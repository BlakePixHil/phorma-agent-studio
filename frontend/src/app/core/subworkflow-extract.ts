import { buildNodeFromCatalog, findCatalogEntry } from './node-catalog';
import {
  findNodeForConnector,
  portBaseId,
  type EmbeddedWorkflow,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSpec,
} from './workflow.model';

const TRIGGER_KINDS = new Set(['manual-trigger', 'schedule-trigger', 'webhook-trigger']);
const NODE_WIDTH = 220;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 24;
const NODE_PADDING = 8;

export interface SubWorkflowExtractOptions {
  workflowId: string;
  workflowName: string;
  savedAt: string;
  subWorkflows?: Record<string, EmbeddedWorkflow>;
}

export interface SubWorkflowExtraction {
  childSpec: WorkflowSpec;
  parentGraph: WorkflowGraph;
  replacementNode: WorkflowNode;
  /** Nodes removed from the parent. Shared tools are cloned, not moved. */
  movedNodeIds: string[];
  /** Tool nodes retained in the parent and cloned into the child. */
  clonedToolIds: string[];
}

export type SubWorkflowExtractResult =
  | { ok: true; value: SubWorkflowExtraction }
  | { ok: false; error: string };

/**
 * Extracts a node selection into a portable child workflow without mutating
 * the source graph. The result is ready to save before applying parentGraph.
 */
export function extractSubWorkflow(
  graph: WorkflowGraph,
  selectedNodeIds: ReadonlySet<string>,
  options: SubWorkflowExtractOptions,
): SubWorkflowExtractResult {
  const selectedNodes = graph.nodes.filter(node => selectedNodeIds.has(node.id));
  if (selectedNodes.length === 0) return invalid('Select at least one node to extract.');

  if (selectedNodes.some(node => TRIGGER_KINDS.has(node.kind))) {
    return invalid('Triggers cannot be extracted. Select the workflow steps after the trigger.');
  }
  if (selectedNodes.some(node => node.kind === 'error-handler')) {
    return invalid('Error Handler nodes cannot be extracted. They belong to the parent workflow.');
  }

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const ownerByPort = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    for (const port of node.ports) ownerByPort.set(port.id, node);
  }
  const endpoints = (connection: WorkflowConnection) => ({
    source: ownerByPort.get(portBaseId(connection.outputId)),
    target: ownerByPort.get(portBaseId(connection.inputId)),
  });

  // A selected agent carries all linked capabilities into the child. A tool
  // used by an unselected agent remains in the parent and is cloned by value.
  const includedIds = new Set(selectedNodes.map(node => node.id));
  for (const connection of graph.connections) {
    if (connection.kind !== 'tool-link') continue;
    const { source, target } = endpoints(connection);
    if (!source || !target) continue;
    const selectedAgent = [source, target].find(
      node => node.category === 'agent' && includedIds.has(node.id),
    );
    const tool = [source, target].find(node => node.category === 'tool');
    if (selectedAgent && tool) includedIds.add(tool.id);
  }

  const includedNodes = graph.nodes.filter(node => includedIds.has(node.id));
  const executableNodes = includedNodes.filter(node => node.category !== 'tool');
  if (executableNodes.length === 0) {
    return invalid('The selection needs at least one executable node, not only tools.');
  }

  const internalHandoffs: WorkflowConnection[] = [];
  const incomingBoundaries: WorkflowConnection[] = [];
  const outgoingBoundaries: WorkflowConnection[] = [];
  for (const connection of graph.connections) {
    if (connection.kind !== 'handoff') continue;
    const { source, target } = endpoints(connection);
    if (!source || !target) continue;
    const sourceInside = includedIds.has(source.id);
    const targetInside = includedIds.has(target.id);
    if (sourceInside && targetInside) internalHandoffs.push(connection);
    else if (!sourceInside && targetInside) incomingBoundaries.push(connection);
    else if (sourceInside && !targetInside) outgoingBoundaries.push(connection);
  }

  if (incomingBoundaries.length > 1) {
    return invalid('The selection has multiple incoming handoffs. Extract a flow with at most one input boundary.');
  }
  if (outgoingBoundaries.length > 1) {
    return invalid('The selection has multiple outgoing handoffs. Extract a flow with at most one output boundary.');
  }

  const incoming = incomingBoundaries[0];
  const outgoing = outgoingBoundaries[0];
  const entry = resolveEntry(graph, executableNodes, internalHandoffs, incoming);
  if (!entry) {
    return invalid('The selection needs one unambiguous entry port for the child trigger.');
  }
  const terminal = resolveTerminal(graph, executableNodes, internalHandoffs, outgoing);
  if (!terminal) {
    return invalid('The selection needs one unambiguous terminal node.');
  }

  if (!allNodesReachable(executableNodes, internalHandoffs, endpoints, entry.node.id, false)) {
    return invalid('Every extracted step must be reachable from the child entry.');
  }
  if (!allNodesReachable(executableNodes, internalHandoffs, endpoints, terminal.id, true)) {
    return invalid('Every extracted step must lead to the child terminal.');
  }

  const sharedToolIds = new Set<string>();
  for (const node of includedNodes) {
    if (node.category !== 'tool') continue;
    const usedByUnselectedAgent = graph.connections.some(connection => {
      if (connection.kind !== 'tool-link') return false;
      const { source, target } = endpoints(connection);
      if (!source || !target || (source.id !== node.id && target.id !== node.id)) return false;
      const other = source.id === node.id ? target : source;
      return other.category === 'agent' && !includedIds.has(other.id);
    });
    if (usedByUnselectedAgent) sharedToolIds.add(node.id);
  }

  const movedIds = new Set([...includedIds].filter(id => !sharedToolIds.has(id)));
  const replacementPosition = replacementCenter(selectedNodes);
  const replacement = catalogNode('flow-execute-workflow', replacementPosition);
  replacement.name = options.workflowName;
  replacement.data = {
    ...replacement.data,
    workflowId: options.workflowId,
    workflowName: options.workflowName,
  };
  const replacementInput = replacement.ports.find(port => port.role === 'message-in');
  const replacementOutput = replacement.ports.find(port => port.role === 'message-out');
  if (!replacementInput || !replacementOutput) {
    return invalid('The Execute Workflow catalog entry is missing its Task or Result port.');
  }

  const childNodes = includedNodes.map(node => structuredClone(node));
  const entryNode = childNodes.find(node => node.id === entry.node.id)!;
  const trigger = catalogNode('trigger-manual', {
    x: entryNode.position.x - 300,
    y: entryNode.position.y,
  });
  const triggerOutput = trigger.ports.find(port => port.role === 'message-out');
  if (!triggerOutput) return invalid('The Manual Trigger catalog entry is missing its Start port.');

  const childConnections = graph.connections
    .filter(connection => {
      const { source, target } = endpoints(connection);
      return !!source && !!target && includedIds.has(source.id) && includedIds.has(target.id);
    })
    .map(connection => structuredClone(connection));
  childConnections.push({
    id: freshConnectionId('child-entry', childConnections),
    outputId: `${triggerOutput.id}-out`,
    inputId: `${entry.portId}-in`,
    kind: 'handoff',
  });

  const parentConnections = graph.connections
    .filter(connection => {
      const { source, target } = endpoints(connection);
      return !!source && !!target && !movedIds.has(source.id) && !movedIds.has(target.id);
    })
    .map(connection => structuredClone(connection));
  if (incoming) {
    parentConnections.push({
      ...structuredClone(incoming),
      inputId: `${replacementInput.id}-in`,
    });
  }
  if (outgoing) {
    parentConnections.push({
      ...structuredClone(outgoing),
      outputId: `${replacementOutput.id}-out`,
    });
  }

  return {
    ok: true,
    value: {
      childSpec: {
        version: 1,
        id: options.workflowId,
        name: options.workflowName,
        graph: {
          nodes: [trigger, ...childNodes],
          connections: childConnections,
        },
        subWorkflows: options.subWorkflows
          ? structuredClone(options.subWorkflows)
          : undefined,
        savedAt: options.savedAt,
      },
      parentGraph: {
        nodes: [
          ...graph.nodes.filter(node => !movedIds.has(node.id)).map(node => structuredClone(node)),
          replacement,
        ],
        connections: parentConnections,
      },
      replacementNode: replacement,
      movedNodeIds: [...movedIds],
      clonedToolIds: [...sharedToolIds],
    },
  };
}

function resolveEntry(
  graph: WorkflowGraph,
  nodes: WorkflowNode[],
  internal: WorkflowConnection[],
  incoming?: WorkflowConnection,
): { node: WorkflowNode; portId: string } | null {
  if (incoming) {
    const target = findNodeForConnector(graph, incoming.inputId);
    if (!target || target.port.role !== 'message-in') return null;
    const hasInternalPredecessor = internal.some(
      connection => findNodeForConnector(graph, connection.inputId)?.node.id === target.node.id,
    );
    return hasInternalPredecessor ? null : { node: target.node, portId: target.port.id };
  }
  const connectedInputs = new Set(internal.map(connection => portBaseId(connection.inputId)));
  const candidates = nodes.flatMap(node =>
    node.ports
      .filter(port => port.role === 'message-in' && !connectedInputs.has(port.id))
      .map(port => ({ node, portId: port.id })),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveTerminal(
  graph: WorkflowGraph,
  nodes: WorkflowNode[],
  internal: WorkflowConnection[],
  outgoing?: WorkflowConnection,
): WorkflowNode | null {
  if (outgoing) {
    const source = findNodeForConnector(graph, outgoing.outputId);
    if (!source || source.port.role !== 'message-out') return null;
    const hasInternalSuccessor = internal.some(
      connection => findNodeForConnector(graph, connection.outputId)?.node.id === source.node.id,
    );
    return hasInternalSuccessor ? null : source.node;
  }
  const nodesWithInternalOutput = new Set(
    internal.flatMap(connection => {
      const source = findNodeForConnector(graph, connection.outputId);
      return source ? [source.node.id] : [];
    }),
  );
  const candidates = nodes.filter(node => !nodesWithInternalOutput.has(node.id));
  return candidates.length === 1 ? candidates[0] : null;
}

function allNodesReachable(
  nodes: WorkflowNode[],
  internal: WorkflowConnection[],
  endpoints: (connection: WorkflowConnection) => { source?: WorkflowNode; target?: WorkflowNode },
  startId: string,
  reverse: boolean,
): boolean {
  const reachable = new Set([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const connection of internal) {
      const { source, target } = endpoints(connection);
      if (!source || !target) continue;
      const from = reverse ? target.id : source.id;
      const to = reverse ? source.id : target.id;
      if (reachable.has(from) && !reachable.has(to)) {
        reachable.add(to);
        changed = true;
      }
    }
  }
  return nodes.every(node => reachable.has(node.id));
}

function replacementCenter(nodes: WorkflowNode[]): { x: number; y: number } {
  const minX = Math.min(...nodes.map(node => node.position.x));
  const minY = Math.min(...nodes.map(node => node.position.y));
  const maxX = Math.max(...nodes.map(node => node.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map(node => node.position.y + nodeHeight(node)));
  const replacementHeight = HEADER_HEIGHT + NODE_PADDING * 2 + ROW_HEIGHT * 2;
  return {
    x: (minX + maxX) / 2 - NODE_WIDTH / 2,
    y: (minY + maxY) / 2 - replacementHeight / 2,
  };
}

function nodeHeight(node: WorkflowNode): number {
  return Math.max(
    HEADER_HEIGHT + NODE_PADDING * 2 + node.ports.length * ROW_HEIGHT,
    HEADER_HEIGHT + NODE_PADDING,
  );
}

function catalogNode(entryId: string, position: { x: number; y: number }): WorkflowNode {
  const entry = findCatalogEntry(entryId);
  if (!entry) throw new Error(`Missing node catalog entry: ${entryId}`);
  return buildNodeFromCatalog(entry, position);
}

function freshConnectionId(prefix: string, connections: WorkflowConnection[]): string {
  const used = new Set(connections.map(connection => connection.id));
  let index = connections.length;
  while (used.has(`conn-${prefix}-${index}`)) index += 1;
  return `conn-${prefix}-${index}`;
}

function invalid(error: string): SubWorkflowExtractResult {
  return { ok: false, error };
}
