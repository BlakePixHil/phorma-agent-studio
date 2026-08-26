import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import { K_ANONYMITY_FLOOR, type GeographyResponse, type GroupRow } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { GroupTable, type GroupColumn } from '../group-table';
import { byInstallsDesc, unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';
import { paintShapes, unmappedInstalls, WorldMap, type PaintedShape } from './world-map';

/** Installs and runs, the two metrics both geography groupings report. */
const GEO_COLUMNS: readonly GroupColumn[] = [
  { key: 'installs', label: 'Installs' },
  { key: 'runs', label: 'Runs' },
];

/** Rows the side-by-side bar list shows next to the map. */
const TOP_COUNTRIES_LIMIT = 6;

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
  imports: [DecimalPipe, GroupTable, ViewStateRail, WorldMap],
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
          <article class="admin-card">
            <h3 class="admin-card__title">
              <i class="ti ti-map-pin" aria-hidden="true"></i>
              <span>Installs by country</span>
            </h3>
            <div class="admin-map-row">
              <div class="admin-map-row__map">
                <!-- @defer keeps the generated path data out of the initial bundle. -->
                @defer (on immediate) {
                  <admin-world-map [rows]="countries()" />
                }
              </div>
              <div class="admin-map-row__list">
                <p class="admin-map-row__list-title">Top countries</p>
                @if (topCountries().length > 0) {
                  @for (shape of topCountries(); track shape.code) {
                    <div class="admin-map-bar">
                      <div class="admin-map-bar__row">
                        <span class="admin-map-bar__name">{{ shape.name }}</span>
                        <span class="admin-map-bar__count">{{ shape.installs | number }}</span>
                      </div>
                      <div class="admin-map-bar__track">
                        <div class="admin-map-bar__fill" [style.width.%]="barWidth(shape)"></div>
                      </div>
                    </div>
                  }
                } @else {
                  <p class="admin-map-row__list-empty">
                    No country has reached the {{ threshold }}-install reporting floor yet.
                  </p>
                }
              </div>
            </div>
          </article>

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
            Country is derived server side from the request. No network address is stored, and a
            country needs at least {{ threshold }} installs in this range before it is reported on
            its own - fewer, and it is folded into
            <code>other</code>
            .
          </p>

          @if (unmapped() > 0) {
            <p class="admin-footnote" data-geography-unmapped>
              <i class="ti ti-map-off" aria-hidden="true"></i>
              <span>{{ unmapped() | number }} install(s) have no country on the map above.</span>
            </p>
          }
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

  /** Installs the map cannot paint: the k-anonymity `other` fold, plus any unrecognized code. */
  readonly unmapped = computed(() => unmappedInstalls(this.countries()));

  /** The reporting floor a country must clear before it is shown on its own, not folded into `other`. */
  readonly threshold = K_ANONYMITY_FLOOR;

  /** The busiest few paintable countries, for the bar list beside the map. */
  readonly topCountries = computed<PaintedShape[]>(() =>
    paintShapes(this.countries())
      .filter((shape) => shape.installs > 0)
      .sort((a, b) => b.installs - a.installs)
      .slice(0, TOP_COUNTRIES_LIMIT),
  );

  /** Bar width as a percentage of the busiest listed country, never dividing by zero. */
  barWidth(shape: PaintedShape): number {
    const max = this.topCountries()[0]?.installs ?? 0;
    return max > 0 ? (shape.installs / max) * 100 : 0;
  }

  reload(): void {
    this.data.reload();
  }
}

/** No rows in either grouping is the empty state, not two empty tables (10.13). */
export function isGeographyEmpty(value: GeographyResponse): boolean {
  return value.countries.length === 0 && value.regions.length === 0;
}
