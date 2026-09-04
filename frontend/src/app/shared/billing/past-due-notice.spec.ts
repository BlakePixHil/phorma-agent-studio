/**
 * The one component every `past_due` surface renders (requirement 17).
 *
 * Two claims worth pinning. It must point at the Billing Portal and never at
 * checkout - a tenant with a live subscription who "subscribes" again gets a
 * SECOND subscription in Stripe rather than a working card. And it must say the
 * plan survived (requirement 18), because a user who reads "runs are paused" and
 * assumes their workflows are gone is the failure this copy exists to prevent.
 *
 * _Requirements: 17, 18, 29, 30_
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';

import { BillingRefreshService } from '../../core/billing-refresh.service';
import { BillingService, type BillingLookupKey } from '../../core/billing.service';
import { McpOAuthService } from '../../core/mcp-oauth.service';
import { PastDueNotice } from './past-due-notice';

function billingStub(portalOpens = true) {
  return {
    signedIn: signal(true),
    pending: signal(null),
    busy: signal(false),
    checkoutPending: signal<BillingLookupKey | null>(null),
    portalPending: signal(false),
    error: signal<{ message: string; status: number | null; code: string | null } | null>(null),
    lastUrl: signal<string | null>(null),
    clearError: () => undefined,
    startCheckout: jasmine.createSpy('startCheckout').and.resolveTo(true),
    openBillingPortal: jasmine.createSpy('openBillingPortal').and.resolveTo(portalOpens),
  };
}

function mount(portalOpens = true) {
  const billing = billingStub(portalOpens);
  const watch = jasmine.createSpy('watch');
  const openExternal = jasmine.createSpy('openExternal').and.resolveTo();
  TestBed.configureTestingModule({
    providers: [
      { provide: BillingService, useValue: billing },
      { provide: McpOAuthService, useValue: { openExternal } },
      {
        provide: BillingRefreshService,
        useValue: { watch, stop: () => undefined, watching: signal(false), remaining: signal(0) },
      },
    ],
  });
  const fixture = TestBed.createComponent(PastDueNotice);
  fixture.detectChanges();
  return { fixture, billing, watch, openExternal };
}

function buttonWith(fixture: ComponentFixture<unknown>, text: string): HTMLButtonElement {
  const match = Array.from(
    fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
  ).find((button) => (button.textContent ?? '').includes(text));
  if (!match) throw new Error(`No button containing "${text}".`);
  return match;
}

describe('PastDueNotice', () => {
  it('names the failure and says the plan survived', () => {
    const { fixture } = mount();
    const text = (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Payment failed');
    expect(text).toContain('still here');
    // The token `/api/me` carries is not user-facing copy.
    expect(text).not.toContain('past_due');
  });

  it('opens the Billing Portal and never a checkout', async () => {
    const { fixture, billing } = mount();

    buttonWith(fixture, 'Update card').click();
    await fixture.whenStable();

    expect(billing.openBillingPortal).toHaveBeenCalledTimes(1);
    expect(billing.startCheckout).not.toHaveBeenCalled();
  });

  it('watches for the restored subscription only after a real hand-off', async () => {
    const { fixture, watch } = mount(true);
    buttonWith(fixture, 'Update card').click();
    await fixture.whenStable();
    expect(watch).toHaveBeenCalledTimes(1);

    // A refused popup, a signed-out user or a 501 from an unconfigured worker
    // answers false, and must leave no timer running (requirement 30).
    TestBed.resetTestingModule();
    const refused = mount(false);
    buttonWith(refused.fixture, 'Update card').click();
    await refused.fixture.whenStable();

    expect(refused.watch).not.toHaveBeenCalled();
  });

  it('offers the live portal URL, since a blocked popup is undetectable', async () => {
    const { fixture, billing, openExternal } = mount();

    billing.lastUrl.set('https://billing.stripe.com/p/session/test_1');
    buttonWith(fixture, 'Update card').click();
    await fixture.whenStable();
    fixture.detectChanges();

    buttonWith(fixture, 'Open billing portal').click();

    expect(openExternal).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test_1');
  });
});
