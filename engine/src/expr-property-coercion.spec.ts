import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileExpression, type EvalContext, type Json } from './expr.js';
import { resolveJsonPath } from './payload.js';
import { DEFAULT_JSON_KEYS, jsonArb, jsonNumberArb } from './test/generators.js';

/**
 * Property 1: Expression evaluation is total, pure and deterministic (design §4)
 * — claims 4 and 5.
 *
 * Claim 4, **No coercion**:
 *   ∀ non-numeric `x`: `evaluate('$.a + 1', {a: x})` is `null`, and
 *   `evaluate('$.a > 1', {a: x})` is `false`.
 *
 * Claim 5, **Path safety**:
 *   ∀ JSON `c`, ∀ dotted path `p`: `evaluate('$.'+p, c)` equals
 *   `resolveJsonPath(c, p) ?? null` — the evaluator and `engine/src/payload.ts`
 *   agree.
 *
 * Claim 4 is widened to the whole arithmetic and ordering surface the acceptance
 * criteria describe: every arithmetic operator with a non-numeric operand or a
 * zero divisor yields `null` and never `NaN`/`Infinity` (Requirement 4.6), every
 * ordering comparison across two different JSON types yields `false` in both
 * operand orders (Requirement 4.7), and `+` across a string/non-string pair
 * yields `null` rather than JS concatenation (Requirement 4.8).
 *
 * **Scope note on claim 5.** The path domain generated here holds ordinary data
 * keys and non-negative integer segments. `resolveJsonPath` reads inherited
 * properties (`$.constructor` hands back `Object`), while the evaluator reads own
 * properties only — deliberately, since an inherited value is outside the `Json`
 * domain. Prototype member names are therefore excluded from the domain rather
 * than asserted to agree; `expr.spec.ts` covers that divergence by example.
 *
 * **Validates: Requirements 4.6, 4.7, 4.8, 4.18**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** An `EvalContext` over one JSON root, with a fixed clock so nothing is ambient. */
function contextFor($: Json | undefined): EvalContext {
  return { $, $text: $ === undefined ? '' : JSON.stringify($), nowMs: 1_700_000_000_000 };
}

/** Compiles and evaluates in one step; every expression here is a constant source. */
function evaluate(source: string, $: Json | undefined): Json {
  return compileExpression(source).evaluate(contextFor($));
}

/** The six JSON type tags, used to decide whether an ordering pair is mixed. */
type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

function jsonTypeOf(value: Json): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'number' || kind === 'string') return kind;
  return 'object';
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Everything in the JSON domain except a number: the "no coercion" input set. */
const nonNumericJsonArb: fc.Arbitrary<Json> = jsonArb().filter(
  (value) => typeof value !== 'number',
);

const ARITHMETIC_OPS = ['+', '-', '*', '/', '%'] as const;
const ORDERING_OPS = ['<', '<=', '>', '>='] as const;

/** Field names a generated path may address. Identifier-safe, no prototype members. */
const FIELD_DOMAIN: readonly string[] = [...DEFAULT_JSON_KEYS, 'missing', 'other'];

const isIndexSegment = (segment: string): boolean => /^[0-9]+$/.test(segment);

/**
 * A dotted path: data keys plus non-negative integer segments, so the generated
 * path lands on objects, walks into arrays, and often addresses nothing at all.
 *
 * Two integer segments in a row are dropped down to one, because `$.0.0` lexes as
 * the single number literal `0.0` rather than as two path segments — a property of
 * the §4.2 NUMBER token, so such a string is not a path this claim quantifies over.
 * `$.items.0.id` (an index between two names) is generated freely.
 */
const dottedPathArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...FIELD_DOMAIN) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 3 }).map(String) },
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((segments) =>
    segments
      .filter(
        (segment, at) =>
          at === 0 || !isIndexSegment(segment) || !isIndexSegment(segments[at - 1]!),
      )
      .join('.'),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Claim 4 — no coercion (Requirements 4.6, 4.7, 4.8)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1 (claim 4): arithmetic never coerces a non-numeric operand', () => {
  it('evaluates `$.a + 1` to null for every non-numeric value', () => {
    fc.assert(
      fc.property(nonNumericJsonArb, (x) => {
        expect(evaluate('$.a + 1', { a: x })).toBeNull();
      }),
    );
  });

  it('evaluates every arithmetic operator to null when either operand is non-numeric', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ARITHMETIC_OPS),
        nonNumericJsonArb,
        jsonNumberArb,
        (op, x, n) => {
          expect(evaluate(`$.a ${op} $.b`, { a: x, b: n })).toBeNull();
          expect(evaluate(`$.b ${op} $.a`, { a: x, b: n })).toBeNull();
        },
      ),
    );
  });

  it('yields null instead of NaN, Infinity or -Infinity for any numeric pair', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ARITHMETIC_OPS), jsonNumberArb, jsonNumberArb, (op, a, b) => {
        const result = evaluate(`$.a ${op} $.b`, { a, b });
        if (result !== null) {
          expect(typeof result).toBe('number');
          expect(Number.isFinite(result as number)).toBe(true);
        }
        if ((op === '/' || op === '%') && b === 0) expect(result).toBeNull();
      }),
    );
  });

  it('returns null for `+` across a string and a non-string, and concatenates two strings', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        nonNumericJsonArb.filter((value) => typeof value !== 'string'),
        (text, other) => {
          expect(evaluate('$.a + $.b', { a: text, b: other })).toBeNull();
          expect(evaluate('$.b + $.a', { a: text, b: other })).toBeNull();
        },
      ),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), (a, b) => {
        expect(evaluate('$.a + $.b', { a, b })).toBe(a + b);
      }),
    );
  });
});

describe('Property 1 (claim 4): ordering comparisons never coerce', () => {
  it('evaluates `$.a > 1` to false for every non-numeric value, in both operand orders', () => {
    fc.assert(
      fc.property(nonNumericJsonArb, (x) => {
        expect(evaluate('$.a > 1', { a: x })).toBe(false);
        expect(evaluate('1 > $.a', { a: x })).toBe(false);
      }),
    );
  });

  it('returns false for every ordering operator across two different JSON types', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDERING_OPS),
        jsonArb(),
        jsonArb(),
        (op, left, right) => {
          fc.pre(jsonTypeOf(left) !== jsonTypeOf(right));
          expect(evaluate(`$.a ${op} $.b`, { a: left, b: right })).toBe(false);
          expect(evaluate(`$.b ${op} $.a`, { a: left, b: right })).toBe(false);
        },
      ),
    );
  });

  it('is not vacuous: same-type numbers and strings still compare', () => {
    fc.assert(
      fc.property(jsonNumberArb, jsonNumberArb, (a, b) => {
        expect(evaluate('$.a < $.b', { a, b })).toBe(a < b);
        expect(evaluate('$.a >= $.b', { a, b })).toBe(a >= b);
        expect(evaluate('$.a + $.b', { a, b })).toBe(a + b);
      }),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), (a, b) => {
        expect(evaluate('$.a < $.b', { a, b })).toBe(a < b);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 5 — path safety (Requirement 4.18)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1 (claim 5): path resolution agrees with resolveJsonPath', () => {
  it('resolves `$.p` to `resolveJsonPath(c, p) ?? null` for every JSON context and path', () => {
    fc.assert(
      fc.property(jsonArb(), dottedPathArb, (root, path) => {
        const expected = resolveJsonPath(root, path);
        expect(evaluate(`$.${path}`, root)).toStrictEqual(expected === undefined ? null : expected);
      }),
    );
  });

  it('resolves a bare `$` to the context root, and null when the payload was not JSON', () => {
    fc.assert(
      fc.property(jsonArb(), (root) => {
        expect(evaluate('$', root)).toStrictEqual(root);
      }),
    );
    expect(evaluate('$', undefined)).toBeNull();
  });

  it('returns null for every path below `$` when the context root is undefined', () => {
    fc.assert(
      fc.property(dottedPathArb, (path) => {
        expect(evaluate(`$.${path}`, undefined)).toBeNull();
      }),
    );
  });

  it('resolves a `[...]` subscript to the same value as the dotted segment', () => {
    fc.assert(
      fc.property(jsonArb(), fc.constantFrom(...FIELD_DOMAIN), (root, field) => {
        const expected = resolveJsonPath(root, field);
        const normalised = expected === undefined ? null : expected;
        expect(evaluate(`$['${field}']`, root)).toStrictEqual(normalised);
        expect(evaluate(`$.${field}`, root)).toStrictEqual(normalised);
      }),
    );
  });
});
