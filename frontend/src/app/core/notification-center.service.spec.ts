/**
 * The merged view, and the two merges that are easy to get wrong.
 *
 * 1. A monitored cloud workflow reports the SAME pending gate twice: the run
 *    controller synthesizes a card from the `approval-required` event on the
 *    monitor socket, and the account-wide poll reports it out of the Durable
 *    Object's memory. Two rows for one decision means answering either leaves the
 *    other looking unanswered until the next poll, so the merge dedupes on the
 *    gate's own id and keeps the LOCAL one - its resolver is the open socket.
 *
 * 2. A pending action counts towards the badge whether it is "read" or not.
 *    Read is meaningless for something still waiting on you, and a badge that
 *    clears while an approval is unanswered has hidden the only thing that
 *    mattered.
 *
 * Plus the ownership rule that decides where a deep link goes: a card
 * synthesized from the monitor socket lives in the LOCAL controller but belongs
 * to a DEPLOYED run, and sending it to the local canvas would open the wrong thing.
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { DeployedNotificationsService } from './deployed-notifications.service';
import { DeploymentsService, type DeploymentRow } from './deployments.service';
import { NotificationCenterService, type NotificationTarget } from './notification-center.service';
import { NotificationsService } from './notifications.service';
import { RunControllerService, type PendingApproval } from './run-controller.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import type { PendingActionRow, StudioNotification } from './notifications.model';

const KEYS = ['phorma.layout.notificationsReadAt', 'phorma.layout.notificationsMutedKinds'];

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: 'req-1',
    nodeId: 'n1',
    nodeName: 'Approve payment',
    message: 'Release this payment?',
    payload: '',
    resolve: () => undefined,
    runId: 'run-1',
    since: 100,
    ...overrides,
  };
}

function deployedRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    kind: 'approval',
    id: 'req-1',
    nodeId: 'n1',
    nodeName: 'Approve payment',
    message: 'Release this payment?',
    hasPayload: false,
    runId: 'cloudrun-1',
    since: 100,
    origin: 'deployed',
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    resolvableInline: true,
    ...overrides,
  };
}

function notification(overrides: Partial<StudioNotification> = {}): StudioNotification {
  return {
    id: 'wf-a:run-1:deployed-run-failed',
    kind: 'deployed-run-failed',
    origin: 'deployed',
    tone: 'error',
    title: 'Invoice triage failed',
    icon: 'ti-alert-triangle',
    at: 1_000,
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    runId: 'run-1',
    ...overrides,
  };
}

function deployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    workflowId: 'wf-orphan',
    workflowName: 'Forgotten cron',
    deployedAt: 1_000,
    updatedAt: 2_000,
    specHash: 'h1',
    cronArmed: true,
    portalSlug: null,
    creditsSpent: 12,
    runsThisMonth: 3,
    orphan: true,
    localName: null,
    ...overrides,
  };
}

interface Harness {
  centre: NotificationCenterService;
  store: NotificationsService;
  /** The run controller's live approvals, driven by the test. */
  localApprovals: ReturnType<typeof signal<PendingApproval[]>>;
  /** The poll's pending list, driven by the test. */
  deployedPending: ReturnType<typeof signal<readonly PendingActionRow[]>>;
  /** The deployment list the orphan rows derive from. */
  deployments: ReturnType<typeof signal<DeploymentRow[]>>;
  resolveApprovalSpy: jasmine.Spy;
  deployedResolveSpy: jasmine.Spy;
  /** Whether a monitor socket is attached, which decides gate ownership. */
  setMonitored(value: boolean): void;
  targets: NotificationTarget[];
  toast: ToastService;
}

function setup(): Harness {
  for (const key of KEYS) localStorage.removeItem(key);

  const localApprovals = signal<PendingApproval[]>([]);
  const deployedPending = signal<readonly PendingActionRow[]>([]);
  const deployments = signal<DeploymentRow[]>([]);
  const resolveApprovalSpy = jasmine.createSpy('resolveApproval');
  const deployedResolveSpy = jasmine.createSpy('deployedResolve').and.resolveTo(true);

  const runControllerStub = {
    pendingApprovals: localApprovals,
    pendingQuestions: signal([]),
    pendingWaits: signal([]),
    resolveApproval: resolveApprovalSpy,
    remoteApprovalSender: null as unknown,
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: RunControllerService, useValue: runControllerStub },
      {
        provide: DeployedNotificationsService,
        useValue: {
          pending: deployedPending,
          unreachable: signal([]),
          truncated: signal(false),
          error: signal(null),
          loading: signal(false),
          loaded: signal(true),
          refresh: async () => undefined,
          resolveApproval: deployedResolveSpy,
        },
      },
      { provide: DeploymentsService, useValue: { deployments } },
      {
        provide: WorkflowService,
        useValue: {
          activeDoc: signal({ workflowId: 'wf-a', name: 'Invoice triage' }),
          library: signal([]),
        },
      },
    ],
  });

  const centre = TestBed.inject(NotificationCenterService);
  const targets: NotificationTarget[] = [];
  centre.deepLinkHandler = target => targets.push(target);

  return {
    centre,
    store: TestBed.inject(NotificationsService),
    localApprovals,
    deployedPending,
    deployments,
    resolveApprovalSpy,
    deployedResolveSpy,
    setMonitored: value => {
      runControllerStub.remoteApprovalSender = value ? () => undefined : null;
    },
    targets,
    toast: TestBed.inject(ToastService),
  };
}

describe('NotificationCenterService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    for (const key of KEYS) localStorage.removeItem(key);
  });

  // ── The pending merge ─────────────────────────────────────────────────────

  it('shows one row when a monitored gate is reported by both sources', () => {
    const rig = setup();
    rig.setMonitored(true);
    rig.localApprovals.set([approval({ requestId: 'req-1' })]);
    rig.deployedPending.set([deployedRow({ id: 'req-1' })]);

    expect(rig.centre.pendingActions().length).toBe(1);
  });

  it('keeps the local copy of a duplicated gate, because its resolver is the socket', async () => {
    const rig = setup();
    rig.setMonitored(true);
    rig.localApprovals.set([approval({ requestId: 'req-1' })]);
    rig.deployedPending.set([deployedRow({ id: 'req-1' })]);

    await rig.centre.resolve(rig.centre.pendingActions()[0], true);

    // Settled in memory over the open socket, with no HTTP round trip at all.
    expect(rig.resolveApprovalSpy).toHaveBeenCalledWith('req-1', true);
    expect(rig.deployedResolveSpy).not.toHaveBeenCalled();
  });

  it('keeps distinct gates from both sources', () => {
    const rig = setup();
    rig.localApprovals.set([approval({ requestId: 'local-1', since: 50 })]);
    rig.deployedPending.set([deployedRow({ id: 'remote-1', since: 900 })]);

    expect(rig.centre.pendingActions().map(row => row.id)).toEqual(['local-1', 'remote-1']);
  });

  it('orders every pending action longest-waiting first', () => {
    const rig = setup();
    rig.localApprovals.set([approval({ requestId: 'local-new', since: 800 })]);
    rig.deployedPending.set([
      deployedRow({ id: 'remote-oldest', since: 10 }),
      deployedRow({ id: 'remote-mid', since: 400 }),
    ]);

    expect(rig.centre.pendingActions().map(row => row.id)).toEqual([
      'remote-oldest',
      'remote-mid',
      'local-new',
    ]);
  });

  // ── Gate ownership decides the deep link ──────────────────────────────────

  it('treats a socket-synthesized card as a deployed run', () => {
    const rig = setup();
    rig.setMonitored(true);
    rig.localApprovals.set([approval()]);

    const row = rig.centre.pendingActions()[0];
    expect(row.origin).toBe('deployed');

    rig.centre.navigateTo(row);
    // A run executing in the cloud must attach the monitor rather than just open
    // the local document, even though its card lives in the local controller.
    expect(rig.targets[0].deployed).toBe(true);
  });

  it('treats a local engine gate as local', () => {
    const rig = setup();
    rig.setMonitored(false);
    rig.localApprovals.set([approval()]);

    const row = rig.centre.pendingActions()[0];
    expect(row.origin).toBe('local');

    rig.centre.navigateTo(row);
    expect(rig.targets[0].deployed).toBe(false);
  });

  it('closes the dropdown when it navigates', () => {
    const rig = setup();
    rig.centre.toggle();
    expect(rig.centre.open()).toBe(true);

    rig.centre.navigateToNotification(notification());

    expect(rig.centre.open()).toBe(false);
    expect(rig.targets[0]).toEqual({ workflowId: 'wf-a', runId: 'run-1', deployed: true });
  });

  // ── Inline resolution ─────────────────────────────────────────────────────

  it('marks a payload-carrying local approval as not inline-resolvable', () => {
    const rig = setup();
    rig.localApprovals.set([approval({ payload: '{"invoice":"INV-1","total":4200}' })]);

    expect(rig.centre.pendingActions()[0].resolvableInline).toBe(false);
  });

  it('treats an empty-object payload as no context', () => {
    const rig = setup();
    rig.localApprovals.set([approval({ payload: '{}' })]);

    // `{}`, `null` and `""` are all what an unset payload serializes to somewhere
    // on the path, and none of them is worth opening the run for.
    expect(rig.centre.pendingActions()[0].resolvableInline).toBe(true);
  });

  it('deep-links instead of resolving a question', async () => {
    const rig = setup();
    rig.deployedPending.set([deployedRow({ kind: 'question', id: 'q-1', resolvableInline: false })]);

    const delivered = await rig.centre.resolve(rig.centre.pendingActions()[0], true);

    expect(delivered).toBe(false);
    expect(rig.deployedResolveSpy).not.toHaveBeenCalled();
    expect(rig.targets.length).toBe(1);
  });

  it('warns when a deployed gate was already answered elsewhere', async () => {
    const rig = setup();
    rig.deployedResolveSpy.and.resolveTo(false);
    rig.deployedPending.set([deployedRow()]);

    const delivered = await rig.centre.resolve(rig.centre.pendingActions()[0], true);

    expect(delivered).toBe(false);
    // Swallowing this would leave the user believing they approved something.
    expect(rig.toast.entries().some(entry => entry.summary === 'Nothing to approve')).toBe(true);
  });

  it('says nothing when a deployed gate is settled successfully', async () => {
    const rig = setup();
    rig.deployedPending.set([deployedRow()]);

    const delivered = await rig.centre.resolve(rig.centre.pendingActions()[0], true);

    expect(delivered).toBe(true);
    expect(rig.toast.entries().length).toBe(0);
  });

  // ── The badge ─────────────────────────────────────────────────────────────

  it('counts a pending action whether it is read or not', () => {
    const rig = setup();
    rig.deployedPending.set([deployedRow()]);
    rig.store.markAllRead();

    // "Read" is meaningless for something still waiting on you.
    expect(rig.centre.badgeCount()).toBe(1);
    expect(rig.centre.hasProblem()).toBe(true);
  });

  it('adds unread notifications to the pending count', () => {
    const rig = setup();
    rig.deployedPending.set([deployedRow()]);
    rig.store.add([notification({ id: 'a', at: 1_000 }), notification({ id: 'b', at: 2_000 })]);

    expect(rig.centre.badgeCount()).toBe(3);
  });

  it('clears the notification half of the badge on open, keeping the pending half', () => {
    const rig = setup();
    rig.deployedPending.set([deployedRow()]);
    rig.store.add([notification()]);
    expect(rig.centre.badgeCount()).toBe(2);

    rig.centre.toggle();

    // Marking read on OPEN rather than on close is what makes the badge
    // trustworthy: a badge that lingers after you looked stops being read at all.
    expect(rig.centre.badgeCount()).toBe(1);
  });

  it('goes quiet with nothing waiting and nothing unread', () => {
    const rig = setup();
    rig.store.add([notification()]);
    rig.centre.markAllRead();

    expect(rig.centre.badgeCount()).toBe(0);
    expect(rig.centre.hasProblem()).toBe(false);
  });

  // ── Derived rows ──────────────────────────────────────────────────────────

  it('derives an orphan-deployment row from the deployment list', () => {
    const rig = setup();
    rig.deployments.set([deployment()]);

    const rows = rig.centre.recent();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('orphan-deployment');
    expect(rows[0].title).toContain('Forgotten cron');
  });

  it('stops deriving the row once the orphan is restored', () => {
    const rig = setup();
    rig.deployments.set([deployment()]);
    expect(rig.centre.recent().length).toBe(1);

    // The whole reason this row is COMPUTED rather than stored: it describes a
    // state, and a stored row would outlive the state ending.
    rig.deployments.set([deployment({ orphan: false, localName: 'Forgotten cron' })]);

    expect(rig.centre.recent().length).toBe(0);
  });

  it('derives nothing while the deployment list has never been loaded', () => {
    const rig = setup();

    // `DeploymentsService.refresh()` is on demand, and this feature must not add a
    // second background request for one advisory row.
    expect(rig.centre.recent().length).toBe(0);
  });

  it('merges derived rows with the stored feed, newest first', () => {
    const rig = setup();
    rig.deployments.set([deployment()]);
    rig.store.add([notification({ at: 1 })]);

    const rows = rig.centre.recent();
    expect(rows.length).toBe(2);
    // The orphan row is stamped `now`, so it leads.
    expect(rows[0].kind).toBe('orphan-deployment');
  });

  it('respects a mute on the orphan row', () => {
    const rig = setup();
    rig.store.setMuted('orphan-deployment', true);
    rig.deployments.set([deployment()]);

    // The derived rows bypass `add()`, so the mute has to be honoured on read too -
    // otherwise switching a kind off works for polled rows and not for derived ones.
    expect(rig.centre.recent().some(row => row.kind === 'orphan-deployment')).toBe(false);
  });
});
