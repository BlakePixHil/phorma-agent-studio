/**
 * One-time usage-credit top-up packs, shown in the Buy Credits dialog.
 *
 * Pack value scales with size - a bigger pack gives more credits per dollar, so
 * our margin narrows as the pack grows:
 *   Small  $10 /   500cr = $0.020/credit
 *   Medium $20 / 1,250cr = $0.016/credit
 *   Large  $40 / 2,500cr = $0.016/credit
 *
 * The real cost basis is the tier-agnostic base rate, `usdPerCredit()` in
 * `cloud/src/tenants.ts` - `TIERS.starter.monthlyCostUsd / monthlyCredits`, or
 * $0.004/credit - so a top-up costs the same to fulfil whatever tier the buyer is
 * on, and pack margin moves with the starter economics rather than drifting away
 * from them (requirement 8).
 *
 * PRICES ARE TAX INCLUSIVE, matching `tax_behavior: 'inclusive'` on every Stripe
 * price, so the number here is the number the customer pays in every
 * jurisdiction. That means margin has to be computed on NET revenue, and at a 10
 * percent GST rate it lands at:
 *
 *   Small  $9.09 net vs $2.00 basis  = 78.0%
 *   Medium $18.18 net vs $5.00 basis = 72.5%
 *   Large  $36.36 net vs $10.00 basis = 72.5%
 *
 * Medium and Large therefore sit 2.5 points UNDER the documented 75 percent
 * floor. That is an open pricing decision, not an oversight - see task 9.2a in
 * `.kiro/specs/stripe-billing/tasks.md`, which blocks creating the live Stripe
 * prices until it is settled (accept 72.5 percent, or cut the two packs to
 * roughly 1,100 and 2,200 credits). The figures above are the worst case: a pack
 * sold into a jurisdiction where we charge no tax returns the full gross margin.
 *
 * TRADEOFF (intentional, per product decision 2026-07-12): the Medium and Large
 * packs land at $0.016/credit, BELOW the $0.02/credit subscription rate, so a
 * Starter plan plus repeated top-ups is cheaper per credit than upgrading a tier.
 * Upgrading still wins on the non-credit limits (concurrency, schedules, run
 * cap), but the pure per-credit upgrade incentive is softened here in favour of
 * more generous top-up value.
 *
 * Purchasing is LIVE: each pack maps to a Stripe lookup key through
 * `topupLookupKey()` in `billing.service.ts`, and `CreditsDialog` gates the action
 * on an active subscription (requirement 26).
 */
export interface CreditPack {
  id: 'small' | 'medium' | 'large';
  label: string;
  /** Displayed price in USD, tax inclusive. */
  priceUsd: number;
  credits: number;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'small', label: 'Small', priceUsd: 10, credits: 500 },
  { id: 'medium', label: 'Medium', priceUsd: 20, credits: 1250 },
  { id: 'large', label: 'Large', priceUsd: 40, credits: 2500 },
];
