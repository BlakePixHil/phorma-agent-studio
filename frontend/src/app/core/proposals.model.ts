/**
 * The proposal wire contract, studio side (multi-organisation-phorma,
 * Requirement 12; design section 16).
 *
 * STRUCTURAL TWIN of `cloud/src/proposals.ts`. Two independent declarations and
 * no shared import, because `cloud/` cannot import from `frontend/` - so a change
 * to `ProposalStatus`, `ProposalSummary`, `ProposalNotice` or the four refusal
 * codes is a change to BOTH files in the same commit (Requirements 16.3, 16.4).
 * The twin is named in `.kiro/steering/structure.md` beside the others.
 *
 * Everything below the wire section is STUDIO-ONLY, the same split
 * `notifications.model.ts` carries: the worker has no notion of a review's
 * field-grouped diff or of a submission outcome the studio branches on.
 */

import type { WorkflowSpec } from './workflow.model';

// ── The wire half (twinned with cloud/src/proposals.ts) ─────────────────────

/**
 * The four states a proposal can be in.
 *
 * APPEND-ONLY, and named tokens rather than a ladder: a status is persisted in a
 * worker row and rendered by a studio that may be three versions old.
 * `published`, `rejected` and `superseded` are TERMINAL.
 */
export type ProposalStatus = 'pending' | 'published' | 'rejected' | 'superseded';

/** Display order only. Never an ordering for a comparison. */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'pending',
  'published',
  'rejected',
  'superseded',
];

/** True when a value is one of the four declared statuses. */
export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/** True when a status can never transition again. */
export function isTerminalProposalStatus(status: ProposalStatus): boolean {
  return status !== 'pending';
}

/**
 * The proposal refusal codes. ONE append-only set: a released token is never
 * renamed or repurposed, and a studio that does not recognise one renders the
 * refusal's prose instead (Requirements 12.12, 16.2).
 */
export type ProposalRefusalCode =
  | 'proposal_scope'
  | 'proposal_stale'
  | 'proposal_conflict'
  | 'proposal_unencrypted';

/** One proposal as the studio sees it. Carries no rowid and no storage key. */
export interface ProposalSummary {
  proposalId: string;
  workflowId: string;
  /** The member who submitted it. Never the resolved owner. */
  authorUserId: string;
  status: ProposalStatus;
  /** The conditional-update guard. A transition must send the value it read. */
  revision: number;
  /** Canonical_Spec_Hash of the PROPOSED spec. */
  specHash: string;
  /** The deployed spec's hash when this proposal was created. Frozen. */
  liveSpecHash: string;
  /** An optional rejection reason. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One connection a proposed workflow references. Id and display name only. */
export interface ProposalConnectionRef {
  id: string;
  name: string;
}

/** `GET /api/proposals/{workflowId}`. */
export interface ProposalListResponse {
  workflowId: string;
  /** Newest first. At most one of them is `pending`. */
  proposals: ProposalSummary[];
  /** Non-pending proposals the worker retains per workflow. */
  proposalsKept: number;
}

/** `GET /api/proposals/{workflowId}/{proposalId}`. */
export interface ProposalDetailResponse {
  proposal: ProposalSummary | null;
  spec: WorkflowSpec | null;
  connections: ProposalConnectionRef[];
}

/**
 * `POST /api/proposals/{workflowId}` - one submission.
 *
 * `liveSpec` is the deployed spec the author was editing. It is not stored, and
 * it is not taken on trust: the worker only uses it once it hashes to the
 * `specHash` its own deployment registry holds, which is what lets the scope check
 * (Requirement 12.2) run without waking the deployed instance.
 */
export interface ProposalCreateRequest {
  spec: WorkflowSpec;
  connections: ProposalConnectionRef[];
  liveSpec?: WorkflowSpec;
}

/** `{revision, reason?}` - the body of a publish or a reject. */
export interface ProposalTransitionRequest {
  revision: number;
  reason?: string;
}

/** One decided proposal, as the AUTHOR's notification feed reports it. */
export interface ProposalNotice {
  proposalId: string;
  workflowId: string;
  status: 'published' | 'rejected';
  reason: string | null;
  /** Epoch ms of the transition. */
  at: number;
}

// ── Studio-only (no worker counterpart) ─────────────────────────────────────

/**
 * What one submission attempt did.
 *
 * A discriminated outcome rather than a boolean, because the three refusals mean
 * three different things to the author and only one of them is retryable by
 * pressing the button again:
 *
 *  - `scope` - a builder has to make this change. The violations name it.
 *  - `stale` - the deployed workflow moved; re-open it and redo the edit.
 *  - `conflict` - somebody submitted at the same moment; re-read the queue.
 */
export type ProposalSubmitOutcome =
  | { ok: true; proposal: ProposalSummary }
  | { ok: false; kind: 'scope'; violations: string[]; violationCount: number }
  | { ok: false; kind: 'stale'; liveSpecHash: string }
  | { ok: false; kind: 'conflict'; revision: number }
  | { ok: false; kind: 'failed'; error: string };

/** A human label for a status, for a chip or a row. */
export function proposalStatusLabel(status: ProposalStatus): string {
  switch (status) {
    case 'pending':
      return 'Awaiting review';
    case 'published':
      return 'Published';
    case 'rejected':
      return 'Rejected';
    case 'superseded':
      return 'Replaced';
  }
}

/** The Tabler icon for a status, without the leading `ti `. */
export function proposalStatusIcon(status: ProposalStatus): string {
  switch (status) {
    case 'pending':
      return 'ti-clock-hour-4';
    case 'published':
      return 'ti-cloud-check';
    case 'rejected':
      return 'ti-circle-x';
    case 'superseded':
      return 'ti-exchange';
  }
}
