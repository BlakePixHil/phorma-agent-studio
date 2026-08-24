/**
 * Owns every `phorma-aws` CLI invocation through the Deploy_Runner.
 *
 * Responsibilities:
 * - At most one command per target at a time (signal tracking) with a cancel
 *   affordance.
 * - Plan_Command runs first, streams output line by line to the terminal.
 * - Deploy only offered AFTER plan succeeds (exit 0); never offered when plan
 *   exits non-zero.
 * - ConfirmDialogService confirmation before deploy proceeds.
 * - Exit code 4 (auth failure) maps to a message naming `aws sso login` as
 *   the next step.
 * - Refuses to run in browser preview (checks isDesktop from TauriService).
 * - Refuses when the configured cloud-aws directory is absent or the CDK entry
 *   point is missing.
 * - After a deploy exits 0, reads the `deploy-outputs` Sentinel_Envelope the CLI
 *   emitted and persists the two endpoints through `AwsDeployConfigService`
 *   (Req 9.2, 9.3, 9.4).
 *
 * Injections: TauriService, TerminalOutputService, ToastService,
 * ConfirmDialogService, AwsDeployConfigService, TelemetryService - NEVER
 * CloudService (DI cycle hazard). `AwsDeployConfigService` and
 * `TelemetryService` inject only `TauriService`, so neither edge closes a cycle.
 */
import { Injectable, inject, signal } from '@angular/core';

import type { EgressAllowList } from '@phorma/engine';

import { TauriService } from '../tauri.service';
import { counterName } from '../telemetry-catalog';
import { TelemetryService } from '../telemetry.service';
import { TerminalOutputService } from '../terminal-output.service';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { AwsDeployConfigService } from './aws-deploy-config.service';
import { AWS_AUTH_FAILURE_EXIT_CODE, DEPLOY_TARGETS, type DeployCommand } from './deploy-targets';
import { SENTINEL_PREFIX, decodeSentinelEnvelope } from './sentinel-envelope';

/**
 * Result of a single `phorma-aws` invocation through the Deploy_Runner.
 */
export interface AwsCommandResult {
  success: boolean;
  exitCode: number | null;
}

/**
 * The two CloudFormation output names endpoint discovery reads, mirroring
 * `TRIGGER_API_OUTPUT` and `MONITOR_API_OUTPUT` in
 * `cloud-aws/src/core/outputs.ts`.
 *
 * The webview cannot import from `cloud-aws/`, so these are declared here. They
 * are used for one purpose only: naming an output the stack did not return, in
 * the message Requirement 9.4 demands. The VALUES travel as the envelope's
 * `triggerApiUrl` / `monitorApiUrl` members, so a rename on the CLI side cannot
 * silently mis-persist an endpoint - it can only mis-name it in a warning.
 */
export const TRIGGER_API_OUTPUT = 'TriggerApiUrl';
export const MONITOR_API_OUTPUT = 'MonitorApiUrl';

/** The `deploy-outputs` envelope payload, with an absent output read as empty. */
interface DeployOutputs {
  triggerApiUrl: string;
  monitorApiUrl: string;
}

@Injectable({ providedIn: 'root' })
export class AwsCliService {
  private readonly tauri = inject(TauriService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly awsConfig = inject(AwsDeployConfigService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge reaches nothing on the deploy or run path.
  private readonly telemetry = inject(TelemetryService);

  /** True while any AWS command is in flight. Guards concurrent execution. */
  readonly running = signal(false);

  private commandCounter = 0;

  /**
   * Runs the full plan-then-deploy flow for the AWS target.
   *
   * 1. Validates preconditions (desktop, directory, entry point).
   * 2. Writes the egress allow-list to the console.
   * 3. Runs the plan command, streaming output to the terminal.
   * 4. If plan exits 0, asks for operator confirmation.
   * 5. If confirmed, runs the deploy command, streaming output.
   * 6. Maps exit code 4 to an auth failure message naming `aws sso login`.
   * 7. On a deploy that exits 0, discovers and persists the two endpoints.
   *
   * @param cloudAwsDir Absolute path to the `cloud-aws/` directory.
   * @param cdkEntryExists Whether `cdk.json` (or the app entry point) exists
   *   in the directory. The caller checks this to keep filesystem access in one
   *   place.
   * @param egressAllowList The derived egress allow-list from the active
   *   workflow graph and configured model providers.
   */
  async planAndDeploy(
    cloudAwsDir: string,
    cdkEntryExists: boolean,
    egressAllowList: EgressAllowList,
  ): Promise<void> {
    if (!this.validatePreconditions(cloudAwsDir, cdkEntryExists)) return;
    if (this.running()) return;

    this.running.set(true);
    this.terminal.open('run');

    try {
      // Write egress allow-list to the console before the Deploy_Runner starts.
      this.writeEgressAllowList(egressAllowList);

      // Run plan command first.
      const planResult = await this.runPlanCommand(cloudAwsDir);
      if (!planResult.success) {
        // Plan failed - never offer deploy.
        this.reportExitFailure('Plan failed', planResult.exitCode);
        return;
      }

      // Plan succeeded - ask for explicit confirmation before deploy.
      const confirmed = await this.confirm.confirm({
        title: 'Deploy to AWS',
        message:
          'The plan completed successfully. Deploy these changes to your AWS account?',
        confirmLabel: 'Deploy',
        cancelLabel: 'Cancel',
      });

      if (!confirmed) {
        this.terminal.append('run', 'info', 'Deploy cancelled by the operator.');
        return;
      }

      // One `deploy.started:aws` per initiated deploy (3.1, 3.2). Counted here
      // rather than at the top of this method because everything above is the
      // plan: a plan that failed, or a confirmation the operator declined,
      // started no deploy. Nothing below retries, so this cannot count twice.
      this.telemetry.count(counterName('deploy.started', 'aws'));

      // Run deploy command. Its `deploy-outputs` envelope is collected instead of
      // printed, so the endpoints can be read back without a base64 framing line
      // landing in the operator's console.
      const collected: string[] = [];
      const deployResult = await this.runDeployCommand(cloudAwsDir, collected);
      if (deployResult.success) {
        this.toast.success('Deployed', 'AWS infrastructure updated.');
        await this.discoverEndpoints(cloudAwsDir, collected);
      } else {
        // One `error:deploy` per counted `deploy.started:aws`, at the same seam
        // and for the same reason (Requirements 3.1, 3.2). A plan that failed
        // above started no deploy and is not counted here. The exit code and
        // every line of CLI output stay in the terminal: `recordError` takes the
        // category and nothing else (11.3).
        this.telemetry.recordError('deploy');
        this.reportExitFailure('Deploy failed', deployResult.exitCode);
      }
    } finally {
      this.running.set(false);
    }
  }

  /**
   * Runs a single `phorma-aws` command through the Deploy_Runner, streaming
   * output line by line to the terminal.
   *
   * Exposed for callers that need a raw command (e.g. `doctor`).
   *
   * A command that RAN and exited non-zero is reported here. That is what
   * carries the `doctor` verb's authentication-failure code to the operator as
   * the `aws sso login` next step (Requirement 5.7): `doctor` reaches the CLI
   * only through this method, and `planAndDeploy` reports for the plan and
   * deploy verbs alone.
   */
  async runCommand(command: DeployCommand): Promise<AwsCommandResult> {
    if (!this.tauri.isDesktop) {
      this.toast.warning(
        'Desktop only',
        'AWS commands require the desktop app - the browser preview cannot deploy.',
      );
      return { success: false, exitCode: null };
    }
    if (this.running()) {
      this.toast.warning(
        'Command already running',
        'Wait for the current AWS command to finish or cancel it.',
      );
      return { success: false, exitCode: null };
    }

    this.running.set(true);
    try {
      const result = await this.executeStreamedCommand(command);
      // `exitCode === null` means the invocation itself failed rather than the
      // process, and `executeStreamedCommand` has already toasted that - a second
      // report would double up on one failure.
      if (!result.success && result.exitCode !== null) {
        this.reportExitFailure(`${commandVerbLabel(command)} failed`, result.exitCode);
      }
      return result;
    } finally {
      this.running.set(false);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private validatePreconditions(cloudAwsDir: string, cdkEntryExists: boolean): boolean {
    if (!this.tauri.isDesktop) {
      this.toast.warning(
        'Desktop only',
        'AWS commands require the desktop app - the browser preview cannot deploy.',
      );
      return false;
    }

    if (!cloudAwsDir) {
      this.toast.warning(
        'Set up the deploy runtime',
        'Settings > Cloud > Deploy runtime unpacks the CDK application this app ships with.',
      );
      return false;
    }

    if (!cdkEntryExists) {
      this.toast.warning(
        'CDK entry point missing',
        'The runtime folder holds no CDK application. Set up the runtime files again in Settings.',
      );
      return false;
    }

    return true;
  }

  private async runPlanCommand(cloudAwsDir: string): Promise<AwsCommandResult> {
    const target = DEPLOY_TARGETS['aws'];
    const cmd = target.planCommand!({
      cloudFolder: cloudAwsDir,
      workflowId: '',
      baseUrl: '',
    });
    if (!cmd) return { success: false, exitCode: null };

    this.terminal.append('run', 'info', `$ npx ${cmd.args.join(' ')}`);
    return this.executeStreamedCommand(cmd);
  }

  /**
   * Runs the deploy verb, collecting its Sentinel_Envelope lines into
   * `collected` so {@link discoverEndpoints} can read the endpoints back.
   */
  private async runDeployCommand(
    cloudAwsDir: string,
    collected: string[],
  ): Promise<AwsCommandResult> {
    const target = DEPLOY_TARGETS['aws'];
    const cmd = target.deployCommand({
      cloudFolder: cloudAwsDir,
      workflowId: '',
      baseUrl: '',
    });
    if (!cmd) return { success: false, exitCode: null };

    this.terminal.append('run', 'info', `$ npx ${cmd.args.join(' ')}`);
    return this.executeStreamedCommand(cmd, collected);
  }

  /**
   * Reads the endpoints a completed deploy reported and persists them
   * (Req 9.2, 9.3, 9.4).
   *
   * `collected` is whatever the deploy stream carried. When it holds no decodable
   * `deploy-outputs` envelope - a killed stream, a truncated final line, a deploy
   * run from CI - the read-only `outputs` verb is run to fetch the same payload
   * from CloudFormation. That is one recovery attempt, not a retry loop: `outputs`
   * reads the deployed stack directly, so a second attempt would report the same
   * thing.
   *
   * An output the stack did not return is NAMED and nothing is persisted. Both
   * signals stay untouched on that path, because
   * `applyDiscoveredEndpoints` takes the pair: writing half of it would leave the
   * store claiming an endpoint pairing that no single deploy ever produced.
   */
  private async discoverEndpoints(cloudAwsDir: string, collected: string[]): Promise<void> {
    let outputs = readDeployOutputs(collected);

    if (!outputs) {
      const cmd: DeployCommand = {
        program: 'npx',
        args: ['phorma-aws', 'outputs'],
        cwd: cloudAwsDir,
      };
      this.terminal.append('run', 'info', `$ npx ${cmd.args.join(' ')}`);
      const fallback: string[] = [];
      await this.executeStreamedCommand(cmd, fallback);
      outputs = readDeployOutputs(fallback);
    }

    // Reported in the order `REQUIRED_OUTPUTS` declares them, so a run that
    // returned neither names the trigger endpoint first.
    const triggerApiUrl = outputs?.triggerApiUrl ?? '';
    const monitorApiUrl = outputs?.monitorApiUrl ?? '';
    const missing: string[] = [];
    if (!triggerApiUrl) missing.push(TRIGGER_API_OUTPUT);
    if (!monitorApiUrl) missing.push(MONITOR_API_OUTPUT);

    if (missing.length > 0) {
      this.toast.warning(
        'Deploy output missing',
        `The stack did not return ${missing.join(' and ')}. ` +
          'The stored endpoint values are unchanged.',
      );
      return;
    }

    await this.awsConfig.applyDiscoveredEndpoints({ triggerApiUrl, monitorApiUrl });
  }

  /**
   * Invokes `run_streamed_command` via Tauri IPC and streams output to the
   * terminal line by line. No AWS credential environment variable is set on
   * the command - it inherits the operator's ambient profile/SSO session.
   *
   * A sentinel-prefixed stdout line is envelope FRAMING, not operator output: it
   * goes to `collectEnvelope` when a caller supplied one and is never written to
   * the terminal either way. A base64 chunk in the run console is noise, and the
   * routing must not depend on whether anyone is listening - a verb that starts
   * emitting an envelope would otherwise dirty every console that ignores it.
   *
   * @param collectEnvelope Receives each sentinel line, in arrival order.
   */
  private async executeStreamedCommand(
    command: DeployCommand,
    collectEnvelope?: string[],
  ): Promise<AwsCommandResult> {
    this.commandCounter += 1;
    const requestId = `aws-${this.commandCounter}`;

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; stream: string; line: string }>(
      'process-output-event',
      event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.stream === 'exit') return;
        if (
          event.payload.stream === 'stdout' &&
          event.payload.line.trimStart().startsWith(SENTINEL_PREFIX)
        ) {
          collectEnvelope?.push(event.payload.line);
          return;
        }
        this.terminal.append(
          'run',
          event.payload.stream === 'stderr' ? 'warning' : 'info',
          event.payload.line,
        );
      },
    );

    try {
      const result = await invoke<{ success: boolean; exitCode: number | null }>(
        'run_streamed_command',
        {
          requestId,
          cwd: command.cwd,
          program: command.program,
          args: command.args,
        },
      );
      return { success: result.success, exitCode: result.exitCode };
    } catch (error) {
      this.toast.error(
        'AWS command failed',
        error instanceof Error ? error.message : String(error),
      );
      return { success: false, exitCode: null };
    } finally {
      unlisten();
    }
  }

  /**
   * Maps an exit code to a user-facing message. Exit code 4 from `phorma-aws
   * doctor` means authentication failure - the message names `aws sso login`
   * as the next step.
   */
  private reportExitFailure(summary: string, exitCode: number | null): void {
    if (exitCode === AWS_AUTH_FAILURE_EXIT_CODE) {
      this.toast.error(
        summary,
        `Authentication failed. Run \`aws sso login\` to refresh your session, then try again.`,
      );
    } else {
      this.toast.error(summary, `Command exited with code ${exitCode ?? '?'}.`);
    }
  }

  /**
   * Writes the egress allow-list to the terminal console (Req 10.5, 10.12).
   *
   * Output format:
   * 1. Entry count line (e.g. "Egress allow-list: 5 hosts").
   * 2. One line per host.
   * 3. Explicit no-hostname line when the list is empty.
   * 4. One line per undeterminable entry naming the node.
   *
   * The deploy always proceeds regardless of the list content.
   */
  private writeEgressAllowList(allowList: EgressAllowList): void {
    if (allowList.hosts.length === 0) {
      this.terminal.append('run', 'info', 'Egress allow-list: no hostnames derived');
    } else {
      const count = allowList.hosts.length;
      this.terminal.append(
        'run',
        'info',
        `Egress allow-list: ${count} ${count === 1 ? 'host' : 'hosts'}`,
      );
      for (const host of allowList.hosts) {
        this.terminal.append('run', 'info', `  ${host}`);
      }
    }

    for (const entry of allowList.undeterminable) {
      const name = entry.nodeName || entry.nodeId || 'unknown node';
      this.terminal.append(
        'run',
        'warning',
        `Egress allow-list: could not derive hostname for "${name}"`,
      );
    }

    if (allowList.capped) {
      this.terminal.append(
        'run',
        'warning',
        'Egress allow-list: capped at 200 entries, additional hosts were dropped',
      );
    }
  }
}

/**
 * The summary line for a failed command, naming the verb it ran.
 *
 * Every AWS command is `npx phorma-aws <verb>`, so the verb is the argument after
 * the package name. A command carrying none falls back to a generic label rather
 * than reading "undefined failed".
 */
function commandVerbLabel(command: DeployCommand): string {
  const verb = command.args[1] ?? '';
  if (!verb) return 'AWS command';
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
}

/**
 * The `deploy-outputs` payload carried by a stream of collected lines, or
 * `undefined` when those lines hold no decodable envelope of that kind.
 *
 * `undefined` is the signal to try the `outputs` verb; a returned object with an
 * empty member is a stack that really did not return that output, which is a
 * different condition and must NOT trigger a fallback. Decoding goes through
 * `sentinel-envelope.ts`, the one Studio-side decoder.
 *
 * Fields are validated rather than cast: this string crossed a process boundary,
 * and a non-string endpoint would otherwise be persisted and later fail at the
 * point of use rather than here.
 */
function readDeployOutputs(lines: readonly string[]): DeployOutputs | undefined {
  const decoded = decodeSentinelEnvelope(lines);
  if (!decoded.ok) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  if (record['kind'] !== 'deploy-outputs') return undefined;

  const triggerApiUrl = record['triggerApiUrl'];
  const monitorApiUrl = record['monitorApiUrl'];
  return {
    triggerApiUrl: typeof triggerApiUrl === 'string' ? triggerApiUrl.trim() : '',
    monitorApiUrl: typeof monitorApiUrl === 'string' ? monitorApiUrl.trim() : '',
  };
}
