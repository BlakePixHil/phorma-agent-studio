/**
 * Durable workflow state + fixtures for the Cloudflare Worker host
 * (design §13, Requirements 12.1-12.22, 16.10, 18.5, 18.6).
 *
 * The engine never touches storage itself: it asks `RunOptions.state` and
 * `RunOptions.fixtures` for everything. On the worker both live in ONE table in
 * the Durable Object's embedded SQLite, `workflow_state`, created beside
 * `run_journal` in `WorkflowAgent.ensureTables()`:
 *
 *   key TEXT PRIMARY KEY | value TEXT | updated_at INTEGER | expires_at INTEGER
 *
 * Two properties matter more than anything else here:
 *
 * 1. `compareAndSet` is ONE conditional SQL statement — `INSERT … WHERE NOT
 *    EXISTS` for an absent `expected`, `UPDATE … WHERE value = ?` otherwise.
 *    A Durable Object runs its SQLite single-threaded and these helpers do not
 *    await between reading and writing, so of any number of concurrent claims
 *    for the same key exactly one resolves true — with no lease, no retry loop
 *    and nothing to leak if the isolate dies mid-claim (Requirements 12.13,
 *    18.6).
 * 2. Every key is already workflow-scoped by the engine (`workflowId::key` via
 *    `scopedStateKey`), so the retention bounds below are computed per scope and
 *    one workflow can never read, scan or prune another's entries
 *    (Requirement 12.2).
 *
 * Fixtures are the `fx:` namespace of this same table (Requirement 16.10):
 * they live in neither the workflow spec nor the `runs`/`run_events` tables, so
 * `pruneRunHistory()` and the run-history limit never touch them. Their only
 * bound is the shared per-workflow state budget, plus a 30-day namespace TTL.
 */

import {
  FIXTURE_MAX_BYTES,
  STATE_LIST_DEFAULT_LIMIT,
  STATE_LIST_MAX_LIMIT,
  STATE_MAX_KEYS_PER_WORKFLOW,
  STATE_MAX_TOTAL_BYTES_PER_WORKFLOW,
  STATE_NS,
  STATE_SCOPE_SEPARATOR,
  STATE_VALUE_MAX_BYTES,
  isPrunableStateKey,
  resolveStateTtlSec,
  scopedStateKey,
  unscopeStateKey,
  utf8ByteLength,
  type FixtureStore,
  type StateEntry,
  type WorkflowStateStore,
} from '@phorma/engine';

/**
 * The Durable Object's tagged SQL executor — exactly the shape of `Agent.sql`,
 * so the agent passes its own method and a test can pass one backed by any
 * SQLite handle.
 */
export type DurableSqlExecutor = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** Row shape of the `workflow_state` table. */
interface StateRow {
  key: string;
  value: string;
  updated_at: number;
  expires_at: number | null;
}

/**
 * Creates the `workflow_state` table. Idempotent and cheap, called from
 * `WorkflowAgent.ensureTables()` beside `run_journal`.
 */
export function ensureWorkflowStateTable(sql: DurableSqlExecutor): void {
  sql`
    CREATE TABLE IF NOT EXISTS workflow_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `;
}

/**
 * Deletes every `workflow_state` row belonging to a workflow.
 *
 * Keys are workflow-scoped by the engine (`{workflowId}::{namespace}:{key}` via
 * `scopedStateKey`), so a prefix match is exact - it can never touch another
 * workflow's state. Used by the workflow DO's purge path (full teardown on
 * delete / "Remove from cloud"); the blanket `DELETE FROM workflow_state` in
 * that path covers this too, but the helper is reusable and self-documenting
 * for any caller that needs to clear one workflow's state without wiping the
 * whole table (for example, a future "reset state" action).
 */
export function clearAllForWorkflow(sql: DurableSqlExecutor, workflowId: string): void {
  const prefix = `${workflowId}${STATE_SCOPE_SEPARATOR}`;
  sql`DELETE FROM workflow_state WHERE substr(key, 1, ${prefix.length}) = ${prefix}`;
}

export interface DurableStateStoreOptions {
  /** The Durable Object's tagged SQL executor. */
  readonly sql: DurableSqlExecutor;
  /** Clock, injectable so a TTL test need not wait. Default `Date.now`. */
  readonly now?: () => number;
  /** Per-value UTF-8 byte cap for `set`/`compareAndSet`. Default 32768. */
  readonly maxValueBytes?: number;
  /** Keys per workflow before prune-oldest. Default 50000. */
  readonly maxKeysPerWorkflow?: number;
  /** Total UTF-8 value bytes per workflow before prune-oldest. Default 32 MB. */
  readonly maxTotalBytesPerWorkflow?: number;
}

/**
 * `WorkflowStateStore` over the Durable Object's `workflow_state` table.
 *
 * Every method is synchronous inside (DO SQLite is a local, synchronous API);
 * the promises exist only because the engine's contract is async.
 */
export class DurableWorkflowStateStore implements WorkflowStateStore {
  private readonly sql: DurableSqlExecutor;
  private readonly clock: () => number;
  private readonly maxValueBytes: number;
  private readonly maxKeys: number;
  private readonly maxTotalBytes: number;

  constructor(options: DurableStateStoreOptions) {
    this.sql = options.sql;
    this.clock = options.now ?? (() => Date.now());
    this.maxValueBytes = options.maxValueBytes ?? STATE_VALUE_MAX_BYTES;
    this.maxKeys = options.maxKeysPerWorkflow ?? STATE_MAX_KEYS_PER_WORKFLOW;
    this.maxTotalBytes = options.maxTotalBytesPerWorkflow ?? STATE_MAX_TOTAL_BYTES_PER_WORKFLOW;
  }

  // ── WorkflowStateStore ────────────────────────────────────────────────────

  /** Requirements 12.1, 12.18, 12.20. An expired entry reads as absent. */
  async get(key: string): Promise<StateEntry | undefined> {
    const now = this.clock();
    const row = this.sql<StateRow>`
      SELECT key, value, updated_at, expires_at
      FROM workflow_state
      WHERE key = ${key}
        AND (expires_at IS NULL OR expires_at > ${now})
      LIMIT 1
    `[0];
    return row === undefined ? undefined : toEntry(row);
  }

  /** Requirements 12.1, 12.16, 12.17, 12.18. */
  async set(key: string, value: string, options?: { ttlSec?: number }): Promise<void> {
    this.write(key, value, options?.ttlSec, this.maxValueBytes);
  }

  /** Requirement 12.22. Deleting an absent key resolves without an error. */
  async delete(key: string): Promise<void> {
    this.sql`DELETE FROM workflow_state WHERE key = ${key}`;
  }

  /** Requirements 12.18, 12.19. Prefix-bounded, clamped to 1-1000 entries. */
  async list(prefix: string, limit?: number): Promise<StateEntry[]> {
    const now = this.clock();
    const width = charLength(prefix);
    const rows = this.sql<StateRow>`
      SELECT key, value, updated_at, expires_at
      FROM workflow_state
      WHERE substr(key, 1, ${width}) = ${prefix}
        AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY key ASC
      LIMIT ${clampLimit(limit)}
    `;
    return rows.map(toEntry);
  }

  /**
   * Requirements 12.13, 12.21, 18.6.
   *
   * One conditional statement decides and writes: `INSERT … WHERE NOT EXISTS`
   * when `expected` is absent, `UPDATE … WHERE value = ?` otherwise. Nothing
   * awaits between the decision and the write, so concurrent claims for one key
   * serialise inside the Durable Object and exactly one resolves true.
   */
  async compareAndSet(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean> {
    // Size and retention are settled BEFORE the conditional write, so a
    // rejected write leaves the stored value untouched (Requirement 12.16).
    const bytes = this.assertValueFits(key, value, this.maxValueBytes);
    this.dropExpired();
    this.makeRoom(key, bytes);

    const now = this.clock();
    const expiresAt = this.expiryFor(key, options?.ttlSec, now);

    const written =
      expected === undefined
        ? this.sql<{ key: string }>`
            INSERT OR REPLACE INTO workflow_state (key, value, updated_at, expires_at)
            SELECT ${key}, ${value}, ${now}, ${expiresAt}
            WHERE NOT EXISTS (
              SELECT 1 FROM workflow_state
              WHERE key = ${key}
                AND (expires_at IS NULL OR expires_at > ${now})
            )
            RETURNING key
          `
        : this.sql<{ key: string }>`
            UPDATE workflow_state
            SET value = ${value}, updated_at = ${now}, expires_at = ${expiresAt}
            WHERE key = ${key}
              AND value = ${expected}
              AND (expires_at IS NULL OR expires_at > ${now})
            RETURNING key
          `;

    return written.length > 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Writes a value, enforcing `maxBytes` and the per-workflow retention bounds.
   * `maxBytes` is the state cap for `set`/`compareAndSet` and the (much larger)
   * fixture cap for a recorded response.
   */
  write(key: string, value: string, ttlSec: number | undefined, maxBytes: number): void {
    const bytes = this.assertValueFits(key, value, maxBytes);
    this.dropExpired();
    this.makeRoom(key, bytes);

    const now = this.clock();
    this.sql`
      INSERT OR REPLACE INTO workflow_state (key, value, updated_at, expires_at)
      VALUES (${key}, ${value}, ${now}, ${this.expiryFor(key, ttlSec, now)})
    `;
  }

  /** Requirement 12.16: reject an oversized value, changing nothing. */
  private assertValueFits(key: string, value: string, maxBytes: number): number {
    const bytes = utf8ByteLength(value);
    if (bytes > maxBytes) {
      throw new Error(
        `State value for "${key}" is ${bytes} bytes, above the ${maxBytes}-byte per-value size limit.`,
      );
    }
    return bytes;
  }

  /** Requirement 12.18: namespace default TTL unless an explicit one applies. */
  private expiryFor(key: string, ttlSec: number | undefined, now: number): number | null {
    const ttl = resolveStateTtlSec(key, ttlSec);
    return ttl === undefined ? null : now + ttl * 1000;
  }

  private dropExpired(): void {
    this.sql`
      DELETE FROM workflow_state
      WHERE expires_at IS NOT NULL AND expires_at <= ${this.clock()}
    `;
  }

  /**
   * Requirement 12.17: prune entries in ascending `updated_at` order — never a
   * `wm:` or `oauth:` entry, never the key being written — until the pending
   * write fits both per-workflow bounds. Rejects with the breached bound only
   * when nothing prunable remains.
   */
  private makeRoom(key: string, incomingBytes: number): void {
    const scope = workflowScopePrefix(key);
    const width = charLength(scope);

    for (;;) {
      const totals = this.sql<{ keys: number; bytes: number }>`
        SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes
        FROM workflow_state
        WHERE substr(key, 1, ${width}) = ${scope}
          AND key <> ${key}
      `[0];
      const keys = Number(totals?.keys ?? 0);
      const bytes = Number(totals?.bytes ?? 0);
      if (keys + 1 <= this.maxKeys && bytes + incomingBytes <= this.maxTotalBytes) return;

      // `wm:` and `oauth:` are excluded in SQL (so the oldest PRUNABLE entry is
      // found however many watermarks sit in front of it) and re-checked in TS.
      const victim = this.sql<{ key: string }>`
        SELECT key FROM workflow_state
        WHERE substr(key, 1, ${width}) = ${scope}
          AND key <> ${key}
          AND substr(key, ${width + 1}, ${charLength(STATE_NS.watermark)}) <> ${STATE_NS.watermark}
          AND substr(key, ${width + 1}, ${charLength(STATE_NS.oauth)}) <> ${STATE_NS.oauth}
        ORDER BY updated_at ASC, key ASC
        LIMIT 1
      `.find((row) => isPrunableStateKey(row.key));

      if (victim === undefined) {
        throw new Error(
          `Workflow state for "${scope.slice(0, -STATE_SCOPE_SEPARATOR.length)}" is at its retention bound ` +
            `(${this.maxKeys} keys / ${this.maxTotalBytes} bytes) and no further entry can be pruned.`,
        );
      }
      this.sql`DELETE FROM workflow_state WHERE key = ${victim.key}`;
    }
  }
}

/**
 * `FixtureStore` over the `fx:` namespace of the same table (Requirement 16.10).
 *
 * A fixture is a recorded HTTP or SQL response, so it is allowed to be far
 * larger than a state value: the cap here is the engine's
 * {@link FIXTURE_MAX_BYTES}, and a rejected write surfaces to the engine as a
 * warning rather than a failed node (Requirement 16.12).
 */
export class DurableFixtureStore implements FixtureStore {
  constructor(
    private readonly state: DurableWorkflowStateStore,
    /** Scope applied to a key that arrives without one. */
    private readonly workflowId = '',
  ) {}

  async read(key: string): Promise<string | undefined> {
    return (await this.state.get(this.fixtureKey(key)))?.value;
  }

  async write(key: string, value: string): Promise<void> {
    // TTL stays the `fx:` namespace default (30 days) — fixtures are exempt
    // from the run-history retention limits, which only reach the `runs` and
    // `run_events` tables.
    this.state.write(this.fixtureKey(key), value, undefined, FIXTURE_MAX_BYTES);
  }

  /**
   * The engine already hands us `workflowId::fx:…`. This normalisation is
   * defence in depth: a key arriving without a scope or without the namespace
   * still lands under `fx:` inside its workflow's scope, never anywhere else.
   */
  private fixtureKey(key: string): string {
    const separator = key.indexOf(STATE_SCOPE_SEPARATOR);
    const scope = separator < 0 ? this.workflowId : key.slice(0, separator);
    const bare = unscopeStateKey(key);
    return scopedStateKey(
      scope,
      bare.startsWith(STATE_NS.fixture) ? bare : `${STATE_NS.fixture}${bare}`,
    );
  }
}

function toEntry(row: StateRow): StateEntry {
  const updatedAt = Number(row.updated_at);
  return row.expires_at === null || row.expires_at === undefined
    ? { key: row.key, value: row.value, updatedAt }
    : { key: row.key, value: row.value, updatedAt, expiresAt: Number(row.expires_at) };
}

/** Requirement 12.19: absent limit = 1000, above 1000 clamps, below 1 clamps. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STATE_LIST_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, STATE_LIST_MAX_LIMIT);
}

/**
 * `workflowId::` for a scoped key, `::` for an unscoped one — the retention
 * bounds of Requirement 12.17 are per workflow, so pruning only ever considers
 * keys sharing this prefix. Every key the engine supplies is scoped
 * (`scopedStateKey`, with an absent `workflowId` scoping to `::`).
 */
function workflowScopePrefix(key: string): string {
  const separator = key.indexOf(STATE_SCOPE_SEPARATOR);
  const scope = separator < 0 ? '' : key.slice(0, separator);
  return `${scope}${STATE_SCOPE_SEPARATOR}`;
}

/**
 * Character count, matching SQLite's `substr` on TEXT (which counts characters,
 * not UTF-16 code units) so a prefix comparison agrees with `startsWith`.
 */
function charLength(value: string): number {
  return Array.from(value).length;
}
