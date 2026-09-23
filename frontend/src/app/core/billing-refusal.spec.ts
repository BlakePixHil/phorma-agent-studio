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

import fc from 'fast-check';

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
import { notificationFromRun } from './notification-projection';
import type { NoticeRun } from './notifications.model';

/**
 * Every token the worker sends that earns a remedy, as an append-only set.
 *
 * Five come from the entitlement gate in `cloud/src/tenants.ts`. `billing_managed`
 * is the odd one out: it comes off `/api/checkout` and `/api/billing-portal` in
 * `cloud/src/api.ts` when the active owner is an organisation, which Phorma Labs
 * invoices (multi-organisation-phorma, Requirement 19.4). It is in the same map
 * because the map is the ONE place a code becomes a remedy - two maps is how a code
 * ends up with two answers.
 */
const WIRE_CODES = [
  'no_subscription',
  'subscription_past_due',
  'runs_exhausted',
  'credits_exhausted',
  'no_runtime_key',
  'billing_managed',
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

  it('offers a managed organisation nothing to buy (Requirement 19.4)', () => {
    // Not `subscribe`, not `buy-credits`: an organisation's plan and credits are
    // Phorma Labs' to change, and every purchase surface is ABSENT for that owner.
    expect(remedyForRefusalCode('billing_managed')).toBe('contact-support');
    expect(refusalNotice('contact-support', 'billing_managed')?.label).toBeNull();
  });

  it('gives the two contact-support codes two different sentences', () => {
    // They share the remedy (no button) and not the cause. `no_runtime_key` is an
    // internal fault on a paid account; `billing_managed` means the account is fine
    // and somebody else pays for it. Telling an organisation member their runtime key
    // is missing would send them chasing a fault that does not exist.
    const runtimeKey = refusalNotice('contact-support');
    const managed = refusalNotice('contact-support', 'billing_managed');

    expect(runtimeKey?.detail).toContain('runtime key');
    expect(managed?.detail).not.toContain('runtime key');
    expect(managed?.summary).toContain('Phorma Labs');
    // An absent code reads as the runtime-key case, which is the only one that has
    // ever reached a run.
    expect(refusalNotice('contact-support', null)?.detail).toBe(runtimeKey?.detail);
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

/**
 * Property 34, the studio half of multi-organisation-phorma Requirement 15.
 *
 * The worker's Refusal_Code set is append-only, and task 14 appends one
 * (`workflow_not_entitled`) that nothing returns yet. That only stays safe if a
 * studio meeting a token it has never heard of RENDERS the sentence the worker
 * served and offers nothing - so this is the assertion that makes appending a token
 * a worker-only change.
 *
 * Two things the property is careful about:
 *
 *  - The prose the generator builds is made of exactly the words the historical
 *    regexes match (`credits exhausted`, `subscription`, `(402)`). A code we do not
 *    recognise must NOT fall through to that prose - it means "a newer worker
 *    refused this for a reason this build has no CTA for", not "no code" - so
 *    generating innocent prose would let a fall-through implementation pass.
 *  - The claim reaches a SURFACE, not only the classifier. `notificationFromRun` is
 *    the row a user actually reads, so the pin is that its detail IS the served
 *    prose and that it carries no remedy - a classifier returning `'none'` while the
 *    row came back null would be a blank feed, which is the failure this property is
 *    named after.
 *
 * **Validates: Requirements 15.5**
 */
describe('an unrecognised refusal code', () => {
  /** The words the pre-code studio matched on, so prose fall-through is visible. */
  const prose = fc
    .array(
      fc.constantFrom(
        'credits',
        'exhausted',
        'subscription',
        '(402)',
        'payment',
        'failed',
        'plan',
        'card',
      ),
      { minLength: 1, maxLength: 8 },
    )
    .map(words => words.join(' '));

  /**
   * Any code string this build does not know. The named ones are the cases that
   * have actually bitten something: the token task 14 RESERVES, a plausible future
   * one, prototype keys (the map is read through `hasOwnProperty` for these), and
   * near-misses of real tokens.
   */
  const unrecognised = fc
    .oneof(
      fc.constantFrom(
        'workflow_not_entitled',
        'card_expired',
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        'valueOf',
        'CREDITS_EXHAUSTED',
        ' credits_exhausted',
        'no_subscription_v2',
      ),
      fc.string({ minLength: 1, maxLength: 24 }),
    )
    .filter(code => code.length > 0 && !(WIRE_CODES as readonly string[]).includes(code));

  // Feature: multi-organisation-phorma, Property 34: An unrecognised refusal code renders rather than breaking a surface
  it('renders the served prose and offers nothing, for any code and any prose', () => {
    fc.assert(
      fc.property(unrecognised, prose, (code, message) => {
        // The classifier: recognised as "a code, just not one of ours". Never null,
        // which would send the caller to its prose fallback.
        expect(remedyForRefusalCode(code)).withContext(code).toBe('none');
        expect(remedyForRunFailure(message, code)).withContext(`${code} / ${message}`).toBe('none');
        expect(remedyForModelError(new ModelRequestError(message, 402, code))).toBe('none');
        // Nothing is sold, and nothing invents copy of its own.
        expect(refusalNotice(remedyForRunFailure(message, code), code)).toBeNull();

        // The surface. The row renders, its detail is the sentence the worker
        // served, and it carries no remedy - so a user reads the refusal and is
        // offered no button for a reason this build cannot explain.
        const failed: NoticeRun = {
          runId: 'cloudrun-34',
          status: 'failed',
          source: 'schedule',
          startedAt: 1_000,
          endedAt: 2_000,
          error: message,
          code,
        };
        const entry = notificationFromRun(failed, 'wf-34', 'Invoice triage');

        expect(entry).withContext(`${code} / ${message}`).not.toBeNull();
        expect(entry?.detail).toBe(message);
        expect(entry?.remedy).toBeUndefined();
        expect(entry?.title.length).toBeGreaterThan(0);
      }),
      { numRuns: 150 },
    );
  });

  // Feature: multi-organisation-phorma, Property 34: An unrecognised refusal code renders rather than breaking a surface
  it('treats the token task 14 reserves exactly like any other unknown one', () => {
    // Named on its own because it is the one token this release adds to the worker's
    // union while deliberately never sending it (Requirement 15.4). The studio must
    // have no entry for it: an entry here would be a CTA for a refusal that cannot
    // happen, and `HOSTED_REFUSAL_REMEDIES` is asserted above to hold no such key.
    expect(Object.keys(HOSTED_REFUSAL_REMEDIES)).not.toContain('workflow_not_entitled');
    expect(remedyForRefusalCode('workflow_not_entitled')).toBe('none');
    expect(refusalNotice('none', 'workflow_not_entitled')).toBeNull();

    const entry = notificationFromRun(
      {
        runId: 'cloudrun-reserved',
        status: 'failed',
        source: 'webhook',
        startedAt: 1,
        endedAt: 2,
        error: 'This workflow is not included in your plan.',
        code: 'workflow_not_entitled',
      },
      'wf-34',
      'Invoice triage',
    );

    expect(entry?.detail).toBe('This workflow is not included in your plan.');
    expect(entry?.remedy).toBeUndefined();
  });
});
