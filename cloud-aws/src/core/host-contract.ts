/**
 * Runtime_Host_Contract: the named set of capabilities a Host must provide for
 * a deployed run on AWS_Host (Req 1.1).
 *
 * Exactly 10 capabilities, one interface each, no eleventh member. The four
 * engine-owned types are re-exported, not redeclared, so drift is impossible.
 *
 * This module is pure declaration. No I/O, no AWS SDK import.
 */

import type {
  ConnectionStore,
  JournalEntry,
  RunEvent,
  RunJournal,
  RunRecord,
  RunRecordSummary,
  UsageLedgerEntry,
  WorkflowSpec,
  WorkflowStateStore,
} from '@phorma/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export the four engine-owned types so consumers import from here
// ─────────────────────────────────────────────────────────────────────────────

export type { RunJournal, WorkflowStateStore, ConnectionStore, JournalEntry };

// ─────────────────────────────────────────────────────────────────────────────
// Capability names - exactly 10, frozen (Req 1.1)
// ─────────────────────────────────────────────────────────────────────────────

export const RUNTIME_HOST_CAPABILITIES = Object.freeze([
  'spec',
  'journal',
  'runHistory',
  'runEvents',
  'usageLedger',
  'workflowState',
  'connections',
  'schedules',
  'monitor',
  'lease',
] as const);

export type RuntimeHostCapability = (typeof RUNTIME_HOST_CAPABILITIES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Supporting types
// ─────────────────────────────────────────────────────────────────────────────

/** A workflow spec as persisted in Run_Table. */
export interface StoredSpec {
  spec: WorkflowSpec;
  savedAt: string;
}

/** The result of a lease acquisition attempt. */
export type LeaseOutcome =
  | { granted: true; lease: HeldLease }
  | { granted: false; holdingFence: number };

/** A lease currently held by this Runner. */
export interface HeldLease {
  workflowId: string;
  runnerId: string;
  fence: number;
  expiresAtMs: number;
}

/** A paginated response carrying items and an optional continuation token. */
export interface PaginatedResult<T> {
  items: T[];
  continuationToken?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Spec storage
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecStore {
  read(workflowId: string): Promise<StoredSpec | undefined>;
  write(workflowId: string, spec: StoredSpec): Promise<void>;
  delete(workflowId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Journal (wraps engine RunJournal for async preload)
// ─────────────────────────────────────────────────────────────────────────────

export interface JournalStore {
  /** Every entry for one run, paginated, for at least 1000 entries (Req 3.3). */
  preload(workflowId: string, runId: string): Promise<Map<string, JournalEntry>>;
  /** Durably record one entry. Resolves only after Run_Table acknowledges. */
  record(workflowId: string, runId: string, key: string, entry: JournalEntry): Promise<void>;
  /** Delete every journal entry for a settled run. */
  deleteRun(workflowId: string, runId: string): Promise<void>;
  /** Delete journal entries for all runs except the one being kept (non-resume cleanup). */
  deleteOtherRuns(workflowId: string, keepRunId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Run history
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHistoryStore {
  /** Write or update a run record (in-flight then settled in place). */
  upsert(workflowId: string, record: RunRecord): Promise<void>;
  /** List summaries descending by start time, 100 per page. */
  list(
    workflowId: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<RunRecordSummary>>;
  /** Full record for one run. */
  get(workflowId: string, runId: string): Promise<RunRecord | undefined>;
  /** Delete all run records for a workflow (purge path). */
  deleteAll(workflowId: string): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Run events
// ─────────────────────────────────────────────────────────────────────────────

export interface RunEventStore {
  /** Persist one sequenced, redacted, possibly-truncated event. */
  write(workflowId: string, runId: string, seq: number, event: RunEvent): Promise<void>;
  /** Read events in emission order, 1000 per page. */
  list(
    workflowId: string,
    runId: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<RunEvent>>;
  /** Delete all events for a workflow (purge path). */
  deleteAll(workflowId: string): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Usage ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageLedgerStore {
  /** Upsert one entry keyed by (workflow, run, node) so resume replaces. */
  write(workflowId: string, entry: UsageLedgerEntry): Promise<void>;
  /** Entries at or after `since`, ascending, 1000 per page. */
  list(
    workflowId: string,
    since: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<UsageLedgerEntry>>;
  /** Delete all usage entries for a workflow (purge path). */
  deleteAll(workflowId: string): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Workflow state - re-exported from engine (WorkflowStateStore)
// ─────────────────────────────────────────────────────────────────────────────

// WorkflowStateStore is re-exported above. No new interface needed.

// ─────────────────────────────────────────────────────────────────────────────
// 7. Connections - re-exported from engine (ConnectionStore)
// ─────────────────────────────────────────────────────────────────────────────

// ConnectionStore is re-exported above. No new interface needed.

// ─────────────────────────────────────────────────────────────────────────────
// 8. Scheduled runs
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleStore {
  /** Replace the entire schedule set for a workflow from its spec. */
  sync(workflowId: string, schedules: ScheduleDefinition[]): Promise<void>;
  /** Remove all schedules for a workflow. */
  deleteAll(workflowId: string): Promise<void>;
  /**
   * Decide whether a fired schedule should start a run.
   *
   * Resolves `true` when the workflow's spec is still present. Resolves `false`
   * when it is not, having first deleted the now-orphaned schedule and published
   * the skipped-scheduled-run metric, so a purged workflow stops firing instead
   * of failing on every tick.
   *
   * On the interface rather than only on the adapter because the trigger route is
   * its caller. Before the Schedule_Shim existed, nothing invoked it at all,
   * which is why the failed-scheduled-run alarm could never fire.
   */
  handleScheduleFire(workflowId: string, nodeId: string): Promise<boolean>;
}

/** One schedule derived from a `schedule-trigger` node. */
export interface ScheduleDefinition {
  nodeId: string;
  cron: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Live monitor
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorGateway {
  /** Push one RunEvent to every authenticated connection for this workflow. */
  push(workflowId: string, event: RunEvent): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Execution lease
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaseStore {
  /** Attempt to acquire the exclusive lease for a workflow. */
  acquire(workflowId: string, runnerId: string, nowMs: number): Promise<LeaseOutcome>;
  /** Extend the lease expiry. Returns false when the fence no longer matches. */
  heartbeat(lease: HeldLease, nowMs: number): Promise<boolean>;
  /** Release the lease on run settle. Returns false on fence mismatch. */
  release(lease: HeldLease, nowMs: number): Promise<boolean>;
}
