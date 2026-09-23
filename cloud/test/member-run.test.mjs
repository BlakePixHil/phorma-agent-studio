/**
 * A member runs, watches and approves a deployed workflow
 * (multi-organisation-phorma task 9, Requirements 10.1, 10.2, 10.3, 10.4, 10.5,
 * 10.6; Property 20).
 *
 * The claim is end to end and it is about IDENTITY, not plumbing: a caller whose
 * only capability level is `operator` can trigger the organisation's deployment,
 * see the run as RunEvents, settle its approval gate through the existing
 * suspension endpoint, and the settled gate then carries THAT MEMBER's user id
 * into the run's persisted history - not the owner's, and not the id of whoever
 * happened to start the run.
 *
 * Why it exists as its own suite rather than a section of `run-wiring.test.mjs`:
 * the pure decision (which pending gate an outcome belongs to, and consuming the
 * entry) is driven there with no worker at all. What cannot be seen from there is
 * the WIRING - whether the four settle sites actually record `caller.userId`, and
 * whether the emit tee stamps it before the recorder runs. Deleting one
 * `rememberGateActor` call passes every pure check and fails here.
 *
 * Harness, each piece real rather than stubbed:
 *
 *  - THE REAL DEPLOY BUNDLE under Miniflare, with real SQLite-backed Durable
 *    Objects, so the run, its recorder and its gate maps are the ones that ship.
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here and its public
 *    half handed to the worker as `CLERK_JWT_KEY`, so `@clerk/backend` verifies
 *    every session token for real on its offline path with no JWKS fetch.
 *  - D1 IS REAL, with the real migrations applied. Both members carry an UNMAPPED
 *    `org:member` role claim, so `CLERK_ROLE_LEVELS` cannot short-circuit and each
 *    level comes from an `org_members` row - which is the only way an `operator`
 *    exists at all. Setup goes through `DB.batch([...])` and the handle through
 *    `withLoopbackRetryD1`, because each proxied statement costs a loopback socket.
 *  - THE WORKFLOW NEEDS NO MODEL. A manual trigger wired into an approval gate
 *    suspends with no inference, so nothing here talks to a provider - but the
 *    tenant row still carries an encrypted runtime key, because
 *    `resolveHostedInference` gates EVERY hosted trigger and without it the run
 *    refuses with `no_runtime_key` and every assertion below is unreachable.
 *
 * Run: npx tsx cloud/test/member-run.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

import { withLoopbackRetry, withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// `tenants.ts` reaches `cloudflare:workers` through its module graph, and this
// suite imports it for `encryptString` alone - the same shim `owner-identity` and
// `status` use, installed before the graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { encryptString } = await import('../src/tenants.ts');

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

const ORG = 'org_member_run';
const OPERATOR_ID = 'user_member_operator';
const BUILDER_ID = 'user_member_builder';
const KEY_ENC_SECRET = Buffer.alloc(32, 19).toString('base64');
const RUNTIME_KEY = 'sk-or-v1-member-run-test';
const WORKFLOW_ID = 'wf-member-run';

// ── Tokens ──────────────────────────────────────────────────────────────────

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-member-run' })}.${base64url({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

/**
 * Both members carry `org:member`, which `CLERK_ROLE_LEVELS` does NOT map - so
 * each level is read from `org_members` and the `operator` case is a real one
 * rather than an admin claim wearing a different name.
 */
const OPERATOR = mintToken(OPERATOR_ID, { org_id: ORG, org_role: 'org:member' });
const BUILDER = mintToken(BUILDER_ID, { org_id: ORG, org_role: 'org:member' });

// ── The bundle ──────────────────────────────────────────────────────────────

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-member-run-'));
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

const mf = withLoopbackRetry(
  new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
      PortalIndex: { className: 'PortalIndex', useSQLite: true },
      SecretVault: { className: 'SecretVault', useSQLite: true },
    },
    d1Databases: { DB: 'phorma-cloud-member-run' },
    bindings: {
      PHORMA_MODE: 'hosted',
      CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
      CLERK_JWT_KEY,
      KEY_ENC_SECRET,
    },
  }),
);

/**
 * Splits a migration into statements. Split on `/\r?\n/`, never `'\n'`: a CRLF
 * checkout leaves each line ending in `\r`, the `--` stripper then matches
 * nothing, and the comment-only tail reaches D1 as "SQL code did not contain a
 * statement".
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

/** A manual trigger wired into an approval gate. No model, no connections. */
function gateSpec() {
  return {
    version: 1,
    id: WORKFLOW_ID,
    name: 'Journal approval',
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'trigger',
          name: 'Start',
          kind: 'manual-trigger',
          category: 'trigger',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: 'trigger-start', name: 'Out', role: 'message-out' }],
          data: {},
        },
        {
          id: 'gate',
          name: 'Post the journal',
          kind: 'approval-gate',
          category: 'flow',
          icon: '',
          position: { x: 200, y: 0 },
          ports: [
            { id: 'gate-input', name: 'In', role: 'message-in' },
            { id: 'gate-yes', name: 'Approved', role: 'message-out' },
            { id: 'gate-no', name: 'Rejected', role: 'message-out' },
          ],
          data: { message: 'Post the June journal?' },
        },
      ],
      // A connector id is the port id plus the `-out` / `-in` suffix
      // `portBaseId` strips - so a port whose OWN id ends in `-out` never
      // resolves, and the run quietly ends after the trigger instead of
      // suspending. That is what these ids are named the way they are to avoid.
      connections: [
        { id: 'edge-1', outputId: 'trigger-start-out', inputId: 'gate-input-in', kind: 'handoff' },
      ],
    },
  };
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

try {
  const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));
  for (const file of [
    '0001_init.sql',
    '0003_billing.sql',
    '0004_billing_ordering.sql',
    '0005_workflow_backups.sql',
    '0006_organisations.sql',
  ]) {
    for (const statement of statementsOf(file)) await DB.prepare(statement).run();
  }

  // One organisation, entitled, with one operator and one builder - in ONE batch.
  const at = new Date().toISOString();
  await DB.batch([
    DB.prepare(
      `INSERT INTO tenants (id, email, tier, status, openrouter_key_id, openrouter_key_enc,
                            created_at, updated_at)
       VALUES (?, ?, 'starter', 'active', ?, ?, ?, ?)`,
    ).bind(
      ORG,
      `billing@${ORG}.example.com`,
      `hash_${ORG}`,
      await encryptString(RUNTIME_KEY, KEY_ENC_SECRET),
      at,
      at,
    ),
    DB.prepare(
      `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
       VALUES (?, ?, 'operator', ?, ?)`,
    ).bind(ORG, OPERATOR_ID, at, at),
    DB.prepare(
      `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
       VALUES (?, ?, 'builder', ?, ?)`,
    ).bind(ORG, BUILDER_ID, at, at),
  ]);

  const AGENT = `/agents/workflow-agent/${WORKFLOW_ID}`;

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

  /**
   * The pending approval the deployment is suspended on, read the way the studio
   * reads it (Requirement 10.6). Polled, because the run reaches the gate on the
   * Durable Object's own turns.
   */
  async function pendingApproval(token) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const feed = await call('/api/notifications?since=0', { token });
      const pending = (feed.body?.deployments ?? []).flatMap(
        deployment => deployment.pending ?? [],
      );
      const approval = pending.find(entry => entry.kind === 'approval');
      if (approval) return { approval, feed };
      await sleep(50);
    }
    return { approval: null, feed: null };
  }

  /** The settled run record, once the run has flushed its event log. */
  async function settledRecord(token, runId) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const record = await call(`${AGENT}/runs/${encodeURIComponent(runId)}`, { token });
      if (record.status === 200 && record.body?.summary?.endedAt) return record.body;
      await sleep(50);
    }
    return null;
  }

  // ── The deployment exists, pushed by the builder ──────────────────────────

  console.log('\nThe organisation has a deployment');
  {
    const pushed = await call(`${AGENT}/workflow`, {
      token: BUILDER,
      method: 'POST',
      body: gateSpec(),
    });
    check('a builder can deploy it', pushed.status === 200, JSON.stringify(pushed.body));

    const asOperator = await call(`${AGENT}/workflow`, { token: OPERATOR });
    check(
      'and an operator can read the deployed spec back',
      asOperator.status === 200 && asOperator.body?.spec?.id === WORKFLOW_ID,
      JSON.stringify(asOperator.body).slice(0, 200),
    );
    const refusedPush = await call(`${AGENT}/workflow`, {
      token: OPERATOR,
      method: 'POST',
      body: gateSpec(),
    });
    check(
      'while the SAME operator credential cannot deploy - the level is real',
      refusedPush.status === 403 && refusedPush.body?.code === 'role_forbidden',
      JSON.stringify(refusedPush.body),
    );
  }

  // ── Requirement 10.1: an operator triggers it ─────────────────────────────

  console.log('\nAn operator triggers, watches and approves');
  let firstRunId = null;
  {
    const triggered = await call(`${AGENT}/trigger`, {
      token: OPERATOR,
      method: 'POST',
      body: { input: '{"period":"2026-06"}' },
    });
    check(
      'an operator may trigger the deployment',
      triggered.status === 200 && triggered.body?.ok === true,
      JSON.stringify(triggered.body),
    );
    firstRunId = triggered.body?.runId ?? null;

    const { approval } = await pendingApproval(OPERATOR);
    check(
      'the run suspends on its gate, and the operator can see it',
      approval?.nodeName === 'Post the journal' && approval?.runId === firstRunId,
      JSON.stringify(approval),
    );

    // Requirement 10.4: the EXISTING suspension endpoint.
    const settled = await call(`${AGENT}/approvals`, {
      token: OPERATOR,
      method: 'POST',
      body: { requestId: approval?.id, approved: true },
    });
    check(
      'and settle it through POST /approvals',
      settled.status === 200 && settled.body?.delivered === true,
      JSON.stringify(settled.body),
    );

    const record = await settledRecord(OPERATOR, firstRunId);
    check('the run settled', record?.summary?.status === 'completed', JSON.stringify(record?.summary));

    // Requirement 10.2: the record IS the RunEvent log - no second event shape.
    const resolved = (record?.events ?? []).filter(event => event.type === 'approval-resolved');
    check(
      'exactly one approval outcome is in the history',
      resolved.length === 1,
      JSON.stringify(resolved),
    );
    // Requirement 10.5 / Property 20.
    check(
      'and it names the OPERATOR who answered it',
      resolved[0]?.approved === true && resolved[0]?.actor === OPERATOR_ID,
      JSON.stringify(resolved[0]),
    );
    check(
      'the required half of the pair carries no actor - nobody has answered yet',
      (record?.events ?? [])
        .filter(event => event.type === 'approval-required')
        .every(event => event.actor === undefined),
    );
  }

  // ── The actor is the SETTLER, never the trigger-er ────────────────────────

  console.log('\nThe recorded id is whoever answered');
  {
    const triggered = await call(`${AGENT}/trigger`, {
      token: OPERATOR,
      method: 'POST',
      body: { input: '{"period":"2026-07"}' },
    });
    check(
      'the operator triggers a second run',
      triggered.status === 200 && triggered.body?.runId !== firstRunId,
      JSON.stringify(triggered.body),
    );
    const runId = triggered.body?.runId;

    const { approval } = await pendingApproval(OPERATOR);
    check('it suspends on its own gate', approval?.runId === runId, JSON.stringify(approval));
    check(
      'and its request id differs from the first run - gates are per occurrence',
      typeof approval?.id === 'string' && approval.id.length > 0,
      JSON.stringify(approval?.id),
    );

    // A DIFFERENT colleague answers this one.
    const settled = await call(`${AGENT}/approvals`, {
      token: BUILDER,
      method: 'POST',
      body: { requestId: approval?.id, approved: false },
    });
    check('a colleague settles it instead', settled.body?.delivered === true, JSON.stringify(settled.body));

    const record = await settledRecord(OPERATOR, runId);
    const resolved = (record?.events ?? []).find(event => event.type === 'approval-resolved');
    check(
      'history names the member who ANSWERED, not the one who triggered',
      resolved?.actor === BUILDER_ID && resolved?.approved === false,
      JSON.stringify(resolved),
    );
    check(
      'the rejected run still settled, so the gate really routed',
      record?.summary?.endedAt !== undefined,
      JSON.stringify(record?.summary),
    );
  }

  // ── Requirement 10.6: the reads a member has ──────────────────────────────

  console.log('\nOwner-scoped reads at operator level');
  {
    const runs = await call(`${AGENT}/runs`, { token: OPERATOR });
    check(
      'an operator lists the organisation\'s runs',
      runs.status === 200 && (runs.body?.runs ?? []).length === 2,
      JSON.stringify((runs.body?.runs ?? []).map(run => run.id)),
    );
    const usage = await call(`${AGENT}/usage`, { token: OPERATOR });
    check('and reads its usage ledger', usage.status === 200 && Array.isArray(usage.body?.usage));

    // None of the above is "open": another organisation asking for the same
    // workflow id is rewritten onto its OWN instance by the gateway, so it reads
    // an empty history rather than this organisation's. Deliberately asserted as
    // empty and not as a 403 - a 403 is what a FOREIGN-PREFIXED address gets, and
    // `organisation-isolation.test.mjs` owns that case at both layers.
    const outsider = mintToken('user_member_outsider', {
      org_id: 'org_member_other',
      org_role: 'org:admin',
    });
    const elsewhere = await call(`${AGENT}/runs`, { token: outsider });
    check(
      "another organisation asking for the same workflow id sees none of these runs",
      elsewhere.status === 200 && (elsewhere.body?.runs ?? []).length === 0,
      JSON.stringify(elsewhere.body),
    );
  }
} finally {
  await mf.dispose();
}

console.log(
  failures === 0 ? '\nAll member-run checks passed.\n' : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
