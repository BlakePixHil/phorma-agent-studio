/**
 * `OwnerSwitchService`: what actually happens when somebody changes account.
 *
 * The claims worth testing here are the ones a signal alone would not give you:
 *
 * - A DIRTY document routes through the REAL `ConfirmDialogService`
 *   (Requirement 20.8), and a CANCEL leaves the active owner, the tabs and every
 *   owner-scoped service untouched. The real rail rather than a stub, because the
 *   thing being asserted is that the switch waits on the resolved value - a stub
 *   that resolved immediately would pass for an implementation that never opened
 *   anything.
 * - Every open tab CLOSES, read-only ones included (Requirement 20.7).
 * - Every owner-scoped session state resets, and the notification STORE resets
 *   before the poll does (Requirement 20.6). That order is load-bearing: the
 *   store's read marker is the poll cursor, so a poll that ran first would ask the
 *   new owner's deployments a question about the previous owner's reading history.
 * - The profile is RE-RESOLVED from the worker (Requirement 20.5), which is what
 *   recomputes every capability-derived surface with no reload.
 *
 * **Validates: Requirements 20.5, 20.6, 20.7, 20.8**
 */

import { TestBed } from '@angular/core/testing';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { ActiveOwnerService } from './active-owner.service';
import { DeployedNotificationsService } from './deployed-notifications.service';
import { DeploymentsService } from './deployments.service';
import { NotificationsService } from './notifications.service';
import { OwnerSwitchService } from './owner-switch.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';

/** Every call the switch makes, in order, so ORDER can be asserted. */
type CallLog = string[];

interface Harness {
  switcher: OwnerSwitchService;
  owner: ActiveOwnerService;
  confirm: ConfirmDialogService;
  calls: CallLog;
  documents: () => { docId: string; dirty: boolean; name: string }[];
  setActive: jasmine.Spy;
}

function harness(
  options: { dirty?: boolean; desktop?: boolean; readOnlyTab?: boolean } = {},
): Harness {
  const calls: CallLog = [];
  let documents = [
    { docId: 'doc-1', name: 'One', dirty: options.dirty ?? false },
    ...(options.readOnlyTab
      ? [{ docId: 'doc-2', name: 'Deployed preview', dirty: false, readOnly: true }]
      : []),
  ];

  const setActive = jasmine.createSpy('setActive').and.resolveTo();
  const clerk$ = new ReplaySubject<unknown>(1);
  clerk$.next({ session: { id: 'sess_1' }, setActive });

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: WorkflowService,
        useValue: {
          documents: () => documents,
          closeAllDocuments: () => {
            calls.push('close-tabs');
            documents = [];
          },
          reloadLibrary: async () => {
            calls.push('reload-library');
          },
        },
      },
      {
        provide: NotificationsService,
        useValue: {
          resetForOwner: () => calls.push('store-reset'),
        },
      },
      {
        provide: DeployedNotificationsService,
        useValue: {
          resetForOwner: () => calls.push('poll-reset'),
        },
      },
      {
        provide: DeploymentsService,
        useValue: {
          resetForOwner: async () => {
            calls.push('deployments-reset');
          },
        },
      },
      {
        provide: PhormaCloudService,
        useValue: {
          refresh: async () => {
            calls.push('api-me');
          },
        },
      },
      { provide: ClerkService, useValue: { clerk$ } as unknown as ClerkService },
      { provide: TauriService, useValue: { isDesktop: options.desktop ?? false } },
    ],
  });

  const owner = TestBed.inject(ActiveOwnerService);
  owner.adoptOwners([
    { orgId: 'org_acme', label: 'Acme', level: 'builder' },
    { orgId: 'org_beta', label: 'Beta', level: 'operator' },
  ]);

  return {
    switcher: TestBed.inject(OwnerSwitchService),
    owner,
    confirm: TestBed.inject(ConfirmDialogService),
    calls,
    documents: () => documents,
    setActive,
  };
}

describe('OwnerSwitchService', () => {
  it('switches, closes every tab and resets each owner-scoped surface in order', async () => {
    const h = harness({ readOnlyTab: true });

    expect(await h.switcher.switchTo('org_acme')).toBeTrue();

    expect(h.owner.activeOrgId()).toBe('org_acme');
    expect(h.documents()).toEqual([]);
    // The order is the assertion. The tabs go before the owner moves, and the
    // notification STORE resets before the poll that reads its cursor.
    expect(h.calls).toEqual([
      'close-tabs',
      'store-reset',
      'poll-reset',
      'reload-library',
      'deployments-reset',
      'api-me',
    ]);
  });

  it('tells Clerk about the organisation in a browser build', async () => {
    const h = harness();

    await h.switcher.switchTo('org_beta');

    expect(h.setActive).toHaveBeenCalledOnceWith({ organization: 'org_beta' });
  });

  it('sets the signal alone on desktop, where there is no Clerk session', async () => {
    const h = harness({ desktop: true });

    await h.switcher.switchTo('org_beta');

    expect(h.setActive).not.toHaveBeenCalled();
    expect(h.owner.activeOrgId()).toBe('org_beta');
    // The header is the whole mechanism there, so it has to be in force.
    expect(h.owner.requestedOrg()).toBe('org_beta');
  });

  it('does nothing at all when the chosen owner is already active', async () => {
    const h = harness({ dirty: true });

    expect(await h.switcher.switchTo(null)).toBeFalse();

    // No prompt, because re-picking the current owner is not a request to throw
    // away unsaved work.
    expect(h.confirm.active()).toBeNull();
    expect(h.calls).toEqual([]);
  });

  // ─── The confirm rail (Requirement 20.8) ──────────────────────────────────

  it('prompts through the confirm rail when a document is dirty', async () => {
    const h = harness({ dirty: true });

    const switched = h.switcher.switchTo('org_acme');
    await Promise.resolve();

    const dialog = h.confirm.active();
    expect(dialog).withContext('no confirm dialog was opened').toBeTruthy();
    expect(dialog?.message).toContain('One');
    // Nothing has moved while the question is on screen.
    expect(h.owner.activeOrgId()).toBeNull();
    expect(h.calls).toEqual([]);

    h.confirm.accept();
    expect(await switched).toBeTrue();
    expect(h.owner.activeOrgId()).toBe('org_acme');
  });

  it('leaves the active owner unchanged when the confirm is cancelled', async () => {
    const h = harness({ dirty: true });

    const switched = h.switcher.switchTo('org_acme');
    await Promise.resolve();
    expect(h.confirm.active()).toBeTruthy();

    h.confirm.cancel();

    expect(await switched).toBeFalse();
    expect(h.owner.activeOrgId()).toBeNull();
    // And nothing was discarded: the tab is still open and no surface was reset.
    expect(h.documents().length).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.setActive).not.toHaveBeenCalled();
  });

  it('does not prompt when nothing is dirty', async () => {
    const h = harness({ dirty: false });

    await h.switcher.switchTo('org_acme');

    expect(h.confirm.active()).toBeNull();
    expect(h.owner.activeOrgId()).toBe('org_acme');
  });
});
