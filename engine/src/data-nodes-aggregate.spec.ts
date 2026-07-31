import { describe, expect, it } from 'vitest';
import {
  DataNodeError,
  MAX_DATA_ELEMENTS,
  MAX_GROUP_METRICS,
  runAggregate,
} from './data-nodes.js';
import type { EvalContext } from './expr.js';
import type { AggregateNodeData, WorkflowNode } from './types.js';

/**
 * `aggregate` grouping, joining and pivoting (Requirements 6.1-6.9, 6.11-6.13).
 *
 * The executor is pure, so every case is a literal: node data plus a payload in,
 * a JSON string out. Permutation invariance and join cardinality get property
 * coverage in tasks 10.4 and 10.5.
 */

const NOW_MS = 1_700_000_000_000;

function node(data: AggregateNodeData): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Counts per client',
    kind: 'aggregate',
    category: 'flow',
    icon: 'pi-chart-bar',
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

function runText(data: AggregateNodeData, source: unknown): string {
  const payload = JSON.stringify(source);
  return runAggregate(node(data), payload, context(payload));
}

function run(data: AggregateNodeData, source: unknown): unknown {
  return JSON.parse(runText(data, source));
}

describe('runAggregate — group', () => {
  it('emits one row per distinct by tuple in first-appearance order', () => {
    const out = run(
      { op: 'group', itemsPath: 'rows', group: { by: ['client'], metrics: [{ name: 'n', fn: 'count' }] } },
      { rows: [{ client: 'b' }, { client: 'a' }, { client: 'b' }] },
    );
    expect(out).toEqual([
      { client: 'b', n: 2 },
      { client: 'a', n: 1 },
    ]);
  });

  it('compares by tuples structurally and treats an absent path as null', () => {
    const out = run(
      { op: 'group', group: { by: ['key'], metrics: [{ name: 'n', fn: 'count' }] } },
      [{ key: { a: 1, b: 2 } }, { key: { b: 2, a: 1 } }, {}, { key: null }],
    );
    expect(out).toEqual([
      { key: { a: 1, b: 2 }, n: 2 },
      { key: null, n: 2 },
    ]);
  });

  it('groups by a multi-path tuple and rebuilds dotted by paths in the output', () => {
    const out = run(
      {
        op: 'group',
        group: { by: ['org.id', 'band'], metrics: [{ name: 'n', fn: 'count' }] },
      },
      [
        { org: { id: 7 }, band: 'L' },
        { org: { id: 7 }, band: 'S' },
        { org: { id: 7 }, band: 'L' },
      ],
    );
    expect(out).toEqual([
      { org: { id: 7 }, band: 'L', n: 2 },
      { org: { id: 7 }, band: 'S', n: 1 },
    ]);
  });

  it('wraps the row array under resultKey when one is declared', () => {
    const out = run(
      {
        op: 'group',
        resultKey: 'groups',
        group: { by: ['client'], metrics: [] },
      },
      [{ client: 'a' }],
    );
    expect(out).toEqual({ groups: [{ client: 'a' }] });
  });

  it('computes every metric function over the group', () => {
    const out = run(
      {
        op: 'group',
        group: {
          by: ['client'],
          metrics: [
            { name: 'rows', fn: 'count' },
            { name: 'open', fn: 'countIf', where: 'item.status == "open"' },
            { name: 'total', fn: 'sum', path: 'value' },
            { name: 'smallest', fn: 'min', path: 'value' },
            { name: 'largest', fn: 'max', path: 'value' },
            { name: 'mean', fn: 'avg', path: 'value' },
            { name: 'firstStatus', fn: 'first', path: 'status' },
            { name: 'statuses', fn: 'distinct', path: 'status' },
          ],
        },
      },
      [
        { client: 'a', status: 'open', value: 10 },
        { client: 'a', status: 'won', value: '5.5' },
        { client: 'a', status: 'open', value: 4.5 },
      ],
    );
    expect(out).toEqual([
      {
        client: 'a',
        rows: 3,
        open: 2,
        total: 20,
        smallest: 4.5,
        largest: 10,
        mean: 20 / 3,
        firstStatus: 'open',
        statuses: 2,
      },
    ]);
  });

  it('excludes non-numeric values from numeric metrics instead of producing NaN', () => {
    const out = run(
      {
        op: 'group',
        group: {
          by: ['client'],
          metrics: [
            { name: 'total', fn: 'sum', path: 'value' },
            { name: 'mean', fn: 'avg', path: 'value' },
            { name: 'largest', fn: 'max', path: 'value' },
          ],
        },
      },
      [
        { client: 'a', value: 4 },
        { client: 'a', value: true },
        { client: 'a', value: 'twelve' },
        { client: 'a', value: null },
        { client: 'a', value: { n: 1 } },
        { client: 'a', value: [1] },
        { client: 'a' },
        { client: 'a', value: 6 },
      ],
    );
    expect(out).toEqual([{ client: 'a', total: 10, mean: 5, largest: 6 }]);
  });

  it('emits 0 for an empty sum and null for an empty avg, min and max', () => {
    const out = run(
      {
        op: 'group',
        group: {
          by: ['client'],
          metrics: [
            { name: 'total', fn: 'sum', path: 'value' },
            { name: 'mean', fn: 'avg', path: 'value' },
            { name: 'smallest', fn: 'min', path: 'value' },
            { name: 'largest', fn: 'max', path: 'value' },
            { name: 'firstValue', fn: 'first', path: 'value' },
          ],
        },
      },
      [{ client: 'a', value: 'n/a' }],
    );
    expect(out).toEqual([
      { client: 'a', total: 0, mean: null, smallest: null, largest: null, firstValue: 'n/a' },
    ]);
  });

  it('counts null as one distinct value', () => {
    const out = run(
      {
        op: 'group',
        group: { by: ['client'], metrics: [{ name: 'tags', fn: 'distinct', path: 'tag' }] },
      },
      [{ client: 'a', tag: null }, { client: 'a' }, { client: 'a', tag: 'x' }],
    );
    expect(out).toEqual([{ client: 'a', tags: 2 }]);
  });

  it('binds item and the zero-based source index in a countIf predicate', () => {
    const out = run(
      {
        op: 'group',
        group: {
          by: ['client'],
          metrics: [{ name: 'late', fn: 'countIf', where: 'index >= 2 && item.client == "a"' }],
        },
      },
      [{ client: 'a' }, { client: 'b' }, { client: 'a' }, { client: 'a' }],
    );
    expect(out).toEqual([
      { client: 'a', late: 2 },
      { client: 'b', late: 0 },
    ]);
  });

  it('treats false, null, 0 and the empty string as the only falsy predicate results', () => {
    const out = run(
      {
        op: 'group',
        group: { by: ['client'], metrics: [{ name: 'hits', fn: 'countIf', where: 'item.flag' }] },
      },
      [
        { client: 'a', flag: false },
        { client: 'a', flag: null },
        { client: 'a', flag: 0 },
        { client: 'a', flag: '' },
        { client: 'a', flag: 'yes' },
        { client: 'a', flag: 1 },
      ],
    );
    expect(out).toEqual([{ client: 'a', hits: 2 }]);
  });

  it('is deterministic and leaves the incoming payload unchanged', () => {
    const data: AggregateNodeData = {
      op: 'group',
      group: { by: ['client'], metrics: [{ name: 'total', fn: 'sum', path: 'value' }] },
    };
    const source = [
      { client: 'a', value: 1 },
      { client: 'b', value: 2 },
    ];
    const before = JSON.stringify(source);
    expect(runText(data, source)).toBe(runText(data, source));
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('runAggregate — join', () => {
  const left = [
    { id: 1, name: 'ann' },
    { id: 2, name: 'bo' },
    { id: 3, name: 'cy' },
  ];
  const right = [
    { id: 1, name: 'north', total: 10 },
    { id: 1, name: 'south', total: 20 },
    { id: 3, name: 'east', total: 5 },
  ];

  function joinData(type: 'inner' | 'left', collisionPrefix?: string): AggregateNodeData {
    return {
      op: 'join',
      join: {
        leftPath: 'left',
        rightPath: 'right',
        leftKey: 'id',
        rightKey: 'id',
        type,
        ...(collisionPrefix === undefined ? {} : { collisionPrefix }),
      },
    };
  }

  it('emits one row per matching pair in left-then-right source order', () => {
    const out = run(joinData('inner'), { left, right });
    expect(out).toEqual([
      { id: 1, name: 'ann', right_id: 1, right_name: 'north', total: 10 },
      { id: 1, name: 'ann', right_id: 1, right_name: 'south', total: 20 },
      { id: 3, name: 'cy', right_id: 3, right_name: 'east', total: 5 },
    ]);
  });

  it('emits the bare left row for an unmatched left row in a left join', () => {
    const out = run(joinData('left'), { left, right }) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(4);
    expect(out[2]).toEqual({ id: 2, name: 'bo' });
  });

  it('matches an absent key only against another absent or null key', () => {
    const out = run(joinData('inner'), {
      left: [{ name: 'ann' }, { id: 1, name: 'bo' }],
      right: [{ id: null, tag: 'x' }, { id: 1, tag: 'y' }],
    });
    expect(out).toEqual([
      { name: 'ann', id: null, tag: 'x' },
      { id: 1, name: 'bo', right_id: 1, tag: 'y' },
    ]);
  });

  it('honours a custom collisionPrefix and leaves the left value unchanged', () => {
    const out = run(joinData('inner', 'r:'), {
      left: [{ id: 1, name: 'ann' }],
      right: [{ id: 1, name: 'north' }],
    });
    expect(out).toEqual([{ id: 1, name: 'ann', 'r:id': 1, 'r:name': 'north' }]);
  });
});

describe('runAggregate — pivot', () => {
  it('builds one flat object keyed by keyFields joined by the separator', () => {
    const out = run(
      {
        op: 'pivot',
        pivot: { rowsPath: 'groups', keyFields: ['band', 'status'], valueField: 'n' },
      },
      { groups: [{ band: 'L', status: 'open', n: 3 }, { band: 'S', status: 'won', n: 1 }] },
    );
    expect(out).toEqual({ L_open: 3, S_won: 1 });
  });

  it('honours a custom separator and non-string key values', () => {
    const out = run(
      {
        op: 'pivot',
        pivot: { rowsPath: 'groups', keyFields: ['id', 'ok'], valueField: 'n', separator: '-' },
      },
      { groups: [{ id: 7, ok: true, n: 2 }, { id: 8, ok: false, n: 4 }] },
    );
    expect(out).toEqual({ '7-true': 2, '8-false': 4 });
  });

  it('fills a declared column absent from the grouped rows with fillValue', () => {
    const out = run(
      {
        op: 'pivot',
        pivot: {
          rowsPath: 'groups',
          keyFields: ['band'],
          valueField: 'n',
          fillValue: 0,
          columns: ['L', 'M', 'S'],
        },
      },
      { groups: [{ band: 'L', n: 3 }] },
    );
    expect(out).toEqual({ L: 3, M: 0, S: 0 });
  });

  it('fails on a duplicated pivot key and emits no output', () => {
    expect(() =>
      runText(
        { op: 'pivot', pivot: { rowsPath: 'groups', keyFields: ['band'], valueField: 'n' } },
        { groups: [{ band: 'L', n: 1 }, { band: 'L', n: 9 }] },
      ),
    ).toThrow(/duplicate pivot key "L"/);
  });
});

describe('runAggregate — validation before accumulation', () => {
  it('rejects an unsupported op', () => {
    expect(() => runText({ op: 'rollup' } as unknown as AggregateNodeData, [])).toThrow(DataNodeError);
  });

  it('rejects a missing spec for the declared op', () => {
    expect(() => runText({ op: 'group' }, [])).toThrow(/no "group" spec/);
    expect(() => runText({ op: 'join' }, [])).toThrow(/no "join" spec/);
    expect(() => runText({ op: 'pivot' }, [])).toThrow(/no "pivot" spec/);
  });

  it('rejects an empty and an oversized by list', () => {
    expect(() => runText({ op: 'group', group: { by: [], metrics: [] } }, [])).toThrow(
      /"group.by" paths/,
    );
    const by = Array.from({ length: 11 }, (_unused, i) => `p${i}`);
    expect(() => runText({ op: 'group', group: { by, metrics: [] } }, [])).toThrow(/"group.by" paths/);
  });

  it('rejects a duplicated metric name', () => {
    expect(() =>
      runText(
        {
          op: 'group',
          group: {
            by: ['client'],
            metrics: [
              { name: 'n', fn: 'count' },
              { name: 'n', fn: 'sum', path: 'value' },
            ],
          },
        },
        [{ client: 'a' }],
      ),
    ).toThrow(/metric name "n" more than once/);
  });

  it('rejects more than the maximum number of metrics', () => {
    const metrics = Array.from({ length: MAX_GROUP_METRICS + 1 }, (_unused, i) => ({
      name: `m${i}`,
      fn: 'count' as const,
    }));
    expect(() => runText({ op: 'group', group: { by: ['client'], metrics } }, [])).toThrow(
      /above the maximum of 50/,
    );
  });

  it('rejects a countIf with no where and a where that does not compile', () => {
    expect(() =>
      runText(
        { op: 'group', group: { by: ['client'], metrics: [{ name: 'n', fn: 'countIf' }] } },
        [{ client: 'a' }],
      ),
    ).toThrow(/no "where" predicate/);

    let error: unknown;
    try {
      runText(
        {
          op: 'group',
          group: { by: ['client'], metrics: [{ name: 'n', fn: 'countIf', where: 'item.a ==' }] },
        },
        [{ client: 'a' }],
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DataNodeError);
    expect((error as DataNodeError).position).toBeTypeOf('number');
  });

  it('rejects a source path that does not resolve to an array', () => {
    expect(() =>
      runText(
        { op: 'group', itemsPath: 'rows', group: { by: ['client'], metrics: [] } },
        { rows: { client: 'a' } },
      ),
    ).toThrow(/expected an array at "rows" for "itemsPath", found an object/);

    expect(() =>
      runText(
        {
          op: 'join',
          join: { leftPath: 'left', rightPath: 'right', leftKey: 'id', rightKey: 'id', type: 'inner' },
        },
        { left: [], right: 3 },
      ),
    ).toThrow(/for "join.rightPath"/);
  });

  it('rejects a source array above the element limit and names the limit', () => {
    const oversized = new Array(MAX_DATA_ELEMENTS + 1).fill(0);
    expect(() =>
      runText({ op: 'group', itemsPath: 'rows', group: { by: ['client'], metrics: [] } }, {
        rows: oversized,
      }),
    ).toThrow(
      new RegExp(`received ${MAX_DATA_ELEMENTS + 1} elements.*maximum of ${MAX_DATA_ELEMENTS}`),
    );
  });

  it('rejects an unsupported join type and an invalid key path', () => {
    expect(() =>
      runText(
        {
          op: 'join',
          join: {
            leftPath: 'left',
            rightPath: 'right',
            leftKey: 'id',
            rightKey: 'id',
            type: 'outer',
          } as unknown as AggregateNodeData['join'],
        },
        { left: [], right: [] },
      ),
    ).toThrow(/unsupported join type/);

    expect(() =>
      runText(
        {
          op: 'join',
          join: { leftPath: 'left', rightPath: 'right', leftKey: '', rightKey: 'id', type: 'inner' },
        },
        { left: [], right: [] },
      ),
    ).toThrow(/invalid join.leftKey/);
  });
});
