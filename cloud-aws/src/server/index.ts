/**
 * Server_Entry: the HTTP listener, the Trigger_Route dispatch and the shutdown
 * path (Req 7.1, 7.2, 7.4, 7.5, 7.6, 7.8).
 *
 * `node:http` and a hand-rolled dispatch, no framework. The routing surface is
 * eight routes with at most two path parameters, the matcher itself lives in
 * `core/route-table.ts` where it is property-tested as a pure function, and the
 * package keeps an exact-pin discipline that a framework's dependency tree would
 * complicate for no gain.
 *
 * The start sequence is ordered, and the order is the safety property:
 *
 * 1. `readServerEnv(process.env)` - a missing variable writes every missing name
 *    to stderr and exits 1.
 * 2. `startHost(env)` - composes the Host_Adapter and asserts the contract. An
 *    incomplete adapter writes every missing capability to stderr and exits 1.
 * 3. `createServer(listener).listen(port)`.
 * 4. Start the Frame_Inbox drain interval.
 * 5. Register `SIGTERM` and `SIGINT`.
 *
 * The health flag flips to `ok` only between step 2 and step 3, so a partial
 * adapter means the process is gone before a listener exists and the NLB target
 * never reports healthy. `GET /health` reads that in-memory flag and nothing
 * else: it issues no AWS call, so it cannot fail for a reason the load balancer
 * would misread, and it answers well inside the 1000 ms of Req 7.2.
 *
 * `createRequestListener(deps)` takes every dependency as a parameter and holds
 * no module-level state, so the dispatch, the 404 shape and the handler-throw
 * containment are all testable without binding a port.
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.8
 */

import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';

import type { WorkflowSpec } from '@phorma/engine';

import type { ControlFrame } from '../core/frames.js';
import type { HeldLease } from '../core/host-contract.js';
import { matchRoute } from '../core/route-table.js';
import type { RouteDefinition, TriggerRouteId } from '../core/route-table.js';
import type { LogWriter } from '../aws/ports.js';

import {
  DEFAULT_PORT,
  FRAME_DRAIN_INTERVAL_MS,
  InvalidEnvError,
  MissingEnvError,
  SHUTDOWN_BUDGET_MS,
  readServerEnv,
} from './env.js';
import type { ServerEnv } from './env.js';
import { drainFrameInbox } from './frame-drain.js';
import { startHost } from './startup.js';
import type { ComposedHost, StartHostOptions, StartupErrorSink } from './startup.js';
import {
  handleConnections,
  handleHistory,
  handlePurge,
  handleRunDetail,
  handleSecretWrite,
  handleSpecPush,
  handleTrigger,
  handleUsage,
} from './trigger-routes.js';
import type {
  RouteResult,
  StoredConnection,
  TriggerRouteDeps,
} from './trigger-routes.js';

// The documented Server_Entry surface: the constants and the environment reader
// live in `env.ts` so `infra/template.spec.ts` can assert the variable names
// without importing a module that imports `node:http`.
export {
  DEFAULT_PORT,
  FRAME_DRAIN_INTERVAL_MS,
  SHUTDOWN_BUDGET_MS,
  readServerEnv,
} from './env.js';
export type { ServerEnv } from './env.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Request body ceiling, 6 MB. A pushed spec with its sub-workflows is the
 * largest legitimate body, and this sits above that while staying below what an
 * unbounded read would cost the task's memory.
 */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** The health path. Not a Trigger_Route, and not exposed through Trigger_API. */
export const HEALTH_PATH = '/health';

/** The base for `new URL`, so a request target is parsed as a relative one. */
const URL_BASE = 'http://local';

/** `content-type` on every response this module writes. */
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

/** The exit code for a startup failure, matching `startup.ts`. */
const EXIT_STARTUP_FAILURE = 1;

// ---------------------------------------------------------------------------
// Health flag
// ---------------------------------------------------------------------------

/**
 * `starting` before the startup assertion passes, `ok` once it has, `draining`
 * from the moment a shutdown signal arrives.
 *
 * Three states rather than a boolean, because `starting` and `draining` are
 * different facts about the same not-serving answer, and the shutdown path needs
 * the health check to fail for a reason the operator can read in the logs.
 */
export type HealthStatus = 'starting' | 'ok' | 'draining';

export interface HealthFlag {
  status(): HealthStatus;
  set(next: HealthStatus): void;
}

/** Build a health flag. In-memory, no I/O, so `GET /health` cannot block. */
export function createHealthFlag(initial: HealthStatus = 'starting'): HealthFlag {
  let status = initial;
  return {
    status: () => status,
    set: (next) => {
      status = next;
    },
  };
}

// ---------------------------------------------------------------------------
// In-flight request tracking
// ---------------------------------------------------------------------------

/**
 * Counts requests currently being served, so shutdown can wait for them.
 *
 * `server.close()` stops accepting and reports when every CONNECTION has
 * closed, which under keep-alive is not the same question as "is any request
 * still running". This counter answers that question directly.
 */
export interface InFlightTracker {
  enter(): void;
  leave(): void;
  count(): number;
  /** Resolves when the count reaches zero. Resolves immediately when it already is. */
  idle(): Promise<void>;
}

export function createInFlightTracker(): InFlightTracker {
  let count = 0;
  let waiters: (() => void)[] = [];

  const settle = (): void => {
    if (count > 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    enter: () => {
      count += 1;
    },
    leave: () => {
      count = Math.max(0, count - 1);
      settle();
    },
    count: () => count,
    idle: () =>
      new Promise<void>((resolve) => {
        if (count === 0) resolve();
        else waiters.push(resolve);
      }),
  };
}

// ---------------------------------------------------------------------------
// The active run
// ---------------------------------------------------------------------------

/**
 * The run this task currently holds a lease for, if any.
 *
 * The Frame_Inbox drain needs the CURRENT lease and the CURRENT frame sink on
 * every tick, and shutdown needs the lease to release it. Both read through this
 * registry rather than capturing a value when the interval was created, so a run
 * that starts or settles between ticks is seen immediately.
 */
export interface ActiveRun {
  readonly lease: HeldLease;
  /** Hand one frame to the Runner, which routes it against its live state. */
  deliver(frame: ControlFrame): void;
}

export interface ActiveRunRegistry {
  current(): ActiveRun | undefined;
  set(run: ActiveRun | undefined): void;
}

export function createActiveRunRegistry(): ActiveRunRegistry {
  let active: ActiveRun | undefined;
  return {
    current: () => active,
    set: (run) => {
      active = run;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-route adapters
// ---------------------------------------------------------------------------

/** One matched request, decoded, with its body already parsed. */
export interface RouteRequest {
  readonly route: RouteDefinition;
  /** Path parameters, already percent-decoded by `matchRoute`. */
  readonly params: Readonly<Record<string, string>>;
  /** Query parameters as the request carried them. */
  readonly query: URLSearchParams;
  /** The parsed JSON body for a body-carrying method, otherwise undefined. */
  readonly body: unknown;
}

/**
 * The seam between the HTTP shape and a `trigger-routes.ts` handler.
 *
 * One adapter per route id, each mapping path parameters and query values onto
 * the handler's own signature. The handlers stay free of `IncomingMessage`, so
 * they remain callable directly from the contention and accounting tests.
 */
export type RouteAdapter = (
  deps: TriggerRouteDeps,
  request: RouteRequest,
) => Promise<RouteResult>;

/** The query parameter carrying a continuation token on the paginated routes. */
const QUERY_CONTINUATION = 'continuationToken';

/** The query parameter carrying the usage window start. */
const QUERY_SINCE = 'since';

/** Read one query value, treating blank as absent. */
function queryValue(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A JSON object body, or undefined when the body is anything else. */
function objectBody(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/** A non-blank string field, or undefined. */
function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

/** The one malformed-body answer, so every adapter rejects the same way. */
function badRequest(message: string): RouteResult {
  return { status: 400, body: { error: message } };
}

/**
 * The eight adapters.
 *
 * Frozen and exported so a test can replace one entry - which is how the
 * handler-throw containment property injects a throwing handler for each route
 * in turn without reaching into a module-level table.
 */
export const ROUTE_ADAPTERS: Readonly<Record<TriggerRouteId, RouteAdapter>> = Object.freeze({
  'spec-push': async (deps, request) => {
    const body = objectBody(request.body);
    if (!body) return badRequest('Request body must be a JSON object');
    const spec = body['spec'];
    if (spec === null || typeof spec !== 'object') {
      return badRequest('Request body must carry a "spec" object');
    }
    const connections = Array.isArray(body['connections'])
      ? (body['connections'] as StoredConnection[])
      : undefined;

    return handleSpecPush(deps, {
      // The path parameter wins over any workflow id in the body, so one
      // request can never address two workflows.
      workflowId: request.params['id'],
      // The spec is validated by `handleSpecPush` against AWS_CAPABILITIES,
      // which is the check that matters; this layer only asserts it is an object.
      spec: spec as WorkflowSpec,
      ...(connections === undefined ? {} : { connections }),
    });
  },

  trigger: async (deps, request) => {
    const body = objectBody(request.body) ?? {};
    const runId = stringField(body, 'runId');
    if (runId === undefined) return badRequest('Request body must carry a "runId" string');

    return handleTrigger(deps, {
      workflowId: request.params['id'],
      runId,
      ...(stringField(body, 'input') === undefined
        ? {}
        : { input: body['input'] as string }),
      source: stringField(body, 'source') ?? 'manual',
      // Forwarded by the Schedule_Shim. Its presence is what lets a fired
      // schedule for a purged workflow be identified and deleted rather than
      // retried forever.
      ...(stringField(body, 'nodeId') === undefined
        ? {}
        : { nodeId: stringField(body, 'nodeId')! }),
    });
  },

  purge: async (deps, request) => handlePurge(deps, request.params['id']),

  'run-history': async (deps, request) =>
    handleHistory(deps, request.params['id'], queryValue(request.query, QUERY_CONTINUATION)),

  'run-detail': async (deps, request) =>
    handleRunDetail(
      deps,
      request.params['id'],
      request.params['runId'],
      queryValue(request.query, QUERY_CONTINUATION),
    ),

  usage: async (deps, request) =>
    handleUsage(
      deps,
      request.params['id'],
      // `handleUsage` owns the validation and its rejection message, so a
      // missing value is passed through as the empty string rather than being
      // rejected here with a second, different wording (Req 4.12).
      queryValue(request.query, QUERY_SINCE) ?? '',
      queryValue(request.query, QUERY_CONTINUATION),
    ),

  connections: async (deps) => {
    const result = await handleConnections(deps);
    // Wrapped so the Studio has one parse shape across deployment targets.
    if (!Array.isArray(result.body)) return result;
    return { status: result.status, body: { connections: result.body } };
  },

  'secret-write': async (deps, request) => {
    const body = objectBody(request.body);
    if (!body) return badRequest('Request body must be a JSON object');
    const value = body['value'];
    if (typeof value !== 'string') {
      return badRequest('Request body must carry a "value" string');
    }

    return handleSecretWrite(deps, {
      connectionId: request.params['connId'],
      secretKey: request.params['key'],
      value,
    });
  },
} satisfies Record<TriggerRouteId, RouteAdapter>);

// ---------------------------------------------------------------------------
// Response writing
// ---------------------------------------------------------------------------

/**
 * Serialize a response body.
 *
 * Returns `undefined` when the value cannot be serialized (a cycle, a BigInt),
 * which the caller treats as a handler defect and answers 500 for. `JSON.stringify`
 * of `undefined` is itself `undefined`, so the `null` literal covers a handler
 * that answered with no body.
 */
function serialize(body: unknown): string | undefined {
  try {
    return JSON.stringify(body) ?? 'null';
  } catch {
    return undefined;
  }
}

/**
 * Write one JSON response. Never writes twice to the same response.
 *
 * `onFlushed` runs once the response has left the process, which the oversized-body
 * path uses to abandon the rest of the upload only after the refusal is on the wire.
 */
function writeJson(
  res: ServerResponse,
  status: number,
  payload: string,
  onFlushed?: () => void,
): void {
  if (res.writableEnded === true) {
    onFlushed?.();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(payload, onFlushed);
}

/** Write a body that is known to be serializable. */
function writeBody(res: ServerResponse, status: number, body: unknown): void {
  writeJson(res, status, serialize(body) ?? '{"error":"Internal error"}');
}

// ---------------------------------------------------------------------------
// Error description
// ---------------------------------------------------------------------------

/** The name and message of a thrown value, whatever was thrown. */
interface ErrorFacts {
  name: string;
  message: string;
}

/**
 * Describe a thrown value for the log line.
 *
 * A throw is not guaranteed to be an `Error`: a handler can reject with a
 * string, a plain object, `undefined`, or a value whose own `toString` throws.
 * All of those have to produce a log line rather than a second failure inside
 * the failure path, so every conversion is guarded.
 */
function describeThrown(thrown: unknown): ErrorFacts {
  if (thrown instanceof Error) {
    return { name: safeString(thrown.name) ?? 'Error', message: safeString(thrown.message) ?? '' };
  }
  return { name: typeof thrown, message: safeString(thrown) ?? '' };
}

/** `String(value)`, or undefined when the conversion itself throws. */
function safeString(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/**
 * Log one structured line for a failed handler.
 *
 * One line, carrying the route id and the error name and message, through the
 * `LogWriter` that already lands in the App_CMK-encrypted log group. The write is
 * awaited nowhere and its rejection is swallowed: a broken stdout pipe must not
 * turn a contained 500 into an unhandled rejection that ends the process, which
 * is exactly what Req 7.6 forbids.
 */
function logHandlerError(
  logWriter: LogWriter,
  routeId: TriggerRouteId | 'unmatched',
  method: string,
  path: string,
  facts: ErrorFacts,
): void {
  const line = serialize({
    level: 'error',
    event: 'route-handler-error',
    routeId,
    method,
    path,
    errorName: facts.name,
    errorMessage: facts.message,
  });
  if (line === undefined) return;
  void logWriter.write(line).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

type BodyRead =
  | { kind: 'read'; text: string }
  | { kind: 'too-large' }
  | { kind: 'aborted' };

/**
 * Read the request body, enforcing the cap WHILE reading.
 *
 * The byte count is checked on every chunk and the request is destroyed the
 * moment it crosses the limit, so an oversized upload costs the task the limit
 * plus one chunk rather than the whole payload. Buffering first and measuring
 * after would make the cap decorative.
 */
function readBody(req: IncomingMessage, limitBytes: number): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;

    const settle = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        // Buffering stops here, which is the whole point of the cap: the task
        // holds at most the limit plus one chunk, whatever the peer sends next.
        // The request is NOT destroyed yet - the caller answers 413 first and
        // destroys once that response has flushed, otherwise the client would
        // see a dropped connection instead of the refusal.
        chunks.length = 0;
        settle({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => settle({ kind: 'read', text: decodeChunks(chunks, size) }));
    req.on('error', () => settle({ kind: 'aborted' }));
    req.on('aborted', () => settle({ kind: 'aborted' }));
  });
}

/** Join the chunks and decode as UTF-8. */
function decodeChunks(chunks: readonly Uint8Array[], size: number): string {
  if (chunks.length === 0) return '';
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

/** The two methods that carry a body in the Trigger_Route table. */
function carriesBody(method: string): boolean {
  return method === 'POST' || method === 'PUT';
}

// ---------------------------------------------------------------------------
// The request listener
// ---------------------------------------------------------------------------

export interface ServerDeps {
  /** Everything the eight handlers need. */
  routes: TriggerRouteDeps;
  /** Where the one structured line per failed handler goes. */
  logWriter: LogWriter;
  /** The health flag `GET /health` reads. Owned by the caller so shutdown can flip it. */
  health: HealthFlag;
  /** Adapter overrides, entry by entry. Defaults to `ROUTE_ADAPTERS`. */
  adapters?: Readonly<Partial<Record<TriggerRouteId, RouteAdapter>>>;
  /** Body ceiling override. Defaults to `MAX_BODY_BYTES`. */
  bodyLimitBytes?: number;
  /** In-flight counter, so shutdown can wait. Defaults to a private one. */
  inFlight?: InFlightTracker;
}

/**
 * Build the request listener.
 *
 * Holds no module-level state: every dependency arrives in `deps`, so the whole
 * dispatch can be driven from a test with a fake request and response and no
 * port bound.
 */
export function createRequestListener(deps: ServerDeps): RequestListener {
  const adapters: Record<TriggerRouteId, RouteAdapter> = { ...ROUTE_ADAPTERS, ...deps.adapters };
  const limitBytes = deps.bodyLimitBytes ?? MAX_BODY_BYTES;
  const inFlight = deps.inFlight ?? createInFlightTracker();

  return (req, res) => {
    inFlight.enter();
    void serve(req, res, deps, adapters, limitBytes).finally(() => inFlight.leave());
  };
}

/** Parse the request target. Total: a target `new URL` rejects still yields a path. */
function parseTarget(target: string): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(target, URL_BASE);
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    const cut = target.indexOf('?');
    return {
      pathname: cut === -1 ? target : target.slice(0, cut),
      query: new URLSearchParams(),
    };
  }
}

/** Serve one request. Never throws: every failure becomes a response. */
async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  adapters: Record<TriggerRouteId, RouteAdapter>,
  limitBytes: number,
): Promise<void> {
  const method = req.method ?? '';
  const { pathname, query } = parseTarget(req.url ?? '/');

  // The health check comes first, and reads nothing but the in-memory flag.
  if (method === 'GET' && pathname === HEALTH_PATH) {
    const status = deps.health.status();
    if (status === 'ok') writeBody(res, 200, { status: 'ok' });
    else writeBody(res, 503, { status });
    return;
  }

  const match = matchRoute(method, pathname);
  if (!match.matched) {
    writeBody(res, 404, {
      error: `No route for ${method} ${pathname}`,
      method,
      path: pathname,
    });
    return;
  }

  const read = await readBody(req, limitBytes);
  if (read.kind === 'aborted') {
    // The peer went away mid-body. Nothing to answer to.
    return;
  }
  if (read.kind === 'too-large') {
    const payload =
      serialize({ error: `Request body exceeds ${limitBytes} bytes` }) ??
      '{"error":"Request body too large"}';
    // Refuse first, then abandon the rest of the upload.
    writeJson(res, 413, payload, () => req.destroy());
    return;
  }

  let body: unknown;
  if (carriesBody(method) && read.text.trim() !== '') {
    try {
      body = JSON.parse(read.text);
    } catch {
      writeBody(res, 400, { error: 'Request body is not valid JSON' });
      return;
    }
  }

  const routeId = match.route.id;
  let status: number;
  let payload: string;

  try {
    const result = await adapters[routeId](deps.routes, {
      route: match.route,
      params: match.params,
      query,
      body,
    });
    const serialized = serialize(result.body);
    if (serialized === undefined) {
      throw new TypeError(`Route ${routeId} answered with a body that cannot be serialized`);
    }
    status = result.status;
    payload = serialized;
  } catch (thrown) {
    // Contained: a generic body with no detail from the thrown value, one
    // structured log line, and a listener that keeps serving (Req 7.6).
    logHandlerError(deps.logWriter, routeId, method, pathname, describeThrown(thrown));
    writeJson(res, 500, '{"error":"Internal error"}');
    return;
  }

  writeJson(res, status, payload);
}

// ---------------------------------------------------------------------------
// Process access
// ---------------------------------------------------------------------------

/**
 * The process members this module needs, declared locally and read through
 * `globalThis`, exactly as `aws/stdout-log-writer.ts` and `server/startup.ts`
 * do. No `node:process` import reaches a package that also compiles for the
 * type-checker alone, and no ambient `process` declaration is needed.
 */
interface ProcessLike {
  env?: Record<string, string | undefined>;
  argv?: string[];
  stderr?: StartupErrorSink;
  exit?: (code: number) => void;
  on?: (signal: string, listener: () => void) => unknown;
}

function currentProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

/** A timer handle that may support `unref`. `unref` is Node-only. */
interface UnrefTimer {
  unref?: () => void;
}

/** Detach a timer from the event loop when the runtime supports it. */
function unref(timer: unknown): void {
  const handle = timer as UnrefTimer | undefined;
  if (handle && typeof handle.unref === 'function') handle.unref();
}

// ---------------------------------------------------------------------------
// Route dependency wiring
// ---------------------------------------------------------------------------

/**
 * Build the handler dependencies from a composed host.
 *
 * One place, so the eight handlers and the frame drain share ONE document
 * client, ONE lease registry and ONE connection inventory. `connections` is the
 * host's own map, not a copy: the spec-push handler replaces its contents and
 * `SecretsAdapter` reads it on every resolve, so both sides must see the same
 * object.
 */
export function buildTriggerRouteDeps(host: ComposedHost, now: () => number): TriggerRouteDeps {
  return {
    specStore: host.specStore,
    leaseStore: host.leaseStore,
    runHistory: host.runHistory,
    runEvents: host.runEvents,
    usageLedger: host.usageLedger,
    scheduleStore: host.scheduler,
    secrets: host.secrets,
    table: host.table,
    tableName: host.tableName,
    purge: (workflowId) => host.runTable.purge(workflowId),
    connections: host.connections,
    runnerId: host.env.runnerId,
    now,
  };
}

// ---------------------------------------------------------------------------
// The server handle
// ---------------------------------------------------------------------------

export interface ServerHandle {
  readonly server: Server;
  readonly env: ServerEnv;
  readonly host: ComposedHost;
  readonly health: HealthFlag;
  readonly routes: TriggerRouteDeps;
  /** The run whose lease this task holds, read by the drain and by shutdown. */
  readonly activeRun: ActiveRunRegistry;
  readonly inFlight: InFlightTracker;
  /** The port actually bound, which differs from `env.port` only for port 0. */
  readonly port: number;
  /** Stop the Frame_Inbox drain interval. Idempotent. */
  stopDrain(): void;
  /** How the process ends. Injectable so a test can observe it. */
  exit(code: number): void;
  now(): number;
  /** True from the moment the first shutdown signal is handled. */
  shuttingDown: boolean;
}

export interface StartServerOptions extends StartHostOptions {
  /** An already-composed host, so a test can skip AWS client construction. */
  host?: ComposedHost;
  /** Frame drain interval. Defaults to `FRAME_DRAIN_INTERVAL_MS` (500 ms). */
  drainIntervalMs?: number;
  /** Register `SIGTERM` and `SIGINT`. Defaults to true when `process.on` exists. */
  registerSignals?: boolean;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** `server.listen`, as a promise that rejects when the bind fails. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

/** The bound port, or the requested one when the runtime reports no address. */
function boundPort(server: Server, requested: number): number {
  const address = server.address();
  if (address !== null && typeof address === 'object' && typeof address.port === 'number') {
    return address.port;
  }
  return requested;
}

/**
 * Compose, assert, listen, drain, and register the signal handlers - the start
 * sequence of Req 7.1, in that order.
 *
 * `startHost` runs BEFORE `createServer`, so an incomplete adapter has already
 * reported and exited by the time a listener could exist. The health flag flips
 * to `ok` between those two steps, which is what keeps the NLB target from ever
 * reporting healthy on a partial adapter (Req 7.3).
 */
export async function startServer(
  env: ServerEnv,
  options: StartServerOptions = {},
): Promise<ServerHandle> {
  const { host: injectedHost, drainIntervalMs, registerSignals, ...hostOptions } = options;
  const now = options.now ?? Date.now;

  // Step 2: compose and assert. Throws or exits before any listener exists.
  const host = injectedHost ?? startHost(env, hostOptions);

  const health = createHealthFlag('starting');
  const routes = buildTriggerRouteDeps(host, now);
  const activeRun = createActiveRunRegistry();
  const inFlight = createInFlightTracker();

  // The assertion has passed, so the health check may now answer 200 (Req 7.2).
  health.set('ok');

  // Step 3: listen.
  const server = createServer(
    createRequestListener({ routes, logWriter: host.logWriter, health, inFlight }),
  );
  await listen(server, env.port);

  // Step 4: the Frame_Inbox drain, on an interval inside the 1000 ms of Req 7.7.
  let drainTimer: ReturnType<typeof setInterval> | undefined = undefined;
  let draining = false;
  const drainOnce = async (): Promise<void> => {
    // One drain at a time: a slow page must not overlap the next tick and
    // deliver the same frame twice.
    if (draining) return;
    draining = true;
    try {
      await drainFrameInbox({
        table: host.table,
        tableName: host.tableName,
        lease: () => activeRun.current()?.lease,
        deliver: (frame) => activeRun.current()?.deliver(frame),
      });
    } catch (thrown) {
      // A fence mismatch or a throttle must not end the process: the next tick
      // tries again, and the entry names why this one did not.
      logHandlerError(
        host.logWriter,
        'unmatched',
        'DRAIN',
        '/frame-inbox',
        describeThrown(thrown),
      );
    } finally {
      draining = false;
    }
  };
  drainTimer = setInterval(() => {
    void drainOnce();
  }, drainIntervalMs ?? FRAME_DRAIN_INTERVAL_MS);
  // The drain must never be the reason the process stays alive during shutdown.
  unref(drainTimer);

  const handle: ServerHandle = {
    server,
    env,
    host,
    health,
    routes,
    activeRun,
    inFlight,
    port: boundPort(server, env.port),
    stopDrain: () => {
      if (drainTimer === undefined) return;
      clearInterval(drainTimer);
      drainTimer = undefined;
    },
    exit: options.exit ?? resolveExit(),
    now,
    shuttingDown: false,
  };

  // Step 5: the signal handlers.
  if (registerSignals !== false) registerSignalHandlers(handle);

  return handle;
}

/**
 * Register `SIGTERM` and `SIGINT`, both running the same shutdown.
 *
 * SIGTERM is what ECS sends on a task stop or a deployment; SIGINT is what a
 * local run gets from Ctrl+C. Both mean the same thing to this process, so both
 * take the drain path rather than letting Ctrl+C leave a lease held for its full
 * 60 second expiry.
 */
export function registerSignalHandlers(handle: ServerHandle): void {
  const on = currentProcess()?.on;
  if (typeof on !== 'function') return;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    on(signal, () => {
      void shutdown(handle, signal);
    });
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/** `server.close`, as a promise that resolves even when the close reports an error. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive connections sitting idle between requests would otherwise hold
    // the close open for their whole timeout.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

/**
 * Drain and exit, within the budget of Req 7.8.
 *
 * The order is what the requirement asks for: stop being routable first, stop
 * accepting second, finish what is in flight third, then stop the drain and
 * release the lease. Releasing the lease LAST means the next task cannot acquire
 * it while this one is still writing.
 *
 * The hard guard is armed first and is `unref`'d, so it can force the exit if a
 * request hangs, and it can never be the reason the process stays alive.
 * Idempotent: a second signal during the drain is ignored.
 */
export async function shutdown(handle: ServerHandle, signal: string): Promise<void> {
  if (handle.shuttingDown) return;
  handle.shuttingDown = true;

  // 1. Fail the health check so the target is deregistered.
  handle.health.set('draining');

  const guard = setTimeout(() => handle.exit(0), SHUTDOWN_BUDGET_MS);
  unref(guard);

  try {
    // 2. Stop accepting, then wait for in-flight requests.
    await closeServer(handle.server);
    await handle.inFlight.idle();

    // 3. Stop the drain before releasing, so no drain writes under a released lease.
    handle.stopDrain();

    // 4. Release any held lease, so the next task acquires immediately.
    const active = handle.activeRun.current();
    if (active) {
      await handle.host.leaseStore.release(active.lease, handle.now());
      handle.activeRun.set(undefined);
    }

    await handle.host.logWriter
      .write(serialize({ level: 'info', event: 'shutdown', signal }) ?? '{}')
      .catch(() => undefined);
  } catch (thrown) {
    // A failed release must not keep the task alive: the lease expires on its
    // own within 60 seconds, and the exit below is what ECS is waiting for.
    logHandlerError(handle.host.logWriter, 'unmatched', 'SHUTDOWN', signal, describeThrown(thrown));
  } finally {
    clearTimeout(guard);
    // 5. Exit 0, inside the 30 seconds of Req 7.8.
    handle.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function resolveStderr(): StartupErrorSink {
  const stderr = currentProcess()?.stderr;
  if (!stderr || typeof stderr.write !== 'function') {
    throw new Error(
      'Server_Entry needs process.stderr to report a startup failure, and this ' +
        'runtime exposes none. Pass a stderr sink explicitly when running outside Node.',
    );
  }
  return stderr;
}

function resolveExit(): (code: number) => void {
  const exit = currentProcess()?.exit;
  if (typeof exit !== 'function') {
    throw new Error(
      'Server_Entry needs process.exit to end the process, and this runtime ' +
        'exposes none. Pass an exit function explicitly when running outside Node.',
    );
  }
  return exit;
}

/**
 * Report an environment failure and exit non-zero.
 *
 * Every missing name on its own line, for the same reason `startup.ts` reports
 * capabilities that way: the operator fixes the task definition once instead of
 * once per redeploy (Req 7.9). Anything that is not an environment failure
 * propagates unchanged rather than being flattened into this report.
 */
function reportEnvFailure(
  error: unknown,
  stderr: StartupErrorSink,
  exit: (code: number) => void,
): void {
  if (error instanceof MissingEnvError) {
    stderr.write(`${error.message}\n`);
    for (const name of error.missing) stderr.write(`${name}\n`);
  } else if (error instanceof InvalidEnvError) {
    stderr.write(`${error.message}\n`);
  } else {
    throw error;
  }
  exit(EXIT_STARTUP_FAILURE);
}

/**
 * The container entry point.
 *
 * Reads `process.env` at the one place a Node runtime is guaranteed to exist,
 * which is why `readServerEnv` takes the environment as a parameter. Resolves
 * with the handle when the listener is up, and with `undefined` when the
 * environment was unusable and the process is on its way out.
 */
export async function main(options: StartServerOptions = {}): Promise<ServerHandle | undefined> {
  const stderr = options.stderr ?? resolveStderr();
  const exit = options.exit ?? resolveExit();

  let env: ServerEnv;
  try {
    env = readServerEnv(currentProcess()?.env ?? {});
  } catch (error) {
    reportEnvFailure(error, stderr, exit);
    return undefined;
  }

  return startServer(env, options);
}

/**
 * True when this module is the process entry, so importing it from a test or a
 * scenario script never binds a port.
 *
 * The container runs the esbuild bundle as `node server.mjs`, where
 * `import.meta.url` is that file and `process.argv[1]` is the path node was
 * given. Under vitest or `tsx`, `argv[1]` is the runner, so the comparison fails
 * and nothing starts.
 */
function isProcessEntry(): boolean {
  const entry = currentProcess()?.argv?.[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const normalized = entry.replace(/\\/g, '/');
  return import.meta.url.endsWith(normalized) || import.meta.url.endsWith(encodeURI(normalized));
}

if (isProcessEntry()) {
  void main();
}
