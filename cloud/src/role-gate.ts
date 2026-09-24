/**
 * The Role_Gate: ONE seam every write in this worker passes through
 * (Requirement 6.1, design section 6 of
 * `.kiro/specs/multi-organisation-phorma/`).
 *
 * `auth.ts` answers "who is asking" and "whose data is this". This module
 * answers the third question, "what may you do", and it is the SECURITY
 * BOUNDARY (Requirement 6.11). Every capability gate in the studio is a
 * usability feature; this one is the enforcement, and it re-checks what the
 * studio already filtered so an omitted studio-side `minLevel` is a UI defect
 * rather than a security one.
 *
 * ## Inert until an organisation exists
 *
 * `resolveRole` answers `admin` for a credential carrying no organisation claim
 * and `admin` over the `default` owner for a `shared` credential
 * (Requirements 1.4, 5.10, 16.6). Every level comparison below therefore passes
 * on every install that exists today, hosted single-user and BYO alike, with no
 * binding read and no observable change. That is what allowed the gate to be
 * added to every write route in one change without gating anything that works.
 *
 * ## Two exports, and the difference between them matters
 *
 * {@link requireCapability} is the gate. Each call site names the level it
 * requires as a LITERAL, so the level for a route lives beside the route.
 *
 * {@link WRITE_ROUTES} and {@link requiredLevelFor} are DATA: the declaration of
 * what every write route requires, in exactly one place. They exist so
 * `cloud/test/role-gate.test.mjs` can drive every entry against a real route,
 * and so a mutating request the table does not answer can be refused rather than
 * passed (see {@link ROLE_GATE_FALLBACK_LEVEL}).
 *
 * The table is deliberately NOT how a covered route's level is resolved at
 * runtime. A dispatch switch is itself a route table, and deriving the required
 * level from the path inside the dispatch would mean two path matchers for one
 * dispatch, which is how one of them starts admitting what the other refuses.
 *
 * ## Reads stay open
 *
 * Every read route is allowed to every level, `operator` included
 * (Requirement 6.3). An `operator` can read their organisation's prompts,
 * traces and usage: they are a member of it, and the boundary this feature
 * defends is BETWEEN organisations, not within one.
 */

import { resolveRole, type AuthContext } from './auth';
import { atLeast, type CapabilityLevel } from './capabilities';
import type { TenantEnv } from './tenants';

/**
 * The identity a write route may act on, once the gate has admitted it.
 *
 * `userId` and `ownerId` are NULLABLE, unlike everything else here, and the
 * reason is the `shared` credential: a BYO worker protected by `PHORMA_TOKEN`
 * (or an open one) has no user and no owner, `resolveOwner` answers null for it,
 * and every consumer already folds that null to the `default` literal through
 * `deploymentOwner` (Requirement 1.4). Inventing an owner string here would be
 * the gate telling the rest of the worker something untrue.
 */
export interface AuthorizedCaller {
  /** The Clerk user id of the caller, or null for a `shared` credential. */
  userId: string | null;
  /** Whose data the request addresses, or null for a `shared` credential. */
  ownerId: string | null;
  /** The organisation the credential names, or null when it names none. */
  orgId: string | null;
  /** The caller's resolved capability level over {@link ownerId}. */
  level: CapabilityLevel;
  /**
   * True when the owner came from an operator act-as header rather than from the
   * caller's own credential. Writes are refused (Requirement 14.5).
   *
   * Set by `applyImpersonation` (`impersonation.ts`) and read here FIRST, before
   * the level comparison - see {@link requireCapability}. It is true only on a
   * READ that was admitted, because a write carrying it never gets this far.
   */
  impersonated: boolean;
}

/**
 * The refusal codes this module answers with. APPEND-ONLY, like every other
 * refusal set on this wire: a released token is never renamed or repurposed, and
 * a studio three versions old renders an unknown one's prose
 * (Requirements 6.10, 16.2).
 *
 * `role_forbidden` and `role_unknown` are introduced here. The
 * `impersonation_read_only` token belongs to the impersonation requirement
 * (Requirement 14.15) and is answered in three independent places, of which
 * this gate is one.
 */
export type RoleRefusalCode = 'role_unknown' | 'role_forbidden' | 'impersonation_read_only';

/** JSON responder, bound by the caller to whatever CORS set applies. */
export type RoleGateResponder = (body: unknown, status?: number) => Response;

// -- The write-route table ---------------------------------------------------

/**
 * HTTP methods that change state. A method outside this set is a read, and a
 * read is open to every level.
 *
 * `PUT` and `PATCH` are listed although no route uses either today, because the
 * cost of listing them is nothing and the cost of a new `PUT` route sliding past
 * the fail-closed check in {@link ROLE_GATE_FALLBACK_LEVEL} is a silently
 * unguarded write.
 */
export const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** True when the method changes state. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.includes(method.toUpperCase());
}

/** One write route and the level it requires. */
export interface WriteRoute {
  /** The mutating method. One entry per method, never a method union. */
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Matched against the request path.
   *
   * Durable Object routes are SUFFIX anchored (`/\/workflow$/`), because the
   * instance sees the full `/agents/workflow-agent/{instance}/workflow` and
   * matches its own dispatch the same way. Control-plane routes are fully
   * anchored, because `routeApiRequest` compares `url.pathname` exactly.
   */
  match: RegExp;
  /** The Capability_Level a caller must hold. */
  required: CapabilityLevel;
  /** Why this level, in one sentence. Read by nobody; written for the reader. */
  note: string;
}

/**
 * Every write route that EXISTS in this worker, with the level it requires
 * (Requirements 6.4 to 6.7, design section 6.3).
 *
 * A route this feature adds later brings its own entry WITH it rather than
 * having one added here in advance: `cloud/test/role-gate.test.mjs` drives each
 * entry against a real route, so an entry with no route behind it would 404
 * under that drive. The ownership claim route arrived that way, and so did the
 * three proposal routes - each landed with its entry and its probe together.
 *
 * Two routes carry a condition the level does not express, and they are recorded
 * here anyway so the table is the complete list of writes:
 * `POST /api/checkout` and `POST /api/billing-portal` require `admin` AND a
 * PERSONAL owner. An organisation admin resolves `admin`, so the level is not
 * what refuses them - the `billing_managed` refusal above those routes is
 * (Requirement 19.4), and it is deliberately not this module's, because it is
 * about which owner is paying rather than about what the caller may do.
 *
 * Not in this table, on purpose:
 *
 *  - Every `/api/admin/*` family - the telemetry aggregates, the billing reads
 *    and the organisation management writes. They are gated by
 *    `refuseNonOperator` (`admin-auth.ts`), which answers a different
 *    401-versus-403 split and hands back no identity at all, so
 *    `requiredLevelFor` answering `undefined` for `POST /api/admin/...` is
 *    CORRECT rather than a miss. The suite exempts them by name with a reason
 *    each.
 *
 *    The organisation family is the one whose absence from this table is itself a
 *    REQUIREMENT rather than a consequence. Requirement 13.7 says membership is
 *    written through the operator gate alone, so `member.manage` is a DECLARED
 *    capability no route exercises and there must be no `admin`-level member write
 *    in this table at all. `cloud/test/role-gate.test.mjs` asserts that as an
 *    inventory claim over the static scan.
 *  - `POST /api/provision` and `POST /api/deactivate`, for the same reason: they
 *    authenticate against `PHORMA_ADMIN_TOKEN`, which is a shared operator
 *    secret carrying no Clerk identity, so there is no level to resolve.
 *  - `POST /api/stripe/webhook`. Stripe authenticates by HMAC over the raw body
 *    and presents no bearer, so there is no caller to gate.
 */
export const WRITE_ROUTES: readonly WriteRoute[] = [
  // -- Proposals: propose at `editor`, decide at `builder` -------------------
  //
  // The split IS the feature. An editor may submit a prompt, cron or node
  // configuration change and may not deploy one, so creating a proposal is an
  // editor write and publishing or rejecting it is a builder write
  // (Requirements 6.5, 6.6, 12.1). All three arrived WITH their routes, because
  // an entry with no route behind it 404s under the runtime drive.
  //
  // FIRST IN THE TABLE, and that is load-bearing rather than tidy.
  // {@link matchWriteRoute} returns the FIRST matching entry, and the Durable
  // Object routes below are SUFFIX anchored - `/\/publish$/` matches
  // `/api/proposals/{id}/{proposalId}/publish` just as happily as it matches a
  // portal publish. Both require `builder`, so nothing is mis-gated today; what
  // the order buys is that each entry answers the route it was written for, so
  // the suite can prove every entry is driven and a later change to the portal
  // level cannot silently move the proposal one. Anchored entries go before
  // suffix-anchored ones.
  {
    method: 'POST',
    match: /^\/api\/proposals\/[^/]+$/,
    required: 'editor',
    note: 'Submitting a change for review is the editor capability (Requirement 12.1).',
  },
  {
    method: 'POST',
    match: /^\/api\/proposals\/[^/]+\/[^/]+\/publish$/,
    required: 'builder',
    note: 'Publishing a proposal replaces the deployed graph, exactly as a push does.',
  },
  {
    method: 'POST',
    match: /^\/api\/proposals\/[^/]+\/[^/]+\/reject$/,
    required: 'builder',
    note: 'Rejecting a proposal is the reviewer half of the same decision.',
  },
  // -- WorkflowAgent: the graph itself, and everything around it (builder) ---
  {
    method: 'POST',
    match: /\/workflow$/,
    required: 'builder',
    note: 'A spec push replaces the deployed graph (Requirement 6.4).',
  },
  {
    method: 'DELETE',
    match: /\/workflow$/,
    required: 'builder',
    note: 'Undeploying removes the running workflow (Requirement 6.4).',
  },
  {
    method: 'DELETE',
    match: /\/workflow\/purge$/,
    required: 'builder',
    note: 'The full teardown: spec, cron, portal, sessions and every table.',
  },
  {
    method: 'POST',
    match: /\/connections$/,
    required: 'builder',
    note: 'Connection metadata is inventory management, not a value edit.',
  },
  {
    method: 'POST',
    match: /\/publish$/,
    required: 'builder',
    note: 'Publishing a portal puts the organisation on the public internet.',
  },
  {
    method: 'POST',
    match: /\/unpublish$/,
    required: 'builder',
    note: 'Unpublishing takes a live public surface down.',
  },
  {
    method: 'POST',
    match: /\/portal-tokens$/,
    required: 'builder',
    note: 'Minting a portal access key grants access to a published portal.',
  },
  {
    method: 'DELETE',
    match: /\/portal-tokens\/[^/]+$/,
    required: 'builder',
    note: 'Revoking a portal access key cuts off whoever holds it.',
  },
  // -- WorkflowAgent: running and answering a gate (operator) ---------------
  {
    method: 'POST',
    match: /\/trigger$/,
    required: 'operator',
    note: 'Triggering a run is the operator capability (Requirement 6.7).',
  },
  {
    method: 'POST',
    match: /\/events$/,
    required: 'operator',
    note: 'A correlated event resumes a suspended run (Requirement 6.7).',
  },
  {
    method: 'POST',
    match: /\/approvals$/,
    required: 'operator',
    note: 'Answering an approval gate is the only write an operator holds.',
  },
  {
    method: 'POST',
    match: /\/questions$/,
    required: 'operator',
    note: 'Answering an Ask-User gate, for the same reason as an approval.',
  },
  // -- Control plane --------------------------------------------------------
  {
    method: 'POST',
    match: /^\/api\/connection-secrets$/,
    required: 'editor',
    note: 'A connection secret VALUE write is an editor capability (Requirement 6.5).',
  },
  {
    method: 'DELETE',
    match: /^\/api\/connection-secrets$/,
    required: 'editor',
    note: 'Removing a stored value is the same capability as writing one.',
  },
  {
    method: 'POST',
    match: /^\/api\/infer$/,
    required: 'operator',
    note: "Local-run inference spends the owner's credits, exactly as a trigger does.",
  },
  {
    method: 'POST',
    match: /^\/api\/decide$/,
    required: 'operator',
    note: "A System One decision spends the owner's credits, exactly as inference does.",
  },
  {
    method: 'POST',
    match: /^\/api\/fetch$/,
    required: 'operator',
    note: "Reading a public page is egress on the owner's behalf; the lowest level suffices.",
  },
  {
    method: 'POST',
    match: /^\/api\/deployments\/[^/]+\/claim$/,
    required: 'builder',
    note: 'Claiming a deployment into an organisation is a deployment write (Requirement 3.2).',
  },
  {
    method: 'POST',
    match: /^\/api\/checkout$/,
    required: 'admin',
    note: 'Billing is admin AND a personal owner; see the header note on this table.',
  },
  {
    method: 'POST',
    match: /^\/api\/billing-portal$/,
    required: 'admin',
    note: 'Billing is admin AND a personal owner; see the header note on this table.',
  },
];

/**
 * The table entry a request matches, or undefined.
 *
 * The primitive {@link requiredLevelFor} is built from, exported because the
 * suite needs to know WHICH entry a probe exercised in order to prove that every
 * entry is driven by at least one probe. A table entry that no probe reaches is
 * an entry nothing has ever checked.
 */
export function matchWriteRoute(method: string, path: string): WriteRoute | undefined {
  const wanted = method.toUpperCase();
  return WRITE_ROUTES.find(route => route.method === wanted && route.match.test(path));
}

/**
 * The level a write route requires, or undefined when the table does not answer.
 *
 * `undefined` for a MUTATING method is a failure, not a permission: see
 * {@link ROLE_GATE_FALLBACK_LEVEL}.
 */
export function requiredLevelFor(method: string, path: string): CapabilityLevel | undefined {
  return matchWriteRoute(method, path)?.required;
}

/**
 * The level assumed when {@link requiredLevelFor} does not answer a mutating
 * request: the HIGHEST one, so an unguarded write route is broken-closed rather
 * than open (Requirement 6.9).
 *
 * This is the runtime half of "a new write route cannot ship without
 * enforcement". The static half lives in `cloud/test/role-gate.test.mjs`, which
 * scans for mutating method and path literals and fails on any the table does
 * not answer - that is what catches it before anybody observes the 403.
 */
export const ROLE_GATE_FALLBACK_LEVEL: CapabilityLevel = 'admin';

// -- The refusals -----------------------------------------------------------

/**
 * 403 naming the required level in the body (Requirement 6.8).
 *
 * The level is NAMED, never numbered: `required: "builder"` is actionable in a
 * log, a toast and an audit row, where `required: 3` is a lookup - and an
 * ordinal renumbers itself the day a level is inserted (design section 5.2).
 */
export function roleForbidden(
  required: CapabilityLevel,
  respond: RoleGateResponder,
): Response {
  return respond(
    {
      error: `This action needs the ${required} role in this organisation.`,
      code: 'role_forbidden' satisfies RoleRefusalCode,
      required,
    },
    403,
  );
}

/**
 * 403 for a caller whose level cannot be resolved at all (Requirement 5.9).
 *
 * Never a substituted `operator`. That is the "safe minimum" instinct and it is
 * wrong: `operator` can trigger a run, which spends the organisation's credits,
 * so there is no safe minimum and therefore no default.
 */
export function roleUnknown(respond: RoleGateResponder): Response {
  return respond(
    {
      error:
        'Your role in this organisation could not be determined. Ask an organisation ' +
        'admin to check your membership.',
      code: 'role_unknown' satisfies RoleRefusalCode,
    },
    403,
  );
}

/** 403 for a write attempted while impersonating another owner. */
export function impersonationReadOnly(respond: RoleGateResponder): Response {
  return respond(
    {
      error: 'An impersonated session is read-only.',
      code: 'impersonation_read_only' satisfies RoleRefusalCode,
    },
    403,
  );
}

/**
 * The impersonation flag, read tolerantly off the auth context.
 *
 * Deliberately not a required field on `AuthContext`: `auth.ts` is about
 * VERIFICATION and the act-as header is resolved a layer above it, so the flag
 * travels BESIDE the verified fields. `applyImpersonation` (`impersonation.ts`) is
 * the only thing that sets it. Absent reads as false, which is every request that
 * named nobody.
 */
function isImpersonated(auth: AuthContext): boolean {
  return (auth as AuthContext & { impersonated?: boolean }).impersonated === true;
}

// -- The gate ---------------------------------------------------------------

/**
 * The one capability check. Returns the authorized caller, or the refusal
 * Response to return unchanged.
 *
 * Discriminate with `'level' in result`, the idiom `resolveHostedInference`
 * established with `'status' in gate`, so no cast is needed at a call site.
 *
 * Three refusals, in THIS order:
 *
 *  1. An impersonated request on a WRITE. FIRST on purpose: an operator who also
 *     holds a real membership in the target organisation must not be able to write
 *     through the act-as header. Their membership is how they write, and it does
 *     not travel with the header (Requirement 14.14).
 *  2. An unresolvable role -> `role_unknown`.
 *  3. A level below `required` -> `role_forbidden`, naming the level.
 *
 * `options.method` is what makes the first refusal WRITE-scoped, and OMITTING IT
 * FAILS CLOSED: with no method named, the request is treated as a write and an
 * impersonated caller is refused. That direction is deliberate. Every control-plane
 * call site is a write route and names nothing; `WorkflowAgent.onRequest` serves
 * reads and writes through one gate and therefore passes its method, which is what
 * lets an operator READ a customer's deployed instance while the same gate refuses
 * every write on it. A caller that forgets the option loses an impersonated read,
 * which is a support inconvenience; a caller that forgot a method-aware check would
 * gain an impersonated write.
 *
 * Costs nothing when no organisation is in play: `resolveRole` short-circuits on
 * an absent organisation claim without touching `DB` or `TENANTS`.
 */
export async function requireCapability(
  env: TenantEnv,
  auth: AuthContext,
  required: CapabilityLevel,
  respond: RoleGateResponder,
  options?: { method?: string },
): Promise<AuthorizedCaller | Response> {
  const impersonated = isImpersonated(auth);
  const writing = options?.method === undefined || isMutatingMethod(options.method);
  if (impersonated && writing) return impersonationReadOnly(respond);

  const role = await resolveRole(env, auth);
  if ('unknown' in role) return roleUnknown(respond);
  if (!atLeast(role.level, required)) return roleForbidden(required, respond);

  return {
    userId: auth.userId,
    ownerId: auth.ownerId,
    orgId: auth.orgId,
    level: role.level,
    impersonated,
  };
}
