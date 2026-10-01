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

/**
 * Every node kind the canvas and this engine understand. Structural twin of
 * `WorkflowNodeKind` in `frontend/src/app/core/workflow.model.ts`.
 *
 * `WorkflowNode.kind` stays a plain `string` at the package boundary so the
 * studio's richer graphs remain structurally assignable; this union is the
 * vocabulary used by catalogs, capability validation and the executor switch.
 */
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
  | 'notify' // P1-10
  // ── Document delivery ─────────────────────────────────────────────────────
  | 'render-document'
  | 'state-list'
  // ── System One (TypeSafe Jev) ─────────────────────────────────────────────
  | 'decide';

/**
 * Kinds that execute in the graph walk AND may perform external I/O. Used by
 * capability validation, the redaction pipeline and fixtures.
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
  'decide',
  'render-document',
  'state-list',
] as const;

/** Data nodes that reach outside the run (fixtures + egress declaration). */
export const DATA_IO_KINDS: readonly WorkflowNodeKind[] = [
  'http-request',
  'sql-query',
  'notify',
  'decide',
] as const;

/**
 * A data node exposes message ports only. `tool-link` edges to a data node are
 * rejected — determinism depends on the graph walk owning these steps, never a
 * model's choice ("data nodes are not tools").
 *
 * Forward-compatible seam: exposing a CONFIGURED data node to an agent later
 * means adding a `tools`-role port and a ToolHost adapter that calls the SAME
 * executor function, so executors stay pure `(node, payload, ctx)` functions
 * that never read graph topology.
 */
export function isDataNode(node: WorkflowNode): boolean {
  return (DATA_NODE_KINDS as readonly string[]).includes(node.kind);
}

/** True when a `tool-link` edge is illegal for this endpoint. */
export function rejectsToolLink(node: WorkflowNode): boolean {
  return isDataNode(node);
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
  /**
   * P1-7: when > 1, the loop yields ARRAYS of up to `batchSize` items instead
   * of single items, so a target API's "max 100 per call" limit is one config
   * field instead of a subgraph. 0/1/absent = today's per-item behaviour.
   */
  batchSize?: number;
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
  /**
   * System One screening of visitor messages (input) and the final answer
   * (output). Output screening switches the portal to final-answer-only: no
   * live tokens reach the visitor before the answer is screened.
   */
  guardrails?: PortalGuardrails;
}

/**
 * Retry policy for an agent's model calls. Transient failures (429, 5xx,
 * network drops, timeouts) are retried BY DEFAULT (one retry, 1s backoff);
 * this object tunes or disables that behaviour per node.
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
   * Per-agent character cap for a single tool result fed back to the model.
   * Absent = engine default (8000). Raise it when an agent needs whole
   * paginated payloads (Slack/Jira list calls) whose cursor would otherwise
   * be sliced off. Capped at 200000 to bound context cost.
   */
  toolResultCapChars?: number;
  /**
   * Maximum model→tools→model rounds for this agent. Absent = run default
   * (RunOptions.maxToolRounds, itself defaulting to 8). Raise for agents
   * whose task needs many tool rounds (e.g. per-item worklog checks before
   * a final report step) so they don't get cut off before completion.
   */
  maxToolRounds?: number;
  /**
   * Skills attached to this agent, embedded by value (see {@link AgentSkill}).
   * Rendered into the system prompt in array order.
   */
  skills?: AgentSkill[];
  /** System One output verification (see {@link AgentVerifyConfig}). */
  verify?: AgentVerifyConfig;
  /** System One tool/skill preselection (see {@link AgentPreselectConfig}). */
  preselect?: AgentPreselectConfig;
  /**
   * When set, the reply is MERGED into the incoming payload under this key
   * (parsed as JSON when it parses, after stripping one code fence) instead of
   * replacing the payload. Absent = the reply replaces the payload.
   */
  resultKey?: string;
}

// ── Phase 1 data nodes: shared vocabulary ────────────────────────────────────

/** Anything that reads a `{{path}}`-interpolated template against the payload. */
export type PayloadTemplate = string;

/**
 * SQL driver families. Host support is declared in the capability matrix.
 * Re-exported by `engine/src/connections.ts` so connection and node data share
 * exactly one definition.
 */
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
  bodyMode?: 'none' | 'json' | 'text' | 'form' | 'multipart';
  /** Template rendered then (for `json`) parsed to validate before sending. */
  body?: PayloadTemplate;
  /** `bodyMode: 'multipart'` only: text fields and file parts read from run artifacts. */
  multipart?: MultipartBodyConfig;
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

/** A `multipart/form-data` body (RFC 7578). */
export interface MultipartBodyConfig {
  /** Text parts. `value` is a payload template. */
  fields?: { name: string; value: PayloadTemplate }[];
  /**
   * File parts. `artifact` is a dotted payload path to an artifact reference;
   * `fileName` (a template) overrides the artifact's own name.
   */
  files?: { name: string; artifact: string; fileName?: PayloadTemplate }[];
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
  // ── Email extensions (channel `email` only) ──
  /** Sender. Falls back to the connection's `defaultFrom`. */
  from?: PayloadTemplate;
  replyTo?: PayloadTemplate;
  /** Comma-separated copy recipients. */
  cc?: PayloadTemplate;
  /** How `body` is delivered. Absent = provider default (markdown). */
  bodyFormat?: 'markdown' | 'html' | 'text';
  /** Dotted payload paths, each resolving to an artifact reference or an array of them. */
  attachments?: string[];
  /** Over the attachment size cap: `fail` (default) or drop trailing attachments. */
  attachmentLimit?: 'fail' | 'truncate';
  /** Rendered key: claimed once under `idem:` and sent as `Idempotency-Key`. */
  idempotencyKey?: PayloadTemplate;
}

// ── Document delivery ────────────────────────────────────────────────────────

/** Page layout for `render-document`. Every field is optional and validated. */
export interface DocumentLayout {
  pageSize?: 'a4' | 'letter';
  /** Margin on every side, millimetres (5-50, default 18). */
  marginMm?: number;
  /** Body text size in points (7-16, default 10.5). */
  fontSize?: number;
  /** Heading and link colour, `#rrggbb` (default `#1f4e79`). */
  accentColor?: string;
}

export interface RenderDocumentNodeData {
  /** Markdown template. `{{path}}` alone reads a payload path. */
  markdown: PayloadTemplate;
  /** File name template; sanitised and given the format's extension. */
  fileName: PayloadTemplate;
  /** Document title metadata template. */
  title?: PayloadTemplate;
  format?: 'pdf';
  layout?: DocumentLayout;
  /** Payload key the artifact reference merges under (default `document`). */
  resultKey?: string;
  errorPortId?: string;
}

export interface StateListNodeData {
  /** Key prefix template, interpolated against the payload. */
  prefix: PayloadTemplate;
  /** Maximum entries (default 100, capped at `STATE_LIST_MAX_LIMIT`). */
  limit?: number;
  /** Payload key the list merges under (default `entries`). */
  resultKey?: string;
}

// ── System One (TypeSafe Jev) decisions ──────────────────────────────────────

/** Fields every decision-backed config shares. */
export interface DecisionTuning {
  /**
   * Dotted path into the JSON payload narrowing what the model evaluates
   * (e.g. `ticket.message`). Empty = the whole payload. Narrow state is the
   * biggest accuracy lever: Jev degrades on large irrelevant context.
   */
  statePath?: string;
  /** Pinned model id or alias. Absent = the run default, else `jev-latest`. */
  decisionModel?: string;
}

/** A question authored on a Decide node (or any decision config). */
export interface DecisionQuestionSpec {
  /** Key the answer is stored under. Letters, digits, `_`. */
  id: string;
  type: 'noul' | 'choice' | 'score';
  /** The question, markdown/plain text. */
  instructions: string;
  /** `choice`: one entry per option (`label` + optional description). */
  options?: { label: string; description?: string }[];
  /** `score`: ordered level descriptions, lowest first (2..10). */
  levels?: string[];
  /** `noul`: optional meaning of yes / no. */
  yes?: string;
  no?: string;
}

/** Router configuration. `keyword` is the historical substring match. */
export interface RouterNodeData extends DecisionTuning {
  /**
   * `keyword` (default): the first route whose name appears in the payload.
   * `decide`: System One picks the route with a calibrated Choice.
   * `expression`: `expression` is evaluated and the route whose name equals
   * the result (trimmed, case-insensitive) is taken.
   */
  mode?: 'keyword' | 'decide' | 'expression';
  /** Expression mode: evaluated against the payload; the result names a route. */
  expression?: string;
  /** Decide mode: the routing question. Markdown. */
  instructions?: string;
  /** Decide mode: port base id -> what belongs on that route. */
  routeCriteria?: Record<string, string>;
  /** Decide mode: below this confidence the unsure port is taken (default 0.5). */
  minConfidence?: number;
  /** Decide mode: port base id taken on low confidence. Absent = best guess. */
  unsurePortId?: string;
  retry?: NodeRetryPolicy;
  fixtures?: FixtureMode;
}

/** Approval Gate auto-resolve: confident answers never wait for a human. */
export interface ApprovalAutoResolve extends DecisionTuning {
  enabled: boolean;
  /** Yes/no question whose YES means "safe to approve". */
  question?: string;
  /** Optional meaning of yes / no. */
  yes?: string;
  no?: string;
  /** P(yes) at or above this approves automatically (default 0.9). */
  approveAt?: number;
  /** P(yes) at or below this rejects automatically (default 0.1). */
  rejectAt?: number;
}

export interface ApprovalGateNodeData {
  /** Message shown to the human approver. Markdown. */
  message?: string;
  autoResolve?: ApprovalAutoResolve;
  retry?: NodeRetryPolicy;
  fixtures?: FixtureMode;
}

/** A Decide node: many typed questions in ONE call, merged into the payload. */
export interface DecideNodeData extends DecisionTuning {
  questions: DecisionQuestionSpec[];
  /** Payload key the answers merge under (default `decisions`). */
  resultKey?: string;
  retry?: NodeRetryPolicy;
  fixtures?: FixtureMode;
  errorPortId?: string;
}

/** Agent output verification: calibrated "is this wrong?" checks. */
export interface AgentVerifyConfig extends DecisionTuning {
  enabled: boolean;
  /**
   * Built-in checks to ask. Each is a Noul framed so YES means "something is
   * wrong": `unsupported` (claims not backed by the task input), `off-task`,
   * `incomplete`, `format` (violates the requested format).
   */
  checks?: ('unsupported' | 'off-task' | 'incomplete' | 'format')[];
  /** Extra custom yes-means-wrong questions. */
  custom?: string[];
  /** Any single check at or above this fires (default 0.7). */
  fireAt?: number;
  /**
   * On a fired check: `fallback` reruns on the fallback model (else fails),
   * `error` fails the node (routing through On error when wired),
   * `warn` records the verdict and keeps the output.
   */
  onFail?: 'fallback' | 'error' | 'warn';
}

/** Per-turn tool/skill preselection: offer the model only what fits. */
export interface AgentPreselectConfig {
  enabled: boolean;
  /** Narrow attached tools (never to zero). Default true. */
  tools?: boolean;
  /** Narrow attached skills (may drop all). Default true. */
  skills?: boolean;
  /** Candidates kept after the ranking pass (default 3). */
  topK?: number;
  /** A candidate whose "does this fit" P(yes) falls under this is dropped (default 0.3). */
  minFit?: number;
  decisionModel?: string;
}

/** One side of portal guardrail screening. */
export interface PortalGuardrailSide {
  enabled: boolean;
  /** Hazards to screen for. Default: every hazard for that side. */
  hazards?: ('jailbreak' | 'harmful' | 'medical' | 'self-harm')[];
  /** P(hazard) at or above this goes to review (default 0.35). */
  reviewAt?: number;
  /** P(hazard) at or above this triggers the hazard's action (default 0.7). */
  actionAt?: number;
  /** Severity score (0..3) at or above this turns a review into a block (default 2). */
  severityBlockAt?: number;
  /** What a `review` verdict does on a public surface: let it through flagged, or block. */
  reviewAction?: 'pass' | 'block';
}

export interface PortalGuardrails {
  input?: PortalGuardrailSide;
  output?: PortalGuardrailSide;
  /** Shown to the visitor when a message is blocked. */
  refusalMessage?: string;
  /** Shown when the self-harm path fires. */
  supportMessage?: string;
  decisionModel?: string;
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
  /**
   * Named workflow values, read as `{{vars.name}}` in templates and prompts and
   * `vars.name` in expressions. Never secrets: those belong in Connections.
   */
  variables?: WorkflowVariable[];
}

export type WorkflowVariableType = 'text' | 'markdown' | 'number' | 'boolean' | 'list';

/** One named workflow value. A `list` holds strings. */
export interface WorkflowVariable {
  name: string;
  type: WorkflowVariableType;
  value: string | number | boolean | string[];
  description?: string;
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
