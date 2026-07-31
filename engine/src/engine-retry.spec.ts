/**
 * Unit tests for the shared non-model retry wrapper (`withNodeRetry`, design §6).
 *
 * The loop is exercised through its exported form, `runWithNodeRetry`, which is
 * what the engine's private `withNodeRetry` delegates to — same code path, no
 * graph required.
 */

import { describe, expect, it } from 'vitest';

import { DataTransportError, HttpStatusError } from './data-host.js';
import {
  RETRY_ERROR_DESCRIPTION_MAX_CHARS,
  describeRetryError,
  formatRetryEventError,
  runWithNodeRetry,
  type NodeRetryNotice,
} from './engine.js';
import { RunStoppedError } from './gate.js';
import type { NodeRetryPolicy } from './types.js';

interface Harness {
  notices: NodeRetryNotice[];
  slept: number[];
  ctx: Parameters<typeof runWithNodeRetry>[2];
}

/** A deterministic context: fixed clock, fixed random draw, instant sleeps. */
function harness(overrides: Partial<Harness['ctx']> = {}): Harness {
  const notices: NodeRetryNotice[] = [];
  const slept: number[] = [];
  return {
    notices,
    slept,
    ctx: {
      onRetry: notice => notices.push(notice),
      sleep: async ms => {
        slept.push(ms);
      },
      now: () => 1_000_000,
      random: () => 0.5,
      ...overrides,
    },
  };
}

const IDEMPOTENT: NodeRetryPolicy = { maxAttempts: 3, backoffMs: 10, idempotent: true };

describe('runWithNodeRetry', () => {
  it('returns the first successful result without emitting a retry (11.1)', async () => {
    const h = harness();
    let calls = 0;

    const result = await runWithNodeRetry(
      IDEMPOTENT,
      async attempt => {
        calls++;
        return `ok:${attempt}`;
      },
      h.ctx,
    );

    expect(result).toBe('ok:1');
    expect(calls).toBe(1);
    expect(h.notices).toEqual([]);
  });

  it('invokes the body at most maxAttempts times and emits one event per retry (11.2, 11.10, 11.13)', async () => {
    const h = harness();
    let calls = 0;

    await expect(
      runWithNodeRetry(
        IDEMPOTENT,
        async () => {
          calls++;
          throw new HttpStatusError(503, {}, '');
        },
        h.ctx,
      ),
    ).rejects.toBeInstanceOf(HttpStatusError);

    expect(calls).toBe(3);
    // One event per SCHEDULED retry — never for the final failure.
    expect(h.notices).toHaveLength(2);
    expect(h.notices.map(notice => notice.attempt)).toEqual([1, 2]);
    expect(h.notices.every(notice => notice.maxAttempts === 3)).toBe(true);
    expect(h.slept).toHaveLength(2);
  });

  it('succeeds on a later attempt and reports the attempt number it took', async () => {
    const h = harness();
    let calls = 0;

    const result = await runWithNodeRetry(
      IDEMPOTENT,
      async attempt => {
        calls++;
        if (attempt < 3) throw new DataTransportError('connect', 'refused');
        return 'recovered';
      },
      h.ctx,
    );

    expect(result).toBe('recovered');
    expect(calls).toBe(3);
    expect(h.notices.map(notice => notice.reason)).toEqual(['transport', 'transport']);
  });

  it('runs the body once and emits nothing when the policy is disabled (11.3)', async () => {
    const h = harness();
    let calls = 0;
    const failure = new HttpStatusError(429, { 'retry-after': '1' }, '');

    await expect(
      runWithNodeRetry({ ...IDEMPOTENT, disabled: true }, async () => {
        calls++;
        throw failure;
      }, h.ctx),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(h.notices).toEqual([]);
    expect(h.slept).toEqual([]);
  });

  it('never repeats a non-idempotent step whose request may have landed (11.4)', async () => {
    const h = harness();
    let calls = 0;

    await expect(
      runWithNodeRetry({ maxAttempts: 5, backoffMs: 10 }, async () => {
        calls++;
        throw new HttpStatusError(500, {}, '');
      }, h.ctx),
    ).rejects.toBeInstanceOf(HttpStatusError);

    expect(calls).toBe(1);
    expect(h.notices).toEqual([]);
  });

  it('sleeps the Retry-After delay through the injected sleep (11.6, 11.11)', async () => {
    const h = harness();

    await expect(
      runWithNodeRetry(
        { maxAttempts: 2, backoffMs: 10, idempotent: true, maxRetryAfterMs: 5_000 },
        async () => {
          throw new HttpStatusError(429, { 'retry-after': '120' }, '');
        },
        h.ctx,
      ),
    ).rejects.toBeInstanceOf(HttpStatusError);

    // 120s parsed, clamped to the policy ceiling, and the exponential schedule
    // is ignored for that attempt.
    expect(h.slept).toEqual([5_000]);
    expect(h.notices[0]?.reason).toBe('retry-after');
    expect(h.notices[0]?.delayMs).toBe(5_000);
  });

  it('propagates a stop raised by the body with no event and no further attempt (11.12)', async () => {
    const h = harness();
    let calls = 0;

    await expect(
      runWithNodeRetry(IDEMPOTENT, async () => {
        calls++;
        throw new RunStoppedError();
      }, h.ctx),
    ).rejects.toBeInstanceOf(RunStoppedError);

    expect(calls).toBe(1);
    expect(h.notices).toEqual([]);
  });

  it('abandons a pending delay when the run stops mid-sleep (11.12)', async () => {
    let calls = 0;
    const h = harness({
      sleep: async () => {
        throw new RunStoppedError();
      },
    });

    await expect(
      runWithNodeRetry(IDEMPOTENT, async () => {
        calls++;
        throw new HttpStatusError(503, {}, '');
      }, h.ctx),
    ).rejects.toBeInstanceOf(RunStoppedError);

    // The retry that was announced never started: exactly one body invocation.
    expect(calls).toBe(1);
    expect(h.notices).toHaveLength(1);
  });

  it('stops after the delay when the gate reports a stop without throwing (11.12)', async () => {
    let calls = 0;
    const h = harness({ stopped: () => true });

    await expect(
      runWithNodeRetry(IDEMPOTENT, async () => {
        calls++;
        throw new DataTransportError('dns', 'no such host');
      }, h.ctx),
    ).rejects.toBeInstanceOf(RunStoppedError);

    expect(calls).toBe(1);
  });

  it('waits for a resume before starting the next attempt (11.11)', async () => {
    const order: string[] = [];
    let release = (): void => {};
    const resumed = new Promise<void>(resolve => {
      release = resolve;
    });
    const h = harness({
      sleep: async () => {
        order.push('slept');
      },
      awaitResume: async () => {
        order.push('await-resume');
        await resumed;
        order.push('resumed');
      },
    });

    let calls = 0;
    const running = runWithNodeRetry(
      IDEMPOTENT,
      async attempt => {
        calls++;
        order.push(`attempt:${attempt}`);
        if (attempt === 1) throw new DataTransportError('tls', 'handshake failed');
        return 'done';
      },
      h.ctx,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await expect(running).resolves.toBe('done');
    expect(order).toEqual(['attempt:1', 'slept', 'await-resume', 'resumed', 'attempt:2']);
  });
});

describe('describeRetryError', () => {
  it('reports a status failure without its body', () => {
    const description = describeRetryError(new HttpStatusError(429, {}, 'token=sk-secret-value'));
    expect(description).toBe('HTTP 429');
  });

  it('names the transport failure kind', () => {
    expect(describeRetryError(new DataTransportError('timeout', 'took too long'))).toBe(
      'timeout: took too long',
    );
  });

  it('applies the host redactor before clipping (11.10)', () => {
    const description = describeRetryError(new Error('bearer sk-live-1234567890 rejected'), value =>
      value.replace('sk-live-1234567890', '***'),
    );
    expect(description).toBe('bearer *** rejected');
    expect(description).not.toContain('sk-live-1234567890');
  });

  it('clips a very long description', () => {
    const description = describeRetryError(new Error('x'.repeat(2_000)));
    expect(description).toHaveLength(RETRY_ERROR_DESCRIPTION_MAX_CHARS + 1);
    expect(description.endsWith('…')).toBe(true);
  });

  it('renders a non-Error rejection', () => {
    expect(describeRetryError('plain failure')).toBe('plain failure');
  });
});

describe('formatRetryEventError', () => {
  it('carries the decision reason in the single event field (11.10)', () => {
    expect(formatRetryEventError('HTTP 429', 'retry-after')).toBe(
      'HTTP 429 (retry reason: retry-after)',
    );
  });
});
