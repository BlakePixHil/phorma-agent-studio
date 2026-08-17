import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { UIChart } from 'primeng/chart';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';

import type { UsageLedgerEntry } from '@phorma/engine';

import { ExpandedPanelDialog } from '../../../shared/expanded-panel-dialog/expanded-panel-dialog';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { SelectionService } from '../../../core/selection.service';
import { ToastService } from '../../../shared/toast/toast.service';
import {
  UsageAnalyticsService,
  type UsagePeriod,
} from '../../../core/usage-analytics.service';
import { WorkflowService } from '../../../core/workflow.service';

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: '1y', label: '1y' },
  { id: 'all', label: 'All' },
  { id: 'month', label: 'Month' },
];

/** Palette for categorical charts (doughnuts, per-model series). */
const SERIES_COLORS = [
  '#818cf8',
  '#34d399',
  '#fbbf24',
  '#38bdf8',
  '#f472b6',
  '#a78bfa',
  '#fb923c',
  '#4ade80',
];

/** Number of duration histogram buckets. */
const HISTOGRAM_BUCKETS = 12;

/** Rows the ledger table can sort by. */
type LedgerSort = 'started' | 'cost' | 'duration' | 'tokens';

/**
 * The expanded Usage panel.
 *
 * Reads the SAME {@link UsageAnalyticsService} as the sidebar, and spends the
 * extra width on data the ledger already records but the narrow panel never
 * shows: cost per node, per trigger source, local vs cloud, the input/output
 * token split, run durations, and a filterable per-run ledger.
 *
 * Display rule (unchanged): the Phorma Cloud share renders as plan CREDITS,
 * never dollars; only the BYO share is USD.
 */
@Component({
  selector: 'app-usage-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    ExpandedPanelDialog,
    FormsModule,
    ButtonModule,
    SelectButtonModule,
    SelectModule,
    UIChart,
  ],
  templateUrl: './usage-dialog.html',
  styleUrl: './usage-dialog.scss',
})
export class UsageDialog {
  private readonly expand = inject(PanelExpandService);
  protected readonly analytics = inject(UsageAnalyticsService);
  private readonly workflow = inject(WorkflowService);
  private readonly selection = inject(SelectionService);
  private readonly toast = inject(ToastService);

  protected readonly visible = computed(() => this.expand.isOpen('usage'));
  protected readonly periods = PERIODS;

  constructor() {
    effect(() => {
      if (!this.visible()) return;
      untracked(() => void this.analytics.refresh());
    });

    // Widening the period may need rows the last cloud fetch did not ask for.
    effect(() => {
      const period = this.analytics.period();
      if (!this.visible()) return;
      untracked(() => {
        if (period === '1y' || period === 'all') void this.analytics.refresh();
      });
    });
  }

  protected readonly subtitle = computed(() => {
    const runs = this.analytics.totals().runs;
    const scope = this.scopes().find(entry => entry.id === this.analytics.scope());
    return `${scope?.label ?? 'All workflows'} · ${runs} ${runs === 1 ? 'run' : 'runs'}`;
  });

  /** Scope options: All workflows + the saved library + drafts bucket. */
  protected readonly scopes = computed(() => {
    const library = this.workflow.library().map(spec => ({
      id: spec.id ?? 'draft',
      label: spec.name,
    }));
    return [{ id: null as string | null, label: 'All workflows' }, ...library];
  });

  protected onScopeChange(value: string | null): void {
    this.analytics.scope.set(value ?? null);
  }

  protected setPeriod(period: UsagePeriod): void {
    this.analytics.period.set(period);
  }

  protected toggleFacet(facet: 'sources' | 'statuses' | 'environments', value: string): void {
    this.analytics.toggleFacet(facet, value);
  }

  protected facetActive(facet: 'sources' | 'statuses' | 'environments', value: string): boolean {
    const set = this.analytics[facet]() as ReadonlySet<string>;
    return set.has(value);
  }

  // ── Derived stats ───────────────────────────────────────────────────────

  protected readonly totalTokens = computed(() => {
    const totals = this.analytics.totals();
    return totals.inputTokens + totals.outputTokens;
  });

  protected readonly hasData = computed(() => this.analytics.entries().length > 0);

  // ── Chart 1: daily credits + USD + runs ─────────────────────────────────

  protected readonly dailyData = computed(() => {
    const daily = this.analytics.daily();
    return {
      labels: daily.map(point => point.day.slice(5)),
      datasets: [
        {
          type: 'bar' as const,
          label: 'Credits',
          data: daily.map(point => point.credits),
          backgroundColor: 'rgba(129, 140, 248, 0.75)',
          borderRadius: 3,
          yAxisID: 'credits',
        },
        {
          type: 'bar' as const,
          label: 'USD (BYO)',
          data: daily.map(point => Number(point.usd.toFixed(4))),
          backgroundColor: 'rgba(52, 211, 153, 0.75)',
          borderRadius: 3,
          yAxisID: 'usd',
        },
        {
          type: 'line' as const,
          label: 'Runs',
          data: daily.map(point => point.runs),
          borderColor: '#fbbf24',
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
          yAxisID: 'runs',
        },
      ],
    };
  });

  protected readonly dailyOptions = {
    ...this.baseOptions(),
    scales: {
      x: this.categoryAxis(),
      credits: {
        position: 'left' as const,
        beginAtZero: true,
        ticks: { color: '#818cf8', font: { size: 9 } },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
      usd: {
        position: 'right' as const,
        beginAtZero: true,
        ticks: { color: '#34d399', font: { size: 9 } },
        grid: { display: false },
      },
      runs: { display: false, beginAtZero: true },
    },
  };

  // ── Chart 2: cost by node ───────────────────────────────────────────────

  /** Top 12 nodes by cost - beyond that the bars are unreadable. */
  protected readonly topNodes = computed(() => this.analytics.byNode().slice(0, 12));

  protected readonly nodeData = computed(() => {
    const nodes = this.topNodes();
    return {
      labels: nodes.map(row => this.nodeLabel(row.nodeId)),
      datasets: [
        {
          label: 'Cost (USD equivalent)',
          data: nodes.map(row => Number(this.usdEquivalent(row.usd, row.credits).toFixed(4))),
          backgroundColor: nodes.map((_, index) => SERIES_COLORS[index % SERIES_COLORS.length]),
          borderRadius: 3,
        },
      ],
    };
  });

  protected readonly nodeOptions = {
    ...this.baseOptions(),
    indexAxis: 'y' as const,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        beginAtZero: true,
        ticks: { color: '#6b7280', font: { size: 9 } },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
      y: {
        ticks: { color: '#9ca3af', font: { size: 9 } },
        grid: { display: false },
      },
    },
  };

  /**
   * Human label for a node id, resolved against the active graph.
   *
   * The ledger outlives the graph (366 days of history vs. whatever is on the
   * canvas now), so historic rows routinely reference deleted nodes. Showing a
   * raw `node-ms4b…` id reads as a rendering bug, so unresolved nodes get an
   * explicit "(deleted)" label with a short id for traceability.
   */
  protected nodeLabel(nodeId: string): string {
    const node = this.workflow.graph().nodes.find(candidate => candidate.id === nodeId);
    if (node) return node.name;
    return `Deleted node · ${nodeId.slice(-6)}`;
  }

  /** Whether a node row still resolves to a node on the current canvas. */
  protected nodeExists(nodeId: string): boolean {
    return this.workflow.graph().nodes.some(node => node.id === nodeId);
  }

  /** Selects a node on the canvas from a chart click / table row. */
  protected selectNode(nodeId: string): void {
    const exists = this.workflow.graph().nodes.some(node => node.id === nodeId);
    if (!exists) {
      this.toast.warning('Node not on this canvas', 'It belongs to another workflow or was deleted.');
      return;
    }
    this.selection.selectNode(nodeId);
    this.expand.close();
  }

  // ── Chart 3: cost by model (doughnut) ───────────────────────────────────

  protected readonly modelShareData = computed(() => {
    const rows = this.analytics.byModel().slice(0, 8);
    return {
      labels: rows.map(row => `${row.provider}:${row.model}`),
      datasets: [
        {
          data: rows.map(row => Number(this.usdEquivalent(row.usd, row.credits).toFixed(4))),
          backgroundColor: rows.map((_, index) => SERIES_COLORS[index % SERIES_COLORS.length]),
          borderWidth: 0,
        },
      ],
    };
  });

  protected readonly doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: { color: '#9ca3af', boxWidth: 10, font: { size: 9 } },
      },
    },
  };

  // ── Chart 4: per-model daily trend ──────────────────────────────────────

  protected readonly modelTrendData = computed(() => {
    const series = this.analytics.dailyByModel();
    // Only the costliest few models, otherwise the chart is spaghetti.
    const topModels = this.analytics
      .byModel()
      .slice(0, 5)
      .map(row => `${row.provider}:${row.model}`);
    const days = this.analytics.daily().map(point => point.day);
    return {
      labels: days.map(day => day.slice(5)),
      datasets: topModels
        .filter(key => series.has(key))
        .map((key, index) => ({
          label: key.split(':').slice(1).join(':') || key,
          data: (series.get(key) ?? []).map(point => Number(point.costUsd.toFixed(4))),
          borderColor: SERIES_COLORS[index % SERIES_COLORS.length],
          backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
        })),
    };
  });

  protected readonly lineOptions = {
    ...this.baseOptions(),
    scales: {
      x: this.categoryAxis(),
      y: {
        beginAtZero: true,
        ticks: { color: '#6b7280', font: { size: 9 } },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
    },
  };

  // ── Chart 5 + 6: source / environment doughnuts ─────────────────────────

  protected readonly sourceData = computed(() => this.groupDoughnut(this.analytics.bySource()));
  protected readonly environmentData = computed(() =>
    this.groupDoughnut(this.analytics.byEnvironment()),
  );

  private groupDoughnut(rows: readonly { key: string; usd: number | null; credits: number | null }[]) {
    return {
      labels: rows.map(row => row.key),
      datasets: [
        {
          data: rows.map(row => Number(this.usdEquivalent(row.usd, row.credits).toFixed(4))),
          backgroundColor: rows.map((_, index) => SERIES_COLORS[index % SERIES_COLORS.length]),
          borderWidth: 0,
        },
      ],
    };
  }

  // ── Chart 7: duration histogram ─────────────────────────────────────────

  protected readonly durationData = computed(() => {
    const values = this.analytics.durations().values;
    if (values.length === 0) return { labels: [], datasets: [] };
    const max = Math.max(...values);
    const width = Math.max(max / HISTOGRAM_BUCKETS, 1);
    const buckets = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
    for (const value of values) {
      // The maximum value would land one past the last bucket.
      const index = Math.min(Math.floor(value / width), HISTOGRAM_BUCKETS - 1);
      buckets[index] += 1;
    }
    return {
      labels: buckets.map((_, index) => this.shortDuration(index * width)),
      datasets: [
        {
          label: 'Runs',
          data: buckets,
          backgroundColor: 'rgba(56, 189, 248, 0.7)',
          borderRadius: 3,
        },
      ],
    };
  });

  protected readonly histogramOptions = {
    ...this.baseOptions(),
    plugins: { legend: { display: false } },
    scales: {
      x: this.categoryAxis(),
      y: {
        beginAtZero: true,
        ticks: { color: '#6b7280', font: { size: 9 }, precision: 0 },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
    },
  };

  // ── Chart 8: token mix ──────────────────────────────────────────────────

  protected readonly tokenMixData = computed(() => {
    const days = this.analytics.daily().map(point => point.day);
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const input = new Array<number>(days.length).fill(0);
    const output = new Array<number>(days.length).fill(0);
    for (const entry of this.analytics.entries()) {
      const index = dayIndex.get(this.dayKeyOf(entry));
      if (index === undefined) continue;
      input[index] += entry.usage.inputTokens;
      output[index] += entry.usage.outputTokens;
    }
    return {
      labels: days.map(day => day.slice(5)),
      datasets: [
        {
          label: 'Input tokens',
          data: input,
          backgroundColor: 'rgba(56, 189, 248, 0.7)',
          borderRadius: 3,
          stack: 'tokens',
        },
        {
          label: 'Output tokens',
          data: output,
          backgroundColor: 'rgba(244, 114, 182, 0.7)',
          borderRadius: 3,
          stack: 'tokens',
        },
      ],
    };
  });

  protected readonly stackedOptions = {
    ...this.baseOptions(),
    scales: {
      x: { ...this.categoryAxis(), stacked: true },
      y: {
        stacked: true,
        beginAtZero: true,
        ticks: { color: '#6b7280', font: { size: 9 } },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
      },
    },
  };

  // ── Run ledger ──────────────────────────────────────────────────────────

  protected readonly ledgerSort = signal<LedgerSort>('started');
  protected readonly ledgerPage = signal(0);
  protected readonly pageSize = 25;

  protected readonly sortedLedger = computed<UsageLedgerEntry[]>(() => {
    const entries = [...this.analytics.entries()];
    switch (this.ledgerSort()) {
      case 'cost':
        return entries.sort((a, b) => b.usage.costUsd - a.usage.costUsd);
      case 'duration':
        return entries.sort((a, b) => this.durationOf(b) - this.durationOf(a));
      case 'tokens':
        return entries.sort(
          (a, b) =>
            b.usage.inputTokens + b.usage.outputTokens - (a.usage.inputTokens + a.usage.outputTokens),
        );
      default:
        return entries.sort((a, b) => b.startedAt - a.startedAt);
    }
  });

  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.sortedLedger().length / this.pageSize)),
  );

  protected readonly ledgerPageRows = computed(() => {
    // Filters can shrink the ledger under the current page.
    const page = Math.min(this.ledgerPage(), this.pageCount() - 1);
    const start = page * this.pageSize;
    return this.sortedLedger().slice(start, start + this.pageSize);
  });

  protected setSort(sort: LedgerSort): void {
    this.ledgerSort.set(sort);
    this.ledgerPage.set(0);
  }

  protected pageBy(delta: number): void {
    this.ledgerPage.update(page => Math.min(Math.max(page + delta, 0), this.pageCount() - 1));
  }

  protected durationOf(entry: UsageLedgerEntry): number {
    return entry.endedAt ? Math.max(entry.endedAt - entry.startedAt, 0) : 0;
  }

  /** Downloads the filtered ledger as CSV. */
  protected exportCsv(): void {
    const rows = this.sortedLedger();
    if (rows.length === 0) {
      this.toast.warning('Nothing to export', 'No runs match the current filters.');
      return;
    }
    const header = [
      'runId',
      'startedAt',
      'workflow',
      'source',
      'status',
      'environment',
      'inputTokens',
      'outputTokens',
      'costUsd',
      'phormaCloudCostUsd',
      'estimated',
      'durationMs',
    ];
    const lines = [header.join(',')];
    for (const entry of rows) {
      lines.push(
        [
          entry.runId,
          new Date(entry.startedAt).toISOString(),
          csvCell(entry.workflowName),
          entry.source,
          entry.status,
          entry.environment,
          entry.usage.inputTokens,
          entry.usage.outputTokens,
          entry.usage.costUsd,
          entry.usage.phormaCloudCostUsd ?? 0,
          entry.usage.estimated ? 'true' : 'false',
          this.durationOf(entry),
        ].join(','),
      );
    }
    downloadBlob(
      new Blob([lines.join('\n')], { type: 'text/csv' }),
      `phorma-usage-${new Date().toISOString().slice(0, 10)}.csv`,
    );
    this.toast.success('Exported', `${rows.length} runs written to CSV.`);
  }

  // ── Formatting helpers ──────────────────────────────────────────────────

  /**
   * A single comparable magnitude for ranking and charting mixed BYO/cloud
   * rows. Credits are converted back through the plan rate; this is a chart
   * axis, never a figure we present as dollars owed.
   */
  private usdEquivalent(usd: number | null, credits: number | null): number {
    const rate = Math.max(this.analytics.creditsPerUsd(), 1);
    return (usd ?? 0) + (credits ?? 0) / rate;
  }

  protected shortDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  private dayKeyOf(entry: UsageLedgerEntry): string {
    const date = new Date(entry.startedAt);
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  protected statusIcon(status: string): string {
    switch (status) {
      case 'completed':
        return 'ti ti-circle-check';
      case 'failed':
        return 'ti ti-circle-x';
      case 'stopped':
        return 'ti ti-player-stop';
      case 'skipped':
        return 'ti ti-circle-minus';
      case 'running':
        return 'ti ti-loader-2';
      default:
        return 'ti ti-loader-2';
    }
  }

  private baseOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: { labels: { color: '#9ca3af', boxWidth: 10, font: { size: 9 } } },
      },
    };
  }

  private categoryAxis() {
    return {
      ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 0, autoSkip: true },
      grid: { display: false },
    };
  }
}

/** Quotes a CSV cell when it contains a delimiter, quote or newline. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Triggers a file download for a blob.
 *
 * Revocation is deferred to a macrotask: revoking synchronously after `click()`
 * can invalidate the URL before the browser has started reading it, which
 * yields an empty or failed download in some engines.
 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
