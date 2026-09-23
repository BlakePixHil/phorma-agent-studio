import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { UIChart } from 'primeng/chart';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TextareaModule } from 'primeng/textarea';

import {
  DEFAULT_PASS_LABEL,
  caseAggregates,
  caseFlakiness,
  evalPassCounts,
  isJudgeMatcher,
  modelAggregates,
  resultModelLabel,
  suiteCostUsd,
  suiteDurationMs,
  suiteTrend,
  type EvalCase,
  type EvalCaseResult,
  type EvalMatcher,
  type EvalModelRef,
  type EvalRunSummary,
  type EvalSuite,
} from '@phorma/engine';

import { CloudService } from '../../../core/cloud.service';
import { DecisionTransportService } from '../../../core/decision-transport.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { EvalRunnerService } from '../../../core/eval-runner.service';
import { EvalService } from '../../../core/eval.service';
import { ExpandedPanelDialog } from '../../../shared/expanded-panel-dialog/expanded-panel-dialog';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { RunControllerService } from '../../../core/run-controller.service';
import { RunHistoryService } from '../../../core/run-history.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  type EmbeddedWorkflow,
  type ModelProviderId,
  type WorkflowGraph,
} from '../../../core/workflow.model';

/** Which view the main area shows. */
type EvalsView = 'cases' | 'matrix' | 'trends' | 'detail';

/** Matcher options for the case editor. */
const MATCHER_OPTIONS: { id: EvalMatcher; label: string }[] = [
  { id: 'exact', label: 'Exact match' },
  { id: 'contains', label: 'Contains' },
  { id: 'llm-judge', label: 'LLM judge' },
  { id: 'decision-judge', label: 'System One judge' },
];

/** `1 suite` / `3 suites` — subtitles read as broken without this. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One cell of the case x model matrix. */
export interface MatrixCell {
  result: EvalCaseResult | null;
}

/** One row of the case x model matrix. */
export interface MatrixRow {
  caseId: string;
  name: string;
  cells: MatrixCell[];
  passRate: number;
  meanScore: number | null;
}

/**
 * The expanded Evals panel.
 *
 * Reads the SAME {@link EvalService} / {@link EvalRunnerService} as the
 * sidebar, and spends the extra width on the things a 320px column cannot
 * show: a case x model comparison matrix with per-model aggregates, a
 * pass-rate/score/cost trend across the suite's run history, a per-case
 * flakiness ranking, and side-by-side output/expected comparison.
 *
 * All aggregation is done by the pure engine helpers in `evals-stats.ts`.
 */
@Component({
  selector: 'app-evals-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    ExpandedPanelDialog,
    FormsModule,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    SelectButtonModule,
    SelectModule,
    TextareaModule,
    UIChart,
  ],
  templateUrl: './evals-dialog.html',
  styleUrl: './evals-dialog.scss',
})
export class EvalsDialog {
  private readonly expand = inject(PanelExpandService);
  protected readonly evals = inject(EvalService);
  protected readonly runner = inject(EvalRunnerService);
  protected readonly cloud = inject(CloudService);
  private readonly workflow = inject(WorkflowService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly runController = inject(RunControllerService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  protected readonly decisionTransport = inject(DecisionTransportService);

  protected readonly visible = computed(() => this.expand.isOpen('evals'));
  protected readonly matcherOptions = MATCHER_OPTIONS;
  protected readonly defaultPassLabel = DEFAULT_PASS_LABEL;

  protected readonly viewOptions: { label: string; value: EvalsView }[] = [
    { label: 'Cases', value: 'cases' },
    { label: 'Matrix', value: 'matrix' },
    { label: 'Trends', value: 'trends' },
    { label: 'Run detail', value: 'detail' },
  ];

  protected readonly view = signal<EvalsView>('cases');

  /** The suite being edited (a working copy), or null for the list view. */
  protected readonly selectedSuite = signal<EvalSuite | null>(null);
  /** A past eval run opened in the detail view, or null. */
  protected readonly selectedRun = signal<EvalRunSummary | null>(null);
  /** Result rows expanded to show output/reasoning. */
  protected readonly expandedResults = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // Load suites when the dialog opens, and whenever the workflow changes
    // while it is open.
    effect(() => {
      if (!this.visible()) return;
      const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
      untracked(() => {
        void this.evals.refresh(workflowId);
        const suite = this.selectedSuite();
        if (suite && suite.workflowId !== workflowId) {
          this.selectedSuite.set(null);
          this.selectedRun.set(null);
        }
      });
    });

    // A finished live run becomes the run under inspection, so the matrix and
    // trends reflect what just happened without an extra click.
    effect(() => {
      const active = this.runner.activeRun();
      if (!active || active.status === 'running') return;
      untracked(() => {
        if (this.selectedSuite()?.id !== active.suiteId) return;
        this.selectedRun.set(active);
        void this.evals.refreshRuns(active.suiteId);
      });
    });
  }

  protected readonly workflowName = computed(
    () => this.workflow.activeDoc()?.name ?? 'Untitled Workflow',
  );

  protected readonly subtitle = computed(() => {
    const suite = this.selectedSuite();
    if (!suite) return `${this.workflowName()} · ${plural(this.evals.suites().length, 'suite')}`;
    return `${suite.name} · ${plural(suite.cases.length, 'case')} · ${this.workflowName()}`;
  });

  /** Cloud runs need a pushed (saved) workflow. */
  protected readonly cloudAvailable = computed(
    () => !!this.workflow.activeDoc()?.workflowId && this.cloud.configured(),
  );

  /** Provider options for judge/comparison pickers. */
  protected readonly providers = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn);
  });

  /** Sentinel-aware options: "Studio default" clears the judge override. */
  protected readonly judgeProviderOptions = computed(() => [
    { id: null as ModelProviderId | null, label: 'Studio default' },
    ...this.providers().map(p => ({ id: p.id as ModelProviderId | null, label: p.label })),
  ]);

  /** The live suite run when it belongs to the selected suite. */
  protected readonly liveRun = computed(() => {
    const active = this.runner.activeRun();
    const suite = this.selectedSuite();
    return active && suite && active.suiteId === suite.id ? active : null;
  });

  /** Live progress as a 0..100 percentage for the header progress bar. */
  protected readonly progressPercent = computed(() => {
    const { done, total } = this.runner.progress();
    return total > 0 ? Math.round((done / total) * 100) : 0;
  });

  /** True when any case uses the llm-judge matcher. */
  protected readonly usesJudge = computed(() =>
    (this.selectedSuite()?.cases ?? []).some(item => item.matcher === 'llm-judge'),
  );

  /** True when any case uses the System One judge. */
  protected readonly usesDecisionJudge = computed(() =>
    (this.selectedSuite()?.cases ?? []).some(item => item.matcher === 'decision-judge'),
  );

  /** Pass threshold as a whole percentage for the editor. */
  protected readonly decisionPassPercent = computed(() =>
    Math.round((this.selectedSuite()?.decisionJudge?.passAt ?? 0.7) * 100),
  );

  protected setDecisionPassPercent(value: number | null): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const pct = typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : 70;
    this.patchSuite({ decisionJudge: { ...suite.decisionJudge, passAt: pct / 100 } });
  }

  protected isReferenceMatcher(matcher: EvalMatcher): boolean {
    return isJudgeMatcher(matcher);
  }

  // ── Suite CRUD ──────────────────────────────────────────────────────────

  protected async createSuite(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
    const suite = await this.evals.createSuite(workflowId, 'New suite');
    this.openSuite(suite);
    this.addCase();
  }

  protected openSuite(suite: EvalSuite): void {
    this.selectedSuite.set(structuredClone(suite));
    this.selectedRun.set(null);
    this.view.set('cases');
    void this.evals.refreshRuns(suite.id);
  }

  protected closeSuite(): void {
    this.selectedSuite.set(null);
    this.selectedRun.set(null);
  }

  protected async deleteSuite(suite: EvalSuite, event: Event): Promise<void> {
    event.stopPropagation();
    const ok = await this.confirmDialog.confirm({
      title: 'Delete suite?',
      message: `"${suite.name}" and its run history will be removed.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
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

  // ── Case editing ────────────────────────────────────────────────────────

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

  protected duplicateCase(index: number): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const source = suite.cases[index];
    if (!source) return;
    const copy: EvalCase = {
      ...source,
      id: `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${source.name} (copy)`,
    };
    const cases = [...suite.cases];
    cases.splice(index + 1, 0, copy);
    this.patchSuite({ cases });
  }

  protected removeCase(index: number): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    this.patchSuite({ cases: suite.cases.filter((_, i) => i !== index) });
  }

  protected moveCase(index: number, delta: number): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const target = index + delta;
    if (target < 0 || target >= suite.cases.length) return;
    const cases = [...suite.cases];
    [cases[index], cases[target]] = [cases[target], cases[index]];
    this.patchSuite({ cases });
  }

  protected patchCase(index: number, patch: Partial<EvalCase>): void {
    const suite = this.selectedSuite();
    if (!suite) return;
    const cases = suite.cases.map((item, i) => (i === index ? { ...item, ...patch } : item));
    this.patchSuite({ cases });
  }

  /** Applies one matcher to every case in the suite. */
  protected setAllMatchers(matcher: EvalMatcher): void {
    const suite = this.selectedSuite();
    if (!suite || suite.cases.length === 0) return;
    this.patchSuite({ cases: suite.cases.map(item => ({ ...item, matcher })) });
  }

  // ── Judge + comparison models ───────────────────────────────────────────

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
        model:
          suite?.judge?.provider === provider
            ? suite.judge.model
            : (this.modelSuggestions(provider)[0] ?? ''),
      },
    });
  }

  protected setJudgeModel(model: string): void {
    const judge = this.selectedSuite()?.judge;
    if (judge) this.patchSuite({ judge: { ...judge, model } });
  }

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

  // ── Running ─────────────────────────────────────────────────────────────

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
    // Comparison passes deserve the matrix; a single pass reads better as a list.
    this.view.set((suite.models?.length ?? 0) > 1 ? 'matrix' : 'detail');
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

  // ── Run inspection ──────────────────────────────────────────────────────

  protected openRun(run: EvalRunSummary): void {
    this.selectedRun.set(run);
    this.expandedResults.set(new Set());
    this.view.set('detail');
  }

  protected async deleteEvalRun(run: EvalRunSummary, event: Event): Promise<void> {
    event.stopPropagation();
    await this.evals.deleteRun(run);
    if (this.selectedRun()?.id === run.id) this.selectedRun.set(null);
  }

  /** The run the matrix and detail views operate on (live run wins). */
  protected readonly inspectedRun = computed(() => this.liveRun() ?? this.selectedRun());

  protected passCounts(run: EvalRunSummary): { passed: number; total: number } {
    return evalPassCounts(run);
  }

  protected caseName(result: EvalCaseResult): string {
    const suite = this.selectedSuite();
    return suite?.cases.find(item => item.id === result.caseId)?.name ?? result.caseId;
  }

  protected caseNameById(caseId: string): string {
    const suite = this.selectedSuite();
    return suite?.cases.find(item => item.id === caseId)?.name ?? caseId;
  }

  protected expectedFor(caseId: string): string {
    return this.selectedSuite()?.cases.find(item => item.id === caseId)?.expected ?? '';
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

  protected resultIcon(status: EvalCaseResult['status'] | null): string {
    switch (status) {
      case 'passed':
        return 'ti ti-circle-check';
      case 'failed':
        return 'ti ti-circle-x';
      case 'error':
        return 'ti ti-alert-triangle';
      default:
        return 'ti ti-minus';
    }
  }

  /** Opens the underlying run record on the canvas ("Bring to Canvas"). */
  protected async openCaseRun(result: EvalCaseResult, event: Event): Promise<void> {
    event.stopPropagation();
    const run = this.inspectedRun();
    if (!run || !result.runId) return;
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
      `${this.caseName(result)} — eval run`,
      record.subWorkflows as unknown as Record<string, EmbeddedWorkflow> | undefined,
    );
    this.runController.loadHistoricalRun(record);
    // The canvas is behind the dialog, so get out of the way.
    this.expand.close();
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

  // ── Matrix ──────────────────────────────────────────────────────────────

  /** Per-model column footers for the inspected run. */
  protected readonly modelColumns = computed(() => {
    const run = this.inspectedRun();
    return run ? modelAggregates(run) : [];
  });

  /** Case x model grid for the inspected run, in suite case order. */
  protected readonly matrixRows = computed<MatrixRow[]>(() => {
    const run = this.inspectedRun();
    if (!run) return [];
    const columns = this.modelColumns().map(column => column.model);
    const rowStats = new Map(caseAggregates(run).map(row => [row.caseId, row]));

    // Index results by case + pass so lookups stay O(1) per cell.
    const byKey = new Map<string, EvalCaseResult>();
    for (const result of run.results) {
      byKey.set(`${result.caseId}\u0000${resultModelLabel(result)}`, result);
    }

    // Suite order first (the user's mental model), then any case that only
    // exists in the run (renamed or deleted since).
    const caseIds = [
      ...(this.selectedSuite()?.cases.map(item => item.id) ?? []),
      ...run.results.map(result => result.caseId),
    ].filter((id, index, all) => all.indexOf(id) === index);

    return caseIds
      .filter(caseId => run.results.some(result => result.caseId === caseId))
      .map(caseId => {
        const stats = rowStats.get(caseId);
        return {
          caseId,
          name: this.caseNameById(caseId),
          cells: columns.map(model => ({
            result: byKey.get(`${caseId}\u0000${model}`) ?? null,
          })),
          passRate: stats?.passRate ?? 0,
          meanScore: stats?.meanScore ?? null,
        };
      });
  });

  /** Whether the matrix is worth showing (more than one comparison pass). */
  protected readonly hasMatrix = computed(() => this.modelColumns().length > 0);

  protected shortModel(label: string): string {
    // "openai:gpt-4o-2024-08-06" reads better as "gpt-4o-2024-08-06".
    const [, ...rest] = label.split(':');
    return rest.length > 0 ? rest.join(':') : label;
  }

  protected providerOf(label: string): string {
    const [provider, ...rest] = label.split(':');
    return rest.length > 0 ? provider : '';
  }

  // ── Trends ──────────────────────────────────────────────────────────────

  /** Pass-rate / score / cost trend across the selected suite's history. */
  protected readonly trend = computed(() => suiteTrend(this.evals.runs()));

  protected readonly hasTrend = computed(() => this.trend().length > 0);

  protected readonly trendData = computed(() => {
    const points = this.trend();
    // Suites are often run several times an hour, so a date-only label repeats
    // and tells the reader nothing. Add the clock time whenever two points
    // share a calendar day.
    const days = points.map(point => new Date(point.startedAt).toDateString());
    const sameDayRepeats = new Set(days).size < days.length;
    return {
      labels: points.map(point =>
        new Date(point.startedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(sameDayRepeats ? { hour: '2-digit', minute: '2-digit' } : {}),
        }),
      ),
      datasets: [
        {
          type: 'line' as const,
          label: 'Pass rate %',
          data: points.map(point => Math.round(point.passRate * 100)),
          borderColor: '#34d399',
          backgroundColor: 'rgba(52, 211, 153, 0.15)',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.25,
          yAxisID: 'percent',
          fill: true,
        },
        {
          type: 'line' as const,
          label: 'Mean score %',
          data: points.map(point =>
            point.meanScore === null ? null : Math.round(point.meanScore * 100),
          ),
          borderColor: '#818cf8',
          borderWidth: 2,
          borderDash: [4, 3],
          pointRadius: 2,
          tension: 0.25,
          yAxisID: 'percent',
          spanGaps: true,
        },
        {
          type: 'bar' as const,
          label: 'Cost USD',
          data: points.map(point => Number((point.costUsd ?? 0).toFixed(4))),
          backgroundColor: 'rgba(251, 191, 36, 0.5)',
          borderRadius: 3,
          yAxisID: 'usd',
        },
      ],
    };
  });

  /**
   * Chart options are a computed, not a static field: the cost axis ceiling
   * depends on the loaded run history, which is empty at construction time.
   */
  protected readonly trendOptions = computed(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
    },
    scales: {
      x: {
        ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 0 },
        grid: { display: false },
      },
      percent: {
        position: 'left' as const,
        min: 0,
        max: 100,
        ticks: { color: '#34d399', font: { size: 9 }, callback: (value: unknown) => `${value}%` },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
      usd: {
        position: 'right' as const,
        beginAtZero: true,
        // Cost bars would otherwise scale to fill the plot and bury the
        // pass-rate line, which is the primary signal here. Capping the bar
        // axis well above the largest value keeps them a low band at the bottom.
        max: this.trendCostCeiling(),
        ticks: { color: '#fbbf24', font: { size: 9 } },
        grid: { display: false },
      },
    },
  }));

  /** Upper bound for the cost axis, or undefined when nothing reported cost. */
  private trendCostCeiling(): number | undefined {
    const max = Math.max(0, ...this.trend().map(point => point.costUsd ?? 0));
    return max > 0 ? max * 4 : undefined;
  }

  /** Per-case stability across the suite's run history, flakiest first. */
  protected readonly flakiness = computed(() => caseFlakiness(this.evals.runs()));

  // ── Run summary stats ───────────────────────────────────────────────────

  protected readonly runDuration = computed(() => {
    const run = this.inspectedRun();
    return run ? suiteDurationMs(run) : null;
  });

  protected readonly runCost = computed(() => {
    const run = this.inspectedRun();
    return run ? suiteCostUsd(run) : null;
  });
}
