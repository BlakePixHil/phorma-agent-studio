/**
 * The billing routes - `POST /api/checkout`, `POST /api/billing-portal` and
 * `GET /billing/return` (task group 4, requirements 2, 4, 5, 6, 27, 28, 32, 46,
 * 47, 48).
 *
 * What is actually at stake here is the REQUEST WE BUILD, not what Stripe says
 * back. Four of these parameters are the difference between a working
 * integration and a broken one, and none of them is a type error when it is
 * wrong:
 *
 *  - `client_reference_id` and `metadata.clerk_user_id` are the two independent
 *    paths a webhook has back to the tenant (requirement 2). Omit both and a
 *    completed payment cannot find the account that made it - money taken for
 *    nothing.
 *  - `automatic_tax`, `billing_address_collection` and `customer_update.address`
 *    are what make an INCLUSIVE price computable (requirements 46-48). Every
 *    price in the catalogue is tax-inclusive, so without a jurisdiction Stripe
 *    cannot split the published number into net and tax - and with an existing
 *    customer Stripe rejects the session outright unless `customer_update` says
 *    which address to trust.
 *  - the CUSTOMER is reused rather than recreated (requirement 4), from the
 *    stored mapping first and the metadata search second, with an idempotency key
 *    on the create so a double-clicked button cannot leave two customers behind.
 *  - the routes sit after the hosted-bindings gate and outside the admin branch
 *    (requirement 32), so a BYO worker and a non-admin caller both behave.
 *
 * Harness. The routes are imported and called DIRECTLY over a REAL local D1
 * (Miniflare's SQLite binding reached from Node, with the real migrations
 * applied), the same shape `tenant-billing.test.mjs` uses - so no
 * `dispatchFetch`, no loopback socket per request, and the SQL under test is the
 * SQL that ships.
 *
 * Authorization is NOT stubbed. An RSA keypair is generated here, the public half
 * is handed to the worker as `CLERK_JWT_KEY`, and each case signs its own RS256
 * session JWT with the private half, so `@clerk/backend` verifies for real on its
 * offline path. That is what makes the authenticated 200 reachable at all rather
 * than asserted around.
 *
 * The ONE thing replaced is Stripe: `globalThis.fetch` is stubbed per case and
 * every call is captured with its decoded form body, so each assertion below is
 * about a parameter this worker chose to send.
 *
 * Run: npx tsx cloud/test/billing-routes.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected to the
// same stub `status.test.mjs` uses, before the module graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { handleApiRequest, handleBillingReturnRequest, handleSignedInRequest } = await import(
  '../src/api.ts'
);
const { TenantStore } = await import('../src/tenants.ts');

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

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  // Only the binding is used; nothing here goes through a worker route.
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-billing-routes' },
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

// --- A real session token --------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A real RS256 session token for `sub`, plus whatever extra claims a case needs.
 *
 * `claims` is how the organisation cases below name an organisation: the token is
 * verified for real, so `auth.orgId` comes off a VERIFIED claim exactly as it does
 * in production rather than from a stubbed context.
 */
function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-billing-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// --- Environment shapes ----------------------------------------------------

const SECRET_KEY = 'sk_test_billing_do_not_leak';
const ADMIN_TOKEN = 'admin-token-not-a-billing-credential';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';
const RETURN_URL = `${ORIGIN}/billing/return`;

/** A hosted worker with D1, Clerk and (optionally) Stripe configured. */
function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    PHORMA_ADMIN_TOKEN: ADMIN_TOKEN,
    STRIPE_SECRET_KEY: SECRET_KEY,
    DB,
    ...extra,
  };
}

// --- The Stripe stub -------------------------------------------------------

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const realConsoleWarn = console.warn;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The catalogue prices the stub serves, by lookup key. */
const PRICES = {
  phorma_starter_monthly: {
    id: 'price_starter_monthly',
    active: true,
    type: 'recurring',
    lookup_key: 'phorma_starter_monthly',
    currency: 'usd',
    unit_amount: 2000,
    tax_behavior: 'inclusive',
    recurring: { interval: 'month' },
    metadata: { tier: 'starter' },
  },
  phorma_topup_small: {
    id: 'price_topup_small',
    active: true,
    type: 'one_time',
    lookup_key: 'phorma_topup_small',
    currency: 'usd',
    unit_amount: 1000,
    tax_behavior: 'inclusive',
    metadata: { credits: '500' },
  },
};

/**
 * Installs the Stripe stub and captures every call plus every log line.
 *
 * `overrides` replaces the response for one Stripe path, so a case can inject a
 * search hit or a malformed session without restating the rest of the catalogue.
 */
function stripeStub(overrides = {}) {
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  console.error = capture;
  console.warn = capture;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? init.body : '';
    const call = {
      path: url.pathname,
      method: init.method ?? 'GET',
      query: Object.fromEntries(url.searchParams),
      params: Object.fromEntries(new URLSearchParams(body)),
      headers: init.headers ?? {},
    };
    calls.push(call);

    const override = overrides[url.pathname];
    if (override) return override(call);

    switch (url.pathname) {
      case '/v1/prices': {
        const key = url.searchParams.get('lookup_keys[0]');
        const price = PRICES[key];
        return jsonResponse({ data: price ? [price] : [] });
      }
      case '/v1/customers/search':
        return jsonResponse({ data: [] });
      case '/v1/customers':
        return jsonResponse({ id: 'cus_created', metadata: call.params });
      case '/v1/checkout/sessions':
        return jsonResponse({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      case '/v1/billing_portal/sessions':
        return jsonResponse({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' });
      default:
        throw new Error(`unexpected Stripe path ${url.pathname}`);
    }
  };

  return {
    calls,
    logs,
    callsTo: (path) => calls.filter((call) => call.path === path),
    restore: () => {
      globalThis.fetch = realFetch;
      console.error = realConsoleError;
      console.warn = realConsoleWarn;
    },
  };
}

/** One `/api/*` request through the real router. */
async function api(env, path, { method = 'POST', body, token, claims, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const authorization = bearer ?? (token ? `Bearer ${mintToken(token, claims)}` : null);
  if (authorization) headers.Authorization = authorization;
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleApiRequest(request, env, CORS, CTX);
  return {
    status: response?.status ?? 0,
    body: response ? await response.json().catch(() => null) : null,
  };
}

// --- Self-containment ------------------------------------------------------

/**
 * Every `src`, `href` or `xlink:href` value in `html`, including the SVG forms,
 * so a `<use href>` cannot slip past a check written only for `src`.
 */
function referenceValues(html) {
  return [...html.matchAll(/(?:xlink:href|src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    ([, doubleQuoted, singleQuoted]) => (doubleQuoted ?? singleQuoted ?? '').trim(),
  );
}

/**
 * Whether any reference in `html` would cause a NETWORK request.
 *
 * The rule is deliberately an allowlist of exactly one shape - a `data:` URI -
 * rather than a blocklist of schemes, so a form nobody thought of fails closed.
 * Everything else counts as remote: any `scheme:` prefix (`https:`, `http:`,
 * `//host`, and anything exotic), and any path (`/favicon.ico`, `logo.svg`), since
 * a root-relative path on this Worker is still a request it would have to serve.
 *
 * An EMPTY value is remote too. `href=""` resolves to the current document, which
 * is a real second request for this page.
 */
function remoteReference(html) {
  return referenceValues(html).some((value) => !value.toLowerCase().startsWith('data:'));
}

function remoteReferenceDetail(html) {
  const remote = referenceValues(html).filter(
    (value) => !value.toLowerCase().startsWith('data:'),
  );
  return remote.length > 0 ? `remote references: ${JSON.stringify(remote).slice(0, 200)}` : '';
}

// Prove the guard above is not vacuous: it must actually reject the shapes it
// claims to, or "no remote references" becomes a sentence that is true of
// everything. Runs before the page assertions so a broken matcher fails first.
console.log('\nThe self-containment guard rejects every remote reference shape');
{
  const remoteCases = [
    '<img src="https://cdn.example.com/logo.png">',
    '<img src="//cdn.example.com/logo.png">',
    '<link rel="icon" href="/favicon.ico">',
    '<link rel="stylesheet" href="styles.css">',
    '<svg><use href="#icon"/></svg>',
    '<svg><use xlink:href="sprite.svg#icon"/></svg>',
    '<a href="">self</a>',
  ];
  for (const markup of remoteCases) {
    check(`rejects ${markup.slice(0, 46)}`, remoteReference(markup), markup);
  }
  const localCases = [
    '<link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">',
    '<svg class="brand__mark" viewBox="0 0 600 600"><path d="M1 2H3"/></svg>',
    '<p>no references at all</p>',
  ];
  for (const markup of localCases) {
    check(`accepts ${markup.slice(0, 46)}`, !remoteReference(markup), markup);
  }
}

// ══ 1. GET /billing/return (task 4.3, requirement 27) ═══════════════════════

console.log('\nGET /billing/return - the page a browser lands on');
{
  const page = handleBillingReturnRequest(new Request(`${RETURN_URL}?status=complete`));
  const html = await page.text();

  check('answers 200 with HTML', page.status === 200 && /text\/html/.test(page.headers.get('Content-Type')), `${page.status} ${page.headers.get('Content-Type')}`);
  // A top-level navigation, not an XHR. Widening the authenticated surface for it
  // would be the wrong fix for a problem it does not have.
  check('carries NO CORS header', page.headers.get('Access-Control-Allow-Origin') === null, String(page.headers.get('Access-Control-Allow-Origin')));
  check('declares a no-load CSP', /default-src 'none'/.test(page.headers.get('Content-Security-Policy') ?? ''), String(page.headers.get('Content-Security-Policy')));
  // Two independent directives, not one exact string, so directive order cannot
  // make this brittle. `no-transform` stops Cloudflare's proxy injecting the Web
  // Analytics beacon into this HTML - the CSP above would block it and log a
  // violation for a script the page never asked for.
  check('is not cached', /\bno-store\b/.test(page.headers.get('Cache-Control') ?? ''), String(page.headers.get('Cache-Control')));
  check('forbids the proxy rewriting the HTML', /\bno-transform\b/.test(page.headers.get('Cache-Control') ?? ''), String(page.headers.get('Cache-Control')));
  // Self-contained: no script, and nothing fetched over the network.
  check('carries no script', !/<script/i.test(html), html.slice(0, 120));
  // NARROWED from "no src= or href= at all" when the page gained its brand mark
  // and favicon. The claim that matters is that this page makes NO NETWORK
  // REQUEST, which is what lets its CSP be `default-src 'none'` and what keeps it
  // rendering offline and in a hardened browser. An inline `<svg>` is not a fetch,
  // and a `data:` favicon is not a fetch. A remote reference still is, so every
  // scheme and every protocol-relative or root-relative path is refused - and
  // `<use href>` / `xlink:href` with them, since those WOULD be fetches.
  check('references nothing over the network', !remoteReference(html), remoteReferenceDetail(html));
  check('carries the Phorma brand mark inline', /<svg[^>]*class="brand__mark"/.test(html), html.slice(0, 200));
  check('tells the user to close the tab', /close this tab/i.test(html), html);
  // Requirement 10: the webhook is the only writer of subscription state, so this
  // page must not claim a tier or a status it cannot know yet.
  check('claims no billing state', !/\b(starter|pro|team|active|credits)\b/i.test(html), html);

  const cancelled = await handleBillingReturnRequest(
    new Request(`${RETURN_URL}?status=cancelled`),
  ).text();
  check('a cancelled return says nothing was charged', /nothing was charged/i.test(cancelled), cancelled);

  // The one query value it reads is compared against a literal, never rendered.
  const injected = await handleBillingReturnRequest(
    new Request(`${RETURN_URL}?status=${encodeURIComponent('<script>alert(1)</script>')}`),
  ).text();
  check('reflects nothing from the query string', !/alert\(1\)/.test(injected) && !/<script/i.test(injected), injected.slice(0, 200));

  const posted = handleBillingReturnRequest(new Request(RETURN_URL, { method: 'POST' }));
  check('a POST is 405 rather than a confusing 404', posted.status === 405 && posted.headers.get('Allow') === 'GET, HEAD', `${posted.status} ${posted.headers.get('Allow')}`);
  check('another path is not this route', handleBillingReturnRequest(new Request(`${ORIGIN}/billing`)) === null);
  check('the page is not an /api/ route', (await handleApiRequest(new Request(RETURN_URL), hostedEnv(), CORS, CTX)) === null);
}

// ══ 1b. GET /signed-in - the Clerk post-sign-in landing page ════════════════
//
// Not a billing route, but it is the same SHAPE of route - a public top-level
// navigation performed by a third party, no bearer, no CORS, static markup - and
// this suite already owns the harness that proves those properties. A file of its
// own would pay the Miniflare bundle cost again to assert the same six things.
//
// It exists because the Clerk instance's `after_sign_in_url` was
// `https://app.phorma-labs.com`, a host with NO DNS record, so every social
// sign-in finished on a browser error page.

console.log('\nGET /signed-in - where Clerk sends the browser after sign-in');
{
  const SIGNED_IN_URL = `${ORIGIN}/signed-in`;
  const page = handleSignedInRequest(new Request(SIGNED_IN_URL));
  const html = await page.text();

  check('answers 200 with HTML', page.status === 200 && /text\/html/.test(page.headers.get('Content-Type')), `${page.status} ${page.headers.get('Content-Type')}`);
  check('carries NO CORS header', page.headers.get('Access-Control-Allow-Origin') === null, String(page.headers.get('Access-Control-Allow-Origin')));
  check('declares a no-load CSP', /default-src 'none'/.test(page.headers.get('Content-Security-Policy') ?? ''), String(page.headers.get('Content-Security-Policy')));
  check('is not cached', /\bno-store\b/.test(page.headers.get('Cache-Control') ?? ''), String(page.headers.get('Cache-Control')));
  check('forbids the proxy rewriting the HTML', /\bno-transform\b/.test(page.headers.get('Cache-Control') ?? ''), String(page.headers.get('Cache-Control')));
  check('carries no script', !/<script/i.test(html), html.slice(0, 120));
  check('references nothing over the network', !remoteReference(html), remoteReferenceDetail(html));
  check('carries the Phorma brand mark inline', /<svg[^>]*class="brand__mark"/.test(html), html.slice(0, 200));
  check('tells the user to close the tab', /close this tab/i.test(html), html);

  // The honesty assertion. The studio's own toast says the same thing, and the two
  // must not drift into telling the user different stories about one moment.
  check('says the desktop app will still read as signed out', /not available yet/i.test(html), html);

  // It reads nothing from the request at all, so there is no reflection surface -
  // which is what lets the CSP above be this strict. Clerk appends its own query
  // parameters to this redirect, so this is not a hypothetical.
  const injected = await handleSignedInRequest(
    new Request(`${SIGNED_IN_URL}?x=${encodeURIComponent('<script>alert(1)</script>')}&__clerk_status=verified`),
  ).text();
  check('reflects nothing from the query string', injected === html, injected.slice(0, 200));

  // A page with no session of its own cannot assert one, and must not imply it.
  check('claims no account state it cannot know', !/\b(starter|pro|team|active|credits|welcome back)\b/i.test(html), html);

  const posted = handleSignedInRequest(new Request(SIGNED_IN_URL, { method: 'POST' }));
  check('a POST is 405 rather than a confusing 404', posted.status === 405 && posted.headers.get('Allow') === 'GET, HEAD', `${posted.status} ${posted.headers.get('Allow')}`);
  check('HEAD is answered with no body', handleSignedInRequest(new Request(SIGNED_IN_URL, { method: 'HEAD' })).status === 200);
  check('another path is not this route', handleSignedInRequest(new Request(`${ORIGIN}/signed`)) === null);
  check('the page is not an /api/ route', (await handleApiRequest(new Request(SIGNED_IN_URL), hostedEnv(), CORS, CTX)) === null);
}

// ══ 2. Placement: the gates (task 4.4, requirement 32) ══════════════════════

console.log('\nBoth routes sit after the hosted gate and outside the admin branch (requirement 32)');
{
  const stub = stripeStub();
  try {
    // A BYO worker binds no D1. Billing must be ABSENT, not attempted: the same
    // 501 every other tenant route gives, and not one Stripe call.
    const byo = { PHORMA_TOKEN: 'byo-token', STRIPE_SECRET_KEY: SECRET_KEY };
    for (const path of ['/api/checkout', '/api/billing-portal']) {
      const answer = await api(byo, path, { body: { lookupKey: 'phorma_starter_monthly' }, bearer: 'Bearer byo-token' });
      check(`${path} on a BYO worker is 501 about hosted bindings`, answer.status === 501 && /hosted bindings/i.test(answer.body?.error ?? ''), `${answer.status} ${JSON.stringify(answer.body)}`);
    }
    check('a BYO worker made no Stripe call at all', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => c.path)));

    // The admin token is not a billing credential: these routes take a Clerk JWT
    // and nothing else, so an operator bearer reads 401 like any other stranger.
    for (const path of ['/api/checkout', '/api/billing-portal']) {
      const asAdmin = await api(hostedEnv(), path, { body: { lookupKey: 'phorma_starter_monthly' }, bearer: `Bearer ${ADMIN_TOKEN}` });
      check(`${path} rejects the admin token (401)`, asAdmin.status === 401, `${asAdmin.status} ${JSON.stringify(asAdmin.body)}`);
      const anonymous = await api(hostedEnv(), path, { body: { lookupKey: 'phorma_starter_monthly' } });
      check(`${path} rejects an unauthenticated caller (401)`, anonymous.status === 401, `${anonymous.status} ${JSON.stringify(anonymous.body)}`);
    }
    check('no unauthorized request reached Stripe', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => c.path)));

    // Requirement 34: unconfigured is 501 NAMING the secret, never an opaque 500.
    const noStripe = hostedEnv({ STRIPE_SECRET_KEY: undefined });
    const checkout = await api(noStripe, '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: 'user_no_stripe' });
    check('checkout without STRIPE_SECRET_KEY is 501 naming it', checkout.status === 501 && /STRIPE_SECRET_KEY/.test(checkout.body?.error ?? ''), `${checkout.status} ${JSON.stringify(checkout.body)}`);
    const portal = await api(noStripe, '/api/billing-portal', { token: 'user_no_stripe' });
    check('the portal without STRIPE_SECRET_KEY is 501 naming it', portal.status === 501 && /STRIPE_SECRET_KEY/.test(portal.body?.error ?? ''), `${portal.status} ${JSON.stringify(portal.body)}`);

    // Method-gated, so a GET falls through to the router's own 404.
    const wrongMethod = await api(hostedEnv(), '/api/checkout', { method: 'GET', token: 'user_no_stripe' });
    check('GET /api/checkout is not a route', wrongMethod.status === 404, `${wrongMethod.status} ${JSON.stringify(wrongMethod.body)}`);
  } finally {
    stub.restore();
  }
}

// ══ 3. The allowlist (task 4.1, requirements 5, 6) ══════════════════════════

console.log('\nOnly an allowlisted lookup key can be checked out (requirements 5, 6)');
{
  const stub = stripeStub();
  try {
    for (const [label, body] of [
      ['an unknown key', { lookupKey: 'phorma_free_forever' }],
      ['a price id instead of a key', { lookupKey: 'price_starter_monthly' }],
      ['no key at all', {}],
      ['a non-string key', { lookupKey: { toString: 'pro' } }],
    ]) {
      const answer = await api(hostedEnv(), '/api/checkout', { body, token: 'user_allowlist' });
      check(`${label} is refused (400 Unknown product)`, answer.status === 400 && answer.body?.error === 'Unknown product.', `${answer.status} ${JSON.stringify(answer.body)}`);
    }
    const missingBody = await api(hostedEnv(), '/api/checkout', { token: 'user_allowlist' });
    check('a missing body is refused too', missingBody.status === 400, `${missingBody.status} ${JSON.stringify(missingBody.body)}`);
    check('nothing off the allowlist reached Stripe', stub.calls.length === 0, JSON.stringify(stub.calls.map((c) => c.path)));
  } finally {
    stub.restore();
  }
}

// ══ 4. Checkout for a first-time buyer (requirements 2, 4, 46, 47, 48) ══════

console.log('\nA first-time buyer: customer created, session built (requirements 2, 4, 46-48)');
{
  const stub = stripeStub();
  const userId = 'user_first_time';
  try {
    const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: userId });
    check('answers 200 with the hosted Checkout URL', answer.status === 200 && answer.body?.url === 'https://checkout.stripe.com/c/pay/cs_test_1', `${answer.status} ${JSON.stringify(answer.body)}`);

    // The price was resolved by LOOKUP KEY against active prices, not by id.
    const priced = stub.callsTo('/v1/prices')[0];
    check('the price was looked up by lookup key', priced?.query['lookup_keys[0]'] === 'phorma_starter_monthly', JSON.stringify(priced?.query));
    check('only ACTIVE prices were considered', priced?.query['active'] === 'true', JSON.stringify(priced?.query));

    // Requirement 4's protection against a double-clicked button.
    const created = stub.callsTo('/v1/customers')[0];
    check('a customer was created', created?.method === 'POST', JSON.stringify(created));
    check('the customer carries metadata.clerk_user_id (requirement 2)', created?.params['metadata[clerk_user_id]'] === userId, JSON.stringify(created?.params));
    check('the create is idempotency-keyed (requirement 4)', typeof created?.headers['Idempotency-Key'] === 'string' && created.headers['Idempotency-Key'].includes(userId), JSON.stringify(created?.headers['Idempotency-Key']));

    const session = stub.callsTo('/v1/checkout/sessions')[0];
    const params = session?.params ?? {};
    check('mode comes from the price type', params['mode'] === 'subscription', params['mode']);
    check('the session reuses the resolved customer', params['customer'] === 'cus_created', params['customer']);
    check('client_reference_id is the verified user id (requirement 2)', params['client_reference_id'] === userId, params['client_reference_id']);
    check('session metadata carries the user id too', params['metadata[clerk_user_id]'] === userId, params['metadata[clerk_user_id]']);
    check('the line item is the resolved price id', params['line_items[0][price]'] === 'price_starter_monthly' && params['line_items[0][quantity]'] === '1', JSON.stringify(params));
    check('both return URLs point at this worker (requirement 27)', params['success_url'] === `${RETURN_URL}?status=complete` && params['cancel_url'] === `${RETURN_URL}?status=cancelled`, `${params['success_url']} | ${params['cancel_url']}`);

    // Task 4.1a. An inclusive price cannot be split without a jurisdiction, so
    // these four are what make the published number the number charged.
    check('automatic tax is on (requirement 47)', params['automatic_tax[enabled]'] === 'true', JSON.stringify(params));
    check('a billing address is collected (requirement 47)', params['billing_address_collection'] === 'required', params['billing_address_collection']);
    check('tax id collection is on (requirement 48)', params['tax_id_collection[enabled]'] === 'true', params['tax_id_collection[enabled]']);
    check('customer_update[address]=auto, which Stripe requires here', params['customer_update[address]'] === 'auto', params['customer_update[address]']);
    check('customer_update[name]=auto, so the invoice carries the legal name', params['customer_update[name]'] === 'auto', params['customer_update[name]']);
    // Subscription mode invoices on its own; asking again would be noise.
    check('no invoice_creation on a subscription', params['invoice_creation[enabled]'] === undefined, JSON.stringify(params));

    // Requirement 10: only the webhook writes subscription state. Clicking
    // Subscribe must not fabricate a tenant row, or `/api/me` would report a plan
    // nobody paid for.
    check('no tenant row was invented', (await store.getTenant(userId)) === null, JSON.stringify(await store.getTenant(userId)));
    // Requirement 33: the API key never leaves the worker.
    check('the secret key is in no log line', !stub.logs.join('\n').includes(SECRET_KEY), stub.logs.join(' | '));
    check('the secret key is in no response body', !JSON.stringify(answer.body).includes(SECRET_KEY));
  } finally {
    stub.restore();
  }
}

// ══ 5. Customer reuse (requirement 4) ══════════════════════════════════════

console.log('\nA returning buyer reuses their Stripe customer (requirement 4)');
{
  const stub = stripeStub();
  try {
    await store.upsertTenant({ id: 'user_mapped', email: 'mapped@example.com', tier: 'starter', status: 'active', stripeCustomerId: 'cus_mapped' });
    const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: 'user_mapped' });

    check('checkout succeeds', answer.status === 200, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('the stored mapping is used', stub.callsTo('/v1/checkout/sessions')[0]?.params['customer'] === 'cus_mapped', JSON.stringify(stub.callsTo('/v1/checkout/sessions')[0]?.params));
    // The stored column is the PRIMARY source, so neither a duplicate create nor
    // a search against Stripe's lagging index should happen at all.
    check('no second customer is created', stub.callsTo('/v1/customers').length === 0, JSON.stringify(stub.calls.map((c) => c.path)));
    check('no customer search is needed', stub.callsTo('/v1/customers/search').length === 0, JSON.stringify(stub.calls.map((c) => c.path)));
  } finally {
    stub.restore();
  }
}

console.log('\nAn unmapped tenant is found by metadata search, then mapped (requirement 4)');
{
  const stub = stripeStub({
    '/v1/customers/search': () => jsonResponse({ data: [{ id: 'cus_abandoned', metadata: { clerk_user_id: 'user_abandoned' } }] }),
  });
  try {
    await store.upsertTenant({ id: 'user_abandoned', email: 'abandoned@example.com', tier: 'starter', status: 'active' });
    const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: 'user_abandoned' });

    check('checkout succeeds', answer.status === 200, `${answer.status} ${JSON.stringify(answer.body)}`);
    const search = stub.callsTo('/v1/customers/search')[0];
    check('the search is by metadata.clerk_user_id', search?.query['query'] === "metadata['clerk_user_id']:'user_abandoned'", JSON.stringify(search?.query));
    check('the found customer is used, not a new one', stub.callsTo('/v1/customers').length === 0 && stub.callsTo('/v1/checkout/sessions')[0]?.params['customer'] === 'cus_abandoned', JSON.stringify(stub.calls.map((c) => c.path)));
    // Persisted, so the next checkout skips the lagging search index entirely.
    const tenant = await store.getTenant('user_abandoned');
    check('the mapping is stored on the tenant', tenant?.stripeCustomerId === 'cus_abandoned', JSON.stringify(tenant));
    check('the mapping write changed nothing else', tenant?.tier === 'starter' && tenant?.status === 'active' && tenant?.email === 'abandoned@example.com', JSON.stringify(tenant));
  } finally {
    stub.restore();
  }
}

// ══ 6. A credit pack is a one-time payment ═════════════════════════════════

console.log('\nA credit pack checks out in payment mode (requirement 48)');
{
  const stub = stripeStub();
  try {
    const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_topup_small' }, token: 'user_topup' });
    const params = stub.callsTo('/v1/checkout/sessions')[0]?.params ?? {};

    check('checkout succeeds', answer.status === 200, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('mode is payment, from the one_time price', params['mode'] === 'payment', params['mode']);
    // A one-time payment produces only a receipt unless asked, and a buyer who
    // supplied a tax id needs the invoice requirement 48 promises them.
    check('invoice creation is enabled for the one-time payment', params['invoice_creation[enabled]'] === 'true', JSON.stringify(params));
    check('tax handling is identical to a subscription', params['automatic_tax[enabled]'] === 'true' && params['tax_id_collection[enabled]'] === 'true' && params['billing_address_collection'] === 'required', JSON.stringify(params));
  } finally {
    stub.restore();
  }
}

// ══ 7. What Stripe says back is not trusted blindly ════════════════════════

console.log('\nAn unusable Stripe answer is a 502, not a URL handed to the OS');
{
  for (const [label, url] of [
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an http: URL', 'http://checkout.stripe.com/c/pay/cs_1'],
    ['no URL at all', undefined],
  ]) {
    const stub = stripeStub({
      '/v1/checkout/sessions': () => jsonResponse({ id: 'cs_bad', url }),
    });
    try {
      const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: 'user_bad_url' });
      check(`${label} is refused (502)`, answer.status === 502, `${answer.status} ${JSON.stringify(answer.body)}`);
      check(`${label} is not echoed back`, !JSON.stringify(answer.body).includes('alert(1)') && answer.body?.url === undefined, JSON.stringify(answer.body));
    } finally {
      stub.restore();
    }
  }

  const upstream = stripeStub({
    '/v1/checkout/sessions': () => jsonResponse({ error: { code: 'parameter_invalid_empty', message: `Bad key ${SECRET_KEY}` } }, 400),
  });
  try {
    const answer = await api(hostedEnv(), '/api/checkout', { body: { lookupKey: 'phorma_starter_monthly' }, token: 'user_upstream' });
    // Stripe's status is never mirrored: a Stripe 400 about OUR parameters is not
    // the caller's fault, and a Stripe 401 would send them to a sign-in screen.
    check('a Stripe rejection becomes a 502', answer.status === 502, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('vendor prose stays out of the response', !/Bad key/.test(JSON.stringify(answer.body)), JSON.stringify(answer.body));
    check('the secret key stays out of the log', !upstream.logs.join('\n').includes(SECRET_KEY), upstream.logs.join(' | '));
  } finally {
    upstream.restore();
  }
}

// ══ 8. POST /api/billing-portal (task 4.2, requirement 28) ═════════════════

console.log('\nPOST /api/billing-portal (requirement 28)');
{
  const stub = stripeStub();
  try {
    // Nothing to manage yet: no stored mapping and no customer in Stripe.
    const fresh = await api(hostedEnv(), '/api/billing-portal', { token: 'user_no_billing' });
    check('a tenant with no billing account gets a 404 that says so', fresh.status === 404 && /no billing account/i.test(fresh.body?.error ?? ''), `${fresh.status} ${JSON.stringify(fresh.body)}`);
    check('no portal session is created for one', stub.callsTo('/v1/billing_portal/sessions').length === 0, JSON.stringify(stub.calls.map((c) => c.path)));

    const answer = await api(hostedEnv(), '/api/billing-portal', { token: 'user_mapped' });
    const session = stub.callsTo('/v1/billing_portal/sessions')[0];
    check('a mapped tenant gets a portal URL', answer.status === 200 && answer.body?.url === 'https://billing.stripe.com/p/session/bps_1', `${answer.status} ${JSON.stringify(answer.body)}`);
    check('the session is for their own customer', session?.params['customer'] === 'cus_mapped', JSON.stringify(session?.params));
    check('the portal returns to this worker', session?.params['return_url'] === RETURN_URL, session?.params['return_url']);
    // Requirement 28 is "let Stripe own cancel, plan change, card and invoices",
    // so this route builds nothing beyond the session.
    check('no other Stripe call is made for a mapped tenant', stub.callsTo('/v1/customers').length === 0 && stub.callsTo('/v1/prices').length === 0, JSON.stringify(stub.calls.map((c) => c.path)));

    const wrongMethod = await api(hostedEnv(), '/api/billing-portal', { method: 'GET', token: 'user_mapped' });
    check('GET /api/billing-portal is not a route', wrongMethod.status === 404, `${wrongMethod.status} ${JSON.stringify(wrongMethod.body)}`);
  } finally {
    stub.restore();
  }
}

// ══ 9. An organisation owner never reaches Stripe ═══════════════════════════
//
// Feature: multi-organisation-phorma, task 15, Requirement 19.4. An organisation is
// invoiced by Phorma Labs, so neither self-serve billing route may create a Stripe
// object for one.
//
// WHAT IS ACTUALLY ASSERTED is the ABSENCE OF THE OUTBOUND CALL, not the 403. A
// refusal that still created a Customer, or that resolved a price first, is the
// failure that matters here: the status would look correct and a Stripe account
// would be quietly accumulating customers for accounts that can never check out.
//
// Both org claim layouts are driven, because `readOrgClaim` tolerates two and a
// refusal wired to only one would leave the other spending. And the ADMIN case is
// the load-bearing one: `org:admin` maps to `admin`, so the level gate PASSES and
// the level is therefore not what refuses them.

console.log('\nAn organisation owner is refused billing_managed with no Stripe call (Requirement 19.4)');
{
  const ORG_CLAIMS = [
    ['a top-level org_id claim', { org_id: 'org_acme', org_role: 'org:admin' }],
    ['a compacted o.id claim', { o: { id: 'org_acme', rol: 'admin' } }],
    ['an org with no role claim at all', { org_id: 'org_acme' }],
    ['a member, not an admin', { org_id: 'org_acme', org_role: 'org:member' }],
  ];

  for (const [label, claims] of ORG_CLAIMS) {
    for (const path of ['/api/checkout', '/api/billing-portal']) {
      const stub = stripeStub();
      try {
        const answer = await api(hostedEnv(), path, {
          body: { lookupKey: 'phorma_starter_monthly' },
          token: 'user_org_member',
          claims,
        });
        check(
          `${path} with ${label} is 403`,
          answer.status === 403,
          `${answer.status} ${JSON.stringify(answer.body)}`,
        );
        check(
          `${path} with ${label} answers code billing_managed`,
          answer.body?.code === 'billing_managed',
          JSON.stringify(answer.body),
        );
        // The refusal names who to ask, because there is no button that fixes this.
        check(
          `${path} with ${label} names Phorma Labs`,
          /Phorma Labs/.test(answer.body?.error ?? ''),
          JSON.stringify(answer.body),
        );
        // The whole point. No price read, no customer search, no customer create,
        // no session - not one byte left this worker.
        check(
          `${path} with ${label} made NO Stripe call of any kind`,
          stub.calls.length === 0,
          JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)),
        );
      } finally {
        stub.restore();
      }
    }
  }

  // Nothing was written under either id either: no tenant row for the member and
  // none for the organisation, because the refusal is above every write.
  check(
    'no tenant row was created for the member or the organisation',
    (await store.getTenant('user_org_member')) === null && (await store.getTenant('org_acme')) === null,
    JSON.stringify([await store.getTenant('user_org_member'), await store.getTenant('org_acme')]),
  );

  // The positive control, and it is what makes every assertion above mean
  // something: the SAME user id, the SAME body, the SAME env, with no organisation
  // claim, reaches Stripe and gets a URL. So the discriminator is the claim and not
  // anything else about the request.
  const control = stripeStub();
  try {
    const answer = await api(hostedEnv(), '/api/checkout', {
      body: { lookupKey: 'phorma_starter_monthly' },
      token: 'user_org_member',
    });
    check(
      'the same caller with no org claim still checks out',
      answer.status === 200 && typeof answer.body?.url === 'string',
      `${answer.status} ${JSON.stringify(answer.body)}`,
    );
    check(
      'and the session carries their PERSONAL id, never an org id',
      control.callsTo('/v1/checkout/sessions')[0]?.params['client_reference_id'] === 'user_org_member',
      JSON.stringify(control.callsTo('/v1/checkout/sessions')[0]?.params),
    );
    // No VALUE anywhere in any call is an organisation id. Checked per value with
    // a prefix test rather than as a substring of the whole capture, because the
    // member's own user id legitimately contains the letters `org_`.
    const values = control.calls.flatMap((call) => [
      ...Object.values(call.params),
      ...Object.values(call.query),
      ...Object.values(call.headers),
    ]);
    check(
      'no org id reaches Stripe in any parameter, query value or header',
      values.every((value) => !String(value).startsWith('org_')) &&
        !JSON.stringify(control.calls).includes('org_acme'),
      JSON.stringify(values),
    );
  } finally {
    control.restore();
  }
}

// ══ 10. A personal owner behaves exactly as before ═════════════════════════
//
// Requirement 19.3. The refusal above is a new branch on a shipped route, so the
// two personal-owner behaviours most likely to be broken by it are re-asserted
// here: `past_due` still routes to the portal (requirement 17 - the remedy is the
// CARD, and the tenant keeps the plan), and a tenant with no Stripe customer still
// gets the 404 that says so rather than a refusal about an organisation.

console.log('\nA personal owner is unaffected, including past_due (Requirement 19.3)');
{
  const stub = stripeStub();
  try {
    await store.upsertTenant({
      id: 'user_past_due',
      email: 'dunning@example.com',
      tier: 'pro',
      status: 'past_due',
      stripeCustomerId: 'cus_past_due',
    });

    const portal = await api(hostedEnv(), '/api/billing-portal', { token: 'user_past_due' });
    check(
      'a past_due personal tenant still reaches the Billing Portal',
      portal.status === 200 && portal.body?.url === 'https://billing.stripe.com/p/session/bps_1',
      `${portal.status} ${JSON.stringify(portal.body)}`,
    );
    check(
      'for their own customer',
      stub.callsTo('/v1/billing_portal/sessions')[0]?.params['customer'] === 'cus_past_due',
      JSON.stringify(stub.callsTo('/v1/billing_portal/sessions')[0]?.params),
    );
    check(
      'and the row is untouched by the visit',
      (await store.getTenant('user_past_due'))?.status === 'past_due',
      JSON.stringify(await store.getTenant('user_past_due')),
    );

    // Unchanged from section 8, restated here because it is the other branch the
    // new refusal sits above: a personal owner with nothing to manage must still
    // read as "nothing to manage", never as "managed elsewhere".
    const fresh = await api(hostedEnv(), '/api/billing-portal', { token: 'user_personal_fresh' });
    check(
      'a personal tenant with no Stripe customer still gets the 404',
      fresh.status === 404 && /no billing account/i.test(fresh.body?.error ?? ''),
      `${fresh.status} ${JSON.stringify(fresh.body)}`,
    );
    check(
      'and NOT a billing_managed refusal',
      fresh.body?.code === undefined,
      JSON.stringify(fresh.body),
    );
  } finally {
    stub.restore();
  }
}

await mf.dispose();
console.log(failures === 0 ? '\nAll billing route checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
