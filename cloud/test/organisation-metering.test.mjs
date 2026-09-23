/**
 * An organisation is ONE billing and quota bucket, whoever acted
 * (`.kiro/specs/multi-organisation-phorma/`, task 3, Requirements 4.8, 4.9, 4.10
 * and 19.6).
 *
 * Feature: multi-organisation-phorma, Property 11: An organisation is one billing
 * and quota bucket regardless of which member acted.
 *
 * ## Why this is a suite of its own rather than a section of `entitlement.test.mjs`
 *
 * Two reasons, and the first is the interesting one.
 *
 * `entitlement.test.mjs` calls `recordRun` and `resolveHostedInference` with a
 * tenant id the test chose, which is exactly why none of it can see the defect
 * this suite exists to catch: `/api/infer` keyed on `auth.userId` rather than on
 * the resolved owner passes every assertion there, because those assertions are
 * about the id the test handed in. So everything below drives the ROUTE, with real
 * member credentials, and lets the route decide whose meter to move. Reverting that
 * one token fails 19 assertions here.
 *
 * The second is the port range. A route round trip per run is far more proxied D1
 * statements than a store call, and `entitlement` sits mid-chain: the property
 * below passed there in isolation and failed at iteration 20 of the full chain on
 * `connect EADDRINUSE`, which is the harness failure `await-port-drain.mjs` exists
 * for. So this suite runs LAST in `test:unit`, behind a drain barrier of its own.
 *
 * ## The two halves that have to agree
 *
 * The ENTITLEMENT GATE decides whether a call is allowed and against which tier's
 * allowance; the LEDGER WRITE records what it cost. Key one on the owner and the
 * other on the caller and a run is metered against a ceiling it was never checked
 * against - and each half alone looks correct. So every call asserts BOTH: the
 * runtime key forwarded upstream (the gate's answer to "whose account is paying")
 * and the rows that landed (the ledger's).
 *
 * ## Harness
 *
 * A REAL local D1 (Miniflare's SQLite binding reached from Node with the real
 * migrations applied) and the REAL router: `handleApiRequest` is imported and
 * called, so `verifyRequest`, `resolveRole`, `requireCapability`,
 * `resolveHostedInference` and `recordRun` are all genuinely in the path. Session
 * tokens are locally minted RS256, verified by `@clerk/backend`'s offline path
 * against `CLERK_JWT_KEY`, so authorization is never stubbed. The ONE thing
 * replaced is the vendor: `globalThis.fetch` serves OpenRouter as a real SSE
 * stream, because the metering path under test is a stream reader over a `tee()`.
 *
 * `0005` and `0006` are both applied because `org_members` is what `resolveRole`
 * reads for a member whose Clerk role claim is unmapped, and `0006`'s one ALTER is
 * against `workflow_backups`.
 *
 * Run: npx tsx cloud/test/organisation-metering.test.mjs
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
const { TenantStore, encryptString, grantCostUsd, tierLimits } = await import('../src/tenants.ts');

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
 * Money comparison. Every figure here is a REAL column summed by SQLite, so an
 * exact `===` would fail on the drift `0003_billing.sql` documents. The tolerance
 * is far below a cent and far above the drift.
 */
const near = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) < epsilon;

/** Flattens float drift to a millionth of a dollar, so two figures compare structurally. */
const money = (value) => Number(Number(value).toFixed(6));

const EPS = 1e-9;

function assertThat(condition, message) {
  if (!condition) throw new Error(message);
}

/** The counterexample fast-check reports, flattened onto one line. */
function describeFailure(error) {
  return String(error?.message ?? error).split('\n').slice(0, 10).join(' | ');
}

// --- Local D1 with the real migrations -------------------------------------

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

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  d1Databases: { DB: 'phorma-cloud-org-metering' },
});
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

// A 32-byte base64 secret, so the stored runtime keys actually decrypt - without
// it every tenant refuses with `no_runtime_key` and nothing below is reachable.
const KEY_ENC_SECRET = Buffer.alloc(32, 7).toString('base64');
const ORG_RUNTIME_KEY = 'sk-or-v1-org-runtime';
const PERSONAL_RUNTIME_KEY = 'sk-or-v1-personal-runtime';
const INFER_MODEL = 'openai/gpt-4o-mini';

const store = new TenantStore({ DB, KEY_ENC_SECRET });
const month = new Date().toISOString().slice(0, 7);
const STARTER = tierLimits('starter');

// --- The vendor stub -------------------------------------------------------

const realFetch = globalThis.fetch;

/**
 * OpenRouter's streamed answer, carrying the usage frame `meterInferenceStream`
 * parses.
 *
 * A real SSE body and not a canned object: the metering path under test is a
 * stream reader, so a stub answering JSON would exercise none of it. The
 * Authorization header is captured because the key the worker forwarded is the
 * entitlement gate's answer to "whose account is paying" and is otherwise
 * unobservable.
 */
function inferenceStub(costUsd, { tokensIn = 11, tokensOut = 22 } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host !== 'openrouter.ai') throw new Error(`unexpected outbound call to ${url.host}`);
    calls.push({ authorization: (init.headers ?? {}).Authorization ?? null });
    const frames = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      `data: {"usage":{"prompt_tokens":${tokensIn},"completion_tokens":${tokensOut},"cost":${costUsd}}}`,
      'data: [DONE]',
    ];
    return new Response(`${frames.join('\n\n')}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// --- Credentials -----------------------------------------------------------

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * A real RS256 session token. `org_id` and `org_role` are TOP-LEVEL claims, which
 * is the layout `readOrgClaim` prefers; the compacted `o: {id, rol}` layout is
 * covered in `owner-identity.test.mjs` and needs no second copy here.
 */
function mintToken(sub, claims = {}) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'phorma-org-metering-test' })}.${enc({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

// No `TENANTS` binding, deliberately: the `org_members` read and the tenant read
// both go to D1 on every call, so a level or a tier can never be served from a
// cache a previous assertion warmed.
const env = {
  PHORMA_MODE: 'hosted',
  CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
  CLERK_JWT_KEY,
  KEY_ENC_SECRET,
  DB,
};

/**
 * One `/api/infer` call, end to end through the real router.
 *
 * Two things here are load-bearing rather than tidy. The client's copy of the
 * `tee()` is read to completion, as a studio reads it. And `ctx.waitUntil` is
 * AWAITED: the ledger write lives there, Node will not wait for it, and without
 * this every rollup below reads 0 and every assertion passes for the wrong
 * reason.
 */
async function infer(token, costUsd) {
  const stub = inferenceStub(costUsd);
  try {
    const pending = [];
    const response = await handleApiRequest(
      new Request('https://cloud.example.com/api/infer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: INFER_MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
      { 'Access-Control-Allow-Origin': 'http://localhost:7322' },
      { waitUntil: (promise) => pending.push(promise), passThroughOnException: () => undefined },
    );
    const streamed = response.ok ? await response.text() : null;
    const body = response.ok ? null : await response.json().catch(() => null);
    await Promise.all(pending);
    return {
      status: response.status,
      body,
      streamed,
      forwardedKey: stub.calls[0]?.authorization ?? null,
      vendorCalls: stub.calls.length,
    };
  } finally {
    stub.restore();
  }
}

// --- Seeding ---------------------------------------------------------------

/**
 * One organisation, its members and its billing state, in ONE `DB.batch`.
 *
 * Batched because each proxied statement costs a loopback socket and the property
 * below repeats this per iteration - the rule every D1-backed suite here follows.
 * `withLoopbackRetryD1` wraps `batch` and unwraps each statement, so batching
 * keeps the retry protection rather than opting out of it.
 */
async function seedOrg(orgId, members, { tier = 'starter', costUsdUsed = 0, packCredits = 0 } = {}) {
  const at = new Date().toISOString();
  const statements = [
    DB.prepare(
      `INSERT INTO tenants (id, email, tier, status, openrouter_key_id, openrouter_key_enc,
                            created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(
      orgId,
      `billing@${orgId}.example.com`,
      tier,
      `hash_${orgId}`,
      await encryptString(ORG_RUNTIME_KEY, KEY_ENC_SECRET),
      at,
      at,
    ),
    ...members.map(([userId, level]) =>
      DB.prepare(
        `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(orgId, userId, level, at, at),
    ),
  ];
  if (costUsdUsed > 0) {
    statements.push(
      DB.prepare(
        `INSERT INTO quotas (tenant_id, month, runs_used, cost_usd_used) VALUES (?, ?, 0, ?)`,
      ).bind(orgId, month, costUsdUsed),
    );
  }
  if (packCredits > 0) {
    statements.push(
      DB.prepare(
        `INSERT INTO credit_grants (tenant_id, stripe_payment_id, credits, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(orgId, `pi_${orgId}`, packCredits, grantCostUsd(packCredits), at),
    );
  }
  await DB.batch(statements);
}

/** A member's own personal tenant row, holding a DIFFERENT runtime key. */
async function seedPersonal(userId, { tier = 'starter', status = 'active' } = {}) {
  await store.upsertTenant({
    id: userId,
    email: `${userId}@example.com`,
    tier,
    status,
    openrouterKeyId: `hash_${userId}`,
    openrouterKeyEnc: await encryptString(PERSONAL_RUNTIME_KEY, KEY_ENC_SECRET),
  });
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

// --- Reads -----------------------------------------------------------------

/**
 * The whole metered picture in ONE statement: the organisation's ledger rows,
 * rollup and grant draw, plus how many rows landed under a MEMBER's id - which is
 * the figure that moves on the defect, and reads 0 in every correct case.
 */
async function bucketOf(orgId, memberIds) {
  const members = [...memberIds, '', '', ''].slice(0, 3);
  const row = await DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM usage WHERE tenant_id = ?) AS org_rows,
       (SELECT COALESCE(cost_usd_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?)
         AS cost_usd_used,
       (SELECT COALESCE(runs_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?) AS runs_used,
       (SELECT COALESCE(SUM(cost_usd_consumed), 0) FROM credit_grants WHERE tenant_id = ?) AS drawn,
       (SELECT COUNT(*) FROM usage WHERE tenant_id IN (?, ?, ?)) AS member_rows,
       (SELECT COUNT(*) FROM quotas WHERE tenant_id IN (?, ?, ?)) AS member_quotas`,
  )
    .bind(orgId, orgId, month, orgId, month, orgId, ...members, ...members)
    .first();
  return {
    orgRows: Number(row?.org_rows ?? 0),
    costUsdUsed: Number(row?.cost_usd_used ?? 0),
    runsUsed: Number(row?.runs_used ?? 0),
    drawn: Number(row?.drawn ?? 0),
    memberRows: Number(row?.member_rows ?? 0),
    memberQuotas: Number(row?.member_quotas ?? 0),
  };
}

/** One personal tenant's own rollup, for the converse assertions. */
async function personalMeterOf(tenantId) {
  const row = await DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM usage WHERE tenant_id = ?) AS rows_used,
       (SELECT COALESCE(cost_usd_used, 0) FROM quotas WHERE tenant_id = ? AND month = ?) AS cost,
       (SELECT COALESCE(SUM(cost_usd_consumed), 0) FROM credit_grants WHERE tenant_id = ?) AS drawn`,
  )
    .bind(tenantId, tenantId, month, tenantId)
    .first();
  return {
    ledgerRows: Number(row?.rows_used ?? 0),
    costUsdUsed: Number(row?.cost ?? 0),
    drawn: Number(row?.drawn ?? 0),
  };
}

// ══ 1. Every member meters against the organisation ═════════════════════════
//
// The two member shapes are both here on purpose. An `org:admin` claim is mapped
// by `CLERK_ROLE_LEVELS` and resolves with no `org_members` read at all, while an
// `org:member` claim is unmapped and falls through to the table - two different
// routes through `resolveRole`, one owner. A member with NO role claim is the
// third, which is what a `device` credential looks like.

console.log('\nEvery member of an organisation meters against the organisation (Requirements 4.8, 4.9, 4.10)');
{
  const ORG = 'org_bucket_alpha';
  const ADMIN = 'user_bucket_admin';
  const EDITOR = 'user_bucket_editor';
  const OPERATOR = 'user_bucket_operator';
  const MEMBERS = [ADMIN, EDITOR, OPERATOR];

  await seedOrg(ORG, [
    [ADMIN, 'admin'],
    [EDITOR, 'editor'],
    [OPERATOR, 'operator'],
  ]);
  // Each member also has a personal account of their own: provisioned, active and
  // holding a DIFFERENT runtime key. Without that, the "nothing landed on the
  // member" assertions would also hold for a worker that simply failed to find a
  // member's row, which is a different bug wearing the same result.
  for (const member of MEMBERS) await seedPersonal(member);

  const asAdmin = await infer(mintToken(ADMIN, { org_id: ORG, org_role: 'org:admin' }), 1);
  check('an organisation admin may spend the organisation credits', asAdmin.status === 200, JSON.stringify(asAdmin.body));
  check(
    "and the key forwarded upstream is the ORGANISATION's, not their own",
    asAdmin.forwardedKey === `Bearer ${ORG_RUNTIME_KEY}`,
    String(asAdmin.forwardedKey),
  );
  check('the stream reaches the caller intact', asAdmin.streamed?.includes('[DONE]') === true);

  const asEditor = await infer(mintToken(EDITOR, { org_id: ORG, org_role: 'org:member' }), 0.5);
  check('a member whose role claim is unmapped resolves from org_members', asEditor.status === 200, JSON.stringify(asEditor.body));
  check('and spends the same organisation key', asEditor.forwardedKey === `Bearer ${ORG_RUNTIME_KEY}`, String(asEditor.forwardedKey));

  const asOperator = await infer(mintToken(OPERATOR, { org_id: ORG }), 0.25);
  check('an operator with no role claim at all still runs', asOperator.status === 200, JSON.stringify(asOperator.body));

  const bucket = await bucketOf(ORG, MEMBERS);
  check('every ledger row landed under the organisation', bucket.orgRows === 3, JSON.stringify(bucket));
  check('the rollup is the sum over the runs, whoever made them', near(bucket.costUsdUsed, 1.75), JSON.stringify(bucket));
  // `countsAsRun: false` is a property of the route, not of the owner: local
  // inference spends credits and must not consume the deployed-run allowance.
  check('and the run count is still untouched by inference', bucket.runsUsed === 0, JSON.stringify(bucket));
  check('NOTHING landed on any member as a tenant', bucket.memberRows === 0 && bucket.memberQuotas === 0, JSON.stringify(bucket));
}

// ══ 2. The grant pool is the organisation's too (Requirement 4.10) ══════════

console.log("\nA member's overage draws the ORGANISATION's pack, never their own (Requirements 4.10, 19.1)");
{
  const ORG = 'org_bucket_pool';
  const MEMBER = 'user_bucket_pool_member';
  await seedOrg(ORG, [[MEMBER, 'operator']], {
    // The allowance is already gone, so the whole cost of the next run has to come
    // off the pack - which is the case that proves WHOSE pack it is.
    costUsdUsed: STARTER.monthlyCostUsd,
    packCredits: 500,
  });
  await seedPersonal(MEMBER);
  await seedGrant(MEMBER, 'pi_bucket_personal_pack', 1000);

  const drew = await infer(mintToken(MEMBER, { org_id: ORG, org_role: 'org:member' }), 0.75);
  check("a member's run past the allowance is allowed by the ORGANISATION's pack", drew.status === 200, JSON.stringify(drew.body));
  const pooled = await bucketOf(ORG, [MEMBER]);
  check("and draws from the organisation's pool", near(pooled.drawn, 0.75), JSON.stringify(pooled));
  const personal = await personalMeterOf(MEMBER);
  check("while the member's own purchased pack is untouched", personal.drawn === 0, JSON.stringify(personal));

  // ── The converse, which is what makes the split real ─────────────────────
  //
  // The SAME human, signed in with no organisation. Their own meter must move and
  // the organisation's must not.
  const asThemselves = await infer(mintToken(MEMBER), 0.25);
  check('the same human signed in personally still meters to themselves', asThemselves.status === 200, JSON.stringify(asThemselves.body));
  check(
    'with their OWN runtime key',
    asThemselves.forwardedKey === `Bearer ${PERSONAL_RUNTIME_KEY}`,
    String(asThemselves.forwardedKey),
  );
  const afterPersonal = await personalMeterOf(MEMBER);
  check('their personal rollup moved', near(afterPersonal.costUsdUsed, 0.25) && afterPersonal.ledgerRows === 1, JSON.stringify(afterPersonal));
  const afterOrg = await bucketOf(ORG, [MEMBER]);
  check(
    "and the organisation's rollup did not",
    afterOrg.orgRows === 1 && near(afterOrg.costUsdUsed, STARTER.monthlyCostUsd + 0.75),
    JSON.stringify(afterOrg),
  );
}

// ══ 3. Entitlement is the ORGANISATION's, never the member's (Req 19.6) ═════
//
// A member whose personal account is fully paid up, in an organisation that has
// never been provisioned. The refusal is the whole point: reading the member's row
// here would let one subscriber's card quietly fund a whole company.

console.log('\nAn unprovisioned organisation refuses its fully paid-up member (Requirement 19.6)');
{
  const ORG = 'org_bucket_unpaid';
  const MEMBER = 'user_bucket_paid_member';
  const at = new Date().toISOString();
  await seedPersonal(MEMBER);
  await DB.batch([
    DB.prepare(
      `INSERT INTO org_members (org_id, user_id, level, created_at, updated_at)
       VALUES (?, ?, 'admin', ?, ?)`,
    ).bind(ORG, MEMBER, at, at),
  ]);

  const refused = await infer(mintToken(MEMBER, { org_id: ORG, org_role: 'org:admin' }), 1);
  check('the run is refused', refused.status === 402, String(refused.status));
  check('with no_subscription', refused.body?.code === 'no_subscription', JSON.stringify(refused.body));
  check('and never reaches the vendor', refused.vendorCalls === 0, String(refused.vendorCalls));
  const unpaid = await bucketOf(ORG, [MEMBER]);
  check('nothing was written for the organisation', unpaid.orgRows === 0 && unpaid.costUsdUsed === 0, JSON.stringify(unpaid));
  check("nor against the member's paid-up personal account", unpaid.memberRows === 0, JSON.stringify(unpaid));
}

// ══ 4. Rotate the actors, keep the costs: the rollup must not notice ════════

console.log('\nThe same costs made by different members produce the same rollup (Property 11)');
{
  const COSTS = [0.5, 0.25, 1];
  const rollups = [];
  for (const [index, rotation] of [
    [0, 1, 2],
    [2, 0, 1],
  ].entries()) {
    const orgId = `org_bucket_rotation_${index}`;
    const people = [0, 1, 2].map((slot) => `user_bucket_rotation_${index}_${slot}`);
    await seedOrg(
      orgId,
      people.map((userId) => [userId, 'operator']),
    );
    for (const [slot, cost] of COSTS.entries()) {
      const actor = people[rotation[slot]];
      const answer = await infer(mintToken(actor, { org_id: orgId, org_role: 'org:member' }), cost);
      if (answer.status !== 200) {
        check(`rotation ${index} run ${slot} succeeded`, false, JSON.stringify(answer.body));
      }
    }
    rollups.push(await bucketOf(orgId, people));
  }
  check(
    'the rollups are identical',
    money(rollups[0].costUsdUsed) === money(rollups[1].costUsdUsed) && rollups[0].orgRows === rollups[1].orgRows,
    JSON.stringify(rollups),
  );
  check(
    'and neither rotation left a row under any member',
    rollups.every((rollup) => rollup.memberRows === 0),
    JSON.stringify(rollups),
  );
}

// ══ 5. The bucket law over ANY interleaving ═════════════════════════════════
//
// The sections above pin three actors and costs a reader chose. This states the
// law over any interleaving: the organisation's rollup and grant draw are a
// function of the COSTS ALONE, and who acted is not an input. The oracle never
// mentions an actor, which is what makes actor-independence the thing asserted
// rather than a claim in a comment.
//
// The draw's closed form is the conservation law `entitlement.test.mjs`'s P2 uses,
// for P2's reason: `clamp(total - allowance, 0, pool)` is a DIFFERENT formulation
// from the per-run difference-of-overages the code computes, so it fails on a
// handler that draws whole runs as well as on one that draws nothing.
//
// SEEDED, like every property in this repo, so the coverage counters below are a
// property of the generator rather than of the day. Set FC_SEED to fuzz for new
// counterexamples; a seed that fails is a real counterexample.

console.log('\nAn organisation is one bucket over any interleaving of member runs (Property 11)');
{
  const RUNS = { numRuns: 24, seed: Number(process.env.FC_SEED ?? 20260925) };
  const PACK_CREDITS = 2500;
  const POOL_USD = grantCostUsd(PACK_CREDITS);
  const ALLOWANCE = STARTER.monthlyCostUsd;
  const UNIT = ALLOWANCE / 8;

  // Eighths of the tier's OWN allowance rather than absolute dollars, so the
  // allowance boundary sits in the middle of the generated range instead of at an
  // edge, and a sequence landing EXACTLY on it is routine rather than a
  // coincidence. `head` is the rollup the month already carries.
  //
  // The range is BOUNDED BELOW the entitlement ceiling on purpose: 8 + 3x3 eighths
  // is at most $8.50 against a $4 allowance and a $10 pack, and the gate refuses at
  // $9 of spend, because its limit is the allowance plus the REMAINING pool and so
  // descends as the pool is drawn. Every generated sequence therefore runs to
  // completion, and the only thing that varies is what this property is about -
  // whose meter moved. The ceiling arithmetic and its clamp belong to
  // `entitlement.test.mjs`'s P2 and P3, which state them over three tiers with no
  // route in the path.
  const arbCase = fc.record({
    head: fc.integer({ min: 0, max: 8 }),
    runs: fc.array(
      fc.record({ actor: fc.nat({ max: 2 }), eighths: fc.integer({ min: 0, max: 3 }) }),
      { minLength: 1, maxLength: 3 },
    ),
  });

  const coverage = { insideAllowance: 0, pastAllowance: 0, actors: new Set() };
  let iteration = 0;
  let held = false;

  try {
    await fc.assert(
      fc.asyncProperty(arbCase, async ({ head, runs }) => {
        // Ids are namespaced PER ITERATION: `usage(tenant_id, run_id)` and
        // `credit_grants.stripe_payment_id` are globally unique, so a shared id
        // would make a later iteration silently no-op and read as a pass. Bumped
        // inside the body, which also covers fast-check replaying while shrinking.
        iteration += 1;
        const orgId = `org_law_${iteration}`;
        const people = [0, 1, 2].map((slot) => `user_law_${iteration}_${slot}`);
        const context = JSON.stringify({ head, runs });
        const headUsd = head * UNIT;

        await seedOrg(
          orgId,
          people.map((userId) => [userId, 'operator']),
          { costUsdUsed: headUsd, packCredits: PACK_CREDITS },
        );

        let total = headUsd;
        for (const run of runs) {
          const cost = run.eighths * UNIT;
          total += cost;
          coverage.actors.add(run.actor);
          const answer = await infer(
            mintToken(people[run.actor], { org_id: orgId, org_role: 'org:member' }),
            cost,
          );
          assertThat(
            answer.status === 200,
            `a member run was refused (${answer.status} ${JSON.stringify(answer.body)}) for ${context}`,
          );
          assertThat(
            answer.forwardedKey === `Bearer ${ORG_RUNTIME_KEY}`,
            `the gate spent ${answer.forwardedKey} rather than the organisation key for ${context}`,
          );
        }

        const bucket = await bucketOf(orgId, people);
        const expected = {
          rows: runs.length,
          cost: money(total),
          runs: 0,
          drawn: money(Math.min(Math.max(total - ALLOWANCE, 0), POOL_USD)),
          memberRows: 0,
          memberQuotas: 0,
        };
        const actual = {
          rows: bucket.orgRows,
          cost: money(bucket.costUsdUsed),
          runs: bucket.runsUsed,
          drawn: money(bucket.drawn),
          memberRows: bucket.memberRows,
          memberQuotas: bucket.memberQuotas,
        };
        assertThat(
          JSON.stringify(expected) === JSON.stringify(actual),
          `the organisation bucket: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} for ${context}`,
        );

        if (total > ALLOWANCE + EPS) coverage.pastAllowance += 1;
        else coverage.insideAllowance += 1;
        return true;
      }),
      RUNS,
    );
    check('the bucket law holds over every generated interleaving', true);
    held = true;
  } catch (error) {
    check('the bucket law holds over every generated interleaving', false, describeFailure(error));
  }

  // Non-vacuity. A worker that metered the CALLER would fail the first iteration,
  // so what needs naming is that all three members were actually used - a
  // generator that collapsed onto one actor would make the actor-independence
  // claim vacuous while every assertion still passed - and that both sides of the
  // allowance were visited, since a draw only happens on one of them.
  if (held) {
    check(`all three members acted (${[...coverage.actors].sort().join(', ')})`, coverage.actors.size === 3);
    check(`interleavings inside the allowance were reached (${coverage.insideAllowance})`, coverage.insideAllowance > 0);
    check(`interleavings past the allowance were reached (${coverage.pastAllowance})`, coverage.pastAllowance > 0);
  }
}

globalThis.fetch = realFetch;
await mf.dispose();

console.log(
  failures === 0
    ? '\nAll organisation metering checks passed.'
    : `\n${failures} organisation metering check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
