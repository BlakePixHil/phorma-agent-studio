/**
 * `/api/proposals/*` end to end (multi-organisation-phorma, Requirement 11,
 * design section 9).
 *
 * ## The claims that matter
 *
 * The feature's promise is a negative one: **an editor's change cannot move what
 * is running.** So the suite is organised around the ways it could quietly stop
 * being true, or stop being safe:
 *
 * - A creation reaching a `WorkflowAgent`, which would make a proposal a deploy.
 * - Two creations both believing they hold the pending slot, so a reviewer
 *   publishes a change that another one replaced.
 * - Two reviewers both winning a transition, which - once publish runs a push -
 *   deploys the same spec twice.
 * - A proposal body landing where a BACKUP destroy path can reach it, so
 *   somebody's delete-all silently takes out a colleague's pending change.
 * - A body stored unencrypted because no key was bound.
 * - Retention pruning the pending row, which is the one row nobody has reviewed.
 *
 * ## Harness
 *
 * The REAL router (`handleApiRequest`), a REAL local D1 with the real migrations,
 * a REAL Miniflare R2 bucket, and a locally minted RS256 JWT verified against a
 * `CLERK_JWT_KEY` PEM - `@clerk/backend`'s offline path runs in Node with no JWKS
 * fetch, so authorization is never stubbed. Same shape as
 * `backup-routes.test.mjs`.
 *
 * Two bindings are stood in for, and both stand-ins are load-bearing rather than
 * convenient:
 *
 * - `PortalIndex` is a small object answering `getDeployment`, because the live
 *   spec hash a proposal freezes comes from the deployment REGISTRY. Standing it
 *   in lets the suite drive a registry read FAILURE, which must refuse rather
 *   than freeze "nothing was deployed" for a workflow that is.
 * - `WorkflowAgent` is a Proxy that RECORDS every property read and throws. That
 *   is the whole of Property 22: if any code path from this surface reached a
 *   deployment, the recorder would name the property it touched.
 *
 * Every D1 statement goes through `withLoopbackRetryD1`, because each proxied
 * statement costs one loopback socket.
 *
 * Run: npx tsx cloud/test/proposals.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';

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
const { bodyPrefix } = await import('../src/backup-store.ts');
const { TenantStore } = await import('../src/tenants.ts');
const {
  PROPOSALS_KEPT,
  PROPOSAL_KEY_PREFIX,
  PROPOSAL_STATUSES,
  MAX_PROPOSAL_BYTES,
  SCOPE_VIOLATIONS_REPORTED,
  canonicalSpecHashOf,
  doomedProposals,
  isProposalId,
  isProposalStatus,
  isTerminalStatus,
  newProposalId,
  parseProposalBody,
  parseProposalSubmission,
  proposalBodyKey,
  proposalBodyPrefix,
  scopeViolations,
} = await import('../src/proposals.ts');
const { handleProposalRequest } = await import('../src/proposal-routes.ts');
const { WRITE_ROUTES, matchWriteRoute, requiredLevelFor } = await import('../src/role-gate.ts');
const { workflowAgentInstance } = await import('../src/portal-registry.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

/** Property runs. Every iteration costs several proxied D1 statements. */
const RUNS = 8;

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
  d1Databases: { DB: 'phorma-cloud-proposals' },
  r2Buckets: { BACKUPS: 'phorma-backups-proposals' },
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

for (const file of [
  '0001_init.sql',
  '0003_billing.sql',
  '0004_billing_ordering.sql',
  '0005_workflow_backups.sql',
  // Carries `workflow_proposals`, `idx_proposals_pending` and
  // `idx_proposals_workflow`. NO migration was added by this task: wrangler
  // records a migration as applied by FILENAME, so anything appended to an
  // applied file silently never runs.
  '0006_organisations.sql',
]) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

const tenants = new TenantStore({ DB });

// --- A real session token --------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-proposals-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

/**
 * A session token for one member of one organisation, at one level.
 *
 * The organisation and the role arrive as VERIFIED CLAIMS, which is the only way
 * they can: a request field naming either would be a "write as somebody else"
 * parameter. `org:admin` is the one mapped claim, so it short-circuits
 * `resolveRole`; every other level is read from `org_members`.
 */
const ORG_ROLE_FOR_LEVEL = { admin: 'org:admin' };
function mintOrgToken(sub, orgId, level = 'admin') {
  const role = ORG_ROLE_FOR_LEVEL[level];
  return mintToken(sub, { org_id: orgId, ...(role ? { org_role: role } : {}) });
}

async function seedMember(orgId, userId, level) {
  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(orgId, userId, level, 'user_seed', now, now)
    .run();
}

// --- Environment ----------------------------------------------------------

const KEY_ENC_SECRET = Buffer.alloc(32, 9).toString('base64');
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:7322' };
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const ORIGIN = 'https://cloud.example.com';

/**
 * The deployment registry, as `PortalIndex.getDeployment` answers it.
 *
 * Keyed `{ownerId}:{workflowId}`, exactly as the real `deploy:` key space is.
 */
const registry = new Map();
const registrySpecHash = (ownerId, workflowId) =>
  registry.get(`${ownerId}:${workflowId}`)?.specHash ?? null;

function portalIndexStub({ fail = false } = {}) {
  return {
    idFromName: name => ({ name }),
    get: () => ({
      getDeployment: async (ownerId, workflowId) => {
        if (fail) throw new Error('registry unavailable');
        return registry.get(`${ownerId}:${workflowId}`) ?? null;
      },
    }),
  };
}

/**
 * Every property read off the `WorkflowAgent` binding, recorded.
 *
 * Property 22's positive control. The proposal surface must have NO path to a
 * deployed instance, so the assertion is on this list being empty - not on a
 * source-code grep, which would pass for an indirect call.
 */
const agentTouches = [];
const workflowAgentTrap = new Proxy(
  {},
  {
    get(_target, property) {
      agentTouches.push(String(property));
      throw new Error(`The proposal surface must not reach the WorkflowAgent (read ${String(property)}).`);
    },
  },
);

function hostedEnv(extra = {}) {
  return {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    DB,
    BACKUPS,
    KEY_ENC_SECRET,
    PortalIndex: portalIndexStub(),
    WorkflowAgent: workflowAgentTrap,
    ...extra,
  };
}

/** One `/api/*` request through the real router. */
async function api(path, { method = 'GET', body, token, bearer, headers: extraHeaders, env } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (token) headers.Authorization = `Bearer ${mintToken(token)}`;
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

/** A realistically repetitive workflow spec. */
function spec(id, { name, nodes = 10, prompt = 'Summarize the input in one short paragraph.' } = {}) {
  return {
    version: 1,
    id,
    name: name ?? `Workflow ${id}`,
    savedAt: '2026-09-01T00:00:00.000Z',
    graph: {
      nodes: Array.from({ length: nodes }, (_unused, index) => ({
        id: `agent-${index}`,
        name: `Step ${index}`,
        kind: 'agent',
        category: 'flow',
        icon: 'ti ti-robot',
        position: { x: index * 220, y: 0 },
        ports: [
          { id: `agent-${index}-in`, name: 'In', role: 'message-in' },
          { id: `agent-${index}-out`, name: 'Out', role: 'message-out' },
        ],
        data: { prompt, provider: 'ollama' },
      })),
      connections: [],
    },
  };
}

function bodyFor(id, options = {}) {
  return {
    spec: spec(id, options),
    connections: options.connections ?? [],
    // The deployed spec the author was editing. Only READ when the caller is below
    // `builder`, and only once it hashes to the registry's own `specHash` - so a
    // test that seeds a registry hash must seed the hash of THIS spec or the
    // submission is refused `proposal_stale` (Requirement 12.2).
    ...(options.liveSpec ? { liveSpec: options.liveSpec } : {}),
  };
}

/** Submits one proposal. */
function propose(bearer, workflowId, options = {}) {
  return api(`/api/proposals/${workflowId}`, {
    method: 'POST',
    bearer,
    body: options.raw ?? bodyFor(options.specId ?? workflowId, options),
    env: options.env,
  });
}

/**
 * Seeds the registry with the hash of `liveSpec` and returns it, so a scope check
 * has an authenticated baseline.
 *
 * One helper because the pairing is the invariant: the registry `specHash` is what
 * makes a submitted live spec trustworthy, and seeding one without the other tests
 * the refusal rather than the feature.
 */
function seedDeployment(ownerId, workflowId, liveSpec) {
  registry.set(`${ownerId}:${workflowId}`, { specHash: canonicalSpecHashOf(liveSpec) });
  return liveSpec;
}

const rowsFor = async (ownerId, workflowId) =>
  (
    await DB.prepare(
      `SELECT id, proposal_id, status, revision, body_key, reason
         FROM workflow_proposals WHERE owner_id = ? AND workflow_id = ? ORDER BY id DESC`,
    )
      .bind(ownerId, workflowId)
      .all()
  ).results ?? [];

const objectsUnder = async prefix => {
  const listed = await BACKUPS.list({ prefix, limit: 1000 });
  return listed.objects.map(object => object.key);
};

// ══ 1. Placement, absence and the two binding refusals ═════════════════════

console.log('\nBYO sees no proposal surface at all (Requirement 11.12, Property 37)');
{
  const anonymous = await api('/api/proposals/wf-a');
  check('a hosted worker with no bearer is 401', anonymous.status === 401, JSON.stringify(anonymous.body));

  // Mounted ABOVE the `store.enabled` gate, so BYO answers 404 rather than the
  // gate's 501 "hosted bindings missing".
  for (const [label, env] of [
    ['a BYO worker', { PHORMA_MODE: 'byo', DB, BACKUPS, KEY_ENC_SECRET }],
    ['a hosted worker with no D1', { PHORMA_MODE: 'hosted', CLERK_SECRET_KEY: 'sk', CLERK_JWT_KEY, BACKUPS }],
  ]) {
    for (const [method, path, body] of [
      ['GET', '/api/proposals/wf-a', undefined],
      ['POST', '/api/proposals/wf-a', bodyFor('wf-a')],
      ['GET', '/api/proposals/wf-a/prop-x-1', undefined],
      ['POST', '/api/proposals/wf-a/prop-x-1/publish', { revision: 1 }],
      ['POST', '/api/proposals/wf-a/prop-x-1/reject', { revision: 1 }],
    ]) {
      const answer = await api(path, { method, body, token: 'user_byo', env });
      check(`${label}: ${method} ${path} is 404`, answer.status === 404, JSON.stringify(answer.body));
      // Requirement 16.6: no refusal this feature adds may name a binding a BYO
      // worker would then be told to add.
      check(
        `${label}: ${method} ${path} names no binding`,
        answer.body?.error === 'Not found.' &&
          !/KEY_ENC_SECRET|BACKUPS|D1|binding|hosted/i.test(JSON.stringify(answer.body)),
        JSON.stringify(answer.body),
      );
    }
  }
}

console.log('\nThe two operator refusals, on a HOSTED worker (Requirement 11.5)');
{
  const ORG = 'org_bindings';
  await seedMember(ORG, 'user_bind', 'builder');
  const bearer = mintOrgToken('user_bind', ORG, 'builder');

  const noKey = await propose(bearer, 'wf-nokey', {
    env: hostedEnv({ KEY_ENC_SECRET: undefined }),
  });
  check('no KEY_ENC_SECRET refuses the proposal', noKey.status === 501, JSON.stringify(noKey.body));
  check(
    'with code proposal_unencrypted',
    noKey.body?.code === 'proposal_unencrypted',
    JSON.stringify(noKey.body),
  );
  check(
    'and it states that a proposal is never stored unencrypted',
    /never stored unencrypted/.test(noKey.body?.error ?? '') &&
      /KEY_ENC_SECRET/.test(noKey.body?.error ?? ''),
    noKey.body?.error,
  );
  // The half that matters: NOTHING is stored (Requirement 11.5).
  check('no row was written', (await rowsFor(ORG, 'wf-nokey')).length === 0);
  check(
    'and no object exists under the workflow prefix',
    (await objectsUnder(proposalBodyPrefix(ORG, 'wf-nokey'))).length === 0,
  );

  const noBucket = await propose(bearer, 'wf-nobucket', { env: hostedEnv({ BACKUPS: undefined }) });
  check('no bucket refuses too', noBucket.status === 501, JSON.stringify(noBucket.body));
  check(
    'and names body storage rather than the encryption key',
    /no body storage is bound/.test(noBucket.body?.error ?? '') && noBucket.body?.code === undefined,
    JSON.stringify(noBucket.body),
  );
  check('no row was written', (await rowsFor(ORG, 'wf-nobucket')).length === 0);
}

// ══ 2. Create, and the round trip (Requirement 11.1-11.4, Property 23) ═════

console.log('\nCreating a proposal, and reading it back');
{
  const ORG = 'org_round_trip';
  const AUTHOR = 'user_round_author';
  await seedMember(ORG, AUTHOR, 'editor');
  const editor = mintOrgToken(AUTHOR, ORG, 'editor');
  const liveRound = seedDeployment(ORG, 'wf-round', spec('wf-round'));

  const created = await propose(editor, 'wf-round', {
    liveSpec: liveRound,
    connections: [
      { id: 'conn-xero', name: 'Xero (production)' },
      // Anything beyond {id, name} is DISCARDED rather than stored: this is the
      // one field of the body a secret could ride in (Requirement 11.9).
      { id: 'conn-bank', name: 'Bank feed', apiKey: 'sk-live-never-store-me', token: 'nope' },
    ],
  });
  check('an editor may propose', created.status === 200 && created.body?.ok === true, JSON.stringify(created.body));
  const proposal = created.body?.proposal;
  check('it comes back pending at revision 1', proposal?.status === 'pending' && proposal?.revision === 1, JSON.stringify(proposal));
  check('with a wire id of the minted shape', isProposalId(proposal?.proposalId), String(proposal?.proposalId));
  check('naming the AUTHOR, not the owner', proposal?.authorUserId === AUTHOR, String(proposal?.authorUserId));
  check('carrying the proposed spec hash', typeof proposal?.specHash === 'string' && proposal.specHash.length > 0);
  // Frozen at creation from the deployment REGISTRY, which is what makes the
  // staleness question answerable later without downloading a spec.
  check(
    'and the live hash frozen from the registry',
    proposal?.liveSpecHash === canonicalSpecHashOf(liveRound),
    String(proposal?.liveSpecHash),
  );
  check('the wire shape carries no rowid and no body key', proposal?.id === undefined && proposal?.bodyKey === undefined, JSON.stringify(proposal));

  // ── The key, and the isolation it buys (Requirement 11.3) ────────────────
  const key = proposalBodyKey(ORG, 'wf-round', proposal.proposalId);
  const stored = await BACKUPS.head(key);
  check('the body is stored at proposal/{owner}/{workflow}/{proposalId}', stored !== null, key);
  check('the key is under the proposal prefix', key.startsWith(PROPOSAL_KEY_PREFIX));
  check('and NOT under the backup prefix', !key.startsWith('backup/'));
  check(
    'the object declares its format and nothing about the workflow',
    stored?.customMetadata?.format === 'gzip+aes-gcm' &&
      stored?.customMetadata?.kind === 'proposal' &&
      !JSON.stringify(stored?.customMetadata ?? {}).includes('Workflow'),
    JSON.stringify(stored?.customMetadata),
  );

  // ── gzip BEFORE AES-GCM (Requirement 11.4) ──────────────────────────────
  const plaintext = JSON.stringify(bodyFor('wf-round'));
  check(
    'the stored object is smaller than the plaintext body',
    stored.size < plaintext.length,
    `${stored.size} vs ${plaintext.length}`,
  );
  const bytes = Buffer.from(await (await BACKUPS.get(key)).arrayBuffer());
  check(
    'and the prompt text is not readable in the object',
    !bytes.includes(Buffer.from('Summarize the input')),
    'plaintext found in the stored object',
  );

  // ── The read, through the route ─────────────────────────────────────────
  const read = await api(`/api/proposals/wf-round/${proposal.proposalId}`, { bearer: editor });
  check('the proposal reads back', read.status === 200, JSON.stringify(read.body?.error));
  check('with the same spec', read.body?.spec?.id === 'wf-round' && read.body?.spec?.name === 'Workflow wf-round', JSON.stringify(read.body?.spec?.id));
  check(
    'and its connections by id and name only',
    read.body?.connections?.length === 2 &&
      !JSON.stringify(read.body.connections).includes('sk-live') &&
      !JSON.stringify(read.body.connections).includes('apiKey') &&
      !JSON.stringify(read.body.connections).includes('token'),
    JSON.stringify(read.body?.connections),
  );

  const listed = await api('/api/proposals/wf-round', { bearer: editor });
  check('the list shows exactly one', listed.body?.proposals?.length === 1, JSON.stringify(listed.body));
  check('it reports how many non-pending rows are kept', listed.body?.proposalsKept === PROPOSALS_KEPT);

  const unknown = await api(`/api/proposals/wf-round/${newProposalId()}`, { bearer: editor });
  check('an unknown proposal id is 404', unknown.status === 404, JSON.stringify(unknown.body));
}

console.log('\nA missing body is 404, never 500');
{
  const ORG = 'org_missing_body';
  await seedMember(ORG, 'user_missing', 'editor');
  const editor = mintOrgToken('user_missing', ORG, 'editor');
  const created = await propose(editor, 'wf-missing');
  const id = created.body.proposal.proposalId;

  // Exactly the state a body write that failed AFTER its row landed leaves
  // behind: a pending row whose object is not there.
  await BACKUPS.delete(proposalBodyKey(ORG, 'wf-missing', id));
  const read = await api(`/api/proposals/wf-missing/${id}`, { bearer: editor });
  check('a row with no stored body reads 404', read.status === 404, `${read.status} ${JSON.stringify(read.body)}`);
  check('and says so rather than failing', /no longer has a stored body/.test(read.body?.error ?? ''), read.body?.error);
  check('the row itself survives', (await rowsFor(ORG, 'wf-missing')).length === 1);
}

// ══ 3. Shape refusals (Requirements 11.8, 11.9) ════════════════════════════

console.log('\nShape refusals, and nothing stored by any of them');
{
  const ORG = 'org_shape';
  await seedMember(ORG, 'user_shape', 'editor');
  const editor = mintOrgToken('user_shape', ORG, 'editor');

  const mismatch = await propose(editor, 'wf-path', { specId: 'wf-body' });
  check('a spec id that disagrees with the path is 400', mismatch.status === 400, JSON.stringify(mismatch.body));
  check('and the refusal names both', /wf-body/.test(mismatch.body?.error ?? ''), mismatch.body?.error);
  check('nothing was stored', (await rowsFor(ORG, 'wf-path')).length === 0);

  const noSpec = await propose(editor, 'wf-shape', { raw: { spec: null } });
  check('a body with no spec is 400', noSpec.status === 400, JSON.stringify(noSpec.body));

  const notJson = await propose(editor, 'wf-shape', { raw: 'not json at all' });
  check('an unparseable body is 400', notJson.status === 400, JSON.stringify(notJson.body));

  const wrongVersion = await propose(editor, 'wf-shape', {
    raw: { spec: { version: 2, id: 'wf-shape', name: 'n', graph: { nodes: [] } }, connections: [] },
  });
  check('a spec that is not version 1 is 400', wrongVersion.status === 400, JSON.stringify(wrongVersion.body));

  const huge = {
    spec: { ...spec('wf-big'), description: 'x'.repeat(MAX_PROPOSAL_BYTES + 1024) },
    connections: [],
  };
  const oversized = await propose(editor, 'wf-big', { raw: huge });
  check('an oversized body is 413', oversized.status === 413, JSON.stringify(oversized.body?.error));
  check('naming the limit and the arrival', oversized.body?.limitBytes === MAX_PROPOSAL_BYTES && oversized.body?.actualBytes > MAX_PROPOSAL_BYTES);
  check('nothing was stored', (await rowsFor(ORG, 'wf-big')).length === 0);
  check('and no object exists', (await objectsUnder(proposalBodyPrefix(ORG, 'wf-big'))).length === 0);

  // An encoded slash survives URL normalization and reaches the key guard.
  const encodedSlash = await api('/api/proposals/wf%2Fevil', { method: 'POST', bearer: editor, body: bodyFor('wf/evil') });
  check('an encoded slash in the workflow id is 404', encodedSlash.status === 404, JSON.stringify(encodedSlash.body));
  const colon = await api('/api/proposals/wf%3Aevil', { method: 'POST', bearer: editor, body: bodyFor('wf:evil') });
  check('a colon in the workflow id is 404', colon.status === 404, JSON.stringify(colon.body));
  const badProposalId = await api('/api/proposals/wf-shape/not-a-proposal-id', { bearer: editor });
  check('a malformed proposal id is 404', badProposalId.status === 404, JSON.stringify(badProposalId.body));
}

console.log('\nA registry read failure refuses rather than freezing a false live hash');
{
  const ORG = 'org_registry_fail';
  await seedMember(ORG, 'user_regfail', 'editor');
  const editor = mintOrgToken('user_regfail', ORG, 'editor');
  const refused = await propose(editor, 'wf-regfail', {
    env: hostedEnv({ PortalIndex: portalIndexStub({ fail: true }) }),
  });
  check('a registry failure is 502', refused.status === 502, JSON.stringify(refused.body));
  check('nothing was stored', (await rowsFor(ORG, 'wf-regfail')).length === 0);
}

// ══ 4. No path to a deployment (Requirement 11.10, Property 22) ════════════

console.log('\nCreating a proposal never reaches the WorkflowAgent');
{
  const ORG = 'org_no_agent';
  await seedMember(ORG, 'user_no_agent', 'editor');
  const editor = mintOrgToken('user_no_agent', ORG, 'editor');
  const liveNoAgent = seedDeployment(ORG, 'wf-live', spec('wf-live'));

  const before = registrySpecHash(ORG, 'wf-live');
  agentTouches.length = 0;
  const created = await propose(editor, 'wf-live', {
    liveSpec: liveNoAgent,
    prompt: 'A completely different instruction.',
  });
  check('the proposal is accepted', created.status === 200, JSON.stringify(created.body));
  // The whole of Property 22: no property of the binding was even READ. A
  // recorder rather than a grep, because an indirect call would pass a grep.
  check(
    'no property of the WorkflowAgent binding was touched',
    agentTouches.length === 0,
    agentTouches.join(', '),
  );
  check(
    "the deployed spec's registry hash is byte-identical",
    registrySpecHash(ORG, 'wf-live') === before && before === canonicalSpecHashOf(liveNoAgent),
    String(registrySpecHash(ORG, 'wf-live')),
  );

  // And the whole surface, not just creation.
  const id = created.body.proposal.proposalId;
  agentTouches.length = 0;
  await api('/api/proposals/wf-live', { bearer: editor });
  await api(`/api/proposals/wf-live/${id}`, { bearer: editor });
  await api(`/api/proposals/wf-live/${id}/reject`, { method: 'POST', bearer: editor, body: { revision: 1 } });
  check('nor by any other route on this surface', agentTouches.length === 0, agentTouches.join(', '));
}

// ══ 5. The single-pending invariant (Requirement 12.5, Property 21) ════════

console.log('\nA second proposal supersedes the first, in the same update pass');
{
  const ORG = 'org_supersede';
  await seedMember(ORG, 'user_super', 'editor');
  const editor = mintOrgToken('user_super', ORG, 'editor');

  const first = await propose(editor, 'wf-sup', { name: 'First' });
  const second = await propose(editor, 'wf-sup', { name: 'Second' });
  check('both creations are accepted', first.status === 200 && second.status === 200, `${first.status}/${second.status}`);

  const rows = await rowsFor(ORG, 'wf-sup');
  check('there are two rows', rows.length === 2, JSON.stringify(rows));
  check('exactly one is pending', rows.filter(row => row.status === 'pending').length === 1, JSON.stringify(rows));
  check('the newest one is the pending one', rows[0].proposal_id === second.body.proposal.proposalId, JSON.stringify(rows));
  // SUPERSEDED, not dropped: the displaced proposal is still readable, which is
  // what makes "your change was replaced" a statement the author can check.
  check('the displaced one is superseded', rows[1].status === 'superseded', JSON.stringify(rows));
  check('and its revision moved with the status', rows[1].revision === 2, JSON.stringify(rows));
  const displaced = await api(`/api/proposals/wf-sup/${first.body.proposal.proposalId}`, { bearer: editor });
  check('the displaced body is retained', displaced.status === 200 && displaced.body?.spec?.name === 'First', JSON.stringify(displaced.body?.error));
}

console.log('\nConcurrent creations: at most one pending at every observable read (Property 21)');
{
  const ORG = 'org_concurrent';
  await seedMember(ORG, 'user_conc', 'editor');
  const editor = mintOrgToken('user_conc', ORG, 'editor');
  let workflow = 0;

  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 }),
      async rounds => {
        workflow += 1;
        const workflowId = `wf-conc-${workflow}`;
        let accepted = 0;

        for (const concurrent of rounds) {
          const results = await Promise.all(
            Array.from({ length: concurrent }, (_unused, index) =>
              propose(editor, workflowId, { name: `Round ${workflow}-${index}` }),
            ),
          );
          const ok = results.filter(result => result.status === 200);
          const conflicts = results.filter(result => result.status === 409);
          accepted += ok.length;

          if (ok.length + conflicts.length !== results.length) {
            throw new Error(`unexpected statuses: ${results.map(r => r.status).join(',')}`);
          }
          // Somebody always wins a contended round - a batch that rolls back does
          // so because ANOTHER one committed.
          if (ok.length < 1) throw new Error('no creation won the round');
          for (const conflict of conflicts) {
            if (conflict.body?.code !== 'proposal_conflict') {
              throw new Error(`a loser answered ${JSON.stringify(conflict.body)}`);
            }
            // The CURRENT revision, so the loser retries against a truth.
            if (!(Number(conflict.body?.revision) >= 1)) {
              throw new Error(`a loser carried no revision: ${JSON.stringify(conflict.body)}`);
            }
          }

          const rows = await rowsFor(ORG, workflowId);
          const pending = rows.filter(row => row.status === 'pending');
          if (pending.length !== 1) throw new Error(`${pending.length} pending rows`);
          // Every displaced row is SUPERSEDED - never deleted, never left pending.
          if (rows.some(row => row.status !== 'pending' && row.status !== 'superseded')) {
            throw new Error(`unexpected statuses: ${rows.map(r => r.status).join(',')}`);
          }
          if (rows.length !== accepted) {
            throw new Error(`${rows.length} rows for ${accepted} accepted creations`);
          }
          // One stored body per surviving row, and no orphan.
          const objects = await objectsUnder(proposalBodyPrefix(ORG, workflowId));
          if (objects.length !== rows.length) {
            throw new Error(`${objects.length} objects for ${rows.length} rows`);
          }
        }
        return true;
      },
    ),
    { numRuns: RUNS },
  );
  check('every interleaving keeps exactly one pending proposal and loses nothing', true);
}

// ══ 6. Transitions are conditional updates (Requirements 11.6, 11.7) ═══════

console.log('\nReject: a terminal transition guarded on the revision');
{
  const ORG = 'org_reject';
  await seedMember(ORG, 'user_reject_builder', 'builder');
  await seedMember(ORG, 'user_reject_editor', 'editor');
  const builder = mintOrgToken('user_reject_builder', ORG, 'builder');
  const editor = mintOrgToken('user_reject_editor', ORG, 'editor');

  const created = await propose(editor, 'wf-rej');
  const id = created.body.proposal.proposalId;

  const noRevision = await api(`/api/proposals/wf-rej/${id}/reject`, { method: 'POST', bearer: builder, body: {} });
  check('a transition with no revision is 400', noRevision.status === 400, JSON.stringify(noRevision.body));
  check('and tells the caller the current one', noRevision.body?.revision === 1, JSON.stringify(noRevision.body));

  const badRevision = await api(`/api/proposals/wf-rej/${id}/reject`, { method: 'POST', bearer: builder, body: { revision: 'one' } });
  check('a non-integer revision is 400', badRevision.status === 400, JSON.stringify(badRevision.body));

  const stale = await api(`/api/proposals/wf-rej/${id}/reject`, { method: 'POST', bearer: builder, body: { revision: 99 } });
  check('a stale revision is 409', stale.status === 409, JSON.stringify(stale.body));
  check('with proposal_conflict and the CURRENT revision', stale.body?.code === 'proposal_conflict' && stale.body?.revision === 1, JSON.stringify(stale.body));
  check('and the proposal is untouched', (await rowsFor(ORG, 'wf-rej'))[0].status === 'pending');

  const rejected = await api(`/api/proposals/wf-rej/${id}/reject`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1, reason: '  Please keep the escalation step.  ' },
  });
  check('a matching revision is accepted', rejected.status === 200 && rejected.body?.proposal?.status === 'rejected', JSON.stringify(rejected.body));
  check('the revision moved with the status', rejected.body?.proposal?.revision === 2, JSON.stringify(rejected.body?.proposal));
  check('the reason is stored, trimmed', rejected.body?.proposal?.reason === 'Please keep the escalation step.', JSON.stringify(rejected.body?.proposal?.reason));
  // A rejected proposal keeps its body until retention prunes it: the reviewer's
  // reason is only useful beside the change it was written about.
  const retained = await api(`/api/proposals/wf-rej/${id}`, { bearer: editor });
  check('and the body is retained', retained.status === 200, JSON.stringify(retained.body?.error));

  const again = await api(`/api/proposals/wf-rej/${id}/reject`, { method: 'POST', bearer: builder, body: { revision: 2 } });
  check('a terminal row cannot transition again', again.status === 409, JSON.stringify(again.body));
  check('and the refusal names the status it is already in', again.body?.status === 'rejected' && again.body?.code === 'proposal_conflict', JSON.stringify(again.body));
  check('the stored reason survives the refused second attempt', (await rowsFor(ORG, 'wf-rej'))[0].reason === 'Please keep the escalation step.');
}

console.log('\nTwo reviewers, one winner (Requirement 11.6 - the mutation target)');
{
  // This is the property the conditional update exists for, and the one the
  // mutation check targets: replacing `UPDATE ... WHERE status = ? AND revision = ?`
  // with a read-then-write lets BOTH reviewers through, because both read
  // `pending` before either writes.
  const ORG = 'org_race';
  await seedMember(ORG, 'user_race_a', 'builder');
  await seedMember(ORG, 'user_race_b', 'builder');
  const reviewerA = mintOrgToken('user_race_a', ORG, 'builder');
  const reviewerB = mintOrgToken('user_race_b', ORG, 'builder');
  await seedMember(ORG, 'user_race_editor', 'editor');
  const editor = mintOrgToken('user_race_editor', ORG, 'editor');

  let workflow = 0;
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 3 }), async reviewers => {
      workflow += 1;
      const workflowId = `wf-race-${workflow}`;
      const created = await propose(editor, workflowId);
      const id = created.body.proposal.proposalId;
      const revision = created.body.proposal.revision;

      const tokens = [reviewerA, reviewerB, reviewerA].slice(0, reviewers);
      const results = await Promise.all(
        tokens.map(bearer =>
          api(`/api/proposals/${workflowId}/${id}/reject`, {
            method: 'POST',
            bearer,
            body: { revision },
          }),
        ),
      );
      const won = results.filter(result => result.status === 200);
      const lost = results.filter(result => result.status === 409);
      if (won.length !== 1) {
        throw new Error(`${won.length} winners: ${results.map(r => r.status).join(',')}`);
      }
      if (lost.length !== results.length - 1) {
        throw new Error(`losers answered ${results.map(r => r.status).join(',')}`);
      }
      for (const loser of lost) {
        if (loser.body?.code !== 'proposal_conflict') {
          throw new Error(`a loser answered ${JSON.stringify(loser.body)}`);
        }
        // The CURRENT revision, not the one they sent.
        if (Number(loser.body?.revision) <= revision) {
          throw new Error(`a loser was told a stale revision: ${JSON.stringify(loser.body)}`);
        }
      }
      const rows = await rowsFor(ORG, workflowId);
      if (rows.length !== 1 || rows[0].status !== 'rejected' || rows[0].revision !== revision + 1) {
        throw new Error(`the row settled at ${JSON.stringify(rows)}`);
      }
      return true;
    }),
    { numRuns: RUNS },
  );
  check('concurrent transitions produce exactly one winner and one true revision per loser', true);
}

console.log('\nPublish refuses rather than recording a deploy that did not happen');
{
  const ORG = 'org_publish';
  await seedMember(ORG, 'user_pub_builder', 'builder');
  await seedMember(ORG, 'user_pub_editor', 'editor');
  const builder = mintOrgToken('user_pub_builder', ORG, 'builder');
  const editor = mintOrgToken('user_pub_editor', ORG, 'editor');

  const created = await propose(editor, 'wf-pub');
  const id = created.body.proposal.proposalId;

  // The SEAM, driven with no performer installed - which is what `api.ts` was
  // doing before this task and what any host that binds no workflow runtime still
  // does. `handleProposalRequest` directly, because the router now installs a real
  // publisher, and a `published` status recording a deploy that never happened is
  // worse than a route saying it cannot yet.
  const seamless = await handleProposalRequest(
    new Request(`${ORIGIN}/api/proposals/wf-pub/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${builder}` },
      body: JSON.stringify({ revision: 1 }),
    }),
    hostedEnv(),
    new URL(`${ORIGIN}/api/proposals/wf-pub/${id}/publish`),
    (body, status = 200) => new Response(JSON.stringify(body), { status }),
    {},
  );
  const seamlessBody = await seamless.json();
  check('a publish with no publisher installed is 501', seamless.status === 501, JSON.stringify(seamlessBody));
  check('and says the proposal is unchanged', /still pending/.test(seamlessBody?.error ?? ''), seamlessBody?.error);
  check('the row is still pending at revision 1', (await rowsFor(ORG, 'wf-pub'))[0].status === 'pending');

  // An editor may not decide, whatever the route does next.
  const byEditor = await api(`/api/proposals/wf-pub/${id}/publish`, { method: 'POST', bearer: editor, body: { revision: 1 } });
  check('an editor cannot publish', byEditor.status === 403 && byEditor.body?.code === 'role_forbidden', JSON.stringify(byEditor.body));
  check('and the refusal names builder', byEditor.body?.required === 'builder', JSON.stringify(byEditor.body));
  const rejectByEditor = await api(`/api/proposals/wf-pub/${id}/reject`, { method: 'POST', bearer: editor, body: { revision: 1 } });
  check('nor reject', rejectByEditor.status === 403 && rejectByEditor.body?.required === 'builder', JSON.stringify(rejectByEditor.body));
}

// ══ 6b. Publish runs the ordinary push path (Requirements 12.7 - 12.9) ═════
//
// Properties 25, 28 and 29. The `WorkflowAgent` binding is a STUB namespace here
// rather than the recording trap: a publish MUST reach a deployment, which is the
// exact opposite of what section 4 pins about a creation, and the two claims are
// what make the seam worth having.

/**
 * A `WorkflowAgent` namespace that records every `acceptSpecPush` and, unless told
 * to refuse, writes the registry record a real accepted push would.
 *
 * Emulating `syncDeployment` here is not convenience: the staleness comparison
 * reads that record, so a stub that pushed without writing it would leave every
 * second publish of the same workflow looking stale.
 */
function pushableAgent(outcome = null) {
  const calls = [];
  return {
    calls,
    namespace: {
      idFromName: name => ({ name }),
      get: id => ({
        acceptSpecPush: async (ownerId, pushed) => {
          calls.push({ instance: id.name, ownerId, spec: pushed });
          if (outcome) return outcome;
          registry.set(`${ownerId}:${pushed.id}`, { specHash: canonicalSpecHashOf(pushed) });
          return { ok: true, name: pushed.name };
        },
      }),
    },
  };
}

console.log('\nA publish deploys the proposed spec and marks the row published');
{
  const ORG = 'org_pub_ok';
  await seedMember(ORG, 'user_ok_builder', 'builder');
  await seedMember(ORG, 'user_ok_editor', 'editor');
  const builder = mintOrgToken('user_ok_builder', ORG, 'builder');
  const editor = mintOrgToken('user_ok_editor', ORG, 'editor');

  const live = seedDeployment(ORG, 'wf-live-pub', spec('wf-live-pub'));
  const created = await propose(editor, 'wf-live-pub', {
    liveSpec: live,
    prompt: 'Answer in two sentences, and name the account code.',
  });
  check('the editor proposal is accepted', created.status === 200, JSON.stringify(created.body));
  const id = created.body.proposal.proposalId;

  const agent = pushableAgent();
  const published = await api(`/api/proposals/wf-live-pub/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: agent.namespace }),
  });
  check('the publish is accepted', published.status === 200, JSON.stringify(published.body));
  check('the row is published', published.body?.proposal?.status === 'published', JSON.stringify(published.body?.proposal));
  check('exactly one push was made', agent.calls.length === 1, String(agent.calls.length));
  // Property 29: the push carries the PROPOSED spec, byte for byte, through the
  // same entrance `POST /workflow` uses - so there is nothing left for a
  // "publishing differs from pushing" bug to live in.
  check(
    'it carried the proposed spec verbatim',
    canonicalSpecHashOf(agent.calls[0].spec) === created.body.proposal.specHash,
    canonicalSpecHashOf(agent.calls[0]?.spec ?? {}),
  );
  check(
    'addressed by the PERCENT-ENCODED instance name, not the raw colon form',
    agent.calls[0].instance === workflowAgentInstance(ORG, 'wf-live-pub'),
    agent.calls[0]?.instance,
  );
  check(
    'and the resolved owner was passed, never the author',
    agent.calls[0].ownerId === ORG,
    String(agent.calls[0]?.ownerId),
  );
  check(
    'the deployed hash moved to the proposed spec',
    registrySpecHash(ORG, 'wf-live-pub') === created.body.proposal.specHash,
    String(registrySpecHash(ORG, 'wf-live-pub')),
  );

  // Terminal is terminal: a published row never transitions again.
  const again = await api(`/api/proposals/wf-live-pub/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: published.body.proposal.revision },
    env: hostedEnv({ WorkflowAgent: agent.namespace }),
  });
  check('publishing it again is 409', again.status === 409, JSON.stringify(again.body));
  check('with the append-only conflict code', again.body?.code === 'proposal_conflict', JSON.stringify(again.body));
  check('and no second push was made', agent.calls.length === 1, String(agent.calls.length));
}

console.log('\nA refused push leaves the proposal pending (Requirement 12.8)');
{
  const ORG = 'org_pub_refused';
  await seedMember(ORG, 'user_ref_builder', 'builder');
  const builder = mintOrgToken('user_ref_builder', ORG, 'builder');

  const created = await propose(builder, 'wf-refused');
  const id = created.body.proposal.proposalId;

  const agent = pushableAgent({
    ok: false,
    status: 400,
    error: 'Workflow is not deployable to this worker.',
    findings: [{ severity: 'error', message: 'Local MCP server cannot run on this host.' }],
  });
  const refused = await api(`/api/proposals/wf-refused/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: agent.namespace }),
  });
  check('the refusal is forwarded with its status', refused.status === 400, JSON.stringify(refused.body));
  check(
    "and the host's own findings travel with it",
    refused.body?.findings?.[0]?.message === 'Local MCP server cannot run on this host.',
    JSON.stringify(refused.body?.findings),
  );
  const rows = await rowsFor(ORG, 'wf-refused');
  check('the row is STILL pending', rows[0].status === 'pending', JSON.stringify(rows));
  check('at its original revision', rows[0].revision === 1, JSON.stringify(rows));

  // An unreachable instance is a 502 and also leaves it pending: the two failures
  // differ in status and agree about the row, which is the part that matters.
  const thrower = {
    idFromName: name => ({ name }),
    get: () => ({
      acceptSpecPush: async () => {
        throw new Error('instance unreachable');
      },
    }),
  };
  const unreachable = await api(`/api/proposals/wf-refused/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: thrower }),
  });
  check('an unreachable instance is 502', unreachable.status === 502, JSON.stringify(unreachable.body));
  check('and the row is untouched', (await rowsFor(ORG, 'wf-refused'))[0].status === 'pending');
}

console.log('\nStaleness is decided by the registry hash (Requirement 12.9, Property 28)');
{
  const ORG = 'org_stale';
  await seedMember(ORG, 'user_stale_builder', 'builder');
  await seedMember(ORG, 'user_stale_editor', 'editor');
  const builder = mintOrgToken('user_stale_builder', ORG, 'builder');
  const editor = mintOrgToken('user_stale_editor', ORG, 'editor');

  const live = seedDeployment(ORG, 'wf-stale', spec('wf-stale'));
  const created = await propose(editor, 'wf-stale', { liveSpec: live, prompt: 'Be brief.' });
  const id = created.body.proposal.proposalId;

  // Somebody deployed something else in the meantime. Publishing now would
  // silently revert their change.
  const moved = seedDeployment(ORG, 'wf-stale', spec('wf-stale', { nodes: 12 }));
  const agent = pushableAgent();
  const stale = await api(`/api/proposals/wf-stale/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: agent.namespace }),
  });
  check('a stale publish is 409', stale.status === 409, JSON.stringify(stale.body));
  check('with code proposal_stale', stale.body?.code === 'proposal_stale', JSON.stringify(stale.body));
  check(
    'carrying the CURRENT live hash',
    stale.body?.liveSpecHash === canonicalSpecHashOf(moved),
    String(stale.body?.liveSpecHash),
  );
  check('no push was attempted', agent.calls.length === 0, String(agent.calls.length));
  check('and the row is still pending', (await rowsFor(ORG, 'wf-stale'))[0].status === 'pending');

  // The other direction of the same property: identical hashes publish.
  seedDeployment(ORG, 'wf-stale', live);
  const now = await api(`/api/proposals/wf-stale/${id}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: agent.namespace }),
  });
  check('the same proposal publishes once the live hash matches again', now.status === 200, JSON.stringify(now.body));
  check('exactly when it matched, and not before', agent.calls.length === 1, String(agent.calls.length));

  // A registry read FAILURE is not a staleness answer.
  const second = await propose(editor, 'wf-stale', {
    liveSpec: spec('wf-stale', { prompt: 'Be brief.' }),
    prompt: 'Be brief.',
  });
  check('a second proposal is accepted', second.status === 200, JSON.stringify(second.body));
  const blind = await api(`/api/proposals/wf-stale/${second.body.proposal.proposalId}/publish`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1 },
    env: hostedEnv({ WorkflowAgent: agent.namespace, PortalIndex: portalIndexStub({ fail: true }) }),
  });
  check('a registry read failure refuses 502', blind.status === 502, JSON.stringify(blind.body));
  check('and pushes nothing', agent.calls.length === 1, String(agent.calls.length));
}

console.log('\nA rejection stores the reason and keeps the body (Requirement 12.10)');
{
  const ORG = 'org_reject';
  await seedMember(ORG, 'user_rej_builder', 'builder');
  await seedMember(ORG, 'user_rej_editor', 'editor');
  const builder = mintOrgToken('user_rej_builder', ORG, 'builder');
  const editor = mintOrgToken('user_rej_editor', ORG, 'editor');

  const created = await propose(editor, 'wf-reject');
  const id = created.body.proposal.proposalId;
  const rejected = await api(`/api/proposals/wf-reject/${id}/reject`, {
    method: 'POST',
    bearer: builder,
    body: { revision: 1, reason: 'Use the shared tone of voice prompt instead.' },
  });
  check('the rejection is accepted', rejected.status === 200, JSON.stringify(rejected.body));
  check('the row is rejected', rejected.body?.proposal?.status === 'rejected');
  check(
    'and carries the reason',
    rejected.body?.proposal?.reason === 'Use the shared tone of voice prompt instead.',
    String(rejected.body?.proposal?.reason),
  );
  const read = await api(`/api/proposals/wf-reject/${id}`, { bearer: editor });
  check('the body is RETAINED for the author to revise', read.status === 200, JSON.stringify(read.body?.error));
  check('and still decrypts to their spec', read.body?.spec?.id === 'wf-reject', JSON.stringify(read.body?.spec?.id));

  // The author's feed. `outcomesForAuthor` scopes on the author, so a reviewer
  // never gets a notification about their own decision (Requirement 12.11).
  const { ProposalStore } = await import('../src/proposals.ts');
  const store = new ProposalStore({ DB });
  const mine = await store.outcomesForAuthor(ORG, 'user_rej_editor', 0);
  check('the author is notified of the decision', mine.length === 1 && mine[0].proposalId === id, JSON.stringify(mine));
  check('with the reason and a real timestamp', mine[0].reason !== null && mine[0].at > 0, JSON.stringify(mine[0]));
  const theirs = await store.outcomesForAuthor(ORG, 'user_rej_builder', 0);
  check('the reviewer is not notified of their own decision', theirs.length === 0, JSON.stringify(theirs));
  const future = await store.outcomesForAuthor(ORG, 'user_rej_editor', Date.now() + 60_000);
  check('and the cursor excludes anything older than it', future.length === 0, JSON.stringify(future));
}

// ══ 6c. Scope: an editor changes values, not structure (Property 27) ════════

console.log('\nAn editor may not change the shape of a workflow (Requirement 12.2)');
{
  const ORG = 'org_scope';
  await seedMember(ORG, 'user_scope_editor', 'editor');
  await seedMember(ORG, 'user_scope_builder', 'builder');
  const editor = mintOrgToken('user_scope_editor', ORG, 'editor');
  const builder = mintOrgToken('user_scope_builder', ORG, 'builder');

  const live = seedDeployment(ORG, 'wf-scope', spec('wf-scope', { nodes: 3 }));

  // In scope: a prompt change over the same graph.
  const inScope = await propose(editor, 'wf-scope', {
    liveSpec: live,
    nodes: 3,
    prompt: 'Summarize in one line.',
  });
  check('a prompt change is in scope', inScope.status === 200, JSON.stringify(inScope.body));

  // Out of scope: one more node.
  const structural = await propose(editor, 'wf-scope', { liveSpec: live, nodes: 4 });
  check('adding a step is refused 403', structural.status === 403, JSON.stringify(structural.body));
  check('with code proposal_scope', structural.body?.code === 'proposal_scope', JSON.stringify(structural.body));
  check(
    'and the refusal NAMES the disallowed change',
    (structural.body?.violations ?? []).some(text => text.includes('Step 3')),
    JSON.stringify(structural.body?.violations),
  );
  check(
    'it reports at most the capped number of violations, with the true count',
    (structural.body?.violations ?? []).length <= SCOPE_VIOLATIONS_REPORTED &&
      structural.body?.violationCount >= 1,
    JSON.stringify(structural.body),
  );
  const rows = await rowsFor(ORG, 'wf-scope');
  check('exactly the one in-scope proposal exists', rows.length === 1, JSON.stringify(rows));
  check('and no object was stored for the refused one', (await objectsUnder(proposalBodyPrefix(ORG, 'wf-scope'))).length === 1);

  // A BUILDER is not scope-limited: they may push the same spec outright, so
  // narrowing their proposal would be theatre.
  const byBuilder = await propose(builder, 'wf-scope', { liveSpec: live, nodes: 4 });
  check('a builder may propose a structural change', byBuilder.status === 200, JSON.stringify(byBuilder.body));

  // The baseline is AUTHENTICATED, not trusted: a live spec that does not hash to
  // the registry record cannot buy a permissive comparison.
  const forged = await propose(editor, 'wf-scope', {
    liveSpec: spec('wf-scope', { nodes: 9 }),
    nodes: 9,
  });
  check('a forged baseline is refused proposal_stale', forged.status === 409 && forged.body?.code === 'proposal_stale', JSON.stringify(forged.body));
  const omitted = await propose(editor, 'wf-scope', { nodes: 4 });
  check('and omitting the baseline fails CLOSED', omitted.status === 400, JSON.stringify(omitted.body));
  check('naming the field to send', /liveSpec/.test(omitted.body?.error ?? ''), omitted.body?.error);
}

console.log('\nscopeViolations is pure, and structure is the four named things');
{
  /** A spec with `count` agents wired into a chain. */
  const chain = (count, prompt = 'p') => {
    const base = spec('wf-pure', { nodes: count, prompt });
    base.graph.connections = Array.from({ length: Math.max(0, count - 1) }, (_unused, index) => ({
      id: `edge-${index}`,
      outputId: `agent-${index}-out`,
      inputId: `agent-${index + 1}-in`,
      kind: 'handoff',
    }));
    return base;
  };

  check('a spec never conflicts with itself', scopeViolations(chain(4), chain(4)).length === 0);
  check('nothing deployed means nothing to preserve', scopeViolations(null, chain(4)).length === 0);

  // Property: for any node count and any two prompts, a DATA-ONLY change is in
  // scope. Pinned on contents as well as emptiness, because "returns []" also
  // holds for a function that never reports anything.
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 8 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      (count, before, after) => {
        const live = chain(count, before);
        const proposed = chain(count, after);
        // Rename a node and move it too: neither is structure.
        proposed.graph.nodes[0].name = `${proposed.graph.nodes[0].name} (revised)`;
        proposed.graph.nodes[0].position = { x: 999, y: 42 };
        proposed.name = 'Renamed workflow';
        if (scopeViolations(live, proposed).length !== 0) throw new Error('data change refused');
        // And the control: removing the LAST node is structure, and the message
        // names that node.
        const removed = chain(count, after);
        const dropped = removed.graph.nodes.pop();
        const violations = scopeViolations(live, removed);
        if (count > 1 && !violations.some(text => text.includes(dropped.name))) {
          throw new Error(`removal not named: ${violations.join('; ')}`);
        }
        return true;
      },
    ),
    { numRuns: 40 },
  );
  check('a data-only change is in scope, and a removed step is named', true);

  // Each of the four structural facts, one at a time.
  const live = chain(3);
  const kindChanged = chain(3);
  kindChanged.graph.nodes[1].kind = 'data-transform';
  check(
    'a kind change on the same id is structure',
    scopeViolations(live, kindChanged).some(text => /changed from agent to data-transform/.test(text)),
    JSON.stringify(scopeViolations(live, kindChanged)),
  );

  const rewired = chain(3);
  rewired.graph.connections[0].inputId = 'agent-2-in';
  const rewiredViolations = scopeViolations(live, rewired);
  check(
    'a rewired edge is structure, both halves named',
    rewiredViolations.length === 2 &&
      rewiredViolations.some(text => text.includes('agent-0-out -> agent-1-in')) &&
      rewiredViolations.some(text => text.includes('agent-0-out -> agent-2-in')),
    JSON.stringify(rewiredViolations),
  );

  const reordered = chain(3);
  reordered.graph.nodes.reverse();
  reordered.graph.connections.reverse();
  reordered.graph.connections[0].id = 'edge-renamed';
  check(
    'reordering and re-identifying edges is NOT structure',
    scopeViolations(live, reordered).length === 0,
    JSON.stringify(scopeViolations(live, reordered)),
  );

  const withSub = chain(3);
  withSub.subWorkflows = { 'sub-a': { id: 'sub-a', name: 'Sub A', graph: chain(2).graph } };
  check(
    'a new sub-workflow is structure',
    scopeViolations(live, withSub).some(text => text.includes('sub-a')),
    JSON.stringify(scopeViolations(live, withSub)),
  );
  const subEdited = structuredClone(withSub);
  subEdited.subWorkflows['sub-a'].graph.nodes.pop();
  check(
    'and so is a change INSIDE one, named with the sub-workflow',
    scopeViolations(withSub, subEdited).some(text => text.includes('sub-workflow "sub-a"')),
    JSON.stringify(scopeViolations(withSub, subEdited)),
  );
  const subPromptOnly = structuredClone(withSub);
  subPromptOnly.subWorkflows['sub-a'].graph.nodes[0].data.prompt = 'Different instruction.';
  check(
    'while a prompt change inside one is in scope',
    scopeViolations(withSub, subPromptOnly).length === 0,
    JSON.stringify(scopeViolations(withSub, subPromptOnly)),
  );
}

console.log('\nA submission carries a live spec that is read and never stored');
{
  const submission = JSON.stringify({
    spec: spec('wf-parse'),
    connections: [{ id: 'c1', name: 'One', secret: 'nope' }],
    liveSpec: spec('wf-parse', { nodes: 2 }),
  });
  const parsed = parseProposalSubmission(submission);
  check('the live spec is read', parsed?.liveSpec?.graph?.nodes?.length === 2, String(parsed?.liveSpec?.graph?.nodes?.length));
  check('the stored body is {spec, connections} alone', JSON.stringify(Object.keys(parsed.body)) === '["spec","connections"]', JSON.stringify(Object.keys(parsed.body)));
  check('with connections narrowed', JSON.stringify(parsed.body.connections) === '[{"id":"c1","name":"One"}]', JSON.stringify(parsed.body.connections));
  check('and the stored-body reader ignores it entirely', parseProposalBody(submission).liveSpec === undefined);
}

// ══ 7. Retention (Requirement 11.11, Property 26) ══════════════════════════

console.log(`\nRetention keeps the ${PROPOSALS_KEPT} most recent non-pending rows, and never the pending one`);
{
  const ORG = 'org_retention';
  await seedMember(ORG, 'user_ret', 'editor');
  const editor = mintOrgToken('user_ret', ORG, 'editor');
  const TOTAL = PROPOSALS_KEPT + 4;

  const ids = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const created = await propose(editor, 'wf-ret', { name: `Take ${index}` });
    if (created.status !== 200) {
      check(`creation ${index} succeeded`, false, JSON.stringify(created.body));
      break;
    }
    ids.push(created.body.proposal.proposalId);
  }

  const rows = await rowsFor(ORG, 'wf-ret');
  const terminal = rows.filter(row => row.status !== 'pending');
  const pending = rows.filter(row => row.status === 'pending');
  check(`the retained non-pending count is min(n, ${PROPOSALS_KEPT})`, terminal.length === PROPOSALS_KEPT, String(terminal.length));
  check('the pending row is never pruned', pending.length === 1 && pending[0].proposal_id === ids[ids.length - 1], JSON.stringify(pending));
  // The prune orders by `id`, the rowid, and never by `created_at`: several of
  // these rows were written inside the same millisecond, so an ISO string could
  // not order them at all.
  const survivingIds = new Set(rows.map(row => row.proposal_id));
  check(
    'the survivors are the newest rows, by rowid',
    ids.slice(TOTAL - PROPOSALS_KEPT - 1).every(id => survivingIds.has(id)),
    JSON.stringify([...survivingIds]),
  );
  check(
    'and the oldest rows are gone',
    ids.slice(0, TOTAL - PROPOSALS_KEPT - 1).every(id => !survivingIds.has(id)),
    JSON.stringify(ids.slice(0, 3)),
  );

  // Every surviving row has a readable body, and every pruned one has none.
  const objects = new Set(await objectsUnder(proposalBodyPrefix(ORG, 'wf-ret')));
  check('one stored body per surviving row, and no orphan', objects.size === rows.length, `${objects.size} vs ${rows.length}`);
  let readable = 0;
  for (const row of rows) {
    const read = await api(`/api/proposals/wf-ret/${row.proposal_id}`, { bearer: editor });
    if (read.status === 200) readable += 1;
  }
  check('every surviving proposal reads back', readable === rows.length, `${readable} of ${rows.length}`);
  const prunedRead = await api(`/api/proposals/wf-ret/${ids[0]}`, { bearer: editor });
  check('a pruned proposal is 404', prunedRead.status === 404, JSON.stringify(prunedRead.body));

  // Another workflow's queue is not touched by this one's retention.
  const other = await propose(editor, 'wf-ret-other');
  check('a different workflow keeps its own queue', other.status === 200 && (await rowsFor(ORG, 'wf-ret-other')).length === 1);
}

console.log('\nThe prune decision is pure, and never selects a pending row');
{
  await fc.assert(
    fc.property(
      fc.array(fc.constantFrom('pending', 'published', 'rejected', 'superseded'), { maxLength: 30 }),
      fc.integer({ min: 0, max: 12 }),
      (statuses, keep) => {
        // Rowids ascending, and deliberately ONE `created_at` for the whole set:
        // the decision must not depend on a clock that ties.
        const rows = statuses.map((status, index) => ({ id: index + 1, status }));
        const doomed = doomedProposals(rows, keep);
        const terminal = rows.filter(row => row.status !== 'pending');

        // Three independent facts, none of them a re-implementation of the rule:
        // no pending row goes, the count is exactly the overflow, and everything
        // that goes is OLDER than everything that stays.
        if (doomed.some(row => row.status === 'pending')) return false;
        if (doomed.length !== Math.max(0, terminal.length - keep)) return false;
        const doomedIds = new Set(doomed.map(row => row.id));
        const surviving = terminal.filter(row => !doomedIds.has(row.id));
        return doomed.every(gone => surviving.every(kept => gone.id < kept.id));
      },
    ),
    { numRuns: 200 },
  );
  check('doomedProposals never prunes a pending row and always takes the oldest terminal ones', true);

  check('a keep of 0 is legal and still spares the pending row', doomedProposals([{ id: 1, status: 'pending' }, { id: 2, status: 'rejected' }], 0).length === 1);
  check('and an empty queue prunes nothing', doomedProposals([], PROPOSALS_KEPT).length === 0);
}

// ══ 8. No backup destroy path can reach a proposal (Property 24) ═══════════

console.log('\nEvery backup destroy path leaves every proposal body alone (Requirement 11.3)');
{
  const OWNER = 'user_shared_bucket';
  await tenants.upsertTenant({ id: OWNER, email: `${OWNER}@example.com`, tier: 'team', status: 'active' });
  const personal = mintToken(OWNER);

  // The same owner and the SAME workflow id on both surfaces, which is the case
  // a shared bucket has to survive.
  const proposals = [];
  for (const name of ['One', 'Two', 'Three']) {
    const created = await propose(personal, 'wf-both', { name });
    check(`a proposal named ${name} is accepted`, created.status === 200, JSON.stringify(created.body));
    proposals.push(created.body.proposal.proposalId);
  }
  const rejectId = proposals[proposals.length - 1];
  await api(`/api/proposals/wf-both/${rejectId}/reject`, { method: 'POST', bearer: personal, body: { revision: 1 } });

  // A second workflow, so the backup tombstone/purge paths have their own target.
  await propose(personal, 'wf-tomb');

  const proposalKeysBefore = (await objectsUnder(PROPOSAL_KEY_PREFIX)).filter(key => key.includes(`/${OWNER}/`));
  check('there are proposal objects to protect', proposalKeysBefore.length >= 4, String(proposalKeysBefore.length));

  // ── Backup destroy path 1: the revision prune ───────────────────────────
  for (let revision = 1; revision <= 12; revision += 1) {
    const upload = await api('/api/backups/wf-both', {
      method: 'POST',
      bearer: personal,
      headers: revision === 1 ? {} : { 'If-Match': String(revision - 1) },
      body: { spec: spec('wf-both'), connections: [] },
    });
    if (upload.status !== 200) {
      check(`backup upload ${revision} succeeded`, false, JSON.stringify(upload.body));
      break;
    }
  }
  check('the backup prune ran', (await objectsUnder(bodyPrefix(OWNER, 'wf-both'))).length === 10);

  // ── Backup destroy path 2: a tombstone purge ────────────────────────────
  await api('/api/backups/wf-tomb', {
    method: 'POST',
    bearer: personal,
    body: { spec: spec('wf-tomb'), connections: [] },
  });
  await api('/api/backups/wf-tomb', { method: 'DELETE', bearer: personal });
  const purged = await api('/api/backups/wf-tomb?purge=1', { method: 'DELETE', bearer: personal });
  check('the tombstone purge ran', purged.status === 200 && purged.body?.purged === true, JSON.stringify(purged.body));

  // ── Backup destroy path 3: the retention sweep ──────────────────────────
  await api('/api/backups/wf-both', { method: 'DELETE', bearer: personal });
  await DB.prepare(
    `UPDATE workflow_backups SET deleted_at = ? WHERE tenant_id = ? AND workflow_id = 'wf-both'`,
  )
    .bind(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), OWNER)
    .run();
  const swept = await runBackupRetention(hostedEnv());
  check('the retention sweep ran', swept.swept >= 1, JSON.stringify(swept));

  // ── Backup destroy path 4: disable and delete everything ────────────────
  const wiped = await api('/api/backups', { method: 'DELETE', bearer: personal });
  check('delete-all ran', wiped.status === 200, JSON.stringify(wiped.body));
  check('and no backup object survives it', (await objectsUnder(`backup/${OWNER}/`)).length === 0);

  // The claim. Four destroy paths, and every proposal object is still there.
  const proposalKeysAfter = (await objectsUnder(PROPOSAL_KEY_PREFIX)).filter(key => key.includes(`/${OWNER}/`));
  check(
    'every proposal body survives all four backup destroy paths',
    proposalKeysAfter.length === proposalKeysBefore.length &&
      proposalKeysBefore.every(key => proposalKeysAfter.includes(key)),
    `${proposalKeysBefore.length} -> ${proposalKeysAfter.length}`,
  );
  check(
    'and every proposal row survives',
    (await rowsFor(OWNER, 'wf-both')).length === 3 && (await rowsFor(OWNER, 'wf-tomb')).length === 1,
  );
  const stillReadable = await api(`/api/proposals/wf-both/${proposals[0]}`, { bearer: personal });
  check('a proposal whose backup was wiped still reads back', stillReadable.status === 200, JSON.stringify(stillReadable.body?.error));

  // The structural half: the two key spaces cannot overlap.
  const everyKey = await objectsUnder('');
  check(
    'no proposal key begins with the backup prefix',
    everyKey.filter(key => key.startsWith(PROPOSAL_KEY_PREFIX)).every(key => !key.startsWith('backup/')),
  );
  check(
    'and no backup key begins with the proposal prefix',
    everyKey.filter(key => key.startsWith('backup/')).every(key => !key.startsWith(PROPOSAL_KEY_PREFIX)),
  );
}

// ══ 9. Whose queue (Requirements 4.x, Property 10) ═════════════════════════

console.log('\nA proposal belongs to the resolved owner, not to its author');
{
  const ORG = 'org_queue_alpha';
  await seedMember(ORG, 'user_queue_one', 'editor');
  await seedMember(ORG, 'user_queue_two', 'builder');
  const one = mintOrgToken('user_queue_one', ORG, 'editor');
  const two = mintOrgToken('user_queue_two', ORG, 'builder');

  const created = await propose(one, 'wf-queue');
  check('a member proposes into the organisation queue', created.status === 200, JSON.stringify(created.body));
  const id = created.body.proposal.proposalId;
  check(
    'and the body lands under the ORGANISATION prefix',
    (await BACKUPS.head(proposalBodyKey(ORG, 'wf-queue', id))) !== null,
  );
  check(
    "and NOT under the author's own",
    (await BACKUPS.head(proposalBodyKey('user_queue_one', 'wf-queue', id))) === null,
  );

  const colleague = await api(`/api/proposals/wf-queue/${id}`, { bearer: two });
  check('a colleague can read it', colleague.status === 200 && colleague.body?.proposal?.proposalId === id, JSON.stringify(colleague.body?.error));

  // The same human with NO organisation claim is a different owner.
  const personal = await api('/api/proposals/wf-queue', { token: 'user_queue_one' });
  check(
    "the author's personal owner sees an empty queue",
    personal.status === 200 && personal.body?.proposals?.length === 0,
    JSON.stringify(personal.body),
  );

  // And another organisation sees nothing, including through a direct id read -
  // the only scoping is the verified owner, never a request field.
  await seedMember('org_queue_beta', 'user_queue_beta', 'admin');
  const outsiderToken = mintOrgToken('user_queue_beta', 'org_queue_beta', 'admin');
  const outsiderList = await api('/api/proposals/wf-queue', { bearer: outsiderToken });
  check("another organisation's queue is empty", outsiderList.body?.proposals?.length === 0, JSON.stringify(outsiderList.body));
  const outsiderRead = await api(`/api/proposals/wf-queue/${id}`, { bearer: outsiderToken });
  check('and it cannot read a proposal by id', outsiderRead.status === 404, JSON.stringify(outsiderRead.body));
  const outsiderReject = await api(`/api/proposals/wf-queue/${id}/reject`, { method: 'POST', bearer: outsiderToken, body: { revision: 1 } });
  check('nor reject one', outsiderReject.status === 404, JSON.stringify(outsiderReject.body));
  check('the proposal is untouched', (await rowsFor(ORG, 'wf-queue'))[0].status === 'pending');
}

// ══ 10. The write-route table answers every proposal write ════════════════

console.log('\nThe Role_Gate table answers all three proposal writes');
{
  // The levels are asserted against the real routes in `role-gate.test.mjs`; this
  // is the declaration check, so a route added here without a table entry fails
  // in the suite that owns the route rather than only in the one that owns the
  // table.
  check(
    'POST /api/proposals/{id} is declared at editor',
    requiredLevelFor('POST', '/api/proposals/wf-x') === 'editor',
    String(requiredLevelFor('POST', '/api/proposals/wf-x')),
  );
  check(
    'publish is declared at builder',
    requiredLevelFor('POST', '/api/proposals/wf-x/prop-a-1/publish') === 'builder',
    String(requiredLevelFor('POST', '/api/proposals/wf-x/prop-a-1/publish')),
  );
  check(
    'reject is declared at builder',
    requiredLevelFor('POST', '/api/proposals/wf-x/prop-a-1/reject') === 'builder',
    String(requiredLevelFor('POST', '/api/proposals/wf-x/prop-a-1/reject')),
  );
  check(
    'and a GET on the same paths is not a write',
    requiredLevelFor('GET', '/api/proposals/wf-x') === undefined,
  );
  check(
    'the table carries exactly three proposal entries',
    WRITE_ROUTES.filter(route => route.match.source.includes('proposals')).length === 3,
  );

  // The collision worth pinning: the Durable Object routes are SUFFIX anchored,
  // so `/\/publish$/` matches a proposal publish path too, and `matchWriteRoute`
  // returns the FIRST match. Both require `builder`, so the level assertion above
  // passes either way - this is what would catch a reordering that let the portal
  // entry answer for the proposal route.
  check(
    'the proposal publish path is answered by the PROPOSAL entry',
    matchWriteRoute('POST', '/api/proposals/wf-x/prop-a-1/publish')?.match.source.includes('proposals') === true,
    String(matchWriteRoute('POST', '/api/proposals/wf-x/prop-a-1/publish')?.match.source),
  );
  check(
    "and a portal publish is still answered by the portal entry",
    matchWriteRoute('POST', '/agents/workflow-agent/wf-x/publish')?.match.source === String.raw`\/publish$`,
    String(matchWriteRoute('POST', '/agents/workflow-agent/wf-x/publish')?.match.source),
  );
}

console.log('\nThe four statuses are one append-only set (Requirement 11.2)');
{
  check(
    'exactly four statuses are declared, in display order',
    JSON.stringify(PROPOSAL_STATUSES) === JSON.stringify(['pending', 'published', 'rejected', 'superseded']),
    JSON.stringify(PROPOSAL_STATUSES),
  );
  check('each one is recognised', PROPOSAL_STATUSES.every(isProposalStatus));
  for (const value of ['Pending', 'approved', 'draft', '', 1, null, undefined, 'toString']) {
    check(`${JSON.stringify(value)} is not a status`, isProposalStatus(value) === false);
  }
  check(
    'only pending is non-terminal',
    PROPOSAL_STATUSES.filter(status => !isTerminalStatus(status)).join(',') === 'pending',
  );
}

// ══ 11. The pure body parser ══════════════════════════════════════════════

console.log('\nparseProposalBody rebuilds rather than trusts');
{
  const narrowed = parseProposalBody(
    JSON.stringify({
      spec: spec('wf-parse'),
      connections: [{ id: 'c1', name: 'One', secret: 'sk-live-1', nested: { token: 'x' } }],
    }),
  );
  check('a valid body parses', narrowed !== null);
  check('connections carry id and name only', JSON.stringify(narrowed.connections) === JSON.stringify([{ id: 'c1', name: 'One' }]), JSON.stringify(narrowed.connections));
  check('a connection with no id is dropped', parseProposalBody(JSON.stringify({ spec: spec('wf-parse'), connections: [{ name: 'x' }] })).connections.length === 0);
  check('a missing name falls back to the id', parseProposalBody(JSON.stringify({ spec: spec('wf-parse'), connections: [{ id: 'c2' }] })).connections[0].name === 'c2');
  for (const [label, raw] of [
    ['a non-JSON body', 'nope'],
    ['a null body', 'null'],
    ['a spec with no graph nodes', JSON.stringify({ spec: { version: 1, id: 'a', name: 'b' } })],
    ['a spec with a numeric id', JSON.stringify({ spec: { version: 1, id: 7, name: 'b', graph: { nodes: [] } } })],
  ]) {
    check(`${label} is refused`, parseProposalBody(raw) === null);
  }

  // Distinct ids, and never a rowid on the wire.
  const minted = new Set(Array.from({ length: 200 }, () => newProposalId()));
  check('minted ids are distinct', minted.size === 200, String(minted.size));
  check('and all of the declared shape', [...minted].every(isProposalId));
}

await mf.dispose();

console.log(failures === 0 ? '\nAll proposal checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
