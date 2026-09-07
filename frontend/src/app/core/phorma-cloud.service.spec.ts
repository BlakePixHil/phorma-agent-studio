/**
 * `PhormaCloudService.signIn()` - which sign-in surface each platform gets.
 *
 * This is worth a suite because the two branches fail in opposite directions and
 * neither failure is visible by reading the file. Clerk's in-app modal CANNOT
 * complete in the Tauri webview against a production instance (the `__client`
 * cookie is `SameSite=Lax` on `clerk.phorma-labs.com` and the webview origin is
 * cross-site with it), so a desktop build that reaches `clerk.openSignIn` sends
 * the user to a dead-end `authorization_invalid` page served by Clerk. Meanwhile
 * a browser build that gets handed to `openExternal` would pop a second tab for
 * no reason and lose the modal that works there.
 *
 * So the assertions are deliberately two-sided: each platform must take its own
 * path AND must not take the other one. `signIn()` has no return value and
 * mutates nothing observable, so the negative half is the only thing standing
 * between a regression and a shipped dead end.
 *
 * The toast is asserted too, because it is the only place the studio admits that
 * finishing in the browser does not sign the desktop app in. Softening that copy
 * silently turns an honest limitation into a bug report.
 */

import { TestBed } from '@angular/core/testing';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import { CLERK_ACCOUNT_PORTAL_URL } from '../../environments/clerk';
import { ToastService } from '../shared/toast/toast.service';
import { McpOAuthService } from './mcp-oauth.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';

/**
 * A Clerk that has loaded and reports nobody signed in, so the constructor
 * effect never fires a `/api/me` refresh. `ReplaySubject(1)` matches the real
 * `ClerkService`, whose streams are replay subjects rather than `of()`.
 */
function signedOutClerk(): Partial<ClerkService> {
  const user$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  user$.next(null);
  session$.next(null);
  return { user$, session$, openSignIn: jasmine.createSpy('openSignIn') } as unknown as
    Partial<ClerkService>;
}

interface Harness {
  readonly cloud: PhormaCloudService;
  readonly openSignIn: jasmine.Spy;
  readonly openExternal: jasmine.Spy;
  readonly toast: ToastService;
}

function harness(options: { isDesktop: boolean; openFails?: boolean }): Harness {
  const clerk = signedOutClerk();
  TestBed.configureTestingModule({
    providers: [
      { provide: TauriService, useValue: { isDesktop: options.isDesktop } },
      { provide: ClerkService, useValue: clerk },
      // A leaf in the app, but there is no reason to let a real one run here.
      { provide: TelemetryService, useValue: { recordError: () => undefined } },
    ],
  });
  const openExternal = spyOn(TestBed.inject(McpOAuthService), 'openExternal');
  if (options.openFails) openExternal.and.rejectWith(new Error('no browser'));
  else openExternal.and.resolveTo();
  return {
    cloud: TestBed.inject(PhormaCloudService),
    openSignIn: clerk.openSignIn as unknown as jasmine.Spy,
    openExternal,
    toast: TestBed.inject(ToastService),
  };
}

describe('PhormaCloudService.signIn', () => {
  it('hands desktop sign-in to the system browser and never opens the in-app modal', async () => {
    const { cloud, openSignIn, openExternal, toast } = harness({ isDesktop: true });

    expect(cloud.signInIsExternal).toBe(true);

    cloud.signIn();
    // `openAccountPortal` is fire-and-forget, so let its promise settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(openExternal).toHaveBeenCalledOnceWith(`${CLERK_ACCOUNT_PORTAL_URL}/sign-up`);
    // The half that matters: reaching Clerk's modal here is the shipped dead end.
    expect(openSignIn).not.toHaveBeenCalled();

    // The user is told the desktop app will still look signed out, because it will.
    const entry = toast.entries().at(-1);
    expect(entry?.severity).toBe('warning');
    expect(entry?.detail).toContain('not available yet');
  });

  it('keeps the in-app modal in a browser build, pinned to this app URL', () => {
    const { cloud, openSignIn, openExternal } = harness({ isDesktop: false });

    expect(cloud.signInIsExternal).toBe(false);

    cloud.signIn();

    expect(openSignIn).toHaveBeenCalledOnceWith({ forceRedirectUrl: window.location.href });
    // A browser build must not spawn a second tab: the modal works here.
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens an https Clerk-hosted portal URL, never a bare host or a local one', () => {
    const url = new URL(`${CLERK_ACCOUNT_PORTAL_URL}/sign-up`);

    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/sign-up');
    // `accounts.<domain>` in production, `<slug>.accounts.dev` in development.
    // Either way it must be a Clerk portal host and never the webview's own origin.
    expect(url.host).not.toContain('tauri.localhost');
    expect(url.host).not.toContain('localhost');
  });

  it('surfaces the URL when the hand-off fails, so the user can still reach it', async () => {
    const { cloud, toast } = harness({ isDesktop: true, openFails: true });

    cloud.signIn();
    await Promise.resolve();
    await Promise.resolve();

    const entry = toast.entries().at(-1);
    expect(entry?.severity).toBe('error');
    expect(entry?.detail).toBe(`${CLERK_ACCOUNT_PORTAL_URL}/sign-up`);
  });
});
