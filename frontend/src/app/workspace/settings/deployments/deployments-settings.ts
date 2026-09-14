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
import { ButtonModule } from 'primeng/button';

import { DeploymentsService, type DeploymentRow } from '../../../core/deployments.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { TauriService } from '../../../core/tauri.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WORKFLOW_FILE_EXTENSION } from '../../../core/workflow.model';
import { loadPhormaCloudUrl } from '../../../core/phorma-cloud-url';

/**
 * "Deployed in your account" - the Reconciliation_List (Requirements 6, 7).
 *
 * ## What this fixes
 *
 * A user reinstalled the studio and lost the local database that held their
 * workflow library. A workflow that had been deployed to Phorma Cloud stayed
 * live: cron kept firing, its portal kept answering, credits kept being spent,
 * and nothing in the studio could name it, because the only copy of its
 * `workflowId` went with the database. This list is where that deployment becomes
 * visible again, and where the user can stop it themselves.
 *
 * ## Two gating decisions
 *
 * Rendered on being SIGNED IN, never on `subscribed()` (Requirement 6.6). A
 * lapsed subscriber is exactly the person who needs to stop a cron deployment
 * they are still being billed for, and an upsell in place of that list would trap
 * the spend this feature exists to reveal.
 *
 * It also sits OUTSIDE the per-provider branch of the Cloud page. The list
 * describes what is running in the Phorma Cloud ACCOUNT, which is independent of
 * where the next deploy will go - so a user who has since switched their deploy
 * target to their own Cloudflare or AWS account can still find and remove what
 * they left behind.
 *
 * ## Its own stylesheet
 *
 * A separate component rather than more markup in `settings-dialog.html` because
 * `settings-dialog.scss` compiles to ~21.8kB against a 22kB `anyComponentStyle`
 * warning. Angular gives this component its own budget, and its own scope - which
 * is why the handful of `.phorma-settings__*` recipes it needs are restated here
 * at the same values rather than inherited.
 */
@Component({
  selector: 'app-deployments-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule],
  templateUrl: './deployments-settings.html',
  styleUrl: './deployments-settings.scss',
})
export class DeploymentsSettings {
  protected readonly deployments = inject(DeploymentsService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  private readonly tauri = inject(TauriService);
  // The app's only external-link helper: `plugin-opener` on desktop, a
  // `noopener` tab in the browser. It lives on the MCP OAuth service because
  // that is where guided provider setup first needed it.
  private readonly links = inject(McpOAuthService);

  /** True once a refresh has been attempted, so an empty list can be honest. */
  private readonly attempted = signal(false);

  protected readonly signedIn = this.phormaCloud.signedIn;

  protected readonly rows = this.deployments.deployments;

  /**
   * Whether to show the empty state.
   *
   * Only after a completed refresh with no error: "nothing is deployed" and "we
   * could not ask" are different answers, and showing the first for the second is
   * how a user stops looking for the spend they came here about.
   */
  protected readonly showEmpty = computed(
    () =>
      this.attempted() &&
      this.deployments.loaded() &&
      !this.deployments.loading() &&
      this.deployments.error() === null &&
      this.rows().length === 0,
  );

  constructor() {
    // One refresh, the first time this component exists with an account signed
    // in. It lives here rather than in the service so a user who never opens the
    // Cloud page spends no request at all.
    //
    // Only `signedIn()` is tracked: the write is inside `untracked` because an
    // effect that reads and writes the same signal re-enters itself, which has
    // OOM'd the renderer elsewhere in this codebase.
    effect(() => {
      if (!this.phormaCloud.signedIn()) return;
      untracked(() => {
        if (this.attempted()) return;
        this.attempted.set(true);
        void this.deployments.refresh();
      });
    });
  }

  protected refresh(): void {
    this.attempted.set(true);
    void this.deployments.refresh();
  }

  protected busy(row: DeploymentRow): boolean {
    return this.deployments.busyWorkflowId() === row.workflowId;
  }

  /** The public address of a published portal, for the link and its label. */
  protected portalUrl(row: DeploymentRow): string {
    return `${loadPhormaCloudUrl()}/p/${row.portalSlug ?? ''}`;
  }

  protected async openPortal(row: DeploymentRow): Promise<void> {
    const url = this.portalUrl(row);
    try {
      await this.links.openExternal(url);
    } catch {
      this.toast.error('Could not open the portal', url);
    }
  }

  /**
   * Writes the deployed spec to a `.phorma.json` file (Requirement 7.6).
   *
   * The DEPLOYED copy, not a local one: for an orphan there is no local copy, and
   * for a drifted one the deployed spec is the thing actually running.
   */
  protected async download(row: DeploymentRow): Promise<void> {
    const spec = await this.deployments.readDeployedSpec(row.workflowId);
    if (!spec) return;

    // Desktop takes the same native save dialog the toolbar's Export uses, so
    // an exported deployment and an exported open document land the same way.
    if (this.tauri.isDesktop) {
      try {
        const path = await this.tauri.saveWorkflowFileDialog(spec);
        if (path) this.toast.success('Workflow saved', path);
      } catch (error) {
        this.toast.error(
          'Could not save the file',
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    // Browser parity: the app has to run under plain `ng serve` with no Tauri.
    const filename = `${safeFilename(spec.name)}.${WORKFLOW_FILE_EXTENSION}`;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Revoking in the same tick can invalidate the blob before the browser has
    // read it, which shows up as an empty or failed download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.toast.success('Workflow downloaded', filename);
  }

  /** Puts the deployed spec back in the local library, keeping its id (7.7). */
  protected async restore(row: DeploymentRow): Promise<void> {
    await this.deployments.restoreToLibrary(row.workflowId);
  }

  /**
   * Stops a deployment (Requirement 7.1). Reversible: run history, the usage
   * ledger and connection metadata stay, so pushing again needs no other setup.
   */
  protected async stop(row: DeploymentRow): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Stop this deployment?',
      message:
        `"${row.workflowName}" stops running in the cloud. Scheduled runs are cancelled` +
        (row.portalSlug ? ' and its published page goes offline' : '') +
        `. Run history and usage are kept, and you can deploy it again at any time.` +
        (row.orphan
          ? ' There is no copy of this workflow in your library - download or restore it first if you want to keep it.'
          : ''),
      confirmLabel: 'Stop deployment',
      cancelLabel: 'Leave running',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.deployments.undeploy(row.workflowId);
  }

  /**
   * Full teardown (Requirement 7.2). Named "Delete everything" rather than
   * "Purge" in the UI: a non-technical owner should not have to know which of two
   * similar-sounding words destroys more.
   */
  protected async purge(row: DeploymentRow): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete this deployment and its cloud history?',
      message:
        `Everything Phorma Cloud holds for "${row.workflowName}" is removed: the deployed ` +
        `workflow, its scheduled runs, its published page, and the cloud copy of its run ` +
        `history and usage. This cannot be undone.` +
        (row.orphan
          ? ' There is no copy of this workflow in your library, so download it first if you want to keep it.'
          : ' Your local copy and its version history are not touched.'),
      confirmLabel: 'Delete everything',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.deployments.purge(row.workflowId);
  }
}

/** A workflow name reduced to something a filesystem will accept. */
function safeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9 _-]+/g, '').replace(/\s+/g, '-');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'workflow';
}
