#!/usr/bin/env node
/**
 * The organisation management route family - `cloud/src/org-admin.ts`
 * (multi-organisation-phorma task 12, Requirements 13.1 to 13.9, 18.1, 20.11).
 *
 * Properties covered:
 *
 *  - 30  A new organisation is never implicitly paid, and a member holds exactly
 *        one level
 *
 * ## What this suite can see that no other one can
 *
 * Four claims, and each of them is invisible from any single surface:
 *
 *  1. THE GATE IS THE SAME DOOR. The three `refuseNonOperator` rules are driven
 *     against the NEW prefix rather than re-asserted against the telemetry one:
 *     an absent bearer is 401 BEFORE `verifyRequest`, a `device` credential is
 *     403 even at `admin` level in the organisation, and a missing or
 *     JSON-shaped `TELEMETRY_ADMIN_USER_IDS` grants nothing. A module that
 *     hand-rolled its own 401/403 split would pass a prefix test and fail here.
 *  2. A CREATED ORGANISATION IS NOT PAID. The `tenants` row has to EXIST - it is
 *     the quota bucket, the usage scope and the backup scope - while carrying no
 *     tier `isKnownTier` recognises, no `active` status, and NO runtime key. The
 *     key half is the one a source read cannot settle: `provisionTenantTier`
 *     reconciles only an `active` tenant, so the assertion is that the OpenRouter
 *     stub was never called at all.
 *  3. THE KV INVALIDATION IS REAL, IN BOTH DIRECTIONS. `resolveRole` caches a HIT
 *     for 60 seconds, so the only way to see a demotion bite on the NEXT request
 *     is to resolve once (populating the cache), demote through the route, and
 *     resolve again through the SAME KV. The removal half is stronger still: the
 *     assertion is that `resolveRequestedOwner` answered the organisation a
 *     moment ago and answers the caller's own owner afterwards, with NO refusal
 *     and a response indistinguishable from the same request without the header
 *     (Requirement 20.11).
 *  4. CLERK GOES FIRST, AND A PARTIAL FAILURE IS REPORTED. The stub can fail one
 *     half at a time, so "the Clerk write failed and NOTHING was written" and
 *     "Clerk landed and the row did not" are two different answers with two
 *     different codes - which is the whole reason the module reports rather than
 *     logs.
 *
 * ## Harness, and why each piece is real
 *
 *  - `handleApiRequest` is called DIRECTLY over a real local D1 (Miniflare's
 *    SQLite binding pulled into Node with the real migrations applied), the shape
 *    `provisioning`, `tenant-billing` and `billing-routes` use. The SQL under test
 *    is the SQL that ships, and no loopback socket is spent per request.
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here, the public
 *    half is bound as `CLERK_JWT_KEY`, and each case signs its own RS256 session
 *    JWT, so `@clerk/backend` verifies for real on its offline path with no JWKS
 *    fetch. The desktop token is minted by the real `mintDeviceToken`.
 *  - THE KV IS A RECORDING DOUBLE rather than Miniflare's, because the
 *    invalidation assertions are about what was DELETED and when. It behaves like
 *    KV for `get`/`put`/`delete` and records both.
 *  - `globalThis.fetch` stands in for the Clerk Backend API and for OpenRouter,
 *    recording every call with its method, path and parsed body. The bodies are
 *    the subject: `role` is what makes a demotion bite, and an OpenRouter call at
 *    all is what makes a new organisation paid.
 *
 * Run: npx tsx cloud/test/org-admin.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected before
// the module graph loads - which is why every module below arrives by dynamic
// import.
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
const {
  CLERK_UNAVAILABLE_ERROR,
  ORG_ADMIN_PREFIX,
  ORG_ADMIN_ROUTES,
  PARTIAL_WRITE_ERROR,
  UNPAID_ORG_STATUS,
  UNPAID_ORG_TIER,
  assignableTiers,
  clerkRoleFor,
} = await import('../src/org-admin.ts');
const {
  ADMIN_FORBIDDEN_ERROR,
  ADMIN_UNAUTHORIZED_ERROR,
} = await import('../src/admin-auth.ts');
const {
  REQUESTED_OWNER_HEADER,
  orgMemberCacheKey,
  resolveRequestedOwner,
  resolveRole,
  verifyBearer,
} = await import('../src/auth.ts');
const { CAPABILITY_LEVELS } = await import('../src/capabilities.ts');
const { mintDeviceToken } = await import('../src/device-auth.ts');
const { TENANT_CACHE_TTL_S, TenantStore, isKnownTier } = await import('../src/tenants.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

/**
 * Captured BEFORE the fetch stub reassigns the console, so a check reports
 * through the live terminal rather than into the captured array the partial-write
 * assertions search.
 */
const realConsole = { log: console.log, warn: console.warn, error: console.error };

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    realConsole.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    realConsole.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 100 };

async function asyncProperty(name, build) {
  try {
    await fc.assert(build(), RUNS);
    check(name, true);
  } catch (error) {
    check(name, false, describeFailure(error));
  }
}

function describeFailure(error) {
  return String(error?.message ?? error)
    .split('\n')
    .slice(0, 8)
    .join(' | ');
}

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  // Only the binding is used; nothing here goes through a worker route.
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-org-admin' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements (the files carry no string literals).
 * Split on `/\r?\n/`, never `'\n'`: a CRLF checkout leaves each line ending in
 * `\r`, the `--` stripper then matches nothing, and the comment-only tail of a
 * migration reaches D1 as "SQL code did not contain a statement".
 */
function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}
for (const file of [
  '0001_init.sql',
  '0003_billing.sql',
  '0004_billing_ordering.sql',
  '0005_workflow_backups.sql',
  '0006_organisations.sql',
]) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

/** Every row of both tables this family writes, wiped in ONE batch. */
async function resetTables() {
  await DB.batch([DB.prepare('DELETE FROM org_members'), DB.prepare('DELETE FROM tenants')]);
}

async function memberRows(orgId) {
  const rows = await DB.prepare(
    'SELECT org_id, user_id, level, invited_by FROM org_members WHERE org_id = ? ORDER BY user_id',
  )
    .bind(orgId)
    .all();
  return rows.results ?? [];
}

async function tenantRow(id) {
  return await DB.prepare(
    'SELECT id, tier, status, openrouter_key_id, openrouter_key_enc FROM tenants WHERE id = ?',
  )
    .bind(id)
    .first();
}

// --- A recording KV double -------------------------------------------------

function memoryKv() {
  const map = new Map();
  const puts = [];
  const deletes = [];
  return {
    entries: map,
    puts,
    deletes,
    async get(key, type) {
      const raw = map.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      map.set(key, value);
      puts.push({ key, value, options });
    },
    async delete(key) {
      map.delete(key);
      deletes.push(key);
    },
  };
}

// --- Real session and desktop tokens ---------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-org-admin-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

const OPERATOR = 'user_operator_org_admin';
const OUTSIDER = 'user_not_an_operator';
const DEVICE_SECRET = 'device-secret-do-not-leak';
const CLERK_SECRET = 'sk_test_clerk_verified_offline';
const PROVISIONING_KEY = 'or-provisioning-key-do-not-leak';
/** A real base64 32-byte AES-GCM key, so key encryption runs for real. */
const KEY_ENC_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7323' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: CLERK_SECRET,
    CLERK_JWT_KEY,
    PHORMA_AUTH_SECRET: DEVICE_SECRET,
    TELEMETRY_ADMIN_USER_IDS: OPERATOR,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
    KEY_ENC_SECRET,
    DB,
    ...extra,
  };
}

// --- The vendor stub -------------------------------------------------------

const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let mintCounter = 0;

/**
 * Stands in for the Clerk Backend API and for OpenRouter, recording every call
 * WITH ITS BODY.
 *
 * The bodies are what the assertions are about. `role` on a membership write is
 * what makes a demotion out of `admin` actually bite - a mapped `org:admin` claim
 * short-circuits the authoritative table, so a level change that left the Clerk
 * role alone would be a demotion in name only. And an OpenRouter call AT ALL is
 * what makes a newly created organisation paid, which Requirement 13.4 forbids.
 *
 * `options`: `existingMembership` (a PATCH succeeds instead of 404ing),
 * `failClerk` (every Clerk call fails), `failMembership` (the membership write
 * alone fails), `noOrgId` (a create answers with an unusable id).
 */
function installStub(options = {}) {
  const calls = [];
  const logs = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const path = new URL(url).pathname;
    calls.push({ method, url, path, body, headers: init.headers ?? {} });

    if (url.startsWith('https://api.clerk.com/')) {
      if (options.failClerk) return jsonResponse({ errors: [{ message: 'nope' }] }, 503);

      if (method === 'GET' && path === '/v1/organizations') {
        return jsonResponse({ data: options.clerkOrganisations ?? [] });
      }
      if (method === 'POST' && path === '/v1/organizations') {
        if (options.noOrgId) return jsonResponse({ id: 'not-an-org-id' });
        const id = options.createdOrgId ?? 'org_created_by_stub';
        return jsonResponse({ id, name: body?.name ?? null, slug: body?.slug ?? null });
      }
      if (/\/memberships\/[^/]+$/.test(path)) {
        if (options.failMembership) return jsonResponse({ errors: [] }, 503);
        if (method === 'PATCH') {
          return options.existingMembership === true
            ? jsonResponse({ id: 'orgmem_stub', role: body?.role })
            : jsonResponse({ errors: [{ code: 'resource_not_found' }] }, 404);
        }
        if (method === 'DELETE') {
          return options.membershipAbsent === true
            ? jsonResponse({ errors: [] }, 404)
            : jsonResponse({ deleted: true });
        }
      }
      if (method === 'POST' && /\/memberships$/.test(path)) {
        if (options.failMembership) return jsonResponse({ errors: [] }, 503);
        return jsonResponse({ id: 'orgmem_stub', role: body?.role });
      }
      return jsonResponse({ errors: [{ message: 'unhandled' }] }, 500);
    }

    if (url.startsWith('https://openrouter.ai/')) {
      mintCounter += 1;
      if (method === 'POST') {
        return jsonResponse({
          key: `sk-or-v1-stub-${mintCounter}`,
          data: { hash: `hash-${mintCounter}`, limit: body?.limit },
        });
      }
      return jsonResponse({ data: { hash: `hash-${mintCounter}`, limit: body?.limit } });
    }

    throw new Error(`unexpected outbound request: ${method} ${url}`);
  };

  // `warn` and `error` only. A stub that silenced `log` would swallow every PASS
  // line this suite prints.
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  return { calls, logs };
}

function restoreStub() {
  globalThis.fetch = realFetch;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
}

/** Calls the real router. Returns `{ status, body }`. */
async function callApi(env, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const response = await handleApiRequest(request, env, CTX, CORS);
  if (response === null) return { status: null, body: null, response: null };
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, response, text };
}

const operatorToken = () => mintToken(OPERATOR);
const route = name => `${ORG_ADMIN_PREFIX}${name}`;

// ══ 1. The operator gate, on the NEW prefix ═════════════════════════════════
//
// Requirements 13.1, 13.2. Three rules, driven against every route in the family
// rather than against one, because a per-route gate is exactly the failure a
// shared gate exists to prevent.
console.log('\nThe operator gate on the organisation family (Requirements 13.1, 13.2)');
{
  const stub = installStub();
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });

    for (const name of ORG_ADMIN_ROUTES) {
      // Rule one: an ABSENT bearer is 401, checked BEFORE `verifyRequest` - which
      // would otherwise hand an anonymous context to the allowlist check and
      // answer "you are not an operator" to somebody who never said who they were.
      const anonymous = await callApi(env, 'GET', route(name));
      check(
        `GET ${name} with no bearer is 401`,
        anonymous.status === 401 && anonymous.body?.error === ADMIN_UNAUTHORIZED_ERROR,
        `${anonymous.status} ${JSON.stringify(anonymous.body)}`,
      );

      // Rule two: a verified but NON-OPERATOR Clerk identity is 403.
      const outsider = await callApi(env, 'GET', route(name), { token: mintToken(OUTSIDER) });
      check(
        `GET ${name} for a non-operator is 403`,
        outsider.status === 403 && outsider.body?.error === ADMIN_FORBIDDEN_ERROR,
        `${outsider.status} ${JSON.stringify(outsider.body)}`,
      );

      // Rule three: a `device` credential is 403 even though it carries the same
      // `userId` the allowlist holds. A long-lived bearer in a laptop keychain
      // cannot carry operator reach.
      const desktop = await mintDeviceToken(DEVICE_SECRET, OPERATOR, Date.now() / 1000);
      const device = await callApi(env, 'GET', route(name), { token: desktop });
      check(
        `GET ${name} for an allowlisted DESKTOP token is 403, not 200`,
        device.status === 403 && device.body?.error === ADMIN_FORBIDDEN_ERROR,
        `${device.status} ${JSON.stringify(device.body)}`,
      );

      // Rule four: a missing allowlist secret grants NO access.
      const unset = await callApi(
        hostedEnv({ TENANTS: memoryKv(), TELEMETRY_ADMIN_USER_IDS: undefined }),
        'GET',
        route(name),
        { token: operatorToken() },
      );
      check(
        `GET ${name} with no allowlist secret is 403, never open`,
        unset.status === 403,
        `${unset.status} ${JSON.stringify(unset.body)}`,
      );

      // And the operational trap: a JSON-shaped allowlist fails CLOSED.
      const jsonShaped = await callApi(
        hostedEnv({ TENANTS: memoryKv(), TELEMETRY_ADMIN_USER_IDS: JSON.stringify([OPERATOR]) }),
        'GET',
        route(name),
        { token: operatorToken() },
      );
      check(
        `GET ${name} with a JSON-shaped allowlist is 403`,
        jsonShaped.status === 403,
        `${jsonShaped.status} ${JSON.stringify(jsonShaped.body)}`,
      );
    }

    // No refusal body ever names an allowlist entry, so a refusal cannot be used
    // to enumerate operators.
    const refusal = await callApi(env, 'GET', route('list'), { token: mintToken(OUTSIDER) });
    check(
      'a refusal body names no allowlist entry',
      !refusal.text.includes(OPERATOR),
      refusal.text,
    );

    // And every answer, refusal included, carries `Cache-Control: no-store`: a
    // cached 403 would outlive an allowlist change.
    check(
      'a refusal is not cacheable',
      refusal.response?.headers.get('Cache-Control') === 'no-store',
      refusal.response?.headers.get('Cache-Control'),
    );

    // An unknown route below the prefix is 404 - AFTER the gate, so the response
    // code cannot be used to learn which routes exist.
    const unknown = await callApi(env, 'GET', route('nope'), { token: mintToken(OUTSIDER) });
    check('an unknown route below the prefix is still 403 for a non-operator', unknown.status === 403);
    const known = await callApi(env, 'GET', route('nope'), { token: operatorToken() });
    check('and 404 for an operator', known.status === 404, `${known.status}`);

    check('the gate reached no vendor', stub.calls.length === 0, JSON.stringify(stub.calls));
  } finally {
    restoreStub();
  }
}

// ══ 2. Creating an organisation grants no paid tier ═════════════════════════
//
// Feature: multi-organisation-phorma, Property 30: A new organisation is never
// implicitly paid, and a member holds exactly one level (the FIRST half)
//
// Validates: Requirements 13.3, 13.4
console.log('\nCreating an organisation (Requirements 13.3, 13.4, Property 30)');
{
  const stub = installStub({ createdOrgId: 'org_fresh' });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });

    const created = await callApi(env, 'POST', route('create'), {
      token: operatorToken(),
      body: { name: 'Acme Accounting' },
    });
    check('a create answers 200', created.status === 200, JSON.stringify(created.body));
    check(
      'and reports the organisation id Clerk minted',
      created.body?.organisation?.id === 'org_fresh',
      JSON.stringify(created.body),
    );

    const row = await tenantRow('org_fresh');
    // The row must EXIST: it is the quota bucket, the usage scope and the backup
    // scope, so an organisation with no row is one nothing can resolve.
    check('one tenants row exists, keyed by the organisation Owner_Id', row !== null, JSON.stringify(row));
    check(
      'carrying no tier isKnownTier recognises',
      row?.tier === UNPAID_ORG_TIER && !isKnownTier(row.tier),
      JSON.stringify(row),
    );
    check(
      'and no active status',
      row?.status === UNPAID_ORG_STATUS && row.status !== 'active',
      JSON.stringify(row),
    );
    check(
      'and NO runtime key, in either column',
      row?.openrouter_key_id === null && row?.openrouter_key_enc === null,
      JSON.stringify(row),
    );

    // The assertion a source read cannot make: not one vendor key call happened.
    // `provisionTenantTier` reconciles only an `active` tenant, and this is what
    // proves that gate is structural rather than documentary.
    const openRouterCalls = stub.calls.filter(call => call.url.includes('openrouter.ai'));
    check(
      'and not one OpenRouter call was made',
      openRouterCalls.length === 0,
      JSON.stringify(openRouterCalls),
    );

    // Requirement 19.10 restated as data: there is no comp-credit path, and the
    // schema is what makes that true.
    const grants = await DB.prepare(
      'SELECT COUNT(*) AS n FROM credit_grants WHERE tenant_id = ?',
    )
      .bind('org_fresh')
      .first();
    check('and no credit grant', Number(grants?.n) === 0, JSON.stringify(grants));

    // Nothing reaches Stripe on this path either: an organisation is invoiced by
    // Phorma Labs.
    const stripeCalls = stub.calls.filter(call => call.url.includes('stripe.com'));
    check('and nothing reached Stripe', stripeCalls.length === 0, JSON.stringify(stripeCalls));

    // A creation is not a membership: `member.manage` is exercised by no route,
    // and creating an organisation does not quietly put somebody in it.
    check('and the organisation has no members yet', (await memberRows('org_fresh')).length === 0);

    // Validation, and a bad name reaches no vendor.
    const before = stub.calls.length;
    const blank = await callApi(env, 'POST', route('create'), {
      token: operatorToken(),
      body: { name: '   ' },
    });
    check('a blank name is 400', blank.status === 400, JSON.stringify(blank.body));
    check('and reached no vendor', stub.calls.length === before);

    const wrongMethod = await callApi(env, 'GET', route('create'), { token: operatorToken() });
    check('GET create is 405', wrongMethod.status === 405, `${wrongMethod.status}`);
  } finally {
    restoreStub();
  }
}

// ══ 3. The tier is assigned through the ONE provisioning path ══════════════
//
// Requirement 19.5 and 19.10: an organisation becomes entitled through
// provisioning alone, and raising a ceiling is a TIER change rather than a grant.
console.log('\nAssigning an organisation a tier (Requirements 13.4, 19.5, 19.10)');
{
  const stub = installStub({ createdOrgId: 'org_paid' });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });
    await callApi(env, 'POST', route('create'), {
      token: operatorToken(),
      body: { name: 'Paying Customer' },
    });

    const assigned = await callApi(env, 'POST', route('tier'), {
      token: operatorToken(),
      body: { orgId: 'org_paid', tier: 'pro' },
    });
    check('assigning a tier answers 200', assigned.status === 200, JSON.stringify(assigned.body));
    check('and reports the tier verbatim', assigned.body?.tier === 'pro', JSON.stringify(assigned.body));
    check('and the status it forced', assigned.body?.status === 'active', JSON.stringify(assigned.body));
    check(
      'and whether a runtime key landed, rather than assuming it did',
      assigned.body?.runtimeKeyProvisioned === true &&
        typeof assigned.body?.runtimeKeyAction === 'string',
      JSON.stringify(assigned.body),
    );

    const paid = await tenantRow('org_paid');
    check('the row now carries a known tier', isKnownTier(paid?.tier), JSON.stringify(paid));
    check('and is active', paid?.status === 'active', JSON.stringify(paid));
    check('and holds a runtime key', paid?.openrouter_key_enc !== null, JSON.stringify(paid));

    // Still no Stripe object of any kind, which is the half of Requirement 19
    // this route could quietly break.
    check(
      'and nothing reached Stripe',
      stub.calls.every(call => !call.url.includes('stripe.com')),
      JSON.stringify(stub.calls.map(call => call.url)),
    );
    const grants = await DB.prepare('SELECT COUNT(*) AS n FROM credit_grants').first();
    check('and no credit grant was made', Number(grants?.n) === 0, JSON.stringify(grants));

    // A raise is another tier change, and it PATCHES the existing key rather than
    // minting a second one - which is what `reconcileRuntimeKey` is for.
    const keyBefore = (await tenantRow('org_paid')).openrouter_key_id;
    const raised = await callApi(env, 'POST', route('tier'), {
      token: operatorToken(),
      body: { orgId: 'org_paid', tier: 'team' },
    });
    check('a raise is accepted', raised.status === 200, JSON.stringify(raised.body));
    check(
      'and reuses the existing key rather than minting a second',
      (await tenantRow('org_paid')).openrouter_key_id === keyBefore,
      `${keyBefore}`,
    );

    // And the tier can be taken back out of entitlement here.
    const unpaid = await callApi(env, 'POST', route('tier'), {
      token: operatorToken(),
      body: { orgId: 'org_paid', tier: UNPAID_ORG_TIER },
    });
    check('the unpaid token is assignable', unpaid.status === 200, JSON.stringify(unpaid.body));
    check(
      'and it is not an active status',
      (await tenantRow('org_paid')).status !== 'active',
      JSON.stringify(await tenantRow('org_paid')),
    );

    // A bespoke tier belongs in an operator's curl, not a select box.
    const bespoke = await callApi(env, 'POST', route('tier'), {
      token: operatorToken(),
      body: { orgId: 'org_paid', tier: 'enterprise-acme' },
    });
    check('an undeclared tier is 400', bespoke.status === 400, JSON.stringify(bespoke.body));
    check(
      'and the declared set is what the list route offers',
      assignableTiers().includes(UNPAID_ORG_TIER) && assignableTiers().includes('pro'),
      JSON.stringify(assignableTiers()),
    );

    // A user id is not an organisation id: the two are separate parameters of one
    // write, so the narrow classifier is what refuses a swapped pair.
    const swapped = await callApi(env, 'POST', route('tier'), {
      token: operatorToken(),
      body: { orgId: OPERATOR, tier: 'pro' },
    });
    check('a user id as orgId is 400', swapped.status === 400, JSON.stringify(swapped.body));
    check('and wrote no row for it', (await tenantRow(OPERATOR)) === null);
  } finally {
    restoreStub();
  }
}

// ══ 4. A member holds exactly one level ════════════════════════════════════
//
// Feature: multi-organisation-phorma, Property 30: A new organisation is never
// implicitly paid, and a member holds exactly one level (the SECOND half)
//
// Validates: Requirements 13.5, 13.6
console.log('\nMembership writes (Requirements 13.5, 13.6, 13.9, Property 30)');
{
  const stub = installStub({ existingMembership: false });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });

    const invited = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_team', userId: 'user_first', level: 'editor' },
    });
    check('an invite answers 200', invited.status === 200, JSON.stringify(invited.body));
    const rows = await memberRows('org_team');
    check('and lands exactly one row', rows.length === 1, JSON.stringify(rows));
    check('at the level asked for', rows[0]?.level === 'editor', JSON.stringify(rows));

    // The Clerk half went FIRST. A PATCH that 404s is the ordinary first-invite
    // case, so both calls are expected and in that order.
    const membershipCalls = stub.calls.filter(call => call.path.includes('/memberships'));
    check(
      'Clerk was written before the row, PATCH then POST',
      membershipCalls[0]?.method === 'PATCH' && membershipCalls[1]?.method === 'POST',
      JSON.stringify(membershipCalls.map(call => `${call.method} ${call.path}`)),
    );
    check(
      'and an editor is an org:member in Clerk, whose claim is deliberately unmapped',
      membershipCalls[1]?.body?.role === clerkRoleFor('editor') &&
        clerkRoleFor('editor') === 'org:member',
      JSON.stringify(membershipCalls[1]?.body),
    );

    // Requirement 13.9: an unrecognised level token is `role_unknown` and nothing
    // is written. The SAME token an unresolvable role answers with.
    const callsBefore = stub.calls.length;
    const junk = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_team', userId: 'user_first', level: 'superuser' },
    });
    check('an unrecognised level is 403', junk.status === 403, `${junk.status}`);
    check('with code role_unknown', junk.body?.code === 'role_unknown', JSON.stringify(junk.body));
    check('and nothing was written', stub.calls.length === callsBefore);
    check(
      'and the level on record is untouched',
      (await memberRows('org_team'))[0]?.level === 'editor',
    );

    // A swapped pair, refused by the narrow classifiers.
    const swapped = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'user_first', userId: 'org_team', level: 'editor' },
    });
    check('a swapped orgId/userId pair is 400', swapped.status === 400, JSON.stringify(swapped.body));

    // `GET members` reads the authoritative table.
    const listed = await callApi(env, 'GET', `${route('members')}?orgId=org_team`, {
      token: operatorToken(),
    });
    check('GET members answers 200', listed.status === 200, JSON.stringify(listed.body));
    check(
      'and reports the one member at the level on record',
      listed.body?.members?.length === 1 && listed.body.members[0].level === 'editor',
      JSON.stringify(listed.body),
    );
    check(
      'and carries the level vocabulary, so the dashboard declares none of its own',
      Array.isArray(listed.body?.levels) &&
        listed.body.levels.length === CAPABILITY_LEVELS.length &&
        listed.body.levels.every((token, index) => token === CAPABILITY_LEVELS[index]),
      JSON.stringify(listed.body?.levels),
    );

    const badOrg = await callApi(env, 'GET', `${route('members')}?orgId=nope`, {
      token: operatorToken(),
    });
    check('GET members with a bad orgId is 400', badOrg.status === 400, `${badOrg.status}`);

    const wrongMethod = await callApi(env, 'PUT', route('members'), { token: operatorToken() });
    check('PUT members is 405', wrongMethod.status === 405, `${wrongMethod.status}`);
  } finally {
    restoreStub();
  }
}

// ══ 5. Property 30's second half, over any sequence of writes ══════════════
//
// Feature: multi-organisation-phorma, Property 30: A new organisation is never
// implicitly paid, and a member holds exactly one level
//
// Validates: Requirements 13.4, 13.5
console.log('\nProperty 30 over sequences of invites and level changes');
{
  const levelArb = fc.constantFrom(...CAPABILITY_LEVELS);
  const userArb = fc.constantFrom('user_alpha', 'user_beta', 'user_gamma');
  const orgArb = fc.constantFrom('org_one', 'org_two');
  /** An invite or a level change, which are the same write. */
  const writeArb = fc.record({ orgId: orgArb, userId: userArb, level: levelArb });
  /** A level token outside the vocabulary: accepted by nothing, so it changes nothing. */
  const rejectedArb = fc.record({
    orgId: orgArb,
    userId: userArb,
    level: fc.constantFrom('root', 'owner', 'OPERATOR', '', 'admin '),
  });
  const stepArb = fc.oneof(
    { weight: 4, arbitrary: writeArb.map(write => ({ kind: 'accept', write })) },
    { weight: 1, arbitrary: rejectedArb.map(write => ({ kind: 'reject', write })) },
    { weight: 1, arbitrary: writeArb.map(write => ({ kind: 'remove', write })) },
  );

  await asyncProperty(
    'exactly one row per (organisation, member), carrying the last ACCEPTED write',
    () =>
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async steps => {
        const stub = installStub({ existingMembership: true });
        try {
          await resetTables();
          const env = hostedEnv({ TENANTS: memoryKv() });
          // The model: the level each pair should be on, or absent.
          const expected = new Map();

          for (const step of steps) {
            const { orgId, userId, level } = step.write;
            const key = `${orgId}|${userId}`;
            if (step.kind === 'accept') {
              const answer = await callApi(env, 'POST', route('members'), {
                token: operatorToken(),
                body: { orgId, userId, level },
              });
              if (answer.status !== 200) throw new Error(`accepted write answered ${answer.status}`);
              expected.set(key, level);
              continue;
            }
            if (step.kind === 'reject') {
              const answer = await callApi(env, 'POST', route('members'), {
                token: operatorToken(),
                body: { orgId, userId, level },
              });
              // A rejected write must be a refusal AND must change nothing.
              if (answer.status !== 403 || answer.body?.code !== 'role_unknown') {
                throw new Error(
                  `level ${JSON.stringify(level)} answered ${answer.status} ${JSON.stringify(answer.body)}`,
                );
              }
              continue;
            }
            const answer = await callApi(
              env,
              'DELETE',
              `${route('members')}?orgId=${orgId}&userId=${userId}`,
              { token: operatorToken() },
            );
            if (answer.status !== 200) throw new Error(`a removal answered ${answer.status}`);
            expected.delete(key);
          }

          const all = await DB.prepare('SELECT org_id, user_id, level FROM org_members').all();
          const actual = new Map(
            (all.results ?? []).map(row => [`${row.org_id}|${row.user_id}`, row.level]),
          );
          if (actual.size !== expected.size) {
            throw new Error(`${actual.size} row(s) for ${expected.size} live membership(s)`);
          }
          for (const [key, level] of expected) {
            if (actual.get(key) !== level) {
              throw new Error(`${key} is ${actual.get(key)}, expected ${level}`);
            }
          }
          // And no organisation became paid along the way.
          const tenants = await DB.prepare('SELECT id, tier, status FROM tenants').all();
          for (const row of tenants.results ?? []) {
            if (row.status === 'active' || isKnownTier(row.tier)) {
              throw new Error(`${row.id} became entitled through a membership write`);
            }
          }
        } finally {
          restoreStub();
        }
      }),
  );
}

// ══ 6. A demotion bites on the NEXT request ════════════════════════════════
//
// Requirement 20.11's first half, and the reason `invalidateMemberCache` exists.
// `resolveRole` caches a HIT for `TENANT_CACHE_TTL_S`, so the resolution BEFORE
// the demotion is what makes this assertion meaningful: without it the second
// resolution would be reading a cold cache and would pass for a module that
// invalidated nothing.
console.log('\nA demotion is effective on the next request (Requirement 20.11)');
{
  const stub = installStub({ existingMembership: true });
  try {
    await resetTables();
    const TENANTS = memoryKv();
    const env = hostedEnv({ TENANTS });

    await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_demote', userId: 'user_demoted', level: 'admin' },
    });

    // A DESKTOP credential, deliberately: it carries no Clerk role claim at all,
    // so its level comes from `org_members` behind the cache and nothing else.
    const desktop = await mintDeviceToken(DEVICE_SECRET, 'user_demoted', Date.now() / 1000);
    const device = await verifyBearer(hostedEnv(), desktop);
    const named = { ...device, orgId: 'org_demote', ownerId: 'org_demote' };

    const first = await resolveRole(env, named);
    check('the member resolves admin', first.level === 'admin', JSON.stringify(first));
    const cacheKey = orgMemberCacheKey('org_demote', 'user_demoted');
    check('and the hit is cached', TENANTS.entries.has(cacheKey), [...TENANTS.entries.keys()].join());
    check(
      'with the TTL the tenant cache uses, which is KV\'s floor',
      TENANTS.puts.at(-1)?.options?.expirationTtl === TENANT_CACHE_TTL_S &&
        TENANT_CACHE_TTL_S === 60,
      JSON.stringify(TENANTS.puts.at(-1)),
    );

    const demotedAt = TENANTS.deletes.length;
    const demote = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_demote', userId: 'user_demoted', level: 'operator' },
    });
    check('the demotion is accepted', demote.status === 200, JSON.stringify(demote.body));
    check(
      'and the membership key was invalidated IMMEDIATELY',
      TENANTS.deletes.slice(demotedAt).includes(cacheKey),
      JSON.stringify(TENANTS.deletes),
    );
    check('so nothing is cached under it', !TENANTS.entries.has(cacheKey));

    const second = await resolveRole(env, named);
    check(
      'the NEXT request resolves the new level, not the cached one',
      second.level === 'operator',
      JSON.stringify(second),
    );

    // The Clerk role moved too. Without this the claim would short-circuit an
    // `admin` answer for a member the table says is an operator - a demotion in
    // name only, with a correct-looking row to prove it happened.
    const demoteCall = stub.calls.filter(call => call.path.includes('/memberships')).at(-1);
    check(
      'and the Clerk role moved off org:admin, so no claim can short-circuit it',
      demoteCall?.body?.role === 'org:member',
      JSON.stringify(demoteCall?.body),
    );
  } finally {
    restoreStub();
  }
}

// ══ 7. A REMOVAL bites on the next request, with no refusal ════════════════
//
// Requirement 20.11's second half, and the stronger of the two. The claim is not
// "the level changed" - it is that the same request which resolved the
// organisation a moment ago resolves the caller's OWN owner instead, with no
// refusal and a response indistinguishable from the same request without the
// header. That indistinguishability is what keeps the header from being a probe
// for which organisations exist.
console.log('\nA removal is effective on the next request, with no refusal (Requirement 20.11)');
{
  const stub = installStub({ existingMembership: true });
  try {
    await resetTables();
    const TENANTS = memoryKv();
    const env = hostedEnv({ TENANTS });

    await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_removal', userId: 'user_removed', level: 'builder' },
    });

    const desktop = await mintDeviceToken(DEVICE_SECRET, 'user_removed', Date.now() / 1000);
    const device = await verifyBearer(hostedEnv(), desktop);
    const namedRequest = new Request(`${ORIGIN}/api/me`, {
      headers: { [REQUESTED_OWNER_HEADER]: 'org_removal' },
    });
    const bareRequest = new Request(`${ORIGIN}/api/me`);

    const before = await resolveRequestedOwner(env, device, namedRequest);
    check('the member addresses the organisation', before === 'org_removal', String(before));
    const cacheKey = orgMemberCacheKey('org_removal', 'user_removed');
    check('and the membership is now cached', TENANTS.entries.has(cacheKey));

    const removedAt = TENANTS.deletes.length;
    const removal = await callApi(
      env,
      'DELETE',
      `${route('members')}?orgId=org_removal&userId=user_removed`,
      { token: operatorToken() },
    );
    check('the removal is accepted', removal.status === 200, JSON.stringify(removal.body));
    check('and reports no level on record', removal.body?.level === null, JSON.stringify(removal.body));
    check(
      'and the membership key was invalidated IMMEDIATELY',
      TENANTS.deletes.slice(removedAt).includes(cacheKey),
      JSON.stringify(TENANTS.deletes),
    );

    check('the row is gone', (await memberRows('org_removal')).length === 0);
    const after = await resolveRequestedOwner(env, device, namedRequest);
    check(
      'the SAME request now resolves the caller\'s own owner',
      after === 'user_removed',
      String(after),
    );
    const bare = await resolveRequestedOwner(env, device, bareRequest);
    check(
      'indistinguishable from the same request with no header at all',
      after === bare,
      `${after} vs ${bare}`,
    );

    // And a miss is never cached, so a RE-grant works at once with no
    // invalidation of its own.
    check('and the miss was not cached', !TENANTS.entries.has(cacheKey));
    await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_removal', userId: 'user_removed', level: 'operator' },
    });
    check(
      'a re-grant is effective at once',
      (await resolveRequestedOwner(env, device, namedRequest)) === 'org_removal',
    );

    // Removing somebody who is not there is a success, which is what makes a
    // retry after a partial failure converge instead of refusing forever.
    const absentStub = stub;
    void absentStub;
    const repeat = await callApi(
      env,
      'DELETE',
      `${route('members')}?orgId=org_removal&userId=user_never_joined`,
      { token: operatorToken() },
    );
    check('removing a non-member is a success', repeat.status === 200, JSON.stringify(repeat.body));
  } finally {
    restoreStub();
  }
}

// ══ 8. Clerk first, and a partial failure is REPORTED ══════════════════════
//
// One half existing without the other is the state an operator most needs to see,
// and the one no later request can discover for itself - so it is a reported
// refusal rather than a log line.
console.log('\nOrdering and partial failures');
{
  // 8a. The Clerk write fails: NOTHING is written, and the code says so.
  const failing = installStub({ failMembership: true });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });
    const refused = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_partial', userId: 'user_partial', level: 'builder' },
    });
    check('a failed Clerk write is 502', refused.status === 502, `${refused.status}`);
    check(
      'with code org_clerk_failed',
      refused.body?.code === 'org_clerk_failed',
      JSON.stringify(refused.body),
    );
    check(
      'and OUR sentence, never the vendor body',
      refused.body?.error === CLERK_UNAVAILABLE_ERROR && !refused.text.includes('nope'),
      refused.text,
    );
    check('and no row was written', (await memberRows('org_partial')).length === 0);
    check(
      'and the vendor failure is in the log rather than the response',
      failing.logs.some(line => line.includes('Clerk')),
      failing.logs.join(' | '),
    );
  } finally {
    restoreStub();
  }

  // 8b. Clerk lands and the row does not: PARTIAL, and reported as such.
  const partial = installStub({ existingMembership: true });
  try {
    await resetTables();
    const TENANTS = memoryKv();
    // A `DB` whose write throws, and only the membership write: everything the
    // gate and the read paths need still works, so the failure is isolated to the
    // second half of one write.
    const brokenDb = {
      ...DB,
      prepare: sql => {
        if (sql.includes('INSERT INTO org_members')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('d1 write refused');
              },
            }),
          };
        }
        return DB.prepare(sql);
      },
      batch: statements => DB.batch(statements),
    };
    const env = hostedEnv({ TENANTS, DB: brokenDb });

    const reported = await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_half', userId: 'user_half', level: 'builder' },
    });
    check('a half-applied write is 502', reported.status === 502, `${reported.status}`);
    check(
      'with code org_partial_write',
      reported.body?.code === 'org_partial_write',
      JSON.stringify(reported.body),
    );
    check(
      'and copy that says the two now disagree and a retry is safe',
      reported.body?.error === PARTIAL_WRITE_ERROR,
      JSON.stringify(reported.body),
    );
    check(
      'and the cache was invalidated anyway, because the row MAY have changed',
      TENANTS.deletes.includes(orgMemberCacheKey('org_half', 'user_half')),
      JSON.stringify(TENANTS.deletes),
    );
    check('and it was reported rather than only logged', reported.status !== 200);
    // The ORDER, measured rather than read: the row write is the half that failed
    // here, so a Clerk membership call having happened at all is what proves Clerk
    // goes first. An implementation that wrote the row first would refuse before
    // reaching the vendor, and this would see no call.
    check(
      'and the Clerk half ran BEFORE the row write that failed',
      partial.calls.some(call => call.path.includes('/memberships')),
      JSON.stringify(partial.calls.map(call => `${call.method} ${call.path}`)),
    );
  } finally {
    restoreStub();
  }

  // 8c. A create whose Clerk id is unusable is a partial too: the organisation
  // exists and cannot be addressed, so it must never read as a success.
  const unusable = installStub({ noOrgId: true });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });
    const answer = await callApi(env, 'POST', route('create'), {
      token: operatorToken(),
      body: { name: 'Unusable Id' },
    });
    check('an unusable organisation id is 502', answer.status === 502, `${answer.status}`);
    check(
      'with code org_partial_write',
      answer.body?.code === 'org_partial_write',
      JSON.stringify(answer.body),
    );
    const rows = await DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
    check('and no tenants row was created under a bad key', Number(rows?.n) === 0);
  } finally {
    restoreStub();
  }
}

// ══ 9. GET list: authoritative membership, degraded names ══════════════════
console.log('\nGET list (Requirement 13.6)');
{
  const stub = installStub({
    existingMembership: true,
    clerkOrganisations: [
      { id: 'org_named', name: 'Named Co', slug: 'named-co' },
      { id: 'org_clerk_only', name: 'Half Created', slug: null },
    ],
  });
  try {
    await resetTables();
    const env = hostedEnv({ TENANTS: memoryKv() });
    await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_named', userId: 'user_one', level: 'operator' },
    });
    await callApi(env, 'POST', route('members'), {
      token: operatorToken(),
      body: { orgId: 'org_named', userId: 'user_two', level: 'builder' },
    });

    const listed = await callApi(env, 'GET', route('list'), { token: operatorToken() });
    check('list answers 200', listed.status === 200, JSON.stringify(listed.body));
    const byId = new Map((listed.body?.organisations ?? []).map(org => [org.id, org]));
    check(
      'an organisation with members is listed with its authoritative count',
      byId.get('org_named')?.members === 2,
      JSON.stringify(byId.get('org_named')),
    );
    check(
      'and its Clerk name',
      byId.get('org_named')?.name === 'Named Co',
      JSON.stringify(byId.get('org_named')),
    );
    check(
      'a Clerk organisation with no tenants row reads as unprovisioned, never as cancelled',
      byId.get('org_clerk_only')?.status === 'unprovisioned',
      JSON.stringify(byId.get('org_clerk_only')),
    );
    check(
      'the vocabulary travels with the list, so the dashboard declares none',
      listed.body?.levels?.length === CAPABILITY_LEVELS.length &&
        Array.isArray(listed.body?.tiers),
      JSON.stringify({ levels: listed.body?.levels, tiers: listed.body?.tiers }),
    );
    check('and nothing is degraded', listed.body?.degraded?.length === 0, JSON.stringify(listed.body?.degraded));
    void stub;
  } finally {
    restoreStub();
  }

  // A failed Clerk read is DEGRADED, not fatal: membership is still authoritative,
  // and blanking the page during a vendor outage takes away the surface an
  // operator opened it for.
  const broken = installStub({ failClerk: true });
  try {
    await DB.batch([
      DB.prepare('DELETE FROM org_members'),
      DB.prepare(
        `INSERT INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
         VALUES ('org_degraded', 'user_x', 'editor', 'operator', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`,
      ),
    ]);
    const env = hostedEnv({ TENANTS: memoryKv() });
    const listed = await callApi(env, 'GET', route('list'), { token: operatorToken() });
    check('a failed Clerk read still answers 200', listed.status === 200, `${listed.status}`);
    check('naming the half that failed', listed.body?.degraded?.includes('clerk'), JSON.stringify(listed.body?.degraded));
    const org = (listed.body?.organisations ?? []).find(row => row.id === 'org_degraded');
    check('the membership is still reported', org?.members === 1, JSON.stringify(org));
    check('with a NULL name, which is not an empty name', org?.name === null, JSON.stringify(org));
    void broken;
  } finally {
    restoreStub();
  }
}

// ══ 10. A BYO worker sees the family as unavailable, not broken ════════════
console.log('\nA worker with no hosted D1 binding');
{
  const stub = installStub();
  try {
    const env = hostedEnv({ TENANTS: memoryKv(), DB: undefined });
    const answer = await callApi(env, 'GET', route('list'), { token: operatorToken() });
    check(
      'an absent DB is 501 naming the binding, not an empty list',
      answer.status === 501,
      `${answer.status} ${JSON.stringify(answer.body)}`,
    );
    check('and reached no vendor', stub.calls.length === 0, JSON.stringify(stub.calls));
  } finally {
    restoreStub();
  }
}

// --- Summary ---------------------------------------------------------------

if (failures > 0) {
  realConsole.error(`\n${failures} org-admin check(s) FAILED.`);
  process.exit(1);
}
realConsole.log('\nAll org-admin checks passed.');
await mf.dispose();
