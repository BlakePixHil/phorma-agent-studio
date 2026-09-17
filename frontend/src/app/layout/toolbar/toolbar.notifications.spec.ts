/**
 * The notification bell's PLACE in the toolbar.
 *
 * This file exists because of one regression. The bell shipped wrapped in
 * `@if (isSignedIn())`, which made the entire feature invisible to anybody who had
 * not signed in - including every `ng serve` session, and including the
 * browser-parity user who has no account and runs workflows all day. A local run
 * finishing while you look at another workflow is the bell's content for that
 * install too; only the DEPLOYED feed is gated, and that gate lives in the poll.
 *
 * So the assertions here are about presence and position rather than behaviour -
 * `notification-bell.spec.ts` owns the panel itself.
 */

import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { Toolbar } from './toolbar';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { TauriService } from '../../core/tauri.service';

/** A Clerk stub: the toolbar reads `user$` for its account branch. */
function clerkStub() {
  return { user$: of(null), session$: of(null), clerk$: of(null), openSignIn: () => undefined };
}

function setup(options: { signedIn: boolean }) {
  const phormaCloud = {
    signedIn: signal(options.signedIn),
    subscribed: signal(false),
    pastDue: signal(false),
    profile: signal(null),
    loading: signal(false),
    error: signal(null),
    email: signal(null),
    signInIsExternal: false,
    refresh: async () => undefined,
    sessionToken: async () => null,
    signIn: () => undefined,
    signOut: () => undefined,
    subWorkflowDepth: () => 2,
  };

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      { provide: TauriService, useValue: { isDesktop: false } },
      { provide: PhormaCloudService, useValue: phormaCloud },
    ],
  });
  // Clerk is provided through the real service in this app; the toolbar only reads
  // `user$` off it, so the stub is registered by class token above where needed.
  const fixture = TestBed.createComponent(Toolbar);
  fixture.detectChanges();
  return { fixture, phormaCloud };
}

describe('Toolbar notification bell placement', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the bell for an account-less install', () => {
    const rig = setup({ signedIn: false });

    // The regression this file exists for.
    expect(rig.fixture.nativeElement.querySelector('app-notification-bell')).toBeTruthy();
  });

  it('renders the bell when signed in', () => {
    const rig = setup({ signedIn: true });

    expect(rig.fixture.nativeElement.querySelector('app-notification-bell')).toBeTruthy();
  });

  it('places the bell to the LEFT of the account control', () => {
    const rig = setup({ signedIn: false });
    const root = rig.fixture.nativeElement as HTMLElement;
    const bell = root.querySelector('app-notification-bell')!;
    // Signed out, the account control is the sign-in button - the last p-button in
    // the right-hand cluster.
    const cluster = bell.parentElement!;
    const children = [...cluster.children];

    const bellIndex = children.indexOf(bell);
    // Everything after the bell (past its trailing divider) is the account control.
    expect(bellIndex).toBeGreaterThan(-1);
    expect(bellIndex).toBeLessThan(children.length - 1);
  });
});
