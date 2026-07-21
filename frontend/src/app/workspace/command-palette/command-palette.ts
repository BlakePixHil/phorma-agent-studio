import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { AssistantChatService } from '../../core/assistant-chat.service';
import { AssistantDialogService } from '../assistant/assistant-dialog.service';
import { CommandPaletteService, type BuilderMode } from '../../core/command-palette.service';
import { CreditsDialogService } from '../cloud/credits-dialog.service';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { SettingsDialogService } from '../settings/settings-dialog.service';
import { WorkflowBuilderService } from '../../core/workflow-builder.service';

/**
 * The AI command palette (Ctrl+P / Cmd+P) — a VS Code-style floating input
 * anchored near the top of the window. A Phorma Cloud subscriber describes
 * a workflow ("What would you like to build?") and the AI builds it on the
 * active canvas, in Plan mode (one-shot plan, animated apply) or Agent mode
 * (live tool loop).
 *
 * Phorma Cloud exclusive: non-subscribers see an upsell state instead of the
 * input (the /api/infer proxy re-gates server-side regardless).
 */
@Component({
  selector: 'app-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.scss',
})
export class CommandPalette {
  protected readonly palette = inject(CommandPaletteService);
  protected readonly builder = inject(WorkflowBuilderService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly creditsDialog = inject(CreditsDialogService);
  private readonly chat = inject(AssistantChatService);
  private readonly assistantDialog = inject(AssistantDialogService);

  protected readonly draft = signal('');
  /** Thread id of the last recorded exchange (drives "Continue in chat"). */
  protected readonly lastThreadId = signal<string | null>(null);

  private readonly inputRef = viewChild<ElementRef<HTMLTextAreaElement>>('promptInput');

  /** True when the palette should show the subscriber input. */
  protected readonly canBuild = computed(() => this.phormaCloud.subscribed());

  /** True while a build is running (input locked, status showing). */
  protected readonly busy = computed(() => {
    const status = this.builder.status();
    return status === 'thinking' || status === 'applying';
  });

  constructor() {
    // Autofocus the input each time the palette opens; reset stale results.
    // The body is untracked so this effect depends ONLY on `visible` —
    // builder.reset() reads the status signal, and tracking it would re-run
    // the effect (and wrongly reset state) on every status transition.
    effect(() => {
      if (!this.palette.visible()) return;
      untracked(() => this.builder.reset());
      // Waits a frame so the element exists post-@if render.
      setTimeout(() => this.inputRef()?.nativeElement.focus(), 0);
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.palette.visible()) return;
    if (this.busy()) this.builder.cancel();
    this.palette.close();
  }

  protected onBackdropClick(): void {
    if (this.busy()) return;
    this.palette.close();
  }

  protected setMode(mode: BuilderMode): void {
    if (this.busy()) return;
    this.palette.setMode(mode);
  }

  protected onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    const request = this.draft().trim();
    if (!request || this.busy() || !this.canBuild()) return;
    this.lastThreadId.set(null);
    await this.builder.run(request, this.palette.mode());
    if (this.builder.status() === 'done') {
      this.draft.set('');
      // Record the exchange as a chat thread so the user can keep refining
      // it in the Assistant (panel or expanded dialog).
      const thread = await this.chat.recordExternalExchange({
        request,
        mode: this.palette.mode(),
        summary: this.builder.summary() ?? 'Workflow updated.',
        model: this.builder.resolveModel(),
      });
      this.lastThreadId.set(thread.id);
      // Let the user read the summary briefly, then get out of the way —
      // the Revert/Keep bar (canvas-anchored) persists after close.
      setTimeout(() => {
        if (this.builder.status() === 'done') this.palette.close();
      }, 2600);
    }
  }

  /** Opens the recorded exchange in the Assistant dialog for refinement. */
  protected continueInChat(): void {
    const id = this.lastThreadId();
    if (!id) return;
    this.palette.close();
    void this.chat.openThreadById(id).then(() => this.assistantDialog.open());
  }

  /** Stops the in-flight build without closing the palette. */
  protected stop(): void {
    this.builder.cancel();
  }

  protected retry(): void {
    this.builder.reset();
    setTimeout(() => this.inputRef()?.nativeElement.focus(), 0);
  }

  protected signIn(): void {
    this.palette.close();
    this.phormaCloud.signIn();
  }

  protected openSubscribe(): void {
    this.palette.close();
    this.settingsDialog.open('cloud');
  }

  protected openCredits(): void {
    this.palette.close();
    this.creditsDialog.open();
  }
}
