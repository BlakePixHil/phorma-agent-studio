/**
 * Turning a hosted entitlement refusal into the ONE thing the user should do
 * next (requirements 19, 20).
 *
 * ## Why a code at all, and why the prose stays
 *
 * The gate in `cloud/src/tenants.ts` refuses a hosted run with a message AND a
 * stable machine token. Before that token existed, the studio recovered the
 * remedy by matching the message - `/credits exhausted/i` in the run controller,
 * `/\(402\)|credits exhausted|subscription/i` in the builder - so rewording a
 * worker error string silently deleted a purchase CTA. Requirement 19 is that
 * defect: branch on the code, never on prose.
 *
 * Requirement 20 is why the prose match is still here anyway. A DEPLOYED worker
 * can be older than the studio reading it, and an older worker sends no code at
 * all, so a consumer resolves the code FIRST and falls back to its historical
 * regex when there is none. Both paths are live on purpose; neither may be
 * deleted while a worker in the wild may predate the field.
 *
 * ## Why an unrecognised code does NOT fall back to prose
 *
 * The token set is append-only, and `RunFailureCode` is deliberately `string`
 * rather than the closed union, so a studio built today must be able to CARRY a
 * token added to the worker tomorrow. A code we do not recognise therefore means
 * "a newer worker refused this for a reason this build has no CTA for" - it does
 * not mean "no code". Falling through to prose there would let a future
 * `card_expired`, whose message reasonably contains the word "subscription",
 * resolve to Buy credits. So an unknown token answers {@link BillingRemedy}
 * `'none'`: the message is shown, and nothing is sold.
 *
 * ## Why the remedies are not interchangeable
 *
 * Each refusal is one button apart from the others and the wrong button is worse
 * than no button:
 *
 *  - `credits_exhausted` - the allowance and every purchased grant are gone. A
 *    top-up is the remedy, which is the pre-existing behaviour.
 *  - `subscription_past_due` - a LIVE subscription whose last invoice failed.
 *    The remedy is the card, through the Billing Portal. Never Buy credits (they
 *    have credits) and never Subscribe (requirement 17): "subscribing" again
 *    creates a SECOND Stripe subscription rather than fixing the first.
 *  - `no_subscription` - no plan. Subscribe, which means the plan cards, because
 *    a toast cannot know which tier they want.
 *  - `runs_exhausted` - the tier's monthly RUN COUNT is gone. This is the one
 *    refusal that is not a purchase problem: it is a 429, not a 402, and the
 *    primary remedy is the monthly reset, which costs nothing and needs no
 *    action. So it earns a deep link to the plan cards and never a checkout -
 *    the copy leads with the reset and offers the upgrade as the way to lift the
 *    limit NOW, rather than presenting a purchase as the only exit.
 *  - `no_runtime_key` - entitled, paid, and missing an OpenRouter key. An
 *    internal fault, so it must offer no purchase whatsoever. It still gets a
 *    notice, because the alternative is a paying user reading a billing-shaped
 *    error in the console and concluding their payment failed; the copy says
 *    there is nothing to buy and points at support.
 */

import { failureCodeOf } from '@phorma/engine';

/** What the studio should offer in response to a hosted refusal. */
export type BillingRemedy =
  | 'buy-credits'
  | 'update-card'
  | 'subscribe'
  | 'upgrade-plan'
  | 'contact-support'
  /** Not a refusal we have an answer for. Show the message, offer nothing. */
  | 'none';

/**
 * The code-to-remedy map, keyed by `HostedInferenceRefusalCode` from
 * `cloud/src/tenants.ts`.
 *
 * A plain record and not a union-keyed one on purpose: the wire contract is
 * append-only and the studio must accept a token it has never heard of, so the
 * lookup has to be total over `string`. Read through `hasOwnProperty`, or
 * `'constructor'` resolves to an inherited value.
 */
export const HOSTED_REFUSAL_REMEDIES: Readonly<Record<string, BillingRemedy>> = {
  no_subscription: 'subscribe',
  subscription_past_due: 'update-card',
  runs_exhausted: 'upgrade-plan',
  credits_exhausted: 'buy-credits',
  no_runtime_key: 'contact-support',
};

/**
 * The remedy a refusal code earns, or null when there is no code and the caller
 * should fall back to its own prose match (requirement 20).
 *
 * Note the two different nulls this deliberately does not conflate: ABSENT means
 * "ask the prose", UNRECOGNISED means `'none'` - see the file header.
 */
export function remedyForRefusalCode(code: string | null | undefined): BillingRemedy | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(HOSTED_REFUSAL_REMEDIES, code)
    ? HOSTED_REFUSAL_REMEDIES[code]
    : 'none';
}

/**
 * The builder and chat prose fallback, character for character what
 * `isCreditsError` matched before the code existed.
 *
 * Broader than the run controller's: it also fires on a bare `(402)` and on the
 * word "subscription", which is how a `no_subscription` refusal used to reach a
 * CTA at all. Kept exactly as-is rather than "improved", because requirement 20
 * is about a CTA not DISAPPEARING during deploy lag - a fallback that classifies
 * differently from the code path is a second behaviour to reason about, and the
 * code path already covers everything a new worker sends.
 */
const CREDITS_ERROR_PROSE = /\(402\)|credits exhausted|subscription/i;

/**
 * The run controller's prose fallback, also unchanged.
 *
 * Narrower on purpose, and it must stay narrow: a `run-failed` message is
 * arbitrary text from anywhere in a workflow, so a data node whose HTTP error
 * body happens to say "subscription" must not raise a billing toast over a run.
 */
const CREDITS_EXHAUSTED_PROSE = /credits exhausted/i;

/** True when a model error message reads as a credits or subscription problem. */
export function isCreditsError(message: string): boolean {
  return CREDITS_ERROR_PROSE.test(message);
}

/**
 * Classifies a thrown model error - the builder and assistant chat path, where
 * the failure is still the `ModelRequestError` the transport threw and therefore
 * still carries its code.
 */
export function remedyForModelError(error: unknown): BillingRemedy {
  const coded = remedyForRefusalCode(failureCodeOf(error));
  if (coded !== null) return coded;
  const message = error instanceof Error ? error.message : String(error);
  return isCreditsError(message) ? 'buy-credits' : 'none';
}

/**
 * Classifies a terminal `run-failed` event - the run controller path, where the
 * original error is long gone and only the message plus the forwarded code
 * survive.
 */
export function remedyForRunFailure(message: string, code?: string | null): BillingRemedy {
  const coded = remedyForRefusalCode(code);
  if (coded !== null) return coded;
  return CREDITS_EXHAUSTED_PROSE.test(message) ? 'buy-credits' : 'none';
}

/** What a surface renders for a remedy: a headline, a body, and maybe a button. */
export interface RefusalNotice {
  /** Toast summary, or the heading of an inline notice. */
  readonly summary: string;
  readonly detail: string;
  /** The button label, or null when there is nothing for the user to press. */
  readonly label: string | null;
}

/**
 * The copy for a remedy, or null when the failure earns no billing notice at
 * all.
 *
 * Copy lives here rather than at the call sites so the toast, the Ctrl+P palette
 * and the chat cannot drift into three different answers for the same refusal.
 * Every string obeys the credits-not-dollars rule: a remedy is described in
 * credits, plans and cards, never in a dollar figure.
 */
export function refusalNotice(remedy: BillingRemedy): RefusalNotice | null {
  switch (remedy) {
    case 'buy-credits':
      // Unchanged from the pre-code toast, deliberately: this is the one path
      // that already worked and users have already seen.
      return {
        summary: 'Monthly credits exhausted',
        detail: 'Resets next month, or top up now.',
        label: 'Buy credits',
      };
    case 'update-card':
      // Requirement 18 keeps the tier, the data and the runtime key, so the copy
      // has to say so - a user who reads "runs are paused" and assumes their
      // workflows are gone is the failure this sentence exists to prevent.
      return {
        summary: 'Phorma Cloud payment failed',
        detail: 'Your plan, workflows and credits are all still here. Update your card to resume hosted runs.',
        label: 'Update card',
      };
    case 'subscribe':
      return {
        summary: 'No active Phorma Cloud subscription',
        detail: 'Pick a plan to run agents on Phorma Cloud credits.',
        label: 'View plans',
      };
    case 'upgrade-plan':
      // Reset first, upgrade second. A 429 is not a payment failure and the
      // cheapest correct answer is to wait.
      return {
        summary: 'Monthly run limit reached',
        detail: 'Resets next month. A higher plan lifts the limit straight away.',
        label: 'View plans',
      };
    case 'contact-support':
      return {
        summary: 'Hosted runs are unavailable',
        detail:
          'Your plan is active but its hosted runtime key is missing. There is nothing to buy - contact support and we will re-provision it.',
        label: null,
      };
    case 'none':
      return null;
  }
}
