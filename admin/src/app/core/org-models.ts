/**
 * Organisation management response shapes, as the dashboard sees them.
 *
 * STRUCTURAL TWIN of `cloud/src/org-admin.ts`. Every interface here is declared
 * independently and nothing is imported across the package boundary - the same
 * arrangement `models.ts` has with `telemetry-admin.ts` and `billing-models.ts`
 * has with `billing-admin.ts`.
 *
 * ## Why there are THREE model files and not one
 *
 * `models.ts` bodies carry no install id by construction; `billing-models.ts`
 * bodies name paying tenants on purpose; these bodies name INDIVIDUAL PEOPLE by
 * Clerk user id, because "who is in this organisation and at what level" is not
 * answerable without them. Three different disclosure contracts over three
 * different tables behind one operator allowlist. Do not merge them.
 *
 * ## The level and tier vocabularies are DATA, not declarations
 *
 * A `level` here is a plain `string`, and that is deliberate rather than lazy.
 * The Capability_Level tokens already exist as a twinned pair
 * (`cloud/src/capabilities.ts` and `frontend/src/app/core/capabilities.ts`), and a
 * third independent copy in this package would be a third thing to keep in step -
 * with no test loading all three, since `cloud/test/capabilities.test.mjs` compares
 * exactly two. So the Worker REPORTS its vocabulary on every read
 * ({@link OrgListResponse.levels}, {@link OrgMembersResponse.levels}) and the
 * dashboard renders whatever it is told. A level added to the contract reaches the
 * select box with no change in this package, and the dashboard can never offer a
 * token the Worker would refuse with `role_unknown`.
 *
 * The same reasoning covers {@link OrgListResponse.tiers}.
 */

// --- Rows ------------------------------------------------------------------

/**
 * One organisation.
 *
 * `name` and `slug` are NULLABLE because they come from the identity provider and
 * that read can fail. A null is "could not be read", never "has no name" - the
 * same null-is-not-a-zero rule the spend view follows, and the reason
 * {@link OrgListResponse.degraded} exists beside them.
 *
 * `status` carries `unprovisioned` on top of the three billing statuses: an
 * organisation that exists upstream with no account row at all is a real,
 * actionable, half-finished creation, and folding it onto `canceled` would hide it.
 */
export interface OrgSummary {
  /** The Owner_Id. `org_...`. */
  id: string;
  name: string | null;
  slug: string | null;
  /** The account row's tier token. {@link UNPAID_ORG_TIER} when unpaid. */
  tier: string;
  status: 'active' | 'past_due' | 'canceled' | 'unprovisioned';
  /** Membership rows for this organisation. The authoritative count. */
  members: number;
}

/** One membership, straight off the authoritative table. */
export interface OrgMemberRow {
  userId: string;
  /** A level token from the vocabulary the same response carried. */
  level: string;
  /** The acting party recorded at the last write. Audit only. */
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Response bodies -------------------------------------------------------

/** `GET list`. */
export interface OrgListResponse {
  organisations: OrgSummary[];
  /** Every level token, in display order (least capable first). */
  levels: string[];
  /** Every tier the tier route accepts, unpaid token first. */
  tiers: string[];
  /** Which half of the read failed, by name. See {@link DEGRADED_CLERK}. */
  degraded: string[];
}

/** `GET members`. */
export interface OrgMembersResponse {
  orgId: string;
  members: OrgMemberRow[];
  levels: string[];
}

/** `POST create`. */
export interface OrgCreateResponse {
  organisation: OrgSummary;
}

/** `POST members` and `DELETE members`. */
export interface OrgMemberWriteResponse {
  orgId: string;
  userId: string;
  /** The level now on record, or null after a removal. */
  level: string | null;
  clerkMembership: 'written' | 'removed' | 'absent';
}

/** `POST tier`. */
export interface OrgTierResponse {
  orgId: string;
  tier: string;
  status: 'active' | 'past_due' | 'canceled';
  runtimeKeyProvisioned: boolean;
  runtimeKeyAction: string;
  runtimeKeyLimitUsd: number;
  supersededKeyDisabled: boolean | null;
  runtimeKeyDetail?: string;
}

// --- Constants -------------------------------------------------------------

/**
 * The tier token that means "no paid plan". Twin of `UNPAID_ORG_TIER`.
 *
 * Restated here rather than read off a response because the VIEW needs it before
 * any response arrives: it is what the tier select opens on, and it is how a row
 * is rendered as unpaid rather than as a plan nobody recognises.
 */
export const UNPAID_ORG_TIER = 'none';

/** The `degraded` entry naming a failed identity-provider read. Twin of `DEGRADED_CLERK`. */
export const DEGRADED_CLERK = 'clerk';

/**
 * The view id, and therefore the URL segment.
 *
 * `organisations` rather than `orgs` or `members`: the surface manages
 * organisations AND the people in them, so naming it after one of the two would
 * make one word mean both a URL segment and half of what is behind it - the same
 * trap `spend` avoided by not being called `costs`.
 */
export const ORG_VIEW_ID = 'organisations';

/**
 * The four routes this family exposes. Twin of `ORG_ADMIN_ROUTES`.
 *
 * Present so a URL is built from a checked token rather than a string literal at
 * each call site.
 */
export const ORG_ADMIN_ROUTES = ['list', 'create', 'members', 'tier'] as const;

export type OrgAdminRoute = (typeof ORG_ADMIN_ROUTES)[number];
