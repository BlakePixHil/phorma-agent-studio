/**
 * Document delivery on AWS: `TriggerInput.variables` reaches the engine as the
 * `vars` scope, and `DataHosts.artifacts` receives the file a Render Document
 * step produces, so a run on this host behaves like one on the Worker.
 *
 * Feature: aws-deployment-target, document-delivery-primitives
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactRef, RunEvent, WorkflowGraph, WorkflowNode } from '@phorma/engine';

import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { FakeRunTable } from '../test/fake-run-table.js';
import { RunTableAdapter } from '../aws/run-table.js';
import type { MonitorGateway } from '../core/host-contract.js';
import { executeRun, type RunnerDeps } from './runner.js';

const TABLE_NAME = 'phorma-run-table';
const WORKFLOW = 'wf-delivery';

function renderGraph(): WorkflowGraph {
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
  const render: WorkflowNode = {
    id: 'render',
    name: 'Render',
    kind: 'render-document',
    category: 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [
      { id: 'render-in', name: 'In', role: 'message-in' },
      { id: 'render-rendered', name: 'Rendered', role: 'message-out' },
    ],
    data: {
      markdown: '# {{vars.title}}\n\nBody text.',
      fileName: '{{vars.title}}',
      format: 'pdf',
      resultKey: 'document',
    },
  };
  return {
    nodes: [trigger, render],
    connections: [{ id: 'c0', outputId: 'trigger-out-out', inputId: 'render-in-in', kind: 'handoff' }],
  };
}

function deps(adapter: RunTableAdapter, pushed: RunEvent[]): RunnerDeps {
  const monitor = {
    push: async (_workflowId: string, event: RunEvent) => {
      pushed.push(event);
    },
    addConnection: () => {},
    removeConnection: () => {},
    connections: () => [],
  } as unknown as MonitorGateway;
  return {
    config: { workflowId: WORKFLOW, runnerId: 'runner-1' },
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
    dataHostFactory: {
      create: async workflowId => ({ artifacts: adapter.createArtifactStore(workflowId) }),
    },
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

describe('runner - document delivery', () => {
  it('resolves vars from the trigger and stores the rendered file in the Run_Table', async () => {
    const adapter = new RunTableAdapter(
      new FakeDocumentTableClient(new FakeRunTable(), { tableName: TABLE_NAME }),
      TABLE_NAME,
    );
    const pushed: RunEvent[] = [];
    const outcome = await executeRun(deps(adapter, pushed), {
      runId: 'run-1',
      input: '',
      source: 'manual',
      graph: renderGraph(),
      variables: { title: 'Quarterly report' },
    });
    expect(outcome).toEqual({ status: 'completed' });

    const created = pushed.filter(
      (event): event is Extract<RunEvent, { type: 'artifact-created' }> => event.type === 'artifact-created',
    );
    expect(created).toHaveLength(1);
    const refs: ArtifactRef[] = await adapter.createArtifactStore(WORKFLOW).list('run-1');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe('Quarterly report.pdf');
    expect(refs[0]!.mimeType).toBe('application/pdf');
    const stored = await adapter.createArtifactStore(WORKFLOW).get('run-1', refs[0]!.id);
    expect(stored && new TextDecoder().decode(stored.bytes.slice(0, 8))).toBe('%PDF-1.4');
  });
});
