import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_SIZE, batchItems, resolveBatchSize } from './data-nodes.js';
import { jsonArb, type Json } from './test/generators.js';

/**
 * Property 4: Batching is a lossless regrouping (design §5.5) — claims 18, 19
 * and 20.
 *
 * Claim 18, **Flatten identity**:
 *   ∀ `xs`, ∀ `n ≥ 1`: `flatten(batchItems(xs, n)) === xs`, with the same order
 *   and multiplicity (Requirement 9.10).
 *
 * Claim 19, **Batch sizing**:
 *   ∀ `xs`, `n` in range: `len(batches) === ceil(len(xs)/n)`, every batch holds
 *   1 to `n` items, and only the last may be short (Requirement 9.8).
 *
 * Claim 20, **Pass-through**:
 *   ∀ `xs`: `batchItems(xs, 1) === xs` and `batchItems(xs, undefined) === xs` —
 *   extended here to every value {@link resolveBatchSize} rejects, since
 *   Requirement 9.9 makes them all one behaviour.
 *
 * "Flatten" is deliberately not `Array.prototype.flat`: an item may itself be an
 * array, so the concatenation is driven by {@link resolveBatchSize} — the same
 * question a caller asks to decide what to report as `loop-started.total` — rather
 * than by inspecting the shape of the returned elements. Items are drawn from the
 * full `Json` domain (including nested arrays, `null` and duplicates) precisely so
 * a shape-sniffing flatten would fail this suite.
 *
 * Conservation is checked by reference identity per position, not just deep
 * equality, which rules out a clone or a reorder that happens to compare equal.
 *
 * **Validates: Requirements 9.8, 9.9, 9.10**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source items over the whole `Json` domain, biased so duplicates and nested
 * arrays are common: an item that is itself an array is the case a naive flatten
 * gets wrong, and repeated items are what makes "multiplicity preserved" bite.
 */
const itemArb: fc.Arbitrary<Json> = fc.oneof(
  { weight: 3, arbitrary: jsonArb({ maxDepth: 2, maxArrayLength: 3 }) },
  { weight: 2, arbitrary: fc.constantFrom<Json>('dup', 0, null, [], ['dup'], [['dup']]) },
);

const itemsArb: fc.Arbitrary<Json[]> = fc.array(itemArb, { maxLength: 40 });

/** In-range batch sizes, skewed small so short final batches are frequent. */
const batchSizeArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 2, max: 7 }) },
  { weight: 1, arbitrary: fc.integer({ min: 8, max: 64 }) },
  { weight: 1, arbitrary: fc.constantFrom(2, MAX_BATCH_SIZE) },
);

/**
 * Every kind of value Requirement 9.9 folds into per-item iteration: absent,
 * non-numeric, non-integer, `NaN`, an infinity, zero, one, negative, and above
 * {@link MAX_BATCH_SIZE}.
 */
const rejectedBatchSizeArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    undefined,
    null,
    1,
    0,
    -0,
    true,
    '2',
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    MAX_BATCH_SIZE + 1,
  ),
  fc.integer({ min: -1000, max: 1 }),
  fc.integer({ min: MAX_BATCH_SIZE + 1, max: 1_000_000 }),
  fc.double({ min: 1.01, max: 500, noNaN: true, noDefaultInfinity: true }).filter(
    (value) => !Number.isInteger(value),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// Oracle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The item sequence the loop would iterate over, flattened one level when — and
 * only when — batch mode is active.
 */
function flattenIterations<T>(items: readonly T[], batchSize: unknown): T[] {
  const result = batchItems(items, batchSize);
  if (resolveBatchSize(batchSize) === undefined) return [...(result as readonly T[])];

  const flat: T[] = [];
  for (const batch of result as readonly T[][]) flat.push(...batch);
  return flat;
}

/** Positional reference identity — stronger than deep equality. */
function expectSameItems<T>(actual: readonly T[], expected: readonly T[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(Object.is(actual[i], expected[i]), `item ${i}`).toBe(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 18: flatten identity
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 4 claim 18: flatten identity', () => {
  it('concatenating the batches reproduces the source list exactly', () => {
    fc.assert(
      fc.property(itemsArb, batchSizeArb, (items, size) => {
        const snapshot = [...items];
        expectSameItems(flattenIterations(items, size), snapshot);
        // The source list is untouched by the regrouping.
        expectSameItems(items, snapshot);
      }),
    );
  });

  it('holds for every rejected batch size too, where each iteration is one item', () => {
    fc.assert(
      fc.property(itemsArb, rejectedBatchSizeArb, (items, size) => {
        expectSameItems(flattenIterations(items, size), [...items]);
      }),
    );
  });

  it('holds for a long source list at the largest accepted batch size', () => {
    const source = Array.from({ length: 100_000 }, (_, i) => i);
    const batches = batchItems(source, MAX_BATCH_SIZE) as readonly number[][];

    expect(batches).toHaveLength(Math.ceil(source.length / MAX_BATCH_SIZE));
    expectSameItems(flattenIterations(source, MAX_BATCH_SIZE), source);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 19: batch sizing
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 4 claim 19: batch sizing', () => {
  it('emits ceil(n / size) batches, only the last of which may be short', () => {
    fc.assert(
      fc.property(itemsArb, batchSizeArb, (items, size) => {
        const batches = batchItems(items, size) as readonly Json[][];

        expect(batches).toHaveLength(Math.ceil(items.length / size));

        batches.forEach((batch, index) => {
          const isLast = index === batches.length - 1;
          expect(Array.isArray(batch), `batch ${index} is an array`).toBe(true);
          expect(batch.length, `batch ${index} lower bound`).toBeGreaterThanOrEqual(1);
          expect(batch.length, `batch ${index} upper bound`).toBeLessThanOrEqual(size);
          if (!isLast) expect(batch.length, `batch ${index} is full`).toBe(size);
        });
      }),
    );
  });

  it('runs zero iterations for an empty source list in either mode', () => {
    fc.assert(
      fc.property(fc.oneof(batchSizeArb, rejectedBatchSizeArb), (size) => {
        expect(batchItems([], size)).toHaveLength(0);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 20: pass-through
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 4 claim 20: pass-through', () => {
  it('returns the source array itself for any size outside 2..MAX_BATCH_SIZE', () => {
    fc.assert(
      fc.property(itemsArb, rejectedBatchSizeArb, (items, size) => {
        expect(resolveBatchSize(size)).toBeUndefined();
        expect(batchItems(items, size)).toBe(items);
      }),
    );
  });

  it('never returns the source array itself once batch mode is active', () => {
    fc.assert(
      fc.property(
        itemsArb.filter((items) => items.length > 0),
        batchSizeArb,
        (items, size) => {
          expect(batchItems(items, size)).not.toBe(items);
        },
      ),
    );
  });
});
