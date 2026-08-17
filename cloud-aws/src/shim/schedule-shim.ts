/**
 * Schedule_Shim: the Lambda EventBridge Scheduler invokes when a cron fires.
 *
 * ## Why this exists
 *
 * EventBridge Scheduler cannot target an API Gateway route. Its templated
 * targets are CodeBuild, CodePipeline, ECS RunTask, EventBridge PutEvents,
 * Inspector, Kinesis, Firehose, Lambda Invoke, SageMaker, SNS, SQS and Step
 * Functions, and its universal target reaches AWS SDK API operations rather than
 * arbitrary REST endpoints. There is no `execute-api:Invoke` target of either
 * kind. An `execute-api` ARN IS a valid target for an EventBridge *rule*, which
 * is a different service, and that mismatch is why every scheduled workflow push
 * used to fail: `CreateSchedule` rejected the target outright.
 *
 * Lambda `Invoke` is a supported templated target, so the schedule invokes this
 * function and this function calls the Trigger_Route the Studio already calls.
 *
 * ## Why the shim rather than a queue
 *
 * Every other ingress into a run goes through `POST /workflows/{id}/trigger`:
 * the Studio, a webhook, a manual run. Draining a queue inside the task would
 * have added a SECOND ingress, which means a second place where the
 * Execution_Lease is acquired and the 409-plus-skip-record contention rule is
 * implemented. Calling the existing route keeps one ingress and one set of
 * semantics, so a scheduled run is the same code path as a manual one.
 *
 * ## Why the run id is minted here
 *
 * The trigger route requires a `runId`, and the schedule's stored input cannot
 * carry one: the input is fixed at spec-push time, so a baked-in id would be
 * reused by every fire of that schedule for as long as it exists. A fresh id per
 * invocation is the whole reason this function has any logic at all.
 *
 * ## Failure semantics
 *
 * The exit condition answers one question: should EventBridge Scheduler retry?
 *
 * - 2xx: the run started. Success.
 * - 409: another Runner holds the lease, so the workflow is already running.
 *   This is a NORMAL outcome with a recorded skip record, not a failure. It must
 *   not throw, or every legitimate concurrent-run skip would raise the Lambda
 *   error metric and page somebody.
 * - 404: the spec is gone. The runtime has already deleted the orphan schedule
 *   and published the skipped-scheduled-run metric, so there is nothing to retry.
 * - Any other status, or a transport failure: throw, so Scheduler retries and the
 *   invocation-error metric means what it says.
 *
 * Feature: aws-byo-deploy
 */

// ---------------------------------------------------------------------------
// Runtime globals
// ---------------------------------------------------------------------------

/**
 * `cloud-aws` installs no `@types/node`, so `process` is reached through
 * `globalThis` behind a narrow local shape - the pattern
 * `aws/stdout-log-writer.ts`, `server/startup.ts` and `cli/runtime.ts` already
 * use. `crypto` and `fetch` are typed by `lib.dom`, which this package includes,
 * and both are present in the Node 22 Lambda runtime.
 */
interface ProcessLike {
  env: Record<string, string | undefined>;
}

function currentEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: ProcessLike }).process?.env ?? {};
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Base URL of the Trigger_API, set by the IaC_App. No trailing slash. */
export const TRIGGER_API_URL_ENV = 'PHORMA_TRIGGER_API_URL';

/** Signing region, set by the IaC_App rather than read from the Lambda region. */
export const REGION_ENV = 'PHORMA_REGION';

/** The service SigV4 signs `execute-api` calls as. */
const EXECUTE_API = 'execute-api';

export interface ShimEnv {
  readonly triggerApiUrl: string;
  readonly region: string;
}

/**
 * Read and validate the environment, naming every absent variable rather than
 * only the first, matching `server/env.ts`.
 */
export function readShimEnv(env: Record<string, string | undefined>): ShimEnv {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      missing.push(name);
      return '';
    }
    return value.trim();
  };

  const triggerApiUrl = read(TRIGGER_API_URL_ENV);
  const region = read(REGION_ENV);

  if (missing.length > 0) {
    throw new Error(`Schedule_Shim is missing required environment: ${missing.join(', ')}`);
  }

  return {
    // A trailing slash would compose a double slash into the route path, which
    // API Gateway treats as a different route and answers 404 for.
    triggerApiUrl: triggerApiUrl.replace(/\/+$/, ''),
    region,
  };
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * The input `SchedulerAdapter` stores on every schedule it creates. Narrowed
 * from `unknown` rather than typed by an SDK event package, so this module
 * declares its own contract with the adapter and needs no `@types/aws-lambda`.
 */
export interface ScheduleFireEvent {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly source?: string;
}

export function parseScheduleFireEvent(event: unknown): ScheduleFireEvent {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Schedule_Shim event must be a JSON object.');
  }
  const record = event as Record<string, unknown>;
  const workflowId = record['workflowId'];
  const nodeId = record['nodeId'];

  if (typeof workflowId !== 'string' || workflowId.trim() === '') {
    throw new Error('Schedule_Shim event must carry a non-empty "workflowId" string.');
  }
  if (typeof nodeId !== 'string' || nodeId.trim() === '') {
    throw new Error('Schedule_Shim event must carry a non-empty "nodeId" string.');
  }

  return { workflowId: workflowId.trim(), nodeId: nodeId.trim(), source: 'schedule' };
}

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

interface UuidSource {
  randomUUID(): string;
}

/**
 * A fresh run id per fire. Mirrors `generateRunnerId` in `server/env.ts`: read
 * WebCrypto through a guarded narrow shape so no `node:crypto` import reaches a
 * package that also compiles for the type-checker alone.
 */
export function mintRunId(now: () => number = Date.now): string {
  const source = globalThis.crypto as UuidSource | undefined;
  if (typeof source?.randomUUID === 'function') return `sched-${source.randomUUID()}`;
  // The Node 22 runtime always has WebCrypto, so this is a belt-and-braces path
  // rather than an expected one. It still has to be unique per fire.
  return `sched-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// The signed call
// ---------------------------------------------------------------------------

export interface TriggerOutcome {
  readonly status: number;
  readonly body: string;
}

/** The seam the handler calls, so a test can drive it without AWS or a network. */
export type TriggerSender = (
  url: string,
  method: string,
  body: string,
  region: string,
) => Promise<TriggerOutcome>;

/**
 * SigV4-sign and send. Every SDK package loads inside the call, exactly as
 * `cli/runtime.ts` does, so a cold start pays for the signer only when a
 * schedule actually fires.
 */
export const sendSigned: TriggerSender = async (url, method, body, region) => {
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { Sha256 } = await import('@aws-crypto/sha256-js');
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  const { HttpRequest } = await import('@smithy/protocol-http');
  const { parseUrl } = await import('@smithy/url-parser');

  const parsed = parseUrl(url);
  const signer = new SignatureV4({
    service: EXECUTE_API,
    region,
    // The task role's credentials, from the provider chain and nowhere else.
    credentials: fromNodeProviderChain(),
    sha256: Sha256,
  });

  const signed = await signer.sign(
    new HttpRequest({
      ...parsed,
      method,
      headers: { host: parsed.hostname, 'content-type': 'application/json' },
      body,
    }),
  );

  const response = await fetch(url, {
    method,
    headers: signed.headers as Record<string, string>,
    body,
  });

  return { status: response.status, body: await response.text() };
};

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface ShimResult {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly status: number;
  /** What the shim concluded, for the log line and for assertions. */
  readonly outcome: 'started' | 'already-running' | 'not-deployed';
}

export interface ShimDeps {
  readonly env?: Record<string, string | undefined>;
  readonly send?: TriggerSender;
  readonly runId?: () => string;
  readonly log?: (line: string) => void;
}

/**
 * Statuses that are answers rather than faults. See the failure semantics in the
 * module header: retrying either of these would achieve nothing.
 */
const TERMINAL_STATUSES: Readonly<Record<number, ShimResult['outcome']>> = Object.freeze({
  409: 'already-running',
  404: 'not-deployed',
});

export async function runShim(event: unknown, deps: ShimDeps = {}): Promise<ShimResult> {
  const env = readShimEnv(deps.env ?? currentEnv());
  const send = deps.send ?? sendSigned;
  const log = deps.log ?? ((line: string) => console.log(line));

  const fired = parseScheduleFireEvent(event);
  const runId = (deps.runId ?? mintRunId)();

  const url = `${env.triggerApiUrl}/workflows/${encodeURIComponent(fired.workflowId)}/trigger`;
  const body = JSON.stringify({
    workflowId: fired.workflowId,
    runId,
    source: 'schedule',
    nodeId: fired.nodeId,
  });

  const response = await send(url, 'POST', body, env.region);

  const terminal = TERMINAL_STATUSES[response.status];
  if (terminal !== undefined) {
    log(
      JSON.stringify({
        level: 'info',
        message: 'Scheduled run not started',
        outcome: terminal,
        workflowId: fired.workflowId,
        nodeId: fired.nodeId,
        runId,
        status: response.status,
      }),
    );
    return { ...fired, runId, status: response.status, outcome: terminal };
  }

  if (response.status < 200 || response.status >= 300) {
    // Throwing is the retry signal. The body is included because this is the one
    // place an operator can see why a cron did not run.
    throw new Error(
      `Trigger_API answered ${response.status} for workflow ${fired.workflowId} ` +
        `node ${fired.nodeId}: ${response.body.slice(0, 512)}`,
    );
  }

  log(
    JSON.stringify({
      level: 'info',
      message: 'Scheduled run started',
      workflowId: fired.workflowId,
      nodeId: fired.nodeId,
      runId,
      status: response.status,
    }),
  );
  return { ...fired, runId, status: response.status, outcome: 'started' };
}

/** The Lambda entry point. */
export async function handler(event: unknown): Promise<ShimResult> {
  return runShim(event);
}
