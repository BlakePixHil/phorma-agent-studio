// Feature: telemetry-phone-home, Property 33: The dashboard sends a bearer token, or sends nothing at all
//
// For any sequence of Admin_API calls, every issued request carries the current
// Clerk session token as a bearer token; and for any sequence of view mounts and
// range changes performed while no Clerk session exists, no request is issued.
//
// Validates: Requirements 10.2, 10.3
//
// The property is a DISJUNCTION with no third case, which is what makes it worth
// testing over a generated input space rather than with two examples. For any
// resolver outcome at all - a real token, a blank or whitespace-only string,
// `null`, `undefined`, something that is not a string, a resolver that throws
// synchronously, a resolver that rejects - the observable behaviour must be one
// of exactly two things:
//
//   1. one request is issued, carrying a NON-EMPTY `Authorization: Bearer <t>`, or
//   2. no request is issued at all and the result is `no-session`.
//
// The forbidden third case is the interesting one: a request on the wire with a
// missing header, an empty header, or the bare string `Bearer `. Blank tokens are
// generated deliberately, because `Bearer ` + '' is a header that looks present
// and authorizes nothing. Assertions are made against the RECORDED requests
// (`HttpTestingController`), not against the service's return value, so a leak
// cannot hide behind a correct-looking result.
//
// Both seams the design names are used: the `SESSION_TOKEN_RESOLVER` provider is
// overridden for the token, so no Clerk instance is involved, and
// `provideHttpClientTesting` records the transport.
//
// Property assertions throw (rather than using jasmine `expect`) so fast-check
// can shrink to a minimal counterexample instead of merely recording a failure.

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { environment } from '../../environments/environment';
import { TELEMETRY_ROUTES, type DateRange, type TelemetryRoute } from './models';
import {
  FORBIDDEN,
  NO_SESSION,
  REQUEST_FAILURE_FALLBACK,
  SESSION_TOKEN_RESOLVER,
  TELEMETRY_ADMIN_PREFIX,
  TelemetryApiService,
  describeRequestFailure,
  isOk,
  type AdminResult,
  type SessionTokenResolver,
} from './telemetry-api.service';

/** Minimum iterations mandated for every property test in this feature. */
const RUNS = 200;

/** Sequences do up to 6 calls each, so a lower run count still clears the floor. */
const SEQUENCE_RUNS = 100;

/** Jasmine's 5s default is not enough for a TestBed rebuild per iteration. */
const PROPERTY_TIMEOUT_MS = 60_000;

// --- Assertions ------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The forbidden third case, stated once. A header is only acceptable when it is
 * literally `Bearer <non-blank>`; `null`, `''` and `'Bearer '` all fail here.
 */
function assertNonEmptyBearer(request: TestRequest, expected: string): void {
  const header = request.request.headers.get('Authorization');
  assert(header !== null, 'issued a request with NO Authorization header');
  const value = header ?? '';
  assert(value.startsWith('Bearer '), `Authorization header is not a bearer: ${JSON.stringify(value)}`);
  assert(value.slice('Bearer '.length).trim() !== '', 'issued a request with an EMPTY bearer token');
  assert(
    value === `Bearer ${expected}`,
    `bearer carried ${JSON.stringify(value)}, expected ${JSON.stringify(`Bearer ${expected}`)}`,
  );
}

// --- The five typed calls, enumerated from the route list -------------------

/**
 * Keyed by `TelemetryRoute` so adding a route to `TELEMETRY_ROUTES` without a
 * call here fails to compile. All five are exercised by every property.
 */
const CALLS: Readonly<
  Record<TelemetryRoute, (service: TelemetryApiService, range: DateRange) => Promise<AdminResult<unknown>>>
> = {
  summary: (service, range) => service.fetchSummary(range),
  geography: (service, range) => service.fetchGeography(range),
  environment: (service, range) => service.fetchEnvironment(range),
  features: (service, range) => service.fetchFeatures(range),
  trend: (service, range) => service.fetchTrend(range),
};

/** Any answer body is fine: the service does not inspect it, only its status. */
function bodyFor(range: DateRange): object {
  return { range };
}

// --- Resolver outcomes -----------------------------------------------------

/** How the resolver hands its value back, including the two failure shapes. */
type Delivery = 'resolveSync' | 'resolveAfterTick' | 'throwSync' | 'reject';

interface ResolverCase {
  readonly resolver: SessionTokenResolver;
  /** The bearer the request must carry, or `null` when nothing may be sent. */
  readonly expected: string | null;
  readonly label: string;
}

/**
 * The usable-token rule, derived independently of `toSessionToken` so the
 * property compares two derivations rather than restating the implementation.
 */
function usableToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function makeResolver(raw: unknown, delivery: Delivery): SessionTokenResolver {
  // The cast is the point: production types forbid these shapes, and the
  // property has to prove the service survives them anyway.
  return (() => {
    switch (delivery) {
      case 'throwSync':
        throw new Error('resolver threw before returning a promise');
      case 'reject':
        return Promise.reject(new Error('token refresh failed'));
      case 'resolveAfterTick':
        return Promise.resolve().then(() => raw);
      default:
        return Promise.resolve(raw);
    }
  }) as SessionTokenResolver;
}

/** Everything a resolver can hand back, valid and degenerate alike. */
const rawArb: fc.Arbitrary<unknown> = fc.oneof(
  // Realistic session tokens.
  fc.stringMatching(/^[A-Za-z0-9_-]{10,20}\.[A-Za-z0-9_-]{10,20}\.[A-Za-z0-9_-]{10,20}$/),
  // Any non-empty string: covers padded tokens, which must be sent trimmed.
  fc.string({ minLength: 1 }),
  // Blank shapes - the ones that would become the header `Bearer `.
  fc.constantFrom('', ' ', '\t', '\n', '   ', ' \t\n '),
  // Absent.
  fc.constant(null),
  fc.constant(undefined),
  // Not a string at all.
  fc.integer(),
  fc.boolean(),
  fc.constant({}),
  fc.constant({ jwt: 'looks-like-a-token' }),
  fc.constant([]),
  fc.constant(() => 'sneaky'),
);

const deliveryArb = fc.constantFrom<Delivery>(
  'resolveSync',
  'resolveAfterTick',
  'throwSync',
  'reject',
);

const resolverCaseArb: fc.Arbitrary<ResolverCase> = fc
  .tuple(rawArb, deliveryArb)
  .map(([raw, delivery]) => ({
    resolver: makeResolver(raw, delivery),
    expected: delivery === 'throwSync' || delivery === 'reject' ? null : usableToken(raw),
    label: `${delivery}:${JSON.stringify(raw) ?? String(raw)}`,
  }));

const routeArb = fc.constantFrom<TelemetryRoute>(...TELEMETRY_ROUTES);

/**
 * An inclusive `YYYY-MM-DD` range, the only shape the Admin_API accepts.
 *
 * `noInvalidDate` is REQUIRED: `fc.date()` generates `new Date(NaN)` even inside
 * a min/max window unless it is set, and `toISOString()` on that throws
 * `RangeError: Invalid time value` - a seed-dependent harness failure that has
 * nothing to do with the property.
 */
const rangeArb: fc.Arbitrary<DateRange> = fc
  .tuple(
    fc.date({
      min: new Date('2024-01-01T00:00:00Z'),
      max: new Date('2027-12-31T00:00:00Z'),
      noInvalidDate: true,
    }),
    fc.integer({ min: 0, max: 120 }),
  )
  .map(([start, span]) => {
    const from = start.toISOString().slice(0, 10);
    const end = new Date(start.getTime() + span * 86_400_000);
    return { from, to: end.toISOString().slice(0, 10) };
  });

// --- Harness ---------------------------------------------------------------

/** Drains every pending microtask, including the resolver's own awaits. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A fresh service over a recording backend and the given resolver. Rebuilt per
 * iteration so the `forbidden` signal and any resolver state start clean.
 */
async function withService<T>(
  resolver: SessionTokenResolver,
  body: (service: TelemetryApiService, http: HttpTestingController) => Promise<T>,
): Promise<T> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SESSION_TOKEN_RESOLVER, useValue: resolver },
    ],
  });
  const service = TestBed.inject(TelemetryApiService);
  const http = TestBed.inject(HttpTestingController);
  const outcome = await body(service, http);
  // Nothing may be left in flight: an unflushed request is a request that was
  // issued and not accounted for by the assertions above.
  http.verify();
  return outcome;
}

/**
 * Issues one call, then reports the requests the backend actually saw. Returns
 * before the answer so the wire can be inspected while the call is in flight.
 */
async function issue(
  service: TelemetryApiService,
  http: HttpTestingController,
  route: TelemetryRoute,
  range: DateRange,
): Promise<{ readonly result: Promise<AdminResult<unknown>>; readonly requests: TestRequest[] }> {
  const result = CALLS[route](service, range);
  await settle();
  return { result, requests: http.match(() => true) };
}

// --- The property ----------------------------------------------------------

describe('Property 33: The dashboard sends a bearer token, or sends nothing at all', () => {
  it(
    'either issues one request with a non-empty bearer, or issues nothing and reports no-session',
    async () => {
      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(routeArb, rangeArb, resolverCaseArb, async (route, range, tokenCase) => {
          iterations += 1;
          await withService(tokenCase.resolver, async (service, http) => {
            const { result, requests } = await issue(service, http, route, range);

            if (tokenCase.expected === null) {
              // Branch 2: no session, so nothing on the wire at all (10.3).
              assert(
                requests.length === 0,
                `issued ${requests.length} request(s) with no session (${tokenCase.label})`,
              );
              const settled = await result;
              assert(
                settled.kind === 'no-session',
                `expected no-session, got ${settled.kind} (${tokenCase.label})`,
              );
              return;
            }

            // Branch 1: exactly one request, carrying the current token (10.2).
            assert(
              requests.length === 1,
              `expected exactly 1 request, saw ${requests.length} (${tokenCase.label})`,
            );
            const request = requests[0];
            assertNonEmptyBearer(request, tokenCase.expected);
            assert(
              request.request.url === service.url(route),
              `requested ${request.request.url}, expected ${service.url(route)}`,
            );
            assert(request.request.method === 'GET', `method was ${request.request.method}`);
            // The range travels as query parameters, unmodified.
            assert(
              request.request.params.get('from') === range.from,
              `from was ${request.request.params.get('from')}, expected ${range.from}`,
            );
            assert(
              request.request.params.get('to') === range.to,
              `to was ${request.request.params.get('to')}, expected ${range.to}`,
            );

            request.flush(bodyFor(range));
            const settled = await result;
            assert(isOk(settled), `expected ok, got ${settled.kind}`);
          });
        }),
        { numRuns: RUNS },
      );
      // The property asserts by throwing so fast-check can shrink; this records
      // that the input space was actually walked the mandated number of times.
      expect(iterations).toBe(RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'carries the token in effect at the time of each call, across any sequence of calls and ranges',
    async () => {
      const stepArb = fc.record({
        route: routeArb,
        range: rangeArb,
        tokenCase: resolverCaseArb,
      });

      let iterations = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 6 }), async (steps) => {
          iterations += 1;
          // One resolver for the service's lifetime, delegating to whichever
          // outcome the current step installed. This is how a sign-out mid
          // session, or a token rotation between two range changes, is modelled.
          const box: { current: SessionTokenResolver } = { current: makeResolver(null, 'resolveSync') };
          const delegating = (() => box.current()) as SessionTokenResolver;

          await withService(delegating, async (service, http) => {
            let issued = 0;

            for (const step of steps) {
              box.current = step.tokenCase.resolver;
              const { result, requests } = await issue(service, http, step.route, step.range);

              if (step.tokenCase.expected === null) {
                assert(
                  requests.length === 0,
                  `issued ${requests.length} request(s) while signed out (${step.tokenCase.label})`,
                );
                const settled = await result;
                assert(settled.kind === 'no-session', `expected no-session, got ${settled.kind}`);
                continue;
              }

              assert(requests.length === 1, `expected 1 request, saw ${requests.length}`);
              issued += 1;
              // The bearer must be THIS step's token, not a cached earlier one.
              assertNonEmptyBearer(requests[0], step.tokenCase.expected);
              assert(
                requests[0].request.params.get('from') === step.range.from &&
                  requests[0].request.params.get('to') === step.range.to,
                'a request carried a range other than the one in effect',
              );
              requests[0].flush(bodyFor(step.range));
              await result;
            }

            const expectedIssued = steps.filter((step) => step.tokenCase.expected !== null).length;
            assert(
              issued === expectedIssued,
              `issued ${issued} requests, expected ${expectedIssued}`,
            );
          });
        }),
        { numRuns: SEQUENCE_RUNS },
      );
      expect(iterations).toBe(SEQUENCE_RUNS);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

// --- Examples: the outcomes the shell switches on --------------------------

describe('TelemetryApiService outcomes', () => {
  const RANGE: DateRange = { from: '2026-01-01', to: '2026-01-31' };
  const TOKEN = 'sess_live_token';

  function resolverFor(token: string | null): SessionTokenResolver {
    return () => Promise.resolve(token);
  }

  // The claim is the PREFIX and the path composition, not which host the
  // dashboard is pointed at. The expectation is therefore derived from the
  // configured base URL: it was once the literal `http://localhost:8787`, which
  // silently became a failing test the day `apiBaseUrl` moved to the deployed
  // Worker. Trailing slashes are stripped here for the same reason the service
  // strips them - a base URL is edited by hand and may carry one.
  const BASE = environment.apiBaseUrl.replace(/\/+$/, '');

  it('builds the route URL under the admin prefix', async () => {
    await withService(resolverFor(TOKEN), async (service) => {
      expect(service.url('summary')).toBe(`${BASE}${TELEMETRY_ADMIN_PREFIX}summary`);
      expect(service.url('trend')).toBe(`${BASE}${TELEMETRY_ADMIN_PREFIX}trend`);
      // The prefix itself is pinned separately: the two claims above would both
      // still hold if the prefix silently changed, since they derive from it.
      expect(TELEMETRY_ADMIN_PREFIX).toBe('/api/admin/telemetry/');
    });
  });

  it('answers forbidden and flips the forbidden signal on 403', async () => {
    await withService(resolverFor(TOKEN), async (service, http) => {
      expect(service.forbidden()).toBe(false);

      const { result, requests } = await issue(service, http, 'summary', RANGE);
      expect(requests.length).toBe(1);
      requests[0].flush({ error: 'Not authorized.' }, { status: 403, statusText: 'Forbidden' });

      expect(await result).toEqual(FORBIDDEN);
      expect(service.forbidden()).toBe(true);
    });
  });

  it('clears the forbidden signal once a later call succeeds', async () => {
    await withService(resolverFor(TOKEN), async (service, http) => {
      const denied = await issue(service, http, 'geography', RANGE);
      denied.requests[0].flush({}, { status: 403, statusText: 'Forbidden' });
      await denied.result;
      expect(service.forbidden()).toBe(true);

      const allowed = await issue(service, http, 'geography', RANGE);
      allowed.requests[0].flush({ range: RANGE, countries: [], regions: [] });
      expect(isOk(await allowed.result)).toBe(true);
      expect(service.forbidden()).toBe(false);
    });
  });

  it('surfaces an expired token as signed out on 401', async () => {
    await withService(resolverFor(TOKEN), async (service, http) => {
      const { result, requests } = await issue(service, http, 'features', RANGE);
      requests[0].flush({ error: 'Unauthorized.' }, { status: 401, statusText: 'Unauthorized' });

      expect(await result).toEqual(NO_SESSION);
      // 401 is not 403: the shell renders sign-in, not not-authorized.
      expect(service.forbidden()).toBe(false);
    });
  });

  it('fails with the served copy on any other error status', async () => {
    await withService(resolverFor(TOKEN), async (service, http) => {
      const { result, requests } = await issue(service, http, 'trend', RANGE);
      requests[0].flush(
        { error: 'Telemetry store unavailable.' },
        { status: 500, statusText: 'Server Error' },
      );

      expect(await result).toEqual({ kind: 'failed', reason: 'Telemetry store unavailable.' });
    });
  });

  it('falls back to the static failure copy when the answer carries none', async () => {
    await withService(resolverFor(TOKEN), async (service, http) => {
      const { result, requests } = await issue(service, http, 'environment', RANGE);
      requests[0].error(new ProgressEvent('error'));

      expect(await result).toEqual({ kind: 'failed', reason: REQUEST_FAILURE_FALLBACK });
      expect(describeRequestFailure(new ProgressEvent('error'))).toBe(REQUEST_FAILURE_FALLBACK);
    });
  });

  it('issues nothing at all while there is no session', async () => {
    await withService(resolverFor(null), async (service, http) => {
      for (const route of TELEMETRY_ROUTES) {
        const { result, requests } = await issue(service, http, route, RANGE);
        expect(requests.length).toBe(0);
        expect(await result).toEqual(NO_SESSION);
      }
    });
  });
});
