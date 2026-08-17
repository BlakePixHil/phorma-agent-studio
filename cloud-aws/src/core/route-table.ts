/**
 * The Trigger_Route table and its matcher.
 *
 * This module is PURE: no AWS SDK, no I/O, no `node:` import. It exists in
 * `core/` rather than inside a framework router precisely so the matching rules
 * can be property-tested as a function.
 *
 * Two guarantees the Server_Entry leans on:
 *
 * - `matchRoute` is TOTAL. Any method string and any path string yields a
 *   `RouteMatch`, never a throw - including a malformed percent-escape, an
 *   empty path and astral-plane text.
 * - `matchRoute` resolves at most one route. No two definitions share a method
 *   and a segment count with overlapping literals, so the match is unique by
 *   construction; the matcher checks every definition rather than relying on
 *   declaration order, so a future conflicting entry fails loudly instead of
 *   dispatching by accident.
 *
 * `renderRoute` is the inverse of `matchRoute` for non-empty parameter values:
 * it percent-encodes each parameter with `encodeURIComponent`, which the
 * matcher undoes with `decodeURIComponent`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.4, 7.5
 */

/** The eight Trigger_Routes, by id. */
export type TriggerRouteId =
  | 'spec-push'
  | 'trigger'
  | 'purge'
  | 'run-history'
  | 'run-detail'
  | 'usage'
  | 'connections'
  | 'secret-write';

/** The HTTP methods the Trigger_API exposes. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteDefinition {
  readonly id: TriggerRouteId;
  readonly method: HttpMethod;
  /** Segments; a leading ':' marks a parameter. */
  readonly segments: readonly string[];
  /** Parameter names in path order, derived from `segments`. */
  readonly params: readonly string[];
}

/** The marker that distinguishes a parameter segment from a literal one. */
const PARAM_PREFIX = ':';

/** Deep-freeze one definition so no caller can mutate the shared table. */
function defineRoute(id: TriggerRouteId, method: HttpMethod, segments: string[]): RouteDefinition {
  const params = segments
    .filter((segment) => segment.startsWith(PARAM_PREFIX))
    .map((segment) => segment.slice(PARAM_PREFIX.length));
  return Object.freeze({
    id,
    method,
    segments: Object.freeze(segments),
    params: Object.freeze(params),
  });
}

/**
 * The eight Trigger_Routes.
 *
 * Frozen, and the single source of truth for both the Server_Entry dispatch and
 * the Studio-side path builders.
 */
export const TRIGGER_ROUTES: readonly RouteDefinition[] = Object.freeze([
  defineRoute('spec-push', 'POST', ['workflows', ':id', 'spec']),
  defineRoute('trigger', 'POST', ['workflows', ':id', 'trigger']),
  defineRoute('purge', 'DELETE', ['workflows', ':id']),
  defineRoute('run-history', 'GET', ['workflows', ':id', 'runs']),
  defineRoute('run-detail', 'GET', ['workflows', ':id', 'runs', ':runId']),
  defineRoute('usage', 'GET', ['workflows', ':id', 'usage']),
  defineRoute('connections', 'GET', ['workflows', ':id', 'connections']),
  defineRoute('secret-write', 'PUT', ['connections', ':connId', 'secrets', ':key']),
]);

export type RouteMatch =
  | { matched: true; route: RouteDefinition; params: Readonly<Record<string, string>> }
  | { matched: false };

/** The one no-match answer, shared so the negative path allocates nothing. */
const NO_MATCH: RouteMatch = Object.freeze({ matched: false });

/**
 * Split a pathname into decoded segments.
 *
 * Returns `undefined` when the path cannot yield a candidate at all: a
 * malformed percent-escape (`decodeURIComponent` throws), or an empty segment.
 * No literal is empty and no parameter may be empty, so an empty segment can
 * never contribute to a match - rejecting it here keeps `renderRoute` a clean
 * inverse instead of letting `/workflows//spec` bind an empty workflow id.
 */
function decodeSegments(pathname: string): string[] | undefined {
  const trimmed = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const raw = trimmed.split('/');

  const decoded: string[] = [];
  for (const segment of raw) {
    if (segment.length === 0) return undefined;
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      // A malformed escape ('%', '%zz', a lone surrogate escape) is not a route.
      return undefined;
    }
  }
  return decoded;
}

/** Bind one definition against already-decoded segments, or answer `undefined`. */
function bind(
  route: RouteDefinition,
  method: string,
  segments: readonly string[],
): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  if (route.segments.length !== segments.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const pattern = route.segments[i];
    const value = segments[i];
    if (pattern.startsWith(PARAM_PREFIX)) {
      params[pattern.slice(PARAM_PREFIX.length)] = value;
    } else if (pattern !== value) {
      return undefined;
    }
  }
  return params;
}

/**
 * Match a request against the Trigger_Route table.
 *
 * Total: never throws, for any method string and any path string. Method
 * comparison is case-sensitive, matching the RFC and what `node:http` reports.
 * Segment counts are compared first, then literals, then parameters bind.
 */
export function matchRoute(method: string, pathname: string): RouteMatch {
  const segments = decodeSegments(pathname);
  if (segments === undefined) return NO_MATCH;

  let match: RouteMatch | undefined;
  for (const route of TRIGGER_ROUTES) {
    const params = bind(route, method, segments);
    if (params === undefined) continue;
    // Two matches means the table itself lost its uniqueness invariant. Answer
    // no-match so the defect surfaces as a dead route rather than as a request
    // silently dispatched to whichever definition was declared first.
    if (match !== undefined) return NO_MATCH;
    match = { matched: true, route, params: Object.freeze(params) };
  }
  return match ?? NO_MATCH;
}

/** Look one definition up by id. */
export function findRoute(id: TriggerRouteId): RouteDefinition {
  const route = TRIGGER_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`Unknown Trigger_Route id: ${id}`);
  return route;
}

/**
 * Render the path for a route id, percent-encoding each parameter value.
 *
 * The inverse of `matchRoute` for non-empty parameter values: matching the
 * result with the route's own method yields that route id and exactly these
 * parameter values. Throws when a parameter the route declares is missing or
 * empty, which is a caller defect rather than a request the host must survive.
 */
export function renderRoute(id: TriggerRouteId, params: Record<string, string>): string {
  const route = findRoute(id);

  const segments = route.segments.map((segment) => {
    if (!segment.startsWith(PARAM_PREFIX)) return segment;
    const name = segment.slice(PARAM_PREFIX.length);
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Route ${id} requires a non-empty '${name}' parameter`);
    }
    return encodeURIComponent(value);
  });

  return `/${segments.join('/')}`;
}
