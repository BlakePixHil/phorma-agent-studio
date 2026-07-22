import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UIChart } from 'primeng/chart';
import { SelectModule } from 'primeng/select';

import { PanelRegistryService } from '../../../core/panel-registry.service';
import {
  UsageAnalyticsService,
  type UsagePeriod,
} from '../../../core/usage-analytics.service';
import { WorkflowService } from '../../../core/workflow.service';

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'month', label: 'This month' },
];

/**
 * The Usage panel (EPIC 2) — cost & usage analytics over the persisted usage
 * ledger (local IndexedDB + every deployed workflow's DO ledger).
 *
 * Display rule: Phorma Cloud-billed usage renders as plan CREDITS, never
 * dollars; BYO-key usage renders as USD, marked "(est.)" when the figure
 * came from the synced pricing table rather than provider accounting.
 */
@Component({
  selector: 'app-usage-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DecimalPipe, FormsModule, UIChart, SelectModule],
  templateUrl: './usage-panel.html',
  styleUrl: './usage-panel.scss',
})
export class UsagePanel {
  protected readonly analytics = inject(UsageAnalyticsService);
  private readonly workflow = inject(WorkflowService);
  private readonly panels = inject(PanelRegistryService);

  protected readonly periods = PERIODS;

  constructor() {
    // Refresh whenever the panel becomes the active tab on either side.
    effect(() => {
      const visible =
        this.panels.activeLeft() === 'usage' || this.panels.activeRight() === 'usage';
      if (visible) void this.analytics.refresh();
    });
  }

  /** Scope options: All workflows + the saved library + drafts bucket. */
  protected readonly scopes = computed(() => {
    const library = this.workflow.library().map(spec => ({
      id: spec.id ?? 'draft',
      label: spec.name,
    }));
    return [{ id: null as string | null, label: 'All workflows' }, ...library];
  });

  /** Bar chart data: per-day BYO USD + cloud credits (two axes). */
  protected readonly chartData = computed(() => {
    const daily = this.analytics.daily();
    return {
      labels: daily.map(point => point.day.slice(5)),
      datasets: [
        {
          label: 'Credits',
          data: daily.map(point => point.credits),
          backgroundColor: 'rgba(129, 140, 248, 0.75)',
          borderRadius: 3,
          yAxisID: 'credits',
        },
        {
          label: 'USD (BYO)',
          data: daily.map(point => Number(point.usd.toFixed(4))),
          backgroundColor: 'rgba(52, 211, 153, 0.75)',
          borderRadius: 3,
          yAxisID: 'usd',
        },
      ],
    };
  });

  protected readonly chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: {
      legend: {
        labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } },
      },
    },
    scales: {
      x: {
        ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 0 },
        grid: { display: false },
      },
      credits: {
        position: 'left' as const,
        ticks: { color: '#818cf8', font: { size: 9 } },
        grid: { color: 'rgba(107, 114, 128, 0.15)' },
        beginAtZero: true,
      },
      usd: {
        position: 'right' as const,
        ticks: { color: '#34d399', font: { size: 9 } },
        grid: { display: false },
        beginAtZero: true,
      },
    },
  };

  /** True when the chart has anything to show. */
  protected readonly hasChartData = computed(() =>
    this.analytics.daily().some(point => point.credits > 0 || point.usd > 0 || point.runs > 0),
  );

  protected onScopeChange(value: string | null): void {
    this.analytics.scope.set(value ?? null);
  }

  protected setPeriod(period: UsagePeriod): void {
    this.analytics.period.set(period);
  }
}
