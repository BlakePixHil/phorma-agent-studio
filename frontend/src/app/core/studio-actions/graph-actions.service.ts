import { Injectable, inject } from '@angular/core';

import { AiEditSessionService } from '../ai-edit-session.service';
import { LocalAgentRouterService } from '../local-agent-router.service';
import { findCatalogEntry } from '../node-catalog';
import { WorkflowService } from '../workflow.service';
import type { GraphPosition, WorkflowGraph } from '../workflow.model';
import {
  actionFail,
  actionOk,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/** Column/row spacing for placeholder placement next to existing content. */
const PLACE_COLUMN_WIDTH = 280;
const PLACE_ROW_HEIGHT = 180;
/** Nodes per column when cascading new nodes beside existing content. */
const PLACE_ROWS_PER_COLUMN = 4;

/**
 * Surface `graph` Studio_Actions (Requirement 2.11) - the canvas capabilities
 * the assistant already had, moved behind the registry so Agent, Plan and Ask
 * dispatch through one path.
 *
 * Every write here goes through {@link LocalAgentRouterService} and records an
 * {@link AiEditSessionService} entry, so the Revert/Keep bar describes exactly
 * what changed (Requirement 7.2).
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): changing the
 * SHAPE of the graph - adding, removing, connecting, disconnecting - is the
 * `graph.structure` capability and sits at the builder level.
 * `graph_update_node` does not: it renames a node and rewrites its prompt, which
 * are values INSIDE an existing graph and exactly what the editor level exists
 * for. Reading the canvas is open.
 */
@Injectable({ providedIn: 'root' })
export class GraphActionsService {
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly session = inject(AiEditSessionService);

  /** Placement cursor, re-seeded once per turn by {@link beginPlacement}. */
  private placeBase: GraphPosition = { x: 80, y: 80 };
  private placeIndex = 0;

  /**
   * Seeds new-node placement from the PRE-TURN graph. The base is captured
   * once: recomputing "right of content" per add double-shifts, because each
   * add extends the graph's extent.
   */
  beginPlacement(graphBefore: WorkflowGraph): void {
    let baseX = 80;
    let baseY = 80;
    for (const node of graphBefore.nodes) {
      baseX = Math.max(baseX, node.position.x + PLACE_COLUMN_WIDTH);
      baseY = Math.min(baseY, node.position.y);
    }
    this.placeBase = { x: baseX, y: Math.max(80, baseY) };
    this.placeIndex = 0;
  }

  /** Next cascade position for a newly added node. */
  nextPosition(): GraphPosition {
    const column = Math.floor(this.placeIndex / PLACE_ROWS_PER_COLUMN);
    const row = this.placeIndex % PLACE_ROWS_PER_COLUMN;
    this.placeIndex += 1;
    return {
      x: this.placeBase.x + column * PLACE_COLUMN_WIDTH,
      y: this.placeBase.y + row * PLACE_ROW_HEIGHT,
    };
  }

  actions(): StudioAction[] {
    return [
      {
        id: 'graph_read_state',
        label: 'Inspect the canvas',
        description:
          'Returns the current workflow graph: every node with its id, kind, display name and ports, plus every connection. Call this to re-check the canvas after edits.',
        surface: 'graph',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Inspecting the canvas',
        run: () => this.readState(),
      },
      {
        id: 'graph_add_node',
        label: 'Add a node',
        description:
          'Adds a node to the canvas from a catalog type. Returns the created node id - use that id in later connect/update calls. Positions are handled automatically.',
        surface: 'graph',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          type: {
            type: 'string',
            description: 'Catalog type id, e.g. agent-researcher, trigger-manual, tool-web-search.',
            required: true,
          },
          name: { type: 'string', description: 'Display name for the node.' },
          prompt: {
            type: 'string',
            description:
              'Markdown system prompt (nodes that carry one). Include {{input}} where the task text goes.',
          },
        },
        activity: args => `Adding ${argStr(args, 'name') ?? argStr(args, 'type') ?? 'a node'}`,
        run: args => this.addNode(args),
      },
      {
        id: 'graph_update_node',
        label: 'Update a node',
        description:
          "Renames a node and/or replaces its markdown prompt. Use prompt_write for prompt-only edits on non-agent nodes.",
        surface: 'graph',
        access: 'write',
        risk: 'silent',
        minLevel: 'editor',
        graphEdit: true,
        params: {
          nodeId: { type: 'string', description: 'Id of the node to update.', required: true },
          name: { type: 'string', description: 'New display name.' },
          prompt: { type: 'string', description: 'Replacement markdown prompt body.' },
        },
        activity: args =>
          `Updating ${argStr(args, 'name') ?? argStr(args, 'nodeId') ?? 'a node'}`,
        run: args => this.updateNode(args),
      },
      {
        // Requirement 6.1 names node deletion explicitly, so it confirms even
        // though the Edit_Session could revert it.
        id: 'graph_remove_node',
        label: 'Remove a node',
        description: 'Removes a node and every connection touching it.',
        surface: 'graph',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          nodeId: { type: 'string', description: 'Id of the node to remove.', required: true },
        },
        confirmSummary: args =>
          `Remove "${this.nodeName(argStr(args, 'nodeId'))}" and its connections from the canvas?`,
        activity: args => `Removing ${this.nodeName(argStr(args, 'nodeId'))}`,
        run: args => this.removeNode(args),
      },
      {
        id: 'graph_connect_nodes',
        label: 'Connect two nodes',
        description:
          'Connects two nodes. Handoff vs tool link is derived from the node kinds. Port names are only needed for multi-port flow nodes; naming a nonexistent port on a router/parallel/aggregator creates it, so prefer descriptive route names.',
        surface: 'graph',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          sourceNodeId: { type: 'string', description: 'Source node id.', required: true },
          targetNodeId: { type: 'string', description: 'Target node id.', required: true },
          sourcePort: { type: 'string', description: 'Optional source port name.' },
          targetPort: { type: 'string', description: 'Optional target port name.' },
        },
        activity: args =>
          `Connecting ${this.nodeName(argStr(args, 'sourceNodeId'))} to ${this.nodeName(
            argStr(args, 'targetNodeId'),
          )}`,
        run: args => this.connectNodes(args),
      },
      {
        // Removing an edge is a local reversible change to the active document
        // (Requirement 6.2). Deleting a stored Connection is the confirm-tier
        // action named in Requirement 6.1 - see connection_delete.
        id: 'graph_remove_connection',
        label: 'Remove a connection',
        description: 'Removes a graph connection by its id.',
        surface: 'graph',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          connectionId: {
            type: 'string',
            description: 'Id of the connection to remove.',
            required: true,
          },
        },
        activity: () => 'Removing a connection',
        run: args => this.removeConnection(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private readState(): ActionResult {
    const graph = this.workflow.graph();
    return actionOk({
      nodes: graph.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        name: node.name,
        ports: node.ports.map(port => ({ name: port.name, role: port.role })),
      })),
      connections: graph.connections.map(conn => ({
        id: conn.id,
        kind: conn.kind,
        outputId: conn.outputId,
        inputId: conn.inputId,
      })),
    });
  }

  private addNode(args: ActionArgs): ActionResult {
    const type = argStr(args, 'type');
    if (!type) return actionFail('Missing the catalog type id.');
    if (!findCatalogEntry(type)) return actionFail(`Unknown node type '${type}'.`);
    const added = this.router.addNode(type, this.nextPosition());
    if (!added.ok || !added.value) return actionFail(added.error ?? 'Failed to add the node.');
    const node = added.value;
    const name = argStr(args, 'name');
    const prompt = argStr(args, 'prompt');
    const patch: { name?: string; data?: object } = {};
    if (name) patch.name = name;
    if (prompt && hasPromptField(node.data)) patch.data = { ...node.data, prompt };
    if (patch.name || patch.data) this.router.updateNode(node.id, patch);
    this.session.record(`Added ${name ?? node.name} (${type})`);
    return actionOk({ nodeId: node.id, name: name ?? node.name }, { revertable: true });
  }

  private updateNode(args: ActionArgs): ActionResult {
    const nodeId = argStr(args, 'nodeId');
    if (!nodeId) return actionFail('Missing the node id.');
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    if (!node) return actionFail(`Node '${nodeId}' not found.`);
    const name = argStr(args, 'name');
    const prompt = argStr(args, 'prompt');
    const patch: { name?: string; data?: object } = {};
    if (name) patch.name = name;
    // Requirement 9.3: the prompt patch lands on any node whose data declares
    // a prompt field, not agent nodes only.
    if (prompt !== undefined) {
      if (!hasPromptField(node.data)) {
        return actionFail(`Nodes of kind '${node.kind}' do not carry a prompt.`);
      }
      patch.data = { ...(node.data as object), prompt };
    }
    if (!patch.name && !patch.data) return actionFail('Nothing to update: pass name or prompt.');
    const result = this.router.updateNode(nodeId, patch);
    if (!result.ok) return actionFail(result.error ?? 'Failed to update the node.');
    this.session.record(`Updated ${name ?? node.name}`);
    return actionOk({ nodeId, name: name ?? node.name }, { revertable: true });
  }

  private removeNode(args: ActionArgs): ActionResult {
    const nodeId = argStr(args, 'nodeId');
    if (!nodeId) return actionFail('Missing the node id.');
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    const result = this.router.removeNode(nodeId);
    if (!result.ok) return actionFail(result.error ?? 'Failed to remove the node.');
    this.session.record(`Removed ${node?.name ?? nodeId}`);
    return actionOk({ nodeId }, { revertable: true });
  }

  private connectNodes(args: ActionArgs): ActionResult {
    const source = argStr(args, 'sourceNodeId');
    const target = argStr(args, 'targetNodeId');
    if (!source || !target) return actionFail('Missing sourceNodeId or targetNodeId.');
    const result = this.router.connectNodes(
      source,
      target,
      argStr(args, 'sourcePort'),
      argStr(args, 'targetPort'),
    );
    if (!result.ok) return actionFail(result.error ?? 'Failed to connect the nodes.');
    this.session.record(`Connected ${this.nodeName(source)} to ${this.nodeName(target)}`);
    return actionOk({ connectionId: result.value }, { revertable: true });
  }

  private removeConnection(args: ActionArgs): ActionResult {
    const connectionId = argStr(args, 'connectionId');
    if (!connectionId) return actionFail('Missing the connection id.');
    const result = this.router.removeConnection(connectionId);
    if (!result.ok) return actionFail(result.error ?? 'Failed to remove the connection.');
    this.session.record(`Removed connection ${connectionId}`);
    return actionOk({ connectionId }, { revertable: true });
  }

  /** Display name for a node id, falling back to the id itself. */
  private nodeName(nodeId: string | undefined): string {
    if (!nodeId) return 'a node';
    return this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
  }
}

/** True when a node's data object declares a `prompt` field. */
export function hasPromptField(data: unknown): data is { prompt: string } {
  return (
    data !== null &&
    typeof data === 'object' &&
    'prompt' in (data as Record<string, unknown>) &&
    typeof (data as Record<string, unknown>)['prompt'] === 'string'
  );
}
