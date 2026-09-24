import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import {
  K_ANONYMITY_FLOOR,
  OTHER_GROUP_LABEL,
  type GroupRow,
  type TrendDay,
  type TrendResponse,
} from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { AdminAreaChart, type AreaSeries } from '../charts/area-chart';
import { AdminBarList, type BarItem } from '../charts/bar-list';
import { AdminCalendar } from '../charts/calendar';
import { deltaOf, weekdayIndex } from '../charts/chart-math';
import type { Tone } from '../charts/tones';
import { formatRange, shortDay, whole } from '../format';
import { GroupTable, type GroupColumn } from '../group-table';
import { AdminData } from '../kit/data-disclosure';
import { AdminHint } from '../kit/hint';
import { AdminKpi } from '../kit/kpi';
import { enriched, enrichment } from '../secondary';
import { alignDays, meanOf, peakIndex, sumOf, type TrendMetric } from '../series';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

const TREND_COLUMNS: readonly GroupColumn[] = [
  { key: 'installs', label: 'Installs' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'runs', label: 'Runs' },
];

interface MetricDef {
  readonly key: TrendMetric;
  readonly label: string;
  readonly tone: Tone;
  readonly icon: string;
}

const METRICS: readonly MetricDef[] = [
  { key: 'installs', label: 'Installs', tone: 'iris', icon: 'ti-device-desktop' },
  { key: 'sessions', label: 'Sessions', tone: 'azure', icon: 'ti-player-play' },
  { key: 'runs', label: 'Runs', tone: 'amber', icon: 'ti-rocket' },
];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The heatmap needs enough days to read as a calendar. */
const CALENDAR_MIN_DAYS = 14;

/**
 * Trend: per-day installs, sessions and runs (Requirement 10.9).
 *
 * The plot is laid onto every calendar day of the range, so a folded day is a
 * visible gap in the line rather than two points silently joined. The folded
 * `other` row never reaches the plot (it is not a date) but stays in the data
 * table.
 */
@Component({
  selector: 'admin-trend',
  imports: [
    AdminAreaChart,
    AdminBarList,
    AdminCalendar,
    AdminData,
    AdminHint,
    AdminKpi,
    GroupTable,
    ViewStateRail,
  ],
  template: `
    <section class="admin-view" aria-labelledby="admin-trend-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-trend-title">
          <i class="ti ti-chart-line" aria-hidden="true"></i>
          <span>Trend</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        @if (trend(); as data) {
          @if (data.foldedDays > 0) {
            <span class="admin-chip admin-chip--muted" data-trend-folded>
              <i class="ti ti-eye-off" aria-hidden="true"></i>
              <span>{{ data.foldedDays }} day(s) folded into <code>other</code></span>
              <admin-hint [text]="foldHint" />
            </span>
          }
        }
      </header>

      @if (trend(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-kpis">
            @for (card of cards(); track card.key) {
              <admin-kpi
                [label]="card.label"
                [value]="card.value"
                [icon]="card.icon"
                [tone]="card.tone"
                [note]="card.note"
                [delta]="card.delta"
                [deltaHint]="deltaHint()"
              />
            }
          </div>

          <article class="admin-card admin-card--hero">
            <div class="admin-card__head">
              <h2 class="admin-card__title">
                <i class="ti ti-timeline" aria-hidden="true"></i>
                <span>Per day</span>
              </h2>
              <div class="admin-card__aside">
                @if (hasPrevious()) {
                  <button
                    type="button"
                    class="admin-segmented__option"
                    [class.admin-segmented__option--active]="compare()"
                    [attr.aria-pressed]="compare()"
                    (click)="compare.set(!compare())"
                  >
                    <i class="ti ti-arrows-diff" aria-hidden="true"></i>
                    Compare to previous
                  </button>
                }
              </div>
            </div>
            @if (plotDays().length > 0) {
              <div class="admin-chart">
                <admin-area-chart
                  [labels]="chart().labels"
                  [series]="chart().series"
                  [showPrevious]="compare()"
                  [height]="300"
                />
              </div>
            } @else {
              <p class="admin-empty-inline">
                <i class="ti ti-eye-off" aria-hidden="true"></i>
                <span>Every day in this range is below the reporting threshold.</span>
              </p>
            }
          </article>

          @if (showCalendar()) {
            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-calendar-stats" aria-hidden="true"></i>
                  <span>Daily rhythm</span>
                </h2>
                <div class="admin-card__aside">
                  <div class="admin-segmented" role="group" aria-label="Heatmap metric">
                    @for (metric of metrics; track metric.key) {
                      <button
                        type="button"
                        class="admin-segmented__option"
                        [class.admin-segmented__option--active]="heatMetric() === metric.key"
                        [attr.aria-pressed]="heatMetric() === metric.key"
                        (click)="heatMetric.set(metric.key)"
                      >
                        {{ metric.label }}
                      </button>
                    }
                  </div>
                </div>
              </div>
              <div class="admin-rhythm">
                <admin-calendar
                  [from]="data.range.from"
                  [to]="data.range.to"
                  [values]="heatValues()"
                  [tone]="heatTone()"
                  [unit]="heatUnit()"
                />
                <div class="admin-rhythm__weekdays">
                  <p class="admin-map-row__list-title">Average by weekday</p>
                  <admin-bar-list [items]="weekdayBars()" [tone]="heatTone()" [limit]="7" />
                </div>
              </div>
            </article>
          }

          <article class="admin-card">
            <admin-data>
              <admin-group-table
                icon="ti-calendar-stats"
                title="Days"
                labelHeading="Day"
                [rows]="dayRows()"
                [columns]="columns"
                [framed]="false"
              />
            </admin-data>
          </article>
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
  private readonly dates = inject(DateRangeService);

  readonly range = this.dates.range;
  readonly columns = TREND_COLUMNS;
  readonly metrics = METRICS;
  readonly rangeLabel = computed(() => formatRange(this.range()));
  readonly foldHint = `Days with fewer than ${K_ANONYMITY_FLOOR} reporting installs are summed into one other row for privacy. They show as gaps on the chart and are listed in the data table.`;

  readonly compare = signal(false);
  readonly heatMetric = signal<TrendMetric>('runs');

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchTrend(params).then(unwrapAdminResult),
  });

  private readonly previousData = enrichment(
    () => this.dates.previousRange(),
    (range) => this.api.fetchTrend(range),
  );

  readonly state = computed(() =>
    viewStateOf<TrendResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: (value) => value.days.length === 0,
    }),
  );

  readonly trend = computed(() => loadedValue(this.state()));
  readonly deltaHint = computed(() => `Against ${formatRange(this.dates.previousRange())}`);

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

  /** Exactly the data handed to the plot: reported days only, in order. */
  readonly chartData = computed(() => {
    const days = this.plotDays();
    return {
      labels: days.map((day) => day.label),
      datasets: METRICS.map((metric) => ({
        label: metric.label,
        data: days.map((day) => day[metric.key]),
      })),
    };
  });

  private readonly aligned = computed(() => {
    const trend = this.trend();
    return alignDays(trend?.range ?? this.range(), trend?.days ?? []);
  });
  private readonly previousAligned = computed(() => {
    const previous = enriched(this.previousData);
    return previous ? alignDays(previous.range, previous.days) : null;
  });

  readonly hasPrevious = computed(() => this.previousAligned() !== null);

  readonly chart = computed<{ labels: string[]; series: AreaSeries[] }>(() => {
    const aligned = this.aligned();
    const previous = this.previousAligned();
    return {
      labels: aligned.labels,
      series: METRICS.map((metric) => ({
        key: metric.key,
        label: metric.label,
        tone: metric.tone,
        values: aligned.byMetric[metric.key],
        previous: previous?.byMetric[metric.key],
      })),
    };
  });

  readonly cards = computed(() => {
    const aligned = this.aligned();
    const previous = this.previousAligned();
    return METRICS.map((metric) => {
      const values = aligned.byMetric[metric.key];
      const total = sumOf(values);
      const peak = peakIndex(values);
      const mean = meanOf(values);
      const parts = [`${mean === null ? '-' : whole(mean)} a day`];
      if (peak >= 0) parts.push(`peak ${shortDay(aligned.labels[peak])}`);
      return {
        key: metric.key,
        label: metric.label,
        icon: metric.icon,
        tone: metric.tone,
        value: whole(total),
        note: parts.join(' · '),
        delta: previous ? deltaOf(total, sumOf(previous.byMetric[metric.key])) : null,
      };
    });
  });

  readonly showCalendar = computed(() => this.aligned().labels.length >= CALENDAR_MIN_DAYS && this.plotDays().length > 0);

  readonly heatValues = computed(() => {
    const metric = this.heatMetric();
    return new Map(this.plotDays().map((day) => [day.label, day[metric]]));
  });
  readonly heatTone = computed<Tone>(() => METRICS.find((m) => m.key === this.heatMetric())?.tone ?? 'iris');
  readonly heatUnit = computed(() => this.heatMetric());

  /** Mean per weekday over reported days, Monday first, so a weekly rhythm is legible. */
  readonly weekdayBars = computed<BarItem[]>(() => {
    const metric = this.heatMetric();
    const sums = new Array<number>(7).fill(0);
    const counts = new Array<number>(7).fill(0);
    for (const day of this.plotDays()) {
      const index = weekdayIndex(day.label);
      sums[index] += day[metric];
      counts[index] += 1;
    }
    return WEEKDAYS.map((name, index) => {
      const mean = counts[index] > 0 ? sums[index] / counts[index] : 0;
      return { key: name, label: name, value: mean, caption: whole(mean) };
    });
  });

  reload(): void {
    this.data.reload();
  }
}

/** Metric_Day order with the folded row last. Zero-padded days compare lexically. */
function sortedDays(days: readonly TrendDay[]): TrendDay[] {
  return [...days].sort((a, b) => {
    if (a.label === OTHER_GROUP_LABEL) return 1;
    if (b.label === OTHER_GROUP_LABEL) return -1;
    return a.label.localeCompare(b.label);
  });
}
