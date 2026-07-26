import { Injectable, signal } from '@angular/core';

export type ToastSeverity = 'success' | 'warning' | 'error';

/** An optional single action button rendered in the toast (e.g. "Buy credits"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Short headline, e.g. "Function saved". */
  summary: string;
  /** Optional body text. */
  detail?: string;
  /** Defaults to 'success'. */
  severity?: ToastSeverity;
  /** Override the auto-dismiss delay (ms). Success defaults to 3000;
   *  warning/error stay until dismissed. */
  life?: number;
  /** Optional call-to-action button (e.g. deep-link to a fix/upsell). */
  action?: ToastAction;
}

export interface ToastEntry extends Required<Omit<ToastOptions, 'detail' | 'action'>> {
  id: number;
  detail?: string;
  action?: ToastAction;
}

/**
 * Ephemeral toast notifications. Mirrors the signal-based pattern used by
 * `ConfirmDialogService` so it stays OnPush-friendly and requires no RxJS.
 *
 * Severity drives both the left-border colour and the dismiss behaviour:
 * - `success` auto-dismisses after 3s.
 * - `warning` / `error` persist until the user clicks the × icon.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly entriesState = signal<ToastEntry[]>([]);
  private nextId = 0;

  /** All currently visible toasts, oldest first. */
  readonly entries = this.entriesState.asReadonly();

  /** Shows a toast and returns its id, so callers can dismiss it early. */
  show(options: ToastOptions): number {
    const severity = options.severity ?? 'success';
    const entry: ToastEntry = {
      id: this.nextId++,
      summary: options.summary,
      detail: options.detail,
      severity,
      // Success auto-dismisses; warnings/errors stay until dismissed.
      life: options.life ?? (severity === 'success' ? 3000 : 0),
      action: options.action,
    };
    this.entriesState.update(items => [...items, entry]);

    if (entry.life > 0) {
      setTimeout(() => this.dismiss(entry.id), entry.life);
    }
    return entry.id;
  }

  /** Convenience helpers — keep call sites terse. */
  success(summary: string, detail?: string): number {
    return this.show({ summary, detail, severity: 'success' });
  }

  warning(summary: string, detail?: string, action?: ToastAction): number {
    return this.show({ summary, detail, severity: 'warning', action });
  }

  error(summary: string, detail?: string, action?: ToastAction): number {
    return this.show({ summary, detail, severity: 'error', action });
  }

  dismiss(id: number): void {
    this.entriesState.update(items => items.filter(t => t.id !== id));
  }

  clear(): void {
    this.entriesState.set([]);
  }
}
