import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';

import { WorkflowService } from '../../../core/workflow.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import type { WorkflowSpec } from '../../../core/workflow.model';

/**
 * The Workflows panel (left side): the saved workflow library. Click to open
 * in a tab; the trash affordance deletes from storage after confirmation.
 */
@Component({
  selector: 'app-workflows-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  templateUrl: './workflows-panel.html',
  styleUrl: './workflows-panel.scss',
})
export class WorkflowsPanel {
  protected readonly workflow = inject(WorkflowService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  protected open(spec: WorkflowSpec): void {
    this.workflow.openWorkflow(spec.id);
  }

  protected async remove(event: Event, spec: WorkflowSpec): Promise<void> {
    event.stopPropagation();
    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete workflow?',
      message: `"${spec.name}" will be removed from your library. Open tabs keep their copy.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (confirmed) void this.workflow.removeFromLibrary(spec.id);
  }
}
