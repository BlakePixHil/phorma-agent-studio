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

/** Resolved value of {@link ConfirmDialogService.open} — carries the input. */
interface ConfirmDialogResolution {
  result: ConfirmDialogResult;
  inputValue: string;
}

/**
 * Optional text-input configuration. When present, the dialog renders a
 * single-line text field and resolves `confirm` with the entered value.
 * Used for rename / name prompts.
 */
export interface ConfirmDialogInput {
  /** Initial value (e.g. the current name when renaming). */
  initialValue?: string;
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Label for screen readers. */
  label?: string;
  /**
   * When true (default), the confirm action is disabled while the input is
   * empty after trimming.
   */
  required?: boolean;
  /** Max length enforced by the input element. */
  maxLength?: number;
}

interface ActiveConfirmDialog extends Required<Omit<ConfirmDialogRequest, 'alternateLabel'>> {
  alternateLabel: string | null;
  input: ConfirmDialogInput | null;
  /** Live value of the text input (kept in sync by the component). */
  inputValue: string;
  resolve: (resolution: ConfirmDialogResolution) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly activeState = signal<ActiveConfirmDialog | null>(null);

  readonly active = this.activeState.asReadonly();

  confirm(request: ConfirmDialogRequest): Promise<boolean> {
    return this.open(request).then(resolution => resolution.result === 'confirm');
  }

  /**
   * Opens a three-way dialog and resolves with `'confirm'`, `'alternate'`
   * (the optional middle button), or `'cancel'`. Use for Save / Discard /
   * Cancel flows: map `confirmLabel` → Discard, `alternateLabel` → Save.
   */
  confirmThreeWay(request: ConfirmDialogRequest): Promise<ConfirmDialogResult> {
    return this.open(request).then(resolution => resolution.result);
  }

  /**
   * Opens a dialog with a single text input. Resolves with the trimmed value
   * on confirm, or `null` when cancelled. The confirm button is disabled
   * while the input is empty (unless `required: false`).
   */
  prompt(request: ConfirmDialogRequest, input: ConfirmDialogInput): Promise<string | null> {
    return this.open({ ...request, input }).then(resolution =>
      resolution.result === 'confirm' ? resolution.inputValue.trim() : null,
    );
  }

  /** Updates the live input value (called by the dialog component on input). */
  setInputValue(value: string): void {
    const active = this.activeState();
    if (!active || !active.input) return;
    this.activeState.set({ ...active, inputValue: value });
  }

  private open(
    request: ConfirmDialogRequest & { input?: ConfirmDialogInput },
  ): Promise<ConfirmDialogResolution> {
    return new Promise(resolve => {
      this.activeState.set({
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel ?? 'Continue',
        cancelLabel: request.cancelLabel ?? 'Cancel',
        tone: request.tone ?? 'default',
        alternateLabel: request.alternateLabel ?? null,
        input: request.input ?? null,
        inputValue: request.input?.initialValue ?? '',
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
    const inputValue = active.inputValue;
    this.activeState.set(null);
    active.resolve({ result, inputValue });
  }
}
