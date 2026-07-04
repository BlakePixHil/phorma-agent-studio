import { NODE_CATEGORY_COLORS, isAgentNode } from '../../../core/workflow.model';
import type { WorkflowGraph, WorkflowNode, WorkflowPort } from '../../../core/workflow.model';
import type { RendererEdge, RendererNode, RendererPort } from './canvas-graph-renderer';

/**
 * Maps the app's {@link WorkflowGraph} into renderer scene data. The geometry
 * here mirrors the node card layout (header + one row per port).
 *
 * `resolveColor` turns CSS-variable colour strings into concrete `rgb(...)`
 * values the 2D context can paint. It is supplied by the host component,
 * which owns the live DOM and therefore the computed theme.
 */

/** Card geometry — kept in sync with the renderer's HEADER_H. */
export const SCENE_HEADER_H = 30;
export const SCENE_ROW_H = 24;
export const SCENE_NODE_W = 220;
export const SCENE_PAD = 8;

export type ColorResolver = (raw: string) => string;
export type IconResolver = (iconClass: string) => { glyph: string; font: string } | null;

/** Accent colour for a node from its category. */
function nodeAccentRaw(node: WorkflowNode): string {
  return NODE_CATEGORY_COLORS[node.category] ?? NODE_CATEGORY_COLORS.flow;
}

/** Port dot colour by role. */
function portColorRaw(role: WorkflowPort['role']): string {
  return role === 'tools'
    ? 'var(--phorma-port-tools, #fbbf24)'
    : 'var(--phorma-port-message, #94a3b8)';
}

/** Truncates display text to at most `max` characters, appending an ellipsis. */
function truncateLabel(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Secondary label shown on a row's right column. Agents show their model
 * ("Default" when inheriting the application default), so the canvas
 * communicates "who runs on what" at a glance.
 */
function nodeSubtitle(node: WorkflowNode): string | null {
  if (isAgentNode(node)) return truncateLabel(node.data.model ?? 'Default', 18);
  return null;
}

export function graphToScene(
  graph: WorkflowGraph,
  resolveColor: ColorResolver,
  resolveIcon?: IconResolver,
): { nodes: RendererNode[]; edges: RendererEdge[] } {
  const nodes: RendererNode[] = [];
  // base port id → owning node id, for resolving connection endpoints.
  const portToNode = new Map<string, string>();

  for (const node of graph.nodes) {
    const ports: RendererPort[] = [];
    const rows: { y: number; name: string; type: string; typeColor: string }[] = [];

    for (const port of node.ports) portToNode.set(port.id, node.id);

    // Row order: message-in ports, then message-out, then the tools port.
    // A tool node's own `tools` port receives links, so it renders on the
    // LEFT (side 'in'); an agent's tools port emits links → RIGHT ('out').
    const ordered = [
      ...node.ports.filter(port => port.role === 'message-in'),
      ...node.ports.filter(port => port.role === 'message-out'),
      ...node.ports.filter(port => port.role === 'tools'),
    ];

    const subtitle = nodeSubtitle(node);
    let cursor = SCENE_HEADER_H + SCENE_PAD;
    ordered.forEach((port, index) => {
      const y = cursor + SCENE_ROW_H / 2;
      const color = resolveColor(portColorRaw(port.role));
      const side: RendererPort['side'] =
        port.role === 'message-in' || (port.role === 'tools' && node.category === 'tool')
          ? 'in'
          : 'out';
      // First row carries the node subtitle (e.g. the agent's model) in the
      // type column; other rows leave it empty — ports are untyped messages.
      rows.push({
        y,
        name: truncateLabel(port.name),
        type: index === 0 && subtitle ? subtitle : '',
        typeColor: color,
      });
      ports.push({
        id: side === 'in' ? `${port.id}-in` : `${port.id}-out`,
        side,
        y,
        color,
        label: port.name,
        portKind: port.role === 'tools' ? 'tools' : 'message',
      });
      cursor += SCENE_ROW_H;
    });

    const h = SCENE_HEADER_H + SCENE_PAD * 2 + ordered.length * SCENE_ROW_H;
    const icon = resolveIcon?.(node.icon);
    nodes.push({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      w: SCENE_NODE_W,
      h: Math.max(h, SCENE_HEADER_H + SCENE_PAD),
      title: node.name,
      kind: node.kind,
      accent: resolveColor(nodeAccentRaw(node)),
      ports,
      rows,
      iconGlyph: icon?.glyph,
      iconFont: icon?.font,
    });
  }

  const edges: RendererEdge[] = [];
  for (const conn of graph.connections) {
    const baseOut = conn.outputId.replace(/-(in|out)$/, '');
    const baseIn = conn.inputId.replace(/-(in|out)$/, '');
    const fromNode = portToNode.get(baseOut);
    const toNode = portToNode.get(baseIn);
    if (!fromNode || !toNode) continue;
    edges.push({
      id: conn.id,
      fromNode,
      fromPort: conn.outputId,
      toNode,
      toPort: conn.inputId,
      dashed: conn.kind === 'tool-link' || undefined,
    });
  }

  return { nodes, edges };
}
