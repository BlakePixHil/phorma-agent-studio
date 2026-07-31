import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SQL_MAX_RESULT_BYTES,
  DEFAULT_SQL_MAX_ROWS,
  DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
  MAX_SQL_STATEMENT_LENGTH,
  extractNamedParameters,
  isWriteStatement,
  maskSqlText,
  reconcileSqlParameters,
  resolveSqlLimits,
  validateSqlStatement,
} from './sql-statement.js';

/**
 * Statement analysis for the `sql-query` node (Requirements 10.1, 10.2, 10.3,
 * 10.7, 10.10). Pure text in, decision out — no host, no driver, no I/O.
 */

describe('maskSqlText', () => {
  it('preserves length and newlines while blanking literals and comments', () => {
    const sql = "select a -- :x\nfrom t /* :y */ where b = ':z'";
    const masked = maskSqlText(sql);

    expect(masked).toHaveLength(sql.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).not.toContain(':x');
    expect(masked).not.toContain(':y');
    expect(masked).not.toContain(':z');
    expect(masked).toContain('select a');
    expect(masked).toContain('from t');
  });
});

describe('extractNamedParameters', () => {
  it('reads names in first-occurrence order with duplicates collapsed', () => {
    expect(
      extractNamedParameters('select * from o where id = :id and since > :since or id = :id'),
    ).toEqual(['id', 'since']);
  });

  it('ignores names inside string literals, comments and quoted identifiers', () => {
    const sql = `
      -- :from_line_comment
      /* :from_block_comment */
      select ':from_literal' as "..:from_identifier", [:from_bracket]
      from t where name = 'it''s :escaped' and id = :real`;

    expect(extractNamedParameters(sql)).toEqual(['real']);
  });

  it('skips :: casts, glued colons and digit-leading tokens', () => {
    expect(extractNamedParameters('select id::text, arr[1:2], a:=b, :1st, :ok from t')).toEqual([
      'ok',
    ]);
  });

  it('returns an empty list for a statement with no parameters', () => {
    expect(extractNamedParameters('select 1')).toEqual([]);
    expect(extractNamedParameters('')).toEqual([]);
  });
});

describe('validateSqlStatement', () => {
  it('accepts a parameterised statement', () => {
    expect(validateSqlStatement('select * from o where id = :id')).toBeUndefined();
  });

  it('rejects an empty or whitespace-only statement', () => {
    expect(validateSqlStatement('   \n ')).toMatch(/empty/i);
    expect(validateSqlStatement(undefined)).toMatch(/empty/i);
  });

  it('rejects a {{ token even alongside valid :name parameters', () => {
    const message = validateSqlStatement('select * from o where id = :id and t = {{input.t}}');

    expect(message).toMatch(/template token/i);
    expect(message).toContain('select * from o where id = :id and t = {{input.t}}');
  });

  it('rejects an over-long statement', () => {
    expect(validateSqlStatement(`select ${'a'.repeat(MAX_SQL_STATEMENT_LENGTH)}`)).toMatch(
      /limit is 20000/,
    );
  });

  it('rejects an unbindable parameter name', () => {
    expect(validateSqlStatement(`select * from t where a = :${'n'.repeat(70)}`)).toMatch(
      /cannot be bound/,
    );
  });
});

describe('reconcileSqlParameters', () => {
  const declared = (...names: string[]) => names.map((name) => ({ name, expression: '1' }));

  it('accepts an exact match and an empty declaration for a bare statement', () => {
    expect(
      reconcileSqlParameters('select * from o where id = :id and s > :since', declared('id', 'since')),
    ).toBeUndefined();
    expect(reconcileSqlParameters('select 1', undefined)).toBeUndefined();
  });

  it('names both directions of a mismatch', () => {
    const message = reconcileSqlParameters(
      'select * from o where id = :id and s > :since',
      declared('id', 'until'),
    );

    expect(message).toContain(':since');
    expect(message).toContain('until');
  });

  it('compares names case-sensitively', () => {
    const message = reconcileSqlParameters('select * from o where id = :Id', declared('id'));

    expect(message).toContain(':Id');
    expect(message).toContain('id');
  });

  it('rejects a duplicate declaration', () => {
    expect(reconcileSqlParameters('select :id', declared('id', 'id'))).toMatch(/more than once/);
  });

  it('rejects an unbindable declared name', () => {
    expect(reconcileSqlParameters('select 1', [{ name: '1bad', expression: '1' }])).toMatch(
      /cannot be bound/,
    );
  });
});

describe('isWriteStatement', () => {
  it.each([
    'select 1',
    '  select * from t where id = :id',
    'SELECT 1',
    '-- a comment\nselect 1',
    '/* header */ select 1',
    'show tables',
    'describe orders',
    'with recent as (select 1) select * from recent',
    'select 1;',
  ])('classifies %j as read-only', (statement) => {
    expect(isWriteStatement(statement)).toBe(false);
  });

  it.each([
    'insert into t values (1)',
    'update t set a = 1',
    'delete from t',
    'truncate table t',
    'drop table t',
    'merge into t using s on t.id = s.id',
    'exec sp_do_thing',
    'vacuum analyze',
    'wibble 1',
    '',
    'select 1; delete from t',
    'with x as (delete from t returning id) select * from x',
  ])('classifies %j as a write', (statement) => {
    expect(isWriteStatement(statement)).toBe(true);
  });

  it('does not read a keyword out of a comment or a literal', () => {
    expect(isWriteStatement("select ';delete from t' from audit -- delete from t")).toBe(false);
  });
});

describe('resolveSqlLimits', () => {
  it('falls back to the defaults with no node and no connection value', () => {
    expect(resolveSqlLimits(undefined, undefined)).toEqual({
      maxRows: DEFAULT_SQL_MAX_ROWS,
      maxResultBytes: DEFAULT_SQL_MAX_RESULT_BYTES,
      statementTimeoutMs: DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
    });
  });

  it('prefers node data over the connection limits, per limit', () => {
    expect(
      resolveSqlLimits(
        { maxRows: 50, statementTimeoutMs: 5_000 },
        { maxRows: 200, maxResultBytes: 2_048, statementTimeoutMs: 60_000 },
      ),
    ).toEqual({ maxRows: 50, maxResultBytes: 2_048, statementTimeoutMs: 5_000 });
  });

  it('falls through an out-of-range or non-integer node value instead of clamping', () => {
    expect(
      resolveSqlLimits(
        { maxRows: 0, statementTimeoutMs: 10.5 },
        { maxRows: 700, statementTimeoutMs: 90_000 },
      ),
    ).toEqual({
      maxRows: 700,
      maxResultBytes: DEFAULT_SQL_MAX_RESULT_BYTES,
      statementTimeoutMs: 90_000,
    });
  });

  it('falls through to the default when the connection value is out of range too', () => {
    expect(
      resolveSqlLimits({ maxRows: 2_000_000 }, { maxRows: -1, maxResultBytes: 33_554_433 }),
    ).toEqual({
      maxRows: DEFAULT_SQL_MAX_ROWS,
      maxResultBytes: DEFAULT_SQL_MAX_RESULT_BYTES,
      statementTimeoutMs: DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
    });
  });

  it('accepts the range boundaries', () => {
    expect(
      resolveSqlLimits(
        { maxRows: 1, maxResultBytes: 1_024, statementTimeoutMs: 1_000 },
        undefined,
      ),
    ).toEqual({ maxRows: 1, maxResultBytes: 1_024, statementTimeoutMs: 1_000 });
    expect(
      resolveSqlLimits(
        { maxRows: 1_000_000, maxResultBytes: 33_554_432, statementTimeoutMs: 300_000 },
        undefined,
      ),
    ).toEqual({ maxRows: 1_000_000, maxResultBytes: 33_554_432, statementTimeoutMs: 300_000 });
  });
});
