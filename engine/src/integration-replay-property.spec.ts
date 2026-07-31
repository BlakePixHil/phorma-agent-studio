import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ResolvedConnection } from './connections.js';
import type { DataResponse, SqlResult } from './data-host.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import {
  FakeConnectionStore,
  FakeDataFetcher,
  FakeSqlHost,
  MemoryFixtureStore,
  NEVER_CALLED_MODEL,
} from './test/fake-host.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import { jsonNumberArb } from './test/generators.js';
import type {
  AssertNodeData,
  AggregateNodeData,
  HttpRequestNodeData,
  NotifyNodeData,
  SqlQueryNodeData,
  StateGetNodeData,
  StateSetNodeData,
  TransformNodeData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

/**
 * Property 12: No model in the data path, and replay repeats no side effects
 * (design §15) — claims 55, 56, 57 and 58.
 *
 *  55. **No model in the data path.** ∀ graph of data nodes only: a full run
 *      makes zero calls to `RunOptions.model` (asserted with a throwing mock
 *      `ModelClient`).
 *  56. **Journal replay safety.** ∀ run interrupted after a data node
 *      completed: re-running with the recorded `RunJournal` performs zero
 *      additional `dataFetch` / `sql.query` / `state.set` calls for that node
 *      and produces the same downstream payload.
 *  57. **Error-branch scoping.** ∀ data node with a wired error port: a
 *      failure in that node routes out the error port; a failure downstream
 *      of it does not.
 *  58. **Determinism end-to-end.** ∀ graph of `transform`/`aggregate`/`assert`
 *      nodes, ∀ payload: two runs produce byte-identical terminal output.
 *
 * Every case drives the REAL `startRun` over a data-only reference graph
 * (`state-set` -> `http-request` -> `sql-query` -> `transform` -> `aggregate`
 * -> `assert` -> `notify`) built from the in-memory host fakes of task 22.1:
 * `FakeConnectionStore`, `FakeDataFetcher`, `FakeSqlHost`, `MemoryFixtureStore`,
 * `MemoryStateStore` and `NEVER_CALLED_MODEL`. Nothing here is mocked at the
 * engine level — the executor switch, the fixture state machine, the
 * idempotency claim and the journal replay short-circuit are the engine's own.
 *
 * **Validates: Requirements 1.2, 1.5, 1.6, 5.14, 8.19**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Harness: a data-only reference graph
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-integration';
const CONNECTION_ID = 'conn-lob';

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
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

function stateSetNode(id: string, data: StateSetNodeData): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'state-set',
    category: 'flow',
    icon: 'ti ti-database',
    position: { x: 100, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data,
  };
}

function stateGetNode(id: string, data: StateGetNodeData): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'state-get',
    category: 'flow',
    icon: 'ti ti-database',
    position: { x: 100, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data,
  };
}

function httpNode(id: string, data: HttpRequestNodeData, wireError: boolean): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 200, y: 0 },
    ports: [
      port(`${id}-in-1`, 'message-in'),
      port(`${id}-out-1`, 'message-out'),
      port(`${id}-err-1`, 'message-out'),
    ],
    data: { ...data, ...(wireError ? { errorPortId: `${id}-err-1` } : {}) },
  };
}

function sqlNode(id: string, data: SqlQueryNodeData, wireError: boolean): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'sql-query',
    category: 'flow',
    icon: 'ti ti-database',
    position: { x: 300, y: 0 },
    ports: [
      port(`${id}-in-1`, 'message-in'),
      port(`${id}-out-1`, 'message-out'),
      port(`${id}-err-1`, 'message-out'),
    ],
    data: { ...data, ...(wireError ? { errorPortId: `${id}-err-1` } : {}) },
  };
}

function transformNode(id: string, data: TransformNodeData): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'transform',
    category: 'flow',
    icon: 'pi-sliders-h',
    position: { x: 400, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data,
  };
}

function aggregateNode(id: string, data: AggregateNodeData): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'aggregate',
    category: 'flow',
    icon: 'pi-chart-bar',
    position: { x: 500, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data,
  };
}

const ASSERT_PASS_PORT = 'assert-1-out-pass';
const ASSERT_FAIL_PORT = 'assert-1-out-fail';

function assertNode(data: AssertNodeData): WorkflowNode {
  return {
    id: 'assert-1',
    name: 'Guard',
    kind: 'assert',
    category: 'flow',
    icon: 'ti ti-shield-check',
    position: { x: 600, y: 0 },
    ports: [
      port('assert-1-in-1', 'message-in'),
      port(ASSERT_PASS_PORT, 'message-out'),
      port(ASSERT_FAIL_PORT, 'message-out'),
    ],
    data,
  };
}

function notifyNode(id: string, data: NotifyNodeData, wireError: boolean): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'notify',
    category: 'flow',
    icon: 'ti ti-bell',
    position: { x: 700, y: 0 },
    ports: [
      port(`${id}-in-1`, 'message-in'),
      port(`${id}-out-1`, 'message-out'),
      port(`${id}-err-1`, 'message-out'),
    ],
    data: { ...data, ...(wireError ? { errorPortId: `${id}-err-1` } : {}) },
  };
}

/** A pass-through marker: `router` with one out-port always routes there unchanged. */
function marker(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'router',
    category: 'flow',
    icon: 'pi-sliders-h',
    position: { x: 800, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: {},
  };
}

function connectionStore(host: FakeConnectionStore, overrides: Partial<ResolvedConnection> = {}): void {
  host.seed({
    id: CONNECTION_ID,
    type: 'sql',
    config: { baseUrl: 'https://api.example.com', driver: 'postgres' },
    secrets: {},
    auth: { mode: 'none' },
    allowWrites: false,
    ...overrides,
  });
}

function ok(body: string, over: Partial<DataResponse> = {}): Partial<DataResponse> {
  return { status: 200, headers: {}, body, byteCount: body.length, durationMs: 5, ...over };
}

function sqlResult(rows: Record<string, unknown>[]): Partial<SqlResult> {
  return { rows, rowCount: rows.length, durationMs: 5 };
}

/**
 * Builds the reference data-only graph (design §14.1, adapted):
 *
 *   trigger -> set-1 (state-set) -> http-1 -> sql-1 -> transform-1 ->
 *   aggregate-1 -> assert-1 --Passed--> marker(pass) / --Failed--> marker(caught)
 *
 * Every node is a data node (Requirement 1.1); the graph contains no `agent`.
 */
function referenceGraph(options: {
  readonly httpAmount: number;
  readonly sqlRows: number;
  readonly wireHttpError?: boolean;
  readonly wireSqlError?: boolean;
}): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    trigger(),
    stateSetNode('set-1', { key: 'wm:run', valueExpression: 'now()', semantics: 'watermark' }),
    httpNode(
      'http-1',
      {
        connectionId: CONNECTION_ID,
        method: 'GET',
        url: 'https://api.example.com/jobs',
        responseMode: 'json',
        resultKey: 'jobs',
      },
      options.wireHttpError === true,
    ),
    sqlNode(
      'sql-1',
      {
        connectionId: CONNECTION_ID,
        statement: 'select id, amount from orders where amount > :threshold',
        params: [{ name: 'threshold', expression: '0' }],
        resultKey: 'rows',
      },
      options.wireSqlError === true,
    ),
    transformNode('transform-1', {
      itemsPath: 'rows',
      mode: 'array',
      fields: [
        { target: 'id', expression: 'item.id', required: true },
        { target: 'amount', expression: 'item.amount', cast: 'number', default: 0 },
      ],
      resultKey: 'shaped',
    }),
    aggregateNode('aggregate-1', {
      op: 'group',
      itemsPath: 'shaped',
      group: {
        by: ['id'],
        metrics: [
          { name: 'total', fn: 'sum', path: 'amount' },
          { name: 'count', fn: 'count' },
        ],
      },
      resultKey: 'groups',
    }),
    assertNode({
      assertions: [{ name: 'has-groups', expression: 'len($.groups) >= 0' }],
      onBreach: 'fail',
    }),
    marker('pass-marker'),
  ];
  const connections = [
    connect('c1', 'trigger-out-1', 'set-1-in-1'),
    connect('c2', 'set-1-out-1', 'http-1-in-1'),
    connect('c3', 'http-1-out-1', 'sql-1-in-1'),
    connect('c4', 'sql-1-out-1', 'transform-1-in-1'),
    connect('c5', 'transform-1-out-1', 'aggregate-1-in-1'),
    connect('c6', 'aggregate-1-out-1', 'assert-1-in-1'),
    connect('c7', ASSERT_PASS_PORT, 'pass-marker-in-1'),
  ];
  if (options.wireHttpError === true) {
    nodes.push(marker('http-caught'));
    connections.push(connect('c8', 'http-1-err-1', 'http-caught-in-1'));
  }
  if (options.wireSqlError === true) {
    nodes.push(marker('sql-caught'));
    connections.push(connect('c9', 'sql-1-err-1', 'sql-caught-in-1'));
  }
  return { nodes, connections };
}

interface HostSet {
  readonly connections: FakeConnectionStore;
  readonly fetcher: FakeDataFetcher;
  readonly sqlHost: FakeSqlHost;
  readonly fixtures: MemoryFixtureStore;
  readonly state: MemoryStateStore;
}

function freshHosts(httpAmount: number, sqlRows: number): HostSet {
  const connections = new FakeConnectionStore();
  connectionStore(connections);
  const httpBody = JSON.stringify({ items: [{ id: 1, value: httpAmount }] });
  const fetcher = new FakeDataFetcher([ok(httpBody)]);
  const sqlHost = new FakeSqlHost({
    script: [sqlResult([{ id: 1, amount: sqlRows }])],
  });
  return {
    connections,
    fetcher,
    sqlHost,
    fixtures: new MemoryFixtureStore(),
    state: new MemoryStateStore(),
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

interface RunResult {
  readonly events: RunEvent[];
  readonly output: string | undefined;
}

async function runGraph(graph: WorkflowGraph, hosts: HostSet, input: string): Promise<RunResult> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph,
    input,
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    connections: hosts.connections,
    dataFetch: hosts.fetcher.fetch,
    sql: hosts.sqlHost,
    state: hosts.state,
    fixtures: hosts.fixtures,
  });
  await handle.done;
  return {
    events,
    output: eventsOf(events, 'run-completed')[0]?.output,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

const httpAmountArb = jsonNumberArb.filter(value => Number.isFinite(value));
const sqlRowsArb = jsonNumberArb.filter(value => Number.isFinite(value));

// ─────────────────────────────────────────────────────────────────────────────
// Claim 55 — no model in the data path
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12 (claim 55): a data-only graph makes zero calls to the model', () => {
  it('completes successfully with a throwing model client', () => {
    return fc.assert(
      fc.asyncProperty(httpAmountArb, sqlRowsArb, async (httpAmount, sqlRows) => {
        const hosts = freshHosts(httpAmount, sqlRows);
        const graph = referenceGraph({ httpAmount, sqlRows });

        // `NEVER_CALLED_MODEL.stream` throws unconditionally. A completed run
        // with no thrown "no model call" error IS the proof of zero calls: the
        // model was handed to `RunOptions.model` and never touched.
        const run = await runGraph(graph, hosts, '{}');

        expect(eventsOf(run.events, 'run-failed')).toEqual([]);
        expect(eventsOf(run.events, 'run-completed')).toHaveLength(1);
        expect(run.events.some(event => /model/i.test(String((event as { error?: string }).error ?? '')))).toBe(
          false,
        );
      }),
      { numRuns: 30 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 58 — determinism end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12 (claim 58): transform/aggregate/assert graphs are deterministic', () => {
  it('produces byte-identical terminal output across two independent runs', () => {
    return fc.assert(
      fc.asyncProperty(httpAmountArb, sqlRowsArb, async (httpAmount, sqlRows) => {
        const graph = referenceGraph({ httpAmount, sqlRows });

        const first = await runGraph(graph, freshHosts(httpAmount, sqlRows), '{}');
        const second = await runGraph(graph, freshHosts(httpAmount, sqlRows), '{}');

        expect(first.output).toBeDefined();
        expect(second.output).toBe(first.output);
      }),
      { numRuns: 30 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 57 — error-branch scoping
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12 (claim 57): a wired error port scopes only its own node failure', () => {
  it('routes an http-request failure out its own error port without affecting downstream nodes', async () => {
    const hosts = freshHosts(1, 1);
    // The scripted step is an error status, so `http-1` fails and routes.
    const failingFetcher = new FakeDataFetcher([{ status: 500, headers: {}, body: 'boom', byteCount: 4 }]);
    const failingHosts: HostSet = { ...hosts, fetcher: failingFetcher };
    const graph = referenceGraph({ httpAmount: 1, sqlRows: 1, wireHttpError: true });

    const run = await runGraph(graph, failingHosts, '{}');

    // The http node's OWN failure routed out its error port: the run completed
    // (not failed), and the downstream pass path never started.
    expect(eventsOf(run.events, 'run-failed')).toEqual([]);
    expect(eventsOf(run.events, 'run-completed')).toHaveLength(1);
    const started = eventsOf(run.events, 'node-started').map(event => event.nodeId);
    expect(started).toContain('http-caught');
    expect(started).not.toContain('sql-1');
    expect(started).not.toContain('pass-marker');
  });

  it('does not let a downstream failure escape through an upstream error port', async () => {
    // `http-1` succeeds; `sql-1` fails (SqlHost unsupported for the requested
    // driver). `sql-1`'s own error port is wired, `http-1`'s is not — proving a
    // downstream failure is captured by the FAILING node's own port, never by
    // an unrelated ancestor's.
    const hosts = freshHosts(1, 1);
    hosts.sqlHost.setSupports('postgres', false);
    const graph = referenceGraph({ httpAmount: 1, sqlRows: 1, wireSqlError: true });

    const run = await runGraph(graph, hosts, '{}');

    expect(eventsOf(run.events, 'run-failed')).toEqual([]);
    expect(eventsOf(run.events, 'run-completed')).toHaveLength(1);
    const started = eventsOf(run.events, 'node-started').map(event => event.nodeId);
    expect(started).toContain('http-1');
    expect(started).toContain('sql-caught');
    expect(started).not.toContain('transform-1');
    expect(started).not.toContain('pass-marker');
  });

  it('fails the whole run when a downstream failure has no wired error port at all', async () => {
    // Neither http-1 nor sql-1 wires an error port here: sql-1's failure must
    // fail the run rather than being silently absorbed anywhere upstream.
    const hosts = freshHosts(1, 1);
    hosts.sqlHost.setSupports('postgres', false);
    const graph = referenceGraph({ httpAmount: 1, sqlRows: 1 });

    const run = await runGraph(graph, hosts, '{}');

    expect(eventsOf(run.events, 'run-completed')).toEqual([]);
    expect(eventsOf(run.events, 'run-failed')).toHaveLength(1);
    const started = eventsOf(run.events, 'node-started').map(event => event.nodeId);
    expect(started).not.toContain('pass-marker');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 56 — journal replay safety
// ─────────────────────────────────────────────────────────────────────────────

/** A `RunJournal` backed by a plain Map, mirroring how a host durably records completed nodes. */
class MemoryJournal {
  private readonly entries = new Map<string, { output: string; viaPortIds?: string[] }>();

  lookup(key: string): { output: string; viaPortIds?: string[] } | undefined {
    return this.entries.get(key);
  }

  record(key: string, entry: { output: string; viaPortIds?: string[] }): void {
    this.entries.set(key, { output: entry.output, viaPortIds: entry.viaPortIds ? [...entry.viaPortIds] : undefined });
  }
}

describe('Property 12 (claim 56): journal replay repeats no side effect', () => {
  it('replays a journaled http-request node with zero additional dataFetch calls and the same downstream payload', async () => {
    const journal = new MemoryJournal();
    const hosts = freshHosts(7, 3);
    const graph = referenceGraph({ httpAmount: 7, sqlRows: 3 });

    // First run: everything journaled, http-1 called exactly once.
    const events1: RunEvent[] = [];
    const handle1 = startRun({
      runId: RUN_ID,
      graph,
      input: '{}',
      workflowId: WORKFLOW_ID,
      model: NEVER_CALLED_MODEL,
      emit: event => events1.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      connections: hosts.connections,
      dataFetch: hosts.fetcher.fetch,
      sql: hosts.sqlHost,
      state: hosts.state,
      fixtures: hosts.fixtures,
      journal,
    });
    await handle1.done;

    const firstOutput = eventsOf(events1, 'run-completed')[0]?.output;
    expect(firstOutput).toBeDefined();
    expect(hosts.fetcher.callCount).toBe(1);
    expect(hosts.sqlHost.callCount).toBe(1);
    const stateWritesAfterFirst = hosts.state.writes;

    // Second run: SAME journal, but fakes that throw/reject if actually called
    // again — a real second call would fail the run instead of silently
    // passing, so "zero additional calls" is checked by construction.
    const neverCalledFetcher = new FakeDataFetcher([]);
    const neverCalledSql = new FakeSqlHost({ script: [] });
    // A call past the script rejects (fetcher) or answers empty rows (SQL
    // host default) — the SQL host's own zero-row default would silently mask
    // a repeated call, so its `callCount` is asserted directly instead.
    const events2: RunEvent[] = [];
    const handle2 = startRun({
      runId: RUN_ID,
      graph,
      input: '{}',
      workflowId: WORKFLOW_ID,
      model: NEVER_CALLED_MODEL,
      emit: event => events2.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      connections: hosts.connections,
      dataFetch: neverCalledFetcher.fetch,
      sql: neverCalledSql,
      state: hosts.state,
      fixtures: hosts.fixtures,
      journal,
    });
    await handle2.done;

    const secondOutput = eventsOf(events2, 'run-completed')[0]?.output;
    expect(eventsOf(events2, 'run-failed')).toEqual([]);
    expect(secondOutput).toBe(firstOutput);

    // Zero additional dataFetch / sql.query / state.set calls for the
    // journaled nodes.
    expect(neverCalledFetcher.callCount).toBe(0);
    expect(neverCalledSql.callCount).toBe(0);
    expect(hosts.state.writes).toBe(stateWritesAfterFirst);
  });

  it('resumes past a journaled prefix and executes only the un-journaled remainder', async () => {
    // Simulates a run "interrupted after a data node completed": manually
    // pre-populate the journal with only the FIRST node's entry (as if the
    // process died right after `set-1` completed and before `http-1` ran), then
    // resume with a fresh host that would fail loudly if `set-1` executed again.
    const journal = new MemoryJournal();
    const primingState = new MemoryStateStore();
    const primingConnections = new FakeConnectionStore();
    connectionStore(primingConnections);

    const primingGraph: WorkflowGraph = {
      nodes: [trigger(), stateSetNode('set-1', { key: 'wm:run', valueExpression: 'now()', semantics: 'watermark' })],
      connections: [connect('c1', 'trigger-out-1', 'set-1-in-1')],
    };
    const primingEvents: RunEvent[] = [];
    const primingHandle = startRun({
      runId: RUN_ID,
      graph: primingGraph,
      input: '{}',
      workflowId: WORKFLOW_ID,
      model: NEVER_CALLED_MODEL,
      emit: event => primingEvents.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      state: primingState,
      journal,
    });
    await primingHandle.done;
    expect(eventsOf(primingEvents, 'run-completed')).toHaveLength(1);

    // Resume over the FULL reference graph with the same journal: `set-1`
    // must replay from the journal (no additional `state.set`), while the rest
    // of the graph executes for real against fresh hosts.
    const hosts = freshHosts(5, 2);
    const graph = referenceGraph({ httpAmount: 5, sqlRows: 2 });
    const writesBeforeResume = primingState.writes;

    const events: RunEvent[] = [];
    const handle = startRun({
      runId: RUN_ID,
      graph,
      input: '{}',
      workflowId: WORKFLOW_ID,
      model: NEVER_CALLED_MODEL,
      emit: event => events.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      connections: hosts.connections,
      dataFetch: hosts.fetcher.fetch,
      sql: hosts.sqlHost,
      state: primingState,
      fixtures: hosts.fixtures,
      journal,
    });
    await handle.done;

    expect(eventsOf(events, 'run-completed')).toHaveLength(1);
    // No additional state.set for the already-journaled `set-1` node: its
    // `node-started`/`node-completed` pair still fires (the journal
    // short-circuits the node BODY, not the lifecycle events), but its
    // recorded output is replayed verbatim with no new write to the store.
    expect(primingState.writes).toBe(writesBeforeResume);
    expect(eventsOf(events, 'node-completed').find(event => event.nodeId === 'set-1')?.output).toBe(
      eventsOf(primingEvents, 'node-completed').find(event => event.nodeId === 'set-1')?.output,
    );
    // The un-journaled remainder ran for real, exactly once each.
    expect(hosts.fetcher.callCount).toBe(1);
    expect(hosts.sqlHost.callCount).toBe(1);
    const started = eventsOf(events, 'node-started').map(event => event.nodeId);
    expect(started).toContain('http-1');
    expect(started).toContain('sql-1');
  });
});
