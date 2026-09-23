/**
 * Read-only audited impersonation: an operator reads any organisation exactly as
 * its members see it, cannot write, and leaves one audit row per accepted request
 * (multi-organisation-phorma Requirement 14, design section 11).
 *
 * ## One module, because there is one header and one table
 *
 * `X-Phorma-Act-As` is read in exactly one place ({@link readActAsHeader}) and
 * `impersonation_audit` is written in exactly one place
 * ({@link writeImpersonationAudit}) and read in exactly one place
 * ({@link handleImpersonationAdminRequest}). A second reader of the header would
 * be a second chance to honour it for somebody who is not an operator; a second
 * writer of the table would be a second chance to skip the await.
 *
 * ## Null covers three cases that must be INDISTINGUISHABLE from outside
 *
 * {@link resolveImpersonation} answers null for: no header, a header from a
 * caller who is not an operator, and a header carrying a value `isOwnerId`
 * rejects. In ALL THREE the request is served as the caller's own resolved owner,
 * with no refusal and no distinguishing response (Requirement 14.4), so probing
 * the header reveals nothing about who is an operator or which organisations
 * exist. That is the same discipline `resolveRequestedOwner` follows for
 * `X-Phorma-Owner`, and the two headers stay separate for the reason stated on
 * that function: one header for both would make the difference between "my
 * organisation" and "a customer's organisation" a property of who is asking
 * rather than of what was asked.
 *
 * ## NO session state
 *
 * Every impersonated request carries the header (Requirement 14.13), so there is
 * nothing to expire, revoke or leak, and a header-free request immediately after
 * an impersonated one resolves the caller's own owner with no "end impersonation"
 * step to forget.
 *
 * ## Enforced at three independent layers
 *
 * Neither layer alone is the boundary (Requirement 14.7):
 *
 *  1. **The gateway and the control plane.** {@link guardImpersonation} refuses a
 *     WebSocket upgrade outright and any non-GET method with 403
 *     `impersonation_read_only`, BEFORE `routeAgentRequest` runs and before any
 *     `/api/*` route is dispatched.
 *  2. **The instance.** `WorkflowAgent.authorized` applies
 *     {@link applyImpersonation}, so `requireCapability` sees
 *     `AuthorizedCaller.impersonated` and refuses a write FIRST, before the level
 *     comparison - an operator who ALSO holds a real membership in the target
 *     organisation still cannot write through the header. Their membership is the
 *     write path (Requirement 14.14) and it does not travel with the header.
 *  3. **The entitlement gate.** `resolveHostedInference` refuses
 *     `impersonation_read_only` for any tenant state, so an impersonated request
 *     spends no credits even if both layers above were bypassed
 *     (Requirement 14.6).
 *
 * ## The audit write REFUSES the request when it fails
 *
 * Awaited, never `ctx.waitUntil`ed: a `waitUntil` failure cannot refuse the
 * request, and Requirement 14.10 is explicit that an unaudited impersonated read
 * never happens. The cost is one D1 write on the request path, which is acceptable
 * precisely because impersonation is a support action measured in dozens per day -
 * the opposite trade from `getTenant`'s KV cache, and stated here so nobody later
 * "optimises" it into a background write.
 */

import {
  noStoreResponder,
  refuseNonOperator,
  resolveOperator,
  type AdminAuthEnv,
  type AdminRespond,
} from './admin-auth';
import { type AuthContext } from './auth';
import { impersonationReadOnly } from './role-gate';
import { isOwnerId, type TenantEnv } from './tenants';

/** Every binding this module touches: the operator gate's, plus D1 for the audit. */
export type ImpersonationEnv = AdminAuthEnv & TenantEnv;

/** JSON responder, bound by the caller to whatever CORS set applies. */
export type ImpersonationResponder = (body: unknown, status?: number) => Response;

// ── The header ───────────────────────────────────────────────────────────────

/**
 * The header an operator names somebody else's owner with (Requirement 14.2).
 *
 * Deliberately NOT `X-Phorma-Owner`, which is a member naming their OWN
 * organisation and is checked against `org_members`. This one is checked against
 * the operator allowlist, is read-only, and is audited.
 */
export const ACT_AS_HEADER = 'X-Phorma-Act-As';

/**
 * Bound on the header value before it reaches an id classifier or a D1 bind.
 * Generous against a Clerk id and small enough that nothing pathological gets
 * copied around. The same bound `readRequestedOrg` applies to its own header.
 */
const ACT_AS_MAX_CHARS = 128;

/**
 * The raw owner id the request NAMES, or null. Meaningless on its own: it is a
 * request, not a credential, and only {@link resolveImpersonation} can turn it
 * into an owner.
 */
export function readActAsHeader(request: Request): string | null {
  const raw = request.headers.get(ACT_AS_HEADER);
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ACT_AS_MAX_CHARS) return null;
  return value;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** An accepted impersonation: whose data to serve, and who asked for it. */
export interface Impersonation {
  /** The owner the request is served as. */
  ownerId: string;
  /** The operator's own Clerk user id. Recorded on every audit row. */
  actingUserId: string;
}

/**
 * The impersonated owner and the acting operator, or null.
 *
 * ORDER IS DELIBERATE: the header is read FIRST, so a request that does not name
 * anybody costs one header read and no token verification at all - which is every
 * request this worker serves. Only a request that DOES name an owner pays for the
 * operator check.
 *
 * `isOwnerId` is the shape gate, and it is the same WRITE-path classifier
 * `/api/provision` uses rather than a second regex here: the value becomes a
 * Durable Object name prefix, a registry key segment and a D1 bind, so it is
 * exactly a write-shaped input. It also refuses a colon by construction, so
 * `ownerIdIsAddressable` has nothing left to catch.
 */
export async function resolveImpersonation(
  request: Request,
  env: ImpersonationEnv,
): Promise<Impersonation | null> {
  const requested = readActAsHeader(request);
  if (requested === null || !isOwnerId(requested)) return null;

  const operator = await resolveOperator(request, env);
  if (operator === null) return null;

  return { ownerId: requested, actingUserId: operator.userId };
}

/**
 * The caller's context with the impersonated owner substituted, or the context
 * unchanged when nothing was impersonated.
 *
 * PURE, and the only place the flag is set. `impersonated` is not a field on
 * `AuthContext` because `auth.ts` is about VERIFICATION and the act-as header is
 * resolved a layer above it - so the flag travels BESIDE the verified fields, and
 * `role-gate.ts` reads it tolerantly (absent reads as false, which is every
 * request that named nobody).
 *
 * EXACTLY ONE FIELD MOVES: `ownerId`, which is the whole of "whose data is this".
 * `orgId`, `orgRole`, `userId` and `kind` keep their VERIFIED values, because they
 * answer "who is asking" and the header does not change that. Two consequences
 * worth stating, because both were the alternative design:
 *
 *  - `resolveRole` still resolves the operator's OWN level, so an impersonated read
 *    is not refused `role_unknown` for the operator having no membership in the
 *    organisation they are reading. Substituting `orgId` as well would have made
 *    every impersonated read fail that way, which would have deleted the read half
 *    of the whole feature. The level is not what admits the read either way - reads
 *    are open to every level (Requirement 6.3) - and a WRITE is refused by the
 *    impersonation check before any level is compared.
 *  - Anything that must compare the addressed owner has to read `ownerId` rather
 *    than call `resolveOwner`, which recomputes `orgId ?? userId` and therefore
 *    answers the operator's own account. `WorkflowAgent.enforceOwnership` reads the
 *    field for exactly this reason, which is also what `resolveOwner`'s own doc
 *    comment asks of a caller holding a context it did not verify itself.
 */
export function applyImpersonation(
  auth: AuthContext,
  impersonation: Impersonation | null,
): AuthContext & { impersonated: boolean } {
  if (impersonation === null) return { ...auth, impersonated: false };
  return { ...auth, ownerId: impersonation.ownerId, impersonated: true };
}

// ── The refusals ─────────────────────────────────────────────────────────────

/**
 * The refusal codes this requirement introduces. APPEND-ONLY, comprising exactly
 * these two (Requirement 14.15).
 *
 * `impersonation_read_only` is also declared in `role-gate.ts`'s own refusal set,
 * because that gate is one of the three places it is answered. This alias exists
 * so the PAIR this requirement introduces is enumerable in one place rather than
 * scattered across the three.
 */
export type ImpersonationRefusalCode = 'impersonation_read_only' | 'impersonation_unaudited';

/**
 * 403 for an impersonated request whose audit row could not be written
 * (Requirement 14.10).
 *
 * No part of the requested resource is served: this replaces the response, it does
 * not accompany it, so an unaudited impersonated read never happens.
 */
export function impersonationUnaudited(respond: ImpersonationResponder): Response {
  return respond(
    {
      error: 'This impersonated request could not be recorded, so it was not served.',
      code: 'impersonation_unaudited' satisfies ImpersonationRefusalCode,
    },
    403,
  );
}

// ── The guard ────────────────────────────────────────────────────────────────

/**
 * The whole impersonation policy for one accepted impersonation: refuse a write,
 * refuse an upgrade, record the read. Returns the refusal to return unchanged, or
 * null when the request may proceed as the impersonated owner.
 *
 * Called by BOTH enforcement layers (the gateway in `index.ts` and the control
 * plane in `api.ts`) so the order below exists once. A request reaches exactly one
 * of them, so exactly one audit row is written per accepted request
 * (Requirement 14.8).
 *
 * The order is load-bearing:
 *
 *  1. **A WebSocket upgrade is refused OUTRIGHT** rather than treated as a read.
 *     An upgrade is a `GET`, so a method check alone would admit it - and the
 *     monitor socket accepts `approval`, `question`, `event`, `trigger` and `stop`
 *     control frames, so it is a write channel wearing a read's clothes.
 *  2. **Any non-GET is refused** `impersonation_read_only` (Requirement 14.5).
 *     `HEAD` and `OPTIONS` are not GETs either, and refusing them costs nothing:
 *     an operator reading a customer's data issues GETs.
 *  3. **The audit row is written and AWAITED.** A failure refuses the request.
 *
 * Steps 1 and 2 come BEFORE the write, which is what makes Requirement 14.9 true:
 * a refused impersonated request leaves no audit row, because the only row this
 * table ever gets is for a request that was actually served.
 */
export async function guardImpersonation(
  request: Request,
  url: URL,
  impersonation: Impersonation,
  env: ImpersonationEnv,
  respond: ImpersonationResponder,
): Promise<Response | null> {
  const upgrading = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if (upgrading || request.method.toUpperCase() !== 'GET') {
    return impersonationReadOnly(respond);
  }

  const audited = await writeImpersonationAudit(env, {
    actingUserId: impersonation.actingUserId,
    ownerId: impersonation.ownerId,
    method: request.method.toUpperCase(),
    path: auditPathOf(url),
  });
  return audited ? null : impersonationUnaudited(respond);
}

// ── The audit ────────────────────────────────────────────────────────────────

/** One row of {@link writeImpersonationAudit}, before the clock is stamped. */
export interface ImpersonationAuditEntry {
  actingUserId: string;
  ownerId: string;
  method: string;
  /** The request path, WITHOUT the query string. See {@link auditPathOf}. */
  path: string;
}

/**
 * The path as the audit records it: no query string, ever.
 *
 * A query string carries cursors and, on some routes, values that have no
 * business being copied into a second table - the same reasoning that kept a raw
 * payload column out of `stripe_events`. `url.pathname` is already query-free;
 * this function exists so that fact is stated once and asserted once rather than
 * re-derived at each call site.
 */
export function auditPathOf(url: URL): string {
  return url.pathname;
}

/**
 * Appends one `impersonation_audit` row. True when the row landed.
 *
 * FALSE rather than a throw for every failure, because the caller's answer to
 * both is the same refusal and a throw here would surface as a 500 that says
 * nothing about auditing. An absent `DB` is one of those failures: a worker that
 * cannot record an impersonated read must not serve one. That case is unreachable
 * in practice - impersonation needs an operator allowlist and a `clerk`
 * credential, neither of which a BYO worker has - and it is still the right
 * answer.
 *
 * `at` is an ISO 8601 UTC string, matching every other timestamp column in this
 * schema, so an operator reading the table needs no unit conversion.
 *
 * The table is APPEND-ONLY: nothing in this worker updates or deletes a row, and
 * there is deliberately no retention sweep - an audit you prune is an audit with a
 * hole, and this one grows by dozens of rows a day.
 */
export async function writeImpersonationAudit(
  env: ImpersonationEnv,
  entry: ImpersonationAuditEntry,
): Promise<boolean> {
  if (!env.DB) {
    console.error('impersonation audit: no DB binding, so the request cannot be served.');
    return false;
  }
  try {
    await env.DB.prepare(
      'INSERT INTO impersonation_audit (acting_user_id, owner_id, method, path, at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        entry.actingUserId,
        entry.ownerId,
        entry.method,
        entry.path,
        new Date().toISOString(),
      )
      .run();
    return true;
  } catch (error) {
    // The id is OURS, not a caller's, so logging it is safe and is the only way to
    // tell "the table is missing" from "the write raced a schema change".
    console.error('impersonation audit write failed; refusing the request.', error);
    return false;
  }
}

// ── GET /api/admin/impersonation ─────────────────────────────────────────────

/**
 * The route path this module owns (Requirement 14.11).
 *
 * A FOURTH operator prefix rather than a sixth telemetry aggregate, for the same
 * reason billing and organisations are their own: a telemetry body carries no
 * install id by construction, while this body names identified PEOPLE on purpose -
 * "who read this customer's data, and when" is not answerable without the ids.
 *
 * No trailing slash, unlike the other three families, because there is exactly one
 * route here and inventing a sub-path for it would imply more.
 */
export const IMPERSONATION_ADMIN_PATH = '/api/admin/impersonation';

/** Rows returned when the caller names no bound. */
export const IMPERSONATION_AUDIT_DEFAULT_LIMIT = 100;

/** Hard cap, so one read cannot walk an unbounded history. */
export const IMPERSONATION_AUDIT_MAX_LIMIT = 500;

/** The fixed sentence a failed read answers with. No vendor or SQL prose, ever. */
export const IMPERSONATION_AUDIT_FAILED_ERROR = 'Impersonation audit unavailable.';

/** One audit row, as the dashboard sees it. */
export interface ImpersonationAuditRow {
  id: number;
  actingUserId: string;
  ownerId: string;
  method: string;
  /** The request path. Carries no query string by construction. */
  path: string;
  /** ISO 8601 UTC. */
  at: string;
}

/** `GET /api/admin/impersonation`. */
export interface ImpersonationAuditResponse {
  entries: ImpersonationAuditRow[];
  /** The owner filter in force, or null when the read was unfiltered. */
  owner: string | null;
  /** The row bound applied. */
  limit: number;
  /** True when the bound was reached, so older rows exist. */
  truncated: boolean;
  generatedAt: string;
}

/**
 * Serves the append-only audit to an operator, or returns null when the path is
 * not this route - matching every other route helper in this worker.
 *
 * READ-ONLY: there is no write, no delete and no retention parameter, so the
 * append-only claim is a property of the surface rather than a promise about it.
 *
 * Behind `refuseNonOperator`, which runs BEFORE the method check so an
 * unauthorized caller cannot use the response code to learn the route exists. An
 * absent `DB` is a 501 NAMING the binding rather than an empty list, for the same
 * reason the organisation family does it: "nobody has impersonated anybody" and
 * "this worker cannot answer" are different statements, and only one of them is
 * safe to read as reassurance.
 */
export async function handleImpersonationAdminRequest(
  request: Request,
  env: ImpersonationEnv,
  url: URL,
  respond: AdminRespond,
): Promise<Response | null> {
  if (url.pathname.replace(/\/$/, '') !== IMPERSONATION_ADMIN_PATH) return null;

  const reply = noStoreResponder(respond);

  const refusal = await refuseNonOperator(request, env, reply);
  if (refusal) return refusal;

  if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
  if (!env.DB) {
    return reply({ error: 'Impersonation audit unavailable: no DB binding.' }, 501);
  }

  const limit = readLimit(url.searchParams.get('limit'));
  const owner = readOwnerFilter(url.searchParams.get('owner'));
  if (owner === false) return reply({ error: 'Invalid owner filter.' }, 400);

  try {
    // Ordered by `id`, the rowid, and never by `at`: two rows from one busy second
    // tie to the millisecond, and the newest-first order is the whole point of the
    // read. `idx_impersonation_owner` covers the filtered form.
    const statement =
      owner === null
        ? env.DB.prepare(
            'SELECT id, acting_user_id, owner_id, method, path, at FROM impersonation_audit ' +
              'ORDER BY id DESC LIMIT ?',
          ).bind(limit)
        : env.DB.prepare(
            'SELECT id, acting_user_id, owner_id, method, path, at FROM impersonation_audit ' +
              'WHERE owner_id = ? ORDER BY id DESC LIMIT ?',
          ).bind(owner, limit);

    const { results } = await statement.all<{
      id: number;
      acting_user_id: string;
      owner_id: string;
      method: string;
      path: string;
      at: string;
    }>();
    const rows = results ?? [];
    return reply({
      entries: rows.map(row => ({
        id: row.id,
        actingUserId: row.acting_user_id,
        ownerId: row.owner_id,
        method: row.method,
        path: row.path,
        at: row.at,
      })),
      owner,
      limit,
      truncated: rows.length === limit,
      generatedAt: new Date().toISOString(),
    } satisfies ImpersonationAuditResponse);
  } catch (error) {
    console.error('impersonation audit read failed.', error);
    return reply({ error: IMPERSONATION_AUDIT_FAILED_ERROR }, 500);
  }
}

/** The row bound, clamped. Anything unreadable falls back to the default. */
function readLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return IMPERSONATION_AUDIT_DEFAULT_LIMIT;
  return Math.min(parsed, IMPERSONATION_AUDIT_MAX_LIMIT);
}

/**
 * The owner filter: a valid owner id, null for no filter, or `false` for a value
 * that is not an owner id at all.
 *
 * `false` rather than "ignore it": a filtered read that silently answered
 * UNFILTERED would show an operator every organisation's rows while they believed
 * they were looking at one customer's.
 */
function readOwnerFilter(raw: string | null): string | null | false {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;
  return isOwnerId(value) ? value : false;
}
