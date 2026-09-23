/**
 * The one place the studio holds the caller's resolved Capability_Level, and the
 * one place a capability decision is made (Requirements 7.1, 7.4).
 *
 * ## Why this file injects NOTHING
 *
 * `PanelRegistryService` injects this service, and the layout shell reads that
 * registry at startup - so anything reachable from here is constructed while the
 * app's first frame is being built. The known NG0200 cycle is
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`, and an import added here does not fail
 * the build: it fails at runtime, in a user's app, as a blank screen on startup.
 * `scripts/check-capability-isolation.mjs` therefore pins this file's import list
 * to `@angular/core` and `./capabilities`, both leaves (Requirement 7.2).
 *
 * The design sketch for this service showed `ClerkService` as a single permitted
 * injection. It is deliberately absent, for two reasons that only surfaced against
 * the real code:
 *
 * - It would have nothing to do. The level does NOT come from Clerk; it is PUSHED
 *   through {@link CapabilityService.resolveFrom} by whoever holds the verified
 *   `/api/me` answer (see below). A Clerk read here would also be WRONG on
 *   desktop, where `user$` emits `null` for a genuinely signed-in install - the
 *   trap `desktop-credential-gates.spec.ts` exists to keep closed.
 * - `ngx-clerk`'s `ClerkService` injects `Router`. Pulling it in would put the
 *   router inside the injector path of `PanelRegistryService`, which several
 *   existing specs construct with no routing providers at all.
 *
 * So the isolation is stronger than the sketch asked for rather than weaker, and
 * an unused injection is exactly what the guard's pruning rule exists to catch.
 *
 * ## Why the level is pushed rather than fetched
 *
 * `PhormaCloudService` already holds the verified `/api/me` answer, and it sits ON
 * the cycle above - so it calls `resolveFrom(level)` rather than being injected
 * here. Same settable-seam idiom as `RunControllerService.remoteApprovalSender`
 * and `NotificationCenterService.deepLinkHandler`, and it makes Requirement 7.7
 * ("recompute every capability-derived surface with no page reload") a single
 * signal write that every `computed` downstream already tracks.
 *
 * ## Why the default is the MOST capable level
 *
 * `admin`, matching the worker's Requirement 5.10 default: a credential carrying
 * no organisation claim resolves `admin` over its own owner. An install with no
 * organisation therefore has every capability it had before this feature existed,
 * and no surface flickers into a restricted shape on startup while `/api/me` is
 * in flight. An older worker that omits the field leaves the studio here, which is
 * today's behaviour.
 */

import { Injectable, computed, signal } from '@angular/core';

import { atLeast, holds, type Capability, type CapabilityLevel } from './capabilities';

/**
 * Where a session starts, before any server answer arrives.
 *
 * See the file header: this is the compatibility default, not a safe minimum.
 * Fail-closed belongs on the WORKER, which refuses `role_unknown` rather than
 * substituting a level; a studio that started at `operator` would subtract every
 * builder surface from every existing single-user install for as long as `/api/me`
 * took to answer.
 */
const DEFAULT_LEVEL: CapabilityLevel = 'admin';

/**
 * What an ABSENT declared minimum means.
 *
 * Applied inside this module on purpose. `?? 'operator'` at a call site would be a
 * `CapabilityLevel` literal in a default position outside the capability module,
 * which Requirement 7.4 forbids and `scripts/check-capability-isolation.mjs` fails
 * on - and it would be the same decision, written once per call site, free to
 * drift. Every subtractive filter in the studio goes through
 * {@link CapabilityService.allows} instead.
 */
const ABSENT_MINIMUM_LEVEL: CapabilityLevel = 'operator';

@Injectable({ providedIn: 'root' })
export class CapabilityService {
  private readonly levelState = signal<CapabilityLevel>(DEFAULT_LEVEL);

  /** The resolved Capability_Level for this session. */
  readonly level = this.levelState.asReadonly();

  /**
   * Adopt the level the server resolved.
   *
   * Typed narrowly on purpose: a level arrives as JSON, so the caller validates it
   * with `isCapabilityLevel` from `./capabilities` first. That is a function call
   * rather than a token comparison, so it stays legal outside this module. A token
   * this build does not know, reaching here through a cast, fails CLOSED - `atLeast`
   * treats an unknown level as holding nothing, so every declared minimum subtracts
   * its surface instead of revealing it.
   *
   * Setting the level it already holds notifies nothing: a signal compares by
   * identity, so applying the same level twice recomputes no surface.
   */
  resolveFrom(level: CapabilityLevel): void {
    this.levelState.set(level);
  }

  /** True when this session holds `capability`. */
  can(capability: Capability): boolean {
    return holds(this.levelState(), capability);
  }

  /** True when this session's level holds every capability of `required`. */
  atLeastLevel(required: CapabilityLevel): boolean {
    return atLeast(this.levelState(), required);
  }

  /**
   * True when this session satisfies an OPTIONAL declared minimum.
   *
   * The one seam every subtractive filter in the studio goes through: the
   * `DEFAULT_TABS` entries in `PanelRegistryService`, and the action entries in
   * `core/studio-actions/`. An absent minimum reads as
   * {@link ABSENT_MINIMUM_LEVEL}, applied here rather than at the call site.
   */
  allows(minLevel?: CapabilityLevel): boolean {
    return this.atLeastLevel(minLevel ?? ABSENT_MINIMUM_LEVEL);
  }

  /**
   * True when this session has no local library and works out of the cloud only.
   *
   * Derived from the level rather than stored beside it, so it recomputes on the
   * same single signal write every other capability-derived surface does.
   */
  readonly cloudLibraryOnly = computed(() => !this.atLeastLevel('builder'));
}
