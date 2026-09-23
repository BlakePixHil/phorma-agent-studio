import { Injectable, inject } from '@angular/core';

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

import { ActiveOwnerService } from './active-owner.service';
import type { ChatThread } from './assistant-chat.model';
import type { WorkflowBackupState } from './backup.model';
import type { InstalledConnector } from './connectors.model';
import type { PromptEntry } from './prompt-library.model';
import type { SkillDef } from './skills.model';
import type { WorkflowSpec } from './workflow.model';
import { WORKFLOW_VERSIONS_KEEP, type WorkflowVersion } from './workflow-versions.model';
import { TelemetryService } from './telemetry.service';

const DB_NAME = 'phorma-agent-studio-db';
/**
 * v12 adds {@link OWNER_FIELD} to every workflow-scoped store
 * (multi-organisation-phorma, Requirement 20.13).
 *
 * THE ONE IRREVERSIBLE STEP in that feature: it runs on the user's machine on
 * first launch of the new build and no worker deploy rolls it back. So the
 * migration is deliberately the smallest thing that can be correct - it adds a
 * field, it deletes nothing, and it rewrites no value that already exists. See
 * {@link OWNER_SCOPED_STORES}.
 */
const DB_VERSION = 12;

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
 * Object store holding INSTALLED connector bundles (keyPath `id`) - P1-14.
 *
 * Global like `skills`, `prompts` and `connections`, so there is no workflow
 * index. Only user-installed bundles live here: the connectors compiled into the
 * app are derived at read time (`BUILTIN_CONNECTOR_PREFIX`) and never stored, so
 * shipping a fix to a built-in reaches existing installs.
 *
 * A stored bundle is secret-free by construction - `validateConnectorBundle`
 * rejects a bundle carrying a credential before it can reach this store.
 */
const CONNECTORS_STORE = 'connectors';

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
 * Object store tracking what cloud backup has already uploaded (keyPath
 * `workflowId`) - cloud-workflow-backup Requirement 13.
 *
 * One row per workflow holding `lastUploadedHash` and the server-assigned
 * `revision`. It exists so restarting the studio does not re-upload the whole
 * library, and so the next upload can carry the right `If-Match`.
 *
 * GLOBAL like `skills` and `connections`, so there is no workflow index: the
 * workflow id IS the key. Deleting a workflow locally deletes its row here and
 * makes NO cloud call - a local delete never propagates.
 */
const WORKFLOW_BACKUP_STATE_STORE = 'workflow-backup-state';

/**
 * The owner a locally stored row belongs to (multi-organisation-phorma,
 * Requirement 20.13). `null` IS the personal account.
 *
 * NOT indexed, deliberately. Every read that needs it already fetches a whole
 * store or a whole workflow bucket and sorts in memory, so an index would buy
 * nothing and would need a v13 to add it to the five stores that have indexes
 * already. Filtering happens in {@link ownedBy}.
 */
export const OWNER_FIELD = 'ownerId';

/**
 * The stores a row's owner is recorded in, and the ONLY stores v12 touches.
 *
 * Exactly the workflow-scoped ones. The global libraries - `skills`, `prompts`,
 * `connections`, `connectors`, `eval-suites`, `eval-runs` and `chat-threads` -
 * are deliberately absent: Requirement 20.13 names the local library, the local
 * run history and the usage panel, because credits are the unit those render and
 * a surface mixing two payers reports a number belonging to nobody. A skill or a
 * connection is a tool the person owns, not a thing the organisation paid for,
 * and scoping one would hide a user's own work from them on a switch.
 *
 * The KEYCHAIN is absent for a stronger reason, stated in the design's rejected
 * alternatives: a browser member has no keychain path at all, and scoping one
 * would CREATE the artefact the "no customer credential on a build machine"
 * principle forbids.
 */
export const OWNER_SCOPED_STORES = [
  WORKFLOWS_STORE,
  RUNS_STORE,
  USAGE_STORE,
  WORKFLOW_VERSIONS_STORE,
  WORKFLOW_STATE_STORE,
  WORKFLOW_BACKUP_STATE_STORE,
] as const;

/** A stored row, with or without the v12 owner stamp. */
type OwnedRow = { [OWNER_FIELD]?: string | null };

/**
 * The owner a row belongs to, reading an ABSENT stamp as the personal account
 * (Requirement 20.15).
 *
 * The same absent-is-ordinary discipline `workflow_backups.body_key` follows. It
 * matters in two places at once: a row written by a build older than v12 in the
 * window before the upgrade ran, and a row written by any future code path that
 * forgets to stamp. Both read as the personal owner, which is the account that
 * wrote them.
 */
function ownerOf(row: OwnedRow | undefined | null): string | null {
  const owner = row?.[OWNER_FIELD];
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/** True when `row` belongs to `owner`. */
function ownedBy(row: OwnedRow | undefined | null, owner: string | null): boolean {
  return ownerOf(row) === owner;
}

/**
 * Strips the owner stamp off a row on its way out of the store.
 *
 * Only the WORKFLOWS store needs this, and it needs it badly: a `WorkflowSpec`
 * is hashed (`canonicalSpecHashOf`) by the backup and proposal paths, and the
 * worker hashes the spec IT was sent. An extra member riding along on a spec read
 * out of the library would make every hash disagree with the worker's, which
 * surfaces as a permanent `proposal_stale` or a backup that re-uploads forever.
 * The run, usage and version rows are not hashed and already carry a stored-only
 * `workflowKey` alongside, so they keep the stamp.
 */
function withoutOwner<T extends object>(row: T): T {
  if (!(OWNER_FIELD in row)) return row;
  const { [OWNER_FIELD]: _dropped, ...rest } = row as T & OwnedRow;
  return rest as T;
}

/**
 * IndexedDB-backed persistence for workflow documents.
 *
 * IndexedDB is used (rather than localStorage) because workflow graphs can
 * grow well past the ~5MB localStorage budget and IDB writes are async, so
 * saves never jank the canvas.
 */
@Injectable({ providedIn: 'root' })
export class IndexedDbStorageService {
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService` and no storage service, so this edge cannot come back here.
  private readonly telemetry = inject(TelemetryService);
  /**
   * Which owner's rows this session reads and writes (Requirement 20.13).
   *
   * Safe from anywhere, which is what this service needs: `ActiveOwnerService`
   * injects NOTHING at all and `scripts/check-capability-isolation.mjs` keeps it
   * that way. Almost every service in the studio injects this one, so a storage
   * edge into anything with dependencies of its own would put half the app in the
   * injector path of the other half.
   */
  private readonly activeOwner = inject(ActiveOwnerService);

  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * The owner every row written in this session is stamped with, and the one every
   * owner-scoped read filters on. `null` is the personal account.
   *
   * Read per call rather than cached, because a switch moves it mid-session and a
   * cached value would keep a switched studio writing rows under the previous
   * owner (Requirement 20.6).
   */
  private owner(): string | null {
    return this.activeOwner.storageOwner();
  }

  /** Adds the owner stamp to a row on its way into an owner-scoped store. */
  private stamped<T extends object>(row: T): T & OwnedRow {
    return { ...row, [OWNER_FIELD]: this.owner() };
  }

  /**
   * Keeps only the ACTIVE owner's rows (Requirements 20.13, 20.15).
   *
   * Filtering at the READ rather than deleting on switch is the decision that
   * makes Requirement 20.9 possible at all: a switch is a change of VIEW, and a
   * switch that pruned rows could not then present an owner's surfaces as they
   * were when the user switched back.
   */
  private ownedRows<T extends object>(rows: readonly T[]): T[] {
    const owner = this.owner();
    return rows.filter(row => ownedBy(row as OwnedRow, owner));
  }

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

  /**
   * The {@link stateStats} key for a state key: the ACTIVE owner plus the workflow
   * scope, joined by a character no id can hold.
   *
   * Owner-qualified because the retention bounds are counted per owner
   * (see {@link loadStateScope}), so a cache keyed on the scope alone would carry
   * one owner's totals across a switch and evict against the wrong number.
   */
  private stateStatsKey(key: string): string {
    return `${this.owner() ?? ''}\u0000${stateScopeOf(key)}`;
  }

  /** The ACTIVE owner's library (Requirement 20.13), owner stamp stripped. */
  async listWorkflows(): Promise<WorkflowSpec[]> {
    const db = await this.open();
    const rows = await this.request<WorkflowSpec[]>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).getAll(),
    );
    return this.ownedRows(rows).map(withoutOwner);
  }

  /**
   * One library entry, or undefined when it belongs to another owner.
   *
   * Scoped like the list, and for a reason worth stating: a workflow id is the key
   * of a document TAB and of a deployment, so an id left over from the previous
   * owner - in a restored session, a notification deep link, a backup record -
   * must read as absent rather than resolving somebody else's workflow of the same
   * name.
   */
  async getWorkflow(id: string): Promise<WorkflowSpec | undefined> {
    const db = await this.open();
    const row = await this.request<WorkflowSpec | undefined>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).get(id),
    );
    if (row === undefined || !ownedBy(row as OwnedRow, this.owner())) return undefined;
    return withoutOwner(row);
  }

  async saveWorkflow(spec: WorkflowSpec): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOWS_STORE, 'readwrite')
        .objectStore(WORKFLOWS_STORE)
        .put(this.stamped(spec)),
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
    return this.ownedRows(records).sort((a, b) => b.summary.startedAt - a.summary.startedAt);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const db = await this.open();
    const row = await this.request<RunRecord | undefined>(
      db.transaction(RUNS_STORE, 'readonly').objectStore(RUNS_STORE).get(id),
    );
    return row !== undefined && ownedBy(row as OwnedRow, this.owner()) ? row : undefined;
  }

  /** Upserts a run record (used mid-run and again when the run settles). */
  async saveRun(record: RunRecord): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(RUNS_STORE, 'readwrite')
        .objectStore(RUNS_STORE)
        .put(this.stamped(toStoredRun(record))),
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
    // The usage panel is the DECISIVE case for owner scoping: credits are the unit
    // it renders, so a panel mixing two payers reports a number belonging to
    // neither (Requirement 20.13).
    return this.ownedRows(rows).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Upserts a run's usage-ledger row and applies retention. */
  async saveUsage(entry: UsageLedgerEntry): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(USAGE_STORE, 'readwrite')
        .objectStore(USAGE_STORE)
        .put(this.stamped(toStoredUsage(entry))),
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
    return this.ownedRows(versions).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /**
   * Every workflow id that has at least one version snapshot marked
   * `deployed: true`. Used by the library panel and the toolbar cloud icon to
   * show a "deployed" badge without a per-workflow network round-trip. A single
   * full-table scan on startup; updated incrementally by `saveWorkflowVersion`.
   */
  async listDeployedWorkflowIds(): Promise<Set<string>> {
    const db = await this.open();
    const store = db
      .transaction(WORKFLOW_VERSIONS_STORE, 'readonly')
      .objectStore(WORKFLOW_VERSIONS_STORE);
    const all = this.ownedRows(await this.request<WorkflowVersion[]>(store.getAll()));
    const ids = new Set<string>();
    for (const version of all) {
      if (version.deployed) ids.add(version.workflowId);
    }
    return ids;
  }

  async saveWorkflowVersion(version: WorkflowVersion): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOW_VERSIONS_STORE, 'readwrite')
        .objectStore(WORKFLOW_VERSIONS_STORE)
        .put(this.stamped(version)),
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

  // ── Cloud backup state (cloud-workflow-backup, Requirement 13) ────────

  /** Every workflow this install has uploaded, for the settings surface. */
  async listBackupState(): Promise<WorkflowBackupState[]> {
    const db = await this.open();
    const rows = await this.request<WorkflowBackupState[]>(
      db
        .transaction(WORKFLOW_BACKUP_STATE_STORE, 'readonly')
        .objectStore(WORKFLOW_BACKUP_STATE_STORE)
        .getAll(),
    );
    return this.ownedRows(rows);
  }

  /**
   * What was last uploaded for one workflow, or undefined.
   *
   * Owner-scoped, and the consequence is the right one: after a switch the next
   * upload for a workflow of the same id finds no row, so it carries no `If-Match`
   * and the worker decides. That is safer than reusing a revision recorded against
   * a DIFFERENT tenant's backup, which would answer `backup_conflict` and read as
   * a broken feature.
   */
  async getBackupState(workflowId: string): Promise<WorkflowBackupState | undefined> {
    const db = await this.open();
    const row = await this.request<WorkflowBackupState | undefined>(
      db
        .transaction(WORKFLOW_BACKUP_STATE_STORE, 'readonly')
        .objectStore(WORKFLOW_BACKUP_STATE_STORE)
        .get(workflowId),
    );
    return row !== undefined && ownedBy(row as OwnedRow, this.owner()) ? row : undefined;
  }

  async saveBackupState(state: WorkflowBackupState): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOW_BACKUP_STATE_STORE, 'readwrite')
        .objectStore(WORKFLOW_BACKUP_STATE_STORE)
        .put(this.stamped(state)),
    );
  }

  /**
   * Forgets one workflow's upload state.
   *
   * LOCAL ONLY, and that is the whole point: a workflow leaving the library drops
   * this row and makes no cloud call, so the backup survives the delete
   * (Requirement 13.4, 17.3).
   */
  async removeBackupState(workflowId: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOW_BACKUP_STATE_STORE, 'readwrite')
        .objectStore(WORKFLOW_BACKUP_STATE_STORE)
        .delete(workflowId),
    );
  }

  /** Clears every row, for the disable-and-delete-all control. */
  async clearBackupState(): Promise<void> {
    const db = await this.open();
    await this.request(
      db
        .transaction(WORKFLOW_BACKUP_STATE_STORE, 'readwrite')
        .objectStore(WORKFLOW_BACKUP_STATE_STORE)
        .clear(),
    );
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

  // ── Installed connector bundles (P1-14) ───────────────────────────────

  /** Every installed connector, most recently installed first. */
  async listConnectors(): Promise<InstalledConnector[]> {
    const db = await this.open();
    const connectors = await this.request<InstalledConnector[]>(
      db.transaction(CONNECTORS_STORE, 'readonly').objectStore(CONNECTORS_STORE).getAll(),
    );
    return connectors.sort((a, b) => (b.installedAt ?? '').localeCompare(a.installedAt ?? ''));
  }

  async saveConnector(connector: InstalledConnector): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(CONNECTORS_STORE, 'readwrite').objectStore(CONNECTORS_STORE).put(connector),
    );
  }

  async removeConnector(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(CONNECTORS_STORE, 'readwrite').objectStore(CONNECTORS_STORE).delete(id),
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

  /**
   * Requirements 12.1, 12.18, 12.20. An expired entry reads as absent.
   *
   * So does ANOTHER OWNER's entry (multi-organisation-phorma, Requirement 20.13),
   * through {@link liveStateRow}. Read the note there for the one residual this
   * store carries that the others do not.
   */
  async getState(key: string): Promise<StateEntry | undefined> {
    return this.stateTransaction('readonly', async store => {
      const row = await this.liveStateRow(store, key, Date.now());
      return row === undefined ? undefined : toStateEntry(row);
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
    const scope = this.stateStatsKey(key);
    try {
      await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        const live = await this.liveStateRow(store, key, now);
        const stats = await this.makeStateRoom(store, key, bytes, now, live);
        await this.request(store.put(toStoredState(key, value, bytes, ttlSec, now, this.owner())));
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
    const scope = this.stateStatsKey(key);
    try {
      await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        // The RAW row first, because a foreign row must not be deleted
        // (Requirement 20.9) and `liveStateRow` cannot tell "absent" from
        // "somebody else's" - which is exactly what it is for on every other path.
        const stored = await this.request<StoredStateEntry | undefined>(store.get(key));
        if (stored !== undefined && !ownedBy(stored, this.owner())) return;
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
      const owner = this.owner();
      await this.cursor(store.openCursor(range), row => {
        if (!isExpiredState(row, now) && ownedBy(row, owner)) entries.push(toStateEntry(row));
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
    const scope = this.stateStatsKey(key);
    try {
      return await this.stateTransaction('readwrite', async store => {
        const now = Date.now();
        const live = await this.liveStateRow(store, key, now);
        // An expired entry counts as absent for the expected value (12.18).
        const matches = expected === undefined ? live === undefined : live?.value === expected;
        if (!matches) return false;
        const stats = await this.makeStateRoom(store, key, bytes, now, live);
        await this.request(store.put(toStoredState(key, value, bytes, options?.ttlSec, now, this.owner())));
        this.stateStats.set(scope, stats);
        return true;
      });
    } catch (error) {
      this.stateStats.delete(scope);
      throw error;
    }
  }

  /**
   * The stored row for `key` when it exists, has not expired, and belongs to the
   * ACTIVE owner.
   *
   * THE ONE RESIDUAL, stated here rather than left to be discovered: `key` is this
   * store's PRIMARY key and it is `{workflowId}::{key}`, with no owner segment. So
   * two owners holding the same workflow id AND the same state key share one row,
   * and a write under one replaces it. Putting the owner in the key instead would
   * have made v12 a key REWRITE rather than an added field, and a destructive
   * migration is not a trade worth making for a collision that needs the same
   * workflow to exist under two owners (a restore or an import) - in which case
   * the state genuinely is the same workflow's. Every read is still owner-scoped,
   * so no owner ever sees another's value.
   */
  private async liveStateRow(
    store: IDBObjectStore,
    key: string,
    now: number,
  ): Promise<StoredStateEntry | undefined> {
    const row = await this.request<StoredStateEntry | undefined>(store.get(key));
    if (row === undefined || isExpiredState(row, now)) return undefined;
    return ownedBy(row, this.owner()) ? row : undefined;
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
    // TWO keys, and they are not interchangeable: `scope` is the workflow segment
    // the `by-workflow` INDEX is keyed on, and `statsKey` is the owner-qualified
    // cache key. Passing the cache key to the index read would match nothing and
    // the bound would never be reached.
    const scope = stateScopeOf(key);
    const statsKey = this.stateStatsKey(key);
    const { maxKeys, maxTotalBytes } = this.stateBounds;
    const cached = this.stateStats.get(statsKey);
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

  /**
   * Live rows of one workflow scope BELONGING TO THE ACTIVE OWNER; deletes every
   * expired row of that owner it passes.
   *
   * Scoped on both counts deliberately. Retention counts only the active owner's
   * keys and bytes, because the bound is per workflow scope and a scope now means
   * "this owner's copy of this workflow"; and the expired-row sweep skips another
   * owner's rows, because a write under one owner must delete nothing of
   * another's (Requirement 20.9). An expired foreign row is swept by its own
   * owner's next write.
   */
  private async loadStateScope(
    store: IDBObjectStore,
    scope: string,
    now: number,
  ): Promise<StoredStateEntry[]> {
    const rows = await this.request<StoredStateEntry[]>(
      store.index(WORKFLOW_STATE_BY_WORKFLOW).getAll(scope),
    );
    const owner = this.owner();
    const live: StoredStateEntry[] = [];
    for (const row of rows) {
      if (!ownedBy(row, owner)) continue;
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
    // Retention is applied PER OWNER, on the owner whose row was just written.
    // Two reasons, and the second is the load-bearing one: the row cap is a cap on
    // what a surface renders, and that surface shows one owner; and a write under
    // one owner must never delete another owner's row (Requirement 20.9), which an
    // unscoped 5000-row cap would do the moment the two together crossed it.
    const rows = this.ownedRows(
      await this.request<StoredUsage[]>(store.index(USAGE_BY_STARTED).getAll()),
    );
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
      request.onupgradeneeded = event => {
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
        if (!db.objectStoreNames.contains(CONNECTORS_STORE)) {
          db.createObjectStore(CONNECTORS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(WORKFLOW_STATE_STORE)) {
          const state = db.createObjectStore(WORKFLOW_STATE_STORE, { keyPath: 'key' });
          state.createIndex(WORKFLOW_STATE_BY_WORKFLOW, 'workflowKey');
        }
        // v11: what cloud backup has already uploaded. A guarded create like every
        // block above, so an existing install keeps every store and every row it
        // already had (Requirement 13.3) - there is no record-level migration here
        // and nothing to rewrite.
        if (!db.objectStoreNames.contains(WORKFLOW_BACKUP_STATE_STORE)) {
          db.createObjectStore(WORKFLOW_BACKUP_STATE_STORE, { keyPath: 'workflowId' });
        }
        // ── v12: the owner stamp (Requirements 20.13, 20.14) ─────────────────
        //
        // Unlike every block above this one is a RECORD-LEVEL migration, and it is
        // the only step in this feature with no server-side rollback: it runs on
        // the user's machine on first launch of the new build. Three properties
        // make it safe to run exactly once and never again:
        //
        //  - It only ADDS a field. Nothing is deleted, no key changes, and no
        //    existing value is rewritten, so a row is readable by the previous
        //    build too (an unknown member is ignored on read).
        //  - It stamps `null`, the PERSONAL account - which is the Owner_Id in
        //    force before this feature existed, because nothing could be addressed
        //    but the account's own data. The literal is written rather than left
        //    absent so the upgrade is OBSERVABLE: "every row now carries a stamp"
        //    is a thing a test can assert, where "nothing changed" is not.
        //    Requirement 20.15 still holds independently, in `ownerOf`.
        //  - It runs inside the version-change transaction the browser already
        //    opened, so a failure anywhere aborts the whole upgrade and leaves the
        //    store at v11 rather than half-stamped.
        //
        // Guarded on `oldVersion` so a FRESH install does no work: there are no
        // rows, and running a cursor over six empty stores on first launch would
        // be pure ceremony.
        migrateOwnerStamp(request.transaction, db, event.oldVersion);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        // A database that will not open is the one storage failure every caller
        // inherits, so it is counted here rather than in each of them
        // (Requirements 3.1, 3.2). Category only: `DOMException.name` and its
        // message stay local, because `recordError` has no parameter for them.
        this.telemetry.recordError('storage');
        reject(request.error ?? new Error('Could not open IndexedDB.'));
      };
    });
    return this.dbPromise;
  }

  /**
   * Every store operation in this service goes through here, so one failed
   * IndexedDB request is one `storage` counter (Requirements 3.1, 3.2, 11.3).
   * A request that fails aborts its transaction, so a single logical failure
   * cannot count twice on this path.
   */
  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.telemetry.recordError('storage');
        reject(request.error ?? new Error('IndexedDB request failed.'));
      };
    });
  }
}

/**
 * The v12 upgrade step (Requirement 20.14), guard included.
 *
 * EXPORTED so a test can drive the real thing against a store seeded at v11 in a
 * database of its own. That is not a convenience: this is the only irreversible
 * step in the feature - it runs on the user's machine on first launch and no
 * server deploy rolls it back - and verifying it against an EMPTY store would
 * assert nothing at all, while verifying it against the shared production
 * database would need a version-change transaction against connections other
 * specs still hold open.
 *
 * The guard is inside rather than at the call site for the same reason: a test
 * that re-implemented `oldVersion > 0 && oldVersion < 12` would be checking its own
 * copy of the condition.
 */
export function migrateOwnerStamp(
  transaction: IDBTransaction | null,
  db: IDBDatabase,
  oldVersion: number,
): void {
  // A FRESH install does no work: there are no rows, and walking six empty stores
  // on first launch would be pure ceremony. `oldVersion === 0` is that case.
  if (transaction === null || oldVersion === 0 || oldVersion >= 12) return;
  stampOwner(transaction, db);
}

/**
 * Stamps every existing row in the owner-scoped stores with the personal
 * Owner_Id, inside the version-change transaction (Requirement 20.14).
 *
 * Synchronous on purpose, and it has to be: nothing may be awaited inside an
 * `onupgradeneeded` handler, because the version-change transaction auto-commits
 * the moment control returns to the event loop for anything other than an
 * IndexedDB request. So this opens a cursor per store and chains the writes off
 * the cursor's own `onsuccess`, which keeps the transaction alive until the walk
 * finishes. A failure anywhere aborts it, which is what keeps the upgrade
 * all-or-nothing.
 *
 * A store this build has not created yet is skipped rather than assumed - a
 * partial upgrade from an old version reaches here with a different set of stores
 * than the constant lists.
 *
 * A row that ALREADY carries a stamp is left alone. That cannot happen on a
 * v11-to-v12 upgrade, and it is what makes the walk safe if it is ever reached
 * from a later version.
 */
function stampOwner(transaction: IDBTransaction, db: IDBDatabase): void {
  for (const name of OWNER_SCOPED_STORES) {
    if (!db.objectStoreNames.contains(name)) continue;
    const cursorRequest = transaction.objectStore(name).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) return;
      const row = cursor.value as OwnedRow | null;
      if (row !== null && typeof row === 'object' && !(OWNER_FIELD in row)) {
        cursor.update({ ...row, [OWNER_FIELD]: null });
      }
      cursor.continue();
    };
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
  /**
   * The owner the entry belongs to (Requirement 20.13). Absent reads as personal.
   *
   * A state key is `{workflowId}::{key}`, and a workflow id is unique per owner
   * rather than globally - a restored backup, or two organisations built from one
   * template, can put the same id under two owners. So the owner is part of the
   * scope for retention as well as for reads.
   */
  [OWNER_FIELD]?: string | null;
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
  owner: string | null,
): StoredStateEntry {
  const ttl = resolveStateTtlSec(key, ttlSec);
  return {
    key,
    workflowKey: stateScopeOf(key),
    value,
    updatedAt: now,
    bytes,
    expiresAt: ttl === undefined ? null : now + ttl * 1000,
    [OWNER_FIELD]: owner,
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
