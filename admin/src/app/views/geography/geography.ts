import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import type { GeographyResponse, GroupRow } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { GroupTable, type GroupColumn } from '../group-table';
import { byInstallsDesc, unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** Installs and runs, the two metrics both geography groupings report. */
const GEO_COLUMNS: readonly GroupColumn[] = [
  { key: 'installs', label: 'Installs' },
  { key: 'runs', label: 'Runs' },
];

/**
 * The geography view: installs and runs grouped by country and by region for the
 * selected range (Requirement 10.6).
 *
 * Both groupings come from one Admin_API call, so there is one resource and one
 * state for the pair - a country table that loaded beside a region table that
 * failed is not a state this view can be in.
 *
 * Rows arrive in SQL group order; they are sorted by reach here so the tables
 * read top-down. The `other` row that the k-anonymity floor produces is left in
 * and marked by `GroupTable`, since its metrics are real.
 */
@Component({
  selector: 'admin-geography',
  imports: [GroupTable, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-geography-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-geography-title">
          <i class="ti ti-world" aria-hidden="true"></i>
          <span>Geography</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (geography(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-columns">
            <admin-group-table
              icon="ti-flag"
              title="By country"
              labelHeading="Country"
              [rows]="countries()"
              [columns]="columns"
            />
            <admin-group-table
              icon="ti-map-2"
              title="By region"
              labelHeading="Region"
              [rows]="regions()"
              [columns]="columns"
            />
          </div>

          <p class="admin-footnote">
            Country is derived server side from the request. No network address is stored, and
            groups below the reporting threshold are folded into
            <code>other</code>
            .
          </p>
        </div>
      } @else {
        <admin-view-state
          emptyMessage="No installs reported a location in this range."
          [state]="state()"
          (retry)="reload()"
        />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Geography {
  private readonly api = inject(TelemetryApiService);

  readonly range = inject(DateRangeService).range;
  readonly columns = GEO_COLUMNS;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchGeography(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<GeographyResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      // Guarded read: `value()` throws in the error state, so a bare read would
      // make this computed throw instead of resolving to `failed` (10.12).
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isGeographyEmpty,
    }),
  );

  readonly geography = computed(() => loadedValue(this.state()));

  readonly countries = computed<GroupRow[]>(() =>
    byInstallsDesc(this.geography()?.countries ?? []),
  );
  readonly regions = computed<GroupRow[]>(() => byInstallsDesc(this.geography()?.regions ?? []));

  reload(): void {
    this.data.reload();
  }
}

/** No rows in either grouping is the empty state, not two empty tables (10.13). */
export function isGeographyEmpty(value: GeographyResponse): boolean {
  return value.countries.length === 0 && value.regions.length === 0;
}
