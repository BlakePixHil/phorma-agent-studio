/**
 * `/api/proposals/*` - the hosted proposal queue
 * (multi-organisation-phorma, Requirement 11, design section 9).
 *
 *   GET  /api/proposals/{workflowId}                        -> this workflow's proposals
 *   POST /api/proposals/{workflowId}                        -> create one (editor)
 *   GET  /api/proposals/{workflowId}/{proposalId}           -> one proposal + its body
 *   POST /api/proposals/{workflowId}/{proposalId}/publish   -> publish it (builder)
 *   POST /api/proposals/{workflowId}/{proposalId}/reject    -> reject it (builder)
 *
 * ## Placement, and the two 404s
 *
 * Mounted ABOVE the `store.enabled` gate in `routeApiRequest`, so the module's
 * first two lines are its own explicit refusals and BOTH are 404. That gate
 * answers 501 "hosted bindings missing", and Requirement 11.12 wants a flat 404
 * rather than an error naming a binding a BYO worker would then be told to add
 * (Requirement 16.6). The same shape `ownership-claim.ts` uses.
 *
 * There are now three cases of this asymmetry in `api.ts`, and the differences
 * are deliberate: `/api/deployments` sits above the gate and ANSWERS (the
 * registry is a Durable Object a BYO worker binds too), `/api/backups` sits below
 * it and answers 501 naming a binding, and `/api/proposals` sits above it and is
 * ABSENT - it needs the hosted D1 and R2 too, but a proposal queue is meaningless
 * on a single-owner deployment, so 404 is the honest answer rather than a
 * configuration complaint.
 *
 * ## The one thing this module must never be able to do
 *
 * **Creating a proposal cannot change what is running.** There is no code path
 * from here to a `WorkflowAgent`: this file does not import one, does not hold
 * its namespace in {@link ProposalRoutesEnv}, and could not address an instance
 * if it tried (Requirement 11.10). That missing edge IS the "an editor's change
 * is a proposal" principle - it holds even if every check above it were wrong.
 *
 * The ONE Durable Object this module does read is `PortalIndex`, for the
 * deployed spec's hash. That is the deployment REGISTRY, not a deployment: it is
 * a read of a record `WorkflowAgent` wrote, it wakes no workflow instance, and
 * it is the same source the publish path compares against.
 *
 * ## Ordering, and what each step protects
 *
 * 1. The two BYO 404s. Before anything reads a binding.
 * 2. `verifyRequest`, then the owner-addressability guard.
 * 3. The Role_Gate, at `editor` to create and `builder` to publish or reject.
 * 4. Only THEN the binding check. An unauthorized caller learns nothing about
 *    this deployment's configuration, and the level refusal is the same whether
 *    or not the operator has finished wiring R2.
 * 5. The SCOPE gate, for a caller below `builder`: an editor may change
 *    configuration and not structure (Requirement 12.2). It runs after the frozen
 *    live hash is read, because the hash is what authenticates the live spec the
 *    comparison needs.
 * 6. The D1 row, claimed BEFORE the body is written, so a refused proposal
 *    stores nothing. A body write that fails after the row lands is a 502 and
 *    leaves a pending row whose body is missing; the next proposal supersedes it,
 *    and a read of a missing body answers 404 rather than 500.
 *
 * ## Not subscription-gated, deliberately
 *
 * Requirement 11 names no billing refusal on this surface, and the place
 * entitlement is enforced is the RUN (`resolveHostedInference`), which is what
 * actually spends money. Design section 9.6 observes that "a lapsed tenant
 * accumulating proposals is a bug"; that is answered by RETENTION rather than by
 * a gate - at most ten non-pending rows plus one pending survive per workflow,
 * so there is nothing to accumulate.
 */

import {
  isHosted,
  ownerIdIsAddressable,
  verifyRequest,
  type AuthContext,
  type AuthEnv,
} from './auth';
import { atLeast } from './capabilities';
import { portalIndex, type PortalRegistryEnv } from './portal-registry';
import { requireCapability } from './role-gate';
import { ProposalBodyStore, type ProposalBodyEnv } from './proposal-store';
import {
  MAX_PROPOSAL_BYTES,
  PROPOSALS_KEPT,
  ProposalStore,
  SCOPE_VIOLATIONS_REPORTED,
  canonicalSpecHashOf,
  isProposalId,
  isProposalWorkflowId,
  isTerminalStatus,
  newProposalId,
  parseProposalBody,
  parseProposalSubmission,
  proposalBodyKey,
  scopeViolations,
  toProposalSummary,
  type ProposalBody,
  type ProposalRecord,
  type ProposalRefusalCode,
  type ProposalSummary,
} from './proposals';
import { TenantStore, type TenantEnv } from './tenants';

/** Prefix this module answers. */
export const PROPOSALS_PREFIX = '/api/proposals';

/**
 * Bindings the proposal surface needs.
 *
 * No `WorkflowAgent`. That absence is the structural half of Requirement 11.10 -
 * see the file header - so adding it here to "read the live spec" would delete
 * the guarantee this module exists to provide.
 */
export type ProposalRoutesEnv = AuthEnv & TenantEnv & ProposalBodyEnv & PortalRegistryEnv;

/** `GET /api/proposals/{workflowId}` body. */
export interface ProposalListResponse {
  workflowId: string;
  /** Newest first. At most one of them is `pending`. */
  proposals: ProposalSummary[];
  /** Non-pending proposals retained per workflow, so the studio can say so. */
  proposalsKept: number;
}

/** `GET /api/proposals/{workflowId}/{proposalId}` body. */
export interface ProposalDetailResponse {
  proposal: ProposalSummary;
  spec: ProposalBody['spec'];
  connections: ProposalBody['connections'];
}

/** `POST` body for a creation, a publish and a reject. */
export interface ProposalWriteResponse {
  ok: true;
  proposal: ProposalSummary;
}

/**
 * What a publish must do BEFORE the proposal may be marked `published`.
 *
 * A settable seam rather than a call, and the same idiom
 * `RunControllerService.remoteApprovalSender` and
 * `NotificationCenterService.deepLinkHandler` use in the studio. Two reasons it
 * is shaped this way:
 *
 *  - This module must not reach a `WorkflowAgent` (Requirement 11.10), and a
 *    publish must run the ORDINARY push path (Requirement 12.7). A function
 *    installed from above satisfies both: the push lives with the push, and the
 *    proposal store still holds no edge to a deployment.
 *  - The store-level transition is complete and correct on its own, so the
 *    performer is the only thing the propose-and-publish task has to supply -
 *    along with the staleness comparison, which belongs with it because both need
 *    the deployed spec.
 *
 * Until one is installed, a publish REFUSES (501) rather than marking a row
 * `published` without deploying anything. A status that records a deploy that did
 * not happen is worse than a route that says it cannot yet.
 */
export type ProposalPublisher = (input: {
  ownerId: string;
  workflowId: string;
  proposal: ProposalRecord;
  body: ProposalBody;
}) => Promise<ProposalPublishOutcome>;

/** What a {@link ProposalPublisher} reports back. */
export type ProposalPublishOutcome =
  | { ok: true }
  /**
   * The push was refused, so the proposal stays `pending` (Requirement 12.8).
   * `code` is one of the four append-only proposal codes when the refusal is a
   * proposal one; anything else carries prose and a status alone.
   */
  | { ok: false; status: number; error: string; code?: ProposalRefusalCode; extra?: Record<string, unknown> };

/** Seams this surface accepts from its caller. */
export interface ProposalRouteDeps {
  publish?: ProposalPublisher;
}

type Respond = (body: unknown, status?: number) => Response;

/**
 * Answers anything under `/api/proposals`, or null when the path is for another
 * module.
 */
export async function handleProposalRequest(
  request: Request,
  env: ProposalRoutesEnv,
  url: URL,
  respond: Respond,
  deps: ProposalRouteDeps = {},
): Promise<Response | null> {
  if (url.pathname !== PROPOSALS_PREFIX && !url.pathname.startsWith(`${PROPOSALS_PREFIX}/`)) {
    return null;
  }

  // The two BYO refusals, first and flat. Never 501, and never naming a binding.
  if (!isHosted(env)) return respond({ error: 'Not found.' }, 404);
  if (!new TenantStore(env).enabled) return respond({ error: 'Not found.' }, 404);

  const auth = await verifyRequest(env, request);
  if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);
  const authorUserId = auth.userId;

  // The RESOLVED owner owns the queue, so one organisation has one queue and a
  // colleague's pending proposal is visible to the builder who has to review it.
  // `?? auth.userId` is a narrowing, not a fallback: `auth.ownerId` is
  // `orgId ?? userId` and the line above has already proved `userId` is present.
  const ownerId = auth.ownerId ?? authorUserId;
  if (!ownerIdIsAddressable(ownerId)) {
    return respond(
      { error: 'This account cannot be addressed. Contact support.', code: 'owner_invalid' },
      403,
    );
  }

  const tail = url.pathname.slice(PROPOSALS_PREFIX.length).replace(/^\//, '');
  const segments = tail.length > 0 ? tail.split('/') : [];

  // 404 rather than 400 for an unaddressable workflow id: it names no queue
  // rather than failing a precondition of a real one, the same answer the claim
  // route gives.
  if (!isProposalWorkflowId(segments[0])) return respond({ error: 'Not found.' }, 404);
  const workflowId = segments[0];

  const store = new ProposalStore(env);
  const bodies = new ProposalBodyStore(env);

  // ── GET /api/proposals/{workflowId} - this workflow's queue ───────────────
  //
  // A READ, so it is open to every level including `operator`: the boundary this
  // feature defends is between organisations, not within one.
  if (request.method === 'GET' && segments.length === 1) {
    const records = await store.list(ownerId, workflowId);
    return respond({
      workflowId,
      proposals: records.map(toProposalSummary),
      proposalsKept: PROPOSALS_KEPT,
    } satisfies ProposalListResponse);
  }

  // ── POST /api/proposals/{workflowId} - create ─────────────────────────────
  if (request.method === 'POST' && segments.length === 1) {
    return createProposal(
      request,
      env,
      auth,
      { store, bodies },
      { ownerId, authorUserId, workflowId },
      respond,
    );
  }

  if (!isProposalId(segments[1])) return respond({ error: 'Not found.' }, 404);
  const proposalId = segments[1];

  // ── GET /api/proposals/{workflowId}/{proposalId} - one proposal + body ────
  if (request.method === 'GET' && segments.length === 2) {
    const refusal = refuseUnavailable(bodies, respond);
    if (refusal) return refusal;

    const record = await store.get(ownerId, proposalId);
    if (!record || record.workflowId !== workflowId) {
      return respond({ error: 'No such proposal.' }, 404);
    }
    const body = await readProposalBody(bodies, record, respond);
    if (body instanceof Response) return body;
    return respond({
      proposal: toProposalSummary(record),
      spec: body.spec,
      connections: body.connections,
    } satisfies ProposalDetailResponse);
  }

  // ── POST /api/proposals/{id}/{proposalId}/publish|reject ──────────────────
  if (request.method === 'POST' && segments.length === 3) {
    const action = segments[2];
    if (action !== 'publish' && action !== 'reject') return respond({ error: 'Not found.' }, 404);

    // The ONE capability seam. `builder`, because deciding what is deployed is
    // the builder capability (design section 6.3) - an editor may propose and
    // may not publish, which is the entire point of the queue.
    const caller = await requireCapability(env, auth, 'builder', respond);
    if (caller instanceof Response) return caller;

    const refusal = refuseUnavailable(bodies, respond);
    if (refusal) return refusal;

    const submitted = await readTransition(request);
    if (submitted === 'invalid') {
      return respond(
        {
          error:
            'A proposal transition must carry the revision it read, as an integer, so a lost ' +
            'race can be reported rather than silently applied.',
        },
        400,
      );
    }

    const record = await store.get(ownerId, proposalId);
    if (!record || record.workflowId !== workflowId) {
      return respond({ error: 'No such proposal.' }, 404);
    }

    return action === 'publish'
      ? publishProposal({ store, bodies }, deps.publish, ownerId, record, submitted, respond)
      : rejectProposal({ store, bodies }, ownerId, record, submitted, respond);
  }

  return respond({ error: 'Not found.' }, 404);
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * `POST /api/proposals/{workflowId}`.
 *
 * Ordered so nothing is stored unless every gate passes: the Role_Gate, the
 * bindings, the size cap, the shape, the path-versus-spec id check, the frozen
 * live hash, then the D1 claim, and only then the body.
 */
async function createProposal(
  request: Request,
  env: ProposalRoutesEnv,
  auth: AuthContext,
  stores: { store: ProposalStore; bodies: ProposalBodyStore },
  who: { ownerId: string; authorUserId: string; workflowId: string },
  respond: Respond,
): Promise<Response> {
  // `editor`, because submitting a change for review is exactly the editor
  // capability (Requirement 12.1). Checked BEFORE the binding refusal below, so
  // a caller who may not propose learns nothing about how this worker is
  // configured.
  const caller = await requireCapability(env, auth, 'editor', respond);
  if (caller instanceof Response) return caller;

  const refusal = refuseUnavailable(stores.bodies, respond);
  if (refusal) return refusal;

  // Content-Length FIRST, before the body is read, so an oversized submission
  // costs us nothing to refuse - the same ordering the Stripe webhook and the
  // backup upload both use.
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_PROPOSAL_BYTES) {
    return respond(sizeRefusal(declared), 413);
  }
  const raw = await request.text();
  // The authoritative check: `Content-Length` is a claim, this is a measurement.
  const actual = new TextEncoder().encode(raw).length;
  if (actual > MAX_PROPOSAL_BYTES) return respond(sizeRefusal(actual), 413);

  const submission = parseProposalSubmission(raw);
  if (!submission) {
    return respond({ error: 'Body must be { spec, connections } with a version-1 spec.' }, 400);
  }
  const parsed = submission.body;
  if (parsed.spec.id !== who.workflowId) {
    // The path is authoritative (Requirement 11.8), so a mismatch is a client bug
    // rather than something to silently resolve one way or the other.
    return respond(
      { error: `The spec id "${parsed.spec.id}" does not match the workflow id in the path.` },
      400,
    );
  }

  // The deployed spec's hash, FROZEN into the row (Requirement 11.1). Read from
  // the deployment REGISTRY - a record `WorkflowAgent` writes on every accepted
  // push - so it is the hash of what is actually deployed and it costs one
  // storage read rather than a spec download. No workflow instance is woken.
  let liveSpecHash: string;
  try {
    const deployment = await portalIndex(env).getDeployment(who.ownerId, who.workflowId);
    // An empty string means nothing is deployed under this workflow id yet. That
    // is a legal state for a proposal and is recorded as the fact it is; a
    // registry READ FAILURE is not, and refuses below, because freezing "nothing
    // was deployed" for a workflow that is would answer the staleness question
    // wrongly forever.
    liveSpecHash = deployment?.specHash ?? '';
  } catch (error) {
    console.error(`Proposal live-hash read failed for ${who.workflowId}:`, error);
    return respond({ error: 'The deployed workflow could not be read. Try again.' }, 502);
  }

  // ── Scope: an editor may change configuration, not structure ──────────────
  //
  // Checked for a caller BELOW `builder` only (Requirement 12.2). A builder may
  // also propose - reviewing your own change before deploying it is a reasonable
  // thing to want - and nothing about their proposal needs narrowing, because they
  // are allowed to push the same spec outright.
  //
  // The comparison needs the LIVE spec, and this module may not ask a deployment
  // for it (Requirement 11.10). It comes from the submission instead, and is
  // AUTHENTICATED rather than trusted: the registry hash above is written by
  // `WorkflowAgent` alone, so a submitted live spec is only used once it hashes to
  // that value. A client therefore cannot forge a permissive baseline, and the
  // worker stays the boundary while still waking nothing.
  if (!atLeast(caller.level, 'builder') && liveSpecHash !== '') {
    const submittedLive = submission.liveSpec;
    if (!submittedLive) {
      // Fail CLOSED. Accepting the proposal unchecked would make the scope rule
      // opt-in from the client, which is the one thing a boundary cannot be.
      return respond(
        {
          error:
            'This submission must include the deployed workflow it was edited from, as ' +
            '`liveSpec`, so the change can be checked against what is deployed.',
          liveSpecHash,
        },
        400,
      );
    }
    if (canonicalSpecHashOf(submittedLive) !== liveSpecHash) {
      // The author was editing something other than what is deployed now, so the
      // scope question cannot be answered against it - and a proposal written on a
      // superseded baseline is exactly what `proposal_stale` names.
      return respond(
        {
          error:
            'The deployed workflow has changed since this copy was opened. Re-open it and make ' +
            'the change again.',
          code: 'proposal_stale' satisfies ProposalRefusalCode,
          liveSpecHash,
        },
        409,
      );
    }
    const violations = scopeViolations(submittedLive, parsed.spec);
    if (violations.length > 0) {
      return respond(
        {
          error:
            'An editor may change prompts, schedules and step configuration, but not the shape ' +
            'of the workflow. Ask a builder to make this change.',
          code: 'proposal_scope' satisfies ProposalRefusalCode,
          // NAMED, not counted (Requirement 12.2): the author has to be able to
          // undo the structural edit without guessing which one it was.
          violations: violations.slice(0, SCOPE_VIOLATIONS_REPORTED),
          violationCount: violations.length,
        },
        403,
      );
    }
  }

  const proposalId = newProposalId();
  const bodyKey = proposalBodyKey(who.ownerId, who.workflowId, proposalId);
  // Serialized from the REBUILT body, never from `raw`, so what is stored is what
  // passed the shape check and the connection narrowing.
  const canonical = JSON.stringify({ spec: parsed.spec, connections: parsed.connections });

  const claim = await stores.store.create({
    proposalId,
    ownerId: who.ownerId,
    workflowId: who.workflowId,
    authorUserId: who.authorUserId,
    specHash: canonicalSpecHashOf(parsed.spec),
    liveSpecHash,
    bodyKey,
  });
  if (!claim.ok) {
    // Another creation took the pending slot in the same instant. 409 with the
    // CURRENT revision, so the loser re-reads and decides rather than guessing
    // (Requirement 11.7). Nothing was stored.
    return respond(
      {
        error:
          'Another proposal for this workflow was submitted at the same moment. Re-read the ' +
          'queue and submit again.',
        code: 'proposal_conflict' satisfies ProposalRefusalCode,
        revision: claim.revision,
      },
      409,
    );
  }

  try {
    await stores.bodies.put(bodyKey, canonical);
  } catch (error) {
    // The row is claimed and its body is missing. Reported rather than rolled
    // back: the next proposal supersedes this one, and a read of the missing body
    // answers 404 rather than 500.
    console.error(`Proposal body write failed for ${bodyKey}:`, error);
    return respond({ error: 'The proposal could not be stored. Try again.' }, 502);
  }

  // Retention. The creation superseded any pending row, which is a new terminal
  // row, so this is one of the three places the queue can grow.
  await runProposalRetention(stores, who.ownerId, who.workflowId);

  return respond({ ok: true, proposal: toProposalSummary(claim.record) } satisfies ProposalWriteResponse);
}

// ── Publish and reject ───────────────────────────────────────────────────────

/**
 * `POST /api/proposals/{workflowId}/{proposalId}/publish`.
 *
 * The push runs FIRST and the transition second, so a refused push leaves the
 * proposal `pending` (Requirement 12.8) and only an accepted one is recorded as
 * published. With no publisher installed the route refuses - see
 * {@link ProposalPublisher} for why that is better than a status that records a
 * deploy that never happened.
 */
async function publishProposal(
  stores: { store: ProposalStore; bodies: ProposalBodyStore },
  publish: ProposalPublisher | undefined,
  ownerId: string,
  record: ProposalRecord,
  submitted: ProposalTransitionInput,
  respond: Respond,
): Promise<Response> {
  if (isTerminalStatus(record.status)) return respond(terminalRefusal(record), 409);
  if (submitted.revision === null) return respond(missingRevision(record), 400);
  const revision = submitted.revision;

  if (!publish) {
    return respond(
      {
        error:
          'Publishing a proposal is not available on this deployment. The proposal is ' +
          'unchanged and still pending.',
      },
      501,
    );
  }

  const body = await readProposalBody(stores.bodies, record, respond);
  if (body instanceof Response) return body;

  const pushed = await publish({ ownerId, workflowId: record.workflowId, proposal: record, body });
  if (!pushed.ok) {
    // The proposal is deliberately untouched: a refused push leaves it pending so
    // the same proposal can be published again once whatever refused it is fixed.
    return respond(
      { error: pushed.error, ...(pushed.code ? { code: pushed.code } : {}), ...(pushed.extra ?? {}) },
      pushed.status,
    );
  }

  const moved = await stores.store.transition(ownerId, record.proposalId, {
    from: 'pending',
    to: 'published',
    revision,
  });
  if (!moved.ok) return respond(conflictRefusal(moved.revision), 409);

  // Retention: a published proposal is a terminal row.
  await runProposalRetention(stores, ownerId, record.workflowId);
  return respond({ ok: true, proposal: toProposalSummary(moved.record) } satisfies ProposalWriteResponse);
}

/**
 * `POST /api/proposals/{workflowId}/{proposalId}/reject`.
 *
 * Carries an optional reason and RETAINS the body until retention prunes it: a
 * rejected proposal is the author's work, and the reviewer's reason is only
 * useful beside the change it was written about.
 */
async function rejectProposal(
  stores: { store: ProposalStore; bodies: ProposalBodyStore },
  ownerId: string,
  record: ProposalRecord,
  submitted: ProposalTransitionInput,
  respond: Respond,
): Promise<Response> {
  if (isTerminalStatus(record.status)) return respond(terminalRefusal(record), 409);
  if (submitted.revision === null) return respond(missingRevision(record), 400);

  const moved = await stores.store.transition(ownerId, record.proposalId, {
    from: 'pending',
    to: 'rejected',
    revision: submitted.revision,
    reason: submitted.reason,
  });
  if (!moved.ok) return respond(conflictRefusal(moved.revision), 409);

  // Retention: a rejected proposal is a terminal row.
  await runProposalRetention(stores, ownerId, record.workflowId);
  return respond({ ok: true, proposal: toProposalSummary(moved.record) } satisfies ProposalWriteResponse);
}

// ── The one destroying path ──────────────────────────────────────────────────

/**
 * THE ONLY PLACE A PROPOSAL BODY IS DESTROYED (Requirement 11.11).
 *
 * Named at each of its three call sites above - after a creation, after a
 * publish and after a reject, the three things that can add a terminal row - the
 * way `backup-routes.ts` names each of its three destroying paths, so a fourth
 * cannot appear by accident.
 *
 * Two rules it keeps:
 *
 *  - It never prunes a `pending` row. `doomedProposals` in `proposals.ts` filters
 *    those out by construction rather than by a `WHERE` clause somebody could
 *    edit, and it is pure, so that rule is property-testable without D1.
 *  - Bodies go BEFORE rows. The row is the only index of which R2 object belongs
 *    to which proposal, so the reverse order orphans an object nothing can name
 *    again. A failure therefore leaves the row in place and the next pass retries
 *    it, which is the safe direction to fail in.
 *
 * Best-effort: a failed prune costs storage, not correctness, and must never
 * turn an accepted proposal into an error.
 */
async function runProposalRetention(
  stores: { store: ProposalStore; bodies: ProposalBodyStore },
  ownerId: string,
  workflowId: string,
): Promise<number> {
  try {
    const doomed = await stores.store.beyondRetention(ownerId, workflowId, PROPOSALS_KEPT);
    if (doomed.length === 0) return 0;
    await stores.bodies.delete(doomed.map(record => record.bodyKey));
    await stores.store.deleteRows(doomed.map(record => record.id));
    return doomed.length;
  } catch (error) {
    console.error(`Proposal retention failed for ${ownerId}/${workflowId}:`, error);
    return 0;
  }
}

// ── Shared refusals and readers ──────────────────────────────────────────────

/**
 * The binding refusal, or null when both are present.
 *
 * Two distinct answers, mirroring `BackupBodyStore.unavailable()`: a missing
 * secret is `proposal_unencrypted` (Requirement 11.5) and states the rule, and a
 * missing bucket names the bucket. Both are operator actions and both are 501,
 * which is safe to name HERE because a BYO worker never reaches this line - the
 * two 404s at the top of the module have already answered it.
 */
function refuseUnavailable(bodies: ProposalBodyStore, respond: Respond): Response | null {
  const missing = bodies.unavailable();
  if (!missing) return null;
  if (missing.reason === 'no-key') {
    return respond(
      {
        error:
          'Proposals are not available on this deployment: KEY_ENC_SECRET is not set, and a ' +
          'proposal is never stored unencrypted.',
        code: 'proposal_unencrypted' satisfies ProposalRefusalCode,
      },
      501,
    );
  }
  return respond(
    { error: 'Proposals are not available on this deployment: no body storage is bound.' },
    501,
  );
}

/**
 * One proposal's stored body, or the Response to return.
 *
 * A MISSING object is 404 and not 500: a body write that failed after its row
 * landed leaves exactly this state, and "the body is not here" is the honest
 * answer. A DECRYPTION failure is 500 - the object is there and we cannot read
 * it, which is an incident - and the vendor detail stays in the log.
 */
async function readProposalBody(
  bodies: ProposalBodyStore,
  record: ProposalRecord,
  respond: Respond,
): Promise<ProposalBody | Response> {
  let json: string | null;
  try {
    json = await bodies.get(record.bodyKey);
  } catch (error) {
    console.error(`Proposal body ${record.bodyKey} could not be read:`, error);
    return respond({ error: 'This proposal could not be decrypted.' }, 500);
  }
  if (json === null) return respond({ error: 'This proposal no longer has a stored body.' }, 404);

  const parsed = parseProposalBody(json);
  if (!parsed) {
    console.error(`Proposal body ${record.bodyKey} is not a valid body.`);
    return respond({ error: 'This proposal could not be read.' }, 500);
  }
  return parsed;
}

/** What a publish or reject body carries. */
interface ProposalTransitionInput {
  /** The revision the caller read, or null when it sent none. */
  revision: number | null;
  /** An optional rejection reason, trimmed and bounded. */
  reason: string | null;
}

/**
 * The transition body: `{ revision, reason? }`, or `'invalid'`.
 *
 * Read ONCE - a `Request` body reads once - and the revision is REQUIRED rather
 * than looked up server-side. That is the whole design: a transition that read
 * the revision itself would be a read-then-write, and two concurrent callers
 * would both be told they won.
 */
async function readTransition(request: Request): Promise<ProposalTransitionInput | 'invalid'> {
  const raw = await request.text();
  if (raw.trim().length === 0) return { revision: null, reason: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  const body = parsed as { revision?: unknown; reason?: unknown } | null;
  const value = body?.revision;
  if (value === undefined || value === null) return { revision: null, reason: readReason(body) };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'invalid';
  return { revision: value, reason: readReason(body) };
}

/** The optional rejection reason, trimmed and bounded. */
function readReason(body: { reason?: unknown } | null): string | null {
  if (typeof body?.reason !== 'string') return null;
  const trimmed = body.reason.trim().slice(0, 2000);
  return trimmed.length > 0 ? trimmed : null;
}

/** 409 carrying the CURRENT revision, so the loser retries against a truth. */
function conflictRefusal(revision: number): Record<string, unknown> {
  return {
    error:
      'This proposal changed while you were deciding. Re-read it and choose again.',
    code: 'proposal_conflict' satisfies ProposalRefusalCode,
    revision,
  };
}

/** 409 for a row that has already reached a terminal status. */
function terminalRefusal(record: ProposalRecord): Record<string, unknown> {
  return {
    error: `This proposal is already ${record.status} and cannot change again.`,
    code: 'proposal_conflict' satisfies ProposalRefusalCode,
    revision: record.revision,
    status: record.status,
  };
}

/** 400 for a transition with no revision, naming the one to send. */
function missingRevision(record: ProposalRecord): Record<string, unknown> {
  return {
    error: 'A proposal transition must carry the revision it read.',
    revision: record.revision,
  };
}

/** The 413 body, naming both the limit and what actually arrived. */
function sizeRefusal(bytes: number): Record<string, unknown> {
  return {
    error:
      `This workflow is ${Math.round(bytes / 1024)} kB, over the ` +
      `${Math.round(MAX_PROPOSAL_BYTES / 1024)} kB proposal limit. Nothing was stored.`,
    limitBytes: MAX_PROPOSAL_BYTES,
    actualBytes: bytes,
  };
}
