import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';

import { WorkflowService } from '../../../core/workflow.service';
import { SettingsService } from '../../../core/settings.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../../core/workflow-templates';
import type { WorkflowSpec } from '../../../core/workflow.model';

/**
 * The Workflows panel (left side): the saved workflow library plus the
 * built-in template gallery. Click to open in a tab; templates open as
 * fresh unsaved copies; the trash affordance deletes from storage after
 * confirmation.
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
  private readonly settings = inject(SettingsService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** Built-in template gallery (registry-driven). */
  protected readonly templates = WORKFLOW_TEMPLATES;

  protected open(spec: WorkflowSpec): void {
    this.workflow.openWorkflow(spec.id);
  }

  /** Opens a template as a fresh unsaved workflow tab. */
  protected openTemplate(template: WorkflowTemplate): void {
    this.workflow.importSpec(template.build());
  }

  protected async rename(event: Event, spec: WorkflowSpec): Promise<void> {
    event.stopPropagation();
    const next = await this.confirmDialog.prompt(
      {
        title: 'Rename workflow',
        message: 'Enter a new name for this workflow.',
        confirmLabel: 'Rename',
        cancelLabel: 'Cancel',
      },
      {
        initialValue: spec.name,
        label: 'Workflow name',
        maxLength: 80,
      },
    );
    if (next === null) return;
    const renamed = await this.workflow.renameInLibrary(spec.id, next);
    if (renamed) this.toast.success(`Renamed to “${renamed}”`);
  }

  protected async remove(event: Event, spec: WorkflowSpec): Promise<void> {
    event.stopPropagation();
    // Confirmation is skippable via Settings → General.
    const confirmed = this.settings.confirmWorkflowDelete()
      ? await this.confirmDialog.confirm({
          title: 'Delete workflow?',
          message: `"${spec.name}" will be removed from your library. Open tabs keep their copy.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Keep',
          tone: 'danger',
        })
      : true;
    if (confirmed) void this.workflow.removeFromLibrary(spec.id);
  }
}
