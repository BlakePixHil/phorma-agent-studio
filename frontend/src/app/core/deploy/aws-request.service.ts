/**
 * One SigV4-signed HTTP call to the Trigger_API, carried through the
 * Phorma_AWS_CLI `request` verb.
 *
 * The webview holds no AWS credentials and cannot sign anything, so every AWS
 * HTTP call leaves the app as `npx phorma-aws request <url> <method>` through the
 * Deploy_Runner (`run_streamed_command`). The CLI resolves ambient credentials,
 * signs, performs the call, and reports status, headers and body back through the
 * Sentinel_Envelope. That is what lets a caller tell a 409 from a broken pipe:
 * an HTTP response of ANY status exits 0, and only a transport or credential
 * failure exits non-zero.
 *
 * Three rules this service exists to hold:
 *
 * 1. THE BODY NEVER TOUCHES `args`. It travels through `stdinData`, which the
 *    Rust side writes to the child's stdin and then closes. A request body can
 *    carry connection metadata and workflow content, and `args` is visible in a
 *    process listing.
 * 2. NO CONCURRENCY GUARD. `inFlight` is this service's own accounting and is
 *    never `AwsCliService.running` (Req 10.10), so a run-history read proceeds
 *    while a deploy streams. There is deliberately no mutual exclusion.
 * 3. NO `CloudService` EDGE. Injects `TauriService`, `AwsDeployConfigService` and
 *    `ToastService` only (Req 10.9). `CloudService -> AwsRequestService` is
 *    one-way, so the known
 *    `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 *    CloudService` NG0200 cycle is untouched.
 *
 * Feature: aws-byo-deploy
 * Requirements: 10.1, 10.2, 10.5, 10.6, 10.7, 10.9, 10.10, 10.11, 11.1
 */

import { Injectable, inject, signal } from '@angular/core';

import { ToastService } from '../../shared/toast/toast.service';
import { TauriService } from '../tauri.service';
import { AwsDeployConfigService } from './aws-deploy-config.service';
import type { HttpMethod } from './cloud-transport';
import { AWS_AUTH_FAILURE_EXIT_CODE } from './deploy-targets';
import { SENTINEL_PREFIX, decodeSentinelEnvelope } from './sentinel-envelope';

/** One HTTP response as the `request` verb reported it, whatever the status. */
export interface AwsHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

/**
 * Why a call produced no HTTP response at all.
 *
 * `transport` and `envelope` are both "the bytes did not arrive"; they are kept
 * apart because an envelope gap names a sequence number and points at the wire
 * format, while a transport failure points at the network or the CLI. Neither is
 * ever an HTTP status: a status arrives as `{ ok: true }`.
 */
export type AwsRequestFailureKind =
  'not-desktop' | 'not-configured' | 'transport' | 'envelope' | 'auth';

/** Either an HTTP response of any status, or a reason no response arrived. */
export type AwsRequestResult =
  | { ok: true; response: AwsHttpResponse }
  | { ok: false; kind: AwsRequestFailureKind; message: string };

/** Presigned monitor `$connect` URL, or why it could not be obtained. */
export type AwsMonitorUrlResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * The one operator instruction for exit code 4, shared by `request` and
 * `monitor-url` so the advice never depends on which verb hit it (Req 10.7).
 */
export const AWS_SESSION_EXPIRED_MESSAGE =
  'AWS session expired. Run `aws sso login`, then try again.';

/** Browser preview refusal, returned before any invoke (Req 10.11). */
export const AWS_BROWSER_PREVIEW_MESSAGE =
  'AWS calls require the desktop app. The browser preview cannot reach your Trigger API.';

/** An unset `cloudAwsDirectory` means there is nothing to run the CLI in. */
export const AWS_NOT_CONFIGURED_MESSAGE =
  'Set up the deploy runtime in Settings so the Studio can reach your AWS deployment.';

/** Longest stderr text carried into a failure message, so a toast stays readable. */
const MAX_STDERR_MESSAGE_CHARS = 1000;

/** What one Deploy_Runner invocation produced, before any payload interpretation. */
interface VerbOutcome {
  /** False when the Deploy_Runner itself could not run the command. */
  invoked: boolean;
  exitCode: number | null;
  /** Only lines carrying the sentinel prefix. Other stdout is dropped. */
  sentinelLines: string[];
  /** Buffered stderr, joined. Never written to the run console. */
  stderr: string;
}

@Injectable({ providedIn: 'root' })
export class AwsRequestService {
  private readonly tauri = inject(TauriService);
  private readonly config = inject(AwsDeployConfigService);
  private readonly toast = inject(ToastService);

  /**
   * How many AWS HTTP calls are in flight.
   *
   * Own accounting, deliberately NOT `AwsCliService.running`: this signal is
   * never read as a gate, so concurrent reads all proceed and a deploy in the
   * other service blocks nothing (Req 10.10). It exists so a surface can show a
   * spinner.
   */
  readonly inFlight = signal(0);

  private counter = 0;

  /**
   * Perform one signed HTTP call.
   *
   * The URL lands at `process.argv` index 3 and the method at index 4, which is
   * the argument contract `cli/request.ts` documents. The body goes on stdin
   * (Req 10.2) and is absent from `args` (Req 10.1).
   */
  async send(url: string, init: { method: HttpMethod; body?: string }): Promise<AwsRequestResult> {
    this.inFlight.update((n) => n + 1);
    try {
      const refusal = this.refuseUnusableEnvironment();
      if (refusal) return refusal;

      const outcome = await this.runVerb(
        ['phorma-aws', 'request', url, init.method],
        init.body ?? '',
      );
      const failure = this.failureFromExit(outcome);
      if (failure) return failure;

      const decoded = decodeSentinelEnvelope(outcome.sentinelLines);
      if (!decoded.ok) return { ok: false, kind: 'envelope', message: decoded.error };

      const response = parseHttpResponsePayload(decoded.payload);
      if (!response) {
        return {
          ok: false,
          kind: 'envelope',
          message: 'The request verb returned an envelope that is not an HTTP response.',
        };
      }
      return { ok: true, response };
    } finally {
      this.inFlight.update((n) => n - 1);
    }
  }

  /**
   * Presign a Monitor_API `$connect` URL for `workflowId` (Req 11.1).
   *
   * Decoded through the same envelope path as {@link send}, because there is one
   * wire format and one decoder. The URL is valid for 300 seconds by the CLI's
   * design, so callers presign afresh on every reconnect rather than caching it.
   */
  async monitorUrl(workflowId: string): Promise<AwsMonitorUrlResult> {
    this.inFlight.update((n) => n + 1);
    try {
      const refusal = this.refuseUnusableEnvironment();
      if (refusal) return { ok: false, message: refusal.message };

      const outcome = await this.runVerb(['phorma-aws', 'monitor-url', workflowId], '');
      const failure = this.failureFromExit(outcome);
      if (failure) return { ok: false, message: failure.message };

      const decoded = decodeSentinelEnvelope(outcome.sentinelLines);
      if (!decoded.ok) return { ok: false, message: decoded.error };

      const url = parseMonitorUrlPayload(decoded.payload);
      if (!url) {
        return {
          ok: false,
          message: 'The monitor-url verb returned an envelope that carries no URL.',
        };
      }
      return { ok: true, url };
    } finally {
      this.inFlight.update((n) => n - 1);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * The two refusals that precede any invoke: browser preview (Req 10.11) and an
   * unconfigured `cloud-aws` directory. Both are returned, not thrown, because a
   * caller in the middle of a push needs to keep its own error path.
   */
  private refuseUnusableEnvironment(): {
    ok: false;
    kind: AwsRequestFailureKind;
    message: string;
  } | null {
    if (!this.tauri.isDesktop) {
      return { ok: false, kind: 'not-desktop', message: AWS_BROWSER_PREVIEW_MESSAGE };
    }
    if (!this.config.cloudAwsDirectory()) {
      return { ok: false, kind: 'not-configured', message: AWS_NOT_CONFIGURED_MESSAGE };
    }
    return null;
  }

  /**
   * Run one `phorma-aws` verb through the Deploy_Runner and collect its output.
   *
   * Output correlation is by `requestId`: the `process-output-event` listener is
   * global, so every other command's lines must be discarded here or two
   * concurrent reads would decode each other's envelopes. Within this request's
   * lines, `stdout` is kept only when it carries the sentinel prefix (npm notices
   * and progress text are not payload), `stderr` is buffered for the failure
   * message, and `exit` is ignored because the invoke's own result carries the
   * code.
   *
   * Nothing here reaches the run console: a data read is not operator output.
   */
  private async runVerb(args: readonly string[], stdinData: string): Promise<VerbOutcome> {
    this.counter += 1;
    const requestId = `aws-req-${this.counter}`;
    const sentinelLines: string[] = [];
    const stderrLines: string[] = [];

    let unlisten: (() => void) | undefined;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');

      unlisten = await listen<{ requestId: string; stream: string; line: string }>(
        'process-output-event',
        (event) => {
          const payload = event.payload;
          if (payload.requestId !== requestId) return;
          if (payload.stream === 'stderr') {
            stderrLines.push(payload.line);
            return;
          }
          if (payload.stream !== 'stdout') return;
          if (payload.line.trimStart().startsWith(SENTINEL_PREFIX))
            sentinelLines.push(payload.line);
        },
      );

      const result = await invoke<{ success: boolean; exitCode: number | null }>(
        'run_streamed_command',
        {
          requestId,
          cwd: this.config.cloudAwsDirectory(),
          program: 'npx',
          // The body is NOT here. It is on stdin, so it cannot reach a process
          // listing.
          args: [...args],
          stdinData,
        },
      );
      return {
        invoked: true,
        exitCode: result.exitCode,
        sentinelLines,
        stderr: joinStderr(stderrLines),
      };
    } catch (error) {
      // The Deploy_Runner could not start the command at all: no npx, a bad cwd,
      // or the IPC bridge rejected. Never an HTTP condition.
      return {
        invoked: false,
        exitCode: null,
        sentinelLines,
        stderr: error instanceof Error ? error.message : String(error),
      };
    } finally {
      unlisten?.();
    }
  }

  /**
   * Map a non-zero exit to a failure, or `null` when the verb reported success
   * and its envelope is worth decoding.
   *
   * Exit 4 is the credential code every verb reserves, so it produces the one
   * `aws sso login` message (Req 10.7) and is the single kind this service
   * surfaces itself: re-authenticating is an operator action no caller can take
   * on their behalf, and the same instruction is correct wherever the call came
   * from. Every other kind stays silent so the caller owns its own messaging.
   */
  private failureFromExit(
    outcome: VerbOutcome,
  ): { ok: false; kind: AwsRequestFailureKind; message: string } | null {
    if (outcome.exitCode === AWS_AUTH_FAILURE_EXIT_CODE) {
      this.toast.error('AWS session expired', AWS_SESSION_EXPIRED_MESSAGE);
      return { ok: false, kind: 'auth', message: AWS_SESSION_EXPIRED_MESSAGE };
    }
    if (!outcome.invoked) {
      return {
        ok: false,
        kind: 'transport',
        message: outcome.stderr || 'The AWS CLI could not be started.',
      };
    }
    if (outcome.exitCode !== 0) {
      const code = outcome.exitCode === null ? 'terminated' : `code ${outcome.exitCode}`;
      return {
        ok: false,
        kind: 'transport',
        message: outcome.stderr || `The AWS CLI exited with ${code}.`,
      };
    }
    return null;
  }
}

/** Buffered stderr as one message, capped so a failure toast stays readable. */
function joinStderr(lines: readonly string[]): string {
  const joined = lines.join('\n').trim();
  return joined.length > MAX_STDERR_MESSAGE_CHARS
    ? `${joined.slice(0, MAX_STDERR_MESSAGE_CHARS)}...`
    : joined;
}

/**
 * The `http-response` payload, or `undefined` when the envelope carried
 * something else.
 *
 * Validated field by field rather than cast: this string crossed a process
 * boundary, and a wrong `status` type would surface later as a mis-read HTTP
 * result rather than as a decode failure.
 */
function parseHttpResponsePayload(payload: string): AwsHttpResponse | undefined {
  const parsed = parseJson(payload);
  if (!parsed || parsed['kind'] !== 'http-response') return undefined;
  const status = parsed['status'];
  const body = parsed['body'];
  if (typeof status !== 'number' || !Number.isFinite(status)) return undefined;
  if (typeof body !== 'string') return undefined;

  const rawHeaders = parsed['headers'];
  const headers: Record<string, string> = {};
  if (typeof rawHeaders === 'object' && rawHeaders !== null) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  return { status, headers, body };
}

/** The `monitor-url` payload's URL, or `undefined` when the envelope carried something else. */
function parseMonitorUrlPayload(payload: string): string | undefined {
  const parsed = parseJson(payload);
  if (!parsed || parsed['kind'] !== 'monitor-url') return undefined;
  const url = parsed['url'];
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/** A JSON object, or `undefined` for malformed JSON and every non-object value. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
