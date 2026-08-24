import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { ChatMessage } from '@phorma/engine';

import {
  chatId,
  titleFromRequest,
  type AssistantMode,
  type ChatModelRef,
  type ChatThread,
  type ChatTurn,
  type EditPlan,
  type PlanProposalAttachment,
} from './assistant-chat.model';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { loadLayout, saveLayout } from './layout-storage';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { WorkflowBuilderService, isCreditsError } from './workflow-builder.service';
import { WorkflowService } from './workflow.service';

/** How many prior turns ride along as conversation history per request. */
const HISTORY_TURNS = 12;

/**
 * Orchestrates the AI Assistant chat (EPIC 5): persistent per-workflow
 * conversation threads whose turns run through the
 * {@link WorkflowBuilderService} in Ask, Plan, or Agent mode.
 *
 * The service owns thread state (list, active thread, streaming turn); the
 * assistant panel and the expanded dialog are both thin views over it, so a
 * conversation started in one continues seamlessly in the other.
 */
@Injectable({ providedIn: 'root' })
export class AssistantChatService {
  private readonly storage = inject(IndexedDbStorageService);
  private readonly builder = inject(WorkflowBuilderService);
  private readonly workflow = inject(WorkflowService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so it cannot pull anything back into this service.
  private readonly telemetry = inject(TelemetryService);

  /** Threads for the active workflow, newest first. */
  readonly threads = signal<ChatThread[]>([]);
  /** The open conversation, or null for the thread-list view. */
  readonly activeThread = signal<ChatThread | null>(null);
  /** True while a turn is streaming/applying. */
  readonly busy = signal(false);
  /** Cumulative streamed text of the in-flight assistant turn. */
  readonly streamingText = signal('');
  /** Live activity lines while an Agent-mode turn edits the canvas. */
  readonly activity = signal<string[]>([]);
  /** Explicit model override from the picker (null = automatic). */
  readonly modelOverride = signal<ChatModelRef | null>(null);
  /** True when the last failure was a credits/subscription 402. */
  readonly creditsExhausted = signal(false);
  /** Selected assistant mode, persisted across sessions. */
  readonly mode = signal<AssistantMode>(loadLayout<AssistantMode>('assistantMode', 'ask'));

  /** The workflow id threads are currently scoped to. */
  private scopeWorkflowId: string | null = null;

  /** The model the next turn will run on (override or automatic). */
  readonly resolvedModel = computed(() => this.builder.resolveModel(this.modelOverride()));

  constructor() {
    // Rescope the thread list whenever the active workflow document changes.
    effect(() => {
      const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
      untracked(() => {
        if (workflowId === this.scopeWorkflowId && this.threads().length > 0) return;
        this.scopeWorkflowId = workflowId;
        this.activeThread.set(null);
        void this.refresh();
      });
    });
  }

  /** Reloads the thread list for the current workflow scope. */
  async refresh(): Promise<void> {
    try {
      this.threads.set(await this.storage.listChatThreads(this.scopeWorkflowId));
    } catch {
      // Chat history must never break the studio.
      this.threads.set([]);
    }
  }

  /** Opens an existing thread. */
  openThread(thread: ChatThread): void {
    if (this.busy()) return;
    this.activeThread.set(structuredClone(thread));
  }

  /** Returns to the thread-list view. */
  closeThread(): void {
    if (this.busy()) return;
    this.activeThread.set(null);
  }

  /** Starts a fresh conversation (persisted on the first message). */
  newThread(): void {
    if (this.busy()) return;
    this.activeThread.set({
      id: chatId('chat'),
      workflowId: this.scopeWorkflowId,
      title: 'New chat',
      turns: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async deleteThread(thread: ChatThread): Promise<void> {
    if (this.busy()) return;
    await this.storage.removeChatThread(thread.id);
    if (this.activeThread()?.id === thread.id) this.activeThread.set(null);
    await this.refresh();
  }

  /** Requests cancellation of the in-flight turn. */
  cancel(): void {
    this.builder.cancel();
  }

  setMode(mode: AssistantMode): void {
    if (!this.builder.modeAvailable(mode)) return;
    this.mode.set(mode);
    saveLayout('assistantMode', mode);
  }

  /**
   * Sends a user message in the given mode. Creates the active thread when
   * none is open. Resolves once the assistant turn settles (ok or error).
   */
  async send(request: string, mode: AssistantMode): Promise<void> {
    const trimmed = request.trim();
    if (!trimmed || this.busy()) return;
    if (!this.builder.modeAvailable(mode)) return;

    // One count per accepted invocation, past every guard and before any model
    // work, so a streamed turn counts once rather than per chunk (3.1, 3.2).
    this.telemetry.count(counterName('assistant.invoked', mode));

    if (!this.activeThread()) this.newThread();
    const model = this.resolvedModel();

    this.busy.set(true);
    this.streamingText.set('');
    this.activity.set([]);
    this.creditsExhausted.set(false);

    this.appendTurn({
      id: chatId('turn'),
      role: 'user',
      text: trimmed,
      mode,
      at: Date.now(),
    });
    this.retitleIfFirst(trimmed);

    const history = this.historyMessages();
    try {
      if (mode === 'ask') {
        const answer = await this.builder.runAskTurn({
          request: trimmed,
          history,
          model,
          onText: text => this.streamingText.set(text),
        });
        this.appendTurn({
          ...this.assistantTurn(mode, model, this.withTurnNotes(answer || 'No answer produced.')),
          status: this.builder.wasCancelled ? 'cancelled' : 'ok',
        });
      } else if (mode === 'plan') {
        const plan = await this.builder.runPlanTurn({ request: trimmed, history, model });
        if (this.builder.wasCancelled) {
          this.appendTurn({
            ...this.assistantTurn(mode, model, 'Stopped.'),
            status: 'cancelled',
          });
        } else {
          this.appendTurn({
            ...this.assistantTurn(mode, model, plan.summary ?? 'Here is the plan.'),
            attachment:
              plan.ops.length > 0
                ? { kind: 'plan-proposal', plan, origin: 'chat' }
                : undefined,
          });
        }
      } else {
        const summary = await this.builder.runAgentTurn({
          request: trimmed,
          history,
          model,
          onActivity: line => this.activity.update(lines => [...lines, line]),
        });
        this.appendTurn({
          ...this.assistantTurn(
            mode,
            model,
            this.builder.wasCancelled ? 'Stopped.' : this.withTurnNotes(summary),
          ),
          status: this.builder.wasCancelled ? 'cancelled' : 'ok',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.creditsExhausted.set(isCreditsError(message));
      this.appendTurn({
        ...this.assistantTurn(mode, model, ''),
        status: 'error',
        error: message,
      });
    } finally {
      this.busy.set(false);
      this.streamingText.set('');
      this.activity.set([]);
      await this.persistActive();
    }
  }

  /**
   * Runs a pre-assembled assistant task (analyzer / converter): a fixed
   * system prompt + user message pair whose result lands in the active
   * thread like any other turn. `mode` controls execution semantics.
   */
  async sendTask(options: {
    /** Rendered as the user turn (short label, e.g. "Analyze this workflow"). */
    label: string;
    /** The full user message sent to the model. */
    request: string;
    system: string;
    mode: 'ask' | 'plan';
    origin?: PlanProposalAttachment['origin'];
  }): Promise<void> {
    if (this.busy()) return;
    if (!this.activeThread()) this.newThread();
    const model = this.resolvedModel();

    this.busy.set(true);
    this.streamingText.set('');
    this.creditsExhausted.set(false);

    this.appendTurn({
      id: chatId('turn'),
      role: 'user',
      text: options.label,
      mode: options.mode,
      at: Date.now(),
    });
    this.retitleIfFirst(options.label);

    try {
      if (options.mode === 'ask') {
        const answer = await this.builder.runAskTurn({
          request: options.request,
          history: [],
          model,
          system: options.system,
          onText: text => this.streamingText.set(text),
        });
        this.appendTurn(this.assistantTurn('ask', model, answer || 'No output produced.'));
      } else {
        const plan = await this.builder.runPlanTurn({
          request: options.request,
          history: [],
          model,
          system: options.system,
        });
        this.appendTurn({
          ...this.assistantTurn('plan', model, plan.summary ?? 'Here is the plan.'),
          attachment:
            plan.ops.length > 0
              ? { kind: 'plan-proposal', plan, origin: options.origin ?? 'chat' }
              : undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.creditsExhausted.set(isCreditsError(message));
      this.appendTurn({
        ...this.assistantTurn(options.mode, model, ''),
        status: 'error',
        error: message,
      });
    } finally {
      this.busy.set(false);
      this.streamingText.set('');
      await this.persistActive();
    }
  }

  /** Applies a plan-proposal attachment onto the canvas. */
  async applyProposal(turn: ChatTurn): Promise<void> {
    const attachment = turn.attachment;
    if (!attachment || attachment.kind !== 'plan-proposal') return;
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.builder.applyPlan(attachment.plan, `Apply plan: ${turn.text.slice(0, 80)}`);
      this.patchTurn(turn.id, current => ({
        ...current,
        attachment: { ...attachment, appliedAt: Date.now() },
      }));
      // Requirements 7.5 and 11.2: permanent effects and failed steps belong
      // in the transcript, not only in the review bar.
      const notes = this.withTurnNotes('');
      if (notes.length > 0) {
        this.appendTurn(
          this.assistantTurn(turn.mode, turn.modelRef ?? this.resolvedModel(), notes),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTurn({
        ...this.assistantTurn(turn.mode, turn.modelRef ?? this.resolvedModel(), ''),
        status: 'error',
        error: `Applying the plan failed: ${message}`,
      });
    } finally {
      this.busy.set(false);
      await this.persistActive();
    }
  }

  /**
   * Records an externally-run exchange (the Ctrl+P quick palette) into a
   * new persisted thread so the user can continue refining it in chat.
   * Returns the thread for focusing.
   */
  async recordExternalExchange(options: {
    request: string;
    mode: AssistantMode;
    summary: string;
    model: ChatModelRef;
  }): Promise<ChatThread> {
    const now = Date.now();
    const thread: ChatThread = {
      id: chatId('chat'),
      workflowId: this.workflow.activeDoc()?.workflowId ?? null,
      title: titleFromRequest(options.request),
      turns: [
        { id: chatId('turn'), role: 'user', text: options.request, mode: options.mode, at: now },
        {
          id: chatId('turn'),
          role: 'assistant',
          text: options.summary,
          mode: options.mode,
          modelRef: options.model,
          status: 'ok',
          at: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.storage.saveChatThread(thread);
      await this.refresh();
    } catch {
      // Recording must never break the palette flow.
    }
    return thread;
  }

  /** Re-runs a user turn — sends the same text again in the same mode. */
  async reRunTurn(turn: ChatTurn): Promise<void> {
    if (this.busy()) return;
    await this.send(turn.text, turn.mode);
  }

  /** Opens a thread by id (used by the palette's "Continue in chat"). */
  async openThreadById(id: string): Promise<void> {
    const thread = await this.storage.getChatThread(id).catch(() => undefined);
    if (thread) this.activeThread.set(thread);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Appends the two things a turn summary must not hide: effects the Revert
   * control cannot undo (Requirement 7.5) and actions that failed
   * (Requirement 11.2). Both go into the persisted turn text, so they survive
   * in the transcript rather than only in the transient activity feed.
   */
  private withTurnNotes(text: string): string {
    const sections = [text.trim()];
    const permanent = this.builder.lastTurnNonRevertableEffects;
    if (permanent.length > 0) {
      sections.push(
        ['**Not covered by Revert:**', ...permanent.map(line => `- ${line}`)].join('\n'),
      );
    }
    const failures = this.builder.lastTurnFailures;
    if (failures.length > 0) {
      sections.push(['**Did not work:**', ...failures.map(line => `- ${line}`)].join('\n'));
    }
    return sections.filter(section => section.length > 0).join('\n\n');
  }

  private assistantTurn(mode: AssistantMode, model: ChatModelRef, text: string): ChatTurn {
    const usage = this.builder.lastTurnUsage;
    return {
      id: chatId('turn'),
      role: 'assistant',
      text,
      mode,
      modelRef: model,
      usage: usage && usage.costUsd > 0 ? { ...usage } : undefined,
      status: 'ok',
      at: Date.now(),
    };
  }

  private appendTurn(turn: ChatTurn): void {
    this.activeThread.update(thread =>
      thread ? { ...thread, turns: [...thread.turns, turn], updatedAt: Date.now() } : thread,
    );
  }

  private patchTurn(id: string, patch: (turn: ChatTurn) => ChatTurn): void {
    this.activeThread.update(thread =>
      thread
        ? {
            ...thread,
            turns: thread.turns.map(turn => (turn.id === id ? patch(turn) : turn)),
            updatedAt: Date.now(),
          }
        : thread,
    );
  }

  private retitleIfFirst(request: string): void {
    this.activeThread.update(thread =>
      thread && thread.turns.length <= 1
        ? { ...thread, title: titleFromRequest(request) }
        : thread,
    );
  }

  /** Prior turns as engine chat messages (text turns only, capped). */
  private historyMessages(): ChatMessage[] {
    const thread = this.activeThread();
    if (!thread) return [];
    // Exclude the just-appended user turn (it is sent as `request`).
    const prior = thread.turns.slice(0, -1).filter(turn => turn.text.trim().length > 0);
    return prior.slice(-HISTORY_TURNS).map(turn => ({
      role: turn.role,
      content: turn.status === 'error' ? `(failed) ${turn.error ?? ''}` : turn.text,
    }));
  }

  private async persistActive(): Promise<void> {
    const thread = this.activeThread();
    if (!thread || thread.turns.length === 0) return;
    try {
      await this.storage.saveChatThread(structuredClone(thread));
      await this.refresh();
    } catch {
      // Persistence failures must never break the conversation.
    }
  }
}
