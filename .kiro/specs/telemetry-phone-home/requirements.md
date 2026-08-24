# Requirements Document

## Introduction

Phone Home adds anonymous product telemetry to Phorma Agent Studio plus an owner-facing admin
dashboard that renders it. The studio accumulates feature-level counters locally, rolls them up per
install per calendar day, and uploads them to a new unauthenticated ingest route on the existing
`cloud/` Cloudflare Worker, which stores rollups in D1. Coarse geography is derived server side from
Cloudflare request headers so the client never sends or the server never stores a network address.
A separately deployed Angular admin dashboard reads a Clerk-authenticated admin API on the same
Worker, authorized against an allowlist of owner Clerk user ids held in a Worker secret.

Telemetry is opt-out: enabled by default after a first-run disclosure, with a single toggle in a new
Privacy section of the Settings dialog. Scope for this version is counters only. No prompt text, no
workflow names, no run payloads, no per-event stream, and no reads from the credit or usage
accounting stores.

## Glossary

- **Studio**: the Angular application in `frontend/`, running either inside the Tauri desktop shell
  or in a plain browser.
- **Telemetry_Service**: the new Angular service in `frontend/src/app/core/` that owns consent,
  install identity, counter accumulation, rollup, and upload.
- **Consent_State**: the persisted boolean recording whether the current install uploads telemetry,
  together with the version of the disclosure the user has seen.
- **First_Run_Notice**: the one-time in-app disclosure shown on the first launch of an install,
  stating that anonymous usage counters are collected and how to turn collection off.
- **Privacy_Settings_Section**: the new Privacy section of the existing Settings dialog, holding the
  telemetry toggle and the privacy policy reference.
- **Install_Id**: a client-generated random identifier (UUID v4) identifying one installation of the
  Studio, with no relationship to any account, machine, or network identity.
- **Client_Environment**: the set `{locale, timezone, platform, osVersion, appVersion, runtimeMode}`
  describing the install, where `runtimeMode` is `desktop` or `browser`.
- **Counter**: a named non-negative integer accumulated locally for one Metric_Day, drawn from the
  Counter_Catalog.
- **Counter_Catalog**: the closed, code-defined list of permitted Counter names.
- **Metric_Day**: a calendar day in UTC, formatted `YYYY-MM-DD`, used as the aggregation bucket.
- **Rollup**: the payload for one Install_Id and one Metric_Day, containing Client_Environment and
  the Counter values accumulated for that Metric_Day.
- **Upload_Queue**: the local persisted list of Rollups that are sealed and awaiting successful
  upload.
- **Ingest_Endpoint**: the new unauthenticated `POST /telemetry` route on the `cloud/` Worker that
  accepts Rollups.
- **Telemetry_Store**: the D1 tables owned by this feature, reached through the existing `DB`
  binding.
- **Geo_Resolver**: the Worker code that derives Coarse_Geo from Cloudflare request headers.
- **Coarse_Geo**: the pair `{countryCode, region}` where `countryCode` is an ISO 3166-1 alpha-2 code
  and `region` is a continent-level grouping.
- **Admin_API**: the new `/api/admin/telemetry/*` routes on the `cloud/` Worker serving aggregated
  telemetry to the Admin_Dashboard.
- **Owner_Allowlist**: the comma-separated list of Clerk user ids in the `TELEMETRY_ADMIN_USER_IDS`
  Worker secret that are authorized to call the Admin_API.
- **Admin_Dashboard**: the new Angular application, deployed independently of the Studio, that
  renders Admin_API data.
- **Retention_Window**: the maximum age of a stored Rollup row, set to 400 days.

## Requirements

### Requirement 1: Consent and first-run disclosure

**User Story:** As a Studio user, I want to be told that anonymous usage counters are collected and
to be able to turn collection off in one place, so that I stay in control of what leaves my machine.

#### Acceptance Criteria

1. WHEN the Studio starts and no Consent_State is persisted, THE Telemetry_Service SHALL persist
   Consent_State with collection enabled and record the disclosure version that the First_Run_Notice
   presents.
2. WHEN the Studio starts and no Consent_State was persisted before that start, THE Studio SHALL
   display the First_Run_Notice containing the categories of data collected, a control that opens
   Privacy_Settings_Section, and a link to the privacy policy.
3. WHEN the user dismisses the First_Run_Notice, THE Studio SHALL keep the notice hidden on every
   subsequent start for the same persisted disclosure version.
4. THE Privacy_Settings_Section SHALL render one toggle bound to Consent_State, the Install_Id, a
   plain-language list of the Counter_Catalog categories and Client_Environment fields, and the
   privacy policy reference.
5. WHEN the user sets the Consent_State toggle to disabled, THE Telemetry_Service SHALL stop
   accumulating Counters, discard the Upload_Queue, and clear locally accumulated Counters within the
   same user interaction.
6. WHILE Consent_State is disabled, THE Telemetry_Service SHALL make no request to the
   Ingest_Endpoint.
7. WHEN the user sets the Consent_State toggle from disabled to enabled, THE Telemetry_Service SHALL
   resume accumulation starting from the current Metric_Day with all Counters at zero.
8. IF the persisted disclosure version is lower than the current disclosure version, THEN THE Studio
   SHALL display the First_Run_Notice again and persist the current disclosure version, preserving
   the existing Consent_State value.

### Requirement 2: Install identity

**User Story:** As the app owner, I want counters grouped by installation without identifying a
person, so that I can read adoption and retention without holding personal data.

#### Acceptance Criteria

1. WHEN the Telemetry_Service initializes and no Install_Id is persisted, THE Telemetry_Service SHALL
   generate a random UUID v4 Install_Id and persist it in `localStorage` under a `phorma.telemetry.*`
   key.
2. WHILE a persisted Install_Id exists, THE Telemetry_Service SHALL reuse that Install_Id for every
   Rollup.
3. THE Telemetry_Service SHALL derive Install_Id from a cryptographically secure random source with
   no input from account identity, hardware identifiers, network address, file paths, or user
   content.
4. WHEN the user activates the reset control in Privacy_Settings_Section, THE Telemetry_Service SHALL
   generate a new Install_Id, discard the Upload_Queue, and clear locally accumulated Counters.
5. THE Studio SHALL send the Install_Id only to the Ingest_Endpoint.

### Requirement 3: Counter collection

**User Story:** As the app owner, I want to know which features are actually used, so that I can
invest in the surfaces that matter.

#### Acceptance Criteria

1. THE Counter_Catalog SHALL contain exactly the counters for sessions started, runs started, runs
   completed, run errors, node kinds instantiated keyed by node kind, panels opened keyed by panel
   id, assistant invocations keyed by assistant mode, deploys started keyed by deploy target, and
   error events keyed by error category.
2. WHEN a surface reports a Counter name that is present in the Counter_Catalog, THE
   Telemetry_Service SHALL increment that Counter for the current Metric_Day by the reported amount.
3. IF a surface reports a Counter name that is absent from the Counter_Catalog, THEN THE
   Telemetry_Service SHALL discard the report and leave every stored Counter unchanged.
4. THE Telemetry_Service SHALL accept only a Counter name from the Counter_Catalog and a positive
   integer amount as increment input, and SHALL reject any additional payload.
5. THE Telemetry_Service SHALL derive Counter values solely from in-process increment calls, and
   SHALL read neither the `usage_ledger` cloud table nor the local `usage` IndexedDB store.
6. THE Telemetry_Service SHALL persist accumulated Counters for the current Metric_Day so that
   counters survive a Studio restart within the same Metric_Day.
7. WHEN the Studio calls an increment while Consent_State is disabled, THE Telemetry_Service SHALL
   return without persisting any value.
8. THE Telemetry_Service SHALL populate Client_Environment `osVersion` through `TauriService` while
   the Studio runs on desktop, and SHALL populate `osVersion` from the browser user agent platform
   string while the Studio runs in a browser.

### Requirement 4: Rollup and upload

**User Story:** As the app owner, I want counters delivered as compact daily rollups, so that ingest
volume stays flat as usage grows.

#### Acceptance Criteria

1. WHEN the current Metric_Day differs from the Metric_Day of the accumulated Counters, THE
   Telemetry_Service SHALL seal the accumulated Counters into a Rollup, append that Rollup to the
   Upload_Queue, and reset accumulation for the new Metric_Day.
2. WHEN a Rollup is present in the Upload_Queue and Consent_State is enabled, THE Telemetry_Service
   SHALL send that Rollup to the Ingest_Endpoint as a single JSON `POST` request.
3. THE Telemetry_Service SHALL send at most one Ingest_Endpoint request per 15 minute interval.
4. WHEN the Ingest_Endpoint answers HTTP 200 for a Rollup, THE Telemetry_Service SHALL remove that
   Rollup from the Upload_Queue.
5. THE Rollup SHALL contain exactly the Install_Id, the Metric_Day, the Client_Environment fields,
   the Counter map, and a schema version integer.
6. THE Telemetry_Service SHALL populate each Rollup with the cumulative Counter totals accumulated
   for that Install_Id and Metric_Day, so that a later Rollup for the same Install_Id and Metric_Day
   supersedes an earlier one.
7. WHEN 6 hours have elapsed since the last seal and the current Metric_Day still has a Counter
   greater than zero, THE Telemetry_Service SHALL seal an interim Rollup for the current Metric_Day,
   append that Rollup to the Upload_Queue, and retain the accumulated Counters for further
   accumulation.
8. WHEN the Upload_Queue holds more than one Rollup for the same Install_Id and Metric_Day, THE
   Telemetry_Service SHALL retain only the most recently sealed Rollup for that Install_Id and
   Metric_Day.
9. THE Telemetry_Service SHALL perform initialization, sealing, and upload without blocking Studio
   startup rendering.

### Requirement 5: Offline and failure resilience

**User Story:** As a Studio user, I want telemetry to be invisible when it fails, so that a network
problem or an unreachable ingest host never affects my work.

#### Acceptance Criteria

1. IF an Ingest_Endpoint request fails with a network error or a timeout, THEN THE Telemetry_Service
   SHALL retain the Rollup in the Upload_Queue and surface no user-visible error.
2. IF an Ingest_Endpoint request answers with an HTTP status of 500 or higher, or with HTTP 429, THEN
   THE Telemetry_Service SHALL retain the Rollup in the Upload_Queue and schedule a retry.
3. IF an Ingest_Endpoint request answers with an HTTP status in the range 400 to 428 or 430 to 499,
   THEN THE Telemetry_Service SHALL remove the Rollup from the Upload_Queue and record the rejection
   count locally.
4. WHEN a retry is scheduled after consecutive failures, THE Telemetry_Service SHALL wait an interval
   of `min(15 minutes * 2^(failureCount - 1), 24 hours)` before the next request.
5. THE Telemetry_Service SHALL cap the Upload_Queue at 30 Rollups and SHALL discard the oldest Rollup
   when appending to a full Upload_Queue.
6. THE Telemetry_Service SHALL abort an Ingest_Endpoint request that has not completed within 10
   seconds and treat the abort as a network failure.
7. IF Telemetry_Service initialization throws, THEN THE Studio SHALL continue startup with telemetry
   inactive for that session.
8. THE Telemetry_Service SHALL write no telemetry failure entry to the bottom terminal console and
   SHALL raise no toast for any telemetry outcome.

### Requirement 6: Ingest endpoint

**User Story:** As the app owner, I want an ingest route that accepts anonymous rollups without
becoming an open write surface, so that the store stays trustworthy and cheap.

#### Acceptance Criteria

1. THE Ingest_Endpoint SHALL be a `POST /telemetry` route on the existing `cloud/` Worker, matched
   before the `/api/*` control-plane branch and before the generic `OPTIONS` branch.
2. THE Ingest_Endpoint SHALL answer a `POST /telemetry` request without an `Authorization` header.
3. THE Ingest_Endpoint SHALL answer `OPTIONS /telemetry` with an allowed origin set that is
   independent of `ALLOWED_ORIGINS`, permitting the `POST` method and the `Content-Type` header.
4. WHEN a request body parses as JSON and satisfies the Rollup schema, THE Ingest_Endpoint SHALL
   write one row to the Telemetry_Store and answer HTTP 200 with an empty JSON object.
5. IF a request body exceeds 16 kilobytes, THEN THE Ingest_Endpoint SHALL answer HTTP 413 and write
   nothing to the Telemetry_Store.
6. IF a request body fails JSON parsing or Rollup schema validation, THEN THE Ingest_Endpoint SHALL
   answer HTTP 400 with a static reason string and write nothing to the Telemetry_Store.
7. THE Ingest_Endpoint SHALL reject a Rollup whose Install_Id is not a UUID v4 string, whose
   Metric_Day is not a `YYYY-MM-DD` date within 30 days before the request date and 1 day after it,
   or whose schema version is unknown.
8. THE Ingest_Endpoint SHALL discard any Counter whose name is absent from the Counter_Catalog and
   any Counter value that is not an integer in the range 0 to 1000000, and SHALL store the remaining
   Counters.
9. THE Ingest_Endpoint SHALL truncate each Client_Environment string field to 64 characters before
   storage.
10. WHEN a Rollup arrives for an Install_Id and Metric_Day that already exist in the
    Telemetry_Store, THE Ingest_Endpoint SHALL replace the stored Counter values and
    Client_Environment for that Install_Id and Metric_Day.
11. WHEN more than 20 requests carrying the same Install_Id are received within one hour, THE
    Ingest_Endpoint SHALL answer HTTP 429 and write nothing to the Telemetry_Store.
12. IF the `DB` binding is absent, THEN THE Ingest_Endpoint SHALL answer HTTP 200 and write nothing,
    so that a BYO Worker deployment accepts and drops telemetry rather than reporting an error.
13. THE Ingest_Endpoint SHALL include no request body content, exception message, or binding detail
    in any response.

### Requirement 7: Geo derivation and address non-retention

**User Story:** As the app owner, I want to see which regions the app is used in without holding
network addresses, so that the data set carries no personal identifiers.

#### Acceptance Criteria

1. WHEN the Ingest_Endpoint handles a request, THE Geo_Resolver SHALL derive Coarse_Geo from the
   Cloudflare request properties available on that request.
2. IF Cloudflare request properties provide no country code, THEN THE Geo_Resolver SHALL return
   `countryCode` of `XX` and `region` of `unknown`.
3. THE Geo_Resolver SHALL map each derived country code to exactly one continent-level `region`
   value.
4. THE Ingest_Endpoint SHALL store only `countryCode` and `region` from the request metadata.
5. THE Ingest_Endpoint SHALL exclude the client network address, the `CF-Connecting-IP` header value,
   the `X-Forwarded-For` header value, the city, the postal code, the latitude, the longitude, and
   the autonomous system number from every write to the Telemetry_Store.
6. THE Rollup schema SHALL define no field carrying a network address, and THE Ingest_Endpoint SHALL
   discard any unrecognized field present in a request body.
7. THE Ingest_Endpoint SHALL emit no log line containing the client network address.

### Requirement 8: Telemetry store and retention

**User Story:** As the app owner, I want rollups stored in a shape I can query cheaply and expired
automatically, so that the data set stays small and bounded.

#### Acceptance Criteria

1. THE Telemetry_Store SHALL hold one row per Install_Id and Metric_Day, with a primary key over
   `(install_id, metric_day)`.
2. THE Telemetry_Store row SHALL hold the Install_Id, the Metric_Day, the Coarse_Geo fields, the
   Client_Environment fields, the Counter map as JSON, the schema version, and the first-seen and
   last-seen timestamps for that row.
3. THE Telemetry_Store SHALL carry an index on `metric_day` and an index on `(metric_day, country_code)`.
4. THE Worker SHALL create the Telemetry_Store tables and indexes idempotently, so that repeated
   application of the migration leaves the schema unchanged.
5. WHEN the scheduled retention pass runs, THE Worker SHALL delete every Telemetry_Store row whose
   Metric_Day is older than the Retention_Window.
6. THE Worker SHALL run the retention pass at least once per 24 hours.
7. IF the retention pass fails, THEN THE Worker SHALL leave existing rows in place and answer
   subsequent Ingest_Endpoint requests normally.

### Requirement 9: Admin API

**User Story:** As the owner of the app, I want an authenticated API that returns aggregated
telemetry, so that only I can read it and the dashboard never queries raw rows.

#### Acceptance Criteria

1. THE Admin_API SHALL expose routes under `/api/admin/telemetry/` on the existing `cloud/` Worker,
   inside the existing `/api/*` control-plane branch.
2. WHEN an Admin_API request carries a bearer token that `verifyRequest` resolves to a Clerk user id
   present in the Owner_Allowlist, THE Admin_API SHALL answer with the requested aggregate.
3. IF an Admin_API request carries no bearer token or a token that `verifyRequest` rejects, THEN THE
   Admin_API SHALL answer HTTP 401 with a static reason string.
4. IF `verifyRequest` resolves an Admin_API request to a Clerk user id that is absent from the
   Owner_Allowlist, or to a null user id, THEN THE Admin_API SHALL answer HTTP 403 with a static
   reason string.
5. IF the `TELEMETRY_ADMIN_USER_IDS` secret is absent or empty, THEN THE Admin_API SHALL answer
   HTTP 403 for every request.
6. THE Admin_API SHALL read the Owner_Allowlist from the `TELEMETRY_ADMIN_USER_IDS` Worker secret and
   SHALL expose no route that returns the Owner_Allowlist contents.
7. THE Admin_API SHALL expose a summary route returning active install counts for the trailing 1, 7,
   and 30 days, total runs, total sessions, and total error events over a requested date range.
8. THE Admin_API SHALL expose a geography route returning install counts and run counts grouped by
   `country_code` and by `region` over a requested date range.
9. THE Admin_API SHALL expose an environment route returning install counts grouped by `app_version`,
   by `platform`, by `runtime_mode`, and by `locale` over a requested date range.
10. THE Admin_API SHALL expose a feature route returning summed Counter values grouped by Counter
    name over a requested date range.
11. THE Admin_API SHALL expose a trend route returning per Metric_Day active install counts, session
    counts, and run counts over a requested date range.
12. THE Admin_API SHALL accept a date range through `from` and `to` query parameters in `YYYY-MM-DD`
    format, SHALL default the range to the trailing 30 days when a parameter is absent, and SHALL
    answer HTTP 400 when a supplied parameter is not a valid date or when `from` is later than `to`.
13. THE Admin_API SHALL cap a requested date range at 400 days and SHALL answer HTTP 400 for a longer
    range.
14. THE Admin_API SHALL return aggregate rows only, and SHALL exclude the Install_Id from every
    response body.
15. WHEN an aggregate group contains fewer than 5 distinct Install_Id values, THE Admin_API SHALL
    report that group under an `other` label rather than as its own row.
16. THE Admin_API SHALL answer with `Cache-Control: no-store`.
17. THE Admin_API SHALL add the Admin_Dashboard origin to `ALLOWED_ORIGINS` so that browser requests
    from the deployed dashboard pass the existing CORS check.

### Requirement 10: Admin dashboard

**User Story:** As the owner of the app, I want a birds-eye dashboard I can log into, so that I can
see where and how the app is being used without running queries.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL be an Angular application in a new top-level package, deployed
   independently of the Studio and of the `cloud/` Worker.
2. THE Admin_Dashboard SHALL authenticate the visitor through Clerk and SHALL attach the Clerk
   session token as a bearer token on every Admin_API request.
3. WHILE no Clerk session exists, THE Admin_Dashboard SHALL render the sign-in surface and SHALL
   issue no Admin_API request.
4. IF the Admin_API answers HTTP 403, THEN THE Admin_Dashboard SHALL render a not-authorized state
   naming no allowlist detail and offering a sign-out control.
5. THE Admin_Dashboard SHALL render an overview view showing active installs for the trailing 1, 7,
   and 30 days, total runs, total sessions, and total error events for the selected date range.
6. THE Admin_Dashboard SHALL render a geography view showing installs and runs grouped by country and
   by region for the selected date range.
7. THE Admin_Dashboard SHALL render an environment view showing installs grouped by app version,
   platform, runtime mode, and locale for the selected date range.
8. THE Admin_Dashboard SHALL render a feature-usage view showing summed Counter values grouped by
   Counter name for the selected date range.
9. THE Admin_Dashboard SHALL render a trend view showing per-day active installs, sessions, and runs
   for the selected date range.
10. WHEN the visitor changes the date range control, THE Admin_Dashboard SHALL refetch every view
    bound to that range.
11. WHILE an Admin_API request is in flight, THE Admin_Dashboard SHALL render a loading state for the
    affected view.
12. IF an Admin_API request fails, THEN THE Admin_Dashboard SHALL render an error state for the
    affected view with a retry control.
13. WHEN an Admin_API response contains no rows for the selected range, THE Admin_Dashboard SHALL
    render an empty state for that view.
14. THE Admin_Dashboard SHALL render icons from the Tabler icon webfont only, SHALL set an explicit
    `size="small"` on every PrimeNG control, and SHALL use no `p-dialog` component.
15. THE Admin_Dashboard SHALL read the Admin_API base URL and the Clerk publishable key from build
    configuration and SHALL contain no Clerk secret key and no Worker secret.

### Requirement 11: Privacy and data minimization

**User Story:** As a Studio user, I want a hard guarantee that my content never leaves my machine
through telemetry, so that I can leave collection enabled.

#### Acceptance Criteria

1. THE Rollup SHALL exclude prompt text, workflow names, workflow ids, node names, node
   configuration, run inputs, run outputs, model responses, connection names, credential values, file
   paths, and account identifiers.
2. THE Telemetry_Service SHALL construct every Rollup field from the Counter_Catalog and the
   Client_Environment set only.
3. THE Telemetry_Service SHALL derive the error-category Counter from a closed set of category names
   and SHALL exclude the error message and the stack trace from the Rollup.
4. THE Studio SHALL keep every telemetry secret out of the webview, holding the Owner_Allowlist and
   any ingest configuration secret in Worker secrets.
5. THE Telemetry_Service SHALL send Rollups over HTTPS only.
6. THE Studio SHALL expose the current pending Rollup contents in Privacy_Settings_Section, so that
   the user can read exactly what would be uploaded.
7. THE Telemetry_Store SHALL hold no column that carries user content, a network address, or an
   account identifier.

### Requirement 12: Build, test, and release integration

**User Story:** As a maintainer, I want the new package and suites wired into the existing gates, so
that the repo keeps one verification story.

#### Acceptance Criteria

1. THE Admin_Dashboard package SHALL declare the same version number as `frontend`, `backend`,
   `cloud`, `cloud-aws`, and `engine`.
2. THE `cloud-aws/scripts/check-versions.mjs` script SHALL include the Admin_Dashboard package in the
   set of packages whose versions it compares.
3. THE `.github/workflows/ci.yml` workflow SHALL run the Admin_Dashboard production build and unit
   test suite on push and on pull request.
4. THE `.github/workflows/ci.yml` workflow SHALL run the new `cloud/` telemetry test suite and the
   new `frontend/` telemetry test suite on push and on pull request.
5. THE `cloud/` telemetry test suite SHALL assert that an Ingest_Endpoint response body contains no
   request body content and no exception message.
6. THE `cloud/` telemetry test suite SHALL assert that a Telemetry_Store write for a request carrying
   a `CF-Connecting-IP` header stores no value from that header.
7. THE `cloud/src/status.ts` component list SHALL report the Telemetry_Store as `unknown` while the
   `DB` binding is absent, so that a BYO Worker deployment does not read as degraded.
