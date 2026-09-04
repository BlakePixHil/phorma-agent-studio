/**
 * Public service-status route (`/status.json`, `/status.svg`).
 *
 * No worker and no Durable Object: every binding is a hand-rolled stub with the
 * exact surface `status.ts` touches, and `fetch` is replaced so the Clerk and
 * OpenRouter probes are deterministic. That covers the parts most likely to
 * regress and the parts that would be embarrassing in public:
 *
 *  - the rollup rules (critical vs non-critical, notice can only make it worse)
 *  - `unknown` for absent bindings, so a BYO worker is not painted red
 *  - vendor and internal error text never reaching the response body
 *  - open CORS, cache headers, method handling, and the badge colour
 *
 * Run: npx -y tsx cloud/test/status.test.mjs
 */

import { registerHooks } from 'node:module';

// `status.ts` reaches the portal registry and the credential vault, both of
// which extend `cloudflare:workers`' `DurableObject`. Node cannot resolve that
// built-in, so it is redirected before the module graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { collectStatus, handleStatusRequest, rollup } = await import('../src/status.ts');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Stubs ────────────────────────────────────────────────────────────────────

const CLERK_SECRET = 'sk_test_do_not_leak_me';
const OPENROUTER_KEY = 'sk-or-v1-do-not-leak-me';
const STRIPE_SECRET = 'sk_test_stripe_do_not_leak_me';

/** A binding set where everything works. Override per test. */
function healthyEnv(overrides = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: CLERK_SECRET,
    OPENROUTER_PROVISIONING_KEY: OPENROUTER_KEY,
    STRIPE_SECRET_KEY: STRIPE_SECRET,
    KEY_ENC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    WorkflowAgent: namespaceStub({ publishedSpec: async () => null }),
    PortalIndex: namespaceStub({ resolve: async () => null }),
    SecretVault: namespaceStub({ entries: async () => [] }),
    // `batch` is here for the telemetry probe's self-healing schema creation.
    DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }), batch: async () => [] },
    TENANTS: { get: async () => null },
    RELEASES: { head: async () => ({ size: 1024 }) },
    ...overrides,
  };
}

function namespaceStub(instance) {
  return { idFromName: name => name, get: () => instance };
}

/** Installs a fetch stub for the three vendor probes. */
function stubFetch({
  clerkStatus = 200,
  clerkIndicator = 'none',
  openRouterStatus = 200,
  stripeStatus = 200,
} = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    seen.push({ href, headers: init?.headers ?? {} });
    if (href.includes('status.clerk.com')) {
      return jsonish({ status: { indicator: clerkIndicator } }, 200);
    }
    if (href.includes('api.clerk.com')) {
      return jsonish({ keys: [] }, clerkStatus);
    }
    if (href.includes('openrouter.ai')) {
      return jsonish({ data: { total_credits: 1 } }, openRouterStatus);
    }
    if (href.includes('api.stripe.com')) {
      // Stripe error bodies QUOTE THE KEY BACK (`Expired API Key provided:
      // sk_test_...`), so the stub does too: the probe must not read a body at
      // all, and this is what would catch it starting to.
      return stripeStatus >= 200 && stripeStatus < 300
        ? jsonish({ object: 'list', data: [] }, stripeStatus)
        : jsonish(
            { error: { code: 'api_key_expired', message: `Expired API Key provided: ${STRIPE_SECRET}` } },
            stripeStatus,
          );
    }
    throw new Error(`Unexpected probe target: ${href}`);
  };
  return seen;
}

function jsonish(body, status) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: async () => {} },
    json: async () => JSON.parse(text),
  };
}

function byId(payload, id) {
  return payload.components.find(component => component.id === id);
}

const ctx = { waitUntil: () => {} };

// ── Rollup rules (pure) ──────────────────────────────────────────────────────

function component(overrides) {
  return {
    id: 'x',
    name: 'X',
    description: '',
    status: 'operational',
    critical: false,
    latencyMs: 1,
    detail: null,
    vendor: null,
    ...overrides,
  };
}

console.log('\nRollup rules');
check(
  'all operational rolls up green',
  rollup([component({}), component({ critical: true })], null) === 'operational',
);
check(
  'critical outage rolls up red',
  rollup([component({ status: 'outage', critical: true })], null) === 'outage',
);
check(
  'non-critical outage rolls up amber',
  rollup([component({ status: 'outage', critical: false })], null) === 'degraded',
);
check(
  'degraded critical rolls up amber, not red',
  rollup([component({ status: 'degraded', critical: true })], null) === 'degraded',
);
check(
  'unknown components are ignored',
  rollup([component({ status: 'unknown', critical: true })], null) === 'operational',
);
check(
  'a degraded notice cannot be beaten by healthy probes',
  rollup([component({})], { status: 'degraded', message: 'Maintenance' }) === 'degraded',
);
check(
  'a degraded notice cannot downgrade a real outage',
  rollup([component({ status: 'outage', critical: true })], {
    status: 'degraded',
    message: 'Maintenance',
  }) === 'outage',
);
check(
  'an outage notice overrides healthy probes',
  rollup([component({})], { status: 'outage', message: 'Down' }) === 'outage',
);

// ── Aggregation ──────────────────────────────────────────────────────────────

console.log('\nAggregation');
{
  const probes = stubFetch();
  const payload = await collectStatus(healthyEnv());
  check('healthy deployment is operational', payload.status === 'operational', payload.summary);
  check('healthy deployment is green', payload.indicator === 'green');
  check('summary reads well', payload.summary === 'All systems operational', payload.summary);
  check('mode reports hosted', payload.mode === 'hosted');
  check(
    'every component is probed',
    payload.components.map(entry => entry.id).join(',') ===
      'runtime,api,plans,vault,portals,downloads,auth,inference,billing,telemetry',
    payload.components.map(entry => entry.id).join(','),
  );
  check(
    'billing is non-critical (requirement 35)',
    byId(payload, 'billing').critical === false && byId(payload, 'billing').vendor === 'Stripe',
    JSON.stringify(byId(payload, 'billing')),
  );
  check(
    'the billing probe is a read-only GET against the price catalogue',
    (() => {
      const stripeCalls = probes.filter(entry => entry.href.includes('api.stripe.com'));
      return (
        stripeCalls.length === 1 &&
        stripeCalls[0].href === 'https://api.stripe.com/v1/prices?limit=1'
      );
    })(),
    JSON.stringify(probes.filter(entry => entry.href.includes('api.stripe.com'))),
  );
  check(
    'no component is unknown on a fully bound worker',
    payload.components.every(entry => entry.status === 'operational'),
    JSON.stringify(payload.components.filter(entry => entry.status !== 'operational')),
  );
  check('checkedAt is an ISO timestamp', !Number.isNaN(Date.parse(payload.checkedAt)));
  check('latency is recorded', payload.components.every(entry => typeof entry.latencyMs === 'number'));
}

{
  stubFetch();
  const payload = await collectStatus(
    healthyEnv({
      DB: {
        prepare: () => ({
          first: async () => {
            throw new Error('D1_ERROR: no such table sqlite_master in shard 7');
          },
        }),
      },
    }),
  );
  check('a critical binding failure is red', payload.status === 'outage', payload.summary);
  check('the failing component is named in the summary', payload.summary.includes('Studio API'));
  check(
    'the internal exception message is not forwarded',
    !JSON.stringify(payload).includes('sqlite_master'),
    byId(payload, 'api').detail,
  );
}

{
  stubFetch();
  const payload = await collectStatus(
    healthyEnv({
      RELEASES: {
        head: async () => {
          throw new Error('R2 unavailable');
        },
      },
    }),
  );
  check('a non-critical failure is amber, not red', payload.status === 'degraded', payload.summary);
  check('the non-critical component reports the outage', byId(payload, 'downloads').status === 'outage');
}

{
  stubFetch({ clerkIndicator: 'minor' });
  const payload = await collectStatus(healthyEnv());
  check('a Clerk minor incident degrades sign-in', byId(payload, 'auth').status === 'degraded');
  check('a Clerk minor incident is amber overall', payload.indicator === 'amber');
}

{
  stubFetch({ clerkIndicator: 'major' });
  const payload = await collectStatus(healthyEnv());
  check('a Clerk major incident is red', payload.status === 'outage', payload.summary);
}

{
  stubFetch({ clerkStatus: 401 });
  const payload = await collectStatus(healthyEnv());
  check('a rejected Clerk key is an outage', byId(payload, 'auth').status === 'outage');
  check(
    'the Clerk secret never reaches the response',
    !JSON.stringify(payload).includes(CLERK_SECRET),
  );
}

{
  stubFetch({ openRouterStatus: 401 });
  const payload = await collectStatus(healthyEnv());
  check('a rejected model key is an outage', byId(payload, 'inference').status === 'outage');
  check(
    'the OpenRouter key never reaches the response',
    !JSON.stringify(payload).includes(OPENROUTER_KEY),
  );
}

{
  stubFetch({ openRouterStatus: 429 });
  const payload = await collectStatus(healthyEnv());
  check('model rate limiting is degraded, not down', byId(payload, 'inference').status === 'degraded');
}

// Requirement 35: Stripe stops new purchases, not running tenants, so its
// outage must be amber. This is the assertion that catches somebody "promoting"
// billing to critical because a payment provider feels important.
{
  stubFetch({ stripeStatus: 500 });
  const payload = await collectStatus(healthyEnv());
  check('an unreachable payment provider is an outage', byId(payload, 'billing').status === 'outage');
  check('a billing outage is amber, never red', payload.status === 'degraded', payload.summary);
  check('the billing component is named in the summary', payload.summary.includes('Subscriptions and payments'), payload.summary);
}

{
  stubFetch({ stripeStatus: 401 });
  const payload = await collectStatus(healthyEnv());
  check('a rejected billing key is an outage', byId(payload, 'billing').status === 'outage');
  check(
    'the Stripe secret never reaches the response',
    !JSON.stringify(payload).includes(STRIPE_SECRET),
    byId(payload, 'billing').detail,
  );
  check(
    'the Stripe error body never reaches the response',
    !JSON.stringify(payload).includes('api_key_expired') &&
      !JSON.stringify(payload).includes('Expired API Key'),
    byId(payload, 'billing').detail,
  );
}

{
  stubFetch({ stripeStatus: 429 });
  const payload = await collectStatus(healthyEnv());
  check('billing rate limiting is degraded, not down', byId(payload, 'billing').status === 'degraded');
}

// A hosted worker with no Stripe secret is UNCONFIGURED, not broken: the billing
// routes answer 501 naming the secret, and a public badge must not go amber for a
// catalogue that has not launched yet.
{
  const probes = stubFetch();
  const payload = await collectStatus(healthyEnv({ STRIPE_SECRET_KEY: undefined }));
  check('an unconfigured hosted billing surface is unknown', byId(payload, 'billing').status === 'unknown');
  check('unconfigured billing does not colour the rollup', payload.status === 'operational', payload.summary);
  check(
    'no Stripe call is made without a key',
    probes.every(entry => !entry.href.includes('api.stripe.com')),
  );
}

// An empty secret is what `wrangler secret put` stores for a stray newline. It
// must read as absent rather than as a rejected credential.
{
  stubFetch();
  const payload = await collectStatus(healthyEnv({ STRIPE_SECRET_KEY: '  \n' }));
  check('a blank Stripe secret reads as absent', byId(payload, 'billing').status === 'unknown');
}

// ── BYO deployment: absent bindings must not read as failures ────────────────

console.log('\nBYO deployment');
{
  stubFetch();
  const payload = await collectStatus({
    PHORMA_TOKEN: 'byo-token',
    WorkflowAgent: namespaceStub({ publishedSpec: async () => null }),
    PortalIndex: namespaceStub({ resolve: async () => null }),
  });
  check('a BYO worker is not painted red', payload.status === 'operational', payload.summary);
  check('mode reports byo', payload.mode === 'byo');
  check('the absent account database is unknown', byId(payload, 'api').status === 'unknown');
  check('the absent plan store is unknown', byId(payload, 'plans').status === 'unknown');
  check('absent downloads are unknown', byId(payload, 'downloads').status === 'unknown');
  check('absent Clerk is unknown', byId(payload, 'auth').status === 'unknown');
  check('absent hosted inference is unknown', byId(payload, 'inference').status === 'unknown');
  // 9.4: a BYO worker binds no STRIPE_SECRET_KEY. Excluded from the rollup, not
  // an outage.
  check('absent billing is unknown', byId(payload, 'billing').status === 'unknown');
  // 12.7: no D1 means no telemetry store, which must not read as degraded.
  check('the absent telemetry store is unknown', byId(payload, 'telemetry').status === 'unknown');
  check('the runtime is still probed', byId(payload, 'runtime').status === 'operational');
}

// ── Operator notice ─────────────────────────────────────────────────────────

console.log('\nOperator notice');
{
  stubFetch();
  const notice = { status: 'degraded', message: 'Scheduled maintenance 02:00-03:00 UTC' };
  const payload = await collectStatus(
    healthyEnv({ TENANTS: { get: async () => JSON.stringify(notice) } }),
  );
  check('a notice forces amber', payload.indicator === 'amber', payload.summary);
  check('the notice message becomes the summary', payload.summary === notice.message);
  check('the notice is echoed for the detail page', payload.notice?.message === notice.message);
}

{
  stubFetch();
  const expired = {
    status: 'outage',
    message: 'Old incident',
    until: new Date(Date.now() - 60_000).toISOString(),
  };
  const payload = await collectStatus(
    healthyEnv({ TENANTS: { get: async () => JSON.stringify(expired) } }),
  );
  check('an expired notice is ignored', payload.status === 'operational', payload.summary);
}

{
  stubFetch();
  const payload = await collectStatus(
    healthyEnv({ TENANTS: { get: async () => '{not json' } }),
  );
  check('a malformed notice does not break the page', payload.status === 'operational');
  check('a malformed notice is dropped', payload.notice === null);
}

// ── Timeouts ────────────────────────────────────────────────────────────────

console.log('\nTimeouts');
{
  stubFetch();
  const payload = await collectStatus(
    healthyEnv({
      WorkflowAgent: namespaceStub({ publishedSpec: () => new Promise(() => {}) }),
    }),
  );
  const runtime = byId(payload, 'runtime');
  check('a hung probe becomes an outage', runtime.status === 'outage');
  check('a hung probe says so', runtime.detail === 'Health check timed out.', runtime.detail);
  check('a hung critical probe is red overall', payload.status === 'outage');
}

// ── HTTP surface ────────────────────────────────────────────────────────────

console.log('\nHTTP surface');
{
  stubFetch();
  const env = healthyEnv();

  const unrelated = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/api/me'),
    env,
    ctx,
  );
  check('unrelated paths fall through', unrelated === null);

  const preflight = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/status.json', { method: 'OPTIONS' }),
    env,
    ctx,
  );
  check('preflight is answered', preflight?.status === 200);
  check(
    'preflight CORS is open',
    preflight?.headers.get('Access-Control-Allow-Origin') === '*',
    preflight?.headers.get('Access-Control-Allow-Origin'),
  );

  const posted = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/status.json', { method: 'POST' }),
    env,
    ctx,
  );
  check('POST is rejected', posted?.status === 405);

  const response = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/status.json'),
    env,
    ctx,
  );
  check('JSON route responds 200', response?.status === 200);
  check(
    'JSON route CORS is open',
    response?.headers.get('Access-Control-Allow-Origin') === '*',
  );
  check(
    'JSON route is cacheable',
    (response?.headers.get('Cache-Control') ?? '').includes('max-age=30'),
    response?.headers.get('Cache-Control'),
  );
  const body = await response.json();
  check('JSON route returns the payload', body.status === 'operational', body.summary);

  const badge = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/status.svg'),
    env,
    ctx,
  );
  const svg = await badge.text();
  check('badge is SVG', badge.headers.get('Content-Type').startsWith('image/svg+xml'));
  check('badge is green when healthy', svg.includes('#22c55e'), svg.slice(0, 120));
  check('badge is labelled for screen readers', svg.includes('aria-label="phorma cloud'));
}

{
  // An outage must still answer 200: a non-200 makes a generic monitor or a
  // browser fetch treat a correctly-reported outage as an unreachable endpoint.
  stubFetch({ openRouterStatus: 500 });
  const response = await handleStatusRequest(
    new Request('https://cloud.phorma-labs.com/status.json'),
    healthyEnv(),
    ctx,
  );
  const body = await response.json();
  check('an outage still answers HTTP 200', response.status === 200);
  check('an outage is reported in the body', body.status === 'outage', body.summary);
}

console.log(failures === 0 ? '\nstatus: all checks passed' : `\nstatus: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
