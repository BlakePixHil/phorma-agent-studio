import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import type { FeaturesResponse, GroupRow } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { GroupTable, type GroupColumn } from '../group-table';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** The total first: it is the number the view exists to show. */
const FEATURE_COLUMNS: readonly GroupColumn[] = [
  { key: 'total', label: 'Total' },
  { key: 'installs', label: 'Installs' },
];

/**
 * The feature-usage view: summed Counter values grouped by Counter name for the
 * selected range (Requirement 10.8).
 *
 * Rows are ordered by total, biggest first, because the question this view
 * answers is which features get used - not which are alphabetically first. The
 * `installs` column beside each total is the reach: 200 runs from 2 installs and
 * 200 from 90 mean very different things.
 */
@Component({
  selector: 'admin-features',
  imports: [GroupTable, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-features-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-features-title">
          <i class="ti ti-sparkles" aria-hidden="true"></i>
          <span>Features</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (features(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <admin-group-table
            icon="ti-list-numbers"
            title="Counter totals"
            labelHeading="Counter"
            [rows]="counters()"
            [columns]="columns"
          />

          <p class="admin-footnote">
            Counters come from a closed catalog. Totals are sums over the range;
            <code>Installs</code>
            is how many distinct installs reported the counter at all.
          </p>
        </div>
      } @else {
        <admin-view-state
          emptyMessage="No counters were reported in this range."
          [state]="state()"
          (retry)="reload()"
        />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Features {
  private readonly api = inject(TelemetryApiService);

  readonly range = inject(DateRangeService).range;
  readonly columns = FEATURE_COLUMNS;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchFeatures(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<FeaturesResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      // Guarded read: `value()` throws in the error state, so a bare read would
      // make this computed throw instead of resolving to `failed` (10.12).
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: (value) => value.counters.length === 0,
    }),
  );

  readonly features = computed(() => loadedValue(this.state()));

  /**
   * Counter rows as group rows, ordered by total.
   *
   * `FeatureRow` is a declared interface, so it carries no implicit index
   * signature and is not assignable to `GroupRow`. Rebuilding each row as an
   * object literal is the conversion, not a copy for its own sake.
   */
  readonly counters = computed<GroupRow[]>(() =>
    [...(this.features()?.counters ?? [])]
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
      .map((row) => ({ label: row.label, installs: row.installs, total: row.total })),
  );

  reload(): void {
    this.data.reload();
  }
}
