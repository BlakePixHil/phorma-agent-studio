import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DialogModule } from 'primeng/dialog';

import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { TauriService } from '../../../core/tauri.service';
import { WorkflowService } from '../../../core/workflow.service';

/**
 * Cloud — deploy the worker, push the active workflow, and connect the live
 * monitor. Everything targets the USER'S Cloudflare account; Phorma hosts
 * nothing.
 */
@Component({
  selector: 'app-cloud-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule],
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
}
