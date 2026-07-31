import { describe, expect, it } from 'vitest';
import {
  compileExpression,
  EXPR_FUNCTIONS,
  ExpressionError,
  jsonEquals,
  MAX_EXPRESSION_CHARS,
  MAX_EXPRESSION_DEPTH,
  printExpression,
  truthy,
  validateExpression,
  type CompiledExpression,
  type EvalContext,
  type Json,
} from './expr.js';
import { resolveJsonPath } from './payload.js';
import { contentHash } from './state.js';

/** Evaluator core (task 2.2) and the `EXPR_FUNCTIONS` table (task 2.3). */

const PAYLOAD: Json = {
  amount: 10,
  label: 'open',
  flag: true,
  nothing: null,
  rows: [{ id: 'a' }, { id: 'b' }],
  nested: { deep: { value: 3 } },
};

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    $: PAYLOAD,
    $text: JSON.stringify(PAYLOAD),
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

const run = (source: string, context: EvalContext = ctx()): Json =>
  compileExpression(source).evaluate(context);

describe('evaluateExpression — context access', () => {
  it.each<[string, Json]>([
    ['$', PAYLOAD],
    ['$.amount', 10],
    ['amount', 10],
    ['$.nested.deep.value', 3],
    ['$.rows.1.id', 'b'],
    ['$.rows[1].id', 'b'],
    ['$.rows[$.amount].id', null],
    ['$.missing', null],
    ['$.missing.deeper', null],
    ['$.nothing.deeper', null],
    ['$.label.length', null],
    ['$.constructor', null],
  ])('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it('reads $text as the raw payload text', () => {
    expect(run('$text', ctx({ $: undefined, $text: 'not json' }))).toBe('not json');
  });

  it('returns null for $ and paths below $ when the payload is not JSON', () => {
    const context = ctx({ $: undefined, $text: 'not json' });
    expect(run('$', context)).toBeNull();
    expect(run('$.amount', context)).toBeNull();
  });

  it('binds item and index, and reads null when they are absent', () => {
    expect(run('item.id', ctx({ item: { id: 'x' } }))).toBe('x');
    expect(run('index', ctx({ index: 0 }))).toBe(0);
    expect(run('item')).toBeNull();
    expect(run('index')).toBeNull();
  });

  it('agrees with resolveJsonPath on every dotted path it resolves', () => {
    for (const path of ['amount', 'nested.deep.value', 'rows.0.id', 'rows.9.id', 'missing.x']) {
      expect(run(`$.${path}`)).toEqual(resolveJsonPath(PAYLOAD, path) ?? null);
    }
  });
});

describe('evaluateExpression — operators', () => {
  it.each<[string, Json]>([
    ['1 + 2', 3],
    ['10 / 4', 2.5],
    ['7 % 3', 1],
    ['-$.amount', -10],
    ['1 / 0', null],
    ['1 % 0', null],
    ['$.label + 1', null],
    ['1 + $.label', null],
    ["'a' + 'b'", 'ab'],
    ['$.missing + 1', null],
    ['$.flag * 2', null],
    ['1e308 * 10', null],
  ])('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it.each<[string, Json]>([
    ['$.amount > 5', true],
    ['$.amount > $.label', false],
    ['$.label > $.amount', false],
    ['$.amount <= 10', true],
    ["'a' < 'b'", true],
    ['$.flag > false', false],
    ['$.missing > 0', false],
  ])('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it('compares by JSON structural equality', () => {
    const context = ctx({
      $: { a: { x: 1, y: 2 }, b: { y: 2, x: 1 }, list: [1, 2], other: [2, 1] },
    });
    expect(run('$.a == $.b', context)).toBe(true);
    expect(run('$.a != $.b', context)).toBe(false);
    expect(run('$.list == $.other', context)).toBe(false);
    expect(run('$.list == [1, 2]', context)).toBe(true);
    expect(run("{'x': 1} == {'x': 1}", context)).toBe(true);
  });

  it('short-circuits && and || without touching the right operand', () => {
    // The right operand would divide by zero into a path read on null; short
    // circuiting means it is never evaluated at all.
    expect(run('false && $.nothing.deeper.more')).toBe(false);
    expect(run('true || $.nothing.deeper.more')).toBe(true);
    expect(run('$.amount > 5 && $.label == "open"')).toBe(true);
    expect(run('$.missing || $.amount == 10')).toBe(true);
  });

  it('evaluates the in operator per JSON type', () => {
    const context = ctx({ $: { list: ['a', 'b'], map: { a: 1 }, text: 'hello', n: 2 } });
    expect(run("'a' in $.list", context)).toBe(true);
    expect(run("'c' in $.list", context)).toBe(false);
    expect(run("'a' in $.map", context)).toBe(true);
    expect(run("'b' in $.map", context)).toBe(false);
    expect(run("'ell' in $.text", context)).toBe(true);
    expect(run("'zzz' in $.text", context)).toBe(false);
    expect(run("'a' in $.n", context)).toBe(false);
    expect(run('[1] in [[1], [2]]', context)).toBe(true);
  });

  it('evaluates ternaries, array and object literals', () => {
    expect(run('$.amount > 5 ? "big" : "small"')).toBe('big');
    expect(run('[1, $.amount]')).toEqual([1, 10]);
    expect(run("{'a': $.amount, 'b': [true]}")).toEqual({ a: 10, b: [true] });
  });

  it('applies ! over the shared truthiness rule', () => {
    expect(run('!$.missing')).toBe(true);
    expect(run('![]', ctx())).toBe(true);
    expect(run('!$.rows')).toBe(false);
  });
});

describe('evaluateExpression — now(), budgets and purity', () => {
  it('returns EvalContext.nowMs from every now() call', () => {
    const context = ctx({ nowMs: 42 });
    expect(run('now()', context)).toBe(42);
    expect(run('now() == now()', context)).toBe(true);
  });

  it('throws an ExpressionError naming the depth limit', () => {
    // A left-deep additive chain recurses once per operator.
    const source = new Array(MAX_EXPRESSION_DEPTH + 5).fill('1').join(' + ');
    expect(() => run(source)).toThrow(ExpressionError);
    expect(() => run(source)).toThrow(/maximum depth/);
  });

  it('leaves the supplied EvalContext structurally unchanged', () => {
    const context = ctx();
    const before = JSON.stringify({ $: context.$, $text: context.$text, nowMs: context.nowMs });
    run("{'a': $.rows, 'b': [$.amount]}", context);
    expect(JSON.stringify({ $: context.$, $text: context.$text, nowMs: context.nowMs })).toBe(before);
  });
});

describe('truthy and jsonEquals', () => {
  it.each<[Json, boolean]>([
    [null, false],
    [false, false],
    [true, true],
    [0, false],
    [1, true],
    ['', false],
    ['x', true],
    [[], false],
    [[0], true],
    [{}, false],
    [{ a: null }, true],
  ])('truthy(%j) is %s', (value, expected) => {
    expect(truthy(value)).toBe(expected);
  });

  it('compares nested structures by value, ignoring object key order', () => {
    expect(jsonEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals(0, '0')).toBe(false);
    expect(jsonEquals(null, false)).toBe(false);
  });
});

/**
 * `EXPR_FUNCTIONS` (task 2.3). Two things are being pinned down here: the value
 * each function produces for the types it accepts, and the fact that every other
 * type produces `null` rather than an exception (Requirement 4.20).
 */

const ROWS: Json = [
  { id: 'a', amount: 10, status: 'open' },
  { id: 'b', amount: 5, status: 'won' },
  { id: 'c', amount: null, status: 'open' },
];

const rowsCtx = (overrides: Partial<EvalContext> = {}): EvalContext =>
  ctx({ $: { rows: ROWS, text: ' Hi There ', n: -2.345, list: [3, 1, 2] }, ...overrides });

describe('EXPR_FUNCTIONS — strings', () => {
  it.each<[string, Json]>([
    ["upper('abc')", 'ABC'],
    ["lower('ABC')", 'abc'],
    ['trim($.text)', 'Hi There'],
    ["concat('a', 'b', 'c')", 'abc'],
    ["substr('abcdef', 1, 3)", 'bcd'],
    ["substr('abcdef', -2, 5)", 'ef'],
    ["substr('abcdef', 2, 0)", ''],
    ["replace('a-b-c', '-', '+')", 'a+b+c'],
    ["replace('abc', '', '+')", 'abc'],
    ["split('a,b', ',')", ['a', 'b']],
    ["join(['a', 1, true, null], '|')", 'a|1|true|'],
    ["startsWith('abc', 'ab')", true],
    ["endsWith('abc', 'bc')", true],
    ["contains('abc', 'b')", true],
    ["contains('abc', 'z')", false],
    ["padStart('7', 3, '0')", '007'],
    ["padStart('7777', 3, '0')", '7777'],
    ["padStart('7', 3, '')", '7'],
    ["length('abcd')", 4],
  ])('%s', (source, expected) => {
    expect(run(source, rowsCtx())).toEqual(expected);
  });

  it('returns null for a non-string argument', () => {
    for (const source of [
      'upper(1)',
      'lower($.rows)',
      'trim(null)',
      "concat('a', 2)",
      "substr('abc', 'x', 1)",
      "replace('abc', 1, 'x')",
      'split(1, 1)',
      "join('abc', '|')",
      "join(['a'], 1)",
      'startsWith(1, 1)',
      "endsWith('a', 1)",
      'contains(null, null)',
      "padStart('7', 100000, '0')",
      'length($.rows)',
    ]) {
      expect(run(source, rowsCtx())).toBeNull();
    }
  });
});

describe('EXPR_FUNCTIONS — numbers, logic and null handling', () => {
  it.each<[string, Json]>([
    ['abs($.n)', 2.345],
    ['round($.n, 2)', -2.35],
    ['round(2.5, 0)', 3],
    ['round(-2.5, 0)', -3],
    ['floor($.n)', -3],
    ['ceil($.n)', -2],
    ['min(4, 2, 9)', 2],
    ['max($.list)', 3],
    ["toNumber('  12.5 ')", 12.5],
    ["toNumber('12px')", null],
    ['toNumber(true)', 1],
    ["toInt('12.9')", 12],
    ['coalesce(null, null, 3, 4)', 3],
    ['coalesce(null, null)', null],
    ['ifNull(null, 7)', 7],
    ['ifNull(0, 7)', 0],
    ['isNull($.missing)', true],
    ['isNull(0)', false],
    ["isEmpty('   ')", true],
    ['isEmpty(0)', false],
    ['isEmpty([])', true],
    ["isEmpty({'a': 1})", false],
    ["toBool('No')", false],
    ["toBool('yes')", true],
    ['toBool([])', false],
    ['toString(12.5)', '12.5'],
    ['toString(false)', 'false'],
    ['toString(null)', null],
    ["toString({'b': 1, 'a': 2})", '{"a":2,"b":1}'],
  ])('%s', (source, expected) => {
    expect(run(source, rowsCtx())).toEqual(expected);
  });

  it('returns null for a non-numeric argument', () => {
    for (const source of [
      "abs('2')",
      "round('2', 1)",
      "round(2, 'x')",
      'floor(null)',
      'ceil($.rows)',
      "min(1, 'x')",
      'max($.rows)',
      'toNumber(null)',
      'toInt([])',
    ]) {
      expect(run(source, rowsCtx())).toBeNull();
    }
  });
});

describe('EXPR_FUNCTIONS — arrays and sub-expressions', () => {
  it.each<[string, Json]>([
    ['len($.rows)', 3],
    ["len('abc')", 3],
    ["len({'a': 1})", 1],
    ['count($.rows)', 3],
    ["sum($.rows, 'item.amount')", 15],
    ["avg($.rows, 'item.amount')", 7.5],
    ["avg([], 'item')", null],
    ["countIf($.rows, 'item.status == \"open\"')", 2],
    ["map($.rows, 'item.id')", ['a', 'b', 'c']],
    ["map($.rows, 'index')", [0, 1, 2]],
    ["filter($.rows, 'item.status == \"won\"')", [{ id: 'b', amount: 5, status: 'won' }]],
    ["distinct($.rows, 'item.status')", ['open', 'won']],
    ["sort($.list, 'item')", [1, 2, 3]],
    ["sort($.rows, 'item.amount')", [
      { id: 'c', amount: null, status: 'open' },
      { id: 'b', amount: 5, status: 'won' },
      { id: 'a', amount: 10, status: 'open' },
    ]],
    ['first($.list)', 3],
    ['last($.list)', 2],
    ['first([])', null],
    ['slice($.list, 1, 3)', [1, 2]],
    ['slice($.list, -1, 3)', [2]],
    ['flatten([[1, 2], 3, [4]])', [1, 2, 3, 4]],
    ["keys({'b': 1, 'a': 2})", ['b', 'a']],
    ["values({'b': 1, 'a': 2})", [1, 2]],
  ])('%s', (source, expected) => {
    expect(run(source, rowsCtx())).toEqual(expected);
  });

  it('returns null for a non-array source or an unusable sub-expression', () => {
    for (const source of [
      "sum('abc', 'item')",
      "map(1, 'item')",
      'filter($.rows, 42)',
      "sort($.rows, 'item.')",
      "countIf($.rows, '((')",
      "distinct($.rows, '')",
      'count($.text)',
      'len(1)',
      'slice($.text, 0, 1)',
      'flatten($.text)',
      'keys($.list)',
      'values(null)',
    ]) {
      expect(run(source, rowsCtx())).toBeNull();
    }
  });

  it('restores the enclosing item and index bindings when a call returns', () => {
    const context = rowsCtx({ item: { amount: 100 }, index: 7 });
    // The inner binding applies only inside the sub-expression; the outer one is
    // still readable in the very same expression afterwards.
    expect(run("sum($.rows, 'item.amount') + item.amount", context)).toBe(115);
    expect(run("map($.rows, 'index') == [0, 1, 2] && index == 7", context)).toBe(true);
    expect(context.item).toEqual({ amount: 100 });
    expect(context.index).toBe(7);
  });

  it('nests sub-expressions and shares one step budget', () => {
    const context = ctx({ $: { groups: [{ rows: [1, 2] }, { rows: [3] }] } });
    expect(run("map($.groups, 'sum(item.rows, \\'item\\')')", context)).toEqual([3, 3]);
    // 100000 evaluated nodes is the ceiling, sub-expression items included.
    const big = { $: { rows: new Array(60_000).fill({ n: 1 }) }, $text: '', nowMs: 0 };
    expect(() => run("sum($.rows, 'item.n')", big)).toThrow(ExpressionError);
    expect(() => run("sum($.rows, 'item.n')", big)).toThrow(/100000/);
  });
});

describe('EXPR_FUNCTIONS — dates', () => {
  const EPOCH = Date.UTC(2024, 2, 5, 6, 7, 8, 90);

  it.each<[string, Json]>([
    ["parseDate('2024-03-05T06:07:08.090Z')", EPOCH],
    ["parseDate('2024-03-05')", Date.UTC(2024, 2, 5)],
    ["parseDate('2024-03-05T06:07:08+02:00')", Date.UTC(2024, 2, 5, 4, 7, 8)],
    ["parseDate('2024-02-30')", null],
    ["parseDate('05/03/2024')", null],
    ['parseDate(1)', 1],
    ["formatDate(parseDate('2024-03-05T06:07:08.090Z'), 'iso')", '2024-03-05T06:07:08.090Z'],
    ["formatDate('2024-03-05T06:07:08.090Z', 'date')", '2024-03-05'],
    ["formatDate('2024-03-05T06:07:08.090Z', 'time')", '06:07:08'],
    ["formatDate('2024-03-05T06:07:08.090Z', 'datetime')", '2024-03-05 06:07:08'],
    ["formatDate('2024-03-05T06:07:08.090Z', 'epoch')", Math.floor(EPOCH / 1000)],
    ["formatDate('2024-03-05', 'wat')", null],
    ["formatDate($.rows, 'iso')", null],
    ["formatDate(0, 1)", null],
    ["formatDate(addDays('2024-03-05', 2), 'date')", '2024-03-07'],
    ["formatDate(addDays('2024-03-05', -5), 'date')", '2024-02-29'],
    ["addDays('2024-03-05', 'x')", null],
    ["dateDiffDays('2024-03-05', '2024-03-01')", 4],
    ["dateDiffDays('2024-03-01', '2024-03-05')", -4],
    ["dateDiffDays('nope', '2024-03-05')", null],
  ])('%s', (source, expected) => {
    expect(run(source, rowsCtx())).toEqual(expected);
  });

  it('reads the run clock, never the host clock', () => {
    expect(run("formatDate(now(), 'iso')", ctx({ nowMs: 0 }))).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('EXPR_FUNCTIONS — lookup, hash and jsonPath', () => {
  const lookupCtx = ctx({
    $: { status: 'open', code: 2, nested: { rows: [{ id: 'z' }] } },
    lookups: { stage: { open: 'Prospect', '2': 'Two' } },
  });

  it.each<[string, Json]>([
    ["lookup('stage', $.status)", 'Prospect'],
    ["lookup('stage', $.code)", 'Two'],
    ["lookup('stage', 'missing')", null],
    ["lookup('absent', 'open')", null],
    ['lookup(1, 1)', null],
    ["lookup('stage', $.nested)", null],
    ["jsonPath($, 'nested.rows.0.id')", 'z'],
    ["jsonPath($, 'nested.rows.9.id')", null],
    ["jsonPath($, 'constructor')", null],
    ['jsonPath($, 1)', null],
  ])('%s', (source, expected) => {
    expect(run(source, lookupCtx)).toEqual(expected);
  });

  it('returns null for lookup when the context carries no tables', () => {
    expect(run("lookup('stage', 'open')", ctx())).toBeNull();
  });

  it('agrees with jsonPath on every path resolveJsonPath resolves', () => {
    for (const path of ['nested.rows.0.id', 'status', 'missing.deep', 'nested.rows.5']) {
      expect(run(`jsonPath($, '${path}')`, lookupCtx)).toEqual(
        resolveJsonPath(lookupCtx.$, path) ?? null,
      );
    }
  });

  it('hashes the canonical form, so key order never fakes a change', () => {
    const context = ctx({ $: { a: { x: 1, y: [2, 3] }, b: { y: [2, 3], x: 1 } } });
    expect(run('hash($.a)', context)).toBe(contentHash({ x: 1, y: [2, 3] }));
    expect(run('hash($.a) == hash($.b)', context)).toBe(true);
    expect(run('hash(null)', context)).toBe(contentHash(null));
  });
});

describe('EXPR_FUNCTIONS — arity and names are compile-time errors', () => {
  it.each<[string, RegExp]>([
    ['nope(1)', /Unknown function 'nope'/],
    ['upper()', /upper\(\) expects 1 argument, received 0/],
    ["upper('a', 'b')", /upper\(\) expects 1 argument, received 2/],
    ["substr('a', 1)", /substr\(\) expects 3 arguments, received 2/],
    ['now(1)', /now\(\) expects 0 arguments, received 1/],
    ['concat()', /concat\(\) expects at least 1 argument, received 0/],
  ])('%s', (source, message) => {
    expect(() => compileExpression(source)).toThrow(ExpressionError);
    expect(() => compileExpression(source)).toThrow(message);
  });

  it('returns a JSON value for every listed function against a mismatched type', () => {
    // Generated from the table itself, so a function added later cannot skip the
    // totality check (Requirement 4.20).
    const context = ctx({ $: { v: { deep: true } } });
    for (const [name, arity] of Object.entries(EXPR_FUNCTIONS)) {
      const args = new Array(arity === -1 ? 1 : arity).fill('$.v').join(', ');
      const source = `${name}(${args})`;
      const value = run(source, context);
      // `typeof null` is 'object', so this admits null and rejects undefined.
      expect(['object', 'number', 'string', 'boolean']).toContain(typeof value);
    }
  });
});

/** `validateExpression` and `printExpression` (task 2.4). */

describe('validateExpression', () => {
  it.each([
    '$.amount',
    'amount',
    "$.amount > 5 && $.label == 'open' ? 'big' : 'small'",
    "sum($.rows, 'item.amount')",
    "{'a': [1, 2], 'b': $.nested.deep.value}",
    'not $.flag',
    '$.label in [1, 2]',
  ])('accepts %s', (source) => {
    expect(validateExpression(source)).toEqual({ ok: true });
  });

  it('reports the same message and position compileExpression throws', () => {
    for (const source of [
      '$.amount +',
      '1 = 1',
      'nope(1)',
      "upper('a', 'b')",
      '$.a[',
      "'unterminated",
      '{a: 1}',
      '',
      'and 1',
      new Array(MAX_EXPRESSION_DEPTH + 5).fill('(').join('') + '1',
    ]) {
      let thrown: ExpressionError | undefined;
      try {
        compileExpression(source);
      } catch (error) {
        thrown = error as ExpressionError;
      }
      expect(thrown, `expected ${JSON.stringify(source)} to be rejected`).toBeInstanceOf(
        ExpressionError,
      );

      const result = validateExpression(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(thrown!.message);
      expect(result.position).toBe(thrown!.position);
    }
  });

  it('throws for no input, including a non-string', () => {
    for (const input of [undefined, null, 42, {}, ['a']] as unknown as string[]) {
      expect(() => validateExpression(input)).not.toThrow();
      expect(validateExpression(input).ok).toBe(false);
    }
    expect(validateExpression('a'.repeat(MAX_EXPRESSION_CHARS + 1))).toEqual({
      ok: false,
      error: expect.stringContaining('maximum'),
      position: MAX_EXPRESSION_CHARS,
    });
  });
});

describe('printExpression', () => {
  const ROUND_TRIP: readonly string[] = [
    '$',
    '$text',
    '$.amount',
    'amount',
    '$.rows.1.id',
    '$.rows[$.amount].id',
    '1 + 2 * 3',
    '(1 + 2) * 3',
    '1 - (2 - 3)',
    '1 - 2 - 3',
    '-$.amount',
    '!$.flag',
    'not $.flag',
    '$.amount > 5 and $.label == "open"',
    '$.amount > 5 or $.label != "open"',
    '$.label in ["a", "b"]',
    '$.amount > 5 ? "big" : $.amount > 1 ? "mid" : "small"',
    '($.flag ? 1 : 2) + 3',
    "concat('a', $.label, 'c')",
    "sum($.rows, 'item.amount') + 1",
    "map($.rows, 'item.id')",
    "{'a': 1, 'b': [true, null, 'x'], 'c': $.nested.deep.value}",
    "{'quote\\'s': 'line\\nbreak\\ttab'}",
    "$.nested['deep'].value",
    "jsonPath($, 'nested.deep.value')",
    'now() - 1000',
    '1.5e3 / 2',
    "upper(trim($.label)) == 'OPEN'",
  ];

  it.each(ROUND_TRIP)('recompiles and revalues %s', (source) => {
    const compiled = compileExpression(source);
    const printed = printExpression(compiled);

    // Accepted by the compiler, and the same value for the same context.
    expect(validateExpression(printed)).toEqual({ ok: true });
    const reparsed = compileExpression(printed);
    expect(reparsed.evaluate(ctx())).toEqual(compiled.evaluate(ctx()));

    // Structurally equivalent: the second print is character-identical, so the
    // tree that came back is the tree that went in.
    expect(printExpression(reparsed)).toBe(printed);
    expect(reparsed.ast).toEqual(compiled.ast);
  });

  it('produces character-identical output on every invocation', () => {
    const compiled = compileExpression("filter($.rows, 'item.id == \"a\"')");
    const first = printExpression(compiled);
    expect(printExpression(compiled)).toBe(first);
    expect(printExpression(compileExpression(compiled.source))).toBe(first);
  });

  it('normalises word operators to their symbols', () => {
    expect(printExpression(compileExpression('not $.flag and $.amount > 1 or $.label'))).toBe(
      '!$.flag && $.amount > 1 || $.label',
    );
  });

  it('spaces adjacent numeric members so they cannot re-lex as one number', () => {
    expect(printExpression(compileExpression('$.rows.0.id'))).toBe('$.rows.0.id');
    const printed = printExpression(compileExpression('$.grid.0 .1'));
    expect(printed).toBe('$.grid.0 .1');
    expect(validateExpression(printed)).toEqual({ ok: true });
    expect(compileExpression(printed).ast).toEqual(compileExpression('$.grid.0 .1').ast);
  });

  it('rejects an argument that is not a compiled expression', () => {
    expect(() => printExpression(undefined as unknown as CompiledExpression)).toThrow(
      ExpressionError,
    );
  });
});
