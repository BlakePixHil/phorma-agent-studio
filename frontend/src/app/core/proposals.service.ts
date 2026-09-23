/**
 * Proposals, studio side: an editor's save becomes a change a builder reviews
 * (multi-organisation-phorma, Requirement 12).
 *
 * ## What it does
 *
 * - **Submit.** An editor cannot push. Their save comes here instead
 *   (Requirement 12.1), as a proposal carrying the spec, its connection
 *   references and the DEPLOYED spec it was edited from.
 * - **Review.** List a workflow's proposals, read one with its spec, and publish
 *   or reject it (Requirements 12.6 - 12.10).
 *
 * ## Why the live spec travels with a submission
 *
 * The worker decides scope - whether an editor's change touched the graph's
 * STRUCTURE - and it will not wake a deployed instance to find out, because
 * "creating a proposal cannot change what is running" is expressed as the ABSENCE
 * of any path from the proposal route to a deployment. So the comparison baseline
 * comes from here, and is authenticated rather than trusted: the worker accepts it
 * only once it hashes to the `specHash` in its own deployment registry, which
 * `WorkflowAgent` is the sole writer of. A forged baseline cannot be made to
 * match, so nothing about the boundary moves into the client.
 *
 * ## Why it does not go through `CloudService`
 *
 * Same two reasons `DeploymentsService` does not. A subscriber whose deploy target
 * is AWS or their own Cloudflare account still has a Phorma Cloud account, and a
 * review queue belongs to that account - so the hosted target is PINNED rather
 * than resolved from the chosen deploy target. And reaching for `CloudService`
 * would close the known NG0200 cycle in a new place, which is also why the push
 * path calls INTO this service through a settable seam
 * (`CloudService.specProposer`, installed by the shell) rather than injecting it.
 *
 * `dispatchCloudOperation` and the five `proposal-*` entries in the phorma route
 * table are what keep this from becoming a second copy of the request plumbing.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { DEPLOY_TARGETS } from './deploy/deploy-targets';
import {
  dispatchCloudOperation,
  type CloudCallResult,
  type CloudScopeResolver,
} from './deploy/cloud-dispatch';
import type { CloudTransport } from './deploy/cloud-transport';
import { ActiveOwnerService } from './active-owner.service';
import { DeploymentsService } from './deployments.service';
import { DesktopAuthService } from './desktop-auth.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { ToastService } from '../shared/toast/toast.service';
import type { WorkflowSpec } from './workflow.model';
import {
  type ProposalConnectionRef,
  type ProposalCreateRequest,
  type ProposalDetailResponse,
  type ProposalListResponse,
  type ProposalSubmitOutcome,
  type ProposalSummary,
} from './proposals.model';

/** The Phorma Cloud route table. Pinned, never resolved from the deploy target. */
const HOSTED_ENDPOINTS = DEPLOY_TARGETS.phorma.endpoints;

/** One proposal plus the spec it proposes, as a review surface needs it. */
export interface ProposalDetail {
  proposal: ProposalSummary;
  spec: WorkflowSpec;
  connections: ProposalConnectionRef[];
}

@Injectable({ providedIn: 'root' })
export class ProposalsService {
  // Identical injection set to `DeploymentsService`, deliberately: this service
  // sits DOWNSTREAM of `PhormaCloudService` and nothing on the transport cycle
  // injects it. `CloudService` is absent - see the file header.
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly desktopAuth = inject(DesktopAuthService);
  // The deployed spec reader, which already owns the `read-spec` call and its
  // failure reporting. A second copy of it here would be a second way for a
  // submission to disagree with what is deployed.
  private readonly deployments = inject(DeploymentsService);
  private readonly toast = inject(ToastService);
  // A DI LEAF - it injects nothing at all - so this edge is safe even on the
  // transport path. It supplies the `X-Phorma-Owner` header this service's
  // `fetch-bearer` transport sends beside its bearer.
  private readonly activeOwner = inject(ActiveOwnerService);

  /** The workflow the loaded queue belongs to, or null. */
  private readonly queueWorkflowId = signal<string | null>(null);
  private readonly rows = signal<ProposalSummary[]>([]);
  /** Non-pending proposals the worker retains per workflow, as it reported it. */
  readonly proposalsKept = signal(0);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  /** The proposal id whose transition is in flight, for a per-row spinner. */
  readonly busyProposalId = signal<string | null>(null);
  /** Human-readable failure from the last list read, or null. */
  readonly error = signal<string | null>(null);

  /** The loaded queue, newest first. */
  readonly proposals = this.rows.asReadonly();

  /** The one proposal awaiting review, or null. At most one can exist. */
  readonly pending = computed(() => this.rows().find(row => row.status === 'pending') ?? null);

  /** The workflow the loaded queue belongs to. */
  readonly workflowId = this.queueWorkflowId.asReadonly();

  /**
   * Submits `spec` as a proposal (Requirement 12.1).
   *
   * Reads the DEPLOYED spec first, because the worker needs it to answer the scope
   * question and will not ask a deployment for it. A read failure is a refusal
   * rather than a submission with the baseline omitted: the worker would fail
   * closed anyway, and a 400 about a missing field is a worse account of "we could
   * not reach your deployment" than saying so.
   *
   * Returns a discriminated outcome rather than a boolean, because the author's
   * next move differs per refusal - see {@link ProposalSubmitOutcome}.
   */
  async submit(
    spec: WorkflowSpec,
    connections: readonly ProposalConnectionRef[] = [],
  ): Promise<ProposalSubmitOutcome> {
    if (this.submitting()) {
      return { ok: false, kind: 'failed', error: 'A proposal is already being submitted.' };
    }
    this.submitting.set(true);
    try {
      const liveSpec = await this.deployments.readDeployedSpec(spec.id);
      const payload: ProposalCreateRequest = {
        spec,
        connections: [...connections],
        // Absent when nothing is deployed yet, which the worker reads as "there is
        // no structure to preserve" rather than as a missing field.
        ...(liveSpec ? { liveSpec } : {}),
      };
      const result = await this.call<{ proposal: ProposalSummary }>(
        'proposal-create',
        { workflowId: spec.id },
        payload,
      );
      if (result.ok === 'unsupported') {
        return { ok: false, kind: 'failed', error: 'Phorma Cloud is not configured.' };
      }
      if (result.ok === false) return this.refusalOf(result);
      const proposal = result.value?.proposal;
      if (!proposal?.proposalId) {
        return { ok: false, kind: 'failed', error: 'The proposal could not be read back.' };
      }
      // Merge rather than re-list: the author is looking at this queue, and a full
      // refresh between two clicks reorders it under their cursor.
      if (this.queueWorkflowId() === spec.id) this.mergeRow(proposal);
      return { ok: true, proposal };
    } catch (error) {
      return {
        ok: false,
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Re-reads one workflow's queue.
   *
   * A failure KEEPS the previous rows and records the message, the same policy
   * `DeploymentsService.refresh` follows: going offline must not read as "there is
   * nothing to review".
   */
  async refresh(workflowId: string): Promise<void> {
    if (!workflowId) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.call<ProposalListResponse>('proposal-list', { workflowId });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      this.queueWorkflowId.set(workflowId);
      this.rows.set(Array.isArray(result.value.proposals) ? result.value.proposals : []);
      this.proposalsKept.set(result.value.proposalsKept ?? 0);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * One proposal with its proposed spec, for the review surface, or null.
   *
   * Null covers every failure and is already toasted here: the only caller is a
   * surface that has to render something else when it cannot load the diff.
   */
  async detail(workflowId: string, proposalId: string): Promise<ProposalDetail | null> {
    try {
      const result = await this.call<ProposalDetailResponse>('proposal-detail', {
        workflowId,
        proposalId,
      });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      const { proposal, spec, connections } = result.value;
      if (!proposal || !spec) throw new Error('This proposal no longer has a stored copy.');
      return { proposal, spec, connections: connections ?? [] };
    } catch (error) {
      this.toast.error(
        'Could not open the proposal',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Publishes a proposal: the worker runs the ORDINARY push path
   * (Requirement 12.7).
   *
   * The revision is sent, never looked up server-side - that is what makes two
   * reviewers deciding at once resolve to exactly one winner, with the loser told
   * the current revision rather than silently overwriting.
   */
  publish(proposal: ProposalSummary): Promise<boolean> {
    return this.transition(proposal, 'proposal-publish', {
      summary: 'Proposal published',
      detail: 'The deployed workflow now carries this change.',
      failure: 'Could not publish the proposal',
    });
  }

  /** Rejects a proposal, with an optional reason (Requirement 12.10). */
  reject(proposal: ProposalSummary, reason?: string): Promise<boolean> {
    return this.transition(
      proposal,
      'proposal-reject',
      {
        summary: 'Proposal rejected',
        detail: 'The author is notified. Their copy is kept.',
        failure: 'Could not reject the proposal',
      },
      reason,
    );
  }

  /** Shared body of {@link publish} and {@link reject}. */
  private async transition(
    proposal: ProposalSummary,
    op: 'proposal-publish' | 'proposal-reject',
    copy: { summary: string; detail: string; failure: string },
    reason?: string,
  ): Promise<boolean> {
    this.busyProposalId.set(proposal.proposalId);
    try {
      const result = await this.call<{ proposal: ProposalSummary }>(
        op,
        { workflowId: proposal.workflowId, proposalId: proposal.proposalId },
        { revision: proposal.revision, ...(reason ? { reason } : {}) },
      );
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      const moved = result.value?.proposal;
      if (moved) this.mergeRow(moved);
      this.toast.success(copy.summary, copy.detail);
      return true;
    } catch (error) {
      this.toast.error(copy.failure, error instanceof Error ? error.message : String(error));
      // The row is deliberately re-read on a failure and only on a failure: a
      // refusal is usually a lost race or a stale live spec, and both are answered
      // by showing the caller what is true now.
      await this.refresh(proposal.workflowId);
      return false;
    } finally {
      this.busyProposalId.set(null);
    }
  }

  /** Replaces one row in place, or prepends it when it is new. */
  private mergeRow(row: ProposalSummary): void {
    this.rows.update(rows => {
      const index = rows.findIndex(entry => entry.proposalId === row.proposalId);
      if (index === -1) {
        // A new pending row supersedes the previous one on the worker, so the
        // local copy has to follow or the queue shows two pending proposals.
        const displaced = rows.map(entry =>
          entry.status === 'pending' ? { ...entry, status: 'superseded' as const } : entry,
        );
        return [row, ...displaced];
      }
      const next = rows.slice();
      next[index] = row;
      return next;
    });
  }

  /**
   * One refused submission, classified by its append-only refusal code.
   *
   * The CODE decides, with the prose as a fallback: a studio that does not
   * recognise a code renders the worker's sentence rather than inventing one.
   */
  private refusalOf(result: {
    status: number;
    error: string;
    detail?: unknown;
  }): ProposalSubmitOutcome {
    const detail = (result.detail ?? {}) as {
      code?: unknown;
      violations?: unknown;
      violationCount?: unknown;
      liveSpecHash?: unknown;
      revision?: unknown;
    };
    const code = typeof detail.code === 'string' ? detail.code : null;
    if (code === 'proposal_scope') {
      const violations = Array.isArray(detail.violations)
        ? detail.violations.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return {
        ok: false,
        kind: 'scope',
        violations,
        violationCount:
          typeof detail.violationCount === 'number' ? detail.violationCount : violations.length,
      };
    }
    if (code === 'proposal_stale') {
      return {
        ok: false,
        kind: 'stale',
        liveSpecHash: typeof detail.liveSpecHash === 'string' ? detail.liveSpecHash : '',
      };
    }
    if (code === 'proposal_conflict') {
      return {
        ok: false,
        kind: 'conflict',
        revision: typeof detail.revision === 'number' ? detail.revision : 0,
      };
    }
    return { ok: false, kind: 'failed', error: result.error };
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /** Bases pinned to Phorma Cloud, never to the chosen deploy target. */
  private readonly scope: CloudScopeResolver = {
    root: () => loadPhormaCloudUrl(),
    instance: workflowId => {
      const base = loadPhormaCloudUrl();
      return base ? DEPLOY_TARGETS.phorma.instanceUrl(base, workflowId || 'default') : null;
    },
  };

  /**
   * `fetch` plus the account bearer, with the desktop device token FIRST for the
   * measured reason `CloudService.resolveAuthToken` and `DeploymentsService` both
   * order it that way: a packaged build never loads a Clerk session, so a
   * Clerk-first order sends no `Authorization` header at all.
   */
  private readonly transport: CloudTransport = {
    id: 'fetch-bearer',
    send: async (url, init) => {
      const token = (await this.desktopAuth.token()) ?? (await this.phormaCloud.sessionToken());
      const headers: Record<string, string> = {
        ...init.headers,
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      // The ACTIVE owner, beside the bearer (multi-organisation-phorma,
      // Requirement 20.4). A proposal belongs to the organisation whose deployment
      // it is against, which is the owner this header names.
      Object.assign(headers, this.activeOwner.ownerHeader());
      const response = await fetch(url, { method: init.method, headers, body: init.body });
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    monitorSocketUrl: async () => {
      throw new Error('ProposalsService does not open a monitor socket.');
    },
  };

  private call<T>(
    op: 'proposal-list' | 'proposal-create' | 'proposal-detail' | 'proposal-publish' | 'proposal-reject',
    ctx: { workflowId: string; proposalId?: string },
    payload?: unknown,
  ): Promise<CloudCallResult<T>> {
    return dispatchCloudOperation<T>(HOSTED_ENDPOINTS, this.transport, this.scope, op, ctx, payload);
  }
}
