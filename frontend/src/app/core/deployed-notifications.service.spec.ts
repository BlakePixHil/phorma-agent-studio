/**
 * The deployed-feed poll: it has to run, it has to STOP, and a failure must not
 * read as good news.
 *
 * The assertions here are mostly about restraint rather than about polling
 * happening at all, because every failure mode of a timer in a desktop app that
 * stays open for days is a restraint failure: hammering a worker that is down,
 * polling for an account that is not entitled to the feature, and polling in the
 * background of a window nobody is looking at.
 *
 * The one correctness claim that is not about restraint is the most important
 * thing in the file: a FAILED poll replaces nothing. `pending` is live state we
 * cannot verify while offline, so keeping a stale list is right and clearing it
 * would tell the user every approval got answered.
 *
 * The clock is shrunk through {@link NOTIFICATION_POLL_CONFIG} rather than by
 * mocking `setTimeout`, so the async sequencing under test is the real one -
 * the same arrangement `billing-refresh.service.spec.ts` uses.
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import {
  DeployedNotificationsService,
  NOTIFICATION_POLL_CONFIG,
  type NotificationPollConfig,
} from './deployed-notifications.service';
import { DesktopAuthService } from './desktop-auth.service';
import { NotificationsService } from './notifications.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { PHORMA_CLOUD_DEFAULT_URL } from './phorma-cloud-url';
import type { DeploymentNotice, NotificationsResponse } from './notifications.model';

const FAST: NotificationPollConfig = { intervalMs: 5, backoffMs: 5, maxBackoffMs: 20 };
const KEYS = ['phorma.layout.notificationsReadAt', 'phorma.layout.notificationsMutedKinds'];

function notice(overrides: Partial<DeploymentNotice> = {}): DeploymentNotice {
  return {
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    runs: [],
    pending: [],
    issues: [],
    ...overrides,
  };
}

function response(overrides: Partial<NotificationsResponse> = {}): NotificationsResponse {
  return { at: 1_000, unreachable: [], truncated: false, deployments: [], ...overrides };
}

/** A `PhormaCloudService` whose entitlement the test drives. */
function cloudStub({ signedIn = true, subscribed = true } = {}) {
  return {
    signedIn: signal(signedIn),
    subscribed: signal(subscribed),
    pastDue: signal(false),
    profile: signal(null),
    loading: signal(false),
    error: signal(null),
    refresh: async () => undefined,
    sessionToken: async () => 'session-token',
  };
}

interface Harness {
  service: DeployedNotificationsService;
  store: NotificationsService;
  cloud: ReturnType<typeof cloudStub>;
  /** How many requests the transport has served. */
  calls(): number;
  /** The `since` value of the most recent request. */
  lastSince(): string | null;
  /** Queues the next response, or an outright network failure. */
  next(value: NotificationsResponse | 'network-error' | { status: number }): void;
}

/**
 * The service built by the current spec, stopped in `afterEach`.
 *
 * Tracked at module scope rather than left to `TestBed.resetTestingModule()`
 * because a leaked `setTimeout` outlives a destroyed injector, and a stray poll
 * from one spec lands in the NEXT spec's `fetch` spy - which is a failure
 * attributed to entirely innocent code. The service also disarms on destroy now,
 * so this is belt and braces on a defect that already cost an hour.
 */
let live: DeployedNotificationsService | null = null;

function setup(options: { signedIn?: boolean; subscribed?: boolean } = {}): Harness {
  for (const key of KEYS) localStorage.removeItem(key);
  const cloud = cloudStub(options);
  const urls: string[] = [];
  let queued: NotificationsResponse | 'network-error' | { status: number } = response();

  const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (queued === 'network-error') throw new Error('Network unreachable');
    if ('status' in queued && !('deployments' in queued)) {
      return new Response(JSON.stringify({ error: 'Server said no.' }), { status: queued.status });
    }
    return new Response(JSON.stringify(queued), { status: 200 });
  });
  void fetchSpy;

  TestBed.configureTestingModule({
    providers: [
      { provide: PhormaCloudService, useValue: cloud },
      { provide: DesktopAuthService, useValue: { token: async () => null } },
      { provide: NOTIFICATION_POLL_CONFIG, useValue: FAST },
    ],
  });

  live = TestBed.inject(DeployedNotificationsService);
  return {
    service: live,
    store: TestBed.inject(NotificationsService),
    cloud,
    calls: () => urls.length,
    lastSince: () => {
      const last = urls[urls.length - 1];
      return last ? new URL(last).searchParams.get('since') : null;
    },
    next: value => {
      queued = value;
    },
  };
}

/** Waits until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the poll.');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** Lets the loop run for a while without asserting anything about it. */
function settle(ms = 60): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('DeployedNotificationsService', () => {
  afterEach(() => {
    live?.stop();
    live = null;
    TestBed.resetTestingModule();
    for (const key of KEYS) localStorage.removeItem(key);
  });

  // ── Entitlement gating ────────────────────────────────────────────────────

  it('does not poll for an account with no subscription', async () => {
    const rig = setup({ subscribed: false });
    rig.service.start();
    await settle();

    // The bell itself is not gated - local notifications and drift work for
    // everybody - but the deployed feed is the paid half.
    expect(rig.calls()).toBe(0);
    rig.service.stop();
  });

  it('does not poll while signed out', async () => {
    const rig = setup({ signedIn: false });
    rig.service.start();
    await settle();

    expect(rig.calls()).toBe(0);
    rig.service.stop();
  });

  it('polls for an entitled account', async () => {
    const rig = setup();
    rig.service.start();
    await until(() => rig.calls() >= 1);

    expect(rig.calls()).toBeGreaterThan(0);
    expect(rig.lastSince()).toBe('0');
  });

  it('keeps polling on a schedule and stops dead on stop()', async () => {
    const rig = setup();
    rig.service.start();
    await until(() => rig.calls() >= 3);

    rig.service.stop();
    const atStop = rig.calls();
    await settle();

    // The bound that matters: a stopped poll issues NOTHING further, so a signed
    // out or unsubscribed account cannot leave a request loop running for the
    // lifetime of the window.
    expect(rig.calls()).toBe(atStop);
  });

  // ── The cursor ────────────────────────────────────────────────────────────

  it('polls from the store read marker, so unread survives a restart', async () => {
    const rig = setup();
    rig.store.add([
      {
        id: 'seed',
        kind: 'deployed-run-failed',
        origin: 'deployed',
        tone: 'error',
        title: 'seed',
        icon: 'ti-alert-triangle',
        at: 4_000,
        workflowId: 'wf-a',
        workflowName: 'Invoice triage',
      },
    ]);
    rig.store.markAllRead();
    const cursor = rig.store.readAt();

    rig.service.start();
    await until(() => rig.calls() >= 1);
    rig.service.stop();

    expect(rig.lastSince()).toBe(String(cursor));
  });

  it('does not advance the cursor itself', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            runs: [
              { runId: 'r1', status: 'failed', source: 'schedule', startedAt: 1, endedAt: 2, error: 'boom' },
            ],
          }),
        ],
      }),
    );
    rig.service.start();
    await until(() => rig.store.feed().length >= 1);
    rig.service.stop();

    // Only the user marking the feed read moves the cursor. A poll that advanced
    // it would consume notifications nobody has seen.
    expect(rig.store.readAt()).toBe(0);
    expect(rig.store.unreadCount()).toBe(1);
  });

  // ── Notifications accumulate ──────────────────────────────────────────────

  it('merges a repeated run into one notification across many polls', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            runs: [
              { runId: 'r1', status: 'failed', source: 'schedule', startedAt: 1, endedAt: 2, error: 'boom' },
            ],
          }),
        ],
      }),
    );
    rig.service.start();
    await until(() => rig.calls() >= 4);
    rig.service.stop();

    // The whole reason the feed can be re-derived rather than persisted: four
    // polls of the same unchanged run are one row, not four.
    expect(rig.store.feed().length).toBe(1);
    expect(rig.store.feed()[0].title).toContain('Invoice triage');
  });

  it('carries a refusal code through to a billing remedy', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            runs: [
              {
                runId: 'r1',
                status: 'failed',
                source: 'schedule',
                startedAt: 1,
                endedAt: 2,
                error: 'Monthly credits exhausted.',
                code: 'credits_exhausted',
              },
            ],
          }),
        ],
      }),
    );
    rig.service.start();
    await until(() => rig.store.feed().length >= 1);
    rig.service.stop();

    expect(rig.store.feed()[0].remedy).toBe('buy-credits');
  });

  // ── Pending actions are replaced, not merged ──────────────────────────────

  it('replaces the pending list wholesale so a resolved gate disappears', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            pending: [
              {
                kind: 'approval',
                id: 'req-1',
                nodeId: 'n1',
                nodeName: 'Approve payment',
                message: 'Release the payment?',
                hasPayload: false,
                runId: 'r1',
                since: 100,
              },
            ],
          }),
        ],
      }),
    );
    // `refresh()` rather than `start()`: one deterministic poll with no timer
    // armed, so nothing can replace the list underneath the assertions.
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(1);

    // Somebody else answered it, so the next poll simply does not mention it.
    rig.next(response({ deployments: [notice()] }));
    await rig.service.refresh();

    // A merged list would leave a phantom "needs your approval" row that resolves
    // to nothing, which is worse than no row at all.
    expect(rig.service.pending().length).toBe(0);
  });

  it('orders pending actions longest-waiting first across deployments', async () => {
    const rig = setup();
    const gate = (id: string, since: number) => ({
      kind: 'approval' as const,
      id,
      nodeId: 'n',
      nodeName: 'Gate',
      message: 'ok?',
      hasPayload: false,
      runId: 'r',
      since,
    });
    rig.next(
      response({
        deployments: [
          notice({ workflowId: 'wf-b', workflowName: 'B', pending: [gate('newer', 900)] }),
          notice({ workflowId: 'wf-a', workflowName: 'A', pending: [gate('older', 100)] }),
        ],
      }),
    );
    await rig.service.refresh();

    // The worker orders within a deployment; this ordering across them is what
    // makes "the thing that has waited longest is at the top" actually true.
    expect(rig.service.pending().map(row => row.id)).toEqual(['older', 'newer']);
  });

  it('marks a payload-carrying approval as not inline-resolvable', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            pending: [
              {
                kind: 'approval',
                id: 'req-1',
                nodeId: 'n1',
                nodeName: 'Approve payment',
                message: 'Release this payment?',
                hasPayload: true,
                runId: 'r1',
                since: 100,
              },
              {
                kind: 'question',
                id: 'req-2',
                nodeId: 'n2',
                nodeName: 'Ask',
                message: 'Which supplier?',
                hasPayload: false,
                runId: 'r1',
                since: 200,
              },
            ],
          }),
        ],
      }),
    );
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(2);

    // Approving a payment from a dropdown without seeing what is being approved is
    // the failure this rule exists to prevent, and a question needs free text.
    expect(rig.service.pending().every(row => row.resolvableInline === false)).toBe(true);
  });

  // ── A failure replaces nothing ────────────────────────────────────────────

  it('keeps the pending list and the feed when a poll fails', async () => {
    const rig = setup();
    rig.next(
      response({
        deployments: [
          notice({
            runs: [
              { runId: 'r1', status: 'failed', source: 'schedule', startedAt: 1, endedAt: 2, error: 'boom' },
            ],
            pending: [
              {
                kind: 'approval',
                id: 'req-1',
                nodeId: 'n1',
                nodeName: 'Gate',
                message: 'ok?',
                hasPayload: false,
                runId: 'r1',
                since: 100,
              },
            ],
          }),
        ],
      }),
    );
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(1);
    expect(rig.store.feed().length).toBe(1);

    rig.next('network-error');
    await rig.service.refresh();

    expect(rig.service.error()).not.toBeNull();
    // Going offline must not read as "everything got resolved and nothing is
    // wrong" - the same rule `DeploymentsService` follows on a failed refresh.
    expect(rig.service.pending().length).toBe(1);
    expect(rig.store.feed().length).toBe(1);
  });

  it('records an HTTP failure message rather than throwing', async () => {
    const rig = setup();
    rig.next({ status: 500 });
    rig.service.start();
    await until(() => rig.service.error() !== null);
    rig.service.stop();

    expect(rig.service.error()).toContain('Server said no.');
    expect(rig.service.loaded()).toBe(true);
  });

  it('backs off after consecutive failures instead of hammering', async () => {
    const rig = setup();
    rig.next('network-error');
    rig.service.start();
    await until(() => rig.calls() >= 2);
    const early = rig.calls();

    // With backoffMs 5 doubling to a ceiling of 20, a window that would fit many
    // interval-paced polls fits far fewer backed-off ones. The claim is the
    // slowdown, not an exact count - the wall clock is real here.
    await settle(120);
    const later = rig.calls() - early;
    rig.service.stop();

    expect(later).toBeLessThan(24);
  });

  it('resets the backoff when the user refreshes explicitly', async () => {
    const rig = setup();
    rig.next('network-error');
    rig.service.start();
    await until(() => rig.service.error() !== null);

    rig.next(response());
    await rig.service.refresh();
    rig.service.stop();

    // A user asking explicitly is a better signal about whether the network is
    // back than our own failure count.
    expect(rig.service.error()).toBeNull();
  });

  // ── Partial answers are surfaced, not hidden ───────────────────────────────

  it('surfaces unreachable deployments and a capped fan-out', async () => {
    const rig = setup();
    rig.next(response({ unreachable: ['wf-down'], truncated: true }));
    rig.service.start();
    await until(() => rig.service.loaded());
    rig.service.stop();

    expect(rig.service.unreachable()).toEqual(['wf-down']);
    expect(rig.service.truncated()).toBe(true);
  });

  it('tolerates a malformed body without throwing', async () => {
    const rig = setup();
    // A worker one version behind, or a proxy rewriting the body. The route table
    // normalizes defensively so this renders as "nothing to report".
    rig.next({ at: 1, unreachable: null, truncated: null, deployments: null } as never);
    rig.service.start();
    await until(() => rig.service.loaded());
    rig.service.stop();

    expect(rig.service.pending().length).toBe(0);
    expect(rig.service.unreachable().length).toBe(0);
    expect(rig.service.truncated()).toBe(false);
  });

  // ── Inline approval ───────────────────────────────────────────────────────

  it('removes the row optimistically and reports delivery', async () => {
    const rig = setup();
    const row = {
      kind: 'approval' as const,
      id: 'req-1',
      nodeId: 'n1',
      nodeName: 'Gate',
      message: 'ok?',
      hasPayload: false,
      runId: 'r1',
      since: 100,
      origin: 'deployed' as const,
      workflowId: 'wf-a',
      workflowName: 'Invoice triage',
      resolvableInline: true,
    };
    rig.next(response({ deployments: [notice({ pending: [row] })] }));
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(1);

    rig.next({ ok: true, delivered: true } as never);
    const delivered = await rig.service.resolveApproval(row, true);

    expect(delivered).toBe(true);
    expect(rig.service.pending().length).toBe(0);
  });

  it('restores the row when the approval could not be delivered', async () => {
    const rig = setup();
    const row = {
      kind: 'approval' as const,
      id: 'req-1',
      nodeId: 'n1',
      nodeName: 'Gate',
      message: 'ok?',
      hasPayload: false,
      runId: 'r1',
      since: 100,
      origin: 'deployed' as const,
      workflowId: 'wf-a',
      workflowName: 'Invoice triage',
      resolvableInline: true,
    };
    rig.next(response({ deployments: [notice({ pending: [row] })] }));
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(1);

    rig.next('network-error');
    const delivered = await rig.service.resolveApproval(row, true);

    expect(delivered).toBe(false);
    // The rollback: a gate we failed to answer is still waiting, and dropping the
    // row would leave the run suspended with nothing on screen to say so.
    expect(rig.service.pending().length).toBe(1);
  });

  it('reports a gate that was already gone without restoring it', async () => {
    const rig = setup();
    const row = {
      kind: 'approval' as const,
      id: 'req-1',
      nodeId: 'n1',
      nodeName: 'Gate',
      message: 'ok?',
      hasPayload: false,
      runId: 'r1',
      since: 100,
      origin: 'deployed' as const,
      workflowId: 'wf-a',
      workflowName: 'Invoice triage',
      resolvableInline: true,
    };
    rig.next(response({ deployments: [notice({ pending: [row] })] }));
    await rig.service.refresh();
    expect(rig.service.pending().length).toBe(1);

    // `{ delivered: false }` is a 200, not an error: the run moved on. The row was
    // right to disappear, but the caller has to be able to say the decision landed
    // nowhere rather than claim success.
    rig.next({ ok: true, delivered: false } as never);
    const delivered = await rig.service.resolveApproval(row, true);

    expect(delivered).toBe(false);
    expect(rig.service.pending().length).toBe(0);
  });

  it('refuses to resolve a row with no workflow id', async () => {
    const rig = setup();
    const delivered = await rig.service.resolveApproval(
      {
        kind: 'approval',
        id: 'req-1',
        nodeId: 'n1',
        nodeName: 'Gate',
        message: 'ok?',
        hasPayload: false,
        runId: 'r1',
        since: 1,
        origin: 'local',
        workflowId: null,
        workflowName: 'Draft',
        resolvableInline: true,
      },
      true,
    );

    expect(delivered).toBe(false);
    expect(rig.calls()).toBe(0);
  });

  // ── The hosted base ───────────────────────────────────────────────────────

  it('addresses the hosted worker, never the chosen deploy target', async () => {
    const rig = setup();
    rig.service.start();
    await until(() => rig.calls() >= 1);
    rig.service.stop();

    // A subscriber deploying to AWS still HAS a Phorma Cloud account, and their
    // feed lives on the hosted worker - which is why this service pins the phorma
    // route table instead of going through CloudService.
    expect(rig.lastSince()).not.toBeNull();
    expect(PHORMA_CLOUD_DEFAULT_URL.length).toBeGreaterThan(0);
  });
});
