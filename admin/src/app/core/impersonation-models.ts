/**
 * Impersonation audit response shapes, as the dashboard sees them.
 *
 * STRUCTURAL TWIN of the `GET /api/admin/impersonation` half of
 * `cloud/src/impersonation.ts`. Declared independently, nothing imported across the
 * package boundary - the same arrangement `models.ts`, `billing-models.ts` and
 * `org-models.ts` each have with their Worker module.
 *
 * ## Why this is a FOURTH model file and not a section of one of the three
 *
 * Each of the four carries a different disclosure contract. `models.ts` bodies
 * carry no install id by construction. `billing-models.ts` bodies name paying
 * tenants. `org-models.ts` bodies name individual people because "who is in this
 * organisation" cannot be answered otherwise. These bodies name a PERSON AND WHAT
 * THEY READ, which is the strongest of the four: an audit row says an operator
 * looked at a named customer's data at a named moment. Merging it into a file whose
 * header claims anonymity would make that claim untrue by adjacency.
 *
 * The WIRE half only. The two refusal codes (`impersonation_read_only`,
 * `impersonation_unaudited`), the header name and every enforcement decision are
 * worker-only, with one exception: the header name is a twin, and it lives in
 * `admin-api.ts` because that is the one place a request is built.
 */

// --- Rows ------------------------------------------------------------------

/**
 * One accepted impersonated request.
 *
 * Nothing here is nullable, and that is a property of the table rather than an
 * optimism: every column is `NOT NULL`, and a row only exists for a request that
 * was actually served.
 */
export interface ImpersonationAuditRow {
  /** The rowid. Newest-first ordering is by this, never by {@link at}. */
  id: number;
  /** The operator who acted. A Clerk user id. */
  actingUserId: string;
  /** The owner they read as. A Clerk user or organisation id. */
  ownerId: string;
  method: string;
  /** The request path. Carries no query string, by construction on the Worker. */
  path: string;
  /** ISO 8601 UTC. */
  at: string;
}

/**
 * One deployment of the owner being read, as `GET /api/deployments` reports it.
 *
 * A THIRD independent declaration of a shape `cloud/src/deployments.ts` and
 * `frontend/src/app/core/deployments.model.ts` already twin, and that is the
 * accepted cost of Requirement 14.12: impersonation lives in this package and
 * nowhere else, so this package has to name the shape it reads. Only the fields
 * this view renders are declared - the response carries more, and extra fields on a
 * JSON body cost a reader nothing.
 *
 * `creditsSpent` and `runsThisMonth` are NULLABLE and a null is NOT a zero: it means
 * the Worker had no ledger to read. The dashboard renders a dash for it, the same
 * rule the spend view follows.
 */
export interface SupportDeploymentRow {
  workflowId: string;
  workflowName: string;
  /** Epoch milliseconds, matching the deployment registry. */
  updatedAt: number;
  cronArmed: boolean;
  portalSlug: string | null;
  creditsSpent: number | null;
  runsThisMonth: number | null;
}

/** `GET /api/deployments`, read as another owner. */
export interface SupportDeploymentsResponse {
  /** The `YYYY-MM` window the spend figures cover. */
  month: string;
  deployments: SupportDeploymentRow[];
}

// --- Response body ---------------------------------------------------------

/** `GET /api/admin/impersonation`. */
export interface ImpersonationAuditResponse {
  entries: ImpersonationAuditRow[];
  /** The owner filter in force, or null when the read was unfiltered. */
  owner: string | null;
  limit: number;
  /** True when the row bound was reached, so older rows exist. */
  truncated: boolean;
  generatedAt: string;
}

// --- Constants -------------------------------------------------------------

/**
 * The view id, and therefore the URL segment.
 *
 * `impersonation` rather than `support` or `audit`: the surface is BOTH the way an
 * operator reads a customer's account and the record of having done so, and naming
 * it after either half would make one word mean the whole - the trap `spend` avoided
 * by not being called `costs`.
 */
export const IMPERSONATION_VIEW_ID = 'impersonation';
