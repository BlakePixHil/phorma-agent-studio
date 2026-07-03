import { Injectable, computed, inject, signal } from '@angular/core';

import { WorkflowService } from './workflow.service';
import { CanvasStateService } from './canvas-state.service';
import { GraphLayoutService } from './graph-layout.service';
import type { GraphPosition, WorkflowNode } from './workflow.model';

/**
 * Tracks the currently selected canvas elements. The Prompt and Properties
 * panels read from here to drive their editors.
 */
@Injectable({ providedIn: 'root' })
export class SelectionService {
  private readonly workflow = inject(WorkflowService);
  private readonly canvasState = inject(CanvasStateService);
  private readonly layout = inject(GraphLayoutService);

  private readonly selectedNodeIdsState = signal<ReadonlySet<string>>(new Set<string>());
  private readonly selectedConnectionIdsState = signal<ReadonlySet<string>>(new Set<string>());

  /** All currently selected node ids. */
  readonly selectedNodeIds = this.selectedNodeIdsState.asReadonly();
  /** All currently selected connection ids. */
  readonly selectedConnectionIds = this.selectedConnectionIdsState.asReadonly();

  /** Primary selected node id, or null when nothing is selected. */
  readonly selectedNodeId = computed(() => [...this.selectedNodeIdsState()][0] ?? null);

  /** All selected node objects, resolved from the active workflow graph. */
  readonly selectedNodes = computed<WorkflowNode[]>(() => {
    const ids = this.selectedNodeIdsState();
    if (ids.size === 0) return [];
    return this.workflow.graph().nodes.filter(node => ids.has(node.id));
  });

  /** The resolved node object for the current single selection. */
  readonly selectedNode = computed<WorkflowNode | null>(() => {
    const nodes = this.selectedNodes();
    return nodes.length === 1 ? nodes[0] : null;
  });

  selectNode(nodeId: string, additive = false): void {
    this.selectedConnectionIdsState.set(new Set<string>());
    if (!additive) {
      this.selectedNodeIdsState.set(new Set([nodeId]));
      return;
    }

    this.selectedNodeIdsState.update(current => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  /**
   * Replaces the entire node selection with the given ids. Used to mirror
   * the canvas renderer's own selection state (from box-select drags) into
   * the app selection signal.
   */
  setNodes(nodeIds: readonly string[]): void {
    this.selectedNodeIdsState.set(new Set(nodeIds));
    this.selectedConnectionIdsState.set(new Set<string>());
  }

  selectConnection(connectionId: string): void {
    this.selectConnections([connectionId]);
  }

  /** Replaces the connection selection (clears any node selection). */
  selectConnections(connectionIds: readonly string[]): void {
    this.selectedNodeIdsState.set(new Set<string>());
    this.selectedConnectionIdsState.set(new Set(connectionIds));
  }

  selectAll(): void {
    this.setNodes(this.workflow.graph().nodes.map(node => node.id));
  }

  deselect(): void {
    this.selectedNodeIdsState.set(new Set<string>());
    this.selectedConnectionIdsState.set(new Set<string>());
  }

  /** Alias of {@link deselect} kept for call-site brevity. */
  clear(): void {
    this.deselect();
  }

  /** Persists new node positions after a canvas drag. */
  moveNodes(updates: ReadonlyMap<string, GraphPosition>): void {
    if (updates.size === 0) return;
    this.workflow.moveNodes(updates);
  }

  /**
   * Auto-arranges all nodes on the active graph using the layered layout
   * (triggers flow left → right through agents to outputs). Positions snap
   * to the grid when grid snapping is enabled. Bound to the Arrange menu and
   * the Ctrl+Shift+L hotkey.
   */
  arrangeNodes(): void {
    const graph = this.workflow.graph();
    if (graph.nodes.length === 0) return;
    const raw = this.layout.layeredLayout(graph);
    const updates = new Map<string, GraphPosition>();
    for (const [nodeId, position] of raw) {
      updates.set(
        nodeId,
        this.canvasState.gridSnap() ? this.canvasState.snapPosition(position) : position,
      );
    }
    this.workflow.moveNodes(updates);
  }
}
