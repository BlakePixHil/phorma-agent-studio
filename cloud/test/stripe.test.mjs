/**
 * Stripe REST primitives (`cloud/src/stripe.ts`) - task 3.1, requirements 33
 * and 34.
 *
 * Two things are worth testing here and this suite tests only those.
 *
 * **The form encoding**, because it is the whole reason we can skip the SDK. It
 * is also the part with no safety net: a wrong bracket layout is not a type
 * error, it is a 400 from Stripe at the moment a customer tries to pay. The
 * cases below pin the exact wire bytes for the shapes the billing routes
 * actually send (nested objects, indexed lists, booleans, omitted optionals),
 * plus the escaping property that matters for safety - a value carrying `&` or
 * `=` must not be able to forge a second parameter.
 *
 * **The missing-secret path** (requirement 34), because the failure it prevents
 * is invisible until it is embarrassing: a BYO worker binds no Stripe secrets at
 * all, and an unguarded helper would fire an unauthenticated request and report
 * whatever Stripe said about it. The assertions are that the refusal is a 501,
 * that it NAMES the secret, and that no network call happens at all.
 *
 * Alongside those: Stripe's HTTP status is never mirrored onto ours (a Stripe
 * 401 means OUR key is wrong, and forwarding it would send the user to a sign-in
 * screen for a problem only an operator can fix), vendor prose never reaches the
 * response body, and the secret key never reaches the URL, the log or an error
 * string (requirement 33).
 *
 * **The webhook signature** (task 3.2, requirement 11), which is the entire
 * authorization story for `POST /api/stripe/webhook` - there is no bearer to
 * fall back on, so a verifier that accepts one thing it should not is a stranger
 * writing subscription state. Signatures are produced here with WebCrypto rather
 * than pasted, so a case cannot pass because a fixture went stale, and the clock
 * is injected so the tolerance boundary is exact instead of racing `Date.now()`.
 * The matrix runs in two passes. The first (task 3.2) covers accept, tamper,
 * wrong secret, replay in both directions, rotation, the candidate cap that keeps
 * a stuffed header from spending unbounded CPU on an unauthenticated request, and
 * every malformed header shape reaching a refusal rather than a throw. The second
 * (task 3.5, the section headed "the rest of the matrix") adds what a fixed
 * fixture cannot say: two fast-check properties over the whole candidate and body
 * space, the boundaries either side of every accepted length, the timestamp's
 * binding into the signed payload independent of the clock, an INDEPENDENT
 * known-answer vector so no positive case rests on the same `crypto.subtle` the
 * verifier uses, and multi-byte and megabyte bodies.
 *
 * No worker and no network: `fetch` is replaced per case, so the assertions are
 * about the request this module BUILDS rather than about Stripe.
 *
 * Run: npx -y tsx cloud/test/stripe.test.mjs
 */

import { createHmac } from 'node:crypto';

import fc from 'fast-check';

import {
  BILLING_LOOKUP_KEYS,
  billingKindForLookupKey,
  encodeStripeForm,
  requireAllowedLookupKey,
  requireStripeSecret,
  resolveCataloguePrice,
  stripeRequest,
  tierForPrice,
  topUpForPrice,
  verifyStripeSignature,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
} from '../src/stripe.ts';
import { TIERS, grantCostUsd, isKnownTier, usdPerCredit } from '../src/tenants.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const SECRET_KEY = 'sk_test_do_not_leak_me';

// ── Harness ──────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const realConsoleWarn = console.warn;

/**
 * Installs a `fetch` stub and captures every call plus everything the module
 * logs, so a test can assert on both. `respond` either returns a Response or
 * throws (the Stripe-unreachable case).
 *
 * Both `error` and `warn` land in one `logs` array: the catalogue refusals split
 * across the two by severity (a misconfigured price is an error, a caller sending
 * an unknown lookup key is not), and a test asserting "the reason was logged"
 * should not have to know which.
 */
function record(respond) {
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map(part => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  };
  console.error = capture;
  console.warn = capture;
  return {
    calls,
    logs,
    restore: () => {
      globalThis.fetch = realFetch;
      console.error = realConsoleError;
      console.warn = realConsoleWarn;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Case-insensitive header read over the plain object the module builds. */
function headerOf(call, name) {
  const headers = call.init.headers ?? {};
  const hit = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return hit ? headers[hit] : undefined;
}

// ── Form encoding ────────────────────────────────────────────────────────────

console.log('\nencodeStripeForm');

const encodings = [
  ['a flat scalar', { mode: 'subscription' }, 'mode=subscription'],
  ['a nested object brackets its key', { metadata: { tier: 'pro' } }, 'metadata%5Btier%5D=pro'],
  [
    'a list of objects is INDEXED, not repeated',
    { line_items: [{ price: 'price_1', quantity: 1 }] },
    'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1',
  ],
  [
    'a list of scalars keeps its order',
    { expand: ['customer', 'subscription'] },
    'expand%5B0%5D=customer&expand%5B1%5D=subscription',
  ],
  [
    'booleans stringify (automatic tax + tax id collection)',
    { automatic_tax: { enabled: true }, tax_id_collection: { enabled: false } },
    'automatic_tax%5Benabled%5D=true&tax_id_collection%5Benabled%5D=false',
  ],
  [
    'two levels of nesting',
    { subscription_data: { metadata: { tier: 'team' } } },
    'subscription_data%5Bmetadata%5D%5Btier%5D=team',
  ],
  [
    'undefined is omitted, so an optional parameter can be written inline',
    { customer: undefined, mode: 'payment' },
    'mode=payment',
  ],
  ['null is an empty value, which is how Stripe clears a field', { metadata: { note: null } }, 'metadata%5Bnote%5D='],
  ['an empty object or list contributes nothing', { empty: {}, list: [], keep: 'yes' }, 'keep=yes'],
  ['a space is %20, matching what the SDKs send', { name: 'a b' }, 'name=a%20b'],
  ['nothing to send is an empty body, not a stray &', {}, ''],
];

for (const [name, params, expected] of encodings) {
  const actual = encodeStripeForm(params);
  check(name, actual === expected, `got ${JSON.stringify(actual)}`);
}

{
  // The escaping property that matters for safety: a value is a value. Stripe's
  // customer search syntax (`metadata['clerk_user_id']:'user_1'`) is full of
  // characters that would otherwise land in the wire format's own vocabulary.
  const query = "metadata['clerk_user_id']:'a&b=c'";
  const encoded = encodeStripeForm({ query, limit: 1 });
  const parsed = new URLSearchParams(encoded);
  check(
    'a value carrying & and = cannot forge a parameter',
    parsed.get('query') === query && [...parsed.keys()].length === 2,
    encoded,
  );
  check(
    'every character with meaning in the format is escaped inside a value',
    // `'` and `[` stay literal (encodeURIComponent leaves sub-delimiters alone,
    // which is legal and decodes identically); `&` and `=` must not.
    encoded.includes('%26') && encoded.includes('%3D') && !encoded.slice(6).includes('&b'),
    encoded,
  );
}

{
  // A non-finite number is a bug in OUR call site. Stripe would answer with a
  // generic 400 that names nothing, so this fails loudly and names the path.
  let thrown = null;
  try {
    encodeStripeForm({ line_items: [{ quantity: Number.NaN }] });
  } catch (error) {
    thrown = error;
  }
  check(
    'a non-finite number throws and names the parameter path',
    thrown instanceof TypeError && thrown.message.includes('line_items[0][quantity]'),
    thrown?.message,
  );
}

// ── Missing secrets (requirement 34) ─────────────────────────────────────────

console.log('\nrequireStripeSecret');

for (const [name, env] of [
  ['absent', {}],
  ['an empty string, which `wrangler secret put` accepts', { STRIPE_SECRET_KEY: '' }],
  ['whitespace only', { STRIPE_SECRET_KEY: '   \n' }],
]) {
  const result = requireStripeSecret(env, 'STRIPE_SECRET_KEY');
  check(
    `${name} refuses with 501`,
    'status' in result && result.status === 501,
    JSON.stringify(result),
  );
  check(
    `${name} names the secret and the command that sets it`,
    'error' in result &&
      result.error.includes('STRIPE_SECRET_KEY') &&
      result.error.includes('wrangler secret put'),
    'error' in result ? result.error : '',
  );
}

{
  const result = requireStripeSecret({ STRIPE_SECRET_KEY: ` ${SECRET_KEY} ` }, 'STRIPE_SECRET_KEY');
  check('a configured secret comes back trimmed', 'secret' in result && result.secret === SECRET_KEY);
}

{
  // The webhook secret is a separate binding, and naming the wrong one would
  // send an operator to set a secret that is already set.
  const result = requireStripeSecret({ STRIPE_SECRET_KEY: SECRET_KEY }, 'STRIPE_WEBHOOK_SECRET');
  check(
    'a missing webhook secret names ITSELF, not the API key',
    'error' in result &&
      result.error.includes('STRIPE_WEBHOOK_SECRET') &&
      !result.error.includes('STRIPE_SECRET_KEY:'),
    'error' in result ? result.error : '',
  );
}

console.log('\nstripeRequest');

{
  const stub = record(() => jsonResponse({ id: 'cus_1' }));
  const result = await stripeRequest({}, '/customers', { params: { email: 'a@b.test' } });
  stub.restore();
  check(
    'an unconfigured worker refuses with 501 naming the secret',
    'status' in result && result.status === 501 && result.error.includes('STRIPE_SECRET_KEY'),
    JSON.stringify(result),
  );
  // The point of checking the secret FIRST: a BYO worker must not talk to Stripe
  // at all, so there is nothing to rate-limit, log, or explain.
  check('an unconfigured worker makes no network call', stub.calls.length === 0);
}

// ── The request it builds ────────────────────────────────────────────────────

{
  const stub = record(() => jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }));
  const result = await stripeRequest(
    { STRIPE_SECRET_KEY: SECRET_KEY },
    '/checkout/sessions',
    {
      params: {
        mode: 'subscription',
        client_reference_id: 'user_123',
        line_items: [{ price: 'price_1', quantity: 1 }],
      },
      idempotencyKey: 'checkout-user_123-1',
    },
  );
  stub.restore();
  const [call] = stub.calls;

  check('a success returns the parsed object', 'data' in result && result.data.id === 'cs_1');
  check('POST is the default method', call?.init.method === 'POST');
  check(
    'the URL is the /v1 path with no query string',
    call?.url === 'https://api.stripe.com/v1/checkout/sessions',
    call?.url,
  );
  check(
    'the body is the form encoding',
    call?.init.body ===
      'mode=subscription&client_reference_id=user_123&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1',
    call?.init.body,
  );
  check(
    'the content type is form-urlencoded',
    headerOf(call, 'content-type') === 'application/x-www-form-urlencoded',
    headerOf(call, 'content-type'),
  );
  check('the secret authenticates the call', headerOf(call, 'authorization') === `Bearer ${SECRET_KEY}`);
  check(
    'the API version is pinned, so an account upgrade cannot change behaviour without a deploy',
    /^\d{4}-\d{2}-\d{2}\./.test(headerOf(call, 'stripe-version') ?? ''),
    headerOf(call, 'stripe-version'),
  );
  check(
    'a User-Agent names the worker build, which Cloudflare fetch does not do by itself',
    (headerOf(call, 'user-agent') ?? '').startsWith('PhormaAgentStudio/'),
    headerOf(call, 'user-agent'),
  );
  check(
    'the idempotency key travels, so a retried create cannot duplicate a customer',
    headerOf(call, 'idempotency-key') === 'checkout-user_123-1',
  );
  check(
    'the secret never reaches the URL',
    !call?.url.includes(SECRET_KEY) && !String(call?.init.body).includes(SECRET_KEY),
  );
}

{
  const stub = record(() => jsonResponse({ data: [] }));
  await stripeRequest({ STRIPE_SECRET_KEY: SECRET_KEY }, '/customers/search', {
    method: 'GET',
    params: { query: "metadata['clerk_user_id']:'user_123'", limit: 1 },
  });
  stub.restore();
  const [call] = stub.calls;
  const url = new URL(call.url);

  check('GET puts the parameters in the query string', url.pathname === '/v1/customers/search');
  check(
    'GET query parameters decode back to what was passed',
    url.searchParams.get('query') === "metadata['clerk_user_id']:'user_123'" &&
      url.searchParams.get('limit') === '1',
    call.url,
  );
  check('GET sends no body', call.init.body === undefined);
  check('GET sends no form content type', headerOf(call, 'content-type') === undefined);
  check(
    'no idempotency key unless one was asked for',
    headerOf(call, 'idempotency-key') === undefined,
  );
}

// ── Failure handling ─────────────────────────────────────────────────────────

{
  // Stripe 401 = OUR key is wrong. Mirroring it would tell the studio the user's
  // session expired and send them to sign in again for an operator's problem.
  const stub = record(() =>
    jsonResponse({ error: { type: 'invalid_request_error', code: 'api_key_expired', message: `Expired API Key provided: ${SECRET_KEY}` } }, 401),
  );
  const result = await stripeRequest({ STRIPE_SECRET_KEY: SECRET_KEY }, '/customers', {
    params: { email: 'a@b.test' },
  });
  stub.restore();

  check(
    "Stripe's status is not mirrored - an upstream failure is a 502",
    'status' in result && result.status === 502,
    JSON.stringify(result),
  );
  check(
    'the stable machine code travels back',
    'error' in result && result.error.includes('api_key_expired'),
    'error' in result ? result.error : '',
  );
  check(
    'vendor prose does not travel back',
    'error' in result && !result.error.includes('Expired API Key'),
    'error' in result ? result.error : '',
  );
  // Stripe quotes the key back at you when it rejects one ("Expired API Key
  // provided: sk_..."). It masks the middle, but requirement 33 must not depend
  // on a vendor's masking, and this worker has `observability` enabled so a log
  // line is durable.
  check(
    'and neither does the secret, in the response or the log',
    'error' in result &&
      !result.error.includes(SECRET_KEY) &&
      stub.logs.every(line => !line.includes(SECRET_KEY)),
    stub.logs.join(' | '),
  );
  check(
    'the secret is redacted rather than the whole log line dropped',
    stub.logs.some(line => line.includes('[redacted]') && line.includes('401')),
    stub.logs.join(' | '),
  );
}

{
  // A `code` is a documented snake_case enum. Anything else is not a code, so it
  // does not get to travel from a vendor body into our response body.
  const stub = record(() =>
    jsonResponse({ error: { code: '<b>injected</b> prose', message: 'nope' } }, 400),
  );
  const result = await stripeRequest({ STRIPE_SECRET_KEY: SECRET_KEY }, '/customers');
  stub.restore();
  check(
    'a code that is not a token shape is dropped rather than echoed',
    'error' in result && !result.error.includes('injected') && result.status === 502,
    'error' in result ? result.error : '',
  );
}

{
  const stub = record(() => {
    throw new TypeError('network error');
  });
  const result = await stripeRequest({ STRIPE_SECRET_KEY: SECRET_KEY }, '/customers');
  stub.restore();
  check(
    'an unreachable Stripe is a 502, not an exception escaping to a generic 500',
    'status' in result && result.status === 502 && /reach Stripe/i.test(result.error),
    JSON.stringify(result),
  );
}

{
  const stub = record(() => new Response('<html>gateway</html>', { status: 200 }));
  const result = await stripeRequest({ STRIPE_SECRET_KEY: SECRET_KEY }, '/customers');
  stub.restore();
  check(
    'a 200 that is not JSON is a 502, not a cast over garbage',
    'status' in result && result.status === 502,
    JSON.stringify(result),
  );
}

// ── Catalogue (requirements 5, 6, 7, 8) ──────────────────────────────────────
//
// Three separable things, and the failure each one prevents is different.
//
// **The allowlist** is the security boundary for `/api/checkout` (requirement 6).
// A client sends a lookup KEY and never a price id, so the set of purchasable
// things is a literal table in the worker rather than whatever the caller typed.
// The cases below therefore include the actual attack - passing a real price id -
// and a property that no string outside the table is ever accepted, because an
// allowlist is only worth as much as its most permissive input.
//
// **Tier resolution** (requirement 7) reads `metadata.tier` off the PRICE, so
// annual pricing stays additive, and refuses an unknown value rather than
// defaulting. The default is what is being tested: silently selling a Team-priced
// subscription as starter is invisible until a support ticket arrives, which is
// strictly worse than a failed checkout.
//
// **The cost basis** (requirement 8) is derived from `TIERS.starter`, not
// written down. A test that only asserts `0.004` would pass just as happily
// against a hardcoded literal, so the derivation is proven by MOVING the tier
// table and watching the ratio follow.
//
// The pure halves need no network at all, which is most of why they are pure.

console.log('\nBilling catalogue');

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

/** The counterexample fast-check reports, flattened onto one line. */
function describeFailure(error) {
  return String(error?.message ?? error).split('\n').slice(0, 8).join(' | ');
}

/**
 * Runs one synchronous property with the module's own logging swallowed - a
 * refusal logs its reason, and 200 of them would bury the report.
 */
function property(name, build) {
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    fc.assert(build(), RUNS);
    check(name, true);
  } catch (error) {
    check(name, false, describeFailure(error));
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

/** Runs a synchronous call with both log channels captured. */
function quiet(run) {
  const logs = [];
  const capture = (...args) => logs.push(args.map(String).join(' '));
  const realError = console.error;
  const realWarn = console.warn;
  console.error = capture;
  console.warn = capture;
  try {
    return { value: run(), log: logs.join(' | ') };
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

/** The real sandbox starter price, field for field (`GET /v1/prices`). */
function subscriptionPrice(overrides = {}) {
  return {
    id: 'price_1UB3bjCNDyfITvm6P25hy7Ud',
    active: true,
    type: 'recurring',
    lookup_key: 'phorma_starter_monthly',
    currency: 'usd',
    unit_amount: 2000,
    tax_behavior: 'inclusive',
    recurring: { interval: 'month', interval_count: 1 },
    metadata: { tier: 'starter' },
    ...overrides,
  };
}

/** A top-up price in the shape task 9.1 will create: `$10` for 500 credits. */
function topUpPrice(overrides = {}) {
  return {
    id: 'price_1UB9smallTopUpCNDyfITvm6',
    active: true,
    type: 'one_time',
    lookup_key: 'phorma_topup_small',
    currency: 'usd',
    unit_amount: 1000,
    tax_behavior: 'inclusive',
    recurring: null,
    metadata: { credits: '500' },
    ...overrides,
  };
}

// ── The allowlist (requirements 5, 6) ────────────────────────────────────────

for (const [lookupKey, kind] of BILLING_LOOKUP_KEYS) {
  const result = requireAllowedLookupKey(lookupKey);
  check(
    `"${lookupKey}" is on the allowlist as a ${kind}`,
    'entry' in result && result.entry.lookupKey === lookupKey && result.entry.kind === kind,
    JSON.stringify(result),
  );
}

check(
  'the allowlist is exactly the three plans plus the three top-up packs',
  BILLING_LOOKUP_KEYS.size === 6 &&
    [...BILLING_LOOKUP_KEYS.values()].filter(kind => kind === 'subscription').length === 3 &&
    [...BILLING_LOOKUP_KEYS.values()].filter(kind => kind === 'topup').length === 3,
  [...BILLING_LOOKUP_KEYS.keys()].join(','),
);

{
  // THE attack the allowlist exists to stop: a caller naming a price directly.
  // This is a real sandbox price id, so without the allowlist it would check out.
  const result = quiet(() => requireAllowedLookupKey('price_1UB3bjCNDyfITvm6P25hy7Ud'));
  check(
    'a price id is refused, which is the whole point of taking a lookup key',
    'status' in result.value && result.value.status === 400,
    JSON.stringify(result.value),
  );
  check(
    'and the refusal does not echo the string back to the caller',
    !JSON.stringify(result.value).includes('price_1UB3bj'),
    JSON.stringify(result.value),
  );
  check('while the log keeps it for whoever has to diagnose it', result.log.includes('price_1UB3bj'), result.log);
}

for (const [name, value] of [
  ['a retired tier', 'phorma_plus_monthly'],
  ['a plausible near-miss', 'phorma_starter_annual'],
  ['an empty string', ''],
  // The reason the table is a Map: every one of these is a truthy inherited
  // value on a plain object literal, so an object-backed allowlist would hand
  // back `[Function: toString]` as the product kind.
  ['a prototype key', 'toString'],
  ['another prototype key', 'constructor'],
  ['__proto__', '__proto__'],
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['an object', { lookupKey: 'phorma_team_monthly' }],
  ['an array of allowlisted keys', ['phorma_starter_monthly']],
]) {
  const result = quiet(() => requireAllowedLookupKey(value));
  check(
    `${name} is refused with 400`,
    'status' in result.value && result.value.status === 400,
    JSON.stringify(result.value),
  );
}

property('any string outside the allowlist is refused with 400', () =>
  fc.property(fc.string({ maxLength: 60 }), value => {
    fc.pre(!BILLING_LOOKUP_KEYS.has(value));
    const result = requireAllowedLookupKey(value);
    return 'status' in result && result.status === 400 && !('entry' in result);
  }),
);

check(
  'billingKindForLookupKey answers for the webhook without a refusal object',
  billingKindForLookupKey('phorma_pro_monthly') === 'subscription' &&
    billingKindForLookupKey('phorma_topup_large') === 'topup' &&
    billingKindForLookupKey('phorma_plus_monthly') === null &&
    billingKindForLookupKey('toString') === null &&
    billingKindForLookupKey(undefined) === null,
);

// ── Tier resolution (requirement 7) ──────────────────────────────────────────

for (const tier of ['starter', 'pro', 'team']) {
  const result = tierForPrice(subscriptionPrice({ metadata: { tier } }));
  check(`metadata.tier "${tier}" resolves to that tier`, 'tier' in result && result.tier === tier);
}

{
  // Dashboard-typed metadata picks up whitespace nobody can see in the form.
  const result = tierForPrice(subscriptionPrice({ metadata: { tier: ' team ' } }));
  check('a padded metadata.tier still resolves', 'tier' in result && result.tier === 'team');
}

for (const [name, metadata] of [
  ['missing metadata entirely', undefined],
  ['null metadata', null],
  ['no tier key', { credits: '500' }],
  ['an empty tier', { tier: '' }],
  ['a whitespace-only tier', { tier: '   ' }],
  ['a non-string tier', { tier: 5 }],
  // `plus` was removed from TIERS. A price still carrying it must fail, not
  // resolve to the nearest thing.
  ['the retired plus tier', { tier: 'plus' }],
  // Requirement 9: Enterprise is sales-led and has no self-serve price, so it is
  // deliberately not in TIERS and must not resolve.
  ['enterprise', { tier: 'enterprise' }],
  ['a typo', { tier: 'startr' }],
  // `TIERS` is a plain object, so `TIERS['toString']` is truthy - `isKnownTier`
  // uses hasOwnProperty precisely so this cannot resolve and then fall back to
  // starter's limits through `tierLimits`.
  ['a prototype key', { tier: 'toString' }],
  ['__proto__', { tier: '__proto__' }],
]) {
  const result = quiet(() => tierForPrice(subscriptionPrice({ metadata })));
  check(
    `${name} is a 501 refusal, never a silent default`,
    'status' in result.value && result.value.status === 501 && !('tier' in result.value),
    JSON.stringify(result.value),
  );
}

property('no metadata.tier value outside TIERS ever resolves to a tier', () =>
  fc.property(fc.string({ maxLength: 30 }), tier => {
    fc.pre(!isKnownTier(tier.trim()));
    const result = tierForPrice(subscriptionPrice({ metadata: { tier } }));
    return 'status' in result && !('tier' in result);
  }),
);

check(
  'isKnownTier knows exactly the declared tiers',
  isKnownTier('starter') &&
    isKnownTier('pro') &&
    isKnownTier('team') &&
    !isKnownTier('plus') &&
    !isKnownTier('enterprise') &&
    !isKnownTier('') &&
    !isKnownTier('toString') &&
    !isKnownTier('__proto__'),
);

// ── The cost basis (requirement 8) ───────────────────────────────────────────

check(
  'usdPerCredit is the starter ratio, not a number of its own',
  usdPerCredit() === TIERS.starter.monthlyCostUsd / TIERS.starter.monthlyCredits,
  String(usdPerCredit()),
);

{
  // The assertion above would also pass against a hardcoded 0.004 that happens
  // to match today. This one cannot: move the tier table and the ratio has to
  // follow it, which is requirement 8 stated as an experiment.
  const restore = TIERS.starter.monthlyCostUsd;
  let moved = null;
  try {
    TIERS.starter.monthlyCostUsd = restore / 2;
    moved = { ratio: usdPerCredit(), grant: grantCostUsd(500) };
  } finally {
    TIERS.starter.monthlyCostUsd = restore;
  }
  check(
    'halving the starter budget halves the pack cost basis',
    moved.ratio === restore / 2 / TIERS.starter.monthlyCredits && moved.grant === 1,
    JSON.stringify(moved),
  );
  check(
    'and restoring the tier table restores it',
    usdPerCredit() === 0.004 && grantCostUsd(500) === 2,
    `${usdPerCredit()} / ${grantCostUsd(500)}`,
  );
}

check(
  'grantCostUsd refuses to invent a budget for a nonsense count',
  grantCostUsd(0) === 0 &&
    grantCostUsd(-500) === 0 &&
    grantCostUsd(Number.NaN) === 0 &&
    grantCostUsd(Number.POSITIVE_INFINITY) === 0,
);

for (const [credits, priceUsd, expectedUsd] of [
  [500, 10, 2],
  [1250, 20, 5],
  [2500, 40, 10],
]) {
  const result = topUpForPrice(
    topUpPrice({ metadata: { credits: String(credits) }, unit_amount: priceUsd * 100 }),
  );
  check(
    `a $${priceUsd} / ${credits} credit pack costs us $${expectedUsd} to fulfil`,
    'credits' in result && result.credits === credits && result.costUsd === expectedUsd,
    JSON.stringify(result),
  );
}

for (const [name, credits] of [
  ['missing metadata.credits', undefined],
  ['an empty count', ''],
  ['zero credits', '0'],
  ['a negative count', '-500'],
  // Every one of these is something `Number()` would either coerce to a value
  // nobody typed or turn into NaN on its way to a REAL column.
  ['exponent notation', '1e3'],
  ['a thousands separator', '2,500'],
  ['a fractional count', '500.5'],
  ['hex', '0x1f'],
  ['a count with a unit', '500 credits'],
  ['whitespace only', '   '],
  ['a non-string count', 500],
]) {
  const metadata = credits === undefined ? {} : { credits };
  const result = quiet(() => topUpForPrice(topUpPrice({ metadata })));
  check(
    `${name} refuses the sale rather than granting something`,
    'status' in result.value && result.value.status === 501 && !('credits' in result.value),
    JSON.stringify(result.value),
  );
}

{
  // The realistic top-up failure is not an attack, it is an extra digit in a
  // Dashboard field: 25,000 credits is $100 of real inference sold for $40.
  const result = quiet(() =>
    topUpForPrice(topUpPrice({ metadata: { credits: '25000' }, unit_amount: 4000 })),
  );
  check(
    'a pack that would grant more budget than it charges is refused',
    'status' in result.value && result.value.status === 501,
    JSON.stringify(result.value),
  );
  check(
    'and the log points at the digit rather than at Stripe',
    result.log.includes('metadata.credits') && result.log.includes('$100.00'),
    result.log,
  );

  // The boundary itself is allowed: exactly break-even is a pricing decision
  // (requirement 51 owns the real margin floor), not a misconfiguration.
  const breakEven = topUpForPrice(topUpPrice({ metadata: { credits: '10000' }, unit_amount: 4000 }));
  check(
    'break-even is allowed, because the floor here is zero margin not a policy',
    'credits' in breakEven && breakEven.costUsd === 40,
    JSON.stringify(breakEven),
  );

  // Currency is immutable per price and task 9.2b has not settled it, so the
  // comparison skips rather than refusing everything non-USD by assumption.
  const aud = topUpForPrice(
    topUpPrice({ currency: 'aud', metadata: { credits: '25000' }, unit_amount: 4000 }),
  );
  check(
    'a non-USD price skips the comparison instead of being refused outright',
    'credits' in aud && aud.credits === 25000,
    JSON.stringify(aud),
  );
}

// ── Resolution against Stripe ────────────────────────────────────────────────

{
  const stub = record(() => jsonResponse({ object: 'list', data: [subscriptionPrice()] }));
  const result = await resolveCataloguePrice(
    { STRIPE_SECRET_KEY: SECRET_KEY },
    'phorma_starter_monthly',
  );
  stub.restore();
  const url = new URL(stub.calls[0]?.url ?? 'https://example.test');

  check(
    'a plan resolves to a price id, subscription mode and a known tier',
    'data' in result &&
      result.data.kind === 'subscription' &&
      result.data.mode === 'subscription' &&
      result.data.tier === 'starter' &&
      result.data.priceId === 'price_1UB3bjCNDyfITvm6P25hy7Ud' &&
      result.data.lookupKey === 'phorma_starter_monthly',
    JSON.stringify(result),
  );
  check('the price is looked up by lookup key', url.pathname === '/v1/prices' &&
    url.searchParams.get('lookup_keys[0]') === 'phorma_starter_monthly', stub.calls[0]?.url);
  check(
    'only ACTIVE prices are considered, so an archived one cannot be bought',
    url.searchParams.get('active') === 'true',
    stub.calls[0]?.url,
  );
  check(
    'two are requested so an ambiguous lookup key is detected rather than guessed',
    url.searchParams.get('limit') === '2',
    stub.calls[0]?.url,
  );
  check('and nothing is logged on the happy path', stub.logs.length === 0, stub.logs.join(' | '));
}

{
  const stub = record(() => jsonResponse({ object: 'list', data: [topUpPrice()] }));
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_topup_small');
  stub.restore();
  check(
    'a top-up resolves to payment mode with credits and a derived budget',
    'data' in result &&
      result.data.kind === 'topup' &&
      result.data.mode === 'payment' &&
      result.data.credits === 500 &&
      result.data.costUsd === 500 * usdPerCredit(),
    JSON.stringify(result),
  );
}

{
  const stub = record(() => jsonResponse({ object: 'list', data: [subscriptionPrice()] }));
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'price_1UB3bjCNDyfITvm6P25hy7Ud');
  stub.restore();
  check(
    'a key off the allowlist is refused with 400',
    'status' in result && result.status === 400,
    JSON.stringify(result),
  );
  // Same discipline as the missing-secret check: the boundary runs BEFORE the
  // network, so a rejected caller cannot make this worker talk to Stripe at all.
  check('and no Stripe call is made', stub.calls.length === 0);
}

{
  const stub = record(() => jsonResponse({ object: 'list', data: [subscriptionPrice()] }));
  const result = await resolveCataloguePrice({}, 'not_a_product');
  stub.restore();
  check(
    "an unconfigured worker still reports the CALLER's error as a 400",
    'status' in result && result.status === 400,
    JSON.stringify(result),
  );
}

{
  // What every `phorma_topup_*` key does until task 9.1 creates the prices, and
  // what a live deployment does if the catalogue was never mirrored (task 9.5).
  const stub = record(() => jsonResponse({ object: 'list', data: [] }));
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_topup_large');
  stub.restore();
  check(
    'an allowlisted key with no price in Stripe is 501 naming the key',
    'status' in result && result.status === 501 && result.error.includes('phorma_topup_large'),
    JSON.stringify(result),
  );
}

{
  const stub = record(() =>
    jsonResponse({
      object: 'list',
      data: [subscriptionPrice(), subscriptionPrice({ id: 'price_1UB3bjDuplicateCNDyfITvm6', unit_amount: 100 })],
    }),
  );
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_starter_monthly');
  stub.restore();
  check(
    'two active prices under one lookup key refuses rather than picking the first',
    'status' in result && result.status === 501,
    JSON.stringify(result),
  );
}

for (const [name, price] of [
  // Both are re-checks of a filter Stripe already applied, and both mean the
  // request we built and the object we got do not describe the same product.
  ['an inactive price came back anyway', subscriptionPrice({ active: false })],
  ['the returned price carries a different lookup key', subscriptionPrice({ lookup_key: 'phorma_team_monthly' })],
  // The reason the allowlist stores a kind: a plan created as a one-time price
  // would take $20 once and expire in silence.
  ['a plan price is not recurring', subscriptionPrice({ type: 'one_time', recurring: null })],
  ['the price has no usable id', subscriptionPrice({ id: '<script>' })],
  ['the price is not an object', 'price_1UB3bjCNDyfITvm6P25hy7Ud'],
]) {
  const stub = record(() => jsonResponse({ object: 'list', data: [price] }));
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_starter_monthly');
  stub.restore();
  check(
    `${name} is refused`,
    'status' in result && (result.status === 501 || result.status === 502) && !('data' in result),
    JSON.stringify(result),
  );
  check(`${name} logs why`, stub.logs.length > 0, stub.logs.join(' | '));
}

{
  const stub = record(() =>
    jsonResponse({ object: 'list', data: [topUpPrice({ type: 'recurring', recurring: { interval: 'month' } })] }),
  );
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_topup_small');
  stub.restore();
  check(
    'a credit pack created as a recurring price cannot be sold as a subscription',
    'status' in result && result.status === 501,
    JSON.stringify(result),
  );
}

{
  // Requirement 46's enforcement point is price creation, so this is a warning
  // rather than a refusal - `tax_behavior` is permanent and cannot be fixed on an
  // existing price. What it must not be is silent: an inclusive price is what
  // makes the published number the number the customer pays.
  const stub = record(() =>
    jsonResponse({ object: 'list', data: [subscriptionPrice({ tax_behavior: 'unspecified' })] }),
  );
  const result = await resolveCataloguePrice({ STRIPE_SECRET_KEY: SECRET_KEY }, 'phorma_starter_monthly');
  stub.restore();
  check('a non-inclusive price still resolves', 'data' in result && result.data.tier === 'starter');
  check(
    'but it is logged loudly enough to catch a live-mode mirroring mistake',
    stub.logs.some(line => line.includes('tax_behavior') && line.includes('inclusive')),
    stub.logs.join(' | '),
  );
}

// ── Webhook signatures (requirement 11) ──────────────────────────────────────

console.log('\nverifyStripeSignature');

const WEBHOOK_SECRET = 'whsec_do_not_leak_me_either';
// A fixed clock, so "exactly at the tolerance" is exactly at the tolerance.
const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;
const BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

/** The `v1` value Stripe would send: HMAC-SHA256 over `${t}.${raw}`, hex. */
async function signStripePayload(raw, secret, timestamp) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`));
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** `t=<unix>,v1=<hex>,...` */
function signatureHeader(timestamp, ...v1) {
  return [`t=${timestamp}`, ...v1.map(value => `v1=${value}`)].join(',');
}

/** Captures everything the verifier logs while `run` is in flight. */
async function captureWarnings(run) {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { ok: await run(), log: warnings.join(' | ') };
  } finally {
    console.warn = realWarn;
  }
}

/**
 * Runs the verifier with `console.warn` captured, so a case can assert BOTH the
 * boolean and the stable rejection token. Asserting the token matters: without
 * it a "replay is refused" case passes just as happily when the header was
 * malformed for an unrelated reason, and the replay guard is never exercised.
 *
 * Cases that need to pass an absent secret call `captureWarnings` directly - a
 * default parameter here would swallow the `undefined` under test.
 */
async function verifySignature(raw, header, secret = WEBHOOK_SECRET, nowMs = NOW_MS) {
  return captureWarnings(() => verifyStripeSignature(raw, header, secret, { nowMs }));
}

check(
  'the tolerance is the documented five minutes',
  STRIPE_SIGNATURE_TOLERANCE_SECONDS === 300,
  String(STRIPE_SIGNATURE_TOLERANCE_SECONDS),
);

{
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const result = await verifySignature(BODY, signatureHeader(NOW_S, signature));
  check('a genuine delivery verifies', result.ok === true, result.log);
  check('and says nothing about it', result.log === '', result.log);
}

{
  // The reason a raw body is read before anything parses it: re-serialized JSON
  // is different bytes, and the HMAC covers bytes.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const reparsed = JSON.stringify(JSON.parse(BODY), null, 2);
  const result = await verifySignature(reparsed, signatureHeader(NOW_S, signature));
  check(
    'a body altered in transit is refused, reparsed JSON included',
    result.ok === false && result.log.includes('no_match'),
    result.log,
  );
}

{
  const signature = await signStripePayload(BODY, 'whsec_some_other_endpoint', NOW_S);
  const result = await verifySignature(BODY, signatureHeader(NOW_S, signature));
  check(
    'a signature from a different secret is refused',
    result.ok === false && result.log.includes('no_match'),
    result.log,
  );
  // The most common real failure by a distance: `stripe listen` prints a
  // different whsec_ than the Dashboard endpoint, so the log has to point at it.
  check(
    'and the log names the secret mismatch as a cause, not just "invalid"',
    result.log.includes('STRIPE_WEBHOOK_SECRET'),
    result.log,
  );
  check('the secret never reaches the log', !result.log.includes(WEBHOOK_SECRET), result.log);
}

{
  // Replay: a signature that WAS valid, re-presented with a fresh timestamp to
  // get past the tolerance. The timestamp is inside the signed payload, so the
  // two cannot be mixed and matched.
  const stale = NOW_S - 4000;
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, stale);
  const replayed = await verifySignature(BODY, signatureHeader(NOW_S, signature));
  check(
    'a captured signature cannot be replayed under a fresh timestamp',
    replayed.ok === false && replayed.log.includes('no_match'),
    replayed.log,
  );
  const asCaptured = await verifySignature(BODY, signatureHeader(stale, signature));
  check(
    'and replaying it verbatim is refused on the timestamp',
    asCaptured.ok === false && asCaptured.log.includes('timestamp_out_of_tolerance'),
    asCaptured.log,
  );
}

for (const [name, offset] of [
  ['an expired timestamp', -(STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1)],
  // A far-future `t` is as invalid as an expired one: accepting it would turn
  // one captured request into a replay token that never ages out.
  ['a far-future timestamp', STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1],
]) {
  const timestamp = NOW_S + offset;
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, timestamp);
  const result = await verifySignature(BODY, signatureHeader(timestamp, signature));
  check(
    `${name} is refused even though the HMAC is correct`,
    result.ok === false && result.log.includes('timestamp_out_of_tolerance'),
    result.log,
  );
}

for (const [name, offset] of [
  ['exactly at the tolerance in the past', -STRIPE_SIGNATURE_TOLERANCE_SECONDS],
  ['exactly at the tolerance in the future', STRIPE_SIGNATURE_TOLERANCE_SECONDS],
]) {
  const timestamp = NOW_S + offset;
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, timestamp);
  const result = await verifySignature(BODY, signatureHeader(timestamp, signature));
  check(`${name} still verifies`, result.ok === true, result.log);
}

{
  // Mid-rotation an endpoint is signed with the old AND the new secret, so the
  // header carries several v1 values and only one of them is ours.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const other = await signStripePayload(BODY, 'whsec_the_expiring_one', NOW_S);
  const first = await verifySignature(BODY, signatureHeader(NOW_S, signature, other));
  const last = await verifySignature(BODY, signatureHeader(NOW_S, other, signature));
  check('a rotation header verifies when ours is first', first.ok === true, first.log);
  check('and when ours is last', last.ok === true, last.log);
}

{
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const result = await verifySignature(
    BODY,
    `t=${NOW_S},v0=${'f'.repeat(64)},v1=${signature}`,
  );
  check('a v0 entry is ignored rather than tried', result.ok === true, result.log);

  const v0Only = await verifySignature(BODY, `t=${NOW_S},v0=${signature}`);
  check(
    'a header with no v1 at all is malformed, not a signature failure',
    v0Only.ok === false && v0Only.log.includes('malformed_header'),
    v0Only.log,
  );
}

{
  // One junk candidate must not invalidate a good one sitting beside it.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const result = await verifySignature(BODY, `t=${NOW_S},v1=nope,v1=${signature}`);
  check('a malformed candidate is dropped, not fatal', result.ok === true, result.log);
}

{
  // Every candidate costs one HMAC over the whole body, and this endpoint is
  // public - the signature IS the authentication, so the work happens before we
  // know who is calling. Cloudflare's ~16kB of headers fits about 240 candidates,
  // which against a large body is a free way to burn the worker's CPU budget.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const junk = count => Array.from({ length: count }, (_, index) => `v1=${String(index).padStart(64, '0')}`);

  const atCap = await verifySignature(
    BODY,
    [`t=${NOW_S}`, ...junk(7), `v1=${signature}`].join(','),
  );
  check(
    'a rotation-sized header verifies with ours in the last tried slot',
    atCap.ok === true,
    atCap.log,
  );

  const stuffed = await verifySignature(
    BODY,
    [`t=${NOW_S}`, ...junk(200), `v1=${signature}`].join(','),
  );
  check(
    'a header stuffed with candidates is bounded rather than verified 200 times',
    stuffed.ok === false && stuffed.log.includes('no_match'),
    stuffed.log,
  );
  // Silently dropping them would make a capped header read as a wrong secret,
  // which is the one diagnosis an operator acts on.
  check(
    'and the log says the cap bit, so it cannot be misread as a wrong secret',
    stuffed.log.includes('201 present'),
    stuffed.log,
  );
}

{
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const upper = await verifySignature(BODY, signatureHeader(NOW_S, signature.toUpperCase()));
  check('hex case does not matter', upper.ok === true, upper.log);

  const spaced = await verifySignature(BODY, ` t = ${NOW_S} , v1 = ${signature} `);
  check(
    'whitespace an intermediary added does not break a payment webhook',
    spaced.ok === true,
    spaced.log,
  );
}

{
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const malformed = [
    ['no header at all', null, 'missing_header'],
    ['an empty header', '', 'missing_header'],
    ['prose instead of a header', 'not-a-signature', 'malformed_header'],
    ['no t=', `v1=${signature}`, 'malformed_header'],
    ['no v1=', `t=${NOW_S}`, 'malformed_header'],
    ['a non-hex v1', `t=${NOW_S},v1=${'z'.repeat(64)}`, 'malformed_header'],
    ['a short v1', `t=${NOW_S},v1=abcd`, 'malformed_header'],
    ['a non-numeric t', `t=yesterday,v1=${signature}`, 'malformed_header'],
    ['a t with trailing junk a lenient parse would accept', `t=${NOW_S}abc,v1=${signature}`, 'malformed_header'],
    ['a negative t', `t=-${NOW_S},v1=${signature}`, 'malformed_header'],
    // Two timestamps is an ambiguity, and picking one silently would decide
    // which value guards the replay window by accident.
    ['a duplicate t', `t=${NOW_S},t=${NOW_S - 1000},v1=${signature}`, 'malformed_header'],
  ];
  for (const [name, header, reason] of malformed) {
    const result = await verifySignature(BODY, header);
    check(
      `${name} is a clean refusal (${reason})`,
      result.ok === false && result.log.includes(reason),
      result.log,
    );
  }
}

{
  const signature = await signStripePayload('', WEBHOOK_SECRET, NOW_S);
  const result = await verifySignature('', signatureHeader(NOW_S, signature));
  check(
    'an empty body is refused even with a correct signature over it',
    result.ok === false && result.log.includes('empty_body'),
    result.log,
  );
}

{
  // Behind requireStripeSecret's 501, but an empty HMAC key throws in some
  // WebCrypto implementations - and inside a webhook a throw is a 500 and days
  // of Stripe retries. `undefined` is in the list because
  // `StripeEnv.STRIPE_WEBHOOK_SECRET` is optional, so it is what a route reading
  // env directly would hand over.
  const header = signatureHeader(NOW_S, 'a'.repeat(64));
  for (const [name, secret] of [
    ['an unconfigured secret', ''],
    ['a whitespace-only secret', '  \n'],
    ['an absent binding (undefined)', undefined],
    ['a null secret', null],
  ]) {
    const result = await captureWarnings(() => verifyStripeSignature(BODY, header, secret));
    check(
      `${name} refuses rather than throwing`,
      result.ok === false && result.log.includes('no_secret'),
      result.log,
    );
  }
}

{
  // `wrangler secret put` stores the trailing newline you did not mean to paste,
  // and `requireStripeSecret` hands back a trimmed value - so checking the
  // trimmed secret while hashing with the padded one would answer `no_match`,
  // which reads as "wrong secret or altered body" and sends an operator hunting
  // a problem that is not there.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const result = await verifySignature(
    BODY,
    signatureHeader(NOW_S, signature),
    `\n ${WEBHOOK_SECRET} \n`,
  );
  check('a secret stored with stray whitespace still verifies', result.ok === true, result.log);
}

{
  // The default clock has to be the real one, or a deployed worker would verify
  // against a fixed instant. Signed at wall-clock now, with no options passed.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, timestamp);
  const result = await captureWarnings(() =>
    verifyStripeSignature(BODY, signatureHeader(timestamp, signature), WEBHOOK_SECRET),
  );
  check('the clock defaults to Date.now()', result.ok === true, result.log);
}

// ── Webhook signatures: the rest of the matrix (task 3.5, requirement 11) ────
//
// Everything above verifies FIXTURES: a fixed body, a fixed clock, a handful of
// hand-written headers. That is the right shape for "this exact malformed header
// is refused with this exact reason", and it is the wrong shape for the two
// claims requirement 11 actually makes about the whole input space - that nothing
// except a genuine signature is ever accepted, and that a signature authorizes
// ONE body rather than any body. Those are properties, so they are tested as
// properties.
//
// The rest of this section fills in what the fixtures left open, and each case is
// here because it is a boundary rather than another example:
//
//  - Every accepted LENGTH has an untested side. `abcd` proves a 4 character
//    candidate is dropped and says nothing about 63 or 65, which is where an
//    unanchored regex or an off-by-one actually goes wrong. Same for the 15 digit
//    timestamp cap and the 8 candidate cap, which is pinned at 8 accepted and 9
//    dropped rather than only at 200.
//  - The replay cases above all fail on the CLOCK, so nothing yet shows the
//    timestamp is bound into the signed payload on its own. Two in-tolerance
//    timestamps one second apart show it.
//  - Every positive case above is signed with the same `crypto.subtle` the
//    verifier uses, so a shared misreading of the payload format would pass
//    twice. One vector from `node:crypto` removes that.
//  - The HMAC is over BYTES. A multi-byte body and a megabyte body are the two
//    ends of that, and neither has appeared yet.

console.log('\nverifyStripeSignature: the rest of the matrix');

/** Runs one asynchronous property with the verifier's own warnings swallowed. */
async function asyncProperty(name, build) {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await fc.assert(build(), RUNS);
    check(name, true);
  } catch (error) {
    check(name, false, describeFailure(error));
  } finally {
    console.warn = realWarn;
  }
}

/** The raw verifier against the fixed clock, for use inside a property. */
function verifyAt(raw, header, secret = WEBHOOK_SECRET) {
  return verifyStripeSignature(raw, header, secret, { nowMs: NOW_MS });
}

/** 64 lowercase hex characters: the shape a candidate has to have to be TRIED. */
const arbHex64 = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 64,
  maxLength: 64,
});

/**
 * A body as `request.text()` could produce one.
 *
 * `grapheme` rather than `binary` on purpose, and not to make the property
 * easier: `request.text()` decodes bytes, so it cannot hand over a lone
 * surrogate, while `binary` generates them freely - and two DIFFERENT lone
 * surrogates encode to the same U+FFFD bytes, so "a signature over A never
 * validates B" would be false for a reason that has nothing to do with this
 * verifier and everything to do with what a string can hold.
 */
const arbBody = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 200 });

// ── The two properties ───────────────────────────────────────────────────────

await asyncProperty('no v1 value a caller can invent is ever accepted', () =>
  fc.asyncProperty(
    arbBody,
    // Weighted towards the shape that actually reaches the HMAC. An arbitrary
    // string is refused by the hex check, which is a different code path and a
    // much weaker statement - 64 hex characters is what makes this a claim about
    // `crypto.subtle.verify` rather than about a regex.
    fc.oneof(
      { weight: 4, arbitrary: arbHex64 },
      { weight: 1, arbitrary: arbHex64.map(hex => hex.toUpperCase()) },
      { weight: 1, arbitrary: fc.string({ maxLength: 80 }) },
      { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 40 }) },
    ),
    // Deliberately INSIDE the tolerance, so a refusal can only have come from the
    // MAC. A random offset would let the clock refuse most of the runs and the
    // property would pass without exercising the thing it names.
    fc.integer({
      min: -STRIPE_SIGNATURE_TOLERANCE_SECONDS,
      max: STRIPE_SIGNATURE_TOLERANCE_SECONDS,
    }),
    async (body, candidate, offset) =>
      (await verifyAt(body, `t=${NOW_S + offset},v1=${candidate}`)) === false,
  ),
);

await asyncProperty('a signature authorizes exactly the body it was made over', () =>
  fc.asyncProperty(arbBody, arbBody, async (signed, other) => {
    fc.pre(signed !== other);
    const header = signatureHeader(NOW_S, await signStripePayload(signed, WEBHOOK_SECRET, NOW_S));
    // BOTH halves, so the property cannot pass by refusing everything - a
    // verifier that always returned false would satisfy the interesting half on
    // its own, and that is the failure mode a "nothing is accepted" property
    // invites.
    return (await verifyAt(signed, header)) === true && (await verifyAt(other, header)) === false;
  }),
);

// ── An independent known-answer vector ───────────────────────────────────────

{
  // Every positive case in this suite so far signs with `crypto.subtle.sign`,
  // which is the same primitive `verifyStripeSignature` verifies with. The
  // payload FORMAT is written out independently in `signStripePayload`, so a
  // wrong separator would be caught - but a shared misreading of what
  // `crypto.subtle` does with a key or a body would not be. `node:crypto`'s
  // `createHmac` is a different implementation reached through a different API,
  // so agreeing with it is a statement about the bytes rather than about one
  // library agreeing with itself.
  const expected = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${NOW_S}.${BODY}`, 'utf8')
    .digest('hex');
  const result = await verifySignature(BODY, signatureHeader(NOW_S, expected));
  check('a MAC computed by node:crypto verifies, so the payload bytes are right', result.ok === true, result.log);
}

// ── The timestamp is signed, not just checked ────────────────────────────────

{
  // Every replay case above is refused by the CLOCK, which means none of them
  // shows that `t` is part of the signed payload at all: a verifier that hashed
  // the body alone would pass all of them. Two timestamps a minute apart, both
  // comfortably inside the tolerance, is the case that separates the two.
  const signedAt = NOW_S - 60;
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, signedAt);

  const asSigned = await verifySignature(BODY, signatureHeader(signedAt, signature));
  check('an in-tolerance timestamp verifies under the t it was signed with', asSigned.ok === true, asSigned.log);

  const moved = await verifySignature(BODY, signatureHeader(NOW_S, signature));
  check(
    'and not under a different in-tolerance t, where the clock cannot be what refuses it',
    moved.ok === false && moved.log.includes('no_match'),
    moved.log,
  );

  const oneSecond = await verifySignature(BODY, signatureHeader(signedAt + 1, signature));
  check(
    'one second of difference is enough, because t is bytes in the payload',
    oneSecond.ok === false && oneSecond.log.includes('no_match'),
    oneSecond.log,
  );
}

{
  // The reason `ParsedStripeSignature.timestamp` keeps the string EXACTLY as it
  // arrived instead of re-serializing the parsed number. `t=01700000000` and
  // `t=1700000000` are the same instant and different bytes, so a verifier that
  // normalized the spelling would answer `no_match` on a delivery whose
  // signature is perfect - and `no_match` reads as "wrong secret", which is the
  // one diagnosis an operator acts on.
  const padded = `0${NOW_S}`;
  const overPadded = await signStripePayload(BODY, WEBHOOK_SECRET, padded);
  const asSent = await verifySignature(BODY, `t=${padded},v1=${overPadded}`);
  check('a t with a leading zero verifies against the bytes AS SENT', asSent.ok === true, asSent.log);

  const canonical = await signStripePayload(BODY, WEBHOOK_SECRET, String(NOW_S));
  const normalized = await verifySignature(BODY, `t=${padded},v1=${canonical}`);
  check(
    'and the canonical spelling does not verify under the padded one',
    normalized.ok === false && normalized.log.includes('no_match'),
    normalized.log,
  );
}

// ── Length boundaries ────────────────────────────────────────────────────────

{
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);

  // 63 and 65 are the two sides of the only length that can be a SHA-256 MAC,
  // and both are built by damaging the REAL signature rather than from filler:
  // that way the case also says the length check is not "carries the right 63
  // characters", which an unanchored pattern would accept.
  for (const [name, candidate] of [
    ['a v1 one character short', signature.slice(0, 63)],
    ['a v1 carrying the right 64 characters plus a 65th', `${signature}f`],
    ['an empty v1', ''],
  ]) {
    const result = await verifySignature(BODY, `t=${NOW_S},v1=${candidate}`);
    check(
      `${name} is dropped, leaving nothing to verify (malformed_header)`,
      result.ok === false && result.log.includes('malformed_header'),
      result.log,
    );
  }

  // The timestamp is capped at 15 digits so the parsed value is always exactly
  // representable, and the two sides of that cap fail DIFFERENTLY - which is the
  // point. A 15 digit timestamp is a readable instant far outside the tolerance;
  // a 16 digit one is not a timestamp at all and never reaches the comparison.
  for (const [name, header, reason] of [
    ['an empty t', `t=,v1=${signature}`, 'malformed_header'],
    [
      'a 15 digit t, the widest spelling that stays exactly representable',
      `t=${'9'.repeat(15)},v1=${signature}`,
      'timestamp_out_of_tolerance',
    ],
    [
      'a 16 digit t, past the point a JS number can hold it',
      `t=${'9'.repeat(16)},v1=${signature}`,
      'malformed_header',
    ],
    // A client sending milliseconds is a real bug and not a malformed header, so
    // it has to land on the tolerance and say so. Diagnosing it as "malformed"
    // would send whoever wrote that client looking at their header format.
    ['a millisecond t rather than seconds', `t=${NOW_MS},v1=${signature}`, 'timestamp_out_of_tolerance'],
  ]) {
    const result = await verifySignature(BODY, header);
    check(`${name} is refused (${reason})`, result.ok === false && result.log.includes(reason), result.log);
  }
}

// ── Near misses ──────────────────────────────────────────────────────────────

{
  // Requirement 11's constant-time clause is satisfied by construction:
  // `crypto.subtle.verify` computes the expected MAC and compares it internally,
  // and this module never decodes a candidate to compare it itself. A test cannot
  // measure that from here - timing a Node process proves nothing - but it CAN
  // pin the bug class a hand-rolled comparison introduces, which is a comparison
  // that stops early or looks at part of the value. A single flipped nibble at
  // each end and in the middle is refused identically, so no prefix, suffix or
  // truncated comparison can be hiding in here.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const flip = index =>
    signature.slice(0, index) + (signature[index] === '0' ? '1' : '0') + signature.slice(index + 1);

  for (const [name, index] of [
    ['its first nibble', 0],
    ['a nibble in the middle', 32],
    ['its last nibble', 63],
  ]) {
    const result = await verifySignature(BODY, signatureHeader(NOW_S, flip(index)));
    check(
      `a candidate differing only in ${name} is refused`,
      result.ok === false && result.log.includes('no_match'),
      result.log,
    );
  }
}

{
  // Stripe repeating a value, or a proxy duplicating a header element, must not
  // read as an ambiguity the way a duplicate `t` does. There is nothing to
  // adjudicate: two identical candidates are one candidate.
  const signature = await signStripePayload(BODY, WEBHOOK_SECRET, NOW_S);
  const duplicated = await verifySignature(BODY, signatureHeader(NOW_S, signature, signature));
  check('a header repeating the same v1 verifies', duplicated.ok === true, duplicated.log);

  // The cap boundary itself, at exactly the off-by-one: eight candidates tried,
  // the ninth dropped even though it is the genuine one. The stuffed-header case
  // above shows the bound EXISTS somewhere below 201; this shows it is 8.
  //
  // Eight IDENTICAL junk candidates rather than eight distinct ones, because that
  // makes the case say a second thing: candidates are not deduplicated on the way
  // in. Deduplicating is the obvious "improvement" here and it is the wrong one -
  // it would collapse these eight into one slot, let ours through, and hand an
  // attacker 8 free HMACs per distinct value they send.
  const junk = `v1=${'0'.repeat(64)}`;
  const pastCap = await verifySignature(
    BODY,
    [`t=${NOW_S}`, ...Array.from({ length: 8 }, () => junk), `v1=${signature}`].join(','),
  );
  check(
    'a ninth candidate is dropped even when it is the genuine one',
    pastCap.ok === false && pastCap.log.includes('no_match') && pastCap.log.includes('9 present'),
    pastCap.log,
  );
}

// ── Bodies: bytes, not characters ────────────────────────────────────────────

{
  // A Stripe event carries customer names and product descriptions, so a
  // multi-byte body is ordinary traffic rather than an edge case. The HMAC is
  // over UTF-8 bytes, and the vector is computed by `node:crypto` again so the
  // agreement is about the encoding rather than about `crypto.subtle` agreeing
  // with itself: a character counted as one unit instead of its two or four
  // bytes would shift every byte after it.
  const unicodeBody = JSON.stringify({
    id: 'evt_1',
    customer: 'Bäckerei Müller GmbH',
    note: '日本語のメモ 🥐',
  });
  const expected = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${NOW_S}.${unicodeBody}`, 'utf8')
    .digest('hex');
  const result = await verifySignature(unicodeBody, signatureHeader(NOW_S, expected));
  check('a body with multi-byte characters verifies against a byte-computed MAC', result.ok === true, result.log);

  // Same code-unit length, different bytes. `ü` is one UTF-16 unit and two UTF-8
  // bytes, so anything measuring the body in characters would treat this as the
  // same input.
  const swapped = unicodeBody.replace('Müller', 'Muller');
  const tampered = await verifySignature(swapped, signatureHeader(NOW_S, expected));
  check(
    'and swapping one multi-byte character for a single-byte one does not',
    tampered.ok === false && tampered.log.includes('no_match'),
    tampered.log,
  );
}

{
  // A megabyte body is what an `invoice.*` event with a long line item list
  // looks like, and it is also the size that makes the candidate cap matter. The
  // flipped byte sits in the middle rather than at either end, where a verifier
  // hashing a prefix would still refuse it.
  const largeBody = JSON.stringify({ id: 'evt_1', blob: 'a'.repeat(1_000_000) });
  const signature = await signStripePayload(largeBody, WEBHOOK_SECRET, NOW_S);
  const ok = await verifySignature(largeBody, signatureHeader(NOW_S, signature));
  check('a megabyte body verifies', ok.ok === true, ok.log);

  const midpoint = Math.floor(largeBody.length / 2);
  const flipped = `${largeBody.slice(0, midpoint)}b${largeBody.slice(midpoint + 1)}`;
  const tampered = await verifySignature(flipped, signatureHeader(NOW_S, signature));
  check(
    'and one byte changed half a megabyte in is still refused',
    tampered.ok === false && tampered.log.includes('no_match'),
    tampered.log,
  );
}

console.log(failures === 0 ? '\nstripe: all checks passed' : `\nstripe: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
