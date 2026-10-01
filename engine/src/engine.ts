/**
 * The workflow interpreter.
 *
 * Walks a {@link WorkflowGraph} from its trigger, executing nodes and
 * following handoff edges, emitting {@link RunEvent}s for every observable
 * moment. Debugger semantics (pause/resume/step/breakpoints/stop) come from
 * the {@link RunGate} checkpoint taken before every node execution.
 *
 * v1 semantics:
 *  - Triggers pass the run input onward.
 *  - Agents render their markdown prompt (`{{input}}` interpolation), stream
 *    a completion from their configured model, and hand the text onward.
 *    Attached tools are DESCRIBED to the agent; native tool invocation lands
 *    with the MCP milestone.
 *  - Routers match a route label inside the payload (case-insensitive); no
 *    match → first route. In `decide` mode System One (TypeSafe Jev) picks the
 *    route with a calibrated Choice instead (see `decisions.ts`).
 *  - Agents may verify their output and preselect tools/skills with System One
 *    (`verify`, `preselect`); Decide nodes ask typed questions in one call.
 *  - Parallel fans the payload out to every branch concurrently.
 *  - Aggregators wait for every CONNECTED input, then merge as markdown.
 *  - Approval gates suspend until the studio resolves them.
 *  - Cycles are permitted but bounded by an execution budget.
 */

import type {
  ConnectionStore,
  DataFetcher,
  DataRequest,
  DataResponse,
  FixtureStore,
  HostCapabilities,
  SqlHost,
  SqlRequest,
  SqlResult,
  TransportFailureKind,
  WorkflowStateStore,
  ArtifactStore,
  ArtifactRef,
  StoredArtifact,
} from './data-host.js';
import { resolveWorkflowVariables } from './variables.js';
import {
  ARTIFACT_MAX_BYTES,
  RUN_ARTIFACTS_MAX_BYTES,
  RUN_ARTIFACTS_MAX_COUNT,
  artifactId,
  collectArtifactRefs,
} from './artifacts.js';
// Loaded on first use with a dynamic `import()`: a host that never renders,
// attaches or uploads a file never parses the PDF writer, the markdown
// renderer, the email adapters or the multipart encoder.
import type { DeliveryHost } from './delivery-steps.js';
import type { EncodedMultipart } from './multipart.js';
import {
  DataTransportError,
  HttpStatusError,
  HTTP_BODY_PREVIEW_MAX_CHARS,
} from './data-host.js';
import type { ResolvedConnection } from './connections.js';
import {
  applyConnectionAuth,
  buildDataRequest,
  createPaginationLoop,
  DEFAULT_MAX_RESPONSE_BYTES,
  isPaginated,
  joinUrl,
  MAX_IDEMPOTENCY_KEY_CHARS,
  registerConnectionSecrets,
  selectResult,
} from './data-http.js';
import {
  claimIdempotent,
  compareWatermark,
  contentHash,
  idempotencyStateKey,
  isProvableNonDelivery,
  releaseIdempotent,
  reservedStateNamespaceOf,
  scopedStateKey,
  STATE_LIST_MAX_LIMIT,
  STATE_TTL_MAX_SEC,
  STATE_TTL_MIN_SEC,
} from './state.js';
import {
  createDecisionFixtureSession,
  createHttpFixtureSession,
  createSqlFixtureSession,
  decisionRequestFingerprint,
  httpRequestFingerprint,
  sqlRequestFingerprint,
  type FixtureSession,
} from './fixtures.js';
import {
  DECISION_ACTOR,
  DECISION_PROVIDER,
  buildDecisionQuestions,
  decisionCostUsd,
  mergeDecisionAnswers,
  payloadToState,
  readThreshold,
  resolveDecisionModel,
  uniqueOptionLabels,
  validateDecisionRequest,
  type ChoiceAnswer,
  type DecisionClient,
  type DecisionPurpose,
  type DecisionQuestion,
  type DecisionResult,
  type DecisionTuningLike,
  type NoulAnswer,
} from './decisions.js';
import {
  preselectFitQuestions,
  preselectFitting,
  preselectRankQuestions,
  preselectShortlist,
  verifyQuestions,
  verifyState,
  verifyVerdict,
  type PreselectCandidate,
  type VerifyVerdict,
} from './decision-batteries.js';
import {
  isWriteStatement,
  reconcileSqlParameters,
  resolveSqlLimits,
  validateSqlStatement,
  type DeclaredSqlParameter,
} from './sql-statement.js';
import {
  compileExpression,
  type CompiledExpression,
  type EvalContext,
  type Json,
} from './expr.js';
import type { RunEvent, RunEventSink, RunScope } from './events.js';
import type { RunSource, SyncSummary } from './run-record.js';
import { accumulateSync, createSyncSummary } from './run-record.js';
import { RunGate, RunStoppedError } from './gate.js';
import {
  failureCodeOf,
  isTransientModelError,
  type ChatMessage,
  type ModelClient,
  type ReasoningReplay,
  type ToolCall,
} from './model.js';
import { batchItems, runAggregate, runTransform } from './data-nodes.js';
import { extractItems, interpolatePayload, mergePayloads } from './payload.js';
import { decideRetry, normalisePolicy, type RetryReason } from './retry.js';
import { resolveAgentTools, type ResolvedTool, type ToolHost } from './tools.js';
import {
  isAgentNode,
  isDataNode,
  nodeForConnector,
  portBaseId,
  type AgentNodeData,
  type AgentSkill,
  type AgentVerifyConfig,
  type ApprovalGateNodeData,
  type AskUserNodeData,
  type AssertNodeData,
  type Assertion,
  type DecideNodeData,
  type FixtureMode,
  type RouterNodeData,
  type EmbeddedWorkflow,
  type ExecuteWorkflowNodeData,
  type ForEachNodeData,
  type HttpRequestNodeData,
  type ModelProviderId,
  type NodeRetryPolicy,
  type NotifyNodeData,
  type RenderDocumentNodeData,
  type SqlDriver,
  type SqlQueryNodeData,
  type StateGetNodeData,
  type StateListNodeData,
  type StateSetNodeData,
  type WaitEventNodeData,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from './types.js';

/** Default safety budget: total node executions per run (cycles are allowed, runaway loops are not). */
const MAX_NODE_EXECUTIONS = 100;
/** Default maximum model→tools→model rounds per agent execution. */
const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** Default character cap for a single tool result fed back to the model. */
const DEFAULT_TOOL_RESULT_CAP_CHARS = 8000;
/** Absolute ceiling for a per-agent tool-result cap override. */
const MAX_TOOL_RESULT_CAP_CHARS = 200_000;
/** Default retry policy: one automatic retry for transient model failures. */
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
/** Extra execution budget granted to the workflow error handler's subtree. */
const ERROR_HANDLER_BUDGET_BONUS = 25;
/** Extra success statuses an `http-request` node may declare (Requirement 8.11). */
const MAX_SUCCESS_CODES = 20;
/** Most assertions one `assert` node may declare (Requirement 7.1). */
const MAX_ASSERTIONS = 50;
/** Longest accepted assertion name (Requirement 7.10). */
const MAX_ASSERTION_NAME_CHARS = 100;
/** Effective per-attempt delivery timeout for a `notify` node (Requirement 13.2). */
const NOTIFY_TIMEOUT_MS = 30_000;
/** The only channels a `notify` node may declare (Requirements 13.1, 13.9). */
const NOTIFY_CHANNELS: ReadonlySet<string> = new Set<NotifyNodeData['channel']>([
  'email',
  'webhook',
  'chat-webhook',
]);
/** The only drivers a `sql-query` node may resolve to (Requirement 10.5). */
const SQL_DRIVERS: ReadonlySet<string> = new Set<SqlDriver>([
  'postgres',
  'mysql',
  'mssql',
  'sqlite',
]);
/** Variable scope of a frame whose host passed none. */
const EMPTY_VARIABLES: Readonly<Record<string, Json>> = Object.freeze({});
/** Largest JSON a `state-list` step merges into the payload, in characters. */
const STATE_LIST_MAX_OUTPUT_CHARS = 1_048_576;

/**
 * One `http-request` attempt's result: the node's outgoing payload, or the
 * `skipped` marker meaning another owner holds this write's idempotency claim
 * so no request was issued (Requirement 12.14).
 */
type HttpAttemptOutcome = { readonly skipped: true } | { readonly output: string; readonly skipped?: false };

/**
 * One accepted assertion of an `assert` node: its trimmed name, its compiled
 * expression and its resolved severity. Every field is settled before the first
 * assertion is evaluated, so a rejection can never happen mid-evaluation
 * (Requirement 7.10).
 */
interface PreparedAssertion {
  readonly name: string;
  readonly compiled: CompiledExpression;
  readonly severity: 'error' | 'warn';
  /** The declared message, when the author wrote one. */
  readonly message?: string;
}
/** Context window assumed when no lookup is available for a model. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Fraction of the context window that triggers compression. */
const COMPRESSION_THRESHOLD = 0.8;
/** Complete tool rounds kept verbatim when compressing (pairs of messages). */
const COMPRESSION_KEEP_TAIL_PAIRS = 2;
/** Character cap for the transcript handed to the summarizer. */
const COMPRESSION_TRANSCRIPT_MAX_CHARS = 24_000;
/** Default nested frame depth available to every host. */
export const DEFAULT_MAX_SUB_WORKFLOW_DEPTH = 2;
/** Absolute engine ceiling, including enterprise/custom host overrides. */
export const MAX_SUB_WORKFLOW_DEPTH = 25;

/** Thrown when a node exceeds its configured `timeoutSec`. */
export class NodeTimeoutError extends Error {
  constructor(nodeName: string, timeoutSec: number) {
    super(`"${nodeName}" timed out after ${timeoutSec}s.`);
    this.name = 'NodeTimeoutError';
  }
}

/** Thrown when a run exceeds the workflow-level timeout. */
export class WorkflowTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`Workflow timed out after ${formatDurationMs(limitMs)}.`);
    this.name = 'WorkflowTimeoutError';
  }
}

function formatDurationMs(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** Estimates the input tokens a message list + system prompt will consume (chars/4 heuristic). */
function estimateMessageTokens(system: string, messages: ChatMessage[]): number {
  let chars = system.length;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      chars += message.content.length;
    } else if (message.role === 'assistant-tool-calls') {
      chars += (message.text?.length ?? 0);
      for (const call of message.calls) chars += call.name.length + call.arguments.length;
    } else if (message.role === 'tool-results') {
      for (const result of message.results) chars += result.name.length + result.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Renders one message as plain text for the compression summarizer. */
function describeMessageForSummary(message: ChatMessage): string {
  switch (message.role) {
    case 'user':
      return `User:\n${message.content}`;
    case 'assistant':
      return `Assistant:\n${message.content}`;
    case 'assistant-tool-calls': {
      const calls = message.calls
        .map(call => `${call.name}(${clipText(call.arguments, 300)})`)
        .join(', ');
      return `Assistant${message.text ? `:\n${message.text}\n` : ' '}called tools: ${calls}`;
    }
    case 'tool-results':
      return message.results
        .map(result => `Tool ${result.name} returned:\n${clipText(result.content, 600)}`)
        .join('\n');
  }
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface RunOptions {
  runId: string;
  graph: WorkflowGraph;
  /** The task handed to the trigger. */
  input: string;
  /** What initiated the run (defaults to 'manual'). Stamped on `run-started`. */
  source?: RunSource;
  /** Node to start from; defaults to the first trigger (any kind). */
  startNodeId?: string;
  model: ModelClient;
  emit: RunEventSink;
  /** Ollama server override, forwarded to model requests. */
  ollamaBaseUrl?: string;
  /** LM Studio server override, forwarded to model requests. */
  lmstudioBaseUrl?: string;
  /**
   * Default AWS region for Amazon Bedrock agents that don't specify their own
   * region. Individual agent nodes can override this per model.
   */
  bedrockRegion?: string;
  /**
   * Application default model. Agents without an explicit provider/model
   * inherit this at execution time. When omitted, agents lacking a model
   * fail with a descriptive error.
   */
  defaultModel?: { provider: ModelProviderId; model: string; temperature?: number };
  /** Maximum model→tools→model rounds per agent execution (default 8). */
  maxToolRounds?: number;
  /**
   * Total node-execution budget per run (default 100). Batch workflows
   * (ForEach over many items) may need more headroom.
   */
  maxExecutions?: number;
  /**
   * Flat by-value registry for Execute Workflow targets. A host resolver is
   * consulted first, then this portable snapshot registry is used as the
   * fallback.
   */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
  /** Resolves a current workflow by id. Return undefined to use the registry fallback. */
  resolveWorkflow?: (workflowId: string) => EmbeddedWorkflow | undefined;
  /**
   * Deepest nested workflow frame allowed. Defaults to 2 and is always
   * clamped to the hard engine ceiling of 25. The top-level graph is depth 0.
   */
  maxSubWorkflowDepth?: number;
  /**
   * Workflow-level timeout in milliseconds. When the run's cumulative
   * RUNNING time (paused time doesn't count) exceeds this, the run stops
   * and fails with a timeout error. 0/absent = no limit. The studio wires
   * this from `WorkflowSpec.settings.timeoutMinutes`.
   */
  runTimeoutMs?: number;
  /**
   * Context-window lookup for automatic context compression. Returns the
   * model's maximum context length in tokens, or undefined when unknown
   * (a conservative default applies). Hosts wire this to the OpenRouter
   * model sync (see pricing.ts).
   */
  contextWindow?: (provider: string, model: string) => number | undefined;
  /**
   * Host-provided tool discovery + execution (HTTP, web search, MCP).
   * When omitted, agents run without callable tools (capabilities are still
   * described in their prompts).
   */
  tools?: ToolHost;
  /**
   * Asks a human to approve. Resolves `true` (approved) or `false`
   * (rejected). The studio wires this to the Runs panel; the cloud runtime
   * wires it to a webhook/WebSocket reply. `requestId` uniquely identifies
   * this deterministic node occurrence, including its nested frame. Existing
   * hosts may ignore the added argument while migrating.
   */
  requestApproval(
    nodeId: string,
    message: string,
    payload: string,
    requestId: string,
  ): Promise<boolean>;
  /**
   * Asks a human a free-text question and resolves with their response.
   * The run suspends at this node until the host resolves the promise.
   * `requestId` uniquely identifies this deterministic node occurrence,
   * including its nested frame. The response is merged into the payload
   * under the node's `responseKey` (default `userResponse`) for the
   * downstream agent.
   */
  requestInput(
    nodeId: string,
    question: string,
    payload: string,
    requestId: string,
  ): Promise<string>;
  /**
   * Suspends until an external event with the given correlation key arrives
   * (webhook callback, e-sign completion, manual injection from the Runs
   * panel). Resolves with the event's payload; rejects to fail the node
   * (e.g. on timeout). Hosts that cannot deliver external events may omit
   * this — reaching a Wait for Event node then fails the run with a
   * descriptive error. `timeoutMs` (when set) asks the host to reject the
   * wait after that long; hosts that cannot enforce it may ignore it.
   */
  waitForEvent?(
    nodeId: string,
    correlationKey: string,
    message: string,
    payload: string,
    timeoutMs?: number,
  ): Promise<string>;
  /**
   * Durable replay journal (see {@link RunJournal}). When present, node
   * results are recorded as they complete and replayed on restart, letting
   * hosts resume an interrupted run without repeating side effects.
   */
  journal?: RunJournal;

  // ── Data-path host capabilities (design §2.5) ───────────────────────────
  // All optional: a host omits what it cannot do, and a node that needs a
  // missing capability fails with a message naming the host and capability.

  /** P1-1: resolves a connection reference to its secret values. */
  connections?: ConnectionStore;
  /** P1-2/P1-7/P1-10: outbound HTTP for DATA nodes (distinct from `tools`). */
  dataFetch?: DataFetcher;
  /** P1-6: parameterised SQL execution, one implementation per driver family. */
  sql?: SqlHost;
  /** P1-8: durable workflow-scoped key/value store. */
  state?: WorkflowStateStore;
  /** P1-13: fixture record/replay for `http-request` and `sql-query`. */
  fixtures?: FixtureStore;
  /** Workflow id used to scope state and fixtures. Defaults to `''`. */
  workflowId?: string;
  /** P1-12: redaction applied by the host before persistence. */
  redact?: (value: string) => string;
  /** Declared host capability set, used for run-time guardrails. */
  capabilities?: HostCapabilities;
  /**
   * Run-scoped binary store (design G2). Payloads carry only an
   * `ArtifactRef`; the bytes live here. Required by `render-document`, email
   * attachments and multipart uploads.
   */
  artifacts?: ArtifactStore;
  /**
   * The top-level workflow's resolved variables (`resolveWorkflowVariables`),
   * read as `vars` in templates and expressions. Child frames resolve their own.
   */
  variables?: Readonly<Record<string, Json>>;

  // ── System One (TypeSafe Jev) ─────────────────────────────────────────────────

  /**
   * Typed decision model. Optional: a Decide-mode router falls back to keyword
   * routing without it; every other System One step fails naming the host.
   */
  decisions?: DecisionClient;
  /** Default decision model for steps that pin none (default `jev-latest`). */
  decisionModel?: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly gate: RunGate;
  /** Resolves when the run finishes (completed, failed, or stopped). */
  readonly done: Promise<void>;
  pause(): void;
  resume(): void;
  step(): void;
  stop(): void;
}

/** A journaled node-execution result (see {@link RunJournal}). */
export interface JournalEntry {
  output: string;
  /** Out ports the node routed through, when it restricted them. */
  viaPortIds?: string[];
}

/**
 * Durable replay journal — the engine's checkpoint/resume contract.
 *
 * When provided, every completed node execution is recorded under a
 * deterministic key (`nodeId|payloadHash|occurrence`). Restarting the SAME
 * run (same graph + input) with the recorded journal REPLAYS journaled
 * executions instantly — no model calls, no tool side effects, no duplicate
 * approval prompts — until execution reaches the first un-journaled node,
 * where real execution resumes. This is how deployed runs survive Durable
 * Object eviction while suspended on approvals or external events. Completed
 * Execute Workflow wrappers re-enter their child frame so child journals can
 * reconstruct scoped trace events without repeating completed side effects.
 */
export interface RunJournal {
  /** Returns the recorded result for a key, or undefined. */
  lookup(key: string): JournalEntry | undefined;
  /** Durably records a result. Awaited before execution continues. */
  record(key: string, entry: JournalEntry): void | Promise<void>;
}

/** FNV-1a 32-bit hash — stable payload fingerprint for journal keys. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const TRIGGER_KINDS = new Set([
  'manual-trigger',
  'schedule-trigger',
  'webhook-trigger',
  'portal-trigger',
]);
const TOOL_KINDS = new Set(['http-tool', 'web-search-tool', 'mcp-tool']);

interface SharedExecutionState {
  executions: number;
  maxExecutions: number;
  /**
   * Artifact totals for the run, seeded once from `ArtifactStore.list` so the
   * per-run caps hold across a host restart. Shared with nested frames.
   */
  artifacts?: { count: number; bytes: number; sizes: Map<string, number> };
}

interface WorkflowFrame {
  scope: RunScope[];
  journalPrefix: string;
}

/**
 * Run-wide sync audit state (P1-11). Shared by the top-level run and every
 * nested frame, so a data node inside a sub-workflow lands in the same
 * summary as one on the top-level canvas.
 */
interface SyncRunState {
  summary: SyncSummary;
  /** True once any data node executed (including a journal replay of one). */
  dataNodeExecuted: boolean;
  /** Guards the exactly-once `sync-summary` emission. */
  emitted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared retry wrapper for non-model steps (design §6, P1-3)
// ─────────────────────────────────────────────────────────────────────────────

/** Character cap for the redacted description on a `node-retrying` event. */
export const RETRY_ERROR_DESCRIPTION_MAX_CHARS = 512;

/** What one scheduled retry tells the trace. */
export interface NodeRetryNotice {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Normalised attempt budget for the node. */
  maxAttempts: number;
  delayMs: number;
  reason: RetryReason;
  /** Redacted, clipped error description. */
  error: string;
}

/**
 * The (injectable) surface the retry loop needs. Everything except `onRetry`
 * and `sleep` has a sane default, so a test can drive the loop with two lambdas
 * while the engine wires the real gate, clock and redactor.
 */
export interface NodeRetryContext {
  /** Called exactly once per SCHEDULED retry, before the delay begins. */
  onRetry(notice: NodeRetryNotice): void;
  /** Pause/stop-aware sleep — the engine passes `RunGate.sleep`. */
  sleep(ms: number): Promise<void>;
  /** Resolves once the run is running again; rejects when it was stopped. */
  awaitResume?(): Promise<void>;
  /** True when the run has been stopped. */
  stopped?(): boolean;
  now?(): number;
  random?(): number;
  /** Renders an error for the event, already redacted. */
  describe?(error: unknown): string;
}

/**
 * Name-based `RunStoppedError` test: an error can cross a bundle or realm
 * boundary and lose its prototype identity while keeping its contract.
 */
function isRunStopped(error: unknown): boolean {
  if (error instanceof RunStoppedError) return true;
  const candidate = error as { name?: unknown } | null;
  return !!candidate && typeof candidate === 'object' && candidate.name === 'RunStoppedError';
}

/**
 * Renders a failed attempt for the `node-retrying` event: a short, structured
 * description, redacted FIRST and clipped second (clipping first could hand a
 * secret's tail to the trace).
 *
 * A response body never appears here — only the status — because the body has
 * not necessarily been through the redaction pipeline at this point.
 */
export function describeRetryError(error: unknown, redact?: (value: string) => string): string {
  const candidate = error as
    | { name?: unknown; status?: unknown; kind?: unknown; message?: unknown }
    | null;
  let raw: string;
  if (candidate && typeof candidate === 'object' && candidate.name === 'HttpStatusError') {
    raw = `HTTP ${String(candidate.status)}`;
  } else if (
    candidate &&
    typeof candidate === 'object' &&
    candidate.name === 'DataTransportError' &&
    typeof candidate.kind === 'string'
  ) {
    raw = `${candidate.kind}: ${error instanceof Error ? error.message : String(error)}`;
  } else {
    raw = error instanceof Error ? error.message : String(error);
  }
  const scrubbed = redact ? redact(raw) : raw;
  return scrubbed.length > RETRY_ERROR_DESCRIPTION_MAX_CHARS
    ? `${scrubbed.slice(0, RETRY_ERROR_DESCRIPTION_MAX_CHARS)}…`
    : scrubbed;
}

/** Folds the decision reason into the event's single `error` field. */
export function formatRetryEventError(description: string, reason: RetryReason): string {
  return `${description} (retry reason: ${reason})`;
}

/**
 * The retry loop itself, lifted out of the engine so it is testable without a
 * graph: invoke the body, ask `decideRetry`, announce the retry, sleep through
 * the caller's pause/stop-aware sleep, try again.
 *
 * Bounds come entirely from `decideRetry`, which refuses once
 * `attempt >= maxAttempts`, so the loop needs no second counter — and the final
 * failure emits no `node-retrying` event (requirement 11.13).
 *
 * Stop always wins: a `RunStoppedError` from the body or from the pending delay
 * propagates immediately, with no further event and no further attempt.
 */
export async function runWithNodeRetry<T>(
  policy: NodeRetryPolicy | undefined,
  body: (attempt: number) => Promise<T>,
  ctx: NodeRetryContext,
): Promise<T> {
  const resolved = normalisePolicy(policy);
  const now = ctx.now ?? ((): number => Date.now());
  const random = ctx.random ?? ((): number => Math.random());
  const describe = ctx.describe ?? ((error: unknown): string => describeRetryError(error));

  for (let attempt = 1; ; attempt++) {
    // Loop invariant: attempt <= resolved.maxAttempts, and every earlier
    // attempt failed with a decision of retry = true.
    try {
      return await body(attempt);
    } catch (error) {
      if (isRunStopped(error)) throw error;

      const decision = decideRetry({ error, attempt, policy: resolved, nowMs: now(), random });
      if (!decision.retry) throw error;

      ctx.onRetry({
        attempt,
        maxAttempts: resolved.maxAttempts,
        delayMs: decision.delayMs,
        reason: decision.reason,
        error: describe(error),
      });

      // Stop unwinds mid-sleep (RunGate.sleep throws); a run paused DURING the
      // delay must also finish pausing before the next attempt starts.
      await ctx.sleep(decision.delayMs);
      if (ctx.stopped?.() === true) throw new RunStoppedError();
      if (ctx.awaitResume) await ctx.awaitResume();
    }
  }
}

/** Starts a run. Events flow through `options.emit`; control via the handle. */
export function startRun(options: RunOptions): RunHandle {
  const gate = new RunGate();
  const run = new WorkflowRun(options, gate);
  return {
    runId: options.runId,
    gate,
    done: run.execute(),
    pause: () => gate.pause(),
    resume: () => gate.resume(),
    step: () => gate.step(),
    stop: () => gate.stop(),
  };
}

class WorkflowRun {
  /** Collected inputs per aggregator node id (port base id → payload). */
  private readonly aggregations = new Map<string, Map<string, string>>();
  /** Terminal outputs (payloads that reached nodes with no outgoing handoff). */
  private readonly terminalOutputs: string[] = [];
  /** Occurrence counters per (node, payload-hash) for journal keys. */
  private readonly journalCounts = new Map<string, number>();
  /** Shared across the top-level run and every nested frame. */
  private readonly executionState: SharedExecutionState;
  /** Root-to-current nested frame path. Empty for the top-level workflow. */
  private readonly scope: RunScope[];
  /** Stable prefix that isolates nested journal keys. */
  private readonly journalPrefix: string;
  /** Sync audit accumulation, shared with every nested frame. */
  private readonly syncState: SyncRunState;
  /** True when the workflow-level timeout stopped the run. */
  private timedOut = false;
  /** Workflow-timeout bookkeeping (paused time doesn't count). */
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private runningSince = 0;
  private runningMsConsumed = 0;

  constructor(
    private readonly options: RunOptions,
    /** Mutable: the error handler swaps in a fresh gate after a stop/timeout. */
    private gate: RunGate,
    frame?: WorkflowFrame,
    executionState?: SharedExecutionState,
    syncState?: SyncRunState,
  ) {
    this.scope = frame?.scope ?? [];
    this.journalPrefix = frame?.journalPrefix ?? '';
    this.syncState = syncState ?? {
      summary: createSyncSummary(),
      dataNodeExecuted: false,
      emitted: false,
    };
    this.executionState = executionState ?? {
      executions: 0,
      maxExecutions: Math.max(1, options.maxExecutions ?? MAX_NODE_EXECUTIONS),
    };
    // Only the top-level frame owns the pause-aware workflow timer and run
    // lifecycle. Child frames share its gate and therefore its deadline.
    if (frame) return;
    gate.onPauseChange = (paused, nodeId) => {
      // A paused run's clock freezes: bank the running time on pause and
      // re-arm the deadline timer with the remaining budget on resume.
      if (paused) {
        this.runningMsConsumed += Date.now() - this.runningSince;
        this.disarmWorkflowTimeout();
      } else {
        this.runningSince = Date.now();
        this.armWorkflowTimeout();
      }
      this.emit(
        paused
          ? { type: 'run-paused', runId: options.runId, nodeId, at: Date.now() }
          : { type: 'run-resumed', runId: options.runId, at: Date.now() },
      );
    };
  }

  /** Remaining running-time budget in ms, or null when no timeout is set. */
  private workflowTimeoutRemaining(): number | null {
    const limit = this.options.runTimeoutMs;
    if (!limit || limit <= 0) return null;
    const consumed =
      this.runningMsConsumed + (this.gate.paused ? 0 : Date.now() - this.runningSince);
    return limit - consumed;
  }

  private armWorkflowTimeout(): void {
    const remaining = this.workflowTimeoutRemaining();
    if (remaining === null) return;
    this.disarmWorkflowTimeout();
    this.timeoutTimer = setTimeout(() => {
      this.timedOut = true;
      this.gate.stop();
    }, Math.max(0, remaining));
    // Never keep a Node.js event loop alive just for the deadline.
    (this.timeoutTimer as { unref?: () => void }).unref?.();
  }

  private disarmWorkflowTimeout(): void {
    if (this.timeoutTimer !== undefined) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  async execute(): Promise<void> {
    const { runId, input, source } = this.options;
    this.emit({ type: 'run-started', runId, input, source: source ?? 'manual', at: Date.now() });

    const start = this.startNode();
    if (!start) {
      this.emitSyncSummary();
      this.emit({
        type: 'run-failed',
        runId,
        error: 'No trigger node found. Add a Manual trigger to start the workflow.',
        at: Date.now(),
      });
      return;
    }

    this.runningSince = Date.now();
    this.armWorkflowTimeout();

    try {
      await this.executeNode(start, input);
      this.emitSyncSummary();
      this.emit({
        type: 'run-completed',
        runId,
        output: this.terminalOutputs.join('\n\n---\n\n'),
        at: Date.now(),
      });
    } catch (error) {
      if (error instanceof RunStoppedError && !this.timedOut) {
        this.emit({ type: 'run-stopped', runId, at: Date.now() });
        return;
      }
      const message = this.timedOut
        ? new WorkflowTimeoutError(this.options.runTimeoutMs ?? 0).message
        : error instanceof Error
          ? error.message
          : String(error);
      // A timeout is OUR verdict, not the responder's, so it never inherits a
      // code from whatever the run happened to be doing when the clock expired.
      const code = this.timedOut ? undefined : failureCodeOf(error);
      // A workflow-level Error Handler node (when present) gets one shot at
      // the failure — notifications, cleanup, escalation — before the run
      // settles as failed. Its own failures never mask the original error.
      await this.runErrorHandler(message);
      // After the error handler, so a data node inside it still counts, and
      // immediately before the terminal event with nothing in between.
      this.emitSyncSummary();
      this.emit({ type: 'run-failed', runId, error: message, code, at: Date.now() });
    } finally {
      this.disarmWorkflowTimeout();
    }
  }

  /** Executes one child frame without creating a second run lifecycle. */
  private async executeFrame(input: string): Promise<string> {
    const start = this.startNode();
    if (!start) {
      throw new Error('No trigger node found in the referenced sub-workflow.');
    }
    await this.executeNode(start, input);
    return this.terminalOutputs.join('\n\n---\n\n');
  }

  /**
   * Executes the workflow's Error Handler subtree (if any) with a JSON error
   * payload. Swallows every failure — the handler is best-effort and the run
   * is already failing. Skipped when the run was stopped/timed out (the user
   * asked it to end) … except timeouts DO run the handler, since a timeout is
   * a failure the workflow may want to escalate.
   */
  private async runErrorHandler(errorMessage: string): Promise<void> {
    const handler = this.options.graph.nodes.find(node => node.kind === 'error-handler');
    if (!handler) return;
    const payload = JSON.stringify(
      { error: errorMessage, at: new Date().toISOString() },
      null,
      2,
    );
    // Grant headroom in case the run died on the execution budget itself.
    this.executionState.maxExecutions =
      this.executionState.executions + ERROR_HANDLER_BUDGET_BONUS;
    const previousGate = this.gate;
    try {
      // The gate may be stopped (workflow timeout) — handler execution still
      // needs checkpoints to pass, so swap in a fresh permissive gate.
      if (previousGate.stopped) this.gate = new RunGate();
      await this.executeNode(handler, payload);
    } catch {
      // Best-effort: a failing handler never masks the original run failure.
    } finally {
      this.gate = previousGate;
    }
  }

  private startNode(): WorkflowNode | undefined {
    const { graph, startNodeId } = this.options;
    if (startNodeId) return graph.nodes.find(node => node.id === startNodeId);
    return (
      graph.nodes.find(node => node.kind === 'manual-trigger') ??
      graph.nodes.find(node => TRIGGER_KINDS.has(node.kind))
    );
  }

  /** Deterministic identity and journal key for this node occurrence. */
  private nextExecutionKey(node: WorkflowNode, payload: string): string {
    const base = `${node.id}|${fnv1a(payload)}`;
    const occurrence = this.journalCounts.get(base) ?? 0;
    this.journalCounts.set(base, occurrence + 1);
    return `${this.journalPrefix}${base}|${occurrence}`;
  }

  /**
   * Executes one node and recursively follows its outgoing handoffs.
   * `sink` collects terminal payloads for the innermost enclosing ForEach
   * (absent at the run's top level, where terminals feed the final output).
   */
  private async executeNode(node: WorkflowNode, payload: string, sink?: string[]): Promise<void> {
    await this.gate.checkpoint(node.id);

    this.executionState.executions += 1;
    if (this.executionState.executions > this.executionState.maxExecutions) {
      throw new Error(
        `Run exceeded the execution budget (${this.executionState.maxExecutions} node executions). ` +
          'Check the workflow for an unbounded loop, or raise the budget for batch runs.',
      );
    }

    const { runId, journal } = this.options;
    // A run that touched any data node gets a sync audit record — including a
    // resumed run whose data nodes replay from the journal.
    if (isDataNode(node)) this.syncState.dataNodeExecuted = true;
    this.emit({ type: 'node-started', runId, nodeId: node.id, nodeName: node.name, at: Date.now() });

    // Replay normally short-circuits the node body entirely: no model/tool
    // calls, approval prompts, or waits. Successful Execute Workflow wrappers
    // are the exception because their child journals must replay to rebuild
    // nested lifecycle and scoped trace events.
    const executionKey = this.nextExecutionKey(node, payload);
    const journalKey = journal ? executionKey : null;
    if (journal && journalKey) {
      const cached = journal.lookup(journalKey);
      const errorPortId = node.kind === 'execute-workflow' ? this.errorRoutePortId(node) : null;
      const cachedErrorRoute =
        !!errorPortId && cached?.viaPortIds?.includes(errorPortId) === true;
      // A successful Execute Workflow wrapper cannot replay as an opaque
      // cached node. Re-enter its child frame using this wrapper key as the
      // namespace so child journals rebuild scoped trace events while every
      // completed child side effect remains skipped. Routed child failures
      // stay opaque because their failed interior node was not journaled.
      if (cached && (node.kind !== 'execute-workflow' || cachedErrorRoute)) {
        this.emit({
          type: 'node-completed',
          runId,
          nodeId: node.id,
          nodeName: node.name,
          output: cached.output,
          at: Date.now(),
        });
        await this.followHandoffs(
          node,
          cached.output,
          cached.viaPortIds ? new Set(cached.viaPortIds) : undefined,
          sink,
        );
        return;
      }
    }

    try {
      let result: { output: string; viaPortIds?: Set<string> } | null;
      try {
        result = await this.runNodeBody(node, payload, sink, executionKey);
      } catch (error) {
        // Error branch: an agent with a connected "On error" out-port routes
        // its OWN failure onward instead of failing the run. Scoped to the
        // node body only — a failure further downstream must never be
        // captured by an ancestor's error branch.
        if (error instanceof RunStoppedError) throw error;
        const errorPortId = this.errorRoutePortId(node);
        if (!errorPortId) throw error;

        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: 'node-failed',
          runId,
          nodeId: node.id,
          nodeName: node.name,
          error: message,
          code: failureCodeOf(error),
          at: Date.now(),
        });
        this.emit({
          type: 'node-error-routed',
          runId,
          nodeId: node.id,
          nodeName: node.name,
          error: message,
          at: Date.now(),
        });
        // JSON payload so downstream agents can interpolate `{{error}}` /
        // `{{node}}` / `{{input}}` in their prompts.
        const errorPayload = JSON.stringify(
          { error: message, node: node.name, input: payload },
          null,
          2,
        );
        if (journal && journalKey) {
          await journal.record(journalKey, {
            output: errorPayload,
            viaPortIds: [errorPortId],
          });
        }
        await this.followHandoffs(node, errorPayload, new Set([errorPortId]), sink);
        return;
      }

      // Aggregators return null until every input has arrived.
      if (result === null) return;

      // Record durably BEFORE following handoffs, so a crash downstream
      // never loses this node's completed work.
      if (journal && journalKey) {
        await journal.record(journalKey, {
          output: result.output,
          viaPortIds: result.viaPortIds ? [...result.viaPortIds] : undefined,
        });
      }

      this.emit({
        type: 'node-completed',
        runId,
        nodeId: node.id,
        nodeName: node.name,
        output: result.output,
        at: Date.now(),
      });

      await this.followHandoffs(node, result.output, result.viaPortIds, sink);
    } catch (error) {
      if (error instanceof RunStoppedError) throw error;
      this.emit({
        type: 'node-failed',
        runId,
        nodeId: node.id,
        nodeName: node.name,
        error: error instanceof Error ? error.message : String(error),
        code: failureCodeOf(error),
        at: Date.now(),
      });
      throw error;
    }
  }

  /**
   * Resolves the agent's "On error" out-port id, but only when a handoff is
   * actually connected to it — an unwired error port keeps fail-fast
   * semantics so mistakes stay loud.
   */
  private errorRoutePortId(node: WorkflowNode): string | null {
    // Data nodes join agents and Execute Workflow here: a wired "On error"
    // port routes the failure onward, an unwired one keeps fail-fast semantics
    // (Requirement 1.6 and 1.8).
    if (!isAgentNode(node) && node.kind !== 'execute-workflow' && !isDataNode(node)) return null;
    const errorPortId = (node.data as { errorPortId?: string } | undefined)?.errorPortId;
    if (!errorPortId) return null;
    if (!node.ports.some(port => port.id === errorPortId && port.role === 'message-out')) {
      return null;
    }
    const wired = this.options.graph.connections.some(
      conn => conn.kind === 'handoff' && portBaseId(conn.outputId) === errorPortId,
    );
    return wired ? errorPortId : null;
  }

  /**
   * Runs a node's behaviour. Returns the outgoing payload and (optionally)
   * the subset of out ports to follow; null when the node is still waiting
   * (aggregator collecting inputs).
   */
  private async runNodeBody(
    node: WorkflowNode,
    payload: string,
    sink?: string[],
    executionKey?: string,
  ): Promise<{ output: string; viaPortIds?: Set<string> } | null> {
    if (TRIGGER_KINDS.has(node.kind)) {
      return { output: payload };
    }

    if (isAgentNode(node)) {
      const reply = await this.runAgent(
        node,
        payload,
        executionKey ?? this.nextExecutionKey(node, payload),
      );
      // `resultKey` keeps the incoming payload and adds the reply to it, so a
      // step after the agent still sees the record the agent worked on.
      const resultKey = ((node.data as AgentNodeData).resultKey ?? '').trim();
      const output =
        resultKey.length > 0
          ? mergePayloads(payload, JSON.stringify({ [resultKey]: parseReplyJson(reply) }))
          : reply;
      // Success never flows through the "On error" branch: restrict routing
      // to the regular out-ports when an error port is declared.
      const errorPortId = (node.data as AgentNodeData).errorPortId;
      if (errorPortId && node.ports.some(port => port.id === errorPortId)) {
        const regular = node.ports
          .filter(port => port.role === 'message-out' && port.id !== errorPortId)
          .map(port => port.id);
        return { output, viaPortIds: new Set(regular) };
      }
      return { output };
    }

    switch (node.kind) {
      case 'router':
        return this.runRouter(
          node,
          payload,
          executionKey ?? this.nextExecutionKey(node, payload),
        );
      case 'decide': {
        const key = executionKey ?? this.nextExecutionKey(node, payload);
        return this.routeAwayFromErrorPort(node, await this.runDecide(node, payload, key));
      }
      case 'parallel':
        return { output: payload }; // fan-out happens in followHandoffs
      case 'aggregator':
        // Aggregation is keyed by which in-port received the payload — handled
        // by the caller (deliverTo) before executeNode; this path only runs
        // when all inputs have arrived (see followHandoffs).
        return { output: payload };
      case 'approval-gate':
        return this.runApprovalGate(
          node,
          payload,
          executionKey ?? this.nextExecutionKey(node, payload),
        );
      case 'for-each':
        return this.runForEach(node, payload);
      case 'wait-event':
        return this.runWaitEvent(node, payload);
      case 'ask-user':
        return this.runAskUser(
          node,
          payload,
          executionKey ?? this.nextExecutionKey(node, payload),
        );
      case 'http-request': {
        const key = executionKey ?? this.nextExecutionKey(node, payload);
        const claim: { key?: string } = {};
        let outcome: HttpAttemptOutcome;
        try {
          outcome = await this.withNodeRetry(node, attempt =>
            this.runHttpRequest(node, payload, attempt, key, claim),
          );
        } catch (error) {
          await this.releaseClaimOnNonDelivery(claim.key, error);
          throw error;
        }
        // `executeNode` short-circuits a journal-replayed node before it ever
        // reaches here, so a replayed run never re-claims a completed write
        // (design §8.3).
        if (outcome.skipped === true) return this.skipLostClaim(payload);
        return this.routeAwayFromErrorPort(node, outcome.output);
      }
      case 'sql-query': {
        const key = executionKey ?? this.nextExecutionKey(node, payload);
        const output = await this.withNodeRetry(node, () => this.runSqlQuery(node, payload, key));
        return this.routeAwayFromErrorPort(node, output);
      }
      case 'transform':
        // Pure and never retried: the same node data, payload and `nowMs`
        // always reach the same output, so a second attempt could only repeat
        // it (design §5.2, Requirement 5.14). `runTransform` never reads or
        // writes graph topology, only `ctx.$`/`ctx.$text`.
        return this.routeAwayFromErrorPort(node, runTransform(node, payload, this.exprContext(payload)));
      case 'aggregate':
        // Same purity argument as `transform` (design §5.3).
        return this.routeAwayFromErrorPort(node, runAggregate(node, payload, this.exprContext(payload)));
      case 'assert':
        // A guard is pure and never retried: the same payload always reaches the
        // same verdict, so a second attempt could only repeat it.
        return this.runAssert(node, payload);
      case 'state-get':
        // State reads and writes go straight to the host store: the store's own
        // `compareAndSet` is the atomicity boundary, so there is nothing here a
        // retry loop could make safer (design §6 wraps only the network kinds).
        return { output: await this.runStateGet(node, payload) };
      case 'state-set':
        return { output: await this.runStateSet(node, payload) };
      case 'notify': {
        // Delivery is a network call, so it shares the retry loop of §6; the
        // payload leaves unchanged either way (Requirement 13.1). A rendered
        // idempotency key is claimed once, before the first attempt, and every
        // attempt reuses it.
        const claimKey = this.notifyIdempotencyKey(node, payload);
        if (claimKey !== undefined && !(await this.claimWrite(node, claimKey))) {
          return this.skipLostClaim(payload);
        }
        let output: string;
        try {
          output = await this.withNodeRetry(node, () => this.runNotify(node, payload, claimKey));
        } catch (error) {
          await this.releaseClaimOnNonDelivery(claimKey, error);
          throw error;
        }
        return this.routeAwayFromErrorPort(node, output);
      }
      case 'render-document': {
        const key = executionKey ?? this.nextExecutionKey(node, payload);
        return this.routeAwayFromErrorPort(node, await this.runRenderDocument(node, payload, key));
      }
      case 'state-list':
        return { output: await this.runStateList(node, payload) };
      case 'execute-workflow': {
        const output = await this.runSubWorkflow(
          node,
          payload,
          executionKey ?? this.nextExecutionKey(node, payload),
        );
        const errorPortId = (node.data as ExecuteWorkflowNodeData).errorPortId;
        if (errorPortId && node.ports.some(port => port.id === errorPortId)) {
          const regular = node.ports
            .filter(port => port.role === 'message-out' && port.id !== errorPortId)
            .map(port => port.id);
          return { output, viaPortIds: new Set(regular) };
        }
        return { output };
      }
      default:
        if (TOOL_KINDS.has(node.kind)) {
          // Tool nodes are capabilities, not flow steps. Reaching one via a
          // handoff is a wiring mistake; pass the payload through unchanged.
          return { output: payload };
        }
        return { output: payload };
    }
  }

  /**
   * Wraps a non-model node body (`http-request`, `sql-query`, `notify`) in the
   * shared, rate-limit-aware retry loop of design §6.
   *
   * The node's own `NodeRetryPolicy` is normalised once; `decideRetry` owns
   * every decision; each scheduled retry emits exactly one `node-retrying`
   * event whose description has been through the host's redactor; and the delay
   * runs through `RunGate.sleep`, so Stop unwinds it immediately and Pause
   * holds the next attempt back.
   *
   * `this.gate` is read per call on purpose: the workflow error handler swaps in
   * a fresh gate after a stop or timeout.
   */
  private async withNodeRetry<T>(
    node: WorkflowNode,
    body: (attempt: number) => Promise<T>,
  ): Promise<T> {
    const policy = (node.data as { retry?: NodeRetryPolicy } | undefined)?.retry;
    return runWithNodeRetry(policy, body, {
      onRetry: notice => {
        this.emit({
          type: 'node-retrying',
          runId: this.options.runId,
          nodeId: node.id,
          nodeName: node.name,
          attempt: notice.attempt,
          maxAttempts: notice.maxAttempts,
          delayMs: notice.delayMs,
          // `node-retrying` is reused verbatim for data nodes (design §7), so
          // the reason rides along in the single `error` field.
          error: formatRetryEventError(notice.error, notice.reason),
          at: Date.now(),
        });
      },
      sleep: ms => this.gate.sleep(ms),
      stopped: () => this.gate.stopped,
      // Already paused, so `checkpoint` blocks until Resume/Step without
      // re-triggering this node's breakpoint (that fires only while running).
      awaitResume: () =>
        this.gate.paused ? this.gate.checkpoint(node.id) : Promise.resolve(),
      describe: error => describeRetryError(error, this.options.redact),
    });
  }

  // ── Data-node shared helpers (design §5) ───────────────────────────────────

  /**
   * Fails a data node for an absent `RunOptions` capability BEFORE it performs
   * any outbound HTTP, SQL, state or fixture call, naming the node, the missing
   * member and the host label when one was declared (Requirements 8.1, 18.2).
   */
  private missingCapability(node: WorkflowNode, member: string, what: string): Error {
    const host = this.options.capabilities?.label;
    return new Error(
      `Step "${node.name}" needs the "${member}" capability to ${what}, which ` +
        `${host ? `the ${host} host` : 'this host'} does not provide.`,
    );
  }

  /**
   * Resolves a node's optional connection reference, seeding the host's
   * Redactor with every resolved secret before the caller builds a request
   * (Requirement 2.13). `connections` is required only when the node names one
   * (Requirement 18.8).
   */
  private async resolveNodeConnection(
    node: WorkflowNode,
    connectionId: string | undefined,
  ): Promise<ResolvedConnection | undefined> {
    const id = (connectionId ?? '').trim();
    if (id.length === 0) return undefined;

    const store = this.options.connections;
    if (!store) throw this.missingCapability(node, 'connections', `resolve connection "${id}"`);

    const conn = await store.resolve(id);
    // Hosts wire `redact` as a closure over their Redactor; when they expose
    // `addLiterals` alongside it, every resolved secret is registered before a
    // single request is constructed or a single event emitted.
    const redactor = this.options.redact as unknown as
      | { addLiterals?: (values: readonly string[]) => void }
      | undefined;
    if (redactor && typeof redactor.addLiterals === 'function') {
      registerConnectionSecrets(redactor as { addLiterals(values: readonly string[]): void }, conn);
    }
    return conn;
  }

  /** Applies the host's redactor when one was supplied; identity otherwise. */
  private scrub(value: string): string {
    const redact = this.options.redact;
    if (!redact) return value;
    try {
      return redact(value);
    } catch {
      // A host redactor that throws must never turn a successful step into a
      // failed one; the unredacted value is not emitted either way.
      return '[redacted]';
    }
  }

  /**
   * The evaluation context a data node's expressions see: the payload parsed as
   * JSON (`undefined` when it is not JSON), the raw text, and the single clock
   * `now()` reads. Nothing else — that is what keeps a data node reproducible
   * across the three hosts (Requirement 1.5).
   */
  private exprContext(payload: string): EvalContext {
    return { $: parseJsonPayload(payload), $text: payload, nowMs: Date.now(), vars: this.vars };
  }

  /**
   * The frame's workflow-variable scope. `vars.` in a template or expression
   * resolves here and never against the payload (Requirement 1.6).
   */
  private get vars(): Readonly<Record<string, Json>> {
    return this.options.variables ?? EMPTY_VARIABLES;
  }

  /** Interpolates a template against the payload and this frame's variables. */
  private render(template: string, payload: string): string {
    return interpolatePayload(template, payload, { vars: this.vars });
  }

  /**
   * Success never flows through a declared "On error" port: routing is
   * restricted to the node's regular `message-out` ports, exactly as agents are
   * treated (Requirement 1.6).
   */
  private routeAwayFromErrorPort(
    node: WorkflowNode,
    output: string,
  ): { output: string; viaPortIds?: Set<string> } {
    const errorPortId = (node.data as { errorPortId?: string } | undefined)?.errorPortId;
    if (!errorPortId || !node.ports.some(port => port.id === errorPortId)) return { output };
    const regular = node.ports
      .filter(port => port.role === 'message-out' && port.id !== errorPortId)
      .map(port => port.id);
    return { output, viaPortIds: new Set(regular) };
  }

  /**
   * The 0-based occurrence index encoded in an execution key
   * (`nodeId|payloadHash|occurrence`). Fixture identity reuses it so a fixture
   * addresses one node execution, and every retry of that execution addresses
   * the same fixture (Requirement 16.2).
   */
  private occurrenceOf(executionKey: string): number {
    const tail = executionKey.slice(executionKey.lastIndexOf('|') + 1);
    const occurrence = Number.parseInt(tail, 10);
    return Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : 0;
  }

  // ── §5.1 http-request ──────────────────────────────────────────────────────

  /**
   * The request's rendered `Idempotency-Key`, read case-insensitively so the
   * claimed state key is byte-identical to the header the target receives —
   * including the trim and the 255-character cap `buildDataRequest` applied
   * (Requirement 8.8). Undefined when the node sends no key.
   */
  private idempotencyKeyOf(request: DataRequest): string | undefined {
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.toLowerCase() !== 'idempotency-key') continue;
      return value.length > 0 ? value : undefined;
    }
    return undefined;
  }

  /**
   * Claims the write under the `idem:` namespace (design §8.3). Resolves true
   * when this run owns the write and the outbound call may proceed.
   *
   * A single atomic `compareAndSet` decides ownership, so of two runs racing
   * for the same rendered key — the classic cron fire overlapping a manual
   * trigger — exactly one issues the request (Requirement 12.13). The claim is
   * taken only when the host provides durable state and the node renders a
   * key: without either there is nothing to claim, and the request proceeds
   * exactly as it did before.
   *
   * A store that rejects propagates: ownership is unproven, so the node fails
   * rather than risk a duplicate write.
   */
  private async claimHttpWrite(node: WorkflowNode, request: DataRequest): Promise<boolean> {
    const key = this.idempotencyKeyOf(request);
    if (key === undefined) return true;
    return this.claimWrite(node, key);
  }

  /**
   * Claims one rendered idempotency key for this node execution. Shared by
   * `http-request` and `notify`, so both sending primitives honour one `idem:`
   * namespace and one ownership rule.
   */
  private async claimWrite(node: WorkflowNode, key: string): Promise<boolean> {
    const state = this.options.state;
    if (!state) return true;

    const workflowId = this.options.workflowId ?? '';
    const owned = await claimIdempotent(key, state, { workflowId });
    // Metadata only: the scoped key and whether another owner already held it.
    this.emit({
      type: 'state-read',
      runId: this.options.runId,
      nodeId: node.id,
      key: scopedStateKey(workflowId, idempotencyStateKey(key)),
      found: !owned,
      at: Date.now(),
    });
    return owned;
  }

  /**
   * After a claimed write finally failed: releases the claim when the failure
   * proves the target never accepted it, so a later run may retry; keeps it
   * otherwise, because a write that may have landed must not be sent twice
   * (Requirement 5.6). A release that fails is swallowed: the claim then simply
   * expires with its TTL, which is the safe direction.
   */
  private async releaseClaimOnNonDelivery(key: string | undefined, error: unknown): Promise<void> {
    const state = this.options.state;
    if (key === undefined || !state || !isProvableNonDelivery(error)) return;
    try {
      await releaseIdempotent(key, state, { workflowId: this.options.workflowId ?? '' });
    } catch {
      // Held until its TTL: never a duplicate, at worst a delayed retry.
    }
  }

  /**
   * The node's result when another owner holds the claim: the incoming payload
   * unchanged, and no out-port followed.
   *
   * Suppressing the success path is what keeps the second half of Requirement
   * 12.14 true — a downstream `state-set` with `delta` semantics would write
   * the record's delta hash and mark it synced, and this run performed no
   * write, so the delta key must stay untouched for a later run to classify the
   * record as changed again (Requirement 12.12). `Sync_Summary.skipped` counts
   * the record once; `considered` rises with it so the audit record keeps
   * `considered = changed + skipped` (Requirement 14.8).
   */
  private skipLostClaim(payload: string): { output: string; viaPortIds: Set<string> } {
    this.syncState.summary.considered += 1;
    this.syncState.summary.skipped += 1;
    return { output: payload, viaPortIds: new Set<string>() };
  }

  /**
   * Executes one `http-request` attempt: guards, the idempotency claim,
   * fixtures, the paginated fetch loop, success classification and result
   * selection (design §5.1, §8.3).
   *
   * Called through {@link withNodeRetry}, so a fresh pagination loop starts per
   * attempt and every failure it throws is classified by `decideRetry`. The
   * journal entry is written by `executeNode` from the returned output, so a
   * resumed run replays this node instead of repeating the call (Requirement
   * 8.19).
   */
  private async runHttpRequest(
    node: WorkflowNode,
    payload: string,
    attempt: number,
    executionKey: string,
    claim: { key?: string } = {},
  ): Promise<HttpAttemptOutcome> {
    const data = node.data as HttpRequestNodeData;

    // Capability first: no connection is resolved and no secret is read on a
    // host that cannot issue the request at all (Requirements 8.1, 18.2).
    const fetcher = this.options.dataFetch;
    if (!fetcher) throw this.missingCapability(node, 'dataFetch', 'run HTTP Request steps');

    const conn = await this.resolveNodeConnection(node, data.connectionId);
    // A multipart body reads artifact bytes from the host store, so it is
    // encoded once per attempt here and handed to the pure request builder.
    const multipart =
      data.bodyMode === 'multipart' ? await this.encodeMultipartBody(node, payload) : undefined;
    const occurrence = this.occurrenceOf(executionKey);
    const paginated = isPaginated(data.pagination);
    const loop = createPaginationLoop(data.pagination);
    // The write is claimed once per node execution: on the first page of the
    // first attempt only, so a retry re-sends the identical key it already owns
    // (Requirement 8.8) rather than losing the claim to itself.
    let claimPending = attempt === 1;

    while (loop.canRequest()) {
      // Every detectable authoring error (empty url, non-http scheme, a `json`
      // body template that does not render JSON) throws here, before any I/O.
      const request = buildDataRequest(node, payload, conn, loop.cursor, { vars: this.vars, multipart });

      if (claimPending) {
        // After construction, so a malformed step burns no idempotency key, and
        // before the first outbound call, so the loser never writes (§8.3).
        claimPending = false;
        if (!(await this.claimHttpWrite(node, request))) return { skipped: true };
        if (this.options.state) claim.key = this.idempotencyKeyOf(request);
      }

      const { response, replayed, session } = await this.fetchHttpPage(
        node,
        data,
        request,
        payload,
        occurrence,
        attempt,
        fetcher,
      );

      if (!this.isSuccessStatus(response.status, data.successCodes)) {
        // No part of the response merges into the payload: the retry classifier
        // of §6 and the "On error" routing of Requirement 1 take it from here.
        throw new HttpStatusError(
          response.status,
          response.headers ?? {},
          this.scrub(clipText(response.body ?? '', HTTP_BODY_PREVIEW_MAX_CHARS)),
        );
      }

      // A recorded fixture reproduces the response the node accepted, so a
      // replay of a `replay-or-record` step cannot pin a transient failure.
      if (!replayed) await this.recordHttpFixture(session, response);

      const parsed = this.parseHttpBody(node, data, response);
      if (!paginated) {
        // Mode `none`: exactly one request, no accumulation, no `page-fetched`.
        return { output: selectResult(data, parsed, payload) };
      }

      const outcome = loop.accept(parsed, response.headers);
      this.emit({
        type: 'page-fetched',
        runId: this.options.runId,
        nodeId: node.id,
        page: outcome.event.page,
        items: outcome.event.items,
        hasMore: outcome.event.hasMore,
        at: Date.now(),
      });
    }

    // Loop invariant on exit: `pages <= maxPages` and `items` holds the items of
    // pages 1..pages in fetch order (Requirement 9.14).
    return { output: selectResult(data, loop.result(), payload) };
  }

  /**
   * Performs (or replays) one page request, emitting exactly one
   * `http-request` event per attempt and one `http-response` event per received
   * response, with bodies included only when the node opted in and the host's
   * redactor has processed them (Requirements 8.9, 8.10, 16.9).
   */
  private async fetchHttpPage(
    node: WorkflowNode,
    data: HttpRequestNodeData,
    request: DataRequest,
    payload: string,
    occurrence: number,
    attempt: number,
    fetcher: DataFetcher,
  ): Promise<{
    response: DataResponse;
    replayed: boolean;
    session: FixtureSession<DataResponse>;
  }> {
    const session = createHttpFixtureSession({
      mode: data.fixtures,
      workflowId: this.options.workflowId ?? '',
      nodeId: node.id,
      nodeName: node.name,
      payload,
      occurrence,
      requestFingerprint: httpRequestFingerprint(request),
      store: this.options.fixtures,
    });

    // Read before the request event so a `replay` miss fails the node without
    // announcing a request that was never issued.
    const replay = await session.read();

    this.emit({
      type: 'http-request',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      method: request.method,
      url: this.scrub(request.url),
      attempt,
      ...(data.persistRequestBody && request.body !== undefined
        ? {
            body:
              request.bodyEncoding === 'base64'
                ? `[binary body, ${Math.floor((request.body.length * 3) / 4)} bytes]`
                : this.scrub(request.body),
          }
        : {}),
      at: Date.now(),
    });

    const response = replay ? replay.value : await this.dispatchHttpRequest(request, fetcher);

    this.emit({
      type: 'http-response',
      runId: this.options.runId,
      nodeId: node.id,
      status: response.status,
      durationMs: replay ? 0 : Math.max(0, Math.round(response.durationMs ?? 0)),
      byteCount: Math.max(0, Math.round(response.byteCount ?? 0)),
      ...(response.truncated ? { truncated: true } : {}),
      ...(data.persistResponseBody ? { body: this.scrub(response.body ?? '') } : {}),
      ...(replay ? { replayed: true } : {}),
      at: Date.now(),
    });

    return { response, replayed: replay !== undefined, session };
  }

  /**
   * Issues the request and enforces the effective per-attempt timeout even on a
   * host that ignores `timeoutMs`: an attempt that has not completed within it
   * fails as a `timeout` transport failure (Requirement 8.20).
   */
  private async dispatchHttpRequest(
    request: DataRequest,
    fetcher: DataFetcher,
  ): Promise<DataResponse> {
    const timeoutMs = request.timeoutMs;
    if (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0) return fetcher(request);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetcher(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DataTransportError(
                  'timeout',
                  `The request did not complete within ${Math.round((timeoutMs as number) / 1000)}s.`,
                ),
              ),
            timeoutMs as number,
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Records the live response when the node's fixture mode writes. A store that
   * is absent, rejects, or is handed an oversized fixture produces a warning and
   * the live response still becomes the node's output (Requirement 16.12).
   */
  private async recordHttpFixture(
    session: FixtureSession<DataResponse>,
    response: DataResponse,
  ): Promise<void> {
    if (!session.writes) return;
    const outcome = await session.write(response);
    if (outcome.stored || !outcome.warning) return;
    const sink = (globalThis as { console?: { warn?: (message: string) => void } }).console;
    sink?.warn?.(outcome.warning);
  }

  /**
   * 200-299, plus the at most 20 listed `successCodes` that are integers in
   * 100-599 (Requirement 8.11).
   */
  private isSuccessStatus(status: number, successCodes: number[] | undefined): boolean {
    if (status >= 200 && status <= 299) return true;
    if (!Array.isArray(successCodes)) return false;
    return successCodes
      .slice(0, MAX_SUCCESS_CODES)
      .some(code => Number.isInteger(code) && code >= 100 && code <= 599 && code === status);
  }

  /**
   * Parses the response per `responseMode` (default `json`). A body that does
   * not parse as JSON fails the node with a message saying whether it was
   * truncated, so the "On error" routing of Requirement 1 applies
   * (Requirement 8.21). An empty body in `json` mode is `null` — a 204 is not a
   * parse failure.
   */
  private parseHttpBody(
    node: WorkflowNode,
    data: HttpRequestNodeData,
    response: DataResponse,
  ): unknown {
    const body = typeof response.body === 'string' ? response.body : '';
    if (data.responseMode === 'text') return body;
    if (body.trim().length === 0) return null;
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error(
        `Step "${node.name}" response body was not valid JSON ` +
          `(${response.truncated ? 'the body was truncated at the response byte cap' : 'the body was not truncated'}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── §5.4 sql-query ─────────────────────────────────────────────────────────

  /**
   * Executes one `sql-query` attempt (design §5.4).
   *
   * Everything that can be decided without the database is decided first, in a
   * fixed order, and every one of those failures happens with the target
   * database untouched: the host must be able to run SQL at all, the statement
   * must be free of `{{` template tokens, the driver must be one the host
   * declares support for, a write needs `allowWrites` on the connection, the
   * declared parameters must match the statement, and every parameter
   * expression must evaluate to a bindable scalar.
   *
   * Parameter VALUES never leave this method: they go to the driver as bound
   * parameters, and neither the `sql-query` nor the `sql-result` event carries
   * one (Requirements 10.4, 10.8).
   *
   * Called through {@link withNodeRetry}, so a rejection is classified by
   * `decideRetry` and a final failure routes out the node's "On error" port.
   */
  private async runSqlQuery(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<string> {
    const data = (node.data ?? {}) as SqlQueryNodeData;

    // Capability first: no connection is resolved and no secret is read on a
    // host that cannot run SQL at all (Requirements 10.5, 18.2).
    const host = this.options.sql;
    const declared = typeof data.driver === 'string' ? data.driver.trim() : '';
    if (!host) {
      throw this.missingCapability(
        node,
        'sql',
        `run ${declared.length > 0 ? declared : 'SQL'} queries`,
      );
    }

    // The statement is checked before the connection is resolved: a `{{` token
    // is an authoring error, not a credential problem (Requirement 10.2).
    const statement = typeof data.statement === 'string' ? data.statement : '';
    const invalid = validateSqlStatement(statement);
    if (invalid) throw new Error(`Step "${node.name}" cannot run its query. ${invalid}`);

    const conn = await this.resolveNodeConnection(node, data.connectionId);
    if (!conn) {
      throw new Error(
        `Step "${node.name}" has no connection selected. Choose the SQL connection ` +
          'that holds the credentials for this query.',
      );
    }

    const driver = this.resolveSqlDriver(node, host, data, conn);

    // Conservative write classification: a false positive asks the operator to
    // enable writes, a false negative would mutate a read-only source
    // (Requirements 2.10, 10.6).
    if (isWriteStatement(statement) && conn.allowWrites !== true) {
      throw new Error(
        `Step "${node.name}" runs a statement classified as a write, but connection ` +
          `"${conn.id}" is read-only. Enable writes on that connection to allow it.`,
      );
    }

    const mismatch = reconcileSqlParameters(statement, data.params);
    if (mismatch) throw new Error(`Step "${node.name}" cannot run its query. ${mismatch}`);

    const params = this.bindSqlParameters(node, data.params, payload);
    const limits = resolveSqlLimits(
      { maxRows: data.maxRows, statementTimeoutMs: data.statementTimeoutMs },
      conn.limits,
    );
    const request: SqlRequest = { driver, connection: conn, statement, params, ...limits };

    const session = createSqlFixtureSession({
      mode: data.fixtures,
      workflowId: this.options.workflowId ?? '',
      nodeId: node.id,
      nodeName: node.name,
      payload,
      occurrence: this.occurrenceOf(executionKey),
      // Parameter values are part of the fixture identity but the fingerprint
      // is a hash, so no value is recoverable from the key.
      requestFingerprint: sqlRequestFingerprint(statement, params),
      store: this.options.fixtures,
    });
    // Read before the query event so a `replay` miss fails the node without
    // announcing a statement that was never submitted.
    const replay = await session.read();

    this.emit({
      type: 'sql-query',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      driver,
      statement: this.scrub(statement),
      paramCount: Object.keys(params).length,
      at: Date.now(),
    });

    const result = replay ? replay.value : await this.dispatchSqlQuery(node, host, request);
    if (!replay) await this.recordSqlFixture(session, result);

    // The host owns the caps, but the node's postcondition is `rows <= maxRows`
    // either way, so a host that over-delivers is trimmed and reported as
    // truncated rather than silently handing an oversized result downstream
    // (Requirement 10.11).
    const returned = Array.isArray(result.rows) ? result.rows : [];
    const rows = returned.length > limits.maxRows ? returned.slice(0, limits.maxRows) : returned;
    const truncated = result.truncated === true || rows.length < returned.length;

    this.emit({
      type: 'sql-result',
      runId: this.options.runId,
      nodeId: node.id,
      rowCount: rows.length,
      durationMs: replay ? 0 : Math.max(0, Math.round(result.durationMs ?? 0)),
      ...(truncated ? { truncated: true } : {}),
      ...(replay ? { replayed: true } : {}),
      at: Date.now(),
    });

    const resultKey = (data.resultKey ?? '').trim() || 'rows';
    // Bracket access throughout: the result object is an index signature, and
    // the Studio compiles this file with `noPropertyAccessFromIndexSignature`.
    const output: Record<string, unknown> = { [resultKey]: rows, ['rowCount']: rows.length };
    if (truncated) output['truncated'] = true;
    return JSON.stringify(output);
  }

  /**
   * Resolves the driver from node data, falling back to the connection's
   * `driver` config entry, and consults `SqlHost.supports` before any query is
   * submitted (Requirements 10.5, 18.9, 18.10).
   */
  private resolveSqlDriver(
    node: WorkflowNode,
    host: SqlHost,
    data: SqlQueryNodeData,
    conn: ResolvedConnection,
  ): SqlDriver {
    const fromNode = typeof data.driver === 'string' ? data.driver.trim() : '';
    const fromConnection = (conn.config?.['driver'] ?? '').trim();
    const candidate = (fromNode.length > 0 ? fromNode : fromConnection).toLowerCase();
    const label = this.options.capabilities?.label;
    const hostName = label ? `the ${label} host` : 'this host';

    if (!SQL_DRIVERS.has(candidate)) {
      throw new Error(
        `Step "${node.name}" has no usable SQL driver: ` +
          `"${candidate.length > 0 ? candidate : '(none)'}" is not one of postgres, mysql, mssql ` +
          `or sqlite, so ${hostName} cannot run it.`,
      );
    }

    const driver = candidate as SqlDriver;
    if (!host.supports(driver)) {
      throw new Error(
        `Step "${node.name}" needs a ${driver} driver, which ${hostName} does not provide. ` +
          'See the host capability matrix for the drivers it supports.',
      );
    }
    return driver;
  }

  /**
   * Evaluates each declared parameter expression against the payload in
   * declaration order and keeps only bindable scalars (Requirement 10.4).
   *
   * A failing expression or a non-scalar result fails the node here, before the
   * statement is submitted, so no parameter is bound at all (Requirement 10.13).
   * A payload value never becomes statement text: it leaves as a bound
   * parameter, which is why `'; DROP TABLE …` binds as a harmless string.
   */
  private bindSqlParameters(
    node: WorkflowNode,
    declared: readonly DeclaredSqlParameter[] | undefined,
    payload: string,
  ): Record<string, string | number | boolean | null> {
    const params = declared ?? [];
    if (params.length === 0) return {};

    const ctx = this.exprContext(payload);
    const bound: Record<string, string | number | boolean | null> = {};
    for (const param of params) {
      let value: Json;
      try {
        value = compileExpression(param.expression).evaluate(ctx);
      } catch (error) {
        throw new Error(
          `Step "${node.name}" cannot bind SQL parameter "${param.name}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        bound[param.name] = value;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        bound[param.name] = value;
        continue;
      }
      throw new Error(
        `Step "${node.name}" cannot bind SQL parameter "${param.name}": the expression ` +
          `evaluated to ${describeJsonKind(value)}, and only a string, number, boolean or ` +
          'null can be bound.',
      );
    }
    return bound;
  }

  /**
   * Submits the statement and enforces the effective `statementTimeoutMs` even
   * on a host that ignores it: a statement that has not completed within it
   * fails as a `timeout` transport failure naming the node and the effective
   * timeout (Requirement 10.14). A rejection from the host is re-described with
   * the node, the driver and the connection, keeping its transport class so the
   * retry classifier still sees it (Requirement 10.15).
   */
  private async dispatchSqlQuery(
    node: WorkflowNode,
    host: SqlHost,
    request: SqlRequest,
  ): Promise<SqlResult> {
    const timeoutMs = request.statementTimeoutMs;
    const query = (async (): Promise<SqlResult> => {
      try {
        return await host.query(request);
      } catch (error) {
        throw this.sqlQueryFailure(node, request, error);
      }
    })();

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return query;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        query,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DataTransportError(
                  'timeout',
                  `Step "${node.name}" did not complete its ${request.driver} query within ` +
                    `${timeoutMs}ms.`,
                ),
              ),
            timeoutMs,
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Re-describes a driver rejection with the node, the driver and the
   * connection, keeping a transport failure's `kind` so a retry stays as safe as
   * it was (Requirement 10.15). The driver's own message goes through the host
   * redactor: a connection string in a driver error is exactly the value the
   * Redactor exists for.
   */
  private sqlQueryFailure(node: WorkflowNode, request: SqlRequest, error: unknown): unknown {
    const detail = this.scrub(error instanceof Error ? error.message : String(error));
    const message =
      `Step "${node.name}" failed to run its ${request.driver} query on connection ` +
      `"${request.connection.id}": ${detail}`;

    if (error instanceof DataTransportError) return new DataTransportError(error.kind, message);
    const candidate = error as { name?: unknown; kind?: unknown } | null;
    if (
      !!candidate &&
      typeof candidate === 'object' &&
      candidate.name === 'DataTransportError' &&
      typeof candidate.kind === 'string'
    ) {
      return new DataTransportError(candidate.kind as TransportFailureKind, message);
    }
    return new Error(message);
  }

  /**
   * Records the live result when the node's fixture mode writes. A store that is
   * absent, rejects, or is handed an oversized fixture produces a warning and
   * the live result still becomes the node's output (Requirement 16.12).
   */
  private async recordSqlFixture(
    session: FixtureSession<SqlResult>,
    result: SqlResult,
  ): Promise<void> {
    if (!session.writes) return;
    const outcome = await session.write(result);
    if (outcome.stored || !outcome.warning) return;
    const sink = (globalThis as { console?: { warn?: (message: string) => void } }).console;
    sink?.warn?.(outcome.warning);
  }

  // ── §5.6 assert ────────────────────────────────────────────────────────────

  /**
   * Runs an `assert` node: the guard that stands between a source read and a
   * write (design §5.6).
   *
   * Every assertion is evaluated exactly once in declaration order with no
   * short-circuit, so an operator reads the full verdict instead of the first
   * breach (Requirement 7.1). A holding guard returns the incoming payload
   * byte-identically and routes through the `Passed` port only; a breached
   * `error` guard either fails the node before the write step or routes out a
   * wired `Failed` port, and a breached `warn` guard changes no routing at all
   * (Requirements 7.2, 7.4, 7.5, 7.7).
   *
   * Nothing here reads a clock or a random source: the only inputs are the node
   * data, the payload and the baseline value, and the payload is read, never
   * written (Requirement 7.11).
   */
  private async runAssert(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const data = (node.data ?? {}) as AssertNodeData;

    // Every rejection lands before the baseline read, before the first
    // evaluation and before a single guard entry is appended to the audit
    // record (Requirement 7.10).
    const assertions = this.prepareAssertions(node, data);

    const template = typeof data.baselineStateKey === 'string' ? data.baselineStateKey.trim() : '';
    const baseline =
      template.length > 0 ? await this.readAssertBaseline(node, template, payload) : undefined;
    const ctx = this.assertContext(payload, baseline);

    // Whether a breach routes is decided before the loop: routing needs
    // `onBreach: 'route'` AND a `failedPortId` that names a wired `message-out`
    // port, and a `warn` breach never routes (Requirements 7.3, 7.5, 7.6).
    const routedPortId = data.onBreach === 'route' ? this.wiredFailedPortId(node, data) : null;

    const guards = (this.syncState.summary.guards ??= []);
    const breaches: PreparedAssertion[] = [];

    for (const assertion of assertions) {
      // Loop invariant: `breaches` holds exactly the breached `error`
      // assertions among those already evaluated, in declaration order.
      const held = assertionHolds(this.evaluateAssertion(node, assertion, ctx));
      // One audit entry per evaluated assertion, holding or breached, for both
      // breach outcomes (Requirement 7.9).
      guards.push({
        name: assertion.name,
        passed: held,
        ...(assertion.message === undefined ? {} : { message: assertion.message }),
      });
      if (held) continue;

      this.emit({
        type: 'assert-breached',
        runId: this.options.runId,
        nodeId: node.id,
        nodeName: node.name,
        assertion: assertion.name,
        // The expression source stands in for an undeclared message, so a
        // breach is always self-explanatory (Requirement 7.3).
        message: assertion.message ?? assertion.compiled.source,
        severity: assertion.severity,
        routed: assertion.severity === 'error' && routedPortId !== null,
        at: Date.now(),
      });
      if (assertion.severity === 'error') breaches.push(assertion);
    }

    if (breaches.length === 0) {
      this.emit({
        type: 'assert-passed',
        runId: this.options.runId,
        nodeId: node.id,
        nodeName: node.name,
        checked: assertions.length,
        at: Date.now(),
      });
      return { output: payload, viaPortIds: this.assertPassedPorts(node, data) };
    }

    if (routedPortId) {
      // The breach report carries the payload unchanged, so a repair branch can
      // still work with what the source actually returned (Requirement 7.5).
      return {
        output: JSON.stringify({ breaches: breaches.map(breach => breach.name), input: payload }),
        viaPortIds: new Set([routedPortId]),
      };
    }

    const first = breaches[0];
    throw new Error(
      `Step "${node.name}" stopped on guard "${first.name}": ` +
        `${first.message ?? first.compiled.source}`,
    );
  }

  /**
   * Accepts the node's assertion list or fails the node, naming the rejected
   * assertion or field (Requirement 7.10).
   *
   * Compiling every expression up front is what makes "no guard entry, no
   * output payload" true for a broken node: an assertion that cannot compile is
   * found before the first one is evaluated.
   */
  private prepareAssertions(node: WorkflowNode, data: AssertNodeData): PreparedAssertion[] {
    const declared = Array.isArray(data.assertions) ? data.assertions : [];
    if (declared.length === 0) {
      throw new Error(
        `Step "${node.name}" declares no assertions. Add at least one guard expression, ` +
          'or remove the step.',
      );
    }
    if (declared.length > MAX_ASSERTIONS) {
      throw new Error(
        `Step "${node.name}" declares ${declared.length} assertions, more than the ` +
          `${MAX_ASSERTIONS} a guard may evaluate.`,
      );
    }

    const prepared: PreparedAssertion[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of declared.entries()) {
      const assertion = (raw ?? {}) as Assertion;
      const position = index + 1;
      const name = typeof assertion.name === 'string' ? assertion.name.trim() : '';
      if (name.length === 0) {
        throw new Error(`Step "${node.name}" assertion ${position} has no name.`);
      }
      if (name.length > MAX_ASSERTION_NAME_CHARS) {
        throw new Error(
          `Step "${node.name}" assertion ${position} has a ${name.length}-character name, ` +
            `longer than the ${MAX_ASSERTION_NAME_CHARS} characters allowed.`,
        );
      }
      if (seen.has(name)) {
        throw new Error(
          `Step "${node.name}" declares assertion "${name}" more than once. ` +
            'Give every guard a distinct name.',
        );
      }
      seen.add(name);

      const source = typeof assertion.expression === 'string' ? assertion.expression : '';
      let compiled: CompiledExpression;
      try {
        compiled = compileExpression(source);
      } catch (error) {
        throw new Error(
          `Step "${node.name}" cannot compile assertion "${name}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      prepared.push({
        name,
        compiled,
        severity: assertion.severity === 'warn' ? 'warn' : 'error',
        ...(typeof assertion.message === 'string' && assertion.message.trim().length > 0
          ? { message: assertion.message }
          : {}),
      });
    }
    return prepared;
  }

  /**
   * Evaluates one prepared assertion. A compiled expression can still exhaust
   * its step or depth budget, and that is a node failure naming the assertion
   * rather than a silent breach — a guard that could not be decided must not
   * read as one that held.
   */
  private evaluateAssertion(
    node: WorkflowNode,
    assertion: PreparedAssertion,
    ctx: EvalContext,
  ): Json {
    try {
      return assertion.compiled.evaluate(ctx);
    } catch (error) {
      throw new Error(
        `Step "${node.name}" could not evaluate assertion "${assertion.name}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Reads the baseline value exactly once, before any assertion runs
   * (Requirement 7.8). The key template is interpolated against the payload and
   * scoped by workflow, so two workflows never share a baseline.
   *
   * A key that holds nothing, or holds a value that does not parse as JSON,
   * yields `null` — a variance guard against a missing baseline then compares
   * against `null` instead of failing the run. `state` is required only because
   * the node declared a baseline key (Requirement 18.8).
   */
  private async readAssertBaseline(
    node: WorkflowNode,
    template: string,
    payload: string,
  ): Promise<Json> {
    const state = this.options.state;
    if (!state) {
      throw this.missingCapability(node, 'state', `read the baseline "${template}"`);
    }
    const key = this.render(template, payload);
    const entry = await state.get(scopedStateKey(this.options.workflowId ?? '', key));
    if (!entry || typeof entry.value !== 'string') return null;
    return parseJsonPayload(entry.value) ?? null;
  }

  /**
   * The context an assertion sees: the payload, the raw text, and the baseline
   * addressable as `baseline` (design §5.6).
   *
   * A bare identifier is shorthand for `$.identifier`, so the baseline is bound
   * by shallow-copying the payload root with `baseline` added — a copy, so the
   * incoming payload's objects stay structurally unchanged (Requirement 7.11).
   * A payload that is not a JSON object cannot carry the binding, so its root
   * becomes `{ baseline }`; the raw payload is still addressable as `$text`.
   */
  private assertContext(payload: string, baseline: Json | undefined): EvalContext {
    const ctx = this.exprContext(payload);
    if (baseline === undefined) return ctx;
    const root = ctx.$;
    const merged: Json =
      typeof root === 'object' && root !== null && !Array.isArray(root)
        ? { ...root, baseline }
        : { baseline };
    return { ...ctx, $: merged };
  }

  /**
   * The node's declared `failedPortId`, but only when it names a `message-out`
   * port of this node that at least one handoff leaves from. Anything else
   * yields null, which sends the breach down the fail path instead of dropping
   * it into an unwired port (Requirement 7.6).
   */
  private wiredFailedPortId(node: WorkflowNode, data: AssertNodeData): string | null {
    const failedPortId = (data.failedPortId ?? '').trim();
    if (failedPortId.length === 0) return null;
    if (!node.ports.some(port => port.id === failedPortId && port.role === 'message-out')) {
      return null;
    }
    const wired = this.options.graph.connections.some(
      conn => conn.kind === 'handoff' && portBaseId(conn.outputId) === failedPortId,
    );
    return wired ? failedPortId : null;
  }

  /**
   * The ports a holding guard routes through: every `message-out` port except
   * the one reserved for breaches (Requirements 7.2, 7.7).
   *
   * The breach port is the declared `failedPortId` when it names one; otherwise
   * the port named `Failed`, and otherwise the second out-port of the blueprint
   * — the same positional reading the approval gate uses. A success must not
   * reach the `Failed` branch just because the author left `failedPortId` unset.
   */
  private assertPassedPorts(node: WorkflowNode, data: AssertNodeData): Set<string> {
    const outs = node.ports.filter(port => port.role === 'message-out');
    const declared = (data.failedPortId ?? '').trim();
    const breachPortId =
      outs.find(port => port.id === declared)?.id ??
      outs.find(port => port.name.trim().toLowerCase() === 'failed')?.id ??
      (outs.length > 1 ? outs[1].id : undefined);
    const errorPortId = (data as { errorPortId?: string }).errorPortId;
    return new Set(
      outs
        .filter(port => port.id !== breachPortId && port.id !== errorPortId)
        .map(port => port.id),
    );
  }

  // ── §5.8 state nodes ───────────────────────────────────────────────────────

  /**
   * Runs a `state-get` node: one scoped read, one `state-read` event, and the
   * value merged into the payload under `resultKey` (design §5.8).
   *
   * The key template is interpolated against the payload and scoped by
   * workflow, so two workflows sharing a key name never see each other's value
   * (Requirement 12.2). An absent or expired key falls back to `defaultValue`,
   * and to `null` when the node declares none; the merged value is parsed as
   * JSON when it parses and merged as text otherwise, so a stored record stays
   * addressable as `{{state.field}}` downstream (Requirement 12.5).
   */
  private async runStateGet(node: WorkflowNode, payload: string): Promise<string> {
    const data = (node.data ?? {}) as StateGetNodeData;

    // Capability first: a host without durable state reads nothing, writes
    // nothing and emits no state event (Requirement 12.4).
    const store = this.requireStateStore(node, 'read durable workflow state');
    const key = this.scopedNodeStateKey(node, data.key, payload);

    const entry = await store.get(key);
    const stored = entry && typeof entry.value === 'string' ? entry.value : undefined;
    // Metadata only: the scoped key and whether the key held a value.
    this.emit({
      type: 'state-read',
      runId: this.options.runId,
      nodeId: node.id,
      key,
      found: stored !== undefined,
      at: Date.now(),
    });

    const fallback = typeof data.defaultValue === 'string' ? data.defaultValue : undefined;
    const source = stored ?? fallback;
    const value = source === undefined ? null : tryParseJson(source);
    const resultKey = (data.resultKey ?? '').trim() || 'state';
    return mergePayloads(payload, JSON.stringify({ [resultKey]: value }));
  }

  /**
   * Runs a `state-set` node: the evaluated value stored under the three
   * semantics of design §5.8, then exactly one `state-written` event carrying
   * the write decision (Requirement 12.9).
   *
   *  - `value` (the default) stores the JSON serialisation and always reports
   *    `changed` (Requirement 12.6).
   *  - `delta` stores the `fnv1a` content hash and reports `changed` only when
   *    the key is absent or the hash moved — so run state holds a fingerprint,
   *    never a shadow copy of the record (Requirement 12.7).
   *  - `watermark` is monotonic: it advances only when `compareWatermark` orders
   *    the new value above the stored one, which makes replaying a set of writes
   *    in any order converge on the same value (Requirement 12.8).
   *
   * The payload leaves unchanged apart from the merged `stateChanged` flag, so a
   * downstream step can branch on whether anything actually moved.
   */
  private async runStateSet(node: WorkflowNode, payload: string): Promise<string> {
    const data = (node.data ?? {}) as StateSetNodeData;
    const semantics: 'value' | 'delta' | 'watermark' =
      data.semantics === 'delta' || data.semantics === 'watermark' ? data.semantics : 'value';

    const store = this.requireStateStore(node, 'write durable workflow state');
    const key = this.scopedNodeStateKey(node, data.key, payload);
    // Evaluated before the read, so an uncompilable or undecidable expression
    // fails the node without touching the store and without an event.
    const value = this.evaluateStateValue(node, data.valueExpression, payload);
    const ttl = this.stateTtlOptions(data.ttlSec);

    let changed: boolean;
    let from: string | undefined;
    let advancedTo: string | undefined;

    switch (semantics) {
      case 'delta': {
        const next = contentHash(value);
        const previous = await store.get(key);
        changed = !previous || previous.value !== next;
        if (changed) await store.set(key, next, ttl);
        break;
      }
      case 'watermark': {
        const next = this.watermarkValue(node, value);
        const previous = await store.get(key);
        const held = previous && typeof previous.value === 'string' ? previous.value : undefined;
        from = held;
        changed = held === undefined || compareWatermark(next, held) > 0;
        if (changed) {
          await store.set(key, next, ttl);
          advancedTo = next;
        }
        break;
      }
      default: {
        await store.set(key, JSON.stringify(value) ?? 'null', ttl);
        changed = true;
        break;
      }
    }

    this.emit({
      type: 'state-written',
      runId: this.options.runId,
      nodeId: node.id,
      key,
      semantics,
      changed,
      ...(from === undefined ? {} : { from }),
      ...(advancedTo === undefined ? {} : { to: advancedTo }),
      at: Date.now(),
    });

    return mergePayloads(payload, JSON.stringify({ stateChanged: changed }));
  }

  /**
   * The host's state store, or a failure naming the node and the missing
   * capability. Called before a key is rendered, so a host without durable
   * state performs no read and no write (Requirements 12.4, 18.8).
   */
  private requireStateStore(node: WorkflowNode, what: string): WorkflowStateStore {
    const state = this.options.state;
    if (!state) throw this.missingCapability(node, 'state', what);
    return state;
  }

  /**
   * The node's key template interpolated against the payload and scoped by
   * workflow (Requirement 12.2). A template that renders to nothing is an
   * authoring error rather than a write to the workflow's empty key.
   */
  private scopedNodeStateKey(
    node: WorkflowNode,
    template: string | undefined,
    payload: string,
  ): string {
    const source = typeof template === 'string' ? template : '';
    const key = this.render(source, payload).trim();
    if (key.length === 0) {
      throw new Error(
        `Step "${node.name}" has no state key. Set a key such as "wm:jobs", ` +
          'optionally with {{field}} tokens from the payload.',
      );
    }
    return scopedStateKey(this.options.workflowId ?? '', key);
  }

  /**
   * Evaluates a `state-set` value expression through the shared evaluator, so a
   * stored value depends on nothing but the payload and the run clock
   * (Requirement 1.5). Both the compile and the evaluation failure name the node.
   */
  private evaluateStateValue(
    node: WorkflowNode,
    source: string | undefined,
    payload: string,
  ): Json {
    let compiled: CompiledExpression;
    try {
      compiled = compileExpression(typeof source === 'string' ? source : '');
    } catch (error) {
      throw new Error(
        `Step "${node.name}" cannot compile its value expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return compiled.evaluate(this.exprContext(payload));
    } catch (error) {
      throw new Error(
        `Step "${node.name}" could not evaluate its value expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The string form a watermark is stored and compared in: a non-empty string
   * or a finite number. Anything else — null from an empty page, a boolean, a
   * record — would make the monotonic order meaningless, so the node fails
   * before the read instead of storing a value no later run can advance past.
   */
  private watermarkValue(node: WorkflowNode, value: Json): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new Error(
      `Step "${node.name}" cannot advance its watermark: the value expression evaluated to ` +
        `${describeWatermarkKind(value)}, and a watermark must be a timestamp, an ` +
        'identifier or a finite number.',
    );
  }

  /**
   * The `set` options for an explicit `ttlSec`. An absent, non-integer or
   * out-of-range value is left to the host, which applies the namespace default
   * (Requirement 12.18).
   */
  private stateTtlOptions(ttlSec: number | undefined): { ttlSec: number } | undefined {
    if (typeof ttlSec !== 'number' || !Number.isInteger(ttlSec)) return undefined;
    if (ttlSec < STATE_TTL_MIN_SEC || ttlSec > STATE_TTL_MAX_SEC) return undefined;
    return { ttlSec };
  }

  // ── §5.7 notify ────────────────────────────────────────────────────────────

  /**
   * Runs a `notify` node: one rendered message delivered through the host's
   * `DataFetcher`, then exactly one `notify-sent` event (design §5.7).
   *
   * A notify node is a PASS-THROUGH step: it adds no field to the payload and
   * removes none, so wiring an alert into a sync changes nothing downstream
   * (Requirements 13.1, 13.4). Everything decidable without the network is
   * decided first — the host must be able to issue requests at all, the channel
   * must be one of the three, an email needs a connection and a non-empty
   * recipient — and every one of those failures happens with no outbound
   * request issued and no secret read (Requirements 13.8, 13.9).
   *
   * Delivery always goes through HTTP: an `email` channel posts to the resolved
   * connection's provider API, which is what keeps an SMTP client out of the
   * engine (Requirement 13.5).
   *
   * Called through {@link withNodeRetry}, so a rejection is classified by
   * `decideRetry` and a final failure routes out the node's "On error" port.
   */
  private async runNotify(
    node: WorkflowNode,
    payload: string,
    idempotencyKey?: string,
  ): Promise<string> {
    const data = (node.data ?? {}) as NotifyNodeData;

    // Capability first: no connection is resolved and no secret is read on a
    // host that cannot deliver at all (Requirements 13.8, 18.2).
    const fetcher = this.options.dataFetch;
    if (!fetcher) throw this.missingCapability(node, 'dataFetch', 'deliver Notify steps');

    const channel = typeof data.channel === 'string' ? data.channel.trim() : '';
    if (!NOTIFY_CHANNELS.has(channel)) {
      throw new Error(
        `Step "${node.name}" has no usable notification channel: ` +
          `"${channel.length > 0 ? channel : '(none)'}" is not one of email, webhook ` +
          'or chat-webhook.',
      );
    }

    // Rendered before the connection is resolved, so an empty recipient is
    // reported as the authoring error it is rather than a credential problem.
    // An unresolved `{{path}}` token is left verbatim by `interpolatePayload`
    // (Requirement 13.2).
    const to = this.render(data.to ?? '', payload).trim();
    const connectionId = (data.connectionId ?? '').trim();
    if (channel === 'email') {
      if (connectionId.length === 0) {
        throw new Error(
          `Step "${node.name}" sends email but has no connection selected. Choose the ` +
            'connection that holds the email provider credentials.',
        );
      }
      if (to.length === 0) {
        throw new Error(
          `Step "${node.name}" sends email but its recipient rendered empty. Set a ` +
            'recipient, optionally with {{field}} tokens from the payload.',
        );
      }
    }

    const conn = await this.resolveNodeConnection(node, connectionId);
    const subject =
      typeof data.subject === 'string' && data.subject.length > 0
        ? this.render(data.subject, payload)
        : undefined;
    // An absent body resolves to the whole incoming payload (Requirement 13.2).
    const body = this.render(
      typeof data.body === 'string' && data.body.length > 0 ? data.body : '{{input}}',
      payload,
    );

    const attachmentPaths = (data.attachments ?? []).filter(
      path => typeof path === 'string' && path.trim().length > 0,
    );
    if (attachmentPaths.length > 0 && channel !== 'email') {
      throw new Error(`Step "${node.name}" declares attachments, which only the email channel can deliver.`);
    }

    let request: DataRequest;
    let attachmentCount = 0;
    let omittedAttachments = 0;
    if (channel === 'email') {
      const steps = await import('./delivery-steps.js');
      const parts = await steps.buildEmailRequest(this.deliveryHost, node, payload, {
        to,
        subject,
        body,
        idempotencyKey,
        attachmentPaths,
        conn,
      });
      attachmentCount = parts.attachments;
      omittedAttachments = parts.omitted;
      request = {
        url: parts.url,
        method: 'POST',
        headers: parts.headers,
        body: parts.body,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      };
    } else {
      const message = {
        ...(to.length > 0 ? { to } : {}),
        ...(subject !== undefined ? { subject } : {}),
        body,
      };
      request = {
        url: this.notifyEndpoint(node, channel, to, conn),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        timeoutMs: NOTIFY_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      };
    }
    if (idempotencyKey !== undefined) request.headers['Idempotency-Key'] = idempotencyKey;
    // Auth last, exactly as `buildDataRequest` orders it, so the connection wins
    // over anything the message carries (Requirement 8.6).
    request = applyConnectionAuth(request, conn);

    const response = await this.dispatchHttpRequest(request, fetcher);
    if (response.status < 200 || response.status > 299) {
      // No `notify-sent` for a rejected attempt, and the payload is untouched:
      // the retry classifier of §6 and the "On error" routing of Requirement 1
      // take it from here (Requirement 13.3).
      throw new HttpStatusError(
        response.status,
        response.headers ?? {},
        this.scrub(clipText(response.body ?? '', HTTP_BODY_PREVIEW_MAX_CHARS)),
      );
    }

    // Metadata only: the channel and the masked target. Never the subject, never
    // the body, never a resolved secret (Requirement 13.4).
    this.emit({
      type: 'notify-sent',
      runId: this.options.runId,
      nodeId: node.id,
      channel,
      target: this.scrub(maskNotifyTarget(to.length > 0 ? to : request.url)),
      ...(attachmentCount > 0 ? { attachments: attachmentCount } : {}),
      ...(omittedAttachments > 0 ? { omittedAttachments } : {}),
      at: Date.now(),
    });

    return payload;
  }

  /**
   * The step's rendered idempotency key, or undefined when it declares none.
   * Rendered from the payload and variables only, so every attempt and every
   * replay of the same execution renders the same key.
   */
  private notifyIdempotencyKey(node: WorkflowNode, payload: string): string | undefined {
    const template = (node.data as NotifyNodeData | undefined)?.idempotencyKey;
    if (typeof template !== 'string' || template.trim().length === 0) return undefined;
    const key = this.render(template, payload).trim();
    if (key.length === 0) return undefined;
    if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      throw new Error(
        `Step "${node.name}" renders an idempotency key of ${key.length} characters; ` +
          `the limit is ${MAX_IDEMPOTENCY_KEY_CHARS}.`,
      );
    }
    return key;
  }

  // ── Run artifacts (G2) ─────────────────────────────────────────────────────

  /** What the lazily loaded delivery step bodies need from this frame. */
  private get deliveryHost(): DeliveryHost {
    return {
      render: (template, payload) => this.render(template, payload),
      artifactRefsAt: (node, payload, paths) => this.artifactRefsAt(node, payload, paths),
      readArtifact: (node, ref) => this.readArtifact(node, ref),
    };
  }

  /** The host's artifact store, or a failure naming the node and capability. */
  private requireArtifacts(node: WorkflowNode, what: string): ArtifactStore {
    const store = this.options.artifacts;
    if (!store) throw this.missingCapability(node, 'artifacts', what);
    return store;
  }

  /** Artifact references at payload paths, with the node named in any error. */
  private artifactRefsAt(node: WorkflowNode, payload: string, paths: readonly string[]): ArtifactRef[] {
    try {
      return collectArtifactRefs(payload, paths);
    } catch (error) {
      throw new Error(`Step "${node.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Reads one artifact of this run; a missing one is an error, never an empty file. */
  private async readArtifact(node: WorkflowNode, ref: ArtifactRef): Promise<StoredArtifact> {
    const store = this.requireArtifacts(node, 'read run files');
    const stored = await store.get(this.options.runId, ref.id);
    if (!stored) {
      throw new Error(`Step "${node.name}" cannot find file "${ref.name}" (${ref.id}) in this run.`);
    }
    return stored;
  }

  /**
   * Stores one artifact under the run caps and announces it. The id derives
   * from the run and the producing execution, so a re-executed producer
   * replaces its own file rather than adding a second one.
   */
  private async writeArtifact(
    node: WorkflowNode,
    executionKey: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<ArtifactRef> {
    const store = this.requireArtifacts(node, 'store run files');
    if (bytes.length > ARTIFACT_MAX_BYTES) {
      throw new Error(
        `Step "${node.name}" produced a ${bytes.length}-byte file; the limit is ${ARTIFACT_MAX_BYTES} bytes.`,
      );
    }
    const runId = this.options.runId;
    const id = artifactId(runId, executionKey, name);
    const totals = await this.artifactTotals(store);
    const previous = totals.sizes.get(id);
    const count = totals.count + (previous === undefined ? 1 : 0);
    const size = totals.bytes - (previous ?? 0) + bytes.length;
    if (count > RUN_ARTIFACTS_MAX_COUNT) {
      throw new Error(`Step "${node.name}" would exceed the ${RUN_ARTIFACTS_MAX_COUNT}-file limit for one run.`);
    }
    if (size > RUN_ARTIFACTS_MAX_BYTES) {
      throw new Error(
        `Step "${node.name}" would take this run's files past ${RUN_ARTIFACTS_MAX_BYTES} bytes.`,
      );
    }

    const ref: ArtifactRef = { id, name, mimeType, sizeBytes: bytes.length };
    await store.put(runId, { ref, nodeId: node.id, createdAt: Date.now(), bytes });
    totals.count = count;
    totals.bytes = size;
    totals.sizes.set(id, bytes.length);
    this.emit({
      type: 'artifact-created',
      runId,
      nodeId: node.id,
      nodeName: node.name,
      artifact: { ...ref },
      at: Date.now(),
    });
    return ref;
  }

  /** The run's artifact totals, seeded once from the store. */
  private async artifactTotals(
    store: ArtifactStore,
  ): Promise<{ count: number; bytes: number; sizes: Map<string, number> }> {
    if (this.executionState.artifacts) return this.executionState.artifacts;
    const existing = await store.list(this.options.runId);
    const sizes = new Map(existing.map(ref => [ref.id, ref.sizeBytes]));
    const seeded = {
      count: sizes.size,
      bytes: [...sizes.values()].reduce((sum, value) => sum + value, 0),
      sizes,
    };
    // Re-check after the await: a concurrent iteration may have seeded first.
    this.executionState.artifacts ??= seeded;
    return this.executionState.artifacts;
  }

  /** Builds a `multipart/form-data` body from text fields and artifact files. */
  private async encodeMultipartBody(node: WorkflowNode, payload: string): Promise<EncodedMultipart> {
    const steps = await import('./delivery-steps.js');
    return steps.buildMultipartBody(this.deliveryHost, node, payload);
  }

  // ── render-document (G3) ───────────────────────────────────────────────────

  /**
   * Renders markdown to a PDF artifact and merges its reference under
   * `resultKey`. The bytes never enter the payload.
   */
  private async runRenderDocument(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<string> {
    const data = (node.data ?? {}) as RenderDocumentNodeData;
    this.requireArtifacts(node, 'store rendered documents');
    const steps = await import('./delivery-steps.js');
    const file = steps.renderDocumentFile(this.deliveryHost, node, payload);
    const ref = await this.writeArtifact(node, executionKey, file.name, 'application/pdf', file.bytes);
    const resultKey = (data.resultKey ?? '').trim() || 'document';
    return mergePayloads(payload, JSON.stringify({ [resultKey]: ref }));
  }

  // ── state-list (G6) ────────────────────────────────────────────────────────

  /**
   * Lists the workflow's state entries under a rendered prefix and merges them
   * under `resultKey`. Reserved namespaces (claims, watermarks, fixtures, delta
   * hashes, OAuth tokens) are never returned, whatever the prefix.
   */
  private async runStateList(node: WorkflowNode, payload: string): Promise<string> {
    const data = (node.data ?? {}) as StateListNodeData;
    const store = this.requireStateStore(node, 'list durable workflow state');
    const prefix = this.render(typeof data.prefix === 'string' ? data.prefix : '', payload).trim();
    if (prefix.length === 0) {
      throw new Error(`Step "${node.name}" has no key prefix. Set one such as "open:".`);
    }
    const reserved = reservedStateNamespaceOf(prefix);
    if (reserved) {
      throw new Error(`Step "${node.name}" cannot list the reserved "${reserved}" namespace.`);
    }
    const requested = typeof data.limit === 'number' && Number.isFinite(data.limit) ? Math.floor(data.limit) : 100;
    const limit = Math.max(1, Math.min(requested, STATE_LIST_MAX_LIMIT));
    const workflowId = this.options.workflowId ?? '';
    const scopedPrefix = scopedStateKey(workflowId, prefix);
    const listed = await store.list(scopedPrefix, limit);
    const steps = await import('./delivery-steps.js');
    const { entries, truncated } = steps.shapeStateEntries(listed, scopedPrefix, STATE_LIST_MAX_OUTPUT_CHARS);

    this.emit({
      type: 'state-read',
      runId: this.options.runId,
      nodeId: node.id,
      key: `${scopedPrefix}*`,
      found: entries.length > 0,
      at: Date.now(),
    });

    const resultKey = (data.resultKey ?? '').trim() || 'entries';
    return mergePayloads(
      payload,
      JSON.stringify({ [resultKey]: entries, ...(truncated ? { [`${resultKey}Truncated`]: true } : {}) }),
    );
  }

  /**
   * The URL the notification is posted to.
   *
   * A webhook addresses itself: the rendered `to` is the hook url when the
   * author supplied one, and the connection's endpoint otherwise — which is how
   * a hook url that is itself a secret stays out of the spec. An email always
   * goes to the connection's provider API, never to the recipient address
   * (Requirement 13.5).
   */
  private notifyEndpoint(
    node: WorkflowNode,
    channel: string,
    to: string,
    conn: ResolvedConnection | undefined,
  ): string {
    const configured = notifyConnectionEndpoint(conn);
    const url = channel === 'email' ? configured : /^https?:\/\//i.test(to) ? to : configured;
    if (!url) {
      throw new Error(
        `Step "${node.name}" has no notification endpoint: set an https url on the step` +
          `${conn ? ` or a "baseUrl" on connection "${conn.id}"` : ''}.`,
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `Step "${node.name}" cannot deliver to "${url}": a notification endpoint must be ` +
          'an http or https url.',
      );
    }
    return url;
  }

  // ── Node behaviours ────────────────────────────────────────────────────────

  private async runAgent(node: WorkflowNode, payload: string, executionKey: string): Promise<string> {
    const data = node.data as AgentNodeData & { region?: string };

    // Resolve the model: explicit node config wins; otherwise inherit the
    // run's default model (the studio's application settings).
    const inherited = this.options.defaultModel;
    const provider: ModelProviderId | undefined = data.provider ?? inherited?.provider;
    const model = data.provider ? data.model : (data.model ?? inherited?.model);
    if (!provider || !model) {
      throw new Error(
        `Agent "${node.name}" has no model configured and no application default model is set. ` +
          'Pick a model on the node or set a default in Settings → Models.',
      );
    }
    const temperature = data.temperature ?? (data.provider ? undefined : inherited?.temperature);

    // Resolve callable tools from the agent's tool-link edges.
    const toolNodes = this.attachedTools(node);
    const allResolved: ResolvedTool[] =
      this.options.tools && toolNodes.length > 0
        ? await resolveAgentTools(toolNodes, this.options.tools)
        : [];

    // System One preselection: offer the model only the tools and skills that
    // fit this turn. Tools never narrow to zero; skills may.
    const { tools: resolved, skills: selectedSkills } = await this.preselectForAgent(
      node,
      payload,
      executionKey,
      allResolved,
    );
    const byWireName = new Map(resolved.map(tool => [tool.definition.name, tool]));

    const system = this.renderPrompt(data.prompt, payload, node, allResolved.length > 0, selectedSkills);
    let messages: ChatMessage[] = [{ role: 'user', content: payload || 'Begin.' }];
    let output = '';

    // Per-node timeout covers the WHOLE node body: every model round and
    // every tool call. Checked between stream chunks (like gate.stopped).
    const timeoutSec = typeof data.timeoutSec === 'number' && data.timeoutSec > 0 ? data.timeoutSec : 0;
    const nodeDeadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0;
    const checkDeadline = (): void => {
      if (nodeDeadline && Date.now() > nodeDeadline) {
        throw new NodeTimeoutError(node.name, timeoutSec);
      }
    };

    // The active (provider, model) pair — swapped once if the fallback kicks in.
    let active = { provider, model };
    let usedFallback = false;
    const fallback =
      data.fallback && data.fallback.provider && data.fallback.model ? data.fallback : undefined;

    // Retry policy: ON by default for transient failures (one retry, 1s
    // backoff, doubling). Nodes tune or disable via `data.retry`.
    const retry = data.retry ?? {};
    const maxAttempts = retry.disabled
      ? 1
      : Math.max(1, Math.min(retry.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS));
    const backoffMs = Math.max(0, retry.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    const retryAll = retry.retryOn === 'all';

    // Context compression bookkeeping: prefer real token counts from usage
    // chunks; fall back to a chars/4 estimate.
    let lastReportedInputTokens: number | undefined;

    /**
     * Streams one model round. Emitted tokens are buffered until the stream
     * survives its first chunk? No — tokens stream live (execution theatre);
     * a retried round may therefore show a partial then a fresh stream. The
     * trace's node-retrying entry explains the restart.
     */
    const streamRound = async (): Promise<{
      roundText: string;
      calls: ToolCall[];
      reasoning?: ReasoningReplay;
    }> => {
      let roundText = '';
      const calls: ToolCall[] = [];
      let reasoning: ReasoningReplay | undefined;
      for await (const chunk of this.options.model.stream({
        provider: active.provider,
        model: active.model,
        system,
        messages,
        tools: resolved.map(tool => tool.definition),
        temperature,
        maxTokens: data.maxTokens,
        ollamaBaseUrl: this.options.ollamaBaseUrl,
        lmstudioBaseUrl: this.options.lmstudioBaseUrl,
        // Per-node region wins; otherwise the run's default Bedrock region.
        bedrockRegion: data.region ?? this.options.bedrockRegion,
      })) {
        if (this.gate.stopped) throw new RunStoppedError();
        checkDeadline();
        if (chunk.type === 'text') {
          roundText += chunk.text;
          this.emit({ type: 'node-token', runId: this.options.runId, nodeId: node.id, token: chunk.text });
        } else if (chunk.type === 'thinking') {
          // Reasoning tokens are surfaced for the thinking overlay but never
          // accumulated into `roundText`/`output` — they must not leak into
          // handoffs or the final answer.
          this.emit({ type: 'node-thinking', runId: this.options.runId, nodeId: node.id, token: chunk.text });
        } else if (chunk.type === 'usage') {
          if (typeof chunk.usage.inputTokens === 'number') {
            lastReportedInputTokens = chunk.usage.inputTokens;
          }
          // One usage event per model round; consumers sum rounds per node.
          this.emit({
            type: 'node-usage',
            runId: this.options.runId,
            nodeId: node.id,
            provider: active.provider,
            model: active.model,
            usage: chunk.usage,
            at: Date.now(),
          });
        } else if (chunk.type === 'tool-call') {
          calls.push(chunk.call);
        } else if (chunk.type === 'reasoning-replay') {
          reasoning = chunk.replay;
        }
      }
      return { roundText, calls, reasoning };
    };

    /** One round with retries, then (once) the fallback model with retries. */
    const streamRoundRobustly = async (): Promise<{
      roundText: string;
      calls: ToolCall[];
      reasoning?: ReasoningReplay;
    }> => {
      for (;;) {
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await streamRound();
          } catch (error) {
            if (error instanceof RunStoppedError) throw error;
            lastError = error;
            const retryable = retryAll || isTransientModelError(error);
            if (!retryable || attempt === maxAttempts) break;
            const delayMs = backoffMs * 2 ** (attempt - 1);
            this.emit({
              type: 'node-retrying',
              runId: this.options.runId,
              nodeId: node.id,
              nodeName: node.name,
              attempt,
              maxAttempts,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            });
            await this.gate.sleep(delayMs);
            checkDeadline();
          }
        }
        // Primary (or fallback) attempts exhausted — switch to the fallback
        // model once, or give up.
        if (fallback && !usedFallback) {
          usedFallback = true;
          this.emit({
            type: 'node-fallback',
            runId: this.options.runId,
            nodeId: node.id,
            nodeName: node.name,
            fromProvider: active.provider,
            fromModel: active.model,
            toProvider: fallback.provider,
            toModel: fallback.model,
            error: lastError instanceof Error ? lastError.message : String(lastError),
            at: Date.now(),
          });
          active = { provider: fallback.provider, model: fallback.model };
          continue;
        }
        throw lastError;
      }
    };

    // Per-agent override takes precedence over the run-level option so a
    // long-tool-loop agent (e.g. Jira safety-net's per-issue worklog checks
    // + final email) can opt out of the tight 8-round default without
    // raising the ceiling for every other agent in the same run.
    const agentMaxRounds = (node.data as AgentNodeData).maxToolRounds;
    const maxToolRounds =
      typeof agentMaxRounds === 'number' && agentMaxRounds > 0
        ? agentMaxRounds
        : this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const initialMessages = messages;
    const runLoop = async (): Promise<string> => {
      messages = initialMessages;
      output = '';
      for (let round = 0; round < maxToolRounds; round++) {
        // Compress the conversation when the next request would land near the
        // model's context limit. Best-effort: failures never break the node.
        if (!data.compressionDisabled && round > 0) {
          messages = await this.maybeCompressContext(
            node,
            active.provider,
            active.model,
            system,
            messages,
            lastReportedInputTokens,
          );
        }

        const { roundText, calls, reasoning } = await streamRoundRobustly();

        output += (output && roundText ? '\n' : '') + roundText;
        if (calls.length === 0) break;

        // Execute the requested tools, then hand the results back to the model.
        // Reasoning state (thinking signatures) is echoed back verbatim - a
        // Claude tool continuation without it loses or rejects its thinking.
        messages.push({
          role: 'assistant-tool-calls',
          text: roundText || undefined,
          calls,
          ...(reasoning ? { reasoning } : {}),
        });
        const results: { id: string; name: string; content: string }[] = [];
        for (const call of calls) {
          if (this.gate.stopped) throw new RunStoppedError();
          checkDeadline();
          const content = await this.executeToolCall(node, call, byWireName);
          results.push({ id: call.id, name: call.name, content });
        }
        messages.push({ role: 'tool-results', results });
        checkDeadline();
      }
      return output.trim();
    };

    const first = await runLoop();
    const verify = data.verify;
    if (!verify?.enabled) return first;

    // System One verification: calibrated "is this wrong?" checks, max-gated.
    const verdict = await this.verifyAgentOutput(node, payload, executionKey, data.prompt, first, verify, 0);
    if (!verdict.failed) return first;
    const onFail = verify.onFail ?? 'fallback';
    const reason = `System One flagged the output of "${node.name}" (${verdict.fired.join(', ')}).`;
    if (onFail === 'warn') return first;
    if (onFail === 'fallback' && fallback && !usedFallback) {
      usedFallback = true;
      this.emit({
        type: 'node-fallback',
        runId: this.options.runId,
        nodeId: node.id,
        nodeName: node.name,
        fromProvider: active.provider,
        fromModel: active.model,
        toProvider: fallback.provider,
        toModel: fallback.model,
        error: reason,
        at: Date.now(),
      });
      active = { provider: fallback.provider, model: fallback.model };
      const second = await runLoop();
      const recheck = await this.verifyAgentOutput(node, payload, executionKey, data.prompt, second, verify, 1);
      if (!recheck.failed) return second;
      throw new Error(
        `System One flagged the output of "${node.name}" again after the fallback model (${recheck.fired.join(', ')}).`,
      );
    }
    throw new Error(
      onFail === 'fallback' ? `${reason} No fallback model is configured.` : reason,
    );
  }

  /**
   * Runs the verify battery against an agent's output. `attempt` scopes the
   * fixture so the primary and fallback checks replay independently.
   */
  private async verifyAgentOutput(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
    instructions: string,
    output: string,
    config: AgentVerifyConfig,
    attempt: number,
  ): Promise<VerifyVerdict> {
    const task = payloadToState(payload, config.statePath);
    const outcome = await this.evaluateDecision(node, 'verify', {
      payload,
      executionKey,
      tuning: config,
      questions: verifyQuestions(config),
      state: verifyState(typeof task === 'string' ? task : JSON.stringify(task), instructions, output),
      fixtures: (node.data as { fixtures?: FixtureMode }).fixtures,
      ...(attempt > 0 ? { fixtureScope: 'fallback' } : {}),
    });
    const verdict = verifyVerdict(config, outcome.result.answers);
    this.emitDecision(node, 'verify', outcome, verdict.failed ? { fallback: 'low-confidence' } : {});
    return verdict;
  }

  /**
   * Tool/skill preselection. Two passes: one Choice ranks every candidate
   * (its probabilities are the ranking) with a "does this turn need one"
   * gate, then absolute fit Nouls on the shortlist. Any failure degrades to
   * the full list - preselection is an optimisation, never a blocker. A
   * missing decision client is the exception: it fails like every other
   * System One feature except the Router.
   */
  private async preselectForAgent(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
    tools: ResolvedTool[],
  ): Promise<{ tools: ResolvedTool[]; skills?: AgentSkill[] }> {
    const data = node.data as AgentNodeData;
    const config = data.preselect;
    const skills = Array.isArray(data.skills) ? data.skills : [];
    if (!config?.enabled) return { tools };
    // Only the Router degrades without a client; every other feature says so.
    if (!this.options.decisions) throw this.missingCapability(node, 'decisions', 'preselect tools with System One');

    const topK = typeof config.topK === 'number' && config.topK > 0 ? config.topK : 3;
    const minFit = readThreshold(config.minFit, 0.3);
    // The turn as the model will see it, capped to keep the state narrow.
    const request = (payload || 'Begin.').slice(0, 24_000);

    const narrow = async <T>(
      kind: 'tool' | 'skill',
      purpose: DecisionPurpose,
      items: T[],
      toCandidate: (item: T) => PreselectCandidate,
      allowEmpty: boolean,
    ): Promise<T[]> => {
      // Nothing to gain below topK+1 candidates when narrowing may not empty.
      if (items.length === 0 || (!allowEmpty && items.length <= topK)) return items;
      const candidates = items.map(toCandidate);
      try {
        const { questions, labels } = preselectRankQuestions(kind, candidates);
        const ranked = await this.evaluateDecision(node, purpose, {
          payload,
          executionKey,
          tuning: config,
          questions,
          state: { request },
          fixtures: (data as { fixtures?: FixtureMode }).fixtures,
          fixtureScope: 'rank',
        });
        const { shortlist, gate } = preselectShortlist(candidates, labels, ranked.result.answers, topK);
        // Candidates past the 255-option limit were never ranked: keep them.
        const overflow = candidates.slice(labels.length);
        let kept: PreselectCandidate[];
        let fitOutcome: typeof ranked | undefined;
        if (allowEmpty && gate < minFit) {
          kept = [];
        } else {
          fitOutcome = await this.evaluateDecision(node, purpose, {
            payload,
            executionKey,
            tuning: config,
            questions: preselectFitQuestions(kind, shortlist),
            state: { request },
            fixtures: (data as { fixtures?: FixtureMode }).fixtures,
            fixtureScope: 'fit',
          });
          kept = preselectFitting(shortlist, fitOutcome.result.answers, minFit);
          if (!allowEmpty && kept.length === 0) kept = shortlist.slice(0, 1);
        }
        const merged = { ...ranked.result.answers, ...(fitOutcome?.result.answers ?? {}) };
        this.emitDecision(node, purpose, {
          result: { ...ranked.result, answers: merged },
          durationMs: ranked.durationMs + (fitOutcome?.durationMs ?? 0),
          replayed: ranked.replayed && (fitOutcome?.replayed ?? true),
        });
        const keep = new Set([...kept, ...overflow].map(candidate => candidate.key));
        return items.filter((item, index) => keep.has(candidates[index]!.key));
      } catch (error) {
        if (error instanceof RunStoppedError) throw error;
        this.emitDecision(node, purpose, { durationMs: 0 }, { fallback: 'error' });
        return items;
      }
    };

    const narrowedTools =
      config.tools === false
        ? tools
        : await narrow(
            'tool',
            'tool-select',
            tools,
            tool => ({
              key: tool.definition.name,
              name: tool.definition.name,
              description: tool.definition.description,
            }),
            false,
          );
    const narrowedSkills =
      config.skills === false || skills.length === 0
        ? undefined
        : await narrow(
            'skill',
            'skill-select',
            skills,
            skill => ({
              key: skill.id || skill.name,
              name: skill.name || 'Skill',
              description: skill.description || skill.content.slice(0, 400),
            }),
            true,
          );
    return { tools: narrowedTools, skills: narrowedSkills };
  }

  /**
   * Automatic context compression — when the conversation approaches the
   * model's context window (~80%), the middle messages are replaced by an
   * LLM-written summary. The first user message and the last two complete
   * tool rounds stay verbatim. Best-effort: any failure returns the
   * original messages untouched.
   */
  private async maybeCompressContext(
    node: WorkflowNode,
    provider: string,
    model: string,
    system: string,
    messages: ChatMessage[],
    reportedInputTokens: number | undefined,
  ): Promise<ChatMessage[]> {
    const window = this.options.contextWindow?.(provider, model) ?? DEFAULT_CONTEXT_WINDOW;
    const estimated = estimateMessageTokens(system, messages);
    const current = Math.max(reportedInputTokens ?? 0, estimated);
    if (current < window * COMPRESSION_THRESHOLD) return messages;

    // Keep: the opening user message + the last N complete tool rounds
    // (assistant-tool-calls / tool-results pairs, plus anything after).
    const keepHead = 1;
    let tailStart = messages.length;
    let pairs = 0;
    for (let i = messages.length - 1; i >= keepHead && pairs < COMPRESSION_KEEP_TAIL_PAIRS; i--) {
      if (messages[i].role === 'assistant-tool-calls') pairs += 1;
      tailStart = i;
    }
    const middle = messages.slice(keepHead, tailStart);
    if (middle.length < 2) return messages; // nothing meaningful to fold

    const transcript = clipText(
      middle.map(describeMessageForSummary).join('\n\n'),
      COMPRESSION_TRANSCRIPT_MAX_CHARS,
    );

    try {
      let summary = '';
      for await (const chunk of this.options.model.stream({
        provider: provider as ModelProviderId,
        model,
        system:
          'Summarize the following working transcript so an agent can continue the task. ' +
          'Preserve every fact, decision, tool result detail, id, and number that later steps ' +
          'might need. Be dense and factual. Output only the summary.',
        messages: [{ role: 'user', content: transcript }],
        maxTokens: 1024,
        ollamaBaseUrl: this.options.ollamaBaseUrl,
        lmstudioBaseUrl: this.options.lmstudioBaseUrl,
        bedrockRegion: this.options.bedrockRegion,
      })) {
        if (this.gate.stopped) throw new RunStoppedError();
        if (chunk.type === 'text') summary += chunk.text;
      }
      if (!summary.trim()) return messages;

      // The summary rides as a user message: providers with strict
      // user/assistant alternation (Anthropic) reject back-to-back
      // assistant turns, and the opening message is already user-role.
      const compressed: ChatMessage[] = [
        ...messages.slice(0, keepHead),
        {
          role: 'user',
          content: `[Context compressed — summary of your earlier work]\n\n${summary.trim()}`,
        },
        ...messages.slice(tailStart),
      ];
      this.emit({
        type: 'context-compressed',
        runId: this.options.runId,
        nodeId: node.id,
        beforeTokens: current,
        afterTokens: estimateMessageTokens(system, compressed),
        at: Date.now(),
      });
      return compressed;
    } catch (error) {
      if (error instanceof RunStoppedError) throw error;
      return messages; // compression must never fail the node
    }
  }

  /** Executes one tool call via the host, emitting call/result events. */
  private async executeToolCall(
    agent: WorkflowNode,
    call: ToolCall,
    byWireName: Map<string, ResolvedTool>,
  ): Promise<string> {
    const tool = byWireName.get(call.name);
    const toolNodeId = tool?.nodeId ?? '';
    this.emit({
      type: 'tool-call',
      runId: this.options.runId,
      nodeId: agent.id,
      toolNodeId,
      name: call.name,
      arguments: call.arguments,
      at: Date.now(),
    });

    let result: string;
    let isError = false;
    if (!tool || !this.options.tools) {
      result = `Unknown tool "${call.name}".`;
      isError = true;
    } else {
      const toolNode = this.options.graph.nodes.find(item => item.id === tool.nodeId);
      try {
        result = toolNode
          ? await this.options.tools.callTool(toolNode, tool.nativeName, call.arguments)
          : `Tool node for "${call.name}" no longer exists.`;
      } catch (error) {
        result = error instanceof Error ? error.message : String(error);
        isError = true;
      }
    }

    // Cap tool output so a huge response can't blow the context window. An
    // agent may raise the cap via `toolResultCapChars` when it needs the full
    // payload (e.g. paginated Slack/Jira responses whose cursor lives at the
    // tail and would be lost under the default cap).
    const requested = (agent.data as AgentNodeData).toolResultCapChars;
    const cap =
      typeof requested === 'number' && requested > 0
        ? Math.min(Math.floor(requested), MAX_TOOL_RESULT_CAP_CHARS)
        : DEFAULT_TOOL_RESULT_CAP_CHARS;
    if (result.length > cap) result = `${result.slice(0, cap)}\n…(truncated)`;

    this.emit({
      type: 'tool-result',
      runId: this.options.runId,
      nodeId: agent.id,
      toolNodeId,
      name: call.name,
      result,
      isError,
      at: Date.now(),
    });
    return result;
  }

  /**
   * Renders the agent's markdown prompt: interpolates `{{input}}`, appends
   * attached skills, and appends a capabilities section describing attached
   * tools and handoff targets so the model knows its place in the workflow.
   */
  private renderPrompt(
    template: string,
    payload: string,
    node: WorkflowNode,
    toolsCallable: boolean,
    selectedSkills?: readonly AgentSkill[],
  ): string {
    // `{{input}}` interpolates the whole payload; `{{a.b.c}}` digs into it
    // when the payload parses as JSON (structured handoffs).
    let prompt = this.render(template, payload);

    // Attached skills render verbatim (no interpolation - skills are static
    // guidance, not task templates), in attachment order, before the
    // capabilities/hand-off sections. Preselection may pass a subset.
    const skills = selectedSkills ?? (node.data as AgentNodeData).skills;
    if (Array.isArray(skills)) {
      for (const skill of skills) {
        if (!skill || typeof skill.content !== 'string' || !skill.content.trim()) continue;
        const name = typeof skill.name === 'string' && skill.name.trim() ? skill.name.trim() : 'Skill';
        prompt += `\n\n# Skill: ${name}\n\n${skill.content.trim()}`;
      }
    }

    const tools = this.attachedTools(node);
    if (tools.length > 0 && !toolsCallable) {
      prompt +=
        '\n\n# Available capabilities\n\n' +
        tools.map(tool => `- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`).join('\n') +
        '\n\n(Tool invocation is unavailable in this run; factor these capabilities into your plan.)';
    }

    const targets = this.handoffTargets(node);
    if (targets.length > 0) {
      prompt +=
        '\n\n# Hand-off\n\nYour result will be handed to: ' +
        targets.map(target => `"${target.name}"`).join(', ') +
        '. Produce output that serves them.';
    }
    return prompt;
  }

  // ── System One (TypeSafe Jev) ─────────────────────────────────────────────────

  /**
   * The one path every System One call takes: validation, fixture replay, the
   * shared rate-limit-aware retry loop (decision calls are read-only, so they
   * are idempotent unless the node says otherwise), then exactly one `decision`
   * event and one `node-usage` event so cost lands in the run totals.
   *
   * `emitDecision: false` lets a caller that knows the routing outcome emit the
   * event itself with `selectedPortId`.
   */
  private async evaluateDecision(
    node: WorkflowNode,
    purpose: DecisionPurpose,
    input: {
      payload: string;
      executionKey: string;
      tuning: DecisionTuningLike;
      questions: Record<string, DecisionQuestion>;
      fixtures?: FixtureMode;
      retry?: NodeRetryPolicy;
      /** Explicit state; absent = the payload narrowed by `tuning.statePath`. */
      state?: string | Record<string, unknown> | unknown[];
      /** Suffix keeping several calls of one purpose apart in the fixture store. */
      fixtureScope?: string;
    },
  ): Promise<{ result: DecisionResult; durationMs: number; replayed: boolean }> {
    const client = this.options.decisions;
    if (!client) throw this.missingCapability(node, 'decisions', 'ask System One');

    const request = {
      model: resolveDecisionModel(input.tuning.decisionModel, this.options.decisionModel),
      state: input.state ?? payloadToState(input.payload, input.tuning.statePath),
      questions: input.questions,
    };
    const invalid = validateDecisionRequest(request);
    if (invalid) throw new Error(`Step "${node.name}" cannot ask System One. ${invalid}`);

    const session = createDecisionFixtureSession({
      mode: input.fixtures,
      workflowId: this.options.workflowId ?? '',
      // Purpose-scoped so an agent's verify and preselect calls never collide.
      nodeId: `${node.id}#${purpose}${input.fixtureScope ? `#${input.fixtureScope}` : ''}`,
      nodeName: node.name,
      payload: input.payload,
      occurrence: this.occurrenceOf(input.executionKey),
      requestFingerprint: decisionRequestFingerprint(request),
      store: this.options.fixtures,
    });
    const replay = await session.read();
    if (replay) return { result: replay.value, durationMs: 0, replayed: true };

    const policy: NodeRetryPolicy = { idempotent: true, ...(input.retry ?? {}) };
    const started = Date.now();
    const result = await runWithNodeRetry(policy, () => client.evaluate(request), {
      onRetry: notice => {
        this.emit({
          type: 'node-retrying',
          runId: this.options.runId,
          nodeId: node.id,
          nodeName: node.name,
          attempt: notice.attempt,
          maxAttempts: notice.maxAttempts,
          delayMs: notice.delayMs,
          error: formatRetryEventError(notice.error, notice.reason),
          at: Date.now(),
        });
      },
      sleep: ms => this.gate.sleep(ms),
      stopped: () => this.gate.stopped,
      awaitResume: () => (this.gate.paused ? this.gate.checkpoint(node.id) : Promise.resolve()),
      describe: error => describeRetryError(error, this.options.redact),
    });
    if (this.gate.stopped) throw new RunStoppedError();
    const durationMs = Math.max(0, Date.now() - started);

    if (session.writes) {
      const outcome = await session.write(result);
      if (!outcome.stored && outcome.warning) {
        (globalThis as { console?: { warn?: (message: string) => void } }).console?.warn?.(outcome.warning);
      }
    }

    this.emit({
      type: 'node-usage',
      runId: this.options.runId,
      nodeId: node.id,
      provider: DECISION_PROVIDER,
      model: result.model || request.model,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: decisionCostUsd(result.usage),
        costSource: 'estimated',
      },
      at: Date.now(),
    });
    return { result, durationMs, replayed: false };
  }

  private emitDecision(
    node: WorkflowNode,
    purpose: DecisionPurpose,
    outcome: { result?: DecisionResult; durationMs: number; replayed?: boolean },
    extra: { selectedPortId?: string; fallback?: 'no-transport' | 'low-confidence' | 'error' } = {},
  ): void {
    this.emit({
      type: 'decision',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      purpose,
      model: outcome.result?.model ?? '',
      answers: outcome.result?.answers ?? {},
      ...(extra.selectedPortId ? { selectedPortId: extra.selectedPortId } : {}),
      ...(extra.fallback ? { fallback: extra.fallback } : {}),
      durationMs: outcome.durationMs,
      ...(outcome.replayed ? { replayed: true } : {}),
      at: Date.now(),
    });
  }

  /**
   * Router. `keyword` (default) is the historical substring match. `decide`
   * asks System One one Choice over the routes - option labels are the port
   * names (what the model reads), mapped back to port ids so renaming a port
   * never breaks a spec. Low confidence takes the declared unsure port.
   */
  private async runRouter(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const routes = node.ports.filter(port => port.role === 'message-out');
    if (routes.length === 0) return { output: payload, viaPortIds: new Set() };

    const data = (node.data ?? {}) as RouterNodeData;
    if (data.mode === 'expression') return this.expressionRoute(node, routes, payload, data);
    if (data.mode !== 'decide') return this.keywordRoute(routes, payload);

    const unsure = routes.find(port => port.id === data.unsurePortId);
    const options = unsure ? routes.filter(port => port !== unsure) : routes;
    if (!this.options.decisions) {
      const fallback = this.keywordRoute(routes, payload);
      this.emitDecision(
        node,
        'route',
        { durationMs: 0 },
        { selectedPortId: [...fallback.viaPortIds][0], fallback: 'no-transport' },
      );
      return fallback;
    }
    if (options.length === 0) return { output: payload, viaPortIds: new Set([routes[0].id]) };
    if (options.length === 1) {
      return { output: payload, viaPortIds: new Set([options[0].id]) };
    }

    const labels = uniqueOptionLabels(
      options.map(port => port.name),
      index => `Route ${index + 1}`,
    );
    const byLabel = new Map(labels.map((label, index) => [label, options[index]]));
    const criteria: Record<string, string | null> = {};
    labels.forEach((label, index) => {
      const description = (data.routeCriteria?.[options[index].id] ?? '').trim();
      criteria[label] = description || null;
    });
    const instructions =
      (data.instructions ?? '').trim() || 'Which route should handle this input?';

    const outcome = await this.evaluateDecision(node, 'route', {
      payload,
      executionKey,
      tuning: data,
      questions: { route: { type: 'choice', instructions, criteria } },
      fixtures: data.fixtures,
      retry: data.retry,
    });
    const answer = outcome.result.answers['route'] as ChoiceAnswer | undefined;
    const chosen = answer ? byLabel.get(answer.choice) : undefined;
    const minConfidence = readThreshold(data.minConfidence, 0.5);

    let via = chosen ?? options[0];
    let fallback: 'low-confidence' | undefined;
    if (unsure && (!answer || answer.confidence < minConfidence)) {
      via = unsure;
      fallback = 'low-confidence';
    }
    this.emitDecision(node, 'route', outcome, { selectedPortId: via.id, fallback });
    return { output: payload, viaPortIds: new Set([via.id]) };
  }

  /**
   * Expression mode: evaluates `expression` and takes the route whose name
   * equals the result (trimmed, case-insensitive). No match takes the declared
   * unsure port, and with none declared fails the node naming the value, so a
   * typo in a route name is loud rather than a silent wrong branch.
   */
  private expressionRoute(
    node: WorkflowNode,
    routes: readonly { id: string; name: string }[],
    payload: string,
    data: RouterNodeData,
  ): { output: string; viaPortIds: Set<string> } {
    let compiled: CompiledExpression;
    try {
      compiled = compileExpression(typeof data.expression === 'string' ? data.expression : '');
    } catch (error) {
      throw new Error(
        `Router "${node.name}" has an invalid route expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const value = compiled.evaluate(this.exprContext(payload));
    const wanted = (typeof value === 'string' ? value : JSON.stringify(value) ?? 'null').trim().toLowerCase();
    const match = routes.find(route => route.name.trim().toLowerCase() === wanted);
    if (match) return { output: payload, viaPortIds: new Set([match.id]) };
    const unsure = routes.find(route => route.id === data.unsurePortId);
    if (unsure) return { output: payload, viaPortIds: new Set([unsure.id]) };
    throw new Error(
      `Router "${node.name}" evaluated to ${JSON.stringify(value)}, which names none of its routes ` +
        `(${routes.map(route => route.name).join(', ')}).`,
    );
  }

  private keywordRoute(
    routes: readonly { id: string; name: string }[],
    payload: string,
  ): { output: string; viaPortIds: Set<string> } {
    const haystack = payload.toLowerCase();
    const match =
      routes.find(route => route.name.trim() && haystack.includes(route.name.trim().toLowerCase())) ??
      routes[0];
    return { output: payload, viaPortIds: new Set([match.id]) };
  }

  /**
   * Decide node: every authored question in ONE System One call (questions run
   * in parallel server-side, so adding one is nearly free), answers merged into
   * the payload under `resultKey` for downstream `router` / `assert` /
   * `transform` / prompt templates.
   */
  private async runDecide(node: WorkflowNode, payload: string, executionKey: string): Promise<string> {
    const data = (node.data ?? {}) as DecideNodeData;
    if (!this.options.decisions) throw this.missingCapability(node, 'decisions', 'ask System One');
    const built = buildDecisionQuestions(data.questions);
    if ('error' in built) throw new Error(`Step "${node.name}" cannot ask System One. ${built.error}`);

    const outcome = await this.evaluateDecision(node, 'decide', {
      payload,
      executionKey,
      tuning: data,
      questions: built.questions,
      fixtures: data.fixtures,
      retry: data.retry,
    });
    this.emitDecision(node, 'decide', outcome);
    const resultKey = (data.resultKey ?? '').trim() || 'decisions';
    return mergeDecisionAnswers(payload, resultKey, outcome.result.answers);
  }

  /**
   * Auto-resolve for an approval gate: one Noul whose YES means "safe to
   * approve". Confident answers settle the gate without a human; the band in
   * between falls through to the normal approval prompt. Returns `null` when
   * the gate should ask a human.
   */
  private async autoResolveApproval(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<{ approved: boolean; probability: number } | { probability: number } | null> {
    const data = (node.data ?? {}) as ApprovalGateNodeData;
    const auto = data.autoResolve;
    if (!auto?.enabled) return null;
    if (!this.options.decisions) throw this.missingCapability(node, 'decisions', 'auto-resolve approvals with System One');

    const question =
      (auto.question ?? '').trim() ||
      (data.message ?? '').trim() ||
      'Is this safe to approve without human review?';
    const yes = (auto.yes ?? '').trim();
    const no = (auto.no ?? '').trim();
    const outcome = await this.evaluateDecision(node, 'gate', {
      payload,
      executionKey,
      tuning: auto,
      questions: {
        approve: {
          type: 'noul',
          instructions: question,
          ...(yes || no ? { criteria: { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) } } : {}),
        },
      },
      fixtures: data.fixtures,
      retry: data.retry,
    });
    this.emitDecision(node, 'gate', outcome);
    const probability = (outcome.result.answers['approve'] as NoulAnswer | undefined)?.noul ?? 0.5;
    const approveAt = readThreshold(auto.approveAt, 0.9);
    const rejectAt = readThreshold(auto.rejectAt, 0.1);
    if (probability >= approveAt) return { approved: true, probability };
    if (probability <= rejectAt) return { approved: false, probability };
    return { probability };
  }

  private async runApprovalGate(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const data = node.data as ApprovalGateNodeData;
    const message =
      typeof data.message === 'string' && data.message.trim()
        ? data.message
        : `Approve the work arriving at "${node.name}"?`;
    const outs = node.ports.filter(port => port.role === 'message-out');

    const requestId = `approval:${executionKey}`;
    const verdict = await this.autoResolveApproval(node, payload, executionKey);
    if (verdict && 'approved' in verdict) {
      // Settled by System One: the trace records it as a resolution with the
      // `system-one` actor, and no human is ever prompted.
      this.emit({
        type: 'approval-resolved',
        runId: this.options.runId,
        requestId,
        nodeId: node.id,
        approved: verdict.approved,
        actor: DECISION_ACTOR,
        at: Date.now(),
      });
      const via = verdict.approved ? outs[0] : (outs[1] ?? outs[0]);
      return { output: payload, viaPortIds: via ? new Set([via.id]) : new Set() };
    }
    this.emit({
      type: 'approval-required',
      runId: this.options.runId,
      requestId,
      nodeId: node.id,
      message,
      payload,
      // The uncertain middle band: the human sees what System One thought.
      ...(verdict ? { decisionProbability: verdict.probability } : {}),
      at: Date.now(),
    });

    const approved = await this.options.requestApproval(node.id, message, payload, requestId);
    if (this.gate.stopped) throw new RunStoppedError();

    this.emit({
      type: 'approval-resolved',
      runId: this.options.runId,
      requestId,
      nodeId: node.id,
      approved,
      at: Date.now(),
    });

    // Route via the matching out port (Approved / Rejected by position:
    // first message-out port = approved, second = rejected).
    const via = approved ? outs[0] : (outs[1] ?? outs[0]);
    return { output: payload, viaPortIds: via ? new Set([via.id]) : new Set() };
  }

  /**
   * ForEach — iterates a JSON array, executing the loop-body subgraph once
   * per item. Port convention (by position, like the approval gate): first
   * message-out port = the body ("Each item"), second = "Done".
   *
   * Each item's body execution collects its terminal payloads into a
   * per-iteration sink; the Done port then receives an aggregate JSON
   * `{ results, exceptions }` document. A failing item is recorded as an
   * exception and the loop continues (unless `continueOnError` is false).
   *
   * Iterations run sequentially by default. Bounded concurrency is opt-in
   * and must be used with care: aggregators inside a loop body are keyed by
   * node id, so concurrent iterations sharing one would collide.
   *
   * Batch mode (`batchSize` an integer in 2..10000) changes exactly one thing:
   * item materialisation. `batchItems` regroups the source list into batches,
   * so one iteration carries an ARRAY of items and the loop reports the batch
   * count as `loop-started.total` and the batch as `loop-iteration.item`
   * (Requirements 9.8, 9.9, 9.11). Everything downstream — the body subgraph,
   * the results/exceptions aggregate, concurrency — is indexed by iteration and
   * needs no further change.
   */
  private async runForEach(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const data = node.data as ForEachNodeData;
    const source = extractItems(payload, data.itemsPath);
    if (!source) {
      throw new Error(
        `ForEach "${node.name}" needs a JSON array to iterate` +
          (data.itemsPath ? ` (items path "${data.itemsPath}")` : '') +
          '. The incoming payload does not contain one.',
      );
    }

    // One element per iteration: a single item, or a batch of items. An absent
    // or out-of-range `batchSize` returns `source` itself (Requirement 9.9).
    const items: readonly unknown[] = batchItems(source, data.batchSize);

    const outs = node.ports.filter(port => port.role === 'message-out');
    const bodyPort = outs[0];
    // With a single out port it serves as the body; the aggregate then has
    // nowhere to flow (terminal) rather than re-entering the body edge.
    const donePort = outs.length > 1 ? outs[1] : undefined;
    const continueOnError = data.continueOnError ?? true;
    const concurrency = Math.max(1, Math.min(data.concurrency ?? 1, 8));

    this.emit({
      type: 'loop-started',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      total: items.length,
      at: Date.now(),
    });

    const results: unknown[] = new Array(items.length).fill(null);
    const exceptions: { index: number; item: unknown; error: string }[] = [];

    const runItem = async (index: number): Promise<void> => {
      const item = items[index];
      const itemPayload = typeof item === 'string' ? item : JSON.stringify(item);
      this.emit({
        type: 'loop-iteration',
        runId: this.options.runId,
        nodeId: node.id,
        index,
        total: items.length,
        item: itemPayload.length > 500 ? `${itemPayload.slice(0, 500)}…` : itemPayload,
        at: Date.now(),
      });
      const sink: string[] = [];
      try {
        if (bodyPort) {
          await this.followHandoffs(node, itemPayload, new Set([bodyPort.id]), sink);
        } else {
          sink.push(itemPayload);
        }
        results[index] =
          sink.length === 0 ? null : sink.length === 1 ? tryParseJson(sink[0]) : sink.map(tryParseJson);
      } catch (error) {
        if (error instanceof RunStoppedError || !continueOnError) throw error;
        exceptions.push({
          index,
          item,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Bounded-concurrency worker pool over the item indices.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await runItem(index);
      }
    });
    await Promise.all(workers);

    this.emit({
      type: 'loop-completed',
      runId: this.options.runId,
      nodeId: node.id,
      total: items.length,
      succeeded: items.length - exceptions.length,
      failed: exceptions.length,
      at: Date.now(),
    });

    const output = JSON.stringify({ results, exceptions }, null, 2);
    return { output, viaPortIds: donePort ? new Set([donePort.id]) : new Set() };
  }

  /**
   * Wait for Event — suspends the run until the host delivers an external
   * event whose correlation key matches this node's rendered key (webhook
   * callback, e-sign completion, manual injection). The event's payload is
   * merged into the waiting payload (JSON objects shallow-merge).
   */
  private async runWaitEvent(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string }> {
    const data = node.data as WaitEventNodeData;
    const keyTemplate = data.correlationKey?.trim() || node.id;
    const correlationKey = this.render(keyTemplate, payload);
    const timeoutMs =
      typeof data.timeoutHours === 'number' && data.timeoutHours > 0
        ? Math.round(data.timeoutHours * 3_600_000)
        : undefined;
    const message =
      typeof data.message === 'string' && data.message.trim()
        ? data.message
        : `Waiting for external event "${correlationKey}".`;

    if (!this.options.waitForEvent) {
      throw new Error(
        `"${node.name}" waits for an external event, but this host cannot deliver events. ` +
          'Deploy the workflow to the cloud or run it from the studio.',
      );
    }

    this.emit({
      type: 'wait-started',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      correlationKey,
      message,
      payload,
      at: Date.now(),
    });

    const eventPayload = await this.options.waitForEvent(
      node.id,
      correlationKey,
      message,
      payload,
      timeoutMs,
    );
    if (this.gate.stopped) throw new RunStoppedError();

    this.emit({
      type: 'wait-resolved',
      runId: this.options.runId,
      nodeId: node.id,
      correlationKey,
      eventPayload,
      at: Date.now(),
    });

    return { output: mergePayloads(payload, eventPayload) };
  }

  /**
   * Ask User — suspends the run and surfaces a question to a human. The
   * user's free-text response is merged into the waiting payload under the
   * node's `responseKey` (default `userResponse`) so the downstream agent
   * receives `{...original, userResponse: '...'}`.
   */
  private async runAskUser(
    node: WorkflowNode,
    payload: string,
    executionKey: string,
  ): Promise<{ output: string }> {
    const data = node.data as AskUserNodeData;
    const responseKey = data.responseKey?.trim() || 'userResponse';
    const questionTemplate = data.question?.trim() || '';
    const question = questionTemplate
      ? this.render(questionTemplate, payload)
      : payload;
    const requestId = `ask:${executionKey}`;

    this.emit({
      type: 'ask-required',
      runId: this.options.runId,
      requestId,
      nodeId: node.id,
      nodeName: node.name,
      question,
      payload,
      at: Date.now(),
    });

    const response = await this.options.requestInput(node.id, question, payload, requestId);
    if (this.gate.stopped) throw new RunStoppedError();

    this.emit({
      type: 'ask-resolved',
      runId: this.options.runId,
      requestId,
      nodeId: node.id,
      response,
      at: Date.now(),
    });

    return { output: mergePayloads(payload, JSON.stringify({ [responseKey]: response })) };
  }

  /**
   * Execute Workflow opens a child interpreter frame inside this run. The
   * child shares the gate, callbacks, model/tool hosts, timeout, journal,
   * and global execution counter. Only its graph, terminal sink, aggregation
   * state, scope path, and journal namespace are frame-local.
   */
  private async runSubWorkflow(
    node: WorkflowNode,
    payload: string,
    frameId: string,
  ): Promise<string> {
    const data = node.data as ExecuteWorkflowNodeData;
    const workflowId = data.workflowId?.trim();
    if (!workflowId) {
      throw new Error(`Execute Workflow "${node.name}" has no target workflow configured.`);
    }

    const resolved =
      this.options.resolveWorkflow?.(workflowId) ?? this.options.subWorkflows?.[workflowId];
    const workflowName = resolved?.name || data.workflowName?.trim() || workflowId;
    if (!resolved) {
      throw new Error(
        `Execute Workflow "${node.name}" could not resolve workflow "${workflowName}" (${workflowId}).`,
      );
    }

    const depth = this.scope.length + 1;
    const configuredLimit = this.options.maxSubWorkflowDepth ?? DEFAULT_MAX_SUB_WORKFLOW_DEPTH;
    const numericLimit = Number.isNaN(configuredLimit)
      ? DEFAULT_MAX_SUB_WORKFLOW_DEPTH
      : Math.floor(configuredLimit);
    const maxDepth = Math.max(0, Math.min(numericLimit, MAX_SUB_WORKFLOW_DEPTH));
    if (depth > maxDepth) {
      throw new Error(
        `Sub-workflow depth limit (${maxDepth}) reached while executing "${workflowName}". ` +
          'Reduce recursive nesting or use a plan with a higher limit.',
      );
    }

    this.emit({
      type: 'subworkflow-started',
      runId: this.options.runId,
      nodeId: node.id,
      nodeName: node.name,
      workflowId: resolved.id,
      workflowName,
      depth,
      input: payload,
      at: Date.now(),
    });

    const childScope = [
      ...this.scope,
      { nodeId: node.id, workflowId: resolved.id, workflowName, frameId, depth },
    ];
    const child = new WorkflowRun(
      { ...this.options, graph: resolved.graph, startNodeId: undefined,
        // A child frame reads ITS OWN workflow's variables, never the parent's:
        // a sub-workflow is a reusable unit whose settings travel with it.
        variables: resolveWorkflowVariables(resolved.settings) },
      this.gate,
      {
        scope: childScope,
        journalPrefix: `${frameId}/`,
      },
      this.executionState,
      this.syncState,
    );

    try {
      const output = await child.executeFrame(payload);
      this.emit({
        type: 'subworkflow-completed',
        runId: this.options.runId,
        nodeId: node.id,
        nodeName: node.name,
        workflowId: resolved.id,
        workflowName,
        depth,
        output,
        at: Date.now(),
      });
      return output;
    } catch (error) {
      if (error instanceof RunStoppedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'subworkflow-failed',
        runId: this.options.runId,
        nodeId: node.id,
        nodeName: node.name,
        workflowId: resolved.id,
        workflowName,
        depth,
        error: message,
        at: Date.now(),
      });
      throw error;
    }
  }

  // ── Flow ───────────────────────────────────────────────────────────────────

  /**
   * Follows outgoing handoffs (optionally restricted to given out ports).
   * `sink` collects terminal payloads for an enclosing ForEach iteration;
   * absent at the top level, where terminals feed the run's final output.
   */
  private async followHandoffs(
    node: WorkflowNode,
    payload: string,
    viaPortIds?: Set<string>,
    sink?: string[],
  ): Promise<void> {
    const outgoing = this.options.graph.connections.filter(conn => {
      if (conn.kind !== 'handoff') return false;
      const sourceBase = portBaseId(conn.outputId);
      if (!node.ports.some(port => port.id === sourceBase)) return false;
      return viaPortIds ? viaPortIds.has(sourceBase) : true;
    });

    if (outgoing.length === 0) {
      // Terminal node — its payload joins the enclosing loop iteration's
      // results, or the run's final output at the top level.
      if (payload) (sink ?? this.terminalOutputs).push(payload);
      return;
    }

    // Fan out concurrently; the shared gate keeps debugger semantics intact.
    await Promise.all(outgoing.map(conn => this.deliver(conn, node, payload, sink)));
  }

  /** Delivers a payload across one connection, emitting the handoff event. */
  private async deliver(
    connection: WorkflowConnection,
    from: WorkflowNode,
    payload: string,
    sink?: string[],
  ): Promise<void> {
    const target = nodeForConnector(this.options.graph, connection.inputId);
    if (!target) return;

    this.emit({
      type: 'handoff',
      runId: this.options.runId,
      connectionId: connection.id,
      fromNodeId: from.id,
      toNodeId: target.id,
      payload,
      at: Date.now(),
    });

    if (target.kind === 'aggregator') {
      const complete = this.collectAggregation(target, connection, payload);
      if (!complete) return; // still waiting on sibling branches
      const merged = this.mergedAggregation(target);
      this.aggregations.delete(target.id);
      await this.executeNode(target, merged, sink);
      return;
    }

    await this.executeNode(target, payload, sink);
  }

  /** Records an aggregator arrival; true when every connected input has one. */
  private collectAggregation(
    aggregator: WorkflowNode,
    connection: WorkflowConnection,
    payload: string,
  ): boolean {
    let collected = this.aggregations.get(aggregator.id);
    if (!collected) {
      collected = new Map<string, string>();
      this.aggregations.set(aggregator.id, collected);
    }
    collected.set(portBaseId(connection.inputId), payload);

    const connectedInputs = new Set(
      this.options.graph.connections
        .filter(conn => {
          if (conn.kind !== 'handoff') return false;
          const base = portBaseId(conn.inputId);
          return aggregator.ports.some(port => port.id === base && port.role === 'message-in');
        })
        .map(conn => portBaseId(conn.inputId)),
    );
    return [...connectedInputs].every(portId => collected.has(portId));
  }

  private mergedAggregation(aggregator: WorkflowNode): string {
    const collected = this.aggregations.get(aggregator.id);
    if (!collected) return '';
    const sections: string[] = [];
    for (const port of aggregator.ports) {
      const value = collected.get(port.id);
      if (value !== undefined) {
        sections.push(`## ${port.name}\n\n${value}`);
      }
    }
    return sections.join('\n\n');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private attachedTools(node: WorkflowNode): WorkflowNode[] {
    const toolsPortIds = new Set(
      node.ports.filter(port => port.role === 'tools').map(port => port.id),
    );
    return this.options.graph.connections
      .filter(conn => conn.kind === 'tool-link' && toolsPortIds.has(portBaseId(conn.outputId)))
      .flatMap(conn => {
        const target = nodeForConnector(this.options.graph, conn.inputId);
        return target ? [target] : [];
      });
  }

  private handoffTargets(node: WorkflowNode): WorkflowNode[] {
    const outIds = new Set(
      node.ports.filter(port => port.role === 'message-out').map(port => port.id),
    );
    return this.options.graph.connections
      .filter(conn => conn.kind === 'handoff' && outIds.has(portBaseId(conn.outputId)))
      .flatMap(conn => {
        const target = nodeForConnector(this.options.graph, conn.inputId);
        return target ? [target] : [];
      });
  }

  private emit(event: RunEvent): void {
    // Accumulate before forwarding, so every emitted event is already folded
    // into the summary by the time the terminal `sync-summary` goes out.
    accumulateSync(event, this.syncState.summary);
    try {
      this.options.emit(this.scope.length > 0 ? { ...event, scope: [...this.scope] } : event);
    } catch {
      // Event sinks must never break a run.
    }
  }

  /**
   * Emits the run's `sync-summary` exactly once, immediately before the
   * terminal event, and only when the run executed a data node. Agent-only
   * runs emit nothing here, which is what keeps their history unchanged.
   */
  private emitSyncSummary(): void {
    if (!this.syncState.dataNodeExecuted || this.syncState.emitted) return;
    this.syncState.emitted = true;
    this.emit({
      type: 'sync-summary',
      runId: this.options.runId,
      summary: this.syncState.summary,
      at: Date.now(),
    });
  }
}

/**
 * The payload as JSON for an expression context, or `undefined` when it is not
 * JSON at all — which is exactly what `EvalContext.$` means, so `$.a.b` resolves
 * to null instead of faulting.
 */
function parseJsonPayload(payload: string): Json | undefined {
  try {
    return JSON.parse(payload) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Whether an assertion result counts as holding: everything except `false`,
 * `null`, `0` and the empty string (Requirement 7.1). An empty array or object
 * holds — emptiness is what the guard's own expression is there to test.
 */
function assertionHolds(value: Json): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

/** Names the kind of a value a SQL parameter cannot bind, for the failure message. */
function describeJsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === undefined) return 'no value';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'number') return 'a value that is not a finite number';
  return `a ${typeof value}`;
}

/**
 * The delivery endpoint a connection declares, read from the non-secret config
 * only: an explicit `notifyUrl`, otherwise `baseUrl` optionally joined with a
 * `notifyPath`. Empty when the connection declares neither.
 */
function notifyConnectionEndpoint(conn: ResolvedConnection | undefined): string {
  if (!conn) return '';
  const config = conn.config ?? {};
  const explicit = (config['notifyUrl'] ?? '').trim();
  if (explicit.length > 0) return explicit;
  const baseUrl = (config['baseUrl'] ?? '').trim();
  if (baseUrl.length === 0) return '';
  const path = (config['notifyPath'] ?? '').trim();
  return path.length > 0 ? joinUrl(baseUrl, path) : baseUrl;
}

/**
 * The target as `notify-sent` reports it: enough to tell two recipients apart,
 * never enough to reconstruct one (Requirement 13.4).
 *
 * An email keeps its first local character and its domain; a url keeps its
 * origin and masks the rest, because a hook url's path IS the credential for
 * every chat provider worth naming. Anything else is masked the same way an
 * email local part is.
 */
function maskNotifyTarget(target: string): string {
  const value = target.trim();
  if (value.length === 0) return '';

  const at = value.lastIndexOf('@');
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at);
    return `${local.slice(0, 1)}***${value.slice(at)}`;
  }

  const url = /^(https?:\/\/[^/?#]+)([/?#].*)?$/i.exec(value);
  if (url) {
    const origin = url[1] ?? value;
    const rest = url[2] ?? '';
    return rest.length === 0 || rest === '/' ? origin : `${origin}/***`;
  }

  return value.length <= 1 ? '***' : `${value.slice(0, 1)}***`;
}

/** Names the kind of a value that cannot serve as a watermark, for the failure message. */
function describeWatermarkKind(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'string') return 'an empty string';
  return 'a value that is not a finite number';
}

/** Parses a string as JSON when possible; otherwise returns it unchanged. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}


/**
 * Strips one surrounding markdown code fence (```json ... ```) from a reply.
 * Models often fence JSON even when told not to.
 */
function stripCodeFence(text: string): string {
  const match = /^\s*```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? match[1]! : text;
}

/**
 * An agent reply read as JSON for `AgentNodeData.resultKey`: the whole reply
 * (fence stripped), else the first balanced `{...}` or `[...]` that parses,
 * else the raw text. Never throws.
 */
export function parseReplyJson(reply: string): unknown {
  const stripped = stripCodeFence(reply).trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to the embedded search.
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = stripped.indexOf(open);
    if (start < 0) continue;
    for (let end = stripped.lastIndexOf(close); end > start; end = stripped.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        // Keep shrinking.
      }
    }
  }
  return reply;
}
