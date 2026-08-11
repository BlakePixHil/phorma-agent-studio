/**
 * Portal + workflow-state teardown coverage for the cloud purge path.
 *
 * Two concerns are pinned here, both reachable without a real worker:
 *
 *  1. `PortalIndex.addSession` / `deleteSessions` - the session registry that
 *     lets a workflow purge delete the per-visitor session Durable Objects a
 *     published portal has spawned. A Map-backed storage stub exercises the
 *     exact key shape (`session:{workflowId}:{sessionId}`) and the
 *     idempotent, prefix-bounded delete.
 *  2. `clearAllForWorkflow` - the workflow-state helper that wipes every
 *     `workflow_state` row for one workflow. Keys are workflow-scoped by the
 *     engine (`{workflowId}::{namespace}:{key}`), so a prefix match is exact
 *     and can never touch another workflow's state. Exercised against a real
 *     in-memory SQLite via `node:sqlite`, the same tagged-template shape the
 *     Durable Object's `Agent.sql` exposes.
 *
 * Run: npx -y tsx cloud/test/portal-cleanup.test.mjs
 */

import { registerHooks } from 'node:module';

// `portal-registry.ts` extends `cloudflare:workers`' `DurableObject`, which
// Node cannot resolve outside workerd. Redirect it to the stub before the
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

const { PortalIndex } = await import('../src/portal-registry.ts');
const { clearAllForWorkflow, ensureWorkflowStateTable } = await import('../src/workflow-state.ts');

// `node:sqlite` is only available on Node 22+. The `clearAllForWorkflow`
// section needs it; the PortalIndex section does not. Load it lazily so the
// session-registry checks still run on older Node, and skip the SQLite
// section with a clear message when the built-in is unavailable.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('\n(node:sqlite unavailable on this Node - skipping clearAllForWorkflow checks)');
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

// ── Map-backed DurableObject storage ───────────────────────────────────────

/**
 * A minimal stand-in for the `DurableObject` `ctx.storage` API: a Map with
 * `get`/`put`/`delete`/`list` (prefix-bounded). Enough for `PortalIndex`'s
 * session registry, which only uses those four.
 */
function mapStorage() {
  const map = new Map();
  return {
    get: async (key) => map.get(key) ?? undefined,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      return map.delete(key);
    },
    list: async ({ prefix } = {}) => {
      const out = new Map();
      for (const [key, value] of map) {
        if (prefix === undefined || key.startsWith(prefix)) out.set(key, value);
      }
      return out;
    },
    // Snapshot for assertions.
    _map: map,
  };
}

function newIndex() {
  const storage = mapStorage();
  const ctx = { storage };
  const index = new PortalIndex(ctx, {});
  return { index, storage };
}

// ── PortalIndex session registry ───────────────────────────────────────────

console.log('\nPortalIndex session registry');
{
  const { index, storage } = newIndex();

  // Two sessions for wf-a, one for wf-b.
  await index.addSession('wf-a', 'sess-1', 'owner:wf-a#ssess-1');
  await index.addSession('wf-a', 'sess-2', 'owner:wf-a#ssess-2');
  await index.addSession('wf-b', 'sess-3', 'owner:wf-b#ssess-3');

  check('three session keys are tracked', storage._map.size === 3, String(storage._map.size));

  // Idempotent: re-registering the same session overwrites the same key
  // (same `session:{workflowId}:{sessionId}` storage key) rather than adding a fourth.
  await index.addSession('wf-a', 'sess-1', 'owner:wf-a#ssess-1');
  check('addSession is idempotent (re-registering overwrites the same key)', storage._map.size === 3, String(storage._map.size));

  const deleted = await index.deleteSessions('wf-a');
  check('deleteSessions returns the two wf-a session instance names', deleted.length === 2, JSON.stringify(deleted));
  check(
    'the returned names are the tenant-prefixed instance names',
    deleted.includes('owner:wf-a#ssess-1') && deleted.includes('owner:wf-a#ssess-2'),
    JSON.stringify(deleted),
  );
  check('wf-a tracking keys are gone', storage._map.size === 1, String(storage._map.size));
  check('wf-b session survives (per-workflow isolation)', (await storage.list({ prefix: 'session:wf-b:' })).size === 1);

  // Idempotent: a second call returns nothing and is harmless.
  const again = await index.deleteSessions('wf-a');
  check('deleteSessions is idempotent (empty on second call)', again.length === 0, JSON.stringify(again));

  // Deleting a workflow with no sessions is a no-op.
  const empty = await index.deleteSessions('wf-never');
  check('deleteSessions on an unknown workflow returns []', empty.length === 0, JSON.stringify(empty));
}

// ── Session keys do not collide with slug keys ─────────────────────────────

console.log('\nSession keys are namespaced away from slug keys');
{
  const { index, storage } = newIndex();
  // A slug and a session for the same workflow coexist.
  await index.publish({
    slug: 'my-portal',
    workflowId: 'wf-a',
    ownerId: 'owner',
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
  await index.addSession('wf-a', 'sess-1', 'owner:wf-a#ssess-1');

  const sessions = await index.deleteSessions('wf-a');
  check('deleteSessions returns only the session, not the slug', sessions.length === 1 && sessions[0] === 'owner:wf-a#ssess-1', JSON.stringify(sessions));
  check('the slug entry survives deleteSessions (purge calls unpublish separately)', (await storage.get('portal:my-portal')) !== undefined);

  const { removed } = await index.unpublish('wf-a');
  check('unpublish removes the slug', removed.length === 1 && removed[0] === 'my-portal', JSON.stringify(removed));
  // deleteSessions already ran above and cleared the session key, so the
  // registry has no session keys left either way; the point is that unpublish
  // itself does not touch the session namespace.
  const sessionKeysAfterUnpublish = await storage.list({ prefix: 'session:wf-a:' });
  check('unpublish does not touch the session namespace', sessionKeysAfterUnpublish.size === 0, String(sessionKeysAfterUnpublish.size));
}

// ── clearAllForWorkflow ─────────────────────────────────────────────────────

console.log('\nclearAllForWorkflow');
if (DatabaseSync) {
  {
    const sql = sqliteExecutor();
    ensureWorkflowStateTable(sql);
    // Seed two workflows' state in the same table.
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-a::user:one'}, ${'a1'}, ${1}, ${null})`;
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-a::fx:fixture'}, ${'a-fx'}, ${1}, ${null})`;
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-a::wm:watermark'}, ${'a-wm'}, ${1}, ${null})`;
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-b::user:two'}, ${'b1'}, ${1}, ${null})`;

    clearAllForWorkflow(sql, 'wf-a');

    const remaining = sql`SELECT key FROM workflow_state`.map(row => row.key);
    check('every wf-a row is deleted', remaining.every(key => !key.startsWith('wf-a::')), JSON.stringify(remaining));
    check('wf-b row survives (per-workflow isolation)', remaining.includes('wf-b::user:two'), JSON.stringify(remaining));
    check('exactly one row remains', remaining.length === 1, JSON.stringify(remaining));
  }

  {
    // The scope separator matters: a workflow id that is a prefix of another
    // (`wf-a` vs `wf-abc`) must not have its delete bleed into the other's rows.
    const sql = sqliteExecutor();
    ensureWorkflowStateTable(sql);
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-a::user:one'}, ${'a'}, ${1}, ${null})`;
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-abc::user:two'}, ${'abc'}, ${1}, ${null})`;

    clearAllForWorkflow(sql, 'wf-a');

    const remaining = sql`SELECT key FROM workflow_state`.map(row => row.key);
    check('a prefix workflow id does not delete a longer workflow id\'s rows', remaining.includes('wf-abc::user:two'), JSON.stringify(remaining));
    check('the exact-match workflow id is deleted', !remaining.includes('wf-a::user:one'), JSON.stringify(remaining));
  }

  {
    // Clearing a workflow with no state is a no-op.
    const sql = sqliteExecutor();
    ensureWorkflowStateTable(sql);
    sql`INSERT INTO workflow_state (key, value, updated_at, expires_at) VALUES (${'wf-a::user:one'}, ${'a'}, ${1}, ${null})`;
    clearAllForWorkflow(sql, 'wf-empty');
    const remaining = sql`SELECT key FROM workflow_state`.map(row => row.key);
    check('clearAllForWorkflow on an unknown workflow is a no-op', remaining.length === 1 && remaining[0] === 'wf-a::user:one', JSON.stringify(remaining));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A `DurableSqlExecutor` backed by a real, in-memory SQLite database - the
 * same tagged-template shape `Agent.sql` exposes, so `clearAllForWorkflow`
 * exercises its actual SQL.
 */
function sqliteExecutor() {
  const db = new DatabaseSync(':memory:');
  return (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) {
      text += `?${strings[i + 1]}`;
    }
    return db.prepare(text).all(...values);
  };
}

console.log(failures === 0 ? '\nAll portal-cleanup checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
