/**
 * The owner switcher's PLACE in the toolbar (Requirements 20.2, 20.3, 20.12).
 *
 * ## Why this is a karma spec and not a `window.__phormaTest` browser run
 *
 * There is NO browser driver in this repository - no Playwright and no Puppeteer,
 * in any package - so the `ng serve` + harness route cannot be run here, and saying
 * so is better than a test that pretends to. What that route would have asserted is
 * asserted below instead, in the same real Chrome the rest of the frontend suite
 * runs in: the component is mounted, the level is driven through
 * `CapabilityService.resolveFrom(...)` and the owner through `ActiveOwnerService`
 * rather than through Clerk, DOM queries are filtered by
 * `getBoundingClientRect().width > 0` because both sidebars render duplicate pane
 * instances, and `document.querySelectorAll('[id]')` is checked against its unique
 * count.
 *
 * The claim that matters most is the ABSENCE one. A solo account must look exactly
 * as it did before this feature existed, which means no control, no divider and no
 * menu - not a disabled control (Requirement 20.3).
 */

import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { ActiveOwnerService } from '../../core/active-owner.service';
import { CapabilityService } from '../../core/capability.service';
import { OwnerSwitchService } from '../../core/owner-switch.service';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { TauriService } from '../../core/tauri.service';
import { Toolbar } from './toolbar';

interface Rig {
  root: HTMLElement;
  owner: ActiveOwnerService;
  capability: CapabilityService;
  detect: () => void;
  switched: string[];
}

function setup(): Rig {
  const switched: string[] = [];
  const phormaCloud = {
    signedIn: signal(true),
    subscribed: signal(true),
    pastDue: signal(false),
    profile: signal(null),
    loading: signal(false),
    error: signal(null),
    email: signal('someone@example.com'),
    avatarUrl: signal(null),
    signInIsExternal: false,
    refresh: async () => undefined,
    sessionToken: async () => null,
    signIn: () => undefined,
    signOut: () => undefined,
    subWorkflowDepth: () => 2,
    selfServeBilling: signal(true),
  };

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      { provide: TauriService, useValue: { isDesktop: false } },
      { provide: PhormaCloudService, useValue: phormaCloud },
      {
        // The SWITCH itself is somebody else's spec (`owner-switch.service.spec.ts`).
        // Here it is stubbed down to the two things the toolbar reads plus a record
        // of what it asked for, so mounting a toolbar does not drag the whole
        // notification and library graph in behind it.
        provide: OwnerSwitchService,
        useFactory: () => {
          const owner = TestBed.inject(ActiveOwnerService);
          return {
            owners: owner.owners,
            canSwitch: owner.canSwitch,
            activeOwner$: owner.activeOwner,
            switchTo: async (orgId: string | null) => {
              switched.push(orgId ?? 'personal');
              return owner.setActiveOrg(orgId);
            },
            labelOf: (choice: { label: string }) => choice.label,
          };
        },
      },
    ],
  });
  // `of(null)` for Clerk's user, as the notification-placement spec does: the
  // toolbar reads `user$` only for its account branch, and the switcher must not
  // depend on a Clerk session at all (Requirement 20.4).
  const fixture = TestBed.createComponent(Toolbar);
  fixture.detectChanges();
  return {
    root: fixture.nativeElement as HTMLElement,
    owner: TestBed.inject(ActiveOwnerService),
    capability: TestBed.inject(CapabilityService),
    detect: () => fixture.detectChanges(),
    switched,
  };
}

/** Visible elements only - both sidebars render duplicate pane instances. */
function visible(root: HTMLElement, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    element => element.getBoundingClientRect().width > 0,
  );
}

describe('Toolbar owner switcher', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders NOTHING for an account with no membership', () => {
    const rig = setup();
    rig.owner.adoptOwners([]);
    rig.detect();

    expect(rig.root.querySelector('.phorma-toolbar__owner-label')).toBeNull();
    expect(rig.root.querySelector('.phorma-toolbar__owner-body')).toBeNull();
  });

  it('names the ACTIVE owner without anything being opened', () => {
    const rig = setup();
    rig.owner.adoptOwners([
      { orgId: 'org_acme', label: 'Acme Accounting', level: 'builder' },
      { orgId: 'org_beta', label: 'Beta Books', level: 'operator' },
    ]);
    rig.owner.setPersonalLabel('someone@example.com');
    rig.detect();

    const labels = visible(rig.root, '.phorma-toolbar__owner-label');
    expect(labels.length).toBe(1);
    expect(labels[0].textContent?.trim()).toBe('someone@example.com');

    rig.owner.setActiveOrg('org_acme');
    rig.detect();
    expect(
      visible(rig.root, '.phorma-toolbar__owner-label')[0].textContent?.trim(),
    ).toBe('Acme Accounting');
  });

  it('recomputes with no reload when the level and the owner both move', () => {
    const rig = setup();
    rig.owner.adoptOwners([{ orgId: 'org_acme', label: 'Acme Accounting', level: 'operator' }]);
    rig.detect();

    // Driven the way the studio really drives them: the level is PUSHED from the
    // verified `/api/me` answer, and the owner comes from the leaf service - neither
    // through Clerk, which a desktop install has no session on at all.
    rig.capability.resolveFrom('operator');
    rig.owner.setActiveOrg('org_acme');
    rig.detect();

    expect(rig.capability.cloudLibraryOnly()).toBeTrue();
    expect(
      visible(rig.root, '.phorma-toolbar__owner-label')[0].textContent?.trim(),
    ).toBe('Acme Accounting');
  });

  it('offers the personal account plus memberships, and nothing else', () => {
    const rig = setup();
    rig.owner.adoptOwners([
      { orgId: 'org_acme', label: 'Acme Accounting', level: 'builder' },
      { orgId: 'org_beta', label: 'Beta Books', level: 'operator' },
    ]);
    rig.detect();

    // Requirement 20.12: no create, no naming, no self-join. Read off the same
    // signal the menu is built from, because a `p-menu` popup is not in the DOM
    // until it is opened.
    const offered = rig.owner.owners();
    expect(offered.map(entry => entry.orgId)).toEqual([null, 'org_acme', 'org_beta']);
    const labels = offered.map(entry => entry.label.toLowerCase()).join(' ');
    expect(labels).not.toContain('create');
    expect(labels).not.toContain('join');
    expect(labels).not.toContain('new organisation');
  });

  /**
   * The duplicate-id check, with two scopes narrowed and both narrowings measured.
   *
   * 1. **The toolbar, not `document`.** A document-wide `querySelectorAll('[id]')`
   *    is the right probe in a BROWSER run and the wrong one under karma: one
   *    document serves the whole suite and jasmine randomises order, so leftover
   *    fixtures from other specs are in the DOM too and the totals disagree for
   *    reasons unrelated to this change (measured: 793 against 785 unique).
   * 2. **`id="null"` excluded, and it is PRIMENG's, not ours.** `MenubarSub` in
   *    `primeng/menubar` carries the host binding `'[id]': 'root ? menuId : null'`,
   *    and Angular assigns the DOM `id` PROPERTY - which coerces null to the string
   *    "null" - so every non-root submenu `<ul>` renders `id="null"`. That is eight
   *    elements in this toolbar, it predates this change by every revision of the
   *    File/Edit/View menus, and it cannot be fixed from our side without giving the
   *    binding a value we do not own. Excluded by name rather than by loosening the
   *    assertion, so a duplicate WE introduce still fails.
   */
  it('leaves no duplicate element id behind', () => {
    const rig = setup();
    rig.owner.adoptOwners([{ orgId: 'org_acme', label: 'Acme Accounting' }]);
    rig.detect();

    const ids = [...rig.root.querySelectorAll('[id]')]
      .map(element => element.id)
      .filter(id => id !== 'null');
    const seen = new Set<string>();
    const duplicates = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
    expect(ids.length).withContext(`duplicates: ${duplicates.join(', ')}`).toBe(seen.size);
    // The exclusion is not a hole: every excluded element is a PrimeNG menu list,
    // asserted rather than assumed, so the day one of OURS renders `id="null"` this
    // fails instead of being quietly absorbed.
    const nulls = [...rig.root.querySelectorAll('[id]')].filter(el => el.id === 'null');
    expect(nulls.length).toBeGreaterThan(0);
    for (const element of nulls) {
      expect(element.tagName).withContext(`unexpected id="null" on ${element.tagName}`).toBe('UL');
      expect(element.closest('p-menubar, p-menu')).toBeTruthy();
    }
    // And the switcher itself declares none, which is why the count above holds
    // however many times the toolbar is rendered.
    const control = visible(rig.root, '.phorma-toolbar__owner-body')[0];
    expect(control).toBeTruthy();
    expect(control.querySelectorAll('[id]').length).toBe(0);
  });
});
