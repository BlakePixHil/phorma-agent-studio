import { Injectable } from '@angular/core';

import type { RunRecord, UsageLedgerEntry } from '@phorma/engine';

import type { WorkflowSpec } from './workflow.model';

const DB_NAME = 'phorma-agent-studio-db';
const DB_VERSION = 3;

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

  /** Deletes this workflow's oldest runs beyond `keep`. */
  async pruneRuns(workflowId: string | null, keep: number): Promise<void> {
    const runs = await this.listRuns(workflowId);
    if (runs.length <= keep) return;
    const db = await this.open();
    const store = db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE);
    await Promise.all(
      runs.slice(keep).map(run => this.request(store.delete(run.summary.id))),
    );
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
