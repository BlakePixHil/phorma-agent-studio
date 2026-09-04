/**
 * The Stripe webhook - `POST /api/stripe/webhook` (task group 5, requirements 3,
 * 10 - 16, 21).
 *
 * Sections 1 - 8 are the focused coverage for the handler tasks 5.1 - 5.8 land.
 * Section 9 (task 5.9) is the REPLAY CONVERGENCE property: any set of events, in
 * any order, with any duplicates interleaved, against the same set delivered in
 * `created` order exactly once. It is the only thing here that says anything
 * about requirements 13 and 14 beyond the handful of orderings a human
 * enumerated - and it is what found the three order-dependence defects that
 * `0004_billing_ordering.sql` fixes, now kept as named regression checks in
 * section 10.
 *
 * Registered in `cloud/package.json`'s `test:unit` chain, which is what CI runs
 * (`.github/workflows/ci.yml` calls `npm run test:unit`, it does not enumerate
 * suites). To run it alone:
 *
 *   npx tsx cloud/test/stripe-webhook.test.mjs
 *
 * What is at stake, and why each section exists:
 *
 *  - the route must be reachable with NO bearer and refused without a valid
 *    signature, because the HMAC is the entire authorization story (5.1)
 *  - the raw body must survive to the signature check, so a 200 here is also the
 *    proof that nothing upstream called `request.json()` first (5.1)
 *  - a body over the ceiling must be refused BEFORE the HMAC runs (5.1)
 *  - a redelivery must not double-grant or double-apply (5.2)
 *  - an out-of-order event must not resurrect a superseded tier (5.3), and that
 *    is a DIFFERENT guard from the one above: an event can be new and stale
 *  - a payment that cannot find its account must be recorded, never dropped (5.4)
 *  - and every state transition - activate, upgrade, dunning, cancel, top-up -
 *    must land on the tenant row it belongs to (5.5 - 5.8)
 *  - and NO delivery order of those events may change where they land (5.9)
 *
 * Harness: `handleApiRequest` called DIRECTLY over a real local D1 (Miniflare's
 * SQLite binding reached from Node, real migrations applied), the same shape
 * `billing-routes.test.mjs` uses. Signatures are REAL HMAC-SHA256 over the raw
 * bytes, so the verification path is exercised rather than stubbed. The only
 * thing replaced is `globalThis.fetch`, which stands in for Stripe and
 * OpenRouter and records every call.
 *
 * The D1 binding goes through `withLoopbackRetryD1`, and NOT because a fetch is
 * dispatched here - none is. Avoiding `dispatchFetch` does not avoid the
 * loopback: `getD1Database` costs ONE SOCKET PER STATEMENT, so this suite is the
 * single biggest consumer in the chain (~7,100 sockets, since every statement
 * `handleApiRequest` issues in-process crosses the proxy too). The earlier claim
 * here, that in-process D1 costs no socket, was measured and is false - it is
 * what drained the Windows ephemeral port range and failed `telemetry-ingest`
 * downstream. See `test/miniflare-loopback.mjs`.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';
import fc from 'fast-check';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected before
// the module graph loads - which is why `api.ts` arrives by dynamic import.
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
const { TenantStore } = await import('../src/tenants.ts');
const { STRIPE_WEBHOOK_MAX_BODY_BYTES } = await import('../src/stripe-webhook.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

// Captured before anything replaces them, and declared up here so `check` below
// cannot accidentally report through a stub.
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

let failures = 0;
function check(name, condition, detail) {
  // Through the REAL console on purpose: the Stripe stub replaces `console.*` to
  // capture the handler's own log lines, and reporting through the replacement
  // would swallow every PASS and, worse, every FAIL detail.
  if (condition) {
    realConsole.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    realConsole.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-stripe-webhook' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
for (const file of ['0001_init.sql', '0003_billing.sql', '0004_billing_ordering.sql']) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}
const store = new TenantStore({ DB });

// --- Environment -----------------------------------------------------------

const WEBHOOK_SECRET = 'whsec_test_do_not_leak';
const SECRET_KEY = 'sk_test_webhook_do_not_leak';
const PROVISIONING_KEY = 'or-provisioning-key';
const ADMIN_TOKEN = 'admin-token-not-a-billing-credential';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';
const WEBHOOK_URL = `${ORIGIN}/api/stripe/webhook`;

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_here',
    PHORMA_ADMIN_TOKEN: ADMIN_TOKEN,
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
    DB,
    ...extra,
  };
}

// --- Stripe + OpenRouter stub ----------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PRO_PRICE = {
  id: 'price_pro_monthly',
  active: true,
  type: 'recurring',
  lookup_key: 'phorma_pro_monthly',
  currency: 'usd',
  unit_amount: 6000,
  tax_behavior: 'inclusive',
  recurring: { interval: 'month' },
  metadata: { tier: 'pro' },
};
const STARTER_PRICE = { ...PRO_PRICE, id: 'price_starter_monthly', lookup_key: 'phorma_starter_monthly', unit_amount: 2000, metadata: { tier: 'starter' } };
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

/** Stripe customers the stub will serve, by id. */
const CUSTOMERS = {};
/** Stripe subscriptions the stub will serve, by id. */
const SUBSCRIPTIONS = {};
/** Checkout session line items the stub will serve, by session id. */
const LINE_ITEMS = {};

function subscriptionObject({
  id = 'sub_1',
  customer = 'cus_1',
  status = 'active',
  price = PRO_PRICE,
  quantity = 1,
} = {}) {
  return {
    id,
    object: 'subscription',
    customer,
    status,
    items: { object: 'list', data: [{ id: `si_${id}`, quantity, price }] },
  };
}

function stripeStub(overrides = {}) {
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      host: url.host,
      path: url.pathname,
      method: init.method ?? 'GET',
      query: Object.fromEntries(url.searchParams),
      headers: init.headers ?? {},
      // Captured because the OpenRouter key API takes its whole instruction in the
      // body: `limit` for a tier change, `disabled` for a retirement (task 8.1).
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);

    const override = overrides[url.pathname];
    if (override) return override(call);

    if (url.host === 'openrouter.ai') {
      // A mint has to answer with a key and a hash, or the provisioner throws and
      // the runtime-key reconciliation (task 8.1) can never be seen to succeed.
      return call.method === 'POST'
        ? jsonResponse({ key: 'sk-or-v1-minted-here', data: { hash: 'hash-minted-here' } })
        : jsonResponse({ data: { disabled: true } });
    }

    const lineItems = /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/.exec(url.pathname);
    if (lineItems) return jsonResponse({ data: LINE_ITEMS[lineItems[1]] ?? [] });

    const customer = /^\/v1\/customers\/([^/]+)$/.exec(url.pathname);
    if (customer) {
      const found = CUSTOMERS[customer[1]];
      return found
        ? jsonResponse(found)
        : jsonResponse({ error: { code: 'resource_missing', message: 'No such customer' } }, 404);
    }

    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (subscription) {
      const found = SUBSCRIPTIONS[subscription[1]];
      return found
        ? jsonResponse(found)
        : jsonResponse({ error: { code: 'resource_missing', message: 'No such subscription' } }, 404);
    }

    throw new Error(`unexpected outbound call ${url.host}${url.pathname}`);
  };

  return {
    calls,
    logs,
    callsTo: (path) => calls.filter((call) => call.path === path),
    restore: () => {
      globalThis.fetch = realFetch;
      Object.assign(console, realConsole);
    },
  };
}

// --- Delivering an event ---------------------------------------------------

let eventCounter = 0;
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function stripeEvent(type, object, { id, created } = {}) {
  eventCounter += 1;
  return {
    id: id ?? `evt_test_${eventCounter}`,
    object: 'event',
    type,
    created: created ?? NOW_SECONDS,
    data: { object },
  };
}

/** POSTs one signed delivery through the REAL router. */
async function deliver(env, event, options = {}) {
  const raw = options.raw ?? JSON.stringify(event);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    options.signature ??
    createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
      .update(`${timestamp}.${raw}`)
      .digest('hex');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.omitSignature ? {} : { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }),
    ...(options.headers ?? {}),
  };
  const response = await handleApiRequest(
    new Request(WEBHOOK_URL, { method: options.method ?? 'POST', headers, body: raw }),
    env,
    CORS,
    CTX,
  );
  return {
    status: response?.status ?? 0,
    body: response ? await response.json().catch(() => null) : null,
  };
}

async function eventRow(id) {
  return DB.prepare('SELECT id, type, tenant_id, status FROM stripe_events WHERE id = ?')
    .bind(id)
    .first();
}
async function grantRows(tenantId) {
  const { results } = await DB.prepare(
    'SELECT stripe_payment_id, credits, cost_usd FROM credit_grants WHERE tenant_id = ? ORDER BY id',
  )
    .bind(tenantId)
    .all();
  return results ?? [];
}

// ══ 1. The front door (task 5.1, requirements 11, 12) ═══════════════════════

console.log('\nThe front door: signature is the only credential (requirements 11, 12)');
{
  const stub = stripeStub();
  try {
    // Requirement 34: unconfigured names the secret rather than failing opaquely.
    const unconfigured = await deliver(
      hostedEnv({ STRIPE_WEBHOOK_SECRET: undefined }),
      stripeEvent('customer.subscription.updated', subscriptionObject()),
    );
    check('without STRIPE_WEBHOOK_SECRET it is 501 naming the secret', unconfigured.status === 501 && /STRIPE_WEBHOOK_SECRET/.test(unconfigured.body?.error ?? ''), `${unconfigured.status} ${JSON.stringify(unconfigured.body)}`);

    // A BYO worker binds neither the secret nor D1, and must not reach Stripe.
    const byo = { PHORMA_TOKEN: 'byo-token' };
    const onByo = await deliver(byo, stripeEvent('customer.subscription.updated', subscriptionObject()));
    check('a BYO worker refuses it without touching D1', onByo.status === 501 && /STRIPE_WEBHOOK_SECRET/.test(onByo.body?.error ?? ''), `${onByo.status} ${JSON.stringify(onByo.body)}`);

    const noSignature = await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject()), { omitSignature: true });
    check('no Stripe-Signature header is 400', noSignature.status === 400, `${noSignature.status} ${JSON.stringify(noSignature.body)}`);

    const wrongSecret = await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject()), { secret: 'whsec_someone_elses' });
    check('a signature under a different secret is 400', wrongSecret.status === 400, `${wrongSecret.status} ${JSON.stringify(wrongSecret.body)}`);

    // The timestamp tolerance is what stops a captured body being replayed.
    const replayed = await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject()), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    check('an hour-old signature is refused (replay guard)', replayed.status === 400, `${replayed.status} ${JSON.stringify(replayed.body)}`);

    // Signed, then altered in transit: the HMAC covers the BYTES.
    const event = stripeEvent('customer.subscription.updated', subscriptionObject());
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    const tampered = await deliver(hostedEnv(), event, { raw: raw.replace('"pro"', '"team"'), timestamp, signature });
    check('a tampered body is refused', tampered.status === 400, `${tampered.status} ${JSON.stringify(tampered.body)}`);

    check('nothing unverified reached Stripe', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => c.path)));
    const rejected = await DB.prepare('SELECT COUNT(*) c FROM stripe_events').first();
    check('nothing unverified was recorded', rejected.c === 0, JSON.stringify(rejected));

    const wrongMethod = await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject()), { method: 'PUT' });
    check('a non-POST is 405 rather than a confusing 404', wrongMethod.status === 405, `${wrongMethod.status} ${JSON.stringify(wrongMethod.body)}`);

    check('the webhook secret is in no log line', !stub.logs.join('\n').includes(WEBHOOK_SECRET), stub.logs.join(' | '));
  } finally {
    stub.restore();
  }
}

console.log('\nAn oversized body is refused BEFORE the HMAC runs (task 5.1)');
{
  const stub = stripeStub();
  try {
    // Deliberately signed with the WRONG secret: a 413 rather than a 400 is the
    // proof that the size ceiling was applied before verification, which is the
    // whole point of having it on a public route.
    const padded = JSON.stringify({
      ...stripeEvent('customer.subscription.updated', subscriptionObject()),
      padding: 'x'.repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES),
    });
    const answer = await deliver(hostedEnv(), null, { raw: padded, secret: 'whsec_someone_elses' });
    check('a body over the ceiling is 413, not 400', answer.status === 413, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('the ceiling is bounded at 1 MiB', STRIPE_WEBHOOK_MAX_BODY_BYTES === 1_048_576, String(STRIPE_WEBHOOK_MAX_BODY_BYTES));
  } finally {
    stub.restore();
  }
}

// ══ 2. Activation from a completed checkout (task 5.5, requirement 10) ══════

console.log('\nA first-time buyer is activated by checkout.session.completed (task 5.5)');
{
  const stub = stripeStub();
  try {
    SUBSCRIPTIONS['sub_new'] = subscriptionObject({ id: 'sub_new', customer: 'cus_new', price: PRO_PRICE });
    const event = stripeEvent('checkout.session.completed', {
      id: 'cs_new',
      object: 'checkout.session',
      mode: 'subscription',
      // The one path that works before any mapping exists.
      client_reference_id: 'user_new',
      customer: 'cus_new',
      subscription: 'sub_new',
      payment_status: 'paid',
      customer_details: { email: 'new@example.com' },
    });
    const answer = await deliver(hostedEnv(), event);

    // A 200 here is also the proof that the raw body survived the router: the
    // signature could not have verified if anything upstream had consumed it.
    check('answers 200 applied', answer.status === 200 && answer.body?.status === 'applied', `${answer.status} ${JSON.stringify(answer.body)}`);

    const tenant = await store.getTenant('user_new');
    check('the tenant row is created active on the purchased tier', tenant?.tier === 'pro' && tenant?.status === 'active', JSON.stringify(tenant));
    check('both Stripe identity columns are mapped', tenant?.stripeCustomerId === 'cus_new' && tenant?.stripeSubscriptionId === 'sub_new', JSON.stringify(tenant));
    check('the watermark advanced to the event created', tenant?.billingEventAt === event.created, JSON.stringify(tenant));
    check('the buyer email is kept for support', tenant?.email === 'new@example.com', JSON.stringify(tenant));
    // Requirement 7: tier came off the PRICE, so the subscription had to be read.
    check('the subscription was read from Stripe for its price', stub.callsTo('/v1/subscriptions/sub_new').length === 1, JSON.stringify(stub.calls.map((c) => c.path)));

    const row = await eventRow(event.id);
    check('the event is recorded applied against the tenant', row?.status === 'applied' && row?.tenant_id === 'user_new', JSON.stringify(row));
  } finally {
    stub.restore();
  }
}

// ══ 3. Idempotency vs ordering (tasks 5.2, 5.3) ════════════════════════════

console.log('\nA redelivery changes nothing (task 5.2, requirement 13)');
{
  const stub = stripeStub();
  try {
    SUBSCRIPTIONS['sub_dup'] = subscriptionObject({ id: 'sub_dup', customer: 'cus_dup', price: PRO_PRICE });
    CUSTOMERS['cus_dup'] = { id: 'cus_dup', metadata: { clerk_user_id: 'user_dup' } };
    const event = stripeEvent('customer.subscription.created', SUBSCRIPTIONS['sub_dup']);

    const first = await deliver(hostedEnv(), event);
    const callsAfterFirst = stub.calls.length;
    const second = await deliver(hostedEnv(), event);

    check('the first delivery applies', first.body?.status === 'applied', JSON.stringify(first.body));
    check('the redelivery is 2xx and reports the recorded status', second.status === 200 && second.body?.duplicate === true && second.body?.status === 'applied', `${second.status} ${JSON.stringify(second.body)}`);
    check('the redelivery did no further work', stub.calls.length === callsAfterFirst, JSON.stringify(stub.calls.map((c) => c.path)));
    const rows = await DB.prepare('SELECT COUNT(*) c FROM stripe_events WHERE id = ?').bind(event.id).first();
    check('only one event row exists', rows.c === 1, JSON.stringify(rows));
  } finally {
    stub.restore();
  }
}

console.log('\nA NEW but STALE event is ignored, not applied (task 5.3, requirement 14)');
{
  const stub = stripeStub();
  try {
    CUSTOMERS['cus_stale'] = { id: 'cus_stale', metadata: { clerk_user_id: 'user_stale' } };
    // The pre-state is "a subscription event at NOW has been applied", which since
    // `0004_billing_ordering.sql` means the TIER and LIFECYCLE-STATUS clocks, not
    // one scalar. `billingEventAt` alone is now audit-only and gates nothing.
    await store.upsertTenant({ id: 'user_stale', tier: 'team', status: 'active', stripeCustomerId: 'cus_stale', billingEventAt: NOW_SECONDS, tierAt: NOW_SECONDS, statusAt: NOW_SECONDS });

    // A late `subscription.updated` carrying an older tier. Its id is unseen, so
    // idempotency does not stop it - the WATERMARK does, which is the whole point
    // of the two guards being separate.
    const stale = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id: 'sub_stale', customer: 'cus_stale', price: STARTER_PRICE }),
      { created: NOW_SECONDS - 60 },
    );
    const answer = await deliver(hostedEnv(), stale);

    check('answers 200 ignored_stale', answer.status === 200 && answer.body?.status === 'ignored_stale', `${answer.status} ${JSON.stringify(answer.body)}`);
    const tenant = await store.getTenant('user_stale');
    check('the superseded tier was NOT resurrected', tenant?.tier === 'team' && tenant?.status === 'active', JSON.stringify(tenant));
    const row = await eventRow(stale.id);
    check('the ignored event is still recorded, against the tenant', row?.status === 'ignored_stale' && row?.tenant_id === 'user_stale', JSON.stringify(row));

    // The same tenant still accepts a NEWER event, so the guard is a watermark
    // rather than a lock.
    const fresh = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id: 'sub_stale', customer: 'cus_stale', price: STARTER_PRICE }),
      { created: NOW_SECONDS + 60 },
    );
    await deliver(hostedEnv(), fresh);
    const downgraded = await store.getTenant('user_stale');
    check('a newer event still applies (a downgrade lands)', downgraded?.tier === 'starter' && downgraded?.billingEventAt === fresh.created, JSON.stringify(downgraded));
  } finally {
    stub.restore();
  }
}

// ══ 4. Tenant resolution (task 5.4, requirement 3) ═════════════════════════

console.log('\nAll three resolution paths, and the recorded failure (task 5.4)');
{
  const stub = stripeStub();
  try {
    // Path 2: the customer's own metadata, independent of our bookkeeping.
    CUSTOMERS['cus_meta'] = { id: 'cus_meta', metadata: { clerk_user_id: 'user_meta' } };
    SUBSCRIPTIONS['sub_meta'] = subscriptionObject({ id: 'sub_meta', customer: 'cus_meta' });
    await deliver(hostedEnv(), stripeEvent('customer.subscription.created', SUBSCRIPTIONS['sub_meta']));
    check('path 2 resolves by customer.metadata.clerk_user_id', (await store.getTenant('user_meta'))?.status === 'active', JSON.stringify(await store.getTenant('user_meta')));

    // Path 3: the stored mapping, for a customer carrying no metadata at all.
    CUSTOMERS['cus_mapped'] = { id: 'cus_mapped', metadata: {} };
    await store.upsertTenant({ id: 'user_mapped', tier: 'starter', status: 'past_due', stripeCustomerId: 'cus_mapped' });
    SUBSCRIPTIONS['sub_mapped'] = subscriptionObject({ id: 'sub_mapped', customer: 'cus_mapped' });
    await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', SUBSCRIPTIONS['sub_mapped']));
    const mapped = await store.getTenant('user_mapped');
    check('path 3 resolves by the stored stripe_customer_id', mapped?.tier === 'pro' && mapped?.status === 'active', JSON.stringify(mapped));

    // Requirement 3: nobody to attach it to, so it is NAMED rather than dropped.
    CUSTOMERS['cus_orphan'] = { id: 'cus_orphan', metadata: {} };
    const orphan = stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_orphan', customer: 'cus_orphan' }));
    const answer = await deliver(hostedEnv(), orphan);
    check('an unresolvable event answers 200 (no Stripe retry storm)', answer.status === 200 && answer.body?.status === 'unresolved', `${answer.status} ${JSON.stringify(answer.body)}`);
    const row = await eventRow(orphan.id);
    check('it is recorded unresolved with a null tenant', row?.status === 'unresolved' && row?.tenant_id === null, JSON.stringify(row));

    // A transient customer read failure is NOT "unresolved": it is unknown, and
    // asking for a redelivery is the honest answer.
    const flaky = stripeStub({
      '/v1/customers/cus_flaky': () => jsonResponse({ error: { code: 'lock_timeout' } }, 500),
    });
    try {
      const transient = stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_flaky', customer: 'cus_flaky' }));
      const retried = await deliver(hostedEnv(), transient);
      check('a Stripe outage during resolution asks for a retry', retried.status === 502, `${retried.status} ${JSON.stringify(retried.body)}`);
      check('and records nothing, so the retry starts clean', (await eventRow(transient.id)) === null, JSON.stringify(await eventRow(transient.id)));
    } finally {
      flaky.restore();
    }
  } finally {
    stub.restore();
  }
}

// ══ 5. Top-ups (task 5.5, requirements 21, 22) ═════════════════════════════

console.log('\nA credit pack writes exactly one grant, keyed on the payment (requirement 21)');
{
  const stub = stripeStub();
  try {
    await store.upsertTenant({ id: 'user_pack', tier: 'starter', status: 'active', stripeCustomerId: 'cus_pack' });
    CUSTOMERS['cus_pack'] = { id: 'cus_pack', metadata: { clerk_user_id: 'user_pack' } };
    LINE_ITEMS['cs_pack'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    const session = {
      id: 'cs_pack',
      object: 'checkout.session',
      mode: 'payment',
      client_reference_id: 'user_pack',
      customer: 'cus_pack',
      payment_intent: 'pi_pack',
      payment_status: 'paid',
    };

    const first = await deliver(hostedEnv(), stripeEvent('checkout.session.completed', session));
    check('the grant applies', first.body?.status === 'applied', JSON.stringify(first.body));

    let grants = await grantRows('user_pack');
    check('one grant row, with the displayed credits', grants.length === 1 && grants[0].credits === 500, JSON.stringify(grants));
    // Requirement 8: the USD basis is derived from TIERS.starter (4/1000), never a
    // literal, so 500 credits is $2.00 of real inference budget.
    check('the USD budget is the starter-derived basis', Math.abs(grants[0].cost_usd - 2) < 1e-9, JSON.stringify(grants));
    check('it is keyed on the payment intent, not the event', grants[0].stripe_payment_id === 'pi_pack', JSON.stringify(grants));

    // A SECOND, DIFFERENT event about the SAME money. Event-level idempotency
    // cannot catch this, which is exactly why the grant is keyed on the payment.
    const second = await deliver(hostedEnv(), stripeEvent('checkout.session.completed', session));
    check('a second event for the same payment is applied but grants nothing', second.body?.status === 'applied', JSON.stringify(second.body));
    grants = await grantRows('user_pack');
    check('still exactly one grant', grants.length === 1, JSON.stringify(grants));

    // A pack purchase must not move the plan-ordering watermark: it says nothing
    // about subscription order, and advancing it would make a later plan change
    // look stale.
    const tenant = await store.getTenant('user_pack');
    check('a pack purchase leaves tier, status and watermark alone', tenant?.tier === 'starter' && tenant?.status === 'active' && tenant?.billingEventAt === 0, JSON.stringify(tenant));

    // A price that is not on the allowlist cannot mint credits, even inside an
    // authentically signed session.
    LINE_ITEMS['cs_forged'] = [{ id: 'li_1', quantity: 1, price: { ...TOPUP_PRICE, lookup_key: 'phorma_free_forever', metadata: { credits: '999999' } } }];
    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', { ...session, id: 'cs_forged', payment_intent: 'pi_forged' }));
    check('an off-catalogue price grants nothing', (await grantRows('user_pack')).length === 1, JSON.stringify(await grantRows('user_pack')));

    // A delayed payment method: completed session, money not yet taken.
    LINE_ITEMS['cs_unpaid'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', { ...session, id: 'cs_unpaid', payment_intent: 'pi_unpaid', payment_status: 'unpaid' }));
    check('an unpaid session grants nothing', (await grantRows('user_pack')).length === 1, JSON.stringify(await grantRows('user_pack')));
  } finally {
    stub.restore();
  }
}

// ══ 5a. The pack has to reach the VENDOR's cap too (requirement 37) ═════════
//
// The defect this section exists for: the grant raised OUR ceiling
// (`effectiveCostUsdLimit` = tier allowance + pool) so `resolveHostedInference` let
// runs through past the allowance, while the tenant's OpenRouter key still carried
// the tier allowance ALONE as its own `limit` - and OpenRouter enforces that itself.
// So the exact overage the pack was sold to cover was refused by the vendor, and a
// purchased top-up was unusable.
//
// Section 5 above could not catch it: it asserts `credit_grants` rows and makes no
// claim about `openrouter.ai` calls at all, even though this suite's stub has always
// recorded them with their bodies.

console.log('\nA pack purchase re-caps the runtime key to allowance + pack (requirement 37)');
{
  const stub = stripeStub();
  const keyCalls = () => stub.calls.filter((call) => call.host === 'openrouter.ai');
  const bodyOf = (call) => (call?.body ? JSON.parse(call.body) : null);
  try {
    // Starter: a $4 monthly allowance. The small pack is 500 credits, and requirement
    // 8 derives its USD basis from TIERS.starter (4/1000), so it buys $2.00 of real
    // inference budget - and the key's cap must become $6.00, not stay at $4.
    await store.upsertTenant({ id: 'user_topup_key', tier: 'starter', status: 'active', stripeCustomerId: 'cus_topup_key', openrouterKeyId: 'hash-topup', openrouterKeyEnc: 'enc-topup' });
    CUSTOMERS['cus_topup_key'] = { id: 'cus_topup_key', metadata: { clerk_user_id: 'user_topup_key' } };
    LINE_ITEMS['cs_topup_key'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    const packSession = {
      id: 'cs_topup_key',
      object: 'checkout.session',
      mode: 'payment',
      client_reference_id: 'user_topup_key',
      customer: 'cus_topup_key',
      payment_intent: 'pi_topup_key',
      payment_status: 'paid',
    };

    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', packSession));
    check('the pack landed', (await grantRows('user_topup_key')).length === 1, JSON.stringify(await grantRows('user_topup_key')));

    const patched = keyCalls();
    check('the purchase patched the key', patched.length === 1 && patched[0].method === 'PATCH', JSON.stringify(patched.map((c) => `${c.method} ${c.path}`)));
    check('it patches the key the tenant holds', patched[0]?.path.endsWith('hash-topup'), JSON.stringify(patched[0]?.path));
    // THE assertion. $4 allowance + $2 pack, and neither figure alone.
    check('the cap is the allowance PLUS the pack ($4 + $2)', bodyOf(patched[0])?.limit === 6, String(patched[0]?.body));
    // The body shape is untouched: the grant term moves the VALUE, and `limit_reset`
    // is still deliberately absent (it would reinterpret the key's accrued usage).
    check('still two fields and no more', Object.keys(bodyOf(patched[0]) ?? {}).sort().join() === 'disabled,limit' && bodyOf(patched[0])?.disabled === false, String(patched[0]?.body));

    // A REDELIVERY: a different event about the same money. The grant is keyed on the
    // payment so it inserts nothing, and the cap must not climb to $8 either - the
    // pool is read live rather than accumulated, so a duplicate cannot inflate it.
    // The patch still runs, deliberately: it is the only thing that can heal a patch
    // that failed the first time, since the grant will never insert again.
    stub.calls.length = 0;
    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', packSession));
    check('a redelivery grants nothing', (await grantRows('user_topup_key')).length === 1, JSON.stringify(await grantRows('user_topup_key')));
    check('and does not double the cap', keyCalls().length === 1 && bodyOf(keyCalls()[0])?.limit === 6, JSON.stringify(keyCalls().map((c) => c.body)));

    // A tenant the gate refuses is not re-capped: the patch carries `disabled: false`,
    // so reconciling a lapsed payer would put a retired key back into service.
    stub.calls.length = 0;
    await store.upsertTenant({ id: 'user_topup_lapsed', tier: 'starter', status: 'canceled', stripeCustomerId: 'cus_topup_lapsed', openrouterKeyId: 'hash-lapsed', openrouterKeyEnc: 'enc-lapsed' });
    CUSTOMERS['cus_topup_lapsed'] = { id: 'cus_topup_lapsed', metadata: { clerk_user_id: 'user_topup_lapsed' } };
    LINE_ITEMS['cs_topup_lapsed'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', { ...packSession, id: 'cs_topup_lapsed', client_reference_id: 'user_topup_lapsed', customer: 'cus_topup_lapsed', payment_intent: 'pi_topup_lapsed' }));
    check('a cancelled tenant still gets the grant they paid for', (await grantRows('user_topup_lapsed')).length === 1, JSON.stringify(await grantRows('user_topup_lapsed')));
    check('but their retired key is not revived', keyCalls().length === 0, JSON.stringify(keyCalls()));

    // A failed patch must not fail the delivery. On THIS path a `retry` would be
    // unrecoverable rather than merely noisy: the grant is idempotent on the payment
    // id, so every redelivery would grant nothing and fail again, forever, until
    // Stripe disabled the endpoint for every tenant.
    const broken = stripeStub({ '/api/v1/keys/hash-broke': () => jsonResponse({ error: 'nope' }, 500) });
    try {
      await store.upsertTenant({ id: 'user_topup_broke', tier: 'starter', status: 'active', stripeCustomerId: 'cus_topup_broke', openrouterKeyId: 'hash-broke', openrouterKeyEnc: 'enc-broke' });
      CUSTOMERS['cus_topup_broke'] = { id: 'cus_topup_broke', metadata: { clerk_user_id: 'user_topup_broke' } };
      LINE_ITEMS['cs_topup_broke'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
      const answer = await deliver(hostedEnv(), stripeEvent('checkout.session.completed', { ...packSession, id: 'cs_topup_broke', client_reference_id: 'user_topup_broke', customer: 'cus_topup_broke', payment_intent: 'pi_topup_broke' }));
      check('a failed re-cap is still a 2xx, never a retry', answer.status === 200 && answer.body?.status === 'applied', `${answer.status} ${JSON.stringify(answer.body)}`);
      check('the grant landed regardless', (await grantRows('user_topup_broke')).length === 1, JSON.stringify(await grantRows('user_topup_broke')));
      check('and the failure names the tenant in the log', broken.logs.some((line) => line.includes('user_topup_broke') && /re-capped/.test(line)), broken.logs.join(' | '));
    } finally {
      broken.restore();
    }
  } finally {
    stub.restore();
  }
}

// ══ 5b. Delayed payment methods (requirement 3) ════════════════════════════
//
// `checkout.session.async_payment_succeeded` was NOT in the dispatch switch, so a
// customer paying by a delayed method had their money taken and received ZERO
// credits, permanently and silently: `applyTopUp` correctly refused to grant on the
// unpaid session, and nothing ever followed up.

console.log('\nA delayed payment grants when it settles, and not before (requirement 3)');
{
  const stub = stripeStub();
  const keyCalls = () => stub.calls.filter((call) => call.host === 'openrouter.ai');
  const bodyOf = (call) => (call?.body ? JSON.parse(call.body) : null);
  try {
    await store.upsertTenant({ id: 'user_async', tier: 'starter', status: 'active', stripeCustomerId: 'cus_async', openrouterKeyId: 'hash-async', openrouterKeyEnc: 'enc-async' });
    CUSTOMERS['cus_async'] = { id: 'cus_async', metadata: { clerk_user_id: 'user_async' } };
    LINE_ITEMS['cs_async'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    const pending = {
      id: 'cs_async',
      object: 'checkout.session',
      mode: 'payment',
      client_reference_id: 'user_async',
      customer: 'cus_async',
      payment_intent: 'pi_async',
      payment_status: 'unpaid',
    };

    // Stage one: the session completes, the money has not arrived. Nothing granted,
    // and nothing patched either - there is no pool to add to the cap.
    const first = await deliver(hostedEnv(), stripeEvent('checkout.session.completed', pending));
    check('the pending session is 2xx', first.status === 200 && first.body?.status === 'applied', `${first.status} ${JSON.stringify(first.body)}`);
    check('nothing is granted on a promise', (await grantRows('user_async')).length === 0, JSON.stringify(await grantRows('user_async')));
    check('and the key is not re-capped for it', keyCalls().length === 0, JSON.stringify(keyCalls()));

    // Stage two: the money lands. SAME session, now paid, on the event type that used
    // to fall through to `default` and be discarded as unhandled.
    stub.calls.length = 0;
    const settled = await deliver(hostedEnv(), stripeEvent('checkout.session.async_payment_succeeded', { ...pending, payment_status: 'paid' }));
    check('the settlement is applied, not ignored', settled.status === 200 && settled.body?.status === 'applied', `${settled.status} ${JSON.stringify(settled.body)}`);
    const grants = await grantRows('user_async');
    check('the credits are granted at last', grants.length === 1 && grants[0].credits === 500, JSON.stringify(grants));
    check('and the key cap follows ($4 + $2)', keyCalls().length === 1 && bodyOf(keyCalls()[0])?.limit === 6, JSON.stringify(keyCalls().map((c) => c.body)));

    // Both event types can arrive for one payment, and `credit_grants.stripe_payment_id`
    // is UNIQUE on the PAYMENT rather than the event - so the pack grants exactly once
    // across the pair, in either order.
    await deliver(hostedEnv(), stripeEvent('checkout.session.completed', { ...pending, payment_status: 'paid' }));
    check('the completed event afterwards grants no second pack', (await grantRows('user_async')).length === 1, JSON.stringify(await grantRows('user_async')));

    // A subscription-mode session settling late goes through the same handler, which
    // branches on `mode` - so a delayed-payment subscriber is activated rather than
    // left paid and unentitled.
    stub.calls.length = 0;
    CUSTOMERS['cus_async_sub'] = { id: 'cus_async_sub', metadata: { clerk_user_id: 'user_async_sub' } };
    SUBSCRIPTIONS['sub_async'] = subscriptionObject({ id: 'sub_async', customer: 'cus_async_sub', price: PRO_PRICE });
    await deliver(hostedEnv(), stripeEvent('checkout.session.async_payment_succeeded', {
      id: 'cs_async_sub',
      object: 'checkout.session',
      mode: 'subscription',
      client_reference_id: 'user_async_sub',
      customer: 'cus_async_sub',
      subscription: 'sub_async',
      payment_status: 'paid',
    }, { created: NOW_SECONDS + 1200 }));
    const activated = await store.getTenant('user_async_sub');
    check('a late subscription payment activates the plan', activated?.tier === 'pro' && activated?.status === 'active', JSON.stringify(activated));

    // THE FAILING HALF. Nothing was granted, so there is nothing to reverse: a logged
    // 2xx with no state change, and a `stripe_events` row so "nothing happened" stays
    // distinguishable from "never arrived". Deliberately NOT routed through
    // `applyCheckoutSession`, which in subscription mode would activate a plan for a
    // payment that failed.
    stub.calls.length = 0;
    CUSTOMERS['cus_async_dead'] = { id: 'cus_async_dead', metadata: { clerk_user_id: 'user_async_dead' } };
    LINE_ITEMS['cs_async_dead'] = [{ id: 'li_1', quantity: 1, price: TOPUP_PRICE }];
    const dead = stripeEvent('checkout.session.async_payment_failed', {
      id: 'cs_async_dead',
      object: 'checkout.session',
      mode: 'payment',
      client_reference_id: 'user_async_dead',
      customer: 'cus_async_dead',
      payment_intent: 'pi_async_dead',
      payment_status: 'unpaid',
    });
    const refused = await deliver(hostedEnv(), dead);
    check('a failed delayed payment is a 2xx', refused.status === 200 && refused.body?.status === 'applied', `${refused.status} ${JSON.stringify(refused.body)}`);
    check('it is recorded, against the tenant the checkout named', (await eventRow(dead.id))?.tenant_id === 'user_async_dead', JSON.stringify(await eventRow(dead.id)));
    check('it grants nothing', (await grantRows('user_async_dead')).length === 0, JSON.stringify(await grantRows('user_async_dead')));
    check('it creates no tenant row for an unpaid buyer', (await store.getTenant('user_async_dead')) === null, JSON.stringify(await store.getTenant('user_async_dead')));
    check('and it costs no call to Stripe or OpenRouter', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => `${c.host}${c.path}`)));
    check('the failure is logged with its session', stub.logs.some((line) => /cs_async_dead/.test(line) && /FAILED/.test(line)), stub.logs.join(' | '));

    // A failed SUBSCRIPTION payment must not activate anything - the reason this is a
    // separate case rather than a third label on the checkout handler.
    stub.calls.length = 0;
    CUSTOMERS['cus_async_deadsub'] = { id: 'cus_async_deadsub', metadata: { clerk_user_id: 'user_async_deadsub' } };
    SUBSCRIPTIONS['sub_async_dead'] = subscriptionObject({ id: 'sub_async_dead', customer: 'cus_async_deadsub', price: PRO_PRICE });
    await deliver(hostedEnv(), stripeEvent('checkout.session.async_payment_failed', {
      id: 'cs_async_deadsub',
      object: 'checkout.session',
      mode: 'subscription',
      client_reference_id: 'user_async_deadsub',
      customer: 'cus_async_deadsub',
      subscription: 'sub_async_dead',
      payment_status: 'unpaid',
    }, { created: NOW_SECONDS + 1300 }));
    check('a failed subscription payment activates no plan', (await store.getTenant('user_async_deadsub')) === null, JSON.stringify(await store.getTenant('user_async_deadsub')));
    check('and reads no subscription back from Stripe', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => c.path)));
  } finally {
    stub.restore();
  }
}

// ══ 6. Dunning (task 5.7, requirement 15) ══════════════════════════════════

console.log('\nDunning has behaviour for the first time (task 5.7, requirement 15)');
{
  const stub = stripeStub();
  try {
    CUSTOMERS['cus_dun'] = { id: 'cus_dun', metadata: { clerk_user_id: 'user_dun' } };
    await store.upsertTenant({ id: 'user_dun', email: 'dun@example.com', tier: 'pro', status: 'active', stripeCustomerId: 'cus_dun', openrouterKeyId: 'hash-dun', openrouterKeyEnc: 'enc-dun' });

    const failed = stripeEvent('invoice.payment_failed', {
      id: 'in_dun_1',
      object: 'invoice',
      customer: 'cus_dun',
      // The current API shape; the legacy `invoice.subscription` is read too.
      parent: { subscription_details: { subscription: 'sub_dun' } },
    }, { created: NOW_SECONDS + 100 });
    await deliver(hostedEnv(), failed);

    let tenant = await store.getTenant('user_dun');
    check('a failed invoice sets past_due', tenant?.status === 'past_due', JSON.stringify(tenant));
    // Requirement 18: recovering from a failed card is a payment, not a rebuild.
    check('tier, email and runtime key are retained', tenant?.tier === 'pro' && tenant?.email === 'dun@example.com' && tenant?.openrouterKeyId === 'hash-dun' && tenant?.openrouterKeyEnc === 'enc-dun', JSON.stringify(tenant));
    check('the subscription is now mapped', tenant?.stripeSubscriptionId === 'sub_dun', JSON.stringify(tenant));

    const paid = stripeEvent('invoice.payment_succeeded', {
      id: 'in_dun_2',
      object: 'invoice',
      customer: 'cus_dun',
      subscription: 'sub_dun',
    }, { created: NOW_SECONDS + 200 });
    await deliver(hostedEnv(), paid);
    tenant = await store.getTenant('user_dun');
    check('a subsequent success restores active (legacy invoice shape too)', tenant?.status === 'active' && tenant?.tier === 'pro', JSON.stringify(tenant));

    // A one-off pack invoice is not subscription state and must not touch it.
    await store.upsertTenant({ id: 'user_dun', tier: 'pro', status: 'past_due' });
    const oneOff = stripeEvent('invoice.payment_failed', { id: 'in_oneoff', object: 'invoice', customer: 'cus_dun' }, { created: NOW_SECONDS + 300 });
    const answer = await deliver(hostedEnv(), oneOff);
    check('an invoice with no subscription changes no plan status', answer.body?.status === 'applied' && (await store.getTenant('user_dun'))?.status === 'past_due', JSON.stringify(await store.getTenant('user_dun')));

    // A cancelled account is not reactivated by a stray paid invoice.
    await store.upsertTenant({ id: 'user_dun', tier: 'pro', status: 'canceled' });
    const stray = stripeEvent('invoice.paid', { id: 'in_stray', object: 'invoice', customer: 'cus_dun', subscription: 'sub_dun' }, { created: NOW_SECONDS + 400 });
    await deliver(hostedEnv(), stray);
    check('a cancelled tenant is NOT reactivated by an invoice', (await store.getTenant('user_dun'))?.status === 'canceled', JSON.stringify(await store.getTenant('user_dun')));
  } finally {
    stub.restore();
  }
}

// ══ 7. Cancellation (task 5.8, requirement 16) ═════════════════════════════

console.log('\nCancellation stops the spending (task 5.8, requirement 16)');
{
  const stub = stripeStub();
  try {
    CUSTOMERS['cus_gone'] = { id: 'cus_gone', metadata: { clerk_user_id: 'user_gone' } };
    await store.upsertTenant({ id: 'user_gone', tier: 'team', status: 'active', stripeCustomerId: 'cus_gone', openrouterKeyId: 'hash-gone', openrouterKeyEnc: 'enc-gone' });

    const deleted = stripeEvent('customer.subscription.deleted', subscriptionObject({ id: 'sub_gone', customer: 'cus_gone', status: 'canceled' }), { created: NOW_SECONDS + 500 });
    const answer = await deliver(hostedEnv(), deleted);

    check('answers 200 applied', answer.body?.status === 'applied', JSON.stringify(answer.body));
    const tenant = await store.getTenant('user_gone');
    check('the tenant is canceled with its tier on record', tenant?.status === 'canceled' && tenant?.tier === 'team', JSON.stringify(tenant));
    const disable = stub.calls.filter((call) => call.host === 'openrouter.ai');
    check('the runtime key is disabled', disable.length === 1 && disable[0].method === 'PATCH' && disable[0].path.endsWith('hash-gone'), JSON.stringify(disable));

    // A failed disable must not lose the cancellation, and must not be silent.
    // `disableTenantRuntimeKey` (task 8.3) is what turns the failure into a log
    // here and into `runtimeKeyDisabled: false` on `/api/deactivate`.
    const broken = stripeStub({ '/api/v1/keys/hash-live': () => jsonResponse({ error: 'nope' }, 500) });
    try {
      CUSTOMERS['cus_live'] = { id: 'cus_live', metadata: { clerk_user_id: 'user_live' } };
      await store.upsertTenant({ id: 'user_live', tier: 'pro', status: 'active', stripeCustomerId: 'cus_live', openrouterKeyId: 'hash-live', openrouterKeyEnc: 'enc-live' });
      const event = stripeEvent('customer.subscription.deleted', subscriptionObject({ id: 'sub_live', customer: 'cus_live', status: 'canceled' }), { created: NOW_SECONDS + 600 });
      const cancelled = await deliver(hostedEnv(), event);
      check('a failed key disable still cancels the tenant', cancelled.status === 200 && (await store.getTenant('user_live'))?.status === 'canceled', `${cancelled.status} ${JSON.stringify(await store.getTenant('user_live'))}`);
      check('and the failure is logged, not swallowed', broken.logs.some((line) => /may still be live/i.test(line)), broken.logs.join(' | '));
    } finally {
      broken.restore();
    }
  } finally {
    stub.restore();
  }
}

// ══ 7a. The runtime key follows the tier (task 8.1, requirements 37, 38) ════

console.log('\nA subscription write reconciles the runtime key (requirements 37, 38)');
{
  const stub = stripeStub();
  const keyCalls = () => stub.calls.filter((call) => call.host === 'openrouter.ai');
  const bodyOf = (call) => (call?.body ? JSON.parse(call.body) : null);
  try {
    CUSTOMERS['cus_tier'] = { id: 'cus_tier', metadata: { clerk_user_id: 'user_tier' } };
    await store.upsertTenant({ id: 'user_tier', tier: 'starter', status: 'active', stripeCustomerId: 'cus_tier', openrouterKeyId: 'hash-tier', openrouterKeyEnc: 'enc-tier' });

    // The defect requirement 37 names: `tier` moved to pro, and the real ceiling
    // stayed at starter's $4 because nothing touched the key.
    const upgrade = stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_tier', customer: 'cus_tier', price: PRO_PRICE }), { created: NOW_SECONDS + 800 });
    await deliver(hostedEnv(), upgrade);

    check('the tier moved', (await store.getTenant('user_tier'))?.tier === 'pro', JSON.stringify(await store.getTenant('user_tier')));
    const patched = keyCalls();
    check('exactly one key call was made', patched.length === 1, JSON.stringify(patched.map((c) => `${c.method} ${c.path} ${c.body}`)));
    check('it patches the key the tenant holds', patched[0]?.method === 'PATCH' && patched[0]?.path.endsWith('hash-tier'), JSON.stringify(patched[0]));
    check('with the NEW tier cap (pro = 12.6 USD)', bodyOf(patched[0])?.limit === 12.6, String(patched[0]?.body));
    // The cap and `disabled: false`, so a resubscription revives the key it
    // retired at cancellation instead of leaving OpenRouter refusing every run.
    check('and it clears disabled, nothing more', Object.keys(bodyOf(patched[0]) ?? {}).sort().join() === 'disabled,limit' && bodyOf(patched[0])?.disabled === false, String(patched[0]?.body));
    check('no replacement key was minted', keyCalls().every((call) => call.method === 'PATCH'), JSON.stringify(keyCalls().map((c) => c.method)));

    // THE ordering case. A late event carrying the OLD tier is refused by the tier
    // clock, so the row stays pro - and the key must follow the ROW, not the event,
    // or a stale delivery would quietly cap a pro tenant at starter's $4.
    stub.calls.length = 0;
    const late = stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_tier', customer: 'cus_tier', price: STARTER_PRICE }), { created: NOW_SECONDS + 700 });
    const answer = await deliver(hostedEnv(), late);
    check('the stale event is ignored', answer.body?.status === 'ignored_stale', JSON.stringify(answer.body));
    check('the tier is still pro', (await store.getTenant('user_tier'))?.tier === 'pro');
    check('the key limit was reconciled to the ROW tier, not the event tier', bodyOf(keyCalls()[0])?.limit === 12.6, JSON.stringify(keyCalls().map((c) => c.body)));

    // A first-time subscriber used to end up entitled with NO key, so every hosted
    // run refused with `no_runtime_key`. Activation mints one at the tier cap.
    stub.calls.length = 0;
    CUSTOMERS['cus_fresh'] = { id: 'cus_fresh', metadata: { clerk_user_id: 'user_fresh' } };
    SUBSCRIPTIONS['sub_fresh'] = subscriptionObject({ id: 'sub_fresh', customer: 'cus_fresh', price: PRO_PRICE });
    const withEnc = hostedEnv({ KEY_ENC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    await deliver(withEnc, stripeEvent('checkout.session.completed', {
      id: 'cs_fresh',
      object: 'checkout.session',
      mode: 'subscription',
      client_reference_id: 'user_fresh',
      customer: 'cus_fresh',
      subscription: 'sub_fresh',
    }, { created: NOW_SECONDS + 900 }));

    const minted = keyCalls();
    check('a key is minted for a first-time subscriber', minted.length === 1 && minted[0].method === 'POST', JSON.stringify(minted.map((c) => `${c.method} ${c.path}`)));
    check('at the tier cap', bodyOf(minted[0])?.limit === 12.6, String(minted[0]?.body));
    const fresh = await store.getTenant('user_fresh');
    check('and both key columns are stored', Boolean(fresh?.openrouterKeyId) && Boolean(fresh?.openrouterKeyEnc), JSON.stringify(fresh));

    // Without the encryption secret the mint is REPORTED and skipped rather than
    // throwing: an exception here would be a non-2xx and an endless redelivery.
    stub.calls.length = 0;
    CUSTOMERS['cus_noenc'] = { id: 'cus_noenc', metadata: { clerk_user_id: 'user_noenc' } };
    SUBSCRIPTIONS['sub_noenc'] = subscriptionObject({ id: 'sub_noenc', customer: 'cus_noenc' });
    const degraded = await deliver(hostedEnv(), stripeEvent('customer.subscription.created', SUBSCRIPTIONS['sub_noenc'], { created: NOW_SECONDS + 950 }));
    check('the delivery still succeeds', degraded.status === 200 && degraded.body?.status === 'applied', `${degraded.status} ${JSON.stringify(degraded.body)}`);
    check('the missing secret is logged', stub.logs.some((line) => /KEY_ENC_SECRET/.test(line)), stub.logs.join(' | '));
    check('and no key call was attempted', keyCalls().length === 0, JSON.stringify(keyCalls()));

    // A tenant the gate refuses is not reconciled at all: re-limiting a lapsed
    // payer's key would undo the branch that took it out of service.
    stub.calls.length = 0;
    await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_tier', customer: 'cus_tier', status: 'past_due', price: PRO_PRICE }), { created: NOW_SECONDS + 1000 }));
    check('a past_due write touches no key', keyCalls().length === 0, JSON.stringify(keyCalls()));
    check('and requirement 18 still holds - the key is retained', (await store.getTenant('user_tier'))?.openrouterKeyId === 'hash-tier');

    // A failed patch must not fail the delivery, or Stripe retries a write that
    // already landed for as long as OpenRouter is unwell.
    const broken = stripeStub({ '/api/v1/keys/hash-tier': () => jsonResponse({ error: 'nope' }, 500) });
    try {
      const resumed = await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_tier', customer: 'cus_tier', price: PRO_PRICE }), { created: NOW_SECONDS + 1100 }));
      check('a failed limit patch is still a 2xx', resumed.status === 200 && resumed.body?.status === 'applied', `${resumed.status} ${JSON.stringify(resumed.body)}`);
      check('the tenant is active again regardless', (await store.getTenant('user_tier'))?.status === 'active');
      check('and the failure is logged against the tenant', broken.logs.some((line) => line.includes('user_tier') && /previous USD limit/.test(line)), broken.logs.join(' | '));
    } finally {
      broken.restore();
    }
  } finally {
    stub.restore();
  }
}

// ══ 8. Statuses and unknown types ══════════════════════════════════════════

console.log('\nSubscription status mapping, and what is deliberately ignored');
{
  const stub = stripeStub();
  try {
    CUSTOMERS['cus_states'] = { id: 'cus_states', metadata: { clerk_user_id: 'user_states' } };
    let created = NOW_SECONDS + 700;
    for (const [stripeStatus, expected] of [
      ['trialing', 'active'],
      ['past_due', 'past_due'],
      ['unpaid', 'past_due'],
      ['incomplete', 'past_due'],
      ['a_status_from_the_future', 'past_due'],
      ['canceled', 'canceled'],
      ['active', 'active'],
    ]) {
      created += 10;
      await deliver(hostedEnv(), stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_states', customer: 'cus_states', status: stripeStatus }), { created }));
      const tenant = await store.getTenant('user_states');
      check(`subscription "${stripeStatus}" maps to ${expected}`, tenant?.status === expected, `${JSON.stringify(tenant)}`);
    }

    // A price this deployment does not sell cannot set a tier, and must not
    // default to one.
    created += 10;
    const foreign = stripeEvent('customer.subscription.updated', subscriptionObject({ id: 'sub_states', customer: 'cus_states', price: { ...PRO_PRICE, lookup_key: 'someone_elses_price' } }), { created });
    await deliver(hostedEnv(), foreign);
    check('an off-catalogue subscription price changes nothing', (await store.getTenant('user_states'))?.tier === 'pro', JSON.stringify(await store.getTenant('user_states')));

    const unknown = stripeEvent('payment_method.attached', { id: 'pm_1', object: 'payment_method' });
    const ignored = await deliver(hostedEnv(), unknown);
    check('an unhandled event type is 2xx and records no row', ignored.status === 200 && ignored.body?.status === 'ignored' && (await eventRow(unknown.id)) === null, `${ignored.status} ${JSON.stringify(ignored.body)}`);

    const malformed = await deliver(hostedEnv(), null, { raw: '{"id":"evt_no_data","type":"customer.subscription.updated","created":1}' });
    check('a body with no data.object is 2xx (a retry cannot fix it)', malformed.status === 200, `${malformed.status} ${JSON.stringify(malformed.body)}`);
    const notJson = await deliver(hostedEnv(), null, { raw: 'not json at all' });
    check('a non-JSON body is 2xx too', notJson.status === 200, `${notJson.status} ${JSON.stringify(notJson.body)}`);
  } finally {
    stub.restore();
  }
}

// ══ 9. Replay convergence (task 5.9, requirements 13, 14) ══════════════════
//
// THE PROPERTY THIS SUITE EXISTS FOR.
//
// Requirements 13 and 14 together make one claim that no fixed fixture can
// establish: Stripe delivers at least once and promises NO ordering, so the
// tenant row a set of events produces must not depend on the order they arrive
// in, or on how many times each one is redelivered. Sections 3 and 8 above check
// three hand-picked orderings. This checks the combinatorial space.
//
// Shape of the property. A SCENARIO is an abstract list of events; its array
// position IS its `created` order, so index i carries `created = BASE + i*10` and
// every timestamp is distinct. Each scenario is then materialized and delivered
// TWICE, into two fully isolated tenants:
//
//   run "a"  - `created` order, each event exactly once     <- the reference
//   run "b"  - an arbitrary permutation, with up to three
//              duplicate deliveries spliced in anywhere     <- the replay
//
// and the two final states must be identical. Every id is namespaced by run
// (`user_conv_a7`, `cus_conv_a7`, `pi_conv_a7_1`, `evt_conv_a7_3`), because
// `tenants.id`, `stripe_events.id`, the partial unique index on
// `stripe_customer_id` and `credit_grants.stripe_payment_id` are all GLOBAL: a
// shared id would make one iteration's leftovers the next one's input and the
// property would pass by accident.
//
// What "the same state" means, spelled out - getting this wrong is how the
// property goes vacuous:
//
//  - `tier` and `status` are elected by the event with the HIGHEST `created`,
//    because that is precisely what the `billing_event_at` watermark enforces.
//    Asserted ABSOLUTELY against that event, not just as run a == run b, so a
//    handler that ignored every event would not pass.
//  - `billing_event_at` must end at the max `created` among APPLIED
//    subscription-state events. An event that writes nothing (an off-catalogue
//    price, a pack purchase, an invoice with no subscription, an unresolvable
//    event) must NOT advance it, or it would censor a legitimate later event.
//  - `credit_grants` are NOT watermark-ordered and each is keyed on its payment
//    id, so total granted credits must equal the sum over DISTINCT payment ids -
//    regardless of order, duplication, or a plan change landing in between.
//  - an event that resolves to nobody must be recorded `unresolved` whatever the
//    order, and every delivered event must leave a row: losing one silently is
//    the failure requirement 3 exists to prevent.
//
// Note what this exercises about the handler's ordering choice. The event row is
// written AFTER the work rather than claimed before it, which trades a narrow
// double-apply for never losing an event to a crash - safe only if every apply is
// independently idempotent. The duplicate deliveries in run "b" are what tests
// that claim, and it holds: a grant is keyed on the payment and a state write SETS
// tier and status rather than incrementing them.

console.log('\nProperty: delivery order cannot change the outcome (task 5.9, requirements 13, 14)');

/**
 * Iterations per property. Each one is TWO full scenario deliveries against two
 * fresh tenants, so a few dozen real D1 round trips - which is why this is 120
 * rather than the 1000 a pure property would run at, and why every read in
 * {@link readConvergedState} is batched.
 *
 * 120 is not arbitrary, and it is a COMPROMISE. The divergences section 10 names
 * are reachable by this generator but RARE: 60 runs missed them and 400 found one.
 * So 120 is the number this suite can afford on every push, not the number that
 * establishes anything on its own - the fix was verified at 600 runs, and any
 * future change to the ordering model deserves the same before it is believed.
 * Never lower it to buy back seconds.
 */
const CONVERGENCE_RUNS = 120;
/** Well above every `created` the sections above used, so no watermark is shared. */
const CONVERGENCE_BASE = NOW_SECONDS + 1_000_000;
/** Gap between consecutive `created` values. Only distinctness matters. */
const CONVERGENCE_STEP = 10;

const TEAM_PRICE = { ...PRO_PRICE, id: 'price_team_monthly', lookup_key: 'phorma_team_monthly', unit_amount: 20000, metadata: { tier: 'team' } };
const TIER_PRICE = { starter: STARTER_PRICE, pro: PRO_PRICE, team: TEAM_PRICE };
/** A real, active price that is simply not on this deployment's allowlist. */
const FOREIGN_PRICE = { ...PRO_PRICE, id: 'price_not_ours', lookup_key: 'someone_elses_price' };

/**
 * Pack slot -> the catalogue price it buys. A slot maps to ONE pack for the whole
 * suite, which is what makes "the sum over distinct payment ids" a well-defined
 * claim: two `topup` events on the same slot are the same money delivered twice.
 * `unit_amount` is above the derived cost basis in every case, or `topUpForPrice`
 * would refuse the pack for granting more budget than it charges.
 */
const PACK_PRICE = [
  { ...TOPUP_PRICE, id: 'price_topup_small', lookup_key: 'phorma_topup_small', unit_amount: 1000, metadata: { credits: '500' } },
  { ...TOPUP_PRICE, id: 'price_topup_medium', lookup_key: 'phorma_topup_medium', unit_amount: 2000, metadata: { credits: '1250' } },
  { ...TOPUP_PRICE, id: 'price_topup_large', lookup_key: 'phorma_topup_large', unit_amount: 4000, metadata: { credits: '2500' } },
];
/** Credits and the starter-derived USD basis per slot (4/1000 = $0.004 a credit). */
const PACK_CREDITS = [500, 1250, 2500];
const PACK_COST_USD = [2, 5, 10];

/** The tenant status each generated subscription status must produce. */
const EXPECTED_STATUS = { active: 'active', trialing: 'active', past_due: 'past_due' };

/** The baseline every scenario starts from: a paying tenant with a runtime key. */
const BASELINE = { tier: 'starter', status: 'active' };

const ENV = hostedEnv();

/**
 * A subscription event that SUPPLIES complete state - it carries its own price
 * (so a tier) and its own status, and therefore needs nothing from the stored
 * row.
 */
const supplyingArb = fc.record({
  kind: fc.constantFrom('sub-created', 'sub-updated'),
  tier: fc.constantFrom('starter', 'pro', 'team'),
  status: fc.constantFrom('active', 'trialing', 'past_due'),
});

/**
 * Everything this endpoint can be sent, weighted towards the events that write
 * state. The three no-op families (`sub-foreign`, `inv-oneoff`, `orphan`) are in
 * deliberately: an event that changes nothing must also ORDER nothing, and a
 * handler that advanced a clock on one of them would look correct in every example
 * test above.
 *
 * `checkout-sub` earns its place for one specific reason: it is the ONLY event
 * that supplies the buyer's EMAIL, and `upsertTenant` fills that column exactly
 * once. A handler that skipped the whole write for an event it judged stale would
 * lose the address whenever the checkout happened to arrive after a newer event -
 * which is a real defect that lived here, so the generator has to be able to reach
 * it.
 */
const anyEventArb = fc.oneof(
  { weight: 5, arbitrary: supplyingArb },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('checkout-sub') }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('inv-failed') }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('inv-paid') }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('sub-deleted') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('topup'), slot: fc.integer({ min: 0, max: PACK_PRICE.length - 1 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('sub-foreign') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('inv-oneoff') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('orphan') }) },
);

// --- The model: which register does each event family SUPPLY? --------------
//
// This is the whole of `0004_billing_ordering.sql`'s semantics, restated
// independently of the handler so the property has an ABSOLUTE oracle rather than
// only a run-a == run-b comparison. A handler that ignored every event, or that
// applied them all in delivery order, satisfies the comparison and fails this.
//
// Read the three sets as the answer to "what does this event actually KNOW":
//
//   a tier            only an event carrying a PRICE. An invoice and a
//                     cancellation carry none, which is why they may not touch the
//                     tier clock and why a single scalar watermark could not work.
//   a lifecycle       any `customer.subscription.*`, plus the subscription behind
//   status            a subscription-mode checkout.
//   a dunning status  an `invoice.*` attached to a subscription.
//
// `sub-foreign` (a real price this deployment does not sell), `inv-oneoff` (a pack
// invoice) and `orphan` (nobody to attach it to) supply NOTHING and appear in none
// of the sets. `topup` writes a grant, which is outside every clock on purpose.

const SUPPLIES_TIER = new Set(['sub-created', 'sub-updated', 'checkout-sub']);
const SUPPLIES_LIFECYCLE = new Set(['sub-created', 'sub-updated', 'sub-deleted', 'checkout-sub']);
const SUPPLIES_DUNNING = new Set(['inv-failed', 'inv-paid']);
/** Every kind that writes the tenant row, so it maps the subscription and moves the audit column. */
const WRITES_TENANT = new Set([...SUPPLIES_TIER, ...SUPPLIES_LIFECYCLE, ...SUPPLIES_DUNNING]);

/** The tier an event supplies. `checkout-sub` reads it off the registered subscription (PRO_PRICE). */
function suppliedTier(spec) {
  return spec.kind === 'checkout-sub' ? 'pro' : spec.tier;
}
/** The lifecycle status an event supplies, through the same mapping the handler uses. */
function suppliedLifecycleStatus(spec) {
  if (spec.kind === 'sub-deleted') return 'canceled';
  if (spec.kind === 'checkout-sub') return 'active';
  return EXPECTED_STATUS[spec.status];
}

/**
 * The tenant state a scenario MUST produce, computed from the event set alone.
 *
 * Each register is the value of the newest event that supplies it - and because a
 * scenario's array position IS its `created` order, "newest" is just the last one
 * in this loop. That is the point of the whole model: a register is a function of
 * the SET, never of the delivery order, so this function needs no notion of
 * delivery at all.
 *
 * The status fold is the one part that is not a plain last-writer-wins: a
 * cancellation is never undone by an invoice, whatever the timestamps, while a
 * genuine later resubscription still wins. See the migration for why that needs two
 * clocks rather than one.
 */
function expectedState(kinds) {
  let tier = BASELINE.tier;
  let tierAt = 0;
  let lifecycle = BASELINE.status;
  let lifecycleAt = 0;
  let dunning = null;
  let dunningAt = 0;
  let eventAt = 0;
  let hasEmail = false;

  kinds.forEach((spec, index) => {
    const created = CONVERGENCE_BASE + index * CONVERGENCE_STEP;
    if (SUPPLIES_TIER.has(spec.kind)) {
      tier = suppliedTier(spec);
      tierAt = created;
    }
    if (SUPPLIES_LIFECYCLE.has(spec.kind)) {
      lifecycle = suppliedLifecycleStatus(spec);
      lifecycleAt = created;
    }
    if (SUPPLIES_DUNNING.has(spec.kind)) {
      dunning = spec.kind === 'inv-failed' ? 'past_due' : 'active';
      dunningAt = created;
    }
    if (WRITES_TENANT.has(spec.kind)) eventAt = created;
    if (spec.kind === 'checkout-sub') hasEmail = true;
  });

  return {
    tier,
    status: lifecycle === 'canceled' ? 'canceled' : dunningAt > lifecycleAt ? dunning : lifecycle,
    billingEventAt: eventAt,
    billingTierAt: tierAt,
    billingStatusAt: lifecycleAt,
    billingDunningStatus: dunning,
    billingDunningAt: dunningAt,
    hasEmail,
    // The baseline write maps the customer, so this holds with no events at all.
    customerMapped: true,
    subscriptionMapped: kinds.some((spec) => WRITES_TENANT.has(spec.kind)),
  };
}

/** The modelled half of an observed state, so the two can be compared field for field. */
function modelView(state) {
  return {
    tier: state.tier,
    status: state.status,
    billingEventAt: state.billingEventAt,
    billingTierAt: state.billingTierAt,
    billingStatusAt: state.billingStatusAt,
    billingDunningStatus: state.billingDunningStatus,
    billingDunningAt: state.billingDunningAt,
    hasEmail: state.hasEmail,
    customerMapped: state.customerMapped,
    subscriptionMapped: state.subscriptionMapped,
  };
}

/**
 * A delivery order over `length` events: a FULL permutation of every index, with
 * up to three duplicate indices spliced in at arbitrary positions. Every event is
 * therefore delivered at least once in both runs, which is what makes the two
 * runs comparable at all - a subset would be testing something else.
 */
function deliveryArb(length) {
  const indices = Array.from({ length }, (_, index) => index);
  return fc.array(fc.nat({ max: length - 1 }), { maxLength: 3 }).chain((duplicates) => {
    const multiset = [...indices, ...duplicates];
    return fc.shuffledSubarray(multiset, { minLength: multiset.length, maxLength: multiset.length });
  });
}

/**
 * A scenario plus its replay order. `tailArb` generates the LAST (highest
 * `created`) event separately so a property can constrain what the watermark
 * elects without discarding runs through `fc.pre`.
 */
function scenarioArb(tailArb) {
  return fc.tuple(fc.array(anyEventArb, { maxLength: 5 }), tailArb).chain(([body, tail]) => {
    const kinds = [...body, tail];
    return fc.record({ kinds: fc.constant(kinds), delivery: deliveryArb(kinds.length) });
  });
}

/** Turns one abstract event into the signed payload Stripe would deliver. */
function materializeEvent(spec, index, ids, runId) {
  const created = CONVERGENCE_BASE + index * CONVERGENCE_STEP;
  const id = `evt_conv_${runId}_${index}`;
  const invoice = (extra) => ({
    id: `in_conv_${runId}_${index}`,
    object: 'invoice',
    customer: ids.customerId,
    ...extra,
  });
  const subscription = (options) =>
    subscriptionObject({ id: ids.subscriptionId, customer: ids.customerId, ...options });

  switch (spec.kind) {
    case 'sub-created':
    case 'sub-updated':
      return stripeEvent(
        spec.kind === 'sub-created' ? 'customer.subscription.created' : 'customer.subscription.updated',
        subscription({ status: spec.status, price: TIER_PRICE[spec.tier] }),
        { id, created },
      );
    case 'sub-deleted':
      return stripeEvent('customer.subscription.deleted', subscription({ status: 'canceled' }), { id, created });
    case 'inv-failed':
      return stripeEvent('invoice.payment_failed', invoice({ subscription: ids.subscriptionId }), { id, created });
    case 'inv-paid':
      return stripeEvent('invoice.paid', invoice({ subscription: ids.subscriptionId }), { id, created });
    // A one-off pack invoice: authentic, understood, and says nothing about a plan.
    case 'inv-oneoff':
      return stripeEvent('invoice.payment_failed', invoice({}), { id, created });
    // Authentically signed, but selling a price this deployment does not offer.
    case 'sub-foreign':
      return stripeEvent('customer.subscription.updated', subscription({ price: FOREIGN_PRICE }), { id, created });
    case 'topup':
      return stripeEvent(
        'checkout.session.completed',
        {
          id: `cs_conv_${runId}_${spec.slot}`,
          object: 'checkout.session',
          mode: 'payment',
          client_reference_id: ids.tenantId,
          customer: ids.customerId,
          payment_intent: `pi_conv_${runId}_${spec.slot}`,
          payment_status: 'paid',
        },
        { id, created },
      );
    case 'checkout-sub':
      return stripeEvent(
        'checkout.session.completed',
        {
          id: `cs_conv_${runId}_s${index}`,
          object: 'checkout.session',
          mode: 'subscription',
          client_reference_id: ids.tenantId,
          customer: ids.customerId,
          subscription: ids.subscriptionId,
          payment_status: 'paid',
          customer_details: { email: `conv_${runId}@example.com` },
        },
        { id, created },
      );
    // A customer carrying no metadata and mapped to no tenant: there is genuinely
    // nobody to attach this to, in any order.
    case 'orphan':
      return stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ id: `sub_conv_orphan_${runId}`, customer: ids.orphanCustomerId }),
        { id, created },
      );
    default:
      throw new Error(`unknown scenario kind ${String(spec.kind)}`);
  }
}

/**
 * The comparable end state of one run, with every run-scoped id normalized away
 * so two runs against different tenants can be compared field for field.
 */
async function readConvergedState(ids, events, runId) {
  const tenant = await store.getTenant(ids.tenantId);
  const grants = await grantRows(ids.tenantId);
  const paymentPrefix = `pi_conv_${runId}_`;
  // ONE query rather than one per event. Every D1 call here is a loopback round
  // trip and the property makes thousands of them, so a per-event read would be
  // most of the suite's runtime for no extra coverage.
  const recorded = new Map();
  const eventIds = events.map((event) => event.id);
  const { results } = await DB.prepare(
    `SELECT id, status FROM stripe_events WHERE id IN (${eventIds.map(() => '?').join(',')})`,
  )
    .bind(...eventIds)
    .all();
  for (const row of results ?? []) recorded.set(row.id, row.status);
  const statuses = events.map((event) => recorded.get(event.id) ?? 'MISSING');

  return {
    tier: tenant?.tier ?? null,
    status: tenant?.status ?? null,
    billingEventAt: tenant?.billingEventAt ?? null,
    // The three ordering clocks and the dunning register are compared too, not
    // just the folded `status` they produce. A handler that reached the right
    // status through the wrong clocks would pass on this scenario and fail on the
    // next one that builds on the row it left behind.
    billingTierAt: tenant?.billingTierAt ?? null,
    billingStatusAt: tenant?.billingStatusAt ?? null,
    billingDunningStatus: tenant?.billingDunningStatus ?? null,
    billingDunningAt: tenant?.billingDunningAt ?? null,
    customerMapped: tenant?.stripeCustomerId === ids.customerId,
    subscriptionMapped: tenant?.stripeSubscriptionId === ids.subscriptionId,
    hasEmail: Boolean(tenant?.email),
    grantCount: grants.length,
    credits: grants.reduce((sum, grant) => sum + grant.credits, 0),
    // Rounded because the basis is a float product and the two runs must compare
    // by value, not by IEEE accumulation order.
    costUsd: Number(grants.reduce((sum, grant) => sum + grant.cost_usd, 0).toFixed(6)),
    slots: grants.map((grant) => grant.stripe_payment_id.slice(paymentPrefix.length)).sort().join(','),
    unresolved: statuses.flatMap((status, index) => (status === 'unresolved' ? [index] : [])).join(','),
    everyEventRecorded: statuses.every((status) => status !== 'MISSING'),
  };
}

/**
 * Materializes a scenario against a fresh tenant and delivers it in `order`.
 *
 * The tenant row is pre-created rather than left to a checkout event, so the
 * property is about ORDER and not about whether a row happened to exist yet - and
 * so the runtime key exists for a cancellation to disable.
 */
async function deliverScenario(kinds, order, runId) {
  const ids = {
    tenantId: `user_conv_${runId}`,
    customerId: `cus_conv_${runId}`,
    orphanCustomerId: `cus_conv_orphan_${runId}`,
    subscriptionId: `sub_conv_${runId}`,
  };

  // Resolution path 2 for the real customer, so identity never depends on which
  // event mapped it first. Path 3 is what the orphan proves absent.
  CUSTOMERS[ids.customerId] = { id: ids.customerId, metadata: { clerk_user_id: ids.tenantId } };
  CUSTOMERS[ids.orphanCustomerId] = { id: ids.orphanCustomerId, metadata: {} };
  // Only a subscription-mode checkout reads this back; registered unconditionally
  // because it costs nothing and a missing one would read as a Stripe outage.
  SUBSCRIPTIONS[ids.subscriptionId] = subscriptionObject({
    id: ids.subscriptionId,
    customer: ids.customerId,
    status: 'active',
    price: PRO_PRICE,
  });
  for (let slot = 0; slot < PACK_PRICE.length; slot += 1) {
    LINE_ITEMS[`cs_conv_${runId}_${slot}`] = [{ id: 'li_1', quantity: 1, price: PACK_PRICE[slot] }];
  }

  await store.upsertTenant({
    id: ids.tenantId,
    tier: BASELINE.tier,
    status: BASELINE.status,
    stripeCustomerId: ids.customerId,
    openrouterKeyId: `hash_conv_${runId}`,
    openrouterKeyEnc: `enc_conv_${runId}`,
  });

  const events = kinds.map((spec, index) => materializeEvent(spec, index, ids, runId));
  for (const index of order) await deliver(ENV, events[index]);
  return readConvergedState(ids, events, runId);
}

/** The grant and bookkeeping half of a state, which holds with no precondition. */
function grantView(state) {
  const { grantCount, credits, costUsd, slots, unresolved, everyEventRecorded } = state;
  return { grantCount, credits, costUsd, slots, unresolved, everyEventRecorded };
}

/** What the scenario's pack purchases must add up to, over DISTINCT payment ids. */
function expectedGrants(kinds) {
  const slots = [...new Set(kinds.filter((spec) => spec.kind === 'topup').map((spec) => spec.slot))].sort();
  return {
    grantCount: slots.length,
    credits: slots.reduce((sum, slot) => sum + PACK_CREDITS[slot], 0),
    costUsd: Number(slots.reduce((sum, slot) => sum + PACK_COST_USD[slot], 0).toFixed(6)),
    slots: slots.map(String).sort().join(','),
    unresolved: kinds.flatMap((spec, index) => (spec.kind === 'orphan' ? [index] : [])).join(','),
    everyEventRecorded: true,
  };
}

function differs(name, expected, actual, context) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  throw new Error(
    `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} for ${context}`,
  );
}

const convStub = stripeStub();
let convIteration = 0;

try {
  // ── C1: the whole tenant state converges ──────────────────────────────────
  //
  // EVERY position is unconstrained, including the last one. It was not always:
  // the newest event used to be forced to a `customer.subscription.created`
  // /`.updated`, which SUPPLIES both tier and status rather than restating what it
  // read off the row. That constraint hid three real order-dependence defects, all
  // of them one root cause - `billing_event_at` was a single scalar gating every
  // subscription-state write, so a RESTATING event that arrived first advanced it
  // and censored the older SUPPLYING event behind it. The tier, and the buyer's
  // email, were then lost for good.
  //
  // `0004_billing_ordering.sql` replaced the scalar with one clock per field, and
  // this generator is the region that fixed. Two warnings for whoever touches it:
  //
  //  - the defect was RARE under this generator: 60 runs missed it, 400 found it.
  //    A green run of a widened property is weak evidence, so do not narrow the
  //    generator to buy back seconds, and do not read a pass at a low `numRuns` as
  //    proof. Verified at 600 runs when the fix landed.
  //  - the oracle is ABSOLUTE. `expectedState` recomputes the whole row from the
  //    event set with no notion of delivery, so a handler that applied everything
  //    in arrival order fails here even though run a and run b would agree.
  await fc.assert(
    fc.asyncProperty(scenarioArb(anyEventArb), async ({ kinds, delivery }) => {
      convIteration += 1;
      const inCreatedOrder = kinds.map((_, index) => index);
      const reference = await deliverScenario(kinds, inCreatedOrder, `a${convIteration}`);
      const replayed = await deliverScenario(kinds, delivery, `b${convIteration}`);
      // The handler is chatty and both arrays are per-process; dropped each
      // iteration so a 120-run property does not accumulate megabytes.
      convStub.calls.length = 0;
      convStub.logs.length = 0;

      const context = `${JSON.stringify(kinds)} delivered as ${JSON.stringify(delivery)}`;
      differs('replay diverged from created order', reference, replayed, context);

      // ABSOLUTE, not merely equal: both runs are checked against the model, so a
      // handler that ignored every event - or one that agreed with itself while
      // being wrong - fails here rather than passing the comparison above.
      const model = expectedState(kinds);
      differs('created order did not match the model', model, modelView(reference), context);
      differs('the replay did not match the model', model, modelView(replayed), context);
      differs('grants did not total the distinct payments', expectedGrants(kinds), grantView(replayed), context);
      return true;
    }),
    { numRuns: CONVERGENCE_RUNS },
  );
  check(`tenant state converges across ${CONVERGENCE_RUNS} replay orders`, true);

  // ── C2: grants and event bookkeeping hold with NO precondition ────────────
  //
  // C1 now covers the same generator, so this is no longer about reaching a region
  // C1 cannot. It is about the half of the state that has NO ordering rule at all:
  // a grant is keyed on its payment id and deliberately consults no clock, so
  // taking money twice or granting nothing cannot be excused by a delivery order,
  // and no authentic event may go unrecorded. Kept separate because it holds under
  // a weaker premise than C1 and is worth failing on its own.
  //
  // ONE run per iteration, not two. The assertion is ABSOLUTE - the total over
  // distinct payment slots, computed from the scenario - which is strictly stronger
  // than comparing an arbitrary order against the created order, and costs half the
  // D1 traffic.
  await fc.assert(
    fc.asyncProperty(scenarioArb(anyEventArb), async ({ kinds, delivery }) => {
      convIteration += 1;
      const replayed = await deliverScenario(kinds, delivery, `c${convIteration}`);
      convStub.calls.length = 0;
      convStub.logs.length = 0;
      differs(
        'grants did not total the distinct payments',
        expectedGrants(kinds),
        grantView(replayed),
        `${JSON.stringify(kinds)} delivered as ${JSON.stringify(delivery)}`,
      );
      return true;
    }),
    { numRuns: CONVERGENCE_RUNS },
  );
  check(`grants total the distinct payments across ${CONVERGENCE_RUNS} unconstrained replay orders`, true);

  // ══ 10. The three orderings that used to diverge ═══════════════════════════
  //
  // These were pinned here as `DEFECT:` checks while `billing_event_at` was a
  // single scalar. They are kept as ordinary regression checks - not because the
  // property above cannot reach them (it now can, and does), but because each one
  // is a named production scenario and a bare property failure names none of them.
  // They are cheap: six deliveries.

  console.log('\nThe three orderings that used to lose state (0004_billing_ordering.sql)');

  // A dunning event that arrives BEFORE the upgrade it should follow. Entirely
  // realistic: Stripe emits `customer.subscription.updated` and
  // `invoice.payment_failed` a second apart and promises no order. Requirement 18
  // says a `past_due` tenant RETAINS their tier, and with one watermark it did not.
  {
    const kinds = [{ kind: 'sub-updated', tier: 'pro', status: 'active' }, { kind: 'inv-failed' }];
    const reference = await deliverScenario(kinds, [0, 1], 'd1a');
    const replayed = await deliverScenario(kinds, [1, 0], 'd1b');
    check(
      'an out-of-order invoice.payment_failed keeps the upgraded tier (requirement 18)',
      reference.tier === 'pro' && reference.status === 'past_due' &&
        replayed.tier === 'pro' && replayed.status === 'past_due',
      `created order ${JSON.stringify(reference)} vs replay ${JSON.stringify(replayed)}`,
    );
  }

  // The same censoring used to cost the buyer's email, which only a checkout
  // session ever supplies and `upsertTenant` only ever fills once. It survives
  // because a stale event still performs its write - the clocks refuse the stale
  // FIELDS, rather than the handler refusing the whole event.
  {
    const kinds = [{ kind: 'checkout-sub' }, { kind: 'inv-failed' }];
    const reference = await deliverScenario(kinds, [0, 1], 'd2a');
    const replayed = await deliverScenario(kinds, [1, 0], 'd2b');
    check(
      'an out-of-order invoice keeps the email the checkout supplied',
      reference.hasEmail === true && replayed.hasEmail === true,
      `created order ${JSON.stringify(reference)} vs replay ${JSON.stringify(replayed)}`,
    );
  }

  // The narrow one: a paid subscription invoice whose `created` is ABOVE its own
  // subscription's deletion. Stripe does not produce that ordering, but the failure
  // direction was the dangerous one - a cancelled account reading `active` - and
  // the guard that prevents it now lives in the fold rather than in a read of
  // whatever the row happened to say at the time.
  {
    const kinds = [{ kind: 'sub-deleted' }, { kind: 'inv-paid' }];
    const reference = await deliverScenario(kinds, [0, 1], 'd3a');
    const replayed = await deliverScenario(kinds, [1, 0], 'd3b');
    check(
      'an invoice newer than the cancellation does NOT reactivate a cancelled tenant',
      reference.status === 'canceled' && replayed.status === 'canceled',
      `created order ${JSON.stringify(reference)} vs replay ${JSON.stringify(replayed)}`,
    );
  }
} finally {
  convStub.restore();
}

await mf.dispose();
console.log(failures === 0 ? '\nAll Stripe webhook checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
