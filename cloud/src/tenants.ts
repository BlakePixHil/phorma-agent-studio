/**
 * Phorma Cloud tenant store — hosted-mode control plane.
 *
 * Owns everything multi-tenant that is NOT run execution:
 *  - tenant records (D1 `tenants` table, KV-cached for the hot path)
 *  - tier definitions + quota math (D1 `quotas` rollup)
 *  - per-run usage ledger writes (D1 `usage` table)
 *  - per-tenant OpenRouter runtime keys: minted through OpenRouter's
 *    provisioning API with a hard credit limit, stored AES-GCM encrypted,
 *    re-limited when the tier moves and retired when a replacement supersedes
 *    them (`reconcileRuntimeKey`, `disableTenantRuntimeKey`)
 *
 * BYO deployments never bind `DB`/`TENANTS`, so none of this code runs
 * outside Phorma Labs' own deployment.
 */

export interface TenantEnv {
  /** D1 — authoritative tenant/usage/quota store (hosted mode only). */
  DB?: D1Database;
  /** KV — short-TTL cache for tenant rows + quota rollups (hosted mode only). */
  TENANTS?: KVNamespace;
  /** 32-byte base64 secret for AES-GCM encryption of stored runtime keys. */
  KEY_ENC_SECRET?: string;
  /** OpenRouter provisioning (management) key — mints per-tenant runtime keys. */
  OPENROUTER_PROVISIONING_KEY?: string;
  /**
   * UUID of the OpenRouter WORKSPACE per-tenant runtime keys are minted into
   * (requirement 36).
   *
   * OPTIONAL, and absent means OpenRouter's DEFAULT workspace - which is exactly
   * what every key minted before this field existed got, because `POST /keys`
   * defaults there when the body carries no `workspace_id`. So leaving it unset
   * reproduces today's behaviour rather than failing, which is what a BYO worker
   * and a local `wrangler dev` need.
   *
   * A `var`, not a secret: a workspace UUID authorizes nothing on its own, the
   * management key is what does. The same management key reaches every workspace
   * on the account (OpenRouter documents Management Keys as account-level, "for
   * administrative actions across all workspaces"), so moving the fleet to a
   * dedicated workspace is this one id plus a re-mint - see
   * `scripts/migrate-openrouter-workspace.mjs`.
   */
  OPENROUTER_WORKSPACE_ID?: string;
  /** Static bearer protecting the admin provisioning endpoints. */
  PHORMA_ADMIN_TOKEN?: string;
  /**
   * Phorma Labs' TypeSafe API key for System One (Jev) decisions made on behalf
   * of hosted tenants: `/api/decide` (local runs) and hosted DO runs. Metered
   * against tenant credits like `/api/infer`. Hosted only:
   * `npx wrangler secret put TYPESAFE_PLATFORM_KEY --env hosted`.
   */
  TYPESAFE_PLATFORM_KEY?: string;
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export interface TierLimits {
  /**
   * Monthly usage-credit allowance shown to the user — the ONLY billing unit
   * the UI ever displays. Deliberately a round marketing number that is
   * decoupled from the real inference cost so the underlying spend (and our
   * margin) stays abstract. Higher tiers include a volume bonus: a credit
   * buys progressively more real inference as the tier climbs.
   */
  monthlyCredits: number;
  /**
   * Monthly inference budget (USD) — the real spend cap, mirrored into the
   * OpenRouter key limit. NEVER surfaced to the user; `monthlyCredits` is the
   * public face of this number. The per-tier ratio of credits→USD is the
   * "burn rate" (higher tiers burn slower = the volume bonus).
   */
  monthlyCostUsd: number;
  /** Monthly run count cap. */
  monthlyRuns: number;
  /** Max concurrently running workflows (enforced per-instance for now). */
  concurrentRuns: number;
  /** Max active cron schedules per workflow. */
  schedulesPerWorkflow: number;
  /** Maximum nested Execute Workflow frame depth. */
  subWorkflowDepth: number;
  /**
   * Max simultaneously published portals (EPIC 9). A published endpoint is
   * reachable by strangers and spends the tenant's credits, so the count is
   * capped per tier rather than left unbounded.
   */
  publishedPortals: number;
  /**
   * Max workflows with a live backup (cloud-workflow-backup, Requirement 10.9).
   *
   * A CEILING ON NEW workflows only: a tenant at the cap keeps accepting uploads
   * for workflows that already have a row, because a backup going stale because
   * of a cap is the failure this feature exists to prevent (Requirement 10.11).
   */
  backupWorkflows: number;
}

// Base rate: 125 credits ≈ $1 of real inference ($0.008/credit) with NO bonus
// (starter). Higher tiers keep round credit numbers but a larger USD budget,
// so each credit buys more real inference - the volume bonus. The USD budget
// is deliberately set to ~20% of price (was ~40%) to target a 75-80% margin on
// the AI spend line - the only real cost, since Cloudflare infra (DO
// duration/requests + D1 + KV) runs at a small fraction of a cent per run and
// is not a meaningful lever. Credit numbers are UNCHANGED by that budget move;
// only the internal figure changed, which is the point of the abstraction.
//
// MARGIN IS MEASURED ON NET REVENUE, NOT ON THE PUBLISHED PRICE (requirement
// 49). Every price in the Stripe catalogue carries `tax_behavior: 'inclusive'`,
// so the number on the pricing page is the number the customer pays and the tax
// is carved OUT of it and remitted. That share was never ours, so it cannot
// count towards margin. Re-derivable at a 10 percent GST rate:
//
//   tier     price   net (price / 1.1)   monthlyCostUsd   net margin
//   starter  $20     $18.18              $4               78.0%
//   pro      $60     $54.55              $12.60           76.9%
//   team     $200    $181.82             $44              75.8%
//
// The comment that used to sit here claimed 80 / 79 / 78. That is the same table
// computed on GROSS - ($20 - $4) / $20 and so on - which is sound arithmetic
// answering the wrong question.
//
// THIS IS A COMMENT CORRECTION, NOT A REPRICING (requirement 50). All three net
// figures are still inside the documented 75-80 percent target band, so no
// price, no credit count and no `monthlyCostUsd` below moves. Do not "fix" the
// prices to restore an 80 percent headline: the headline was measuring pre-tax
// revenue we never receive.
//
// These are the FLOOR, not the expectation. A sale into a jurisdiction where we
// charge no tax collects the full gross price and so returns the old 80 / 79 /
// 78 figures; the table above is what the worst currently-registered rate does
// to them. 10 percent is AU GST, the one obligation being registered (task
// 9.6), so the trigger to revisit this is a NEW registration at a higher VAT
// rate - which would push these under the band - and not a change in here.
//
// The top-up packs are the same calculation with a worse answer, and the numbers
// live with the packs rather than being restated here:
// `frontend/src/app/core/credit-packs.ts` records 78.0 / 72.5 / 72.5 on the same
// net basis, with Medium and Large sitting 2.5 points UNDER the floor pending
// the pricing decision in task 9.2a. Their cost basis is `usdPerCredit()` below,
// so it is this table's starter row they are priced against.
//
// Tier lineup: starter / pro / team (displayed "Teams"), plus a custom
// enterprise tier that is provisioned per-deal (no fixed limits here —
// unknown tiers fall back to starter until provisioned properly).
export const TIERS: Record<string, TierLimits> = {
  starter: { monthlyCredits: 1000, monthlyCostUsd: 4, monthlyRuns: 300, concurrentRuns: 1, schedulesPerWorkflow: 1, subWorkflowDepth: 5, publishedPortals: 1, backupWorkflows: 25 },
  pro: { monthlyCredits: 3000, monthlyCostUsd: 12.6, monthlyRuns: 2000, concurrentRuns: 3, schedulesPerWorkflow: 5, subWorkflowDepth: 8, publishedPortals: 5, backupWorkflows: 100 },
  team: { monthlyCredits: 10000, monthlyCostUsd: 44, monthlyRuns: 10000, concurrentRuns: 10, schedulesPerWorkflow: 20, subWorkflowDepth: 10, publishedPortals: 25, backupWorkflows: 250 },
};

export function tierLimits(tier: string): TierLimits {
  return TIERS[tier] ?? TIERS['starter'];
}

/**
 * Converts a real USD inference cost into the tier's display credits. Uses the
 * tier's own credits↔USD ratio so the volume bonus is applied automatically:
 * `credits = round(costUsd / monthlyCostUsd * monthlyCredits)`. Result is
 * clamped at 0. This is the ONLY function that turns dollars into the number
 * the user sees.
 */
export function creditsForTier(tier: string, costUsd: number): number {
  const limits = tierLimits(tier);
  if (limits.monthlyCostUsd <= 0) return 0;
  return Math.max(0, Math.round((costUsd / limits.monthlyCostUsd) * limits.monthlyCredits));
}

/** Credits earned per USD of real inference for a tier (the inverse burn rate). */
export function creditsPerUsd(tier: string): number {
  const limits = tierLimits(tier);
  if (limits.monthlyCostUsd <= 0) return 0;
  return limits.monthlyCredits / limits.monthlyCostUsd;
}

/**
 * Whether `TIERS` declares this tier at all — the requirement 7 predicate.
 *
 * `tierLimits` cannot answer this, and that is the point: it FALLS BACK to
 * starter for an unknown id, which is the right behaviour for an already-paid
 * tenant whose row carries a tier this worker version does not know (they keep
 * working, at the floor). It is exactly the wrong behaviour when the question is
 * "should we sell this?", because a Stripe price whose `metadata.tier` is a typo
 * would then quietly become a starter subscription. The billing catalogue
 * (`stripe.ts`) refuses instead, and this is what lets it.
 *
 * `hasOwnProperty` rather than `TIERS[tier] !== undefined`, because `TIERS` is a
 * plain object literal and the input is a string off a Stripe price: without it
 * `isKnownTier('toString')` and `isKnownTier('constructor')` are both true, and
 * `tierLimits` would then hand back starter's limits for a tier nobody declared.
 */
export function isKnownTier(tier: string): boolean {
  return Object.prototype.hasOwnProperty.call(TIERS, tier);
}

/**
 * USD of real inference one PURCHASED credit is worth: the starter tier's own
 * credits-to-USD ratio, `4 / 1000` = $0.004 (requirement 8).
 *
 * Derived from `TIERS.starter` rather than written as a literal, so a top-up
 * pack's cost basis cannot drift away from the tier model it is priced against.
 * Starter specifically, because it is the tier with NO volume bonus: a pack costs
 * the same to fulfil whoever buys it, so pricing it off the buyer's own tier
 * would make a Team customer's pack cost us 2.75x a Starter customer's for the
 * same money.
 *
 * Returns 0 if starter ever loses its credit allowance, which makes
 * {@link grantCostUsd} return 0 and the catalogue refuse the pack. That is the
 * safe direction: a pack with no computable budget is not sold, rather than sold
 * and then granting nothing.
 */
export function usdPerCredit(): number {
  const starter: TierLimits | undefined = TIERS['starter'];
  if (!starter || starter.monthlyCredits <= 0) return 0;
  return starter.monthlyCostUsd / starter.monthlyCredits;
}

/**
 * The real USD inference budget a top-up of `credits` buys — computed ONCE, at
 * purchase, and frozen into `credit_grants.cost_usd`.
 *
 * Two readers need two units (requirement 22): the inference gate compares USD,
 * the studio may only ever show credits. This is the one conversion between them
 * for a PURCHASE, and it is deliberately not `creditsForTier`'s inverse —
 * `creditsForTier` maps a real cost into the buyer's tier display, while a pack
 * is priced off starter regardless of who buys it.
 *
 * The result is stored rather than recomputed on read, so a later reprice cannot
 * reach backwards and shrink a pack somebody already paid for. See the
 * requirement 22 block in `migrations/0003_billing.sql`.
 *
 * A non-positive or non-finite count yields 0, so a garbage `metadata.credits`
 * fails towards "no budget, refuse the sale" instead of NaN reaching a REAL
 * column.
 */
export function grantCostUsd(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  return credits * usdPerCredit();
}

// ── Grant pool arithmetic (requirements 22, 23, 24) ──────────────────────────

/**
 * What a tenant's UNSPENT top-up grants are worth, in both units the system
 * needs (requirement 22): USD because the gate compares USD, credits because the
 * studio may only ever display credits.
 *
 * Both numbers are REMAINING, never purchased totals. A grant is spent by
 * `cost_usd_consumed` climbing towards `cost_usd`, so "remaining" is the only
 * figure either reader has a use for, and computing it once in SQL keeps the
 * per-grant clamp in one place.
 */
export interface GrantPool {
  /**
   * `SUM(cost_usd - cost_usd_consumed)` over the tenant's grants, clamped at 0
   * per grant AND in total. The clamp is the schema's assignment, not caution:
   * `0003_billing.sql` deliberately carries no `cost_usd_consumed <= cost_usd`
   * CHECK, because both columns are REAL and a draw that lands exactly on the
   * ceiling can settle a fraction of 1e-15 above it, so the invariant is
   * enforced by arithmetic here and by `MIN(cost_usd, ...)` on the write.
   */
  costUsdRemaining: number;
  /**
   * The same pool expressed in credits, each grant valued at ITS OWN
   * purchase-time ratio: `credits * remainingUsd / cost_usd`, summed and rounded.
   *
   * Deliberately NOT `costUsdRemaining / usdPerCredit()`. That would re-run
   * today's starter economics over a purchase made under yesterday's, so
   * halving `TIERS.starter.monthlyCostUsd` would silently halve every unspent
   * pack anybody had already paid for - the exact reason `cost_usd` is a frozen
   * column rather than a derivation.
   */
  creditsRemaining: number;
}

/**
 * A tenant with no grants, and the value every read falls back to.
 *
 * Frozen because it is a SHARED instance handed back by {@link
 * TenantStore.grantPool}: a caller that treated a pool as scratch space would
 * otherwise corrupt every later read in the same isolate.
 */
export const EMPTY_GRANT_POOL: GrantPool = Object.freeze({
  costUsdRemaining: 0,
  creditsRemaining: 0,
});

/**
 * The real spend ceiling for a tenant this month: the tier's monthly allowance
 * PLUS whatever their purchased grants still hold (requirement 22).
 *
 * Grants RAISE the ceiling rather than reducing recorded usage, which is what
 * makes requirement 23 hold with no expiry logic: `quotas` resets by acquiring a
 * new `(tenant_id, month)` row, and a grant is not keyed by month, so it simply
 * keeps raising next month's ceiling too.
 */
export function effectiveCostUsdLimit(limits: TierLimits, pool: GrantPool): number {
  return Math.max(0, limits.monthlyCostUsd) + Math.max(0, pool.costUsdRemaining);
}

/** The same ceiling in the only unit the UI may show. */
export function effectiveCreditsLimit(limits: TierLimits, pool: GrantPool): number {
  return Math.max(0, limits.monthlyCredits) + Math.max(0, pool.creditsRemaining);
}

/**
 * How much of ONE run's cost comes out of purchased grants rather than out of
 * the tier's monthly allowance. Requirement 24, and the whole of it.
 *
 * The allowance is spent FIRST, so a run is split at the allowance boundary
 * rather than assigned wholesale to one side:
 *
 * ```
 *   allowance 4.00, used 3.50, run costs 0.80
 *     -> 0.50 comes out of the allowance, 0.30 is drawn from grants
 * ```
 *
 * Written as the DIFFERENCE of two overages instead of a three-branch
 * conditional, because that form is correct for the straddling run above without
 * naming it as a case: `max(0, used + cost - allowance) - max(0, used -
 * allowance)` is 0 while a run stays inside the allowance, the whole cost once it
 * is past, and exactly the part past the line for the one run that crosses it.
 *
 * Pure, and separated from the SQL on purpose: this is the rule that decides
 * whether a tenant keeps a pack they did not need this month, and it must be
 * assertable without a database.
 *
 * Every input is coerced rather than trusted. `costUsd` reaches `recordRun` from
 * an OpenRouter usage block, and `costUsdUsedBefore` is derived by SUBTRACTION
 * from the rollup the write just returned, so a NaN on either side would make the
 * draw NaN and park one in a REAL column.
 */
export function grantDrawUsd(input: {
  /** This run's real cost, in USD. */
  costUsd: number;
  /**
   * `quotas.cost_usd_used` BEFORE this run landed. `recordRun` derives it from
   * the value its own rollup write returned, minus this run's cost, so the
   * before-value cannot be read by a second statement another settle could have
   * moved in between.
   */
  costUsdUsedBefore: number;
  /** The tier's monthly USD allowance, `tierLimits(tier).monthlyCostUsd`. */
  monthlyCostUsd: number;
}): number {
  const cost = Number(input.costUsd);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const allowance = Number.isFinite(input.monthlyCostUsd) ? Math.max(0, input.monthlyCostUsd) : 0;
  const before = Number.isFinite(input.costUsdUsedBefore)
    ? Math.max(0, input.costUsdUsedBefore)
    : 0;
  const overageAfter = Math.max(0, before + cost - allowance);
  const overageBefore = Math.max(0, before - allowance);
  // Algebraically already inside [0, cost]; clamped anyway because the two
  // overages are float subtractions of numbers that can be many orders of
  // magnitude apart, and a negative draw would ADD budget back to a grant.
  return Math.min(cost, Math.max(0, overageAfter - overageBefore));
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * A Clerk user id, which is what `tenants.id` IS - the primary key of every
 * tenant row, the KV cache key, and the value `/api/me` looks a row up by.
 *
 * Lives here rather than beside a route because two writers share it: the Stripe
 * webhook (a `client_reference_id` or a customer's `metadata.clerk_user_id`) and
 * `/api/provision` (an operator's curl). One pattern, so the two cannot drift
 * apart into a schema this table accepts on one path and refuses on the other.
 *
 * Bounded and character-restricted rather than modelled: Clerk documents ids as
 * opaque, so the job is to refuse prose, an email, markup and an empty string
 * before one becomes a primary key.
 */
const CLERK_USER_ID = /^user_[A-Za-z0-9_-]{1,120}$/;

/**
 * Whether `value` could be a Clerk user id, and therefore whether writing a
 * tenant row keyed by it can ever produce an account a user reaches.
 *
 * Apply it on WRITE paths only, never to an id read back out of `tenants`
 * (requirement 1, task 8.4). The asymmetry is deliberate and load-bearing:
 * `/api/provision` accepted any string for months, so a legacy hand-provisioned
 * row can carry an id this pattern rejects, and refusing to RESOLVE such a tenant
 * would turn a real payment into an unattached event for no benefit. Refusing to
 * CREATE one costs nothing and is the only moment the mistake is still cheap - a
 * typo becomes a row `/api/me` can never find, and nothing in the system ever
 * notices, because an orphan tenant looks exactly like a tenant who has not
 * signed in yet.
 *
 * `unknown` on purpose: both callers hold a value parsed out of a JSON body, so
 * the declared type is a claim rather than a fact.
 */
export function isClerkUserId(value: unknown): boolean {
  return typeof value === 'string' && CLERK_USER_ID.test(value);
}

/**
 * The organisation form of the same thing. Same bounds, same alphabet, same
 * reasoning about opacity - only the prefix differs.
 */
const CLERK_ORG_ID = /^org_[A-Za-z0-9_-]{1,120}$/;

/**
 * Whether `value` could be an Owner_Id: a Clerk USER id or a Clerk ORGANISATION
 * id (Requirement 1.9 of `.kiro/specs/multi-organisation-phorma/`).
 *
 * It inherits {@link isClerkUserId}'s asymmetry VERBATIM, and for the same
 * reason: **apply it on WRITE paths only, never to an id read back out of a row**
 * (Requirement 1.10). Rows written before an id was checked at all can carry a
 * value this rejects, and refusing to RESOLVE one would strand a real account for
 * no benefit.
 *
 * {@link isClerkUserId} stays exported and stays NARROWER, which is the load
 * bearing half of the pair. It remains the predicate for anything that genuinely
 * means a human, and in particular for the three Stripe-supplied id paths in
 * `stripe-webhook.ts`: an organisation is invoiced by Phorma Labs and `/api/checkout`
 * refuses an organisation owner outright, so an `org_` id can never legitimately
 * arrive from Stripe, and widening a classifier on a third-party-supplied input
 * would only broaden what an inbound value is allowed to claim.
 *
 * `unknown` on purpose, like its narrower twin: a caller holds a value parsed out
 * of a JSON body, so the declared type is a claim rather than a fact.
 */
export function isOwnerId(value: unknown): boolean {
  return typeof value === 'string' && (CLERK_USER_ID.test(value) || CLERK_ORG_ID.test(value));
}

/**
 * The NARROWEST of the three: an organisation id and nothing else.
 *
 * The third member of the same family, and it exists because the organisation
 * management routes (`org-admin.ts`) take an `orgId` and a `userId` as two
 * SEPARATE parameters of one write. {@link isOwnerId} accepts either shape, so
 * validating both fields with it would let a swapped pair through - a membership
 * row keyed `(user_x, org_y)` resolves for nobody, ever, and nothing logs a word
 * about it.
 *
 * Same asymmetry as its two siblings: WRITE paths only, never an id read back out
 * of a row.
 */
export function isOrgId(value: unknown): boolean {
  return typeof value === 'string' && CLERK_ORG_ID.test(value);
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface TenantRecord {
  id: string;
  email: string | null;
  tier: string;
  status: 'active' | 'past_due' | 'canceled';
  openrouterKeyId: string | null;
  openrouterKeyEnc: string | null;
  /**
   * Stripe Customer this tenant maps to (`cus_*`), or null while it is
   * unmapped. NULLABLE ON PURPOSE: a tenant is a real account long before it is
   * a paying one, every row that existed before `0003_billing.sql` reads NULL,
   * and a hand-provisioned tenant never gets one. Callers must treat the
   * absence as ordinary, not as a gap to backfill.
   */
  stripeCustomerId: string | null;
  /** Stripe Subscription (`sub_*`), null for the same reasons. */
  stripeSubscriptionId: string | null;
  /**
   * AUDIT ONLY: the `created` timestamp (epoch SECONDS, Stripe's own unit) of
   * the newest Stripe event that wrote anything to this tenant. 0 means no
   * billing event has ever been applied, which is why the column is
   * `NOT NULL DEFAULT 0` and this field is a plain `number` rather than
   * `number | null`.
   *
   * NOTHING MAY GATE ON THIS FIELD. It used to be the single ordering watermark
   * for every subscription-state write, and that is the defect
   * `0004_billing_ordering.sql` removes: the event families do not carry the
   * same information, so a restating event that advanced one scalar censored an
   * older event that would have supplied a tier. Ordering decisions belong to
   * the three per-field clocks below.
   *
   * `normalizeWatermark` keeps every clock a finite non-negative integer at BOTH
   * boundaries: on the way out through `normalizeTenant` (so a cache entry
   * written before a field existed still yields a number) and on the way in
   * through `upsertTenant` (so nothing the SQL `MAX` could mis-order ever
   * reaches a column in the first place).
   */
  billingEventAt: number;
  /**
   * Clock for `tier`: the `created` of the newest Stripe event that SUPPLIED a
   * tier - a `customer.subscription.created`/`.updated`, or the subscription
   * behind a subscription-mode `checkout.session.completed`. An invoice event and
   * a `customer.subscription.deleted` carry no price, so they never move it.
   */
  billingTierAt: number;
  /**
   * Clock for the SUBSCRIPTION-LIFECYCLE half of `status`: the `created` of the
   * newest `customer.subscription.*` event (or checkout subscription) applied.
   */
  billingStatusAt: number;
  /**
   * The DUNNING half of `status`: what the newest invoice event reported, or null
   * when no invoice has ever been applied to this tenant.
   *
   * Separate from `status` because the two facts are not comparable on one clock.
   * A cancellation must overrule an `invoice.paid` that carries a HIGHER
   * timestamp - a paid invoice for a subscription that is gone entitles nobody -
   * while still losing to a genuine later resubscription. See the fold in
   * {@link TenantStore.upsertTenant} and the long note in
   * `0004_billing_ordering.sql`.
   */
  billingDunningStatus: 'active' | 'past_due' | null;
  /** Clock for {@link billingDunningStatus}. */
  billingDunningAt: number;
}

/**
 * A tenant as a READ PATH may hand it over, before normalization: the three
 * billing fields are optional because the KV cache can still hold an entry
 * serialized by a worker version that predates them, and because a D1 driver
 * hands back `null` for a column, never `undefined`.
 *
 * This type exists so `normalizeTenant`'s coercions are provably load-bearing
 * rather than defensive noise a reader would be tempted to delete.
 */
type LooseTenantRecord = Omit<
  TenantRecord,
  | 'stripeCustomerId'
  | 'stripeSubscriptionId'
  | 'billingEventAt'
  | 'billingTierAt'
  | 'billingStatusAt'
  | 'billingDunningStatus'
  | 'billingDunningAt'
> & {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  billingEventAt?: number | null;
  billingTierAt?: number | null;
  billingStatusAt?: number | null;
  billingDunningStatus?: string | null;
  billingDunningAt?: number | null;
};

/**
 * The watermark's one invariant, enforced at BOTH boundaries that touch it: a
 * finite, non-negative integer. Anything else becomes 0, which is the column
 * default and the "no billing event applied yet" value, so a bad input fails
 * towards APPLYING a first event rather than towards ignoring a real one.
 *
 * The parameter is `unknown` on purpose. Both call sites have a declared type
 * (`number | null | undefined`), and at both of them that type is a CLAIM about
 * a value that arrived as JSON - a KV cache entry on the read side, a field cast
 * off a parsed Stripe event body on the write side. The column must not depend
 * on the claim holding, so the coercion is written against what can actually
 * turn up rather than against what the signature promises.
 *
 * Each rejected shape below is a verified failure, not a hypothetical:
 *
 *  - `undefined`  - a KV entry serialized before this field existed. `undefined
 *                   > n` is silently false, so the stale-event guard would apply
 *                   every event it should ignore, for the 60s of a cache TTL
 *                   after any deploy that adds a field.
 *  - non-finite   - D1 binds NaN and Infinity as NULL, and the column is
 *                   NOT NULL. Verified on local D1: the write RAISES, on the
 *                   `DO UPDATE` path as well as the insert, because SQLite
 *                   checks column constraints on the candidate row before the
 *                   uniqueness conflict that routes there. So an uncoerced NaN
 *                   loses the whole write - status included - not just the
 *                   watermark.
 *  - non-numeric  - the expensive one, because it is SILENT and PERMANENT.
 *    text           SQLite orders TEXT above every number, so
 *                   `MAX(1700000200, 'abc')` is `'abc'`: one such write parks a
 *                   string in the column, `MAX` then keeps preferring it, and NO
 *                   later legitimate event can ever advance the watermark again.
 *                   The read path coerces it back to 0, so the row looks merely
 *                   unmapped while the stale-event guard is dead for that tenant
 *                   forever. Verified end to end on local D1.
 *  - negative      - cannot corrupt `MAX` against a stored value, but would
 *                   store as-is on a first insert and sits below the documented
 *                   floor. Clamped so 0 is genuinely the minimum.
 *  - fractional    - compares correctly, but SQLite cannot narrow 1.5 to INTEGER
 *                   affinity losslessly and would keep the column REAL. Floored
 *                   so the column stays the integer its type says it is.
 *                   Stripe's `created` is epoch seconds and never fractional.
 */
function normalizeWatermark(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds);
}

/**
 * The dunning register's vocabulary, and the whole of it: what an invoice event
 * can report about a LIVE subscription.
 *
 * `canceled` is deliberately absent. A cancellation is a subscription-lifecycle
 * fact, never an invoice one, and letting it into this register would make the
 * fold in {@link TenantStore.upsertTenant} unable to tell the two apart - which is
 * exactly the collapse `0004_billing_ordering.sql` exists to undo. Anything else
 * becomes null, so a value that cannot be a dunning status is ignored rather than
 * stored and later folded into a real entitlement decision.
 */
function normalizeDunningStatus(value: unknown): 'active' | 'past_due' | null {
  return value === 'active' || value === 'past_due' ? value : null;
}

/**
 * The single place a `TenantRecord` is materialized, so D1 reads and KV cache
 * hits cannot diverge in shape.
 *
 * The watermark is the reason this function exists: it is compared numerically
 * by the webhook's stale-event guard, and a KV entry cached by the previous
 * worker version carries no `billingEventAt` at all, so the hazard is real for
 * one cache TTL after every deploy rather than theoretical. See
 * `normalizeWatermark` for the full list of shapes that reach it.
 */
function normalizeTenant(loose: LooseTenantRecord): TenantRecord {
  return {
    id: loose.id,
    email: loose.email,
    tier: loose.tier,
    status: loose.status,
    openrouterKeyId: loose.openrouterKeyId,
    openrouterKeyEnc: loose.openrouterKeyEnc,
    stripeCustomerId: loose.stripeCustomerId ?? null,
    stripeSubscriptionId: loose.stripeSubscriptionId ?? null,
    billingEventAt: normalizeWatermark(loose.billingEventAt),
    billingTierAt: normalizeWatermark(loose.billingTierAt),
    billingStatusAt: normalizeWatermark(loose.billingStatusAt),
    billingDunningStatus: normalizeDunningStatus(loose.billingDunningStatus),
    billingDunningAt: normalizeWatermark(loose.billingDunningAt),
  };
}

/**
 * The `stripe_events.status` vocabulary, and the whole of it.
 *
 *  - `applied`       - this worker finished processing the event. Includes a
 *                      deliberate no-op (an event type that touches nothing on
 *                      the tenant), because what the value records is that
 *                      processing COMPLETED, not that a column moved.
 *  - `ignored_stale` - the event's `created` was at or below the tenant's
 *                      `billing_event_at` watermark, so applying it would have
 *                      walked subscription state backwards (requirement 14).
 *  - `unresolved`    - authentic and understood, but it could not be attached to
 *                      a tenant. Recorded rather than dropped because a payment
 *                      that cannot find its account is money taken for nothing
 *                      (requirement 3).
 *
 * Deliberately NOT stored as a CHECK constraint - `0003_billing.sql` explains
 * why - so this type is the only enforcement, and every writer goes through
 * {@link TenantStore.recordStripeEvent}.
 */
export type StripeEventStatus = 'applied' | 'ignored_stale' | 'unresolved';

export interface QuotaSnapshot {
  month: string;
  runsUsed: number;
  costUsdUsed: number;
  limits: TierLimits;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Exported because `auth.ts` caches an `org_members` lookup behind the SAME KV
 * shape `getTenant` uses, and two copies of the number is how one of the two
 * caches quietly stops matching the other.
 */
export const TENANT_CACHE_TTL_S = 60;
// Cloudflare KV enforces a 60s minimum expirationTtl — anything lower is
// rejected with a 400 (which previously surfaced to the browser as a bare
// CORS failure, since the unhandled exception replaced our response before
// CORS headers were attached).
const QUOTA_CACHE_TTL_S = 60;

/** Data-access layer over D1 + KV for tenant state. */
export class TenantStore {
  constructor(private readonly env: TenantEnv) {}

  /** True when the hosted bindings are present. */
  get enabled(): boolean {
    return Boolean(this.env.DB);
  }

  private get db(): D1Database {
    if (!this.env.DB) throw new Error('Tenant store requires the DB (D1) binding.');
    return this.env.DB;
  }

  // ── Tenant rows ────────────────────────────────────────────────────────────

  /**
   * The ONLY read path that materializes a `TenantRecord`. `/api/me`, the
   * provisioning and deactivation endpoints, `resolveHostedInference` and the
   * Durable Object all come through here, so the column list below is the one
   * place a missing billing column would turn into a silent `undefined` with no
   * type error.
   *
   * {@link getTenantByStripeCustomer} is the only other query against `tenants`,
   * and it deliberately selects the ID ALONE and then comes back through here -
   * so there is still exactly one place a record is built, and one cache to keep
   * coherent.
   *
   * The three billing columns arrive with `0003_billing.sql`, so that migration
   * has to be applied BEFORE this code is deployed. It is additive, which is
   * what makes that ordering safe: the previously deployed worker keeps working
   * against the migrated schema.
   */
  async getTenant(id: string): Promise<TenantRecord | null> {
    const cacheKey = `tenant:${id}`;
    const cached = await this.env.TENANTS?.get(cacheKey, 'json');
    // Deliberately normalized rather than cast: an entry cached by the previous
    // worker version has no billing fields, and `as TenantRecord` would assert
    // otherwise.
    if (cached) return normalizeTenant(cached as LooseTenantRecord);

    const row = await this.db
      .prepare(
        `SELECT id, email, tier, status, openrouter_key_id, openrouter_key_enc,
                stripe_customer_id, stripe_subscription_id, billing_event_at,
                billing_tier_at, billing_status_at, billing_dunning_status,
                billing_dunning_at
         FROM tenants WHERE id = ?`,
      )
      .bind(id)
      .first<{
        id: string;
        email: string | null;
        tier: string;
        status: string;
        openrouter_key_id: string | null;
        openrouter_key_enc: string | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        // NOT NULL DEFAULT 0 in the schema, so SQLite always hands back a
        // number. Typed nullable anyway because `normalizeTenant` is what
        // guarantees the field a comparison site sees, and a type that lies
        // about the wire shape is how a NULL becomes a NaN.
        billing_event_at: number | null;
        billing_tier_at: number | null;
        billing_status_at: number | null;
        billing_dunning_status: string | null;
        billing_dunning_at: number | null;
      }>();
    if (!row) return null;

    const record = normalizeTenant({
      id: row.id,
      email: row.email,
      tier: row.tier,
      status: row.status as TenantRecord['status'],
      openrouterKeyId: row.openrouter_key_id,
      openrouterKeyEnc: row.openrouter_key_enc,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      billingEventAt: row.billing_event_at,
      billingTierAt: row.billing_tier_at,
      billingStatusAt: row.billing_status_at,
      billingDunningStatus: row.billing_dunning_status,
      billingDunningAt: row.billing_dunning_at,
    });
    await this.env.TENANTS?.put(cacheKey, JSON.stringify(record), {
      expirationTtl: TENANT_CACHE_TTL_S,
    });
    return record;
  }

  /**
   * Creates or updates one tenant. Every optional field follows the same rule:
   * OMITTING IT LEAVES THE STORED VALUE ALONE. A caller that knows one fact
   * about a tenant does not have to read the row first to avoid destroying the
   * rest of it, which is what a webhook handling `invoice.payment_failed` (it
   * knows only `status`) actually has.
   *
   * `tier` and `status` are the two exceptions and are REQUIRED: they are the
   * values the candidate row carries, so the type forces a caller to state them
   * rather than silently reset them - and a NULL bind on either would raise
   * anyway, since both columns are `NOT NULL` and SQLite checks the candidate row
   * before the conflict that routes to `DO UPDATE`.
   *
   * The `COALESCE(excluded.x, tenants.x)` idiom is the mechanism for everything
   * else, extended from the OpenRouter key columns to the Stripe identity
   * columns. `NULL` binds for an omitted field and `COALESCE` then keeps what is
   * stored, so a status-only write cannot wipe a runtime key or unmap a Stripe
   * customer. The cost of the idiom is that it cannot express "set this back to
   * NULL"; nothing needs to (unmapping a customer would orphan their payments),
   * and doing it would be an explicit statement, not an accidental omission.
   *
   * ## Two kinds of write, and the clocks that tell them apart
   *
   * An UNORDERED write states a fact that is true now: `/api/provision`,
   * `/api/deactivate`, the customer-mapping repair in `api.ts`. It supplies no
   * clock, and `tier` and `status` are then applied unconditionally - the
   * behaviour this method has always had.
   *
   * An ORDERED write replays a Stripe event that may arrive out of order, and
   * supplies the event's `created` alongside each field it actually KNOWS:
   * {@link tierAt} with the tier, {@link statusAt} with a subscription-lifecycle
   * status, {@link dunningAt} with an invoice status. Each field is then written
   * only when the event is newer than that FIELD's clock, which is what makes the
   * outcome independent of delivery order. `0004_billing_ordering.sql` carries the
   * full reasoning, including why one scalar watermark could not do this.
   *
   * A caller supplies EITHER `statusAt` OR `dunningAt`, never both: they are the
   * two halves of one folded value and no event is both a lifecycle change and an
   * invoice. If both ever arrive, the dunning half wins and the lifecycle clock
   * still advances, which is coherent but is not a shape any caller should build.
   */
  async upsertTenant(record: {
    id: string;
    email?: string | null;
    /**
     * The tier for the candidate row. Applied unconditionally UNLESS {@link tierAt}
     * says otherwise, so an unordered caller keeps today's behaviour and an
     * ordered caller that supplies no tier (an invoice, a cancellation) passes the
     * value it just read and gets a value-identical no-op.
     */
    tier: string;
    /**
     * The status for the candidate row, and for an unordered write the effective
     * status itself. An ordered write pairs it with {@link statusAt} (a lifecycle
     * status) or leaves it as the read-back value and pairs {@link dunningStatus}
     * with {@link dunningAt} instead.
     */
    status: string;
    openrouterKeyId?: string | null;
    openrouterKeyEnc?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    /**
     * Stripe event `created` (epoch seconds) for the AUDIT column
     * `billing_event_at`. Omit it for a write that is not driven by a Stripe
     * event: 0 binds, and the `MAX` in the SQL leaves the stored value untouched.
     *
     * This column no longer gates anything - see the field docs on
     * {@link TenantRecord.billingEventAt}. The ordering clocks are the three
     * below.
     *
     * Passed through `normalizeWatermark` before it is bound, so a caller that
     * hands over a non-finite or non-numeric value gets a no-op on this column
     * instead of a raise that discards the whole write or a string that kills
     * the column permanently. The type is not enough on its own: NaN is a
     * `number`, and the webhook's `created` reaches this field through a cast off
     * a parsed event body. Every clock below is coerced the same way, for the
     * same reason.
     */
    billingEventAt?: number | null;
    /**
     * The `created` of the event that SUPPLIED {@link tier}. Present means "apply
     * the tier only if this is newer than the stored tier clock"; absent or 0
     * means the tier is not event-ordered and applies unconditionally.
     */
    tierAt?: number | null;
    /**
     * The `created` of the `customer.subscription.*` event that supplied
     * {@link status}. Present means the status is a LIFECYCLE fact, ordered
     * against other lifecycle facts and folded against the dunning register.
     */
    statusAt?: number | null;
    /** What an invoice event reported: `active` or `past_due`, with {@link dunningAt}. */
    dunningStatus?: 'active' | 'past_due' | null;
    /** The `created` of the invoice event that supplied {@link dunningStatus}. */
    dunningAt?: number | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    // Bound once and reused below, because the SQL branches on whether each clock
    // is present and the TS side has to agree with it exactly.
    const dunningStatus = normalizeDunningStatus(record.dunningStatus);
    // A dunning clock without a usable value would leave the register claiming a
    // fact it cannot name, and the fold would then prefer a NULL over a real
    // lifecycle status. Bound to 0 instead, which routes the write to the
    // unordered branch - the same place an event with no usable `created` lands.
    const dunningAt = dunningStatus ? normalizeWatermark(record.dunningAt) : 0;
    await this.db
      .prepare(
        `INSERT INTO tenants (id, email, tier, status, openrouter_key_id, openrouter_key_enc,
                              stripe_customer_id, stripe_subscription_id, billing_event_at,
                              billing_tier_at, billing_status_at, billing_dunning_status,
                              billing_dunning_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = COALESCE(excluded.email, tenants.email),
           -- Applied unless an ORDERED write says this tier is older than the one
           -- already on record. An unordered write binds 0, which cannot be
           -- "older than" anything, so it still overwrites - and an ordered write
           -- that supplies no tier binds 0 too, together with the value it just
           -- read, so it writes the same string back.
           tier = CASE
             WHEN excluded.billing_tier_at > 0
                  AND excluded.billing_tier_at <= tenants.billing_tier_at
               THEN tenants.tier
             ELSE excluded.tier
           END,
           -- THE FOLD. The status column is the effective value every reader
           -- sees, derived from the two registers so that it cannot depend on
           -- delivery order. Migration 0004_billing_ordering.sql carries the full
           -- argument; the shape is:
           --
           --   an invoice fact wins when it is newer than the newest lifecycle
           --   fact, EXCEPT that a cancellation is never undone by an invoice.
           --
           -- Note what each branch reads. The dunning branch tests the effective
           -- status against 'canceled' rather than a stored lifecycle value: only
           -- a lifecycle event (or an operator) can produce 'canceled', so the
           -- effective column already answers "is this subscription gone". The
           -- lifecycle branch falls back on the excluded status when the dunning
           -- register is somehow clocked without a value, which a pre-0004 row can
           -- be for exactly one write.
           status = CASE
             -- An invoice event.
             WHEN excluded.billing_dunning_at > 0 THEN CASE
               WHEN excluded.billing_dunning_at <= tenants.billing_dunning_at THEN tenants.status
               WHEN tenants.status = 'canceled' THEN 'canceled'
               WHEN excluded.billing_dunning_at > tenants.billing_status_at
                 THEN excluded.billing_dunning_status
               -- Older than the newest lifecycle fact, so that fact still rules -
               -- and it IS the stored value, because the dunning register was
               -- older still.
               ELSE tenants.status
             END
             -- A subscription-lifecycle event.
             WHEN excluded.billing_status_at > 0 THEN CASE
               WHEN excluded.billing_status_at <= tenants.billing_status_at THEN tenants.status
               WHEN excluded.status = 'canceled' THEN 'canceled'
               WHEN tenants.billing_dunning_at > excluded.billing_status_at
                 THEN COALESCE(tenants.billing_dunning_status, excluded.status)
               ELSE excluded.status
             END
             -- An unordered write: an operator, or an event with no usable
             -- created timestamp. Applied as stated, which is what this method has
             -- always done.
             ELSE excluded.status
           END,
           openrouter_key_id = COALESCE(excluded.openrouter_key_id, tenants.openrouter_key_id),
           openrouter_key_enc = COALESCE(excluded.openrouter_key_enc, tenants.openrouter_key_enc),
           stripe_customer_id = COALESCE(excluded.stripe_customer_id, tenants.stripe_customer_id),
           stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, tenants.stripe_subscription_id),
           -- Every clock is a monotone maximum. NOT a COALESCE, deliberately: a
           -- clock has to hold against a LOWER value as well as an absent one,
           -- since COALESCE would keep 0 out but happily move 1700000200 back to
           -- 1700000100, which is precisely the out-of-order delivery these
           -- columns exist to survive. MAX covers both cases with one rule,
           -- because 0 is the floor: an omitted clock binds 0 and MAX(stored, 0)
           -- is stored. Scalar max(X,Y), not the aggregate.
           --
           -- Monotone is also what makes each register a last-writer-wins value
           -- over the whole event set rather than over the delivery order, so two
           -- concurrent deliveries of different events converge without a
           -- transaction - the reason the fold above is evaluated HERE and not
           -- across a read and a later write.
           billing_event_at = MAX(tenants.billing_event_at, excluded.billing_event_at),
           billing_tier_at = MAX(tenants.billing_tier_at, excluded.billing_tier_at),
           billing_status_at = MAX(tenants.billing_status_at, excluded.billing_status_at),
           billing_dunning_at = MAX(tenants.billing_dunning_at, excluded.billing_dunning_at),
           billing_dunning_status = CASE
             WHEN excluded.billing_dunning_at > tenants.billing_dunning_at
               THEN excluded.billing_dunning_status
             ELSE tenants.billing_dunning_status
           END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.email ?? null,
        record.tier,
        record.status,
        record.openrouterKeyId ?? null,
        record.openrouterKeyEnc ?? null,
        record.stripeCustomerId ?? null,
        record.stripeSubscriptionId ?? null,
        // A finite non-negative integer, never null and never anything `MAX`
        // could mis-order. The columns are NOT NULL, and SQLite checks column
        // constraints on the candidate row BEFORE the uniqueness conflict that
        // routes to DO UPDATE, so a null (or a NaN, which D1 binds as null)
        // raises on the update path too rather than quietly falling through to
        // the MAX. `normalizeWatermark` carries the rest of the reasoning.
        normalizeWatermark(record.billingEventAt),
        normalizeWatermark(record.tierAt),
        normalizeWatermark(record.statusAt),
        dunningStatus,
        dunningAt,
        now,
        now,
      )
      .run();
    await this.env.TENANTS?.delete(`tenant:${record.id}`);
  }

  /**
   * The tenant a Stripe Customer maps to, or null when none does - the THIRD and
   * last of the webhook's tenant resolution paths (requirement 3).
   *
   * Two queries rather than one, on purpose. This one reads the ID ALONE and
   * {@link getTenant} materializes the record, so the column list, the
   * normalization and the KV cache all stay in exactly one place: a second
   * hand-rolled `SELECT` of every column is how a new field ends up present on
   * one read path and `undefined` on the other.
   *
   * The lookup rides the PARTIAL unique index `idx_tenants_stripe_customer`
   * (`0003_billing.sql`). Verified with EXPLAIN QUERY PLAN on 2026-09-02:
   * `SEARCH tenants USING INDEX idx_tenants_stripe_customer
   * (stripe_customer_id=?)`. A partial index is usable here because `= ?`
   * implies `IS NOT NULL`, which is the index's own predicate - so the
   * documentation-value form of that index costs nothing at read time. The same
   * index is what makes "exactly one tenant" true rather than hoped for: a
   * second row claiming the same customer fails at WRITE time, so this read can
   * never have to pick a winner.
   *
   * A blank or non-matching id is refused before the query, because
   * `stripe_customer_id = ''` would scan for a value the column never holds.
   */
  async getTenantByStripeCustomer(stripeCustomerId: string): Promise<TenantRecord | null> {
    if (!stripeCustomerId) return null;
    const row = await this.db
      .prepare('SELECT id FROM tenants WHERE stripe_customer_id = ?')
      .bind(stripeCustomerId)
      .first<{ id: string }>();
    return row ? this.getTenant(row.id) : null;
  }

  // ── Stripe webhook bookkeeping ─────────────────────────────────────────────

  /**
   * The status already recorded against a Stripe event id, or null when this
   * worker has never seen it.
   *
   * The CHEAP half of the webhook's idempotency (requirement 13): Stripe
   * delivers at least once and retries every non-2xx, so a redelivery is
   * routine, and answering it with one indexed primary-key read beats
   * re-applying the event and re-hitting Stripe for the objects it references.
   *
   * It is NOT the authoritative half. Two simultaneous deliveries of the same
   * event both pass this check, and the `INSERT OR IGNORE` in
   * {@link recordStripeEvent} is what settles that race. See the ordering note
   * on the webhook handler for why applying twice is safe.
   */
  async stripeEventStatus(eventId: string): Promise<StripeEventStatus | null> {
    if (!eventId) return null;
    const row = await this.db
      .prepare('SELECT status FROM stripe_events WHERE id = ?')
      .bind(eventId)
      .first<{ status: string }>();
    // Cast rather than validated: the only writer of this column is
    // `recordStripeEvent` below, and a value from outside that vocabulary is an
    // operator's hand-run UPDATE, which the webhook treats the same way either
    // way - as "already handled, do not repeat".
    return (row?.status as StripeEventStatus | undefined) ?? null;
  }

  /**
   * Records one handled Stripe event. Returns whether the row actually landed.
   *
   * `INSERT OR IGNORE` on the primary key is the AUTHORITATIVE idempotency gate
   * (requirement 13), the same discipline `recordRun` uses over
   * `usage(tenant_id, run_id)`. `false` means the id was already present, which
   * in practice means a concurrent delivery of the same event won the race.
   *
   * `status` carries the migration's three-value vocabulary and nothing else:
   * `applied`, `ignored_stale`, `unresolved`. There is no transient fourth value
   * because the row is written AFTER the work, never as a claim beforehand - a
   * claim would need a status that means "in flight", and a crash would then park
   * that word in the table forever and make Stripe's retry skip a payment.
   *
   * `tenantId` is nullable because an `unresolved` event may have no identity at
   * all to point at (`0003_billing.sql` explains why the row exists anyway).
   */
  async recordStripeEvent(entry: {
    id: string;
    type: string;
    tenantId: string | null;
    status: StripeEventStatus;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_events (id, type, tenant_id, received_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(entry.id, entry.type, entry.tenantId ?? null, new Date().toISOString(), entry.status)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Writes one top-up credit grant. Returns whether it was NEW.
   *
   * Idempotent on `stripe_payment_id` (requirement 21), which is `NOT NULL
   * UNIQUE`, so `false` means "this payment was already granted" and the caller
   * must not treat it as a failure. Keyed on the PAYMENT rather than the event
   * because one payment surfaces in several events - see the long note in
   * `0003_billing.sql`.
   *
   * `credits` is rounded here because the column is INTEGER and D1 would
   * otherwise store a REAL in it. The caller already resolves whole credits from
   * `metadata.credits`, so this is the boundary being defensive about the type
   * its column claims, in the same spirit as `normalizeWatermark`.
   *
   * Nothing is validated beyond that: a non-positive grant is refused UPSTREAM,
   * by the catalogue (`topUpForPrice`), because refusing here would mean throwing
   * inside a webhook and asking Stripe to retry something that can never
   * succeed.
   */
  async recordCreditGrant(grant: {
    tenantId: string;
    stripePaymentId: string;
    credits: number;
    costUsd: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO credit_grants
           (tenant_id, stripe_payment_id, credits, cost_usd, cost_usd_consumed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        grant.tenantId,
        grant.stripePaymentId,
        Math.round(grant.credits),
        grant.costUsd,
        new Date().toISOString(),
      )
      .run();
    return result.meta.changes === 1;
  }

  /**
   * The tenant's unspent grant pool, in both units (requirement 22).
   *
   * NOT KV-CACHED, deliberately, and it does not need to be, because neither
   * caller puts it on the hot path:
   *
   *  - `resolveHostedInference` reads it ONLY after `quotas.cost_usd_used` has
   *    already passed the tier allowance. Below the allowance the pool cannot
   *    change the decision (requirement 24 spends the allowance first), so the
   *    common request does zero grant reads.
   *  - `/api/me` reads it once per profile poll.
   *
   * A cache here would buy nothing and cost the thing that matters most about a
   * top-up: that it works the instant it is bought. A 60s stale pool would let a
   * tenant who just paid keep reading "credits exhausted", which is the same dead
   * end this whole spec exists to remove.
   *
   * The SUM is order-independent, so unlike the FIFO draw this read makes no use
   * of `ORDER BY id`. Both clamps are the ones `0003_billing.sql` assigns to this
   * task in place of a CHECK constraint: `MAX(0, ...)` per grant so one drifted or
   * overdrawn row cannot subtract from a healthy one, and `cost_usd > 0` guarding
   * the credits ratio so a zero-budget grant cannot divide by zero (the catalogue
   * refuses to sell one, which is why this is a guard and not a code path).
   *
   * `COALESCE` because `SUM` over no rows is NULL, not 0 - a tenant with no
   * grants is the ordinary case, not an edge one.
   */
  async grantPool(tenantId: string): Promise<GrantPool> {
    if (!tenantId) return EMPTY_GRANT_POOL;
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(MAX(0, cost_usd - cost_usd_consumed)), 0) AS remaining_usd,
           COALESCE(SUM(CASE WHEN cost_usd > 0
             THEN credits * MAX(0, cost_usd - cost_usd_consumed) / cost_usd
             ELSE 0 END), 0) AS remaining_credits
         FROM credit_grants WHERE tenant_id = ?`,
      )
      .bind(tenantId)
      .first<{ remaining_usd: number; remaining_credits: number }>();
    const costUsdRemaining = Number(row?.remaining_usd ?? 0);
    const creditsRemaining = Number(row?.remaining_credits ?? 0);
    return {
      // Coerced at the boundary for the same reason the watermark is: these are
      // REAL columns summed by SQLite, and a NaN reaching the gate would make
      // every comparison against the ceiling false, which fails OPEN on money.
      costUsdRemaining: Number.isFinite(costUsdRemaining) ? Math.max(0, costUsdRemaining) : 0,
      // Rounded because credits are a displayed count, matching
      // `creditsForTier`'s output, and because the ratio above is float division.
      creditsRemaining: Number.isFinite(creditsRemaining)
        ? Math.max(0, Math.round(creditsRemaining))
        : 0,
    };
  }

  /**
   * Draws `amountUsd` from the tenant's open grants, oldest first, and returns
   * what was actually drawn.
   *
   * Private because the ORDERING with `quotas` is what makes it correct:
   * requirement 24 says the allowance is spent first, and the only place that
   * ordering is known is inside {@link recordRun}, after the rollup write has
   * reported where this run left the month. A caller reaching for this directly
   * would be drawing on grants without knowing whether the allowance was gone.
   *
   * FIFO by `id`, NEVER by `created_at`. `0003_billing.sql` records the reason:
   * `created_at` is an ISO string the webhook writes, two grants written in one
   * webhook pass share it to the millisecond, and a tie makes the order
   * arbitrary. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so it is monotonic
   * and never reused. Ids are NOT gapless (an ignored `INSERT OR IGNORE` still
   * consumes one), so this depends on the order alone and never on contiguity.
   *
   * The write clamps with `MIN(cost_usd, cost_usd_consumed + ?)` against the
   * STORED value rather than the one just read, which is what bounds a
   * concurrent draw: two settles racing on the same grant can each add their
   * share, but neither can push the row past its own ceiling. The cost of that
   * race is a pack draining slightly faster than it should, never a grant
   * consumed beyond what was paid for.
   *
   * A draw larger than every open grant leaves the surplus undrawn and returns
   * less than it was asked for. That is correct rather than an error: the money is
   * already spent, `usage` and `quotas` have recorded it, and there is nothing
   * left in the ledger to charge it to. The caller does not treat the shortfall as
   * a failure - `recordRun` is called from a settle finally-block, where raising
   * costs the billing record too.
   */
  private async drawFromGrants(tenantId: string, amountUsd: number): Promise<number> {
    if (!(amountUsd > 0)) return 0;
    const open = await this.db
      .prepare(
        `SELECT id, cost_usd, cost_usd_consumed FROM credit_grants
         WHERE tenant_id = ? AND cost_usd_consumed < cost_usd
         ORDER BY id`,
      )
      .bind(tenantId)
      .all<{ id: number; cost_usd: number; cost_usd_consumed: number }>();

    let remaining = amountUsd;
    const writes: D1PreparedStatement[] = [];
    for (const grant of open.results ?? []) {
      if (remaining <= 0) break;
      const available = Math.max(0, Number(grant.cost_usd) - Number(grant.cost_usd_consumed));
      if (!(available > 0)) continue;
      const take = Math.min(available, remaining);
      writes.push(
        this.db
          .prepare(
            `UPDATE credit_grants
             SET cost_usd_consumed = MIN(cost_usd, cost_usd_consumed + ?)
             WHERE id = ?`,
          )
          .bind(take, grant.id),
      );
      remaining -= take;
    }
    // One batch, because D1 runs a batch as a single atomic transaction: a draw
    // that spans two grants must not be able to land half of itself.
    if (writes.length) await this.db.batch(writes);
    return amountUsd - Math.max(0, remaining);
  }

  // ── Quotas + usage ledger ──────────────────────────────────────────────────

  async getQuota(tenantId: string, tier: string): Promise<QuotaSnapshot> {
    const month = currentMonth();
    const cacheKey = `quota:${tenantId}:${month}`;
    const limits = tierLimits(tier);

    const cached = await this.env.TENANTS?.get(cacheKey, 'json');
    if (cached) {
      const { runsUsed, costUsdUsed } = cached as { runsUsed: number; costUsdUsed: number };
      return { month, runsUsed, costUsdUsed, limits };
    }

    const row = await this.db
      .prepare('SELECT runs_used, cost_usd_used FROM quotas WHERE tenant_id = ? AND month = ?')
      .bind(tenantId, month)
      .first<{ runs_used: number; cost_usd_used: number }>();
    const snapshot = {
      month,
      runsUsed: row?.runs_used ?? 0,
      costUsdUsed: row?.cost_usd_used ?? 0,
      limits,
    };
    await this.env.TENANTS?.put(
      cacheKey,
      JSON.stringify({ runsUsed: snapshot.runsUsed, costUsdUsed: snapshot.costUsdUsed }),
      { expirationTtl: QUOTA_CACHE_TTL_S },
    );
    return snapshot;
  }

  /**
   * Records one settled run: ledger row + rollup bump + grant draw + cache bust.
   *
   * Idempotent on `run_id`: the `usage` insert uses `INSERT OR IGNORE` against
   * the UNIQUE(tenant_id, run_id) index, and the quota rollup, the grant draw and
   * the cache bust all hang off whether that ledger row actually landed
   * (meta.changes === 1). A retried settle (or any path that calls recordRun twice
   * for the same run) is therefore a no-op instead of a double charge.
   *
   * That index is what makes the claim true rather than aspirational: it did not
   * exist until `0003_billing.sql` added `idx_usage_tenant_run`, so before this
   * migration the insert had nothing to conflict on and `meta.changes` was always
   * 1. The grant draw below is gated on the SAME signal deliberately - a second
   * gate, computed from anything else, is how a retried settle would draw twice
   * from a pack the tenant paid for once (requirement 21's discipline applied to
   * consumption rather than to granting).
   */
  async recordRun(entry: {
    tenantId: string;
    runId: string;
    workflowId: string;
    costUsd: number;
    /**
     * The tenant's tier, which is what decides the monthly USD allowance this
     * run's cost is measured against (requirement 24).
     *
     * REQUIRED rather than resolved in here, and that is a forcing function: both
     * callers already hold the tenant (the DO from its gate, `/api/infer` from
     * `resolveHostedInference`), so reading the row again would be a second read
     * for a value the caller has, and making it optional would let a future
     * caller omit it and silently get starter's allowance - which for a Team
     * tenant would start drawing on grants at $4 instead of $44, burning packs
     * they never needed to touch.
     */
    tier: string;
    tokensIn: number;
    tokensOut: number;
    durationMs?: number;
    /**
     * Whether this bumps the monthly `runs_used` count. True for a deployed
     * workflow execution (the "runs" quota is a per-workflow-run concept).
     * FALSE for local-run `/api/infer` inference calls — those consume
     * credits (cost) but must NOT inflate the run count, otherwise every
     * agent node × tool-call round in a local debug run would each count as a
     * "run". Defaults to true. Cost is always metered regardless.
     */
    countsAsRun?: boolean;
  }): Promise<void> {
    const month = currentMonth();
    const now = new Date().toISOString();
    const runIncrement = entry.countsAsRun === false ? 0 : 1;

    // Ledger first: INSERT OR IGNORE against UNIQUE(tenant_id, run_id). Only
    // when the row actually lands (a fresh run_id) do we bump the rollup and
    // bust the cache — a duplicate run_id is a settle retry and must be a
    // no-op rather than a second charge.
    const ledger = await this.db
      .prepare(
        `INSERT OR IGNORE INTO usage (tenant_id, run_id, workflow_id, month, cost_usd, tokens_in, tokens_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.tenantId,
        entry.runId,
        entry.workflowId,
        month,
        entry.costUsd,
        entry.tokensIn,
        entry.tokensOut,
        entry.durationMs ?? null,
        now,
      )
      .run();

    if (!ledger.meta.changes) return; // duplicate run_id — already recorded

    // `RETURNING` rather than a SELECT before the write: the grant draw needs the
    // rollup value as it stood BEFORE this run, and reading it in a separate
    // statement would leave a window in which another settle for the same tenant
    // lands between the read and the bump. Both settles would then compute the
    // same before-value, and the run that should have straddled the allowance
    // boundary would draw from grants twice or not at all. Taking the AFTER value
    // out of the write itself and subtracting this run's cost cannot race: the
    // arithmetic is the one SQLite performed.
    const rollup = await this.db
      .prepare(
        `INSERT INTO quotas (tenant_id, month, runs_used, cost_usd_used)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, month) DO UPDATE SET
           runs_used = quotas.runs_used + excluded.runs_used,
           cost_usd_used = quotas.cost_usd_used + excluded.cost_usd_used
         RETURNING cost_usd_used`,
      )
      .bind(entry.tenantId, month, runIncrement, entry.costUsd)
      .first<{ cost_usd_used: number }>();

    // Requirement 24: the monthly allowance is spent first, and only the part of
    // this run that lands PAST it is drawn from purchased grants. A tenant who
    // never exceeds their plan therefore keeps a pack indefinitely, which is what
    // the pricing page means by calling it a balance.
    //
    // Best-effort in the same sense as the rest of this method, which the settle
    // path calls from a finally-block: `usage` and `quotas` already hold the
    // truth about what was spent, so a grant write that fails leaves the tenant
    // with MORE budget than they should have rather than a lost billing record.
    // Raising here would trade a cent for the audit trail.
    const costUsdUsedAfter = Number(rollup?.cost_usd_used ?? 0);
    const draw = grantDrawUsd({
      costUsd: entry.costUsd,
      costUsdUsedBefore: costUsdUsedAfter - entry.costUsd,
      monthlyCostUsd: tierLimits(entry.tier).monthlyCostUsd,
    });
    if (draw > 0) await this.drawFromGrants(entry.tenantId, draw);

    await this.env.TENANTS?.delete(`quota:${entry.tenantId}:${month}`);
  }

  // ── Runtime key resolution ─────────────────────────────────────────────────

  /** Decrypts a tenant's OpenRouter runtime key (null when not provisioned). */
  async runtimeKey(tenant: TenantRecord): Promise<string | null> {
    if (!tenant.openrouterKeyEnc || !this.env.KEY_ENC_SECRET) return null;
    try {
      return await decryptString(tenant.openrouterKeyEnc, this.env.KEY_ENC_SECRET);
    } catch {
      return null;
    }
  }

  /**
   * Stores a freshly minted runtime key against an EXISTING tenant, as one write
   * of BOTH columns. Returns whether a row was updated.
   *
   * A plain `UPDATE`, deliberately not `upsertTenant`, for two reasons that are
   * both about what this write must NOT touch:
   *
   *  - `upsertTenant` requires `tier` and `status` and applies them
   *    unconditionally on an unordered write. A key rotation knows nothing new
   *    about either, so it would have to restate values it just read - and inside
   *    the Stripe webhook that is exactly how a stale event's tier gets written
   *    back over a newer one, bypassing the per-field clocks the ordering guard is
   *    made of.
   *  - the two key columns must move TOGETHER. `openrouter_key_id` is the handle
   *    that disables or re-limits the key and `openrouter_key_enc` is the key
   *    itself, so a half-write leaves either an unmanageable live key or a stored
   *    ciphertext for a key we can no longer control. One statement, both columns.
   *
   * No `INSERT` fallback: minting for a tenant with no row would create one with
   * no tier and no status, and both columns are `NOT NULL`. Every caller writes
   * the row first (`/api/provision`) or is reconciling a row it just read, so a
   * `false` return means the tenant vanished mid-flight and is worth logging.
   */
  async setRuntimeKey(id: string, keyId: string | null, keyEnc: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tenants
            SET openrouter_key_id = ?, openrouter_key_enc = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(keyId, keyEnc, new Date().toISOString(), id)
      .run();
    await this.env.TENANTS?.delete(`tenant:${id}`);
    return (result.meta?.changes ?? 0) > 0;
  }
}

// ── Hosted inference mapping (shared by the DO + the /api/infer proxy) ───────

/**
 * Maps a node's declared provider to the OpenRouter model-slug prefix. Hosted
 * inference is OpenRouter-only: whatever provider a node declares is rewritten
 * to the equivalent OpenRouter slug and billed against the tenant's runtime
 * key. `null` means the provider has no hosted equivalent (rejected).
 *
 * `phorma-cloud` nodes already store a full OpenRouter slug as their model id
 * (the curated big-name set), so they map with an empty prefix.
 */
export const OPENROUTER_SLUG_PREFIX: Record<string, string | null> = {
  anthropic: 'anthropic/',
  openai: 'openai/',
  gemini: 'google/',
  openrouter: '', // already a full slug
  'phorma-cloud': '', // already a full OpenRouter slug (curated)
  bedrock: null, // BYO-key only — hosted (OpenRouter) inference has no Bedrock path
  ollama: null, // no hosted equivalent — rejected in hosted mode
  lmstudio: null, // local server — no hosted equivalent
};

/**
 * Rewrites a provider/model pair to its OpenRouter equivalent. Returns the
 * mapped `{ provider: 'openrouter', model }` or an error string when the
 * provider can't be hosted (Ollama/Bedrock).
 */
export function toOpenRouterModel(
  provider: string,
  model: string,
): { provider: 'openrouter'; model: string } | string {
  const prefix = OPENROUTER_SLUG_PREFIX[provider];
  if (prefix === null) {
    return `Provider "${provider}" is not available on Phorma Cloud. Pick a cloud model.`;
  }
  return { provider: 'openrouter', model: provider === 'openrouter' || provider === 'phorma-cloud' ? model : `${prefix}${model}` };
}

/**
 * Why hosted inference was refused, as a STABLE MACHINE TOKEN (requirement 19).
 *
 * THIS UNION IS A WIRE CONTRACT, not an implementation detail. The studio
 * branches on it to decide which call to action a failure earns - Subscribe, or
 * update your card, or buy credits - and the whole point of it existing is that
 * REWORDING A MESSAGE CAN NEVER AGAIN REMOVE A CTA. So the tokens are
 * append-only: add a value, never rename or repurpose one, and keep them
 * snake_case because that is what the consumers already match on.
 *
 * The prose beside each code stays matchable too (requirement 20). A deployed
 * worker may predate this field, so consumers branch on the code FIRST and fall
 * back to the existing regex; changing "credits exhausted" out of the
 * `credits_exhausted` message would break that fallback for anyone on an older
 * worker even though the code is correct.
 *
 *  - `no_subscription`       - no tenant row, or a `canceled` one. Remedy: buy a
 *                              plan.
 *  - `subscription_past_due` - a real subscription whose last invoice failed.
 *                              Remedy: update the card. DISTINCT from the above
 *                              on purpose (requirement 17): the two are one
 *                              button apart and sending a lapsed payer to a
 *                              Subscribe CTA asks them to buy what they already
 *                              own.
 *  - `runs_exhausted`        - the tier's monthly run count is gone. 429.
 *  - `credits_exhausted`     - the monthly allowance AND every purchased grant
 *                              are gone.
 *  - `no_runtime_key`        - entitled, but no OpenRouter key is provisioned.
 *                              An internal fault, not a billing state.
 *  - `impersonation_read_only` - the request is being served as another owner
 *                              through the operator act-as header, so it spends
 *                              nothing (multi-organisation-phorma Requirement 14.6).
 *                              NOT a billing state either: the tenant is entitled
 *                              and the CALLER is not allowed to spend on their
 *                              behalf. The third and last of the three independent
 *                              places that refusal is answered - see
 *                              `impersonation.ts`.
 *
 *  - `workflow_not_entitled` - RESERVED, and never returned in this release
 *                              (multi-organisation-phorma Requirement 15.4). It is
 *                              the token per-workflow pricing will refuse with once
 *                              there is a policy to refuse on, declared NOW so that
 *                              policy is a change inside {@link
 *                              resolveHostedInference} rather than a change to a
 *                              wire contract a studio three versions old is already
 *                              branching on. Nothing under `cloud/src/` may mention
 *                              it apart from this comment and the union member
 *                              below, and `cloud/test/entitlement.test.mjs` greps
 *                              for exactly that - so wiring it up without also
 *                              wiring up the policy fails a test.
 *
 * The sixth is the one token in this set with NO entry in the studio's
 * `HOSTED_REFUSAL_REMEDIES` map (`frontend/src/app/core/billing-refusal.ts`), and
 * that is correct rather than a gap: the studio offers no impersonation surface and
 * never sends an act-as header, so it can never receive this code - and an
 * unrecognised code already renders the served prose. `billing-refusal.spec.ts`
 * asserts that map holds no key the worker does not send, so adding one there fails
 * a test rather than drifting. The SEVENTH has no entry there for the stronger
 * reason that nothing sends it at all; an unrecognised code renders the served
 * prose and offers nothing, which is Property 34 and is what makes appending a
 * token safe.
 */
export type HostedInferenceRefusalCode =
  | 'no_subscription'
  | 'subscription_past_due'
  | 'runs_exhausted'
  | 'credits_exhausted'
  | 'no_runtime_key'
  | 'impersonation_read_only'
  | 'workflow_not_entitled';

/**
 * A refusal a caller can return verbatim.
 *
 * `status` and `error` keep their exact previous meaning, so `'status' in result`
 * is still the discriminator every control-plane route uses and this shape is
 * still assignable wherever `StripeRefusal` (`stripe.ts`) is expected. `code` is
 * ADDITIVE: nothing that ignores it changes behaviour.
 */
export interface HostedInferenceRefusal {
  status: number;
  error: string;
  code: HostedInferenceRefusalCode;
}

/**
 * Pre-flight entitlement gate for a hosted inference call - the ONE
 * implementation, shared by the `/api/infer` proxy (local runs) and
 * `WorkflowAgent.trigger()` (deployed runs), so the two cannot drift. They were
 * two copies of these checks until tasks 6.1-6.3, and the copies are what would
 * have made a top-up raise the ceiling for one kind of run and not the other.
 *
 * Returns the decrypted OpenRouter runtime key plus the tenant record it was
 * resolved from (the DO needs the record for its tier), or a
 * {@link HostedInferenceRefusal} the caller returns directly.
 *
 * Check ORDER is deliberate: identity, then entitlement, then quota, then
 * provisioning. Each refusal names the FIRST thing the user can act on, so a
 * `past_due` tenant is told to update their card rather than told they are out
 * of credits they cannot spend anyway.
 *
 * `options.impersonated` is checked BEFORE all of that, and before any read
 * (multi-organisation-phorma Requirement 14.6). It is a property of the CALLER
 * rather than of the tenant, so a tenant state that would otherwise be entitled is
 * refused just the same - and it costs nothing, because an ordinary request omits
 * the bag entirely. This is the THIRD independent layer of the read-only rule: the
 * gateway and the Role_Gate both refuse an impersonated write before it can reach a
 * run, and this is what makes "an impersonated request spends no credits" true even
 * if neither of them did.
 *
 * `options.workflowId` is the WHOLE of the per-workflow pricing preparation
 * (multi-organisation-phorma Requirements 15.1, 15.6). It is read by nothing in
 * this release, deliberately: there is no workflow catalogue, no per-workflow meter
 * and no entitlement table, and there must not be one here. What it buys is that
 * both call sites already NAME the workflow a spend belongs to, so pricing later is
 * a policy change inside this function rather than a signature change across two
 * call sites plus the `POST /api/infer` body. `/api/infer` passes it when the
 * request carries one and `WorkflowAgent.trigger` passes the deployed spec's id
 * (Requirements 15.2, 15.3). Absent is a legitimate answer, not a defect: an
 * assistant or Ctrl+P builder call belongs to no workflow at all, so a future
 * policy has to decide what an unnamed spend costs rather than assume the field is
 * always there.
 *
 * One optional options bag, so every existing call site keeps compiling.
 */
export async function resolveHostedInference(
  store: TenantStore,
  tenantId: string,
  options?: { workflowId?: string; impersonated?: boolean },
): Promise<{ key: string; tenant: TenantRecord } | HostedInferenceRefusal> {
  if (options?.impersonated === true) {
    return {
      status: 403,
      code: 'impersonation_read_only',
      error: 'An impersonated session is read-only, so it cannot run hosted inference.',
    };
  }
  const tenant = await store.getTenant(tenantId);
  if (!tenant) {
    return {
      status: 402,
      code: 'no_subscription',
      error: 'No active Phorma Cloud subscription. Visit Settings → Cloud to subscribe.',
    };
  }
  // Requirement 17. Split out BEFORE the generic refusal, and note what the
  // tenant keeps while it is refused: requirement 18 has the row hold its tier,
  // its data and its runtime key, so paying the outstanding invoice restores
  // service with no rebuild. Nothing here deprovisions anything.
  if (tenant.status === 'past_due') {
    return {
      status: 402,
      code: 'subscription_past_due',
      error:
        'Your last Phorma Cloud payment failed. Update your card in Settings → Cloud to resume hosted runs.',
    };
  }
  if (tenant.status !== 'active') {
    return {
      status: 402,
      code: 'no_subscription',
      error: 'No active Phorma Cloud subscription. Visit Settings → Cloud to subscribe.',
    };
  }
  const quota = await store.getQuota(tenant.id, tenant.tier);
  if (quota.runsUsed >= quota.limits.monthlyRuns) {
    return {
      status: 429,
      code: 'runs_exhausted',
      error: `Monthly run limit reached (${quota.limits.monthlyRuns}). Resets next month or upgrade your plan.`,
    };
  }
  // Requirement 22: grants RAISE the ceiling. The pool is read only once the
  // monthly allowance is already gone, which is not an optimization but the
  // consequence of requirement 24 - below the allowance a grant cannot change
  // the answer, so the ordinary request costs zero grant reads.
  if (quota.costUsdUsed >= quota.limits.monthlyCostUsd) {
    const pool = await store.grantPool(tenant.id);
    if (quota.costUsdUsed >= effectiveCostUsdLimit(quota.limits, pool)) {
      return {
        status: 402,
        code: 'credits_exhausted',
        // "credits exhausted" is load-bearing prose, not a phrasing choice: it is
        // the regex an older studio matches to raise the Buy credits action
        // (requirement 20). Reword the sentence around it, never that phrase.
        error: 'Monthly credits exhausted. Resets next month or upgrade your plan.',
      };
    }
  }
  const key = await store.runtimeKey(tenant);
  if (!key) {
    return {
      status: 402,
      code: 'no_runtime_key',
      error: 'Your Phorma Cloud account has no runtime key yet. Contact support.',
    };
  }
  return { key, tenant };
}

// ── OpenRouter key provisioning ──────────────────────────────────────────────

const OPENROUTER_KEYS_API = 'https://openrouter.ai/api/v1/keys';

/**
 * The name every per-tenant runtime key carries, and the ONLY link back to a
 * tenant that survives on the OpenRouter side.
 *
 * Deterministic on purpose, and load-bearing twice over. The key hash is stored
 * in `tenants.openrouter_key_id`, but the PLAINTEXT key is returned exactly once
 * at mint, so a key that was minted and then not stored is unrecoverable and
 * invisible except by this name. The workspace migration uses it to find such
 * orphans and retire them, which is what makes a re-run safe
 * (`scripts/migrate-openrouter-workspace.mjs`), and `provisioning.test.mjs`
 * asserts the exact string. Changing it strands every key already minted.
 */
export function runtimeKeyName(tenantId: string): string {
  return `phorma-tenant-${tenantId}`;
}

/**
 * Mints a per-tenant OpenRouter runtime key with a hard credit limit.
 * Requires the provisioning (management) key. Returns the key + its hash
 * (used later to disable/rotate).
 *
 * Two fields beyond the name and the cap, both settled by the requirement 36
 * investigation (task 10.1) against OpenRouter's key management API:
 *
 *  - `workspace_id` TARGETS a workspace explicitly, and `POST /keys` defaults to
 *    the account's DEFAULT workspace when it is absent. So workspace association
 *    is a request field rather than a property of the minting key, and one
 *    account-level management key mints into any workspace. Omitted from the body
 *    entirely when we have no id, so the request stays byte-identical to the one
 *    every existing key was minted with.
 *  - `limit_reset: 'monthly'` puts the key's cap on the SAME clock as the
 *    allowance it mirrors. Without it OpenRouter treats `limit` as cumulative for
 *    the life of the key, so `TierLimits.monthlyCostUsd` - a monthly allowance
 *    `quotas` resets - became a lifetime ceiling, and a long-lived tenant would
 *    eventually be refused by the vendor with our own gate saying they were fine.
 *    It is set HERE rather than patched onto existing keys because changing
 *    `limit_reset` changes what an existing key's accrued usage means, and the
 *    migration re-mints every key anyway - so the fleet converges without a
 *    second, subtler write.
 *
 * `creditLimitUsd` is the GRANT-AWARE ceiling, not `tierLimits(tier).monthlyCostUsd`
 * - see {@link runtimeKeyLimitUsd}. A key minted for a tenant who already holds an
 * unspent pack has to carry the pack, or the overage the pack was bought to cover
 * is refused by the vendor.
 */
export async function provisionOpenRouterKey(
  provisioningKey: string,
  tenantId: string,
  creditLimitUsd: number,
  options: { workspaceId?: string } = {},
): Promise<{ key: string; hash: string }> {
  const response = await fetch(OPENROUTER_KEYS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: runtimeKeyName(tenantId),
      limit: creditLimitUsd,
      limit_reset: 'monthly',
      ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter key provisioning failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as { key?: string; data?: { hash?: string } };
  if (!body.key) throw new Error('OpenRouter provisioning response carried no key.');
  return { key: body.key, hash: body.data?.hash ?? '' };
}

/** An error message, without letting a non-Error throw become "[object Object]". */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `PATCH /keys/{hash}` - the one mutation OpenRouter offers on an existing key.
 *
 * Both callers below go through here because they are the same request with a
 * different field, and the failure handling is the part worth having once:
 * throwing on a non-2xx with a TRUNCATED vendor body, so a caller can report the
 * failure instead of assuming a silent success.
 *
 * Verified against OpenRouter's key management API (2026-09-02): the endpoint
 * accepts `disabled`, `limit`, `limit_reset`, `include_byok_in_limit` and `name`,
 * and only the fields present in the body are changed. That is what makes
 * requirement 37 a patch rather than a mint-and-rotate: a tier change can move
 * the spend cap on the key the tenant already holds.
 */
async function patchOpenRouterKey(
  provisioningKey: string,
  keyHash: string,
  patch: Record<string, unknown>,
  what: string,
): Promise<void> {
  const response = await fetch(`${OPENROUTER_KEYS_API}/${encodeURIComponent(keyHash)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter key ${what} failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

/** Disables a previously provisioned runtime key. */
export async function disableOpenRouterKey(
  provisioningKey: string,
  keyHash: string,
): Promise<void> {
  await patchOpenRouterKey(provisioningKey, keyHash, { disabled: true }, 'disable');
}

/**
 * Moves an existing runtime key's USD spend cap - requirement 37, and the reason
 * a tier change does not have to rotate a key at all.
 *
 * NOTE ON WHAT THIS LIMIT IS, AND WHAT THIS PATCH DELIBERATELY LEAVES ALONE.
 * OpenRouter's `limit` is CUMULATIVE against the key unless a `limit_reset` is
 * set, so a cap with no reset is a LIFETIME ceiling while
 * `TierLimits.monthlyCostUsd` is a monthly allowance `quotas` resets - two
 * clocks on the same number. {@link provisionOpenRouterKey} now mints with
 * `limit_reset: 'monthly'`, which puts a new key on the right clock, and the
 * workspace migration (task 10.2) re-mints every key that predates it, so the
 * fleet converges through mints alone.
 *
 * This patch does NOT send `limit_reset`, and that is a decision rather than an
 * omission: it would change what an existing key's accrued usage measures
 * (lifetime spend suddenly read as this month's), on a path that runs on every
 * tier change AND on every top-up, when the migration is already the moment that
 * conversion is accounted for. Two fields, so the body stays the minimum the
 * requirement needs - `provisioning.test.mjs` asserts exactly that. The grant term
 * moves the limit VALUE, never the body shape.
 *
 * ORDERING CAVEAT, and the reason this is only fully sound after the migration has
 * run. A key minted BEFORE `limit_reset: 'monthly'` existed reads `limit` as a
 * LIFETIME ceiling, and nothing in the tenant row records which kind of key a
 * tenant holds - there is no `GET /keys/{hash}` call anywhere in the worker, and
 * adding one to find out is deliberately out of scope. So on a pre-migration key
 * this cap is `allowance + pool` measured against spend since the key was minted,
 * which is TIGHTER than intended and fails towards refusing a run rather than
 * overspending. `scripts/migrate-openrouter-workspace.mjs` re-mints the fleet,
 * after which every key is on the monthly clock and the cap means what it says.
 *
 * Our own gate (`resolveHostedInference`) is what enforces the monthly figure
 * either way, and the key limit is the backstop for a bypass of it, so any
 * remaining mismatch degrades towards refusing a run rather than overspending.
 */
export async function updateOpenRouterKeyLimit(
  provisioningKey: string,
  keyHash: string,
  creditLimitUsd: number,
): Promise<void> {
  // `disabled: false` rides along because the only caller reconciles an ACTIVE
  // tenant, and a resubscriber's key was disabled when they cancelled. Without it,
  // a reactivation would restore the tier, the allowance and the cap on a key
  // OpenRouter still refuses, and every hosted run would fail at the vendor with
  // the tenant's own row saying they are entitled. Idempotent on a key that was
  // never disabled, and no way for it to revive a cancelled tenant's key: a
  // cancelled row is not reconciled at all.
  await patchOpenRouterKey(
    provisioningKey,
    keyHash,
    { limit: creditLimitUsd, disabled: false },
    'limit update',
  );
}

/**
 * Takes a tenant's runtime key out of service and REPORTS whether it worked -
 * requirement 39, in one place, for every caller that has ever needed it.
 *
 * The thing this function exists to not be is `.catch(() => undefined)`, which is
 * what `/api/deactivate` did: it reported a successful deactivation while the key
 * stayed live and kept spending. A failure here is logged as an error AND returned,
 * so a caller can put it in a response body (`runtimeKeyDisabled: false`) and a
 * leaked key is discoverable rather than invisible.
 *
 * It never throws, and every caller relies on that for a different reason: a
 * cancellation must land even when OpenRouter is down, a webhook that raised here
 * would have Stripe redeliver the cancellation forever, and a rotation must not
 * lose a freshly minted key over a failure to retire the old one.
 *
 * `reason` is a short phrase naming WHY the key was being retired ("cancelled",
 * "deactivated", "superseded by a replacement key"), so one log line identifies
 * both the tenant and the path that left the key live.
 *
 * A tenant with no `openrouterKeyId` returns true: there is nothing live, and a
 * `false` there would mean "we failed", which is a different fact.
 */
export async function disableTenantRuntimeKey(
  env: TenantEnv,
  tenant: Pick<TenantRecord, 'id' | 'openrouterKeyId'>,
  reason: string,
): Promise<boolean> {
  if (!tenant.openrouterKeyId) return true;
  if (!env.OPENROUTER_PROVISIONING_KEY) {
    console.error(
      `Tenant ${tenant.id}: their OpenRouter runtime key (${reason}) could not be disabled ` +
        `because this worker has no OPENROUTER_PROVISIONING_KEY. The key is still live.`,
    );
    return false;
  }
  try {
    await disableOpenRouterKey(env.OPENROUTER_PROVISIONING_KEY, tenant.openrouterKeyId);
    return true;
  } catch (error) {
    console.error(
      `Tenant ${tenant.id}: disabling their OpenRouter runtime key (${reason}) failed ` +
        `(${errorMessage(error)}). The key may still be live - disable it by hand.`,
    );
    return false;
  }
}

/**
 * What one {@link reconcileRuntimeKey} call did, in the two units a caller cares
 * about: whether the tenant can run, and whether anything was left live.
 *
 * Every field is reportable. `/api/provision` puts them in its response body and
 * the webhook logs them, because the alternative - a void return - is how a key
 * that failed to move became invisible in the first place.
 */
export interface RuntimeKeyOutcome {
  /**
   * The path taken:
   *
   *  - `limit_updated` - the tenant's existing key now carries the tier's cap.
   *  - `limit_failed`  - it does not, and still carries the old one.
   *  - `minted`        - a new key was created and stored.
   *  - `mint_failed`   - it was not; the tenant may have no usable key.
   *  - `unmanaged`     - a usable key with no stored hash, so it can be neither
   *                      re-limited nor safely replaced. Needs an operator.
   *  - `skipped`       - this worker is not configured to manage keys at all.
   */
  action: 'limit_updated' | 'limit_failed' | 'minted' | 'mint_failed' | 'unmanaged' | 'skipped';
  /** Whether the tenant holds a key `resolveHostedInference` can hand to a run. */
  keyPresent: boolean;
  /**
   * The cap this call was reconciling towards: the tier's monthly allowance PLUS
   * the tenant's unspent grant pool, which is the same ceiling the gate enforces
   * ({@link effectiveCostUsdLimit}). See {@link runtimeKeyLimitUsd} for why the
   * naive-looking sum is the correct one.
   *
   * Reported on a FAILED outcome too, so a log line names the cap the key should
   * be carrying and does not.
   */
  limitUsd: number;
  /**
   * Requirement 38/39 together: `true` when a superseded key was retired, `false`
   * when the attempt FAILED and a live key is still out there, `null` when there
   * was nothing to retire. Three states because "nothing to do" and "we tried and
   * could not" must not read the same in a response body.
   */
  supersededKeyDisabled: boolean | null;
  /**
   * A short reason, safe to put in a RESPONSE BODY - which is why it is written
   * here rather than forwarded.
   *
   * NEVER a vendor message. `provisionOpenRouterKey` and `patchOpenRouterKey`
   * carry up to 200 characters of OpenRouter's response body in their errors, and a
   * vendor body is not ours to hand on: it can echo a request header, and
   * `/api/provision` puts this field in its JSON. So the full failure goes to
   * `console.error` (ours, private) and this stays our own sentence, the same split
   * `status.ts` makes for its probes.
   */
  detail?: string;
}

/**
 * The USD cap a runtime key should carry: the tier's monthly allowance PLUS the
 * tenant's unspent grant pool. Exactly the ceiling `resolveHostedInference`
 * enforces, which is the whole point - a key that refused a run our own gate
 * allowed would make a purchased top-up unusable at the vendor.
 *
 * ## Why the naive-looking sum is correct
 *
 * The cap is patched to `allowance + poolAtPatch`, and then time passes. Between
 * two patches the pool only SHRINKS - consumption climbs it towards zero, and a
 * NEW grant is itself a patch - while the allowance is constant, because a tier
 * change is also a patch. So for any `t` after a patch:
 *
 *     ourCeiling(t) = allowance + poolNow(t)
 *                  <= allowance + poolAtPatch
 *                   = keyLimit
 *
 * The key can therefore never refuse a run the gate allows. That direction is the
 * one that matters: the reverse is a backstop being loose, not money escaping.
 *
 * ## The residual, which is accepted rather than engineered away
 *
 * After a month boundary the key's cap can sit ABOVE our ceiling by whatever pool
 * was unspent at the last patch, until the next patch tightens it. That is fine.
 * Our gate is the primary control and reads the LIVE pool on every request; the key
 * cap exists as a backstop for a bypass of the gate, and a backstop being generous
 * by the size of one unspent pack is not worth a cron sweep or a "last patched
 * month" column to close. Do not add either.
 *
 * ## Never throws, and degrades to the tier allowance
 *
 * {@link reconcileRuntimeKey}'s contract is that it does not raise, because the
 * Stripe webhook calls it and a rejection there is a non-2xx and an endless
 * redelivery. This read is the only D1 access on that path, so its failure has to
 * land here: a store with no D1 binding, or a database that predates
 * `0003_billing.sql` and therefore has no `credit_grants` table (which is exactly
 * the state of the hosted database the workspace migration runs against), falls
 * back to `EMPTY_GRANT_POOL`. That reproduces the pre-grant behaviour precisely -
 * the tier allowance alone - which is the safe direction.
 */
async function runtimeKeyLimitUsd(store: TenantStore, tenant: TenantRecord): Promise<number> {
  const limits = tierLimits(tenant.tier);
  // Not an error: a worker with no D1 binding is a BYO deployment, and the pool of
  // a tenancy that does not exist is empty by definition.
  if (!store.enabled) return effectiveCostUsdLimit(limits, EMPTY_GRANT_POOL);
  try {
    return effectiveCostUsdLimit(limits, await store.grantPool(tenant.id));
  } catch (error) {
    console.error(
      `Tenant ${tenant.id}: their grant pool could not be read (${errorMessage(error)}), so their ` +
        `OpenRouter runtime key is being capped at the ${tenant.tier} tier allowance alone. Any ` +
        `purchased top-up will be refused at the vendor until this is reconciled again.`,
    );
    return effectiveCostUsdLimit(limits, EMPTY_GRANT_POOL);
  }
}

/**
 * Brings a tenant's OpenRouter runtime key into line with the tier their row now
 * says they are on, and with the top-ups they have bought - requirements 37 and
 * 38, and the seam the webhook's subscription write left open.
 *
 * ## Why patch rather than rotate
 *
 * `upsertTenant` moves `tier`, and with it the displayed allowance and the quota
 * cap, while the runtime key kept whatever limit it was minted with. So an upgrade
 * to Team left the real ceiling at Starter's $4, and a downgrade left a $44 cap on
 * an account paying for $4. The fix is one PATCH on the key the tenant already
 * holds, which is preferable to minting a replacement on every tier change for
 * three reasons: it cannot desynchronize the two key columns, it does not leak a
 * key if the second half fails, and it keeps the key's accrued usage rather than
 * resetting the spend history a cumulative limit is measured against.
 *
 * The patch also clears `disabled`, because every caller reconciles a tenant whose
 * row says `active` and a resubscriber's key was retired when they cancelled - see
 * {@link updateOpenRouterKeyLimit}.
 *
 * ## Two things move the cap, not one
 *
 * A tier change and a TOP-UP both do, because the cap is
 * {@link runtimeKeyLimitUsd} - allowance plus unspent grants - rather than the tier
 * allowance alone. A tenant who bought a pack had our ceiling raised while their
 * key's cap stayed at the tier figure, so the vendor refused the exact overage the
 * pack was sold to cover. Both halves are required: without the grant term, patching
 * on the webhook's grant path would achieve nothing; without patching on that path,
 * a later tier change would be the first thing to notice the pack, and a tier change
 * computed from the tier alone would patch the pack straight back out again.
 *
 * A replacement is minted only when there is nothing to patch - a first-time
 * subscriber, or a row whose ciphertext is missing so the gate cannot use it. When
 * one IS minted and a superseded hash exists, that hash is disabled FIRST
 * (requirement 38): two live keys for one tenant is the state with a real cost, and
 * a failed mint after a successful disable self-heals on the next subscription
 * event, while a failed disable after a successful mint leaks silently forever.
 *
 * ## The contract callers depend on
 *
 * IT NEVER THROWS. The Stripe webhook calls this after writing subscription state,
 * and an exception there would be a non-2xx: Stripe would redeliver the event, the
 * state write would repeat, and the delivery would keep failing for as long as
 * OpenRouter was unwell. So every failure is an {@link RuntimeKeyOutcome} plus an
 * error log, never a rejection.
 *
 * It also reads the tier off the STORED RECORD rather than from an event. A stale
 * Stripe event still performs its write (the clocks refuse the stale fields), so
 * the tier the event carries is not necessarily the tier the tenant is on -
 * reconciling against the event would then move the spend cap to a superseded
 * plan. Callers pass the row as it stands after the write.
 *
 * ## Only `active` tenants, and that gate is the CALLER'S
 *
 * Re-limiting a `canceled` or `past_due` key would undo the branch that took it out
 * of service, and the patch below carries `disabled: false`, so calling this for a
 * lapsed tenant would hand them a live key. Every call site checks the status
 * itself; this function deliberately does not, because the migration needs to
 * classify a non-active tenant rather than have the reconciliation quietly no-op.
 */
export async function reconcileRuntimeKey(
  env: TenantEnv,
  store: TenantStore,
  tenant: TenantRecord,
  options: {
    /**
     * Force a replacement even when the existing key could be patched - the
     * primitive a workspace migration needs (task 10.2), and the only way an
     * operator can retire a key deliberately. The superseded key is disabled the
     * same way it is on any other mint.
     */
    rotate?: boolean;
  } = {},
): Promise<RuntimeKeyOutcome> {
  // Tier allowance plus unspent grants, computed ONCE so every outcome below
  // reports the same number. This single line covers both writers (the PATCH and
  // the mint) and every call site.
  const limitUsd = await runtimeKeyLimitUsd(store, tenant);
  const provisioningKey = env.OPENROUTER_PROVISIONING_KEY;
  const keyPresent = Boolean(tenant.openrouterKeyEnc);

  // Not a failure. A BYO worker binds neither secret, and a hosted worker without
  // them is a deployment problem an operator already knows about - so this reads
  // as "not managed here" rather than as an error on every subscription event.
  if (!provisioningKey) {
    return {
      action: 'skipped',
      keyPresent,
      limitUsd,
      supersededKeyDisabled: null,
      detail: 'this worker has no OPENROUTER_PROVISIONING_KEY',
    };
  }

  // The ordinary path once a tenant has a key: one PATCH, and the tier's cap is
  // now the key's cap. Deliberately unconditional rather than gated on "did the
  // tier actually change", because the caller cannot know whether the LAST
  // reconciliation succeeded - so a patch that failed during an OpenRouter blip
  // heals on the next subscription event instead of leaving the wrong cap forever.
  if (keyPresent && tenant.openrouterKeyId && !options.rotate) {
    try {
      await updateOpenRouterKeyLimit(provisioningKey, tenant.openrouterKeyId, limitUsd);
      return { action: 'limit_updated', keyPresent: true, limitUsd, supersededKeyDisabled: null };
    } catch (error) {
      console.error(
        `Tenant ${tenant.id} is on tier ${tenant.tier} but their OpenRouter runtime key still ` +
          `carries its previous USD limit: the update to ${limitUsd} failed ` +
          `(${errorMessage(error)}).`,
      );
      return {
        action: 'limit_failed',
        keyPresent: true,
        limitUsd,
        supersededKeyDisabled: null,
        detail: 'the OpenRouter limit update failed; the worker log carries the reason',
      };
    }
  }

  // A usable key whose hash we never stored (an empty `hash` in an old mint
  // response). It can be neither re-limited nor retired, so minting a replacement
  // would leave the old one live and unreachable FOREVER - the exact leak
  // requirement 38 is about. Refused, loudly, unless an operator asks for the
  // rotation explicitly and accepts the leak.
  if (keyPresent && !tenant.openrouterKeyId && !options.rotate) {
    const detail = 'the stored runtime key has no OpenRouter hash, so it cannot be re-limited';
    console.error(
      `Tenant ${tenant.id} is on tier ${tenant.tier} but ${detail}. Rotate the key by hand and ` +
        `disable the old one in the OpenRouter dashboard - a replacement minted from here could ` +
        `not retire it.`,
    );
    return { action: 'unmanaged', keyPresent: true, limitUsd, supersededKeyDisabled: null };
  }

  // Minting stores a SECRET, so it needs the encryption secret. Degraded rather
  // than thrown, per the `/api/connection-secrets` precedent: a worker missing
  // `KEY_ENC_SECRET` cannot serve hosted inference at all, and crashing a webhook
  // over it would turn a configuration gap into an infinite Stripe retry.
  if (!env.KEY_ENC_SECRET) {
    const detail = 'this worker has no KEY_ENC_SECRET, so a minted key could not be stored';
    console.error(`Tenant ${tenant.id} needs an OpenRouter runtime key but ${detail}.`);
    return { action: 'skipped', keyPresent, limitUsd, supersededKeyDisabled: null, detail };
  }

  // Requirement 38. Before the replacement exists, so this tenant never has two
  // live keys - see the header for why that ordering beats the alternative.
  const supersededKeyDisabled = tenant.openrouterKeyId
    ? await disableTenantRuntimeKey(env, tenant, 'superseded by a replacement key')
    : null;

  try {
    // Requirement 36: the workspace is a MINT-TIME field, so this is the only
    // place a key's workspace is ever decided. `undefined` means the account's
    // default workspace, which is where every key minted before this existed
    // lives - so an unset `OPENROUTER_WORKSPACE_ID` changes nothing.
    const minted = await provisionOpenRouterKey(provisioningKey, tenant.id, limitUsd, {
      workspaceId: env.OPENROUTER_WORKSPACE_ID,
    });
    const keyEnc = await encryptString(minted.key, env.KEY_ENC_SECRET);
    // Both columns in one write. `minted.hash` is empty only if OpenRouter stops
    // returning it, and the key is stored anyway: an unmanageable key that works
    // beats no key, and the branch above then refuses to compound it.
    const stored = await store.setRuntimeKey(tenant.id, minted.hash || null, keyEnc);
    if (!minted.hash) {
      console.error(
        `Tenant ${tenant.id}: OpenRouter returned no hash for their new runtime key, so it cannot ` +
          `be re-limited or disabled from here. Record the hash from the OpenRouter dashboard.`,
      );
    }
    if (!stored) {
      console.error(
        `Tenant ${tenant.id}: a runtime key was minted but no tenant row was there to store it ` +
          `on. The key is live and unreferenced - disable it in the OpenRouter dashboard.`,
      );
      return {
        action: 'mint_failed',
        keyPresent: false,
        limitUsd,
        supersededKeyDisabled,
        detail: 'the tenant row disappeared before the key could be stored',
      };
    }
    return { action: 'minted', keyPresent: true, limitUsd, supersededKeyDisabled };
  } catch (error) {
    console.error(
      `Tenant ${tenant.id} has no usable OpenRouter runtime key: minting one at a ${limitUsd} USD ` +
        `limit failed (${errorMessage(error)}). Hosted inference will refuse with no_runtime_key.`,
    );
    // `keyPresent: false` even when a ciphertext survives: the superseded key was
    // disabled above, so whatever is stored no longer works.
    return {
      action: 'mint_failed',
      keyPresent: false,
      limitUsd,
      supersededKeyDisabled,
      detail: 'minting an OpenRouter runtime key failed; the worker log carries the reason',
    };
  }
}

/**
 * The outcome shape a caller reports when nothing was reconciled because the
 * tenant is not `active`.
 *
 * Reconciling a non-active tenant would hand them a live key - the PATCH carries
 * `disabled: false` - which is why {@link reconcileRuntimeKey} documents the
 * status gate as the CALL SITE's. {@link provisionTenantTier} makes that gate
 * structural instead of documentary, and this is what it reports when it holds.
 *
 * `action: 'skipped'` rather than a sixth token: the wire meaning of `skipped` is
 * already "this call managed no key", and the token set is append-only.
 */
export const RUNTIME_KEY_NOT_RECONCILED: RuntimeKeyOutcome = Object.freeze({
  action: 'skipped',
  keyPresent: false,
  limitUsd: 0,
  supersededKeyDisabled: null,
  detail: 'the tenant is not active, so no runtime key was reconciled',
});

/** What {@link provisionTenantTier} did, or `null` when the row vanished. */
export interface ProvisionedTenant {
  /** The row as it stands AFTER the write, read back rather than assumed. */
  tenant: TenantRecord;
  /**
   * The runtime-key reconciliation, or {@link RUNTIME_KEY_NOT_RECONCILED} when
   * the written status is not `active`.
   */
  key: RuntimeKeyOutcome;
}

/**
 * The ONE provisioning path: write a tenant's tier and status, read the row back,
 * and bring its runtime key into line.
 *
 * Two callers, and the reason they must share this rather than each perform the
 * three steps: `POST /api/provision` is the operator curl, and the organisation
 * management route family (`org-admin.ts`) is the dashboard button. Requirement
 * 19.5 names provisioning as the only way an organisation becomes entitled, and
 * Requirement 13.4 says creating one grants no paid tier - both are claims about
 * ONE path, so there has to be one.
 *
 * The ordering is the whole content of the function and is not negotiable:
 *
 *  1. THE ROW FIRST. That is what makes a re-run an upgrade rather than a
 *     re-provision.
 *  2. READ IT BACK. `reconcileRuntimeKey` reads the tier off the stored record,
 *     never off whatever the caller believed, so a stale event cannot move the
 *     spend cap to a superseded plan.
 *  3. RECONCILE ONLY AN `active` TENANT. See
 *     {@link RUNTIME_KEY_NOT_RECONCILED}.
 *
 * There is NO credit grant here and there must not be one:
 * `credit_grants.stripe_payment_id` is `NOT NULL UNIQUE`, which is what makes a
 * grant idempotent on the payment, and a comp-credit path would have to weaken
 * it. An organisation that needs a higher ceiling gets a TIER change
 * (Requirement 19.10), which is exactly this call with a different `tier`.
 *
 * Returns `null` when the row was written and could not be read back, which is a
 * D1 fault rather than a caller error - reporting it beats minting a key with
 * nowhere to live.
 */
export async function provisionTenantTier(
  env: TenantEnv,
  store: TenantStore,
  input: {
    /** The Owner_Id: a Clerk user id or an organisation id. Validated by the CALLER. */
    id: string;
    email?: string | null;
    /** Written verbatim. An unknown token falls back to starter LIMITS on read. */
    tier: string;
    /** The effective status. Only `active` reaches the runtime key. */
    status: TenantRecord['status'];
    /** Force a key replacement. For a workspace migration or a compromised key. */
    rotate?: boolean;
  },
): Promise<ProvisionedTenant | null> {
  await store.upsertTenant({
    id: input.id,
    email: input.email ?? null,
    tier: input.tier,
    status: input.status,
  });
  const tenant = await store.getTenant(input.id);
  if (!tenant) {
    console.error(`Tenant ${input.id} was provisioned but could not be read back.`);
    return null;
  }
  if (tenant.status !== 'active') {
    return { tenant, key: RUNTIME_KEY_NOT_RECONCILED };
  }
  const key = await reconcileRuntimeKey(env, store, tenant, { rotate: input.rotate === true });
  return { tenant, key };
}

// ── AES-GCM string encryption (WebCrypto, no deps) ───────────────────────────

async function importAesKey(secretB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secretB64), char => char.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(plaintext: string, secretB64: string): Promise<string> {
  const key = await importAesKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptString(packedB64: string, secretB64: string): Promise<string> {
  const key = await importAesKey(secretB64);
  const packed = Uint8Array.from(atob(packedB64), char => char.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

// ── AES-GCM byte encryption, for objects rather than fields ──────────────────
//
// Same key, same 12-byte-IV-prefix packing as the two functions above, but bytes
// in and bytes out. A workflow backup body is a GZIP stream, and pushing that
// through `encryptString` would mean base64 on the way in and base64 again on the
// way out - 1.78x the compressed size in R2, on the one path whose whole job is
// to store things cheaply and forever.
//
// The packing is deliberately IDENTICAL, so anything encrypted by one pair is
// decryptable by the other after a base64 hop. That keeps this an encoding
// choice rather than a second format.

/** Encrypts raw bytes. The IV is prefixed, as in {@link encryptString}. */
export async function encryptBytes(
  plaintext: Uint8Array,
  secretB64: string,
): Promise<Uint8Array> {
  const key = await importAesKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return packed;
}

/**
 * Decrypts what {@link encryptBytes} produced.
 *
 * THROWS on a wrong key or a truncated object, exactly as `crypto.subtle.decrypt`
 * does, rather than answering an empty buffer: a caller handing back a silently
 * empty backup would be worse than one that failed loudly.
 */
export async function decryptBytes(
  packed: Uint8Array,
  secretB64: string,
): Promise<Uint8Array> {
  const key = await importAesKey(secretB64);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new Uint8Array(plain);
}
