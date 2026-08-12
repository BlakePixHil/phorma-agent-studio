import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';

import { ConfirmDialogService } from '../confirm-dialog/confirm-dialog.service';
import { PanelExpandService, type ExpandablePanelId } from '../../core/panel-expand.service';

/**
 * The shared chrome for an expanded side panel.
 *
 * Mirrors the bespoke overlay pattern used by every other dialog in the app
 * (cloud, credits, assistant, skill editor) — there is no `p-dialog` here —
 * but centralises the scrim, card sizing, header, close affordances and
 * focus handling so the four expanded panels stay pixel-consistent.
 *
 * Content is projected into a flex body that owns no scrolling: children
 * decide which of their columns scroll.
 */
@Component({
  selector: 'app-expanded-panel-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './expanded-panel-dialog.html',
  styleUrl: './expanded-panel-dialog.scss',
})
export class ExpandedPanelDialog {
  private readonly expand = inject(PanelExpandService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  /** Which panel this shell renders; drives visibility. */
  readonly panelId = input.required<ExpandablePanelId>();

  readonly title = input.required<string>();
  readonly subtitle = input<string>('');

  /** CSS width for the card. */
  readonly width = input<string>('min(1240px, 100%)');
  /**
   * CSS height for the card. Dialogs whose body is a fixed workbench (the
   * prompt editor, the evals views) want the full height; content-driven ones
   * (properties, usage) pass `auto` so the card shrinks rather than leaving a
   * band of empty background under the last field.
   */
  readonly height = input<string>('min(820px, calc(100vh - 48px))');

  /** When true, Esc and backdrop clicks are ignored (busy states). */
  readonly blockClose = input<boolean>(false);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  protected readonly visible = () => this.expand.isOpen(this.panelId());

  constructor() {
    // Move focus into the card on open so Esc/Tab are scoped to the dialog.
    effect(() => {
      if (!this.visible()) return;
      // Defer past the @if materialising the card.
      queueMicrotask(() => this.card()?.nativeElement.focus());
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.visible() || this.blockClose()) return;
    // A confirmation summoned from inside this dialog layers above it and owns
    // Escape; closing both at once would discard the user's pending decision.
    if (this.confirmDialog.active()) return;
    this.expand.close();
  }

  protected onBackdropClick(): void {
    if (this.blockClose() || this.confirmDialog.active()) return;
    this.expand.close();
  }

  protected close(): void {
    this.expand.close();
  }
}
