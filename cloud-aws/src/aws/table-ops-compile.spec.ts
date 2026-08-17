/**
 * Property tests for the core-shape-to-SDK-command compiler.
 *
 * Feature: aws-byo-deploy, Property 10: Condition compilation is sound
 *
 * The compiler in `table-ops-compile.ts` is the only path from a pure
 * `ConditionNode` to a DynamoDB condition expression, so its soundness is the
 * whole guarantee behind the fencing invariant: if the compiled expression can
 * disagree with the decision the core layer made, a fenced write could be
 * accepted or rejected against the wrong condition.
 *
 * The reference verdict comes from `FakeRunTable` (through a no-mutation
 * `ConditionCheck`), so there is exactly one declaration of the pure semantics
 * rather than a second, divergent evaluator. The compiled verdict comes from the
 * small DynamoDB expression interpreter below, which reads the emitted string
 * plus the name and value maps the compiler filled in.
 *
 * Validates: Requirements 8.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ConditionNode, ExprValue, Item, ItemKey } from '../core/table-ops.js';
import { FakeRunTable, TransactionCancelledError } from '../test/fake-run-table.js';
import { compileCondition, type NameMap, type ValueMap } from './table-ops-compile.js';

/** The item every generated condition is evaluated against. */
const KEY: ItemKey = { pk: 'wf#w1', sk: 'lease' };

// ---------------------------------------------------------------------------
// Reference side: evaluate the node directly
// ---------------------------------------------------------------------------

/**
 * Evaluate a `ConditionNode` against an item using the pure semantics
 * `FakeRunTable` implements. A `ConditionCheck` mutates nothing, so the only
 * observable outcome is whether the transaction was cancelled.
 */
function evaluateDirect(node: ConditionNode, item: Item | null): boolean {
  const table = new FakeRunTable();
  if (item) table.seed(KEY, item);
  try {
    table.transactWrite({
      items: [{ type: 'conditionCheck', conditionCheck: { key: KEY, condition: node } }],
    });
    return true;
  } catch (error) {
    if (error instanceof TransactionCancelledError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compiled side: interpret the emitted DynamoDB expression
// ---------------------------------------------------------------------------

const OPERATORS = new Set(['=', '<>', '<=', '<', '>=', '>']);
const DELIMITERS = ' (),<>=';

/**
 * Split an expression into tokens. Parentheses and commas are always their own
 * token; every attribute reference is a `#nN` placeholder and every literal a
 * `:vN` placeholder, so no token can contain a delimiter.
 */
function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === ' ') {
      index++;
      continue;
    }
    if (char === '(' || char === ')' || char === ',') {
      tokens.push(char);
      index++;
      continue;
    }
    if (char === '<' || char === '>') {
      const next = expression[index + 1];
      if (char === '<' && next === '>') {
        tokens.push('<>');
        index += 2;
        continue;
      }
      if (next === '=') {
        tokens.push(`${char}=`);
        index += 2;
        continue;
      }
      tokens.push(char);
      index++;
      continue;
    }
    if (char === '=') {
      tokens.push('=');
      index++;
      continue;
    }
    let end = index;
    while (end < expression.length && !DELIMITERS.includes(expression[end])) end++;
    tokens.push(expression.slice(index, end));
    index = end;
  }
  return tokens;
}

/**
 * Mirrors the comparison semantics of the pure evaluator: numbers compare as
 * numbers, strings as strings, anything else supports only equality, and a
 * missing operand makes every ordering comparison false.
 */
function compareValues(op: string, left: unknown, right: unknown): boolean {
  if (left === undefined || left === null || right === undefined || right === null) {
    if (op === '=') return left === right;
    if (op === '<>') return left !== right;
    return false;
  }
  const comparable =
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string');
  if (comparable) {
    switch (op) {
      case '=':
        return left === right;
      case '<>':
        return left !== right;
      case '<=':
        return left <= right;
      case '<':
        return left < right;
      case '>=':
        return left >= right;
      case '>':
        return left > right;
    }
  }
  if (op === '=') return left === right;
  if (op === '<>') return left !== right;
  return false;
}

/**
 * Recursive-descent interpreter for the expression grammar the compiler emits:
 *
 *   or      := and ( 'OR' and )*
 *   and     := primary ( 'AND' primary )*
 *   primary := '(' or ')'
 *            | 'attribute_exists' '(' name ')'
 *            | 'attribute_not_exists' '(' name ')'
 *            | operand op operand
 *   operand := name | value | 'if_not_exists' '(' name ',' operand ')'
 */
class ExpressionInterpreter {
  private position = 0;

  constructor(
    private readonly tokens: string[],
    private readonly names: NameMap,
    private readonly values: ValueMap,
    private readonly item: Item | null,
  ) {}

  run(): boolean {
    const verdict = this.parseOr();
    if (this.position !== this.tokens.length) {
      throw new Error(`unconsumed tokens: ${this.tokens.slice(this.position).join(' ')}`);
    }
    return verdict;
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek() === 'OR') {
      this.position++;
      // Parse before combining: short-circuiting would leave tokens unread.
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parsePrimary();
    while (this.peek() === 'AND') {
      this.position++;
      const right = this.parsePrimary();
      left = left && right;
    }
    return left;
  }

  private parsePrimary(): boolean {
    const token = this.next();
    if (token === '(') {
      const verdict = this.parseOr();
      this.expect(')');
      return verdict;
    }
    if (token === 'attribute_exists' || token === 'attribute_not_exists') {
      this.expect('(');
      const path = this.resolveName(this.next());
      this.expect(')');
      const exists = this.attributeExists(path);
      return token === 'attribute_exists' ? exists : !exists;
    }
    const left = this.parseOperand(token);
    const op = this.next();
    if (!OPERATORS.has(op)) throw new Error(`expected a comparison operator, received '${op}'`);
    const right = this.parseOperand(this.next());
    return compareValues(op, left, right);
  }

  private parseOperand(token: string): unknown {
    if (token === 'if_not_exists') {
      this.expect('(');
      const path = this.resolveName(this.next());
      this.expect(',');
      const fallback = this.parseOperand(this.next());
      this.expect(')');
      const current = this.read(path);
      return current === undefined || current === null ? fallback : current;
    }
    if (token.startsWith('#')) return this.read(this.resolveName(token));
    if (token.startsWith(':')) {
      if (!(token in this.values)) throw new Error(`unmapped value placeholder '${token}'`);
      return this.values[token];
    }
    throw new Error(`expected an operand, received '${token}'`);
  }

  private resolveName(placeholder: string): string {
    const path = this.names[placeholder];
    if (path === undefined) throw new Error(`unmapped name placeholder '${placeholder}'`);
    return path;
  }

  private read(path: string): unknown {
    return this.item ? this.item[path] : undefined;
  }

  private attributeExists(path: string): boolean {
    return this.item !== null && path in this.item && this.item[path] !== undefined;
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new Error('unexpected end of expression');
    this.position++;
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected '${token}', received '${actual}'`);
  }
}

function evaluateCompiled(
  expression: string,
  names: NameMap,
  values: ValueMap,
  item: Item | null,
): boolean {
  return new ExpressionInterpreter(tokenize(expression), names, values, item).run();
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A small pool of attribute names, drawn small on purpose so a generated
 * condition actually hits the generated item. It carries the real Run_Table
 * names, a DynamoDB reserved word (`status`, `ttl`), and two names containing
 * `.` and `[0]` - a `path` names ONE top-level attribute and is never split, so
 * those must survive compilation as a single placeholder.
 */
const PATHS = [
  'pk',
  'sk',
  'fence',
  'expiresAtMs',
  'status',
  'ttl',
  'runId',
  'a.b',
  'items[0]',
  'absent',
];

const pathArb = fc.constantFrom(...PATHS);

/** Values narrow enough that comparisons land on both verdicts. */
const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom('', 'lease', 'zz'),
  fc.boolean(),
  fc.constant(null),
);

const leafExprArb: fc.Arbitrary<ExprValue> = fc.oneof(
  pathArb.map((path) => ({ type: 'path', path }) as ExprValue),
  valueArb.map((value) => ({ type: 'literal', value }) as ExprValue),
);

const ifNotExistsArb: fc.Arbitrary<ExprValue> = fc
  .record({ path: pathArb, fallback: leafExprArb })
  .map(({ path, fallback }) => ({ type: 'if_not_exists', path, fallback }) as ExprValue);

/** `if_not_exists` nests, so the fallback may itself be an `if_not_exists`. */
const exprValueArb: fc.Arbitrary<ExprValue> = fc.oneof(
  leafExprArb,
  ifNotExistsArb,
  fc
    .record({ path: pathArb, fallback: ifNotExistsArb })
    .map(({ path, fallback }) => ({ type: 'if_not_exists', path, fallback }) as ExprValue),
);

const { condition: conditionArb } = fc.letrec<{ condition: ConditionNode }>((tie) => ({
  condition: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    // The first entry is the fallback once the depth limit is reached, so it
    // must be non-recursive.
    pathArb.map((path) => ({ type: 'attribute_exists', path }) as ConditionNode),
    pathArb.map((path) => ({ type: 'attribute_not_exists', path }) as ConditionNode),
    fc
      .record({
        op: fc.constantFrom('=', '<>', '<=', '<', '>=', '>'),
        left: exprValueArb,
        right: exprValueArb,
      })
      .map(({ op, left, right }) => ({ type: 'compare', op, left, right }) as ConditionNode),
    // Empty junctions included on purpose: AND over nothing is a tautology and
    // OR over nothing a contradiction, and DynamoDB has no empty-junction
    // syntax, so the compiler has to emit an identity for each.
    fc
      .array(tie('condition'), { minLength: 0, maxLength: 3 })
      .map((children) => ({ type: 'and', children }) as ConditionNode),
    fc
      .array(tie('condition'), { minLength: 0, maxLength: 3 })
      .map((children) => ({ type: 'or', children }) as ConditionNode),
  ),
}));

/**
 * A candidate item, or `null` for the absent-item case. The table always stores
 * an item carrying its own key attributes, so the generated attributes are
 * overlaid onto the key exactly as `FakeRunTable.seed` does.
 */
const itemArb: fc.Arbitrary<Item | null> = fc.option(
  fc
    .dictionary(pathArb, valueArb, { maxKeys: PATHS.length })
    .map((attributes) => ({ ...attributes, pk: KEY.pk, sk: KEY.sk }) as Item),
  { nil: null },
);

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('table-ops-compile - Property 10: Condition compilation is sound', () => {
  /**
   * **Validates: Requirements 8.4**
   *
   * For any core `ConditionNode` and any candidate item, evaluating the node
   * directly and evaluating the compiled DynamoDB condition expression with its
   * name and value maps against the same item produce the same verdict.
   */
  it('the compiled expression agrees with direct evaluation', () => {
    fc.assert(
      fc.property(conditionArb, itemArb, (node, item) => {
        const names: NameMap = {};
        const values: ValueMap = {};
        const expression = compileCondition(node, names, values);

        const compiled = evaluateCompiled(expression, names, values, item);
        const direct = evaluateDirect(node, item);

        expect(compiled).toBe(direct);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 8.4**
   *
   * Every attribute reference and every literal leaves the expression as a
   * placeholder, so a reserved word or an odd attribute name can never reach
   * DynamoDB as text. Verdict agreement alone would not catch a leak that
   * happens to evaluate the same way.
   */
  it('emits no bare attribute name and no bare literal', () => {
    fc.assert(
      fc.property(conditionArb, (node) => {
        const names: NameMap = {};
        const values: ValueMap = {};
        const expression = compileCondition(node, names, values);

        for (const token of tokenize(expression)) {
          const structural =
            token === '(' ||
            token === ')' ||
            token === ',' ||
            token === 'AND' ||
            token === 'OR' ||
            token === 'attribute_exists' ||
            token === 'attribute_not_exists' ||
            token === 'if_not_exists' ||
            OPERATORS.has(token);
          if (structural) continue;
          expect(token).toMatch(/^[#:][nv]\d+$/);
        }
        for (const placeholder of Object.keys(names)) {
          expect(expression).toContain(placeholder);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Examples - the documented compilation decisions
// ---------------------------------------------------------------------------

describe('compileCondition - documented shapes', () => {
  it('deduplicates names by attribute and never deduplicates values', () => {
    const names: NameMap = {};
    const values: ValueMap = {};
    const expression = compileCondition(
      {
        type: 'and',
        children: [
          { type: 'compare', op: '=', left: { type: 'path', path: 'fence' }, right: { type: 'literal', value: 7 } },
          { type: 'compare', op: '>', left: { type: 'path', path: 'fence' }, right: { type: 'literal', value: 7 } },
        ],
      },
      names,
      values,
    );

    expect(Object.keys(names)).toHaveLength(1);
    expect(Object.keys(values)).toHaveLength(2);
    expect(expression).toBe('(#n0 = :v0) AND (#n0 > :v1)');
  });

  it('treats a dotted attribute name as one top-level attribute', () => {
    const names: NameMap = {};
    const values: ValueMap = {};
    const expression = compileCondition({ type: 'attribute_exists', path: 'a.b' }, names, values);

    expect(names).toEqual({ '#n0': 'a.b' });
    expect(expression).toBe('attribute_exists(#n0)');
  });

  it('compiles an empty AND to a tautology and an empty OR to a contradiction', () => {
    const andNames: NameMap = {};
    const andExpression = compileCondition({ type: 'and', children: [] }, andNames, {});
    const orNames: NameMap = {};
    const orExpression = compileCondition({ type: 'or', children: [] }, orNames, {});

    for (const item of [null, { pk: KEY.pk, sk: KEY.sk }] as (Item | null)[]) {
      expect(evaluateCompiled(andExpression, andNames, {}, item)).toBe(true);
      expect(evaluateCompiled(orExpression, orNames, {}, item)).toBe(false);
    }
  });

  it('compiles the fenced lease check verbatim', () => {
    const names: NameMap = {};
    const values: ValueMap = {};
    const expression = compileCondition(
      { type: 'compare', op: '=', left: { type: 'path', path: 'fence' }, right: { type: 'literal', value: 3 } },
      names,
      values,
    );

    expect(expression).toBe('#n0 = :v0');
    expect(names).toEqual({ '#n0': 'fence' });
    expect(values).toEqual({ ':v0': 3 });
  });
});
