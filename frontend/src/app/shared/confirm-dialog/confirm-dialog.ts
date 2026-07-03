import { ChangeDetectionStrategy, Component, HostListener, effect, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'app-confirm-dialog',
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
})
export class ConfirmDialog {
  protected readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly active = this.confirmDialog.active;

  constructor() {
    // Autofocus the primary (accept) button whenever a dialog becomes active.
    // This makes Enter trigger the confirm action — the expected default for
    // a confirmation dialog.
    effect(() => {
      const active = this.active();
      if (!active) return;
      // Defer past the animation frame so PrimeNG has rendered the button.
      // Two rAFs ensure the DOM is committed and focusable.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => this.focusAcceptButton()),
      );
    });
  }

  /** Focuses the accept (primary) button inside the dialog card. */
  private focusAcceptButton(): void {
    const card = document.querySelector('.phorma-confirm__card');
    if (!card) return;
    // The accept button is the last <button> in the actions footer — it's the
    // primary/danger action. Focusing it makes Enter trigger confirm.
    const buttons = card.querySelectorAll<HTMLButtonElement>('footer button');
    const accept = buttons[buttons.length - 1];
    accept?.focus();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.active()) this.confirmDialog.cancel();
  }

  /** Enter triggers the focused button — default to accept when nothing
   *  else in the dialog has focus. */
  @HostListener('document:keydown.enter', ['$event'])
  protected onEnter(e: Event): void {
    if (!this.active()) return;
    const ke = e as KeyboardEvent;
    // If focus is already on a button inside the dialog, let it handle Enter.
    const target = ke.target as HTMLElement | null;
    if (target?.closest('.phorma-confirm__card button')) return;
    ke.preventDefault();
    this.confirmDialog.accept();
  }
}
