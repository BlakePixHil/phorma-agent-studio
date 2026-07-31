import { Injectable, inject, signal } from '@angular/core';

import {
  createRunRecorder,
  usageLedgerEntryOf,
  type RunEvent,
  type RunRecord,
  type RunRecorder,
  type RunRecordSummary,
  type EmbeddedWorkflow,
  type WorkflowGraph,
} from '@phorma/engine';

import type { RunRetention } from './data-path-settings';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { ModelPricingService } from './model-pricing.service';

/** How many finished runs each workflow keeps locally; oldest are pruned. */
export const RUN_HISTORY_LIMIT = 50;

/** Retention applied when a run carries no workflow-level override. */
const DEFAULT_RETENTION: RunRetention = { keepRuns: RUN_HISTORY_LIMIT, maxAgeMs: null };

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
  private readonly pricing = inject(ModelPricingService);

  private recorder: RunRecorder | null = null;
  private activeRunId: string | null = null;
  private activeWorkflowId: string | null = null;
  private activeRetention: RunRetention = DEFAULT_RETENTION;

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
    subWorkflows?: Record<string, EmbeddedWorkflow>;
    /** `WorkflowSettings.retention` resolved by the caller. Absent = host default. */
    retention?: RunRetention;
  }): void {
    const { retention, ...recorderMeta } = meta;
    this.recorder = createRunRecorder({
      ...recorderMeta,
      source: 'manual',
      environment: 'local',
      // BYO providers without usage accounting (OpenAI, Anthropic, Bedrock,
      // Gemini) get an estimated USD cost from the synced pricing table.
      estimateCost: this.pricing.estimator(),
    });
    this.activeRunId = meta.runId;
    this.activeWorkflowId = meta.workflowId;
    this.activeRetention = retention ?? DEFAULT_RETENTION;
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
      const retention = this.activeRetention;
      void this.persist(recorder, this.activeWorkflowId, retention);
      // Usage ledger (EPIC 2): one compact row per settled run, separate
      // from run records so cost analytics survive the history prune.
      void this.storage
        .saveUsage(usageLedgerEntryOf(recorder.summary()))
        .catch(() => undefined);
      this.activeWorkflowId = null;
      this.activeRetention = DEFAULT_RETENTION;
    }
  }

  /** Loads one full record (for run detail / Bring to Canvas). */
  getRun(id: string): Promise<RunRecord | undefined> {
    return this.storage.getRun(id);
  }

  /**
   * Persists a run recorded OUTSIDE the single active recorder — eval case
   * runs (EPIC 4) build their own recorders (several run concurrently) but
   * still land in normal run history with the same pruning + usage ledger.
   */
  async saveExternalRecord(record: RunRecord): Promise<void> {
    try {
      await this.storage.saveRun(record);
      if (record.summary.endedAt !== undefined) {
        await this.storage.pruneRuns(record.summary.workflowId, RUN_HISTORY_LIMIT);
        await this.storage.saveUsage(usageLedgerEntryOf(record.summary)).catch(() => undefined);
      }
      await this.refresh();
    } catch {
      // Persistence failures must never break an eval run.
    }
  }

  async deleteRun(id: string): Promise<void> {
    await this.storage.removeRun(id);
    await this.refresh();
  }

  private async persist(
    recorder: RunRecorder,
    pruneKey?: string | null,
    retention: RunRetention = DEFAULT_RETENTION,
  ): Promise<void> {
    try {
      await this.storage.saveRun(recorder.snapshot());
      if (pruneKey !== undefined) {
        await this.storage.pruneRuns(pruneKey, retention.keepRuns, retention.maxAgeMs);
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
