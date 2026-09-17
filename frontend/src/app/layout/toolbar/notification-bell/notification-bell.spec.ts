/**
 * The bell and its dropdown.
 *
 * Four things are asserted here that nothing else can catch:
 *
 *  1. the panel does NOT carry `role="dialog"`. `Toolbar.anyOverlayOpen()` is
 *     `!!document.querySelector('[role="dialog"]')` and gates whether Escape
 *     deselects canvas nodes, so a dropdown claiming to be a dialog silently
 *     breaks the canvas for as long as the bell is open. This is the kind of
 *     regression that looks like an unrelated bug three weeks later.
 *  2. no `pi pi-*` glyphs. `primeicons` is uninstalled, so one renders as a blank
 *     box, and a blank box in a notification row reads as broken software.
 *  3. inline Approve/Reject appears ONLY for a payload-free approval. Approving a
 *     payment from a dropdown without seeing what is being approved is the failure
 *     the `resolvableInline` rule exists to prevent.
 *  4. pending actions render ABOVE the feed, always. The whole point of the panel
 *     is that the thing waiting on you is the thing you see first.
 *
 * The panel is appended to the document body by PrimeNG, so every query here goes
 * through `document` rather than the fixture's own element.
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';

import { NotificationBell } from './notification-bell';
import { NotificationCenterService } from '../../../core/notification-center.service';
import { NotificationsService } from '../../../core/notifications.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { BillingCtaService } from '../../../shared/billing/billing-cta.service';
import type { BillingRemedy } from '../../../core/billing-refusal';
import type { PendingActionRow, StudioNotification } from '../../../core/notifications.model';

const KEYS = ['phorma.layout.notificationsReadAt', 'phorma.layout.notificationsMutedKinds'];

function pendingRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
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
    title: 'Scheduled run of "Invoice triage" failed',
    detail: 'Upstream returned 500.',
    icon: 'ti-alert-triangle',
    at: 1_000,
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    runId: 'run-1',
    ...overrides,
  };
}

interface Harness {
  fixture: ComponentFixture<NotificationBell>;
  pending: ReturnType<typeof signal<PendingActionRow[]>>;
  recent: ReturnType<typeof signal<StudioNotification[]>>;
  badge: ReturnType<typeof signal<number>>;
  problem: ReturnType<typeof signal<boolean>>;
  unreachable: ReturnType<typeof signal<string[]>>;
  truncated: ReturnType<typeof signal<boolean>>;
  pollError: ReturnType<typeof signal<string | null>>;
  subscribed: ReturnType<typeof signal<boolean>>;
  signedIn: ReturnType<typeof signal<boolean>>;
  resolveSpy: jasmine.Spy;
  navigateSpy: jasmine.Spy;
  navigateNotificationSpy: jasmine.Spy;
  toggleSpy: jasmine.Spy;
  ctaSpy: jasmine.Spy;
  /** Opens the dropdown and settles change detection. */
  open(): Promise<void>;
  /** The panel root, or null when closed. */
  panel(): HTMLElement | null;
  text(): string;
}

function setup(): Harness {
  for (const key of KEYS) localStorage.removeItem(key);

  const pending = signal<PendingActionRow[]>([]);
  const recent = signal<StudioNotification[]>([]);
  const badge = signal(0);
  const problem = signal(false);
  const unreachable = signal<string[]>([]);
  const truncated = signal(false);
  const pollError = signal<string | null>(null);
  const subscribed = signal(true);
  const signedIn = signal(true);
  const open = signal(false);

  const resolveSpy = jasmine.createSpy('resolve').and.resolveTo(true);
  const navigateSpy = jasmine.createSpy('navigateTo');
  const navigateNotificationSpy = jasmine.createSpy('navigateToNotification');
  const toggleSpy = jasmine.createSpy('toggle').and.callFake(() => open.update(v => !v));
  const ctaSpy = jasmine.createSpy('run');

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      {
        provide: NotificationCenterService,
        useValue: {
          open,
          feed: recent,
          recent,
          pendingActions: pending,
          badgeCount: badge,
          hasProblem: problem,
          unreachable,
          truncated,
          pollError,
          refreshing: signal(false),
          toggle: toggleSpy,
          close: () => open.set(false),
          markAllRead: () => undefined,
          dismiss: jasmine.createSpy('dismiss'),
          refresh: async () => undefined,
          resolve: resolveSpy,
          navigateTo: navigateSpy,
          navigateToNotification: navigateNotificationSpy,
        },
      },
      { provide: PhormaCloudService, useValue: { signedIn, subscribed } },
      { provide: BillingCtaService, useValue: { run: ctaSpy } },
    ],
  });

  const fixture = TestBed.createComponent(NotificationBell);
  fixture.detectChanges();

  const harness: Harness = {
    fixture,
    pending,
    recent,
    badge,
    problem,
    unreachable,
    truncated,
    pollError,
    subscribed,
    signedIn,
    resolveSpy,
    navigateSpy,
    navigateNotificationSpy,
    toggleSpy,
    ctaSpy,
    open: async () => {
      const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
      trigger.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    },
    panel: () => document.querySelector<HTMLElement>('.phorma-bell'),
    text: () => harness.panel()?.textContent ?? '',
  };
  return harness;
}

/** Buttons inside the panel whose visible label matches `label`. */
function buttonsLabelled(label: string): HTMLButtonElement[] {
  const panel = document.querySelector('.phorma-bell');
  if (!panel) return [];
  return [...panel.querySelectorAll<HTMLButtonElement>('button')].filter(
    button => (button.textContent ?? '').trim() === label,
  );
}

describe('NotificationBell', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    for (const key of KEYS) localStorage.removeItem(key);
    for (const key of KEYS) localStorage.removeItem(key);
  });

  // ── The trigger ───────────────────────────────────────────────────────────

  it('shows no count when there is nothing to report', () => {
    const rig = setup();

    expect(rig.fixture.nativeElement.querySelector('.phorma-bell__count')).toBeNull();
    expect(rig.fixture.nativeElement.querySelector('.ti-bell')).toBeTruthy();
  });

  it('shows the count and switches to the filled bell', () => {
    const rig = setup();
    rig.badge.set(3);
    rig.fixture.detectChanges();

    const pill = rig.fixture.nativeElement.querySelector('.phorma-bell__count') as HTMLElement;
    expect(pill.textContent?.trim()).toBe('3');
    expect(rig.fixture.nativeElement.querySelector('.ti-bell-filled')).toBeTruthy();
  });

  it('caps the count so a three-digit pill cannot break the toolbar row', () => {
    const rig = setup();
    rig.badge.set(47);
    rig.fixture.detectChanges();

    // Past the cap the exact number stops being information - nobody acts
    // differently on 47 than on "lots".
    expect(
      (rig.fixture.nativeElement.querySelector('.phorma-bell__count') as HTMLElement).textContent?.trim(),
    ).toBe('9+');
  });

  it('tints the count when something is a problem', () => {
    const rig = setup();
    rig.badge.set(1);
    rig.problem.set(true);
    rig.fixture.detectChanges();

    expect(
      rig.fixture.nativeElement.querySelector('.phorma-bell__count--problem'),
    ).toBeTruthy();
  });

  it('names what is waiting in the tooltip', () => {
    const rig = setup();
    rig.pending.set([pendingRow()]);
    rig.fixture.detectChanges();

    const trigger = rig.fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Notifications');
    // `aria-expanded` has to be on the element carrying the button role, which is
    // the NATIVE button PrimeNG renders - not the `p-button` host. A binding on the
    // host looks right in the template and is invisible to a screen reader.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  // ── The panel is a menu, not a dialog ─────────────────────────────────────

  it('carries role=menu and never role=dialog', async () => {
    const rig = setup();
    rig.recent.set([notification()]);
    await rig.open();

    expect(rig.panel()).toBeTruthy();
    // The load-bearing assertion. `Toolbar.anyOverlayOpen()` probes for this
    // attribute to decide whether Escape deselects canvas nodes, and PrimeNG's
    // Popover hard-codes `role="dialog"` on its panel - so this fails unless the
    // `pt` override actually landed.
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
    expect(document.querySelector('.p-popover')?.getAttribute('role')).toBe('menu');
    // Not modal either: a dropdown that claims to be traps assistive technology.
    expect(document.querySelector('.p-popover')?.hasAttribute('aria-modal')).toBe(false);
  });

  it('uses Tabler icons only', async () => {
    const rig = setup();
    rig.pending.set([pendingRow()]);
    rig.recent.set([notification()]);
    await rig.open();

    const panel = rig.panel()!;
    // `primeicons` is uninstalled, so a `pi pi-*` class renders a blank box.
    expect(panel.querySelectorAll('[class*="pi-"]').length).toBe(0);
    expect(panel.querySelectorAll('i.ti').length).toBeGreaterThan(0);
  });

  // ── Sections and ordering ─────────────────────────────────────────────────

  it('renders pending actions above the feed', async () => {
    const rig = setup();
    rig.pending.set([pendingRow()]);
    rig.recent.set([notification()]);
    await rig.open();

    const titles = [...rig.panel()!.querySelectorAll('.phorma-bell__section-title')].map(node =>
      (node.textContent ?? '').trim(),
    );
    expect(titles).toEqual(['Needs your attention', 'Recent']);
  });

  it('omits the attention section entirely when nothing is waiting', async () => {
    const rig = setup();
    rig.recent.set([notification()]);
    await rig.open();

    expect(rig.text()).not.toContain('Needs your attention');
  });

  it('shows an empty state rather than a blank panel', async () => {
    const rig = setup();
    await rig.open();

    expect(rig.text()).toContain('Nothing needs you right now');
  });

  it('renders a notification title, detail and workflow name', async () => {
    const rig = setup();
    rig.recent.set([notification()]);
    await rig.open();

    const text = rig.text();
    expect(text).toContain('Scheduled run of "Invoice triage" failed');
    expect(text).toContain('Upstream returned 500.');
    expect(text).toContain('Invoice triage');
  });

  // ── Inline resolution (the 2=b rule) ──────────────────────────────────────

  it('offers Approve and Reject for a payload-free approval', async () => {
    const rig = setup();
    rig.pending.set([pendingRow({ hasPayload: false, resolvableInline: true })]);
    await rig.open();

    expect(buttonsLabelled('Approve').length).toBe(1);
    expect(buttonsLabelled('Reject').length).toBe(1);
    expect(buttonsLabelled('Review').length).toBe(0);
  });

  it('offers Review instead for an approval carrying a payload', async () => {
    const rig = setup();
    rig.pending.set([pendingRow({ hasPayload: true, resolvableInline: false })]);
    await rig.open();

    // Approving a payment from a dropdown without seeing what is being approved.
    expect(buttonsLabelled('Approve').length).toBe(0);
    expect(buttonsLabelled('Reject').length).toBe(0);
    expect(buttonsLabelled('Review').length).toBe(1);
    expect(rig.text()).toContain('Review the details before approving');
  });

  it('offers Review for a question and for a wait', async () => {
    const rig = setup();
    rig.pending.set([
      pendingRow({ id: 'q', kind: 'question', resolvableInline: false }),
      pendingRow({ id: 'w', kind: 'wait', resolvableInline: false }),
    ]);
    await rig.open();

    // A question needs free text and a wait needs an event body; neither fits a
    // two-button row.
    expect(buttonsLabelled('Review').length).toBe(2);
    expect(buttonsLabelled('Approve').length).toBe(0);
  });

  it('dispatches an approval and a rejection distinctly', async () => {
    const rig = setup();
    const row = pendingRow();
    rig.pending.set([row]);
    await rig.open();

    buttonsLabelled('Approve')[0].click();
    await rig.fixture.whenStable();
    expect(rig.resolveSpy).toHaveBeenCalledWith(row, true);

    rig.resolveSpy.calls.reset();
    buttonsLabelled('Reject')[0].click();
    await rig.fixture.whenStable();
    expect(rig.resolveSpy).toHaveBeenCalledWith(row, false);
  });

  it('does not navigate when the Approve button is pressed', async () => {
    const rig = setup();
    rig.pending.set([pendingRow()]);
    await rig.open();

    buttonsLabelled('Approve')[0].click();
    await rig.fixture.whenStable();

    // The row itself navigates, so a decision must stop propagation or approving
    // also yanks the user out of whatever they were doing.
    expect(rig.navigateSpy).not.toHaveBeenCalled();
  });

  it('ignores a second press while a decision is in flight', async () => {
    const rig = setup();
    let release: (value: boolean) => void = () => undefined;
    rig.resolveSpy.and.returnValue(new Promise<boolean>(resolve => (release = resolve)));
    rig.pending.set([pendingRow()]);
    await rig.open();

    buttonsLabelled('Approve')[0].click();
    buttonsLabelled('Approve')[0].click();
    expect(rig.resolveSpy.calls.count()).toBe(1);

    release(true);
    await rig.fixture.whenStable();
  });

  it('opens the run when a Review button is pressed', async () => {
    const rig = setup();
    const row = pendingRow({ hasPayload: true, resolvableInline: false });
    rig.pending.set([row]);
    await rig.open();

    buttonsLabelled('Review')[0].click();

    expect(rig.navigateSpy).toHaveBeenCalledWith(row);
  });

  // ── Billing remedies ──────────────────────────────────────────────────────

  it('offers the remedy a refusal earns and dispatches it through the shared rail', async () => {
    const rig = setup();
    rig.recent.set([notification({ remedy: 'buy-credits' })]);
    await rig.open();

    const button = buttonsLabelled('Buy credits');
    expect(button.length).toBe(1);

    button[0].click();
    expect(rig.ctaSpy).toHaveBeenCalledWith('buy-credits' satisfies BillingRemedy);
  });

  it('offers no remedy button when a failure earns none', async () => {
    const rig = setup();
    rig.recent.set([notification()]);
    await rig.open();

    expect(buttonsLabelled('Buy credits').length).toBe(0);
    expect(buttonsLabelled('View plans').length).toBe(0);
  });

  // ── Partial answers are stated ────────────────────────────────────────────

  it('says when the poll could not reach the cloud', async () => {
    const rig = setup();
    rig.pollError.set('Network unreachable');
    await rig.open();

    // An outage must not read as a clean bill of health.
    expect(rig.text()).toContain('Could not reach Phorma Cloud');
  });

  it('names how many deployments could not be checked', async () => {
    const rig = setup();
    rig.unreachable.set(['wf-a', 'wf-b']);
    await rig.open();

    expect(rig.text()).toContain('2 deployments could not be checked');
  });

  it('says when the deployment list was capped', async () => {
    const rig = setup();
    rig.truncated.set(true);
    await rig.open();

    expect(rig.text()).toContain('most recently updated deployments only');
  });

  // ── Account states ────────────────────────────────────────────────────────

  it('explains the gate to an unsubscribed account and routes to the plan cards', async () => {
    const rig = setup();
    rig.subscribed.set(false);
    await rig.open();

    expect(rig.text()).toContain('Local runs only');
    const link = rig.panel()!.querySelector('.phorma-bell__link') as HTMLButtonElement;
    link.click();

    // The plan cards, never a direct checkout: a footer line in a narrow dropdown
    // cannot ask which of three plans somebody wants.
    expect(rig.ctaSpy).toHaveBeenCalledWith('subscribe' satisfies BillingRemedy);
  });

  it('works with no account at all, and asks for sign-in rather than a plan', async () => {
    const rig = setup();
    rig.signedIn.set(false);
    rig.subscribed.set(false);
    rig.recent.set([notification({ origin: 'local', kind: 'local-run-completed' })]);
    await rig.open();

    // The bell shipped gated on being signed in for one revision, which made the
    // entire feature invisible to every `ng serve` session. A local run finishing
    // is its content for an install with no account too.
    expect(rig.panel()).toBeTruthy();
    expect(rig.text()).toContain('Sign in to see what your deployed workflows are doing');
    // Offering plans to somebody with no account is a dead end, so that CTA is
    // absent rather than merely inert.
    expect(rig.panel()!.querySelector('.phorma-bell__link')).toBeNull();
  });

  it('says nothing about plans to a subscriber', async () => {
    const rig = setup();
    rig.subscribed.set(true);
    await rig.open();

    expect(rig.text()).not.toContain('Local runs only');
  });

  // ── Dismissal ─────────────────────────────────────────────────────────────

  it('offers no dismiss button on a pending action', async () => {
    const rig = setup();
    rig.pending.set([pendingRow()]);
    await rig.open();

    // Dismissing "this run needs your approval" would leave the run suspended
    // forever with nothing on screen to say so.
    const action = rig.panel()!.querySelector('.phorma-bell__action')!;
    expect(action.querySelector('[aria-label="Dismiss"]')).toBeNull();
  });

  it('offers a dismiss button on a feed row', async () => {
    const rig = setup();
    rig.recent.set([notification()]);
    await rig.open();

    expect(rig.panel()!.querySelector('[aria-label="Dismiss"]')).toBeTruthy();
  });
});
