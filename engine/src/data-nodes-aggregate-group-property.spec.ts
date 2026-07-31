import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runAggregate } from './data-nodes.js';
import type { EvalContext, Json } from './expr.js';
import { resolveJsonPath } from './payload.js';
import { canonicalJson } from './state.js';
import type { AggregateMetric, AggregateNodeData, WorkflowNode } from './types.js';

/**
 * Property 3: Aggregation conserves counts and sums (design §5.3) — claims 11,
 * 12, 13 and 17. Claims 14, 15 and 16 (join cardinality, left-join totality and
 * the pivot round trip) live in their own suite.
 *
 * Claim 11, **Count conservation**:
 *   ∀ rows `R`, ∀ group spec: `Σ groups[i].count === len(R)`.
 *
 * Claim 12, **Sum conservation**:
 *   ∀ `R`, ∀ numeric path `q`: `Σ groups[i].sum(q)` equals the sum of numeric
 *   values at `q` across `R` (non-numerics excluded from both sides).
 *
 * Claim 13, **Group key partition**:
 *   Every row contributes to exactly one group, and group keys are distinct.
 *
 * Claim 17, **Order independence of metrics**:
 *   ∀ permutation `π` of `R`: `count`, `countIf`, `sum`, `min`, `max`, `avg` and
 *   `distinct` are identical for `R` and `π(R)`. `first` is deliberately excluded
 *   — Requirement 6.10 derives it from source order — so this suite asserts
 *   nothing about `first` under permutation and pins that exclusion with an
 *   explicit example instead.
 *
 * ### Why the numeric domain is exact rather than arbitrary doubles
 *
 * Claims 12 and 17 are equalities over floating-point totals, so a generator that
 * mixed 1e6-scale and 1e-300-scale doubles in the same group would be asserting
 * something about IEEE-754 rounding rather than about aggregation. The measure
 * domain here is therefore restricted to values that sum exactly in a double —
 * integers and quarter-steps — while everything the requirements actually branch
 * on stays in play: absent paths, `null`, booleans, objects, arrays, unparseable
 * strings and numeric strings all appear at the measure path so the
 * "non-numerics are excluded, never coerced" rule (Requirement 6.3) is exercised
 * on both sides of each equality.
 *
 * The `countIf` predicate is deliberately written over `item` only. A predicate
 * reading `index` is bound to the row's source position by Requirement 6.5 and so
 * is not permutation-invariant by construction; that is a property of the
 * predicate, not of the accumulator claim 17 is about.
 *
 * **Validates: Requirements 6.1, 6.2, 6.10**
 */

const NOW_MS = 1_700_000_000_000;

/** The `countIf` predicate every generated spec uses. Reads `item` only. */
const POSITIVE_PREDICATE = 'item.amount > 0';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type Row = { [key: string]: Json };

function nodeFor(data: AggregateNodeData): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Counts per client',
    kind: 'aggregate',
    category: 'flow',
    icon: 'pi-chart-bar',
    position: { x: 0, y: 0 },
    ports: [],
    data,
  };
}

function contextFor(root: Json): EvalContext {
  return { $: root, $text: JSON.stringify(root), nowMs: NOW_MS };
}

/** Runs the grouping and returns the emitted rows, unwrapping `resultKey`. */
function groupRows(data: AggregateNodeData, root: Json): Record<string, unknown>[] {
  const ctx = contextFor(root);
  const parsed = JSON.parse(runAggregate(nodeFor(data), ctx.$text, ctx)) as unknown;
  const list =
    data.resultKey === undefined ? parsed : (parsed as Record<string, unknown>)[data.resultKey];
  expect(Array.isArray(list)).toBe(true);
  return list as Record<string, unknown>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference implementation — an independent, exact model of §5.3 grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requirement 6.3, restated for the reference model: a finite number, or a string
 * that parses whole as a finite decimal, counts; anything else is excluded.
 */
const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function measureOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!NUMERIC_TEXT.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ExpectedGroup {
  readonly key: string;
  readonly keyValues: readonly Json[];
  /** Source positions of every row folded into this group, in source order. */
  readonly rowIndices: number[];
  measures: number[];
  labels: Set<string>;
  positives: number;
}

/**
 * Groups `rows` the way §5.3 says to, computed independently of the executor:
 * first-appearance order, canonical JSON of the resolved `by` tuple as the group
 * identity, and plain (exact, in this domain) arithmetic for the measures.
 */
function expectedGroups(rows: readonly Row[], by: readonly string[]): ExpectedGroup[] {
  const groups = new Map<string, ExpectedGroup>();
  rows.forEach((row, index) => {
    const keyValues = by.map((path) => (resolveJsonPath(row, path) ?? null) as Json);
    const key = canonicalJson(keyValues);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, keyValues, rowIndices: [], measures: [], labels: new Set(), positives: 0 };
      groups.set(key, group);
    }
    group.rowIndices.push(index);
    const measure = measureOf(row.amount);
    if (measure !== undefined) group.measures.push(measure);
    // `>` never coerces (Requirement 4.7), so only a real number can be positive.
    if (typeof row.amount === 'number' && row.amount > 0) group.positives += 1;
    group.labels.add(canonicalJson(resolveJsonPath(row, 'label') ?? null));
  });
  return [...groups.values()];
}

/** Normalises `-0` to `0`, which is what the executor emits. */
function zeroSafe(value: number): number {
  return value === 0 ? 0 : value;
}

function exactSum(values: readonly number[]): number {
  return zeroSafe(values.reduce((total, value) => total + value, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure values that sum exactly in a double: integers and quarter-steps, both
 * bounded so any total of the ≤ 24 rows a case can hold stays exact.
 */
const exactNumberArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: -10_000, max: 10_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -40_000, max: 40_000 }).map((n) => n / 4) },
);

/** Everything the executor must exclude from `sum`/`avg`/`min`/`max`. */
const nonNumericArb: fc.Arbitrary<Json> = fc.constantFrom<Json>(
  null,
  true,
  false,
  '',
  'n/a',
  '12abc',
  { a: 1 },
  [1, 2],
);

/**
 * The measure at `amount`: an exact number, the same number as text (so the
 * string-parsing branch of Requirement 6.3 is reached), or a non-numeric value.
 * Absence is modelled by dropping the property entirely.
 */
const amountArb: fc.Arbitrary<Json | undefined> = fc.oneof(
  { weight: 6, arbitrary: exactNumberArb as fc.Arbitrary<Json | undefined> },
  { weight: 2, arbitrary: exactNumberArb.map((n) => String(n)) },
  { weight: 2, arbitrary: nonNumericArb },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

/** A small key domain, so generated tables really do collide into groups. */
const keyValueArb: fc.Arbitrary<Json | undefined> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<Json>('a', 'b', 'c') },
  { weight: 1, arbitrary: fc.constant(null as Json) },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

const rowArb: fc.Arbitrary<Row> = fc
  .record(
    {
      group: keyValueArb,
      bucket: keyValueArb,
      amount: amountArb,
      label: fc.oneof(
        { weight: 4, arbitrary: fc.constantFrom<Json>('p', 'q', 1, null) },
        { weight: 1, arbitrary: fc.constant(undefined) },
      ),
    },
    { requiredKeys: [] },
  )
  // `undefined` is not a JSON value: an absent field must really be absent.
  .map((raw) => {
    const row: Row = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined) row[key] = value as Json;
    }
    return row;
  });

const rowsArb = fc.array(rowArb, { maxLength: 24 });

/** 1 or 2 `by` paths drawn from the generated fields, including a nested miss. */
const byArb: fc.Arbitrary<string[]> = fc.uniqueArray(
  fc.constantFrom('group', 'bucket', 'org.id'),
  { minLength: 1, maxLength: 2 },
);

/** The full metric set. `first` is present so its exclusion is not vacuous. */
const METRICS: readonly AggregateMetric[] = [
  { name: 'n', fn: 'count' },
  { name: 'positives', fn: 'countIf', where: POSITIVE_PREDICATE },
  { name: 'total', fn: 'sum', path: 'amount' },
  { name: 'lo', fn: 'min', path: 'amount' },
  { name: 'hi', fn: 'max', path: 'amount' },
  { name: 'mean', fn: 'avg', path: 'amount' },
  { name: 'uniq', fn: 'distinct', path: 'label' },
  { name: 'firstAmount', fn: 'first', path: 'amount' },
];

/** Metric names claim 17 quantifies over: everything except `first`. */
const ORDER_INDEPENDENT_METRICS: readonly string[] = [
  'n',
  'positives',
  'total',
  'lo',
  'hi',
  'mean',
  'uniq',
];

type Source = { readonly data: AggregateNodeData; readonly root: Json };

/** Rows at the payload root, or under an `itemsPath`, optionally wrapped. */
function source(
  rows: readonly Row[],
  by: readonly string[],
  shape: 'root' | 'itemsPath',
  resultKey: string | undefined,
): Source {
  const data: AggregateNodeData = {
    op: 'group',
    group: { by: [...by], metrics: [...METRICS] },
    ...(shape === 'itemsPath' ? { itemsPath: 'rows' } : {}),
    ...(resultKey === undefined ? {} : { resultKey }),
  };
  return { data, root: shape === 'root' ? (rows as Json) : ({ rows } as unknown as Json) };
}

const shapeArb = fc.constantFrom<'root' | 'itemsPath'>('root', 'itemsPath');
const resultKeyArb = fc.option(fc.constant('groups'), { nil: undefined });

// ─────────────────────────────────────────────────────────────────────────────
// Claim 11 — count conservation (Requirements 6.1, 6.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 3 (claim 11): group counts sum to the row count', () => {
  it('conserves the row count across every generated table and by tuple', () => {
    fc.assert(
      fc.property(rowsArb, byArb, shapeArb, resultKeyArb, (rows, by, shape, resultKey) => {
        const { data, root } = source(rows, by, shape, resultKey);
        const out = groupRows(data, root);

        const counts = out.map((record) => record.n);
        for (const count of counts) expect(count).toBeTypeOf('number');
        expect(counts.reduce((sum: number, count) => sum + (count as number), 0)).toBe(rows.length);

        // Every group holds at least one row, and no tallied metric can exceed
        // its group's row count (Requirement 6.2).
        for (const record of out) {
          expect(record.n as number).toBeGreaterThan(0);
          expect(record.positives as number).toBeLessThanOrEqual(record.n as number);
        }
        // An empty source emits no groups at all.
        if (rows.length === 0) expect(out).toHaveLength(0);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 12 — sum conservation (Requirements 6.2, 6.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 3 (claim 12): group sums conserve the numeric total', () => {
  it('reproduces the whole-table total, with non-numerics excluded on both sides', () => {
    fc.assert(
      fc.property(rowsArb, byArb, shapeArb, (rows, by, shape) => {
        const { data, root } = source(rows, by, shape, undefined);
        const out = groupRows(data, root);

        const measures = rows
          .map((row) => measureOf(row.amount))
          .filter((value): value is number => value !== undefined);
        const totals = out.map((record) => record.total as number);
        for (const total of totals) expect(Number.isFinite(total)).toBe(true);

        expect(exactSum(totals)).toBe(exactSum(measures));

        // Per-group agreement, which is the stronger statement the whole-table
        // equality follows from: a compensating pair of wrong group sums cannot
        // hide here.
        const expected = expectedGroups(rows, by);
        expect(out).toHaveLength(expected.length);
        for (let i = 0; i < expected.length; i += 1) {
          const group = expected[i]!;
          const record = out[i]!;
          expect(record.total).toBe(exactSum(group.measures));
          // Requirement 6.4: an empty numeric set is `null` for avg/min/max and
          // `0` for sum.
          if (group.measures.length === 0) {
            expect(record.total).toBe(0);
            expect(record.mean).toBeNull();
            expect(record.lo).toBeNull();
            expect(record.hi).toBeNull();
          } else {
            expect(record.mean).toBe(zeroSafe(exactSum(group.measures) / group.measures.length));
            expect(record.lo).toBe(Math.min(...group.measures));
            expect(record.hi).toBe(Math.max(...group.measures));
          }
        }
      }),
    );
  });

  it('is not vacuous: a non-numeric measure is excluded rather than coerced', () => {
    const rows: Row[] = [
      { group: 'a', amount: 2 },
      { group: 'a', amount: 'n/a' },
      { group: 'a', amount: '3' },
      { group: 'a', amount: true },
    ];
    const { data, root } = source(rows, ['group'], 'root', undefined);
    const out = groupRows(data, root);
    expect(out).toHaveLength(1);
    expect(out[0]!.total).toBe(5);
    expect(out[0]!.mean).toBe(2.5);
    expect(out[0]!.n).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 13 — group key partition (Requirement 6.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 3 (claim 13): the by tuple partitions the rows', () => {
  it('emits distinct keys in first-appearance order, one group per row set', () => {
    fc.assert(
      fc.property(rowsArb, byArb, shapeArb, (rows, by, shape) => {
        const { data, root } = source(rows, by, shape, undefined);
        const out = groupRows(data, root);
        const expected = expectedGroups(rows, by);

        // One group per distinct tuple, in first-appearance order.
        expect(out).toHaveLength(expected.length);

        const seen = new Set<string>();
        for (let i = 0; i < out.length; i += 1) {
          const record = out[i]!;
          const keyValues = by.map((path) => (resolveJsonPath(record, path) ?? null) as Json);
          const key = canonicalJson(keyValues);

          // Distinctness: no two output groups carry the same tuple.
          expect(seen.has(key)).toBe(false);
          seen.add(key);

          // Identity and membership: this group is the i-th distinct tuple and
          // holds exactly the rows that resolved to it, so every row landed in
          // exactly one group.
          expect(key).toBe(expected[i]!.key);
          expect(record.n).toBe(expected[i]!.rowIndices.length);
        }

        const partitioned = expected.reduce((total, group) => total + group.rowIndices.length, 0);
        expect(partitioned).toBe(rows.length);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 17 — order independence of metrics (Requirement 6.10)
// ─────────────────────────────────────────────────────────────────────────────

/** Maps each emitted group to its order-independent metrics, keyed by tuple. */
function metricsByKey(
  out: readonly Record<string, unknown>[],
  by: readonly string[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const record of out) {
    const key = canonicalJson(by.map((path) => (resolveJsonPath(record, path) ?? null) as Json));
    const metrics: Record<string, unknown> = {};
    for (const name of ORDER_INDEPENDENT_METRICS) metrics[name] = record[name];
    map.set(key, metrics);
  }
  return map;
}

/** A table paired with a permutation of itself. */
const permutedRowsArb: fc.Arbitrary<{ rows: Row[]; permuted: Row[] }> = rowsArb.chain((rows) =>
  fc
    .shuffledSubarray(
      rows.map((_, index) => index),
      { minLength: rows.length, maxLength: rows.length },
    )
    .map((order) => ({ rows, permuted: order.map((index) => rows[index]!) })),
);

describe('Property 3 (claim 17): metrics are independent of row order', () => {
  it('produces identical count, countIf, sum, min, max, avg and distinct under permutation', () => {
    fc.assert(
      fc.property(permutedRowsArb, byArb, shapeArb, ({ rows, permuted }, by, shape) => {
        const original = source(rows, by, shape, undefined);
        const shuffled = source(permuted, by, shape, undefined);

        const left = metricsByKey(groupRows(original.data, original.root), by);
        const right = metricsByKey(groupRows(shuffled.data, shuffled.root), by);

        // The same partition, whatever the order the rows arrived in.
        expect([...right.keys()].sort()).toStrictEqual([...left.keys()].sort());
        for (const [key, metrics] of left) expect(right.get(key)).toStrictEqual(metrics);
      }),
    );
  });

  it('is not vacuous: `first` is the metric permutation may change', () => {
    const rows: Row[] = [
      { group: 'a', amount: 1 },
      { group: 'a', amount: 2 },
    ];
    const reversed = [...rows].reverse();
    const forward = groupRows(source(rows, ['group'], 'root', undefined).data, rows as Json);
    const backward = groupRows(
      source(reversed, ['group'], 'root', undefined).data,
      reversed as Json,
    );

    expect(forward[0]!.firstAmount).toBe(1);
    expect(backward[0]!.firstAmount).toBe(2);
    // Every other metric is untouched by the reordering.
    for (const name of ORDER_INDEPENDENT_METRICS) {
      expect(backward[0]![name]).toStrictEqual(forward[0]![name]);
    }
  });
});
