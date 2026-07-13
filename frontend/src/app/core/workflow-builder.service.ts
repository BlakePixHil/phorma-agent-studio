import { Injectable, inject, signal } from '@angular/core';

import type { ChatMessage, ModelRequest, ToolCall, ToolDefinition } from '@phorma/engine';

import { AgentStreamService } from './agent-stream.service';
import { AiEditSessionService } from './ai-edit-session.service';
import { CanvasStateService } from './canvas-state.service';
import type { BuilderMode } from './command-palette.service';
import { LocalAgentRouterService } from './local-agent-router.service';
import { ModelTransportService } from './model-transport.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { WorkflowService } from './workflow.service';
import { buildAgentSystemPrompt, buildPlanSystemPrompt } from './workflow-builder-prompt';
import { findCatalogEntry } from './node-catalog';
import { isAgentNode, type GraphPosition, type WorkflowGraph } from './workflow.model';

/**
 * The curated Phorma Cloud model that powers the workflow builder. Full
 * OpenRouter slug, billed against the tenant's subscription credits through
 * the /api/infer proxy. Deliberately a constant — one strong default keeps
 * the palette zero-config; revisit if a Settings knob is ever warranted.
 */
export const BUILDER_MODEL = 'anthropic/claude-sonnet-5';

/** Max LLM round-trips in Agent mode before the loop is cut off. */
const MAX_AGENT_ROUNDS = 12;

/** Delay between applied ops in Plan mode — the "watch it build" cadence. */
const PLAN_APPLY_DELAY_MS = 220;

/** Column/row spacing for placeholder placement next to existing content. */
const PLACE_COLUMN_WIDTH = 280;
const PLACE_ROW_HEIGHT = 180;
/** Nodes per column when cascading new nodes beside existing content. */
const PLACE_ROWS_PER_COLUMN = 4;

export type BuilderStatus = 'idle' | 'thinking' | 'applying' | 'done' | 'error';

/** One operation in a Plan-mode edit plan (the model's JSON output). */
interface PlanOp {
  op: 'add' | 'connect' | 'update' | 'remove' | 'disconnect';
  // add
  ref?: string;
  type?: string;
  name?: string;
  prompt?: string;
  // connect
  from?: string;
  to?: string;
  fromPort?: string;
  toPort?: string;
  // update / remove
  node?: string;
  // disconnect
  connection?: string;
}

interface EditPlan {
  summary?: string;
  ops: PlanOp[];
}

/**
 * Runs the AI workflow builder: turns a natural-language request into graph
 * edits on the active canvas, in one of two modes:
 *
 * - **Plan** — a single model call emits a complete JSON edit plan, which is
 *   validated and then played back op-by-op with the canvas glow (atomic
 *   feel, cheapest, most robust).
 * - **Agent** — a live tool loop: the model calls graph tools round by round
 *   and the canvas updates as it works (most agentic, more round trips).
 *
 * Both modes run inside an {@link AiEditSessionService} transaction so the
 * whole edit can be reverted, and both bill through the Phorma Cloud
 * /api/infer proxy (subscription-gated server-side; also gated here in UI).
 */
@Injectable({ providedIn: 'root' })
export class WorkflowBuilderService {
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly transport = inject(ModelTransportService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly session = inject(AiEditSessionService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly canvasState = inject(CanvasStateService);

  readonly status = signal<BuilderStatus>('idle');
  /** Plan-mode playback progress (null outside of applying). */
  readonly progress = signal<{ applied: number; total: number } | null>(null);
  /** Human-readable error from the last run (null when ok). */
  readonly error = signal<string | null>(null);
  /** True when the last failure was a credits/subscription 402 — drives upsell. */
  readonly creditsExhausted = signal(false);
  /** The model's one-line summary of what it built. */
  readonly summary = signal<string | null>(null);

  private cancelled = false;

  get running(): boolean {
    const status = this.status();
    return status === 'thinking' || status === 'applying';
  }

  /** Requests cancellation of the in-flight build (checked between steps). */
  cancel(): void {
    this.cancelled = true;
  }

  /** Resets transient result state (called when the palette reopens). */
  reset(): void {
    if (this.running) return;
    this.status.set('idle');
    this.error.set(null);
    this.summary.set(null);
    this.progress.set(null);
  }

  /** Builds the user's request onto the active canvas. */
  async run(request: string, mode: BuilderMode): Promise<void> {
    if (this.running) return;
    const trimmed = request.trim();
    if (!trimmed) return;

    this.cancelled = false;
    this.error.set(null);
    this.summary.set(null);
    this.creditsExhausted.set(false);
    this.progress.set(null);
    this.status.set('thinking');

    const graphBefore = this.workflow.graph();
    this.session.begin(trimmed);

    try {
      if (mode === 'plan') {
        await this.runPlanMode(trimmed, graphBefore);
      } else {
        await this.runAgentMode(trimmed, graphBefore);
      }
      this.session.commit();
      this.status.set(this.cancelled ? 'idle' : 'done');
    } catch (err) {
      // A failed build must not leave a half-applied graph behind.
      this.session.rollbackActive();
      const message = err instanceof Error ? err.message : String(err);
      this.creditsExhausted.set(/\(402\)|credits exhausted|subscription/i.test(message));
      this.error.set(message);
      this.status.set('error');
    } finally {
      this.progress.set(null);
      this.agentStream.clearAll();
      // Refresh the quota after the metering write lands server-side.
      setTimeout(() => void this.phormaCloud.refresh(), 1500);
    }
  }

  // ── Plan mode ──────────────────────────────────────────────────────────────

  private async runPlanMode(request: string, graphBefore: WorkflowGraph): Promise<void> {
    const modelRequest: ModelRequest = {
      provider: 'phorma-cloud',
      model: BUILDER_MODEL,
      system: buildPlanSystemPrompt(graphBefore),
      messages: [{ role: 'user', content: request }],
      temperature: 0.2,
      maxTokens: 8192,
    };

    let text = '';
    for await (const chunk of this.transport.create().stream(modelRequest)) {
      if (this.cancelled) return;
      if (chunk.type === 'text') text += chunk.text;
    }
    if (this.cancelled) return;

    const plan = this.parsePlan(text);
    if (plan.ops.length === 0) {
      this.summary.set(plan.summary ?? 'No changes needed.');
      return;
    }

    this.status.set('applying');
    this.progress.set({ applied: 0, total: plan.ops.length });

    const startedEmpty = graphBefore.nodes.length === 0;
    // Temp-ref → real node id, filled as adds are applied.
    const refs = new Map<string, string>();
    const nextPosition = this.makePositioner(graphBefore);

    for (const [index, op] of plan.ops.entries()) {
      if (this.cancelled) return;
      this.applyPlanOp(op, refs, nextPosition);
      this.progress.set({ applied: index + 1, total: plan.ops.length });
      await this.delay(PLAN_APPLY_DELAY_MS);
    }

    // Bring the freshly placed nodes into view, then arrange and fit again
    // — the user should watch the build resolve into its final shape.
    this.fitToScreen();
    await this.delay(PLAN_APPLY_DELAY_MS);

    // Position the result: a fresh canvas gets the full layered layout; an
    // existing canvas keeps the user's positions (new nodes were cascaded
    // beside the existing content by nextPosition).
    if (startedEmpty) {
      this.router.arrangeLayout();
      this.session.record('Auto-arranged the layout');
      this.fitToScreen();
    }
    this.summary.set(plan.summary ?? 'Workflow updated.');
  }

  /** Parses the model's JSON plan, tolerating markdown fences. */
  private parsePlan(text: string): EditPlan {
    let body = text.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body);
    if (fenced) body = fenced[1].trim();
    // Fall back to the outermost braces when prose leaked around the JSON.
    if (!body.startsWith('{')) {
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start === -1 || end <= start) {
        throw new Error('The model did not return a valid edit plan. Try rephrasing.');
      }
      body = body.slice(start, end + 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('The model returned malformed JSON. Try again.');
    }
    const plan = parsed as EditPlan;
    if (!Array.isArray(plan.ops)) {
      throw new Error('The model returned a plan without ops. Try rephrasing.');
    }
    return plan;
  }

  /** Applies one plan op, throwing a descriptive error on failure. */
  private applyPlanOp(
    op: PlanOp,
    refs: Map<string, string>,
    nextPosition: () => GraphPosition,
  ): void {
    switch (op.op) {
      case 'add': {
        if (!op.type || !findCatalogEntry(op.type)) {
          throw new Error(`Plan referenced unknown node type '${op.type ?? '?'}'.`);
        }
        const added = this.router.addNode(op.type, nextPosition());
        if (!added.ok || !added.value) throw new Error(added.error ?? 'Failed to add node.');
        const node = added.value;
        if (op.ref) refs.set(op.ref, node.id);
        const patch: { name?: string; data?: object } = {};
        if (op.name) patch.name = op.name;
        if (op.prompt && isAgentNode(node)) {
          patch.data = { ...node.data, prompt: op.prompt };
        }
        if (patch.name || patch.data) this.router.updateNode(node.id, patch);
        this.session.record(`Added ${op.name ?? node.name} (${op.type})`);
        break;
      }
      case 'connect': {
        const from = this.resolveRef(op.from, refs);
        const to = this.resolveRef(op.to, refs);
        if (!from || !to) throw new Error('Plan connect op is missing from/to.');
        const result = this.router.connectNodes(from, to, op.fromPort, op.toPort);
        if (!result.ok) throw new Error(result.error ?? 'Failed to connect nodes.');
        this.session.record(`Connected ${from} → ${to}`);
        break;
      }
      case 'update': {
        const nodeId = this.resolveRef(op.node, refs);
        if (!nodeId) throw new Error('Plan update op is missing node.');
        const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
        if (!node) throw new Error(`Plan updated unknown node '${nodeId}'.`);
        const patch: { name?: string; data?: object } = {};
        if (op.name) patch.name = op.name;
        if (op.prompt && isAgentNode(node)) patch.data = { ...node.data, prompt: op.prompt };
        if (!patch.name && !patch.data) break;
        const result = this.router.updateNode(nodeId, patch);
        if (!result.ok) throw new Error(result.error ?? 'Failed to update node.');
        this.session.record(`Updated ${node.name}`);
        break;
      }
      case 'remove': {
        const nodeId = this.resolveRef(op.node, refs);
        if (!nodeId) throw new Error('Plan remove op is missing node.');
        const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
        const result = this.router.removeNode(nodeId);
        if (!result.ok) throw new Error(result.error ?? 'Failed to remove node.');
        this.session.record(`Removed ${node?.name ?? nodeId}`);
        break;
      }
      case 'disconnect': {
        if (!op.connection) throw new Error('Plan disconnect op is missing connection.');
        const result = this.router.removeConnection(op.connection);
        if (!result.ok) throw new Error(result.error ?? 'Failed to remove connection.');
        this.session.record(`Removed connection ${op.connection}`);
        break;
      }
      default:
        throw new Error(`Plan contained unknown op '${(op as { op?: string }).op ?? '?'}'.`);
    }
  }

  private resolveRef(value: string | undefined, refs: Map<string, string>): string | null {
    if (!value) return null;
    return refs.get(value) ?? value;
  }

  /** Fits the whole graph in the viewport (same as View → Fit to screen). */
  private fitToScreen(): void {
    this.canvasState.zoomCommand.set('fit');
  }

  // ── Agent mode ─────────────────────────────────────────────────────────────

  private async runAgentMode(request: string, graphBefore: WorkflowGraph): Promise<void> {
    const startedEmpty = graphBefore.nodes.length === 0;
    const nextPosition = this.makePositioner(graphBefore);

    const messages: ChatMessage[] = [{ role: 'user', content: request }];
    const client = this.transport.create();

    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
      if (this.cancelled) return;

      const modelRequest: ModelRequest = {
        provider: 'phorma-cloud',
        model: BUILDER_MODEL,
        system: buildAgentSystemPrompt(graphBefore),
        messages,
        tools: this.agentToolDefinitions(),
        temperature: 0.2,
        maxTokens: 8192,
      };

      let text = '';
      const calls: ToolCall[] = [];
      for await (const chunk of client.stream(modelRequest)) {
        if (this.cancelled) return;
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'tool-call') calls.push(chunk.call);
      }
      if (this.cancelled) return;

      if (calls.length === 0) {
        // Build finished — the model's text is the summary.
        this.summary.set(text.trim() || 'Workflow updated.');
        break;
      }

      this.status.set('applying');
      messages.push({ role: 'assistant-tool-calls', text: text || undefined, calls });
      const results: { id: string; name: string; content: string }[] = [];
      for (const call of calls) {
        if (this.cancelled) return;
        results.push({
          id: call.id,
          name: call.name,
          content: this.executeAgentTool(call, nextPosition),
        });
        await this.delay(120);
      }
      messages.push({ role: 'tool-results', results });
      this.status.set('thinking');
    }

    // Bring the freshly placed nodes into view, then arrange and fit again.
    if (this.workflow.graph().nodes.length > 0) {
      this.fitToScreen();
      await this.delay(PLAN_APPLY_DELAY_MS);
    }
    if (startedEmpty && this.workflow.graph().nodes.length > 0) {
      this.router.arrangeLayout();
      this.session.record('Auto-arranged the layout');
      this.fitToScreen();
    }
    if (!this.summary()) this.summary.set('Workflow updated.');
  }

  /** Tool schemas offered to the model in Agent mode. */
  private agentToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'get_workflow_state',
        description:
          'Returns the current workflow graph (all nodes with ids, kinds, names, ports, and all connections). Call this to re-check the canvas after your edits.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'add_node',
        description:
          'Adds a node to the canvas from a catalog type. Returns the created node with its id — use that id in later connect/update calls.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Catalog type id, e.g. agent-researcher, trigger-manual, tool-web-search.' },
            name: { type: 'string', description: 'Display name for the node.' },
            prompt: { type: 'string', description: 'Markdown system prompt (agent nodes only). Include {{input}} where the task text goes.' },
          },
          required: ['type'],
        },
      },
      {
        name: 'update_node',
        description: 'Renames a node and/or replaces an agent node\'s markdown prompt.',
        parameters: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'remove_node',
        description: 'Removes a node and every connection touching it.',
        parameters: {
          type: 'object',
          properties: { nodeId: { type: 'string' } },
          required: ['nodeId'],
        },
      },
      {
        name: 'connect_nodes',
        description:
          'Connects two nodes. Handoff vs tool link is derived from the node kinds. Port names are only needed for multi-port flow nodes (e.g. Router "Route A").',
        parameters: {
          type: 'object',
          properties: {
            sourceNodeId: { type: 'string' },
            targetNodeId: { type: 'string' },
            sourcePort: { type: 'string', description: 'Optional source port name.' },
            targetPort: { type: 'string', description: 'Optional target port name.' },
          },
          required: ['sourceNodeId', 'targetNodeId'],
        },
      },
      {
        name: 'remove_connection',
        description: 'Removes a connection by its id.',
        parameters: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
        },
      },
    ];
  }

  /** Executes one Agent-mode tool call, returning the JSON result payload. */
  private executeAgentTool(call: ToolCall, nextPosition: () => GraphPosition): string {
    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ ok: false, error: 'Malformed tool arguments (invalid JSON).' });
    }
    const str = (key: string): string | undefined =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined;

    switch (call.name) {
      case 'get_workflow_state': {
        const graph = this.workflow.graph();
        return JSON.stringify({
          ok: true,
          nodes: graph.nodes.map(node => ({
            id: node.id,
            kind: node.kind,
            name: node.name,
            ports: node.ports.map(port => ({ name: port.name, role: port.role })),
          })),
          connections: graph.connections.map(conn => ({
            id: conn.id,
            kind: conn.kind,
            outputId: conn.outputId,
            inputId: conn.inputId,
          })),
        });
      }
      case 'add_node': {
        const type = str('type');
        if (!type) return JSON.stringify({ ok: false, error: 'Missing type.' });
        const added = this.router.addNode(type, nextPosition());
        if (!added.ok || !added.value) return JSON.stringify(added);
        const node = added.value;
        const name = str('name');
        const prompt = str('prompt');
        const patch: { name?: string; data?: object } = {};
        if (name) patch.name = name;
        if (prompt && isAgentNode(node)) patch.data = { ...node.data, prompt };
        if (patch.name || patch.data) this.router.updateNode(node.id, patch);
        this.session.record(`Added ${name ?? node.name} (${type})`);
        return JSON.stringify({ ok: true, nodeId: node.id, name: name ?? node.name });
      }
      case 'update_node': {
        const nodeId = str('nodeId');
        if (!nodeId) return JSON.stringify({ ok: false, error: 'Missing nodeId.' });
        const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
        if (!node) return JSON.stringify({ ok: false, error: `Node '${nodeId}' not found.` });
        const patch: { name?: string; data?: object } = {};
        const name = str('name');
        const prompt = str('prompt');
        if (name) patch.name = name;
        if (prompt && isAgentNode(node)) patch.data = { ...node.data, prompt };
        const result = this.router.updateNode(nodeId, patch);
        if (result.ok) this.session.record(`Updated ${node.name}`);
        return JSON.stringify({ ok: result.ok, error: result.error });
      }
      case 'remove_node': {
        const nodeId = str('nodeId');
        if (!nodeId) return JSON.stringify({ ok: false, error: 'Missing nodeId.' });
        const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
        const result = this.router.removeNode(nodeId);
        if (result.ok) this.session.record(`Removed ${node?.name ?? nodeId}`);
        return JSON.stringify({ ok: result.ok, error: result.error });
      }
      case 'connect_nodes': {
        const source = str('sourceNodeId');
        const target = str('targetNodeId');
        if (!source || !target) {
          return JSON.stringify({ ok: false, error: 'Missing sourceNodeId/targetNodeId.' });
        }
        const result = this.router.connectNodes(source, target, str('sourcePort'), str('targetPort'));
        if (result.ok) this.session.record(`Connected ${source} → ${target}`);
        return JSON.stringify({ ok: result.ok, connectionId: result.value, error: result.error });
      }
      case 'remove_connection': {
        const connectionId = str('connectionId');
        if (!connectionId) return JSON.stringify({ ok: false, error: 'Missing connectionId.' });
        const result = this.router.removeConnection(connectionId);
        if (result.ok) this.session.record(`Removed connection ${connectionId}`);
        return JSON.stringify({ ok: result.ok, error: result.error });
      }
      default:
        return JSON.stringify({ ok: false, error: `Unknown tool '${call.name}'.` });
    }
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /**
   * Builds a positioner that cascades newly added nodes in columns to the
   * right of the pre-run canvas content so nothing overlaps the user's
   * layout. The base is captured ONCE from the pre-run graph (recomputing
   * per-add would double-shift, since each add extends the graph's extent).
   * A fresh canvas gets a full layered layout afterwards anyway.
   */
  private makePositioner(graphBefore: WorkflowGraph): () => GraphPosition {
    let baseX = 80;
    let baseY = 80;
    for (const node of graphBefore.nodes) {
      baseX = Math.max(baseX, node.position.x + PLACE_COLUMN_WIDTH);
      baseY = Math.min(baseY, node.position.y);
    }
    baseY = Math.max(80, baseY);
    let index = 0;
    return () => {
      const column = Math.floor(index / PLACE_ROWS_PER_COLUMN);
      const row = index % PLACE_ROWS_PER_COLUMN;
      index += 1;
      return {
        x: baseX + column * PLACE_COLUMN_WIDTH,
        y: baseY + row * PLACE_ROW_HEIGHT,
      };
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
