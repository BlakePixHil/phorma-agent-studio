import { Injectable, signal } from '@angular/core';

/**
 * Tracks the node-catalog entry being dragged from the Agents palette.
 *
 * The DataTransfer payload (PHORMA_NODE_MIME) is the primary channel; this
 * signal is the Angular-side fallback because some webviews clear
 * `dataTransfer` between dragstart and drop.
 *
 * Also carries click-to-add requests: clicking a palette item asks the canvas
 * to place that node at the viewport centre (keyboard/AT-friendly, and the
 * fastest way to build when precision doesn't matter yet).
 */
@Injectable({ providedIn: 'root' })
export class NodeDragService {
  private readonly activeIdState = signal<string | null>(null);
  private addNonce = 0;

  /** Catalog entry id currently being dragged, or null. */
  readonly activeId = this.activeIdState.asReadonly();

  /** Pending click-to-add request (nonce distinguishes repeat adds). */
  readonly addRequest = signal<{ entryId: string; nonce: number } | null>(null);

  start(entryId: string): void {
    this.activeIdState.set(entryId);
  }

  stop(): void {
    this.activeIdState.set(null);
  }

  /** Asks the canvas to add this catalog entry at the viewport centre. */
  requestAdd(entryId: string): void {
    this.addNonce += 1;
    this.addRequest.set({ entryId, nonce: this.addNonce });
  }
}
