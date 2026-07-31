import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_CLAIMED,
  claimIdempotent,
  idempotencyStateKey,
  scopedStateKey,
  utf8ByteLength,
} from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';

/**
 * Property 6: State primitives are idempotent, isolated and order-independent —
 * the store contract (claims 27, 28, 33).
 *
 * **Validates: Requirements 12.2, 12.13, 12.20**
 *
 * 27. Round-trip. ∀ key `k`, value `v`: `set(k, v)` then `get(k)` yields `v`
 *     byte-identical, with `updatedAt` equal to the time of that write (12.20).
 * 28. CAS mutual exclusion. ∀ set of concurrent `compareAndSet(k, undefined, …)`
 *     calls: exactly one resolves `true` (12.13).
 * 33. Workflow isolation. ∀ workflows `a ≠ b`, ∀ key `k`: writes under `a` are
 *     invisible to reads under `b` (12.2).
 *
 * `MemoryStateStore` implements the whole host contract, so what holds here is
 * what the desktop (IndexedDB) and worker (DO SQLite) stores must also provide.
 */

/** A fixed epoch the injected clock starts from, so failures read cleanly. */
const EPOCH = 1_700_000_000_000;

/** Mutable clock: tests advance it explicitly instead of waiting. */
function fixedClock(start = EPOCH): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * Workflow ids never contain the `::` scope separator (they are slugs), so a
 * scoped key parses back to exactly one workflow.
 */
const workflowIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,12}$/)
  .filter((id) => id.length > 0);

/** Caller-supplied keys: user keys and reserved-namespace keys alike. */
const stateKeyArb: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9_:.-]{1,24}$/).filter((key) => key.length > 0),
  fc.constantFrom('cursor', 'delta:orders:1', 'wm:orders', 'idem:run-1', 'fx:node-1:abcd1234'),
);

/**
 * Values stay well inside the 32 KB per-value cap, but include full-unicode text
 * so "byte-identical" means more than "same ASCII".
 */
const stateValueArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ maxLength: 64 }),
    fc.string({ unit: 'binary', maxLength: 64 }),
    fc.json({ maxDepth: 2 }),
    fc.constantFrom('', '0', 'null', '  padded  ', '"quoted"', 'ключ', '🔑🔑🔑'),
  )
  .filter((value) => utf8ByteLength(value) <= 4096);

// ─────────────────────────────────────────────────────────────────────────────
// Claim 27 — round-trip (Requirement 12.20)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6, claim 27: set/get round-trip is byte-identical', () => {
  it('returns the written value and the write timestamp for every key', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb,
        fc.uniqueArray(fc.tuple(stateKeyArb, stateValueArb), {
          minLength: 1,
          maxLength: 12,
          selector: ([key]) => key,
        }),
        async (workflowId, pairs) => {
          const clock = fixedClock();
          const store = new MemoryStateStore({ now: clock.now });
          const writtenAt = new Map<string, number>();

          for (const [key, value] of pairs) {
            const scoped = scopedStateKey(workflowId, key);
            const at = clock.now();
            await store.set(scoped, value);
            writtenAt.set(scoped, at);
            clock.advance(1);
          }

          for (const [key, value] of pairs) {
            const scoped = scopedStateKey(workflowId, key);
            const entry = await store.get(scoped);
            expect(entry).toBeDefined();
            // Byte-identical, not merely equal after some parse/serialise cycle.
            expect(entry!.value).toBe(value);
            expect(utf8ByteLength(entry!.value)).toBe(utf8ByteLength(value));
            expect(entry!.key).toBe(scoped);
            expect(entry!.updatedAt).toBe(writtenAt.get(scoped));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('lets the last write for a key win, again byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb,
        stateKeyArb,
        fc.array(stateValueArb, { minLength: 2, maxLength: 6 }),
        async (workflowId, key, values) => {
          const clock = fixedClock();
          const store = new MemoryStateStore({ now: clock.now });
          const scoped = scopedStateKey(workflowId, key);

          let lastAt = clock.now();
          for (const value of values) {
            lastAt = clock.now();
            await store.set(scoped, value);
            clock.advance(1);
          }

          const entry = await store.get(scoped);
          expect(entry!.value).toBe(values[values.length - 1]);
          expect(entry!.updatedAt).toBe(lastAt);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 28 — CAS mutual exclusion (Requirement 12.13)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6, claim 28: concurrent compareAndSet elects exactly one winner', () => {
  it('resolves true for exactly one of N concurrent claims, whatever the interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb,
        stateKeyArb,
        fc.array(stateValueArb, { minLength: 2, maxLength: 8 }),
        async (workflowId, key, candidates) => {
          const store = new MemoryStateStore({ now: () => EPOCH });
          const scoped = scopedStateKey(workflowId, key);

          const outcomes = await Promise.all(
            candidates.map((value) => store.compareAndSet(scoped, undefined, value)),
          );

          expect(outcomes.filter((won) => won)).toHaveLength(1);
          const winner = candidates[outcomes.indexOf(true)];
          const entry = await store.get(scoped);
          expect(entry!.value).toBe(winner);
          // Only the winning claim mutated the store.
          expect(store.writes).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('claims an idempotency key for exactly one caller and skips every other', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb,
        fc.stringMatching(/^[a-zA-Z0-9_:-]{1,24}$/).filter((k) => k.length > 0),
        fc.integer({ min: 2, max: 8 }),
        async (workflowId, claimKey, callers) => {
          const store = new MemoryStateStore({ now: () => EPOCH });

          const outcomes = await Promise.all(
            Array.from({ length: callers }, () =>
              claimIdempotent(claimKey, store, { workflowId }),
            ),
          );

          expect(outcomes.filter((won) => won)).toHaveLength(1);
          const entry = await store.get(
            scopedStateKey(workflowId, idempotencyStateKey(claimKey)),
          );
          expect(entry!.value).toBe(IDEMPOTENCY_CLAIMED);

          // A later claim for the same key never wins again.
          expect(await claimIdempotent(claimKey, store, { workflowId })).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 33 — workflow isolation (Requirement 12.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6, claim 33: writes under one workflow are invisible to another', () => {
  it('hides get, list and compareAndSet across workflow scopes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(workflowIdArb, { minLength: 2, maxLength: 2 }),
        fc.uniqueArray(fc.tuple(stateKeyArb, stateValueArb), {
          minLength: 1,
          maxLength: 8,
          selector: ([key]) => key,
        }),
        stateValueArb,
        async ([workflowA, workflowB], pairs, otherValue) => {
          const store = new MemoryStateStore({ now: () => EPOCH });

          for (const [key, value] of pairs) {
            await store.set(scopedStateKey(workflowA, key), value);
          }

          for (const [key] of pairs) {
            // A read under B never observes A's entry.
            expect(await store.get(scopedStateKey(workflowB, key))).toBeUndefined();
            // Nor does an absent-expected CAS: it wins under B even though the
            // same unscoped key is occupied under A.
            expect(
              await store.compareAndSet(scopedStateKey(workflowB, key), undefined, otherValue),
            ).toBe(true);
          }

          // B's writes left A's values byte-identical.
          for (const [key, value] of pairs) {
            const entry = await store.get(scopedStateKey(workflowA, key));
            expect(entry!.value).toBe(value);
          }

          // A prefix scan is scoped too: each side sees only its own keys.
          const listedA = await store.list(scopedStateKey(workflowA, ''));
          const listedB = await store.list(scopedStateKey(workflowB, ''));
          expect(listedA).toHaveLength(pairs.length);
          expect(listedB).toHaveLength(pairs.length);
          for (const entry of listedA) {
            expect(entry.key.startsWith(`${workflowA}::`)).toBe(true);
          }
          for (const entry of listedB) {
            expect(entry.key.startsWith(`${workflowB}::`)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps an idempotency claim in one workflow from blocking another', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(workflowIdArb, { minLength: 2, maxLength: 2 }),
        fc.stringMatching(/^[a-zA-Z0-9_:-]{1,24}$/).filter((k) => k.length > 0),
        async ([workflowA, workflowB], claimKey) => {
          const store = new MemoryStateStore({ now: () => EPOCH });

          expect(await claimIdempotent(claimKey, store, { workflowId: workflowA })).toBe(true);
          expect(await claimIdempotent(claimKey, store, { workflowId: workflowB })).toBe(true);
          expect(await claimIdempotent(claimKey, store, { workflowId: workflowA })).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('deletes only the scoped key, leaving the other workflow untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(workflowIdArb, { minLength: 2, maxLength: 2 }),
        stateKeyArb,
        stateValueArb,
        stateValueArb,
        async ([workflowA, workflowB], key, valueA, valueB) => {
          const store = new MemoryStateStore({ now: () => EPOCH });
          await store.set(scopedStateKey(workflowA, key), valueA);
          await store.set(scopedStateKey(workflowB, key), valueB);

          await store.delete(scopedStateKey(workflowA, key));

          expect(await store.get(scopedStateKey(workflowA, key))).toBeUndefined();
          expect((await store.get(scopedStateKey(workflowB, key)))!.value).toBe(valueB);
        },
      ),
      { numRuns: 200 },
    );
  });
});
