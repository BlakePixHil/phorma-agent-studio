/**
 * E2E for the EPIC 3 robustness primitives: retry with backoff, LLM
 * fallback, error output branch, workflow error handler, node + workflow
 * timeouts, and automatic context compression.
 * Run: npx -y tsx robustness.e2e.mts
 */
import { startRun, ModelRequestError, isTransientModelError } from '../src/index.js';
import type {
  ModelChunk,
  ModelClient,
  ModelRequest,
  RunEvent,
  WorkflowGraph,
} from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
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

async function run(
  graph: WorkflowGraph,
  model: ModelClient,
  extra: Partial<Parameters<typeof startRun>[0]> = {},
): Promise<{ events: RunEvent[]; handle: ReturnType<typeof startRun> }> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e',
    graph,
    input: 'task',
    model,
    emit: event => events.push(event),
    requestApproval: async () => true,
    ...extra,
  });
  await handle.done;
  return { events, handle };
}

function textStream(text: string): ModelClient {
  return {
    stream: async function* (): AsyncIterable<ModelChunk> {
      yield { type: 'text', text };
    },
  };
}

function last(events: RunEvent[]): RunEvent | undefined {
  return events.at(-1);
}

// ── Unit: transient error classification ────────────────────────────────────
console.log('isTransientModelError');
check('429 is transient', isTransientModelError(new ModelRequestError('rate limited', 429)));
check('503 is transient', isTransientModelError(new ModelRequestError('overloaded', 503)));
check('408 is transient', isTransientModelError(new ModelRequestError('timeout', 408)));
check('401 is permanent', !isTransientModelError(new ModelRequestError('bad key', 401)));
check('400 is permanent', !isTransientModelError(new ModelRequestError('bad request', 400)));
check('statusless is transient (network)', isTransientModelError(new ModelRequestError('boom')));
check(
  'message-embedded 503 is transient',
  isTransientModelError(new Error('openai request failed (503): overloaded')),
);
check(
  'message-embedded 401 is permanent',
  !isTransientModelError(new Error('openai request failed (401): unauthorized')),
);
check('fetch TypeError is transient', isTransientModelError(new TypeError('fetch failed')));
check('random error is permanent', !isTransientModelError(new Error('some prompt problem')));

// ── E2E 1: transient failure retries then succeeds (default policy) ─────────
console.log('\nE2E: retry then succeed');
{
  let calls = 0;
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      calls += 1;
      if (calls === 1) throw new ModelRequestError('rate limited', 429);
      yield { type: 'text', text: 'recovered' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { retry: { backoffMs: 10 } })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model);
  check('run completed', last(events)?.type === 'run-completed', JSON.stringify(last(events)));
  check('model called twice', calls === 2, String(calls));
  const retrying = events.filter(e => e.type === 'node-retrying');
  check('one node-retrying event', retrying.length === 1);
  check(
    'retrying carries attempt info',
    retrying[0]?.type === 'node-retrying' && retrying[0].attempt === 1 && retrying[0].maxAttempts === 2,
  );
  const completedOutput = events.find(e => e.type === 'run-completed');
  check(
    'output from the retried round',
    completedOutput?.type === 'run-completed' && completedOutput.output.includes('recovered'),
  );
}

// ── E2E 2: permanent failure does NOT retry ──────────────────────────────────
console.log('\nE2E: permanent failure fails fast');
{
  let calls = 0;
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      calls += 1;
      throw new ModelRequestError('unauthorized', 401);
      yield { type: 'text', text: 'never' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1')],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model);
  check('run failed', last(events)?.type === 'run-failed');
  check('model called once (no retry)', calls === 1, String(calls));
  check('no node-retrying events', !events.some(e => e.type === 'node-retrying'));
}

// ── E2E 3: retry disabled per node ───────────────────────────────────────────
console.log('\nE2E: retry disabled');
{
  let calls = 0;
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      calls += 1;
      throw new ModelRequestError('overloaded', 503);
      yield { type: 'text', text: 'never' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { retry: { disabled: true } })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model);
  check('run failed', last(events)?.type === 'run-failed');
  check('model called once', calls === 1, String(calls));
}

// ── E2E 4: fallback model after primary exhausts retries ────────────────────
console.log('\nE2E: LLM fallback');
{
  const seen: string[] = [];
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      seen.push(`${request.provider}/${request.model}`);
      if (request.model === 'gpt-test') throw new ModelRequestError('down', 500);
      yield { type: 'text', text: 'fallback answer' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1', {
        retry: { backoffMs: 5 },
        fallback: { provider: 'anthropic', model: 'claude-test' },
      }),
    ],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model);
  check('run completed on fallback', last(events)?.type === 'run-completed');
  check(
    'primary tried twice then fallback',
    JSON.stringify(seen) === '["openai/gpt-test","openai/gpt-test","anthropic/claude-test"]',
    JSON.stringify(seen),
  );
  const fallbackEvents = events.filter(e => e.type === 'node-fallback');
  check('one node-fallback event', fallbackEvents.length === 1);
  check(
    'fallback event carries models',
    fallbackEvents[0]?.type === 'node-fallback' &&
      fallbackEvents[0].fromModel === 'gpt-test' &&
      fallbackEvents[0].toModel === 'claude-test',
  );
  const usage = events.filter(e => e.type === 'node-usage');
  check('no stray usage events', usage.length === 0);
}

// ── E2E 5: error output branch routes failure ────────────────────────────────
console.log('\nE2E: error branch');
{
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      if (request.model === 'gpt-test') throw new ModelRequestError('bad key', 401);
      yield { type: 'text', text: `handled: ${request.messages[0]?.role}` };
    },
  };
  const failing = agent('a1', { errorPortId: 'a1-err' });
  failing.ports.push({ id: 'a1-err', name: 'On error', role: 'message-out' });
  const graph: WorkflowGraph = {
    nodes: [trigger(), failing, agent('rescue', { model: 'rescue-model' })],
    connections: [
      edge('e1', 'trig-start', 'a1-in'),
      edge('e2', 'a1-err', 'rescue-in'),
    ],
  };
  const { events } = await run(graph, model);
  check('run completed via error branch', last(events)?.type === 'run-completed');
  check('node-failed emitted for a1', events.some(e => e.type === 'node-failed' && e.nodeId === 'a1'));
  check('node-error-routed emitted', events.some(e => e.type === 'node-error-routed'));
  const handoff = events.find(e => e.type === 'handoff' && e.toNodeId === 'rescue');
  check('handoff through error port', !!handoff);
  check(
    'error payload is JSON with error+input',
    handoff?.type === 'handoff' &&
      (() => {
        try {
          const parsed = JSON.parse(handoff.payload) as { error?: string; input?: string };
          return !!parsed.error?.includes('bad key') && parsed.input === 'task';
        } catch {
          return false;
        }
      })(),
    handoff?.type === 'handoff' ? handoff.payload : undefined,
  );
  check('rescue agent ran', events.some(e => e.type === 'node-completed' && e.nodeId === 'rescue'));
}

// ── E2E 6: success never flows through the error port ────────────────────────
console.log('\nE2E: error branch not taken on success');
{
  const failing = agent('a1', { errorPortId: 'a1-err' });
  failing.ports.push({ id: 'a1-err', name: 'On error', role: 'message-out' });
  const graph: WorkflowGraph = {
    nodes: [trigger(), failing, agent('next', { model: 'ok' }), agent('rescue', { model: 'ok' })],
    connections: [
      edge('e1', 'trig-start', 'a1-in'),
      edge('e2', 'a1-out', 'next-in'),
      edge('e3', 'a1-err', 'rescue-in'),
    ],
  };
  const { events } = await run(graph, textStream('fine'));
  check('run completed', last(events)?.type === 'run-completed');
  check('next ran', events.some(e => e.type === 'node-completed' && e.nodeId === 'next'));
  check('rescue did NOT run', !events.some(e => e.type === 'node-started' && e.nodeId === 'rescue'));
}

// ── E2E 7: workflow error handler runs on failure ────────────────────────────
console.log('\nE2E: error handler node');
{
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      if (request.model === 'gpt-test') throw new ModelRequestError('forbidden', 403);
      yield { type: 'text', text: 'notified ops' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1'),
      node('handler', 'error-handler', [
        { id: 'handler-out', name: 'Error', role: 'message-out' },
      ]),
      agent('notifier', { model: 'notify-model' }),
    ],
    connections: [
      edge('e1', 'trig-start', 'a1-in'),
      edge('e2', 'handler-out', 'notifier-in'),
    ],
  };
  const { events } = await run(graph, model);
  check('run still failed', last(events)?.type === 'run-failed');
  check('handler executed', events.some(e => e.type === 'node-completed' && e.nodeId === 'handler'));
  check('notifier ran', events.some(e => e.type === 'node-completed' && e.nodeId === 'notifier'));
  const handlerHandoff = events.find(e => e.type === 'handoff' && e.toNodeId === 'notifier');
  check(
    'handler payload carries the error',
    handlerHandoff?.type === 'handoff' && handlerHandoff.payload.includes('forbidden'),
  );
}

// ── E2E 8: failing handler never masks the original error ───────────────────
console.log('\nE2E: failing error handler is contained');
{
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      throw new ModelRequestError('primary down', 400);
      yield { type: 'text', text: 'never' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [
      trigger(),
      agent('a1'),
      node('handler', 'error-handler', [
        { id: 'handler-out', name: 'Error', role: 'message-out' },
      ]),
      agent('notifier'), // also fails (same model)
    ],
    connections: [
      edge('e1', 'trig-start', 'a1-in'),
      edge('e2', 'handler-out', 'notifier-in'),
    ],
  };
  const { events } = await run(graph, model);
  const failed = last(events);
  check('run failed with ORIGINAL error', failed?.type === 'run-failed' && failed.error.includes('primary down'));
}

// ── E2E 9: per-node timeout ──────────────────────────────────────────────────
console.log('\nE2E: node timeout');
{
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      // A slow stream: emits chunks forever with delays.
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        yield { type: 'text', text: 'x' };
      }
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { timeoutSec: 1, retry: { disabled: true } })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const started = Date.now();
  const { events } = await run(graph, model);
  const took = Date.now() - started;
  const failed = last(events);
  check('run failed on node timeout', failed?.type === 'run-failed' && /timed out after 1s/.test(failed.error), JSON.stringify(failed));
  check('timed out promptly (<3s)', took < 3000, `${took}ms`);
}

// ── E2E 10: workflow timeout ─────────────────────────────────────────────────
console.log('\nE2E: workflow timeout');
{
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        yield { type: 'text', text: 'x' };
      }
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { retry: { disabled: true } })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const started = Date.now();
  const { events } = await run(graph, model, { runTimeoutMs: 500 });
  const took = Date.now() - started;
  const failed = last(events);
  check(
    'run failed with workflow timeout',
    failed?.type === 'run-failed' && /Workflow timed out/.test(failed.error),
    JSON.stringify(failed),
  );
  check('timed out promptly (<3s)', took < 3000, `${took}ms`);
}

// ── E2E 11: stop during retry backoff unwinds promptly ───────────────────────
console.log('\nE2E: stop during backoff');
{
  const model: ModelClient = {
    stream: async function* (): AsyncIterable<ModelChunk> {
      throw new ModelRequestError('overloaded', 503);
      yield { type: 'text', text: 'never' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1', { retry: { maxAttempts: 5, backoffMs: 60_000 } })],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-stop',
    graph,
    input: 'task',
    model,
    emit: event => events.push(event),
    requestApproval: async () => true,
  });
  // Give the first attempt time to fail and enter the 60s backoff, then stop.
  await new Promise(resolve => setTimeout(resolve, 150));
  const started = Date.now();
  handle.stop();
  await handle.done;
  const took = Date.now() - started;
  check('run stopped', last(events)?.type === 'run-stopped', JSON.stringify(last(events)));
  check('stop unwound promptly (<1s, not 60s)', took < 1000, `${took}ms`);
}

// ── E2E 12: context compression ──────────────────────────────────────────────
console.log('\nE2E: context compression');
{
  const requests: ModelRequest[] = [];
  const big = 'lorem ipsum dolor sit amet '.repeat(400); // ~10.8k chars ≈ 2.7k tokens
  let toolRoundsServed = 0;
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      requests.push(request);
      // The summarizer call: no tools attached to the request.
      if (request.system.startsWith('Summarize')) {
        yield { type: 'text', text: 'SUMMARY-OF-EARLIER-WORK' };
        return;
      }
      toolRoundsServed += 1;
      if (toolRoundsServed <= 4) {
        // Keep requesting a (fake) tool so the conversation grows.
        yield { type: 'text', text: big };
        yield {
          type: 'tool-call',
          call: { id: `t${toolRoundsServed}`, name: 'lookup', arguments: '{}' },
        };
        return;
      }
      yield { type: 'text', text: 'final answer' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1')],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model, {
    // Tiny context window so the test compresses fast: 4 rounds × ~2.7k
    // tokens crosses 80% of 8000 comfortably.
    contextWindow: () => 8000,
    tools: {
      // Minimal ToolHost: the agent has no tool-link edges, so listTools is
      // never called; the model's tool call resolves as "Unknown tool" via
      // the engine's built-in handling (still grows the message list).
      listTools: async () => [],
      callTool: async () => 'tool says hi',
    },
  });
  check('run completed', last(events)?.type === 'run-completed', JSON.stringify(last(events)));
  const compressions = events.filter(e => e.type === 'context-compressed');
  check('context-compressed emitted', compressions.length >= 1, String(compressions.length));
  check(
    'compression reduced tokens',
    compressions.every(
      e => e.type === 'context-compressed' && e.afterTokens < e.beforeTokens,
    ),
  );
  const summarizerCalls = requests.filter(r => r.system.startsWith('Summarize'));
  check('summarizer called', summarizerCalls.length >= 1);
  const postCompression = requests.find(
    r =>
      !r.system.startsWith('Summarize') &&
      r.messages.some(
        m => m.role === 'user' && m.content.includes('SUMMARY-OF-EARLIER-WORK'),
      ),
  );
  check('summary injected into later rounds', !!postCompression);
  if (postCompression) {
    check(
      'first user message preserved',
      postCompression.messages[0]?.role === 'user' &&
        postCompression.messages[0].content === 'task',
    );
  }
}

// ── E2E 13: compression failure never fails the node ─────────────────────────
console.log('\nE2E: compression failure is contained');
{
  const big = 'word '.repeat(3000);
  let toolRoundsServed = 0;
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      if (request.system.startsWith('Summarize')) {
        throw new Error('summarizer down');
      }
      toolRoundsServed += 1;
      if (toolRoundsServed <= 3) {
        yield { type: 'text', text: big };
        yield {
          type: 'tool-call',
          call: { id: `t${toolRoundsServed}`, name: 'lookup', arguments: '{}' },
        };
        return;
      }
      yield { type: 'text', text: 'done anyway' };
    },
  };
  const graph: WorkflowGraph = {
    nodes: [trigger(), agent('a1')],
    connections: [edge('e1', 'trig-start', 'a1-in')],
  };
  const { events } = await run(graph, model, { contextWindow: () => 4000 });
  check('run completed despite summarizer failure', last(events)?.type === 'run-completed');
  check('no context-compressed event', !events.some(e => e.type === 'context-compressed'));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
