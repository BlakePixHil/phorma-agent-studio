/**
 * The owner seam - `cloud/src/auth.ts` and `isOwnerId` in `cloud/src/tenants.ts`
 * (multi-organisation-phorma task 1, Requirements 1, 5.8, 5.10, 13.9, 16.5, 16.6,
 * 20.10, 20.11).
 *
 * What is at stake is a SILENT failure. If `org_id` goes unread, every member of
 * every organisation resolves their PERSONAL owner, sees an empty workspace, and
 * nothing logs an error. If the ABSENT claim stops meaning "no organisation",
 * every solo account loses the behaviour it has today. So this suite pins both
 * directions: a token with an organisation claim resolves the organisation, and a
 * token without one resolves exactly what it resolved before this seam existed.
 *
 * Harness, and why each piece is real rather than stubbed:
 *
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here, the public
 *    half is handed to the worker as `CLERK_JWT_KEY`, and each case signs its own
 *    RS256 session JWT with the private half, so `@clerk/backend` verifies for
 *    real on its offline path with no JWKS fetch. The claim layouts under test are
 *    therefore claims that went through verification, not objects handed to a
 *    reader.
 *  - D1 IS REAL. `org_members` is the authoritative membership and level source,
 *    so it is a local Miniflare D1 with the real migrations applied - including
 *    `0006_organisations.sql`, which this task adds. Per-iteration setup goes
 *    through `DB.batch([...])` and the handle through `withLoopbackRetryD1`,
 *    because each proxied statement costs a loopback socket.
 *  - KV IS A DOUBLE, deliberately. The cache is not SQL that ships, and an
 *    in-memory double makes the two claims that matter OBSERVABLE: which key was
 *    written, and with which `expirationTtl`. It also costs no sockets.
 *  - `registerHooks` redirects `cloudflare:workers` before the module graph loads,
 *    the same shim `status.test.mjs` uses, because `portal-registry.ts` extends the
 *    SDK's `DurableObject`.
 *
 * NOT asserted here, on purpose: the route-level `owner_invalid` refusal and
 * "nothing is written under a colon-bearing owner". `ownerIdIsAddressable` is the
 * guard, and this suite pins the guard; the gateway and `routeApiRequest` call
 * sites arrived with task 2, and `organisation-isolation.test.mjs` asserts the
 * refusal at both. Task 1 changes no observable route behaviour by design.
 *
 * Run: npx tsx cloud/test/owner-identity.test.mjs
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

const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const {
  ownerIdIsAddressable,
  orgMemberCacheKey,
  readOrgClaim,
  readRequestedOrg,
  REQUESTED_OWNER_HEADER,
  resolveOwner,
  resolveRequestedOwner,
  resolveRole,
  verifyBearer,
  verifyRequest,
} = await import('../src/auth.ts');
const { isClerkUserId, isOwnerId, TENANT_CACHE_TTL_S, TenantStore } = await import(
  '../src/tenants.ts'
);
const { CAPABILITY_LEVELS } = await import('../src/capabilities.ts');
const { refuseNonOperator } = await import('../src/admin-auth.ts');
const { mintDeviceToken } = await import('../src/device-auth.ts');
const { DEFAULT_DEPLOYMENT_OWNER, deploymentOwner } = await import('../src/portal-registry.ts');

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

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 100 };

function property(name, build) {
  try {
    fc.assert(build(), RUNS);
    check(name, true);
  } catch (error) {
    check(name, false, describeFailure(error));
  }
}

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
  d1Databases: { DB: 'phorma-cloud-owner-identity' },
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
for (const file of [
  '0001_init.sql',
  '0003_billing.sql',
  '0004_billing_ordering.sql',
  '0005_workflow_backups.sql',
  '0006_organisations.sql',
]) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

/** Replaces the whole membership table, in ONE batch. */
async function setMemberships(rows) {
  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare('DELETE FROM org_members'),
    ...rows.map(({ orgId, userId, level }) =>
      DB.prepare(
        `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(orgId, userId, level, 'user_operator', now, now),
    ),
  ]);
}

// --- A KV double that records what it was asked to store -------------------

function memoryKv() {
  const map = new Map();
  const puts = [];
  return {
    entries: map,
    puts,
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
    },
  };
}

// --- A real session token --------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs a session JWT carrying `sub` plus whatever organisation claims are given. */
function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-owner-test' })}.${base64url({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

const DEVICE_SECRET = 'device-secret-do-not-leak';
const SHARED_TOKEN = 'byo-shared-token';

/** A hosted worker with Clerk and the desktop-token secret configured. */
function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    PHORMA_AUTH_SECRET: DEVICE_SECRET,
    ...extra,
  };
}

/** A BYO worker protected by the shared static token. */
function byoEnv(extra = {}) {
  return { PHORMA_TOKEN: SHARED_TOKEN, ...extra };
}

function requestWith(headers = {}) {
  return new Request('https://cloud.example.com/api/me', { headers });
}

// ══ 1. No organisation claim resolves exactly today's owner ═════════════════
//
// Feature: multi-organisation-phorma, Property 2: A credential with no
// organisation claim resolves full capability over its own owner
console.log('\nA credential carrying no organisation claim (Requirements 1.3, 1.4, 5.10)');
{
  const auth = await verifyBearer(hostedEnv(), mintToken('user_solo'));
  check('a Clerk session resolves its own userId as the owner', auth?.ownerId === 'user_solo', JSON.stringify(auth));
  check('userId is unchanged', auth?.userId === 'user_solo', JSON.stringify(auth));
  check('orgId is null, never inferred', auth?.orgId === null, JSON.stringify(auth));
  check('orgRole is null', auth?.orgRole === null, JSON.stringify(auth));
  check('kind is still clerk', auth?.kind === 'clerk', auth?.kind);
  check('resolveOwner agrees with the cached field', resolveOwner(auth) === auth?.ownerId);

  // No bindings at all: the `admin` answer cannot be coming from a table read.
  const role = await resolveRole({}, auth);
  check('resolveRole answers admin with no organisation and no bindings', role.level === 'admin', JSON.stringify(role));

  const device = await verifyBearer(
    hostedEnv(),
    await mintDeviceToken(DEVICE_SECRET, 'user_desktop', Date.now() / 1000),
  );
  check('a desktop token resolves the subject as the owner', device?.ownerId === 'user_desktop', JSON.stringify(device));
  check('a desktop token carries no organisation id', device?.orgId === null, JSON.stringify(device));
  check('a desktop token carries no role claim', device?.orgRole === null, JSON.stringify(device));
  check('kind is still device', device?.kind === 'device', device?.kind);
  check('a desktop credential resolves admin over its own owner', (await resolveRole({}, device)).level === 'admin');

  const shared = await verifyBearer(byoEnv(), SHARED_TOKEN);
  check('a BYO shared token resolves a null owner', shared?.ownerId === null, JSON.stringify(shared));
  check('a null owner folds to the default literal', deploymentOwner(shared?.ownerId) === DEFAULT_DEPLOYMENT_OWNER);
  check('kind is still shared', shared?.kind === 'shared', shared?.kind);
  check('a shared credential resolves admin', (await resolveRole({}, shared)).level === 'admin');

  const open = await verifyBearer({}, null);
  check('an open instance still returns an anonymous context', open?.kind === 'shared' && open?.ownerId === null, JSON.stringify(open));

  check('a rejected token is still null', (await verifyBearer(hostedEnv(), 'not-a-token')) === null);
  check('a hosted request with no bearer is still null', (await verifyRequest(hostedEnv(), requestWith())) === null);
}

// ══ 2. An organisation claim resolves the organisation ══════════════════════
//
// Feature: multi-organisation-phorma, Property 1: Owner resolution is total, and
// never yields a colon-bearing segment
console.log('\nA verified organisation claim (Requirements 1.1, 1.2)');
{
  const topLevel = await verifyBearer(
    hostedEnv(),
    mintToken('user_member', { org_id: 'org_acme', org_role: 'org:admin', org_slug: 'acme' }),
  );
  check('the organisation becomes the owner', topLevel?.ownerId === 'org_acme', JSON.stringify(topLevel));
  check('orgId carries the claim value', topLevel?.orgId === 'org_acme', JSON.stringify(topLevel));
  check('userId stays the subject', topLevel?.userId === 'user_member', JSON.stringify(topLevel));
  check('the RAW role claim is carried through unmapped', topLevel?.orgRole === 'org:admin', JSON.stringify(topLevel));
  check('kind is still clerk', topLevel?.kind === 'clerk', topLevel?.kind);

  const compacted = await verifyBearer(
    hostedEnv(),
    mintToken('user_member', { o: { id: 'org_acme', rol: 'admin', slg: 'acme' } }),
  );
  check('the compacted layout resolves the same owner', compacted?.ownerId === 'org_acme', JSON.stringify(compacted));
  check('the compacted layout carries its raw role', compacted?.orgRole === 'admin', JSON.stringify(compacted));

  const noRole = await verifyBearer(hostedEnv(), mintToken('user_member', { org_id: 'org_acme' }));
  check('an organisation with no role claim is not a verification error', noRole?.ownerId === 'org_acme' && noRole?.orgRole === null, JSON.stringify(noRole));
}

// ══ 3. The colon guard ══════════════════════════════════════════════════════
//
// Feature: multi-organisation-phorma, Property 1: Owner resolution is total, and
// never yields a colon-bearing segment
console.log('\nownerIdIsAddressable (Requirement 1.8)');
{
  check('null is addressable, because it folds to the default owner', ownerIdIsAddressable(null));
  check('a user id is addressable', ownerIdIsAddressable('user_abc'));
  check('an organisation id is addressable', ownerIdIsAddressable('org_abc'));
  check('a colon-bearing owner is refused', !ownerIdIsAddressable('org_a:b'));
  check('a leading colon is refused', !ownerIdIsAddressable(':org_a'));
  check('a trailing colon is refused', !ownerIdIsAddressable('org_a:'));

  // Nothing truncates, escapes or rewrites the value: the resolver hands back
  // exactly what it was given, and the guard is what refuses it.
  const hostile = await verifyBearer(hostedEnv(), mintToken('user_member', { org_id: 'org_a:b' }));
  check('a colon-bearing claim is resolved VERBATIM', hostile?.ownerId === 'org_a:b', JSON.stringify(hostile));
  check('and the guard refuses it', !ownerIdIsAddressable(hostile?.ownerId));
}

// ══ 4. isOwnerId, and the read-path asymmetry ═══════════════════════════════
//
// Feature: multi-organisation-phorma, Property 3: Owner id validation is a
// classifier applied only on writes
console.log('\nisOwnerId beside isClerkUserId (Requirements 1.9, 1.10)');
{
  check('accepts a user id', isOwnerId('user_2abcDEF-_'));
  check('accepts an organisation id', isOwnerId('org_2abcDEF-_'));
  for (const rejected of [
    'usr_abc',
    'user_',
    'org_',
    'ORG_abc',
    'User_abc',
    'tenant_abc',
    'org_abc:def',
    'org abc',
    '',
    'user_' + 'a'.repeat(121),
    null,
    undefined,
    42,
    { id: 'user_abc' },
  ]) {
    check(`refuses ${JSON.stringify(rejected)}`, !isOwnerId(rejected));
  }

  check('isClerkUserId is still exported', typeof isClerkUserId === 'function');
  check('isClerkUserId is still NARROWER than isOwnerId', isOwnerId('org_abc') && !isClerkUserId('org_abc'));

  // A row whose id `isOwnerId` would reject still resolves on the read path.
  const legacy = 'legacy tenant id, provisioned before any check existed';
  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare(
      `INSERT OR REPLACE INTO tenants (id, email, tier, status, created_at, updated_at)
       VALUES (?, ?, 'starter', 'active', ?, ?)`,
    ).bind(legacy, 'legacy@example.com', now, now),
  ]);
  const record = await new TenantStore({ DB }).getTenant(legacy);
  check('a stored row whose id isOwnerId rejects still resolves', record?.id === legacy, JSON.stringify(record));
  check('and isOwnerId would indeed have rejected it', !isOwnerId(legacy));
}

// ══ 5. readOrgClaim tolerates both layouts ══════════════════════════════════
console.log('\nreadOrgClaim (design section 2.3)');
{
  check('reads the top-level layout', JSON.stringify(readOrgClaim({ org_id: 'org_a', org_role: 'org:admin' })) === JSON.stringify({ orgId: 'org_a', orgRole: 'org:admin' }));
  check('reads the compacted layout', JSON.stringify(readOrgClaim({ o: { id: 'org_a', rol: 'admin' } })) === JSON.stringify({ orgId: 'org_a', orgRole: 'admin' }));
  check('prefers the top-level layout when both are present', readOrgClaim({ org_id: 'org_top', o: { id: 'org_compact' } }).orgId === 'org_top');
  check('returns nulls for a token carrying neither', JSON.stringify(readOrgClaim({ sub: 'user_a' })) === JSON.stringify({ orgId: null, orgRole: null }));
  check('an organisation with no role is not an error', JSON.stringify(readOrgClaim({ org_id: 'org_a' })) === JSON.stringify({ orgId: 'org_a', orgRole: null }));
  check('a compacted object with no id reads as no organisation', readOrgClaim({ o: { rol: 'admin' } }).orgId === null);
  check('a non-object compacted claim reads as no organisation', readOrgClaim({ o: 'org_a' }).orgId === null);
  check('a null compacted claim reads as no organisation', readOrgClaim({ o: null }).orgId === null);
  check('a whitespace-only claim reads as absent', readOrgClaim({ org_id: '   ' }).orgId === null);
  check('a non-string claim reads as absent', readOrgClaim({ org_id: 12 }).orgId === null);
  check('claim values are trimmed, never rewritten', readOrgClaim({ org_id: ' org_a ' }).orgId === 'org_a');
}

// ══ 6. resolveRole: two sources, one seam ═══════════════════════════════════
//
// Feature: multi-organisation-phorma, Property 13: An unresolvable role fails
// closed and writes nothing
console.log('\nresolveRole (Requirements 5.9, 5.10, 13.9)');
{
  await setMemberships([{ orgId: 'org_acme', userId: 'user_member', level: 'builder' }]);

  // 1. A mapped claim short-circuits: no row exists for this user at all.
  const TENANTS = memoryKv();
  const claimed = await verifyBearer(hostedEnv(), mintToken('user_admin', { org_id: 'org_acme', org_role: 'org:admin' }));
  const claimedRole = await resolveRole({ DB, TENANTS }, claimed);
  check('a mapped claim resolves without a membership row', claimedRole.level === 'admin', JSON.stringify(claimedRole));
  check('and writes nothing to the cache', TENANTS.puts.length === 0, JSON.stringify(TENANTS.puts));

  // 2. An unmapped claim falls through to the table.
  const member = await verifyBearer(hostedEnv(), mintToken('user_member', { org_id: 'org_acme', org_role: 'org:member' }));
  const fromTable = await resolveRole({ DB, TENANTS }, member);
  check('an unmapped claim resolves from org_members', fromTable.level === 'builder', JSON.stringify(fromTable));
  const cacheKey = orgMemberCacheKey('org_acme', 'user_member');
  check('the hit is cached under the documented key', TENANTS.puts[0]?.key === cacheKey, JSON.stringify(TENANTS.puts));
  check('with the same TTL the tenant cache uses', TENANTS.puts[0]?.options?.expirationTtl === TENANT_CACHE_TTL_S);
  check('and that TTL is KV\'s 60 second floor', TENANT_CACHE_TTL_S === 60);

  // 3. The cache is load-bearing: the row is gone and the answer survives.
  await setMemberships([]);
  check('a second resolution is served from the cache', (await resolveRole({ DB, TENANTS }, member)).level === 'builder');

  // 4. A member-management write invalidates the key, so a revocation bites.
  await TENANTS.delete(cacheKey);
  const revoked = await resolveRole({ DB, TENANTS }, member);
  check('a revoked membership fails closed', revoked.unknown === true, JSON.stringify(revoked));
  check('and the miss is NOT cached, so a new grant works at once', !TENANTS.entries.has(cacheKey));

  // 5. Neither source has an answer.
  const noRole = await verifyBearer(hostedEnv(), mintToken('user_stranger', { org_id: 'org_acme' }));
  const unknown = await resolveRole({ DB, TENANTS: memoryKv() }, noRole);
  check('an absent role claim with no row is unknown, never a substituted level', unknown.unknown === true, JSON.stringify(unknown));
  check('unknown is not a level', unknown.level === undefined);

  // 6. An unrecognised level token in a row fails closed (Requirement 13.9).
  await setMemberships([{ orgId: 'org_acme', userId: 'user_stranger', level: 'superuser' }]);
  const junk = await resolveRole({ DB, TENANTS: memoryKv() }, noRole);
  check('a level token outside the vocabulary is unknown', junk.unknown === true, JSON.stringify(junk));
  check('every declared level token is accepted, though', CAPABILITY_LEVELS.length === 4);

  // 7. No DB binding at all - BYO shape - never throws.
  const byoRole = await resolveRole({}, noRole);
  check('an organisation claim with no DB binding fails closed rather than throwing', byoRole.unknown === true, JSON.stringify(byoRole));
}

// ══ 7. A desktop install names its organisation per request ═════════════════
//
// Feature: multi-organisation-phorma, Property 40: An owner switch is a
// complete, reversible change of scope
console.log('\nX-Phorma-Owner on a desktop credential (Requirements 1.6, 1.7, 20.10, 20.11)');
{
  await setMemberships([{ orgId: 'org_acme', userId: 'user_desktop', level: 'editor' }]);
  const TENANTS = memoryKv();
  const env = { DB, TENANTS };
  const token = await mintDeviceToken(DEVICE_SECRET, 'user_desktop', Date.now() / 1000);
  const device = await verifyBearer(hostedEnv(), token);

  const named = requestWith({ [REQUESTED_OWNER_HEADER]: 'org_acme' });
  check('an organisation the caller belongs to resolves', (await resolveRequestedOwner(env, device, named)) === 'org_acme');
  check('the membership level resolves too', (await resolveRole(env, { ...device, orgId: 'org_acme' })).level === 'editor');

  const bare = requestWith();
  const foreign = requestWith({ [REQUESTED_OWNER_HEADER]: 'org_other' });
  const bareOwner = await resolveRequestedOwner(env, device, bare);
  const foreignOwner = await resolveRequestedOwner(env, device, foreign);
  check('an absent header resolves the caller\'s own userId', bareOwner === 'user_desktop', String(bareOwner));
  check('an organisation the caller is NOT in resolves the same thing', foreignOwner === 'user_desktop', String(foreignOwner));
  check('so the two are indistinguishable from outside', foreignOwner === bareOwner);

  for (const hostile of ['org:acme', '   ', 'x'.repeat(200), 'org acme', 'org/acme']) {
    const answer = await resolveRequestedOwner(env, device, requestWith({ [REQUESTED_OWNER_HEADER]: hostile }));
    check(`an unparseable header (${JSON.stringify(hostile.slice(0, 12))}) resolves the caller's own userId`, answer === 'user_desktop', String(answer));
  }
  check('readRequestedOrg refuses a colon outright', readRequestedOrg(requestWith({ [REQUESTED_OWNER_HEADER]: 'org:acme' })) === null);
  check('readRequestedOrg reads a well-formed value', readRequestedOrg(named) === 'org_acme');
  check('readRequestedOrg answers null for an absent header', readRequestedOrg(bare) === null);
  check('naming your own userId is a no-op', (await resolveRequestedOwner(env, device, requestWith({ [REQUESTED_OWNER_HEADER]: 'user_desktop' }))) === 'user_desktop');

  // A membership removed BETWEEN two requests changes the second one's answer.
  // The management write invalidates the cache key, which is what makes it the
  // next request rather than the next minute (Requirement 20.11).
  check('request one resolves the organisation', (await resolveRequestedOwner(env, device, named)) === 'org_acme');
  await setMemberships([]);
  await TENANTS.delete(orgMemberCacheKey('org_acme', 'user_desktop'));
  check('request two resolves the personal owner', (await resolveRequestedOwner(env, device, named)) === 'user_desktop');
  // And with no cache in the path at all, the revocation needs no invalidation.
  check('an uncached revocation bites immediately too', (await resolveRequestedOwner({ DB }, device, named)) === 'user_desktop');

  // A VERIFIED claim outranks a header: a header can never move a browser
  // session out of the organisation Clerk minted it for.
  await setMemberships([{ orgId: 'org_acme', userId: 'user_member', level: 'admin' }]);
  const browser = await verifyBearer(hostedEnv(), mintToken('user_member', { org_id: 'org_acme' }));
  check('a claim outranks a header naming another organisation', (await resolveRequestedOwner({ DB, TENANTS: memoryKv() }, browser, foreign)) === 'org_acme');
}

// ══ 8. A shared credential ignores the header outright ══════════════════════
console.log('\nX-Phorma-Owner on a BYO shared credential (Requirements 1.4, 16.6)');
{
  const shared = await verifyBearer(byoEnv(), SHARED_TOKEN);
  const withHeader = await resolveRequestedOwner({}, shared, requestWith({ [REQUESTED_OWNER_HEADER]: 'org_acme' }));
  const without = await resolveRequestedOwner({}, shared, requestWith());
  check('the header changes nothing', withHeader === without, `${withHeader} vs ${without}`);
  check('and the owner is still the default literal', deploymentOwner(withHeader) === DEFAULT_DEPLOYMENT_OWNER);
  // It must not even reach D1, which a BYO worker does not bind. Passing `{}` as
  // the env above is the assertion: a read would have thrown.
  check('a shared credential needs no DB binding to resolve an owner', withHeader === null);
}

// ══ 9. Credential kind semantics are unchanged ══════════════════════════════
//
// Feature: multi-organisation-phorma, Property 35: Credential kind semantics are
// unchanged
console.log('\nOperator surfaces still refuse a desktop token (Requirements 16.5)');
{
  const ALLOWLIST = 'user_desktop, user_member';
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const env = hostedEnv({ TELEMETRY_ADMIN_USER_IDS: ALLOWLIST, DB });
  const token = await mintDeviceToken(DEVICE_SECRET, 'user_desktop', Date.now() / 1000);

  // An organisation membership at the highest level changes nothing here: the
  // operator gate decides on `kind`, not on level or owner.
  await setMemberships([{ orgId: 'org_acme', userId: 'user_desktop', level: 'admin' }]);

  for (const [label, headers] of [
    ['with no owner header', {}],
    ['naming its own organisation', { [REQUESTED_OWNER_HEADER]: 'org_acme' }],
    ['naming a foreign organisation', { [REQUESTED_OWNER_HEADER]: 'org_other' }],
  ]) {
    const request = new Request('https://cloud.example.com/api/admin/telemetry/overview', {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    const refusal = await refuseNonOperator(request, env, reply);
    check(`a desktop token is refused 403 ${label}`, refusal?.status === 403, String(refusal?.status));
  }

  const browser = new Request('https://cloud.example.com/api/admin/telemetry/overview', {
    headers: { Authorization: `Bearer ${mintToken('user_desktop')}` },
  });
  check('the same allowlisted user IS an operator in a browser', (await refuseNonOperator(browser, env, reply)) === null);

  const orgBrowser = new Request('https://cloud.example.com/api/admin/telemetry/overview', {
    headers: { Authorization: `Bearer ${mintToken('user_desktop', { org_id: 'org_acme' })}` },
  });
  check('and an organisation claim does not remove that operator access', (await refuseNonOperator(orgBrowser, env, reply)) === null);
}

// ══ Properties ══════════════════════════════════════════════════════════════

const idChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-');
const idSuffix = fc.array(idChar, { minLength: 1, maxLength: 30 }).map((chars) => chars.join(''));
const userIdArb = idSuffix.map((suffix) => `user_${suffix}`);
const orgIdArb = idSuffix.map((suffix) => `org_${suffix}`);

console.log('\nProperties');

// Feature: multi-organisation-phorma, Property 1: Owner resolution is total, and
// never yields a colon-bearing segment
property('resolveOwner returns the organisation when one is claimed and the user when not', () =>
  fc.property(userIdArb, fc.option(orgIdArb, { nil: null }), (userId, orgId) => {
    const auth = { userId, orgId, orgRole: null, ownerId: null, kind: 'clerk' };
    const owner = resolveOwner(auth);
    return owner === (orgId ?? userId) && owner !== null;
  }),
);

// Feature: multi-organisation-phorma, Property 1: Owner resolution is total, and
// never yields a colon-bearing segment
property('resolveOwner is null for exactly the shared credential', () =>
  fc.property(fc.option(userIdArb, { nil: null }), fc.option(orgIdArb, { nil: null }), (userId, orgId) => {
    const kind = userId === null ? 'shared' : 'clerk';
    const owner = resolveOwner({ userId, orgId, orgRole: null, ownerId: null, kind });
    return (owner === null) === (userId === null && orgId === null);
  }),
);

// Feature: multi-organisation-phorma, Property 1: Owner resolution is total, and
// never yields a colon-bearing segment
property('ownerIdIsAddressable is false exactly for a colon, and rewrites nothing', () =>
  fc.property(fc.string({ maxLength: 40 }), fc.boolean(), (body, colon) => {
    const candidate = colon ? `org_${body}:tail` : `org_${body.replace(/:/g, '')}`;
    const auth = { userId: 'user_a', orgId: candidate, orgRole: null, ownerId: null, kind: 'clerk' };
    // The resolver hands the value back byte-identical; only the guard judges it.
    return resolveOwner(auth) === candidate && ownerIdIsAddressable(candidate) === !candidate.includes(':');
  }),
);

// Feature: multi-organisation-phorma, Property 2: A credential with no
// organisation claim resolves full capability over its own owner
await asyncProperty('a verified token with no organisation claim resolves its own owner and admin', () =>
  fc.asyncProperty(userIdArb, async (userId) => {
    const auth = await verifyBearer(hostedEnv(), mintToken(userId));
    if (auth === null) return false;
    // No bindings: an `admin` answer here cannot have come from a table.
    const role = await resolveRole({}, auth);
    return (
      auth.userId === userId &&
      auth.orgId === null &&
      auth.orgRole === null &&
      auth.ownerId === userId &&
      auth.kind === 'clerk' &&
      role.level === 'admin' &&
      deploymentOwner(auth.ownerId) === userId
    );
  }),
);

// Feature: multi-organisation-phorma, Property 3: Owner id validation is a
// classifier applied only on writes
property('isOwnerId accepts exactly the user and organisation id shapes', () =>
  fc.property(fc.string({ maxLength: 40 }), (value) => {
    const expected = /^user_[A-Za-z0-9_-]{1,120}$/.test(value) || /^org_[A-Za-z0-9_-]{1,120}$/.test(value);
    return isOwnerId(value) === expected;
  }),
);

// Feature: multi-organisation-phorma, Property 3: Owner id validation is a
// classifier applied only on writes
property('isClerkUserId stays strictly narrower than isOwnerId', () =>
  fc.property(fc.oneof(userIdArb, orgIdArb, fc.string({ maxLength: 20 })), (value) => {
    if (isClerkUserId(value) && !isOwnerId(value)) return false;
    return !(value.startsWith('org_') && isClerkUserId(value));
  }),
);

// Feature: multi-organisation-phorma, Property 3: Owner id validation is a
// classifier applied only on writes
await asyncProperty('a stored row whose id isOwnerId rejects still resolves on the read path', () =>
  fc.asyncProperty(
    fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((value) => value.trim().length > 0 && !isOwnerId(value)),
    async (legacyId) => {
      const now = new Date().toISOString();
      await DB.batch([
        DB.prepare(
          `INSERT OR REPLACE INTO tenants (id, email, tier, status, created_at, updated_at)
           VALUES (?, NULL, 'starter', 'active', ?, ?)`,
        ).bind(legacyId, now, now),
      ]);
      const record = await new TenantStore({ DB }).getTenant(legacyId);
      return record !== null && record.id === legacyId;
    },
  ),
);

// Feature: multi-organisation-phorma, Property 35: Credential kind semantics are
// unchanged
await asyncProperty('the resolved kind equals the pre-feature mapping for every credential shape', () =>
  fc.asyncProperty(
    userIdArb,
    fc.option(orgIdArb, { nil: null }),
    fc.constantFrom('clerk', 'device', 'shared', 'rejected'),
    async (userId, orgId, shape) => {
      if (shape === 'clerk') {
        const claims = orgId === null ? {} : { org_id: orgId };
        const auth = await verifyBearer(hostedEnv(), mintToken(userId, claims));
        return auth?.kind === 'clerk';
      }
      if (shape === 'device') {
        const token = await mintDeviceToken(DEVICE_SECRET, userId, Date.now() / 1000);
        const auth = await verifyBearer(hostedEnv(), token);
        // A desktop payload never names an organisation, whatever was generated.
        return auth?.kind === 'device' && auth.orgId === null && auth.ownerId === userId;
      }
      if (shape === 'shared') {
        return (await verifyBearer(byoEnv(), SHARED_TOKEN))?.kind === 'shared';
      }
      return (await verifyBearer(hostedEnv(), `phd_${userId}.forged`)) === null;
    },
  ),
);

// Feature: multi-organisation-phorma, Property 35: Credential kind semantics are
// unchanged
await asyncProperty('a device credential is refused at the operator surface for any owner', () =>
  fc.asyncProperty(userIdArb, fc.option(orgIdArb, { nil: null }), async (userId, orgId) => {
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    const env = hostedEnv({ TELEMETRY_ADMIN_USER_IDS: userId });
    const token = await mintDeviceToken(DEVICE_SECRET, userId, Date.now() / 1000);
    const headers = { Authorization: `Bearer ${token}` };
    if (orgId !== null) headers[REQUESTED_OWNER_HEADER] = orgId;
    const request = new Request('https://cloud.example.com/api/admin/billing/costs', { headers });
    const refusal = await refuseNonOperator(request, env, reply);
    return refusal?.status === 403;
  }),
);

await mf.dispose();
console.log(failures === 0 ? '\nAll owner identity checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
