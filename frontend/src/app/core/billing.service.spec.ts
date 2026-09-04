/**
 * `BillingService` - the DI-leaf claim first, then the request path.
 *
 * The leaf claim (requirement 31) is the one that cannot be checked by reading
 * the file. There is a precedent for asserting a leaf with a static import
 * allowlist (`scripts/check-telemetry-isolation.mjs`), and it is the wrong tool
 * here: `BillingService` injects `McpOAuthService` for the external-link helper,
 * so the hazard is TRANSITIVE and an import list of `billing.service.ts` alone
 * would pass while `McpOAuthService` quietly acquired a `CloudService` edge. The
 * first suite below therefore provides all four forbidden services with
 * RECORDING factories and asserts none of them was constructed - which covers
 * the whole construction chain, at whatever depth, and needs no new CI step
 * because it rides the existing karma run.
 *
 * Everything else is the request path: one token, one POST, one https URL handed
 * to `openExternal`, and a refusal that leaves no spinner behind.
 *
 * _Requirements: 31, 27, 28, 26, 9_
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import {
  BILLING_LOOKUP_KEYS,
  BillingService,
  subscriptionLookupKey,
  topupLookupKey,
  type BillingLookupKey,
} from './billing.service';
import { CloudService } from './cloud.service';
import { CREDIT_PACKS } from './credit-packs';
import { McpOAuthService } from './mcp-oauth.service';
import { ModelTransportService } from './model-transport.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { PHORMA_CLOUD_DEFAULT_URL } from './phorma-cloud-url';
import { RunControllerService } from './run-controller.service';
import { TauriService } from './tauri.service';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 120 };

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_a1';
const PORTAL_URL = 'https://billing.stripe.com/p/session/live_abc';

/** The Phorma Cloud override key, cleared per test so the base URL is fixed. */
const CLOUD_URL_KEY = 'phorma.layout.phormaCloudUrl';

// ─── Clerk stubs ────────────────────────────────────────────────────────────

/**
 * A Clerk that reports a signed-in user whose session mints `token`.
 *
 * `ReplaySubject(1)` matching the real `ClerkService`, so `firstValueFrom`
 * behaves as it does in the app rather than on a synchronous `of()`.
 */
function clerkWith(token: string | null): Partial<ClerkService> {
  const user$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  user$.next({ id: 'user_test' });
  session$.next(token === null ? null : { getToken: async () => token });
  return { user$, session$ } as unknown as Partial<ClerkService>;
}

/** A Clerk that has loaded and reports nobody signed in. */
function signedOutClerk(): Partial<ClerkService> {
  const user$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  user$.next(null);
  session$.next(null);
  return { user$, session$ } as unknown as Partial<ClerkService>;
}

/** A Clerk that never loads: both subjects stay silent. */
function silentClerk(): Partial<ClerkService> {
  return {
    user$: new ReplaySubject<unknown>(1),
    session$: new ReplaySubject<unknown>(1),
  } as unknown as Partial<ClerkService>;
}

// ─── Harness ────────────────────────────────────────────────────────────────

interface Harness {
  readonly billing: BillingService;
  readonly fetchSpy: jasmine.Spy;
  readonly openExternal: jasmine.Spy;
}

function configure(clerk: Partial<ClerkService>): void {
  TestBed.configureTestingModule({
    providers: [
      { provide: TauriService, useValue: { isDesktop: false } },
      { provide: ClerkService, useValue: clerk },
    ],
  });
}

/** Builds the service with `fetch` and `openExternal` stubbed. */
function harness(options: { clerk?: Partial<ClerkService>; response?: Response } = {}): Harness {
  configure(options.clerk ?? clerkWith('jwt-abc'));
  const fetchSpy = spyOn(window, 'fetch').and.resolveTo(
    options.response ?? new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 200 }),
  );
  const openExternal = spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();
  return { billing: TestBed.inject(BillingService), fetchSpy, openExternal };
}

/** The parsed JSON body of the nth `fetch` call. */
function bodyOf(spy: jasmine.Spy, call = 0): unknown {
  const init = spy.calls.argsFor(call)[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? 'null'));
}

/**
 * Clears the Phorma Cloud override so the base URL is the built-in default.
 * Registered PER SUITE rather than at the top level on purpose: a bare top-level
 * `beforeEach` in a karma spec file joins Jasmine's root suite and would run for
 * every spec in the whole app.
 */
function withDefaultCloudUrl(): void {
  beforeEach(() => localStorage.removeItem(CLOUD_URL_KEY));
  afterEach(() => localStorage.removeItem(CLOUD_URL_KEY));
}

// ─── Requirement 31: the leaf shape ─────────────────────────────────────────

describe('BillingService DI isolation (requirement 31)', () => {
  withDefaultCloudUrl();

  /**
   * The four services on (or reaching into) the known NG0200 cycle
   * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
   * CloudService -> RunControllerService`.
   */
  const FORBIDDEN = [
    { name: 'CloudService', token: CloudService },
    { name: 'PhormaCloudService', token: PhormaCloudService },
    { name: 'RunControllerService', token: RunControllerService },
    { name: 'ModelTransportService', token: ModelTransportService },
  ] as const;

  it('constructs without pulling any cycle service into its injector', () => {
    const constructed: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: signedOutClerk() },
        // Recording rather than throwing, so a violation reports WHICH service
        // arrived instead of an opaque DI error.
        ...FORBIDDEN.map(({ name, token }) => ({
          provide: token,
          useFactory: () => {
            constructed.push(name);
            return {} as unknown;
          },
        })),
      ],
    });

    const billing = TestBed.inject(BillingService);

    expect(billing).toBeTruthy();
    // Transitive: `McpOAuthService` and everything it injects is constructed for
    // real here, so an edge added anywhere down that chain fails this too.
    expect(constructed).toEqual([]);
  });

  it('keeps the whole request path free of them', async () => {
    const constructed: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: clerkWith('jwt-abc') },
        ...FORBIDDEN.map(({ name, token }) => ({
          provide: token,
          useFactory: () => {
            constructed.push(name);
            return {} as unknown;
          },
        })),
      ],
    });
    spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 200 }),
    );
    spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();

    // Construction is not the only moment a lazy `inject()` could appear.
    await TestBed.inject(BillingService).startCheckout('phorma_pro_monthly');

    expect(constructed).toEqual([]);
  });
});

// ─── The catalogue twin ─────────────────────────────────────────────────────

describe('BillingService catalogue', () => {
  it('maps every self-serve tier to an allowlisted lookup key', () => {
    for (const tier of ['starter', 'pro', 'team']) {
      const key = subscriptionLookupKey(tier);
      expect(key).not.toBeNull();
      expect(BILLING_LOOKUP_KEYS).toContain(key as BillingLookupKey);
    }
  });

  it('has no lookup key for enterprise, which stays sales-led (requirement 9)', () => {
    expect(subscriptionLookupKey('enterprise')).toBeNull();
  });

  it('maps every credit pack to an allowlisted top-up key', () => {
    const keys = CREDIT_PACKS.map((pack) => topupLookupKey(pack.id));

    expect(keys).toEqual(['phorma_topup_small', 'phorma_topup_medium', 'phorma_topup_large']);
    expect(new Set(keys).size).toBe(CREDIT_PACKS.length);
  });

  /**
   * Property: no string a caller can pass produces a key that is not on the
   * allowlist. The prototype cases are the ones worth generating - a plain
   * object read would answer truthy for `constructor` and `toString`.
   */
  it('never invents a lookup key for an arbitrary tier id', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom('constructor', 'toString', '__proto__', 'hasOwnProperty', 'PRO', 'plus'),
        ),
        (tier) => {
          const key = subscriptionLookupKey(tier);
          return key === null || BILLING_LOOKUP_KEYS.includes(key);
        },
      ),
      RUNS,
    );
  });
});

// ─── Checkout ───────────────────────────────────────────────────────────────

describe('BillingService.startCheckout', () => {
  withDefaultCloudUrl();

  it('posts the lookup key with a bearer token and opens the session URL', async () => {
    const { billing, fetchSpy, openExternal } = harness();

    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(true);

    const [input, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(input).toBe(`${PHORMA_CLOUD_DEFAULT_URL}/api/checkout`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-abc');
    // A lookup KEY and nothing else: no price id, no tenant id, no amount.
    expect(bodyOf(fetchSpy)).toEqual({ lookupKey: 'phorma_pro_monthly' });
    expect(openExternal).toHaveBeenCalledOnceWith(CHECKOUT_URL);
    expect(billing.lastUrl()).toBe(CHECKOUT_URL);
    expect(billing.error()).toBeNull();
  });

  it('honours a persisted Phorma Cloud override', async () => {
    localStorage.setItem(CLOUD_URL_KEY, JSON.stringify('https://cloud.example.test'));
    const { billing, fetchSpy } = harness();

    await billing.startCheckout('phorma_starter_monthly');

    expect(fetchSpy.calls.mostRecent().args[0]).toBe('https://cloud.example.test/api/checkout');
  });

  it('clears pending state and records the worker error on a refusal', async () => {
    const { billing, openExternal } = harness({
      response: new Response(JSON.stringify({ error: 'Stripe is not configured.' }), {
        status: 501,
      }),
    });

    await expectAsync(billing.startCheckout('phorma_topup_small')).toBeResolvedTo(false);

    expect(billing.error()).toEqual({
      message: 'Stripe is not configured.',
      status: 501,
      code: null,
    });
    expect(billing.pending()).toBeNull();
    expect(billing.busy()).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps a machine code when the body carries one', async () => {
    const { billing } = harness({
      response: new Response(
        JSON.stringify({ error: 'Your subscription is past due.', code: 'subscription_past_due' }),
        { status: 402 },
      ),
    });

    await billing.startCheckout('phorma_topup_large');

    expect(billing.error()?.code).toBe('subscription_past_due');
  });

  it('falls back to the status when the body carries no message', async () => {
    const { billing } = harness({ response: new Response('not json at all', { status: 502 }) });

    await billing.startCheckout('phorma_team_monthly');

    expect(billing.error()?.message).toContain('502');
  });

  it('refuses a non-https URL rather than handing it to the OS', async () => {
    const { billing, openExternal } = harness({
      response: new Response(JSON.stringify({ url: 'javascript:alert(1)' }), { status: 200 }),
    });

    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(false);

    expect(openExternal).not.toHaveBeenCalled();
    expect(billing.error()?.message).toContain('unreadable');
  });

  it('reports a network failure without leaving the request pending', async () => {
    configure(clerkWith('jwt-abc'));
    spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const billing = TestBed.inject(BillingService);

    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(false);

    expect(billing.error()?.message).toBe('Failed to fetch');
    expect(billing.busy()).toBe(false);
  });

  it('refuses a second request while one is in flight', async () => {
    configure(clerkWith('jwt-abc'));
    let release: (response: Response) => void = () => undefined;
    const fetchSpy = spyOn(window, 'fetch').and.returnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const openExternal = spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();
    const billing = TestBed.inject(BillingService);

    const first = billing.startCheckout('phorma_pro_monthly');
    // Let the token await settle so the guard is genuinely armed.
    await Promise.resolve();
    await Promise.resolve();
    const second = await billing.startCheckout('phorma_team_monthly');

    expect(second).toBe(false);
    expect(billing.checkoutPending()).toBe('phorma_pro_monthly');
    release(new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 200 }));

    await expectAsync(first).toBeResolvedTo(true);
    // One Stripe session, not two - each POST creates a real object.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(billing.checkoutPending()).toBeNull();
  });

  it('does not call the worker at all when signed out', async () => {
    const { billing, fetchSpy } = harness({ clerk: signedOutClerk() });

    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(billing.error()?.message).toContain('Sign in');
  });

  it('does not hang when Clerk never loads', async () => {
    const { billing, fetchSpy } = harness({ clerk: silentClerk() });

    // `signedIn()` is false until `user$` emits, so this answers immediately
    // rather than waiting out the session timeout.
    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(billing.busy()).toBe(false);
  });

  it('reports a session that cannot mint a token', async () => {
    const { billing, fetchSpy } = harness({ clerk: clerkWith(null) });

    await expectAsync(billing.startCheckout('phorma_pro_monthly')).toBeResolvedTo(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(billing.error()?.message).toContain('Sign in');
  });

  it('clears a previous error when a new attempt succeeds', async () => {
    const { billing, fetchSpy } = harness({
      response: new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    });
    await billing.startCheckout('phorma_pro_monthly');
    expect(billing.error()).not.toBeNull();

    fetchSpy.and.resolveTo(new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 200 }));
    await billing.startCheckout('phorma_pro_monthly');

    expect(billing.error()).toBeNull();
  });

  /**
   * Property: for ANY refusal status and any body, a checkout for any
   * allowlisted key resolves false, records a non-empty message, opens nothing,
   * and leaves no spinner behind. This is the claim task 7.2's five call sites
   * depend on - a stuck `busy()` is a permanently disabled Subscribe button.
   */
  it('never opens a URL and never stays pending on any refusal', async () => {
    // ONE harness for the whole property: jasmine allows `spyOn` on a given
    // property once per spec, and the service is stateless between attempts
    // apart from the signals each iteration asserts on.
    const { billing, fetchSpy, openExternal } = harness();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.constantFrom(...BILLING_LOOKUP_KEYS),
        fc.oneof(
          fc.constant('not json'),
          fc.constant('{}'),
          // A refusal that ALSO carries a URL: the status decides, not the body.
          fc.constant(JSON.stringify({ url: CHECKOUT_URL })),
          fc.string().map((error) => JSON.stringify({ error })),
        ),
        async (status, lookupKey, body) => {
          openExternal.calls.reset();
          fetchSpy.and.resolveTo(new Response(body, { status }));

          const started = await billing.startCheckout(lookupKey);

          expect(started).toBe(false);
          expect(openExternal).not.toHaveBeenCalled();
          expect(billing.pending()).toBeNull();
          expect(billing.busy()).toBe(false);
          expect(billing.error()?.message.length).toBeGreaterThan(0);
          expect(billing.error()?.status).toBe(status);
        },
      ),
      RUNS,
    );
  });
});

// ─── Billing portal ─────────────────────────────────────────────────────────

describe('BillingService.openBillingPortal', () => {
  withDefaultCloudUrl();

  it('posts to the portal route and opens the portal URL', async () => {
    const { billing, fetchSpy, openExternal } = harness({
      response: new Response(JSON.stringify({ url: PORTAL_URL }), { status: 200 }),
    });

    await expectAsync(billing.openBillingPortal()).toBeResolvedTo(true);

    expect(fetchSpy.calls.mostRecent().args[0]).toBe(
      `${PHORMA_CLOUD_DEFAULT_URL}/api/billing-portal`,
    );
    // No lookup key: the portal is not a purchase.
    expect(bodyOf(fetchSpy)).toEqual({});
    expect(openExternal).toHaveBeenCalledOnceWith(PORTAL_URL);
  });

  it('surfaces the 404 a tenant with no billing account gets', async () => {
    const { billing } = harness({
      response: new Response(
        JSON.stringify({ error: 'There is no billing account to manage yet. Choose a plan first.' }),
        { status: 404 },
      ),
    });

    await expectAsync(billing.openBillingPortal()).toBeResolvedTo(false);

    expect(billing.error()?.status).toBe(404);
    expect(billing.portalPending()).toBe(false);
  });

  it('tracks its own pending flag, not the checkout one', async () => {
    configure(clerkWith('jwt-abc'));
    let release: (response: Response) => void = () => undefined;
    spyOn(window, 'fetch').and.returnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();
    const billing = TestBed.inject(BillingService);

    const opening = billing.openBillingPortal();
    await Promise.resolve();
    await Promise.resolve();

    expect(billing.portalPending()).toBe(true);
    expect(billing.checkoutPending()).toBeNull();
    expect(billing.busy()).toBe(true);

    release(new Response(JSON.stringify({ url: PORTAL_URL }), { status: 200 }));
    await opening;

    expect(billing.portalPending()).toBe(false);
    expect(billing.busy()).toBe(false);
  });
});

// ─── clearError ─────────────────────────────────────────────────────────────

describe('BillingService.clearError', () => {
  withDefaultCloudUrl();

  it('drops the recorded failure', async () => {
    const { billing } = harness({
      response: new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    });
    await billing.startCheckout('phorma_pro_monthly');
    expect(billing.error()).not.toBeNull();

    billing.clearError();

    expect(billing.error()).toBeNull();
  });
});
