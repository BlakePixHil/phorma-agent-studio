import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';

import type { Connection } from '@phorma/engine';

import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ConnectionEditorDialogService } from '../connection-editor-dialog.service';
import { ConnectionsService } from '../../../core/connections.service';
import { ToastService } from '../../../shared/toast/toast.service';

/**
 * The Connections panel (left sidebar): the global library of credential
 * connections (Requirements 2.1, 2.2, 19.5, 19.6). Create/edit/delete happen
 * in the connection editor dialog; this panel is the list + entry point,
 * mirroring the Skills panel.
 */
@Component({
  selector: 'app-connections-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule],
  templateUrl: './connections-panel.html',
  styleUrl: './connections-panel.scss',
})
export class ConnectionsPanel {
  protected readonly connections = inject(ConnectionsService);
  private readonly editor = inject(ConnectionEditorDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** connection id → number of saved workflows referencing it. */
  protected readonly usedBy = computed(() => {
    const counts = new Map<string, number>();
    for (const connection of this.connections.connections()) {
      counts.set(connection.id, this.connections.referencingWorkflows(connection.id).length);
    }
    return counts;
  });

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
