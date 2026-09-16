/**
 * The entitlement gate and the grant ledger arithmetic (tasks 6.1-6.5 and 6.7,
 * requirements 17, 18, 19, 21, 22, 23, 24, 25).
 *
 * Four claims here are the kind that cannot be verified by reading the SQL,
 * because in every case the wrong version reads exactly as convincingly as the
 * right one:
 *
 *  - ALLOWANCE BEFORE GRANTS (requirement 24). A run that straddles the monthly
 *    allowance must split at the boundary: the part inside comes out of the plan,
 *    only the part past it touches a purchased pack. Draw the whole cost instead
 *    and a tenant who never exceeds their plan still watches their top-up drain,
 *    which is the opposite of what "balance" means on the pricing page. Nothing
 *    about that is a type error, and both versions pass any test that only checks
 *    that a draw happened.
 *  - THE IDEMPOTENT DRAW (requirements 21, 24). The draw hangs off the SAME
 *    `meta.changes` signal as the quota rollup, which only became a real signal
 *    when `0003_billing.sql` added `idx_usage_tenant_run`. A retried settle must
 *    draw nothing. A second gate computed from anything else double-charges a
 *    pack that was paid for once, and only ever on a retry.
 *  - FIFO BY `id`, and the CLAMP. `0003_billing.sql` deliberately carries no
 *    `cost_usd_consumed <= cost_usd` CHECK, because both columns are REAL and
 *    float drift would fire it on a correct draw, so overdraw protection is
 *    arithmetic in this code and nowhere else.
 *  - THE REFUSAL CODES (requirement 19) are a wire contract. `past_due` is a
 *    DISTINCT code from unsubscribed (requirement 17) because the remedies differ
 *    by one button, and a `past_due` tenant keeps tier, data and runtime key
 *    (requirement 18) so recovery is a payment rather than a rebuild.
 *
 * Section 7 (task 6.7) turns the last two into properties, because the examples
 * above pin the boundary at values a reader chose. The two laws are stated over
 * ANY sequence, with oracles computed from the sequence rather than from the
 * production functions - see the block above that section for why each generator
 * is shaped the way it is.
 *
 * Harness. A REAL local D1 (Miniflare's SQLite binding reached from Node) with
 * the real migrations applied, the same shape `tenant-billing.test.mjs` and
 * `billing-routes.test.mjs` use: no `dispatchFetch`, no loopback socket per
 * request, and the SQL under test is the SQL that ships. `/api/me` goes through
 * the REAL router with a locally minted RS256 session token, so the response
 * shape asserted below is the one a studio would receive.
 *
 * Nothing is stubbed. There is no Stripe call on any path here - a grant is
 * written straight through `recordCreditGrant`, which is what the webhook does.
 *
 * Run: npx tsx cloud/test/entitlement.test.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetryD1 } from './miniflare-loopback.mjs';
import fc from 'fast-check';

// `api.ts` reaches the credential vault, which extends `cloudflare:workers`'
// `DurableObject`. Node cannot resolve that built-in, so it is redirected to the
// same stub the other route suites use, before the module graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { handleApiRequest } = await import('../src/api.ts');
const {
  TenantStore,
  effectiveCostUsdLimit,
  effectiveCreditsLimit,
  encryptString,
  grantCostUsd,
  grantDrawUsd,
  reconcileRuntimeKey,
  resolveHostedInference,
  tierLimits,
  usdPerCredit,
} = await import('../src/tenants.ts');

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/**
 * Money comparison. Every figure here is a REAL column summed and subtracted by
 * SQLite, so an exact `===` would fail on the drift `0003_billing.sql` documents
 * (two untouched grants of 4.8 and 9.6 already sum to 14.399999999999999). The
 * tolerance is far below a cent and far above the drift.
 */
const near = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) < epsilon;

// --- Local D1 with the real migrations -------------------------------------

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-entitlement' },
});
const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));

/**
 * Splits a migration into statements (the files carry no string literals).
 * Split on `/\r?\n/`, never `'\n'`: a CRLF checkout leaves each line ending in
 * `\r`, the `--` stripper then matches nothing, and the comment-only tail of a
 * migration reaches D1 as "SQL code did not contain a statement".
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

// A 32-byte base64 secret, so `runtimeKey` actually decrypts rather than being
// skipped: without it every tenant would refuse with `no_runtime_key` and the
// quota checks below would be unreachable.
const KEY_ENC_SECRET = Buffer.alloc(32, 7).toString('base64');
const RUNTIME_KEY = 'sk-or-v1-entitlement-test';
const store = new TenantStore({ DB, KEY_ENC_SECRET });

const month = new Date().toISOString().slice(0, 7);

/** A tenant that would pass the gate: active, provisioned, no usage. */
async function seedTenant(id, { tier = 'starter', status = 'active', withKey = true } = {}) {
  await store.upsertTenant({
    id,
    email: `${id}@example.com`,
    tier,
    status,
    openrouterKeyId: withKey ? `hash_${id}` : null,
    openrouterKeyEnc: withKey ? await encryptString(RUNTIME_KEY, KEY_ENC_SECRET) : null,
  });
}

/**
 * Writes the monthly rollup directly. Building it through `recordRun` would work
 * for cost but not for the run count: starter allows 300 runs, and the point of
 * the `runs_exhausted` case is the refusal, not 300 inserts.
 */
async function setQuota(tenantId, { runs = 0, costUsd = 0 } = {}) {
  await DB.prepare(
    `INSERT INTO quotas (tenant_id, month, runs_used, cost_usd_used) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, month) DO UPDATE SET
       runs_used = excluded.runs_used, cost_usd_used = excluded.cost_usd_used`,
  )
    .bind(tenantId, month, runs, costUsd)
    .run();
}

/** One top-up, priced exactly as the webhook prices it. */
async function seedGrant(tenantId, paymentId, credits) {
  const landed = await store.recordCreditGrant({
    tenantId,
    stripePaymentId: paymentId,
    credits,
    costUsd: grantCostUsd(credits),
  });
  if (!landed) throw new Error(`grant ${paymentId} did not land`);
}

/** The grant ledger as stored, oldest first. */
async function grantRows(tenantId) {
  const rows = await DB.prepare(
    `SELECT id, stripe_payment_id, credits, cost_usd, cost_usd_consumed
     FROM credit_grants WHERE tenant_id = ? ORDER BY id`,
  )
    .bind(tenantId)
    .all();
  return rows.results ?? [];
}

async function quotaRow(tenantId) {
  return DB.prepare('SELECT runs_used, cost_usd_used FROM quotas WHERE tenant_id = ? AND month = ?')
    .bind(tenantId, month)
    .first();
}

const STARTER = tierLimits('starter');

// ══ 1. The refusal codes (task 6.1, requirement 19) ═════════════════════════
//
// The codes are append-only tokens the studio branches on. What is asserted is
// the PAIRING of code, status and prose: a code with the wrong status sends the
// studio the right CTA and the wrong HTTP semantics, and prose that loses its
// matchable phrase breaks the requirement 20 fallback for anyone on an older
// worker.

console.log('\nEvery refusal carries a stable machine code (requirement 19)');
{
  const missing = await resolveHostedInference(store, 'user_does_not_exist');
  check('an unknown tenant refuses', 'status' in missing, JSON.stringify(missing));
  check('with no_subscription / 402', missing.code === 'no_subscription' && missing.status === 402, JSON.stringify(missing));

  await seedTenant('user_canceled', { status: 'canceled' });
  const canceled = await resolveHostedInference(store, 'user_canceled');
  check('a canceled tenant reads as no_subscription', canceled.code === 'no_subscription' && canceled.status === 402, JSON.stringify(canceled));
  // Requirement 20: the studio's existing regexes are `/credits exhausted/i` and
  // `/\(402\)|credits exhausted|subscription/i`, so this prose has to keep saying
  // "subscription" for a studio that predates the code field.
  check('and keeps the word a legacy studio matches', /subscription/i.test(canceled.error), canceled.error);

  await seedTenant('user_runs_gone');
  await setQuota('user_runs_gone', { runs: STARTER.monthlyRuns });
  const runs = await resolveHostedInference(store, 'user_runs_gone');
  check('an exhausted run count is runs_exhausted / 429', runs.code === 'runs_exhausted' && runs.status === 429, JSON.stringify(runs));

  await seedTenant('user_credits_gone');
  await setQuota('user_credits_gone', { costUsd: STARTER.monthlyCostUsd });
  const credits = await resolveHostedInference(store, 'user_credits_gone');
  check('an exhausted allowance with no grants is credits_exhausted / 402', credits.code === 'credits_exhausted' && credits.status === 402, JSON.stringify(credits));
  check('and keeps the "credits exhausted" phrase the studio matches', /credits exhausted/i.test(credits.error), credits.error);

  await seedTenant('user_no_key', { withKey: false });
  const noKey = await resolveHostedInference(store, 'user_no_key');
  check('an unprovisioned tenant is no_runtime_key / 402', noKey.code === 'no_runtime_key' && noKey.status === 402, JSON.stringify(noKey));

  await seedTenant('user_ok');
  const allowed = await resolveHostedInference(store, 'user_ok');
  check('an entitled tenant returns the decrypted key', allowed.key === RUNTIME_KEY, JSON.stringify(allowed));
  check('and the tenant record the caller needs for its tier', allowed.tenant?.tier === 'starter', JSON.stringify(allowed.tenant));
  check('a success carries no status, so `status in result` still discriminates', !('status' in allowed));
}

// ══ 2. past_due is its own refusal, and costs nothing (tasks 6.2, reqs 17, 18)

console.log('\npast_due is a distinct refusal that retains tier, data and key (requirements 17, 18)');
{
  await seedTenant('user_dunning', { tier: 'pro' });
  await store.upsertTenant({ id: 'user_dunning', tier: 'pro', status: 'past_due' });

  const refusal = await resolveHostedInference(store, 'user_dunning');
  check('the code is subscription_past_due', refusal.code === 'subscription_past_due', JSON.stringify(refusal));
  check('and it is 402, like every other billing refusal', refusal.status === 402, String(refusal.status));
  // The whole point of requirement 17: this message must send the user to the
  // billing portal to update a card, NOT to a Subscribe CTA...
  check('the message names the remedy (update the card)', /update your card/i.test(refusal.error), refusal.error);
  // ...and must NOT be mistaken for a credits problem by the studio's existing
  // `/credits exhausted/i` fallback, which raises a Buy credits action that would
  // not fix anything here.
  check('and cannot trip the credits-exhausted fallback', !/credits exhausted/i.test(refusal.error), refusal.error);
  check('nor read as "no subscription"', refusal.code !== 'no_subscription');

  // Requirement 18: recovery is a payment, not a rebuild.
  const row = await DB.prepare('SELECT tier, status, openrouter_key_id, openrouter_key_enc, email FROM tenants WHERE id = ?')
    .bind('user_dunning')
    .first();
  check('the tier survives the refusal', row.tier === 'pro', row.tier);
  check('the runtime key survives', row.openrouter_key_id === 'hash_user_dunning' && Boolean(row.openrouter_key_enc), JSON.stringify(row));
  check('the email survives', row.email === 'user_dunning@example.com', String(row.email));
  check('and the runtime key still decrypts, so paying is enough', (await store.runtimeKey(await store.getTenant('user_dunning'))) === RUNTIME_KEY);

  // Paying restores service with no other write.
  await store.upsertTenant({ id: 'user_dunning', tier: 'pro', status: 'active' });
  const recovered = await resolveHostedInference(store, 'user_dunning');
  check('a paid invoice restores hosted inference', recovered.key === RUNTIME_KEY, JSON.stringify(recovered));
}

// ══ 3. The grant pool and the effective ceilings (task 6.3, requirement 22) ══

console.log('\nThe grant pool reports both units, valued at each purchase (requirement 22)');
{
  const pool = await store.grantPool('user_no_grants');
  check('a tenant with no grants reads 0, not NULL', pool.costUsdRemaining === 0 && pool.creditsRemaining === 0, JSON.stringify(pool));

  await seedTenant('user_pool');
  await seedGrant('user_pool', 'pi_pool_small', 500);
  const bought = await store.grantPool('user_pool');
  // 500 credits at the starter ratio ($0.004) is a $2.00 budget.
  check('an untouched grant is worth its full purchase', near(bought.costUsdRemaining, 2) && bought.creditsRemaining === 500, JSON.stringify(bought));

  // Half consumed, so half remains - in BOTH units, and the credits figure comes
  // from this grant's own frozen ratio rather than from today's `usdPerCredit()`.
  await DB.prepare('UPDATE credit_grants SET cost_usd_consumed = 1 WHERE stripe_payment_id = ?')
    .bind('pi_pool_small')
    .run();
  const half = await store.grantPool('user_pool');
  check('a half-spent grant reports half of each unit', near(half.costUsdRemaining, 1) && half.creditsRemaining === 250, JSON.stringify(half));

  // The clamps `0003_billing.sql` assigns here in place of a CHECK constraint. An
  // overdrawn row (float drift, or a raced draw) must not subtract from a healthy
  // grant, and a zero-budget row must not divide by zero.
  await DB.prepare(
    `INSERT INTO credit_grants (tenant_id, stripe_payment_id, credits, cost_usd, cost_usd_consumed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind('user_pool', 'pi_pool_overdrawn', 100, 0.4, 0.9, new Date().toISOString())
    .run();
  await DB.prepare(
    `INSERT INTO credit_grants (tenant_id, stripe_payment_id, credits, cost_usd, cost_usd_consumed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind('user_pool', 'pi_pool_zero', 0, 0, 0, new Date().toISOString())
    .run();
  const clamped = await store.grantPool('user_pool');
  check('an overdrawn grant contributes 0 rather than a negative', near(clamped.costUsdRemaining, 1), JSON.stringify(clamped));
  check('and cannot drag the credits figure down either', clamped.creditsRemaining === 250, JSON.stringify(clamped));
  check('a zero-budget grant does not divide by zero', Number.isFinite(clamped.creditsRemaining), JSON.stringify(clamped));

  // The ceilings are the tier plus the pool, in the two units the two readers use.
  const pro = tierLimits('pro');
  check('the USD ceiling adds the pool to the allowance', near(effectiveCostUsdLimit(pro, clamped), pro.monthlyCostUsd + 1), String(effectiveCostUsdLimit(pro, clamped)));
  check('the credits ceiling does the same', effectiveCreditsLimit(pro, clamped) === pro.monthlyCredits + 250, String(effectiveCreditsLimit(pro, clamped)));
  check('a negative pool cannot lower a ceiling', effectiveCostUsdLimit(pro, { costUsdRemaining: -5, creditsRemaining: -5 }) === pro.monthlyCostUsd);
}

console.log('\nA grant raises the gate ceiling, and only an empty one refuses (requirement 22)');
{
  await seedTenant('user_topped_up');
  await setQuota('user_topped_up', { costUsd: STARTER.monthlyCostUsd });
  const before = await resolveHostedInference(store, 'user_topped_up');
  check('the allowance alone is exhausted', before.code === 'credits_exhausted', JSON.stringify(before));

  await seedGrant('user_topped_up', 'pi_rescue', 250); // $1.00 of budget
  const after = await resolveHostedInference(store, 'user_topped_up');
  check('a top-up lets the same tenant run again', after.key === RUNTIME_KEY, JSON.stringify(after));

  // Spent past allowance + grant, and it refuses again. This is also the boundary
  // case: usage EQUAL to the effective ceiling refuses, matching how the allowance
  // check has always used `>=`.
  await setQuota('user_topped_up', { costUsd: STARTER.monthlyCostUsd + 1 });
  const spent = await resolveHostedInference(store, 'user_topped_up');
  check('usage exactly at the raised ceiling refuses', spent.code === 'credits_exhausted', JSON.stringify(spent));
}

// ══ 4. The draw split, as arithmetic (task 6.4, requirement 24) ═════════════
//
// Pure, so the rule that decides whether a tenant keeps a pack they did not need
// is assertable without a database.

console.log('\ngrantDrawUsd spends the allowance before the grants (requirement 24)');
{
  const draw = (costUsd, costUsdUsedBefore, monthlyCostUsd = 4) =>
    grantDrawUsd({ costUsd, costUsdUsedBefore, monthlyCostUsd });

  check('a run wholly inside the allowance draws nothing', draw(0.5, 1) === 0, String(draw(0.5, 1)));
  check('a run that lands exactly on the allowance draws nothing', draw(1, 3) === 0, String(draw(1, 3)));
  check('a run that straddles the boundary draws only the part past it', near(draw(0.8, 3.5), 0.3), String(draw(0.8, 3.5)));
  check('a run wholly past the allowance draws all of it', near(draw(0.6, 4), 0.6), String(draw(0.6, 4)));
  check('a run wholly past it, started above it, draws all of it', near(draw(0.6, 10), 0.6), String(draw(0.6, 10)));
  check('a bigger allowance defers the draw', draw(5, 3, 44) === 0, String(draw(5, 3, 44)));

  // Never more than the run cost, never negative, and junk on any input is 0
  // rather than a NaN parked in a REAL column.
  check('the draw never exceeds the run cost', near(draw(2, 3.9), 1.9) && draw(2, 3.9) <= 2);
  check('a zero-cost run draws nothing', draw(0, 10) === 0);
  check('a negative cost draws nothing', draw(-5, 10) === 0);
  check('a NaN cost draws nothing', draw(Number.NaN, 10) === 0);
  check('a NaN prior usage is treated as none', draw(1, Number.NaN, 4) === 0, String(draw(1, Number.NaN, 4)));
  check('a NaN allowance falls back to drawing from grants', near(draw(1, 0, Number.NaN), 1), String(draw(1, 0, Number.NaN)));
  check('a zero allowance draws from the first cent', near(draw(1, 0, 0), 1));
}

// ══ 5. recordRun: the draw in place (task 6.4, requirements 23, 24) ═════════

console.log('\nrecordRun draws only past the allowance, and only once (requirements 23, 24)');
{
  await seedTenant('user_settle');
  await seedGrant('user_settle', 'pi_settle', 500); // $2.00

  // Inside the allowance: the pack is untouched, which is requirement 23's whole
  // promise (a pack survives a month you did not need it).
  await store.recordRun({ tenantId: 'user_settle', tier: 'starter', runId: 'run_a', workflowId: 'wf', costUsd: 3.5, tokensIn: 10, tokensOut: 20 });
  let rows = await grantRows('user_settle');
  check('a run inside the allowance leaves the grant untouched', rows[0].cost_usd_consumed === 0, JSON.stringify(rows));
  check('while the rollup records the whole cost', near((await quotaRow('user_settle')).cost_usd_used, 3.5));

  // Straddling: $0.50 from the allowance, $0.30 from the pack.
  await store.recordRun({ tenantId: 'user_settle', tier: 'starter', runId: 'run_b', workflowId: 'wf', costUsd: 0.8, tokensIn: 10, tokensOut: 20 });
  rows = await grantRows('user_settle');
  check('a straddling run draws only its overage', near(rows[0].cost_usd_consumed, 0.3), String(rows[0].cost_usd_consumed));
  check('and the rollup still records the full cost', near((await quotaRow('user_settle')).cost_usd_used, 4.3));

  // THE IDEMPOTENCY. A retried settle for the same run id must change nothing -
  // not the ledger, not the rollup, not the draw. The `usage` unique index that
  // makes this a real signal only exists as of `0003_billing.sql`.
  await store.recordRun({ tenantId: 'user_settle', tier: 'starter', runId: 'run_b', workflowId: 'wf', costUsd: 0.8, tokensIn: 10, tokensOut: 20 });
  rows = await grantRows('user_settle');
  check('a retried settle does not draw again', near(rows[0].cost_usd_consumed, 0.3), String(rows[0].cost_usd_consumed));
  check('and does not bump the rollup again', near((await quotaRow('user_settle')).cost_usd_used, 4.3));
  const ledger = await DB.prepare('SELECT COUNT(*) AS c FROM usage WHERE tenant_id = ? AND run_id = ?').bind('user_settle', 'run_b').first();
  check('and leaves exactly one ledger row', ledger.c === 1, String(ledger.c));

  // Wholly past the allowance now, so the whole cost comes off the pack.
  await store.recordRun({ tenantId: 'user_settle', tier: 'starter', runId: 'run_c', workflowId: 'wf', costUsd: 1, tokensIn: 10, tokensOut: 20 });
  rows = await grantRows('user_settle');
  check('a run past the allowance draws its whole cost', near(rows[0].cost_usd_consumed, 1.3), String(rows[0].cost_usd_consumed));
  const pool = await store.grantPool('user_settle');
  check('and the remaining pool follows in both units', near(pool.costUsdRemaining, 0.7) && pool.creditsRemaining === 175, JSON.stringify(pool));

  // A draw bigger than the pool is CLAMPED, never overdrawn: `0003_billing.sql`
  // has no CHECK to catch it, so this arithmetic is the only guard.
  await store.recordRun({ tenantId: 'user_settle', tier: 'starter', runId: 'run_d', workflowId: 'wf', costUsd: 5, tokensIn: 10, tokensOut: 20 });
  rows = await grantRows('user_settle');
  check('a draw past the pool clamps at the purchase', near(rows[0].cost_usd_consumed, rows[0].cost_usd), JSON.stringify(rows));
  check('and never exceeds it', rows[0].cost_usd_consumed <= rows[0].cost_usd, JSON.stringify(rows));
  check('the pool reads empty rather than negative', (await store.grantPool('user_settle')).costUsdRemaining === 0);
  // The overspend is still recorded against the month, so the gate refuses the
  // next call rather than quietly forgetting the money.
  check('the rollup still holds the full spend', near((await quotaRow('user_settle')).cost_usd_used, 10.3));
  check('and the gate now refuses', (await resolveHostedInference(store, 'user_settle')).code === 'credits_exhausted');
}

console.log('\nMultiple grants drain oldest first (task 6.4)');
{
  await seedTenant('user_fifo');
  await seedGrant('user_fifo', 'pi_fifo_first', 500); // $2.00, id lower
  await seedGrant('user_fifo', 'pi_fifo_second', 1000); // $4.00, id higher
  await setQuota('user_fifo', { costUsd: STARTER.monthlyCostUsd }); // allowance already gone

  await store.recordRun({ tenantId: 'user_fifo', tier: 'starter', runId: 'run_fifo', workflowId: 'wf', costUsd: 3, tokensIn: 1, tokensOut: 1 });
  const rows = await grantRows('user_fifo');
  check('the ledger is still in id order', rows[0].stripe_payment_id === 'pi_fifo_first' && rows[1].stripe_payment_id === 'pi_fifo_second', JSON.stringify(rows));
  check('the oldest grant is drained first', near(rows[0].cost_usd_consumed, 2), String(rows[0].cost_usd_consumed));
  check('and the remainder spills into the next one', near(rows[1].cost_usd_consumed, 1), String(rows[1].cost_usd_consumed));
  check('nothing was overdrawn', rows.every((row) => row.cost_usd_consumed <= row.cost_usd + 1e-9), JSON.stringify(rows));
  check('the pool reports what is left', near((await store.grantPool('user_fifo')).costUsdRemaining, 3), JSON.stringify(await store.grantPool('user_fifo')));
}

console.log('\nThe tier decides where the allowance ends, and a metered call still draws');
{
  // A Team tenant has a $44 allowance, so a $5 run must not touch a pack. Getting
  // this wrong (defaulting to starter) would burn a Team customer's top-up from
  // the fifth dollar of a forty-four dollar plan.
  await seedTenant('user_team', { tier: 'team' });
  await seedGrant('user_team', 'pi_team', 500);
  await store.recordRun({ tenantId: 'user_team', tier: 'team', runId: 'run_team', workflowId: 'wf', costUsd: 5, tokensIn: 1, tokensOut: 1 });
  check('a Team run inside a Team allowance draws nothing', (await grantRows('user_team'))[0].cost_usd_consumed === 0);

  // `/api/infer` meters with `countsAsRun: false` - cost is always metered, only
  // the run COUNT is exempt, so the draw has to happen on this path too.
  await seedTenant('user_infer');
  await seedGrant('user_infer', 'pi_infer', 500);
  await setQuota('user_infer', { runs: 7, costUsd: STARTER.monthlyCostUsd });
  await store.recordRun({ tenantId: 'user_infer', tier: 'starter', runId: 'run_infer', workflowId: 'infer:x', costUsd: 0.5, tokensIn: 1, tokensOut: 1, countsAsRun: false });
  check('a metered inference call still draws from the pack', near((await grantRows('user_infer'))[0].cost_usd_consumed, 0.5));
  check('and still does not inflate the run count', (await quotaRow('user_infer')).runs_used === 7, String((await quotaRow('user_infer')).runs_used));
}

// ══ 6. /api/me exposes the balance additively (task 6.5, requirement 25) ════

console.log('\n/api/me carries the grant balance as additive quota fields (requirement 25)');
{
  const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const mintToken = (sub) => {
    const seconds = Math.floor(Date.now() / 1000);
    const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-entitlement-test' })}.${base64url({ sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
    return `${signing}.${signature}`;
  };
  const env = {
    PHORMA_MODE: 'hosted',
    CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
    CLERK_JWT_KEY,
    KEY_ENC_SECRET,
    DB,
  };
  const me = async (userId) => {
    const response = await handleApiRequest(
      new Request('https://cloud.example.com/api/me', {
        headers: { Authorization: `Bearer ${mintToken(userId)}` },
      }),
      env,
      { 'Access-Control-Allow-Origin': 'http://localhost:7322' },
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    return { status: response.status, body: await response.json() };
  };

  await seedTenant('user_profile');
  const empty = await me('user_profile');
  check('a tenant with no top-up reads 0 rather than omitting the field', empty.body.quota.grantCreditsRemaining === 0 && empty.body.quota.grantCostUsdRemaining === 0, JSON.stringify(empty.body.quota));

  await seedGrant('user_profile', 'pi_profile_a', 500);
  await seedGrant('user_profile', 'pi_profile_b', 1000);
  await setQuota('user_profile', { runs: 3, costUsd: 2 });
  const topped = await me('user_profile');
  const quota = topped.body.quota;

  check('the route answers 200', topped.status === 200, String(topped.status));
  check('the balance is the sum of both packs, in credits', quota.grantCreditsRemaining === 1500, JSON.stringify(quota));
  check('and in USD for internal analytics', near(quota.grantCostUsdRemaining, 6), String(quota.grantCostUsdRemaining));
  // ADDITIVE: the allowance fields keep their old meaning, so a studio that
  // predates the balance renders exactly what it did before, and one that knows
  // about it can show allowance and top-up separately (requirement 23 - only the
  // allowance resets monthly).
  check('creditsLimit is still the tier allowance alone', quota.creditsLimit === STARTER.monthlyCredits, String(quota.creditsLimit));
  check('costUsdLimit is still the tier allowance alone', near(quota.costUsdLimit, STARTER.monthlyCostUsd), String(quota.costUsdLimit));
  check('creditsUsed still measures the month, not the balance', quota.creditsUsed === 500, String(quota.creditsUsed));
  check('so the effective ceiling is the studio-side sum', quota.creditsLimit + quota.grantCreditsRemaining === STARTER.monthlyCredits + 1500);

  // Requirement 25 is a rule about UNITS: whatever the studio renders about a
  // grant must be a credit figure, and one it never has to compute. The credit
  // field is therefore a whole number, valued at each grant's purchase ratio.
  check('the credits figure is a whole count, needing no client arithmetic', Number.isInteger(quota.grantCreditsRemaining), String(quota.grantCreditsRemaining));

  // Spending past the allowance draws down the balance the profile reports, so
  // the two surfaces cannot disagree.
  await setQuota('user_profile', { runs: 3, costUsd: STARTER.monthlyCostUsd });
  await store.recordRun({ tenantId: 'user_profile', tier: 'starter', runId: 'run_profile', workflowId: 'wf', costUsd: 1, tokensIn: 1, tokensOut: 1 });
  const drawn = await me('user_profile');
  check('a draw is visible in the profile', drawn.body.quota.grantCreditsRemaining === 1250, String(drawn.body.quota.grantCreditsRemaining));
  check('in USD too', near(drawn.body.quota.grantCostUsdRemaining, 5), String(drawn.body.quota.grantCostUsdRemaining));

  // An unprovisioned user still answers, with no quota block at all - the shape
  // the studio relies on to know nobody has been provisioned yet.
  const unknown = await me('user_never_seen');
  check('an unprovisioned user still gets a null quota, not a grant block', unknown.body.provisioned === false && unknown.body.quota === null, JSON.stringify(unknown.body));
}

// ══ 7. The two laws only a property can hold (task 6.7, requirements 21, 24) ══
//
// Everything above pins a boundary at values a reader chose. These two state the
// same rules over ANY sequence, and both are built the same way:
//
//  - THE ORACLE IS INDEPENDENT. Neither property calls `grantDrawUsd` or reads a
//    grant back through `grantPool` to decide what it expected. P2 walks the
//    sequence as one closed-form conservation law
//    (`drawn = clamp(totalSpend - allowance, 0, pool)`), which is a DIFFERENT
//    formulation from the per-run difference-of-overages the code computes, so it
//    fails on a handler that draws whole runs, one that draws nothing, and one
//    that agrees with itself while being wrong. P1's oracle is a five-line
//    simulator over a `Set` of payment ids.
//  - THE INTERESTING REGION IS REACHED ON PURPOSE. A generator that produced
//    spend "somewhere in the plausible range" would sit almost entirely on one
//    side of the allowance, and the version of the code that draws a straddling
//    run WHOLESALE would pass. So P2's run costs are EIGHTHS OF THE TIER'S OWN
//    ALLOWANCE (0 to 4 eighths each, 1 to 6 runs, so 0 to 300% of it) rather than
//    absolute dollars. That makes the boundary scale-free across a $4 starter and
//    a $44 team plan, puts it in the middle of the range instead of at an edge,
//    and makes eighths summing to exactly 8 - a sequence landing EXACTLY on the
//    allowance, which is the `>=` boundary - a routine draw rather than a
//    coincidence. Coverage counters below assert every region was actually
//    visited, so this claim fails loudly if a later edit narrows the generator.
//  - RETRIED SETTLES ARE IN THE SEQUENCE, because the draw and the quota rollup
//    hang off the SAME `meta.changes` signal. A duplicate `run_id` must add
//    nothing to either side of the conservation law, and a second gate computed
//    any other way only ever double-draws on a retry.
//  - TOLERANCE, NOT EQUALITY. Every figure is a REAL column summed by SQLite, and
//    `recordRun` recovers its before-value by SUBTRACTION, so the telescoping sum
//    the oracle relies on is exact only in real arithmetic. `near`'s 1e-9 is four
//    orders below a cent and five above the drift these values accumulate.
//  - IDS ARE NAMESPACED PER ITERATION. `credit_grants.stripe_payment_id` and
//    `usage(tenant_id, run_id)` are globally unique, so a shared id would make a
//    later iteration silently no-op and read as a pass. The counter is bumped
//    inside the property body, which also covers fast-check replaying an input
//    while shrinking.
//
// 120 iterations, matching what `stripe-webhook.test.mjs` settled on: each one is
// several D1 round trips, and the way to keep that affordable is to fold the
// verification reads into one statement (see `meterOf`), not to lower the count.
//
// SEEDED, deliberately. The coverage counters below are assertions, not
// diagnostics, so an unseeded generator makes them a dice roll: P2's
// `poolExhausted` bucket came up 5 in 120 locally and 0 in 120 in CI on the same
// commit, failing the release gate for no defect. A pinned seed makes the buckets
// a property of the generator rather than of the day, and `fast-check` is an exact
// pin so the sequence is stable. Set FC_SEED to fuzz for new counterexamples; a
// seed that fails is a real counterexample, so fix the code or the generator and
// keep the run reproducible.

const RUNS = { numRuns: 120, seed: Number(process.env.FC_SEED ?? 20260916) };
const EPS = 1e-9;

/** The counterexample fast-check reports, flattened onto one line. */
function describeFailure(error) {
  return String(error?.message ?? error).split('\n').slice(0, 10).join(' | ');
}

/**
 * Runs one property and reports it. Returns whether it PASSED, because
 * fast-check stops at the first counterexample and the coverage counters below
 * are then only partly filled: asserting non-vacuity on a half-finished run would
 * report a second failure for one cause and bury the counterexample.
 */
async function asyncProperty(name, build) {
  try {
    await fc.assert(build(), RUNS);
    check(name, true);
    return true;
  } catch (error) {
    check(name, false, describeFailure(error));
    return false;
  }
}

/**
 * Flattens float drift to a millionth of a dollar, so two ledgers can be compared
 * STRUCTURALLY (`JSON.stringify`) rather than field by field with a tolerance.
 * Still far below a cent, and far above the drift `0003_billing.sql` documents.
 */
const money = (value) => Number(Number(value).toFixed(6));

function differs(name, expected, actual, context) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  throw new Error(
    `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} for ${context}`,
  );
}

function assertThat(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The whole metered side of a tenant in ONE round trip: how many ledger rows
 * landed, and what the monthly rollup holds. Three correlated subqueries rather
 * than three statements, because at 120 iterations the read traffic is what the
 * property costs.
 */
async function meterOf(tenantId) {
  const row = await DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM usage WHERE tenant_id = ?) AS ledger_rows,
       (SELECT COALESCE(runs_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?) AS runs_used,
       (SELECT COALESCE(cost_usd_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?)
         AS cost_usd_used`,
  )
    .bind(tenantId, tenantId, month, tenantId, month)
    .first();
  return {
    ledgerRows: Number(row?.ledger_rows ?? 0),
    runsUsed: Number(row?.runs_used ?? 0),
    costUsdUsed: Number(row?.cost_usd_used ?? 0),
  };
}

console.log('\nP1: granting one payment id twice equals granting it once (requirement 21)');
{
  // Four packs and up to six steps, so a repeat is the COMMON case rather than
  // something the generator has to get lucky to produce.
  const PACK_CREDITS = [125, 500, 1000, 2500];

  // A sequence mixes purchases with SPENDING, which is the part an idempotency
  // test on a virgin ledger cannot reach: a Stripe retry can arrive after the
  // pack has been partly consumed, and re-granting it must not hand budget back.
  const arbStep = fc.oneof(
    { weight: 3, arbitrary: fc.record({ grant: fc.nat({ max: PACK_CREDITS.length - 1 }) }) },
    { weight: 2, arbitrary: fc.record({ quarters: fc.integer({ min: 1, max: 8 }) }) },
  );
  const arbSteps = fc.array(arbStep, { minLength: 1, maxLength: 6 });

  /**
   * What the sequence must add up to, walked independently: a `Set` of payment
   * ids and a running pool. Nothing here calls `grantDrawUsd`, `grantPool` or
   * `drawFromGrants`.
   *
   * Every run's WHOLE cost draws, because the tenant's rollup is pre-seeded at
   * exactly the tier allowance (below). P1 is the idempotency law, so the
   * allowance boundary is deliberately taken out of it and left to P2.
   */
  function expectedOf(steps) {
    const seen = new Set();
    const landed = [];
    const order = [];
    let poolUsd = 0;
    let credits = 0;
    let drawn = 0;
    let spend = 0;
    let runs = 0;
    let duplicates = 0;
    let duplicateAfterDraw = false;
    for (const step of steps) {
      if ('grant' in step) {
        const fresh = !seen.has(step.grant);
        landed.push(fresh);
        if (!fresh) {
          duplicates += 1;
          if (drawn > 0) duplicateAfterDraw = true;
          continue;
        }
        seen.add(step.grant);
        order.push(step.grant);
        poolUsd += grantCostUsd(PACK_CREDITS[step.grant]);
        credits += PACK_CREDITS[step.grant];
      } else {
        runs += 1;
        const cost = step.quarters * 0.25;
        spend += cost;
        const take = Math.min(poolUsd, cost);
        poolUsd -= take;
        drawn += take;
      }
    }
    return { landed, order, poolUsd, credits, drawn, spend, runs, duplicates, duplicateAfterDraw };
  }

  /** Delivers the sequence against a fresh tenant and reports the ledger. */
  async function deliver(steps, tag) {
    const tenantId = `user_p1_${tag}`;
    // Rollup pre-seeded AT the allowance, so every run below is wholly past it
    // and draws in full. Without this, most sequences would never reach a grant
    // and the duplicate-after-a-draw region would be unreachable.
    await setQuota(tenantId, { costUsd: STARTER.monthlyCostUsd });

    const landed = [];
    let runOrdinal = 0;
    for (const step of steps) {
      if ('grant' in step) {
        const credits = PACK_CREDITS[step.grant];
        landed.push(
          await store.recordCreditGrant({
            tenantId,
            // Namespaced by tenant AND slot: the column is globally unique, so a
            // shared id across the two tenants below would make the second one
            // grant nothing and the comparison would pass vacuously.
            stripePaymentId: `pi_p1_${tag}_${step.grant}`,
            credits,
            costUsd: grantCostUsd(credits),
          }),
        );
      } else {
        runOrdinal += 1;
        await store.recordRun({
          tenantId,
          tier: 'starter',
          runId: `run_p1_${tag}_${runOrdinal}`,
          workflowId: 'wf',
          costUsd: step.quarters * 0.25,
          tokensIn: 1,
          tokensOut: 1,
        });
      }
    }

    const prefix = `pi_p1_${tag}_`;
    const rows = (await grantRows(tenantId)).map((row) => ({
      slot: Number(row.stripe_payment_id.slice(prefix.length)),
      credits: Number(row.credits),
      costUsd: Number(row.cost_usd),
      consumed: Number(row.cost_usd_consumed),
    }));
    const pool = await store.grantPool(tenantId);
    const meter = await meterOf(tenantId);
    return {
      landed,
      rows,
      pool,
      meter,
      // The A/B comparison is STRUCTURAL, so the money in it is rounded to a
      // millionth of a dollar; every absolute check below reads the raw fields
      // above and compares with `near` instead. Mixing the two would silently
      // widen the tolerance to 5e-7 per term.
      view: {
        ledger: rows.map((row) => ({ ...row, costUsd: money(row.costUsd), consumed: money(row.consumed) })),
        creditsRemaining: pool.creditsRemaining,
        costUsdRemaining: money(pool.costUsdRemaining),
        ledgerRows: meter.ledgerRows,
        runsUsed: meter.runsUsed,
        costUsdUsed: money(meter.costUsdUsed),
      },
    };
  }

  const coverage = { duplicates: 0, duplicateAfterDraw: 0, drained: 0 };
  let iteration = 0;

  const held = await asyncProperty(
    `a repeated payment id changed nothing, across ${RUNS.numRuns} purchase and spend sequences`,
    () =>
      fc.asyncProperty(arbSteps, async (steps) => {
        iteration += 1;
        const model = expectedOf(steps);
        const context = JSON.stringify(steps);

        // The literal reading of requirement 21: the same sequence with every
        // repeat REMOVED must leave the same ledger. Runs are kept in both, so
        // the two tenants spend identically and the comparison covers the draw,
        // the rollup and the per-grant split, not just the row count.
        const seen = new Set();
        const deduplicated = steps.filter((step) => {
          if (!('grant' in step)) return true;
          if (seen.has(step.grant)) return false;
          seen.add(step.grant);
          return true;
        });

        const withRepeats = await deliver(steps, `a${iteration}`);
        const once = await deliver(deduplicated, `b${iteration}`);

        differs('twice did not equal once', once.view, withRepeats.view, context);

        // ABSOLUTE, so a store that ignored every grant cannot pass by agreeing
        // with itself.
        differs('the wrong grants landed', model.landed, withRepeats.landed, context);
        differs(
          'the ledger did not hold one row per distinct payment, in first-purchase order',
          model.order.map((slot) => ({
            slot,
            credits: PACK_CREDITS[slot],
            costUsd: money(grantCostUsd(PACK_CREDITS[slot])),
          })),
          withRepeats.rows.map((row) => ({
            slot: row.slot,
            credits: row.credits,
            costUsd: money(row.costUsd),
          })),
          context,
        );
        assertThat(
          near(
            withRepeats.rows.reduce((sum, row) => sum + row.consumed, 0),
            model.drawn,
          ),
          `the draw did not total ${model.drawn}: ${JSON.stringify(withRepeats.rows)} for ${context}`,
        );
        assertThat(
          near(withRepeats.pool.costUsdRemaining, model.poolUsd),
          `the pool read ${withRepeats.pool.costUsdRemaining}, expected ${model.poolUsd} for ${context}`,
        );
        // A repeat must not inflate the month either - `recordCreditGrant` and
        // `recordRun` are separate idempotency keys and a sequence exercises both.
        assertThat(
          near(withRepeats.meter.costUsdUsed, STARTER.monthlyCostUsd + model.spend) &&
            withRepeats.meter.runsUsed === model.runs &&
            withRepeats.meter.ledgerRows === model.runs,
          `the month did not record ${model.runs} runs and ${model.spend}: ${JSON.stringify(withRepeats.meter)} for ${context}`,
        );
        // Requirement 21 is about money, so the no-overdraw invariant is checked
        // on this path too: a duplicate that "topped up" a consumed grant would
        // show here as a row whose budget grew back.
        for (const row of withRepeats.rows) {
          assertThat(
            Number.isFinite(row.consumed) && row.consumed >= -EPS && row.consumed <= row.costUsd + EPS,
            `grant ${row.slot} is outside [0, cost_usd]: ${JSON.stringify(row)} for ${context}`,
          );
        }

        if (model.duplicates > 0) coverage.duplicates += 1;
        if (model.duplicateAfterDraw) coverage.duplicateAfterDraw += 1;
        if (model.poolUsd <= EPS && model.drawn > EPS) coverage.drained += 1;
        return true;
      }),
  );

  // Non-vacuity. The property is only worth its runtime if the sequences it saw
  // actually repeated a payment, and repeated one whose budget had already been
  // partly spent.
  if (held) {
    check(`sequences that repeated a payment id were reached (${coverage.duplicates})`, coverage.duplicates > 0);
    check(
      `so were repeats arriving after that pack had been drawn on (${coverage.duplicateAfterDraw})`,
      coverage.duplicateAfterDraw > 0,
    );
    check(`and sequences that drained the pool entirely (${coverage.drained})`, coverage.drained > 0);
  }
}

console.log('\nP2: the allowance absorbs the first monthlyCostUsd of any sequence (requirement 24)');
{
  const P2_TIERS = ['starter', 'pro', 'team'];

  const arbCase = fc.record({
    // All three, because the allowance is where the split happens and a draw
    // computed against the wrong tier is the defect that burns a Team customer's
    // pack from the fifth dollar of a forty-four dollar plan.
    tier: fc.constantFrom(...P2_TIERS),
    // Packs in EIGHTHS OF THE ALLOWANCE as well, so "the pool covers the overage"
    // and "the pool is exhausted" are both reachable on every tier. Absolute
    // credit counts would make a $2 pack decisive on starter and irrelevant on
    // team, and the clamp would then only ever be tested on one tier. Capped at
    // four eighths rather than eight: a pool that can reach 300% of the allowance
    // covers almost every overage this generator can produce, and the CLAMP
    // (`overage >= pool`) then becomes the rare case - it was reached 3 times in
    // 120 at max 8, which is too close to vacuous for the one bucket that proves
    // the overdraw guard runs at all.
    packs: fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 3 }),
    runs: fc.array(
      fc.record({
        // 0 included: a free run must draw nothing and still land a ledger row.
        eighths: fc.integer({ min: 0, max: 4 }),
        // Extra deliveries of the SAME run id. Stripe-style at-least-once applied
        // to the settle path.
        retries: fc.integer({ min: 0, max: 2 }),
      }),
      { minLength: 1, maxLength: 6 },
    ),
  });

  const coverage = {
    interior: 0,
    exact: 0,
    straddle: 0,
    past: 0,
    poolCovered: 0,
    poolExhausted: 0,
    retried: 0,
    tiers: new Set(),
  };
  let iteration = 0;

  const held = await asyncProperty(
    `the draw equalled the overage, clamped by the pool, across ${RUNS.numRuns} consumption sequences`,
    () =>
      fc.asyncProperty(arbCase, async ({ tier, packs, runs }) => {
        iteration += 1;
        const tenantId = `user_p2_${iteration}`;
        const allowance = tierLimits(tier).monthlyCostUsd;
        const unit = allowance / 8;
        const context = `${tier} with packs ${JSON.stringify(packs)} and runs ${JSON.stringify(runs)}`;

        // Every pack lands BEFORE any run. The conservation law is stated over the
        // pool that existed while the overage happened, and a pack bought after an
        // overage legitimately cannot back-fill it: `drawFromGrants` leaves an
        // unmet draw undrawn rather than carrying it (the money is already
        // recorded in `usage`). P1 covers the interleaved case.
        let poolUsd = 0;
        let poolCredits = 0;
        for (const [index, eighthsOfAllowance] of packs.entries()) {
          const credits = Math.max(
            1,
            Math.round((allowance * eighthsOfAllowance) / 8 / usdPerCredit()),
          );
          const landed = await store.recordCreditGrant({
            tenantId,
            stripePaymentId: `pi_p2_${iteration}_${index}`,
            credits,
            costUsd: grantCostUsd(credits),
          });
          assertThat(landed, `pack ${index} did not land for ${context}`);
          poolUsd += grantCostUsd(credits);
          poolCredits += credits;
        }

        let spend = 0;
        let straddled = false;
        for (const [index, spec] of runs.entries()) {
          const costUsd = spec.eighths * unit;
          const runId = `run_p2_${iteration}_${index}`;
          // The first delivery plus `retries` more. A retry is byte-identical,
          // which is what a settle retry actually looks like.
          for (let attempt = 0; attempt <= spec.retries; attempt += 1) {
            await store.recordRun({
              tenantId,
              tier,
              runId,
              workflowId: 'wf',
              costUsd,
              tokensIn: 1,
              tokensOut: 1,
            });
          }
          if (spend < allowance - EPS && spend + costUsd > allowance + EPS) straddled = true;
          spend += costUsd;
        }

        // THE LAW. Independent of how the spend was chopped into runs, of how many
        // times each was delivered, and of the per-run difference-of-overages the
        // code actually evaluates.
        const overage = Math.max(0, spend - allowance);
        const expectedDraw = Math.min(poolUsd, overage);

        const rows = await grantRows(tenantId);
        const meter = await meterOf(tenantId);

        assertThat(
          near(meter.costUsdUsed, spend),
          `the month recorded ${meter.costUsdUsed}, expected ${spend} for ${context}`,
        );
        // A retry must contribute to NEITHER side of the law: not the rollup
        // above, not the ledger, and not the draw below.
        assertThat(
          meter.ledgerRows === runs.length && meter.runsUsed === runs.length,
          `a retry was counted: ${JSON.stringify(meter)} against ${runs.length} runs for ${context}`,
        );

        const drawn = rows.reduce((sum, row) => sum + Number(row.cost_usd_consumed), 0);
        assertThat(
          near(drawn, expectedDraw),
          `drew ${drawn}, expected clamp(${spend} - ${allowance}, 0, ${poolUsd}) = ${expectedDraw}` +
            ` for ${context}: ${JSON.stringify(rows)}`,
        );

        // The invariant `0003_billing.sql` deliberately assigns to arithmetic
        // instead of a CHECK constraint, because both columns are REAL and drift
        // would fire a constraint on a correct draw. Nothing but this holds it.
        for (const row of rows) {
          const consumed = Number(row.cost_usd_consumed);
          assertThat(
            Number.isFinite(consumed) && consumed >= -EPS && consumed <= Number(row.cost_usd) + EPS,
            `grant ${row.id} is outside [0, cost_usd]: ${JSON.stringify(row)} for ${context}`,
          );
        }

        // FIFO leaves a staircase: everything before the newest touched grant is
        // full. A draw that skipped a grant, or spread itself across all of them,
        // would satisfy the total above and fail here.
        let lastTouched = -1;
        rows.forEach((row, index) => {
          if (Number(row.cost_usd_consumed) > EPS) lastTouched = index;
        });
        for (let index = 0; index < lastTouched; index += 1) {
          assertThat(
            Number(rows[index].cost_usd) - Number(rows[index].cost_usd_consumed) <= EPS,
            `grant ${rows[index].id} kept budget while a later one was drawn:` +
              ` ${JSON.stringify(rows)} for ${context}`,
          );
        }

        // The two ends of the range, in the unit the studio renders. A sequence
        // inside the allowance must leave the pack whole - that is requirement 23's
        // promise, and it is the half a wholesale draw gets wrong.
        const pool = await store.grantPool(tenantId);
        if (overage <= EPS) {
          assertThat(
            pool.creditsRemaining === poolCredits && near(pool.costUsdRemaining, poolUsd),
            `a sequence inside the allowance spent a pack: ${JSON.stringify(pool)} against` +
              ` ${poolCredits} credits for ${context}`,
          );
        }
        if (poolUsd > 0 && overage >= poolUsd + EPS) {
          assertThat(
            pool.creditsRemaining === 0 && pool.costUsdRemaining === 0,
            `an exhausted pool did not read empty: ${JSON.stringify(pool)} for ${context}`,
          );
        }

        coverage.tiers.add(tier);
        if (spend < allowance - EPS) coverage.interior += 1;
        else if (Math.abs(spend - allowance) <= EPS) coverage.exact += 1;
        else coverage.past += 1;
        if (straddled) coverage.straddle += 1;
        if (poolUsd > 0 && overage > EPS && overage <= poolUsd - EPS) coverage.poolCovered += 1;
        if (poolUsd > 0 && overage >= poolUsd + EPS) coverage.poolExhausted += 1;
        if (runs.some((spec) => spec.retries > 0)) coverage.retried += 1;
        return true;
      }),
  );

  // Non-vacuity, asserted rather than asserted-in-a-comment. Every one of these
  // is a region where a plausible wrong implementation passes everywhere else:
  // drawing wholesale passes `interior` and `past` and fails `straddle`; using `>`
  // instead of `>=` at the boundary fails only `exact`; forgetting the clamp fails
  // only `poolExhausted`.
  if (held) {
    check(`all three tiers were exercised (${[...coverage.tiers].sort().join(', ')})`, coverage.tiers.size === P2_TIERS.length);
    check(`sequences entirely inside the allowance were reached (${coverage.interior})`, coverage.interior > 0);
    check(`sequences landing EXACTLY on the allowance were reached (${coverage.exact})`, coverage.exact > 0);
    check(`sequences past the allowance were reached (${coverage.past})`, coverage.past > 0);
    check(`single runs STRADDLING the boundary were reached (${coverage.straddle})`, coverage.straddle > 0);
    check(`overages the pool could cover were reached (${coverage.poolCovered})`, coverage.poolCovered > 0);
    check(`overages that exhausted the pool were reached (${coverage.poolExhausted})`, coverage.poolExhausted > 0);
    check(`sequences containing a retried settle were reached (${coverage.retried})`, coverage.retried > 0);
  }
}

console.log('\nP3: the key cap the reconciler patches IS the gate ceiling (requirement 37)');
{
  // WHAT THIS IS FOR. `resolveHostedInference` lets a run through up to
  // `effectiveCostUsdLimit` (allowance + unspent pool), but the spend the VENDOR
  // enforces is the `limit` on the tenant's OpenRouter key, and that used to be the
  // tier allowance alone - so the exact overage a purchased pack was sold to cover
  // was refused by OpenRouter. The two numbers have to be one number, and the safety
  // argument for patching it only at a purchase or a tier change rests on an
  // invariant this property is the only thing that states:
  //
  //   keyLimit = allowance + poolAtPatch,  and between patches the pool only SHRINKS
  //   => ourCeiling(t) = allowance + poolNow(t) <= keyLimit,  always.
  //
  // So the key can never refuse a run our own gate allows. Two things follow that a
  // fixed fixture cannot establish: the equality holds AT every patch, and the
  // inequality holds at every point BETWEEN patches, over any interleaving of
  // purchases, spends, retried settles and tier changes.
  //
  // THE CAP IS READ WITHOUT A VENDOR. `reconcileRuntimeKey` reports `limitUsd` on
  // every outcome including `skipped`, and it computes it before it looks for a
  // provisioning key - so an env with no `OPENROUTER_PROVISIONING_KEY` yields the
  // number the PATCH would carry while touching no network at all. That is the same
  // number `provisioning.test.mjs` reads off the wire, which is what makes reading it
  // this way a shortcut rather than a different subject.
  const P3_TIERS = ['starter', 'pro', 'team'];
  const P3_ENV = { KEY_ENC_SECRET };

  const arbSteps = fc.record({
    tier: fc.constantFrom(...P3_TIERS),
    // A tier change mid-sequence, because half of this fix is that a LATER tier
    // change must not patch a purchased pack back out of the cap.
    retier: fc.option(fc.constantFrom(...P3_TIERS), { nil: null }),
    steps: fc.array(
      fc.oneof(
        { weight: 2, arbitrary: fc.record({ buy: fc.integer({ min: 1, max: 4 }) }) },
        { weight: 3, arbitrary: fc.record({ spend: fc.integer({ min: 0, max: 5 }) }) },
      ),
      { minLength: 1, maxLength: 6 },
    ),
  });

  const coverage = { patches: 0, shrank: 0, drained: 0, retiered: 0, pastAllowance: 0, tiers: new Set() };
  let iteration = 0;

  const held = await asyncProperty(
    `the cap equals the ceiling at every patch and bounds it in between, across ${RUNS.numRuns} sequences`,
    () =>
      fc.asyncProperty(arbSteps, async ({ tier, retier, steps }) => {
        iteration += 1;
        const tenantId = `user_p3_${iteration}`;
        const context = `${tier}${retier ? ` -> ${retier}` : ''} with ${JSON.stringify(steps)}`;
        await seedTenant(tenantId, { tier });

        /** The cap OpenRouter would be holding right now, as a patch would set it. */
        const patch = async (currentTier) => {
          const outcome = await reconcileRuntimeKey(
            P3_ENV,
            store,
            { ...(await store.getTenant(tenantId)), tier: currentTier },
          );
          // No provisioning key, so nothing was attempted - the point is the number.
          assertThat(outcome.action === 'skipped', `expected no vendor call, got ${outcome.action}`);
          coverage.patches += 1;
          return outcome.limitUsd;
        };

        /**
         * What the GATE would allow, from a pool the caller has already read. Pure on
         * purpose: `grantPool` is a loopback round trip and this property would
         * otherwise spend three of them per step for one number.
         */
        const ceiling = (currentTier, poolUsd) =>
          effectiveCostUsdLimit(tierLimits(currentTier), { costUsdRemaining: poolUsd, creditsRemaining: 0 });

        let activeTier = tier;
        let allowance = tierLimits(activeTier).monthlyCostUsd;
        let unit = allowance / 8;
        // Provisioning a tenant patches the key, so the sequence starts from a patch
        // exactly as a real tenant does.
        let keyLimit = await patch(activeTier);
        let pool = 0;
        let spend = 0;
        let bought = false;

        assertThat(
          near(keyLimit, allowance),
          `a tenant with no grants was not capped at the bare allowance: ${keyLimit} vs ${allowance} for ${context}`,
        );

        for (const [index, step] of steps.entries()) {
          const spending = step.spend !== undefined;
          if (spending) {
            // Spending draws the allowance first and then the pool, so the pool can
            // only fall - which is the premise the inequality below rests on. Retried
            // settles are P2's subject, not this one, and each `recordRun` is several
            // D1 round trips, so they are left out deliberately.
            const runId = `run_p3_${iteration}_${index}`;
            const costUsd = step.spend * unit;
            await store.recordRun({
              tenantId,
              tier: activeTier,
              runId,
              workflowId: 'wf_p3',
              costUsd,
              tokensIn: 1,
              tokensOut: 1,
            });
            spend += costUsd;
          } else {
            const credits = Math.max(1, Math.round((allowance * step.buy) / 8 / usdPerCredit()));
            const landed = await store.recordCreditGrant({
              tenantId,
              stripePaymentId: `pi_p3_${iteration}_${index}`,
              credits,
              costUsd: grantCostUsd(credits),
            });
            assertThat(landed, `pack ${index} did not land for ${context}`);
            bought = true;
            // A purchase re-patches the cap. That is the whole defect.
            keyLimit = await patch(activeTier);
          }

          // ONE pool read per step, and both claims are made against it: a second
          // read would be a second loopback round trip for the same figure.
          const previousPool = pool;
          pool = (await store.grantPool(tenantId)).costUsdRemaining;
          const now = ceiling(activeTier, pool);

          if (spending) {
            // THE PREMISE, asserted rather than assumed. If a spend could RAISE the
            // pool, the sum would be unsound and the cap would need another clock.
            assertThat(
              pool <= previousPool + EPS,
              `a spend raised the grant pool from ${previousPool} to ${pool} for ${context}`,
            );
            if (pool < previousPool - EPS) coverage.shrank += 1;
          } else {
            // THE EQUALITY. At a patch instant the vendor's ceiling and ours are the
            // same figure, so a run the gate admits cannot be refused upstream.
            assertThat(
              near(keyLimit, now),
              `at a patch the cap ${keyLimit} was not the gate ceiling ${now} for ${context}`,
            );
            assertThat(
              keyLimit > allowance + EPS,
              `a purchase did not raise the cap above the allowance: ${keyLimit} vs ${allowance} for ${context}`,
            );
          }

          // THE CONCLUSION, at every single point in the sequence: the vendor's cap
          // is never below what our own gate would allow.
          assertThat(
            keyLimit >= now - EPS,
            `the key cap ${keyLimit} fell below the gate ceiling ${now} for ${context}`,
          );
        }

        // A TIER CHANGE, which is the other half. Recomputing the cap from the tier
        // alone would delete the pack the tenant paid for; the pool has to survive it.
        if (retier) {
          activeTier = retier;
          allowance = tierLimits(activeTier).monthlyCostUsd;
          unit = allowance / 8;
          keyLimit = await patch(activeTier);
          coverage.retiered += 1;
          assertThat(
            near(keyLimit, allowance + pool),
            `a tier change lost the pool: cap ${keyLimit} against ${allowance} + ${pool} for ${context}`,
          );
          assertThat(
            near(keyLimit, ceiling(activeTier, pool)),
            `after a tier change the cap ${keyLimit} was not the gate ceiling for ${context}`,
          );
        }

        coverage.tiers.add(tier);
        if (retier) coverage.tiers.add(retier);
        if (spend > tierLimits(tier).monthlyCostUsd + EPS) coverage.pastAllowance += 1;
        if (bought && pool <= EPS) coverage.drained += 1;
        return true;
      }),
  );

  // Non-vacuity. Each of these names a region where a wrong implementation passes
  // everywhere else: a cap computed from the tier alone survives every sequence with
  // no purchase in it, and one that never re-patches survives every sequence whose
  // pool is still whole at the end.
  if (held) {
    check(`all three tiers were exercised (${[...coverage.tiers].sort().join(', ')})`, coverage.tiers.size === P3_TIERS.length);
    check(`caps were recomputed many times (${coverage.patches})`, coverage.patches > RUNS.numRuns);
    check(`sequences where spending SHRANK the pool were reached (${coverage.shrank})`, coverage.shrank > 0);
    check(`sequences that drained a purchased pool were reached (${coverage.drained})`, coverage.drained > 0);
    check(`sequences spending past the allowance were reached (${coverage.pastAllowance})`, coverage.pastAllowance > 0);
    check(`tier changes on a tenant holding a pool were reached (${coverage.retiered})`, coverage.retiered > 0);
  }
}

await mf.dispose();

console.log(
  failures === 0
    ? '\nAll entitlement + grant arithmetic checks passed.'
    : `\n${failures} entitlement + grant arithmetic check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
