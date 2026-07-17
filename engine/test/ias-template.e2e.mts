/**
 * E2E for the Monthly IAS (PAYGW) workflow TEMPLATE — runs the real template
 * graph through the real engine with a scripted model + stub tool host,
 * simulating a 2-entity month: one entity flows through journal → e-sign →
 * lodgement; the other has unposted pay runs and exits via the SKIP route.
 *
 * Run: npx -y tsx engine/test/ias-template.e2e.mts
 */
import { startRun } from '../src/index.js';
import type { ModelChunk, ModelRequest, RunEvent, ToolHost, WorkflowNode } from '../src/index.js';
import { WORKFLOW_TEMPLATES } from '../../frontend/src/app/core/workflow-templates.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const template = WORKFLOW_TEMPLATES.find(item => item.id === 'tpl-monthly-ias');
if (!template) throw new Error('IAS template not found');
const spec = template.build();

console.log('template structure');
check('14 nodes', spec.graph.nodes.length === 14, String(spec.graph.nodes.length));
const portIds = new Set(spec.graph.nodes.flatMap(node => node.ports.map(port => port.id)));
const badConnections = spec.graph.connections.filter(
  conn =>
    !portIds.has(conn.outputId.replace(/-(in|out)$/, '')) ||
    !portIds.has(conn.inputId.replace(/-(in|out)$/, '')),
);
check('all connections resolve to ports', badConnections.length === 0, JSON.stringify(badConnections));

// ── Scripted model: each agent node answers from a queue keyed by node name ──
// The engine hands the system prompt + user payload; we key on which agent is
// asked (the prompt embeds the agent's role text).
const scripted: { match: string; responses: string[] }[] = [
  {
    match: 'find the IAS jobs',
    responses: [
      JSON.stringify({
        month: '2026-06',
        jobs: [
          { jobId: 'J-1', jobName: 'IAS Jun — Acme', entity: 'Acme Pty Ltd', clientId: 'C1', signerName: 'Jo Smith', signerEmail: 'jo@acme.example', month: '2026-06' },
          { jobId: 'J-2', jobName: 'IAS Jun — Beta', entity: 'Beta Trust', clientId: 'C2', signerName: 'Sam Lee', signerEmail: 'sam@beta.example', month: '2026-06' },
        ],
      }),
    ],
  },
  {
    match: 'verify one entity',
    responses: [
      JSON.stringify({ route: 'PROCEED', jobId: 'J-1', entity: 'Acme Pty Ltd', month: '2026-06', grossWages: 84210.55, taxWithheld: 19874, paygAccountCode: '825', atoAccountCode: '826', signerName: 'Jo Smith', signerEmail: 'jo@acme.example' }),
      JSON.stringify({ route: 'SKIP', jobId: 'J-2', entity: 'Beta Trust', month: '2026-06', reason: '1 pay run not posted' }),
    ],
  },
  {
    match: 'post the PAYGW journal',
    responses: [
      JSON.stringify({ jobId: 'J-1', entity: 'Acme Pty Ltd', month: '2026-06', grossWages: 84210.55, taxWithheld: 19874, journalId: 'MJ-9', journalDeepLink: 'https://go.xero.com/x', envelopeId: 'ENV-1' }),
    ],
  },
  {
    match: 'Assemble the lodgement pack',
    responses: [
      '## IAS lodgement pack — Acme Pty Ltd\n\n…\n{"jobId":"J-1","entity":"Acme Pty Ltd","month":"2026-06","taxWithheld":19874}',
    ],
  },
  {
    match: 'Close out the job',
    responses: [JSON.stringify({ jobId: 'J-1', entity: 'Acme Pty Ltd', month: '2026-06', status: 'lodged', taxWithheld: 19874 })],
  },
  {
    match: 'batch has finished',
    responses: ['# Monthly IAS run summary\n\n- 1 lodged (Acme Pty Ltd, $19,874.00)\n- 1 skipped (Beta Trust: pay run not posted)'],
  },
];

const model = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(request: ModelRequest): AsyncGenerator<ModelChunk> {
    const script = scripted.find(item => request.system?.includes(item.match));
    if (!script) throw new Error(`No script for system prompt: ${request.system?.slice(0, 80)}`);
    const response = script.responses.length > 1 ? script.responses.shift()! : script.responses[0];
    yield { type: 'text', text: response };
  },
} as never;

// Tool host: agents get their tools described but our scripted model never
// calls them — this validates the wiring without network access.
const tools: ToolHost = {
  async listTools(node: WorkflowNode) {
    return [
      {
        definition: {
          name: `stub_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 40),
          description: 'stub',
          parameters: { type: 'object', properties: {} },
        },
        nativeName: 'stub',
      },
    ];
  },
  async callTool() {
    return 'stub-result';
  },
};

const events: RunEvent[] = [];
const approvals: string[] = [];
const waits: string[] = [];

const handle = startRun({
  runId: 'ias-e2e',
  graph: spec.graph,
  input: '',
  model,
  tools,
  maxExecutions: 2000,
  defaultModel: { provider: 'ollama', model: 'stub' },
  emit: event => events.push(event),
  requestApproval: async nodeId => {
    approvals.push(nodeId);
    return true; // staff approves both gates
  },
  waitForEvent: async (_nodeId, correlationKey) => {
    waits.push(correlationKey);
    return JSON.stringify({ signedAt: '2026-07-03', envelopeId: 'ENV-1' });
  },
});
await handle.done;

console.log('\nIAS template run');
const completed = events.find(event => event.type === 'run-completed') as
  | Extract<RunEvent, { type: 'run-completed' }>
  | undefined;
const failed = events.find(event => event.type === 'run-failed') as
  | Extract<RunEvent, { type: 'run-failed' }>
  | undefined;
check('run completed', !!completed, failed?.error);

const loopDone = events.find(event => event.type === 'loop-completed') as
  | Extract<RunEvent, { type: 'loop-completed' }>
  | undefined;
check('loop processed 2 entities, 0 hard failures', loopDone?.total === 2 && loopDone.failed === 0, JSON.stringify(loopDone));
check(
  'both approval gates fired for the proceeding entity',
  approvals.length === 2 &&
    approvals.some(id => id === 'tpl-ias-gate-journal') &&
    approvals.some(id => id === 'tpl-ias-gate-lodge'),
  JSON.stringify(approvals),
);
check('wait-event fired once with the interpolated job key', JSON.stringify(waits) === '["signed:J-1"]', JSON.stringify(waits));

const output = completed?.output ?? '';
check('summary mentions the lodged entity', output.includes('Acme'), output.slice(0, 200));
check('summary mentions the skipped entity', output.includes('Beta'), output.slice(0, 200));

// The SKIP route contributes the skip JSON to the loop results.
const summaryTask = events.find(
  event => event.type === 'handoff' && event.toNodeId === 'tpl-ias-summary',
) as Extract<RunEvent, { type: 'handoff' }> | undefined;
const aggregate = summaryTask ? (JSON.parse(summaryTask.payload) as { results: unknown[]; exceptions: unknown[] }) : null;
check('aggregate delivered both entity outcomes to the summary', aggregate?.results.length === 2, summaryTask?.payload.slice(0, 300));
check(
  'skip outcome flowed through the unconnected SKIP route',
  JSON.stringify(aggregate?.results).includes('SKIP'),
  JSON.stringify(aggregate?.results)?.slice(0, 300),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
