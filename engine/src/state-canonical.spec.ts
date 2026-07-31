import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, deltaFilter } from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import { jsonArb, type Json } from './test/generators.js';

/**
 * Property 6: State primitives are idempotent, isolated and order-independent —
 * claims 30, 31 and 32 (design §8.2).
 *
 * 30. **Delta stability.** ∀ record `r`, ∀ key permutation `r'` of `r`:
 *     `hash(r) === hash(r')`, so key ordering from a paginated API never fakes a
 *     change.
 * 31. **Delta detection.** ∀ `r ≠ r'` (structurally): `hash(r) ≠ hash(r')` with the
 *     collision probability of the hash; and `deltaFilter` classifies `r'` as changed.
 * 32. **Conservation.** ∀ `R`: `len(changed) + skipped === len(R)`.
 *
 * **Validates: Requirements 12.7, 12.10, 12.11**
 */

const KEY_PATH = 'id';
const ENTITY = 'record';
const WORKFLOW_ID = 'wf-canonical';

interface SyncRecord {
  readonly id: string;
  readonly data: Json;
}

/** A record set with unique external ids, so one delta key tracks one record. */
const recordsArb: fc.Arbitrary<SyncRecord[]> = fc
  .array(
    fc.record({
      id: fc.integer({ min: 1, max: 50 }).map(String),
      data: jsonArb({ maxDepth: 3 }),
    }),
    { maxLength: 8 },
  )
  .map((rows) => {
    const seen = new Set<string>();
    return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  });

/** Deterministic PRNG so a shrunk counterexample replays exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reorders every object's own keys at every depth; array order is preserved. */
function permuteKeys(value: Json, rand: () => number): Json {
  if (Array.isArray(value)) return value.map((item) => permuteKeys(item, rand));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const out: { [key: string]: Json } = {};
    for (const key of keys) out[key] = permuteKeys((value as { [key: string]: Json })[key] as Json, rand);
    return out;
  }
  return value;
}

function storeFor(): MemoryStateStore {
  return new MemoryStateStore();
}

async function filter(records: readonly SyncRecord[], store: MemoryStateStore) {
  return await deltaFilter(records, ENTITY, KEY_PATH, store, { workflowId: WORKFLOW_ID });
}

describe('Property 6 claim 30: delta stability under key permutation', () => {
  it('hashes two key permutations of the same value identically', () => {
    fc.assert(
      fc.property(jsonArb({ maxDepth: 3 }), fc.integer(), (value, seed) => {
        const permuted = permuteKeys(value, mulberry32(seed));
        // The permutation must not have changed the value structurally.
        expect(permuted).toEqual(value);
        expect(canonicalJson(permuted)).toBe(canonicalJson(value));
        expect(contentHash(permuted)).toBe(contentHash(value));
      }),
    );
  });

  it('classifies a key-permuted record set as entirely skipped', async () => {
    await fc.assert(
      fc.asyncProperty(recordsArb, fc.integer(), async (records, seed) => {
        const store = storeFor();
        const first = await filter(records, store);
        expect(first.changed).toHaveLength(records.length);
        // Confirm every record as written, the way the engine does after the target acks.
        for (const candidate of first.changed) {
          await store.set(candidate.deltaKey, candidate.deltaHash);
        }

        const rand = mulberry32(seed);
        const permuted = records.map((record) => ({
          id: record.id,
          data: permuteKeys(record.data, rand),
        }));
        const second = await filter(permuted, store);
        expect(second.changed).toHaveLength(0);
        expect(second.skipped).toBe(records.length);
      }),
    );
  });
});

describe('Property 6 claim 31: structurally different records are detected', () => {
  it('gives structurally different values different canonical forms and hashes', () => {
    fc.assert(
      fc.property(jsonArb({ maxDepth: 3 }), jsonArb({ maxDepth: 3 }), (left, right) => {
        const leftJson = canonicalJson(left);
        const rightJson = canonicalJson(right);
        fc.pre(leftJson !== rightJson);
        // 32-bit FNV-1a: distinct canonical forms differ except at collision odds.
        expect(contentHash(left)).not.toBe(contentHash(right));
      }),
    );
  });

  it('classifies a record whose content changed as changed, and an absent key as changed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }).map(String),
        jsonArb({ maxDepth: 3 }),
        jsonArb({ maxDepth: 3 }),
        async (id, before, after) => {
          fc.pre(canonicalJson(before) !== canonicalJson(after));
          const store = storeFor();

          // Absent delta key: changed.
          const initial = await filter([{ id, data: before }], store);
          expect(initial.changed).toHaveLength(1);
          expect(initial.skipped).toBe(0);
          await store.set(initial.changed[0]!.deltaKey, initial.changed[0]!.deltaHash);

          // Same id, different content: changed again, under the same delta key.
          const next = await filter([{ id, data: after }], store);
          expect(next.changed).toHaveLength(1);
          expect(next.skipped).toBe(0);
          expect(next.changed[0]!.deltaKey).toBe(initial.changed[0]!.deltaKey);
          expect(next.changed[0]!.deltaHash).not.toBe(initial.changed[0]!.deltaHash);
        },
      ),
    );
  });
});

describe('Property 6 claim 32: the delta filter conserves the record count', () => {
  it('holds changed + skipped === len(R) for any partially synced record set', async () => {
    await fc.assert(
      fc.asyncProperty(
        recordsArb,
        fc.array(fc.boolean(), { maxLength: 8 }),
        async (records, alreadySynced) => {
          const store = storeFor();
          // Seed a subset of delta hashes, so the run sees both classifications.
          const seeded = await filter(records, store);
          for (let i = 0; i < seeded.changed.length; i++) {
            if (alreadySynced[i] === true) {
              const candidate = seeded.changed[i]!;
              await store.set(candidate.deltaKey, candidate.deltaHash);
            }
          }

          const result = await filter(records, store);
          expect(result.changed.length + result.skipped).toBe(records.length);
          const expectedSkipped = records.filter((_, i) => alreadySynced[i] === true).length;
          expect(result.skipped).toBe(expectedSkipped);
          // Changed records keep source order.
          const changedIds = result.changed.map((c) => (c.record as SyncRecord).id);
          const expectedIds = records
            .filter((_, i) => alreadySynced[i] !== true)
            .map((record) => record.id);
          expect(changedIds).toEqual(expectedIds);
        },
      ),
    );
  });

  it('conserves the count with no store contents at all', async () => {
    await fc.assert(
      fc.asyncProperty(recordsArb, async (records) => {
        const result = await filter(records, storeFor());
        expect(result.changed.length + result.skipped).toBe(records.length);
        expect(result.skipped).toBe(0);
      }),
    );
  });
});
