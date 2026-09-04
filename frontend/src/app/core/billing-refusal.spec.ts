/**
 * The refusal classifier - the thing requirement 19 exists to make impossible to
 * get wrong, and requirement 20 exists to keep working during deploy lag.
 *
 * Both paths are pinned here, because either one silently dying is invisible:
 * a code path that stopped mapping would just show no CTA, and a prose fallback
 * that stopped matching would only fail against a worker nobody in the office is
 * running.
 *
 * _Requirements: 19, 20_
 */

import { ModelRequestError } from '@phorma/engine';

import {
  HOSTED_REFUSAL_REMEDIES,
  isCreditsError,
  refusalNotice,
  remedyForModelError,
  remedyForRefusalCode,
  remedyForRunFailure,
  type BillingRemedy,
} from './billing-refusal';

/** The five tokens `cloud/src/tenants.ts` sends today, as an append-only set. */
const WIRE_CODES = [
  'no_subscription',
  'subscription_past_due',
  'runs_exhausted',
  'credits_exhausted',
  'no_runtime_key',
] as const;

describe('remedyForRefusalCode', () => {
  it('maps every code the worker can send to a remedy', () => {
    for (const code of WIRE_CODES) {
      expect(remedyForRefusalCode(code)).withContext(code).not.toBeNull();
      expect(remedyForRefusalCode(code)).withContext(code).not.toBe('none');
    }
    // No extra keys: an entry here that the worker does not send is dead code
    // pretending to be a contract.
    expect(Object.keys(HOSTED_REFUSAL_REMEDIES).sort()).toEqual([...WIRE_CODES].sort());
  });

  it('sends a past-due tenant to the card and never to a purchase', () => {
    // The expensive mistake: "subscribing" again buys a SECOND Stripe
    // subscription instead of fixing the first one (requirement 17).
    expect(remedyForRefusalCode('subscription_past_due')).toBe('update-card');
  });

  it('keeps the four other codes on their own remedy', () => {
    expect(remedyForRefusalCode('credits_exhausted')).toBe('buy-credits');
    expect(remedyForRefusalCode('no_subscription')).toBe('subscribe');
    expect(remedyForRefusalCode('runs_exhausted')).toBe('upgrade-plan');
    expect(remedyForRefusalCode('no_runtime_key')).toBe('contact-support');
  });

  it('answers null for an absent code, so the caller falls back to prose', () => {
    expect(remedyForRefusalCode(undefined)).toBeNull();
    expect(remedyForRefusalCode(null)).toBeNull();
    expect(remedyForRefusalCode('')).toBeNull();
  });

  it('offers nothing for a token from a NEWER worker, rather than guessing', () => {
    // The token set is append-only and `RunFailureCode` is `string` precisely so
    // a studio built today can carry tomorrow's token. Carrying it must not mean
    // falling through to prose: a future `card_expired` whose message says
    // "subscription" would then resolve to a top-up.
    expect(remedyForRefusalCode('card_expired')).toBe('none');
    expect(remedyForRefusalCode('constructor')).toBe('none');
    expect(remedyForRefusalCode('toString')).toBe('none');
  });
});

describe('remedyForModelError (the builder and chat path)', () => {
  /** What `ModelTransportService` throws for a coded 402 from `/api/infer`. */
  function refusal(status: number, message: string, code?: string): ModelRequestError {
    return new ModelRequestError(
      `Phorma Cloud request failed (${status}): ${message}`,
      status,
      code,
    );
  }

  it('branches on the code, even when the prose says something else', () => {
    // The whole point. This message matches the historical
    // `/\(402\)|credits exhausted|subscription/i` regex, which would have said
    // "Buy credits"; the code says the card failed.
    const error = refusal(
      402,
      'Your last Phorma Cloud payment failed. Update your card in Settings > Cloud to resume hosted runs.',
      'subscription_past_due',
    );

    expect(remedyForModelError(error)).toBe('update-card');
  });

  it('still resolves a CODE-LESS refusal through the old prose (requirement 20)', () => {
    // A deployed worker older than the code field. Byte-identical to the prose
    // the pre-code studio matched, and it must still reach a CTA.
    expect(remedyForModelError(refusal(402, 'Monthly credits exhausted (500 credits).'))).toBe(
      'buy-credits',
    );
    expect(
      remedyForModelError(
        refusal(402, 'No active Phorma Cloud subscription. Visit Settings > Cloud to subscribe.'),
      ),
    ).toBe('buy-credits');
    // A bare `(402)` with no recognisable words was in the old regex too.
    expect(remedyForModelError(new Error('Request failed (402)'))).toBe('buy-credits');
  });

  it('offers nothing for an ordinary failure', () => {
    expect(remedyForModelError(new Error('Ollama is not running on port 11434.'))).toBe('none');
    expect(remedyForModelError(refusal(500, 'Upstream provider error.'))).toBe('none');
    expect(remedyForModelError('a thrown string')).toBe('none');
  });
});

describe('remedyForRunFailure (the run-failed path)', () => {
  const PAST_DUE_PROSE =
    'Phorma Cloud request failed (402): Your last Phorma Cloud payment failed. Update your card.';

  it('branches on the forwarded code', () => {
    expect(remedyForRunFailure(PAST_DUE_PROSE, 'subscription_past_due')).toBe('update-card');
    expect(remedyForRunFailure('anything at all', 'runs_exhausted')).toBe('upgrade-plan');
  });

  it('falls back to its own narrower prose when no code arrived', () => {
    expect(
      remedyForRunFailure('Phorma Cloud request failed (402): Monthly credits exhausted.'),
    ).toBe('buy-credits');
  });

  it('keeps the run-failed fallback NARROW, unlike the builder one', () => {
    // A `run-failed` message is arbitrary text from anywhere in a workflow, so
    // a data node whose HTTP error body mentions a subscription must not raise a
    // billing toast over a run. This is why the two fallbacks differ and why
    // neither was "unified" into the broader one.
    expect(remedyForRunFailure('GET /subscriptions failed (402): quota')).toBe('none');
    expect(isCreditsError('GET /subscriptions failed (402): quota')).toBeTrue();
  });
});

describe('refusalNotice', () => {
  it('gives every actionable remedy a label, and the internal fault none', () => {
    const labelled: BillingRemedy[] = [
      'buy-credits',
      'update-card',
      'subscribe',
      'upgrade-plan',
    ];
    for (const remedy of labelled) {
      expect(refusalNotice(remedy)?.label).withContext(remedy).toBeTruthy();
    }
    // Entitled, paid, and missing a runtime key: our fault, so no purchase.
    const support = refusalNotice('contact-support');
    expect(support?.label).toBeNull();
    expect(support?.detail).toContain('nothing to buy');
    expect(refusalNotice('none')).toBeNull();
  });

  it('never names a dollar figure, per the credits-not-dollars rule', () => {
    for (const remedy of Object.values(HOSTED_REFUSAL_REMEDIES)) {
      const notice = refusalNotice(remedy);
      expect(`${notice?.summary} ${notice?.detail}`).withContext(remedy).not.toMatch(/\$\d/);
    }
  });

  it('keeps a wire token out of user-facing copy', () => {
    for (const code of WIRE_CODES) {
      const notice = refusalNotice(remedyForRefusalCode(code) ?? 'none');
      expect(`${notice?.summary} ${notice?.detail} ${notice?.label}`)
        .withContext(code)
        .not.toContain(code);
    }
  });
});
