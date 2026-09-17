/**
 * The notification store: what the bell shows, and what counts as unread.
 *
 * ## What this service is, and what it deliberately is not
 *
 * A signal-backed ring buffer plus a read marker. It has no transport, no timer
 * and no knowledge of where a notification came from - `DeployedNotificationsService`
 * polls the cloud into it and `RunControllerService` pushes local run outcomes
 * into it, and neither is visible from here.
 *
 * That is a DI constraint rather than a preference. `RunControllerService` injects
 * this service, and `RunControllerService` sits on the known NG0200 cycle
 * (`RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`). So this service must reach nothing on
 * that path: no `CloudService`, no `PhormaCloudService`, no `RunControllerService`,
 * no `WorkflowService`. Everything that needs those lives in
 * `NotificationCenterService`, which only components inject.
 *
 * ## Why almost nothing is persisted
 *
 * Notification BODIES are session state, and that is a design decision with a
 * payoff rather than a shortcut. The deployed ones are re-derived from the worker
 * on the next poll, so persisting the READ MARKER is enough: polling
 * `?since={readAt}` means anything the user has not read comes back after a
 * restart, at no storage cost and with no IndexedDB migration. Local ones are not
 * re-derivable, but they are about a run the Runs panel and run history already
 * own, so losing the notification loses nothing.
 *
 * The read marker is therefore load-bearing in two ways at once - it is both "how
 * far the user has read" and "how far back to ask the worker" - which is why
 * {@link markAllRead} is the only thing that advances it.
 */

import { computed, Injectable, signal } from '@angular/core';

import { loadLayout, saveLayout } from './layout-storage';
import type { NotificationKind, StudioNotification } from './notifications.model';

/**
 * How many notifications the feed holds.
 *
 * A ceiling rather than a policy: the feed is a glanceable list, and the Runs
 * panel is where somebody goes for the full history. Oldest are evicted.
 */
export const NOTIFICATION_FEED_LIMIT = 200;

/**
 * `phorma.layout.*` keys this service owns.
 *
 * Under the layout prefix because that is where the app keeps small persisted
 * settings (`core/layout-storage.ts`), and these two values together are a few
 * dozen bytes. They are NOT layout in the visual sense, hence the explicit names.
 */
const READ_AT_KEY = 'notificationsReadAt';
const MUTED_KINDS_KEY = 'notificationsMutedKinds';

/**
 * Every notification kind a user may turn off, and its label.
 *
 * Declared as data so the settings block, the mute check and any future
 * per-kind UI all read the same list - a hand-written checkbox per kind is how
 * one gets forgotten when a kind is added.
 *
 * Note what is absent: the two run-FAILED kinds and `deployment-issue`. A user
 * can silence noise, not silence problems; a bell that can be configured to say
 * nothing when a deployed workflow breaks is a bell that cannot be trusted, and
 * "why did nobody tell me" is a worse outcome than one row too many.
 */
export const MUTABLE_NOTIFICATION_KINDS: readonly { kind: NotificationKind; label: string }[] = [
  { kind: 'deployed-run-completed', label: 'Scheduled cloud runs that finished' },
  { kind: 'deployed-run-stopped', label: 'Cloud runs that were stopped' },
  { kind: 'local-run-completed', label: 'Local runs that finished' },
  { kind: 'local-run-stopped', label: 'Local runs that were stopped' },
  { kind: 'orphan-deployment', label: 'Deployments with no local workflow' },
];

/** True when a kind may be muted at all. */
export function isMutableKind(kind: NotificationKind): boolean {
  return MUTABLE_NOTIFICATION_KINDS.some(entry => entry.kind === kind);
}

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  /** Newest first. The order the bell renders, so it is stored that way. */
  private readonly feedState = signal<StudioNotification[]>([]);

  /**
   * Epoch ms of the last "mark all read", and the poll cursor.
   *
   * Seeded from storage so a restart resumes where the user left off. A fresh
   * install starts at 0, which asks the worker for everything it still retains -
   * over-reporting once is better than a first run that silently hides a
   * yesterday failure, and the merge dedupes anyway.
   */
  private readonly readAtState = signal<number>(loadLayout(READ_AT_KEY, 0));

  /** Kinds the user has switched off. */
  private readonly mutedState = signal<readonly NotificationKind[]>(
    loadLayout<NotificationKind[]>(MUTED_KINDS_KEY, []),
  );

  readonly feed = this.feedState.asReadonly();
  readonly readAt = this.readAtState.asReadonly();
  readonly muted = this.mutedState.asReadonly();

  /**
   * Notifications the user has not seen.
   *
   * Compared against `at` - when the underlying thing HAPPENED - not against
   * when it was polled. A cron run that failed before the last "mark all read"
   * but only reached this machine afterwards is not news, and treating arrival as
   * the timestamp would resurrect it.
   */
  readonly unread = computed(() => {
    const readAt = this.readAtState();
    return this.feedState().filter(entry => entry.at > readAt);
  });

  readonly unreadCount = computed(() => this.unread().length);

  /** True when anything unread is a failure - the bell tints on this. */
  readonly hasUnreadProblem = computed(() => this.unread().some(entry => entry.tone === 'error'));

  /**
   * Merges notifications into the feed, idempotently.
   *
   * Idempotence is the whole contract here, and it is what lets the deployed feed
   * be re-derived rather than persisted: a poll re-reports the same settled run
   * every tick until the cursor moves past it, so a merge that appended would add
   * a row every few seconds forever. An incoming record REPLACES a stored one with
   * the same id, because the newer read is the better one.
   *
   * With ONE exception, and it is load-bearing: `at` is PINNED to the value the
   * notification first arrived with. Not every kind has a natural timestamp - a
   * deployment's `settingsIssues` are sentences with no clock at all, so their `at`
   * is "when we first saw this" - and letting a re-merge bump it would push the
   * notification back above the read marker on every single poll, giving a badge
   * that reappears seconds after being cleared and cannot be dismissed. Runs are
   * unaffected either way, since `endedAt` does not move.
   *
   * Muted kinds are dropped here rather than at the call sites, so a new producer
   * cannot forget to check.
   */
  add(incoming: readonly StudioNotification[]): void {
    const muted = new Set(this.mutedState());
    const admitted = incoming.filter(entry => !muted.has(entry.kind));
    if (admitted.length === 0) return;

    this.feedState.update(current => {
      const byId = new Map(current.map(entry => [entry.id, entry]));
      for (const entry of admitted) {
        const existing = byId.get(entry.id);
        byId.set(entry.id, existing ? { ...entry, at: existing.at } : entry);
      }
      return [...byId.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, NOTIFICATION_FEED_LIMIT);
    });
  }

  /** Convenience for the single-record producers. */
  addOne(notification: StudioNotification): void {
    this.add([notification]);
  }

  /**
   * Marks everything read and advances the poll cursor.
   *
   * The cursor is the greatest `at` in the feed rather than `Date.now()`, and the
   * difference matters: a notification whose `at` is slightly in the future
   * relative to this machine (a worker clock a second ahead) would otherwise stay
   * unread forever, with a badge nothing can clear. Falls back to now for an empty
   * feed so a cursor still advances past whatever the worker was retaining.
   */
  markAllRead(): void {
    const newest = this.feedState().reduce((max, entry) => Math.max(max, entry.at), 0);
    const next = Math.max(this.readAtState(), newest, Date.now());
    this.readAtState.set(next);
    // Written HERE rather than from an `effect()`, unlike the rest of the app's
    // persisted UI state. An effect defers the write to the next change-detection
    // flush, and this value is a poll CURSOR as well as a read marker: killing the
    // app in that window would silently re-report everything the user just read.
    // Layout state can afford that; a cursor cannot.
    saveLayout(READ_AT_KEY, next);
  }

  /**
   * Removes one notification from the feed.
   *
   * This does NOT mark it read, and it does not stop a poll from re-reporting it
   * while the cursor is still behind it. Dismissal is "get this off my screen",
   * which is a display concern; the cursor is the only thing that decides what the
   * worker is asked for.
   */
  dismiss(id: string): void {
    this.feedState.update(current => current.filter(entry => entry.id !== id));
  }

  /** Empties the feed. Does not touch the read marker, for the reason above. */
  clear(): void {
    this.feedState.set([]);
  }

  /** True when the user has switched this kind off. */
  isMuted(kind: NotificationKind): boolean {
    return this.mutedState().includes(kind);
  }

  /**
   * Turns a kind on or off.
   *
   * Refuses to mute a kind outside {@link MUTABLE_NOTIFICATION_KINDS} rather than
   * trusting the caller: the settings UI is generated from that list, but an
   * action-registry entry or a future call site is not, and silently muting
   * failures would be indistinguishable from the feature being broken.
   */
  setMuted(kind: NotificationKind, muted: boolean): void {
    if (muted && !isMutableKind(kind)) return;
    const next = this.mutedState().filter(entry => entry !== kind);
    if (muted) next.push(kind);
    this.mutedState.set(next);
    // Synchronous for the same reason as the cursor: a mute the user set and the
    // app then forgot reads as the setting not working.
    saveLayout(MUTED_KINDS_KEY, next);
  }

  /**
   * Drops every notification for one workflow.
   *
   * Called when a workflow is deleted or a deployment is removed: a row pointing
   * at something that no longer exists cannot be acted on, and the app's rule for
   * historic data is that an unresolvable reference is made explicit or removed,
   * never left looking like a rendering bug.
   */
  dropWorkflow(workflowId: string): void {
    this.feedState.update(current => current.filter(entry => entry.workflowId !== workflowId));
  }
}
