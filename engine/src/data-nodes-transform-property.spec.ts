import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DataNodeError, castValue, runTransform } from './data-nodes.js';
import type { EvalContext, Json } from './expr.js';
import { resolveJsonPath } from './payload.js';
import { jsonArb, jsonNumberArb, rowsArb, type Row } from './test/generators.js';
import type { TransformField, TransformNodeData, WorkflowNode } from './types.js';

/**
 * Property 2: Transform preserves shape and never mutates its input (design §5.2)
 * — claims 7, 8, 9 and 10.
 *
 * Claim 7, **Length preservation**:
 *   ∀ array `xs`, ∀ field set `F`: `runTransform` in array mode returns exactly
 *   `len(xs)` records, in source order.
 *
 * Claim 8, **Target coverage**:
 *   ∀ output record `r`, ∀ field `f ∈ F` with `required: true`: `r` has a non-null
 *   value at `f.target`, or the call failed.
 *
 * Claim 9, **Idempotence of casts**:
 *   ∀ value `v`, ∀ cast `k`: `cast(cast(v, k), k) === cast(v, k)`.
 *
 * Claim 10, **Non-mutation**:
 *   ∀ payload `p`: `p` parses to a structurally identical value after the call.
 *
 * Claim 10 is checked after a successful projection **and** after a failure
 * (Requirement 5.13), and paired with the repeat-call stability Requirement 5.14
 * asks for: the same node data, payload and `nowMs` produce a byte-identical
 * output string, or the same failure naming the same field `target`. A projection
 * that wrote through into the payload would break both at once.
 *
 * Claim 9 quantifies over the whole shared `jsonArb` domain plus epoch, ISO and
 * numeric-string values, with the epoch range spanning the full ECMAScript time
 * range on both sides of the `date-iso` four-digit-year window: `date-iso` returns
 * `null` outside years 0000-9999 rather than an expanded-year string `parseDate`
 * cannot read back, so the cast is total and idempotent everywhere.
 *
 * **Validates: Requirements 5.3, 5.8, 5.9, 5.13, 5.14**
 */

const NOW_MS = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function nodeFor(data: TransformNodeData): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Shape rows',
    kind: 'transform',
    category: 'flow',
    icon: 'pi-sitemap',
    position: { x: 0, y: 0 },
    ports: [],
    data,
  };
}

/** An `EvalContext` over one JSON root, with a fixed clock so nothing is ambient. */
function contextFor(root: Json | undefined): EvalContext {
  return { $: root, $text: root === undefined ? '' : JSON.stringify(root), nowMs: NOW_MS };
}

type Attempt =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: DataNodeError };

/**
 * Runs the projection, keeping a `DataNodeError` as a value: every claim here is
 * conditional on "or the call failed", so a failure is an outcome, not a crash.
 */
function attempt(data: TransformNodeData, root: Json | undefined): Attempt {
  const ctx = contextFor(root);
  try {
    return { ok: true, text: runTransform(nodeFor(data), ctx.$text, ctx) };
  } catch (error) {
    if (error instanceof DataNodeError) return { ok: false, error };
    throw error;
  }
}

/** The projected array, whether it was wrapped under a `resultKey` or not. */
function outputList(text: string, resultKey: string | undefined): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  const list = resultKey === undefined ? parsed : (parsed as Record<string, unknown>)[resultKey];
  expect(Array.isArray(list)).toBe(true);
  return list as unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Target paths. Chosen so no target is a prefix of another: two fields where one
 * target sits under the other (`a` and `a.b`) make "the record has a value at
 * every required target" ill-defined, which is a spec question rather than
 * something claim 8 quantifies over.
 */
const TARGET_DOMAIN: readonly string[] = [
  'alpha',
  'beta',
  'gamma',
  'nested.one',
  'nested.two',
  'deep.a.b',
];

/** Expressions that all compile, over `item`, `index` and the payload root. */
const EXPRESSION_DOMAIN: readonly string[] = [
  'item.group',
  'item.amount',
  'item.amount * 2',
  'item.nested',
  'item.detail',
  'item.absent',
  'index',
  'len(keys(item))',
  "'fixed'",
  'null',
  'now()',
  '$',
];

const CASTS: readonly NonNullable<TransformField['cast']>[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'date-iso',
];

const defaultArb: fc.Arbitrary<string | number | boolean | null> = fc.oneof(
  fc.string({ maxLength: 8 }),
  jsonNumberArb,
  fc.boolean(),
  fc.constant(null),
);

interface FieldArbOptions {
  /** True lets a generated field declare `required: true`. */
  readonly allowRequired: boolean;
}

function fieldArb(target: string, options: FieldArbOptions): fc.Arbitrary<TransformField> {
  return fc.record(
    {
      target: fc.constant(target),
      expression: fc.constantFrom(...EXPRESSION_DOMAIN),
      cast: fc.constantFrom(...CASTS),
      default: defaultArb,
      required: options.allowRequired ? fc.boolean() : fc.constant(false),
    },
    { requiredKeys: ['target', 'expression'] },
  );
}

/** 1 to 4 fields with distinct, non-overlapping targets. */
function fieldsArb(options: FieldArbOptions): fc.Arbitrary<TransformField[]> {
  return fc
    .uniqueArray(fc.constantFrom(...TARGET_DOMAIN), { minLength: 1, maxLength: 4 })
    .chain((targets) => fc.tuple(...targets.map((target) => fieldArb(target, options))));
}

/** Rows carrying key, numeric and nested-JSON fields, with absences. */
const sourceRowsArb: fc.Arbitrary<Row[]> = rowsArb({
  jsonFields: ['nested', 'detail'],
  allowMissing: true,
  maxRows: 8,
});

/** `mode: 'array'` over the root, or an `itemsPath` into a wrapper object. */
type ArraySource = { readonly data: TransformNodeData; readonly root: Json };

function arraySource(
  rows: Row[],
  fields: TransformField[],
  shape: 'array' | 'itemsPath',
  passthrough: boolean,
  resultKey: string | undefined,
): ArraySource {
  const common: TransformNodeData = { fields, passthrough, ...(resultKey ? { resultKey } : {}) };
  return shape === 'array'
    ? { data: { ...common, mode: 'array' }, root: rows as Json }
    : { data: { ...common, itemsPath: 'rows' }, root: { rows } as Json };
}

const shapeArb = fc.constantFrom<'array' | 'itemsPath'>('array', 'itemsPath');
const resultKeyArb = fc.option(fc.constant('out'), { nil: undefined });

// ─────────────────────────────────────────────────────────────────────────────
// Claim 7 — length preservation (Requirement 5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe fields pin the record's source position and source element. They carry no
 * cast and no `required`, so they cannot change whether the call succeeds.
 */
const PROBE_FIELDS: readonly TransformField[] = [
  { target: '_probeIndex', expression: 'index' },
  { target: '_probeItem', expression: 'item' },
];

describe('Property 2 (claim 7): array projection preserves length and source order', () => {
  it('emits exactly one record per source element, in source order', () => {
    fc.assert(
      fc.property(
        sourceRowsArb,
        fieldsArb({ allowRequired: false }),
        shapeArb,
        fc.boolean(),
        resultKeyArb,
        (rows, fields, shape, passthrough, resultKey) => {
          const { data, root } = arraySource(
            rows,
            [...fields, ...PROBE_FIELDS],
            shape,
            passthrough,
            resultKey,
          );
          const result = attempt(data, root);
          // No field is required and every expression compiles, so the only
          // remaining failure mode — a non-array source — cannot occur here.
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const list = outputList(result.text, resultKey);
          expect(list).toHaveLength(rows.length);
          for (let i = 0; i < rows.length; i += 1) {
            const record = list[i] as Record<string, unknown>;
            expect(record._probeIndex).toBe(i);
            expect(record._probeItem).toStrictEqual(JSON.parse(JSON.stringify(rows[i])));
          }
        },
      ),
    );
  });

  it('keeps an empty source array an empty output array', () => {
    fc.assert(
      fc.property(fieldsArb({ allowRequired: false }), shapeArb, (fields, shape) => {
        const { data, root } = arraySource([], fields, shape, false, undefined);
        const result = attempt(data, root);
        expect(result.ok).toBe(true);
        if (result.ok) expect(outputList(result.text, undefined)).toHaveLength(0);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 8 — target coverage (Requirement 5.9)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 2 (claim 8): every required target is non-null, or the call failed', () => {
  it('holds for every generated field set over every generated row array', () => {
    fc.assert(
      fc.property(
        sourceRowsArb,
        fieldsArb({ allowRequired: true }),
        shapeArb,
        fc.boolean(),
        (rows, fields, shape, passthrough) => {
          const required = fields.filter((field) => field.required === true);
          const { data, root } = arraySource(rows, fields, shape, passthrough, undefined);
          const result = attempt(data, root);

          if (!result.ok) {
            // The only failure our construction allows is a null required value,
            // and it must name the offending target (Requirement 5.9).
            expect(result.error).toBeInstanceOf(DataNodeError);
            expect(required.map((field) => field.target)).toContain(result.error.target);
            return;
          }

          for (const record of outputList(result.text, undefined)) {
            for (const field of required) {
              const value = resolveJsonPath(record as Json, field.target);
              expect(value).not.toBeUndefined();
              expect(value).not.toBeNull();
            }
          }
        },
      ),
    );
  });

  it('is not vacuous: both branches are reachable', () => {
    const rows: Row[] = [{ group: 'a' }, { group: 'b' }];

    const satisfied = attempt(
      { mode: 'array', fields: [{ target: 'alpha', expression: 'index', required: true }] },
      rows as Json,
    );
    expect(satisfied.ok).toBe(true);
    if (satisfied.ok) {
      for (const record of outputList(satisfied.text, undefined)) {
        expect((record as Record<string, unknown>).alpha).toBeTypeOf('number');
      }
    }

    const breached = attempt(
      { mode: 'array', fields: [{ target: 'nested.one', expression: 'item.absent', required: true }] },
      rows as Json,
    );
    expect(breached.ok).toBe(false);
    if (!breached.ok) expect(breached.error.target).toBe('nested.one');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 9 — idempotence of casts (Requirement 5.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Epoch milliseconds across the full ECMAScript time range (±8.64e15), so values
 * inside the `date-iso` four-digit-year window and values well outside it (which
 * must cast to `null`) are both generated, plus realistic recent instants.
 */
const epochMsArb: fc.Arbitrary<Json> = fc.oneof(
  { weight: 2, arbitrary: fc.integer({ min: -2_000_000_000_000, max: 4_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.double({ min: -8.64e15, max: 8.64e15, noNaN: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom<Json>(
      -62_167_219_200_001,
      -62_167_219_200_000,
      253_402_300_799_999,
      253_402_300_800_000,
      8.64e15,
      -8.64e15,
      1e15,
    ),
  },
);

const isoStringArb: fc.Arbitrary<Json> = fc
  .tuple(
    fc.integer({ min: 1970, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
  )
  .map(([year, month, day, hour, minute]) => {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00.000Z`;
  });

const numericStringArb: fc.Arbitrary<Json> = jsonNumberArb.map((value) => String(value));

const boolWordArb: fc.Arbitrary<Json> = fc.constantFrom(
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'Y',
  ' n ',
  'maybe',
);

/** The shared JSON domain, weighted toward values the casts actually convert. */
const castableArb: fc.Arbitrary<Json> = fc.oneof(
  { weight: 4, arbitrary: jsonArb() },
  { weight: 2, arbitrary: epochMsArb },
  { weight: 2, arbitrary: isoStringArb },
  { weight: 2, arbitrary: numericStringArb },
  { weight: 1, arbitrary: boolWordArb },
);

describe('Property 2 (claim 9): casts are idempotent', () => {
  it('satisfies cast(cast(v, k), k) === cast(v, k) for every value and cast', () => {
    fc.assert(
      fc.property(castableArb, fc.constantFrom(...CASTS), (value, cast) => {
        const once = castValue(value, cast);
        expect(once).not.toBeUndefined();
        expect(castValue(once, cast)).toStrictEqual(once);
      }),
    );
  });

  it('is not vacuous: a converting cast is exercised for each kind', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CASTS), (cast) => {
        const converted = castValue(
          cast === 'date-iso' ? 1_700_000_000_000 : cast === 'boolean' ? 'yes' : '42',
          cast,
        );
        expect(converted).not.toBeNull();
        expect(castValue(converted, cast)).toStrictEqual(converted);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 10 — non-mutation, plus repeat-call stability (Requirements 5.13, 5.14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the projection over `root` and asserts the payload is untouched, whether
 * the call succeeded or failed, and that a second identical call is byte-identical.
 */
function expectPureOver(data: TransformNodeData, root: Json | undefined): void {
  const before = root === undefined ? undefined : JSON.stringify(root);
  const clone = root === undefined ? undefined : (structuredClone(root) as Json);

  // `attempt` hands `root` to the executor as `ctx.$`, so asserting on `root`
  // asserts on everything reachable from the payload the node was given.
  const first = attempt(data, root);
  // Both the serialisation and a deep clone taken before the call: the first
  // catches a changed shape or key order, the second catches an in-place value
  // swap. `toEqual`, not `toStrictEqual`: `fc.dictionary` hands out
  // null-prototype objects and `structuredClone` returns plain ones, which is a
  // property of the generator rather than of the payload's structure.
  expect(root === undefined ? undefined : JSON.stringify(root)).toBe(before);
  if (clone !== undefined) expect(root).toEqual(clone);

  const second = attempt(data, root);
  if (first.ok) {
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.text).toBe(first.text);
  } else {
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.target).toBe(first.error.target);
  }
  expect(root === undefined ? undefined : JSON.stringify(root)).toBe(before);
}

describe('Property 2 (claim 10): the incoming payload is never mutated', () => {
  it('leaves an array payload structurally unchanged, including through passthrough writes', () => {
    fc.assert(
      fc.property(
        sourceRowsArb,
        fieldsArb({ allowRequired: true }),
        shapeArb,
        fc.boolean(),
        resultKeyArb,
        (rows, fields, shape, passthrough, resultKey) => {
          const { data, root } = arraySource(rows, fields, shape, passthrough, resultKey);
          expectPureOver(data, root);
        },
      ),
    );
  });

  it('leaves a record-mode payload structurally unchanged', () => {
    fc.assert(
      fc.property(
        jsonArb(),
        fieldsArb({ allowRequired: true }),
        fc.boolean(),
        (root, fields, passthrough) => {
          expectPureOver({ mode: 'record', fields, passthrough }, root);
        },
      ),
    );
  });

  it('leaves the payload unchanged when the field list itself is rejected', () => {
    fc.assert(
      fc.property(sourceRowsArb, (rows) => {
        // An empty field list and a non-compiling expression both fail before any
        // record is projected (Requirements 5.2, 5.13).
        expectPureOver({ mode: 'array', fields: [] }, rows as Json);
        expectPureOver(
          { mode: 'array', fields: [{ target: 'alpha', expression: '$.a +' }] },
          rows as Json,
        );
      }),
    );
  });
});
