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

import { CapabilityService } from '../../core/capability.service';
import { DeploymentsService, type DeploymentRow } from '../../core/deployments.service';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { WorkflowService } from '../../core/workflow.service';
import { PanelCard } from '../../shared/panel-card/panel-card';

/**
 * The Cloud_Library: an organisation's deployed workflows, opened read-only on the
 * canvas (multi-organisation Requirement 9).
 *
 * ## Who sees it
 *
 * A member whose Capability_Level is `operator` or `editor` - which
 * `CapabilityService.cloudLibraryOnly()` derives, and which the Workflows panel
 * uses to render this surface in place of the local library. Such a session has no
 * local library, no desktop install and no keychain: this list IS their workflow
 * list.
 *
 * ## Why there is no transport here
 *
 * `DeploymentsService` already reads `GET /api/deployments`, already pins
 * `DEPLOY_TARGETS.phorma` (a subscriber deploying elsewhere still HAS a hosted
 * account) and already goes through `dispatchCloudOperation`. It also already reads
 * the deployed spec back. So this component is a view over that service and adds no
 * second transport and no second model - `DeploymentSummary` stays the twin of
 * `cloud/src/deployments.ts` it already is.
 *
 * ## A failure is a failure, never an empty organisation
 *
 * The module's existing discipline is that `creditsSpent: null` means "cannot tell"
 * while `0` means "spent nothing", and Requirement 9.8 extends the same rule to the
 * list itself. `showEmpty` therefore requires a COMPLETED read with no error, so a
 * refusal, a server error and a network loss all render the failure - never
 * "this organisation has no deployments", which is the one answer that would stop a
 * member looking for the workflow they came here to run.
 *
 * ## Deferred
 *
 * Hosted inside `@defer (on immediate)` (Requirement 9.7), the same treatment
 * chart.js gets, so the studio's initial bundle does not grow by the size of this
 * surface. It adds no runtime dependency.
 */
@Component({
  selector: 'app-cloud-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule, PanelCard],
  templateUrl: './cloud-library.html',
  styleUrl: './cloud-library.scss',
})
export class CloudLibrary {
  protected readonly deployments = inject(DeploymentsService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly workflow = inject(WorkflowService);
  // Decides whether an opened deployment is read-only or proposable. A DI leaf.
  private readonly capability = inject(CapabilityService);

  /** True once a refresh has been attempted, so an empty list can be honest. */
  private readonly attempted = signal(false);

  /** The rows the list renders, straight off the service. */
  protected readonly rows = this.deployments.deployments;

  /** Workflow id whose spec is being read, for the per-row spinner. */
  protected readonly opening = signal<string | null>(null);

  /**
   * Whether the organisation genuinely has no deployments.
   *
   * Requires a completed read with no error: "nothing is deployed" and "we could
   * not ask" are different answers, and showing the first for the second is the
   * defect Requirement 9.8 names.
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
    // One read, the first time this surface exists with an account signed in. It
    // lives here rather than in the service so a builder - who never renders this
    // component - spends no request at all.
    //
    // Only `signedIn()` is tracked; the write sits inside `untracked` because an
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
    return this.opening() === row.workflowId;
  }

  /**
   * Opens the DEPLOYED spec on the canvas.
   *
   * `readDeployedSpec` reads `GET /workflow` off the instance and has already
   * toasted anything that went wrong, so a null is simply "not opened". The spec
   * needs no redaction: a `WorkflowSpec` references credentials by NAME, the values
   * live in the organisation's `SecretVault`, and ownership is enforced two seams
   * above that route.
   *
   * READ-ONLY unless this session can change a value and cannot deploy one - which
   * is exactly an editor (multi-organisation-phorma, Requirement 12.1). Then the
   * document is mutable and its save becomes a PROPOSAL. Named capabilities rather
   * than a level comparison, so the one level comparison stays inside
   * `CapabilityService`: `edit.prompt` is what makes the change possible and
   * `deploy.push` is what would make it a deploy instead.
   */
  protected async open(row: DeploymentRow): Promise<void> {
    if (this.opening() !== null) return;
    this.opening.set(row.workflowId);
    try {
      const spec = await this.deployments.readDeployedSpec(row.workflowId);
      if (!spec) return;
      const mode =
        this.capability.can('edit.prompt') && !this.capability.can('deploy.push')
          ? 'propose'
          : 'read-only';
      this.workflow.openDeployedSpec(spec, mode);
    } finally {
      this.opening.set(null);
    }
  }
}
