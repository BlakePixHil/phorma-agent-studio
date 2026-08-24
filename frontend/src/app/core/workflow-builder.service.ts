import { Injectable, inject, signal } from '@angular/core';

import type { ChatMessage, ModelRequest, ModelUsage, ToolCall } from '@phorma/engine';

import { AgentStreamService } from './agent-stream.service';
import { AiEditSessionService } from './ai-edit-session.service';
import { AssistantContextService } from './assistant-context.service';
import type {
  AssistantMode,
  ChatModelRef,
  ChatTurnUsage,
  EditPlan,
  PlanOp,
} from './assistant-chat.model';
import { CanvasStateService } from './canvas-state.service';
import type { BuilderMode } from './command-palette.service';
import { LocalAgentRouterService } from './local-agent-router.service';
import { ModelPricingService } from './model-pricing.service';
import { ModelTransportService } from './model-transport.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { planOpCall } from './studio-actions/plan-op';
import { StudioActionRegistryService } from './studio-actions/studio-action-registry.service';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { WorkflowService } from './workflow.service';
import {
  buildAgentSystemPrompt,
  buildAskSystemPrompt,
  buildPlanSystemPrompt,
  summarizeContextWorkflows,
} from './workflow-builder-prompt';
import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import type { WorkflowGraph } from './workflow.model';

/**
 * The curated Phorma Cloud model that powers the workflow builder. Full
 * OpenRouter slug, billed against the tenant's subscription credits through
 * the /api/infer proxy. Deliberately a constant - one strong default keeps
 * the palette zero-config; revisit if a Settings knob is ever warranted.
 */
export const BUILDER_MODEL = 'anthropic/claude-sonnet-5';

/** Max LLM round-trips in Agent mode before the loop is cut off. */
const MAX_AGENT_ROUNDS = 12;

/** Delay between applied ops in Plan mode - the "watch it build" cadence. */
const PLAN_APPLY_DELAY_MS = 220;

export type BuilderStatus = 'idle' | 'thinking' | 'applying' | 'done' | 'error';

/** True when a model error message means "credits/subscription problem". */
export function isCreditsError(message: string): boolean {
  return /\(402\)|credits exhausted|subscription/i.test(message);
}

/** Options shared by the chat-turn methods. */
export interface ChatTurnOptions {
  request: string;
  /** Prior conversation turns (user/assistant text pairs). */
  history: ChatMessage[];
  model: ChatModelRef;
  /** Overrides the default system prompt (used by the analyzer/converter). */
  system?: string;
  /** Cumulative streamed text callback (Ask mode). */
  onText?: (text: string) => void;
  /** Human-readable activity lines as the agent works (Agent mode). */
  onActivity?: (line: string) => void;
}

/**
 * Runs the AI assistant: turns a natural-language request into studio work.
 *
 * Every mode dispatches through the {@link StudioActionRegistryService}, which
 * is the single description of what the studio can do. That is what makes the
 * assistant a control surface rather than a graph editor with a chat box: a
 * request naming evals, runs, prompts, versions, deploy, skills, connections,
 * the portal, usage or settings reaches that capability instead of the nearest
 * graph edit.
 *
 * - **Ask** - streams an answer, with the READ-ONLY action subset available as
 *   tools so it can look up the exact prompt, suite or run it needs.
 * - **Plan** - one model call emits a JSON plan of ops the user reviews and
 *   applies, played back with the canvas glow (atomic feel, cheapest).
 * - **Agent** - a live tool loop: the model calls actions round by round and
 *   the studio updates as it works (most agentic, more round trips).
 *
 * Plan and Agent run inside an {@link AiEditSessionService} transaction so the
 * graph edits can be reverted; effects outside that coverage are reported as
 * `revertable: false` and called out separately in the turn summary.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowBuilderService {
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly transport = inject(ModelTransportService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly settings = inject(SettingsService);
  private readonly session = inject(AiEditSessionService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly canvasState = inject(CanvasStateService);
  private readonly pricing = inject(ModelPricingService);
  private readonly actions = inject(StudioActionRegistryService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly context = inject(AssistantContextService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge cannot close the known NG0200 cycle through
  // `ModelTransportService -> PhormaCloudService -> CloudService`.
  private readonly telemetry = inject(TelemetryService);

  readonly status = signal<BuilderStatus>('idle');
  /** Plan-mode playback progress (null outside of applying). */
  readonly progress = signal<{ applied: number; total: number } | null>(null);
  /** Human-readable error from the last run (null when ok). */
  readonly error = signal<string | null>(null);
  /** True when the last failure was a credits/subscription 402 - drives upsell. */
  readonly creditsExhausted = signal(false);
  /** The model's one-line summary of what it built. */
  readonly summary = signal<string | null>(null);

  private cancelled = false;

  /** Accumulated cost of the current/most recent turn (null = unknown). */
  private turnUsage: ChatTurnUsage | null = null;

  /** Cost of the last completed turn, or null when nothing was reported. */
  get lastTurnUsage(): ChatTurnUsage | null {
    return this.turnUsage;
  }

  /** Resets the turn-usage accumulator (call at turn start). */
  private resetTurnUsage(): void {
    this.turnUsage = null;
  }

  /**
   * Folds one model-stream usage sample into the turn accumulator, filling
   * in a pricing-table estimate when the provider reported tokens but no
   * USD (the EPIC 2 display rule: reported wins, estimates are marked).
   */
  private recordUsage(model: ChatModelRef, usage: ModelUsage): void {
    let costUsd = usage.costUsd;
    let estimated = usage.costSource === 'estimated';
    if (costUsd === undefined) {
      const estimate = this.pricing.estimator()(model.provider, model.model, usage);
      if (estimate === null) return;
      costUsd = estimate;
      estimated = true;
    }
    const current = this.turnUsage ?? {
      costUsd: 0,
      phormaCloud: model.provider === 'phorma-cloud',
      estimated: false,
    };
    this.turnUsage = {
      costUsd: current.costUsd + costUsd,
      phormaCloud: current.phormaCloud || model.provider === 'phorma-cloud',
      estimated: current.estimated || estimated,
    };
  }

  get running(): boolean {
    const status = this.status();
    return status === 'thinking' || status === 'applying';
  }

  /** Requests cancellation of the in-flight build (checked between steps). */
  cancel(): void {
    this.cancelled = true;
  }

  /** True when the most recent turn was stopped by the user. */
  get wasCancelled(): boolean {
    return this.cancelled;
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

    // The Ctrl+P builder entry point. `BuilderMode` is a subset of
    // `AssistantMode`, so the palette's mode is already a catalog dimension;
    // one count per accepted build, not per model round trip (3.1, 3.2).
    this.telemetry.count(counterName('assistant.invoked', mode));

    this.cancelled = false;
    this.error.set(null);
    this.summary.set(null);
    this.creditsExhausted.set(false);
    this.progress.set(null);
    this.status.set('thinking');

    const graphBefore = this.workflow.graph();
    this.session.begin(trimmed);

    try {
      const model = this.resolveModel();
      if (mode === 'plan') {
        await this.runPlanMode(trimmed, graphBefore, model);
      } else {
        await this.runAgentMode(trimmed, graphBefore, model);
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

  // ── Chat-turn API (assistant panel/dialog - EPIC 5) ────────────────────

  /**
   * Resolves the model a turn should run on: an explicit picker choice wins,
   * else Phorma Cloud's builder model for subscribers, else the user's
   * default model (Ask/Plan work without a subscription by design).
   */
  resolveModel(explicit?: ChatModelRef | null): ChatModelRef {
    if (explicit) return explicit;
    if (this.phormaCloud.subscribed()) {
      return { provider: 'phorma-cloud', model: BUILDER_MODEL };
    }
    return this.settings.resolvedDefaultModel();
  }

  /**
   * Whether a mode is available for the current account. Agent mode edits
   * the canvas live and is Phorma Cloud-exclusive (also re-gated server-side
   * by /api/infer since it always runs on the phorma-cloud provider).
   */
  modeAvailable(mode: AssistantMode): boolean {
    return mode !== 'agent' || this.phormaCloud.subscribed();
  }

  /**
   * Ask mode: streams a markdown answer about the current workflow.
   *
   * Read_Actions are offered as tools (Requirement 5.5) so the assistant can
   * look up the exact prompt, suite, run or usage row it needs instead of
   * having panel state pushed into the prompt. Writes are structurally
   * unreachable here: the registry only hands over `access: 'read'` entries,
   * and every read leaves studio state untouched (Requirement 5.6).
   *
   * A turn with no tool calls behaves exactly as before - one streamed answer.
   */
  async runAskTurn(options: ChatTurnOptions): Promise<string> {
    this.cancelled = false;
    this.resetTurnUsage();
    this.status.set('thinking');
    const graph = this.workflow.graph();
    this.actions.beginTurn(graph);
    const system =
      options.system ?? buildAskSystemPrompt(graph, this.actions, this.contextBlock());
    const tools = options.system ? undefined : this.actions.toolDefinitions('read');
    const messages: ChatMessage[] = [
      ...options.history,
      { role: 'user', content: options.request },
    ];
    const client = this.transport.create();
    let answer = '';

    try {
      for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
        if (this.cancelled) break;
        const modelRequest: ModelRequest = {
          provider: options.model.provider,
          model: options.model.model,
          system,
          messages,
          ...(tools && tools.length > 0 ? { tools } : {}),
          temperature: 0.4,
          maxTokens: 4096,
        };

        let text = '';
        const calls: ToolCall[] = [];
        for await (const chunk of client.stream(modelRequest)) {
          if (this.cancelled) break;
          if (chunk.type === 'text') {
            text += chunk.text;
            options.onText?.(answer + text);
          } else if (chunk.type === 'tool-call') {
            calls.push(chunk.call);
          } else if (chunk.type === 'usage') {
            this.recordUsage(options.model, chunk.usage);
          }
        }
        if (this.cancelled) break;

        if (calls.length === 0) {
          answer += text;
          break;
        }
        // Keep any prose the model emitted alongside its lookups, then run
        // them and let it answer with the results in hand.
        if (text.trim()) answer += `${text}\n\n`;
        messages.push({ role: 'assistant-tool-calls', text: text || undefined, calls });
        messages.push({
          role: 'tool-results',
          results: await this.runToolCalls(calls, options, { readOnly: true }),
        });
      }
    } finally {
      this.status.set('idle');
    }
    return answer.trim();
  }

  /**
   * Plan mode as a chat turn: asks the model for an edit plan and returns it
   * WITHOUT applying - chat renders it as a proposal card and the user
   * applies it explicitly via {@link applyPlan}.
   */
  async runPlanTurn(options: ChatTurnOptions): Promise<EditPlan> {
    this.cancelled = false;
    this.resetTurnUsage();
    this.status.set('thinking');
    const graph = this.workflow.graph();
    const modelRequest: ModelRequest = {
      provider: options.model.provider,
      model: options.model.model,
      system: options.system ?? buildPlanSystemPrompt(graph, this.actions, this.contextBlock()),
      messages: [...options.history, { role: 'user', content: options.request }],
      temperature: 0.2,
      maxTokens: 8192,
    };
    let text = '';
    try {
      for await (const chunk of this.transport.create().stream(modelRequest)) {
        if (this.cancelled) break;
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'usage') this.recordUsage(options.model, chunk.usage);
      }
    } finally {
      this.status.set('idle');
    }
    if (this.cancelled) return { summary: 'Cancelled.', ops: [] };
    return this.parsePlan(text);
  }

  /**
   * Plays a plan proposal onto the canvas inside an edit transaction (the
   * Revert/Keep review bar appears after). Free - no model call happens
   * here. Throws on the first failing op after rolling the graph back.
   */
  async applyPlan(plan: EditPlan, request = 'Apply plan'): Promise<void> {
    if (this.running) throw new Error('A build is already running.');
    if (plan.ops.length === 0) return;
    this.cancelled = false;
    this.error.set(null);
    this.status.set('applying');
    this.progress.set({ applied: 0, total: plan.ops.length });

    // Requirement 4.7: ONE grouped confirmation for the whole plan, before
    // anything is applied. Asking per op would turn a five-step plan into five
    // dialogs, which is how people learn to click through guardrails.
    const consented = await this.confirmPlan(plan);
    if (!consented) {
      this.status.set('idle');
      this.progress.set(null);
      return;
    }

    const graphBefore = this.workflow.graph();
    this.session.begin(request);
    try {
      await this.playbackPlan(plan, graphBefore);
      this.session.commit();
      this.status.set(this.cancelled ? 'idle' : 'done');
    } catch (err) {
      this.session.rollbackActive();
      const message = err instanceof Error ? err.message : String(err);
      this.error.set(message);
      this.status.set('error');
      throw err;
    } finally {
      this.progress.set(null);
      this.agentStream.clearAll();
    }
  }

  /**
   * Asks once for the confirm-tier actions a plan contains. Resolves true when
   * the plan needs no consent at all, or the user granted it.
   */
  private async confirmPlan(plan: EditPlan): Promise<boolean> {
    const refs = new Map<string, string>();
    const pending = this.actions.pendingConfirmations(
      plan.ops.map(op => {
        const call = planOpCall(op, refs);
        return { id: call.id ?? '', args: call.args };
      }),
    );
    if (pending.length === 0) return true;
    return this.confirmDialog.confirm({
      title: pending.length === 1 ? pending[0].label : 'Apply this plan?',
      message:
        'This plan includes steps that spend credits, delete data or change configuration:\n\n' +
        pending.map(action => `- ${action.label}`).join('\n'),
      confirmLabel: 'Apply plan',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
  }

  /**
   * Agent mode as a chat turn: the live tool loop with conversation history.
   * Runs inside an edit transaction; returns the model's closing summary.
   */
  async runAgentTurn(options: ChatTurnOptions): Promise<string> {
    if (this.running) throw new Error('A build is already running.');
    this.cancelled = false;
    this.resetTurnUsage();
    this.error.set(null);
    this.status.set('thinking');

    const graphBefore = this.workflow.graph();
    this.session.begin(options.request);
    try {
      const summary = await this.agentLoop(options, graphBefore);
      this.session.commit();
      this.status.set(this.cancelled ? 'idle' : 'done');
      return summary;
    } catch (err) {
      this.session.rollbackActive();
      const message = err instanceof Error ? err.message : String(err);
      this.creditsExhausted.set(isCreditsError(message));
      this.error.set(message);
      this.status.set('error');
      throw err;
    } finally {
      this.progress.set(null);
      this.agentStream.clearAll();
      setTimeout(() => void this.phormaCloud.refresh(), 1500);
    }
  }

  // ── Plan mode ──────────────────────────────────────────────────────────────────

  private async runPlanMode(
    request: string,
    graphBefore: WorkflowGraph,
    model: ChatModelRef,
  ): Promise<void> {
    const modelRequest: ModelRequest = {
      provider: model.provider,
      model: model.model,
      system: buildPlanSystemPrompt(graphBefore, this.actions, this.contextBlock()),
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

    // The palette applies Plan results without a second click (speed is its
    // whole point), but consent for confirm-tier steps is not negotiable.
    if (!(await this.confirmPlan(plan))) {
      this.summary.set('Cancelled.');
      return;
    }
    await this.playbackPlan(plan, graphBefore);
    this.summary.set(plan.summary ?? 'Workflow updated.');
  }

  /**
   * Plays a validated plan's ops onto the canvas with the animated cadence.
   * Shared by palette Plan mode (auto-apply) and chat proposals (explicit
   * Apply). Must run inside an open edit-session transaction.
   */
  private async playbackPlan(plan: EditPlan, graphBefore: WorkflowGraph): Promise<void> {
    this.status.set('applying');
    this.progress.set({ applied: 0, total: plan.ops.length });

    const startedEmpty = graphBefore.nodes.length === 0;
    // Temp-ref -> real node id, filled as adds are applied.
    const refs = new Map<string, string>();
    this.actions.beginTurn(graphBefore);

    for (const [index, op] of plan.ops.entries()) {
      if (this.cancelled) return;
      await this.applyPlanOp(op, refs);
      this.progress.set({ applied: index + 1, total: plan.ops.length });
      await this.delay(PLAN_APPLY_DELAY_MS);
    }

    // Bring the freshly placed nodes into view, then arrange and fit again
    // - the user should watch the build resolve into its final shape.
    this.fitToScreen();
    await this.delay(PLAN_APPLY_DELAY_MS);

    // Position the result: a fresh canvas gets the full layered layout; an
    // existing canvas keeps the user's positions (new nodes were cascaded
    // beside the existing content by the registry's placement cursor).
    if (startedEmpty) {
      this.router.arrangeLayout();
      this.session.record('Auto-arranged the layout');
      this.fitToScreen();
    }
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

  /**
   * Applies one Plan_Op through the Action_Registry (Requirement 4.2),
   * throwing a descriptive error on failure so playback stops and the
   * Edit_Session rolls back (Requirement 4.8).
   *
   * The five Legacy_Plan_Op forms are translated to their graph Studio_Action
   * with the arguments they always carried, so a chat thread persisted before
   * this feature replays with its original behaviour (Requirement 4.3).
   * Consent was already obtained once for the whole plan, hence
   * `confirmed: true`.
   */
  private async applyPlanOp(op: PlanOp, refs: Map<string, string>): Promise<void> {
    const { id, args, ref } = planOpCall(op, refs);
    if (!id) {
      throw new Error(`Plan contained unknown op '${(op as { op?: string }).op ?? '?'}'.`);
    }
    const result = await this.actions.execute(id, args, { confirmed: true });
    if (!result.ok) {
      throw new Error(result.message ?? `Plan step '${id}' failed.`);
    }
    if (ref) {
      const nodeId = (result.data as { nodeId?: string } | undefined)?.nodeId;
      if (nodeId) refs.set(ref, nodeId);
    }
  }

  /**
   * The "Also in context" prompt block for the workflows the user added from
   * the document tab menu, or an empty string when there are none. The active
   * canvas is not included here - it already has its own section.
   */
  private contextBlock(): string {
    return summarizeContextWorkflows(
      this.context.extraDocuments().map(doc => ({
        workflowId: doc.workflowId,
        name: doc.name,
        graph: doc.graph,
      })),
    );
  }

  /** Fits the whole graph in the viewport (same as View -> Fit to screen). */
  private fitToScreen(): void {
    this.canvasState.zoomCommand.set('fit');
  }

  // ── Agent mode ─────────────────────────────────────────────────────────────

  private async runAgentMode(
    request: string,
    graphBefore: WorkflowGraph,
    model: ChatModelRef,
  ): Promise<void> {
    const summary = await this.agentLoop(
      { request, history: [], model },
      graphBefore,
    );
    this.summary.set(summary);
  }

  /**
   * The live tool loop shared by palette Agent mode and chat Agent turns: the
   * model calls Studio_Actions round by round until it stops, then its closing
   * text becomes the summary.
   */
  private async agentLoop(
    options: ChatTurnOptions,
    graphBefore: WorkflowGraph,
  ): Promise<string> {
    const startedEmpty = graphBefore.nodes.length === 0;
    this.actions.beginTurn(graphBefore);

    const messages: ChatMessage[] = [
      ...options.history,
      { role: 'user', content: options.request },
    ];
    const client = this.transport.create();
    // Requirement 3.1: one tool definition per available Studio_Action, name,
    // description and schema all derived from the registry entry.
    const tools = this.actions.toolDefinitions('all');
    const context = this.contextBlock();
    let summary = '';

    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
      if (this.cancelled) break;

      const modelRequest: ModelRequest = {
        provider: options.model.provider,
        model: options.model.model,
        system: options.system ?? buildAgentSystemPrompt(graphBefore, this.actions, context),
        messages,
        tools,
        temperature: 0.2,
        maxTokens: 8192,
      };

      let text = '';
      const calls: ToolCall[] = [];
      for await (const chunk of client.stream(modelRequest)) {
        if (this.cancelled) break;
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'tool-call') calls.push(chunk.call);
        else if (chunk.type === 'usage') this.recordUsage(options.model, chunk.usage);
      }
      if (this.cancelled) break;

      if (calls.length === 0) {
        // Build finished - the model's text is the summary.
        summary = text.trim();
        break;
      }

      this.status.set('applying');
      messages.push({ role: 'assistant-tool-calls', text: text || undefined, calls });
      messages.push({ role: 'tool-results', results: await this.runToolCalls(calls, options) });
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
    return summary || 'Workflow updated.';
  }

  /**
   * Runs a round of tool calls through the Action_Registry and returns the
   * results as JSON for the model (Requirement 3.2). One plain-language
   * activity line is emitted per executed action (Requirement 3.5), and an
   * unknown id or invalid arguments come back as `ok: false` without breaking
   * the loop (Requirements 3.3, 3.4).
   */
  private async runToolCalls(
    calls: readonly ToolCall[],
    options: ChatTurnOptions,
    dispatch: { readOnly?: boolean } = {},
  ): Promise<{ id: string; name: string; content: string }[]> {
    const results: { id: string; name: string; content: string }[] = [];
    for (const call of calls) {
      if (this.cancelled) break;
      const args = parseToolArguments(call.arguments);
      if (args === null) {
        results.push({
          id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, message: 'Malformed tool arguments (invalid JSON).' }),
        });
        continue;
      }
      const line = this.actions.describe(call.name, args);
      options.onActivity?.(line);
      const result = await this.actions.execute(call.name, args, dispatch);
      options.onActivity?.(
        result.ok ? `${line} - done` : `${line} - failed: ${result.message ?? 'unknown error'}`,
      );
      results.push({ id: call.id, name: call.name, content: JSON.stringify(result) });
      await this.delay(120);
    }
    return results;
  }

  /**
   * Effects from the last turn the Revert control cannot undo, so the chat can
   * describe them separately from the revertable graph edits
   * (Requirement 7.5).
   */
  get lastTurnNonRevertableEffects(): string[] {
    return this.actions.nonRevertableEffects();
  }

  /**
   * Action failures from the last turn, so the chat records them in the
   * transcript instead of leaving them only in the model's context
   * (Requirement 11.2).
   */
  get lastTurnFailures(): string[] {
    return this.actions.turnFailures();
  }

  // Shared helpers

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** Parses tool-call arguments, returning null for malformed JSON. */
function parseToolArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

