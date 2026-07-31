/**
 * Durable workflow state for the Cloudflare Worker host (task 18.5,
 * Requirements 12.13, 18.5, 18.6).
 *
 * No worker and no Durable Object: `DurableWorkflowStateStore` is exercised
 * against a real SQLite database via Node's built-in `node:sqlite`, using the
 * exact tagged-template shape the Durable Object's `Agent.sql` exposes. That is
 * enough to pin the two properties the design calls out by name — a
 * `compareAndSet` race resolves exactly one caller true via a single
 * conditional statement with no lease (12.13, 18.6), and TTL expiry / prune-oldest
 * eviction behave per Requirement 12 — plus a check that the worker's data-fetch
 * path still runs every request through `assertPublicHttpUrl` (18.5), unaffected
 * by anything in this module.
 *
 * Run: npx -y tsx cloud/test/workflow-state.test.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import {
  DurableFixtureStore,
  DurableWorkflowStateStore,
  ensureWorkflowStateTable,
} from '../src/workflow-state.ts';
import { assertPublicHttpUrl, createWorkerDataFetcher } from '../src/data-host.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function rejection(promise) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * A `DurableSqlExecutor` backed by a real, in-memory SQLite database — the same
 * tagged-template shape `Agent.sql` exposes, so `DurableWorkflowStateStore`
 * exercises its actual SQL, not a stand-in.
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

function newStore(overrides = {}) {
  const sql = sqliteExecutor();
  ensureWorkflowStateTable(sql);
  const store = new DurableWorkflowStateStore({ sql, ...overrides });
  return { sql, store };
}

// ── Concurrent compareAndSet (12.13, 18.6) ──────────────────────────────────

console.log('\nConcurrent compareAndSet');
{
  const { store } = newStore();
  const key = 'wf-1::idem:order-42';

  const outcomes = await Promise.all(
    Array.from({ length: 25 }, (_, i) => store.compareAndSet(key, undefined, `caller-${i}`)),
  );
  const winners = outcomes.filter(Boolean);
  check('exactly one of 25 concurrent claims resolves true', winners.length === 1, JSON.stringify(outcomes));

  const winnerIndex = outcomes.findIndex(Boolean);
  const stored = await store.get(key);
  check(
    'the stored value is the winning caller\'s value',
    stored?.value === `caller-${winnerIndex}`,
    JSON.stringify(stored),
  );
}

{
  // A smaller race with an EXPECTED (non-absent) value, matching a watermark
  // or delta-hash advance racing against itself.
  const { store } = newStore();
  const key = 'wf-1::wm:stream';
  await store.set(key, 'v0');

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.compareAndSet(key, 'v0', `v-${i}`)),
  );
  check('exactly one of 10 concurrent CAS-from-v0 calls resolves true', outcomes.filter(Boolean).length === 1);
}

// ── TTL expiry (Requirement 12.18) ──────────────────────────────────────────

console.log('\nTTL expiry');
{
  let now = 1_000;
  const { store } = newStore({ now: () => now });
  const key = 'wf-1::user:report';

  await store.set(key, 'fresh', { ttlSec: 5 });
  check('an unexpired entry reads back before its TTL', (await store.get(key))?.value === 'fresh');

  now += 5_001;
  check('a TTL-expired entry reads as absent via get', await store.get(key) === undefined);
  check('a TTL-expired entry is excluded from list', (await store.list('wf-1::user:')).length === 0);

  const claimed = await store.compareAndSet(key, 'fresh', 'stolen');
  check(
    'an expired value is absent for the expected side of compareAndSet too',
    claimed === false,
  );
  const reclaimed = await store.compareAndSet(key, undefined, 'reclaimed');
  check('an expired entry can be reclaimed as if it were absent', reclaimed === true);
}

{
  // Namespace default TTL: idem: defaults to 7 days, so a claim with no
  // explicit ttlSec still expires eventually rather than living forever.
  let now = 0;
  const { store } = newStore({ now: () => now });
  await store.compareAndSet('wf-1::idem:once', undefined, 'claimed');
  now += 8 * 24 * 60 * 60 * 1000; // 8 days: past the 7-day idem: default
  check(
    'an idempotency claim with no explicit ttlSec expires after its namespace default',
    await store.get('wf-1::idem:once') === undefined,
  );
}

// ── Pruning behaviour (Requirement 12.17) ───────────────────────────────────

console.log('\nPruning');
{
  // Cap of 4 keys: wm: and oauth: are exempt from the count-based eviction
  // order, so the cap is effectively "4 prunable-or-exempt keys" and the two
  // exempt entries never come up for eviction no matter how old they are.
  let now = 0;
  const { store } = newStore({ now: () => now, maxKeysPerWorkflow: 4, maxTotalBytesPerWorkflow: 1_000_000 });

  await store.set('wf-1::user:a', 'oldest');
  now += 10;
  await store.set('wf-1::wm:watermark', 'never-pruned');
  now += 10;
  await store.set('wf-1::oauth:conn-1', 'never-pruned');
  now += 10;
  await store.set('wf-1::user:b', 'second-oldest');
  now += 10;

  // A 5th key over the 4-key cap: the oldest PRUNABLE entry (user:a) must go,
  // never the wm:/oauth: entries even though they are chronologically older
  // than user:b.
  await store.set('wf-1::user:c', 'newest');

  check('the oldest prunable entry is evicted first', await store.get('wf-1::user:a') === undefined);
  check('wm: survives pruning although it is the chronologically oldest key', (await store.get('wf-1::wm:watermark'))?.value === 'never-pruned');
  check('oauth: survives pruning', (await store.get('wf-1::oauth:conn-1'))?.value === 'never-pruned');
  check('a newer prunable entry survives while an older one was evicted', (await store.get('wf-1::user:b'))?.value === 'second-oldest');
  check('the write that triggered pruning itself succeeds', (await store.get('wf-1::user:c'))?.value === 'newest');
}

{
  // Total-byte cap, not just key count.
  let now = 0;
  const { store } = newStore({ now: () => now, maxKeysPerWorkflow: 1_000, maxTotalBytesPerWorkflow: 40 });

  await store.set('wf-1::user:big-1', 'x'.repeat(20));
  now += 10;
  await store.set('wf-1::user:big-2', 'y'.repeat(20));
  now += 10;
  // Adding a third 20-byte value pushes the workflow to 60 bytes, over the
  // 40-byte cap, so the oldest (big-1) must be pruned to make room.
  await store.set('wf-1::user:big-3', 'z'.repeat(20));

  check('byte-cap pruning evicts the oldest entry', await store.get('wf-1::user:big-1') === undefined);
  check('byte-cap pruning keeps the newer entries', (await store.get('wf-1::user:big-2')) !== undefined);
  check('the triggering write lands', (await store.get('wf-1::user:big-3'))?.value === 'z'.repeat(20));
}

{
  // Workflow isolation: pruning for one workflow never touches another's keys.
  let now = 0;
  const { store } = newStore({ now: () => now, maxKeysPerWorkflow: 1, maxTotalBytesPerWorkflow: 1_000_000 });
  await store.set('wf-a::user:only', 'a-value');
  now += 10;
  await store.set('wf-b::user:only', 'b-value');
  check(
    'pruning is scoped per workflow: a second workflow\'s key is untouched',
    (await store.get('wf-a::user:only'))?.value === 'a-value',
  );
  check('the second workflow\'s own write succeeds', (await store.get('wf-b::user:only'))?.value === 'b-value');
}

{
  // Fixtures (`fx:`) are prunable like ordinary user keys — only wm:/oauth: are
  // exempt (Requirement 16.10 keeps fixtures out of RUN history, not out of the
  // shared state retention bounds).
  let now = 0;
  const { store } = newStore({ now: () => now, maxKeysPerWorkflow: 2, maxTotalBytesPerWorkflow: 1_000_000 });
  const fixtures = new DurableFixtureStore(store, 'wf-1');

  await fixtures.write('fx-key-1', 'recorded-response-1');
  now += 10;
  await store.set('wf-1::wm:keep-me', 'never-pruned');
  now += 10;
  // Over the 2-key cap: the fixture, being the oldest prunable entry, is
  // evicted rather than the exempt watermark.
  await store.set('wf-1::user:new', 'value');

  check(
    'an fx: fixture is prunable and is evicted before an exempt wm: entry',
    await fixtures.read('fx-key-1') === undefined,
  );
  check('the exempt wm: entry survives', (await store.get('wf-1::wm:keep-me'))?.value === 'never-pruned');
}

{
  // Exhausted retention: every remaining entry is exempt, so the write rejects
  // rather than looping forever, and the rejected write leaves storage unchanged.
  let now = 0;
  const { store } = newStore({ now: () => now, maxKeysPerWorkflow: 1, maxTotalBytesPerWorkflow: 1_000_000 });
  await store.set('wf-1::wm:only', 'kept');

  const error = await rejection(store.set('wf-1::user:new', 'value'));
  check(
    'a write rejects when no further entry can be pruned',
    error !== undefined && /retention bound/i.test(error.message ?? ''),
    error?.message,
  );
  check('the exempt entry is left untouched by the rejected write', (await store.get('wf-1::wm:only'))?.value === 'kept');
  check('the rejected write itself was not stored', await store.get('wf-1::user:new') === undefined);
}

// ── assertPublicHttpUrl still applied on the data path (18.5) ───────────────

console.log('\nEgress guard on the data path');
{
  const blocked = [
    'http://127.0.0.1/x',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/internal',
  ];
  check(
    'assertPublicHttpUrl rejects loopback, localhost, link-local and private addresses',
    blocked.every((url) => {
      try {
        assertPublicHttpUrl(url, 'data request URL');
        return false;
      } catch {
        return true;
      }
    }),
  );

  let dispatched = 0;
  const fetcher = createWorkerDataFetcher({
    fetchImpl: async () => {
      dispatched += 1;
      return new Response('{}', { status: 200 });
    },
  });

  for (const url of blocked) {
    const error = await rejection(
      fetcher({ url, method: 'GET', headers: {} }),
    );
    check(`the worker data-fetch path rejects ${url} before dispatch`, error !== undefined, String(error));
  }
  check('none of the blocked requests reached the network', dispatched === 0, String(dispatched));

  // A public URL is unaffected by the guard.
  const ok = await createWorkerDataFetcher({
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })({ url: 'https://api.example.com/v1/items', method: 'GET', headers: {} });
  check('a public URL still reaches the network', ok.status === 200);
}

console.log(failures === 0 ? '\nAll workflow-state checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
