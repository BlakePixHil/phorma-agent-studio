/**
 * The Server_Entry configuration contract: what the task definition must set,
 * and how the process reads it (Req 7.9).
 *
 * `readServerEnv` takes the environment as a PARAMETER rather than reading
 * `process.env` itself. `cloud-aws` installs no `@types/node`, so a bare
 * `process` reference would not type-check under `tsc --noEmit`; the caller
 * (`server/index.ts main()`) passes `process.env` at the one place where a Node
 * runtime is guaranteed to exist. That also makes the whole validation testable
 * with a plain object.
 *
 * Two lists are exported because the estate has two providers of these values:
 * the IaC_App sets seven names on the container definition, and the Fargate
 * agent sets `AWS_REGION` for us. `REQUIRED_ENV_NAMES` is the union, so the
 * startup check and the template assertion in `infra/template.spec.ts` read one
 * source and cannot drift apart.
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.9
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Listener port when `PORT` is unset. Matches the container health check. */
export const DEFAULT_PORT = 8080;

/** Frame inbox drain interval in milliseconds. */
export const FRAME_DRAIN_INTERVAL_MS = 500;

/**
 * Hard ceiling on shutdown, in milliseconds. Chosen below the 30 second budget
 * in Req 7.8 so the guard timer still fires inside it.
 */
export const SHUTDOWN_BUDGET_MS = 25_000;

/** Lowest and highest values a TCP port may take. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

// ---------------------------------------------------------------------------
// The required names
// ---------------------------------------------------------------------------

/**
 * Required names the ECS agent injects into the task, not the task definition.
 * The IaC_App must NOT set these, so the template assertion excludes them.
 */
export const AGENT_PROVIDED_ENV_NAMES = Object.freeze(['AWS_REGION'] as const);

/**
 * Required names the IaC_App sets in the `environment` block of the container
 * definition. `infra/template.spec.ts` imports this list and asserts every entry
 * is present on the synthesized container.
 */
export const TASK_DEFINITION_ENV_NAMES = Object.freeze([
  'PHORMA_RUN_TABLE',
  'PHORMA_MONITOR_ENDPOINT',
  'PHORMA_SECRET_PREFIX',
  'PHORMA_SCHEDULE_GROUP',
  'PHORMA_METRIC_NAMESPACE',
  'PHORMA_SCHEDULE_TARGET_ARN',
  'PHORMA_SCHEDULE_ROLE_ARN',
] as const);

/** Every name `readServerEnv` requires, whoever provides it. */
export const REQUIRED_ENV_NAMES = Object.freeze([
  ...AGENT_PROVIDED_ENV_NAMES,
  ...TASK_DEFINITION_ENV_NAMES,
] as const);

/** A name that must be present and non-blank for startup to proceed. */
export type RequiredEnvName = (typeof REQUIRED_ENV_NAMES)[number];

/** Names that carry a default, so their absence is not a misconfiguration. */
export const OPTIONAL_ENV_NAMES = Object.freeze(['PHORMA_RUNNER_ID', 'PORT'] as const);

// ---------------------------------------------------------------------------
// The resolved shape
// ---------------------------------------------------------------------------

export interface ServerEnv {
  region: string; // AWS_REGION
  runTableName: string; // PHORMA_RUN_TABLE
  monitorEndpoint: string; // PHORMA_MONITOR_ENDPOINT
  secretPrefix: string; // PHORMA_SECRET_PREFIX
  scheduleGroup: string; // PHORMA_SCHEDULE_GROUP
  metricNamespace: string; // PHORMA_METRIC_NAMESPACE
  /**
   * The Schedule_Shim function ARN every created schedule targets.
   * `PHORMA_SCHEDULE_TARGET_ARN`.
   */
  scheduleTargetArn: string;
  scheduleRoleArn: string; // PHORMA_SCHEDULE_ROLE_ARN
  runnerId: string; // PHORMA_RUNNER_ID, defaults to a generated id
  port: number; // PORT, defaults to DEFAULT_PORT
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Thrown when one or more required variables are absent.
 *
 * `missing` carries the names as structured data, not only inside the message,
 * because the caller writes one name per line to stderr and the property test
 * compares the reported set against the omitted set exactly.
 */
export class MissingEnvError extends Error {
  /** Every absent required name, in `REQUIRED_ENV_NAMES` order. Never truncated. */
  readonly missing: readonly RequiredEnvName[];

  constructor(missing: readonly RequiredEnvName[]) {
    super(`AWS_Host startup failed: missing environment variables: ${missing.join(', ')}`);
    this.name = 'MissingEnvError';
    this.missing = missing;
  }
}

/**
 * Thrown when a variable is present but unusable, currently only `PORT`.
 *
 * This is a separate type from `MissingEnvError` on purpose: absence and
 * malformation are different operator mistakes, and keeping `MissingEnvError`
 * exclusively about absence keeps `missing` an exact report of what is not set.
 */
export class InvalidEnvError extends Error {
  /** The offending variable name. */
  readonly variable: string;
  /** The value as the environment carried it, before trimming. */
  readonly value: string;

  constructor(variable: string, value: string, expected: string) {
    super(`AWS_Host startup failed: ${variable}="${value}" is not ${expected}`);
    this.name = 'InvalidEnvError';
    this.variable = variable;
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Optional value handling
// ---------------------------------------------------------------------------

/** A blank value is treated as absent: a task definition with `""` is a mistake. */
function present(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse `PORT`.
 *
 * Absent or blank yields `DEFAULT_PORT`. Anything else must be a base-10 integer
 * inside the TCP port range: a non-numeric or out-of-range value throws
 * `InvalidEnvError` rather than producing `NaN` and failing later inside
 * `listen`, where the cause would be far from the misconfiguration.
 */
function readPort(raw: string | undefined): number {
  const value = present(raw);
  if (value === undefined) return DEFAULT_PORT;

  const expected = `a base-10 integer between ${MIN_PORT} and ${MAX_PORT}`;
  if (!/^\d+$/.test(value)) {
    throw new InvalidEnvError('PORT', raw ?? '', expected);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new InvalidEnvError('PORT', raw ?? '', expected);
  }
  return port;
}

/**
 * The one runtime global this module needs. `globalThis.crypto` is the WebCrypto
 * global, present in every Node version this image runs. It is read through a
 * narrow local shape and guarded, so no `node:crypto` import reaches a package
 * that also compiles for the type-checker alone.
 */
interface UuidSource {
  randomUUID?: () => string;
}

/**
 * Build a runner id when `PHORMA_RUNNER_ID` is unset.
 *
 * Uniqueness is what matters: the id is the lease holder's identity, so two
 * concurrent tasks must never share one. The timestamp-plus-random fallback
 * exists only for a runtime with no WebCrypto global.
 */
function generateRunnerId(): string {
  const source = globalThis.crypto as UuidSource | undefined;
  if (typeof source?.randomUUID === 'function') {
    return `runner-${source.randomUUID()}`;
  }
  return `runner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read and validate the task-definition environment.
 *
 * Every required name is checked before anything is thrown, so the report names
 * EVERY absent variable and the operator fixes the task definition once instead
 * of once per redeploy. Surrounding whitespace is stripped from accepted values,
 * so a stray space in a table name or ARN never reaches a Run_Table key.
 *
 * The absence check runs first: a garbled `PORT` alongside missing names still
 * reports the missing names, which are the larger problem.
 *
 * @param env - The environment record, normally `process.env`.
 * @returns The resolved configuration, with `PHORMA_RUNNER_ID` and `PORT` defaulted.
 * @throws MissingEnvError naming every absent required variable.
 * @throws InvalidEnvError when `PORT` is present but not a valid port number.
 */
export function readServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const missing: RequiredEnvName[] = [];
  const values = new Map<RequiredEnvName, string>();

  for (const name of REQUIRED_ENV_NAMES) {
    const value = present(env[name]);
    if (value === undefined) missing.push(name);
    else values.set(name, value);
  }

  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  const required = (name: RequiredEnvName): string => values.get(name) as string;

  return {
    region: required('AWS_REGION'),
    runTableName: required('PHORMA_RUN_TABLE'),
    monitorEndpoint: required('PHORMA_MONITOR_ENDPOINT'),
    secretPrefix: required('PHORMA_SECRET_PREFIX'),
    scheduleGroup: required('PHORMA_SCHEDULE_GROUP'),
    metricNamespace: required('PHORMA_METRIC_NAMESPACE'),
    scheduleTargetArn: required('PHORMA_SCHEDULE_TARGET_ARN'),
    scheduleRoleArn: required('PHORMA_SCHEDULE_ROLE_ARN'),
    runnerId: present(env['PHORMA_RUNNER_ID']) ?? generateRunnerId(),
    port: readPort(env['PORT']),
  };
}
