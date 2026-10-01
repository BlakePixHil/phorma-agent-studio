/**
 * Engine-native expression language (design §4).
 *
 * Zero dependencies, zero ambient state: the only values an expression can reach
 * are the ones handed to it in an `EvalContext` plus the fixed function table in
 * `EXPR_FUNCTIONS`. There is no `globalThis`, no `fetch`, no timer and no
 * `Date.now()` — `now()` returns `EvalContext.nowMs`. That is what makes the same
 * source produce the same value on the desktop, in the browser preview and in the
 * Cloudflare worker (Requirement 4.1).
 *
 * This file is built out in four passes, in this order:
 *   1. lexer, parser, `compileExpression`, limits
 *   2. the evaluator core (`evaluateExpression`)
 *   3. the `EXPR_FUNCTIONS` implementations
 *   4. `validateExpression` / `printExpression`  ← this pass
 */

import { canonicalJson, contentHash } from './state.js';
import { htmlToReadableText } from './web-fetch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Domain and limits
// ─────────────────────────────────────────────────────────────────────────────

/** JSON value domain. The evaluator is closed over exactly this set. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Longest accepted expression source, in characters (design §4.4). */
export const MAX_EXPRESSION_CHARS = 4096;

/**
 * Maximum evaluation recursion depth, also applied to structural nesting while
 * parsing so a pathological source can never exhaust the JS stack.
 */
export const MAX_EXPRESSION_DEPTH = 64;

/** Maximum number of AST nodes one `evaluate` call may visit. */
export const MAX_EXPRESSION_STEPS = 100_000;

/**
 * The complete, fixed function table (design §4.3). The value is the arity;
 * `-1` marks a variadic function, which requires at least one argument.
 *
 * `map`, `filter`, `sort`, `sum`, `avg`, `distinct` and `countIf` take a
 * sub-expression **string** as their second argument, evaluated with `item` and
 * `index` bound — that keeps the grammar first-order (no closures).
 */
export const EXPR_FUNCTIONS = {
  // strings
  upper: 1, lower: 1, trim: 1, concat: -1, substr: 3, replace: 3, split: 2,
  join: 2, startsWith: 2, endsWith: 2, contains: 2, padStart: 3, length: 1,
  // numbers
  abs: 1, round: 2, floor: 1, ceil: 1, min: -1, max: -1, toNumber: 1, toInt: 1,
  // logic / null handling
  coalesce: -1, ifNull: 2, isNull: 1, isEmpty: 1, toBool: 1, toString: 1,
  // arrays
  len: 1, sum: 2, avg: 2, count: 1, countIf: 2, distinct: 2, first: 1, last: 1,
  map: 2, filter: 2, sort: 2, slice: 3, flatten: 1, keys: 1, values: 1,
  // dates — ISO 8601 only, UTC only, no locale, no parsing ambiguity
  now: 0, parseDate: 1, formatDate: 2, addDays: 2, dateDiffDays: 2,
  // integration helpers
  lookup: 2,
  hash: 1,
  jsonPath: 2,
  parseJson: 1,
  // text and collection helpers
  containsAny: 2,
  distinctBy: 2,
  extractNumbers: 1,
  htmlToText: 1,
} as const;

/** Name of a function in `EXPR_FUNCTIONS`. */
export type ExprFunctionName = keyof typeof EXPR_FUNCTIONS;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalContext {
  /** The incoming payload parsed as JSON, or `undefined` when it was not JSON. */
  readonly $: Json | undefined;
  /** Raw payload text, addressable as `$text`. */
  readonly $text: string;
  /** Current element inside a per-item evaluation (transform/array, countIf). */
  readonly item?: Json;
  /** Zero-based index of `item`, when iterating. */
  readonly index?: number;
  /** Named lookup tables from `TransformNodeData.lookups`. */
  readonly lookups?: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  /** Workflow-variable scope addressed as `vars`. Absent reads as `{}`. */
  readonly vars?: Readonly<Record<string, Json>>;
  /** Deterministic run clock. `now()` returns THIS value, never `Date.now()`. */
  readonly nowMs: number;
}

export interface CompiledExpression {
  /** The unmodified source string handed to `compileExpression`. */
  readonly source: string;
  /** Distinct paths read from `$`, in first-occurrence source order. */
  readonly references: readonly string[];
  /**
   * Parsed syntax tree. Exposed so `printExpression` and the capability
   * validator can inspect a compiled expression; treat it as read-only.
   */
  readonly ast: ExprNode;
  evaluate(context: EvalContext): Json;
}

/** Every rejection — lexical, syntactic or budgetary — surfaces as this error. */
export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly source: string,
    /** Zero-based character offset in `source`, when one applies. */
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AST
// ─────────────────────────────────────────────────────────────────────────────

export type ExprUnaryOperator = '!' | '-';

export type ExprBinaryOperator =
  | '||' | '&&'
  | '==' | '!='
  | '<' | '<=' | '>' | '>=' | 'in'
  | '+' | '-' | '*' | '/' | '%';

export type ExprPathSegment =
  | { readonly kind: 'field'; readonly name: string }
  | { readonly kind: 'index'; readonly expression: ExprNode };

export interface ExprObjectEntry {
  readonly key: string;
  readonly value: ExprNode;
}

export type ExprNode =
  /** `42`, `'text'`, `true`, `null` — already a `Json` value. */
  | { readonly type: 'literal'; readonly value: Json }
  /** `$` — the parsed payload. */
  | { readonly type: 'root' }
  /** `vars` — the run frame's workflow-variable scope. Never the payload. */
  | { readonly type: 'vars' }
  /** `$text` — the raw payload text. */
  | { readonly type: 'text' }
  /** `item` — current element of an enclosing per-item evaluation. */
  | { readonly type: 'item' }
  /** `index` — zero-based position of `item`. */
  | { readonly type: 'index' }
  /** `$.a.b[0]` — a base plus one or more member accesses. */
  | { readonly type: 'path'; readonly base: ExprNode; readonly segments: readonly ExprPathSegment[] }
  | { readonly type: 'unary'; readonly op: ExprUnaryOperator; readonly operand: ExprNode }
  | {
      readonly type: 'binary';
      readonly op: ExprBinaryOperator;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | {
      readonly type: 'ternary';
      readonly test: ExprNode;
      readonly then: ExprNode;
      readonly otherwise: ExprNode;
    }
  /** An allow-listed function call. `name` is always in `EXPR_FUNCTIONS`. */
  | { readonly type: 'call'; readonly name: ExprFunctionName; readonly args: readonly ExprNode[] }
  | { readonly type: 'array'; readonly items: readonly ExprNode[] }
  | { readonly type: 'object'; readonly entries: readonly ExprObjectEntry[] };

// ─────────────────────────────────────────────────────────────────────────────
// Lexer
// ─────────────────────────────────────────────────────────────────────────────

type TokenKind = 'number' | 'string' | 'ident' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  /** Raw source text: the punctuator, the identifier, or the number literal. */
  readonly text: string;
  /** Decoded value, for `number` and `string` tokens. */
  readonly value?: number | string;
  /** Zero-based offset of the token's first character. */
  readonly position: number;
}

/** Multi-character punctuators first, so `==` never lexes as `=` `=`. */
const PUNCTUATORS: readonly string[] = [
  '==', '!=', '<=', '>=', '&&', '||',
  '?', ':', '.', ',', '(', ')', '[', ']', '{', '}',
  '+', '-', '*', '/', '%', '<', '>', '!',
];

/**
 * Words the grammar owns that stand for a value, and the node each produces.
 * None of them can be a bare `$.field` shorthand, and none of them can name a
 * function — `EXPR_FUNCTIONS` is consulted only after this table misses.
 *
 * A `Map`, not an object literal, so `constructor` and friends stay unknown names
 * instead of resolving through `Object.prototype`.
 */
const RESERVED_PRIMARY_NODES: ReadonlyMap<string, () => ExprNode> = new Map([
  ['true', (): ExprNode => ({ type: 'literal', value: true })],
  ['false', (): ExprNode => ({ type: 'literal', value: false })],
  ['null', (): ExprNode => ({ type: 'literal', value: null })],
  ['item', (): ExprNode => ({ type: 'item' })],
  ['index', (): ExprNode => ({ type: 'index' })],
  ['$', (): ExprNode => ({ type: 'root' })],
  ['$text', (): ExprNode => ({ type: 'text' })],
  ['vars', (): ExprNode => ({ type: 'vars' })],
]);

/**
 * Words the grammar owns that are operators. `parseUnary`, `parseAnd`, `parseOr`
 * and `parseComparison` consume them in operator position, so seeing one where a
 * value must start is always an error — never a function name.
 */
const RESERVED_OPERATOR_WORDS: readonly string[] = ['in', 'and', 'or', 'not'];

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

const isIdentStart = (ch: string | undefined): boolean =>
  ch !== undefined && (/[A-Za-z_]/.test(ch) || ch === '$');

const isIdentPart = (ch: string | undefined): boolean =>
  ch !== undefined && (/[A-Za-z0-9_]/.test(ch) || ch === '$');

/**
 * Splits `source` into tokens. Terminates by construction: every branch consumes
 * at least one character, so the cursor strictly increases (design §4.4).
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (isIdentPart(source[i])) i += 1;
      tokens.push({ kind: 'ident', text: source.slice(start, i), position: start });
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      while (isDigit(source[i])) i += 1;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (isDigit(source[i])) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let after = i + 1;
        if (source[after] === '+' || source[after] === '-') after += 1;
        if (isDigit(source[after])) {
          i = after;
          while (isDigit(source[i])) i += 1;
        }
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`Number literal '${text}' is out of range`, source, start);
      }
      tokens.push({ kind: 'number', text, value, position: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const token = readString(source, i, ch);
      tokens.push(token);
      i += token.text.length;
      continue;
    }

    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
    if (punct) {
      tokens.push({ kind: 'punct', text: punct, position: i });
      i += punct.length;
      continue;
    }

    const hint = ch === '=' ? " (use '==' to compare)" : '';
    throw new ExpressionError(`Unexpected character '${ch}'${hint}`, source, i);
  }

  tokens.push({ kind: 'eof', text: '', position: source.length });
  return tokens;
}

/** Reads a quoted string literal. `text` keeps the raw slice, quotes included. */
function readString(source: string, start: number, quote: string): Token {
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) break;
      switch (next) {
        case '\\': value += '\\'; i += 2; continue;
        case '/': value += '/'; i += 2; continue;
        case "'": value += "'"; i += 2; continue;
        case '"': value += '"'; i += 2; continue;
        case 'n': value += '\n'; i += 2; continue;
        case 'r': value += '\r'; i += 2; continue;
        case 't': value += '\t'; i += 2; continue;
        case 'b': value += '\b'; i += 2; continue;
        case 'f': value += '\f'; i += 2; continue;
        case 'u': {
          const hex = source.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new ExpressionError(`Invalid unicode escape '\\u${hex}'`, source, i);
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        default:
          throw new ExpressionError(`Invalid escape sequence '\\${next}'`, source, i);
      }
    }
    if (ch === quote) {
      return { kind: 'string', text: source.slice(start, i + 1), value, position: start };
    }
    value += ch;
    i += 1;
  }
  throw new ExpressionError('Unterminated string literal', source, start);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursive-descent parser for the design §4.2 grammar.
 *
 * Termination: `cursor` strictly increases on every consumed token and never
 * rewinds, so every loop makes progress. Structural nesting (parentheses,
 * brackets, braces, argument lists, ternary branches, unary chains) is capped at
 * `MAX_EXPRESSION_DEPTH`, bounding the recursion.
 */
class Parser {
  private cursor = 0;
  private depth = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
  ) {}

  parse(): ExprNode {
    const node = this.parseTernary();
    const token = this.peek();
    if (token.kind !== 'eof') {
      throw this.fail(`Unexpected ${describe(token)}`, token.position);
    }
    return node;
  }

  // ── token helpers ──────────────────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.cursor] ?? this.tokens[this.tokens.length - 1]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.cursor += 1;
    return token;
  }

  private atPunct(text: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.text === text;
  }

  private matchPunct(text: string): Token | undefined {
    if (!this.atPunct(text)) return undefined;
    return this.next();
  }

  private atWord(word: string): boolean {
    const token = this.peek();
    return token.kind === 'ident' && token.text === word;
  }

  private matchWord(word: string): Token | undefined {
    if (!this.atWord(word)) return undefined;
    return this.next();
  }

  private expectPunct(text: string): Token {
    const token = this.peek();
    if (token.kind === 'punct' && token.text === text) return this.next();
    throw this.fail(`Expected '${text}' but found ${describe(token)}`, token.position);
  }

  private fail(message: string, position: number): ExpressionError {
    return new ExpressionError(message, this.source, position);
  }

  private enter(position: number): void {
    this.depth += 1;
    if (this.depth > MAX_EXPRESSION_DEPTH) {
      throw this.fail(
        `Expression nesting exceeds the maximum depth of ${MAX_EXPRESSION_DEPTH}`,
        position,
      );
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  // ── grammar ────────────────────────────────────────────────────────────────

  /** `ternary := or ( '?' expression ':' expression )?` */
  private parseTernary(): ExprNode {
    const test = this.parseOr();
    const question = this.matchPunct('?');
    if (!question) return test;
    this.enter(question.position);
    const then = this.parseTernary();
    this.expectPunct(':');
    const otherwise = this.parseTernary();
    this.leave();
    return { type: 'ternary', test, then, otherwise };
  }

  /** `or := and ( ('||' | 'or') and )*` */
  private parseOr(): ExprNode {
    let left = this.parseAnd();
    for (;;) {
      if (!this.matchPunct('||') && !this.matchWord('or')) return left;
      left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    }
  }

  /** `and := equality ( ('&&' | 'and') equality )*` */
  private parseAnd(): ExprNode {
    let left = this.parseEquality();
    for (;;) {
      if (!this.matchPunct('&&') && !this.matchWord('and')) return left;
      left = { type: 'binary', op: '&&', left, right: this.parseEquality() };
    }
  }

  /** `equality := comparison ( ('==' | '!=') comparison )*` */
  private parseEquality(): ExprNode {
    let left = this.parseComparison();
    for (;;) {
      const op = this.atPunct('==') ? '==' : this.atPunct('!=') ? '!=' : undefined;
      if (!op) return left;
      this.next();
      left = { type: 'binary', op, left, right: this.parseComparison() };
    }
  }

  /** `comparison := additive ( ('<' | '<=' | '>' | '>=' | 'in') additive )*` */
  private parseComparison(): ExprNode {
    let left = this.parseAdditive();
    for (;;) {
      let op: ExprBinaryOperator | undefined;
      for (const candidate of ['<=', '>=', '<', '>'] as const) {
        if (this.atPunct(candidate)) {
          op = candidate;
          break;
        }
      }
      if (!op && this.atWord('in')) op = 'in';
      if (!op) return left;
      this.next();
      left = { type: 'binary', op, left, right: this.parseAdditive() };
    }
  }

  /** `additive := multiplicative ( ('+' | '-') multiplicative )*` */
  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.atPunct('+') ? '+' : this.atPunct('-') ? '-' : undefined;
      if (!op) return left;
      this.next();
      left = { type: 'binary', op, left, right: this.parseMultiplicative() };
    }
  }

  /** `multiplicative := unary ( ('*' | '/' | '%') unary )*` */
  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const op = this.atPunct('*') ? '*' : this.atPunct('/') ? '/' : this.atPunct('%') ? '%' : undefined;
      if (!op) return left;
      this.next();
      left = { type: 'binary', op, left, right: this.parseUnary() };
    }
  }

  /** `unary := ('!' | '-' | 'not') unary | postfix` */
  private parseUnary(): ExprNode {
    const token = this.peek();
    const op: ExprUnaryOperator | undefined = this.atPunct('!')
      ? '!'
      : this.atPunct('-')
        ? '-'
        : this.atWord('not')
          ? '!'
          : undefined;
    if (!op) return this.parsePostfix();
    this.next();
    this.enter(token.position);
    const operand = this.parseUnary();
    this.leave();
    return { type: 'unary', op, operand };
  }

  /** `postfix := primary ( '.' IDENT | '[' expression ']' )*` */
  private parsePostfix(): ExprNode {
    const base = this.parsePrimary();
    const segments: ExprPathSegment[] = [];
    for (;;) {
      if (this.matchPunct('.')) {
        segments.push({ kind: 'field', name: this.parseFieldName() });
        continue;
      }
      const open = this.matchPunct('[');
      if (!open) break;
      this.enter(open.position);
      const expression = this.parseTernary();
      this.leave();
      this.expectPunct(']');
      segments.push({ kind: 'index', expression });
    }
    if (segments.length === 0) return base;
    // Bare-identifier shorthand already produced a path; keep one flat node so
    // `amount.currency` reads as `$.amount.currency`, not a path of a path.
    if (base.type === 'path') {
      return { type: 'path', base: base.base, segments: [...base.segments, ...segments] };
    }
    return { type: 'path', base, segments };
  }

  /**
   * A member name after `.`. Identifiers (including reserved words, so `$.in`
   * works) and integer literals (`$.rows.0`, matching `resolveJsonPath`).
   */
  private parseFieldName(): string {
    const token = this.peek();
    if (token.kind === 'ident') {
      this.next();
      return token.text;
    }
    if (token.kind === 'number' && /^[0-9]+$/.test(token.text)) {
      this.next();
      return token.text;
    }
    throw this.fail(`Expected a field name after '.' but found ${describe(token)}`, token.position);
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();

    switch (token.kind) {
      case 'eof':
        throw this.fail('Unexpected end of expression', token.position);
      case 'number':
        this.next();
        return { type: 'literal', value: token.value as number };
      case 'string':
        this.next();
        return { type: 'literal', value: token.value as string };
      case 'ident':
        return this.parseIdentPrimary();
      case 'punct':
        break;
    }

    if (this.matchPunct('(')) {
      this.enter(token.position);
      const inner = this.parseTernary();
      this.leave();
      this.expectPunct(')');
      return inner;
    }
    if (this.matchPunct('[')) {
      this.enter(token.position);
      const items = this.parseList(']');
      this.leave();
      return { type: 'array', items };
    }
    if (this.matchPunct('{')) {
      this.enter(token.position);
      const entries = this.parseObjectEntries();
      this.leave();
      return { type: 'object', entries };
    }
    throw this.fail(`Unexpected ${describe(token)}`, token.position);
  }

  private parseIdentPrimary(): ExprNode {
    const token = this.next();
    const name = token.text;

    // Reserved words are resolved before the call form, so a word the grammar owns
    // can never be read as a function name: `true(1)` is a syntax error at the
    // '(', not `Unknown function 'true'`.
    const reserved = RESERVED_PRIMARY_NODES.get(name);
    if (reserved) {
      if (this.atPunct('(')) {
        throw this.fail(`'${name}' cannot be called as a function`, this.peek().position);
      }
      return reserved();
    }
    if (RESERVED_OPERATOR_WORDS.includes(name)) {
      throw this.fail(`Unexpected operator '${name}'`, token.position);
    }

    if (this.atPunct('(')) return this.parseCall(token);

    if (name.includes('$')) {
      throw this.fail(`Unknown identifier '${name}'`, token.position);
    }
    // `IDENT` is shorthand for `$.IDENT` (design §4.2).
    return { type: 'path', base: { type: 'root' }, segments: [{ kind: 'field', name }] };
  }

  private parseCall(nameToken: Token): ExprNode {
    const name = nameToken.text;
    if (!Object.prototype.hasOwnProperty.call(EXPR_FUNCTIONS, name)) {
      throw this.fail(`Unknown function '${name}'`, nameToken.position);
    }
    const open = this.expectPunct('(');
    this.enter(open.position);
    const args = this.parseList(')');
    this.leave();

    const arity = EXPR_FUNCTIONS[name as ExprFunctionName];
    if (arity === -1) {
      if (args.length === 0) {
        throw this.fail(`${name}() expects at least 1 argument, received 0`, nameToken.position);
      }
    } else if (args.length !== arity) {
      throw this.fail(
        `${name}() expects ${arity} ${arity === 1 ? 'argument' : 'arguments'}, received ${args.length}`,
        nameToken.position,
      );
    }
    return { type: 'call', name: name as ExprFunctionName, args };
  }

  /** `args? closer` — a comma-separated expression list, no trailing comma. */
  private parseList(closer: string): ExprNode[] {
    const items: ExprNode[] = [];
    if (this.matchPunct(closer)) return items;
    for (;;) {
      items.push(this.parseTernary());
      if (this.matchPunct(',')) continue;
      this.expectPunct(closer);
      return items;
    }
  }

  /** `'{' (STRING ':' expression),* '}'` — string keys only, by design. */
  private parseObjectEntries(): ExprObjectEntry[] {
    const entries: ExprObjectEntry[] = [];
    if (this.matchPunct('}')) return entries;
    for (;;) {
      const key = this.peek();
      if (key.kind !== 'string') {
        throw this.fail(
          `Expected a quoted object key but found ${describe(key)}`,
          key.position,
        );
      }
      this.next();
      this.expectPunct(':');
      entries.push({ key: key.value as string, value: this.parseTernary() });
      if (this.matchPunct(',')) continue;
      this.expectPunct('}');
      return entries;
    }
  }
}

/** Human-readable token description, for error messages. */
function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'end of expression';
    case 'string':
      return `string ${token.text}`;
    case 'number':
      return `number ${token.text}`;
    default:
      return `'${token.text}'`;
  }
}

/** Lexes and parses `source`. Throws `ExpressionError` on any rejection. */
export function parseExpression(source: string): ExprNode {
  return new Parser(source, tokenize(source)).parse();
}

// ─────────────────────────────────────────────────────────────────────────────
// References
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every distinct path read from `$`, deduplicated, in first-occurrence source
 * order. A pre-order walk visits nodes in source order, so the first time a path
 * appears is the first time it appears in the text.
 *
 * A path is recorded up to its first dynamic segment: `$.rows[0].id` yields
 * `rows.0.id`, while `$.rows[$.i].id` yields `rows` — the part that is known
 * statically, in `resolveJsonPath` dotted form.
 */
export function collectReferences(node: ExprNode): string[] {
  const seen = new Set<string>();
  const references: string[] = [];

  const record = (path: string): void => {
    if (path.length === 0 || seen.has(path)) return;
    seen.add(path);
    references.push(path);
  };

  const walk = (current: ExprNode): void => {
    switch (current.type) {
      case 'literal':
      case 'root':
      case 'vars':
      case 'text':
      case 'item':
      case 'index':
        return;
      case 'path': {
        if (current.base.type === 'root') record(staticPath(current.segments));
        walk(current.base);
        for (const segment of current.segments) {
          if (segment.kind === 'index') walk(segment.expression);
        }
        return;
      }
      case 'unary':
        walk(current.operand);
        return;
      case 'binary':
        walk(current.left);
        walk(current.right);
        return;
      case 'ternary':
        walk(current.test);
        walk(current.then);
        walk(current.otherwise);
        return;
      case 'call':
        for (const arg of current.args) walk(arg);
        return;
      case 'array':
        for (const item of current.items) walk(item);
        return;
      case 'object':
        for (const entry of current.entries) walk(entry.value);
        return;
    }
  };

  walk(node);
  return references;
}

/** The statically known prefix of a segment list, in dotted form. */
function staticPath(segments: readonly ExprPathSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'field') {
      parts.push(segment.name);
      continue;
    }
    const { expression } = segment;
    if (expression.type !== 'literal') break;
    const { value } = expression;
    if (typeof value !== 'number' && typeof value !== 'string') break;
    parts.push(String(value));
  }
  return parts.join('.');
}

// ─────────────────────────────────────────────────────────────────────────────
// compileExpression
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses and validates `source`, returning a reusable `CompiledExpression`.
 *
 * Rejects — with an `ExpressionError` carrying a zero-based position — an empty
 * source, a source longer than `MAX_EXPRESSION_CHARS`, any syntax error, an
 * unknown identifier, an unknown function and a wrong argument count.
 */
export function compileExpression(source: string): CompiledExpression {
  if (typeof source !== 'string') {
    throw new ExpressionError('Expression source must be a string', String(source), 0);
  }
  if (source.length === 0) {
    throw new ExpressionError('Expression source is empty', source, 0);
  }
  if (source.length > MAX_EXPRESSION_CHARS) {
    throw new ExpressionError(
      `Expression source is ${source.length} characters, above the maximum of ${MAX_EXPRESSION_CHARS}`,
      source,
      MAX_EXPRESSION_CHARS,
    );
  }

  const ast = parseExpression(source);
  const references = Object.freeze(collectReferences(ast));

  return {
    source,
    references,
    ast,
    evaluate(context: EvalContext): Json {
      return evaluateExpression(ast, context, source);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable per-`evaluate` state: the step budget plus the source for errors. */
interface EvalState {
  /** AST nodes visited so far in this `evaluate` call. */
  steps: number;
  /** The compiled source, echoed on every `ExpressionError` raised here. */
  readonly source: string;
}

/**
 * Truthiness, defined once for the whole data path.
 *
 * `null` is false, a boolean is itself, a number is true when non-zero, a string
 * when non-empty, an array when it holds an element and an object when it holds a
 * key. `assert`, `filter` and `countIf` all read this, so an empty result set is
 * falsy everywhere rather than "truthy because it is an object" as in JS.
 */
export function truthy(value: Json): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

/**
 * JSON structural equality (Requirement 4.9).
 *
 * Objects are equal when they carry the same key set with equal values in any key
 * order; arrays only when they carry equal values in the same order. Iterative by
 * design: a deeply nested payload must not be able to overflow the JS stack,
 * because the only error this module may raise is `ExpressionError`.
 */
export function jsonEquals(left: Json, right: Json): boolean {
  const pending: Array<readonly [Json, Json]> = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (a === null || b === null) return false;

    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) pending.push([a[i]!, b[i]!]);
      continue;
    }
    if (Array.isArray(b)) return false;

    if (typeof a === 'object') {
      if (typeof b !== 'object') return false;
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        pending.push([a[key]!, b[key]!]);
      }
      continue;
    }
    // Remaining cases are scalars, already compared by `a === b` above.
    return false;
  }
  return true;
}

/**
 * Resolves one path segment, agreeing with `resolveJsonPath` in `payload.ts`:
 * arrays accept integer segments only, objects index by key, everything else is
 * absent (Requirement 4.18). `undefined` means "absent"; the caller maps it to
 * `null`.
 *
 * Own properties only, so `$.constructor` and `$.__proto__` read as absent rather
 * than handing back something outside the `Json` domain.
 */
function resolveSegment(current: Json, segment: string): Json | undefined {
  if (current === null) return undefined;
  if (Array.isArray(current)) {
    const index = Number(segment);
    if (!Number.isInteger(index)) return undefined;
    return current[index];
  }
  if (typeof current === 'object') {
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    return current[segment];
  }
  return undefined;
}

/**
 * A computed `[...]` subscript rendered as a path segment. Strings and finite
 * numbers address a member; every other JSON type addresses nothing, so the whole
 * path reads as absent.
 */
function segmentFromValue(value: Json): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  return undefined;
}

/** A scalar rendered as an object key, for the `in` operator (Requirement 4.21). */
function keyFromValue(value: Json): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return undefined;
}

/** A finite number, or `undefined` when the operand is not arithmetic. */
function asNumber(value: Json): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Arithmetic results are `null` unless they are finite numbers (Requirement 4.6). */
function finiteOrNull(value: number): Json {
  return Number.isFinite(value) ? value : null;
}

/**
 * `<`, `<=`, `>`, `>=`: numeric for two finite numbers, lexicographic for two
 * strings, and `false` for every other pairing — including two operands of
 * different JSON types, in both operand orders (Requirement 4.7). No coercion can
 * happen because each branch has already narrowed both sides to one primitive.
 */
function compareOrdering(op: '<' | '<=' | '>' | '>=', left: Json, right: Json): boolean {
  let sign: number;
  if (typeof left === 'number' && typeof right === 'number') {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    sign = left < right ? -1 : left > right ? 1 : 0;
  } else if (typeof left === 'string' && typeof right === 'string') {
    // UTF-16 code-unit order: no locale, so every host agrees.
    sign = left < right ? -1 : left > right ? 1 : 0;
  } else {
    return false;
  }
  switch (op) {
    case '<': return sign < 0;
    case '<=': return sign <= 0;
    case '>': return sign > 0;
    default: return sign >= 0;
  }
}

/** `left in right` per Requirement 4.21. */
function evaluateIn(left: Json, right: Json): boolean {
  if (Array.isArray(right)) return right.some((element) => jsonEquals(left, element));
  if (right !== null && typeof right === 'object') {
    const key = keyFromValue(left);
    return key !== undefined && Object.prototype.hasOwnProperty.call(right, key);
  }
  if (typeof right === 'string' && typeof left === 'string') return right.includes(left);
  return false;
}

/** Non short-circuiting binary operators, applied to already-evaluated operands. */
function applyBinary(op: ExprBinaryOperator, left: Json, right: Json): Json {
  switch (op) {
    case '==': return jsonEquals(left, right);
    case '!=': return !jsonEquals(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareOrdering(op, left, right);
    case 'in':
      return evaluateIn(left, right);
    case '+': {
      // Concatenation only when BOTH operands are strings; a string/number mix is
      // `null`, not JS's silent coercion (Requirement 4.8).
      if (typeof left === 'string' || typeof right === 'string') {
        return typeof left === 'string' && typeof right === 'string' ? left + right : null;
      }
      const a = asNumber(left);
      const b = asNumber(right);
      return a === undefined || b === undefined ? null : finiteOrNull(a + b);
    }
    case '-':
    case '*':
    case '/':
    case '%': {
      const a = asNumber(left);
      const b = asNumber(right);
      if (a === undefined || b === undefined) return null;
      if (op === '-') return finiteOrNull(a - b);
      if (op === '*') return finiteOrNull(a * b);
      if (b === 0) return null;
      return op === '/' ? finiteOrNull(a / b) : finiteOrNull(a % b);
    }
    case '&&':
      // `evaluateNode` short-circuits before reaching this table; kept total so
      // the operator set stays exhaustively covered.
      return truthy(left) && truthy(right);
    case '||':
      return truthy(left) || truthy(right);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function-table helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Milliseconds in one UTC day. Leap seconds do not exist in epoch time. */
const MS_PER_DAY = 86_400_000;

/**
 * Widest target length `padStart` will build, so a hostile `padStart($.s, 1e9,
 * '.')` cannot allocate a gigabyte string.
 */
const MAX_PAD_LENGTH = MAX_EXPRESSION_CHARS;

/** Highest `round` precision. Beyond 15 digits a double carries no information. */
const MAX_ROUND_DIGITS = 15;

/** Strings `toBool` reads as false. Everything else non-empty is true. */
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', '0', 'no', 'off', 'n']);

/**
 * ISO-8601 date, optionally with a time and a zone. `T` or a single space
 * separates the two halves; an absent zone means UTC, never the host's zone.
 */
const ISO_DATE_PATTERN =
  /^(\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

const asString = (value: Json | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asArray = (value: Json | undefined): Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

const asRecord = (value: Json | undefined): { [key: string]: Json } | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { [key: string]: Json })
    : undefined;

/** A finite number truncated toward zero, for length/offset arguments. */
function asInteger(value: Json | undefined): number | undefined {
  const numeric = asNumber(value ?? null);
  return numeric === undefined ? undefined : Math.trunc(numeric);
}

/** Normalises `-0` to `0`, so identical values never render differently. */
const withoutNegativeZero = (value: number): number => (value === 0 ? 0 : value);

/**
 * A scalar rendered for `join`: strings pass through, numbers and booleans use
 * their canonical form, `null` contributes nothing, and a nested array or object
 * uses its canonical JSON so key order can never change the output.
 */
function renderForJoin(value: Json): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return '';
  return canonicalText(value);
}

/**
 * Canonical JSON text that cannot throw. `canonicalJson` rejects a circular
 * structure, and a host is free to hand us one inside `EvalContext.$`; every
 * function in this module has to stay total regardless (Requirement 4.4).
 */
function canonicalText(value: Json): string {
  try {
    return canonicalJson(value);
  } catch {
    return 'null';
  }
}

/**
 * Total order over the JSON domain, used by `sort` and `distinct`.
 *
 * Types are ranked (`null` < boolean < number < string < array < object) so a
 * mixed-type key list still sorts to one stable, host-independent order rather
 * than whatever `Array.prototype.sort` would do with coerced strings.
 */
function compareJsonValues(left: Json, right: Json): number {
  const rankLeft = jsonTypeRank(left);
  const rankRight = jsonTypeRank(right);
  if (rankLeft !== rankRight) return rankLeft < rankRight ? -1 : 1;
  switch (rankLeft) {
    case 0:
      return 0;
    case 1:
      return left === right ? 0 : left === false ? -1 : 1;
    case 2: {
      const a = left as number;
      const b = right as number;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    case 3: {
      const a = left as string;
      const b = right as string;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    default: {
      const a = canonicalText(left);
      const b = canonicalText(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }
  }
}

function jsonTypeRank(value: Json): number {
  if (value === null) return 0;
  switch (typeof value) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    case 'string':
      return 3;
    default:
      return Array.isArray(value) ? 4 : 5;
  }
}

/**
 * Compiled sub-expression sources, bounded and cleared wholesale when full.
 *
 * A `filter($.rows, 'item.open')` over 10 000 rows must parse its predicate once,
 * not 10 000 times. `null` is cached for a source that does not compile, so a bad
 * predicate is not re-parsed per item either.
 */
const SUB_EXPRESSION_CACHE_LIMIT = 256;
const subExpressionCache = new Map<string, ExprNode | null>();

/**
 * Compiles a sub-expression argument. `undefined` means "not usable" — the value
 * was not a string, or it did not compile — and every caller turns that into
 * `null` for the whole call (Requirement 4.20).
 */
function compileSubExpression(source: Json): ExprNode | undefined {
  if (typeof source !== 'string') return undefined;

  const cached = subExpressionCache.get(source);
  if (cached !== undefined) return cached ?? undefined;

  let parsed: ExprNode | null;
  try {
    parsed = compileExpression(source).ast;
  } catch {
    parsed = null;
  }
  if (subExpressionCache.size >= SUB_EXPRESSION_CACHE_LIMIT) subExpressionCache.clear();
  subExpressionCache.set(source, parsed);
  return parsed ?? undefined;
}

/**
 * `map`, `filter`, `sort`, `sum`, `avg`, `distinct` and `countIf` (Requirement
 * 4.14).
 *
 * The sub-expression sees a derived context carrying `item` and `index`; the
 * supplied context is never written to, so the enclosing `item`/`index` bindings
 * are still in place when this returns. The step budget is shared with the outer
 * evaluation, so a long array plus a large predicate is bounded by
 * `MAX_EXPRESSION_STEPS` exactly like everything else.
 */
function callIterating(
  name: 'map' | 'filter' | 'sort' | 'sum' | 'avg' | 'distinct' | 'distinctBy' | 'countIf',
  source: Json,
  subExpression: Json,
  context: EvalContext,
  depth: number,
  state: EvalState,
): Json {
  const items = asArray(source);
  if (items === undefined) return null;
  const ast = compileSubExpression(subExpression);
  if (ast === undefined) return null;

  const evaluated = items.map((item, index) =>
    evaluateNode(ast, { ...context, item, index }, depth, state),
  );

  switch (name) {
    case 'map':
      return evaluated;

    case 'filter':
      return items.filter((_, index) => truthy(evaluated[index]!));

    case 'countIf': {
      let matches = 0;
      for (const value of evaluated) if (truthy(value)) matches += 1;
      return matches;
    }

    case 'sum': {
      let total = 0;
      for (const value of evaluated) {
        const numeric = asNumber(value);
        if (numeric !== undefined) total += numeric;
      }
      return finiteOrNull(withoutNegativeZero(total));
    }

    case 'avg': {
      let total = 0;
      let seen = 0;
      for (const value of evaluated) {
        const numeric = asNumber(value);
        if (numeric === undefined) continue;
        total += numeric;
        seen += 1;
      }
      // An empty (or wholly non-numeric) list has no average — `null`, matching
      // the `aggregate` metric rule, not `0`, which would read as a real figure.
      return seen === 0 ? null : finiteOrNull(withoutNegativeZero(total / seen));
    }

    case 'distinct': {
      const seen = new Set<string>();
      const distinct: Json[] = [];
      for (const value of evaluated) {
        const fingerprint = canonicalText(value);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        distinct.push(value);
      }
      return distinct;
    }

    case 'distinctBy': {
      // The first ELEMENT per distinct evaluated key, in input order: unlike
      // `distinct`, which returns the keys themselves.
      const seen = new Set<string>();
      const kept: Json[] = [];
      items.forEach((item, index) => {
        const fingerprint = canonicalText(evaluated[index]!);
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);
        kept.push(item);
      });
      return kept;
    }

    case 'sort': {
      // Sort the positions, not the elements: comparing indices as the tie-break
      // keeps equal keys in input order on every engine.
      const order = items.map((_, index) => index);
      order.sort((a, b) => compareJsonValues(evaluated[a]!, evaluated[b]!) || a - b);
      return order.map((index) => items[index]!);
    }
  }
}

/**
 * Epoch milliseconds for a date value: a finite number passes through, an
 * ISO-8601 string is parsed as UTC, everything else is `undefined`.
 *
 * Hand-rolled rather than `new Date(string)`, whose non-ISO fallback is
 * implementation-defined — the whole point of §4 is that the desktop, the browser
 * and the worker agree. A rolled-over calendar date (`2024-02-30`) is rejected
 * instead of silently becoming March 1st.
 */
function parseDateValue(value: Json | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(`${match[7]}00`.slice(0, 3));
  const zone = match[8];

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  const date = new Date(0);
  // setUTCFullYear (not Date.UTC) so a two- or three-digit year is not mapped
  // into the 1900s.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) return undefined;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  if (zone === undefined || zone === 'Z' || zone === 'z') return epochMs;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  if (!Number.isFinite(offsetMinutes)) return undefined;
  return epochMs - sign * offsetMinutes * 60_000;
}

const pad = (value: number, width: number): string =>
  String(Math.abs(value)).padStart(width, '0');

/**
 * Renders epoch milliseconds in one of the fixed UTC formats. No locale, no host
 * time zone, no pattern language — an unknown format name is `null`.
 */
function formatDateValue(epochMs: number, format: string): Json {
  if (format === 'epochMs') return epochMs;
  if (format === 'epoch') return Math.floor(epochMs / 1000);

  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const yyyy = year < 0 ? `-${pad(year, 6)}` : pad(year, 4);
  const day = `${yyyy}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  const time = `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;

  switch (format) {
    case 'iso':
      return `${day}T${time}.${pad(date.getUTCMilliseconds(), 3)}Z`;
    case 'date':
      return day;
    case 'time':
      return time;
    case 'datetime':
      return `${day} ${time}`;
    default:
      return null;
  }
}

/**
 * Applies an allow-listed function to already-evaluated arguments.
 *
 * Every branch is **total**: an argument of a type the function does not accept
 * yields `null` and never an exception, so a malformed record degrades to a `null`
 * field that `required`/`assert` then catch, instead of failing the run from
 * inside an expression (Requirement 4.20). Nothing here coerces across types —
 * `toNumber`, `toBool` and `toString` are the only conversions, and they are
 * explicit by name.
 *
 * `now()` returns `EvalContext.nowMs`, so every call in one `evaluate` invocation
 * agrees and no ambient clock is ever read (Requirement 4.11).
 */
function callFunction(
  name: ExprFunctionName,
  args: readonly Json[],
  context: EvalContext,
  depth: number,
  state: EvalState,
): Json {
  const first: Json = args[0] ?? null;
  const second: Json = args[1] ?? null;

  switch (name) {
    // ── strings ──────────────────────────────────────────────────────────────

    case 'upper': {
      const text = asString(first);
      // toUpperCase, never toLocaleUpperCase: the Turkish dotless i must not
      // depend on where the run happens.
      return text === undefined ? null : text.toUpperCase();
    }
    case 'lower': {
      const text = asString(first);
      return text === undefined ? null : text.toLowerCase();
    }
    case 'trim': {
      const text = asString(first);
      return text === undefined ? null : text.trim();
    }
    case 'concat': {
      let joined = '';
      for (const arg of args) {
        const text = asString(arg);
        if (text === undefined) return null;
        joined += text;
      }
      return joined;
    }
    case 'substr': {
      const text = asString(first);
      const start = asInteger(second);
      const count = asInteger(args[2]);
      if (text === undefined || start === undefined || count === undefined) return null;
      const begin = start < 0 ? Math.max(0, text.length + start) : Math.min(start, text.length);
      return count <= 0 ? '' : text.slice(begin, begin + count);
    }
    case 'replace': {
      const text = asString(first);
      const search = asString(second);
      const replacement = asString(args[2]);
      if (text === undefined || search === undefined || replacement === undefined) return null;
      // Literal, global, no regex: a search string is data, never a pattern.
      return search.length === 0 ? text : text.split(search).join(replacement);
    }
    case 'split': {
      const text = asString(first);
      const separator = asString(second);
      return text === undefined || separator === undefined ? null : text.split(separator);
    }
    case 'join': {
      const items = asArray(first);
      const separator = asString(second);
      if (items === undefined || separator === undefined) return null;
      return items.map(renderForJoin).join(separator);
    }
    case 'startsWith': {
      const text = asString(first);
      const prefix = asString(second);
      return text === undefined || prefix === undefined ? null : text.startsWith(prefix);
    }
    case 'endsWith': {
      const text = asString(first);
      const suffix = asString(second);
      return text === undefined || suffix === undefined ? null : text.endsWith(suffix);
    }
    case 'contains': {
      const text = asString(first);
      const needle = asString(second);
      return text === undefined || needle === undefined ? null : text.includes(needle);
    }
    case 'padStart': {
      const text = asString(first);
      const target = asInteger(second);
      const filler = asString(args[2]);
      if (text === undefined || target === undefined || filler === undefined) return null;
      if (target > MAX_PAD_LENGTH) return null;
      if (filler.length === 0 || target <= text.length) return text;
      return text.padStart(target, filler);
    }
    case 'length': {
      const text = asString(first);
      return text === undefined ? null : text.length;
    }

    // ── numbers ──────────────────────────────────────────────────────────────

    case 'abs': {
      const numeric = asNumber(first);
      return numeric === undefined ? null : Math.abs(numeric);
    }
    case 'round': {
      const numeric = asNumber(first);
      const digits = asInteger(second);
      if (numeric === undefined || digits === undefined) return null;
      const precision = Math.min(Math.max(digits, 0), MAX_ROUND_DIGITS);
      const factor = 10 ** precision;
      // Half away from zero, applied to the magnitude, so -2.5 rounds to -3
      // rather than JS's -2. Money rounding must not depend on sign.
      const scaled = Math.round(Math.abs(numeric) * factor) / factor;
      return finiteOrNull(withoutNegativeZero(numeric < 0 ? -scaled : scaled));
    }
    case 'floor': {
      const numeric = asNumber(first);
      return numeric === undefined ? null : finiteOrNull(withoutNegativeZero(Math.floor(numeric)));
    }
    case 'ceil': {
      const numeric = asNumber(first);
      return numeric === undefined ? null : finiteOrNull(withoutNegativeZero(Math.ceil(numeric)));
    }
    case 'min':
    case 'max': {
      const numbers: number[] = [];
      for (const arg of args) {
        // An array argument contributes its numbers, so `max($.amounts)` works
        // as well as `max($.a, $.b)`.
        if (Array.isArray(arg)) {
          for (const element of arg) {
            const numeric = asNumber(element);
            if (numeric === undefined) return null;
            numbers.push(numeric);
          }
          continue;
        }
        const numeric = asNumber(arg);
        if (numeric === undefined) return null;
        numbers.push(numeric);
      }
      if (numbers.length === 0) return null;
      // A fold, not `Math.min(...numbers)`: spreading a 100 000-element array
      // overflows the argument list on every engine.
      let extreme = numbers[0]!;
      for (const candidate of numbers) {
        if (name === 'min' ? candidate < extreme : candidate > extreme) extreme = candidate;
      }
      return withoutNegativeZero(extreme);
    }
    case 'toNumber':
    case 'toInt': {
      const numeric = toNumberValue(first);
      if (numeric === undefined) return null;
      return name === 'toInt' ? withoutNegativeZero(Math.trunc(numeric)) : numeric;
    }

    // ── logic and null handling ──────────────────────────────────────────────

    case 'coalesce': {
      for (const arg of args) if (arg !== null && arg !== undefined) return arg;
      return null;
    }
    case 'ifNull':
      return first === null ? second : first;
    case 'isNull':
      return first === null;
    case 'isEmpty': {
      if (first === null) return true;
      if (typeof first === 'string') return first.trim().length === 0;
      if (Array.isArray(first)) return first.length === 0;
      if (typeof first === 'object') return Object.keys(first).length === 0;
      // A number or a boolean is a present value, `0` and `false` included.
      return false;
    }
    case 'toBool': {
      if (typeof first === 'string') {
        const text = first.trim().toLowerCase();
        return text.length === 0 ? false : !FALSE_WORDS.has(text);
      }
      return truthy(first);
    }
    case 'toString': {
      if (typeof first === 'string') return first;
      if (typeof first === 'number') return Number.isFinite(first) ? String(first) : null;
      if (typeof first === 'boolean') return first ? 'true' : 'false';
      // `null` stays `null`: rendering it as the text "null" into a target field
      // is how "null" ends up written to a customer record.
      if (first === null) return null;
      return safeCanonicalJson(first);
    }

    // ── arrays ───────────────────────────────────────────────────────────────

    case 'len': {
      if (typeof first === 'string') return first.length;
      if (Array.isArray(first)) return first.length;
      if (first !== null && typeof first === 'object') return Object.keys(first).length;
      return null;
    }
    case 'count': {
      const items = asArray(first);
      return items === undefined ? null : items.length;
    }
    case 'map':
    case 'filter':
    case 'sort':
    case 'sum':
    case 'avg':
    case 'distinct':
    case 'distinctBy':
    case 'countIf':
      return callIterating(name, first, second, context, depth, state);

    case 'first': {
      const items = asArray(first);
      return items === undefined || items.length === 0 ? null : items[0]!;
    }
    case 'last': {
      const items = asArray(first);
      return items === undefined || items.length === 0 ? null : items[items.length - 1]!;
    }
    case 'slice': {
      const items = asArray(first);
      const start = asInteger(second);
      const end = asInteger(args[2]);
      if (items === undefined || start === undefined || end === undefined) return null;
      return items.slice(start, end);
    }
    case 'flatten': {
      const items = asArray(first);
      if (items === undefined) return null;
      // One level only, so the result depth is predictable from the input.
      const flat: Json[] = [];
      for (const element of items) {
        if (Array.isArray(element)) flat.push(...element);
        else flat.push(element);
      }
      return flat;
    }
    case 'keys': {
      const record = asRecord(first);
      return record === undefined ? null : Object.keys(record);
    }
    case 'values': {
      const record = asRecord(first);
      return record === undefined ? null : Object.keys(record).map((key) => record[key] ?? null);
    }

    // ── dates (ISO-8601, UTC only) ───────────────────────────────────────────

    case 'now': {
      const nowMs = context.nowMs;
      return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : null;
    }
    case 'parseDate':
      return parseDateValue(first) ?? null;
    case 'formatDate': {
      const epochMs = parseDateValue(first);
      const format = asString(second);
      return epochMs === undefined || format === undefined ? null : formatDateValue(epochMs, format);
    }
    case 'addDays': {
      const epochMs = parseDateValue(first);
      const days = asNumber(second);
      if (epochMs === undefined || days === undefined) return null;
      return finiteOrNull(epochMs + days * MS_PER_DAY);
    }
    case 'dateDiffDays': {
      const later = parseDateValue(first);
      const earlier = parseDateValue(second);
      if (later === undefined || earlier === undefined) return null;
      return finiteOrNull(withoutNegativeZero((later - earlier) / MS_PER_DAY));
    }

    // ── integration helpers ──────────────────────────────────────────────────

    case 'lookup': {
      const table = asString(first);
      const tables = context.lookups;
      if (table === undefined || !tables || typeof tables !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(tables, table)) return null;
      const entries = tables[table];
      if (!entries || typeof entries !== 'object') return null;
      const key = keyFromValue(second);
      if (key === undefined) return null;
      if (!Object.prototype.hasOwnProperty.call(entries, key)) return null;
      return entries[key] ?? null;
    }
    case 'hash': {
      try {
        // fnv1a over canonical JSON: the same fingerprint the delta filter and
        // the fixture keys use, so a workflow can compare its own hashes to the
        // engine's across hosts.
        return contentHash(first);
      } catch {
        return null;
      }
    }
    case 'jsonPath': {
      const path = asString(second);
      if (path === undefined) return null;
      let current: Json | undefined = first;
      // Same walk as `resolveJsonPath` in payload.ts, absent mapped to `null`.
      for (const segment of path.split('.')) {
        if (current === undefined || current === null) return null;
        current = resolveSegment(current, segment);
      }
      return current ?? null;
    }

    case 'parseJson': {
      const text = asString(first);
      if (text === undefined || text.length > MAX_TEXT_HELPER_CHARS) return null;
      try {
        return toJsonValue(JSON.parse(text));
      } catch {
        return null;
      }
    }

    // ── text and collection helpers ──────────────────────────────────────────

    case 'containsAny': {
      const text = asString(first);
      const needles = asArray(second);
      if (text === undefined || needles === undefined) return null;
      // Non-string and empty entries never match: an empty needle would make
      // every text "contain" the list.
      return needles.some(needle => typeof needle === 'string' && needle.length > 0 && text.includes(needle));
    }
    case 'extractNumbers': {
      const text = asString(first);
      if (text === undefined || text.length > MAX_TEXT_HELPER_CHARS) return null;
      const found: Json[] = [];
      for (const match of text.matchAll(NUMBER_RUN_PATTERN)) {
        if (found.length >= MAX_EXTRACTED_NUMBERS) break;
        found.push(match[0]);
      }
      return found;
    }
    case 'htmlToText': {
      const text = asString(first);
      if (text === undefined) return null;
      return htmlToReadableText(text.length > MAX_TEXT_HELPER_CHARS ? text.slice(0, MAX_TEXT_HELPER_CHARS) : text);
    }
  }
}

/** Input cap for `parseJson`, `extractNumbers` and `htmlToText`, in characters. */
const MAX_TEXT_HELPER_CHARS = 1_048_576;

/** Most figures `extractNumbers` returns. */
const MAX_EXTRACTED_NUMBERS = 10_000;

/** A digit run with optional `.` or `,` separated digit groups: `40`, `3.5`, `1,200`. */
const NUMBER_RUN_PATTERN = /\d+(?:[.,]\d+)*/g;

/**
 * `JSON.parse` output narrowed to the evaluator's closed domain. Parsed JSON is
 * already in the domain, except that a huge integer literal can parse to a
 * non-finite number, which becomes `null` like every other non-finite result.
 */
function toJsonValue(value: unknown): Json {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toJsonValue(item);
    return out;
  }
  return value as Json;
}

/** Explicit conversion for `toNumber`/`toInt`. Strict: no partial parses. */
function toNumberValue(value: Json): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `canonicalJson` that cannot throw, so `toString` stays total. */
function safeCanonicalJson(value: Json): Json {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

/**
 * Evaluates one AST node.
 *
 * Budgets are checked before descending, so evaluation always terminates:
 * `depth` is bounded by `MAX_EXPRESSION_DEPTH` and the visited-node count by
 * `MAX_EXPRESSION_STEPS` (Requirement 4.19). Nothing here writes to `context` or
 * to any value reachable from it (Requirement 4.12).
 */
function evaluateNode(
  node: ExprNode,
  context: EvalContext,
  depth: number,
  state: EvalState,
): Json {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new ExpressionError(
      `Expression evaluation exceeded the maximum depth of ${MAX_EXPRESSION_DEPTH}`,
      state.source,
    );
  }
  if (state.steps >= MAX_EXPRESSION_STEPS) {
    throw new ExpressionError(
      `Expression evaluation exceeded the maximum of ${MAX_EXPRESSION_STEPS} evaluated nodes`,
      state.source,
    );
  }
  state.steps += 1;
  const next = depth + 1;

  switch (node.type) {
    case 'literal':
      return node.value;
    case 'root':
      return context.$ ?? null;
    case 'vars':
      return (context.vars as Json | undefined) ?? {};
    case 'text':
      return typeof context.$text === 'string' ? context.$text : '';
    case 'item':
      return context.item ?? null;
    case 'index':
      return typeof context.index === 'number' ? context.index : null;

    case 'path': {
      let current: Json | undefined = evaluateNode(node.base, context, next, state);
      for (const segment of node.segments) {
        if (current === undefined || current === null) return null;
        const key =
          segment.kind === 'field'
            ? segment.name
            : segmentFromValue(evaluateNode(segment.expression, context, next, state));
        if (key === undefined) return null;
        current = resolveSegment(current, key);
      }
      return current ?? null;
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, context, next, state);
      if (node.op === '!') return !truthy(operand);
      const numeric = asNumber(operand);
      return numeric === undefined ? null : finiteOrNull(-numeric);
    }

    case 'binary': {
      const left = evaluateNode(node.left, context, next, state);
      // Short-circuit BEFORE touching the right operand, so
      // `isNull($.a) || $.a.b > 0` never faults on the missing path.
      if (node.op === '&&' && !truthy(left)) return false;
      if (node.op === '||' && truthy(left)) return true;
      const right = evaluateNode(node.right, context, next, state);
      if (node.op === '&&' || node.op === '||') return truthy(right);
      return applyBinary(node.op, left, right);
    }

    case 'ternary':
      return truthy(evaluateNode(node.test, context, next, state))
        ? evaluateNode(node.then, context, next, state)
        : evaluateNode(node.otherwise, context, next, state);

    case 'call': {
      const args = node.args.map((arg) => evaluateNode(arg, context, next, state));
      return callFunction(node.name, args, context, next, state);
    }

    case 'array':
      return node.items.map((item) => evaluateNode(item, context, next, state));

    case 'object': {
      const result: { [key: string]: Json } = {};
      for (const entry of node.entries) {
        result[entry.key] = evaluateNode(entry.value, context, next, state);
      }
      return result;
    }
  }
}

/**
 * Walks the AST against an `EvalContext`.
 *
 * Total by construction: every node returns a `Json` value, and the only error
 * that can escape is an `ExpressionError` for an exhausted depth or step budget
 * (Requirements 4.4, 4.19). The context is read-only throughout, so it is
 * structurally unchanged whether this returns or throws (Requirement 4.12).
 */
function evaluateExpression(node: ExprNode, context: EvalContext, source: string): Json {
  return evaluateNode(node, context, 1, { steps: 0, source });
}

// ─────────────────────────────────────────────────────────────────────────────
// validateExpression
// ─────────────────────────────────────────────────────────────────────────────

/** Result of `validateExpression`: ok, or a message plus a caret position. */
export type ExpressionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly position?: number };

/**
 * Parse-only validation for the properties panel and push-time checks
 * (Requirement 4.15).
 *
 * Succeeds for exactly the sources `compileExpression` accepts — it *is*
 * `compileExpression`, with the throw turned into a value — and reports the same
 * zero-based position for everything it rejects. It throws for no input at all,
 * including a non-string, so a keystroke-by-keystroke caller never needs a
 * `try`/`catch`.
 */
export function validateExpression(source: string): ExpressionValidation {
  try {
    compileExpression(source);
    return { ok: true };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return error.position === undefined
        ? { ok: false, error: error.message }
        : { ok: false, error: error.message, position: error.position };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// printExpression
// ─────────────────────────────────────────────────────────────────────────────

/** Binding strength per binary operator, mirroring the design §4.2 grammar. */
const BINARY_PRECEDENCE: Readonly<Record<ExprBinaryOperator, number>> = {
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  in: 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

const PRECEDENCE_TERNARY = 1;
const PRECEDENCE_UNARY = 8;
const PRECEDENCE_PATH = 9;
const PRECEDENCE_PRIMARY = 10;

/** A member name that can follow `.` unquoted. */
const BARE_FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A member name the lexer reads back as a number token, as `$.rows.0` does. */
const NUMERIC_FIELD_NAME = /^[0-9]+$/;

interface PrintOptions {
  /** Pad binary operators and list separators. The compact form is the fallback
   *  when the padded form would exceed `MAX_EXPRESSION_CHARS`. */
  readonly spaced: boolean;
}

/**
 * Renders a compiled expression back to source (Requirement 4.16).
 *
 * The output is a pure function of the compiled syntax tree, so the same compiled
 * expression prints character-identically every time, and it parses back to a
 * structurally equivalent tree (Requirement 4.17): parentheses carry no node of
 * their own, so re-adding exactly the ones precedence requires cannot change the
 * shape. Word forms are printed as their normalised symbols (`and` → `&&`),
 * because that is what the tree holds.
 */
export function printExpression(expression: CompiledExpression): string {
  const ast = expression?.ast as ExprNode | undefined;
  if (!ast || typeof ast !== 'object' || typeof ast.type !== 'string') {
    throw new ExpressionError(
      'printExpression requires a compiled expression',
      typeof expression?.source === 'string' ? expression.source : '',
      0,
    );
  }
  const padded = printNode(ast, { spaced: true });
  // A source at the character cap can print longer than it arrived (`and` → `&&`
  // shrinks, but `a` → `$.a` and the operator padding grow). Falling back to the
  // compact form keeps the promise that the printed source still compiles.
  return padded.length <= MAX_EXPRESSION_CHARS ? padded : printNode(ast, { spaced: false });
}

/** Precedence of the text `printNode` produces for `node`. */
function precedenceOf(node: ExprNode): number {
  switch (node.type) {
    case 'ternary':
      return PRECEDENCE_TERNARY;
    case 'binary':
      return BINARY_PRECEDENCE[node.op] ?? PRECEDENCE_TERNARY;
    case 'unary':
      return PRECEDENCE_UNARY;
    case 'path':
      return PRECEDENCE_PATH;
    case 'literal':
      // A negative number prints with a leading '-', which binds like the unary
      // operator it lexes as: `(-1).x`, never `-1.x`.
      return typeof node.value === 'number' && node.value < 0 ? PRECEDENCE_UNARY : PRECEDENCE_PRIMARY;
    default:
      return PRECEDENCE_PRIMARY;
  }
}

/** Prints `node`, parenthesised when its precedence is below `minPrecedence`. */
function printAt(node: ExprNode, minPrecedence: number, options: PrintOptions): string {
  const text = printNode(node, options);
  return precedenceOf(node) < minPrecedence ? `(${text})` : text;
}

function printNode(node: ExprNode, options: PrintOptions): string {
  switch (node.type) {
    case 'literal':
      return printLiteral(node.value, options);
    case 'root':
      return '$';
    case 'vars':
      return 'vars';
    case 'text':
      return '$text';
    case 'item':
      return 'item';
    case 'index':
      return 'index';

    case 'path': {
      let out = printAt(node.base, PRECEDENCE_PATH, options);
      for (const segment of node.segments) out += printSegment(segment, out, options);
      return out;
    }

    case 'unary': {
      // `-` never takes a bare unary operand, so a hand-built `-(-1)` cannot
      // print as `--1` and re-read as one operator over `1`.
      const min = node.op === '-' ? PRECEDENCE_UNARY + 1 : PRECEDENCE_UNARY;
      return `${node.op}${printAt(node.operand, min, options)}`;
    }

    case 'binary': {
      const precedence = BINARY_PRECEDENCE[node.op] ?? PRECEDENCE_TERNARY;
      const left = printAt(node.left, precedence, options);
      // Left-associative: an equal-precedence right operand needs parentheses.
      const right = printAt(node.right, precedence + 1, options);
      // `in` is a word, so it always needs its spaces; the symbols only take them
      // in the padded form.
      const separator = node.op === 'in' || options.spaced ? ` ${node.op} ` : node.op;
      return `${left}${separator}${right}`;
    }

    case 'ternary': {
      const test = printAt(node.test, PRECEDENCE_TERNARY + 1, options);
      const then = printAt(node.then, PRECEDENCE_TERNARY, options);
      const otherwise = printAt(node.otherwise, PRECEDENCE_TERNARY, options);
      return options.spaced
        ? `${test} ? ${then} : ${otherwise}`
        : `${test}?${then}:${otherwise}`;
    }

    case 'call':
      return `${node.name}(${printList(node.args, options)})`;

    case 'array':
      return `[${printList(node.items, options)}]`;

    case 'object': {
      const entries = node.entries.map(
        (entry) =>
          `${printString(entry.key)}:${options.spaced ? ' ' : ''}${printAt(entry.value, PRECEDENCE_TERNARY, options)}`,
      );
      return `{${entries.join(options.spaced ? ', ' : ',')}}`;
    }
  }
}

function printList(nodes: readonly ExprNode[], options: PrintOptions): string {
  return nodes
    .map((item) => printAt(item, PRECEDENCE_TERNARY, options))
    .join(options.spaced ? ', ' : ',');
}

/**
 * A member access, appended to `prefix` (everything printed so far in this path).
 *
 * Identifier-shaped names print as `.name` and numeric ones as `.0`, the two
 * forms `parseFieldName` reads, so a field segment always parses back as a field
 * segment rather than a computed subscript. A numeric name is spaced off when the
 * text before it ends in a digit, because `$.a.0.1` would otherwise re-lex `0.1`
 * as one number. Anything else — a name the lexer cannot read back — becomes a
 * bracketed string literal, which resolves the exact same member.
 */
function printSegment(
  segment: ExprPathSegment,
  prefix: string,
  options: PrintOptions,
): string {
  if (segment.kind === 'index') {
    return `[${printAt(segment.expression, PRECEDENCE_TERNARY, options)}]`;
  }
  const { name } = segment;
  if (BARE_FIELD_NAME.test(name)) return `.${name}`;
  if (NUMERIC_FIELD_NAME.test(name)) {
    const previous = prefix.charAt(prefix.length - 1);
    return previous >= '0' && previous <= '9' ? ` .${name}` : `.${name}`;
  }
  return `[${printString(name)}]`;
}

/** A `Json` literal as source. Composite values only reach here hand-built. */
function printLiteral(value: Json, options: PrintOptions): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return printNumber(value);
    case 'string':
      return printString(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => printLiteral(item, options));
    return `[${items.join(options.spaced ? ', ' : ',')}]`;
  }
  const entries = Object.entries(value).map(
    ([key, entry]) => `${printString(key)}:${options.spaced ? ' ' : ''}${printLiteral(entry, options)}`,
  );
  return `{${entries.join(options.spaced ? ', ' : ',')}}`;
}

/** A number the lexer reads back as the same value. `-0` prints as `0`. */
function printNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  return String(withoutNegativeZero(value));
}

/** A single-quoted string literal, escaped exactly as `readString` decodes. */
function printString(value: string): string {
  let out = "'";
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        continue;
      case "'":
        out += "\\'";
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      default:
        break;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return `${out}'`;
}
