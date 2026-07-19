/**
 * Workflow domain model — the heart of Phorma Agent Studio.
 *
 * A Workflow is a graph of agents, triggers, tools, and flow nodes joined by
 * connections. It is the document the canvas renders, the engine executes,
 * and the `.phorma.json` file persists. Keep this file free of Angular and
 * Tauri imports: the same shapes are consumed by the run engine (`engine/`)
 * and the cloud worker (`cloud/`).
 */

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface GraphPosition {
  x: number;
  y: number;
}

// ── Node taxonomy ────────────────────────────────────────────────────────────

/** Visual/semantic grouping used for palette sections and canvas accents. */
export type NodeCategory = 'agent' | 'trigger' | 'tool' | 'flow';

/** Every node kind the canvas and engine understand. */
export type WorkflowNodeKind =
  | 'agent'
  | 'manual-trigger'
  | 'schedule-trigger'
  | 'webhook-trigger'
  | 'http-tool'
  | 'web-search-tool'
  | 'mcp-tool'
  | 'router'
  | 'parallel'
  | 'aggregator'
  | 'approval-gate'
  | 'for-each'
  | 'wait-event'
  | 'error-handler';

/** Category accent colors (hex) shared by the canvas renderer and minimap. */
export const NODE_CATEGORY_COLORS: Record<NodeCategory, string> = {
  agent: '#818cf8', // indigo — the stars of the show
  trigger: '#34d399', // emerald — entry points
  tool: '#fbbf24', // amber — capabilities
  flow: '#38bdf8', // sky — control flow
};

// ── Ports ────────────────────────────────────────────────────────────────────

/**
 * What a port does:
 * - `message-in`  — receives the task/conversation (left edge).
 * - `message-out` — emits the task onward via a handoff (right edge).
 * - `tools`       — capability port; agents expose one, tool nodes accept via
 *                   theirs. Tool links are declarations ("this agent may call
 *                   this tool"), not sequential flow.
 */
export type PortRole = 'message-in' | 'message-out' | 'tools';

export interface WorkflowPort {
  /** Stable base id. Connector ids add `-in` / `-out` suffixes. */
  id: string;
  /** Display label. For router out-ports this is the route label. */
  name: string;
  role: PortRole;
}

// ── Node data (kind-specific configuration) ──────────────────────────────────

/** Model providers supported in v1 (bring-your-own-key; Ollama is keyless). */
export type ModelProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'bedrock'
  // Routes inference through the Phorma Cloud proxy, billed against the
  // tenant's subscription credits. Curated big-name models only.
  | 'phorma-cloud';

export const MODEL_PROVIDERS: { id: ModelProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'bedrock', label: 'Amazon Bedrock' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'lmstudio', label: 'LM Studio (local)' },
  { id: 'phorma-cloud', label: 'Phorma Cloud' },
];

/**
 * Suggested models per provider (users can always type any model id).
 * Shared by the Prompt panel's model picker and the Settings dialog's
 * default-model picker.
 */
export const PROVIDER_MODEL_SUGGESTIONS: Record<ModelProviderId, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.2', 'gpt-5.2-mini', 'o4-mini'],
  gemini: ['gemini-3-pro', 'gemini-3-flash'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.2', 'meta-llama/llama-4-70b'],
  // Bedrock is invoked via the Converse API, which takes inference-profile ids
  // (geo/cross-region prefixes like `apac.`/`global.`). These are fallbacks
  // shown only if live discovery fails; the picker normally lists your account's
  // actual profiles.
  bedrock: [
    'global.anthropic.claude-sonnet-4-6',
    'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'apac.amazon.nova-pro-v1:0',
  ],
  ollama: ['llama3.2', 'qwen3', 'mistral-small'],
  lmstudio: ['llama-3.2-3b-instruct', 'qwen2.5-7b-instruct', 'mistral-7b-instruct'],
  // Phorma Cloud offers a curated set of big-name models, routed through
  // OpenRouter on the tenant's credit-limited runtime key. These are full
  // OpenRouter slugs and the ONLY models selectable for this provider.
  'phorma-cloud': [
    'openai/gpt-5.5',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-4.8',
    'google/gemini-3.5-flash',
  ],
};

/** Default AWS region for Amazon Bedrock when no region is configured. */
export const DEFAULT_BEDROCK_REGION = 'us-east-1';

/**
 * Amazon Bedrock regions offered in the Settings dropdown. Scoped to regions
 * that support the `bedrock-mantle` endpoint, because Claude via a Bedrock API
 * key is only reachable there. Agents can still type any region per node, so
 * this isn't a hard limit — it's the quick-pick set for the application default.
 */
export const BEDROCK_REGIONS: string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-south-1',
  'ap-northeast-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-north-1',
  'sa-east-1',
];

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
  /** System prompt. ALWAYS markdown — edited as markdown, rendered sanitized. */
  prompt: string;
  /**
   * Model provider. When absent the agent inherits the application-level
   * default model (Settings → Models). Resolved at run/deploy time.
   */
  provider?: ModelProviderId;
  /** Model id. Absent = inherit the application default (with `provider`). */
  model?: string;
  /**
   * AWS region for Amazon Bedrock agents (e.g. `ap-southeast-2`). Absent =
   * inherit the application default Bedrock region (Settings → Models). Lets
   * different agents target models hosted in different regions.
   */
  region?: string;
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

export interface ScheduleTriggerData {
  /** Cron expression evaluated by the deployed cloud runtime. */
  cron: string;
}

export interface WebhookTriggerData {
  /** Optional path hint for the deployed HTTP trigger endpoint. */
  path?: string;
}

export interface HttpToolData {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Markdown/JSON body template; `{{input}}` interpolates the agent's call. */
  bodyTemplate?: string;
}

export interface WebSearchToolData {
  maxResults?: number;
}

export interface McpToolData {
  /** `stdio` spawns a local process (desktop); `sse` connects over HTTP. */
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** Names of secret env vars to inject (values live in the OS keychain). */
  envKeys?: string[];
  /**
   * For remote (`sse`) servers: the name of the secret (in `envKeys`) whose
   * value is sent as `Authorization: Bearer <value>`. Resolved at request
   * time from secret storage — never persisted in the workflow file.
   */
  authKey?: string;
  /**
   * How the remote server authenticates:
   * - `bearer` (default when `authKey` is set): a static token/PAT.
   * - `oauth`: interactive OAuth 2.1; tokens are obtained via the Connect
   *   button and refreshed automatically. Never stored in the workflow file.
   */
  authMode?: 'bearer' | 'oauth';
  /** Preset that seeded this node, if any (enables preset-aware UI). */
  presetId?: string;
}

export interface RouterNodeData {
  /** Extra routing guidance appended to the routing prompt. Markdown. */
  instructions?: string;
}

export interface ApprovalGateData {
  /** Message shown to the human approver. Markdown. */
  message?: string;
}

export interface ForEachNodeData {
  /**
   * Optional dotted path to the array inside the incoming JSON payload
   * (e.g. `jobs`). Empty = auto-detect (whole-payload array, single array
   * property, or first embedded JSON array).
   */
  itemsPath?: string;
  /** Maximum concurrent iterations (1–8; default 1 = sequential). */
  concurrency?: number;
  /**
   * When true (default) a failing item is recorded as an exception and the
   * loop continues; when false the first failure fails the run.
   */
  continueOnError?: boolean;
}

export interface WaitEventNodeData {
  /**
   * Correlation key template; `{{field}}` interpolates against the incoming
   * JSON payload (e.g. `signed:{{jobId}}`). The run resumes when an external
   * event with the rendered key arrives.
   */
  correlationKey?: string;
  /** Note shown while waiting. Markdown. */
  message?: string;
  /**
   * Maximum hours to wait before the node fails (0/absent = wait forever).
   * Measured from (re-)registration; a resumed run restarts the clock.
   */
  timeoutHours?: number;
}

/**
 * Union of all kind-specific node configuration. Narrow via `node.kind`
 * (e.g. `isAgentNode(node)`); nodes without configuration carry `{}`.
 */
export type WorkflowNodeData =
  | AgentNodeData
  | ScheduleTriggerData
  | WebhookTriggerData
  | HttpToolData
  | WebSearchToolData
  | McpToolData
  | RouterNodeData
  | ApprovalGateData
  | ForEachNodeData
  | WaitEventNodeData
  | Record<string, never>;

// ── Nodes, connections, graph ────────────────────────────────────────────────

export interface WorkflowNode {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  category: NodeCategory;
  /** Tabler icon class (`ti ti-*`). PrimeIcons are not used in Agent Studio. */
  icon: string;
  position: GraphPosition;
  ports: WorkflowPort[];
  /** Kind-specific configuration edited by the Prompt/Properties panels. */
  data: WorkflowNodeData;
  /** Short human-readable description shown in the properties panel. */
  description?: string;
}

/**
 * Edge semantics:
 * - `handoff`   — control flow: when the source finishes/decides, the task
 *                 passes to the target. Rendered solid; pulses during runs.
 * - `tool-link` — capability: the source agent may call the target tool.
 *                 Rendered dashed; not sequential flow.
 */
export type WorkflowEdgeKind = 'handoff' | 'tool-link';

export interface WorkflowConnection {
  id: string;
  /** Source connector id — a port base id with the `-out` suffix. */
  outputId: string;
  /** Target connector id — a port base id with the `-in` suffix. */
  inputId: string;
  kind: WorkflowEdgeKind;
  /** Optional edge label (e.g. a router branch condition). */
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

// ── The workflow document ────────────────────────────────────────────────────

export const WORKFLOW_SPEC_VERSION = 1;

/** File extension for exported workflow documents. */
export const WORKFLOW_FILE_EXTENSION = 'phorma.json';

/** Workflow-level execution settings, persisted in the spec. */
export interface WorkflowSettings {
  /**
   * Maximum minutes a run may take end-to-end before it fails with a
   * timeout. Paused time doesn't count. 0/absent = no limit.
   */
  timeoutMinutes?: number;
}

/**
 * The portable workflow document — persisted to IndexedDB, exported as
 * `.phorma.json`, and shipped to the cloud runtime on deploy.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

export function emptyGraph(): WorkflowGraph {
  return { nodes: [], connections: [] };
}

export function isAgentNode(node: WorkflowNode): node is WorkflowNode & { data: AgentNodeData } {
  return node.kind === 'agent';
}

/** Strips the `-in` / `-out` connector suffix, returning the port base id. */
export function portBaseId(connectorId: string): string {
  return connectorId.replace(/-(in|out)$/, '');
}

/**
 * Resolves a connector id back to the owning node and port. Returns
 * `undefined` when no matching port exists (e.g. after a node deletion).
 */
export function findNodeForConnector(
  graph: WorkflowGraph,
  connectorId: string,
): { node: WorkflowNode; port: WorkflowPort } | undefined {
  const baseId = portBaseId(connectorId);
  for (const node of graph.nodes) {
    const match = node.ports.find(port => port.id === baseId);
    if (match) return { node, port: match };
  }
  return undefined;
}

/**
 * Lookup index mapping every port base id to its role and owning node id.
 * Lets the canvas classify all connections in one O(n) pass.
 */
export interface PortIndex {
  readonly roles: ReadonlyMap<string, PortRole>;
  readonly nodeIds: ReadonlyMap<string, string>;
}

export function buildPortIndex(graph: WorkflowGraph): PortIndex {
  const roles = new Map<string, PortRole>();
  const nodeIds = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const port of node.ports) {
      roles.set(port.id, port.role);
      nodeIds.set(port.id, node.id);
    }
  }
  return { roles, nodeIds };
}

/**
 * Derives the edge kind for a new connection: touching a `tools` port on
 * either side makes it a capability tool-link; otherwise it's a handoff.
 */
export function edgeKindForPorts(source: PortRole, target: PortRole): WorkflowEdgeKind {
  return source === 'tools' || target === 'tools' ? 'tool-link' : 'handoff';
}

/**
 * Validates that a connection between two port roles makes sense:
 * - handoffs run message-out → message-in;
 * - tool links join a `tools` port and a tool node's `tools` port.
 * Anything else (message-in → message-in, tools → message-in, ...) is invalid.
 */
export function canConnectPorts(source: PortRole, target: PortRole): boolean {
  if (source === 'tools' || target === 'tools') {
    return source === 'tools' && target === 'tools';
  }
  return source === 'message-out' && target === 'message-in';
}
