import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { UIChart } from 'primeng/chart';

import { DateRangeService } from '../../core/date-range.service';
import {
  OTHER_GROUP_LABEL,
  type GroupRow,
  type TrendDay,
  type TrendResponse,
} from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { GroupTable, type GroupColumn } from '../group-table';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** The three series, and the table columns, in one order. */
const TREND_COLUMNS: readonly GroupColumn[] = [
  { key: 'installs', label: 'Installs' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'runs', label: 'Runs' },
];

/**
 * Series colours, from the same Iris ramp the theme preset uses. Literal hex
 * rather than CSS variables: chart.js paints into a canvas and cannot resolve a
 * custom property.
 */
const SERIES_COLORS = ['#8578f6', '#3fa9c9', '#e0983c'] as const;

/**
 * The trend view: per-day active installs, sessions and runs for the selected
 * range (Requirement 10.9).
 *
 * Two details are deliberate.
 *
 * **The `other` row is not plotted.** The Admin_API applies its k-anonymity floor
 * to every grouped route, and trend groups by Metric_Day, so low-traffic days are
 * folded into a single row labelled `other`. Plotting that row would put a
 * non-date on a time axis. It is excluded from the chart and reported as a
 * folded-days footnote instead, which keeps the chart a time series while the
 * numbers stay complete. The day table below the chart still lists it, so no
 * reported row is hidden.
 *
 * **Chart options are a `computed()`, never a static field.** The y-axis bound is
 * derived from the loaded series; a static field is evaluated at construction,
 * when the resource is still empty, so the bound would be computed from nothing
 * and stay wrong for the life of the component. This has bitten the studio
 * before and is a standing repo rule.
 *
 * `UIChart` sits behind `@defer (on immediate)` so chart.js (~240KB) stays out of
 * the initial bundle, the same arrangement the studio's usage panel uses.
 */
@Component({
  selector: 'admin-trend',
  imports: [UIChart, GroupTable, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-trend-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-trend-title">
          <i class="ti ti-chart-line" aria-hidden="true"></i>
          <span>Trend</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (trend(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          @if (plotDays().length > 0) {
            <article class="admin-card">
              <h3 class="admin-card__title">
                <i class="ti ti-timeline" aria-hidden="true"></i>
                <span>Per day</span>
              </h3>
              <div class="admin-chart">
                <!-- @defer keeps chart.js out of the initial bundle. -->
                @defer (on immediate) {
                  <p-chart
                    type="line"
                    height="260px"
                    [data]="chartData()"
                    [options]="chartOptions()"
                  />
                }
              </div>
            </article>
          } @else {
            <p class="admin-footnote">
              Every day in this range is below the reporting threshold, so there is nothing to plot.
            </p>
          }

          <admin-group-table
            icon="ti-calendar-stats"
            title="Days"
            labelHeading="Day"
            [rows]="dayRows()"
            [columns]="columns"
          />

          @if (data.foldedDays > 0) {
            <p class="admin-footnote" data-trend-folded>
              <i class="ti ti-eye-off" aria-hidden="true"></i>
              <span>
                {{ data.foldedDays }} day(s) below the reporting threshold are folded into the
                <code>other</code>
                row and left off the plot.
              </span>
            </p>
          }
        </div>
      } @else {
        <admin-view-state
          emptyMessage="No days in this range carry telemetry."
          [state]="state()"
          (retry)="reload()"
        />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Trend {
  private readonly api = inject(TelemetryApiService);

  readonly range = inject(DateRangeService).range;
  readonly columns = TREND_COLUMNS;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchTrend(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<TrendResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      // Guarded read: `value()` throws in the error state, so a bare read would
      // make this computed throw instead of resolving to `failed` (10.12).
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: (value) => value.days.length === 0,
    }),
  );

  readonly trend = computed(() => loadedValue(this.state()));

  /** Every reported day, in Metric_Day order, as table rows. */
  readonly dayRows = computed<GroupRow[]>(() =>
    sortedDays(this.trend()?.days ?? []).map((day) => ({
      label: day.label,
      installs: day.installs,
      sessions: day.sessions,
      runs: day.runs,
    })),
  );

  /** The plotted days: every reported day except the folded `other` row. */
  readonly plotDays = computed<TrendDay[]>(() =>
    sortedDays(this.trend()?.days ?? []).filter((day) => day.label !== OTHER_GROUP_LABEL),
  );

  readonly chartData = computed(() => {
    const days = this.plotDays();
    return {
      labels: days.map((day) => day.label),
      datasets: [
        series('Installs', days.map((day) => day.installs), SERIES_COLORS[0]),
        series('Sessions', days.map((day) => day.sessions), SERIES_COLORS[1]),
        series('Runs', days.map((day) => day.runs), SERIES_COLORS[2]),
      ],
    };
  });

  /**
   * Chart options, derived from the loaded series. A `computed()` because
   * `suggestedMax` depends on the data - see the class comment.
   */
  readonly chartOptions = computed(() => ({
    maintainAspectRatio: false,
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom' } },
    scales: {
      x: { grid: { display: false } },
      y: { beginAtZero: true, suggestedMax: this.axisMax(), ticks: { precision: 0 } },
    },
  }));

  /** A little headroom above the tallest point, and never a flat zero axis. */
  private readonly axisMax = computed(() => {
    const peak = this.plotDays().reduce(
      (max, day) => Math.max(max, day.installs, day.sessions, day.runs),
      0,
    );
    return Math.max(4, Math.ceil(peak * 1.15));
  });

  reload(): void {
    this.data.reload();
  }
}

/**
 * Days in Metric_Day order with the folded row last. Both ends of a Metric_Day
 * are zero-padded, so a lexicographic compare is a chronological one; `other` is
 * not a date, so it is pinned to the end rather than sorted among them.
 */
function sortedDays(days: readonly TrendDay[]): TrendDay[] {
  return [...days].sort((a, b) => {
    if (a.label === OTHER_GROUP_LABEL) return 1;
    if (b.label === OTHER_GROUP_LABEL) return -1;
    return a.label.localeCompare(b.label);
  });
}

function series(label: string, data: number[], color: string) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    pointBackgroundColor: color,
    pointRadius: 2,
    borderWidth: 2,
    tension: 0.3,
    fill: false,
  };
}
