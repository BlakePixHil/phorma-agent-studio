/**
 * Contract tests for the eleven data-path run events (Requirements 14.1-14.3).
 *
 * Every assertion here runs against events the engine ACTUALLY EMITTED from a
 * real `startRun` over a graph that exercises the whole deterministic data
 * path: a paginated http fetch, a sql query, a state read and write, a guard,
 * and a notification. Nothing is asserted against a literal declared in this
 * file.
 *
 * That distinction is the point. The previous version of this suite declared
 * eleven `RunEvent` literals and compared them to a list of eleven type names
 * it also declared, under a header claiming the union was "checked at compile
 * time" - `vitest.config.ts` sets no `typecheck`, so nothing checked it. The
 * whole file executed zero lines of production code: renaming `notify-sent` in
 * `events.ts` left it green.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 */

import { describe, expect, it } from 'vitest';

import type { ResolvedConnection } from './connections.js';
import type {
  ConnectionStore,
  DataFetcher,
  DataRequest,
  DataResponse,
  SqlHost,
  SqlRequest,
  SqlResult,
} from './data-host.js';
import { DataTransportError } from './data-host.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import { scopedStateKey } from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import type {
  AssertNodeData,
  HttpRequestNodeData,
  NotifyNodeData,
  StateGetNodeData,
  StateSetNodeData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// The contract under test
// ─────────────────────────────────────────────────────────────────────────────

/** The eleven event types the deterministic data path adds (14.1). */
const DATA_PATH_EVENT_TYPES = [
  'http-request',
  'http-response',
  'page-fetched',
  'sql-query',
  'sql-result',
  'state-read',
  'state-written',
  'assert-passed',
  'assert-breached',
  'notify-sent',
  'sync-summary',
] as const;

/**
 * Members that must never appear on a run event (14.2). Headers carry auth,
 * parameter values carry customer data, and a run event stream is persisted to
 * the run record and relayed over the portal WebSocket.
 */
const FORBIDDEN_MEMBERS = [
  'headers',
  'requestHeaders',
  'responseHeaders',
  'params',
  'parameters',
  'parameterValues',
  'secret',
  'secrets',
  'auth',
  'token',
] as const;

/** Values the hosts hold that must never reach the event stream. */
const SQL_PASSWORD = 'sup3r-secret-sql-password';
const BEARER_TOKEN = 'tok-live-must-never-be-emitted';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-events';
const WORKFLOW_ID = 'wf-events';
const CONNECTION_ID = 'conn-events';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

function port(id: string, role: 'message-in' | 'message-out', name = id) {
  return { id, name, role };
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
    icon: 'ti ti-player-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out-1', 'message-out')],
    data: {},
  };
}

function node(
  id: string,
  kind: string,
  data: object,
  extraPorts: ReturnType<typeof port>[] = [],
): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    category: 'data',
    icon: 'ti ti-square',
    position: { x: 0, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out'), ...extraPorts],
    data,
  };
}

/** Chains nodes trigger -> a -> b -> ... through their default in/out ports. */
function chain(nodes: readonly WorkflowNode[]): WorkflowGraph {
  const all = [trigger(), ...nodes];
  const connections = all.slice(0, -1).map((from, index) => {
    const to = all[index + 1]!;
    const outputId = from.kind === 'manual-trigger' ? 'trigger-out-1' : `${from.id}-out-1`;
    return connect(`c${index}`, outputId, `${to.id}-in-1`);
  });
  return { nodes: all, connections };
}

/** A fetcher answering from `script` in order; an unscripted call fails the run. */
function scripted(script: readonly (Partial<DataResponse> | Error)[]): {
  fetch: DataFetcher;
  requests: DataRequest[];
} {
  const requests: DataRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: async (request: DataRequest): Promise<DataResponse> => {
      requests.push(request);
      const step = script[index++];
      if (step === undefined) throw new Error(`Unscripted request ${index} to ${request.url}.`);
      if (step instanceof Error) throw step;
      return { status: 200, headers: {}, body: '', byteCount: 0, durationMs: 4, ...step };
    },
  };
}

function jsonBody(value: unknown, over: Partial<DataResponse> = {}): Partial<DataResponse> {
  const body = JSON.stringify(value);
  return { status: 200, headers: {}, body, byteCount: body.length, durationMs: 5, ...over };
}

class RecordingSqlHost implements SqlHost {
  readonly requests: SqlRequest[] = [];
  supports(): boolean {
    return true;
  }
  async query(request: SqlRequest): Promise<SqlResult> {
    this.requests.push(request);
    return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2, durationMs: 3 };
  }
}

/**
 * A connection carrying BOTH a sql password and a bearer token, so the
 * no-secret assertions have something real to find if the engine ever starts
 * echoing resolved connection material into an event.
 */
function connectionStore(): ConnectionStore {
  return {
    resolve: async (connectionId: string): Promise<ResolvedConnection> => ({
      id: connectionId,
      type: 'sql',
      config: { driver: 'postgres', baseUrl: 'https://api.example.com' },
      secrets: { password: SQL_PASSWORD, token: BEARER_TOKEN },
      auth: { mode: 'bearer', secretKey: 'token' },
      allowWrites: false,
    }),
  };
}

interface Scenario {
  readonly events: RunEvent[];
  readonly requests: DataRequest[];
}

async function runGraph(
  graph: WorkflowGraph,
  fetcher: ReturnType<typeof scripted>,
  extra: Record<string, unknown> = {},
): Promise<Scenario> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph,
    input: '{"id":"acme","cursor":"2026-01-01"}',
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: (event) => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    dataFetch: fetcher.fetch,
    sql: new RecordingSqlHost(),
    connections: connectionStore(),
    state: new MemoryStateStore(),
    ...extra,
  });
  await handle.done;
  return { events, requests: fetcher.requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node builders for the full data-path graph
// ─────────────────────────────────────────────────────────────────────────────

function httpNode(over: Partial<HttpRequestNodeData> = {}): WorkflowNode {
  const data: HttpRequestNodeData = {
    connectionId: CONNECTION_ID,
    method: 'GET',
    url: '/things',
    resultKey: 'fetched',
    pagination: {
      mode: 'cursor',
      cursorPath: 'next',
      cursorParam: 'cursor',
      itemsPath: 'items',
      maxPages: 5,
    },
    ...over,
  } as HttpRequestNodeData;
  return node('http-1', 'http-request', data);
}

function sqlNode(): WorkflowNode {
  return node('sql-1', 'sql-query', {
    connectionId: CONNECTION_ID,
    driver: 'postgres',
    statement: 'select id from orders where tenant = :tenant',
    params: [{ name: 'tenant', expression: "'acme'" }],
    resultKey: 'rows',
  });
}

/** Literal key: what the event must show is the SCOPED form of exactly this. */
const STATE_KEY = 'cursor:acme';

function stateGetNode(): WorkflowNode {
  return node('get-1', 'state-get', { key: STATE_KEY, resultKey: 'saved' } as StateGetNodeData);
}

function stateSetNode(): WorkflowNode {
  return node('set-1', 'state-set', {
    key: STATE_KEY,
    valueExpression: "'2026-02-01'",
    semantics: 'watermark',
  } as StateSetNodeData);
}

function assertNode(expression: string, severity: 'error' | 'warn'): WorkflowNode {
  return node('assert-1', 'assert', {
    assertions: [{ name: 'rows present', expression, severity }],
  } as AssertNodeData);
}

function notifyNode(): WorkflowNode {
  return node('notify-1', 'notify', {
    channel: 'webhook',
    to: 'https://hooks.example.com/incoming',
    body: 'Sync finished for {{id}}.',
  } as NotifyNodeData);
}

/** Two pages then the notify POST: the exact call sequence the graph makes. */
function fullPathScript() {
  return scripted([
    jsonBody({ items: [{ id: 1 }], next: 'cursor-2' }),
    jsonBody({ items: [{ id: 2 }] }),
    { status: 200 },
  ]);
}

/**
 * The whole data path in one run. A passing guard yields `assert-passed`; the
 * companion run below breaches to yield `assert-breached`.
 */
function fullPathGraph(assertExpression: string, severity: 'error' | 'warn'): WorkflowGraph {
  return chain([
    httpNode(),
    sqlNode(),
    stateGetNode(),
    stateSetNode(),
    assertNode(assertExpression, severity),
    notifyNode(),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('data-path run events (14.1)', () => {
  it('emits every one of the eleven types from a real run of the data path', async () => {
    // A passing guard and a warn breach: warn keeps the run going, so both
    // assert events are reachable and every other type is emitted twice.
    const passing = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const breaching = await runGraph(fullPathGraph('false', 'warn'), fullPathScript());
    const emitted = new Set([...passing.events, ...breaching.events].map((event) => event.type));

    // Names come from the engine's own output, so renaming a variant in
    // `events.ts` without updating its emitter fails here.
    for (const type of DATA_PATH_EVENT_TYPES) {
      expect(emitted, `no ${type} event was emitted`).toContain(type);
    }
    expect(passing.events.filter((e) => e.type === 'assert-passed')).toHaveLength(1);
    expect(breaching.events.filter((e) => e.type === 'assert-breached')).toHaveLength(1);
  });

  it('carries the run id, the node id and a timestamp on every data-path event', async () => {
    const { events } = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const dataPath = events.filter((event) =>
      (DATA_PATH_EVENT_TYPES as readonly string[]).includes(event.type),
    );
    expect(dataPath.length).toBeGreaterThanOrEqual(DATA_PATH_EVENT_TYPES.length);

    for (const event of dataPath) {
      expect(event.runId, event.type).toBe(RUN_ID);
      expect(typeof (event as { at?: unknown }).at, event.type).toBe('number');
      // `sync-summary` is run-scoped; every other data-path event names its node.
      expect('nodeId' in event, event.type).toBe(event.type !== 'sync-summary');
    }
  });

  it('walks the pages it was given and reports each one', async () => {
    const { events, requests } = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const pages = events.filter(
      (event): event is Extract<RunEvent, { type: 'page-fetched' }> => event.type === 'page-fetched',
    );

    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages.map((page) => page.items)).toEqual([1, 1]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
    // Two fetches for the pages plus one for the notification.
    expect(requests).toHaveLength(3);
  });

  it('reports the sql statement and its row count without parameter values', async () => {
    const { events } = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const query = events.find((e) => e.type === 'sql-query');
    const result = events.find((e) => e.type === 'sql-result');

    expect(query).toMatchObject({
      driver: 'postgres',
      statement: 'select id from orders where tenant = :tenant',
      paramCount: 1,
    });
    // The named placeholder survives; the bound value never appears.
    expect(JSON.stringify(query)).not.toContain('acme');
    expect(result).toMatchObject({ rowCount: 2 });
  });

  it('reports the workflow-scoped state key it read and the semantics it wrote under', async () => {
    const { events } = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const read = events.find((e) => e.type === 'state-read');
    const written = events.find((e) => e.type === 'state-written');

    // The event must show the SCOPED key, not the raw node template: an
    // unscoped key in the trace would mean cross-workflow state collision.
    const scoped = scopedStateKey(WORKFLOW_ID, STATE_KEY);
    expect(scoped).toContain(WORKFLOW_ID);
    expect(read).toMatchObject({ key: scoped, found: false });
    // A watermark is a cursor, not a payload: the new high-water mark is part
    // of the contract so the trace can show what a sync advanced to.
    expect(written).toMatchObject({
      key: scoped,
      semantics: 'watermark',
      changed: true,
      to: '2026-02-01',
    });
  });
});

describe('data-path run events carry no secret-bearing members (14.2)', () => {
  it('declares no header, parameter-value or secret member on any emitted event', async () => {
    const passing = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const breaching = await runGraph(fullPathGraph('false', 'warn'), fullPathScript());

    for (const event of [...passing.events, ...breaching.events]) {
      for (const key of Object.keys(event)) {
        expect(FORBIDDEN_MEMBERS, `${event.type}.${key}`).not.toContain(key);
      }
    }
  });

  it('never emits the resolved connection password or bearer token', async () => {
    const { events } = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain(SQL_PASSWORD);
    expect(serialized).not.toContain(BEARER_TOKEN);
  });

  it('leaves request and response bodies absent unless the node opts in', async () => {
    const withoutCapture = await runGraph(fullPathGraph('true', 'error'), fullPathScript());
    const request = withoutCapture.events.find((e) => e.type === 'http-request');
    const response = withoutCapture.events.find((e) => e.type === 'http-response');

    expect(request).toBeDefined();
    expect((request as { body?: string }).body).toBeUndefined();
    expect((response as { body?: string }).body).toBeUndefined();
  });

  it('includes the response body only when persistResponseBody is set', async () => {
    const graph = chain([httpNode({ persistResponseBody: true })]);
    const { events } = await runGraph(
      graph,
      scripted([jsonBody({ items: [{ id: 1 }], next: 'cursor-2' }), jsonBody({ items: [{ id: 2 }] })]),
    );
    const responses = events.filter(
      (e): e is Extract<RunEvent, { type: 'http-response' }> => e.type === 'http-response',
    );

    expect(responses).not.toHaveLength(0);
    for (const response of responses) expect(response.body).toBeDefined();
  });
});

describe('data-node retries reuse node-retrying (14.3)', () => {
  it('emits node-retrying, not a data-path-specific retry event', async () => {
    // `idempotent` is required: a timeout does not prove the request never
    // landed, so an undeclared step is deliberately NOT retried on one.
    const graph = chain([httpNode({ retry: { maxAttempts: 2, backoffMs: 1, idempotent: true } })]);
    const { events } = await runGraph(
      graph,
      scripted([
        // A transport failure the classifier must treat as retryable, then success.
        new DataTransportError('timeout', 'took too long'),
        jsonBody({ items: [{ id: 1 }] }),
      ]),
    );

    const retries = events.filter(
      (e): e is Extract<RunEvent, { type: 'node-retrying' }> => e.type === 'node-retrying',
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ nodeId: 'http-1', attempt: 1, maxAttempts: 2 });

    // No data-path-specific retry variant may exist alongside it.
    const retryTypes = [...new Set(events.map((e) => e.type))].filter(
      (type) => type.includes('retry') && type !== 'node-retrying',
    );
    expect(retryTypes).toEqual([]);
  });
});
