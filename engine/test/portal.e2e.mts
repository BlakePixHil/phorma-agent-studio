/**
 * E2E for EPIC 9 Published Endpoints / Portal.
 *
 * Covers the pure rails a published surface depends on: slug hygiene, publish
 * validation, responder resolution (whose tokens a visitor may see), the JSON
 * input envelope, field coercion, and the visitor-facing config projection.
 * Closes with a real engine run asserting `{{message}}` / `{{history}}` /
 * `{{fields.x}}` interpolate and the run is attributed to `source: 'portal'`.
 *
 * Run: npx -y tsx engine/test/portal.e2e.mts
 */
import {
  buildPortalInput,
  coercePortalFields,
  createRunRecorder,
  isValidPortalFieldKey,
  isValidPortalSlug,
  portalPublicConfig,
  randomPortalSlug,
  renderPortalHistory,
  resolveResponderNodeId,
  startRun,
  suggestPortalSlug,
  terminalLeafNodes,
  toPortalSlug,
  trimPortalHistory,
  validatePortal,
  PORTAL_MAX_HISTORY_TURNS,
  type PortalField,
  type PortalTriggerData,
  type PortalTurn,
} from '../src/index.js';
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
  category = 'flow',
) {
  return { id, name: id, kind, category, icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id: string, fromPort: string, toPort: string) {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' as const };
}
function portal(data: Partial<PortalTriggerData> = {}) {
  return node(
    'portal',
    'portal-trigger',
    [{ id: 'portal-msg', name: 'Message', role: 'message-out' }],
    { mode: 'chat', access: 'public', ...data },
    'trigger',
  );
}
function agent(id: string, data: object = {}) {
  return node(
    id,
    'agent',
    [
      { id: `${id}-in`, name: 'Task', role: 'message-in' },
      { id: `${id}-out`, name: 'Result', role: 'message-out' },
    ],
    { prompt: 'Answer: {{input}}', provider: 'openai', model: 'gpt-test', ...data },
    'agent',
  );
}

/** A chat graph: portal -> a1 -> a2 (a2 is the only leaf). */
function chainGraph(portalData: Partial<PortalTriggerData> = {}): WorkflowGraph {
  return {
    nodes: [portal(portalData), agent('a1'), agent('a2')],
    connections: [edge('e1', 'portal-msg', 'a1-in'), edge('e2', 'a1-out', 'a2-in')],
  };
}

// ── 1: slug hygiene ──────────────────────────────────────────────────────────
console.log('Portal: slug hygiene');
{
  check('accepts a simple slug', isValidPortalSlug('support'));
  check('accepts dashes and digits', isValidPortalSlug('customer-intake-2'));
  check('rejects upper case', !isValidPortalSlug('Support'));
  check('rejects a leading dash', !isValidPortalSlug('-support'));
  check('rejects a trailing dash', !isValidPortalSlug('support-'));
  check('rejects a single character', !isValidPortalSlug('a'));
  check('rejects spaces', !isValidPortalSlug('my portal'));
  check('rejects path separators', !isValidPortalSlug('a/b'));
  check('rejects reserved route "api"', !isValidPortalSlug('api'));
  check('rejects reserved route "agents"', !isValidPortalSlug('agents'));
  check('rejects over-length slugs', !isValidPortalSlug('a'.repeat(49)));
  check('accepts a 48-character slug', isValidPortalSlug('a'.repeat(48)));

  check('slugifies a display name', toPortalSlug('Customer Intake') === 'customer-intake');
  check('collapses punctuation runs', toPortalSlug('Support -- Tier 1!!') === 'support-tier-1');
  check('trims to a legal length', toPortalSlug('x'.repeat(80)).length === 48);
  check('returns empty for unusable input', toPortalSlug('!!!') === '');
  check('returns empty for reserved words', toPortalSlug('API') === '');

  // Deterministic randomness keeps the assertion stable.
  const fixed = randomPortalSlug(() => 0);
  check('random slug is legal', isValidPortalSlug(fixed), fixed);
  check('random slug is prefixed', fixed.startsWith('portal-'), fixed);
  check(
    'suggestion falls back to random when the name is unusable',
    suggestPortalSlug('###', () => 0) === fixed,
  );
  check(
    'suggestion prefers the workflow name',
    suggestPortalSlug('Refund Desk', () => 0) === 'refund-desk',
  );
}

// ── 2: field keys ────────────────────────────────────────────────────────────
console.log('\nPortal: field keys');
{
  check('accepts a plain key', isValidPortalFieldKey('email'));
  check('accepts underscores and digits', isValidPortalFieldKey('order_id2'));
  check('rejects a leading digit', !isValidPortalFieldKey('2fast'));
  check('rejects dots (would break {{fields.x}})', !isValidPortalFieldKey('a.b'));
  check('rejects dashes', !isValidPortalFieldKey('order-id'));
  check('rejects an empty key', !isValidPortalFieldKey(''));
}

// ── 3: terminal leaves + responder resolution ────────────────────────────────
console.log('\nPortal: responder resolution');
{
  const leaves = terminalLeafNodes(chainGraph());
  check('single-leaf chain has one leaf', leaves.length === 1, JSON.stringify(leaves.map(l => l.id)));
  check('the leaf is the last agent', leaves[0]?.id === 'a2');
  check('auto-resolves the sole leaf', resolveResponderNodeId(chainGraph()) === 'a2');

  // Fan-out: portal -> a1 -> {a2, a3}. Two leaves = ambiguous.
  const fanOut: WorkflowGraph = {
    nodes: [portal(), agent('a1'), agent('a2'), agent('a3')],
    connections: [
      edge('e1', 'portal-msg', 'a1-in'),
      edge('e2', 'a1-out', 'a2-in'),
      edge('e3', 'a1-out', 'a3-in'),
    ],
  };
  check('two leaves resolve to null (ambiguous)', resolveResponderNodeId(fanOut) === null);
  check('an explicit leaf wins', resolveResponderNodeId(fanOut, 'a3') === 'a3');
  check(
    'a non-leaf configuration is refused, not trusted',
    resolveResponderNodeId(fanOut, 'a1') === null,
  );
  check(
    'a stale node id is refused',
    resolveResponderNodeId(fanOut, 'deleted-node') === null,
  );

  // Tool nodes hang off `tools` ports and must never count as leaves.
  const withTool: WorkflowGraph = {
    nodes: [
      portal(),
      {
        ...agent('a1'),
        ports: [
          { id: 'a1-in', name: 'Task', role: 'message-in' as const },
          { id: 'a1-out', name: 'Result', role: 'message-out' as const },
          { id: 'a1-tools', name: 'Tools', role: 'tools' as const },
        ],
      },
      node('t1', 'http-tool', [{ id: 't1-tools', name: 'Tool', role: 'tools' }], {}, 'tool'),
    ],
    connections: [
      edge('e1', 'portal-msg', 'a1-in'),
      { id: 'e2', outputId: 'a1-tools-out', inputId: 't1-tools-in', kind: 'tool-link' as const },
    ],
  };
  const toolLeaves = terminalLeafNodes(withTool);
  check('tool nodes are not leaves', !toolLeaves.some(leaf => leaf.id === 't1'));
  check('the portal trigger is not a leaf', !toolLeaves.some(leaf => leaf.id === 'portal'));
  check('auto-resolves past the tool link', resolveResponderNodeId(withTool) === 'a1');
}

// ── 4: publish validation ────────────────────────────────────────────────────
console.log('\nPortal: publish validation');
{
  const ok = validatePortal(chainGraph({ slug: 'support' }));
  check('a wired chat portal validates', ok.errors.length === 0, JSON.stringify(ok.errors));
  check('validation reports the responder', ok.responderNodeId === 'a2');
  check('a clean graph has no warnings', ok.warnings.length === 0, JSON.stringify(ok.warnings));

  const noTrigger = validatePortal({ nodes: [agent('a1')], connections: [] });
  check(
    'a graph without a portal trigger errors',
    noTrigger.errors.some(issue => issue.code === 'no-portal-trigger'),
  );

  const unwired = validatePortal({ nodes: [portal({ slug: 'x-y' })], connections: [] });
  check(
    'an unconnected portal errors',
    unwired.errors.some(issue => issue.code === 'portal-not-connected'),
  );

  const badSlug = validatePortal(chainGraph({ slug: 'Not Legal' }));
  check('an illegal slug errors', badSlug.errors.some(issue => issue.code === 'invalid-slug'));

  const taken = validatePortal(chainGraph({ slug: 'support' }), { takenSlugs: ['support'] });
  check('a claimed slug errors', taken.errors.some(issue => issue.code === 'slug-taken'));
  check(
    'the slug error names the offending node',
    taken.errors.find(issue => issue.code === 'slug-taken')?.nodeId === 'portal',
  );

  const emptyForm = validatePortal(chainGraph({ mode: 'form', fields: [] }));
  check(
    'a form with no fields errors',
    emptyForm.errors.some(issue => issue.code === 'form-without-fields'),
  );

  const badFields = validatePortal(
    chainGraph({
      mode: 'form',
      fields: [
        { key: 'ok', label: 'Fine', type: 'text' },
        { key: 'ok', label: 'Duplicate', type: 'text' },
        { key: '2bad', label: 'Bad key', type: 'text' },
        { key: 'nolabel', label: '   ', type: 'text' },
        { key: 'pick', label: 'Pick', type: 'select' },
      ],
    }),
  );
  const codes = badFields.errors.map(issue => issue.code);
  check('duplicate field keys error', codes.includes('duplicate-field-key'));
  check('invalid field keys error', codes.includes('invalid-field-key'));
  check('unlabelled fields error', codes.includes('field-without-label'));
  check('optionless dropdowns error', codes.includes('select-without-options'));

  const badResponder = validatePortal(chainGraph({ responderNodeId: 'a1' }));
  check(
    'a mid-graph responder errors',
    badResponder.errors.some(issue => issue.code === 'responder-not-terminal'),
  );

  // Ambiguity is a WARNING (publishable after confirmation), not an error.
  const ambiguous = validatePortal({
    nodes: [portal(), agent('a1'), agent('a2'), agent('a3')],
    connections: [
      edge('e1', 'portal-msg', 'a1-in'),
      edge('e2', 'a1-out', 'a2-in'),
      edge('e3', 'a1-out', 'a3-in'),
    ],
  });
  check('multiple endings warn', ambiguous.warnings.some(w => w.code === 'ambiguous-responder'));
  check('multiple endings do not block publishing', ambiguous.errors.length === 0);

  // Operator-wait nodes warn because the VISITOR is left hanging.
  const withGate: WorkflowGraph = {
    nodes: [
      portal(),
      agent('a1'),
      node(
        'gate',
        'approval-gate',
        [
          { id: 'gate-in', name: 'In', role: 'message-in' },
          { id: 'gate-ok', name: 'Approved', role: 'message-out' },
        ],
        {},
      ),
    ],
    connections: [edge('e1', 'portal-msg', 'a1-in'), edge('e2', 'a1-out', 'gate-in')],
  };
  check(
    'a reachable approval gate warns',
    validatePortal(withGate).warnings.some(w => w.code === 'approval-gate-reachable'),
  );
  check('a reachable approval gate still publishes', validatePortal(withGate).errors.length === 0);

  // An UNREACHABLE gate is somebody else's problem - don't cry wolf.
  const orphanGate: WorkflowGraph = {
    nodes: [
      ...chainGraph().nodes,
      node('gate', 'approval-gate', [{ id: 'gate-in', name: 'In', role: 'message-in' }], {}),
    ],
    connections: chainGraph().connections,
  };
  check(
    'an unreachable approval gate does not warn',
    !validatePortal(orphanGate).warnings.some(w => w.code === 'approval-gate-reachable'),
  );

  const withWait: WorkflowGraph = {
    nodes: [
      portal(),
      agent('a1'),
      node(
        'wait',
        'wait-event',
        [
          { id: 'wait-in', name: 'In', role: 'message-in' },
          { id: 'wait-out', name: 'Out', role: 'message-out' },
        ],
        {},
      ),
    ],
    connections: [edge('e1', 'portal-msg', 'a1-in'), edge('e2', 'a1-out', 'wait-in')],
  };
  check(
    'a reachable wait-for-event warns',
    validatePortal(withWait).warnings.some(w => w.code === 'wait-event-reachable'),
  );
}

// ── 5: history + input envelope ──────────────────────────────────────────────
console.log('\nPortal: transcript and input envelope');
{
  const turns: PortalTurn[] = [
    { role: 'user', text: 'Where is my order?', at: 1 },
    { role: 'assistant', text: 'It ships tomorrow.', at: 2 },
  ];
  const rendered = renderPortalHistory(turns);
  check('history labels the visitor', rendered.includes('You: Where is my order?'));
  check('history labels the assistant', rendered.includes('Assistant: It ships tomorrow.'));

  const many: PortalTurn[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `turn ${index}`,
    at: index,
  }));
  const trimmed = trimPortalHistory(many);
  check('history is capped by turn count', trimmed.length === PORTAL_MAX_HISTORY_TURNS);
  check('trimming drops the OLDEST turns', trimmed[trimmed.length - 1].text === 'turn 39');
  check('trimming never mutates the input', many.length === 40);

  const huge: PortalTurn[] = [
    { role: 'user', text: 'x'.repeat(11_000), at: 1 },
    { role: 'assistant', text: 'y'.repeat(11_000), at: 2 },
  ];
  check('history is capped by characters', trimPortalHistory(huge).length === 1);
  check('character capping keeps the newest turn', trimPortalHistory(huge)[0].text.startsWith('y'));

  const envelope = JSON.parse(
    buildPortalInput({ message: 'Hello', history: turns, sessionId: 's1', turn: 3 }),
  );
  check('envelope carries the message', envelope.message === 'Hello');
  check('envelope carries the session id', envelope.sessionId === 's1');
  check('envelope carries the turn ordinal', envelope.turn === 3);
  check('envelope renders history as text', typeof envelope.history === 'string');
  check('chat envelopes omit fields', envelope.fields === undefined);

  const formEnvelope = JSON.parse(
    buildPortalInput({ fields: { email: 'a@b.co', count: 2 }, sessionId: 's2', turn: 1 }),
  );
  check('form envelope carries fields', formEnvelope.fields.email === 'a@b.co');
  check('form envelope preserves number types', formEnvelope.fields.count === 2);
  check(
    'form envelope renders a readable message so {{input}} still works',
    formEnvelope.message.includes('email: a@b.co'),
  );
  check('first turn has empty history', formEnvelope.history === '');
}

// ── 6: field coercion ────────────────────────────────────────────────────────
console.log('\nPortal: field coercion');
{
  const schema: PortalField[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'age', label: 'Age', type: 'number' },
    { key: 'urgent', label: 'Urgent', type: 'boolean' },
    { key: 'team', label: 'Team', type: 'select', options: ['Sales', 'Support'] },
  ];

  const good = coercePortalFields(schema, {
    name: 'Ada',
    age: '41',
    urgent: 'on',
    team: 'Support',
  });
  check('valid submissions coerce', 'values' in good, JSON.stringify(good));
  if ('values' in good) {
    check('numbers are parsed', good.values.age === 41);
    check('checkbox "on" becomes true', good.values.urgent === true);
    check('text passes through', good.values.name === 'Ada');
    check('select passes through', good.values.team === 'Support');
  }

  const missing = coercePortalFields(schema, { age: '1' });
  check('required fields are enforced', 'errors' in missing);
  if ('errors' in missing) {
    check('the error names the label, not the key', missing.errors[0].includes('Name'));
  }

  check(
    'non-numeric numbers are rejected',
    'errors' in coercePortalFields(schema, { name: 'Ada', age: 'twelve' }),
  );
  check(
    'off-schema select values are rejected (server-side, not just in the page)',
    'errors' in coercePortalFields(schema, { name: 'Ada', team: 'Engineering' }),
  );
  const optional = coercePortalFields(schema, { name: 'Ada' });
  check('absent optional fields are simply omitted', 'values' in optional);
  if ('values' in optional) {
    check('omitted optionals are not defaulted', optional.values.age === undefined);
  }
}

// ── 7: visitor-facing config projection ──────────────────────────────────────
console.log('\nPortal: public config projection');
{
  const config = portalPublicConfig(
    {
      slug: 'support',
      mode: 'form',
      title: '  Help Desk  ',
      greeting: '  Hi  ',
      fields: [{ key: 'q', label: 'Question', type: 'text' }],
      access: 'token',
      responderNodeId: 'a2',
      theme: 'dark',
      showBranding: false,
    },
    'Fallback Name',
  );
  check('title is trimmed', config.title === 'Help Desk');
  check('greeting is trimmed', config.greeting === 'Hi');
  check('access carries through', config.access === 'token');
  check('theme carries through', config.theme === 'dark');
  check('branding opt-out carries through', config.showBranding === false);
  check('form fields are exposed', config.fields.length === 1);
  check(
    'the responder node id is NOT exposed to visitors',
    !JSON.stringify(config).includes('a2'),
    JSON.stringify(config),
  );

  const defaults = portalPublicConfig({ mode: 'chat', access: 'public' }, 'Fallback Name');
  check('title falls back to the workflow name', defaults.title === 'Fallback Name');
  check('greeting is omitted when empty', defaults.greeting === undefined);
  check('theme defaults to auto', defaults.theme === 'auto');
  check('branding defaults on', defaults.showBranding === true);
  check('chat mode exposes no fields', defaults.fields.length === 0);

  const chatWithFields = portalPublicConfig(
    { mode: 'chat', access: 'public', fields: [{ key: 'q', label: 'Q', type: 'text' }] },
    'X',
  );
  check('chat mode withholds stale form fields', chatWithFields.fields.length === 0);
}

// ── 8: real run - interpolation and attribution ──────────────────────────────
console.log('\nPortal: real run interpolation and attribution');
{
  const captured: string[] = [];
  const model: ModelClient = {
    stream: async function* (request: ModelRequest): AsyncIterable<ModelChunk> {
      captured.push(request.system);
      yield { type: 'text', text: 'Ships tomorrow.' };
    },
  };

  const graph: WorkflowGraph = {
    nodes: [
      portal({ slug: 'support' }),
      agent('a1', {
        prompt:
          'Visitor said: {{message}}\n\nEarlier:\n{{history}}\n\nOrder: {{fields.orderId}}\nSession: {{sessionId}}',
      }),
    ],
    connections: [edge('e1', 'portal-msg', 'a1-in')],
  };

  const input = buildPortalInput({
    message: 'Where is my order?',
    fields: { orderId: 'ORD-42' },
    history: [{ role: 'assistant', text: 'Hi there!', at: 1 }],
    sessionId: 'sess-abc',
    turn: 2,
  });

  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-portal',
    graph,
    input,
    source: 'portal',
    model,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
  });
  await handle.done;

  const system = captured[0] ?? '';
  check('{{message}} interpolates', system.includes('Visitor said: Where is my order?'), system);
  check('{{history}} interpolates', system.includes('Assistant: Hi there!'), system);
  check('{{fields.x}} interpolates', system.includes('Order: ORD-42'), system);
  check('{{sessionId}} interpolates', system.includes('Session: sess-abc'), system);

  const started = events.find(event => event.type === 'run-started');
  check('the run is attributed to the portal', started?.type === 'run-started' && started.source === 'portal');

  const completed = events.find(event => event.type === 'run-completed');
  check('the run completes', !!completed);
  check(
    'the answer is the responding agent output',
    completed?.type === 'run-completed' && completed.output.includes('Ships tomorrow.'),
  );

  // A portal run must land in history like any other run, with its source
  // preserved so the Runs panel can badge it.
  const recorder = createRunRecorder({
    runId: 'e2e-portal',
    workflowId: 'wf-1',
    workflowName: 'Support',
    source: 'portal',
    environment: 'cloud',
    graph,
  });
  for (const event of events) recorder.record(event);
  const record = recorder.snapshot();
  check('the recorded run keeps the portal source', record.summary.source === 'portal');
  check('the recorded run completed', record.summary.status === 'completed');
  check('the recorded run keeps the envelope as its input', record.summary.input === input);

  // The responder is what a visitor is allowed to see; nothing else.
  check('run-time responder is the sole agent', resolveResponderNodeId(graph) === 'a1');

  const tokenEvents = events.filter(event => event.type === 'node-token');
  check('tokens stream from the responder', tokenEvents.every(event => event.nodeId === 'a1'));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
