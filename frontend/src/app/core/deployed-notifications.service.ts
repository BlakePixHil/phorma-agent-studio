/**
 * The deployed-workflow poll: one request per tick, for the whole account.
 *
 * ## Why a poll rather than a socket
 *
 * `CloudService` holds ONE monitor WebSocket, attached to ONE workflow - the one
 * the user has open - and its replay buffer covers the current run only. So the
 * live channel structurally cannot answer "did anything go wrong anywhere" or
 * "what happened while I was closed". A socket per deployment would be N
 * connections to N Durable Objects and would still know nothing about the time the
 * app was shut. The worker's `GET /api/notifications` reads what is already
 * durable (each instance's own `runs` table) plus what is only live (its pending
 * gates), and this asks for it on a timer.
 *
 * ## Why it does not go through `CloudService`
 *
 * Identical reasoning to `DeploymentsService`, and it is worth restating because
 * it looks like duplication and is not. `CloudService.call()` dispatches against
 * `settings.cloudProvider()`, which is right for a deploy and wrong here: a
 * subscriber whose deploy target is AWS or their own Cloudflare account still HAS
 * a Phorma Cloud account, and their notification feed lives on the hosted worker.
 * So this pins `DEPLOY_TARGETS.phorma` and reads the hosted base from the leaf
 * module. Reaching for `CloudService` would also close the known NG0200 cycle in a
 * new place. The shared `dispatchCloudOperation` is what keeps this from becoming
 * a second copy of the request plumbing.
 *
 * ## Notifications accumulate; pending actions do not
 *
 * The single most important distinction in this file. A settled run is HISTORY:
 * merged into `NotificationsService`, kept until the ring buffer evicts it, and
 * safe to re-report because the merge is idempotent. A pending gate is LIVE
 * STATE living in a Durable Object's memory: it vanishes when somebody else
 * answers it, when the run is stopped, or when the instance is evicted. So the
 * pending list is REPLACED wholesale on every successful poll, never merged -
 * merging would leave a phantom "needs your approval" row that resolves to
 * nothing, which is worse than no row at all.
 *
 * A FAILED poll replaces nothing. Going offline must not read as "everything got
 * resolved", the same way `DeploymentsService` keeps its rows on a failed refresh.
 */

import { inject, Injectable, InjectionToken, signal, type OnDestroy } from '@angular/core';

import { ActiveOwnerService } from './active-owner.service';
import { DesktopAuthService } from './desktop-auth.service';
import { NotificationsService } from './notifications.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { DEPLOY_TARGETS } from './deploy/deploy-targets';
import {
  dispatchCloudOperation,
  type CloudCallResult,
  type CloudScopeResolver,
} from './deploy/cloud-dispatch';
import type { CloudTransport } from './deploy/cloud-transport';
import {
  notificationFromProposal,
  notificationsFromNotice,
  pendingRowsFromNotice,
} from './notification-projection';
import type {
  ApprovalPayload,
} from './deploy/deploy-targets';
import type {
  DeploymentNotice,
  NotificationsResponse,
  PendingActionRow,
} from './notifications.model';

/** The Phorma Cloud route table. Pinned, never resolved from the deploy target. */
const HOSTED_ENDPOINTS = DEPLOY_TARGETS.phorma.endpoints;

/** How the poll is paced. */
export interface NotificationPollConfig {
  /** Gap between successful polls, in ms. */
  intervalMs: number;
  /** First delay after a failure. Doubles per consecutive failure. */
  backoffMs: number;
  /** Ceiling for the backoff, so a long outage settles at a slow retry. */
  maxBackoffMs: number;
}

/**
 * The poll clock, injectable so a spec can shrink it.
 *
 * 20 seconds, and the reasoning is a tradeoff rather than a round number. The
 * worker spends one subrequest per deployment per tick, and a pending approval is
 * the only thing here where latency is felt by a human - 20s is well inside the
 * time it takes somebody to notice a bell and click it, while a busy account with
 * 40 deployments costs 3 requests a minute rather than 20.
 *
 * Backoff exists because the alternative is a desktop app hammering a worker that
 * is down for as long as it stays open. It doubles from 30s to a 5 minute ceiling;
 * a manual `refresh()` or a visibility change resets it, so a user who comes back
 * to the app never waits out a backoff they cannot see.
 */
export const NOTIFICATION_POLL_CONFIG = new InjectionToken<NotificationPollConfig>(
  'phorma.notifications.poll',
  {
    factory: (): NotificationPollConfig => ({
      intervalMs: 20_000,
      backoffMs: 30_000,
      maxBackoffMs: 300_000,
    }),
  },
);

@Injectable({ providedIn: 'root' })
export class DeployedNotificationsService implements OnDestroy {
  // Safe DI direction, and the same one `DeploymentsService` documents: this
  // service sits DOWNSTREAM of `PhormaCloudService`, and nothing on the
  // `RunControllerService -> ModelTransportService -> PhormaCloudService ->
  // CloudService` path injects this one. `CloudService` is deliberately absent.
  private readonly phormaCloud = inject(PhormaCloudService);
  // A DI leaf, and the desktop half of the bearer: a packaged build holds no
  // Clerk session at all.
  private readonly desktopAuth = inject(DesktopAuthService);
  private readonly store = inject(NotificationsService);
  private readonly config = inject(NOTIFICATION_POLL_CONFIG);
  // A DI LEAF - it injects nothing at all - so this edge is safe even on the
  // transport path. It supplies the `X-Phorma-Owner` header this service's
  // `fetch-bearer` transport sends beside its bearer.
  private readonly activeOwner = inject(ActiveOwnerService);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  /** True between `start()` and `stop()`, regardless of whether a timer is armed. */
  private active = false;
  /** Guards against a manual refresh racing a scheduled one. */
  private inFlight = false;

  /**
   * Gates waiting on a human across every deployment, longest-waiting first.
   *
   * Replaced wholesale per poll - see the file header.
   */
  readonly pending = signal<readonly PendingActionRow[]>([]);

  /** Deployments the last poll could not reach. Named, never silently empty. */
  readonly unreachable = signal<readonly string[]>([]);

  /** True when the account has more deployments than one poll asks. */
  readonly truncated = signal(false);

  /** Message from the last failed poll, or null. */
  readonly error = signal<string | null>(null);

  /** True while a request is in flight, for a manual refresh spinner. */
  readonly loading = signal(false);

  /** True once a poll has completed at least once, success or failure. */
  readonly loaded = signal(false);

  /**
   * Starts polling, if the account is entitled to it.
   *
   * Idempotent: called from the shell on startup, on a subscription change and on
   * a visibility change, and calling it while already running only resets the
   * backoff. That reset is the point of calling it on focus - a user returning to
   * a laptop that slept through an outage should get a fresh attempt, not the tail
   * of a five minute backoff.
   */
  start(): void {
    this.active = true;
    this.consecutiveFailures = 0;
    if (!this.eligible()) {
      this.disarm();
      return;
    }
    void this.pollNow();
  }

  /**
   * Stops polling and forgets the live pending list.
   *
   * The pending list is dropped because it is live state we can no longer verify:
   * leaving "this run needs your approval" on screen after we stopped asking
   * would be a row that might already have been answered. The notification FEED is
   * left alone - it is history, and history does not stop being true.
   */
  stop(): void {
    this.active = false;
    this.disarm();
    this.pending.set([]);
  }

  /**
   * Releases the timer when the injector goes away.
   *
   * In the shipped app the root injector outlives the window, so this never fires
   * in anger. It exists because a service that owns a `setTimeout` and no teardown
   * is a service that keeps issuing requests after whatever created it is gone -
   * which is exactly what happened across specs, where a leaked timer from one
   * test kept polling into the next one's `fetch` spy.
   */
  ngOnDestroy(): void {
    this.stop();
  }

  /**
   * Polls once, now, outside the schedule.
   *
   * Used by the bell's manual refresh and by the visibility handler. Resets the
   * backoff, because a user asking explicitly is a better signal about whether the
   * network is back than our own failure count.
   */
  async refresh(): Promise<void> {
    this.consecutiveFailures = 0;
    await this.pollNow();
  }

  /**
   * Re-scopes the poll to the ACTIVE owner (multi-organisation-phorma,
   * Requirement 20.6).
   *
   * Called by `OwnerSwitchService` after the owner signal has moved and after
   * `NotificationsService.resetForOwner()` has re-read that owner's cursor - the
   * ORDER is load-bearing, because the poll below reads the store's marker as its
   * `?since=` value, so polling first would ask the new owner's deployments a
   * question about the previous owner's reading history.
   *
   * Everything derived from the previous owner goes: the live pending list (a gate
   * in an organisation's Durable Object, which this session can no longer verify),
   * the unreachable list and the truncation flag (both are statements about the
   * previous owner's registry), and the last error. The backoff resets too, because
   * a switch is an explicit user action and is a better signal than our failure
   * count - the same reasoning `refresh()` carries.
   */
  resetForOwner(): void {
    this.consecutiveFailures = 0;
    this.pending.set([]);
    this.unreachable.set([]);
    this.truncated.set(false);
    this.error.set(null);
    if (this.active) void this.pollNow();
  }

  /**
   * Settles one pending approval on a deployed workflow.
   *
   * Over HTTP to the instance's `POST /approvals`, which is the SAME route the
   * monitor socket's `approval` frame lands on - so this works for a workflow the
   * user does not have open and has no socket attached to.
   *
   * The row is removed optimistically and restored on failure. Optimism is right
   * here because the alternative is a two-second wait on a button that is almost
   * always going to succeed; the rollback matters because a gate can genuinely be
   * gone already (another client answered it, the run was stopped, the instance was
   * evicted) and `{ delivered: false }` is a 200, not an error.
   */
  async resolveApproval(row: PendingActionRow, approved: boolean): Promise<boolean> {
    if (!row.workflowId) return false;
    const before = this.pending();
    this.pending.set(before.filter(entry => entry.id !== row.id));
    try {
      const result = await dispatchCloudOperation<{ ok?: boolean; delivered?: boolean }>(
        HOSTED_ENDPOINTS,
        this.transport,
        this.scope,
        'approve',
        { workflowId: row.workflowId },
        { requestId: row.id, approved } satisfies ApprovalPayload,
      );
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      // A 200 with `delivered: false` means the gate was already gone. Nothing to
      // restore - the row was correct to remove - but the caller must be able to
      // say so rather than report a decision that landed nowhere.
      return result.value?.delivered === true;
    } catch (error) {
      this.pending.set(before);
      this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Removes one pending row locally, for a gate resolved through another surface. */
  forgetPending(id: string): void {
    this.pending.update(current => current.filter(entry => entry.id !== id));
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  /**
   * Whether polling is allowed right now.
   *
   * Three conditions, and each one is a separate reason. Signed in, because there
   * is no account to read otherwise. Subscribed, because the deployed feed is the
   * paid half of this feature (the bell itself is not gated - local notifications
   * and drift work for everybody). And a configured hosted base, because a
   * blank one produces an `unsupported` dispatch on every tick forever.
   */
  private eligible(): boolean {
    return this.phormaCloud.signedIn() && this.phormaCloud.subscribed() && !!loadPhormaCloudUrl();
  }

  /**
   * One poll.
   *
   * Note what gates it: `eligible()` alone, NOT `active`. Those are two different
   * questions - "may this account read the feed" and "is the scheduled loop
   * running" - and conflating them made `refresh()` a silent no-op whenever the
   * loop happened to be stopped, which is exactly the state a user pressing
   * Refresh after signing in is in. Re-arming is the part that respects `active`,
   * and `arm()` enforces that itself.
   */
  private async pollNow(): Promise<void> {
    this.disarm();
    if (!this.eligible()) return;
    if (this.inFlight) {
      this.arm(this.config.intervalMs);
      return;
    }

    this.inFlight = true;
    this.loading.set(true);
    try {
      const result = await this.call<NotificationsResponse>();
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      this.applyResponse(result.value);
      this.consecutiveFailures = 0;
      this.error.set(null);
      this.arm(this.config.intervalMs);
    } catch (error) {
      this.consecutiveFailures += 1;
      this.error.set(error instanceof Error ? error.message : String(error));
      // Nothing is replaced on a failure: the pending list, the feed and the
      // unreachable list all keep what they had. An offline moment must not read
      // as "everything is resolved and nothing is wrong".
      this.arm(this.backoffDelay());
    } finally {
      this.inFlight = false;
      this.loading.set(false);
      this.loaded.set(true);
    }
  }

  /**
   * Folds one response into the store and the live signals.
   *
   * The cursor is NOT advanced here, and that is deliberate: the store's read
   * marker is the cursor, and only the user marking the feed read moves it. A poll
   * that advanced its own cursor would consume notifications nobody had seen.
   */
  private applyResponse(response: NotificationsResponse): void {
    const deployments: DeploymentNotice[] = Array.isArray(response.deployments)
      ? response.deployments
      : [];
    const now = Date.now();

    const notifications = deployments.flatMap(notice => notificationsFromNotice(notice, now));

    // The caller's own decided proposals (multi-organisation-phorma,
    // Requirement 12.11). ACCUMULATED with the run notifications rather than
    // replaced like the pending rows, because a decision is history: it is merged
    // idempotently on the proposal id, which is what lets the worker keep
    // re-reporting it until the read marker passes it.
    //
    // The name comes from the deployment notice when one is present in this
    // response, and falls back to the workflow id: a proposal can be decided for a
    // workflow that reported nothing this tick, and a row reading "Your change to
    // "undefined"" would be worse than one naming the id.
    const names = new Map(deployments.map(notice => [notice.workflowId, notice.workflowName]));
    for (const proposal of Array.isArray(response.proposals) ? response.proposals : []) {
      if (!proposal?.proposalId || !proposal.workflowId) continue;
      notifications.push(
        notificationFromProposal({
          proposalId: proposal.proposalId,
          workflowId: proposal.workflowId,
          status: proposal.status === 'published' ? 'published' : 'rejected',
          reason: proposal.reason ?? null,
          at: typeof proposal.at === 'number' ? proposal.at : 0,
          workflowName: names.get(proposal.workflowId) ?? proposal.workflowId,
          now,
        }),
      );
    }

    if (notifications.length > 0) this.store.add(notifications);

    // Wholesale replacement, ordered longest-waiting first across every
    // deployment - the worker orders within a deployment, and this is what makes
    // the ordering hold across them.
    const pending = deployments
      .flatMap(notice => pendingRowsFromNotice(notice))
      .sort((a, b) => a.since - b.since);
    this.pending.set(pending);

    this.unreachable.set(Array.isArray(response.unreachable) ? response.unreachable : []);
    this.truncated.set(response.truncated === true);
  }

  /** Exponential backoff, capped. */
  private backoffDelay(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const delay = this.config.backoffMs * 2 ** Math.min(exponent, 10);
    return Math.min(delay, this.config.maxBackoffMs);
  }

  private arm(delayMs: number): void {
    this.disarm();
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow();
    }, delayMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ── Transport (the DeploymentsService shape, for the reasons in the header) ──

  private readonly scope: CloudScopeResolver = {
    root: () => loadPhormaCloudUrl(),
    instance: workflowId => {
      const base = loadPhormaCloudUrl();
      return base ? DEPLOY_TARGETS.phorma.instanceUrl(base, workflowId || 'default') : null;
    },
  };

  /**
   * `fetch` plus the account bearer.
   *
   * The desktop device token comes FIRST for the measured reason
   * `CloudService.resolveAuthToken` does it: a packaged build never loads a Clerk
   * session, so a Clerk-first order sent every request with no `Authorization`
   * header and the hosted worker failed them closed.
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
      // Requirement 20.6). The fan-out reads the resolved owner's `deploy:`
      // registry, so this is what decides whose settled runs the bell reports.
      Object.assign(headers, this.activeOwner.ownerHeader());
      const response = await fetch(url, { method: init.method, headers, body: init.body });
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    monitorSocketUrl: async () => {
      throw new Error('DeployedNotificationsService does not open a monitor socket.');
    },
  };

  private call<T>(): Promise<CloudCallResult<T>> {
    return dispatchCloudOperation<T>(
      HOSTED_ENDPOINTS,
      this.transport,
      this.scope,
      'list-notifications',
      // The cursor is the store's read marker: polling from there is what makes an
      // unread notification survive a restart with nothing persisted but a number.
      { workflowId: '', since: String(this.store.readAt()) },
    );
  }
}
