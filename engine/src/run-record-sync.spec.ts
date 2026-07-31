import { describe, expect, it } from 'vitest';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import {
  accumulateSync,
  createRunRecorder,
  createSyncSummary,
  type SyncSummary,
} from './run-record.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Sync audit record invariants (Requirements 14.6, 14.8, 14.10, 14.11).
 *
 * `accumulateSync` is a pure in-place fold, so every case here is a literal
 * event list folded into a fresh summary. The engine-level cases drive
 * `startRun` over graphs that need no model: a `transform` node counts as a
 * data node the moment it executes, which is exactly what gates the terminal
 * `sync-summary`.
 */

const AT = 1_700_000_000_000;

function deltaWrite(changed: boolean, nodeId = 'set-1'): RunEvent {
  return {
    type: 'state-written',
    runId: 'run-1',
    nodeId,
    key: 'delta:acme',
    semantics: 'delta',
    changed,
    at: AT,
  };
}

function loopCompleted(succeeded: number, failed: number): RunEvent {
  return {
    type: 'loop-completed',
    runId: 'run-1',
    nodeId: 'loop-1',
    total: succeeded + failed,
    succeeded,
    failed,
    at: AT,
  };
}

function httpResponse(status: number): RunEvent {
  return {
    type: 'http-response',
    runId: 'run-1',
    nodeId: 'http-1',
    status,
    durationMs: 12,
    byteCount: 128,
    at: AT,
  };
}

function fold(events: RunEvent[]): SyncSummary {
  const summary = createSyncSummary();
  for (const event of events) accumulateSync(event, summary);
  return summary;
}

/** Every count is a non-negative integer (Requirement 14.8). */
function expectNonNegativeIntegers(summary: SyncSummary): void {
  const counts = [
    summary.considered,
    summary.changed,
    summary.written,
    summary.skipped,
    summary.failed,
    ...Object.values(summary.targetStatuses),
    ...Object.values(summary.sources).flatMap(source => [source.rows, source.pages ?? 0]),
  ];
  for (const value of counts) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

describe('createSyncSummary', () => {
  it('starts every count at zero with no guards and no watermark', () => {
    const summary = createSyncSummary();
    expect(summary).toEqual({
      sources: {},
      considered: 0,
      changed: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      targetStatuses: {},
    });
    expect(summary.guards).toBeUndefined();
    expect(summary.watermark).toBeUndefined();
    expectNonNegativeIntegers(summary);
  });
});

describe('accumulateSync — delta stage counting (Requirements 14.8, 14.11)', () => {
  it('counts each delta write once and keeps considered = changed + skipped', () => {
    const summary = fold([
      deltaWrite(true),
      deltaWrite(false),
      deltaWrite(true),
      deltaWrite(false),
      deltaWrite(false),
    ]);
    expect(summary.changed).toBe(2);
    expect(summary.skipped).toBe(3);
    expect(summary.considered).toBe(summary.changed + summary.skipped);
    expectNonNegativeIntegers(summary);
  });

  it('keeps considered = changed + skipped across several delta nodes', () => {
    const summary = fold([
      deltaWrite(true, 'set-a'),
      deltaWrite(false, 'set-b'),
      deltaWrite(true, 'set-b'),
    ]);
    expect(summary.considered).toBe(3);
    expect(summary.considered).toBe(summary.changed + summary.skipped);
  });

  it('ignores value-semantics writes entirely', () => {
    const summary = fold([
      { type: 'state-written', runId: 'run-1', nodeId: 'set-1', key: 'cursor', semantics: 'value', changed: true, at: AT },
      { type: 'state-written', runId: 'run-1', nodeId: 'set-1', key: 'cursor', semantics: 'value', changed: false, at: AT },
    ]);
    expect(summary).toEqual(createSyncSummary());
  });
});

describe('accumulateSync — watermark (Requirement 14.11)', () => {
  it('records the key and the advanced value, carrying from when present', () => {
    const summary = fold([
      {
        type: 'state-written',
        runId: 'run-1',
        nodeId: 'set-1',
        key: 'invoices.updatedAt',
        semantics: 'watermark',
        changed: true,
        from: '2024-01-01T00:00:00.000Z',
        to: '2024-02-01T00:00:00.000Z',
        at: AT,
      },
    ]);
    expect(summary.watermark).toEqual({
      key: 'invoices.updatedAt',
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-02-01T00:00:00.000Z',
    });
  });

  it('omits from for a first-run watermark and never adds delta counts', () => {
    const summary = fold([
      {
        type: 'state-written',
        runId: 'run-1',
        nodeId: 'set-1',
        key: 'invoices.updatedAt',
        semantics: 'watermark',
        changed: true,
        to: '2024-02-01T00:00:00.000Z',
        at: AT,
      },
    ]);
    expect(summary.watermark).toEqual({ key: 'invoices.updatedAt', to: '2024-02-01T00:00:00.000Z' });
    expect('from' in (summary.watermark ?? {})).toBe(false);
    expect(summary.considered).toBe(0);
    expect(summary.changed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('leaves the watermark absent when the write did not advance it', () => {
    const summary = fold([
      {
        type: 'state-written',
        runId: 'run-1',
        nodeId: 'set-1',
        key: 'invoices.updatedAt',
        semantics: 'watermark',
        changed: false,
        from: '2024-02-01T00:00:00.000Z',
        to: '2024-02-01T00:00:00.000Z',
        at: AT,
      },
    ]);
    expect(summary.watermark).toBeUndefined();
  });

  it('keeps the last advance when a run advances the same watermark twice', () => {
    const summary = fold([
      { type: 'state-written', runId: 'run-1', nodeId: 'set-1', key: 'wm', semantics: 'watermark', changed: true, to: 'a', at: AT },
      { type: 'state-written', runId: 'run-1', nodeId: 'set-1', key: 'wm', semantics: 'watermark', changed: true, from: 'a', to: 'b', at: AT },
    ]);
    expect(summary.watermark).toEqual({ key: 'wm', from: 'a', to: 'b' });
  });
});

describe('accumulateSync — target status counting (Requirement 14.10)', () => {
  it('creates a status entry with one and increments it on repeats', () => {
    const summary = fold([httpResponse(200), httpResponse(200), httpResponse(429)]);
    expect(summary.targetStatuses).toEqual({ '200': 2, '429': 1 });
    expectNonNegativeIntegers(summary);
  });

  it('keys statuses by their string form and counts every response', () => {
    const events = [
      ...Array.from({ length: 98 }, () => httpResponse(200)),
      httpResponse(429),
      httpResponse(500),
    ];
    const summary = fold(events);
    expect(summary.targetStatuses).toEqual({ '200': 98, '429': 1, '500': 1 });
    expect(Object.keys(summary.targetStatuses).every(key => typeof key === 'string')).toBe(true);
  });
});

describe('accumulateSync — write loop counting (Requirement 14.8)', () => {
  it('sums succeeded and failed across loops and keeps written + failed <= considered', () => {
    const summary = fold([
      ...Array.from({ length: 10 }, () => deltaWrite(true)),
      loopCompleted(4, 1),
      loopCompleted(3, 2),
    ]);
    expect(summary.written).toBe(7);
    expect(summary.failed).toBe(3);
    expect(summary.considered).toBe(10);
    expect(summary.written + summary.failed).toBeLessThanOrEqual(summary.considered);
    expectNonNegativeIntegers(summary);
  });

  it('raises considered to written + failed when no delta stage filtered the records', () => {
    // Documented behaviour for a workflow that writes without a delta filter:
    // the write loop is the only evidence of how many records were considered.
    const summary = fold([loopCompleted(8, 2)]);
    expect(summary.considered).toBe(10);
    expect(summary.changed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.written + summary.failed).toBeLessThanOrEqual(summary.considered);
  });

  it('raises considered when a write loop reports more records than the delta stage considered', () => {
    const summary = fold([deltaWrite(true), deltaWrite(false), loopCompleted(5, 1)]);
    expect(summary.considered).toBe(6);
    expect(summary.written + summary.failed).toBeLessThanOrEqual(summary.considered);
  });

  it('coerces non-integer and negative reported counts to non-negative integers', () => {
    const summary = fold([
      loopCompleted(2.7, -3),
      loopCompleted(Number.NaN, Number.POSITIVE_INFINITY),
    ]);
    expect(summary.written).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.considered).toBe(2);
    expectNonNegativeIntegers(summary);
  });

  it('keeps counts non-negative integers for malformed source counts', () => {
    const summary = fold([
      { type: 'sql-result', runId: 'run-1', nodeId: 'sql-1', rowCount: Number.NaN, durationMs: 3, at: AT },
      { type: 'page-fetched', runId: 'run-1', nodeId: 'http-1', page: 1, items: 4.9, hasMore: false, at: AT },
    ]);
    expect(summary.sources['sql-1']).toEqual({ rows: 0 });
    expect(summary.sources['http-1']).toEqual({ rows: 4, pages: 1 });
    expectNonNegativeIntegers(summary);
  });
});

describe('createRunRecorder — sync-summary branch (Requirements 14.5, 14.6)', () => {
  const graph: WorkflowGraph = { nodes: [], connections: [] };

  function recorder() {
    return createRunRecorder({
      runId: 'run-1',
      workflowId: 'wf-1',
      workflowName: 'Nightly sync',
      source: 'schedule',
      environment: 'local',
      graph,
    });
  }

  it('attaches the summary unchanged and keeps the event in the log', () => {
    const summary = fold([deltaWrite(true), deltaWrite(false), loopCompleted(1, 0), httpResponse(200)]);
    const rec = recorder();
    rec.record({ type: 'run-started', runId: 'run-1', input: 'go', at: AT });
    rec.record({ type: 'sync-summary', runId: 'run-1', summary, at: AT + 1 });
    rec.record({ type: 'run-completed', runId: 'run-1', output: 'done', at: AT + 2 });

    const record = rec.snapshot();
    expect(record.summary.sync).toBe(summary);
    expect(record.events.map(event => event.type)).toEqual([
      'run-started',
      'sync-summary',
      'run-completed',
    ]);
  });

  it('omits sync for an agent-only run that emitted no sync-summary', () => {
    const rec = recorder();
    rec.record({ type: 'run-started', runId: 'run-1', input: 'go', at: AT });
    rec.record({ type: 'node-started', runId: 'run-1', nodeId: 'agent-1', nodeName: 'Writer', at: AT });
    rec.record({ type: 'node-token', runId: 'run-1', nodeId: 'agent-1', token: 'hi' });
    rec.record({ type: 'node-completed', runId: 'run-1', nodeId: 'agent-1', nodeName: 'Writer', output: 'hi', at: AT + 1 });
    rec.record({ type: 'run-completed', runId: 'run-1', output: 'hi', at: AT + 2 });

    expect(rec.summary().sync).toBeUndefined();
    expect('sync' in rec.summary()).toBe(false);
  });

  it('omits sync on a failed agent-only run', () => {
    const rec = recorder();
    rec.record({ type: 'run-started', runId: 'run-1', input: 'go', at: AT });
    rec.record({ type: 'run-failed', runId: 'run-1', error: 'boom', at: AT + 1 });
    expect(rec.summary().status).toBe('failed');
    expect(rec.summary().sync).toBeUndefined();
  });
});

// ── Engine emission: exactly once, immediately before the terminal event ─────

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [{ id: 'trigger-out-1', name: 'Out', role: 'message-out' }],
    data: {},
  };
}

function dataNode(): WorkflowNode {
  return {
    id: 'transform-1',
    name: 'Shape rows',
    kind: 'transform',
    category: 'data',
    icon: 'pi-sliders-h',
    position: { x: 200, y: 0 },
    ports: [
      { id: 'transform-in-1', name: 'In', role: 'message-in' },
      { id: 'transform-out-1', name: 'Out', role: 'message-out' },
    ],
    // A minimal valid `transform`: `passthrough` keeps every top-level field,
    // and the one mapped field is what makes the field list non-empty
    // (Requirement 5.2). What matters here is only that this is a real data
    // node execution, not its projected shape.
    data: { mode: 'record', passthrough: true, fields: [{ target: '_seen', expression: 'true' }] },
  };
}

function agentWithoutModel(): WorkflowNode {
  return {
    id: 'agent-1',
    name: 'Writer',
    kind: 'agent',
    category: 'agent',
    icon: 'pi-user',
    position: { x: 400, y: 0 },
    ports: [{ id: 'agent-in-1', name: 'In', role: 'message-in' }],
    data: {},
  };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

async function runGraph(graph: WorkflowGraph): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'run-1',
    graph,
    input: '{"rows":[]}',
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
  });
  await handle.done;
  return events;
}

describe('engine sync-summary emission (Requirements 14.4, 14.6)', () => {
  it('emits exactly one sync-summary immediately before run-completed when a data node ran', async () => {
    const events = await runGraph({
      nodes: [trigger(), dataNode()],
      connections: [connect('c1', 'trigger-out-1', 'transform-in-1')],
    });

    const types = events.map(event => event.type);
    expect(types.filter(type => type === 'sync-summary')).toHaveLength(1);
    expect(types.at(-1)).toBe('run-completed');
    expect(types.at(-2)).toBe('sync-summary');

    const emitted = events.find(event => event.type === 'sync-summary');
    expect(emitted?.type === 'sync-summary' && emitted.summary).toEqual(createSyncSummary());
  });

  it('emits exactly one sync-summary immediately before run-failed when a data node ran', async () => {
    const events = await runGraph({
      nodes: [trigger(), dataNode(), agentWithoutModel()],
      connections: [
        connect('c1', 'trigger-out-1', 'transform-in-1'),
        connect('c2', 'transform-out-1', 'agent-in-1'),
      ],
    });

    const types = events.map(event => event.type);
    expect(types.filter(type => type === 'sync-summary')).toHaveLength(1);
    expect(types.at(-1)).toBe('run-failed');
    expect(types.at(-2)).toBe('sync-summary');
  });

  it('emits no sync-summary for a run that executed no data node', async () => {
    const events = await runGraph({ nodes: [trigger()], connections: [] });

    expect(events.map(event => event.type)).not.toContain('sync-summary');
    expect(events.map(event => event.type).at(-1)).toBe('run-completed');
  });

  it('leaves RunRecordSummary.sync absent for an agent-only run and present for a data run', async () => {
    const graphs: Array<{ graph: WorkflowGraph; expectsSync: boolean }> = [
      { graph: { nodes: [trigger()], connections: [] }, expectsSync: false },
      {
        graph: {
          nodes: [trigger(), dataNode()],
          connections: [connect('c1', 'trigger-out-1', 'transform-in-1')],
        },
        expectsSync: true,
      },
    ];

    for (const { graph, expectsSync } of graphs) {
      const rec = createRunRecorder({
        runId: 'run-1',
        workflowId: null,
        workflowName: 'Scripted',
        source: 'manual',
        environment: 'local',
        graph,
      });
      for (const event of await runGraph(graph)) rec.record(event);
      const summary = rec.summary();
      expect(summary.status).toBe('completed');
      expect(summary.sync !== undefined).toBe(expectsSync);
    }
  });
});
