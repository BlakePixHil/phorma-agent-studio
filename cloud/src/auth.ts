/**
 * Shared auth verification for the cloud runtime.
 *
 * Hosted mode: Clerk session JWTs only (fail closed).
 * BYO mode: Clerk when configured, PHORMA_TOKEN fallback, open when neither.
 */

import { verifyToken as clerkVerifyToken } from '@clerk/backend';

export interface AuthEnv {
  PHORMA_MODE?: string;
  PHORMA_TOKEN?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
}

/** The identity attached to an authorized request. */
export interface AuthContext {
  /** Clerk userId (JWT sub) — null for shared-token / open-instance access. */
  userId: string | null;
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
  if (!isHosted(env) && !hasAnySecret(env)) return { userId: null }; // open instance
  if (!token) return null;

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
      if (payload.sub) return { userId: payload.sub };
    } catch {
      // Not a valid Clerk token — BYO mode may fall through to PHORMA_TOKEN.
    }
  }

  // Hosted mode: Clerk is the only accepted credential. Fail closed.
  if (isHosted(env)) return null;

  // BYO fallback: shared static token (anonymous identity).
  const shared = env.PHORMA_TOKEN;
  return shared && token === shared ? { userId: null } : null;
}

/** Extracts + verifies the Authorization header of a request. */
export async function verifyRequest(env: AuthEnv, request: Request): Promise<AuthContext | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return !isHosted(env) && !hasAnySecret(env) ? { userId: null } : null;
  }
  return verifyBearer(env, header.slice('Bearer '.length).trim());
}
