import { extractSubWorkflow } from './subworkflow-extract';
import type {
  NodeCategory,
  WorkflowConnection,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowPort,
} from './workflow.model';

function node(
  id: string,
  kind: WorkflowNodeKind,
  category: NodeCategory,
  x: number,
  ports: Array<[string, WorkflowPort['role']]>,
): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    category,
    icon: 'ti ti-box',
    position: { x, y: 20 },
    ports: ports.map(([name, role]) => ({ id: `${id}-${name}`, name, role })),
    data: kind === 'agent' ? { prompt: '{{input}}' } : {},
  };
}

function trigger(id: string): WorkflowNode {
  return node(id, 'manual-trigger', 'trigger', 0, [['start', 'message-out']]);
}

function agent(id: string, x: number): WorkflowNode {
  return node(id, 'agent', 'agent', x, [
    ['task', 'message-in'],
    ['result', 'message-out'],
    ['tools', 'tools'],
  ]);
}

function tool(id: string, x: number): WorkflowNode {
  return node(id, 'http-tool', 'tool', x, [['tool', 'tools']]);
}

function errorHandler(id: string): WorkflowNode {
  return node(id, 'error-handler', 'flow', 0, [['error', 'message-out']]);
}

function edge(
  id: string,
  outputBase: string,
  inputBase: string,
  kind: WorkflowConnection['kind'] = 'handoff',
): WorkflowConnection {
  return {
    id,
    outputId: `${outputBase}-out`,
    inputId: `${inputBase}-in`,
    kind,
  };
}

function extract(graph: WorkflowGraph, ids: string[]) {
  return extractSubWorkflow(graph, new Set(ids), {
    workflowId: 'wf-child',
    workflowName: 'Extracted Work',
    savedAt: '2026-07-23T00:00:00.000Z',
  });
}

describe('extractSubWorkflow', () => {
  it('rejects empty, trigger, and error-handler selections', () => {
    const graph = { nodes: [trigger('start'), errorHandler('handler')], connections: [] };
    expect(extract(graph, []).ok).toBeFalse();

    const triggerResult = extract(graph, ['start']);
    expect(triggerResult.ok).toBeFalse();
    if (!triggerResult.ok) expect(triggerResult.error).toContain('Triggers');

    const handlerResult = extract(graph, ['handler']);
    expect(handlerResult.ok).toBeFalse();
    if (!handlerResult.ok) expect(handlerResult.error).toContain('Error Handler');
  });

  it('rejects ambiguous incoming and outgoing handoff boundaries', () => {
    const beforeA = agent('before-a', 0);
    const beforeB = agent('before-b', 0);
    const selected = agent('selected', 300);
    const afterA = agent('after-a', 600);
    const afterB = agent('after-b', 600);
    const graph: WorkflowGraph = {
      nodes: [beforeA, beforeB, selected, afterA, afterB],
      connections: [
        edge('in-a', 'before-a-result', 'selected-task'),
        edge('in-b', 'before-b-result', 'selected-task'),
        edge('out-a', 'selected-result', 'after-a-task'),
        edge('out-b', 'selected-result', 'after-b-task'),
      ],
    };

    const incoming = extract(graph, ['selected']);
    expect(incoming.ok).toBeFalse();
    if (!incoming.ok) expect(incoming.error).toContain('multiple incoming');

    graph.connections = graph.connections.filter(connection => connection.id !== 'in-b');
    const outgoing = extract(graph, ['selected']);
    expect(outgoing.ok).toBeFalse();
    if (!outgoing.ok) expect(outgoing.error).toContain('multiple outgoing');
  });

  it('preserves internal edges, adds a manual trigger, and rewires parent boundaries', () => {
    const start = trigger('start');
    const first = agent('first', 260);
    const second = agent('second', 560);
    const finish = agent('finish', 860);
    const graph: WorkflowGraph = {
      nodes: [start, first, second, finish],
      connections: [
        edge('incoming', 'start-start', 'first-task'),
        edge('internal', 'first-result', 'second-task'),
        edge('outgoing', 'second-result', 'finish-task'),
      ],
    };

    const result = extract(graph, ['first', 'second']);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;

    const child = result.value.childSpec.graph;
    expect(child.nodes.filter(item => item.kind === 'manual-trigger').length).toBe(1);
    expect(child.nodes.some(item => item.id === 'first')).toBeTrue();
    expect(child.nodes.some(item => item.id === 'second')).toBeTrue();
    expect(child.connections.some(connection => connection.id === 'internal')).toBeTrue();
    expect(child.connections.some(connection => connection.inputId === 'first-task-in')).toBeTrue();

    const parent = result.value.parentGraph;
    expect(parent.nodes.some(item => item.id === 'first')).toBeFalse();
    expect(parent.nodes.some(item => item.id === 'second')).toBeFalse();
    expect(parent.nodes.some(item => item.id === 'finish')).toBeTrue();
    const replacement = result.value.replacementNode;
    expect(replacement.kind).toBe('execute-workflow');
    expect(replacement.data).toEqual(
      jasmine.objectContaining({ workflowId: 'wf-child', workflowName: 'Extracted Work' }),
    );
    expect(parent.connections.find(connection => connection.id === 'incoming')?.inputId)
      .toBe(`${replacement.ports.find(port => port.role === 'message-in')!.id}-in`);
    expect(parent.connections.find(connection => connection.id === 'outgoing')?.outputId)
      .toBe(`${replacement.ports.find(port => port.role === 'message-out')!.id}-out`);
    expect(replacement.position.x).toBe(410);
  });

  it('moves unshared tools and clones tools shared with unselected agents', () => {
    const selected = agent('selected', 200);
    const unselected = agent('unselected', 800);
    const privateTool = tool('private-tool', 300);
    const sharedTool = tool('shared-tool', 500);
    const graph: WorkflowGraph = {
      nodes: [selected, unselected, privateTool, sharedTool],
      connections: [
        edge('selected-private', 'selected-tools', 'private-tool-tool', 'tool-link'),
        edge('selected-shared', 'selected-tools', 'shared-tool-tool', 'tool-link'),
        edge('unselected-shared', 'unselected-tools', 'shared-tool-tool', 'tool-link'),
      ],
    };

    const result = extract(graph, ['selected']);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;

    expect(result.value.childSpec.graph.nodes.map(item => item.id)).toContain('private-tool');
    expect(result.value.childSpec.graph.nodes.map(item => item.id)).toContain('shared-tool');
    expect(result.value.parentGraph.nodes.map(item => item.id)).not.toContain('private-tool');
    expect(result.value.parentGraph.nodes.map(item => item.id)).toContain('shared-tool');
    expect(result.value.clonedToolIds).toEqual(['shared-tool']);
    expect(result.value.parentGraph.connections.map(item => item.id)).toContain('unselected-shared');
    expect(result.value.parentGraph.connections.map(item => item.id)).not.toContain('selected-shared');
  });

  it('rejects selections without a unique child entry or terminal', () => {
    const a = agent('a', 0);
    const b = agent('b', 300);
    const disconnected: WorkflowGraph = { nodes: [a, b], connections: [] };
    const entryResult = extract(disconnected, ['a', 'b']);
    expect(entryResult.ok).toBeFalse();
    if (!entryResult.ok) expect(entryResult.error).toContain('entry');

    const forked: WorkflowGraph = {
      nodes: [a, b, agent('c', 600)],
      connections: [
        edge('a-b', 'a-result', 'b-task'),
        edge('a-c', 'a-result', 'c-task'),
      ],
    };
    const terminalResult = extract(forked, ['a', 'b', 'c']);
    expect(terminalResult.ok).toBeFalse();
    if (!terminalResult.ok) expect(terminalResult.error).toContain('terminal');
  });

  it('rejects a boundary attached to a non-entry or non-terminal selected node', () => {
    const before = agent('before', -300);
    const a = agent('a', 0);
    const b = agent('b', 300);
    const after = agent('after', 600);
    const invalidEntry: WorkflowGraph = {
      nodes: [before, a, b],
      connections: [
        edge('cycle-a-b', 'a-result', 'b-task'),
        edge('cycle-b-a', 'b-result', 'a-task'),
        edge('incoming', 'before-result', 'a-task'),
      ],
    };
    const entryResult = extract(invalidEntry, ['a', 'b']);
    expect(entryResult.ok).toBeFalse();
    if (!entryResult.ok) expect(entryResult.error).toContain('entry');

    const invalidTerminal: WorkflowGraph = {
      nodes: [a, b, after],
      connections: [
        edge('internal', 'a-result', 'b-task'),
        edge('outgoing', 'a-result', 'after-task'),
      ],
    };
    const terminalResult = extract(invalidTerminal, ['a', 'b']);
    expect(terminalResult.ok).toBeFalse();
    if (!terminalResult.ok) expect(terminalResult.error).toContain('terminal');
  });
});
