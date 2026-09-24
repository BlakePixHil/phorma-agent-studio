/**
 * `/api/admin/billing/*` - operator-only cost and revenue reads.
 *
 * ## Why this exists
 *
 * Every OpenRouter write this worker makes is a *spend limit on a key*, never a
 * deposit: `reconcileRuntimeKey` patches `limit` to `allowance + unspent grants`,
 * which is permission to draw down a PREPAID account balance that no code path in
 * this repo funds, reads, or watches. OpenRouter has no card-based credits
 * purchase API - the only programmatic purchase they ever shipped was a Coinbase
 * Commerce charge their docs now mark deprecated - so funding stays a manual
 * dashboard action and always will.
 *
 * The consequence, before this module: a dry account was completely invisible.
 * `/status.json`'s inference probe fetches `/api/v1/credits` and then `drain()`s
 * the body unread, so it only ever branched on the HTTP status - a zero-balance
 * account answers 200 and read as fully green. The first symptom was `/api/infer`
 * forwarding OpenRouter's 402 to a paying tenant whose own D1 quota said they
 * were fine.
 *
 * And the documented margin (78.0 / 76.9 / 75.8 percent net, in the `TIERS`
 * comment) was measured against the *cap* rather than against invoiced cost or
 * collected revenue. It was an intent, not a figure. Both routes here exist to
 * turn it into a measurement.
 *
 * ## Two routes, and why they are separate
 *
 *  - `GET costs`    D1 plus ONE OpenRouter read. Balance, trailing burn, runway,
 *                   committed ceilings, and the tenants needing attention.
 *  - `GET revenue`  D1 plus TWO paginated Stripe reads, KV-cached.
 *
 * Split rather than merged into one overview so the dashboard renders
 * progressively and, more importantly, so a Stripe outage cannot blank the
 * balance and runway numbers - which are the ones an operator opens this page to
 * see. A vendor being down degrades one card instead of the page.
 *
 * ## Why it is NOT a sixth telemetry aggregate
 *
 * `telemetry-admin.ts` is built around anonymity: no `install_id` reaches a
 * response body by construction, and a k-anonymity floor folds any group under
 * five installs into `other`. This module reports IDENTIFIED paying tenants, by
 * id, because "which account is cancelled but still holding a live key" is not
 * actionable without the id. Those are opposite privacy contracts over different
 * tables, and hosting them in one module would make the anonymity claim in that
 * one untrue by adjacency. Same door (`admin-auth.ts`), different room.
 *
 * ## The public status page is deliberately untouched
 *
 * `/status.json` is rendered on phorma-labs.com's public footer, so anything that
 * moved its colour would tell visitors about our funding rather than about their
 * service. A low balance is a business fact, not an outage. So the balance lives
 * ONLY here, behind the operator allowlist, and `status.ts` keeps its existing
 * reachability-plus-credential probe unchanged.
 *
 * ## Money conventions in every body below
 *
 * Every USD figure is a NUMBER OF DOLLARS, not minor units - the opposite of
 * Stripe's own convention, and converted once at the boundary in
 * {@link minorToUsd}. D1 already stores dollars (`usage.cost_usd`,
 * `credit_grants.cost_usd`) and `TIERS.monthlyCostUsd` is dollars, so converting
 * Stripe on the way in means exactly one unit in the response and no per-field
 * rule for a reader to remember. Figures are rounded for transport only
 * ({@link round2} / {@link round4}); nothing here is an accounting record.
 *
 * ## No vendor prose ever reaches a response body
 *
 * Same rule the status probes and `RuntimeKeyOutcome.detail` follow. A Stripe
 * error body quotes the API key back at you, and an OpenRouter body can echo a
 * request header. Failures become one of OUR fixed sentences plus a
 * `console.error`, and the `degraded` array names the half that failed rather
 * than why.
 */

import {
  noStoreResponder,
  refuseNonOperator,
  type AdminAuthEnv,
  type AdminRespond,
} from './admin-auth';
import { WORKER_BUILD } from './build-info';
import { stripeRequest, type StripeEnv } from './stripe';
import {
  TIERS,
  tierLimits,
  usdPerCredit,
  type TenantEnv,
} from './tenants';
import { parseDateRange, type DateRange } from './telemetry-admin';
import { metricDayUtc } from './telemetry';

/** The path prefix this module owns. Every route sits below it. */
export const BILLING_ADMIN_PREFIX = '/api/admin/billing/';

/** The two routes, both `GET`, both accepting `from` and `to`. */
export const BILLING_ADMIN_ROUTES = ['costs', 'revenue'] as const;

export type BillingAdminRoute = (typeof BILLING_ADMIN_ROUTES)[number];

/** Every binding this module touches. */
export type BillingAdminEnv = AdminAuthEnv & TenantEnv & StripeEnv;

/**
 * Trailing window the burn rate and therefore the runway are measured over.
 *
 * 30 days rather than the selected range on purpose: runway is a property of the
 * account right now, not of whatever window the operator happens to be looking
 * at, and a one-day range would otherwise produce a runway figure built from a
 * single day's spend. The range picker drives the REVENUE route, which is a
 * period question; this one ignores it.
 */
export const BURN_WINDOW_DAYS = 30;

/** Hard cap on Stripe list pages, so one route cannot walk an unbounded history. */
const STRIPE_MAX_PAGES = 10;

/** Objects per Stripe page. 100 is Stripe's maximum. */
const STRIPE_PAGE_SIZE = 100;

/**
 * How long a revenue answer is cached in KV.
 *
 * The Stripe half is two paginated reads and the numbers move only when somebody
 * pays, so re-walking the invoice list on every dashboard render buys nothing.
 * 300s is comfortably above KV's 60s minimum TTL and short enough that a test
 * purchase shows up while you are still looking for it.
 */
export const REVENUE_CACHE_SECONDS = 300;

/** The fixed sentences a failure answers with. Static: no vendor prose, ever. */
export const BILLING_ADMIN_FAILED_ERROR = 'Billing aggregate unavailable.';
export const BILLING_RANGE_ERROR = 'Invalid date range.';

/** Names of the halves that can degrade, as they appear in `degraded`. */
export const DEGRADED_VENDOR_BALANCE = 'openrouter-balance';
export const DEGRADED_METERED_COST = 'metered-cost';
export const DEGRADED_COMMITTED = 'committed-ceilings';
export const DEGRADED_ATTENTION = 'tenant-attention';
export const DEGRADED_STRIPE_INVOICES = 'stripe-invoices';
export const DEGRADED_STRIPE_FEES = 'stripe-fees';

// ── Response shapes ──────────────────────────────────────────────────────────

/**
 * What the OpenRouter account holds. Every field is nullable because the read
 * can fail or the key can be unbound, and a missing balance must read as
 * "unknown" rather than as zero - zero is the one value that would make the
 * runway look catastrophic when nothing is actually wrong.
 */
export interface VendorBalance {
  /** Whether `OPENROUTER_PROVISIONING_KEY` is bound at all. */
  configured: boolean;
  /** Whether the read succeeded. False with `configured` true means a vendor problem. */
  reachable: boolean;
  /** `total_credits` - lifetime credits purchased onto the account. */
  purchasedUsd: number | null;
  /** `total_usage` - lifetime spend against them. */
  spentUsd: number | null;
  /** `purchased - spent`, clamped at 0. What is left to draw down. */
  balanceUsd: number | null;
}

/** One UTC day of metered spend inside the burn window. */
export interface BurnDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  usd: number;
}

/** Burn rate and the runway it implies. */
export interface BurnRate {
  /** Always {@link BURN_WINDOW_DAYS}. Stated so a reader need not assume it. */
  windowDays: number;
  /** `SUM(usage.cost_usd)` over the window - OUR metered figure, not the vendor's. */
  meteredUsd: number;
  /** `meteredUsd / windowDays`. */
  perDayUsd: number;
  /**
   * `balanceUsd / perDayUsd`, or null when the balance is unknown or nothing has
   * been spent in the window. Null is "cannot be computed", never "infinite".
   */
  runwayDays: number | null;
  /**
   * The same window per UTC day, ascending and zero-filled, so its sum is
   * `meteredUsd`. The first day is partial (the window starts at an instant).
   * Empty when the ledger could not be read or there is no D1 binding.
   */
  daily: BurnDay[];
}

/** One tier's contribution to the committed ceiling. */
export interface TierCommitment {
  tier: string;
  tenants: number;
  /** `tenants * TIERS[tier].monthlyCostUsd`. */
  allowanceUsd: number;
}

/**
 * What we have promised active tenants they may spend, which is also the sum of
 * the `limit` values on their OpenRouter keys.
 *
 * The comparison against the balance is the number with real operational
 * meaning: if every active tenant spent their full allowance this month, would
 * the account cover it?
 */
export interface CommittedCeiling {
  activeTenants: number;
  /** Sum of tier monthly allowances over ACTIVE tenants. */
  allowanceUsd: number;
  /** Unspent purchased grants held by active tenants - grants raise the ceiling. */
  grantPoolUsd: number;
  /** `allowanceUsd + grantPoolUsd`. The sum of every active key's cap. */
  ceilingUsd: number;
  /**
   * `balanceUsd / ceilingUsd`. Below 1 means a fully-spending month would run the
   * account dry. Null when the balance is unknown or nothing is committed.
   */
  coverageRatio: number | null;
  byTier: TierCommitment[];
}

/** A tenant whose row and whose runtime key disagree about entitlement. */
export interface TenantAttentionRow {
  id: string;
  tier: string;
  status: string;
}

/**
 * The two disagreements worth an operator's time, both invisible today.
 *
 * `retiredHoldingKey` is the one with a cost attached: a `canceled` or `past_due`
 * tenant whose `openrouter_key_id` is still set. `disableTenantRuntimeKey` patches
 * the vendor but deliberately does NOT null the columns, so a populated hash is
 * the EXPECTED steady state after a cancellation and this list is not by itself a
 * leak - it is the list to check against the OpenRouter dashboard, because there
 * is no `GET /keys/{hash}` call anywhere in this worker to confirm the patch
 * landed.
 */
export interface TenantAttention {
  /** `active` tenants with no usable key - these get `no_runtime_key` on every run. */
  entitledWithoutKey: number;
  /** Non-active tenants still carrying a key hash. Capped, newest first. */
  retiredHoldingKey: TenantAttentionRow[];
}

/** `GET costs` - what we are spending and what we have promised. */
export interface BillingCostsResponse {
  vendor: VendorBalance;
  burn: BurnRate;
  committed: CommittedCeiling;
  attention: TenantAttention;
  /** Which halves could not be computed. Empty on a clean read. */
  degraded: string[];
  generatedAt: string;
}

/** What Stripe invoiced and collected over the range. */
export interface InvoicedRevenue {
  count: number;
  /** What customers paid, tax included - every catalogue price is tax inclusive. */
  grossUsd: number;
  /** The tax carved out of it and remitted. Never ours (requirement 49). */
  taxUsd: number;
  /** `gross - tax`. The margin basis. */
  netUsd: number;
  /** Invoices in a currency other than USD, which are NOT in the totals above. */
  otherCurrencyCount: number;
  /** True when the page cap was hit, so the totals are a floor rather than a total. */
  truncated: boolean;
}

/** What Stripe took to process it. */
export interface ProcessingCost {
  count: number;
  /** `SUM(fee)` over balance transactions in range - includes refund and dispute fees. */
  feeUsd: number;
  otherCurrencyCount: number;
  truncated: boolean;
}

/**
 * The margin, measured rather than asserted.
 *
 * `vendorCostUsd` is OUR metered OpenRouter spend over the same range from D1,
 * not the vendor's lifetime `total_usage`, so the two sides of the subtraction
 * describe the same period.
 */
export interface MeasuredMargin {
  netUsd: number;
  vendorCostUsd: number;
  processingFeeUsd: number;
  /** `net - vendorCost - processingFee`. */
  marginUsd: number;
  /** `marginUsd / netUsd` as a percentage, or null when there was no revenue. */
  marginPct: number | null;
}

/** `GET revenue` - what came in, what it cost, and what was left. */
export interface BillingRevenueResponse {
  range: DateRange;
  /** Whether `STRIPE_SECRET_KEY` is bound. False on a BYO worker. */
  configured: boolean;
  invoiced: InvoicedRevenue | null;
  processing: ProcessingCost | null;
  margin: MeasuredMargin | null;
  degraded: string[];
  generatedAt: string;
}

export type BillingAdminResponse = BillingCostsResponse | BillingRevenueResponse;

// ── The route ────────────────────────────────────────────────────────────────

/**
 * Handles `/api/admin/billing/*`, or returns null when the path is not below the
 * prefix - matching every other route helper in this worker.
 *
 * The authorization gate runs BEFORE method and route dispatch, so an
 * unauthorized caller cannot use the response code to learn which routes exist.
 */
export async function handleBillingAdminRequest(
  request: Request,
  env: BillingAdminEnv,
  url: URL,
  respond: AdminRespond,
): Promise<Response | null> {
  if (!url.pathname.startsWith(BILLING_ADMIN_PREFIX)) return null;

  const reply = noStoreResponder(respond);

  const refusal = await refuseNonOperator(request, env, reply);
  if (refusal) return refusal;

  if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);

  const route = url.pathname.slice(BILLING_ADMIN_PREFIX.length);
  if (!isBillingRoute(route)) return reply({ error: 'Not found.' }, 404);

  // ONE date grammar for every admin surface: `parseDateRange` is imported from
  // the telemetry module rather than restated, so `from`/`to` cannot mean two
  // things depending on which card is reading them.
  const parsed = parseDateRange(url.searchParams, metricDayUtc(Date.now()));
  if (!parsed.ok) return reply({ error: BILLING_RANGE_ERROR }, 400);

  try {
    const body =
      route === 'costs'
        ? await buildCosts(env)
        : await buildRevenue(env, parsed.range);
    return reply(body);
  } catch (error) {
    // A defect in our own aggregation, not a vendor failure - every vendor call
    // below is individually caught and degraded. Fixed string, no query, no
    // exception message, no binding name.
    console.error(`billing admin aggregate failed: ${describeError(error)}`);
    return reply({ error: BILLING_ADMIN_FAILED_ERROR }, 500);
  }
}

function isBillingRoute(route: string): route is BillingAdminRoute {
  return (BILLING_ADMIN_ROUTES as readonly string[]).includes(route);
}

// ── GET costs ────────────────────────────────────────────────────────────────

/**
 * Balance, burn, runway, committed ceilings and the attention list.
 *
 * Every contributing read is INDEPENDENTLY degradable, and they run together:
 * the OpenRouter read is a network round trip and the three D1 reads are
 * indexed sums, so serializing them would make the card feel slow for no reason.
 * A failure in any one lands in `degraded` and leaves the others intact, because
 * an operator opening this page during an OpenRouter outage still wants to know
 * what we have committed.
 */
export async function buildCosts(env: BillingAdminEnv): Promise<BillingCostsResponse> {
  const degraded: string[] = [];
  const db = env.DB;

  const [vendor, metered, committed, attention] = await Promise.all([
    readVendorBalance(env, degraded),
    readMeteredBurn(db, degraded),
    readCommittedCeiling(db, degraded),
    readTenantAttention(db, degraded),
  ]);

  const perDayUsd = round4(metered.total / BURN_WINDOW_DAYS);
  return {
    vendor,
    burn: {
      windowDays: BURN_WINDOW_DAYS,
      meteredUsd: round4(metered.total),
      perDayUsd,
      runwayDays: runwayDays(vendor.balanceUsd, perDayUsd),
      daily: metered.daily,
    },
    committed: {
      ...committed,
      coverageRatio: coverageRatio(vendor.balanceUsd, committed.ceilingUsd),
    },
    attention,
    degraded,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * `balance / perDay`, or null.
 *
 * Null rather than `Infinity` when nothing has been spent: `Infinity` does not
 * survive `JSON.stringify` (it serializes as `null` anyway, but silently and
 * from the wrong reason), and "no spend in the window, so this cannot be
 * projected" is a different fact from a very long runway. Capped at four years,
 * because a runway measured in decades is a rounding artifact of a near-zero
 * burn rather than information.
 */
export function runwayDays(balanceUsd: number | null, perDayUsd: number): number | null {
  if (balanceUsd === null || !Number.isFinite(balanceUsd)) return null;
  if (!Number.isFinite(perDayUsd) || perDayUsd <= 0) return null;
  return Math.min(1461, Math.round(balanceUsd / perDayUsd));
}

/** `balance / ceiling`, or null when either side is unknown or nothing is committed. */
export function coverageRatio(balanceUsd: number | null, ceilingUsd: number): number | null {
  if (balanceUsd === null || !Number.isFinite(balanceUsd)) return null;
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) return null;
  return round4(balanceUsd / ceilingUsd);
}

/**
 * The one OpenRouter read in this module: `GET /api/v1/credits`, which needs the
 * management key and answers `{ data: { total_credits, total_usage } }`.
 *
 * This is what `/status.json` fetches and throws away. Here the body is actually
 * parsed, which is the whole point of the route.
 *
 * Never throws. An unbound key is `configured: false` (a BYO worker, or a local
 * `wrangler dev`), and a vendor failure is `reachable: false` plus a log line -
 * the numbers stay null rather than becoming zero, because a zero balance and an
 * unknown balance would otherwise be indistinguishable and the first is an
 * emergency.
 */
async function readVendorBalance(
  env: BillingAdminEnv,
  degraded: string[],
): Promise<VendorBalance> {
  const key = env.OPENROUTER_PROVISIONING_KEY?.trim();
  if (!key) {
    return {
      configured: false,
      reachable: false,
      purchasedUsd: null,
      spentUsd: null,
      balanceUsd: null,
    };
  }

  const unreachable = (reason: string): VendorBalance => {
    console.error(`OpenRouter credit balance could not be read: ${reason}`);
    degraded.push(DEGRADED_VENDOR_BALANCE);
    return {
      configured: true,
      reachable: false,
      purchasedUsd: null,
      spentUsd: null,
      balanceUsd: null,
    };
  };

  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: {
        Authorization: `Bearer ${key}`,
        // Repo rule: any outbound HTTP sets a User-Agent. Several public APIs
        // reject UA-less requests and the failure is silent because JSON parsing
        // masks the error body.
        'User-Agent': `PhormaAgentStudio/${WORKER_BUILD} (+https://phorma-labs.com)`,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return unreachable(describeError(error));
  }

  if (!response.ok) {
    // The vendor body is NOT read into the reason: it can echo a request header,
    // and this status is enough to act on.
    return unreachable(`HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return unreachable(`the response was not JSON (${describeError(error)})`);
  }

  const data = asRecord(asRecord(parsed)?.['data']);
  const purchased = finiteNumber(data?.['total_credits']);
  const spent = finiteNumber(data?.['total_usage']);
  if (purchased === null || spent === null) {
    return unreachable('the response carried no usable total_credits and total_usage');
  }

  return {
    configured: true,
    reachable: true,
    purchasedUsd: round4(purchased),
    spentUsd: round4(spent),
    // Clamped: OpenRouter permits a small negative balance in flight, and a
    // negative runway is not a reading anybody can act on differently from zero.
    balanceUsd: round4(Math.max(0, purchased - spent)),
  };
}

/**
 * `SUM(usage.cost_usd)` over the trailing {@link BURN_WINDOW_DAYS}.
 *
 * OUR metered figure rather than OpenRouter's `total_usage`, for two reasons:
 * `total_usage` is lifetime and cannot be windowed, and it includes any spend on
 * the account that did not come through a tenant runtime key. This number is
 * what tenants actually cost us in the window.
 *
 * `created_at` is an ISO 8601 string, so a lexicographic `>=` against another ISO
 * string is a chronological compare. There is no index on `created_at` - the
 * table is small and this is an operator read on a page nobody loads in a loop,
 * so it is a scan by design rather than by oversight.
 *
 * One grouped query serves both the total and the daily series, so the two can
 * never disagree: the total IS the sum of the days.
 */
async function readMeteredBurn(
  db: D1Database | undefined,
  degraded: string[],
): Promise<{ total: number; daily: BurnDay[] }> {
  if (!db) return { total: 0, daily: [] };
  const now = Date.now();
  const since = new Date(now - BURN_WINDOW_DAYS * 86_400_000).toISOString();
  try {
    const { results } = await db
      .prepare(
        'SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS spent ' +
          'FROM usage WHERE created_at >= ? GROUP BY day ORDER BY day',
      )
      .bind(since)
      .all<{ day: string; spent: number }>();
    const byDay = new Map<string, number>();
    for (const row of results ?? []) {
      byDay.set(row.day, Math.max(0, finiteNumber(row.spent) ?? 0));
    }
    const daily = burnDays(since.slice(0, 10), new Date(now).toISOString().slice(0, 10), byDay);
    const total = [...byDay.values()].reduce((sum, usd) => sum + usd, 0);
    return { total, daily };
  } catch (error) {
    console.error(`billing admin: the metered burn could not be read: ${describeError(error)}`);
    degraded.push(DEGRADED_METERED_COST);
    return { total: 0, daily: [] };
  }
}

/** Every UTC day from `first` to `last` inclusive, zero where nothing was metered. */
export function burnDays(first: string, last: string, byDay: ReadonlyMap<string, number>): BurnDay[] {
  const days: BurnDay[] = [];
  let cursor = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  // Bounded: a window of N days spans at most N + 1 calendar days.
  while (cursor <= end && days.length <= BURN_WINDOW_DAYS + 1) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    days.push({ day, usd: round4(byDay.get(day) ?? 0) });
    cursor += 86_400_000;
  }
  return days;
}

/**
 * What active tenants are permitted to spend: tier allowances plus their unspent
 * grants, which is exactly the number `reconcileRuntimeKey` patches onto each
 * OpenRouter key.
 *
 * Two statements rather than a join. The allowance side has to be computed in
 * TypeScript because `TIERS` lives in code and not in D1 - SQL cannot know that
 * `pro` means $12.60 - so the query groups by tier and the multiplication happens
 * here. An unknown tier on a row falls back through `tierLimits` to starter,
 * matching what the entitlement gate would give that tenant.
 *
 * The grant side is scoped to ACTIVE tenants by a subquery, because a cancelled
 * tenant's unspent pack is not a live commitment against the balance.
 */
async function readCommittedCeiling(
  db: D1Database | undefined,
  degraded: string[],
): Promise<Omit<CommittedCeiling, 'coverageRatio'>> {
  const empty = {
    activeTenants: 0,
    allowanceUsd: 0,
    grantPoolUsd: 0,
    ceilingUsd: 0,
    byTier: [] as TierCommitment[],
  };
  if (!db) return empty;

  try {
    const [tiers, grants] = await Promise.all([
      db
        .prepare(
          "SELECT tier, COUNT(*) AS tenants FROM tenants WHERE status = 'active' GROUP BY tier",
        )
        .all<{ tier: string; tenants: number }>(),
      db
        .prepare(
          'SELECT COALESCE(SUM(MAX(0, cost_usd - cost_usd_consumed)), 0) AS pool ' +
            'FROM credit_grants WHERE tenant_id IN ' +
            "(SELECT id FROM tenants WHERE status = 'active')",
        )
        .first<{ pool: number }>(),
    ]);

    const byTier: TierCommitment[] = [];
    let activeTenants = 0;
    let allowanceUsd = 0;
    for (const row of tiers.results ?? []) {
      const tenants = Math.max(0, Math.trunc(finiteNumber(row.tenants) ?? 0));
      if (tenants === 0) continue;
      const tier = typeof row.tier === 'string' && row.tier ? row.tier : 'starter';
      const allowance = tenants * tierLimits(tier).monthlyCostUsd;
      activeTenants += tenants;
      allowanceUsd += allowance;
      byTier.push({ tier, tenants, allowanceUsd: round2(allowance) });
    }
    // Biggest commitment first, tier name as a stable tie break.
    byTier.sort((a, b) => b.allowanceUsd - a.allowanceUsd || a.tier.localeCompare(b.tier));

    const grantPoolUsd = Math.max(0, finiteNumber(grants?.pool) ?? 0);
    return {
      activeTenants,
      allowanceUsd: round2(allowanceUsd),
      grantPoolUsd: round2(grantPoolUsd),
      ceilingUsd: round2(allowanceUsd + grantPoolUsd),
      byTier,
    };
  } catch (error) {
    console.error(
      `billing admin: committed ceilings could not be read: ${describeError(error)}`,
    );
    degraded.push(DEGRADED_COMMITTED);
    return empty;
  }
}

/** Cap on the attention list, so one broken migration cannot return every row. */
const ATTENTION_ROW_CAP = 50;

/**
 * The two states where a tenant row and its runtime key disagree.
 *
 * Both are cheap `status`-filtered scans on a table with one row per account, so
 * neither is worth an index.
 */
async function readTenantAttention(
  db: D1Database | undefined,
  degraded: string[],
): Promise<TenantAttention> {
  if (!db) return { entitledWithoutKey: 0, retiredHoldingKey: [] };

  try {
    const [without, retired] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tenants WHERE status = 'active' AND openrouter_key_enc IS NULL",
        )
        .first<{ n: number }>(),
      db
        .prepare(
          'SELECT id, tier, status FROM tenants ' +
            "WHERE status <> 'active' AND openrouter_key_id IS NOT NULL " +
            'ORDER BY updated_at DESC LIMIT ?',
        )
        .bind(ATTENTION_ROW_CAP)
        .all<{ id: string; tier: string; status: string }>(),
    ]);

    return {
      entitledWithoutKey: Math.max(0, Math.trunc(finiteNumber(without?.n) ?? 0)),
      retiredHoldingKey: (retired.results ?? []).map((row) => ({
        id: String(row.id),
        tier: String(row.tier),
        status: String(row.status),
      })),
    };
  } catch (error) {
    console.error(`billing admin: the attention list could not be read: ${describeError(error)}`);
    degraded.push(DEGRADED_ATTENTION);
    return { entitledWithoutKey: 0, retiredHoldingKey: [] };
  }
}

// ── GET revenue ──────────────────────────────────────────────────────────────

/**
 * Collected revenue, Stripe's cut, our vendor cost, and the resulting margin -
 * all for the SAME range.
 *
 * KV-cached whole rather than per-call: the two Stripe walks are the expensive
 * part and they only move when somebody pays. A cache MISS still answers, so an
 * absent `TENANTS` binding degrades to "slower", never to "broken".
 *
 * A degraded answer is NOT cached. Caching a partial read would freeze a
 * transient Stripe failure in place for five minutes and make it look permanent.
 */
export async function buildRevenue(
  env: BillingAdminEnv,
  range: DateRange,
): Promise<BillingRevenueResponse> {
  const cacheKey = `admin:revenue:v1:${range.from}:${range.to}`;
  const cached = await readRevenueCache(env, cacheKey);
  if (cached) return cached;

  const degraded: string[] = [];
  const configured = Boolean(env.STRIPE_SECRET_KEY?.trim());

  // Stripe filters on unix seconds. `to` is INCLUSIVE of the whole day, so the
  // upper bound is the last second of it - using midnight would silently drop
  // every payment made on the final day of the selected range.
  const createdGte = Math.floor(Date.parse(`${range.from}T00:00:00.000Z`) / 1000);
  const createdLte = Math.floor(Date.parse(`${range.to}T23:59:59.999Z`) / 1000);

  const [invoiced, processing, vendorCostUsd] = await Promise.all([
    configured ? readInvoicedRevenue(env, createdGte, createdLte, degraded) : null,
    configured ? readProcessingCost(env, createdGte, createdLte, degraded) : null,
    readRangeVendorCost(env.DB, range, degraded),
  ]);

  const body: BillingRevenueResponse = {
    range,
    configured,
    invoiced,
    processing,
    margin: measureMargin(invoiced, processing, vendorCostUsd),
    degraded,
    generatedAt: new Date().toISOString(),
  };

  if (degraded.length === 0) await writeRevenueCache(env, cacheKey, body);
  return body;
}

/**
 * The margin, or null when there is no revenue figure to measure against.
 *
 * Null rather than a zeroed object: "we invoiced nothing in this range" and "we
 * made no margin" are different statements, and a card rendering 0 percent for
 * the first would be a lie about a quiet month.
 */
export function measureMargin(
  invoiced: InvoicedRevenue | null,
  processing: ProcessingCost | null,
  vendorCostUsd: number,
): MeasuredMargin | null {
  if (invoiced === null) return null;
  const processingFeeUsd = processing?.feeUsd ?? 0;
  const marginUsd = invoiced.netUsd - vendorCostUsd - processingFeeUsd;
  return {
    netUsd: round2(invoiced.netUsd),
    vendorCostUsd: round4(vendorCostUsd),
    processingFeeUsd: round2(processingFeeUsd),
    marginUsd: round2(marginUsd),
    marginPct: invoiced.netUsd > 0 ? round2((marginUsd / invoiced.netUsd) * 100) : null,
  };
}

/** The fields this module reads off a Stripe invoice. */
interface StripeInvoice {
  currency?: unknown;
  total?: unknown;
  tax?: unknown;
  total_taxes?: unknown;
}

/**
 * Paid invoices in range, summed into gross, tax and net.
 *
 * NET OF TAX IS THE MARGIN BASIS (requirement 49). Every catalogue price carries
 * `tax_behavior: 'inclusive'`, so the number a customer pays already contains the
 * tax, and that share is remitted and was never ours. `total - tax` is the only
 * figure margin may be measured against.
 *
 * TWO TAX SHAPES ARE READ, and that is not defensiveness. Stripe replaced the
 * scalar `invoice.tax` with a `total_taxes[]` breakdown, and a delivery is shaped
 * by whichever API version answers - this worker pins one, but a pinned version
 * is a claim about the request, not a guarantee about every field's history on an
 * account. Reading only one shape would silently report zero tax and inflate the
 * net, which is the failure that makes a margin figure worse than none. Same
 * precedent as the webhook reading both `invoice.subscription` shapes.
 *
 * Non-USD invoices are COUNTED AND EXCLUDED rather than summed. The catalogue is
 * USD-only today, so a non-USD invoice means something changed that this
 * arithmetic has not been taught about, and adding a euro to a dollar silently is
 * the wrong way to find out.
 */
async function readInvoicedRevenue(
  env: BillingAdminEnv,
  createdGte: number,
  createdLte: number,
  degraded: string[],
): Promise<InvoicedRevenue | null> {
  const page = await walkStripeList<StripeInvoice>(env, '/invoices', {
    status: 'paid',
    'created[gte]': createdGte,
    'created[lte]': createdLte,
  });
  if (page === null) {
    degraded.push(DEGRADED_STRIPE_INVOICES);
    return null;
  }

  let grossUsd = 0;
  let taxUsd = 0;
  let count = 0;
  let otherCurrencyCount = 0;
  for (const invoice of page.items) {
    if (String(invoice.currency ?? '').toLowerCase() !== 'usd') {
      otherCurrencyCount += 1;
      continue;
    }
    count += 1;
    grossUsd += minorToUsd(invoice.total);
    taxUsd += invoiceTaxMinorToUsd(invoice);
  }

  return {
    count,
    grossUsd: round2(grossUsd),
    taxUsd: round2(taxUsd),
    // Clamped: a credited invoice can leave tax marginally above total after
    // rounding, and a negative "net" is not a number anybody can read.
    netUsd: round2(Math.max(0, grossUsd - taxUsd)),
    otherCurrencyCount,
    truncated: page.truncated,
  };
}

/**
 * The tax on one invoice, in dollars, from whichever shape it carries.
 *
 * The scalar `tax` wins when present because it is Stripe's own total; the
 * `total_taxes[]` sum is the newer breakdown. A missing amount inside the
 * breakdown contributes 0 rather than NaN.
 */
function invoiceTaxMinorToUsd(invoice: StripeInvoice): number {
  const scalar = finiteNumber(invoice.tax);
  if (scalar !== null) return minorToUsd(scalar);
  if (!Array.isArray(invoice.total_taxes)) return 0;
  let minor = 0;
  for (const entry of invoice.total_taxes) {
    minor += finiteNumber(asRecord(entry)?.['amount']) ?? 0;
  }
  return minorToUsd(minor);
}

/** The fields this module reads off a Stripe balance transaction. */
interface StripeBalanceTransaction {
  currency?: unknown;
  fee?: unknown;
}

/**
 * What Stripe took over the range: `SUM(fee)` across balance transactions.
 *
 * Deliberately UNFILTERED by `type`. Every fee Stripe charged is a real cost,
 * including the ones on a refund or a dispute, so filtering to `charge` would
 * report a rosier number than the bank did. The count travels with it so a reader
 * can see the fee is spread over more entries than there were invoices.
 */
async function readProcessingCost(
  env: BillingAdminEnv,
  createdGte: number,
  createdLte: number,
  degraded: string[],
): Promise<ProcessingCost | null> {
  const page = await walkStripeList<StripeBalanceTransaction>(env, '/balance_transactions', {
    'created[gte]': createdGte,
    'created[lte]': createdLte,
  });
  if (page === null) {
    degraded.push(DEGRADED_STRIPE_FEES);
    return null;
  }

  let feeUsd = 0;
  let count = 0;
  let otherCurrencyCount = 0;
  for (const entry of page.items) {
    if (String(entry.currency ?? '').toLowerCase() !== 'usd') {
      otherCurrencyCount += 1;
      continue;
    }
    count += 1;
    feeUsd += minorToUsd(entry.fee);
  }

  return { count, feeUsd: round2(feeUsd), otherCurrencyCount, truncated: page.truncated };
}

/**
 * `SUM(usage.cost_usd)` over the SELECTED range, for the margin's cost side.
 *
 * Separate from {@link readMeteredBurn}, which is always the trailing 30 days:
 * runway is a question about now, margin is a question about a period, and
 * sharing one number between them would answer one of the two wrongly.
 *
 * `to` is inclusive of the whole day, so the upper bound is the day AFTER with a
 * strict `<`. Comparing `<= '2026-09-08'` against an ISO timestamp would exclude
 * every row on the final day, because `'2026-09-08T04:00:00Z' > '2026-09-08'`
 * lexicographically.
 */
async function readRangeVendorCost(
  db: D1Database | undefined,
  range: DateRange,
  degraded: string[],
): Promise<number> {
  if (!db) return 0;
  const upperExclusive = new Date(Date.parse(`${range.to}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const row = await db
      .prepare(
        'SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage ' +
          'WHERE created_at >= ? AND created_at < ?',
      )
      .bind(range.from, upperExclusive)
      .first<{ spent: number }>();
    return Math.max(0, finiteNumber(row?.spent) ?? 0);
  } catch (error) {
    console.error(
      `billing admin: the ranged vendor cost could not be read: ${describeError(error)}`,
    );
    degraded.push(DEGRADED_METERED_COST);
    return 0;
  }
}

// ── Stripe list walking ──────────────────────────────────────────────────────

interface StripeListPage<T> {
  items: T[];
  /** True when {@link STRIPE_MAX_PAGES} was hit, so `items` is a prefix. */
  truncated: boolean;
}

/**
 * Walks a paginated Stripe list to the end, or to {@link STRIPE_MAX_PAGES}.
 *
 * `null` means the walk FAILED and the caller must degrade. A partial walk that
 * hit the page cap is NOT a failure - it returns what it read with
 * `truncated: true`, because a floor on the revenue is more useful than nothing
 * and the cap only bites at a volume this deployment does not have yet.
 *
 * Cursor pagination by `starting_after` on the last id. The loop is bounded by
 * the page cap as well as by `has_more`, so a vendor that kept answering
 * `has_more: true` with the same cursor could not spin here forever.
 */
async function walkStripeList<T>(
  env: BillingAdminEnv,
  path: string,
  filters: Record<string, string | number>,
): Promise<StripeListPage<T> | null> {
  const items: T[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < STRIPE_MAX_PAGES; page += 1) {
    const result = await stripeRequest<{ data?: unknown; has_more?: unknown }>(env, path, {
      method: 'GET',
      params: {
        ...filters,
        limit: STRIPE_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
    });
    // `stripeRequest` has already logged the vendor detail and redacted the key.
    if ('status' in result) return null;

    const rows = Array.isArray(result.data.data) ? result.data.data : [];
    for (const row of rows) items.push(row as T);

    if (result.data.has_more !== true || rows.length === 0) {
      return { items, truncated: false };
    }
    const lastId = asRecord(rows[rows.length - 1])?.['id'];
    if (typeof lastId !== 'string' || !lastId) {
      // `has_more` with no cursor to follow. Report what we have rather than
      // looping on the same page forever.
      console.warn(`Stripe ${path} reported has_more with no usable cursor; stopping the walk.`);
      return { items, truncated: true };
    }
    startingAfter = lastId;
  }

  console.warn(
    `Stripe ${path} was not fully walked: the ${STRIPE_MAX_PAGES}-page cap was reached, so the ` +
      `totals derived from it are a floor.`,
  );
  return { items, truncated: true };
}

// ── The revenue cache ────────────────────────────────────────────────────────

async function readRevenueCache(
  env: BillingAdminEnv,
  cacheKey: string,
): Promise<BillingRevenueResponse | null> {
  if (!env.TENANTS) return null;
  try {
    const cached = await env.TENANTS.get(cacheKey, 'json');
    // Shape-checked rather than cast: a cache entry written by an older worker
    // version can be missing a field this version's view reads, and `undefined`
    // reaching a template renders as a blank where a number belongs.
    const record = asRecord(cached);
    if (!record || !asRecord(record['range']) || !Array.isArray(record['degraded'])) return null;
    return record as unknown as BillingRevenueResponse;
  } catch {
    // A cache miss and an unreadable cache entry are the same thing to a caller.
    return null;
  }
}

async function writeRevenueCache(
  env: BillingAdminEnv,
  cacheKey: string,
  body: BillingRevenueResponse,
): Promise<void> {
  if (!env.TENANTS) return;
  try {
    await env.TENANTS.put(cacheKey, JSON.stringify(body), {
      expirationTtl: REVENUE_CACHE_SECONDS,
    });
  } catch (error) {
    // Not worth failing a read over. The next request simply recomputes.
    console.warn(`billing admin: the revenue cache could not be written: ${describeError(error)}`);
  }
}

// ── Small readers ────────────────────────────────────────────────────────────

/**
 * Stripe's smallest-currency-unit integer as dollars.
 *
 * The ONE place this conversion happens, so no response field can accidentally
 * carry cents. Non-numeric input is 0 rather than NaN - a NaN would propagate
 * through every sum it touches and land in a response as `null`, silently
 * zeroing a real figure instead of one line item.
 */
export function minorToUsd(minor: unknown): number {
  const value = finiteNumber(minor);
  return value === null ? 0 : value / 100;
}

/** Two decimal places, for money. */
export function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Four decimal places, for figures that are legitimately sub-cent: a single
 * agent turn can cost $0.0004, and rounding a burn rate to cents would report a
 * real spend as zero.
 */
export function round4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The tiers this worker sells, with the allowance each one commits us to.
 *
 * Exported for the dashboard's benefit rather than used above: the cost view
 * shows a per-tier breakdown, and a tier with zero active tenants should still be
 * listed as a row of zeros rather than vanishing. Derived from `TIERS` so it
 * cannot drift from the entitlement model, and `usdPerCredit` travels with it
 * because the same view explains what a purchased credit is worth.
 */
export function tierCommitmentBasis(): { tier: string; allowanceUsd: number }[] {
  return Object.keys(TIERS).map((tier) => ({
    tier,
    allowanceUsd: round2(tierLimits(tier).monthlyCostUsd),
  }));
}

/** USD of real inference one purchased credit buys. Re-exported for the view. */
export const purchasedCreditUsd = usdPerCredit;
