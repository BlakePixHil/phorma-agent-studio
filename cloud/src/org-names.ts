/**
 * Organisation DISPLAY NAMES for `/api/me`'s `owners` list.
 *
 * ## Why this exists
 *
 * `org_members` is the authoritative membership source and deliberately holds no
 * name: names belong to Clerk, which is where `org-admin.ts` creates an
 * organisation. The studio used to recover names from Clerk's
 * `user.organizationMemberships`, which only exists in a browser session - a
 * desktop install signs in through the device handoff and has no Clerk user at
 * all, so every organisation rendered as `Organisation <last six id chars>` in
 * the owner switcher. The worker already holds `CLERK_SECRET_KEY`, so it resolves
 * the names once for both credential kinds.
 *
 * ## Cost and caching
 *
 * `/api/me` is polled, so a Clerk round trip per membership per poll is not
 * acceptable. A name is cached in `TENANTS` KV under `orgname:{orgId}` for an
 * hour: a rename is rare, and an hour-stale label is harmless because nothing
 * DECIDES with a name. A MISS is cached too (as a null name, for a shorter TTL),
 * because an organisation Clerk cannot answer for would otherwise be re-fetched on
 * every poll.
 *
 * ## Failure shape
 *
 * Never throws and never blocks `/api/me` on Clerk: every lookup is bounded, and a
 * failed one answers `null`, which the studio renders with its id-based fallback.
 * The vendor body is logged, never forwarded, the same rule `org-admin.ts` follows.
 */

import type { AuthEnv } from './auth';
import type { TenantEnv } from './tenants';

/** Every binding this module touches. */
export type OrgNameEnv = Pick<AuthEnv, 'CLERK_SECRET_KEY'> & Pick<TenantEnv, 'TENANTS'>;

/** How long a resolved name is trusted. Nothing decides with a name. */
export const ORG_NAME_CACHE_TTL_S = 60 * 60;

/** How long a MISS is trusted, so an unanswerable id is not re-fetched per poll. */
export const ORG_NAME_MISS_TTL_S = 5 * 60;

/** Bounded so a Clerk stall cannot hold the profile poll open. */
const CLERK_TIMEOUT_MS = 3_000;

/** Longest name reported. Clerk's own cap is higher; this bounds the wire. */
export const ORG_NAME_REPORT_MAX = 120;

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/** Every outbound request sets a User-Agent; several vendors refuse without one. */
const USER_AGENT = 'phorma-agent-studio-cloud';

/** KV key for one organisation's name. Namespaced away from tenant rows. */
export function orgNameCacheKey(orgId: string): string {
  return `orgname:${orgId}`;
}

/**
 * Seeds the cache with a name the caller already knows - `org-admin.ts` has the
 * name in hand the moment Clerk creates the organisation, so the first `/api/me`
 * after a creation needs no Clerk read at all. Never throws.
 */
export async function rememberOrgName(
  env: Pick<TenantEnv, 'TENANTS'>,
  orgId: string,
  name: string | null,
): Promise<void> {
  const clean = cleanName(name);
  if (clean === null) return;
  try {
    await env.TENANTS?.put(orgNameCacheKey(orgId), JSON.stringify({ name: clean }), {
      expirationTtl: ORG_NAME_CACHE_TTL_S,
    });
  } catch (error) {
    console.error(`org names: could not cache the name for ${orgId}.`, error);
  }
}

/**
 * Display names for a set of organisation ids, keyed by id. An id with no
 * resolvable name maps to null. Lookups run in parallel and each is bounded.
 */
export async function resolveOrgNames(
  env: OrgNameEnv,
  orgIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(orgIds)];
  // NO CACHE, NO LOOKUP. Without `TENANTS` every profile poll would be a Clerk
  // round trip per membership, which is the cost this module exists to avoid.
  // The hosted worker always binds it; a BYO worker has no organisations at all.
  if (!env.TENANTS) return new Map(unique.map(orgId => [orgId, null] as const));
  const entries = await Promise.all(
    unique.map(async orgId => [orgId, await resolveOrgName(env, orgId)] as const),
  );
  return new Map(entries);
}

async function resolveOrgName(env: OrgNameEnv, orgId: string): Promise<string | null> {
  const cacheKey = orgNameCacheKey(orgId);
  try {
    const cached = await env.TENANTS?.get(cacheKey, 'json');
    if (cached && typeof cached === 'object' && 'name' in cached) {
      return cleanName((cached as { name?: unknown }).name);
    }
  } catch (error) {
    console.error(`org names: cache read failed for ${orgId}.`, error);
  }

  const name = await fetchOrgName(env, orgId);
  try {
    await env.TENANTS?.put(cacheKey, JSON.stringify({ name }), {
      expirationTtl: name === null ? ORG_NAME_MISS_TTL_S : ORG_NAME_CACHE_TTL_S,
    });
  } catch (error) {
    console.error(`org names: cache write failed for ${orgId}.`, error);
  }
  return name;
}

async function fetchOrgName(env: OrgNameEnv, orgId: string): Promise<string | null> {
  const secret = env.CLERK_SECRET_KEY;
  if (!secret) return null;
  try {
    const response = await fetch(`${CLERK_API_BASE}/organizations/${encodeURIComponent(orgId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(
        `org names: Clerk GET /organizations/${orgId} answered ${response.status}: ${text.slice(0, 200)}`,
      );
      return null;
    }
    const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
    return cleanName(body?.name);
  } catch (error) {
    console.error(`org names: Clerk lookup for ${orgId} failed.`, error);
    return null;
  }
}

/** A name worth showing, or null. Trimmed and bounded; never an empty string. */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > ORG_NAME_REPORT_MAX ? trimmed.slice(0, ORG_NAME_REPORT_MAX) : trimmed;
}
