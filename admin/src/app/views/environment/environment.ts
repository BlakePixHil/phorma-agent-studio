import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import type { EnvironmentResponse, GroupRow } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { GroupTable } from '../group-table';
import { byInstallsDesc, unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** One of the four environment groupings, as the template renders it. */
export interface EnvironmentSection {
  key: keyof Omit<EnvironmentResponse, 'range'>;
  title: string;
  heading: string;
  icon: string;
}

/**
 * The four groupings the Admin_API returns, in render order. Keyed off the
 * response so a section cannot point at a field that is not there.
 */
export const ENVIRONMENT_SECTIONS: readonly EnvironmentSection[] = [
  { key: 'appVersion', title: 'By app version', heading: 'Version', icon: 'ti-tag' },
  { key: 'platform', title: 'By platform', heading: 'Platform', icon: 'ti-device-desktop' },
  { key: 'runtimeMode', title: 'By runtime mode', heading: 'Mode', icon: 'ti-app-window' },
  { key: 'locale', title: 'By locale', heading: 'Locale', icon: 'ti-language' },
];

/** One section paired with its sorted rows. */
export interface EnvironmentGroup extends EnvironmentSection {
  rows: GroupRow[];
}

/**
 * The environment view: installs grouped by app version, platform, runtime mode
 * and locale for the selected range (Requirement 10.7).
 *
 * All four groupings come from one call, so they share one resource and one
 * state. The section list is data, not four copies of the same markup, so
 * adding a fifth grouping to the response is one entry here.
 */
@Component({
  selector: 'admin-environment',
  imports: [GroupTable, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-environment-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-environment-title">
          <i class="ti ti-device-desktop" aria-hidden="true"></i>
          <span>Environment</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (environment(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-columns">
            @for (group of groups(); track group.key) {
              <admin-group-table
                [icon]="group.icon"
                [title]="group.title"
                [labelHeading]="group.heading"
                [rows]="group.rows"
              />
            }
          </div>

          <p class="admin-footnote">
            Every field is install-level and self-reported. Groups below the reporting threshold are
            folded into
            <code>other</code>
            .
          </p>
        </div>
      } @else {
        <admin-view-state
          emptyMessage="No installs reported environment details in this range."
          [state]="state()"
          (retry)="reload()"
        />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Environment {
  private readonly api = inject(TelemetryApiService);

  readonly range = inject(DateRangeService).range;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchEnvironment(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<EnvironmentResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      // Guarded read: `value()` throws in the error state, so a bare read would
      // make this computed throw instead of resolving to `failed` (10.12).
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isEnvironmentEmpty,
    }),
  );

  readonly environment = computed(() => loadedValue(this.state()));

  readonly groups = computed<EnvironmentGroup[]>(() => {
    const value = this.environment();
    if (value === null) return [];
    return ENVIRONMENT_SECTIONS.map((section) => ({
      ...section,
      rows: byInstallsDesc(value[section.key]),
    }));
  });

  reload(): void {
    this.data.reload();
  }
}

/** Empty only when none of the four groupings has a row (10.13). */
export function isEnvironmentEmpty(value: EnvironmentResponse): boolean {
  return ENVIRONMENT_SECTIONS.every((section) => value[section.key].length === 0);
}
