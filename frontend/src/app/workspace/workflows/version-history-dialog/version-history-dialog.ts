import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';

import { WorkflowService } from '../../../core/workflow.service';
import { WorkflowVersionsService } from '../../../core/workflow-versions.service';
import { diffWorkflowSpecs } from '../../../core/workflow-diff';
import type { WorkflowVersion } from '../../../core/workflow-versions.model';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { VersionHistoryDialogService } from '../version-history-dialog.service';

@Component({
  selector: 'app-version-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule],
  templateUrl: './version-history-dialog.html',
  styleUrl: './version-history-dialog.scss',
})
export class VersionHistoryDialog {
  protected readonly dialog = inject(VersionHistoryDialogService);
  protected readonly versions = inject(WorkflowVersionsService);
  private readonly workflow = inject(WorkflowService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() =>
    this.versions.versions().find(version => version.id === this.selectedId()) ?? this.versions.versions()[0] ?? null,
  );
  protected readonly current = computed(() => {
    const id = this.dialog.workflowId();
    return this.workflow.library().find(spec => spec.id === id) ?? null;
  });
  protected readonly diff = computed(() => {
    const selected = this.selected();
    const current = this.current();
    return selected && current ? diffWorkflowSpecs(selected.spec, current) : [];
  });

  constructor() {
    effect(() => {
      const workflowId = this.dialog.workflowId();
      if (!this.dialog.visible() || !workflowId) return;
      untracked(() => {
        this.selectedId.set(null);
        void this.versions.load(workflowId);
      });
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }

  protected select(version: WorkflowVersion): void {
    this.selectedId.set(version.id);
  }

  protected preview(): void {
    const version = this.selected();
    if (!version) return;
    this.workflow.openVersionSnapshot(version.spec);
    this.dialog.close();
  }

  protected async restore(): Promise<void> {
    const version = this.selected();
    if (!version) return;
    const confirmed = await this.confirm.confirm({
      title: 'Restore this version?',
      message: 'The current workflow will be saved as a safety version before this snapshot becomes current.',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    if (await this.workflow.restoreVersion(version)) {
      await this.versions.load(version.workflowId);
      this.toast.success('Version restored', 'The selected snapshot is now the current workflow.');
    }
  }

  protected triggerLabel(version: WorkflowVersion): string {
    if (version.deployed || version.trigger === 'deploy') return 'Deployed';
    if (version.trigger === 'autosave') return 'Autosave';
    if (version.trigger === 'restore') return 'Restored';
    return 'Saved';
  }

  protected triggerIcon(version: WorkflowVersion): string {
    if (version.deployed || version.trigger === 'deploy') return 'ti ti-cloud-up';
    if (version.trigger === 'autosave') return 'ti ti-refresh';
    if (version.trigger === 'restore') return 'ti ti-history';
    return 'ti ti-device-floppy';
  }

  /** CSS class suffix for per-trigger color coding (saved/autosave/deploy/restore). */
  protected triggerClass(version: WorkflowVersion): string {
    if (version.deployed || version.trigger === 'deploy') return 'deploy';
    return version.trigger;
  }
}
