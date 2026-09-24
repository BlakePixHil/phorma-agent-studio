import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DateRangeService } from '../../core/date-range.service';
import type { SummaryResponse } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { AdminAreaChart, type AreaSeries } from '../charts/area-chart';
import { deltaOf, shareOf, type DeltaReading } from '../charts/chart-math';
import { AdminRing } from '../charts/ring';
import type { Tone } from '../charts/tones';
import { compact, completionRate, formatRange, percent, ratio, whole } from '../format';
import { AdminHint } from '../kit/hint';
import { AdminKpi } from '../kit/kpi';
import { enriched, enrichment } from '../secondary';
import { alignDays, type TrendMetric } from '../series';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** One headline number on the overview. */
export interface StatCard {
  label: string;
  value: string;
  icon: string;
  tone: Tone;
  note: string | null;
  hint: string | null;
  delta: DeltaReading | null;
  invert: boolean;
  spark: readonly (number | null)[] | null;
}

/** The overview hint that replaced the anonymity footnote. */
export const OVERVIEW_PRIVACY_HINT =
  'Counts are anonymous per-install rollups. No install identifier leaves the API.';

const PULSE_HINT =
  'Distinct installs active in the trailing 1, 7 and 30 days, measured back from today. The date picker does not move these.';

/**
 * Overview: the range at a glance (Requirement 10.5).
 *
 * The summary for the selected range is the view's one required request, so it
 * alone decides loading, empty and failed. The previous-period summary and the
 * per-day trend are enrichments: they add deltas and sparklines and never fail
 * the view.
 */
@Component({
  selector: 'admin-overview',
  imports: [AdminAreaChart, AdminHint, AdminKpi, AdminRing, RouterLink, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-overview-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-overview-title">
          <i class="ti ti-gauge" aria-hidden="true"></i>
          <span>Overview</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        <admin-hint [text]="privacyHint" icon="ti-shield-lock" />
      </header>

      @if (summary(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-kpis">
            @for (card of totalCards(); track card.label) {
              <admin-kpi
                [label]="card.label"
                [value]="card.value"
                [icon]="card.icon"
                [tone]="card.tone"
                [note]="card.note"
                [hint]="card.hint"
                [delta]="card.delta"
                [deltaHint]="deltaHint()"
                [invert]="card.invert"
                [spark]="card.spark"
              />
            }
          </div>

          <div class="admin-split admin-split--stretch">
            <article class="admin-card admin-card--hero">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-activity" aria-hidden="true"></i>
                  <span>Activity</span>
                </h2>
                <div class="admin-card__aside">
                  <a class="admin-link-button" routerLink="/trend">
                    <span>Open trend</span>
                    <i class="ti ti-arrow-right" aria-hidden="true"></i>
                  </a>
                </div>
              </div>
              @if (activity(); as chart) {
                <admin-area-chart [labels]="chart.labels" [series]="chart.series" [height]="240" />
              } @else {
                <p class="admin-empty-inline">
                  <i class="ti ti-chart-area-line" aria-hidden="true"></i>
                  <span>Per-day activity is not available for this range.</span>
                </p>
              }
            </article>

            <div class="admin-stack-col">
              <article class="admin-card">
                <div class="admin-card__head">
                  <h2 class="admin-card__title">
                    <i class="ti ti-heartbeat" aria-hidden="true"></i>
                    <span>Pulse</span>
                  </h2>
                  <admin-hint [text]="pulseHint" />
                </div>
                <div class="admin-figures">
                  @for (card of activeCards(); track card.label) {
                    <div class="admin-figure admin-stat">
                      <span class="admin-figure__label admin-stat__label"><span>{{ card.label }}</span></span>
                      <span class="admin-figure__value admin-stat__value">{{ card.value }}</span>
                      <span class="admin-stat__note admin-sr">{{ card.note }}</span>
                    </div>
                  }
                </div>
                <hr class="admin-divider" />
                <div class="admin-ring-row">
                  <div class="admin-ring-pair">
                    <admin-ring [value]="stickiness().daily" tone="emerald" caption="DAU / MAU" [small]="true" />
                    <div class="admin-ring-pair__text">
                      <span class="admin-ring-pair__title">Daily stickiness</span>
                      <span class="admin-ring-pair__note">of monthly installs came back today</span>
                    </div>
                  </div>
                  <div class="admin-ring-pair">
                    <admin-ring [value]="stickiness().weekly" tone="azure" caption="WAU / MAU" [small]="true" />
                    <div class="admin-ring-pair__text">
                      <span class="admin-ring-pair__title">Weekly stickiness</span>
                      <span class="admin-ring-pair__note">of monthly installs were active this week</span>
                    </div>
                  </div>
                </div>
              </article>

              <article class="admin-card">
                <div class="admin-card__head">
                  <h2 class="admin-card__title">
                    <i class="ti ti-bolt" aria-hidden="true"></i>
                    <span>Engagement</span>
                  </h2>
                </div>
                <div class="admin-figures">
                  <div class="admin-figure">
                    <span class="admin-figure__label">Sessions / install</span>
                    <span class="admin-figure__value">{{ engagement().sessionsPerInstall }}</span>
                  </div>
                  <div class="admin-figure">
                    <span class="admin-figure__label">Runs / session</span>
                    <span class="admin-figure__value">{{ engagement().runsPerSession }}</span>
                  </div>
                  <div class="admin-figure">
                    <span class="admin-figure__label">Runs / install</span>
                    <span class="admin-figure__value">{{ engagement().runsPerInstall }}</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>
      } @else {
        <admin-view-state [state]="state()" (retry)="reload()" />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Overview {
  private readonly api = inject(TelemetryApiService);
  private readonly dates = inject(DateRangeService);

  readonly range = this.dates.range;
  readonly privacyHint = OVERVIEW_PRIVACY_HINT;
  readonly pulseHint = PULSE_HINT;
  readonly rangeLabel = computed(() => formatRange(this.range()));

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchSummary(params).then(unwrapAdminResult),
  });

  private readonly previousData = enrichment(
    () => this.dates.previousRange(),
    (range) => this.api.fetchSummary(range),
  );

  private readonly trendData = enrichment(
    () => this.range(),
    (range) => this.api.fetchTrend(range),
  );

  readonly state = computed(() =>
    viewStateOf<SummaryResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      // Guarded read: `value()` throws in the error state (10.12).
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isSummaryEmpty,
    }),
  );

  readonly summary = computed(() => loadedValue(this.state()));
  readonly previous = computed(() => enriched(this.previousData));

  readonly deltaHint = computed(() => `Against ${formatRange(this.dates.previousRange())}`);

  /** Per-day series aligned to the range, or null when trend is unavailable. */
  private readonly series = computed(() => {
    const trend = enriched(this.trendData);
    if (!trend || trend.days.length === 0) return null;
    return alignDays(trend.range, trend.days);
  });

  readonly activity = computed<{ labels: string[]; series: AreaSeries[] } | null>(() => {
    const series = this.series();
    if (!series || series.labels.length < 2) return null;
    const line = (key: TrendMetric, label: string, tone: Tone): AreaSeries => ({
      key,
      label,
      tone,
      values: series.byMetric[key],
    });
    return {
      labels: series.labels,
      series: [line('installs', 'Installs', 'iris'), line('sessions', 'Sessions', 'azure'), line('runs', 'Runs', 'amber')],
    };
  });

  readonly activeCards = computed(() => {
    const active = this.summary()?.activeInstalls;
    if (!active) return [];
    return [
      { label: 'Last 24 hours', value: whole(active.d1), note: 'Trailing 1 day' },
      { label: 'Last 7 days', value: whole(active.d7), note: 'Trailing 7 days' },
      { label: 'Last 30 days', value: whole(active.d30), note: 'Trailing 30 days' },
    ];
  });

  readonly stickiness = computed(() => {
    const active = this.summary()?.activeInstalls;
    if (!active || active.d30 === 0) return { daily: null, weekly: null };
    return { daily: shareOf(active.d1, active.d30), weekly: shareOf(active.d7, active.d30) };
  });

  readonly engagement = computed(() => {
    const totals = this.summary()?.totals;
    if (!totals) return { sessionsPerInstall: '-', runsPerSession: '-', runsPerInstall: '-' };
    return {
      sessionsPerInstall: ratio(totals.sessions, totals.installs),
      runsPerSession: ratio(totals.runs, totals.sessions),
      runsPerInstall: ratio(totals.runs, totals.installs),
    };
  });

  readonly totalCards = computed<StatCard[]>(() => {
    const totals = this.summary()?.totals;
    if (!totals) return [];
    const prev = this.previous()?.totals;
    const series = this.series();
    const success = completionRate(totals.runsCompleted, totals.runs);
    const prevSuccess = prev ? completionRate(prev.runsCompleted, prev.runs) : null;
    return [
      {
        label: 'Installs',
        value: whole(totals.installs),
        icon: 'ti-device-desktop',
        tone: 'iris',
        note: null,
        hint: 'Distinct installs that reported in this range.',
        delta: deltaOf(totals.installs, prev?.installs),
        invert: false,
        spark: series?.byMetric.installs ?? null,
      },
      {
        label: 'Sessions',
        value: compact(totals.sessions),
        icon: 'ti-player-play',
        tone: 'azure',
        note: null,
        hint: 'Sessions started in this range.',
        delta: deltaOf(totals.sessions, prev?.sessions),
        invert: false,
        spark: series?.byMetric.sessions ?? null,
      },
      {
        label: 'Runs',
        value: compact(totals.runs),
        icon: 'ti-rocket',
        tone: 'amber',
        note: `${whole(totals.runsCompleted)} completed`,
        hint: 'Workflow runs started in this range.',
        delta: deltaOf(totals.runs, prev?.runs),
        invert: false,
        spark: series?.byMetric.runs ?? null,
      },
      {
        label: 'Success rate',
        value: percent(success),
        icon: 'ti-circle-check',
        tone: 'emerald',
        note: null,
        hint: 'Runs that completed, as a share of runs started.',
        delta: deltaOf(success, prevSuccess, 'points'),
        invert: false,
        spark: null,
      },
      {
        label: 'Error events',
        value: whole(totals.runErrors),
        icon: 'ti-alert-triangle',
        tone: 'rose',
        note: null,
        hint: 'Run errors reported in this range. A fall is good.',
        delta: deltaOf(totals.runErrors, prev?.runErrors),
        invert: true,
        spark: null,
      },
    ];
  });

  reload(): void {
    this.data.reload();
  }
}

/** Empty only when every number the summary reports is zero (10.13). */
export function isSummaryEmpty(value: SummaryResponse): boolean {
  const { activeInstalls: active, totals } = value;
  return (
    active.d1 === 0 &&
    active.d7 === 0 &&
    active.d30 === 0 &&
    totals.installs === 0 &&
    totals.sessions === 0 &&
    totals.runs === 0 &&
    totals.runsCompleted === 0 &&
    totals.runErrors === 0
  );
}
