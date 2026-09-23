/**
 * `POST /api/deployments/{workflowId}/claim` - the one-time move of a pre-pivot
 * personal deployment into an organisation (Requirement 3, design section 4 of
 * `.kiro/specs/multi-organisation-phorma/`).
 *
 * ## Why this is its own module
 *
 * `deployments.ts` stays a READ. A claim is a write with a different gate, a
 * different audit and a different failure vocabulary, and folding it in would make
 * one module answer both questions.
 *
 * ## Placement, and the two 404s
 *
 * Mounted immediately after `handleDeploymentsRequest` in `routeApiRequest` and
 * ABOVE the `store.enabled` gate. It cannot sit below that gate: the gate answers
 * 501 "hosted bindings missing", and Requirement 3.10 wants a flat 404 in BYO
 * mode - no refusal this feature adds may name a binding a BYO worker would have
 * to add (Requirement 16.6). So the module's first two lines are its own explicit
 * refusals, and both are 404 rather than 501.
 *
 * ## One capability seam
 *
 * The gate is `requireCapability` at `builder` (`role-gate.ts`), the same seam
 * every other write in this worker passes through, and the route brings its own
 * `WRITE_ROUTES` entry with it. A route with a hand-rolled check of its own is how
 * two gates start disagreeing.
 *
 * ## Order of operations, and why each step is where it is
 *
 * 1. The `workflow_backups` collision pre-check, BEFORE anything changes
 *    (Requirement 3.11). That table's primary key is `(tenant_id, workflow_id)`,
 *    so a transfer into an owner that already backs up this workflow id would
 *    violate it - and discovering that after the Durable Object stamp had moved
 *    would leave a half-applied claim.
 * 2. The `claimOwnership` RPC, which owns every decision that needs the
 *    instance's own stamp and performs the atomic replace plus the registry move.
 * 3. The D1 row transfer, as ONE `DB.batch`, which D1 runs in a single implicit
 *    transaction.
 * 4. The `ownership_claims` audit row, which LOGS on failure rather than
 *    refusing - by then the move has already happened.
 */

import {
  isHosted,
  ownerIdIsAddressable,
  resolveOwner,
  verifyRequest,
  type AuthEnv,
} from './auth';
import { bodyPrefix } from './backup-store';
import { workflowAgentInstance } from './portal-registry';
import { requireCapability } from './role-gate';
import { TenantStore, type TenantEnv } from './tenants';
import type { ClaimOwnershipResult } from './workflow-agent';

/**
 * `POST /api/deployments/{workflowId}/claim`.
 *
 * Deliberately NOT shared with the `WRITE_ROUTES` entry that declares this route's
 * required level: `role-gate.ts` importing this module would close a cycle, since
 * this module imports the gate. Both literals are driven against the real route by
 * `cloud/test/role-gate.test.mjs`, which is what keeps them from drifting.
 */
const CLAIM_PATH = /^\/api\/deployments\/([^/]+)\/claim$/;

/**
 * Refusal codes this route answers. APPEND-ONLY, like every other refusal set on
 * this wire (Requirements 3.12, 16.2): a released token is never renamed or
 * repurposed, and a studio three versions old renders an unknown one's prose.
 */
export type ClaimRefusalCode = 'claim_not_owner' | 'claim_unowned' | 'claim_conflict';

/** Bindings this route needs. */
export type OwnershipClaimEnv = AuthEnv &
  TenantEnv & {
    WorkflowAgent: DurableObjectNamespace;
  };

/** The RPC surface this route needs from an instance. */
interface ClaimableInstance {
  claimOwnership(actingUserId: string, newOwnerId: string): Promise<ClaimOwnershipResult>;
}

/** `POST /api/deployments/{workflowId}/claim` body on success. */
export interface OwnershipClaimResponse {
  ok: true;
  workflowId: string;
  /** Who held the stamp before this call. The caller's own id, by precondition. */
  previousOwnerId: string;
  /** Who holds it now: the caller's resolved owner. */
  newOwnerId: string;
  /** True when the instance was already owned by the new owner (Requirement 3.8). */
  alreadyOwned: boolean;
  /** Backup metadata rows moved by this call. */
  backupsMoved: number;
  /** Usage rows moved by this call. */
  usageRowsMoved: number;
}

/**
 * A workflow id, as an instance-name segment.
 *
 * The same pattern `backup-routes.ts` uses, and bounded for the same reasons: a
 * `:` would forge a different owner prefix, and `#` is the portal SESSION
 * separator (`{owner}:{workflowId}#s{sessionId}`), so refusing it here is what
 * makes a session instance unnameable through this route. A portal session also
 * refuses inside the RPC, because an RPC is reachable by name.
 */
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Respond = (body: unknown, status?: number) => Response;

/**
 * Answers the claim route, or null when the request is for another path.
 *
 * Returning null on a non-match keeps this consistent with the other route
 * modules, so `routeApiRequest` reads as one ordered list of `if (matched) return
 * it` branches.
 */
export async function handleOwnershipClaimRequest(
  request: Request,
  env: OwnershipClaimEnv,
  url: URL,
  respond: Respond,
): Promise<Response | null> {
  const matched = CLAIM_PATH.exec(url.pathname);
  if (!matched) return null;
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

  // The two BYO refusals, first and flat. Never 501, and never naming a binding:
  // an ownership claim is meaningless on a single-owner deployment, so the route
  // is ABSENT there rather than broken (Requirements 3.10, 16.6).
  if (!isHosted(env)) return respond({ error: 'Not found.' }, 404);
  if (!new TenantStore(env).enabled) return respond({ error: 'Not found.' }, 404);

  const auth = await verifyRequest(env, request);
  if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);
  const actingUserId = auth.userId;

  const newOwnerId = resolveOwner(auth);
  // Defensive, and deliberately not left to the gate above `routeApiRequest`: this
  // route writes `newOwnerId` into a Durable Object state row, a registry key and
  // three D1 columns, so the one structural fact about an owner id is checked
  // where it is about to be used (Requirement 1.8).
  if (!newOwnerId || !ownerIdIsAddressable(newOwnerId)) {
    return respond(
      { error: 'This account cannot be addressed. Contact support.', code: 'owner_invalid' },
      403,
    );
  }

  const workflowId = decodeURIComponent(matched[1]);
  // 404 rather than a refusal code: the claim vocabulary is append-only and three
  // codes wide (Requirement 3.12), and an unaddressable workflow id names no
  // deployment rather than failing a precondition of a real one.
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) return respond({ error: 'Not found.' }, 404);

  // The ONE capability seam. `builder` is required in the NEW owner, because the
  // claim is a deployment write into that organisation (Requirement 3.2): an
  // `operator` or `editor` claiming a deployment into it is `role_forbidden`.
  const caller = await requireCapability(env, auth, 'builder', respond);
  if (caller instanceof Response) return caller;

  const db = env.DB;
  if (!db) return respond({ error: 'Not found.' }, 404);

  // ── Step 1: the collision that could half-apply a claim ────────────────────
  //
  // `workflow_backups` has PK `(tenant_id, workflow_id)`, so the transfer below
  // would violate it when BOTH owners hold a row for this workflow id. Both, and
  // not just the new owner's, and the difference matters: after an accepted claim
  // the new owner DOES hold the row, and a check on that alone would turn every
  // repeat claim into `claim_conflict` and break Requirement 3.8.
  let conflicted = false;
  try {
    const rows = await db
      .prepare(
        `SELECT tenant_id FROM workflow_backups WHERE workflow_id = ? AND tenant_id IN (?, ?)`,
      )
      .bind(workflowId, newOwnerId, actingUserId)
      .all<{ tenant_id: string }>();
    const owners = new Set((rows.results ?? []).map(row => row.tenant_id));
    conflicted =
      newOwnerId !== actingUserId && owners.has(newOwnerId) && owners.has(actingUserId);
  } catch (error) {
    // A read failure must not be read as "no collision": that is the one outcome
    // that lets a claim half-apply, which is the whole reason this check exists.
    console.error(`Ownership claim pre-check failed for ${workflowId}:`, error);
    return respond({ error: 'The claim could not be checked. Try again.' }, 502);
  }
  if (conflicted) {
    return respond(
      {
        error:
          'This organisation already backs up a workflow with this id. Rename or remove that ' +
          'backup before claiming this deployment.',
        code: 'claim_conflict' satisfies ClaimRefusalCode,
      },
      409,
    );
  }

  // ── Step 2: the instance decides, and performs the atomic replace ──────────
  //
  // Addressed under the ACTING USER's prefix, mirroring the gateway's naming: a
  // pre-pivot deployment was stamped with the personal account, so that is where
  // the instance lives. Naming a workflow id nobody ever deployed creates a blank
  // instance, which answers `claim_unowned` - which is why the route needs no
  // separate existence check.
  //
  // Through `workflowAgentInstance`, never by string concatenation: the gateway
  // percent-encodes the owner separator into the path and partyserver hashes what it
  // finds there, so `org_a:wf` and `org_a%3Awf` are two different Durable Objects
  // and only one of them is the deployment. A hand-built name here would answer
  // `claim_unowned` for every real claim, with nothing logged.
  const instanceName = workflowAgentInstance(actingUserId, workflowId);
  const stub = env.WorkflowAgent.get(
    env.WorkflowAgent.idFromName(instanceName),
  ) as unknown as ClaimableInstance;

  let claim: ClaimOwnershipResult;
  try {
    claim = await stub.claimOwnership(actingUserId, newOwnerId);
  } catch (error) {
    console.error(`claimOwnership RPC failed for ${instanceName}:`, error);
    return respond({ error: 'The deployment could not be reached. Try again.' }, 502);
  }

  if (!claim.ok) {
    return respond(
      {
        error:
          claim.code === 'claim_unowned'
            ? 'Nothing is deployed under your account with this workflow id, so there is ' +
              'nothing to claim.'
            : 'This deployment belongs to another account, so you cannot claim it.',
        code: claim.code satisfies ClaimRefusalCode,
      },
      409,
    );
  }

  // ── Step 3: the row transfer, as one batch ────────────────────────────────
  //
  // Keyed on the ACTING USER as the source rather than on the previous owner the
  // RPC reported, which is the same value for a fresh claim and is what makes a
  // RETRY converge: if this batch failed once, the stamp has already moved, so the
  // retry arrives at the idempotent branch above - and a transfer keyed on the
  // reported previous owner would then be a no-op and strand the rows forever.
  // Both statements change zero rows once the move is complete, so a repeat claim
  // remains observably a no-op (Requirement 3.8).
  //
  // `body_key` is FROZEN to the legacy derived prefix on the way past. The column
  // is nullable and a NULL reads as `bodyPrefix(tenantId, workflowId)`, so leaving
  // it NULL while `tenant_id` moved would re-derive the NEW owner's prefix and make
  // every stored body unreachable. `COALESCE` writes the prefix that is actually in
  // force and leaves an already-populated one alone, which is what keeps the R2 key
  // set byte-identical and every body readable at its original key
  // (Requirements 3.7, 4.7).
  //
  // `quotas`, `tenants`, `credit_grants` and `stripe_customer_id` are deliberately
  // NOT moved: they record a billing period that has already been charged to
  // somebody, and a `(tenant_id, month)` rollup moved across owners would rewrite
  // it.
  //
  // That exclusion is the CLAIM PATH's half of Requirement 19.2, which forbids a
  // subscription, a tier, a credit grant or a Stripe customer moving between a
  // personal owner and an organisation owner in EITHER direction on ANY path - and
  // this is the only path in the worker that moves anything across owners at all.
  // So the four names above are a closed list rather than an incidental one: a
  // personal account keeps the plan it paid for, the organisation keeps the plan
  // Phorma Labs invoices it for (`/api/provision`, with no Stripe object anywhere),
  // and a claim moves the WORKFLOW rather than the relationship. Adding a table to
  // this batch is therefore a Requirement 19.2 decision, not a tidying one;
  // `cloud/test/organisation-billing.test.mjs` fails on one.
  let backupsMoved = 0;
  let usageRowsMoved = 0;
  try {
    const [backups, usage] = await db.batch([
      db
        .prepare(
          `UPDATE workflow_backups
              SET tenant_id = ?, body_key = COALESCE(body_key, ?)
            WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .bind(newOwnerId, bodyPrefix(actingUserId, workflowId), actingUserId, workflowId),
      db
        .prepare(`UPDATE usage SET tenant_id = ? WHERE tenant_id = ? AND workflow_id = ?`)
        .bind(newOwnerId, actingUserId, workflowId),
    ]);
    backupsMoved = Number(backups?.meta?.changes ?? 0);
    usageRowsMoved = Number(usage?.meta?.changes ?? 0);
  } catch (error) {
    // The stamp and the registry have already moved and the rows have not. Reported
    // rather than swallowed, and a retry of the same request is safe and completes
    // it - see the note above on why the source is the acting user.
    console.error(`Ownership claim row transfer failed for ${workflowId}:`, error);
    return respond(
      {
        error:
          'The deployment moved to this organisation, but its backup and usage rows did ' +
          'not. Retry this claim to finish the move.',
      },
      502,
    );
  }

  // ── Step 4: the audit row, which logs rather than refuses ─────────────────
  //
  // Exactly one row per ACCEPTED claim (Requirement 3.9), so a repeat writes none.
  // Unlike the impersonation audit, a failed write here does NOT refuse: the
  // ownership move has already landed in the instance, the registry and D1, and
  // refusing now would report a failure for a claim that succeeded. The row is
  // reconstructible from the registry.
  if (!claim.alreadyOwned) {
    try {
      await db
        .prepare(
          `INSERT INTO ownership_claims
             (workflow_id, previous_owner_id, new_owner_id, acting_user_id, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(workflowId, claim.previousOwnerId, newOwnerId, actingUserId, new Date().toISOString())
        .run();
    } catch (error) {
      console.error(`ownership_claims row could not be written for ${workflowId}:`, error);
    }
  }

  return respond({
    ok: true,
    workflowId,
    previousOwnerId: claim.previousOwnerId,
    newOwnerId,
    alreadyOwned: claim.alreadyOwned,
    backupsMoved,
    usageRowsMoved,
  } satisfies OwnershipClaimResponse);
}
