import { Injectable, signal } from '@angular/core';

/**
 * Opens/closes the expanded Assistant dialog (the large chat surface the
 * sidebar panel's expand button leads to). Conversation state itself lives
 * in `AssistantChatService` — the dialog and the panel are two views over
 * the same thread.
 */
@Injectable({ providedIn: 'root' })
export class AssistantDialogService {
  readonly visible = signal(false);

  open(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }
}
