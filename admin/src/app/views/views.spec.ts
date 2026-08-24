// Feature: telemetry-phone-home, Property: every group label in a generated response reaches the DOM
//
// TASK-LEVEL property, not one of the numbered design properties. The design's
// numbered set stops at Property 35; task 13.9 asks for one rendering example per
// view plus this one property, so it carries a named tag rather than a number.
// Adding it to the design's numbered list is a spec change and needs the user.
//
// Validates: Requirements 10.5, 10.6, 10.7, 10.8, 10.9
//
// What the property claims: for any Admin_API response a view can be handed, the
// set of group labels rendered by that view equals the set of group labels the
// response carried - per grouping, not merely in total.
//
// That is the claim the four grouped views can quietly break. Each of them sorts,
// maps or filters its rows on the way to the template (`byInstallsDesc`, the
// `FeatureRow` to `GroupRow` rebuild, `sortedDays`, the `other` exclusion from the
// plot), and every one of those is a place a row can go missing without anything
// failing: the view still renders, still says `loaded`, and just shows less than
// it was given. Set EQUALITY rather than inclusion, so an invented or duplicated
// label fails too.
//
// The examples below cover the other half of 13.9, one per view: the numbers and
// labels each requirement names actually appear in the DOM, exactly one
// `[data-view-state]` element is present in each of the four states, and the
// failed state's retry control re-issues the view's own request.
//
// Two deliberate scoping decisions:
//
//   - `data-view-state` is the assertion target for "exactly one state". The
//     loaded body and `ViewStateRail` each mark themselves with it, so counting
//     the attribute is a direct test of the exclusivity the two arms of the view's
//     `@if` are supposed to guarantee - no reading of component state involved.
//
//   - The trend chart is NOT asserted through the DOM. `UIChart` paints into a
//     canvas, so no label of it is readable from the DOM at all, and it sits
//     behind `@defer (on immediate)` so chart.js resolves asynchronously. The
//     assertions are made on `chartData()`, which is exactly the data handed to
//     `p-chart`, plus the day table and the footnote, which ARE in the DOM. The
//     trend mounts run with `DeferBlockBehavior.Manual` so a 100-iteration
//     property does not load and tear down chart.js 100 times; the rendering
//     example lets the defer play through and asserts the chart element appears.
//
// Property assertions throw rather than using jasmine `expect`, so fast-check can
// shrink to a minimal counterexample.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { DeferBlockBehavior, TestBed, type ComponentFixture } from '@angular/core/testing';
import fc from 'fast-check';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';

import { DateRangeService } from '../core/date-range.service';
import {
  OTHER_GROUP_LABEL,
  type DateRange,
  type EnvironmentResponse,
  type FeatureRow,
  type FeaturesResponse,
  type GeographyResponse,
  type GroupRow,
  type SummaryResponse,
  type TelemetryRoute,
  type TrendDay,
  type TrendResponse,
} from '../core/models';
import { SESSION_TOKEN_RESOLVER } from '../core/telemetry-api.service';
import { VIEW_FAILURE_FALLBACK } from '../core/view-state';
import { Environment, ENVIRONMENT_SECTIONS } from './environment/environment';
import { Features } from './features/features';
import { Geography } from './geography/geography';
import { Overview } from './overview/overview';
import { Trend } from './trend/trend';

/** Minimum iterations mandated for every property test in this feature. */
const RUNS = 100;

/** Each iteration mounts a view, so the jasmine 5s default is not enough. */
const PROPERTY_TIMEOUT_MS = 180_000;

/** Any non-blank token: the bearer is Property 33's subject, not this file's. */
const TOKEN = 'sess_live_token';

/** The static reason every failing answer in this file serves. */
const FAILURE_REASON = 'Telemetry store unavailable.';

// --- Assertions ------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Set equality on labels, reported as a diff so a shrunk failure reads. */
function assertSameLabels(rendered: readonly string[], expected: readonly string[], where: string): void {
  const missing = expected.filter((label) => !rendered.includes(label));
  const extra = rendered.filter((label) => !expected.includes(label));
  assert(
    missing.length === 0 && extra.length === 0 && rendered.length === expected.length,
    `${where}: rendered [${rendered.join(', ')}] for expected [${expected.join(', ')}]` +
      `${missing.length > 0 ? ` - missing [${missing.join(', ')}]` : ''}` +
      `${extra.length > 0 ? ` - unexpected [${extra.join(', ')}]` : ''}`,
  );
}

// --- Harness ---------------------------------------------------------------

/** Drains pending microtasks, including the resource loader's own awaits. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted<T> {
  readonly fixture: ComponentFixture<T>;
  readonly view: T;
  readonly host: HTMLElement;
  readonly http: HttpTestingController;
  /** The range the view opened on, which every request must carry. */
  readonly range: DateRange;
}

/**
 * One view over a recording backend, rendered once so its resource has issued
 * its first request. Rebuilt per case so the shared range signal and the
 * `forbidden` signal start clean.
 */
function mount<T>(type: Type<T>, options: { deferBlocks?: DeferBlockBehavior } = {}): Mounted<T> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      providePrimeNG({ theme: { preset: Aura } }),
      { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve(TOKEN) },
    ],
    deferBlockBehavior: options.deferBlocks ?? DeferBlockBehavior.Playthrough,
  });
  const http = TestBed.inject(HttpTestingController);
  const range = TestBed.inject(DateRangeService).range();
  const fixture = TestBed.createComponent(type);
  fixture.detectChanges();
  return { fixture, view: fixture.componentInstance, host: fixture.nativeElement, http, range };
}

/** The single in-flight request, asserted to carry the view's own range. */
async function pending<T>(mounted: Mounted<T>, route: TelemetryRoute) {
  await settle();
  const request = mounted.http.expectOne((candidate) => candidate.url.endsWith(`/${route}`));
  assert(
    request.request.params.get('from') === mounted.range.from &&
      request.request.params.get('to') === mounted.range.to,
    `${route}: requested ${request.request.params.get('from')}..${request.request.params.get('to')}, expected ${mounted.range.from}..${mounted.range.to}`,
  );
  return request;
}

/**
 * Answers the in-flight request and settles the view.
 *
 * Two rounds of change detection: the first delivers the answer to the resource,
 * the second renders the state it resolved to. One round leaves the view showing
 * `loading` and would make every assertion below read as a dropped row.
 */
async function answer<T>(mounted: Mounted<T>, route: TelemetryRoute, body: object): Promise<void> {
  (await pending(mounted, route)).flush(body);
  for (let round = 0; round < 2; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
  }
  mounted.fixture.detectChanges();
}

/** Fails the in-flight request with a served static reason, and settles. */
async function reject<T>(mounted: Mounted<T>, route: TelemetryRoute): Promise<void> {
  (await pending(mounted, route)).flush(
    { error: FAILURE_REASON },
    { status: 500, statusText: 'Server Error' },
  );
  for (let round = 0; round < 2; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
  }
  mounted.fixture.detectChanges();
}

/** Nothing may be left in flight when a case ends. */
function finish<T>(mounted: Mounted<T>): void {
  mounted.http.verify();
}

// --- Reading the DOM -------------------------------------------------------

function text(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

/**
 * The view's single rendered state.
 *
 * Throws when the count is anything other than one, which is the assertion:
 * zero means the view rendered no state at all, two means the loaded body and
 * the rail are both up.
 */
function renderedState(host: HTMLElement): string {
  const marked = Array.from(host.querySelectorAll('[data-view-state]'));
  const kinds = marked.map((element) => element.getAttribute('data-view-state') ?? '?');
  assert(
    marked.length === 1,
    `expected exactly one [data-view-state] element, saw ${marked.length} [${kinds.join(', ')}]`,
  );
  return kinds[0];
}

interface RenderedRow {
  readonly label: string;
  readonly folded: boolean;
  readonly cells: readonly string[];
}

interface RenderedTable {
  readonly title: string;
  readonly labelHeading: string;
  readonly columns: readonly string[];
  readonly rows: readonly RenderedRow[];
  readonly labels: readonly string[];
}

/** Every `admin-group-table` the view rendered, in document order. */
function renderedTables(host: HTMLElement): RenderedTable[] {
  return Array.from(host.querySelectorAll('admin-group-table')).map((card) => {
    const headings = Array.from(card.querySelectorAll('thead th')).map(text);
    const rows: RenderedRow[] = Array.from(card.querySelectorAll('tbody tr')).map((row) => ({
      // The first span of the label cell is the label; a second one, when
      // present, is the fold marker.
      label: text(row.querySelector('.admin-table__label > span')),
      folded: row.querySelector('.admin-table__fold') !== null,
      cells: Array.from(row.querySelectorAll('td')).map(text),
    }));
    return {
      title: text(card.querySelector('.admin-card__title')),
      labelHeading: headings[0] ?? '',
      columns: headings.slice(1),
      rows,
      labels: rows.map((row) => row.label),
    };
  });
}

/** The rendered tables keyed by their card title. */
function tablesByTitle(host: HTMLElement): Map<string, RenderedTable> {
  return new Map(renderedTables(host).map((table) => [table.title, table]));
}

/** One rendered table, or a throw naming what was actually rendered. */
function table(host: HTMLElement, title: string): RenderedTable {
  const found = tablesByTitle(host).get(title);
  assert(
    found !== undefined,
    `no table titled "${title}"; rendered [${renderedTables(host)
      .map((candidate) => candidate.title)
      .join(', ')}]`,
  );
  return found as RenderedTable;
}

interface RenderedStat {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/** Every stat card the overview rendered, in document order. */
function renderedStats(host: HTMLElement): RenderedStat[] {
  return Array.from(host.querySelectorAll('.admin-stat')).map((card) => ({
    label: text(card.querySelector('.admin-stat__label span')),
    value: text(card.querySelector('.admin-stat__value')),
    note: text(card.querySelector('.admin-stat__note')),
  }));
}

/** The retry control of the failed state, which only that state renders. */
function retryButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-view-state="failed"] button');
  assert(button !== null, 'the failed state rendered no retry control');
  return button as HTMLButtonElement;
}

// --- Generators ------------------------------------------------------------

/**
 * A group label as the Admin_API produces them: country codes, region names,
 * app versions, locales, runtime modes, Counter_Catalog names, the k-anonymity
 * `other` row, plus arbitrary shapes around them.
 *
 * No whitespace in the alphabet on purpose: the DOM readers above trim, so a
 * generated label with a leading or trailing space would fail on the reader
 * rather than on the view.
 */
const labelArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'US',
      'DE',
      'JP',
      'BR',
      'unknown',
      OTHER_GROUP_LABEL,
      'north-america',
      'europe',
      'en-US',
      'de-DE',
      'win32',
      'macos',
      'desktop',
      'browser',
      '0.2.0-beta.10',
      'session.started',
      'run.completed',
      'node.created:agent',
      'panel.opened:runs',
      'assistant.invoked:agent',
    ),
  },
  { weight: 2, arbitrary: fc.stringMatching(/^[A-Za-z][A-Za-z0-9._:-]{0,14}$/) },
);

/** Counter values live inside the range the Worker accepts. */
const metricArb: fc.Arbitrary<number> = fc.nat({ max: 1_000_000 });

/**
 * Distinct-labelled group rows. Distinct because `GroupTable` tracks rows by
 * label, and a duplicate track key is an Angular error rather than a view
 * defect - the property is about dropped rows, not about `@for` internals.
 */
function groupRowsArb(
  options: { minLength: number; maxLength: number; metrics?: readonly string[] },
): fc.Arbitrary<GroupRow[]> {
  const metrics = options.metrics ?? [];
  return fc
    .uniqueArray(
      fc.tuple(labelArb, metricArb, fc.array(metricArb, { minLength: metrics.length, maxLength: metrics.length })),
      {
        minLength: options.minLength,
        maxLength: options.maxLength,
        selector: ([label]) => label,
      },
    )
    .map((entries) =>
      entries.map(([label, installs, extra]) => {
        const row: GroupRow = { label, installs };
        metrics.forEach((metric, index) => {
          row[metric] = extra[index];
        });
        return row;
      }),
    );
}

/**
 * A real `YYYY-MM-DD` day.
 *
 * `noInvalidDate` is REQUIRED: `fc.date()` generates `new Date(NaN)` even inside
 * a min/max window unless it is set, and `toISOString()` on that throws.
 */
const metricDayArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2025-01-01T00:00:00Z'),
    max: new Date('2027-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

const RANGE: DateRange = { from: '2026-01-01', to: '2026-01-30' };

// --- The property ----------------------------------------------------------

describe('Property: every group label in a generated response reaches the DOM', () => {
  it(
    'renders every country and region label the geography response carried',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(
          fc
            .tuple(
              groupRowsArb({ minLength: 0, maxLength: 6, metrics: ['runs'] }),
              groupRowsArb({ minLength: 0, maxLength: 6, metrics: ['runs'] }),
            )
            // Both groupings empty is the empty state, which renders no labels
            // by design (10.13) and is covered by an example below.
            .filter(([countries, regions]) => countries.length + regions.length > 0),
          async ([countries, regions]) => {
            iterations += 1;
            const mounted = mount(Geography);
            const body: GeographyResponse = { range: RANGE, countries, regions };
            await answer(mounted, 'geography', body);

            assert(renderedState(mounted.host) === 'loaded', 'geography did not render loaded');
            assertSameLabels(
              table(mounted.host, 'By country').labels,
              countries.map((row) => row.label),
              'geography countries',
            );
            assertSameLabels(
              table(mounted.host, 'By region').labels,
              regions.map((row) => row.label),
              'geography regions',
            );
            finish(mounted);
          },
        ),
        { numRuns: RUNS },
      );
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'renders every label of all four environment groupings',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(
          fc
            .record({
              appVersion: groupRowsArb({ minLength: 0, maxLength: 5 }),
              platform: groupRowsArb({ minLength: 0, maxLength: 5 }),
              runtimeMode: groupRowsArb({ minLength: 0, maxLength: 3 }),
              locale: groupRowsArb({ minLength: 0, maxLength: 5 }),
            })
            .filter((groups) =>
              ENVIRONMENT_SECTIONS.some((section) => groups[section.key].length > 0),
            ),
          async (groups) => {
            iterations += 1;
            const mounted = mount(Environment);
            const body: EnvironmentResponse = { range: RANGE, ...groups };
            await answer(mounted, 'environment', body);

            assert(renderedState(mounted.host) === 'loaded', 'environment did not render loaded');
            const rendered = renderedTables(mounted.host);
            assert(
              rendered.length === ENVIRONMENT_SECTIONS.length,
              `expected ${ENVIRONMENT_SECTIONS.length} groupings, rendered ${rendered.length}`,
            );
            // Per grouping, so a section that dropped its rows cannot hide
            // behind another section that kept them.
            for (const section of ENVIRONMENT_SECTIONS) {
              assertSameLabels(
                table(mounted.host, section.title).labels,
                groups[section.key].map((row) => row.label),
                `environment ${section.key}`,
              );
            }
            finish(mounted);
          },
        ),
        { numRuns: RUNS },
      );
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'renders every counter name the features response carried',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.record({ label: labelArb, total: metricArb, installs: metricArb }),
            { minLength: 1, maxLength: 8, selector: (row) => row.label },
          ),
          async (counters: FeatureRow[]) => {
            iterations += 1;
            const mounted = mount(Features);
            const body: FeaturesResponse = { range: RANGE, counters };
            await answer(mounted, 'features', body);

            assert(renderedState(mounted.host) === 'loaded', 'features did not render loaded');
            assertSameLabels(
              table(mounted.host, 'Counter totals').labels,
              counters.map((row) => row.label),
              'features counters',
            );
            finish(mounted);
          },
        ),
        { numRuns: RUNS },
      );
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'lists every reported day in the table and plots every day except the folded row',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            days: fc.uniqueArray(
              fc.record({
                label: metricDayArb,
                installs: metricArb,
                sessions: metricArb,
                runs: metricArb,
              }),
              { minLength: 1, maxLength: 8, selector: (day) => day.label },
            ),
            // The k-anonymity fold is present about half the time, since its
            // row is the one the plot has to exclude and the table has to keep.
            folded: fc.option(
              fc.record({ installs: metricArb, sessions: metricArb, runs: metricArb }),
              { nil: null },
            ),
            foldedDays: fc.nat({ max: 30 }),
          }),
          async ({ days, folded, foldedDays }) => {
            iterations += 1;
            const reported: TrendDay[] =
              folded === null ? days : [...days, { label: OTHER_GROUP_LABEL, ...folded }];
            // The chart is a canvas, so the defer is left un-played here and the
            // plotted series is read from `chartData()` instead.
            const mounted = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
            const body: TrendResponse = { range: RANGE, days: reported, foldedDays };
            await answer(mounted, 'trend', body);

            assert(renderedState(mounted.host) === 'loaded', 'trend did not render loaded');
            // Every reported row, including the fold, is in the day table.
            assertSameLabels(
              table(mounted.host, 'Days').labels,
              reported.map((day) => day.label),
              'trend days',
            );
            // The plot carries the real days and never the fold.
            const plotted = (mounted.view.chartData().labels ?? []) as string[];
            assertSameLabels(
              plotted,
              days.map((day) => day.label),
              'trend plot',
            );
            finish(mounted);
          },
        ),
        { numRuns: RUNS },
      );
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

// --- Examples: one rendering per view --------------------------------------

describe('Overview view (10.5)', () => {
  const SUMMARY: SummaryResponse = {
    range: RANGE,
    activeInstalls: { d1: 11, d7: 222, d30: 3333 },
    totals: { installs: 4444, sessions: 55_555, runs: 666, runsCompleted: 77, runErrors: 8 },
  };

  it('renders active installs for 1, 7 and 30 days plus the range totals', async () => {
    const mounted = mount(Overview);
    await answer(mounted, 'summary', SUMMARY);

    expect(renderedState(mounted.host)).toBe('loaded');
    // Label, formatted value and caption for all eight numbers 10.5 names.
    expect(renderedStats(mounted.host)).toEqual([
      { label: 'Last 24 hours', value: '11', note: 'Trailing 1 day' },
      { label: 'Last 7 days', value: '222', note: 'Trailing 7 days' },
      { label: 'Last 30 days', value: '3,333', note: 'Trailing 30 days' },
      { label: 'Installs', value: '4,444', note: 'Distinct installs in range' },
      { label: 'Sessions', value: '55,555', note: 'Sessions started' },
      { label: 'Runs', value: '666', note: 'Runs started' },
      { label: 'Runs completed', value: '77', note: 'Runs that settled' },
      { label: 'Error events', value: '8', note: 'Run errors reported' },
    ]);
    // The selected range is stated, so the totals cannot be misread.
    expect(text(mounted.host.querySelector('.admin-view__range'))).toBe(
      `${mounted.range.from} to ${mounted.range.to}`,
    );
    finish(mounted);
  });

  it('renders exactly one state across loading, loaded, empty and failed', async () => {
    const loading = mount(Overview);
    expect(renderedState(loading.host)).toBe('loading');
    await answer(loading, 'summary', SUMMARY);
    expect(renderedState(loading.host)).toBe('loaded');
    finish(loading);

    const empty = mount(Overview);
    await answer(empty, 'summary', {
      range: RANGE,
      activeInstalls: { d1: 0, d7: 0, d30: 0 },
      totals: { installs: 0, sessions: 0, runs: 0, runsCompleted: 0, runErrors: 0 },
    } satisfies SummaryResponse);
    expect(renderedState(empty.host)).toBe('empty');
    expect(renderedStats(empty.host)).toEqual([]);
    finish(empty);

    const failed = mount(Overview);
    await reject(failed, 'summary');
    expect(renderedState(failed.host)).toBe('failed');
    expect(text(failed.host.querySelector('.admin-view-state__message'))).toBe(FAILURE_REASON);
    expect(VIEW_FAILURE_FALLBACK).not.toBe(FAILURE_REASON);
    finish(failed);
  });

  it('re-issues its own request from the retry control on the failed state', async () => {
    const mounted = mount(Overview);
    await reject(mounted, 'summary');
    expect(renderedState(mounted.host)).toBe('failed');

    retryButton(mounted.host).click();
    mounted.fixture.detectChanges();

    // A retry is a fresh request for the same range, and the view is back to
    // loading rather than sitting on the stale error.
    expect(renderedState(mounted.host)).toBe('loading');
    await answer(mounted, 'summary', SUMMARY);
    expect(renderedState(mounted.host)).toBe('loaded');
    expect(renderedStats(mounted.host).length).toBe(8);
    finish(mounted);
  });
});

describe('Geography view (10.6)', () => {
  const GEOGRAPHY: GeographyResponse = {
    range: RANGE,
    countries: [
      { label: 'DE', installs: 12, runs: 90 },
      { label: 'US', installs: 41, runs: 610 },
      { label: OTHER_GROUP_LABEL, installs: 7, runs: 22 },
    ],
    regions: [
      { label: 'europe', installs: 12, runs: 90 },
      { label: 'north-america', installs: 41, runs: 610 },
    ],
  };

  it('renders installs and runs grouped by country and by region', async () => {
    const mounted = mount(Geography);
    await answer(mounted, 'geography', GEOGRAPHY);

    expect(renderedState(mounted.host)).toBe('loaded');

    const countries = table(mounted.host, 'By country');
    expect(countries.labelHeading).toBe('Country');
    expect(countries.columns).toEqual(['Installs', 'Runs']);
    // Ordered by reach, and the folded row is kept and marked.
    expect(countries.labels).toEqual(['US', 'DE', OTHER_GROUP_LABEL]);
    expect(countries.rows.map((row) => row.cells)).toEqual([
      ['41', '610'],
      ['12', '90'],
      ['7', '22'],
    ]);
    expect(countries.rows.filter((row) => row.folded).map((row) => row.label)).toEqual([
      OTHER_GROUP_LABEL,
    ]);

    const regions = table(mounted.host, 'By region');
    expect(regions.labelHeading).toBe('Region');
    expect(regions.labels).toEqual(['north-america', 'europe']);
    finish(mounted);
  });

  it('renders exactly one state across loading, loaded, empty and failed', async () => {
    const loading = mount(Geography);
    expect(renderedState(loading.host)).toBe('loading');
    await answer(loading, 'geography', GEOGRAPHY);
    expect(renderedState(loading.host)).toBe('loaded');
    finish(loading);

    const empty = mount(Geography);
    await answer(empty, 'geography', { range: RANGE, countries: [], regions: [] });
    expect(renderedState(empty.host)).toBe('empty');
    expect(renderedTables(empty.host)).toEqual([]);
    finish(empty);

    const failed = mount(Geography);
    await reject(failed, 'geography');
    expect(renderedState(failed.host)).toBe('failed');
    retryButton(failed.host).click();
    failed.fixture.detectChanges();
    await answer(failed, 'geography', GEOGRAPHY);
    expect(renderedState(failed.host)).toBe('loaded');
    finish(failed);
  });
});

describe('Environment view (10.7)', () => {
  const ENVIRONMENT: EnvironmentResponse = {
    range: RANGE,
    appVersion: [
      { label: '0.2.0-beta.10', installs: 30 },
      { label: '0.2.0-beta.9', installs: 4 },
    ],
    platform: [
      { label: 'win32', installs: 20 },
      { label: 'macos', installs: 14 },
    ],
    runtimeMode: [
      { label: 'desktop', installs: 31 },
      { label: 'browser', installs: 3 },
    ],
    locale: [{ label: 'en-US', installs: 34 }],
  };

  it('renders installs grouped by app version, platform, runtime mode and locale', async () => {
    const mounted = mount(Environment);
    await answer(mounted, 'environment', ENVIRONMENT);

    expect(renderedState(mounted.host)).toBe('loaded');

    const rendered = renderedTables(mounted.host);
    // The four groupings are driven off ENVIRONMENT_SECTIONS, so the expected
    // titles and headings are derived rather than restated.
    expect(rendered.map((group) => group.title)).toEqual(
      ENVIRONMENT_SECTIONS.map((section) => section.title),
    );
    expect(rendered.map((group) => group.labelHeading)).toEqual(
      ENVIRONMENT_SECTIONS.map((section) => section.heading),
    );

    for (const section of ENVIRONMENT_SECTIONS) {
      const group = table(mounted.host, section.title);
      expect(group.columns).toEqual(['Installs']);
      expect(group.labels).toEqual(
        [...ENVIRONMENT[section.key]]
          .sort((a, b) => b.installs - a.installs)
          .map((row) => row.label),
      );
    }
    expect(table(mounted.host, 'By locale').rows.map((row) => row.cells)).toEqual([['34']]);
    finish(mounted);
  });

  it('renders exactly one state across loading, loaded, empty and failed', async () => {
    const loading = mount(Environment);
    expect(renderedState(loading.host)).toBe('loading');
    await answer(loading, 'environment', ENVIRONMENT);
    expect(renderedState(loading.host)).toBe('loaded');
    finish(loading);

    const empty = mount(Environment);
    await answer(empty, 'environment', {
      range: RANGE,
      appVersion: [],
      platform: [],
      runtimeMode: [],
      locale: [],
    } satisfies EnvironmentResponse);
    expect(renderedState(empty.host)).toBe('empty');
    finish(empty);

    const failed = mount(Environment);
    await reject(failed, 'environment');
    expect(renderedState(failed.host)).toBe('failed');
    retryButton(failed.host).click();
    failed.fixture.detectChanges();
    await answer(failed, 'environment', ENVIRONMENT);
    expect(renderedState(failed.host)).toBe('loaded');
    expect(renderedTables(failed.host).length).toBe(ENVIRONMENT_SECTIONS.length);
    finish(failed);
  });
});

describe('Features view (10.8)', () => {
  const FEATURES: FeaturesResponse = {
    range: RANGE,
    counters: [
      { label: 'run.completed', total: 120, installs: 18 },
      { label: 'session.started', total: 940, installs: 34 },
      { label: 'node.created:agent', total: 260, installs: 21 },
    ],
  };

  it('renders summed counter values grouped by counter name, ordered by total', async () => {
    const mounted = mount(Features);
    await answer(mounted, 'features', FEATURES);

    expect(renderedState(mounted.host)).toBe('loaded');

    const counters = table(mounted.host, 'Counter totals');
    expect(counters.labelHeading).toBe('Counter');
    expect(counters.columns).toEqual(['Total', 'Installs']);
    expect(counters.labels).toEqual(['session.started', 'node.created:agent', 'run.completed']);
    expect(counters.rows.map((row) => row.cells)).toEqual([
      ['940', '34'],
      ['260', '21'],
      ['120', '18'],
    ]);
    finish(mounted);
  });

  it('renders exactly one state across loading, loaded, empty and failed', async () => {
    const loading = mount(Features);
    expect(renderedState(loading.host)).toBe('loading');
    await answer(loading, 'features', FEATURES);
    expect(renderedState(loading.host)).toBe('loaded');
    finish(loading);

    const empty = mount(Features);
    await answer(empty, 'features', { range: RANGE, counters: [] });
    expect(renderedState(empty.host)).toBe('empty');
    finish(empty);

    const failed = mount(Features);
    await reject(failed, 'features');
    expect(renderedState(failed.host)).toBe('failed');
    retryButton(failed.host).click();
    failed.fixture.detectChanges();
    await answer(failed, 'features', FEATURES);
    expect(renderedState(failed.host)).toBe('loaded');
    finish(failed);
  });
});

describe('Trend view (10.9)', () => {
  const TREND: TrendResponse = {
    range: RANGE,
    days: [
      { label: '2026-01-03', installs: 9, sessions: 22, runs: 31 },
      { label: '2026-01-01', installs: 7, sessions: 15, runs: 20 },
      { label: OTHER_GROUP_LABEL, installs: 3, sessions: 4, runs: 5 },
      { label: '2026-01-02', installs: 8, sessions: 19, runs: 24 },
    ],
    foldedDays: 4,
  };

  it('renders per-day installs, sessions and runs, with the fold off the plot', async () => {
    const mounted = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
    await answer(mounted, 'trend', TREND);

    expect(renderedState(mounted.host)).toBe('loaded');

    const days = table(mounted.host, 'Days');
    expect(days.labelHeading).toBe('Day');
    expect(days.columns).toEqual(['Installs', 'Sessions', 'Runs']);
    // Metric_Day order, with the fold pinned last and still listed.
    expect(days.labels).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      OTHER_GROUP_LABEL,
    ]);
    expect(days.rows.map((row) => row.cells)).toEqual([
      ['7', '15', '20'],
      ['8', '19', '24'],
      ['9', '22', '31'],
      ['3', '4', '5'],
    ]);
    expect(days.rows.filter((row) => row.folded).map((row) => row.label)).toEqual([
      OTHER_GROUP_LABEL,
    ]);

    // The plot excludes the fold. Asserted on the data handed to `p-chart`,
    // because the chart itself is a canvas with no readable labels.
    const chart = mounted.view.chartData();
    expect(chart.labels).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(chart.datasets.map((set) => set.label)).toEqual(['Installs', 'Sessions', 'Runs']);
    expect(chart.datasets.map((set) => set.data)).toEqual([
      [7, 8, 9],
      [15, 19, 22],
      [20, 24, 31],
    ]);

    // foldedDays renders as a footnote naming the count.
    const footnote = text(mounted.host.querySelector('[data-trend-folded]'));
    expect(footnote).toContain('4 day(s)');
    expect(footnote).toContain(OTHER_GROUP_LABEL);
    finish(mounted);
  });

  it('omits the folded-days footnote when nothing was folded', async () => {
    const mounted = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
    await answer(mounted, 'trend', {
      range: RANGE,
      days: [{ label: '2026-01-01', installs: 2, sessions: 3, runs: 4 }],
      foldedDays: 0,
    } satisfies TrendResponse);

    expect(renderedState(mounted.host)).toBe('loaded');
    expect(mounted.host.querySelector('[data-trend-folded]')).toBeNull();
    finish(mounted);
  });

  it('mounts the deferred chart once the range has data', async () => {
    // The one case that lets `@defer (on immediate)` play through: chart.js
    // loads asynchronously, so what is asserted is that the deferred `p-chart`
    // reaches the DOM inside the chart container, not anything it paints.
    const mounted = mount(Trend);
    await answer(mounted, 'trend', TREND);
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    const container = mounted.host.querySelector('.admin-chart');
    expect(container).not.toBeNull();
    expect(container?.querySelector('p-chart')).not.toBeNull();
    finish(mounted);
  });

  it('renders exactly one state across loading, loaded, empty and failed', async () => {
    const loading = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
    expect(renderedState(loading.host)).toBe('loading');
    await answer(loading, 'trend', TREND);
    expect(renderedState(loading.host)).toBe('loaded');
    finish(loading);

    const empty = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
    await answer(empty, 'trend', { range: RANGE, days: [], foldedDays: 0 });
    expect(renderedState(empty.host)).toBe('empty');
    finish(empty);

    const failed = mount(Trend, { deferBlocks: DeferBlockBehavior.Manual });
    await reject(failed, 'trend');
    expect(renderedState(failed.host)).toBe('failed');
    retryButton(failed.host).click();
    failed.fixture.detectChanges();
    await answer(failed, 'trend', TREND);
    expect(renderedState(failed.host)).toBe('loaded');
    finish(failed);
  });
});
