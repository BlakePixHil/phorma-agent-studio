import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { TauriService } from '../../../core/tauri.service';
import { WorkflowService } from '../../../core/workflow.service';

/**
 * Cloud — deploy the worker, push the active workflow, and connect the live
 * monitor. Everything targets the USER'S Cloudflare account; Phorma hosts
 * nothing.
 *
 * Styled to match the confirmation dialog: a bespoke overlay (not p-dialog)
 * with the same card surface, icon-led header, and p-button actions.
 */
@Component({
  selector: 'app-cloud-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  templateUrl: './cloud-dialog.html',
  styleUrl: './cloud-dialog.scss',
})
export class CloudDialog {
  protected readonly dialog = inject(CloudDialogService);
  protected readonly cloud = inject(CloudService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly isDesktop = inject(TauriService).isDesktop;

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
