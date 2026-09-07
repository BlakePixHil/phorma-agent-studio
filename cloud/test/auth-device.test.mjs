/**
 * The desktop sign-in credential - the token, the authorization branch it added,
 * and the three routes that mint it.
 *
 * This suite exists because a new credential type was added to the ONE seam every
 * request passes through, and the failure modes are asymmetric. A bug that refuses
 * a valid token is a support ticket; a bug that ACCEPTS an invalid one hands over
 * a tenant's account. So the forgery cases outnumber the happy path here on
 * purpose, and the two-sided properties ("a Clerk JWT still works", "BYO is
 * unchanged") are asserted rather than assumed - `verifyBearer` is shared with
 * `/api/infer` and with every Durable Object request, so a regression here is not
 * contained to sign-in.
 *
 * Authorization is never stubbed. An RSA keypair is generated here, the public
 * half is handed to the worker as `CLERK_JWT_KEY`, and each Clerk case signs its
 * own RS256 JWT with the private half, so `@clerk/backend` verifies for real on
 * its offline path - the same arrangement `billing-routes.test.mjs` uses.
 *
 * KV is a real Miniflare namespace, because the one-shot and expiry behaviour of
 * `redeem` is entirely about what is in KV and a fake would be asserting on itself.
 * No D1: the device routes are matched ABOVE the tenant-store gate and touch no
 * database, and proving that is one of the checks below.
 *
 * Run: npx tsx cloud/test/auth-device.test.mjs
 */

import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import process from 'node:process';
import fc from 'fast-check';
import { Miniflare } from 'miniflare';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so redirect it before the
// module graph loads.
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
const { verifyBearer } = await import('../src/auth.ts');
const {
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_TTL_SECONDS,
  deviceCodeKey,
  hashDeviceCode,
  mintDeviceToken,
  verifyDeviceToken,
} = await import('../src/device-auth.ts');
const { clerkHostFromPublishableKey, handleDeviceAuthPage } = await import(
  '../src/device-auth-routes.ts'
);

const RUNS = { numRuns: 200 };

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- Real KV ---------------------------------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  kvNamespaces: { TENANTS: 'phorma-auth-device' },
});
const TENANTS = await mf.getKVNamespace('TENANTS');

// --- A real Clerk session token -------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintClerkToken(sub) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-device-test' })}.${b64url({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// --- Environments ----------------------------------------------------------

const AUTH_SECRET = 'device-auth-secret-not-a-real-one';
const OTHER_SECRET = 'a-completely-different-secret-value';
const PUBLISHABLE = 'pk_test_Zmxvd2luZy1zZWFob3JzZS03Mi5jbGVyay5hY2NvdW50cy5kZXYk';
const OWNER = 'user_2abcDEVICEowner';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

/** Hosted worker with desktop sign-in configured. */
function hostedEnv(overrides = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_device_not_used_offline',
    CLERK_JWT_KEY,
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE,
    PHORMA_AUTH_SECRET: AUTH_SECRET,
    TENANTS,
    ...overrides,
  };
}

const api = (path, init) =>
  handleApiRequest(new Request(`https://cloud.example.com${path}`, init), hostedEnv(), CORS, CTX);

async function post(path, body, { token, env } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`https://cloud.example.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const response = await handleApiRequest(request, env ?? hostedEnv(), CORS, CTX);
  return { status: response?.status ?? 0, body: await response?.json().catch(() => null) };
}

/** A fresh 32-byte base64url device code, as the studio mints them. */
const newCode = () => randomBytes(32).toString('base64url');

const NOW = Math.floor(Date.now() / 1000);

// ══ 1. The token itself ═════════════════════════════════════════════════════

console.log('\nThe device token: signed, scoped, and expiring');
{
  const token = await mintDeviceToken(AUTH_SECRET, OWNER, NOW);

  check('announces itself with the phd_ prefix', token.startsWith(DEVICE_TOKEN_PREFIX), token.slice(0, 12));
  check('round-trips to the Clerk sub', (await verifyDeviceToken([AUTH_SECRET], token, NOW))?.sub === OWNER);

  // The prefix is what stops `verifyBearer` handing a device token to Clerk's
  // verifier and vice versa, so a token WITHOUT it must not verify at all.
  const unprefixed = token.slice(DEVICE_TOKEN_PREFIX.length);
  check('is refused without the prefix', (await verifyDeviceToken([AUTH_SECRET], unprefixed, NOW)) === null);

  check('is refused under a different secret', (await verifyDeviceToken([OTHER_SECRET], token, NOW)) === null);
  check('is refused once expired', (await verifyDeviceToken([AUTH_SECRET], token, NOW + DEVICE_TOKEN_TTL_SECONDS + 1)) === null);
  check('is valid one second before expiry', (await verifyDeviceToken([AUTH_SECRET], token, NOW + DEVICE_TOKEN_TTL_SECONDS - 1))?.sub === OWNER);

  // Rotation: the previous secret keeps verifying during the overlap window, which
  // is the only thing standing between a secret roll and every install signing out.
  check('verifies under a rotated pair (old secret still listed)', (await verifyDeviceToken([OTHER_SECRET, AUTH_SECRET], token, NOW))?.sub === OWNER);
  check('an undefined secret in the list is skipped, not treated as a match', (await verifyDeviceToken([undefined, AUTH_SECRET], token, NOW))?.sub === OWNER);
  check('a list with no usable secret refuses', (await verifyDeviceToken([undefined, ''], token, NOW)) === null);

  // Tampering. The signature covers the ENCODED payload, so re-encoding a changed
  // payload has to invalidate it.
  const [encoded, signature] = token.slice(DEVICE_TOKEN_PREFIX.length).split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ s: 'user_attacker', i: NOW, e: NOW + 999, v: 1 })).toString('base64url');
  check('a swapped payload is refused', (await verifyDeviceToken([AUTH_SECRET], `${DEVICE_TOKEN_PREFIX}${forgedPayload}.${signature}`, NOW)) === null);
  check('a swapped signature is refused', (await verifyDeviceToken([AUTH_SECRET], `${DEVICE_TOKEN_PREFIX}${encoded}.${'A'.repeat(43)}`, NOW)) === null);
  check('a missing signature is refused', (await verifyDeviceToken([AUTH_SECRET], `${DEVICE_TOKEN_PREFIX}${encoded}`, NOW)) === null);
  check('an empty token is refused', (await verifyDeviceToken([AUTH_SECRET], '', NOW)) === null);
  check('the bare prefix is refused', (await verifyDeviceToken([AUTH_SECRET], DEVICE_TOKEN_PREFIX, NOW)) === null);
}

// ══ Property 1 ══════════════════════════════════════════════════════════════
// "No string that was not minted with the secret ever verifies."
//
// The blunt instrument, and the one worth having: it covers malformed input,
// truncation, alphabet violations and accidental near-misses in one statement,
// including the shapes a hand-written case list would not think of. It is
// generated WITH the prefix as often as without, because a forgery attempt would
// obviously include it.
console.log('\nProperty 1: only a genuinely minted token verifies');
{
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.string(),
        fc.string({ minLength: 40, maxLength: 400 }),
        fc.string().map(s => `${DEVICE_TOKEN_PREFIX}${s}`),
        fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${DEVICE_TOKEN_PREFIX}${a}.${b}`),
      ),
      async candidate => {
        const real = await mintDeviceToken(AUTH_SECRET, OWNER, NOW);
        // Guard against the generator accidentally producing the real thing.
        if (candidate === real) return true;
        return (await verifyDeviceToken([AUTH_SECRET], candidate, NOW)) === null;
      },
    ),
    RUNS,
  );
  check('no generated string verified', true);
}

// ══ Property 2 ══════════════════════════════════════════════════════════════
// "A token minted for a sub verifies as exactly that sub, and never another."
console.log('\nProperty 2: a token carries the sub it was minted for');
{
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 60 }).filter(s => s.trim().length > 0),
      async sub => {
        const token = await mintDeviceToken(AUTH_SECRET, sub, NOW);
        const verified = await verifyDeviceToken([AUTH_SECRET], token, NOW);
        return verified?.sub === sub;
      },
    ),
    RUNS,
  );
  check('every minted sub round-tripped exactly', true);
}

// ══ 2. verifyBearer: the shared seam ════════════════════════════════════════

console.log('\nverifyBearer accepts both credential types and still fails closed');
{
  const device = await mintDeviceToken(AUTH_SECRET, OWNER, NOW);
  const clerk = mintClerkToken(OWNER);

  const asDevice = await verifyBearer(hostedEnv(), device);
  check('a device token resolves to its sub, kind=device', asDevice?.userId === OWNER && asDevice?.kind === 'device', JSON.stringify(asDevice));

  // The regression that would matter most: this seam is also `/api/infer`'s and
  // every Durable Object request's.
  const asClerk = await verifyBearer(hostedEnv(), clerk);
  check('a Clerk session JWT still resolves, kind=clerk', asClerk?.userId === OWNER && asClerk?.kind === 'clerk', JSON.stringify(asClerk));

  check('garbage is refused in hosted mode', (await verifyBearer(hostedEnv(), 'not-a-token')) === null);
  check('a null bearer is refused in hosted mode', (await verifyBearer(hostedEnv(), null)) === null);
  check('an expired device token is refused', (await verifyBearer(hostedEnv(), await mintDeviceToken(AUTH_SECRET, OWNER, NOW - DEVICE_TOKEN_TTL_SECONDS - 60))) === null);

  // With the secret unset the branch must not exist at all - this is what keeps a
  // BYO worker byte-identical to before this feature.
  const noSecret = hostedEnv({ PHORMA_AUTH_SECRET: undefined });
  check('a device token is refused when PHORMA_AUTH_SECRET is unset', (await verifyBearer(noSecret, device)) === null);
  const clerkStillWorks = await verifyBearer(noSecret, clerk);
  check('...while Clerk still works on that same worker', clerkStillWorks?.userId === OWNER && clerkStillWorks?.kind === 'clerk');

  // A device token must never fall THROUGH to the shared-token comparison.
  const byoShared = { PHORMA_TOKEN: 'shared-byo-token', PHORMA_AUTH_SECRET: AUTH_SECRET };
  const sharedOk = await verifyBearer(byoShared, 'shared-byo-token');
  check('BYO shared token still resolves, kind=shared', sharedOk?.userId === null && sharedOk?.kind === 'shared', JSON.stringify(sharedOk));
  check('BYO refuses a device token signed by another secret', (await verifyBearer({ ...byoShared, PHORMA_AUTH_SECRET: OTHER_SECRET }, device)) === null);

  const open = await verifyBearer({}, null);
  check('an open BYO instance is still anonymous-but-authorized', open?.userId === null && open?.kind === 'shared', JSON.stringify(open));
}

// ══ 3. The routes ═══════════════════════════════════════════════════════════

console.log('\nPOST /api/auth/device/start registers a hash and nothing else');
{
  const code = newCode();
  const hash = await hashDeviceCode(code);

  const bad = await post('/api/auth/device/start', { codeHash: 'not-a-digest' });
  check('a non-digest codeHash is refused', bad.status === 400, JSON.stringify(bad));

  const ok = await post('/api/auth/device/start', { codeHash: hash });
  check('a valid hash is registered', ok.status === 200 && ok.body?.ok === true, JSON.stringify(ok));

  const stored = await TENANTS.get(deviceCodeKey(hash));
  check('KV holds the pending record', stored !== null, String(stored));
  check('KV does NOT hold the code itself', stored !== null && !stored.includes(code), String(stored));
  check('the pending record carries no sub yet', JSON.parse(stored).sub === undefined, String(stored));
}

console.log('\nThe claim/redeem exchange');
{
  const code = newCode();
  await post('/api/auth/device/start', { codeHash: await hashDeviceCode(code) });

  const early = await post('/api/auth/device/redeem', { code });
  check('redeeming before a claim is 202 pending, not an error', early.status === 202 && early.body?.status === 'pending', JSON.stringify(early));
  check('...and hands out no token', early.body?.token === undefined);

  const anon = await post('/api/auth/device/claim', { code });
  check('claiming with no credential is 401', anon.status === 401, JSON.stringify(anon));

  // The gate that matters most on this route: a machine holding a device token
  // must not be able to mint itself further credentials without a human.
  const deviceToken = await mintDeviceToken(AUTH_SECRET, OWNER, NOW);
  const byDevice = await post('/api/auth/device/claim', { code }, { token: deviceToken });
  check('claiming with a DEVICE token is 403, not 200', byDevice.status === 403, JSON.stringify(byDevice));

  const claimed = await post('/api/auth/device/claim', { code }, { token: mintClerkToken(OWNER) });
  check('claiming with a Clerk session succeeds', claimed.status === 200, JSON.stringify(claimed));

  const redeemed = await post('/api/auth/device/redeem', { code });
  check('redeeming after the claim returns a token', redeemed.status === 200 && typeof redeemed.body?.token === 'string', JSON.stringify(redeemed));
  check('the token names the user who signed in', redeemed.body?.userId === OWNER, JSON.stringify(redeemed.body?.userId));

  // The whole point: the minted token has to actually authorize.
  const resolved = await verifyBearer(hostedEnv(), redeemed.body.token);
  check('the minted token authorizes as that user', resolved?.userId === OWNER && resolved?.kind === 'device', JSON.stringify(resolved));

  // One-shot. A replayed code is indistinguishable from one never issued.
  const again = await post('/api/auth/device/redeem', { code });
  check('a second redemption is 404', again.status === 404, JSON.stringify(again));
  const unknown = await post('/api/auth/device/redeem', { code: newCode() });
  check('an unknown code answers identically to a spent one', again.status === unknown.status && JSON.stringify(again.body) === JSON.stringify(unknown.body), `${JSON.stringify(again.body)} vs ${JSON.stringify(unknown.body)}`);

  // A claim cannot resurrect a spent code either.
  const reclaim = await post('/api/auth/device/claim', { code }, { token: mintClerkToken(OWNER) });
  check('claiming a spent code is 404', reclaim.status === 404, JSON.stringify(reclaim));
}

// The email rides along for DISPLAY only. It is worth its own checks because it is
// the one value in this flow that the CLIENT supplies, so the boundary has to be
// unmistakable: it must never influence which account the token addresses.
console.log('\nThe claimed email is display-only and size-bounded');
{
  const code = newCode();
  await post('/api/auth/device/start', { codeHash: await hashDeviceCode(code) });
  await post(
    '/api/auth/device/claim',
    { code, email: '  Owner@Example.com  ' },
    { token: mintClerkToken(OWNER) },
  );
  const out = await post('/api/auth/device/redeem', { code });
  check('a claimed email is trimmed and returned', out.body?.email === 'Owner@Example.com', JSON.stringify(out.body?.email));
  // The token is bound to the VERIFIED sub, never to anything the page said.
  check('the token still names the verified sub', (await verifyBearer(hostedEnv(), out.body.token))?.userId === OWNER);

  // A lie about the email cannot become a lie about the account.
  const code2 = newCode();
  await post('/api/auth/device/start', { codeHash: await hashDeviceCode(code2) });
  await post(
    '/api/auth/device/claim',
    { code: code2, email: 'attacker@evil.example' },
    { token: mintClerkToken('user_someoneElse') },
  );
  const out2 = await post('/api/auth/device/redeem', { code2: null, code: code2 });
  check('a mismatched email does not change who the token is for', out2.body?.userId === 'user_someoneElse', JSON.stringify(out2.body?.userId));

  // Shapes that must be dropped rather than stored.
  for (const [label, value] of [
    ['a control character', 'a\u0000b@example.com'],
    ['an angle bracket', '<script>@example.com'],
    ['no at-sign', 'not-an-email'],
    ['an over-long value', `${'a'.repeat(250)}@example.com`],
    ['a non-string', 42],
  ]) {
    const c = newCode();
    await post('/api/auth/device/start', { codeHash: await hashDeviceCode(c) });
    await post('/api/auth/device/claim', { code: c, email: value }, { token: mintClerkToken(OWNER) });
    const r = await post('/api/auth/device/redeem', { code: c });
    check(`${label} is dropped, not stored`, r.body?.email === null, `${label}: ${JSON.stringify(r.body?.email)}`);
  }

  // Absent is fine - the studio renders the account without an address.
  const c3 = newCode();
  await post('/api/auth/device/start', { codeHash: await hashDeviceCode(c3) });
  await post('/api/auth/device/claim', { code: c3 }, { token: mintClerkToken(OWNER) });
  check('an absent email yields null, not undefined', (await post('/api/auth/device/redeem', { code: c3 })).body?.email === null);
}

console.log('\nRoute-level refusals');
{
  const short = await post('/api/auth/device/redeem', { code: 'too-short' });
  check('a low-entropy code is refused before any KV read', short.status === 400, JSON.stringify(short));
  check('a non-object body is refused', (await post('/api/auth/device/start', 'not-an-object')).status === 400);

  const unset = await post(
    '/api/auth/device/start',
    { codeHash: await hashDeviceCode(newCode()) },
    { env: hostedEnv({ PHORMA_AUTH_SECRET: undefined }) },
  );
  check('a worker with no PHORMA_AUTH_SECRET answers 501 naming the gap', unset.status === 501 && /not configured/i.test(unset.body?.error ?? ''), JSON.stringify(unset));

  const noKv = await post(
    '/api/auth/device/start',
    { codeHash: await hashDeviceCode(newCode()) },
    { env: hostedEnv({ TENANTS: undefined }) },
  );
  check('a worker with no KV answers 501 rather than throwing', noKv.status === 501, JSON.stringify(noKv));

  const getStart = await api('/api/auth/device/start', { method: 'GET' });
  check('GET on a POST route is 405', getStart?.status === 405, String(getStart?.status));
  const nonsense = await post('/api/auth/device/nope', {});
  check('an unknown sub-route is 404', nonsense.status === 404, JSON.stringify(nonsense));
}

// ══ 4. The operator surface stays Clerk-only ════════════════════════════════
//
// A device token carries the SAME userId as the Clerk session that minted it, so
// without the kind check an owner signing in on the desktop app would carry
// operator access on a long-lived bearer that lean v1 cannot revoke. The allowlist
// below names the device token's own user, so only the kind check can refuse it.

console.log('\nA device token is not an operator credential');
{
  const env = hostedEnv({ TELEMETRY_ADMIN_USER_IDS: OWNER });
  const path = '/api/admin/telemetry/overview?range=7d';
  const withDevice = new Request(`https://cloud.example.com${path}`, {
    headers: { Authorization: `Bearer ${await mintDeviceToken(AUTH_SECRET, OWNER, NOW)}` },
  });
  const denied = await handleApiRequest(withDevice, env, CORS, CTX);
  check('the telemetry admin surface refuses it with 403', denied?.status === 403, String(denied?.status));
  const body = await denied.json().catch(() => null);
  check('...and says nothing about why or about the allowlist', body?.error === 'Forbidden.', JSON.stringify(body));
}

// ══ 5. The browser page ═════════════════════════════════════════════════════

console.log('\nGET /auth/device - the page that does the signing in');
{
  const PAGE = 'https://cloud.example.com/auth/device';
  const code = newCode();
  const page = handleDeviceAuthPage(new Request(`${PAGE}?c=${code}`), hostedEnv());
  const html = await page.text();
  const csp = page.headers.get('Content-Security-Policy') ?? '';

  check('answers 200 with HTML', page.status === 200 && /text\/html/.test(page.headers.get('Content-Type')), String(page.status));
  check('carries NO CORS header', page.headers.get('Access-Control-Allow-Origin') === null);
  check('is not cached', page.headers.get('Cache-Control') === 'no-store');

  // The code is in the URL, so it must not leak onward in a Referer, and it must
  // not be baked into the document either - the script reads it from location.
  check('sends no referrer', page.headers.get('Referrer-Policy') === 'no-referrer');
  check('does not embed the device code in the markup', !html.includes(code), html.slice(0, 200));

  // The CSP is widened for exactly one host, derived from the publishable key.
  const host = clerkHostFromPublishableKey(PUBLISHABLE);
  check('derives the Clerk host from the publishable key', host === 'flowing-seahorse-72.clerk.accounts.dev', host);
  check('the CSP allows script only from that host', csp.includes(`script-src 'unsafe-inline' https://${host}`), csp);
  check('the CSP still forbids everything by default', csp.includes("default-src 'none'"), csp);

  // clerk-js builds a Worker from a blob URL. `worker-src` falls back to
  // `script-src` when absent, which does not admit `blob:`, so omitting this
  // directive blocks the worker and logs a violation on every load. It must be
  // its OWN directive: adding `blob:` to `script-src` would also let a blob run
  // as a top-level script on the page that handles sign-in.
  check('the CSP admits the clerk-js blob worker', /worker-src [^;]*blob:/.test(csp), csp);
  check(
    "...without letting a blob be a top-level script",
    !/script-src [^;]*blob:/.test(csp),
    csp,
  );
  check('the CSP forbids form submission and base rewriting', /form-action 'none'/.test(csp) && /base-uri 'none'/.test(csp), csp);
  check('loads clerk-js from that host and nowhere else', html.includes(`https://${host}/npm/@clerk/clerk-js`), '');
  check('posts the claim to a relative path', html.includes("fetch('/api/auth/device/claim'"), '');

  // A deployment with no desktop sign-in configured must say so, not render a page
  // whose script cannot work. This is the BYO shape.
  const byo = handleDeviceAuthPage(new Request(PAGE), { PHORMA_MODE: undefined });
  check('an unconfigured deployment answers 503 with an explanation', byo.status === 503, String(byo.status));
  check('...and does not load clerk-js', !(await byo.text()).includes('clerk.browser.js'));

  check('a POST is 405 rather than a confusing 404', handleDeviceAuthPage(new Request(PAGE, { method: 'POST' }), hostedEnv()).status === 405);
  check('another path is not this route', handleDeviceAuthPage(new Request('https://cloud.example.com/auth'), hostedEnv()) === null);
  check('a malformed publishable key yields no host rather than a bad one', clerkHostFromPublishableKey('pk_live_@@@@') === '');
}

// --- Result ---------------------------------------------------------------

await mf.dispose();
if (failures > 0) {
  console.error(`\n${failures} device-auth check(s) failed.`);
  process.exit(1);
}
console.log('\nAll device-auth checks passed.');
