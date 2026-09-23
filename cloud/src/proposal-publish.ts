/**
 * The proposal PUBLISHER: the performer `proposal-routes.ts` leaves as a settable
 * seam (multi-organisation-phorma, Requirements 12.7, 12.8, 12.9; design section
 * 9.5).
 *
 * ## Why a separate module
 *
 * `proposal-routes.ts` must have no path to a `WorkflowAgent` - that missing edge
 * is the whole of "an editor's change cannot move what is running"
 * (Requirement 11.10), and `cloud/test/proposals.test.mjs` asserts it with a Proxy
 * that records every property read off the binding. A publish, on the other hand,
 * MUST reach a deployment. Both hold at once because the push lives here and is
 * handed in from `api.ts`: the route knows a publisher exists, and knows nothing
 * about what one does.
 *
 * ## What a publish is, in one sentence
 *
 * The ORDINARY push path, with a staleness check in front of it.
 *
 * It is the push path by CONSTRUCTION rather than by resemblance: this module
 * calls `WorkflowAgent.acceptSpecPush`, which is the second entrance to the same
 * private method `POST /workflow` runs, so the validation, the connection
 * inventory it validates against, the cron re-arm, the owner stamp, the state
 * write and the deployment registry write are all the same code
 * (Requirement 12.7, Property 29). Nothing here re-implements a step of it, and
 * nothing here may be allowed to grow one.
 *
 * ## RPC, not `stub.fetch()`
 *
 * A worker-to-Durable-Object fetch carries no `Authorization` header, so
 * `WorkflowAgent.authorized()` would refuse it. RPC is how every internal call
 * into an instance is already made (`notificationsSince`, `purgeSelf`,
 * `startPortalTurn`, `claimOwnership`), and the caller has already verified the
 * identity, resolved the owner and checked the `builder` capability at the route.
 * The RPC re-checks the owner against the stamp exactly as `notificationsSince`
 * does.
 *
 * ## The staleness comparison, and why the registry is the right source
 *
 * `live_spec_hash` was frozen into the proposal row when it was created. Before
 * the push, it is compared against the CURRENT `DeploymentRecord.specHash` read
 * from `PortalIndex.getDeployment` (Requirement 12.9). That record is written by
 * `syncDeployment` on every accepted push, so it is the hash of what is actually
 * deployed, and reading it costs one storage read rather than a spec download.
 *
 * A difference means somebody deployed something else since the proposal was
 * written, so publishing it would silently revert their change: that is
 * `proposal_stale`, carrying the current live hash so the studio can offer a
 * re-review against what is really there.
 *
 * A registry READ FAILURE is not a staleness answer and must not be treated as
 * one - it refuses 502, the same policy the creation path follows for the same
 * read.
 */

import { isHosted, type AuthEnv } from './auth';
import { portalIndex, workflowAgentInstance, type PortalRegistryEnv } from './portal-registry';
import type { ProposalPublishOutcome, ProposalPublisher } from './proposal-routes';
import type { ProposalRefusalCode } from './proposals';
import type { SpecPushOutcome } from './workflow-agent';

/** Bindings a publish needs: the registry to compare against, and the instance. */
export type ProposalPublishEnv = AuthEnv &
  PortalRegistryEnv & {
    WorkflowAgent: DurableObjectNamespace;
  };

/**
 * The RPC surface a publish uses, declared structurally.
 *
 * A structural interface rather than an import of the class, exactly as
 * `notifications.ts` declares `NotifiableInstance`: a Durable Object stub is not
 * the class, and naming only the one method this module calls keeps the coupling
 * to the size of the call.
 */
interface PushableInstance {
  acceptSpecPush(ownerId: string, spec: unknown): Promise<SpecPushOutcome>;
}

/**
 * Builds the publisher `api.ts` installs on the proposal routes.
 *
 * A factory over the env rather than a bare function, so the seam the route holds
 * stays a one-argument performer and the bindings are captured once.
 */
export function createProposalPublisher(env: ProposalPublishEnv): ProposalPublisher {
  return async ({ ownerId, workflowId, proposal, body }) => {
    if (!env.WorkflowAgent) {
      return {
        ok: false,
        status: 501,
        error: 'This deployment cannot publish a proposal: no workflow runtime is bound.',
      };
    }

    // ── Staleness, BEFORE the push ────────────────────────────────────────────
    let liveSpecHash: string;
    try {
      const record = await portalIndex(env).getDeployment(ownerId, workflowId);
      // An empty string is "nothing is deployed under this id", which is the same
      // value the creation path freezes in that case, so a proposal made against
      // an undeployed workflow is not stale and publishing it is its first deploy.
      liveSpecHash = record?.specHash ?? '';
    } catch (error) {
      // NOT a staleness answer. Refusing here leaves the proposal pending, which
      // is recoverable; guessing would either revert somebody's deploy or refuse a
      // current proposal forever.
      console.error(`Proposal publish could not read the deployment registry for ${workflowId}:`, error);
      return {
        ok: false,
        status: 502,
        error: 'The deployed workflow could not be read, so this proposal was not published. Try again.',
      };
    }

    if (liveSpecHash !== proposal.liveSpecHash) {
      return {
        ok: false,
        status: 409,
        error:
          'The deployed workflow has changed since this proposal was written, so publishing it ' +
          'would undo that change. Review it against what is deployed now.',
        code: 'proposal_stale' satisfies ProposalRefusalCode,
        // The CURRENT live hash (Requirement 12.9), so the studio can tell the
        // difference between "re-review this" and "your copy is behind" without a
        // second round trip.
        extra: { liveSpecHash, proposalLiveSpecHash: proposal.liveSpecHash },
      };
    }

    // ── The ordinary push path ────────────────────────────────────────────────
    //
    // Through `workflowAgentInstance`, never a hand-built string: the gateway
    // writes `encodeURIComponent('{owner}:{workflowId}')` into the path and
    // partyserver hashes that segment WITHOUT decoding it, so the raw colon form
    // addresses a DIFFERENT, blank instance - which answers successfully with
    // empty state and logs nothing. BYO instances carry no owner prefix, so null
    // is passed there exactly as `index.ts` routes them.
    const name = workflowAgentInstance(isHosted(env) ? ownerId : null, workflowId);
    const stub = env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name)) as unknown as PushableInstance;

    let pushed: SpecPushOutcome;
    try {
      pushed = await stub.acceptSpecPush(ownerId, body.spec);
    } catch (error) {
      // A thrown RPC is an unreachable or refusing instance - including the
      // instance's own owner re-check, which throws by design so a refusal stays
      // distinguishable from "nothing happened".
      console.error(`Proposal publish push failed for ${ownerId}/${workflowId}:`, error);
      return {
        ok: false,
        status: 502,
        error: 'The deployed workflow could not be updated, so this proposal is still pending.',
      };
    }

    if (!pushed.ok) {
      // The host's own capability findings are authoritative and travel with the
      // refusal, so a reviewer sees WHY the spec is not deployable rather than a
      // bare failure - the same contract the studio's push path already honours.
      return {
        ok: false,
        status: pushed.status,
        error: pushed.error,
        ...(pushed.findings ? { extra: { findings: pushed.findings } } : {}),
      } satisfies ProposalPublishOutcome;
    }
    return { ok: true };
  };
}
