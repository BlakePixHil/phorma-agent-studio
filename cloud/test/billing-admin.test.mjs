/**
 * `/api/admin/billing/*` - the operator cost and revenue reads.
 *
 * What is genuinely at stake here is ARITHMETIC OVER MONEY plus a gate, and both
 * fail silently when they are wrong:
 *
 *  - An unknown balance must be `null`, never `0`. Those two render as
 *    "OpenRouter is unreachable" and "we are out of money" respectively, and a
 *    vendor blip must not read as an emergency. Every nullable field here exists
 *    for that reason and the properties below pin it.
 *  - `netUsd = gross - tax` is the margin basis (requirement 49), and Stripe
 *    carries the tax in TWO shapes. Reading only the scalar `tax` reports zero tax
 *    on an account answering `total_taxes[]`, which inflates the net and makes the
 *    margin look better than it is - the exact failure that makes a measured
 *    margin worse than an asserted one.
 *  - Non-USD must be excluded and COUNTED, not summed. Adding a euro to a dollar
 *    is a wrong number that looks like a right one.
 *  - The gate is now SHARED with `/api/admin/telemetry/*` (`admin-auth.ts`). The
 *    refactor that extracted it is only safe if both prefixes still answer
 *    identically for every identity, so that is asserted as a cross-prefix
 *    property rather than assumed.
 *  - A vendor failure degrades ONE half. An OpenRouter outage must still answer
 *    200 with the committed ceilings intact, because those are what an operator
 *    opens this page for during exactly that outage.
 *
 * Harness. `handleApiRequest` is called DIRECTLY over a REAL local D1 (Miniflare's
 * SQLite binding reached from Node with the real migrations applied) - the
 * `billing-routes.test.mjs` shape, so no `dispatchFetch` and the SQL under test is
 * the SQL that ships.
 *
 * Authorization is NOT stubbed. An RSA keypair is generated here, the public half
 * is handed to the worker as `CLERK_JWT_KEY`, and each case signs its own RS256
 * session JWT, so `@clerk/backend` verifies for real on its offline path.
 *
 * The two things replaced are the VENDORS: `globalThis.fetch` serves OpenRouter
 * and Stripe from per-case fixtures, and every call is captured so an assertion
 * can be about a request this worker chose to make.
 *
 * Run: npx tsx cloud/test/billing-admin.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected before
// the module graph loads - which is why `api.ts` arrives via a dynamic import.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { handleApiRequest } = await import('../src/api.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

let failures = 0;
const realConsole = console;
function check(name, condition, detail) {
  // The reporter holds the REAL console, captured before any stub swaps it -
  // otherwise every PASS and, worse, every FAIL detail is swallowed into the
  // capture array and the suite looks like it printed nothing while exiting 0.
  if (condition) {
    realConsole.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    realConsole.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/**
 * fast-check inside a plain script: pass a FACTORY, report through `check`.
 *
 * `await`ing `fc.assert` is NOT optional for an ASYNC property, and getting it
 * wrong is silent. `fc.assert` over an `asyncProperty` returns a Promise, so
 * without the await this helper printed PASS immediately and the assertion kept
 * running in the background - past the end of the file and past `mf.dispose()`,
 * which surfaced as an unhandled "Attempted to use poisoned stub" rejection while
 * every property still reported green. A property that cannot fail its own suite
 * is not a test.
 */
async function property(name, build, runs = 60) {
  try {
    await fc.assert(build(), { numRuns: runs });
    check(name, true);
  } catch (error) {
    // The WHOLE message, collapsed to one line. `message.split('\n')[0]` is just
    // "Property failed after N tests" and throws away the counterexample and the
    // thrown cause underneath it - which is the only part that tells you what broke.
    const detail = error instanceof Error ? `${error.message} ${error.cause ?? ''}` : String(error);
    check(name, false, detail.replace(/\s+/g, ' ').slice(0, 600));
  }
}

// --- Bounds restated from the module, not imported -------------------------
// A test that imports the constant it checks proves only self-consistency.

const PREFIX = '/api/admin/billing/';
const TELEMETRY_PREFIX = '/api/admin/telemetry/';
const ROUTES = ['costs', 'revenue'];
/** `BURN_WINDOW_DAYS`. Runway is always measured over this, never over the range. */
const BURN_DAYS = 30;
/** `TIERS` monthly USD allowances, restated. */
const TIER_ALLOWANCE = { starter: 4, pro: 12.6, team: 44 };

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-billing-admin' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements. Split on `/\r?\n/`, never `'\n'`: a CRLF
 * checkout leaves each line ending in `\r`, the `--` stripper then matches
 * nothing, and the comment-only tail reaches D1 as "SQL code did not contain a
 * statement".
 */
function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
for (const file of ['0001_init.sql', '0003_billing.sql', '0004_billing_ordering.sql']) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

/**
 * Clears every table this suite writes.
 *
 * ONE `batch` rather than five `run()` calls, and that is a socket budget decision
 * rather than tidiness: `getD1Database` costs one loopback socket PER STATEMENT
 * (measured - see `miniflare-loopback.mjs`), Windows parks each closed socket in
 * TIME_WAIT for two minutes against a 16,384-port range, and this runs at the top
 * of every property iteration. Five statements x ~75 iterations is ~375 sockets
 * spent on nothing but DELETEs; one batch is 75.
 *
 * That is not a micro-optimisation - the whole-chain run failed here on a property
 * that passes at 400 iterations in isolation, which is the documented signature of
 * inheriting a drained port range from the suite before it.
 */
async function resetDb() {
  await DB.batch(
    ['tenants', 'usage', 'quotas', 'credit_grants', 'stripe_events'].map((table) =>
      DB.prepare(`DELETE FROM ${table}`),
    ),
  );
}

async function seedTenant({ id, tier, status, keyHash = 'hash', keyEnc = 'enc' }) {
  const now = new Date().toISOString();
  await DB.prepare(
    'INSERT INTO tenants (id, email, tier, status, openrouter_key_id, openrouter_key_enc, ' +
      'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, `${id}@example.test`, tier, status, keyHash, keyEnc, now, now)
    .run();
}

async function seedUsage({ tenantId, costUsd, daysAgo, runId }) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await DB.prepare(
    'INSERT INTO usage (tenant_id, run_id, workflow_id, month, cost_usd, tokens_in, tokens_out, ' +
      'created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
  )
    .bind(tenantId, runId, 'wf', at.slice(0, 7), costUsd, at)
    .run();
}

async function seedGrant({ tenantId, paymentId, credits, costUsd, consumed = 0 }) {
  await DB.prepare(
    'INSERT INTO credit_grants (tenant_id, stripe_payment_id, credits, cost_usd, ' +
      'cost_usd_consumed, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(tenantId, paymentId, credits, costUsd, consumed, new Date().toISOString())
    .run();
}

// --- A real session token --------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-billing-admin-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600 },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// --- Environment shapes ----------------------------------------------------

const OWNER = 'user_3IzOklOFc47mTy0fQzbnlTjLptI';
const STRANGER = 'user_not_an_operator';
const STRIPE_KEY = 'sk_test_billing_admin_do_not_leak';
const OPENROUTER_KEY = 'sk-or-v1-provisioning-do-not-leak';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7323' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

/** A minimal KV double, so the revenue cache is observable rather than inferred. */
function kvDouble() {
  const store = new Map();
  const writes = [];
  return {
    writes,
    size: () => store.size,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      writes.push({ key, options });
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    TELEMETRY_ADMIN_USER_IDS: `  ${OWNER} , user_second_operator  `,
    STRIPE_SECRET_KEY: STRIPE_KEY,
    OPENROUTER_PROVISIONING_KEY: OPENROUTER_KEY,
    DB,
    ...extra,
  };
}

async function api(env, path, { bearer, token, method = 'GET', query = {} } = {}) {
  const url = new URL(`${ORIGIN}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = {};
  const authorization = bearer ?? (token ? `Bearer ${mintToken(token)}` : null);
  if (authorization) headers['Authorization'] = authorization;

  const response = await handleApiRequest(new Request(url, { method, headers }), env, CORS, CTX);
  const text = response === null ? '' : await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, status: response?.status ?? 0, body, text, headers: response?.headers };
}

// --- The vendor stub -------------------------------------------------------

const realFetch = globalThis.fetch;
const realError = console.error;
const realWarn = console.warn;
const realLog = console.log;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serves OpenRouter and Stripe from fixtures and captures every call.
 *
 * `credits` is the OpenRouter body (or a function for a failure), `invoices` and
 * `balanceTransactions` are ARRAYS OF PAGES so pagination is driven by the
 * fixture rather than simulated.
 */
function vendorStub({ credits, invoices = [[]], balanceTransactions = [[]] } = {}) {
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  console.error = capture;
  console.warn = capture;
  console.log = capture;

  const pageFor = (pages, cursor) => {
    const index = cursor === undefined ? 0 : Number(cursor.split(':')[1] ?? 0) + 1;
    const rows = pages[index] ?? [];
    return {
      data: rows.map((row, i) => ({ id: `obj:${index}:${i}`, ...row })),
      has_more: index + 1 < pages.length,
    };
  };
  // The cursor the worker echoes back is the LAST id of the page it just read, so
  // the page index is recoverable from it - which is what lets the fixture prove
  // the walk actually follows `starting_after` rather than refetching page 0.
  const cursorPage = (pages, startingAfter) => {
    if (!startingAfter) return pageFor(pages, undefined);
    const index = Number(String(startingAfter).split(':')[1] ?? 0) + 1;
    const rows = pages[index] ?? [];
    return {
      data: rows.map((row, i) => ({ id: `obj:${index}:${i}`, ...row })),
      has_more: index + 1 < pages.length,
    };
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({
      host: url.host,
      path: url.pathname,
      method: init.method ?? 'GET',
      query: Object.fromEntries(url.searchParams),
    });

    if (url.host === 'openrouter.ai') {
      if (typeof credits === 'function') return credits();
      if (credits === undefined) throw new Error('openrouter unreachable');
      return jsonResponse(credits);
    }

    if (url.pathname === '/v1/invoices') {
      return jsonResponse(cursorPage(invoices, url.searchParams.get('starting_after')));
    }
    if (url.pathname === '/v1/balance_transactions') {
      return jsonResponse(cursorPage(balanceTransactions, url.searchParams.get('starting_after')));
    }
    throw new Error(`unexpected vendor path ${url.host}${url.pathname}`);
  };

  return {
    calls,
    logs,
    callsTo: (path) => calls.filter((call) => call.path === path),
    restore: () => {
      globalThis.fetch = realFetch;
      console.error = realError;
      console.warn = realWarn;
      console.log = realLog;
    },
  };
}

/**
 * The range every `revenue` check queries, as a ROLLING window ending today.
 *
 * It used to be the fixed literal `2026-09-01 .. 2026-09-08`, and that was a time
 * bomb: `seedUsage` places rows relative to `Date.now()`, so once the real clock
 * moved past 2026-09-10 every seeded row fell OUTSIDE the window, `vendorCostUsd`
 * read 0, and the two margin checks below started failing - having silently stopped
 * covering the vendor-cost half of the subtraction some days earlier.
 *
 * Thirty days back, so `daysAgo: 1`, `2` and `3` all land inside it, and derived
 * from the UTC day because that is the clock `parseDateRange` measures against.
 * Nothing in this file asserts that a row is EXCLUDED by the range, so widening it
 * costs no coverage.
 */
const RANGE = (() => {
  const day = 86_400_000;
  const iso = (at) => new Date(at).toISOString().slice(0, 10);
  const today = Date.now();
  return { from: iso(today - 30 * day), to: iso(today) };
})();

// ══ 1. The shared operator gate ═════════════════════════════════════════════

realConsole.log('\nThe operator gate, shared with /api/admin/telemetry/*');
{
  await resetDb();
  const stub = vendorStub({ credits: { data: { total_credits: 100, total_usage: 10 } } });
  try {
    for (const route of ROUTES) {
      const path = `${PREFIX}${route}`;

      const anonymous = await api(hostedEnv(), path);
      check(
        `${route}: no bearer is 401 Unauthorized`,
        anonymous.status === 401 && anonymous.body?.error === 'Unauthorized.',
        `${anonymous.status} ${JSON.stringify(anonymous.body)}`,
      );

      const blank = await api(hostedEnv(), path, { bearer: 'Bearer    ' });
      check(
        `${route}: a whitespace-only bearer is an ABSENT credential, so 401`,
        blank.status === 401,
        `${blank.status} ${JSON.stringify(blank.body)}`,
      );

      const garbage = await api(hostedEnv(), path, { bearer: 'Bearer not-a-jwt' });
      check(
        `${route}: an unverifiable token is 401`,
        garbage.status === 401,
        `${garbage.status} ${JSON.stringify(garbage.body)}`,
      );

      const stranger = await api(hostedEnv(), path, { token: STRANGER });
      check(
        `${route}: a verified non-operator is 403 Forbidden`,
        stranger.status === 403 && stranger.body?.error === 'Forbidden.',
        `${stranger.status} ${JSON.stringify(stranger.body)}`,
      );

      const noAllowlist = await api(hostedEnv({ TELEMETRY_ADMIN_USER_IDS: undefined }), path, {
        token: OWNER,
      });
      check(
        `${route}: an unset allowlist closes the door for everyone (403)`,
        noAllowlist.status === 403,
        `${noAllowlist.status} ${JSON.stringify(noAllowlist.body)}`,
      );

      const jsonAllowlist = await api(
        hostedEnv({ TELEMETRY_ADMIN_USER_IDS: JSON.stringify([OWNER]) }),
        path,
        { token: OWNER },
      );
      check(
        `${route}: a JSON-ARRAY allowlist value fails closed (the 2026-09-09 trap)`,
        jsonAllowlist.status === 403,
        `${jsonAllowlist.status} ${JSON.stringify(jsonAllowlist.body)}`,
      );

      const owner = await api(hostedEnv(), path, { token: OWNER });
      check(
        `${route}: a padded allowlist entry still authorizes its trimmed id (200)`,
        owner.status === 200,
        `${owner.status} ${JSON.stringify(owner.body)}`,
      );

      check(
        `${route}: every answer carries Cache-Control: no-store`,
        [anonymous, stranger, owner].every(
          (r) => r.headers?.get('Cache-Control') === 'no-store',
        ),
        [anonymous, stranger, owner].map((r) => r.headers?.get('Cache-Control')).join(' | '),
      );

      const posted = await api(hostedEnv(), path, { token: OWNER, method: 'POST' });
      check(
        `${route}: a POST from an operator is 405`,
        posted.status === 405,
        `${posted.status} ${JSON.stringify(posted.body)}`,
      );
    }

    const unknownRoute = await api(hostedEnv(), `${PREFIX}margin`, { token: OWNER });
    check(
      'an unknown billing route is 404 for an operator',
      unknownRoute.status === 404,
      `${unknownRoute.status} ${JSON.stringify(unknownRoute.body)}`,
    );
    const unknownAnonymous = await api(hostedEnv(), `${PREFIX}margin`);
    check(
      'and 401 for a stranger, so the code cannot enumerate routes',
      unknownAnonymous.status === 401,
      `${unknownAnonymous.status} ${JSON.stringify(unknownAnonymous.body)}`,
    );

    // THE REFACTOR'S SAFETY PROPERTY. `admin-auth.ts` was extracted out of
    // `telemetry-admin.ts` so both surfaces share one door; if the two prefixes
    // ever disagree for an identity, the extraction regressed.
    const identities = [
      { label: 'no bearer', options: {} },
      { label: 'garbage bearer', options: { bearer: 'Bearer nope' } },
      { label: 'a stranger', options: { token: STRANGER } },
      { label: 'the operator', options: { token: OWNER } },
    ];
    for (const { label, options } of identities) {
      const billing = await api(hostedEnv(), `${PREFIX}costs`, options);
      const telemetry = await api(hostedEnv(), `${TELEMETRY_PREFIX}summary`, options);
      check(
        `both admin prefixes answer alike for ${label} (${billing.status})`,
        billing.status === telemetry.status,
        `billing ${billing.status} vs telemetry ${telemetry.status}`,
      );
    }
  } finally {
    stub.restore();
  }
}

// ══ 2. GET costs - the balance, and what "unknown" must never become ════════

realConsole.log('\nGET costs - an unknown balance is null, never zero');
{
  await resetDb();
  await seedTenant({ id: 't_starter', tier: 'starter', status: 'active' });

  const healthy = vendorStub({ credits: { data: { total_credits: 250, total_usage: 90.5 } } });
  let body;
  try {
    body = (await api(hostedEnv(), `${PREFIX}costs`, { token: OWNER })).body;
  } finally {
    healthy.restore();
  }
  check(
    'balance is purchased minus spent',
    body.vendor.purchasedUsd === 250 &&
      body.vendor.spentUsd === 90.5 &&
      body.vendor.balanceUsd === 159.5,
    JSON.stringify(body.vendor),
  );
  check(
    'a healthy read is configured, reachable and not degraded',
    body.vendor.configured === true && body.vendor.reachable === true && body.degraded.length === 0,
    JSON.stringify({ vendor: body.vendor, degraded: body.degraded }),
  );

  // The distinction the whole design turns on, over every failure shape.
  const failures = [
    ['a network error', undefined],
    ['a 401 from the vendor', () => jsonResponse({ error: { message: OPENROUTER_KEY } }, 401)],
    ['a 500 from the vendor', () => jsonResponse({ error: 'boom' }, 500)],
    ['a non-JSON body', () => new Response('<html>nope</html>', { status: 200 })],
    ['a body with no totals', () => jsonResponse({ data: { something_else: 1 } })],
  ];
  for (const [label, credits] of failures) {
    const stub = vendorStub({ credits });
    let failed;
    try {
      failed = await api(hostedEnv(), `${PREFIX}costs`, { token: OWNER });
    } finally {
      stub.restore();
    }
    check(
      `${label} still answers 200 with a NULL balance, never 0`,
      failed.status === 200 &&
        failed.body.vendor.balanceUsd === null &&
        failed.body.vendor.purchasedUsd === null &&
        failed.body.vendor.reachable === false &&
        failed.body.vendor.configured === true,
      `${failed.status} ${JSON.stringify(failed.body?.vendor)}`,
    );
    check(
      `${label} names the degraded half and no runway`,
      failed.body.degraded.includes('openrouter-balance') && failed.body.burn.runwayDays === null,
      JSON.stringify({ degraded: failed.body.degraded, burn: failed.body.burn }),
    );
    check(
      `${label} leaks no provisioning key into the response body`,
      !failed.text.includes(OPENROUTER_KEY),
      failed.text.slice(0, 160),
    );
  }

  const unconfigured = vendorStub({ credits: { data: { total_credits: 1, total_usage: 0 } } });
  let byo;
  try {
    byo = (
      await api(hostedEnv({ OPENROUTER_PROVISIONING_KEY: undefined }), `${PREFIX}costs`, {
        token: OWNER,
      })
    ).body;
  } finally {
    unconfigured.restore();
  }
  check(
    'an unbound provisioning key is configured:false and is NOT degraded',
    byo.vendor.configured === false &&
      byo.vendor.balanceUsd === null &&
      !byo.degraded.includes('openrouter-balance'),
    JSON.stringify({ vendor: byo.vendor, degraded: byo.degraded }),
  );
  check(
    'and it made no OpenRouter call at all',
    unconfigured.calls.filter((call) => call.host === 'openrouter.ai').length === 0,
    JSON.stringify(unconfigured.calls.map((c) => c.host)),
  );
}

// ══ 3. GET costs - burn, runway and committed ceilings ═════════════════════

realConsole.log('\nGET costs - burn, runway and the committed ceiling');
{
  await resetDb();
  // Two active tenants on different tiers, one cancelled, one past_due.
  await seedTenant({ id: 't_a', tier: 'starter', status: 'active' });
  await seedTenant({ id: 't_b', tier: 'team', status: 'active' });
  await seedTenant({ id: 't_gone', tier: 'pro', status: 'canceled' });
  await seedTenant({ id: 't_late', tier: 'pro', status: 'past_due' });
  // An active tenant with NO key - the `no_runtime_key` population.
  await seedTenant({ id: 't_nokey', tier: 'starter', status: 'active', keyEnc: null });

  // In the burn window, and one row safely outside it.
  await seedUsage({ tenantId: 't_a', costUsd: 3, daysAgo: 1, runId: 'r1' });
  await seedUsage({ tenantId: 't_b', costUsd: 12, daysAgo: 10, runId: 'r2' });
  await seedUsage({ tenantId: 't_b', costUsd: 999, daysAgo: 45, runId: 'r3' });

  // Unspent grants: one on an ACTIVE tenant (counts) and one on a cancelled
  // tenant (must not, because it is not a live commitment).
  await seedGrant({ tenantId: 't_a', paymentId: 'pi_1', credits: 500, costUsd: 2, consumed: 0.5 });
  await seedGrant({ tenantId: 't_gone', paymentId: 'pi_2', credits: 500, costUsd: 2 });

  const stub = vendorStub({ credits: { data: { total_credits: 200, total_usage: 50 } } });
  let body;
  try {
    body = (await api(hostedEnv(), `${PREFIX}costs`, { token: OWNER })).body;
  } finally {
    stub.restore();
  }

  const expectedBurn = 15; // 3 + 12; the 45-day-old row is outside the window
  check(
    'the burn window excludes rows older than 30 days',
    body.burn.meteredUsd === expectedBurn && body.burn.windowDays === BURN_DAYS,
    JSON.stringify(body.burn),
  );
  check(
    'perDay is the window total divided by the window length',
    Math.abs(body.burn.perDayUsd - expectedBurn / BURN_DAYS) < 1e-6,
    JSON.stringify(body.burn),
  );
  check(
    'runway is balance divided by the daily burn',
    body.burn.runwayDays === Math.round(150 / (expectedBurn / BURN_DAYS)),
    `${body.burn.runwayDays} from balance ${body.vendor.balanceUsd}`,
  );

  const expectedAllowance = TIER_ALLOWANCE.starter * 2 + TIER_ALLOWANCE.team; // t_a, t_nokey, t_b
  check(
    'the committed allowance counts ACTIVE tenants only, at their own tier rate',
    body.committed.activeTenants === 3 &&
      Math.abs(body.committed.allowanceUsd - expectedAllowance) < 1e-6,
    JSON.stringify(body.committed),
  );
  check(
    "the grant pool counts an active tenant's unspent grant and not a cancelled one's",
    Math.abs(body.committed.grantPoolUsd - 1.5) < 1e-6,
    JSON.stringify(body.committed),
  );
  check(
    'the ceiling is allowance plus grant pool - the sum of every live key limit',
    Math.abs(body.committed.ceilingUsd - (expectedAllowance + 1.5)) < 1e-6,
    JSON.stringify(body.committed),
  );
  check(
    'coverage is the balance over that ceiling',
    Math.abs(body.committed.coverageRatio - 150 / (expectedAllowance + 1.5)) < 1e-3,
    `${body.committed.coverageRatio}`,
  );
  check(
    'the per-tier breakdown sums to the allowance, biggest first',
    Math.abs(
      body.committed.byTier.reduce((sum, row) => sum + row.allowanceUsd, 0) - expectedAllowance,
    ) < 1e-6 &&
      body.committed.byTier[0].tier === 'team' &&
      body.committed.byTier.every((row) => row.tenants > 0),
    JSON.stringify(body.committed.byTier),
  );

  check(
    'an active tenant with no stored key is counted as entitled-without-key',
    body.attention.entitledWithoutKey === 1,
    JSON.stringify(body.attention),
  );
  const retired = body.attention.retiredHoldingKey.map((row) => row.id).sort();
  check(
    'both non-active tenants still holding a key hash are listed, by id',
    retired.length === 2 && retired[0] === 't_gone' && retired[1] === 't_late',
    JSON.stringify(body.attention.retiredHoldingKey),
  );
  check(
    'no active tenant appears in the retired-holding-key list',
    body.attention.retiredHoldingKey.every((row) => row.status !== 'active'),
    JSON.stringify(body.attention.retiredHoldingKey),
  );

  // A BYO worker binds no D1. Zeros and nulls, never a 501 about bindings.
  const byoStub = vendorStub({ credits: { data: { total_credits: 0, total_usage: 0 } } });
  let byo;
  try {
    // Clerk stays configured - the case under test is the ABSENT `DB`, and
    // dropping the secret too would just re-test the 401 path above.
    byo = await api(
      {
        PHORMA_MODE: 'hosted',
        CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
        CLERK_JWT_KEY,
        TELEMETRY_ADMIN_USER_IDS: OWNER,
      },
      `${PREFIX}costs`,
      { token: OWNER },
    );
  } finally {
    byoStub.restore();
  }
  check(
    'a worker with no DB answers 200 with nothing committed, not a 501',
    byo.status === 200 &&
      byo.body.committed.ceilingUsd === 0 &&
      byo.body.committed.activeTenants === 0 &&
      byo.body.attention.retiredHoldingKey.length === 0,
    `${byo.status} ${JSON.stringify(byo.body?.committed)}`,
  );
}

// ══ 4. GET revenue - the tax basis, both Stripe shapes ═════════════════════

realConsole.log('\nGET revenue - net of tax is the margin basis, in both Stripe tax shapes');
{
  await resetDb();
  await seedUsage({ tenantId: 't_a', costUsd: 1.25, daysAgo: 2, runId: 'rr1' });

  // Same money, two shapes. The scalar `tax` and the `total_taxes[]` breakdown
  // MUST produce the same net, or one account's API version silently inflates it.
  const shapes = {
    'the scalar invoice.tax': [{ currency: 'usd', total: 2000, tax: 182 }],
    'the total_taxes breakdown': [
      { currency: 'usd', total: 2000, total_taxes: [{ amount: 100 }, { amount: 82 }] },
    ],
  };
  const nets = [];
  for (const [label, invoices] of Object.entries(shapes)) {
    const stub = vendorStub({
      credits: { data: { total_credits: 10, total_usage: 1 } },
      invoices: [invoices],
      balanceTransactions: [[{ currency: 'usd', fee: 95 }]],
    });
    let body;
    try {
      body = (
        await api(hostedEnv({ TENANTS: kvDouble() }), `${PREFIX}revenue`, {
          token: OWNER,
          query: RANGE,
        })
      ).body;
    } finally {
      stub.restore();
    }
    nets.push(body.invoiced.netUsd);
    check(
      `${label}: gross 20.00, tax 1.82, net 18.18`,
      body.invoiced.grossUsd === 20 &&
        body.invoiced.taxUsd === 1.82 &&
        body.invoiced.netUsd === 18.18,
      JSON.stringify(body.invoiced),
    );
    check(
      `${label}: the Stripe fee is a real cost and lands in the margin`,
      body.processing.feeUsd === 0.95 &&
        body.margin.processingFeeUsd === 0.95 &&
        Math.abs(body.margin.marginUsd - (18.18 - 1.25 - 0.95)) < 1e-6,
      JSON.stringify({ processing: body.processing, margin: body.margin }),
    );
    check(
      `${label}: the margin percentage is measured on NET, not gross`,
      Math.abs(body.margin.marginPct - ((18.18 - 1.25 - 0.95) / 18.18) * 100) < 0.01,
      `${body.margin.marginPct}`,
    );
  }
  check('both tax shapes agree on the net', nets[0] === nets[1], nets.join(' vs '));

  // Non-USD is excluded and counted, never summed into a dollar total.
  const mixed = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [
      [
        { currency: 'usd', total: 2000, tax: 182 },
        { currency: 'eur', total: 5000, tax: 800 },
        { currency: 'USD', total: 1000, tax: 91 },
      ],
    ],
    balanceTransactions: [[{ currency: 'aud', fee: 5000 }]],
  });
  let mixedBody;
  try {
    mixedBody = (
      await api(hostedEnv({ TENANTS: kvDouble() }), `${PREFIX}revenue`, {
        token: OWNER,
        query: RANGE,
      })
    ).body;
  } finally {
    mixed.restore();
  }
  check(
    'a non-USD invoice is counted and EXCLUDED from the dollar totals',
    mixedBody.invoiced.count === 2 &&
      mixedBody.invoiced.grossUsd === 30 &&
      mixedBody.invoiced.otherCurrencyCount === 1,
    JSON.stringify(mixedBody.invoiced),
  );
  check(
    'a non-USD balance transaction contributes no fee',
    mixedBody.processing.feeUsd === 0 && mixedBody.processing.otherCurrencyCount === 1,
    JSON.stringify(mixedBody.processing),
  );

  // No invoices at all is a null margin, not a zero one.
  const quiet = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [[]],
    balanceTransactions: [[]],
  });
  let quietBody;
  try {
    quietBody = (
      await api(hostedEnv({ TENANTS: kvDouble() }), `${PREFIX}revenue`, {
        token: OWNER,
        query: RANGE,
      })
    ).body;
  } finally {
    quiet.restore();
  }
  check(
    'a range with no revenue reports marginPct null rather than 0 percent',
    quietBody.invoiced.count === 0 && quietBody.margin.marginPct === null,
    JSON.stringify({ invoiced: quietBody.invoiced, margin: quietBody.margin }),
  );

  // An unconfigured Stripe worker: absent, not broken, and no Stripe call.
  const noStripe = vendorStub({ credits: { data: { total_credits: 1, total_usage: 0 } } });
  let noStripeBody;
  try {
    noStripeBody = await api(
      hostedEnv({ STRIPE_SECRET_KEY: undefined, TENANTS: kvDouble() }),
      `${PREFIX}revenue`,
      { token: OWNER, query: RANGE },
    );
  } finally {
    noStripe.restore();
  }
  check(
    'no STRIPE_SECRET_KEY answers 200 with configured:false and null halves',
    noStripeBody.status === 200 &&
      noStripeBody.body.configured === false &&
      noStripeBody.body.invoiced === null &&
      noStripeBody.body.margin === null,
    `${noStripeBody.status} ${JSON.stringify(noStripeBody.body)}`,
  );
  check(
    'and it called Stripe zero times',
    noStripe.calls.filter((call) => call.host === 'api.stripe.com').length === 0,
    JSON.stringify(noStripe.calls.map((c) => `${c.host}${c.path}`)),
  );
}

// ══ 5. GET revenue - pagination, degradation and the cache ═════════════════

realConsole.log('\nGET revenue - pagination, degradation and the KV cache');
{
  await resetDb();

  // Three pages of invoices. The walk must FOLLOW the cursor, not refetch page 0.
  const paged = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [
      [{ currency: 'usd', total: 1000, tax: 0 }],
      [{ currency: 'usd', total: 2000, tax: 0 }],
      [{ currency: 'usd', total: 3000, tax: 0 }],
    ],
    balanceTransactions: [[]],
  });
  let pagedBody;
  try {
    pagedBody = (
      await api(hostedEnv({ TENANTS: kvDouble() }), `${PREFIX}revenue`, {
        token: OWNER,
        query: RANGE,
      })
    ).body;
  } finally {
    paged.restore();
  }
  check(
    'the walk follows starting_after across every page',
    pagedBody.invoiced.count === 3 && pagedBody.invoiced.grossUsd === 60,
    JSON.stringify(pagedBody.invoiced),
  );
  check(
    'and it stopped once has_more went false, rather than looping',
    paged.callsTo('/v1/invoices').length === 3 && pagedBody.invoiced.truncated === false,
    `${paged.callsTo('/v1/invoices').length} page reads`,
  );
  const cursors = paged.callsTo('/v1/invoices').map((call) => call.query['starting_after']);
  check(
    'the first page sends no cursor and each later page sends the previous last id',
    cursors[0] === undefined && cursors[1] === 'obj:0:0' && cursors[2] === 'obj:1:0',
    JSON.stringify(cursors),
  );
  check(
    'the Stripe window is inclusive of the whole final day',
    Number(paged.callsTo('/v1/invoices')[0].query['created[lte]']) ===
      Math.floor(Date.parse(`${RANGE.to}T23:59:59.999Z`) / 1000),
    JSON.stringify(paged.callsTo('/v1/invoices')[0].query),
  );

  // A Stripe failure degrades ONE half and is NOT cached.
  const kv = kvDouble();
  const broken = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [[]],
    balanceTransactions: [[]],
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/invoices') return jsonResponse({ error: { code: 'api_error' } }, 500);
    if (url.pathname === '/v1/balance_transactions') return jsonResponse({ data: [], has_more: false });
    return jsonResponse({ data: { total_credits: 10, total_usage: 1 } });
  };
  let brokenBody;
  try {
    brokenBody = await api(hostedEnv({ TENANTS: kv }), `${PREFIX}revenue`, {
      token: OWNER,
      query: RANGE,
    });
  } finally {
    broken.restore();
  }
  check(
    'a Stripe invoice failure is still a 200 that names the degraded half',
    brokenBody.status === 200 &&
      brokenBody.body.invoiced === null &&
      brokenBody.body.degraded.includes('stripe-invoices'),
    `${brokenBody.status} ${JSON.stringify(brokenBody.body?.degraded)}`,
  );
  check(
    'the fee half survived the invoice failure',
    brokenBody.body.processing !== null,
    JSON.stringify(brokenBody.body?.processing),
  );
  check(
    'a DEGRADED answer is not cached - a transient failure must not freeze for 5 minutes',
    kv.size() === 0 && kv.writes.length === 0,
    `${kv.size()} cached entr(y|ies)`,
  );

  // A clean answer IS cached, with a TTL, and the second read makes no Stripe call.
  const cacheKv = kvDouble();
  const clean = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [[{ currency: 'usd', total: 2000, tax: 182 }]],
    balanceTransactions: [[{ currency: 'usd', fee: 95 }]],
  });
  let first;
  let second;
  try {
    first = await api(hostedEnv({ TENANTS: cacheKv }), `${PREFIX}revenue`, {
      token: OWNER,
      query: RANGE,
    });
    const before = clean.callsTo('/v1/invoices').length;
    second = await api(hostedEnv({ TENANTS: cacheKv }), `${PREFIX}revenue`, {
      token: OWNER,
      query: RANGE,
    });
    check(
      'a cache hit makes no further Stripe call',
      clean.callsTo('/v1/invoices').length === before,
      `${before} then ${clean.callsTo('/v1/invoices').length}`,
    );
  } finally {
    clean.restore();
  }
  check(
    'a clean answer is cached with an expiring TTL',
    cacheKv.writes.length === 1 && Number(cacheKv.writes[0].options?.expirationTtl) >= 60,
    JSON.stringify(cacheKv.writes),
  );
  check(
    'and the cached answer is byte-identical to the computed one',
    JSON.stringify(second.body.invoiced) === JSON.stringify(first.body.invoiced),
    `${JSON.stringify(first.body?.invoiced)} vs ${JSON.stringify(second.body?.invoiced)}`,
  );
  check(
    'a worker with no KV still answers, just without caching',
    (
      await (async () => {
        const noKv = vendorStub({
          credits: { data: { total_credits: 10, total_usage: 1 } },
          invoices: [[{ currency: 'usd', total: 1000, tax: 0 }]],
        });
        try {
          const answer = await api(hostedEnv(), `${PREFIX}revenue`, {
            token: OWNER,
            query: RANGE,
          });
          return answer.status === 200 && answer.body.invoiced.grossUsd === 10;
        } finally {
          noKv.restore();
        }
      })()
    ),
    'expected a 200 with real totals and no KV binding',
  );
}

// ══ 6. The shared range grammar, and no vendor prose ══════════════════════

realConsole.log('\nThe range grammar is shared with telemetry, and no vendor prose escapes');
{
  await resetDb();
  const stub = vendorStub({
    credits: { data: { total_credits: 10, total_usage: 1 } },
    invoices: [[]],
    balanceTransactions: [[]],
  });
  try {
    const badRanges = [
      { from: '2026-09-08', to: '2026-09-01' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-9-1', to: '2026-09-08' },
      { from: '2020-01-01', to: '2026-09-08' },
    ];
    for (const query of badRanges) {
      const answer = await api(hostedEnv(), `${PREFIX}revenue`, { token: OWNER, query });
      check(
        `an invalid range ${query.from}..${query.to} is 400 with a static body`,
        answer.status === 400 && answer.body?.error === 'Invalid date range.',
        `${answer.status} ${JSON.stringify(answer.body)}`,
      );
    }
    const defaulted = await api(hostedEnv(), `${PREFIX}revenue`, { token: OWNER });
    check(
      'an absent range falls back to the shared default rather than failing',
      defaulted.status === 200 && typeof defaulted.body.range?.from === 'string',
      `${defaulted.status} ${JSON.stringify(defaulted.body?.range)}`,
    );
  } finally {
    stub.restore();
  }

  // A vendor error body carrying our secret must reach the log and never the wire.
  const leaky = vendorStub({ credits: { data: { total_credits: 1, total_usage: 0 } } });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.host === 'api.stripe.com') {
      return jsonResponse(
        { error: { code: 'api_key_expired', message: `Expired API Key provided: ${STRIPE_KEY}` } },
        401,
      );
    }
    return jsonResponse({ data: { total_credits: 1, total_usage: 0 } });
  };
  let leakyAnswer;
  try {
    leakyAnswer = await api(hostedEnv({ TENANTS: kvDouble() }), `${PREFIX}revenue`, {
      token: OWNER,
      query: RANGE,
    });
  } finally {
    leaky.restore();
  }
  check(
    'a Stripe body quoting the secret key never reaches the response',
    !leakyAnswer.text.includes(STRIPE_KEY) && !leakyAnswer.text.includes('Expired API Key'),
    leakyAnswer.text.slice(0, 200),
  );
  check(
    'and the log line redacted it too',
    leaky.logs.length > 0 && leaky.logs.every((line) => !line.includes(STRIPE_KEY)),
    leaky.logs.join(' | ').slice(0, 200),
  );
}

// ══ 7. Properties over the money arithmetic ═══════════════════════════════

realConsole.log('\nProperties: the arithmetic holds for any figures Stripe can send');
{
  const minor = fc.integer({ min: 0, max: 5_000_000 });

  await property('net is never negative and never exceeds gross', () =>
    fc.asyncProperty(
      fc.array(fc.record({ total: minor, tax: minor }), { minLength: 0, maxLength: 6 }),
      async (rows) => {
        await resetDb();
        const stub = vendorStub({
          credits: { data: { total_credits: 1, total_usage: 0 } },
          invoices: [rows.map((row) => ({ currency: 'usd', ...row }))],
          balanceTransactions: [[]],
        });
        try {
          const body = (
            await api(hostedEnv(), `${PREFIX}revenue`, { token: OWNER, query: RANGE })
          ).body;
          const { grossUsd, taxUsd, netUsd } = body.invoiced;
          if (netUsd < 0) throw new Error(`net ${netUsd} went negative`);
          if (netUsd > grossUsd + 1e-9) throw new Error(`net ${netUsd} exceeded gross ${grossUsd}`);
          // Net is gross minus tax, unless the clamp fired (tax above total).
          const unclamped = Math.round((grossUsd - taxUsd) * 100) / 100;
          if (unclamped >= 0 && Math.abs(netUsd - unclamped) > 0.011) {
            throw new Error(`net ${netUsd} is not gross ${grossUsd} minus tax ${taxUsd}`);
          }
          if (body.invoiced.count !== rows.length) {
            throw new Error(`counted ${body.invoiced.count} of ${rows.length}`);
          }
        } finally {
          stub.restore();
        }
      },
    ),
    25,
  );

  await property('the ceiling always equals the allowance plus the pool, and coverage tracks it', () =>
    fc.asyncProperty(
      fc.array(
        fc.record({
          tier: fc.constantFrom('starter', 'pro', 'team'),
          status: fc.constantFrom('active', 'past_due', 'canceled'),
        }),
        { minLength: 0, maxLength: 8 },
      ),
      fc.integer({ min: 0, max: 400 }),
      async (rows, balanceCents) => {
        await resetDb();
        let expectedAllowance = 0;
        let activeCount = 0;
        const now = new Date().toISOString();
        // Batched for the same socket-budget reason as `resetDb`: seeding eight
        // tenants one statement at a time is eight sockets per iteration.
        const seeds = rows.map((row, index) =>
          DB.prepare(
            'INSERT INTO tenants (id, email, tier, status, openrouter_key_id, ' +
              'openrouter_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).bind(`p_${index}`, null, row.tier, row.status, 'hash', 'enc', now, now),
        );
        if (seeds.length > 0) await DB.batch(seeds);
        for (const row of rows) {
          if (row.status === 'active') {
            activeCount += 1;
            expectedAllowance += TIER_ALLOWANCE[row.tier];
          }
        }
        const balance = balanceCents / 4;
        const stub = vendorStub({
          credits: { data: { total_credits: balance, total_usage: 0 } },
        });
        try {
          const body = (
            await api(hostedEnv(), `${PREFIX}costs`, { token: OWNER })
          ).body;
          if (body.committed.activeTenants !== activeCount) {
            throw new Error(
              `active ${body.committed.activeTenants} expected ${activeCount}`,
            );
          }
          if (Math.abs(body.committed.allowanceUsd - expectedAllowance) > 0.011) {
            throw new Error(
              `allowance ${body.committed.allowanceUsd} expected ${expectedAllowance}`,
            );
          }
          const { allowanceUsd, grantPoolUsd, ceilingUsd, coverageRatio } = body.committed;
          if (Math.abs(ceilingUsd - (allowanceUsd + grantPoolUsd)) > 0.011) {
            throw new Error(`ceiling ${ceilingUsd} is not ${allowanceUsd} + ${grantPoolUsd}`);
          }
          const expectedCoverage = ceilingUsd > 0 ? balance / ceilingUsd : null;
          if (expectedCoverage === null) {
            if (coverageRatio !== null) throw new Error(`coverage ${coverageRatio} on a 0 ceiling`);
          } else if (Math.abs(coverageRatio - expectedCoverage) > 1e-3) {
            throw new Error(`coverage ${coverageRatio} expected ${expectedCoverage}`);
          }
        } finally {
          stub.restore();
        }
      },
    ),
    25,
  );

  await property('runway is null exactly when it cannot be projected', () =>
    fc.asyncProperty(
      fc.integer({ min: 0, max: 2000 }),
      fc.boolean(),
      async (costCents, vendorUp) => {
        await resetDb();
        await seedTenant({ id: 'r_a', tier: 'starter', status: 'active' });
        if (costCents > 0) {
          await seedUsage({
            tenantId: 'r_a',
            costUsd: costCents / 100,
            daysAgo: 3,
            runId: `run_${costCents}`,
          });
        }
        const stub = vendorStub({
          credits: vendorUp ? { data: { total_credits: 100, total_usage: 0 } } : undefined,
        });
        try {
          const body = (await api(hostedEnv(), `${PREFIX}costs`, { token: OWNER })).body;
          const projectable = vendorUp && costCents > 0;
          if (projectable && body.burn.runwayDays === null) {
            throw new Error(`runway null with balance and burn ${costCents}`);
          }
          if (!projectable && body.burn.runwayDays !== null) {
            throw new Error(
              `runway ${body.burn.runwayDays} with vendorUp=${vendorUp} burn=${costCents}`,
            );
          }
        } finally {
          stub.restore();
        }
      },
    ),
    25,
  );
}

await mf.dispose();

if (failures > 0) {
  realConsole.error(`\nbilling-admin FAILED with ${failures} failure(s).`);
  process.exitCode = 1;
} else {
  realConsole.log('\nAll billing-admin checks passed.');
}
