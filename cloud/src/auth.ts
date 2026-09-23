/**
 * Shared auth verification for the cloud runtime.
 *
 * Hosted mode: Clerk session JWTs, or a Phorma desktop token (fail closed).
 * BYO mode: Clerk when configured, PHORMA_TOKEN fallback, open when neither.
 *
 * Two credential types reach hosted mode, and `kind` on the returned context is
 * what lets a caller tell them apart. A Phorma desktop token exists because the
 * studio's webview cannot hold a Clerk session against a production instance -
 * see `device-auth.ts` for the mechanism. It is equivalent to a Clerk session for
 * a tenant's OWN data, and deliberately not equivalent for operator surfaces.
 *
 * ## The owner seam
 *
 * This module also answers "WHOSE DATA does this request address", which is a
 * different question from "who is asking" and is the whole of design section 2 of
 * `.kiro/specs/multi-organisation-phorma/`. `userId` is the caller; `ownerId` is
 * the account the request addresses, and the two differ exactly when an
 * organisation is in play. Consumers read `ownerId`, or call {@link resolveOwner}
 * when they hold a context they synthesised themselves, and never re-derive
 * `orgId ?? userId` for themselves.
 */

import { verifyToken as clerkVerifyToken } from '@clerk/backend';

import { CLERK_ROLE_LEVELS, isCapabilityLevel, type CapabilityLevel } from './capabilities';
import { isDeviceToken, verifyDeviceToken } from './device-auth';
import { TENANT_CACHE_TTL_S, type TenantEnv } from './tenants';

export interface AuthEnv {
  PHORMA_MODE?: string;
  PHORMA_TOKEN?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  /**
   * HMAC secret signing desktop sign-in tokens (`device-auth.ts`).
   *
   * OPTIONAL, and that is load-bearing: a BYO worker binds nothing here, and with
   * it unset the desktop-token branch below is skipped entirely, so BYO behaviour
   * is byte-identical to before this existed.
   *
   * `npx wrangler secret put PHORMA_AUTH_SECRET --env hosted`
   */
  PHORMA_AUTH_SECRET?: string;
  /**
   * Previous value of {@link PHORMA_AUTH_SECRET}, honoured for verification only.
   *
   * Set it for the overlap window of a rotation, then delete it. Without it a
   * rotation signs every desktop install out at once, because lean v1 has no
   * server-side record of a token to migrate.
   */
  PHORMA_AUTH_SECRET_PREVIOUS?: string;
}

/** Which kind of credential authorized a request. */
export type AuthKind =
  /** A Clerk session JWT: a human authenticated in a browser just now. */
  | 'clerk'
  /** A Phorma desktop token: a machine holding a credential from a past sign-in. */
  | 'device'
  /** BYO shared `PHORMA_TOKEN`, or an open unprotected instance. Anonymous. */
  | 'shared';

/** The identity attached to an authorized request. */
export interface AuthContext {
  /** Clerk userId (JWT sub) — null for shared-token / open-instance access. */
  userId: string | null;
  /**
   * Clerk organisation id (`org_...`) when the credential names one, else null.
   *
   * NEVER inferred: an absent claim means an absent organisation, which is a
   * single-user install behaving exactly as it did before this field existed
   * (Requirement 1.3). An account belonging to no organisation is a fully
   * supported terminal state, not a state to be migrated (Requirement 1.12).
   *
   * Filled from a VERIFIED claim for a `clerk` credential. A `device` credential
   * carries no organisation claim by design, so this stays null there and the
   * organisation is resolved per request by {@link resolveRequestedOwner} - see
   * the note on {@link resolveOwner}.
   */
  orgId: string | null;
  /**
   * Whose data this request addresses: `orgId ?? userId`, or null for a shared
   * token or an open instance.
   *
   * The cached result of {@link resolveOwner}, so no consumer re-derives the
   * expression. Null is not a gap: every consumer already folds it to the
   * `default` literal through `deploymentOwner` (Requirement 1.4).
   */
  ownerId: string | null;
  /**
   * The RAW organisation role claim, unmapped and unvalidated.
   *
   * Deliberately a string rather than a {@link CapabilityLevel}: this module is
   * about verification and must not own the capability vocabulary. The mapping
   * lives in `capabilities.ts` and is reached through {@link resolveRole}. An
   * organisation id with no role claim is NOT an error here; it becomes
   * `role_unknown` at {@link resolveRole}, which is where fail-closed belongs.
   */
  orgRole: string | null;
  /**
   * How the caller proved who they are.
   *
   * Read this, not just `userId`, for anything an OPERATOR does rather than a
   * tenant. A desktop token is a long-lived bearer sitting on a laptop with no
   * revocation in lean v1, so it must not reach the telemetry admin surface even
   * when its `userId` is on the allowlist - see `telemetry-admin.ts`.
   */
  kind: AuthKind;
}

export function isHosted(env: AuthEnv): boolean {
  return env.PHORMA_MODE === 'hosted';
}

function hasAnySecret(env: AuthEnv): boolean {
  return Boolean(env.CLERK_SECRET_KEY || env.PHORMA_TOKEN);
}

// ── The owner seam ───────────────────────────────────────────────────────────

/**
 * Whose data a request addresses.
 *
 * TOTAL and SYNCHRONOUS: every `AuthContext` resolves, and the only null is the
 * shared-token / open-instance case that every consumer already folds to the
 * `default` literal through `deploymentOwner` (Requirement 1.4).
 *
 * THE ASYMMETRY, documented here rather than left for the first caller to find:
 * this reads `auth.orgId`, which {@link verifyBearer} fills for a `clerk`
 * credential from a VERIFIED claim. For a `device` credential there is no claim -
 * the `phd_` payload deliberately carries no organisation id - so `verifyBearer`
 * fills `ownerId` with the subject's own `userId`, and an organisation named by
 * the `X-Phorma-Owner` header is confirmed against membership one layer up, by
 * {@link resolveRequestedOwner}, which needs a `TenantEnv` and therefore cannot
 * live inside a synchronous resolver. Both paths write the SAME field, so every
 * consumer below them reads one value and never branches on credential kind.
 *
 * It is a function AND a cached field ({@link AuthContext.ownerId}) because
 * `verifyBearer` fills the field by calling the function: the expression
 * `orgId ?? userId` is written exactly once. Read the field; call the function
 * only when you hold a context you synthesised yourself.
 */
export function resolveOwner(auth: AuthContext): string | null {
  return auth.orgId ?? auth.userId;
}

/**
 * False when an owner id cannot be used as a key segment (Requirement 1.8).
 *
 * A GUARD beside {@link resolveOwner} rather than a branch inside it, because a
 * resolver that can return a refusal is a resolver every caller has to
 * discriminate. The gateway and the API router call this and answer
 * `owner_invalid` on false. Nothing truncates, escapes or rewrites the value:
 * an owner id is opaque, and a colon is the one structural fact anything is
 * allowed to know about it, because `${ownerId}:${instance}` is how a Durable
 * Object instance and a `deploy:` registry key are addressed.
 *
 * This is the FIRST of two independent colon refusals. The second is
 * `isRegistrySegment` in `portal-registry.ts`, which protects the prefix scan in
 * `listDeployments`. Keeping both is deliberate.
 */
export function ownerIdIsAddressable(ownerId: string | null): boolean {
  return ownerId === null || !ownerId.includes(':');
}

/**
 * The organisation id and the RAW role claim, from whichever layout the verified
 * Clerk instance emits.
 *
 * Clerk has shipped more than one session-token claim layout: the long-standing
 * default carries organisation context as TOP-LEVEL claims (`org_id`, `org_role`,
 * `org_slug`, `org_permissions`), and a newer instance can be configured to emit
 * a COMPACTED organisation object instead (`o: { id, rol, slg, ... }`).
 * `@clerk/backend`'s `verifyToken` hands back the payload and normalises neither.
 *
 * So this reads both and prefers whichever is present, and returns nulls rather
 * than throwing for a token carrying neither - which is the ordinary case for a
 * personal account and must stay ordinary (Requirement 1.3). An organisation id
 * with no role claim is also not an error here; it becomes `role_unknown` at
 * {@link resolveRole}.
 *
 * The role value is handed back UNMAPPED. The two layouts spell one role
 * differently (`org:admin` against a bare `admin`), and that tolerance belongs in
 * `CLERK_ROLE_LEVELS`, not here.
 */
export function readOrgClaim(payload: Record<string, unknown>): {
  orgId: string | null;
  orgRole: string | null;
} {
  const topLevelId = readClaimString(payload['org_id']);
  if (topLevelId) return { orgId: topLevelId, orgRole: readClaimString(payload['org_role']) };

  const compacted = payload['o'];
  if (compacted !== null && typeof compacted === 'object') {
    const organisation = compacted as Record<string, unknown>;
    const compactedId = readClaimString(organisation['id']);
    if (compactedId) return { orgId: compactedId, orgRole: readClaimString(organisation['rol']) };
  }

  return { orgId: null, orgRole: null };
}

/** A claim value that is a usable non-empty string, else null. */
function readClaimString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The header a member uses to name their OWN organisation. */
export const REQUESTED_OWNER_HEADER = 'X-Phorma-Owner';

/**
 * Bound on a header value before it reaches a D1 bind. Generous against a Clerk
 * id (`org_` plus 27 characters today) and small enough that nothing pathological
 * gets copied around.
 */
const REQUESTED_OWNER_MAX_CHARS = 128;

/**
 * Shape gate for {@link REQUESTED_OWNER_HEADER}. Deliberately NOT an id
 * classifier - `isOwnerId` in `tenants.ts` is that, and it guards writes. This
 * only refuses what could not possibly be looked up or addressed: an empty value,
 * an oversized one, and anything carrying a character outside the id alphabet,
 * which is also what keeps a colon out (see {@link ownerIdIsAddressable}).
 */
const REQUESTED_OWNER_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * The organisation a request NAMES, or null. Read in ONE place, so the header
 * name lives in one place.
 *
 * MEANINGLESS on its own: it is a request, not a credential. Only
 * {@link resolveRequestedOwner} can turn it into an owner, and only after a
 * membership check.
 *
 * Deliberately a different header from `X-Phorma-Act-As`, which is an OPERATOR
 * naming somebody else's owner and is checked against the allowlist, audited and
 * read-only. One header for both would make the difference between "my
 * organisation" and "a customer's organisation" a property of who is asking
 * rather than of what was asked.
 */
export function readRequestedOrg(request: Request): string | null {
  const raw = request.headers.get(REQUESTED_OWNER_HEADER);
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > REQUESTED_OWNER_MAX_CHARS) return null;
  return REQUESTED_OWNER_CHARS.test(value) ? value : null;
}

/**
 * Whose data this request addresses, for a credential whose organisation is not
 * already carried by a verified claim.
 *
 * Returns the caller's OWN `userId` whenever the named organisation cannot be
 * confirmed. That covers an absent header, an unparseable value, and a real
 * organisation the caller is not a member of - all three INDISTINGUISHABLE from
 * outside (Requirements 1.7, 20.10), and none of them a refusal, because the
 * answer to "show me this organisation" for somebody who is not in it is the same
 * answer as to a request that never named it. Probing the header therefore
 * reveals nothing about which organisations exist.
 *
 * Two shapes short-circuit before any read:
 *
 *  - A `shared` credential IGNORES the header outright. BYO binds no `DB`, so
 *    there is nothing to check a membership against and nothing an organisation
 *    could mean (Requirements 1.4, 16.6).
 *  - A credential that already carries a VERIFIED organisation claim keeps it. A
 *    claim outranks a header; a header can never move a browser session out of
 *    the organisation Clerk minted it for.
 *
 * The membership check is not a new read: it is the same cached
 * `orgmember:{orgId}:{userId}` lookup {@link resolveRole} performs, so a named
 * organisation costs what resolving the level already costs, and a REVOKED
 * membership bites on the next request rather than when the credential expires
 * (Requirement 20.11) - which is exactly why the `phd_` payload names no
 * organisation.
 */
export async function resolveRequestedOwner(
  env: TenantEnv,
  auth: AuthContext,
  request: Request,
): Promise<string | null> {
  if (auth.kind === 'shared' || auth.userId === null) return resolveOwner(auth);
  if (auth.orgId) return auth.orgId;

  const requested = readRequestedOrg(request);
  if (requested === null || requested === auth.userId) return auth.userId;

  const level = await readMemberLevel(env, requested, auth.userId);
  return level === null ? auth.userId : requested;
}

/**
 * The caller's capability level for the owner they are addressing, or an explicit
 * unknown. ONE seam, two sources.
 *
 * 1. **No organisation, full capability.** A credential carrying no organisation
 *    claim resolves `admin` over its own personal owner (Requirement 5.10), and a
 *    `shared` credential resolves `admin` over the `default` owner
 *    (Requirements 1.4, 16.6). This is what makes the whole capability layer
 *    deployable before any organisation exists, with byte-identical behaviour.
 * 2. **Claim first, as an OPTIMISATION.** `CLERK_ROLE_LEVELS` maps the raw claim
 *    a `clerk` credential carries. An unmapped value is not an error yet; it
 *    falls through. A `device` credential carries no role claim at all, which is
 *    why the table below cannot be a mere fallback.
 * 3. **`org_members` second, and AUTHORITATIVE.** One row per `(org_id, user_id)`
 *    carrying the level, read behind the same KV cache shape
 *    `TenantStore.getTenant` uses. The Super_Admin route family is the only
 *    writer, so one surface we control owns both the membership and the level.
 * 4. **Neither.** `{ unknown: true }`, and the caller answers 403 `role_unknown`
 *    (Requirement 5.9). Never a substituted `operator`: `operator` can trigger a
 *    run, which spends the organisation's credits, so there is no safe minimum.
 *
 * Callers see one function either way, so a later move to claim-only is a change
 * inside here and nowhere else. No new binding: the claim arrives on the
 * credential and the table read takes the `DB` and `TENANTS` bindings that
 * already exist.
 */
export async function resolveRole(
  env: TenantEnv,
  auth: AuthContext,
): Promise<{ level: CapabilityLevel } | { unknown: true }> {
  const orgId = auth.orgId;
  if (orgId === null) return { level: 'admin' };

  const claimed = auth.orgRole === null ? undefined : CLERK_ROLE_LEVELS[auth.orgRole];
  if (claimed) return { level: claimed };

  if (auth.userId === null) return { unknown: true };
  const level = await readMemberLevel(env, orgId, auth.userId);
  return level === null ? { unknown: true } : { level };
}

/** KV key for one membership. Namespaced so it cannot collide with a tenant row. */
export function orgMemberCacheKey(orgId: string, userId: string): string {
  return `orgmember:${orgId}:${userId}`;
}

/** One organisation the caller may address, and the level they hold in it. */
export interface MembershipRef {
  orgId: string;
  level: CapabilityLevel;
}

/**
 * How many memberships one answer carries.
 *
 * A bound rather than a policy: the switcher is a menu, and an account in more
 * organisations than this has a support conversation rather than a scrolling list.
 */
export const MEMBERSHIP_LIST_LIMIT = 50;

/**
 * Every organisation `userId` is a member of, in a stable order, or an empty list.
 *
 * `org_members` by `user_id` - which is exactly what `idx_org_members_user`
 * exists for - so ONE source answers both credential shapes: a desktop install
 * with no Clerk session gets the same list a browser gets from
 * `user.organizationMemberships`, and a member whose Clerk role claim would have
 * short-circuited {@link resolveRole} is still listed.
 *
 * NOT cached, deliberately, and it is the opposite call to {@link readMemberLevel}:
 * this one is read by `/api/me` alone rather than on the request path, and a
 * membership granted a moment ago appearing in the switcher a minute later is
 * exactly the "did it work?" failure the Super_Admin surface would then be blamed
 * for. A revocation has the same shape from the other side (Requirement 20.11).
 *
 * Fails CLOSED to an EMPTY list rather than throwing, the same way
 * {@link readMemberLevel} does: a worker with no `DB`, or a database predating
 * `0006_organisations.sql`, reads as "no memberships", and `canSwitch` then
 * renders no switching surface at all - which is today's behaviour for every
 * install (Requirement 20.3). A throw here would turn a missing migration into a
 * 500 on the one route the studio polls for its plan and its credits.
 *
 * A level token outside the declared vocabulary is DROPPED, not substituted. The
 * studio compares no level token itself, so an unrecognised one would be offered
 * as an owner whose capabilities nothing could describe.
 */
export async function listMemberships(
  env: TenantEnv,
  userId: string | null,
): Promise<MembershipRef[]> {
  if (userId === null || !env.DB) return [];
  try {
    const result = await env.DB.prepare(
      // `ORDER BY org_id`, NEVER `created_at`: this list is a MENU, so it needs a
      // stable order, and two memberships granted in one operator pass tie on
      // `created_at` to the millisecond - the same trap the proposal retention sweep
      // documents. A tie would reorder the switcher between two polls.
      `SELECT org_id, level FROM org_members WHERE user_id = ? ORDER BY org_id ASC LIMIT ?`,
    )
      .bind(userId, MEMBERSHIP_LIST_LIMIT)
      .all<{ org_id: string; level: string }>();
    const rows = result.results ?? [];
    const memberships: MembershipRef[] = [];
    for (const row of rows) {
      if (typeof row.org_id !== 'string' || !isCapabilityLevel(row.level)) continue;
      memberships.push({ orgId: row.org_id, level: row.level });
    }
    return memberships;
  } catch (error) {
    console.error('org_members listing failed; resolving as no memberships.', error);
    return [];
  }
}

/**
 * Adopts an organisation the request NAMES, once membership is confirmed.
 *
 * The one place `X-Phorma-Owner` becomes part of an identity, called from
 * {@link verifyRequest} so every authenticated route and the HTTP gateway inherit
 * it together (Requirements 20.4, 20.10). Without it the header is inert and a
 * desktop install could not switch at all - the `phd_` payload carries no
 * organisation by design, so per-request naming is the whole mechanism there.
 *
 * It moves TWO fields, `orgId` and `ownerId`, and that is the difference from
 * `applyImpersonation`, which moves exactly one. A confirmed membership is a fact
 * about the caller, so `resolveRole` must answer about the organisation they are
 * in and `refuseManagedBilling` must refuse an organisation's checkout. An
 * impersonated owner is a fact about somebody ELSE, which is why it leaves the
 * claims alone.
 *
 * Returns `auth` UNCHANGED for every case but a confirmed one, so an install
 * that never sends the header - which is every install before this feature - is
 * byte-identical:
 *
 *  - a credential already carrying a VERIFIED claim (a claim outranks a header),
 *  - an absent or unparseable header,
 *  - a `shared` credential, which ignores the header outright,
 *  - a real organisation the caller is not a member of, which is deliberately
 *    INDISTINGUISHABLE from the two above (Requirement 20.10).
 *
 * NOT reached on a WebSocket upgrade, and that is a property of browsers rather
 * than a gap here: `WebSocket` cannot carry a request header, so the monitor
 * socket authorizes off the query-string token through {@link verifyBearer} and
 * follows the verified claim alone.
 */
export async function adoptRequestedOwner(
  env: TenantEnv,
  auth: AuthContext,
  request: Request,
): Promise<AuthContext> {
  if (auth.orgId !== null || auth.kind === 'shared' || auth.userId === null) return auth;
  if (readRequestedOrg(request) === null) return auth;

  const owner = await resolveRequestedOwner(env, auth, request);
  if (owner === null || owner === auth.userId) return auth;
  return { ...auth, orgId: owner, ownerId: owner };
}

/**
 * One member's level in one organisation, or null when there is no row.
 *
 * Cached because this read is on the request path for every organisation member -
 * the opposite call to `grantPool`, which is deliberately uncached because it is
 * only reached once a tier allowance is gone. `TENANT_CACHE_TTL_S` is 60, which is
 * also Cloudflare KV's floor; anything lower is a 400.
 *
 * A MISS IS NOT CACHED, and that asymmetry is the point. Caching an absent row
 * would make a newly granted membership take up to 60 seconds to work, for no
 * saving on the only path that reaches here with no row - a caller naming an
 * organisation they do not belong to. A HIT is cached, and a member-management
 * write invalidates the key immediately, because a demotion that takes 60 seconds
 * to bite is a demotion that did not happen for 60 seconds.
 *
 * A level token read out of a row is validated against the DECLARED vocabulary
 * and an unrecognised one reads as absent, so an unknown level fails closed
 * (Requirement 13.9). That is not the same thing as re-validating an ID read out
 * of a row, which nothing here does (Requirement 1.10).
 *
 * Fails CLOSED rather than throwing: a database with no `DB` binding, or one
 * predating `0006_organisations.sql` and therefore missing the table, reads as
 * "no membership" with the cause logged. A throw here would turn a missing
 * migration into a 500 on every route rather than a refusal on the organisation
 * ones.
 */
async function readMemberLevel(
  env: TenantEnv,
  orgId: string,
  userId: string,
): Promise<CapabilityLevel | null> {
  const cacheKey = orgMemberCacheKey(orgId, userId);
  const cached = await env.TENANTS?.get(cacheKey, 'json');
  if (cached) {
    const level = (cached as { level?: unknown }).level;
    return isCapabilityLevel(level) ? level : null;
  }

  if (!env.DB) return null;
  let row: { level: string } | null = null;
  try {
    row = await env.DB.prepare('SELECT level FROM org_members WHERE org_id = ? AND user_id = ?')
      .bind(orgId, userId)
      .first<{ level: string }>();
  } catch (error) {
    console.error('org_members lookup failed; resolving as no membership.', error);
    return null;
  }
  if (!row) return null;

  await env.TENANTS?.put(cacheKey, JSON.stringify({ level: row.level }), {
    expirationTtl: TENANT_CACHE_TTL_S,
  });
  return isCapabilityLevel(row.level) ? row.level : null;
}

/**
 * Completes an {@link AuthContext} by filling {@link AuthContext.ownerId} from
 * {@link resolveOwner}, so the `orgId ?? userId` expression exists once in this
 * file and nowhere else.
 */
function withOwner(partial: Omit<AuthContext, 'ownerId'>): AuthContext {
  const auth: AuthContext = { ...partial, ownerId: null };
  auth.ownerId = resolveOwner(auth);
  return auth;
}

/** The anonymous BYO identity: no user, no organisation, the `default` owner. */
function sharedContext(): AuthContext {
  return withOwner({ userId: null, orgId: null, orgRole: null, kind: 'shared' });
}

/**
 * Validates a bearer token. Returns the caller's identity on success, null
 * on failure. Open instances (BYO, no secrets) return an anonymous context.
 */
export async function verifyBearer(env: AuthEnv, token: string | null): Promise<AuthContext | null> {
  if (!isHosted(env) && !hasAnySecret(env)) return sharedContext(); // open instance
  if (!token) return null;

  // A Phorma desktop token is checked FIRST, but only when it announces itself
  // with the `phd_` prefix. Ordering it before Clerk costs nothing (the prefix
  // test is a string compare) and keeps a device token out of `clerkVerifyToken`,
  // whose failure path is a thrown exception rather than a return.
  if (env.PHORMA_AUTH_SECRET && isDeviceToken(token)) {
    const verified = await verifyDeviceToken(
      [env.PHORMA_AUTH_SECRET, env.PHORMA_AUTH_SECRET_PREVIOUS],
      token,
      Date.now() / 1000,
    );
    // A well-formed-but-invalid device token stops here rather than falling
    // through to the Clerk attempt: it can never be a Clerk JWT, and letting it
    // continue would only widen what a forgery gets to try.
    // The payload carries NO organisation id, deliberately (design section 2.5),
    // so `ownerId` is the subject's own account here and an organisation is named
    // per request through `resolveRequestedOwner`. A signed organisation id would
    // leave a desktop install unable to switch without re-running the whole
    // browser handoff, and would honour a revoked membership for up to the
    // token's 30-day TTL, because lean v1 has no record of a token to revoke.
    return verified
      ? withOwner({ userId: verified.sub, orgId: null, orgRole: null, kind: 'device' })
      : null;
  }

  // Prefer Clerk session JWT verification when configured.
  if (env.CLERK_SECRET_KEY) {
    try {
      const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(',')
        .map(party => party.trim())
        .filter(Boolean);
      const payload = await clerkVerifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
        // Offline verification when the instance PEM is provided (no JWKS
        // fetch on DO cold start).
        jwtKey: env.CLERK_JWT_KEY,
        authorizedParties: authorizedParties?.length ? authorizedParties : undefined,
      });
      if (payload.sub) {
        const { orgId, orgRole } = readOrgClaim(payload as unknown as Record<string, unknown>);
        return withOwner({ userId: payload.sub, orgId, orgRole, kind: 'clerk' });
      }
    } catch {
      // Not a valid Clerk token — BYO mode may fall through to PHORMA_TOKEN.
    }
  }

  // Hosted mode: Clerk and desktop tokens are the only accepted credentials.
  // Fail closed.
  if (isHosted(env)) return null;

  // BYO fallback: shared static token (anonymous identity).
  const shared = env.PHORMA_TOKEN;
  return shared && token === shared ? sharedContext() : null;
}

/**
 * Extracts + verifies the Authorization header of a request, then adopts an
 * organisation the request names if the caller's membership confirms.
 *
 * The owner adoption lives HERE rather than in each route because there is one
 * bearer seam and there must be one owner seam beside it: a route that verified
 * the credential and forgot the header would address the member's personal
 * account while every neighbouring route addressed the organisation, and nothing
 * would log it. `env` therefore carries the `TenantEnv` bindings too - every one
 * of them is optional, so a caller holding only an {@link AuthEnv} still
 * satisfies it and the header simply never confirms.
 */
export async function verifyRequest(
  env: AuthEnv & TenantEnv,
  request: Request,
): Promise<AuthContext | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return !isHosted(env) && !hasAnySecret(env) ? sharedContext() : null;
  }
  const auth = await verifyBearer(env, header.slice('Bearer '.length).trim());
  return auth === null ? null : adoptRequestedOwner(env, auth, request);
}
