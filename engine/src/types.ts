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

/** Configuration for an `ask-user` flow node. */
export interface AskUserNodeData {
  /**
   * Question template shown to the user. `{{field}}` placeholders
   * interpolate against the incoming JSON payload (e.g.
   * `Approve this draft for {{customer}}?`). When empty, the incoming
   * payload text is shown as the question.
   */
  question?: string;
  /**
   * Payload key the user's response is merged under (default
   * `userResponse`). The downstream agent receives
   * `{...original, [responseKey]: '...'}`.
   */
  responseKey?: string;
}

/** Configuration for an `execute-workflow` flow node. */
export interface ExecuteWorkflowNodeData {
  /** Id of the workflow resolved from the host or embedded registry. */
  workflowId?: string;
  /** Snapshot name used for readable traces when the target is unavailable. */
  workflowName?: string;
  /** Connected output used when nested execution fails. */
  errorPortId?: string;
}

// ── Portal (EPIC 9: published endpoints) ─────────────────────────────────────

/**
 * How a published workflow presents itself to visitors.
 * - `chat` — a conversational page; each message starts a run whose transcript
 *   is carried forward as `{{history}}`.
 * - `form` — typed fields submitted once; the answer streams back below.
 */
export type PortalMode = 'chat' | 'form';

/**
 * Who may reach a published surface.
 * - `public` — anyone with the link.
 * - `token`  — callers must present a scoped portal token.
 */
export type PortalAccess = 'public' | 'token';

/** Input control rendered on a `form`-mode portal. */
export interface PortalField {
  /**
   * Payload key. Reachable from agent prompts as `{{fields.<key>}}`.
   * Must match `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
   */
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean';
  required?: boolean;
  placeholder?: string;
  /** Allowed values for `select` fields. */
  options?: string[];
}

/**
 * Configuration for a `portal-trigger` node — the canvas-visible declaration
 * that a workflow is publicly reachable.
 *
 * The node is a pure pass-through entry point like every other trigger; the
 * host (cloud worker) reads this data at publish time to build the public
 * surface. Nothing here is secret: it is served to visitors as-is (minus
 * `slug`, which is in the URL anyway).
 */
export interface PortalTriggerData {
  /**
   * URL segment the portal is served from (`/p/{slug}`). Lower-case
   * alphanumerics and dashes; assigned at publish time when empty.
   */
  slug?: string;
  mode: PortalMode;
  /** Page heading. Falls back to the workflow name. */
  title?: string;
  /** Markdown opener shown before the first visitor message. */
  greeting?: string;
  /** Fields rendered in `form` mode. Ignored in `chat` mode. */
  fields?: PortalField[];
  /**
   * Node whose streamed tokens and final output the visitor sees. `null` /
   * absent = auto (the graph's single terminal leaf). Tokens from every other
   * node are withheld so internal reasoning never reaches the public.
   */
  responderNodeId?: string | null;
  access: PortalAccess;
  /** Per-visitor request ceiling. 0/absent = host default. */
  rateLimitPerMin?: number;
  theme?: 'auto' | 'light' | 'dark';
  /** False hides the "Powered by Phorma" footer. */
  showBranding?: boolean;
  /**
   * Allows this portal to be embedded in a page on another site via the
   * `/portal-embed.js` loader. When false the page sends
   * `frame-ancestors 'none'`, so it cannot be framed at all - which is what
   * stops an attacker framing a token-gated portal and clickjacking it.
   */
  embedEnabled?: boolean;
  /**
   * Sites permitted to frame this portal, as origins (`https://acme.com`).
   * Empty with `embedEnabled` on means "any site", which is a deliberate but
   * loud choice - the studio warns about it at publish time.
   */
  embedOrigins?: string[];
  /** Label on the launcher bubble the loader injects. */
  embedLabel?: string;
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

/**
 * A skill attached to an agent - a named, reusable markdown fragment
 * (prompt guidance + tool-usage instructions) appended to the agent's
 * rendered system prompt. Skills are embedded BY VALUE in the spec so
 * workflows stay portable; the `id` links back to the studio's skill
 * library for re-sync. Markdown only - no scripts, no sandbox.
 */
export interface AgentSkill {
  /** Library id (stable across edits; used to refresh embedded copies). */
  id: string;
  name: string;
  description?: string;
  /** Markdown body. Rendered verbatim into the system prompt (no `{{input}}` interpolation). */
  content: string;
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
  /**
   * Skills attached to this agent, embedded by value (see {@link AgentSkill}).
   * Rendered into the system prompt in array order.
   */
  skills?: AgentSkill[];
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
 * A workflow embedded by value for nested execution. Embedded workflows do
 * not recursively own registries; `WorkflowSpec.subWorkflows` is one flat,
 * cycle-safe registry containing the full transitive closure.
 */
export interface EmbeddedWorkflow {
  id: string;
  name: string;
  description?: string;
  graph: WorkflowGraph;
  settings?: WorkflowSettings;
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
  /** Flat by-value registry used by `execute-workflow` nodes. */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
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
