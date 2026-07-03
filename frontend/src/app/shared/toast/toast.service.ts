import { Injectable, signal } from '@angular/core';

export type ToastSeverity = 'success' | 'warning' | 'error';

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
}

export interface ToastEntry extends Required<Omit<ToastOptions, 'detail'>> {
  id: number;
  detail?: string;
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

  show(options: ToastOptions): void {
    const severity = options.severity ?? 'success';
    const entry: ToastEntry = {
      id: this.nextId++,
      summary: options.summary,
      detail: options.detail,
      severity,
      // Success auto-dismisses; warnings/errors stay until dismissed.
      life: options.life ?? (severity === 'success' ? 3000 : 0),
    };
    this.entriesState.update(items => [...items, entry]);

    if (entry.life > 0) {
      setTimeout(() => this.dismiss(entry.id), entry.life);
    }
  }

  /** Convenience helpers — keep call sites terse. */
  success(summary: string, detail?: string): void {
    this.show({ summary, detail, severity: 'success' });
  }

  warning(summary: string, detail?: string): void {
    this.show({ summary, detail, severity: 'warning' });
  }

  error(summary: string, detail?: string): void {
    this.show({ summary, detail, severity: 'error' });
  }

  dismiss(id: number): void {
    this.entriesState.update(items => items.filter(t => t.id !== id));
  }

  clear(): void {
    this.entriesState.set([]);
  }
}
