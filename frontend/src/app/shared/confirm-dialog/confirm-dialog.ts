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
    // For prompt dialogs, focus the text input instead so the user can type.
    effect(() => {
      const active = this.active();
      if (!active) return;
      // Defer past the animation frame so PrimeNG has rendered the button.
      // Two rAFs ensure the DOM is committed and focusable.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (active.input) this.focusInput();
          else this.focusAcceptButton();
        }),
      );
    });
  }

  /** Live input value for the template (drives the disabled state of confirm). */
  protected inputValue(): string {
    return this.active()?.inputValue ?? '';
  }

  /** Whether the confirm button should be disabled for an empty required input. */
  protected confirmDisabled(): boolean {
    const active = this.active();
    if (!active?.input) return false;
    const required = active.input.required ?? true;
    return required && active.inputValue.trim().length === 0;
  }

  /** Called from the template on every input event. */
  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.confirmDialog.setInputValue(value);
  }

  /** Enter inside the text field confirms (when allowed). */
  protected onInputKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!this.confirmDisabled()) this.confirmDialog.accept();
  }

  /** Focuses the text input element. */
  private focusInput(): void {
    const card = document.querySelector('.phorma-confirm__card');
    card?.querySelector<HTMLInputElement>('.phorma-confirm__input')?.focus();
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
    // If focus is already on a button or the text input inside the dialog,
    // let it handle Enter.
    const target = ke.target as HTMLElement | null;
    if (target?.closest('.phorma-confirm__card button, .phorma-confirm__input')) return;
    ke.preventDefault();
    if (!this.confirmDisabled()) this.confirmDialog.accept();
  }
}
