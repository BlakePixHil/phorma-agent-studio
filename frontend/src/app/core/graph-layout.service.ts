import { Injectable } from '@angular/core';

import { portBaseId, type GraphPosition, type WorkflowGraph } from './workflow.model';

/**
 * Spacing constants for the layered layout.
 * Tuned so a typical agent node (~200px wide) has comfortable gutters
 * between columns and rows.
 */
const LAYER_COLUMN_WIDTH = 280;
const LAYER_ROW_HEIGHT = 180;
const LAYER_ORIGIN_X = 80;
const LAYER_ORIGIN_Y = 80;

/**
 * Pure graph-layout service. Produces `Map<nodeId, GraphPosition>` for a
 * given graph — no side effects, no signal writes. Callers (currently
 * {@link SelectionService.arrangeNodes}) apply the result via `moveNodes`.
 *
 * Strategy: {@link layeredLayout} — Sugiyama-style layered layout (triggers
 * on the left, work flows left→right through agents, branches stacked
 * vertically).
 */
@Injectable({ providedIn: 'root' })
export class GraphLayoutService {
  /**
   * Layered (Sugiyama-style) layout. Entry nodes (triggers) land in layer 0;
   * each downstream node lands one layer right of its deepest upstream
   * dependency. Within a layer, nodes are ordered by the barycenter of their
   * upstream neighbours to reduce wire crossings.
   *
   * Returns a position for every node in the graph. Disconnected nodes
   * (no connections) are stacked in a trailing column.
   */
  layeredLayout(graph: WorkflowGraph): Map<string, GraphPosition> {
    const nodes = graph.nodes;
    if (nodes.length === 0) return new Map();

    const ids = nodes.map(node => node.id);
    const idSet = new Set(ids);

    // ── Build adjacency: for each node, the set of nodes that feed INTO it
    //    (i.e. this node reads from their output ports). ──
    const incoming = new Map<string, Set<string>>();
    const outgoing = new Map<string, Set<string>>();
    for (const id of ids) {
      incoming.set(id, new Set());
      outgoing.set(id, new Set());
    }
    for (const conn of graph.connections) {
      const source = this.nodeIdForConnector(graph, conn.outputId);
      const target = this.nodeIdForConnector(graph, conn.inputId);
      if (!source || !target || source === target) continue;
      if (!idSet.has(source) || !idSet.has(target)) continue;
      incoming.get(target)!.add(source);
      outgoing.get(source)!.add(target);
    }

    // ── Layer assignment via longest path from any source (node with no
    //    incoming edges). Entry-node kinds are forced to layer 0. ──
    const layers = new Map<string, number>();
    const entryKinds = new Set(['manual-trigger', 'schedule-trigger', 'webhook-trigger']);
    // Kahn-style topological pass: process nodes whose incoming deps are all
    // already layered. Cycles (shouldn't happen — saveDraft rejects them — but
    // guard anyway) fall back to max-layer + 1.
    const pending = new Set(ids);
    let guard = nodes.length + 1;
    while (pending.size > 0 && guard-- > 0) {
      const ready: string[] = [];
      for (const id of pending) {
        const deps = incoming.get(id)!;
        let allLayered = true;
        for (const dep of deps) {
          if (!layers.has(dep)) { allLayered = false; break; }
        }
        if (allLayered) ready.push(id);
      }
      if (ready.length === 0) {
        // Cycle or stuck — force-assign the first pending node to break the
        // deadlock so we always make progress.
        const [first] = pending;
        ready.push(first);
      }
      for (const id of ready) {
        const deps = incoming.get(id)!;
        let maxDepLayer = -1;
        for (const dep of deps) {
          const depLayer = layers.get(dep) ?? 0;
          if (depLayer > maxDepLayer) maxDepLayer = depLayer;
        }
        const node = nodes.find(n => n.id === id)!;
        const layer = entryKinds.has(node.kind) ? 0 : maxDepLayer + 1;
        layers.set(id, layer);
        pending.delete(id);
      }
    }

    // ── Order nodes within each layer by barycenter of upstream neighbours. ──
    const layerGroups = new Map<number, string[]>();
    for (const [id, layer] of layers) {
      if (!layerGroups.has(layer)) layerGroups.set(layer, []);
      layerGroups.get(layer)!.push(id);
    }
    const orderedLayers = new Map<number, string[]>();
    for (const [layer, group] of layerGroups) {
      // Barycenter: average position (index) of upstream neighbours in the
      // already-ordered previous layer. Nodes with no upstream deps keep
      // their original order (stable sort).
      const previousOrder = orderedLayers.get(layer - 1) ?? [];
      const previousIndex = new Map<string, number>();
      previousOrder.forEach((id, index) => previousIndex.set(id, index));

      const withBary = group.map((id, index) => {
        const deps = incoming.get(id)!;
        let sum = 0;
        let count = 0;
        for (const dep of deps) {
          const idx = previousIndex.get(dep);
          if (idx !== undefined) { sum += idx; count++; }
        }
        return { id, bary: count > 0 ? sum / count : index, fallback: index };
      });
      withBary.sort((a, b) => a.bary - b.bary || a.fallback - b.fallback);
      orderedLayers.set(layer, withBary.map(item => item.id));
    }

    // ── Assign x/y from layer + rank. ──
    const positions = new Map<string, GraphPosition>();
    for (const [layer, ordered] of orderedLayers) {
      ordered.forEach((id, rank) => {
        positions.set(id, {
          x: LAYER_ORIGIN_X + layer * LAYER_COLUMN_WIDTH,
          y: LAYER_ORIGIN_Y + rank * LAYER_ROW_HEIGHT,
        });
      });
    }

    // ── Disconnected nodes (never reached by the layering pass) stack in a
    //    trailing column to the right of everything else. ──
    const maxLayer = Math.max(0, ...[...layers.values()]);
    let disconnectedRank = 0;
    for (const node of nodes) {
      if (positions.has(node.id)) continue;
      positions.set(node.id, {
        x: LAYER_ORIGIN_X + (maxLayer + 1) * LAYER_COLUMN_WIDTH,
        y: LAYER_ORIGIN_Y + disconnectedRank * LAYER_ROW_HEIGHT,
      });
      disconnectedRank++;
    }

    return positions;
  }

  /** Resolves a connector id to its owning node id. */
  private nodeIdForConnector(graph: WorkflowGraph, connectorId: string): string | undefined {
    const baseId = portBaseId(connectorId);
    const node = graph.nodes.find(n => n.ports.some(p => p.id === baseId));
    return node?.id;
  }
}
