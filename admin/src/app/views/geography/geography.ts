import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import {
  K_ANONYMITY_FLOOR,
  OTHER_GROUP_LABEL,
  type GeographyResponse,
  type GroupRow,
} from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { AdminBarList, type BarItem } from '../charts/bar-list';
import { shareOf } from '../charts/chart-math';
import { AdminDonut, type Slice } from '../charts/donut';
import { categorical } from '../charts/tones';
import { continentName, formatRange, percent, whole } from '../format';
import { GroupTable, type GroupColumn } from '../group-table';
import { AdminData } from '../kit/data-disclosure';
import { AdminHint } from '../kit/hint';
import { AdminKpi } from '../kit/kpi';
import { byInstallsDesc, unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';
import { paintShapes, unmappedInstalls, WorldMap, type PaintedShape } from './world-map';

const GEO_COLUMNS: readonly GroupColumn[] = [
  { key: 'installs', label: 'Installs' },
  { key: 'runs', label: 'Runs' },
];

/** Rows the bar list beside the map shows before "Show more". */
const TOP_COUNTRIES_LIMIT = 8;

/**
 * Geography: installs and runs by country and continent (Requirement 10.6).
 *
 * One Admin_API call feeds both groupings, so one resource and one state. The
 * map, its shading and its geometry are unchanged; the page around it leads
 * with the headline numbers and keeps the tables one click away.
 */
@Component({
  selector: 'admin-geography',
  imports: [AdminBarList, AdminData, AdminDonut, AdminHint, AdminKpi, GroupTable, ViewStateRail, WorldMap],
  template: `
    <section class="admin-view" aria-labelledby="admin-geography-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-geography-title">
          <i class="ti ti-world" aria-hidden="true"></i>
          <span>Geography</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        <admin-hint [text]="privacyHint" icon="ti-shield-lock" />
      </header>

      @if (geography(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-kpis">
            <admin-kpi label="Countries" [value]="headline().countries" icon="ti-flag" tone="iris" [note]="headline().countriesNote" />
            <admin-kpi label="Top country" [value]="headline().top" icon="ti-map-pin" tone="azure" [note]="headline().topNote" />
            <admin-kpi label="Continents" [value]="headline().continents" icon="ti-world" tone="emerald" [note]="headline().continentNote" />
            <admin-kpi label="Runs" [value]="headline().runs" icon="ti-rocket" tone="amber" [note]="headline().runsNote" />
          </div>

          <article class="admin-card admin-card--hero">
            <div class="admin-card__head">
              <h2 class="admin-card__title">
                <i class="ti ti-map-pin" aria-hidden="true"></i>
                <span>Installs by country</span>
              </h2>
              <div class="admin-card__aside">
                @if (unmapped() > 0) {
                  <span class="admin-chip admin-chip--muted" data-geography-unmapped>
                    <i class="ti ti-map-off" aria-hidden="true"></i>
                    <span>{{ unmappedText() }} not on the map</span>
                    <admin-hint [text]="unmappedHint" />
                  </span>
                }
              </div>
            </div>
            <div class="admin-map-row">
              <div class="admin-map-row__map">
                <!-- @defer keeps the generated path data off the first paint. -->
                @defer (on immediate) {
                  <admin-world-map [rows]="countries()" />
                }
                <div class="admin-map__legend" aria-hidden="true">
                  <span>Fewer</span>
                  <span class="admin-map__ramp"></span>
                  <span>More installs</span>
                </div>
              </div>
              <div class="admin-map-row__list">
                <p class="admin-map-row__list-title">Top countries</p>
                @if (topCountries().length > 0) {
                  <admin-bar-list [items]="topCountries()" tone="iris" [limit]="limit" [total]="installTotal()" />
                } @else {
                  <p class="admin-map-row__list-empty">
                    No country has reached the {{ threshold }}-install reporting floor yet.
                  </p>
                }
              </div>
            </div>
          </article>

          <div class="admin-pair">
            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-map-2" aria-hidden="true"></i>
                  <span>By continent</span>
                </h2>
              </div>
              <admin-donut [data]="continentSlices()" caption="installs" />
            </article>

            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-rocket" aria-hidden="true"></i>
                  <span>Runs per install</span>
                </h2>
                <p class="admin-card__subtitle">Where installs are most active</p>
              </div>
              <admin-bar-list [items]="intensity()" tone="amber" [limit]="6" />
            </article>
          </div>

          <article class="admin-card">
            <admin-data>
              <div class="admin-columns">
                <admin-group-table
                  icon="ti-flag"
                  title="By country"
                  labelHeading="Country"
                  [rows]="countries()"
                  [columns]="columns"
                  [framed]="false"
                />
                <admin-group-table
                  icon="ti-map-2"
                  title="By region"
                  labelHeading="Region"
                  [rows]="regions()"
                  [columns]="columns"
                  [framed]="false"
                />
              </div>
            </admin-data>
          </article>
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
  readonly limit = TOP_COUNTRIES_LIMIT;
  readonly threshold = K_ANONYMITY_FLOOR;
  readonly rangeLabel = computed(() => formatRange(this.range()));
  readonly privacyHint = `Country is derived server side from the request. No network address is stored, and a country needs at least ${K_ANONYMITY_FLOOR} installs in this range before it is reported on its own - fewer, and it is folded into other.`;
  readonly unmappedHint = `Installs folded into other (countries under ${K_ANONYMITY_FLOOR} installs) or from an unknown location.`;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchGeography(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<GeographyResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isGeographyEmpty,
    }),
  );

  readonly geography = computed(() => loadedValue(this.state()));

  readonly countries = computed<GroupRow[]>(() => byInstallsDesc(this.geography()?.countries ?? []));
  readonly regions = computed<GroupRow[]>(() => byInstallsDesc(this.geography()?.regions ?? []));

  readonly installTotal = computed(() => this.countries().reduce((sum, row) => sum + row.installs, 0));

  /** Installs the map cannot paint: the k-anonymity `other` fold, plus any unrecognized code. */
  readonly unmapped = computed(() => unmappedInstalls(this.countries()));
  readonly unmappedText = computed(() => `${whole(this.unmapped())} install(s)`);

  private readonly painted = computed<PaintedShape[]>(() =>
    paintShapes(this.countries())
      .filter((shape) => shape.installs > 0)
      .sort((a, b) => b.installs - a.installs),
  );

  readonly topCountries = computed<BarItem[]>(() =>
    this.painted().map((shape) => ({
      key: shape.code,
      label: shape.name,
      value: shape.installs,
      caption: `${whole(shape.installs)}`,
      hint: `${percent(shape.share)} of installs · ${whole(shape.runs)} runs`,
    })),
  );

  readonly continentSlices = computed<Slice[]>(() =>
    this.regions().map((row, index) => {
      const muted = row.label === OTHER_GROUP_LABEL || row.label === 'unknown';
      return {
        key: row.label,
        label: row.label === OTHER_GROUP_LABEL ? 'Other' : continentName(row.label),
        value: row.installs,
        tone: muted ? 'muted' : categorical(index),
      };
    }),
  );

  readonly intensity = computed<BarItem[]>(() =>
    this.painted()
      .map((shape) => ({ shape, perInstall: shape.installs > 0 ? shape.runs / shape.installs : 0 }))
      .filter((entry) => entry.shape.runs > 0)
      .sort((a, b) => b.perInstall - a.perInstall)
      .map(({ shape, perInstall }) => ({
        key: shape.code,
        label: shape.name,
        value: perInstall,
        caption: perInstall.toFixed(1),
        hint: `${whole(shape.runs)} runs from ${whole(shape.installs)} installs`,
      })),
  );

  readonly headline = computed(() => {
    const painted = this.painted();
    const top = painted[0];
    const regions = this.regions().filter((row) => row.label !== OTHER_GROUP_LABEL && row.label !== 'unknown');
    const topRegion = regions[0];
    const runs = this.countries().reduce((sum, row) => sum + (typeof row['runs'] === 'number' ? row['runs'] : 0), 0);
    const installs = this.installTotal();
    return {
      countries: whole(painted.length),
      countriesNote: `${whole(installs)} installs located`,
      top: top?.name ?? '-',
      topNote: top ? `${percent(top.share)} of installs` : null,
      continents: whole(regions.length),
      continentNote: topRegion
        ? `Led by ${continentName(topRegion.label)} (${percent(shareOf(topRegion.installs, installs))})`
        : null,
      runs: whole(runs),
      runsNote: installs > 0 ? `${(runs / installs).toFixed(1)} per install` : null,
    };
  });

  reload(): void {
    this.data.reload();
  }
}

/** No rows in either grouping is the empty state, not two empty tables (10.13). */
export function isGeographyEmpty(value: GeographyResponse): boolean {
  return value.countries.length === 0 && value.regions.length === 0;
}
