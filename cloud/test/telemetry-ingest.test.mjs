/**
 * `POST /telemetry` - the anonymous Ingest_Endpoint, end to end against a real
 * D1 database.
 *
 * These seven properties are the ones that cannot be decided from pure
 * functions. `test/telemetry.test.mjs` already covers the validation,
 * sanitization and geo algebra; what is left is what the ROUTE does: the
 * preflight it answers, the rows it writes, the rows it replaces, the requests
 * it refuses, what it never lets escape, whether the schema survives repeated
 * creation, and what the retention pass deletes.
 *
 * Harness. The worker is the exact bundle `wrangler deploy` would ship, run
 * under Miniflare with a real (in-memory) SQLite-backed D1 binding - no
 * network, no Cloudflare account. That bundle is wrapped by one small harness
 * module so three otherwise unobservable things become assertable:
 *
 *  1. `env.DB` is proxied, so every SQL string and every BOUND VALUE that
 *     reaches the Telemetry_Store is recorded. Property 23 needs the bound
 *     values, not just the stored row, and Property 20 needs the write COUNT.
 *  2. `console.*` is captured inside the isolate, so "no emitted log line
 *     contains a marker" (7.7) is a real assertion rather than a hope.
 *  3. `Date.now` is driven by an `x-test-now-ms` request header, so the rolling
 *     rate window (6.11), the `first_seen_at` claim (6.10) and the 400 day
 *     retention edge (8.5) are exact instead of approximate.
 *
 * The harness proxies and observes; it never replaces a decision. Every status
 * code, every SQL statement and every bound value below is produced by
 * `cloud/src/telemetry.ts` running in workerd.
 *
 * `ensureTelemetrySchema` is guarded by a MODULE-LEVEL promise, so it runs once
 * per isolate. That is deliberately not defeated here: the guard is part of the
 * behaviour under test. Instead the suite starts with one warm-up ingest, which
 * is the request that actually creates the schema, and captures the real
 * `TELEMETRY_SCHEMA_STATEMENTS` and the real prune statements from the SQL that
 * the module itself issued.
 *
 * Covers:
 *  - Property 17 (6.3), 20 (6.4), 21 (6.10, 8.1), 22 (6.11),
 *    23 (6.13, 7.4, 7.5, 7.7, 12.5, 12.6), 25 (8.4), 26 (8.5, 8.7)
 *  - examples for route order (6.1), a missing `Authorization` header (6.2) and
 *    the absent `DB` binding (6.12)
 *
 * Run: node cloud/test/telemetry-ingest.test.mjs
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';
import { loopbackRetries, withLoopbackRetry } from './miniflare-loopback.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(here, '..');

/** Every property test runs at least this many iterations. */
const RUNS = 100;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- Bounds restated from the requirements, not imported ------------------
// A test that imports the constant it is checking proves only self-consistency.

/** Requirement 6.11: more than 20 requests per Install_Id per hour -> 429. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 3_600_000;
/** Requirement 6.5: a body above 16 kilobytes -> 413. */
const MAX_BODY_BYTES = 16_384;
/** Requirement 6.9: every Client_Environment string is truncated to 64. */
const ENV_MAX = 64;
/** The Retention_Window (8.5). */
const RETENTION_DAYS = 400;
const MS_PER_DAY = 86_400_000;

/** A fixed virtual instant every property drives the worker clock to. */
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Real Counter_Catalog names (`cloud/src/telemetry-catalog.ts`), one per family. */
const CATALOG_NAMES = [
  'session.started',
  'run.started',
  'run.completed',
  'run.error',
  'node.created:agent',
  'node.created:http-request',
  'panel.opened:runs',
  'assistant.invoked:plan',
  'deploy.started:aws',
  'error:network',
];

// --- The harness module ----------------------------------------------------
// Plain JS, no backticks or template placeholders so it survives being carried
// as a string. It re-exports the bundle's Durable Object classes so their
// bindings still resolve, and delegates every non-`/__t/` request to the real
// worker.

const HARNESS = `
import worker from './worker.mjs';
export { WorkflowAgent, PortalIndex, SecretVault } from './worker.mjs';

/** Every console line the worker emitted since the last reset. */
const logs = [];
for (const level of ['log', 'error', 'warn', 'info', 'debug']) {
  console[level] = (...args) => { logs.push(args.map((a) => String(a)).join(' ')); };
}

/** Every SQL statement executed through the proxied DB, with its bound values. */
let binds = [];
/** Set from the x-test-now-ms header, so the worker clock is the test's clock. */
let virtualNow = null;
/** Failure injection: reject any batch carrying this exact SQL. */
let failSql = null;
let failMessage = 'injected failure';

const realNow = Date.now.bind(Date);
Date.now = () => (virtualNow === null ? realNow() : virtualNow);

function record(sql, values) {
  binds.push({ sql: sql, values: (values || []).map((v) => (v === undefined ? null : v)) });
}

function wrapStatement(inner, sql, values) {
  return {
    __sql: sql,
    __values: values,
    __inner: inner,
    bind(...args) { return wrapStatement(inner.bind(...args), sql, args); },
    first(column) { record(sql, values); return column === undefined ? inner.first() : inner.first(column); },
    run() { record(sql, values); return inner.run(); },
    all() { record(sql, values); return inner.all(); },
    raw(options) { record(sql, values); return inner.raw(options); },
  };
}

function wrapDb(db) {
  return {
    prepare(sql) { return wrapStatement(db.prepare(sql), sql, []); },
    batch(statements) {
      for (const statement of statements) record(statement.__sql, statement.__values);
      if (failSql !== null && statements.some((s) => s.__sql.startsWith(failSql))) {
        return Promise.reject(new Error(failMessage));
      }
      return db.batch(statements.map((s) => s.__inner));
    },
    exec(sql) { record(sql, []); return db.exec(sql); },
    dump() { return db.dump(); },
  };
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runStatements(db, statements) {
  const results = [];
  for (const entry of statements) {
    let prepared = db.prepare(entry.sql);
    if (Array.isArray(entry.params) && entry.params.length > 0) prepared = prepared.bind(...entry.params);
    const out = await prepared.all();
    results.push(out.results);
  }
  return results;
}

async function handleTestRoute(url, request, env) {
  const db = env.DB;
  if (url.pathname === '/__t/reset') {
    const body = await request.json();
    if (body.logs !== false) logs.length = 0;
    if (body.binds !== false) binds = [];
    // A reset ALWAYS clears failure injection, and that is load-bearing rather
    // than tidiness. failSql is module state in this worker, the ingest handler
    // CATCHES a rejected batch and answers 200 {} exactly as it does on a healthy
    // no-op, and nothing else in the suite writes it - so an injection left armed
    // by a throw between set and clear poisons every later iteration and every
    // later property, silently, as "0 stored rows". Observed: Property 23 failed
    // at test 67 and then shrank to the minimal input, because by then EVERY
    // input failed and the counterexample described nothing.
    failSql = null;
    if (body.tables === true && db) {
      await runStatements(db, [
        { sql: 'DELETE FROM telemetry_rollups' },
        { sql: 'DELETE FROM telemetry_ingest_rate' },
      ]);
    }
    return json({ ok: true });
  }
  if (url.pathname === '/__t/state') return json({ logs: logs, binds: binds });
  if (url.pathname === '/__t/fail') {
    const body = await request.json();
    failSql = body.sql === undefined ? null : body.sql;
    failMessage = body.message === undefined ? 'injected failure' : body.message;
    return json({ ok: true });
  }
  if (url.pathname === '/__t/sql') {
    const body = await request.json();
    const results = await runStatements(db, body.statements);
    return json({ results: results });
  }
  if (url.pathname === '/__t/schema') {
    const out = await db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'telemetry%' OR tbl_name LIKE 'telemetry%' ORDER BY type, name")
      .all();
    return json({ objects: out.results });
  }
  if (url.pathname === '/__t/schema-apply') {
    const body = await request.json();
    try {
      for (let pass = 0; pass < body.times; pass += 1) {
        await db.batch(body.statements.map((sql) => db.prepare(sql)));
      }
      return json({ ok: true, error: null });
    } catch (error) {
      return json({ ok: false, error: String(error) });
    }
  }
  if (url.pathname === '/__t/retention') {
    // The real scheduled() handler, including its containing .catch().
    const tasks = [];
    const ctx = { waitUntil: (p) => { tasks.push(p); }, passThroughOnException() {} };
    const proxied = db ? Object.assign({}, env, { DB: wrapDb(db) }) : env;
    await worker.scheduled(
      { cron: '17 3 * * *', scheduledTime: Date.now(), noRetry() {} },
      proxied,
      ctx,
    );
    const settled = await Promise.allSettled(tasks);
    return json({ ok: true, rejected: settled.filter((s) => s.status === 'rejected').length });
  }
  return json({ error: 'unknown test route' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const header = request.headers.get('x-test-now-ms');
    virtualNow = header === null ? null : Number(header);

    const url = new URL(request.url);
    if (url.pathname.startsWith('/__t/')) return handleTestRoute(url, request, env);

    const proxied = env.DB ? Object.assign({}, env, { DB: wrapDb(env.DB) }) : env;
    return worker.fetch(request, proxied, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
`;

// --- Build the exact deploy bundle, then run it under Miniflare ------------

const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-telemetry-ingest-'));
let script;
try {
  execFileSync(process.execPath, [wranglerBin, 'deploy', '--dry-run', '--outdir', bundleDir], {
    cwd: cloudRoot,
    stdio: 'pipe',
  });
  script = readFileSync(join(bundleDir, 'index.js'), 'utf8');
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}

const DURABLE_OBJECTS = {
  WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
  PortalIndex: { className: 'PortalIndex', useSQLite: true },
  SecretVault: { className: 'SecretVault', useSQLite: true },
};

/**
 * The bundle behind the harness, optionally with a D1 binding.
 *
 * `withLoopbackRetry` covers the loopback transport only - see
 * `test/miniflare-loopback.mjs`. Nothing about the worker's behaviour changes.
 */
function harnessWorker(bindings, withDb) {
  const worker = new Miniflare({
    modulesRoot: cloudRoot,
    modules: [
      { type: 'ESModule', path: join(cloudRoot, 'harness.mjs'), contents: HARNESS },
      { type: 'ESModule', path: join(cloudRoot, 'worker.mjs'), contents: script },
    ],
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: DURABLE_OBJECTS,
    ...(withDb ? { d1Databases: { DB: 'phorma-telemetry-test' } } : {}),
    bindings,
  });
  return withLoopbackRetry(worker);
}

/** The bare bundle, for the preflight pool where no observation is needed. */
function plainWorker(bindings) {
  const worker = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: DURABLE_OBJECTS,
    bindings,
  });
  return withLoopbackRetry(worker);
}

const HOSTED = { PHORMA_MODE: 'hosted', ALLOWED_ORIGINS: 'https://studio.example.com' };

const mf = harnessWorker(HOSTED, true);
const mfNoDb = harnessWorker(HOSTED, false);

// --- Request helpers -------------------------------------------------------

function rollup(overrides = {}) {
  return {
    installId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    metricDay: dayOf(T0),
    env: {
      locale: 'en-GB',
      timezone: 'Europe/London',
      platform: 'windows',
      osVersion: '10.0.26100',
      appVersion: '0.2.0-beta.10',
      runtimeMode: 'desktop',
    },
    counters: { 'session.started': 1 },
    schemaVersion: 1,
    ...overrides,
  };
}

async function ingest(worker, body, { now = T0, headers = {}, cf, method = 'POST' } = {}) {
  const response = await worker.dispatchFetch('http://localhost/telemetry', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-now-ms': String(now),
      ...headers,
    },
    ...(method === 'POST'
      ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
      : {}),
    ...(cf ? { cf } : {}),
  });
  return { status: response.status, text: await response.text() };
}

async function testRoute(worker, path, body) {
  const response = await worker.dispatchFetch(`http://localhost/__t/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

const reset = (worker, options) => testRoute(worker, 'reset', options ?? {});
const state = (worker) => testRoute(worker, 'state', {});
const sql = async (worker, statements) => (await testRoute(worker, 'sql', { statements })).results;
const injectFailure = (worker, options) => testRoute(worker, 'fail', options);
const retention = (worker) => testRoute(worker, 'retention', {});

const rollupRows = async (worker) =>
  (await sql(worker, [{ sql: 'SELECT * FROM telemetry_rollups ORDER BY install_id, metric_day' }]))[0];
const rateRows = async (worker) =>
  (await sql(worker, [{ sql: 'SELECT * FROM telemetry_ingest_rate ORDER BY install_id' }]))[0];

/** The write statements, matched the way the worker names them. */
const isRollupWrite = (entry) => entry.sql.startsWith('INSERT INTO telemetry_rollups');
const isRateWrite = (entry) => entry.sql.startsWith('INSERT INTO telemetry_ingest_rate');

/** `envString` from `cloud/src/telemetry.ts`, restated: trim, then truncate. */
const expectEnv = (value) => String(value).trim().slice(0, ENV_MAX);

// --- Generators ------------------------------------------------------------

const arbInstallId = fc.uuid({ version: 4 });
const arbEnvString = fc.string({ minLength: 0, maxLength: 80, unit: 'grapheme-ascii' });
const arbEnv = fc.record({
  locale: arbEnvString,
  timezone: arbEnvString,
  platform: arbEnvString,
  osVersion: arbEnvString,
  appVersion: arbEnvString,
  runtimeMode: fc.constantFrom('desktop', 'browser'),
});
const arbCounters = fc.dictionary(fc.constantFrom(...CATALOG_NAMES), fc.nat({ max: 1_000_000 }), {
  maxKeys: 6,
});
/** A Metric_Day inside the accepted `[today - 30, today + 1]` window (6.7). */
const arbMetricDay = fc
  .integer({ min: -30, max: 1 })
  .map((offset) => dayOf(T0 + offset * MS_PER_DAY));

try {
  // ── Warm-up: the request that creates the schema ─────────────────────────
  // Also the request that reveals the real TELEMETRY_SCHEMA_STATEMENTS and the
  // real prune statements, straight out of the SQL the module issued.
  console.log('Harness warm-up');
  let schemaStatements = [];
  let rollupPruneSql = '';
  let ratePruneSql = '';
  {
    const warm = await ingest(mf, rollup());
    check('the warm-up ingest is accepted', warm.status === 200 && warm.text === '{}', `${warm.status} ${warm.text}`);

    const observed = await state(mf);
    schemaStatements = observed.binds.filter((b) => b.sql.startsWith('CREATE')).map((b) => b.sql);
    check(
      'the schema was created by the worker, not by a migration (8.4)',
      schemaStatements.length === 4 &&
        schemaStatements.every((s) => s.includes('IF NOT EXISTS')) &&
        schemaStatements.filter((s) => s.startsWith('CREATE TABLE')).length === 2 &&
        schemaStatements.filter((s) => s.startsWith('CREATE INDEX')).length === 2,
      JSON.stringify(schemaStatements),
    );

    await reset(mf);
    await retention(mf);
    const afterRetention = await state(mf);
    rollupPruneSql = afterRetention.binds.find((b) => b.sql.startsWith('DELETE FROM telemetry_rollups'))?.sql ?? '';
    ratePruneSql = afterRetention.binds.find((b) => b.sql.startsWith('DELETE FROM telemetry_ingest_rate'))?.sql ?? '';
    check(
      'the retention pass issues both prune statements',
      rollupPruneSql !== '' && ratePruneSql !== '',
      `${rollupPruneSql} | ${ratePruneSql}`,
    );
  }

  const baselineSchema = (await (await mf.dispatchFetch('http://localhost/__t/schema')).json()).objects;

  // ══ Route resolution examples (6.1, 6.2) ════════════════════════════════
  console.log('\nRoute order and anonymity (6.1, 6.2)');
  {
    await reset(mf, { tables: true });

    // 6.2: no Authorization header, on a HOSTED worker. If `/telemetry` fell
    // into the `/api/*` branch or the agent branch this would be a 401.
    const anonymous = await ingest(mf, rollup({ installId: '11111111-1111-4111-8111-111111111111' }));
    check(
      'POST /telemetry is answered without an Authorization header (6.2)',
      anonymous.status === 200 && anonymous.text === '{}',
      `${anonymous.status} ${anonymous.text}`,
    );

    // Auth is not merely optional, it is not consulted: a garbage bearer is
    // neither rejected nor verified.
    const bogusAuth = await ingest(mf, rollup({ installId: '22222222-2222-4222-8222-222222222222' }), {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    check(
      'a bogus Authorization header changes nothing (6.2)',
      bogusAuth.status === 200 && bogusAuth.text === '{}',
      `${bogusAuth.status} ${bogusAuth.text}`,
    );

    // 6.1: matched BEFORE the generic OPTIONS branch. The generic branch would
    // answer with the ALLOWED_ORIGINS-scoped origin; telemetry answers `*`.
    const telemetryPreflight = await mf.dispatchFetch('http://localhost/telemetry', {
      method: 'OPTIONS',
      headers: { Origin: 'https://studio.example.com' },
    });
    const genericPreflight = await mf.dispatchFetch('http://localhost/api/profile', {
      method: 'OPTIONS',
      headers: { Origin: 'https://studio.example.com' },
    });
    check(
      'OPTIONS /telemetry is answered by the telemetry branch, not the generic one (6.1)',
      telemetryPreflight.headers.get('Access-Control-Allow-Origin') === '*' &&
        genericPreflight.headers.get('Access-Control-Allow-Origin') === 'https://studio.example.com',
      `${telemetryPreflight.headers.get('Access-Control-Allow-Origin')} vs ${genericPreflight.headers.get('Access-Control-Allow-Origin')}`,
    );

    // Matched BEFORE `/api/*`: an unsupported method on the telemetry path is
    // the telemetry 405, carrying the telemetry CORS set, not a gateway 404.
    const wrongMethod = await mf.dispatchFetch('http://localhost/telemetry', { method: 'GET' });
    check(
      'GET /telemetry is the telemetry 405, not a gateway 404 (6.1)',
      wrongMethod.status === 405 &&
        wrongMethod.headers.get('Access-Control-Allow-Methods') === 'POST, OPTIONS' &&
        JSON.stringify(await wrongMethod.json()) === '{"error":"Method not allowed."}',
      String(wrongMethod.status),
    );

    // The handler returns null for anything else, so the chain continues.
    const otherPath = await mf.dispatchFetch('http://localhost/telemetry-not-really', { method: 'POST' });
    check(
      'a neighbouring path falls through to the rest of the worker (6.1)',
      otherPath.status === 404,
      String(otherPath.status),
    );
  }

  // ══ The body size cap, at the exact byte (6.5) ═══════════════════════════
  // `test/telemetry.test.mjs` cannot decide this one: the cap is enforced by a
  // reader over the request stream, so it needs a real request with a real body
  // to sit ON the boundary. Exactly 16384 bytes is accepted and stored; one
  // byte more is 413 and writes nothing.
  console.log('\nThe body size cap, at the exact byte (6.5)');
  {
    await reset(mf, { tables: true });

    /** A valid Rollup padded with a discarded field to exactly `bytes` bytes. */
    const bodyOfExactly = (bytes, installId) => {
      const base = rollup({ installId, pad: '' });
      const overhead = JSON.stringify(base).length;
      const padding = bytes - overhead;
      if (padding < 0) throw new Error(`cannot build a ${bytes} byte body: overhead is ${overhead}`);
      return JSON.stringify({ ...base, pad: 'x'.repeat(padding) });
    };

    const atCapId = 'eeeeeeee-0000-4000-8000-000000000001';
    const overCapId = 'eeeeeeee-0000-4000-8000-000000000002';
    const atCap = bodyOfExactly(MAX_BODY_BYTES, atCapId);
    const overCap = bodyOfExactly(MAX_BODY_BYTES + 1, overCapId);
    check(
      'the two bodies really are 16384 and 16385 bytes',
      Buffer.byteLength(atCap) === MAX_BODY_BYTES && Buffer.byteLength(overCap) === MAX_BODY_BYTES + 1,
      `${Buffer.byteLength(atCap)} / ${Buffer.byteLength(overCap)}`,
    );

    await reset(mf);
    const accepted = await ingest(mf, atCap);
    const acceptedState = await state(mf);
    check(
      'a body of exactly 16384 bytes is accepted (6.5)',
      accepted.status === 200 && accepted.text === '{}',
      `${accepted.status} ${accepted.text}`,
    );
    check(
      'and it wrote its row',
      acceptedState.binds.filter(isRollupWrite).length === 1,
      JSON.stringify(acceptedState.binds.map((b) => b.sql)),
    );

    await reset(mf);
    const refused = await ingest(mf, overCap);
    const refusedState = await state(mf);
    check(
      'a body one byte above the cap is 413 (6.5)',
      refused.status === 413 && refused.text === '{"error":"Payload too large."}',
      `${refused.status} ${refused.text}`,
    );
    check(
      'and nothing was written for it (6.5)',
      refusedState.binds.length === 0,
      JSON.stringify(refusedState.binds.map((b) => b.sql)),
    );
    const rows = (
      await sql(mf, [
        {
          sql: 'SELECT install_id FROM telemetry_rollups WHERE install_id IN (?1, ?2) ORDER BY install_id',
          params: [atCapId, overCapId],
        },
      ])
    )[0];
    check(
      'the store holds the accepted body only',
      rows.length === 1 && rows[0].install_id === atCapId,
      JSON.stringify(rows),
    );
  }

  // ══ Property 17 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 17: The telemetry preflight is independent of ALLOWED_ORIGINS
  //
  // "For any request `Origin` and any value of `ALLOWED_ORIGINS`, the
  // `OPTIONS /telemetry` response is identical, permits the `POST` method and
  // the `Content-Type` header, and never varies with the configured origin
  // list."
  //
  // **Validates: Requirements 6.3**
  //
  // `ALLOWED_ORIGINS` is a deploy-time binding, so it is varied across a pool
  // of workers rather than per iteration: a hosted worker with one origin, a
  // hosted worker with two, a hosted worker with an empty list, and a BYO
  // worker with no list at all. The generated `Origin` is then crossed with
  // every one of them, and one single signature has to answer for all of it.
  console.log('\nProperty 17: the telemetry preflight is independent of ALLOWED_ORIGINS (6.3)');
  {
    const pool = [
      { label: 'hosted, one origin', mf },
      { label: 'hosted, two origins', mf: plainWorker({ PHORMA_MODE: 'hosted', ALLOWED_ORIGINS: 'https://studio.example.com,https://admin.example.com' }) },
      { label: 'hosted, empty list', mf: plainWorker({ PHORMA_MODE: 'hosted', ALLOWED_ORIGINS: '' }) },
      { label: 'BYO, no list', mf: plainWorker({}) },
    ];

    const signatures = new Map();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(null),
            fc.constantFrom('https://studio.example.com', 'https://admin.example.com', 'https://evil.example.com', 'null', ''),
            fc.webUrl(),
          ),
          async (origin) => {
            for (const entry of pool) {
              const response = await entry.mf.dispatchFetch('http://localhost/telemetry', {
                method: 'OPTIONS',
                ...(origin === null ? {} : { headers: { Origin: origin } }),
              });
              const signature = JSON.stringify({
                status: response.status,
                allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
                allowMethods: response.headers.get('Access-Control-Allow-Methods'),
                allowHeaders: response.headers.get('Access-Control-Allow-Headers'),
                maxAge: response.headers.get('Access-Control-Max-Age'),
                vary: response.headers.get('Vary'),
                body: await response.text(),
              });
              signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
              if (signatures.size !== 1) {
                throw new Error(`preflight varied (${entry.label}, origin ${String(origin)}): ${[...signatures.keys()].join(' !== ')}`);
              }
            }
            return true;
          },
        ),
        { numRuns: RUNS },
      );

      const [only] = [...signatures.keys()];
      const parsed = JSON.parse(only);
      check('the preflight answer is identical for every Origin and every ALLOWED_ORIGINS', signatures.size === 1, only);
      check('it never scopes the origin to the configured list', parsed.allowOrigin === '*', parsed.allowOrigin);
      check('it never varies on Origin', parsed.vary === null, String(parsed.vary));
      check('it permits the POST method', /\bPOST\b/.test(parsed.allowMethods ?? ''), parsed.allowMethods);
      check('it permits the Content-Type header', /\bContent-Type\b/.test(parsed.allowHeaders ?? ''), parsed.allowHeaders);
    } finally {
      for (const entry of pool.slice(1)) await entry.mf.dispose();
    }
  }

  // ══ Property 20 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 20: A valid Rollup writes exactly one row and answers an empty object
  //
  // "For any valid Rollup, the Ingest_Endpoint performs exactly one
  // Telemetry_Store row write and answers HTTP 200 with a body that parses to
  // an empty JSON object."
  //
  // **Validates: Requirements 6.4**
  console.log('\nProperty 20: a valid Rollup writes exactly one row and answers {} (6.4)');
  {
    await reset(mf, { tables: true });
    await fc.assert(
      fc.asyncProperty(arbInstallId, arbMetricDay, arbEnv, arbCounters, async (installId, metricDay, env, counters) => {
        // Tables too: shrinking replays one Install_Id many times, and a stale
        // rate window from a previous attempt would answer 429 (6.11) instead of
        // exercising the write path this property is about.
        await reset(mf, { tables: true });
        const body = { installId, metricDay, env, counters, schemaVersion: 1 };
        const answer = await ingest(mf, body);

        if (answer.status !== 200) throw new Error(`status ${answer.status}`);
        const parsed = JSON.parse(answer.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(`body is not an object: ${answer.text}`);
        }
        if (Object.keys(parsed).length !== 0) throw new Error(`body is not empty: ${answer.text}`);

        const observed = await state(mf);
        const writes = observed.binds.filter(isRollupWrite);
        if (writes.length !== 1) throw new Error(`${writes.length} rollup writes`);

        const rows = (
          await sql(mf, [
            {
              sql: 'SELECT install_id, metric_day, counters FROM telemetry_rollups WHERE install_id = ?1 AND metric_day = ?2',
              params: [installId, metricDay],
            },
          ])
        )[0];
        if (rows.length !== 1) throw new Error(`${rows.length} stored rows`);
        if (JSON.parse(rows[0].counters) === null) throw new Error('counters did not round-trip');
        return true;
      }),
      { numRuns: RUNS },
    );
    check('every valid Rollup wrote exactly one row and answered an empty object', true);

    // 6.12: a BYO deployment has no `DB`. It must accept and drop, not error.
    await reset(mfNoDb);
    const dropped = await ingest(mfNoDb, rollup());
    const noDbState = await state(mfNoDb);
    check(
      'an absent DB binding answers 200 {} (6.12)',
      dropped.status === 200 && dropped.text === '{}',
      `${dropped.status} ${dropped.text}`,
    );
    check(
      'and writes nothing, and logs nothing (6.12)',
      noDbState.binds.length === 0 && noDbState.logs.length === 0,
      JSON.stringify(noDbState),
    );
  }

  // ══ Property 21 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 21: A repeat Install_Id and Metric_Day replaces rather than accumulates
  //
  // "For any two valid Rollups sharing an Install_Id and Metric_Day, after both
  // are ingested the Telemetry_Store holds exactly one row for that pair, its
  // counters and Client_Environment equal the later Rollup's values, and its
  // first-seen timestamp equals the earlier ingest time."
  //
  // **Validates: Requirements 6.10, 8.1**
  console.log('\nProperty 21: a repeat install/day replaces rather than accumulates (6.10, 8.1)');
  {
    await reset(mf, { tables: true });
    await fc.assert(
      fc.asyncProperty(
        arbInstallId,
        arbMetricDay,
        arbEnv,
        arbEnv,
        arbCounters,
        arbCounters,
        fc.integer({ min: 1, max: 6 * 3_600_000 }),
        async (installId, metricDay, envA, envB, countersA, countersB, gap) => {
          await reset(mf, { tables: true });
          const first = T0;
          const second = T0 + gap;

          const one = await ingest(mf, { installId, metricDay, env: envA, counters: countersA, schemaVersion: 1 }, { now: first });
          if (one.status !== 200) throw new Error(`first status ${one.status}`);
          const two = await ingest(mf, { installId, metricDay, env: envB, counters: countersB, schemaVersion: 1 }, { now: second });
          if (two.status !== 200) throw new Error(`second status ${two.status}`);

          const rows = (
            await sql(mf, [
              {
                sql: 'SELECT * FROM telemetry_rollups WHERE install_id = ?1 AND metric_day = ?2',
                params: [installId, metricDay],
              },
            ])
          )[0];
          if (rows.length !== 1) throw new Error(`${rows.length} rows for the pair (8.1)`);
          const row = rows[0];

          if (row.counters !== JSON.stringify(countersB)) {
            throw new Error(`counters are not the later Rollup's: ${row.counters}`);
          }
          const storedEnv = {
            locale: row.locale,
            timezone: row.timezone,
            platform: row.platform,
            osVersion: row.os_version,
            appVersion: row.app_version,
            runtimeMode: row.runtime_mode,
          };
          const expected = {
            locale: expectEnv(envB.locale),
            timezone: expectEnv(envB.timezone),
            platform: expectEnv(envB.platform),
            osVersion: expectEnv(envB.osVersion),
            appVersion: expectEnv(envB.appVersion),
            runtimeMode: envB.runtimeMode,
          };
          if (JSON.stringify(storedEnv) !== JSON.stringify(expected)) {
            throw new Error(`environment is not the later Rollup's: ${JSON.stringify(storedEnv)} vs ${JSON.stringify(expected)}`);
          }
          if (Number(row.first_seen_at) !== first) {
            throw new Error(`first_seen_at is ${row.first_seen_at}, expected the earlier ingest time ${first}`);
          }
          if (Number(row.last_seen_at) !== second) {
            throw new Error(`last_seen_at is ${row.last_seen_at}, expected ${second}`);
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
    check('a repeat Install_Id and Metric_Day replaced the row and preserved first_seen_at', true);
  }

  // ══ Property 22 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 22: Per-install ingest rate limiting
  //
  // "For any sequence of request timestamps carrying one Install_Id, every
  // request beyond the twentieth inside a rolling one hour window answers HTTP
  // 429 and writes nothing, and the first request after the window elapses is
  // accepted again."
  //
  // **Validates: Requirements 6.11**
  //
  // The expectation is an independent reference model of the window, written
  // from the requirement rather than from the SQL: a window opens on the first
  // accepted request, restarts once an hour has elapsed since it opened, and a
  // request is refused while the open window already holds 20 accepted ones.
  console.log('\nProperty 22: per-install ingest rate limiting (6.11)');
  {
    await reset(mf, { tables: true });
    await fc.assert(
      fc.asyncProperty(
        arbInstallId,
        fc.array(fc.constantFrom(0, 1_000, 60_000, 1_800_000, RATE_WINDOW_MS - 1, RATE_WINDOW_MS, RATE_WINDOW_MS + 1), {
          minLength: RATE_LIMIT + 1,
          maxLength: RATE_LIMIT + 3,
        }),
        async (installId, gaps) => {
          const metricDay = dayOf(T0);
          let windowStart = null;
          let count = 0;
          let at = T0;
          let accepted = 0;

          await reset(mf);
          for (const gap of gaps) {
            at += gap;
            const elapsed = windowStart !== null && at - windowStart >= RATE_WINDOW_MS;
            const refused = windowStart !== null && !elapsed && count >= RATE_LIMIT;

            const answer = await ingest(
              mf,
              { installId, metricDay, env: rollup().env, counters: { 'session.started': 1 }, schemaVersion: 1 },
              { now: at },
            );

            if (refused) {
              if (answer.status !== 429) throw new Error(`expected 429 at ${at}, got ${answer.status}`);
              if (JSON.parse(answer.text).error !== 'Too many requests.') {
                throw new Error(`unexpected 429 body ${answer.text}`);
              }
            } else {
              if (answer.status !== 200) throw new Error(`expected 200 at ${at}, got ${answer.status} ${answer.text}`);
              accepted += 1;
              if (windowStart === null || elapsed) {
                windowStart = at;
                count = 1;
              } else {
                count += 1;
              }
            }
          }

          // A refused request writes NOTHING: neither the rollup row nor the
          // rate window moves, so the write count equals the accepted count.
          const observed = await state(mf);
          const rollupWrites = observed.binds.filter(isRollupWrite).length;
          const rateWrites = observed.binds.filter(isRateWrite).length;
          if (rollupWrites !== accepted || rateWrites !== accepted) {
            throw new Error(`${rollupWrites}/${rateWrites} writes for ${accepted} accepted requests`);
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
    check('every request beyond the twentieth in the window was refused and wrote nothing', true);

    // The second half of the property, stated as an explicit walk so the
    // boundary is legible: 20 accepted, the 21st refused, and the first request
    // after the hour elapses accepted again.
    await reset(mf, { tables: true });
    const walkId = '99999999-9999-4999-8999-999999999999';
    const walkBody = { installId: walkId, metricDay: dayOf(T0), env: rollup().env, counters: {}, schemaVersion: 1 };
    const statuses = [];
    for (let i = 0; i < RATE_LIMIT; i += 1) statuses.push((await ingest(mf, walkBody, { now: T0 + i })).status);
    const twentyFirst = await ingest(mf, walkBody, { now: T0 + RATE_LIMIT });
    const afterWindow = await ingest(mf, walkBody, { now: T0 + RATE_WINDOW_MS });
    check(
      'the first 20 requests in the window are accepted',
      statuses.every((s) => s === 200),
      JSON.stringify(statuses),
    );
    check('the 21st is refused with 429', twentyFirst.status === 429, `${twentyFirst.status} ${twentyFirst.text}`);
    check(
      'the first request after the window elapses is accepted again',
      afterWindow.status === 200 && afterWindow.text === '{}',
      `${afterWindow.status} ${afterWindow.text}`,
    );
  }

  // ══ Property 23 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 23: The ingest path leaks nothing
  //
  // "For any request body containing arbitrary marker strings, and any values
  // placed in the `CF-Connecting-IP` header, the `X-Forwarded-For` header, and
  // the city, postal code, latitude, longitude and autonomous system number
  // request properties, no response body contains a marker or an exception
  // message, no value bound into a Telemetry_Store write contains a marker, and
  // no emitted log line contains a marker."
  //
  // **Validates: Requirements 6.13, 7.4, 7.5, 7.7, 12.5, 12.6**
  //
  // Two marker classes, because they make different claims. HIDDEN markers sit
  // where nothing may ever reach: unrecognized body fields, unknown counter
  // names, the two address headers, and the five request properties the store
  // has no column for. They must appear in no response, no bound value, no
  // stored row and no log line. The STORED marker sits in a legitimate
  // Client_Environment field, which is written on purpose; it exists only to
  // prove the response never echoes request content back (6.13).
  console.log('\nProperty 23: the ingest path leaks nothing (6.13, 7.4, 7.5, 7.7, 12.5, 12.6)');
  {
    await reset(mf, { tables: true });
    await fc.assert(
      fc.asyncProperty(
        arbInstallId,
        // The ASN is a NUMBER on a Cloudflare request, so it gets its own
        // generator and an exact-value check. Every other marker is letters and
        // hyphens only, which keeps a substring scan free of false positives
        // against timestamps and counter values.
        fc.integer({ min: 100_000_000, max: 999_999_999 }),
        fc.string({ minLength: 6, maxLength: 10, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz') }),
        async (installId, asn, tag) => {
          // A fixed second install id, so the faulted request is always
          // distinguishable from the accepted one even when shrinking collapses
          // the generated value.
          const throwInstallId = 'dddddddd-0000-4000-8000-000000000001';
          const marker = (slot) => `LEAK-${slot}-${tag}`;
          const hidden = {
            body: marker('body'),
            counter: marker('counter'),
            ip: marker('ip'),
            xff: marker('xff'),
            city: marker('city'),
            postal: marker('postal'),
            latitude: marker('lat'),
            longitude: marker('lon'),
          };
          const stored = marker('env');
          const thrown = marker('throw');

          const hiddenValues = Object.values(hidden);
          const cf = {
            country: 'DE',
            city: hidden.city,
            postalCode: hidden.postal,
            latitude: hidden.latitude,
            longitude: hidden.longitude,
            asn,
            asOrganization: hidden.body,
          };
          const headers = { 'CF-Connecting-IP': hidden.ip, 'X-Forwarded-For': hidden.xff };
          const body = {
            installId,
            metricDay: dayOf(T0),
            env: { ...rollup().env, locale: stored, ip: hidden.body, city: hidden.body },
            counters: { 'session.started': 2, [hidden.counter]: 7 },
            schemaVersion: 1,
            // Unrecognized fields, discarded by construction (7.6).
            clientIp: hidden.body,
            note: { nested: [hidden.body] },
          };

          await reset(mf, { tables: true });

          // 1. The accepted path.
          const accepted = await ingest(mf, body, { headers, cf });
          if (accepted.status !== 200 || accepted.text !== '{}') {
            throw new Error(`accepted path answered ${accepted.status} ${accepted.text}`);
          }

          // 2. A parse failure, with a marker in the unparseable body (6.6).
          const broken = await ingest(mf, `{"broken":${JSON.stringify(hidden.body)}`, { headers, cf });
          if (broken.status !== 400 || broken.text !== '{"error":"Invalid telemetry payload."}') {
            throw new Error(`parse failure answered ${broken.status} ${broken.text}`);
          }

          // 3. An oversized body, entirely made of markers (6.5).
          const huge = `{"pad":"${hidden.body.repeat(Math.ceil(MAX_BODY_BYTES / hidden.body.length) + 1)}"}`;
          const oversized = await ingest(mf, huge, { headers, cf });
          if (oversized.status !== 413 || oversized.text !== '{"error":"Payload too large."}') {
            throw new Error(`oversized answered ${oversized.status} ${oversized.text}`);
          }

          // 4. An internal throw whose message is itself a marker. The handler
          //    catches everything and answers 200 {}, so the message has to die
          //    inside - not in the body, and not in the log line.
          await injectFailure(mf, { sql: 'INSERT INTO telemetry_rollups', message: thrown });
          // try/finally, because an `ingest` that REJECTS (a loopback connect
          // failure, say) would otherwise leave the injection armed and turn one
          // transient error into a run of meaningless failures. The `reset` route
          // clears it too; both, so the intent is visible where it matters.
          let faulted;
          try {
            faulted = await ingest(mf, { ...body, installId: throwInstallId }, { headers, cf });
          } finally {
            await injectFailure(mf, { sql: null });
          }
          if (faulted.status !== 200 || faulted.text !== '{}') {
            throw new Error(`the faulted path answered ${faulted.status} ${faulted.text}`);
          }

          // Nothing hidden may be in ANY response body, and no response may
          // carry the exception message or request content (6.13).
          const bodies = [accepted.text, broken.text, oversized.text, faulted.text].join('\n');
          for (const value of [...hiddenValues, stored, thrown, String(asn)]) {
            if (bodies.includes(value)) throw new Error(`a response body leaked ${value}`);
          }

          const observed = await state(mf);

          // No BOUND value, and no SQL, may carry a hidden marker (7.4, 7.5, 12.6).
          const bound = JSON.stringify(observed.binds);
          for (const value of hiddenValues) {
            if (bound.includes(value)) throw new Error(`a bound write value leaked ${value}`);
          }
          for (const entry of observed.binds) {
            if (entry.values.some((value) => String(value) === String(asn))) {
              throw new Error(`a bound write value leaked the autonomous system number ${asn}`);
            }
          }

          // No emitted log line may carry a marker or the exception message (7.7).
          const logged = observed.logs.join('\n');
          for (const value of [...hiddenValues, stored, thrown, String(asn)]) {
            if (logged.includes(value)) throw new Error(`a log line leaked ${value}`);
          }
          if (observed.logs.some((line) => line !== 'telemetry ingest failed')) {
            throw new Error(`unexpected log output: ${JSON.stringify(observed.logs)}`);
          }

          // The stored row holds the environment marker (it is a legitimate
          // field) and nothing hidden.
          const rows = (
            await sql(mf, [
              { sql: 'SELECT * FROM telemetry_rollups WHERE install_id = ?1', params: [installId] },
            ])
          )[0];
          if (rows.length !== 1) throw new Error(`${rows.length} stored rows`);
          const rowText = JSON.stringify(rows[0]);
          for (const value of hiddenValues) {
            if (rowText.includes(value)) throw new Error(`the stored row leaked ${value}`);
          }
          if (Object.values(rows[0]).some((value) => String(value) === String(asn))) {
            throw new Error(`the stored row leaked the autonomous system number ${asn}`);
          }
          if (!rowText.includes(stored)) throw new Error('the environment field was not stored at all');
          // Only the coarse geography survives from the request metadata (7.4).
          if (rows[0].country_code !== 'DE' || rows[0].region !== 'europe') {
            throw new Error(`coarse geo is ${rows[0].country_code}/${rows[0].region}`);
          }
          // The unknown counter name was dropped, the known one kept (6.8).
          if (rows[0].counters !== '{"session.started":2}') {
            throw new Error(`counters are ${rows[0].counters}`);
          }
          // A faulted write leaves no row behind.
          const faultedRows = (
            await sql(mf, [
              { sql: 'SELECT * FROM telemetry_rollups WHERE install_id = ?1', params: [throwInstallId] },
            ])
          )[0];
          if (faultedRows.length !== 0) throw new Error('the faulted write left a row');
          return true;
        },
      ),
      { numRuns: RUNS },
    );
    check('no marker, and no exception message, reached a response, a bound value, a row or a log line', true);
  }

  // ══ Property 25 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 25: Schema creation is idempotent
  //
  // "For any number of repeated applications of the Telemetry_Store schema
  // statements, the resulting schema snapshot equals the snapshot after one
  // application and no application throws."
  //
  // **Validates: Requirements 8.4**
  //
  // The statements applied here are the real `TELEMETRY_SCHEMA_STATEMENTS`,
  // captured from the SQL `ensureTelemetrySchema` issued during the warm-up
  // rather than copied into this file, so the two cannot drift.
  console.log('\nProperty 25: schema creation is idempotent (8.4)');
  {
    const snapshot = JSON.stringify(baselineSchema);
    // A row to notice if re-application quietly recreated a table.
    await sql(mf, [
      {
        sql: 'INSERT OR REPLACE INTO telemetry_rollups (install_id, metric_day, schema_version, first_seen_at, last_seen_at) VALUES (?1, ?2, 1, ?3, ?3)',
        params: ['cccccccc-0000-4000-8000-000000000001', dayOf(T0), T0],
      },
    ]);
    check(
      'the baseline snapshot holds both tables and both indexes',
      baselineSchema.filter((o) => o.type === 'table').length === 2 &&
        baselineSchema.filter((o) => o.type === 'index' && o.name.startsWith('idx_telemetry')).length === 2,
      snapshot,
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (times) => {
        const applied = await testRoute(mf, 'schema-apply', { statements: schemaStatements, times });
        if (applied.ok !== true) throw new Error(`application ${times}x threw: ${applied.error}`);
        const after = (await (await mf.dispatchFetch('http://localhost/__t/schema')).json()).objects;
        if (JSON.stringify(after) !== snapshot) {
          throw new Error(`the schema changed after ${times} applications: ${JSON.stringify(after)}`);
        }
        return true;
      }),
      { numRuns: RUNS },
    );
    check('repeated application left the schema snapshot unchanged and never threw', true);

    // The rows the schema holds must survive re-application too - an
    // `IF NOT EXISTS` that was silently a DROP would still pass a snapshot
    // comparison.
    const survivors = await rollupRows(mf);
    check('re-application did not disturb the stored rows', survivors.length > 0, String(survivors.length));
  }

  // ══ Property 26 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 26: Retention deletes exactly the expired rows
  //
  // "For any set of Telemetry_Store rows with Metric_Days spanning ages either
  // side of the 400 day Retention_Window, the retention pass leaves exactly the
  // rows within the window; and for a failure injected at any delete step,
  // every row remains and a subsequent Ingest_Endpoint request still answers
  // HTTP 200 and writes its row."
  //
  // **Validates: Requirements 8.5, 8.7**
  console.log('\nProperty 26: retention deletes exactly the expired rows (8.5, 8.7)');
  {
    const oldestKeptDay = dayOf(T0 - RETENTION_DAYS * MS_PER_DAY);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: RETENTION_DAYS - 5, max: RETENTION_DAYS + 5 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 0, max: 48 }), { minLength: 1, maxLength: 4 }),
        fc.uuid({ version: 4 }),
        async (ages, rateHours, freshInstallId) => {
          // Always span both sides of the boundary, whatever was generated.
          const allAges = [...new Set([...ages, RETENTION_DAYS - 1, RETENTION_DAYS, RETENTION_DAYS + 1])];
          const rows = allAges.map((age, index) => ({
            installId: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
            metricDay: dayOf(T0 - age * MS_PER_DAY),
            age,
          }));
          const rateWindows = [...new Set(rateHours)].map((hours, index) => ({
            installId: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`,
            windowStart: T0 - hours * 3_600_000,
            hours,
          }));

          const seed = () => [
            { sql: 'DELETE FROM telemetry_rollups' },
            { sql: 'DELETE FROM telemetry_ingest_rate' },
            ...rows.map((row) => ({
              sql: 'INSERT INTO telemetry_rollups (install_id, metric_day, schema_version, first_seen_at, last_seen_at) VALUES (?1, ?2, 1, ?3, ?3)',
              params: [row.installId, row.metricDay, T0],
            })),
            ...rateWindows.map((entry) => ({
              sql: 'INSERT INTO telemetry_ingest_rate (install_id, window_start_ms, request_count) VALUES (?1, ?2, 1)',
              params: [entry.installId, entry.windowStart],
            })),
          ];

          // ── The pass deletes exactly the expired rows (8.5) ──────────────
          await reset(mf);
          await sql(mf, seed());
          await mf.dispatchFetch('http://localhost/__t/retention', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-now-ms': String(T0) },
            body: '{}',
          });

          const kept = (await rollupRows(mf)).map((row) => row.metric_day).sort();
          const expected = rows.filter((row) => row.metricDay >= oldestKeptDay).map((row) => row.metricDay).sort();
          if (JSON.stringify(kept) !== JSON.stringify(expected)) {
            throw new Error(`kept ${JSON.stringify(kept)}, expected ${JSON.stringify(expected)}`);
          }
          if (kept.length === rows.length || kept.length === 0) {
            throw new Error('the generated set did not span the window boundary');
          }
          const keptRate = (await rateRows(mf)).map((row) => Number(row.window_start_ms)).sort();
          const expectedRate = rateWindows
            .filter((entry) => entry.windowStart >= T0 - 24 * 3_600_000)
            .map((entry) => entry.windowStart)
            .sort();
          if (JSON.stringify(keptRate) !== JSON.stringify(expectedRate)) {
            throw new Error(`kept rate windows ${JSON.stringify(keptRate)}, expected ${JSON.stringify(expectedRate)}`);
          }

          // ── A failure at either delete step leaves every row (8.7) ───────
          for (const targetSql of [rollupPruneSql, ratePruneSql]) {
            await reset(mf);
            await sql(mf, seed());
            await injectFailure(mf, { sql: targetSql, message: 'injected retention failure' });
            let pass;
            try {
              pass = await mf.dispatchFetch('http://localhost/__t/retention', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-test-now-ms': String(T0) },
                body: '{}',
              });
            } finally {
              // Same hazard as Property 23's faulted path: a rejected dispatch
              // must not leave the injection armed for the next iteration.
              await injectFailure(mf, { sql: null });
            }

            const passBody = await pass.json();
            if (passBody.rejected !== 0) throw new Error('the failure escaped scheduled()');

            const observed = await state(mf);
            if (!observed.binds.some((entry) => entry.sql === targetSql)) {
              throw new Error(`the delete step for ${targetSql} was never attempted`);
            }

            const survivingRollups = (await rollupRows(mf)).map((row) => row.metric_day).sort();
            const survivingRate = (await rateRows(mf)).length;
            if (survivingRollups.length !== rows.length || survivingRate !== rateWindows.length) {
              throw new Error(
                `a failed pass deleted rows: ${survivingRollups.length}/${rows.length} rollups, ${survivingRate}/${rateWindows.length} rate windows`,
              );
            }

            // And the Ingest_Endpoint still answers normally afterwards.
            const after = await ingest(
              mf,
              { installId: freshInstallId, metricDay: dayOf(T0), env: rollup().env, counters: { 'run.started': 1 }, schemaVersion: 1 },
              { now: T0 },
            );
            if (after.status !== 200 || after.text !== '{}') {
              throw new Error(`ingest after a failed pass answered ${after.status} ${after.text}`);
            }
            const written = (
              await sql(mf, [
                { sql: 'SELECT counters FROM telemetry_rollups WHERE install_id = ?1', params: [freshInstallId] },
              ])
            )[0];
            if (written.length !== 1 || written[0].counters !== '{"run.started":1}') {
              throw new Error(`ingest after a failed pass wrote ${JSON.stringify(written)}`);
            }
            await sql(mf, [
              { sql: 'DELETE FROM telemetry_rollups WHERE install_id = ?1', params: [freshInstallId] },
            ]);
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
    check('the pass deleted exactly the expired rows, and a failed pass deleted nothing', true);
  }
} finally {
  await mf.dispose();
  await mfNoDb.dispose();
}

if (loopbackRetries() > 0) {
  console.log(`\n(${loopbackRetries()} loopback connect retries - see test/miniflare-loopback.mjs)`);
}
console.log(failures === 0 ? '\nAll telemetry-ingest checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
