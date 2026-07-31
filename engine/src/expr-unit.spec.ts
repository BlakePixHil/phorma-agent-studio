import { describe, expect, it } from 'vitest';
import {
  compileExpression,
  ExpressionError,
  MAX_EXPRESSION_CHARS,
  MAX_EXPRESSION_DEPTH,
  validateExpression,
  type EvalContext,
  type Json,
} from './expr.js';

/**
 * Unit coverage for the expression module (task 2.8).
 *
 * `expr.spec.ts` already pins down evaluator values, the function table and the
 * print round trip. This file closes the gaps that task leaves open:
 *
 *   - the exact zero-based `position` on every rejection class (Requirement 4.3)
 *   - lexer detail: quote styles, escapes, number forms, whitespace
 *   - the precedence/associativity table asserted by value (Requirement 4.2)
 *   - `references` deduplication, ordering and dynamic-segment truncation
 *   - unknown identifier, unknown function and wrong arity (Requirements 4.13, 4.15)
 */

const context = (value: Json | undefined = {}): EvalContext => ({
  $: value,
  $text: typeof value === 'undefined' ? '' : JSON.stringify(value),
  nowMs: 1_700_000_000_000,
});

const run = (source: string, ctx: EvalContext = context()): Json =>
  compileExpression(source).evaluate(ctx);

/** The `ExpressionError` `source` is rejected with. Fails when it compiles. */
function rejection(source: string): ExpressionError {
  try {
    compileExpression(source);
  } catch (error) {
    expect(error, `expected an ExpressionError for ${JSON.stringify(source)}`).toBeInstanceOf(
      ExpressionError,
    );
    return error as ExpressionError;
  }
  throw new Error(`expected ${JSON.stringify(source)} to be rejected`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lexer
// ─────────────────────────────────────────────────────────────────────────────

describe('lexer — string literals', () => {
  it.each<[string, string]>([
    ["'single'", 'single'],
    ['"double"', 'double'],
    ["''", ''],
    ['""', ''],
    ["'a\\nb'", 'a\nb'],
    ["'a\\tb'", 'a\tb'],
    ["'a\\rb'", 'a\rb'],
    ["'a\\bb'", 'a\bb'],
    ["'a\\fb'", 'a\fb'],
    ["'a\\\\b'", 'a\\b'],
    ["'a\\/b'", 'a/b'],
    ["'it\\'s'", "it's"],
    ['"say \\"hi\\""', 'say "hi"'],
    ["'\\u0041\\u00e9'", 'Aé'],
    ["'a\nb'", 'a\nb'],
    ['\'mixed "quotes"\'', 'mixed "quotes"'],
    ['"mixed \'quotes\'"', "mixed 'quotes'"],
  ])('%s', (source, expected) => {
    expect(run(source)).toBe(expected);
  });
});

describe('lexer — number literals', () => {
  it.each<[string, number]>([
    ['0', 0],
    ['42', 42],
    ['007', 7],
    ['1.5', 1.5],
    ['0.25', 0.25],
    ['1e3', 1000],
    ['1E3', 1000],
    ['1.5e2', 150],
    ['1.5e+2', 150],
    ['2e-2', 0.02],
  ])('%s', (source, expected) => {
    expect(run(source)).toBe(expected);
  });
});

describe('lexer — whitespace', () => {
  it('skips every whitespace form between tokens', () => {
    expect(run('\n\t 1\r\n+\f2\v ')).toBe(3);
    expect(run('  upper(  \n  \'a\'  )  ')).toBe('A');
  });

  it('keeps source verbatim, whitespace included', () => {
    const source = '  1 + 2  ';
    expect(compileExpression(source).source).toBe(source);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grammar: precedence and associativity, asserted by value
// ─────────────────────────────────────────────────────────────────────────────

describe('grammar — precedence and associativity', () => {
  it.each<[string, Json]>([
    // multiplicative over additive, left-associative within each level
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 * 3 % 4', 2],
    ['12 / 3 * 2', 8],
    ['1 - 2 - 3', -4],
    ['1 - (2 - 3)', 2],
    ['-7 % 3', -1],
    // unary over multiplicative
    ['-2 + 3', 1],
    ['2 - -3', 5],
    ['--1', 1],
    ['-2 * 3', -6],
    ['!true == false', true],
    // additive over comparison, comparison over equality
    ['1 + 1 == 2', true],
    ['1 + 1 in [2]', true],
    ['1 < 2 == true', true],
    ["'a' in ['a'] == true", true],
    // equality over &&, && over ||
    ['1 == 1 && 2 == 2', true],
    ['true || false && false', true],
    ['false || true && false', false],
    ['false && false || true', true],
    // ternary binds loosest, and nests on both branches
    ['true ? 1 : 2 + 3', 1],
    ['false ? 1 : 2 + 3', 5],
    ['false ? 1 : true ? 2 : 3', 2],
    ['true ? false ? 1 : 2 : 3', 2],
    ['1 + 2 > 2 ? "y" : "n"', 'y'],
    ['(true ? 1 : 2) + 10', 11],
  ])('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it.each<[string, Json]>([
    ['not false and true', true],
    ['not (1 > 2) or false', true],
    ['1 > 2 or 2 > 1', true],
    ['true and false or true', true],
    ['not not true', true],
    ['1 == 1 and not (2 == 3)', true],
  ])('word operator form: %s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  // `not` is a unary operator, never a function name: a following '(' opens a
  // grouped operand, with or without a space before it.
  it.each<[string, Json]>([
    ['not (1 > 2)', true],
    ['not(1 > 2)', true],
    ['not (1 < 2)', false],
    ['not(1)', false],
    ['not(0)', true],
    ['not ($.missing)', true],
    ['not (1 > 2) and not (3 > 4)', true],
    ['[not (1 > 2)]', [true]],
    ['upper(not (1 > 2) ? \'y\' : \'n\')', 'Y'],
  ])('not applies to a parenthesised operand: %s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it('parses word operators to the same tree as their symbols', () => {
    expect(compileExpression('$.a and $.b').ast).toEqual(compileExpression('$.a && $.b').ast);
    expect(compileExpression('$.a or $.b').ast).toEqual(compileExpression('$.a || $.b').ast);
    expect(compileExpression('not $.a').ast).toEqual(compileExpression('!$.a').ast);
    expect(compileExpression('not (1 > 2)').ast).toEqual(compileExpression('!(1 > 2)').ast);
    expect(compileExpression('not(1)').ast).toEqual(compileExpression('!1').ast);
  });

  it('accepts a reserved word as a field name', () => {
    const ctx = context({ in: 5, and: 1, or: 2, not: true, item: 'i', index: 9, null: null });
    expect(run('$.in', ctx)).toBe(5);
    expect(run('$.and + $.or', ctx)).toBe(3);
    expect(run('$.not', ctx)).toBe(true);
    expect(run('$.item', ctx)).toBe('i');
    expect(run('$.index', ctx)).toBe(9);
    expect(run("$['in'] == $.in", ctx)).toBe(true);
  });

  it('treats a bare identifier as shorthand for a field of $', () => {
    const ctx = context({ amount: { currency: 'EUR' }, rows: [{ id: 'a' }] });
    expect(compileExpression('amount').ast).toEqual(compileExpression('$.amount').ast);
    expect(compileExpression('amount.currency').ast).toEqual(
      compileExpression('$.amount.currency').ast,
    );
    expect(compileExpression('rows[0].id').ast).toEqual(compileExpression('$.rows[0].id').ast);
    expect(run('amount.currency', ctx)).toBe('EUR');
    expect(run('rows[0].id', ctx)).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// references (Requirement 4.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('references', () => {
  it.each<[string, readonly string[]]>([
    ['$', []],
    ['$text', []],
    ['42', []],
    ['$.amount', ['amount']],
    ['amount', ['amount']],
    ['amount.currency', ['amount.currency']],
    ['$.rows[0].id', ['rows.0.id']],
    ['$.rows.0.id', ['rows.0.id']],
    ["$.rows['x'].y", ['rows.x.y']],
    // deduplicated, first-occurrence order
    ['$.b + $.a + $.b.c', ['b', 'a', 'b.c']],
    ['$.rows.0 + $.rows[0]', ['rows.0']],
    ['$.a > 1 ? $.b : $.a', ['a', 'b']],
    ["{'k': $.z, 'j': [$.y, $.z]}", ['z', 'y']],
    // truncated at the first dynamic segment, which is itself a reference
    ['$.rows[$.i].id', ['rows', 'i']],
    ['$.rows[1 + 1].id', ['rows']],
    ['$.rows[index].id', ['rows']],
    // item paths are not paths of $
    ['item.x + index', []],
    // a sub-expression argument is a string at compile time, not a path
    ["sum($.rows, 'item.amount')", ['rows']],
  ])('%s', (source, expected) => {
    expect(compileExpression(source).references).toEqual(expected);
  });

  it('exposes references as an immutable list', () => {
    const compiled = compileExpression('$.a + $.b');
    expect(Object.isFrozen(compiled.references)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejections: message and exact zero-based position (Requirement 4.3)
// ─────────────────────────────────────────────────────────────────────────────

const OVERSIZED = 'a'.repeat(MAX_EXPRESSION_CHARS + 1);
const DEEP_PARENS = '('.repeat(MAX_EXPRESSION_DEPTH + 1) + '1' + ')'.repeat(MAX_EXPRESSION_DEPTH + 1);
const DEEP_UNARY = '!'.repeat(MAX_EXPRESSION_DEPTH + 1) + 'true';

describe('rejections — position and message', () => {
  it.each<[string, number, RegExp]>([
    // source bounds
    ['', 0, /empty/],
    [OVERSIZED, MAX_EXPRESSION_CHARS, /maximum of 4096/],
    // lexical
    ['1 = 1', 2, /Unexpected character '=' \(use '==' to compare\)/],
    ['$.a # 1', 4, /Unexpected character '#'/],
    ["'abc", 0, /Unterminated string literal/],
    ['1 + "abc', 4, /Unterminated string literal/],
    ["'a\\qb'", 2, /Invalid escape sequence '\\q'/],
    ["'\\uZZ01'", 1, /Invalid unicode escape/],
    ['1e999', 0, /out of range/],
    // syntactic
    ['1 + ', 4, /Unexpected end of expression/],
    ['1 2', 2, /Unexpected number 2/],
    ["1 'x'", 2, /Unexpected string 'x'/],
    ['$.a.', 4, /Expected a field name after '\.'/],
    ['1.', 2, /Expected a field name after '\.'/],
    ['$.a[', 4, /Unexpected end of expression/],
    ['$.a[1', 5, /Expected '\]'/],
    ['(1', 2, /Expected '\)'/],
    ['[1,]', 3, /Unexpected '\]'/],
    ['true ? 1', 8, /Expected ':'/],
    ['{a: 1}', 1, /Expected a quoted object key but found 'a'/],
    ["{'a' 1}", 5, /Expected ':' but found number 1/],
    ['and 1', 0, /Unexpected operator 'and'/],
    ['1 + in', 4, /Unexpected operator 'in'/],
    ['1 or', 4, /Unexpected end of expression/],
    // depth, measured while parsing so the stack can never be exhausted
    [DEEP_PARENS, MAX_EXPRESSION_DEPTH, /maximum depth of 64/],
    [DEEP_UNARY, MAX_EXPRESSION_DEPTH, /maximum depth of 64/],
  ])('%s', (source, position, message) => {
    const error = rejection(source);
    expect(error.message).toMatch(message);
    expect(error.position).toBe(position);
    expect(error.source).toBe(source);
  });

  it('rejects a non-string source with a position of 0', () => {
    for (const input of [undefined, null, 42, {}] as unknown as string[]) {
      const error = rejection(input);
      expect(error.message).toMatch(/must be a string/);
      expect(error.position).toBe(0);
    }
  });

  it('accepts a source exactly at the character cap', () => {
    const atCap = `'${'a'.repeat(MAX_EXPRESSION_CHARS - 2)}'`;
    expect(atCap.length).toBe(MAX_EXPRESSION_CHARS);
    expect(validateExpression(atCap)).toEqual({ ok: true });
  });
});

describe('rejections — unknown identifiers, unknown functions and arity', () => {
  it.each<[string, number, RegExp]>([
    ['$foo', 0, /Unknown identifier '\$foo'/],
    ['$textual', 0, /Unknown identifier '\$textual'/],
    ['$.a + foo$bar', 6, /Unknown identifier 'foo\$bar'/],
  ])('unknown identifier: %s', (source, position, message) => {
    const error = rejection(source);
    expect(error.message).toMatch(message);
    expect(error.position).toBe(position);
  });

  it.each<[string, number, RegExp]>([
    ['nope(1)', 0, /Unknown function 'nope'/],
    ['1 + nope(1)', 4, /Unknown function 'nope'/],
    ['upper(nope())', 6, /Unknown function 'nope'/],
    ['toUpper($.a)', 0, /Unknown function 'toUpper'/],
    // a name that only exists on Object.prototype is still unknown
    ['constructor(1)', 0, /Unknown function 'constructor'/],
    ['hasOwnProperty(1)', 0, /Unknown function 'hasOwnProperty'/],
  ])('unknown function: %s', (source, position, message) => {
    const error = rejection(source);
    expect(error.message).toMatch(message);
    expect(error.position).toBe(position);
  });

  // A word the grammar owns is never looked up in EXPR_FUNCTIONS, so a '(' after
  // one is a syntax error about the word, not `Unknown function`.
  it.each<[string, number, RegExp]>([
    ['true(1)', 4, /'true' cannot be called as a function/],
    ['false(1)', 5, /'false' cannot be called as a function/],
    ['null(1)', 4, /'null' cannot be called as a function/],
    ['item(1)', 4, /'item' cannot be called as a function/],
    ['index(1)', 5, /'index' cannot be called as a function/],
    ['$(1)', 1, /'\$' cannot be called as a function/],
    ['$text(1)', 5, /'\$text' cannot be called as a function/],
    ['[true(1)]', 5, /'true' cannot be called as a function/],
    // the operator words report as operators, not as unknown functions
    ['and(1)', 0, /Unexpected operator 'and'/],
    ['or(1)', 0, /Unexpected operator 'or'/],
    ['in(1)', 0, /Unexpected operator 'in'/],
  ])('reserved word in call position: %s', (source, position, message) => {
    const error = rejection(source);
    expect(error.message).toMatch(message);
    expect(error.message).not.toMatch(/Unknown function/);
    expect(error.position).toBe(position);
  });

  it.each<[string, number, RegExp]>([
    ['upper()', 0, /upper\(\) expects 1 argument, received 0/],
    ["upper('a', 'b')", 0, /upper\(\) expects 1 argument, received 2/],
    ['1 + upper()', 4, /upper\(\) expects 1 argument, received 0/],
    ["split('a')", 0, /split\(\) expects 2 arguments, received 1/],
    ["substr('a', 1)", 0, /substr\(\) expects 3 arguments, received 2/],
    ["substr('a', 1, 2, 3)", 0, /substr\(\) expects 3 arguments, received 4/],
    ['now(1)', 0, /now\(\) expects 0 arguments, received 1/],
    ['isNull()', 0, /isNull\(\) expects 1 argument, received 0/],
    ["map($.rows, 'item', 1)", 0, /map\(\) expects 2 arguments, received 3/],
  ])('fixed arity: %s', (source, position, message) => {
    const error = rejection(source);
    expect(error.message).toMatch(message);
    expect(error.position).toBe(position);
  });

  it.each<[string, number]>([
    ['concat()', 0],
    ['min()', 0],
    ['max()', 0],
    ['coalesce()', 0],
    ['1 + min()', 4],
  ])('variadic minimum: %s', (source, position) => {
    const error = rejection(source);
    expect(error.message).toMatch(/expects at least 1 argument, received 0/);
    expect(error.position).toBe(position);
  });

  it('accepts a variadic function with a single argument', () => {
    expect(run("concat('a')")).toBe('a');
    expect(run('min(3)')).toBe(3);
    expect(run('max(3)')).toBe(3);
    expect(run('coalesce(null)')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateExpression parity (Requirement 4.15)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateExpression — parity with compileExpression', () => {
  const REJECTED: readonly string[] = [
    '',
    '1 = 1',
    "'abc",
    "'a\\qb'",
    '$.a.',
    '$.a[1',
    '{a: 1}',
    '1 + in',
    '$foo',
    'nope(1)',
    'true(1)',
    'upper()',
    'concat()',
    DEEP_PARENS,
  ];

  it.each(REJECTED)('reports the thrown message and position for %s', (source) => {
    const error = rejection(source);
    expect(validateExpression(source)).toEqual({
      ok: false,
      error: error.message,
      position: error.position,
    });
  });

  it.each([
    '$',
    '$text',
    'amount',
    '$.in',
    'not false and true',
    'not (1 > 2)',
    'not(1)',
    '1 + 2 * 3',
    "concat('a', 'b')",
    "{'a': [1, 2]}",
    '  1  ',
  ])('accepts %s, exactly as compileExpression does', (source) => {
    expect(() => compileExpression(source)).not.toThrow();
    expect(validateExpression(source)).toEqual({ ok: true });
  });

  it('throws for no string input at all', () => {
    for (const input of [undefined, null, 42, {}, ['a']] as unknown as string[]) {
      expect(() => validateExpression(input)).not.toThrow();
      expect(validateExpression(input).ok).toBe(false);
    }
  });
});
