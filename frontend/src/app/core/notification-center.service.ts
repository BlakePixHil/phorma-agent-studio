/**
 * The notification centre: one merged view of everything waiting and everything
 * that happened, and the actions the bell performs.
 *
 * ## Why this exists as a third service
 *
 * `NotificationsService` is a bare store because `RunControllerService` injects it,
 * and `RunControllerService` sits on the known NG0200 cycle
 * (`RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`). Anything the store reached would be
 * dragged onto that path.
 *
 * So the parts that DO need the run controller, the deployment list and the
 * workflow library live here instead, and this service is injected only by
 * components. Nothing on the transport path injects it, so the edges below are
 * safe in the one direction that matters.
 *
 * ## What it merges, and the one duplicate it has to prevent
 *
 * Pending gates arrive from two places at once for a monitored cloud workflow:
 * `RunControllerService` synthesizes a card from the `approval-required` event on
 * the monitor socket, and the account-wide poll reports the same gate out of the
 * Durable Object's memory. Both are real; both describe one gate. The merge keeps
 * the LOCAL one, because its resolver is the open socket and settles instantly,
 * while the polled one costs an HTTP round trip. Dropping that dedupe puts two
 * rows on screen for one decision, and answering either leaves the other looking
 * unanswered until the next poll.
 *
 * ## Why deep-linking is a settable seam
 *
 * Navigating to a run needs `CloudService` (to attach the monitor) and this
 * service must not inject it. So the shell installs a handler, exactly as it
 * installs `RunControllerService.remoteApprovalSender`. The alternative - reaching
 * for `CloudService` here - closes the cycle in a new place.
 */

import { computed, inject, Injectable, signal } from '@angular/core';

import { DeployedNotificationsService } from './deployed-notifications.service';
import { DeploymentsService } from './deployments.service';
import { NotificationsService } from './notifications.service';
import { RunControllerService } from './run-controller.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import { orphanNotification } from './notification-projection';
import type {
  NoticePendingKind,
  PendingActionRow,
  StudioNotification,
} from './notifications.model';

/** Where the bell should take the user for one notification or action. */
export interface NotificationTarget {
  workflowId: string | null;
  /** The run to select, when the notification is about one. */
  runId?: string;
  /**
   * True when the target is a DEPLOYED run, so the shell attaches the cloud
   * monitor rather than just opening the document.
   */
  deployed: boolean;
}

/** What the shell installs to perform a deep link. */
export type NotificationDeepLinkHandler = (target: NotificationTarget) => void;

@Injectable({ providedIn: 'root' })
export class NotificationCenterService {
  private readonly store = inject(NotificationsService);
  private readonly deployed = inject(DeployedNotificationsService);
  private readonly deployments = inject(DeploymentsService);
  private readonly runController = inject(RunControllerService);
  private readonly workflow = inject(WorkflowService);
  private readonly toast = inject(ToastService);

  /**
   * Performs a deep link. Installed by the shell; null until then.
   *
   * Mirrors `RunControllerService.remoteApprovalSender` - a settable seam rather
   * than an injected service, so this service stays off the DI cycle.
   */
  deepLinkHandler: NotificationDeepLinkHandler | null = null;

  /** True while the dropdown is open, so the trigger can render its state. */
  readonly open = signal(false);

  /** The feed, newest first. */
  readonly feed = this.store.feed;

  /** Deployments the last poll could not reach - surfaced, never hidden. */
  readonly unreachable = this.deployed.unreachable;

  /** True when the account has more deployments than one poll asks. */
  readonly truncated = this.deployed.truncated;

  /** The last poll's failure, or null. */
  readonly pollError = this.deployed.error;

  /** True while a poll is in flight, for the manual refresh affordance. */
  readonly refreshing = this.deployed.loading;

  /**
   * Everything waiting on a human, longest-waiting first.
   *
   * Local gates and polled gates merged and deduped on the gate's own id - see the
   * file header for why the local one wins.
   */
  readonly pendingActions = computed<PendingActionRow[]>(() => {
    const local = this.localPendingRows();
    const byId = new Map(local.map(row => [row.id, row]));
    for (const row of this.deployed.pending()) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => a.since - b.since);
  });

  /**
   * What the bell's badge shows.
   *
   * Pending actions are counted whether they are read or not, because "read" is
   * meaningless for something still waiting on you - a badge that clears while an
   * approval is unanswered is a badge that hid the only thing that mattered.
   * Unread notifications are counted on top.
   */
  readonly badgeCount = computed(() => this.pendingActions().length + this.store.unreadCount());

  /** True when anything in the badge is a problem, for the bell's tint. */
  readonly hasProblem = computed(
    () => this.store.hasUnreadProblem() || this.pendingActions().length > 0,
  );

  /** Rows the bell renders in its "Recent" section, with drift and orphans folded in. */
  readonly recent = computed<StudioNotification[]>(() => {
    const derived = this.derivedNotifications();
    if (derived.length === 0) return [...this.feed()];
    // Derived rows are computed rather than stored, because they describe a STATE
    // (this deployment has no local copy) rather than an event, and a stored row
    // would survive the state ending. Merged on id so a stored twin cannot double.
    const byId = new Map(this.feed().map(entry => [entry.id, entry]));
    for (const entry of derived) if (!byId.has(entry.id)) byId.set(entry.id, entry);
    return [...byId.values()].sort((a, b) => b.at - a.at);
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  toggle(): void {
    this.open.update(value => !value);
    // Opening the bell is the moment the user has seen what is in it. Marking read
    // on OPEN rather than on close means the badge clears immediately, which is
    // what makes it trustworthy - a badge that lingers after you looked stops
    // being read at all.
    if (this.open()) this.store.markAllRead();
  }

  close(): void {
    this.open.set(false);
  }

  markAllRead(): void {
    this.store.markAllRead();
  }

  dismiss(id: string): void {
    this.store.dismiss(id);
  }

  /** Re-polls the account now. */
  refresh(): Promise<void> {
    return this.deployed.refresh();
  }

  /**
   * Settles one pending action from the dropdown.
   *
   * A LOCAL gate carries its own resolver, so it settles in memory with no
   * network at all - that covers both a local engine run and a monitored cloud run
   * whose socket is open. A polled gate goes over HTTP to its own deployment.
   *
   * Returns false when nothing was delivered, and says so on a toast: a gate can
   * genuinely have been answered elsewhere between two polls, and silently
   * swallowing that would leave the user believing they approved something.
   */
  async resolve(row: PendingActionRow, approved: boolean): Promise<boolean> {
    if (row.kind !== 'approval') {
      // Only approvals are settleable here. A question needs free text and a wait
      // needs an event body, so both deep-link instead - see `isInlineResolvable`.
      this.navigateTo(row);
      return false;
    }

    const local = this.runController.pendingApprovals().find(entry => entry.requestId === row.id);
    if (local) {
      this.runController.resolveApproval(row.id, approved);
      return true;
    }

    const delivered = await this.deployed.resolveApproval(row, approved);
    if (!delivered) {
      this.toast.warning(
        'Nothing to approve',
        `"${row.nodeName}" is no longer waiting - it may have been answered somewhere else, or the run has moved on.`,
      );
    }
    return delivered;
  }

  /** Opens whatever a notification is about. */
  navigateToNotification(notification: StudioNotification): void {
    this.close();
    this.deepLinkHandler?.({
      workflowId: notification.workflowId,
      runId: notification.runId,
      deployed: notification.origin === 'deployed',
    });
  }

  /** Opens the run a pending action belongs to. */
  navigateTo(row: PendingActionRow): void {
    this.close();
    this.deepLinkHandler?.({
      workflowId: row.workflowId,
      runId: row.runId,
      deployed: row.origin === 'deployed',
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * The run controller's live gates as action rows.
   *
   * Their origin is decided by whether a remote resolver is installed rather than
   * by which service created them: a card synthesized from the monitor socket has
   * `remoteApprovalSender` behind it and belongs to a DEPLOYED run, even though it
   * lives in the local controller. Getting that wrong would send a deep link to
   * the local canvas for a run executing in the cloud.
   */
  private localPendingRows(): PendingActionRow[] {
    const doc = this.workflow.activeDoc();
    const workflowId = doc?.workflowId ?? null;
    const workflowName = doc?.name ?? 'Untitled workflow';
    const rows: PendingActionRow[] = [];

    const monitored = this.runController.remoteApprovalSender !== null;
    const origin = monitored ? ('deployed' as const) : ('local' as const);

    for (const approval of this.runController.pendingApprovals()) {
      rows.push({
        kind: 'approval',
        id: approval.requestId,
        nodeId: approval.nodeId,
        nodeName: approval.nodeName,
        message: approval.message,
        hasPayload: hasContext(approval.payload),
        runId: approval.runId,
        since: approval.since,
        origin,
        workflowId,
        workflowName,
        // A payload-free approval is a yes/no question, and a local one settles
        // with no network at all - the cheapest inline action in the product.
        resolvableInline: !hasContext(approval.payload),
      });
    }
    for (const question of this.runController.pendingQuestions()) {
      rows.push(
        gateRow('question', question.requestId, question.nodeId, question.nodeName, question.question, question.payload, question.runId, question.since, origin, workflowId, workflowName),
      );
    }
    for (const wait of this.runController.pendingWaits()) {
      rows.push(
        gateRow('wait', wait.correlationKey, wait.nodeId, wait.nodeName, wait.message, wait.payload, wait.runId, wait.since, origin, workflowId, workflowName),
      );
    }
    return rows;
  }

  /**
   * Notifications derived from CURRENT state rather than from an event.
   *
   * Spec drift and orphan deployments are conditions, not moments: they become
   * true and later stop being true, and a stored row would outlive the condition -
   * a restored orphan would keep its "not in your library" notice until the ring
   * buffer evicted it. So these are computed on read, from the deployment list the
   * settings surface already maintains.
   *
   * Nothing here polls. `DeploymentsService.refresh()` is on demand, so this is
   * empty until some surface has loaded the list, and that is deliberate: the
   * feature must not add a second background request for two advisory rows.
   */
  private derivedNotifications(): StudioNotification[] {
    // The mute is checked HERE as well as in the store, because a derived row never
    // passes through `add()`. Without it, switching a kind off would silence the
    // polled rows and leave the derived ones on screen, which reads as the setting
    // being broken rather than as a design decision.
    if (this.store.isMuted('orphan-deployment')) return [];
    const now = Date.now();
    return this.deployments
      .deployments()
      .filter(deployment => deployment.orphan)
      .map(deployment =>
        orphanNotification({
          workflowId: deployment.workflowId,
          workflowName: deployment.workflowName,
          now,
        }),
      );
  }
}

/** True when a gate's payload is worth opening the run to read. */
function hasContext(payload: string | undefined): boolean {
  if (typeof payload !== 'string') return false;
  const trimmed = payload.trim();
  return trimmed.length > 0 && trimmed !== '{}' && trimmed !== 'null' && trimmed !== '""';
}

/** One non-approval gate row. Never inline-resolvable - both need more than a button. */
function gateRow(
  kind: Exclude<NoticePendingKind, 'approval'>,
  id: string,
  nodeId: string,
  nodeName: string,
  message: string,
  payload: string,
  runId: string,
  since: number,
  origin: 'local' | 'deployed',
  workflowId: string | null,
  workflowName: string,
): PendingActionRow {
  return {
    kind,
    id,
    nodeId,
    nodeName,
    message,
    hasPayload: hasContext(payload),
    runId,
    since,
    origin,
    workflowId,
    workflowName,
    resolvableInline: false,
  };
}
