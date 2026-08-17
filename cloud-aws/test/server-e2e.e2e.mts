/**
 * E2E scenario: the real Server_Entry over a real loopback socket.
 *
 * This is the ONE test in the feature that binds a TCP port and drives the real
 * `node:http` listener end to end. `src/server/index.spec.ts` deliberately calls
 * `createRequestListener` with a hand-built request and response and no port, so
 * nothing there proves the process actually serves. This script does: it starts
 * the real `startServer` on port 0, reads the bound port back off the handle and
 * speaks to it with `fetch`.
 *
 * What it covers:
 *   1. `GET /health` - 200 once serving, 503 while `starting` or `draining`
 *      (Req 7.2)
 *   2. One real HTTP call per Trigger_Route, path parameters included (Req 7.4)
 *   3. The 404 body shape for an unmatched request (Req 7.5)
 *   4. The 500 containment shape: generic body, no detail from the thrown value,
 *      one structured log line, and a listener that keeps serving (Req 7.6)
 *   5. A Frame_Inbox drain round trip: seed a frame, set the active run, let the
 *      interval tick, assert the frame reached the sink and the item was
 *      fenced-deleted (Req 7.7, and the fencing invariant of Req 2.5)
 *   6. A SIGTERM shutdown that fails the health check, stops accepting, stops the
 *      drain, releases the lease and exits 0 (Req 7.8)
 *
 * No AWS client and no credential: the host is composed through
 * `composeHostAdapter`'s `factories` seam over `FakeDocumentTableClient` and the
 * fake monitor, secrets and scheduler backends, exactly as `startup.spec.ts`
 * does. Only the socket is real.
 *
 * Two things this script is careful about, both of which have bitten scripts in
 * this package before:
 *
 * - The `tsx` hazard. Awaiting anything that cannot settle hangs the process on
 *   an unsettled top-level await, and the failure looks like silence. No run is
 *   started here at all, and the frame delivery is synchronised on a
 *   side-channel promise resolved from inside the frame sink, raced against a
 *   timeout that always settles.
 * - Termination. Every timer this script creates is cleared, the drain interval
 *   is stopped by `shutdown`, and the listener is closed - so the process exits
 *   on its own after the last assertion rather than sitting on an open handle.
 *
 * Run: npx -y tsx cloud-aws/test/server-e2e.e2e.mts
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.7, 7.8, 13.8
 */

import type { ControlFrame } from '../src/core/frames.js';
import type { HeldLease } from '../src/core/host-contract.js';
import { frameSk, leaseSk, pk } from '../src/core/keys.js';
import { TRIGGER_ROUTES } from '../src/core/route-table.js';
import type { TriggerRouteId } from '../src/core/route-table.js';
import type { LogWriter, MetricPublisher } from '../src/aws/ports.js';
import { FakeDocumentTableClient } from '../src/test/fake-document-table-client.js';
import { FakeRunTable } from '../src/test/fake-run-table.js';
import { FakeMonitorBackend } from '../src/test/fake-monitor.js';
import { FakeSchedulerBackend } from '../src/test/fake-scheduler.js';
import { FakeSecretsManager } from '../src/test/fake-secrets-manager.js';
import type { ServerEnv } from '../src/server/env.js';
import { composeHostAdapter } from '../src/server/startup.js';
import type { HostFactories } from '../src/server/startup.js';
import { shutdown, startServer } from '../src/server/index.js';
import type { ServerHandle } from '../src/server/index.js';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  \u2713 ${name}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Sleep. Every timer is short and cleared by the runtime once it fires. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout, and ALWAYS settle.
 *
 * The tsx hazard in one function: the caller can await this even when the
 * promise it wraps never resolves, so a broken drain reports a timeout instead
 * of hanging the process with no output.
 */
function settledWithin(promise: Promise<unknown>, ms: number, what: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.error(`  [timeout] ${what}`);
      resolve(false);
    }, ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Poll a predicate until it holds or the deadline passes. Always settles. */
async function pollUntil(predicate: () => boolean, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      console.error(`  [timeout] ${what}`);
      return false;
    }
    await sleep(10);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const TABLE_NAME = 'phorma-runs-e2e';
const RUNNER_ID = 'runner-e2e';

/** The workflow the eight Trigger_Route calls address. */
const WF = 'wf-e2e';
/** A second workflow, so the lease the drain runs under is its own. */
const WF_FRAMES = 'wf-e2e-frames';
/** The connection the secret-write route addresses. Must match the engine id pattern. */
const CONN = 'conn-e2e';
const SECRET_KEY = 'API_KEY';
/** The secret value, so the connections route can be shown not to echo it. */
const SECRET_VALUE = 'sk-loopback-e2e-0123456789';

/**
 * A recognisable marker for the containment check. It cannot appear in the
 * contained 500 body by accident, so finding it there is proof detail leaked.
 */
const MARKER = 'SECRET-LOOPBACK-9F3C-LEAK';

// ---------------------------------------------------------------------------
// The host, composed from fakes
// ---------------------------------------------------------------------------

const table = new FakeDocumentTableClient(new FakeRunTable(), { tableName: TABLE_NAME });
const monitor = new FakeMonitorBackend();
const secrets = new FakeSecretsManager();
const scheduler = new FakeSchedulerBackend();

/** Every line the host wrote, so the containment and shutdown lines can be read. */
const logLines: string[] = [];
const logWriter: LogWriter = {
  write: async (line) => {
    logLines.push(line);
  },
};
const metricPublisher: MetricPublisher = { publish: async () => {} };

const factories: Partial<HostFactories> = {
  createDocumentTableClient: () => table,
  createMonitorBackend: () => monitor,
  createSecretsBackend: () => secrets,
  createSchedulerBackend: () => scheduler,
  createMetricPublisher: () => metricPublisher,
  createStdoutLogWriter: () => logWriter,
};

const env: ServerEnv = {
  region: 'eu-west-1',
  runTableName: TABLE_NAME,
  monitorEndpoint: 'https://monitor.example.com',
  secretPrefix: 'phorma/e2e',
  metricNamespace: 'Phorma/E2E',
  scheduleGroup: 'phorma-e2e-schedules',
  scheduleTargetArn: 'arn:aws:lambda:eu-west-1:123456789012:function:phorma-schedule-shim',
  scheduleRoleArn: 'arn:aws:iam::123456789012:role/phorma-scheduler',
  runnerId: RUNNER_ID,
  // Port 0: the runtime picks a free port and `handle.port` reports it back, so
  // the script never collides with a port a developer happens to be using.
  port: 0,
};

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level?: string;
  event?: string;
  routeId?: string;
  method?: string;
  path?: string;
  errorName?: string;
  errorMessage?: string;
  signal?: string;
}

function entries(): LogEntry[] {
  const parsed: LogEntry[] = [];
  for (const line of logLines) {
    try {
      parsed.push(JSON.parse(line) as LogEntry);
    } catch {
      // A non-JSON line is itself a defect, and the assertions below will miss
      // the entry they were looking for rather than throwing here.
    }
  }
  return parsed;
}

function routeErrors(): LogEntry[] {
  return entries().filter((entry) => entry.event === 'route-handler-error');
}

// ---------------------------------------------------------------------------
// Recorded-request helpers
// ---------------------------------------------------------------------------

/** How many Frame_Inbox `Query` calls the drain has issued. */
function drainQueryCount(): number {
  return table.requests.filter((request) => {
    if (request.operation !== 'Query') return false;
    const input = request.input as { ExpressionAttributeValues?: Record<string, unknown> };
    return input.ExpressionAttributeValues?.[':prefix'] === 'frame#';
  }).length;
}

/** The most recent `TransactWriteItems` input, as the client received it. */
function lastTransact(): { TransactItems?: unknown[] } | undefined {
  const transacts = table.requests.filter((r) => r.operation === 'TransactWriteItems');
  return transacts[transacts.length - 1]?.input as { TransactItems?: unknown[] } | undefined;
}

/** Frame_Inbox items still stored, read straight off the fake table. */
function storedFrames(): { sk: string }[] {
  return table.table.query({ pk: pk(WF_FRAMES), skPrefix: 'frame#' }).items as { sk: string }[];
}

/** The stored lease item for a workflow, or undefined. */
function storedLease(workflowId: string): Record<string, unknown> | undefined {
  return table.table.getItem({ pk: pk(workflowId), sk: leaseSk() }) ?? undefined;
}

// ---------------------------------------------------------------------------
// HTTP over the bound port
// ---------------------------------------------------------------------------

let base = '';

interface Answer {
  status: number;
  text: string;
  json: unknown;
}

async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

function field(answer: Answer, name: string): unknown {
  const body = answer.json;
  if (body === null || typeof body !== 'object') return undefined;
  return (body as Record<string, unknown>)[name];
}

// ---------------------------------------------------------------------------
// The spec the push route stores
// ---------------------------------------------------------------------------

/**
 * The smallest spec that passes the Capability_Validator against
 * AWS_CAPABILITIES: one manual trigger, no schedule, no connection reference.
 * What is under test here is the HTTP path, not the validator.
 */
function e2eSpec(): unknown {
  return {
    version: 1,
    id: WF,
    name: 'Loopback E2E',
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'trig',
          name: 'Start',
          kind: 'manual-trigger',
          category: 'flow',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: 'trig-start', name: 'Start', role: 'message-out' }],
          data: {},
        },
      ],
      connections: [],
    },
  };
}

/** Connection metadata carrying a secret NAME and no secret value. */
function e2eConnection(): unknown {
  return {
    id: CONN,
    name: 'E2E HTTP',
    type: 'http',
    config: { baseUrl: 'https://api.example.com' },
    secretKeys: [SECRET_KEY],
    auth: { mode: 'none' },
  };
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

console.log('Scenario: Server_Entry over loopback');

const exitCodes: number[] = [];

const host = composeHostAdapter(env, { factories });

let handle: ServerHandle;
try {
  handle = await startServer(env, {
    // The composed host, so no AWS client is constructed and no credential is
    // resolved. `startServer` still runs its own start sequence around it.
    host,
    // Well inside the 1000 ms ceiling of Req 7.7, so the round trip below does
    // not have to wait half a second for a tick.
    drainIntervalMs: 25,
    // The signal handlers are one line that calls the same exported `shutdown`
    // this script calls directly. Registering them here would leave listeners on
    // `process` behind and, on Windows, `process.kill(pid, 'SIGTERM')` ends the
    // process outright rather than raising a signal - so the shutdown path is
    // driven through `shutdown(handle, 'SIGTERM')` instead.
    registerSignals: false,
    // So the script survives its own shutdown.
    exit: (code) => exitCodes.push(code),
  });
} catch (thrown) {
  console.error(`  \u2717 startServer threw - ${String(thrown)}`);
  process.exit(1);
}

base = `http://127.0.0.1:${handle.port}`;

// ─── 1. The listener is really bound (Req 7.1) ─────────────────────────────
console.log('\nBinding');
check('a real port was bound', handle.port > 0, `port ${handle.port}`);
check('the bound port differs from the requested 0', handle.port !== env.port);

// ─── 2. The health check (Req 7.2) ─────────────────────────────────────────
console.log('\nHealth check');
{
  const ok = await call('GET', '/health');
  check('GET /health answers 200 once serving', ok.status === 200, `got ${ok.status}`);
  check('GET /health body is {"status":"ok"}', ok.text === '{"status":"ok"}', ok.text);

  // The flag flips to `ok` BEFORE `listen`, so a socket can never observe
  // `starting` in production - that is the point of the ordering. Flipping it
  // back is how the 503 answer is exercised over a real socket.
  handle.health.set('starting');
  const starting = await call('GET', '/health');
  check('GET /health answers 503 while starting', starting.status === 503, `got ${starting.status}`);
  check('the 503 body names the state', starting.text === '{"status":"starting"}', starting.text);

  handle.health.set('draining');
  const draining = await call('GET', '/health');
  check('GET /health answers 503 while draining', draining.status === 503, `got ${draining.status}`);
  check('the 503 body names the state', draining.text === '{"status":"draining"}', draining.text);

  handle.health.set('ok');
  const again = await call('GET', '/health');
  check('GET /health answers 200 again', again.status === 200, `got ${again.status}`);
}

// ─── 3. One call per Trigger_Route, path parameters included (Req 7.4) ──────
console.log('\nTrigger_Routes');

/** Every route id that has been answered over the socket. */
const served = new Set<TriggerRouteId>();

{
  const push = await call('POST', `/workflows/${WF}/spec`, {
    spec: e2eSpec(),
    connections: [e2eConnection()],
  });
  served.add('spec-push');
  check('POST /workflows/{id}/spec answers 200', push.status === 200, push.text);
  check('the push echoes the path parameter as the workflow id', field(push, 'workflowId') === WF);
  check(
    'the stored spec landed in the workflow partition',
    table.table.getItem({ pk: pk(WF), sk: 'spec' }) !== null,
  );
}

{
  const trigger = await call('POST', `/workflows/${WF}/trigger`, { runId: 'run-e2e-1' });
  served.add('trigger');
  check('POST /workflows/{id}/trigger answers 202', trigger.status === 202, trigger.text);
  check('the trigger reports the granted lease', typeof field(trigger, 'lease') === 'object');
  check('the lease acquire reached Run_Table', storedLease(WF) !== undefined);
}

{
  const history = await call('GET', `/workflows/${WF}/runs`);
  served.add('run-history');
  check('GET /workflows/{id}/runs answers 200', history.status === 200, history.text);
  check('the history body carries an items array', Array.isArray(field(history, 'items')));
}

{
  // No run record exists, so the handler's own 404 is the correct answer - and
  // it names the `runId` path parameter, which is what proves the second path
  // parameter reached the handler rather than being dropped by the matcher.
  const detail = await call('GET', `/workflows/${WF}/runs/run-e2e-1`);
  served.add('run-detail');
  check('GET /workflows/{id}/runs/{runId} answers 404 for an unknown run', detail.status === 404);
  check(
    'the run-detail 404 names the runId path parameter',
    typeof field(detail, 'error') === 'string' && String(field(detail, 'error')).includes('run-e2e-1'),
    detail.text,
  );
}

{
  const usage = await call('GET', `/workflows/${WF}/usage?since=1970-01-01T00:00:00.000Z`);
  served.add('usage');
  check('GET /workflows/{id}/usage answers 200', usage.status === 200, usage.text);
  check('the usage body carries an items array', Array.isArray(field(usage, 'items')));

  const rejected = await call('GET', `/workflows/${WF}/usage?since=not-a-date`);
  check('an invalid since value is rejected with 400', rejected.status === 400, rejected.text);
}

{
  const write = await call('PUT', `/connections/${CONN}/secrets/${SECRET_KEY}`, {
    value: SECRET_VALUE,
  });
  served.add('secret-write');
  check('PUT /connections/{connId}/secrets/{key} answers 200', write.status === 200, write.text);
  check(
    'the response names the Secret_Store entry and no value',
    typeof field(write, 'name') === 'string' && !write.text.includes(SECRET_VALUE),
    write.text,
  );
  check(
    'both path parameters reached the Secret_Store entry name',
    String(field(write, 'name')).includes(CONN) && String(field(write, 'name')).includes(SECRET_KEY),
    String(field(write, 'name')),
  );
  check('the value landed in the secrets backend', secrets.size === 1);
}

{
  const connections = await call('GET', `/workflows/${WF}/connections`);
  served.add('connections');
  check('GET /workflows/{id}/connections answers 200', connections.status === 200, connections.text);
  const list = field(connections, 'connections');
  check('the inventory is wrapped in a {connections} object', Array.isArray(list));
  check(
    'the pushed connection is in the inventory',
    Array.isArray(list) && list.some((c) => (c as { id?: string }).id === CONN),
    connections.text,
  );
  check('the inventory carries no secret value', !connections.text.includes(SECRET_VALUE));
}

{
  const purge = await call('DELETE', `/workflows/${WF}`);
  served.add('purge');
  check('DELETE /workflows/{id} answers 200', purge.status === 200, purge.text);
  check('the purge counted the stored spec', field(purge, 'spec') === 1, purge.text);
  check('the spec is gone from Run_Table', table.table.getItem({ pk: pk(WF), sk: 'spec' }) === null);
}

check(
  'all eight Trigger_Routes were answered over the socket',
  served.size === TRIGGER_ROUTES.length,
  `served ${served.size} of ${TRIGGER_ROUTES.length}`,
);

// ─── 4. The 404 shape (Req 7.5) ────────────────────────────────────────────
console.log('\nUnmatched request');
{
  const missing = await call('GET', `/workflows/${WF}/nope`);
  check('an unmatched path answers 404', missing.status === 404, `got ${missing.status}`);
  check(
    'the 404 body names the unmatched method and path',
    field(missing, 'error') === `No route for GET /workflows/${WF}/nope` &&
      field(missing, 'method') === 'GET' &&
      field(missing, 'path') === `/workflows/${WF}/nope`,
    missing.text,
  );

  const wrongMethod = await call('DELETE', `/workflows/${WF}/runs`);
  check('a known path under the wrong method answers 404', wrongMethod.status === 404);
}

// ─── 5. The 500 containment shape (Req 7.6) ────────────────────────────────
console.log('\nHandler throw containment');
{
  const before = routeErrors().length;

  // `startServer` builds the listener itself, so the `adapters` seam of
  // `createRequestListener` is not reachable from here. The equivalent
  // injection point is the handler's own dependency: the purge route calls
  // `deps.purge`, and the listener reads `deps.routes` per request, so
  // replacing that one function makes the real adapter throw on a real request.
  handle.routes.purge = async () => {
    throw new Error(MARKER);
  };

  const failed = await call('DELETE', `/workflows/${WF}`);
  check('a throwing handler answers 500', failed.status === 500, `got ${failed.status}`);
  check('the 500 body carries no detail from the thrown value', !failed.text.includes(MARKER));
  check('the 500 body is the generic one', failed.text === '{"error":"Internal error"}', failed.text);

  const logged = routeErrors();
  check('exactly one structured log line was written', logged.length === before + 1,
    `got ${logged.length - before}`);
  const line = logged[logged.length - 1];
  check('the log line names the route and the method', line?.routeId === 'purge' && line?.method === 'DELETE');
  check(
    'the log line carries the error detail the response withheld',
    typeof line?.errorMessage === 'string' && line.errorMessage.includes(MARKER),
    String(line?.errorMessage),
  );

  // Still serving, which is the half of Req 7.6 a unit test cannot claim about
  // a real listener: the same socket answers the health check and another route.
  const health = await call('GET', '/health');
  check('the listener still answers the health check', health.status === 200);
  const other = await call('GET', `/workflows/${WF}/runs`);
  check('the listener still answers another route', other.status === 200);
}

// ─── 6. The Frame_Inbox drain round trip (Req 7.7) ─────────────────────────
console.log('\nFrame_Inbox drain');

let lease: HeldLease | undefined;
const delivered: ControlFrame[] = [];
const frameKey = frameSk(1_700_000_000_000, 'conn-monitor-1', 1);

{
  const outcome = await host.leaseStore.acquire(WF_FRAMES, RUNNER_ID, Date.now());
  check('the drain lease was granted', outcome.granted === true);
  lease = outcome.granted ? outcome.lease : undefined;
}

if (lease) {
  const frame: ControlFrame = { type: 'event', correlationKey: 'e2e-key', payload: 'hello' };

  // Seeded exactly as the Monitor_API `$default` integration writes it: the raw
  // frame text in `body`, under the ordered `frame#` sort key.
  await host.table.put({
    TableName: TABLE_NAME,
    Item: {
      pk: pk(WF_FRAMES),
      sk: frameKey,
      workflowId: WF_FRAMES,
      connectionId: 'conn-monitor-1',
      arrivedAtMs: 1_700_000_000_000,
      body: JSON.stringify(frame),
    },
  });

  // The side channel: the sink resolves this, so the script synchronises on the
  // delivery itself rather than on anything that could fail to settle.
  let signalDelivery: (() => void) | undefined;
  const firstDelivery = new Promise<void>((resolve) => {
    signalDelivery = resolve;
  });

  handle.activeRun.set({
    lease,
    deliver: (received) => {
      delivered.push(received);
      signalDelivery?.();
    },
  });

  const arrived = await settledWithin(firstDelivery, 3000, 'the drain to deliver the frame');
  check('the drain delivered the frame to the sink', arrived);
  check('exactly one frame was delivered', delivered.length === 1, `got ${delivered.length}`);
  check(
    'the delivered frame is the one that was seeded',
    JSON.stringify(delivered[0]) === JSON.stringify(frame),
    JSON.stringify(delivered[0]),
  );

  const consumed = await pollUntil(
    () => storedFrames().length === 0,
    3000,
    'the drained frame to be deleted',
  );
  check('the drained item was removed from the Frame_Inbox', consumed);

  const transact = lastTransact();
  const items = (transact?.TransactItems ?? []) as {
    ConditionCheck?: { Key?: { sk?: string }; ExpressionAttributeValues?: Record<string, unknown> };
    Delete?: { Key?: { sk?: string } };
  }[];
  check(
    'the delete was a fenced transaction with the lease ConditionCheck first',
    items.length === 2 && items[0]?.ConditionCheck?.Key?.sk === leaseSk(),
    `items: ${items.length}`,
  );
  check(
    'the ConditionCheck asserts this runner fence',
    Object.values(items[0]?.ConditionCheck?.ExpressionAttributeValues ?? {}).includes(lease.fence),
  );
  check('the transaction deleted the seeded frame key', items[1]?.Delete?.Key?.sk === frameKey);

  check(
    'the drain logged no error',
    routeErrors().every((entry) => entry.method !== 'DRAIN'),
    JSON.stringify(routeErrors().filter((e) => e.method === 'DRAIN')),
  );
}

// ─── 7. SIGTERM shutdown (Req 7.8) ─────────────────────────────────────────
console.log('\nSIGTERM shutdown');
{
  const leaseBefore = storedLease(WF_FRAMES);
  const expiryBefore = leaseBefore?.['expiresAtMs'] as number | undefined;

  const settled = await settledWithin(
    shutdown(handle, 'SIGTERM'),
    5000,
    'shutdown to complete inside its budget',
  );
  check('shutdown completed', settled);

  check('the health flag reads draining', handle.health.status() === 'draining');
  check('shutdown is recorded on the handle', handle.shuttingDown === true);
  check('the process was asked to exit 0', exitCodes.length === 1 && exitCodes[0] === 0,
    JSON.stringify(exitCodes));

  // The lease is released, not deleted: expiry moves to now so the next task
  // acquires immediately, and the fencing token is retained.
  const leaseAfter = storedLease(WF_FRAMES);
  const expiryAfter = leaseAfter?.['expiresAtMs'] as number | undefined;
  check('the lease item still exists', leaseAfter !== undefined);
  check(
    'the lease expiry was pulled back to now',
    typeof expiryAfter === 'number' &&
      typeof expiryBefore === 'number' &&
      expiryAfter < expiryBefore &&
      expiryAfter <= Date.now(),
    `${String(expiryBefore)} -> ${String(expiryAfter)}`,
  );
  check(
    'the fencing token was retained',
    leaseAfter?.['fence'] === lease?.fence,
    `${String(leaseAfter?.['fence'])} vs ${String(lease?.fence)}`,
  );
  check('the active run was cleared', handle.activeRun.current() === undefined);

  check(
    'shutdown wrote its own log line naming the signal',
    entries().some((entry) => entry.event === 'shutdown' && entry.signal === 'SIGTERM'),
  );
  check(
    'the release path logged no error',
    routeErrors().every((entry) => entry.method !== 'SHUTDOWN'),
    JSON.stringify(routeErrors().filter((e) => e.method === 'SHUTDOWN')),
  );

  // The drain interval is stopped: no further Frame_Inbox query is issued.
  const queriesAfterShutdown = drainQueryCount();
  await sleep(150);
  check(
    'the Frame_Inbox drain stopped',
    drainQueryCount() === queriesAfterShutdown,
    `${queriesAfterShutdown} -> ${drainQueryCount()}`,
  );

  // And the listener is gone, so the socket refuses rather than answering 503.
  let refused = false;
  try {
    await call('GET', '/health');
  } catch {
    refused = true;
  }
  check('the listener stopped accepting connections', refused);

  // A second signal during or after the drain changes nothing.
  await shutdown(handle, 'SIGTERM');
  check('a second SIGTERM is a no-op', exitCodes.length === 1, JSON.stringify(exitCodes));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
