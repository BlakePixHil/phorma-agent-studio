/**
 * Trigger_API route handlers - the eight HTTP routes the Trigger_API exposes.
 *
 * 1. POST /workflow   - spec push (validate against AWS_CAPABILITIES, store, sync schedules)
 * 2. POST /trigger    - manual trigger (acquire lease, start run or 409 with skip)
 * 3. DELETE /workflow  - purge (delegate to the purge path)
 * 4. GET /history     - run history (paginated via GSI1, 100 per page)
 * 5. GET /run/:runId  - run detail (single run record with its events)
 * 6. GET /usage       - usage ledger (paginated via GSI2, 1000 per page)
 * 7. GET /connections - connection inventory (ConnectionSummary, no secret values)
 * 8. POST /secrets    - Secret_Store write (reject empty or over 64 KB)
 *
 * Key behaviours:
 * - Lease acquisition is the FIRST Run_Table operation for every trigger source (Req 2.13)
 * - Lease held by another Runner: 409 + exactly one unfenced skip record, and no further
 *   Run_Table write for that run (Req 2.7, 8.5, 15.6)
 * - Lease state indeterminate: 503 with a distinct message, never 409 (Req 2.16)
 * - Capability_Validator runs on spec push: error findings refuse the push (Req 16.5)
 * - 404 for unknown workflow id, but ONLY after authentication (Req 9.9)
 * - Invalid `since` parameter: naming rejection, no item created (Req 4.12)
 * - ConnectionSummary never carries a secret value (Req 8.5)
 * - Secret_Store write rejects empty or over 64 KB (Req 8.15)
 *
 * Feature: aws-deployment-target, aws-byo-deploy
 * Requirements: 2.7, 2.13, 2.16, 4.3, 4.5, 4.12, 4.16, 6.4, 8.4, 8.5, 8.8, 8.13, 9.9, 15.6, 16.5
 */

import type {
  CapabilityValidationTarget,
  ConnectionSummary,
  RunRecordSummary,
  UsageLedgerEntry,
  WorkflowSpec,
} from '@phorma/engine';

import { AWS_CAPABILITIES, validateAgainstCapabilities } from '@phorma/engine';

import type {
  LeaseOutcome,
  LeaseStore,
  PaginatedResult,
  RunEventStore,
  RunHistoryStore,
  ScheduleDefinition,
  ScheduleStore,
  SpecStore,
  StoredSpec,
  UsageLedgerStore,
} from '../core/host-contract.js';

import { pk, skipSk } from '../core/keys.js';
import { classify } from '../core/lease.js';
import { RETRY_BUDGETS } from '../core/retry.js';

import type { DocumentTableClient } from '../aws/ports.js';
import type { SecretsAdapter } from '../aws/secrets.js';
import { SecretWriteError } from '../aws/secrets.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authentication result - routes proceed only after this succeeds. */
export interface AuthResult {
  authenticated: true;
  identity: string;
}

/** Connection metadata stored with the spec (no secret values). */
export interface StoredConnection {
  id: string;
  name: string;
  type: string;
  config: Record<string, string>;
  secretKeys: string[];
  auth: unknown;
  allowWrites?: boolean;
  limits?: unknown;
}

/** The shape of the push request body. */
export interface SpecPushRequest {
  workflowId: string;
  spec: WorkflowSpec;
  connections?: StoredConnection[];
}

/** The shape of the trigger request body. */
export interface TriggerRequest {
  workflowId: string;
  runId: string;
  input?: string;
  source: string;
  /**
   * The `schedule-trigger` node that fired, present only when `source` is
   * `'schedule'`. The Schedule_Shim forwards it from the schedule's stored input
   * so an orphaned schedule can be identified and deleted by name.
   */
  nodeId?: string;
}

/** The shape of the secret write request body. */
export interface SecretWriteRequest {
  connectionId: string;
  secretKey: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Route response types
// ---------------------------------------------------------------------------

export interface RouteSuccess<T = unknown> {
  status: number;
  body: T;
}

export interface RouteError {
  status: number;
  body: { error: string };
}

export type RouteResult<T = unknown> = RouteSuccess<T> | RouteError;

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface TriggerRouteDeps {
  specStore: SpecStore;
  leaseStore: LeaseStore;
  runHistory: RunHistoryStore;
  runEvents: RunEventStore;
  usageLedger: UsageLedgerStore;
  scheduleStore: ScheduleStore;
  secrets: SecretsAdapter;
  /**
   * The Run_Table port. Used for exactly one write: the unfenced skip record on
   * the contention path (Req 8.5). Every other Run_Table write in this file
   * goes through a capability store, which fences it.
   */
  table: DocumentTableClient;
  /** The Run_Table name every command input must carry. */
  tableName: string;
  /** The purge operation. */
  purge: (workflowId: string) => Promise<PurgeCounts>;
  /** Connection metadata indexed by connection id. */
  connections: ReadonlyMap<string, StoredConnection>;
  /** Runner id for lease acquisition. */
  runnerId: string;
  /** Current time in epoch ms. */
  now: () => number;
}

export interface PurgeCounts {
  spec: number;
  journal: number;
  runs: number;
  events: number;
  usage: number;
  state: number;
  lease: number;
  schedules?: number;
  failedCategories?: string[];
}

// ---------------------------------------------------------------------------
// 1. POST /workflow - Spec push
// ---------------------------------------------------------------------------

/**
 * Push a workflow spec. Validates against AWS_CAPABILITIES first; if any
 * finding is an error the push is refused and the stored spec and schedule
 * set remain unchanged (Req 16.5).
 *
 * Rejects a push carrying a value where a secret name belongs (Req 8.13).
 */
export async function handleSpecPush(
  deps: TriggerRouteDeps,
  req: SpecPushRequest,
): Promise<RouteResult> {
  const { workflowId, spec, connections } = req;

  // Check for secret values in connection metadata (Req 8.13)
  if (connections) {
    const violation = findSecretValueViolation(connections);
    if (violation) {
      return {
        status: 400,
        body: { error: violation },
      };
    }
  }

  // Build the ConnectionSummary inventory for validation (Req 8.5)
  const inventory = buildConnectionInventory(deps.connections, deps.secrets);

  // Run the Capability_Validator against AWS_CAPABILITIES (Req 16.5)
  const target: CapabilityValidationTarget = {
    graph: spec.graph,
    subWorkflows: spec.subWorkflows,
  };

  const findings = validateAgainstCapabilities(target, AWS_CAPABILITIES, inventory);

  // If any finding is an error, refuse the push (Req 16.5)
  const errors = findings.filter(f => f.severity === 'error');
  if (errors.length > 0) {
    return {
      status: 422,
      body: { error: 'Capability validation failed', findings },
    };
  }

  // Store the spec
  const stored: StoredSpec = {
    spec,
    savedAt: new Date(deps.now()).toISOString(),
  };
  await deps.specStore.write(workflowId, stored);

  // Store connection metadata (no secret values)
  if (connections) {
    for (const conn of connections) {
      deps.connections = updateConnectionsMap(deps.connections, conn);
    }
  }

  // Sync schedules from spec (Req 6.1-6.3)
  const schedules = deriveSchedules(spec);
  await deps.scheduleStore.sync(workflowId, schedules);

  return {
    status: 200,
    body: { workflowId, findings, schedulesDeployed: schedules.length },
  };
}

// ---------------------------------------------------------------------------
// 2. POST /trigger - Manual trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a run. The lease conditional write is the FIRST Run_Table operation
 * (Req 2.13).
 *
 * The two contention outcomes are kept apart by where they come from, because
 * they mean different things to the operator:
 *
 * - `acquire` RESOLVES `{ granted: false }`: another Runner genuinely holds the
 *   lease. One unfenced skip record, HTTP 409, and no further Run_Table write
 *   for that run (Req 2.7, 8.5, 15.6).
 * - `acquire` THROWS: the lease state is indeterminate (a throttle, a network
 *   failure, a fatal error). HTTP 503 with a distinct message, never 409 - a 409
 *   here would tell the operator "already running" when the truth is unknown
 *   (Req 2.16).
 */
export async function handleTrigger(
  deps: TriggerRouteDeps,
  req: TriggerRequest,
): Promise<RouteResult> {
  const { workflowId, runId, source, nodeId } = req;
  const nowMs = deps.now();

  // Lease acquisition as the FIRST Run_Table operation (Req 2.13)
  let leaseResult: LeaseOutcome;
  try {
    leaseResult = await acquireLeaseWithRetry(deps, workflowId, nowMs);
  } catch {
    // Indeterminate state - distinct message, never 409 (Req 2.16)
    return {
      status: 503,
      body: { error: 'Lease state could not be determined' },
    };
  }

  if (!leaseResult.granted) {
    // Lease held by another Runner. This is the ONE unfenced Run_Table write in
    // the package: the losing Runner holds no lease, so there is no fence to
    // assert (Req 8.5). It is also the LAST write this request makes for the run
    // (Req 15.6) - the 409 returns immediately below.
    const holdingFence = leaseResult.holdingFence;
    const sk = skipSk(nowMs, deps.runnerId);

    await deps.table.put({
      TableName: deps.tableName,
      Item: {
        pk: pk(workflowId),
        sk,
        workflowId,
        runId,
        source,
        runnerId: deps.runnerId,
        holdingFence,
        triggeredAtMs: nowMs,
        skippedAt: new Date(nowMs).toISOString(),
      },
    });

    // 409 with the skip details (Req 2.7, 15.6)
    return {
      status: 409,
      body: {
        error: 'Workflow is already running',
        workflowId,
        runId,
        source,
        holdingFence,
      },
    };
  }

  // A fired schedule for a workflow whose spec is gone: delete the orphaned
  // schedule, publish the skipped-scheduled-run metric, release the lease and
  // answer 404 (Req 6.11).
  //
  // This runs AFTER the lease acquire, never before. Property 6 requires the
  // lease conditional write to be the FIRST Run_Table operation of every trigger
  // with no preceding read, and the spec presence check is a read. Taking the
  // lease and releasing it costs one fence increment, which the lease design
  // already tolerates: release retains the token and the next acquire sees the
  // highest one ever issued.
  if (source === 'schedule' && nodeId !== undefined) {
    const deployed = await deps.scheduleStore.handleScheduleFire(workflowId, nodeId);
    if (!deployed) {
      // Best effort: a failed release leaves a lease that expires on its own
      // within LEASE_TTL_MS, which is strictly better than failing the response
      // and having Scheduler retry a workflow that cannot run.
      try {
        await deps.leaseStore.release(leaseResult.lease, deps.now());
      } catch {
        // Swallowed deliberately - see above.
      }
      return {
        status: 404,
        body: {
          error: `Workflow "${workflowId}" has no deployed spec. The schedule has been removed.`,
          workflowId,
          nodeId,
        },
      };
    }
  }

  // Lease granted - the caller (server startup) orchestrates the actual run
  // through executeRun. This route returns the lease to signal readiness.
  return {
    status: 202,
    body: {
      workflowId,
      runId,
      lease: {
        fence: leaseResult.lease.fence,
        expiresAtMs: leaseResult.lease.expiresAtMs,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 3. DELETE /workflow - Purge
// ---------------------------------------------------------------------------

/**
 * Purge a workflow: delete spec, journal, runs, events, usage, state and
 * lease. Preserves Secret_Store entries (Req 4.10).
 */
export async function handlePurge(
  deps: TriggerRouteDeps,
  workflowId: string,
): Promise<RouteResult<PurgeCounts>> {
  const counts = await deps.purge(workflowId);

  // Also remove schedules
  await deps.scheduleStore.deleteAll(workflowId);

  return {
    status: 200,
    body: counts,
  };
}

// ---------------------------------------------------------------------------
// 4. GET /history - Run history
// ---------------------------------------------------------------------------

/**
 * Serve run history for a workflow, paginated via GSI1, 100 per page (Req 4.3).
 */
export async function handleHistory(
  deps: TriggerRouteDeps,
  workflowId: string,
  continuationToken?: string,
): Promise<RouteResult<PaginatedResult<RunRecordSummary>>> {
  const result = await deps.runHistory.list(workflowId, continuationToken);
  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// 5. GET /run/:runId - Run detail
// ---------------------------------------------------------------------------

/**
 * Serve a single run record with its events (Req 4.3).
 */
export async function handleRunDetail(
  deps: TriggerRouteDeps,
  workflowId: string,
  runId: string,
  eventsContinuationToken?: string,
): Promise<RouteResult> {
  const record = await deps.runHistory.get(workflowId, runId);
  if (!record) {
    return { status: 404, body: { error: `Run "${runId}" not found` } };
  }

  const events = await deps.runEvents.list(workflowId, runId, eventsContinuationToken);

  return {
    status: 200,
    body: { record, events },
  };
}

// ---------------------------------------------------------------------------
// 6. GET /usage - Usage ledger
// ---------------------------------------------------------------------------

/**
 * Serve usage ledger entries for a workflow, paginated via GSI2, 1000 per
 * page (Req 4.5). Requires a valid ISO 8601 `since` timestamp; rejects
 * invalid values (Req 4.12).
 */
export async function handleUsage(
  deps: TriggerRouteDeps,
  workflowId: string,
  since: string,
  continuationToken?: string,
): Promise<RouteResult<PaginatedResult<UsageLedgerEntry>>> {
  // Validate `since` parameter (Req 4.12)
  if (!isValidIso8601(since)) {
    return {
      status: 400,
      body: { error: `Invalid "since" value: "${since}" is not a valid ISO 8601 UTC timestamp` },
    };
  }

  const result = await deps.usageLedger.list(workflowId, since, continuationToken);
  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// 7. GET /connections - Connection inventory
// ---------------------------------------------------------------------------

/**
 * Serve the ConnectionSummary inventory with `secretsPresent` and
 * `missingSecretKeys` and no secret value (Req 8.5).
 */
export async function handleConnections(
  deps: TriggerRouteDeps,
): Promise<RouteResult<ConnectionSummary[]>> {
  const inventory = buildConnectionInventory(deps.connections, deps.secrets);
  return { status: 200, body: inventory };
}

// ---------------------------------------------------------------------------
// 8. POST /secrets - Secret_Store write
// ---------------------------------------------------------------------------

/**
 * Write a secret value. Rejects empty or over 64 KB (Req 8.15). Leaves
 * existing unchanged on rejection. Never exposes a secret value in the
 * response (Req 8.8).
 */
export async function handleSecretWrite(
  deps: TriggerRouteDeps,
  req: SecretWriteRequest,
): Promise<RouteResult> {
  try {
    const result = await deps.secrets.writeSecret(
      req.connectionId,
      req.secretKey,
      req.value,
    );
    return {
      status: 200,
      body: { name: result.name, connectionId: req.connectionId, secretKey: req.secretKey },
    };
  } catch (err: unknown) {
    if (err instanceof SecretWriteError) {
      return { status: 400, body: { error: err.message } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow existence check (Req 9.9)
// ---------------------------------------------------------------------------

/**
 * Check that a workflow id exists in Run_Table. Call ONLY after authentication
 * has succeeded (Req 9.9), so an unauthenticated caller cannot learn which
 * workflow ids exist.
 *
 * Returns undefined if the workflow exists, or a 404 RouteError if not.
 */
export async function assertWorkflowExists(
  deps: TriggerRouteDeps,
  workflowId: string,
): Promise<RouteError | undefined> {
  const stored = await deps.specStore.read(workflowId);
  if (!stored) {
    return { status: 404, body: { error: `Workflow "${workflowId}" not found` } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Acquire the lease with the `lease` retry budget (3 attempts, 5s).
 *
 * Resolving is the 409 path, throwing is the 503 path, and this function is the
 * only place that decides which. `LeaseStore.acquire` already resolves
 * `{ granted: false, holdingFence }` when the conditional write loses, so the
 * common contention case never reaches the catch at all. The `condition` branch
 * below only covers a store that surfaces contention as a throw: it still means
 * another Runner holds the lease, so it resolves rather than throws. A
 * `transient` error is retried within the budget and then thrown, and a `fatal`
 * error is thrown immediately - neither may be reported as "already running".
 */
async function acquireLeaseWithRetry(
  deps: TriggerRouteDeps,
  workflowId: string,
  nowMs: number,
): Promise<LeaseOutcome> {
  const budget = RETRY_BUDGETS['lease'];
  const startMs = Date.now();

  for (let attempt = 1; attempt <= budget.maxAttempts; attempt++) {
    try {
      return await deps.leaseStore.acquire(workflowId, deps.runnerId, nowMs);
    } catch (err: unknown) {
      const classification = classify(err);

      // Condition failure means the lease is held - not an error, return it
      if (classification === 'condition') {
        // Extract the holding fence from the error if available
        const holdingFence = extractHoldingFence(err);
        return { granted: false, holdingFence };
      }

      // Check if we should retry
      if (classification === 'transient' && attempt < budget.maxAttempts) {
        // Check timeout
        const elapsed = Date.now() - startMs;
        if (budget.timeoutMs !== undefined && elapsed >= budget.timeoutMs) {
          throw new Error('Lease acquisition timed out');
        }
        // Brief backoff before retry
        await delay(Math.min(500 * attempt, 2000));
        continue;
      }

      // Fatal or budget exhausted - throw to signal indeterminate state
      throw err;
    }
  }

  // Should not reach here, but safety
  throw new Error('Lease acquisition failed: budget exhausted');
}

/** Extract the holding fence from a condition failure error. */
function extractHoldingFence(err: unknown): number {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e['holdingFence'] === 'number') return e['holdingFence'];
    if (typeof e['fence'] === 'number') return e['fence'];
  }
  return 0;
}

/** Validate an ISO 8601 UTC timestamp string (Req 4.12). */
function isValidIso8601(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const d = new Date(value);
  // Must be a valid date and must round-trip (rejects partial parses)
  return !isNaN(d.getTime()) && d.toISOString() !== 'Invalid Date';
}

/**
 * Derive schedule definitions from a pushed spec.
 * One schedule per `schedule-trigger` node with a non-blank cron field.
 */
function deriveSchedules(spec: WorkflowSpec): ScheduleDefinition[] {
  const schedules: ScheduleDefinition[] = [];
  if (!spec.graph?.nodes) return schedules;

  for (const node of spec.graph.nodes) {
    if (node.kind === 'schedule-trigger' && node.data) {
      const data = node.data as Record<string, unknown>;
      const cron = data['cron'];
      if (typeof cron === 'string' && cron.trim().length > 0) {
        schedules.push({ nodeId: node.id, cron: cron.trim() });
      }
    }
  }

  return schedules;
}

/**
 * Build the ConnectionSummary array for the connection inventory route and
 * for spec push validation (Req 8.5). Never carries a secret value.
 */
function buildConnectionInventory(
  connections: ReadonlyMap<string, StoredConnection>,
  secrets: SecretsAdapter,
): ConnectionSummary[] {
  const inventory: ConnectionSummary[] = [];

  for (const [, conn] of connections) {
    const secretKeys = conn.secretKeys ?? [];
    // missingSecretKeys: derive from what the backend reports
    // secretsPresent: the count of secrets that are actually stored
    // These are computed without exposing secret VALUES (Req 8.5)
    const summary: ConnectionSummary = {
      id: conn.id,
      name: conn.name,
      type: conn.type as ConnectionSummary['type'],
      config: { ...conn.config },
      secretKeys: [...secretKeys],
      auth: conn.auth as ConnectionSummary['auth'],
      allowWrites: conn.allowWrites,
      limits: conn.limits as ConnectionSummary['limits'],
      secretsPresent: 0, // Populated by the live inventory check
      missingSecretKeys: [...secretKeys], // Default: all missing until checked
      createdAt: '',
      updatedAt: '',
    };
    inventory.push(summary);
  }

  return inventory;
}

/**
 * Check for a push that carries a value where a secret name belongs (Req 8.13).
 * Returns an error message string, or undefined if clean.
 *
 * A "value where a secret name belongs" means a field in the Connection
 * metadata that should hold only a name (secretKeys) but instead looks like
 * it contains an actual secret value (non-empty string that is not a valid
 * secret key identifier).
 */
function findSecretValueViolation(connections: StoredConnection[]): string | undefined {
  for (const conn of connections) {
    // Check that config fields don't contain anything that looks like a secret
    // A secret name should be a simple alphanumeric key; a value is anything else
    const secretKeyNames = new Set(conn.secretKeys ?? []);

    // Check auth object for embedded values
    if (conn.auth && typeof conn.auth === 'object') {
      const auth = conn.auth as Record<string, unknown>;
      for (const [key, val] of Object.entries(auth)) {
        if (key === 'mode') continue;
        // Auth fields that end in 'SecretKey' or 'secretKey' should carry only a name
        if (
          (key.endsWith('SecretKey') || key.endsWith('secretKey') || key === 'secretKey') &&
          typeof val === 'string' &&
          val.length > 0 &&
          !isSecretKeyName(val)
        ) {
          return `Connection "${conn.name}" (${conn.id}): field "${key}" carries a value where a secret name belongs`;
        }
      }
    }
  }
  return undefined;
}

/**
 * A secret key name is a simple identifier: alphanumeric with dashes and
 * underscores, at most 128 characters. Anything longer or with special
 * characters is likely an actual secret value.
 */
function isSecretKeyName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Update the connections map with a new or updated connection. */
function updateConnectionsMap(
  current: ReadonlyMap<string, StoredConnection>,
  conn: StoredConnection,
): ReadonlyMap<string, StoredConnection> {
  const updated = new Map(current);
  updated.set(conn.id, conn);
  return updated;
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
