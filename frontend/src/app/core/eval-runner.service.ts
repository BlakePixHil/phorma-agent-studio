import { Injectable, computed, inject, signal } from '@angular/core';

import {
  createRunRecorder,
  evalModelLabel,
  scoreOutput,
  startRun,
  type EvalCase,
  type EvalCaseResult,
  type EvalModelRef,
  type EvalRunSummary,
  type EvalScore,
  type EvalSuite,
  type RunHandle,
  type WorkflowGraph,
} from '@phorma/engine';

import { CloudService } from './cloud.service';
import { EvalService } from './eval.service';
import { ModelPricingService } from './model-pricing.service';
import { ModelTransportService } from './model-transport.service';
import { RunHistoryService } from './run-history.service';
import { SettingsService } from './settings.service';
import { ToolHostService } from './tool-host.service';
import { WorkflowService } from './workflow.service';

/** Local case executions in flight at once. */
const LOCAL_CONCURRENCY = 3;
/** Cloud completion polling cadence. */
const CLOUD_POLL_MS = 2000;
/** Safety margin added to the workflow timeout when polling cloud runs. */
const CLOUD_TIMEOUT_MARGIN_MS = 2 * 60_000;
/** Fallback cloud case budget when the workflow has no timeout configured. */
const CLOUD_DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Case outputs stored in eval results are clipped to this length. */
const RESULT_OUTPUT_CAP = 16 * 1024;

/** Live per-case status surfaced by the Evals panel while a suite runs. */
export interface EvalCaseProgress {
  caseId: string;
  model?: string;
  status: 'pending' | 'running' | 'scoring' | 'passed' | 'failed' | 'error';
}

/**
 * Executes eval suites (EPIC 4).
 *
 * Local: each case is a REAL engine run (own recorder, `source: 'eval'`)
 * executed directly via `startRun` — deliberately bypassing
 * `RunControllerService`, which is single-run and owns the live canvas.
 * Cases run in a small concurrent pool; every case run is persisted to
 * normal run history so results link to full traces.
 *
 * Cloud: cases run sequentially against the deployed Durable Object (it
 * rejects concurrent triggers with 409) via HTTP trigger + polling; outputs
 * are scored locally, records are persisted by the DO.
 *
 * Model comparison: the suite re-runs once per `suite.models` entry with
 * `RunOptions.defaultModel` overridden — agents pinning an explicit model
 * are unaffected. Local only (cloud specs are materialized at push time).
 */
@Injectable({ providedIn: 'root' })
export class EvalRunnerService {
  private readonly workflow = inject(WorkflowService);
  private readonly transport = inject(ModelTransportService);
  private readonly settings = inject(SettingsService);
  private readonly toolHost = inject(ToolHostService);
  private readonly pricing = inject(ModelPricingService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly evals = inject(EvalService);
  private readonly cloud = inject(CloudService);

  private cancelled = false;
  private readonly liveHandles = new Set<RunHandle>();
  private runCounter = 0;

  /** The suite run currently executing, or null when idle. */
  readonly activeRun = signal<EvalRunSummary | null>(null);
  /** Live case statuses for the active suite run. */
  readonly caseProgress = signal<ReadonlyMap<string, EvalCaseProgress>>(new Map());
  readonly running = computed(() => this.activeRun() !== null);
  readonly progress = computed(() => {
    const statuses = [...this.caseProgress().values()];
    const done = statuses.filter(
      entry => entry.status === 'passed' || entry.status === 'failed' || entry.status === 'error',
    ).length;
    return { done, total: statuses.length };
  });

  /** Runs a suite. Resolves with the persisted summary when it settles. */
  async runSuite(
    suite: EvalSuite,
    environment: 'local' | 'cloud',
  ): Promise<EvalRunSummary | null> {
    if (this.running() || suite.cases.length === 0) return null;
    this.cancelled = false;

    // Local model-comparison passes; cloud always runs a single default pass.
    const passes: (EvalModelRef | undefined)[] =
      environment === 'local' && suite.models?.length ? suite.models : [undefined];

    const run: EvalRunSummary = {
      id: `evalrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      suiteId: suite.id,
      workflowId: suite.workflowId,
      suiteName: suite.name,
      environment,
      status: 'running',
      models: passes.filter((pass): pass is EvalModelRef => !!pass).map(evalModelLabel),
      results: [],
      startedAt: Date.now(),
    };
    this.activeRun.set(run);
    this.caseProgress.set(
      new Map(
        passes.flatMap(pass =>
          suite.cases.map(testCase => {
            const model = pass ? evalModelLabel(pass) : undefined;
            const key = progressKey(testCase.id, model);
            return [key, { caseId: testCase.id, model, status: 'pending' as const }] as const;
          }),
        ),
      ),
    );
    await this.evals.saveRun(run);

    try {
      const graph = structuredClone(this.workflow.graph());
      for (const pass of passes) {
        if (this.cancelled) break;
        if (environment === 'local') {
          await this.runLocalPass(suite, run, graph, pass);
        } else {
          await this.runCloudPass(suite, run);
        }
      }
      run.status = this.cancelled ? 'cancelled' : 'completed';
    } catch {
      run.status = this.cancelled ? 'cancelled' : 'failed';
    }
    run.endedAt = Date.now();
    await this.evals.saveRun(run);
    await this.runHistory.refresh();
    this.activeRun.set(null);
    return run;
  }

  /** Stops pending cases and aborts in-flight local runs. */
  cancel(): void {
    this.cancelled = true;
    for (const handle of this.liveHandles) handle.stop();
  }

  // ── Local execution ────────────────────────────────────────────────────────

  private async runLocalPass(
    suite: EvalSuite,
    run: EvalRunSummary,
    graph: WorkflowGraph,
    pass: EvalModelRef | undefined,
  ): Promise<void> {
    const queue = [...suite.cases];
    const workers = Array.from({ length: Math.min(LOCAL_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const testCase = queue.shift();
        if (!testCase || this.cancelled) return;
        const result = await this.runLocalCase(suite, testCase, graph, pass);
        run.results.push(result);
        this.setProgress(testCase.id, pass, result.status);
        // Checkpoint at case boundaries so a crash leaves partial results.
        await this.evals.saveRun(run);
      }
    });
    await Promise.all(workers);
  }

  private async runLocalCase(
    suite: EvalSuite,
    testCase: EvalCase,
    graph: WorkflowGraph,
    pass: EvalModelRef | undefined,
  ): Promise<EvalCaseResult> {
    const model = pass ? evalModelLabel(pass) : undefined;
    this.setProgress(testCase.id, pass, 'running');
    this.runCounter += 1;
    const runId = `run-${Date.now().toString(36)}-eval${this.runCounter}`;
    const doc = this.workflow.activeDoc();
    const graphSnapshot = structuredClone(graph);
    const recorder = createRunRecorder({
      runId,
      workflowId: suite.workflowId,
      workflowName: doc?.name ?? 'Untitled Workflow',
      source: 'eval',
      environment: 'local',
      graph: graphSnapshot,
      estimateCost: this.pricing.estimator(),
    });
    const startedAt = Date.now();

    const handle = startRun({
      runId,
      graph: graphSnapshot,
      input: testCase.input,
      source: 'eval',
      maxExecutions: graph.nodes.some(node => node.kind === 'for-each') ? 2000 : undefined,
      model: this.transport.create(),
      ollamaBaseUrl: this.settings.ollamaBaseUrl(),
      lmstudioBaseUrl: this.settings.lmstudioBaseUrl(),
      bedrockRegion: this.settings.bedrockRegion(),
      defaultModel: {
        provider: pass?.provider ?? this.settings.defaultProvider(),
        model: pass?.model ?? this.settings.defaultModel(),
        temperature: this.settings.defaultTemperature(),
      },
      maxToolRounds: this.settings.maxToolRounds(),
      runTimeoutMs: this.workflowTimeoutMs(),
      contextWindow: this.pricing.contextWindowLookup(),
      tools: this.toolHost,
      emit: event => recorder.record(event),
      // Evals are unattended: approval gates auto-approve, external-event
      // waits fail the case immediately (a suite can't wait for a webhook).
      requestApproval: async () => true,
      waitForEvent: async () => {
        throw new Error('Eval runs cannot wait for external events.');
      },
    });
    this.liveHandles.add(handle);
    try {
      await handle.done;
    } finally {
      this.liveHandles.delete(handle);
    }

    const summary = recorder.summary();
    await this.runHistory.saveExternalRecord(recorder.snapshot());

    const base = {
      caseId: testCase.id,
      runId,
      model,
      durationMs: Date.now() - startedAt,
      costUsd: summary.usage.costUsd || undefined,
    };
    if (summary.status !== 'completed') {
      return {
        ...base,
        status: 'error',
        output: clip(summary.output ?? ''),
        error: summary.error ?? `Run ${summary.status}.`,
      };
    }
    return this.scoreCase(suite, testCase, summary.output ?? '', base, pass);
  }

  // ── Cloud execution ────────────────────────────────────────────────────────

  private async runCloudPass(suite: EvalSuite, run: EvalRunSummary): Promise<void> {
    const workflowId = suite.workflowId;
    if (!workflowId) throw new Error('Save the workflow before running cloud evals.');
    // Sequential by design: the Durable Object rejects concurrent runs (409).
    for (const testCase of suite.cases) {
      if (this.cancelled) break;
      const result = await this.runCloudCase(suite, workflowId, testCase);
      run.results.push(result);
      this.setProgress(testCase.id, undefined, result.status);
      await this.evals.saveRun(run);
    }
  }

  private async runCloudCase(
    suite: EvalSuite,
    workflowId: string,
    testCase: EvalCase,
  ): Promise<EvalCaseResult> {
    this.setProgress(testCase.id, undefined, 'running');
    const startedAt = Date.now();
    const budgetMs = (this.workflowTimeoutMs() ?? CLOUD_DEFAULT_TIMEOUT_MS) + CLOUD_TIMEOUT_MARGIN_MS;
    let runId: string;
    try {
      ({ runId } = await this.cloud.triggerHttp(workflowId, testCase.input, 'eval'));
    } catch (error) {
      return {
        caseId: testCase.id,
        runId: '',
        status: 'error',
        output: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    }

    // Poll the DO's run summaries until this case settles (no await API).
    const deadline = startedAt + budgetMs;
    for (;;) {
      if (this.cancelled) {
        this.cloud.stopRemote();
        return {
          caseId: testCase.id,
          runId,
          status: 'error',
          output: '',
          error: 'Cancelled.',
          durationMs: Date.now() - startedAt,
        };
      }
      if (Date.now() > deadline) {
        return {
          caseId: testCase.id,
          runId,
          status: 'error',
          output: '',
          error: 'Timed out waiting for the cloud run to settle.',
          durationMs: Date.now() - startedAt,
        };
      }
      const listing = await this.cloud.listRuns(workflowId);
      const summary = listing?.runs.find(row => row.id === runId);
      if (summary && summary.status !== 'running') {
        const base = {
          caseId: testCase.id,
          runId,
          durationMs: Date.now() - startedAt,
          costUsd: summary.usage.costUsd || undefined,
        };
        if (summary.status !== 'completed') {
          return {
            ...base,
            status: 'error',
            output: clip(summary.output ?? ''),
            error: summary.error ?? `Run ${summary.status}.`,
          };
        }
        return this.scoreCase(suite, testCase, summary.output ?? '', base, undefined);
      }
      await sleep(CLOUD_POLL_MS);
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  private async scoreCase(
    suite: EvalSuite,
    testCase: EvalCase,
    output: string,
    base: { caseId: string; runId: string; model?: string; durationMs: number; costUsd?: number },
    pass: EvalModelRef | undefined,
  ): Promise<EvalCaseResult> {
    this.setProgress(testCase.id, pass, 'scoring');
    let score: EvalScore;
    try {
      score = await scoreOutput(
        testCase,
        output,
        testCase.matcher === 'llm-judge' ? this.judgeOptions(suite) : undefined,
      );
    } catch (error) {
      return {
        ...base,
        status: 'error',
        output: clip(output),
        error: `Judge failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ...base,
      status: score.pass ? 'passed' : 'failed',
      output: clip(output),
      score: score.score,
      judgeReasoning: score.reasoning,
    };
  }

  /** Judge = per-suite override, else the studio's default model. */
  private judgeOptions(suite: EvalSuite) {
    return {
      client: this.transport.create(),
      judge: suite.judge ?? {
        provider: this.settings.defaultProvider(),
        model: this.settings.defaultModel(),
      },
      request: {
        ollamaBaseUrl: this.settings.ollamaBaseUrl(),
        lmstudioBaseUrl: this.settings.lmstudioBaseUrl(),
        bedrockRegion: this.settings.bedrockRegion(),
      },
    };
  }

  private workflowTimeoutMs(): number | undefined {
    const minutes = this.workflow.activeDoc()?.settings.timeoutMinutes;
    return typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : undefined;
  }

  private setProgress(
    caseId: string,
    pass: EvalModelRef | undefined,
    status: EvalCaseProgress['status'],
  ): void {
    const model = pass ? evalModelLabel(pass) : undefined;
    const key = progressKey(caseId, model);
    this.caseProgress.update(current => {
      const next = new Map(current);
      next.set(key, { caseId, model, status });
      return next;
    });
  }
}

function progressKey(caseId: string, model: string | undefined): string {
  return model ? `${caseId}@${model}` : caseId;
}

function clip(text: string): string {
  return text.length > RESULT_OUTPUT_CAP ? `${text.slice(0, RESULT_OUTPUT_CAP)}…` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
