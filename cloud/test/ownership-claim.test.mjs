/**
 * The ownership claim path - `cloud/src/ownership-claim.ts` and
 * `WorkflowAgent.claimOwnership` (multi-organisation-phorma task 2,
 * Requirements 3.1 to 3.12, 4.7, 16.2, 18.5, 18.6).
 *
 * ## What is at stake
 *
 * A claim moves one deployment's owner across three independent stores: a Durable
 * Object state row, the `deploy:` registry in `PortalIndex`, and two D1 tables. A
 * claim that half-applies is worse than one that refuses, because the deployment is
 * then addressable by nobody and its billing rows point at the wrong tenant. So the
 * refusals are asserted to change NOTHING, and the acceptance is asserted to change
 * everything at once.
 *
 * ## The five claims this suite makes
 *
 * 1. **The preconditions are a CONJUNCTION** (Property 7): `builder` or above in
 *    the new owner AND the acting user equals the stamped owner. Each half is
 *    driven separately, and each refusal leaves the stamp, the registry and every
 *    D1 row untouched.
 * 2. **The replace is atomic and repeats are free** (Property 8). Concurrent
 *    claims are fired at one instance and exactly one of them reports a move;
 *    every observed read of the stamp returns exactly one owner.
 * 3. **Every row moves and no object is rewritten** (Property 9). The R2 key set
 *    is compared byte-for-byte before and after, and the body is read back through
 *    the real `JSON -> gzip -> AES-GCM` pipeline at its ORIGINAL key.
 * 4. **`claim_conflict` refuses BEFORE anything changes** (Requirement 3.11).
 * 5. **BYO answers a flat 404**, never the 501 the `store.enabled` gate produces,
 *    so no refusal names a binding a BYO worker would have to add
 *    (Requirements 3.10, 16.6).
 *
 * ## Harness
 *
 * The deploy bundle under Miniflare with real SQLite Durable Objects, real D1 with
 * the real migrations, a real R2 bucket, and locally minted RS256 session tokens
 * verified by `@clerk/backend`'s offline path - so the gateway,
 * `routeApiRequest`, `requireCapability`, the instance and every store are all
 * genuinely in the path. A harness module adds two read-only probes: the stamp, via
 * the `notificationsSince` RPC, and the raw `deploy:` registry, read directly rather
 * than through `GET /api/deployments` so that what a claim did to the key space is
 * asserted without a route's own owner resolution in the way.
 *
 * Levels come from `org_members`, not from a role claim, because that is the
 * authoritative source and the one a desktop credential would use.
 *
 * ## A gap this suite records rather than papers over
 *
 * A Durable Object's name is fixed at creation. A claimed deployment keeps living
 * at `{actingUserId}:{workflowId}` while its stamp becomes the organisation, so the
 * ORGANISATION's members - who address `{orgId}:{workflowId}` through the gateway -
 * reach a different, blank instance. The claim moves ownership correctly and every
 * assertion below holds; what is missing is a way for the new owner to ADDRESS what
 * they now own. That needs a design decision (an addressing alias, or an
 * instance-name scheme that is not owner-derived) and is deliberately not invented
 * here.
 *
 * Run: npx tsx cloud/test/ownership-claim.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetry, withLoopbackRetryD1 } from './miniflare-loopback.mjs';

import { BackupBodyStore, bodyPrefix } from '../src/backup-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(here, '..');
const migrations = join(cloudRoot, 'migrations');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── The harness module ──────────────────────────────────────────────────────

const HARNESS = `
import worker from './worker.mjs';
export { WorkflowAgent, PortalIndex, SecretVault } from './worker.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The STAMP, read without the gateway in the path. \`notificationsSince\`
    // re-checks the owner against the stamp and throws on a mismatch, so it answers
    // "who owns this instance" without an accessor existing for it.
    if (url.pathname === '/__t/stamp') {
      const name = url.searchParams.get('name') ?? '';
      const owner = url.searchParams.get('owner') ?? '';
      const stub = env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name));
      try {
        await stub.notificationsSince(owner, 0);
        return json({ owns: true });
      } catch (error) {
        return json({ owns: false, error: String(error?.message ?? error) });
      }
    }

    // The raw \`deploy:\` registry. \`GET /api/deployments\` still scopes on
    // \`auth.userId\` rather than the resolved owner until task 3, so it would answer
    // an empty list here for a reason unrelated to the claim.
    if (url.pathname === '/__t/registry') {
      const stub = env.PortalIndex.get(env.PortalIndex.idFromName('portal-index'));
      return json({ records: await stub.listDeployments(url.searchParams.get('owner') ?? '') });
    }

    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
`;

// ── Identities ──────────────────────────────────────────────────────────────

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-claim-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

/** The human who deployed personally before the pivot and now claims. */
const ACTOR = 'user_claim_actor';
/** A colleague with too little capability to claim into the organisation. */
const COLLEAGUE = 'user_claim_colleague';
const ORG = 'org_claim_alpha';
/** A second organisation, used to reach `claim_not_owner` on a claimed instance. */
const ORG_OTHER = 'org_claim_beta';

/** No organisation claim: the pre-pivot credential that deployed the workflow. */
const ACTOR_PERSONAL = mintToken(ACTOR);
/** The same human inside the organisation. Level comes from `org_members`. */
const ACTOR_IN_ORG = mintToken(ACTOR, { org_id: ORG });
const ACTOR_IN_ORG_OTHER = mintToken(ACTOR, { org_id: ORG_OTHER });
const COLLEAGUE_IN_ORG = mintToken(COLLEAGUE, { org_id: ORG });

/**
 * The Durable Object name the gateway gives one owner's instance.
 *
 * PERCENT-ENCODED: the gateway writes `encodeURIComponent(owner:workflowId)` into
 * the path and partyserver hashes the segment it finds there without decoding it.
 * `organisation-isolation.test.mjs` proves that against the addressing log; here it
 * is used to read the stamp of the instance the claim route targets.
 */
const instanceOf = (ownerId, workflowId) => encodeURIComponent(`${ownerId}:${workflowId}`);

// ── Build the exact deploy bundle, then run it under Miniflare ──────────────

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-ownership-claim-'));
let script;
try {
  execFileSync(process.execPath, [wranglerBin, 'deploy', '--dry-run', '--outdir', bundleDir], {
    cwd: cloudRoot,
    stdio: 'pipe',
  });
  script = readFileSync(join(bundleDir, 'index.js'), 'utf8');
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}

const KEY_ENC_SECRET = Buffer.alloc(32, 17).toString('base64');

const DURABLE_OBJECTS = {
  WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
  PortalIndex: { className: 'PortalIndex', useSQLite: true },
  SecretVault: { className: 'SecretVault', useSQLite: true },
};

function worker(bindings, { d1, r2 } = {}) {
  return withLoopbackRetry(
    new Miniflare({
      modulesRoot: cloudRoot,
      modules: [
        { type: 'ESModule', path: join(cloudRoot, 'harness.mjs'), contents: HARNESS },
        { type: 'ESModule', path: join(cloudRoot, 'worker.mjs'), contents: script },
      ],
      compatibilityDate: '2025-05-01',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: DURABLE_OBJECTS,
      ...(d1 ? { d1Databases: { DB: d1 } } : {}),
      ...(r2 ? { r2Buckets: { BACKUPS: r2 } } : {}),
      bindings,
    }),
  );
}

const mf = worker(
  {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    KEY_ENC_SECRET,
  },
  { d1: 'phorma-cloud-ownership-claim', r2: 'phorma-claim-backups' },
);

/**
 * Splits a migration into statements. Split on `/\r?\n/`, never `'\n'`: a CRLF
 * checkout leaves each line ending in `\r`, the `--` stripper then matches nothing,
 * and the comment-only tail reaches D1 as "SQL code did not contain a statement".
 */
function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

/** A minimal deployable spec. One manual trigger, nothing that needs a model. */
function spec(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'trigger',
          name: 'trigger',
          kind: 'manual-trigger',
          category: 'trigger',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: 'trigger-out', name: 'Out', role: 'message-out' }],
          data: {},
        },
      ],
      connections: [],
    },
  };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));
  const BACKUPS = await mf.getR2Bucket('BACKUPS');
  const bodies = new BackupBodyStore({ BACKUPS, KEY_ENC_SECRET });

  for (const file of [
    '0001_init.sql',
    '0003_billing.sql',
    '0004_billing_ordering.sql',
    '0005_workflow_backups.sql',
    '0006_organisations.sql',
  ]) {
    for (const statement of statementsOf(file)) await DB.prepare(statement).run();
  }

  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare('DELETE FROM org_members'),
    DB.prepare(
      `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ORG, ACTOR, 'builder', 'user_claim_seed', now, now),
    DB.prepare(
      `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ORG, COLLEAGUE, 'editor', 'user_claim_seed', now, now),
    DB.prepare(
      `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ORG_OTHER, ACTOR, 'admin', 'user_claim_seed', now, now),
  ]);

  const AGENT = '/agents/workflow-agent';

  async function call(path, { token, method = 'GET', body } = {}) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const claimAs = (token, workflowId) =>
    call(`/api/deployments/${workflowId}/claim`, { token, method: 'POST' });

  /** True when `owner` is the instance's stamped owner. */
  async function owns(instanceName, owner) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/stamp?name=${encodeURIComponent(instanceName)}&owner=${encodeURIComponent(owner)}`,
    );
    return (await response.json()).owns === true;
  }

  async function registryFor(owner) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/registry?owner=${encodeURIComponent(owner)}`,
    );
    return ((await response.json()).records ?? []).map(record => record.workflowId);
  }

  /** Every `backup/` key in the bucket, sorted, so a key SET can be compared. */
  async function backupKeys() {
    const listed = await BACKUPS.list({ prefix: 'backup/', limit: 1000 });
    return listed.objects.map(object => object.key).sort();
  }

  async function backupRow(tenantId, workflowId) {
    return DB.prepare(
      `SELECT tenant_id, workflow_id, body_key, revision FROM workflow_backups
        WHERE tenant_id = ? AND workflow_id = ?`,
    )
      .bind(tenantId, workflowId)
      .first();
  }

  async function usageOwners(workflowId) {
    const rows = await DB.prepare(
      `SELECT tenant_id, COUNT(*) AS n FROM usage WHERE workflow_id = ? GROUP BY tenant_id`,
    )
      .bind(workflowId)
      .all();
    return Object.fromEntries((rows.results ?? []).map(row => [row.tenant_id, Number(row.n)]));
  }

  async function auditRows(workflowId) {
    const rows = await DB.prepare(
      `SELECT workflow_id, previous_owner_id, new_owner_id, acting_user_id, at
         FROM ownership_claims WHERE workflow_id = ? ORDER BY id`,
    )
      .bind(workflowId)
      .all();
    return rows.results ?? [];
  }

  /** Seeds the D1 and R2 state a pre-pivot personal deployment would have. */
  async function seedBillingState(tenantId, workflowId, runIds) {
    await DB.batch([
      DB.prepare(
        `INSERT OR REPLACE INTO workflow_backups
           (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at, body_key)
         VALUES (?, ?, ?, 1, 'hash-seed', 128, ?, ?, NULL, NULL)`,
      ).bind(tenantId, workflowId, 'Claimed workflow', now, now),
      ...runIds.map(runId =>
        DB.prepare(
          `INSERT INTO usage (tenant_id, run_id, workflow_id, month, cost_usd, tokens_in, tokens_out, duration_ms, created_at)
           VALUES (?, ?, ?, '2026-09', 0.25, 10, 20, 100, ?)`,
        ).bind(tenantId, runId, workflowId, now),
      ),
    ]);
    // The body goes in through the real pipeline, so "still readable at its original
    // key" below is a real decryption rather than a byte comparison.
    await bodies.put(
      bodyPrefix(tenantId, workflowId),
      1,
      JSON.stringify({ spec: spec(workflowId, 'Claimed workflow'), connections: [] }),
    );
  }

  // ══ 1. claim_unowned: a workflow id nobody deployed ════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 7: An ownership claim is accepted
  // exactly on the conjunction of its two preconditions.
  console.log('\nclaim_unowned (Requirement 3.4)');
  {
    const refused = await claimAs(ACTOR_IN_ORG, 'wf-claim-nothing');
    check('an unowned instance is refused 409', refused.status === 409, String(refused.status));
    check(
      'with code claim_unowned, so a claim never adopts an unstamped instance',
      refused.body?.code === 'claim_unowned',
      JSON.stringify(refused.body),
    );
    check('and nothing is registered under the organisation', (await registryFor(ORG)).length === 0);
    check('and no audit row exists', (await auditRows('wf-claim-nothing')).length === 0);
  }

  // ══ 2. The level half of the conjunction ═══════════════════════════════════
  console.log('\nThe capability half of the precondition (Requirement 3.2)');
  {
    const pushed = await call(`${AGENT}/wf-claim-level/workflow`, {
      token: ACTOR_PERSONAL,
      method: 'POST',
      body: spec('wf-claim-level', 'Level probe'),
    });
    check('the pre-pivot deployment exists', pushed.status === 200, JSON.stringify(pushed.body));

    // An `editor` in the organisation. The stamp is not theirs either, so this also
    // pins the ORDER: the capability refusal comes first, and it never tells a
    // caller below `builder` anything about the instance.
    const refused = await claimAs(COLLEAGUE_IN_ORG, 'wf-claim-level');
    check('an editor is refused 403', refused.status === 403, String(refused.status));
    check(
      'with role_forbidden naming builder',
      refused.body?.code === 'role_forbidden' && refused.body?.required === 'builder',
      JSON.stringify(refused.body),
    );
    check(
      'and the stamp is untouched',
      await owns(instanceOf(ACTOR, 'wf-claim-level'), ACTOR),
      'the personal owner no longer owns it',
    );
    check('and nothing moved into the organisation', (await registryFor(ORG)).length === 0);
    check('and no audit row exists', (await auditRows('wf-claim-level')).length === 0);
  }

  // ══ 3. claim_conflict, before anything changes ═════════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 7: An ownership claim is accepted
  // exactly on the conjunction of its two preconditions.
  console.log('\nclaim_conflict (Requirement 3.11)');
  {
    const workflowId = 'wf-claim-clash';
    const pushed = await call(`${AGENT}/${workflowId}/workflow`, {
      token: ACTOR_PERSONAL,
      method: 'POST',
      body: spec(workflowId, 'Clashing workflow'),
    });
    check('the deployment exists', pushed.status === 200, String(pushed.status));

    // BOTH owners hold a backup row for this id, which is what `workflow_backups`'
    // primary key would refuse mid-transfer.
    await seedBillingState(ACTOR, workflowId, ['cloudrun-clash-1']);
    await DB.prepare(
      `INSERT OR REPLACE INTO workflow_backups
         (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at, body_key)
       VALUES (?, ?, 'Organisation copy', 4, 'hash-org', 256, ?, ?, NULL, NULL)`,
    )
      .bind(ORG, workflowId, now, now)
      .run();

    const keysBefore = await backupKeys();
    const refused = await claimAs(ACTOR_IN_ORG, workflowId);
    check('a colliding claim is refused 409', refused.status === 409, String(refused.status));
    check(
      'with code claim_conflict',
      refused.body?.code === 'claim_conflict',
      JSON.stringify(refused.body),
    );
    check(
      'the stamp is unchanged, so nothing half-applied',
      await owns(instanceOf(ACTOR, workflowId), ACTOR),
    );
    check(
      "the acting user's backup row is still theirs",
      (await backupRow(ACTOR, workflowId)) !== null,
    );
    check(
      "the organisation's own row is untouched",
      (await backupRow(ORG, workflowId))?.revision === 4,
    );
    check(
      'the usage rows did not move',
      JSON.stringify(await usageOwners(workflowId)) === JSON.stringify({ [ACTOR]: 1 }),
      JSON.stringify(await usageOwners(workflowId)),
    );
    check('no R2 object was touched', JSON.stringify(await backupKeys()) === JSON.stringify(keysBefore));
    check('and no audit row exists', (await auditRows(workflowId)).length === 0);
  }

  // ══ 4. An accepted claim moves everything, and rewrites no object ══════════
  //
  // Feature: multi-organisation-phorma, Property 9: A claim moves every row and
  // rewrites no object.
  const CLAIMED = 'wf-claim-move';
  console.log('\nAn accepted claim (Requirements 3.1, 3.5, 3.6, 3.7, 3.9, 4.7)');
  {
    const pushed = await call(`${AGENT}/${CLAIMED}/workflow`, {
      token: ACTOR_PERSONAL,
      method: 'POST',
      body: spec(CLAIMED, 'Moving workflow'),
    });
    check('the pre-pivot deployment exists', pushed.status === 200, String(pushed.status));
    check(
      'and is registered under the personal owner',
      (await registryFor(ACTOR)).includes(CLAIMED),
      JSON.stringify(await registryFor(ACTOR)),
    );

    await seedBillingState(ACTOR, CLAIMED, [
      'cloudrun-move-1',
      'cloudrun-move-2',
      'cloudrun-move-3',
    ]);
    const keysBefore = await backupKeys();
    const bodyBefore = await bodies.get(bodyPrefix(ACTOR, CLAIMED), 1);
    check('the seeded body reads back', typeof bodyBefore === 'string' && bodyBefore.length > 0);

    // The socket that WILL be refused after the claim, opened and admitted first, so
    // the assertion further down has a positive control taken on the same instance
    // with the same token.
    const beforeSocket = await mf.dispatchFetch(
      `http://localhost${AGENT}/${CLAIMED}?token=${ACTOR_PERSONAL}`,
      { headers: { Upgrade: 'websocket' } },
    );
    let beforeSynced = false;
    if (beforeSocket.webSocket) {
      const messages = [];
      beforeSocket.webSocket.addEventListener('message', event =>
        messages.push(String(event.data ?? '')),
      );
      beforeSocket.webSocket.accept();
      await settle(500);
      beforeSynced = messages.some(message => message.includes('monitor-synced'));
      try {
        beforeSocket.webSocket.close();
      } catch {
        // Already closed by the worker.
      }
    }
    check('a monitor socket is admitted BEFORE the claim', beforeSynced === true);

    const accepted = await claimAs(ACTOR_IN_ORG, CLAIMED);
    check('the claim succeeds', accepted.status === 200, JSON.stringify(accepted.body));
    check('and reports a real move', accepted.body?.alreadyOwned === false, JSON.stringify(accepted.body));
    check(
      'naming both owners',
      accepted.body?.previousOwnerId === ACTOR && accepted.body?.newOwnerId === ORG,
      JSON.stringify(accepted.body),
    );

    // The stamp: exactly one owner, and it is the new one.
    check('the organisation owns the instance', await owns(instanceOf(ACTOR, CLAIMED), ORG));
    check(
      'and the previous owner no longer does',
      !(await owns(instanceOf(ACTOR, CLAIMED), ACTOR)),
    );

    // The registry: written under the new owner first, removed from the old second.
    check(
      'the registry record is under the organisation',
      (await registryFor(ORG)).includes(CLAIMED),
      JSON.stringify(await registryFor(ORG)),
    );
    check(
      'and gone from the personal owner',
      !(await registryFor(ACTOR)).includes(CLAIMED),
      JSON.stringify(await registryFor(ACTOR)),
    );

    // D1: every row moved, none to any other owner, and the count is unchanged.
    check('the backup row moved', (await backupRow(ORG, CLAIMED)) !== null);
    check('and is gone from the previous owner', (await backupRow(ACTOR, CLAIMED)) === null);
    check(
      'the usage rows all moved, and the count is unchanged',
      JSON.stringify(await usageOwners(CLAIMED)) === JSON.stringify({ [ORG]: 3 }),
      JSON.stringify(await usageOwners(CLAIMED)),
    );
    check('the response counts what it moved', accepted.body?.usageRowsMoved === 3 && accepted.body?.backupsMoved === 1, JSON.stringify(accepted.body));

    // R2: byte-identical key set, and the body still readable at its ORIGINAL key.
    check(
      'the R2 key set is byte-identical',
      JSON.stringify(await backupKeys()) === JSON.stringify(keysBefore),
      JSON.stringify(await backupKeys()),
    );
    const moved = await backupRow(ORG, CLAIMED);
    check(
      'and body_key was frozen to the prefix that was in force',
      moved?.body_key === bodyPrefix(ACTOR, CLAIMED),
      String(moved?.body_key),
    );
    check(
      'so the body is still readable at its original key',
      (await bodies.get(moved.body_key, 1)) === bodyBefore,
    );
    // The failure the frozen prefix exists to prevent.
    check(
      'while deriving from the new owner would have found nothing',
      (await bodies.get(bodyPrefix(ORG, CLAIMED), 1)) === null,
    );

    // The audit row: exactly one, with the claim's inputs.
    const audit = await auditRows(CLAIMED);
    check('exactly one audit row', audit.length === 1, JSON.stringify(audit));
    check(
      'carrying both owners and the acting user',
      audit[0]?.previous_owner_id === ACTOR &&
        audit[0]?.new_owner_id === ORG &&
        audit[0]?.acting_user_id === ACTOR,
      JSON.stringify(audit[0]),
    );
    check('and a timestamp', typeof audit[0]?.at === 'string' && audit[0].at.length >= 20);
  }

  // ══ 5. The instance refuses its FORMER owner, alone ════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 4: A foreign organisation's
  // instance is unreachable, and the instance refuses alone.
  //
  // The gateway ADMITS this request - the instance name carries the caller's own
  // prefix, which is exactly what it checks - so the 403 can only have come from
  // `enforceOwnership`. The same request was 200 before the claim.
  console.log('\nAfter the claim, the former owner is refused by the instance (Requirement 2.4)');
  {
    const read = await call(`${AGENT}/${CLAIMED}/workflow`, { token: ACTOR_PERSONAL });
    check('a read by the former owner is 403', read.status === 403, String(read.status));
    check(
      'and it is the ownership refusal, not a capability one',
      /another account/i.test(read.body?.error ?? '') && read.body?.code === undefined,
      JSON.stringify(read.body),
    );

    // The monitor socket, which the studio would reconnect. It still upgrades - that
    // is the SDK - and the enforcement is that it is never ADMITTED, so no control
    // frame it sends is ever dispatched. There is deliberately no assertion on a
    // close code: measured against this same bundle, a `close(4001)` from
    // `onConnect` is not delivered and the client socket stays at `readyState === 1`.
    const refusedSocket = await mf.dispatchFetch(
      `http://localhost${AGENT}/${CLAIMED}?token=${ACTOR_PERSONAL}`,
      { headers: { Upgrade: 'websocket' } },
    );
    check('the upgrade still returns a socket', Boolean(refusedSocket.webSocket));
    if (refusedSocket.webSocket) {
      const messages = [];
      refusedSocket.webSocket.addEventListener('message', event =>
        messages.push(String(event.data ?? '')),
      );
      refusedSocket.webSocket.accept();
      refusedSocket.webSocket.send(JSON.stringify({ type: 'trigger', input: 'from a former owner' }));
      await settle(1200);
      check(
        'but it is never synced, so it was never admitted',
        !messages.some(message => message.includes('monitor-synced')),
        messages.join(' | ').slice(0, 200),
      );
      // And its `trigger` frame started nothing: the new owner's notification feed
      // reports no run and no pending gate.
      const feed = await mf.dispatchFetch(
        `http://localhost/__t/stamp?name=${encodeURIComponent(instanceOf(ACTOR, CLAIMED))}&owner=${encodeURIComponent(ORG)}`,
      );
      check('and the instance is still owned by the organisation', (await feed.json()).owns === true);
    }
  }

  // ══ 6. Repeats are free, and concurrent claims pick one winner ═════════════
  //
  // Feature: multi-organisation-phorma, Property 8: A claim replaces exactly one
  // owner, atomically, and repeats are free.
  console.log('\nRepeat and concurrent claims (Requirement 3.8)');
  {
    const repeat = await claimAs(ACTOR_IN_ORG, CLAIMED);
    check('a repeat claim is a success', repeat.status === 200, JSON.stringify(repeat.body));
    check('reported as already owned', repeat.body?.alreadyOwned === true, JSON.stringify(repeat.body));
    check('with no second audit row', (await auditRows(CLAIMED)).length === 1);
    check('and nothing moved', repeat.body?.usageRowsMoved === 0 && repeat.body?.backupsMoved === 0, JSON.stringify(repeat.body));
    check('the stamp still reads exactly one owner', await owns(instanceOf(ACTOR, CLAIMED), ORG));
    check(
      'and still refuses the former owner',
      !(await owns(instanceOf(ACTOR, CLAIMED), ACTOR)),
    );

    // Concurrency, on a fresh deployment: five claims at once, one winner.
    const raced = 'wf-claim-race';
    const pushed = await call(`${AGENT}/${raced}/workflow`, {
      token: ACTOR_PERSONAL,
      method: 'POST',
      body: spec(raced, 'Raced workflow'),
    });
    check('a deployment to race on exists', pushed.status === 200, String(pushed.status));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimAs(ACTOR_IN_ORG, raced)),
    );
    check(
      'every concurrent claim answers 200',
      results.every(result => result.status === 200),
      JSON.stringify(results.map(result => [result.status, result.body?.code])),
    );
    check(
      'exactly one of them reports the move',
      results.filter(result => result.body?.alreadyOwned === false).length === 1,
      JSON.stringify(results.map(result => result.body?.alreadyOwned)),
    );
    check('and exactly one audit row exists', (await auditRows(raced)).length === 1);
    check('the stamp reads exactly one owner', await owns(instanceOf(ACTOR, raced), ORG));
    check('never two', !(await owns(instanceOf(ACTOR, raced), ACTOR)));
    check(
      'and the registry holds one record for it',
      (await registryFor(ORG)).filter(id => id === raced).length === 1,
      JSON.stringify(await registryFor(ORG)),
    );
  }

  // ══ 7. claim_not_owner ═════════════════════════════════════════════════════
  //
  // Reachable on an ALREADY claimed instance: a second organisation the same human
  // also belongs to, whose claim finds a stamp that is neither its own owner nor the
  // acting user. The comparison is against the acting USER on purpose - comparing
  // the resolved owner would make the precondition "the organisation already owns
  // it", which is the state a claim is trying to reach.
  console.log('\nclaim_not_owner (Requirement 3.3)');
  {
    const keysBefore = await backupKeys();
    const refused = await claimAs(ACTOR_IN_ORG_OTHER, CLAIMED);
    check('a second organisation is refused 409', refused.status === 409, String(refused.status));
    check(
      'with code claim_not_owner',
      refused.body?.code === 'claim_not_owner',
      JSON.stringify(refused.body),
    );
    check('the stamp did not move', await owns(instanceOf(ACTOR, CLAIMED), ORG));
    check('nothing is registered under it', (await registryFor(ORG_OTHER)).length === 0);
    check(
      'the rows did not move',
      JSON.stringify(await usageOwners(CLAIMED)) === JSON.stringify({ [ORG]: 3 }),
      JSON.stringify(await usageOwners(CLAIMED)),
    );
    check('no R2 object was touched', JSON.stringify(await backupKeys()) === JSON.stringify(keysBefore));
    check('and there is still exactly one audit row', (await auditRows(CLAIMED)).length === 1);
  }

  // ══ 8. Shape refusals ══════════════════════════════════════════════════════
  console.log('\nRoute shape');
  {
    const wrongMethod = await call(`/api/deployments/${CLAIMED}/claim`, { token: ACTOR_IN_ORG });
    check('GET is 405', wrongMethod.status === 405, String(wrongMethod.status));

    const unauthenticated = await call(`/api/deployments/${CLAIMED}/claim`, { method: 'POST' });
    check('no bearer is 401', unauthenticated.status === 401, String(unauthenticated.status));

    // A workflow id that could not be a key segment is 404, not a claim refusal: the
    // claim vocabulary is append-only and three codes wide (Requirement 3.12).
    for (const hostile of ['wf%3Aclaim', 'wf%23sclaim', encodeURIComponent('wf claim')]) {
      const refused = await call(`/api/deployments/${hostile}/claim`, {
        token: ACTOR_IN_ORG,
        method: 'POST',
      });
      check(`an unaddressable workflow id (${hostile}) is 404`, refused.status === 404, String(refused.status));
      check('with no claim code', refused.body?.code === undefined, JSON.stringify(refused.body));
    }

    // The deployments READ is still matched, and the claim route did not swallow it.
    const list = await call('/api/deployments', { token: ACTOR_IN_ORG });
    check('GET /api/deployments still answers', list.status === 200, String(list.status));
  }
} finally {
  await mf.dispose();
}

// ══ 9. BYO answers a flat 404, and so does hosted with no D1 ════════════════
//
// Requirement 3.10 and 16.6: no refusal this feature adds may name a binding a BYO
// worker would have to add, so both cases are 404 and neither is the 501 the
// `store.enabled` gate produces.
console.log('\nBYO and an unconfigured hosted worker (Requirements 3.10, 16.6)');
{
  const byo = worker({ PHORMA_TOKEN: 'claim-byo-token' });
  try {
    const response = await byo.dispatchFetch('http://localhost/api/deployments/wf-x/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer claim-byo-token' },
    });
    const body = await response.json().catch(() => null);
    check('BYO answers 404', response.status === 404, String(response.status));
    check('and says nothing about a binding', !/binding/i.test(body?.error ?? ''), JSON.stringify(body));
  } finally {
    await byo.dispose();
  }

  const hostedNoDb = worker({
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
  });
  try {
    const response = await hostedNoDb.dispatchFetch('http://localhost/api/deployments/wf-x/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACTOR_IN_ORG}` },
    });
    const body = await response.json().catch(() => null);
    check('a hosted worker with no D1 also answers 404', response.status === 404, String(response.status));
    check('and not the 501 the store gate produces', response.status !== 501, String(response.status));
    check('and says nothing about a binding', !/binding/i.test(body?.error ?? ''), JSON.stringify(body));
  } finally {
    await hostedNoDb.dispose();
  }
}

console.log(
  failures === 0 ? '\nAll ownership-claim checks passed.\n' : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
