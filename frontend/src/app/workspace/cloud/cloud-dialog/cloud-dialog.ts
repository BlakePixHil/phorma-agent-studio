import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';

import {
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
} from '@phorma/engine';

import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { ConnectionStoreService } from '../../../core/connection-store.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SelectionService } from '../../../core/selection.service';
import { SettingsService } from '../../../core/settings.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { WorkflowService } from '../../../core/workflow.service';
import { WorkflowVersionsService } from '../../../core/workflow-versions.service';
import { diffWorkflowSpecs } from '../../../core/workflow-diff';
import { DEPLOY_TARGETS, type DeployTargetId } from '../../../core/deploy/deploy-targets';
import { summarizeDeploySpec, type DeploySummary } from './deploy-readiness';

/** Instance counter so two mounted fixtures never share an element id. */
let instanceCount = 0;

/** Why the deploy button is unavailable. Null means it is ready to press. */
export type DeployBlockedReason =
  | 'read-only'
  | 'unsaved-draft'
  | 'no-provider'
  | 'not-configured'
  | 'signed-out'
  | 'subscription-inactive'
  | 'validation-errors'
  | 'pushing';

/**
 * Deploy the active workflow to the configured cloud runtime.
 *
 * Deploy-only by design. Every provider control this surface used to carry -
 * the wrangler runtime folder, the worker URL and token, the AWS field set and
 * its plan/deploy/doctor runners - is duplicated in Settings > Cloud, which is
 * where it now lives exclusively.
 */
@Component({
  selector: 'app-cloud-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule],
  templateUrl: './cloud-dialog.html',
  styleUrl: './cloud-dialog.scss',
})
export class CloudDialog {
  protected readonly dialog = inject(CloudDialogService);
  protected readonly cloud = inject(CloudService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly settings = inject(SettingsService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly selection = inject(SelectionService);
  private readonly versions = inject(WorkflowVersionsService);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  /** Scoped so `aria-labelledby` still resolves with two fixtures mounted. */
  protected readonly titleId = `cloud-dialog-title-${(instanceCount += 1)}`;

  /** The element to hand focus back to when the dialog closes. */
  private returnFocusTo: HTMLElement | null = null;

  /** The chosen deploy target ('cloudflare' fallback keeps legacy behavior). */
  protected readonly provider = computed(
    () => (this.settings.cloudProvider() ?? 'cloudflare') as DeployTargetId,
  );

  protected readonly providerLabel = computed(() => DEPLOY_TARGETS[this.provider()].label);

  /** Host of the configured endpoint, or null when the target is unconfigured. */
  protected readonly targetEndpoint = computed(() => {
    const base = this.cloud.effectiveWorkerUrl();
    if (!base) return null;
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  });

  /**
   * Deployment status for the workflow this dialog is showing. Goes through
   * `deployedStatusFor` rather than reading `cloud.deployedStatus()` directly:
   * the signal is a single shared slot, and other surfaces (the library panel's
   * delete, which purges the cloud) check the status of OTHER workflows, which
   * would otherwise be rendered here as if it were this workflow's.
   */
  protected readonly deployedStatus = computed(() =>
    this.cloud.deployedStatusFor(this.workflow.activeDoc()?.workflowId),
  );

  // ── What is about to go live ───────────────────────────────────────────────

  /** The spec a push would send, defaults unmaterialized. */
  private readonly activeSpec = computed(() => {
    // Tracked so the summary and diff follow canvas edits while the dialog sits open.
    this.workflow.graph();
    this.workflow.activeDoc();
    return this.workflow.exportActiveSpec();
  });

  protected readonly deploySummary = computed<DeploySummary | null>(() => {
    const spec = this.activeSpec();
    return spec ? summarizeDeploySpec(spec) : null;
  });

  /** Newest snapshot recorded as successfully deployed, or null. */
  private readonly deployedSnapshot = computed(
    () => this.versions.versions().find(version => version.deployed) ?? null,
  );

  /**
   * Changes since the deployed snapshot. Null when nothing is deployed yet -
   * a different statement from "no changes", and the template says so.
   */
  protected readonly deployDiff = computed(() => {
    const snapshot = this.deployedSnapshot();
    const spec = this.activeSpec();
    if (!snapshot || !spec) return null;
    return diffWorkflowSpecs(snapshot.spec, spec);
  });

  /** True when the open document has edits that a push would carry silently. */
  protected readonly hasUnsavedEdits = computed(
    () => this.workflow.isDirty() && this.workflow.activeDoc()?.workflowId != null,
  );

  // ── Pre-flight validation ──────────────────────────────────────────────────

  /** Locally known connections, reloaded whenever the dialog opens. */
  private readonly connections = signal<ConnectionSummary[]>([]);

  /**
   * Capability findings against the SELECTED deploy target, computed on open
   * rather than at push time. The push re-validates against the target's own
   * connection inventory, which only it can read; this is the same walk against
   * what the studio knows, so problems surface before the button is pressed.
   */
  protected readonly preflightFindings = computed<CapabilityFinding[]>(() => {
    const spec = this.activeSpec();
    if (!spec) return [];
    return validateAgainstCapabilities(
      spec,
      DEPLOY_TARGETS[this.provider()].capabilities,
      this.connections(),
    );
  });

  protected readonly preflightErrors = computed(() =>
    this.preflightFindings().filter(finding => finding.severity === 'error'),
  );

  protected readonly preflightWarnings = computed(() =>
    this.preflightFindings().filter(finding => finding.severity === 'warning'),
  );

  // ── Readiness ──────────────────────────────────────────────────────────────

  /**
   * Why the deploy cannot proceed, or null. Every branch here is also enforced
   * inside `CloudService.pushWorkflow`, which is the real gate - this one exists
   * so the user learns BEFORE pressing rather than from a toast afterwards.
   */
  protected readonly deployBlockedReason = computed<DeployBlockedReason | null>(() => {
    if (this.cloud.pushing()) return 'pushing';
    const doc = this.workflow.activeDoc();
    if (doc?.readOnly) return 'read-only';
    if (!doc?.workflowId) return 'unsaved-draft';
    if (!this.settings.cloudProvider()) return 'no-provider';
    if (!this.cloud.configured()) return 'not-configured';
    if (this.provider() === 'phorma') {
      if (!this.phormaCloud.signedIn()) return 'signed-out';
      const profile = this.phormaCloud.profile();
      if (profile && !this.phormaCloud.subscribed()) return 'subscription-inactive';
    }
    if (this.preflightErrors().length > 0) return 'validation-errors';
    return null;
  });

  /** One sentence naming the blocker, shown beside the disabled button. */
  protected readonly deployBlockedMessage = computed(() => {
    const errors = this.preflightErrors().length;
    switch (this.deployBlockedReason()) {
      case 'pushing':
        return 'A deploy is already in flight.';
      case 'read-only':
        return 'This is a read-only version preview. Restore it before deploying.';
      case 'unsaved-draft':
        return 'Save this workflow to the library before deploying it.';
      case 'no-provider':
        return 'No cloud provider is chosen yet.';
      case 'not-configured':
        return `${this.providerLabel()} is not configured yet.`;
      case 'signed-out':
        return 'Sign in to your Phorma account to publish.';
      case 'subscription-inactive':
        return this.phormaCloud.pastDue()
          ? 'Your last payment failed, so publishing is paused.'
          : 'An active subscription is needed to publish.';
      case 'validation-errors':
        return `${errors} problem${errors === 1 ? '' : 's'} would stop this running on ${this.providerLabel()}.`;
      default:
        return null;
    }
  });

  /** The remedy offered beside the blocker, or null when there is no jump. */
  protected readonly deployBlockedAction = computed(() => {
    switch (this.deployBlockedReason()) {
      case 'no-provider':
      case 'not-configured':
      case 'signed-out':
      case 'subscription-inactive':
        return 'settings';
      case 'unsaved-draft':
        return 'save';
      default:
        return null;
    }
  });

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
        if (workflowId) void this.versions.load(workflowId);
        this.cloud.lastPushFindings.set([]);
        void this.connectionStore
          .list()
          .then(list => this.connections.set(list))
          .catch(() => this.connections.set([]));
      });
    });

    // Focus moves into the card on open and back to the opener on close.
    effect(() => {
      const visible = this.dialog.visible();
      const host = this.card()?.nativeElement;
      untracked(() => {
        if (visible) {
          this.returnFocusTo = document.activeElement as HTMLElement | null;
          host?.focus();
          return;
        }
        this.returnFocusTo?.focus?.();
        this.returnFocusTo = null;
      });
    });
  }

  /** Jumps to Settings > Cloud, where every provider control lives. */
  protected openCloudSettings(): void {
    this.dialog.close();
    this.settingsDialog.open('cloud');
  }

  // ── Deploy ─────────────────────────────────────────────────────────────────

  /** Label the primary button carries, naming the running step. */
  protected readonly deployLabel = computed(() => {
    switch (this.cloud.pushPhase()) {
      case 'connections':
        return 'Syncing connections';
      case 'validating':
        return 'Validating';
      case 'uploading':
        return 'Uploading';
      default:
        return this.provider() === 'phorma' ? 'Publish workflow' : 'Deploy workflow';
    }
  });

  /**
   * Host findings when the last push produced any, otherwise the local
   * pre-flight. The host validates against an inventory only it can read, so
   * once it has spoken it is authoritative.
   */
  protected readonly findings = computed<CapabilityFinding[]>(() => {
    const fromHost = this.cloud.lastPushFindings();
    return fromHost.length > 0 ? fromHost : this.preflightFindings();
  });

  protected async deploy(): Promise<void> {
    if (this.deployBlockedReason()) return;
    const pushed = await this.cloud.pushWorkflow();
    // Watching the run it just armed is the next thing anyone does.
    if (pushed && !this.cloud.connected()) await this.cloud.connect();
  }

  /** Selects the offending node on the canvas and steps out of the way. */
  protected revealFinding(finding: CapabilityFinding): void {
    if (!finding.nodeId) return;
    this.selection.selectNode(finding.nodeId);
    this.dialog.close();
  }

  /** Saves the open draft so it has a library id a deploy can address. */
  protected async saveWorkflow(): Promise<void> {
    await this.workflow.saveActive('manual');
  }

  protected refreshStatus(): void {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (workflowId) void this.cloud.refreshStatus(workflowId);
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  /**
   * The deployed snapshot before the current one. Present only once a workflow
   * has been deployed twice, which is exactly when rolling back is meaningful.
   */
  protected readonly previousDeployed = computed(
    () => this.versions.versions().filter(version => version.deployed)[1] ?? null,
  );

  protected async redeployPrevious(): Promise<void> {
    const snapshot = this.previousDeployed();
    if (!snapshot) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Redeploy the previous version?',
      message:
        `The snapshot from ${new Date(snapshot.savedAt).toLocaleString()} replaces what is ` +
        `running in the cloud. Your canvas is left exactly as it is - this deploys the ` +
        `snapshot, it does not restore it locally.`,
      confirmLabel: 'Redeploy',
    });
    if (!confirmed) return;
    await this.cloud.pushWorkflow(snapshot.spec);
  }

  /** Confirms, then removes the active workflow's deployed spec. */
  protected async removeFromCloud(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Remove from cloud?',
      message:
        `"${this.workflow.activeName()}" will stop running in the cloud immediately - scheduled ` +
        `triggers, manual runs and the live monitor all need a fresh push afterward. Its published ` +
        `portal is taken offline, and the cloud copy of its run history and usage is deleted. Your ` +
        `local workflow, connections and account usage totals are untouched.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.cloud.removeWorkflow(workflowId);
  }

  protected onBackdropClick(): void {
    if (this.cloud.pushing()) return;
    this.dialog.close();
  }

  /** Keeps Tab inside the card while the dialog owns the screen. */
  protected onCardKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const host = this.card()?.nativeElement;
    if (!host) return;
    const focusable = [
      ...host.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(element => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === host)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible() && !this.cloud.pushing()) this.dialog.close();
  }
}
