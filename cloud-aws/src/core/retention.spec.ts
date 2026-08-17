/**
 * Unit tests for retention TTL computation and read-time exclusion.
 *
 * Requirements: 4.8, 11.5, 11.10
 */

import { describe, it, expect } from 'vitest';
import { computeTtl, isExpired, validateRetentionDays } from './retention.js';

// ---------------------------------------------------------------------------
// validateRetentionDays
// ---------------------------------------------------------------------------

describe('validateRetentionDays', () => {
  it('defaults to 30 when undefined', () => {
    expect(validateRetentionDays(undefined)).toBe(30);
  });

  it('defaults to 30 when null', () => {
    expect(validateRetentionDays(null)).toBe(30);
  });

  it('accepts 1 (minimum)', () => {
    expect(validateRetentionDays(1)).toBe(1);
  });

  it('accepts 366 (maximum)', () => {
    expect(validateRetentionDays(366)).toBe(366);
  });

  it('accepts 30 (default value explicitly)', () => {
    expect(validateRetentionDays(30)).toBe(30);
  });

  it('rejects 0', () => {
    expect(() => validateRetentionDays(0)).toThrow(RangeError);
  });

  it('rejects 367', () => {
    expect(() => validateRetentionDays(367)).toThrow(RangeError);
  });

  it('rejects negative values', () => {
    expect(() => validateRetentionDays(-1)).toThrow(RangeError);
  });

  it('rejects fractional values', () => {
    expect(() => validateRetentionDays(30.5)).toThrow(RangeError);
    expect(() => validateRetentionDays(1.1)).toThrow(RangeError);
  });

  it('rejects non-number types', () => {
    expect(() => validateRetentionDays('30')).toThrow(RangeError);
    expect(() => validateRetentionDays(true)).toThrow(RangeError);
    expect(() => validateRetentionDays({})).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// computeTtl
// ---------------------------------------------------------------------------

describe('computeTtl', () => {
  it('computes TTL in epoch seconds with default 30 days', () => {
    const createdAtMs = 1_700_000_000_000; // some fixed timestamp
    const ttl = computeTtl(createdAtMs);
    const expectedMs = createdAtMs + 30 * 86_400_000;
    expect(ttl).toBe(Math.floor(expectedMs / 1000));
  });

  it('computes TTL with explicit retention days', () => {
    const createdAtMs = 1_700_000_000_000;
    const ttl = computeTtl(createdAtMs, 7);
    const expectedMs = createdAtMs + 7 * 86_400_000;
    expect(ttl).toBe(Math.floor(expectedMs / 1000));
  });

  it('computes TTL with 1 day retention', () => {
    const createdAtMs = 1_700_000_000_000;
    const ttl = computeTtl(createdAtMs, 1);
    const expectedMs = createdAtMs + 86_400_000;
    expect(ttl).toBe(Math.floor(expectedMs / 1000));
  });

  it('computes TTL with 366 day retention', () => {
    const createdAtMs = 1_700_000_000_000;
    const ttl = computeTtl(createdAtMs, 366);
    const expectedMs = createdAtMs + 366 * 86_400_000;
    expect(ttl).toBe(Math.floor(expectedMs / 1000));
  });

  it('returns epoch seconds (not milliseconds)', () => {
    const createdAtMs = 1_700_000_000_000;
    const ttl = computeTtl(createdAtMs, 30);
    // TTL should be roughly createdAtMs/1000 + 30 days in seconds
    expect(ttl).toBe(1_700_000_000 + 30 * 86_400);
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('returns false when item has no ttl', () => {
    expect(isExpired({}, 1_700_000_000_000)).toBe(false);
  });

  it('returns false when item ttl is undefined', () => {
    expect(isExpired({ ttl: undefined }, 1_700_000_000_000)).toBe(false);
  });

  it('returns true when now is past the ttl', () => {
    const ttl = 1_700_000_000; // epoch seconds
    const nowMs = 1_700_000_001_000; // 1 second after ttl
    expect(isExpired({ ttl }, nowMs)).toBe(true);
  });

  it('returns true when now equals the ttl exactly', () => {
    const ttl = 1_700_000_000;
    const nowMs = 1_700_000_000_000; // exactly at ttl
    expect(isExpired({ ttl }, nowMs)).toBe(true);
  });

  it('returns false when now is before the ttl', () => {
    const ttl = 1_700_000_000;
    const nowMs = 1_699_999_999_000; // 1 second before ttl
    expect(isExpired({ ttl }, nowMs)).toBe(false);
  });

  it('works with computeTtl output', () => {
    const createdAtMs = 1_700_000_000_000;
    const retentionDays = 30;
    const ttl = computeTtl(createdAtMs, retentionDays);

    // Just before expiry - not expired
    const justBeforeMs = createdAtMs + retentionDays * 86_400_000 - 1000;
    expect(isExpired({ ttl }, justBeforeMs)).toBe(false);

    // At expiry - expired
    const atExpiryMs = createdAtMs + retentionDays * 86_400_000;
    expect(isExpired({ ttl }, atExpiryMs)).toBe(true);

    // After expiry - expired
    const afterMs = createdAtMs + retentionDays * 86_400_000 + 1000;
    expect(isExpired({ ttl }, afterMs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 13: Retention excludes an expired item from every read
// Validates: Requirements 4.8, 11.5, 11.10
// ---------------------------------------------------------------------------

import fc from 'fast-check';
import { retentionDaysEdge } from '../test/generators.js';

describe('Property 13: Retention excludes an expired item from every read', () => {
  it('for valid retention days (1-366): item is NOT expired before its TTL and IS expired at/after its TTL', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 366 }),
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        (retentionDays, createdAtMs) => {
          const ttl = computeTtl(createdAtMs, retentionDays);
          const expiryMs = ttl * 1000;

          // Not expired 1 second before the TTL
          expect(isExpired({ ttl }, expiryMs - 1000)).toBe(false);

          // Expired exactly at the TTL
          expect(isExpired({ ttl }, expiryMs)).toBe(true);

          // Expired 1 second after the TTL
          expect(isExpired({ ttl }, expiryMs + 1000)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for invalid retention days (0, 367, 30.5): validateRetentionDays throws RangeError', () => {
    fc.assert(
      fc.property(
        retentionDaysEdge().filter(d => d === 0 || d === 367 || d === 30.5 || !Number.isInteger(d) || d < 1 || d > 366),
        (days) => {
          expect(() => validateRetentionDays(days)).toThrow(RangeError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('an item with no TTL is never expired', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (nowMs) => {
          expect(isExpired({}, nowMs)).toBe(false);
          expect(isExpired({ ttl: undefined }, nowMs)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('TTL computed by computeTtl with a given retention correctly gates the isExpired predicate', () => {
    fc.assert(
      fc.property(
        retentionDaysEdge().filter(d => Number.isInteger(d) && d >= 1 && d <= 366),
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        fc.integer({ min: 0, max: 400 * 86_400_000 }),
        (retentionDays, createdAtMs, elapsedMs) => {
          const ttl = computeTtl(createdAtMs, retentionDays);
          const checkMs = createdAtMs + elapsedMs;
          const retentionMs = retentionDays * 86_400_000;

          if (elapsedMs < retentionMs) {
            // Before retention period expires - item should NOT be expired
            // (with a 1-second floor due to second-precision TTL)
            const ttlBoundarySec = ttl;
            const checkSec = Math.floor(checkMs / 1000);
            if (checkSec < ttlBoundarySec) {
              expect(isExpired({ ttl }, checkMs)).toBe(false);
            }
          } else {
            // At or after retention period - item should be expired
            expect(isExpired({ ttl }, checkMs)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
