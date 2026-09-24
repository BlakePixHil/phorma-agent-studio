import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { ChatMessage } from '@phorma/engine';

import { normalizeWebUrl } from '@phorma/engine';

import {
  chatId,
  normalizeChatThread,
  titleFromRequest,
  type AssistantMode,
  type ChatModelRef,
  type ChatReference,
  type ChatStep,
  type ChatThinking,
  type ChatThread,
  type ChatTurn,
  type EditPlan,
  type PlanProposalAttachment,
} from './assistant-chat.model';
import { remedyForModelError, type BillingRemedy } from './billing-refusal';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { loadLayout, saveLayout } from './layout-storage';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { WebFetchService, type WebPage } from './web-fetch.service';
import { WorkflowBuilderService } from './workflow-builder.service';
import {
  summarizeReferencedPages,
  type FailedReference,
  type ReferencedPage,
} from './workflow-builder-prompt';
import { WorkflowService } from './workflow.service';

/** How many prior turns ride along as conversation history per request. */
const HISTORY_TURNS = 12;

/** References one message may carry. */
export const MAX_REFERENCES = 5;

/** Page text budget per reference, and for all references of one message. */
const REFERENCE_CHARS = 12_000;
const REFERENCE_TOTAL_CHARS = 36_000;

/** A URL reference in the composer, before the message is sent. */
export interface PendingReference {
  url: string;
  /** `reading` while the page is fetched for its title; the send re-uses the result. */
  status: 'reading' | 'ready' | 'failed';
  title?: string;
  error?: string;
}

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
  private readonly web = inject(WebFetchService);

  /** Threads for the active workflow, newest first. */
  readonly threads = signal<ChatThread[]>([]);
  /** The open conversation, or null for the thread-list view. */
  readonly activeThread = signal<ChatThread | null>(null);
  /** True while a turn is streaming/applying. */
  readonly busy = signal(false);
  /** Cumulative streamed text of the in-flight assistant turn. */
  readonly streamingText = signal('');
  /** Live steps (studio actions / tool calls) of the in-flight turn, in order. */
  readonly steps = signal<ChatStep[]>([]);
  /** Streamed reasoning of the in-flight turn. */
  readonly thinkingText = signal('');
  /** When the in-flight turn started thinking / stopped thinking (epoch ms). */
  readonly thinkingStartedAt = signal<number | null>(null);
  readonly thinkingEndedAt = signal<number | null>(null);
  /** URL references attached in the composer for the next message. */
  readonly references = signal<PendingReference[]>([]);
  /** Whether turns ask the model to reason visibly (persisted). */
  readonly reasoningEnabled = signal<boolean>(loadLayout<boolean>('assistantReasoning', true));
  /** Whether the next turn's model can be asked to reason at all. */
  readonly reasoningSupported = computed(() =>
    this.builder.canRequestReasoning(this.resolvedModel()),
  );
  /** Whether the studio can read web pages from this session. */
  readonly webAvailable = computed(() => this.web.available());

  /** Page reads started for pending references, keyed by URL, reused on send. */
  private readonly referenceReads = new Map<string, Promise<WebPage>>();
  /** Explicit model override from the picker (null = automatic). */
  readonly modelOverride = signal<ChatModelRef | null>(null);
  /**
   * What to offer after a hosted refusal on the last turn, `'none'` otherwise.
   * Mirrors `WorkflowBuilderService.billingRemedy` and for the same reason: a
   * boolean could only ever offer Buy credits (requirement 19).
   */
  readonly billingRemedy = signal<BillingRemedy>('none');
  /** Selected assistant mode, persisted across sessions. */
  readonly mode = signal<AssistantMode>(loadLayout<AssistantMode>('assistantMode', 'ask'));

  /** The workflow id threads are currently scoped to. */
  private scopeWorkflowId: string | null = null;

  /**
   * Set when the active workflow changed WHILE a turn was in flight, so the
   * rescope runs once the turn settles instead of in the middle of it.
   */
  private rescopePending = false;

  /** False until the thread list has been scoped for the first time. */
  private scoped = false;

  /**
   * The active document's workflow id, and nothing else.
   *
   * A `computed` is the whole point: `activeDoc()` is a NEW object on every graph
   * edit (`updateDoc` spreads the doc), so an effect reading it directly re-ran on
   * every node an Agent-mode turn added. The computed's equality check collapses
   * those to the id, so only a real workflow switch notifies the effect below.
   */
  private readonly activeWorkflowId = computed(
    () => this.workflow.activeDoc()?.workflowId ?? null,
  );

  /** The model the next turn will run on (override or automatic). */
  readonly resolvedModel = computed(() => this.builder.resolveModel(this.modelOverride()));

  constructor() {
    // Rescope the thread list whenever the active workflow document changes.
    //
    // Three rules, each of which was once violated and made the conversation
    // vanish mid-turn in Agent mode:
    //  - Track the workflow ID only (see `activeWorkflowId`), never the doc.
    //  - An unchanged id is ALWAYS a no-op. The old guard also required
    //    `threads().length > 0`, and a workflow's first chat is not persisted
    //    until its turn settles - so during a first turn every graph edit wiped
    //    the open thread.
    //  - Never rescope while a turn is in flight. A turn can itself change the
    //    active workflow (`workflow_open`, `workflow_create`, saving a draft
    //    assigns an id), and the user can click another tab. The in-flight turn
    //    keeps its thread; the rescope is deferred to `settleTurn`.
    effect(() => {
      const workflowId = this.activeWorkflowId();
      untracked(() => {
        // `scoped` so the very first run loads the list even though a draft's
        // id and the initial scope are both null.
        if (this.scoped && workflowId === this.scopeWorkflowId) return;
        if (this.busy()) {
          this.rescopePending = true;
          return;
        }
        this.rescope(workflowId);
      });
    });
  }

  private rescope(workflowId: string | null, options: { keepThread?: boolean } = {}): void {
    this.scoped = true;
    this.rescopePending = false;
    this.scopeWorkflowId = workflowId;
    if (!options.keepThread) this.activeThread.set(null);
    void this.refresh();
  }

  /**
   * Ends a turn: clears the busy state, persists the thread, then applies any
   * rescope that was deferred while the turn ran.
   *
   * The deferred rescope KEEPS the open conversation. The switch happened
   * during the turn - usually because the assistant itself opened or created a
   * workflow - and the user is reading that conversation right now, so clearing
   * it the moment the turn finishes is the same "the chat disappeared" defect a
   * few seconds later. The thread keeps its original `workflowId` and stays
   * saved under it; only the list behind it follows the new workflow.
   */
  private async settleTurn(): Promise<void> {
    this.busy.set(false);
    await this.persistActive();
    if (this.rescopePending) {
      const current = this.activeWorkflowId();
      if (current !== this.scopeWorkflowId) this.rescope(current, { keepThread: true });
      else this.rescopePending = false;
    }
  }

  /** Reloads the thread list for the current workflow scope. */
  async refresh(): Promise<void> {
    try {
      const threads = await this.storage.listChatThreads(this.scopeWorkflowId);
      this.threads.set(threads.map(normalizeChatThread));
    } catch {
      // Chat history must never break the studio.
      this.threads.set([]);
    }
  }

  /** Opens an existing thread. */
  openThread(thread: ChatThread): void {
    if (this.busy()) return;
    this.activeThread.set(normalizeChatThread(structuredClone(thread)));
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

  setReasoning(enabled: boolean): void {
    this.reasoningEnabled.set(enabled);
    saveLayout('assistantReasoning', enabled);
  }

  // ── URL references ──────────────────────────────────────────────────────────

  /**
   * Attaches a web page to the next message. Starts reading it straight away
   * so the chip can show the page title, and so the send does not wait.
   * Returns an error sentence when the URL is refused, or null when added.
   */
  addReference(raw: string): string | null {
    const url = normalizeWebUrl(raw);
    if (!url) return 'That is not a valid web address.';
    const current = this.references();
    if (current.some(ref => ref.url === url)) return 'That page is already attached.';
    if (current.length >= MAX_REFERENCES) {
      return `A message can reference at most ${MAX_REFERENCES} pages.`;
    }
    if (!this.web.available()) {
      return 'Reading web pages needs the desktop app, or a Phorma Cloud sign-in in the browser.';
    }
    this.references.set([...current, { url, status: 'reading' }]);
    const read = this.web.read(url, { maxChars: REFERENCE_CHARS });
    this.referenceReads.set(url, read);
    read.then(
      page => this.patchReference(url, { status: 'ready', title: page.title || undefined }),
      error => this.patchReference(url, { status: 'failed', error: oneLine(error) }),
    );
    return null;
  }

  removeReference(url: string): void {
    this.references.update(list => list.filter(ref => ref.url !== url));
    this.referenceReads.delete(url);
  }

  private patchReference(url: string, patch: Partial<PendingReference>): void {
    this.references.update(list =>
      list.map(ref => (ref.url === url ? { ...ref, ...patch } : ref)),
    );
  }

  /**
   * Resolves the composer's references for a send: waits for reads still in
   * flight, builds the prompt block, and returns the record kept on the turn.
   * Clears the composer.
   */
  private async takeReferences(): Promise<{ block: string; records: ChatReference[] }> {
    const pending = this.references();
    if (pending.length === 0) return { block: '', records: [] };
    this.references.set([]);
    const reads = pending.map(ref => {
      const read = this.referenceReads.get(ref.url) ?? this.web.read(ref.url, { maxChars: REFERENCE_CHARS });
      return read.then(
        page => ({ ref, page }),
        (error: unknown) => ({ ref, error: oneLine(error) }),
      );
    });
    const settled = await Promise.all(reads);
    this.referenceReads.clear();

    const pages: ReferencedPage[] = [];
    const failed: FailedReference[] = [];
    const records: ChatReference[] = [];
    let budget = REFERENCE_TOTAL_CHARS;
    for (const item of settled) {
      if ('page' in item) {
        const text = item.page.text.slice(0, Math.max(0, budget));
        const truncated = item.page.truncated || text.length < item.page.text.length;
        budget -= text.length;
        pages.push({ url: item.page.url, title: item.page.title, text, truncated });
        records.push({
          url: item.ref.url,
          title: item.page.title || undefined,
          status: 'ready',
          chars: text.length,
          ...(truncated ? { truncated: true } : {}),
        });
      } else {
        failed.push({ url: item.ref.url, error: item.error });
        records.push({ url: item.ref.url, status: 'failed', error: item.error });
      }
    }
    return { block: summarizeReferencedPages(pages, failed), records };
  }

  // ── Live turn state ──────────────────────────────────────────────────────────

  private resetLiveTurn(): void {
    this.streamingText.set('');
    this.steps.set([]);
    this.thinkingText.set('');
    this.thinkingStartedAt.set(null);
    this.thinkingEndedAt.set(null);
  }

  /** Inserts a step, or replaces the one with the same id in place. */
  private upsertStep(step: ChatStep): void {
    this.steps.update(list => {
      const index = list.findIndex(existing => existing.id === step.id);
      if (index === -1) return [...list, step];
      const next = [...list];
      next[index] = step;
      return next;
    });
  }

  private appendThinking(delta: string): void {
    if (this.thinkingStartedAt() === null) this.thinkingStartedAt.set(Date.now());
    // Interleaved thinking (between tool rounds) resumes the clock.
    this.thinkingEndedAt.set(null);
    this.thinkingText.update(text => text + delta);
  }

  private endThinking(): void {
    if (this.thinkingStartedAt() !== null && this.thinkingEndedAt() === null) {
      this.thinkingEndedAt.set(Date.now());
    }
  }

  /** The callbacks every chat turn shares. */
  private liveTurnHooks(): {
    onStep: (step: ChatStep) => void;
    onThinking: (delta: string) => void;
    onThinkingEnd: () => void;
    reasoning: boolean;
  } {
    return {
      onStep: step => this.upsertStep(step),
      onThinking: delta => this.appendThinking(delta),
      onThinkingEnd: () => this.endThinking(),
      reasoning: this.reasoningEnabled(),
    };
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
    this.resetLiveTurn();
    this.billingRemedy.set('none');

    const userTurnId = chatId('turn');
    const hasReferences = this.references().length > 0;
    this.appendTurn({
      id: userTurnId,
      role: 'user',
      text: trimmed,
      mode,
      at: Date.now(),
    });
    this.retitleIfFirst(trimmed);

    const history = this.historyMessages();
    try {
      // Referenced pages are read (or awaited) before the model call, and the
      // outcome is recorded on the user turn so the transcript shows which
      // pages the answer was grounded in.
      const { block: extraContext, records } = hasReferences
        ? await this.takeReferences()
        : { block: '', records: [] };
      if (records.length > 0) {
        this.patchTurn(userTurnId, turn => ({ ...turn, references: records }));
      }
      const hooks = { ...this.liveTurnHooks(), extraContext };
      if (mode === 'ask') {
        const answer = await this.builder.runAskTurn({
          request: trimmed,
          history,
          model,
          onText: text => this.streamingText.set(text),
          ...hooks,
        });
        this.appendTurn({
          ...this.assistantTurn(mode, model, this.withTurnNotes(answer || 'No answer produced.')),
          status: this.builder.wasCancelled ? 'cancelled' : 'ok',
        });
      } else if (mode === 'plan') {
        const plan = await this.builder.runPlanTurn({ request: trimmed, history, model, ...hooks });
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
          ...hooks,
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
      this.billingRemedy.set(remedyForModelError(err));
      this.appendTurn({
        ...this.assistantTurn(mode, model, ''),
        status: 'error',
        error: message,
      });
    } finally {
      this.resetLiveTurn();
      await this.settleTurn();
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
    this.resetLiveTurn();
    this.billingRemedy.set('none');

    this.appendTurn({
      id: chatId('turn'),
      role: 'user',
      text: options.label,
      mode: options.mode,
      at: Date.now(),
    });
    this.retitleIfFirst(options.label);

    const hooks = this.liveTurnHooks();
    try {
      if (options.mode === 'ask') {
        const answer = await this.builder.runAskTurn({
          request: options.request,
          history: [],
          model,
          system: options.system,
          onText: text => this.streamingText.set(text),
          ...hooks,
        });
        this.appendTurn(this.assistantTurn('ask', model, answer || 'No output produced.'));
      } else {
        const plan = await this.builder.runPlanTurn({
          request: options.request,
          history: [],
          model,
          system: options.system,
          ...hooks,
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
      this.billingRemedy.set(remedyForModelError(err));
      this.appendTurn({
        ...this.assistantTurn(options.mode, model, ''),
        status: 'error',
        error: message,
      });
    } finally {
      this.resetLiveTurn();
      await this.settleTurn();
    }
  }

  /**
   * Whether this account can have a plan applied for it. The UI hides the Apply
   * button without it and shows the per-step instructions instead. Proxied off
   * the builder rather than injecting `PhormaCloudService` here: the builder
   * already holds it, and this service is deliberately thin on dependencies.
   */
  readonly canAutoApply = computed(() => this.builder.canAutoApply());

  /** Applies a plan-proposal attachment onto the canvas. */
  async applyProposal(turn: ChatTurn): Promise<void> {
    const attachment = turn.attachment;
    if (!attachment || attachment.kind !== 'plan-proposal') return;
    // Re-gated here, not only in the template: `applyProposal` is also reachable
    // from the action registry, so the check has to sit at the capability.
    if (!this.canAutoApply()) return;
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
      await this.settleTurn();
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
    if (thread) this.activeThread.set(normalizeChatThread(thread));
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
    // Snapshot the live step feed and reasoning onto the turn. Safe because
    // every caller builds the turn BEFORE the `finally` that clears them; copy
    // rather than alias, or the clear would empty the transcript. A step still
    // `running` here was interrupted (Stop), so it is recorded as failed.
    const now = Date.now();
    const steps = this.steps().map(step =>
      step.status === 'running'
        ? { ...step, status: 'failed' as const, error: 'Stopped.', endedAt: now }
        : { ...step },
    );
    return {
      id: chatId('turn'),
      role: 'assistant',
      text,
      mode,
      modelRef: model,
      usage: usage && usage.costUsd > 0 ? { ...usage } : undefined,
      steps: steps.length > 0 ? steps : undefined,
      thinking: this.thinkingSnapshot(now),
      status: 'ok',
      at: now,
    };
  }

  /** The in-flight turn's reasoning as a transcript record, or undefined. */
  private thinkingSnapshot(now: number): ChatThinking | undefined {
    const text = this.thinkingText().trim();
    const started = this.thinkingStartedAt();
    if (!text || started === null) return undefined;
    return { text, durationMs: Math.max(0, (this.thinkingEndedAt() ?? now) - started) };
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

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
