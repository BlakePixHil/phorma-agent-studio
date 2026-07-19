import { Injectable, inject, signal } from '@angular/core';

import type { EvalRunSummary, EvalSuite } from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';

/**
 * Eval suite persistence (EPIC 4) — CRUD over the IndexedDB `eval-suites`
 * and `eval-runs` stores, exposed as signals for the Evals panel.
 *
 * Suites are keyed to a workflow id (unsaved drafts share the 'draft'
 * bucket, mirroring run history). Executing suites is
 * `EvalRunnerService`'s job — this service only stores.
 */
@Injectable({ providedIn: 'root' })
export class EvalService {
  private readonly storage = inject(IndexedDbStorageService);

  /** Suites for the workflow last passed to {@link refresh}, newest first. */
  readonly suites = signal<EvalSuite[]>([]);
  /** Eval runs for the suite last passed to {@link refreshRuns}, newest first. */
  readonly runs = signal<EvalRunSummary[]>([]);

  private lastWorkflowId: string | null | undefined;
  private lastSuiteId: string | undefined;

  /** Loads all suites for a workflow into {@link suites}. */
  async refresh(workflowId: string | null): Promise<void> {
    this.lastWorkflowId = workflowId;
    try {
      this.suites.set(await this.storage.listEvalSuites(workflowId));
    } catch {
      // Evals must never break the studio — an unreadable store lists empty.
      this.suites.set([]);
    }
  }

  /** Loads a suite's past eval runs into {@link runs}. */
  async refreshRuns(suiteId: string): Promise<void> {
    this.lastSuiteId = suiteId;
    try {
      this.runs.set(await this.storage.listEvalRuns(suiteId));
    } catch {
      this.runs.set([]);
    }
  }

  /** Creates an empty suite for a workflow and returns it. */
  async createSuite(workflowId: string | null, name: string): Promise<EvalSuite> {
    const now = Date.now();
    const suite: EvalSuite = {
      id: `suite-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      workflowId,
      name,
      cases: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSuite(suite);
    return suite;
  }

  /** Upserts a suite (bumps `updatedAt`) and refreshes the list. */
  async saveSuite(suite: EvalSuite): Promise<void> {
    await this.storage.saveEvalSuite({ ...suite, updatedAt: Date.now() });
    await this.refresh(this.lastWorkflowId ?? suite.workflowId);
  }

  /** Deletes a suite and its eval-run history. */
  async deleteSuite(suite: EvalSuite): Promise<void> {
    await this.storage.removeEvalSuite(suite.id);
    await this.refresh(this.lastWorkflowId ?? suite.workflowId);
    if (this.lastSuiteId === suite.id) this.runs.set([]);
  }

  /** Upserts an eval run (mid-run checkpoints + final settle). */
  async saveRun(run: EvalRunSummary): Promise<void> {
    await this.storage.saveEvalRun(run);
    if (this.lastSuiteId === run.suiteId) await this.refreshRuns(run.suiteId);
  }

  async deleteRun(run: EvalRunSummary): Promise<void> {
    await this.storage.removeEvalRun(run.id);
    if (this.lastSuiteId === run.suiteId) await this.refreshRuns(run.suiteId);
  }
}
