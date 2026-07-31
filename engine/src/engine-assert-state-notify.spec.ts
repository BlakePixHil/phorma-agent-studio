/**
 * Table-driven unit tests for the `assert`, `state-get`/`state-set` and
 * `notify` executors as the engine actually runs them (design §5.6, §5.7,
 * §5.8), complementing the property suites (`engine-assert-property.spec.ts`,
 * `engine-notify.spec.ts`) with the specific example cases the design calls
 * out: warn-severity breaches that keep the write path open, an unwired
 * `route` breach falling back to failing the node, an absent state store
 * failing every state-touching node, the `delta` and `watermark` change
 * decisions, and `notify` channel validation.
 *
 * Every case drives the real `startRun` over a small graph — nothing here
 * mocks the executor itself, only the host capabilities it is handed.
 *
 * **Validates: Requirements 7.6, 7.7, 12.4, 12.6, 12.8, 13.9**
 */

import { describe, expect, it } from 'vitest';

import type { ConnectionStore, DataFetcher, DataRequest, DataResponse } from './data-host.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import { scopedStateKey } from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import type {
  AssertNodeData,
  NotifyNodeData,
  StateGetNodeData,
  StateSetNodeData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared harness
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-1';

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
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out-1', 'message-out')],
    data: {},
  };
}

/** A pass-through data node used as a downstream marker: reachability proxy. */
function marker(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'transform',
    category: 'data',
    icon: 'pi-sliders-h',
    position: { x: 600, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: { passthrough: true, fields: [{ target: 'seen', expression: 'true' }] },
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
  readonly failure: string | undefined;
  readonly started: string[];
}

async function run(
  graph: WorkflowGraph,
  input: string,
  extra: Parameters<typeof startRun>[0] extends infer T
    ? Partial<T>
    : never = {},
): Promise<RunResult> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph,
    input,
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: (event) => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    ...extra,
  });
  await handle.done;

  const targetId = graph.nodes.find((n) => n.kind !== 'manual-trigger' && n.kind !== 'transform')?.id;
  return {
    events,
    output: targetId
      ? eventsOf(events, 'node-completed').find((e) => e.nodeId === targetId)?.output
      : undefined,
    failure: targetId
      ? eventsOf(events, 'node-failed').find((e) => e.nodeId === targetId)?.error
      : undefined,
    started: eventsOf(events, 'node-started').map((e) => e.nodeId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assert: warn-severity breaches, route-without-wiring fallback, absent state
// ─────────────────────────────────────────────────────────────────────────────

const PASS_PORT = 'assert-1-out-pass';
const FAIL_PORT = 'assert-1-out-fail';

function assertNode(data: AssertNodeData): WorkflowNode {
  return {
    id: 'assert-1',
    name: 'Guard',
    kind: 'assert',
    category: 'data',
    icon: 'ti ti-shield-check',
    position: { x: 300, y: 0 },
    ports: [
      port('assert-1-in-1', 'message-in', 'In'),
      port(PASS_PORT, 'message-out', 'Passed'),
      port(FAIL_PORT, 'message-out', 'Failed'),
    ],
    data,
  };
}

function assertGraph(data: AssertNodeData, wireFailed: boolean): WorkflowGraph {
  const nodes = [trigger(), assertNode(data), marker('pass-1')];
  const connections = [
    connect('c1', 'trigger-out-1', 'assert-1-in-1'),
    connect('c2', PASS_PORT, 'pass-1-in-1'),
  ];
  if (wireFailed) {
    nodes.push(marker('caught'));
    connections.push(connect('c3', FAIL_PORT, 'caught-in-1'));
  }
  return { nodes, connections };
}

describe('assert: warn-severity breaches (Requirement 7.7)', () => {
  it.each([
    ['a single warn guard breaching alone', [{ name: 'g1', expression: 'false', severity: 'warn' as const }]],
    [
      'a warn breach alongside a holding error guard',
      [
        { name: 'g1', expression: 'true', severity: 'error' as const },
        { name: 'g2', expression: 'null', severity: 'warn' as const },
      ],
    ],
  ])('%s: passes through, routes Passed only, reports the breach unrouted', async (_label, assertions) => {
    const result = await run(assertGraph({ assertions }, false), '{"n":1}');

    expect(result.failure).toBeUndefined();
    expect(result.output).toBe('{"n":1}');
    expect(result.started).toContain('pass-1');

    const breached = eventsOf(result.events, 'assert-breached');
    expect(breached).toHaveLength(1);
    expect(breached[0]).toMatchObject({ severity: 'warn', routed: false });
    expect(eventsOf(result.events, 'assert-passed')).toHaveLength(1);
  });
});

describe('assert: route-without-wiring falls back to failing the node (Requirement 7.6)', () => {
  it.each([
    ['failedPortId absent', undefined],
    ['failedPortId names an unwired port', FAIL_PORT],
    ['failedPortId names a port that does not exist', 'no-such-port'],
  ])('%s: fails the node instead of dropping the breach silently', async (_label, failedPortId) => {
    const assertions = [{ name: 'g1', expression: 'false', severity: 'error' as const }];
    const data: AssertNodeData = {
      assertions,
      onBreach: 'route',
      ...(failedPortId === undefined ? {} : { failedPortId }),
    };
    // Never wire the Failed port in this graph, so "names a port wired to no
    // edge" and "no failedPortId at all" are both exercised the same way.
    const result = await run(assertGraph(data, false), '{}');

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('g1');
    expect(result.started).toEqual(['trigger', 'assert-1']);
    expect(result.output).toBeUndefined();
    expect(eventsOf(result.events, 'assert-breached')[0]).toMatchObject({ routed: false });
  });

  it('does route when failedPortId names a port that IS wired', async () => {
    const assertions = [{ name: 'g1', expression: 'false', severity: 'error' as const }];
    const data: AssertNodeData = { assertions, onBreach: 'route', failedPortId: FAIL_PORT };
    const result = await run(assertGraph(data, true), '{}');

    expect(result.failure).toBeUndefined();
    expect(result.started).toContain('caught');
    expect(result.started).not.toContain('pass-1');
    expect(eventsOf(result.events, 'assert-breached')[0]).toMatchObject({ routed: true });
  });
});

describe('assert: absent RunOptions.state fails the node when baselineStateKey is set (Requirement 12.4)', () => {
  it('fails before evaluating any assertion and appends no guard entry', async () => {
    const assertions = [{ name: 'g1', expression: 'true' as const }];
    const data: AssertNodeData = { assertions, baselineStateKey: 'baseline:{{id}}' };
    const result = await run(assertGraph(data, false), '{"id":"x"}');

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('state');
    expect(result.started).toEqual(['trigger', 'assert-1']);
    expect(eventsOf(result.events, 'assert-passed')).toHaveLength(0);
    expect(eventsOf(result.events, 'assert-breached')).toHaveLength(0);
    expect(eventsOf(result.events, 'sync-summary')[0]?.summary.guards).toBeUndefined();
  });

  it('succeeds and exposes baseline when state IS supplied', async () => {
    const store = new MemoryStateStore();
    const key = scopedStateKey(WORKFLOW_ID, 'baseline:x');
    await store.set(key, JSON.stringify(42));

    const assertions = [{ name: 'g1', expression: 'baseline == 42' }];
    const data: AssertNodeData = { assertions, baselineStateKey: 'baseline:{{id}}' };
    const result = await run(assertGraph(data, false), '{"id":"x"}', { state: store });

    expect(result.failure).toBeUndefined();
    expect(result.output).toBe('{"id":"x"}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State: absent-store failures, delta and watermark change decisions
// ─────────────────────────────────────────────────────────────────────────────

function stateGetNode(data: StateGetNodeData): WorkflowNode {
  return {
    id: 'get-1',
    name: 'Read',
    kind: 'state-get',
    category: 'data',
    icon: 'ti ti-bookmark',
    position: { x: 300, y: 0 },
    ports: [port('get-1-in-1', 'message-in', 'In'), port('get-1-out-1', 'message-out', 'Out')],
    data,
  };
}

function stateSetNode(data: StateSetNodeData): WorkflowNode {
  return {
    id: 'set-1',
    name: 'Write',
    kind: 'state-set',
    category: 'data',
    icon: 'ti ti-bookmark-plus',
    position: { x: 300, y: 0 },
    ports: [port('set-1-in-1', 'message-in', 'In'), port('set-1-out-1', 'message-out', 'Out')],
    data,
  };
}

function singleNodeGraph(node: WorkflowNode): WorkflowGraph {
  return {
    nodes: [trigger(), node],
    connections: [connect('c1', 'trigger-out-1', `${node.id}-in-1`)],
  };
}

describe('state: absent RunOptions.state fails the node (Requirement 12.4)', () => {
  it('fails state-get before any read, with no state-read event', async () => {
    const result = await run(singleNodeGraph(stateGetNode({ key: 'k' })), '{}');

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('state');
    expect(eventsOf(result.events, 'state-read')).toHaveLength(0);
  });

  it('fails state-set before any write, with no state-written event', async () => {
    const result = await run(
      singleNodeGraph(stateSetNode({ key: 'k', valueExpression: '1' })),
      '{}',
    );

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('state');
    expect(eventsOf(result.events, 'state-written')).toHaveLength(0);
  });
});

describe('state-get: value/default resolution (Requirement 12.5)', () => {
  it('merges the stored value under resultKey, JSON-parsed', async () => {
    const store = new MemoryStateStore();
    await store.set(scopedStateKey(WORKFLOW_ID, 'k'), JSON.stringify({ rows: 5 }));
    const result = await run(
      singleNodeGraph(stateGetNode({ key: 'k', resultKey: 'found' })),
      '{}',
      { state: store },
    );

    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.output ?? '{}')).toEqual({ found: { rows: 5 } });
    expect(eventsOf(result.events, 'state-read')[0]).toMatchObject({ found: true });
  });

  it('falls back to defaultValue when the key is absent', async () => {
    const store = new MemoryStateStore();
    const result = await run(
      singleNodeGraph(stateGetNode({ key: 'missing', defaultValue: 'fallback' })),
      '{}',
      { state: store },
    );

    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.output ?? '{}')).toEqual({ state: 'fallback' });
    expect(eventsOf(result.events, 'state-read')[0]).toMatchObject({ found: false });
  });

  it('falls back to null when the key is absent and no defaultValue is declared', async () => {
    const store = new MemoryStateStore();
    const result = await run(singleNodeGraph(stateGetNode({ key: 'missing' })), '{}', {
      state: store,
    });

    expect(JSON.parse(result.output ?? '{}')).toEqual({ state: null });
  });
});

describe('state-set: delta semantics change decision (Requirement 12.6, 12.8)', () => {
  it.each([
    ['no previous value: changed = true', undefined, '1', true],
    ['identical previous value: changed = false', '1', '1', false],
    ['a differing previous value: changed = true', '1', '2', true],
  ])('%s', async (_label, previous, next, expectedChanged) => {
    const store = new MemoryStateStore();
    const key = scopedStateKey(WORKFLOW_ID, 'delta:item');
    if (previous !== undefined) {
      const { contentHash } = await import('./state.js');
      await store.set(key, contentHash(JSON.parse(previous)));
    }

    const result = await run(
      singleNodeGraph(
        stateSetNode({ key: 'delta:item', valueExpression: next, semantics: 'delta' }),
      ),
      '{}',
      { state: store },
    );

    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.output ?? '{}')).toEqual({ stateChanged: expectedChanged });
    const written = eventsOf(result.events, 'state-written')[0];
    expect(written).toMatchObject({ semantics: 'delta', changed: expectedChanged });
  });

  it('writes the hash only when changed is true, leaving an unchanged key untouched', async () => {
    const store = new MemoryStateStore();
    const key = scopedStateKey(WORKFLOW_ID, 'delta:item');
    const { contentHash } = await import('./state.js');
    const hash = contentHash(1);
    await store.set(key, hash);

    await run(
      singleNodeGraph(stateSetNode({ key: 'delta:item', valueExpression: '1', semantics: 'delta' })),
      '{}',
      { state: store },
    );

    // Unchanged: still the original hash, not re-written to itself-as-a-noop.
    expect((await store.get(key))?.value).toBe(hash);
  });
});

describe('state-set: watermark semantics change decision (Requirement 12.8)', () => {
  it.each([
    ['no previous watermark: changed = true, value stored', undefined, '"5"', true, '5'],
    ['new value orders above stored: changed = true, value advances', '5', '"10"', true, '10'],
    ['new value orders at or below stored: changed = false, value unchanged', '10', '"5"', false, '10'],
    ['new value ties the stored value: changed = false', '5', '"5"', false, '5'],
  ])('%s', async (_label, previous, valueExpression, expectedChanged, expectedStored) => {
    const store = new MemoryStateStore();
    const key = scopedStateKey(WORKFLOW_ID, 'wm:jobs');
    if (previous !== undefined) await store.set(key, previous);

    const result = await run(
      singleNodeGraph(
        stateSetNode({ key: 'wm:jobs', valueExpression, semantics: 'watermark' }),
      ),
      '{}',
      { state: store },
    );

    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.output ?? '{}')).toEqual({ stateChanged: expectedChanged });
    expect(eventsOf(result.events, 'state-written')[0]).toMatchObject({
      semantics: 'watermark',
      changed: expectedChanged,
    });
    expect((await store.get(key))?.value).toBe(expectedStored);
  });

  it('fails the node instead of storing a value with no meaningful order', async () => {
    const store = new MemoryStateStore();
    const result = await run(
      singleNodeGraph(
        stateSetNode({ key: 'wm:jobs', valueExpression: 'null', semantics: 'watermark' }),
      ),
      '{}',
      { state: store },
    );

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('watermark');
    expect(eventsOf(result.events, 'state-written')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notify: channel validation
// ─────────────────────────────────────────────────────────────────────────────

type ScriptStep = Partial<DataResponse> | Error;

function scripted(script: readonly ScriptStep[]): { fetch: DataFetcher; requests: DataRequest[] } {
  const requests: DataRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: async (request: DataRequest): Promise<DataResponse> => {
      requests.push(request);
      const step = script[index++];
      if (step === undefined) throw new Error(`Unscripted request ${index} to ${request.url}.`);
      if (step instanceof Error) throw step;
      return { status: 200, headers: {}, body: '', byteCount: 0, durationMs: 3, ...step };
    },
  };
}

function notifyNode(data: Partial<NotifyNodeData>): WorkflowNode {
  return {
    id: 'notify-1',
    name: 'Alert',
    kind: 'notify',
    category: 'flow',
    icon: 'ti ti-bell',
    position: { x: 300, y: 0 },
    ports: [
      port('notify-1-in-1', 'message-in'),
      port('notify-1-out-1', 'message-out'),
      port('notify-1-err-1', 'message-out'),
    ],
    data: { channel: 'webhook', ...data } as NotifyNodeData,
  };
}

describe('notify: channel validation (Requirement 13.9)', () => {
  it.each([
    ['absent channel', undefined],
    ['empty channel', ''],
    ['an unsupported channel', 'sms'],
    ['a channel with only whitespace', '   '],
  ])('%s: fails before any request and emits no notify-sent', async (_label, channel) => {
    const fetcher = scripted([]);
    const result = await run(
      singleNodeGraph(notifyNode({ channel: channel as NotifyNodeData['channel'], to: 'https://hooks.test/hook' })),
      '{}',
      { dataFetch: fetcher.fetch },
    );

    expect(result.failure).toBeDefined();
    expect(result.failure).toContain('notification channel');
    expect(fetcher.requests).toHaveLength(0);
    expect(eventsOf(result.events, 'notify-sent')).toHaveLength(0);
  });

  it.each(['email', 'webhook', 'chat-webhook'] as const)(
    'accepts the valid channel %s (rejecting only for other reasons downstream)',
    async (channel) => {
      const fetcher = scripted([{ status: 200 }]);
      const connections: ConnectionStore = {
        resolve: async () => ({
          id: 'conn-1',
          type: 'http',
          config: { baseUrl: 'https://provider.test' },
          secrets: {},
          auth: { mode: 'none' },
          allowWrites: true,
        }),
        list: async () => [],
      };
      const result = await run(
        singleNodeGraph(
          notifyNode(
            channel === 'email'
              ? { channel, connectionId: 'conn-1', to: 'ops@example.com' }
              : { channel, to: 'https://hooks.test/hook' },
          ),
        ),
        '{}',
        { dataFetch: fetcher.fetch, connections },
      );

      expect(result.failure).toBeUndefined();
      expect(eventsOf(result.events, 'notify-sent')).toHaveLength(1);
    },
  );

  it('rejects an email channel with no connectionId before any request', async () => {
    const fetcher = scripted([]);
    const result = await run(
      singleNodeGraph(notifyNode({ channel: 'email', to: 'ops@example.com' })),
      '{}',
      { dataFetch: fetcher.fetch },
    );

    expect(result.failure).toContain('no connection selected');
    expect(fetcher.requests).toHaveLength(0);
    expect(eventsOf(result.events, 'notify-sent')).toHaveLength(0);
  });

  it('rejects an email channel whose recipient renders empty before any request', async () => {
    const fetcher = scripted([]);
    const connections: ConnectionStore = {
      resolve: async () => ({
        id: 'conn-1',
        type: 'http',
        config: { baseUrl: 'https://provider.test' },
        secrets: {},
        auth: { mode: 'none' },
        allowWrites: true,
      }),
      list: async () => [],
    };
    const result = await run(
      singleNodeGraph(notifyNode({ channel: 'email', connectionId: 'conn-1', to: '   ' })),
      '{}',
      { dataFetch: fetcher.fetch, connections },
    );

    expect(result.failure).toContain('recipient rendered empty');
    expect(fetcher.requests).toHaveLength(0);
  });
});
