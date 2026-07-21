/**
 * E2E for EPIC 6 Agent Skills: markdown skill fragments embedded in
 * AgentNodeData.skills render into the agent's system prompt in order,
 * verbatim, between the user prompt and the capabilities/hand-off sections.
 * Run: npx -y tsx engine/test/skills.e2e.mts
 */
import { startRun } from '../src/index.js';
import type { ModelChunk, ModelClient, ModelRequest, RunEvent, WorkflowGraph } from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Graph builder helpers ─────────────────────────────────────────────────────
function node(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
) {
  return { id, name: id, kind, category: 'flow', icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id: string, fromPort: string, toPort: string) {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' as const };
}
function trigger() {
  return node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]);
}
function agent(id: string, data: object = {}) {
  return node(
    id,
    'agent',
    [
      { id: `${id}-in`, name: 'Task', role: 'message-in' },
      { id: `${id}-out`, name: 'Result', role: 'message-out' },
    ],
    { prompt: 'Do the thing: {{input}}', provider: 'openai', model: 'gpt-test', ...data },
  );
}

/** Fake model that records every system prompt it is asked to run with. */
function capturingModel(captured: string[]): ModelClient {
  return {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      captured.push(request.system);
      yield { type: 'text', text: 'ok' };
    },
  };
}

async function run(graph: WorkflowGraph, model: ModelClient): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-skills',
    graph,
    input: 'task',
    model,
    emit: event => events.push(event),
    requestApproval: async () => true,
  });
  await handle.done;
  return events;
}

// ── E2E 1: skills render into the system prompt in order ────────────────────
console.log('E2E: skills render in order');
{
  const skills = [
    { id: 's1', name: 'Xero Journals', content: 'Always post journals via the `xero_*` tools.\nNever guess account codes.' },
    { id: 's2', name: 'Tone', description: 'ignored at render time', content: 'Write in plain English for a non-accountant.' },
  ];
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { skills })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const captured: string[] = [];
  const events = await run(graph, capturingModel(captured));

  check('run completed', events.some(e => e.type === 'run-completed'), JSON.stringify(events.at(-1)));
  check('one model call', captured.length === 1);
  const system = captured[0] ?? '';
  check('prompt body interpolated first', system.startsWith('Do the thing: task'));
  const idx1 = system.indexOf('# Skill: Xero Journals');
  const idx2 = system.indexOf('# Skill: Tone');
  check('skill 1 section present', idx1 > 0, system);
  check('skill 2 section present', idx2 > 0, system);
  check('skills in attachment order', idx1 < idx2);
  check('skill content verbatim', system.includes('Never guess account codes.'));
}

// ── E2E 2: skill content is not interpolated ─────────────────────────────────
console.log('\nE2E: skill content stays verbatim');
{
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1', {
        skills: [{ id: 's1', name: 'Templating', content: 'Use {{input}} placeholders in YOUR outputs.' }],
      }),
    ],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const captured: string[] = [];
  await run(graph, capturingModel(captured));
  const system = captured[0] ?? '';
  check(
    '{{input}} inside skill content is untouched',
    system.includes('Use {{input}} placeholders in YOUR outputs.'),
    system,
  );
  check('prompt body still interpolated', system.startsWith('Do the thing: task'));
}

// ── E2E 3: agents without skills are unchanged ───────────────────────────────
console.log('\nE2E: no skills = no skill section');
{
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1')],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const captured: string[] = [];
  await run(graph, capturingModel(captured));
  const system = captured[0] ?? '';
  check('no skill heading', !system.includes('# Skill:'), system);
}

// ── E2E 4: malformed/blank skills are skipped gracefully ─────────────────────
console.log('\nE2E: malformed skills skipped');
{
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1', {
        skills: [
          { id: 's1', name: '', content: 'Body without a name.' },
          { id: 's2', name: 'Blank', content: '   ' },
          null as never,
          { id: 's3', name: 'Good', content: 'Real guidance.' },
        ],
      }),
    ],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const captured: string[] = [];
  const events = await run(graph, capturingModel(captured));
  const system = captured[0] ?? '';
  check('run completed despite malformed entries', events.some(e => e.type === 'run-completed'));
  check('nameless skill gets fallback heading', system.includes('# Skill: Skill\n\nBody without a name.'));
  check('blank-content skill dropped', !system.includes('# Skill: Blank'));
  check('good skill still renders', system.includes('# Skill: Good\n\nReal guidance.'));
}

// ── E2E 5: skills coexist with hand-off section ──────────────────────────────
console.log('\nE2E: skills precede hand-off section');
{
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1', { skills: [{ id: 's1', name: 'First', content: 'Skill body.' }] }),
      agent('a2'),
    ],
    connections: [edge('e1', 'trig-start', 'a1-in'), edge('e2', 'a1-out', 'a2-in')],
  };
  const captured: string[] = [];
  await run(graph, capturingModel(captured));
  const system = captured[0] ?? '';
  const skillIdx = system.indexOf('# Skill: First');
  const handoffIdx = system.indexOf('# Hand-off');
  check('skill section present', skillIdx > 0, system);
  check('hand-off section present', handoffIdx > 0, system);
  check('skills render before hand-off', skillIdx < handoffIdx);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
