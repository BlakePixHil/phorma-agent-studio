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
import { RunGate, RunStoppedError } from './gate.js';
import type { ModelClient, ChatMessage, ToolCall } from './model.js';
import { resolveAgentTools, type ResolvedTool, type ToolHost } from './tools.js';
import {
  isAgentNode,
  nodeForConnector,
  portBaseId,
  type ModelProviderId,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from './types.js';

/** Safety budget: total node executions per run (cycles are allowed, runaway loops are not). */
const MAX_NODE_EXECUTIONS = 100;
/** Default maximum model→tools→model rounds per agent execution. */
const DEFAULT_MAX_TOOL_ROUNDS = 8;

export interface RunOptions {
  runId: string;
  graph: WorkflowGraph;
  /** The task handed to the trigger. */
  input: string;
  /** Node to start from; defaults to the first trigger (any kind). */
  startNodeId?: string;
  model: ModelClient;
  emit: RunEventSink;
  /** Ollama server override, forwarded to model requests. */
  ollamaBaseUrl?: string;
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

  constructor(
    private readonly options: RunOptions,
    private readonly gate: RunGate,
  ) {
    gate.onPauseChange = (paused, nodeId) => {
      this.emit(
        paused
          ? { type: 'run-paused', runId: options.runId, nodeId, at: Date.now() }
          : { type: 'run-resumed', runId: options.runId, at: Date.now() },
      );
    };
  }

  async execute(): Promise<void> {
    const { runId, graph, input } = this.options;
    this.emit({ type: 'run-started', runId, input, at: Date.now() });

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

    try {
      await this.executeNode(start, input);
      this.emit({
        type: 'run-completed',
        runId,
        output: this.terminalOutputs.join('\n\n---\n\n'),
        at: Date.now(),
      });
    } catch (error) {
      if (error instanceof RunStoppedError) {
        this.emit({ type: 'run-stopped', runId, at: Date.now() });
        return;
      }
      this.emit({
        type: 'run-failed',
        runId,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
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

  /** Executes one node and recursively follows its outgoing handoffs. */
  private async executeNode(node: WorkflowNode, payload: string): Promise<void> {
    await this.gate.checkpoint(node.id);

    this.executions += 1;
    if (this.executions > MAX_NODE_EXECUTIONS) {
      throw new Error(
        `Run exceeded the execution budget (${MAX_NODE_EXECUTIONS} node executions). ` +
          'Check the workflow for an unbounded loop.',
      );
    }

    const { runId } = this.options;
    this.emit({ type: 'node-started', runId, nodeId: node.id, nodeName: node.name, at: Date.now() });

    try {
      const result = await this.runNodeBody(node, payload);
      // Aggregators return null until every input has arrived.
      if (result === null) return;

      this.emit({
        type: 'node-completed',
        runId,
        nodeId: node.id,
        nodeName: node.name,
        output: result.output,
        at: Date.now(),
      });

      await this.followHandoffs(node, result.output, result.viaPortIds);
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
   * Runs a node's behaviour. Returns the outgoing payload and (optionally)
   * the subset of out ports to follow; null when the node is still waiting
   * (aggregator collecting inputs).
   */
  private async runNodeBody(
    node: WorkflowNode,
    payload: string,
  ): Promise<{ output: string; viaPortIds?: Set<string> } | null> {
    if (TRIGGER_KINDS.has(node.kind)) {
      return { output: payload };
    }

    if (isAgentNode(node)) {
      return { output: await this.runAgent(node, payload) };
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
    const data = node.data as {
      prompt: string;
      provider?: 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'bedrock';
      model?: string;
      /** Per-node AWS region override for Amazon Bedrock agents. */
      region?: string;
      temperature?: number;
      maxTokens?: number;
    };

    // Resolve the model: explicit node config wins; otherwise inherit the
    // run's default model (the studio's application settings).
    const fallback = this.options.defaultModel;
    const provider: ModelProviderId | undefined = data.provider ?? fallback?.provider;
    const model = data.provider ? data.model : (data.model ?? fallback?.model);
    if (!provider || !model) {
      throw new Error(
        `Agent "${node.name}" has no model configured and no application default model is set. ` +
          'Pick a model on the node or set a default in Settings → Models.',
      );
    }
    const temperature = data.temperature ?? (data.provider ? undefined : fallback?.temperature);

    // Resolve callable tools from the agent's tool-link edges.
    const toolNodes = this.attachedTools(node);
    const resolved: ResolvedTool[] =
      this.options.tools && toolNodes.length > 0
        ? await resolveAgentTools(toolNodes, this.options.tools)
        : [];
    const byWireName = new Map(resolved.map(tool => [tool.definition.name, tool]));

    const system = this.renderPrompt(data.prompt, payload, node, resolved.length > 0);
    const messages: ChatMessage[] = [{ role: 'user', content: payload || 'Begin.' }];
    let output = '';

    const maxToolRounds = this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    for (let round = 0; round < maxToolRounds; round++) {
      let roundText = '';
      const calls: ToolCall[] = [];

      for await (const chunk of this.options.model.stream({
        provider,
        model,
        system,
        messages,
        tools: resolved.map(tool => tool.definition),
        temperature,
        maxTokens: data.maxTokens,
        ollamaBaseUrl: this.options.ollamaBaseUrl,
        // Per-node region wins; otherwise the run's default Bedrock region.
        bedrockRegion: data.region ?? this.options.bedrockRegion,
      })) {
        if (this.gate.stopped) throw new RunStoppedError();
        if (chunk.type === 'text') {
          roundText += chunk.text;
          this.emit({ type: 'node-token', runId: this.options.runId, nodeId: node.id, token: chunk.text });
        } else if (chunk.type === 'thinking') {
          // Reasoning tokens are surfaced for the thinking overlay but never
          // accumulated into `roundText`/`output` — they must not leak into
          // handoffs or the final answer.
          this.emit({ type: 'node-thinking', runId: this.options.runId, nodeId: node.id, token: chunk.text });
        } else if (chunk.type === 'usage') {
          // One usage event per model round; consumers sum rounds per node.
          this.emit({
            type: 'node-usage',
            runId: this.options.runId,
            nodeId: node.id,
            provider,
            usage: chunk.usage,
            at: Date.now(),
          });
        } else if (chunk.type === 'tool-call') {
          calls.push(chunk.call);
        }
      }

      output += (output && roundText ? '\n' : '') + roundText;
      if (calls.length === 0) break;

      // Execute the requested tools, then hand the results back to the model.
      messages.push({ role: 'assistant-tool-calls', text: roundText || undefined, calls });
      const results: { id: string; name: string; content: string }[] = [];
      for (const call of calls) {
        if (this.gate.stopped) throw new RunStoppedError();
        const content = await this.executeToolCall(node, call, byWireName);
        results.push({ id: call.id, name: call.name, content });
      }
      messages.push({ role: 'tool-results', results });
    }

    return output.trim();
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
    let prompt = template.split('{{input}}').join(payload || '(no input provided)');

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

  // ── Flow ───────────────────────────────────────────────────────────────────

  /** Follows outgoing handoffs (optionally restricted to given out ports). */
  private async followHandoffs(
    node: WorkflowNode,
    payload: string,
    viaPortIds?: Set<string>,
  ): Promise<void> {
    const outgoing = this.options.graph.connections.filter(conn => {
      if (conn.kind !== 'handoff') return false;
      const sourceBase = portBaseId(conn.outputId);
      if (!node.ports.some(port => port.id === sourceBase)) return false;
      return viaPortIds ? viaPortIds.has(sourceBase) : true;
    });

    if (outgoing.length === 0) {
      // Terminal node — its payload is part of the run's final output.
      if (payload) this.terminalOutputs.push(payload);
      return;
    }

    // Fan out concurrently; the shared gate keeps debugger semantics intact.
    await Promise.all(outgoing.map(conn => this.deliver(conn, node, payload)));
  }

  /** Delivers a payload across one connection, emitting the handoff event. */
  private async deliver(
    connection: WorkflowConnection,
    from: WorkflowNode,
    payload: string,
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
      await this.executeNode(target, merged);
      return;
    }

    await this.executeNode(target, payload);
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
