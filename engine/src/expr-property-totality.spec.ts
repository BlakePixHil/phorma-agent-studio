import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ExpressionError,
  MAX_EXPRESSION_STEPS,
  compileExpression,
  jsonEquals,
  type EvalContext,
  type Json,
} from './expr.js';
import { expressionSourceArb, jsonArb } from './test/generators.js';

/**
 * Property 1: Expression evaluation is total, pure and deterministic (design §4)
 * — claims 1, 2 and 3:
 *
 *  1. **Totality.** ∀ compilable `e`, ∀ JSON context `c`:
 *     `compile(e).evaluate(c)` returns a `Json` value or throws only
 *     `ExpressionError` for depth/step exhaustion. It never throws a
 *     `TypeError`, never returns `undefined`, and never returns `NaN`.
 *  2. **Determinism.** ∀ `e`, `c`: two evaluations of the same `(e, c)` —
 *     including `nowMs` — return structurally equal values.
 *  3. **Purity.** ∀ `e`, `c`: `c` is structurally unchanged after `evaluate`
 *     (deep-equal to a pre-call clone).
 *
 * Claims 4, 5 (no coercion, path safety) and 6 (parser termination, print
 * round-trip) belong to sibling tasks and are deliberately not asserted here.
 *
 * **Validates: Requirements 4.4, 4.11, 4.12, 4.19**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Lookup tables, the one context member reached only through `lookup()`. */
const lookupsArb: fc.Arbitrary<Record<string, Record<string, Json>>> = fc.dictionary(
  fc.constantFrom('users', 'codes'),
  fc.dictionary(fc.constantFrom('a', 'b', 'c'), jsonArb({ maxDepth: 1 }) as fc.Arbitrary<Json>, {
    maxKeys: 3,
  }),
  { maxKeys: 2 },
);

/**
 * An arbitrary `EvalContext`. `$` is generated as absent as well as present, and
 * `item`/`index` as bound as well as unbound, so the evaluator is exercised in
 * both the top-level and the per-item shape.
 */
const evalContextArb: fc.Arbitrary<EvalContext> = fc.record(
  {
    $: fc.oneof(
      { weight: 6, arbitrary: jsonArb({ maxDepth: 3 }) as fc.Arbitrary<Json | undefined> },
      { weight: 1, arbitrary: fc.constant(undefined) },
    ),
    $text: fc.string({ maxLength: 40 }),
    item: jsonArb({ maxDepth: 2 }) as fc.Arbitrary<Json>,
    index: fc.nat({ max: 20 }),
    lookups: lookupsArb,
    nowMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  },
  { requiredKeys: ['$', '$text', 'nowMs'] },
);

/** Well-formed expression source over the §4.2 grammar. */
const sourceArb: fc.Arbitrary<string> = expressionSourceArb({ maxDepth: 3 });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserts `value` lies inside the JSON domain: null, boolean, finite number,
 * string, array or plain object, with no `undefined` and no `NaN`/`Infinity`
 * anywhere inside it (Requirement 4.4). Iterative, so a deep result cannot blow
 * the checker's own stack.
 */
function assertJsonDomain(value: unknown, source: string): void {
  const pending: Array<{ node: unknown; path: string }> = [{ node: value, path: '$' }];
  while (pending.length > 0) {
    const { node, path } = pending.pop()!;
    const where = `${source} at ${path}`;

    if (node === null) continue;
    const kind = typeof node;
    if (kind === 'boolean' || kind === 'string') continue;
    if (kind === 'number') {
      expect(Number.isFinite(node as number), `non-finite number: ${where}`).toBe(true);
      continue;
    }
    expect(kind, `value outside the JSON domain: ${where}`).toBe('object');

    if (Array.isArray(node)) {
      node.forEach((element, index) => pending.push({ node: element, path: `${path}[${index}]` }));
      continue;
    }

    const proto = Object.getPrototypeOf(node as object);
    expect(proto === Object.prototype || proto === null, `not a plain object: ${where}`).toBe(true);
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      expect(child, `undefined property value: ${where}.${key}`).not.toBe(undefined);
      pending.push({ node: child, path: `${path}.${key}` });
    }
  }
}

/**
 * A byte-comparable snapshot of an `EvalContext`. The key list is captured
 * alongside the serialised value, so adding a property whose value is
 * `undefined` — which `JSON.stringify` would drop — still shows up as a change.
 */
function snapshotContext(context: EvalContext): string {
  return `${Object.keys(context).join('|')}::${JSON.stringify(context, jsonReplacer)}`;
}

/** Serialises `undefined` explicitly, so absence and presence differ. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return value === undefined ? '⟪undefined⟫' : value;
}

/** Re-throws anything that is not an `ExpressionError`, so claim 1 can see it. */
function evaluateOrExpressionError(
  source: string,
  context: EvalContext,
): { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly error: ExpressionError } {
  try {
    return { ok: true, value: compileExpression(source).evaluate(context) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error };
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 1: Totality
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1, claim 1: expression evaluation is total', () => {
  it('returns a Json value, or throws only ExpressionError, for every context', () => {
    fc.assert(
      fc.property(sourceArb, evalContextArb, (source, context) => {
        const outcome = evaluateOrExpressionError(source, context);
        if (!outcome.ok) {
          // The only permitted escape is a budget rejection (Requirement 4.19).
          expect(outcome.error.source).toBe(source);
          return;
        }
        expect(outcome.value, `undefined result: ${source}`).not.toBe(undefined);
        assertJsonDomain(outcome.value, source);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws for a context whose payload is absent', () => {
    fc.assert(
      fc.property(sourceArb, fc.string({ maxLength: 20 }), fc.nat(), (source, text, nowMs) => {
        const outcome = evaluateOrExpressionError(source, { $: undefined, $text: text, nowMs });
        if (outcome.ok) assertJsonDomain(outcome.value, source);
      }),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 2: Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1, claim 2: expression evaluation is deterministic', () => {
  it('returns structurally equal values for repeated evaluations of the same (e, c)', () => {
    fc.assert(
      fc.property(sourceArb, evalContextArb, (source, context) => {
        const compiled = compileExpression(source);
        const first = compiled.evaluate(context);
        const second = compiled.evaluate(context);
        // A fresh compile of the same source must agree with the reused one too.
        const third = compileExpression(source).evaluate(context);

        expect(jsonEquals(first, second)).toBe(true);
        expect(jsonEquals(first, third)).toBe(true);
        expect(second).toStrictEqual(first);
        expect(third).toStrictEqual(first);
      }),
      { numRuns: 300 },
    );
  });

  it('reads nowMs from the context and no ambient clock (4.11)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000_000 }), (nowMs) => {
        const context: EvalContext = { $: null, $text: '', nowMs };
        expect(compileExpression('now()').evaluate(context)).toBe(nowMs);
        // Every `now()` inside one evaluation reads the same instant.
        expect(compileExpression('now() - now()').evaluate(context)).toBe(0);
        expect(compileExpression('[now(), now()]').evaluate(context)).toStrictEqual([nowMs, nowMs]);
      }),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 3: Purity
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1, claim 3: expression evaluation is pure', () => {
  it('leaves the supplied EvalContext structurally unchanged (4.12)', () => {
    fc.assert(
      fc.property(sourceArb, evalContextArb, (source, context) => {
        const before = snapshotContext(context);
        evaluateOrExpressionError(source, context);
        expect(snapshotContext(context)).toBe(before);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves the context unchanged when evaluation exhausts its step budget (4.19)', () => {
    // 400 outer items, each evaluating a 400-item inner `map`: far above
    // MAX_EXPRESSION_STEPS, so the budget rejection is deterministic.
    const rows: Json = Array.from({ length: 400 }, (_, index) => index);
    const context: EvalContext = { $: { rows }, $text: '', item: { rows }, index: 0, nowMs: 1 };
    const before = snapshotContext(context);

    const outcome = evaluateOrExpressionError('map($.rows, \'map($.rows, "item")\')', context);

    expect(outcome.ok, 'expected the step budget to reject this expression').toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ExpressionError);
      expect(outcome.error.message).toContain(String(MAX_EXPRESSION_STEPS));
    }
    expect(snapshotContext(context)).toBe(before);
  });
});
