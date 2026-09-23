/**
 * `/api/admin/organisations/*` - the operator-only organisation and member
 * management family (multi-organisation-phorma task 12, Requirement 13).
 *
 * ## The THIRD room behind the same door
 *
 * `admin-auth.ts` owns the operator gate, and this module calls it exactly as
 * `telemetry-admin.ts` and `billing-admin.ts` do. It does NOT re-implement the
 * 401-versus-403 split (Requirement 13.1), and every rule that gate carries still
 * applies here (Requirement 13.2): an ABSENT bearer is 401, checked before
 * `verifyRequest` hands an anonymous context to an open worker; a non-`clerk`
 * credential kind is 403, so a long-lived desktop `phd_` token cannot carry
 * operator reach; and a missing `TELEMETRY_ADMIN_USER_IDS` grants NO access
 * rather than open access. That secret is a BARE comma-separated list, never
 * JSON, and its name is historical and deliberately not renamed - one allowlist,
 * one door, three rooms.
 *
 * ## This is the ONLY surface that writes membership
 *
 * Requirement 13.7: there is no organisation-facing member management route in
 * this release. Membership is written through the operator gate alone, so exactly
 * one surface writes it and the `member.manage` capability stays DECLARED in the
 * Capability_Contract and exercised by no route at all. A released token is never
 * renamed or repurposed to reflect that (Requirement 5.11), and an
 * organisation-facing route is a later feature rather than a gap.
 * `cloud/test/role-gate.test.mjs` asserts the ABSENCE: its static half fails on an
 * `admin`-level member write anywhere outside this prefix.
 *
 * ## Every membership write lands an `org_members` row, and Clerk goes FIRST
 *
 * `org_members` is the AUTHORITATIVE membership and level source rather than a
 * fallback (design section 2.5): a `device` credential carries no Clerk role claim
 * at all, and `resolveRequestedOwner` confirms a header-named organisation against
 * that table - so a write that only touched Clerk would leave a desktop install
 * unable to switch into the organisation it was just added to.
 *
 * The ORDER is Clerk first, then the row, and it is load-bearing rather than
 * arbitrary. `resolveRole` consults `CLERK_ROLE_LEVELS` BEFORE the table as an
 * optimisation, and `org:admin` maps to `admin`. So on a DEMOTION out of `admin`,
 * the Clerk role is what has to move first: write the row first and let the Clerk
 * PATCH fail, and the claim keeps short-circuiting to `admin` while the table says
 * `builder` - a demotion that did not happen, with a correct-looking row to prove
 * it did. The reverse partial state fails CLOSED instead: a Clerk `org:member`
 * claim is deliberately UNMAPPED, so a member with a Clerk membership and no row
 * resolves `role_unknown`.
 *
 * A partial failure is REPORTED, never logged and swallowed (502
 * `org_partial_write`): one half existing without the other is the state an
 * operator most needs to see, and it is the one state no later request can
 * discover for itself.
 *
 * ## Membership and level writes INVALIDATE the KV cache IMMEDIATELY
 *
 * `resolveRole` caches a HIT under `orgmember:{orgId}:{userId}` for
 * `TENANT_CACHE_TTL_S` (60, which is also KV's floor). Two consequences, and both
 * are the reason {@link invalidateMemberCache} is called on every write path
 * including the failing ones:
 *
 *  - a demotion that takes 60 seconds to bite is a demotion that did not happen
 *    for 60 seconds;
 *  - a REMOVAL that takes 60 seconds to bite leaves a removed member addressing
 *    the organisation for a minute (Requirement 20.11), because
 *    `resolveRequestedOwner` reads the same cached key.
 *
 * A MISS is never cached, which is what makes a brand new membership work at once
 * with no invalidation of its own.
 *
 * ## An organisation is never implicitly paid
 *
 * Creating one provisions a `tenants` row at {@link UNPAID_ORG_TIER} with
 * {@link UNPAID_ORG_STATUS} and NO runtime key (Requirement 13.4). Entitlement
 * arrives later through `POST tier`, which goes through the SAME
 * `provisionTenantTier` seam `/api/provision` uses - Requirement 19.5 names
 * provisioning as the only way an organisation becomes entitled, which is a claim
 * about one path rather than about two that happen to agree. Raising a ceiling is
 * a TIER change and never a credit grant (Requirement 19.10).
 *
 * ## No vendor prose reaches a response body
 *
 * Same rule `status.ts`, `billing-admin.ts` and `RuntimeKeyOutcome.detail` follow.
 * A Clerk error body can quote a request header back, and these responses are read
 * by a browser, so a failure becomes one of OUR fixed sentences plus a
 * `console.error`.
 *
 * ## No migration
 *
 * `org_members` already exists, complete, from `0006_organisations.sql` (task 1).
 * A migration is recorded as applied by FILENAME, so nothing may be appended to
 * that file; a later schema change goes in `0007`.
 */

import {
  noStoreResponder,
  refuseNonOperator,
  type AdminAuthEnv,
  type AdminRespond,
} from './admin-auth';
import { orgMemberCacheKey } from './auth';
import { CAPABILITY_LEVELS, isCapabilityLevel, type CapabilityLevel } from './capabilities';
import { rememberOrgName } from './org-names';
import type { RoleRefusalCode } from './role-gate';
import {
  TIERS,
  TenantStore,
  isClerkUserId,
  isKnownTier,
  isOrgId,
  provisionTenantTier,
  type TenantEnv,
  type TenantRecord,
} from './tenants';

/** The path prefix this module owns. Every route sits below it. */
export const ORG_ADMIN_PREFIX = '/api/admin/organisations/';

/**
 * The four routes. `members` carries three methods, because "who is in this
 * organisation" and "put this person in it at this level" are the same resource.
 */
export const ORG_ADMIN_ROUTES = ['list', 'create', 'members', 'tier'] as const;

export type OrgAdminRoute = (typeof ORG_ADMIN_ROUTES)[number];

/** Every binding this module touches: the operator gate, D1, and KV. */
export type OrgAdminEnv = AdminAuthEnv & TenantEnv;

/**
 * The refusal codes this family answers with. APPEND-ONLY, like every other
 * refusal set on this wire (Requirement 16.2).
 *
 * `role_unknown` is NOT introduced here - it is `role-gate.ts`'s token, reused
 * because one token covers both "we cannot read your role" and "you named a level
 * we do not have" (Requirement 13.9, design section 5.4). The
 * `satisfies RoleRefusalCode` below is what keeps that sharing structural.
 */
export type OrgAdminRefusalCode =
  /** A level token outside the declared vocabulary (Requirement 13.9). */
  | 'role_unknown'
  /** The Clerk write failed, so NOTHING was written. Retry. */
  | 'org_clerk_failed'
  /** The Clerk write landed and its counterpart did not. Needs an operator. */
  | 'org_partial_write';

/** Compile-time proof that `role_unknown` is the Role_Gate's token, not a copy. */
const ROLE_UNKNOWN: OrgAdminRefusalCode = 'role_unknown' satisfies RoleRefusalCode;

/**
 * The tier a brand new organisation is provisioned at: a token that is
 * deliberately NOT in `TIERS` (Requirement 13.4).
 *
 * Not `'starter'`, because that IS a paid tier and creating an organisation must
 * grant none. Not an absent column either - `tenants.tier` is `NOT NULL`, and a
 * row per owner is what makes the quota bucket, the usage rollup and the backup
 * scope resolve at all.
 *
 * `isKnownTier('none')` is false, so nothing treats it as a plan. `tierLimits`
 * falls back to starter LIMITS for it, which is harmless and is not entitlement:
 * {@link UNPAID_ORG_STATUS} is what `resolveHostedInference` reads, and an
 * unprovisioned organisation also holds no runtime key, so a hosted run is refused
 * twice over.
 */
export const UNPAID_ORG_TIER = 'none';

/**
 * The status a brand new organisation is provisioned at.
 *
 * `canceled` is the only non-entitled value `TenantRecord['status']` offers, and
 * it is the right one: `resolveHostedInference` refuses it `no_subscription`, and
 * `provisionTenantTier` therefore reconciles no runtime key. "Never subscribed"
 * and "cancelled" are not distinguished on this column, and widening the
 * vocabulary to distinguish them would be a wire and schema change for a
 * distinction nothing acts on.
 */
export const UNPAID_ORG_STATUS: TenantRecord['status'] = 'canceled';

/**
 * The tier tokens `POST tier` accepts: every declared plan, plus the unpaid token
 * so an organisation can be taken back OUT of entitlement here.
 *
 * Derived from `TIERS` rather than written out, so a plan added there is offered
 * by the dashboard with no dashboard change. The per-deal enterprise tier stays on
 * `/api/provision`, which writes a tier verbatim - a bespoke token belongs in an
 * operator's curl rather than in a select box.
 */
export function assignableTiers(): string[] {
  return [UNPAID_ORG_TIER, ...Object.keys(TIERS)];
}

// --- Wire contract (structural twin of `admin/src/app/core/org-models.ts`) ---

/**
 * One organisation, as the dashboard sees it.
 *
 * `name` and `slug` are NULLABLE because they come from Clerk and a Clerk read can
 * fail. A null is "we could not read this", never "it has no name" - the same
 * null-is-not-a-zero rule `billing-admin.ts` carries.
 *
 * `status` adds `unprovisioned` to `TenantRecord['status']`: an organisation that
 * exists in Clerk with no `tenants` row at all is a real and actionable state, and
 * folding it onto `canceled` would hide a half-finished creation.
 */
export interface OrgSummary {
  /** The Owner_Id. `org_...`. */
  id: string;
  name: string | null;
  slug: string | null;
  /** The `tenants.tier` token, or {@link UNPAID_ORG_TIER} when there is no row. */
  tier: string;
  status: TenantRecord['status'] | 'unprovisioned';
  /** `org_members` rows for this organisation. The authoritative count. */
  members: number;
}

/** One membership row, straight off the authoritative table. */
export interface OrgMemberRow {
  userId: string;
  /** A declared level token. Sent as a string; the vocabulary travels separately. */
  level: string;
  /** The acting user recorded at the last write. Audit only. */
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET list`.
 *
 * `levels` and `tiers` carry the VOCABULARY, which is why the dashboard declares
 * neither. A level token is persisted in an `org_members` row and compared only
 * inside the capability module; a dashboard that declared its own copy would be a
 * THIRD independent declaration of a contract that already has a twin pair, and
 * the one thing worse than two copies is three. So the worker tells the dashboard
 * what it accepts, and a level added to `CAPABILITY_LEVELS` reaches the select box
 * with no dashboard change.
 */
export interface OrgListResponse {
  organisations: OrgSummary[];
  /** Every Capability_Level, in display order (least capable first). */
  levels: string[];
  /** Every tier `POST tier` accepts, unpaid token first. */
  tiers: string[];
  /**
   * Which half of the read failed, by name. `['clerk']` means the names and the
   * organisations that exist only in Clerk are missing; the rows below are still
   * the authoritative membership.
   */
  degraded: string[];
}

/** `GET members`. */
export interface OrgMembersResponse {
  orgId: string;
  members: OrgMemberRow[];
  levels: string[];
}

/** `POST create`. */
export interface OrgCreateResponse {
  organisation: OrgSummary;
}

/** `POST members` and `DELETE members`. */
export interface OrgMemberWriteResponse {
  orgId: string;
  userId: string;
  /** The level now on record, or null after a removal. */
  level: string | null;
  /** What the Clerk half did. `absent` means there was no membership to remove. */
  clerkMembership: 'written' | 'removed' | 'absent';
}

/** `POST tier`. */
export interface OrgTierResponse {
  orgId: string;
  tier: string;
  status: TenantRecord['status'];
  /** Whether the organisation now holds a runtime key a hosted run can use. */
  runtimeKeyProvisioned: boolean;
  /** `RuntimeKeyOutcome.action`, reported rather than assumed. */
  runtimeKeyAction: string;
  /** The USD ceiling the key was reconciled towards. */
  runtimeKeyLimitUsd: number;
  /** Three-state: null nothing to retire, false a live key is still out there. */
  supersededKeyDisabled: boolean | null;
  runtimeKeyDetail?: string;
}

// --- Bounds and fixed copy -------------------------------------------------

/** Longest organisation name accepted. Clerk's own cap is higher; this is a sanity bound. */
export const ORG_NAME_MAX = 120;

/** Longest slug accepted. Clerk normalises, so this only refuses prose. */
export const ORG_SLUG_MAX = 120;

/** How many organisations one `GET list` reads out of Clerk. */
export const ORG_LIST_LIMIT = 200;

/** The one sentence a failed Clerk call answers with. Never the vendor's. */
export const CLERK_UNAVAILABLE_ERROR =
  'The identity provider could not be reached, so nothing was written. Try again.';

/** The one sentence a half-applied write answers with. */
export const PARTIAL_WRITE_ERROR =
  'The identity provider was updated and the membership record was not, so the two now ' +
  'disagree. Re-run this change; it is safe to repeat.';

/** The `degraded` entry naming a failed Clerk read. */
export const DEGRADED_CLERK = 'clerk';

// --- The Clerk Backend API -------------------------------------------------

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/**
 * Every outbound request sets a User-Agent. Several vendors reject a UA-less
 * request, and the failure is silent because JSON parsing masks the error body.
 */
const USER_AGENT = 'phorma-agent-studio-cloud';

/** Bounded so one vendor stall cannot hold an operator's request open. */
const CLERK_TIMEOUT_MS = 8_000;

/**
 * One Clerk Backend API call. `status` is reported so a caller can branch on 404
 * without reading prose, and `detail` is OUR sentence - the vendor body goes to
 * the log only.
 */
type ClerkResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null };

async function clerkRequest<T>(
  env: OrgAdminEnv,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<ClerkResult<T>> {
  const secret = env.CLERK_SECRET_KEY;
  if (!secret) {
    console.error('org admin: no CLERK_SECRET_KEY, so no organisation write is possible.');
    return { ok: false, status: null };
  }
  try {
    const response = await fetch(`${CLERK_API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body is logged and never forwarded: it can echo a request header, and
      // this response reaches a browser.
      const text = await response.text().catch(() => '');
      console.error(
        `org admin: Clerk ${init.method} ${path} answered ${response.status}: ${text.slice(0, 200)}`,
      );
      return { ok: false, status: response.status };
    }
    return { ok: true, status: response.status, data: (await response.json()) as T };
  } catch (error) {
    console.error(`org admin: Clerk ${init.method} ${path} failed.`, error);
    return { ok: false, status: null };
  }
}

/**
 * The Clerk organisation role for a Capability_Level.
 *
 * Clerk's built-in organisation roles are `org:admin` and `org:member`, and four
 * levels do not fit in two - which is exactly why `org_members` is the
 * authoritative source rather than the claim. The mapping is still load-bearing in
 * ONE direction: `CLERK_ROLE_LEVELS` maps `org:admin` to `admin`, so anybody who
 * is NOT `admin` here must carry `org:member`, whose claim is deliberately
 * UNMAPPED and therefore falls through to the table. Hand a `builder` an
 * `org:admin` role and the claim would short-circuit their level to `admin` and
 * the table would never be read.
 */
export function clerkRoleFor(level: CapabilityLevel): string {
  return level === 'admin' ? 'org:admin' : 'org:member';
}

// --- The membership cache -------------------------------------------------

/**
 * Drops the cached membership for one `(organisation, member)` pair, IMMEDIATELY.
 *
 * Called on every write path, including the ones that failed, because a stale
 * `admin` entry outliving a demotion and a stale entry outliving a REMOVAL are
 * the two failures this whole family exists to avoid (Requirement 20.11). A
 * delete on a key that was never cached is a no-op, so calling it unconditionally
 * costs one KV round trip and removes a branch that could be wrong.
 *
 * Never throws: a KV failure must not turn a completed write into a refusal. It
 * DOES log, because the residual is then up to 60 seconds of a superseded level.
 */
async function invalidateMemberCache(
  env: OrgAdminEnv,
  orgId: string,
  userId: string,
): Promise<void> {
  try {
    await env.TENANTS?.delete(orgMemberCacheKey(orgId, userId));
  } catch (error) {
    console.error(
      `org admin: could not invalidate ${orgMemberCacheKey(orgId, userId)}; the previous level ` +
        `may resolve for up to the cache TTL.`,
      error,
    );
  }
}

// --- The handler ----------------------------------------------------------

/**
 * Handles `/api/admin/organisations/*`. Returns `null` for any other path, so
 * `routeApiRequest` falls through - the same convention the other two admin
 * families follow.
 *
 * The authorization gate runs BEFORE any route or method dispatch, so an
 * unauthorized caller cannot use the response code to learn which routes exist.
 */
export async function handleOrgAdminRequest(
  request: Request,
  env: OrgAdminEnv,
  url: URL,
  respond: AdminRespond,
): Promise<Response | null> {
  if (!url.pathname.startsWith(ORG_ADMIN_PREFIX)) return null;

  const reply = noStoreResponder(respond);

  // Requirements 13.1, 13.2 - the whole gate, shared with the other two families.
  const refusal = await refuseNonOperator(request, env, reply);
  if (refusal) return refusal;

  const route = url.pathname.slice(ORG_ADMIN_PREFIX.length);
  if (!isOrgAdminRoute(route)) return reply({ error: 'Not found.' }, 404);

  // Hosted-only, and a missing `DB` is a 501 naming the binding rather than an
  // empty answer. `telemetry-admin.ts` answers an empty aggregate for an absent
  // binding because a BYO worker genuinely has no telemetry store; here an empty
  // list would read as "this account has no organisations", which is a different
  // and wrong statement. Membership IS the subject.
  if (!env.DB) {
    return reply({ error: 'Organisation management needs the hosted D1 binding.' }, 501);
  }
  const store = new TenantStore(env);

  switch (route) {
    case 'list':
      if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
      return listOrganisations(env, reply);
    case 'create':
      if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
      return createOrganisation(request, env, store, reply);
    case 'members':
      if (request.method === 'GET') return listMembers(env, url, reply);
      if (request.method === 'POST') return writeMember(request, env, reply);
      if (request.method === 'DELETE') return removeMember(env, url, reply);
      return reply({ error: 'Method not allowed.' }, 405);
    case 'tier':
      if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
      return setOrganisationTier(request, env, store, reply);
  }
}

function isOrgAdminRoute(route: string): route is OrgAdminRoute {
  return (ORG_ADMIN_ROUTES as readonly string[]).includes(route);
}

/** The declared level vocabulary, as wire tokens. */
function levelTokens(): string[] {
  return [...CAPABILITY_LEVELS];
}

// --- GET list -------------------------------------------------------------

/** One Clerk organisation, reduced to the two fields this family reports. */
interface ClerkOrganisation {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
}

/**
 * Every organisation this deployment knows about, merged from three sources.
 *
 * D1 is AUTHORITATIVE about which organisations exist as far as this worker is
 * concerned: `org_members` names every organisation somebody can reach, and an
 * `org_` row in `tenants` names every one that has ever been provisioned. Clerk
 * supplies the NAMES, and a Clerk organisation with neither a membership row nor a
 * tenants row is still listed - it is a half-finished creation, which is exactly
 * what an operator needs to see.
 *
 * A failed Clerk read is DEGRADED, not fatal: the list is still correct about
 * membership and entitlement, and blanking the page because a vendor was
 * unreachable would take away the surface an operator opens during that outage.
 */
async function listOrganisations(env: OrgAdminEnv, reply: AdminRespond): Promise<Response> {
  const db = env.DB;
  if (!db) return reply({ error: 'Organisation management needs the hosted D1 binding.' }, 501);

  const degraded: string[] = [];
  const clerk = await clerkRequest<{ data?: unknown }>(
    env,
    `/organizations?limit=${ORG_LIST_LIMIT}&order_by=-created_at`,
  );
  const names = new Map<string, { name: string | null; slug: string | null }>();
  if (clerk.ok) {
    const rows = Array.isArray(clerk.data?.data) ? clerk.data.data : [];
    for (const raw of rows as ClerkOrganisation[]) {
      if (typeof raw?.id !== 'string') continue;
      names.set(raw.id, {
        name: typeof raw.name === 'string' ? raw.name : null,
        slug: typeof raw.slug === 'string' ? raw.slug : null,
      });
    }
    // Refreshes the switcher's name cache as a side benefit: the operator just
    // paid for this read, and a rename then reaches members immediately. In
    // parallel, and `rememberOrgName` never throws.
    await Promise.all(
      [...names].map(([id, entry]) => rememberOrgName(env, id, entry.name)),
    );
  } else {
    degraded.push(DEGRADED_CLERK);
  }

  let counts: { org_id: string; members: number }[] = [];
  let tenants: { id: string; tier: string; status: string }[] = [];
  try {
    const [memberRows, tenantRows] = await db.batch<Record<string, unknown>>([
      db.prepare('SELECT org_id, COUNT(*) AS members FROM org_members GROUP BY org_id'),
      // `LIKE 'org\_%'` with an explicit ESCAPE: an unescaped `_` is a single
      // character wildcard in SQL LIKE, so the naive pattern also matches
      // `orgX...`. Nothing writes such an id today, which is precisely why the
      // mistake would be invisible.
      db.prepare("SELECT id, tier, status FROM tenants WHERE id LIKE 'org\\_%' ESCAPE '\\'"),
    ]);
    counts = (memberRows.results ?? []) as unknown as typeof counts;
    tenants = (tenantRows.results ?? []) as unknown as typeof tenants;
  } catch (error) {
    console.error('org admin: reading the organisation inventory failed.', error);
    return reply({ error: 'The organisation inventory could not be read.' }, 500);
  }

  const memberCounts = new Map(counts.map(row => [row.org_id, Number(row.members) || 0]));
  const provisioned = new Map(tenants.map(row => [row.id, row]));

  const ids = new Set<string>([...names.keys(), ...memberCounts.keys(), ...provisioned.keys()]);
  const organisations: OrgSummary[] = [...ids].sort().map(id => {
    const tenant = provisioned.get(id);
    const clerkRow = names.get(id);
    return {
      id,
      name: clerkRow?.name ?? null,
      slug: clerkRow?.slug ?? null,
      tier: tenant?.tier ?? UNPAID_ORG_TIER,
      status: (tenant?.status as OrgSummary['status']) ?? 'unprovisioned',
      members: memberCounts.get(id) ?? 0,
    };
  });

  return reply({
    organisations,
    levels: levelTokens(),
    tiers: assignableTiers(),
    degraded,
  } satisfies OrgListResponse);
}

// --- POST create ----------------------------------------------------------

/**
 * Creates the Clerk organisation and provisions one `tenants` row keyed by the
 * organisation Owner_Id (Requirement 13.3), with NO paid tier
 * (Requirement 13.4).
 *
 * Clerk FIRST, for the same reason every write in this module goes that way
 * round: the id does not exist until Clerk mints it, so there is nothing to key a
 * row by. A tenants row that then fails to land is a reported partial, not a log
 * line - the organisation exists and cannot be addressed, and nothing else will
 * ever notice.
 *
 * `createdBy` is a REQUEST field rather than the operator's own id because
 * `refuseNonOperator` deliberately hands back no identity at all: no admin route
 * needs to know which operator is asking, and `resolveOperator` is task 13's. A
 * Clerk instance that requires an administrator at creation is then still
 * serviceable without this module reaching for an identity it was not given.
 */
async function createOrganisation(
  request: Request,
  env: OrgAdminEnv,
  store: TenantStore,
  reply: AdminRespond,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    slug?: unknown;
    createdBy?: unknown;
  } | null;

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > ORG_NAME_MAX) {
    return reply(
      { error: `name is required and must be at most ${ORG_NAME_MAX} characters.` },
      400,
    );
  }
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (slug.length > ORG_SLUG_MAX) {
    return reply({ error: `slug must be at most ${ORG_SLUG_MAX} characters.` }, 400);
  }
  if (body?.createdBy !== undefined && !isClerkUserId(body.createdBy)) {
    return reply({ error: 'createdBy must be a Clerk user id (user_...).' }, 400);
  }

  const created = await clerkRequest<ClerkOrganisation>(env, '/organizations', {
    method: 'POST',
    body: {
      name,
      ...(slug === '' ? {} : { slug }),
      ...(body?.createdBy === undefined ? {} : { created_by: body.createdBy }),
    },
  });
  if (!created.ok) {
    return reply(
      { error: CLERK_UNAVAILABLE_ERROR, code: 'org_clerk_failed' satisfies OrgAdminRefusalCode },
      502,
    );
  }

  const id = created.data?.id;
  // A WRITE path, so the id is validated before it becomes a primary key. Nothing
  // here re-validates an id read back out of a row (Requirement 1.10).
  if (!isOrgId(id)) {
    console.error('org admin: Clerk created an organisation with an unusable id.');
    return reply(
      {
        error:
          'The identity provider created the organisation but returned an id this worker cannot ' +
          'use as an account key. It exists and is not addressable; remove it there.',
        code: 'org_partial_write' satisfies OrgAdminRefusalCode,
      },
      502,
    );
  }
  const orgId = id as string;
  // Seed the switcher's name cache from the name in hand, so the first `/api/me`
  // after a creation shows "Phorma Labs" rather than paying a Clerk read.
  await rememberOrgName(
    env,
    orgId,
    typeof created.data?.name === 'string' ? created.data.name : name,
  );

  const provisioned = await provisionTenantTier(env, store, {
    id: orgId,
    email: null,
    tier: UNPAID_ORG_TIER,
    status: UNPAID_ORG_STATUS,
  });
  if (!provisioned) {
    return reply(
      { error: PARTIAL_WRITE_ERROR, code: 'org_partial_write' satisfies OrgAdminRefusalCode },
      502,
    );
  }

  return reply({
    organisation: {
      id: orgId,
      name: typeof created.data?.name === 'string' ? created.data.name : name,
      slug: typeof created.data?.slug === 'string' ? created.data.slug : null,
      tier: provisioned.tenant.tier,
      status: provisioned.tenant.status,
      members: 0,
    },
  } satisfies OrgCreateResponse);
}

// --- GET members ----------------------------------------------------------

/** One organisation's members, straight off the authoritative table. */
async function listMembers(
  env: OrgAdminEnv,
  url: URL,
  reply: AdminRespond,
): Promise<Response> {
  const orgId = url.searchParams.get('orgId') ?? '';
  if (!isOrgId(orgId)) return reply({ error: 'orgId must be an organisation id (org_...).' }, 400);

  const db = env.DB;
  if (!db) return reply({ error: 'Organisation management needs the hosted D1 binding.' }, 501);

  try {
    const rows = await db
      .prepare(
        `SELECT user_id, level, invited_by, created_at, updated_at
           FROM org_members WHERE org_id = ? ORDER BY user_id`,
      )
      .bind(orgId)
      .all<{
        user_id: string;
        level: string;
        invited_by: string | null;
        created_at: string;
        updated_at: string;
      }>();
    const members: OrgMemberRow[] = (rows.results ?? []).map(row => ({
      userId: row.user_id,
      level: row.level,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return reply({ orgId, members, levels: levelTokens() } satisfies OrgMembersResponse);
  } catch (error) {
    console.error('org admin: reading a membership list failed.', error);
    return reply({ error: 'The membership list could not be read.' }, 500);
  }
}

// --- POST members ---------------------------------------------------------

/**
 * Invites a member or changes their level, and records EXACTLY ONE
 * Capability_Level for that member in that organisation (Requirement 13.5).
 *
 * One statement, `INSERT ... ON CONFLICT DO UPDATE`, over a table whose PRIMARY
 * KEY is `(org_id, user_id)` - so "exactly one row per pair, carrying the last
 * accepted write" (Property 30) is a schema fact rather than a claim about this
 * function.
 *
 * `invited_by` records the acting party as the literal operator surface rather
 * than an individual, because `refuseNonOperator` hands back no identity. It is an
 * audit column nothing reads; naming the surface is honest, and inventing a user
 * id would not be.
 */
export const MEMBER_WRITE_ACTOR = 'operator';

async function writeMember(
  request: Request,
  env: OrgAdminEnv,
  reply: AdminRespond,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    orgId?: unknown;
    userId?: unknown;
    level?: unknown;
  } | null;

  const orgId = typeof body?.orgId === 'string' ? body.orgId : '';
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  const requestedLevel = body?.level;
  if (!isOrgId(orgId)) {
    return reply({ error: 'orgId must be an organisation id (org_...).' }, 400);
  }
  if (!isClerkUserId(userId)) {
    return reply({ error: 'userId must be a Clerk user id (user_...).' }, 400);
  }
  // Requirement 13.9: an unrecognised level token is `role_unknown`, the same
  // token an unresolvable role answers with, and nothing is written.
  if (!isCapabilityLevel(requestedLevel)) {
    return reply(
      {
        error:
          `level must be one of ${CAPABILITY_LEVELS.join(', ')}. Nothing was written.`,
        code: ROLE_UNKNOWN,
      },
      403,
    );
  }
  const level: CapabilityLevel = requestedLevel;

  // CLERK FIRST. See the module header: a demotion out of `admin` only bites once
  // the `org:admin` claim is gone, because a mapped claim short-circuits the
  // authoritative table.
  const role = clerkRoleFor(level);
  const patched = await clerkRequest(
    env,
    `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: { role } },
  );
  if (!patched.ok) {
    // 404 is the ordinary first-invite case: there is no membership to patch yet.
    // Anything else is a vendor failure and nothing has been written.
    if (patched.status !== 404) {
      await invalidateMemberCache(env, orgId, userId);
      return reply(
        { error: CLERK_UNAVAILABLE_ERROR, code: 'org_clerk_failed' satisfies OrgAdminRefusalCode },
        502,
      );
    }
    const invited = await clerkRequest(
      env,
      `/organizations/${encodeURIComponent(orgId)}/memberships`,
      { method: 'POST', body: { user_id: userId, role } },
    );
    if (!invited.ok) {
      await invalidateMemberCache(env, orgId, userId);
      return reply(
        { error: CLERK_UNAVAILABLE_ERROR, code: 'org_clerk_failed' satisfies OrgAdminRefusalCode },
        502,
      );
    }
  }

  const now = new Date().toISOString();
  let rowWritten = false;
  try {
    await env.DB?.prepare(
      `INSERT INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO UPDATE SET
            level = excluded.level,
            updated_at = excluded.updated_at`,
    )
      .bind(orgId, userId, level, MEMBER_WRITE_ACTOR, now, now)
      .run();
    rowWritten = true;
  } catch (error) {
    console.error('org admin: the Clerk membership was written and the row was not.', error);
  }

  // IMMEDIATELY, and before the response, so the very next request resolves the
  // level just written (Requirement 20.11). Unconditional: the row may have
  // changed even on a path that then failed.
  await invalidateMemberCache(env, orgId, userId);

  if (!rowWritten) {
    return reply(
      { error: PARTIAL_WRITE_ERROR, code: 'org_partial_write' satisfies OrgAdminRefusalCode },
      502,
    );
  }

  return reply({
    orgId,
    userId,
    level,
    clerkMembership: 'written',
  } satisfies OrgMemberWriteResponse);
}

// --- DELETE members -------------------------------------------------------

/**
 * Removes a member from an organisation (Requirement 13.6).
 *
 * The KV invalidation is the load-bearing half (Requirement 20.11): without it a
 * removed member goes on naming the organisation through `X-Phorma-Owner` for up
 * to the cache TTL, because `resolveRequestedOwner` confirms membership against
 * the same cached key `resolveRole` reads.
 *
 * A Clerk 404 is SUCCESS, not a failure: the member is not in the organisation,
 * which is the state being asked for. That is what makes a retry after a partial
 * failure converge instead of refusing forever.
 */
async function removeMember(
  env: OrgAdminEnv,
  url: URL,
  reply: AdminRespond,
): Promise<Response> {
  const orgId = url.searchParams.get('orgId') ?? '';
  const userId = url.searchParams.get('userId') ?? '';
  if (!isOrgId(orgId)) return reply({ error: 'orgId must be an organisation id (org_...).' }, 400);
  if (!isClerkUserId(userId)) {
    return reply({ error: 'userId must be a Clerk user id (user_...).' }, 400);
  }

  const removed = await clerkRequest(
    env,
    `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  if (!removed.ok && removed.status !== 404) {
    await invalidateMemberCache(env, orgId, userId);
    return reply(
      { error: CLERK_UNAVAILABLE_ERROR, code: 'org_clerk_failed' satisfies OrgAdminRefusalCode },
      502,
    );
  }

  let rowRemoved = false;
  try {
    await env.DB?.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')
      .bind(orgId, userId)
      .run();
    rowRemoved = true;
  } catch (error) {
    console.error('org admin: the Clerk membership was removed and the row was not.', error);
  }

  await invalidateMemberCache(env, orgId, userId);

  if (!rowRemoved) {
    return reply(
      { error: PARTIAL_WRITE_ERROR, code: 'org_partial_write' satisfies OrgAdminRefusalCode },
      502,
    );
  }

  return reply({
    orgId,
    userId,
    level: null,
    clerkMembership: removed.ok ? 'removed' : 'absent',
  } satisfies OrgMemberWriteResponse);
}

// --- POST tier ------------------------------------------------------------

/**
 * Assigns an organisation's tier through the ONE provisioning path
 * (Requirement 19.5), and takes it back out of entitlement with
 * {@link UNPAID_ORG_TIER}.
 *
 * NO Stripe object is created or read anywhere on this path, and no credit grant
 * is made: raising a ceiling is a tier change (Requirement 19.10), and
 * `credit_grants.stripe_payment_id` is `NOT NULL UNIQUE` precisely so a grant
 * cannot exist without a payment.
 *
 * The status follows the tier rather than being a second parameter, because the
 * two cannot legitimately disagree here: a paid tier that is not `active` is not
 * entitled, and an unpaid tier that IS active would reconcile a runtime key for an
 * organisation nobody is invoicing.
 */
async function setOrganisationTier(
  request: Request,
  env: OrgAdminEnv,
  store: TenantStore,
  reply: AdminRespond,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    orgId?: unknown;
    tier?: unknown;
    email?: unknown;
    rotateKey?: unknown;
  } | null;

  const orgId = typeof body?.orgId === 'string' ? body.orgId : '';
  if (!isOrgId(orgId)) {
    return reply({ error: 'orgId must be an organisation id (org_...).' }, 400);
  }
  const tier = typeof body?.tier === 'string' ? body.tier : '';
  if (!assignableTiers().includes(tier)) {
    return reply(
      {
        error:
          `tier must be one of ${assignableTiers().join(', ')}. A bespoke tier is provisioned ` +
          `through the admin provisioning endpoint.`,
      },
      400,
    );
  }
  const status: TenantRecord['status'] =
    tier === UNPAID_ORG_TIER ? UNPAID_ORG_STATUS : 'active';

  const provisioned = await provisionTenantTier(env, store, {
    id: orgId,
    email: typeof body?.email === 'string' ? body.email : null,
    tier,
    status,
    rotate: body?.rotateKey === true,
  });
  if (!provisioned) {
    return reply({ error: 'The tenant was written but could not be read back.' }, 500);
  }

  const { tenant, key } = provisioned;
  return reply({
    orgId,
    tier: tenant.tier,
    status: tenant.status,
    // Reported rather than assumed. A mint or a limit patch can fail while the
    // tenant row is perfectly written, and the operator reading this is the only
    // one who can act on it.
    runtimeKeyProvisioned: key.keyPresent,
    runtimeKeyAction: key.action,
    runtimeKeyLimitUsd: key.limitUsd,
    supersededKeyDisabled: key.supersededKeyDisabled,
    ...(key.detail ? { runtimeKeyDetail: key.detail } : {}),
  } satisfies OrgTierResponse);
}
