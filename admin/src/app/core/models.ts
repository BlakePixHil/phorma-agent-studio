/**
 * Admin_API response shapes, as the dashboard sees them.
 *
 * STRUCTURAL TWIN of `cloud/src/telemetry-admin.ts`. Every interface here is
 * declared independently and nothing is imported across the package boundary -
 * the same arrangement as `engine/src/types.ts` and
 * `frontend/src/app/core/workflow.model.ts`. Changing a shape on one side
 * without the other compiles in one package and breaks the other, so the two
 * files are edited together.
 *
 * Only aggregate rows cross the wire. No Install_Id appears in any of these
 * shapes, by construction rather than by filtering (Requirement 9.14), and
 * neither does the Owner_Allowlist.
 */

// --- Range -----------------------------------------------------------------

/**
 * An inclusive Metric_Day range, both ends a real `YYYY-MM-DD` calendar day.
 * Sent as the `from` and `to` query parameters and echoed back on every
 * response, so a view can always show which range its numbers describe.
 */
export interface DateRange {
  from: string;
  to: string;
}

// --- Grouped rows ----------------------------------------------------------

/**
 * One aggregate group row. `label` is the group key and `installs` is the
 * distinct-install count the k-anonymity floor tests; every other property is a
 * numeric metric (the geography routes add `runs`).
 *
 * The index signature is what makes the shape a faithful twin: the Worker sums
 * every numeric property when it folds a group, so a row can legitimately carry
 * metrics this file does not name.
 */
export interface GroupRow {
  label: string;
  installs: number;
  [metric: string]: string | number;
}

/**
 * The single label the Worker reports everything below its k-anonymity floor
 * under (Requirement 9.15). Declared here so a view can mark that row as a
 * fold rather than treating it as a real group. Twin of
 * `K_ANONYMITY_OTHER_LABEL`.
 */
export const OTHER_GROUP_LABEL = 'other';

/**
 * Minimum distinct installs a group needs before it is reported under its own
 * label (9.15); below it, a group folds into `OTHER_GROUP_LABEL`. Twin of
 * `K_ANONYMITY_FLOOR` (cloud/src/telemetry-admin.ts) - a view states this
 * number so a single-digit install count folding into `other` reads as the
 * privacy floor working, not as a bug.
 */
export const K_ANONYMITY_FLOOR = 5;

// --- The five aggregate bodies ---------------------------------------------

/** `GET summary` - global numbers, no group labels (Requirement 10.5). */
export interface SummaryResponse {
  range: DateRange;
  activeInstalls: { d1: number; d7: number; d30: number };
  totals: {
    installs: number;
    sessions: number;
    runs: number;
    runsCompleted: number;
    runErrors: number;
  };
}

/** `GET geography` - installs and runs by country and by region (10.6). */
export interface GeographyResponse {
  range: DateRange;
  countries: GroupRow[];
  regions: GroupRow[];
}

/** `GET environment` - installs by app version, platform, mode, locale (10.7). */
export interface EnvironmentResponse {
  range: DateRange;
  appVersion: GroupRow[];
  platform: GroupRow[];
  runtimeMode: GroupRow[];
  locale: GroupRow[];
}

/** One Counter name present in range, with its total and its reach. */
export interface FeatureRow {
  label: string;
  total: number;
  installs: number;
}

/** `GET features` - summed Counter values grouped by Counter name (10.8). */
export interface FeaturesResponse {
  range: DateRange;
  counters: FeatureRow[];
}

/** One Metric_Day of the trend series. `label` is the Metric_Day. */
export interface TrendDay {
  label: string;
  installs: number;
  sessions: number;
  runs: number;
}

/**
 * `GET trend` - per-day installs, sessions and runs, plus the number of days
 * the k-anonymity floor folded (10.9).
 */
export interface TrendResponse {
  range: DateRange;
  days: TrendDay[];
  foldedDays: number;
}

/** Any one of the five aggregate bodies. */
export type AggregateResponse =
  | SummaryResponse
  | GeographyResponse
  | EnvironmentResponse
  | FeaturesResponse
  | TrendResponse;

/** The five aggregate routes, in the order the view nav lists them. */
export const TELEMETRY_ROUTES = [
  'summary',
  'geography',
  'environment',
  'features',
  'trend',
] as const;

export type TelemetryRoute = (typeof TELEMETRY_ROUTES)[number];
