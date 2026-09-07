/**
 * The plan picker and the credit packs - the two purchase surfaces.
 *
 * What is worth asserting here is not that a button exists but that the two ways
 * a purchase surface can take the WRONG money are impossible: Enterprise must
 * never reach checkout (requirement 9), and a tenant who already has a
 * subscription must be routed to the portal rather than issued a SECOND
 * subscription. The credit-pack suite covers the subscriber-only gate
 * (requirement 26).
 *
 * `BillingService` and `PhormaCloudService` are stubbed rather than driven through
 * `fetch`, because `billing.service.spec.ts` already owns the request path and
 * `PhormaCloudService`'s constructor effect would fire a real refresh.
 *
 * _Requirements: 9, 26, 27, 28_
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type Type } from '@angular/core';

import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, type BillingLookupKey } from '../../../core/billing.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { PhormaCloudService, type PhormaCloudProfile } from '../../../core/phorma-cloud.service';
import { CONTACT_SALES_URL, PLAN_CARDS } from '../../../core/plan-catalog';
import { CreditsDialog } from '../credits-dialog/credits-dialog';
import { PlanCards } from './plan-cards';

// ─── Stubs ──────────────────────────────────────────────────────────────────

/** A `BillingService` that records what it was asked to buy. */
function billingStub() {
  const checkoutPending = signal<BillingLookupKey | null>(null);
  const startCheckout = jasmine.createSpy('startCheckout').and.resolveTo(true);
  const openBillingPortal = jasmine.createSpy('openBillingPortal').and.resolveTo(true);
  return {
    signedIn: signal(true),
    pending: signal(null),
    busy: signal(false),
    checkoutPending,
    portalPending: signal(false),
    error: signal(null),
    lastUrl: signal<string | null>(null),
    clearError: () => undefined,
    startCheckout,
    openBillingPortal,
  };
}

function profile(overrides: Partial<PhormaCloudProfile> = {}): PhormaCloudProfile {
  return {
    id: 'user_test',
    provisioned: true,
    tier: 'starter',
    status: 'active',
    quota: null,
    ...overrides,
  };
}

/** A `PhormaCloudService` with no constructor effect and no network. */
function cloudStub(options: { signedIn?: boolean; profile?: PhormaCloudProfile | null } = {}) {
  const current = signal<PhormaCloudProfile | null>(options.profile ?? null);
  return {
    signedIn: signal(options.signedIn ?? true),
    profile: current,
    subscribed: signal(current()?.status === 'active'),
    // Separate from `subscribed` on purpose: `past_due` is false for BOTH, and
    // the surfaces branch on it to swap a Subscribe CTA for an update-card
    // action (requirement 17).
    pastDue: signal(current()?.status === 'past_due'),
    loading: signal(false),
    error: signal(null),
    email: signal('buyer@example.test'),
  };
}

interface Harness<T> {
  readonly fixture: ComponentFixture<T>;
  readonly billing: ReturnType<typeof billingStub>;
  readonly openExternal: jasmine.Spy;
  /** Records whether the surface opened the bounded post-checkout window. */
  readonly watch: jasmine.Spy;
}

function mount<T>(component: Type<T>, cloud: ReturnType<typeof cloudStub>): Harness<T> {
  const billing = billingStub();
  const openExternal = jasmine.createSpy('openExternal').and.resolveTo();
  const watch = jasmine.createSpy('watch');
  TestBed.configureTestingModule({
    providers: [
      { provide: BillingService, useValue: billing },
      { provide: PhormaCloudService, useValue: cloud },
      { provide: McpOAuthService, useValue: { openExternal } },
      // Stubbed rather than real: `watch()` installs a timer and a window
      // listener, and `billing-refresh.service.spec.ts` owns that behaviour.
      {
        provide: BillingRefreshService,
        useValue: { watch, stop: () => undefined, watching: signal(false), remaining: signal(0) },
      },
    ],
  });
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  return { fixture, billing, openExternal, watch };
}

/** Text of every rendered button, trimmed. */
function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLElement>).map(
    (button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

/** The first button whose text contains `text`. */
function buttonWith(fixture: ComponentFixture<unknown>, text: string): HTMLButtonElement {
  const match = Array.from(
    fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
  ).find((button) => (button.textContent ?? '').includes(text));
  if (!match) throw new Error(`No button containing "${text}". Saw: ${buttonLabels(fixture).join(' | ')}`);
  return match;
}

// ─── Plan cards ─────────────────────────────────────────────────────────────

describe('PlanCards', () => {
  it('renders nothing at all when nobody is signed in', () => {
    const { fixture } = mount(PlanCards, cloudStub({ signedIn: false }));

    expect(fixture.nativeElement.querySelector('.phorma-plans')).toBeNull();
  });

  it('offers checkout for each self-serve plan when there is no subscription', async () => {
    const cloud = cloudStub({ profile: profile({ provisioned: false, tier: null, status: null }) });
    const { fixture, billing } = mount(PlanCards, cloud);

    const cards = fixture.nativeElement.querySelectorAll('.phorma-plans__card');
    expect(cards.length).toBe(3);

    buttonWith(fixture, 'Choose').click();
    await fixture.whenStable();

    // Starter is the first card, so the first Choose buys the entry plan.
    expect(billing.startCheckout).toHaveBeenCalledOnceWith('phorma_starter_monthly');
    expect(billing.openBillingPortal).not.toHaveBeenCalled();
  });

  it('shows Enterprise with no price and no checkout path (requirement 9)', async () => {
    const { fixture, billing, openExternal } = mount(PlanCards, cloudStub({ profile: null }));

    const sales = fixture.nativeElement.querySelector('.phorma-plans__sales') as HTMLElement;
    expect(sales).not.toBeNull();
    expect(sales.textContent).toContain('Enterprise');
    // Not "no dollar amount somewhere on the page" - no dollar amount in the
    // Enterprise row, which is the claim requirement 9 actually makes.
    expect(sales.textContent).not.toContain('$');

    buttonWith(fixture, 'Contact sales').click();
    await fixture.whenStable();

    expect(openExternal).toHaveBeenCalledOnceWith(CONTACT_SALES_URL);
    expect(billing.startCheckout).not.toHaveBeenCalled();
  });

  it('routes a plan change to the portal instead of a second subscription', async () => {
    const cloud = cloudStub({ profile: profile({ tier: 'starter', status: 'active' }) });
    const { fixture, billing } = mount(PlanCards, cloud);

    // The tier they are on is inert; the others move them through the portal.
    expect(buttonWith(fixture, 'Current plan').disabled).toBe(true);
    buttonWith(fixture, 'Change plan').click();
    await fixture.whenStable();

    expect(billing.openBillingPortal).toHaveBeenCalledTimes(1);
    expect(billing.startCheckout).not.toHaveBeenCalled();
  });

  it('treats past_due as having a subscription, so it never offers a fresh purchase', () => {
    const cloud = cloudStub({ profile: profile({ tier: 'pro', status: 'past_due' }) });
    const { fixture } = mount(PlanCards, cloud);

    expect(buttonLabels(fixture)).not.toContain('Choose');
    expect(buttonLabels(fixture)).toContain('Manage billing');
  });

  it('hides Manage billing when there is no billing account to manage', () => {
    const cloud = cloudStub({ profile: profile({ provisioned: false, tier: null, status: null }) });
    const { fixture } = mount(PlanCards, cloud);

    expect(buttonLabels(fixture)).not.toContain('Manage billing');
  });

  it('offers the live Stripe URL after an attempt, since a blocked popup is undetectable', async () => {
    const { fixture, billing, openExternal } = mount(PlanCards, cloudStub({ profile: null }));
    expect(fixture.nativeElement.textContent).not.toContain("Didn't open?");

    billing.lastUrl.set('https://checkout.stripe.com/c/pay/cs_test_1');
    buttonWith(fixture, 'Choose').click();
    await fixture.whenStable();
    fixture.detectChanges();

    buttonWith(fixture, 'Open Stripe').click();

    expect(openExternal).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
  });

  it('opens the bounded post-checkout window only when the hand-off happened', async () => {
    const cloud = cloudStub({ profile: profile({ provisioned: false, tier: null, status: null }) });
    const { fixture, billing, watch } = mount(PlanCards, cloud);

    buttonWith(fixture, 'Choose').click();
    await fixture.whenStable();
    expect(watch).toHaveBeenCalledTimes(1);

    // A refused popup, a signed-out user or a 501 from an unconfigured worker
    // answers false, and must leave no timer running (requirement 30).
    billing.startCheckout.and.resolveTo(false);
    buttonWith(fixture, 'Choose').click();
    await fixture.whenStable();

    expect(watch).toHaveBeenCalledTimes(1);
  });

  /**
   * The three actions must share one baseline. The cards are equal-height grid
   * items whose blurbs wrap to different numbers of lines, so a button that is
   * laid out directly under its own blurb lands at a different y in each card -
   * which is exactly what shipped (measured spread: 18px, one blurb line).
   *
   * Two things make this a real test rather than a tautology. The container width
   * is pinned so auto-fit yields ONE row of three (different rows have different
   * tops by design, and asserting across them would be meaningless), and the
   * unequal content is FORCED with a min-height rather than left to text
   * wrapping, because karma's font metrics are not the studio's and a run where
   * every blurb happened to wrap identically would pass with the fix reverted.
   */
  it('keeps every card action on one baseline when the cards differ in content height', () => {
    const cloud = cloudStub({ profile: profile({ provisioned: false, tier: null, status: null }) });
    const { fixture } = mount(PlanCards, cloud);
    const host = fixture.nativeElement as HTMLElement;

    const section = host.querySelector('.phorma-plans') as HTMLElement;
    // The real settings content pane is ~630px, which is where `auto-fit` still
    // fits three 150px columns.
    section.style.width = '630px';

    const cards = Array.from(host.querySelectorAll('.phorma-plans__card')) as HTMLElement[];
    const blurb = (card: HTMLElement) => card.querySelector('.phorma-plans__blurb') as HTMLElement;
    // 18px is one wrapped line of the 12px/1.5 blurb - the studio's actual case.
    blurb(cards[2]).style.minHeight = `${blurb(cards[2]).getBoundingClientRect().height + 18}px`;

    const tops = cards.map(
      (card) => (card.querySelector('.phorma-plans__btn') as HTMLElement).getBoundingClientRect().top,
    );
    const cardTops = cards.map((card) => card.getBoundingClientRect().top);
    const cardHeights = cards.map((card) => card.getBoundingClientRect().height);
    const blurbHeights = cards.map((card) => blurb(card).getBoundingClientRect().height);

    // Preconditions: one stretched grid row, and content that does differ.
    expect(Math.max(...cardTops) - Math.min(...cardTops))
      .withContext('the three cards must share a grid row for the claim to mean anything')
      .toBeLessThanOrEqual(1);
    expect(Math.max(...cardHeights) - Math.min(...cardHeights))
      .withContext('grid items stretch, so the cards are equal height')
      .toBeLessThanOrEqual(1);
    expect(Math.max(...blurbHeights) - Math.min(...blurbHeights))
      .withContext('without unequal content there is nothing to misalign')
      .toBeGreaterThan(1);

    expect(Math.max(...tops) - Math.min(...tops))
      .withContext(`button tops: ${tops.map((top) => top.toFixed(2)).join(', ')}`)
      .toBeLessThanOrEqual(1);
  });

  it('prices every self-serve plan and leaves the sales-led one unpriced', () => {
    for (const plan of PLAN_CARDS) {
      const priced = plan.priceUsd !== null;
      expect(priced)
        .withContext(`${plan.tier} price vs credits`)
        .toBe(plan.credits !== null);
    }
  });
});

// ─── Credit packs ───────────────────────────────────────────────────────────

describe('CreditsDialog top-ups (requirement 26)', () => {
  function openDialog(cloud: ReturnType<typeof cloudStub>): Harness<CreditsDialog> {
    const harness = mount(CreditsDialog, cloud);
    harness.fixture.componentInstance['dialog'].open();
    harness.fixture.detectChanges();
    return harness;
  }

  it('buys the matching pack when the tenant is subscribed', async () => {
    const cloud = cloudStub({ profile: profile({ status: 'active' }) });
    cloud.subscribed.set(true);
    const { fixture, billing } = openDialog(cloud);

    expect(fixture.nativeElement.querySelectorAll('.phorma-credits__pack').length).toBe(3);
    buttonWith(fixture, 'Buy').click();
    await fixture.whenStable();

    expect(billing.startCheckout).toHaveBeenCalledOnceWith('phorma_topup_small');
  });

  it('refuses to sell a top-up without an active subscription', async () => {
    const cloud = cloudStub({ profile: profile({ status: 'canceled' }) });
    cloud.subscribed.set(false);
    const { fixture, billing } = openDialog(cloud);

    const buy = buttonWith(fixture, 'Buy');
    expect(buy.disabled).toBe(true);

    // Belt and braces: even if the disabled attribute were lost, the handler
    // itself must not start a checkout.
    fixture.componentInstance['buy'](fixture.componentInstance['packs'][0]);
    await fixture.whenStable();

    expect(billing.startCheckout).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('active subscription');
  });
});
