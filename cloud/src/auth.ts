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
 */

import { verifyToken as clerkVerifyToken } from '@clerk/backend';

import { isDeviceToken, verifyDeviceToken } from './device-auth';

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

/**
 * Validates a bearer token. Returns the caller's identity on success, null
 * on failure. Open instances (BYO, no secrets) return an anonymous context.
 */
export async function verifyBearer(env: AuthEnv, token: string | null): Promise<AuthContext | null> {
  if (!isHosted(env) && !hasAnySecret(env)) return { userId: null, kind: 'shared' }; // open instance
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
    return verified ? { userId: verified.sub, kind: 'device' } : null;
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
      if (payload.sub) return { userId: payload.sub, kind: 'clerk' };
    } catch {
      // Not a valid Clerk token — BYO mode may fall through to PHORMA_TOKEN.
    }
  }

  // Hosted mode: Clerk and desktop tokens are the only accepted credentials.
  // Fail closed.
  if (isHosted(env)) return null;

  // BYO fallback: shared static token (anonymous identity).
  const shared = env.PHORMA_TOKEN;
  return shared && token === shared ? { userId: null, kind: 'shared' } : null;
}

/** Extracts + verifies the Authorization header of a request. */
export async function verifyRequest(env: AuthEnv, request: Request): Promise<AuthContext | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return !isHosted(env) && !hasAnySecret(env) ? { userId: null, kind: 'shared' } : null;
  }
  return verifyBearer(env, header.slice('Bearer '.length).trim());
}
