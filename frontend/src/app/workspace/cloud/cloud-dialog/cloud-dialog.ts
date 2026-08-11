import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { PhormaCloudIcon } from '../../../shared/icons/phorma-cloud-icon';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { PhormaCloudService, tierLabel } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { TauriService } from '../../../core/tauri.service';
import { WorkflowService } from '../../../core/workflow.service';

/**
 * Cloud — push the active workflow and connect the live monitor.
 *
 * Branches on the chosen provider (Settings → Cloud):
 *  - **Phorma Cloud**: managed hosting. Push + monitor only; no
 *    infrastructure vocabulary, no deploy step.
 *  - **Your own Cloudflare**: the full technical flow — deploy the worker
 *    with wrangler, set URL/token, then push + monitor.
 *
 * Styled to match the confirmation dialog: a bespoke overlay (not p-dialog)
 * with the same card surface, icon-led header, and p-button actions.
 */
@Component({
  selector: 'app-cloud-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, ButtonModule, TooltipModule, PhormaCloudIcon],
  templateUrl: './cloud-dialog.html',
  styleUrl: './cloud-dialog.scss',
})
export class CloudDialog {
  protected readonly dialog = inject(CloudDialogService);
  protected readonly cloud = inject(CloudService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly settings = inject(SettingsService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  protected readonly tierLabel = tierLabel;
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly isDesktop = inject(TauriService).isDesktop;

  /** The chosen deploy target ('cloudflare' fallback keeps legacy behavior). */
  protected readonly provider = computed(() => this.settings.cloudProvider() ?? 'cloudflare');

  constructor() {
    // Refresh the account chip and the deployment status whenever the dialog
    // opens - both providers deploy one instance per workflow, so the status
    // check applies regardless of which one is active.
    effect(() => {
      if (!this.dialog.visible()) return;
      const workflowId = this.workflow.activeDoc()?.workflowId;
      untracked(() => {
        if (this.provider() === 'phorma') void this.phormaCloud.refresh();
        this.cloud.deployedStatus.set(null);
        this.cloud.deployedStatusWorkflowId.set(null);
        if (workflowId) void this.cloud.refreshStatus(workflowId);
      });
    });
  }

  /** Jumps to Settings → Cloud to change the provider. */
  protected openCloudSettings(): void {
    this.dialog.close();
    this.settingsDialog.open('cloud');
  }

  /** Confirms, then removes the active workflow's deployed spec. */
  protected async removeFromCloud(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Remove from cloud?',
      message:
        `"${this.workflow.activeName()}" will stop running in the cloud immediately - scheduled ` +
        `triggers, manual runs and the live monitor all need a fresh push afterward. Run history is kept.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.cloud.removeWorkflow(workflowId);
  }

  protected onUrlInput(event: Event): void {
    this.cloud.setWorkerUrl((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onTokenInput(event: Event): void {
    this.cloud.setToken((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onFolderInput(event: Event): void {
    this.cloud.setCloudFolder((event.target as HTMLInputElement | null)?.value ?? '');
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }
}
