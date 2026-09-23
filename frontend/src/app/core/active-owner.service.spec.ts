/**
 * `ActiveOwnerService`: which of the caller's owners the studio is working in.
 *
 * Three claims carry more weight than the rest here.
 *
 * - It is a DI LEAF, asserted from an injector holding nothing at all. That is the
 *   only way to state "injects nothing" as a test rather than as a comment;
 *   `scripts/check-capability-isolation.mjs` pins the import list statically and
 *   this pins the runtime half. The value is read ON the transport path and by
 *   `IndexedDbStorageService`, so an edge added here fails as a blank screen on
 *   startup rather than as a compile error.
 * - An account with NO membership is offered no switching surface at all
 *   (Requirement 20.3). That is the criterion the demo shows, and it is also what
 *   keeps a solo install byte-identical to the build before this feature.
 * - A switch is REVERSIBLE (Requirement 20.9). Driven as a property over a
 *   sequence of switches: the state after any sequence equals the state of a
 *   session that started at the final owner.
 *
 * **Validates: Requirements 20.1, 20.2, 20.3, 20.9, 20.11**
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import {
  ActiveOwnerService,
  PERSONAL_OWNER_LABEL,
  REQUESTED_OWNER_HEADER,
  shortOwnerLabel,
  type OwnerChoice,
} from './active-owner.service';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

/**
 * A freshly constructed service from an injector holding NOTHING.
 *
 * `providers: []` is the assertion, not an omission.
 */
function service(): ActiveOwnerService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [] });
  return TestBed.inject(ActiveOwnerService);
}

/** Organisation memberships as `/api/me` would have reported them. */
function memberships(ids: readonly string[]): OwnerChoice[] {
  return ids.map(id => ({ orgId: id, label: `Org ${id}`, level: 'builder' }));
}

/** Distinct organisation ids, in the shape Clerk mints. */
const orgIds = fc.uniqueArray(
  fc.integer({ min: 0, max: 9999 }).map((n: number) => `org_2ab${n}`),
  { minLength: 1, maxLength: 5 },
);

describe('ActiveOwnerService', () => {
  // ─── The startup state, and the solo account ──────────────────────────────

  it('starts on the personal account, which is also what null means', () => {
    const owner = service();

    expect(owner.activeOrgId()).toBeNull();
    expect(owner.requestedOrg()).toBeNull();
    expect(owner.storageOwner()).toBeNull();
    expect(owner.activeOwner().orgId).toBeNull();
    expect(owner.activeOwnerLabel()).toBe(PERSONAL_OWNER_LABEL);
  });

  it('offers NO switching surface to an account with no membership', () => {
    const owner = service();

    // Before any answer arrives, and after an answer reporting none - the two cases
    // an install with no organisation actually goes through.
    expect(owner.canSwitch()).toBeFalse();
    owner.adoptOwners([]);
    expect(owner.canSwitch()).toBeFalse();
    expect(owner.owners().length).toBe(1);
  });

  it('sends no owner header on the personal account, and one for an organisation', () => {
    const owner = service();

    expect(owner.ownerHeader()).toEqual({});

    owner.adoptOwners(memberships(['org_acme']));
    expect(owner.setActiveOrg('org_acme')).toBeTrue();
    expect(owner.ownerHeader()).toEqual({ [REQUESTED_OWNER_HEADER]: 'org_acme' });
  });

  // ─── What it refuses ──────────────────────────────────────────────────────

  it('refuses an organisation that is not on the list', () => {
    const owner = service();
    owner.adoptOwners(memberships(['org_acme']));

    expect(owner.setActiveOrg('org_elsewhere')).toBeFalse();
    expect(owner.activeOrgId()).toBeNull();
  });

  it('re-selecting the active owner changes nothing', () => {
    const owner = service();
    owner.adoptOwners(memberships(['org_acme']));
    owner.setActiveOrg('org_acme');

    expect(owner.setActiveOrg('org_acme')).toBeFalse();
    expect(owner.activeOrgId()).toBe('org_acme');
  });

  /**
   * Requirement 20.11: a revoked membership resolves as though it were never
   * named, so the studio must fall back to the personal account rather than keep
   * an organisation selected that nothing will resolve.
   */
  it('drops back to the personal account when the active membership disappears', () => {
    const owner = service();
    owner.adoptOwners(memberships(['org_acme', 'org_beta']));
    owner.setActiveOrg('org_acme');

    owner.adoptOwners(memberships(['org_beta']));

    expect(owner.activeOrgId()).toBeNull();
    expect(owner.canSwitch()).toBeTrue();
  });

  it('keeps the active owner when an unrelated membership is added', () => {
    const owner = service();
    owner.adoptOwners(memberships(['org_acme']));
    owner.setActiveOrg('org_acme');

    owner.adoptOwners(memberships(['org_acme', 'org_beta']));

    expect(owner.activeOrgId()).toBe('org_acme');
  });

  it('keeps the personal entry first and drops a duplicate or personal-shaped entry', () => {
    const owner = service();
    owner.adoptOwners([
      { orgId: null, label: 'not a membership' },
      { orgId: 'org_acme', label: 'Acme' },
      { orgId: 'org_acme', label: 'Acme again' },
    ]);

    expect(owner.owners().map(entry => entry.orgId)).toEqual([null, 'org_acme']);
    expect(owner.owners()[0].label).toBe(PERSONAL_OWNER_LABEL);
  });

  it('renames only the personal entry', () => {
    const owner = service();
    owner.adoptOwners(memberships(['org_acme']));
    owner.setPersonalLabel('someone@example.com');

    expect(owner.owners()[0].label).toBe('someone@example.com');
    expect(owner.owners()[1].label).toBe('Org org_acme');
  });

  it('labels an unnamed organisation by the entropy end of its id', () => {
    // The head of a Clerk id is a constant prefix, so a leading truncation would
    // render every organisation identically.
    expect(shortOwnerLabel('org_2abcdefghijkl')).toBe('Organisation ghijkl');
    expect(shortOwnerLabel('org_ab')).toBe('Organisation ab');
  });

  // ─── Property 40 (the local half) ─────────────────────────────────────────

  /**
   * Feature: multi-organisation-phorma, Property 40: An owner switch is a
   * complete, reversible change of scope.
   *
   * The half that lives in this service: for any sequence of switches across the
   * caller's available owners, the active owner, the header every transport sends
   * and the owner the local stores are scoped to all equal those of a session that
   * started at the final owner.
   *
   * Driven against a SECOND, independently constructed service rather than against
   * a transcribed expectation, so the oracle is the real startup path.
   */
  it('reaches the same state as a session that started at the final owner', () => {
    fc.assert(
      fc.property(orgIds, fc.array(fc.nat(), { minLength: 1, maxLength: 12 }), (ids, picks) => {
        const available: (string | null)[] = [null, ...ids];
        const switched = service();
        switched.adoptOwners(memberships(ids));

        let final: string | null = null;
        for (const pick of picks) {
          const target = available[pick % available.length];
          switched.setActiveOrg(target);
          final = target;
        }

        const fresh = service();
        fresh.adoptOwners(memberships(ids));
        fresh.setActiveOrg(final);

        expect(switched.activeOrgId()).toBe(fresh.activeOrgId());
        expect(switched.requestedOrg()).toBe(fresh.requestedOrg());
        expect(switched.storageOwner()).toBe(fresh.storageOwner());
        expect(switched.ownerHeader()).toEqual(fresh.ownerHeader());
        expect(switched.activeOwnerLabel()).toBe(fresh.activeOwnerLabel());
        expect(switched.owners().map(entry => entry.orgId)).toEqual(
          fresh.owners().map(entry => entry.orgId),
        );
      }),
      RUNS,
    );
  });

  /**
   * Feature: multi-organisation-phorma, Property 40: An owner switch is a
   * complete, reversible change of scope.
   *
   * The reversibility half, stated on its own because the sequence property above
   * would be satisfied by a service that simply remembered the last pick: after
   * ANY detour, returning to an owner reproduces the state held while it was
   * active, and the offered list never changes under a switch.
   */
  it('reproduces an owner\'s state when the caller switches back to it', () => {
    fc.assert(
      fc.property(orgIds, fc.array(fc.nat(), { maxLength: 8 }), (ids, detour) => {
        const available: (string | null)[] = [null, ...ids];
        const owner = service();
        owner.adoptOwners(memberships(ids));

        for (const start of available) {
          owner.setActiveOrg(start);
          const before = {
            active: owner.activeOrgId(),
            header: owner.ownerHeader(),
            storage: owner.storageOwner(),
            label: owner.activeOwnerLabel(),
            offered: owner.owners().map(entry => entry.orgId),
          };

          for (const pick of detour) owner.setActiveOrg(available[pick % available.length]);
          owner.setActiveOrg(start);

          expect(owner.activeOrgId()).toBe(before.active);
          expect(owner.ownerHeader()).toEqual(before.header);
          expect(owner.storageOwner()).toBe(before.storage);
          expect(owner.activeOwnerLabel()).toBe(before.label);
          expect(owner.owners().map(entry => entry.orgId)).toEqual(before.offered);
        }
      }),
      RUNS,
    );
  });

  /**
   * Feature: multi-organisation-phorma, Property 40: An owner switch is a
   * complete, reversible change of scope.
   *
   * The refusal half: no sequence of requests can make an owner active that the
   * list does not hold, so nothing downstream - a request header, a stamped local
   * row - can ever name an owner the worker will refuse to resolve.
   */
  it('never becomes active on an owner it was not offered', () => {
    fc.assert(
      fc.property(
        orgIds,
        fc.array(fc.oneof(fc.constant(null), fc.string({ maxLength: 12 })), { maxLength: 15 }),
        (ids, hostile) => {
          const owner = service();
          owner.adoptOwners(memberships(ids));
          const offered = new Set<string | null>([null, ...ids]);

          for (const attempt of hostile) {
            owner.setActiveOrg(attempt);
            expect(offered.has(owner.activeOrgId())).toBeTrue();
          }
        },
      ),
      RUNS,
    );
  });
});
