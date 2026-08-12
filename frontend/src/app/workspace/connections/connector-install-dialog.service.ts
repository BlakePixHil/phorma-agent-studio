import { Injectable, signal } from '@angular/core';

import type { ConnectorBundle, ConnectorFinding } from '@phorma/engine';

/**
 * Opens/closes the connector install preview (P1-14) - mirrors
 * `ConnectionEditorDialogService`.
 *
 * A bundle NEVER installs straight from a file pick. It lands here first, so the
 * user sees what it declares, which credentials it will ask for, and where it
 * will send traffic before anything is written. That review step is the whole
 * reason installing a stranger's integration is a reasonable thing to do.
 */
@Injectable({ providedIn: 'root' })
export class ConnectorInstallDialogService {
  readonly visible = signal(false);
  /** The bundle under review. */
  readonly bundle = signal<ConnectorBundle | null>(null);
  /** Non-blocking findings from parsing, shown alongside the preview. */
  readonly warnings = signal<ConnectorFinding[]>([]);
  /** Suggested file name, shown so the user knows what they picked. */
  readonly fileName = signal<string | null>(null);

  open(bundle: ConnectorBundle, options: { warnings?: ConnectorFinding[]; fileName?: string } = {}): void {
    this.bundle.set(bundle);
    this.warnings.set(options.warnings ?? []);
    this.fileName.set(options.fileName ?? null);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.bundle.set(null);
    this.warnings.set([]);
    this.fileName.set(null);
  }
}
