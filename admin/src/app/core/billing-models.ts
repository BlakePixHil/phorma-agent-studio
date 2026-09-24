import type { DateRange } from './models';

/**
 * `/api/admin/billing/*` response shapes, as the dashboard sees them.
 *
 * STRUCTURAL TWIN of `cloud/src/billing-admin.ts` - declared independently, with
 * nothing imported across the package boundary, the same arrangement as
 * `models.ts` and `cloud/src/telemetry-admin.ts`. Changing a shape on one side
 * without the other compiles in one package and breaks the other, so the two
 * files are edited together.
 *
 * UNLIKE `models.ts`, these bodies deliberately NAME TENANTS. The telemetry
 * aggregates carry no install identifier by construction and fold small groups for
 * anonymity; this surface reports identified paying accounts, because "which
 * account is cancelled but still holding a live key" is not actionable without the
 * id. Two opposite privacy contracts, which is exactly why they are two route
 * families and two model files rather than one of each.
 *
 * EVERY USD FIGURE IS A NUMBER OF DOLLARS, never minor units. The Worker converts
 * Stripe's cents once at its own boundary so nothing here has to remember which
 * field is which.
 *
 * A NULL IS NOT A ZERO anywhere in this file. `balanceUsd: null` means the
 * OpenRouter read failed; `balanceUsd: 0` means the account is empty. A view that
 * renders those the same way turns a vendor blip into a false emergency, so every
 * nullable field below is annotated with what its null means.
 */

// --- costs -----------------------------------------------------------------

/** What the OpenRouter account holds. Every figure null when it could not be read. */
export interface VendorBalance {
  /** Whether the Worker has a provisioning key at all. False on a BYO deployment. */
  configured: boolean;
  /** Whether the read succeeded. False with `configured` true is a vendor problem. */
  reachable: boolean;
  /** Lifetime credits purchased onto the account. Null when unknown. */
  purchasedUsd: number | null;
  /** Lifetime spend against them. Null when unknown. */
  spentUsd: number | null;
  /** What is left to draw down. NULL MEANS UNKNOWN, never empty. */
  balanceUsd: number | null;
}

/** One UTC day of metered spend inside the burn window. */
export interface BurnDay {
  day: string;
  usd: number;
}

/** Burn rate over a trailing window, and the runway it implies. */
export interface BurnRate {
  /** The trailing window, in days. Always 30 today; stated so a view need not assume. */
  windowDays: number;
  /** Our own metered OpenRouter spend over the window, from the usage ledger. */
  meteredUsd: number;
  perDayUsd: number;
  /** Null when the balance is unknown or nothing was spent - never "infinite". */
  runwayDays: number | null;
  /**
   * The window per UTC day, ascending and zero-filled. Optional here only because
   * this dashboard can deploy ahead of a Worker that does not send it yet.
   */
  daily?: BurnDay[];
}

/** One tier's contribution to the committed ceiling. */
export interface TierCommitment {
  tier: string;
  tenants: number;
  allowanceUsd: number;
}

/** What active tenants may spend - also the sum of every live OpenRouter key limit. */
export interface CommittedCeiling {
  activeTenants: number;
  allowanceUsd: number;
  /** Unspent purchased grants held by ACTIVE tenants. Grants raise the ceiling. */
  grantPoolUsd: number;
  ceilingUsd: number;
  /**
   * `balance / ceiling`. Below 1 means a fully-spending month would run the
   * account dry. Null when the balance is unknown or nothing is committed.
   */
  coverageRatio: number | null;
}

/** A tenant whose row and whose runtime key disagree about entitlement. */
export interface TenantAttentionRow {
  id: string;
  tier: string;
  status: string;
}

/** The two disagreements worth an operator's time. */
export interface TenantAttention {
  /** Active tenants with no usable key - every run of theirs fails `no_runtime_key`. */
  entitledWithoutKey: number;
  /**
   * Non-active tenants still carrying a key hash.
   *
   * NOT by itself a leak: the Worker patches the vendor on cancellation but
   * deliberately does not null the columns, so a populated hash is the expected
   * steady state afterwards. It is the list to spot-check against the OpenRouter
   * dashboard, because no code path here can confirm the patch landed.
   */
  retiredHoldingKey: TenantAttentionRow[];
}

/** `GET costs` - what we are spending and what we have promised. */
export interface BillingCostsResponse {
  vendor: VendorBalance;
  burn: BurnRate;
  committed: CommittedCeiling & { byTier: TierCommitment[] };
  attention: TenantAttention;
  /** Names of the halves that could not be computed. Empty on a clean read. */
  degraded: string[];
  generatedAt: string;
}

// --- revenue ---------------------------------------------------------------

/** What Stripe invoiced over the range. */
export interface InvoicedRevenue {
  count: number;
  /** What customers paid, tax included - every catalogue price is tax inclusive. */
  grossUsd: number;
  /** The tax carved out and remitted. Never ours. */
  taxUsd: number;
  /** `gross - tax`. The margin basis. */
  netUsd: number;
  /** Invoices in another currency, NOT included in the totals above. */
  otherCurrencyCount: number;
  /** True when the page cap was hit, so the totals are a floor. */
  truncated: boolean;
}

/** What Stripe took to process it. */
export interface ProcessingCost {
  count: number;
  feeUsd: number;
  otherCurrencyCount: number;
  truncated: boolean;
}

/** The margin, measured rather than asserted. */
export interface MeasuredMargin {
  netUsd: number;
  /** Our metered OpenRouter spend over the SAME range. */
  vendorCostUsd: number;
  processingFeeUsd: number;
  marginUsd: number;
  /** Null when there was no revenue - which is not the same as 0 percent. */
  marginPct: number | null;
}

/** `GET revenue` - what came in, what it cost, and what was left. */
export interface BillingRevenueResponse {
  range: DateRange;
  /** Whether the Worker has a Stripe key. False on a BYO deployment. */
  configured: boolean;
  /** Null when Stripe is unconfigured or the read failed. */
  invoiced: InvoicedRevenue | null;
  processing: ProcessingCost | null;
  margin: MeasuredMargin | null;
  degraded: string[];
  generatedAt: string;
}

export type BillingResponse = BillingCostsResponse | BillingRevenueResponse;

/**
 * The billing routes, in the order the view fetches them.
 *
 * A tuple rather than a loose string union so the nav, the router and the API
 * client can all derive from it - the same property `TELEMETRY_ROUTES` gives the
 * telemetry half, where adding a route without a nav entry cannot compile.
 */
export const BILLING_ROUTES = ['costs', 'revenue'] as const;

export type BillingRoute = (typeof BILLING_ROUTES)[number];

/**
 * The dashboard view id (and URL segment) for the cost surface.
 *
 * Deliberately NOT one of `BILLING_ROUTES`: the view fetches BOTH of them, so
 * naming it `costs` would make one word mean two things - a URL segment and one of
 * the two API routes behind it. `spend` is the view; `costs` and `revenue` are what
 * it reads.
 */
export const BILLING_VIEW_ID = 'spend';

/** Marker the Worker uses for the OpenRouter half of `degraded`. Twin constant. */
export const DEGRADED_VENDOR_BALANCE = 'openrouter-balance';

/** Marker for the usage-ledger half of `degraded`. Twin constant. */
export const DEGRADED_METERED_COST = 'metered-cost';
