// Feature: telemetry-phone-home, Property 35: A range change refetches every bound view
//
// For any sequence of date-range changes, each view bound to the range issues
// exactly one request per change plus one for its initial load, and every issued
// request carries the range in effect at the time it was issued.
//
// Validates: Requirements 10.10
//
// The interesting half of 10.10 is not "a change refetches" - it is that the
// count is EXACT in both directions, over any sequence of writes:
//
//   - a real change refetches every bound view exactly once, never twice, and
//     never four of the five;
//   - a write that changes nothing - a half-typed date the Admin_API would answer
//     400 for, or a value identical to the selected one - refetches NOTHING and
//     leaves the shared signal untouched;
//   - every request carries the range in effect when it was issued, not a
//     neighbouring one from earlier in the sequence.
//
// Writes go through the real shell (`App.selectPreset`, `App.onFromInput`,
// `App.onToInput`), so the property covers the control a visitor actually
// operates, including the draft signals that keep a half-typed date away from the
// shared range. The shell is instantiated in an injection context rather than
// rendered: the property is about what reaches the wire, and the header markup is
// not part of that claim (the auth switch below is rendered, because there the
// markup IS the claim).
//
// A bound view is modelled by `BoundViewProbe`, which owns the same binding the
// five real views own - `resource({ params: () => dateRange.range(), loader: ...
// })` over one Admin_API route - and nothing else. Five probes, one per route, so
// "every bound view" is five observations per step rather than one. The bridging
// example at the bottom mounts the real `Overview` and shows the same refetch, so
// the probe is not a story the property tells itself.
//
// Requests are counted through `HttpTestingController`, so what is asserted is
// what the transport saw, and `http.verify()` proves nothing was left in flight.
// Property assertions throw rather than using jasmine `expect`, so fast-check can
// shrink to a minimal counterexample.

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, inject, input, resource } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import fc from 'fast-check';
import { BehaviorSubject } from 'rxjs';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';
import { ClerkService } from 'ngx-clerk';

import { App, RANGE_REJECTED_MESSAGE } from './app';
import {
  DateRangeService,
  MAX_RANGE_DAYS,
  RANGE_PRESET_DAYS,
  type RangePresetDays,
} from './core/date-range.service';
import {
  TELEMETRY_ROUTES,
  type DateRange,
  type SummaryResponse,
  type TelemetryRoute,
} from './core/models';
import {
  SESSION_TOKEN_RESOLVER,
  TelemetryApiService,
  type AdminResult,
} from './core/telemetry-api.service';
import { unwrapAdminResult } from './views/view-data';
import { Overview } from './views/overview/overview';

/** Minimum iterations mandated for every property test in this feature. */
const RUNS = 100;

/** Each iteration rebuilds a TestBed and walks up to five writes. */
const PROPERTY_TIMEOUT_MS = 120_000;

/** Any non-blank token: this file is not about the bearer (that is Property 33). */
const TOKEN = 'sess_live_token';

/** The trailing window the dashboard opens on, restated rather than imported. */
const OPENING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

// --- Assertions ------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// --- The range rules, re-derived -------------------------------------------
//
// The model needs its own date maths and its own validity rule, or it would only
// prove `DateRangeService` agrees with itself. Only the numeric bound is shared,
// because a bound restated here could drift from the Admin_API's.

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayPlus(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The trailing `days` days ending today, inclusive. */
function trailing(days: number): DateRange {
  const to = todayUtc();
  return { from: dayPlus(to, 1 - days), to };
}

/** A real calendar day: `2026-02-30` matches the shape and is not a day. */
function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function inclusiveDays(range: DateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

/** Whether the Admin_API would accept this range, derived independently. */
function acceptable(range: DateRange): boolean {
  if (!isRealDay(range.from) || !isRealDay(range.to)) return false;
  if (range.from > range.to) return false;
  return inclusiveDays(range) <= MAX_RANGE_DAYS;
}

// --- A bound view ----------------------------------------------------------

/**
 * The five typed calls, keyed by route so a sixth route in `TELEMETRY_ROUTES`
 * without a call here fails to compile.
 */
const CALLS: Readonly<
  Record<
    TelemetryRoute,
    (api: TelemetryApiService, range: DateRange) => Promise<AdminResult<unknown>>
  >
> = {
  summary: (api, range) => api.fetchSummary(range),
  geography: (api, range) => api.fetchGeography(range),
  environment: (api, range) => api.fetchEnvironment(range),
  features: (api, range) => api.fetchFeatures(range),
  trend: (api, range) => api.fetchTrend(range),
};

/**
 * A view bound to the shared range, reduced to the binding that makes it bound.
 * `params` reads the range signal and NOTHING else - exactly what the five real
 * views do - so a refetch here happens for the same reason it happens there.
 */
@Component({
  selector: 'admin-test-bound-view',
  template: `<p>{{ route() }}</p>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class BoundViewProbe {
  /**
   * Not `input.required`: a required input read from the loader would throw if the
   * loader ever ran before the binding landed, which would read as a harness
   * failure rather than as data. The default is safe because the property asserts
   * the SET of routes requested, so a binding that did not land shows up as five
   * requests for the same route.
   */
  readonly route = input<TelemetryRoute>('summary');

  private readonly api = inject(TelemetryApiService);
  private readonly range = inject(DateRangeService).range;

  readonly data = resource({
    params: () => this.range(),
    loader: ({ params }) => CALLS[this.route()](this.api, params).then(unwrapAdminResult),
  });
}

/** One probe per Admin_API route, so every bound view is observed per step. */
@Component({
  selector: 'admin-test-bound-views',
  imports: [BoundViewProbe],
  template: `
    @for (route of routes; track route) {
      <admin-test-bound-view [route]="route" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class BoundViews {
  readonly routes = TELEMETRY_ROUTES;
}

/** Somewhere for the shell's outlet to land in the rendered examples. */
@Component({ selector: 'admin-test-routed', template: '<p>routed</p>' })
class RoutedStub {}

// --- Harness ---------------------------------------------------------------

/** Drains pending microtasks, including the resource loader's own awaits. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A `ClerkService` stand-in. No real Clerk instance is constructed: the auth
 * surfaces mount themselves off `clerk$`, and the shell reads `session$`.
 */
function fakeClerkService(options: { signedIn: boolean }): ClerkService {
  const instance = {
    signOut: () => Promise.resolve(),
    mountUserButton: () => undefined,
    unmountUserButton: () => undefined,
    mountSignIn: () => undefined,
    unmountSignIn: () => undefined,
  };
  return {
    clerk$: new BehaviorSubject(instance),
    session$: new BehaviorSubject(options.signedIn ? { id: 'sess_test' } : null),
  } as unknown as ClerkService;
}

interface Probes {
  readonly shell: App;
  readonly dateRange: DateRangeService;
  readonly http: HttpTestingController;
  readonly fixture: ComponentFixture<BoundViews>;
}

/**
 * A fresh shell and five fresh bound views over a recording backend. Rebuilt per
 * iteration so the range signal starts at the opening range every time.
 */
async function withProbes(body: (probes: Probes) => Promise<void>): Promise<void> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ClerkService, useValue: fakeClerkService({ signedIn: true }) },
      { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve(TOKEN) },
    ],
  });
  const probes: Probes = {
    // The shell's logic, without its markup: `selectPreset` and the two input
    // handlers are the writes 10.10 is about.
    shell: TestBed.runInInjectionContext(() => new App()),
    dateRange: TestBed.inject(DateRangeService),
    http: TestBed.inject(HttpTestingController),
    fixture: TestBed.createComponent(BoundViews),
  };
  await body(probes);
  // An unflushed request is a request that was issued and not accounted for.
  probes.http.verify();
}

/**
 * Everything the five probes asked for since the last drain, answered.
 *
 * Two rounds on purpose. The first flushes the view effects, so a changed range
 * reaches each `resource`, and gives the loader its microtasks. The second is
 * what catches a SECOND wave - a refetch the range change did not ask for - which
 * a single round would silently leave in the queue for `verify()` to blame on the
 * following step.
 */
async function drain(probes: Probes): Promise<TestRequest[]> {
  const seen: TestRequest[] = [];
  for (let round = 0; round < 2; round += 1) {
    probes.fixture.detectChanges();
    await settle();
    const requests = probes.http.match(() => true);
    for (const request of requests) request.flush({});
    seen.push(...requests);
  }
  return seen;
}

function routeOf(request: TestRequest): string {
  const url = request.request.url;
  return url.slice(url.lastIndexOf('/') + 1);
}

const SORTED_ROUTES = [...TELEMETRY_ROUTES].sort();

/** Exactly one request per bound view, each carrying `range`. */
function assertRefetchedEveryView(
  requests: readonly TestRequest[],
  range: DateRange,
  label: string,
): void {
  const routes = requests.map(routeOf).sort();
  assert(
    routes.length === SORTED_ROUTES.length && routes.every((r, i) => r === SORTED_ROUTES[i]),
    `${label}: expected one request per bound view [${SORTED_ROUTES.join(', ')}], saw [${routes.join(', ')}]`,
  );
  for (const request of requests) {
    const from = request.request.params.get('from');
    const to = request.request.params.get('to');
    assert(
      from === range.from && to === range.to,
      `${label}: ${routeOf(request)} asked for ${from}..${to}, expected ${range.from}..${range.to}`,
    );
  }
}

// --- The model -------------------------------------------------------------

/** One thing a visitor can do to the range control. */
type Step =
  | { readonly kind: 'preset'; readonly days: RangePresetDays }
  | { readonly kind: 'from'; readonly value: string }
  | { readonly kind: 'to'; readonly value: string };

function describeStep(step: Step): string {
  if (step.kind === 'preset') return `preset ${step.days}`;
  return `typed ${step.kind}=${JSON.stringify(step.value)}`;
}

/**
 * What the range control should hold: the shared range, what the two inputs hold,
 * and whether the last write was rejected.
 */
interface RangeModel {
  from: string;
  to: string;
  draftFrom: string;
  draftTo: string;
  rejected: boolean;
}

function openingModel(): RangeModel {
  const opening = trailing(OPENING_DAYS);
  return { ...opening, draftFrom: opening.from, draftTo: opening.to, rejected: false };
}

/**
 * A committed range. Each input resets to the shared value only when THAT end
 * changed: the inputs track `from` and `to` separately, so moving only the end
 * date leaves a typed start alone.
 */
function commit(model: RangeModel, next: DateRange): void {
  if (next.from !== model.from) {
    model.from = next.from;
    model.draftFrom = next.from;
  }
  if (next.to !== model.to) {
    model.to = next.to;
    model.draftTo = next.to;
  }
}

function applyToModel(model: RangeModel, step: Step): void {
  if (step.kind === 'preset') {
    commit(model, trailing(step.days));
    model.rejected = false;
    return;
  }
  if (step.kind === 'from') model.draftFrom = step.value;
  else model.draftTo = step.value;
  const drafted: DateRange = { from: model.draftFrom, to: model.draftTo };
  if (acceptable(drafted)) {
    commit(model, drafted);
    model.rejected = false;
    return;
  }
  // Rejected: the shared range is untouched, so nothing refetches.
  model.rejected = true;
}

/**
 * Drives the step through the real shell. The two typed steps go through a real
 * `change` event so `onFromInput` reads its value the way it does in the browser;
 * the element is a plain `<input>` rather than `type="date"`, because a date input
 * silently blanks a value like `2026-02-30` and the handler's own tolerance of
 * such a string is part of what is under test.
 */
function applyToShell(shell: App, step: Step): void {
  if (step.kind === 'preset') {
    shell.selectPreset(step.days);
    return;
  }
  const element = document.createElement('input');
  element.value = step.value;
  element.addEventListener('change', (event) =>
    step.kind === 'from' ? shell.onFromInput(event) : shell.onToInput(event),
  );
  element.dispatchEvent(new Event('change'));
}

// --- Generators ------------------------------------------------------------

const presetStepArb: fc.Arbitrary<Step> = fc
  .constantFrom<RangePresetDays>(...RANGE_PRESET_DAYS)
  .map((days): Step => ({ kind: 'preset', days }));

/**
 * Real days across four years, plus the shapes a date input can still hand over.
 *
 * `noInvalidDate` is REQUIRED: `fc.date()` generates `new Date(NaN)` even inside a
 * min/max window unless it is set, and `toISOString()` on that throws.
 */
const dayArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc
      .date({
        min: new Date('2024-01-01T00:00:00Z'),
        max: new Date('2027-12-31T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10)),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '',
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-1-1',
      '20260101',
      '2026-08-2',
      'tomorrow',
    ),
  },
);

const typedStepArb: fc.Arbitrary<Step> = fc
  .tuple(fc.constantFrom<'from' | 'to'>('from', 'to'), dayArb)
  .map(([kind, value]): Step => ({ kind, value }));

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 1, arbitrary: presetStepArb },
  { weight: 2, arbitrary: typedStepArb },
);

// --- The property ----------------------------------------------------------

describe('Property 35: A range change refetches every bound view', () => {
  it(
    'refetches every bound view exactly once per change, with the range in effect, and not at all otherwise',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 5 }), async (steps) => {
          iterations += 1;
          await withProbes(async (probes) => {
            const model = openingModel();
            const opening = probes.dateRange.range();
            assert(
              opening.from === model.from && opening.to === model.to,
              `opened on ${opening.from}..${opening.to}, expected ${model.from}..${model.to}`,
            );

            // "plus one for its initial load".
            assertRefetchedEveryView(await drain(probes), model, 'initial load');

            for (const step of steps) {
              const before: DateRange = { from: model.from, to: model.to };
              applyToModel(model, step);
              applyToShell(probes.shell, step);
              const requests = await drain(probes);
              const label = describeStep(step);

              const changed = model.from !== before.from || model.to !== before.to;
              if (changed) {
                assertRefetchedEveryView(requests, model, label);
              } else {
                assert(
                  requests.length === 0,
                  `${label}: the range did not change (${before.from}..${before.to}), yet ${requests.length} request(s) were issued`,
                );
              }

              // The shared signal is the only thing every view reads, so a write
              // that must not refetch is exactly a write that must not touch it.
              const live = probes.dateRange.range();
              assert(
                live.from === model.from && live.to === model.to,
                `${label}: shared range is ${live.from}..${live.to}, expected ${model.from}..${model.to}`,
              );
              assert(
                probes.shell.rangeRejected() === model.rejected,
                `${label}: rangeRejected is ${probes.shell.rangeRejected()}, expected ${model.rejected}`,
              );
            }
          });
        }),
        { numRuns: RUNS },
      );
      // The property asserts by throwing so fast-check can shrink; this records
      // that the input space was walked the mandated number of times.
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

// --- Examples: the range control -------------------------------------------

describe('App range control', () => {
  it('refetches every bound view when a preset changes the range', async () => {
    await withProbes(async (probes) => {
      assertRefetchedEveryView(await drain(probes), trailing(OPENING_DAYS), 'initial load');

      probes.shell.selectPreset(7);
      const refetched = await drain(probes);

      assertRefetchedEveryView(refetched, trailing(7), 'preset 7');
      expect(refetched.length).toBe(TELEMETRY_ROUTES.length);
      expect(probes.dateRange.days()).toBe(7);
      expect(probes.shell.rangeRejected()).toBe(false);
    });
  });

  it('leaves the shared range untouched and refetches nothing when a typed range is invalid', async () => {
    await withProbes(async (probes) => {
      await drain(probes);
      const selected = probes.dateRange.range();

      // A start after the end is one of the three shapes the Admin_API answers
      // 400 for; the drafted value stays in the input and goes no further.
      applyToShell(probes.shell, { kind: 'from', value: dayPlus(selected.to, 5) });

      expect(await drain(probes)).toEqual([]);
      expect(probes.dateRange.range()).toEqual(selected);
      expect(probes.shell.rangeRejected()).toBe(true);
      expect(probes.shell.draftFrom()).toBe(dayPlus(selected.to, 5));
      expect(RANGE_REJECTED_MESSAGE).toContain(String(MAX_RANGE_DAYS));
    });
  });

  it('refetches nothing when a typed range repeats the one already selected', async () => {
    await withProbes(async (probes) => {
      await drain(probes);
      const selected = probes.dateRange.range();

      applyToShell(probes.shell, { kind: 'from', value: selected.from });
      applyToShell(probes.shell, { kind: 'to', value: selected.to });

      expect(await drain(probes)).toEqual([]);
      expect(probes.dateRange.range()).toEqual(selected);
      // A no-op is accepted, so it is not a rejection.
      expect(probes.shell.rangeRejected()).toBe(false);
    });
  });

  it('refetches the real overview view when the range changes', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        providePrimeNG({ theme: { preset: Aura } }),
        { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve(TOKEN) },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const dateRange = TestBed.inject(DateRangeService);
    const fixture = TestBed.createComponent(Overview);

    const summary = (range: DateRange): SummaryResponse => ({
      range,
      activeInstalls: { d1: 1, d7: 2, d30: 3 },
      totals: { installs: 3, sessions: 4, runs: 5, runsCompleted: 5, runErrors: 0 },
    });

    // The overview's own summary, plus two enrichments: the previous-period summary
    // and the per-day trend. Every one of them must follow the range.
    const listed = (requests: TestRequest[]) =>
      requests
        .map((r) => `${routeOf(r)} ${r.request.params.get('from')}..${r.request.params.get('to')}`)
        .sort();
    const expected = (range: DateRange) => {
      const previous = TestBed.inject(DateRangeService).previousRange();
      return [
        `summary ${previous.from}..${previous.to}`,
        `summary ${range.from}..${range.to}`,
        `trend ${range.from}..${range.to}`,
      ].sort();
    };

    fixture.detectChanges();
    await settle();
    const first = http.match(() => true);
    expect(listed(first)).toEqual(expected(dateRange.range()));
    for (const request of first) request.flush(routeOf(request) === 'summary' ? summary(dateRange.range()) : { range: dateRange.range(), days: [], foldedDays: 0 });

    dateRange.applyPreset(7);
    fixture.detectChanges();
    await settle();
    const second = http.match(() => true);
    expect(listed(second)).toEqual(expected(trailing(7)));
    for (const request of second) request.flush(routeOf(request) === 'summary' ? summary(trailing(7)) : { range: trailing(7), days: [], foldedDays: 0 });

    fixture.detectChanges();
    await settle();
    http.verify();
  });

  /**
   * The rendered highlight, not the state behind it.
   *
   * Every other test here reads signals, and all of them passed while the
   * highlight was visibly stuck on the opening preset: `pButton` applies its
   * style classes imperatively and re-applies them only from the `label`,
   * `icon`, `iconPos` and `severity` setters, so the `[text]` flip that used to
   * carry the active look never reached the DOM. `aria-pressed` moved the whole
   * time, which is why the state assertions were no defence. Assert the class a
   * visitor can actually see.
   */
  it('moves the active preset highlight in the DOM, not only in aria-pressed', async () => {
    const fixture = await createShell({ signedIn: true });
    const host: HTMLElement = fixture.nativeElement;

    const presets = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('.admin-range__preset'));
    const highlighted = () =>
      presets()
        .filter((button) => button.classList.contains('admin-range__preset--active'))
        .map((button) => button.textContent?.trim());
    const pressed = () =>
      presets()
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent?.trim());

    expect(presets().length).toBe(RANGE_PRESET_DAYS.length);
    expect(highlighted()).toEqual([`${OPENING_DAYS} days`]);

    const seven = presets().find((button) => button.textContent?.includes('7 days'));
    expect(seven).toBeDefined();
    seven?.click();
    fixture.detectChanges();

    // Exactly one highlight, on the preset that is now selected, and the visible
    // state agrees with the announced one.
    expect(highlighted()).toEqual(['7 days']);
    expect(pressed()).toEqual(['7 days']);
    expect(TestBed.inject(DateRangeService).days()).toBe(7);
  });
});

// --- Examples: the auth switch ---------------------------------------------

async function createShell(options: { signedIn: boolean }): Promise<ComponentFixture<App>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: RoutedStub }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      providePrimeNG({ theme: { preset: Aura } }),
      { provide: ClerkService, useValue: fakeClerkService(options) },
      { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve(TOKEN) },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
  return fixture;
}

describe('App auth switch', () => {
  /** Anything that would say who IS allowed to read the dashboard (10.4). */
  const ALLOWLIST_TELLS = ['allowlist', 'allow list', 'owner', 'user_', 'sess_', '@', 'clerk'];

  it('renders the sign-in surface and no dashboard while there is no session', async () => {
    const fixture = await createShell({ signedIn: false });
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('admin-signed-out')).not.toBeNull();
    expect(host.querySelector('admin-not-authorized')).toBeNull();
    expect(host.querySelector('router-outlet')).toBeNull();
    expect(host.querySelector('.admin-shell')).toBeNull();
  });

  it('renders the not-authorized surface and no dashboard outlet after a 403', async () => {
    const fixture = await createShell({ signedIn: true });
    const http = TestBed.inject(HttpTestingController);
    const api = TestBed.inject(TelemetryApiService);
    const host: HTMLElement = fixture.nativeElement;

    // The dashboard is what a signed-in visitor sees until a route answers 403.
    expect(host.querySelector('router-outlet')).not.toBeNull();

    const call = api.fetchSummary(TestBed.inject(DateRangeService).range());
    await settle();
    http.expectOne((request) => request.url.endsWith('/summary')).flush(
      { error: 'Forbidden.' },
      { status: 403, statusText: 'Forbidden' },
    );
    await call;
    fixture.detectChanges();

    expect(api.forbidden()).toBe(true);
    expect(host.querySelector('admin-not-authorized')).not.toBeNull();
    // The gate, not a visibility toggle: with no outlet, no view can refetch.
    expect(host.querySelector('router-outlet')).toBeNull();
    expect(host.querySelector('.admin-shell')).toBeNull();
    expect(host.querySelector('admin-signed-out')).toBeNull();

    const copy = (host.textContent ?? '').toLowerCase();
    expect(copy).toContain('not authorized');
    for (const tell of ALLOWLIST_TELLS) {
      expect(copy).not.toContain(tell);
    }

    const actions = Array.from(host.querySelectorAll('button'));
    expect(actions.length).toBe(1);
    expect(actions[0].textContent ?? '').toContain('Sign out');

    http.verify();
  });
});
