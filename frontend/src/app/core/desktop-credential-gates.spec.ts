/**
 * The gates that must observe the DESKTOP credential, not the Clerk user.
 *
 * This suite exists because of a bug shipped in beta.19 and reported from a real
 * install: the browser handoff completed, the success toast named the user's
 * email, the Clerk user existed in the production instance - and the app still
 * behaved as if signed out. Every symptom traced to the same class of mistake in
 * four different places, each reading `ClerkService.user$` for "is anybody signed
 * in".
 *
 * On desktop that question CANNOT be answered by Clerk. The webview is cross-site
 * with `clerk.phorma-labs.com`, so a production instance never loads a user there
 * and `user$` is permanently null (see `DesktopAuthService`'s header for the
 * measurement). A signed-in desktop install is one holding a device token, and the
 * only correct gate is the union in `PhormaCloudService.signedIn`.
 *
 * What made this expensive to find is that the failures do not look like auth
 * failures:
 *
 *  - `BillingService.sessionToken()` returned null, so Checkout and the Billing
 *    Portal refused - which reads as a Stripe problem.
 *  - `CloudService.resolveAuthToken()` fell through to `null` for the `phorma`
 *    provider, so deploys went out with NO Authorization header and the worker
 *    failed them closed - which reads as a deploy problem.
 *  - The toolbar and the settings account card rendered the signed-OUT branch -
 *    which reads as a sign-in problem, and is the only one of the four a user can
 *    see.
 *
 * So the assertions here are deliberately about the CREDENTIAL each gate observes,
 * with the Clerk user pinned to null throughout. A test that merely signed a user
 * in through Clerk would pass against the original bug.
 */

import { TestBed } from '@angular/core/testing';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import { BillingService } from './billing.service';
import { CloudService } from './cloud.service';
import { DesktopAuthService } from './desktop-auth.service';
import { McpOAuthService } from './mcp-oauth.service';
import { loadPhormaCloudUrl, savePhormaCloudUrl } from './phorma-cloud-url';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';

/** The device token a signed-in desktop install holds. */
const DEVICE_TOKEN = 'phd_eyJzdWIiOiJ1c2VyX2FiYyJ9.c2ln';

/**
 * A Clerk in the state a PRODUCTION instance leaves a Tauri webview in: loaded,
 * with no user and no session, forever. Pinned this way in every spec below so a
 * gate can only pass by reading the device credential.
 */
function desktopClerk(): Partial<ClerkService> {
  const user$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  const clerk$ = new ReplaySubject<unknown>(1);
  user$.next(null);
  session$.next(null);
  clerk$.next({});
  return { user$, session$, clerk$ } as unknown as Partial<ClerkService>;
}

/** A `DesktopAuthService` holding a credential from a completed handoff. */
function signedInDesktopAuth(): Partial<DesktopAuthService> {
  return {
    signedIn: (() => true) as unknown as DesktopAuthService['signedIn'],
    email: (() => 'blake@example.com') as unknown as DesktopAuthService['email'],
    userId: (() => 'user_abc') as unknown as DesktopAuthService['userId'],
    token: jasmine.createSpy('token').and.resolveTo(DEVICE_TOKEN),
    restore: jasmine.createSpy('restore').and.resolveTo(),
  } as unknown as Partial<DesktopAuthService>;
}

/** The same service with nothing stored - the genuinely signed-out desktop. */
function signedOutDesktopAuth(): Partial<DesktopAuthService> {
  return {
    signedIn: (() => false) as unknown as DesktopAuthService['signedIn'],
    email: (() => null) as unknown as DesktopAuthService['email'],
    userId: (() => null) as unknown as DesktopAuthService['userId'],
    token: jasmine.createSpy('token').and.resolveTo(null),
    restore: jasmine.createSpy('restore').and.resolveTo(),
  } as unknown as Partial<DesktopAuthService>;
}

describe('BillingService on a desktop install (device token, no Clerk user)', () => {
  let previousUrl: string;

  beforeEach(() => {
    previousUrl = loadPhormaCloudUrl();
    savePhormaCloudUrl('https://cloud.example.com');
  });
  afterEach(() => savePhormaCloudUrl(previousUrl));

  function configure(desktop: Partial<DesktopAuthService>): BillingService {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: true } },
        { provide: ClerkService, useValue: desktopClerk() },
        { provide: DesktopAuthService, useValue: desktop },
      ],
    });
    return TestBed.inject(BillingService);
  }

  it('reports signed in from the device token alone', () => {
    // The regression: this was `clerk.user$ != null`, so it was false for every
    // signed-in desktop install and `sessionToken()` short-circuited to null.
    expect(configure(signedInDesktopAuth()).signedIn()).toBeTrue();
  });

  it('still reports signed out when no credential is held', () => {
    // The other side of the union - without this the gate is vacuous.
    expect(configure(signedOutDesktopAuth()).signedIn()).toBeFalse();
  });

  it('sends the device token as the bearer on a checkout', async () => {
    const billing = configure(signedInDesktopAuth());
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), {
        status: 200,
      }),
    );
    spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();

    const started = await billing.startCheckout('phorma_starter_monthly');

    expect(started).toBeTrue();
    const init = fetchSpy.calls.argsFor(0)[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it('makes no request at all when signed out', async () => {
    const billing = configure(signedOutDesktopAuth());
    const fetchSpy = spyOn(window, 'fetch');

    const started = await billing.startCheckout('phorma_starter_monthly');

    expect(started).toBeFalse();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not wait on Clerk to answer, because Clerk never will', async () => {
    // `session$` here has already emitted null, but the guard that matters is the
    // desktop branch returning BEFORE the Clerk path: a Clerk whose subjects never
    // replay would otherwise hold the checkout open for the whole timeout and pin
    // the button's busy state.
    const silentClerk = {
      user$: new ReplaySubject<unknown>(1),
      session$: new ReplaySubject<unknown>(1),
      clerk$: new ReplaySubject<unknown>(1),
    } as unknown as Partial<ClerkService>;
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: true } },
        { provide: ClerkService, useValue: silentClerk },
        { provide: DesktopAuthService, useValue: signedInDesktopAuth() },
      ],
    });
    const billing = TestBed.inject(BillingService);
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_1' }), {
        status: 200,
      }),
    );
    spyOn(TestBed.inject(McpOAuthService), 'openExternal').and.resolveTo();

    const opened = await billing.openBillingPortal();

    expect(opened).toBeTrue();
    const init = fetchSpy.calls.argsFor(0)[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${DEVICE_TOKEN}`,
    );
  });
});

/**
 * The deploy path. This half of the bug was the most silent of the four: with no
 * Clerk session and the `phorma` provider selected, `resolveAuthToken` returned
 * null by DESIGN (never send the static token to Phorma Cloud) and the request
 * simply went out unauthenticated. The hosted worker fails that closed, so the
 * user saw a deploy failure with nothing pointing at sign-in.
 */
describe('CloudService bearer on a desktop install', () => {
  function configure(desktop: Partial<DesktopAuthService>): CloudService {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: true } },
        { provide: ClerkService, useValue: desktopClerk() },
        { provide: DesktopAuthService, useValue: desktop },
      ],
    });
    const settings = TestBed.inject(SettingsService);
    settings.cloudProvider.set('phorma');
    return TestBed.inject(CloudService);
  }

  /**
   * The Authorization header on the `/status` request specifically.
   *
   * Selected by URL rather than by call index on purpose: other services in this
   * injector may issue their own requests, and an index would silently assert
   * against whichever one happened to go first.
   */
  function statusAuthHeader(spy: jasmine.Spy): string | undefined {
    const call = spy.calls
      .allArgs()
      .find(([url]) => String(url).includes('/status'));
    expect(call).withContext('no /status request was made').toBeDefined();
    const init = call?.[1] as RequestInit | undefined;
    return (init?.headers as Record<string, string> | undefined)?.['Authorization'];
  }

  it('sends the device token to Phorma Cloud', async () => {
    const cloud = configure(signedInDesktopAuth());
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ hasWorkflow: true, savedAt: null }), { status: 200 }),
    );

    await cloud.refreshStatus('wf-1');

    // The regression sent NO Authorization header at all, so assert on the value
    // rather than merely on the key being present.
    expect(statusAuthHeader(fetchSpy)).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it('sends no bearer when the install holds no credential', async () => {
    const cloud = configure(signedOutDesktopAuth());
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ hasWorkflow: true, savedAt: null }), { status: 200 }),
    );

    await cloud.refreshStatus('wf-1');

    // Phorma Cloud must never receive the static BYO token as a fallback.
    expect(statusAuthHeader(fetchSpy)).toBeUndefined();
  });
});
