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
  | 'portal-trigger'
  | 'http-tool'
  | 'web-search-tool'
  | 'mcp-tool'
  | 'router'
  | 'parallel'
  | 'aggregator'
  | 'approval-gate'
  | 'for-each'
  | 'wait-event'
  | 'ask-user'
  | 'execute-workflow'
  | 'error-handler'
  // ── Phase 1: deterministic data path ──────────────────────────────────────
  | 'http-request' // P1-2  flow step (distinct from the existing 'http-tool')
  | 'sql-query' // P1-6
  | 'transform' // P1-4
  | 'aggregate' // P1-5
  | 'assert' // P1-9
  | 'state-get' // P1-8
  | 'state-set' // P1-8
  | 'notify'; // P1-10

/**
 * Kinds that execute in the graph walk AND may perform external I/O. Every one
 * carries `category: 'flow'`, so the palette section and canvas accent reuse
 * the existing sky colour with no change to {@link NODE_CATEGORY_COLORS}.
 *
 * Structural twin of `DATA_NODE_KINDS` in `engine/src/types.ts`.
 */
export const DATA_NODE_KINDS: readonly WorkflowNodeKind[] = [
  'http-request',
  'sql-query',
  'transform',
  'aggregate',
  'assert',
  'state-get',
  'state-set',
  'notify',
] as const;

/** Data nodes that reach outside the run (fixtures + egress declaration). */
export const DATA_IO_KINDS: readonly WorkflowNodeKind[] = [
  'http-request',
  'sql-query',
  'notify',
] as const;

/**
 * A data node exposes message ports only. `tool-link` edges touching a data
 * node are rejected — determinism depends on the graph walk owning these
 * steps, never a model's choice ("data nodes are not tools").
 *
 * Structural twin of `isDataNode` in `engine/src/types.ts`.
 */
export function isDataNode(node: Pick<WorkflowNode, 'kind'>): boolean {
  return (DATA_NODE_KINDS as readonly string[]).includes(node.kind);
}

/**
 * True when a `tool-link` edge is illegal for this endpoint.
 *
 * Structural twin of `rejectsToolLink` in `engine/src/types.ts`.
 */
export function rejectsToolLink(node: Pick<WorkflowNode, 'kind'>): boolean {
  return isDataNode(node);
}

/** Validation message returned when a `tool-link` endpoint is a data node. */
export const TOOL_LINK_ON_DATA_NODE_MESSAGE =
  'Data nodes cannot be attached to an agent as a tool.';

/**
 * Rejection reason for a proposed edge whose derived kind is `tool-link` and
 * whose source or target endpoint is a data node, or `null` when the edge is
 * allowed. Callers must consult this BEFORE mutating the graph.
 */
export function toolLinkRejection(
  source: { node: Pick<WorkflowNode, 'kind'>; role: PortRole },
  target: { node: Pick<WorkflowNode, 'kind'>; role: PortRole },
): string | null {
  if (edgeKindForPorts(source.role, target.role) !== 'tool-link') return null;
  if (!rejectsToolLink(source.node) && !rejectsToolLink(target.node)) return null;
  return TOOL_LINK_ON_DATA_NODE_MESSAGE;
}

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
 * Retry policy for ANY node kind — an agent's model calls or a data node's
 * HTTP/SQL/notify call. Transient failures (429, 5xx, network drops, timeouts)
 * are retried BY DEFAULT; this object tunes or disables that behaviour per node.
 *
 * Structural twin of `NodeRetryPolicy` in `engine/src/types.ts`.
 */
export interface NodeRetryPolicy {
  /** Total attempts including the first (default 2 for agents, 3 for data I/O). */
  maxAttempts?: number;
  /** Base backoff before the first retry, doubled per attempt (default 1000). */
  backoffMs?: number;
  /** Backoff ceiling per attempt (default 30_000). */
  maxBackoffMs?: number;
  /** `transient` (default) retries 429/5xx/network only; `all` retries everything; `none` disables. */
  retryOn?: 'transient' | 'all' | 'none';
  /** True disables automatic retries for this node. */
  disabled?: boolean;
  /**
   * Declares the step safe to repeat. Non-idempotent steps are retried ONLY on
   * errors that prove the request never landed (connect/DNS/TLS), never on a
   * 5xx or a timeout.
   */
  idempotent?: boolean;
  /** Honour a `Retry-After` header when present (default true). */
  honorRetryAfter?: boolean;
  /** Ceiling applied to a server-provided Retry-After (default 120_000). */
  maxRetryAfterMs?: number;
}

/**
 * @deprecated Use {@link NodeRetryPolicy}. Kept as an alias so existing specs
 * and agent-only call sites keep working unchanged.
 */
export type AgentRetryPolicy = NodeRetryPolicy;

/** Secondary model used when the primary model still fails after retries. */
export interface AgentFallbackModel {
  provider: ModelProviderId;
  model: string;
}

/**
 * A skill attached to an agent - a named, reusable markdown fragment
 * (prompt guidance + tool-usage instructions) appended to the agent's
 * rendered system prompt. Skills are embedded BY VALUE in the spec so
 * workflows stay portable; the `id` links back to the skill library
 * for re-sync. Markdown only - no scripts, no sandbox.
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
  /**
   * Skills attached to this agent, embedded by value (see {@link AgentSkill}).
   * Rendered into the system prompt in array order.
   */
  skills?: AgentSkill[];
}

export interface ScheduleTriggerData {
  /** Cron expression evaluated by the deployed cloud runtime. */
  cron: string;
}

export interface WebhookTriggerData {
  /** Optional path hint for the deployed HTTP trigger endpoint. */
  path?: string;
}

// ── Portal (EPIC 9: published endpoints) ─────────────────────────────────────
// Structural twins of the same names in `engine/src/types.ts`. Keep in sync.

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
  /** Payload key, reachable from prompts as `{{fields.<key>}}`. */
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
 * that a workflow is publicly reachable. Read at publish time to build the
 * public surface; nothing here is secret.
 */
export interface PortalTriggerData {
  /** URL segment (`/p/{slug}`). Assigned at publish time when empty. */
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
   * absent = auto (the graph's single terminal leaf).
   */
  responderNodeId?: string | null;
  access: PortalAccess;
  /** Per-visitor request ceiling. 0/absent = host default. */
  rateLimitPerMin?: number;
  theme?: 'auto' | 'light' | 'dark';
  /** False hides the "Powered by Phorma" footer. */
  showBranding?: boolean;
  /** Allows embedding on other sites via the `/portal-embed.js` loader. */
  embedEnabled?: boolean;
  /** Origins permitted to frame this portal. Empty + enabled = any site. */
  embedOrigins?: string[];
  /** Label on the launcher bubble the loader injects. */
  embedLabel?: string;
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
  /**
   * P1-7: when > 1, the loop yields ARRAYS of up to `batchSize` items instead
   * of single items, so a target API's "max 100 per call" limit is one config
   * field instead of a subgraph. 0/1/absent = today's per-item behaviour.
   */
  batchSize?: number;
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

/** Configuration for an `ask-user` flow node. */
export interface AskUserNodeData {
  /**
   * Question template shown to the user. `{{field}}` placeholders interpolate
   * against the incoming JSON payload (e.g. `Approve this draft for {{customer}}?`).
   * When empty, the incoming payload text is shown as the question.
   */
  question?: string;
  /**
   * Payload key the user's response is merged under (default `userResponse`).
   * The downstream agent receives `{...original, [responseKey]: '...'}`.
   */
  responseKey?: string;
}

/** Configuration for an `execute-workflow` flow node. */
export interface ExecuteWorkflowNodeData {
  /** Id of the workflow resolved from the library or embedded registry. */
  workflowId?: string;
  /** Snapshot name used for readable traces when the target is unavailable. */
  workflowName?: string;
  /** Connected output used when nested execution fails. */
  errorPortId?: string;
}

// ── Phase 1 data nodes: shared vocabulary ────────────────────────────────────
// Structural twins of the same names in `engine/src/types.ts`. Keep in sync.

/** Anything that reads a `{{path}}`-interpolated template against the payload. */
export type PayloadTemplate = string;

/** SQL driver families. Host support is declared in the capability matrix. */
export type SqlDriver = 'postgres' | 'mysql' | 'mssql' | 'sqlite';

/** Fixture mode for the two I/O node kinds (P1-13). */
export type FixtureMode = 'off' | 'record' | 'replay' | 'replay-or-record';

/**
 * Field-level redaction rule applied to every persisted payload (P1-12).
 * `path` matches a dotted JSON path; `key` matches any property name;
 * `pattern` is a bounded regex source applied to string values.
 */
export interface RedactionRule {
  kind: 'path' | 'key' | 'pattern';
  value: string;
  /** Replacement. Default `'[redacted]'`. `hash` stores an fnv1a fingerprint. */
  replace?: 'mask' | 'hash' | 'drop';
}

// ── P1-2 http-request ────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequestNodeData {
  connectionId?: string;
  method: HttpMethod;
  /** Path appended to the connection's `config.baseUrl`, or an absolute URL. */
  url: PayloadTemplate;
  query?: { key: string; value: PayloadTemplate }[];
  /** Non-secret headers only. Auth comes from the connection, never from here. */
  headers?: { key: string; value: PayloadTemplate }[];
  bodyMode?: 'none' | 'json' | 'text' | 'form';
  /** Template rendered then (for `json`) parsed to validate before sending. */
  body?: PayloadTemplate;
  /** Extra codes treated as success. Default: 2xx. */
  successCodes?: number[];
  /** Dotted path selecting what lands in the outgoing payload. */
  resultPath?: string;
  /** Key the result is wrapped under. Default: replace the payload. */
  resultKey?: string;
  responseMode?: 'json' | 'text';
  pagination?: PaginationConfig;
  /** Idempotency key template; sent as `Idempotency-Key` and used by the retry classifier. */
  idempotencyKey?: PayloadTemplate;
  retry?: NodeRetryPolicy;
  timeoutSec?: number;
  /** Opt-in payload capture for the trace. Off by default. */
  persistRequestBody?: boolean;
  persistResponseBody?: boolean;
  fixtures?: FixtureMode;
  errorPortId?: string;
}

/** P1-7: paginated fetch. The node loops until exhausted or `maxPages`. */
export type PaginationConfig =
  | { mode: 'none' }
  | {
      mode: 'cursor';
      cursorPath: string;
      cursorParam: string;
      itemsPath: string;
      maxPages: number;
    }
  | {
      mode: 'page';
      pageParam: string;
      sizeParam?: string;
      pageSize?: number;
      startPage?: number;
      itemsPath: string;
      maxPages: number;
    }
  | {
      mode: 'offset';
      offsetParam: string;
      limitParam: string;
      limit: number;
      itemsPath: string;
      maxPages: number;
    }
  | { mode: 'link-header'; rel?: string; itemsPath: string; maxPages: number };

// ── P1-6 sql-query ───────────────────────────────────────────────────────────

export interface SqlQueryNodeData {
  connectionId?: string;
  /** Mirrors the connection's driver; validated to match at push time. */
  driver?: SqlDriver;
  /**
   * Parameterised statement. Named parameters (`:name`) ONLY — the properties
   * panel offers no way to concatenate payload text into SQL.
   */
  statement: string;
  /** Parameter name -> expression evaluated against the payload. */
  params?: { name: string; expression: string }[];
  maxRows?: number;
  statementTimeoutMs?: number;
  /** Default `rows`. */
  resultKey?: string;
  retry?: NodeRetryPolicy;
  fixtures?: FixtureMode;
  errorPortId?: string;
  /** Off by default. */
  persistRows?: boolean;
}

// ── P1-4 transform ───────────────────────────────────────────────────────────

export interface TransformNodeData {
  /** Applied to each element when set, otherwise to the whole payload. */
  itemsPath?: string;
  mode?: 'record' | 'array';
  fields: TransformField[];
  /** Named lookup tables addressable as `lookup('name', key)` in expressions. */
  lookups?: Record<string, Record<string, string | number | boolean>>;
  /** True keeps unmapped source fields; false (default) emits only `fields`. */
  passthrough?: boolean;
  /** Wraps an array projection under this key; absent emits a bare array. */
  resultKey?: string;
}

export interface TransformField {
  /** Dotted target path; `a.b` creates nested objects. */
  target: string;
  /** Expression in the engine grammar. */
  expression: string;
  cast?: 'string' | 'number' | 'integer' | 'boolean' | 'date-iso';
  /** Used when the expression yields null/undefined. */
  default?: string | number | boolean | null;
  /** Fail the node when the result is null/undefined after `default`. */
  required?: boolean;
}

// ── P1-5 aggregate ───────────────────────────────────────────────────────────

export interface AggregateNodeData {
  op: 'group' | 'join' | 'pivot';
  itemsPath?: string;
  group?: GroupSpec;
  join?: JoinSpec;
  pivot?: PivotSpec;
  resultKey?: string;
}

export interface GroupSpec {
  /** Dotted source paths. */
  by: string[];
  metrics: AggregateMetric[];
}

export interface AggregateMetric {
  name: string;
  fn: 'count' | 'countIf' | 'sum' | 'min' | 'max' | 'avg' | 'first' | 'distinct';
  /** Source path for value-taking fns; ignored by `count`. */
  path?: string;
  /** Predicate expression for `countIf`, evaluated per row. */
  where?: string;
}

export interface JoinSpec {
  leftPath: string;
  rightPath: string;
  leftKey: string;
  rightKey: string;
  type: 'inner' | 'left';
  /** Prefix applied to right-hand fields on collision. Default `right_`. */
  collisionPrefix?: string;
}

export interface PivotSpec {
  /** Path to grouped rows. */
  rowsPath?: string;
  /** e.g. `['group','bucket']` -> `'A_x'`. */
  keyFields: string[];
  /** e.g. `'n'`. */
  valueField: string;
  /** Default `'_'`. */
  separator?: string;
  /** Emitted for pivot columns absent from the data. */
  fillValue?: number | string | null;
  /**
   * Pivot column vocabulary. Every declared column absent from the grouped rows
   * is emitted as `fillValue` (Requirement 6.9).
   */
  columns?: string[];
}

// ── P1-9 assert ──────────────────────────────────────────────────────────────

export interface AssertNodeData {
  assertions: Assertion[];
  /** `fail` (default) fails the node; `route` sends it out the Failed port. */
  onBreach?: 'fail' | 'route';
  failedPortId?: string;
  /** Comparison baseline for variance guards, read from the state store. */
  baselineStateKey?: string;
}

export interface Assertion {
  /** Shown in the breach message and the sync audit record. */
  name: string;
  /** Boolean expression that MUST hold. */
  expression: string;
  /** Optional human explanation surfaced on breach. */
  message?: string;
  severity?: 'error' | 'warn';
}

// ── P1-8 state nodes ─────────────────────────────────────────────────────────

export interface StateGetNodeData {
  /** Key template, interpolated against the payload. */
  key: PayloadTemplate;
  /** Default `state`. */
  resultKey?: string;
  /** Emitted when the key is absent. */
  defaultValue?: string;
}

export interface StateSetNodeData {
  key: PayloadTemplate;
  /** Expression producing the value to store. */
  valueExpression: string;
  /** Time-to-live in seconds. Absent = retention policy default. */
  ttlSec?: number;
  /** `delta` writes a content hash; `watermark` keeps a monotonic maximum. */
  semantics?: 'value' | 'delta' | 'watermark';
}

// ── P1-10 notify ─────────────────────────────────────────────────────────────

export interface NotifyNodeData {
  channel: 'email' | 'webhook' | 'chat-webhook';
  connectionId?: string;
  /** Email recipient. */
  to?: PayloadTemplate;
  subject?: PayloadTemplate;
  /** Markdown body template. */
  body?: PayloadTemplate;
  retry?: NodeRetryPolicy;
  errorPortId?: string;
}

/**
 * Union of all kind-specific node configuration. Narrow via `node.kind`
 * (e.g. `isAgentNode(node)`); nodes without configuration carry `{}`.
 */
export type WorkflowNodeData =
  | AgentNodeData
  | ScheduleTriggerData
  | WebhookTriggerData
  | PortalTriggerData
  | HttpToolData
  | WebSearchToolData
  | McpToolData
  | RouterNodeData
  | ApprovalGateData
  | ForEachNodeData
  | WaitEventNodeData
  | AskUserNodeData
  | ExecuteWorkflowNodeData
  | HttpRequestNodeData
  | SqlQueryNodeData
  | TransformNodeData
  | AggregateNodeData
  | AssertNodeData
  | StateGetNodeData
  | StateSetNodeData
  | NotifyNodeData
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
  /** P1-10: run-outcome notification policy. */
  notifications?: {
    /** 0 to 3 unique triggers. Absent trigger = no notification for it. */
    on: ('failure' | 'guard-breach' | 'completion')[];
    /** Connection used to deliver. Absent = the host's default channel. */
    connectionId?: string;
    /** Recipient (email address or webhook target) for the delivery. */
    to?: string;
  };
  /** P1-12: run-history retention and redaction. */
  retention?: {
    /** Runs kept for this workflow (1-1000). 0/absent = host default (50). */
    keepRuns?: number;
    /** Runs older than this are pruned regardless of count (1-3650 days). */
    maxAgeDays?: number;
    /** Never persist node outputs for these node ids. */
    noPersistNodeIds?: string[];
    /** Field-level redaction applied to every persisted payload. */
    redact?: RedactionRule[];
  };
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
  /** Flat by-value registry used by `execute-workflow` nodes. */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
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
