/**
 * `/api/admin/telemetry/*` - the owner-only Admin_API, end to end against a
 * real D1 database and the real authorization chain.
 *
 * These three properties are the ones that cannot be decided from pure
 * functions. `test/telemetry.test.mjs` already covers the authorization
 * algebra, the date-range grammar and the k-anonymity fold as pure logic; what
 * is left is what the ROUTES do: whether the five aggregates actually conserve
 * the rows underneath them, whether any response body can leak an identity, and
 * whether every answer is uncacheable.
 *
 * Harness. The worker is the exact bundle `wrangler deploy` would ship, run
 * under Miniflare with a real (in-memory) SQLite-backed D1 binding - no
 * network, no Cloudflare account. It is the same harness `telemetry-ingest.test.mjs`
 * uses, extended with one thing that suite did not need: a real, verifiable
 * bearer token.
 *
 * Authorization is NOT stubbed. `verifyRequest` runs for real, `@clerk/backend`
 * verifies for real, and the allowlist check runs for real. The only thing the
 * test controls is the KEY: an RSA keypair is generated here, the public half is
 * handed to the worker as `CLERK_JWT_KEY`, and each iteration signs its own
 * RS256 session JWT with the private half. Clerk's offline verification path
 * (`jwtKey` present) then verifies it inside the isolate without a JWKS fetch.
 * That is what makes the authorized 200, and the 400/404/405/500 answers behind
 * it, reachable at all - `aggregateTelemetry` is exercised through the route
 * that serves it rather than beside it, so the response shape, the CORS
 * envelope and the `Cache-Control` header are part of every assertion.
 *
 * Three worker shapes carry the authorization outcomes, because the allowlist
 * and the deployment mode are deploy-time bindings:
 *
 *  - `mfA` hosted, allowlist `user_owner_a`
 *  - `mfB` hosted, allowlist ` user_owner_b , user_extra_b ` (padded, multiple)
 *  - `mfOpen` an open BYO worker (no mode, no secrets), which `verifyRequest`
 *    resolves to a NULL user id for any token - the 403-without-Clerk shape
 *
 * The harness proxies and observes; it never replaces a decision. Every status
 * code, every SQL statement and every bound value below is produced by
 * `cloud/src/telemetry-admin.ts` running in workerd.
 *
 * Covers:
 *  - Property 29 (9.7, 9.8, 9.9, 9.10, 9.11)
 *  - Property 31 (9.6, 9.14)
 *  - Property 32 (9.16)
 *  - route-resolution examples (9.1)
 *
 * Run: node cloud/test/telemetry-admin.test.mjs
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { createSign, generateKeyPairSync } from 'node:crypto';
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

// --- Bounds and shapes restated from the requirements, not imported --------
// A test that imports the constant it is checking proves only self-consistency.

/** The five aggregate routes (9.7 to 9.11). */
const ROUTES = ['summary', 'geography', 'environment', 'features', 'trend'];

/** The path prefix the Admin_API owns (9.1). */
const PREFIX = '/api/admin/telemetry/';

/** Requirement 9.15: a group below 5 distinct installs is reported as `other`. */
const K_FLOOR = 5;
const OTHER = 'other';

/** Requirement 9.7: the three trailing active-install windows, in days. */
const ACTIVE_WINDOWS = { d1: 1, d7: 7, d30: 30 };

/** Requirement 9.12: the default range is the trailing 30 days, inclusive. */
const DEFAULT_RANGE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** A fixed virtual instant every request drives the worker clock to. */
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);
/** `metricDayUtc(T0)`, restated. The default range ends here. */
const TODAY = '2026-06-15';

/** Day 0 of the generated row space. Rows and ranges are offsets from here. */
const ORIGIN = Date.UTC(2026, 4, 1);

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayAt = (offset) => dayOf(ORIGIN + offset * MS_PER_DAY);
const shiftDay = (day, days) => dayOf(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY);

/** Real Counter_Catalog names (`cloud/src/telemetry-catalog.ts`), one per family. */
const CATALOG_NAMES = [
  'session.started',
  'run.started',
  'run.completed',
  'run.error',
  'node.created:agent',
  'panel.opened:runs',
  'assistant.invoked:plan',
  'error:network',
];

/**
 * A counter name that is NOT in the Counter_Catalog, as an older Worker could
 * have written. The features route filters it out before the fold, so it must
 * reach neither its own label nor `other` (9.10).
 */
const STALE_COUNTER = 'legacy.counter:gone';

/** The insert the suite seeds rows with. Deliberately not the ingest upsert. */
const SEED_SQL = `INSERT OR REPLACE INTO telemetry_rollups (
  install_id, metric_day, country_code, region, locale, timezone, platform,
  os_version, app_version, runtime_mode, counters, schema_version,
  first_seen_at, last_seen_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

// --- The session token -----------------------------------------------------
// A real RS256 JWT, verified for real by @clerk/backend inside the isolate.
// `loadClerkJwkFromPem` reads the modulus straight out of a 2048-bit SPKI PEM,
// so the key has to be exactly that shape - which is what Node generates here.

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A session JWT for `sub`, valid around the virtual instant `nowMs`. */
function mintToken(sub, nowMs = T0) {
  const seconds = Math.floor(nowMs / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-admin-test' })}.${base64url({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

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
/** Failure injection: reject any statement whose SQL starts with this. */
let failSql = null;
let failMessage = 'injected failure';

const realNow = Date.now.bind(Date);
Date.now = () => (virtualNow === null ? realNow() : virtualNow);

function record(sql, values) {
  binds.push({ sql: sql, values: (values || []).map((v) => (v === undefined ? null : v)) });
}

function injected(sql) {
  return failSql !== null && String(sql).startsWith(failSql);
}

function wrapStatement(inner, sql, values) {
  const guard = (call) => {
    record(sql, values);
    if (injected(sql)) return Promise.reject(new Error(failMessage));
    return call();
  };
  return {
    __sql: sql,
    __values: values,
    __inner: inner,
    bind(...args) { return wrapStatement(inner.bind(...args), sql, args); },
    first(column) { return guard(() => (column === undefined ? inner.first() : inner.first(column))); },
    run() { return guard(() => inner.run()); },
    all() { return guard(() => inner.all()); },
    raw(options) { return guard(() => inner.raw(options)); },
  };
}

function wrapDb(db) {
  return {
    prepare(sql) { return wrapStatement(db.prepare(sql), sql, []); },
    batch(statements) {
      for (const statement of statements) record(statement.__sql, statement.__values);
      if (statements.some((s) => injected(s.__sql))) {
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
    if (body.tables === true && db) {
      await runStatements(db, [{ sql: 'DELETE FROM telemetry_rollups' }]);
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

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-telemetry-admin-'));
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
 * `withLoopbackRetry` covers the loopback transport only - see
 * `test/miniflare-loopback.mjs`. Nothing about the worker's behaviour changes.
 */
function harnessWorker(bindings, databaseName) {
  const worker = new Miniflare({
    modulesRoot: cloudRoot,
    modules: [
      { type: 'ESModule', path: join(cloudRoot, 'harness.mjs'), contents: HARNESS },
      { type: 'ESModule', path: join(cloudRoot, 'worker.mjs'), contents: script },
    ],
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: DURABLE_OBJECTS,
    d1Databases: { DB: databaseName },
    bindings,
  });
  return withLoopbackRetry(worker);
}

/** The owner of `mfA`, and the subject of the token every 200 below carries. */
const OWNER_A = 'user_owner_a';
/** `mfB`'s allowlist has padding and two entries; this one is the second. */
const OWNER_B = 'user_owner_b';
const EXTRA_B = 'user_extra_b';
/** `mfOpen`'s allowlist is populated, but no caller there ever has a user id. */
const OWNER_OPEN = 'user_owner_open';

/** A verified caller who is simply not on any list. */
const STRANGER = 'user_stranger_9';

const mfA = harnessWorker(
  {
    PHORMA_MODE: 'hosted',
    ALLOWED_ORIGINS: 'https://admin.example.com',
    CLERK_SECRET_KEY: 'sk_test_admin_suite',
    CLERK_JWT_KEY,
    TELEMETRY_ADMIN_USER_IDS: OWNER_A,
  },
  'phorma-telemetry-admin-a',
);

const mfB = harnessWorker(
  {
    PHORMA_MODE: 'hosted',
    ALLOWED_ORIGINS: 'https://admin.example.com',
    CLERK_SECRET_KEY: 'sk_test_admin_suite',
    CLERK_JWT_KEY,
    TELEMETRY_ADMIN_USER_IDS: `  ${OWNER_B} , ${EXTRA_B}  `,
  },
  'phorma-telemetry-admin-b',
);

/**
 * An open BYO worker: no `PHORMA_MODE`, no `CLERK_SECRET_KEY`, no
 * `PHORMA_TOKEN`. `verifyRequest` hands back an anonymous context, so every
 * token here verifies to a NULL user id and every route answers 403 (9.4).
 */
const mfOpen = harnessWorker({ TELEMETRY_ADMIN_USER_IDS: OWNER_OPEN }, 'phorma-telemetry-admin-open');

/** Same allowlist as `mfA`, but with the beta k-anonymity override on (9.15). */
const mfNoFold = harnessWorker(
  {
    PHORMA_MODE: 'hosted',
    ALLOWED_ORIGINS: 'https://admin.example.com',
    CLERK_SECRET_KEY: 'sk_test_admin_suite',
    CLERK_JWT_KEY,
    TELEMETRY_ADMIN_USER_IDS: OWNER_A,
    TELEMETRY_K_ANONYMITY_DISABLED: 'true',
  },
  'phorma-telemetry-admin-nofold',
);

const WORKERS = [
  { label: 'hosted, single-entry allowlist', mf: mfA, owner: OWNER_A, allowlist: [OWNER_A] },
  { label: 'hosted, padded two-entry allowlist', mf: mfB, owner: OWNER_B, allowlist: [OWNER_B, EXTRA_B] },
  { label: 'open BYO, null user id', mf: mfOpen, owner: null, allowlist: [OWNER_OPEN] },
];

// --- Request helpers -------------------------------------------------------

/**
 * One Admin_API request. `token` is a full bearer value, `null` for no
 * `Authorization` header at all. The clock is always driven, so the default
 * range and the token's own expiry agree.
 */
async function admin(worker, path, { token, method = 'GET', query, now = T0 } = {}) {
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const response = await worker.dispatchFetch(`http://localhost${path}${search}`, {
    method,
    headers: {
      'x-test-now-ms': String(now),
      ...(token === null || token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    status: response.status,
    cacheControl: response.headers.get('Cache-Control'),
    allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
    contentType: response.headers.get('Content-Type'),
    text,
    json: parsed,
  };
}

const aggregate = (worker, route, options) => admin(worker, `${PREFIX}${route}`, options);

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

/** Seeds the Telemetry_Store with exactly `rows`, replacing whatever was there. */
async function seed(worker, rows) {
  await reset(worker, { tables: true });
  if (rows.length === 0) return;
  await sql(
    worker,
    rows.map((row) => ({
      sql: SEED_SQL,
      params: [
        row.install_id,
        row.metric_day,
        row.country_code,
        row.region,
        row.locale,
        row.timezone,
        row.platform,
        row.os_version,
        row.app_version,
        row.runtime_mode,
        JSON.stringify(row.counters),
        1,
        T0,
        T0,
      ],
    })),
  );
}

// --- The reference aggregation ---------------------------------------------
// A second implementation, written from the requirements rather than from the
// SQL: a plain reduce over the same rows the store was seeded with. It shares no
// code with `cloud/src/telemetry-admin.ts` - no import, no derived constant, no
// borrowed query - which is the whole point. If it were a copy of the query it
// would prove nothing.

/** Rows whose Metric_Day falls inside the inclusive range. */
function within(rows, from, to) {
  return rows.filter((row) => row.metric_day >= from && row.metric_day <= to);
}

function distinctInstalls(rows) {
  return new Set(rows.map((row) => row.install_id)).size;
}

/** Sum of one Counter across rows. A row without the counter contributes 0. */
function counterTotal(rows, name) {
  let total = 0;
  for (const row of rows) {
    const value = row.counters[name];
    if (typeof value === 'number') total += value;
  }
  return total;
}

/** Rows grouped by one column, preserving nothing about order. */
function groupBy(rows, column) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[column]);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }
  return groups;
}

/**
 * The k-anonymity fold (9.15), restated. Rows with fewer than 5 distinct
 * installs collapse into one `other` row that sums every metric; when nothing is
 * below the floor there is no `other` row at all.
 *
 * The generators never emit the literal label `other`, so the "a surviving row
 * already labelled other joins the fold" edge is out of scope here - it belongs
 * to Property 30, which decides the fold as pure logic.
 */
function foldGroups(rows, metrics) {
  const kept = rows.filter((row) => row.installs >= K_FLOOR);
  const folded = rows.filter((row) => row.installs < K_FLOOR);
  if (folded.length === 0) return kept;

  const other = { label: OTHER, installs: 0 };
  for (const metric of metrics) other[metric] = 0;
  for (const row of folded) {
    other.installs += row.installs;
    for (const metric of metrics) other[metric] += row[metric];
  }
  return [...kept, other];
}

/** Trailing window of `days` ending on `range.to`, inclusive, clamped to `from`. */
function trailingWindow(range, days) {
  const start = shiftDay(range.to, -(days - 1));
  return { from: start > range.from ? start : range.from, to: range.to };
}

function referenceSummary(rows, range) {
  const scoped = within(rows, range.from, range.to);
  const active = (days) => {
    const window = trailingWindow(range, days);
    return distinctInstalls(within(rows, window.from, window.to));
  };
  return {
    range,
    activeInstalls: {
      d1: active(ACTIVE_WINDOWS.d1),
      d7: active(ACTIVE_WINDOWS.d7),
      d30: active(ACTIVE_WINDOWS.d30),
    },
    totals: {
      installs: distinctInstalls(scoped),
      sessions: counterTotal(scoped, 'session.started'),
      runs: counterTotal(scoped, 'run.started'),
      runsCompleted: counterTotal(scoped, 'run.completed'),
      runErrors: counterTotal(scoped, 'run.error'),
    },
  };
}

/** `{ label, installs, runs }` by one column, folded (9.8). */
function referenceInstallsAndRuns(rows, column) {
  const groups = [...groupBy(rows, column)].map(([label, bucket]) => ({
    label,
    installs: distinctInstalls(bucket),
    runs: counterTotal(bucket, 'run.started'),
  }));
  return foldGroups(groups, ['runs']);
}

/** `{ label, installs }` by one column, folded (9.9). */
function referenceInstalls(rows, column) {
  const groups = [...groupBy(rows, column)].map(([label, bucket]) => ({
    label,
    installs: distinctInstalls(bucket),
  }));
  return foldGroups(groups, []);
}

function referenceGeography(rows, range) {
  const scoped = within(rows, range.from, range.to);
  return {
    range,
    countries: referenceInstallsAndRuns(scoped, 'country_code'),
    regions: referenceInstallsAndRuns(scoped, 'region'),
  };
}

function referenceEnvironment(rows, range) {
  const scoped = within(rows, range.from, range.to);
  return {
    range,
    appVersion: referenceInstalls(scoped, 'app_version'),
    platform: referenceInstalls(scoped, 'platform'),
    runtimeMode: referenceInstalls(scoped, 'runtime_mode'),
    locale: referenceInstalls(scoped, 'locale'),
  };
}

/**
 * Summed Counter values by name (9.10). The catalog filter runs BEFORE the fold,
 * so a stale counter name reaches neither its own label nor `other`.
 */
function referenceFeatures(rows, range) {
  const scoped = within(rows, range.from, range.to);
  const perName = new Map();
  for (const row of scoped) {
    for (const [name, value] of Object.entries(row.counters)) {
      if (!CATALOG_NAMES.includes(name)) continue; // the catalog filter
      const bucket = perName.get(name) ?? { total: 0, installs: new Set() };
      bucket.total += value;
      bucket.installs.add(row.install_id);
      perName.set(name, bucket);
    }
  }
  const groups = [...perName].map(([label, bucket]) => ({
    label,
    total: bucket.total,
    installs: bucket.installs.size,
  }));
  return { range, counters: foldGroups(groups, ['total']) };
}

/** The per-Metric_Day series plus the number of days the floor folded (9.11). */
function referenceTrend(rows, range) {
  const scoped = within(rows, range.from, range.to);
  const groups = [...groupBy(scoped, 'metric_day')].map(([label, bucket]) => ({
    label,
    installs: distinctInstalls(bucket),
    sessions: counterTotal(bucket, 'session.started'),
    runs: counterTotal(bucket, 'run.started'),
  }));
  return {
    range,
    days: foldGroups(groups, ['sessions', 'runs']),
    foldedDays: groups.filter((row) => row.installs < K_FLOOR).length,
  };
}

function referenceAggregate(route, rows, range) {
  switch (route) {
    case 'summary':
      return referenceSummary(rows, range);
    case 'geography':
      return referenceGeography(rows, range);
    case 'environment':
      return referenceEnvironment(rows, range);
    case 'features':
      return referenceFeatures(rows, range);
    case 'trend':
      return referenceTrend(rows, range);
    default:
      throw new Error(`unknown route ${route}`);
  }
}

// --- Comparison ------------------------------------------------------------

/** The declared key set of each route's body (9.7 to 9.11). */
const BODY_KEYS = {
  summary: ['activeInstalls', 'range', 'totals'],
  geography: ['countries', 'range', 'regions'],
  environment: ['appVersion', 'locale', 'platform', 'range', 'runtimeMode'],
  features: ['counters', 'range'],
  trend: ['days', 'foldedDays', 'range'],
};

/** The declared key set of each route's group rows. */
const ROW_KEYS = {
  geography: { countries: ['installs', 'label', 'runs'], regions: ['installs', 'label', 'runs'] },
  environment: {
    appVersion: ['installs', 'label'],
    locale: ['installs', 'label'],
    platform: ['installs', 'label'],
    runtimeMode: ['installs', 'label'],
  },
  features: { counters: ['installs', 'label', 'total'] },
  trend: { days: ['installs', 'label', 'runs', 'sessions'] },
};

const keysOf = (value) => Object.keys(value).sort();

/**
 * A canonical string for a body: object keys sorted, and any array of labelled
 * rows sorted by label, so the comparison is about content rather than about the
 * order `GROUP BY` happened to hand back.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(canonical);
    const labelled = value.every((entry) => entry && typeof entry.label === 'string');
    return labelled ? [...mapped].sort(compareCanonical) : mapped;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function compareCanonical(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Asserts the body's key set and every group row's key set, or throws. */
function assertShape(route, body) {
  const expected = BODY_KEYS[route];
  const actual = keysOf(body);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${route} body keys ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
  if (JSON.stringify(keysOf(body.range)) !== JSON.stringify(['from', 'to'])) {
    throw new Error(`${route} range keys ${JSON.stringify(keysOf(body.range))}`);
  }
  if (route === 'summary') {
    const windows = keysOf(body.activeInstalls);
    const totals = keysOf(body.totals);
    if (JSON.stringify(windows) !== JSON.stringify(['d1', 'd30', 'd7'])) {
      throw new Error(`summary activeInstalls keys ${JSON.stringify(windows)}`);
    }
    const expectedTotals = ['installs', 'runErrors', 'runs', 'runsCompleted', 'sessions'];
    if (JSON.stringify(totals) !== JSON.stringify(expectedTotals)) {
      throw new Error(`summary totals keys ${JSON.stringify(totals)}`);
    }
    return;
  }
  for (const [field, rowKeys] of Object.entries(ROW_KEYS[route])) {
    const rows = body[field];
    if (!Array.isArray(rows)) throw new Error(`${route}.${field} is not an array`);
    for (const row of rows) {
      if (JSON.stringify(keysOf(row)) !== JSON.stringify(rowKeys)) {
        throw new Error(`${route}.${field} row keys ${JSON.stringify(keysOf(row))}`);
      }
    }
    const labels = rows.map((row) => row.label);
    if (new Set(labels).size !== labels.length) {
      throw new Error(`${route}.${field} repeated a label: ${JSON.stringify(labels)}`);
    }
  }
}

// --- Generators ------------------------------------------------------------

/** A fixed pool of Install_Ids, small enough that groups cross the k floor. */
const INSTALL_IDS = Array.from(
  { length: 12 },
  (_, index) => `a17e57ed-1000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

const arbCounters = fc.dictionary(
  fc.constantFrom(...CATALOG_NAMES, STALE_COUNTER),
  fc.nat({ max: 40 }),
  { maxKeys: 5 },
);

/**
 * One row seed. Group domains are deliberately SMALL so generated groups land on
 * both sides of the k-anonymity floor, and the day offset reaches outside every
 * generated range so "rows outside the range contribute nothing" has something
 * to bite on.
 */
const arbRowSeed = fc.record({
  install: fc.nat({ max: INSTALL_IDS.length - 1 }),
  day: fc.integer({ min: -3, max: 34 }),
  country_code: fc.constantFrom('US', 'DE', 'FR', 'XX'),
  region: fc.constantFrom('americas', 'europe', 'unknown'),
  locale: fc.constantFrom('en-US', 'de-DE', ''),
  platform: fc.constantFrom('windows', 'macos', 'linux'),
  app_version: fc.constantFrom('0.2.0-beta.9', '0.2.0-beta.10'),
  runtime_mode: fc.constantFrom('desktop', 'browser'),
  counters: arbCounters,
});

/**
 * Materializes seeds into rows, deduplicated on `(install_id, metric_day)` -
 * the Telemetry_Store's primary key - keeping the last seed for a pair, which is
 * what `INSERT OR REPLACE` does. The reference model then reduces over exactly
 * the rows the store holds.
 */
function materialize(seeds, installIds = INSTALL_IDS) {
  const byKey = new Map();
  for (const seed of seeds) {
    const row = {
      install_id: installIds[seed.install % installIds.length],
      metric_day: dayAt(seed.day),
      country_code: seed.country_code,
      region: seed.region,
      locale: seed.locale,
      timezone: 'Europe/London',
      platform: seed.platform,
      os_version: '10.0.26100',
      app_version: seed.app_version,
      runtime_mode: seed.runtime_mode,
      counters: seed.counters,
    };
    byKey.set(`${row.install_id}|${row.metric_day}`, row);
  }
  return [...byKey.values()];
}

const arbRowSeeds = fc.array(arbRowSeed, { maxLength: 24 });

/** A valid range inside the generated day space. */
const arbRange = fc
  .tuple(fc.integer({ min: 0, max: 31 }), fc.integer({ min: 0, max: 31 }))
  .map(([a, b]) => ({ from: dayAt(Math.min(a, b)), to: dayAt(Math.max(a, b)) }));

// --- Tokens ---------------------------------------------------------------

const TOKENS = {
  ownerA: mintToken(OWNER_A),
  ownerB: mintToken(OWNER_B),
  extraB: mintToken(EXTRA_B),
  ownerOpen: mintToken(OWNER_OPEN),
  stranger: mintToken(STRANGER),
};

/** A syntactically valid bearer that verification rejects. */
const GARBAGE_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2Zha2UifQ.not-a-signature';

/** The four authorization outcomes, per worker. `null` means no header at all. */
function tokenFor(worker, outcome) {
  switch (outcome) {
    case 'owner':
      return worker.owner === null ? TOKENS.ownerOpen : mintToken(worker.owner);
    case 'stranger':
      return TOKENS.stranger;
    case 'garbage':
      return GARBAGE_TOKEN;
    case 'none':
      return null;
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/** Warms a worker's D1 by driving one real ingest, which creates the schema. */
async function warmSchema(worker) {
  const response = await worker.dispatchFetch('http://localhost/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-now-ms': String(T0) },
    body: JSON.stringify({
      installId: 'ffffffff-0000-4000-8000-000000000000',
      metricDay: TODAY,
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
    }),
  });
  const text = await response.text();
  if (response.status !== 200 || text !== '{}') {
    throw new Error(`schema warm-up failed: ${response.status} ${text}`);
  }
  await reset(worker, { tables: true });
}

try {
  // ── Warm-up ─────────────────────────────────────────────────────────────
  console.log('Harness warm-up');
  for (const worker of WORKERS) {
    await warmSchema(worker.mf);
  }
  {
    const [rows] = await sql(mfA, [{ sql: 'SELECT COUNT(*) AS n FROM telemetry_rollups' }]);
    check('the Telemetry_Store exists and is empty', rows[0].n === 0, JSON.stringify(rows));
  }
  {
    const authorized = await aggregate(mfA, 'summary', { token: TOKENS.ownerA });
    check(
      'a locally minted session token is verified for real and authorizes the owner',
      authorized.status === 200,
      `${authorized.status} ${authorized.text}`,
    );
    const rejected = await aggregate(mfA, 'summary', { token: TOKENS.stranger });
    check(
      'a verified caller off the allowlist is 403, so the allowlist is really consulted',
      rejected.status === 403 && rejected.text === '{"error":"Forbidden."}',
      `${rejected.status} ${rejected.text}`,
    );
    const open = await aggregate(mfOpen, 'summary', { token: TOKENS.ownerOpen });
    check(
      'an open BYO worker resolves any token to a null user id and answers 403 (9.4)',
      open.status === 403 && open.text === '{"error":"Forbidden."}',
      `${open.status} ${open.text}`,
    );
  }

  // ══ Route resolution examples (9.1) ══════════════════════════════════════
  console.log('\nRoute resolution (9.1)');
  {
    await seed(mfA, []);

    // Inside the `/api/*` control-plane branch: the answer carries the scoped
    // `/api` CORS envelope, not the open `*` the anonymous telemetry branch uses.
    const inside = await aggregate(mfA, 'summary', { token: TOKENS.ownerA });
    check(
      'an aggregate is served inside the /api branch, with its scoped CORS (9.1)',
      inside.status === 200 &&
        inside.allowOrigin === 'https://admin.example.com' &&
        inside.contentType === 'application/json',
      `${inside.status} ${inside.allowOrigin} ${inside.contentType}`,
    );

    // All five route names resolve; neighbouring spellings do not.
    const resolved = [];
    for (const route of ROUTES) {
      const answer = await aggregate(mfA, route, { token: TOKENS.ownerA });
      resolved.push(`${route}:${answer.status}`);
    }
    check(
      'every one of the five route names resolves (9.7 to 9.11)',
      resolved.every((entry) => entry.endsWith(':200')),
      resolved.join(' '),
    );

    const misses = [];
    for (const tail of ['', 'Summary', 'summary2', 'sum', 'summary/extra', 'geo']) {
      const answer = await admin(mfA, `${PREFIX}${tail}`, { token: TOKENS.ownerA });
      misses.push(`${JSON.stringify(tail)}:${answer.status}:${answer.text}`);
    }
    check(
      'an unknown tail is 404 with a static body, for an authorized caller (9.1)',
      misses.every((entry) => entry.includes(':404:{"error":"Not found."}')),
      misses.join(' '),
    );

    // The gate runs BEFORE route dispatch, so an unauthorized caller cannot use
    // the status code to learn which routes exist.
    const unknownUnauthorized = await admin(mfA, `${PREFIX}nope`, { token: null });
    const knownUnauthorized = await aggregate(mfA, 'summary', { token: null });
    check(
      'an unauthorized caller gets the same 401 for a known and an unknown route',
      unknownUnauthorized.status === 401 &&
        knownUnauthorized.status === 401 &&
        unknownUnauthorized.text === knownUnauthorized.text,
      `${unknownUnauthorized.status} ${unknownUnauthorized.text} vs ${knownUnauthorized.status} ${knownUnauthorized.text}`,
    );

    // The prefix is exact: the path WITHOUT the trailing slash is not this
    // module's, so it must not answer with this module's headers.
    const neighbour = await admin(mfA, '/api/admin/telemetry', { token: TOKENS.ownerA });
    check(
      'the path without the trailing slash is not an Admin_API answer (9.1)',
      neighbour.status !== 200 && neighbour.cacheControl !== 'no-store',
      `${neighbour.status} ${neighbour.cacheControl}`,
    );

    // And the same tail outside `/api/` reaches nothing at all.
    const outside = await admin(mfA, '/admin/telemetry/summary', { token: TOKENS.ownerA });
    check(
      'the same tail outside /api/ is not served (9.1)',
      outside.status === 404 && outside.cacheControl !== 'no-store',
      `${outside.status} ${outside.cacheControl}`,
    );

    // Both allowlist entries of the padded two-entry secret authorize, which is
    // what makes `mfB` a distinct shape rather than a copy of `mfA`.
    const first = await aggregate(mfB, 'summary', { token: TOKENS.ownerB });
    const second = await aggregate(mfB, 'summary', { token: TOKENS.extraB });
    check(
      'both entries of a padded, comma-separated allowlist authorize',
      first.status === 200 && second.status === 200,
      `${first.status} ${second.status}`,
    );
  }

  // ══ Property 29 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 29: Aggregates conserve the underlying rows
  //
  // "For any set of Telemetry_Store rows and any valid date range, each of the
  // five Admin_API routes returns the same aggregate as a naive reference
  // aggregation over the rows in that range, its response key set equals the
  // declared shape for that route, and rows outside the range contribute
  // nothing."
  //
  // **Validates: Requirements 9.7, 9.8, 9.9, 9.10, 9.11**
  //
  // The rows are seeded straight into D1 with the suite's own insert, then read
  // back through the five real routes with an authorized token. The comparison
  // is against `referenceAggregate`, the second implementation above: a reduce
  // over the same rows that shares no code with the SQL.
  //
  // Rows land on days OUTSIDE every generated range, so a query that forgot its
  // `BETWEEN` - or a trailing active-install window that reached back past
  // `range.from` - shows up as a mismatch rather than as an untested case.
  console.log('\nProperty 29: aggregates conserve the underlying rows (9.7 to 9.11)');
  {
    await fc.assert(
      fc.asyncProperty(arbRowSeeds, arbRange, async (seeds, range) => {
        const rows = materialize(seeds);
        await seed(mfA, rows);

        for (const route of ROUTES) {
          const answer = await aggregate(mfA, route, {
            token: TOKENS.ownerA,
            query: { from: range.from, to: range.to },
          });
          if (answer.status !== 200) {
            throw new Error(`${route} answered ${answer.status} ${answer.text}`);
          }
          assertShape(route, answer.json);
          const expected = referenceAggregate(route, rows, range);
          if (!same(answer.json, expected)) {
            throw new Error(
              `${route} over ${rows.length} rows in ${range.from}..${range.to}\n` +
                `  actual   ${JSON.stringify(canonical(answer.json))}\n` +
                `  expected ${JSON.stringify(canonical(expected))}`,
            );
          }
        }
        return true;
      }),
      { numRuns: RUNS },
    );
    check('every route matched the reference aggregation, on the declared shape', true);
  }

  // ── Rows outside the range contribute nothing, stated directly ────────────
  // The property above compares against a model that filters by range, which
  // already decides this. This example decides it a second way, without the
  // model: the same five bodies must come back whether or not the out-of-range
  // rows are in the store at all.
  console.log('\nRows outside the range contribute nothing (9.7 to 9.11)');
  {
    const range = { from: dayAt(10), to: dayAt(20) };
    const inside = materialize(
      Array.from({ length: 12 }, (_, index) => ({
        install: index,
        day: 10 + (index % 11),
        country_code: index % 2 === 0 ? 'US' : 'DE',
        region: 'americas',
        locale: 'en-US',
        platform: 'windows',
        app_version: '0.2.0-beta.10',
        runtime_mode: 'desktop',
        counters: { 'session.started': 2, 'run.started': 3, 'run.completed': 1 },
      })),
    );
    const outside = materialize(
      [-3, -1, 9, 21, 30, 34].map((day, index) => ({
        install: index,
        day,
        country_code: 'FR',
        region: 'europe',
        locale: 'de-DE',
        platform: 'linux',
        app_version: '0.2.0-beta.9',
        runtime_mode: 'browser',
        counters: { 'session.started': 500, 'run.started': 700, 'run.error': 900 },
      })),
    );

    await seed(mfA, [...inside, ...outside]);
    const withOutside = [];
    for (const route of ROUTES) {
      withOutside.push(
        (await aggregate(mfA, route, { token: TOKENS.ownerA, query: range })).text,
      );
    }

    await seed(mfA, inside);
    const withoutOutside = [];
    for (const route of ROUTES) {
      withoutOutside.push(
        (await aggregate(mfA, route, { token: TOKENS.ownerA, query: range })).text,
      );
    }

    check(
      'deleting every out-of-range row changes no aggregate body',
      JSON.stringify(withOutside) === JSON.stringify(withoutOutside),
      `${JSON.stringify(withOutside)}\n  vs ${JSON.stringify(withoutOutside)}`,
    );
    check(
      'and the in-range aggregate is not vacuously empty',
      JSON.parse(withoutOutside[0]).totals.runs === 36,
      withoutOutside[0],
    );
  }

  // ── The features catalog filter and the trend series (9.10, 9.11) ─────────
  console.log('\nThe catalog filter and the trend series (9.10, 9.11)');
  {
    const range = { from: dayAt(0), to: dayAt(9) };
    const rows = materialize(
      Array.from({ length: 12 }, (_, index) => ({
        install: index,
        day: index % 2, // day 0 has 6 installs, day 1 has 6: both above the floor
        country_code: 'US',
        region: 'americas',
        locale: 'en-US',
        platform: 'windows',
        app_version: '0.2.0-beta.10',
        runtime_mode: 'desktop',
        counters: { 'session.started': 1, 'run.started': 2, [STALE_COUNTER]: 999 },
      })),
    );
    await seed(mfA, rows);

    const features = await aggregate(mfA, 'features', { token: TOKENS.ownerA, query: range });
    const labels = features.json.counters.map((row) => row.label).sort();
    check(
      'the features route reports every Counter_Catalog name present in range (9.10)',
      JSON.stringify(labels) === JSON.stringify(['run.started', 'session.started']),
      features.text,
    );
    check(
      'a counter name outside the Counter_Catalog reaches no label and no total (9.10)',
      !features.text.includes(STALE_COUNTER) && !features.text.includes('999'),
      features.text,
    );
    check(
      'and it matches the reference aggregation',
      same(features.json, referenceFeatures(rows, range)),
      features.text,
    );

    const trend = await aggregate(mfA, 'trend', { token: TOKENS.ownerA, query: range });
    const days = trend.json.days.filter((row) => row.label !== OTHER).map((row) => row.label);
    check(
      'the trend route returns one row per Metric_Day, in ascending order (9.11)',
      JSON.stringify(days) === JSON.stringify([...days].sort()) &&
        JSON.stringify(days) === JSON.stringify([dayAt(0), dayAt(1)]),
      trend.text,
    );
    check(
      'foldedDays is zero when no day is below the reporting floor (9.11)',
      trend.json.foldedDays === 0,
      trend.text,
    );

    // One extra day carrying a single install: it folds, and `foldedDays` counts
    // it. `sessions` and `runs` survive the fold, so the series still adds up.
    await seed(mfA, [
      ...rows,
      ...materialize([
        {
          install: 0,
          day: 5,
          country_code: 'US',
          region: 'americas',
          locale: 'en-US',
          platform: 'windows',
          app_version: '0.2.0-beta.10',
          runtime_mode: 'desktop',
          counters: { 'session.started': 7, 'run.started': 11 },
        },
      ]),
    ]);
    const folded = await aggregate(mfA, 'trend', { token: TOKENS.ownerA, query: range });
    const otherRow = folded.json.days.find((row) => row.label === OTHER);
    check(
      'a day below the floor folds into `other` and is counted in foldedDays (9.11, 9.15)',
      folded.json.foldedDays === 1 &&
        otherRow !== undefined &&
        otherRow.installs === 1 &&
        otherRow.sessions === 7 &&
        otherRow.runs === 11 &&
        !folded.json.days.some((row) => row.label === dayAt(5)),
      folded.text,
    );

    // The exact scenario above, replayed on a worker with the beta override on:
    // the single-install day keeps its OWN label instead of joining `other`,
    // and foldedDays reads zero.
    await warmSchema(mfNoFold);
    await seed(mfNoFold, [
      ...rows,
      ...materialize([
        {
          install: 0,
          day: 5,
          country_code: 'US',
          region: 'americas',
          locale: 'en-US',
          platform: 'windows',
          app_version: '0.2.0-beta.10',
          runtime_mode: 'desktop',
          counters: { 'session.started': 7, 'run.started': 11 },
        },
      ]),
    ]);
    const unfolded = await aggregate(mfNoFold, 'trend', { token: TOKENS.ownerA, query: range });
    const ownDay = unfolded.json.days.find((row) => row.label === dayAt(5));
    check(
      'TELEMETRY_K_ANONYMITY_DISABLED reports the single-install day under its own label, not `other`',
      unfolded.json.foldedDays === 0 &&
        ownDay !== undefined &&
        ownDay.installs === 1 &&
        ownDay.sessions === 7 &&
        ownDay.runs === 11 &&
        !unfolded.json.days.some((row) => row.label === OTHER),
      unfolded.text,
    );

    // Geography folds by country across the WHOLE range, not by day, so the
    // trend fixture above (all `US`, well above the floor) proves nothing
    // about it - a fresh, isolated single-install country is seeded instead.
    await seed(
      mfNoFold,
      materialize([
        {
          install: 0,
          day: 0,
          country_code: 'DE',
          region: 'europe',
          locale: 'de-DE',
          platform: 'linux',
          app_version: '0.2.0-beta.10',
          runtime_mode: 'desktop',
          counters: {},
        },
      ]),
    );
    const geo = await aggregate(mfNoFold, 'geography', { token: TOKENS.ownerA, query: range });
    check(
      'and the same override reports a single-install country on its own label in geography',
      geo.json.countries.some((row) => row.label === 'DE' && row.installs === 1) &&
        !geo.json.countries.some((row) => row.label === OTHER),
      geo.text,
    );
  }

  // ── The default range (9.12) ─────────────────────────────────────────────
  console.log('\nThe default range (9.12)');
  {
    const rows = materialize(
      Array.from({ length: 10 }, (_, index) => ({
        install: index,
        day: index * 4 - 3, // spans 2026-04-28 to 2026-06-02
        country_code: 'US',
        region: 'americas',
        locale: 'en-US',
        platform: 'macos',
        app_version: '0.2.0-beta.10',
        runtime_mode: 'browser',
        counters: { 'session.started': 3, 'run.started': 5 },
      })),
    );
    await seed(mfA, rows);

    const answer = await aggregate(mfA, 'summary', { token: TOKENS.ownerA });
    const expectedRange = { from: shiftDay(TODAY, -(DEFAULT_RANGE_DAYS - 1)), to: TODAY };
    check(
      'an absent from/to defaults to the trailing 30 days ending today (9.12)',
      same(answer.json.range, expectedRange),
      `${answer.text} expected ${JSON.stringify(expectedRange)}`,
    );
    check(
      'and the aggregate over the default range matches the reference',
      same(answer.json, referenceSummary(rows, expectedRange)),
      answer.text,
    );
  }

  // ══ Property 31 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 31: Admin responses expose no identity
  //
  // "For any set of Telemetry_Store rows carrying marker Install_Ids and any
  // populated Owner_Allowlist, no Admin_API response body contains an
  // Install_Id or an allowlist entry, on any route, for any authorization
  // outcome."
  //
  // **Validates: Requirements 9.6, 9.14**
  //
  // The allowlist is a deploy-time secret, so it is varied across the three
  // worker shapes rather than per iteration; the marker Install_Ids, the rows,
  // the route and the authorization outcome all vary per iteration. Every
  // generated Install_Id is a marker: it is the only uuid-shaped string that
  // exists anywhere in the system, so the assertion can be blunt - no uuid at
  // all, and no `user_` id at all, in any body.
  console.log('\nProperty 31: admin responses expose no identity (9.6, 9.14)');
  {
    const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const ALL_ALLOWLIST_ENTRIES = [OWNER_A, OWNER_B, EXTRA_B, OWNER_OPEN, STRANGER];

    /** Throws when a body carries an identity of any kind. */
    function assertNoIdentity(context, body, markers) {
      for (const marker of markers) {
        if (body.includes(marker)) throw new Error(`${context}: leaked Install_Id ${marker}`);
      }
      if (UUID_SHAPE.test(body)) throw new Error(`${context}: leaked a uuid: ${body}`);
      for (const entry of ALL_ALLOWLIST_ENTRIES) {
        if (body.includes(entry)) throw new Error(`${context}: leaked allowlist entry ${entry}`);
      }
      // Not one Clerk id shape, so a future field cannot leak an id we did not
      // happen to enumerate above.
      if (body.includes('user_')) throw new Error(`${context}: leaked a user id: ${body}`);
    }

    const seen = new Set();
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: WORKERS.length - 1 }),
        fc.constantFrom(...ROUTES, '', 'unknown', 'Summary'),
        fc.constantFrom('owner', 'stranger', 'garbage', 'none'),
        fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 3 }),
        arbRowSeeds,
        fc.option(arbRange, { nil: undefined }),
        async (workerIndex, tail, outcome, markers, seeds, range) => {
          const worker = WORKERS[workerIndex];
          const rows = materialize(seeds, markers);
          await seed(worker.mf, rows);

          const answer = await admin(worker.mf, `${PREFIX}${tail}`, {
            token: tokenFor(worker, outcome),
            query: range,
          });
          seen.add(`${worker.label}|${outcome}|${answer.status}`);

          if (![200, 401, 403, 404].includes(answer.status)) {
            throw new Error(`unexpected status ${answer.status}: ${answer.text}`);
          }
          assertNoIdentity(`${worker.label} ${tail || '<empty>'} ${outcome}`, answer.text, markers);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
    check('no generated body carried an Install_Id, a uuid, or an allowlist entry', true);
    check(
      'the generated outcomes covered 200, 401, 403 and 404',
      [200, 401, 403, 404].every((status) => [...seen].some((entry) => entry.endsWith(`|${status}`))),
      [...seen].sort().join(' '),
    );

    // The full cross product, once, so "on any route, for any authorization
    // outcome" is decided exhaustively rather than only sampled.
    const markers = ['c0ffee00-0000-4000-8000-000000000001', 'c0ffee00-0000-4000-8000-000000000002'];
    const sweepRows = materialize(
      Array.from({ length: 8 }, (_, index) => ({
        install: index,
        day: index % 4,
        country_code: 'US',
        region: 'americas',
        locale: 'en-US',
        platform: 'windows',
        app_version: '0.2.0-beta.10',
        runtime_mode: 'desktop',
        counters: { 'session.started': 1, 'run.started': 2 },
      })),
      markers,
    );

    const sweepFailures = [];
    let sweepBodies = 0;
    for (const worker of WORKERS) {
      await seed(worker.mf, sweepRows);
      for (const tail of [...ROUTES, '', 'unknown']) {
        for (const outcome of ['owner', 'stranger', 'garbage', 'none']) {
          const answer = await admin(worker.mf, `${PREFIX}${tail}`, {
            token: tokenFor(worker, outcome),
          });
          sweepBodies += 1;
          try {
            assertNoIdentity(`${worker.label} ${tail || '<empty>'} ${outcome}`, answer.text, markers);
          } catch (error) {
            sweepFailures.push(String(error));
          }
        }
      }
    }
    check(
      `no body in the ${sweepBodies}-answer cross product carried an identity (9.6, 9.14)`,
      sweepFailures.length === 0,
      sweepFailures.join(' | '),
    );

    // The store really does hold the markers, so the sweep above was not clean
    // by virtue of an empty table.
    const [stored] = await sql(mfA, [
      { sql: 'SELECT COUNT(DISTINCT install_id) AS n FROM telemetry_rollups' },
    ]);
    check(
      'and the store held the marker rows while it was swept',
      stored[0].n === markers.length,
      JSON.stringify(stored),
    );

    // No route returns the allowlist (9.6): the secret is set, an authorized
    // caller reads every route, and the value appears in nothing.
    const bodies = [];
    for (const route of ROUTES) {
      bodies.push((await aggregate(mfA, route, { token: TOKENS.ownerA })).text);
    }
    check(
      'no aggregate body names the Owner_Allowlist secret (9.6)',
      bodies.every((body) => !body.includes(OWNER_A) && !body.includes('TELEMETRY_ADMIN')),
      bodies.join(' '),
    );
  }

  // ══ Property 32 ═════════════════════════════════════════════════════════
  // Feature: telemetry-phone-home, Property 32: Every admin response is uncacheable
  //
  // "For any Admin_API route and any authorization outcome, including 400, 401
  // and 403 answers, the response carries `Cache-Control: no-store`."
  //
  // **Validates: Requirements 9.16**
  //
  // A flat cross product of routes, methods, tokens and ranges would spend
  // almost every iteration on a 401 or a 403, because those two swallow any
  // method and any tail. So the generator is built the other way round: it picks
  // one of the six ANSWER CLASSES first, then generates an input that produces
  // it, leaving every dimension the class does not constrain free. Each class
  // gets its share of the run budget, and the property carries the header claim
  // and the expected status together.
  //
  // The free dimensions are the interesting part of each class. 401 and 403 leave
  // the tail, the method and the range free, which says the authorization gate
  // really does run before any dispatch; 404 leaves the range free, which says
  // the route check runs before the range parse.
  //
  // `OPTIONS` is deliberately absent. The Worker answers a preflight from its
  // own CORS branch above the `/api/*` chain, so an `OPTIONS` request never
  // reaches the Admin_API and carries no aggregate to cache.
  console.log('\nProperty 32: every admin response is uncacheable (9.16)');
  const statusesSeen = new Set();
  {
    const QUERIES = {
      absent: undefined,
      valid: { from: dayAt(0), to: dayAt(10) },
      malformed: { from: 'not-a-day', to: dayAt(10) },
      reversed: { from: dayAt(10), to: dayAt(0) },
      overlong: { from: '2024-01-01', to: TODAY },
    };

    const HOSTED = { label: 'hosted', mf: mfA, owner: OWNER_A };
    const OPEN = { label: 'open BYO', mf: mfOpen, owner: null };

    const anyTail = fc.constantFrom(...ROUTES, '', 'unknown', 'summary/extra');
    const anyMethod = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'HEAD');
    const anyQuery = fc.constantFrom('absent', 'valid', 'malformed', 'reversed', 'overlong');
    const unknownTail = fc.constantFrom('', 'unknown', 'summary/extra');

    const arbCase = fc.oneof(
      // Authorized, real route, acceptable range.
      fc.record({
        expected: fc.constant(200),
        worker: fc.constant(HOSTED),
        tail: fc.constantFrom(...ROUTES),
        method: fc.constant('GET'),
        outcome: fc.constant('owner'),
        query: fc.constantFrom('absent', 'valid'),
      }),
      // Authorized, real route, a range the grammar rejects (9.12, 9.13).
      fc.record({
        expected: fc.constant(400),
        worker: fc.constant(HOSTED),
        tail: fc.constantFrom(...ROUTES),
        method: fc.constant('GET'),
        outcome: fc.constant('owner'),
        query: fc.constantFrom('malformed', 'reversed', 'overlong'),
      }),
      // No credential, or one verification rejects (9.3). Tail, method and range
      // are free: the gate answers before any of them is looked at.
      fc.record({
        expected: fc.constant(401),
        worker: fc.constantFrom(HOSTED, OPEN),
        tail: anyTail,
        method: anyMethod,
        outcome: fc.constant('none'),
        query: anyQuery,
      }),
      fc.record({
        expected: fc.constant(401),
        worker: fc.constant(HOSTED),
        tail: anyTail,
        method: anyMethod,
        outcome: fc.constant('garbage'),
        query: anyQuery,
      }),
      // Verified, but off the allowlist or carrying a null user id (9.4).
      fc.oneof(
        fc.record({
          expected: fc.constant(403),
          worker: fc.constant(HOSTED),
          tail: anyTail,
          method: anyMethod,
          outcome: fc.constant('stranger'),
          query: anyQuery,
        }),
        fc.record({
          expected: fc.constant(403),
          worker: fc.constant(OPEN),
          tail: anyTail,
          method: anyMethod,
          outcome: fc.constantFrom('owner', 'stranger', 'garbage'),
          query: anyQuery,
        }),
      ),
      // Authorized, but no such route. The range is free: the route check comes
      // first, so a broken range on an unknown route is still a 404.
      fc.record({
        expected: fc.constant(404),
        worker: fc.constant(HOSTED),
        tail: unknownTail,
        method: fc.constant('GET'),
        outcome: fc.constant('owner'),
        query: anyQuery,
      }),
      // Authorized, but not a GET. Any tail: the method check comes first.
      fc.record({
        expected: fc.constant(405),
        worker: fc.constant(HOSTED),
        tail: anyTail,
        method: fc.constantFrom('POST', 'PUT', 'DELETE', 'HEAD'),
        outcome: fc.constant('owner'),
        query: anyQuery,
      }),
    );

    await fc.assert(
      fc.asyncProperty(arbCase, async ({ expected, worker, tail, method, outcome, query }) => {
        const answer = await admin(worker.mf, `${PREFIX}${tail}`, {
          token: tokenFor(worker, outcome),
          method,
          query: QUERIES[query],
        });
        statusesSeen.add(answer.status);

        const where = `${worker.label} ${method} ${tail || '<empty>'} ${outcome} ${query}`;
        if (answer.cacheControl !== 'no-store') {
          throw new Error(
            `${where} -> ${answer.status} Cache-Control ${String(answer.cacheControl)}`,
          );
        }
        if (answer.status !== expected) {
          throw new Error(`${where} -> ${answer.status}, expected ${expected}: ${answer.text}`);
        }
        return true;
      }),
      { numRuns: RUNS },
    );
    check('every generated answer carried Cache-Control: no-store, with its expected status', true);
    check(
      'and the generated answers spanned 200, 400, 401, 403, 404 and 405',
      [200, 400, 401, 403, 404, 405].every((status) => statusesSeen.has(status)),
      [...statusesSeen].sort().join(' '),
    );
  }

  // ── The 500 answer (9.16, plus the static-body rule) ─────────────────────
  // A store failure is the one status the generator above cannot produce. The
  // target statement is not hardcoded: each route is called once, the SQL it
  // actually issued is read back out of the proxy, and THAT statement is the one
  // made to fail. So the injection follows the implementation rather than a
  // guess about it.
  console.log('\nA store failure is a static, uncacheable 500 (9.16)');
  {
    const MARKER = 'D1_EXCEPTION_MARKER_c0ffee';
    const outcomes = [];
    for (const route of ROUTES) {
      await reset(mfA);
      const healthy = await aggregate(mfA, route, { token: TOKENS.ownerA });
      if (healthy.status !== 200) {
        outcomes.push(`${route} was not healthy first: ${healthy.status}`);
        continue;
      }
      const observed = await state(mfA);
      const target = observed.binds.find((entry) => entry.sql.startsWith('SELECT'));
      if (target === undefined) {
        outcomes.push(`${route} issued no SELECT`);
        continue;
      }

      await reset(mfA);
      await injectFailure(mfA, { sql: target.sql, message: MARKER });
      const broken = await aggregate(mfA, route, { token: TOKENS.ownerA });
      const brokenState = await state(mfA);
      await injectFailure(mfA, { sql: null });

      if (broken.status !== 500) outcomes.push(`${route} answered ${broken.status}`);
      if (broken.cacheControl !== 'no-store') {
        outcomes.push(`${route} 500 Cache-Control ${String(broken.cacheControl)}`);
      }
      if (broken.text !== '{"error":"Telemetry aggregate unavailable."}') {
        outcomes.push(`${route} 500 body ${broken.text}`);
      }
      if (broken.text.includes(MARKER)) outcomes.push(`${route} leaked the exception message`);
      if (broken.text.includes('SELECT')) outcomes.push(`${route} leaked the query`);
      if (brokenState.logs.some((line) => line.includes(MARKER))) {
        outcomes.push(`${route} logged the exception message`);
      }
      if (!brokenState.logs.includes('telemetry admin aggregate failed')) {
        outcomes.push(`${route} logged ${JSON.stringify(brokenState.logs)}`);
      }
      statusesSeen.add(broken.status);

      const recovered = await aggregate(mfA, route, { token: TOKENS.ownerA });
      if (recovered.status !== 200) outcomes.push(`${route} did not recover: ${recovered.status}`);
    }
    check(
      'every route answers a static, uncacheable 500 on a store failure, then recovers',
      outcomes.length === 0,
      outcomes.join(' | '),
    );
    check(
      'the six documented statuses were all observed carrying no-store (9.16)',
      [400, 401, 403, 404, 405, 500].every((status) => statusesSeen.has(status)),
      [...statusesSeen].sort().join(' '),
    );
  }
} finally {
  await mfA.dispose();
  await mfB.dispose();
  await mfOpen.dispose();
  await mfNoFold.dispose();
}

if (loopbackRetries() > 0) {
  console.log(`\n(${loopbackRetries()} loopback connect retries - see test/miniflare-loopback.mjs)`);
}
console.log(
  failures === 0 ? '\nAll telemetry-admin checks passed.\n' : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
