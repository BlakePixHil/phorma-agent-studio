import { Injectable, inject, signal } from '@angular/core';

import { SelectionService } from './selection.service';
import { WorkflowService } from './workflow.service';
import { portBaseId, type WorkflowConnection, type WorkflowNode } from './workflow.model';

/** Offset applied to pasted nodes so copies don't sit exactly on originals. */
const PASTE_OFFSET = 24;

/**
 * Cut/copy/paste for workflow nodes. Stores deep-cloned selected nodes plus
 * the connections BETWEEN them (edges to non-selected nodes are dropped).
 * Paste re-ids everything and offsets by 24px per successive paste.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardService {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);

  private readonly bufferState = signal<{
    nodes: WorkflowNode[];
    connections: WorkflowConnection[];
  } | null>(null);

  private pasteCount = 0;

  /** True when the clipboard holds content that can be pasted. */
  hasContent(): boolean {
    return this.bufferState() !== null;
  }

  copy(): void {
    const nodes = this.selection.selectedNodes();
    if (nodes.length === 0) return;

    const nodeIds = new Set(nodes.map(node => node.id));
    const portOwner = new Map<string, string>();
    for (const node of nodes) {
      for (const port of node.ports) portOwner.set(port.id, node.id);
    }

    // Keep only connections whose BOTH endpoints belong to copied nodes.
    const connections = this.workflow
      .graph()
      .connections.filter(conn => {
        const sourceOwner = portOwner.get(portBaseId(conn.outputId));
        const targetOwner = portOwner.get(portBaseId(conn.inputId));
        return (
          sourceOwner !== undefined &&
          targetOwner !== undefined &&
          nodeIds.has(sourceOwner) &&
          nodeIds.has(targetOwner)
        );
      });

    this.bufferState.set({
      nodes: structuredClone(nodes),
      connections: structuredClone(connections),
    });
    this.pasteCount = 0;
  }

  cut(): void {
    const nodes = this.selection.selectedNodes();
    if (nodes.length === 0) return;
    this.copy();
    for (const node of nodes) {
      this.workflow.removeNode(node.id);
    }
    this.selection.deselect();
  }

  paste(): void {
    const buffer = this.bufferState();
    if (!buffer) return;

    this.pasteCount += 1;
    const offset = PASTE_OFFSET * this.pasteCount;
    const stamp = Date.now().toString(36);

    // Re-id nodes and ports, tracking old→new port ids for connections.
    const portIdMap = new Map<string, string>();
    const nodes = buffer.nodes.map((node, nodeIndex) => {
      const newNodeId = `node-${stamp}-${nodeIndex}`;
      const ports = node.ports.map((port, portIndex) => {
        const newPortId = `${newNodeId}-p${portIndex}`;
        portIdMap.set(port.id, newPortId);
        return { ...port, id: newPortId };
      });
      return {
        ...structuredClone(node),
        id: newNodeId,
        ports,
        position: { x: node.position.x + offset, y: node.position.y + offset },
      };
    });

    const connections = buffer.connections.flatMap((conn, index) => {
      const outputBase = portIdMap.get(portBaseId(conn.outputId));
      const inputBase = portIdMap.get(portBaseId(conn.inputId));
      if (!outputBase || !inputBase) return [];
      return [
        {
          ...conn,
          id: `conn-${stamp}-${index}`,
          outputId: `${outputBase}-out`,
          inputId: `${inputBase}-in`,
        },
      ];
    });

    this.workflow.insertNodes(nodes, connections);
    this.selection.setNodes(nodes.map(node => node.id));
  }
}
