/**
 * Workflow spec types — the wire contract between the studio, this engine,
 * and the cloud runtime.
 *
 * These are STRUCTURAL twins of the richer types in
 * `frontend/src/app/core/workflow.model.ts` (which adds UI-only concerns like
 * category colors). TypeScript's structural typing lets the frontend pass its
 * graphs straight in. If you change a shape here, change it there too.
 */

export interface GraphPosition {
  x: number;
  y: number;
}

export type PortRole = 'message-in' | 'message-out' | 'tools';

export interface WorkflowPort {
  id: string;
  name: string;
  role: PortRole;
}

export type ModelProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'bedrock';

export interface AgentNodeData {
  /** Markdown system prompt. `{{input}}` interpolates the incoming task. */
  prompt: string;
  /**
   * Model provider. When absent the agent inherits the run's default model
   * (`RunOptions.defaultModel`), which the studio wires to its application
   * settings and the cloud path materializes at deploy time.
   */
  provider?: ModelProviderId;
  /** Model id. Absent = inherit the run default (with `provider`). */
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface WorkflowNode {
  id: string;
  name: string;
  kind: string;
  category: string;
  icon: string;
  position: GraphPosition;
  ports: WorkflowPort[];
  /**
   * Kind-specific configuration. Typed loosely at the package boundary so the
   * studio's richer union types remain structurally assignable; executors
   * narrow it per kind.
   */
  data: object;
  description?: string;
}

export type WorkflowEdgeKind = 'handoff' | 'tool-link';

export interface WorkflowConnection {
  id: string;
  /** Source connector id — a port base id with the `-out` suffix. */
  outputId: string;
  /** Target connector id — a port base id with the `-in` suffix. */
  inputId: string;
  kind: WorkflowEdgeKind;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

/**
 * The portable workflow document — what the studio exports as
 * `.phorma.json` and pushes to the cloud runtime on deploy.
 */
export interface WorkflowSpec {
  version: number;
  id: string;
  name: string;
  description?: string;
  graph: WorkflowGraph;
  /** ISO timestamp of the last save. */
  savedAt: string;
}

/** Strips the `-in` / `-out` connector suffix, returning the port base id. */
export function portBaseId(connectorId: string): string {
  return connectorId.replace(/-(in|out)$/, '');
}

/** Resolves a connector id to its owning node, or undefined. */
export function nodeForConnector(
  graph: WorkflowGraph,
  connectorId: string,
): WorkflowNode | undefined {
  const baseId = portBaseId(connectorId);
  return graph.nodes.find(node => node.ports.some(port => port.id === baseId));
}

/** Type guard for agent nodes. */
export function isAgentNode(
  node: WorkflowNode,
): node is WorkflowNode & { data: AgentNodeData } {
  return node.kind === 'agent';
}
