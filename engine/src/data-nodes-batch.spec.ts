import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  batchItems,
  resolveBatchSize,
} from './data-nodes.js';

/**
 * `for-each` batch mode (Requirements 9.8-9.10).
 *
 * Pure regrouping, so every case is a literal list in and a list out. Property
 * coverage (flatten identity, batch sizing, pass-through) is task 10.7.
 */

const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('resolveBatchSize', () => {
  it('accepts every integer in range', () => {
    expect(resolveBatchSize(MIN_BATCH_SIZE)).toBe(2);
    expect(resolveBatchSize(7)).toBe(7);
    expect(resolveBatchSize(MAX_BATCH_SIZE)).toBe(MAX_BATCH_SIZE);
  });

  it('rejects absent, non-numeric, non-integer and out-of-range values', () => {
    for (const value of [
      undefined,
      null,
      '5',
      {},
      [],
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2.5,
      -0.5,
      1,
      0,
      -1,
      -10,
      MAX_BATCH_SIZE + 1,
      100_000,
    ]) {
      expect(resolveBatchSize(value), `batchSize ${String(value)}`).toBeUndefined();
    }
  });
});

describe('batchItems pass-through (Requirement 9.9)', () => {
  it('returns the source array itself for an absent or out-of-range size', () => {
    const source = items(5);
    for (const value of [undefined, 0, 1, -3, 2.5, Number.NaN, MAX_BATCH_SIZE + 1]) {
      expect(batchItems(source, value)).toBe(source);
    }
  });
});

describe('batchItems batching (Requirements 9.8, 9.10)', () => {
  it('splits an exact multiple into full batches', () => {
    expect(batchItems(items(6), 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('leaves a short final batch', () => {
    expect(batchItems(items(7), 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
  });

  it('emits one short batch when the source is smaller than the batch size', () => {
    expect(batchItems(items(2), 10)).toEqual([[0, 1]]);
  });

  it('yields zero iterations for an empty source', () => {
    expect(batchItems([], 4)).toEqual([]);
    expect(batchItems([], undefined)).toEqual([]);
  });

  it('conserves order, multiplicity and count for a large source', () => {
    const source = items(100_000);
    const batches = batchItems(source, MAX_BATCH_SIZE) as readonly number[][];

    expect(batches).toHaveLength(Math.ceil(source.length / MAX_BATCH_SIZE));
    expect(batches.flat()).toEqual(source);
    expect(batches.slice(0, -1).every((batch) => batch.length === MAX_BATCH_SIZE)).toBe(true);
    expect(batches[batches.length - 1]!.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });

  it('preserves duplicates and nested arrays as plain items', () => {
    const source = [['a'], ['a'], null, 'a'];
    const batches = batchItems(source, 2) as readonly unknown[][];

    expect(batches).toEqual([[['a'], ['a']], [null, 'a']]);
    expect(batches.flat()).toEqual(source);
  });

  it('never mutates the source list', () => {
    const source = items(5);
    const snapshot = [...source];
    const batches = batchItems(source, 2) as number[][];
    batches[0]![0] = 99;

    expect(source).toEqual(snapshot);
  });
});
