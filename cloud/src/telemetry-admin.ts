/**
 * The Admin_API: owner-only aggregate reads over the Telemetry_Store, mounted
 * under `/api/admin/telemetry/` inside the existing `/api/*` control-plane
 * branch (9.1).
 *
 * This module is FAIL-CLOSED. Authorization is two independent facts about the
 * caller, answered in this order and never merged:
 *
 * | Condition                                                  | Status | Body                        |
 * |------------------------------------------------------------|--------|-----------------------------|
 * | No bearer token, or `verifyRequest` returns null           | 401    | `{"error":"Unauthorized."}`  |
 * | Verified, but the user id is null or not on the allowlist   | 403    | `{"error":"Forbidden."}`     |
 * | `TELEMETRY_ADMIN_USER_IDS` absent, empty or whitespace-only | 403    | `{"error":"Forbidden."}`     |
 * | Allowlisted                                                | 200    | the aggregate               |
 *
 * Both failure bodies are fixed literals. No route returns the Owner_Allowlist
 * and no response body ever names an allowlist entry (9.6). Every response this
 * module produces carries `Cache-Control: no-store`, including 400, 401, 403,
 * 404 and 405 (9.16).
 *
 * A missing secret means NO access, never open access (9.5): the allowlist is
 * the only key to this surface, so an unset secret closes the door rather than
 * removing it.
 */

import { verifyRequest, type AuthEnv } from './auth';
import { COUNTER_CATALOG } from './telemetry-catalog';
import { ensureTelemetrySchema, isMetricDay, metricDayUtc, type TelemetryEnv } from './telemetry';

/** The bindings the Admin_API touches: auth, the allowlist secret, and D1. */
export type TelemetryAdminEnv = AuthEnv &
  TelemetryEnv & {
    /** Comma-separated Clerk user ids (the Owner_Allowlist). Worker secret. */
    TELEMETRY_ADMIN_USER_IDS?: string;
    /**
     * Beta-only override: `"true"` turns the k-anonymity floor (9.15) off
     * everywhere, so every aggregate reports exact rows instead of folding
     * low-volume groups into `other`. Set as a `vars` entry per environment in
     * `wrangler.jsonc`, NOT a source change, so re-enabling for general
     * availability is a config flip and a redeploy, nothing else. Absent or
     * any other value means the floor is on, which is the default and the
     * only behaviour the existing test suites exercise.
     */
    TELEMETRY_K_ANONYMITY_DISABLED?: string;
  };

/**
 * The JSON responder `routeApiRequest` passes in, already bound to the current
 * request's CORS headers.
 */
export type TelemetryAdminRespond = (body: unknown, status?: number) => Response;

/** The path prefix this module owns. Every route sits below it. */
export const TELEMETRY_ADMIN_PREFIX = '/api/admin/telemetry/';

/**
 * Exact membership in the Owner_Allowlist after trimming each entry.
 *
 * NEVER a substring, prefix or `includes()` test on the raw secret: with a raw
 * substring check `user_123` would authorize `user_1234`, and an allowlist that
 * silently admits longer ids is not an allowlist. The secret is split on commas,
 * each entry is trimmed, empties are dropped, and the caller's id must equal one
 * of the survivors.
 *
 * An absent, empty or whitespace-only secret has no surviving entry, so this
 * returns false for every caller (9.5). A null user id - a shared-token or
 * open-instance identity - is never a member (9.4).
 */
export function isTelemetryAdmin(allowlist: string | undefined, userId: string | null): boolean {
  if (!allowlist) return false;
  const ids = allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) return false; // fail closed (9.5)
  return userId !== null && ids.includes(userId);
}

// --- Date range ------------------------------------------------------------

/** An inclusive Metric_Day range, both ends real `YYYY-MM-DD` calendar days. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * The parse outcome. A failure is DATA, not an exception and not a `Response`:
 * `parseDateRange` stays pure so one property can cover the whole grammar, and
 * the caller is the only thing that knows about HTTP.
 */
export type RangeResult = { ok: true; range: DateRange } | { ok: false; error: string };

/** Inclusive length of the default range when `from` or `to` is absent (9.12). */
export const TELEMETRY_RANGE_DEFAULT_DAYS = 30;

/**
 * Maximum INCLUSIVE length of a requested range, in days (9.13). Deliberately
 * the same number as the Retention_Window: asking for more days than the store
 * keeps cannot return more data, only more work.
 */
export const TELEMETRY_RANGE_MAX_DAYS = 400;

/** The single fixed body every range failure answers with (9.12, 9.13). */
export const INVALID_RANGE_ERROR = 'Invalid date range.';

/**
 * Parses the `from`/`to` query grammar shared by all five aggregate routes.
 *
 * PURE by design - `today` is passed in rather than read from the clock, so the
 * whole grammar is directly property-testable.
 *
 * The rules, in the order they are applied:
 *
 * - Either parameter ABSENT (the key is missing, so `get` returns `null`) means
 *   the trailing `TELEMETRY_RANGE_DEFAULT_DAYS` days ending on `today`,
 *   INCLUSIVE - so `to === today` and the range spans exactly 30 days, not 31.
 *   Absence short-circuits: a supplied partner value is not validated, because
 *   the requested range is the default range either way.
 * - A present value must be a real calendar day, which is `isMetricDay` -
 *   shape `YYYY-MM-DD` AND a round-trip through `Date`. `2026-02-30` passes the
 *   shape test and `Date.parse` happily rolls it over to March 2, so the
 *   round-trip is what rejects it. `2026-1-1` fails the shape test.
 * - `from > to` fails. Both values are zero-padded fixed-width days, so a
 *   lexicographic compare is a chronological compare.
 * - An inclusive length above the cap fails. Ends exactly 400 days apart
 *   inclusive (399 days of difference) are ACCEPTED; 401 is rejected.
 *
 * Every failure returns the same `INVALID_RANGE_ERROR`, which the caller turns
 * into `400 {"error":"Invalid date range."}`. The message never echoes the
 * offending input.
 */
export function parseDateRange(params: URLSearchParams, today: string): RangeResult {
  const fromParam = params.get('from');
  const toParam = params.get('to');

  if (fromParam === null || toParam === null) return defaultRange(today);

  if (!isMetricDay(fromParam) || !isMetricDay(toParam)) return invalidRange();
  if (fromParam > toParam) return invalidRange();
  if (inclusiveDays(fromParam, toParam) > TELEMETRY_RANGE_MAX_DAYS) return invalidRange();

  return { ok: true, range: { from: fromParam, to: toParam } };
}

// --- k-anonymity floor -----------------------------------------------------

/**
 * Minimum number of distinct installs a group needs before it may be reported
 * under its own label (9.15). Groups below it are folded into `other` - unless
 * `TELEMETRY_K_ANONYMITY_DISABLED` turns the floor off for the deployment, in
 * which case every aggregate function is called with a floor of `0` instead of
 * this value (see `handleTelemetryAdminRequest`). `applyKAnonymity` itself
 * always defaults to the real floor, so its own tests exercise 9.15 unchanged
 * regardless of that switch.
 */
export const K_ANONYMITY_FLOOR = 5;

/** The single label everything below the floor is reported under. */
export const K_ANONYMITY_OTHER_LABEL = 'other';

/**
 * One aggregate group row. `label` is the group key and `installs` is the
 * `COUNT(DISTINCT install_id)` the floor tests; every other property is a
 * numeric metric the fold sums.
 */
export interface GroupRow {
  label: string;
  installs: number;
  [metric: string]: string | number;
}

/**
 * Folds every group below the floor into a single `other` row, conserving
 * metrics (9.15).
 *
 * PURE - no clock, no I/O, and the input rows are never mutated, so one
 * property can cover the whole rule.
 *
 * The rules, precisely:
 *
 * - The floor is tested on `installs`, the distinct-install count. `installs`
 *   STRICTLY below `floor` folds, so exactly `floor` (5 by default) stays a row
 *   of its own. A row whose `installs` is not a finite number counts as zero and
 *   therefore folds - the bias is toward privacy, never toward publishing a
 *   group we cannot size.
 * - EVERY numeric property is summed into the `other` row, not just `installs`.
 *   The sum of each metric across the output equals its sum across the input, so
 *   a folded group still contributes its runs, sessions and counters to the
 *   totals a reader adds up. Non-numeric properties are dropped, because there is
 *   no meaningful sum of two labels.
 * - `installs` on the `other` row is the SUM of the folded rows' install counts.
 *   That is an upper bound on the distinct installs behind the bucket - it may
 *   double-count an install present in two folded groups, but it never
 *   under-reports the bucket's size.
 * - When nothing folds the `other` row is ABSENT entirely, not present with
 *   zeros, so a healthy data set has no mystery bucket. Surviving rows keep
 *   their input order and the `other` row is appended last.
 * - A surviving row that already carries the `other` label joins the fold, so
 *   the output can never carry two rows labelled `other`.
 */
export function applyKAnonymity(rows: readonly GroupRow[], floor = K_ANONYMITY_FLOOR): GroupRow[] {
  const kept: GroupRow[] = [];
  const folded: GroupRow[] = [];
  for (const row of rows) {
    (installCount(row) < floor ? folded : kept).push(row);
  }

  // Nothing below the floor: no `other` row at all (9.15).
  if (folded.length === 0) return kept.map(copyRow);

  const survivors: GroupRow[] = [];
  for (const row of kept) {
    (row.label === K_ANONYMITY_OTHER_LABEL ? folded : survivors).push(row);
  }

  const other: GroupRow = { label: K_ANONYMITY_OTHER_LABEL, installs: 0 };
  for (const row of folded) {
    for (const [key, value] of Object.entries(row)) {
      if (key === 'label' || typeof value !== 'number') continue;
      const running = other[key];
      other[key] = (typeof running === 'number' ? running : 0) + value;
    }
  }

  return [...survivors.map(copyRow), other];
}

// --- Aggregate routes ------------------------------------------------------

/** The five aggregate routes, all `GET`, all accepting `from` and `to`. */
export const TELEMETRY_ADMIN_ROUTES = [
  'summary',
  'geography',
  'environment',
  'features',
  'trend',
] as const;

export type TelemetryAdminRoute = (typeof TELEMETRY_ADMIN_ROUTES)[number];

/**
 * The single fixed body a D1 failure answers with. STATIC by construction: an
 * exception message from the store could name a column, a table or a bound
 * value, and none of that belongs in a response body.
 */
export const AGGREGATE_FAILED_ERROR = 'Telemetry aggregate unavailable.';

/** The trailing windows the summary route reports active installs over (9.7). */
export const ACTIVE_INSTALL_WINDOW_DAYS = { d1: 1, d7: 7, d30: 30 } as const;

/** `{ range, activeInstalls, totals }` - global numbers, no group labels (9.7). */
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

/** Installs and runs by `country_code` and by `region` (9.8). */
export interface GeographyResponse {
  range: DateRange;
  countries: GroupRow[];
  regions: GroupRow[];
}

/** Installs by app version, platform, runtime mode and locale (9.9). */
export interface EnvironmentResponse {
  range: DateRange;
  appVersion: GroupRow[];
  platform: GroupRow[];
  runtimeMode: GroupRow[];
  locale: GroupRow[];
}

/** One Counter_Catalog name present in range, with its total and reach. */
export interface FeatureRow {
  label: string;
  total: number;
  installs: number;
}

/** Summed Counter values grouped by Counter name (9.10). */
export interface FeaturesResponse {
  range: DateRange;
  counters: FeatureRow[];
}

/** One Metric_Day of the trend series. `label` is the Metric_Day (9.11). */
export interface TrendDay {
  label: string;
  installs: number;
  sessions: number;
  runs: number;
}

/**
 * Per-Metric_Day installs, sessions and runs, plus the number of days the
 * k-anonymity floor folded (9.11, 9.15).
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

/**
 * Distinct installs seen inside a day window. `?1` and `?2` are the inclusive
 * ends, so the query rides the `metric_day` index.
 */
export const TELEMETRY_ACTIVE_INSTALLS_SQL = `SELECT COUNT(DISTINCT install_id) AS installs
  FROM telemetry_rollups WHERE metric_day >= ?1 AND metric_day <= ?2`;

/**
 * The summary totals. Counters are stored as one JSON object per row, so a
 * named total is `json_extract` by counter name summed across rows.
 * `COALESCE(..., 0)` covers both an empty range and a row whose counter map
 * omits the name.
 */
export const TELEMETRY_TOTALS_SQL = `SELECT COUNT(DISTINCT install_id)                                     AS installs,
       COALESCE(SUM(json_extract(counters, '$."session.started"')), 0)  AS sessions,
       COALESCE(SUM(json_extract(counters, '$."run.started"')), 0)      AS runs,
       COALESCE(SUM(json_extract(counters, '$."run.completed"')), 0)    AS runs_completed,
       COALESCE(SUM(json_extract(counters, '$."run.error"')), 0)        AS run_errors
  FROM telemetry_rollups WHERE metric_day BETWEEN ?1 AND ?2`;

/**
 * Per-Metric_Day installs, sessions and runs, ordered so the dashboard receives
 * a time series it can plot without sorting.
 */
export const TELEMETRY_TREND_SQL = `SELECT metric_day AS label,
       COUNT(DISTINCT install_id) AS installs,
       COALESCE(SUM(json_extract(counters, '$."session.started"')), 0) AS sessions,
       COALESCE(SUM(json_extract(counters, '$."run.started"')), 0)     AS runs
  FROM telemetry_rollups WHERE metric_day BETWEEN ?1 AND ?2
 GROUP BY metric_day ORDER BY metric_day`;

/**
 * Per-counter-name totals. The counter map is JSON TEXT, so a per-name
 * aggregate has to expand it: `json_each` turns each row's map into one row per
 * entry, which is what makes `GROUP BY` on the counter name possible at all.
 * `installs` is the distinct-install reach of that counter, which is the number
 * the k-anonymity floor tests.
 */
export const TELEMETRY_FEATURES_SQL = `SELECT json_each.key AS label,
       COALESCE(SUM(json_each.value), 0) AS total,
       COUNT(DISTINCT telemetry_rollups.install_id) AS installs
  FROM telemetry_rollups, json_each(telemetry_rollups.counters)
 WHERE metric_day BETWEEN ?1 AND ?2
 GROUP BY json_each.key`;

/**
 * The columns a grouped route may group by. A LITERAL UNION, not a string: the
 * SQL builders below take this type, so no value derived from a request can
 * reach a `GROUP BY` clause. Query parameters never name a column here - the
 * route name selects the column.
 */
export const GROUP_COLUMNS = [
  'country_code',
  'region',
  'app_version',
  'platform',
  'runtime_mode',
  'locale',
] as const;

export type GroupColumn = (typeof GROUP_COLUMNS)[number];

/** `{ label, installs, runs }` by one group column - the geography shape (9.8). */
export function installsAndRunsSql(column: GroupColumn): string {
  return `SELECT ${column} AS label,
       COUNT(DISTINCT install_id) AS installs,
       COALESCE(SUM(json_extract(counters, '$."run.started"')), 0) AS runs
  FROM telemetry_rollups WHERE metric_day BETWEEN ?1 AND ?2
 GROUP BY ${column}`;
}

/** `{ label, installs }` by one group column - the environment shape (9.9). */
export function installsSql(column: GroupColumn): string {
  return `SELECT ${column} AS label,
       COUNT(DISTINCT install_id) AS installs
  FROM telemetry_rollups WHERE metric_day BETWEEN ?1 AND ?2
 GROUP BY ${column}`;
}

/**
 * Handles `/api/admin/telemetry/*`. Returns `null` for any other path, so
 * `routeApiRequest` falls through to the rest of the control plane - the same
 * convention `handleTelemetryRequest` and `handleStatusRequest` follow.
 *
 * The authorization gate runs BEFORE any route or method dispatch, so an
 * unauthorized caller cannot use the response code to learn which routes exist.
 */
export async function handleTelemetryAdminRequest(
  request: Request,
  env: TelemetryAdminEnv,
  url: URL,
  respond: TelemetryAdminRespond,
): Promise<Response | null> {
  if (!url.pathname.startsWith(TELEMETRY_ADMIN_PREFIX)) return null;

  const reply = noStore(respond);

  // 9.3 - an absent bearer token is a 401 on every deployment shape. Checked
  // here rather than left to `verifyRequest`, which hands an anonymous context
  // to an unprotected BYO worker; that identity would otherwise arrive at the
  // allowlist check and answer 403 for a request that carried no credential at
  // all.
  const token = readBearerToken(request);
  if (token === null) return reply({ error: 'Unauthorized.' }, 401);

  const auth = await verifyRequest(env, request);
  if (auth === null) return reply({ error: 'Unauthorized.' }, 401); // 9.3

  // 9.4, 9.5 - verified, but not the owner. A different fact from 401, and the
  // body says nothing about why or about who is on the list (9.6).
  //
  // The KIND check is part of that gate, not an extra. A Phorma desktop token
  // carries the same `userId` as the Clerk session that minted it, so an owner
  // signing in on the desktop app would otherwise carry operator access on a
  // long-lived bearer that sits in a laptop's keychain and cannot be revoked
  // before it expires (lean v1 - see `device-auth.ts`). Operator surfaces require
  // a human who authenticated in a browser just now, so this asks for a Clerk
  // session specifically. It answers 403 rather than 401 because the credential
  // IS valid; it is just not an operator credential.
  if (auth.kind !== 'clerk' || !isTelemetryAdmin(env.TELEMETRY_ADMIN_USER_IDS, auth.userId)) {
    return reply({ error: 'Forbidden.' }, 403);
  }

  if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);

  const route = url.pathname.slice(TELEMETRY_ADMIN_PREFIX.length);
  if (!isAggregateRoute(route)) return reply({ error: 'Not found.' }, 404);

  // 9.12, 9.13 - one grammar for all five routes, resolved against the Worker's
  // own UTC day so a client clock cannot widen the window.
  const parsed = parseDateRange(url.searchParams, metricDayUtc(Date.now()));
  if (!parsed.ok) return reply({ error: parsed.error }, 400);

  const floor = env.TELEMETRY_K_ANONYMITY_DISABLED === 'true' ? 0 : K_ANONYMITY_FLOOR;
  try {
    return reply(await aggregateTelemetry(route, parsed.range, env.DB, floor));
  } catch {
    // Fixed string, no query, no exception message, no binding name.
    console.error('telemetry admin aggregate failed');
    return reply({ error: AGGREGATE_FAILED_ERROR }, 500);
  }
}

// --- Aggregation -----------------------------------------------------------

/** Narrows a path tail to one of the five routes. */
function isAggregateRoute(route: string): route is TelemetryAdminRoute {
  return (TELEMETRY_ADMIN_ROUTES as readonly string[]).includes(route);
}

/**
 * Builds one aggregate body. The aggregation CORE: it knows about D1 and the
 * k-anonymity floor and nothing about HTTP or authorization, so a test can
 * exercise the five aggregates against a real D1 without minting a session
 * token.
 *
 * An ABSENT `DB` binding answers the empty aggregate for the route rather than
 * an error: on a BYO deployment there is no Telemetry_Store and never was, which
 * is an empty data set, not a failure. The dashboard then renders its empty
 * state (10.13) instead of an error state. A D1 failure is different and is
 * allowed to propagate to the caller's 500.
 *
 * No body carries an Install_Id (9.14). Nothing here selects `install_id` - it
 * only ever appears inside `COUNT(DISTINCT install_id)`, so an identity cannot
 * reach a response even by accident.
 */
export async function aggregateTelemetry(
  route: TelemetryAdminRoute,
  range: DateRange,
  db: D1Database | undefined,
  floor: number = K_ANONYMITY_FLOOR,
): Promise<AggregateResponse> {
  if (!db) return emptyAggregate(route, range);

  // Self-healing, exactly as on the ingest path: a deployment where migrations
  // were never applied would otherwise fail on a missing table.
  await ensureTelemetrySchema(db);

  switch (route) {
    case 'summary':
      return summaryAggregate(db, range);
    case 'geography':
      return geographyAggregate(db, range, floor);
    case 'environment':
      return environmentAggregate(db, range, floor);
    case 'features':
      return featuresAggregate(db, range, floor);
    case 'trend':
      return trendAggregate(db, range, floor);
  }
}

/**
 * Global totals plus the three trailing active-install windows (9.7).
 *
 * The k-anonymity floor does NOT apply here: these are global numbers with no
 * group labels, so there is no group to fold. This is the one route that can
 * report a count below the floor, and that is correct - a global install count
 * is not a group (9.15).
 *
 * Each trailing window is CLAMPED to the requested range, so a row outside the
 * range contributes to nothing on this route.
 */
async function summaryAggregate(db: D1Database, range: DateRange): Promise<SummaryResponse> {
  const d1 = trailingWindow(range, ACTIVE_INSTALL_WINDOW_DAYS.d1);
  const d7 = trailingWindow(range, ACTIVE_INSTALL_WINDOW_DAYS.d7);
  const d30 = trailingWindow(range, ACTIVE_INSTALL_WINDOW_DAYS.d30);

  const [active1, active7, active30, totals] = await db.batch<AggregateRow>([
    db.prepare(TELEMETRY_ACTIVE_INSTALLS_SQL).bind(d1.from, d1.to),
    db.prepare(TELEMETRY_ACTIVE_INSTALLS_SQL).bind(d7.from, d7.to),
    db.prepare(TELEMETRY_ACTIVE_INSTALLS_SQL).bind(d30.from, d30.to),
    db.prepare(TELEMETRY_TOTALS_SQL).bind(range.from, range.to),
  ]);

  const totalsRow = firstRow(totals);
  return {
    range,
    activeInstalls: {
      d1: metric(firstRow(active1)['installs']),
      d7: metric(firstRow(active7)['installs']),
      d30: metric(firstRow(active30)['installs']),
    },
    totals: {
      installs: metric(totalsRow['installs']),
      sessions: metric(totalsRow['sessions']),
      runs: metric(totalsRow['runs']),
      runsCompleted: metric(totalsRow['runs_completed']),
      runErrors: metric(totalsRow['run_errors']),
    },
  };
}

/** Installs and runs by country and by region, both folded (9.8, 9.15). */
async function geographyAggregate(
  db: D1Database,
  range: DateRange,
  floor: number,
): Promise<GeographyResponse> {
  const [countries, regions] = await db.batch<AggregateRow>([
    db.prepare(installsAndRunsSql('country_code')).bind(range.from, range.to),
    db.prepare(installsAndRunsSql('region')).bind(range.from, range.to),
  ]);

  return {
    range,
    countries: foldInstallsAndRuns(countries, floor),
    regions: foldInstallsAndRuns(regions, floor),
  };
}

/** Installs by app version, platform, runtime mode and locale, all folded (9.9). */
async function environmentAggregate(
  db: D1Database,
  range: DateRange,
  floor: number,
): Promise<EnvironmentResponse> {
  const [appVersion, platform, runtimeMode, locale] = await db.batch<AggregateRow>([
    db.prepare(installsSql('app_version')).bind(range.from, range.to),
    db.prepare(installsSql('platform')).bind(range.from, range.to),
    db.prepare(installsSql('runtime_mode')).bind(range.from, range.to),
    db.prepare(installsSql('locale')).bind(range.from, range.to),
  ]);

  return {
    range,
    appVersion: foldInstalls(appVersion, floor),
    platform: foldInstalls(platform, floor),
    runtimeMode: foldInstalls(runtimeMode, floor),
    locale: foldInstalls(locale, floor),
  };
}

/**
 * Summed Counter values by Counter name (9.10).
 *
 * `label` is filtered against the Counter_Catalog BEFORE the fold, so a counter
 * name this Worker does not know cannot reach the dashboard under its own label
 * or inside `other`. Ingest already enforces the catalog at write time, so this
 * is belt and braces for rows written by an older Worker.
 */
async function featuresAggregate(
  db: D1Database,
  range: DateRange,
  floor: number,
): Promise<FeaturesResponse> {
  const rows = await db
    .prepare(TELEMETRY_FEATURES_SQL)
    .bind(range.from, range.to)
    .all<AggregateRow>();

  const known = resultRows(rows)
    .filter((row) => COUNTER_CATALOG.has(label(row['label'])))
    .map(
      (row): GroupRow => ({
        label: label(row['label']),
        total: metric(row['total']),
        installs: metric(row['installs']),
      }),
    );

  const counters = applyKAnonymity(known, floor).map(
    (row): FeatureRow => ({
      label: label(row.label),
      total: metric(row['total']),
      installs: metric(row.installs),
    }),
  );
  return { range, counters };
}

/**
 * The per-Metric_Day series (9.11).
 *
 * The floor applies here like anywhere else: a day whose distinct-install count
 * is below it folds into `other`, and `foldedDays` reports how many days went
 * that way so the dashboard can render "N days below the reporting threshold"
 * as a footnote and keep the plot a time series (9.15).
 */
async function trendAggregate(
  db: D1Database,
  range: DateRange,
  floor: number,
): Promise<TrendResponse> {
  const rows = await db.prepare(TELEMETRY_TREND_SQL).bind(range.from, range.to).all<AggregateRow>();

  const series = resultRows(rows).map(
    (row): GroupRow => ({
      label: label(row['label']),
      installs: metric(row['installs']),
      sessions: metric(row['sessions']),
      runs: metric(row['runs']),
    }),
  );

  const foldedDays = series.filter((row) => metric(row.installs) < floor).length;
  const days = applyKAnonymity(series, floor).map(
    (row): TrendDay => ({
      label: label(row.label),
      installs: metric(row.installs),
      sessions: metric(row['sessions']),
      runs: metric(row['runs']),
    }),
  );
  return { range, days, foldedDays };
}

/**
 * The empty body for a route, used when there is no `DB` binding. Same key set
 * as the populated body, so the dashboard's typing never has a second shape to
 * handle.
 */
function emptyAggregate(route: TelemetryAdminRoute, range: DateRange): AggregateResponse {
  switch (route) {
    case 'summary':
      return {
        range,
        activeInstalls: { d1: 0, d7: 0, d30: 0 },
        totals: { installs: 0, sessions: 0, runs: 0, runsCompleted: 0, runErrors: 0 },
      };
    case 'geography':
      return { range, countries: [], regions: [] };
    case 'environment':
      return { range, appVersion: [], platform: [], runtimeMode: [], locale: [] };
    case 'features':
      return { range, counters: [] };
    case 'trend':
      return { range, days: [], foldedDays: 0 };
  }
}

/** One raw aggregate row as D1 hands it back. */
type AggregateRow = Record<string, unknown>;

/**
 * `{ label, installs, runs }` rows through the floor, rebuilt afterwards so the
 * serialized key set is exactly the declared shape.
 */
function foldInstallsAndRuns(result: D1Result<AggregateRow>, floor: number): GroupRow[] {
  const rows = resultRows(result).map(
    (row): GroupRow => ({
      label: label(row['label']),
      installs: metric(row['installs']),
      runs: metric(row['runs']),
    }),
  );
  return applyKAnonymity(rows, floor).map((row) => ({
    label: label(row.label),
    installs: metric(row.installs),
    runs: metric(row['runs']),
  }));
}

/** `{ label, installs }` rows through the floor, same rebuild. */
function foldInstalls(result: D1Result<AggregateRow>, floor: number): GroupRow[] {
  const rows = resultRows(result).map(
    (row): GroupRow => ({ label: label(row['label']), installs: metric(row['installs']) }),
  );
  return applyKAnonymity(rows, floor).map((row) => ({
    label: label(row.label),
    installs: metric(row.installs),
  }));
}

/**
 * A trailing window of `days` ending on `range.to`, INCLUSIVE, clamped to
 * `range.from`.
 *
 * Clamping is what keeps "rows outside the requested range contribute nothing"
 * true on the summary route: a 3-day range must not let the `d30` window reach
 * back 27 days beyond what the caller asked for.
 */
function trailingWindow(range: DateRange, days: number): DateRange {
  const toMs = Date.parse(`${range.to}T00:00:00.000Z`);
  const start = Number.isFinite(toMs) ? formatDay(toMs - (days - 1) * MS_PER_DAY) : null;
  if (start === null) return { from: range.from, to: range.to };
  return { from: start > range.from ? start : range.from, to: range.to };
}

/** The rows of a result, or an empty list when D1 reports none. */
function resultRows(result: D1Result<AggregateRow>): AggregateRow[] {
  return result.results ?? [];
}

/** The single row of an aggregate-without-grouping query, or an empty row. */
function firstRow(result: D1Result<AggregateRow>): AggregateRow {
  return resultRows(result)[0] ?? {};
}

/**
 * A metric as a finite number. `COUNT` and `SUM` come back as numbers, but an
 * empty `SUM` can arrive as `null` and a JSON-sourced value can arrive as a
 * string, and neither may become a `NaN` in a response body.
 */
function metric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A group label as a string. A `NULL` column becomes `''`, never `"null"`. */
function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

// --- Internals -------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** The single failure shape, so no call site can invent a second message. */
function invalidRange(): RangeResult {
  return { ok: false, error: INVALID_RANGE_ERROR };
}

/**
 * The trailing default window ending on `today`, inclusive. `today` itself must
 * be a real calendar day; a caller that hands over nonsense gets the same
 * failure as a nonsense query parameter rather than a fabricated range.
 */
function defaultRange(today: string): RangeResult {
  if (!isMetricDay(today)) return invalidRange();
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const from = formatDay(todayMs - (TELEMETRY_RANGE_DEFAULT_DAYS - 1) * MS_PER_DAY);
  if (from === null) return invalidRange();
  return { ok: true, range: { from, to: today } };
}

/** Inclusive day count between two real calendar days, `from <= to`. */
function inclusiveDays(from: string, to: string): number {
  const spanMs = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.round(spanMs / MS_PER_DAY) + 1;
}

/**
 * `YYYY-MM-DD` for a UTC instant, or `null` when the year falls outside the
 * four-digit range. Built from the UTC getters rather than `toISOString`, which
 * switches to expanded years (`-000001-12-07`) near year zero and would emit a
 * string no `YYYY-MM-DD` consumer can read.
 */
function formatDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * The distinct-install count the k-anonymity floor tests. Anything that is not
 * a finite number counts as ZERO, so a row we cannot size folds instead of
 * being published: the bias is toward privacy. D1 hands back a number for a
 * `COUNT(DISTINCT ...)`, but the index signature on `GroupRow` lets a caller
 * pass a string or a `NaN`, and that must not become an exemption from the
 * floor.
 */
function installCount(row: GroupRow): number {
  const installs: string | number = row.installs;
  return typeof installs === 'number' && Number.isFinite(installs) ? installs : 0;
}

/**
 * A shallow copy of a surviving row, so `applyKAnonymity` never hands back a
 * reference into its input. Metrics are numbers and labels are strings, so
 * there is no nested state to clone.
 */
function copyRow(row: GroupRow): GroupRow {
  return { ...row };
}

/**
 * Wraps the shared responder so every answer carries `Cache-Control: no-store`
 * (9.16). Aggregated product telemetry must never sit in a shared cache, and an
 * authorization failure must never be cached either.
 */
function noStore(respond: TelemetryAdminRespond): TelemetryAdminRespond {
  return (body: unknown, status = 200): Response => {
    const base = respond(body, status);
    const headers = new Headers(base.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(base.body, { status: base.status, headers });
  };
}

/**
 * The bearer token, or `null` when the request carries none. An empty or
 * whitespace-only token counts as none: it is an absent credential, not a
 * rejected one.
 */
function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
