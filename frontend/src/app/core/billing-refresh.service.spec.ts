/**
 * The post-checkout window: it has to run, it has to STOP, and it has to stop
 * early once the answer arrives.
 *
 * The bound is the whole point of requirement 30 - an unbounded poll on a
 * checkout the user abandoned is a permanent background request loop - so the
 * assertions here are about termination rather than about a refresh happening at
 * all. The clock is shrunk through {@link BILLING_POLL_CONFIG} rather than by
 * mocking `setTimeout`, so the async sequencing under test is the real one.
 *
 * _Requirements: 29, 30_
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import {
  BILLING_POLL_CONFIG,
  BillingRefreshService,
  type BillingPollConfig,
} from './billing-refresh.service';
import { PhormaCloudService, type PhormaCloudProfile } from './phorma-cloud.service';

function profile(overrides: Partial<PhormaCloudProfile> = {}): PhormaCloudProfile {
  return {
    id: 'user_test',
    provisioned: false,
    tier: null,
    status: null,
    quota: null,
    ...overrides,
  };
}

/**
 * A `PhormaCloudService` whose `refresh()` is observable and whose profile the
 * test drives. The real one would fire its constructor effect and a `fetch`.
 */
function cloudStub(initial: PhormaCloudProfile | null = profile()) {
  const current = signal<PhormaCloudProfile | null>(initial);
  const loading = signal(false);
  /** Replaces the profile on the Nth refresh, mimicking a webhook landing. */
  let onRefresh: ((attempt: number) => void) | null = null;
  let attempts = 0;
  const refresh = jasmine.createSpy('refresh').and.callFake(async () => {
    attempts += 1;
    onRefresh?.(attempts);
  });
  return {
    profile: current,
    loading,
    refresh,
    signedIn: signal(true),
    subscribed: signal(false),
    pastDue: signal(false),
    error: signal(null),
    /** Arranges for the profile to change on the `at`th refresh. */
    changeOn(at: number, next: PhormaCloudProfile): void {
      onRefresh = (attempt) => {
        if (attempt === at) current.set(next);
      };
    },
  };
}

function setup(config: BillingPollConfig, cloud: ReturnType<typeof cloudStub>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PhormaCloudService, useValue: cloud },
      { provide: BILLING_POLL_CONFIG, useValue: config },
    ],
  });
  return TestBed.inject(BillingRefreshService);
}

/** Waits until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the poll to settle.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('BillingRefreshService', () => {
  afterEach(() => {
    // The service clears its own timer and listener on destroy; resetting the
    // TestBed is what triggers that, and a leaked timer would poison the next
    // spec rather than this one.
    TestBed.resetTestingModule();
  });

  it('is idle until a checkout is actually handed off', async () => {
    const cloud = cloudStub();
    const service = setup({ intervalMs: 1, maxAttempts: 4 }, cloud);

    expect(service.watching()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.refresh).not.toHaveBeenCalled();
  });

  it('stops after the bounded number of attempts and makes no further request', async () => {
    // A profile that never changes is exactly the abandoned checkout: the poll
    // has no answer to wait for, so only the bound can end it.
    const cloud = cloudStub();
    const service = setup({ intervalMs: 1, maxAttempts: 5 }, cloud);

    service.watch();
    expect(service.watching()).toBe(true);

    await until(() => !service.watching());

    expect(cloud.refresh).toHaveBeenCalledTimes(5);
    expect(service.remaining()).toBe(0);

    // The load-bearing half: nothing is still scheduled once the window closed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cloud.refresh).toHaveBeenCalledTimes(5);
  });

  it('stops early once the profile actually changes', async () => {
    const cloud = cloudStub(profile({ provisioned: false, tier: null, status: null }));
    // The webhook lands on the second read.
    cloud.changeOn(2, profile({ provisioned: true, tier: 'starter', status: 'active' }));
    const service = setup({ intervalMs: 1, maxAttempts: 20 }, cloud);

    service.watch();
    await until(() => !service.watching());

    expect(cloud.refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through an unrelated usage change', async () => {
    const quota = {
      month: '2026-09',
      runsUsed: 1,
      runsLimit: 300,
      creditsUsed: 10,
      creditsLimit: 1000,
      costUsdUsed: 0.04,
      costUsdLimit: 4,
    };
    const cloud = cloudStub(profile({ provisioned: true, tier: 'starter', status: null, quota }));
    // A run settling in another window moves the counters and nothing else. A
    // poll that treated that as its answer would stop before the webhook landed.
    cloud.changeOn(
      1,
      profile({
        provisioned: true,
        tier: 'starter',
        status: null,
        quota: { ...quota, runsUsed: 2, creditsUsed: 25, costUsdUsed: 0.1 },
      }),
    );
    const service = setup({ intervalMs: 1, maxAttempts: 4 }, cloud);

    service.watch();
    await until(() => !service.watching());

    expect(cloud.refresh).toHaveBeenCalledTimes(4);
  });

  it('restarts the window rather than stacking a second timer', async () => {
    const cloud = cloudStub();
    const service = setup({ intervalMs: 5, maxAttempts: 3 }, cloud);

    service.watch();
    service.watch();
    service.watch();

    expect(service.remaining()).toBe(3);
    await until(() => !service.watching());

    // Three overlapping timers would have produced nine reads.
    expect(cloud.refresh).toHaveBeenCalledTimes(3);
  });

  it('refreshes when the window regains focus, and only while it is open', async () => {
    const cloud = cloudStub();
    const service = setup({ intervalMs: 10_000, maxAttempts: 4 }, cloud);

    // Before any checkout there is no listener at all, so tabbing around a
    // studio nobody is buying anything in costs nothing.
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(cloud.refresh).not.toHaveBeenCalled();

    service.watch();
    window.dispatchEvent(new Event('focus'));
    await until(() => cloud.refresh.calls.count() === 1);

    service.stop();
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cloud.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not stack a focus refresh on top of one already in flight', async () => {
    const cloud = cloudStub();
    const service = setup({ intervalMs: 10_000, maxAttempts: 4 }, cloud);

    service.watch();
    // `PhormaCloudService.refresh()` does not dedupe, so the guard is here.
    cloud.loading.set(true);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cloud.refresh).not.toHaveBeenCalled();
  });

  it('ends the window on a focus refresh that finds the change', async () => {
    const cloud = cloudStub(profile({ status: null }));
    cloud.changeOn(1, profile({ provisioned: true, tier: 'pro', status: 'active' }));
    const service = setup({ intervalMs: 10_000, maxAttempts: 20 }, cloud);

    service.watch();
    window.dispatchEvent(new Event('focus'));
    await until(() => !service.watching());

    expect(cloud.refresh).toHaveBeenCalledTimes(1);
  });

  it('ships a bound that terminates rather than an accidental zero', () => {
    TestBed.configureTestingModule({});
    const config = TestBed.inject(BILLING_POLL_CONFIG);

    expect(config.maxAttempts).toBeGreaterThan(0);
    expect(config.intervalMs).toBeGreaterThan(0);
    // Two minutes: long enough for an unhurried card entry plus webhook
    // delivery, short enough that an abandoned checkout is not a request loop.
    expect(config.intervalMs * config.maxAttempts).toBeLessThanOrEqual(180_000);
  });
});
