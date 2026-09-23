/**
 * Deployment registry coverage - the `deploy:{ownerId}:{workflowId}` key space
 * `PortalIndex` gained for cloud-workflow-backup Phase 1.
 *
 * This registry exists because a Durable Object namespace cannot be enumerated:
 * without it, the only handle on a deployed workflow is an id that lived solely
 * in the user's local IndexedDB, so a reinstall left a deployment running cron
 * and spending credits with nobody able to name it. Everything asserted here is
 * about that list staying correct and owner-scoped.
 *
 * Reached with the same Map-backed `ctx.storage` stub `portal-cleanup.test.mjs`
 * uses, so no worker and no Miniflare socket is spent on it. The last section
 * drives the real `GET /api/deployments` over that same stub, because the thing
 * under test there - which owner the read is scoped to - needs a verified identity
 * and a registry and nothing else. Authorization is not stubbed: an RSA keypair is
 * generated here and the public half handed over as `CLERK_JWT_KEY`, so
 * `@clerk/backend` verifies each session token for real on its offline path.
 *
 * Run: npx -y tsx cloud/test/deployment-registry.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { registerHooks } from 'node:module';

import fc from 'fast-check';

// `portal-registry.ts` extends `cloudflare:workers`' `DurableObject`, which Node
// cannot resolve outside workerd. Redirect it before the graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { PortalIndex, DEFAULT_DEPLOYMENT_OWNER, deploymentOwner } = await import(
  '../src/portal-registry.ts'
);
const { handleDeploymentsRequest } = await import('../src/deployments.ts');

// ── A real Clerk session token ──────────────────────────────────────────────

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An RS256 session JWT, optionally carrying organisation claims. */
function mintClerkToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-registry-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Minimal `ctx.storage`: a Map with get/put/delete/prefix-bounded list. */
function mapStorage() {
  const map = new Map();
  return {
    get: async key => map.get(key) ?? undefined,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async key => map.delete(key),
    list: async ({ prefix } = {}) => {
      const out = new Map();
      for (const [key, value] of map) {
        if (prefix === undefined || key.startsWith(prefix)) out.set(key, value);
      }
      return out;
    },
    _map: map,
  };
}

function newIndex() {
  const storage = mapStorage();
  return { index: new PortalIndex({ storage }, {}), storage };
}

function record(overrides = {}) {
  return {
    workflowId: 'wf-a',
    ownerId: 'user_1',
    workflowName: 'Invoice triage',
    deployedAt: 1_000,
    updatedAt: 1_000,
    specHash: 'hash-1',
    cronArmed: false,
    portalSlug: null,
    ...overrides,
  };
}

// ── Key shape and owner scoping ─────────────────────────────────────────────

console.log('\nDeployment registry key shape and owner scoping');
{
  const { index, storage } = newIndex();
  await index.registerDeployment(record());

  check(
    'the key is deploy:{ownerId}:{workflowId}',
    storage._map.has('deploy:user_1:wf-a'),
    [...storage._map.keys()].join(', '),
  );

  await index.registerDeployment(record({ ownerId: 'user_2', workflowId: 'wf-b' }));
  const mine = await index.listDeployments('user_1');
  check('listDeployments returns only this owner', mine.length === 1 && mine[0].workflowId === 'wf-a', JSON.stringify(mine));
  check('the other owner sees only their own', (await index.listDeployments('user_2')).length === 1);
  check('an unknown owner sees nothing', (await index.listDeployments('user_never')).length === 0);
}

{
  // The trailing colon in the scan prefix is what stops one owner id that is a
  // string prefix of another from leaking records across the boundary - the same
  // trap `{workflowId}::` exists to avoid in the workflow-state keys.
  const { index } = newIndex();
  await index.registerDeployment(record({ ownerId: 'user_a', workflowId: 'wf-1' }));
  await index.registerDeployment(record({ ownerId: 'user_ab', workflowId: 'wf-2' }));

  const shorter = await index.listDeployments('user_a');
  check(
    'a prefix owner id does not see a longer owner id\'s deployments',
    shorter.length === 1 && shorter[0].workflowId === 'wf-1',
    JSON.stringify(shorter),
  );
}

{
  // A colon in either segment could forge a key inside another owner's prefix,
  // so it is refused rather than stored and hoped about.
  const { index, storage } = newIndex();
  const bad = await index.registerDeployment(record({ workflowId: 'wf:evil' }));
  check('a workflow id containing ":" is refused', bad.ok === false, JSON.stringify(bad));
  check('nothing is stored for a refused registration', storage._map.size === 0, String(storage._map.size));
  const badOwner = await index.registerDeployment(record({ ownerId: 'user_1:extra' }));
  check('an owner id containing ":" is refused', badOwner.ok === false, JSON.stringify(badOwner));
  check('an empty owner id is refused', (await index.registerDeployment(record({ ownerId: '' }))).ok === false);
}

// ── BYO owner segment ───────────────────────────────────────────────────────

console.log('\nBYO single-tenant owner segment');
{
  check('deploymentOwner(null) is the default literal', deploymentOwner(null) === DEFAULT_DEPLOYMENT_OWNER);
  check('deploymentOwner(undefined) is the default literal', deploymentOwner(undefined) === DEFAULT_DEPLOYMENT_OWNER);
  check('deploymentOwner("") is the default literal', deploymentOwner('') === DEFAULT_DEPLOYMENT_OWNER);
  check('deploymentOwner passes a real userId through', deploymentOwner('user_9') === 'user_9');

  const { index, storage } = newIndex();
  await index.registerDeployment(record({ ownerId: deploymentOwner(null) }));
  check('a BYO record keys under "default"', storage._map.has('deploy:default:wf-a'), [...storage._map.keys()].join(', '));
  check('a BYO owner can enumerate', (await index.listDeployments(DEFAULT_DEPLOYMENT_OWNER)).length === 1);
}

// ── deployedAt preservation (Requirement 2.7) ───────────────────────────────

console.log('\ndeployedAt survives a re-push');
{
  const { index } = newIndex();
  await index.registerDeployment(record({ deployedAt: 1_000, updatedAt: 1_000 }));
  await index.registerDeployment(
    record({ deployedAt: 9_000, updatedAt: 9_000, workflowName: 'Renamed', specHash: 'hash-2' }),
  );

  const stored = await index.getDeployment('user_1', 'wf-a');
  check('deployedAt keeps the first value', stored.deployedAt === 1_000, String(stored.deployedAt));
  check('updatedAt takes the later value', stored.updatedAt === 9_000, String(stored.updatedAt));
  check('every other field takes the later value', stored.workflowName === 'Renamed' && stored.specHash === 'hash-2', JSON.stringify(stored));
}

{
  // A deregister ends the run, so the next register starts a fresh deployedAt.
  const { index } = newIndex();
  await index.registerDeployment(record({ deployedAt: 1_000 }));
  await index.deregisterDeployment('user_1', 'wf-a');
  await index.registerDeployment(record({ deployedAt: 5_000 }));
  check(
    'a re-deploy after an undeploy starts a new deployedAt',
    (await index.getDeployment('user_1', 'wf-a')).deployedAt === 5_000,
  );
}

// ── Deregister ──────────────────────────────────────────────────────────────

console.log('\nDeregister');
{
  const { index } = newIndex();
  await index.registerDeployment(record());
  await index.registerDeployment(record({ workflowId: 'wf-b' }));

  const first = await index.deregisterDeployment('user_1', 'wf-a');
  check('deregister reports the removal', first.removed === true, JSON.stringify(first));
  const second = await index.deregisterDeployment('user_1', 'wf-a');
  check('deregistering again reports no removal and does not throw', second.removed === false, JSON.stringify(second));
  check('an unknown workflow deregisters harmlessly', (await index.deregisterDeployment('user_1', 'wf-never')).removed === false);
  check('the sibling deployment survives', (await index.listDeployments('user_1')).length === 1);
  check('getDeployment on a removed record is null', (await index.getDeployment('user_1', 'wf-a')) === null);
}

// ── Namespace isolation from the two existing key spaces ────────────────────

console.log('\nDeployment keys are namespaced away from portal and session keys');
{
  const { index } = newIndex();
  await index.publish({
    slug: 'my-portal',
    workflowId: 'wf-a',
    ownerId: 'user_1',
    workflowName: 'Demo',
    mode: 'chat',
    access: 'public',
    title: 'Demo',
    fields: [],
    responderNodeId: null,
    rateLimitPerMin: 10,
    theme: 'auto',
    showBranding: true,
    tokens: [],
    publishedAt: 1,
    updatedAt: 1,
    hits: 0,
  });
  await index.addSession('wf-a', 'sess-1', 'user_1:wf-a#ssess-1');
  await index.registerDeployment(record());

  check('listDeployments returns only deployment records', (await index.listDeployments('user_1')).length === 1);
  check('the slug still resolves', (await index.resolve('my-portal')) !== null);
  check('the session is still tracked', (await index.listSessions('wf-a')).length === 1);

  await index.deregisterDeployment('user_1', 'wf-a');
  check('deregister does not touch the slug', (await index.resolve('my-portal')) !== null);
  check('deregister does not touch the session namespace', (await index.listSessions('wf-a')).length === 1);

  await index.registerDeployment(record());
  await index.unpublish('wf-a');
  check('unpublish does not touch the deployment record', (await index.listDeployments('user_1')).length === 1);
}

// ── Properties ──────────────────────────────────────────────────────────────

const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);

const arbRecord = fc.record({
  workflowId: segment,
  ownerId: segment,
  workflowName: fc.string({ maxLength: 20 }),
  deployedAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  updatedAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  specHash: fc.stringMatching(/^[0-9a-f]{1,8}$/),
  cronArmed: fc.boolean(),
  portalSlug: fc.option(fc.stringMatching(/^[a-z0-9-]{1,12}$/), { nil: null }),
});

console.log('\nProperty: register idempotence (Requirement 1.7)');
{
  // Writing the SAME record twice leaves the registry byte-identical to writing
  // it once. That is what 1.7 claims, and it is only true because `updatedAt`
  // comes from the caller rather than from `Date.now()` inside the DO - a clock
  // read here would make every second write differ.
  await fc.assert(
    fc.asyncProperty(arbRecord, async candidate => {
      const once = newIndex();
      await once.index.registerDeployment(candidate);

      const twice = newIndex();
      await twice.index.registerDeployment(candidate);
      await twice.index.registerDeployment(candidate);

      return snapshot(once.storage) === snapshot(twice.storage);
    }),
    { numRuns: 200 },
  );
  check('a repeated identical register is byte-identical to a single one', true);
}

console.log('\nProperty: final contents depend only on the last call (Requirement 1.8)');
{
  // `deployedAt` is deliberately excluded from the comparison: Requirement 2.7
  // makes it depend on the FIRST register in the current unbroken run, which is
  // the one field 1.8's wording cannot mean literally. Everything else - and
  // presence itself, which is what the property is really about - depends only
  // on the last call.
  const call = fc.oneof(
    arbRecord.map(value => ({ kind: 'register', value })),
    fc.constant({ kind: 'deregister' }),
  );

  await fc.assert(
    fc.asyncProperty(
      segment,
      segment,
      fc.array(call, { minLength: 1, maxLength: 8 }),
      async (ownerId, workflowId, calls) => {
        const scoped = calls.map(entry =>
          entry.kind === 'register'
            ? { kind: 'register', value: { ...entry.value, ownerId, workflowId } }
            : entry,
        );

        const { index } = newIndex();
        for (const entry of scoped) {
          if (entry.kind === 'register') await index.registerDeployment(entry.value);
          else await index.deregisterDeployment(ownerId, workflowId);
        }
        const actual = await index.getDeployment(ownerId, workflowId);

        const last = scoped[scoped.length - 1];
        if (last.kind === 'deregister') return actual === null;
        if (actual === null) return false;
        const { deployedAt: _ignoredActual, ...rest } = actual;
        const { deployedAt: _ignoredExpected, ...expected } = last.value;
        return JSON.stringify(rest) === JSON.stringify(expected);
      },
    ),
    { numRuns: 300 },
  );
  check('a register/deregister sequence resolves to its last call', true);
}

console.log('\nProperty: enumeration never crosses an owner boundary');
{
  await fc.assert(
    fc.asyncProperty(fc.array(arbRecord, { maxLength: 12 }), async records => {
      const { index } = newIndex();
      for (const entry of records) await index.registerDeployment(entry);

      for (const owner of new Set(records.map(entry => entry.ownerId))) {
        const listed = await index.listDeployments(owner);
        if (listed.some(entry => entry.ownerId !== owner)) return false;
      }
      return true;
    }),
    { numRuns: 200 },
  );
  check('every listDeployments row carries the requested ownerId', true);
}

// ── GET /api/deployments: the read over that key space ──────────────────────
//
// Feature: multi-organisation-phorma, Property 10: Every owner-scoped read
// returns exactly the caller's owner's set.
//
// The route is driven here rather than in a Miniflare suite because everything it
// needs is already in this file: a Map-backed `PortalIndex` and a verified
// identity. With no `DB` binding the spend columns are null, which is the answer
// Requirement 5.5 wants on a worker with no ledger, so no D1 and no loopback
// socket is spent to assert the scoping.

console.log('\nGET /api/deployments lists exactly the resolved owner (Requirement 4.4)');
{
  const ORG = 'org_reg_alpha';
  const MEMBER = 'user_reg_member';

  /** Drives the real route against a Map-backed registry. */
  async function listDeploymentsRoute({ records, token, env: extraEnv = {} }) {
    const { index } = newIndex();
    for (const entry of records) await index.registerDeployment(entry);
    const url = new URL('https://worker.example/api/deployments');
    const response = await handleDeploymentsRequest(
      new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      {
        PortalIndex: { idFromName: () => ({}), get: () => index },
        PHORMA_MODE: 'hosted',
        CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
        CLERK_JWT_KEY,
        ...extraEnv,
      },
      url,
      (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    return { status: response.status, body: await response.json() };
  }

  const records = [
    record({ ownerId: ORG, workflowId: 'wf-org-1', workflowName: 'Shared triage' }),
    record({ ownerId: ORG, workflowId: 'wf-org-2', workflowName: 'Shared payroll' }),
    record({ ownerId: MEMBER, workflowId: 'wf-personal' }),
    record({ ownerId: 'org_reg_beta', workflowId: 'wf-beta' }),
  ];

  const asMember = await listDeploymentsRoute({
    records,
    token: mintClerkToken(MEMBER, { org_id: ORG, org_role: 'org:admin' }),
  });
  check('a member of the organisation is answered', asMember.status === 200, String(asMember.status));
  // Both directions, because only one of them is a leak: the organisation's set is
  // complete, AND nothing outside it is present. A route scoped by `auth.userId`
  // would answer an EMPTY list here - no leak, and no deployments either, which
  // reads as "you have deployed nothing" about workflows that are running cron.
  check(
    'it lists exactly the organisation\'s deployments',
    asMember.body.deployments.map(entry => entry.workflowId).sort().join(',') ===
      'wf-org-1,wf-org-2',
    JSON.stringify(asMember.body.deployments.map(entry => entry.workflowId)),
  );

  // The SAME human's personal credential is a different owner, not a subset.
  const asPerson = await listDeploymentsRoute({ records, token: mintClerkToken(MEMBER) });
  check(
    'the same account with no organisation claim lists only its own',
    asPerson.body.deployments.map(entry => entry.workflowId).join(',') === 'wf-personal',
    JSON.stringify(asPerson.body.deployments.map(entry => entry.workflowId)),
  );

  // Property 37: BYO is byte-identical. No credential at all, one owner, and the
  // records live under the `default` literal exactly as they did before.
  const byo = await listDeploymentsRoute({
    records: [
      record({ ownerId: DEFAULT_DEPLOYMENT_OWNER, workflowId: 'wf-byo' }),
      record({ ownerId: ORG, workflowId: 'wf-org-1' }),
    ],
    token: null,
    env: { PHORMA_MODE: undefined, CLERK_SECRET_KEY: undefined, CLERK_JWT_KEY: undefined },
  });
  check('an open BYO worker answers with no credential', byo.status === 200, String(byo.status));
  check(
    'and lists the single default owner\'s deployments',
    byo.body.deployments.map(entry => entry.workflowId).join(',') === 'wf-byo',
    JSON.stringify(byo.body.deployments.map(entry => entry.workflowId)),
  );
  // "Cannot tell" and "spent nothing" stay distinguishable: no D1 means null.
  check(
    'a worker with no ledger reports null spend rather than zero',
    byo.body.deployments[0].creditsSpent === null && byo.body.deployments[0].runsThisMonth === null,
    JSON.stringify(byo.body.deployments[0]),
  );
}

/** Stable serialization of the whole store, for byte-identity comparisons. */
function snapshot(storage) {
  return JSON.stringify([...storage._map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

console.log(
  failures === 0 ? '\nAll deployment-registry checks passed.' : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
