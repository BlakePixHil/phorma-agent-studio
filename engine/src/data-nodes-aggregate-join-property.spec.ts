import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runAggregate } from './data-nodes.js';
import type { EvalContext, Json } from './expr.js';
import { joinableRowsArb, type Row } from './test/generators.js';
import type { AggregateNodeData, WorkflowNode } from './types.js';

/**
 * Property 3: Aggregation conserves counts and sums (design §5.3) — claims 14,
 * 15 and 16. Claims 11-13 and 17 live in the conservation suite.
 *
 * Claim 14, **Join cardinality**:
 *   ∀ `L`, `R`, key paths: `inner` output length equals
 *   `Σ_{l ∈ L} |{r ∈ R : key(r) = key(l)}|`; `left` output length equals that sum
 *   plus the number of unmatched left rows.
 *
 * Claim 15, **Left-join totality**:
 *   ∀ `l ∈ L`: at least one output row derives from `l` under `left`.
 *
 * Claim 16, **Pivot round-trip**:
 *   ∀ grouped rows with distinct key tuples: every input row appears as exactly
 *   one pivot column, and `len(keys(pivot)) === len(rows) + len(fills)`.
 *
 * Both join claims are checked against an independent oracle that indexes the
 * right rows by key with the same "absent is `null`" rule the executor uses
 * (Requirement 6.6), so a key of `null` matches an absent key and nothing else.
 * Each left row carries a unique `lid` marker, which survives the merge under its
 * own name because left field names are never prefixed — that marker is what
 * makes "derives from `l`" observable for claim 15 and lets the per-row field
 * checks confirm the collision prefix of Requirement 6.8 and the bare shape of an
 * unmatched left row under Requirement 6.7.
 *
 * The pivot generator draws key parts that never contain the chosen separator, so
 * distinct key tuples of fixed width always join to distinct keys — the premise of
 * claim 16 — and declares a column vocabulary that overlaps the data only
 * partially, so the fill branch of Requirement 6.9 fires.
 *
 * **Validates: Requirements 6.6, 6.7, 6.8, 6.9**
 */

const NOW_MS = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function nodeFor(data: AggregateNodeData): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Join rows',
    kind: 'aggregate',
    category: 'flow',
    icon: 'pi-chart-bar',
    position: { x: 0, y: 0 },
    ports: [],
    data,
  };
}

/** An `EvalContext` over one JSON root, with a fixed clock so nothing is ambient. */
function contextFor(root: Json): EvalContext {
  return { $: root, $text: JSON.stringify(root), nowMs: NOW_MS };
}

function run(data: AggregateNodeData, root: Json): unknown {
  const ctx = contextFor(root);
  return JSON.parse(runAggregate(nodeFor(data), ctx.$text, ctx));
}

/**
 * The join key of one row, as an equality token. Independent of the executor:
 * an absent value and a `null` value collapse to the same token, and a string is
 * tagged so `'1'` never matches `1` (Requirement 6.6).
 */
function keyToken(value: Json | undefined): string {
  if (value === undefined || value === null) return 'null';
  return typeof value === 'string' ? `s:${value}` : `j:${JSON.stringify(value)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claims 14 and 15 — join cardinality and left-join totality
// ─────────────────────────────────────────────────────────────────────────────

interface JoinCase {
  readonly left: Row[];
  readonly right: Row[];
  readonly type: 'inner' | 'left';
  readonly collisionPrefix?: string;
}

/**
 * Two row arrays over one shared key domain, plus the join type and an optional
 * collision prefix. `allowMissing` lets a key be absent or `null`, which is what
 * exercises the null-matching rule.
 */
const joinCaseArb: fc.Arbitrary<JoinCase> = fc
  .record({
    rows: joinableRowsArb({
      keyFields: ['group'],
      keyDomain: ['a', 'b', 1],
      minRows: 0,
      maxRows: 8,
      allowMissing: true,
    }),
    type: fc.constantFrom('inner' as const, 'left' as const),
    collisionPrefix: fc.option(fc.constantFrom('right_', 'r::', 'src_'), { nil: undefined }),
  })
  .map(({ rows, type, collisionPrefix }) => ({
    // A unique marker per left row, so every output row names the left row it
    // came from. Right rows never carry `lid`, so it is not a colliding name.
    left: rows.left.map((row, index) => ({ ...row, lid: index })),
    right: rows.right,
    type,
    collisionPrefix,
  }));

function joinData(kase: JoinCase): AggregateNodeData {
  return {
    op: 'join',
    join: {
      leftPath: 'left',
      rightPath: 'right',
      leftKey: 'group',
      rightKey: 'group',
      type: kase.type,
      ...(kase.collisionPrefix === undefined ? {} : { collisionPrefix: kase.collisionPrefix }),
    },
  };
}

/** Right rows bucketed by key token, each bucket in right source order. */
function indexRight(right: readonly Row[]): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of right) {
    const token = keyToken(row['group']);
    const bucket = index.get(token);
    if (bucket === undefined) index.set(token, [row]);
    else bucket.push(row);
  }
  return index;
}

describe('Property 3 — join cardinality (claim 14)', () => {
  it('emits one row per matching pair, plus one bare row per unmatched left row under left join', () => {
    fc.assert(
      fc.property(joinCaseArb, (kase) => {
        const index = indexRight(kase.right);

        let matchedPairs = 0;
        let unmatchedLeft = 0;
        for (const row of kase.left) {
          const matches = index.get(keyToken(row['group']))?.length ?? 0;
          matchedPairs += matches;
          if (matches === 0) unmatchedLeft += 1;
        }

        const out = run(joinData(kase), { left: kase.left, right: kase.right } as unknown as Json);
        expect(Array.isArray(out)).toBe(true);
        const rows = out as Record<string, Json>[];

        expect(rows.length).toBe(
          kase.type === 'inner' ? matchedPairs : matchedPairs + unmatchedLeft,
        );
      }),
    );
  });

  it('pairs left and right rows in left-then-right source order, prefixing colliding right fields', () => {
    fc.assert(
      fc.property(joinCaseArb, (kase) => {
        const index = indexRight(kase.right);
        const prefix = kase.collisionPrefix ?? 'right_';

        // Expected pairs in output order: left source order, then right order.
        const expected: { left: Row; right: Row | undefined }[] = [];
        for (const left of kase.left) {
          const matches = index.get(keyToken(left['group'])) ?? [];
          if (matches.length === 0) {
            if (kase.type === 'left') expected.push({ left, right: undefined });
            continue;
          }
          for (const right of matches) expected.push({ left, right });
        }

        const rows = run(joinData(kase), {
          left: kase.left,
          right: kase.right,
        } as unknown as Json) as Record<string, Json>[];
        expect(rows.length).toBe(expected.length);

        for (let i = 0; i < expected.length; i += 1) {
          const { left, right } = expected[i]!;
          const row = rows[i]!;

          if (right === undefined) {
            // Requirement 6.7: an unmatched left row is emitted bare — its own
            // fields only, with no prefixed name and no right contribution.
            expect(row).toEqual(left);
            continue;
          }

          // Requirement 6.8: left values keep their own names; a colliding right
          // field moves under the prefix; a non-colliding one keeps its name.
          for (const [key, value] of Object.entries(left)) expect(row[key]).toEqual(value);
          for (const [key, value] of Object.entries(right)) {
            const target = Object.prototype.hasOwnProperty.call(left, key) ? `${prefix}${key}` : key;
            expect(row[target]).toEqual(value);
          }
        }
      }),
    );
  });
});

describe('Property 3 — left-join totality (claim 15)', () => {
  it('derives at least one output row from every left row', () => {
    fc.assert(
      fc.property(joinCaseArb, (kase) => {
        const data = joinData({ ...kase, type: 'left' });
        const rows = run(data, {
          left: kase.left,
          right: kase.right,
        } as unknown as Json) as Record<string, Json>[];

        const seen = new Set<Json>();
        for (const row of rows) seen.add(row['lid'] ?? null);
        for (const left of kase.left) expect(seen.has(left['lid'] ?? null)).toBe(true);
        expect(seen.size).toBe(kase.left.length);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 16 — pivot round-trip
// ─────────────────────────────────────────────────────────────────────────────

/** Key parts drawn from a domain that contains none of the generated separators. */
const pivotPartArb: fc.Arbitrary<string | number> = fc.oneof(
  fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  fc.constantFrom(1, 2, 3),
);

const pivotValueArb: fc.Arbitrary<Json> = fc.oneof(
  fc.constant(null as Json),
  fc.boolean(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 8 }),
);

interface PivotCase {
  readonly rows: Row[];
  readonly keyFields: string[];
  readonly separator: string;
  readonly columns: string[];
  readonly fillValue: number | string | null;
}

const pivotCaseArb: fc.Arbitrary<PivotCase> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.constantFrom('_', '|', '::'))
  .chain(([width, separator]) => {
    const keyFields = Array.from({ length: width }, (_, i) => `k${i}`);
    return fc
      .uniqueArray(fc.array(pivotPartArb, { minLength: width, maxLength: width }), {
        selector: (tuple) => JSON.stringify(tuple),
        maxLength: 8,
      })
      .chain((tuples) =>
        fc
          .record({
            values: fc.array(pivotValueArb, {
              minLength: tuples.length,
              maxLength: tuples.length,
            }),
            columns: fc.array(fc.constantFrom('a', 'z', 'extra', 'a_a', 'b'), { maxLength: 4 }),
            fillValue: fc.oneof(
              fc.constant(null as number | string | null),
              fc.constant(0 as number | string | null),
              fc.constant('missing' as number | string | null),
            ),
          })
          .map(({ values, columns, fillValue }) => ({
            rows: tuples.map((tuple, i) => {
              const row: Row = { n: values[i] ?? null, label: `row-${i}` };
              tuple.forEach((part, j) => {
                row[keyFields[j]!] = part;
              });
              return row;
            }),
            keyFields,
            separator,
            columns,
            fillValue,
          })),
      );
  });

/** The pivot key of one row: a string part as written, anything else as JSON. */
function pivotKey(row: Row, keyFields: readonly string[], separator: string): string {
  return keyFields
    .map((field) => {
      const value = row[field];
      return typeof value === 'string' ? value : JSON.stringify(value ?? null);
    })
    .join(separator);
}

describe('Property 3 — pivot round-trip (claim 16)', () => {
  it('emits exactly one column per input row plus one per declared column absent from the rows', () => {
    fc.assert(
      fc.property(pivotCaseArb, (kase) => {
        const out = run(
          {
            op: 'pivot',
            pivot: {
              rowsPath: 'rows',
              keyFields: kase.keyFields,
              valueField: 'n',
              separator: kase.separator,
              fillValue: kase.fillValue,
              columns: kase.columns,
            },
          },
          { rows: kase.rows } as unknown as Json,
        ) as Record<string, Json>;

        const rowKeys = kase.rows.map((row) => pivotKey(row, kase.keyFields, kase.separator));
        // Distinct key tuples of fixed width over separator-free parts join to
        // distinct keys, which is the premise of the claim.
        expect(new Set(rowKeys).size).toBe(rowKeys.length);

        const fills: string[] = [];
        for (const column of kase.columns) {
          if (!rowKeys.includes(column) && !fills.includes(column)) fills.push(column);
        }

        // Every input row is exactly one column, carrying that row's valueField.
        for (let i = 0; i < kase.rows.length; i += 1) {
          expect(Object.prototype.hasOwnProperty.call(out, rowKeys[i]!)).toBe(true);
          expect(out[rowKeys[i]!]).toEqual(kase.rows[i]!['n'] ?? null);
        }
        for (const fill of fills) expect(out[fill]).toEqual(kase.fillValue);

        // Width: one column per grouped row plus one per declared column absent
        // from the data, and nothing else (Requirement 6.9).
        expect([...Object.keys(out)].sort()).toEqual([...rowKeys, ...fills].sort());
        expect(Object.keys(out).length).toBe(kase.rows.length + fills.length);

        // Emission order is grouped-row order then declared-column order. Only
        // asserted when no key is array-index-like: JavaScript enumerates
        // integer-like own keys first in ascending numeric order whatever the
        // insertion order, which is a property of the object, not of the
        // executor.
        const keys = Object.keys(out);
        if (!keys.some((key) => String(Number(key)) === key)) {
          expect(keys).toEqual([...rowKeys, ...fills]);
        }
      }),
    );
  });
});
