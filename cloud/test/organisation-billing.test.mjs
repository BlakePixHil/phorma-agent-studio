/**
 * A personal owner and an organisation owner never share a billing fact
 * (`.kiro/specs/multi-organisation-phorma/`, task 15, Requirement 19).
 *
 * Feature: multi-organisation-phorma, Property 39: A personal owner and an
 * organisation owner never share a billing fact.
 *
 * ## What this suite is for, and what it deliberately is not
 *
 * `organisation-metering.test.mjs` already proves that a member's RUN moves the
 * organisation's meter. This suite is about the other half of the same wall: the
 * BILLING facts - tier, status, Stripe customer, subscription, credit grants,
 * quota rollup and runtime key - and the claim that no sequence of writes makes one
 * owner's fact observable as the other's, in either direction.
 *
 * Four things here cannot be seen anywhere else:
 *
 * 1. **An organisation reaches an entitled state with NO Stripe object at all**
 *    (Requirements 19.5, 19.11). Provisioning is the whole mechanism, and the
 *    assertion that matters is the ABSENCE of the outbound call - a worker that
 *    quietly created a Customer for every provisioned organisation would pass every
 *    status assertion.
 * 2. **Self-serve billing refuses an organisation owner with nothing created**
 *    (Requirement 19.4). Asserted here as well as in `billing-routes.test.mjs`
 *    because here it sits INSIDE the sequence: a refusal that still wrote a row
 *    would be visible as a shared fact rather than merely as a 403.
 * 3. **`credit_grants` keeps its payment-keyed uniqueness** (Requirement 19.10).
 *    Every grant row in the database is checked for a `stripe_payment_id`, and a
 *    grant WITHOUT one is attempted and must be rejected by the schema. That is the
 *    guard against a comp-credit path being added for organisations later: the
 *    higher ceiling an organisation needs is a TIER change, not a free grant.
 * 4. **The claim path's excluded tables are a CLOSED list** (Requirement 19.2),
 *    asserted against the source of `ownership-claim.ts`. The claim is the only
 *    path in the worker that moves rows across owners, and it needs a Durable
 *    Object to drive - `ownership-claim.test.mjs` owns that. What is checkable here,
 *    cheaply and without a DO, is that its transfer statements name `workflow_backups`
 *    and `usage` and NOTHING else, so a fifth table cannot join the batch unnoticed.
 *
 * ## Harness
 *
 * A REAL local D1 (Miniflare's SQLite binding reached from Node with the real
 * migrations applied) and the REAL router: `handleApiRequest` is imported and
 * called, so `verifyRequest`, `refuseManagedBilling`, `requireCapability`, the
 * Stripe webhook's signature check and `resolveHostedInference` are all genuinely in
 * the path. Session tokens are locally minted RS256, verified by `@clerk/backend`'s
 * offline path against `CLERK_JWT_KEY`, so authorization is never stubbed. Stripe
 * and OpenRouter are the only things replaced, and every outbound attempt is
 * captured - the captures are what several assertions below are ABOUT.
 *
 * The property drives `resolveHostedInference` and `recordRun` directly rather than
 * `/api/infer`, deliberately: which owner a ROUTE meters is
 * `organisation-metering.test.mjs`'s subject and is measured there against the real
 * router, while the subject here is whether a billing fact crosses between two
 * owners. A route round trip per step would spend thousands of loopback sockets to
 * re-measure a different claim.
 *
 * `0006` is applied because `org_members` is what `resolveRole` reads for a member
 * whose Clerk role claim is unmapped, and `0006`'s one ALTER is against
 * `workflow_backups`.
 *
 * Run: npx tsx cloud/test/organisation-billing.test.mjs
 */

import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected to the
// same stub the other route suites use, before the module graph loads.
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
const { TenantStore, resolveHostedInference, tierLimits } = await import('../src/tenants.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Money comparison: every figure is a REAL column summed by SQLite. */
const near = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) < epsilon;

function assertThat(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The counterexample fast-check reports, flattened onto one line.
 *
 * The WHOLE message, not a slice: the failing assertion's own sentence is what says
 * which billing fact crossed, and fast-check prints it after the shrink summary.
 */
function describeFailure(error) {
  return String(error?.message ?? error).split(/\r?\n/).filter(Boolean).join(' | ');
}

// --- Local D1 with the real migrations -------------------------------------

/**
 * Splits a migration into statements (the files carry no string literals).
 * Split on `/\r?\n/`, never `'\n'`: a CRLF checkout leaves each line ending in
 * `\r`, the `--` stripper then matches nothing, and the comment-only tail of a
 * migration reaches D1 as "SQL code did not contain a statement".
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

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-org-billing' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

for (const file of [
  '0001_init.sql',
  '0003_billing.sql',
  '0004_billing_ordering.sql',
  '0005_workflow_backups.sql',
  '0006_organisations.sql',
]) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

// A 32-byte base64 secret, so a stored runtime key actually decrypts - without it
// every tenant refuses with `no_runtime_key` and no entitlement assertion below is
// reachable.
const KEY_ENC_SECRET = Buffer.alloc(32, 9).toString('base64');
const RUNTIME_KEY_PREFIX = 'sk-or-v1-';
const WEBHOOK_SECRET = 'whsec_org_billing_do_not_leak';
const STRIPE_SECRET_KEY = 'sk_test_org_billing_do_not_leak';
const ADMIN_TOKEN = 'admin-token-not-a-billing-credential';
const PROVISIONING_KEY = 'or-provisioning-key';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

const store = new TenantStore({ DB, KEY_ENC_SECRET });
const month = new Date().toISOString().slice(0, 7);

// --- The vendor stub -------------------------------------------------------
//
// Stripe AND OpenRouter, in one place, because the thing several assertions below
// are about is which HOST was reached at all. A call to an unexpected host throws
// rather than being served, so a new outbound call cannot pass silently.

const realFetch = globalThis.fetch;
const realConsoleWarn = console.warn;
const realConsoleError = console.error;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STARTER_PRICE = {
  id: 'price_starter_monthly',
  active: true,
  type: 'recurring',
  lookup_key: 'phorma_starter_monthly',
  currency: 'usd',
  unit_amount: 2000,
  tax_behavior: 'inclusive',
  recurring: { interval: 'month' },
  metadata: { tier: 'starter' },
};
const PRO_PRICE = {
  ...STARTER_PRICE,
  id: 'price_pro_monthly',
  lookup_key: 'phorma_pro_monthly',
  unit_amount: 6000,
  metadata: { tier: 'pro' },
};
const TOPUP_PRICE = {
  id: 'price_topup_small',
  active: true,
  type: 'one_time',
  lookup_key: 'phorma_topup_small',
  currency: 'usd',
  unit_amount: 1000,
  tax_behavior: 'inclusive',
  metadata: { credits: '500' },
};

/** Checkout session line items the stub serves, by session id. */
const LINE_ITEMS = {};

/** Makes every minted runtime key distinct. See the OpenRouter branch below. */
let mintCounter = 0;

/**
 * Installs the vendor stub and captures every call plus every log line.
 *
 * `console.log` is deliberately LEFT ALONE - `check` writes through it, and a stub
 * that silenced it would swallow every PASS line inside the block and make a broken
 * section look like an empty one. Only `warn` and `error` are captured, which is
 * where the worker's expected refusal noise goes.
 */
function vendorStub() {
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  console.warn = capture;
  console.error = capture;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({
      host: url.host,
      path: url.pathname,
      method: init.method ?? 'GET',
      query: Object.fromEntries(url.searchParams),
      params: Object.fromEntries(new URLSearchParams(body)),
      headers: init.headers ?? {},
    });

    if (url.host === 'openrouter.ai') {
      // A DISTINCT key and hash per mint, which is load-bearing rather than tidy:
      // one canned hash would make the two owners' runtime keys compare equal and
      // the "two keys, never one" assertion vacuously true.
      if (init.method === 'POST') {
        mintCounter += 1;
        return jsonResponse({
          key: `${RUNTIME_KEY_PREFIX}minted-${mintCounter}`,
          data: { hash: `hash-minted-${mintCounter}` },
        });
      }
      return jsonResponse({ data: { disabled: true } });
    }
    if (url.host !== 'api.stripe.com') {
      throw new Error(`unexpected outbound call to ${url.host}${url.pathname}`);
    }

    const lineItems = /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/.exec(url.pathname);
    if (lineItems) return jsonResponse({ data: LINE_ITEMS[lineItems[1]] ?? [] });

    // Customer ids here are `cus_{tenantId}` by construction, so the stub can stamp
    // the metadata the webhook's path 2 reads without a registry. That path is the
    // one a subscription event takes, since a subscription object carries a customer
    // ID and no `client_reference_id`.
    const customer = /^\/v1\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(url.pathname);
    if (customer) {
      return jsonResponse({
        id: customer[1],
        object: 'customer',
        metadata: { clerk_user_id: customer[1].slice('cus_'.length) },
      });
    }

    switch (url.pathname) {
      case '/v1/prices': {
        const key = url.searchParams.get('lookup_keys[0]');
        const price = { phorma_starter_monthly: STARTER_PRICE, phorma_pro_monthly: PRO_PRICE, phorma_topup_small: TOPUP_PRICE }[key];
        return jsonResponse({ data: price ? [price] : [] });
      }
      case '/v1/customers/search':
        return jsonResponse({ data: [] });
      case '/v1/customers':
        return jsonResponse({ id: 'cus_created', metadata: {} });
      case '/v1/checkout/sessions':
        return jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      case '/v1/billing_portal/sessions':
        return jsonResponse({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' });
      default:
        throw new Error(`unexpected Stripe path ${url.pathname}`);
    }
  };

  return {
    calls,
    logs,
    stripeCalls: () => calls.filter((call) => call.host === 'api.stripe.com'),
    restore: () => {
      globalThis.fetch = realFetch;
      console.warn = realConsoleWarn;
      console.error = realConsoleError;
    },
  };
}

// --- Credentials -----------------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** A real RS256 session token, with whatever organisation claims a case needs. */
function mintToken(sub, claims = {}) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'phorma-org-billing-test' })}.${enc({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// No `TENANTS` binding, deliberately: every tenant read and every `org_members`
// read goes to D1, so a tier or a level can never be served from a cache an
// earlier assertion warmed.
const env = {
  PHORMA_MODE: 'hosted',
  CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
  CLERK_JWT_KEY,
  PHORMA_ADMIN_TOKEN: ADMIN_TOKEN,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
  KEY_ENC_SECRET,
  DB,
};

// --- Driving the routes ----------------------------------------------------

/** One `/api/*` request through the real router. */
async function api(path, { method = 'POST', body, token, claims, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const authorization = bearer ?? (token ? `Bearer ${mintToken(token, claims)}` : null);
  if (authorization) headers.Authorization = authorization;
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    CORS,
    CTX,
  );
  return {
    status: response?.status ?? 0,
    body: response ? await response.json().catch(() => null) : null,
  };
}

/** `POST /api/provision` - the Super_Admin path, and the ONLY way an org is entitled. */
function provision(tenantId, tier) {
  return api('/api/provision', {
    body: { tenantId, email: `billing@${tenantId}.example.com`, tier },
    bearer: `Bearer ${ADMIN_TOKEN}`,
  });
}

let eventCounter = 0;

/**
 * One SIGNED Stripe delivery through the real router.
 *
 * `created` ADVANCES with the counter rather than reading the clock, and that is a
 * correctness fix rather than a convenience. `upsertTenant` gates the tier on
 * `billing_tier_at`, refusing a tier whose clock is not STRICTLY newer than the one
 * on record - which is exactly what keeps a stale redelivery from censoring a newer
 * event. Two deliveries that read `Date.now()` in the same wall-clock second carry
 * the SAME `created`, so the second one's tier was refused and the property's
 * last-write-wins oracle failed, intermittently, on nothing but timing. A real
 * sequence of Stripe events carries distinct `created` values; this makes the
 * harness say so.
 *
 * The signature timestamp still reads the real clock, because the webhook checks
 * that one for freshness.
 */
async function deliver(type, object) {
  eventCounter += 1;
  const event = {
    id: `evt_org_billing_${eventCounter}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000) + eventCounter,
    data: { object },
  };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
      body: raw,
    }),
    env,
    CORS,
    CTX,
  );
  return {
    status: response?.status ?? 0,
    body: response ? await response.json().catch(() => null) : null,
  };
}

/** A subscription event naming `tenantId` through its customer metadata. */
function subscriptionFor(tenantId, { price = PRO_PRICE, status = 'active', customer } = {}) {
  return {
    id: `sub_${tenantId}`,
    object: 'subscription',
    customer: customer ?? `cus_${tenantId}`,
    status,
    metadata: { clerk_user_id: tenantId },
    items: { object: 'list', data: [{ id: `si_${tenantId}`, quantity: 1, price }] },
  };
}

/** A completed credit-pack checkout for `tenantId`. */
function topUpFor(tenantId, paymentId) {
  const sessionId = `cs_${paymentId}`;
  LINE_ITEMS[sessionId] = [{ price: TOPUP_PRICE, quantity: 1 }];
  return {
    id: sessionId,
    object: 'checkout_session',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: paymentId,
    customer: `cus_${tenantId}`,
    client_reference_id: tenantId,
    metadata: { clerk_user_id: tenantId },
  };
}

// --- Reading a billing fact ------------------------------------------------

/**
 * EVERY billing fact of one owner, in one statement.
 *
 * One read rather than six, because each proxied statement is a loopback socket and
 * the property below reads two owners per step. The shape is what Property 39 is
 * stated over: tier, status, Stripe customer, subscription, grant rows, quota
 * rollup and runtime key.
 */
async function billingFactsOf(ownerId) {
  const row = await DB.prepare(
    `SELECT
       (SELECT tier FROM tenants WHERE id = ?) AS tier,
       (SELECT status FROM tenants WHERE id = ?) AS status,
       (SELECT stripe_customer_id FROM tenants WHERE id = ?) AS customer,
       (SELECT stripe_subscription_id FROM tenants WHERE id = ?) AS subscription,
       (SELECT openrouter_key_id FROM tenants WHERE id = ?) AS key_id,
       (SELECT COUNT(*) FROM credit_grants WHERE tenant_id = ?) AS grants,
       (SELECT COALESCE(SUM(credits), 0) FROM credit_grants WHERE tenant_id = ?) AS granted_credits,
       (SELECT COALESCE(cost_usd_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?)
         AS cost_usd_used,
       (SELECT COUNT(*) FROM usage WHERE tenant_id = ?) AS ledger_rows`,
  )
    .bind(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, month, ownerId)
    .first();
  return {
    tier: row?.tier ?? null,
    status: row?.status ?? null,
    customer: row?.customer ?? null,
    subscription: row?.subscription ?? null,
    keyId: row?.key_id ?? null,
    grants: Number(row?.grants ?? 0),
    grantedCredits: Number(row?.granted_credits ?? 0),
    costUsdUsed: Number(row?.cost_usd_used ?? 0),
    ledgerRows: Number(row?.ledger_rows ?? 0),
  };
}

// ══ 1. An organisation is entitled with NO Stripe object ════════════════════
//
// Requirements 19.5 and 19.11. Provisioning writes the tier verbatim and forces
// `active`, exactly as it already does for the sales-led enterprise tier, and the
// assertion that carries the requirement is that Stripe was never reached - not
// that the status came out right.

console.log('\nAn organisation reaches an entitled state with no Stripe object (Requirements 19.5, 19.11)');
{
  const ORG = 'org_entitled_no_stripe';
  const MEMBER = 'user_entitled_member';
  const stub = vendorStub();
  try {
    const provisioned = await provision(ORG, 'pro');
    check('provisioning accepts an organisation id', provisioned.status === 200, JSON.stringify(provisioned.body));

    const facts = await billingFactsOf(ORG);
    check('the tier is written verbatim', facts.tier === 'pro', JSON.stringify(facts));
    check('and the status is forced active', facts.status === 'active', JSON.stringify(facts));
    // The requirement, stated as the absence it actually is.
    check('no Stripe customer exists for it', facts.customer === null, JSON.stringify(facts));
    check('no Stripe subscription exists for it', facts.subscription === null, JSON.stringify(facts));
    check('no credit grant exists for it', facts.grants === 0, JSON.stringify(facts));
    check('it holds a runtime key all the same', typeof facts.keyId === 'string' && facts.keyId.length > 0, JSON.stringify(facts));
    check(
      'and NOT ONE Stripe call was made to get there',
      stub.stripeCalls().length === 0,
      JSON.stringify(stub.stripeCalls().map((call) => `${call.method} ${call.path}`)),
    );
    // The runtime key IS minted - an organisation with no key would be entitled and
    // unable to run, which is the same dead end as no plan at all.
    check(
      'the only vendor reached was OpenRouter, for the runtime key',
      stub.calls.every((call) => call.host === 'openrouter.ai'),
      JSON.stringify(stub.calls.map((call) => call.host)),
    );

    // And it is genuinely entitled: the gate resolves the ORGANISATION's row.
    const at = new Date().toISOString();
    await DB.batch([
      DB.prepare(
        `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
         VALUES (?, ?, 'admin', ?, ?)`,
      ).bind(ORG, MEMBER, at, at),
    ]);
    const gate = await resolveHostedInference(store, ORG);
    check('the entitlement gate allows it', !('status' in gate), JSON.stringify(gate));
    check('against the organisation row', gate.tenant?.id === ORG && gate.tenant?.tier === 'pro', JSON.stringify(gate.tenant));
  } finally {
    stub.restore();
  }
}

// ══ 2. A tier change is the higher ceiling, never a free grant ══════════════
//
// Requirement 19.10. The schema is the enforcement: `credit_grants.stripe_payment_id`
// is `NOT NULL UNIQUE`, which is what keys a grant on the PAYMENT and makes it
// idempotent. A comp-credit path for organisations would have to weaken that, so a
// grant with no payment id is attempted here and MUST be refused by D1.

console.log('\nA higher ceiling is a tier change; no grant exists without a Stripe payment (Requirement 19.10)');
{
  const ORG = 'org_ceiling';
  const stub = vendorStub();
  try {
    await provision(ORG, 'starter');
    const starter = await billingFactsOf(ORG);
    check('the organisation starts on starter', starter.tier === 'starter', JSON.stringify(starter));

    // The supported way to raise the ceiling: one more provisioning write. It patches
    // the EXISTING key's limit rather than minting a second one.
    const upgraded = await provision(ORG, 'team');
    check('a tier change is accepted', upgraded.status === 200, JSON.stringify(upgraded.body));
    const after = await billingFactsOf(ORG);
    check('the tier moved', after.tier === 'team', JSON.stringify(after));
    check('the runtime key was reused rather than replaced', after.keyId === starter.keyId, `${starter.keyId} -> ${after.keyId}`);
    check('and still no grant, no customer, no subscription', after.grants === 0 && after.customer === null && after.subscription === null, JSON.stringify(after));
    // The point of a tier change being the mechanism: the ceiling actually moves,
    // and it moves on the key OpenRouter enforces rather than only in our own row.
    const limits = tierLimits('team');
    check('the team allowance is genuinely higher than starter', limits.monthlyCostUsd > tierLimits('starter').monthlyCostUsd, JSON.stringify(limits));
    const patched = stub.calls.filter((call) => call.host === 'openrouter.ai' && call.method === 'PATCH');
    check(
      "the existing key's limit was PATCHED rather than a second key minted",
      patched.length >= 1,
      JSON.stringify(stub.calls.map((call) => `${call.method} ${call.host}${call.path}`)),
    );
    check(
      'and no Stripe call was involved in raising the ceiling',
      stub.stripeCalls().length === 0,
      JSON.stringify(stub.stripeCalls().map((call) => call.path)),
    );
  } finally {
    stub.restore();
  }

  // The schema guard. A NULL payment id must be REFUSED, not stored - that is what
  // makes "no credit grant without a Stripe payment" a fact about the database
  // rather than a convention in a handler.
  let refused = false;
  try {
    await DB.prepare(
      `INSERT INTO credit_grants (tenant_id, stripe_payment_id, credits, cost_usd, created_at)
       VALUES (?, NULL, 500, 2.0, ?)`,
    )
      .bind(ORG, new Date().toISOString())
      .run();
  } catch {
    refused = true;
  }
  check('a grant with no stripe_payment_id is refused by the schema', refused);
  const clean = await billingFactsOf(ORG);
  check('so nothing landed', clean.grants === 0, JSON.stringify(clean));

  // Every grant row that DOES exist carries one. Asserted over the whole table, so
  // a later comp-credit path anywhere in the worker fails here.
  const orphan = await DB.prepare(
    `SELECT COUNT(*) AS n FROM credit_grants WHERE stripe_payment_id IS NULL OR stripe_payment_id = ''`,
  ).first();
  check('no grant anywhere in the database lacks a payment id', Number(orphan?.n ?? 0) === 0, JSON.stringify(orphan));
}

// ══ 3. Self-serve billing refuses an organisation, and writes nothing ═══════
//
// Requirement 19.4, inside the sequence rather than on its own: the 403 is asserted
// in `billing-routes.test.mjs`, and what is added here is that the refusal leaves
// both owners' billing facts byte-identical.

console.log('\nSelf-serve billing refuses an organisation owner and changes nothing (Requirement 19.4)');
{
  const ORG = 'org_refused_checkout';
  const MEMBER = 'user_refused_admin';
  // The stub goes up FIRST: `/api/provision` mints a runtime key, so any setup
  // outside it would reach the real OpenRouter.
  const stub = vendorStub();
  try {
    await provision(ORG, 'starter');
    const at = new Date().toISOString();
    await DB.batch([
      DB.prepare(
        `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
         VALUES (?, ?, 'admin', ?, ?)`,
      ).bind(ORG, MEMBER, at, at),
    ]);
    await store.upsertTenant({ id: MEMBER, email: `${MEMBER}@example.com`, tier: 'starter', status: 'active' });

    const beforeOrg = await billingFactsOf(ORG);
    const beforeMember = await billingFactsOf(MEMBER);
    const stripeBefore = stub.stripeCalls().length;

    for (const path of ['/api/checkout', '/api/billing-portal']) {
      const answer = await api(path, {
        body: { lookupKey: 'phorma_starter_monthly' },
        token: MEMBER,
        claims: { org_id: ORG, org_role: 'org:admin' },
      });
      check(`${path} answers 403 billing_managed`, answer.status === 403 && answer.body?.code === 'billing_managed', `${answer.status} ${JSON.stringify(answer.body)}`);
    }
    check(
      'no Stripe object was created for either owner',
      stub.stripeCalls().length === stripeBefore,
      JSON.stringify(stub.stripeCalls().map((call) => `${call.method} ${call.path}`)),
    );

    check(
      "the organisation's billing facts are byte-identical",
      JSON.stringify(await billingFactsOf(ORG)) === JSON.stringify(beforeOrg),
      JSON.stringify([beforeOrg, await billingFactsOf(ORG)]),
    );
    check(
      "and so are the admin's own",
      JSON.stringify(await billingFactsOf(MEMBER)) === JSON.stringify(beforeMember),
      JSON.stringify([beforeMember, await billingFactsOf(MEMBER)]),
    );
  } finally {
    stub.restore();
  }
}

// ══ 4. The claim path's excluded tables are a CLOSED list ═══════════════════
//
// Requirement 19.2. The claim is the only path in the worker that moves rows across
// owners. Driving it needs a Durable Object, which `ownership-claim.test.mjs` owns;
// what is checkable here is the statement text, which is what would change if a
// fifth table joined the batch.

console.log('\nThe ownership claim moves the workflow and no billing fact (Requirement 19.2)');
{
  const source = readFileSync(join(here, '..', 'src', 'ownership-claim.ts'), 'utf8');
  // Comments carry these names on purpose (the exclusion is documented in place), so
  // the scan is over CODE with the comments stripped.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const updated = [...code.matchAll(/UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);

  check(
    'it updates workflow_backups and usage and nothing else',
    updated.length > 0 && updated.every((table) => table === 'workflow_backups' || table === 'usage'),
    JSON.stringify(updated),
  );
  for (const forbidden of ['tenants', 'credit_grants', 'quotas', 'stripe_events']) {
    check(
      `it never writes ${forbidden}`,
      !new RegExp(`(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)[^;]*\\b${forbidden}\\b`, 'i').test(code),
      forbidden,
    );
  }
  check(
    'and it never mentions stripe_customer_id in a statement',
    !/stripe_customer_id/i.test(code),
  );
}

// ══ 5. Property 39, over any interleaving ═══════════════════════════════════
//
// Feature: multi-organisation-phorma, Property 39: A personal owner and an
// organisation owner never share a billing fact.
//
// The sections above pin sequences a reader chose. This states the law: for a
// personal owner and an organisation owner the same human belongs to, NO sequence of
// provisioning writes, Stripe events, credit grants or metered runs makes a tier, a
// status, a grant, a quota rollup, a runtime key or a Stripe customer of one
// observable as the other's - and a member's entitlement decision is a function of
// the ORGANISATION's row alone.
//
// The oracle tracks the two owners as two INDEPENDENT records and never as one
// merged view, which is the point: an implementation that folded them would satisfy
// any oracle that did the same.
//
// **Validates: Requirements 19.1, 19.2, 19.4, 19.5, 19.6, 19.10**

console.log('\nNo sequence makes one owner a billing fact of the other (Property 39)');
{
  const STEP = fc.oneof(
    fc.record({ kind: fc.constant('provision-org'), tier: fc.constantFrom('starter', 'pro', 'team') }),
    fc.record({ kind: fc.constant('provision-personal'), tier: fc.constantFrom('starter', 'pro') }),
    fc.record({ kind: fc.constant('personal-subscription'), tier: fc.constantFrom('starter', 'pro') }),
    fc.record({ kind: fc.constant('personal-topup'), credits: fc.constantFrom(500, 1000) }),
    fc.record({ kind: fc.constant('org-run'), costUsd: fc.constantFrom(0.25, 0.5, 1) }),
    fc.record({ kind: fc.constant('personal-run'), costUsd: fc.constantFrom(0.25, 0.5) }),
    fc.record({ kind: fc.constant('org-checkout-attempt') }),
  );

  let iteration = 0;
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(STEP, { minLength: 1, maxLength: 6 }), async (steps) => {
        iteration += 1;
        const ORG = `org_p39_${iteration}`;
        const MEMBER = `user_p39_${iteration}`;
        const at = new Date().toISOString();
        await DB.batch([
          DB.prepare(
            `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
             VALUES (?, ?, 'admin', ?, ?)`,
          ).bind(ORG, MEMBER, at, at),
        ]);

        // The oracle: two records, kept apart by construction.
        const expected = {
          org: { tier: null, status: null, grants: 0, credits: 0, cost: 0, runs: 0 },
          personal: { tier: null, status: null, grants: 0, credits: 0, cost: 0, runs: 0, customer: false },
        };
        let runId = 0;
        const stub = vendorStub();
        try {
          for (const step of steps) {
            switch (step.kind) {
              case 'provision-org': {
                const answer = await provision(ORG, step.tier);
                assertThat(answer.status === 200, `provision org: ${JSON.stringify(answer.body)}`);
                expected.org.tier = step.tier;
                expected.org.status = 'active';
                break;
              }
              case 'provision-personal': {
                const answer = await provision(MEMBER, step.tier);
                assertThat(answer.status === 200, `provision personal: ${JSON.stringify(answer.body)}`);
                expected.personal.tier = step.tier;
                expected.personal.status = 'active';
                break;
              }
              case 'personal-subscription': {
                const price = step.tier === 'pro' ? PRO_PRICE : STARTER_PRICE;
                const answer = await deliver(
                  'customer.subscription.updated',
                  subscriptionFor(MEMBER, { price }),
                );
                assertThat(answer.status === 200, `subscription event: ${JSON.stringify(answer.body)}`);
                expected.personal.tier = step.tier;
                expected.personal.status = 'active';
                expected.personal.customer = true;
                break;
              }
              case 'personal-topup': {
                // A pack is sold in a fixed size, so the event's line item decides the
                // credits; `step.credits` only varies the PAYMENT so each is distinct.
                const answer = await deliver(
                  'checkout.session.completed',
                  topUpFor(MEMBER, `pi_p39_${iteration}_${step.credits}_${runId++}`),
                );
                assertThat(answer.status === 200, `topup event: ${JSON.stringify(answer.body)}`);
                expected.personal.grants += 1;
                expected.personal.credits += Number(TOPUP_PRICE.metadata.credits);
                expected.personal.customer = true;
                break;
              }
              case 'org-run': {
                // Entitlement is the ORGANISATION's decision. Recorded only when the
                // gate allows it, exactly as the route does.
                const gate = await resolveHostedInference(store, ORG);
                if ('status' in gate) {
                  assertThat(
                    expected.org.status !== 'active',
                    `org run refused while provisioned active: ${JSON.stringify(gate)}`,
                  );
                  break;
                }
                assertThat(
                  expected.org.status === 'active',
                  'org run allowed while the organisation was never provisioned',
                );
                await store.recordRun({
                  tenantId: ORG,
                  runId: `run_org_${iteration}_${runId++}`,
                  workflowId: 'wf-p39',
                  costUsd: step.costUsd,
                  tier: gate.tenant.tier,
                  tokensIn: 10,
                  tokensOut: 20,
                  countsAsRun: false,
                });
                expected.org.cost += step.costUsd;
                expected.org.runs += 1;
                break;
              }
              case 'personal-run': {
                const gate = await resolveHostedInference(store, MEMBER);
                if ('status' in gate) {
                  assertThat(
                    expected.personal.status !== 'active',
                    `personal run refused while active: ${JSON.stringify(gate)}`,
                  );
                  break;
                }
                await store.recordRun({
                  tenantId: MEMBER,
                  runId: `run_me_${iteration}_${runId++}`,
                  workflowId: 'wf-p39',
                  costUsd: step.costUsd,
                  tier: gate.tenant.tier,
                  tokensIn: 10,
                  tokensOut: 20,
                  countsAsRun: false,
                });
                expected.personal.cost += step.costUsd;
                expected.personal.runs += 1;
                break;
              }
              case 'org-checkout-attempt': {
                const before = stub.stripeCalls().length;
                const answer = await api('/api/checkout', {
                  body: { lookupKey: 'phorma_starter_monthly' },
                  token: MEMBER,
                  claims: { org_id: ORG, org_role: 'org:admin' },
                });
                assertThat(
                  answer.status === 403 && answer.body?.code === 'billing_managed',
                  `org checkout was not refused: ${answer.status} ${JSON.stringify(answer.body)}`,
                );
                assertThat(
                  stub.stripeCalls().length === before,
                  'a refused organisation checkout still reached Stripe',
                );
                break;
              }
              default:
                throw new Error(`unknown step ${step.kind}`);
            }
          }

          const org = await billingFactsOf(ORG);
          const personal = await billingFactsOf(MEMBER);

          // ── The organisation never acquires a Stripe fact ────────────────
          assertThat(org.customer === null, `org acquired a Stripe customer: ${org.customer}`);
          assertThat(org.subscription === null, `org acquired a subscription: ${org.subscription}`);
          assertThat(org.grants === 0, `org acquired ${org.grants} credit grant(s)`);
          // And the converse direction: any Stripe customer the PERSONAL row
          // acquired is its own, never one that could name the organisation.
          assertThat(
            personal.customer === null || personal.customer === `cus_${MEMBER}`,
            `personal row holds a foreign Stripe customer: ${personal.customer}`,
          );
          assertThat(
            expected.personal.customer || personal.customer === null,
            `personal row acquired a Stripe customer with no Stripe event: ${personal.customer}`,
          );

          // ── Each owner's tier and status are its own ─────────────────────
          assertThat(org.tier === expected.org.tier, `org tier ${org.tier} != ${expected.org.tier}`);
          assertThat(org.status === expected.org.status, `org status ${org.status} != ${expected.org.status}`);
          assertThat(
            personal.tier === expected.personal.tier,
            `personal tier ${personal.tier} != ${expected.personal.tier}`,
          );
          assertThat(
            personal.status === expected.personal.status,
            `personal status ${personal.status} != ${expected.personal.status}`,
          );

          // ── Grants belong to the payer ───────────────────────────────────
          assertThat(
            personal.grants === expected.personal.grants && personal.grantedCredits === expected.personal.credits,
            `personal grants ${personal.grants}/${personal.grantedCredits} != ${expected.personal.grants}/${expected.personal.credits}`,
          );

          // ── The rollups are separate sums ────────────────────────────────
          assertThat(near(org.costUsdUsed, expected.org.cost), `org rollup ${org.costUsdUsed} != ${expected.org.cost}`);
          assertThat(org.ledgerRows === expected.org.runs, `org ledger rows ${org.ledgerRows} != ${expected.org.runs}`);
          assertThat(
            near(personal.costUsdUsed, expected.personal.cost),
            `personal rollup ${personal.costUsdUsed} != ${expected.personal.cost}`,
          );
          assertThat(
            personal.ledgerRows === expected.personal.runs,
            `personal ledger rows ${personal.ledgerRows} != ${expected.personal.runs}`,
          );

          // ── The runtime keys are two keys, never one ─────────────────────
          assertThat(
            org.keyId === null || personal.keyId === null || org.keyId !== personal.keyId,
            `both owners hold the same runtime key ${org.keyId}`,
          );

          // ── Entitlement is a function of the organisation's row alone ────
          //
          // Re-resolved at the END, when the personal row may be fully paid up and
          // the organisation may not be. A gate that fell back to the member's own
          // account would allow here.
          const gate = await resolveHostedInference(store, ORG);
          assertThat(
            ('status' in gate) === (expected.org.status !== 'active'),
            `entitlement disagreed with the organisation row: ${JSON.stringify(gate)} vs ${expected.org.status}`,
          );
          if (!('status' in gate)) {
            assertThat(gate.tenant.id === ORG, `gate resolved ${gate.tenant.id} rather than ${ORG}`);
            assertThat(
              gate.tenant.tier === expected.org.tier,
              `gate tier ${gate.tenant.tier} != ${expected.org.tier}`,
            );
          }
          return true;
        } finally {
          stub.restore();
        }
      }),
      { numRuns: 12 },
    );
    check('Property 39 holds over every generated interleaving', true);
  } catch (error) {
    check('Property 39 holds over every generated interleaving', false, describeFailure(error));
  }
}

await mf.dispose();
console.log(
  failures === 0
    ? '\nAll organisation billing checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
