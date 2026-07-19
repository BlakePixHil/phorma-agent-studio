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
  | 'bedrock'
  | 'lmstudio'
  // Routes inference through the Phorma Cloud proxy (POST /api/infer),
  // billed against the tenant's credit-limited OpenRouter key. The model id
  // is already a full OpenRouter slug (curated big-name models only).
  | 'phorma-cloud';

/** Configuration for a `for-each` flow node. */
export interface ForEachNodeData {
  /**
   * Optional dotted path to the array inside the incoming JSON payload
   * (e.g. `jobs`). When empty the node auto-detects: whole-payload array,
   * single array property, or first embedded JSON array.
   */
  itemsPath?: string;
  /** Maximum concurrent iterations (default 1 = sequential). */
  concurrency?: number;
  /**
   * When true (default), an item whose subgraph fails is recorded as an
   * exception and the loop continues. When false the first failure fails
   * the whole run.
   */
  continueOnError?: boolean;
}

/** Configuration for a `wait-event` flow node. */
export interface WaitEventNodeData {
  /**
   * Correlation key template. `{{field}}` placeholders interpolate against
   * the incoming JSON payload (e.g. `signed:{{jobId}}`). The run resumes
   * when an external event with the rendered key arrives.
   */
  correlationKey?: string;
  /** Human-readable note shown while waiting. Markdown. */
  message?: string;
  /**
   * Maximum hours to wait before the node fails (0/absent = wait forever).
   * Enforced by the host; measured from (re-)registration, so a resumed
   * run restarts the clock.
   */
  timeoutHours?: number;
}

/**
 * Retry policy for an agent's model calls. Transient failures (429, 5xx,
 * network drops, timeouts) are retried BY DEFAULT (one retry, 1s backoff);
 * this object tunes or disables that behaviour per node.
 */
export interface AgentRetryPolicy {
  /** Total attempts including the first (default 2, i.e. one retry). */
  maxAttempts?: number;
  /** Base backoff before the first retry, doubled per attempt (default 1000). */
  backoffMs?: number;
  /** `transient` (default) retries 429/5xx/network only; `all` retries everything. */
  retryOn?: 'transient' | 'all';
  /** True disables automatic retries for this node. */
  disabled?: boolean;
}

/** Secondary model used when the primary model still fails after retries. */
export interface AgentFallbackModel {
  provider: ModelProviderId;
  model: string;
}

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
  /** Retry tuning for transient model failures (see {@link AgentRetryPolicy}). */
  retry?: AgentRetryPolicy;
  /** Fallback model tried when the primary fails after all retries. */
  fallback?: AgentFallbackModel;
  /**
   * Maximum seconds for this node's whole execution (all model rounds and
   * tool calls). 0/absent = no per-node timeout.
   */
  timeoutSec?: number;
  /**
   * Port base id of this agent's "On error" out-port. When set AND that port
   * has a connected handoff, a failure routes an error payload through it
   * instead of failing the run.
   */
  errorPortId?: string;
  /** True disables automatic context compression for long tool loops. */
  compressionDisabled?: boolean;
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

/** Workflow-level execution settings, persisted in the spec. */
export interface WorkflowSettings {
  /**
   * Maximum minutes a run may take end-to-end before it fails with a
   * timeout. Paused time doesn't count. 0/absent = no limit.
   */
  timeoutMinutes?: number;
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
  /** Workflow-level execution settings (timeout, …). */
  settings?: WorkflowSettings;
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
