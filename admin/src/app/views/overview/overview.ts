import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import type { SummaryResponse } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** One number on the overview, with the icon and caption that explain it. */
export interface StatCard {
  label: string;
  value: number;
  icon: string;
  note: string;
}

/**
 * The overview view: active installs for the trailing 1, 7 and 30 days, plus the
 * range totals (Requirement 10.5).
 *
 * The data is a `resource()` keyed on the shared range signal, so a range change
 * refetches it with no wiring beyond that key (10.10). Its four render states go
 * through `viewStateOf`, so precedence is the same here as in every other view
 * (10.11, 10.12, 10.13).
 *
 * The trailing windows are NOT clipped to the selected range: they are what the
 * Admin_API reports for the last 1, 7 and 30 days, which is the reading the
 * requirement asks for. The captions say so, so a narrow range cannot be
 * misread as having produced them.
 */
@Component({
  selector: 'admin-overview',
  imports: [DecimalPipe, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-overview-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-overview-title">
          <i class="ti ti-gauge" aria-hidden="true"></i>
          <span>Overview</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (summary(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <section class="admin-view__section" aria-labelledby="admin-overview-active">
            <h2 class="admin-view__section-title" id="admin-overview-active">Active installs</h2>
            <div class="admin-grid">
              @for (card of activeCards(); track card.label) {
                <article class="admin-card admin-stat">
                  <p class="admin-stat__label">
                    <i class="ti {{ card.icon }}" aria-hidden="true"></i>
                    <span>{{ card.label }}</span>
                  </p>
                  <p class="admin-stat__value">{{ card.value | number }}</p>
                  <p class="admin-stat__note">{{ card.note }}</p>
                </article>
              }
            </div>
          </section>

          <section class="admin-view__section" aria-labelledby="admin-overview-totals">
            <h2 class="admin-view__section-title" id="admin-overview-totals">
              Totals for this range
            </h2>
            <div class="admin-grid">
              @for (card of totalCards(); track card.label) {
                <article class="admin-card admin-stat">
                  <p class="admin-stat__label">
                    <i class="ti {{ card.icon }}" aria-hidden="true"></i>
                    <span>{{ card.label }}</span>
                  </p>
                  <p class="admin-stat__value">{{ card.value | number }}</p>
                  <p class="admin-stat__note">{{ card.note }}</p>
                </article>
              }
            </div>
          </section>

          <p class="admin-footnote">
            Counts are anonymous per-install rollups. No install identifier leaves the API.
          </p>
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

  /** The one shared range. Both the resource key and the header caption. */
  readonly range = inject(DateRangeService).range;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchSummary(params).then(unwrapAdminResult),
  });

  /**
   * Exactly one of loading, loaded, empty or failed.
   *
   * `value` is read through `hasValue()`, never bare: `resource().value()` THROWS
   * while the resource is in its error state, and the literal below evaluates
   * every property eagerly, so a bare read makes this computed throw on any
   * failed request instead of resolving to `failed` (10.12). Same guard in all
   * five views.
   */
  readonly state = computed(() =>
    viewStateOf<SummaryResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isSummaryEmpty,
    }),
  );

  /** The loaded response, or `null` in the other three states. */
  readonly summary = computed(() => loadedValue(this.state()));

  readonly activeCards = computed<StatCard[]>(() => {
    const active = this.summary()?.activeInstalls;
    if (!active) return [];
    return [
      { label: 'Last 24 hours', value: active.d1, icon: 'ti-clock', note: 'Trailing 1 day' },
      { label: 'Last 7 days', value: active.d7, icon: 'ti-calendar-week', note: 'Trailing 7 days' },
      {
        label: 'Last 30 days',
        value: active.d30,
        icon: 'ti-calendar-month',
        note: 'Trailing 30 days',
      },
    ];
  });

  readonly totalCards = computed<StatCard[]>(() => {
    const totals = this.summary()?.totals;
    if (!totals) return [];
    return [
      {
        label: 'Installs',
        value: totals.installs,
        icon: 'ti-device-desktop',
        note: 'Distinct installs in range',
      },
      {
        label: 'Sessions',
        value: totals.sessions,
        icon: 'ti-player-play',
        note: 'Sessions started',
      },
      { label: 'Runs', value: totals.runs, icon: 'ti-rocket', note: 'Runs started' },
      {
        label: 'Runs completed',
        value: totals.runsCompleted,
        icon: 'ti-circle-check',
        note: 'Runs that settled',
      },
      {
        label: 'Error events',
        value: totals.runErrors,
        icon: 'ti-alert-triangle',
        note: 'Run errors reported',
      },
    ];
  });

  /** Re-runs this view's own request. The failed state's retry control (10.12). */
  reload(): void {
    this.data.reload();
  }
}

/**
 * The summary carries no group rows, so "no rows for this range" means every
 * number it reports is zero. Anything above zero is real data and renders as
 * loaded, however small (10.13).
 */
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
