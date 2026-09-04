/**
 * The self-serve subscription plans, as the studio DISPLAYS them.
 *
 * This is a presentation catalogue, not an authority. `TIERS` in
 * `cloud/src/tenants.ts` decides what a tier is allowed to do and Stripe decides
 * what it costs; the numbers below only have to agree with them. They are
 * duplicated here rather than fetched because the plan cards must render for a
 * signed-out or unprovisioned visitor, who has no `/api/me` to read - a card
 * grid that is blank until a request lands is worse than one that is a few
 * minutes stale after a repricing.
 *
 * Two invariants worth keeping:
 *
 *  - `priceUsd` is TAX INCLUSIVE, matching `tax_behavior: 'inclusive'` on every
 *    Stripe price. The number here is the number the customer pays in every
 *    jurisdiction, so it never needs a "+ tax" qualifier.
 *  - A price is the only dollar figure allowed on these cards. Everything about
 *    USAGE renders in credits, per the credits-not-dollars product rule, which
 *    is why `credits` is a plain count and no USD budget appears at all.
 *
 * `enterprise` carries `priceUsd: null` and that is the whole mechanism behind
 * requirement 9: it has no Stripe price, `subscriptionLookupKey('enterprise')`
 * answers null, and the card therefore cannot render a Choose action even by
 * accident. Contact sales is the only affordance it has.
 */

/** One plan, as a card. */
export interface PlanCard {
  /** Tier id as `/api/me` reports it, so a card can match the current plan. */
  readonly tier: string;
  /** Marketing name. Mirrors `tierLabel()` rather than re-deriving it. */
  readonly label: string;
  /** Displayed monthly price in USD, tax inclusive. Null when sales-led. */
  readonly priceUsd: number | null;
  /** Monthly usage-credit allowance. Null when negotiated. */
  readonly credits: number | null;
  /** Monthly run cap. Null when negotiated. */
  readonly runs: number | null;
  /** Concurrent hosted runs. Null when negotiated. */
  readonly concurrentRuns: number | null;
  /** One line on who the plan is for. */
  readonly blurb: string;
}

/**
 * Ascending by price, which is also the order the cards render in. Enterprise
 * sits last with no price.
 */
export const PLAN_CARDS: readonly PlanCard[] = [
  {
    tier: 'starter',
    label: 'Starter',
    priceUsd: 20,
    credits: 1000,
    runs: 300,
    concurrentRuns: 1,
    blurb: 'Everything you need to run real agents on your own.',
  },
  {
    tier: 'pro',
    label: 'Pro',
    priceUsd: 60,
    credits: 3000,
    runs: 2000,
    concurrentRuns: 3,
    blurb: 'More headroom, more schedules, more published portals.',
  },
  {
    tier: 'team',
    label: 'Teams',
    priceUsd: 200,
    credits: 10000,
    runs: 10000,
    concurrentRuns: 10,
    blurb: 'Team-scale volume and concurrency for shared workflows.',
  },
  {
    tier: 'enterprise',
    label: 'Enterprise',
    priceUsd: null,
    credits: null,
    runs: null,
    concurrentRuns: null,
    blurb: 'Custom volume, SSO and a support agreement.',
  },
];

/**
 * The tier a context-free "Subscribe" CTA buys.
 *
 * The five upsell CTAs around the studio (the model picker, the agent config
 * panel, the Ctrl+P builder, the assistant composer) sit in surfaces with no
 * room to compare plans, so they cannot ask which one the user wants. They buy
 * the ENTRY plan and pair with a secondary "See all plans" link to the plan
 * cards, which is the honest split: the fast path is one click, the considered
 * path is one click away, and Stripe's own page names the plan and the price
 * before any card is charged.
 */
export const ENTRY_PLAN_TIER = 'starter';

/**
 * Where Enterprise goes. Not a Stripe URL: this plan is sales-led by design
 * (requirement 9), so the action is a conversation, not a checkout.
 */
export const CONTACT_SALES_URL = 'https://phorma-labs.com/contact';
