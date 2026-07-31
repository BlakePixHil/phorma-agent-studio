import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareWatermark,
  isIsoWatermark,
  isNumericWatermark,
  maxWatermark,
  scopedStateKey,
  watermarkStateKey,
} from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';

/**
 * Property 6: State primitives are idempotent, isolated and order-independent
 * (design §8.4) — claim 29, **Watermark monotonicity**:
 *
 *   ∀ sequence of watermark writes `W`: the final stored value equals `max(W)`
 *   under `compareWatermark`, for every permutation of `W`.
 *
 * `compareWatermark` is the order that claim rests on, so the total-order laws
 * (Requirement 12.15) are asserted first, then the store-level convergence of the
 * `semantics: 'watermark'` write rule (Requirement 12.8).
 *
 * **Scope note.** `compareWatermark` compares numerically only when BOTH sides
 * parse as finite numbers, and falls back to string compare otherwise. Mixing
 * shapes inside one stream (a numeric id against a timestamp) therefore mixes two
 * orders, which `state.ts` documents as unsupported — so the transitivity and
 * convergence properties quantify over watermark sets drawn from ONE shape, which
 * is what a real `wm:{stream}` key holds.
 *
 * **Validates: Requirements 12.8, 12.15**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators — one arbitrary per watermark shape, plus arbitrary text
// ─────────────────────────────────────────────────────────────────────────────

/** Plain numeric literals: the shape compared numerically. */
const numericWatermarkArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map((n) => n.toFixed(4)),
  fc.integer({ min: 0, max: 999 }).map((n) => `${n}e3`),
);

/**
 * Canonical UTC instants (`YYYY-MM-DDTHH:MM:SS.sssZ`). Fixed width and fixed
 * offset, so lexicographic order is chronological order.
 */
const isoWatermarkArb: fc.Arbitrary<string> = fc
  .integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

/** Opaque cursors: neither numeric nor ISO, so compared as plain strings. */
const opaqueWatermarkArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/),
    fc.constantFrom('', 'cursor', 'ZZZ', 'v2:abc'),
  )
  .filter((value) => !isNumericWatermark(value) && !isIsoWatermark(value));

/** One shape per generated case: watermark lists a real stream could hold. */
const sameShapeWatermarksArb = (
  options: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<string[]> =>
  fc.oneof(numericWatermarkArb, isoWatermarkArb, opaqueWatermarkArb).chain((seed) =>
    fc.array(
      isNumericWatermark(seed)
        ? numericWatermarkArb
        : isIsoWatermark(seed)
          ? isoWatermarkArb
          : opaqueWatermarkArb,
      { minLength: options.minLength ?? 1, maxLength: options.maxLength ?? 8 },
    ),
  );

/** A list paired with a permutation of itself. */
const listWithPermutationArb = (): fc.Arbitrary<{ values: string[]; shuffled: string[] }> =>
  sameShapeWatermarksArb({ minLength: 1, maxLength: 8 }).chain((values) =>
    fc
      .shuffledSubarray(values, { minLength: values.length, maxLength: values.length })
      .map((shuffled) => ({ values, shuffled: [...shuffled] })),
  );

/** Any string at all, including empty, whitespace and lone-surrogate text. */
const anyTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 24 }),
  numericWatermarkArb,
  isoWatermarkArb,
  fc.constantFrom('', ' ', '\u0000', '\uD800', 'NaN', 'Infinity', '0x10', '007'),
);

/** The greatest element of a non-empty list under `compareWatermark`. */
function maxOf(values: readonly string[]): string {
  return values.reduce((best, next) => maxWatermark(best, next));
}

/** `-n` without producing `-0`, which `toBe` treats as distinct from `0`. */
function negate(n: number): -1 | 0 | 1 {
  return (n === 0 ? 0 : -n) as -1 | 0 | 1;
}

/** `Math.sign` without producing `-0`. */
function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The write rule under test (Requirement 12.8), expressed over the primitives
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'wf-watermark';
const STREAM_KEY = scopedStateKey(WORKFLOW_ID, watermarkStateKey('jobs'));

/**
 * `state-set` with `semantics: 'watermark'`: `changed` is true when the key is
 * absent or the new value orders above the stored value, and only then is the
 * value written. Mirrors design §8.4 / Requirement 12.8 using nothing but the
 * state primitives, so the property tests the order, not an engine re-write.
 */
async function applyWatermark(
  store: MemoryStateStore,
  key: string,
  value: string,
): Promise<boolean> {
  const previous = await store.get(key);
  const changed = previous === undefined || compareWatermark(value, previous.value) > 0;
  if (changed) await store.set(key, value);
  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 12.15 — total order
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6 (claim 29): compareWatermark is a total order', () => {
  it('returns -1, 0 or 1 for any two strings and never throws', () => {
    fc.assert(
      fc.property(anyTextArb, anyTextArb, (a, b) => {
        const result = compareWatermark(a, b);
        expect([-1, 0, 1]).toContain(result);
      }),
    );
  });

  it('is reflexive: every value compares equal to itself', () => {
    fc.assert(
      fc.property(anyTextArb, (a) => {
        expect(compareWatermark(a, a)).toBe(0);
      }),
    );
  });

  it('is antisymmetric: compare(a, b) === -compare(b, a)', () => {
    fc.assert(
      fc.property(anyTextArb, anyTextArb, (a, b) => {
        expect(compareWatermark(a, b)).toBe(negate(compareWatermark(b, a)));
      }),
    );
  });

  it('is transitive within one watermark shape', () => {
    fc.assert(
      fc.property(sameShapeWatermarksArb({ minLength: 3, maxLength: 3 }), ([a, b, c]) => {
        const ab = compareWatermark(a!, b!);
        const bc = compareWatermark(b!, c!);
        if (ab <= 0 && bc <= 0) expect(compareWatermark(a!, c!)).toBeLessThanOrEqual(0);
        if (ab >= 0 && bc >= 0) expect(compareWatermark(a!, c!)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('compares numerically when both sides parse as finite numbers', () => {
    fc.assert(
      fc.property(numericWatermarkArb, numericWatermarkArb, (a, b) => {
        expect(isNumericWatermark(a) && isNumericWatermark(b)).toBe(true);
        expect(compareWatermark(a, b)).toBe(sign(Number(a) - Number(b)));
      }),
    );
  });

  it('orders canonical ISO instants chronologically', () => {
    fc.assert(
      fc.property(isoWatermarkArb, isoWatermarkArb, (a, b) => {
        expect(isIsoWatermark(a) && isIsoWatermark(b)).toBe(true);
        expect(compareWatermark(a, b)).toBe(sign(Date.parse(a) - Date.parse(b)));
      }),
    );
  });

  it('makes max well defined: maxWatermark folds to a greatest element in any order', () => {
    fc.assert(
      fc.property(listWithPermutationArb(), ({ values, shuffled }) => {
        const best = maxOf(values);
        expect(compareWatermark(maxOf(shuffled), best)).toBe(0);
        for (const value of values) {
          expect(compareWatermark(best, value)).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 12.8 / claim 29 — monotonic convergence of watermark writes
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6 (claim 29): watermark writes converge on max(W)', () => {
  it('stores max(W) whatever the order the writes arrive in', async () => {
    await fc.assert(
      fc.asyncProperty(listWithPermutationArb(), async ({ values, shuffled }) => {
        const inOrder = new MemoryStateStore();
        for (const value of values) await applyWatermark(inOrder, STREAM_KEY, value);

        const permuted = new MemoryStateStore();
        for (const value of shuffled) await applyWatermark(permuted, STREAM_KEY, value);

        const expected = maxOf(values);
        const left = await inOrder.get(STREAM_KEY);
        const right = await permuted.get(STREAM_KEY);
        expect(left?.value).toBeDefined();
        expect(compareWatermark(left!.value, expected)).toBe(0);
        expect(compareWatermark(right!.value, left!.value)).toBe(0);
      }),
    );
  });

  it('never moves the stored watermark backwards, at any point in the sequence', async () => {
    await fc.assert(
      fc.asyncProperty(sameShapeWatermarksArb({ minLength: 1, maxLength: 8 }), async (values) => {
        const store = new MemoryStateStore();
        let previous: string | undefined;
        for (const value of values) {
          const changed = await applyWatermark(store, STREAM_KEY, value);
          const current = (await store.get(STREAM_KEY))?.value;
          expect(current).toBeDefined();
          if (previous !== undefined) {
            expect(compareWatermark(current!, previous)).toBeGreaterThanOrEqual(0);
            // `changed` is reported exactly when the value actually advanced.
            expect(changed).toBe(compareWatermark(current!, previous) > 0);
          }
          previous = current;
        }
      }),
    );
  });

  it('is idempotent: replaying the same writes changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(sameShapeWatermarksArb({ minLength: 1, maxLength: 8 }), async (values) => {
        const store = new MemoryStateStore();
        for (const value of values) await applyWatermark(store, STREAM_KEY, value);
        const settled = (await store.get(STREAM_KEY))!.value;

        for (const value of values) {
          expect(await applyWatermark(store, STREAM_KEY, value)).toBe(false);
        }
        expect((await store.get(STREAM_KEY))!.value).toBe(settled);
      }),
    );
  });

  it('keeps one stream per key: writes to one stream never advance another', async () => {
    await fc.assert(
      fc.asyncProperty(
        sameShapeWatermarksArb({ minLength: 1, maxLength: 6 }),
        sameShapeWatermarksArb({ minLength: 1, maxLength: 6 }),
        async (jobs, invoices) => {
          const store = new MemoryStateStore();
          const jobsKey = scopedStateKey(WORKFLOW_ID, watermarkStateKey('jobs'));
          const invoicesKey = scopedStateKey(WORKFLOW_ID, watermarkStateKey('invoices'));
          for (const value of jobs) await applyWatermark(store, jobsKey, value);
          for (const value of invoices) await applyWatermark(store, invoicesKey, value);

          expect(compareWatermark((await store.get(jobsKey))!.value, maxOf(jobs))).toBe(0);
          expect(compareWatermark((await store.get(invoicesKey))!.value, maxOf(invoices))).toBe(0);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Table-driven cases for the three comparison shapes (design "Unit tests")
// ─────────────────────────────────────────────────────────────────────────────

describe('compareWatermark table cases', () => {
  const CASES: ReadonlyArray<readonly [string, string, -1 | 0 | 1]> = [
    ['1', '2', -1],
    ['10', '9', 1],
    ['1.0', '1', 0],
    ['1e3', '1000', 0],
    ['-5', '3', -1],
    ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', -1],
    ['2024-02-01T00:00:00.000Z', '2024-01-31T23:59:59.999Z', 1],
    ['2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 0],
    ['cursor-a', 'cursor-b', -1],
    ['', 'a', -1],
    ['', '', 0],
  ];

  it.each(CASES)('compareWatermark(%j, %j) === %i', (a, b, expected) => {
    expect(compareWatermark(a, b)).toBe(expected);
    expect(compareWatermark(b, a)).toBe(negate(expected));
  });

  it('classifies shapes as documented', () => {
    expect(isNumericWatermark('42')).toBe(true);
    expect(isNumericWatermark('')).toBe(false);
    expect(isNumericWatermark('2024-01-01')).toBe(false);
    expect(isIsoWatermark('2024-01-01')).toBe(true);
    expect(isIsoWatermark('2024-01-01T00:00:00.000Z')).toBe(true);
    expect(isIsoWatermark('cursor')).toBe(false);
  });

  it('returns the greater side from maxWatermark, preferring the left on a tie', () => {
    expect(maxWatermark('9', '10')).toBe('10');
    expect(maxWatermark('1.0', '1')).toBe('1.0');
  });
});
