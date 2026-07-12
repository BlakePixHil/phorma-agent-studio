import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { ToastService, type ToastAction, type ToastEntry } from './toast.service';

/**
 * Renders the stack of active toasts in the top-right corner of the viewport.
 * Mounted once at the app root so any service can fire a toast.
 */
@Component({
  selector: 'app-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast.html',
  styleUrl: './toast.scss',
})
export class Toast {
  protected readonly toast = inject(ToastService);
  protected readonly entries = this.toast.entries;

  /** Id of the toast whose message was just copied (drives the ✓ feedback). */
  protected readonly copiedId = signal<number | null>(null);

  /** Runs a toast's CTA and dismisses it (e.g. "Buy credits" → open the credits dialog). */
  protected runAction(entry: ToastEntry, action: ToastAction): void {
    this.toast.dismiss(entry.id);
    action.onClick();
  }

  /** Copies a toast's summary + detail to the clipboard (for sharing errors). */
  protected async copy(entry: ToastEntry): Promise<void> {
    const text = entry.detail ? `${entry.summary}\n${entry.detail}` : entry.summary;
    try {
      await navigator.clipboard.writeText(text);
      this.copiedId.set(entry.id);
      setTimeout(() => {
        if (this.copiedId() === entry.id) this.copiedId.set(null);
      }, 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently ignore.
    }
  }
}
