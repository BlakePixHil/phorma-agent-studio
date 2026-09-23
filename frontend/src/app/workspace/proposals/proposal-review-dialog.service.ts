/**
 * Open/close state for the proposal review dialog
 * (multi-organisation-phorma, Requirement 12.6).
 *
 * A tiny service rather than a component input, for the same reason every other
 * dialog in the studio has one: the surface itself is behind `@defer` in
 * `app.html` so it stays out of the initial bundle (Requirement 18.4), and a
 * deferred component cannot be addressed by a template that has not loaded it yet.
 * Whoever opens it holds this instead.
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ProposalReviewDialogService {
  private readonly visibleState = signal(false);
  private readonly workflowIdState = signal<string | null>(null);

  readonly visible = this.visibleState.asReadonly();
  /** The workflow whose queue is under review. */
  readonly workflowId = this.workflowIdState.asReadonly();

  open(workflowId: string): void {
    if (!workflowId) return;
    this.workflowIdState.set(workflowId);
    this.visibleState.set(true);
  }

  close(): void {
    this.visibleState.set(false);
  }
}
