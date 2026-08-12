import { Injectable, signal } from '@angular/core';

/**
 * Opens/closes the "Package as connector" dialog (P1-14).
 *
 * Carries no state beyond visibility: the dialog reads the ACTIVE workflow when
 * it opens, because packaging is always "turn what I am looking at into
 * something shareable".
 */
@Injectable({ providedIn: 'root' })
export class ConnectorPackageDialogService {
  readonly visible = signal(false);

  /** Node ids to preselect, when packaging came from a canvas selection. */
  readonly preselectedNodeIds = signal<string[]>([]);

  open(nodeIds: readonly string[] = []): void {
    this.preselectedNodeIds.set([...nodeIds]);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.preselectedNodeIds.set([]);
  }
}
