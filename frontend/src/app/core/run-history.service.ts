import { Injectable, inject, signal } from '@angular/core';

import {
  createRunRecorder,
  type RunEvent,
  type RunRecord,
  type RunRecorder,
  type RunRecordSummary,
  type WorkflowGraph,
} from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';

/** How many finished runs each workflow keeps locally; oldest are pruned. */
const RUN_HISTORY_LIMIT = 50;

/**
 * Local run history (EPIC 1) — persists every LOCAL run to IndexedDB as a
 * {@link RunRecord}: a summary for the Runs-panel list plus a coalesced event
 * log for rebuilding the trace and node states ("Bring to Canvas").
 *
 * Cloud runs are deliberately NOT recorded here: the Durable Object persists
 * those in its own SQLite and the studio lists them via `GET /runs` — one
 * source of truth per environment, no duplicate records from monitor events.
 *
 * Wiring: `RunControllerService.start()` calls {@link beginRun} with the run
 * identity + graph snapshot, then feeds every engine event to {@link record}
 * from its `emit` callback (which only local runs flow through).
 */
@Injectable({ providedIn: 'root' })
export class RunHistoryService {
  private readonly storage = inject(IndexedDbStorageService);

  private recorder: RunRecorder | null = null;
  private activeRunId: string | null = null;
  private activeWorkflowId: string | null = null;

  /** Local run records, newest first (refreshed after every persist). */
  readonly localRuns = signal<RunRecord[]>([]);
  /** Bumped whenever history changes — panels can react to refreshes. */
  readonly revision = signal(0);

  /** Loads the full local history from IndexedDB into {@link localRuns}. */
  async refresh(): Promise<void> {
    try {
      this.localRuns.set(await this.storage.listRuns());
      this.revision.update(n => n + 1);
    } catch {
      // History must never break the studio — an unreadable store lists empty.
      this.localRuns.set([]);
    }
  }

  /**
   * Starts recording a local run. `graph` must be the same snapshot handed
   * to the engine (the user can edit the canvas while the run executes).
   */
  beginRun(meta: {
    runId: string;
    workflowId: string | null;
    workflowName: string;
    graph: WorkflowGraph;
  }): void {
    this.recorder = createRunRecorder({
      ...meta,
      source: 'manual',
      environment: 'local',
    });
    this.activeRunId = meta.runId;
    this.activeWorkflowId = meta.workflowId;
  }

  /** Feeds one engine event into the active recorder (no-op when idle). */
  record(event: RunEvent): void {
    const recorder = this.recorder;
    if (!recorder || event.runId !== this.activeRunId) return;
    recorder.record(event);
    // Persist at run + node boundaries so a crash mid-run still leaves a
    // browsable record (status 'running' = interrupted). Token events never
    // hit IndexedDB — the recorder coalesces them in memory.
    if (
      event.type === 'run-started' ||
      event.type === 'node-completed' ||
      event.type === 'node-failed'
    ) {
      void this.persist(recorder);
    }
    if (recorder.settled) {
      this.recorder = null;
      this.activeRunId = null;
      void this.persist(recorder, this.activeWorkflowId);
      this.activeWorkflowId = null;
    }
  }

  /** Loads one full record (for run detail / Bring to Canvas). */
  getRun(id: string): Promise<RunRecord | undefined> {
    return this.storage.getRun(id);
  }

  async deleteRun(id: string): Promise<void> {
    await this.storage.removeRun(id);
    await this.refresh();
  }

  private async persist(recorder: RunRecorder, pruneKey?: string | null): Promise<void> {
    try {
      await this.storage.saveRun(recorder.snapshot());
      if (pruneKey !== undefined) {
        await this.storage.pruneRuns(pruneKey, RUN_HISTORY_LIMIT);
      }
      await this.refresh();
    } catch {
      // Persistence failures must never break a run.
    }
  }
}

/** Sort helper shared by panels merging local + cloud summaries. */
export function byStartedAtDesc(a: RunRecordSummary, b: RunRecordSummary): number {
  return b.startedAt - a.startedAt;
}
