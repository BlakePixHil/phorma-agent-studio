/**
 * The fixture replay suite for CI (task 22.4, design §11, Requirements 16.5,
 * 16.6, 16.9, 16.10).
 *
 * This suite is the CI-facing proof that the record/replay CONTRACT
 * (`engine/src/fixtures.ts`) works end to end against real serialised
 * fixture text, not merely against an in-memory value a test just wrote a
 * moment ago:
 *
 * - The fixture data in `./test/fixtures/data-node-fixtures.ts` is COMMITTED:
 *   it was captured once by driving `startRun` with `fixtures: 'record'`
 *   against scripted fake hosts, then copying the resulting
 *   `MemoryFixtureStore` entries verbatim (see that file's header for the
 *   exact recording inputs).
 * - Every test here seeds a FRESH `MemoryFixtureStore` from that committed
 *   data — never from a record pass performed in this file — and drives the
 *   SAME `http-request` / `sql-query` node graphs with `fixtures: 'replay'`.
 * - The fake `DataFetcher` / `SqlHost` handed to `startRun` are configured to
 *   THROW immediately if invoked at all, so a passing assertion proves the
 *   response came from the committed fixture, never from a live (even fake)
 *   call reaching a real API or database.
 *
 * This is what task 22.4 asks for literally: "Run the data-node suites with
 * `fixtures: 'replay'` against committed fixtures so no test reaches a real
 * API or database."
 */

import { describe, expect, it } from 'vitest';

import type { DataRequest, DataResponse, SqlRequest, SqlResult } from './data-host.js';
import type { ResolvedConnection, SqlDriver } from './connections.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import { FakeConnectionStore, MemoryFixtureStore, NEVER_CALLED_MODEL } from './test/fake-host.js';
import {
  DATA_NODE_FIXTURES,
  EXPECTED_HTTP_OUTPUT,
  EXPECTED_SQL_OUTPUT,
  RECORDING_INPUTS,
} from './test/fixtures/data-node-fixtures.js';
import type { HttpRequestNodeData, SqlQueryNodeData, WorkflowGraph, WorkflowNode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-fixture-replay';

/** Seeds a fresh `MemoryFixtureStore` from the COMMITTED fixture data. */
function seededFixtureStore(): MemoryFixtureStore {
  const store = new MemoryFixtureStore();
  for (const [key, value] of Object.entries(DATA_NODE_FIXTURES)) store.seed(key, value);
  return store;
}

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
function marker(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'router',
    category: 'flow',
    icon: 'pi-sliders-h',
    position: { x: 400, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: {},
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/**
 * A `DataFetcher` that throws the moment it is called. Handed to every
 * replay run in this file so a pass proves zero network calls were made —
 * not merely that nobody happened to check.
 */
const NEVER_CALLED_FETCHER = async (request: DataRequest): Promise<DataResponse> => {
  throw new Error(
    `No live HTTP call is expected in a fixture replay. Received a request to ${request.url}.`,
  );
};

/**
 * A `SqlHost` that throws the moment `query()` is called. `supports()` still
 * answers truthfully (a real host would too), so the driver-support guard
 * that runs BEFORE the fixture read is exercised honestly.
 */
class NeverCalledSqlHost {
  supports(_driver: SqlDriver): boolean {
    return true;
  }

  async query(request: SqlRequest): Promise<SqlResult> {
    throw new Error(
      `No live SQL call is expected in a fixture replay. Received: ${request.statement}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// http-request replay (16.5, 16.9, 16.10)
// ─────────────────────────────────────────────────────────────────────────────

function httpGraph(): WorkflowGraph {
  const httpNode: WorkflowNode = {
    id: RECORDING_INPUTS.http.nodeId,
    name: 'Fetch orders',
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 200, y: 0 },
    ports: [
      port(`${RECORDING_INPUTS.http.nodeId}-in-1`, 'message-in'),
      port(`${RECORDING_INPUTS.http.nodeId}-out-1`, 'message-out'),
    ],
    data: {
      method: RECORDING_INPUTS.http.method,
      url: RECORDING_INPUTS.http.url,
      resultKey: RECORDING_INPUTS.http.resultKey,
      fixtures: 'replay',
    } as HttpRequestNodeData,
  };
  return {
    nodes: [trigger(), httpNode, marker('done')],
    connections: [
      connect('c1', 'trigger-out-1', `${RECORDING_INPUTS.http.nodeId}-in-1`),
      connect('c2', `${RECORDING_INPUTS.http.nodeId}-out-1`, 'done-in-1'),
    ],
  };
}

describe('fixture replay: http-request against committed fixtures (16.5, 16.9)', () => {
  it('serves the recorded response with zero DataFetcher calls', async () => {
    const store = seededFixtureStore();
    const events: RunEvent[] = [];
    const handle = startRun({
      runId: RUN_ID,
      graph: httpGraph(),
      input: RECORDING_INPUTS.http.payload,
      workflowId: RECORDING_INPUTS.workflowId,
      model: NEVER_CALLED_MODEL,
      emit: event => events.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      // Would throw synchronously on any call; never invoked in a true replay.
      dataFetch: NEVER_CALLED_FETCHER,
      fixtures: store,
    });
    await handle.done;

    expect(eventsOf(events, 'run-failed')).toEqual([]);
    const completed = eventsOf(events, 'node-completed').find(
      event => event.nodeId === RECORDING_INPUTS.http.nodeId,
    );
    expect(completed?.output).toBe(EXPECTED_HTTP_OUTPUT);

    // Honest about itself: durationMs 0 and replayed true (Requirement 16.9).
    const response = eventsOf(events, 'http-response')[0];
    expect(response).toBeDefined();
    expect(response!.durationMs).toBe(0);
    expect(response!.replayed).toBe(true);
    expect(response!.status).toBe(200);

    // Same event TYPES, same order, as a live call would have produced.
    expect(
      events
        .filter(event => event.type === 'http-request' || event.type === 'http-response')
        .map(event => event.type),
    ).toEqual(['http-request', 'http-response']);

    // The committed store was read from, never written to (replay never
    // records) and never mutated (Requirement 16.10 — fixtures persist
    // independent of what a run does with them).
    expect(store.writes).toBe(0);
    expect(store.reads).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sql-query replay (16.5, 16.9, 16.10)
// ─────────────────────────────────────────────────────────────────────────────

function sqlGraph(): WorkflowGraph {
  const sqlNode: WorkflowNode = {
    id: RECORDING_INPUTS.sql.nodeId,
    name: 'Read open orders',
    kind: 'sql-query',
    category: 'flow',
    icon: 'ti ti-database',
    position: { x: 200, y: 0 },
    ports: [
      port(`${RECORDING_INPUTS.sql.nodeId}-in-1`, 'message-in'),
      port(`${RECORDING_INPUTS.sql.nodeId}-out-1`, 'message-out'),
    ],
    data: {
      connectionId: RECORDING_INPUTS.sql.connectionId,
      statement: RECORDING_INPUTS.sql.statement,
      params: [{ name: 'status', expression: '$.status' }],
      fixtures: 'replay',
    } as SqlQueryNodeData,
  };
  return {
    nodes: [trigger(), sqlNode, marker('done')],
    connections: [
      connect('c1', 'trigger-out-1', `${RECORDING_INPUTS.sql.nodeId}-in-1`),
      connect('c2', `${RECORDING_INPUTS.sql.nodeId}-out-1`, 'done-in-1'),
    ],
  };
}

function connectionStore(): FakeConnectionStore {
  const store = new FakeConnectionStore();
  const seeded: ResolvedConnection = {
    id: RECORDING_INPUTS.sql.connectionId,
    type: 'sql',
    config: { driver: 'postgres' },
    secrets: {},
    auth: { mode: 'none' },
    allowWrites: false,
  };
  store.seed(seeded);
  return store;
}

describe('fixture replay: sql-query against committed fixtures (16.5, 16.9)', () => {
  it('serves the recorded result with zero SqlHost.query calls', async () => {
    const store = seededFixtureStore();
    const events: RunEvent[] = [];
    const handle = startRun({
      runId: RUN_ID,
      graph: sqlGraph(),
      input: RECORDING_INPUTS.sql.payload,
      workflowId: RECORDING_INPUTS.workflowId,
      model: NEVER_CALLED_MODEL,
      emit: event => events.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      connections: connectionStore(),
      // Would throw synchronously on any call; never invoked in a true replay.
      sql: new NeverCalledSqlHost(),
      fixtures: store,
    });
    await handle.done;

    expect(eventsOf(events, 'run-failed')).toEqual([]);
    const completed = eventsOf(events, 'node-completed').find(
      event => event.nodeId === RECORDING_INPUTS.sql.nodeId,
    );
    expect(completed?.output).toBe(EXPECTED_SQL_OUTPUT);

    // Honest about itself: durationMs 0 and replayed true (Requirement 16.9).
    const result = eventsOf(events, 'sql-result')[0];
    expect(result).toBeDefined();
    expect(result!.durationMs).toBe(0);
    expect(result!.replayed).toBe(true);
    expect(result!.rowCount).toBe(1);

    expect(
      events
        .filter(event => event.type === 'sql-query' || event.type === 'sql-result')
        .map(event => event.type),
    ).toEqual(['sql-query', 'sql-result']);

    expect(store.writes).toBe(0);
    expect(store.reads).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A missing fixture still fails loudly against the committed store (16.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture replay: a request not present in the committed data misses honestly (16.6)', () => {
  it('fails the node instead of silently falling through to a live call', async () => {
    const store = seededFixtureStore();
    const graph = httpGraph();
    // A different input payload changes the fixture key (Requirement 16.2),
    // so this run addresses a key the committed data does not contain.
    const events: RunEvent[] = [];
    const handle = startRun({
      runId: RUN_ID,
      graph,
      input: '{"tenant":"someone-else"}',
      workflowId: RECORDING_INPUTS.workflowId,
      model: NEVER_CALLED_MODEL,
      emit: event => events.push(event),
      requestApproval: async () => true,
      requestInput: async () => '',
      dataFetch: NEVER_CALLED_FETCHER,
      fixtures: store,
    });
    await handle.done;

    expect(eventsOf(events, 'run-completed')).toEqual([]);
    const failed = eventsOf(events, 'node-failed').find(
      event => event.nodeId === RECORDING_INPUTS.http.nodeId,
    );
    expect(failed?.error).toMatch(/no recorded fixture/);
    expect(failed?.error).toMatch(/record/);
    // The store was consulted (a miss), never written — a replay miss never
    // mutates the committed data (Requirement 16.6).
    expect(store.writes).toBe(0);
  });
});
