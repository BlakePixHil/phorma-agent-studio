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
 *    match → first route. Pair one with a Classifier agent for LLM routing.
 *  - Parallel fans the payload out to every branch concurrently.
 *  - Aggregators wait for every CONNECTED input, then merge as markdown.
 *  - Approval gates suspend until the studio resolves them.
 *  - Cycles are permitted but bounded by an execution budget.
 */

import type { RunEvent, RunEventSink } from './events.js';
import type { RunSource } from './run-record.js';
import { RunGate, RunStoppedError } from './gate.js';
import {
  isTransientModelError,
  type ChatMessage,
  type ModelClient,
  type ToolCall,
} from './model.js';
import { extractItems, interpolatePayload, mergePayloads } from './payload.js';
import { resolveAgentTools, type ResolvedTool, type ToolHost } from './tools.js';
import {
  isAgentNode,
  nodeForConnector,
  portBaseId,
  type AgentNodeData,
  type ForEachNodeData,
  type ModelProviderId,
  type WaitEventNodeData,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from './types.js';

/** Default safety budget: total node executions per run (cycles are allowed, runaway loops are not). */
const MAX_NODE_EXECUTIONS = 100;
/** Default maximum model→tools→model rounds per agent execution. */
const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** Default retry policy: one automatic retry for transient model failures. */
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
/** Extra execution budget granted to the workflow error handler's subtree. */
const ERROR_HANDLER_BUDGET_BONUS = 25;
/** Context window assumed when no lookup is available for a model. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Fraction of the context window that triggers compression. */
const COMPRESSION_THRESHOLD = 0.8;
/** Complete tool rounds kept verbatim when compressing (pairs of messages). */
const COMPRESSION_KEEP_TAIL_PAIRS = 2;
/** Character cap for the transcript handed to the summarizer. */
const COMPRESSION_TRANSCRIPT_MAX_CHARS = 24_000;

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
   * wires it to a webhook/WebSocket reply.
   */
  requestApproval(nodeId: string, message: string, payload: string): Promise<boolean>;
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
 * Object eviction while suspended on approvals or external events.
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

const TRIGGER_KINDS = new Set(['manual-trigger', 'schedule-trigger', 'webhook-trigger']);
const TOOL_KINDS = new Set(['http-tool', 'web-search-tool', 'mcp-tool']);

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
  private executions = 0;
  /** Collected inputs per aggregator node id (port base id → payload). */
  private readonly aggregations = new Map<string, Map<string, string>>();
  /** Terminal outputs (payloads that reached nodes with no outgoing handoff). */
  private readonly terminalOutputs: string[] = [];
  /** Effective node-execution budget for this run. */
  private maxExecutions: number;
  /** Occurrence counters per (node, payload-hash) for journal keys. */
  private readonly journalCounts = new Map<string, number>();
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
  ) {
    this.maxExecutions = Math.max(1, options.maxExecutions ?? MAX_NODE_EXECUTIONS);
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
      // A workflow-level Error Handler node (when present) gets one shot at
      // the failure — notifications, cleanup, escalation — before the run
      // settles as failed. Its own failures never mask the original error.
      await this.runErrorHandler(message);
      this.emit({ type: 'run-failed', runId, error: message, at: Date.now() });
    } finally {
      this.disarmWorkflowTimeout();
    }
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
    this.maxExecutions = this.executions + ERROR_HANDLER_BUDGET_BONUS;
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

  /** Deterministic journal key for this execution of `node` with `payload`. */
  private nextJournalKey(node: WorkflowNode, payload: string): string {
    const base = `${node.id}|${fnv1a(payload)}`;
    const occurrence = this.journalCounts.get(base) ?? 0;
    this.journalCounts.set(base, occurrence + 1);
    return `${base}|${occurrence}`;
  }

  /**
   * Executes one node and recursively follows its outgoing handoffs.
   * `sink` collects terminal payloads for the innermost enclosing ForEach
   * (absent at the run's top level, where terminals feed the final output).
   */
  private async executeNode(node: WorkflowNode, payload: string, sink?: string[]): Promise<void> {
    await this.gate.checkpoint(node.id);

    this.executions += 1;
    if (this.executions > this.maxExecutions) {
      throw new Error(
        `Run exceeded the execution budget (${this.maxExecutions} node executions). ` +
          'Check the workflow for an unbounded loop, or raise the budget for batch runs.',
      );
    }

    const { runId, journal } = this.options;
    this.emit({ type: 'node-started', runId, nodeId: node.id, nodeName: node.name, at: Date.now() });

    // Replay: a journaled result short-circuits the node body entirely —
    // no model/tool calls, no approval prompts, no waits. The occurrence
    // counter keeps repeated executions of the same node+payload distinct.
    const journalKey = journal ? this.nextJournalKey(node, payload) : null;
    if (journal && journalKey) {
      const cached = journal.lookup(journalKey);
      if (cached) {
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
        result = await this.runNodeBody(node, payload, sink);
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
    if (!isAgentNode(node)) return null;
    const errorPortId = (node.data as AgentNodeData).errorPortId;
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
  ): Promise<{ output: string; viaPortIds?: Set<string> } | null> {
    if (TRIGGER_KINDS.has(node.kind)) {
      return { output: payload };
    }

    if (isAgentNode(node)) {
      const output = await this.runAgent(node, payload);
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
        return this.runRouter(node, payload);
      case 'parallel':
        return { output: payload }; // fan-out happens in followHandoffs
      case 'aggregator':
        // Aggregation is keyed by which in-port received the payload — handled
        // by the caller (deliverTo) before executeNode; this path only runs
        // when all inputs have arrived (see followHandoffs).
        return { output: payload };
      case 'approval-gate':
        return this.runApprovalGate(node, payload);
      case 'for-each':
        return this.runForEach(node, payload);
      case 'wait-event':
        return this.runWaitEvent(node, payload);
      default:
        if (TOOL_KINDS.has(node.kind)) {
          // Tool nodes are capabilities, not flow steps. Reaching one via a
          // handoff is a wiring mistake; pass the payload through unchanged.
          return { output: payload };
        }
        return { output: payload };
    }
  }

  // ── Node behaviours ────────────────────────────────────────────────────────

  private async runAgent(node: WorkflowNode, payload: string): Promise<string> {
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
    const resolved: ResolvedTool[] =
      this.options.tools && toolNodes.length > 0
        ? await resolveAgentTools(toolNodes, this.options.tools)
        : [];
    const byWireName = new Map(resolved.map(tool => [tool.definition.name, tool]));

    const system = this.renderPrompt(data.prompt, payload, node, resolved.length > 0);
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
    const streamRound = async (): Promise<{ roundText: string; calls: ToolCall[] }> => {
      let roundText = '';
      const calls: ToolCall[] = [];
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
        }
      }
      return { roundText, calls };
    };

    /** One round with retries, then (once) the fallback model with retries. */
    const streamRoundRobustly = async (): Promise<{ roundText: string; calls: ToolCall[] }> => {
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

    const maxToolRounds = this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
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

      const { roundText, calls } = await streamRoundRobustly();

      output += (output && roundText ? '\n' : '') + roundText;
      if (calls.length === 0) break;

      // Execute the requested tools, then hand the results back to the model.
      messages.push({ role: 'assistant-tool-calls', text: roundText || undefined, calls });
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

    // Cap tool output so a huge response can't blow the context window.
    if (result.length > 8000) result = `${result.slice(0, 8000)}\n…(truncated)`;

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
   * Renders the agent's markdown prompt: interpolates `{{input}}` and appends
   * a capabilities section describing attached tools and handoff targets so
   * the model knows its place in the workflow.
   */
  private renderPrompt(
    template: string,
    payload: string,
    node: WorkflowNode,
    toolsCallable: boolean,
  ): string {
    // `{{input}}` interpolates the whole payload; `{{a.b.c}}` digs into it
    // when the payload parses as JSON (structured handoffs).
    let prompt = interpolatePayload(template, payload);

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

  private runRouter(
    node: WorkflowNode,
    payload: string,
  ): { output: string; viaPortIds: Set<string> } {
    const routes = node.ports.filter(port => port.role === 'message-out');
    if (routes.length === 0) return { output: payload, viaPortIds: new Set() };

    const haystack = payload.toLowerCase();
    const match =
      routes.find(route => route.name.trim() && haystack.includes(route.name.trim().toLowerCase())) ??
      routes[0];
    return { output: payload, viaPortIds: new Set([match.id]) };
  }

  private async runApprovalGate(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const data = node.data as { message?: string };
    const message =
      typeof data.message === 'string' && data.message.trim()
        ? data.message
        : `Approve the work arriving at "${node.name}"?`;

    this.emit({
      type: 'approval-required',
      runId: this.options.runId,
      nodeId: node.id,
      message,
      payload,
      at: Date.now(),
    });

    const approved = await this.options.requestApproval(node.id, message, payload);
    if (this.gate.stopped) throw new RunStoppedError();

    this.emit({
      type: 'approval-resolved',
      runId: this.options.runId,
      nodeId: node.id,
      approved,
      at: Date.now(),
    });

    // Route via the matching out port (Approved / Rejected by position:
    // first message-out port = approved, second = rejected).
    const outs = node.ports.filter(port => port.role === 'message-out');
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
   */
  private async runForEach(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string; viaPortIds: Set<string> }> {
    const data = node.data as ForEachNodeData;
    const items = extractItems(payload, data.itemsPath);
    if (!items) {
      throw new Error(
        `ForEach "${node.name}" needs a JSON array to iterate` +
          (data.itemsPath ? ` (items path "${data.itemsPath}")` : '') +
          '. The incoming payload does not contain one.',
      );
    }

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
    const correlationKey = interpolatePayload(keyTemplate, payload);
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
    try {
      this.options.emit(event);
    } catch {
      // Event sinks must never break a run.
    }
  }
}

/** Parses a string as JSON when possible; otherwise returns it unchanged. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
