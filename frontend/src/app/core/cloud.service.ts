import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import {
  CLOUDFLARE_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
  type RunEvent,
  type RunRecord,
  type RunRecordSummary,
  type UsageLedgerEntry,
} from '@phorma/engine';

import {
  DEPLOY_TARGETS,
  type CloudEndpointContext,
  type CloudOperation,
  type ConnectionsPushPayload,
  type SecretWritePayload,
  type SpecPushPayload,
  type TriggerPayload,
} from './deploy/deploy-targets';
import type { CloudTransport } from './deploy/cloud-transport';
import {
  dispatchCloudOperation,
  type CloudCallResult,
} from './deploy/cloud-dispatch';
import type { DeploymentSummary, DeploymentsResponse } from './deployments.model';
import { AwsDeployConfigService } from './deploy/aws-deploy-config.service';
import { AwsRequestService } from './deploy/aws-request.service';

import { ActiveOwnerService } from './active-owner.service';
import { CapabilityService } from './capability.service';
import { ConnectionStoreService } from './connection-store.service';
import { DeployConfigService, BYO_CONFIG_FILENAME } from './deploy-config.service';
import { DesktopAuthService } from './desktop-auth.service';
import { RunControllerService } from './run-controller.service';
import { SettingsService } from './settings.service';
import { SkillsService } from './skills.service';
import { WorkflowVersionsService } from './workflow-versions.service';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { loadLayout, saveLayout } from './layout-storage';
import { loadPhormaCloudUrl, savePhormaCloudUrl } from './phorma-cloud-url';
import { ToastService } from '../shared/toast/toast.service';
import type { WorkflowSpec } from './workflow.model';
import { graphsOf, materializeSpecDefaults } from './spec-defaults';
import type {
  PortalMintResponse,
  PortalPublishResponse,
  PortalStatusResponse,
} from './portal.model';

export type CloudConnectionState = 'disconnected' | 'connecting' | 'connected';

/** The step of a push that is currently running. */
export type PushPhase = 'connections' | 'validating' | 'uploading' | null;

/**
 * Drops the local-only projection fields (`secretsPresent`, `usedByWorkflowIds`)
 * from a `ConnectionSummary`, leaving exactly the `Connection` metadata shape
 * the worker's push route accepts. Never carries a secret value either way.
 */
function toConnectionMetadata(
  summary: ConnectionSummary,
): Omit<ConnectionSummary, 'secretsPresent' | 'missingSecretKeys' | 'usedByWorkflowIds'> {
  const { secretsPresent, missingSecretKeys, usedByWorkflowIds, ...metadata } = summary;
  void secretsPresent;
  void missingSecretKeys;
  void usedByWorkflowIds;
  return metadata;
}

// `PHORMA_CLOUD_DEFAULT_URL` and the retired-host migration live in
// `phorma-cloud-url.ts`, a leaf module the run path can import without closing
// the RunController -> ModelTransport -> PhormaCloud -> Cloud DI cycle.

/**
 * Capability findings a host returned alongside a rejection (Requirement 16.8).
 * The host's own findings are authoritative, so they reach the Problems console
 * even though the push already failed.
 */
function readFindings(detail: unknown): CapabilityFinding[] {
  const value = (detail as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(value) ? (value as CapabilityFinding[]) : [];
}

/**
 * The studio's bridge to the deployed cloud runtime.
 *
 * - **Deploy**: streams `npx wrangler deploy` (run by the Rust backend inside
 *   the runtime folder `DeployWorkspaceService` prepared) into the console.
 * - **Push**: uploads the active workflow spec to its WorkflowAgent instance.
 * - **Monitor**: a WebSocket whose RunEvents feed the SAME
 *   `RunControllerService.apply()` path as local runs - cloud runs animate
 *   the canvas identically.
 * - **Trigger/Stop/Approve**: control frames sent over the socket.
 */
@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly tauri = inject(TauriService);
  private readonly workflow = inject(WorkflowService);
  private readonly runController = inject(RunControllerService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(SettingsService);
  private readonly skillsLibrary = inject(SkillsService);
  private readonly versions = inject(WorkflowVersionsService);
  private readonly clerk = inject(ClerkService);
  private readonly deployConfig = inject(DeployConfigService);
  private readonly connectionStore = inject(ConnectionStoreService);
  // Both sit BELOW this service and inject neither it nor
  // `RunControllerService`, so the known NG0200 cycle is untouched.
  private readonly awsConfig = inject(AwsDeployConfigService);
  private readonly awsRequest = inject(AwsRequestService);
  // Safe DI direction even though this service sits inside the known NG0200
  // cycle: `TelemetryService` is a leaf that injects only `TauriService`, so it
  // cannot reach back into `RunControllerService`.
  private readonly telemetry = inject(TelemetryService);
  // The desktop credential, for `resolveAuthToken` below. Also a leaf
  // (`TauriService` + `McpOAuthService`), so it cannot close the cycle either -
  // and deliberately NOT `PhormaCloudService`, which injects THIS service.
  private readonly desktopAuth = inject(DesktopAuthService);
  // Safe here for the strongest possible reason: `CapabilityService` injects
  // NOTHING, and `scripts/check-capability-isolation.mjs` keeps it that way. Read
  // by `provider` below - see the comment there for why a Cloud_Library session
  // has no deploy target to resolve.
  private readonly capability = inject(CapabilityService);

  // Safe for the same reason, and guarded by the same script:
  // `ActiveOwnerService` injects nothing at all. Read by `headers()` below, which
  // is the ONE place a hosted request's owner is named.
  private readonly activeOwner = inject(ActiveOwnerService);

  /** Worker base URL, e.g. https://phorma-agent-studio-cloud.you.workers.dev */
  readonly workerUrl = signal(loadLayout('cloudWorkerUrl', ''));
  /**
   * Bearer token matching the worker's PHORMA_TOKEN secret (optional).
   *
   * Only read back from storage when the user opted into remembering it - see
   * {@link setToken} and `SettingsService.rememberCloudToken`.
   */
  readonly token = signal(
    loadLayout('rememberCloudToken', false) ? loadLayout('cloudToken', '') : '',
  );
  /**
   * Absolute path of the runtime folder wrangler deploys from.
   *
   * Normally the workspace `DeployWorkspaceService` unpacks out of the installer,
   * so a production install needs no checkout of the Phorma repository. A
   * developer can still point it at their own `cloud/` folder.
   */
  readonly cloudFolder = signal(loadLayout('cloudFolder', ''));
  /** Phorma Cloud base URL (configurable for staging; defaults to prod). */
  readonly phormaCloudUrl = signal(loadPhormaCloudUrl());

  /**
   * The deploy target every request, socket and command resolves against.
   *
   * Normally the user's chosen one (null until picked in Settings → Cloud). For a
   * Cloud_Library session it is PINNED to Phorma Cloud, because such a session has
   * no target to choose: a member never deploys, their workflows exist only as an
   * organisation's hosted deployments, and Settings → Cloud is a builder surface
   * they never reach. Left unpinned, `configured()` answers false and
   * `effectiveWorkerUrl()` answers the empty BYO worker URL, so Run, Stop and the
   * monitor socket all fail for the one session that has nothing else to run
   * (multi-organisation Requirements 10.1, 10.3).
   *
   * Pinning HERE rather than at each call site is deliberate, and it is the same
   * answer `DeploymentsService` and `DeployedNotificationsService` reached by
   * pinning `DEPLOY_TARGETS.phorma`: the fact is "this session's runtime is the
   * hosted one", and it belongs in the one place the target is resolved. It is a
   * predicate call, never a level comparison - the decision stays inside
   * `CapabilityService`.
   */
  readonly provider = computed(() =>
    this.capability.cloudLibraryOnly() ? ('phorma' as const) : this.settings.cloudProvider(),
  );

  /**
   * Base URL actually used for push/monitor, per the chosen provider.
   *
   * `aws` reads the discovered Trigger_API URL, which no operator types: it is
   * empty until a deploy completes, and every AWS call is unreachable while it
   * is.
   */
  readonly effectiveWorkerUrl = computed(() => {
    const provider = this.provider();
    if (provider === 'phorma') return this.phormaCloudUrl();
    if (provider === 'aws') return this.awsConfig.triggerApiUrl();
    return this.workerUrl();
  });

  /**
   * Whether the chosen provider has enough configuration for push/monitor.
   * Phorma Cloud needs only the built-in URL (auth is checked at request
   * time); own-Cloudflare needs the user's worker URL; `aws` needs BOTH a valid
   * aggregate configuration and a discovered Trigger_API URL (Requirement
   * 12.5) - a well-formed configuration that has never deployed reaches
   * nothing.
   */
  readonly configured = computed(() => {
    const provider = this.provider();
    if (provider === 'phorma') return this.phormaCloudUrl().length > 0;
    if (provider === 'cloudflare') return this.workerUrl().length > 0;
    if (provider === 'aws') {
      return this.awsConfig.valid() && this.awsConfig.triggerApiUrl().length > 0;
    }
    return false;
  });

  readonly connection = signal<CloudConnectionState>('disconnected');
  readonly deploying = signal(false);
  readonly connected = computed(() => this.connection() === 'connected');
  /**
   * True while {@link pushWorkflow} has work in flight. Distinct from
   * {@link deploying}, which covers provisioning the worker itself.
   */
  readonly pushing = signal(false);
  /** Which step of a push is running, so the button can name it. */
  readonly pushPhase = signal<PushPhase>(null);
  /**
   * Findings from the last push attempt, authoritative over the studio's own
   * pre-flight because the host validates against an inventory only it can read.
   */
  readonly lastPushFindings = signal<CapabilityFinding[]>([]);
  /**
   * Deployment status of the active workflow on the current provider's
   * instance, for the Cloud dialog's status indicator. `null` means unknown
   * (never checked, or the worker was unreachable) - never read as "not
   * deployed".
   */
  readonly deployedStatus = signal<{ hasWorkflow: boolean; savedAt: string | null } | null>(null);
  /**
   * The workflow id the live {@link deployedStatus} was last checked for.
   * Consumers must compare this to the workflow they're interested in before
   * trusting {@link deployedStatus} - otherwise a stale status from a
   * previously-active workflow leaks when the user switches tabs.
   */
  readonly deployedStatusWorkflowId = signal<string | null>(null);
  /** True while {@link refreshStatus} has a request in flight. */
  readonly statusLoading = signal(false);

  /**
   * Where a change goes when the caller may not deploy
   * (multi-organisation-phorma, Requirement 12.1).
   *
   * A SETTABLE SEAM, installed by the shell, for the same reason
   * `RunControllerService.deployedRunLauncher` and
   * `NotificationCenterService.deepLinkHandler` are: the performer
   * (`ProposalsService`) reaches `PhormaCloudService`, which injects this service,
   * so an injection here would close the known NG0200 cycle through a new edge.
   *
   * Absent means "this build cannot submit a proposal", which
   * {@link pushWorkflow} reports rather than falling back to a push - an editor's
   * change must never reach a deployment by default.
   */
  specProposer: ((spec: WorkflowSpec) => Promise<boolean>) | null = null;

  private socket: WebSocket | null = null;
  /**
   * Workflow id the live monitor socket is attached to. Every ControlFrame sent
   * over an AWS socket carries it, because the Monitor_API's `$default` template
   * can only read it from the frame body (see {@link send}).
   */
  private monitorWorkflowId = '';
  private deployCounter = 0;
  /** Feeds the caller-minted run id an HTTP trigger sends. */
  private triggerCounter = 0;

  constructor() {
    // Persist connection settings across sessions.
    // (Best-effort localStorage writes; see layout-storage.)

    // Toggling the opt-in has to act on the token already held: turning it off
    // must erase a copy written while it was on.
    effect(() => {
      saveLayout('cloudToken', this.settings.rememberCloudToken() ? untracked(this.token) : '');
    });
  }

  setWorkerUrl(url: string): void {
    this.workerUrl.set(url.trim().replace(/\/$/, ''));
    saveLayout('cloudWorkerUrl', this.workerUrl());
  }

  /**
   * Sets the worker bearer token, persisting it only when the user asked us to.
   * Otherwise it is session state and the stored copy is actively cleared, so
   * turning the option off removes a token written while it was on.
   */
  setToken(token: string): void {
    this.token.set(token.trim());
    saveLayout('cloudToken', this.settings.rememberCloudToken() ? this.token() : '');
  }

  setCloudFolder(path: string): void {
    this.cloudFolder.set(path.trim());
    saveLayout('cloudFolder', this.cloudFolder());
  }

  setPhormaCloudUrl(url: string): void {
    this.phormaCloudUrl.set(savePhormaCloudUrl(url));
  }

  /** Picks the runtime folder with the native dialog (desktop only). */
  async pickCloudFolder(): Promise<void> {
    try {
      const folder = await this.tauri.selectFolderDialog('Select the runtime folder');
      if (folder) this.setCloudFolder(folder);
    } catch (error) {
      this.toast.error('Folder picker unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  // ── Deploy (desktop only - spawns wrangler via Rust) ───────────────────────

  async deploy(): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Deploying runs wrangler locally - use the desktop app.');
      return;
    }
    const cwd = this.cloudFolder();
    if (!cwd) {
      this.toast.warning(
        'Set up the deploy runtime',
        'Settings > Cloud > Deploy runtime unpacks the worker this app ships with.',
      );
      return;
    }
    if (!this.deployConfig.valid()) {
      this.toast.warning(
        'Check your Cloud settings',
        'The account id, worker name or portal domain looks wrong.',
      );
      return;
    }
    if (this.deploying()) return;

    this.deploying.set(true);
    this.deployCounter += 1;
    const requestId = `deploy-${this.deployCounter}`;
    this.terminal.open('run');

    // A custom account, worker name or portal domain needs configuration that
    // must NOT be hand-edited into the version-controlled wrangler.jsonc, so
    // the studio writes a gitignored override and deploys with `--config`.
    const args = ['wrangler', 'deploy'];
    if (this.deployConfig.needsOverride()) {
      const written = await this.writeOverrideConfig(cwd);
      if (!written) {
        this.deploying.set(false);
        return;
      }
      args.push('--config', BYO_CONFIG_FILENAME);
    }
    this.terminal.append('run', 'info', `$ npx ${args.join(' ')}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; stream: string; line: string }>(
      'process-output-event',
      event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.stream === 'exit') return;
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
        { requestId, cwd, program: 'npx', args },
      );
      if (result.success) {
        this.toast.success('Deployed', 'Worker published. Push your workflow next.');
      } else {
        this.toast.error('Deploy failed', `wrangler exited with code ${result.exitCode ?? '?'}.`);
      }
    } catch (error) {
      this.toast.error('Deploy failed', error instanceof Error ? error.message : String(error));
    } finally {
      unlisten();
      this.deploying.set(false);
    }
  }

  /**
   * Writes the generated wrangler override into the cloud folder. Returns false
   * (having toasted) when it could not be written, so the caller aborts rather
   * than deploying with stale or default configuration.
   */
  private async writeOverrideConfig(cwd: string): Promise<boolean> {
    // Match the folder's own separator instead of assuming one.
    const separator = cwd.includes('\\') ? '\\' : '/';
    const path = `${cwd.replace(/[\\/]$/, '')}${separator}${BYO_CONFIG_FILENAME}`;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_workflow_file', {
        path,
        content: this.deployConfig.buildOverrideConfig(),
      });
      this.terminal.append('run', 'info', `Wrote ${BYO_CONFIG_FILENAME} (generated, gitignored).`);
      return true;
    } catch (error) {
      this.toast.error(
        'Could not write the deploy config',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  // ── Worker secrets (desktop only - wrangler secret put via Rust) ───────────

  /** Secret name currently being saved (drives per-row button spinners). */
  readonly savingSecret = signal<string | null>(null);

  // ── Connection secrets on the deployed runtime (any provider) ─────────────

  /**
   * Connection-secret entry names the deployed runtime currently holds, as
   * `workerSecretName` produces them. Names only - there is no route that
   * returns a value, by construction.
   *
   * Empty on any failure (unreachable worker, no vault binding, no encryption
   * key): this drives an informational badge, so it must never throw into a
   * caller that is only trying to render.
   */
  async connectionSecretNames(): Promise<string[]> {
    if (!this.effectiveWorkerUrl()) return [];
    try {
      // Requirement 12.6: a target that lists no secret names (AWS Secrets
      // Manager entries are written, never read back) resolves to the empty
      // list, which is this method's documented absent value anyway.
      const result = await this.call<string[]>('list-secret-names', { workflowId: '' });
      return result.ok === true ? result.value : [];
    } catch {
      return [];
    }
  }

  /**
   * Stores one connection secret on the deployed runtime, so a deployed run can
   * resolve it (Requirement 3.5 second path).
   *
   * The value goes ONLY here: the studio's own copy lives in the OS keychain,
   * which a worker cannot read, and there is no path that reads either store
   * back. That is why this takes the value the operator is currently typing
   * rather than "syncing" a stored one - a sync would require a read-back that
   * deliberately does not exist.
   *
   * Works for both deploy targets: Phorma Cloud (the tenant's own vault) and
   * own-Cloudflare (the deployment's vault). Resolves false having toasted, so
   * a caller can keep the draft on screen for a retry.
   *
   * `silent` suppresses only the SUCCESS toast, for a caller that writes both
   * secret stores in one action and reports them together. Failures always
   * toast: a credential that did not reach the deploy target is the thing the
   * operator has to know about.
   */
  async putConnectionSecret(
    connectionId: string,
    secretKey: string,
    value: string,
    options?: { silent?: boolean },
  ): Promise<boolean> {
    const base = this.effectiveWorkerUrl();
    if (!base) {
      this.toast.warning('No cloud target', 'Pick a deploy target in Settings > Cloud first.');
      return false;
    }
    if (!value.trim()) {
      this.toast.warning('Empty value', 'Enter the secret value first.');
      return false;
    }
    this.savingSecret.set(`${connectionId}:${secretKey}`);
    try {
      const result = await this.call(
        'put-secret',
        { workflowId: '', connectionId, secretKey },
        { value } satisfies SecretWritePayload,
      );
      if (result.ok === 'unsupported') throw this.unsupportedError('put-secret');
      if (result.ok === false) throw new Error(result.error);
      if (!options?.silent) {
        this.toast.success('Secret sent to the cloud', `${secretKey} is available to deployed runs.`);
      }
      return true;
    } catch (error) {
      this.toast.error('Could not send the secret', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.savingSecret.set(null);
    }
  }

  /** Removes one connection secret from the deployed runtime. Idempotent. */
  async deleteConnectionSecret(connectionId: string, secretKey: string): Promise<boolean> {
    const base = this.effectiveWorkerUrl();
    if (!base) return false;
    try {
      const query = `connectionId=${encodeURIComponent(connectionId)}&secretKey=${encodeURIComponent(secretKey)}`;
      const response = await fetch(`${base}/api/connection-secrets?${query}`, {
        method: 'DELETE',
        headers: await this.headers(),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.toast.error('Could not remove the secret', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Sets a secret on the user's deployed worker via
   * `npx wrangler secret put <NAME>`. The value travels through the Rust
   * backend into wrangler's stdin - never through argv or the console.
   */
  async putWorkerSecret(name: string, value: string): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Setting secrets runs wrangler locally - use the desktop app.');
      return;
    }
    const cwd = this.cloudFolder();
    if (!cwd) {
      this.toast.warning(
        'Set up the deploy runtime',
        'Settings > Cloud > Deploy runtime unpacks the worker this app ships with.',
      );
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      this.toast.error('Invalid secret name', name);
      return;
    }
    if (!value.trim()) {
      this.toast.warning('Empty value', 'Paste the secret value first.');
      return;
    }
    if (this.savingSecret()) return;

    this.savingSecret.set(name);
    this.deployCounter += 1;
    const requestId = `secret-${this.deployCounter}`;
    this.terminal.open('run');
    this.terminal.append('run', 'info', `$ npx wrangler secret put ${name}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; stream: string; line: string }>(
      'process-output-event',
      event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.stream === 'exit') return;
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
          cwd,
          program: 'npx',
          args: ['wrangler', 'secret', 'put', name],
          stdinData: value.trim(),
        },
      );
      if (result.success) {
        this.toast.success('Secret saved', `${name} is set on your worker.`);
      } else {
        this.toast.error('Secret failed', `wrangler exited with code ${result.exitCode ?? '?'}.`);
      }
    } catch (error) {
      this.toast.error('Secret failed', error instanceof Error ? error.message : String(error));
    } finally {
      unlisten();
      this.savingSecret.set(null);
    }
  }

  // ── Connection test ─────────────────────────────────────────────────────────

  /** Latest connection-test outcome (drives the status pill in Settings). */
  readonly connectionTest = signal<'untested' | 'testing' | 'ok' | 'auth-failed' | 'unreachable'>(
    'untested',
  );

  /**
   * Probes the configured worker with `GET /status` on the `default`
   * instance. Distinguishes auth failures from unreachable hosts so the
   * settings pill can say something actionable.
   */
  async testConnection(): Promise<void> {
    // The `default` instance, shaped by the registry rather than by a literal
    // path (Requirement 12.4).
    const base = this.instanceUrl('default');
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }
    this.connectionTest.set('testing');
    try {
      const response = await fetch(`${base}/status`, {
        headers: await this.headers(),
      });
      if (response.status === 401 || response.status === 403) {
        this.connectionTest.set('auth-failed');
        return;
      }
      this.connectionTest.set(response.ok ? 'ok' : 'unreachable');
    } catch {
      this.connectionTest.set('unreachable');
    }
  }

  // ── Push the active workflow spec ──────────────────────────────────────────

  /**
   * Materializes the application default model into agents that inherit it, and
   * refreshes attached skill bodies from the local library. The cloud runtime has
   * no access to either, so both are resolved into the spec at push time.
   *
   * A THIN WRAPPER over `materializeSpecDefaults` (`core/spec-defaults.ts`),
   * which is where the transform now lives so a service that must not inject
   * this one can still compute a Canonical_Spec_Hash that agrees with the one the
   * push path stores (Requirement 12.4).
   *
   * The two halves are deliberately on opposite sides of that seam. The default
   * materialization is IN the hash transform; the skills refresh is OUT of it,
   * because it is a library READ rather than a default and a member has no local
   * skills library. The consequence, stated rather than discovered: the hash
   * compares workflow CONFIGURATION, not attached skill CONTENT.
   */
  private materializeDefaults(spec: WorkflowSpec): WorkflowSpec {
    const resolved = materializeSpecDefaults(spec, {
      provider: this.settings.defaultProvider(),
      model: this.settings.defaultModel(),
      temperature: this.settings.defaultTemperature(),
    });
    // Deployed runs can't reach the studio libraries, so every graph in the
    // embedded closure gets its attached skill copies refreshed.
    for (const graph of graphsOf(resolved)) this.skillsLibrary.syncAttachedSkills(graph);
    return resolved;
  }

  /**
   * Uploads a spec to its WorkflowAgent instance. Resolves true only when the
   * worker accepted it - callers that need the outcome (the studio assistant's
   * deploy action) must not infer success from the absence of a throw, because
   * every failure path here is a toast.
   *
   * `source` defaults to the active document. A caller passes one explicitly to
   * redeploy a previous snapshot without rewriting the canvas.
   */
  async pushWorkflow(source?: WorkflowSpec): Promise<boolean> {
    if (this.pushing()) return false;
    if (!source && this.workflow.activeDoc()?.readOnly) {
      this.toast.warning('Preview is read-only', 'Restore this version before pushing it to the cloud.');
      return false;
    }
    const rawSpec = source ?? this.workflow.exportActiveSpec();
    if (!rawSpec) return false;
    const spec = this.materializeDefaults(rawSpec);

    // An editor may not deploy, so their push is a PROPOSAL and never a push
    // (multi-organisation-phorma, Requirement 12.1). Routed here, past
    // materialization, so the spec a builder reviews and the spec a push would
    // have sent are the same bytes - a comparison against the deployed hash is
    // only meaningful when both sides ran the same transform.
    //
    // A SEAM rather than an injection: `ProposalsService` reaches
    // `PhormaCloudService`, so injecting it here would close the known NG0200
    // cycle (`RunControllerService -> ModelTransportService -> PhormaCloudService
    // -> CloudService`) through a new edge. The shell installs it, exactly as it
    // installs `RunControllerService.deployedRunLauncher`.
    //
    // The test is the CAPABILITY, not a level: `deploy.push` is what a push needs,
    // and naming it here keeps the one level comparison inside `CapabilityService`
    // where `scripts/check-capability-isolation.mjs` requires it to stay.
    if (!this.capability.can('deploy.push')) {
      if (!this.specProposer) {
        this.toast.warning(
          'Submit for review',
          'Your account can propose changes rather than deploy them, and this build cannot ' +
            'submit one. Update the app and try again.',
        );
        return false;
      }
      return this.specProposer(spec);
    }
    const base = this.instanceUrl(spec.id);
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return false;
    }

    // One `deploy.started` per initiated deploy: past every guard, before any
    // network work, and outside the pipeline below so a retried request inside
    // it cannot count twice (3.1, 3.2). The dimension is read from the chosen
    // provider, so it names the target the spec is actually heading to rather
    // than assuming one. `aws` deliberately does not count here - an AWS deploy
    // starts at the `cdk deploy` step in `AwsCliService`, and counting both
    // would fold two different actions into one counter.
    const deployTarget = this.provider();
    if (deployTarget === 'phorma' || deployTarget === 'cloudflare') {
      this.telemetry.count(counterName('deploy.started', deployTarget));
    }

    this.pushing.set(true);
    try {
      // Requirement 3.6: the host's connection inventory comes ONLY from
      // connection metadata - names, types and auth modes, never a secret
      // value. Pushed before validation so the Capability_Validator checks
      // the SAME inventory the target host will resolve against. A target that
      // folds this into the spec push declares no separate route, and the
      // metadata travels in the `push-spec` payload below instead.
      this.pushPhase.set('connections');
      const summaries = await this.connectionStore.list();
      const metadata = summaries.map(toConnectionMetadata);
      await this.pushConnectionMetadata(spec.id, metadata);

      // Requirements 16.3, 16.4: validate against the selected target's
      // capability record and the target's connection inventory, after default
      // materialisation and before the deployment request. Any error finding
      // aborts the push. Write all findings to the Problems console either way.
      this.pushPhase.set('validating');
      const provider = this.settings.cloudProvider();
      const capabilities = provider
        ? DEPLOY_TARGETS[provider].capabilities
        : CLOUDFLARE_CAPABILITIES;
      const connections = await this.fetchConnectionInventory(spec.id);
      const findings = validateAgainstCapabilities(spec, capabilities, connections);
      // Always write findings to Problems console (Requirement 16.4).
      this.reportCapabilityFindings(findings);
      this.lastPushFindings.set(findings);
      const errors = findings.filter(finding => finding.severity === 'error');
      if (errors.length > 0) {
        // The spec validation surface: the push is abandoned because the spec
        // cannot run on the chosen target. Counted once as `validation` and
        // deliberately not as `deploy` - the deploy never started, and this
        // branch returns rather than throwing, so the catch below cannot also
        // count it (Requirements 3.1, 3.2). No finding text is recorded: the
        // category is the whole payload (11.3).
        this.telemetry.recordError('validation');
        this.toast.error(
          'Push aborted',
          `${errors.length} problem${errors.length === 1 ? '' : 's'} would prevent this workflow ` +
            `from running on ${capabilities.label}.`,
        );
        return false;
      }

      this.pushPhase.set('uploading');
      const result = await this.call(
        'push-spec',
        { workflowId: spec.id },
        { spec, connections: metadata } satisfies SpecPushPayload,
      );
      if (result.ok === 'unsupported') throw this.unsupportedError('push-spec');
      if (result.ok === false) {
        // Requirement 16.8: when the Host_Adapter returns its own findings,
        // treat them as authoritative and write them to the Problems console.
        const hostFindings = readFindings(result.detail);
        this.reportCapabilityFindings(hostFindings);
        if (hostFindings.length > 0) this.lastPushFindings.set(hostFindings);
        throw new Error(result.error);
      }
      await this.versions.recordDeploy(rawSpec).catch(() => undefined);
      this.deployedStatus.set({ hasWorkflow: true, savedAt: new Date().toISOString() });
      this.deployedStatusWorkflowId.set(spec.id);
      this.toast.success('Workflow pushed', `"${spec.name}" is live in the cloud.`);
      return true;
    } catch (error) {
      // Every way a push can fail lands here - connection metadata, inventory
      // read, the spec push itself - so one abandoned deploy is one `deploy`
      // counter (Requirements 3.1, 3.2). The message goes to the toast, never to
      // telemetry: `recordError` takes the category and nothing else (11.3).
      this.telemetry.recordError('deploy');
      this.toast.error('Push failed', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.pushPhase.set(null);
      this.pushing.set(false);
    }
  }

  /**
   * Pushes every locally known connection's METADATA to the target's dedicated
   * route (Requirements 2.2, 3.6): names, types, non-secret `config` and
   * `secretKeys` NAMES only - never a secret value. The host pairs each entry
   * with its own secret store at resolve time.
   *
   * A target that declares no separate route folds this into its spec push, so
   * an absent route is a no-op here rather than a failure: the same metadata
   * reaches the host in one request instead of two.
   */
  private async pushConnectionMetadata(
    workflowId: string,
    connections: readonly unknown[],
  ): Promise<void> {
    const result = await this.call(
      'push-connections',
      { workflowId },
      { connections } satisfies ConnectionsPushPayload,
    );
    if (result.ok === 'unsupported') return;
    if (result.ok === false) {
      throw new Error(
        result.hostError ?? `Could not push connection metadata (HTTP ${result.status}).`,
      );
    }
  }

  /**
   * Reads back the host's connection inventory — the same
   * `ConnectionSummary[]` the deployed connection store produces, carrying
   * secret-present counts and no secret value — for push-time validation
   * (Requirement 17.11).
   */
  private async fetchConnectionInventory(workflowId: string): Promise<ConnectionSummary[]> {
    const result = await this.call<ConnectionSummary[]>('read-connections', { workflowId });
    if (result.ok === 'unsupported') return [];
    if (result.ok === false) {
      throw new Error(
        result.hostError ??
          `Could not read the worker's connection inventory (HTTP ${result.status}).`,
      );
    }
    return Array.isArray(result.value) ? result.value : [];
  }

  /** Every returned finding, oldest first, into the Problems console. */
  private reportCapabilityFindings(findings: { severity: 'error' | 'warning'; message: string }[]): void {
    if (findings.length === 0) return;
    this.terminal.open('problems');
    for (const finding of findings) {
      this.terminal.append('problems', finding.severity === 'error' ? 'error' : 'warning', finding.message);
    }
  }

  // ── Deployment status ─────────────────────────────────────────────────────

  /**
   * Reads whether `workflowId` currently has a deployed spec on the active
   * provider's instance, for the Cloud dialog's status indicator. Leaves
   * {@link deployedStatus} at `null` (unknown) rather than claiming "not
   * deployed" when the worker cannot be reached.
   */
  async refreshStatus(workflowId: string): Promise<void> {
    this.statusLoading.set(true);
    try {
      const status = await this.fetchDeployedStatus(workflowId);
      this.deployedStatus.set(status);
      this.deployedStatusWorkflowId.set(status ? workflowId : null);
    } finally {
      this.statusLoading.set(false);
    }
  }

  /**
   * The live deployment status, but ONLY when it was read for `workflowId`.
   * The status signals are single-slot and shared, so any consumer that cares
   * about a specific workflow must go through here - reading
   * {@link deployedStatus} directly returns whatever workflow happened to be
   * checked last. `null` means unknown, not "not deployed".
   */
  deployedStatusFor(workflowId: string | null | undefined): { hasWorkflow: boolean; savedAt: string | null } | null {
    if (!workflowId || this.deployedStatusWorkflowId() !== workflowId) return null;
    return this.deployedStatus();
  }

  /**
   * Every deployment the CONFIGURED target knows about (Requirement 21.2).
   *
   * Deliberately distinct from `DeploymentsService.refresh()`, which pins Phorma
   * Cloud: this one answers "what is deployed where I deploy TO", which is what a
   * BYO user's exported `deployments.json` manifest has to describe. Their own
   * worker binds `PortalIndex` and answers `/api/deployments` for the single
   * `default` owner, with a null spend figure because it binds no D1.
   *
   * Empty on any failure, and empty for a target that declares no route (AWS):
   * this feeds a durability artifact, so a missing manifest section must not
   * abort an export of the workflows themselves.
   */
  async listDeployments(): Promise<DeploymentSummary[]> {
    if (!this.configured()) return [];
    try {
      const result = await this.call<DeploymentsResponse>('list-deployments', { workflowId: '' });
      if (result.ok !== true) return [];
      return Array.isArray(result.value.deployments) ? result.value.deployments : [];
    } catch {
      return [];
    }
  }

  /**
   * One `GET /status` read against `workflowId`'s instance. Writes no signals,
   * so it is safe to call for a workflow that is not the active one (the
   * library-delete path does). `null` means "cannot tell" - unconfigured,
   * unreachable, or a non-200 - never "not deployed".
   */
  private async fetchDeployedStatus(
    workflowId: string,
  ): Promise<{ hasWorkflow: boolean; savedAt: string | null } | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    try {
      // Requirement 12.6: a target that declares no status route resolves to
      // `null`, the unknown value - never to "not deployed".
      const result = await this.call<{ hasWorkflow: boolean; savedAt: string | null }>('status', {
        workflowId,
      });
      return result.ok === true ? result.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Fully tears down `workflowId`'s deployed instance in Phorma Cloud (the
   * Cloud dialog's "Remove from cloud" action, and the library-delete path).
   * Cancels cron, unpublishes the portal, deletes tracked portal session
   * Durable Objects and empties every SQLite table (runs, events, usage ledger,
   * workflow state + fixtures). Connection secrets in the per-tenant vault are
   * untouched (they may be shared across workflows) and D1 usage rows are
   * retained for billing. Returns true on success; surfaces a toast on error.
   */
  async removeWorkflow(workflowId: string): Promise<boolean> {
    const base = this.instanceUrl(workflowId);
    if (!base) return false;
    try {
      const result = await this.call('purge', { workflowId });
      if (result.ok === 'unsupported') throw this.unsupportedError('purge');
      if (result.ok === false) {
        throw new Error(
          result.hostError ?? `Could not remove the workflow (HTTP ${result.status}).`,
        );
      }
      this.deployedStatus.set({ hasWorkflow: false, savedAt: null });
      this.deployedStatusWorkflowId.set(workflowId);
      this.versions.unmarkDeployed(workflowId);
      this.toast.success(
        'Removed from cloud',
        `"${this.workflowName(workflowId)}" is no longer deployed.`,
      );
      return true;
    } catch (error) {
      this.toast.error('Remove failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * A workflow's name by id, for messages about a workflow that is NOT
   * necessarily the active one (the library-delete path removes a workflow from
   * a panel row while a different one is open, and `activeName()` would name the
   * wrong workflow in the toast).
   */
  private workflowName(workflowId: string): string {
    const saved = this.workflow.library().find(spec => spec.id === workflowId);
    if (saved) return saved.name;
    const active = this.workflow.activeDoc();
    return active?.workflowId === workflowId ? this.workflow.activeName() : 'This workflow';
  }

  /**
   * Best-effort cloud teardown for the library-delete path. Checks whether
   * `workflowId` is deployed and, if so, calls {@link removeWorkflow} to fully
   * purge it. Never throws: a cloud that is unreachable, unconfigured, or
   * returns an error (for example a 409 while a run is in progress) only raises
   * a warning toast so the local delete still completes. Returns true when
   * nothing needed cleanup or cleanup succeeded; false when cleanup was needed
   * but failed (the caller may warn the user to remove it manually).
   *
   * Reads the status WITHOUT touching the shared status signals: the workflow
   * being deleted is usually not the open one, and writing them here made the
   * Cloud dialog show the deleted workflow's status for the workflow it is
   * actually displaying.
   */
  async purgeIfDeployed(workflowId: string): Promise<boolean> {
    if (!this.configured()) return true;
    const status = await this.fetchDeployedStatus(workflowId);
    if (!status?.hasWorkflow) return true;
    const removed = await this.removeWorkflow(workflowId);
    if (!removed) {
      this.toast.warning(
        'Cloud cleanup failed',
        `"${this.workflowName(workflowId)}" could not be removed from the cloud. Remove it manually from the Cloud dialog.`,
      );
    }
    return removed;
  }

  // ── Run history (EPIC 1) ──────────────────────────────────────────────────

  /**
   * Lists the deployed workflow's persisted runs from its Durable Object.
   * Returns null when the workflow was never pushed (404) or the worker is
   * unreachable - callers render local history only in that case.
   */
  async listRuns(
    workflowId: string,
  ): Promise<{ runs: RunRecordSummary[]; activeRunId: string | null } | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    try {
      const result = await this.call<{ runs: RunRecordSummary[]; activeRunId: string | null }>(
        'run-history',
        { workflowId },
      );
      return result.ok === true ? result.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches the deployed workflow's usage ledger (EPIC 2) - per-run usage
   * rows that survive run-history pruning. Null when unreachable/never
   * pushed, same contract as {@link listRuns}.
   */
  async fetchUsage(workflowId: string, since = 0): Promise<UsageLedgerEntry[] | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    try {
      const result = await this.call<UsageLedgerEntry[]>('usage', {
        workflowId,
        since: this.usageSince(since),
      });
      return result.ok === true ? result.value : null;
    } catch {
      return null;
    }
  }

  /**
   * `since` in the representation the selected host validates.
   *
   * The two hosts disagree: the Worker reads epoch milliseconds, the AWS host
   * rejects anything that is not ISO 8601. An unbounded window is left
   * undefined so each registry entry supplies its own epoch default, which is
   * the only part of this that can be expressed as data.
   */
  private usageSince(since: number): string | undefined {
    if (!Number.isFinite(since) || since <= 0) return undefined;
    return this.provider() === 'aws' ? new Date(since).toISOString() : String(since);
  }

  // ── Portal (EPIC 9) ────────────────────────────────────────────────────────

  /**
   * Reads the deployed workflow's publish record and publish-readiness.
   * Returns null when the worker is unreachable or the workflow was never
   * pushed, same contract as {@link listRuns}.
   */
  async fetchPortal(workflowId: string): Promise<PortalStatusResponse | null> {
    return this.portalRequest<PortalStatusResponse>(workflowId, 'portal', 'GET');
  }

  /**
   * Publishes the pushed spec's portal trigger. The worker re-validates, so a
   * stale studio state cannot publish a broken portal.
   */
  async publishPortal(workflowId: string): Promise<PortalPublishResponse | null> {
    return this.portalRequest<PortalPublishResponse>(workflowId, 'publish', 'POST');
  }

  /** Takes the portal offline. The slug is released for reuse. */
  async unpublishPortal(workflowId: string): Promise<{ ok: boolean; removed?: string[] } | null> {
    return this.portalRequest(workflowId, 'unpublish', 'POST');
  }

  /**
   * Mints a scoped access key. The plaintext comes back exactly ONCE - show it
   * to the user immediately, because the worker only stores its hash.
   */
  async mintPortalToken(workflowId: string, label: string): Promise<PortalMintResponse | null> {
    return this.portalRequest<PortalMintResponse>(workflowId, 'portal-tokens', 'POST', { label });
  }

  /** Revokes one access key by id. */
  async revokePortalToken(workflowId: string, tokenId: string): Promise<{ ok: boolean } | null> {
    return this.portalRequest(
      workflowId,
      `portal-tokens/${encodeURIComponent(tokenId)}`,
      'DELETE',
    );
  }

  /**
   * Portal-sourced runs. Portal runs execute in per-visitor session instances,
   * so the owner instance mirrors their summaries here.
   */
  async listPortalRuns(workflowId: string): Promise<RunRecordSummary[] | null> {
    const body = await this.portalRequest<{ runs?: RunRecordSummary[] }>(
      workflowId,
      'portal-runs',
      'GET',
    );
    return body ? (body.runs ?? []) : null;
  }

  /**
   * The public address a published portal is served from.
   *
   * A custom portal domain wins when set. Note this is deliberately NOT the
   * same as {@link effectiveWorkerUrl}, which also carries the PRIVATE control
   * plane (push, monitor, run history) - those must keep using the worker URL
   * so owner traffic never rides a public marketing domain.
   */
  portalUrl(slug: string): string | null {
    if (!slug) return null;
    // Own-Cloudflare only: a Phorma Cloud portal lives on our own host.
    if (this.provider() !== 'phorma') {
      const domain = this.deployConfig.portalDomain();
      if (domain) return `https://${domain}/p/${slug}`;
    }
    const base = this.effectiveWorkerUrl();
    return base ? `${base}/p/${slug}` : null;
  }

  /**
   * Shared plumbing for the owner-side portal routes. Throws with the worker's
   * message on a 4xx/5xx so callers can surface it; returns null only when the
   * worker is unreachable or unconfigured.
   */
  private async portalRequest<T>(
    workflowId: string,
    action: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    let response: Response;
    try {
      response = await fetch(`${base}/${action}`, {
        method,
        headers: await this.headers(),
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    } catch {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    return payload;
  }

  /** Fetches one full cloud RunRecord (detail view / Bring to Canvas). */
  async fetchRunRecord(workflowId: string, runId: string): Promise<RunRecord | null> {
    const base = this.instanceUrl(workflowId);
    if (!base) return null;
    try {
      const result = await this.call<RunRecord | null>('run-detail', { workflowId, runId });
      return result.ok === true ? result.value : null;
    } catch {
      return null;
    }
  }

  // ── Monitor (WebSocket → RunControllerService.apply) ───────────────────────

  /**
   * Connects the monitor WebSocket. Defaults to the active workflow; pass a
   * `workflowId` to attach to a specific deployed workflow's live run (the
   * DO replays the in-flight run's events, then sends a `monitor-synced`
   * sentinel before live events continue).
   */
  async connect(workflowId?: string): Promise<void> {
    const spec = this.workflow.exportActiveSpec();
    const targetId = workflowId ?? spec?.id ?? '';
    const targetName = workflowId ?? spec?.name ?? 'workflow';
    const base = this.instanceUrl(targetId);
    if (!targetId || !base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }
    this.disconnect();

    // Only the URL differs by credential model. `aws` opens a presigned
    // Monitor_API `$connect` URL (Requirement 11.1); `phorma` and `cloudflare`
    // keep the existing `?token=` query shape (Requirement 11.4). The presign
    // happens HERE, inside `connect()`, so every reconnect attempt presigns
    // afresh and an expired 300 second URL recovers on its own
    // (Requirement 11.8).
    let socketUrl: string;
    if (this.provider() === 'aws') {
      try {
        socketUrl = await this.transport().monitorSocketUrl(base, targetId);
      } catch (error) {
        // Requirement 11.5: name the failure and open no socket. `connection`
        // is still `disconnected` from the `disconnect()` above, so returning
        // here cannot leave the UI stuck on `connecting`.
        this.toast.error(
          'Monitor unavailable',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    } else {
      socketUrl = this.tokenSocketUrl(base, await this.resolveAuthToken());
    }

    this.connection.set('connecting');
    const socket = new WebSocket(socketUrl);
    this.socket = socket;
    // The id every ControlFrame carries on the AWS path (see `send`).
    this.monitorWorkflowId = targetId;

    socket.onopen = () => {
      this.connection.set('connected');
      this.runController.remoteApprovalSender = (requestId, approved) =>
        this.approveRemote(requestId, approved);
      this.runController.remoteEventSender = (correlationKey, payload) =>
        this.sendEventRemote(correlationKey, payload);
      this.runController.remoteQuestionSender = (requestId, response) =>
        this.answerQuestionRemote(requestId, response);
      this.terminal.append('run', 'success', `Cloud monitor connected (${targetName}).`);
    };
    socket.onmessage = message => {
      try {
        const event = JSON.parse(message.data as string) as RunEvent | { type: 'monitor-synced' };
        // The replay-complete sentinel is monitor plumbing, not a run event.
        if (event.type === 'monitor-synced') return;
        this.runController.apply(event);
      } catch {
        // Ignore non-event frames.
      }
    };
    socket.onclose = event => {
      if (this.socket === socket) {
        this.socket = null;
        this.connection.set('disconnected');
        if (event.code === 4001) {
          this.toast.error('Cloud monitor rejected', 'Token mismatch - check the Cloud dialog.');
        }
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.toast.error('Cloud monitor error', 'Could not reach the worker WebSocket.');
      }
    };
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.monitorWorkflowId = '';
    this.connection.set('disconnected');
    this.runController.remoteApprovalSender = null;
    this.runController.remoteEventSender = null;
    this.runController.remoteQuestionSender = null;
    socket?.close();
  }

  // ── Remote run control (over the socket) ───────────────────────────────────
  /**
   * Triggers a run over HTTP (no monitor socket required) - used by the
   * eval runner (EPIC 4), which polls `listRuns` for completion instead of
   * listening on the WebSocket. Throws on rejection (409 busy, 402 quota…).
   */
  async triggerHttp(
    workflowId: string,
    input: string,
    source?: 'eval',
  ): Promise<{ runId: string }> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) throw new Error('Cloud worker is not configured.');
    // Minted here because the AWS host requires the caller to supply the run id
    // (its lease is keyed on it). The Cloudflare route table drops it, so the
    // Worker keeps minting its own.
    this.triggerCounter += 1;
    const runId = `run-${Date.now().toString(36)}-${this.triggerCounter}`;
    const result = await this.call<{ ok?: boolean; runId?: string; error?: string } | null>(
      'trigger',
      { workflowId, runId },
      { input, ...(source ? { source } : {}) } satisfies TriggerPayload,
    );
    if (result.ok === 'unsupported') throw this.unsupportedError('trigger');
    if (result.ok === false) {
      throw new Error(result.hostError ?? `Trigger failed (HTTP ${result.status}).`);
    }
    const body = result.value;
    if (!body?.ok || !body.runId) {
      throw new Error(body?.error ?? `Trigger failed (HTTP ${result.status}).`);
    }
    return { runId: body.runId };
  }
  triggerRemote(input: string): void {
    if (!this.send({ type: 'trigger', input })) {
      this.toast.warning('Not connected', 'Connect the cloud monitor first.');
    }
  }

  /**
   * Runs the ACTIVE document's deployment and watches it - a member's Run
   * (multi-organisation Requirements 10.1, 10.2, 10.3).
   *
   * Installed on `RunControllerService.deployedRunLauncher` by the shell, because
   * the controller must not inject this service (it is the far side of the known
   * NG0200 cycle). One seam, so the Runs panel button, the toolbar, F5 and the
   * assistant's run action all reach the deployment rather than three of them
   * starting a local run of a read-only spec.
   *
   * Two choices worth keeping. The monitor is attached FIRST, though ordering is a
   * courtesy rather than a correctness requirement: the Durable Object replays its
   * event log to a late-joining monitor, so a socket that opens mid-run catches up.
   * And the trigger goes over HTTP rather than the socket's `trigger` frame
   * precisely BECAUSE the socket may not be open yet - `triggerRemote` would report
   * "not connected" for a run that was one await away from being watchable.
   *
   * Entitlement, metering and the credits split need nothing here: `trigger`
   * resolves the instance's own `ownerId`, so a member's run is billed to the
   * ORGANISATION's bucket, and its usage arrives as ordinary RunEvents.
   */
  async runDeployedActive(input: string): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) {
      this.toast.warning(
        'Open a deployed workflow',
        'Pick one from your cloud library, then press Run.',
      );
      return;
    }
    if (!this.connected()) await this.connect(workflowId);
    try {
      await this.triggerHttp(workflowId, input);
    } catch (error) {
      // The worker's own sentence, verbatim: a refusal here is a quota, a lapsed
      // subscription or a busy instance, and it knows which of the three.
      this.toast.error(
        'Could not start the run',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  stopRemote(): void {
    this.send({ type: 'stop' });
  }

  approveRemote(requestId: string, approved: boolean): void {
    this.send({ type: 'approval', requestId, approved });
  }

  /** Answers a suspended Ask-User node over the WebSocket monitor. */
  answerQuestionRemote(requestId: string, response: string): void {
    this.send({ type: 'question', requestId, response });
  }

  /** Delivers an external event to a suspended Wait-for-Event node remotely. */
  sendEventRemote(correlationKey: string, payload: string): void {
    this.send({ type: 'event', correlationKey, payload });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Sends one ControlFrame over the monitor socket.
   *
   * On the AWS path the frame carries an extra `workflowId` member, because
   * outside `$connect` the Monitor_API has no query string and `AWS_IAM`
   * authorization populates no authorizer - so its `$default` request template
   * reads the workflow id from the frame body with `$input.path('$.workflowId')`
   * to build the `wf#{workflowId}` partition key (Requirement 11.7). Added in
   * this ONE place rather than at the five call sites, and ONLY for `aws`: the
   * Cloudflare wire format must not change. `parseFrame` in `cloud-aws` inspects
   * only `type` and the union's own fields, so the extra member is inert there.
   */
  private send(frame: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const payload =
      this.provider() === 'aws' ? { ...frame, workflowId: this.monitorWorkflowId } : frame;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  /**
   * The monitor socket URL both Cloudflare targets use: the instance URL with
   * `http`/`https` swapped for `ws`/`wss` and the bearer token as a `token`
   * query parameter, which is the only way a browser WebSocket can carry it.
   */
  private tokenSocketUrl(instanceBase: string, token: string | null): string {
    const url = new URL(instanceBase.replace(/^http/, 'ws'));
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  // ── The transport seam and the endpoint dispatcher ─────────────────────────

  /**
   * `fetch` plus an `Authorization: Bearer` header - the credential model both
   * Cloudflare targets use.
   *
   * A transport failure THROWS, exactly as `fetch` does, because
   * `CloudTransportResponse` describes an HTTP answer and has no failure
   * variant. That is what keeps every existing `catch` in this service working
   * unchanged.
   */
  private readonly fetchTransport: CloudTransport = {
    id: 'fetch-bearer',
    send: async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        // The transport's own headers first, so a route table can never override
        // the credential by declaring an `Authorization` of its own.
        headers: { ...init.headers, ...(await this.headers()) },
        body: init.body,
      });
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    monitorSocketUrl: async instanceBase =>
      this.tokenSocketUrl(instanceBase, await this.resolveAuthToken()),
  };

  /**
   * The signed request the `phorma-aws request` verb makes, because an
   * AWS_IAM-authorized route needs SigV4 and the webview holds no AWS
   * credentials (Requirement 10.8).
   *
   * An HTTP status is never a failure here: `AwsRequestService` reports a 409 as
   * `ok: true` with `status: 409`, so only "no response arrived at all" throws.
   */
  private readonly awsTransport: CloudTransport = {
    id: 'aws-cli',
    send: async (url, init) => {
      const result = await this.awsRequest.send(url, init);
      if (!result.ok) throw new Error(result.message);
      const { status, body } = result.response;
      return { status, ok: status >= 200 && status < 300, body };
    },
    /**
     * Presigns a Monitor_API `$connect` URL through the CLI's `monitor-url`
     * verb (Requirement 11.1). `instanceBase` is deliberately unused: the
     * signature covers the host, the path and the signed `workflowId` query
     * parameter, so re-deriving any of it here would fight the signature.
     *
     * Throws on a failed presign, like `send` does, so `connect()` can toast
     * the failure and return before it opens a socket (Requirement 11.5). The
     * URL is good for 300 seconds and is never cached (Requirement 11.8).
     */
    monitorSocketUrl: async (_instanceBase, workflowId) => {
      const result = await this.awsRequest.monitorUrl(workflowId);
      if (!result.ok) throw new Error(result.message);
      return result.url;
    },
  };

  /**
   * Which credential model carries a request. Selected by the persisted deploy
   * target and nothing else - never by operation, never by URL.
   */
  private readonly transport = computed<CloudTransport>(() =>
    this.provider() === 'aws' ? this.awsTransport : this.fetchTransport,
  );

  /**
   * Dispatches one logical operation against the selected target.
   *
   * Everything host-specific is data: the endpoint registry supplies the
   * method, the scope, the path, the request-body reshaper and the response
   * unwrapper, and the {@link CloudTransport} seam supplies the credential
   * model. Nothing here knows which host it is talking to, which is what keeps
   * each of the eleven endpoint methods at exactly one call.
   *
   * Three outcomes, all returned rather than thrown:
   *
   * - `{ ok: true }` with the unwrapped value, for a 2xx.
   * - `{ ok: false }` for any other status, carrying the host's own message.
   * - `{ ok: 'unsupported' }` when this target declares no route for `op`, or
   *   when there is no base URL to address (the caller has already guarded
   *   that, and both mean "do not attempt this request").
   *
   * A transport failure and an unparseable body both throw, matching `fetch`
   * and `Response.json()`, so every existing catch block behaves as before.
   */
  private call<T>(
    op: CloudOperation,
    ctx: CloudEndpointContext,
    payload?: unknown,
  ): Promise<CloudCallResult<T>> {
    return dispatchCloudOperation<T>(
      DEPLOY_TARGETS[this.provider() ?? 'cloudflare'].endpoints,
      this.transport(),
      {
        root: () => this.effectiveWorkerUrl(),
        instance: workflowId => this.instanceUrl(workflowId),
      },
      op,
      ctx,
      payload,
    );
  }

  /**
   * The refusal for an operation this target declares no route for, in the
   * cases where there IS no sensible absent value - a write the operator asked
   * for cannot silently do nothing.
   */
  private unsupportedError(op: CloudOperation): Error {
    const label = DEPLOY_TARGETS[this.provider() ?? 'cloudflare'].label;
    return new Error(`${label} has no ${op} route.`);
  }

  /**
   * Instance URL for a workflow id, shaped by the selected target's registry
   * entry and nowhere else (Requirement 12.4): `/agents/workflow-agent/{id}` on
   * Cloudflare, `/workflows/{id}` on AWS.
   */
  private instanceUrl(workflowId: string): string | null {
    const base = this.effectiveWorkerUrl();
    if (!base) return null;
    return DEPLOY_TARGETS[this.provider() ?? 'cloudflare'].instanceUrl(
      base,
      workflowId || 'default',
    );
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await this.resolveAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // The ACTIVE owner, beside the bearer (multi-organisation-phorma,
    // Requirement 20.4). Empty for a personal account, and empty for a BYO target
    // too - `X-Phorma-Owner` is ignored by a `shared` credential, so one code path
    // covers both rather than a branch per target.
    return { ...headers, ...this.activeOwner.ownerHeader() };
  }

  /**
   * Resolves the bearer token to send to the cloud worker.
   *
   * The desktop device token comes FIRST, and that ordering is the fix for a
   * shipped bug: on a packaged build Clerk never loads a session, so this method
   * fell through to `provider() === 'phorma' -> null` and every deploy, status and
   * monitor call went out with NO Authorization header at all. The hosted worker
   * fails those closed, so a signed-in desktop user could not deploy.
   *
   * After that, a fresh Clerk session JWT for a browser build. Own-Cloudflare
   * deployments may fall back to the static PHORMA_TOKEN; Phorma Cloud accepts
   * only a verified account credential, never the static token.
   */
  private async resolveAuthToken(): Promise<string | null> {
    const deviceToken = await this.desktopAuth.token();
    if (deviceToken) return deviceToken;
    const clerk = await firstValueFrom(this.clerk.clerk$);
    const session = await firstValueFrom(this.clerk.session$);
    if (clerk && session) {
      try {
        const jwt = await session.getToken();
        if (jwt) return jwt;
      } catch {
        // Token refresh failed - fall through to static token.
      }
    }
    if (this.provider() === 'phorma') return null; // never send the static token
    return this.token() || null;
  }
}
