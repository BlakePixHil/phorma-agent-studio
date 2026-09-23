/**
 * System One on AWS: `DataHosts.decisions` reaches the engine, so a Decide
 * node completes through the injected client, and its absence fails the run
 * naming the capability.
 */

import { describe, expect, it } from 'vitest';
import type {
  DecisionClient,
  DecisionRequest,
  RunEvent,
  WorkflowGraph,
  WorkflowNode,
} from '@phorma/engine';

import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { FakeRunTable } from '../test/fake-run-table.js';
import { RunTableAdapter } from '../aws/run-table.js';
import type { MonitorGateway } from '../core/host-contract.js';
import { executeRun, type DataHosts, type RunnerDeps } from './runner.js';

const TABLE_NAME = 'phorma-run-table';

function decideGraph(): WorkflowGraph {
  const trigger: WorkflowNode = {
    id: 'trigger',
    name: 'Trigger',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [{ id: 'trigger-out', name: 'Start', role: 'message-out' }],
    data: {},
  };
  const decide: WorkflowNode = {
    id: 'decide',
    name: 'Triage',
    kind: 'decide',
    category: 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [
      { id: 'decide-in', name: 'In', role: 'message-in' },
      { id: 'decide-out', name: 'Decided', role: 'message-out' },
    ],
    data: { questions: [{ id: 'urgent', type: 'noul', instructions: 'Is this urgent?' }] },
  };
  return {
    nodes: [trigger, decide],
    connections: [{ id: 'c0', outputId: 'trigger-out-out', inputId: 'decide-in-in', kind: 'handoff' }],
  };
}

function deps(dataHosts: DataHosts, pushed: RunEvent[]): RunnerDeps {
  const adapter = new RunTableAdapter(
    new FakeDocumentTableClient(new FakeRunTable(), { tableName: TABLE_NAME }),
    TABLE_NAME,
  );
  const monitor = {
    push: async (_workflowId: string, event: RunEvent) => {
      pushed.push(event);
    },
    addConnection: () => {},
    removeConnection: () => {},
    connections: () => [],
  } as unknown as MonitorGateway;
  return {
    config: { workflowId: 'wf-decide', runnerId: 'runner-1' },
    clock: { now: () => 1_700_000_000_000 },
    timers: {
      setTimeout: fn => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    lease: adapter,
    journal: adapter,
    events: adapter.eventStore,
    history: adapter,
    usage: adapter.usageStore,
    spec: adapter,
    monitor,
    frameInbox: { drain: async () => [] },
    modelFactory: {
      create: async () => ({
        async *stream() {
          throw new Error('No model call is expected.');
        },
      }),
    },
    dataHostFactory: { create: async () => dataHosts },
    telemetry: {
      setRunId: () => {},
      clearRunId: () => {},
      log: async () => {},
      publishRunOutcome: async () => {},
      publishRunDuration: async () => {},
      publishLeaseTakeover: async () => {},
    },
    runRecord: { writeInFlight: async () => {}, writeSettled: async () => {} },
    resumeTracker: { getReplacementCount: async () => 0, incrementReplacementCount: async () => 1 },
  };
}

describe('runner - System One decisions', () => {
  it('hands DataHosts.decisions to the engine', async () => {
    const requests: DecisionRequest[] = [];
    const decisions: DecisionClient = {
      async evaluate(request) {
        requests.push(request);
        return {
          model: 'jev-1.13.0',
          answers: { urgent: { type: 'noul', noul: 0.83 } },
          usage: { inputTokens: 100, outputTokens: 1 },
        };
      },
    };
    const pushed: RunEvent[] = [];
    const outcome = await executeRun(deps({ decisions }, pushed), {
      runId: 'run-1',
      input: 'The site is down',
      source: 'manual',
      graph: decideGraph(),
    });
    expect(outcome).toEqual({ status: 'completed' });
    expect(requests).toHaveLength(1);
    expect(pushed.some(event => event.type === 'decision')).toBe(true);
  });

  it('fails naming the capability when no decision client is configured', async () => {
    const pushed: RunEvent[] = [];
    const outcome = await executeRun(deps({}, pushed), {
      runId: 'run-2',
      input: 'x',
      source: 'manual',
      graph: decideGraph(),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toMatch(/decisions/);
  });
});
