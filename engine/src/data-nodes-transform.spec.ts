import { describe, expect, it } from 'vitest';
import {
  DataNodeError,
  MAX_DATA_ELEMENTS,
  MAX_TRANSFORM_FIELDS,
  castValue,
  runTransform,
} from './data-nodes.js';
import type { EvalContext } from './expr.js';
import type { TransformField, TransformNodeData, WorkflowNode } from './types.js';

/**
 * `transform` projection and `castValue` (Requirements 5.1-5.14).
 *
 * The executor is pure, so every case is a literal: node data plus a payload in,
 * a JSON string out. Property coverage (shape preservation, non-mutation) is
 * task 10.2.
 */

const NOW_MS = 1_700_000_000_000;

function node(data: TransformNodeData): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Shape rows',
    kind: 'transform',
    category: 'flow',
    icon: 'pi-sitemap',
    position: { x: 0, y: 0 },
    ports: [],
    data,
  };
}

function context(payload: string): EvalContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = undefined;
  }
  return { $: parsed as EvalContext['$'], $text: payload, nowMs: NOW_MS };
}

function run(data: TransformNodeData, payload: string): unknown {
  return JSON.parse(runTransform(node(data), payload, context(payload)));
}

function field(partial: Partial<TransformField> & { target: string; expression: string }): TransformField {
  return partial;
}

describe('runTransform — mode and source selection', () => {
  it('projects one record per source element, in source order', () => {
    const payload = JSON.stringify({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    const out = run(
      {
        itemsPath: 'rows',
        fields: [field({ target: 'value', expression: 'item.n * 10' })],
      },
      payload,
    );
    expect(out).toEqual([{ value: 10 }, { value: 20 }, { value: 30 }]);
  });

  it('wraps an array projection under resultKey', () => {
    const out = run(
      {
        mode: 'array',
        resultKey: 'rows',
        fields: [field({ target: 'i', expression: 'index' })],
      },
      JSON.stringify([{}, {}]),
    );
    expect(out).toEqual({ rows: [{ i: 0 }, { i: 1 }] });
  });

  it('projects a single record with index 0 in record mode', () => {
    const out = run(
      {
        mode: 'record',
        fields: [
          field({ target: 'id', expression: '$.id' }),
          field({ target: 'i', expression: 'index' }),
        ],
      },
      JSON.stringify({ id: 'a-1' }),
    );
    expect(out).toEqual({ id: 'a-1', i: 0 });
  });

  it('preserves an empty source array as an empty output array', () => {
    expect(run({ itemsPath: 'rows', fields: [field({ target: 'a', expression: '1' })] }, '{"rows":[]}'))
      .toEqual([]);
  });

  it('fails when a required array source is not an array', () => {
    expect(() =>
      run({ itemsPath: 'rows', fields: [field({ target: 'a', expression: '1' })] }, '{"rows":7}'),
    ).toThrow(/expected an array at "rows"/);
  });
});

describe('runTransform — field pipeline', () => {
  it('applies default, then cast, then the required check', () => {
    const out = run(
      {
        mode: 'record',
        fields: [
          field({ target: 'count', expression: '$.missing', default: '42', cast: 'integer' }),
          field({ target: 'flag', expression: '$.missing', default: 'yes', cast: 'boolean' }),
        ],
      },
      '{}',
    );
    expect(out).toEqual({ count: 42, flag: true });
  });

  it('omits an optional null target and keeps a required one failing', () => {
    expect(run({ mode: 'record', fields: [field({ target: 'a', expression: '$.nope' })] }, '{}')).toEqual({});
    expect(() =>
      run({ mode: 'record', fields: [field({ target: 'a', expression: '$.nope', required: true })] }, '{}'),
    ).toThrow(/Transform "a" produced no value/);
  });

  it('writes dotted targets as nested objects', () => {
    const out = run(
      {
        mode: 'record',
        fields: [
          field({ target: 'customer.address.city', expression: "'Berlin'" }),
          field({ target: 'customer.id', expression: '$.id' }),
        ],
      },
      '{"id":9}',
    );
    expect(out).toEqual({ customer: { address: { city: 'Berlin' }, id: 9 } });
  });

  it('copies passthrough fields first so a mapped target wins', () => {
    const out = run(
      {
        mode: 'record',
        passthrough: true,
        fields: [field({ target: 'name', expression: "upper($.name)" })],
      },
      '{"name":"ada","keep":true}',
    );
    expect(out).toEqual({ name: 'ADA', keep: true });
  });

  it('never mutates the incoming payload, including through passthrough writes', () => {
    const source = { rows: [{ nested: { keep: 1 } }] };
    const payload = JSON.stringify(source);
    const ctx = context(payload);
    const before = JSON.stringify(ctx.$);
    runTransform(
      node({
        itemsPath: 'rows',
        passthrough: true,
        fields: [field({ target: 'nested.added', expression: '7' })],
      }),
      payload,
      ctx,
    );
    expect(JSON.stringify(ctx.$)).toBe(before);
  });

  it('is byte-identical across runs with identical inputs', () => {
    const data: TransformNodeData = {
      itemsPath: 'rows',
      fields: [field({ target: 'at', expression: 'now()', cast: 'date-iso' })],
    };
    const payload = '{"rows":[{},{}]}';
    const first = runTransform(node(data), payload, context(payload));
    expect(runTransform(node(data), payload, context(payload))).toBe(first);
  });
});

describe('runTransform — bounds and compile failures', () => {
  it('rejects an empty and an oversized field list', () => {
    expect(() => run({ fields: [] }, '{}')).toThrow(DataNodeError);
    const many = Array.from({ length: MAX_TRANSFORM_FIELDS + 1 }, (_, i) =>
      field({ target: `f${i}`, expression: '1' }),
    );
    expect(() => run({ fields: many }, '{}')).toThrow(new RegExp(String(MAX_TRANSFORM_FIELDS)));
  });

  it('fails before projecting when any expression does not compile', () => {
    let error: unknown;
    try {
      run(
        {
          mode: 'record',
          fields: [
            field({ target: 'ok', expression: '1' }),
            field({ target: 'broken', expression: '$.a +' }),
          ],
        },
        '{}',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DataNodeError);
    expect((error as DataNodeError).target).toBe('broken');
    expect((error as DataNodeError).position).toBeTypeOf('number');
  });

  it('rejects a source array above the element limit', () => {
    const ctx = context('[]');
    const big = new Array(MAX_DATA_ELEMENTS + 1).fill(0);
    expect(() =>
      runTransform(node({ mode: 'array', fields: [field({ target: 'a', expression: '1' })] }), '[]', {
        ...ctx,
        $: big,
      }),
    ).toThrow(new RegExp(String(MAX_DATA_ELEMENTS)));
  });
});

describe('castValue', () => {
  it('keeps null null for every cast', () => {
    for (const cast of ['string', 'number', 'integer', 'boolean', 'date-iso'] as const) {
      expect(castValue(null, cast)).toBeNull();
    }
  });

  it('truncates integers toward zero and rejects non-numerics', () => {
    expect(castValue(-3.9, 'integer')).toBe(-3);
    expect(castValue('  4.7 ', 'integer')).toBe(4);
    expect(castValue('4 apples', 'integer')).toBeNull();
    expect(castValue({}, 'number')).toBeNull();
  });

  it('emits UTC millisecond ISO timestamps and null for unparseable input', () => {
    expect(castValue(0, 'date-iso')).toBe('1970-01-01T00:00:00.000Z');
    expect(castValue('2024-03-01', 'date-iso')).toBe('2024-03-01T00:00:00.000Z');
    expect(castValue('2024-02-30', 'date-iso')).toBeNull();
    expect(castValue('last tuesday', 'date-iso')).toBeNull();
  });

  // `date-iso` only emits the four-digit-year form, so its output is always
  // something `parseDate()` reads back — the cast stays total and idempotent.
  it('emits only four-digit-year timestamps and nulls instants outside that range', () => {
    const minEpochMs = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
    const maxEpochMs = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

    expect(castValue(minEpochMs, 'date-iso')).toBe('0000-01-01T00:00:00.000Z');
    expect(castValue(maxEpochMs, 'date-iso')).toBe('9999-12-31T23:59:59.999Z');

    // one millisecond past either end, and the wider ECMAScript time range
    expect(castValue(minEpochMs - 1, 'date-iso')).toBeNull();
    expect(castValue(maxEpochMs + 1, 'date-iso')).toBeNull();
    expect(castValue(2.5e14, 'date-iso')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(castValue(1e15, 'date-iso')).toBeNull();
    expect(castValue(8.64e15, 'date-iso')).toBeNull();
    expect(castValue(-8.64e15, 'date-iso')).toBeNull();

    // round trip: the string casts back to itself, at both boundaries and inside
    for (const epochMs of [minEpochMs, maxEpochMs, 0, 1_700_000_000_000]) {
      const once = castValue(epochMs, 'date-iso');
      expect(typeof once).toBe('string');
      expect(castValue(once, 'date-iso')).toBe(once);
      expect(once).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    // and an out-of-range value is idempotent through null, not through a string
    // `parseDate()` would refuse
    expect(castValue(castValue(maxEpochMs + 1, 'date-iso'), 'date-iso')).toBeNull();
  });

  it('casts strings and booleans without inventing values', () => {
    expect(castValue(true, 'string')).toBe('true');
    expect(castValue(12.5, 'string')).toBe('12.5');
    expect(castValue('off', 'boolean')).toBe(false);
    expect(castValue('maybe', 'boolean')).toBeNull();
    expect(castValue(0, 'boolean')).toBe(false);
  });
});
