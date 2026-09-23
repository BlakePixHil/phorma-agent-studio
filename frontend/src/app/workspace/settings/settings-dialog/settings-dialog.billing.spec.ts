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
function cloudStub(current: PhormaCloudProfile | null, selfServeBilling = true) {
  return {
    user: signal(current ? { id: current.id } : null),
    signedIn: signal(current != null),
    email: signal('buyer@example.test'),
    profile: signal(current),
    loading: signal(false),
    error: signal(null),
    subscribed: signal(current?.status === 'active'),
    pastDue: signal(current?.status === 'past_due'),
    /**
     * False stands for "an organisation owner is active" - Phorma Labs invoices an
     * organisation, so every purchase surface is ABSENT (multi-organisation-phorma,
     * requirement 19.7). Set explicitly, like `subscribed` and `pastDue`, so a case
     * can pin an owner whose plan is perfectly healthy and still not theirs to buy.
     */
    selfServeBilling: signal(selfServeBilling),
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
  selfServeBilling = true,
): Mounted {
  const billing = billingStub();
  const watch = jasmine.createSpy('watch');
  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      { provide: TauriService, useValue: { isDesktop: false, selectFolderDialog: () => Promise.resolve(null) } },
      { provide: BillingService, useValue: billing },
      { provide: BillingRefreshService, useValue: { watch, stop: () => undefined, watching: signal(false), remaining: signal(0) } },
      { provide: PhormaCloudService, useValue: cloudStub(current, selfServeBilling) },
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

// ── The five surfaces and five actions, shared by both absence cases ─────────

/**
 * The PURCHASE surfaces: a grid to buy from, a card to buy, and a banner whose
 * whole content is a payment action. Absent means ABSENT for both the BYO case and
 * the organisation case: not a disabled control, not an explanatory note about a
 * subscription the user has no reason to want.
 */
const PURCHASE_SURFACES: readonly { readonly what: string; readonly selector: string }[] = [
  { what: 'the plan grid', selector: '.phorma-plans' },
  { what: 'a plan card', selector: '.phorma-plans__card' },
  { what: 'the dunning banner', selector: '.phorma-past-due' },
];

/**
 * The READING surfaces: what the account is on and what is left of it.
 *
 * The partition is load-bearing rather than tidy, and it is where the BYO case and
 * the organisation case genuinely differ. A BYO deployment renders neither, because
 * its user pays Cloudflare or AWS and the whole Phorma panel is absent. An
 * organisation owner renders BOTH, read-only, because requirement 19.8 requires it:
 * a member who sees no plan, no credits and no Subscribe button reads the page as a
 * broken account rather than as somebody else's bill. So "zero of the five" holds
 * for BYO and "zero of the three, plus the two present and read-only" holds for an
 * organisation - stated over ONE list, so neither case can quietly stop covering a
 * surface.
 */
const READING_SURFACES: readonly { readonly what: string; readonly selector: string }[] = [
  { what: 'the quota bar', selector: '.phorma-settings__quota' },
  { what: 'the account panel', selector: '.phorma-settings__account' },
];

const BILLING_SURFACES = [...PURCHASE_SURFACES, ...READING_SURFACES];

/** Every billing ACTION the Cloud page can offer. Both cases require zero. */
const BILLING_ACTIONS = ['Choose', 'Change plan', 'Manage billing', 'Update card', 'Buy more credits'];

// ── BYO absence ──────────────────────────────────────────────────────────────

describe('Billing surfaces on a BYO deployment (requirement 32)', () => {
  afterEach(() => {
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.resetTestingModule();
    localStorage.clear();
  });

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

// ── Organisation absence ─────────────────────────────────────────────────────

/**
 * The same five surfaces and five actions, for an ACTIVE ORGANISATION owner
 * (multi-organisation-phorma, Requirement 19.7, 19.8).
 *
 * The deploy target is `phorma` throughout, which is what makes this a second
 * parameterisation rather than a restatement of the BYO one: every predicate the BYO
 * case fails on is satisfied here. The account is signed in, the target is Phorma
 * Cloud, the tenant is provisioned, and one thing differs - who pays. So anything
 * still on screen is on screen because of the owner and nothing else.
 *
 * **Validates: Requirements 19.7, 19.8**
 */
describe('Billing surfaces while an organisation owner is active (Requirements 19.7, 19.8)', () => {
  afterEach(() => {
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  /** An organisation's `/api/me` answer: the owner IS the tenant, and it is an org. */
  const orgProfile = (overrides: Partial<PhormaCloudProfile> = {}) =>
    profile({ id: 'org_acme', ownerId: 'org_acme', tier: 'team', status: 'active', ...overrides });

  const mountOrg = (current = orgProfile()) => mountCloudPage('phorma', current, false);

  it('offers no purchase surface', () => {
    const { fixture } = mountOrg();

    for (const surface of PURCHASE_SURFACES) {
      expect(laidOut(fixture, surface.selector).length)
        .withContext(`${surface.what} for an organisation owner`)
        .toBe(0);
    }
  });

  it('offers no billing action', () => {
    // `lowOnCredits` is true here, so the Buy-more-credits button's own predicate is
    // satisfied and only the owner check can be keeping it off screen.
    const { fixture } = mountOrg(
      orgProfile({
        quota: { month: '2026-09', runsUsed: 10, runsLimit: 2000, creditsUsed: 9800, creditsLimit: 10000, costUsdUsed: 40, costUsdLimit: 44 },
      }),
    );
    const labels = buttonLabels(fixture);

    for (const action of BILLING_ACTIONS) {
      expect(labels).withContext(`"${action}" for an organisation owner`).not.toContain(action);
    }
  });

  it('mentions no price', () => {
    const { fixture } = mountOrg();
    const body = laidOut<HTMLElement>(fixture, '.phorma-settings__content')[0]?.textContent ?? '';

    expect(body).not.toContain('/month');
  });

  it('still shows the plan and the remaining credits, read-only', () => {
    const { fixture } = mountOrg();

    // Requirement 19.8. The reading surfaces are PRESENT - the opposite of the BYO
    // case - because a member has to be able to see what the organisation is on.
    for (const surface of READING_SURFACES) {
      expect(laidOut(fixture, surface.selector).length)
        .withContext(`${surface.what} for an organisation owner`)
        .toBe(1);
    }
    const account = laidOut<HTMLElement>(fixture, '.phorma-settings__account')[0];
    expect(account.textContent).toContain('Teams');
    const quota = laidOut<HTMLElement>(fixture, '.phorma-settings__quota')[0];
    expect(quota.textContent).toContain('Credits');
  });

  it('names Phorma Labs, so the missing actions read as intended rather than broken', () => {
    const { fixture } = mountOrg();
    const body = laidOut<HTMLElement>(fixture, '.phorma-settings__content')[0]?.textContent ?? '';

    expect(body).toContain('Phorma Labs');
  });

  it('offers no card update even when the organisation row is past_due', () => {
    // Unreachable through Stripe (an organisation has no Stripe customer), but an
    // operator CAN set the status by hand - and the Billing Portal that banner routes
    // to is exactly what the worker refuses with `billing_managed`.
    const { fixture, billing } = mountOrg(orgProfile({ status: 'past_due' }));

    expect(laidOut(fixture, '.phorma-past-due').length).toBe(0);
    expect(buttonLabels(fixture)).not.toContain('Update card');
    expect(billing.openBillingPortal).not.toHaveBeenCalled();
  });

  it('renders every one of them again for a personal owner, so absence is the owner', () => {
    // The control. Same target, same active tenant, personal owner: all five surfaces
    // are back, which is what makes the four cases above about the owner.
    const { fixture } = mountCloudPage('phorma', profile({ status: 'active' }));

    for (const surface of [...PURCHASE_SURFACES.filter((s) => s.selector !== '.phorma-past-due'), ...READING_SURFACES]) {
      expect(laidOut(fixture, surface.selector).length)
        .withContext(`${surface.what} for a personal owner`)
        .toBeGreaterThan(0);
    }
    expect(buttonLabels(fixture)).toContain('Manage billing');
  });
});
