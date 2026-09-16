/**
 * `/api/backups/*` end to end (cloud-workflow-backup, Requirements 9-20).
 *
 * ## The claims that matter
 *
 * This is where the feature's central promise is either true or not: **a backup is
 * not a mirror.** So the suite is organised around the ways it could quietly stop
 * being a backup:
 *
 * - A conflicting upload silently winning, losing the other machine's work.
 * - An oversized upload half-storing, leaving a metadata row with no body.
 * - A lapsed subscription taking read access with it, which would destroy the copy
 *   at the moment it is most needed.
 * - A purge reachable without a soft delete first, so one mis-aimed request takes
 *   out a live backup.
 * - The tombstone sweep removing a row before its bodies, orphaning R2 objects
 *   that nothing indexes any more.
 *
 * ## Harness
 *
 * The REAL router (`handleApiRequest`), a REAL local D1 with the real migrations,
 * a REAL Miniflare R2 bucket, and a locally minted RS256 JWT verified against a
 * `CLERK_JWT_KEY` PEM - `@clerk/backend`'s offline path runs in Node with no JWKS
 * fetch, so authorization is never stubbed. Same shape as
 * `billing-routes.test.mjs`.
 *
 * Every D1 statement goes through `withLoopbackRetryD1`, because each proxied
 * statement costs one loopback socket.
 *
 * Run: npx tsx cloud/test/backup-routes.test.mjs
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
// `DurableObject`. Node cannot resolve that built-in, so it is redirected before
// the module graph loads.
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
const { runBackupRetention } = await import('../src/backup-routes.ts');
const { TenantStore } = await import('../src/tenants.ts');
const { MAX_SPEC_BYTES, REVISIONS_KEPT, TOMBSTONE_WINDOW_MS } = await import('../src/backups.ts');
const { bodyKey } = await import('../src/backup-store.ts');

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

// --- Local D1 + R2 with the real migrations --------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-backup-routes' },
  r2Buckets: { BACKUPS: 'phorma-backups-routes' },
});

const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));
const BACKUPS = await mf.getR2Bucket('BACKUPS');

/** Same CRLF-tolerant migration reader the other D1 suites use. */
function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

for (const file of ['0001_init.sql', '0003_billing.sql', '0004_billing_ordering.sql', '0005_workflow_backups.sql']) {
  for (const statement of statementsOf(file)) {
    await DB.prepare(statement).run();
  }
}

const store = new TenantStore({ DB });

// --- A real session token --------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-backup-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600 },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// --- Environment ----------------------------------------------------------

const KEY_ENC_SECRET = Buffer.alloc(32, 7).toString('base64');
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    DB,
    BACKUPS,
    KEY_ENC_SECRET,
    ...extra,
  };
}

const realConsoleError = console.error;

/** One `/api/*` request through the real router. */
async function api(path, { method = 'GET', body, token, headers: extraHeaders, env } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${mintToken(token)}`;
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const response = await handleApiRequest(request, env ?? hostedEnv(), CORS, CTX);
  return {
    status: response?.status ?? 0,
    body: response ? await response.json().catch(() => null) : null,
  };
}

/** A workflow spec of roughly controllable size. */
function spec(id, { name = `Workflow ${id}`, nodes = 4, savedAt = '2026-09-01T00:00:00.000Z' } = {}) {
  return {
    version: 1,
    id,
    name,
    savedAt,
    graph: {
      nodes: Array.from({ length: nodes }, (_unused, index) => ({
        id: `agent-${index}`,
        name: `Step ${index}`,
        kind: 'agent',
        category: 'flow',
        icon: 'ti ti-robot',
        position: { x: index * 220, y: 0 },
        ports: [{ id: `agent-${index}-out`, name: 'Out', role: 'message-out' }],
        data: { prompt: 'Summarize the input.' },
      })),
      connections: [],
    },
  };
}

function bodyFor(id, options = {}) {
  return { spec: spec(id, options), connections: options.connections ?? [] };
}

/** Uploads one revision. `ifMatch` of `undefined` sends no header. */
function upload(tenant, workflowId, options = {}) {
  const headers = {};
  if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch);
  return api(`/api/backups/${workflowId}`, {
    method: 'POST',
    token: tenant,
    headers,
    body: options.raw ?? bodyFor(workflowId, options),
    env: options.env,
  });
}

async function seedTenant(id, { tier = 'starter', status = 'active', statusAt = 0 } = {}) {
  await store.upsertTenant({ id, email: `${id}@example.com`, tier, status });
  if (statusAt > 0) {
    await DB.prepare(`UPDATE tenants SET billing_status_at = ? WHERE id = ?`)
      .bind(statusAt, id)
      .run();
  }
}

// ══ 1. Availability and authorization ══════════════════════════════════════

console.log('\nAuthorization and binding gates');
{
  const anonymous = await api('/api/backups');
  check('no bearer is 401', anonymous.status === 401, JSON.stringify(anonymous.body));

  // A BYO worker binds no D1, so the whole tenant surface answers 501 above this
  // module - which is how backup is ABSENT rather than broken there.
  const byo = await api('/api/backups', { token: 'user_byo', env: { PHORMA_MODE: 'byo' } });
  check('a worker with no D1 refuses the surface', byo.status === 501, JSON.stringify(byo.body));

  await seedTenant('user_nokey');
  const noKey = await api('/api/backups', {
    token: 'user_nokey',
    env: hostedEnv({ KEY_ENC_SECRET: undefined }),
  });
  check('a missing KEY_ENC_SECRET is 501', noKey.status === 501, JSON.stringify(noKey.body));
  // Named, so an operator is sent to the right place, and it states the rule.
  check(
    'and says a backup is never stored unencrypted',
    /KEY_ENC_SECRET/.test(noKey.body?.error ?? '') && /unencrypted/.test(noKey.body?.error ?? ''),
    noKey.body?.error,
  );

  const noBucket = await api('/api/backups', {
    token: 'user_nokey',
    env: hostedEnv({ BACKUPS: undefined }),
  });
  check('a missing bucket is 501', noBucket.status === 501, JSON.stringify(noBucket.body));

  // Signed in with no tenant row: no plan has ever existed. 402, not 403 - this is
  // a billing state, and the studio branches on the code.
  const noTenant = await api('/api/backups', { token: 'user_never_subscribed' });
  check('a signed-in user with no plan is 402', noTenant.status === 402, JSON.stringify(noTenant.body));
  check('the refusal carries no_subscription', noTenant.body?.code === 'no_subscription');
}

// ══ 2. Upload ══════════════════════════════════════════════════════════════

console.log('\nUploading a revision');
{
  await seedTenant('user_up');
  const first = await upload('user_up', 'wf-a');
  check('the first upload succeeds', first.status === 200 && first.body?.ok === true, JSON.stringify(first.body));
  check('it is revision 1', first.body?.revision === 1, JSON.stringify(first.body));
  check('it reports a spec hash', typeof first.body?.specHash === 'string' && first.body.specHash.length > 0);
  check('it reports the stored size', typeof first.body?.sizeBytes === 'number' && first.body.sizeBytes > 0);

  const listed = await api('/api/backups', { token: 'user_up' });
  check('the list shows it', listed.body?.backups?.length === 1, JSON.stringify(listed.body));
  check('with the workflow name', listed.body.backups[0].name === 'Workflow wf-a');
  check('it is writable while active', listed.body?.writable === true);
  check('the plan cap is reported', listed.body?.cap === 25, String(listed.body?.cap));
  check('and how many are used', listed.body?.used === 1);
  check('and how many revisions are kept', listed.body?.revisionsKept === REVISIONS_KEPT);
  check('a live backup has no tombstone countdown', listed.body.backups[0].daysRemaining === null);
}

{
  // The path is authoritative. A mismatch is a client bug, not something to
  // silently resolve one way or the other.
  await seedTenant('user_mismatch');
  const wrong = await api('/api/backups/wf-path', {
    method: 'POST',
    token: 'user_mismatch',
    body: bodyFor('wf-body'),
  });
  check('a spec id that disagrees with the path is 400', wrong.status === 400, JSON.stringify(wrong.body));
  check('nothing was stored', (await api('/api/backups', { token: 'user_mismatch' })).body?.backups?.length === 0);
}

{
  await seedTenant('user_shape');
  const bad = await api('/api/backups/wf-x', { method: 'POST', token: 'user_shape', body: { spec: null } });
  check('a body with no spec is 400', bad.status === 400, JSON.stringify(bad.body));

  const notJson = await upload('user_shape', 'wf-x', { raw: 'not json at all' });
  check('an unparseable body is 400', notJson.status === 400, JSON.stringify(notJson.body));

  // The key segment guard. A workflow id becomes a path segment in
  // `backup/{tenant}/{workflowId}/{revision}`, so anything that could forge a
  // nested key has to be refused before it reaches R2.
  //
  // Traversal never even arrives at the guard: `new URL()` percent-decodes the
  // unreserved `.` and then RESOLVES the segment away, so both `..` and `%2e%2e`
  // leave the path as `/api/` and no backup route matches. Safe, but by a
  // different mechanism, so it is asserted as what it actually is - a reader who
  // saw a 400 here would think the regex was doing this work.
  for (const form of ['..', '%2e%2e', '%2E%2E']) {
    const resolved = await api(`/api/backups/${form}`, {
      method: 'POST',
      token: 'user_shape',
      body: bodyFor('..'),
    });
    check(
      `"${form}" is resolved away by the URL parser, never routed`,
      resolved.status === 404,
      JSON.stringify(resolved.body),
    );
  }

  // An encoded SLASH does survive normalization - `pathname` keeps `%2F` - so it
  // reaches the guard, and the guard is what refuses it.
  const encodedSlash = await api('/api/backups/wf%2Fevil', { method: 'POST', token: 'user_shape', body: bodyFor('wf/evil') });
  check('an encoded slash is 400', encodedSlash.status === 400, JSON.stringify(encodedSlash.body));
  const colon = await api('/api/backups/wf%3Aevil', { method: 'POST', token: 'user_shape', body: bodyFor('wf:evil') });
  check('a colon in the workflow id is 400', colon.status === 400, JSON.stringify(colon.body));
}

console.log('\nThe 2MB cap (Requirement 10.8)');
{
  await seedTenant('user_big');
  // A spec whose serialized body is comfortably over the cap.
  const huge = { spec: { ...spec('wf-big'), description: 'x'.repeat(MAX_SPEC_BYTES + 1024) }, connections: [] };
  const refused = await upload('user_big', 'wf-big', { raw: huge });
  check('an oversized upload is 413', refused.status === 413, JSON.stringify(refused.body?.error));
  check('the refusal names the limit', refused.body?.limitBytes === MAX_SPEC_BYTES);
  check('and the actual size', refused.body?.actualBytes > MAX_SPEC_BYTES, String(refused.body?.actualBytes));
  check('and says nothing was stored', /Nothing was stored/.test(refused.body?.error ?? ''), refused.body?.error);
  // Requirement 10.8's second half: NOTHING is stored, so no metadata row appears.
  check('no metadata row was created', (await api('/api/backups', { token: 'user_big' })).body?.backups?.length === 0);
  check('no body was stored', (await BACKUPS.get(bodyKey('user_big', 'wf-big', 1))) === null);
}

console.log('\nOptimistic concurrency over HTTP (Requirement 16)');
{
  await seedTenant('user_conc');
  await upload('user_conc', 'wf-c');

  const bad = await upload('user_conc', 'wf-c', { ifMatch: 'not-a-number' });
  check('an unparseable If-Match is 400', bad.status === 400, JSON.stringify(bad.body));

  const ok = await upload('user_conc', 'wf-c', { ifMatch: 1, name: 'Second' });
  check('a matching If-Match is accepted', ok.status === 200 && ok.body?.revision === 2, JSON.stringify(ok.body));

  const stale = await upload('user_conc', 'wf-c', { ifMatch: 1 });
  check('a stale If-Match is 409', stale.status === 409, JSON.stringify(stale.body));
  check('the 409 carries the current revision', stale.body?.revision === 2, JSON.stringify(stale.body));
  check('and a code the studio can branch on', stale.body?.code === 'backup_conflict');
  // Nothing merges: the stored copy is still the accepted one.
  check('the stale upload stored nothing', (await BACKUPS.get(bodyKey('user_conc', 'wf-c', 3))) === null);

  const blind = await upload('user_conc', 'wf-c');
  check('no If-Match on an existing backup is 409', blind.status === 409, JSON.stringify(blind.body));

  // A quoted ETag-style value is accepted, since that is what `If-Match` normally
  // carries and a client library may add the quotes.
  const quoted = await upload('user_conc', 'wf-c', { ifMatch: '"2"' });
  check('a quoted If-Match is accepted', quoted.status === 200 && quoted.body?.revision === 3, JSON.stringify(quoted.body));
}

console.log('\nRetention on upload (Requirement 10.7)');
{
  await seedTenant('user_keep', { tier: 'team' });
  for (let revision = 1; revision <= REVISIONS_KEPT + 3; revision += 1) {
    const result = await upload('user_keep', 'wf-k', { ifMatch: revision === 1 ? undefined : revision - 1 });
    if (result.status !== 200) {
      check(`upload ${revision} succeeded`, false, JSON.stringify(result.body));
      break;
    }
  }
  const revisions = await api('/api/backups/wf-k/revisions', { token: 'user_keep' });
  check('the current revision is reported', revisions.body?.current === REVISIONS_KEPT + 3, JSON.stringify(revisions.body?.current));
  check(
    `at most ${REVISIONS_KEPT} bodies are retained`,
    revisions.body?.revisions?.length === REVISIONS_KEPT,
    String(revisions.body?.revisions?.length),
  );
  check('the newest is always retained', revisions.body.revisions[0] === REVISIONS_KEPT + 3, JSON.stringify(revisions.body.revisions));
  check('the oldest revisions are gone', !revisions.body.revisions.includes(1));
}

console.log('\nThe workflow cap (Requirements 10.10, 10.11)');
{
  await seedTenant('user_cap');
  const now = new Date().toISOString();
  await DB.batch(
    Array.from({ length: 25 }, (_unused, index) =>
      DB.prepare(
        `INSERT INTO workflow_backups
           (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
         VALUES ('user_cap', ?, 'Filler', 1, 'h', 10, ?, ?, NULL)`,
      ).bind(`wf-filler-${index}`, now, now),
    ),
  );

  const refused = await upload('user_cap', 'wf-new');
  check('a new workflow at the cap is 409', refused.status === 409, JSON.stringify(refused.body));
  check('with the backup_cap code', refused.body?.code === 'backup_cap', JSON.stringify(refused.body));
  check('and the cap named', refused.body?.cap === 25);
  check('the refusal says existing backups keep updating', /keep updating/.test(refused.body?.error ?? ''), refused.body?.error);

  // The half that matters: a cap must never make an EXISTING backup go stale.
  const existing = await upload('user_cap', 'wf-filler-0', { ifMatch: 1 });
  check('an existing workflow still uploads at the cap', existing.status === 200 && existing.body?.revision === 2, JSON.stringify(existing.body));
}

// ══ 3. Download ════════════════════════════════════════════════════════════

console.log('\nDownloading a revision');
{
  await seedTenant('user_dl');
  await upload('user_dl', 'wf-d', {
    connections: [
      { id: 'conn-xero', name: 'Xero (production)' },
      // Anything beyond {id, name} is DISCARDED rather than stored: this is the
      // one field of the body a secret could ride in (Requirement 19.2).
      { id: 'conn-bank', name: 'Bank feed', apiKey: 'sk-live-should-never-be-stored', token: 'nope' },
    ],
  });

  const got = await api('/api/backups/wf-d/1', { token: 'user_dl' });
  check('the body comes back', got.status === 200, JSON.stringify(got.body?.error));
  check('with the spec', got.body?.spec?.id === 'wf-d', JSON.stringify(got.body?.spec?.id));
  check('and its connections by id and name', got.body?.connections?.length === 2, JSON.stringify(got.body?.connections));
  check(
    'carrying NO credential field (19.2, 19.5)',
    !JSON.stringify(got.body?.connections).includes('sk-live') &&
      !JSON.stringify(got.body?.connections).includes('apiKey') &&
      !JSON.stringify(got.body?.connections).includes('token'),
    JSON.stringify(got.body?.connections),
  );

  const missing = await api('/api/backups/wf-d/99', { token: 'user_dl' });
  check('a revision that is not retained is 404', missing.status === 404, JSON.stringify(missing.body));

  const unknown = await api('/api/backups/wf-nothing/1', { token: 'user_dl' });
  check('a workflow with no backup is 404', unknown.status === 404, JSON.stringify(unknown.body));

  const badRevision = await api('/api/backups/wf-d/zero', { token: 'user_dl' });
  check('a non-numeric revision is 400', badRevision.status === 400, JSON.stringify(badRevision.body));
}

console.log('\nTenant isolation (Requirement 9.5)');
{
  await seedTenant('user_a');
  await seedTenant('user_b');
  await upload('user_a', 'wf-shared', { name: 'Mine' });

  // The SAME workflow id under another account. Every route is scoped by the
  // verified identity, never by a request field, so this can only be a 404.
  const stranger = await api('/api/backups/wf-shared/1', { token: 'user_b' });
  check('another account cannot download it', stranger.status === 404, JSON.stringify(stranger.body));
  check('and does not see it listed', (await api('/api/backups', { token: 'user_b' })).body?.backups?.length === 0);

  // And an upload under the same id is a separate row, not an overwrite.
  const theirs = await upload('user_b', 'wf-shared', { name: 'Theirs' });
  check('their own upload starts at revision 1', theirs.body?.revision === 1, JSON.stringify(theirs.body));
  check("the first account's copy is untouched", (await api('/api/backups/wf-shared/1', { token: 'user_a' })).body?.spec?.name === 'Mine');
}

// ══ 4. Subscription lapse (Requirement 20) ═════════════════════════════════

console.log('\nA lapsed subscription is read-only, not gone');
{
  const tenDaysAgo = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
  await seedTenant('user_lapse');
  await upload('user_lapse', 'wf-l');
  // Now cancel, with a lapse clock 10 days back.
  await seedTenant('user_lapse', { status: 'canceled', statusAt: tenDaysAgo });

  const listed = await api('/api/backups', { token: 'user_lapse' });
  check('a lapsed tenant can still list', listed.status === 200, JSON.stringify(listed.body?.error));
  check('the list says it is not writable', listed.body?.writable === false, JSON.stringify(listed.body));
  check('and how many read-only days are left', listed.body?.readOnlyDaysRemaining === 80, String(listed.body?.readOnlyDaysRemaining));

  const download = await api('/api/backups/wf-l/1', { token: 'user_lapse' });
  check('a lapsed tenant can still download (20.1)', download.status === 200, JSON.stringify(download.body?.error));

  const write = await upload('user_lapse', 'wf-l', { ifMatch: 1 });
  check('but cannot upload (20.2)', write.status === 402, JSON.stringify(write.body));
  check('the refusal says read-only', write.body?.readOnly === true, JSON.stringify(write.body));
  check('and names the remaining window', /80 more days/.test(write.body?.error ?? ''), write.body?.error);

  // Renewing restores writes with no further action (20.4).
  await seedTenant('user_lapse', { status: 'active' });
  const renewed = await upload('user_lapse', 'wf-l', { ifMatch: 1 });
  check('renewing restores uploads with no other step', renewed.status === 200 && renewed.body?.revision === 2, JSON.stringify(renewed.body));
}

{
  // `past_due` keeps BOTH: requirement 18 says a failed payment costs a tenant
  // nothing but hosted runs, and a backup is not a run.
  await seedTenant('user_pastdue', { status: 'past_due' });
  await upload('user_pastdue', 'wf-p');
  const listed = await api('/api/backups', { token: 'user_pastdue' });
  check('a past_due tenant is still writable', listed.body?.writable === true, JSON.stringify(listed.body));
  check('with no read-only countdown', listed.body?.readOnlyDaysRemaining === null);
  const write = await upload('user_pastdue', 'wf-p', { ifMatch: 1 });
  check('and can still upload', write.status === 200, JSON.stringify(write.body));
}

{
  // Past the 90 day window the surface closes, and says why.
  const longAgo = Math.floor((Date.now() - 120 * 24 * 60 * 60 * 1000) / 1000);
  await seedTenant('user_expired', { status: 'canceled', statusAt: longAgo });
  const listed = await api('/api/backups', { token: 'user_expired' });
  check('past the window every route is 402', listed.status === 402, JSON.stringify(listed.body));
  check('and the reason is stated', /read-only window/.test(listed.body?.error ?? ''), listed.body?.error);
}

// ══ 5. Delete, purge, delete-all (Requirement 17) ══════════════════════════

console.log('\nSoft delete keeps the bodies');
{
  await seedTenant('user_del');
  await upload('user_del', 'wf-t');

  const deleted = await api('/api/backups/wf-t', { method: 'DELETE', token: 'user_del' });
  check('the delete succeeds', deleted.status === 200 && deleted.body?.ok === true, JSON.stringify(deleted.body));
  check('it reports a change', deleted.body?.changed === true);
  check('and the days remaining', deleted.body?.daysRemaining === 30, String(deleted.body?.daysRemaining));

  const listed = await api('/api/backups', { token: 'user_del' });
  check('the tombstone is still listed (17.9)', listed.body?.backups?.length === 1, JSON.stringify(listed.body));
  check('marked as deleted', typeof listed.body.backups[0].deletedAt === 'string');
  check('with a countdown', listed.body.backups[0].daysRemaining === 30);

  // The claim this whole design exists for: the body is still there.
  const download = await api('/api/backups/wf-t/1', { token: 'user_del' });
  check('a tombstone is still downloadable (17.5)', download.status === 200, JSON.stringify(download.body?.error));
  check('and restores the same spec (17.11)', download.body?.spec?.id === 'wf-t');

  const again = await api('/api/backups/wf-t', { method: 'DELETE', token: 'user_del' });
  check('re-deleting reports no change', again.body?.changed === false, JSON.stringify(again.body));
  check(
    'and does NOT extend the window',
    again.body?.deletedAt === deleted.body?.deletedAt,
    `${deleted.body?.deletedAt} -> ${again.body?.deletedAt}`,
  );

  // Saving it again revives it: the workflow is back in the library.
  const revived = await upload('user_del', 'wf-t', { ifMatch: 1 });
  check('an upload revives a tombstone', revived.status === 200, JSON.stringify(revived.body));
  check('and it is no longer marked deleted', (await api('/api/backups', { token: 'user_del' })).body.backups[0].deletedAt === null);
}

console.log('\nPurge requires a delete first');
{
  await seedTenant('user_purge');
  await upload('user_purge', 'wf-u');

  const early = await api('/api/backups/wf-u?purge=1', { method: 'DELETE', token: 'user_purge' });
  check('purging a LIVE backup is refused', early.status === 409, JSON.stringify(early.body));
  check('and says to delete it first', /Delete this backup before purging/.test(early.body?.error ?? ''), early.body?.error);
  check('the backup survives', (await api('/api/backups/wf-u/1', { token: 'user_purge' })).status === 200);

  await api('/api/backups/wf-u', { method: 'DELETE', token: 'user_purge' });
  const purged = await api('/api/backups/wf-u?purge=1', { method: 'DELETE', token: 'user_purge' });
  check('purging a tombstone succeeds', purged.status === 200 && purged.body?.purged === true, JSON.stringify(purged.body));
  check('it reports how many bodies went', purged.body?.bodies === 1, JSON.stringify(purged.body));
  check('the row is gone', (await api('/api/backups', { token: 'user_purge' })).body?.backups?.length === 0);
  check('the body is gone', (await BACKUPS.get(bodyKey('user_purge', 'wf-u', 1))) === null);
}

console.log('\nDisable and delete everything (Requirement 11.6)');
{
  await seedTenant('user_wipe');
  await upload('user_wipe', 'wf-1');
  await upload('user_wipe', 'wf-2');
  await seedTenant('user_bystander');
  await upload('user_bystander', 'wf-3');

  const wiped = await api('/api/backups', { method: 'DELETE', token: 'user_wipe' });
  check('delete-all succeeds', wiped.status === 200 && wiped.body?.ok === true, JSON.stringify(wiped.body));
  check('it reports the workflow count', wiped.body?.workflows === 2, JSON.stringify(wiped.body));
  check('and the body count', wiped.body?.bodies === 2, JSON.stringify(wiped.body));
  check('nothing is listed', (await api('/api/backups', { token: 'user_wipe' })).body?.backups?.length === 0);
  check('no bodies remain', (await BACKUPS.get(bodyKey('user_wipe', 'wf-1', 1))) === null);
  check("another account's backups are untouched", (await api('/api/backups', { token: 'user_bystander' })).body?.backups?.length === 1);
  check('delete-all is idempotent', (await api('/api/backups', { method: 'DELETE', token: 'user_wipe' })).status === 200);
}

// ══ 6. The retention sweep (Requirement 17.8) ══════════════════════════════

console.log('\nThe tombstone sweep');
{
  await seedTenant('user_sweep');
  await upload('user_sweep', 'wf-old');
  await upload('user_sweep', 'wf-recent');
  await upload('user_sweep', 'wf-live');
  await api('/api/backups/wf-old', { method: 'DELETE', token: 'user_sweep' });
  await api('/api/backups/wf-recent', { method: 'DELETE', token: 'user_sweep' });
  // Age the first tombstone past its window.
  await DB.prepare(`UPDATE workflow_backups SET deleted_at = ? WHERE tenant_id = 'user_sweep' AND workflow_id = 'wf-old'`)
    .bind(new Date(Date.now() - TOMBSTONE_WINDOW_MS - 60_000).toISOString())
    .run();

  const result = await runBackupRetention(hostedEnv());
  check('the sweep removes exactly the expired tombstone', result.swept === 1 && result.failed === 0, JSON.stringify(result));

  const listed = await api('/api/backups', { token: 'user_sweep' });
  const ids = (listed.body?.backups ?? []).map(entry => entry.workflowId).sort();
  check('the expired tombstone is gone', !ids.includes('wf-old'), JSON.stringify(ids));
  check('the in-window tombstone survives', ids.includes('wf-recent'), JSON.stringify(ids));
  check('the live backup survives', ids.includes('wf-live'), JSON.stringify(ids));
  // Bodies go BEFORE the row, because the row is the only index of which objects
  // belong to a tenant - the reverse order orphans them.
  check('its bodies went too', (await BACKUPS.get(bodyKey('user_sweep', 'wf-old', 1))) === null);
  check("the survivors' bodies are intact", (await BACKUPS.get(bodyKey('user_sweep', 'wf-recent', 1))) !== null);

  const noBindings = await runBackupRetention({ PHORMA_MODE: 'byo' });
  check('the sweep is a no-op with no bindings', noBindings.swept === 0 && noBindings.failed === 0, JSON.stringify(noBindings));
}

// ══ 7. A local delete never propagates (Requirement 17.10) ═════════════════

console.log('\nA local delete cannot reach the cloud');
{
  // The invariant stated at the transport level: there is no route the studio
  // could call as a side effect of a local library delete that removes a body.
  // Every destroying path needs either an explicit DELETE the user confirmed, a
  // purge that needs a tombstone first, or delete-all. A GET or a POST cannot
  // destroy anything.
  await seedTenant('user_local');
  await upload('user_local', 'wf-keep');
  const before = await BACKUPS.get(bodyKey('user_local', 'wf-keep', 1));

  // Everything the studio does on a local delete: nothing at all. Simulated by
  // exercising every non-destroying verb and confirming the body survives.
  await api('/api/backups', { token: 'user_local' });
  await api('/api/backups/wf-keep/revisions', { token: 'user_local' });
  await api('/api/backups/wf-keep/1', { token: 'user_local' });
  await upload('user_local', 'wf-keep', { ifMatch: 1 });

  check('the body is still there', (await BACKUPS.get(bodyKey('user_local', 'wf-keep', 1))) !== null, 'gone');
  check('and so is the original revision', before !== null);
  check('the metadata row survives', (await api('/api/backups', { token: 'user_local' })).body?.backups?.length === 1);
}

console.error = realConsoleError;
await mf.dispose();

console.log(failures === 0 ? '\nAll backup-route checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
