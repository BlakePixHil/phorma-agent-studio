import { Injectable, signal } from '@angular/core';

/** Opens/closes version history for one saved workflow. */
@Injectable({ providedIn: 'root' })
export class VersionHistoryDialogService {
  readonly visible = signal(false);
  readonly workflowId = signal<string | null>(null);

  open(workflowId: string): void {
    this.workflowId.set(workflowId);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.workflowId.set(null);
  }
}
