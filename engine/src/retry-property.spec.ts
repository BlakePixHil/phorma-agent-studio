import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DataTransportError, HttpStatusError, type TransportFailureKind } from './data-host.js';
import {
  MAX_RETRY_ATTEMPTS,
  MIN_RETRY_ATTEMPTS,
  RETRYABLE_STATUSES,
  backoffFor,
  decideRetry,
  normalisePolicy,
  parseRetryAfter,
  type NormalisedRetryPolicy,
  type RetryDecision,
} from './retry.js';
import type { NodeRetryPolicy } from './types.js';

/**
 * Property 5: Retry is bounded and never repeats an unsafe write (design §6) —
 * claims 21, 22, 23, 24 and 26:
 *
 *  21. **Attempt bound.** ∀ policy, ∀ failure sequence: the body is invoked at
 *      most `min(policy.maxAttempts, MAX_RETRY_ATTEMPTS)` times.
 *  22. **Backoff bound.** ∀ attempt `n`, ∀ policy:
 *      `0 ≤ delay ≤ min(backoffMs · 2^(n-1), maxBackoffMs)`, unless a
 *      `Retry-After` applied, in which case `delay ≤ maxRetryAfterMs`.
 *  23. **Non-idempotent safety.** ∀ error `e` that is a 5xx, a 429 or a timeout:
 *      if `policy.idempotent !== true` then `decideRetry(...).retry === false`.
 *  24. **Retry-After precedence.** ∀ response with a parseable `Retry-After` and
 *      `honorRetryAfter !== false`: `delayMs === min(parsed, maxRetryAfterMs)`
 *      regardless of the exponential schedule.
 *  26. **Purity.** `decideRetry` with a seeded `random` is deterministic.
 *
 * `engine/src/retry.ts` owns every decision and no awaiting, so the attempt bound
 * of claim 21 is asserted over a driver loop that mirrors `withNodeRetry`: invoke
 * the body, ask `decideRetry`, stop when it says stop. The loop carries its own
 * hard cap far above `MAX_RETRY_ATTEMPTS`, so a classifier that never stopped
 * would fail the assertion rather than hang the suite.
 *
 * Claim 25 (`RunStoppedError` is never retried) belongs to a sibling task and is
 * deliberately not asserted here.
 *
 * **Validates: Requirements 11.2, 11.4, 11.5, 11.6, 11.7, 11.9**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Seeded randomness — the classifier reads no ambient random source (11.9)
// ─────────────────────────────────────────────────────────────────────────────

/** A deterministic unit-interval source: an LCG, so a seed replays exactly. */
function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Constant draws, for pinning the exponential schedule to its extremes. */
function constantRandom(value: number): () => number {
  return () => value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE = [...RETRYABLE_STATUSES];

/** Statuses the classifier treats as transient for an idempotent step (11.5). */
const retryableStatusArb: fc.Arbitrary<number> = fc.constantFrom(...RETRYABLE);

/** Response statuses outside the retryable set. */
const nonRetryableStatusArb: fc.Arbitrary<number> = fc
  .integer({ min: 400, max: 599 })
  .filter((status) => !RETRYABLE_STATUSES.has(status));

/** Server-side statuses claim 23 names explicitly. */
const serverErrorStatusArb: fc.Arbitrary<number> = fc.constantFrom(429, 500, 502, 503, 504);

const transportKindArb: fc.Arbitrary<TransportFailureKind> = fc.constantFrom(
  'connect',
  'dns',
  'tls',
  'timeout',
  'aborted',
  'unknown',
);

/** Kinds that prove the request never landed, so a write cannot have happened. */
const neverSentKindArb: fc.Arbitrary<TransportFailureKind> = fc.constantFrom(
  'connect',
  'dns',
  'tls',
);

/** Kinds that leave the outcome unknown: the write may already have landed. */
const maybeSentKindArb: fc.Arbitrary<TransportFailureKind> = fc.constantFrom(
  'timeout',
  'aborted',
  'unknown',
);

/** Headers with no `retry-after`, so the exponential schedule applies (11.7). */
const plainHeadersArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  fc.constantFrom('content-type', 'x-request-id', 'server', 'link'),
  fc.string({ maxLength: 12 }),
  { maxKeys: 3 },
);

/** `Retry-After` values in both wire forms, plus values a host may mangle. */
const retryAfterValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 3_600 }).map(String),
  fc.integer({ min: 1_500_000_000_000, max: 2_000_000_000_000 }).map((ms) =>
    new Date(ms).toUTCString(),
  ),
  fc.constantFrom('', '   ', 'soon', '-5', '1.5', 'Thu, 99 Xxx 2024 00:00:00 GMT'),
);

const errorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc
    .tuple(retryableStatusArb, plainHeadersArb)
    .map(([status, headers]) => new HttpStatusError(status, headers, 'body')),
  fc
    .tuple(nonRetryableStatusArb, plainHeadersArb)
    .map(([status, headers]) => new HttpStatusError(status, headers, 'body')),
  transportKindArb.map((kind) => new DataTransportError(kind, `transport ${kind}`)),
  fc.constant(new Error('opaque host failure')),
  fc.constant('a thrown string'),
);

/** Author-supplied policies, including out-of-range and absent fields (11.2). */
const policyArb: fc.Arbitrary<NodeRetryPolicy> = fc.record(
  {
    maxAttempts: fc.oneof(
      fc.integer({ min: -3, max: 9 }),
      fc.constantFrom(0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY),
    ),
    backoffMs: fc.oneof(fc.integer({ min: -500, max: 8_000 }), fc.constant(0)),
    maxBackoffMs: fc.integer({ min: 0, max: 60_000 }),
    maxRetryAfterMs: fc.integer({ min: 0, max: 200_000 }),
    retryOn: fc.constantFrom('transient' as const, 'all' as const, 'none' as const),
    honorRetryAfter: fc.boolean(),
    idempotent: fc.boolean(),
    disabled: fc.boolean(),
  },
  { requiredKeys: [] },
);

/** Policies that leave the retry budget open, for exhaustion assertions. */
const enabledPolicyArb: fc.Arbitrary<NodeRetryPolicy> = policyArb.map((policy) => ({
  ...policy,
  disabled: false,
  retryOn: policy.retryOn === 'none' ? 'transient' : policy.retryOn,
}));

const attemptArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8 });
const nowMsArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 2_000_000_000_000 });
const seedArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 2 ** 31 - 1 });

// ─────────────────────────────────────────────────────────────────────────────
// The driver loop under test — `withNodeRetry` minus the awaiting
// ─────────────────────────────────────────────────────────────────────────────

/** Far above `MAX_RETRY_ATTEMPTS`: a non-terminating classifier fails, not hangs. */
const HARD_LOOP_CAP = 64;

interface LoopResult {
  /** Body invocations, counting the first as attempt 1. */
  invocations: number;
  decisions: RetryDecision[];
  policy: NormalisedRetryPolicy;
}

/**
 * Drives `decideRetry` exactly as the engine's retry helper does: run the body,
 * classify the failure, stop when the classifier says stop. The body always
 * fails with `error`, which is the worst case for the attempt bound.
 */
function driveRetryLoop(
  error: unknown,
  policy: NodeRetryPolicy,
  random: () => number,
  nowMs = 1_700_000_000_000,
): LoopResult {
  const normalised = normalisePolicy(policy);
  const decisions: RetryDecision[] = [];
  let invocations = 0;

  for (let attempt = 1; attempt <= HARD_LOOP_CAP; attempt += 1) {
    invocations += 1;
    const decision = decideRetry({ error, attempt, policy, nowMs, random });
    if (!decision.retry) break;
    decisions.push(decision);
  }

  return { invocations, decisions, policy: normalised };
}

/** The exponential ceiling for one attempt, straight from the claim. */
function scheduleCeiling(policy: NormalisedRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(policy.backoffMs * Math.pow(2, exponent), policy.maxBackoffMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 21 — attempt bound (Requirements 11.2, 11.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 21): retry is bounded by the normalised attempt budget', () => {
  it('invokes the body at most min(maxAttempts, MAX_RETRY_ATTEMPTS) times', () => {
    fc.assert(
      fc.property(errorArb, policyArb, seedArb, (error, policy, seed) => {
        const { invocations, policy: normalised } = driveRetryLoop(
          error,
          policy,
          seededRandom(seed),
        );
        expect(invocations).toBeGreaterThanOrEqual(MIN_RETRY_ATTEMPTS);
        expect(invocations).toBeLessThanOrEqual(normalised.maxAttempts);
        expect(invocations).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS);
      }),
    );
  });

  it('normalises maxAttempts into [1, 5] whatever the author wrote', () => {
    fc.assert(
      fc.property(policyArb, (policy) => {
        const normalised = normalisePolicy(policy);
        expect(Number.isInteger(normalised.maxAttempts)).toBe(true);
        expect(normalised.maxAttempts).toBeGreaterThanOrEqual(MIN_RETRY_ATTEMPTS);
        expect(normalised.maxAttempts).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS);
        if (policy.disabled === true || policy.retryOn === 'none') {
          expect(normalised.maxAttempts).toBe(MIN_RETRY_ATTEMPTS);
        }
      }),
    );
  });

  it('emits exactly one retry decision per scheduled retry: invocations = retries + 1', () => {
    fc.assert(
      fc.property(errorArb, policyArb, seedArb, (error, policy, seed) => {
        const { invocations, decisions } = driveRetryLoop(error, policy, seededRandom(seed));
        expect(decisions.length).toBe(invocations - 1);
        expect(decisions.every((decision) => decision.retry)).toBe(true);
      }),
    );
  });

  it('exhausts the whole budget for an always-retryable failure, and no more', () => {
    fc.assert(
      fc.property(enabledPolicyArb, neverSentKindArb, seedArb, (policy, kind, seed) => {
        const safe: NodeRetryPolicy = { ...policy, idempotent: true };
        const { invocations, policy: normalised } = driveRetryLoop(
          new DataTransportError(kind, `transport ${kind}`),
          safe,
          seededRandom(seed),
        );
        expect(invocations).toBe(normalised.maxAttempts);
      }),
    );
  });

  it('never retries when the policy is disabled or retryOn is none (11.3)', () => {
    fc.assert(
      fc.property(errorArb, policyArb, seedArb, (error, base, seed) => {
        for (const policy of [
          { ...base, disabled: true },
          { ...base, retryOn: 'none' as const },
        ]) {
          const { invocations, decisions } = driveRetryLoop(error, policy, seededRandom(seed));
          expect(invocations).toBe(1);
          expect(decisions).toEqual([]);
        }
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 22 — backoff bound (Requirements 11.6, 11.7)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 22): every delay stays inside its declared ceiling', () => {
  it('draws backoffFor from [0, min(backoffMs * 2^(n-1), maxBackoffMs)]', () => {
    fc.assert(
      fc.property(attemptArb, policyArb, seedArb, (attempt, policy, seed) => {
        const normalised = normalisePolicy(policy);
        const delay = backoffFor(attempt, policy, seededRandom(seed));
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(scheduleCeiling(normalised, attempt));
      }),
    );
  });

  it('reaches both ends of the range as the injected source moves', () => {
    fc.assert(
      fc.property(attemptArb, policyArb, (attempt, policy) => {
        const normalised = normalisePolicy(policy);
        const ceiling = scheduleCeiling(normalised, attempt);
        expect(backoffFor(attempt, policy, constantRandom(0))).toBe(0);
        // Full jitter floors the draw, so the top of the range is `ceiling` itself.
        expect(backoffFor(attempt, policy, constantRandom(1))).toBe(Math.floor(ceiling));
      }),
    );
  });

  it('clamps an out-of-range or non-finite draw instead of trusting it', () => {
    fc.assert(
      fc.property(attemptArb, policyArb, (attempt, policy) => {
        const ceiling = scheduleCeiling(normalisePolicy(policy), attempt);
        for (const draw of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
          const delay = backoffFor(attempt, policy, constantRandom(draw));
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(Math.floor(ceiling));
        }
      }),
    );
  });

  it('bounds every delay a full retry loop schedules', () => {
    fc.assert(
      fc.property(errorArb, policyArb, seedArb, nowMsArb, (error, policy, seed, nowMs) => {
        const { decisions, policy: normalised } = driveRetryLoop(
          error,
          policy,
          seededRandom(seed),
          nowMs,
        );
        decisions.forEach((decision, index) => {
          const attempt = index + 1;
          expect(decision.delayMs).toBeGreaterThanOrEqual(0);
          const ceiling =
            decision.reason === 'retry-after'
              ? normalised.maxRetryAfterMs
              : scheduleCeiling(normalised, attempt);
          expect(decision.delayMs).toBeLessThanOrEqual(ceiling);
        });
      }),
    );
  });

  it('reports a zero delay whenever it decides against retrying', () => {
    fc.assert(
      fc.property(errorArb, policyArb, attemptArb, seedArb, (error, policy, attempt, seed) => {
        const decision = decideRetry({
          error,
          attempt,
          policy,
          nowMs: 1_700_000_000_000,
          random: seededRandom(seed),
        });
        if (!decision.retry) {
          expect(decision.delayMs).toBe(0);
          expect(decision.reason).toBe('not-retryable');
        }
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 23 — non-idempotent safety (Requirement 11.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 23): a non-idempotent step is never repeated unsafely', () => {
  it('refuses every response-status failure when idempotent is not true', () => {
    fc.assert(
      fc.property(
        fc.oneof(serverErrorStatusArb, retryableStatusArb, nonRetryableStatusArb),
        plainHeadersArb,
        policyArb,
        attemptArb,
        seedArb,
        (status, headers, base, attempt, seed) => {
          for (const idempotent of [undefined, false]) {
            const policy: NodeRetryPolicy = { ...base, idempotent, disabled: false };
            const decision = decideRetry({
              error: new HttpStatusError(status, headers, 'body'),
              attempt,
              policy,
              nowMs: 1_700_000_000_000,
              random: seededRandom(seed),
            });
            expect(decision.retry).toBe(false);
          }
        },
      ),
    );
  });

  it('refuses a timeout, abort or unknown transport failure when idempotent is not true', () => {
    fc.assert(
      fc.property(maybeSentKindArb, policyArb, attemptArb, seedArb, (kind, base, attempt, seed) => {
        const policy: NodeRetryPolicy = { ...base, idempotent: false };
        const decision = decideRetry({
          error: new DataTransportError(kind, `transport ${kind}`),
          attempt,
          policy,
          nowMs: 1_700_000_000_000,
          random: seededRandom(seed),
        });
        expect(decision.retry).toBe(false);
        expect(decision.delayMs).toBe(0);
      }),
    );
  });

  it('holds even under retryOn: all, which never overrides write safety', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          serverErrorStatusArb.map((status) => new HttpStatusError(status, {}, 'body')),
          maybeSentKindArb.map((kind) => new DataTransportError(kind, kind)),
        ),
        attemptArb,
        seedArb,
        (error, attempt, seed) => {
          const decision = decideRetry({
            error,
            attempt,
            policy: { retryOn: 'all', maxAttempts: 5, idempotent: false },
            nowMs: 1_700_000_000_000,
            random: seededRandom(seed),
          });
          expect(decision.retry).toBe(false);
        },
      ),
    );
  });

  it('still retries a provably unsent request, which cannot have duplicated a write', () => {
    fc.assert(
      fc.property(neverSentKindArb, seedArb, (kind, seed) => {
        const decision = decideRetry({
          error: new DataTransportError(kind, `transport ${kind}`),
          attempt: 1,
          policy: { maxAttempts: 3, idempotent: false },
          nowMs: 1_700_000_000_000,
          random: seededRandom(seed),
        });
        expect(decision.retry).toBe(true);
        expect(decision.reason).toBe('transport');
      }),
    );
  });

  it('invokes a non-idempotent body once for any failure that may have landed', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          serverErrorStatusArb.map((status) => new HttpStatusError(status, {}, 'body')),
          maybeSentKindArb.map((kind) => new DataTransportError(kind, kind)),
        ),
        enabledPolicyArb,
        seedArb,
        (error, base, seed) => {
          const { invocations } = driveRetryLoop(
            error,
            { ...base, idempotent: false },
            seededRandom(seed),
          );
          expect(invocations).toBe(1);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 24 — Retry-After precedence (Requirements 11.6, 11.8)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 24): a parseable Retry-After overrides the schedule', () => {
  it('uses min(parsed, maxRetryAfterMs), clamped at zero, and reports retry-after', () => {
    fc.assert(
      fc.property(
        retryableStatusArb,
        retryAfterValueArb,
        enabledPolicyArb,
        nowMsArb,
        seedArb,
        (status, headerValue, base, nowMs, seed) => {
          const policy: NodeRetryPolicy = {
            ...base,
            idempotent: true,
            honorRetryAfter: true,
            maxAttempts: 5,
          };
          const normalised = normalisePolicy(policy);
          const decision = decideRetry({
            error: new HttpStatusError(status, { 'retry-after': headerValue }, 'body'),
            attempt: 1,
            policy,
            nowMs,
            random: seededRandom(seed),
          });

          const parsed = parseRetryAfter(headerValue, nowMs);
          expect(decision.retry).toBe(true);
          if (parsed === undefined) {
            // Unparseable: the exponential schedule applies instead (11.8 → 11.7).
            expect(decision.reason).toBe('status');
            expect(decision.delayMs).toBeLessThanOrEqual(scheduleCeiling(normalised, 1));
          } else {
            expect(decision.reason).toBe('retry-after');
            expect(decision.delayMs).toBe(
              Math.min(Math.max(0, parsed), normalised.maxRetryAfterMs),
            );
          }
        },
      ),
    );
  });

  it('ignores the injected random source entirely on the retry-after path', () => {
    fc.assert(
      fc.property(
        retryableStatusArb,
        fc.integer({ min: 0, max: 60 }).map(String),
        nowMsArb,
        (status, headerValue, nowMs) => {
          const policy: NodeRetryPolicy = {
            maxAttempts: 5,
            idempotent: true,
            backoffMs: 1_000,
            maxBackoffMs: 30_000,
            maxRetryAfterMs: 120_000,
          };
          const error = new HttpStatusError(status, { 'retry-after': headerValue }, 'body');
          const low = decideRetry({ error, attempt: 3, policy, nowMs, random: constantRandom(0) });
          const high = decideRetry({ error, attempt: 3, policy, nowMs, random: constantRandom(1) });
          expect(low).toEqual(high);
          expect(low.delayMs).toBe(Number(headerValue) * 1_000);
        },
      ),
    );
  });

  it('clamps a past HTTP-date to zero rather than a negative delay', () => {
    fc.assert(
      fc.property(
        retryableStatusArb,
        fc.integer({ min: 1_000, max: 10_000_000 }),
        nowMsArb,
        (status, backOffsetMs, nowMs) => {
          const past = new Date(Math.max(0, nowMs - backOffsetMs)).toUTCString();
          const decision = decideRetry({
            error: new HttpStatusError(status, { 'retry-after': past }, 'body'),
            attempt: 1,
            policy: { maxAttempts: 3, idempotent: true },
            nowMs,
            random: constantRandom(0.5),
          });
          expect(decision.retry).toBe(true);
          expect(decision.delayMs).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('falls back to the schedule when honorRetryAfter is false', () => {
    fc.assert(
      fc.property(
        retryableStatusArb,
        fc.integer({ min: 1, max: 600 }).map(String),
        enabledPolicyArb,
        seedArb,
        (status, headerValue, base, seed) => {
          const policy: NodeRetryPolicy = {
            ...base,
            idempotent: true,
            honorRetryAfter: false,
            maxAttempts: 5,
          };
          const decision = decideRetry({
            error: new HttpStatusError(status, { 'retry-after': headerValue }, 'body'),
            attempt: 2,
            policy,
            nowMs: 1_700_000_000_000,
            random: seededRandom(seed),
          });
          expect(decision.retry).toBe(true);
          expect(decision.reason).toBe('status');
          expect(decision.delayMs).toBeLessThanOrEqual(
            scheduleCeiling(normalisePolicy(policy), 2),
          );
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 26 — purity and determinism (Requirement 11.9)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 26): decideRetry is pure and deterministic', () => {
  it('returns the same decision for identical inputs and an identical seed', () => {
    fc.assert(
      fc.property(
        errorArb,
        policyArb,
        attemptArb,
        nowMsArb,
        seedArb,
        (error, policy, attempt, nowMs, seed) => {
          const first = decideRetry({ error, attempt, policy, nowMs, random: seededRandom(seed) });
          const second = decideRetry({ error, attempt, policy, nowMs, random: seededRandom(seed) });
          expect(second).toEqual(first);
        },
      ),
    );
  });

  it('replays a whole retry loop identically from the same seed', () => {
    fc.assert(
      fc.property(errorArb, policyArb, seedArb, nowMsArb, (error, policy, seed, nowMs) => {
        const first = driveRetryLoop(error, policy, seededRandom(seed), nowMs);
        const second = driveRetryLoop(error, policy, seededRandom(seed), nowMs);
        expect(second.invocations).toBe(first.invocations);
        expect(second.decisions).toEqual(first.decisions);
      }),
    );
  });

  it('leaves the supplied policy and error structurally unchanged', () => {
    fc.assert(
      fc.property(
        errorArb,
        policyArb,
        attemptArb,
        nowMsArb,
        seedArb,
        (error, policy, attempt, nowMs, seed) => {
          const policySnapshot = JSON.stringify(policy);
          const errorSnapshot = JSON.stringify({
            name: (error as Error)?.name,
            message: (error as Error)?.message,
            status: (error as HttpStatusError)?.status,
            kind: (error as DataTransportError)?.kind,
          });

          decideRetry({ error, attempt, policy, nowMs, random: seededRandom(seed) });

          expect(JSON.stringify(policy)).toBe(policySnapshot);
          expect(
            JSON.stringify({
              name: (error as Error)?.name,
              message: (error as Error)?.message,
              status: (error as HttpStatusError)?.status,
              kind: (error as DataTransportError)?.kind,
            }),
          ).toBe(errorSnapshot);
        },
      ),
    );
  });

  it('hands back a fresh decision object per call, so a caller can keep it', () => {
    fc.assert(
      fc.property(errorArb, policyArb, attemptArb, seedArb, (error, policy, attempt, seed) => {
        const nowMs = 1_700_000_000_000;
        const first = decideRetry({ error, attempt, policy, nowMs, random: seededRandom(seed) });
        first.delayMs = -1;
        first.retry = !first.retry;
        const second = decideRetry({ error, attempt, policy, nowMs, random: seededRandom(seed) });
        expect(second.delayMs).toBeGreaterThanOrEqual(0);
        expect(second).not.toBe(first);
      }),
    );
  });

  it('reads no ambient clock: the decision depends only on the supplied nowMs', () => {
    fc.assert(
      fc.property(
        retryableStatusArb,
        fc.integer({ min: 0, max: 3_600 }).map(String),
        nowMsArb,
        (status, headerValue, nowMs) => {
          const error = new HttpStatusError(status, { 'retry-after': headerValue }, 'body');
          const policy: NodeRetryPolicy = { maxAttempts: 4, idempotent: true };
          const decision = decideRetry({
            error,
            attempt: 1,
            policy,
            nowMs,
            random: constantRandom(0.5),
          });
          // Delta-seconds is clock-independent, so shifting `nowMs` cannot move it.
          const shifted = decideRetry({
            error,
            attempt: 1,
            policy,
            nowMs: nowMs + 5_000,
            random: constantRandom(0.5),
          });
          expect(shifted).toEqual(decision);
        },
      ),
    );
  });

  it('normalisePolicy is idempotent, so a normalised policy passes through', () => {
    fc.assert(
      fc.property(policyArb, (policy) => {
        const once = normalisePolicy(policy);
        expect(normalisePolicy(once)).toEqual(once);
      }),
    );
  });
});
