/**
 * SQL statement analysis for the `sql-query` node (design §5.4, P1-6).
 *
 * Everything here is pure text analysis: no driver, no host, no I/O. The
 * executor (`runSqlQuery`) calls these functions *before* it touches
 * {@link SqlHost}, so an injection-shaped statement, a parameter mismatch or a
 * write against a read-only connection fails the node with the target database
 * untouched.
 *
 * Four jobs:
 *
 * - {@link validateSqlStatement} rejects an empty statement, an over-long one
 *   and — the guardrail that matters — one carrying a `{{` template token.
 *   Templates in SQL are exactly the concatenation the design forbids.
 * - {@link extractNamedParameters} reads the `:name` placeholders, ignoring the
 *   ones inside string literals, quoted identifiers, line comments and block
 *   comments, so `select ':not_a_param'` declares nothing.
 * - {@link isWriteStatement} classifies a statement conservatively: read-only
 *   only for a leading `SELECT`, `WITH … SELECT`, `SHOW` or `DESCRIBE`. A false
 *   positive asks the operator to tick "allow writes"; a false negative would
 *   let a workflow mutate a read-only source.
 * - {@link resolveSqlLimits} resolves the three host limits from node data, then
 *   the connection, then the defaults.
 *
 * The literal/comment skipping is deliberately dialect-generous: `'…'` with
 * `''` escaping, `"…"`, backticks and `[…]`, `--` line comments and nestable
 * `/* … *\/` blocks. Where dialects disagree (a MySQL backslash escape, a
 * Postgres dollar-quoted body) the scanner errs toward extracting a name it
 * should have skipped, which surfaces as a parameter mismatch and fails the
 * node — the safe direction.
 */

import type { SqlLimits } from './connections.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds (requirements 10.1, 10.10)
// ─────────────────────────────────────────────────────────────────────────────

/** Shortest accepted statement, once surrounding whitespace is removed. */
export const MIN_SQL_STATEMENT_LENGTH = 1;
/** Longest accepted statement. */
export const MAX_SQL_STATEMENT_LENGTH = 20_000;
/** Most declared parameters a single node may carry. */
export const MAX_SQL_PARAMETERS = 64;
/** The only accepted parameter name shape. */
export const SQL_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Rows returned when neither node data nor the connection sets a cap. */
export const DEFAULT_SQL_MAX_ROWS = 10_000;
/** Result bytes read when neither node data nor the connection sets a cap. */
export const DEFAULT_SQL_MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Statement timeout when neither node data nor the connection sets one. */
export const DEFAULT_SQL_STATEMENT_TIMEOUT_MS = 30_000;

/** Inclusive accepted ranges; a value outside its range is ignored, not clamped. */
export const SQL_LIMIT_RANGES = {
  maxRows: { min: 1, max: 1_000_000 },
  maxResultBytes: { min: 1_024, max: 33_554_432 },
  statementTimeoutMs: { min: 1_000, max: 300_000 },
} as const;

/** Length of the statement excerpt echoed back in a rejection message. */
const EXCERPT_LENGTH = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Literal and comment masking
// ─────────────────────────────────────────────────────────────────────────────

const SPACE = ' ';

/** Quote characters that open a run of text carrying no SQL syntax. */
const QUOTES = new Set(["'", '"', '`']);

function isWordChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$'
  );
}

/**
 * Returns a copy of `statement` in which every string literal, quoted
 * identifier, line comment and block comment is blanked to spaces, with the
 * length, the newlines and every other character preserved.
 *
 * Position-preserving masking is what lets the parameter scanner and the
 * keyword classifier work on a single flat string: an offset in the mask is the
 * same offset in the source, so a caller can still report a position against
 * the statement the author wrote.
 *
 * Exported for the tests, which pin the masking rules dialect by dialect.
 */
export function maskSqlText(statement: string): string {
  if (typeof statement !== 'string' || statement.length === 0) return '';
  const source = statement;
  const out = source.split('');
  const n = source.length;

  /** Blanks one position, keeping newlines so line structure survives. */
  const blank = (index: number): void => {
    if (source[index] !== '\n') out[index] = SPACE;
  };

  let i = 0;
  while (i < n) {
    const char = source[i];
    const next = source[i + 1];

    // `-- …` to end of line.
    if (char === '-' && next === '-') {
      while (i < n && source[i] !== '\n') blank(i++);
      continue;
    }

    // `/* … */`, nestable as Postgres allows.
    if (char === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (source[i] === '/' && source[i + 1] === '*') {
          blank(i);
          blank(i + 1);
          depth += 1;
          i += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          blank(i);
          blank(i + 1);
          depth -= 1;
          i += 2;
          if (depth <= 0) break;
          continue;
        }
        blank(i);
        i += 1;
      }
      continue;
    }

    // `'…'`, `"…"` and `` `…` ``, with the doubled-delimiter escape.
    if (QUOTES.has(char)) {
      blank(i);
      i += 1;
      while (i < n) {
        if (source[i] === char) {
          blank(i);
          i += 1;
          if (i < n && source[i] === char) {
            blank(i);
            i += 1;
            continue;
          }
          break;
        }
        blank(i);
        i += 1;
      }
      continue;
    }

    // `[…]` bracketed identifiers (SQL Server), with the `]]` escape.
    if (char === '[') {
      blank(i);
      i += 1;
      while (i < n) {
        if (source[i] === ']') {
          blank(i);
          i += 1;
          if (i < n && source[i] === ']') {
            blank(i);
            i += 1;
            continue;
          }
          break;
        }
        blank(i);
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Named parameter extraction (requirement 10.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the named parameters of a statement in first-occurrence order with
 * duplicates collapsed, ignoring every `:name` inside a string literal, a
 * quoted identifier, a line comment or a block comment.
 *
 * A `::` type cast is skipped whole, so `id::text` contributes nothing, and a
 * colon glued to the end of a word (`array[1:2]`, `a:=b`) opens no parameter.
 * The scanner reads the full word run rather than the first 64 characters, so an
 * over-long name comes back over-long and {@link validateSqlStatement} can
 * reject it by name instead of silently truncating it into a different one.
 */
export function extractNamedParameters(statement: string): string[] {
  if (typeof statement !== 'string' || statement.length === 0) return [];
  const masked = maskSqlText(statement);
  const names: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== ':') {
      i += 1;
      continue;
    }

    // `::` is a cast, never a parameter; consume both colons.
    if (masked[i + 1] === ':') {
      i += 2;
      continue;
    }

    // A colon glued to the right of a word is a range or an assignment.
    if (isWordChar(masked[i - 1])) {
      i += 1;
      continue;
    }

    const start = i + 1;
    let end = start;
    while (end < masked.length && isWordChar(masked[end])) end += 1;

    // A name must open with a letter or an underscore; `:1` is not a parameter.
    const first = masked[start];
    if (end > start && first !== undefined && !(first >= '0' && first <= '9')) {
      const name = masked.slice(start, end);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    i = end > start ? end : start;
  }

  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statement validation (requirements 10.1, 10.2, 10.3)
// ─────────────────────────────────────────────────────────────────────────────

function excerpt(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH)}…`;
}

/**
 * Validates a statement on its own, returning `undefined` when it is usable and
 * a human-readable rejection message otherwise.
 *
 * The `{{` check runs on the raw text, not the mask: a template token inside a
 * literal or a comment is still an author mistake worth naming, and a statement
 * carrying both a `{{` token and valid `:name` parameters is still rejected.
 */
export function validateSqlStatement(statement: unknown): string | undefined {
  if (typeof statement !== 'string' || statement.trim().length < MIN_SQL_STATEMENT_LENGTH) {
    return 'SQL statement is empty. Write a parameterised statement using :name parameters.';
  }
  if (statement.length > MAX_SQL_STATEMENT_LENGTH) {
    return `SQL statement is ${statement.length} characters; the limit is ${MAX_SQL_STATEMENT_LENGTH}.`;
  }
  if (statement.includes('{{')) {
    return (
      'SQL statement contains a {{ template token, which would concatenate payload text into SQL. ' +
      `Use a :name parameter instead. Statement: "${excerpt(statement)}"`
    );
  }

  const invalid = extractNamedParameters(statement).filter(
    (name) => !SQL_PARAM_NAME_PATTERN.test(name),
  );
  if (invalid.length > 0) {
    return `SQL statement uses parameter name${invalid.length === 1 ? '' : 's'} that cannot be bound: ${invalid
      .map((name) => `:${name}`)
      .join(', ')}. A name must match ${SQL_PARAM_NAME_PATTERN.source}.`;
  }

  return undefined;
}

/** One declared parameter, as carried by `SqlQueryNodeData.params`. */
export interface DeclaredSqlParameter {
  name: string;
  expression: string;
}

/**
 * Compares the parameters the statement uses against the ones the node
 * declares, returning `undefined` on an exact match and a message naming every
 * disagreement otherwise.
 *
 * Comparison is case-sensitive: `:Since` and `since` are different parameters,
 * and quietly binding one to the other would ship the wrong value.
 */
export function reconcileSqlParameters(
  statement: string,
  declared: readonly DeclaredSqlParameter[] | undefined,
): string | undefined {
  const params = declared ?? [];
  if (params.length > MAX_SQL_PARAMETERS) {
    return `SQL node declares ${params.length} parameters; the limit is ${MAX_SQL_PARAMETERS}.`;
  }

  const declaredNames: string[] = [];
  const duplicates: string[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  for (const param of params) {
    const name = typeof param?.name === 'string' ? param.name : '';
    if (!SQL_PARAM_NAME_PATTERN.test(name)) {
      malformed.push(name);
      continue;
    }
    if (seen.has(name)) {
      duplicates.push(name);
      continue;
    }
    seen.add(name);
    declaredNames.push(name);
  }

  if (malformed.length > 0) {
    return `SQL node declares parameter name${malformed.length === 1 ? '' : 's'} that cannot be bound: ${malformed
      .map((name) => (name.length === 0 ? '(empty)' : name))
      .join(', ')}. A name must match ${SQL_PARAM_NAME_PATTERN.source}.`;
  }
  if (duplicates.length > 0) {
    return `SQL node declares parameter ${duplicates.map((name) => `"${name}"`).join(', ')} more than once.`;
  }

  const used = extractNamedParameters(statement);
  const undeclared = used.filter((name) => !seen.has(name));
  const usedSet = new Set(used);
  const unused = declaredNames.filter((name) => !usedSet.has(name));
  if (undeclared.length === 0 && unused.length === 0) return undefined;

  const parts: string[] = [];
  if (undeclared.length > 0) {
    parts.push(`used in the statement but not declared: ${undeclared.map((n) => `:${n}`).join(', ')}`);
  }
  if (unused.length > 0) {
    parts.push(`declared but absent from the statement: ${unused.map((n) => n).join(', ')}`);
  }
  return `SQL parameters do not match the statement — ${parts.join('; ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write classification (requirement 10.7)
// ─────────────────────────────────────────────────────────────────────────────

/** Leading keywords that make a single statement read-only on their own. */
const READ_ONLY_LEADING: ReadonlySet<string> = new Set(['select', 'show', 'describe']);

/**
 * Verbs that make a `WITH …` statement a write at any nesting depth: Postgres
 * allows a data-modifying CTE (`WITH x AS (DELETE … RETURNING …) SELECT …`),
 * which reads as a `SELECT` at the top level while mutating a table.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'replace',
  'truncate',
  'drop',
  'create',
  'alter',
  'rename',
  'grant',
  'revoke',
  'call',
  'exec',
  'execute',
  'do',
  'copy',
  'load',
  'lock',
  'set',
  'commit',
  'rollback',
  'vacuum',
  'analyze',
  'reindex',
  'refresh',
  'attach',
  'detach',
  'pragma',
  'comment',
  'begin',
  'declare',
]);

/** Lower-cased word tokens of a masked statement, in source order. */
function wordTokens(masked: string): string[] {
  const tokens = masked.match(/[A-Za-z_][A-Za-z0-9_$]*/g);
  return tokens ? tokens.map((token) => token.toLowerCase()) : [];
}

/** Non-empty `;`-separated segments of a masked statement. */
function statementSegments(masked: string): string[] {
  return masked
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Conservative write classification, run after comments and literals are
 * masked away.
 *
 * Read-only only when the statement is a single `;`-separated statement whose
 * first keyword is `SELECT`, `SHOW`, `DESCRIBE`, or `WITH` followed somewhere by
 * a `SELECT` and by no write verb. Everything else — an unrecognised first
 * keyword, an empty statement, several statements in one box — is a write, so a
 * read-only connection refuses it.
 */
export function isWriteStatement(statement: string): boolean {
  if (typeof statement !== 'string') return true;
  const masked = maskSqlText(statement);
  const segments = statementSegments(masked);
  if (segments.length !== 1) return true;

  const tokens = wordTokens(segments[0]!);
  const first = tokens[0];
  if (first === undefined) return true;

  if (READ_ONLY_LEADING.has(first)) {
    // A leading SELECT cannot smuggle a write past the parser, but a stray write
    // verb in the token stream means the mask missed something; stay safe.
    return tokens.some((token) => WRITE_VERBS.has(token));
  }

  if (first === 'with') {
    const rest = tokens.slice(1);
    if (rest.some((token) => WRITE_VERBS.has(token))) return true;
    return !rest.includes('select');
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Limit resolution (requirement 10.10)
// ─────────────────────────────────────────────────────────────────────────────

/** The three limits every {@link SqlRequest} carries, fully resolved. */
export interface ResolvedSqlLimits {
  maxRows: number;
  maxResultBytes: number;
  statementTimeoutMs: number;
}

/**
 * Node-level limit overrides. `SqlQueryNodeData` sets only `maxRows` and
 * `statementTimeoutMs` today; `maxResultBytes` is accepted here so all three
 * tiers resolve through one code path.
 */
export interface SqlLimitOverrides {
  maxRows?: number;
  maxResultBytes?: number;
  statementTimeoutMs?: number;
}

type LimitName = keyof ResolvedSqlLimits;

/**
 * Picks the first tier that supplies an integer inside the accepted range.
 *
 * Out-of-range and non-integer values fall THROUGH rather than clamping: a
 * `maxRows: 0` from stale node data should not silently become 1 and return an
 * empty result set, and a nonsense timeout should not become the shortest legal
 * one. The next tier — connection, then default — answers instead.
 */
function pickLimit(name: LimitName, tiers: readonly (number | undefined)[], fallback: number): number {
  const { min, max } = SQL_LIMIT_RANGES[name];
  for (const value of tiers) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      return value;
    }
  }
  return fallback;
}

/**
 * Resolves `maxRows`, `maxResultBytes` and `statementTimeoutMs` from node data,
 * then the connection `limits`, then the defaults, independently per limit.
 */
export function resolveSqlLimits(
  node: SqlLimitOverrides | undefined,
  connectionLimits: SqlLimits | undefined,
): ResolvedSqlLimits {
  return {
    maxRows: pickLimit('maxRows', [node?.maxRows, connectionLimits?.maxRows], DEFAULT_SQL_MAX_ROWS),
    maxResultBytes: pickLimit(
      'maxResultBytes',
      [node?.maxResultBytes, connectionLimits?.maxResultBytes],
      DEFAULT_SQL_MAX_RESULT_BYTES,
    ),
    statementTimeoutMs: pickLimit(
      'statementTimeoutMs',
      [node?.statementTimeoutMs, connectionLimits?.statementTimeoutMs],
      DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
    ),
  };
}
