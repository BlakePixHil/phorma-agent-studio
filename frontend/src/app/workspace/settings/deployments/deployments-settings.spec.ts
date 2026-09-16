/**
 * The Reconciliation_List surface (Requirements 6, 7).
 *
 * What is worth a suite here is the set of ways this page could quietly stop
 * doing its job:
 *
 * - Gating it on `subscribed()` instead of `signedIn()`. A lapsed subscriber is
 *   exactly who needs to stop a cron deployment they are still being billed for,
 *   so an upsell in place of the list would trap the spend (Requirement 6.6).
 * - Rendering a null spend as `0 credits`. Null means "no ledger to read"; zero
 *   means "spent nothing". One of those is a reason to relax.
 * - Losing the orphan badge, which is the only signal that a row cannot be
 *   opened, edited or deleted locally (Requirement 6.3).
 * - Firing Stop or Delete without a confirmation (Requirement 7.3).
 */

import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DeploymentsSettings } from './deployments-settings';
import { DeploymentsService, type DeploymentRow } from '../../../core/deployments.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { TauriService } from '../../../core/tauri.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

function row(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    workflowId: 'wf-one',
    workflowName: 'Invoice triage',
    deployedAt: Date.UTC(2026, 0, 15),
    updatedAt: Date.UTC(2026, 0, 15),
    specHash: 'abc123',
    cronArmed: false,
    portalSlug: null,
    creditsSpent: 12,
    runsThisMonth: 3,
    orphan: false,
    localName: null,
    ...overrides,
  };
}

describe('DeploymentsSettings', () => {
  let fixture: ComponentFixture<DeploymentsSettings>;
  let signedIn: ReturnType<typeof signal<boolean>>;
  let rows: ReturnType<typeof signal<DeploymentRow[]>>;
  let error: ReturnType<typeof signal<string | null>>;
  let loading: ReturnType<typeof signal<boolean>>;
  let loaded: ReturnType<typeof signal<boolean>>;
  let confirmResult: boolean;
  let confirmCalls: { title?: string; message?: string }[];
  let refresh: jasmine.Spy;
  let undeploy: jasmine.Spy;
  let purge: jasmine.Spy;
  let restoreToLibrary: jasmine.Spy;

  beforeEach(() => {
    signedIn = signal(true);
    rows = signal<DeploymentRow[]>([]);
    error = signal<string | null>(null);
    loading = signal(false);
    loaded = signal(true);
    confirmResult = true;
    confirmCalls = [];
    refresh = jasmine.createSpy('refresh').and.resolveTo(undefined);
    undeploy = jasmine.createSpy('undeploy').and.resolveTo(true);
    purge = jasmine.createSpy('purge').and.resolveTo(true);
    restoreToLibrary = jasmine.createSpy('restoreToLibrary').and.resolveTo('restored');

    TestBed.configureTestingModule({
      providers: [
        {
          provide: DeploymentsService,
          useValue: {
            deployments: rows,
            month: signal('2026-01'),
            loading,
            error,
            loaded,
            busyWorkflowId: signal<string | null>(null),
            orphanCount: () => rows().filter(entry => entry.orphan).length,
            hasArmedCron: () => rows().some(entry => entry.cronArmed),
            refresh,
            undeploy,
            purge,
            restoreToLibrary,
            readDeployedSpec: jasmine.createSpy('readDeployedSpec').and.resolveTo(null),
          },
        },
        { provide: PhormaCloudService, useValue: { signedIn } },
        {
          provide: ConfirmDialogService,
          useValue: {
            confirm: (options: { title?: string; message?: string }) => {
              confirmCalls.push(options);
              return Promise.resolve(confirmResult);
            },
          },
        },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: () => undefined, warning: () => undefined },
        },
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: McpOAuthService, useValue: { openExternal: async () => undefined } },
      ],
    });
    fixture = TestBed.createComponent(DeploymentsSettings);
    fixture.detectChanges();
  });

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function buttonLabelled(label: string): HTMLButtonElement | undefined {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      button => (button.textContent ?? '').trim() === label,
    ) as HTMLButtonElement | undefined;
  }

  // ── Gating ────────────────────────────────────────────────────────────────

  it('refreshes once when signed in', () => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders nothing and issues no request while signed out', () => {
    TestBed.resetTestingModule();
    signedIn.set(false);
    // A fresh component with the same stubs, signed out.
    const local = TestBed.configureTestingModule({
      providers: [
        {
          provide: DeploymentsService,
          useValue: {
            deployments: rows,
            month: signal(''),
            loading,
            error,
            loaded,
            busyWorkflowId: signal<string | null>(null),
            orphanCount: () => 0,
            hasArmedCron: () => false,
            refresh,
            undeploy,
            purge,
            restoreToLibrary,
            readDeployedSpec: async () => null,
          },
        },
        { provide: PhormaCloudService, useValue: { signedIn } },
        { provide: ConfirmDialogService, useValue: { confirm: async () => true } },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: () => undefined, warning: () => undefined },
        },
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: McpOAuthService, useValue: { openExternal: async () => undefined } },
      ],
    }).createComponent(DeploymentsSettings);
    refresh.calls.reset();
    local.detectChanges();

    expect((local.nativeElement as HTMLElement).textContent?.trim()).toBe('');
    expect(refresh).not.toHaveBeenCalled();
  });

  // ── Rows ──────────────────────────────────────────────────────────────────

  it('marks a row with no local copy (6.3)', () => {
    rows.set([row({ orphan: true })]);
    fixture.detectChanges();

    expect(text()).toContain('No local copy');
    // And explains what to do about it, rather than only labelling it.
    expect(text()).toContain('no copy in your library');
  });

  it('does not mark a row that has a local copy', () => {
    rows.set([row({ orphan: false })]);
    fixture.detectChanges();
    expect(text()).not.toContain('No local copy');
  });

  it('shows an armed schedule and a published portal (6.4)', () => {
    rows.set([row({ cronArmed: true, portalSlug: 'invoices' })]);
    fixture.detectChanges();

    expect(text()).toContain('Scheduled');
    expect(text()).toContain('/p/invoices');
  });

  it('renders spend as credits, never dollars (6.4)', () => {
    rows.set([row({ creditsSpent: 12 })]);
    fixture.detectChanges();

    expect(text()).toContain('12 credits this month');
    expect(text()).not.toContain('$');
  });

  it('renders a null spend as unavailable, not as zero (5.5)', () => {
    rows.set([row({ creditsSpent: null, runsThisMonth: null })]);
    fixture.detectChanges();

    expect(text()).toContain('spend unavailable');
    expect(text()).not.toContain('0 credits');
  });

  it('reports a local name that has drifted from the deployed one', () => {
    rows.set([row({ localName: 'Renamed locally' })]);
    fixture.detectChanges();
    expect(text()).toContain('saved locally as "Renamed locally"');
  });

  // ── Failure and empty states ──────────────────────────────────────────────

  it('shows the failure and keeps retry available (6.7)', () => {
    rows.set([row()]);
    error.set('Control plane unavailable.');
    fixture.detectChanges();

    expect(text()).toContain('Could not read your deployments');
    expect(text()).toContain('Control plane unavailable.');
    // The rows we already had stay on screen: an empty list would read as
    // "nothing is deployed", which is the one answer that stops somebody looking.
    expect(text()).toContain('Invoice triage');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh the deployment list"]',
      )?.disabled,
    ).toBeFalse();
  });

  it('does not claim an empty account while a read is failing', () => {
    error.set('Offline.');
    fixture.detectChanges();
    expect(text()).not.toContain('Nothing is deployed');
  });

  it('claims an empty account only after a clean read', () => {
    error.set(null);
    loaded.set(true);
    fixture.detectChanges();
    expect(text()).toContain('Nothing is deployed');
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  it('confirms before stopping a deployment (7.3)', async () => {
    rows.set([row()]);
    fixture.detectChanges();

    buttonLabelled('Stop')!.click();
    await fixture.whenStable();

    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].title).toContain('Stop this deployment');
    expect(undeploy).toHaveBeenCalledWith('wf-one');
  });

  it('does not stop a deployment when the confirmation is declined', async () => {
    rows.set([row()]);
    fixture.detectChanges();
    confirmResult = false;

    buttonLabelled('Stop')!.click();
    await fixture.whenStable();

    expect(undeploy).not.toHaveBeenCalled();
  });

  it('confirms before deleting, and says it cannot be undone (7.3)', async () => {
    rows.set([row()]);
    fixture.detectChanges();

    buttonLabelled('Delete')!.click();
    await fixture.whenStable();

    expect(confirmCalls[0].message).toContain('cannot be undone');
    expect(purge).toHaveBeenCalledWith('wf-one');
  });

  it('warns that an orphan has no local copy before destroying it', async () => {
    rows.set([row({ orphan: true })]);
    fixture.detectChanges();

    buttonLabelled('Delete')!.click();
    await fixture.whenStable();

    expect(confirmCalls[0].message).toContain('download it first');
  });

  it('tells a user with a local copy that it is not touched', async () => {
    rows.set([row({ orphan: false })]);
    fixture.detectChanges();

    buttonLabelled('Delete')!.click();
    await fixture.whenStable();

    expect(confirmCalls[0].message).toContain('local copy and its version history are not touched');
  });

  // ── Layout ────────────────────────────────────────────────────────────────
  // Karma runs real Chrome with `src/styles.scss` loaded, so these measure actual
  // layout rather than asserting on class names. Each one is a trap this codebase
  // has already paid for.

  it('does not collapse a row to its first line', () => {
    rows.set([
      row({ orphan: true, cronArmed: true, portalSlug: 'invoices', localName: 'Renamed' }),
    ]);
    fixture.detectChanges();

    const element = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.settings-section__row',
    )!;
    // A direct child of a flex column collapses to its header height without
    // `flex-shrink: 0`, and `overflow: auto` then hides the rest. The symptom is
    // a rect far shorter than the content.
    expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(element.scrollHeight);
  });

  it('keeps the action buttons on screen beside a long workflow name', () => {
    rows.set([
      row({
        workflowName:
          'Quarterly consolidated management accounts with intercompany eliminations and FX',
      }),
    ]);
    fixture.detectChanges();

    const rowElement = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.settings-section__row',
    )!;
    const actions = rowElement.querySelector<HTMLElement>('.settings-section__actions')!;
    const rowRect = rowElement.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();

    // `min-width: 0` on the growing child is what lets the name wrap instead of
    // pushing the actions past the row's right edge.
    expect(actionsRect.width).toBeGreaterThan(0);
    expect(Math.round(actionsRect.right)).toBeLessThanOrEqual(Math.round(rowRect.right) + 1);
  });

  it('renders every action label at a legible size', () => {
    rows.set([row()]);
    fixture.detectChanges();

    for (const label of ['Download', 'Restore', 'Stop', 'Delete']) {
      const button = buttonLabelled(label)!;
      expect(button).withContext(label).toBeTruthy();
      // Root font size is 14px, so 0.857rem is 12px. Measured, never derived by
      // rem arithmetic against an assumed 16.
      const size = Number.parseFloat(getComputedStyle(button).fontSize);
      expect(size).withContext(`${label} font size`).toBeGreaterThanOrEqual(11.5);
      expect(button.getBoundingClientRect().width).withContext(`${label} width`).toBeGreaterThan(0);
    }
  });

  it('scopes every element id, so two instances could not collide', () => {
    rows.set([row(), row({ workflowId: 'wf-two' })]);
    fixture.detectChanges();

    const ids = [...(fixture.nativeElement as HTMLElement).querySelectorAll('[id]')].map(
      element => element.id,
    );
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('restores through the service, with no confirmation (a restore adds)', async () => {
    rows.set([row({ orphan: true })]);
    fixture.detectChanges();

    buttonLabelled('Restore')!.click();
    await fixture.whenStable();

    expect(restoreToLibrary).toHaveBeenCalledWith('wf-one');
    // `restoreSpec` asks its own question when it would overwrite something, so a
    // second confirmation here would double-prompt the collision case.
    expect(confirmCalls.length).toBe(0);
  });
});
