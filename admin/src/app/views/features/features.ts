import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { DateRangeService } from '../../core/date-range.service';
import type { FeatureRow, FeaturesResponse, GroupRow } from '../../core/models';
import { OTHER_GROUP_LABEL } from '../../core/models';
import { TelemetryApiService } from '../../core/telemetry-api.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { AdminBarList, type BarItem } from '../charts/bar-list';
import { deltaOf, shareOf } from '../charts/chart-math';
import { AdminDonut, type Slice } from '../charts/donut';
import { categorical, type Tone } from '../charts/tones';
import { compact, completionRate, formatRange, humanize, percent, whole } from '../format';
import { GroupTable, type GroupColumn } from '../group-table';
import { AdminData } from '../kit/data-disclosure';
import { AdminHint } from '../kit/hint';
import { AdminKpi } from '../kit/kpi';
import { enriched, enrichment } from '../secondary';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

const FEATURE_COLUMNS: readonly GroupColumn[] = [
  { key: 'total', label: 'Total' },
  { key: 'installs', label: 'Installs' },
];

/** The counter families of the closed catalog, keyed by name prefix. */
export type FeatureFamily = 'core' | 'nodes' | 'panels' | 'assistant' | 'deploys' | 'errors' | 'other';

export interface ParsedCounter extends FeatureRow {
  readonly family: FeatureFamily;
  /** The dimension after the colon, or the whole name for a core counter. */
  readonly part: string;
}

const PREFIXES: readonly [string, FeatureFamily][] = [
  ['node.created:', 'nodes'],
  ['panel.opened:', 'panels'],
  ['assistant.invoked:', 'assistant'],
  ['deploy.started:', 'deploys'],
  ['error:', 'errors'],
];

const CORE = new Set(['session.started', 'run.started', 'run.completed', 'run.error']);

/** Which family a counter belongs to. Unknown names land in `other`, never dropped. */
export function parseCounter(row: FeatureRow): ParsedCounter {
  for (const [prefix, family] of PREFIXES) {
    if (row.label.startsWith(prefix)) return { ...row, family, part: row.label.slice(prefix.length) };
  }
  return { ...row, family: CORE.has(row.label) ? 'core' : 'other', part: row.label };
}

const CORE_LABELS: Readonly<Record<string, string>> = {
  'session.started': 'Sessions started',
  'run.started': 'Runs started',
  'run.completed': 'Runs completed',
  'run.error': 'Run errors',
};

/** Operator copy for one counter, e.g. `node.created:http-tool` -> `HTTP tool node`. */
export function counterName(counter: ParsedCounter): string {
  const part = humanize(counter.part);
  switch (counter.family) {
    case 'core':
      return CORE_LABELS[counter.label] ?? part;
    case 'nodes':
      return `${part} node`;
    case 'panels':
      return `${part} panel`;
    case 'assistant':
      return `Assistant: ${part.toLowerCase()}`;
    case 'deploys':
      return `Deploy to ${part}`;
    case 'errors':
      return `${part} error`;
    default:
      return counter.label === OTHER_GROUP_LABEL ? 'Other counters' : counter.label;
  }
}

/**
 * Features: what the install base actually uses (Requirement 10.8).
 *
 * The 57-name closed catalog is grouped into families so the page answers
 * questions ("which nodes get built", "which panels get opened") instead of
 * listing raw counter names. The summary's install count is the denominator
 * for reach, and the previous period's counters give the deltas; both are
 * enrichments that never fail the view.
 */
@Component({
  selector: 'admin-features',
  imports: [AdminBarList, AdminData, AdminDonut, AdminHint, AdminKpi, GroupTable, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-features-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-features-title">
          <i class="ti ti-sparkles" aria-hidden="true"></i>
          <span>Features</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        <admin-hint [text]="catalogHint" />
      </header>

      @if (features(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-kpis">
            @for (card of cards(); track card.label) {
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
              />
            }
          </div>

          <div class="admin-split">
            <article class="admin-card admin-card--hero">
              <div class="admin-card__head">
                <h2 class="admin-card__title">
                  <i class="ti ti-trophy" aria-hidden="true"></i>
                  <span>Most used</span>
                </h2>
                <p class="admin-card__subtitle">{{ reachCaption() }}</p>
              </div>
              <admin-bar-list [items]="leaderboard()" tone="iris" [limit]="10" />
            </article>

            <div class="admin-stack-col">
              @if (assistantSlices().length > 0) {
                <article class="admin-card">
                  <div class="admin-card__head">
                    <h2 class="admin-card__title">
                      <i class="ti ti-message-chatbot" aria-hidden="true"></i>
                      <span>Assistant modes</span>
                    </h2>
                  </div>
                  <admin-donut [data]="assistantSlices()" caption="uses" />
                </article>
              }
              @if (deploySlices().length > 0) {
                <article class="admin-card">
                  <div class="admin-card__head">
                    <h2 class="admin-card__title">
                      <i class="ti ti-cloud-upload" aria-hidden="true"></i>
                      <span>Deploy targets</span>
                    </h2>
                  </div>
                  <admin-donut [data]="deploySlices()" caption="deploys" />
                </article>
              }
            </div>
          </div>

          <div class="admin-split admin-split--even">
            @for (family of familyCards(); track family.key) {
              <article class="admin-card">
                <div class="admin-card__head">
                  <h2 class="admin-card__title">
                    <i class="ti {{ family.icon }}" aria-hidden="true"></i>
                    <span>{{ family.title }}</span>
                  </h2>
                  <p class="admin-card__subtitle">{{ family.caption }}</p>
                </div>
                <admin-bar-list [items]="family.items" [tone]="family.tone" [limit]="8" />
              </article>
            }
          </div>

          <article class="admin-card">
            <admin-data label="View all counters">
              <admin-group-table
                icon="ti-list-numbers"
                title="Counter totals"
                labelHeading="Counter"
                [rows]="counters()"
                [columns]="columns"
                [framed]="false"
              />
            </admin-data>
          </article>
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
  private readonly dates = inject(DateRangeService);

  readonly range = this.dates.range;
  readonly columns = FEATURE_COLUMNS;
  readonly rangeLabel = computed(() => formatRange(this.range()));
  readonly catalogHint =
    'Counters come from a closed catalog. Totals are sums over the range; reach is how many distinct installs reported a counter at all.';

  private readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchFeatures(params).then(unwrapAdminResult),
  });

  private readonly previousData = enrichment(
    () => this.dates.previousRange(),
    (range) => this.api.fetchFeatures(range),
  );

  private readonly summaryData = enrichment(
    () => this.range(),
    (range) => this.api.fetchSummary(range),
  );

  readonly state = computed(() =>
    viewStateOf<FeaturesResponse>({
      loading: this.data.isLoading(),
      error: this.data.error(),
      value: this.data.hasValue() ? this.data.value() : undefined,
      isEmpty: (value) => value.counters.length === 0,
    }),
  );

  readonly features = computed(() => loadedValue(this.state()));
  readonly deltaHint = computed(() => `Against ${formatRange(this.dates.previousRange())}`);

  /** Counter rows as group rows, ordered by total. */
  readonly counters = computed<GroupRow[]>(() =>
    [...(this.features()?.counters ?? [])]
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
      .map((row) => ({ label: row.label, installs: row.installs, total: row.total })),
  );

  private readonly parsed = computed(() => (this.features()?.counters ?? []).map(parseCounter));

  /** Distinct installs in range, the reach denominator. Null until the summary lands. */
  private readonly installBase = computed(() => enriched(this.summaryData)?.totals.installs ?? null);

  readonly reachCaption = computed(() => {
    const base = this.installBase();
    return base ? `Reach across ${whole(base)} installs` : 'By installs reporting it';
  });

  private total(label: string, rows: readonly FeatureRow[] | undefined = this.features()?.counters): number | null {
    if (!rows) return null;
    return rows.find((row) => row.label === label)?.total ?? 0;
  }

  private familyTotal(family: FeatureFamily, rows: readonly FeatureRow[] | undefined): number | null {
    if (!rows) return null;
    return rows.map(parseCounter).filter((c) => c.family === family).reduce((sum, c) => sum + c.total, 0);
  }

  readonly cards = computed(() => {
    const current = this.features()?.counters;
    const previous = enriched(this.previousData)?.counters;
    const runs = this.total('run.started') ?? 0;
    const completed = this.total('run.completed') ?? 0;
    const success = completionRate(completed, runs);
    const prevRuns = previous ? (this.total('run.started', previous) ?? 0) : null;
    const prevCompleted = previous ? (this.total('run.completed', previous) ?? 0) : null;
    const prevSuccess = prevRuns !== null && prevCompleted !== null ? completionRate(prevCompleted, prevRuns) : null;
    const card = (
      label: string,
      icon: string,
      tone: Tone,
      now: number | null,
      before: number | null,
      hint: string,
      invert = false,
    ) => ({
      label,
      icon,
      tone,
      hint,
      invert,
      value: now === null ? '-' : compact(now),
      note: null as string | null,
      delta: deltaOf(now, before),
    });
    return [
      card('Runs started', 'ti-rocket', 'amber', runs, prevRuns, 'Workflow runs started in this range.'),
      {
        ...card('Success rate', 'ti-circle-check', 'emerald', null, null, 'Runs completed as a share of runs started.'),
        value: percent(success),
        delta: deltaOf(success, prevSuccess, 'points'),
      },
      card(
        'Nodes created',
        'ti-hierarchy-3',
        'iris',
        this.familyTotal('nodes', current),
        this.familyTotal('nodes', previous),
        'Canvas nodes added, across every node kind.',
      ),
      card(
        'Assistant uses',
        'ti-message-chatbot',
        'violet',
        this.familyTotal('assistant', current),
        this.familyTotal('assistant', previous),
        'Assistant invocations across ask, plan and agent modes.',
      ),
      card(
        'Deploys',
        'ti-cloud-upload',
        'azure',
        this.familyTotal('deploys', current),
        this.familyTotal('deploys', previous),
        'Deploys started, across every target.',
      ),
      card(
        'Errors',
        'ti-alert-octagon',
        'rose',
        this.familyTotal('errors', current),
        this.familyTotal('errors', previous),
        'Error events by category. A fall is good.',
        true,
      ),
    ];
  });

  /** Features ranked by reach: the share of installs that used them at all. */
  readonly leaderboard = computed<BarItem[]>(() => {
    const base = this.installBase();
    return this.parsed()
      .filter((c) => c.family !== 'core' && c.family !== 'errors')
      .sort((a, b) => b.installs - a.installs || b.total - a.total)
      .map((c) => ({
        key: c.label,
        label: counterName(c),
        value: c.installs,
        caption: base ? `${percent(shareOf(c.installs, base))} · ${compact(c.total)}` : `${whole(c.installs)} installs`,
        hint: `${whole(c.total)} total from ${whole(c.installs)} installs`,
        muted: c.label === OTHER_GROUP_LABEL,
      }));
  });

  private slices(family: FeatureFamily): Slice[] {
    return this.parsed()
      .filter((c) => c.family === family)
      .sort((a, b) => b.total - a.total)
      .map((c, index) => ({ key: c.label, label: humanize(c.part), value: c.total, tone: categorical(index) }));
  }

  readonly assistantSlices = computed(() => this.slices('assistant'));
  readonly deploySlices = computed(() => this.slices('deploys'));

  readonly familyCards = computed(() => {
    const bars = (family: FeatureFamily): BarItem[] =>
      this.parsed()
        .filter((c) => c.family === family)
        .sort((a, b) => b.total - a.total)
        .map((c) => ({
          key: c.label,
          label: family === 'other' ? counterName(c) : humanize(c.part),
          value: c.total,
          caption: compact(c.total),
          hint: `${whole(c.installs)} installs`,
          muted: c.label === OTHER_GROUP_LABEL,
        }));
    const defs: { key: FeatureFamily; title: string; icon: string; tone: Tone }[] = [
      { key: 'nodes', title: 'Nodes built', icon: 'ti-hierarchy-3', tone: 'iris' },
      { key: 'panels', title: 'Panels opened', icon: 'ti-layout-sidebar', tone: 'azure' },
      { key: 'errors', title: 'Errors by category', icon: 'ti-alert-octagon', tone: 'bad' },
      { key: 'other', title: 'Other counters', icon: 'ti-dots', tone: 'muted' },
    ];
    return defs
      .map((def) => {
        const items = bars(def.key);
        return { ...def, items, caption: `${compact(items.reduce((sum, i) => sum + i.value, 0))} total` };
      })
      .filter((card) => card.items.length > 0);
  });

  reload(): void {
    this.data.reload();
  }
}
