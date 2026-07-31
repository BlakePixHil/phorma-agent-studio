import { describe, expect, it } from 'vitest';
import { DataTransportError, HttpStatusError } from './data-host.js';
import { RunStoppedError } from './gate.js';
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_ATTEMPTS,
  MAX_RETRY_ATTEMPTS,
  MIN_RETRY_ATTEMPTS,
  RETRYABLE_STATUSES,
  decideRetry,
  normalisePolicy,
  parseRetryAfter,
} from './retry.js';
import type { NodeRetryPolicy } from './types.js';

/**
 * `Retry-After` parsing and the `decideRetry` status / idempotency matrix
 * (Requirements 11.3, 11.8, 11.14).
 *
 * Every case pins a fixed `nowMs` and a fixed `random`, so a delay assertion is
 * exact rather than a range check — the classifier reads no ambient clock and no
 * ambient randomness, and these tests would fail if it started to.
 */

/** 2015-10-21T07:28:00Z, the reference instant for every HTTP-date case. */
const NOW_MS = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');

/** Deterministic random draws: the floor and the ceiling of the jitter window. */
const zero = (): number => 0;
const one = (): number => 1;

function statusError(status: number, headers: Record<string, string> = {}): HttpStatusError {
  return new HttpStatusError(status, headers, '');
}

function decide(
  error: unknown,
  policy: NodeRetryPolicy,
  overrides: { attempt?: number; nowMs?: number; random?: () => number } = {},
) {
  return decideRetry({
    error,
    attempt: overrides.attempt ?? 1,
    policy,
    nowMs: overrides.nowMs ?? NOW_MS,
    random: overrides.random ?? zero,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 11.8 Retry-After parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRetryAfter delta-seconds (11.8)', () => {
  it.each([
    ['0', 0],
    ['1', 1_000],
    ['30', 30_000],
    ['120', 120_000],
    ['86400', 86_400_000],
  ])('parses %j as %i ms independently of the current time', (header, expected) => {
    expect(parseRetryAfter(header, NOW_MS)).toBe(expected);
    expect(parseRetryAfter(header, 0)).toBe(expected);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseRetryAfter('  30  ', NOW_MS)).toBe(30_000);
    expect(parseRetryAfter('\t7\n', NOW_MS)).toBe(7_000);
  });
});

describe('parseRetryAfter HTTP-date (11.8)', () => {
  it('returns the future date minus the supplied current time', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:30 GMT', NOW_MS)).toBe(30_000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:30:00 GMT', NOW_MS)).toBe(120_000);
  });

  it('returns the raw negative delta for a date already in the past', () => {
    // Clamping is `decideRetry`'s job, so the parser reports the true delta.
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', NOW_MS)).toBe(-60_000);
  });

  it('reads the same instant from an equivalent ISO-8601 spelling', () => {
    expect(parseRetryAfter('2015-10-21T07:28:10Z', NOW_MS)).toBe(10_000);
  });
});

describe('parseRetryAfter absent and unparseable values (11.8)', () => {
  it('reports no delay for an absent header', () => {
    expect(parseRetryAfter(undefined, NOW_MS)).toBeUndefined();
  });

  it.each([['', 'empty'] as const, ['   ', 'whitespace only'] as const])(
    'reports no delay for an %j (%s) value',
    (header: string, _label: string) => {
      expect(parseRetryAfter(header, NOW_MS)).toBeUndefined();
    },
  );

  it.each(['abc', 'soon', '30 seconds', 'PT30S', 'Nonsense, 99 Xyz 2020 07:28:00 GMT'])(
    'reports no delay for the unparseable value %j',
    (header) => {
      expect(parseRetryAfter(header, NOW_MS)).toBeUndefined();
    },
  );

  it('reports no delay for a non-string value', () => {
    expect(parseRetryAfter(30 as unknown as string, NOW_MS)).toBeUndefined();
    expect(parseRetryAfter(null as unknown as string, NOW_MS)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11.3 disabled and retryOn: 'none'
// ─────────────────────────────────────────────────────────────────────────────

describe('disabled and retryOn none (11.3)', () => {
  it.each<[string, NodeRetryPolicy]>([
    ['disabled', { idempotent: true, maxAttempts: 5, disabled: true }],
    ['retryOn none', { idempotent: true, maxAttempts: 5, retryOn: 'none' }],
  ])('collapses the attempt budget to a single attempt when %s', (_label, policy) => {
    expect(normalisePolicy(policy).maxAttempts).toBe(MIN_RETRY_ATTEMPTS);
  });

  it.each<[string, NodeRetryPolicy]>([
    ['disabled', { idempotent: true, maxAttempts: 5, disabled: true }],
    ['retryOn none', { idempotent: true, maxAttempts: 5, retryOn: 'none' }],
  ])('decides against retrying with reason not-retryable and zero delay when %s', (_l, policy) => {
    for (const error of [
      statusError(503, { 'retry-after': '1' }),
      new DataTransportError('connect', 'refused'),
      new Error('opaque'),
    ]) {
      expect(decide(error, policy)).toEqual({
        retry: false,
        delayMs: 0,
        reason: 'not-retryable',
      });
    }
  });

  it('ignores retryOn all while disabled', () => {
    const decision = decide(statusError(429, { 'retry-after': '5' }), {
      idempotent: true,
      retryOn: 'all',
      disabled: true,
    });

    expect(decision).toEqual({ retry: false, delayMs: 0, reason: 'not-retryable' });
  });
});

describe('policy normalisation defaults and clamping (11.3)', () => {
  it('resolves every unset field', () => {
    expect(normalisePolicy(undefined)).toEqual({
      maxAttempts: DEFAULT_RETRY_ATTEMPTS,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
      maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
      retryOn: 'transient',
      honorRetryAfter: true,
      idempotent: false,
      disabled: false,
    });
  });

  it.each([
    [undefined, DEFAULT_RETRY_ATTEMPTS],
    [0, MIN_RETRY_ATTEMPTS],
    [-3, MIN_RETRY_ATTEMPTS],
    [2.5, MIN_RETRY_ATTEMPTS],
    [1, 1],
    [5, 5],
    [99, MAX_RETRY_ATTEMPTS],
  ])('normalises maxAttempts %s to %i', (raw, expected) => {
    expect(normalisePolicy({ maxAttempts: raw as number | undefined }).maxAttempts).toBe(expected);
  });

  it('is idempotent, so an already-normalised policy passes through unchanged', () => {
    const once = normalisePolicy({ maxAttempts: 9, backoffMs: 250, retryOn: 'all' });
    expect(normalisePolicy(once)).toEqual(once);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11.14 + 11.4/11.5 the status / idempotency matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('status and idempotency matrix (11.14)', () => {
  const idempotent: NodeRetryPolicy = { idempotent: true, maxAttempts: 5, honorRetryAfter: false };
  const nonIdempotent: NodeRetryPolicy = { maxAttempts: 5 };

  it.each([...RETRYABLE_STATUSES])(
    'retries status %i with reason status for an idempotent step',
    (status) => {
      const decision = decide(statusError(status), idempotent);
      expect(decision.retry).toBe(true);
      expect(decision.reason).toBe('status');
    },
  );

  it.each([...RETRYABLE_STATUSES])(
    'refuses to repeat status %i for a non-idempotent step',
    (status) => {
      expect(decide(statusError(status), nonIdempotent)).toEqual({
        retry: false,
        delayMs: 0,
        reason: 'not-retryable',
      });
    },
  );

  it.each([400, 401, 403, 404, 409, 418, 422, 501])(
    'declines status %i as not-retryable even when idempotent',
    (status) => {
      expect(decide(statusError(status), idempotent)).toEqual({
        retry: false,
        delayMs: 0,
        reason: 'not-retryable',
      });
    },
  );

  it.each([404, 422, 501])('retries status %i under retryOn all when idempotent', (status) => {
    const decision = decide(statusError(status), { ...idempotent, retryOn: 'all' }, { random: one });
    expect(decision).toEqual({ retry: true, delayMs: 1_000, reason: 'policy-all' });
  });

  it('still refuses a non-retryable status under retryOn all when not idempotent', () => {
    expect(decide(statusError(404), { ...nonIdempotent, retryOn: 'all' })).toEqual({
      retry: false,
      delayMs: 0,
      reason: 'not-retryable',
    });
  });

  it.each<['connect' | 'dns' | 'tls', string]>([
    ['connect', 'connection refused'],
    ['dns', 'name not resolved'],
    ['tls', 'handshake failed'],
  ])('retries a never-sent %s transport failure even when not idempotent', (kind, message) => {
    const decision = decide(new DataTransportError(kind, message), nonIdempotent);
    expect(decision).toEqual({ retry: true, delayMs: 0, reason: 'transport' });
  });

  it.each<['timeout' | 'aborted' | 'unknown', string]>([
    ['timeout', 'deadline exceeded'],
    ['aborted', 'aborted'],
    ['unknown', 'unknown failure'],
  ])('refuses a possibly-sent %s transport failure when not idempotent', (kind, message) => {
    expect(decide(new DataTransportError(kind, message), nonIdempotent)).toEqual({
      retry: false,
      delayMs: 0,
      reason: 'not-retryable',
    });
  });

  it.each<['timeout' | 'aborted' | 'unknown', string]>([
    ['timeout', 'deadline exceeded'],
    ['aborted', 'aborted'],
    ['unknown', 'unknown failure'],
  ])('retries a %s transport failure when the step is idempotent', (kind, message) => {
    const decision = decide(new DataTransportError(kind, message), idempotent, { random: one });
    expect(decision).toEqual({ retry: true, delayMs: 1_000, reason: 'transport' });
  });

  it('retries an error that lost its prototype identity across a bundle boundary', () => {
    const crossRealm = Object.assign(new Error('HTTP 503'), {
      name: 'HttpStatusError',
      status: 503,
      headers: {},
    });

    expect(decide(crossRealm, idempotent).retry).toBe(true);
  });

  it('declines an opaque error unless retryOn is all', () => {
    expect(decide(new Error('boom'), idempotent)).toEqual({
      retry: false,
      delayMs: 0,
      reason: 'not-retryable',
    });

    const decision = decide(new Error('boom'), { ...idempotent, retryOn: 'all' }, { random: one });
    expect(decision).toEqual({ retry: true, delayMs: 1_000, reason: 'policy-all' });
  });

  it('never retries a stopped run', () => {
    expect(decide(new RunStoppedError(), { idempotent: true, retryOn: 'all', maxAttempts: 5 })).toEqual(
      { retry: false, delayMs: 0, reason: 'not-retryable' },
    );
  });

  it('exhausts the budget at parity with maxAttempts', () => {
    const policy: NodeRetryPolicy = { idempotent: true, maxAttempts: 3 };
    expect(decide(statusError(503), policy, { attempt: 2 }).retry).toBe(true);
    expect(decide(statusError(503), policy, { attempt: 3 })).toEqual({
      retry: false,
      delayMs: 0,
      reason: 'not-retryable',
    });
    expect(decide(statusError(503), policy, { attempt: 4 }).retry).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11.8 Retry-After inside a decision
// ─────────────────────────────────────────────────────────────────────────────

describe('Retry-After applied to a decision (11.8)', () => {
  const idempotent: NodeRetryPolicy = { idempotent: true, maxAttempts: 5 };

  it('uses a delta-seconds header and reports the retry-after reason', () => {
    const decision = decide(statusError(429, { 'retry-after': '30' }), idempotent, { random: one });
    expect(decision).toEqual({ retry: true, delayMs: 30_000, reason: 'retry-after' });
  });

  it('uses an HTTP-date header relative to the supplied current time', () => {
    const decision = decide(
      statusError(503, { 'retry-after': 'Wed, 21 Oct 2015 07:28:45 GMT' }),
      idempotent,
    );
    expect(decision).toEqual({ retry: true, delayMs: 45_000, reason: 'retry-after' });
  });

  it('clamps a past HTTP-date to zero rather than to a negative delay', () => {
    const decision = decide(
      statusError(503, { 'retry-after': 'Wed, 21 Oct 2015 07:20:00 GMT' }),
      idempotent,
    );
    expect(decision).toEqual({ retry: true, delayMs: 0, reason: 'retry-after' });
  });

  it('clamps an oversized header to maxRetryAfterMs', () => {
    const decision = decide(statusError(429, { 'retry-after': '600' }), idempotent);
    expect(decision).toEqual({
      retry: true,
      delayMs: DEFAULT_MAX_RETRY_AFTER_MS,
      reason: 'retry-after',
    });

    const tighter = decide(statusError(429, { 'retry-after': '600' }), {
      ...idempotent,
      maxRetryAfterMs: 5_000,
    });
    expect(tighter).toEqual({ retry: true, delayMs: 5_000, reason: 'retry-after' });
  });

  it('falls back to the jittered schedule for an unparseable header', () => {
    const decision = decide(statusError(503, { 'retry-after': 'soon' }), idempotent, {
      random: one,
    });
    expect(decision).toEqual({ retry: true, delayMs: 1_000, reason: 'status' });
  });

  it('ignores the header when honorRetryAfter is false', () => {
    const decision = decide(
      statusError(429, { 'retry-after': '30' }),
      { ...idempotent, honorRetryAfter: false },
      { random: one },
    );
    expect(decision).toEqual({ retry: true, delayMs: 1_000, reason: 'status' });
  });

  it('applies the exponential schedule per attempt when no header applies', () => {
    const policy: NodeRetryPolicy = { idempotent: true, maxAttempts: 5, honorRetryAfter: false };
    for (const [attempt, ceiling] of [
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
      [4, 8_000],
    ] as const) {
      expect(decide(statusError(503), policy, { attempt, random: one }).delayMs).toBe(ceiling);
      expect(decide(statusError(503), policy, { attempt, random: zero }).delayMs).toBe(0);
    }
  });

  it('caps the schedule at maxBackoffMs', () => {
    const decision = decide(
      statusError(503),
      { idempotent: true, maxAttempts: 5, honorRetryAfter: false, maxBackoffMs: 2_500 },
      { attempt: 4, random: one },
    );
    expect(decision.delayMs).toBe(2_500);
  });
});
