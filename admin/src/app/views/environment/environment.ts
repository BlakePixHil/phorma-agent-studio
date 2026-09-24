import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import {
  K_ANONYMITY_FLOOR,
  OTHER_GROUP_LABEL,
  type EnvironmentResponse,
  type GroupRow,
} from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { AdminBarList, type BarItem } from '../charts/bar-list';
import { shareOf } from '../charts/chart-math';
import { AdminDonut, type Slice } from '../charts/donut';
import { AdminRing } from '../charts/ring';
import { AdminStackBar, type StackPart } from '../charts/stack-bar';
import { categorical } from '../charts/tones';
import {
  compareVersions,
  formatRange,
  isVersion,
  localeDisplay,
  percent,
  platformDisplay,
  runtimeDisplay,
  whole,
} from '../format';
import { GroupTable } from '../group-table';
import { AdminData } from '../kit/data-disclosure';
import { AdminHint } from '../kit/hint';
import { AdminKpi } from '../kit/kpi';
import { byInstallsDesc, unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** One of the four environment groupings. */
export interface EnvironmentSection {
  key: keyof Omit<EnvironmentResponse, 'range'>;
  title: string;
  heading: string;
  icon: string;
}

/** The four groupings the Admin_API returns. Titles name each card's data table. */
export const ENVIRONMENT_SECTIONS: readonly EnvironmentSection[] = [
  { key: 'appVersion', title: 'By app version', heading: 'Version', icon: 'ti-tag' },
  { key: 'platform', title: 'By platform', heading: 'Platform', icon: 'ti-device-desktop' },
  { key: 'runtimeMode', title: 'By runtime mode', heading: 'Mode', icon: 'ti-app-window' },
  { key: 'locale', title: 'By locale', heading: 'Locale', icon: 'ti-language' },
];

export interface EnvironmentGroup extends EnvironmentSection {
  rows: GroupRow[];
}

const OTHER_HINT = `Groups with fewer than ${K_ANONYMITY_FLOOR} installs, summed together for privacy.`;

/** Versions shown individually on the rollout bar before the rest collapse. */
const ROLLOUT_SLOTS = 5;

/**
 * Environment: what the install base runs on (Requirement 10.7).
 *
 * Each grouping gets the chart that answers its question: a rollout bar for
 * "how many are on the latest version", a donut for the platform mix, a split
 * for desktop versus browser, and a ranked list for languages.
 */
@Component({
  selector: 'admin-environment',
  imports: [
    AdminBarList,
    AdminData,
    AdminDonut,
    AdminHint,
    AdminKpi,
    AdminRing,
    AdminStackBar,
    GroupTable,
    ViewStateRail,
  ],
  template: `
    <section class="admin-view" aria-labelledby="admin-environment-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-environment-title">
          <i class="ti ti-device-desktop" aria-hidden="true"></i>
          <span>Environment</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        <admin-hint [text]="selfReportedHint" />
      </header>

      @if (environment(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-kpis">
            <admin-kpi
              label="Latest version"
              [value]="headline().latest"
              icon="ti-tag"
              tone="iris"
              [note]="headline().latestNote"
            />
            <admin-kpi
              label="On latest"
              [value]="headline().adoption"
              icon="ti-rocket"
              tone="emerald"
              hint="Share of reporting installs already on the newest version seen in this range."
            />
            <admin-kpi
              label="Desktop app"
              [value]="headline().desktop"
              icon="ti-device-desktop"
              tone="azure"
              hint="Share of installs running the desktop app rather than the browser build."
            />
            <admin-kpi
              label="Top platform"
              [value]="headline().platform"
              [icon]="headline().platformIcon"
              tone="amber"
              [note]="headline().platformNote"
            />
            <admin-kpi
              label="Languages"
              [value]="headline().languages"
              icon="ti-language"
              tone="rose"
              [note]="headline().topLanguage"
            />
          </div>

          <div class="admin-pair">
            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-git-branch" aria-hidden="true"></i>
                  <span>Version rollout</span>
                </h2>
                <p class="admin-card__subtitle">Newest first</p>
              </div>
              <admin-stack-bar [data]="rollout()" [tall]="true" [legend]="false" />
              <admin-bar-list [items]="versionBars()" tone="iris" [limit]="6" />
              <admin-data>
                <admin-group-table
                  [icon]="sections[0].icon"
                  [title]="sections[0].title"
                  [labelHeading]="sections[0].heading"
                  [rows]="groups()[0].rows"
                  [framed]="false"
                />
              </admin-data>
            </article>

            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-devices" aria-hidden="true"></i>
                  <span>Platform</span>
                </h2>
              </div>
              <admin-donut [data]="platformSlices()" caption="installs" />
              <admin-data>
                <admin-group-table
                  [icon]="sections[1].icon"
                  [title]="sections[1].title"
                  [labelHeading]="sections[1].heading"
                  [rows]="groups()[1].rows"
                  [framed]="false"
                />
              </admin-data>
            </article>

            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-app-window" aria-hidden="true"></i>
                  <span>Desktop vs browser</span>
                </h2>
              </div>
              <div class="admin-ring-pair admin-env__runtime">
                <admin-ring [value]="desktopShare()" tone="azure" caption="desktop" />
                <div class="admin-env__runtime-bar">
                  <admin-stack-bar [data]="runtimeParts()" [tall]="true" />
                </div>
              </div>
              <admin-data>
                <admin-group-table
                  [icon]="sections[2].icon"
                  [title]="sections[2].title"
                  [labelHeading]="sections[2].heading"
                  [rows]="groups()[2].rows"
                  [framed]="false"
                />
              </admin-data>
            </article>

            <article class="admin-card">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-language" aria-hidden="true"></i>
                  <span>Languages</span>
                </h2>
              </div>
              <admin-bar-list [items]="localeBars()" tone="rose" [limit]="6" [total]="localeTotal()" />
              <admin-data>
                <admin-group-table
                  [icon]="sections[3].icon"
                  [title]="sections[3].title"
                  [labelHeading]="sections[3].heading"
                  [rows]="groups()[3].rows"
                  [framed]="false"
                />
              </admin-data>
            </article>
          </div>
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
  readonly sections = ENVIRONMENT_SECTIONS;
  readonly rangeLabel = computed(() => formatRange(this.range()));
  readonly selfReportedHint = `Every field is install-level and self-reported. ${OTHER_HINT.replace('Groups', 'Values')}`;

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchEnvironment(params).then(unwrapAdminResult),
  });

  readonly state = computed(() =>
    viewStateOf<EnvironmentResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: isEnvironmentEmpty,
    }),
  );

  readonly environment = computed(() => loadedValue(this.state()));

  readonly groups = computed<EnvironmentGroup[]>(() => {
    const value = this.environment();
    return ENVIRONMENT_SECTIONS.map((section) => ({
      ...section,
      rows: value ? byInstallsDesc(value[section.key]) : [],
    }));
  });

  private rows(key: EnvironmentSection['key']): GroupRow[] {
    return this.groups().find((group) => group.key === key)?.rows ?? [];
  }

  /** Real versions newest first, with `other` and unparseable labels after. */
  private readonly versionsNewestFirst = computed(() => {
    const rows = this.rows('appVersion');
    const versions = rows.filter((row) => isVersion(row.label)).sort((a, b) => compareVersions(b.label, a.label));
    const rest = rows.filter((row) => !isVersion(row.label));
    return { versions, rest, total: rows.reduce((sum, row) => sum + row.installs, 0) };
  });

  readonly rollout = computed<StackPart[]>(() => {
    const { versions, rest } = this.versionsNewestFirst();
    const shown = versions.slice(0, ROLLOUT_SLOTS);
    const older = [...versions.slice(ROLLOUT_SLOTS), ...rest].reduce((sum, row) => sum + row.installs, 0);
    const parts: StackPart[] = shown.map((row, index) => ({
      key: row.label,
      label: row.label,
      value: row.installs,
      tone: index === 0 ? 'emerald' : categorical(index),
    }));
    if (older > 0) parts.push({ key: '__older', label: 'Older and other', value: older, tone: 'muted' });
    return parts;
  });

  readonly versionBars = computed<BarItem[]>(() => {
    const { versions, rest, total } = this.versionsNewestFirst();
    const tones = new Map(this.rollout().map((part) => [part.key, part.tone]));
    return [...versions, ...rest].map((row, index) => ({
      key: row.label,
      label: row.label,
      value: row.installs,
      caption: `${whole(row.installs)} · ${percent(shareOf(row.installs, total))}`,
      badge: index === 0 && versions.length > 0 ? 'latest' : undefined,
      muted: row.label === OTHER_GROUP_LABEL,
      hint: row.label === OTHER_GROUP_LABEL ? OTHER_HINT : undefined,
      tone: tones.get(row.label) ?? 'muted',
    }));
  });

  readonly desktopShare = computed(() => {
    const runtime = this.rows('runtimeMode');
    const total = runtime.reduce((sum, row) => sum + row.installs, 0);
    const desktop = runtime.find((row) => row.label === 'desktop')?.installs ?? 0;
    return total > 0 ? shareOf(desktop, total) : null;
  });

  readonly platformSlices = computed<Slice[]>(() =>
    this.rows('platform').map((row, index) => {
      const display = platformDisplay(row.label);
      const other = row.label === OTHER_GROUP_LABEL;
      return {
        key: row.label,
        label: other ? 'Other' : display.name,
        value: row.installs,
        icon: other ? 'ti-dots' : display.icon,
        tone: other ? 'muted' : categorical(index),
      };
    }),
  );

  readonly runtimeParts = computed<StackPart[]>(() =>
    this.rows('runtimeMode').map((row, index) => {
      const other = row.label === OTHER_GROUP_LABEL;
      return {
        key: row.label,
        label: other ? 'Other' : runtimeDisplay(row.label).name,
        value: row.installs,
        tone: other ? 'muted' : row.label === 'desktop' ? 'azure' : row.label === 'browser' ? 'violet' : categorical(index),
        caption: `${whole(row.installs)} installs`,
      };
    }),
  );

  readonly localeTotal = computed(() => this.rows('locale').reduce((sum, row) => sum + row.installs, 0));

  readonly localeBars = computed<BarItem[]>(() =>
    this.rows('locale').map((row) => {
      const other = row.label === OTHER_GROUP_LABEL;
      return {
        key: row.label,
        label: other ? 'Other' : `${localeDisplay(row.label)}`,
        value: row.installs,
        muted: other,
        hint: other ? OTHER_HINT : row.label,
      };
    }),
  );

  readonly headline = computed(() => {
    const { versions, total } = this.versionsNewestFirst();
    const latest = versions[0];
    const runtime = this.rows('runtimeMode');
    const runtimeTotal = runtime.reduce((sum, row) => sum + row.installs, 0);
    const desktop = runtime.find((row) => row.label === 'desktop')?.installs ?? 0;
    const platform = this.rows('platform').find((row) => row.label !== OTHER_GROUP_LABEL);
    const platformTotal = this.rows('platform').reduce((sum, row) => sum + row.installs, 0);
    const locales = this.rows('locale').filter((row) => row.label !== OTHER_GROUP_LABEL);
    const display = platform ? platformDisplay(platform.label) : null;
    return {
      latest: latest?.label ?? '-',
      latestNote: latest ? `${whole(latest.installs)} installs` : null,
      adoption: latest ? percent(shareOf(latest.installs, total)) : '-',
      desktop: runtimeTotal > 0 ? percent(shareOf(desktop, runtimeTotal)) : '-',
      platform: display?.name ?? '-',
      platformIcon: display?.icon ?? 'ti-device-desktop',
      platformNote: platform ? `${percent(shareOf(platform.installs, platformTotal))} of installs` : null,
      languages: whole(locales.length),
      topLanguage: locales[0] ? `Mostly ${localeDisplay(locales[0].label)}` : null,
    };
  });

  reload(): void {
    this.data.reload();
  }
}

/** Empty only when none of the four groupings has a row (10.13). */
export function isEnvironmentEmpty(value: EnvironmentResponse): boolean {
  return ENVIRONMENT_SECTIONS.every((section) => value[section.key].length === 0);
}
