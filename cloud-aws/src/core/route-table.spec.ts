/**
 * Property tests for the Trigger_Route table and its matcher.
 *
 * The Server_Entry dispatches every request through `matchRoute`, so the
 * matcher carries three obligations: it must survive any bytes a public load
 * balancer can deliver, it must never leave a request ambiguous, and it must
 * undo exactly what `renderRoute` produced so the Studio-side path builders and
 * the host agree on one wire format.
 *
 * Feature: aws-byo-deploy, Property 4: Route matcher is total, unique and inverts renderRoute
 * Validates: Requirements 7.4, 7.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TRIGGER_ROUTES,
  findRoute,
  matchRoute,
  renderRoute,
  type TriggerRouteId,
} from './route-table.js';

/**
 * An independent re-derivation of the match set from `TRIGGER_ROUTES`.
 *
 * `matchRoute` collapses a double match to no-match on purpose, which hides a
 * table that lost its uniqueness invariant. Counting matches here instead of
 * trusting that collapse is what makes the uniqueness assertion meaningful.
 */
function referenceMatches(
  method: string,
  pathname: string,
): { id: TriggerRouteId; params: Record<string, string> }[] {
  const trimmed = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  const segments: string[] = [];
  for (const raw of trimmed.split('/')) {
    // No literal is empty and no parameter may be empty, so an empty segment
    // can never contribute to a match.
    if (raw.length === 0) return [];
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return [];
    }
    segments.push(decoded);
  }

  const matches: { id: TriggerRouteId; params: Record<string, string> }[] = [];
  for (const route of TRIGGER_ROUTES) {
    if (route.method !== method) continue;
    if (route.segments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let bound = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const pattern = route.segments[i];
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = segments[i];
      } else if (pattern !== segments[i]) {
        bound = false;
        break;
      }
    }
    if (bound) matches.push({ id: route.id, params });
  }
  return matches;
}

/** Segments chosen to break a decoder rather than to please one. */
const hostileSegment = fc.oneof(
  fc.constant(''),
  fc.constant('%'),
  fc.constant('%%'),
  fc.constant('%zz'),
  fc.constant('%2'),
  fc.constant('%E0%A4'),
  fc.constant('%C0%80'),
  fc.constant('%ED%A0%80'),
  fc.constant('%FF%FE'),
  fc.constant('%2F'),
  fc.constant('%00'),
  // Literals from the table, so hostile paths land on real routes too.
  fc.constant('workflows'),
  fc.constant('connections'),
  fc.constant('runs'),
  fc.constant('secrets'),
  fc.constant('spec'),
  fc.constant('trigger'),
  fc.constant('usage'),
  fc.constant('\u0000\u0001\u001f\u007f'),
  fc.constant('\u{1f4a9}\u{10ffff}\u{2f804}'),
  fc.constant('\ud800'),
  fc.constant('\udfff\ud83d'),
  fc.constant('a'.repeat(8192)),
  fc.constant('%'.repeat(64)),
  fc.string({ unit: 'binary', maxLength: 16 }),
  fc.string({ unit: 'grapheme', maxLength: 16 }),
  fc.string({ maxLength: 12 }),
);

/** Paths a public listener can actually receive, including the pathological ones. */
const hostilePath = fc.oneof(
  fc.constant(''),
  fc.constant('/'),
  fc.constant('//'),
  fc.constant('/'.repeat(64)),
  fc.constant('/workflows'),
  fc.constant('/workflows//spec'),
  fc.constant('/workflows/abc/runs/'),
  fc.constant('/%'),
  fc.constant('/workflows/%E0%A4/spec'),
  fc.string({ unit: 'binary', maxLength: 64 }),
  fc.array(hostileSegment, { maxLength: 8 }).map((parts) => `/${parts.join('/')}`),
  fc.array(hostileSegment, { maxLength: 8 }).map((parts) => parts.join('/')),
);

/** Methods including the wrong case, the empty string and outright garbage. */
const hostileMethod = fc.oneof(
  fc.constant('GET'),
  fc.constant('POST'),
  fc.constant('PUT'),
  fc.constant('DELETE'),
  fc.constant('get'),
  fc.constant('Post'),
  fc.constant('PATCH'),
  fc.constant('OPTIONS'),
  fc.constant(''),
  fc.constant(' GET'),
  fc.constant('GET '),
  fc.constant('G'.repeat(4096)),
  fc.constant('\u{1f4a9}'),
  fc.string({ unit: 'binary', maxLength: 12 }),
);

/**
 * Percent-encode a generated segment, keeping it raw when it cannot be encoded
 * at all (a lone surrogate makes `encodeURIComponent` throw). A raw hostile
 * segment is exactly the kind of input the matcher must survive, so falling back
 * is better than filtering it out.
 */
function encodeSegment(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A request shaped like a real route: the table's own segment list with the
 * parameter positions filled in, sometimes truncated or extended, paired with
 * the route's own method in its own case, lowercased or swapped.
 *
 * Purely random input almost never reaches the parameter-binding stage, so
 * without this branch a mutation in method or literal comparison would never be
 * exercised by the property at all.
 */
const routeShapedRequest = fc
  .tuple(
    fc.constantFrom(...TRIGGER_ROUTES),
    fc.array(fc.oneof(hostileSegment, fc.constant('wf-1'), fc.constant('run-2')), {
      minLength: 2,
      maxLength: 2,
    }),
    fc.constantFrom<'exact' | 'drop' | 'append'>('exact', 'exact', 'exact', 'drop', 'append'),
    fc.constantFrom<'own' | 'lower' | 'other'>('own', 'own', 'lower', 'other'),
  )
  .map(([route, values, shape, methodCase]): [string, string] => {
    let cursor = 0;
    const parts = route.segments.map((segment) =>
      segment.startsWith(':') ? encodeSegment(values[cursor++] || 'x') : segment,
    );
    if (shape === 'drop') parts.pop();
    if (shape === 'append') parts.push('extra');

    const method =
      methodCase === 'own'
        ? route.method
        : methodCase === 'lower'
          ? route.method.toLowerCase()
          : route.method === 'GET'
            ? 'POST'
            : 'GET';

    return [method, `/${parts.join('/')}`];
  });

/** Every request the matcher must answer: hostile pairs plus route-shaped ones. */
const requestArb = fc.oneof(
  { arbitrary: fc.tuple(hostileMethod, hostilePath), weight: 2 },
  { arbitrary: routeShapedRequest, weight: 3 },
);

/** Non-empty printable parameter values, weighted toward what encoding must survive. */
const parameterValue = fc.oneof(
  fc.constant('a'),
  fc.constant('wf-123'),
  fc.constant('a/b/c'),
  fc.constant('100%'),
  fc.constant('%2F'),
  fc.constant('#anchor'),
  fc.constant('?query=1&x=2'),
  fc.constant('two words'),
  fc.constant('  leading and trailing  '),
  fc.constant('runs'),
  fc.constant('spec'),
  fc.constant('..'),
  fc.constant('caf\u00e9 \u00fcber'),
  fc.constant('\u65e5\u672c\u8a9e'),
  fc.constant('\u{1f4a9}\u{1f680}'),
  fc.constant('~!*()-_.\''),
  fc.constant('x'.repeat(512)),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }).filter((s) => s.length > 0),
);

const routeId = fc.constantFrom(...TRIGGER_ROUTES.map((route) => route.id));

describe('route-table - Property 4: route matcher is total, unique and inverts renderRoute', () => {
  /**
   * **Validates: Requirements 7.4, 7.5**
   *
   * TOTALITY. `matchRoute` answers for any method string and any path string.
   * The Server_Entry has no guard around it: a throw here is a 500 on a request
   * that should have been a clean 404, so malformed escapes, lone surrogates,
   * astral text, control characters and multi-kilobyte paths must all resolve.
   */
  it('never throws for any method string and any path string', () => {
    fc.assert(
      fc.property(requestArb, ([method, pathname]) => {
        const result = matchRoute(method, pathname);

        expect(typeof result.matched).toBe('boolean');
        if (result.matched) {
          expect(TRIGGER_ROUTES).toContain(result.route);
          // Every declared parameter is bound, and nothing else is.
          expect(Object.keys(result.params).sort()).toEqual([...result.route.params].sort());
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4, 7.5**
   *
   * UNIQUENESS. At most one definition matches, re-derived from the table
   * rather than read off the matcher's own collapse. When exactly one
   * definition matches, `matchRoute` must return that definition with those
   * parameter values; when none does, it must report no match.
   */
  it('matches at most one definition, and agrees with the table when exactly one matches', () => {
    fc.assert(
      fc.property(requestArb, ([method, pathname]) => {
        const expected = referenceMatches(method, pathname);
        expect(expected.length).toBeLessThanOrEqual(1);

        const actual = matchRoute(method, pathname);
        if (expected.length === 0) {
          expect(actual.matched).toBe(false);
        } else {
          expect(actual.matched).toBe(true);
          if (actual.matched) {
            expect(actual.route.id).toBe(expected[0].id);
            expect({ ...actual.params }).toEqual(expected[0].params);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * ROUND TRIP. `matchRoute` inverts `renderRoute` for non-empty printable
   * values: the route id comes back and the parameter values come back byte for
   * byte, including values carrying '/', '%', '#', '?', spaces and astral
   * characters - exactly the values percent-encoding exists to carry.
   */
  it('matching renderRoute output with the route method yields that route id and exactly those parameters', () => {
    fc.assert(
      fc.property(
        routeId,
        // Two values cover the widest route; single-parameter routes use the first.
        fc.array(parameterValue, { minLength: 2, maxLength: 2 }),
        (id, values) => {
          const route = findRoute(id);
          const params: Record<string, string> = {};
          route.params.forEach((name, index) => {
            params[name] = values[index];
          });

          const pathname = renderRoute(id, params);
          const result = matchRoute(route.method, pathname);

          expect(result.matched).toBe(true);
          if (!result.matched) return;
          expect(result.route.id).toBe(id);
          expect({ ...result.params }).toEqual(params);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('route-table - documented matcher behaviour', () => {
  it('rejects every path with an empty segment', () => {
    expect(matchRoute('GET', '').matched).toBe(false);
    expect(matchRoute('GET', '/').matched).toBe(false);
    expect(matchRoute('GET', '/workflows/wf-1/runs/').matched).toBe(false);
    expect(matchRoute('POST', '/workflows//spec').matched).toBe(false);
  });

  it('rejects a malformed percent-escape rather than throwing', () => {
    expect(matchRoute('POST', '/workflows/%/spec').matched).toBe(false);
    expect(matchRoute('POST', '/workflows/%E0%A4/spec').matched).toBe(false);
  });

  it('compares the method case-sensitively', () => {
    expect(matchRoute('GET', '/workflows/wf-1/runs').matched).toBe(true);
    expect(matchRoute('get', '/workflows/wf-1/runs').matched).toBe(false);
  });

  it('dispatches each of the eight routes', () => {
    const ids = TRIGGER_ROUTES.map((route) => {
      const params = Object.fromEntries(route.params.map((name) => [name, `v-${name}`]));
      const result = matchRoute(route.method, renderRoute(route.id, params));
      return result.matched ? result.route.id : undefined;
    });

    expect(ids).toEqual(TRIGGER_ROUTES.map((route) => route.id));
    expect(TRIGGER_ROUTES).toHaveLength(8);
  });

  it('round-trips a parameter value containing a slash through percent-encoding', () => {
    const pathname = renderRoute('run-detail', { id: 'wf/1', runId: 'run%2F2' });
    expect(pathname).toBe('/workflows/wf%2F1/runs/run%252F2');

    const result = matchRoute('GET', pathname);
    expect(result.matched).toBe(true);
    if (result.matched) expect({ ...result.params }).toEqual({ id: 'wf/1', runId: 'run%2F2' });
  });

  it('throws when a declared parameter is missing or empty', () => {
    expect(() => renderRoute('run-detail', { id: 'wf-1' })).toThrow(/runId/);
    expect(() => renderRoute('trigger', { id: '' })).toThrow(/non-empty/);
  });
});
