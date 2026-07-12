/**
 * One-time usage-credit top-up packs, shown in the Buy Credits dialog.
 *
 * Pack value scales with size — bigger packs give more credits per dollar
 * (smaller margin for us):
 *   Small  $10 / 500cr   = $0.020/credit  → 80% margin
 *   Medium $20 / 1,250cr = $0.016/credit  → 75% margin
 *   Large  $40 / 2,500cr = $0.016/credit  → 75% margin
 * Real cost basis is the tier-agnostic base rate ($0.004/credit — the same
 * rate `starter` uses with no volume bonus), so a top-up costs the same to
 * fulfil regardless of the buyer's subscription tier. All packs stay within
 * the 75-80% margin target.
 *
 * TRADEOFF (intentional, per product decision 2026-07-12): the Medium/Large
 * packs land at $0.016/credit — BELOW the $0.02/credit subscription rate — so
 * a Starter sub + repeated top-ups is cheaper per credit than upgrading a
 * tier. Upgrading still wins on the non-credit limits (concurrency, schedules,
 * run cap), but the pure per-credit upgrade incentive is softened here in
 * favour of more generous top-up value.
 *
 * NOTE: Payments are not wired up yet — see `CreditsDialog`. Purchasing is a
 * placeholder ("Coming soon") until billing lands.
 */
export interface CreditPack {
  id: 'small' | 'medium' | 'large';
  label: string;
  priceUsd: number;
  credits: number;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'small', label: 'Small', priceUsd: 10, credits: 500 },
  { id: 'medium', label: 'Medium', priceUsd: 20, credits: 1250 },
  { id: 'large', label: 'Large', priceUsd: 40, credits: 2500 },
];
