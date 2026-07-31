import { Injectable } from '@angular/core';

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
  type Connection,
  type EvalRunSummary,
  type EvalSuite,
  type RunRecord,
  type StateEntry,
  type UsageLedgerEntry,
} from '@phorma/engine';

import type { ChatThread } from './assistant-chat.model';
import type { PromptEntry } from './prompt-library.model';
import type { SkillDef } from './skills.model';
import type { WorkflowSpec } from './workflow.model';
import { WORKFLOW_VERSIONS_KEEP, type WorkflowVersion } from './workflow-versions.model';

const DB_NAME = 'phorma-agent-studio-db';
const DB_VERSION = 9;

/** Object store holding saved {@link WorkflowSpec} documents (keyPath `id`). */
const WORKFLOWS_STORE = 'workflows';
/** Object store holding persisted {@link RunRecord}s (keyPath `summary.id`). */
const RUNS_STORE = 'runs';
const RUNS_BY_WORKFLOW = 'by-workflow';
const RUNS_BY_STARTED = 'by-started';
/**
 * Object store holding per-run {@link UsageLedgerEntry} rows (keyPath
 * `runId`) — deliberately separate from the runs store so cost analytics
 * survive run-history pruning (EPIC 2).
 */
const USAGE_STORE = 'usage';
const USAGE_BY_WORKFLOW = 'by-workflow';
const USAGE_BY_STARTED = 'by-started';

/** Usage-ledger retention: rows older than this are pruned on write. */
const USAGE_MAX_AGE_MS = 366 * 24 * 60 * 60 * 1000;
/** Usage-ledger retention: hard row cap (newest kept). */
const USAGE_MAX_ROWS = 5000;

/** Object store holding {@link EvalSuite} documents (keyPath `id`) — EPIC 4. */
const EVAL_SUITES_STORE = 'eval-suites';
const EVAL_SUITES_BY_WORKFLOW = 'by-workflow';
/** Object store holding {@link EvalRunSummary} rows (keyPath `id`) — EPIC 4. */
const EVAL_RUNS_STORE = 'eval-runs';
const EVAL_RUNS_BY_SUITE = 'by-suite';
const EVAL_RUNS_BY_WORKFLOW = 'by-workflow';

/** Eval-run retention per suite (newest kept). */
const EVAL_RUNS_KEEP = 50;

/** Object store holding {@link ChatThread} conversations (keyPath `id`) — EPIC 5. */
const CHAT_THREADS_STORE = 'chat-threads';
const CHAT_THREADS_BY_WORKFLOW = 'by-workflow';

/** Chat-thread retention per workflow (newest kept). */
const CHAT_THREADS_KEEP = 50;

/**
 * Object store holding {@link SkillDef} documents (keyPath `id`) — EPIC 6.
 * The skill library is GLOBAL (cross-workflow), so there is no workflow index.
 */
const SKILLS_STORE = 'skills';

/**
 * Object store holding {@link PromptEntry} documents (keyPath `id`).
 * Like the skill library the prompt library is GLOBAL (cross-workflow), so
 * there is no workflow index. Built-in prompts are derived from the node
 * catalog at read time and never stored here.
 */
const PROMPTS_STORE = 'prompts';

/** Full workflow snapshots used by persistent edit history (EPIC 7). */
const WORKFLOW_VERSIONS_STORE = 'workflow-versions';
const WORKFLOW_VERSIONS_BY_WORKFLOW = 'by-workflow';
const WORKFLOW_VERSIONS_BY_SAVED = 'by-saved';

/**
 * Object store holding {@link Connection} METADATA (keyPath `id`) — never a
 * secret value, which lives in the OS keychain under `conn:{id}:{key}`
 * (Requirement 3.4). Like `skills` and `prompts` the connection library is
 * GLOBAL, so there is deliberately no workflow index: every stored Connection
 * is readable from every workflow.
 */
const CONNECTIONS_STORE = 'connections';

/**
 * Object store backing the engine's `WorkflowStateStore` and `FixtureStore`
 * (keyPath `key`, index `by-workflow`) — Requirements 12.1-12.22, 16.10.
 *
 * Keys arrive already workflow-scoped from the engine (`workflowId::key` via
 * `scopedStateKey`), so a prefix scan can never cross a workflow boundary and
 * the retention bounds below are computed per scope. `workflowKey` duplicates
 * the scope as an indexed field, because IndexedDB cannot index a prefix.
 *
 * Semantics mirror the worker host (`cloud/src/workflow-state.ts`) exactly:
 * same namespace TTL defaults, same per-value and per-workflow caps, same
 * prune-oldest eviction and the same all-or-nothing `compareAndSet`.
 */
const WORKFLOW_STATE_STORE = 'workflow-state';
const WORKFLOW_STATE_BY_WORKFLOW = 'by-workflow';

/**
 * IndexedDB-backed persistence for workflow documents.
 *
 * IndexedDB is used (rather than localStorage) because workflow graphs can
 * grow well past the ~5MB localStorage budget and IDB writes are async, so
 * saves never jank the canvas.
 */
@Injectable({ providedIn: 'root' })
export class IndexedDbStorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Per-value / per-workflow retention bounds for the `workflow-state` store.
   * Mutable through {@link setStateBounds} so a prune test need not write
   * 50 000 keys to observe eviction.
   */
  private stateBounds: StateBounds = {
    maxValueBytes: STATE_VALUE_MAX_BYTES,
    maxKeys: STATE_MAX_KEYS_PER_WORKFLOW,
    maxTotalBytes: STATE_MAX_TOTAL_BYTES_PER_WORKFLOW,
  };

  /**
   * Live key count and value-byte total per workflow scope. IndexedDB cannot
   * aggregate, so a full scope scan on every write would make a delta sync
   * quadratic; the cache keeps the common path O(1) and a scan happens only on
   * a miss or when a bound is reached (where an exact answer actually matters).
   */
  private readonly stateStats = new Map<string, StateScopeStats>();

  async listWorkflows(): Promise<WorkflowSpec[]> {
    const db = await this.open();
    return this.request<WorkflowSpec[]>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).getAll(),
    );
  }

  async getWorkflow(id: string): Promise<WorkflowSpec | undefined> {
    const db = await this.open();
    return this.request<WorkflowSpec | undefined>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).get(id),
    );
  }

  async saveWorkflow(spec: WorkflowSpec): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(WORKFLOWS_STORE, 'readwrite').objectStore(WORKFLOWS_STORE).put(spec),
    );
  }

  async removeWorkflow(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(WORKFLOWS_STORE, 'readwrite').objectStore(WORKFLOWS_STORE).delete(id),
    );
  }

  // ── Run history (EPIC 1) ───────────────────────────────────────────────

  /** All local run records, newest first. Optionally scoped to a workflow. */
  async listRuns(workflowId?: string | null): Promise<RunRecord[]> {
    const db = await this.open();
    const store = db.transaction(RUNS_STORE, 'readonly').objectStore(RUNS_STORE);
    const records =
      workflowId !== undefined
        ? await this.request<RunRecord[]>(
            store.index(RUNS_BY_WORKFLOW).getAll(workflowId ?? 'draft'),
          )
        : await this.request<RunRecord[]>(store.getAll());
    return records.sort((a, b) => b.summary.startedAt - a.summary.startedAt);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const db = await this.open();
    return this.request<RunRecord | undefined>(
      db.transaction(RUNS_STORE, 'readonly').objectStore(RUNS_STORE).get(id),
    );
  }

  /** Upserts a run record (used mid-run and again when the run settles). */
  async saveRun(record: RunRecord): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE).put(toStoredRun(record)),
    );
  }

  async removeRun(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE).delete(id),
    );
  }

  /**
   * Deletes this workflow's runs beyond the `keep` most recent, then any
   * remaining run older than `maxAgeMs` (Requirement 15.12). `maxAgeMs` is
   * measured against `Date.now()` at call time.
   */
  async pruneRuns(workflowId: string | null, keep: number, maxAgeMs: number | null = null): Promise<void> {
    const runs = await this.listRuns(workflowId);
    const cutoff = maxAgeMs !== null ? Date.now() - maxAgeMs : null;
    const doomed = new Set<string>();
    for (const run of runs.slice(keep)) doomed.add(run.summary.id);
    if (cutoff !== null) {
      for (const run of runs) {
        if (run.summary.startedAt < cutoff) doomed.add(run.summary.id);
      }
    }
    if (doomed.size === 0) return;
    const db = await this.open();
    const store = db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE);
    await Promise.all([...doomed].map(id => this.request(store.delete(id))));
  }

  // ── Usage ledger (EPIC 2) ─────────────────────────────────────

  /** All usage-ledger rows started at/after `since`, newest first. */
  async listUsage(since = 0): Promise<UsageLedgerEntry[]> {
    const db = await this.open();
    const store = db.transaction(USAGE_STORE, 'readonly').objectStore(USAGE_STORE);
    const rows = await this.request<StoredUsage[]>(
      store.index(USAGE_BY_STARTED).getAll(IDBKeyRange.lowerBound(since)),
    );
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Upserts a run's usage-ledger row and applies retention. */
  async saveUsage(entry: UsageLedgerEntry): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(USAGE_STORE, 'readwrite').objectStore(USAGE_STORE).put(toStoredUsage(entry)),
    );
    await this.pruneUsage();
  }

  // ── Evals (EPIC 4) ────────────────────────────────────────────────────

  /** All eval suites for a workflow (`null` = unsaved drafts), newest first. */
  async listEvalSuites(workflowId: string | null): Promise<EvalSuite[]> {
    const db = await this.open();
    const store = db.transaction(EVAL_SUITES_STORE, 'readonly').objectStore(EVAL_SUITES_STORE);
    const suites = await this.request<EvalSuite[]>(
      store.index(EVAL_SUITES_BY_WORKFLOW).getAll(workflowId ?? 'draft'),
    );
    return suites.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveEvalSuite(suite: EvalSuite): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(EVAL_SUITES_STORE, 'readwrite')
        .objectStore(EVAL_SUITES_STORE)
        .put(toStoredEvalSuite(suite)),
    );
  }

  async removeEvalSuite(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(EVAL_SUITES_STORE, 'readwrite').objectStore(EVAL_SUITES_STORE).delete(id),
    );
    // A suite's run history dies with it.
    const runsStore = db.transaction(EVAL_RUNS_STORE, 'readwrite').objectStore(EVAL_RUNS_STORE);
    const runs = await this.request<EvalRunSummary[]>(
      runsStore.index(EVAL_RUNS_BY_SUITE).getAll(id),
    );
    await Promise.all(runs.map(run => this.request(runsStore.delete(run.id))));
  }

  /** All eval runs for a suite, newest first. */
  async listEvalRuns(suiteId: string): Promise<EvalRunSummary[]> {
    const db = await this.open();
    const store = db.transaction(EVAL_RUNS_STORE, 'readonly').objectStore(EVAL_RUNS_STORE);
    const runs = await this.request<EvalRunSummary[]>(
      store.index(EVAL_RUNS_BY_SUITE).getAll(suiteId),
    );
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Upserts an eval run (used at case boundaries and again on settle). */
  async saveEvalRun(run: EvalRunSummary): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(EVAL_RUNS_STORE, 'readwrite')
        .objectStore(EVAL_RUNS_STORE)
        .put(toStoredEvalRun(run)),
    );
    await this.pruneEvalRuns(run.suiteId);
  }

  async removeEvalRun(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(EVAL_RUNS_STORE, 'readwrite').objectStore(EVAL_RUNS_STORE).delete(id),
    );
  }

  /** Deletes this suite's oldest eval runs beyond {@link EVAL_RUNS_KEEP}. */
  private async pruneEvalRuns(suiteId: string): Promise<void> {
    const runs = await this.listEvalRuns(suiteId);
    if (runs.length <= EVAL_RUNS_KEEP) return;
    const db = await this.open();
    const store = db.transaction(EVAL_RUNS_STORE, 'readwrite').objectStore(EVAL_RUNS_STORE);
    await Promise.all(runs.slice(EVAL_RUNS_KEEP).map(run => this.request(store.delete(run.id))));
  }

  // ── Assistant chat threads (EPIC 5) ───────────────────────────────────

  /** All chat threads for a workflow (`null` = unsaved drafts), newest first. */
  async listChatThreads(workflowId: string | null): Promise<ChatThread[]> {
    const db = await this.open();
    const store = db.transaction(CHAT_THREADS_STORE, 'readonly').objectStore(CHAT_THREADS_STORE);
    const threads = await this.request<ChatThread[]>(
      store.index(CHAT_THREADS_BY_WORKFLOW).getAll(workflowId ?? 'draft'),
    );
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getChatThread(id: string): Promise<ChatThread | undefined> {
    const db = await this.open();
    return this.request<ChatThread | undefined>(
      db.transaction(CHAT_THREADS_STORE, 'readonly').objectStore(CHAT_THREADS_STORE).get(id),
    );
  }

  /** Upserts a chat thread and applies per-workflow retention. */
  async saveChatThread(thread: ChatThread): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(CHAT_THREADS_STORE, 'readwrite')
        .objectStore(CHAT_THREADS_STORE)
        .put(toStoredChatThread(thread)),
    );
    await this.pruneChatThreads(thread.workflowId);
  }

  async removeChatThread(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(CHAT_THREADS_STORE, 'readwrite').objectStore(CHAT_THREADS_STORE).delete(id),
    );
  }

  // ── Skill library (EPIC 6) ─────────────────────────────────────────────

  /** All library skills, most recently updated first. */
  async listSkills(): Promise<SkillDef[]> {
    const db = await this.open();
    const skills = await this.request<SkillDef[]>(
      db.transaction(SKILLS_STORE, 'readonly').objectStore(SKILLS_STORE).getAll(),
    );
    return skills.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveSkill(skill: SkillDef): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(SKILLS_STORE, 'readwrite').objectStore(SKILLS_STORE).put(skill),
    );
  }

  async removeSkill(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(SKILLS_STORE, 'readwrite').objectStore(SKILLS_STORE).delete(id),
    );
  }

  // ── Prompt library ─────────────────────────────────────────────────────

  /** All user-saved prompts, most recently updated first. */
  async listPrompts(): Promise<PromptEntry[]> {
    const db = await this.open();
    const prompts = await this.request<PromptEntry[]>(
      db.transaction(PROMPTS_STORE, 'readonly').objectStore(PROMPTS_STORE).getAll(),
    );
    return prompts.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async savePrompt(prompt: PromptEntry): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(PROMPTS_STORE, 'readwrite').objectStore(PROMPTS_STORE).put(prompt),
    );
  }

  async removePrompt(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(PROMPTS_STORE, 'readwrite').objectStore(PROMPTS_STORE).delete(id),
    );
  }

  // ── Workflow versions (EPIC 7) ────────────────────────────────────────

  /** All versions for a workflow, newest first. */
  async listWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
    const db = await this.open();
    const store = db
      .transaction(WORKFLOW_VERSIONS_STORE, 'readonly')
      .objectStore(WORKFLOW_VERSIONS_STORE);
    const versions = await this.request<WorkflowVersion[]>(
      store.index(WORKFLOW_VERSIONS_BY_WORKFLOW).getAll(workflowId),
    );
    return versions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async saveWorkflowVersion(version: WorkflowVersion): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOW_VERSIONS_STORE, 'readwrite')
        .objectStore(WORKFLOW_VERSIONS_STORE)
        .put(version),
    );
    await this.pruneWorkflowVersions(version.workflowId);
  }

  async removeWorkflowVersion(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(WORKFLOW_VERSIONS_STORE, 'readwrite').objectStore(WORKFLOW_VERSIONS_STORE).delete(id),
    );
  }

  async removeWorkflowVersions(workflowId: string): Promise<void> {
    const versions = await this.listWorkflowVersions(workflowId);
    if (versions.length === 0) return;
    const db = await this.open();
    const store = db.transaction(WORKFLOW_VERSIONS_STORE, 'readwrite').objectStore(WORKFLOW_VERSIONS_STORE);
    await Promise.all(versions.map(version => this.request(store.delete(version.id))));
  }

  // ── Connection metadata (P1-1, Requirement 3.4) ───────────────────────

  /** Every stored Connection, most recently updated first. Secret-free. */
  async listConnections(): Promise<Connection[]> {
    const db = await this.open();
    const connections = await this.request<Connection[]>(
      db.transaction(CONNECTIONS_STORE, 'readonly').objectStore(CONNECTIONS_STORE).getAll(),
    );
    return connections.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    const db = await this.open();
    return this.request<Connection | undefined>(
      db.transaction(CONNECTIONS_STORE, 'readonly').objectStore(CONNECTIONS_STORE).get(id),
    );
  }

  /**
   * Upserts connection METADATA. `secretKeys` holds field NAMES only — a caller
   * that hands a secret value to this method has a bug, so values are stripped
   * here rather than trusted.
   */
  async saveConnection(connection: Connection): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(CONNECTIONS_STORE, 'readwrite')
        .objectStore(CONNECTIONS_STORE)
        .put(toStoredConnection(connection)),
    );
  }

  /** Removes metadata only; keychain entries are cleared by the caller. */
  async removeConnection(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(CONNECTIONS_STORE, 'readwrite').objectStore(CONNECTIONS_STORE).delete(id),
    );
  }

  // ── Durable workflow state + fixtures (P1-8, Requirements 12.1-12.22) ──

  /**
   * Narrows the `workflow-state` retention bounds. Test seam: production code
   * uses the engine's constants, which are the defaults.
   */
  setStateBounds(bounds: Partial<StateBounds>): void {
    this.stateBounds = { ...this.stateBounds, ...bounds };
    this.stateStats.clear();
  }

  /** Requirements 12.1, 12.18, 12.20. An expired entry reads as absent. */
  async getState(key: string): Promise<StateEntry | undefined> {
    return this.stateTransaction('readonly', async store => {
      const row = await this.request<StoredStateEntry | undefined>(store.get(key));
      const now = Date.now();
      return row === undefined || isExpiredState(row, now) ? undefined : toStateEntry(row);
    });
  }

  /** Requirements 12.1, 12.16, 12.17, 12.18. */
  async setState(key: string, value: string, options?: { ttlSec?: number }): Promise<void> {
    await this.writeState(key, value, options?.ttlSec, this.stateBounds.maxValueBytes);
  }

  /**
   * Writes one entry under `maxBytes`, applying the namespace TTL and the
   * per-workflow retention bounds. `maxBytes` is the state cap for
   * `setState`/`compareAndSetState` and the much larger fixture cap for a
   * recorded response (Requirement 16.10).
   */
  async writeState(
    key: string,
    value: string,
    ttlSec?: number,
    maxBytes: number = this.stateBounds.maxValueBytes,
  ): Promise<void> {
    // Size is settled BEFORE the transaction opens, so a rejected write leaves
    // the stored value untouched (Requirement 12.16).
    const bytes = assertStateValueFits(key, value, maxBytes);
    const scope = stateScopeOf(key);
    try {
      await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        const live = await this.liveStateRow(store, key, now);
        const stats = await this.makeStateRoom(store, key, bytes, now, live);
        await this.request(store.put(toStoredState(key, value, bytes, ttlSec, now)));
        this.stateStats.set(scope, stats);
      });
    } catch (error) {
      // A failed or aborted transaction leaves the cached totals unreliable.
      this.stateStats.delete(scope);
      throw error;
    }
  }

  /** Requirement 12.22. Deleting an absent key resolves without an error. */
  async deleteState(key: string): Promise<void> {
    const scope = stateScopeOf(key);
    try {
      await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        const live = await this.liveStateRow(store, key, now);
        await this.request(store.delete(key));
        const stats = this.stateStats.get(scope);
        if (stats !== undefined && live !== undefined) {
          this.stateStats.set(scope, {
            keys: Math.max(0, stats.keys - 1),
            bytes: Math.max(0, stats.bytes - storedStateBytes(live)),
          });
        }
      });
    } catch (error) {
      this.stateStats.delete(scope);
      throw error;
    }
  }

  /** Requirements 12.18, 12.19. Prefix-bounded, clamped to 1-1000 entries. */
  async listState(prefix: string, limit?: number): Promise<StateEntry[]> {
    const cap = clampStateLimit(limit);
    return this.stateTransaction('readonly', async store => {
      const now = Date.now();
      const entries: StateEntry[] = [];
      // Keys are strings, so `[prefix, prefix + \uffff]` is exactly the prefix
      // range: no code unit a key can hold sorts above \uffff.
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      await this.cursor(store.openCursor(range), row => {
        if (!isExpiredState(row, now)) entries.push(toStateEntry(row));
        return entries.length < cap;
      });
      return entries;
    });
  }

  /**
   * Requirements 12.13, 12.21. Read and write share ONE readwrite transaction
   * and nothing but IndexedDB requests is awaited between them; IndexedDB never
   * overlaps two readwrite transactions on the same store, across tabs
   * included, so of any number of concurrent claims for one key exactly one
   * resolves true. A losing claim changes neither the value nor its expiry.
   */
  async compareAndSetState(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean> {
    const bytes = assertStateValueFits(key, value, this.stateBounds.maxValueBytes);
    const scope = stateScopeOf(key);
    try {
      return await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        const live = await this.liveStateRow(store, key, now);
        // An expired entry counts as absent for the expected value (12.18).
        const matches = expected === undefined ? live === undefined : live?.value === expected;
        if (!matches) return false;
        const stats = await this.makeStateRoom(store, key, bytes, now, live);
        await this.request(store.put(toStoredState(key, value, bytes, options?.ttlSec, now)));
        this.stateStats.set(scope, stats);
        return true;
      });
    } catch (error) {
      this.stateStats.delete(scope);
      throw error;
    }
  }

  /** The stored row for `key` when it exists and has not expired. */
  private async liveStateRow(
    store: IDBObjectStore,
    key: string,
    now: number,
  ): Promise<StoredStateEntry | undefined> {
    const row = await this.request<StoredStateEntry | undefined>(store.get(key));
    return row === undefined || isExpiredState(row, now) ? undefined : row;
  }

  /**
   * Requirement 12.17: prunes entries in ascending `updatedAt` order — never a
   * `wm:` or `oauth:` entry, never the key being written — until the pending
   * write fits both per-workflow bounds, and rejects with the breached bound
   * only when nothing prunable remains. Returns the scope totals that will hold
   * once the pending `put` lands.
   */
  private async makeStateRoom(
    store: IDBObjectStore,
    key: string,
    incomingBytes: number,
    now: number,
    live: StoredStateEntry | undefined,
  ): Promise<StateScopeStats> {
    const scope = stateScopeOf(key);
    const { maxKeys, maxTotalBytes } = this.stateBounds;
    const cached = this.stateStats.get(scope);
    if (cached !== undefined) {
      const projected: StateScopeStats = {
        keys: cached.keys + (live === undefined ? 1 : 0),
        bytes: cached.bytes - (live === undefined ? 0 : storedStateBytes(live)) + incomingBytes,
      };
      if (projected.keys <= maxKeys && projected.bytes <= maxTotalBytes) return projected;
    }

    // At (or near) a bound the exact answer matters: rescan the scope, dropping
    // expired entries on the way, then evict oldest-first until the write fits.
    const rows = await this.loadStateScope(store, scope, now);
    const others = rows.filter(row => row.key !== key);
    let keys = others.length + 1;
    let bytes = others.reduce((sum, row) => sum + storedStateBytes(row), 0) + incomingBytes;
    const victims = others
      .filter(row => isPrunableStateKey(row.key))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));

    while (keys > maxKeys || bytes > maxTotalBytes) {
      const victim = victims.shift();
      if (victim === undefined) {
        throw new Error(
          `Workflow state for "${scope}" is at its retention bound (${maxKeys} keys / ` +
            `${maxTotalBytes} bytes) and no further entry can be pruned.`,
        );
      }
      await this.request(store.delete(victim.key));
      keys -= 1;
      bytes -= storedStateBytes(victim);
    }
    return { keys, bytes };
  }

  /** Live rows of one workflow scope; deletes every expired row it passes. */
  private async loadStateScope(
    store: IDBObjectStore,
    scope: string,
    now: number,
  ): Promise<StoredStateEntry[]> {
    const rows = await this.request<StoredStateEntry[]>(
      store.index(WORKFLOW_STATE_BY_WORKFLOW).getAll(scope),
    );
    const live: StoredStateEntry[] = [];
    for (const row of rows) {
      if (isExpiredState(row, now)) await this.request(store.delete(row.key));
      else live.push(row);
    }
    return live;
  }

  /**
   * Runs `body` inside a single `workflow-state` transaction and resolves once
   * that transaction commits. `body` must await IndexedDB requests only —
   * awaiting anything else lets the transaction auto-commit underneath it.
   */
  private async stateTransaction<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(WORKFLOW_STATE_STORE, mode);
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
    });
    let result: T;
    try {
      result = await body(tx.objectStore(WORKFLOW_STATE_STORE));
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already settled — nothing to roll back.
      }
      await committed.catch(() => undefined);
      throw error;
    }
    await committed;
    return result;
  }

  /**
   * Walks a cursor, handing each row to `onRow`; stops when `onRow` returns
   * false or the cursor is exhausted.
   */
  private cursor(
    request: IDBRequest<IDBCursorWithValue | null>,
    onRow: (row: StoredStateEntry) => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve();
          return;
        }
        if (!onRow(cursor.value as StoredStateEntry)) {
          resolve();
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed.'));
    });
  }

  /** Deletes this workflow's oldest chat threads beyond {@link CHAT_THREADS_KEEP}. */
  private async pruneChatThreads(workflowId: string | null): Promise<void> {
    const threads = await this.listChatThreads(workflowId);
    if (threads.length <= CHAT_THREADS_KEEP) return;
    const db = await this.open();
    const store = db.transaction(CHAT_THREADS_STORE, 'readwrite').objectStore(CHAT_THREADS_STORE);
    await Promise.all(
      threads.slice(CHAT_THREADS_KEEP).map(thread => this.request(store.delete(thread.id))),
    );
  }

  /** Age + row-cap retention for the usage ledger. */
  private async pruneUsage(): Promise<void> {
    const db = await this.open();
    const store = db.transaction(USAGE_STORE, 'readwrite').objectStore(USAGE_STORE);
    const rows = await this.request<StoredUsage[]>(store.index(USAGE_BY_STARTED).getAll());
    const cutoff = Date.now() - USAGE_MAX_AGE_MS;
    const doomed = [
      ...rows.filter(row => row.startedAt < cutoff),
      ...rows
        .filter(row => row.startedAt >= cutoff)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(USAGE_MAX_ROWS),
    ];
    await Promise.all(doomed.map(row => this.request(store.delete(row.runId))));
  }

  /** Keeps the newest non-deployed snapshots; deployed snapshots are pinned. */
  private async pruneWorkflowVersions(workflowId: string): Promise<void> {
    const versions = await this.listWorkflowVersions(workflowId);
    const doomed = versions.filter(version => !version.deployed).slice(WORKFLOW_VERSIONS_KEEP);
    if (doomed.length === 0) return;
    const db = await this.open();
    const store = db.transaction(WORKFLOW_VERSIONS_STORE, 'readwrite').objectStore(WORKFLOW_VERSIONS_STORE);
    await Promise.all(doomed.map(version => this.request(store.delete(version.id))));
  }

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WORKFLOWS_STORE)) {
          db.createObjectStore(WORKFLOWS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(RUNS_STORE)) {
          const runs = db.createObjectStore(RUNS_STORE, { keyPath: 'summary.id' });
          // Unsaved drafts have workflowId null — stored as the 'draft' bucket
          // because IDB indexes skip records whose key value is null.
          runs.createIndex(RUNS_BY_WORKFLOW, 'workflowKey');
          runs.createIndex(RUNS_BY_STARTED, 'summary.startedAt');
        }
        if (!db.objectStoreNames.contains(USAGE_STORE)) {
          const usage = db.createObjectStore(USAGE_STORE, { keyPath: 'runId' });
          usage.createIndex(USAGE_BY_WORKFLOW, 'workflowKey');
          usage.createIndex(USAGE_BY_STARTED, 'startedAt');
        }
        if (!db.objectStoreNames.contains(EVAL_SUITES_STORE)) {
          const suites = db.createObjectStore(EVAL_SUITES_STORE, { keyPath: 'id' });
          suites.createIndex(EVAL_SUITES_BY_WORKFLOW, 'workflowKey');
        }
        if (!db.objectStoreNames.contains(EVAL_RUNS_STORE)) {
          const evalRuns = db.createObjectStore(EVAL_RUNS_STORE, { keyPath: 'id' });
          evalRuns.createIndex(EVAL_RUNS_BY_SUITE, 'suiteId');
          evalRuns.createIndex(EVAL_RUNS_BY_WORKFLOW, 'workflowKey');
        }
        if (!db.objectStoreNames.contains(CHAT_THREADS_STORE)) {
          const chats = db.createObjectStore(CHAT_THREADS_STORE, { keyPath: 'id' });
          chats.createIndex(CHAT_THREADS_BY_WORKFLOW, 'workflowKey');
        }
        if (!db.objectStoreNames.contains(SKILLS_STORE)) {
          db.createObjectStore(SKILLS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(PROMPTS_STORE)) {
          db.createObjectStore(PROMPTS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(WORKFLOW_VERSIONS_STORE)) {
          const versions = db.createObjectStore(WORKFLOW_VERSIONS_STORE, { keyPath: 'id' });
          versions.createIndex(WORKFLOW_VERSIONS_BY_WORKFLOW, 'workflowId');
          versions.createIndex(WORKFLOW_VERSIONS_BY_SAVED, 'savedAt');
        }
        // v9: connection metadata (global, no workflow index) and the durable
        // workflow-state store that also holds `fx:` fixtures.
        if (!db.objectStoreNames.contains(CONNECTIONS_STORE)) {
          db.createObjectStore(CONNECTIONS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(WORKFLOW_STATE_STORE)) {
          const state = db.createObjectStore(WORKFLOW_STATE_STORE, { keyPath: 'key' });
          state.createIndex(WORKFLOW_STATE_BY_WORKFLOW, 'workflowKey');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
    });
    return this.dbPromise;
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
    });
  }
}

/**
 * The stored shape adds a non-null `workflowKey` ('draft' for unsaved docs)
 * because IndexedDB indexes silently exclude records with null key values.
 */
function toStoredRun(record: RunRecord): RunRecord & { workflowKey: string } {
  return { ...record, workflowKey: record.summary.workflowId ?? 'draft' };
}

type StoredUsage = UsageLedgerEntry & { workflowKey: string };

/** Same null-key workaround as {@link toStoredRun}. */
function toStoredUsage(entry: UsageLedgerEntry): StoredUsage {
  return { ...entry, workflowKey: entry.workflowId ?? 'draft' };
}

/** Same null-key workaround as {@link toStoredRun}. */
function toStoredEvalSuite(suite: EvalSuite): EvalSuite & { workflowKey: string } {
  return { ...suite, workflowKey: suite.workflowId ?? 'draft' };
}

/** Same null-key workaround as {@link toStoredRun}. */
function toStoredEvalRun(run: EvalRunSummary): EvalRunSummary & { workflowKey: string } {
  return { ...run, workflowKey: run.workflowId ?? 'draft' };
}

/** Same null-key workaround as {@link toStoredRun}. */
function toStoredChatThread(thread: ChatThread): ChatThread & { workflowKey: string } {
  return { ...thread, workflowKey: thread.workflowId ?? 'draft' };
}

/** Retention bounds of the `workflow-state` store (Requirements 12.16, 12.17). */
export interface StateBounds {
  /** Per-value UTF-8 byte cap; a larger write is rejected. */
  maxValueBytes: number;
  /** Keys per workflow before prune-oldest. */
  maxKeys: number;
  /** Total UTF-8 value bytes per workflow before prune-oldest. */
  maxTotalBytes: number;
}

/** Live totals of one workflow scope, cached to keep writes O(1). */
interface StateScopeStats {
  keys: number;
  bytes: number;
}

/**
 * Row shape of the `workflow-state` store. `key` is the engine's already
 * workflow-scoped key; `workflowKey` is the indexed scope; `bytes` caches the
 * UTF-8 length so the per-workflow byte bound costs no re-encoding.
 */
interface StoredStateEntry {
  key: string;
  workflowKey: string;
  value: string;
  updatedAt: number;
  bytes: number;
  /** Absolute epoch-ms expiry, `null` for the never-expiring namespaces. */
  expiresAt: number | null;
}

/** Strips anything that is not connection metadata before it reaches storage. */
function toStoredConnection(connection: Connection): Connection {
  const { id, name, type, config, secretKeys, auth, allowWrites, limits, createdAt, updatedAt } =
    connection;
  return {
    id,
    name,
    type,
    config: { ...config },
    secretKeys: [...secretKeys],
    auth,
    ...(allowWrites === undefined ? {} : { allowWrites }),
    ...(limits === undefined ? {} : { limits: { ...limits } }),
    createdAt,
    updatedAt,
  };
}

/**
 * The workflow scope of a state key: everything before `::`, and the empty
 * scope for a key that arrives unscoped. Retention and the `by-workflow` index
 * are both per scope, so one workflow can never prune or scan another's
 * entries (Requirement 12.2).
 */
function stateScopeOf(key: string): string {
  const at = key.indexOf(STATE_SCOPE_SEPARATOR);
  return at < 0 ? '' : key.slice(0, at);
}

/** Requirement 12.16: reject an oversized value, changing nothing. */
function assertStateValueFits(key: string, value: string, maxBytes: number): number {
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(
      `State value for "${key}" is ${bytes} bytes, above the ${maxBytes}-byte per-value size limit.`,
    );
  }
  return bytes;
}

/** Requirement 12.18: namespace default TTL unless an explicit one applies. */
function toStoredState(
  key: string,
  value: string,
  bytes: number,
  ttlSec: number | undefined,
  now: number,
): StoredStateEntry {
  const ttl = resolveStateTtlSec(key, ttlSec);
  return {
    key,
    workflowKey: stateScopeOf(key),
    value,
    updatedAt: now,
    bytes,
    expiresAt: ttl === undefined ? null : now + ttl * 1000,
  };
}

/** Requirement 12.18: an entry expiring at or before `now` reads as absent. */
function isExpiredState(row: StoredStateEntry, now: number): boolean {
  return row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt <= now;
}

/** Byte size of a stored value, recomputed for rows written before `bytes`. */
function storedStateBytes(row: StoredStateEntry): number {
  return typeof row.bytes === 'number' ? row.bytes : utf8ByteLength(row.value);
}

function toStateEntry(row: StoredStateEntry): StateEntry {
  return row.expiresAt === null || row.expiresAt === undefined
    ? { key: row.key, value: row.value, updatedAt: row.updatedAt }
    : { key: row.key, value: row.value, updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

/** Requirement 12.19: absent limit = 1000, above 1000 clamps, below 1 clamps. */
function clampStateLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STATE_LIST_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, STATE_LIST_MAX_LIMIT);
}
