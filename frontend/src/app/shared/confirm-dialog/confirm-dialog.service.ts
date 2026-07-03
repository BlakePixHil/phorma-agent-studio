import { Injectable, signal } from '@angular/core';

export interface ConfirmDialogRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /**
   * Optional third "alternate" action (e.g. "Save"), rendered between Cancel
   * and the primary action. When present, the dialog resolves via
   * {@link ConfirmDialogService.confirmThreeWay} with `'alternate'`.
   */
  alternateLabel?: string;
}

/** Result of a three-way dialog (Save / Discard / Cancel style). */
export type ConfirmDialogResult = 'confirm' | 'alternate' | 'cancel';

interface ActiveConfirmDialog extends Required<Omit<ConfirmDialogRequest, 'alternateLabel'>> {
  alternateLabel: string | null;
  resolve: (result: ConfirmDialogResult) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly activeState = signal<ActiveConfirmDialog | null>(null);

  readonly active = this.activeState.asReadonly();

  confirm(request: ConfirmDialogRequest): Promise<boolean> {
    return this.open(request).then(result => result === 'confirm');
  }

  /**
   * Opens a three-way dialog and resolves with `'confirm'`, `'alternate'`
   * (the optional middle button), or `'cancel'`. Use for Save / Discard /
   * Cancel flows: map `confirmLabel` → Discard, `alternateLabel` → Save.
   */
  confirmThreeWay(request: ConfirmDialogRequest): Promise<ConfirmDialogResult> {
    return this.open(request);
  }

  private open(request: ConfirmDialogRequest): Promise<ConfirmDialogResult> {
    return new Promise(resolve => {
      this.activeState.set({
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel ?? 'Continue',
        cancelLabel: request.cancelLabel ?? 'Cancel',
        tone: request.tone ?? 'default',
        alternateLabel: request.alternateLabel ?? null,
        resolve,
      });
    });
  }

  accept(): void {
    this.close('confirm');
  }

  alternate(): void {
    this.close('alternate');
  }

  cancel(): void {
    this.close('cancel');
  }

  private close(result: ConfirmDialogResult): void {
    const active = this.activeState();
    if (!active) return;
    this.activeState.set(null);
    active.resolve(result);
  }
}
