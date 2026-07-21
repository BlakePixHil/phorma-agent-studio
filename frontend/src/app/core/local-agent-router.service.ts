import { Injectable, inject } from '@angular/core';

import { AgentStreamService } from './agent-stream.service';
import { GraphLayoutService } from './graph-layout.service';
import { NODE_CATALOG, findCatalogEntry } from './node-catalog';
import { WorkflowService } from './workflow.service';
import {
  canConnectPorts,
  type GraphPosition,
  type PortRole,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowPort,
} from './workflow.model';

/** Uniform result envelope for agent tool calls. */
export interface AgentToolResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * Tool layer for AI copilots operating on the ACTIVE workflow document.
 *
 * Every mutation path (user drag-drop, panels, and future in-studio AI
 * assistance) converges on the same WorkflowService mutations, and each
 * tool call emits AgentStream activity so the canvas can glow the touched
 * nodes. This is the contract a future assistant engine will drive.
 */
@Injectable({ providedIn: 'root' })
export class LocalAgentRouterService {
  private readonly workflow = inject(WorkflowService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly layout = inject(GraphLayoutService);

  /** Returns the active workflow graph. */
  getWorkflowState(): AgentToolResult<WorkflowGraph> {
    return { ok: true, value: this.workflow.graph() };
  }

  /** Lists the node types available in the catalog. */
  listNodeTypes(): AgentToolResult<{ id: string; label: string; description: string }[]> {
    return {
      ok: true,
      value: NODE_CATALOG.map(({ id, label, description }) => ({ id, label, description })),
    };
  }

  /** Adds a node from a catalog entry at the given position. */
  addNode(catalogEntryId: string, position: GraphPosition): AgentToolResult<WorkflowNode> {
    const entry = findCatalogEntry(catalogEntryId);
    if (!entry) {
      return { ok: false, error: `Unknown node type '${catalogEntryId}'.` };
    }
    const node = this.workflow.addNodeFromCatalog(catalogEntryId, position);
    if (!node) {
      return { ok: false, error: 'No active workflow to add the node to.' };
    }
    this.agentStream.emit({ nodeId: node.id, kind: 'created' });
    return { ok: true, value: node };
  }

  /** Patches a node's display fields or kind-specific data. */
  updateNode(
    nodeId: string,
    patch: Partial<Pick<WorkflowNode, 'name' | 'icon' | 'description' | 'data'>>,
  ): AgentToolResult<WorkflowNode> {
    const existing = this.workflow.graph().nodes.find(node => node.id === nodeId);
    if (!existing) {
      return { ok: false, error: `Node '${nodeId}' not found.` };
    }
    this.agentStream.emit({ nodeId, kind: 'editing' });
    this.workflow.updateNode(nodeId, patch);
    this.agentStream.clearEditing(nodeId);
    const updated = this.workflow.graph().nodes.find(node => node.id === nodeId)!;
    return { ok: true, value: updated };
  }

  /** Removes a node (and its connections). */
  removeNode(nodeId: string): AgentToolResult<void> {
    const existing = this.workflow.graph().nodes.find(node => node.id === nodeId);
    if (!existing) {
      return { ok: false, error: `Node '${nodeId}' not found.` };
    }
    this.agentStream.emit({ nodeId, kind: 'removed' });
    this.workflow.removeNode(nodeId);
    return { ok: true };
  }

  /** Connects two ports (connector ids carry `-out` / `-in` suffixes). */
  connect(outputId: string, inputId: string): AgentToolResult<string> {
    const connection = this.workflow.addConnection(outputId, inputId);
    if (!connection) {
      return { ok: false, error: 'Connection rejected (invalid ports or duplicate).' };
    }
    return { ok: true, value: connection.id };
  }

  /**
   * Connects two NODES by id, resolving the right ports automatically —
   * the ergonomic form for AI callers, which think in nodes, not connector
   * ids. Optional port names disambiguate multi-port flow nodes (Router
   * routes, Parallel branches, Aggregator inputs).
   *
   * Resolution: tries tools→tools (tool link) first when either node is a
   * tool, otherwise message-out→message-in (handoff).
   */
  connectNodes(
    sourceNodeId: string,
    targetNodeId: string,
    sourcePortName?: string,
    targetPortName?: string,
  ): AgentToolResult<string> {
    const graph = this.workflow.graph();
    const source = graph.nodes.find(node => node.id === sourceNodeId);
    const target = graph.nodes.find(node => node.id === targetNodeId);
    if (!source) return { ok: false, error: `Source node '${sourceNodeId}' not found.` };
    if (!target) return { ok: false, error: `Target node '${targetNodeId}' not found.` };

    let pair = this.resolvePortPair(source, target, sourcePortName, targetPortName);
    if (!pair) {
      // Second chance: multi-branch flow nodes (router routes, parallel
      // branches, aggregator inputs) grow ports on demand — an AI naming a
      // route that doesn't exist yet means "create that route", exactly
      // like the + button in the Properties panel.
      const grewSource = this.ensureBranchPort(source, 'out', sourcePortName);
      const grewTarget = this.ensureBranchPort(target, 'in', targetPortName);
      if (grewSource || grewTarget) {
        const graphNow = this.workflow.graph();
        const sourceNow = graphNow.nodes.find(node => node.id === sourceNodeId) ?? source;
        const targetNow = graphNow.nodes.find(node => node.id === targetNodeId) ?? target;
        pair = this.resolvePortPair(sourceNow, targetNow, sourcePortName, targetPortName);
      }
    }
    if (!pair) {
      return {
        ok: false,
        error:
          `No connectable ports between '${source.name}' and '${target.name}'. ` +
          `Source ports: ${source.ports.map(p => `${p.name}(${p.role})`).join(', ')}. ` +
          `Target ports: ${target.ports.map(p => `${p.name}(${p.role})`).join(', ')}.`,
      };
    }

    const connection = this.workflow.addConnection(`${pair.out.id}-out`, `${pair.in.id}-in`);
    if (!connection) {
      return { ok: false, error: 'Connection rejected (duplicate or invalid).' };
    }
    this.agentStream.emit({ nodeId: targetNodeId, kind: 'connected' });
    return { ok: true, value: connection.id };
  }

  /** Removes a connection by id. */
  removeConnection(connectionId: string): AgentToolResult<void> {
    const exists = this.workflow.graph().connections.some(conn => conn.id === connectionId);
    if (!exists) return { ok: false, error: `Connection '${connectionId}' not found.` };
    this.workflow.removeConnection(connectionId);
    return { ok: true };
  }

  /** Auto-arranges the whole graph with the layered layout. */
  arrangeLayout(): AgentToolResult<void> {
    const graph = this.workflow.graph();
    if (graph.nodes.length === 0) return { ok: true };
    this.workflow.moveNodes(this.layout.layeredLayout(graph));
    return { ok: true };
  }

  /**
   * Picks the (out, in) port pair joining two nodes. Tool links are preferred
   * when both nodes expose tools ports AND one of them is a tool node;
   * otherwise a handoff pair is used. Explicit port names always win.
   */
  private resolvePortPair(
    source: WorkflowNode,
    target: WorkflowNode,
    sourcePortName?: string,
    targetPortName?: string,
  ): { out: WorkflowPort; in: WorkflowPort } | null {
    // Connector ids already used by existing connections, so unnamed picks
    // can prefer a FREE port (a router's second handoff must not stack on
    // "Route A" alongside the first).
    const usedConnectors = new Set(
      this.workflow.graph().connections.flatMap(conn => [conn.outputId, conn.inputId]),
    );
    const pick = (
      node: WorkflowNode,
      role: PortRole,
      name: string | undefined,
      direction: 'out' | 'in',
    ): WorkflowPort | undefined => {
      const candidates = node.ports.filter(port => port.role === role);
      if (name) {
        return candidates.find(port => port.name.toLowerCase() === name.toLowerCase());
      }
      const free = candidates.find(
        port => !usedConnectors.has(`${port.id}-${direction}`),
      );
      return free ?? candidates[0];
    };

    // Tool link when either endpoint is a tool node.
    if (source.category === 'tool' || target.category === 'tool') {
      const out = pick(source, 'tools', sourcePortName, 'out');
      const inPort = pick(target, 'tools', targetPortName, 'in');
      if (out && inPort && canConnectPorts('tools', 'tools')) return { out, in: inPort };
      return null;
    }

    const out = pick(source, 'message-out', sourcePortName, 'out');
    const inPort = pick(target, 'message-in', targetPortName, 'in');
    if (out && inPort) return { out, in: inPort };
    return null;
  }

  /**
   * Adds a named branch port to a multi-branch flow node when the requested
   * name doesn't exist — routers/parallels grow `message-out` routes,
   * aggregators grow `message-in` inputs (same mutation as the Properties
   * panel's + button). Returns true when a port was added.
   */
  private ensureBranchPort(
    node: WorkflowNode,
    direction: 'out' | 'in',
    name?: string,
  ): boolean {
    if (!name) return false;
    const role: PortRole =
      node.kind === 'aggregator' ? 'message-in' : 'message-out';
    const growable =
      (direction === 'out' && (node.kind === 'router' || node.kind === 'parallel')) ||
      (direction === 'in' && node.kind === 'aggregator');
    if (!growable) return false;
    if (node.ports.some(port => port.name.toLowerCase() === name.toLowerCase())) return false;
    this.workflow.updateNodePorts(node.id, [
      ...node.ports,
      { id: `${node.id}-p${Date.now().toString(36)}`, name, role },
    ]);
    return true;
  }
}
