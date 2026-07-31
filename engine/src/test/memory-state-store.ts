/**
 * In-memory `WorkflowStateStore` for the engine test suites (design §8).
 *
 * It implements the whole host contract — not a stub — so the state properties and
 * the integration suites exercise the same semantics the desktop (IndexedDB) and
 * worker (DO SQLite) stores must provide:
 *
 * - TTL expiry: an entry at or past `expiresAt` reads as absent for `get`, `list`
 *   and the `expected` side of `compareAndSet`, with the namespace defaults from
 *   `state.ts` applied when no explicit `ttlSec` is given.
 * - `list` clamped to 1000 entries (default and maximum), prefix-bounded.
 * - The 32 KB per-value cap, rejected with a descriptive error and no write.
 * - Prune-oldest retention on the key and total-byte bounds, skipping `wm:` and
 *   `oauth:`.
 * - Atomic `compareAndSet`: every operation runs in a serialised critical section,
 *   so of any number of concurrent claims for one key exactly one resolves true.
 *
 * Bounds are constructor-injectable so a retention test does not have to write
 * 50 000 keys, and the clock is injectable so a TTL test does not have to wait.
 */

import type { StateEntry, WorkflowStateStore } from '../data-host.js';
import {
  STATE_LIST_DEFAULT_LIMIT,
  STATE_LIST_MAX_LIMIT,
  STATE_MAX_KEYS_PER_WORKFLOW,
  STATE_MAX_TOTAL_BYTES_PER_WORKFLOW,
  STATE_SCOPE_SEPARATOR,
  STATE_VALUE_MAX_BYTES,
  isPrunableStateKey,
  resolveStateTtlSec,
  utf8ByteLength,
} from '../state.js';

export interface MemoryStateStoreOptions {
  /** Clock, injectable so TTL tests need not wait. Default `Date.now`. */
  readonly now?: () => number;
  /** Per-value UTF-8 byte cap. Default 32768. */
  readonly maxValueBytes?: number;
  /** Keys per workflow before prune-oldest. Default 50000. */
  readonly maxKeysPerWorkflow?: number;
  /** Total UTF-8 value bytes per workflow before prune-oldest. Default 32 MB. */
  readonly maxTotalBytesPerWorkflow?: number;
}

interface StoredRecord extends StateEntry {
  /** Insertion sequence, breaking `updatedAt` ties during prune-oldest. */
  seq: number;
  bytes: number;
}

export class MemoryStateStore implements WorkflowStateStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly clock: () => number;
  private readonly maxValueBytes: number;
  private readonly maxKeys: number;
  private readonly maxTotalBytes: number;
  private seq = 0;
  /** Serialises every operation, modelling the hosts' atomic transactions. */
  private tail: Promise<unknown> = Promise.resolve();

  /** Number of `compareAndSet` calls that resolved true. Handy in tests. */
  writes = 0;

  constructor(options: MemoryStateStoreOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.maxValueBytes = options.maxValueBytes ?? STATE_VALUE_MAX_BYTES;
    this.maxKeys = options.maxKeysPerWorkflow ?? STATE_MAX_KEYS_PER_WORKFLOW;
    this.maxTotalBytes = options.maxTotalBytesPerWorkflow ?? STATE_MAX_TOTAL_BYTES_PER_WORKFLOW;
  }

  // ── WorkflowStateStore ────────────────────────────────────────────────────

  get(key: string): Promise<StateEntry | undefined> {
    return this.serialise(() => {
      const record = this.live(key);
      return record === undefined ? undefined : toEntry(record);
    });
  }

  set(key: string, value: string, options?: { ttlSec?: number }): Promise<void> {
    return this.serialise(() => {
      this.write(key, value, options?.ttlSec);
    });
  }

  delete(key: string): Promise<void> {
    return this.serialise(() => {
      this.records.delete(key);
    });
  }

  list(prefix: string, limit?: number): Promise<StateEntry[]> {
    return this.serialise(() => {
      const clamped = clampLimit(limit);
      const now = this.clock();
      const matches: StoredRecord[] = [];
      for (const record of this.records.values()) {
        if (!record.key.startsWith(prefix)) continue;
        if (isExpired(record, now)) continue;
        matches.push(record);
      }
      // Deterministic order so a clamped page is reproducible.
      matches.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return matches.slice(0, clamped).map(toEntry);
    });
  }

  compareAndSet(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean> {
    return this.serialise(() => {
      const current = this.live(key);
      if (expected === undefined) {
        if (current !== undefined) return false;
      } else if (current === undefined || current.value !== expected) {
        return false;
      }
      this.write(key, value, options?.ttlSec);
      this.writes++;
      return true;
    });
  }

  // ── Test affordances ──────────────────────────────────────────────────────

  /** Live entry count across every workflow, expired entries excluded. */
  get size(): number {
    const now = this.clock();
    let count = 0;
    for (const record of this.records.values()) {
      if (!isExpired(record, now)) count++;
    }
    return count;
  }

  /** Live keys in insertion order, expired entries excluded. */
  liveKeys(): string[] {
    const now = this.clock();
    return [...this.records.values()].filter((r) => !isExpired(r, now)).map((r) => r.key);
  }

  clear(): void {
    this.records.clear();
    this.writes = 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Runs `body` after every previously queued operation, so an interleaved set of
   * `compareAndSet` calls behaves exactly like the hosts' single transaction.
   */
  private serialise<T>(body: () => T): Promise<T> {
    const result = this.tail.then(body, body);
    // Keep the chain alive after a rejection so one rejected write does not
    // poison every later operation.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The stored record for `key`, dropping it when expired. */
  private live(key: string): StoredRecord | undefined {
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    if (isExpired(record, this.clock())) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  private write(key: string, value: string, ttlSec: number | undefined): void {
    const bytes = utf8ByteLength(value);
    if (bytes > this.maxValueBytes) {
      throw new Error(
        `State value for "${key}" is ${bytes} bytes, above the ${this.maxValueBytes}-byte per-value size limit.`,
      );
    }
    this.dropExpired();
    this.makeRoom(key, bytes);

    const ttl = resolveStateTtlSec(key, ttlSec);
    const now = this.clock();
    this.records.delete(key);
    this.records.set(key, {
      key,
      value,
      updatedAt: now,
      expiresAt: ttl === undefined ? undefined : now + ttl * 1000,
      seq: this.seq++,
      bytes,
    });
  }

  private dropExpired(): void {
    const now = this.clock();
    for (const [key, record] of [...this.records]) {
      if (isExpired(record, now)) this.records.delete(key);
    }
  }

  /**
   * Prunes entries in ascending `updatedAt` order, excluding `wm:` and `oauth:`
   * and the key being written, until the pending write fits both workflow bounds.
   * Rejects with the breached bound when nothing prunable remains.
   */
  private makeRoom(key: string, incomingBytes: number): void {
    const workflowId = workflowScopeOf(key);
    const fits = (): boolean => {
      let keys = 0;
      let bytes = 0;
      for (const record of this.records.values()) {
        if (workflowScopeOf(record.key) !== workflowId) continue;
        if (record.key === key) continue;
        keys++;
        bytes += record.bytes;
      }
      return keys + 1 <= this.maxKeys && bytes + incomingBytes <= this.maxTotalBytes;
    };

    while (!fits()) {
      const victim = this.oldestPrunable(workflowId, key);
      if (victim === undefined) {
        throw new Error(
          `Workflow state for "${workflowId}" is at its retention bound (${this.maxKeys} keys / ${this.maxTotalBytes} bytes) and no further entry can be pruned.`,
        );
      }
      this.records.delete(victim.key);
    }
  }

  private oldestPrunable(workflowId: string, exclude: string): StoredRecord | undefined {
    let oldest: StoredRecord | undefined;
    for (const record of this.records.values()) {
      if (record.key === exclude) continue;
      if (workflowScopeOf(record.key) !== workflowId) continue;
      if (!isPrunableStateKey(record.key)) continue;
      if (
        oldest === undefined ||
        record.updatedAt < oldest.updatedAt ||
        (record.updatedAt === oldest.updatedAt && record.seq < oldest.seq)
      ) {
        oldest = record;
      }
    }
    return oldest;
  }
}

function toEntry(record: StoredRecord): StateEntry {
  return record.expiresAt === undefined
    ? { key: record.key, value: record.value, updatedAt: record.updatedAt }
    : {
        key: record.key,
        value: record.value,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
      };
}

function isExpired(record: StoredRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STATE_LIST_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, STATE_LIST_MAX_LIMIT);
}

/** The workflow scope a key belongs to (the part before `::`), or `''`. */
function workflowScopeOf(key: string): string {
  const at = key.indexOf(STATE_SCOPE_SEPARATOR);
  return at < 0 ? '' : key.slice(0, at);
}
