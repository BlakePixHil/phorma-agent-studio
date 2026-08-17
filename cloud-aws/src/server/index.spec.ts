/**
 * Property test for Server_Entry handler-throw containment, plus the two
 * response-shape examples that sit beside it.
 *
 * Property 5: A handler throw is contained.
 * Validates: Requirements 7.6
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.2, 7.5, 7.6
 *
 * `createRequestListener(deps)` holds no module-level state and `node-http.d.ts`
 * types every method as returning `void`, so the whole dispatch is driven here
 * with a hand-built request and response and NO port bound.
 *
 * The interesting half of "carries no detail" is the marker: each thrown value
 * embeds a recognisable secret-like string, and the assertion is that the string
 * appears nowhere in the response body. Asserting the body equals
 * `{"error":"Internal error"}` is also here, but it is the marker check that
 * would catch a future change which starts interpolating the thrown message.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { TRIGGER_ROUTES, findRoute, renderRoute } from '../core/route-table.js';
import type { TriggerRouteId } from '../core/route-table.js';
import type { LogWriter } from '../aws/ports.js';

import { HEALTH_PATH, createHealthFlag, createRequestListener } from './index.js';
import type { HealthStatus, RouteAdapter } from './index.js';
import type { TriggerRouteDeps } from './trigger-routes.js';

// ---------------------------------------------------------------------------
// Fake request and response
// ---------------------------------------------------------------------------

interface FakeRequest extends IncomingMessage {
  /** Emit the body (when given) and then `end`, as `node:http` would. */
  finish(body?: string): void;
  /** True once the listener abandoned the upload. */
  destroyed: boolean;
}

function fakeRequest(method: string, url: string): FakeRequest {
  const listeners = new Map<string, ((chunk?: Uint8Array) => void)[]>();

  const req: FakeRequest = {
    method,
    url,
    headers: {},
    destroyed: false,
    on: (event, listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    destroy: () => {
      req.destroyed = true;
    },
    finish: (body) => {
      if (body !== undefined && body !== '') {
        const chunk = new TextEncoder().encode(body);
        for (const listener of listeners.get('data') ?? []) listener(chunk);
      }
      for (const listener of listeners.get('end') ?? []) listener();
    },
  };

  return req;
}

interface FakeResponse extends ServerResponse {
  writableEnded: boolean;
  status?: number;
  headers?: Record<string, string>;
  /** The serialized body exactly as the listener wrote it. */
  payload: string;
  /** Resolves once `end` has been called. */
  done: Promise<void>;
}

function fakeResponse(): FakeResponse {
  let settle = (): void => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const res: FakeResponse = {
    writableEnded: false,
    payload: '',
    done,
    writeHead: (status, headers) => {
      res.status = status;
      res.headers = headers;
    },
    end: (chunk, callback) => {
      res.payload = chunk ?? '';
      res.writableEnded = true;
      callback?.();
      settle();
    },
    destroy: () => undefined,
  };

  return res;
}

/** Drive one request through the listener and wait for the response. */
async function dispatch(
  listener: RequestListener,
  method: string,
  url: string,
  body?: string,
): Promise<FakeResponse> {
  const req = fakeRequest(method, url);
  const res = fakeResponse();
  listener(req, res);
  // The listener has already registered its body handlers by now: `serve` runs
  // synchronously as far as `readBody`, whose executor attaches them.
  req.finish(body);
  await res.done;
  return res;
}

// ---------------------------------------------------------------------------
// Fake log writer
// ---------------------------------------------------------------------------

interface RecordingLogWriter extends LogWriter {
  readonly lines: string[];
}

function recordingLogWriter(): RecordingLogWriter {
  const lines: string[] = [];
  return {
    lines,
    write: async (line) => {
      lines.push(line);
    },
  };
}

// ---------------------------------------------------------------------------
// Listener assembly
// ---------------------------------------------------------------------------

/**
 * The handlers are never reached: every route under test has its adapter
 * replaced, and `GET /health` reads the flag alone. So the dependency bundle can
 * be empty.
 */
const NO_ROUTE_DEPS = {} as TriggerRouteDeps;

interface Harness {
  listener: RequestListener;
  log: RecordingLogWriter;
  setHealth(next: HealthStatus): void;
}

function harness(
  adapters: Partial<Record<TriggerRouteId, RouteAdapter>>,
  initialHealth: HealthStatus = 'ok',
): Harness {
  const log = recordingLogWriter();
  const health = createHealthFlag(initialHealth);
  return {
    log,
    setHealth: (next) => health.set(next),
    listener: createRequestListener({
      routes: NO_ROUTE_DEPS,
      logWriter: log,
      health,
      adapters,
    }),
  };
}

/**
 * An adapter that throws the given value ONCE and answers normally afterwards,
 * so the same route proves the listener kept serving.
 */
function throwsOnce(thrown: unknown): RouteAdapter {
  let thrownAlready = false;
  return async () => {
    if (!thrownAlready) {
      thrownAlready = true;
      throw thrown;
    }
    return { status: 200, body: { ok: true } };
  };
}

/** Sample values for every path parameter the eight routes declare. */
const ROUTE_PARAMS: Record<string, string> = {
  id: 'wf-1',
  runId: 'run-1',
  connId: 'conn-1',
  key: 'API_KEY',
};

const ROUTE_IDS: readonly TriggerRouteId[] = TRIGGER_ROUTES.map((route) => route.id);

/** The two body-carrying methods get a valid JSON body so the adapter is reached. */
function bodyFor(method: string): string | undefined {
  return method === 'POST' || method === 'PUT' ? '{}' : undefined;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Any of the eight routes. */
const arbRouteId = fc.constantFrom(...ROUTE_IDS);

/**
 * A secret-like marker. It cannot occur in the contained body by accident, so
 * finding it in a response is proof that detail leaked.
 */
const arbMarker = fc
  .integer({ min: 0x1000_0000, max: 0x7fff_ffff })
  .map((token) => `SECRET-${token.toString(16).toUpperCase()}-LEAK`);

/** The ten thrown-value shapes a handler can realistically produce. */
const THROWN_KINDS = 10;

class DetailedError extends Error {
  override name = 'DetailedError';
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

function makeThrown(kind: number, marker: string): unknown {
  switch (kind) {
    case 0:
      return new Error(marker);
    case 1:
      return new DetailedError(marker);
    case 2:
      return marker;
    case 3:
      return 4242.5;
    case 4:
      return null;
    case 5:
      return undefined;
    case 6:
      return { detail: marker, code: 'AccessDenied' };
    case 7:
      return {
        toString(): string {
          throw new Error(marker);
        },
      };
    case 8:
      return { message: marker, name: 'WeirdError' };
    default:
      // A message far larger than any response the listener would write.
      return new Error(`${marker}${'x'.repeat(20_000)}`);
  }
}

const arbThrown = fc
  .tuple(fc.integer({ min: 0, max: THROWN_KINDS - 1 }), arbMarker)
  .map(([kind, marker]) => ({ thrown: makeThrown(kind, marker), marker }));

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

// Feature: aws-byo-deploy, Property 5: A handler throw is contained
describe('server/index - Property 5: A handler throw is contained', () => {
  /**
   * **Validates: Requirements 7.6**
   *
   * For any of the eight routes and any thrown value: status 500, a body
   * carrying no detail from the thrown value, one structured log line, and a
   * listener that is still serving - both `GET /health` and the same route.
   */
  it('answers 500 with no detail, logs the error and keeps serving, for any route and any thrown value', async () => {
    await fc.assert(
      fc.asyncProperty(arbRouteId, arbThrown, async (routeId, { thrown, marker }) => {
        const route = findRoute(routeId);
        const path = renderRoute(routeId, ROUTE_PARAMS);
        const { listener, log } = harness({ [routeId]: throwsOnce(thrown) });

        const failed = await dispatch(listener, route.method, path, bodyFor(route.method));

        expect(failed.status).toBe(500);

        // The real leak test, and it comes first: no trace of the thrown value
        // in the body, whatever shape the body takes.
        expect(failed.payload).not.toContain(marker);
        expect(failed.payload).not.toContain('SECRET');

        // Contained: the generic 500 body and nothing else.
        expect(failed.payload).toBe('{"error":"Internal error"}');

        // The detail goes to the log, which must carry exactly one line.
        expect(log.lines).toHaveLength(1);
        const line = JSON.parse(log.lines[0]) as Record<string, unknown>;
        expect(line['level']).toBe('error');
        expect(line['event']).toBe('route-handler-error');
        expect(line['routeId']).toBe(routeId);
        expect(line['method']).toBe(route.method);
        expect(line['path']).toBe(path);
        expect(typeof line['errorName']).toBe('string');
        expect(typeof line['errorMessage']).toBe('string');

        // Still serving: the health check answers 200 ...
        const health = await dispatch(listener, 'GET', HEALTH_PATH);
        expect(health.status).toBe(200);
        expect(health.payload).toBe('{"status":"ok"}');

        // ... and so does the route that just threw.
        const recovered = await dispatch(listener, route.method, path, bodyFor(route.method));
        expect(recovered.status).toBe(200);
        expect(recovered.payload).toBe('{"ok":true}');

        // The second, successful call added no further log line.
        expect(log.lines).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

describe('server/index - unmatched request', () => {
  /**
   * **Validates: Requirements 7.5**
   *
   * A request matching no Trigger_Route answers 404 with a body naming the
   * unmatched method and path.
   */
  it('answers 404 with a body naming the unmatched method and path', async () => {
    const { listener } = harness({});

    const res = await dispatch(listener, 'GET', '/workflows/wf-1/nope');

    expect(res.status).toBe(404);
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(res.payload)).toEqual({
      error: 'No route for GET /workflows/wf-1/nope',
      method: 'GET',
      path: '/workflows/wf-1/nope',
    });
  });

  it('answers 404 for a known path under the wrong method', async () => {
    const { listener } = harness({});

    const res = await dispatch(listener, 'DELETE', '/workflows/wf-1/runs');

    expect(res.status).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({
      error: 'No route for DELETE /workflows/wf-1/runs',
      method: 'DELETE',
      path: '/workflows/wf-1/runs',
    });
  });
});

describe('server/index - GET /health', () => {
  /**
   * **Validates: Requirements 7.2**
   *
   * Once the startup assertion has passed, the health check answers 200 from the
   * in-memory flag alone.
   */
  it('answers 200 {"status":"ok"} when the health flag is ok', async () => {
    const { listener } = harness({}, 'ok');

    const res = await dispatch(listener, 'GET', HEALTH_PATH);

    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(res.payload)).toEqual({ status: 'ok' });
  });

  it('answers 503 while starting, so the NLB never routes to a partial task', async () => {
    const { listener } = harness({}, 'starting');

    const res = await dispatch(listener, 'GET', HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ status: 'starting' });
  });

  it('answers 503 once draining, so the NLB stops routing during shutdown', async () => {
    const { listener, setHealth } = harness({}, 'ok');

    setHealth('draining');
    const res = await dispatch(listener, 'GET', HEALTH_PATH);

    expect(res.status).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ status: 'draining' });
  });
});
