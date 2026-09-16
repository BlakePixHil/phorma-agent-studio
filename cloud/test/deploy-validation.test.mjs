/**
 * Deploy-time capability validation on `POST /workflow` (task 21.3,
 * Requirements 17.11, 17.12, 17.15).
 *
 * This is the one worker-route test that needs a REAL Durable Object rather
 * than a pure-function harness: the property under test is what
 * `WorkflowAgent.onRequest` does with `setState`/`rescheduleCron` around the
 * Capability_Validator call, which a pure-function test of
 * `validateAgainstCapabilities` alone cannot observe. `wrangler deploy
 * --dry-run` produces the exact worker bundle a real deploy would ship, and
 * `miniflare` runs that bundle against a real (in-memory) SQLite-backed
 * Durable Object — no network, no Cloudflare account, no deployed worker.
 *
 * Because it is the one harness with a real DO, it also hosts the worker-route
 * regressions that only a real bundle can catch (the OPTIONS preflight, the
 * purge cascade across two Durable Objects, and the WebSocket upgrade).
 *
 * Covers:
 *  - an error finding -> HTTP 400 with EVERY finding in the body, and the
 *    previously deployed spec left completely unchanged (17.12)
 *  - a warning-only (or clean) push -> HTTP 200 and the spec is replaced
 *    (17.12, 17.15)
 *  - `DELETE /workflow` clears the spec; `DELETE /workflow/purge` additionally
 *    cascades (portal unpublished, sessions purged) and is idempotent
 *  - the gateway leaves a 101 WebSocket upgrade untouched
 *
 * Run: node cloud/test/deploy-validation.test.mjs
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Miniflare } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(here, '..');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function node(id, kind, ports, data = {}) {
  return { id, name: id, kind, category: 'flow', icon: '', position: { x: 0, y: 0 }, ports, data };
}
const IN = (id) => ({ id: `${id}-in`, name: 'In', role: 'message-in' });
const OUT = (id, name = 'Out') => ({ id: `${id}-out`, name, role: 'message-out' });

/** A trigger plus one well-formed `http-request` node — deployable as-is. */
function validSpec(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        node('trigger', 'manual-trigger', [OUT('trigger')]),
        node('http1', 'http-request', [IN('http1'), OUT('http1', 'Response')], {
          method: 'GET',
          url: 'https://api.example.com/items',
          responseMode: 'json',
          bodyMode: 'none',
        }),
      ],
      edges: [],
    },
  };
}

/**
 * Two INDEPENDENT error findings — an unrecognised node kind and an
 * unsupported SQL driver — so the "every finding, not just the first" claim
 * of Requirement 17.12 has something to actually distinguish it from a
 * "first finding only" implementation.
 */
function specWithTwoErrorFindings(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        node('bad-kind', 'not-a-real-kind', [OUT('bad-kind')]),
        node('sql1', 'sql-query', [IN('sql1'), OUT('sql1', 'Rows')], {
          driver: 'mssql', // declared for Desktop_Host only (Requirement 17.3)
          statement: 'SELECT 1',
          params: [],
        }),
      ],
      edges: [],
    },
  };
}

/**
 * A publishable portal: a `portal-trigger` handed off to one agent. The handoff
 * matters - `validatePortal` rejects a trigger that answers nobody.
 */
function portalSpec(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'portal',
          name: 'Portal',
          kind: 'portal-trigger',
          category: 'trigger',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: 'portal-msg', name: 'Message', role: 'message-out' }],
          data: { mode: 'chat', access: 'public', slug: 'purge-me' },
        },
        node('answer', 'agent', [IN('answer'), OUT('answer', 'Reply')], {
          prompt: 'Reply in one short sentence.',
        }),
      ],
      connections: [
        { id: 'e1', outputId: 'portal-msg-out', inputId: 'answer-in', kind: 'handoff' },
      ],
    },
  };
}

/** A trigger plus an `http-request` node whose url is a template — warning only. */
function specWithWarningOnly(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        node('trigger', 'manual-trigger', [OUT('trigger')]),
        node('http1', 'http-request', [IN('http1'), OUT('http1', 'Response')], {
          method: 'GET',
          url: '{{ base }}/items', // not statically determinable -> warning (17.13)
          responseMode: 'json',
          bodyMode: 'none',
        }),
      ],
      edges: [],
    },
  };
}

async function push(mf, workflowId, spec) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/workflow`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) },
  );
  return { status: response.status, body: await response.json() };
}

async function status(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/status`,
  );
  return { status: response.status, body: await response.json() };
}

async function removeWorkflow(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/workflow`,
    { method: 'DELETE' },
  );
  return { status: response.status, body: await response.json() };
}

async function purgeWorkflow(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/workflow/purge`,
    { method: 'DELETE' },
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function publish(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/publish`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function portalStatus(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/portal`,
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** `GET /workflow` - the deployed spec read-back (Requirement 4). */
async function readSpec(mf, workflowId) {
  const response = await mf.dispatchFetch(
    `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}/workflow`,
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** `GET /api/deployments` - the whole account's live deployments. */
async function listDeployments(mf) {
  const response = await mf.dispatchFetch('http://localhost/api/deployments');
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** One deployment row by workflow id, or undefined. */
async function deploymentRow(mf, workflowId) {
  const { body } = await listDeployments(mf);
  return (body.deployments ?? []).find((entry) => entry.workflowId === workflowId);
}

// ── Build the exact deploy bundle, then run it under Miniflare ─────────────

const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-deploy-validation-'));
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

const mf = new Miniflare({
  modules: true,
  script,
  compatibilityDate: '2025-05-01',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
    PortalIndex: { className: 'PortalIndex', useSQLite: true },
  },
});

try {
  // ── The gateway's CORS preflight must allow every method a route uses ────
  // (regression: DELETE /workflow shipped before the OPTIONS handler in
  // index.ts knew about it, so a browser blocked it before the request ever
  // reached the worker).
  console.log('\nOPTIONS preflight CORS headers');
  {
    const response = await mf.dispatchFetch(
      'http://localhost/agents/workflow-agent/wf-cors-check/workflow',
      { method: 'OPTIONS' },
    );
    const allowed = response.headers.get('Access-Control-Allow-Methods') ?? '';
    check('OPTIONS preflight allows DELETE', allowed.includes('DELETE'), allowed);
  }

  // ── Requirement 17.12: an error finding rejects with every finding ───────
  console.log('\nAn error finding on POST /workflow');
  {
    const workflowId = 'wf-deploy-validation-error';
    const first = await push(mf, workflowId, validSpec(workflowId, 'Original'));
    check('a well-formed spec deploys first (200)', first.status === 200, JSON.stringify(first.body));

    const rejected = await push(mf, workflowId, specWithTwoErrorFindings(workflowId, 'Bad push'));
    check('the deploy-time rejection is HTTP 400', rejected.status === 400, JSON.stringify(rejected.body));
    check(
      'the body carries a findings array',
      Array.isArray(rejected.body?.findings),
      JSON.stringify(rejected.body),
    );
    check(
      'every finding is present, not just the first (unrecognised kind AND unsupported driver)',
      rejected.body.findings.some((f) => /not-a-real-kind/.test(f.message)) &&
        rejected.body.findings.some((f) => /mssql/.test(f.message)),
      JSON.stringify(rejected.body.findings),
    );
    check(
      'every returned finding is severity error',
      rejected.body.findings.every((f) => f.severity === 'error'),
      JSON.stringify(rejected.body.findings),
    );

    const after = await status(mf, workflowId);
    check(
      'the previously deployed workflow is left completely unchanged',
      after.body.name === 'Original',
      JSON.stringify(after.body),
    );
  }

  // ── Requirement 17.12, 17.15: warning-only never blocks the deploy ───────
  console.log('\nA warning-only finding on POST /workflow');
  {
    const workflowId = 'wf-deploy-validation-warning';
    const accepted = await push(mf, workflowId, specWithWarningOnly(workflowId, 'Warned push'));
    check('a warning-only spec still deploys (200)', accepted.status === 200, JSON.stringify(accepted.body));
    check('the deploy response carries no findings body', accepted.body?.findings === undefined);

    const after = await status(mf, workflowId);
    check(
      'the spec IS replaced by a warning-only push',
      after.body.name === 'Warned push' && after.body.hasWorkflow === true,
      JSON.stringify(after.body),
    );
  }

  // ── Requirement 17.12: a clean spec deploys with no findings at all ──────
  console.log('\nA fully clean spec on POST /workflow');
  {
    const workflowId = 'wf-deploy-validation-clean';
    const accepted = await push(mf, workflowId, validSpec(workflowId, 'Clean push'));
    check('a clean spec deploys (200)', accepted.status === 200, JSON.stringify(accepted.body));
    const after = await status(mf, workflowId);
    check('the spec is stored', after.body.name === 'Clean push', JSON.stringify(after.body));
  }

  // ── DELETE /workflow removes the deployed spec (studio "Remove from cloud") ──
  console.log('\nDELETE /workflow');
  {
    const workflowId = 'wf-deploy-validation-remove';
    const pushed = await push(mf, workflowId, validSpec(workflowId, 'Removable push'));
    check('the spec deploys first (200)', pushed.status === 200, JSON.stringify(pushed.body));

    const removed = await removeWorkflow(mf, workflowId);
    check(
      'the removal responds ok',
      removed.status === 200 && removed.body?.ok === true,
      JSON.stringify(removed.body),
    );

    const after = await status(mf, workflowId);
    check('hasWorkflow is false after removal', after.body.hasWorkflow === false, JSON.stringify(after.body));
  }

  // ── DELETE /workflow/purge cascades (studio delete / "Remove from cloud") ──
  // The purge is the ONLY teardown a user can reach for cloud resources they
  // can no longer see, so the cascade is the property that matters: cron
  // cancelled, portal slug unpublished, session DOs purged, spec gone. Proven
  // through the portal slug, because it lives in a DIFFERENT Durable Object
  // (`PortalIndex`) and therefore can only disappear if the owner instance
  // actually cascaded. Regression: the route shipped calling
  // `purgeSelf(false)`, so it wiped its own tables and left the published
  // portal serving a workflow that no longer existed.
  console.log('\nDELETE /workflow/purge');
  {
    const workflowId = 'wf-purge-cascade';
    const pushed = await push(mf, workflowId, portalSpec(workflowId, 'Purgeable portal'));
    check('the portal spec deploys (200)', pushed.status === 200, JSON.stringify(pushed.body));

    const published = await publish(mf, workflowId);
    check(
      'the portal publishes',
      published.status === 200 && published.body?.ok === true,
      JSON.stringify(published.body),
    );
    const before = await portalStatus(mf, workflowId);
    check('the portal registry holds a slug', before.body?.record?.slug === 'purge-me', JSON.stringify(before.body));

    const purged = await purgeWorkflow(mf, workflowId);
    check(
      'the purge responds ok',
      purged.status === 200 && purged.body?.purged === true,
      JSON.stringify(purged.body),
    );
    check(
      'no session DO was left orphaned',
      purged.body?.orphanedSessions === 0,
      JSON.stringify(purged.body),
    );

    const afterPortal = await portalStatus(mf, workflowId);
    check(
      'the purge UNPUBLISHED the portal (the cascade ran)',
      afterPortal.body?.record === null,
      JSON.stringify(afterPortal.body),
    );
    const afterStatus = await status(mf, workflowId);
    check(
      'hasWorkflow is false after the purge',
      afterStatus.body.hasWorkflow === false,
      JSON.stringify(afterStatus.body),
    );

    // Purging twice must not fault - the library-delete path can race the
    // Cloud dialog's own "Remove from cloud".
    const again = await purgeWorkflow(mf, workflowId);
    check('a second purge is a clean no-op', again.status === 200, JSON.stringify(again.body));
  }

  // ── GET /workflow: the deployed spec is itself a recoverable copy ─────────
  // (cloud-workflow-backup Requirement 4). This is the route that makes a
  // deployment downloadable and restorable when the local library is gone, with
  // no backup storage involved at all.
  console.log('\nGET /workflow read-back');
  {
    const workflowId = 'wf-read-back';
    const empty = await readSpec(mf, workflowId);
    check('an instance with nothing deployed answers 404', empty.status === 404, String(empty.status));
    check('the 404 body says nothing is deployed', empty.body?.hasWorkflow === false, JSON.stringify(empty.body));

    await push(mf, workflowId, validSpec(workflowId, 'Readable'));
    const read = await readSpec(mf, workflowId);
    check('a deployed instance answers 200', read.status === 200, String(read.status));
    check(
      'the body carries the exact spec that was pushed',
      read.body?.spec?.id === workflowId &&
        read.body.spec.name === 'Readable' &&
        read.body.spec.graph.nodes.length === 2,
      JSON.stringify(read.body?.spec).slice(0, 200),
    );
    check('the body reports when it was deployed', typeof read.body?.savedAt === 'string');

    await removeWorkflow(mf, workflowId);
    check('after an undeploy the read-back is 404 again', (await readSpec(mf, workflowId)).status === 404);
  }

  // ── The deployment registry, end to end ───────────────────────────────────
  // (cloud-workflow-backup Requirements 2, 5). Written by the WORKER on push,
  // undeploy and purge, so the list stays correct for a studio that crashed, was
  // uninstalled, or is three versions old. Observed through `/api/deployments`,
  // which is the only read path there is.
  console.log('\nDeployment registry lifecycle');
  {
    const workflowId = 'wf-registry-lifecycle';
    check('the account lists nothing for an unpushed workflow', (await deploymentRow(mf, workflowId)) === undefined);

    await push(mf, workflowId, validSpec(workflowId, 'Listed'));
    const listed = await deploymentRow(mf, workflowId);
    check('a push registers the deployment', listed !== undefined, 'no row');
    check('the row carries the workflow name', listed?.workflowName === 'Listed', JSON.stringify(listed));
    check('the row carries a spec hash', typeof listed?.specHash === 'string' && listed.specHash.length > 0);
    check('a spec with no schedule-trigger reports cronArmed false', listed?.cronArmed === false, JSON.stringify(listed));
    check('a workflow with no portal reports portalSlug null', listed?.portalSlug === null, JSON.stringify(listed));
    check('deployedAt is an epoch-ms number', Number.isFinite(listed?.deployedAt) && listed.deployedAt > 0);

    // A re-push keeps the original deployment time and moves `updatedAt`
    // (Requirement 2.7). The 5ms wait is what makes the two clocks separable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await push(mf, workflowId, validSpec(workflowId, 'Listed again'));
    const repushed = await deploymentRow(mf, workflowId);
    check('a re-push keeps deployedAt', repushed?.deployedAt === listed?.deployedAt, `${listed?.deployedAt} -> ${repushed?.deployedAt}`);
    check('a re-push moves updatedAt forward', repushed?.updatedAt > listed?.updatedAt, `${listed?.updatedAt} -> ${repushed?.updatedAt}`);
    check('a re-push updates the name', repushed?.workflowName === 'Listed again', JSON.stringify(repushed));

    // No D1 in this harness, so spend is UNKNOWN rather than zero
    // (Requirement 5.5). A null here is the whole point: rendering it as 0 would
    // tell a user a runaway deployment costs nothing.
    check('spend is null when there is no ledger to read', repushed?.creditsSpent === null, JSON.stringify(repushed));
    check('the run count is null for the same reason', repushed?.runsThisMonth === null, JSON.stringify(repushed));
    check('the response names the spend window', /^\d{4}-\d{2}$/.test((await listDeployments(mf)).body?.month ?? ''));

    await removeWorkflow(mf, workflowId);
    check('an undeploy deregisters the deployment', (await deploymentRow(mf, workflowId)) === undefined);
  }

  {
    // A rejected push must leave the registry untouched (Requirement 2.5) -
    // otherwise the list would advertise a deployment the worker refused.
    const workflowId = 'wf-registry-rejected';
    const rejected = await push(mf, workflowId, specWithTwoErrorFindings(workflowId, 'Never deployed'));
    check('the push is rejected', rejected.status === 400, String(rejected.status));
    check('a rejected push registers nothing', (await deploymentRow(mf, workflowId)) === undefined);
  }

  {
    // The purge cascade removes the registry entry too (Requirement 2.3), so the
    // action a user reaches for to stop an orphan also stops listing it.
    const workflowId = 'wf-registry-purge';
    await push(mf, workflowId, portalSpec(workflowId, 'Purgeable listed'));
    await publish(mf, workflowId);
    // The portal slug is captured on the NEXT registry write, so re-push after
    // publishing to observe it - which is also what the studio does.
    await push(mf, workflowId, portalSpec(workflowId, 'Purgeable listed'));
    const published = await deploymentRow(mf, workflowId);
    check('the row reports the published portal address', published?.portalSlug === 'purge-me', JSON.stringify(published));

    await purgeWorkflow(mf, workflowId);
    check('a purge deregisters the deployment', (await deploymentRow(mf, workflowId)) === undefined);
  }

  {
    // Requirement 3: a deployment made before the registry existed is invisible
    // until something writes it, and a WAKE is that something. Simulated by
    // pushing, deregistering behind the agent's back (which is what an
    // unmigrated deployment looks like), then waking the instance.
    // What this harness can observe is the half that can go WRONG: a wake must
    // not duplicate or overwrite a live record (Requirement 3.5), because held
    // state is older than whatever the last push wrote. The empty-registry write
    // itself is `PortalIndex.registerDeployment`, covered by
    // `deployment-registry.test.mjs`.
    const workflowId = 'wf-registry-backfill';
    await push(mf, workflowId, validSpec(workflowId, 'Backfilled'));
    const before = await deploymentRow(mf, workflowId);
    const { body } = await listDeployments(mf);
    const count = (body.deployments ?? []).filter((entry) => entry.workflowId === workflowId).length;
    check('the deployment is listed exactly once', count === 1, String(count));
    // Any authenticated route wakes the instance; `status` is the cheapest.
    await status(mf, workflowId);
    const after = await deploymentRow(mf, workflowId);
    check(
      'a wake leaves an existing record unmodified',
      after?.deployedAt === before?.deployedAt && after?.updatedAt === before?.updatedAt,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  }

  // ── The gateway must not re-wrap a WebSocket upgrade ──────────────────────
  // The monitor connects `wss://.../agents/workflow-agent/{id}`, which returns
  // a 101 carrying the `webSocket` handle. Regression: the CORS-attachment
  // block in index.ts rebuilt every response that lacked
  // `Access-Control-Allow-Origin`, and rebuilding a 101 drops the socket (and
  // workerd rejects the status), so the cloud monitor could not connect at all.
  console.log('\nWebSocket upgrade passthrough');
  {
    const workflowId = 'wf-ws-upgrade';
    await push(mf, workflowId, validSpec(workflowId, 'Monitored'));
    const response = await mf.dispatchFetch(
      `http://localhost/agents/workflow-agent/${encodeURIComponent(workflowId)}`,
      { headers: { Upgrade: 'websocket' } },
    );
    check('the upgrade is answered 101', response.status === 101, String(response.status));
    check('the response still carries the webSocket handle', response.webSocket !== null && response.webSocket !== undefined);
    // Accept before closing: workerd refuses close() on an unaccepted socket.
    response.webSocket?.accept();
    response.webSocket?.close();
  }
} finally {
  await mf.dispose();
}

console.log(failures === 0 ? '\nAll deploy-validation checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
