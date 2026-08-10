import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';

import {
  evalPassCounts,
  type EvalCase,
  type EvalCaseResult,
  type EvalMatcher,
  type EvalModelRef,
  type EvalRunSummary,
  type EvalSuite,
} from '@phorma/engine';

import { CloudService } from '../../../core/cloud.service';
import { EvalRunnerService } from '../../../core/eval-runner.service';
import { EvalService } from '../../../core/eval.service';
import { PanelCard } from '../../../shared/panel-card/panel-card';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { PanelRegistryService } from '../../../core/panel-registry.service';
import { RunControllerService } from '../../../core/run-controller.service';
import { RunHistoryService } from '../../../core/run-history.service';
import { WorkflowService } from '../../../core/workflow.service';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  type EmbeddedWorkflow,
  type ModelProviderId,
  type WorkflowGraph,
} from '../../../core/workflow.model';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { ToastService } from '../../../shared/toast/toast.service';

/** Matcher options for the case editor. */
const MATCHER_OPTIONS: { id: EvalMatcher; label: string }[] = [
  { id: 'exact', label: 'Exact match' },
  { id: 'contains', label: 'Contains' },
  { id: 'llm-judge', label: 'LLM judge' },
];

/**
 * The Evals panel (EPIC 4): test suites for the active workflow. Users
 * define cases (input + expectation + matcher), run the suite locally or
 * against the deployed cloud workflow, and inspect scored results — each
 * case links to its full run record ("Bring to Canvas").
 */
@Component({
  selector: 'app-evals-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    ButtonModule,
    InputTextModule,
    PanelCard,
    SelectModule,
    TextareaModule,
  ],
  templateUrl: './evals-panel.html',
  styleUrl: './evals-panel.scss',
})
export class EvalsPanel {
  protected readonly evals = inject(EvalService);
  protected readonly runner = inject(EvalRunnerService);
  protected readonly cloud = inject(CloudService);
  private readonly workflow = inject(WorkflowService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly runController = inject(RunControllerService);
  private readonly panels = inject(PanelRegistryService);
  private readonly panelExpand = inject(PanelExpandService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly toast = inject(ToastService);

  protected readonly matcherOptions = MATCHER_OPTIONS;

  /** Opens the expanded evals dialog (matrix, trends, flakiness). */
  protected expand(): void {
    this.panelExpand.open('evals');
  }

  /** Provider options for judge/comparison pickers. */
  protected readonly providers = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn);
  });

  /** The suite being edited (a working copy), or null for the list view. */
  protected readonly selectedSuite = signal<EvalSuite | null>(null);
  /** A past eval run opened in the results view, or null. */
  protected readonly selectedRun = signal<EvalRunSummary | null>(null);
  /** Result rows expanded to show output/reasoning. */
  protected readonly expandedResults = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // Reload suites whenever the active workflow changes (and when the
    // panel becomes visible, so first open lists current data).
    effect(() => {
      const visible =
        this.panels.activeLeft() === 'evals' || this.panels.activeRight() === 'evals';
      const doc = this.workflow.activeDoc();
      if (!visible) return;
      void this.evals.refresh(doc?.workflowId ?? null);
      // Switching workflows invalidates the open suite/run.
      const suite = this.selectedSuite();
      if (suite && suite.workflowId !== (doc?.workflowId ?? null)) {
        this.selectedSuite.set(null);
        this.selectedRun.set(null);
      }
    });
  }

  protected readonly workflowName = computed(
    () => this.workflow.activeDoc()?.name ?? 'Untitled Workflow',
  );

  /** Cloud runs need a pushed (saved) workflow. */
  protected readonly cloudAvailable = computed(
    () => !!this.workflow.activeDoc()?.workflowId && this.cloud.configured(),
  );

  /** The live suite run when it belongs to the selected suite. */
  protected readonly liveRun = computed(() => {
    const active = this.runner.activeRun();
    const suite = this.selectedSuite();
    return active && suite && active.suiteId === suite.id ? active : null;
  });

  // ── Suite CRUD ─────────────────────────────────────────────────────────

  protected async createSuite(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
    const suite = await this.evals.createSuite(workflowId, 'New suite');
    this.openSuite(suite);
    this.addCase();
  }

  protected openSuite(suite: EvalSuite): void {
    this.selectedSuite.set(structuredClone(suite));
    this.selectedRun.set(null);
    void this.evals.refreshRuns(suite.id);
  }

  protected closeSuite(): void {
    this.selectedSuite.set(null);
    this.selectedRun.set(null);
  }

  protected async deleteSuite(suite: EvalSuite, event: Event): Promise<void> {
    event.stopPropagation();
    await this.evals.deleteSuite(suite);
    if (this.selectedSuite()?.id === suite.id) this.closeSuite();
  }

  /** Applies a partial update to the working copy and persists it. */
  protected patchSuite(patch: Partial<EvalSuite>): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const next = { ...suite, ...patch };
    this.selectedSuite.set(next);
    void this.evals.saveSuite(next);
  }

  // ── Case editing (immutable array patch, MCP-args pattern) ────────────

  protected addCase(): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const newCase: EvalCase = {
      id: `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `Case ${suite.cases.length + 1}`,
      input: '',
      expected: '',
      matcher: 'contains',
    };
    this.patchSuite({ cases: [...suite.cases, newCase] });
  }

  protected removeCase(index: number): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    this.patchSuite({ cases: suite.cases.filter((_, i) => i !== index) });
  }

  protected patchCase(index: number, patch: Partial<EvalCase>): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const cases = suite.cases.map((item, i) => (i === index ? { ...item, ...patch } : item));
    this.patchSuite({ cases });
  }

  // ── Judge + comparison models ──────────────────────────────────────────

  protected modelSuggestions(provider: ModelProviderId): string[] {
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  }

  protected setJudgeProvider(provider: ModelProviderId | null): void {
    if (!provider) {
      this.patchSuite({ judge: undefined });
      return;
    }
    const suite = this.selectedSuite();
    this.patchSuite({
      judge: {
        provider,
        model: suite?.judge?.provider === provider ? suite.judge.model : (this.modelSuggestions(provider)[0] ?? ''),
      },
    });
  }

  protected setJudgeModel(model: string): void {
    const judge = this.selectedSuite()?.judge;
    if (judge) this.patchSuite({ judge: { ...judge, model } });
  }

  /** Sentinel-aware options: "Studio default" clears the judge override. */
  protected readonly judgeProviderOptions = computed(() => [
    { id: null as ModelProviderId | null, label: 'Studio default' },
    ...this.providers().map(p => ({ id: p.id as ModelProviderId | null, label: p.label })),
  ]);

  protected addComparisonModel(): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const provider = this.providers()[0]?.id as ModelProviderId | undefined;
    if (!provider) return;
    const ref: EvalModelRef = { provider, model: this.modelSuggestions(provider)[0] ?? '' };
    this.patchSuite({ models: [...(suite.models ?? []), ref] });
  }

  protected removeComparisonModel(index: number): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const models = (suite.models ?? []).filter((_, i) => i !== index);
    this.patchSuite({ models: models.length > 0 ? models : undefined });
  }

  protected patchComparisonModel(index: number, patch: Partial<EvalModelRef>): void {
    const suite = this.selectedSuite();
    if (!suite?.models) return;
    const models = suite.models.map((item, i) =>
      i === index
        ? {
            ...item,
            ...patch,
            // Provider change resets the model to that provider's first suggestion.
            ...(patch.provider && patch.provider !== item.provider
              ? { model: this.modelSuggestions(patch.provider)[0] ?? '' }
              : {}),
          }
        : item,
    );
    this.patchSuite({ models });
  }

  /** True when any case uses the llm-judge matcher. */
  protected readonly usesJudge = computed(() =>
    (this.selectedSuite()?.cases ?? []).some(item => item.matcher === 'llm-judge'),
  );

  // ── Running ────────────────────────────────────────────────────────────

  protected async runSuite(environment: 'local' | 'cloud'): Promise<void> {
    const suite = this.selectedSuite();
    if (!suite || this.runner.running()) return;
    if (suite.cases.length === 0) {
      this.toast.warning('No cases', 'Add at least one test case first.');
      return;
    }
    if (suite.cases.some(item => !item.input.trim())) {
      this.toast.warning('Empty case input', 'Every case needs an input.');
      return;
    }
    this.selectedRun.set(null);
    const run = await this.runner.runSuite(suite, environment);
    if (run) {
      this.selectedRun.set(run);
      const counts = evalPassCounts(run);
      if (run.status === 'completed') {
        (counts.passed === counts.total ? this.toast.success : this.toast.warning).call(
          this.toast,
          'Suite finished',
          `${counts.passed}/${counts.total} cases passed.`,
        );
      }
    }
  }

  protected cancelRun(): void {
    this.runner.cancel();
  }

  // ── Results ────────────────────────────────────────────────────────────

  protected openRun(run: EvalRunSummary): void {
    this.selectedRun.set(run);
    this.expandedResults.set(new Set());
  }

  protected closeRun(): void {
    this.selectedRun.set(null);
  }

  protected async deleteEvalRun(run: EvalRunSummary, event: Event): Promise<void> {
    event.stopPropagation();
    await this.evals.deleteRun(run);
    if (this.selectedRun()?.id === run.id) this.selectedRun.set(null);
  }

  protected passCounts(run: EvalRunSummary): { passed: number; total: number } {
    return evalPassCounts(run);
  }

  protected caseName(run: EvalRunSummary, result: EvalCaseResult): string {
    const suite = this.selectedSuite();
    return suite?.cases.find(item => item.id === result.caseId)?.name ?? result.caseId;
  }

  protected resultKey(result: EvalCaseResult): string {
    return result.model ? `${result.caseId}@${result.model}` : result.caseId;
  }

  protected toggleResult(result: EvalCaseResult): void {
    const key = this.resultKey(result);
    this.expandedResults.update(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected isResultExpanded(result: EvalCaseResult): boolean {
    return this.expandedResults().has(this.resultKey(result));
  }

  protected resultIcon(result: EvalCaseResult): string {
    switch (result.status) {
      case 'passed':
        return 'ti ti-circle-check';
      case 'failed':
        return 'ti ti-circle-x';
      default:
        return 'ti ti-alert-triangle';
    }
  }

  /** Opens the underlying run record on the canvas ("Bring to Canvas"). */
  protected async openCaseRun(run: EvalRunSummary, result: EvalCaseResult, event: Event): Promise<void> {
    event.stopPropagation();
    if (!result.runId) return;
    const record =
      run.environment === 'local'
        ? await this.runHistory.getRun(result.runId)
        : await this.cloud.fetchRunRecord(run.workflowId ?? '', result.runId);
    if (!record) {
      this.toast.warning('Run not found', 'The case run record was pruned or is unavailable.');
      return;
    }
    this.workflow.openRunSnapshot(
      record.graph as WorkflowGraph,
      `${this.caseName(run, result)} — eval run`,
      record.subWorkflows as unknown as Record<string, EmbeddedWorkflow> | undefined,
    );
    this.runController.loadHistoricalRun(record);
  }

  protected duration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  /** Live progress status for one case (running suites only). */
  protected liveStatus(caseId: string, model?: string): string | null {
    const key = model ? `${caseId}@${model}` : caseId;
    return this.runner.caseProgress().get(key)?.status ?? null;
  }
}
