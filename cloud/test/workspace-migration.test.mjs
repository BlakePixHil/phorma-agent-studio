/**
 * The OpenRouter workspace migration (task group 10, requirements 36, 40).
 *
 * The subject is RE-RUNNABILITY, because that is what requirement 40 asks for and
 * because this script is pointed at live paid accounts. A migration that mints
 * twice for one tenant leaves a live key nobody can account for - the plaintext is
 * returned exactly once, so an unstored key can never be adopted, re-limited or
 * even identified except by its name.
 *
 * So the assertions are about the two states that must never exist after any
 * number of runs, including interrupted ones:
 *
 *  - a tenant with TWO enabled keys in the target workspace;
 *  - an enabled key in the target workspace that no tenant row points at.
 *
 * Harness. A real local D1 (Miniflare's SQLite binding pulled into Node with the
 * real migrations applied), the same shape `provisioning.test.mjs` uses, plus a
 * `globalThis.fetch` stub that models OpenRouter's workspaces and keys as actual
 * state rather than canned responses - a mint really lands in a workspace, a
 * disable really flips `disabled`, and `GET /keys?workspace_id=` really filters.
 * That is what makes the convergence property meaningful: the property asserts
 * against the vendor's state, not against our report of it.
 *
 * The encryption is NOT stubbed: `KEY_ENC_SECRET` is a real 32-byte key and a
 * migrated tenant's stored ciphertext is decrypted back through
 * `TenantStore.runtimeKey`, which is what proves the two key columns moved
 * together to the NEW key rather than merely changed.
 *
 * Run: npx tsx cloud/test/workspace-migration.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';

const { TenantStore, encryptString, runtimeKeyName } = await import('../src/tenants.ts');
const {
  ACTIONS,
  classifyTenant,
  formatReport,
  migrateWorkspace,
  readTenantInventory,
  resolveWorkspace,
} = await import('../scripts/workspace-migration.mjs');
// The CLI is imported for its three pure pieces only. It runs `main()` solely when
// executed directly, so importing it here starts nothing.
const { parseArgs, parseWranglerJson, renderSql, sqlLiteral, wranglerD1 } = await import(
  '../scripts/migrate-openrouter-workspace.mjs'
);

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

const realConsole = { log: console.log, warn: console.warn, error: console.error };

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    realConsole.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    realConsole.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-workspace-migration' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements. Split on `/\r?\n/`, never `'\n'`: a CRLF
 * checkout leaves each line ending in `\r`, the `--` stripper then matches
 * nothing, and the comment-only tail of a migration reaches D1 as "SQL code did
 * not contain a statement".
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
for (const file of ['0001_init.sql', '0003_billing.sql', '0004_billing_ordering.sql']) {
  for (const statement of statementsOf(file)) await DB.prepare(statement).run();
}

const PROVISIONING_KEY = 'or-management-key-do-not-leak';
const KEY_ENC_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DEFAULT_WS = '11111111-1111-1111-1111-111111111111';
const TARGET_WS = '22222222-2222-2222-2222-222222222222';
const CAP = { starter: 4, pro: 12.6, team: 44 };

const store = new TenantStore({ DB, KEY_ENC_SECRET });

// --- The OpenRouter stub: real state, not canned answers -------------------

const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let hashCounter = 0;

/**
 * Models the slice of OpenRouter this migration uses, with keys and workspaces as
 * mutable state so a mint is observable by a later list and a disable sticks.
 *
 * `failStoreFor` is not a vendor failure - it is how an INTERRUPTED run is
 * reproduced. The migration's dangerous window is between a successful mint and
 * the D1 write that records it, and the only way to be in it is for the write to
 * not happen, so the D1 shim (not the stub) refuses that one UPDATE.
 */
function openRouterStub({ failList = false } = {}) {
  const keys = new Map(); // hash -> key object
  const calls = [];
  const logs = [];
  const capture = (...args) => {
    logs.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const seed = ({ name, workspaceId, disabled = false, limit = null, limitReset = null }) => {
    hashCounter += 1;
    const hash = `hash_${hashCounter}`;
    keys.set(hash, {
      hash,
      name,
      workspace_id: workspaceId,
      disabled,
      limit,
      limit_reset: limitReset,
      usage: 0,
    });
    return hash;
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host !== 'openrouter.ai') throw new Error(`unexpected outbound call to ${url.host}`);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const path = url.pathname.replace('/api/v1', '');
    calls.push({ method, path, query: url.search, body });

    if (path === '/workspaces' && method === 'GET') {
      return jsonResponse({
        data: [
          { id: DEFAULT_WS, name: 'Default', slug: 'default' },
          { id: TARGET_WS, name: 'Phorma Cloud', slug: 'phorma-cloud' },
        ],
        total_count: 2,
      });
    }
    if (path === '/keys' && method === 'GET') {
      if (failList) return jsonResponse({ error: { message: 'list refused' } }, 500);
      const workspaceId = url.searchParams.get('workspace_id');
      const includeDisabled = url.searchParams.get('include_disabled') === 'true';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const all = [...keys.values()].filter(
        (key) =>
          (!workspaceId || key.workspace_id === workspaceId) && (includeDisabled || !key.disabled),
      );
      // Paged deliberately, at a page size smaller than some tests need, so the
      // `offset` loop in `listWorkspaceKeys` is exercised rather than assumed.
      return jsonResponse({ data: all.slice(offset, offset + 2) });
    }
    if (path.startsWith('/keys/') && method === 'GET') {
      const key = keys.get(decodeURIComponent(path.slice('/keys/'.length)));
      return key ? jsonResponse({ data: key }) : jsonResponse({ error: { message: 'not found' } }, 404);
    }
    if (path === '/keys' && method === 'POST') {
      hashCounter += 1;
      const hash = `hash_${hashCounter}`;
      keys.set(hash, {
        hash,
        name: body?.name ?? '',
        // The whole point of requirement 36: no `workspace_id` in the body means
        // the DEFAULT workspace, so an omission is silent rather than an error.
        workspace_id: body?.workspace_id ?? DEFAULT_WS,
        disabled: false,
        limit: body?.limit ?? null,
        limit_reset: body?.limit_reset ?? null,
        usage: 0,
      });
      return jsonResponse({ key: `sk-or-v1-${hash}`, data: { hash } });
    }
    if (path.startsWith('/keys/') && method === 'PATCH') {
      const hash = decodeURIComponent(path.slice('/keys/'.length));
      const key = keys.get(hash);
      if (!key) return jsonResponse({ error: { message: 'not found' } }, 404);
      if (typeof body?.disabled === 'boolean') key.disabled = body.disabled;
      if (typeof body?.limit === 'number') key.limit = body.limit;
      if (body?.limit_reset !== undefined) key.limit_reset = body.limit_reset;
      return jsonResponse({ data: key });
    }
    throw new Error(`unexpected OpenRouter call ${method} ${path}`);
  };

  return {
    keys,
    calls,
    logs,
    seed,
    mints: () => calls.filter((call) => call.method === 'POST' && call.path === '/keys'),
    disables: () => calls.filter((call) => call.method === 'PATCH' && call.body?.disabled === true),
    limitPatches: () => calls.filter((call) => call.method === 'PATCH' && call.body?.disabled === false),
    /** Live keys of one tenant's name in one workspace - the invariant's subject. */
    enabledNamed: (tenantId, workspaceId = TARGET_WS) =>
      [...keys.values()].filter(
        (key) => key.name === runtimeKeyName(tenantId) && key.workspace_id === workspaceId && !key.disabled,
      ),
    restore: () => {
      globalThis.fetch = realFetch;
      Object.assign(console, realConsole);
    },
  };
}

// --- Helpers ---------------------------------------------------------------

async function seedTenant({ id, tier = 'team', status = 'active', keyHash = null, withCiphertext = true }) {
  await store.upsertTenant({ id, tier, status });
  if (keyHash || withCiphertext) {
    const enc = withCiphertext ? await encryptString(`sk-or-v1-${keyHash ?? 'legacy'}`, KEY_ENC_SECRET) : null;
    await DB.prepare('UPDATE tenants SET openrouter_key_id = ?, openrouter_key_enc = ? WHERE id = ?')
      .bind(keyHash, enc, id)
      .run();
  }
}

async function keyColumns(id) {
  return DB.prepare('SELECT tier, status, openrouter_key_id, openrouter_key_enc FROM tenants WHERE id = ?')
    .bind(id)
    .first();
}

/**
 * The D1 the migration writes through, with an optional refusal of the runtime-key
 * UPDATE for named tenants - the only way to sit in the mint-then-store window.
 *
 * `changes: 0` rather than a throw, because that is what the real hazard looks
 * like to `reconcileRuntimeKey`: the write ran and matched no row.
 */
function d1WithFailingStore(failFor = new Set()) {
  return {
    prepare(sql) {
      const inner = DB.prepare(sql);
      const wrap = (statement, values) => ({
        bind: (...next) => wrap(statement.bind(...next), next),
        all: () => statement.all(),
        first: () => statement.first(),
        run: async () => {
          if (/UPDATE tenants\s+SET openrouter_key_id/.test(sql) && failFor.has(values[values.length - 1])) {
            return { meta: { changes: 0 }, success: true };
          }
          return statement.run();
        },
      });
      return wrap(inner, []);
    },
  };
}

const migrate = (options = {}) =>
  migrateWorkspace({
    db: options.db ?? DB,
    provisioningKey: PROVISIONING_KEY,
    keyEncSecret: KEY_ENC_SECRET,
    workspaceId: TARGET_WS,
    ...options,
  });

// ══ 1. classifyTenant, at the boundary every later assertion rests on ══════

console.log('\nclassifyTenant names one action per tenant state');
{
  const active = { id: 'user_c', tier: 'team', status: 'active', hasKeyEnc: true, openrouterKeyId: 'h' };
  check(
    'a key already in the target workspace is already migrated',
    classifyTenant({ tenant: active, storedKey: { workspaceId: TARGET_WS, disabled: false }, workspaceId: TARGET_WS }).action === ACTIONS.alreadyMigrated,
  );
  check(
    'the same key DISABLED is a repair, not a rotation',
    classifyTenant({ tenant: active, storedKey: { workspaceId: TARGET_WS, disabled: true }, workspaceId: TARGET_WS }).action === ACTIONS.repair,
  );
  check(
    'a key in another workspace is a rotation',
    classifyTenant({ tenant: active, storedKey: { workspaceId: DEFAULT_WS, disabled: false }, workspaceId: TARGET_WS }).action === ACTIONS.rotate,
  );
  check(
    'a hash OpenRouter has never heard of is still a rotation',
    classifyTenant({ tenant: active, storedKey: null, workspaceId: TARGET_WS }).action === ACTIONS.rotate,
  );
  check(
    'no ciphertext is a first mint',
    classifyTenant({ tenant: { ...active, hasKeyEnc: false }, storedKey: null, workspaceId: TARGET_WS }).action === ACTIONS.mint,
  );
  check(
    'ciphertext with no hash is left for an operator',
    classifyTenant({ tenant: { ...active, openrouterKeyId: null }, storedKey: null, workspaceId: TARGET_WS }).action === ACTIONS.unmanaged,
  );
  for (const status of ['past_due', 'canceled']) {
    check(
      `a ${status} tenant is never touched`,
      classifyTenant({ tenant: { ...active, status }, storedKey: { workspaceId: DEFAULT_WS, disabled: false }, workspaceId: TARGET_WS }).action === ACTIONS.notActive,
    );
  }
  // Status is checked FIRST, so a cancelled tenant whose key happens to be in the
  // target workspace still reads as skipped rather than as finished work.
  check(
    'status outranks workspace membership',
    classifyTenant({ tenant: { ...active, status: 'canceled' }, storedKey: { workspaceId: TARGET_WS, disabled: false }, workspaceId: TARGET_WS }).action === ACTIONS.notActive,
  );
}

// ══ 2. Preflight refusals ══════════════════════════════════════════════════

console.log('\nThe migration refuses to run without a resolved workspace');
{
  const stub = openRouterStub();
  try {
    let message = '';
    await migrate({ workspaceId: '', apply: false }).catch((error) => { message = error.message; });
    // The failure that matters: `POST /keys` with no `workspace_id` mints into the
    // DEFAULT workspace, so a missing id would look like a clean migration.
    check('a missing workspace id is an error, not a default', /workspace id is required/.test(message), message);

    message = '';
    await migrate({ apply: true, keyEncSecret: undefined }).catch((error) => { message = error.message; });
    check('--apply without KEY_ENC_SECRET is refused up front', /KEY_ENC_SECRET/.test(message), message);
    check('neither refusal reached OpenRouter', stub.calls.length === 0, JSON.stringify(stub.calls));

    const resolved = await resolveWorkspace(PROVISIONING_KEY, 'phorma-cloud');
    check('a workspace resolves by slug', resolved.id === TARGET_WS, JSON.stringify(resolved));
    check('and by name', (await resolveWorkspace(PROVISIONING_KEY, 'Phorma Cloud')).id === TARGET_WS);
    check('and by id', (await resolveWorkspace(PROVISIONING_KEY, TARGET_WS)).slug === 'phorma-cloud');

    let refusal = '';
    await resolveWorkspace(PROVISIONING_KEY, '33333333-3333-3333-3333-333333333333').catch((error) => { refusal = error.message; });
    // A UUID is resolved rather than trusted: minting into a workspace nobody meant
    // is the one outcome a re-run cannot repair.
    check('an unknown UUID is refused, not passed through', /No OpenRouter workspace matches/.test(refusal), refusal);
    check('the refusal lists what the account does have', /Phorma Cloud/.test(refusal), refusal);
  } finally {
    stub.restore();
  }
}

// ══ 3. A dry run is read-only on both sides ════════════════════════════════

console.log('\nA dry run produces the plan and writes nothing');
{
  const stub = openRouterStub();
  try {
    const oldHash = stub.seed({ name: runtimeKeyName('user_dry'), workspaceId: DEFAULT_WS, limit: CAP.team });
    await seedTenant({ id: 'user_dry', keyHash: oldHash });

    const report = await migrate({ apply: false });
    const entry = report.tenants.find((tenant) => tenant.id === 'user_dry');
    check('the plan says rotate', entry?.action === ACTIONS.rotate, JSON.stringify(entry));
    check('it names the workspace the key is in today', entry?.storedKeyWorkspaceId === DEFAULT_WS, JSON.stringify(entry));
    check('nothing was minted', stub.mints().length === 0, JSON.stringify(stub.calls));
    check('nothing was disabled', stub.disables().length === 0, JSON.stringify(stub.calls));
    check('the old key is still enabled', stub.keys.get(oldHash).disabled === false);
    check('the tenant row is untouched', (await keyColumns('user_dry')).openrouter_key_id === oldHash);
    check('the report renders', /DRY RUN/.test(formatReport(report)) && /user_dry/.test(formatReport(report)));
  } finally {
    stub.restore();
  }
}

// ══ 4. An apply moves the key, and a SECOND run does nothing (requirement 40)

console.log('\nAn apply mints in the target workspace and retires the old key');
{
  const stub = openRouterStub();
  const purged = [];
  try {
    const oldHash = stub.seed({ name: runtimeKeyName('user_move'), workspaceId: DEFAULT_WS, limit: CAP.team });
    await seedTenant({ id: 'user_move', tier: 'team', keyHash: oldHash });

    const report = await migrate({ apply: true, only: 'user_move', purgeCache: async (id) => purged.push(id) });
    const entry = report.tenants.find((tenant) => tenant.id === 'user_move');

    check('exactly one key was minted', stub.mints().length === 1, JSON.stringify(stub.calls));
    const mint = stub.mints()[0];
    check('the mint targets the workspace explicitly', mint?.body?.workspace_id === TARGET_WS, JSON.stringify(mint?.body));
    check('at the tier cap', mint?.body?.limit === CAP.team, JSON.stringify(mint?.body));
    // The defect task 8 left here on purpose: `limit` with no reset is a LIFETIME
    // ceiling, while `monthlyCostUsd` is a monthly allowance. A migration that
    // re-mints every key is the one moment fixing it costs nothing.
    check('and on a MONTHLY reset, not a lifetime ceiling', mint?.body?.limit_reset === 'monthly', JSON.stringify(mint?.body));
    check('the key is named for the tenant', mint?.body?.name === 'phorma-tenant-user_move', JSON.stringify(mint?.body));

    check('the old key was disabled', stub.keys.get(oldHash).disabled === true);
    check('the outcome reports the retirement', entry?.outcome?.supersededKeyDisabled === true, JSON.stringify(entry?.outcome));
    // Order: the tenant must never hold two live keys, so the retirement lands
    // before the replacement exists.
    const disableIndex = stub.calls.findIndex((call) => call.body?.disabled === true);
    const mintIndex = stub.calls.findIndex((call) => call.method === 'POST');
    check('the disable precedes the mint', disableIndex >= 0 && disableIndex < mintIndex, JSON.stringify(stub.calls.map((c) => `${c.method} ${c.path}`)));

    const row = await keyColumns('user_move');
    const newHash = stub.enabledNamed('user_move')[0]?.hash;
    check('both key columns moved to the replacement', row.openrouter_key_id === newHash && Boolean(row.openrouter_key_enc), JSON.stringify(row));
    const stored = await store.runtimeKey(await store.getTenant('user_move'));
    check('the stored ciphertext decrypts to the NEW key', stored === `sk-or-v1-${newHash}`, String(stored));
    check('the placeholder ciphertext never reached the row', !String(row.openrouter_key_enc).includes('placeholder'), JSON.stringify(row));
    check('exactly one live key of that name in the target workspace', stub.enabledNamed('user_move').length === 1);
    check('and none left live in the old workspace', stub.enabledNamed('user_move', DEFAULT_WS).length === 0);
    check('the KV cache entry was purged', purged.join() === 'user_move', purged.join());
    check('the summary counts one rotation', report.summary.rotated === 1 && report.summary.failures === 0, JSON.stringify(report.summary));

    // THE requirement-40 assertion. Same command, same state, second time.
    const second = await migrate({ apply: true, only: 'user_move', purgeCache: async (id) => purged.push(id) });
    check('the second run mints nothing', stub.mints().length === 1, JSON.stringify(stub.calls.filter((c) => c.method === 'POST')));
    check('and disables nothing', stub.keys.get(oldHash).disabled === true && stub.enabledNamed('user_move').length === 1);
    check('it reports the tenant as already migrated', second.tenants[0]?.action === ACTIONS.alreadyMigrated, JSON.stringify(second.tenants[0]));
    check('the stored hash did not move', (await keyColumns('user_move')).openrouter_key_id === newHash);
    check('and it purged no cache entry it did not need to', purged.length === 1, purged.join());
  } finally {
    stub.restore();
  }
}

// ══ 5. The interrupted run: mint succeeded, store did not ══════════════════

console.log('\nA run interrupted between the mint and the store is repaired by the next one');
{
  const stub = openRouterStub();
  try {
    const oldHash = stub.seed({ name: runtimeKeyName('user_crash'), workspaceId: DEFAULT_WS, limit: CAP.pro });
    await seedTenant({ id: 'user_crash', tier: 'pro', keyHash: oldHash });

    // Run one: the D1 write matches no row, so a live key exists in the target
    // workspace that nothing points at, and its plaintext is gone for good.
    const first = await migrate({
      apply: true,
      only: 'user_crash',
      db: d1WithFailingStore(new Set(['user_crash'])),
    });
    const orphan = stub.enabledNamed('user_crash')[0];
    check('the interrupted run reports a failure', first.tenants[0]?.outcome?.action === 'mint_failed' && first.summary.failures === 1, JSON.stringify(first.tenants[0]));
    check('it left one unreferenced live key behind', Boolean(orphan) && (await keyColumns('user_crash')).openrouter_key_id === oldHash);
    check('and it is discoverable ONLY by its name', orphan.name === runtimeKeyName('user_crash'));

    // Run two: the name sweep is what makes this recoverable at all.
    const second = await migrate({ apply: true, only: 'user_crash' });
    const entry = second.tenants[0];
    check('the orphan was planned for retirement', entry?.orphans?.includes(orphan.hash), JSON.stringify(entry?.orphans));
    check('and retired', stub.keys.get(orphan.hash).disabled === true);
    check('the orphan retirement is counted', second.summary.orphansDisabled === 1, JSON.stringify(second.summary));
    const live = stub.enabledNamed('user_crash');
    const row = await keyColumns('user_crash');
    check('exactly one live key remains for the tenant', live.length === 1, JSON.stringify(live.map((k) => k.hash)));
    check('and the row points at it', row.openrouter_key_id === live[0].hash, JSON.stringify(row));
    check('the pre-migration key stayed disabled', stub.keys.get(oldHash).disabled === true);
    const stored = await store.runtimeKey(await store.getTenant('user_crash'));
    check('the tenant can run again', stored === `sk-or-v1-${live[0].hash}`, String(stored));

    // And the third run is a no-op, which is the property that makes step 5 of the
    // procedure ("re-run without --apply") a real verification.
    const mintsBefore = stub.mints().length;
    const third = await migrate({ apply: true, only: 'user_crash' });
    check('a third run changes nothing', stub.mints().length === mintsBefore && third.tenants[0]?.action === ACTIONS.alreadyMigrated, JSON.stringify(third.tenants[0]));
  } finally {
    stub.restore();
  }
}

// ══ 6. The states the migration must NOT act on ════════════════════════════

console.log('\nTenants the migration deliberately leaves alone');
{
  const stub = openRouterStub();
  try {
    const canceledHash = stub.seed({ name: runtimeKeyName('user_gone'), workspaceId: DEFAULT_WS, disabled: true });
    await seedTenant({ id: 'user_gone', tier: 'starter', status: 'canceled', keyHash: canceledHash });
    // Ciphertext, no hash: a replacement could not retire the key it replaces, so
    // minting one would leave a live key unreachable forever.
    await seedTenant({ id: 'user_unmanaged', tier: 'starter', keyHash: null, withCiphertext: true });
    await seedTenant({ id: 'user_pastdue', tier: 'pro', status: 'past_due', keyHash: stub.seed({ name: runtimeKeyName('user_pastdue'), workspaceId: DEFAULT_WS }) });

    const report = await migrate({ apply: true });
    const actionFor = (id) => report.tenants.find((tenant) => tenant.id === id)?.action;
    check('a canceled tenant is skipped', actionFor('user_gone') === ACTIONS.notActive);
    check('a past_due tenant is skipped', actionFor('user_pastdue') === ACTIONS.notActive);
    check('an unmanageable key is skipped with a reason an operator can act on', actionFor('user_unmanaged') === ACTIONS.unmanaged && /by hand/.test(report.tenants.find((t) => t.id === 'user_unmanaged').reason));
    check('none of them was minted for', stub.enabledNamed('user_gone').length === 0 && stub.enabledNamed('user_unmanaged').length === 0 && stub.enabledNamed('user_pastdue').length === 0);
    check('no runtime key was written for them', (await keyColumns('user_unmanaged')).openrouter_key_id === null);
  } finally {
    stub.restore();
  }
}

console.log('\nA tenant with no key at all gets a first one, in the right workspace');
{
  const stub = openRouterStub();
  try {
    await seedTenant({ id: 'user_fresh', tier: 'starter', keyHash: null, withCiphertext: false });
    const report = await migrate({ apply: true, only: 'user_fresh' });
    check('the action is a first mint', report.tenants[0]?.action === ACTIONS.mint, JSON.stringify(report.tenants[0]));
    check('nothing was reported as superseded', report.tenants[0]?.outcome?.supersededKeyDisabled === null, JSON.stringify(report.tenants[0]?.outcome));
    const live = stub.enabledNamed('user_fresh');
    check('the key landed in the target workspace at the starter cap', live.length === 1 && live[0].limit === CAP.starter && live[0].limit_reset === 'monthly', JSON.stringify(live));
    check('and the row points at it', (await keyColumns('user_fresh')).openrouter_key_id === live[0].hash);
  } finally {
    stub.restore();
  }
}

console.log('\nA key already in the workspace but DISABLED is re-enabled, not replaced');
{
  const stub = openRouterStub();
  try {
    const hash = stub.seed({ name: runtimeKeyName('user_resub'), workspaceId: TARGET_WS, disabled: true, limit: CAP.starter });
    await seedTenant({ id: 'user_resub', tier: 'team', keyHash: hash });

    const report = await migrate({ apply: true, only: 'user_resub' });
    check('the action is a repair', report.tenants[0]?.action === ACTIONS.repair, JSON.stringify(report.tenants[0]));
    check('no replacement was minted', stub.mints().length === 0, JSON.stringify(stub.calls));
    check('the key is live again at the CURRENT tier cap', stub.keys.get(hash).disabled === false && stub.keys.get(hash).limit === CAP.team, JSON.stringify(stub.keys.get(hash)));
    check('the stored hash is unchanged', (await keyColumns('user_resub')).openrouter_key_id === hash);
  } finally {
    stub.restore();
  }
}

console.log('\nKeys in the workspace that no tenant row claims are reported, never touched');
{
  const stub = openRouterStub();
  try {
    const stray = stub.seed({ name: 'made-by-hand', workspaceId: TARGET_WS });
    const report = await migrate({ apply: true, only: 'user_move' });
    check('the stray key is listed', report.unclaimedKeys.some((key) => key.hash === stray), JSON.stringify(report.unclaimedKeys));
    check('and left enabled for an operator to judge', stub.keys.get(stray).disabled === false);
    check('the report says so in prose', /no tenant row claims/.test(formatReport(report)));
  } finally {
    stub.restore();
  }
}

// ══ 7. The CLI's own hazards: inlined SQL and the dry-run guarantee ════════

console.log('\nThe wrangler D1 shim cannot be talked into a write or an injection');
{
  // A dry run promising to be read-only is only worth something if something
  // enforces it. Nothing is spawned on this path, so the refusal is provable
  // without a shell.
  const readOnly = wranglerD1({ database: 'phorma-cloud', env: 'hosted', local: false, allowWrites: false });
  let message = '';
  await readOnly
    .prepare('UPDATE tenants SET tier = ? WHERE id = ?')
    .bind('team', 'user_x')
    .run()
    .catch((error) => { message = error.message; });
  check('a dry run refuses a non-SELECT statement', /Refusing to run a non-SELECT/.test(message), message);

  // `wrangler d1 execute --command` splits on `;` before SQLite sees the text, so a
  // semicolon inside a quoted value would still cut the statement in two.
  const writable = wranglerD1({ database: 'phorma-cloud', env: 'hosted', local: false, allowWrites: true });
  message = '';
  await writable.prepare('SELECT ?').bind('a;DROP TABLE tenants').all().catch((error) => { message = error.message; });
  check('a semicolon in a bound value is refused, not escaped', /semicolon/.test(message), message);

  check("a quote is doubled, SQL's own escape", sqlLiteral("O'Brien") === "'O''Brien'");
  check('a null is NULL, not the string', sqlLiteral(null) === 'NULL');
  check('a number is bare', sqlLiteral(44) === '44');
  for (const [label, value] of [
    ['an object', { toString: () => "'" }],
    ['an array', ["'"]],
    ['a NUL byte', 'a\u0000b'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ]) {
    let refused = false;
    try { sqlLiteral(value); } catch { refused = true; }
    check(`${label} is refused rather than stringified`, refused);
  }
  check('placeholders are filled left to right', renderSql('SELECT ?, ?', ['a', 1]) === "SELECT 'a', 1");
  for (const [label, sql, values] of [
    ['too few values', 'SELECT ?, ?', ['a']],
    ['too many values', 'SELECT ?', ['a', 'b']],
  ]) {
    let refused = false;
    try { renderSql(sql, values); } catch { refused = true; }
    check(`${label} is a hard error`, refused);
  }

  // THE THIRD STATEMENT. `reconcileRuntimeKey` caps a key at the tier allowance plus
  // the tenant's unspent grants, so `grantPool` now runs through this shim once per
  // tenant. The shim's two rules are properties of the STATEMENT, so they are
  // asserted against the real SQL rather than by spawning wrangler at a remote
  // database: it must satisfy the dry run's `^\s*SELECT` guard (it is multi-line and
  // indented, which is precisely where an anchored regex goes wrong) and it must
  // carry no semicolon, since `--command` splits on one before SQLite sees it.
  {
    const seen = [];
    const recorder = {
      prepare(sql) {
        const statement = {
          bind: (...values) => { seen.push({ sql, values }); return statement; },
          first: async () => null,
          all: async () => ({ results: [], meta: {} }),
          run: async () => ({ results: [], meta: {} }),
        };
        return statement;
      },
    };
    const pool = await new TenantStore({ DB: recorder }).grantPool('user_shim');
    check('the pool read degrades to an empty pool on a NULL row', pool.costUsdRemaining === 0 && pool.creditsRemaining === 0, JSON.stringify(pool));
    const rendered = renderSql(seen[0]?.sql ?? '', seen[0]?.values ?? []);
    check('the grant pool statement is a SELECT the dry-run guard admits', /^\s*SELECT\b/i.test(rendered), rendered.slice(0, 120));
    check('and it carries no semicolon for --command to split on', !rendered.includes(';'), rendered.slice(0, 120));
    check('the tenant id is inlined as a quoted literal', rendered.includes("'user_shim'"), rendered.slice(-80));
  }
}

console.log("\nThe CLI refuses --local --apply, because the local driver reports no row count");
{
  let message = '';
  try { parseArgs(['--workspace', 'phorma-cloud', '--local', '--apply']); } catch (error) { message = error.message; }
  // A local apply STORES the key and then reports `mint_failed`, so the next run
  // mints again - the double mint requirement 40 exists to prevent.
  check('the combination is refused with the reason', /--local cannot be combined with --apply/.test(message), message);
  check('--local alone is a legitimate plan', parseArgs(['--workspace', 'w', '--local']).local === true);
  check('a dry run is the default', parseArgs(['--workspace', 'w']).apply === false);
  check('an unknown flag is refused', (() => { try { parseArgs(['--rotate-everything']); return false; } catch { return true; } })());

  check(
    'wrangler JSON survives progress lines before the payload',
    parseWranglerJson('| uploading\n[{"results":[{"id":"a"}],"meta":{"changes":1}}]\n')[0].results[0].id === 'a',
  );
  check('unparseable output is an error, not an empty result set', (() => {
    try { parseWranglerJson('no json here'); return false; } catch { return true; }
  })());
}

// ══ 8. Property: any interruption pattern converges (requirement 40) ════════

/**
 * Runs deliberately modest: each iteration migrates a small fleet TWICE over a
 * real local D1, so the cost is real statements rather than arithmetic. 30 is
 * enough to cover every interruption subset of a 1-3 tenant fleet many times over
 * while keeping the suite in the seconds.
 */
const CONVERGENCE_RUNS = 30;

console.log('\nProperty: whatever is interrupted, re-running converges on one live key per tenant');
{
  let iteration = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          tier: fc.constantFrom('starter', 'pro', 'team'),
          status: fc.constantFrom('active', 'active', 'past_due', 'canceled'),
          keyState: fc.constantFrom('in_default', 'in_target', 'no_key', 'unknown_hash', 'no_hash'),
          interrupt: fc.boolean(),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      async (fleet) => {
        iteration += 1;
        const stub = openRouterStub();
        try {
          const tenants = [];
          for (const [index, spec] of fleet.entries()) {
            const id = `user_p${iteration}_${index}`;
            let hash = null;
            if (spec.keyState === 'in_default') hash = stub.seed({ name: runtimeKeyName(id), workspaceId: DEFAULT_WS });
            if (spec.keyState === 'in_target') hash = stub.seed({ name: runtimeKeyName(id), workspaceId: TARGET_WS });
            if (spec.keyState === 'unknown_hash') hash = `hash_never_minted_${id}`;
            await seedTenant({
              id,
              tier: spec.tier,
              status: spec.status,
              keyHash: spec.keyState === 'no_hash' ? null : hash,
              withCiphertext: spec.keyState !== 'no_key',
            });
            tenants.push({ id, spec, hash });
          }
          const interrupted = new Set(tenants.filter((tenant) => tenant.spec.interrupt).map((tenant) => tenant.id));

          for (const tenant of tenants) {
            await migrateWorkspace({
              db: d1WithFailingStore(interrupted),
              provisioningKey: PROVISIONING_KEY,
              keyEncSecret: KEY_ENC_SECRET,
              workspaceId: TARGET_WS,
              apply: true,
              only: tenant.id,
            });
          }
          for (const tenant of tenants) {
            await migrateWorkspace({
              db: DB,
              provisioningKey: PROVISIONING_KEY,
              keyEncSecret: KEY_ENC_SECRET,
              workspaceId: TARGET_WS,
              apply: true,
              only: tenant.id,
            });
          }

          const mintsBefore = stub.mints().length;
          for (const tenant of tenants) {
            const report = await migrateWorkspace({
              db: DB,
              provisioningKey: PROVISIONING_KEY,
              keyEncSecret: KEY_ENC_SECRET,
              workspaceId: TARGET_WS,
              apply: true,
              only: tenant.id,
            });
            const entry = report.tenants[0];
            const row = await keyColumns(tenant.id);
            const live = stub.enabledNamed(tenant.id);

            if (tenant.spec.status !== 'active') {
              // Untouched, whatever their key state: the migration must not
              // reactivate a key the cancellation retired.
              if (entry.action !== ACTIONS.notActive) throw new Error(`${tenant.id}: acted on a ${tenant.spec.status} tenant (${entry.action})`);
              if (row.openrouter_key_id !== (tenant.spec.keyState === 'no_hash' ? null : tenant.hash)) {
                throw new Error(`${tenant.id}: moved the stored hash of a ${tenant.spec.status} tenant`);
              }
              continue;
            }
            if (tenant.spec.keyState === 'no_hash') {
              if (entry.action !== ACTIONS.unmanaged) throw new Error(`${tenant.id}: acted on an unmanageable key (${entry.action})`);
              continue;
            }
            // The two states that must never exist, for every other active tenant.
            if (live.length !== 1) throw new Error(`${tenant.id}: ${live.length} live keys in the target workspace`);
            if (row.openrouter_key_id !== live[0].hash) throw new Error(`${tenant.id}: the row points at ${row.openrouter_key_id}, the live key is ${live[0].hash}`);
            if (stub.enabledNamed(tenant.id, DEFAULT_WS).length !== 0) throw new Error(`${tenant.id}: still has a live key in the old workspace`);
            if (live[0].limit_reset !== 'monthly' && tenant.spec.keyState !== 'in_target') {
              throw new Error(`${tenant.id}: minted key has no monthly reset`);
            }
            const stored = await store.runtimeKey(await store.getTenant(tenant.id));
            if (stored !== `sk-or-v1-${live[0].hash}`) throw new Error(`${tenant.id}: stored ciphertext does not decrypt to the live key`);
          }
          // Idempotence, stated as arithmetic: the run that found everything
          // already done minted nothing.
          if (stub.mints().length !== mintsBefore) throw new Error('a settled fleet was minted for again');
          return true;
        } finally {
          stub.restore();
        }
      },
    ),
    { numRuns: CONVERGENCE_RUNS },
  );
  check('every interruption pattern converges on one live key per active tenant', true);
}

// --- Result ----------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.error(`workspace-migration: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('workspace-migration: all checks passed.');
process.exit(0);
