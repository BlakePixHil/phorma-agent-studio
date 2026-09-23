/**
 * The operator gate every `/api/admin/*` surface shares.
 *
 * There are now four of them - `/api/admin/telemetry/*` (product aggregates),
 * `/api/admin/billing/*` (cost and revenue), `/api/admin/organisations/*` (org and
 * member management) and `/api/admin/impersonation` (the impersonation audit) -
 * and they must be the SAME door. This module exists because the alternative is
 * four authorization implementations for one privilege, which is how one of them
 * starts admitting what the others refuse.
 *
 * Two exports answer the gate question, and the difference matters:
 * {@link refuseNonOperator} decides whether a route may run and hands back NO
 * identity, while {@link resolveOperator} hands back the acting user id and
 * refuses nothing. See the doc comment on each.
 *
 * ## The gate, in the order it decides
 *
 * | Condition                                                   | Status | Body                        |
 * |-------------------------------------------------------------|--------|-----------------------------|
 * | No bearer token at all                                      | 401    | `{"error":"Unauthorized."}` |
 * | `verifyRequest` returns null                                | 401    | `{"error":"Unauthorized."}` |
 * | Verified, but not a CLERK identity                          | 403    | `{"error":"Forbidden."}`    |
 * | Verified Clerk identity, user id null or not on the allowlist| 403    | `{"error":"Forbidden."}`    |
 * | `TELEMETRY_ADMIN_USER_IDS` absent, empty or whitespace-only  | 403    | `{"error":"Forbidden."}`    |
 * | Allowlisted                                                 | -      | the route runs              |
 *
 * Both failure bodies are fixed literals. No admin route returns the allowlist
 * and no response body ever names an entry in it, so a refusal cannot be used to
 * enumerate operators.
 *
 * ## Three decisions worth not re-litigating
 *
 * **The absent bearer is checked HERE rather than left to `verifyRequest`**,
 * which hands an anonymous context to an unprotected BYO worker. That identity
 * would otherwise reach the allowlist check and answer 403 for a request that
 * carried no credential at all - "you are not an operator" for someone who never
 * said who they were.
 *
 * **A missing secret means NO access, never open access.** The allowlist is the
 * only key to these surfaces, so an unset secret closes the door rather than
 * removing it. That is the opposite of the usual "unconfigured is 501" rule in
 * this worker, and deliberately so: a 501 on `/api/checkout` tells an operator
 * to bind a secret, whereas a 501 here would be a hint that the surface exists
 * and is merely unguarded.
 *
 * **A Phorma DESKTOP token is refused with 403, not admitted.** It carries the
 * same `userId` as the Clerk session that minted it, so without the `kind` check
 * an operator signing in on the desktop app would carry operator access on a
 * long-lived bearer sitting in a laptop keychain that cannot be revoked before
 * it expires. Operator surfaces want a human who authenticated in a browser just
 * now. It is 403 rather than 401 because the credential IS valid - it is just not
 * an operator credential.
 *
 * ## The secret name is historical, and renaming it is not free
 *
 * `TELEMETRY_ADMIN_USER_IDS` was named when telemetry was the only admin
 * surface. It is now the operator allowlist for billing too. The name stays
 * because renaming a Worker secret is a `wrangler secret put` plus a
 * `wrangler secret delete` plus a deploy, with a window in between where one of
 * the two surfaces answers 403 for everyone - real downside, zero functional
 * gain. One secret, one allowlist, one door; the name is just older than the
 * second room.
 */

import { verifyRequest, type AuthEnv } from './auth';

/** The bindings the gate reads: the auth chain, plus the allowlist secret. */
export type AdminAuthEnv = AuthEnv & {
  /**
   * Comma-separated Clerk user ids allowed to read every `/api/admin/*` surface.
   * A Worker secret, never a `var` - it names individuals.
   */
  TELEMETRY_ADMIN_USER_IDS?: string;
};

/**
 * The JSON responder `routeApiRequest` owns, passed in so CORS stays in one
 * place rather than being rebuilt per admin module.
 */
export type AdminRespond = (body: unknown, status?: number) => Response;

/** The two fixed refusal bodies. Exported so a test asserts the literal, not a copy. */
export const ADMIN_UNAUTHORIZED_ERROR = 'Unauthorized.';
export const ADMIN_FORBIDDEN_ERROR = 'Forbidden.';

/**
 * Exact membership in the operator allowlist after trimming each entry.
 *
 * NEVER a substring, prefix or `includes()` test on the raw secret: with a raw
 * substring check `user_123` would authorize `user_1234`, and an allowlist that
 * silently admits longer ids is not an allowlist. The secret is split on commas,
 * each entry is trimmed, empties are dropped, and the caller's id must equal one
 * of the survivors.
 *
 * An absent, empty or whitespace-only secret has no surviving entry, so this
 * returns false for every caller. A null user id - a shared-token or
 * open-instance identity - is never a member.
 *
 * OPERATIONAL TRAP, paid for on 2026-09-09: the secret is a BARE comma-separated
 * list, not JSON. `["user_a","user_b"]` splits into `["user_a` and `"user_b"]`,
 * neither of which equals a user id, so a JSON-shaped value fails closed and
 * every operator reads 403 with nothing in the log to say why. Setting it wrong
 * looks exactly like not being an operator.
 */
export function isOperator(allowlist: string | undefined, userId: string | null): boolean {
  if (!allowlist) return false;
  const ids = allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) return false; // fail closed
  return userId !== null && ids.includes(userId);
}

/**
 * Runs the gate. Returns `null` when the caller IS an operator, or the refusal
 * `Response` to return unchanged when they are not.
 *
 * `null` means "proceed" rather than an authorized-identity object because no
 * admin route needs to know WHICH operator is asking - these surfaces are
 * account-wide reads, not per-user ones. Handing back an identity nobody uses
 * would invite a route to start scoping by it, which is a different feature with
 * different requirements.
 *
 * The `reply` passed in should already be `noStore`-wrapped by the caller, so an
 * authorization failure cannot be cached either.
 */
export async function refuseNonOperator(
  request: Request,
  env: AdminAuthEnv,
  reply: AdminRespond,
): Promise<Response | null> {
  const token = readBearerToken(request);
  if (token === null) return reply({ error: ADMIN_UNAUTHORIZED_ERROR }, 401);

  const auth = await verifyRequest(env, request);
  if (auth === null) return reply({ error: ADMIN_UNAUTHORIZED_ERROR }, 401);

  if (auth.kind !== 'clerk' || !isOperator(env.TELEMETRY_ADMIN_USER_IDS, auth.userId)) {
    return reply({ error: ADMIN_FORBIDDEN_ERROR }, 403);
  }

  return null;
}

/**
 * The operator's identity, or `null` when the caller is not one
 * (Requirement 14.1).
 *
 * A SEPARATE function rather than a change to {@link refuseNonOperator}, whose
 * `null`-means-proceed contract stays exactly as it is. That contract exists
 * because no admin route needs to know WHICH operator is asking, and handing back
 * an identity nobody uses would invite a route to start scoping by it - a
 * different feature with different requirements. Impersonation IS that feature: it
 * needs the acting user id, because every accepted impersonated request records it
 * in `impersonation_audit`.
 *
 * It reuses {@link readBearerToken}, `verifyRequest` and {@link isOperator}, so
 * the gate's non-negotiable rules hold here identically: an absent bearer is not
 * an operator, a non-`clerk` credential is not an operator (so a long-lived `phd_`
 * desktop token sitting in a laptop keychain can never impersonate,
 * Requirement 14.3), and an absent or whitespace-only allowlist means NO operator
 * rather than every caller.
 *
 * It answers `null` rather than a `Response` on purpose: the one caller
 * (`resolveImpersonation` in `impersonation.ts`) must refuse nothing, because a
 * request from a non-operator carrying an act-as header is served as the caller's
 * own owner with no refusal and no distinguishing response (Requirement 14.4).
 */
export async function resolveOperator(
  request: Request,
  env: AdminAuthEnv,
): Promise<{ userId: string } | null> {
  if (readBearerToken(request) === null) return null;

  const auth = await verifyRequest(env, request);
  if (auth === null || auth.kind !== 'clerk') return null;
  if (!isOperator(env.TELEMETRY_ADMIN_USER_IDS, auth.userId)) return null;

  // `isOperator` is false for a null user id, so this is a narrowing rather than
  // an assumption.
  return { userId: auth.userId as string };
}

/**
 * Wraps the shared responder so every answer carries `Cache-Control: no-store`.
 *
 * Aggregated product telemetry must never sit in a shared cache, cost and
 * revenue figures even less so, and an authorization failure must not be cached
 * either - a cached 403 would outlive an allowlist change.
 */
export function noStoreResponder(respond: AdminRespond): AdminRespond {
  return (body: unknown, status = 200): Response => {
    const base = respond(body, status);
    const headers = new Headers(base.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(base.body, { status: base.status, headers });
  };
}

/**
 * The bearer token, or `null` when the request carries none. An empty or
 * whitespace-only token counts as none: it is an absent credential, not a
 * rejected one.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
