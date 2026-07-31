/**
 * Unit tests for the `sql-query` executor as the engine actually runs it
 * (design §5.4, Requirements 10.1, 10.3, 10.4, 10.7, 10.13).
 *
 * Every case drives `startRun` over a small graph with a SCRIPTED `SqlHost`:
 * the host records each {@link SqlRequest} it receives, so "the payload never
 * became statement text" and "the node failed before any statement was
 * submitted" are both checked against what the driver would have seen rather
 * than against an internal call.
 *
 * The pure text-analysis suite for the same surface lives in
 * `sql-statement.spec.ts`; this file covers only what needs a run.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectionStore } from './data-host.js';
import type { SqlHost, SqlRequest, SqlResult } from './data-host.js';
import type { ResolvedConnection, SqlDriver } from './connections.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import type { SqlQueryNodeData, WorkflowGraph, WorkflowNode } from './types.js';

// ── harness ─────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'wf-sql';
const RUN_ID = 'run-sql';
const CONNECTION_ID = 'conn-warehouse';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

/** A `SqlHost` that records every request and answers from a fixed result. */
class RecordingSqlHost implements SqlHost {
  readonly requests: SqlRequest[] = [];

  constructor(
    private readonly result: Partial<SqlResult> = {},
    private readonly supported: ReadonlySet<SqlDriver> = new Set<SqlDriver>([
      'postgres',
      'mysql',
      'mssql',
      'sqlite',
    ]),
  ) {}

  supports(driver: SqlDriver): boolean {
    return this.supported.has(driver);
  }

  async query(request: SqlRequest): Promise<SqlResult> {
    this.requests.push(request);
    const rows = this.result.rows ?? [{ id: 1 }];
    return { rows, rowCount: rows.length, durationMs: 3, ...this.result };
  }
}

function connectionStore(overrides: Partial<ResolvedConnection> = {}): ConnectionStore {
  return {
    resolve: async (connectionId: string): Promise<ResolvedConnection> => ({
      id: connectionId,
      type: 'sql',
      config: { driver: 'postgres' },
      secrets: { password: 'sup3r-secret-value' },
      auth: { mode: 'none' },
      allowWrites: false,
      ...overrides,
    }),
  };
}

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
}

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out-1', 'message-out')],
    data: {},
  };
}

function sqlNode(data: Partial<SqlQueryNodeData>): WorkflowNode {
  return {
    id: 'sql-1',
    name: 'Read orders',
    kind: 'sql-query',
    category: 'data',
    icon: 'ti ti-database',
    position: { x: 200, y: 0 },
    ports: [port('sql-1-in-1', 'message-in'), port('sql-1-out-1', 'message-out')],
    data: {
      connectionId: CONNECTION_ID,
      statement: 'select 1',
      ...data,
    } as SqlQueryNodeData,
  };
}

function graphFor(data: Partial<SqlQueryNodeData>): WorkflowGraph {
  return {
    nodes: [trigger(), sqlNode(data)],
    connections: [{ id: 'c1', outputId: 'trigger-out-1', inputId: 'sql-1-in-1', kind: 'handoff' }],
  };
}

interface RunSetup {
  readonly data: Partial<SqlQueryNodeData>;
  readonly input?: string;
  readonly host?: RecordingSqlHost;
  readonly connection?: Partial<ResolvedConnection>;
}

interface RunResult {
  readonly events: RunEvent[];
  /** Every request the engine submitted to the host, in order. */
  readonly requests: SqlRequest[];
  readonly output: string | undefined;
  readonly failure: string | undefined;
}

async function runSql(setup: RunSetup): Promise<RunResult> {
  const events: RunEvent[] = [];
  const host = setup.host ?? new RecordingSqlHost();
  const handle = startRun({
    runId: RUN_ID,
    graph: graphFor(setup.data),
    input: setup.input ?? '{}',
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    sql: host,
    connections: connectionStore(setup.connection),
  });
  await handle.done;

  const completed = eventsOf(events, 'node-completed').find(event => event.nodeId === 'sql-1');
  const failed = eventsOf(events, 'node-failed').find(event => event.nodeId === 'sql-1');
  return {
    events,
    requests: host.requests,
    output: completed?.output,
    failure: failed?.error,
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

// ── parameter binding (10.1, 10.4, 10.13) ───────────────────────────────────

describe('sql-query parameter binding', () => {
  const INJECTION = "acme'; DROP TABLE users; --";

  it('binds an injection-shaped payload value as a parameter and never as SQL', async () => {
    const statement = 'select id, total from orders where customer = :customer';
    const host = new RecordingSqlHost({ rows: [{ id: 7 }] });
    const run = await runSql({
      data: { statement, params: [{ name: 'customer', expression: '$.customer' }] },
      input: JSON.stringify({ customer: INJECTION }),
      host,
    });

    expect(run.failure).toBeUndefined();
    expect(run.requests).toHaveLength(1);
    const request = run.requests[0]!;

    // The statement reached the driver byte-identical: no payload text in it.
    expect(request.statement).toBe(statement);
    expect(request.statement).not.toContain('DROP TABLE');
    // The dangerous text arrived as a bound value, unmodified and unescaped.
    expect(request.params).toEqual({ customer: INJECTION });
  });

  it('keeps parameter values out of the sql-query event', async () => {
    const run = await runSql({
      data: {
        statement: 'select id from orders where customer = :customer and open = :open',
        params: [
          { name: 'customer', expression: '$.customer' },
          { name: 'open', expression: 'true' },
        ],
      },
      input: JSON.stringify({ customer: INJECTION }),
    });

    const queryEvents = eventsOf(run.events, 'sql-query');
    expect(queryEvents).toHaveLength(1);
    expect(queryEvents[0]).toMatchObject({
      nodeId: 'sql-1',
      driver: 'postgres',
      paramCount: 2,
    });
    expect(JSON.stringify(queryEvents[0])).not.toContain('DROP TABLE');
  });

  it('binds every scalar kind in declaration order', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :a and b = :b and c = :c and d = :d',
        params: [
          { name: 'a', expression: '$.text' },
          { name: 'b', expression: '$.count' },
          { name: 'c', expression: 'false' },
          { name: 'd', expression: '$.missing' },
        ],
      },
      input: JSON.stringify({ text: 'x', count: 42 }),
      host,
    });

    expect(run.failure).toBeUndefined();
    expect(Object.keys(run.requests[0]!.params)).toEqual(['a', 'b', 'c', 'd']);
    expect(run.requests[0]!.params).toEqual({ a: 'x', b: 42, c: false, d: null });
  });

  it('binds nothing and submits no statement when an expression yields a non-scalar (10.13)', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :a and b = :b',
        params: [
          { name: 'a', expression: '$.text' },
          { name: 'b', expression: '$.items' },
        ],
      },
      input: JSON.stringify({ text: 'x', items: [1, 2] }),
      host,
    });

    expect(run.failure).toContain('"b"');
    expect(run.failure).toMatch(/array/i);
    expect(host.requests).toHaveLength(0);
    expect(eventsOf(run.events, 'sql-query')).toHaveLength(0);
  });

  it('fails before submitting when an expression cannot compile (10.13)', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :a',
        params: [{ name: 'a', expression: '$.' }],
      },
      host,
    });

    expect(run.failure).toContain('"a"');
    expect(host.requests).toHaveLength(0);
  });
});

// ── declared vs extracted names (10.3) ──────────────────────────────────────

describe('sql-query parameter reconciliation', () => {
  it('fails before submitting when a used name is undeclared', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :a and b = :b',
        params: [{ name: 'a', expression: '1' }],
      },
      host,
    });

    expect(run.failure).toContain(':b');
    expect(host.requests).toHaveLength(0);
    expect(eventsOf(run.events, 'sql-query')).toHaveLength(0);
  });

  it('fails before submitting when a declared name is absent from the statement', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :a',
        params: [
          { name: 'a', expression: '1' },
          { name: 'stale', expression: '2' },
        ],
      },
      host,
    });

    expect(run.failure).toContain('stale');
    expect(host.requests).toHaveLength(0);
  });

  it('compares names case-sensitively', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: 'select 1 from t where a = :Since',
        params: [{ name: 'since', expression: '1' }],
      },
      host,
    });

    expect(run.failure).toContain(':Since');
    expect(host.requests).toHaveLength(0);
  });

  it('ignores a colon token inside a literal or a comment when reconciling', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: {
        statement: "select ':nope' as label -- :also_nope\nfrom t where a = :a",
        params: [{ name: 'a', expression: '1' }],
      },
      host,
    });

    expect(run.failure).toBeUndefined();
    expect(host.requests[0]!.params).toEqual({ a: 1 });
  });

  it('fails before submitting on a {{ template token in the statement', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: { statement: 'select 1 from t where a = {{input.a}}' },
      host,
    });

    expect(run.failure).toMatch(/template token/i);
    expect(host.requests).toHaveLength(0);
  });
});

// ── write classification against a read-only connection (10.7) ──────────────

describe('sql-query write classification', () => {
  it.each([
    ['select', 'select id from orders where id = :id'],
    ['with … select', 'with recent as (select id from orders) select id from recent where id = :id'],
    ['show', 'show tables like :pattern'],
    ['describe', 'describe :pattern'],
  ])('runs a leading %s statement on a read-only connection', async (_label, statement) => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: { statement, params: [{ name: statement.includes(':id') ? 'id' : 'pattern', expression: '1' }] },
      host,
    });

    expect(run.failure).toBeUndefined();
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]!.statement).toBe(statement);
  });

  it('classifies multi-statement input as a write and refuses it on a read-only connection', async () => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: { statement: 'select id from orders; delete from orders' },
      host,
    });

    expect(run.failure).toContain(CONNECTION_ID);
    expect(run.failure).toMatch(/read-only/i);
    expect(host.requests).toHaveLength(0);
    expect(eventsOf(run.events, 'sql-query')).toHaveLength(0);
  });

  it.each([
    'insert into orders (id) values (:id)',
    'update orders set open = false where id = :id',
    'delete from orders where id = :id',
    'wibble :id',
  ])('refuses %j on a read-only connection', async statement => {
    const host = new RecordingSqlHost();
    const run = await runSql({
      data: { statement, params: [{ name: 'id', expression: '1' }] },
      host,
    });

    expect(run.failure).toMatch(/read-only/i);
    expect(host.requests).toHaveLength(0);
  });

  it('submits a write when the connection allows writes', async () => {
    const host = new RecordingSqlHost({ rows: [] });
    const run = await runSql({
      data: { statement: 'select id from orders; delete from orders where id = :id', params: [{ name: 'id', expression: '1' }] },
      connection: { allowWrites: true },
      host,
    });

    expect(run.failure).toBeUndefined();
    expect(host.requests).toHaveLength(1);
    expect(run.output).toBe(JSON.stringify({ rows: [], rowCount: 0 }));
  });
});
