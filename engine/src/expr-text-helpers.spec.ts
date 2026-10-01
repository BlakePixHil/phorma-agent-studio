/**
 * Expression functions added for document delivery (Requirement 10):
 * `parseJson`, `containsAny`, `distinctBy`, `extractNumbers`, `htmlToText`.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compileExpression, type Json } from './expr.js';
import { jsonArb } from './test/generators.js';

const run = (source: string, $: Json = null): Json =>
  compileExpression(source).evaluate({ $, $text: '', nowMs: 0 });

describe('parseJson', () => {
  it('parses JSON text and yields null otherwise', () => {
    expect(run("parseJson('{\"a\":[1,2]}')")).toEqual({ a: [1, 2] });
    expect(run("parseJson('nope')")).toBeNull();
    expect(run('parseJson(42)')).toBeNull();
  });

  it('round-trips any JSON value (Requirement 10.1)', () => {
    fc.assert(
      fc.property(jsonArb(), value => {
        expect(run('parseJson($.text)', { text: JSON.stringify(value) })).toEqual(value);
      }),
    );
  });
});

describe('containsAny', () => {
  it('matches any non-empty needle', () => {
    expect(run("containsAny('remote, worldwide', ['emea', 'worldwide'])")).toBe(true);
    expect(run("containsAny('onsite', ['remote'])")).toBe(false);
    expect(run("containsAny('anything', ['', 3])")).toBe(false);
    expect(run("containsAny(3, ['a'])")).toBeNull();
  });

  it('agrees with some(includes) for string needles (Requirement 10.2)', () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.string()), (text, needles) => {
        const expected = needles.some(needle => needle.length > 0 && text.includes(needle));
        expect(run('containsAny($.t, $.n)', { t: text, n: needles })).toBe(expected);
      }),
    );
  });
});

describe('distinctBy', () => {
  it('keeps the first element per key, in order', () => {
    const rows = [
      { k: 'a', n: 1 },
      { k: 'b', n: 2 },
      { k: 'a', n: 3 },
    ];
    expect(run("distinctBy($.rows, 'item.k')", { rows })).toEqual([rows[0], rows[1]]);
  });

  it('returns elements of the input with pairwise distinct keys (Requirement 10.3)', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ k: fc.integer({ min: 0, max: 5 }), v: fc.string() })), rows => {
        const out = run("distinctBy($.rows, 'item.k')", { rows }) as { k: number; v: string }[];
        const keys = out.map(row => row.k);
        expect(new Set(keys).size).toBe(keys.length);
        expect(new Set(keys)).toEqual(new Set(rows.map(row => row.k)));
        // Each kept row is the FIRST row with its key.
        for (const row of out) expect(rows.find(other => other.k === row.k)).toEqual(row);
      }),
    );
  });
});

describe('extractNumbers', () => {
  it('finds digit runs with separators', () => {
    expect(run("extractNumbers('Cut costs 40% across 3.5 years, 1,200 users in 2021')")).toEqual([
      '40',
      '3.5',
      '1,200',
      '2021',
    ]);
    expect(run("extractNumbers('none here')")).toEqual([]);
    expect(run('extractNumbers(null)')).toBeNull();
  });

  it('every figure occurs in the source (Requirement 10.4)', () => {
    fc.assert(
      fc.property(fc.string(), text => {
        const found = run('extractNumbers($.t)', { t: text }) as string[];
        for (const figure of found) {
          expect(text.includes(figure)).toBe(true);
          expect(/^\d/.test(figure)).toBe(true);
        }
      }),
    );
  });
});

describe('htmlToText', () => {
  it('strips markup and decodes entities', () => {
    // Readable text is markdown-flavoured: emphasis survives as `**`.
    expect(run("htmlToText('<p>Hello <b>world</b> &amp; friends</p>')")).toContain('Hello **world** & friends');
    // Double-escaped HTML (as some feeds deliver it) decodes in two passes.
    expect(run("htmlToText(htmlToText('&lt;p&gt;Hi&lt;/p&gt;'))")).toBe('Hi');
  });

  it('is total over strings and null on anything else (Requirement 10.6)', () => {
    fc.assert(
      fc.property(jsonArb(), value => {
        const out = run('htmlToText($.v)', { v: value });
        expect(typeof value === 'string' ? typeof out === 'string' : out === null).toBe(true);
      }),
    );
  });
});
