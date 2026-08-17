/**
 * FakeSchedulerBackend - in-memory EventBridge Scheduler backend for testing.
 *
 * Mirrors the FakeRunTable and FakeSecretsManager pattern: a simple in-memory
 * store with per-request failure injection and an inspectable request log.
 *
 * Feature: aws-deployment-target
 * Requirements: 6.1, 6.2, 6.5, 6.9, 6.10
 */

import type { SchedulerBackend, ScheduleEntry, ScheduleTarget } from '../aws/scheduler.js';

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

export interface SchedulerRequestLogEntry {
  operation: 'create' | 'delete' | 'list';
  name?: string;
  groupName?: string;
  /** The scope a `list` was made with, so a test can assert it was scoped. */
  namePrefix?: string;
}

// ---------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------

/**
 * A callback invoked before each operation. If it throws, the operation is
 * aborted and the error propagates to the caller.
 */
export type SchedulerFailureInjector = (
  operation: 'create' | 'delete' | 'list',
  name?: string,
) => void;

// ---------------------------------------------------------------------------
// FakeSchedulerBackend
// ---------------------------------------------------------------------------

export class FakeSchedulerBackend implements SchedulerBackend {
  /** In-memory store: scheduleName -> ScheduleEntry. */
  private readonly store = new Map<string, ScheduleEntry>();

  /** Recorded request log for assertions. */
  readonly log: SchedulerRequestLogEntry[] = [];

  /** Per-request failure injector. */
  private injector: SchedulerFailureInjector | undefined;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Set the failure injector. Pass undefined to clear. */
  setFailureInjector(injector: SchedulerFailureInjector | undefined): void {
    this.injector = injector;
  }

  /** Reset the store and logs. */
  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.injector = undefined;
  }

  /** Seed a schedule directly (bypasses logging and injection). */
  seed(name: string, entry: ScheduleEntry): void {
    this.store.set(name, entry);
  }

  /** Check if a schedule exists (for assertions). */
  has(name: string): boolean {
    return this.store.has(name);
  }

  /** Get a schedule entry directly (for assertions). */
  peek(name: string): ScheduleEntry | undefined {
    return this.store.get(name);
  }

  /** Number of entries in the store (for assertions). */
  get size(): number {
    return this.store.size;
  }

  /** All schedule names currently in the store. */
  get names(): string[] {
    return Array.from(this.store.keys());
  }

  // -------------------------------------------------------------------------
  // SchedulerBackend implementation
  // -------------------------------------------------------------------------

  async createSchedule(
    groupName: string,
    name: string,
    cron: string,
    timezone: string,
    target: ScheduleTarget,
  ): Promise<void> {
    this.log.push({ operation: 'create', name, groupName });
    if (this.injector) this.injector('create', name);
    this.store.set(name, { name, groupName, cron, timezone, target });
  }

  async deleteSchedule(groupName: string, name: string): Promise<void> {
    this.log.push({ operation: 'delete', name, groupName });
    if (this.injector) this.injector('delete', name);
    this.store.delete(name);
  }

  /**
   * List the group's schedules whose name starts with `namePrefix`.
   *
   * The prefix is honoured rather than ignored on purpose. A fake that returned
   * the whole group would accept the cross-workflow deletion bug this parameter
   * exists to prevent, which is how that bug survived a green suite once
   * already.
   */
  async listSchedules(groupName: string, namePrefix: string): Promise<ScheduleEntry[]> {
    this.log.push({ operation: 'list', groupName, namePrefix });
    if (this.injector) this.injector('list', undefined);
    return Array.from(this.store.values()).filter(
      e => e.groupName === groupName && e.name.startsWith(namePrefix),
    );
  }
}

// Re-export the target type for convenience
export type { ScheduleTarget };
