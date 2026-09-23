/**
 * Which of the caller's owners the studio is working in (Requirement 20).
 *
 * ## Why this file injects NOTHING
 *
 * The same reason `CapabilityService` injects nothing, and it is the stronger case
 * of the two: the active owner is read ON THE TRANSPORT PATH. Every Phorma Cloud
 * request attaches `X-Phorma-Owner` beside its bearer, and the seams that do it -
 * `PhormaCloudService.sessionToken()`'s callers, `dispatchCloudOperation`,
 * `BillingService` - sit on or under the known NG0200 cycle
 * (`RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`). `IndexedDbStorageService` reads it too,
 * and that service is injected by almost everything.
 *
 * So there is no `CloudService`, no `PhormaCloudService`, no `WorkflowService` and
 * no transport of any kind here. The owner list is PUSHED in by whoever already
 * holds the verified `/api/me` answer, exactly as the capability level is
 * (`CapabilityService.resolveFrom`), and the SWITCH is performed by
 * `OwnerSwitchService`, which components inject and which is free to reach the
 * services this one may not. `scripts/check-capability-isolation.mjs` pins this
 * file's import list alongside `capability.service.ts`, so an import added here
 * fails a guard rather than failing at runtime as a blank screen on startup.
 *
 * ## Why `null` is the personal account
 *
 * Not a sentinel for "unknown": the personal account is where every session
 * starts and where an account with no membership permanently stays
 * (Requirement 1.12), so it is the ORDINARY value. It is also what a local row
 * written before this feature existed reads as (Requirement 20.15), and what
 * {@link requestedOrg} answers when there is no organisation to name - which is
 * how a request from a solo install stays byte-identical to the one it sent
 * before this service existed.
 */

import { Injectable, computed, signal } from '@angular/core';

/**
 * One owner the caller may work in.
 *
 * `orgId: null` IS the personal account, so the list the switcher renders is
 * `[personal, ...memberships]` rather than "the special one plus the real ones".
 *
 * `level` is the capability level held IN that owner, and it is a plain `string`
 * on purpose: it arrives as JSON from a worker that may be newer than this build,
 * and nothing here decides with it. The level that is in force is the one
 * `CapabilityService` holds, pushed from the same `/api/me` answer.
 */
export interface OwnerChoice {
  orgId: string | null;
  label: string;
  level?: string;
}

/** The request header a member uses to name their OWN organisation. */
export const REQUESTED_OWNER_HEADER = 'X-Phorma-Owner';

/**
 * What the personal account is called wherever an owner is named. Deliberately
 * one plain word beside organisation names, never the account email.
 */
export const PERSONAL_OWNER_LABEL = 'Personal';

/**
 * A readable label for an organisation id with no name attached.
 *
 * `org_2abcDEF...` is a legible identity and a terrible label, so the tail is
 * kept: a Clerk id's entropy is at the end, and the head is the constant prefix.
 * Used only when nothing better is available - a browser session carries the real
 * names on `user.organizationMemberships`.
 */
export function shortOwnerLabel(orgId: string): string {
  const tail = orgId.replace(/^org_/, '');
  return tail.length <= 8 ? `Organisation ${tail}` : `Organisation ${tail.slice(-6)}`;
}

@Injectable({ providedIn: 'root' })
export class ActiveOwnerService {
  /**
   * The organisation the studio is working in, or null for the personal account.
   *
   * Session state, deliberately not persisted. A restart resolving the personal
   * account is the honest default: the worker re-confirms membership on every
   * request (Requirement 20.10), so a persisted organisation could only ever be a
   * guess that a revoked member would then have to be walked back out of.
   */
  private readonly activeOrgIdState = signal<string | null>(null);

  /** The owners this caller may switch between, personal account first. */
  private readonly ownersState = signal<readonly OwnerChoice[]>([
    { orgId: null, label: PERSONAL_OWNER_LABEL },
  ]);

  readonly activeOrgId = this.activeOrgIdState.asReadonly();
  readonly owners = this.ownersState.asReadonly();

  /**
   * True when there is anything to switch BETWEEN (Requirement 20.3).
   *
   * An account with no membership holds exactly one owner, so every switching
   * surface in the studio renders NOTHING and a solo install looks precisely as it
   * did before this feature existed. That is the criterion, not an optimisation:
   * a disabled or single-item menu is a control with no use.
   */
  readonly canSwitch = computed(() => this.ownersState().length > 1);

  /** The active owner's entry, which always exists. */
  readonly activeOwner = computed<OwnerChoice>(() => {
    const active = this.activeOrgIdState();
    return (
      this.ownersState().find(owner => owner.orgId === active) ?? {
        orgId: active,
        label: active === null ? PERSONAL_OWNER_LABEL : shortOwnerLabel(active),
      }
    );
  });

  /** What to show wherever the account is identified (Requirement 20.2). */
  readonly activeOwnerLabel = computed(() => this.activeOwner().label);

  /**
   * Adopts the owner list from the verified `/api/me` answer.
   *
   * The personal account is prepended HERE rather than sent by the worker,
   * because the worker answers a question about MEMBERSHIPS and the personal
   * account is not one - `/api/me` reporting it would be reporting the caller's
   * own id back as a membership they hold of themselves.
   *
   * An active organisation that is no longer in the list is DROPPED back to the
   * personal account (Requirement 20.11): a revoked membership already resolves
   * as though it were never named, so leaving it selected would show the personal
   * account's data under somebody else's name.
   */
  adoptOwners(memberships: readonly OwnerChoice[]): void {
    const personal = this.ownersState()[0] ?? { orgId: null, label: PERSONAL_OWNER_LABEL };
    const seen = new Set<string>();
    const organisations = memberships.filter(owner => {
      if (owner.orgId === null || seen.has(owner.orgId)) return false;
      seen.add(owner.orgId);
      return true;
    });
    this.ownersState.set([{ ...personal, orgId: null }, ...organisations]);

    const active = this.activeOrgIdState();
    if (active !== null && !seen.has(active)) this.activeOrgIdState.set(null);
  }

  /** Renames the personal entry once an account address is known. */
  setPersonalLabel(label: string): void {
    this.ownersState.update(owners =>
      owners.map(owner => (owner.orgId === null ? { ...owner, label } : owner)),
    );
  }

  /**
   * Makes one owner active.
   *
   * Refuses an organisation that is not in the list rather than trusting the
   * caller: everything downstream of this signal - the local stores, the
   * notification cursor, every request header - would then be scoped to an owner
   * the worker will refuse to resolve, which reads as an empty account rather
   * than as a rejected switch. Returns true when the value changed.
   */
  setActiveOrg(orgId: string | null): boolean {
    if (orgId !== null && !this.ownersState().some(owner => owner.orgId === orgId)) return false;
    if (this.activeOrgIdState() === orgId) return false;
    this.activeOrgIdState.set(orgId);
    return true;
  }

  /**
   * The `X-Phorma-Owner` value for this request, or null for none.
   *
   * Read by every transport seam. A function rather than the signal itself so a
   * transport never has to know that null means the personal account - it asks
   * what to send, and null means "send nothing", which is the request an install
   * with no organisation has always made.
   */
  requestedOrg(): string | null {
    return this.activeOrgIdState();
  }

  /**
   * The owner header for a request, ready to spread beside `Authorization`.
   *
   * Empty for the personal account, so `{ ...ownerHeader() }` adds nothing and
   * there is exactly one code path rather than one per credential shape.
   */
  ownerHeader(): Record<string, string> {
    const org = this.requestedOrg();
    return org === null ? {} : { [REQUESTED_OWNER_HEADER]: org };
  }

  /**
   * The owner a locally stored row belongs to.
   *
   * The SAME value the stores stamp and filter on, exposed as one function so the
   * storage layer never re-derives it. Requirement 20.15's absent-is-personal rule
   * is the read side of this: a row carrying no owner compares equal to the
   * personal account.
   */
  storageOwner(): string | null {
    return this.activeOrgIdState();
  }
}
