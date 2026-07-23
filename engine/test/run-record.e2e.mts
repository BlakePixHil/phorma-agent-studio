/**
 * E2E for the run-record model (EPIC 1) — drives the REAL engine over a
 * two-agent graph with a scripted model and verifies the recorder produces a
 * faithful, coalesced, JSON-safe RunRecord: token streams folded per node,
 * usage summed, status transitions, graph snapshot, and payload clipping.
 *
 * Run: npx -y tsx run-record.e2e.mts
 */
import {
  createRunRecorder,
  decodeRunSnapshot,
  encodeRunSnapshot,
  startRun,
} from '../src/index.js';
import type {
  EmbeddedWorkflow,
  ModelChunk,
  ModelRequest,
  RunLogEvent,
  WorkflowGraph,
} from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function node(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
) {
  return {
    id,
    name: id.toUpperCase(),
    kind,
    category: kind.includes('trigger') ? 'trigger' : 'agent',
    icon: 'ti ti-robot',
    position: { x: 0, y: 0 },
    ports,
    data,
  };
}

const graph: WorkflowGraph = {
  nodes: [
    node('trig', 'manual-trigger', [{ id: 'trig-out-p', name: 'Out', role: 'message-out' }]),
    node(
      'a1',
      'agent',
      [
        { id: 'a1-in-p', name: 'In', role: 'message-in' },
        { id: 'a1-out-p', name: 'Out', role: 'message-out' },
      ],
      { prompt: 'First: {{input}}', provider: 'openai', model: 'scripted' },
    ),
    node(
      'a2',
      'agent',
      [{ id: 'a2-in-p', name: 'In', role: 'message-in' }],
      { prompt: 'Second: {{input}}', provider: 'openai', model: 'scripted' },
    ),
  ],
  connections: [
    { id: 'c1', outputId: 'trig-out-p-out', inputId: 'a1-in-p-in', kind: 'handoff' },
    { id: 'c2', outputId: 'a1-out-p-out', inputId: 'a2-in-p-in', kind: 'handoff' },
  ],
};

// Scripted model: streams three tokens + usage per call.
let call = 0;
const model = {
  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    call += 1;
    const word = call === 1 ? 'alpha' : 'omega';
    for (const token of [word, ' ', `#${call}`]) yield { type: 'text', text: token };
    yield {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.001 },
    } as ModelChunk;
  },
};

console.log('E2E: run recorder over a real engine run');
{
  const childRegistry: Record<string, EmbeddedWorkflow> = {
    child: {
      id: 'child',
      name: 'Child Workflow',
      graph: { nodes: [structuredClone(graph.nodes[0])], connections: [] },
    },
  };
  const recorder = createRunRecorder({
    runId: 'rec-1',
    workflowId: 'wf-test',
    workflowName: 'Recorder Test',
    source: 'manual',
    environment: 'local',
    graph: structuredClone(graph),
    subWorkflows: childRegistry,
  });

  check('recorder starts unsettled and running', !recorder.settled && recorder.summary().status === 'running');

  const handle = startRun({
    runId: 'rec-1',
    graph: structuredClone(graph),
    input: 'the task',
    source: 'manual',
    model: model as never,
    emit: event => recorder.record(event),
    requestApproval: async () => true,
  });
  await handle.done;

  const record = recorder.snapshot();
  const summary = record.summary;
  const types = record.events.map(event => event.type);

  check('settled after run-completed', recorder.settled && summary.status === 'completed');
  check('run-started carries source', (record.events[0] as { source?: string }).source === 'manual');
  check('input captured', summary.input === 'the task');
  check('endedAt set and >= startedAt', !!summary.endedAt && summary.endedAt >= summary.startedAt);
  check('usage summed across both agents', summary.usage.inputTokens === 20 && summary.usage.outputTokens === 6);
  check('cost summed', Math.abs(summary.usage.costUsd - 0.002) < 1e-9);
  check('nodeCount from graph snapshot', summary.nodeCount === 3);
  check(
    'embedded sub-workflow registry retained',
    record.subWorkflows?.child?.graph.nodes[0]?.id === 'trig',
  );
  check('no raw node-token events in the log', !types.includes('node-token' as never));
  const outputTexts = record.events.filter(
    (event): event is Extract<RunLogEvent, { type: 'node-output-text' }> =>
      event.type === 'node-output-text',
  );
  check('one coalesced output-text entry per agent', outputTexts.length === 2);
  check(
    'coalesced text is the full stream',
    outputTexts[0]?.text === 'alpha #1' && outputTexts[1]?.text === 'omega #2',
  );
  check(
    'final output flows into the summary',
    summary.output === 'omega #2',
    `got: ${summary.output}`,
  );
  check('record survives JSON round-trip', JSON.stringify(JSON.parse(JSON.stringify(record))) === JSON.stringify(record));
}

console.log('E2E: cloud graph-column snapshot compatibility');
{
  const registry: Record<string, EmbeddedWorkflow> = {
    child: {
      id: 'child',
      name: 'Child Workflow',
      graph: { nodes: [structuredClone(graph.nodes[1])], connections: [] },
    },
  };
  const envelope = decodeRunSnapshot(encodeRunSnapshot(graph, registry));
  check('versioned snapshot envelope restores root graph', envelope.graph.nodes.length === 3);
  check('versioned snapshot envelope restores registry', envelope.subWorkflows?.child?.name === 'Child Workflow');

  const legacy = decodeRunSnapshot(JSON.stringify(graph));
  check('legacy raw graph row still parses', legacy.graph.connections.length === 2);
  check('legacy raw graph has no invented registry', legacy.subWorkflows === undefined);
}

console.log('E2E: payload clipping + truncation flag');
{
  const recorder = createRunRecorder({
    runId: 'rec-2',
    workflowId: null,
    workflowName: 'Clip Test',
    source: 'schedule',
    environment: 'cloud',
    graph: { nodes: [], connections: [] },
  });
  const huge = 'x'.repeat(100 * 1024);
  recorder.record({ type: 'run-started', runId: 'rec-2', input: 'go', at: Date.now() });
  recorder.record({
    type: 'node-completed',
    runId: 'rec-2',
    nodeId: 'n1',
    nodeName: 'N1',
    output: huge,
    at: Date.now(),
  });
  recorder.record({ type: 'run-failed', runId: 'rec-2', error: 'boom', at: Date.now() });

  const record = recorder.snapshot();
  const completed = record.events.find(event => event.type === 'node-completed') as
    | Extract<RunLogEvent, { type: 'node-completed' }>
    | undefined;
  check('oversized payload clipped to ~64KB', !!completed && completed.output.length < 70 * 1024);
  check('truncated flag set', record.summary.truncated === true);
  check('failed status + error recorded', record.summary.status === 'failed' && record.summary.error === 'boom');
  check('draft run keeps null workflowId', record.summary.workflowId === null);
  check('source preserved', record.summary.source === 'schedule');
}

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
