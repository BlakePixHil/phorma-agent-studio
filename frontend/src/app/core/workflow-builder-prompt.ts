/**
 * Prompt assembly for the AI workflow builder (command palette).
 *
 * Serializes the active canvas graph and the node catalog into a compact,
 * model-friendly system prompt so the AI can understand the existing
 * architecture and reuse pieces already on the canvas. Shared by both
 * builder modes (Plan and Agent) — keep this file free of Angular imports
 * so it stays trivially testable.
 */

import { NODE_CATALOG } from './node-catalog';
import {
  findNodeForConnector,
  isAgentNode,
  type WorkflowGraph,
  type WorkflowNode,
} from './workflow.model';

/** Compact one-line description of a node for the model's context. */
function describeNode(node: WorkflowNode): string {
  const parts = [`- id=${node.id} kind=${node.kind} name="${node.name}"`];
  const portNames = node.ports.map(port => `${port.name}(${port.role})`).join(', ');
  parts.push(`ports: [${portNames}]`);
  if (isAgentNode(node) && node.data.prompt) {
    // First non-heading, non-empty prompt line — enough to convey the role.
    const gist = node.data.prompt
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0 && !line.startsWith('#'));
    if (gist) parts.push(`prompt-gist: "${gist.slice(0, 120)}"`);
  }
  return parts.join(' | ');
}

/** Serializes the current graph into a compact text block for the model. */
export function summarizeGraph(graph: WorkflowGraph): string {
  if (graph.nodes.length === 0) {
    return 'The canvas is currently EMPTY — you are building from scratch.';
  }
  const nodes = graph.nodes.map(describeNode).join('\n');
  const connections =
    graph.connections.length === 0
      ? '(none)'
      : graph.connections
          .map(conn => {
            const source = findNodeForConnector(graph, conn.outputId);
            const target = findNodeForConnector(graph, conn.inputId);
            if (!source || !target) return null;
            return `- ${conn.kind}: ${source.node.id} ("${source.node.name}") -> ${target.node.id} ("${target.node.name}") [connection-id=${conn.id}]`;
          })
          .filter((line): line is string => line !== null)
          .join('\n');
  return `Nodes already on the canvas:\n${nodes}\n\nExisting connections:\n${connections}`;
}

/** Serializes the node catalog (the types the AI may instantiate). */
export function summarizeCatalog(): string {
  return NODE_CATALOG.map(
    entry => `- type=${entry.id} (${entry.kind}): ${entry.label} — ${entry.description}`,
  ).join('\n');
}

/** Domain rules both modes must respect, phrased for the model. */
const SHARED_RULES = `
## Domain rules

- A workflow is a graph of nodes joined by connections.
- "handoff" connections are sequential control flow: source finishes, target starts. They run from a message-out port to a message-in port.
- "tool" connections declare a capability: an agent MAY call the tool. They join an agent's Tools port to a tool node's Tool port. Tools are NOT sequential steps.
- Every runnable workflow should start from a trigger node (usually trigger-manual) handing off to the first agent.
- Agents do the thinking; tools (web search, HTTP, MCP) give them capabilities; flow nodes (router, parallel, aggregator, approval-gate) shape control flow.
- Agent prompts are markdown and should contain {{input}} where the incoming task text is interpolated.
- REUSE existing canvas nodes whenever they fit the request instead of duplicating them. Connect to existing nodes by their id.
- Do not remove or rewrite existing nodes unless the request clearly asks for it.
- Node positions are handled automatically — never worry about coordinates.
`.trim();

/** System prompt for Plan mode: emit a complete JSON edit plan. */
export function buildPlanSystemPrompt(graph: WorkflowGraph): string {
  return `You are the Phorma Agent Studio workflow architect. The user describes a workflow in natural language; you design it as a graph of AI agents, triggers, tools, and flow nodes, emitting a JSON edit plan that the studio applies to the canvas.

${SHARED_RULES}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}

## Output format

Respond with ONLY a JSON object — no markdown fences, no prose before or after:

{
  "summary": "One sentence describing what you built.",
  "ops": [
    { "op": "add", "ref": "a1", "type": "<catalog type id>", "name": "<display name>", "prompt": "<markdown system prompt, agents only>" },
    { "op": "connect", "from": "<ref or existing node id>", "to": "<ref or existing node id>", "fromPort": "<optional source port name>", "toPort": "<optional target port name>" },
    { "op": "update", "node": "<existing node id>", "name": "<optional>", "prompt": "<optional>" },
    { "op": "remove", "node": "<existing node id>" },
    { "op": "disconnect", "connection": "<existing connection id>" }
  ]
}

- "ref" is a temporary handle you invent for nodes added in this plan, used by later connect ops.
- "connect" port names are only needed for multi-port flow nodes (e.g. Router "Route A"/"Route B", Parallel branches, Aggregator inputs); omit them otherwise and the studio picks the right ports.
- Handoff vs tool connections are derived automatically from the node kinds — never specify the connection kind.
- Keep plans minimal: only the ops needed to satisfy the request.`;
}

/** System prompt for Agent mode: drive the graph tools live. */
export function buildAgentSystemPrompt(graph: WorkflowGraph): string {
  return `You are the Phorma Agent Studio workflow architect. The user describes a workflow in natural language; you build it directly on the canvas by calling the provided graph tools, one edit at a time.

${SHARED_RULES}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}

## How to work

- Call add_node to create nodes (it returns the new node's id — use that id in later calls).
- Call connect_nodes to wire nodes together (handoff vs tool is derived automatically; port names only matter for multi-port flow nodes).
- Call update_node / remove_node / remove_connection to modify existing pieces when the request calls for it.
- When the build is complete, respond with a short plain-text summary of what you built — do not call more tools.`;
}
