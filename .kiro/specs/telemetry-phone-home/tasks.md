# Implementation Plan: Telemetry Phone Home

## Overview

Build from the pure core outward. The Counter_Catalog twins, the state algebra in
`telemetry-core.ts`, the storage adapter, the geo map, the date-range parser and the k-anonymity
fold are plain functions over plain data, so they land first and carry the property tests. The
Angular `TelemetryService` is a thin shell over that core and injects `TauriService` only, so it
lands next and stays a DI leaf. Counter call sites, then the Privacy UI, then the Worker ingest
route and D1 store, then the admin API, then the new `admin/` Angular package, then the static
guards and CI wiring.

Language: TypeScript, plus one small Rust command for the native `osVersion` lookup.

Property tests run a minimum of 100 iterations and carry the tag
`// Feature: telemetry-phone-home, Property N: <property text>` exactly as the design specifies.

## Tasks

- [x] 1. Counter catalog twins and property-test tooling
  - [x] 1.1 Add `fast-check` 4 as a devDependency
    - Add to `frontend/package.json` and `cloud/package.json`, pinned to the same version `engine/` and `cloud-aws/` already use
    - Install in `frontend` with `npm install --legacy-peer-deps`
    - _Requirements: 12.4_

  - [x] 1.2 Create `frontend/src/app/core/telemetry-catalog.ts`
    - Declare `TELEMETRY_SCHEMA_VERSION`, `CURRENT_DISCLOSURE_VERSION`, `ERROR_CATEGORIES`
    - Declare the dimension lists with `satisfies readonly WorkflowNodeKind[]` and the equivalents for `DEFAULT_TABS` panel ids, `AssistantMode` and `DeployTargetId`, so a new kind without its counter is a compile error
    - Expand the family and dimension lists once at module load into `COUNTER_CATALOG: ReadonlySet<string>` (56 names), and export `counterName(family, dimension?)` as the only name builder
    - Verify with `cd frontend; npm run build`
    - _Requirements: 3.1, 11.3_

  - [x] 1.3 Create the Worker twin `cloud/src/telemetry-catalog.ts`
    - Independent declaration of the same catalog, schema version and error categories, with no import across the package boundary
    - Verify with `cd cloud; npm run check`
    - _Requirements: 3.1, 6.8_

  - [x]* 1.4 Write property test for the Counter_Catalog
    - **Property 5: The Counter_Catalog is closed and complete**
    - In `frontend/src/app/core/telemetry-catalog.spec.ts`: the catalog equals the expansion of its families over their dimension lists, has an entry for every `WorkflowNodeKind`, every default panel id, every assistant mode and every deploy target id, and nothing outside that expansion
    - **Validates: Requirements 3.1**

  - [x]* 1.5 Write property test for catalog twin identity
    - **Property 5: The Counter_Catalog is closed and complete**
    - New suite `cloud/test/telemetry.test.mjs`: the Worker catalog name set and schema version are identical to the frontend catalog module's
    - **Validates: Requirements 3.1**

- [x] 2. Telemetry core state algebra
  - [x] 2.1 Create `frontend/src/app/core/telemetry-core.ts`
    - Wire models: `Rollup`, `ClientEnvironment`, `ROLLUP_KEYS`, `ENV_KEYS`
    - Local persisted models: `ConsentState`, `Accumulator`, `QueueEntry`, `UploadState`
    - Pure functions: `metricDayUtc`, `readConsent`, `acknowledgeDisclosure`, `applyIncrement`, `sealRollup`, `appendToQueue`, `classifyIngestStatus`, `backoffMs`, `resolveIngestUrl`, `resetDerivedState` (`shouldShowNotice` was here too and was removed on 2026-09-07 with the first-run notice)
    - Constants: `UPLOAD_INTERVAL_MS` 15 minutes, `MAX_BACKOFF_MS` 24 hours, `QUEUE_CAP` 30
    - `appendToQueue` dedupes on `(installId, metricDay)` first, then caps by dropping the oldest by `sealedAt`
    - No Angular, no DOM beyond types
    - Verify with `cd frontend; npm run build`
    - _Requirements: 3.2, 3.3, 3.4, 4.1, 4.5, 4.6, 4.7, 4.8, 5.2, 5.3, 5.4, 5.5, 11.2, 11.5_

  - [x]* 2.2 Write property test for the disclosure gate
    - **Property 1: Consent bootstrap decision** (was "Disclosure gate decision" until 2026-09-07)
    - In `frontend/src/app/core/telemetry-core.spec.ts`, over `readConsent` and `acknowledgeDisclosure`; the `shouldShowNotice` assertions went with the notice
    - **Validates: Requirements 1.1, 1.8**

  - [x]* 2.3 Write property test for consent and reset transitions
    - **Property 2: Consent and reset transitions clear derived state**
    - Over `resetDerivedState` for the disable, re-enable and install-id reset paths
    - **Validates: Requirements 1.5, 1.7, 2.4**

  - [x]* 2.4 Write property test for counter accumulation
    - **Property 6: Counter accumulation is exact and monotone**
    - Over `applyIncrement` with names inside and outside the catalog and amounts that are and are not positive integers
    - **Validates: Requirements 3.2, 3.3, 3.4**

  - [x]* 2.5 Write property test for the Rollup field set
    - **Property 8: The Rollup field set is closed (client side)**
    - Over `sealRollup`, asserting key-set equality against `ROLLUP_KEYS` and `ENV_KEYS` and catalog membership of every counter key
    - **Validates: Requirements 4.5, 11.2**

  - [x]* 2.6 Write property test for the Metric_Day roll
    - **Property 9: A Metric_Day change seals the old day and zeroes the new one**
    - Also asserts an accepted upload removes exactly the uploaded entry and leaves the rest of the queue unchanged
    - **Validates: Requirements 4.1, 4.4**

  - [x]* 2.7 Write property test for cumulative supersede
    - **Property 10: Rollups are cumulative-to-date, so the latest supersedes every earlier one**
    - Interleave increments and interim seals within one Metric_Day
    - **Validates: Requirements 4.6, 4.7**

  - [x]* 2.8 Write property test for upload queue invariants
    - **Property 11: Upload queue invariants**
    - Over `appendToQueue`: cap of 30, no duplicate `(installId, metricDay)` pair, newest seal survives, eviction takes the oldest
    - **Validates: Requirements 4.8, 5.5**

  - [x]* 2.9 Write property test for ingest status classification
    - **Property 12: Ingest status classification partitions the status space**
    - Over `classifyIngestStatus` across the whole status space, plus the queue and rejection-count effect of each outcome
    - **Validates: Requirements 5.2, 5.3**

  - [x]* 2.10 Write property test for retry backoff
    - **Property 13: Retry backoff is bounded and monotone**
    - Over `backoffMs`, including zero, non-integer and non-finite input
    - **Validates: Requirements 5.4**

  - [x]* 2.11 Write property test for HTTPS-only ingest URLs
    - **Property 16: Rollups leave the machine over HTTPS only**
    - Over `resolveIngestUrl`, with `localhost` and `127.0.0.1` as the only `http:` exceptions
    - **Validates: Requirements 11.5**

- [x] 3. Telemetry storage adapter
  - [x] 3.1 Create `frontend/src/app/core/telemetry-storage.ts`
    - `loadTelemetry` / `saveTelemetry` / `removeTelemetry` over the `phorma.telemetry.` prefix, try/catch wrapped, returning defaults rather than throwing, following `core/layout-storage.ts`
    - Keys: `installId`, `consent`, `accumulator`, `queue`, `upload`
    - Verify with `cd frontend; npm run build`
    - _Requirements: 2.1, 3.6_

  - [x]* 3.2 Write property test for accumulator round trip
    - **Property 7: Accumulated counters round-trip through storage**
    - In `frontend/src/app/core/telemetry-storage.spec.ts` against a fake storage adapter, no real `localStorage`
    - **Validates: Requirements 3.6**

- [x] 4. Checkpoint - pure core is green
  - Ensure all tests pass, ask the user if questions arise.
  - `cd frontend; npm run build`, then `npx ng test --watch=false --browsers=ChromeHeadless` in `frontend`, then `cd cloud; npm run check`

- [x] 5. TelemetryService, native osVersion, and bootstrap
  - [x] 5.1 Add `osVersion()` to `TauriService` and its Rust command
    - New `os_version` command in `backend/src-tauri/src/`, registered in the invoke handler
    - `TauriService.osVersion()` caches the resolved value, is guarded by `isDesktop`, and falls back to the user agent platform string and then to `'unknown'`
    - Verify with `cd backend/src-tauri; cargo check` and `cd frontend; npm run build`
    - _Requirements: 3.8_

  - [x] 5.2 Create `frontend/src/app/core/telemetry.service.ts`
    - Injects `TauriService` only; reads the base URL through `loadPhormaCloudUrl()` from `core/phorma-cloud-url.ts`
    - Signals `active`, `enabled`, `installId`, `pendingRollup`, `queueLength` (`noticePending` existed here and was removed on 2026-09-07 with the first-run notice)
    - `bootstrap()` returns synchronously and schedules the real work on `requestIdleCallback` with a `setTimeout(..., 0)` fallback, wrapped so any throw leaves `active()` false
    - Initialization order: read consent before writing, persist the current disclosure version preserving any existing consent value, read or mint `installId` via `crypto.randomUUID()`, resolve `ClientEnvironment`, load and repair `accumulator` / `queue` / `upload`, roll the day, `count('session.started')`, start the 60 second tick
    - Tick: roll the day, interim seal when 6 hours have elapsed and a counter is above zero, upload the head of queue when `now >= upload.nextAttemptAt`
    - Upload: single JSON `POST`, `AbortSignal.timeout(10_000)`, outcome routed through `classifyIngestStatus`, `nextAttemptAt = now + backoffMs(failureCount)` after every attempt
    - `count(name, amount = 1)` and `recordError(category)` are the only increment APIs, both total and silent; `setEnabled` and `resetInstallId` both converge on `resetDerivedState`
    - Injects no toast service, no console service, no storage service, no settings service, and nothing on the usage or transport path
    - Verify with `cd frontend; npm run build`
    - _Requirements: 1.1, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.9, 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8, 11.5_

  - [x]* 5.3 Write property test for disabled consent
    - **Property 3: Disabled consent silences the service completely**
    - In `frontend/src/app/core/telemetry.service.spec.ts` with a fake clock, fake storage adapter and recording `fetch`
    - **Validates: Requirements 1.6, 3.7**

  - [x]* 5.4 Write property test for install identity
    - **Property 4: Install identity is a stable UUID v4 that travels only to the ingest endpoint**
    - **Validates: Requirements 2.1, 2.2, 2.5**

  - [x]* 5.5 Write property test for silence and startup safety
    - **Property 14: Telemetry never addresses the user and never breaks startup**
    - Inject a failure at each initialization step, spy on the toast and console services, assert `active()` is false and bootstrap does not reject
    - **Validates: Requirements 5.1, 5.7, 5.8**

  - [x]* 5.6 Write property test for content exclusion
    - **Property 15: A Rollup carries no workflow content**
    - Marker strings in prompt text, workflow and node names, node configuration, connection names and file paths, plus arbitrary error messages and stacks, must not appear in the serialized Rollup; the Privacy preview parses back to the exact object the uploader would send
    - **Validates: Requirements 11.1, 11.3, 11.6**

  - [x] 5.7 Wire `bootstrap()` into the app shell
    - Call `TelemetryService.bootstrap()` once from the shell after first render setup, on a path that cannot block first paint
    - Verify with `cd frontend; npm run build`
    - _Requirements: 4.9, 5.7_

  - [x]* 5.8 Write unit tests for the service scheduling and environment branches
    - The 10 second abort treated as a network failure, the non-blocking bootstrap return, and the desktop versus browser `osVersion` branch
    - _Requirements: 3.8, 4.9, 5.6_

- [x] 6. Counter call sites
  - [x] 6.1 Count runs and engine errors in `RunControllerService`
    - `run.started` / `run.completed` / `run.error` on the `run-started` / `run-completed` / `run-failed` RunEvents in `apply()`, plus `recordError('engine')` on `run-failed`
    - _Requirements: 3.1, 3.2_

  - [x] 6.2 Count node instantiation in `WorkflowService`
    - `node.created:{kind}` on the add-node path, after the node is instantiated from its catalog entry
    - _Requirements: 3.1, 3.2_

  - [x] 6.3 Count panel opens in `PanelRegistryService`
    - `panel.opened:{id}` where a tab becomes active on a side
    - _Requirements: 3.1, 3.2_

  - [x] 6.4 Count assistant invocations
    - `assistant.invoked:{mode}` in `AssistantChatService.send()` and at the Ctrl+P builder entry point, both of which already receive the mode
    - _Requirements: 3.1, 3.2_

  - [x] 6.5 Count deploy starts
    - `deploy.started:phorma` and `deploy.started:cloudflare` in `CloudService`, `deploy.started:aws` in `AwsDeployConfigService`
    - _Requirements: 3.1, 3.2_

  - [x] 6.6 Wire the remaining error categories
    - `recordError` calls for `model-call` in `ModelTransportService`, `tool-call` in the tool host bridge, `mcp` in the MCP connect path, `network` in `FetchModelClient` and the data fetcher, `storage` in `StorageService`, `deploy` in the deploy services, `auth` in `PhormaCloudService` on a 401, `validation` in the spec and connector validation surfaces, and `unknown` for an unclassified throw
    - Category only, no message and no stack at any call site
    - Verify with `cd frontend; npm run build`
    - _Requirements: 3.1, 3.2, 11.3_

  - [x]* 6.7 Write unit tests for the call sites
    - One spec per seam asserting exactly one `count` or `recordError` call with the expected catalog name
    - _Requirements: 3.1, 3.2_

- [x] 7. Checkpoint - service and call sites are green
  - Ensure all tests pass, ask the user if questions arise.
  - `cd frontend; npm run build`, then `npx ng test --watch=false --browsers=ChromeHeadless` in `frontend`

- [x] 8. Settings Privacy section and First_Run_Notice
  - [x] 8.1 Register the Privacy page in the settings surface
    - New `privacy` page in `SettingsRegistryService.pages` placed after `Updates`, icon `ti ti-shield-lock`, one `telemetry` section with `customTemplate: 'privacy'` and the search keywords from the design
    - Add `'privacy'` to `SettingsCustomTemplate` and map it in the settings dialog template
    - _Requirements: 1.4_

  - [x] 8.2 Build the `PrivacySettings` component
    - Standalone, OnPush, in `frontend/src/app/workspace/settings/privacy/`
    - One `p-toggleswitch` bound to `telemetry.enabled()`, the Install_Id as a monospace read-only value with copy and `ti ti-refresh` reset going through `ConfirmDialogService`, a plain-language collected-data list derived from the catalog families and `ENV_KEYS`, a `<pre>` preview of `pendingRollup()` with the queue length and local rejection count, and the privacy policy link through the existing external-link helper
    - Tabler icons only, explicit `size="small"` on every control, `.phorma-btn-content` on solid buttons, no `p-dialog`, rem values against a 14px root
    - Verify with `cd frontend; npm run build`
    - _Requirements: 1.4, 1.5, 1.7, 2.4, 11.6_

  - [x] 8.3 Build the First_Run_Notice card
    - **REMOVED on 2026-09-07.** The card was built as described, shipped, and then deleted along with `noticePending` / `dismissNotice`. There is no in-app first-run disclosure any more: the disclosure is an accept-privacy step on the download website, before the installer is downloaded, and telemetry stays enabled by default. Do not rebuild this - see the decision record in `requirements.md`.
    - What survived: `CURRENT_DISCLOSURE_VERSION` is still persisted with consent, as the record of which policy version an install acknowledged. Settings > Privacy (8.1, 8.2) is now the only in-app disclosure.
    - _Requirements: 1.2, 1.3, 1.8 (all three rewritten by the removal)_

  - [x]* 8.4 Write rendering examples for the Privacy surfaces
    - `privacy-settings.spec.ts`: the toggle, install id, collected-data list and pending preview are present, and the collected-data copy is derived from the catalog rather than hard coded
    - The notice examples lived in `telemetry-notice.spec.ts` and were deleted with the component on 2026-09-07 (6 specs)
    - _Requirements: 1.4_

- [x] 9. Worker geo resolver and ingest validation
  - [x] 9.1 Create `cloud/src/telemetry-geo.ts`
    - `TelemetryRegion` union, `CoarseGeo`, `TELEMETRY_REGIONS`, and the hand-written `COUNTRY_REGION` map covering the ISO 3166-1 alpha-2 set with exactly one region per code
    - `resolveCoarseGeo(request)` reads only `cf.country`, treats `XX` and Cloudflare's `T1` as unknown, and degrades an unmapped code to `region: 'unknown'` while keeping the country
    - Verify with `cd cloud; npm run check`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x]* 9.2 Write property test for geo resolution
    - **Property 24: Geo resolution is total**
    - In `cloud/test/telemetry.test.mjs`, over absent, empty, non-string and unrecognized country properties
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x] 9.3 Create `cloud/src/telemetry.ts` validation core
    - `normalizeRollup(body, nowMs): Rollup | null`, pure, building a fresh object from `ROLLUP_KEYS` so unrecognized fields are discarded by construction
    - `installId` must match the UUID v4 pattern, `metricDay` must be a real `YYYY-MM-DD` date inside `[today - 30 days, today + 1 day]`, `schemaVersion` must be a member of `KNOWN_SCHEMA_VERSIONS`; each of the six env fields is coerced, trimmed and truncated to 64 code units with `runtimeMode` outside `{desktop, browser}` becoming `browser`; counters outside `COUNTER_CATALOG` or outside the integer range 0 to 1000000 are dropped without rejecting the request
    - Export `TELEMETRY_SCHEMA_STATEMENTS` and `ensureTelemetrySchema(db)` guarded by a module-level promise so the schema is created once per isolate
    - Verify with `cd cloud; npm run check`
    - _Requirements: 6.7, 6.8, 6.9, 7.6, 8.4_

  - [x]* 9.4 Write property test for ingest rejection
    - **Property 18: Ingest rejection is exact**
    - In `cloud/test/telemetry.test.mjs`: 413 exactly above 16 kilobytes, 400 exactly for unparseable JSON, a non-UUID v4 Install_Id, an out-of-window or non-calendar Metric_Day, or an unknown schema version, with nothing written in any rejecting case
    - **Validates: Requirements 6.5, 6.6, 6.7**

  - [x]* 9.5 Write property test for ingest sanitization
    - **Property 19: Ingest sanitization is exact**
    - Key-set equality after normalization, every env string at most 64 characters and a prefix of the submitted value, and the exact surviving counter set
    - **Validates: Requirements 6.8, 6.9, 7.6**

- [x] 10. Worker ingest route, D1 store, retention and status
  - [x] 10.1 Implement `handleTelemetryRequest` in `cloud/src/telemetry.ts`
    - Returns `null` for any path other than `/telemetry`; answers its own `OPTIONS` with the fixed `TELEMETRY_CORS` set and 405 for other methods
    - Pipeline: absent `DB` answers `200 {}` with no read and no write, a capped body reader rejects above 16384 bytes with `413 {"error":"Payload too large."}`, a parse or validation failure answers `400 {"error":"Invalid telemetry payload."}`, more than 20 accepted requests for one Install_Id inside the rolling hour answers `429 {"error":"Too many requests."}`, then `resolveCoarseGeo`, then one `env.DB.batch([...])` carrying the rollup upsert and the rate-window upsert, then `200 {}`
    - The upsert omits `first_seen_at` from the `DO UPDATE SET` list and replaces counters and environment wholesale
    - Any throw is caught locally and answered `200 {}`; no response body, and no log line, carries request content, an exception message or a binding name
    - Verify with `cd cloud; npm run check`
    - _Requirements: 6.2, 6.4, 6.5, 6.6, 6.10, 6.11, 6.12, 6.13, 7.4, 7.5, 7.7, 8.1_

  - [x] 10.2 Insert the route in `cloud/src/index.ts`
    - Immediately after `handleStatusRequest` and immediately before the `request.method === 'OPTIONS'` branch, with the comment explaining both ordering reasons
    - Add the `TelemetryEnv` type to the Worker env declaration
    - Verify with `cd cloud; npm run check`
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 10.3 Add the D1 migration `cloud/migrations/0002_telemetry.sql`
    - `telemetry_rollups` with the primary key over `(install_id, metric_day)` and the full column list from the design, `idx_telemetry_metric_day`, `idx_telemetry_day_country`, and `telemetry_ingest_rate`
    - Every statement `IF NOT EXISTS`, and the SQL identical to `TELEMETRY_SCHEMA_STATEMENTS`
    - No column for a city, postal code, latitude, longitude, autonomous system number, address or account identifier
    - Verify with `cd cloud; npm run check`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 11.7_

  - [x]* 10.4 Write property test for the telemetry preflight
    - **Property 17: The telemetry preflight is independent of ALLOWED_ORIGINS**
    - New suite `cloud/test/telemetry-ingest.test.mjs` on miniflare with a `d1Databases` binding, plus examples for route order (6.1) and no `Authorization` header (6.2)
    - **Validates: Requirements 6.3**

  - [x]* 10.5 Write property test for a valid ingest
    - **Property 20: A valid Rollup writes exactly one row and answers an empty object**
    - Plus the absent `DB` binding example answering `200 {}` with no write (6.12)
    - **Validates: Requirements 6.4**

  - [x]* 10.6 Write property test for replace semantics
    - **Property 21: A repeat Install_Id and Metric_Day replaces rather than accumulates**
    - One row survives, counters and environment equal the later Rollup, `first_seen_at` equals the earlier ingest time
    - **Validates: Requirements 6.10, 8.1**

  - [x]* 10.7 Write property test for per-install rate limiting
    - **Property 22: Per-install ingest rate limiting**
    - **Validates: Requirements 6.11**

  - [x]* 10.8 Write property test for ingest non-leakage
    - **Property 23: The ingest path leaks nothing**
    - Marker strings in the body, in `CF-Connecting-IP`, in `X-Forwarded-For`, and in the city, postal code, latitude, longitude and autonomous system number request properties must not appear in any response body, any bound write value, or any emitted log line
    - **Validates: Requirements 6.13, 7.4, 7.5, 7.7, 12.5, 12.6**

  - [x]* 10.9 Write property test for schema idempotency
    - **Property 25: Schema creation is idempotent**
    - Repeated application of `TELEMETRY_SCHEMA_STATEMENTS` leaves the schema snapshot unchanged and never throws
    - **Validates: Requirements 8.4**

  - [x] 10.10 Add the retention pass and its cron
    - Export `runTelemetryRetention(env)` from `cloud/src/telemetry.ts`: return immediately when `DB` is absent, then delete `telemetry_rollups` rows with `metric_day` older than 400 days and `telemetry_ingest_rate` rows with `window_start_ms` older than 24 hours
    - Add a `scheduled()` handler in `cloud/src/index.ts` that wraps the call in `ctx.waitUntil(...)` with a trailing `.catch(() => undefined)`
    - Add `"triggers": { "crons": ["17 3 * * *"] }` under `env.hosted` only in `cloud/wrangler.jsonc`
    - Verify with `cd cloud; npm run check`
    - _Requirements: 8.5, 8.6, 8.7_

  - [x]* 10.11 Write property test for retention
    - **Property 26: Retention deletes exactly the expired rows**
    - Rows spanning both sides of the 400 day window, plus a failure injected at each delete step leaving every row in place and a following ingest still answering HTTP 200 and writing its row
    - **Validates: Requirements 8.5, 8.7**

  - [x] 10.12 Add the ninth status component
    - `describe('telemetry', 'Usage telemetry', 'Anonymous product usage counters.', false, null, telemetry)` in `cloud/src/status.ts`, probing `absent('This deployment does not collect telemetry.')` without `DB` and `SELECT 1 FROM telemetry_rollups LIMIT 1` after `ensureTelemetrySchema` with it
    - Update the component list assertion in `cloud/test/status.test.mjs`
    - Verify with `cd cloud; npm run test:unit` and `cd cloud; npm run check`
    - _Requirements: 12.7_

- [x] 11. Checkpoint - ingest and store are green
  - Ensure all tests pass, ask the user if questions arise.
  - `cd cloud; npm run test:unit`, then `cd cloud; npm run check`

- [x] 12. Admin API
  - [x] 12.1 Create `cloud/src/telemetry-admin.ts` with the authorization gate
    - `handleTelemetryAdminRequest(request, env, url, respond)` returning `null` for a non-matching path, and `isTelemetryAdmin(allowlist, userId)` doing exact membership after trimming, never a substring or prefix test
    - 401 `{"error":"Unauthorized."}` for an absent bearer token or a rejected `verifyRequest`, 403 `{"error":"Forbidden."}` for a resolved but unlisted or null user id and for an absent, empty or whitespace-only `TELEMETRY_ADMIN_USER_IDS`
    - Every response, including 400, 401 and 403, carries `Cache-Control: no-store`; no route returns the allowlist
    - Verify with `cd cloud; npm run check`
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 9.16_

  - [x]* 12.2 Write property test for admin authorization
    - **Property 27: Admin authorization decides on exactly four outcomes**
    - In `cloud/test/telemetry.test.mjs`, over absent, empty, whitespace-only and padded allowlist entries and every verification outcome, including the substring case
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5**

  - [x] 12.3 Implement `parseDateRange`
    - `parseDateRange(params, today): RangeResult`, defaulting to the trailing 30 days inclusive when either parameter is absent, requiring real `YYYY-MM-DD` calendar dates, rejecting `from > to` and an inclusive length above 400 days, and answering `400 {"error":"Invalid date range."}` on every failure
    - Verify with `cd cloud; npm run check`
    - _Requirements: 9.12, 9.13_

  - [x]* 12.4 Write property test for date range parsing
    - **Property 28: Date range parsing and capping are exact**
    - **Validates: Requirements 9.12, 9.13**

  - [x] 12.5 Implement `applyKAnonymity`
    - `K_ANONYMITY_FLOOR = 5`, folding every group whose `installs` count is below the floor into a single `other` row that sums each numeric metric, and omitting the `other` row entirely when nothing folds
    - Verify with `cd cloud; npm run check`
    - _Requirements: 9.15_

  - [x]* 12.6 Write property test for the k-anonymity floor
    - **Property 30: The k-anonymity floor holds and conserves metrics**
    - **Validates: Requirements 9.15**

  - [x] 12.7 Implement the five aggregate routes
    - `summary`, `geography`, `environment`, `features` and `trend`, all `GET`, all accepting `from` and `to`, all returning the response shapes declared in the design and no Install_Id
    - The aggregation SQL from the design, keyed on the `metric_day` index; grouped routes run their rows through `applyKAnonymity`; `features` filters `label` against `COUNTER_CATALOG` before serializing; `trend` reports `foldedDays`
    - `summary` returns global totals with no group labels, so the floor does not apply to it
    - D1 failures answer 500 with a static reason
    - Verify with `cd cloud; npm run check`
    - _Requirements: 9.7, 9.8, 9.9, 9.10, 9.11, 9.14, 9.15_

  - [x]* 12.8 Write property test for aggregate conservation
    - **Property 29: Aggregates conserve the underlying rows**
    - New suite `cloud/test/telemetry-admin.test.mjs` on miniflare, model based against an independently written in-memory reduce over the same generated rows, plus route-resolution examples (9.1)
    - **Validates: Requirements 9.7, 9.8, 9.9, 9.10, 9.11**

  - [x]* 12.9 Write property test for identity exposure
    - **Property 31: Admin responses expose no identity**
    - Marker Install_Ids and a populated allowlist must not appear in any response body, on any route, for any authorization outcome
    - **Validates: Requirements 9.6, 9.14**

  - [x]* 12.10 Write property test for cache headers
    - **Property 32: Every admin response is uncacheable**
    - **Validates: Requirements 9.16**

  - [x] 12.11 Wire the admin branch into the control plane
    - `if (url.pathname.startsWith('/api/admin/telemetry/')) return handleTelemetryAdminRequest(request, env, url, respond);` in `routeApiRequest` in `cloud/src/api.ts`, immediately after the `/api/connection-secrets` branch and before the `TenantStore` availability gate
    - Add `TELEMETRY_ADMIN_USER_IDS` to the Worker env type, and add the dashboard origin to `ALLOWED_ORIGINS` under `env.hosted` in `cloud/wrangler.jsonc`
    - Document `npx wrangler secret put TELEMETRY_ADMIN_USER_IDS --env hosted` alongside the existing secret instructions
    - Verify with `cd cloud; npm run check`
    - _Requirements: 9.1, 9.6, 9.17, 11.4_

- [x] 13. Admin dashboard package
  - [x] 13.1 Scaffold the `admin/` package
    - `admin/package.json` as `@phorma/admin` on the repo-wide version number, `angular.json` building to `dist/admin/browser`, `tsconfig.json`, `wrangler.jsonc` naming `phorma-admin` with the built assets directory, Tailwind v4 and postcss config, `src/main.ts`, `src/styles.scss` with the Tabler icon webfont, `src/environments/environment.ts` and `environment.prod.ts` carrying `apiBaseUrl` and `clerkPublishableKey`, and `src/app/app.config.ts` with the Aura preset, `ngx-clerk` and the router
    - No dependency on `frontend`, `engine`, `cloud` or `cloud-aws`, and no import across a package boundary
    - Verify with `npm run build` in `admin`
    - _Requirements: 10.1, 10.15, 12.1_

  - [x] 13.2 Add the dashboard core primitives
    - `core/models.ts` as a structural twin of the admin response interfaces, `core/view-state.ts` with `ViewState<T>` covering loading, loaded, empty and failed, and `core/date-range.service.ts` holding the single range signal
    - _Requirements: 10.10, 10.11, 10.12, 10.13_

  - [x]* 13.3 Write property test for view state
    - **Property 34: Each view is in exactly one state**
    - In `admin/src/app/core/view-state.spec.ts`
    - **Validates: Requirements 10.11, 10.12, 10.13**

  - [x] 13.4 Add Clerk auth and the API client
    - `core/telemetry-api.service.ts` with five typed calls, attaching `Authorization: Bearer <session token>` on every request and returning early when the token resolver yields null so no request is issued without a session
    - `auth/signed-out.ts` sign-in surface and `auth/not-authorized.ts` 403 state naming no allowlist detail and offering sign out
    - Verify with `npm run build` in `admin`
    - _Requirements: 10.2, 10.3, 10.4_

  - [x]* 13.5 Write property test for bearer attachment
    - **Property 33: The dashboard sends a bearer token, or sends nothing at all**
    - In `admin/src/app/core/telemetry-api.service.spec.ts`
    - **Validates: Requirements 10.2, 10.3**

  - [x] 13.6 Build the shell
    - `app.ts` / `app.html` / `app.scss`: header, view nav, the `from`/`to` date-range control with 7, 30 and 90 day presets, the signed-out switch and the 403 not-authorized switch
    - Verify with `npm run build` in `admin`
    - _Requirements: 10.3, 10.4, 10.10, 10.14_

  - [x]* 13.7 Write property test for range refetch
    - **Property 35: A range change refetches every bound view**
    - In `admin/src/app/app.spec.ts`, plus the 403 not-authorized example (10.4)
    - **Validates: Requirements 10.10**

  - [x] 13.8 Build the five views
    - `overview`, `geography`, `environment`, `features` and `trend`, each an Angular `resource()` keyed on the range signal, each rendering exactly one of loading, loaded, empty or failed with a retry control on failed
    - `trend` uses PrimeNG `UIChart` behind `@defer (on immediate)` with chart options as a `computed()`, excludes the `other` row from the plot and renders it as a folded-days footnote
    - Tabler icons only, explicit `size="small"` on every PrimeNG control, no `p-dialog`, no em dashes
    - Verify with `npm run build` in `admin`
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 10.12, 10.13, 10.14_

  - [x]* 13.9 Write view specs
    - One rendering example per view, plus a property that every group label in a generated response reaches the DOM
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9_

- [x] 14. Checkpoint - admin API and dashboard are green
  - Ensure all tests pass, ask the user if questions arise.
  - `cd cloud; npm run test:unit`, `cd cloud; npm run check`, `npm run build` in `admin`, and `npx ng test --watch=false --browsers=ChromeHeadless` in `admin`

- [x] 15. Static guards, CI and release wiring
  - [x] 15.1 Write `scripts/check-telemetry-catalog.mjs`
    - Assert the frontend and Worker catalog modules declare identical counter-name sets and the same schema version, and that `cloud/migrations/0002_telemetry.sql` and `TELEMETRY_SCHEMA_STATEMENTS` are the same SQL
    - _Requirements: 3.1, 8.4_

  - [x] 15.2 Write `scripts/check-telemetry-isolation.mjs`
    - Assert the import list of `frontend/src/app/core/telemetry.service.ts` stays within `{telemetry-catalog, telemetry-core, telemetry-storage, app-version, phorma-cloud-url, tauri.service, @angular/core}`
    - _Requirements: 3.5_

  - [x] 15.3 Write `scripts/check-telemetry-secrets.mjs`
    - Assert `TELEMETRY_ADMIN_USER_IDS` appears nowhere under `frontend/src` or `admin/src`, and that the built dashboard bundle contains no `sk_`-prefixed and no `CLERK_SECRET` string
    - _Requirements: 10.15, 11.4_

  - [x] 15.4 Write `scripts/check-admin-conventions.mjs`
    - Assert the dashboard templates use no `pi pi-` icon class, no `p-dialog`, and no PrimeNG control without an explicit size
    - _Requirements: 10.14_

  - [x] 15.5 Include the dashboard in the version gate
    - Add `admin/package.json` to the `packages` array in `cloud-aws/scripts/check-versions.mjs` and derive the log line from `packages.length`
    - Verify with `cd cloud-aws; npm run check`
    - _Requirements: 12.1, 12.2_

  - [x] 15.6 Add the CI steps to `.github/workflows/ci.yml`
    - In the existing `checks` job: `Install dependencies (admin)` running `npm install --legacy-peer-deps` in `admin`, `Admin dashboard unit tests` running `npx ng test --watch=false --browsers=ChromeHeadless` in `admin`, `Admin dashboard production build` running `npm run build` in `admin`, and the four guard scripts alongside the existing `check-deploy-bundle.mjs` step
    - _Requirements: 12.3, 12.4_

  - [x] 15.7 Add the dashboard to the release version bump
    - Include `admin/package.json` in the package set `scripts/release.mjs` bumps, so all six packages stay on one version number
    - _Requirements: 12.1_

  - [x] 15.8 Register the new cloud suites
    - Add `test/telemetry.test.mjs`, `test/telemetry-ingest.test.mjs` and `test/telemetry-admin.test.mjs` to the `test:unit` script in `cloud/package.json`
    - Verify with `cd cloud; npm run test:unit`
    - _Requirements: 12.4, 12.5, 12.6_

- [x] 16. Final checkpoint - full verification sweep
  - Ensure all tests pass, ask the user if questions arise.
  - `cd frontend; npm run build`, `npx ng test --watch=false --browsers=ChromeHeadless` in `frontend`, `cd cloud; npm run test:unit`, `cd cloud; npm run check`, `cd cloud-aws; npm run check`, `npm run build` in `admin`

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster first pass
- Property tests run a minimum of 100 iterations and carry the tag `// Feature: telemetry-phone-home, Property N: <property text>`
- `TelemetryService` must keep injecting `TauriService` only. Adding any other service risks the known `RunControllerService -> ModelTransportService -> PhormaCloudService -> CloudService -> RunControllerService` cycle and breaks the structural enforcement of Requirement 3.5
- `frontend/src/app/core/telemetry-catalog.ts` and `cloud/src/telemetry-catalog.ts` are structural twins. Change one and change the other in the same edit
- Route order in `cloud/src/index.ts` is load bearing: `/telemetry` must be matched after the status branch and before both the generic `OPTIONS` branch and `/api/*`
- No em dashes anywhere in code, comments, templates or docs

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "5.1", "9.1"] },
    { "id": 1, "tasks": ["1.4", "1.5", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "9.2", "9.3"] },
    { "id": 3, "tasks": ["2.3", "3.2", "9.4", "10.1"] },
    { "id": 4, "tasks": ["2.4", "5.2", "9.5", "10.2"] },
    { "id": 5, "tasks": ["2.5", "5.3", "10.3", "10.4"] },
    { "id": 6, "tasks": ["2.6", "5.4", "5.7", "10.5"] },
    { "id": 7, "tasks": ["2.7", "5.5", "6.1", "6.2", "6.3", "10.6"] },
    { "id": 8, "tasks": ["2.8", "5.6", "6.4", "6.5", "6.6", "10.7"] },
    { "id": 9, "tasks": ["2.9", "5.8", "6.7", "8.1", "10.8"] },
    { "id": 10, "tasks": ["2.10", "8.2", "10.9", "12.1"] },
    { "id": 11, "tasks": ["2.11", "8.3", "10.10", "12.3"] },
    { "id": 12, "tasks": ["8.4", "10.11", "12.5", "13.1"] },
    { "id": 13, "tasks": ["10.12", "12.2", "12.7", "13.2"] },
    { "id": 14, "tasks": ["12.4", "12.11", "13.3", "13.4"] },
    { "id": 15, "tasks": ["12.6", "12.8", "13.5", "13.6"] },
    { "id": 16, "tasks": ["12.9", "13.7", "13.8"] },
    { "id": 17, "tasks": ["12.10", "13.9", "15.1", "15.2"] },
    { "id": 18, "tasks": ["15.3", "15.4", "15.5", "15.7", "15.8"] },
    { "id": 19, "tasks": ["15.6"] }
  ]
}
```
