/**
 * The provisioning path: `POST /api/provision`, `POST /api/deactivate`, and the
 * runtime-key reconciliation both of them and the Stripe webhook share
 * (task group 8, requirements 1, 37, 38, 39).
 *
 * Every assertion here is about MONEY or a LEAKED CREDENTIAL, which is why the
 * suite exists separately from `billing-routes`:
 *
 *  - the OpenRouter key's `limit` is the real spend ceiling, and `tier` moves
 *    without it unless something patches it (requirement 37). An upgrade to team
 *    that leaves a starter key caps a $200 customer at $4; a downgrade that leaves
 *    a team key hands a $20 customer a $44 budget.
 *  - a superseded key that is never disabled stays live and spendable forever
 *    (requirement 38), and OpenRouter is the only place it is visible.
 *  - a FAILED disable that reports success is worse than a failure (requirement
 *    39). `/api/deactivate` used to `.catch(() => undefined)`, so a leaked key and
 *    a retired one produced byte-identical responses.
 *  - `tenants.id` IS the Clerk user id (requirement 1), so a typo in an operator's
 *    curl creates a row `/api/me` can never find - and an orphan tenant is
 *    indistinguishable from a user who has not signed in yet, so nothing ever
 *    notices.
 *
 * Harness. `handleApiRequest` is called DIRECTLY over a real local D1 (Miniflare's
 * SQLite binding pulled into Node with the real migrations applied), the same shape
 * `tenant-billing` and `billing-routes` use - so the SQL under test is the SQL that
 * ships and no loopback socket is spent per request. `globalThis.fetch` stands in
 * for OpenRouter and records every call WITH ITS BODY, because the body is where
 * `limit` and `disabled` live and those two fields are the whole subject here.
 *
 * The encryption is NOT stubbed: `KEY_ENC_SECRET` is a real 32-byte key and every
 * minted key is decrypted back through `TenantStore.runtimeKey`, which is what
 * proves the two key columns moved together rather than merely changed.
 *
 * Run: npx tsx cloud/test/provisioning.test.mjs
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected before
// the module graph loads - which is why `api.ts` arrives by dynamic import below.
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
const { TenantStore, grantCostUsd, isClerkUserId, reconcileRuntimeKey } = await import(
  '../src/tenants.ts'
);

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

/**
 * Captured BEFORE the stub swaps them, and used by `check` directly: the stub
 * captures `console.log` as well as the two error channels, so a check that
 * reported through the live console would both hide itself and pollute the
 * `stub.logs` array several assertions below search for a production log line.
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

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-provisioning' },
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

// --- Environment -----------------------------------------------------------

const ADMIN_TOKEN = 'admin-token-do-not-leak';
const PROVISIONING_KEY = 'or-provisioning-key-do-not-leak';
// A real base64 32-byte AES-GCM key, so encrypt/decrypt runs for real.
const KEY_ENC_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// The secret is bound HERE too, not just in the worker env: `store.runtimeKey`
// decrypts with the store's own binding, and that decryption is what proves a
// minted key was stored intact rather than merely stored.
const store = new TenantStore({ DB, KEY_ENC_SECRET });
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

/** The tier caps this suite asserts against - `TIERS` in `tenants.ts` owns them. */
const CAP = { starter: 4, pro: 12.6, team: 44 };

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_here',
    PHORMA_ADMIN_TOKEN: ADMIN_TOKEN,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
    KEY_ENC_SECRET,
    DB,
    ...extra,
  };
}

// --- The OpenRouter stub ---------------------------------------------------

const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let mintCounter = 0;

/**
 * Stands in for the OpenRouter key API and captures every call with its parsed
 * body. `failMint`, `failLimit` and `failDisable` inject the vendor failures the
 * requirement-39 assertions need; `hashless` reproduces a mint response with no
 * hash, which is the only way a stored key becomes unmanageable.
 */
function openRouterStub({ failMint = false, failLimit = false, failDisable = false, hashless = false } = {}) {
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
    if (url.host !== 'openrouter.ai') throw new Error(`unexpected outbound call to ${url.host}`);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      hash: url.pathname.replace('/api/v1/keys', '').replace(/^\//, ''),
      body,
      authorization: (init.headers ?? {}).Authorization ?? null,
    };
    calls.push(call);

    if (call.method === 'POST') {
      if (failMint) return jsonResponse({ error: { message: `mint refused for ${PROVISIONING_KEY}` } }, 402);
      mintCounter += 1;
      const hash = hashless ? '' : `hash_minted_${mintCounter}`;
      return jsonResponse({ key: `sk-or-v1-minted-${mintCounter}`, data: { hash } });
    }
    if (call.method === 'PATCH') {
      const disabling = body?.disabled === true;
      if (disabling && failDisable) return jsonResponse({ error: { message: 'disable refused' } }, 500);
      if (!disabling && failLimit) return jsonResponse({ error: { message: 'limit refused' } }, 500);
      return jsonResponse({ data: { hash: call.hash, disabled: disabling, limit: body?.limit } });
    }
    throw new Error(`unexpected OpenRouter method ${call.method}`);
  };

  return {
    calls,
    logs,
    mints: () => calls.filter((call) => call.method === 'POST'),
    limits: () => calls.filter((call) => call.method === 'PATCH' && call.body?.disabled !== true),
    disables: () => calls.filter((call) => call.method === 'PATCH' && call.body?.disabled === true),
    restore: () => {
      globalThis.fetch = realFetch;
      Object.assign(console, realConsole);
    },
  };
}

/** One `/api/*` request through the real router, as the admin unless told otherwise. */
async function api(env, path, { body, bearer = `Bearer ${ADMIN_TOKEN}`, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = bearer;
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

/** The stored key columns, read past the KV-less cache straight out of D1. */
async function keyColumns(id) {
  return DB.prepare('SELECT tier, status, openrouter_key_id, openrouter_key_enc FROM tenants WHERE id = ?')
    .bind(id)
    .first();
}

// ══ 1. tenantId must look like a Clerk user id (task 8.4, requirement 1) ════

console.log('\nPOST /api/provision refuses a tenantId that is not a Clerk user id (requirement 1)');
{
  const stub = openRouterStub();
  try {
    for (const [label, tenantId] of [
      ['a bare name', 'acme-corp'],
      ['an email', 'owner@example.com'],
      ['a near miss', 'usr_2abc'],
      ['the prefix alone', 'user_'],
      ['a Stripe customer id', 'cus_2abc'],
      ['whitespace inside', 'user_2abc def'],
      ['markup', '<script>user_2abc</script>'],
      ['a number', 42],
      ['too long', `user_${'a'.repeat(121)}`],
    ]) {
      const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId, tier: 'starter' } });
      check(`${label} is refused (400)`, answer.status === 400 && /Clerk user id/.test(answer.body?.error ?? ''), `${answer.status} ${JSON.stringify(answer.body)}`);
      // The whole point: no row, so no orphan for `/api/me` to fail to find.
      check(`${label} created no tenant row`, (await keyColumns(String(tenantId))) === null, String(tenantId));
    }
    // A missing id keeps its own message - it is a different mistake.
    const missing = await api(hostedEnv(), '/api/provision', { body: { tier: 'starter' } });
    check('a missing tenantId still says it is required', missing.status === 400 && /required/.test(missing.body?.error ?? ''), JSON.stringify(missing.body));

    check('no refused provision reached OpenRouter', stub.calls.length === 0, JSON.stringify(stub.calls));

    // The check sits INSIDE the admin branch, so a stranger is still a 401 and
    // learns nothing about the id format.
    const stranger = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'acme-corp' }, bearer: 'Bearer wrong' });
    check('an unauthorized caller is 401, not 400', stranger.status === 401, `${stranger.status} ${JSON.stringify(stranger.body)}`);

    // The predicate itself, at the boundary the route depends on.
    check('isClerkUserId accepts a real id', isClerkUserId('user_2abcDEF-90_x'));
    check('isClerkUserId rejects a non-string', !isClerkUserId(undefined) && !isClerkUserId(null) && !isClerkUserId({}));
    // A read must NOT re-validate: a row provisioned before this check can hold an
    // id that fails it, and refusing to resolve it would strand a real payment.
    await store.upsertTenant({ id: 'legacy-hand-provisioned', tier: 'pro', status: 'active' });
    check('a legacy row with a non-Clerk id is still readable', (await store.getTenant('legacy-hand-provisioned'))?.tier === 'pro');
  } finally {
    stub.restore();
  }
}

// ══ 2. A first-time provision mints at the tier's cap ══════════════════════

console.log('\nA first provision mints a key capped at the tier budget');
{
  const stub = openRouterStub();
  try {
    const answer = await api(hostedEnv(), '/api/provision', {
      body: { tenantId: 'user_upgrade', email: 'upgrade@example.com', tier: 'starter' },
    });

    check('answers 200', answer.status === 200 && answer.body?.ok === true, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('reports what it did to the key', answer.body?.runtimeKeyAction === 'minted' && answer.body?.runtimeKeyProvisioned === true, JSON.stringify(answer.body));
    check('reports the limit it minted at', answer.body?.runtimeKeyLimitUsd === CAP.starter, JSON.stringify(answer.body));
    // Nothing was superseded, which is a different fact from "we tried and failed".
    check('supersededKeyDisabled is null, not false', answer.body?.supersededKeyDisabled === null, JSON.stringify(answer.body));

    const mint = stub.mints()[0];
    check('exactly one key was minted', stub.mints().length === 1, JSON.stringify(stub.calls));
    check('the mint carries the tier cap as its limit', mint?.body?.limit === CAP.starter, JSON.stringify(mint?.body));
    check('the key is named for the tenant', mint?.body?.name === 'phorma-tenant-user_upgrade', JSON.stringify(mint?.body));
    check('nothing was disabled', stub.disables().length === 0, JSON.stringify(stub.calls));

    const row = await keyColumns('user_upgrade');
    check('both key columns were written together', row.openrouter_key_id === 'hash_minted_1' && Boolean(row.openrouter_key_enc), JSON.stringify(row));
    check('the tenant is active on the tier asked for', row.tier === 'starter' && row.status === 'active', JSON.stringify(row));
    // The ciphertext is the key, not a placeholder: decrypt it back.
    const stored = await store.runtimeKey(await store.getTenant('user_upgrade'));
    check('the stored key decrypts to the minted key', stored === 'sk-or-v1-minted-1', String(stored));
    check('the raw key is in no response body', !JSON.stringify(answer.body).includes('sk-or-v1-minted-1'), JSON.stringify(answer.body));
    check('the provisioning key is in no log line', !stub.logs.join('\n').includes(PROVISIONING_KEY), stub.logs.join(' | '));
  } finally {
    stub.restore();
  }
}

// ══ 3. A tier change MOVES the limit (task 8.1, requirement 37) ════════════

console.log('\nA tier change patches the existing key rather than leaving the old cap (requirement 37)');
{
  const stub = openRouterStub();
  try {
    const upgrade = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_upgrade', tier: 'team' } });

    check('answers 200', upgrade.status === 200, `${upgrade.status} ${JSON.stringify(upgrade.body)}`);
    check('the action is a limit update', upgrade.body?.runtimeKeyAction === 'limit_updated', JSON.stringify(upgrade.body));
    const patch = stub.limits()[0];
    check('exactly one limit patch was sent', stub.limits().length === 1, JSON.stringify(stub.calls));
    check('it targets the key the tenant already holds', patch?.hash === 'hash_minted_1', JSON.stringify(patch));
    check('it carries the NEW tier cap', patch?.body?.limit === CAP.team, JSON.stringify(patch?.body));
    // Two fields and no more. `disabled: false` is there so a RESUBSCRIBER's key,
    // retired when they cancelled, comes back into service with the new cap.
    check('it patches the cap and clears disabled, nothing else', Object.keys(patch?.body ?? {}).sort().join() === 'disabled,limit' && patch?.body?.disabled === false, JSON.stringify(patch?.body));
    // The point of patching: no rotation, so no second key and nothing to leak.
    check('no replacement key was minted', stub.mints().length === 0, JSON.stringify(stub.calls));
    check('nothing was disabled', stub.disables().length === 0, JSON.stringify(stub.calls));

    const row = await keyColumns('user_upgrade');
    check('the key columns are untouched', row.openrouter_key_id === 'hash_minted_1', JSON.stringify(row));
    check('the tier moved', row.tier === 'team', JSON.stringify(row));
    check('the email survived a tier-only write', (await store.getTenant('user_upgrade'))?.email === 'upgrade@example.com');

    // A DOWNGRADE has to move it back, or a $20 customer keeps a $44 budget.
    const downgrade = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_upgrade', tier: 'starter' } });
    check('a downgrade patches the cap back down', downgrade.body?.runtimeKeyAction === 'limit_updated' && stub.limits()[1]?.body?.limit === CAP.starter, JSON.stringify(stub.limits()));
  } finally {
    stub.restore();
  }
}

console.log('\nA failed limit patch is reported, not assumed (requirement 39)');
{
  const stub = openRouterStub({ failLimit: true });
  try {
    const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_upgrade', tier: 'pro' } });

    // The tenant row is fine; only the ceiling on the vendor side is stale, and
    // the operator running this curl is the only one who can act on that.
    check('the tenant write still succeeds (200)', answer.status === 200 && answer.body?.ok === true, `${answer.status} ${JSON.stringify(answer.body)}`);
    check('the failure is named in the response', answer.body?.runtimeKeyAction === 'limit_failed', JSON.stringify(answer.body));
    check('the key is still usable, so the tenant can run', answer.body?.runtimeKeyProvisioned === true, JSON.stringify(answer.body));
    check('a detail comes with it', typeof answer.body?.runtimeKeyDetail === 'string' && answer.body.runtimeKeyDetail.length > 0, JSON.stringify(answer.body));
    // Ours, not OpenRouter's. A vendor body can echo a request header, and this
    // field is in a JSON response, so the truncated upstream text stays in the log.
    check('the vendor message stays out of the response', !/limit refused/.test(answer.body?.runtimeKeyDetail ?? ''), JSON.stringify(answer.body));
    check('the vendor message IS in the log', stub.logs.some((line) => line.includes('limit refused')), stub.logs.join(' | '));
    check('it is logged as an error naming the tenant and the tier', stub.logs.some((line) => line.includes('user_upgrade') && line.includes('pro')), stub.logs.join(' | '));
    check('a failed patch does not fall back to minting', stub.mints().length === 0, JSON.stringify(stub.calls));

    const row = await keyColumns('user_upgrade');
    check('the tier still moved, so the studio and the gate agree', row.tier === 'pro', JSON.stringify(row));
    check('the key columns are untouched', row.openrouter_key_id === 'hash_minted_1' && Boolean(row.openrouter_key_enc), JSON.stringify(row));
    check('the vendor body does not reach the response', !JSON.stringify(answer.body).includes(PROVISIONING_KEY), JSON.stringify(answer.body));
  } finally {
    stub.restore();
  }
}

// ══ 4. A replacement disables the superseded key (task 8.2, requirement 38) ═

console.log('\nMinting a replacement disables the superseded key FIRST (requirement 38)');
{
  const stub = openRouterStub();
  try {
    const answer = await api(hostedEnv(), '/api/provision', {
      body: { tenantId: 'user_upgrade', tier: 'team', rotateKey: true },
    });

    check('the action is a mint', answer.body?.runtimeKeyAction === 'minted', JSON.stringify(answer.body));
    check('the superseded key is reported as disabled', answer.body?.supersededKeyDisabled === true, JSON.stringify(answer.body));
    check('the old key was disabled', stub.disables()[0]?.hash === 'hash_minted_1', JSON.stringify(stub.calls));
    // Order matters: this tenant must never hold two LIVE keys, so the retirement
    // happens before the replacement exists.
    check('the disable precedes the mint', stub.calls.findIndex((c) => c.method === 'PATCH') < stub.calls.findIndex((c) => c.method === 'POST'), JSON.stringify(stub.calls.map((c) => `${c.method} ${c.hash}`)));
    check('the replacement carries the tier cap', stub.mints()[0]?.body?.limit === CAP.team, JSON.stringify(stub.mints()[0]?.body));
    check('no limit patch was sent as well', stub.limits().length === 0, JSON.stringify(stub.calls));

    const row = await keyColumns('user_upgrade');
    check('both key columns moved to the replacement', row.openrouter_key_id === 'hash_minted_2' && Boolean(row.openrouter_key_enc), JSON.stringify(row));
    const stored = await store.runtimeKey(await store.getTenant('user_upgrade'));
    check('the stored ciphertext is the NEW key, not the old one', stored === 'sk-or-v1-minted-2', String(stored));
  } finally {
    stub.restore();
  }
}

console.log('\nA key with no usable ciphertext is replaced, and its hash retired');
{
  const stub = openRouterStub();
  try {
    // The desynchronized row: a hash on record, nothing decryptable behind it. The
    // gate refuses (`no_runtime_key`), so a replacement is the only way out - and
    // the hash we hold is a LIVE key that has to go with it.
    await store.upsertTenant({ id: 'user_desync', tier: 'pro', status: 'active', openrouterKeyId: 'hash_desync' });
    const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_desync', tier: 'pro' } });

    check('a replacement is minted without asking for a rotation', answer.body?.runtimeKeyAction === 'minted', JSON.stringify(answer.body));
    check('the orphaned hash was disabled', stub.disables()[0]?.hash === 'hash_desync' && answer.body?.supersededKeyDisabled === true, JSON.stringify(stub.calls));
    const row = await keyColumns('user_desync');
    check('the row now carries a complete pair', row.openrouter_key_id === 'hash_minted_3' && Boolean(row.openrouter_key_enc), JSON.stringify(row));
  } finally {
    stub.restore();
  }
}

console.log('\nA failed disable is reported while the replacement still lands (requirement 39)');
{
  const stub = openRouterStub({ failDisable: true });
  try {
    const answer = await api(hostedEnv(), '/api/provision', {
      body: { tenantId: 'user_desync', tier: 'pro', rotateKey: true },
    });

    // The honest combination, and the one the swallow made unrepresentable: the
    // tenant has a working key AND a live one is unaccounted for.
    check('the replacement was minted', answer.body?.runtimeKeyAction === 'minted' && answer.body?.runtimeKeyProvisioned === true, JSON.stringify(answer.body));
    check('the failure is reported as false, not null', answer.body?.supersededKeyDisabled === false, JSON.stringify(answer.body));
    check('it is logged as an error saying the key may still be live', stub.logs.some((line) => line.includes('user_desync') && /may still be live/.test(line)), stub.logs.join(' | '));
    check('the reason names the path', stub.logs.some((line) => line.includes('superseded')), stub.logs.join(' | '));
  } finally {
    stub.restore();
  }
}

console.log('\nA usable key with no stored hash is refused rather than leaked');
{
  const stub = openRouterStub();
  try {
    // Only reachable from a mint response that carried no hash. The key works, and
    // nothing here can re-limit or retire it, so minting a replacement would leave
    // it live and unreachable forever - the exact leak requirement 38 is about.
    await store.upsertTenant({ id: 'user_hashless', tier: 'starter', status: 'active' });
    await store.setRuntimeKey('user_hashless', null, await (async () => {
      const { encryptString } = await import('../src/tenants.ts');
      return encryptString('sk-or-v1-legacy', KEY_ENC_SECRET);
    })());

    const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_hashless', tier: 'team' } });

    check('the action says an operator is needed', answer.body?.runtimeKeyAction === 'unmanaged', JSON.stringify(answer.body));
    check('the tenant keeps the key that works', answer.body?.runtimeKeyProvisioned === true, JSON.stringify(answer.body));
    check('no replacement was minted', stub.mints().length === 0, JSON.stringify(stub.calls));
    check('it is logged as an error telling the operator what to do', stub.logs.some((line) => line.includes('user_hashless') && /by hand/.test(line)), stub.logs.join(' | '));

    // An explicit rotation is still allowed: the operator has accepted the leak.
    const rotated = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_hashless', tier: 'team', rotateKey: true } });
    check('rotateKey overrides it', rotated.body?.runtimeKeyAction === 'minted' && stub.mints().length === 1, JSON.stringify(rotated.body));
    check('and reports that nothing could be disabled', rotated.body?.supersededKeyDisabled === null, JSON.stringify(rotated.body));
  } finally {
    stub.restore();
  }
}

console.log('\nA failed mint leaves the tenant provisioned and says hosted inference will refuse');
{
  const stub = openRouterStub({ failMint: true });
  try {
    const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_mint_fails', tier: 'pro' } });

    // The row is the part we can guarantee; the key is not. Reported both ways.
    check('the tenant row still exists and is active', (await keyColumns('user_mint_fails'))?.status === 'active');
    check('the response says there is no usable key', answer.body?.runtimeKeyAction === 'mint_failed' && answer.body?.runtimeKeyProvisioned === false, JSON.stringify(answer.body));
    check('the log names the consequence', stub.logs.some((line) => line.includes('no_runtime_key')), stub.logs.join(' | '));
    // A vendor error body can carry ANYTHING - the stub echoes the provisioning key
    // to prove the point - so it must never be forwarded to a caller.
    check('the vendor body is in no response field', !JSON.stringify(answer.body).includes(PROVISIONING_KEY), JSON.stringify(answer.body));
    check('but the operator can still find it in the log', stub.logs.some((line) => line.includes('mint refused')), stub.logs.join(' | '));
  } finally {
    stub.restore();
  }
}

// ══ 5. POST /api/deactivate (task 8.3, requirement 39) ═════════════════════

console.log('\nPOST /api/deactivate reports whether the key was actually retired (requirement 39)');
{
  const stub = openRouterStub();
  try {
    const answer = await api(hostedEnv(), '/api/deactivate', { body: { tenantId: 'user_upgrade' } });

    check('answers 200 canceled', answer.status === 200 && answer.body?.status === 'canceled', `${answer.status} ${JSON.stringify(answer.body)}`);
    check('the key disable is reported as true', answer.body?.runtimeKeyDisabled === true, JSON.stringify(answer.body));
    check('the tenant key was the one disabled', stub.disables()[0]?.hash === 'hash_minted_2', JSON.stringify(stub.calls));
    const row = await keyColumns('user_upgrade');
    check('the status is canceled in D1', row.status === 'canceled', JSON.stringify(row));
    // Requirement 18's shape: deactivation is not a deprovision. The columns stay,
    // so a re-provision can rotate rather than guess.
    check('the key columns are retained for the record', row.openrouter_key_id === 'hash_minted_2' && Boolean(row.openrouter_key_enc), JSON.stringify(row));

    const unknown = await api(hostedEnv(), '/api/deactivate', { body: { tenantId: 'user_never_existed' } });
    check('an unknown tenant is 404 and touches OpenRouter not at all', unknown.status === 404 && stub.disables().length === 1, `${unknown.status} ${JSON.stringify(stub.calls)}`);
  } finally {
    stub.restore();
  }
}

console.log('\nA deactivation whose key disable FAILS says so, and still cancels');
{
  const stub = openRouterStub({ failDisable: true });
  try {
    await store.upsertTenant({ id: 'user_leak', tier: 'team', status: 'active', openrouterKeyId: 'hash_leak', openrouterKeyEnc: 'enc_leak' });
    const answer = await api(hostedEnv(), '/api/deactivate', { body: { tenantId: 'user_leak' } });

    // THE regression this suite exists for. `.catch(() => undefined)` made this
    // response byte-identical to the successful one above.
    check('runtimeKeyDisabled is false', answer.body?.runtimeKeyDisabled === false, JSON.stringify(answer.body));
    check('the deactivation still happened', answer.status === 200 && (await keyColumns('user_leak')).status === 'canceled', JSON.stringify(answer.body));
    check('the leak is logged as an error', stub.logs.some((line) => line.includes('user_leak') && /may still be live/.test(line)), stub.logs.join(' | '));
    check('the log names it as a deactivation', stub.logs.some((line) => line.includes('deactivated')), stub.logs.join(' | '));
  } finally {
    stub.restore();
  }
}

console.log('\nRe-provisioning a cancelled tenant brings their key back into service');
{
  const stub = openRouterStub();
  try {
    // `user_upgrade` was just cancelled, which disabled their key. Restoring the
    // tier and the allowance without clearing `disabled` would leave the row saying
    // entitled while OpenRouter refused every run.
    const answer = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_upgrade', tier: 'pro' } });

    check('the tenant is active again', (await keyColumns('user_upgrade')).status === 'active', JSON.stringify(await keyColumns('user_upgrade')));
    check('the same key is reused, not replaced', answer.body?.runtimeKeyAction === 'limit_updated' && stub.mints().length === 0, JSON.stringify(answer.body));
    const patch = stub.limits()[0];
    check('the patch re-enables the key at the new cap', patch?.body?.disabled === false && patch?.body?.limit === CAP.pro, JSON.stringify(patch?.body));
    check('and it targets their own key', patch?.hash === 'hash_minted_2', JSON.stringify(patch));
  } finally {
    stub.restore();
  }
}

console.log('\nA tenant with no key deactivates cleanly rather than reporting a failure');
{
  const stub = openRouterStub();
  try {
    await store.upsertTenant({ id: 'user_keyless', tier: 'starter', status: 'active' });
    const answer = await api(hostedEnv(), '/api/deactivate', { body: { tenantId: 'user_keyless' } });

    // Nothing live means nothing failed - `false` here would be a lie about a
    // vendor call that never happened.
    check('runtimeKeyDisabled is true', answer.body?.runtimeKeyDisabled === true, JSON.stringify(answer.body));
    check('no OpenRouter call was made', stub.calls.length === 0, JSON.stringify(stub.calls));
  } finally {
    stub.restore();
  }
}

// ══ 6. An unconfigured worker degrades instead of failing ══════════════════

console.log('\nWithout the key secrets, provisioning degrades rather than crashing');
{
  const stub = openRouterStub();
  try {
    const noProvisioning = await api(hostedEnv({ OPENROUTER_PROVISIONING_KEY: undefined }), '/api/provision', {
      body: { tenantId: 'user_no_or', tier: 'pro' },
    });
    check('the tenant is still provisioned', noProvisioning.status === 200 && (await keyColumns('user_no_or'))?.status === 'active', JSON.stringify(noProvisioning.body));
    check('the key work is reported as skipped', noProvisioning.body?.runtimeKeyAction === 'skipped' && noProvisioning.body?.runtimeKeyProvisioned === false, JSON.stringify(noProvisioning.body));
    check('the missing secret is named', /OPENROUTER_PROVISIONING_KEY/.test(noProvisioning.body?.runtimeKeyDetail ?? ''), JSON.stringify(noProvisioning.body));
    check('nothing was attempted', stub.calls.length === 0, JSON.stringify(stub.calls));

    // A minted key is a SECRET, so storing it needs KEY_ENC_SECRET. Degraded, not
    // thrown: crashing on a configuration gap would turn a webhook delivery into
    // an infinite Stripe retry.
    const noEnc = await api(hostedEnv({ KEY_ENC_SECRET: undefined }), '/api/provision', {
      body: { tenantId: 'user_no_enc', tier: 'pro' },
    });
    check('a missing KEY_ENC_SECRET is reported, not raised', noEnc.status === 200 && noEnc.body?.runtimeKeyAction === 'skipped', `${noEnc.status} ${JSON.stringify(noEnc.body)}`);
    check('and it is named', /KEY_ENC_SECRET/.test(noEnc.body?.runtimeKeyDetail ?? ''), JSON.stringify(noEnc.body));
    check('no key was minted with nowhere to store it', stub.mints().length === 0, JSON.stringify(stub.calls));
  } finally {
    stub.restore();
  }
}

// ══ 7. reconcileRuntimeKey never throws ═══════════════════════════════════

console.log('\nreconcileRuntimeKey never throws, whatever OpenRouter does');
{
  const stub = openRouterStub();
  try {
    // The contract the Stripe webhook depends on: a rejection there would be a
    // non-2xx, and Stripe would redeliver a state write that already landed - for
    // as long as the vendor stayed unwell.
    globalThis.fetch = async () => {
      throw new Error('network is gone');
    };
    const tenant = await store.getTenant('user_leak');
    const outcome = await reconcileRuntimeKey(hostedEnv(), store, tenant);
    check('a thrown fetch becomes an outcome', outcome.action === 'limit_failed' && outcome.keyPresent === true, JSON.stringify(outcome));
    check('the outcome carries the tier cap it was aiming at', outcome.limitUsd === CAP.team, JSON.stringify(outcome));

    // An unknown tier falls back to starter's cap (`tierLimits` does), so an
    // enterprise row provisioned per-deal never reads as unlimited by accident.
    const custom = { ...tenant, tier: 'enterprise' };
    const fallback = await reconcileRuntimeKey(hostedEnv(), store, custom);
    check('an unknown tier reconciles towards the starter cap', fallback.limitUsd === CAP.starter, JSON.stringify(fallback));
  } finally {
    stub.restore();
  }
}

// ══ 8. A purchased pack has to reach the cap too (requirement 37) ══════════
//
// The cap is `runtimeKeyLimitUsd` - the tier allowance PLUS the tenant's unspent
// grants - not the tier allowance alone. Every assertion above still reads the bare
// tier figure because those tenants have no grants, so `grantPool` returns 0 and the
// sum collapses to the allowance: that is the point of pinning it here instead.
//
// Both halves of the fix are load-bearing, and this section is where the second one
// is provable. Patching on the webhook's GRANT path alone would be undone the moment
// a tier change ran a cap computed from the tier only - the pack would be patched
// straight back out of the ceiling the tenant paid for.
//
// WHY THIS SECTION IS LAST, even though it belongs beside section 3. `mintCounter` in
// the stub is module-global and hands out `hash_minted_1`, `hash_minted_2`, ... in
// call order, and sections 4 and 5 pin those literals to assert that a patch or a
// disable targeted the key a tenant actually holds. So a block that MINTS renumbers
// every mint after it: placed beside section 3, the mint below turned six later
// assertions red without a single line of production code being wrong. Add a minting
// block here at the end, or read the hash back off the row.

console.log('\nThe key cap is the tier allowance PLUS unspent grants (requirement 37)');
{
  const stub = openRouterStub();
  try {
    // A paying starter tenant who has bought the small pack: 500 credits at the
    // starter-derived basis is $2.00 of real budget on top of the $4 allowance.
    await store.upsertTenant({ id: 'user_grant_tier', tier: 'starter', status: 'active', openrouterKeyId: 'hash_granted', openrouterKeyEnc: 'enc_granted' });
    const landed = await store.recordCreditGrant({ tenantId: 'user_grant_tier', stripePaymentId: 'pi_grant_tier', credits: 500, costUsd: grantCostUsd(500) });
    check('the seeded pack landed', landed === true);

    const outcome = await reconcileRuntimeKey(hostedEnv(), store, await store.getTenant('user_grant_tier'));
    check('the outcome reports allowance + pack ($4 + $2)', outcome.limitUsd === CAP.starter + 2, JSON.stringify(outcome));
    check('and that is the cap the key was patched to', stub.limits()[0]?.body?.limit === CAP.starter + 2, JSON.stringify(stub.limits()[0]?.body));
    // The value moves; the body shape does not. `limit_reset` stays absent.
    check('two fields and no more, still', Object.keys(stub.limits()[0]?.body ?? {}).sort().join() === 'disabled,limit', JSON.stringify(stub.limits()[0]?.body));

    // THE REGRESSION THE SECOND HALF PREVENTS. An upgrade recomputes the cap, and a
    // cap computed from the tier alone would silently delete the pack from it.
    const upgrade = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_grant_tier', tier: 'pro' } });
    check('a tier change keeps the pack in the cap ($12.60 + $2)', upgrade.body?.runtimeKeyLimitUsd === CAP.pro + 2, JSON.stringify(upgrade.body));
    check('the patch carries the same figure', stub.limits()[1]?.body?.limit === CAP.pro + 2, JSON.stringify(stub.limits()[1]?.body));

    // A partially consumed pack contributes only what is LEFT, because the pool is
    // `cost_usd - cost_usd_consumed` and it is read live on every reconciliation.
    await DB.prepare('UPDATE credit_grants SET cost_usd_consumed = ? WHERE stripe_payment_id = ?')
      .bind(1.5, 'pi_grant_tier')
      .run();
    const spent = await reconcileRuntimeKey(hostedEnv(), store, await store.getTenant('user_grant_tier'));
    check('a half-spent pack contributes only its remainder', Math.abs(spent.limitUsd - (CAP.pro + 0.5)) < 1e-9, JSON.stringify(spent));

    // An exhausted pack leaves the tier allowance exactly, so the cap returns to what
    // it was before any of this - no residue, and nothing to clean up.
    await DB.prepare('UPDATE credit_grants SET cost_usd_consumed = cost_usd WHERE stripe_payment_id = ?')
      .bind('pi_grant_tier')
      .run();
    const drained = await reconcileRuntimeKey(hostedEnv(), store, await store.getTenant('user_grant_tier'));
    check('an exhausted pack leaves the tier allowance alone', drained.limitUsd === CAP.pro, JSON.stringify(drained));
  } finally {
    stub.restore();
  }
}

console.log('\nA MINT carries the grant term too, not only a patch');
{
  const stub = openRouterStub();
  try {
    // The other writer. A pack can be bought before a tenant ever holds a key - the
    // grant is keyed on the payment and needs no tenant row - so the first mint has
    // to carry it or the buyer's overage is refused until something else patches.
    await store.recordCreditGrant({ tenantId: 'user_grant_mint', stripePaymentId: 'pi_grant_mint', credits: 1250, costUsd: grantCostUsd(1250) });
    const provision = await api(hostedEnv(), '/api/provision', { body: { tenantId: 'user_grant_mint', tier: 'starter' } });

    check('a key was minted', provision.body?.runtimeKeyAction === 'minted' && stub.mints().length === 1, JSON.stringify(provision.body));
    // 1250 credits is $5.00 of budget on a $4 allowance.
    check('the mint is capped at allowance + pack ($4 + $5)', stub.mints()[0]?.body?.limit === CAP.starter + 5, JSON.stringify(stub.mints()[0]?.body));
    check('the response reports the same ceiling', provision.body?.runtimeKeyLimitUsd === CAP.starter + 5, JSON.stringify(provision.body));
    // The mint body is otherwise unchanged: the monthly reset clock is what makes
    // this cap mean "this month", and it is still sent.
    check('and it still mints on the monthly clock', stub.mints()[0]?.body?.limit_reset === 'monthly', JSON.stringify(stub.mints()[0]?.body));
  } finally {
    stub.restore();
  }
}

console.log('\nA tenant with no grants is capped exactly as before');
{
  const stub = openRouterStub();
  try {
    // The reason every expectation above this section stayed green: no grants means
    // an empty pool, and the sum collapses to the tier allowance. Pinned explicitly
    // so a future change to the pool read cannot move the no-grant case unnoticed.
    await store.upsertTenant({ id: 'user_grant_none', tier: 'team', status: 'active', openrouterKeyId: 'hash_nogrant', openrouterKeyEnc: 'enc_nogrant' });
    const pool = await store.grantPool('user_grant_none');
    check('the pool is 0, not NULL', pool.costUsdRemaining === 0, JSON.stringify(pool));
    const outcome = await reconcileRuntimeKey(hostedEnv(), store, await store.getTenant('user_grant_none'));
    check('so the cap is the bare tier figure', outcome.limitUsd === CAP.team && stub.limits()[0]?.body?.limit === CAP.team, JSON.stringify(outcome));
  } finally {
    stub.restore();
  }
}

await mf.dispose();
console.log(failures === 0 ? '\nAll provisioning checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
