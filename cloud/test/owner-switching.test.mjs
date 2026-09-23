/**
 * Owner switching, the worker half (multi-organisation-phorma task 16,
 * Requirement 20).
 *
 * Two things ship on this side and both are only observable through a whole
 * route, which is why this suite drives `/api/me` rather than calling functions:
 *
 *  - **`owners`**, the list the switcher renders, resolved from `org_members` by
 *    `user_id`. It has to appear on BOTH `/api/me` branches, and the
 *    `provisioned: false` branch is the one that matters most: a member who never
 *    subscribed personally has no `tenants` row of their own, so a switcher fed
 *    only by the provisioned branch would be empty for exactly the people who need
 *    it. That is a claim about a route's SHAPE, not about a function's return.
 *  - **`adoptRequestedOwner` wired into `verifyRequest`.** `X-Phorma-Owner` was
 *    inert before this task: `resolveRequestedOwner` existed and nothing called it,
 *    so a desktop install could not switch at all. The assertion that matters is
 *    end to end - the SAME request with and without the header must answer about two
 *    different owners, and a request naming an organisation the caller is not in
 *    must be byte-identical to one that named nothing.
 *
 * Three things are deliberately NOT stubbed, for the reasons `owner-identity`
 * states at length: authorization (a real RS256 JWT verified offline against a
 * generated `CLERK_JWT_KEY`), D1 (`org_members` is the authoritative source, so it
 * is a local Miniflare D1 with the real migrations applied), and the router
 * (`handleApiRequest` is imported directly, so the answer under test is the answer
 * a client would get). KV is an in-memory double - it is a cache rather than SQL
 * that ships, and it costs no loopback sockets.
 *
 * NOT asserted here: the studio's half of the switch. `active-owner.service.spec.ts`
 * and `owner-switch.service.spec.ts` own the signal, the tab closing, the confirm
 * rail and the session-state resets.
 *
 * Run: npx tsx cloud/test/owner-switching.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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

const { handleApiRequest } = await import('../src/api.ts');
const {
  adoptRequestedOwner,
  listMemberships,
  MEMBERSHIP_LIST_LIMIT,
  orgMemberCacheKey,
  REQUESTED_OWNER_HEADER,
  verifyBearer,
} = await import('../src/auth.ts');
const { mintDeviceToken } = await import('../src/device-auth.ts');
const { CAPABILITY_LEVELS } = await import('../src/capabilities.ts');
const { orgNameCacheKey, rememberOrgName, resolveOrgNames } = await import('../src/org-names.ts');

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
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-owner-switching' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements. `/\r?\n/`, never `'\n'`: a CRLF checkout
 * leaves each line ending in `\r`, the `--` stripper matches nothing, and the
 * comment-only tail reaches D1 as "SQL code did not contain a statement".
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

/** Replaces the whole membership table, in ONE batch (one socket per statement). */
async function setMemberships(rows) {
  await DB.batch([
    DB.prepare('DELETE FROM org_members'),
    ...rows.map(({ orgId, userId, level }) =>
      DB.prepare(
        `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        orgId,
        userId,
        level,
        'user_operator',
        // Every row gets the SAME `created_at`, on purpose: that is what an operator
        // pass granting two memberships really produces, and the order assertions
        // below would be vacuous against a timestamp that happened to differ.
        new Date(1_760_000_000_000).toISOString(),
        new Date(1_760_000_000_000).toISOString(),
      ),
    ),
  ]);
}

/** Drops one tenant row, so the `provisioned: false` branch can be driven. */
async function setTenant(row) {
  await DB.batch([
    DB.prepare('DELETE FROM tenants WHERE id = ?').bind(row.id),
    ...(row.tier === null
      ? []
      : [
          DB.prepare(
            `INSERT INTO tenants (id, tier, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(row.id, row.tier, row.status, new Date().toISOString(), new Date().toISOString()),
        ]),
  ]);
}

// --- A KV double -----------------------------------------------------------

function memoryKv() {
  const map = new Map();
  return {
    entries: map,
    async get(key, type) {
      const raw = map.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      map.set(key, value);
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

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-owner-switch' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

const DEVICE_SECRET = 'device-secret-do-not-leak';
const ORIGIN = 'https://cloud.example.com';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

let TENANTS = memoryKv();

// `/api/me` now resolves organisation NAMES from Clerk (`org-names.ts`). Every
// section except the names one below asserts `owners` without a name, so the
// suite-wide default answers every Clerk organisation read with a 404 - the
// "no name" shape - and refuses any other outbound call, so a test can never
// reach the real network by accident. Section 7 swaps in its own stub.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.clerk.com/v1/organizations/')) {
    return new Response(JSON.stringify({ errors: [{ code: 'resource_not_found' }] }), { status: 404 });
  }
  throw new Error(`unexpected outbound request: ${url}`);
};
{
  // The 404s are logged by design; keep them out of this suite's output.
  const realError = console.error;
  console.error = (...args) => {
    if (String(args[0]).startsWith('org names:')) return;
    realError(...args);
  };
}

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    PHORMA_AUTH_SECRET: DEVICE_SECRET,
    DB,
    TENANTS,
    ...extra,
  };
}

/** One `GET /api/me` through the real router. */
async function me({ bearer, owner }) {
  const headers = { Authorization: `Bearer ${bearer}` };
  if (owner !== undefined) headers[REQUESTED_OWNER_HEADER] = owner;
  const response = await handleApiRequest(new Request(`${ORIGIN}/api/me`, { headers }), hostedEnv(), CORS, CTX);
  return { status: response?.status ?? 0, body: response ? await response.json() : null };
}

// ══ 1. `owners` on BOTH branches ════════════════════════════════════════════

console.log('\n`owners` on both /api/me branches (Requirements 20.1, 20.3)');
{
  await setMemberships([
    { orgId: 'org_acme', userId: 'user_member', level: 'builder' },
    { orgId: 'org_beta', userId: 'user_member', level: 'operator' },
    // Somebody else's membership, which must never appear in this caller's list.
    { orgId: 'org_gamma', userId: 'user_other', level: 'admin' },
  ]);

  // The UNPROVISIONED branch first, because it is the common case for a member and
  // the one a switcher fed only by the provisioned branch would leave empty.
  await setTenant({ id: 'user_member', tier: null });
  const unprovisioned = await me({ bearer: mintToken('user_member') });
  check('the unprovisioned branch answers 200', unprovisioned.status === 200, String(unprovisioned.status));
  check(
    'and it is the unprovisioned branch',
    unprovisioned.body?.provisioned === false,
    JSON.stringify(unprovisioned.body),
  );
  check(
    'owners lists exactly the caller\'s memberships',
    JSON.stringify(unprovisioned.body?.owners) ===
      JSON.stringify([
        { ownerId: 'org_acme', level: 'builder' },
        { ownerId: 'org_beta', level: 'operator' },
      ]),
    JSON.stringify(unprovisioned.body?.owners),
  );
  check(
    'and nobody else\'s',
    !JSON.stringify(unprovisioned.body?.owners ?? []).includes('org_gamma'),
    JSON.stringify(unprovisioned.body?.owners),
  );
  check(
    'the personal account is NOT reported as a membership',
    !JSON.stringify(unprovisioned.body?.owners ?? []).includes('user_member'),
    JSON.stringify(unprovisioned.body?.owners),
  );

  // The PROVISIONED branch carries the same field.
  await setTenant({ id: 'user_member', tier: 'pro', status: 'active' });
  const provisioned = await me({ bearer: mintToken('user_member') });
  check('the provisioned branch answers 200', provisioned.status === 200, String(provisioned.status));
  check('and it is the provisioned branch', provisioned.body?.provisioned === true, JSON.stringify(provisioned.body));
  check(
    'owners is identical on both branches',
    JSON.stringify(provisioned.body?.owners) === JSON.stringify(unprovisioned.body?.owners),
    `${JSON.stringify(provisioned.body?.owners)} vs ${JSON.stringify(unprovisioned.body?.owners)}`,
  );

  // A DESKTOP credential gets the same list out of the same source, which is the
  // whole point of resolving it from `org_members` rather than from Clerk.
  const deviceToken = await mintDeviceToken(DEVICE_SECRET, 'user_member', Date.now() / 1000);
  const device = await me({ bearer: deviceToken });
  check(
    'a desktop credential gets the same list',
    JSON.stringify(device.body?.owners) === JSON.stringify(provisioned.body?.owners),
    JSON.stringify(device.body?.owners),
  );

  // A SOLO account is offered nothing, which is what renders no switcher at all.
  await setTenant({ id: 'user_solo', tier: null });
  const solo = await me({ bearer: mintToken('user_solo') });
  check('a solo account is offered an empty list', JSON.stringify(solo.body?.owners) === '[]', JSON.stringify(solo.body?.owners));
}

// ══ 2. A membership removed between two calls ═══════════════════════════════

console.log('\nA membership removed between two calls (Requirement 20.11)');
{
  await setMemberships([{ orgId: 'org_acme', userId: 'user_member', level: 'builder' }]);
  const before = await me({ bearer: mintToken('user_member') });
  check(
    'call one lists the membership',
    JSON.stringify(before.body?.owners) === JSON.stringify([{ ownerId: 'org_acme', level: 'builder' }]),
    JSON.stringify(before.body?.owners),
  );

  await setMemberships([]);
  const after = await me({ bearer: mintToken('user_member') });
  check('call two lists nothing', JSON.stringify(after.body?.owners) === '[]', JSON.stringify(after.body?.owners));
  check('and the route still answers 200', after.status === 200, String(after.status));
  // The list is NOT cached, which is what makes it the next call rather than the
  // next minute - a grant that took 60 seconds to appear would be blamed on the
  // Super_Admin surface that just made it.
  check(
    'no membership list was cached',
    ![...TENANTS.entries.keys()].some((key) => key.startsWith('orgmembers:')),
    [...TENANTS.entries.keys()].join(', '),
  );
}

// ══ 3. An unrecognised level token is DROPPED, not offered ══════════════════

console.log('\nA level token outside the declared vocabulary');
{
  await setMemberships([
    { orgId: 'org_acme', userId: 'user_member', level: 'builder' },
    { orgId: 'org_future', userId: 'user_member', level: 'archduke' },
  ]);
  const answer = await me({ bearer: mintToken('user_member') });
  check(
    'the unrecognised membership is not offered',
    JSON.stringify(answer.body?.owners) === JSON.stringify([{ ownerId: 'org_acme', level: 'builder' }]),
    JSON.stringify(answer.body?.owners),
  );
  check(
    'every offered level is in the declared vocabulary',
    (answer.body?.owners ?? []).every((entry) => CAPABILITY_LEVELS.includes(entry.level)),
    JSON.stringify(answer.body?.owners),
  );
}

// ══ 4. The header is no longer inert ════════════════════════════════════════

console.log('\nX-Phorma-Owner, end to end (Requirements 20.4, 20.10)');
{
  await setMemberships([{ orgId: 'org_acme', userId: 'user_member', level: 'builder' }]);
  await setTenant({ id: 'org_acme', tier: 'team', status: 'active' });
  await setTenant({ id: 'user_member', tier: null });
  TENANTS = memoryKv();

  const deviceToken = await mintDeviceToken(DEVICE_SECRET, 'user_member', Date.now() / 1000);

  const bare = await me({ bearer: deviceToken });
  check('with no header the personal owner answers', bare.body?.ownerId === 'user_member', JSON.stringify(bare.body));
  check('and it is unprovisioned', bare.body?.provisioned === false, JSON.stringify(bare.body));

  const named = await me({ bearer: deviceToken, owner: 'org_acme' });
  check('the SAME token naming the organisation answers about it', named.body?.ownerId === 'org_acme', JSON.stringify(named.body));
  check('the organisation\'s tier is what is reported', named.body?.tier === 'team', JSON.stringify(named.body));
  check('and the level comes from the membership row', named.body?.level === 'builder', JSON.stringify(named.body));
  check('`id` is the owner the answer is about', named.body?.id === 'org_acme', JSON.stringify(named.body));

  // An organisation the caller is NOT in, an unparseable value, and no header at
  // all are three cases that must be INDISTINGUISHABLE from outside - so the whole
  // body is compared, not just the status.
  const foreign = await me({ bearer: deviceToken, owner: 'org_gamma' });
  const hostile = await me({ bearer: deviceToken, owner: 'org:acme' });
  check(
    'a foreign organisation is indistinguishable from no header',
    JSON.stringify(foreign.body) === JSON.stringify(bare.body) && foreign.status === bare.status,
    JSON.stringify(foreign.body),
  );
  check(
    'an unparseable value is indistinguishable too',
    JSON.stringify(hostile.body) === JSON.stringify(bare.body) && hostile.status === bare.status,
    JSON.stringify(hostile.body),
  );

  // A VERIFIED claim outranks the header: a header can never move a browser session
  // out of the organisation Clerk minted it for.
  const browser = await me({
    bearer: mintToken('user_member', { org_id: 'org_acme', org_role: 'org:admin' }),
    owner: 'org_gamma',
  });
  check('a claim outranks a header', browser.body?.ownerId === 'org_acme', JSON.stringify(browser.body));

  // A revoked membership bites on the NEXT request. Driven with the cache WARM,
  // because that is the only version of this that could fail: the management route
  // invalidates the key, so the invalidation is what is under test here.
  const warm = await me({ bearer: deviceToken, owner: 'org_acme' });
  check('the member is addressing the organisation', warm.body?.ownerId === 'org_acme', JSON.stringify(warm.body));
  await setMemberships([]);
  await TENANTS.delete(orgMemberCacheKey('org_acme', 'user_member'));
  const revoked = await me({ bearer: deviceToken, owner: 'org_acme' });
  check('after a revocation the same request answers about the personal owner', revoked.body?.ownerId === 'user_member', JSON.stringify(revoked.body));
  check(
    'and it is byte-identical to the request that named nothing',
    JSON.stringify(revoked.body) === JSON.stringify(await (await me({ bearer: deviceToken })).body),
    JSON.stringify(revoked.body),
  );
}

// ══ 5. `adoptRequestedOwner` changes nothing it should not ══════════════════

console.log('\nadoptRequestedOwner leaves every other shape untouched');
{
  await setMemberships([{ orgId: 'org_acme', userId: 'user_member', level: 'builder' }]);
  const env = { DB, TENANTS: memoryKv() };
  const deviceToken = await mintDeviceToken(DEVICE_SECRET, 'user_member', Date.now() / 1000);
  const device = await verifyBearer(hostedEnv(), deviceToken);
  const bareRequest = new Request(`${ORIGIN}/api/me`);
  const namedRequest = new Request(`${ORIGIN}/api/me`, {
    headers: { [REQUESTED_OWNER_HEADER]: 'org_acme' },
  });

  const unchanged = await adoptRequestedOwner(env, device, bareRequest);
  check('an absent header returns the SAME context object', unchanged === device);

  const adopted = await adoptRequestedOwner(env, device, namedRequest);
  check('a confirmed header moves ownerId', adopted.ownerId === 'org_acme', JSON.stringify(adopted));
  check('and orgId with it, so resolveRole answers about the organisation', adopted.orgId === 'org_acme', JSON.stringify(adopted));
  check('userId is untouched - it answers who is asking', adopted.userId === 'user_member', JSON.stringify(adopted));
  check('kind is untouched, so every operator refusal still holds', adopted.kind === 'device', adopted.kind);

  const shared = await verifyBearer({ PHORMA_TOKEN: 'byo-token' }, 'byo-token');
  const sharedAdopted = await adoptRequestedOwner(env, shared, namedRequest);
  check('a shared credential ignores the header outright', sharedAdopted === shared);

  const foreign = await adoptRequestedOwner(env, device, new Request(`${ORIGIN}/api/me`, {
    headers: { [REQUESTED_OWNER_HEADER]: 'org_nope' },
  }));
  check('an unconfirmed organisation returns the SAME context object', foreign === device);
}

// ══ 6. The list is bounded, and fails closed ════════════════════════════════

console.log('\nlistMemberships bounds and failure shape');
{
  const many = Array.from({ length: MEMBERSHIP_LIST_LIMIT + 10 }, (_, index) => ({
    orgId: `org_${String(index).padStart(3, '0')}`,
    userId: 'user_many',
    level: 'operator',
  }));
  await setMemberships(many);
  const bounded = await listMemberships({ DB }, 'user_many');
  check(
    `the list is capped at ${MEMBERSHIP_LIST_LIMIT}`,
    bounded.length === MEMBERSHIP_LIST_LIMIT,
    String(bounded.length),
  );

  check('no DB binding reads as no memberships', (await listMemberships({}, 'user_many')).length === 0);
  check('a null userId reads as no memberships', (await listMemberships({ DB }, null)).length === 0);

  // A table that is not there - a database predating `0006_organisations.sql` - must
  // read as "no memberships" with the cause logged, never throw. A throw here would
  // turn a missing migration into a 500 on the one route the studio polls for its
  // plan and its credits.
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    const broken = await listMemberships(
      { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('no such table'); } }) }) } },
      'user_many',
    );
    check('a failed read answers an empty list rather than throwing', broken.length === 0);
    check('and the cause is logged', logged.some((line) => line.includes('org_members listing failed')), logged.join(' | '));
  } finally {
    console.error = realError;
  }
}

// ══ 7. Organisation NAMES ride on `owners` ══════════════════════════════════
//
// A desktop install has no Clerk user and so no `organizationMemberships`; before
// this the switcher could only render `Organisation <id tail>`. The worker now
// resolves the name from Clerk, caches it in KV, and omits it when it cannot - so
// the three claims are: a name is reported, it is fetched ONCE per TTL rather than
// per poll, and a Clerk failure degrades to "no name" without failing the read.

console.log('\nOrganisation names on `owners`');
{
  await setMemberships([
    { orgId: 'org_named', userId: 'user_member', level: 'admin' },
    { orgId: 'org_broken', userId: 'user_member', level: 'operator' },
  ]);
  await setTenant({ id: 'user_member', tier: null });
  TENANTS = memoryKv();

  const realFetch = globalThis.fetch;
  const realError = console.error;
  const clerkCalls = [];
  console.error = () => undefined;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.clerk.com/')) throw new Error(`unexpected outbound ${url}`);
    clerkCalls.push({ url, auth: (init.headers ?? {}).Authorization });
    if (url.endsWith('/organizations/org_named')) {
      return new Response(JSON.stringify({ id: 'org_named', name: '  Phorma Labs  ' }), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 503 });
  };
  try {
    const first = await me({ bearer: mintToken('user_member') });
    check('the read still answers 200 when one name lookup fails', first.status === 200, String(first.status));
    check(
      'a resolvable organisation carries its trimmed name',
      JSON.stringify(first.body?.owners?.[1]) === JSON.stringify({ ownerId: 'org_named', level: 'admin', name: 'Phorma Labs' }),
      JSON.stringify(first.body?.owners),
    );
    check(
      'an unresolvable one omits the field, byte-identical to an older worker',
      JSON.stringify(first.body?.owners?.[0]) === JSON.stringify({ ownerId: 'org_broken', level: 'operator' }),
      JSON.stringify(first.body?.owners),
    );
    check(
      'Clerk is asked with the worker secret',
      clerkCalls.every((call) => call.auth === 'Bearer sk_test_clerk_not_used_offline'),
      JSON.stringify(clerkCalls),
    );

    const callsAfterFirst = clerkCalls.length;
    const deviceToken = await mintDeviceToken(DEVICE_SECRET, 'user_member', Date.now() / 1000);
    const second = await me({ bearer: deviceToken });
    check(
      'a desktop credential gets the same names',
      JSON.stringify(second.body?.owners) === JSON.stringify(first.body?.owners),
      JSON.stringify(second.body?.owners),
    );
    check(
      'and the second poll made NO Clerk call - hits and misses are both cached',
      clerkCalls.length === callsAfterFirst,
      `${callsAfterFirst} then ${clerkCalls.length}`,
    );
    check(
      'the cache holds one key per organisation',
      TENANTS.entries.has(orgNameCacheKey('org_named')) && TENANTS.entries.has(orgNameCacheKey('org_broken')),
      [...TENANTS.entries.keys()].join(', '),
    );

    // Seeding (what `org-admin.ts` does at creation) short-circuits the fetch.
    TENANTS = memoryKv();
    await rememberOrgName({ TENANTS }, 'org_broken', 'Seeded Name');
    const calls = clerkCalls.length;
    const seeded = await me({ bearer: mintToken('user_member') });
    check(
      'a seeded name is reported with no Clerk read for it',
      seeded.body?.owners?.[0]?.name === 'Seeded Name' &&
        !clerkCalls.slice(calls).some((call) => call.url.endsWith('/org_broken')),
      JSON.stringify(seeded.body?.owners),
    );
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }

  // No KV binding: no lookup at all, rather than a Clerk call on every poll.
  const noKv = await resolveOrgNames({ CLERK_SECRET_KEY: 'sk_x' }, ['org_named']);
  check('with no cache binding nothing is looked up', noKv.get('org_named') === null);
}

await setMemberships([]);
await mf.dispose();

if (failures > 0) {
  console.error(`\nowner-switching: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nowner-switching: all checks passed.');
