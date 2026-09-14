/**
 * The `GET /api/deployments` response shape.
 *
 * Structural twin of `cloud/src/deployments.ts`. The studio and the worker each
 * declare this contract independently - `frontend/` cannot import from `cloud/` -
 * so a field added on one side and not the other compiles in one package and
 * breaks the other.
 *
 * Note what is deliberately ABSENT: there is no USD field anywhere in here. The
 * Phorma Cloud-billed share of a deployment's spend renders as plan credits and
 * nothing else, so the worker converts and the studio only ever displays.
 */

/** One live deployment in the signed-in account. */
export interface DeploymentSummary {
  /** Library workflow id. Also the local library key, when a local copy exists. */
  workflowId: string;
  workflowName: string;
  /** Epoch ms of the first push. Survives a re-push. */
  deployedAt: number;
  /** Epoch ms of the most recent push. */
  updatedAt: number;
  /** `fnv1a(canonicalJson(spec))` of the deployed spec. */
  specHash: string;
  /** True when a schedule trigger is armed - this deployment runs on its own. */
  cronArmed: boolean;
  /** Published portal address, or null when nothing is published. */
  portalSlug: string | null;
  /**
   * Month-to-date plan credits, or null when the worker could not read a ledger.
   *
   * NULL IS NOT ZERO. Zero means "no spend recorded this month"; null means "no
   * ledger to read" (a BYO worker with no D1, or a failed query). Rendering them
   * alike would tell a user a runaway cron deployment costs nothing.
   */
  creditsSpent: number | null;
  /** Month-to-date settled runs, null for the same reason. */
  runsThisMonth: number | null;
}

/** `GET /api/deployments` body. */
export interface DeploymentsResponse {
  /** The `YYYY-MM` window the spend figures cover. */
  month: string;
  deployments: DeploymentSummary[];
}
