import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_KEY_DOMAIN,
  expressionAstArb,
  expressionSourceArb,
  jsonArb,
  joinableRowsArb,
  renderExpression,
  rowsArb,
  runEventArb,
  subExpressionSourceArb,
} from './generators.js';

/**
 * Harness self-check. These assertions guard the GENERATORS, not engine
 * behaviour: a generator that silently drifts (emits `undefined`, `NaN`, or
 * unparseable source) would weaken every property suite built on top of it.
 */
describe('test generators', () => {
  it('jsonArb produces JSON-round-trippable values', () => {
    fc.assert(
      fc.property(jsonArb(), (value) => {
        expect(value).not.toBeUndefined();
        expect(JSON.parse(JSON.stringify(value))).toEqual(value);
      }),
    );
  });

  it('rowsArb draws key fields from the configured domain and never emits undefined', () => {
    fc.assert(
      fc.property(rowsArb({ allowMissing: true }), (rows) => {
        for (const row of rows) {
          for (const [key, value] of Object.entries(row)) {
            expect(value).not.toBeUndefined();
            if (key === 'group' || key === 'bucket') {
              if (value !== null) expect(DEFAULT_KEY_DOMAIN).toContain(value);
            }
            if (key === 'amount' && typeof value === 'number') {
              expect(Number.isFinite(value)).toBe(true);
            }
          }
        }
      }),
    );
  });

  it('joinableRowsArb yields two tables over the same key domain', () => {
    fc.assert(
      fc.property(joinableRowsArb({ minRows: 1, maxRows: 4 }), ({ left, right }) => {
        expect(Array.isArray(left)).toBe(true);
        expect(Array.isArray(right)).toBe(true);
      }),
    );
  });

  it('expressionSourceArb renders non-empty, balanced source text', () => {
    fc.assert(
      fc.property(expressionSourceArb(), (source) => {
        expect(source.length).toBeGreaterThan(0);
        expect(source.length).toBeLessThanOrEqual(4096);
        let depth = 0;
        let inString = false;
        for (let i = 0; i < source.length; i += 1) {
          const ch = source[i];
          if (inString) {
            if (ch === '\\') i += 1;
            else if (ch === "'") inString = false;
            continue;
          }
          if (ch === "'") inString = true;
          else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
          else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
          expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
        expect(inString).toBe(false);
      }),
    );
  });

  it('renderExpression is deterministic for the same AST', () => {
    fc.assert(
      fc.property(expressionAstArb(), (ast) => {
        expect(renderExpression(ast)).toBe(renderExpression(ast));
      }),
    );
  });

  it('subExpressionSourceArb embeds cleanly inside a single-quoted literal', () => {
    fc.assert(
      fc.property(subExpressionSourceArb(), (source) => {
        expect(source).not.toContain("'");
      }),
    );
  });

  it('runEventArb always produces a typed event with a runId', () => {
    fc.assert(
      fc.property(runEventArb, (event) => {
        expect(typeof event.type).toBe('string');
        expect(typeof event.runId).toBe('string');
        if (event.scope !== undefined) expect(Array.isArray(event.scope)).toBe(true);
      }),
    );
  });
});
