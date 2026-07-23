/**
 * E2E for EPIC 8 Phase 1 sub-workflow contracts and nested execution.
 * Run: npx -y tsx engine/test/subworkflows.e2e.mts
 */
import {
  MAX_SUB_WORKFLOW_DEPTH,
  ModelRequestError,
  createRunRecorder,
  startRun,
} from '../src/index.js';
import type {
  EmbeddedWorkflow,
  JournalEntry,
  ModelChunk,
  ModelClient,
  ModelRequest,
  RunEvent,
  RunLogEvent,
  WorkflowGraph,
  WorkflowNode,
} from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
  }
}

type Port = { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' };

function node(id: string, kind: string, ports: Port[], data: object = {}): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    category: kind.includes('trigger') ? 'trigger' : kind === 'agent' ? 'agent' : 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports,
    data,
  };
}

function trigger(id = 'trigger'): WorkflowNode {
  return node(id, 'manual-trigger', [{ id: `${id}-start`, name: 'Start', role: 'message-out' }]);
}

function agent(id: string, model: string): WorkflowNode {
  return node(
    id,
    'agent',
    [
      { id: `${id}-input`, name: 'Task', role: 'message-in' },
      { id: `${id}-result`, name: 'Result', role: 'message-out' },
    ],
    { prompt: `${id}: {{input}}`, provider: 'openai', model, retry: { disabled: true } },
  );
}

function executeNode(
  id: string,
  workflowId: string,
  options: { errorPort?: boolean; workflowName?: string } = {},
): WorkflowNode {
  const ports: Port[] = [
    { id: `${id}-input`, name: 'Task', role: 'message-in' },
    { id: `${id}-result`, name: 'Result', role: 'message-out' },
  ];
  if (options.errorPort) ports.push({ id: `${id}-error`, name: 'On error', role: 'message-out' });
  return node(id, 'execute-workflow', ports, {
    workflowId,
    workflowName: options.workflowName,
    errorPortId: options.errorPort ? `${id}-error` : undefined,
  });
}

function edge(id: string, fromPort: string, toPort: string) {
  return {
    id,
    outputId: `${fromPort}-out`,
    inputId: `${toPort}-in`,
    kind: 'handoff' as const,
  };
}

function graph(nodes: WorkflowNode[], connections: ReturnType<typeof edge>[]): WorkflowGraph {
  return { nodes, connections };
}

function embedded(id: string, workflowGraph: WorkflowGraph, settings?: { timeoutMinutes?: number }): EmbeddedWorkflow {
  return { id, name: id, graph: workflowGraph, settings };
}

function linearChild(id: string, agentId = `${id}-agent`, model = id): EmbeddedWorkflow {
  const start = trigger(`${id}-trigger`);
  const worker = agent(agentId, model);
  return embedded(
    id,
    graph([start, worker], [edge(`${id}-edge`, `${id}-trigger-start`, `${agentId}-input`)]),
  );
}

function scriptedModel(
  handler: (request: ModelRequest) => string | Error,
  usage = true,
): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const result = handler(request);
      if (result instanceof Error) throw result;
      yield { type: 'text', text: result };
      if (usage) {
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.001, costSource: 'reported' },
        };
      }
    },
  };
}

async function run(
  parentGraph: WorkflowGraph,
  options: Partial<Parameters<typeof startRun>[0]> = {},
): Promise<{ events: RunEvent[]; handle: ReturnType<typeof startRun> }> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'sub-e2e',
    graph: parentGraph,
    input: 'seed',
    model: scriptedModel(request => `${request.model}(${request.messages[0]?.role === 'user' ? request.messages[0].content : ''})`),
    emit: event => events.push(event),
    requestApproval: async () => true,
    ...options,
  });
  await handle.done;
  return { events, handle };
}

function finalEvent(events: RunEvent[]): RunEvent | undefined {
  return events.at(-1);
}

function completedOutput(events: RunEvent[]): string | undefined {
  const completed = events.find(event => event.type === 'run-completed');
  return completed?.type === 'run-completed' ? completed.output : undefined;
}

console.log('E2E: nested output, lifecycle, scope, usage, and one record');
{
  const child = linearChild('child', 'shared-agent', 'child-model');
  const start = trigger();
  const execute = executeNode('execute-child', child.id);
  const finish = agent('finish', 'parent-model');
  const parent = graph(
    [start, execute, finish],
    [
      edge('p1', 'trigger-start', 'execute-child-input'),
      edge('p2', 'execute-child-result', 'finish-input'),
    ],
  );
  const events: RunEvent[] = [];
  const recorder = createRunRecorder({
    runId: 'nested-record',
    workflowId: 'parent',
    workflowName: 'Parent',
    source: 'manual',
    environment: 'local',
    graph: parent,
  });
  const handle = startRun({
    runId: 'nested-record',
    graph: parent,
    input: 'seed',
    subWorkflows: { child },
    model: scriptedModel(request => `${request.model}(${request.messages[0]?.role === 'user' ? request.messages[0].content : ''})`),
    emit: event => {
      events.push(event);
      recorder.record(event);
    },
    requestApproval: async () => true,
  });
  await handle.done;

  check('only one run-started event', events.filter(event => event.type === 'run-started').length === 1);
  check('only one run-completed event', events.filter(event => event.type === 'run-completed').length === 1);
  check('one subworkflow-started event', events.filter(event => event.type === 'subworkflow-started').length === 1);
  check('one subworkflow-completed event', events.filter(event => event.type === 'subworkflow-completed').length === 1);
  check(
    'child output propagates to the parent successor',
    completedOutput(events) === 'parent-model(child-model(seed))',
    completedOutput(events),
  );
  const childAgentStarted = events.find(
    event => event.type === 'node-started' && event.nodeId === 'shared-agent',
  );
  check(
    'child interior event has a root-to-leaf scope path',
    childAgentStarted?.scope?.length === 1 &&
      childAgentStarted.scope[0]?.nodeId === 'execute-child' &&
      childAgentStarted.scope[0]?.workflowId === 'child' &&
      childAgentStarted.scope[0]?.depth === 1,
    JSON.stringify(childAgentStarted?.scope),
  );
  const boundary = events.find(event => event.type === 'subworkflow-started');
  check('top-level boundary event is unscoped', boundary?.scope === undefined);
  const record = recorder.snapshot();
  check('one parent run record settled completed', recorder.settled && record.summary.status === 'completed');
  check('child usage contributes to parent totals', record.summary.usage.inputTokens === 4);
  check(
    'child usage rollup uses a scope-aware key',
    Object.keys(record.summary.usage.byNode ?? {}).some(key =>
      key.includes('execute-child|') && key.endsWith('/shared-agent'),
    ),
    JSON.stringify(Object.keys(record.summary.usage.byNode ?? {})),
  );
  check('final output stored on parent summary', record.summary.output === 'parent-model(child-model(seed))');
}

console.log('\nE2E: resolver precedence and embedded fallback');
{
  const snapshot = linearChild('target', 'worker', 'snapshot-model');
  const current = linearChild('target', 'worker', 'current-model');
  const parent = graph(
    [trigger(), executeNode('execute', 'target')],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  let resolves = 0;
  const resolved = await run(parent, {
    subWorkflows: { target: snapshot },
    resolveWorkflow: workflowId => {
      resolves += 1;
      return workflowId === 'target' ? current : undefined;
    },
  });
  check('host resolver was consulted', resolves === 1, String(resolves));
  check('host resolver wins over embedded snapshot', completedOutput(resolved.events) === 'current-model(seed)');

  const fallback = await run(parent, {
    subWorkflows: { target: snapshot },
    resolveWorkflow: () => undefined,
  });
  check('flat embedded registry is the resolver fallback', completedOutput(fallback.events) === 'snapshot-model(seed)');
}

console.log('\nE2E: missing target fails descriptively');
{
  const parent = graph(
    [trigger(), executeNode('execute', 'missing', { workflowName: 'Missing Workflow' })],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent);
  const failed = finalEvent(events);
  check(
    'missing workflow fails the run',
    failed?.type === 'run-failed' && failed.error.includes('could not resolve workflow') && failed.error.includes('Missing Workflow'),
    failed?.type === 'run-failed' ? failed.error : JSON.stringify(failed),
  );
}

console.log('\nE2E: execute node error branch');
{
  const broken = linearChild('broken', 'broken-agent', 'broken-model');
  const start = trigger();
  const execute = executeNode('execute', 'broken', { errorPort: true });
  const next = agent('next', 'next-model');
  const rescue = agent('rescue', 'rescue-model');
  const parent = graph(
    [start, execute, next, rescue],
    [
      edge('e1', 'trigger-start', 'execute-input'),
      edge('e2', 'execute-result', 'next-input'),
      edge('e3', 'execute-error', 'rescue-input'),
    ],
  );
  const { events } = await run(parent, {
    subWorkflows: { broken },
    model: scriptedModel(request =>
      request.model === 'broken-model'
        ? new ModelRequestError('child rejected', 401)
        : `${request.model}:${request.messages[0]?.role === 'user' ? request.messages[0].content : ''}`,
    ),
  });
  check('run completes through execute error branch', finalEvent(events)?.type === 'run-completed');
  check('subworkflow-failed emitted', events.some(event => event.type === 'subworkflow-failed'));
  check('execute node emitted node-error-routed', events.some(event => event.type === 'node-error-routed' && event.nodeId === 'execute'));
  check('success branch stayed inert', !events.some(event => event.type === 'node-started' && event.nodeId === 'next'));
  check('error branch executed rescue node', events.some(event => event.type === 'node-started' && event.nodeId === 'rescue'));
  check('error payload propagated', completedOutput(events)?.includes('child rejected') === true, completedOutput(events));
}

function recursiveWorkflow(id: string, targetId: string): EmbeddedWorkflow {
  const start = trigger(`${id}-trigger`);
  const execute = executeNode(`${id}-execute`, targetId);
  return embedded(
    id,
    graph([start, execute], [edge(`${id}-edge`, `${id}-trigger-start`, `${id}-execute-input`)]),
  );
}

console.log('\nE2E: default depth and self recursion');
{
  const self = recursiveWorkflow('self', 'self');
  const parent = graph(
    [trigger(), executeNode('execute', 'self')],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent, { subWorkflows: { self } });
  const started = events.filter(event => event.type === 'subworkflow-started');
  const failed = finalEvent(events);
  check('recursion is allowed through depth 2', started.length === 2, String(started.length));
  check(
    'default depth 2 bounds recursion',
    failed?.type === 'run-failed' && failed.error.includes('depth limit (2)'),
    failed?.type === 'run-failed' ? failed.error : JSON.stringify(failed),
  );
  const deepestInterior = events.find(
    event => event.type === 'node-started' && event.scope?.length === 2,
  );
  check('deep child events preserve the full scope path', deepestInterior?.scope?.map(scope => scope.depth).join(',') === '1,2');
}

console.log('\nE2E: mutual recursion is allowed but bounded');
{
  const a = recursiveWorkflow('a', 'b');
  const b = recursiveWorkflow('b', 'a');
  const parent = graph(
    [trigger(), executeNode('execute', 'a')],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent, {
    subWorkflows: { a, b },
    maxSubWorkflowDepth: 5,
  });
  const started = events.filter(event => event.type === 'subworkflow-started');
  check('five mutual recursion frames start', started.length === 5, String(started.length));
  check(
    'mutual recursion alternates targets',
    started.map(event => event.type === 'subworkflow-started' ? event.workflowId : '').join(',') === 'a,b,a,b,a',
  );
  const failed = finalEvent(events);
  check('mutual recursion stops at configured limit', failed?.type === 'run-failed' && failed.error.includes('depth limit (5)'));
}

console.log('\nE2E: hard depth cap');
{
  const self = recursiveWorkflow('self', 'self');
  const parent = graph(
    [trigger(), executeNode('execute', 'self')],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent, {
    subWorkflows: { self },
    maxSubWorkflowDepth: 999,
  });
  const started = events.filter(event => event.type === 'subworkflow-started');
  const failed = finalEvent(events);
  check('hard ceiling constant is 25', MAX_SUB_WORKFLOW_DEPTH === 25);
  check('host override is clamped to 25 frames', started.length === 25, String(started.length));
  check('failure reports hard cap 25', failed?.type === 'run-failed' && failed.error.includes('depth limit (25)'));
}

console.log('\nE2E: global execution budget spans child frames');
{
  const child = linearChild('child', 'child-agent', 'child-model');
  const parent = graph(
    [trigger(), executeNode('execute', 'child')],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent, {
    subWorkflows: { child },
    maxExecutions: 3,
  });
  const failed = finalEvent(events);
  check(
    'child does not receive a fresh execution budget',
    failed?.type === 'run-failed' && failed.error.includes('execution budget (3 node executions)'),
    failed?.type === 'run-failed' ? failed.error : JSON.stringify(failed),
  );
}

console.log('\nE2E: child shares approval and wait callbacks');
{
  const childStart = trigger('child-trigger');
  const approval = node(
    'approve',
    'approval-gate',
    [
      { id: 'approve-input', name: 'Task', role: 'message-in' },
      { id: 'approve-yes', name: 'Approved', role: 'message-out' },
    ],
    { message: 'Approve child' },
  );
  const wait = node(
    'wait',
    'wait-event',
    [
      { id: 'wait-input', name: 'Task', role: 'message-in' },
      { id: 'wait-result', name: 'Result', role: 'message-out' },
    ],
    { correlationKey: 'child-key' },
  );
  const child = embedded(
    'callback-child',
    graph(
      [childStart, approval, wait],
      [
        edge('c1', 'child-trigger-start', 'approve-input'),
        edge('c2', 'approve-yes', 'wait-input'),
      ],
    ),
  );
  const parent = graph(
    [trigger(), executeNode('execute', child.id)],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  let approvals = 0;
  let waits = 0;
  const { events } = await run(parent, {
    subWorkflows: { [child.id]: child },
    requestApproval: async () => {
      approvals += 1;
      return true;
    },
    waitForEvent: async (_nodeId, key) => {
      waits += 1;
      return JSON.stringify({ delivered: key });
    },
  });
  check('child used the parent approval callback', approvals === 1);
  check('child used the parent wait callback', waits === 1);
  check('callback result becomes child output', completedOutput(events)?.includes('child-key') === true);
  const waitStarted = events.find(event => event.type === 'wait-started');
  check('callback lifecycle event remains scoped', waitStarted?.scope?.[0]?.workflowId === child.id);
}

console.log('\nE2E: child workflow settings and error handler are inert');
{
  const childStart = trigger('child-trigger');
  const broken = agent('broken', 'broken-model');
  const handler = node('child-handler', 'error-handler', [
    { id: 'handler-result', name: 'Error', role: 'message-out' },
  ]);
  const notifier = agent('notifier', 'notifier-model');
  const child = embedded(
    'inert-child',
    graph(
      [childStart, broken, handler, notifier],
      [
        edge('c1', 'child-trigger-start', 'broken-input'),
        edge('c2', 'handler-result', 'notifier-input'),
      ],
    ),
    { timeoutMinutes: 0.000001 },
  );
  const parent = graph(
    [trigger(), executeNode('execute', child.id)],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const { events } = await run(parent, {
    subWorkflows: { [child.id]: child },
    model: scriptedModel(request =>
      request.model === 'broken-model'
        ? new ModelRequestError('child failed', 400)
        : 'handler should not run',
    ),
  });
  check('child failure reaches the parent run', finalEvent(events)?.type === 'run-failed');
  check('child error handler node never starts', !events.some(event => event.type === 'node-started' && event.nodeId === 'child-handler'));
  check('child notifier never starts', !events.some(event => event.type === 'node-started' && event.nodeId === 'notifier'));
  const failed = finalEvent(events);
  check('child timeout setting does not replace parent timeout', failed?.type === 'run-failed' && failed.error.includes('child failed'));
}

console.log('\nE2E: child workflow timeout setting is ignored');
{
  const child = linearChild('tiny-timeout-child', 'delayed-agent', 'delayed-model');
  child.settings = { timeoutMinutes: 0.000001 };
  const parent = graph(
    [trigger(), executeNode('execute', child.id)],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const delayedModel: ModelClient = {
    async *stream(): AsyncIterable<ModelChunk> {
      await new Promise(resolve => setTimeout(resolve, 30));
      yield { type: 'text', text: 'finished under parent ownership' };
    },
  };
  const { events } = await run(parent, {
    subWorkflows: { [child.id]: child },
    model: delayedModel,
  });
  check('child setting does not arm a separate timeout', finalEvent(events)?.type === 'run-completed');
  check('child output still propagates', completedOutput(events) === 'finished under parent ownership');
}

console.log('\nE2E: parent workflow timeout governs a child frame');
{
  const child = linearChild('slow-child', 'slow-agent', 'slow-model');
  const parent = graph(
    [trigger(), executeNode('execute', child.id)],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const slowModel: ModelClient = {
    async *stream(): AsyncIterable<ModelChunk> {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 20));
        yield { type: 'text', text: 'x' };
      }
    },
  };
  const startedAt = Date.now();
  const { events } = await run(parent, {
    subWorkflows: { [child.id]: child },
    model: slowModel,
    runTimeoutMs: 100,
  });
  const elapsed = Date.now() - startedAt;
  const failed = finalEvent(events);
  check('parent timeout fails nested execution', failed?.type === 'run-failed' && failed.error.includes('Workflow timed out'));
  check('parent timeout unwinds promptly', elapsed < 1500, `${elapsed}ms`);
}

console.log('\nE2E: nested journal replay resumes without repeating child approval');
{
  const childStart = trigger('child-trigger');
  const approval = node(
    'approve',
    'approval-gate',
    [
      { id: 'approve-input', name: 'Task', role: 'message-in' },
      { id: 'approve-yes', name: 'Approved', role: 'message-out' },
    ],
    { message: 'Approve once' },
  );
  const wait = node(
    'wait',
    'wait-event',
    [
      { id: 'wait-input', name: 'Task', role: 'message-in' },
      { id: 'wait-result', name: 'Result', role: 'message-out' },
    ],
    { correlationKey: 'resume-key' },
  );
  const child = embedded(
    'journal-child',
    graph(
      [childStart, approval, wait],
      [
        edge('c1', 'child-trigger-start', 'approve-input'),
        edge('c2', 'approve-yes', 'wait-input'),
      ],
    ),
  );
  const parent = graph(
    [trigger(), executeNode('execute', child.id)],
    [edge('e1', 'trigger-start', 'execute-input')],
  );
  const store = new Map<string, JournalEntry>();
  const journal = {
    lookup: (key: string) => store.get(key),
    record: (key: string, entry: JournalEntry) => store.set(key, entry),
  };

  let approvals1 = 0;
  let suspended!: () => void;
  const suspendedSignal = new Promise<void>(resolve => (suspended = resolve));
  startRun({
    runId: 'journal-run',
    graph: parent,
    input: 'seed',
    subWorkflows: { [child.id]: child },
    journal,
    model: scriptedModel(() => 'unused'),
    emit: () => {},
    requestApproval: async () => {
      approvals1 += 1;
      return true;
    },
    waitForEvent: async () => {
      suspended();
      return new Promise<string>(() => {});
    },
  });
  await suspendedSignal;
  check('first attempt approved once', approvals1 === 1);
  const executePrefix = [...store.keys()]
    .find(key => key.startsWith('execute|'))
    ?.split('/')[0];
  check(
    'nested journal keys use the deterministic execute wrapper key',
    !!executePrefix && [...store.keys()].some(key => key.startsWith(`${executePrefix}/`)),
    JSON.stringify([...store.keys()]),
  );

  let approvals2 = 0;
  let waits2 = 0;
  const events2: RunEvent[] = [];
  const handle2 = startRun({
    runId: 'journal-run',
    graph: parent,
    input: 'seed',
    subWorkflows: { [child.id]: child },
    journal,
    model: scriptedModel(() => 'unused'),
    emit: event => events2.push(event),
    requestApproval: async () => {
      approvals2 += 1;
      return true;
    },
    waitForEvent: async () => {
      waits2 += 1;
      return '{"resumed":true}';
    },
  });
  await handle2.done;
  check('completed child approval replayed from journal', approvals2 === 0, String(approvals2));
  check('unfinished child wait executed once', waits2 === 1, String(waits2));
  check('resumed parent run completed', finalEvent(events2)?.type === 'run-completed');
}

console.log('\nE2E: parallel child approvals have unique deterministic request ids');
{
  const childStart = trigger('approval-trigger');
  const approval = node(
    'shared-approval',
    'approval-gate',
    [
      { id: 'shared-approval-input', name: 'Task', role: 'message-in' },
      { id: 'shared-approval-yes', name: 'Approved', role: 'message-out' },
    ],
    { message: 'Approve this child frame' },
  );
  const child = embedded(
    'parallel-approval-child',
    graph(
      [childStart, approval],
      [edge('approval-edge', 'approval-trigger-start', 'shared-approval-input')],
    ),
  );
  const start = trigger();
  const parallel = node(
    'parallel',
    'parallel',
    [
      { id: 'parallel-input', name: 'Task', role: 'message-in' },
      { id: 'parallel-left', name: 'Left', role: 'message-out' },
      { id: 'parallel-right', name: 'Right', role: 'message-out' },
    ],
  );
  const left = executeNode('execute-left', child.id);
  const right = executeNode('execute-right', child.id);
  const parent = graph(
    [start, parallel, left, right],
    [
      edge('p-start', 'trigger-start', 'parallel-input'),
      edge('p-left', 'parallel-left', 'execute-left-input'),
      edge('p-right', 'parallel-right', 'execute-right-input'),
    ],
  );
  const callbackIds: string[] = [];
  const { events } = await run(parent, {
    subWorkflows: { [child.id]: child },
    requestApproval: async (_nodeId, _message, _payload, requestId) => {
      callbackIds.push(requestId);
      return true;
    },
  });
  const required = events.filter(
    (event): event is Extract<RunEvent, { type: 'approval-required' }> =>
      event.type === 'approval-required',
  );
  const resolved = events.filter(
    (event): event is Extract<RunEvent, { type: 'approval-resolved' }> =>
      event.type === 'approval-resolved',
  );
  check('both sibling child approvals were requested', required.length === 2, String(required.length));
  check('callback receives two distinct request ids', new Set(callbackIds).size === 2, JSON.stringify(callbackIds));
  check(
    'required and resolved events preserve their request ids',
    required.every(event => resolved.some(item => item.requestId === event.requestId)),
    JSON.stringify({ required, resolved }),
  );
  check(
    'request ids include distinct execute frame identities',
    callbackIds.some(id => id.includes('execute-left|')) &&
      callbackIds.some(id => id.includes('execute-right|')),
    JSON.stringify(callbackIds),
  );
}

console.log('\nE2E: repeated child frames with the same approval node have unique request ids');
{
  const childStart = trigger('repeated-trigger');
  const approval = node(
    'repeated-approval',
    'approval-gate',
    [
      { id: 'repeated-approval-input', name: 'Task', role: 'message-in' },
      { id: 'repeated-approval-yes', name: 'Approved', role: 'message-out' },
    ],
    { message: 'Approve repeated child' },
  );
  const child = embedded(
    'repeated-child',
    graph(
      [childStart, approval],
      [edge('repeated-edge', 'repeated-trigger-start', 'repeated-approval-input')],
    ),
  );
  const start = trigger();
  const loop = node(
    'child-loop',
    'for-each',
    [
      { id: 'child-loop-input', name: 'Task', role: 'message-in' },
      { id: 'child-loop-each', name: 'Each item', role: 'message-out' },
      { id: 'child-loop-done', name: 'Done', role: 'message-out' },
    ],
  );
  const execute = executeNode('execute-repeated', child.id);
  const parent = graph(
    [start, loop, execute],
    [
      edge('loop-start', 'trigger-start', 'child-loop-input'),
      edge('loop-child', 'child-loop-each', 'execute-repeated-input'),
    ],
  );
  const requestIds: string[] = [];
  const { events } = await run(parent, {
    input: '["same","same"]',
    subWorkflows: { [child.id]: child },
    requestApproval: async (_nodeId, _message, _payload, requestId) => {
      requestIds.push(requestId);
      return true;
    },
  });
  check('both repeated frames requested approval', requestIds.length === 2, JSON.stringify(requestIds));
  check(
    'repeated identical frames use occurrence-aware request ids',
    new Set(requestIds).size === 2 &&
      requestIds.some(id => /execute-repeated\|[^/]+\|0\/repeated-approval\|/.test(id)) &&
      requestIds.some(id => /execute-repeated\|[^/]+\|1\/repeated-approval\|/.test(id)),
    JSON.stringify(requestIds),
  );
  check('repeated-frame run completed', finalEvent(events)?.type === 'run-completed');
}

console.log('\nE2E: completed execute wrappers replay child journals and nested trace');
{
  const approvalChild = (id: string, approvalId: string): EmbeddedWorkflow => {
    const start = trigger(`${id}-trigger`);
    const approval = node(
      approvalId,
      'approval-gate',
      [
        { id: `${approvalId}-input`, name: 'Task', role: 'message-in' },
        { id: `${approvalId}-yes`, name: 'Approved', role: 'message-out' },
      ],
      { message: `Approve ${id}` },
    );
    return embedded(
      id,
      graph([start, approval], [edge(`${id}-edge`, `${id}-trigger-start`, `${approvalId}-input`)]),
    );
  };

  const early = approvalChild('early-child', 'early-approval');
  const grandchild = approvalChild('grandchild', 'nested-approval');
  const nestedStart = trigger('nested-trigger');
  const nestedExecute = executeNode('nested-execute', grandchild.id);
  const nestedWait = node(
    'nested-wait',
    'wait-event',
    [
      { id: 'nested-wait-input', name: 'Task', role: 'message-in' },
      { id: 'nested-wait-result', name: 'Result', role: 'message-out' },
    ],
    { correlationKey: 'nested-resume' },
  );
  const nested = embedded(
    'nested-child',
    graph(
      [nestedStart, nestedExecute, nestedWait],
      [
        edge('nested-start-edge', 'nested-trigger-start', 'nested-execute-input'),
        edge('nested-wait-edge', 'nested-execute-result', 'nested-wait-input'),
      ],
    ),
  );
  const parent = graph(
    [trigger(), executeNode('execute-early', early.id), executeNode('execute-nested', nested.id)],
    [
      edge('parent-early', 'trigger-start', 'execute-early-input'),
      edge('parent-nested', 'execute-early-result', 'execute-nested-input'),
    ],
  );
  const registry = { [early.id]: early, [nested.id]: nested, [grandchild.id]: grandchild };
  const store = new Map<string, JournalEntry>();
  const journal = {
    lookup: (key: string) => store.get(key),
    record: (key: string, entry: JournalEntry) => store.set(key, entry),
  };

  const firstApprovalIds: string[] = [];
  let suspended!: () => void;
  const suspendedSignal = new Promise<void>(resolve => (suspended = resolve));
  startRun({
    runId: 'wrapper-replay',
    graph: parent,
    input: 'seed',
    subWorkflows: registry,
    journal,
    model: scriptedModel(() => 'unused'),
    emit: () => {},
    requestApproval: async (_nodeId, _message, _payload, requestId) => {
      firstApprovalIds.push(requestId);
      return true;
    },
    waitForEvent: async () => {
      suspended();
      return new Promise<string>(() => {});
    },
  });
  await suspendedSignal;
  const firstKeys = [...store.keys()].sort();
  check('first attempt completed both approvals', firstApprovalIds.length === 2, JSON.stringify(firstApprovalIds));
  check(
    'nested journals are namespaced by both execute wrapper keys',
    firstKeys.some(key => key.includes('/nested-execute|') && key.includes('/nested-approval|')),
    JSON.stringify(firstKeys),
  );

  const replayApprovalIds: string[] = [];
  const replayEvents: RunEvent[] = [];
  const replay = startRun({
    runId: 'wrapper-replay',
    graph: parent,
    input: 'seed',
    subWorkflows: registry,
    journal,
    model: scriptedModel(() => 'unused'),
    emit: event => replayEvents.push(event),
    requestApproval: async (_nodeId, _message, _payload, requestId) => {
      replayApprovalIds.push(requestId);
      return true;
    },
    waitForEvent: async () => '{"resumed":true}',
  });
  await replay.done;
  check('completed child approvals do not repeat on resume', replayApprovalIds.length === 0);
  check(
    'resume keeps prior journal prefixes',
    firstKeys.every(key => store.has(key)),
    JSON.stringify([...store.keys()]),
  );
  const replayStarts = replayEvents.filter(
    (event): event is Extract<RunEvent, { type: 'subworkflow-started' }> =>
      event.type === 'subworkflow-started',
  );
  check(
    'completed wrapper replays reconstruct both top-level child boundaries',
    replayStarts.some(event => event.workflowId === early.id && !event.scope?.length) &&
      replayStarts.some(event => event.workflowId === nested.id && !event.scope?.length),
    JSON.stringify(replayStarts),
  );
  const nestedApprovalReplay = replayEvents.find(
    event => event.type === 'node-completed' && event.nodeId === 'nested-approval',
  );
  check(
    'nested trace reconstructs at depth two from child journals',
    nestedApprovalReplay?.scope?.length === 2 &&
      nestedApprovalReplay.scope[1]?.workflowId === grandchild.id,
    JSON.stringify(nestedApprovalReplay),
  );
  check('resumed run completes', finalEvent(replayEvents)?.type === 'run-completed');
}

console.log('\nE2E: recorder coalescing distinguishes scope');
{
  const childA = linearChild('child-a', 'same-agent', 'model-a');
  const childB = linearChild('child-b', 'same-agent', 'model-b');
  const start = trigger();
  const executeA = executeNode('execute-a', childA.id);
  const executeB = executeNode('execute-b', childB.id);
  const parent = graph(
    [start, executeA, executeB],
    [
      edge('e1', 'trigger-start', 'execute-a-input'),
      edge('e2', 'execute-a-result', 'execute-b-input'),
    ],
  );
  const recorder = createRunRecorder({
    runId: 'scope-record',
    workflowId: 'parent',
    workflowName: 'Parent',
    source: 'manual',
    environment: 'local',
    graph: parent,
  });
  const handle = startRun({
    runId: 'scope-record',
    graph: parent,
    input: 'seed',
    subWorkflows: { [childA.id]: childA, [childB.id]: childB },
    model: scriptedModel(request => `${request.model}-output`),
    emit: event => recorder.record(event),
    requestApproval: async () => true,
  });
  await handle.done;
  const outputs = recorder.snapshot().events.filter(
    (event): event is Extract<RunLogEvent, { type: 'node-output-text' }> =>
      event.type === 'node-output-text' && event.nodeId === 'same-agent',
  );
  check('same node id in two scopes creates two stream entries', outputs.length === 2, String(outputs.length));
  check(
    'coalesced entries retain distinct scope paths',
    outputs.map(event => event.scope?.[0]?.workflowId).join(',') === 'child-a,child-b',
    JSON.stringify(outputs.map(event => event.scope)),
  );
  check('each scoped stream keeps its own text', outputs.map(event => event.text).join(',') === 'model-a-output,model-b-output');
  const usageKeys = Object.keys(recorder.summary().usage.byNode ?? {});
  check(
    'same node id in sibling frames creates two usage buckets',
    usageKeys.filter(key => key.endsWith('/same-agent')).length === 2,
    JSON.stringify(usageKeys),
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
