/**
 * `CapabilityService`: the studio's one holder of the resolved Capability_Level,
 * and the one seam that decides with it.
 *
 * Three claims are worth more than the rest, and each has bitten this repo in a
 * different shape:
 *
 * - The DEFAULT is `admin`, not a safe minimum. Every existing single-user and BYO
 *   install lands there and must behave exactly as it did before the feature
 *   existed (Requirement 5.10). A studio that started at `operator` would subtract
 *   builder surfaces for as long as `/api/me` took to answer.
 * - It is a DI LEAF. The service is asserted constructible from an injector holding
 *   nothing at all, which is the only way to state "injects nothing" as a test
 *   rather than as a comment. `scripts/check-capability-isolation.mjs` guards the
 *   import list statically; this pins the runtime half.
 * - A level change RECOMPUTES, with no reload (Requirement 7.7). Asserted through a
 *   `computed` that tracks the service, because "the method returns a new answer"
 *   would also hold for a plain field that no surface is watching.
 *
 * **Validates: Requirements 7.1, 7.2, 7.4, 7.7**
 */

import { Injector, computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { CAPABILITY_LEVELS, atLeast, capabilitiesOf, type CapabilityLevel } from './capabilities';
import { CapabilityService } from './capability.service';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

/** Every declared level, read from the contract rather than transcribed. */
const LEVELS = [...CAPABILITY_LEVELS];

/** The least capable declared level, derived rather than named. */
const LOWEST = LEVELS.find(candidate => LEVELS.every(other => atLeast(other, candidate)))!;

/** The most capable declared level, derived the same way. */
const HIGHEST = LEVELS.find(candidate => LEVELS.every(other => atLeast(candidate, other)))!;

/**
 * A freshly constructed service from the root injector.
 *
 * `resetTestingModule` first, because the properties below build one per iteration
 * and a second `configureTestingModule` against an instantiated module throws.
 * `providers: []` is the assertion, not an omission: the service resolves with
 * nothing supplied.
 */
function service(): CapabilityService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [] });
  return TestBed.inject(CapabilityService);
}

describe('CapabilityService', () => {
  // ─── The compatibility default ────────────────────────────────────────────

  it('starts at the most capable level, so an install with no organisation loses nothing', () => {
    const capability = service();

    expect(capability.level()).toBe('admin');
    // Stated twice on purpose: the token, because Requirement 5.10 names it, and
    // the consequence, because that is what an existing install actually relies on.
    expect(capability.level()).toBe(HIGHEST);
    for (const level of LEVELS) {
      expect(capability.atLeastLevel(level)).toBe(true);
    }
    for (const capabilityToken of capabilitiesOf('admin')) {
      expect(capability.can(capabilityToken)).toBe(true);
    }
  });

  it('holds no local library only below builder', () => {
    const capability = service();

    expect(capability.cloudLibraryOnly()).toBe(false);

    capability.resolveFrom('operator');
    expect(capability.cloudLibraryOnly()).toBe(true);

    capability.resolveFrom('editor');
    expect(capability.cloudLibraryOnly()).toBe(true);

    capability.resolveFrom('builder');
    expect(capability.cloudLibraryOnly()).toBe(false);

    capability.resolveFrom('admin');
    expect(capability.cloudLibraryOnly()).toBe(false);
  });

  // ─── The DI leaf claim ────────────────────────────────────────────────────

  it('constructs from an injector that provides nothing but itself', () => {
    // An empty injector with no parent: anything this service injected - Angular's
    // Router by way of ClerkService included - would throw here. That is the
    // runtime statement of Requirement 7.2, and the reason it matters is
    // PanelRegistryService, which injects this service and is read by the layout
    // shell at startup.
    const injector = Injector.create({
      providers: [{ provide: CapabilityService, useClass: CapabilityService, deps: [] }],
    });

    const capability = injector.get(CapabilityService);

    expect(capability.level()).toBe('admin');
    expect(capability.cloudLibraryOnly()).toBe(false);
    capability.resolveFrom('operator');
    expect(capability.cloudLibraryOnly()).toBe(true);
  });

  // ─── Resolution through the push seam ─────────────────────────────────────

  // Feature: multi-organisation-phorma, Property 16: A level change recomputes every derived surface
  it('answers every decision from the level it was last given', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const capability = service();

        capability.resolveFrom(level);

        expect(capability.level()).toBe(level);
        for (const required of LEVELS) {
          expect(capability.atLeastLevel(required)).toBe(atLeast(level, required));
          // `allows` with an explicit minimum is the same decision, so it must not
          // be a second implementation of it.
          expect(capability.allows(required)).toBe(atLeast(level, required));
        }
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 16: A level change recomputes every derived surface
  it('recomputes a derived surface on a level change, with no reload', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...LEVELS), { minLength: 1, maxLength: 8 }), sequence => {
        const capability = service();
        // A `computed` rather than a repeated method call: the requirement is that
        // a surface watching the service is recomputed, which a plain field would
        // fail while every direct call still passed.
        const derived = computed(() => capability.allows('builder'));

        for (const level of sequence) {
          capability.resolveFrom(level);
          expect(derived()).toBe(atLeast(level, 'builder'));
        }
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 16: A level change recomputes every derived surface
  it('changes nothing when the same level is applied twice', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), fc.integer({ min: 2, max: 6 }), (level, times) => {
        const capability = service();
        let recomputes = 0;
        const derived = computed(() => {
          recomputes += 1;
          return capability.level();
        });

        capability.resolveFrom(level);
        expect(derived()).toBe(level);
        const after = recomputes;

        for (let index = 1; index < times; index += 1) {
          capability.resolveFrom(level);
          expect(derived()).toBe(level);
        }

        // Idempotent in the strong sense: a repeat write is not even a recompute,
        // which is what stops a poll that re-reads `/api/me` from churning every
        // capability-derived surface in the studio.
        expect(recomputes).toBe(after);
      }),
      RUNS,
    );
  });

  // ─── The absent-minimum default ───────────────────────────────────────────

  // Feature: multi-organisation-phorma, Property 15: Capability filtering is exactly subtractive
  it('treats an absent declared minimum as the least capable level', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), level => {
        const capability = service();
        capability.resolveFrom(level);

        // Every declared level satisfies an absent minimum, which is what makes an
        // undeclared tab or action visible to everybody.
        expect(capability.allows()).toBe(true);
        expect(capability.allows(undefined)).toBe(true);
        expect(capability.allows()).toBe(capability.allows(LOWEST));
      }),
      RUNS,
    );
  });

  // ─── Fail closed ──────────────────────────────────────────────────────────

  it('fails closed on a level token this build does not know', () => {
    const capability = service();
    // A level arrives from the server. A caller validates with `isCapabilityLevel`
    // first, so reaching here needs a cast - and when it happens, every declared
    // minimum must SUBTRACT its surface rather than reveal it.
    capability.resolveFrom('superadmin' as CapabilityLevel);

    expect(capability.allows()).toBe(false);
    expect(capability.cloudLibraryOnly()).toBe(true);
    for (const level of LEVELS) {
      expect(capability.atLeastLevel(level)).toBe(false);
      expect(capability.allows(level)).toBe(false);
    }
    for (const capabilityToken of capabilitiesOf('admin')) {
      expect(capability.can(capabilityToken)).toBe(false);
    }
  });

  it('recovers from an unknown token when a known one arrives', () => {
    const capability = service();

    capability.resolveFrom('not-a-level' as CapabilityLevel);
    expect(capability.allows()).toBe(false);

    capability.resolveFrom('operator');
    expect(capability.allows()).toBe(true);
    expect(capability.atLeastLevel('builder')).toBe(false);
  });
});
