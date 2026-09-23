/**
 * `BackupStore` - the D1 half of hosted workflow backup
 * (cloud-workflow-backup, Requirements 9, 10, 16, 17, 20).
 *
 * ## What cannot be read off the SQL
 *
 * Three claims, and each one is a way this feature could destroy the data it
 * exists to protect:
 *
 * 1. **Optimistic concurrency has exactly one winner.** Two studios on two
 *    machines saving the same workflow must not silently last-write-wins. The gate
 *    is a conditional `UPDATE ... WHERE revision = ?` whose `meta.changes` is the
 *    signal - and a read-then-write with the same intent lets both through while
 *    reading just as convincingly.
 * 2. **A delete is soft, and re-deleting does not extend the window.** A
 *    tombstone is restorable for 30 days from the FIRST delete. An idempotent
 *    delete that moved the clock would keep a workflow alive forever, which sounds
 *    harmless until it is the reason a purge never happens.
 * 3. **The workflow cap is a ceiling on NEW workflows only.** A tenant at the cap
 *    must keep accepting uploads for workflows that already have a row, or an
 *    existing backup goes stale because of a limit - the exact failure this
 *    feature was built to prevent.
 *
 * ## Harness
 *
 * A REAL local D1 with the REAL migrations applied, reached from Node through
 * Miniflare's proxy, so the SQL under test is the SQL that ships. `0002_telemetry`
 * is skipped deliberately: leaving it out proves 0005 does not secretly depend on
 * it.
 *
 * Every statement goes through `withLoopbackRetryD1`, and per-iteration setup is
 * batched, because each proxied statement costs one loopback socket.
 *
 * Run: npx tsx cloud/test/backup-store.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';

import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';
import {
  BackupStore,
  LAPSE_READ_WINDOW_MS,
  MAX_SPEC_BYTES,
  REVISIONS_KEPT,
  TOMBSTONE_WINDOW_MS,
  backupWorkflowCaps,
  lapseReadAccess,
  tombstoneDaysRemaining,
} from '../src/backups.ts';
import { TIERS } from '../src/tenants.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

/** Property iterations. Each is a handful of loopback D1 calls. */
const RUNS = 40;

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
  d1Databases: { DB: 'phorma-cloud-backup-store' },
});

const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements. Same reader `tenant-billing.test.mjs` uses,
 * including the CRLF tolerance: with `core.autocrlf=true` a `--` comment stripper
 * anchored on `$` matches nothing against a line still carrying its `\r`, and the
 * comment-only tail then reaches D1 as "SQL code did not contain a statement".
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

for (const file of [
  '0001_init.sql',
  '0003_billing.sql',
  '0004_billing_ordering.sql',
  '0005_workflow_backups.sql',
  // 0006 adds the nullable `body_key` column this store now selects. Applied here
  // because it is applied on the hosted database, not to make a test pass.
  '0006_organisations.sql',
]) {
  for (const statement of statementsOf(file)) {
    await DB.prepare(statement).run();
  }
}

const store = new BackupStore({ DB });

/** Seeds a tenant on a tier, so the cap lookup has something to read. */
async function seedTenant(id, tier = 'starter') {
  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO tenants (id, email, tier, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET tier = excluded.tier`,
  )
    .bind(id, `${id}@example.com`, tier, now, now)
    .run();
}

/** The `next` payload `claimRevision` takes. */
function next(overrides = {}) {
  return {
    name: 'Invoice triage',
    specHash: 'hash-1',
    sizeBytes: 2048,
    savedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- 1. Constants agree with the resolved decisions ------------------------

console.log('\nRetention and cap constants (resolved decisions 3)');
{
  check('10 revisions per workflow', REVISIONS_KEPT === 10, String(REVISIONS_KEPT));
  check('30 day tombstone window', TOMBSTONE_WINDOW_MS === 30 * 24 * 60 * 60 * 1000);
  check('90 day lapse read window', LAPSE_READ_WINDOW_MS === 90 * 24 * 60 * 60 * 1000);
  // Deliberately different numbers: one is about a deleted workflow, the other
  // about a lapsed subscription.
  check('the two windows are not the same number', TOMBSTONE_WINDOW_MS !== LAPSE_READ_WINDOW_MS);
  check('2MB per spec', MAX_SPEC_BYTES === 2 * 1024 * 1024, String(MAX_SPEC_BYTES));
  check(
    'workflow caps are 25 / 100 / 250',
    TIERS.starter.backupWorkflows === 25 &&
      TIERS.pro.backupWorkflows === 100 &&
      TIERS.team.backupWorkflows === 250,
    JSON.stringify(backupWorkflowCaps()),
  );
}

// --- 2. First upload ------------------------------------------------------

console.log('\nA workflow backed up for the first time');
{
  await seedTenant('user_first');
  const created = await store.claimRevision('user_first', 'wf-a', null, next());

  check('the first accepted upload is revision 1', created.ok === true && created.record.revision === 1, JSON.stringify(created));
  check('it is not a tombstone', created.ok === true && created.record.deletedAt === null);

  const read = await store.get('user_first', 'wf-a');
  check('the row round-trips through D1', read?.revision === 1 && read.name === 'Invoice triage', JSON.stringify(read));
  check('savedAt is the client timestamp', read?.savedAt === '2026-09-01T00:00:00.000Z');
  check('updatedAt is the worker timestamp, and differs', read?.updatedAt !== read?.savedAt, `${read?.updatedAt}`);
  check('the size is recorded for the cap and for display', read?.sizeBytes === 2048);
}

{
  // A client claiming to hold revision 5 of something this account has never
  // stored is a wrong id or a wiped account. Refusing beats silently starting at
  // 1 and letting them believe they restored something.
  await seedTenant('user_ghost');
  const refused = await store.claimRevision('user_ghost', 'wf-never', 5, next());
  check('an If-Match against a non-existent row is a conflict', refused.ok === false && refused.reason === 'conflict', JSON.stringify(refused));
  check('the reported revision is 0 (nothing stored)', refused.ok === false && refused.revision === 0);
  check('nothing was written', (await store.get('user_ghost', 'wf-never')) === null);
}

// --- 3. Optimistic concurrency -------------------------------------------

console.log('\nOptimistic concurrency (Requirement 16)');
{
  await seedTenant('user_conc');
  await store.claimRevision('user_conc', 'wf-b', null, next());

  const ok = await store.claimRevision('user_conc', 'wf-b', 1, next({ specHash: 'hash-2' }));
  check('a matching If-Match increments by exactly one', ok.ok === true && ok.record.revision === 2, JSON.stringify(ok));

  const stale = await store.claimRevision('user_conc', 'wf-b', 1, next({ specHash: 'hash-3' }));
  check('a stale If-Match is a conflict', stale.ok === false && stale.reason === 'conflict', JSON.stringify(stale));
  check('the conflict carries the CURRENT revision', stale.ok === false && stale.revision === 2, JSON.stringify(stale));
  check('the stale upload changed nothing', (await store.get('user_conc', 'wf-b'))?.specHash === 'hash-2');

  // A null If-Match on an EXISTING row is last-write-wins over a copy the client
  // has never seen. Nothing here merges (Requirement 16.6), so it is refused.
  const blind = await store.claimRevision('user_conc', 'wf-b', null, next({ specHash: 'hash-4' }));
  check('a null If-Match on an existing row is a conflict', blind.ok === false && blind.reason === 'conflict', JSON.stringify(blind));
  check('the blind upload changed nothing', (await store.get('user_conc', 'wf-b'))?.specHash === 'hash-2');
}

console.log('\nProperty: exactly one winner per If-Match value (16.8)');
{
  // `team` and a per-iteration cleanup, both deliberately. Each iteration creates
  // a NEW workflow, so on `starter` the property ran out of the 25-workflow cap at
  // iteration 26 and reported a concurrency bug that was really the cap doing its
  // job. A property that is not hermetic tests the wrong thing eventually.
  await seedTenant('user_race', 'team');
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async concurrency => {
      const workflowId = `wf-race-${Math.random().toString(36).slice(2, 10)}`;
      const first = await store.claimRevision('user_race', workflowId, null, next());
      if (first.ok !== true) return false;

      // Every writer carries the SAME If-Match. Exactly one may be accepted.
      const results = await Promise.all(
        Array.from({ length: concurrency }, (_unused, index) =>
          store.claimRevision('user_race', workflowId, 1, next({ specHash: `h-${index}` })),
        ),
      );
      const accepted = results.filter(result => result.ok === true);
      const stored = await store.get('user_race', workflowId);
      await store.hardDelete('user_race', workflowId);

      // Exactly one winner, it claimed revision 2, and every loser was told the
      // real revision so it can retry against something true.
      return (
        accepted.length === 1 &&
        accepted[0].record.revision === 2 &&
        stored?.revision === 2 &&
        results
          .filter(result => result.ok === false)
          .every(result => result.reason === 'conflict' && result.revision === 2)
      );
    }),
    { numRuns: RUNS },
  );
  check('one accepted upload per If-Match, whatever the concurrency', true);
}

console.log('\nProperty: revision is strictly increasing and never repeats (16.7)');
{
  // `team` plus per-iteration cleanup, for the same hermeticity reason as above.
  await seedTenant('user_mono', 'team');
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async uploads => {
      const workflowId = `wf-mono-${Math.random().toString(36).slice(2, 10)}`;
      const seen = [];
      let revision = null;
      for (let index = 0; index < uploads; index += 1) {
        const result = await store.claimRevision(
          'user_mono',
          workflowId,
          revision,
          next({ specHash: `h-${index}` }),
        );
        if (result.ok !== true) return false;
        seen.push(result.record.revision);
        revision = result.record.revision;
      }
      await store.hardDelete('user_mono', workflowId);
      // Strictly increasing, starting at 1, no repeats.
      return (
        seen.length === new Set(seen).size &&
        seen.every((value, index) => value === index + 1)
      );
    }),
    { numRuns: RUNS },
  );
  check('revisions count up from 1 with no gaps and no repeats', true);
}

// --- 4. The workflow cap -------------------------------------------------

console.log('\nThe per-tier workflow cap (Requirements 10.9-10.11)');
{
  await seedTenant('user_cap', 'starter');
  const cap = TIERS.starter.backupWorkflows;

  // Batched: each statement is a loopback socket, and this needs `cap` rows.
  const now = new Date().toISOString();
  await DB.batch(
    Array.from({ length: cap }, (_unused, index) =>
      DB.prepare(
        `INSERT INTO workflow_backups
           (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
         VALUES ('user_cap', ?, 'Filler', 1, 'h', 10, ?, ?, NULL)`,
      ).bind(`wf-filler-${index}`, now, now),
    ),
  );
  check('the tenant is at the cap', (await store.count('user_cap')) === cap, String(await store.count('user_cap')));

  const refused = await store.claimRevision('user_cap', 'wf-new', null, next());
  check('a NEW workflow is refused at the cap', refused.ok === false && refused.reason === 'workflow-cap', JSON.stringify(refused));
  check('the refusal names the cap', refused.ok === false && refused.cap === cap, JSON.stringify(refused));
  check('every existing backup is intact', (await store.count('user_cap')) === cap);

  // The half that matters: an EXISTING backup must not go stale because of a cap.
  const existing = await store.claimRevision('user_cap', 'wf-filler-0', 1, next({ specHash: 'h2' }));
  check(
    'an EXISTING workflow still accepts uploads at the cap (10.11)',
    existing.ok === true && existing.record.revision === 2,
    JSON.stringify(existing),
  );
}

{
  // A higher tier has a higher ceiling, read from the tenant row rather than
  // assumed.
  await seedTenant('user_pro', 'pro');
  const accepted = await store.claimRevision('user_pro', 'wf-pro', null, next());
  check('a pro tenant is nowhere near the starter cap', accepted.ok === true, JSON.stringify(accepted));
}

// --- 5. Soft delete, tombstones and purge --------------------------------

console.log('\nSoft delete and tombstones (Requirement 17)');
{
  await seedTenant('user_del');
  await store.claimRevision('user_del', 'wf-c', null, next());

  check('the first delete reports a change', (await store.softDelete('user_del', 'wf-c')) === true);
  const tombstone = await store.get('user_del', 'wf-c');
  check('the row survives as a tombstone', tombstone !== null, 'row gone');
  check('deleted_at is set', typeof tombstone?.deletedAt === 'string', JSON.stringify(tombstone));
  check('the revision is untouched by a delete', tombstone?.revision === 1);

  const firstDeletedAt = tombstone.deletedAt;
  check('re-deleting reports no change', (await store.softDelete('user_del', 'wf-c')) === false);
  check(
    'a repeated delete does NOT extend the 30 day window',
    (await store.get('user_del', 'wf-c'))?.deletedAt === firstDeletedAt,
    `${firstDeletedAt} -> ${(await store.get('user_del', 'wf-c'))?.deletedAt}`,
  );

  // A tombstone is listed, because the user needs to see the countdown to act.
  const listed = await store.list('user_del');
  check('a tombstone is still listed', listed.some(entry => entry.workflowId === 'wf-c'), JSON.stringify(listed));

  // Saving it again revives it: the workflow is back in the library and being
  // saved, which is a clearer statement of intent than an undelete button.
  const revived = await store.claimRevision('user_del', 'wf-c', 1, next({ specHash: 'h-revived' }));
  check('an upload revives a tombstone', revived.ok === true && revived.record.deletedAt === null, JSON.stringify(revived));
  check('the revived row is no longer a tombstone', (await store.get('user_del', 'wf-c'))?.deletedAt === null);
}

console.log('\nTombstone ordering and the retention sweep');
{
  await seedTenant('user_sweep');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - TOMBSTONE_WINDOW_MS - 60_000).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  await DB.batch([
    DB.prepare(
      `INSERT INTO workflow_backups
         (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
       VALUES ('user_sweep', 'wf-live', 'Live', 1, 'h', 10, ?, ?, NULL)`,
    ).bind(now, now),
    DB.prepare(
      `INSERT INTO workflow_backups
         (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
       VALUES ('user_sweep', 'wf-old', 'Expired', 1, 'h', 10, ?, ?, ?)`,
    ).bind(now, now, old),
    DB.prepare(
      `INSERT INTO workflow_backups
         (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
       VALUES ('user_sweep', 'wf-recent', 'Recent', 1, 'h', 10, ?, ?, ?)`,
    ).bind(now, now, recent),
  ]);

  const listed = await store.list('user_sweep');
  check('live rows come before tombstones', listed[0].deletedAt === null, JSON.stringify(listed.map(e => [e.workflowId, e.deletedAt])));

  const expired = await store.expiredTombstones();
  const ids = expired.map(entry => entry.workflowId);
  check('the sweep finds the expired tombstone', ids.includes('wf-old'), JSON.stringify(ids));
  check('the sweep leaves an in-window tombstone alone (17.5)', !ids.includes('wf-recent'), JSON.stringify(ids));
  check('the sweep never touches a live row', !ids.includes('wf-live'), JSON.stringify(ids));
}

console.log('\nPurge and delete-all');
{
  await seedTenant('user_purge');
  await store.claimRevision('user_purge', 'wf-d', null, next());
  check('hardDelete removes the row', (await store.hardDelete('user_purge', 'wf-d')) === true);
  check('the row is gone', (await store.get('user_purge', 'wf-d')) === null);
  check('hardDelete is idempotent', (await store.hardDelete('user_purge', 'wf-d')) === false);

  await seedTenant('user_all');
  await store.claimRevision('user_all', 'wf-e', null, next());
  await store.claimRevision('user_all', 'wf-f', null, next());
  const removed = await store.deleteAllForTenant('user_all');
  // Whole ROWS come back, not ids, so the caller can delete the bodies: this table
  // is the ONLY index of which R2 keys belong to a tenant, and a claimed row's keys
  // live under a prefix that only `body_key` records (Requirement 4.7).
  check(
    'delete-all reports every workflow id',
    removed.map(row => row.workflowId).sort().join(',') === 'wf-e,wf-f',
    JSON.stringify(removed),
  );
  check(
    'and each row carries the prefix its bodies live under',
    removed.every(row => 'bodyKey' in row),
    JSON.stringify(removed),
  );
  check('the tenant has no rows left', (await store.count('user_all')) === 0);
  check('delete-all on an empty tenant is a no-op', (await store.deleteAllForTenant('user_all')).length === 0);
}

// --- 6. Tenant isolation -------------------------------------------------

console.log('\nTenant isolation (Requirement 9.5)');
{
  await seedTenant('user_x');
  await seedTenant('user_y');
  await store.claimRevision('user_x', 'wf-shared-id', null, next({ name: 'Mine' }));
  await store.claimRevision('user_y', 'wf-shared-id', null, next({ name: 'Theirs' }));

  // The SAME workflow id under two tenants is two independent rows: the primary
  // key is the pair, so one account can never read or overwrite the other's.
  check('each tenant sees only their own row', (await store.list('user_x')).length === 1);
  check('the names do not cross', (await store.get('user_x', 'wf-shared-id'))?.name === 'Mine');
  check('the other tenant keeps theirs', (await store.get('user_y', 'wf-shared-id'))?.name === 'Theirs');

  await store.hardDelete('user_x', 'wf-shared-id');
  check("deleting one tenant's row leaves the other's", (await store.get('user_y', 'wf-shared-id')) !== null);
}

// --- 7. Pure helpers ----------------------------------------------------

console.log('\ntombstoneDaysRemaining');
{
  const now = Date.UTC(2026, 8, 14);
  check('a fresh tombstone has 30 days', tombstoneDaysRemaining(new Date(now).toISOString(), now) === 30);
  check(
    'a 29 day old tombstone has 1 day',
    tombstoneDaysRemaining(new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString(), now) === 1,
  );
  // Clamped rather than negative: the sweep is a cron and may not have run yet.
  check(
    'an over-age tombstone reads 0, never negative',
    tombstoneDaysRemaining(new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(), now) === 0,
  );
  check('an unparseable timestamp reads 0', tombstoneDaysRemaining('not a date', now) === 0);
}

console.log('\nlapseReadAccess (Requirement 20)');
{
  const now = Date.UTC(2026, 8, 14);
  const secondsAgo = days => Math.floor((now - days * 24 * 60 * 60 * 1000) / 1000);

  const active = lapseReadAccess({ status: 'active', billingStatusAt: secondsAgo(500) }, now);
  check('an active tenant reads with no expiry', active.allowed === true && active.daysRemaining === null);

  // `past_due` keeps everything: requirement 18 keeps their tier, data and key.
  const pastDue = lapseReadAccess({ status: 'past_due', billingStatusAt: secondsAgo(200) }, now);
  check('a past_due tenant keeps read access with no expiry', pastDue.allowed === true && pastDue.daysRemaining === null);

  const lapsed = lapseReadAccess({ status: 'canceled', billingStatusAt: secondsAgo(10) }, now);
  check('a recently cancelled tenant can still read', lapsed.allowed === true, JSON.stringify(lapsed));
  check('and is told how long is left', lapsed.daysRemaining === 80, String(lapsed.daysRemaining));

  const expired = lapseReadAccess({ status: 'canceled', billingStatusAt: secondsAgo(120) }, now);
  check('past 90 days the read window has closed', expired.allowed === false && expired.daysRemaining === 0, JSON.stringify(expired));

  // A hand-run `/api/deactivate` is an unordered write and supplies no clock.
  // Refusing on a timestamp we never recorded would destroy access on the
  // strength of a missing value - the exact class of loss this feature prevents.
  const noClock = lapseReadAccess({ status: 'canceled', billingStatusAt: 0 }, now);
  check('a cancellation with no clock keeps read access', noClock.allowed === true && noClock.daysRemaining === null, JSON.stringify(noClock));
}

await mf.dispose();

console.log(failures === 0 ? '\nAll backup-store checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
