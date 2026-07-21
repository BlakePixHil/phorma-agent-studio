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
import { SelectModule } from 'primeng/select';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { AssistantChatService } from '../../../core/assistant-chat.service';
import type { AssistantMode, ChatTurn } from '../../../core/assistant-chat.model';
import { MigrationImportService } from '../../../core/migration/migration-import.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { CreditsDialogService } from '../../cloud/credits-dialog.service';
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
  imports: [FormsModule, SelectModule],
  templateUrl: './assistant-chat.html',
  styleUrl: './assistant-chat.scss',
})
export class AssistantChat {
  protected readonly chat = inject(AssistantChatService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly creditsDialog = inject(CreditsDialogService);
  private readonly importer = inject(MigrationImportService);
  private readonly sanitizer = inject(DomSanitizer);

  /** Wide layout (expanded dialog) vs compact (sidebar panel). */
  readonly wide = input(false);

  protected readonly modes = MODES;
  protected readonly draft = signal('');
  /** Turn id whose copy button briefly shows the "copied" check. */
  protected readonly copiedTurnId = signal<string | null>(null);

  private readonly scrollRef = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly inputRef = viewChild<ElementRef<HTMLTextAreaElement>>('chatInput');

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

  /** Model suggestions for the explicitly selected provider. */
  protected readonly modelSuggestions = computed(() => {
    const provider = this.chat.modelOverride()?.provider;
    return provider ? PROVIDER_MODEL_SUGGESTIONS[provider] : [];
  });

  /** Hint describing what the automatic route resolves to. */
  protected readonly autoHint = computed(() => {
    const model = this.chat.resolvedModel();
    const provider = MODEL_PROVIDERS.find(p => p.id === model.provider);
    return `${provider?.label ?? model.provider} · ${model.model}`;
  });

  protected readonly agentLocked = computed(() => !this.phormaCloud.subscribed());

  constructor() {
    // Keep the conversation pinned to the bottom as turns stream in.
    effect(() => {
      this.chat.activeThread();
      this.chat.streamingText();
      this.chat.activity();
      untracked(() => this.scrollToBottom());
    });
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

  /** Sanitized markdown for an assistant turn. */
  protected renderMarkdown(text: string): SafeHtml {
    const raw = marked.parse(text, { async: false });
    return this.sanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(raw));
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

  protected openSubscribe(): void {
    this.settingsDialog.open('cloud');
  }

  protected openCredits(): void {
    this.creditsDialog.open();
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      const el = this.scrollRef()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }
}
