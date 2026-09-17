/**
 * The `GET /api/notifications` response shape, plus the studio's own record type.
 *
 * Structural twin of `cloud/src/notifications.ts`. The studio and the worker each
 * declare this contract independently - `frontend/` cannot import from `cloud/` -
 * so a field added on one side and not the other compiles in one package and
 * breaks the other.
 *
 * The wire half stops at {@link NotificationsResponse}. Everything below it is
 * studio-only: a {@link StudioNotification} is what the bell renders, and it is
 * derived from the wire types AND from local run events, so it deliberately has
 * no counterpart in the worker.
 */

import type { BillingRemedy } from './billing-refusal';

// ── The wire contract (twin of cloud/src/notifications.ts) ──────────────────

/** How a settled run ended. */
export type NoticeRunStatus = 'completed' | 'failed' | 'stopped';

/** One settled run of a deployed workflow. */
export interface NoticeRun {
  runId: string;
  status: NoticeRunStatus;
  /**
   * The engine's `RunSource` - `schedule` is the one that matters most, because
   * it is the run nobody was watching.
   *
   * Typed `string` and not the union, for the reason `RunFailureCode` is: a
   * deployed worker is routinely a different version than the studio reading it,
   * so a source added to the engine tomorrow must be CARRIABLE by a studio built
   * today. Consumers branch with a default.
   */
  source: string;
  startedAt: number;
  endedAt: number;
  /** Failure message. Present only when `status` is `failed`. */
  error?: string;
  /**
   * The append-only entitlement refusal token, when the failure was one, read
   * from the run's terminal event by the worker.
   *
   * ABSENT is meaningful and different from unrecognised: an absent code means
   * ask the prose (`remedyForRunFailure`), an unrecognised one means a newer
   * worker and must never be guessed at.
   */
  code?: string;
}

/** Which kind of human-in-the-loop gate a run is suspended on. */
export type NoticePendingKind = 'approval' | 'question' | 'wait';

/** What a suspended gate is waiting for. */
export interface PendingGateMeta {
  /** Display metadata only - never an identity to key a map on. */
  nodeId: string;
  nodeName: string;
  /** The gate's own prompt text. */
  message: string;
  /**
   * True when the gate carries context worth opening the run to read.
   *
   * This is what decides between an inline Approve/Reject and sending the user to
   * the run. The payload itself never crosses the wire into an account-wide feed.
   */
  hasPayload: boolean;
  runId: string;
  /** Epoch ms the gate started waiting. */
  since: number;
}

/**
 * One gate waiting on a human, right now.
 *
 * LIVE state, not history: it comes from the instance's in-memory resolver maps,
 * so it vanishes on a Durable Object eviction and reappears when the resumed run
 * re-registers the gate. Treat it as a snapshot that can disappear between two
 * polls, never as a durable record - which is why resolving one is optimistic
 * with a rollback rather than assumed to succeed.
 */
export interface NoticePending extends PendingGateMeta {
  kind: NoticePendingKind;
  /** `requestId` for an approval or question; the correlation key for a wait. */
  id: string;
}

/** Everything one deployment has to report. */
export interface DeploymentNotice {
  workflowId: string;
  workflowName: string;
  /** Runs that settled after the cursor, newest-ended first. */
  runs: NoticeRun[];
  /** Gates waiting on a human right now, longest-waiting first. */
  pending: NoticePending[];
  /** Operator-facing problems collected on this instance. */
  issues: string[];
}

/** `GET /api/notifications` body. */
export interface NotificationsResponse {
  /**
   * Server clock when the answer was assembled - the cursor for the next call.
   *
   * Server-side rather than client-side so a machine with a fast clock cannot
   * hand back a future `since` and permanently skip its own notifications.
   */
  at: number;
  /**
   * Deployments the fan-out could not reach, by workflow id.
   *
   * NAMED, not dropped: "I could not ask this one" and "this one had nothing to
   * say" are different answers, and collapsing them turns an outage into a clean
   * bill of health.
   */
  unreachable: string[];
  /** True when the account has more deployments than one poll asks. */
  truncated: boolean;
  deployments: DeploymentNotice[];
}

// ── The studio's own record (no worker counterpart) ─────────────────────────

/**
 * What a notification is about.
 *
 * One flat union rather than a nested shape, because the kind is what picks the
 * icon, the copy and the action, and every consumer switches on it exactly once.
 * Ordered here roughly by how much it wants a human.
 */
export type NotificationKind =
  /** A deployed run failed. The headline case for this whole feature. */
  | 'deployed-run-failed'
  /**
   * A deployed run finished. Reported for a `schedule` source only: a run the
   * user triggered themselves is a run they are already watching.
   */
  | 'deployed-run-completed'
  /** A deployed run was stopped before it finished. */
  | 'deployed-run-stopped'
  /** An operator-facing problem on a deployment (`settingsIssues`). */
  | 'deployment-issue'
  /** A local run failed. */
  | 'local-run-failed'
  /** A local run finished while the user was looking at something else. */
  | 'local-run-completed'
  /** A local run was stopped. */
  | 'local-run-stopped'
  /**
   * A deployment with no local workflow to open - the reinstall case.
   *
   * There is deliberately no `spec-drift` sibling. `DeploymentRecord.specHash` is
   * `fnv1a(canonicalJson(spec))` over the spec AFTER `CloudService.materializeDefaults()`
   * has baked in the app-level defaults, and that method is private to
   * `CloudService` - which every service on this path must not inject, because it
   * closes the NG0200 cycle. Reproducing the transform here would be a second copy
   * of it, and comparing against the un-materialized spec would report drift on
   * every deployment that is perfectly current. A "your cloud copy is behind"
   * notice belongs with the push path that can compute it honestly.
   */
  | 'orphan-deployment';

/** Whether a notification is about the cloud or about this machine. */
export type NotificationOrigin = 'deployed' | 'local';

/** How loud a notification is. Drives the row tint, nothing else. */
export type NotificationTone = 'error' | 'warning' | 'info' | 'success';

/**
 * One row in the bell's feed.
 *
 * Session state. Notification BODIES are never persisted: the deployed ones are
 * re-derived from the worker on the next poll (which is what makes the read
 * marker double as the cursor), and the local ones belong to a run the Runs panel
 * and run history already own. Only the read marker and the mute set survive a
 * restart.
 */
export interface StudioNotification {
  /**
   * Stable identity: `{scope}:{subject}:{kind}`.
   *
   * This is the property that makes re-deriving the deployed feed safe. A repeat
   * poll re-reports the same run, and merging on this id makes that a no-op
   * instead of a duplicate row per tick.
   */
  id: string;
  kind: NotificationKind;
  origin: NotificationOrigin;
  tone: NotificationTone;
  /** One line. No trailing period - these are labels, not sentences. */
  title: string;
  /** Optional second line: the failure message, the issue text, the outcome. */
  detail?: string;
  /** Tabler icon class, without the leading `ti `. */
  icon: string;
  /** Epoch ms the underlying event happened, NOT when it was noticed. */
  at: number;
  /** Library workflow id, or null for a run of an unsaved draft. */
  workflowId: string | null;
  /** Name to show for the workflow, resolved at creation time. */
  workflowName: string;
  /** The run this is about, when there is one. */
  runId?: string;
  /**
   * The billing call to action this notification should offer, when its failure
   * was an entitlement refusal.
   *
   * Resolved through `billing-refusal.ts` at creation time and stored as the
   * REMEDY rather than as a label, so the bell renders the same copy the toast and
   * the Ctrl+P palette do. `'none'` is stored as absent - there is nothing to
   * offer, and an explicit `'none'` would invite a call site to render a
   * disabled button.
   */
  remedy?: Exclude<BillingRemedy, 'none'>;
}

/**
 * A notification the user must respond to, merged from both origins.
 *
 * Deliberately NOT a {@link StudioNotification}. A feed row is a record of
 * something that happened and is dismissible; a pending action is live state with
 * a resolver behind it, it disappears when somebody else answers it, and it must
 * never be dismissible - dismissing "this run needs your approval" would leave
 * the run suspended forever with nothing on screen to say so.
 */
export interface PendingActionRow extends PendingGateMeta {
  kind: NoticePendingKind;
  id: string;
  origin: NotificationOrigin;
  workflowId: string | null;
  workflowName: string;
  /**
   * True when this action can be settled from the dropdown itself.
   *
   * An approval with no payload is a yes/no question and is answered inline. An
   * approval carrying context, a free-text question, and a wait-for-event all
   * need the run open, so they deep-link instead.
   */
  resolvableInline: boolean;
}
