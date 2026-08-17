/**
 * ScheduleStore: EventBridge Scheduler adapter for AWS_Host.
 *
 * Implements the `ScheduleStore` interface from host-contract.ts over the
 * IaC-owned schedule group. One schedule per `schedule-trigger` node whose
 * `cron` is non-blank, capped at 50.
 *
 * Validation happens before any mutation. Deletions are confirmed before the
 * first create. On a failed create, every schedule created during that push
 * is rolled back.
 *
 * When a schedule fires for a workflow whose spec is absent, the schedule is
 * deleted and the skipped-scheduled-run metric is published.
 *
 * Feature: aws-deployment-target
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11
 */

import type { ScheduleStore, ScheduleDefinition } from '../core/host-contract.js';
import { scheduleName, schedulePrefix } from '../core/schedule-name.js';
import { isBlankCron, translateCron, type CronTranslator } from '../core/cron.js';
import { RETRY_BUDGETS } from '../core/retry.js';
import type { SchedulerBackend } from './ports.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of schedules per workflow (Req 6.1). */
const MAX_SCHEDULES_PER_WORKFLOW = 50;

/** Time zone for all schedules (Req 6.1). */
const SCHEDULE_TIMEZONE = 'UTC';

/** Maximum attempts for a single Scheduler API call (Req 6.10). */
const MAX_ATTEMPTS = 3;

/** Maximum total time for retries during a push (Req 6.10: 30 seconds). */
const MAX_PUSH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Backend port shapes
// ---------------------------------------------------------------------------

/**
 * The target configuration for a schedule - what it invokes when it fires.
 */
export interface ScheduleTarget {
  arn: string;
  roleArn: string;
  input?: string;
}

/**
 * A schedule entry as stored in the backend.
 */
export interface ScheduleEntry {
  name: string;
  groupName: string;
  cron: string;
  timezone: string;
  target: ScheduleTarget;
}

/**
 * `SchedulerBackend` is declared once, in `./ports.js`. It is re-exported here
 * so existing importers keep resolving, while the port has a single
 * declaration site (Req 8.2).
 */
export type { SchedulerBackend };

// ---------------------------------------------------------------------------
// Telemetry interface (subset of TelemetryAdapter)
// ---------------------------------------------------------------------------

/**
 * A minimal telemetry interface for the scheduler, accepting the
 * skipped-scheduled-run metric publication.
 */
export interface SchedulerTelemetry {
  publishSkippedScheduledRun(scheduleName?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Spec presence checker
// ---------------------------------------------------------------------------

/**
 * A function that checks whether a workflow spec exists in Run_Table.
 * Used when a schedule fires to determine if the spec is still present.
 */
export type SpecPresenceChecker = (workflowId: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The backoff wait between retry attempts, injectable so a test can drive the
 * retry and rollback paths without paying their wall-clock backoff. The retry
 * counts and the timeout budget are unaffected: only the sleep is replaceable.
 */
export type Sleep = (ms: number) => Promise<void>;

export interface SchedulerConfig {
  /** The IaC-owned schedule group name. */
  groupName: string;
  /** The schedule target: the Schedule_Shim function ARN and the invoke role. */
  target: ScheduleTarget;
  /**
   * Translates a workflow cron into the AWS six-field dialect, or explains why
   * it cannot be. Defaults to `core/cron.ts translateCron`.
   *
   * A seam rather than a boolean validator: validation and translation are the
   * same pass, because deciding whether `0 12 * * *` is acceptable means
   * knowing what it becomes. The previous boolean seam let the adapter accept an
   * expression it then handed to AWS unchanged and unaccepted.
   */
  translateCron?: CronTranslator;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when schedule validation fails before any mutation is attempted.
 */
export class ScheduleValidationError extends Error {
  readonly workflowId: string;
  readonly nodeId?: string;

  constructor(workflowId: string, message: string, nodeId?: string) {
    super(message);
    this.name = 'ScheduleValidationError';
    this.workflowId = workflowId;
    this.nodeId = nodeId;
  }
}

/**
 * Thrown when a schedule push fails after partial creation (rollback occurred).
 */
export class SchedulePushError extends Error {
  readonly workflowId: string;
  readonly nodeId: string;

  constructor(workflowId: string, nodeId: string, message: string) {
    super(message);
    this.name = 'SchedulePushError';
    this.workflowId = workflowId;
    this.nodeId = nodeId;
  }
}

// ---------------------------------------------------------------------------
// SchedulerAdapter
// ---------------------------------------------------------------------------

/**
 * Implements `ScheduleStore` over the `SchedulerBackend` port declared in
 * `./ports.js`. The production implementation is `./scheduler-backend.js` over
 * EventBridge Scheduler; the property tests supply an in-memory implementation
 * of the same port, so nothing in this module names a test fixture (Req 8.2).
 */
export class SchedulerAdapter implements ScheduleStore {
  private readonly backend: SchedulerBackend;
  private readonly config: SchedulerConfig;
  private readonly telemetry: SchedulerTelemetry;
  private readonly specPresent: SpecPresenceChecker;
  private readonly sleep: Sleep;

  constructor(
    backend: SchedulerBackend,
    config: SchedulerConfig,
    telemetry: SchedulerTelemetry,
    specPresent: SpecPresenceChecker,
    sleep: Sleep = delay,
  ) {
    this.backend = backend;
    this.config = config;
    this.telemetry = telemetry;
    this.specPresent = specPresent;
    this.sleep = sleep;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ScheduleStore.sync (Req 6.1, 6.2, 6.5, 6.6, 6.9, 6.10)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Replace the entire schedule set for a workflow from its spec.
   *
   * 1. Validate: skip blank cron, reject invalid cron, reject >50 non-blank
   * 2. Delete all existing schedules (Req 6.2: all confirmed before first create)
   * 3. Create new schedules (Req 6.10: rollback on failure)
   */
  async sync(workflowId: string, schedules: ScheduleDefinition[]): Promise<void> {
    // ── Step 1: validate and translate ────────────────────────────────────
    // Translation happens in this pass, not at create time, so a spec carrying
    // one untranslatable cron is refused before any mutation rather than part
    // way through the create loop.
    const translate = this.config.translateCron ?? translateCron;
    const planned: { nodeId: string; expression: string }[] = [];

    for (const def of schedules) {
      if (isBlankCron(def.cron)) continue; // Skip blank cron (not an error)

      const translated = translate(def.cron);
      if (!translated.ok) {
        throw new ScheduleValidationError(
          workflowId,
          `Workflow "${workflowId}": schedule-trigger node "${def.nodeId}" has an ` +
            `unusable cron expression "${def.cron}". ${translated.reason}`,
          def.nodeId,
        );
      }

      planned.push({ nodeId: def.nodeId, expression: translated.expression });
    }

    // Cap at 50 (Req 6.1, 6.9)
    if (planned.length > MAX_SCHEDULES_PER_WORKFLOW) {
      throw new ScheduleValidationError(
        workflowId,
        `Workflow "${workflowId}": spec carries ${planned.length} schedule-trigger nodes with non-empty cron (maximum is ${MAX_SCHEDULES_PER_WORKFLOW}).`,
        planned[0]?.nodeId,
      );
    }

    // ── Step 2: delete this workflow's existing schedules (Req 6.2) ──────
    await this.deleteAllForWorkflow(workflowId);

    // ── Step 3: create new schedules (Req 6.1, 6.5, 6.6, 6.10) ──────────
    const created: string[] = [];
    const pushStartMs = Date.now();

    for (const def of planned) {
      const name = scheduleName(workflowId, def.nodeId);
      const targetWithInput: ScheduleTarget = {
        ...this.config.target,
        // What the Schedule_Shim receives. It carries no `runId`: the shim mints
        // a fresh one per fire, because a run id baked in here would be reused
        // by every invocation of this schedule for as long as it exists.
        input: JSON.stringify({ workflowId, nodeId: def.nodeId, source: 'schedule' }),
      };

      try {
        await this.createWithRetry(name, def.expression, targetWithInput, pushStartMs);
        created.push(name);
      } catch (err) {
        // Rollback: delete every schedule created during this push (Req 6.10)
        await this.rollback(created);
        throw new SchedulePushError(
          workflowId,
          def.nodeId,
          `Workflow "${workflowId}": failed to create schedule for node "${def.nodeId}" after ${MAX_ATTEMPTS} attempts. All schedules rolled back.`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ScheduleStore.deleteAll
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Remove all schedules for a workflow. Confirms every deletion.
   */
  async deleteAll(workflowId: string): Promise<void> {
    await this.deleteAllForWorkflow(workflowId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Orphan schedule handling (Req 6.11)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called when a schedule fires. If the workflow's spec is absent, delete the
   * schedule and publish the skipped-scheduled-run metric.
   *
   * Returns true if the spec was present (run should proceed), false if absent
   * (schedule was deleted, no run).
   */
  async handleScheduleFire(workflowId: string, nodeId: string): Promise<boolean> {
    const present = await this.specPresent(workflowId);
    if (present) return true;

    // Spec is absent - delete the orphan schedule and publish metric (Req 6.11)
    const name = scheduleName(workflowId, nodeId);
    try {
      await this.backend.deleteSchedule(this.config.groupName, name);
    } catch {
      // Best effort - schedule may already be gone
    }
    await this.telemetry.publishSkippedScheduledRun(name);
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: delete all existing schedules for a workflow
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List and delete every schedule belonging to ONE workflow, confirming each
   * deletion before returning (Req 6.2).
   *
   * The list is scoped by `schedulePrefix(workflowId)`. The IaC_App creates one
   * schedule group per DEPLOYMENT, so the group holds every workflow's
   * schedules; an unscoped list here previously meant a spec push for workflow B
   * deleted workflow A's schedules, with no way to notice and no way to restore
   * them (the rollback path only undoes creates from the failing push).
   */
  private async deleteAllForWorkflow(workflowId: string): Promise<void> {
    const existing = await this.backend.listSchedules(
      this.config.groupName,
      schedulePrefix(workflowId),
    );

    for (const entry of existing) {
      await this.deleteWithRetry(entry.name);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: retried operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a schedule with up to MAX_ATTEMPTS retries, respecting the 30s
   * timeout (Req 6.10).
   */
  private async createWithRetry(
    name: string,
    cron: string,
    target: ScheduleTarget,
    pushStartMs: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Check overall push timeout
      if (Date.now() - pushStartMs > MAX_PUSH_TIMEOUT_MS) {
        throw new Error(`Push timeout exceeded (${MAX_PUSH_TIMEOUT_MS}ms)`);
      }

      try {
        await this.backend.createSchedule(
          this.config.groupName,
          name,
          cron,
          SCHEDULE_TIMEZONE,
          target,
        );
        return; // Success
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          throw err; // Propagate on final attempt
        }
        // Brief delay before retry
        await this.sleep(Math.min(100 * Math.pow(2, attempt - 1), 2000));
      }
    }
  }

  /**
   * Delete a schedule with up to MAX_ATTEMPTS retries.
   */
  private async deleteWithRetry(name: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.backend.deleteSchedule(this.config.groupName, name);
        return; // Success
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          throw err; // Propagate on final attempt
        }
        await this.sleep(Math.min(100 * Math.pow(2, attempt - 1), 2000));
      }
    }
  }

  /**
   * Rollback: delete every schedule that was created during a failed push
   * (Req 6.10). Best-effort - swallows errors during rollback.
   */
  private async rollback(created: string[]): Promise<void> {
    for (const name of created) {
      try {
        await this.backend.deleteSchedule(this.config.groupName, name);
      } catch {
        // Best effort during rollback - swallow errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The real backoff wait, and the default for the injectable `Sleep` seam. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
