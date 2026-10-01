/**
 * Shared fast-check arbitraries for the engine test suites.
 *
 * Four generators are built once here and reused by every property suite in the
 * deterministic data path (design §"Testing Strategy"):
 *
 * 1. `jsonArb` — an arbitrary `Json` value, the domain the expression evaluator
 *    and every pure data node are closed over.
 * 2. `rowsArb` — an arbitrary row array with a controllable key domain, so
 *    grouping, joining and pivoting actually see colliding keys instead of a
 *    table of singletons.
 * 3. `expressionAstArb` + `renderExpression` — an arbitrary WELL-FORMED
 *    expression AST rendered to source, so the parser is exercised against valid
 *    input as well as fuzz.
 * 4. `runEventArb` — an arbitrary `RunEvent`, for the redaction and run-record
 *    properties.
 *
 * This module imports nothing but `fast-check` (a dev dependency) and engine
 * types. It adds no runtime dependency to the engine package.
 */

import fc from 'fast-check';
import type { RunEvent, RunScope } from '../events.js';
import type { ModelUsage } from '../model.js';
import type { SyncSummary } from '../run-record.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Arbitrary Json
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON value domain. Mirrors the `Json` type the expression evaluator exports
 * (design §4.1); declared locally so the test harness does not depend on module
 * load order while `engine/src/expr.ts` is still being built out.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: Json };

export interface JsonArbOptions {
  /** Nesting depth for arrays and objects. Default 3. */
  readonly maxDepth?: number;
  /** Max elements per generated array. Default 5. */
  readonly maxArrayLength?: number;
  /** Max properties per generated object. Default 5. */
  readonly maxKeys?: number;
  /**
   * Property-name domain. A small fixed domain makes structural collisions (and
   * therefore key/path redaction rules) actually fire. Default: a fixed set.
   */
  readonly keys?: readonly string[];
}

/** Default property-name domain: short, realistic, includes a secret-ish name. */
export const DEFAULT_JSON_KEYS: readonly string[] = [
  'id',
  'name',
  'amount',
  'status',
  'nested',
  'items',
  'token',
];

/**
 * Finite, JSON-round-trippable numbers (no NaN, no Infinity, no `-0`).
 *
 * `-0` is deliberately excluded rather than asserted around. `JSON.stringify(-0)`
 * is `"0"`, so `-0` does not survive a JSON round trip: it comes back as `+0`,
 * and deep-equality (`Object.is` semantics) treats the two as different values.
 * Since this arbitrary — and `jsonArb`, which builds on it — claims to generate
 * the JSON value domain, `-0` was never a member of that domain and its presence
 * was a defect in the generator, not in the properties that quantify over it.
 * The engine itself already normalises `-0` to `0` wherever it serialises numbers
 * (see `canonicalJson` in `state.ts`, the number printer in `expr.ts` and the
 * `int`/`number` casts in `data-nodes.ts`), so excluding it here loses no
 * coverage of real behaviour. Suites that specifically want to pin `-0` handling
 * add it to their own local domain (e.g. `data-nodes-batch-property.spec.ts`).
 */
export const jsonNumberArb: fc.Arbitrary<number> = fc
  .oneof(
    { weight: 3, arbitrary: fc.integer({ min: -10_000, max: 10_000 }) },
    {
      weight: 1,
      arbitrary: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
    },
  )
  .map((value) => (value === 0 ? 0 : value));

/** Scalar leaves of the JSON domain. */
export const jsonScalarArb: fc.Arbitrary<Json> = fc.oneof(
  fc.constant(null as Json),
  fc.boolean(),
  jsonNumberArb,
  fc.string({ maxLength: 24 }),
);

/** An arbitrary `Json` value with a bounded shape. */
export function jsonArb(options: JsonArbOptions = {}): fc.Arbitrary<Json> {
  const maxDepth = options.maxDepth ?? 3;
  const maxArrayLength = options.maxArrayLength ?? 5;
  const maxKeys = options.maxKeys ?? 5;
  const keyArb = fc.constantFrom(...(options.keys ?? DEFAULT_JSON_KEYS));

  const build = (depth: number): fc.Arbitrary<Json> => {
    if (depth <= 0) return jsonScalarArb;
    const inner = build(depth - 1);
    return fc.oneof(
      { weight: 4, arbitrary: jsonScalarArb },
      { weight: 1, arbitrary: fc.array(inner, { maxLength: maxArrayLength }) },
      {
        weight: 1,
        arbitrary: fc.dictionary(keyArb, inner, { maxKeys }) as fc.Arbitrary<Json>,
      },
    );
  };

  return build(maxDepth);
}

/** An arbitrary JSON **object** (never a bare scalar or array at the root). */
export function jsonObjectArb(options: JsonArbOptions = {}): fc.Arbitrary<JsonObject> {
  const keyArb = fc.constantFrom(...(options.keys ?? DEFAULT_JSON_KEYS));
  return fc.dictionary(keyArb, jsonArb({ ...options, maxDepth: (options.maxDepth ?? 3) - 1 }), {
    maxKeys: options.maxKeys ?? 5,
  }) as fc.Arbitrary<JsonObject>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Arbitrary row array with a controllable key domain
// ─────────────────────────────────────────────────────────────────────────────

/** One flat record, the shape `transform` and `aggregate` operate over. */
export type Row = { [key: string]: Json };

export interface RowsArbOptions {
  /**
   * Grouping/join key fields. Their values are drawn from `keyDomain`, so a
   * generated table reliably contains repeated keys.
   */
  readonly keyFields?: readonly string[];
  /** Value domain for every key field. Small on purpose. Default 3 values. */
  readonly keyDomain?: readonly (string | number)[];
  /** Numeric measure fields, for `sum`/`avg`/`min`/`max` metrics. */
  readonly numericFields?: readonly string[];
  /** Extra free-form fields carrying an arbitrary `Json` value. */
  readonly jsonFields?: readonly string[];
  readonly minRows?: number;
  readonly maxRows?: number;
  /**
   * True allows a key or numeric field to be absent or `null` on a row, which is
   * what exercises the "non-numeric values are excluded" and "absent path
   * resolves to null" branches. Default false.
   */
  readonly allowMissing?: boolean;
}

export const DEFAULT_KEY_FIELDS: readonly string[] = ['group', 'bucket'];
export const DEFAULT_KEY_DOMAIN: readonly string[] = ['a', 'b', 'c'];
export const DEFAULT_NUMERIC_FIELDS: readonly string[] = ['amount'];

/**
 * An arbitrary row array. Key fields draw from a small domain (`keyDomain`) so
 * grouping and joining see collisions; numeric fields are finite numbers.
 */
export function rowsArb(options: RowsArbOptions = {}): fc.Arbitrary<Row[]> {
  const keyFields = options.keyFields ?? DEFAULT_KEY_FIELDS;
  const keyDomain = options.keyDomain ?? DEFAULT_KEY_DOMAIN;
  const numericFields = options.numericFields ?? DEFAULT_NUMERIC_FIELDS;
  const jsonFields = options.jsonFields ?? [];
  const allowMissing = options.allowMissing ?? false;

  const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null | undefined> =>
    allowMissing
      ? fc.oneof(
          { weight: 6, arbitrary: arb as fc.Arbitrary<T | null | undefined> },
          { weight: 1, arbitrary: fc.constant(null) },
          { weight: 1, arbitrary: fc.constant(undefined) },
        )
      : (arb as fc.Arbitrary<T | null | undefined>);

  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const field of keyFields) shape[field] = maybe(fc.constantFrom(...keyDomain));
  for (const field of numericFields) shape[field] = maybe(jsonNumberArb);
  for (const field of jsonFields) shape[field] = jsonArb({ maxDepth: 2 });

  const rowArb = fc
    .record(shape, { requiredKeys: [] })
    // `undefined` is not a Json value: drop those properties so a "missing"
    // field really is absent rather than present-and-undefined.
    .map((raw) => {
      const row: Row = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) row[key] = value as Json;
      }
      return row;
    });

  return fc.array(rowArb, {
    minLength: options.minRows ?? 0,
    maxLength: options.maxRows ?? 12,
  });
}

/**
 * A pair of row arrays sharing one key domain — the input shape for join
 * cardinality and pivot round-trip properties.
 */
export function joinableRowsArb(options: RowsArbOptions = {}): fc.Arbitrary<{
  left: Row[];
  right: Row[];
}> {
  const left = rowsArb(options);
  const right = rowsArb({ ...options, numericFields: options.numericFields ?? ['weight'] });
  return fc.record({ left, right });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Arbitrary well-formed expression AST, rendered to source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A structurally valid expression tree over the design §4.2 grammar. This is the
 * harness's own AST: it exists to GENERATE valid source text, so it deliberately
 * stays independent of whatever internal AST `engine/src/expr.ts` parses into.
 */
export type ExprAst =
  | { readonly type: 'literal'; readonly value: null | boolean | number | string }
  | { readonly type: 'root' }
  | { readonly type: 'text' }
  | { readonly type: 'item' }
  | { readonly type: 'index' }
  | { readonly type: 'path'; readonly base: ExprAst; readonly segments: readonly ExprSegment[] }
  | { readonly type: 'unary'; readonly op: UnaryOp; readonly operand: ExprAst }
  | { readonly type: 'binary'; readonly op: BinaryOp; readonly left: ExprAst; readonly right: ExprAst }
  | {
      readonly type: 'ternary';
      readonly test: ExprAst;
      readonly then: ExprAst;
      readonly otherwise: ExprAst;
    }
  | { readonly type: 'call'; readonly name: string; readonly args: readonly ExprAst[] }
  | { readonly type: 'array'; readonly items: readonly ExprAst[] }
  | { readonly type: 'object'; readonly entries: readonly ExprEntry[] };

export type ExprSegment =
  | { readonly kind: 'field'; readonly name: string }
  | { readonly kind: 'index'; readonly expression: ExprAst };

export interface ExprEntry {
  readonly key: string;
  readonly value: ExprAst;
}

export type UnaryOp = '!' | '-';

export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

export const BINARY_OPS: readonly BinaryOp[] = [
  '||', '&&', '==', '!=', '<', '<=', '>', '>=', 'in', '+', '-', '*', '/', '%',
];

/** Plain functions from the §4.3 table, with their exact arity. */
export const FIXED_ARITY_FUNCTIONS: readonly { name: string; arity: number }[] = [
  { name: 'upper', arity: 1 },
  { name: 'lower', arity: 1 },
  { name: 'trim', arity: 1 },
  { name: 'length', arity: 1 },
  { name: 'startsWith', arity: 2 },
  { name: 'contains', arity: 2 },
  { name: 'abs', arity: 1 },
  { name: 'floor', arity: 1 },
  { name: 'ceil', arity: 1 },
  { name: 'round', arity: 2 },
  { name: 'toNumber', arity: 1 },
  { name: 'toInt', arity: 1 },
  { name: 'ifNull', arity: 2 },
  { name: 'isNull', arity: 1 },
  { name: 'isEmpty', arity: 1 },
  { name: 'toBool', arity: 1 },
  { name: 'toString', arity: 1 },
  { name: 'len', arity: 1 },
  { name: 'count', arity: 1 },
  { name: 'first', arity: 1 },
  { name: 'last', arity: 1 },
  { name: 'flatten', arity: 1 },
  { name: 'keys', arity: 1 },
  { name: 'values', arity: 1 },
  { name: 'slice', arity: 3 },
  { name: 'now', arity: 0 },
  { name: 'hash', arity: 1 },
];

/** Variadic functions from the §4.3 table (`arity: -1`). */
export const VARIADIC_FUNCTIONS: readonly string[] = ['concat', 'coalesce', 'min', 'max'];

/**
 * Functions whose second argument is a SUB-EXPRESSION STRING evaluated with
 * `item`/`index` bound (design §4.3).
 */
export const SUB_EXPRESSION_FUNCTIONS: readonly string[] = [
  'map', 'filter', 'sort', 'sum', 'avg', 'distinct', 'countIf',
];

/** Identifier-safe field names used in generated paths. */
export const DEFAULT_EXPR_FIELDS: readonly string[] = [
  'id', 'name', 'amount', 'status', 'rows', 'nested', 'total',
];

/** String literals restricted to characters that need no escaping. */
const plainStringArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9 _-]{0,10}$/);

const BASE_CONTEXT_NODES: ExprAst[] = [{ type: 'root' }, { type: 'text' }];
const ITEM_CONTEXT_NODES: ExprAst[] = [
  { type: 'root' },
  { type: 'text' },
  { type: 'item' },
  { type: 'index' },
];
const UNARY_OPS: UnaryOp[] = ['!', '-'];

export interface ExpressionArbOptions {
  /** Tree depth. Default 3. Depth 0 yields a primary only. */
  readonly maxDepth?: number;
  /** Field-name domain for `$.field` paths. */
  readonly fields?: readonly string[];
  /** True binds `item`/`index`, for sub-expression contexts. Default false. */
  readonly allowItem?: boolean;
}

/** An arbitrary well-formed expression AST. Render it with `renderExpression`. */
export function expressionAstArb(options: ExpressionArbOptions = {}): fc.Arbitrary<ExprAst> {
  const maxDepth = options.maxDepth ?? 3;
  const fields = options.fields ?? DEFAULT_EXPR_FIELDS;
  const fieldArb = fc.constantFrom(...fields);

  const literalArb: fc.Arbitrary<ExprAst> = fc.oneof(
    fc.constant<ExprAst>({ type: 'literal', value: null }),
    fc.boolean().map<ExprAst>((value) => ({ type: 'literal', value })),
    jsonNumberArb.map<ExprAst>((value) => ({ type: 'literal', value })),
    plainStringArb.map<ExprAst>((value) => ({ type: 'literal', value })),
  );

  const contextArb: fc.Arbitrary<ExprAst> = fc.constantFrom(
    ...(options.allowItem ? ITEM_CONTEXT_NODES : BASE_CONTEXT_NODES),
  );

  const build = (depth: number): fc.Arbitrary<ExprAst> => {
    if (depth <= 0) {
      return fc.oneof({ weight: 2, arbitrary: literalArb }, { weight: 3, arbitrary: pathArb(0) });
    }
    const inner = build(depth - 1);
    return fc.oneof(
      { weight: 3, arbitrary: literalArb },
      { weight: 4, arbitrary: pathArb(depth) },
      {
        weight: 4,
        arbitrary: fc
          .tuple(fc.constantFrom(...BINARY_OPS), inner, inner)
          .map<ExprAst>(([op, left, right]) => ({ type: 'binary', op, left, right })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.constantFrom(...UNARY_OPS), inner)
          .map<ExprAst>(([op, operand]) => ({ type: 'unary', op, operand })),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(inner, inner, inner)
          .map<ExprAst>(([test, then, otherwise]) => ({ type: 'ternary', test, then, otherwise })),
      },
      { weight: 3, arbitrary: callArb(depth) },
      {
        weight: 1,
        arbitrary: fc
          .array(inner, { maxLength: 3 })
          .map<ExprAst>((items) => ({ type: 'array', items })),
      },
      {
        weight: 1,
        arbitrary: fc
          .array(fc.record({ key: fieldArb, value: inner }), { maxLength: 3 })
          .map<ExprAst>((entries) => ({ type: 'object', entries })),
      },
    );
  };

  function pathArb(depth: number): fc.Arbitrary<ExprAst> {
    const segmentArb: fc.Arbitrary<ExprSegment> =
      depth <= 0
        ? fieldArb.map<ExprSegment>((name) => ({ kind: 'field', name }))
        : fc.oneof(
            {
              weight: 4,
              arbitrary: fieldArb.map<ExprSegment>((name) => ({ kind: 'field', name })),
            },
            {
              weight: 1,
              arbitrary: fc
                .integer({ min: 0, max: 3 })
                .map<ExprSegment>((i) => ({
                  kind: 'index',
                  expression: { type: 'literal', value: i },
                })),
            },
          );
    return fc
      .tuple(contextArb, fc.array(segmentArb, { minLength: 0, maxLength: 3 }))
      .map<ExprAst>(([base, segments]) =>
        segments.length === 0 ? base : { type: 'path', base, segments },
      );
  }

  function callArb(depth: number): fc.Arbitrary<ExprAst> {
    const argArb = build(depth - 1);
    const fixed = fc
      .constantFrom(...FIXED_ARITY_FUNCTIONS)
      .chain((fn) =>
        fc
          .array(argArb, { minLength: fn.arity, maxLength: fn.arity })
          .map<ExprAst>((args) => ({ type: 'call', name: fn.name, args })),
      );
    const variadic = fc
      .constantFrom(...VARIADIC_FUNCTIONS)
      .chain((name) =>
        fc
          .array(argArb, { minLength: 1, maxLength: 3 })
          .map<ExprAst>((args) => ({ type: 'call', name, args })),
      );
    const higherOrder = fc
      .constantFrom(...SUB_EXPRESSION_FUNCTIONS)
      .chain((name) =>
        fc
          .tuple(argArb, subExpressionSourceArb({ fields }))
          .map<ExprAst>(([list, source]) => ({
            type: 'call',
            name,
            args: [list, { type: 'literal', value: source }],
          })),
      );
    return fc.oneof(
      { weight: 3, arbitrary: fixed },
      { weight: 2, arbitrary: variadic },
      { weight: 2, arbitrary: higherOrder },
    );
  }

  return build(maxDepth);
}

/**
 * Source text for a sub-expression argument (`sum($.rows, 'item.amount')`).
 * Rendered with `item`/`index` in scope and free of single quotes, so it can be
 * embedded as a single-quoted literal without escaping.
 */
export function subExpressionSourceArb(
  options: Omit<ExpressionArbOptions, 'allowItem'> = {},
): fc.Arbitrary<string> {
  return expressionAstArb({ ...options, maxDepth: options.maxDepth ?? 1, allowItem: true }).map(
    (ast) => renderExpression(ast, { quote: '"' }),
  );
}

/** An arbitrary well-formed expression rendered to source text. */
export function expressionSourceArb(options: ExpressionArbOptions = {}): fc.Arbitrary<string> {
  return expressionAstArb(options).map((ast) => renderExpression(ast));
}

export interface RenderOptions {
  /** Quote character used for string literals. Default `'`. */
  readonly quote?: "'" | '"';
}

/**
 * Renders an `ExprAst` to grammar-conformant source. Every compound form is fully
 * parenthesised, so the rendered text parses back to this exact tree regardless
 * of operator precedence.
 */
export function renderExpression(ast: ExprAst, options: RenderOptions = {}): string {
  const quote = options.quote ?? "'";
  const str = (value: string): string => {
    const escaped = value.split('\\').join('\\\\').split(quote).join(`\\${quote}`);
    return `${quote}${escaped}${quote}`;
  };

  const render = (node: ExprAst): string => {
    switch (node.type) {
      case 'literal':
        if (node.value === null) return 'null';
        if (typeof node.value === 'boolean') return node.value ? 'true' : 'false';
        if (typeof node.value === 'number') return renderNumber(node.value);
        return str(node.value);
      case 'root':
        return '$';
      case 'text':
        return '$text';
      case 'item':
        return 'item';
      case 'index':
        return 'index';
      case 'path': {
        let out = render(node.base);
        for (const segment of node.segments) {
          out += segment.kind === 'field' ? `.${segment.name}` : `[${render(segment.expression)}]`;
        }
        return out;
      }
      case 'unary':
        return `(${node.op}${render(node.operand)})`;
      case 'binary':
        return `(${render(node.left)} ${node.op} ${render(node.right)})`;
      case 'ternary':
        return `(${render(node.test)} ? ${render(node.then)} : ${render(node.otherwise)})`;
      case 'call':
        return `${node.name}(${node.args.map(render).join(', ')})`;
      case 'array':
        return `[${node.items.map(render).join(', ')}]`;
      case 'object':
        return `{${node.entries.map((e) => `${str(e.key)}: ${render(e.value)}`).join(', ')}}`;
    }
  };

  return render(ast);
}

/** Numbers rendered so the lexer sees a plain NUMBER token, never `1e-7`. */
function renderNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Arbitrary RunEvent
// ─────────────────────────────────────────────────────────────────────────────

const idArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9-]{2,10}$/);
const textArb: fc.Arbitrary<string> = fc.string({ maxLength: 40 });
const atArb: fc.Arbitrary<number> = fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 });

/** An arbitrary nested-workflow scope frame. */
export const runScopeArb: fc.Arbitrary<RunScope> = fc.record({
  nodeId: idArb,
  workflowId: idArb,
  workflowName: textArb,
  frameId: idArb,
  depth: fc.integer({ min: 0, max: 4 }),
});

/** An arbitrary root-to-leaf scope path. */
export const runScopePathArb: fc.Arbitrary<RunScope[]> = fc.array(runScopeArb, { maxLength: 3 });

/** An https url with a path — the shape a data node's request event carries. */
const urlArb: fc.Arbitrary<string> = fc
  .tuple(idArb, fc.array(idArb, { maxLength: 3 }))
  .map(([host, segments]) => `https://${host}.example.com/${segments.join('/')}`);

/** An arbitrary {@link SyncSummary}: counts only, never row contents. */
export const syncSummaryArb: fc.Arbitrary<SyncSummary> = fc.record(
  {
    sources: fc.dictionary(
      idArb,
      fc.record(
        {
          rows: fc.nat({ max: 100_000 }),
          pages: fc.integer({ min: 1, max: 1000 }),
          truncated: fc.boolean(),
        },
        { requiredKeys: ['rows'] },
      ),
      { maxKeys: 3 },
    ),
    considered: fc.nat({ max: 100_000 }),
    changed: fc.nat({ max: 100_000 }),
    written: fc.nat({ max: 100_000 }),
    skipped: fc.nat({ max: 100_000 }),
    failed: fc.nat({ max: 100_000 }),
    targetStatuses: fc.dictionary(
      fc.constantFrom('200', '201', '204', '400', '429', '500'),
      fc.integer({ min: 1, max: 1000 }),
      { maxKeys: 3 },
    ),
    guards: fc.array(
      fc.record(
        { name: idArb, passed: fc.boolean(), message: textArb },
        { requiredKeys: ['name', 'passed'] },
      ),
      { maxLength: 3 },
    ),
    watermark: fc.record(
      { key: idArb, from: textArb, to: textArb },
      { requiredKeys: ['key', 'to'] },
    ),
  },
  {
    requiredKeys: [
      'sources',
      'considered',
      'changed',
      'written',
      'skipped',
      'failed',
      'targetStatuses',
    ],
  },
);

const usageArb: fc.Arbitrary<ModelUsage> = fc.record(
  {
    inputTokens: fc.integer({ min: 0, max: 100_000 }),
    outputTokens: fc.integer({ min: 0, max: 100_000 }),
    costUsd: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
    costSource: fc.constantFrom('reported' as const, 'estimated' as const),
  },
  { requiredKeys: [] },
);

/**
 * An arbitrary `RunEvent` covering every variant of the discriminated union.
 * Each entry is generated from the variant's own field shape, so a new event
 * type added to `engine/src/events.ts` shows up here as a compile error rather
 * than as silently untested surface.
 */
export const runEventArb: fc.Arbitrary<RunEvent> = fc
  .oneof(
    ...([
      fc.record({ type: fc.constant('run-started'), runId: idArb, input: textArb, at: atArb }),
      fc.record({ type: fc.constant('node-started'), runId: idArb, nodeId: idArb, nodeName: textArb, at: atArb }),
      fc.record({ type: fc.constant('node-token'), runId: idArb, nodeId: idArb, token: textArb }),
      fc.record({ type: fc.constant('node-thinking'), runId: idArb, nodeId: idArb, token: textArb }),
      fc.record({
        type: fc.constant('node-usage'),
        runId: idArb,
        nodeId: idArb,
        provider: idArb,
        model: idArb,
        usage: usageArb,
        at: atArb,
      }),
      fc.record({ type: fc.constant('node-completed'), runId: idArb, nodeId: idArb, nodeName: textArb, output: textArb, at: atArb }),
      fc.record({ type: fc.constant('node-failed'), runId: idArb, nodeId: idArb, nodeName: textArb, error: textArb, at: atArb }),
      fc.record({
        type: fc.constant('node-retrying'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        attempt: fc.integer({ min: 1, max: 5 }),
        maxAttempts: fc.integer({ min: 1, max: 5 }),
        delayMs: fc.integer({ min: 0, max: 120_000 }),
        error: textArb,
        at: atArb,
      }),
      fc.record({
        type: fc.constant('node-fallback'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        fromProvider: idArb,
        fromModel: idArb,
        toProvider: idArb,
        toModel: idArb,
        error: textArb,
        at: atArb,
      }),
      fc.record({ type: fc.constant('node-error-routed'), runId: idArb, nodeId: idArb, nodeName: textArb, error: textArb, at: atArb }),
      fc.record({
        type: fc.constant('context-compressed'),
        runId: idArb,
        nodeId: idArb,
        beforeTokens: fc.integer({ min: 0, max: 100_000 }),
        afterTokens: fc.integer({ min: 0, max: 100_000 }),
        at: atArb,
      }),
      fc.record({ type: fc.constant('handoff'), runId: idArb, connectionId: idArb, fromNodeId: idArb, toNodeId: idArb, payload: textArb, at: atArb }),
      fc.record({ type: fc.constant('tool-call'), runId: idArb, nodeId: idArb, toolNodeId: idArb, name: idArb, arguments: textArb, at: atArb }),
      fc.record({ type: fc.constant('tool-result'), runId: idArb, nodeId: idArb, toolNodeId: idArb, name: idArb, result: textArb, isError: fc.boolean(), at: atArb }),
      fc.record({ type: fc.constant('approval-required'), runId: idArb, requestId: idArb, nodeId: idArb, message: textArb, payload: textArb, at: atArb }),
      fc.record({ type: fc.constant('approval-resolved'), runId: idArb, requestId: idArb, nodeId: idArb, approved: fc.boolean(), at: atArb }),
      fc.record({ type: fc.constant('ask-required'), runId: idArb, requestId: idArb, nodeId: idArb, nodeName: textArb, question: textArb, payload: textArb, at: atArb }),
      fc.record({ type: fc.constant('ask-resolved'), runId: idArb, requestId: idArb, nodeId: idArb, response: textArb, at: atArb }),
      fc.record({ type: fc.constant('loop-started'), runId: idArb, nodeId: idArb, nodeName: textArb, total: fc.nat({ max: 100 }), at: atArb }),
      fc.record({
        type: fc.constant('loop-iteration'),
        runId: idArb,
        nodeId: idArb,
        index: fc.nat({ max: 100 }),
        total: fc.nat({ max: 100 }),
        item: textArb,
        at: atArb,
      }),
      fc.record({
        type: fc.constant('loop-completed'),
        runId: idArb,
        nodeId: idArb,
        total: fc.nat({ max: 100 }),
        succeeded: fc.nat({ max: 100 }),
        failed: fc.nat({ max: 100 }),
        at: atArb,
      }),
      fc.record({ type: fc.constant('wait-started'), runId: idArb, nodeId: idArb, nodeName: textArb, correlationKey: idArb, message: textArb, payload: textArb, at: atArb }),
      fc.record({ type: fc.constant('wait-resolved'), runId: idArb, nodeId: idArb, correlationKey: idArb, eventPayload: textArb, at: atArb }),
      fc.record({
        type: fc.constant('subworkflow-started'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        workflowId: idArb,
        workflowName: textArb,
        depth: fc.integer({ min: 0, max: 4 }),
        input: textArb,
        at: atArb,
      }),
      fc.record({
        type: fc.constant('subworkflow-completed'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        workflowId: idArb,
        workflowName: textArb,
        depth: fc.integer({ min: 0, max: 4 }),
        output: textArb,
        at: atArb,
      }),
      fc.record({
        type: fc.constant('subworkflow-failed'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        workflowId: idArb,
        workflowName: textArb,
        depth: fc.integer({ min: 0, max: 4 }),
        error: textArb,
        at: atArb,
      }),
      // Deterministic data path events. Optional members (`body`, `truncated`)
      // are generated as present-or-absent so redaction and run-record
      // properties see both shapes.
      fc.record(
        {
          type: fc.constant('http-request'),
          runId: idArb,
          nodeId: idArb,
          nodeName: textArb,
          method: fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
          url: urlArb,
          attempt: fc.integer({ min: 1, max: 5 }),
          body: textArb,
          at: atArb,
        },
        { requiredKeys: ['type', 'runId', 'nodeId', 'nodeName', 'method', 'url', 'attempt', 'at'] },
      ),
      fc.record(
        {
          type: fc.constant('http-response'),
          runId: idArb,
          nodeId: idArb,
          status: fc.integer({ min: 100, max: 599 }),
          durationMs: fc.integer({ min: 0, max: 120_000 }),
          byteCount: fc.nat({ max: 5_000_000 }),
          truncated: fc.boolean(),
          body: textArb,
          at: atArb,
        },
        { requiredKeys: ['type', 'runId', 'nodeId', 'status', 'durationMs', 'byteCount', 'at'] },
      ),
      fc.record({
        type: fc.constant('page-fetched'),
        runId: idArb,
        nodeId: idArb,
        page: fc.integer({ min: 1, max: 1000 }),
        items: fc.nat({ max: 1000 }),
        hasMore: fc.boolean(),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('sql-query'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        driver: fc.constantFrom('postgres', 'mysql', 'mssql', 'sqlite'),
        statement: textArb,
        paramCount: fc.nat({ max: 32 }),
        at: atArb,
      }),
      fc.record(
        {
          type: fc.constant('sql-result'),
          runId: idArb,
          nodeId: idArb,
          rowCount: fc.nat({ max: 100_000 }),
          durationMs: fc.integer({ min: 0, max: 120_000 }),
          truncated: fc.boolean(),
          at: atArb,
        },
        { requiredKeys: ['type', 'runId', 'nodeId', 'rowCount', 'durationMs', 'at'] },
      ),
      fc.record({
        type: fc.constant('state-read'),
        runId: idArb,
        nodeId: idArb,
        key: idArb,
        found: fc.boolean(),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('state-written'),
        runId: idArb,
        nodeId: idArb,
        key: idArb,
        semantics: fc.constantFrom('value' as const, 'delta' as const, 'watermark' as const),
        changed: fc.boolean(),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('assert-passed'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        checked: fc.integer({ min: 1, max: 50 }),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('assert-breached'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        assertion: textArb,
        message: textArb,
        severity: fc.constantFrom('error' as const, 'warn' as const),
        routed: fc.boolean(),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('notify-sent'),
        runId: idArb,
        nodeId: idArb,
        channel: fc.constantFrom('email', 'slack', 'webhook'),
        target: textArb,
        at: atArb,
      }),
      fc.record({
        type: fc.constant('artifact-created'),
        runId: idArb,
        nodeId: idArb,
        nodeName: textArb,
        artifact: fc.record({
          id: idArb,
          name: textArb,
          mimeType: fc.constantFrom('application/pdf', 'text/csv'),
          sizeBytes: fc.nat({ max: 1_048_576 }),
        }),
        at: atArb,
      }),
      fc.record({
        type: fc.constant('sync-summary'),
        runId: idArb,
        summary: syncSummaryArb,
        at: atArb,
      }),
      fc.record({ type: fc.constant('run-paused'), runId: idArb, at: atArb }),
      fc.record({ type: fc.constant('run-resumed'), runId: idArb, at: atArb }),
      fc.record({ type: fc.constant('run-completed'), runId: idArb, output: textArb, at: atArb }),
      fc.record({ type: fc.constant('run-failed'), runId: idArb, error: textArb, at: atArb }),
      fc.record({ type: fc.constant('run-stopped'), runId: idArb, at: atArb }),
    ] as fc.Arbitrary<RunEvent>[]),
  )
  .chain((event) =>
    fc.option(runScopePathArb, { nil: undefined, freq: 4 }).map((scope) =>
      scope === undefined ? event : ({ ...event, scope } as RunEvent),
    ),
  );

/** A bounded, chronologically increasing stream of events for one run. */
export function runEventStreamArb(options: { maxEvents?: number } = {}): fc.Arbitrary<RunEvent[]> {
  return fc.array(runEventArb, { maxLength: options.maxEvents ?? 10 });
}
