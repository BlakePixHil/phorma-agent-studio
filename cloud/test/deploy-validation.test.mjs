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
 * Covers:
 *  - an error finding -> HTTP 400 with EVERY finding in the body, and the
 *    previously deployed spec left completely unchanged (17.12)
 *  - a warning-only (or clean) push -> HTTP 200 and the spec is replaced
 *    (17.12, 17.15)
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
} finally {
  await mf.dispose();
}

console.log(failures === 0 ? '\nAll deploy-validation checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
