import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ExpressionError,
  MAX_EXPRESSION_CHARS,
  compileExpression,
  printExpression,
  validateExpression,
  type EvalContext,
  type ExprNode,
  type Json,
} from './expr.js';
import {
  expressionAstArb,
  expressionSourceArb,
  jsonObjectArb,
  renderExpression,
} from './test/generators.js';

/**
 * Property 1: Expression evaluation is total, pure and deterministic (design §4)
 * — claim 6:
 *
 *  6. **Termination.** ∀ generated expression string (valid or not),
 *     `compileExpression` returns or throws within a bounded step count; it never
 *     loops.
 *
 * Termination is asserted two ways. Structurally: every rejection is an
 * `ExpressionError` carrying the source and an in-range zero-based position, so
 * the lexer/parser always reached a decision rather than spinning (Requirement
 * 4.3). Behaviourally: each call is timed and must finish inside a per-call
 * budget, so a genuine loop fails the assertion instead of hanging the suite
 * (the 30s suite timeout is the outer net).
 *
 * The same claim is what makes the print/compile round trip meaningful, so the
 * `printExpression` obligations ride along here: printing is a pure function of
 * the compiled tree (Requirement 4.16) and re-compiling printed source yields the
 * same tree and the same value (Requirement 4.17). `printExpression` preserves
 * the tree exactly — parentheses carry no node, and a numeric field segment
 * prints back as `.0` rather than as a computed `[0]` subscript — so the round
 * trip is asserted as structural equality of ASTs, not merely equality of
 * evaluated values.
 *
 * Claims 1–5 (totality, determinism, purity, coercion, path safety) belong to
 * sibling tasks and are deliberately not asserted here.
 *
 * **Validates: Requirements 4.3, 4.16, 4.17**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wall-clock ceiling for one `compileExpression` / `validateExpression` call, in
 * milliseconds. Deliberately loose: it is a hang detector, not a benchmark. The
 * bounded work per call is a few thousand tokens at most, which lands three
 * orders of magnitude below this.
 */
const COMPILE_BUDGET_MS = 500;

/** Outcome of a call that is allowed to fail, flattened so it can be compared. */
type Outcome =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly error: string };

/** Runs `body`, timing it, and asserts it stayed inside the budget. */
function withinBudget<T>(body: () => T): T {
  const started = Date.now();
  try {
    return body();
  } finally {
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(COMPILE_BUDGET_MS);
  }
}

/** Compiles `source` inside the budget, returning the error instead of throwing. */
function compileOutcome(source: string): { ok: true } | { ok: false; error: ExpressionError } {
  return withinBudget(() => {
    try {
      compileExpression(source);
      return { ok: true } as const;
    } catch (error) {
      if (error instanceof ExpressionError) return { ok: false, error } as const;
      throw error;
    }
  });
}

/** Evaluates `source` against `context`, flattening an `ExpressionError` to a value. */
function evaluateOutcome(source: string, context: EvalContext): Outcome {
  try {
    return { ok: true, value: compileExpression(source).evaluate(context) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error: error.message };
    throw error;
  }
}

/** An `EvalContext` built from a generated payload, with a pinned clock. */
function contextArb(): fc.Arbitrary<EvalContext> {
  return fc
    .record({ payload: jsonObjectArb(), text: fc.string({ maxLength: 32 }) })
    .map(({ payload, text }) => ({
      $: payload as Json,
      $text: text,
      nowMs: 1_700_000_000_000,
      lookups: { codes: { a: 1 as Json, b: 2 as Json } },
    }));
}

/**
 * Adversarial source text. Random strings alone rarely reach the interesting
 * rejection paths, so the alphabet is narrowed to grammar characters and the
 * pathological shapes (unbalanced nesting past the depth cap, a source at and
 * over the character cap, an unterminated string, a trailing escape) are
 * generated explicitly.
 */
function hostileSourceArb(): fc.Arbitrary<string> {
  const grammarChars = "$.[]{}()+-*/%<>=!&|?:,'\"\\ \tabc019_";
  const grammarNoise = fc
    .array(fc.constantFrom(...grammarChars.split('')), { maxLength: 60 })
    .map((chars) => chars.join(''));
  const tokenSoup = fc
    .array(
      fc.constantFrom(
        '$',
        '$text',
        'item',
        'index',
        'in',
        'and',
        'or',
        'not',
        'null',
        'true',
        'upper',
        'map',
        'nope',
        '(',
        ')',
        '[',
        ']',
        '{',
        '}',
        ',',
        '?',
        ':',
        '.',
        '+',
        '==',
        "'x'",
        '1',
        '1.5',
      ),
      { maxLength: 24 },
    )
    .map((parts) => parts.join(' '));
  const nesting = fc
    .tuple(fc.constantFrom('(', '[', '{', '-', '!', '$.a'), fc.integer({ min: 1, max: 400 }))
    .map(([unit, count]) => unit.repeat(count));
  const atTheCap = fc
    .integer({ min: MAX_EXPRESSION_CHARS - 2, max: MAX_EXPRESSION_CHARS + 2 })
    .map((length) => `'${'x'.repeat(Math.max(0, length - 2))}'`);
  return fc.oneof(
    { weight: 3, arbitrary: grammarNoise },
    { weight: 3, arbitrary: tokenSoup },
    { weight: 2, arbitrary: fc.string({ maxLength: 48 }) },
    { weight: 2, arbitrary: nesting },
    { weight: 1, arbitrary: atTheCap },
    { weight: 1, arbitrary: fc.constantFrom('', ' ', "'unterminated", "'trailing\\", '$.', '1..2') },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 6 — termination
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1 claim 6: parser termination', () => {
  it('decides every source string inside a bounded budget, rejecting with an in-range position', () => {
    fc.assert(
      fc.property(hostileSourceArb(), (source) => {
        const outcome = compileOutcome(source);
        if (outcome.ok) return;
        // Requirement 4.3: the rejection carries the source and a zero-based
        // character position, and no `CompiledExpression` came back.
        expect(outcome.error.source).toBe(source);
        expect(outcome.error.message.length).toBeGreaterThan(0);
        if (outcome.error.position !== undefined) {
          expect(Number.isInteger(outcome.error.position)).toBe(true);
          expect(outcome.error.position).toBeGreaterThanOrEqual(0);
          expect(outcome.error.position).toBeLessThanOrEqual(source.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decides every well-formed source inside the same budget, and accepts it', () => {
    fc.assert(
      fc.property(expressionSourceArb({ maxDepth: 4 }), (source) => {
        expect(compileOutcome(source)).toEqual({ ok: true });
      }),
      { numRuns: 300 },
    );
  });

  it('validateExpression terminates on the same inputs and never throws', () => {
    fc.assert(
      fc.property(hostileSourceArb(), (source) => {
        const result = withinBudget(() => validateExpression(source));
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 4.16 — printing is a pure function of the compiled expression
// ─────────────────────────────────────────────────────────────────────────────

describe('printExpression is deterministic and produces compilable source (4.16)', () => {
  it('prints character-identical output per invocation and the output recompiles', () => {
    fc.assert(
      fc.property(expressionSourceArb({ maxDepth: 4 }), (source) => {
        const compiled = compileExpression(source);
        const first = printExpression(compiled);
        const second = printExpression(compiled);
        expect(second).toBe(first);
        expect(first.length).toBeGreaterThan(0);
        expect(first.length).toBeLessThanOrEqual(MAX_EXPRESSION_CHARS);
        // The printed text is itself accepted, and printing it again is a fixed
        // point — printing normalises, so a second pass changes nothing.
        const reprinted = printExpression(compileExpression(first));
        expect(reprinted).toBe(first);
      }),
      { numRuns: 300 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 4.17 — print → compile round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('print → compile round trip preserves tree and value (4.17)', () => {
  it('recompiles printed source to a structurally identical tree', () => {
    fc.assert(
      fc.property(expressionAstArb({ maxDepth: 4 }), (ast) => {
        const compiled = compileExpression(renderExpression(ast));
        const roundTripped = compileExpression(printExpression(compiled));
        expect(roundTripped.ast as ExprNode).toEqual(compiled.ast as ExprNode);
        // References are derived from the tree, so they travel with it.
        expect([...roundTripped.references]).toEqual([...compiled.references]);
      }),
      { numRuns: 300 },
    );
  });

  it('evaluates the printed source to the same value for the same EvalContext', () => {
    fc.assert(
      fc.property(expressionSourceArb({ maxDepth: 4 }), contextArb(), (source, context) => {
        const compiled = compileExpression(source);
        const printed = printExpression(compiled);
        expect(evaluateOutcome(printed, context)).toEqual(evaluateOutcome(source, context));
      }),
      { numRuns: 300 },
    );
  });
});
