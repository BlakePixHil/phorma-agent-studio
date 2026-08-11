import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { WorkflowService } from '../../../core/workflow.service';
import { WorkflowVersionsService } from '../../../core/workflow-versions.service';
import { CloudService } from '../../../core/cloud.service';
import { SettingsService } from '../../../core/settings.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { PanelCard } from '../../../shared/panel-card/panel-card';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../../core/workflow-templates';
import type { WorkflowSpec } from '../../../core/workflow.model';
import { VersionHistoryDialogService } from '../version-history-dialog.service';

/**
 * The Workflows panel (left side): the saved workflow library plus the
 * built-in template gallery. Click to open in a tab; templates open as
 * fresh unsaved copies; the trash affordance deletes from storage after
 * confirmation.
 */
@Component({
  selector: 'app-workflows-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, PanelCard],
  templateUrl: './workflows-panel.html',
  styleUrl: './workflows-panel.scss',
})
export class WorkflowsPanel {
  protected readonly workflow = inject(WorkflowService);
  protected readonly versions = inject(WorkflowVersionsService);
  private readonly cloud = inject(CloudService);
  private readonly settings = inject(SettingsService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  private readonly versionHistory = inject(VersionHistoryDialogService);

  /** Built-in template gallery (registry-driven). */
  protected readonly templates = WORKFLOW_TEMPLATES;

  /** Whether the templates section is collapsed. */
  protected readonly templatesCollapsed = signal(false);

  protected open(spec: WorkflowSpec): void {
    this.workflow.openWorkflow(spec.id);
  }

  protected toggleTemplates(): void {
    this.templatesCollapsed.update(v => !v);
  }

  protected openHistory(event: Event, spec: WorkflowSpec): void {
    event.stopPropagation();
    this.versionHistory.open(spec.id);
  }

  /** Whether a library workflow has been deployed to a cloud runtime. */
  protected isDeployed(spec: WorkflowSpec): boolean {
    return this.versions.deployedWorkflowIds().has(spec.id);
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
    // A deployed workflow ALWAYS confirms, even with the confirmation turned off
    // in Settings → General: that setting is about a local library delete, and
    // this delete also takes a published portal offline and destroys the cloud
    // deployment. Saying so is the difference between a delete and a surprise.
    const deployed = this.isDeployed(spec);
    const confirmed =
      this.settings.confirmWorkflowDelete() || deployed
        ? await this.confirmDialog.confirm({
            title: 'Delete workflow?',
            message: deployed
              ? `"${spec.name}" will be removed from your library, and its cloud deployment will be ` +
                `torn down: scheduled triggers stop, any published portal goes offline immediately, ` +
                `and the cloud copy of its run history and usage is deleted. Open tabs keep their copy.`
              : `"${spec.name}" will be removed from your library. Open tabs keep their copy.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Keep',
            tone: 'danger',
          })
        : true;
    if (!confirmed) return;
    // Tear down the cloud deployment first (best-effort): if this workflow is
    // deployed to Phorma Cloud, its Durable Object, portal and session DOs must
    // be purged or they hang around with no way for the user to remove them
    // after the local workflow is gone. A failure (cloud unreachable, a run in
    // progress) only warns - the local delete still completes so the user is
    // never stuck, and the toast tells them to retry from the Cloud dialog.
    await this.cloud.purgeIfDeployed(spec.id).catch(() => undefined);
    void this.workflow.removeFromLibrary(spec.id);
  }
}
