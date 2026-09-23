/**
 * `GET /api/deployments` - what is actually running in this account.
 *
 * ## Why this route exists
 *
 * A Durable Object namespace cannot be enumerated, so before this route the only
 * handle on a deployed workflow was its id - and the only copy of that id lived
 * in the user's local IndexedDB. A reinstall therefore left deployments running
 * cron, answering published portals and spending plan credits with nobody able to
 * name them, let alone remove them. `PortalIndex`'s `deploy:` key space is the
 * record; this is the read.
 *
 * ## Two placement decisions
 *
 * It is mounted ABOVE the `store.enabled` gate in `routeApiRequest`, beside
 * `/api/connection-secrets`. Requirement 5.5 wants the deployment list with a
 * NULL spend figure on a worker with no D1, not a 501 about hosted bindings: the
 * registry lives in a Durable Object that BYO binds too, and "I cannot tell you
 * what it cost" is a very different answer from "I cannot tell you what is
 * running".
 *
 * And it is NOT subscription-gated (Requirement 5.6). A lapsed subscriber is
 * precisely the person who needs to find and stop a cron deployment, so gating
 * this on `status === 'active'` would trap the spend it exists to reveal.
 *
 * ## Credits, not dollars
 *
 * Spend is reported as plan credits and there is no USD field in the response by
 * construction (Requirement 5.4). The conversion happens here, worker-side,
 * against the tenant's own tier, exactly as `/api/me` does it.
 */

import { verifyRequest, isHosted, type AuthEnv } from './auth';
import { applyImpersonation, type Impersonation } from './impersonation';
import {
  deploymentOwner,
  portalIndex,
  type DeploymentRecord,
  type PortalRegistryEnv,
} from './portal-registry';
import { TenantStore, creditsForTier, currentMonth, type TenantEnv } from './tenants';

/** The one path this module answers. */
export const DEPLOYMENTS_PATH = '/api/deployments';

/** Bindings this route needs. */
export type DeploymentsEnv = AuthEnv & TenantEnv & PortalRegistryEnv;

/**
 * One row of the Reconciliation_List.
 *
 * Structural twin of `DeploymentSummary` in
 * `frontend/src/app/core/deployments.model.ts`. Timestamps are epoch ms, matching
 * the registry rather than the spec's ISO `savedAt`.
 */
export interface DeploymentSummary {
  workflowId: string;
  workflowName: string;
  deployedAt: number;
  updatedAt: number;
  /** `fnv1a(canonicalJson(spec))` of the deployed spec. */
  specHash: string;
  cronArmed: boolean;
  portalSlug: string | null;
  /**
   * Month-to-date plan credits spent by this deployment, or null when this
   * worker cannot tell (no D1 binding). Null is NOT zero: one means "no spend
   * recorded", the other means "no ledger to read".
   */
  creditsSpent: number | null;
  /** Month-to-date settled runs, or null for the same reason. */
  runsThisMonth: number | null;
}

/** `GET /api/deployments` body. */
export interface DeploymentsResponse {
  /** The `YYYY-MM` window the spend figures cover. */
  month: string;
  deployments: DeploymentSummary[];
}

/**
 * Month-to-date spend for one workflow.
 *
 * `credits` is carried alongside rather than derived at render time because the
 * conversion needs the tenant's tier, and the tier is read once for the whole
 * account rather than once per row.
 */
interface WorkflowSpend {
  credits: number;
  runs: number;
}

/**
 * Answers `GET /api/deployments`, or null when the request is for another path.
 *
 * Returning null on a non-match keeps this consistent with the other route
 * modules, so `routeApiRequest` reads as one ordered list of `if (matched)
 * return it` branches.
 */
export async function handleDeploymentsRequest(
  request: Request,
  env: DeploymentsEnv,
  url: URL,
  respond: (body: unknown, status?: number) => Response,
  impersonation: Impersonation | null = null,
): Promise<Response | null> {
  if (url.pathname !== DEPLOYMENTS_PATH) return null;
  if (request.method !== 'GET') return respond({ error: 'Method not allowed.' }, 405);

  const verified = await verifyRequest(env, request);
  if (!verified) return respond({ error: 'Unauthorized.' }, 401);
  // The operator act-as owner, when the router resolved one. It arrives already
  // gated - only `api.ts` can produce it, only for an allowlisted `clerk` caller,
  // only on a GET, and only once the audit row has landed - so this line is a
  // SUBSTITUTION rather than a second decision (multi-organisation-phorma
  // Requirement 14.5). Null for every other request, including one that named an
  // owner and was not honoured, which is why nothing here can tell the two apart.
  const auth = applyImpersonation(verified, impersonation);
  // Hosted mode is per-tenant, so an anonymous identity has no account to list
  // (Requirement 5.1). A BYO worker has ONE owner and answers for it.
  if (isHosted(env) && !auth.userId) return respond({ error: 'Unauthorized.' }, 401);
  if (!env.PortalIndex) {
    return respond({ error: 'This deployment has no deployment registry binding.' }, 501);
  }

  // Scoped by the RESOLVED owner off the VERIFIED identity, never by a request
  // field - which is what makes the tenant-isolation property of Requirement 5.7
  // structural rather than a filter somebody could forget.
  //
  // `auth.ownerId` and not `auth.userId` (multi-organisation-phorma,
  // Requirement 4.4): the registry key space is `deploy:{ownerId}:{workflowId}`
  // and `WorkflowAgent` stamps the resolved owner on a first push, so scoping this
  // read by the caller would answer an EMPTY list to every member of every
  // organisation - the deployments are there, under a prefix nobody asked for.
  const ownerId = deploymentOwner(auth.ownerId);
  const records = await portalIndex(env).listDeployments(ownerId);
  const month = currentMonth();

  const spend = await monthlySpendByWorkflow(env, auth.ownerId);
  return respond({
    month,
    deployments: records.map(record => toSummary(record, spend)),
  } satisfies DeploymentsResponse);
}

/** Projects a registry record plus its spend into one response row. */
function toSummary(
  record: DeploymentRecord,
  spend: Map<string, WorkflowSpend> | null,
): DeploymentSummary {
  const entry = spend?.get(record.workflowId);
  return {
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    deployedAt: record.deployedAt,
    updatedAt: record.updatedAt,
    specHash: record.specHash,
    cronArmed: record.cronArmed,
    portalSlug: record.portalSlug,
    // A deployment with no usage row this month really has spent nothing, so a
    // present ledger answers 0 rather than null. Only an ABSENT ledger is null.
    creditsSpent: spend === null ? null : (entry?.credits ?? 0),
    runsThisMonth: spend === null ? null : (entry?.runs ?? 0),
  };
}

/**
 * Month-to-date credits and run count per workflow, or null when there is no
 * ledger to read.
 *
 * Null covers three cases that are all "cannot tell" rather than "spent
 * nothing": no D1 binding (a BYO worker), no resolved owner, and a D1 read
 * that failed. The last one is deliberately folded in: the deployment list is
 * what stops a runaway cron, and losing the whole list because a spend query
 * timed out would be the worst possible trade.
 *
 * The owner is the quota bucket (multi-organisation-phorma, Requirements 4.8,
 * 4.9): `usage.tenant_id` and the `tenants` row it prices against are both the
 * resolved owner, so an organisation's spend is one figure regardless of which
 * member's run produced it.
 */
async function monthlySpendByWorkflow(
  env: DeploymentsEnv,
  ownerId: string | null | undefined,
): Promise<Map<string, WorkflowSpend> | null> {
  const store = new TenantStore(env);
  if (!store.enabled || !ownerId || !env.DB) return null;
  try {
    const tenant = await store.getTenant(ownerId);
    // A tenant row is what makes hosted inference possible at all, so no row
    // means no hosted spend. The tier is only needed for the credit conversion.
    const tier = tenant?.tier ?? 'starter';
    const rows = await env.DB.prepare(
      `SELECT workflow_id, SUM(cost_usd) AS cost_usd, COUNT(*) AS runs
         FROM usage
        WHERE tenant_id = ? AND month = ?
        GROUP BY workflow_id`,
    )
      .bind(ownerId, currentMonth())
      .all<{ workflow_id: string; cost_usd: number | null; runs: number | null }>();

    const out = new Map<string, WorkflowSpend>();
    for (const row of rows.results ?? []) {
      const costUsd = Number(row.cost_usd ?? 0);
      out.set(row.workflow_id, {
        runs: Number(row.runs ?? 0),
        credits: creditsForTier(tier, Number.isFinite(costUsd) ? costUsd : 0),
      });
    }
    return out;
  } catch (error) {
    console.error('monthlySpendByWorkflow failed:', error);
    return null;
  }
}
