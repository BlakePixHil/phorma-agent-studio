import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DataTransportError, HttpStatusError, type TransportFailureKind } from './data-host.js';
import {
  runWithNodeRetry,
  type NodeRetryContext,
  type NodeRetryNotice,
} from './engine.js';
import { RunGate, RunStoppedError } from './gate.js';
import { RETRYABLE_STATUSES, normalisePolicy } from './retry.js';
import type { NodeRetryPolicy } from './types.js';

/**
 * Property 5: Retry is bounded and never repeats an unsafe write (design §6) —
 * claim 25 only:
 *
 *  25. **Stop wins.** ∀ policy: a `RunStoppedError` is never retried and always
 *      propagates.
 *
 * The retry loop is driven through its exported form, `runWithNodeRetry`, with an
 * injected {@link NodeRetryContext}, so the real code path runs without a graph.
 * A stop can reach the loop from four places, and the property is asserted at
 * every one of them:
 *
 *   1. the body throws `RunStoppedError` mid-attempt;
 *   2. the pending delay unwinds (`RunGate.sleep` throws when Stop lands);
 *   3. the gate reports a stop after the delay without throwing;
 *   4. the pause-aware resume wait rejects because the run was stopped.
 *
 * In every case the rejection must be the stop, the announced-but-unstarted retry
 * must never begin, and no `node-retrying` event may follow the stop.
 *
 * Claims 21, 22, 23, 24 and 26 belong to `retry-property.spec.ts` and are
 * deliberately not re-asserted here.
 *
 * **Validates: Requirements 11.12**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transport failures the classifier retries whatever `idempotent` says: the
 * request provably never left, so the retry budget always opens.
 */
const neverSentKindArb: fc.Arbitrary<TransportFailureKind> = fc.constantFrom(
  'connect',
  'dns',
  'tls',
);

/** Failures that keep the retry budget open, so a stop has something to cancel. */
const retryableFailureArb: fc.Arbitrary<unknown> = fc.oneof(
  neverSentKindArb.map((kind) => new DataTransportError(kind, `transport ${kind}`)),
  fc
    .tuple(fc.constantFrom(...RETRYABLE_STATUSES), fc.constantFrom('1', '30', 'soon', ''))
    .map(([status, retryAfter]) => new HttpStatusError(status, { 'retry-after': retryAfter }, 'b')),
);

/**
 * Retry-friendly policies: enabled, idempotent, and with the delay pinned to
 * zero so a real `RunGate.sleep` cannot stall the suite. `maxAttempts` spans the
 * whole normalised range, plus values the normaliser has to clamp.
 */
function policyArb(minAttempts: number): fc.Arbitrary<NodeRetryPolicy> {
  // Every field is present on purpose: an absent `idempotent` would close the
  // retry budget for a status failure, leaving no scheduled retry for a stop to
  // cancel. Claim 23 owns that path; this file needs the budget open.
  return fc.record({
    maxAttempts: fc.integer({ min: minAttempts, max: 9 }),
    backoffMs: fc.constant(0),
    maxBackoffMs: fc.constant(0),
    maxRetryAfterMs: fc.constant(0),
    retryOn: fc.constantFrom('transient' as const, 'all' as const),
    honorRetryAfter: fc.boolean(),
    idempotent: fc.constant(true),
    disabled: fc.constant(false),
  });
}

/** Where the stop reaches the loop. */
type StopSite = 'body' | 'sleep' | 'gate-flag' | 'resume';

const STOP_SITES: StopSite[] = ['body', 'sleep', 'gate-flag', 'resume'];

/** Policy shapes that span every retry configuration a node author can write. */
const POLICY_SHAPES: NodeRetryPolicy[] = [
  {},
  { maxAttempts: 5, idempotent: true, retryOn: 'all' },
  { maxAttempts: 5, idempotent: true, retryOn: 'none' },
  { maxAttempts: 5, idempotent: true, disabled: true },
  { maxAttempts: 5, idempotent: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Driver — the real loop, with the stop injected at one chosen point
// ─────────────────────────────────────────────────────────────────────────────

interface Trace {
  /** Body invocations, counting the first as attempt 1. */
  bodyCalls: number;
  notices: NodeRetryNotice[];
  /** Delays the loop actually slept through. */
  sleeps: number[];
  outcome: 'stopped' | 'failed' | 'resolved';
  error: unknown;
}

/**
 * Runs `runWithNodeRetry` with an always-failing body and a stop injected at
 * `site`. `at` is the 1-based attempt for the `body` site, and the 1-based index
 * of the announced retry for every other site.
 */
async function drive(
  policy: NodeRetryPolicy,
  failure: unknown,
  site: StopSite,
  at: number,
  stop: RunStoppedError,
): Promise<Trace> {
  const notices: NodeRetryNotice[] = [];
  const sleeps: number[] = [];
  const trace: Trace = {
    bodyCalls: 0,
    notices,
    sleeps,
    outcome: 'resolved',
    error: undefined,
  };

  const ctx: NodeRetryContext = {
    onRetry: (notice) => notices.push(notice),
    sleep: async (ms) => {
      if (site === 'sleep' && notices.length >= at) throw stop;
      sleeps.push(ms);
    },
    stopped: () => site === 'gate-flag' && notices.length >= at,
    awaitResume: async () => {
      if (site === 'resume' && notices.length >= at) throw stop;
    },
    now: () => 1_700_000_000_000,
    random: () => 0.5,
  };

  try {
    await runWithNodeRetry(
      policy,
      async (attempt) => {
        trace.bodyCalls += 1;
        if (site === 'body' && attempt >= at) throw stop;
        throw failure;
      },
      ctx,
    );
  } catch (error) {
    trace.error = error;
    trace.outcome = error instanceof RunStoppedError ? 'stopped' : 'failed';
  }
  return trace;
}

/** Folds an arbitrary positive integer into `1..budget`. */
function within(raw: number, budget: number): number {
  return ((raw - 1) % budget) + 1;
}

/** The normalised attempt budget the loop will honour for this policy. */
function budgetOf(policy: NodeRetryPolicy): number {
  return normalisePolicy(policy).maxAttempts;
}

/** No event may describe the stop, and none may follow it. */
function expectNoStopEvent(notices: NodeRetryNotice[]): void {
  expect(notices.some((notice) => notice.error.includes('Run stopped'))).toBe(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 25 — a stop raised by the attempt itself
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 25): a stop raised during an attempt is never retried', () => {
  it('propagates the stop unchanged and schedules no further attempt', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(1),
        retryableFailureArb,
        fc.integer({ min: 1, max: 9 }),
        async (policy, failure, rawAt) => {
          const stop = new RunStoppedError();
          const at = within(rawAt, budgetOf(policy));
          const trace = await drive(policy, failure, 'body', at, stop);

          // The very error the body raised comes back out, not a re-wrap.
          expect(trace.outcome).toBe('stopped');
          expect(trace.error).toBe(stop);
          // The stopping attempt is the last one: nothing after it ran.
          expect(trace.bodyCalls).toBe(at);
          expect(trace.notices).toHaveLength(at - 1);
          expect(trace.notices.map((notice) => notice.attempt)).toEqual(
            Array.from({ length: at - 1 }, (_, index) => index + 1),
          );
          expectNoStopEvent(trace.notices);
        },
      ),
    );
  });

  it('holds for every policy shape, including retryOn all and a disabled policy', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...POLICY_SHAPES),
        async (policy) => {
          const stop = new RunStoppedError();
          const trace = await drive(policy, new Error('unused'), 'body', 1, stop);

          expect(trace.error).toBe(stop);
          expect(trace.bodyCalls).toBe(1);
          expect(trace.notices).toEqual([]);
          expect(trace.sleeps).toEqual([]);
        },
      ),
    );
  });

  it('recognises a stop that crossed a bundle boundary and lost its prototype', () => {
    return fc.assert(
      fc.asyncProperty(policyArb(2), async (policy) => {
        const lookalike = new Error('Run stopped by user.');
        lookalike.name = 'RunStoppedError';
        const notices: NodeRetryNotice[] = [];
        let bodyCalls = 0;

        await expect(
          runWithNodeRetry(
            policy,
            async () => {
              bodyCalls += 1;
              throw lookalike;
            },
            {
              onRetry: (notice) => notices.push(notice),
              sleep: async () => {},
              now: () => 1_700_000_000_000,
              random: () => 0.5,
            },
          ),
        ).rejects.toBe(lookalike);

        expect(bodyCalls).toBe(1);
        expect(notices).toEqual([]);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 25 — a stop that lands while the retry delay is pending
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 25): a stop during a pending delay abandons the retry', () => {
  it('abandons the announced retry when the delay itself unwinds', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(2),
        retryableFailureArb,
        fc.integer({ min: 1, max: 9 }),
        async (policy, failure, rawAt) => {
          const stop = new RunStoppedError();
          // Only a retry the loop actually schedules can be abandoned, so the
          // stop point stays inside `1..budget - 1`.
          const at = within(rawAt, budgetOf(policy) - 1);
          const trace = await drive(policy, failure, 'sleep', at, stop);

          expect(trace.outcome).toBe('stopped');
          expect(trace.error).toBe(stop);
          // The retry was announced but never started: attempts stop at `at`.
          expect(trace.bodyCalls).toBe(at);
          expect(trace.notices).toHaveLength(at);
          expect(trace.sleeps).toHaveLength(at - 1);
          expectNoStopEvent(trace.notices);
        },
      ),
    );
  });

  it('starts no further attempt when the gate reports a stop after the delay', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(2),
        retryableFailureArb,
        fc.integer({ min: 1, max: 9 }),
        async (policy, failure, rawAt) => {
          const at = within(rawAt, budgetOf(policy) - 1);
          const trace = await drive(policy, failure, 'gate-flag', at, new RunStoppedError());

          expect(trace.outcome).toBe('stopped');
          expect(trace.error).toBeInstanceOf(RunStoppedError);
          expect(trace.bodyCalls).toBe(at);
          expect(trace.notices).toHaveLength(at);
          expectNoStopEvent(trace.notices);
        },
      ),
    );
  });

  it('starts no further attempt when the run is stopped while paused', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(2),
        retryableFailureArb,
        fc.integer({ min: 1, max: 9 }),
        async (policy, failure, rawAt) => {
          const stop = new RunStoppedError();
          const at = within(rawAt, budgetOf(policy) - 1);
          const trace = await drive(policy, failure, 'resume', at, stop);

          expect(trace.outcome).toBe('stopped');
          expect(trace.error).toBe(stop);
          expect(trace.bodyCalls).toBe(at);
          expect(trace.notices).toHaveLength(at);
          expectNoStopEvent(trace.notices);
        },
      ),
    );
  });

  it('runs nothing more once the rejection has settled', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(2),
        retryableFailureArb,
        fc.constantFrom(...STOP_SITES),
        async (policy, failure, site) => {
          const trace = await drive(policy, failure, site, 1, new RunStoppedError());
          const settledCalls = trace.bodyCalls;
          const settledNotices = trace.notices.length;

          // Let every pending microtask and one timer turn drain.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          expect(trace.bodyCalls).toBe(settledCalls);
          expect(trace.notices).toHaveLength(settledNotices);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 25 — the same guarantee through the real gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5 (claim 25): the real RunGate unwinds the loop on Stop', () => {
  it('propagates a stop pressed mid-attempt through gate.sleep', () => {
    return fc.assert(
      fc.asyncProperty(
        policyArb(2),
        retryableFailureArb,
        fc.integer({ min: 1, max: 9 }),
        async (policy, failure, rawAt) => {
          const gate = new RunGate();
          const at = within(rawAt, budgetOf(policy) - 1);
          const notices: NodeRetryNotice[] = [];
          let bodyCalls = 0;

          const running = runWithNodeRetry(
            policy,
            async (attempt) => {
              bodyCalls += 1;
              // Stop is pressed while this attempt is in flight.
              if (attempt >= at) gate.stop();
              throw failure;
            },
            {
              onRetry: (notice) => notices.push(notice),
              sleep: (ms) => gate.sleep(ms),
              stopped: () => gate.stopped,
              now: () => 1_700_000_000_000,
              random: () => 0.5,
            },
          );

          await expect(running).rejects.toBeInstanceOf(RunStoppedError);
          expect(bodyCalls).toBe(at);
          // The retry that was announced never started.
          expect(notices).toHaveLength(at);
          expectNoStopEvent(notices);
        },
      ),
    );
  });
});
