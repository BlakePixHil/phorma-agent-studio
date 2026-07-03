import { Injectable, inject } from '@angular/core';

import { AgentStreamService } from './agent-stream.service';
import { NODE_CATALOG, findCatalogEntry } from './node-catalog';
import { WorkflowService } from './workflow.service';
import type { GraphPosition, WorkflowGraph, WorkflowNode } from './workflow.model';

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
}
