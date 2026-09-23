/**
 * The builder's review surface: what an editor changed, and the two decisions
 * (multi-organisation-phorma, Requirements 12.6, 12.7, 12.8, 12.10).
 *
 * ## The diff is the EXISTING one
 *
 * `diffWorkflowSpecs` (`core/workflow-diff.ts`) is what the Cloud dialog and the
 * version history already render, and it is already grouped by the changed FIELD
 * ("Changed prompt on ...", "Changed model on ..."). So this dialog adds a review
 * flow and no diff engine, and no new runtime dependency: the prompt body preview
 * goes through the existing `marked` + DOMPurify markdown component
 * (Requirement 17.7).
 *
 * ## Deferred, on purpose
 *
 * Hosted in `app.html` inside `@defer (on immediate)`, so the initial bundle does
 * not carry it (Requirement 18.4). That is also why the open state lives in
 * `ProposalReviewDialogService` rather than in an input.
 *
 * ## Both decisions are confirmed through the shared rail
 *
 * `ConfirmDialogService` for the publish, and its `prompt()` for the rejection
 * reason - the same rail every rename and delete in the studio uses. A publish
 * moves what is RUNNING, which is exactly the class of action that rail exists
 * for, and `.phorma-confirm` outranks every dialog tier so a confirm summoned from
 * inside this one is on top.
 */

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';

import { renderMarkdown } from '../../../shared/markdown/render-markdown';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { CapabilityService } from '../../../core/capability.service';
import { DeploymentsService } from '../../../core/deployments.service';
import { ProposalsService, type ProposalDetail } from '../../../core/proposals.service';
import { diffWorkflowSpecs } from '../../../core/workflow-diff';
import { isAgentNode, type WorkflowSpec } from '../../../core/workflow.model';
import {
  proposalStatusIcon,
  proposalStatusLabel,
  type ProposalSummary,
} from '../../../core/proposals.model';
import { ProposalReviewDialogService } from '../proposal-review-dialog.service';

/** One prompt body a proposal changed, for the markdown preview. */
interface PromptChange {
  nodeName: string;
  before: string;
  after: string;
}

@Component({
  selector: 'app-proposal-review-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ButtonModule],
  templateUrl: './proposal-review-dialog.html',
  styleUrl: './proposal-review-dialog.scss',
})
export class ProposalReviewDialog {
  protected readonly dialog = inject(ProposalReviewDialogService);
  protected readonly proposals = inject(ProposalsService);
  private readonly deployments = inject(DeploymentsService);
  private readonly capability = inject(CapabilityService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly sanitizer = inject(DomSanitizer);

  /** The loaded proposal and its spec, or null while nothing is selected. */
  protected readonly detail = signal<ProposalDetail | null>(null);
  /** The deployed spec the proposal is compared against. */
  protected readonly liveSpec = signal<WorkflowSpec | null>(null);
  protected readonly loadingDetail = signal(false);

  /**
   * True when this session may decide. A reader still sees the diff.
   *
   * `deploy.push` is the capability a publish exercises, named directly rather
   * than compared as a level: the one level comparison lives inside
   * `CapabilityService`, which `scripts/check-capability-isolation.mjs` enforces.
   */
  protected readonly canDecide = computed(() => this.capability.can('deploy.push'));

  /**
   * The field-grouped diff from what is DEPLOYED to what is proposed.
   *
   * Empty when either side is missing, which reads as "nothing to compare" rather
   * than as "no changes" - the template distinguishes the two.
   */
  protected readonly diff = computed(() => {
    const proposed = this.detail()?.spec;
    const live = this.liveSpec();
    return proposed && live ? diffWorkflowSpecs(live, proposed) : [];
  });

  /**
   * Every prompt body the proposal rewrote, rendered as sanitized markdown.
   *
   * Prompts get their own section because they are the case this whole queue
   * exists for: "Changed prompt on Triage" tells a reviewer that something moved
   * and nothing about whether to accept it.
   */
  protected readonly promptChanges = computed<PromptChange[]>(() => {
    const proposed = this.detail()?.spec;
    const live = this.liveSpec();
    if (!proposed || !live) return [];
    const before = new Map(live.graph.nodes.map(node => [node.id, node]));
    const changes: PromptChange[] = [];
    for (const node of proposed.graph.nodes) {
      if (!isAgentNode(node)) continue;
      const previous = before.get(node.id);
      if (!previous || !isAgentNode(previous)) continue;
      const after = node.data.prompt ?? '';
      const original = previous.data.prompt ?? '';
      if (after === original) continue;
      changes.push({ nodeName: node.name, before: original, after });
    }
    return changes;
  });

  constructor() {
    // Loads the queue and the deployed spec whenever the dialog opens on a
    // workflow. `untracked` because the body writes signals this effect reads -
    // the loop that hazard causes has already cost this repo a renderer OOM twice.
    effect(() => {
      const workflowId = this.dialog.workflowId();
      if (!this.dialog.visible() || !workflowId) return;
      untracked(() => void this.load(workflowId));
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }

  /** Re-reads the queue, the deployed spec, and the pending proposal's body. */
  private async load(workflowId: string): Promise<void> {
    this.detail.set(null);
    this.liveSpec.set(null);
    await this.proposals.refresh(workflowId);
    this.liveSpec.set(await this.deployments.readDeployedSpec(workflowId));
    const pending = this.proposals.pending();
    if (pending) await this.select(pending);
  }

  /** Loads one proposal's stored spec for the diff. */
  protected async select(proposal: ProposalSummary): Promise<void> {
    this.loadingDetail.set(true);
    try {
      this.detail.set(await this.proposals.detail(proposal.workflowId, proposal.proposalId));
    } finally {
      this.loadingDetail.set(false);
    }
  }

  /**
   * One prompt body as sanitized markdown (Requirement 17.7).
   *
   * Through the shared `renderMarkdown` rail - marked plus DOMPurify - which is
   * the only markdown path in the studio, so a review cannot render a prompt any
   * differently from the prompt panel that wrote it.
   */
  protected markdown(text: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(text));
  }

  protected statusLabel(proposal: ProposalSummary): string {
    return proposalStatusLabel(proposal.status);
  }

  protected statusIcon(proposal: ProposalSummary): string {
    return `ti ${proposalStatusIcon(proposal.status)}`;
  }

  /**
   * Publishes the selected proposal after a confirmation.
   *
   * Confirmed rather than immediate because it moves what is RUNNING: the worker
   * runs the ordinary push path, so the next scheduled run uses the new spec.
   */
  protected async publish(): Promise<void> {
    const proposal = this.detail()?.proposal;
    if (!proposal) return;
    const confirmed = await this.confirm.confirm({
      title: 'Publish this change?',
      message:
        'The deployed workflow is replaced with this version, and the next run - including a ' +
        'scheduled one - uses it.',
      confirmLabel: 'Publish',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    if (await this.proposals.publish(proposal)) await this.load(proposal.workflowId);
  }

  /**
   * Rejects the selected proposal, with an optional reason.
   *
   * The reason comes from `ConfirmDialogService.prompt`, and an empty answer is a
   * rejection with no reason rather than a cancelled action - the cancel is the
   * dialog's own, and `prompt` resolves null for it.
   */
  protected async reject(): Promise<void> {
    const proposal = this.detail()?.proposal;
    if (!proposal) return;
    const reason = await this.confirm.prompt(
      {
        title: 'Reject this change?',
        message: 'The author is told, and their version is kept so they can revise it.',
        confirmLabel: 'Reject',
        cancelLabel: 'Cancel',
        tone: 'danger',
      },
      { placeholder: 'Why (optional)', label: 'Rejection reason', required: false, maxLength: 2000 },
    );
    if (reason === null) return;
    if (await this.proposals.reject(proposal, reason)) await this.load(proposal.workflowId);
  }
}
