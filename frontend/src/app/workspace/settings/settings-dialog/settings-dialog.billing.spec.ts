/**
 * The two billing behaviours the Settings dialog owns.
 *
 * `past_due` (requirement 17): a tenant whose card failed must be offered a card
 * update through the Billing Portal and NEVER a Subscribe CTA, because they
 * already have a subscription - selling them another one is the wrong remedy and,
 * in Stripe, a second subscription rather than a fixed one. The branch reads the
 * tenant `status` off `/api/me` and not a billing error code: `/api/checkout` and
 * `/api/billing-portal` answer `{ error }` with no `code`, so there would be
 * nothing to branch on, and a `past_due` tenant may never have touched a billing
 * route in this session.
 *
 * BYO absence (requirement 32): on a BYO deployment billing is not disabled, it
 * is ABSENT. A user who brings their own Cloudflare or AWS account pays that
 * vendor directly, so a plan grid, a Manage billing action or a dunning banner on
 * their Cloud page would be describing a relationship they do not have.
 *
 * Both are asserted against the LAID-OUT instance. Two instances of a panel body
 * are routinely in the DOM at once in this app, and a query that ignores that
 * finds a hidden copy and passes on it.
 *
 * _Requirements: 17, 18, 32_
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { SettingsDialog } from './settings-dialog';
import { SettingsDialogService } from '../settings-dialog.service';
import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, type BillingLookupKey } from '../../../core/billing.service';
import { PhormaCloudService, type PhormaCloudProfile } from '../../../core/phorma-cloud.service';
import { SettingsService, type CloudProviderChoice } from '../../../core/settings.service';
import { TauriService } from '../../../core/tauri.service';

// ── Stubs ────────────────────────────────────────────────────────────────────

function billingStub() {
  return {
    signedIn: signal(true),
    pending: signal(null),
    busy: signal(false),
    checkoutPending: signal<BillingLookupKey | null>(null),
    portalPending: signal(false),
    error: signal(null),
    lastUrl: signal<string | null>(null),
    clearError: () => undefined,
    startCheckout: jasmine.createSpy('startCheckout').and.resolveTo(true),
    openBillingPortal: jasmine.createSpy('openBillingPortal').and.resolveTo(true),
  };
}

function profile(overrides: Partial<PhormaCloudProfile> = {}): PhormaCloudProfile {
  return {
    id: 'user_test',
    provisioned: true,
    tier: 'pro',
    status: 'past_due',
    quota: {
      month: '2026-09',
      runsUsed: 120,
      runsLimit: 2000,
      creditsUsed: 900,
      creditsLimit: 3000,
      costUsdUsed: 3.78,
      costUsdLimit: 12.6,
    },
    ...overrides,
  };
}

/**
 * A `PhormaCloudService` with no constructor effect and no network. `subscribed`
 * and `pastDue` are set explicitly rather than derived, so a spec can pin the
 * exact combination the template branches on - including the one that matters
 * here, `subscribed() === false` WITH a live plan.
 */
function cloudStub(current: PhormaCloudProfile | null) {
  return {
    user: signal(current ? { id: current.id } : null),
    signedIn: signal(current != null),
    email: signal('buyer@example.test'),
    profile: signal(current),
    loading: signal(false),
    error: signal(null),
    subscribed: signal(current?.status === 'active'),
    pastDue: signal(current?.status === 'past_due'),
    subWorkflowDepth: signal(2),
    schedulesPerWorkflow: signal(1),
    runsFraction: signal(0.06),
    creditsFraction: signal(0.3),
    lowOnCredits: signal(false),
    creditsPerUsd: signal(250),
    refresh: jasmine.createSpy('refresh').and.resolveTo(),
    signIn: () => undefined,
    signOut: () => Promise.resolve(),
    sessionToken: () => Promise.resolve(null),
  };
}

interface Mounted {
  readonly fixture: ComponentFixture<SettingsDialog>;
  readonly billing: ReturnType<typeof billingStub>;
  readonly watch: jasmine.Spy;
}

function mountCloudPage(
  provider: CloudProviderChoice,
  current: PhormaCloudProfile | null,
): Mounted {
  const billing = billingStub();
  const watch = jasmine.createSpy('watch');
  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      { provide: TauriService, useValue: { isDesktop: false, selectFolderDialog: () => Promise.resolve(null) } },
      { provide: BillingService, useValue: billing },
      { provide: BillingRefreshService, useValue: { watch, stop: () => undefined, watching: signal(false), remaining: signal(0) } },
      { provide: PhormaCloudService, useValue: cloudStub(current) },
    ],
  });
  TestBed.inject(SettingsService).cloudProvider.set(provider);
  TestBed.inject(SettingsDialogService).open('cloud');
  const fixture = TestBed.createComponent(SettingsDialog);
  fixture.detectChanges();
  return { fixture, billing, watch };
}

/** Elements the browser actually lays out, so a hidden twin cannot answer. */
function laidOut<T extends HTMLElement>(fixture: ComponentFixture<unknown>, selector: string): T[] {
  return Array.from(fixture.nativeElement.querySelectorAll(selector) as NodeListOf<T>).filter(
    (element) => element.getBoundingClientRect().width > 0,
  );
}

/** Visible button labels, whitespace collapsed. */
function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return laidOut<HTMLButtonElement>(fixture, 'button').map((button) =>
    (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

function buttonWith(fixture: ComponentFixture<unknown>, text: string): HTMLButtonElement {
  const match = laidOut<HTMLButtonElement>(fixture, 'button').find((button) =>
    (button.textContent ?? '').includes(text),
  );
  if (!match) throw new Error(`No visible button containing "${text}". Saw: ${buttonLabels(fixture).join(' | ')}`);
  return match;
}

// ── past_due ─────────────────────────────────────────────────────────────────

describe('Settings > Cloud with a past_due tenant (requirements 17, 18)', () => {
  afterEach(() => {
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('offers an update-card action and never a Subscribe CTA', () => {
    const { fixture } = mountCloudPage('phorma', profile());

    expect(laidOut(fixture, '.phorma-past-due').length).toBe(1);
    const labels = buttonLabels(fixture);
    expect(labels).toContain('Update card');
    // The two shapes a purchase CTA takes on this page. Neither may appear:
    // requirement 18 keeps this tenant's plan, so there is nothing to buy.
    expect(labels).not.toContain('Choose');
    expect(labels).not.toContain('Subscribe - Starter');
  });

  it('keeps the tier on screen, because a failed payment does not remove it', () => {
    const { fixture } = mountCloudPage('phorma', profile({ tier: 'pro' }));

    const account = laidOut<HTMLElement>(fixture, '.phorma-settings__account')[0];
    expect(account).withContext('account panel').toBeDefined();
    expect(account.textContent).toContain('Pro');
    expect(account.textContent).toContain('payment failed');
    // The raw D1 token must not reach the user.
    expect(account.textContent).not.toContain('past_due');
  });

  it('routes the update through the Billing Portal and then watches for the fix', async () => {
    const { fixture, billing, watch } = mountCloudPage('phorma', profile());

    buttonWith(fixture, 'Update card').click();
    await fixture.whenStable();

    expect(billing.openBillingPortal).toHaveBeenCalledTimes(1);
    expect(billing.startCheckout).not.toHaveBeenCalled();
    // A card update produces an `invoice.paid` that restores `active`, and
    // nothing else would tell the studio (requirements 29, 30).
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('shows the plan grid to an active tenant and no dunning banner', () => {
    const { fixture } = mountCloudPage('phorma', profile({ status: 'active' }));

    expect(laidOut(fixture, '.phorma-past-due').length).toBe(0);
    expect(laidOut(fixture, '.phorma-plans').length).toBe(1);
  });
});

// ── BYO absence ──────────────────────────────────────────────────────────────

describe('Billing surfaces on a BYO deployment (requirement 32)', () => {
  afterEach(() => {
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  /**
   * Every billing surface the Cloud page can render, as a selector or a button
   * label. Absent means ABSENT: not a disabled control, not an explanatory note
   * about a subscription the user has no reason to want.
   */
  const BILLING_SURFACES: readonly { readonly what: string; readonly selector: string }[] = [
    { what: 'the plan grid', selector: '.phorma-plans' },
    { what: 'a plan card', selector: '.phorma-plans__card' },
    { what: 'the dunning banner', selector: '.phorma-past-due' },
    { what: 'the quota bar', selector: '.phorma-settings__quota' },
    { what: 'the account panel', selector: '.phorma-settings__account' },
  ];

  const BILLING_ACTIONS = ['Choose', 'Change plan', 'Manage billing', 'Update card', 'Buy more credits'];

  for (const provider of ['cloudflare', 'aws'] as const) {
    describe(`with the ${provider} deploy target`, () => {
      // Signed in AND past_due: the state most likely to leak a banner, since
      // `pastDue()` is true and every dunning branch would fire if the deploy
      // target were not checked first.
      it('renders no billing surface', () => {
        const { fixture } = mountCloudPage(provider, profile());

        for (const surface of BILLING_SURFACES) {
          expect(laidOut(fixture, surface.selector).length)
            .withContext(`${surface.what} on ${provider}`)
            .toBe(0);
        }
      });

      it('offers no billing action', () => {
        const { fixture } = mountCloudPage(provider, profile());
        const labels = buttonLabels(fixture);

        for (const action of BILLING_ACTIONS) {
          expect(labels).withContext(`"${action}" on ${provider}`).not.toContain(action);
        }
      });

      it('mentions no price', () => {
        const { fixture } = mountCloudPage(provider, profile());
        const body = laidOut<HTMLElement>(fixture, '.phorma-settings__content')[0]?.textContent ?? '';

        // The plan cards are the only thing on this page that prints a dollar
        // amount, so their absence is observable as the absence of one.
        expect(body).not.toContain('/month');
      });
    });
  }

  it('does render them for the phorma target, so absence is the target and not a broken page', () => {
    const { fixture } = mountCloudPage('phorma', profile({ status: 'active' }));

    expect(laidOut(fixture, '.phorma-plans__card').length).toBe(3);
    expect(buttonLabels(fixture)).toContain('Manage billing');
  });
});
