/**
 * Turning facts into notifications: the copy, the icons, and the rules about
 * which facts are worth telling somebody.
 *
 * A leaf module - pure functions, no `inject`, no Angular import - for the same
 * reason `deploy-targets.ts` and `billing-refusal.ts` are. `RunControllerService`
 * ends up on the local-run side of this, and it sits on the known NG0200 cycle,
 * so nothing here may reach a service.
 *
 * Keeping the decisions here rather than in the two producers is what stops the
 * cloud feed and the local feed drifting into two different vocabularies for the
 * same event. It also makes the interesting rules testable without a poll, a
 * worker, or a run: which sources earn a completion notice, what a stable
 * notification id looks like, and how long a detail line may be.
 */

import { fnv1a } from '@phorma/engine';

import { remedyForRunFailure, type BillingRemedy } from './billing-refusal';
import type {
  DeploymentNotice,
  NoticePending,
  NoticeRun,
  NotificationKind,
  NotificationTone,
  PendingActionRow,
  StudioNotification,
} from './notifications.model';

/**
 * How much of a failure message a notification row carries.
 *
 * A `run-failed` message is arbitrary text from anywhere in a workflow and can be
 * an entire HTTP error body. The row is a summary with a way through to the run,
 * so it is clipped here rather than left to CSS - a 4 KB string in a signal that
 * something renders `title` from is a cost paid on every change detection.
 */
export const NOTIFICATION_DETAIL_CHARS = 160;

/**
 * Run sources whose COMPLETION is worth announcing.
 *
 * The test is "was anybody watching". A schedule fires while the app may not even
 * be open and a webhook fires because something outside the studio asked, so
 * their outcome is news. A `manual` run is one the user just started and is
 * looking at; an `eval` run has the Evals panel's own progress UI and a suite
 * would produce a row per case; a `portal` run happens once per visitor message,
 * which would turn a busy portal into a feed nobody can read; a `resume` is the
 * continuation of a run already reported.
 *
 * FAILURES are not filtered this way - see {@link failureIsWorthReporting}.
 */
export const UNATTENDED_RUN_SOURCES: readonly string[] = ['schedule', 'webhook'];

/**
 * Sources whose FAILURE is deliberately not reported.
 *
 * Only `eval`. An eval run failing is an ordinary authoring outcome, it is
 * already displayed case by case in the Evals panel, and a suite of thirty cases
 * would push everything else out of a 200-row feed. Every other source reports a
 * failure, including `portal` - a visitor hitting an error is exactly the thing an
 * owner needs to hear about and currently never does.
 */
const SILENT_FAILURE_SOURCES: readonly string[] = ['eval'];

/** True when a failed run of this source should raise a notification. */
export function failureIsWorthReporting(source: string): boolean {
  return !SILENT_FAILURE_SOURCES.includes(source);
}

/** True when a completed run of this source should raise a notification. */
export function completionIsWorthReporting(source: string): boolean {
  return UNATTENDED_RUN_SOURCES.includes(source);
}

/**
 * A stable notification id.
 *
 * `{scope}:{subject}:{kind}` - and stability is the whole point rather than
 * tidiness. The deployed feed is RE-DERIVED from the worker on every poll instead
 * of being persisted, so the same settled run is reported again and again until
 * the cursor passes it. Merging on this id makes that a no-op; anything less
 * stable grows a duplicate row every few seconds.
 *
 * `scope` is the workflow id, or the literal `draft` for a run of an unsaved
 * document - matching the `workflowKey` convention every workflow-scoped
 * IndexedDB store already uses, so the two never disagree about what a draft is.
 */
export function notificationId(
  workflowId: string | null,
  subject: string,
  kind: NotificationKind,
): string {
  return `${workflowId ?? 'draft'}:${subject}:${kind}`;
}

/** One line of detail, clipped. */
export function clipDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > NOTIFICATION_DETAIL_CHARS
    ? `${flat.slice(0, NOTIFICATION_DETAIL_CHARS)}…`
    : flat;
}

/** Tabler icon and tone per kind, in one place so no two rows disagree. */
const PRESENTATION: Readonly<Record<NotificationKind, { icon: string; tone: NotificationTone }>> = {
  'deployed-run-failed': { icon: 'ti-alert-triangle', tone: 'error' },
  'deployed-run-completed': { icon: 'ti-clock-check', tone: 'success' },
  'deployed-run-stopped': { icon: 'ti-player-stop', tone: 'warning' },
  'deployment-issue': { icon: 'ti-alert-hexagon', tone: 'warning' },
  'local-run-failed': { icon: 'ti-alert-triangle', tone: 'error' },
  'local-run-completed': { icon: 'ti-circle-check', tone: 'success' },
  'local-run-stopped': { icon: 'ti-player-stop', tone: 'warning' },
  'orphan-deployment': { icon: 'ti-cloud-question', tone: 'warning' },
};

/** The icon and tone a kind renders with. */
export function presentationFor(kind: NotificationKind): { icon: string; tone: NotificationTone } {
  return PRESENTATION[kind];
}

/** The remedy a failure earns, or undefined when there is nothing to offer. */
function remedyFor(
  message: string | undefined,
  code: string | undefined,
): Exclude<BillingRemedy, 'none'> | undefined {
  const remedy = remedyForRunFailure(message ?? '', code);
  // `'none'` is stored as absent: there is nothing to offer, and keeping the
  // token would invite a call site to render a disabled button for it.
  return remedy === 'none' ? undefined : remedy;
}

/** Which kind a settled deployed run maps to. */
function deployedKindFor(status: NoticeRun['status']): NotificationKind {
  if (status === 'failed') return 'deployed-run-failed';
  return status === 'stopped' ? 'deployed-run-stopped' : 'deployed-run-completed';
}

/**
 * One settled deployed run as a notification, or null when it is not news.
 *
 * The source filter lives here rather than at the poll, so the same rule applies
 * to a re-derived run on the next tick and cannot be forgotten by a second caller.
 */
export function notificationFromRun(
  run: NoticeRun,
  workflowId: string,
  workflowName: string,
): StudioNotification | null {
  const kind = deployedKindFor(run.status);
  if (run.status === 'failed' && !failureIsWorthReporting(run.source)) return null;
  if (run.status === 'completed' && !completionIsWorthReporting(run.source)) return null;
  // A stopped run is only news when nobody asked for the stop, and the only stop
  // button is in the studio - so a stopped UNATTENDED run means a timeout or a
  // deploy replaced it, which is worth saying.
  if (run.status === 'stopped' && !completionIsWorthReporting(run.source)) return null;

  const { icon, tone } = presentationFor(kind);
  const remedy = run.status === 'failed' ? remedyFor(run.error, run.code) : undefined;
  return {
    id: notificationId(workflowId, run.runId, kind),
    kind,
    origin: 'deployed',
    tone,
    icon,
    title: titleForRun(kind, workflowName, run.source),
    detail: clipDetail(run.status === 'failed' ? run.error : undefined),
    // The moment the run ENDED, from the worker. Not the moment we polled - a
    // failure that happened before the user last read the feed is not new to them.
    at: run.endedAt,
    workflowId,
    workflowName,
    runId: run.runId,
    ...(remedy ? { remedy } : {}),
  };
}

/** Row copy. Labels, so no trailing punctuation. */
function titleForRun(kind: NotificationKind, workflowName: string, source: string): string {
  const scheduled = source === 'schedule';
  switch (kind) {
    case 'deployed-run-failed':
      return scheduled ? `Scheduled run of "${workflowName}" failed` : `"${workflowName}" failed in the cloud`;
    case 'deployed-run-completed':
      return scheduled
        ? `Scheduled run of "${workflowName}" finished`
        : `"${workflowName}" finished in the cloud`;
    case 'deployed-run-stopped':
      return `"${workflowName}" was stopped in the cloud`;
    case 'local-run-failed':
      return `"${workflowName}" failed`;
    case 'local-run-completed':
      return `"${workflowName}" finished`;
    case 'local-run-stopped':
      return `"${workflowName}" was stopped`;
    default:
      return workflowName;
  }
}

/**
 * A deployment's operator-facing problem as a notification.
 *
 * The id hashes the issue TEXT because `settingsIssues` carries no identity and
 * no timestamp - it is a growing array of sentences on the instance. Hashing the
 * text is what makes the same complaint on the next poll the same notification
 * rather than a new one, and `fnv1a` is reused from the engine rather than
 * hand-rolled so there is one hash in the product.
 */
export function notificationFromIssue(
  issue: string,
  workflowId: string,
  workflowName: string,
  now: number,
): StudioNotification {
  const { icon, tone } = presentationFor('deployment-issue');
  return {
    id: notificationId(workflowId, `issue-${fnv1a(issue)}`, 'deployment-issue'),
    kind: 'deployment-issue',
    origin: 'deployed',
    tone,
    icon,
    title: `"${workflowName}" needs attention`,
    detail: clipDetail(issue),
    // No natural timestamp exists for an issue, so this is when we first saw it.
    // The store PINS `at` on a re-merge, which is what stops a timestamp-less
    // notification going unread again on every poll.
    at: now,
    workflowId,
    workflowName,
  };
}

/** Everything one deployment's notice contributes to the feed. */
export function notificationsFromNotice(
  notice: DeploymentNotice,
  now: number,
): StudioNotification[] {
  const out: StudioNotification[] = [];
  for (const run of notice.runs) {
    const entry = notificationFromRun(run, notice.workflowId, notice.workflowName);
    if (entry) out.push(entry);
  }
  for (const issue of notice.issues) {
    out.push(notificationFromIssue(issue, notice.workflowId, notice.workflowName, now));
  }
  return out;
}

/**
 * Whether a pending gate can be settled from the dropdown itself.
 *
 * An approval with no payload is a yes/no question and nothing is gained by
 * making the user open the run. An approval that CARRIES a payload is a decision
 * about content, and approving a payment gate from a dropdown without seeing what
 * is being approved is the failure mode this rule exists to prevent. A question
 * needs free text and a wait needs an event body, so neither fits a two-button row.
 */
export function isInlineResolvable(pending: NoticePending): boolean {
  return pending.kind === 'approval' && !pending.hasPayload;
}

/** One deployment's pending gates as action rows. */
export function pendingRowsFromNotice(notice: DeploymentNotice): PendingActionRow[] {
  return notice.pending.map(pending => ({
    ...pending,
    origin: 'deployed' as const,
    workflowId: notice.workflowId,
    workflowName: notice.workflowName,
    resolvableInline: isInlineResolvable(pending),
  }));
}

/** A settled LOCAL run as a notification, or null when it is not news. */
export function notificationFromLocalRun(input: {
  runId: string;
  status: 'completed' | 'failed' | 'stopped';
  source: string;
  workflowId: string | null;
  workflowName: string;
  endedAt: number;
  error?: string;
  code?: string;
}): StudioNotification | null {
  if (input.status === 'failed' && !failureIsWorthReporting(input.source)) return null;
  // A local completion or stop of an eval case is the Evals panel's business.
  if (input.status !== 'failed' && input.source === 'eval') return null;

  const kind: NotificationKind =
    input.status === 'failed'
      ? 'local-run-failed'
      : input.status === 'stopped'
        ? 'local-run-stopped'
        : 'local-run-completed';
  const { icon, tone } = presentationFor(kind);
  const remedy = input.status === 'failed' ? remedyFor(input.error, input.code) : undefined;
  return {
    id: notificationId(input.workflowId, input.runId, kind),
    kind,
    origin: 'local',
    tone,
    icon,
    title: titleForRun(kind, input.workflowName, input.source),
    detail: clipDetail(input.status === 'failed' ? input.error : undefined),
    at: input.endedAt,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    runId: input.runId,
    ...(remedy ? { remedy } : {}),
  };
}

/** A deployment with nothing in the local library to open. */
export function orphanNotification(input: {
  workflowId: string;
  workflowName: string;
  now: number;
}): StudioNotification {
  const { icon, tone } = presentationFor('orphan-deployment');
  return {
    id: notificationId(input.workflowId, 'orphan', 'orphan-deployment'),
    kind: 'orphan-deployment',
    origin: 'deployed',
    tone,
    icon,
    title: `"${input.workflowName}" is deployed but not in your library`,
    detail: 'It is still running and still spending credits. Restore it or remove it.',
    at: input.now,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
  };
}
