/**
 * `TenantStore` billing columns - the storage primitive under the Stripe
 * webhook (task 2.4, requirements 1 and 14).
 *
 * The claim under test is the one that cannot be read off the SQL: that a
 * PARTIAL write leaves everything it did not mention alone. A webhook handling
 * `invoice.payment_failed` knows one fact, `status = 'past_due'`, and writes
 * exactly that. If `upsertTenant` overwrote the columns absent from such a call,
 * the tenant would lose its Stripe customer mapping (so no later event could
 * ever find it), its runtime key (so it could not run anything), and its event
 * watermark (so a replayed `subscription.updated` could resurrect a cancelled
 * plan). All three failures are silent: the write succeeds, and the row is
 * quietly wrong.
 *
 * That is why this suite exists rather than an assertion that the statement text
 * contains `COALESCE`. A `COALESCE` in the right place with the wrong operand
 * order clobbers just as thoroughly and reads just as convincingly.
 *
 * Harness. A REAL local D1 (Miniflare's SQLite-backed binding, reached from Node
 * through the magic proxy) with the REAL migrations applied - `0001_init.sql`
 * for `tenants` and `0003_billing.sql` for the billing columns and the partial
 * unique index. `0002_telemetry.sql` is deliberately skipped: it touches only
 * telemetry tables, and leaving it out proves 0003 does not secretly depend on
 * it. No network, no Cloudflare account, no D1 stub. `TenantStore` itself is
 * imported and exercised directly, so the SQL under test is the SQL that ships.
 *
 * Covers:
 *  - requirement 1  - the Stripe identity columns persist, one customer maps to
 *                     exactly one tenant, and a duplicate is a database error
 *  - requirement 14 - `billing_event_at` is a monotonic watermark the storage
 *                     primitive cannot move backwards, blank out, or be poisoned
 *                     into never advancing again. The stale-event GUARD is the
 *                     webhook's job (task 5.3); what is tested here is that the
 *                     column it reads cannot be corrupted by a write that never
 *                     mentions it, or by one that mentions it with a value that
 *                     is not a timestamp.
 *
 * Run: npx tsx cloud/test/tenant-billing.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';
import fc from 'fast-check';
import { TenantStore } from '../src/tenants.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

/** Property iterations. Each one is a handful of loopback D1 calls. */
const RUNS = 60;

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
  // The binding is what this suite uses; the worker script is a placeholder
  // because nothing here goes through a route.
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-tenant-billing' },
});

const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements. The migration files are heavily commented
 * and every statement spans multiple lines, so `--` comments are stripped first
 * and the remainder is split on `;`. Safe for these files specifically: none of
 * them contains a string literal, so no `;` or `--` can be inside one.
 *
 * The split MUST tolerate CRLF. `git config core.autocrlf=true` rewrites these
 * files with CRLF on every checkout, and against a line still carrying its `\r`
 * the stripper `/--.*$/` matches nothing at all - `.` will not cross `\r` and
 * `$` sits after it - so every comment survives, and the comment-only tail after
 * the last `;` reaches D1 as "SQL code did not contain a statement".
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
  for (const statement of statementsOf(file)) {
    await DB.prepare(statement).run();
  }
}

/**
 * An in-memory stand-in for the `TENANTS` KV namespace, used ONLY by the cache
 * tests at the bottom. Every other test runs against a store with no KV binding
 * so each read is a real D1 read rather than a possible cache hit.
 */
function kvStub() {
  const entries = new Map();
  return {
    entries,
    async get(key, type) {
      const raw = entries.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

const store = new TenantStore({ DB });

/** Reads the raw row, to check the columns and not just the mapped record. */
async function rawRow(id) {
  return DB.prepare(
    `SELECT email, tier, status, openrouter_key_id, openrouter_key_enc,
            stripe_customer_id, stripe_subscription_id, billing_event_at,
            billing_tier_at, billing_status_at, billing_dunning_status,
            billing_dunning_at
     FROM tenants WHERE id = ?`,
  )
    .bind(id)
    .first();
}

// --- 1. A tenant with no billing history ----------------------------------

console.log('\nA tenant that has never touched Stripe (requirement 1)');
{
  await store.upsertTenant({ id: 'user_fresh', email: 'fresh@example.com', tier: 'starter', status: 'active' });
  const tenant = await store.getTenant('user_fresh');

  check('the two Stripe ids read as null, not undefined', tenant.stripeCustomerId === null && tenant.stripeSubscriptionId === null, JSON.stringify(tenant));
  check('the watermark reads as the number 0', tenant.billingEventAt === 0 && typeof tenant.billingEventAt === 'number');
  // The hazard this rules out: `undefined > n` and `NaN > n` are both false, so
  // a stale-event guard reading either would apply every event it should ignore.
  check('the watermark is finite', Number.isFinite(tenant.billingEventAt));
}

// --- 2. Round trip -------------------------------------------------------

console.log('\nThe Stripe identity columns persist and read back (requirement 1)');
{
  await store.upsertTenant({
    id: 'user_paid',
    email: 'paid@example.com',
    tier: 'starter',
    status: 'active',
    openrouterKeyId: 'hash_original',
    openrouterKeyEnc: 'enc_original',
  });
  await store.upsertTenant({
    id: 'user_paid',
    tier: 'pro',
    status: 'active',
    stripeCustomerId: 'cus_paid',
    stripeSubscriptionId: 'sub_paid',
    billingEventAt: 1_700_000_200,
  });

  const tenant = await store.getTenant('user_paid');
  check('customer id round trips', tenant.stripeCustomerId === 'cus_paid', String(tenant.stripeCustomerId));
  check('subscription id round trips', tenant.stripeSubscriptionId === 'sub_paid', String(tenant.stripeSubscriptionId));
  check('watermark round trips as a number', tenant.billingEventAt === 1_700_000_200, String(tenant.billingEventAt));
  check('tier was overwritten, as tier always is', tenant.tier === 'pro', tenant.tier);
  check('the email nobody mentioned survived', tenant.email === 'paid@example.com', String(tenant.email));
  check('the runtime key nobody mentioned survived', tenant.openrouterKeyEnc === 'enc_original', String(tenant.openrouterKeyEnc));
}

// --- 3. The status-only write, the whole point of the task -----------------

console.log('\nA status-only write clobbers nothing (requirement 1)');
{
  // Exactly what `invoice.payment_failed` will know: one tenant, one status.
  await store.upsertTenant({ id: 'user_paid', tier: 'pro', status: 'past_due' });

  const tenant = await store.getTenant('user_paid');
  const row = await rawRow('user_paid');

  check('status was applied', tenant.status === 'past_due', tenant.status);
  check('stripe_customer_id survived', row.stripe_customer_id === 'cus_paid', String(row.stripe_customer_id));
  check('stripe_subscription_id survived', row.stripe_subscription_id === 'sub_paid', String(row.stripe_subscription_id));
  check('billing_event_at survived', row.billing_event_at === 1_700_000_200, String(row.billing_event_at));
  check('openrouter_key_id survived', row.openrouter_key_id === 'hash_original', String(row.openrouter_key_id));
  check('openrouter_key_enc survived', row.openrouter_key_enc === 'enc_original', String(row.openrouter_key_enc));
  check('email survived', row.email === 'paid@example.com', String(row.email));
  // Requirement 18 in miniature: a past_due tenant keeps its tier and its key.
  check('tier survived because the caller restated it', row.tier === 'pro', row.tier);
}

// --- 4. The watermark cannot be walked backwards --------------------------

console.log('\nThe watermark only ever moves forward (requirement 14)');
{
  await store.upsertTenant({ id: 'user_paid', tier: 'pro', status: 'active', billingEventAt: 1_700_000_100 });
  check('a lower watermark is refused', (await rawRow('user_paid')).billing_event_at === 1_700_000_200);

  await store.upsertTenant({ id: 'user_paid', tier: 'pro', status: 'active', billingEventAt: 0 });
  check('an explicit 0 is refused', (await rawRow('user_paid')).billing_event_at === 1_700_000_200);

  await store.upsertTenant({ id: 'user_paid', tier: 'pro', status: 'active', billingEventAt: null });
  check('a null watermark is refused, and does not raise on NOT NULL', (await rawRow('user_paid')).billing_event_at === 1_700_000_200);

  await store.upsertTenant({ id: 'user_paid', tier: 'pro', status: 'active', billingEventAt: 1_700_000_300 });
  check('a higher watermark advances it', (await rawRow('user_paid')).billing_event_at === 1_700_000_300);
}

// --- 5. The watermark cannot be poisoned or made to raise ------------------
//
// The write boundary, not the read boundary. `normalizeTenant` already coerces
// what a READ hands back, but until `normalizeWatermark` was shared with the
// bind site the column itself accepted values that broke it, and the read-side
// coercion is exactly what HID the damage. Both shapes below were verified
// against a local D1 before the coercion landed:
//
//   NaN / Infinity - D1 binds them as NULL, the column is NOT NULL, so the write
//                    RAISED. Inside a webhook that is a non-2xx to Stripe and an
//                    infinite retry, and the `status` in the same call is lost
//                    too - the whole write goes, not just this column.
//   'abc'          - accepted, and PERMANENT. SQLite orders TEXT above every
//                    number, so `MAX(1700000200, 'abc')` is `'abc'`; the string
//                    parks in the column and no later event can ever advance the
//                    watermark again. `getTenant` reads it back as 0, so the row
//                    looks merely unmapped while the stale-event guard is dead
//                    for that tenant forever.
//
// The second one is why this section exists. It is silent, it is unrecoverable
// through `upsertTenant`, and the type signature does not stop it: NaN is a
// `number`, and the webhook's `created` arrives through a cast off a parsed
// event body.

console.log('\nA junk watermark is a no-op, not a raise and not permanent (requirement 14)');
{
  await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'active', billingEventAt: 1_700_000_500 });

  // Labelled explicitly rather than stringified: `JSON.stringify` renders NaN
  // and both infinities as "null", which would print three identical test names
  // for three different hazards.
  const junkWatermarks = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ["'abc'", 'abc'],
    ["'' (empty string)", ''],
    ['-5', -5],
  ];

  for (const [label, junk] of junkWatermarks) {
    let raised = null;
    try {
      // A cast is what the webhook will have: `created` off a parsed event body.
      await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'past_due', billingEventAt: junk });
    } catch (error) {
      raised = error;
    }
    const row = await rawRow('user_junk_wm');
    check(`a watermark of ${label} does not raise`, raised === null, raised?.message);
    check(`a watermark of ${label} leaves the stored value alone`, row.billing_event_at === 1_700_000_500, String(row.billing_event_at));
    // The rest of the write still has to land: the watermark is one field of a
    // call that also carries the status the event actually reported.
    check(`the status in the same write still applied over ${label}`, row.status === 'past_due', row.status);
    await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'active' });
  }

  // The half that proves the poisoning is gone rather than merely masked.
  await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'active', billingEventAt: 1_700_000_600 });
  const row = await rawRow('user_junk_wm');
  check('a later legitimate event still advances the watermark', row.billing_event_at === 1_700_000_600, String(row.billing_event_at));
  check('and the column is still a number, not text', typeof row.billing_event_at === 'number', typeof row.billing_event_at);

  // A numeric string is Stripe-authentic data in the wrong wrapper, so it is
  // coerced rather than discarded. The distinction matters: the rule is "a value
  // that cannot be a watermark is ignored", not "anything untyped is ignored".
  await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'active', billingEventAt: '1700000700' });
  check('a numeric string advances it', (await rawRow('user_junk_wm')).billing_event_at === 1_700_000_700);

  // Floored, so the INTEGER column cannot quietly become REAL.
  await store.upsertTenant({ id: 'user_junk_wm', tier: 'starter', status: 'active', billingEventAt: 1_700_000_800.9 });
  const floored = await rawRow('user_junk_wm');
  check('a fractional watermark is floored to an integer', floored.billing_event_at === 1_700_000_800, String(floored.billing_event_at));
  check('the stored value is an integer', Number.isInteger(floored.billing_event_at));
}

// --- 6. Per-field clocks and the status fold (requirement 14) --------------
//
// The store half of `0004_billing_ordering.sql`. One scalar watermark used to gate
// every subscription-state write, and the event families do not carry equal
// information: an `invoice.*` or a `customer.subscription.deleted` supplies no
// tier, so when one of them advanced the single watermark it censored an older,
// not-yet-delivered event that WOULD have supplied a tier. The supplied value was
// then lost for good.
//
// So each field carries its own clock, and `status` is the fold of two registers.
// The webhook suite proves the fold converges over arbitrary delivery orders; this
// section pins what the SQL itself does, because a fold expressed in a CASE
// expression has no type checker and every branch here is one a reader would
// otherwise have to simulate in their head.

console.log('\nEach field is ordered by its OWN clock (requirement 14)');
{
  await store.upsertTenant({
    id: 'user_clocks',
    tier: 'pro',
    status: 'active',
    tierAt: 1_700_000_100,
    statusAt: 1_700_000_100,
  });

  // A dunning write: the SHAPE an invoice event produces. It restates the tier it
  // read with NO tier clock, so the tier column is written back identical to
  // itself and the tier clock does not move.
  await store.upsertTenant({
    id: 'user_clocks',
    tier: 'pro',
    status: 'active',
    dunningStatus: 'past_due',
    dunningAt: 1_700_000_200,
  });
  let row = await rawRow('user_clocks');
  check('an invoice write folds to past_due', row.status === 'past_due', row.status);
  check('and leaves the tier clock where it was', row.billing_tier_at === 1_700_000_100, String(row.billing_tier_at));
  check('while advancing its own clock', row.billing_dunning_at === 1_700_000_200, String(row.billing_dunning_at));

  // THE DEFECT, at the store level. A tier supplied by an event OLDER than the
  // invoice above must still land: the invoice never claimed the tier clock, so
  // there is nothing for it to be stale against.
  await store.upsertTenant({
    id: 'user_clocks',
    tier: 'team',
    status: 'active',
    tierAt: 1_700_000_150,
    statusAt: 1_700_000_150,
  });
  row = await rawRow('user_clocks');
  check('a tier supplied older than a later invoice still lands', row.tier === 'team', row.tier);
  check('and the newer invoice still rules the status', row.status === 'past_due', row.status);

  // A tier genuinely older than the tier clock is refused, which is the half that
  // makes the clock a clock rather than a decoration.
  await store.upsertTenant({ id: 'user_clocks', tier: 'starter', status: 'active', tierAt: 1_700_000_140, statusAt: 1_700_000_140 });
  row = await rawRow('user_clocks');
  check('a tier older than the tier clock is refused', row.tier === 'team', row.tier);

  // A lifecycle status NEWER than the invoice wins the fold back.
  await store.upsertTenant({ id: 'user_clocks', tier: 'team', status: 'active', tierAt: 1_700_000_300, statusAt: 1_700_000_300 });
  check('a newer lifecycle status wins the fold', (await rawRow('user_clocks')).status === 'active');

  // An unordered write - `/api/provision`, `/api/deactivate` - supplies no clock
  // and applies as stated, which is what this method has always done.
  await store.upsertTenant({ id: 'user_clocks', tier: 'starter', status: 'past_due' });
  row = await rawRow('user_clocks');
  check('an unordered write applies both fields as stated', row.tier === 'starter' && row.status === 'past_due', JSON.stringify(row));
  check('and moves no clock', row.billing_tier_at === 1_700_000_300 && row.billing_status_at === 1_700_000_300, JSON.stringify(row));
}

console.log('\nA cancellation is not undone by an invoice, at any timestamp (requirements 15, 16)');
{
  await store.upsertTenant({ id: 'user_fold', tier: 'pro', status: 'canceled', statusAt: 1_700_000_100 });

  // Requirement 15 restores `active` on a successful payment - but only for a LIVE
  // subscription. A paid invoice against a deleted one entitles nobody, and the
  // refusal cannot depend on timestamps: this invoice is NEWER than the
  // cancellation and must still lose.
  await store.upsertTenant({
    id: 'user_fold',
    tier: 'pro',
    status: 'canceled',
    dunningStatus: 'active',
    dunningAt: 1_700_000_500,
  });
  let row = await rawRow('user_fold');
  check('a newer paid invoice does not reactivate a cancelled tenant', row.status === 'canceled', row.status);
  // Recorded rather than dropped, so the stored state does not depend on whether
  // the cancellation happened to arrive first.
  check('but the dunning register still recorded the fact', row.billing_dunning_status === 'active' && row.billing_dunning_at === 1_700_000_500, JSON.stringify(row));

  // A genuine resubscription DOES undo it, even though the dunning register above
  // is newer than this event: the two clocks are what tell those two cases apart.
  await store.upsertTenant({ id: 'user_fold', tier: 'pro', status: 'active', tierAt: 1_700_000_400, statusAt: 1_700_000_400 });
  row = await rawRow('user_fold');
  check('a resubscription older than the invoice still un-cancels', row.status === 'active', row.status);

  // And with the subscription live again, the newer invoice register rules: the
  // fold prefers it because 500 is above the lifecycle clock at 400.
  await store.upsertTenant({
    id: 'user_fold',
    tier: 'pro',
    status: 'active',
    dunningStatus: 'past_due',
    dunningAt: 1_700_000_600,
  });
  check('dunning resumes once the subscription is live', (await rawRow('user_fold')).status === 'past_due');
}

console.log('\nA dunning clock without a usable status is a no-op (requirement 14)');
{
  await store.upsertTenant({ id: 'user_dun_junk', tier: 'pro', status: 'active', statusAt: 1_700_000_100 });
  // `canceled` is deliberately not in the dunning vocabulary - only a lifecycle
  // event can cancel - so it is ignored rather than folded into an entitlement
  // decision, and the clock does not move on a fact we could not name.
  for (const junk of ['canceled', 'nonsense', '', null, 42]) {
    await store.upsertTenant({
      id: 'user_dun_junk',
      tier: 'pro',
      status: 'active',
      dunningStatus: junk,
      dunningAt: 1_700_000_900,
    });
    const row = await rawRow('user_dun_junk');
    check(`a dunning status of ${JSON.stringify(junk)} is ignored`, row.billing_dunning_status === null && row.billing_dunning_at === 0, JSON.stringify(row));
    check(`and the status is left to the unordered value`, row.status === 'active', row.status);
  }
}

// --- 7. The `/api/deactivate` call shape ----------------------------------

console.log('\nThe deactivate round trip preserves the record (requirement 1)');
{
  // `cloud/src/api.ts` spreads the record it just read: `{ ...tenant, status }`.
  // That only works if every field the record carries is a field the upsert
  // accepts under the same name - otherwise the mapping silently drops it.
  //
  // The ORDERING CLOCKS are the deliberate exception, and the naming difference is
  // the mechanism rather than an oversight: the record exposes `billingTierAt` and
  // friends, while the upsert takes `tierAt` / `statusAt` / `dunningAt`. A spread
  // therefore drops them and the write lands as UNORDERED, which is exactly right
  // for an operator action. Naming them alike would make this spread re-assert the
  // stored clock, and the fold would then read the deactivation as "not newer than
  // what I have" and silently ignore it.
  const before = await store.getTenant('user_paid');
  await store.upsertTenant({ ...before, status: 'canceled' });
  const after = await store.getTenant('user_paid');

  check('status changed', after.status === 'canceled', after.status);
  check(
    'every other field is identical',
    JSON.stringify({ ...before, status: 'canceled' }) === JSON.stringify(after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
}

// --- 8. One customer, one tenant -----------------------------------------

console.log('\nA Stripe customer maps to exactly one tenant (requirement 1)');
{
  let raised = null;
  try {
    await store.upsertTenant({
      id: 'user_impostor',
      tier: 'starter',
      status: 'active',
      stripeCustomerId: 'cus_paid', // already mapped to user_paid
    });
  } catch (error) {
    raised = error;
  }
  check('a duplicate customer id is a database error', raised !== null, 'the write was accepted');
  check(
    'and the second tenant was not created',
    (await store.getTenant('user_impostor')) === null,
    'an orphan row landed',
  );

  // The other half of the partial index: unmapped tenants are not "duplicates"
  // of each other, so any number of them coexist.
  await store.upsertTenant({ id: 'user_unmapped_a', tier: 'starter', status: 'active' });
  await store.upsertTenant({ id: 'user_unmapped_b', tier: 'starter', status: 'active' });
  const both = await Promise.all([store.getTenant('user_unmapped_a'), store.getTenant('user_unmapped_b')]);
  check('many unmapped tenants coexist', both.every((tenant) => tenant?.stripeCustomerId === null));
}

// --- 9. The KV cache round trip, and the missing-field shape --------------

console.log('\nThe KV cache round trip, and an entry written before these columns existed (requirements 1, 14)');
{
  const TENANTS = kvStub();
  const cached = new TenantStore({ DB, TENANTS });

  // Exactly what the previously deployed worker serialized: the old five fields
  // and nothing else. This is live for the 60s TTL after every deploy.
  await TENANTS.put(
    'tenant:user_legacy',
    JSON.stringify({
      id: 'user_legacy',
      email: 'legacy@example.com',
      tier: 'starter',
      status: 'active',
      openrouterKeyId: 'hash_legacy',
      openrouterKeyEnc: 'enc_legacy',
    }),
  );

  const tenant = await cached.getTenant('user_legacy');
  check('a legacy cache hit still yields the two ids as null', tenant.stripeCustomerId === null && tenant.stripeSubscriptionId === null, JSON.stringify(tenant));
  check('a legacy cache hit yields a finite watermark, not undefined', tenant.billingEventAt === 0 && Number.isFinite(tenant.billingEventAt), String(tenant.billingEventAt));
  // The same hazard, one migration later: an entry cached before
  // `0004_billing_ordering.sql` carries none of the ordering clocks, and
  // `undefined > n` is silently false - which would make every stale event apply
  // for the 60s of a cache TTL after the deploy.
  check(
    'a legacy cache hit yields finite ordering clocks too',
    tenant.billingTierAt === 0 && tenant.billingStatusAt === 0 && tenant.billingDunningAt === 0,
    JSON.stringify(tenant),
  );
  check('and a null dunning register rather than undefined', tenant.billingDunningStatus === null, String(tenant.billingDunningStatus));
  check('the rest of the cached record is untouched', tenant.openrouterKeyEnc === 'enc_legacy' && tenant.email === 'legacy@example.com');

  // A hand-edited or corrupted entry must not produce NaN either.
  for (const junk of ['not-a-number', null, {}, []]) {
    await TENANTS.put(
      'tenant:user_junk',
      JSON.stringify({
        id: 'user_junk',
        email: null,
        tier: 'starter',
        status: 'active',
        openrouterKeyId: null,
        openrouterKeyEnc: null,
        billingEventAt: junk,
      }),
    );
    const junked = await cached.getTenant('user_junk');
    check(
      `a watermark of ${JSON.stringify(junk)} normalizes to a finite number`,
      Number.isFinite(junked.billingEventAt),
      String(junked.billingEventAt),
    );
  }

  // And a write busts the cache, so the next read is the row and not the stale
  // copy. Without this the two halves above would be testing a dead code path.
  await cached.upsertTenant({
    id: 'user_legacy',
    tier: 'starter',
    status: 'active',
    stripeCustomerId: 'cus_legacy',
    stripeSubscriptionId: 'sub_legacy',
    billingEventAt: 1_700_000_900,
  });
  check('an upsert evicts the cached entry', !TENANTS.entries.has('tenant:user_legacy'));

  // The D1 read that repopulates the cache, then the cache HIT. Both must carry
  // the three new fields: `getTenant` serializes whatever it just materialized,
  // so a field missing from the SELECT column list, from `normalizeTenant`, or
  // from the cached JSON would show up as a divergence between these two reads
  // rather than as a type error. The read path is also the ONLY writer of this
  // cache, which is why a round trip is the whole contract.
  const fromD1 = await cached.getTenant('user_legacy');
  check('the D1 read sees the mapping', fromD1.stripeCustomerId === 'cus_legacy', String(fromD1.stripeCustomerId));
  check('and the read repopulated the cache', TENANTS.entries.has('tenant:user_legacy'));

  const serialized = JSON.parse(TENANTS.entries.get('tenant:user_legacy'));
  for (const field of [
    'stripeCustomerId',
    'stripeSubscriptionId',
    'billingEventAt',
    'billingTierAt',
    'billingStatusAt',
    'billingDunningStatus',
    'billingDunningAt',
  ]) {
    check(`the cached JSON carries ${field}`, field in serialized, JSON.stringify(serialized));
  }

  const fromCache = await cached.getTenant('user_legacy');
  check(
    'a cache hit is byte-identical to the D1 read',
    JSON.stringify(fromD1) === JSON.stringify(fromCache),
    `${JSON.stringify(fromD1)} -> ${JSON.stringify(fromCache)}`,
  );
  check('including the watermark, still a finite number', fromCache.billingEventAt === 1_700_000_900 && Number.isFinite(fromCache.billingEventAt), String(fromCache.billingEventAt));
}

// --- 10. Property: no partial write ever clobbers --------------------------
//
// **Validates: Requirements 1, 14**
//
// The examples above pin the cases a human thought of. This generates arbitrary
// sequences of partial writes - the shape a webhook actually produces, where
// each event knows a different subset - and asserts against a model computed
// from the sequence rather than from the SQL:
//
//   a field a write did not mention keeps its stored value
//   the watermark is max(0, every USABLE watermark ever supplied), where a
//     usable one is a finite positive number and everything else counts as 0
//
// Tier and status are excluded from the model: they are the two fields upsert
// deliberately always overwrites.
//
// The watermark generator deliberately mixes junk in with the real values, so
// the sequences cover a poison write landing BETWEEN two legitimate events -
// the ordering that made the text case unrecoverable, and the one no
// hand-written example enumerates. `expectedWatermark` below is written out
// independently rather than importing the production coercion, so the property
// still fails if that coercion changes meaning.

console.log('\nProperty: a partial write preserves every field it omits (requirements 1, 14)');
{
  const arbWrite = fc.record(
    {
      status: fc.constantFrom('active', 'past_due', 'canceled'),
      email: fc.option(fc.constantFrom('a@example.com', 'b@example.com'), { nil: undefined }),
      openrouterKeyId: fc.option(fc.constantFrom('hash_1', 'hash_2'), { nil: undefined }),
      openrouterKeyEnc: fc.option(fc.constantFrom('enc_1', 'enc_2'), { nil: undefined }),
      stripeSubscriptionId: fc.option(fc.constantFrom('sub_1', 'sub_2'), { nil: undefined }),
      billingEventAt: fc.option(
        fc.oneof(
          // Clustered around one value so ties, advances and regressions all
          // occur within a short sequence.
          { weight: 6, arbitrary: fc.integer({ min: 1_700_000_000, max: 1_700_000_010 }) },
          // Every shape that must count as "no watermark supplied": NaN and the
          // infinities (D1 binds them as NULL against a NOT NULL column), text
          // SQLite would order above every number, and values at or below the
          // floor.
          {
            weight: 4,
            arbitrary: fc.constantFrom(
              Number.NaN,
              Number.POSITIVE_INFINITY,
              Number.NEGATIVE_INFINITY,
              'abc',
              '',
              0,
              -1,
              -1_700_000_005,
            ),
          },
        ),
        { nil: undefined },
      ),
    },
    { requiredKeys: ['status'] },
  );

  /** The model's own rule for what a supplied watermark is worth. */
  const expectedWatermark = (supplied) => {
    if (typeof supplied !== 'number' && typeof supplied !== 'string') return 0;
    const seconds = Number(supplied);
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  };

  let iteration = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(arbWrite, { minLength: 1, maxLength: 6 }), async (writes) => {
      // A fresh tenant id per iteration: the property is about one row's
      // history, and reusing an id would leak state between runs. The customer
      // id is per-tenant too, because the unique index is global.
      iteration += 1;
      const id = `user_prop_${iteration}`;
      const expected = {
        email: null,
        openrouterKeyId: null,
        openrouterKeyEnc: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        billingEventAt: 0,
      };

      // The first write maps the customer, so later writes that omit it are
      // testing survival of a value that is actually there.
      await store.upsertTenant({ id, tier: 'starter', status: 'active', stripeCustomerId: `cus_${iteration}` });
      expected.stripeCustomerId = `cus_${iteration}`;

      for (const write of writes) {
        await store.upsertTenant({ id, tier: 'starter', ...write });
        for (const field of ['email', 'openrouterKeyId', 'openrouterKeyEnc', 'stripeSubscriptionId']) {
          if (write[field] !== undefined) expected[field] = write[field];
        }
        expected.billingEventAt = Math.max(
          expected.billingEventAt,
          expectedWatermark(write.billingEventAt),
        );
      }

      const tenant = await store.getTenant(id);
      for (const [field, value] of Object.entries(expected)) {
        if (tenant[field] !== value) {
          throw new Error(
            `${field}: expected ${JSON.stringify(value)}, stored ${JSON.stringify(tenant[field])} after ${JSON.stringify(writes)}`,
          );
        }
      }
      return true;
    }),
    { numRuns: RUNS },
  );
  check(`no partial write clobbered an omitted field across ${RUNS} sequences`, true);
}

await mf.dispose();

console.log(
  failures === 0
    ? '\nAll tenant billing column checks passed.'
    : `\n${failures} tenant billing column check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
