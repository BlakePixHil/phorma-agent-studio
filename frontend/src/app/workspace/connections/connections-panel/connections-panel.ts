import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';

import {
  connectorFileName,
  serializeConnectorBundle,
  type Connection,
} from '@phorma/engine';

import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ConnectionEditorDialogService } from '../connection-editor-dialog.service';
import { ConnectionsService } from '../../../core/connections.service';
import { ConnectorInstallDialogService } from '../connector-install-dialog.service';
import { ConnectorPackageDialogService } from '../connector-package-dialog.service';
import { ConnectorsService } from '../../../core/connectors.service';
import { PanelCard } from '../../../shared/panel-card/panel-card';
import { ToastService } from '../../../shared/toast/toast.service';
import { isBuiltInConnector, type InstalledConnector } from '../../../core/connectors.model';

/**
 * The Connections panel (left sidebar): installed connectors (P1-14) above the
 * global library of credential connections (Requirements 2.1, 2.2, 19.5, 19.6).
 *
 * Connectors sit here rather than in a panel of their own because a connector is
 * how a connection gets set up - the two are read together, and splitting them
 * would mean a second place to look for "why can this not reach the API".
 * Create/edit/delete of a connection happens in the connection editor dialog;
 * installing a connector happens in the install preview dialog.
 */
@Component({
  selector: 'app-connections-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule, PanelCard],
  templateUrl: './connections-panel.html',
  styleUrl: './connections-panel.scss',
})
export class ConnectionsPanel {
  protected readonly connections = inject(ConnectionsService);
  protected readonly connectors = inject(ConnectorsService);
  private readonly editor = inject(ConnectionEditorDialogService);
  private readonly installDialog = inject(ConnectorInstallDialogService);
  private readonly packageDialog = inject(ConnectorPackageDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** Whether the connectors section is collapsed. */
  protected readonly connectorsCollapsed = signal(false);

  /** connection id → number of saved workflows referencing it. */
  protected readonly usedBy = computed(() => {
    const counts = new Map<string, number>();
    for (const connection of this.connections.connections()) {
      counts.set(connection.id, this.connections.referencingWorkflows(connection.id).length);
    }
    return counts;
  });

  /** connector id → secret names still needing a value. */
  protected readonly missingSecrets = computed(() => {
    const missing = new Map<string, string[]>();
    for (const connector of this.connectors.connectors()) {
      missing.set(connector.id, this.connectors.missingSecretKeys(connector));
    }
    return missing;
  });

  /**
   * connector id → the connection it is bound to.
   *
   * Only interesting once there is more than one connection, which is exactly
   * when a row saying "REST API (generic)" with no further detail becomes
   * ambiguous. A binding whose connection has since been deleted resolves to an
   * explicit label rather than a raw id, the same rule the usage ledger follows
   * for deleted nodes.
   */
  protected readonly bindings = computed(() => {
    const names = new Map(this.connections.connections().map(item => [item.id, item.name]));
    const bindings = new Map<string, { label: string; missing: boolean }>();
    for (const connector of this.connectors.connectors()) {
      const id = connector.connectionId;
      if (!id) continue;
      const name = names.get(id);
      bindings.set(
        connector.id,
        name ? { label: name, missing: false } : { label: 'Connection removed', missing: true },
      );
    }
    return bindings;
  });

  protected toggleConnectors(): void {
    this.connectorsCollapsed.update(value => !value);
  }

  /** Opens the packaging dialog for the active workflow's data steps. */
  protected packageConnector(): void {
    this.packageDialog.open();
  }

  protected isBuiltIn(connector: InstalledConnector): boolean {
    return isBuiltInConnector(connector.id);
  }

  protected stepCount(connector: InstalledConnector): number {
    return connector.bundle.steps?.length ?? 0;
  }

  // ── Connectors ───────────────────────────────────────────────────────────

  /**
   * Reads a picked `.connector.json` and opens the install preview. Nothing is
   * written by picking a file: review comes first, always.
   */
  protected async openConnectorFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const parsed = this.connectors.parse(await file.text());
    if (!parsed.ok) {
      const [first, ...rest] = parsed.findings.filter(finding => finding.severity === 'error');
      this.toast.error(
        'That connector cannot be installed',
        first
          ? `${first.path ? `${first.path}: ` : ''}${first.message}` +
              (rest.length > 0 ? ` (+${rest.length} more)` : '')
          : 'The file could not be read as a connector.',
      );
      return;
    }
    this.installDialog.open(parsed.bundle, { warnings: parsed.findings, fileName: file.name });
  }

  /**
   * Opens a connector in the install preview: for a built-in that is how it gets
   * adopted, and for one already installed it is how its connection gets set up
   * or pointed somewhere else.
   */
  protected setUpConnector(connector: InstalledConnector, event: Event): void {
    event.stopPropagation();
    this.installDialog.open(connector.bundle);
  }

  /** Downloads the bundle as a `.connector.json` file, ready to share. */
  protected exportConnector(connector: InstalledConnector, event: Event): void {
    event.stopPropagation();
    const blob = new Blob([serializeConnectorBundle(connector.bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = connectorFileName(connector.bundle);
    anchor.click();
    // Deferred: revoking in the same tick can invalidate the blob before the
    // browser has read it, producing an empty download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  protected async removeConnector(connector: InstalledConnector, event: Event): Promise<void> {
    event.stopPropagation();
    const confirmed = await this.confirmDialog.confirm({
      title: 'Remove connector?',
      message:
        `"${connector.bundle.name}" and its ${this.stepCount(connector)} palette ` +
        `${this.stepCount(connector) === 1 ? 'step' : 'steps'} will be removed. Nodes already on a ` +
        `canvas keep working - they are ordinary data nodes - and the connection and its secrets ` +
        `are left in place.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await this.connectors.remove(connector.id);
      this.toast.success('Connector removed', connector.bundle.name);
    } catch (error) {
      this.toast.error('Remove failed', error instanceof Error ? error.message : String(error));
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────

  protected newConnection(): void {
    this.editor.openNew();
  }

  protected editConnection(connection: Connection): void {
    this.editor.openEdit(connection);
  }

  protected async deleteConnection(connection: Connection, event: Event): Promise<void> {
    event.stopPropagation();
    const referencing = this.connections.referencingWorkflows(connection.id);
    const message =
      referencing.length > 0
        ? `"${connection.name}" is used by ${referencing.length} workflow${referencing.length === 1 ? '' : 's'}: ` +
          `${referencing.map(w => w.name).join(', ')}. Deleting it removes every stored secret; those ` +
          `workflows will fail to resolve this connection at run time.`
        : `"${connection.name}" and every secret stored for it will be removed. This can't be undone.`;

    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete connection?',
      message,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await this.connections.remove(connection.id);
      this.toast.success('Connection deleted', connection.name);
    } catch (error) {
      this.toast.error('Delete failed', error instanceof Error ? error.message : String(error));
    }
  }
}
