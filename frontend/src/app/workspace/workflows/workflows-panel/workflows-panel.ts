import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';

import { CapabilityService } from '../../../core/capability.service';
import { CloudLibrary } from '../../cloud-library/cloud-library';
import { WorkflowBackupService } from '../../../core/cloud/workflow-backup.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
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
 *
 * In Cloud_Library mode (multi-organisation Requirement 9.1) it renders the
 * organisation's DEPLOYED workflows instead, behind `@defer (on immediate)` so the
 * surface costs the initial bundle nothing. A member has no local library to show
 * and cannot save into one, so this is a replacement rather than an addition.
 */
@Component({
  selector: 'app-workflows-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule, PanelCard, CloudLibrary],
  templateUrl: './workflows-panel.html',
  styleUrl: './workflows-panel.scss',
})
export class WorkflowsPanel {
  protected readonly workflow = inject(WorkflowService);
  // `CapabilityService` injects nothing at all, so this edge cannot pull a member
  // of the NG0200 run/model/cloud cycle into the panel.
  private readonly capability = inject(CapabilityService);

  /**
   * Whether this session works out of the cloud only.
   *
   * Read straight off the capability seam rather than compared here: the one place
   * a level decision is made is `CapabilityService`, and
   * `scripts/check-capability-isolation.mjs` fails a level token compared anywhere
   * else.
   */
  protected readonly cloudLibraryOnly = this.capability.cloudLibraryOnly;
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

  // ── Restore banner (cloud-workflow-backup Requirement 18) ─────────────────

  private readonly backup = inject(WorkflowBackupService);
  private readonly settingsDialog = inject(SettingsDialogService);

  /** Dismissed for this session. Session state - deliberately not persisted. */
  private readonly restoreDismissed = signal(false);
  protected readonly restoring = signal(false);

  /** Backups that could be restored, tombstones included - they still work. */
  protected readonly restorableCount = computed(
    () => this.backup.backups().length + this.backup.tombstones().length,
  );

  /**
   * Whether to offer restore.
   *
   * Only on an EMPTY library (Requirement 18.6): somebody with work in progress does
   * not need to be told about a backup, and a banner over their workflow list would
   * be noise. `loaded()` gates it so a slow list read cannot flash the banner at a
   * user who does have workflows.
   */
  protected readonly showRestoreBanner = computed(
    () =>
      !this.restoreDismissed() &&
      this.workflow.libraryLoaded() &&
      this.workflow.library().length === 0 &&
      this.backup.loaded() &&
      this.restorableCount() > 0,
  );

  /** Dismisses it. Restore stays reachable from Settings > Cloud (18.4). */
  protected dismissRestore(): void {
    this.restoreDismissed.set(true);
  }

  protected openBackupSettings(): void {
    this.settingsDialog.open('cloud');
  }

  /**
   * Restores everything available.
   *
   * `replace` rather than `ask`: the library is empty, so there is nothing to
   * collide with, and N dialogs is not a recovery flow. Reports the counts and
   * leaves a PARTIAL result in place rather than rolling back what worked
   * (Requirement 18.5) - a half-recovered library is strictly better than none.
   */
  protected async restoreAll(): Promise<void> {
    this.restoring.set(true);
    try {
      const targets = [...this.backup.backups(), ...this.backup.tombstones()];
      let restored = 0;
      let failed = 0;
      const missing = new Set<string>();
      for (const row of targets) {
        const result = await this.backup.restore(row.workflowId, { collision: 'replace' });
        if (result.outcome === 'restored' || result.outcome === 'replaced') restored += 1;
        else failed += 1;
        for (const name of result.missingConnections) missing.add(name);
      }

      const detail = [
        missing.size > 0 ? `Reconnect ${[...missing].join(', ')} before running them.` : '',
        'Prompts, skills and connectors are not part of a backup.',
      ]
        .filter(part => part.length > 0)
        .join(' ');

      if (failed === 0) {
        this.toast.success(
          `Restored ${restored} ${restored === 1 ? 'workflow' : 'workflows'}`,
          detail,
        );
      } else {
        this.toast.warning(
          `Restored ${restored} of ${targets.length}`,
          `${failed} could not be restored. ${detail}`.trim(),
        );
      }
      this.restoreDismissed.set(true);
    } finally {
      this.restoring.set(false);
    }
  }

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
  protected async openTemplate(template: WorkflowTemplate): Promise<void> {
    this.workflow.importSpec(await template.build());
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
