/**
 * E2E for cost & usage observability (EPIC 2) — drives the REAL engine over
 * a two-agent graph with a scripted model and verifies:
 *  - node-usage events carry the resolved model id
 *  - the pricing module estimates BYO cost (marked 'estimated')
 *  - reported cost always wins over estimation
 *  - the recorder produces per-node + per-model rollups and the Phorma
 *    Cloud cost split (the credits-not-dollars display rule's data source)
 *  - usageLedgerEntryOf projects a summary into a ledger row
 *
 * Run: npx -y tsx usage-pricing.e2e.mts
 */
import {
  createRunRecorder,
  estimateCostUsd,
  priceTableFromOpenRouter,
  startRun,
  toPricingSlug,
  usageLedgerEntryOf,
  withEstimatedCost,
} from '../src/index.js';
import type {
  ModelChunk,
  ModelPriceTable,
  ModelRequest,
  RunEvent,
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

// ── Pricing module (pure) ────────────────────────────────────────────────────

console.log('Pricing: slug normalization');
{
  check('openai id maps', toPricingSlug('openai', 'gpt-4o') === 'openai/gpt-4o');
  check(
    'anthropic date stamp stripped',
    toPricingSlug('anthropic', 'claude-sonnet-4-5-20250929') === 'anthropic/claude-sonnet-4-5',
  );
  check('gemini maps to google', toPricingSlug('gemini', 'gemini-2.5-pro') === 'google/gemini-2.5-pro');
  check(
    'openrouter variant suffix stripped',
    toPricingSlug('openrouter', 'openai/gpt-4o:free') === 'openai/gpt-4o',
  );
  check(
    'bedrock geo profile maps',
    toPricingSlug('bedrock', 'au.anthropic.claude-opus-4-7-20250514-v1:0') ===
      'anthropic/claude-opus-4-7',
    `got ${toPricingSlug('bedrock', 'au.anthropic.claude-opus-4-7-20250514-v1:0')}`,
  );
  check('ollama is unpriced', toPricingSlug('ollama', 'llama3') === null);
}

console.log('Pricing: estimation');
const table: ModelPriceTable = {
  'openai/gpt-4o': { promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00001 },
};
{
  const est = estimateCostUsd(table, 'openai', 'gpt-4o', { inputTokens: 1000, outputTokens: 500 });
  check('estimates from token counts', Math.abs((est ?? 0) - 0.0075) < 1e-9, `got ${est}`);
  check('unknown model returns null', estimateCostUsd(table, 'openai', 'not-a-model', { inputTokens: 5 }) === null);
  check('ollama estimates to 0', estimateCostUsd(table, 'ollama', 'llama3', { inputTokens: 5 }) === 0);

  const estimated = withEstimatedCost({ inputTokens: 1000, outputTokens: 500 }, 'openai', 'gpt-4o', (p, m, u) =>
    estimateCostUsd(table, p, m, u),
  );
  check('withEstimatedCost fills + marks estimated', estimated.costUsd !== undefined && estimated.costSource === 'estimated');

  const reported = withEstimatedCost(
    { inputTokens: 1000, outputTokens: 500, costUsd: 0.5, costSource: 'reported' },
    'openai',
    'gpt-4o',
    () => 0.001,
  );
  check('reported cost wins over estimate', reported.costUsd === 0.5 && reported.costSource === 'reported');
}

console.log('Pricing: OpenRouter response parsing');
{
  const parsed = priceTableFromOpenRouter({
    data: [
      { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
      { id: 'broken/model', pricing: { prompt: 'NaN', completion: '1' } },
      { id: 'anthropic/claude-sonnet-4-5:beta', pricing: { prompt: '0.000003', completion: '0.000015' } },
    ],
  });
  check('parses valid rows', parsed['openai/gpt-4o']?.completionUsdPerToken === 0.00001);
  check('skips unparseable rows', !('broken/model' in parsed));
  check('strips variant suffix from keys', 'anthropic/claude-sonnet-4-5' in parsed);
}

// ── Recorder rollups over a real engine run ──────────────────────────────────

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

// Agent a1 runs BYO OpenAI (tokens only → estimated cost); agent a2 runs on
// Phorma Cloud (reported cost → the credits-billed share).
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
      { prompt: 'First: {{input}}', provider: 'openai', model: 'gpt-4o' },
    ),
    node(
      'a2',
      'agent',
      [{ id: 'a2-in-p', name: 'In', role: 'message-in' }],
      { prompt: 'Second: {{input}}', provider: 'phorma-cloud', model: 'anthropic/claude-sonnet-5' },
    ),
  ],
  connections: [
    { id: 'c1', outputId: 'trig-out-p-out', inputId: 'a1-in-p-in', kind: 'handoff' },
    { id: 'c2', outputId: 'a1-out-p-out', inputId: 'a2-in-p-in', kind: 'handoff' },
  ],
};

// Scripted model: BYO round reports tokens only; cloud round reports cost.
const model = {
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    yield { type: 'text', text: 'ok' };
    if (request.provider === 'phorma-cloud') {
      yield {
        type: 'usage',
        usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02, costSource: 'reported' },
      } as ModelChunk;
    } else {
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } } as ModelChunk;
    }
  },
};

console.log('E2E: usage rollups over a real engine run');
await (async () => {
  const recorder = createRunRecorder({
    runId: 'usage-1',
    workflowId: 'wf-usage',
    workflowName: 'Usage Test',
    source: 'manual',
    environment: 'local',
    graph: structuredClone(graph),
    estimateCost: (provider, modelId, usage) => estimateCostUsd(table, provider, modelId, usage),
  });

  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'usage-1',
    graph: structuredClone(graph),
    input: 'the task',
    source: 'manual',
    model,
    emit: event => {
      events.push(event);
      recorder.record(event);
    },
    requestApproval: async () => true,
    waitForEvent: async () => '',
  });
  await handle.done;

  const usageEvents = events.filter(e => e.type === 'node-usage');
  check('two node-usage events emitted', usageEvents.length === 2);
  check(
    'node-usage carries the resolved model id',
    usageEvents.every(e => e.type === 'node-usage' && !!e.model),
    JSON.stringify(usageEvents.map(e => e.type === 'node-usage' && e.model)),
  );

  const summary = recorder.summary();
  check('run completed', summary.status === 'completed');
  check('tokens summed', summary.usage.inputTokens === 1020 && summary.usage.outputTokens === 510);

  // BYO estimate: 1000*0.0000025 + 500*0.00001 = 0.0075; cloud reported 0.02.
  check(
    'total cost = estimate + reported',
    Math.abs(summary.usage.costUsd - 0.0275) < 1e-9,
    `got ${summary.usage.costUsd}`,
  );
  check(
    'phorma cloud share split out (credits display source)',
    Math.abs((summary.usage.phormaCloudCostUsd ?? 0) - 0.02) < 1e-9,
    `got ${summary.usage.phormaCloudCostUsd}`,
  );
  check('summary marked estimated (BYO share)', summary.usage.estimated === true);

  const byNode = summary.usage.byNode ?? {};
  check('per-node rollup has both agents', 'a1' in byNode && 'a2' in byNode);
  check(
    'a1 rollup estimated',
    byNode['a1']?.estimated === true && Math.abs((byNode['a1']?.costUsd ?? 0) - 0.0075) < 1e-9,
  );
  check(
    'a2 rollup reported (not estimated)',
    byNode['a2']?.estimated === false && byNode['a2']?.provider === 'phorma-cloud',
  );

  const byModel = summary.usage.byModel ?? {};
  check(
    'per-model rollup keyed provider:model',
    'openai:gpt-4o' in byModel && 'phorma-cloud:anthropic/claude-sonnet-5' in byModel,
    Object.keys(byModel).join(', '),
  );

  const ledger = usageLedgerEntryOf(summary);
  check(
    'ledger row projects the summary',
    ledger.runId === 'usage-1' &&
      ledger.workflowId === 'wf-usage' &&
      ledger.usage.costUsd === summary.usage.costUsd &&
      ledger.status === 'completed',
  );

  check('record JSON-safe', JSON.stringify(recorder.snapshot()).length > 0);
})();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
