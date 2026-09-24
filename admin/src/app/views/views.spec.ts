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
//   - The trend plot is asserted on `chartData()`, the reported days handed to
//     the SVG chart, plus the day table and the fold chip, which are in the DOM.
//     The rendering example asserts the SVG chart actually painted.
//
//   - Views also issue ENRICHMENT requests (the previous period, a sparkline
//     series). `pending` matches the view's own request by route AND range, and
//     `finish` fails whatever enrichments are left - they never fail the view.
//
// Property assertions throw rather than using jasmine `expect`, so fast-check can
// shrink to a minimal counterexample.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { DeferBlockBehavior, TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
import { paintShapes, unmappedInstalls } from './geography/world-map';
import type { WorldShape } from './geography/world-map.data';
import { formatRange } from './format';
import { Overview, OVERVIEW_PRIVACY_HINT } from './overview/overview';
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
      provideRouter([]),
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

/** The single in-flight request for `route` over `range` (the view's own range by default). */
async function pending<T>(mounted: Mounted<T>, route: TelemetryRoute, range: DateRange = mounted.range) {
  await settle();
  return mounted.http.expectOne(
    (candidate) =>
      candidate.url.endsWith(`/${route}`) &&
      candidate.params.get('from') === range.from &&
      candidate.params.get('to') === range.to,
    `${route} for ${range.from}..${range.to}`,
  );
}

/** Answers an enrichment request and settles, like {@link answer}. */
async function answerFor<T>(
  mounted: Mounted<T>,
  route: TelemetryRoute,
  range: DateRange,
  body: object,
): Promise<void> {
  (await pending(mounted, route, range)).flush(body);
  for (let round = 0; round < 2; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
  }
  mounted.fixture.detectChanges();
}

/** The previous-period range the view compares against. */
function previousRange(): DateRange {
  return TestBed.inject(DateRangeService).previousRange();
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

/** Fails any enrichment still in flight, then asserts nothing else is. */
function finish<T>(mounted: Mounted<T>): void {
  for (const request of mounted.http.match(() => true)) {
    request.flush({ error: 'not under test' }, { status: 500, statusText: 'Server Error' });
  }
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

describe('Property: world map shading is bounded, monotonic and honest about the unpaintable', () => {
  // A small fixed geometry rather than the real 173-country data: the claim is
  // about the shading maths in `paintShapes`, not about Natural Earth geometry.
  const FIXTURE_SHAPES: readonly WorldShape[] = [
    { code: 'US', name: 'United States', d: '' },
    { code: 'DE', name: 'Germany', d: '' },
    { code: 'JP', name: 'Japan', d: '' },
  ];
  const FIXTURE_CODES = new Set(FIXTURE_SHAPES.map((shape) => shape.code));

  /** A mix of codes the fixture can paint, codes it cannot (including the k-anonymity fold), and noise. */
  const mapLabelArb: fc.Arbitrary<string> = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom('US', 'DE', 'JP', OTHER_GROUP_LABEL, 'XX', 'ZZ') },
    { weight: 1, arbitrary: fc.stringMatching(/^[A-Za-z]{2,6}$/) },
  );

  const mapRowsArb: fc.Arbitrary<GroupRow[]> = fc
    .uniqueArray(fc.tuple(mapLabelArb, fc.nat({ max: 1_000_000 })), {
      minLength: 0,
      maxLength: 8,
      selector: ([label]) => label,
    })
    .map((entries) => entries.map(([label, installs]) => ({ label, installs }) satisfies GroupRow));

  it('paints one shape per known country, never above full opacity, monotonic in installs', () => {
    let iterations = 0;
    fc.assert(
      fc.property(mapRowsArb, (rows) => {
        iterations += 1;
        const painted = paintShapes(rows, FIXTURE_SHAPES);
        assert(
          painted.length === FIXTURE_SHAPES.length,
          `expected ${FIXTURE_SHAPES.length} painted shapes, got ${painted.length}`,
        );

        let maxInstalls = 0;
        for (const shape of painted) {
          assert(
            shape.opacity >= 0 && shape.opacity <= 1,
            `${shape.code}: opacity ${shape.opacity} out of range`,
          );
          assert(
            shape.installs === 0 ? shape.opacity === 0 : shape.opacity > 0,
            `${shape.code}: ${shape.installs} installs produced opacity ${shape.opacity}`,
          );
          maxInstalls = Math.max(maxInstalls, shape.installs);
        }
        if (maxInstalls > 0) {
          assert(
            painted
              .filter((shape) => shape.installs === maxInstalls)
              .every((shape) => shape.opacity === 1),
            'the busiest painted country did not reach full opacity',
          );
        }
        // More installs never paints a lower opacity than fewer installs.
        const byInstalls = [...painted].sort((a, b) => a.installs - b.installs);
        for (let i = 1; i < byInstalls.length; i += 1) {
          assert(
            byInstalls[i].opacity >= byInstalls[i - 1].opacity,
            `opacity fell from ${byInstalls[i - 1].installs} installs to ${byInstalls[i].installs}`,
          );
        }

        const expectedUnmapped = rows
          .filter((row) => !FIXTURE_CODES.has(row.label))
          .reduce((sum, row) => sum + row.installs, 0);
        const actualUnmapped = unmappedInstalls(rows, FIXTURE_SHAPES);
        assert(
          actualUnmapped === expectedUnmapped,
          `unmapped installs: got ${actualUnmapped}, expected ${expectedUnmapped}`,
        );
        return true;
      }),
      { numRuns: RUNS },
    );
    expect(iterations).toBe(RUNS);
  });
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
    // The range totals lead as KPIs, then the three trailing active windows.
    expect(renderedStats(mounted.host)).toEqual([
      { label: 'Installs', value: '4,444', note: '' },
      { label: 'Sessions', value: '55.6K', note: '' },
      { label: 'Runs', value: '666', note: '77 completed' },
      { label: 'Success rate', value: '12%', note: '' },
      { label: 'Error events', value: '8', note: '' },
      { label: 'Last 24 hours', value: '11', note: 'Trailing 1 day' },
      { label: 'Last 7 days', value: '222', note: 'Trailing 7 days' },
      { label: 'Last 30 days', value: '3,333', note: 'Trailing 30 days' },
    ]);
    // The selected range is stated, so the totals cannot be misread.
    expect(text(mounted.host.querySelector('.admin-view__range'))).toBe(formatRange(mounted.range));
    // The anonymity explainer is a tooltip now, still readable to assistive tech.
    expect(text(mounted.host.querySelector('admin-hint .admin-sr'))).toBe(OVERVIEW_PRIVACY_HINT);
    finish(mounted);
  });

  it('shows deltas against the previous period once that enrichment lands', async () => {
    const mounted = mount(Overview);
    await answer(mounted, 'summary', SUMMARY);
    expect(mounted.host.querySelector('[data-delta]')).toBeNull();

    await answerFor(mounted, 'summary', previousRange(), {
      ...SUMMARY,
      totals: { ...SUMMARY.totals, installs: 2222, runErrors: 16 },
    } satisfies SummaryResponse);

    const deltas = Array.from(mounted.host.querySelectorAll('[data-delta]')).map((el) => ({
      tone: el.getAttribute('data-delta'),
      text: text(el),
    }));
    // Installs doubled (good); errors halved, which is ALSO good because a fall is.
    expect(deltas[0]).toEqual({ tone: 'good', text: '+100%' });
    expect(deltas[deltas.length - 1]).toEqual({ tone: 'good', text: '-50%' });
    finish(mounted);
  });

  it('stays loaded when an enrichment request fails', async () => {
    const mounted = mount(Overview);
    await answer(mounted, 'summary', SUMMARY);
    (await pending(mounted, 'summary', previousRange())).flush(
      { error: FAILURE_REASON },
      { status: 500, statusText: 'Server Error' },
    );
    (await pending(mounted, 'trend')).flush({ error: FAILURE_REASON }, { status: 500, statusText: 'Server Error' });
    await settle();
    mounted.fixture.detectChanges();
    expect(renderedState(mounted.host)).toBe('loaded');
    expect(mounted.host.querySelector('[data-delta]')).toBeNull();
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

  it('paints the world map from the country grouping and shows a tooltip on hover', async () => {
    const mounted = mount(Geography);
    await answer(mounted, 'geography', GEOGRAPHY);
    // Let the map's own `@defer (on immediate)` block resolve, the same wait
    // the trend view's chart example uses.
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    const paths = mounted.host.querySelectorAll('admin-world-map path');
    expect(paths.length).toBeGreaterThan(0);

    const firstPath = paths[0] as SVGPathElement;
    firstPath.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    mounted.fixture.detectChanges();
    expect(mounted.host.querySelector('.admin-map__tooltip')).not.toBeNull();

    // The k-anonymity fold cannot be painted; it is called out, not dropped.
    const footnote = text(mounted.host.querySelector('[data-geography-unmapped]'));
    expect(footnote).toContain('7');

    // The bar list beside the map names the busiest real countries, `other` excluded.
    const bars = Array.from(
      mounted.host.querySelectorAll('.admin-map-row__list .admin-bars__item'),
    ).map((bar) => ({
      name: text(bar.querySelector('.admin-bars__label')),
      count: text(bar.querySelector('.admin-bars__value')),
    }));
    expect(bars).toEqual([
      { name: 'United States of America', count: '41' },
      { name: 'Germany', count: '12' },
    ]);
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

    // The plot excludes the fold.
    const chart = mounted.view.chartData();
    expect(chart.labels).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(chart.datasets.map((set) => set.label)).toEqual(['Installs', 'Sessions', 'Runs']);
    expect(chart.datasets.map((set) => set.data)).toEqual([
      [7, 8, 9],
      [15, 19, 22],
      [20, 24, 31],
    ]);

    // foldedDays renders as a chip naming the count.
    const chip = text(mounted.host.querySelector('[data-trend-folded]'));
    expect(chip).toContain('4 day(s)');
    expect(chip).toContain(OTHER_GROUP_LABEL);

    // Per-series KPIs total the plotted days only: the fold is not a day.
    expect(renderedStats(mounted.host).map((stat) => [stat.label, stat.value])).toEqual([
      ['Installs', '24'],
      ['Sessions', '56'],
      ['Runs', '75'],
    ]);
    finish(mounted);
  });

  it('omits the folded-days chip when nothing was folded', async () => {
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

  it('paints one line per series once the range has data', async () => {
    const mounted = mount(Trend);
    await answer(mounted, 'trend', TREND);
    // `whenStable` waits on every in-flight resource, so settle the enrichment first.
    await answerFor(mounted, 'trend', previousRange(), { range: previousRange(), days: [], foldedDays: 0 });
    await mounted.fixture.whenStable();
    mounted.fixture.detectChanges();

    const lines = mounted.host.querySelectorAll('.admin-chart admin-area-chart path.admin-area__line');
    expect(lines.length).toBe(3);
    for (const line of Array.from(lines)) {
      expect(line.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+C/);
    }
    // Legend chips carry each series total.
    const legend = Array.from(mounted.host.querySelectorAll('.admin-legend__chip')).map(
      (chip) => `${text(chip.querySelector('.admin-legend__label'))} ${text(chip.querySelector('.admin-legend__total'))}`,
    );
    expect(legend).toEqual(['Installs 24', 'Sessions 56', 'Runs 75']);
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
