import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { WorkflowBackupService } from '../../../core/cloud/workflow-backup.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { WorkflowService } from '../../../core/workflow.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { VersionHistoryDialogService } from '../../workflows/version-history-dialog.service';
import type { BackupSummary } from '../../../core/backup.model';

/**
 * "Cloud backup" - Settings > Cloud (cloud-workflow-backup Requirements 11, 17,
 * 18.6, 20.5, 24.2).
 *
 * ## What this page owes the user
 *
 * Backup is ON by default for a subscriber, which means most people will never
 * come here before they need it. So the page has one job when they do: say plainly
 * what is stored, who can read it, and how to stop. In particular the DECRYPTION
 * DISCLOSURE is rendered inline beside the state rather than behind a dialog
 * (Requirement 11.4) - Phorma Labs holds the key, and a user cannot make an
 * informed choice about that if they have to go looking for it.
 *
 * ## Three states it has to render honestly
 *
 * - **Not available.** A BYO deployment binds no backup storage, so the controls
 *   are ABSENT rather than broken (Requirement 24.2), and the library export
 *   section beside this one is the durability answer there.
 * - **Read-only.** A lapsed subscription keeps its backups for 90 days. The window
 *   is stated (Requirement 20.5), because "read-only" without a date reads as
 *   permanent.
 * - **Deleted, not gone.** A tombstone is restorable until its countdown runs out
 *   (Requirement 17.9). Purge is a SEPARATE action from delete and says it cannot
 *   be undone (Requirement 17.7).
 */
@Component({
  selector: 'app-backup-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ButtonModule, ToggleSwitchModule],
  templateUrl: './backup-settings.html',
  styleUrl: './backup-settings.scss',
})
export class BackupSettings {
  /**
   * Per-instance id scope, minted from a static counter.
   *
   * Two settings bodies can be in the DOM at once, and a static `id` would appear
   * twice and break every `<label for>` in both. `settings-dialog.aws.spec.ts`
   * mounts two dialogs and asserts no id in the document repeats.
   */
  private static instances = 0;
  private readonly scope = `backup-settings-${(BackupSettings.instances += 1)}`;

  protected readonly backup = inject(WorkflowBackupService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly workflow = inject(WorkflowService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  private readonly versionHistory = inject(VersionHistoryDialogService);

  private readonly attempted = signal(false);

  /** True while a delete, purge or delete-all is in flight for one workflow. */
  protected readonly busyWorkflowId = signal<string | null>(null);

  protected readonly signedIn = this.phormaCloud.signedIn;

  /**
   * Whether to render the section at all.
   *
   * Signed in AND the deployment has backup storage. A signed-out user has no
   * account to back up to, and a BYO worker has nowhere to put it.
   */
  protected readonly visible = computed(() => this.signedIn() && this.backup.available());

  /** Backup is running: subscribed, not opted out. */
  protected readonly running = this.backup.active;

  /**
   * A subscriber who has turned backup off, versus somebody with no plan.
   *
   * Separated because the remedies are opposite: one flips a switch, the other buys
   * a plan, and an upsell shown to a subscriber who deliberately opted out would be
   * both wrong and annoying.
   */
  protected readonly optedOut = computed(
    () =>
      this.backup.disabled() && (this.phormaCloud.subscribed() || this.phormaCloud.pastDue()),
  );

  protected readonly needsPlan = computed(
    () => !this.phormaCloud.subscribed() && !this.phormaCloud.pastDue(),
  );

  /** Total bytes across live backups, for the one summary figure worth showing. */
  protected readonly totalBytes = computed(() =>
    this.backup.backups().reduce((sum, row) => sum + row.sizeBytes, 0),
  );

  /** Workflows in the local library with no live backup yet. */
  protected readonly notYetBackedUp = computed(() => {
    const backed = new Set(this.backup.backups().map(row => row.workflowId));
    return this.workflow.library().filter(spec => !backed.has(spec.id)).length;
  });

  constructor() {
    // One list read the first time this page renders with an account signed in.
    // Only `signedIn()` is tracked; the write is inside `untracked` because an
    // effect that re-enters its own writes has OOM'd the renderer elsewhere here.
    effect(() => {
      if (!this.phormaCloud.signedIn()) return;
      untracked(() => {
        if (this.attempted()) return;
        this.attempted.set(true);
        void this.backup.refresh();
      });
    });
  }

  protected id(suffix: string): string {
    return `${this.scope}-${suffix}`;
  }

  protected refresh(): void {
    this.attempted.set(true);
    void this.backup.refresh();
  }

  protected busy(row: BackupSummary): boolean {
    return this.busyWorkflowId() === row.workflowId;
  }

  /** True when this workflow's last upload lost a race with another machine. */
  protected hasConflict(row: BackupSummary): boolean {
    return this.backup.conflicts().has(row.workflowId);
  }

  /** kB or MB, whichever reads better. Never bytes - nobody counts in bytes. */
  protected size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  protected onEnabledChange(next: boolean): void {
    if (next === true) {
      this.backup.enable();
      void this.backup.uploadAll();
      return;
    }
    // Turning it OFF is the destructive direction, so it goes through the
    // disable-and-delete-all confirmation rather than flipping silently.
    void this.disableAndDeleteAll();
  }

  /** Uploads everything now, for a user who wants to see it happen. */
  protected async backUpNow(): Promise<void> {
    await this.backup.uploadAll();
    await this.backup.refresh();
  }

  /**
   * Opens the local version history for a workflow whose upload hit a conflict, so
   * the user can compare and choose (Requirement 16.5). Nothing merges two specs.
   */
  protected compare(row: BackupSummary): void {
    this.versionHistory.open(row.workflowId);
  }

  /** Restores one backup into the local library, keeping its id. */
  protected async restore(row: BackupSummary): Promise<void> {
    this.busyWorkflowId.set(row.workflowId);
    try {
      const result = await this.backup.restore(row.workflowId);
      if (result.outcome === 'restored' || result.outcome === 'replaced') {
        this.toast.success(
          'Restored to your library',
          result.missingConnections.length > 0
            ? `Reconnect ${result.missingConnections.join(', ')} before running it.`
            : `"${row.name}" is back in your workflow library.`,
        );
      }
    } finally {
      this.busyWorkflowId.set(null);
    }
  }

  /**
   * Soft delete: a tombstone whose copies stay retrievable for its countdown. The
   * confirmation says so, because "delete" that does not delete needs explaining
   * more than one that does.
   */
  protected async delete(row: BackupSummary): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete this backup?',
      message:
        `The cloud copy of "${row.name}" is marked deleted. It stays restorable for 30 days, ` +
        `then it is removed for good. Your local copy is not touched.`,
      confirmLabel: 'Delete backup',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.busyWorkflowId.set(row.workflowId);
    try {
      await this.backup.deleteBackup(row.workflowId);
    } finally {
      this.busyWorkflowId.set(null);
    }
  }

  /**
   * Purge: the separate, irreversible action (Requirements 17.6, 17.7).
   *
   * The confirmation NAMES the workflow and states that it cannot be undone,
   * because this is the point past which the copy is genuinely gone.
   */
  protected async purge(row: BackupSummary): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: `Permanently delete the backup of "${row.name}"?`,
      message:
        `Every stored copy of "${row.name}" is destroyed immediately, including its earlier ` +
        `revisions. This cannot be undone. Your local copy is not touched.`,
      confirmLabel: 'Delete permanently',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.busyWorkflowId.set(row.workflowId);
    try {
      await this.backup.deleteBackup(row.workflowId, { purge: true });
    } finally {
      this.busyWorkflowId.set(null);
    }
  }

  /**
   * The one control that turns backup off and destroys everything stored
   * (Requirement 11.5).
   *
   * Deliberately one action rather than two: an "off" switch that left the data
   * behind would make the disclosure above it meaningless.
   */
  protected async disableAndDeleteAll(): Promise<void> {
    const count = this.backup.backups().length + this.backup.tombstones().length;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Turn off cloud backup and delete every copy?',
      message:
        (count > 0
          ? `All ${count} ${count === 1 ? 'backup' : 'backups'} stored for your account are ` +
            `destroyed immediately, earlier revisions included. `
          : 'Nothing is stored right now, so there is nothing to destroy. ') +
        `This cannot be undone. Your local workflow library is not touched, and you can turn ` +
        `backup on again at any time.`,
      confirmLabel: 'Turn off and delete',
      cancelLabel: 'Keep backing up',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.backup.disableAndDeleteAll();
  }
}
