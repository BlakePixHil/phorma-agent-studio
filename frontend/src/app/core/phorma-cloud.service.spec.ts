/**
 * `PhormaCloudService` where the desktop credential meets the Clerk one.
 *
 * Three things here are worth a suite, and none of them is visible by reading the
 * file:
 *
 * 1. **Which sign-in each platform gets.** The two branches fail in opposite
 *    directions. A desktop build that reaches `clerk.openSignIn` sends the user to
 *    Clerk's `authorization_invalid` dead end, because the webview cannot hold the
 *    `SameSite=Lax` `__client` cookie a production instance needs. A browser build
 *    handed to the device handoff would try to open a second window for a flow that
 *    already works in-page. So every assertion is two-sided: each platform must take
 *    its own path AND must not take the other one.
 *
 * 2. **`sessionToken()` is the seam.** `ModelTransportService`, `BillingService` and
 *    `refresh()` all authenticate through it, and none of them was edited when
 *    desktop stopped carrying a Clerk session. If this returns the wrong credential
 *    for a platform, hosted inference and billing break together and nothing about
 *    sign-in looks wrong.
 *
 * 3. **`signedIn()` is a union.** Every gate in the studio reads it. On desktop the
 *    Clerk user is permanently null, so a regression that reads only Clerk makes a
 *    signed-in desktop user look signed out - which reads as a billing bug, not an
 *    auth one.
 */

import { TestBed } from '@angular/core/testing';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import { ToastService } from '../shared/toast/toast.service';
import {
  DesktopAuthService,
  subjectOf,
  type DesktopAuthFailure,
  type DesktopAuthState,
} from './desktop-auth.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { savePhormaCloudUrl } from './phorma-cloud-url';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';
import { TerminalOutputService } from './terminal-output.service';

/** A Clerk that has loaded and reports nobody signed in. */
function clerkStub(options: { user?: unknown; token?: string } = {}): Partial<ClerkService> {
  const user$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  const clerk$ = new ReplaySubject<unknown>(1);
  user$.next(options.user ?? null);
  session$.next(options.token ? { getToken: async () => options.token } : null);
  clerk$.next({ signOut: jasmine.createSpy('clerkSignOut') });
  return {
    user$,
    session$,
    clerk$,
    openSignIn: jasmine.createSpy('openSignIn'),
  } as unknown as Partial<ClerkService>;
}

interface DesktopStub {
  begin: jasmine.Spy;
  cancel: jasmine.Spy;
  signOut: jasmine.Spy;
  restore: jasmine.Spy;
  token: jasmine.Spy;
  state: () => DesktopAuthState;
  failure: () => DesktopAuthFailure | null;
  signedIn: () => boolean;
  email: () => string | null;
  imageUrl: () => string | null;
  userId: () => string | null;
  pendingUrl: () => string | null;
  handoff: () => 'browser' | 'manual';
  lastErrorDetail: () => string | null;
}

function desktopStub(
  options: {
    signedIn?: boolean;
    email?: string | null;
    /** Avatar the handoff supplied, if any. Display only, like the email. */
    imageUrl?: string | null;
    token?: string | null;
    beginResult?: boolean;
    failure?: DesktopAuthFailure | null;
    /** Detail the service recorded about the failure, for the console line. */
    errorDetail?: string | null;
    /**
     * When set, `begin` invokes its manual-handoff callback with this URL - what
     * happens when the system browser could not be launched.
     */
    manualUrl?: string;
  } = {},
): DesktopStub {
  return {
    begin: jasmine
      .createSpy('begin')
      .and.callFake(async (onManual?: (url: string) => void) => {
        if (options.manualUrl) onManual?.(options.manualUrl);
        return options.beginResult ?? false;
      }),
    pendingUrl: () => options.manualUrl ?? null,
    handoff: () => (options.manualUrl ? 'manual' : 'browser'),
    lastErrorDetail: () => options.errorDetail ?? null,
    cancel: jasmine.createSpy('cancel'),
    signOut: jasmine.createSpy('signOut').and.resolveTo(),
    restore: jasmine.createSpy('restore').and.resolveTo(),
    token: jasmine.createSpy('token').and.resolveTo(options.token ?? null),
    state: () => (options.signedIn ? 'signed-in' : 'signed-out'),
    failure: () => options.failure ?? null,
    signedIn: () => options.signedIn ?? false,
    email: () => options.email ?? null,
    imageUrl: () => options.imageUrl ?? null,
    userId: () => null,
  };
}

interface Harness {
  cloud: PhormaCloudService;
  clerk: Partial<ClerkService>;
  desktop: DesktopStub;
  toast: ToastService;
}

function harness(options: {
  isDesktop: boolean;
  clerk?: Partial<ClerkService>;
  desktop?: DesktopStub;
}): Harness {
  const clerk = options.clerk ?? clerkStub();
  const desktop = options.desktop ?? desktopStub();
  TestBed.configureTestingModule({
    providers: [
      { provide: TauriService, useValue: { isDesktop: options.isDesktop } },
      { provide: ClerkService, useValue: clerk },
      { provide: DesktopAuthService, useValue: desktop },
      { provide: TelemetryService, useValue: { recordError: () => undefined } },
    ],
  });
  // `refresh()` would otherwise reach the network the moment `signedIn()` flips.
  spyOn(window, 'fetch').and.resolveTo(new Response('{}', { status: 200 }));
  return {
    cloud: TestBed.inject(PhormaCloudService),
    clerk,
    desktop,
    toast: TestBed.inject(ToastService),
  };
}

const openSignInOf = (clerk: Partial<ClerkService>): jasmine.Spy =>
  clerk.openSignIn as unknown as jasmine.Spy;

/**
 * Telling a failed BROWSER LAUNCH apart from a failed REQUEST.
 *
 * These were one `'unreachable'` failure, and collapsing them cost real debugging
 * time: a `plugin-opener` problem produced "Could not reach Phorma Cloud - check
 * your connection", which is not only unhelpful but false, and it ABANDONED a
 * one-time code that was minted, registered and valid for another two minutes.
 *
 * So there are two claims here. A launch failure must keep the sign-in alive and
 * hand the user the URL; a request failure must stay the connection error it always
 * was. And in both cases the real cause has to reach the Problems console, because
 * every `catch` on this path used to discard it.
 */
describe('PhormaCloudService desktop sign-in diagnostics', () => {
  const SIGN_IN_URL = 'https://cloud.phorma-labs.com/auth/device?c=abc123';

  it('offers the URL when the browser could not be launched, and keeps going', async () => {
    const desktop = desktopStub({
      manualUrl: SIGN_IN_URL,
      errorDetail: 'Could not open the browser: opener.open_url not allowed',
      // The poll still runs and can still succeed - a launch failure is not a
      // sign-in failure.
      beginResult: true,
      email: 'owner@example.com',
    });
    const { cloud, toast } = harness({ isDesktop: true, desktop });

    cloud.signIn();
    await Promise.resolve();
    await Promise.resolve();

    const entries = toast.entries();
    const offer = entries.find(entry => entry.summary === 'Open the sign-in page yourself');
    expect(offer).withContext(JSON.stringify(entries.map(e => e.summary))).toBeTruthy();
    // The URL itself, not a paraphrase - it is the only way forward.
    expect(offer!.detail).toContain(SIGN_IN_URL);
    // And it must NOT be the connection error, which is what shipped.
    expect(entries.some(entry => entry.summary === 'Could not reach Phorma Cloud')).toBe(false);
  });

  it('puts the real cause and the URL in the Problems console', async () => {
    const desktop = desktopStub({
      manualUrl: SIGN_IN_URL,
      errorDetail: 'Could not open the browser: opener.open_url not allowed',
      beginResult: true,
    });
    harness({ isDesktop: true, desktop }).cloud.signIn();
    await Promise.resolve();
    await Promise.resolve();

    const problems = TestBed.inject(TerminalOutputService)
      .entries()
      .filter(entry => entry.channel === 'problems')
      .map(entry => entry.message);

    // A toast cannot usefully carry an exception message; the console can, and it
    // is where somebody looks a minute later.
    expect(problems.some(message => message.includes('opener.open_url not allowed'))).toBe(true);
    expect(problems.some(message => message.includes(SIGN_IN_URL))).toBe(true);
  });

  it('still reports a genuine request failure as a connection problem', async () => {
    const desktop = desktopStub({
      failure: 'unreachable',
      errorDetail: 'https://cloud.phorma-labs.com/api/auth/device/start: Failed to fetch',
    });
    const { cloud, toast } = harness({ isDesktop: true, desktop });

    cloud.signIn();
    await Promise.resolve();
    await Promise.resolve();

    // `unreachable` now means ONLY "the request got no answer", so this copy is
    // finally true whenever it appears.
    const entry = toast.entries().find(item => item.summary === 'Could not reach Phorma Cloud');
    expect(entry).toBeTruthy();
    expect(
      TestBed.inject(TerminalOutputService)
        .entries()
        .some(item => item.message.includes('Failed to fetch')),
    ).toBe(true);
  });

  it('names the endpoint it could not reach', async () => {
    // The endpoint is an overridable per-origin setting, so a stale value fails on
    // one machine and works on another. Telling somebody to "check your connection"
    // when the app is quietly addressing a dead `wrangler dev` URL is the wrong
    // advice, and naming the host is what makes the two distinguishable on sight.
    savePhormaCloudUrl('http://localhost:8787');
    try {
      const desktop = desktopStub({ failure: 'unreachable' });
      const { cloud, toast } = harness({ isDesktop: true, desktop });

      cloud.signIn();
      await Promise.resolve();
      await Promise.resolve();

      const entry = toast.entries().find(item => item.summary === 'Could not reach Phorma Cloud');
      expect(entry!.detail).toContain('http://localhost:8787');
      expect(entry!.detail).toContain('Settings');
    } finally {
      savePhormaCloudUrl('');
    }
  });

  it('says nothing extra when the browser opened normally', async () => {
    const desktop = desktopStub({ beginResult: true, email: 'owner@example.com' });
    const { cloud, toast } = harness({ isDesktop: true, desktop });

    cloud.signIn();
    await Promise.resolve();
    await Promise.resolve();

    expect(toast.entries().map(entry => entry.summary)).toEqual(['Signed in']);
  });
});

describe('PhormaCloudService sign-in routing', () => {
  it('runs the browser handoff on desktop and never opens the in-app modal', async () => {
    const desktop = desktopStub({ beginResult: true, email: 'owner@example.com' });
    const { cloud, clerk } = harness({ isDesktop: true, desktop });

    expect(cloud.signInIsExternal).toBe(true);

    cloud.signIn();
    await Promise.resolve();

    expect(desktop.begin).toHaveBeenCalledTimes(1);
    // The half that matters: reaching Clerk's modal here is the shipped dead end.
    expect(openSignInOf(clerk)).not.toHaveBeenCalled();
  });

  it('keeps the in-app modal in a browser build, pinned to this app URL', () => {
    const desktop = desktopStub();
    const { cloud, clerk } = harness({ isDesktop: false, desktop });

    expect(cloud.signInIsExternal).toBe(false);

    cloud.signIn();

    expect(openSignInOf(clerk)).toHaveBeenCalledOnceWith({
      forceRedirectUrl: window.location.href,
    });
    // A browser build must not spawn a handoff: the modal works here.
    expect(desktop.begin).not.toHaveBeenCalled();
  });

  it('adopts a credential from a previous session at construction', () => {
    const desktop = desktopStub();
    harness({ isDesktop: true, desktop });

    // Without this, a desktop user who signed in last week starts signed out and
    // every gated surface reads `subscribed()` as false.
    expect(desktop.restore).toHaveBeenCalledTimes(1);
  });
});

describe('PhormaCloudService credential seam', () => {
  it('hands out the device token on desktop', async () => {
    const desktop = desktopStub({ signedIn: true, token: 'phd_desktop_token' });
    const { cloud } = harness({ isDesktop: true, desktop });

    await expectAsync(cloud.sessionToken()).toBeResolvedTo('phd_desktop_token');
  });

  it('hands out the Clerk JWT in a browser build', async () => {
    const { cloud } = harness({
      isDesktop: false,
      clerk: clerkStub({ user: { id: 'user_browser' }, token: 'clerk.jwt.value' }),
    });

    await expectAsync(cloud.sessionToken()).toBeResolvedTo('clerk.jwt.value');
  });

  it('returns null rather than a stale credential when signed out', async () => {
    const { cloud } = harness({ isDesktop: false });

    await expectAsync(cloud.sessionToken()).toBeResolvedTo(null);
  });

  it('treats a desktop credential as signed in with no Clerk user present', () => {
    const desktop = desktopStub({ signedIn: true, email: 'owner@example.com' });
    const { cloud } = harness({ isDesktop: true, desktop });

    // Clerk is permanently null on desktop, so a gate reading only Clerk would
    // report a paying user as signed out.
    expect(cloud.user()).toBeNull();
    expect(cloud.signedIn()).toBe(true);
    expect(cloud.email()).toBe('owner@example.com');
  });

  it('renders an account with no address rather than treating null as signed out', () => {
    const desktop = desktopStub({ signedIn: true, email: null });
    const { cloud } = harness({ isDesktop: true, desktop });

    // A brand new account has no tenant row, so there may be no address anywhere.
    expect(cloud.signedIn()).toBe(true);
    expect(cloud.email()).toBeNull();
  });

  it('surfaces the handoff avatar on desktop, where Clerk supplies none', () => {
    const desktop = desktopStub({
      signedIn: true,
      imageUrl: 'https://img.clerk.com/abc?width=64&height=64&fit=crop&quality=85',
    });
    const { cloud } = harness({ isDesktop: true, desktop });

    // A provider photo (Google, say) reaches a device-token install only through
    // the sign-in handoff - there is no Clerk user here to read one from.
    expect(cloud.avatarUrl()).toBe(
      'https://img.clerk.com/abc?width=64&height=64&fit=crop&quality=85',
    );
  });

  it('reports no avatar when the account has no photo', () => {
    const desktop = desktopStub({ signedIn: true, email: 'owner@example.com' });
    const { cloud } = harness({ isDesktop: true, desktop });

    // Null is ordinary, not a failure: callers fall back to the account initial
    // rather than to Clerk's generated placeholder.
    expect(cloud.avatarUrl()).toBeNull();
  });

  it('scales a Clerk avatar through the image CDN rather than fetching the original', () => {
    const clerk = clerkStub({
      user: { hasImage: true, imageUrl: 'https://img.clerk.com/xyz' },
    });
    const { cloud } = harness({ isDesktop: false, clerk });

    expect(cloud.avatarUrl()).toBe(
      'https://img.clerk.com/xyz?width=64&height=64&fit=crop&quality=85',
    );
  });

  it('ignores a Clerk user with no image of their own', () => {
    const clerk = clerkStub({
      user: { hasImage: false, imageUrl: 'https://img.clerk.com/generated-placeholder' },
    });
    const { cloud } = harness({ isDesktop: false, clerk });

    // `hasImage` false means Clerk would hand back a generated placeholder. Ours
    // is the better one, so this must read as "no photo".
    expect(cloud.avatarUrl()).toBeNull();
  });

  it('clears both credentials on sign-out regardless of platform', async () => {
    const desktop = desktopStub({ signedIn: true, token: 'phd_x' });
    const { cloud, desktop: stub } = harness({ isDesktop: false, desktop });

    await cloud.signOut();

    // Not gated on `isDesktop`: a sign-out that consulted it would leave a stale
    // credential behind on any build where that assumption was ever wrong.
    expect(stub.signOut).toHaveBeenCalledTimes(1);
    expect(cloud.profile()).toBeNull();
  });
});

describe('PhormaCloudService handoff outcomes', () => {
  /** Runs `signIn()` on desktop and lets the async chain settle. */
  async function attempt(desktop: DesktopStub): Promise<ToastService> {
    const { cloud, toast } = harness({ isDesktop: true, desktop });
    cloud.signIn();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return toast;
  }

  it('says nothing when the user cancelled on purpose', async () => {
    const toast = await attempt(desktopStub({ beginResult: false, failure: 'cancelled' }));

    expect(toast.entries().length).toBe(0);
  });

  // An abandoned sign-in and a refused one are split across two specs rather than
  // asserted in one: `harness()` configures the TestBed, which cannot be
  // reconfigured once instantiated.
  it('reports an abandoned sign-in as a warning, not an error', async () => {
    const toast = await attempt(desktopStub({ beginResult: false, failure: 'timed-out' }));
    const entry = toast.entries().at(-1);

    // Not an error: this is simply what a user walking away looks like.
    expect(entry?.severity).toBe('warning');
    expect(entry?.summary).toContain('not completed');
  });

  it('reports a refusal as an error', async () => {
    const toast = await attempt(desktopStub({ beginResult: false, failure: 'refused' }));
    const entry = toast.entries().at(-1);

    expect(entry?.severity).toBe('error');
    expect(entry?.summary).toContain('refused');
  });

  it('distinguishes an unreachable worker from a refusal, and promises no change', async () => {
    const toast = await attempt(desktopStub({ beginResult: false, failure: 'unreachable' }));
    const entry = toast.entries().at(-1);

    expect(entry?.severity).toBe('error');
    expect(entry?.summary).toContain('Could not reach');
    expect(entry?.detail).toContain('Nothing was changed');
  });

  it('confirms success', async () => {
    const toast = await attempt(
      desktopStub({ beginResult: true, signedIn: true, email: 'owner@example.com' }),
    );
    const entry = toast.entries().at(-1);

    expect(entry?.severity).toBe('success');
    expect(entry?.detail).toBe('owner@example.com');
  });
});

describe('subjectOf', () => {
  /** Builds a token payload the way the worker encodes it. */
  const token = (payload: unknown): string => {
    const json = JSON.stringify(payload);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `phd_${b64}.signature-not-checked-here`;
  };

  it('reads the sub out of a device token', () => {
    expect(subjectOf(token({ s: 'user_abc', e: 1, v: 1 }))).toBe('user_abc');
  });

  it('returns null for anything it cannot read, rather than throwing', () => {
    // Reached during startup with whatever is in the keychain, so a throw here
    // would take the whole service down rather than report a signed-out state.
    for (const bad of ['', 'phd_', 'phd_!!!.sig', 'phd_' + btoa('{}') + '.sig', 'nonsense']) {
      expect(subjectOf(bad)).withContext(bad).toBeNull();
    }
  });

  it('does not require a valid signature, because the worker checks it', () => {
    // Decoding without verifying is safe: the worker verifies every request, so a
    // tampered payload only mislabels the account card on the attacker's own machine.
    expect(subjectOf(token({ s: 'user_xyz', v: 1 }))).toBe('user_xyz');
  });
});
