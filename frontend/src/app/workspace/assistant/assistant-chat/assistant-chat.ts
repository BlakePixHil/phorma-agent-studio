import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { normalizeWebUrl } from '@phorma/engine';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import { renderMarkdown } from '../../../shared/markdown/render-markdown';
import { AssistantChatService, type PendingReference } from '../../../core/assistant-chat.service';
import type { AssistantMode, ChatReference, ChatTurn } from '../../../core/assistant-chat.model';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { ChatSteps } from './chat-steps';
import { ChatThought } from './chat-thought';
import { ThinkingBubble } from './thinking-bubble';
import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, subscriptionLookupKey } from '../../../core/billing.service';
import { ENTRY_PLAN_TIER } from '../../../core/plan-catalog';
import { CheckoutFallback } from '../../../shared/billing/checkout-fallback';
import { PastDueNotice } from '../../../shared/billing/past-due-notice';
import { MigrationImportService } from '../../../core/migration/migration-import.service';
import { ModelTransportService } from '../../../core/model-transport.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { AssistantContextService, type AssistantContextItem } from '../../../core/assistant-context.service';
import { SettingsService } from '../../../core/settings.service';
import { StudioActionRegistryService } from '../../../core/studio-actions/studio-action-registry.service';
import { WorkflowService } from '../../../core/workflow.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { refusalNotice } from '../../../core/billing-refusal';
import { BillingCtaService } from '../../../shared/billing/billing-cta.service';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  type ModelProviderId,
} from '../../../core/workflow.model';

/** Sentinel provider value meaning "automatic model routing". */
const AUTO_OPTION = '__auto__';

/** The three assistant modes with display metadata. */
const MODES: { id: AssistantMode; label: string; icon: string; title: string }[] = [
  { id: 'ask', label: 'Ask', icon: 'ti ti-message-question', title: 'Ask: answers questions about your workflow — never edits' },
  { id: 'plan', label: 'Plan', icon: 'ti ti-list-check', title: 'Plan: proposes an edit plan you apply explicitly' },
  { id: 'agent', label: 'Agent', icon: 'ti ti-robot', title: 'Agent: edits the canvas live, step by step (Phorma Cloud)' },
];

/**
 * The shared assistant conversation view (EPIC 5): message list, streaming
 * turn, plan-proposal cards, mode switch, model picker, and the input box.
 * Rendered by BOTH the sidebar panel and the expanded dialog — all state
 * lives in {@link AssistantChatService} so the two surfaces stay in sync.
 */
@Component({
  selector: 'app-assistant-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    CheckoutFallback,
    PastDueNotice,
    ChatSteps,
    ChatThought,
    ThinkingBubble,
  ],
  templateUrl: './assistant-chat.html',
  styleUrl: './assistant-chat.scss',
})
export class AssistantChat {
  protected readonly chat = inject(AssistantChatService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  protected readonly billing = inject(BillingService);
  private readonly billingRefresh = inject(BillingRefreshService);

  /** True once a checkout was started from this view (arms the reopen link). */
  protected readonly checkoutAttempted = signal(false);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly billingCta = inject(BillingCtaService);
  private readonly importer = inject(MigrationImportService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly transport = inject(ModelTransportService);
  private readonly settings = inject(SettingsService);
  private readonly actions = inject(StudioActionRegistryService);
  protected readonly context = inject(AssistantContextService);
  private readonly workflow = inject(WorkflowService);
  // The app's one external-link helper (system browser on desktop, a
  // `noopener` tab in the browser).
  private readonly links = inject(McpOAuthService);

  /** Wide layout (expanded dialog) vs compact (sidebar panel). */
  readonly wide = input(false);

  protected readonly modes = MODES;
  /** The billing CTA the last failed turn earned, or null for anything else. */
  protected readonly billingCtaLabel = computed(
    () => refusalNotice(this.chat.billingRemedy())?.label ?? null,
  );
  protected readonly draft = signal('');
  /** Turn id whose copy button briefly shows the "copied" check. */
  protected readonly copiedTurnId = signal<string | null>(null);

  private readonly scrollRef = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly inputRef = viewChild<ElementRef<HTMLTextAreaElement>>('chatInput');
  private readonly refInputRef = viewChild<ElementRef<HTMLInputElement>>('refInput');

  /** The inline "reference a page" field is open. */
  protected readonly referenceOpen = signal(false);
  protected readonly referenceDraft = signal('');
  protected readonly referenceError = signal<string | null>(null);
  /** A bare URL the user just pasted, offered as a reference. */
  protected readonly pastedUrl = signal<string | null>(null);

  /** True once the live turn has streamed any reasoning (not per delta). */
  private readonly isThinking = computed(() => this.chat.thinkingText() !== '');

  /** True while any live step is still running (its row shows the spinner). */
  protected readonly liveStepRunning = computed(() =>
    this.chat.steps().some(step => step.status === 'running'),
  );

  /** Duration of the live turn's finished thinking phase. */
  protected readonly liveThinkingMs = computed(() => {
    const started = this.chat.thinkingStartedAt();
    const ended = this.chat.thinkingEndedAt();
    return started !== null && ended !== null ? ended - started : 0;
  });

  protected readonly reasoningTitle = computed(() => {
    if (!this.chat.reasoningSupported()) {
      return "This model can't be asked to show its reasoning (it will still appear if the model shares it)";
    }
    return this.chat.reasoningEnabled()
      ? 'Showing the model\u2019s reasoning - click to turn off'
      : 'Show the model\u2019s reasoning (uses a few more tokens)';
  });

  /** Provider options for the model picker: Automatic + selectable providers. */
  protected readonly providerOptions = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return [
      { id: AUTO_OPTION, label: 'Auto model' },
      ...MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn),
    ];
  });

  protected readonly providerValue = computed(
    () => this.chat.modelOverride()?.provider ?? AUTO_OPTION,
  );

  /** Live-fetched LM Studio model ids (empty until loaded). */
  protected readonly lmstudioModels = signal<string[]>([]);
  /** True while fetching LM Studio models. */
  protected readonly loadingLmstudioModels = signal(false);
  /** Whether the LM Studio server was reachable on the last fetch. */
  protected readonly lmstudioRunning = signal(true);

  /** Live-fetched Ollama model ids (empty until loaded). */
  protected readonly ollamaModels = signal<string[]>([]);
  /** True while fetching Ollama models. */
  protected readonly loadingOllamaModels = signal(false);
  /** Whether the Ollama daemon was reachable on the last fetch. */
  protected readonly ollamaRunning = signal(true);

  /** Model suggestions for the explicitly selected provider. */
  protected readonly modelSuggestions = computed(() => {
    const provider = this.chat.modelOverride()?.provider;
    if (!provider) return [];
    if (provider === 'lmstudio') {
      return this.lmstudioModels().length > 0 ? this.lmstudioModels() : PROVIDER_MODEL_SUGGESTIONS['lmstudio'];
    }
    if (provider === 'ollama') {
      return this.ollamaModels().length > 0 ? this.ollamaModels() : PROVIDER_MODEL_SUGGESTIONS['ollama'];
    }
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  });

  /** Hint describing what the automatic route resolves to. */
  protected readonly autoHint = computed(() => {
    const model = this.chat.resolvedModel();
    const provider = MODEL_PROVIDERS.find(p => p.id === model.provider);
    return `${provider?.label ?? model.provider} · ${model.model}`;
  });

  protected readonly agentLocked = computed(() => !this.phormaCloud.subscribed());

  /**
   * True when this view may OFFER a purchase (multi-organisation-phorma,
   * Requirement 19.7).
   *
   * BOTH upsells in this view read it - the plan-proposal "have it built for you"
   * link and the Agent-mode composer hint. False while an organisation owner is
   * active, because Phorma Labs invoices it and `/api/checkout` refuses that owner
   * with `billing_managed`. The copy stays; only the purchase goes, and the plan is
   * still the deliverable either way.
   */
  protected readonly selfServeBilling = computed(() => this.phormaCloud.selfServeBilling());

  constructor() {
    // Keep the conversation pinned to the bottom as turns stream in.
    effect(() => {
      this.chat.activeThread();
      this.chat.streamingText();
      this.chat.steps();
      // Only the START and END of thinking move the layout (the bubble is a
      // fixed height and scrolls itself), so the deltas do not re-pin.
      this.isThinking();
      this.chat.thinkingEndedAt();
      untracked(() => this.scrollToBottom());
    });
  }

  // ── Web references ────────────────────────────────────────────────────────

  protected toggleReference(): void {
    if (this.referenceOpen()) {
      this.closeReference();
      return;
    }
    this.referenceOpen.set(true);
    this.referenceError.set(null);
    setTimeout(() => this.refInputRef()?.nativeElement.focus(), 0);
  }

  protected closeReference(): void {
    this.referenceOpen.set(false);
    this.referenceDraft.set('');
    this.referenceError.set(null);
    setTimeout(() => this.inputRef()?.nativeElement.focus(), 0);
  }

  protected addReference(): void {
    const error = this.chat.addReference(this.referenceDraft());
    if (error) {
      this.referenceError.set(error);
      return;
    }
    this.closeReference();
  }

  /** Offers a lone pasted URL as a reference; the paste itself is untouched. */
  protected onInputPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
    const url = /^https?:\/\/\S+$/i.test(text) ? normalizeWebUrl(text) : null;
    const attached = url !== null && this.chat.references().some(ref => ref.url === url);
    this.pastedUrl.set(url && !attached && this.chat.webAvailable() ? url : null);
  }

  protected acceptPastedUrl(url: string): void {
    this.pastedUrl.set(null);
    const error = this.chat.addReference(url);
    if (error) {
      this.referenceOpen.set(true);
      this.referenceDraft.set(url);
      this.referenceError.set(error);
    }
  }

  protected openReference(url: string): void {
    void this.links.openExternal(url);
  }

  protected hostOf(url: string): string {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  protected pendingReferenceTitle(ref: PendingReference): string {
    if (ref.status === 'reading') return `Reading ${ref.url}…`;
    if (ref.status === 'failed') return `${ref.url}\nCould not be read: ${ref.error ?? 'unknown error'}`;
    return `${ref.title ? `${ref.title}\n` : ''}${ref.url}`;
  }

  protected referenceTitle(ref: ChatReference): string {
    if (ref.status === 'failed') return `${ref.url}\nCould not be read: ${ref.error ?? 'unknown error'}`;
    const size = ref.chars ? `\n${ref.chars.toLocaleString()} characters${ref.truncated ? ' (truncated)' : ''}` : '';
    return `${ref.title ? `${ref.title}\n` : ''}${ref.url}${size}\nClick to open`;
  }

  protected setMode(mode: AssistantMode): void {
    if (this.chat.busy()) return;
    if (mode === 'agent' && this.agentLocked()) return;
    this.chat.setMode(mode);
  }

  protected onProviderChange(value: string): void {
    if (value === AUTO_OPTION) {
      this.chat.modelOverride.set(null);
      return;
    }
    const provider = value as ModelProviderId;
    const model = PROVIDER_MODEL_SUGGESTIONS[provider][0] ?? '';
    this.chat.modelOverride.set({ provider, model });
    // Kick off live model fetching for local providers (best-effort).
    if (provider === 'lmstudio') void this.loadLmstudioModels();
    else if (provider === 'ollama') void this.loadOllamaModels();
  }

  protected onModelChange(model: string): void {
    const current = this.chat.modelOverride();
    if (current) this.chat.modelOverride.set({ ...current, model });
  }

  protected onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    const request = this.draft().trim();
    if (!request || this.chat.busy()) return;
    this.draft.set('');
    this.pastedUrl.set(null);
    if (this.referenceOpen()) this.closeReference();
    // Pasted n8n/Flowise/Dify exports route to the migration converter.
    const foreign = this.importer.detect(request);
    if (foreign) {
      await this.importer.convert(foreign);
    } else {
      await this.chat.send(request, this.chat.mode());
    }
    setTimeout(() => this.inputRef()?.nativeElement.focus(), 0);
  }

  protected cancel(): void {
    this.chat.cancel();
  }

  protected applyProposal(turn: ChatTurn): void {
    void this.chat.applyProposal(turn);
  }

  /** Re-runs a user turn in the same mode. */
  protected reRunTurn(turn: ChatTurn): void {
    void this.chat.reRunTurn(turn);
  }

  /** Copies a turn's full text (or error) to the clipboard. */
  protected copyTurn(turn: ChatTurn): void {
    const text = turn.status === 'error' ? (turn.error ?? '') : turn.text;
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        this.copiedTurnId.set(turn.id);
        setTimeout(() => {
          if (this.copiedTurnId() === turn.id) this.copiedTurnId.set(null);
        }, 1600);
      })
      .catch(() => undefined);
  }

  /**
   * Sanitized markdown for an assistant turn. Goes through the shared
   * `renderMarkdown` rail (marked + DOMPurify) rather than calling `marked`
   * here, so the chat cannot drift from every other markdown surface in the
   * studio - this component had its own copy of the same two lines.
   */
  protected renderMarkdown(text: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(text));
  }

  /**
   * The proposal's steps: a one-line title plus the model's manual instructions.
   * A step without `detail` (a thread persisted before plans carried it) renders
   * as a plain row rather than an expander that opens onto nothing.
   */
  protected planSteps(turn: ChatTurn): { label: string; detail: string }[] {
    if (turn.attachment?.kind !== 'plan-proposal') return [];
    const labels = this.planOpSummary(turn);
    return turn.attachment.plan.ops.map((op, index) => ({
      label: labels[index] ?? String(op.op),
      detail: op.detail?.trim() ?? '',
    }));
  }

  /**
   * Expanded step keys, `turnId:index`. Component-local on purpose: the panel
   * and the expanded dialog are separate instances, and which step you opened
   * while reading is view state, not conversation state worth persisting.
   */
  private readonly openSteps = signal<ReadonlySet<string>>(new Set());

  protected isStepOpen(turn: ChatTurn, index: number): boolean {
    return this.openSteps().has(`${turn.id}:${index}`);
  }

  protected toggleStep(turn: ChatTurn, index: number): void {
    const key = `${turn.id}:${index}`;
    this.openSteps.update(open => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Opens or closes every step of a proposal at once. */
  protected toggleAllSteps(turn: ChatTurn): void {
    const steps = this.planSteps(turn);
    const allOpen = steps.every((step, index) => !step.detail || this.isStepOpen(turn, index));
    this.openSteps.update(open => {
      const next = new Set(open);
      steps.forEach((step, index) => {
        if (!step.detail) return;
        if (allOpen) next.delete(`${turn.id}:${index}`);
        else next.add(`${turn.id}:${index}`);
      });
      return next;
    });
  }

  /** True when at least one step of this proposal is expanded. */
  protected anyStepOpen(turn: ChatTurn): boolean {
    return this.planSteps(turn).some((_, index) => this.isStepOpen(turn, index));
  }

  protected planOpSummary(turn: ChatTurn): string[] {
    if (turn.attachment?.kind !== 'plan-proposal') return [];
    return turn.attachment.plan.ops.map(op => {
      switch (op.op) {
        case 'add':
          return `Add ${op.name ?? op.type ?? 'node'}`;
        case 'connect':
          return `Connect ${op.from ?? '?'} → ${op.to ?? '?'}`;
        case 'update':
          return `Update ${op.name ?? op.node ?? 'node'}`;
        case 'remove':
          return `Remove ${op.node ?? 'node'}`;
        case 'disconnect':
          return `Disconnect ${op.connection ?? 'connection'}`;
        case 'action':
          // Requirement 4.4: every op, including Action_Ops, gets a line.
          return op.action ? this.actions.describe(op.action, op.args ?? {}) : 'Studio action';
        default:
          return String(op.op);
      }
    });
  }

  protected modelLabel(turn: ChatTurn): string {
    if (!turn.modelRef) return '';
    if (turn.modelRef.provider === 'phorma-cloud') return 'Phorma Cloud';
    return turn.modelRef.model;
  }

  /**
   * Cost label for a turn. Phorma Cloud-billed turns render as plan CREDITS
   * (never dollars); BYO turns render USD, suffixed "(est.)" when the figure
   * comes from the pricing table — the same display rule as runs (EPIC 2).
   */
  protected costLabel(turn: ChatTurn): string {
    const usage = turn.usage;
    if (!usage || usage.costUsd <= 0) return '';
    if (usage.phormaCloud) {
      const credits = usage.costUsd * this.phormaCloud.creditsPerUsd();
      const rounded = credits < 1 ? Math.ceil(credits * 10) / 10 : Math.round(credits);
      return `${rounded} ${rounded === 1 ? 'credit' : 'credits'}`;
    }
    const usd =
      usage.costUsd < 0.01 ? `$${usage.costUsd.toFixed(4)}` : `$${usage.costUsd.toFixed(2)}`;
    return usage.estimated ? `${usd} (est.)` : usd;
  }

  // ── Context strip ────────────────────────────────────────────────────────

  /** Tooltip explaining why a workflow is in context and what it carries. */
  protected contextTitle(item: AssistantContextItem): string {
    const size = `${item.nodes} ${item.nodes === 1 ? 'node' : 'nodes'}, ${item.connections} ${
      item.connections === 1 ? 'connection' : 'connections'
    }`;
    const why = item.active
      ? 'The workflow you are looking at is always in context.'
      : 'Added from the document tab menu. Click to open it.';
    return `${item.name} - ${size}\n${why}`;
  }

  /** Clicking a context chip brings that workflow to the front. */
  protected focusContext(item: AssistantContextItem): void {
    this.workflow.activateDocument(item.docId);
  }

  protected removeContext(item: AssistantContextItem): void {
    this.context.remove(item.docId);
  }

  /**
   * Starts a real Stripe Checkout Session for the entry plan (requirement 27).
   *
   * Both upsells in this view - the plan-proposal "have it built for you" link and
   * the Agent-mode composer hint - land here. They are mid-sentence links with no
   * room for a plan comparison, so they buy {@link ENTRY_PLAN_TIER}; the recovery
   * affordance renders once under the composer rather than inside a message
   * bubble, which is why both share one {@link checkoutAttempted} flag.
   */
  protected async subscribe(): Promise<void> {
    const lookupKey = subscriptionLookupKey(ENTRY_PLAN_TIER);
    if (!lookupKey) return;
    this.checkoutAttempted.set(true);
    // Only a real hand-off opens the bounded `/api/me` window (requirements 29, 30).
    if (await this.billing.startCheckout(lookupKey)) this.billingRefresh.watch();
  }

  /**
   * The `past_due` counterpart to {@link subscribe} (requirement 17): the plan
   * proposal's inline CTA points at the Billing Portal rather than at a second
   * subscription, because the tenant already has one and it is the CARD that
   * failed.
   */
  protected async updateCard(): Promise<void> {
    this.checkoutAttempted.set(true);
    await this.billingCta.updateCard();
  }

  /** Performs whatever the failed turn's refusal earned (requirement 19). */
  protected runBillingCta(): void {
    this.billingCta.run(this.chat.billingRemedy());
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      const el = this.scrollRef()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  /**
   * Fetches the list of models available from the local LM Studio server.
   * Falls back to static suggestions when the server is unreachable.
   */
  private async loadLmstudioModels(): Promise<void> {
    this.loadingLmstudioModels.set(true);
    try {
      const { running, models } = await this.transport.listLmstudioModels(this.settings.lmstudioBaseUrl());
      this.lmstudioRunning.set(running);
      this.lmstudioModels.set(models);
    } catch {
      this.lmstudioRunning.set(false);
      this.lmstudioModels.set([]);
    } finally {
      this.loadingLmstudioModels.set(false);
    }
  }

  /**
   * Fetches the list of models installed in the local Ollama daemon.
   * Falls back to static suggestions when the daemon is unreachable.
   */
  private async loadOllamaModels(): Promise<void> {
    this.loadingOllamaModels.set(true);
    try {
      const { running, models } = await this.transport.listOllamaModels(this.settings.ollamaBaseUrl());
      this.ollamaRunning.set(running);
      this.ollamaModels.set(models);
    } catch {
      this.ollamaRunning.set(false);
      this.ollamaModels.set([]);
    } finally {
      this.loadingOllamaModels.set(false);
    }
  }
}
