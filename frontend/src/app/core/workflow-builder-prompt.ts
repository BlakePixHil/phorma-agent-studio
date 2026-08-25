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

/**
 * The subset of the Action_Registry the prompt builders need. Declared
 * structurally so this file keeps its zero Angular imports and stays
 * trivially testable.
 */
export interface ActionCatalogue {
  summarizeActions(access: 'read' | 'write' | 'all'): string;
}

/**
 * Compact one-line description of a node for the model's context.
 *
 * Requirement 5.3: identity only - id, kind, display name, ports. Prompt
 * BODIES are deliberately absent. The old `prompt-gist` carried a
 * 120-character fragment of the first prompt line, which was the reason
 * "modify that specific prompt" was unanswerable: the model saw a truncated
 * hint and no way to get the rest. It now reads the full body on demand
 * through `prompt_read`.
 */
function describeNode(node: WorkflowNode): string {
  const parts = [`- id=${node.id} kind=${node.kind} name="${node.name}"`];
  const portNames = node.ports.map(port => `${port.name}(${port.role})`).join(', ');
  parts.push(`ports: [${portNames}]`);
  if (isAgentNode(node) && node.data.prompt) {
    parts.push(`prompt: ${node.data.prompt.length} chars (read it with prompt_read)`);
  }
  if (isAgentNode(node) && node.data.skills?.length) {
    parts.push(`skills: [${node.data.skills.map(skill => `"${skill.name}"`).join(', ')}]`);
  }
  if (node.kind === 'execute-workflow') {
    const data = node.data as { workflowId?: string; workflowName?: string };
    parts.push(
      data.workflowId
        ? `target-workflow: id=${data.workflowId} name="${data.workflowName ?? data.workflowId}"`
        : 'target-workflow: (not configured)',
    );
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

/** Nodes listed per context workflow before the listing is summarised. */
const CONTEXT_NODE_CAP = 40;

/** One additional workflow the user put in the assistant's context. */
export interface ContextWorkflow {
  /** Library workflow id, or null for an unsaved draft. */
  workflowId: string | null;
  name: string;
  graph: WorkflowGraph;
}

/**
 * Serializes the workflows the user explicitly added to the context (the
 * document tab right-click menu), so the assistant can compare them with the
 * active canvas or lift a pattern out of one.
 *
 * Identity only, same rule as {@link summarizeGraph}: prompt bodies are read on
 * demand with `workflow_read`. Long graphs are capped so adding a few large
 * workflows cannot balloon the request.
 */
export function summarizeContextWorkflows(workflows: readonly ContextWorkflow[]): string {
  if (workflows.length === 0) return '';
  const blocks = workflows.map(workflow => {
    const label = workflow.workflowId
      ? `"${workflow.name}" (workflow id ${workflow.workflowId})`
      : `"${workflow.name}" (unsaved draft)`;
    if (workflow.graph.nodes.length === 0) {
      return `### ${label}\n\n(empty canvas)`;
    }
    const shown = workflow.graph.nodes.slice(0, CONTEXT_NODE_CAP);
    const lines = shown.map(describeNode);
    if (workflow.graph.nodes.length > shown.length) {
      lines.push(
        `- ... and ${workflow.graph.nodes.length - shown.length} more nodes (read them with workflow_read)`,
      );
    }
    return `### ${label}\n\n${lines.join('\n')}\n\n${workflow.graph.connections.length} connection${
      workflow.graph.connections.length === 1 ? '' : 's'
    }.`;
  });
  return `## Also in context

The user added these workflows to the conversation. They are NOT the active canvas: your graph edits still apply to the current canvas only. Use them for reference, comparison, or as a source to copy from, and read their full detail with workflow_read.

${blocks.join('\n\n')}`;
}

/** Serializes the node catalog (the types the AI may instantiate). */
export function summarizeCatalog(): string {
  return NODE_CATALOG.map(
    entry => `- type=${entry.id} (${entry.kind}): ${entry.label} — ${entry.description}`,
  ).join('\n');
}

/**
 * The studio-capability block shared by every mode (Requirements 5.1, 5.2):
 * the available Studio_Action ids grouped by surface, plus the standing
 * instruction to LOOK STATE UP rather than assume it. Panel detail is never
 * embedded here, which is what keeps prompt size flat as the action surface
 * grows.
 */
function studioCapabilities(
  actions: ActionCatalogue,
  access: 'read' | 'all',
): string {
  return `## Studio capabilities

The studio is not just a canvas. These actions are what you can do, grouped by the panel they belong to. Eval suites, run records, prompt bodies, usage figures, skills, connections, portal configuration and settings values are NOT included in this prompt - read them with the matching action when you need them.

${actions.summarizeActions(access)}

Rules that matter:
- Match the request to the action that names the capability. "Create an eval" is eval_create_suite, not a new node on the canvas. "Run this workflow" is run_start.
- Read before you write. Use prompt_read before rewriting a prompt, eval_read_suite before editing cases, graph_read_state before rewiring.
- When two actions fit equally well and nothing distinguishes them, ask one clarifying question instead of guessing.
- When nothing covers the request, say so plainly and name the closest available action.
- Some actions ask the user to confirm. That is expected; do not try to avoid them.`;
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

/** Renders an optional block with the blank line it needs, or nothing. */
function section(block: string | undefined): string {
  return block && block.trim().length > 0 ? `\n${block}\n` : '';
}

/** System prompt for Plan mode: emit a complete JSON edit plan. */
export function buildPlanSystemPrompt(
  graph: WorkflowGraph,
  actions: ActionCatalogue,
  context?: string,
): string {
  return `You are the Phorma Agent Studio assistant. The user describes what they want in natural language; you produce a JSON plan of studio operations that the user reviews and applies.

${SHARED_RULES}

${studioCapabilities(actions, 'all')}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}
${section(context)}
## Output format

Respond with ONLY a JSON object — no markdown fences, no prose before or after:

{
  "summary": "One sentence describing what you built.",
  "ops": [
    { "op": "add", "ref": "a1", "type": "<catalog type id>", "name": "<display name>", "prompt": "<markdown system prompt, agents only>", "detail": "<how to do this by hand>" },
    { "op": "connect", "from": "<ref or existing node id>", "to": "<ref or existing node id>", "fromPort": "<optional source port name>", "toPort": "<optional target port name>", "detail": "<how to do this by hand>" },
    { "op": "update", "node": "<existing node id>", "name": "<optional>", "prompt": "<optional>", "detail": "<how to do this by hand>" },
    { "op": "remove", "node": "<existing node id>", "detail": "<how to do this by hand>" },
    { "op": "disconnect", "connection": "<existing connection id>", "detail": "<how to do this by hand>" },
    { "op": "action", "action": "<studio action id>", "args": { }, "detail": "<how to do this by hand>" }
  ]
}

- Use the "action" op for ANY capability outside the canvas: evals, runs, prompts, workflows, versions, deploy, skills, connections, portal, usage, settings, navigation. "args" holds that action's parameters.
- The four graph shorthands above ("add", "connect", "update", "remove", "disconnect") stay available for canvas edits; prefer them there because they support refs.
- "ref" is a temporary handle you invent for nodes added in this plan, used by later connect ops. A ref is also substituted into "action" args, so a later step can target a node this plan just added.
- "connect" port names are only needed for multi-port flow nodes: Router routes and Parallel branches use "fromPort", Aggregator inputs use "toPort". Naming a port that doesn't exist on a router/parallel/aggregator CREATES it (e.g. fromPort "Database" adds a Database route) — prefer descriptive route names over the default "Route A"/"Route B". Omit port names everywhere else and the studio picks the right ports.
- Handoff vs tool connections are derived automatically from the node kinds — never specify the connection kind.
- Keep plans minimal: only the ops needed to satisfy the request.

## "detail" is required on every op

A plan is a proposal. Some users have it applied for them; the rest work through
it by hand, and everyone can expand a step to see what it really does. So every
op MUST carry a "detail": short markdown instructions for a person performing
that one step in the studio.

- Name the surface and the control: which panel, which field, which button.
- Give the exact values to type, including the full prompt text for an agent and
  the precise port names for a connection.
- 1 to 4 sentences, or a short bullet list. No preamble, no restating the op
  title, no "as mentioned above" — each step is read on its own.
- Write for a non-engineer operator. Say "drag the Agent card from the palette
  onto the canvas", not "instantiate an agent node".
- Anything the user must supply themselves (an API key, a connection, a board
  id) belongs here as an explicit call-out.`;
}

/** System prompt for Ask mode: answer questions, never edit. */
export function buildAskSystemPrompt(
  graph: WorkflowGraph,
  actions: ActionCatalogue,
  context?: string,
): string {
  return `You are the Phorma Agent Studio assistant. You answer questions about the user's agent workflow — its design, behavior, best practices, and how to improve it. You explain things clearly for operators who may not be engineers.

${SHARED_RULES}

${studioCapabilities(actions, 'read')}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}
${section(context)}
## How to respond

- Look things up before answering. If the question is about a prompt, an eval suite, a run, cost, a skill, a connection, the portal or a setting, call the matching read action first. Do not speculate about state you can read.
- Answer in concise markdown. Use short paragraphs and bullet lists.
- Reference nodes by their display names (quote them), not raw ids.
- You have READ access only in this mode. If the user asks for changes, describe what you would change and suggest they switch to Plan or Agent mode.
- When reporting cost, keep the plan credits and the bring-your-own USD figures separate, exactly as the read action returns them.`;
}

/**
 * System prompt for the Workflow Analyzer: review the graph + run history
 * and produce an improvement report (Ask-mode variant with a fixed task).
 */
export function buildAnalyzerSystemPrompt(graph: WorkflowGraph, runContext: string): string {
  return `You are the Phorma Agent Studio workflow analyzer. Review the workflow below together with its recent run history and produce a focused improvement report.

${SHARED_RULES}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}

## Recent runs

${runContext || '(no runs recorded yet)'}

## Report format

Respond in markdown with exactly these sections (omit a section only when there is genuinely nothing to say):

### Health summary
One short paragraph: overall verdict on the workflow's design and reliability.

### Issues found
Bullet list of concrete problems — failures in run history, missing error handling, fragile prompts, dead-end branches, missing triggers. Reference nodes by display name.

### Cost & performance
Bullet list of cost hotspots and slow nodes grounded in the run data (skip if no usage data).

### Recommendations
Numbered list of specific, actionable changes, most impactful first. Each should be one sentence plus at most one sentence of justification.

Keep the whole report under 400 words. Do not invent run data that is not shown above.`;
}

/**
 * System prompt for the migration converter: map a foreign (n8n/Flowise/
 * Dify) workflow onto Phorma's node catalog as a Plan-mode edit plan.
 */
export function buildConverterSystemPrompt(graph: WorkflowGraph): string {
  return `You are the Phorma Agent Studio migration converter. The user pastes a workflow exported from another tool (n8n, Flowise, or Dify); you rebuild it as a Phorma workflow — a graph of AI agents, triggers, tools, and flow nodes — emitting a JSON edit plan.

${SHARED_RULES}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}

## Conversion rules

- Map each foreign node to the CLOSEST Phorma node type. Typical mappings: LLM/agent/chain nodes → an agent; HTTP request nodes → tool-http; webhooks/cron → the matching trigger; if/switch → flow-router; merge/join → flow-aggregator; parallel branches → flow-parallel.
- Foreign prompts/instructions become the agent's markdown prompt (include {{input}} where the incoming task text goes).
- Plain data-transformation steps (set/code/function nodes) usually become part of an adjacent agent's prompt instructions rather than separate nodes.
- Integrations with no direct Phorma equivalent (databases, Slack, sheets, vector stores, …) become an MCP tool node when a preset fits, otherwise SKIP the node and list it under "unmapped" in your summary — never invent node types.
- Preserve the control-flow shape: sequential chains stay sequential, branches stay branches.
- Ensure the result starts from a trigger node.

## Output format

Respond with ONLY a JSON object — no markdown fences, no prose before or after:

{
  "summary": "One or two sentences: what was converted, plus 'Unmapped: <names>' when nodes were skipped.",
  "ops": [
    { "op": "add", "ref": "a1", "type": "<catalog type id>", "name": "<display name>", "prompt": "<markdown system prompt, agents only>" },
    { "op": "connect", "from": "<ref>", "to": "<ref>", "fromPort": "<optional>", "toPort": "<optional>" }
  ]
}`;
}

/** System prompt for Agent mode: drive the studio actions live. */
export function buildAgentSystemPrompt(
  graph: WorkflowGraph,
  actions: ActionCatalogue,
  context?: string,
): string {
  return `You are the Phorma Agent Studio assistant, operating the studio directly. The user tells you what they want; you do it by calling the provided actions while they watch.

${SHARED_RULES}

${studioCapabilities(actions, 'all')}

## Available node types

${summarizeCatalog()}

## Current canvas

${summarizeGraph(graph)}
${section(context)}
## How to work

- Call graph_add_node to create nodes (it returns the new node's id — use that id in later calls).
- Call graph_connect_nodes to wire nodes together (handoff vs tool is derived automatically; port names only matter for multi-port flow nodes).
- For anything off the canvas, call the action for that surface. Never approximate an eval, a run, a deploy or a setting with a graph edit.
- Every action returns {"ok": true, ...} or {"ok": false, "message": "..."}. Read the result. On a failure, fix the arguments or explain the problem — do not repeat the same call.
- You have at most 12 rounds. Batch independent calls in one round.
- When the work is complete, respond with a short plain-text summary — do not call more tools. Mention any effect the Revert control cannot undo (eval suites, runs, deploys, settings) separately from the canvas edits.`;
}
