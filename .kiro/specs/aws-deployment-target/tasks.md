# Implementation Plan: AWS Deployment Target

> **Superseded by `aws-byo-deploy`** (`.kiro/specs/aws-byo-deploy/`). The completed work recorded
> below stands, but parts of it were incomplete or incorrect; the corrections plus the remaining
> runtime, CLI and Studio work are planned and tracked in that newer spec, not here.

## Overview

Four deliverables in dependency order: three declaration-only engine additions, the `cloud-aws/`
package (pure `core/`, then SDK `aws/`, then `server/`, then `infra/`), the Studio Deploy_Provider
seam, and the Deploy_Guide plus steering file last so `check-docs.mjs` can derive its assertions from
a template and source that already exist.

Language is TypeScript everywhere, matching the design. No Rust change is in scope: `npx` is already
allow-listed in `ALLOWED_PROGRAMS` (`backend/src-tauri/src/process.rs`) and `stdin_data` already
exists on `run_streamed_command`.

All 34 correctness properties from the design are implemented as exactly one property test each, at a
minimum of 100 iterations, tagged with a comment naming the feature and the property number. Property
placement follows the design's Testing Strategy: Properties 19, 27 and the validator half of 32 in
`engine/` (vitest 4 + fast-check 4), Property 31 and the Studio half of 32 in `frontend/`
(karma + jasmine, exhaustive enumeration rather than sampling because fast-check is not available
there), everything else in `cloud-aws/` (vitest 4 + fast-check 4).

## Tasks

- [x] 1. Engine additions and the `skipped` structural twin
  - [x] 1.1 Add `AWS_CAPABILITIES` and the AWS secret scheme to the engine capability records
    - Add `AWS_CAPABILITIES` to `engine/src/capabilities.ts` with `id: 'aws-fargate'`, all
      `ALL_NODE_KINDS`, `sqlDrivers` of `postgres`, `mysql`, `mssql`, `sqlite`,
      `connectionSecretScheme: 'aws-secrets-manager'`, and `features` of `cron: true`,
      `durableState: true`, `fixtures: true`, `privateNetworkEgress: true`, `stdioMcp: false`,
      `mcpOAuth: false`
    - Include it in `HOST_CAPABILITIES`, making four records
    - Add `'aws-secrets-manager'` to `ConnectionSecretScheme` in `engine/src/data-host.ts`
    - Add the matching `secretRemedy` case in `engine/src/capabilities.ts` naming the exact Secrets
      Manager entry to create, mirroring the `cloudflare-worker-env` case
    - Verify: `cd engine; npm test` and `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`
    - _Requirements: 6.8, 8.3, 10.7, 10.8, 16.1, 16.2_

  - [x] 1.2 Extend `engine/src/capabilities.spec.ts` with the AWS record assertions
    - Assert `HOST_CAPABILITIES` holds exactly four records with distinct ids and that `mssql` is
      declared by the desktop host and AWS_Host only
    - Assert `AWS_CAPABILITIES` field by field including every `features` flag and the new
      `secretRemedy` case output
    - Required by criterion 16.7 as a deliverable, so this sub-task is not optional
    - Verify: `cd engine; npm test`
    - _Requirements: 16.7_

  - [x] 1.3 Add `awsSecretName` to `engine/src/connections.ts`
    - Place it beside `connectionSecretName` and `workerSecretName`
    - Derive `{prefix}/conn/{connectionId}/{normalisedSecretKey}`, deterministic, injective over
      `(connectionId, secretKey)`, at most 512 characters, prefixed by the IaC-owned prefix
    - Keep the `/` separator out of the normalised character class so a key cannot forge another pair
    - Verify: `cd engine; npm test`
    - _Requirements: 8.2_

  - [x] 1.4 Write property test for `awsSecretName`
    - **Property 19: Secret entry names are deterministic, injective and bounded**
    - **Validates: Requirements 8.2**
    - `engine/src/connections.spec.ts`, fast-check, minimum 100 runs, generators including pairs whose
      characters could be mistaken for the separator

  - [x] 1.5 Add `deriveEgressAllowList` in a new `engine/src/egress.ts`
    - Build on the existing `inspectAgainstCapabilities` static host collection and add provider
      hostnames from `engine/src/model.ts`
    - Return `EgressAllowList` with `hosts` lower-cased, alphabetical, deduped case-insensitively and
      capped at 200, plus `undeterminable` entries and the `capped` flag
    - Verify: `cd engine; npm test`
    - _Requirements: 10.4, 10.12_

  - [x] 1.6 Write property test for the egress allow-list derivation
    - **Property 27: The egress allow-list is deduped, ordered, capped and honest about what it cannot derive**
    - **Validates: Requirements 10.4, 10.5, 10.12**
    - `engine/src/egress.spec.ts`, fast-check, minimum 100 runs, covering the console block's leading
      count, the empty-list line and interpolated hostnames

  - [x] 1.7 Add `skipped` to `RunRecordStatus` in both structural twins and all three switch sites
    - Add the member to `engine/src/run-record.ts` (re-exported through `engine/src/types.ts`) and to
      the twin in `frontend/src/app/core/workflow.model.ts`
    - Add an explicit case at `runs-panel.statusIcon`
      (`frontend/src/app/workspace/runs/runs-panel/runs-panel.ts`), `portal-panel.runStatusIcon`
      (`frontend/src/app/workspace/portal/portal-panel/portal-panel.ts`) and the usage analytics
      status facet (`frontend/src/app/workspace/usage/usage-dialog/usage-dialog.ts`), reaching the
      member through no fallback default branch at any of the three
    - Verify: `cd engine; npm test`, `cd cloud; npm run check` (the worker compiles against the same
      engine types), `cd frontend; npm run build`
    - _Requirements: 4.14, 4.15_

  - [x] 1.8 Write frontend specs for the `skipped` status rendering
    - Assert a distinct status representation at each of the three switch sites and that no site
      resolves `skipped` through its fallback default branch
    - karma + jasmine, filtering for the visible panel instance since both sidebars render every panel
    - _Requirements: 4.15_

  - [x] 1.9 Write property test for the validator half of the capability gate
    - **Property 32: Capability findings gate a push identically on both sides (validator half)**
    - **Validates: Requirements 16.3, 16.4, 16.5, 16.6, 16.8**
    - `engine/src/capabilities.spec.ts`, fast-check, minimum 100 runs, over
      `validateAgainstCapabilities(spec, AWS_CAPABILITIES, inventory)`: error findings gate, warnings
      do not. The Studio half is task 13.7, as the design's placement rule requires

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd engine; npm test`, `cd cloud; npm run check`, `cd frontend; npm run build`

- [x] 3. `cloud-aws/` package scaffold, purity checks and test fixtures
  - [x] 3.1 Create the `cloud-aws/` package
    - `cloud-aws/package.json` with an exact CDK version pin, the shared repository version number,
      and `check` plus `test` scripts; `cloud-aws/tsconfig.json` with the `@phorma/engine` path alias
      as the only route to engine source; `cloud-aws/cdk.json` reading the bootstrap qualifier from
      configuration; a vitest 4 + fast-check 4 config; and the `src/core`, `src/aws`, `src/server`,
      `src/infra`, `test` and `scripts` directories
    - Declare no dependency on the `frontend`, `backend` or `cloud` packages
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 13.1, 13.9_

  - [x] 3.2 Write `check-engine-purity.mjs` and `check-engine-alias.mjs`
    - `cloud-aws/scripts/check-engine-purity.mjs`: reject any `@aws-sdk/*` value import, type-only
      import or dynamic import expression in `engine/src`, and any AWS-derived identifier outside the
      declared allow-list of `aws-sigv4`, `bedrock`, `aws-secrets-manager`, `aws-fargate`,
      `awsSecretName`, `AWS_CAPABILITIES`
    - `cloud-aws/scripts/check-engine-alias.mjs`: assert the tsconfig path exists and that no file
      imports a relative path crossing into `../engine`
    - Wire both into the `check` script; both must exit non-zero on violation
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 1.2, 1.7_

  - [x] 3.3 Write `check-versions.mjs` and add `cloud-aws` to the release script
    - Assert five packages carry one version number and that the CDK dependency is an exact pin
    - Add `cloud-aws/package.json` to the bump list in `scripts/release.mjs`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 13.9, 13.10_

  - [x] 3.4 Build the `FakeRunTable` fixture
    - `cloud-aws/src/test/fake-run-table.ts`: `PutItem` and `UpdateItem` with condition expressions,
      all-or-nothing `TransactWriteItems`, `Query` with a page size, `BatchWriteItem`, per-request
      failure injection and an inspectable recorded request log
    - The request log is what makes "one partition key, never a scan" and "the lease write came first"
      assertions possible, so record operation name, key and condition per request
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 18.3, 2.13_

  - [x] 3.5 Build the shared generators fixture
    - `cloud-aws/src/test/generators.ts` with the edge cases the design lists: payload sizes
      straddling 300 KB and 64 KB, state values straddling 32,768 UTF-8 bytes with astral-plane
      characters, `ttlSec` values that are zero, negative, fractional and out of range, retention days
      of 0, 367 and 30.5, blank and invalid cron expressions, 51 schedule-trigger nodes, and 0 and 32
      secret keys
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 3.10, 5.5, 5.7, 6.1, 8.1, 11.5_

- [x] 4. `cloud-aws/src/core`: contract, keys, lease and retry budgets
  - [x] 4.1 Write `core/host-contract.ts`
    - Declare the frozen `RUNTIME_HOST_CAPABILITIES` array of exactly ten keys and one interface per
      capability: `SpecStore`, `JournalStore`, `RunHistoryStore`, `RunEventStore`,
      `UsageLedgerStore`, `ScheduleStore`, `MonitorGateway`, `LeaseStore`
    - Re-export the four engine-owned types (`RunJournal`, `WorkflowStateStore`, `ConnectionStore`,
      `JournalEntry`) rather than redeclaring them, so drift is impossible
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 1.1_

  - [x] 4.2 Write `core/keys.ts`
    - Own every Run_Table key in one module: `pk` always `wf#{workflowId}`, and the `spec`, `lease`,
      `run#`, `journal#`, `event#` with 12-digit zero-padded sequence, `usage#`, `state#`, `frame#`,
      `conn#` and `skip#` sort keys, plus the GSI1 and GSI2 key pairs
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 2.12, 18.2, 4.2_

  - [x] 4.3 Write property test for lease key derivation
    - **Property 4: The lease key is a function of the workflow id alone**
    - **Validates: Requirements 2.12, 18.2**
    - `cloud-aws/src/core/keys.spec.ts`, fast-check, minimum 100 runs, over run contexts differing
      only in run id, trigger source, task id and process id

  - [x] 4.4 Write `core/lease.ts`, the correctness core
    - `HEARTBEAT_MS = 10_000`, `LEASE_TTL_MS = 60_000`, `nextFence`, `expiryFor`, `acquireWrite`,
      `fencedWrite`, `classify` and `isZombie`
    - Acquire is one conditional write: `attribute_not_exists(pk) OR expiresAtMs <= :now` with
      `fence = if_not_exists(fence, :zero) + 1` in the same expression
    - Heartbeat and release condition on `fence = :mine`; release sets `expiresAtMs = :now` and
      retains `fence`
    - Every other run-scoped write is a `TransactWriteItems` with a `ConditionCheck` on the lease,
      exempting only the unfenced skip record
    - `classify` keeps a condition failure distinguishable from a transient one
    - Verify: `cd cloud-aws; npm test` and `cd cloud-aws; npm run check`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.9, 2.10, 2.11, 2.12_

  - [x] 4.5 Write property test for lease exclusivity and fencing
    - **Property 1: Lease grant is exclusive and fencing tokens strictly increase**
    - **Validates: Requirements 2.1, 2.2, 2.10, 2.14**
    - `cloud-aws/src/core/lease.spec.ts` against `FakeRunTable`, fast-check, minimum 100 runs, 2 to
      100 concurrent Runners

  - [x] 4.6 Write property test for fenced writes and zombie inertness
    - **Property 2: Every Runner write is fenced, and a Zombie_Runner changes nothing**
    - **Validates: Requirements 2.5, 2.6, 2.15**
    - Against `FakeRunTable`, fast-check, minimum 100 runs, asserting the stored item is unchanged and
      no retry is attempted

  - [x] 4.7 Write property test for lease expiry bounds
    - **Property 3: Lease expiry stays inside its bounds across the whole lifecycle**
    - **Validates: Requirements 2.3, 2.4, 2.9, 2.11**
    - fast-check, minimum 100 runs, over arbitrary clock values including indefinite suspension

  - [x] 4.8 Write `core/retry.ts`
    - One table of per-category attempt budgets and terminal actions: lease 3 attempts in 5s, journal
      3 in 10s, audit 3, secret 3 in 10s, metric 3
    - Classify a conditional-check failure as never retryable and never reportable as transient
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 2.16, 3.2, 3.9, 4.13, 5.8, 8.14, 12.10_

  - [x] 4.9 Write property test for retry budgets
    - **Property 28: Retry budgets are bounded, and a condition failure is never retried**
    - **Validates: Requirements 2.16, 3.2, 3.9, 4.13, 5.8, 8.14, 12.10**
    - Against `FakeRunTable` failure injection across all five categories, fast-check, minimum 100
      runs, asserting each category's stated terminal action and that a transient store failure never
      surfaces as a false `compareAndSet` result

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd cloud-aws; npm test`, `cd cloud-aws; npm run check`

- [x] 6. `cloud-aws/src/core`: journal codec, event pipeline, retention, frames, schedule names, config
  - [x] 6.1 Write `core/journal-codec.ts`
    - Encode and decode the engine `JournalEntry` shape carrying `output` and optional `viaPortIds`
      and no field the engine does not read
    - Treat an entry that fails to parse as absent; refuse to truncate an over-cap entry and return
      the 300 kilobyte failure decision instead
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 3.7, 3.8, 3.10_

  - [x] 6.2 Write property test for the journal codec
    - **Property 7: Journal entries round-trip, and an unreadable entry reads as absent**
    - **Validates: Requirements 3.7, 3.8**
    - fast-check, minimum 100 runs

  - [x] 6.3 Write `core/events.ts`
    - The fixed pipeline order the properties depend on: stamp the per-run sequence from 1 increasing
      by exactly 1, apply the node's payload-persistence setting, apply the Redactor, measure UTF-8
      bytes, truncate to 300 KB and flag, then emit the item
    - A Redactor failure yields an event with no payload marked as carrying a withheld payload
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 4.2, 4.6, 4.7, 11.6, 11.11_

  - [x] 6.4 Write property test for run event sequencing
    - **Property 9: Run events are contiguously sequenced and read back in emission order**
    - **Validates: Requirements 4.2**
    - fast-check, minimum 100 runs, reading back through the zero-padded sort key with no in-memory
      sort

  - [x] 6.5 Write property test for the two 300 kilobyte behaviours
    - **Property 11: An over-cap event payload is truncated and flagged; an over-cap journal entry fails the run**
    - **Validates: Requirements 3.10, 4.7**
    - fast-check, minimum 100 runs, using the generators that straddle 300 KB, asserting redaction
      happens before measurement

  - [x] 6.6 Write `core/retention.ts`
    - Accept 1 to 366 whole days defaulting to 30, compute the `ttl` attribute in epoch seconds, and
      expose the read-time exclusion predicate applied before DynamoDB removes an item
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 4.8, 11.5, 11.10_

  - [x] 6.7 Write property test for retention
    - **Property 13: Retention excludes an expired item from every read**
    - **Validates: Requirements 4.8, 11.5, 11.10**
    - fast-check, minimum 100 runs, using the retention-day edge generators of 0, 367 and 30.5

  - [x] 6.8 Write `core/frames.ts`
    - Parse an inbound ControlFrame and return one routing decision of `resolve-approval`,
      `resolve-question`, `resolve-wait`, `buffer-event`, `start-run`, `stop` or `ignore`, touching no
      state
    - Accept the existing union unchanged: exactly `approval`, `event`, `question`, `trigger`, `stop`,
      adding no kind and removing no field
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.15_

  - [x] 6.9 Write unit tests for the ControlFrame union shape
    - `cloud-aws/src/core/frames.spec.ts`: exactly the five frame types are accepted and no field was
      removed from any of them
    - _Requirements: 7.1_

  - [x] 6.10 Write property test for frame routing
    - **Property 21: Control frames resolve exactly what they address, and nothing else**
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.15**
    - fast-check, minimum 100 runs, over arbitrary sets of pending approvals, questions and waits
      including the early-event buffering rule

  - [x] 6.11 Write `core/schedule-name.ts`
    - Deterministic naming from `(workflowId, nodeId)`, at most 64 characters, distinct for distinct
      pairs, unique within the schedule group
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 6.5_

  - [x] 6.12 Write `core/config.ts`
    - Parse and validate `AwsDeployConfig`: 12-digit account id, syntactically valid region,
      `[a-z0-9-]{1,32}` name prefix, required permissions boundary ARN, bootstrap qualifier, optional
      App_CMK ARN shape and region match, VPC and subnet id shape and declared subnet-to-VPC
      membership, optional data-source security group id, egress allow-list, non-empty
      cost-allocation tag values, 1 to 366 retention days and the required alarm notification ARN
    - Every check must be reachable with no AWS credentials present, and must run before any construct
      is created so `SHALL create no resource` holds by construction
    - Verify: `cd cloud-aws; npm run check` with AWS credential variables cleared
    - _Requirements: 10.3, 10.11, 11.2, 11.3, 11.9, 12.7, 13.5, 13.8_

- [x] 7. `cloud-aws/src/aws/run-table.ts`: the eight Run_Table capabilities
  - [x] 7.1 Implement spec storage, journal, run history, run events and the usage ledger
    - One `DynamoDBDocumentClient`; `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`,
      `BatchWriteItem` and `TransactWriteItems` only, with no `Scan` import in the file
    - `JournalStore.preload` paginates every entry for a run id for at least 1000 entries;
      `record` resolves only after Run_Table acknowledges; `deleteRun` and `deleteOtherRuns` implement
      the settle and non-resume cleanup
    - One `RunRecord` per run id, written in flight then updated in place on settle with the outcome,
      end timestamp and optional `sync` summary; GSI1 serves history descending at 100 per page with a
      continuation token; GSI2 serves usage ascending at 1000 per page
    - One usage ledger entry per `node-usage` event keyed by workflow, run and node id, so a resumed
      run replaces rather than appends
    - Verify: `cd cloud-aws; npm test` and `cd cloud-aws; npm run check`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.11, 18.3_

  - [x] 7.2 Write property test for run history and usage upsert, ordering and pagination
    - **Property 12: Run history and the usage ledger are upserted, ordered and paginated**
    - **Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.11, 4.14**
    - Against `FakeRunTable`, fast-check, minimum 100 runs, including a `skipped` record served as an
      ordinary `RunRecordSummary`

  - [x] 7.3 Write property test for partition scoping and the scan prohibition
    - **Property 26: Every Run_Table request names one partition key and never scans**
    - **Validates: Requirements 18.3**
    - Against the `FakeRunTable` recorded request log, fast-check, minimum 100 runs, over arbitrary
      operation sequences

  - [x] 7.4 Implement the engine `WorkflowStateStore` against Run_Table
    - `get`, `set`, `delete`, `list` and `compareAndSet` returning the engine `StateEntry` shape;
      `get` absent and `delete` non-erroring for an unknown key
    - `compareAndSet` as a single conditional write with no read-then-write window
    - `list` limited to 1000, defaulting to 1000, clamping a supplied limit to 1 to 1000, prefix
      filtered and workflow-id scoped
    - Reject a value over 32,768 UTF-8 bytes naming the key and the limit, writing nothing
    - Resolve every time-to-live through the single shared function in `engine/src/state.ts` and store
      it as epoch seconds, treating an expired entry as absent on `get`, `list` and the `expected`
      comparison
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 7.5 Write property test for `compareAndSet`
    - **Property 15: compareAndSet has exactly one winner and no effect when it loses**
    - **Validates: Requirements 5.2, 5.3**
    - Against `FakeRunTable`, fast-check, minimum 100 runs, 2 to 100 concurrent callers

  - [x] 7.6 Write property test for the state store bounds, scoping and expiry
    - **Property 16: The state store honours its bounds, scoping and expiry semantics**
    - **Validates: Requirements 5.1, 5.4, 5.5, 5.6, 5.7, 5.9**
    - fast-check, minimum 100 runs, using the 32,768-byte and `ttlSec` edge generators

  - [x] 7.7 Implement the purge path
    - Delete the spec, journal entries, run records, run events, usage ledger entries, workflow state
      and Execution_Lease for a workflow id, answer only after every deletion is confirmed or failed,
      and answer with per-category counts naming any failed category
    - Preserve every Secret_Store entry
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 4.9, 4.10_

  - [x] 7.8 Write property test for purge
    - **Property 14: Purge is complete, itemised and idempotent, and never touches a secret**
    - **Validates: Requirements 4.9, 4.10**
    - Against `FakeRunTable` seeded state, fast-check, minimum 100 runs, asserting a repeat purge
      answers with zero counts

  - [x] 7.9 Write the purge scenario script
    - `cloud-aws/test/purge.e2e.mts`: full teardown, per-category counts, idempotent repeat, secrets
      intact
    - Run with `npx -y tsx cloud-aws/test/purge.e2e.mts` from the repo root
    - _Requirements: 4.9, 4.10_

- [x] 8. `cloud-aws/src/aws`: secrets, telemetry, scheduler and monitor
  - [x] 8.1 Write `aws/secrets.ts`
    - Implement the engine `ConnectionStore`: `assertConnectionId` first, then resolve each of the 0
      to 32 `secretKeys` names through `awsSecretName` in declaration order, stopping at the first
      absent one with a message naming the Connection and that key, settling within 10 seconds
    - Seed the Phase 1 Redactor with every resolved value of 8 characters or more before any value can
      reach a run event, a log line or a metric dimension
    - Read each configured provider key and substitute it for `{{API_KEY}}` at request time, failing
      the node naming the provider when absent with no request sent
    - Implement the Secret_Store write path used by the Trigger_API route, rejecting an empty value or
      one over 64 kilobytes and leaving any existing entry unchanged
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.1, 8.9, 8.10, 8.11, 8.12, 8.14, 8.15_

  - [x] 8.2 Write property test for connection resolution
    - **Property 20: Connection resolution is validated, ordered, complete-or-refusing, and secret-free**
    - **Validates: Requirements 8.1, 8.4, 8.5, 8.8, 8.10, 8.13**
    - fast-check, minimum 100 runs, using the 0 and 32 secret-key generators, including metadata
      carrying a planted value where a secret name belongs

  - [x] 8.3 Write `aws/telemetry.ts`
    - Single-line JSON log entries carrying workflow id, level and an ISO 8601 UTC timestamp, plus the
      run id while a run is in flight, written to the configured log group
    - Publish the six metrics: run outcome, run duration, node retry count, lease takeover, skipped
      scheduled run and dropped audit write, each within 60 seconds carrying the workflow id as a
      dimension
    - Route every log entry and metric dimension through the same Redactor instance `secrets.ts`
      seeded, and continue the run when publication fails after 3 attempts with a log line naming the
      metric
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 2.8, 12.1, 12.2, 12.8, 12.9, 12.10_

  - [x] 8.4 Write property test for structured telemetry
    - **Property 30: Structured telemetry is complete and run-scoped**
    - **Validates: Requirements 12.1, 12.2, 12.9**
    - fast-check, minimum 100 runs, asserting that filtering by run id partitions the entries of
      concurrent runs exactly

  - [x] 8.5 Write property test for secret absence across every sink
    - **Property 10: Nothing persisted, logged or measured contains a resolved secret**
    - **Validates: Requirements 4.6, 8.11, 11.6, 11.11, 12.8**
    - fast-check, minimum 100 runs, checking run events, journal entries, run records, log entries,
      metric dimensions and Trigger_API response bodies for every value of 8 or more characters as a
      whole and as a substring

  - [x] 8.6 Write `aws/scheduler.ts`
    - Implement `ScheduleStore` over the IaC-owned schedule group in the Region_Pin with a UTC time
      zone, one schedule per `schedule-trigger` node whose `cron` is non-blank, capped at 50
    - Validate before any mutation, then delete-all with every deletion confirmed before the first
      create, rolling back every schedule created during a failed push
    - Delete a schedule that fires for a workflow id whose spec is absent and publish the
      skipped-scheduled-run metric
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11_

  - [x] 8.7 Write property test for the deployed schedule set
    - **Property 17: The deployed schedule set equals the pushed spec's derived set**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.5, 6.6**
    - fast-check, minimum 100 runs, using the blank and invalid cron generators

  - [x] 8.8 Write property test for schedule push atomicity
    - **Property 18: A schedule push is all-or-nothing**
    - **Validates: Requirements 6.9, 6.10**
    - fast-check, minimum 100 runs, using the 51-schedule-trigger-node generator and failure injection
      at every call position

  - [x] 8.9 Write `aws/monitor.ts`
    - Push RunEvents with `PostToConnection` holding only `execute-api:ManageConnections` against the
      Monitor_API stage, discarding a connection id on `GoneException` and continuing the run
    - Fan out to every authenticated connection of that workflow id and to none of another, and
      continue to a settled outcome with zero connections open
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.2, 7.12, 7.13, 7.14, 7.16_

  - [x] 8.10 Write property test for monitor delivery
    - **Property 22: Monitor delivery reaches every connection of that workflow exactly once and no other**
    - **Validates: Requirements 7.2, 7.13, 7.14, 7.16**
    - fast-check, minimum 100 runs, asserting the persisted run event count is invariant in the number
      of open connections

  - [x] 8.11 Write the monitor frames scenario script
    - `cloud-aws/test/monitor-frames.e2e.mts`: approve, answer a question, early event, stop, and a
      contended `trigger` frame answered by a synthetic `run-failed`
    - Run with `npx -y tsx cloud-aws/test/monitor-frames.e2e.mts`; abandon an unsettled run and
      synchronise on a side-channel promise rather than awaiting it, per the `tsx` hazard
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.8_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd cloud-aws; npm test`, `cd cloud-aws; npm run check`, `cd engine; npm test`

- [x] 10. `cloud-aws/src/server`: runner, trigger routes and startup
  - [x] 10.1 Write `server/runner.ts`
    - One run's lifecycle: acquire the lease as the first Run_Table operation, preload the journal,
      compose `RunOptions`, start the engine, fan events to Run_Table and Monitor_API, drain the frame
      inbox on a 1 second tick, heartbeat on a 10 second tick, settle, release, delete the journal
    - `capabilities` is always `AWS_CAPABILITIES` and the adapter declares no capability value of its
      own; for any capability that record declares absent the corresponding `RunOptions` member is
      left absent
    - Stop node bodies within one heartbeat on lease loss, attempt no further write, and report
      `run-failed` naming lease loss
    - Restart an interrupted run with the same run id and trigger input, bounded at 3 replacements per
      run id
    - Record model spend with the real provider name and the bring-your-own cost field, leaving the
      Phorma Cloud cost field absent
    - Verify: `cd cloud-aws; npm test` and `cd cloud-aws; npm run check`
    - _Requirements: 1.5, 1.6, 2.6, 2.11, 3.6, 3.9, 3.11, 18.5_

  - [x] 10.2 Write property test for `RunOptions` composition
    - **Property 24: RunOptions carry the declared capability record and nothing more**
    - **Validates: Requirements 1.5, 1.6**
    - fast-check, minimum 100 runs, asserting no side-effect call is recorded on any host fake for a
      node requiring an absent capability

  - [x] 10.3 Write property test for resume
    - **Property 8: Resume replays completed work without repeating a side effect**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 3.6**
    - Against `FakeRunTable`, fast-check, minimum 100 runs, over arbitrary replacement points

  - [x] 10.4 Write the resume and zombie scenario scripts
    - `cloud-aws/test/resume.e2e.mts`: kill mid-run, restart, no repeated side effect, run completes
    - `cloud-aws/test/zombie-fencing.e2e.mts`: steal the lease mid-run, every subsequent write
      refused, exactly one `run-failed`
    - Run with `npx -y tsx cloud-aws/test/<name>.e2e.mts`
    - _Requirements: 3.6, 2.6, 2.15_

  - [x] 10.5 Write property test for host-independent event parity
    - **Property 23: The forwarded event sequence matches the host-independent reference**
    - **Validates: Requirements 1.3, 1.8**
    - Model-based comparison against the engine's in-memory `referenceHost`, fast-check, minimum 100
      runs, differing only in run id, timestamps and host identity fields

  - [x] 10.6 Write property test for bring-your-own accounting
    - **Property 33: A run on AWS_Host is accounted as bring-your-own**
    - **Validates: Requirements 18.4, 18.5**
    - fast-check, minimum 100 runs

  - [x] 10.7 Write `server/trigger-routes.ts`
    - The eight routes: spec push, trigger, purge, run history, run detail, usage, connection
      inventory and the Secret_Store write
    - Attempt the lease conditional write as the first Run_Table operation of every trigger source,
      answering 409 within 5 seconds with one unfenced skip record naming the workflow id, the trigger
      source and the holding Fencing_Token on a condition failure, and a distinct error when the lease
      state could not be determined
    - Run the Capability_Validator against `AWS_CAPABILITIES` on a spec push, answering with the
      findings and leaving the stored spec and schedule set unchanged when any finding is an error
    - Serve the `ConnectionSummary` inventory with `secretsPresent` and `missingSecretKeys` and no
      secret value; reject a push carrying a value where a secret name belongs
    - Reject an unknown workflow id with 404 and an invalid `since` value with a naming rejection,
      creating no item, and perform every existence check only after authentication has succeeded
    - Verify: `cd cloud-aws; npm test` and `cd cloud-aws; npm run check`
    - _Requirements: 2.7, 2.13, 2.16, 4.3, 4.5, 4.12, 4.16, 6.4, 8.4, 8.5, 8.8, 8.13, 9.9, 16.5_

  - [x] 10.8 Write property test for the contended trigger
    - **Property 5: A contended trigger starts no run and records exactly one skip**
    - **Validates: Requirements 2.7, 4.16, 6.4, 7.8**
    - fast-check, minimum 100 runs, asserting zero usage ledger entries for a skipped run

  - [x] 10.9 Write property test for lease-write ordering
    - **Property 6: The lease write is the first Run_Table operation of every trigger**
    - **Validates: Requirements 2.13, 7.7**
    - Against the `FakeRunTable` recorded request log across schedule fire, webhook, manual call and
      monitor `trigger` frame, fast-check, minimum 100 runs

  - [x] 10.10 Write the lease contention scenario script
    - `cloud-aws/test/lease-contention.e2e.mts`: two Runners, one workflow, one winner, one skip
      record, 409
    - Run with `npx -y tsx cloud-aws/test/lease-contention.e2e.mts`
    - _Requirements: 2.7, 2.14_

  - [x] 10.11 Write `server/startup.ts`
    - Assert the composed adapter provides a live implementation for every capability
      `AWS_CAPABILITIES` declares present, against the frozen ten-key array
    - Fail startup before the NLB target passes its first health check, start no run, and report an
      error naming each unimplemented capability
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 1.9_

  - [x] 10.12 Write property test for startup completeness
    - **Property 25: Startup refuses to serve an incomplete contract**
    - **Validates: Requirements 1.9**
    - fast-check, minimum 100 runs, over arbitrary subsets of the ten capabilities

  - [x] 10.13 Write the capability refusal scenario script
    - `cloud-aws/test/capability-refusal.e2e.mts`: a stdio MCP node and an unsupported driver refused
      at push and at run
    - Run with `npx -y tsx cloud-aws/test/capability-refusal.e2e.mts`
    - _Requirements: 1.6, 16.5_

- [x] 11. `cloud-aws/src/infra`: constructs, Aspects, Plan_Command preflight and the check pipeline
  - [x] 11.1 Write the CDK constructs and `PhormaAwsHostStack`
    - `NetworkConstruct`, `DataConstruct`, `SecretsConstruct`, `ComputeConstruct`,
      `TriggerApiConstruct`, `MonitorApiConstruct`, `ScheduleConstruct`, `IdentityConstruct` and
      `ObservabilityConstruct`, all created within a single `cdk deploy`
    - Private subnets with no internet gateway route and `AssignPublicIp: DISABLED`; the DynamoDB
      gateway endpoint and the Secrets Manager, ECR API, ECR DKR, CloudWatch Logs, STS and Scheduler
      interface endpoints with private DNS in the task subnets; a task security group with egress only
      to those endpoints, the configured data-source security group on its port and the ports the
      egress allow-list requires, and no all-destinations rule
    - Run_Table with GSI1 and GSI2, App_CMK encryption, point-in-time recovery and the `ttl`
      attribute; the four roles with the exact grants the design's identity table states, expressed as
      managed policies with prefixed names and no inline policy; both APIs with authorizers; the
      schedule group; the ECR repo; the log groups with retention matching the configured run-event
      retention; and both alarms
    - Use `Vpc.fromVpcAttributes`, never `fromLookup`, and apply the bootstrap qualifier through
      `DefaultStackSynthesizer`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 9.5, 9.6, 9.7, 10.1, 10.2, 10.3, 10.10, 11.1, 11.7, 11.12, 12.3, 12.4, 13.2, 13.3, 13.6, 13.7, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.13, 15.14, 18.1_

  - [x] 11.2 Write the six synthesis Aspects
    - `PermissionsBoundaryAspect`, `CustomerKeyAspect`, `AuthorizerAspect`, `NoIamUserAspect`,
      `AlarmTargetAspect` and `TagAspect`, each failing synthesis with a message naming the offending
      element and creating no resource
    - Keep each Aspect a pure function over the construct tree so Property 29 can drive it against
      generated trees
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 9.5, 9.11, 11.1, 12.5, 12.6, 12.7, 13.4, 13.5, 15.8_

  - [x] 11.3 Implement the Plan_Command existence preflight
    - `ec2:Describe*` calls in the Region_Pin for every configured VPC, subnet and security group id
      plus the declared subnet-to-VPC membership, and `kms:DescribeKey` for a supplied App_CMK ARN
    - Complete both before any `cdk deploy` invocation and exit non-zero reporting the same message
      the credential-free criterion states for that identifier
    - Keep the decision a pure function of the configuration and the describe responses
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 10.13, 10.14, 11.13, 11.14_

  - [x] 11.4 Write property test for synthesis failures and the preflight
    - **Property 29: Synthesis fails on any policy violation it can see, and the Plan_Command catches every non-existence**
    - **Validates: Requirements 9.5, 9.7, 9.11, 10.3, 10.11, 10.13, 10.14, 11.1, 11.2, 11.3, 11.9, 11.13, 11.14, 12.5, 12.6, 12.7, 13.4, 13.6, 13.7, 15.8**
    - fast-check, minimum 100 runs, over generated construct trees and configurations for the Aspect
      half and over fake describe responses for the preflight half, with no AWS present

  - [x] 11.5 Wire the `cloud-aws` check pipeline
    - `npm run check` runs, in order, with AWS credential variables cleared and exiting non-zero on any
      failure: `tsc --noEmit`, `cdk synth` with no context lookups, the `Template` assertion suite, the
      IAM deny-list assertions, `check-no-scan.mjs`, `check-engine-purity.mjs`,
      `check-engine-alias.mjs` and `check-versions.mjs`
    - Write `cloud-aws/scripts/check-no-scan.mjs` asserting no DynamoDB scan operation anywhere in the
      package
    - `check-docs.mjs` is added to this pipeline by task 15.3, once the guide it derives its assertions
      from exists
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 13.8, 18.6_

  - [x] 11.6 Write the `Template` assertion suite
    - `aws-cdk-lib/assertions` over the synthesized output: the resource inventory, one table and one
      HTTP API and one WebSocket API, the VPC endpoints with private DNS, `AssignPublicIp: DISABLED`,
      App_CMK on the four encrypted resources with log retention, `kms:Decrypt` with its `ViaService`
      condition, every route's authorizer and the portal throttle, `execute-api:ManageConnections`
      scoped to the stage and nothing else against Monitor_API, both alarms, and the bootstrap
      qualifier
    - Confirm the six Aspects are wired into the app
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.12, 9.1, 9.5, 9.6, 9.12, 10.1, 10.2, 11.1, 11.7, 11.12, 12.3, 12.4, 13.2, 13.3, 18.1_

  - [x] 11.7 Write the IAM deny-list assertions
    - The Runtime_Identity policy grants nothing criterion 15.3 excludes and carries exactly one
      statement whose action set is exactly `iam:PassRole`, whose resource set is exactly the
      Scheduler_Invoke_Identity role ARN and whose condition requires
      `iam:PassedToService = scheduler.amazonaws.com`
    - The Scheduler_Invoke_Identity grants exactly `execute-api:Invoke` on the single scheduled-run
      route and its trust policy names `scheduler.amazonaws.com` as its only principal under the
      `aws:SourceArn` condition scoped to the schedule group
    - The same treatment for the Task_Execution and Deployment policies
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.6, 8.7, 11.8, 15.3, 15.4, 15.5, 15.6, 15.12, 15.15_

  - [x] 11.8 Write property test for role disjointness and deploy trust shapes
    - **Property 34: Roles stay disjoint and the deploy trust policy accepts every supported shape**
    - **Validates: Requirements 15.1, 15.7, 15.13, 15.14, 15.15**
    - fast-check, minimum 100 runs, over the three supported Deployment_Identity trust configurations
      plus the empty configuration that must fail synthesis

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd cloud-aws; npm run check`, `cd cloud-aws; npm test`

- [x] 13. Studio Deploy_Provider, the `phorma-aws` shim and the capability gate
  - [x] 13.1 Write `frontend/src/app/core/deploy/deploy-targets.ts` as a leaf module
    - `DeployTargetId`, `DeployCommand`, `DeployTarget` and the `DEPLOY_TARGETS` record with pure data
      and functions, no `inject` and no service dependency, following `core/phorma-cloud-url.ts`
    - `instanceUrl` is the only place a deployed-instance URL is shaped: the
      `/agents/workflow-agent/{id}` shape for Cloudflare and Phorma targets, `{base}/workflows/{id}`
      for `aws`
    - Add `'aws'` to `SettingsService.CloudProviderChoice`, carried by the existing
      `phorma.layout.cloudProvider` persistence with no migration
    - Move `CloudService` and the Cloud dialog onto the record so neither carries a target-id branch
    - Verify: `cd frontend; npm run build`
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 13.2 Write the `cloud-aws/bin/phorma-aws.mjs` CLI shim
    - The five verbs: `plan` (cdk diff plus the existence preflight of task 11.3), `deploy`,
      `request` (one SigV4-signed HTTPS call with the body on stdin and a sentinel-prefixed
      `__phorma__:{seq}:{chunk}` stdout envelope), `monitor-url` (presign a `$connect` URL) and
      `doctor` (session validity and entry-point checks by exit code)
    - Inherit the ambient profile or SSO session; read no credential from argv or the environment the
      Studio sets
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 9.8, 9.13, 14.8, 14.10_

  - [x] 13.3 Write `AwsDeployConfigService`
    - Signals for account id, region, name prefix, permissions boundary ARN, VPC and subnet ids,
      App_CMK ARN, tag set, retention days, notification target, bootstrap qualifier and the
      `cloud-aws` directory, each with a `computed` validator
    - `buildConfigFile()` writes a gitignored `cdk.context.phorma.json` beside `cdk.json` with the
      same generated-file header the wrangler override uses; add the path to `.gitignore`
    - Display the Region_Pin in the Cloud dialog, or an indication that none is configured
    - Verify: `cd frontend; npm run build`
    - _Requirements: 11.4, 14.12, 14.13_

  - [x] 13.4 Write `AwsCliService`
    - Own every `phorma-aws` invocation through the Deploy_Runner: at most one command per target at a
      time with a cancel affordance, the Plan_Command first with output streamed line by line, an
      explicit `ConfirmDialogService` confirmation before deploy that is never offered when the plan
      exited non-zero, and exit-code mapping that appends the `aws sso login` next step on an
      authentication failure
    - Refuse to run in the browser preview and refuse when the configured `cloud-aws` directory or CDK
      entry point is absent
    - Inject `TauriService`, `TerminalOutputService`, `ToastService` and `ConfirmDialogService` only,
      never `CloudService`
    - Verify: `cd frontend; npm run build`
    - _Requirements: 9.13, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.14_

  - [x] 13.5 Write the egress allow-list console block into the deploy flow
    - Call `deriveEgressAllowList` before the Deploy_Runner starts, write the entry count line then
      one line per entry, write the explicit no-hostname line for an empty list, name each node whose
      hostname could not be derived on exactly one line, and let the deploy proceed
    - Verify: `cd frontend; npm run build`
    - _Requirements: 10.4, 10.5, 10.12_

  - [x] 13.6 Point `CapabilityFindingsService` at the selected target's record
    - Read `DEPLOY_TARGETS[target].capabilities` instead of `CLOUDFLARE_CAPABILITIES`, keeping
      `deployOnly` findings forced to `warning` so they never block a local run
    - Run the Capability_Validator against `AWS_CAPABILITIES` and the Trigger_API Connection inventory
      before a push, sending no spec when any finding is an error and writing every finding to the
      Problems console either way
    - Treat the Host_Adapter's findings as authoritative when they differ, writing them to the same
      surface
    - Verify: `cd frontend; npm run build`
    - _Requirements: 16.3, 16.4, 16.8_

  - [x] 13.7 Write the Deploy_Provider totality spec by exhaustive enumeration
    - **Property 31: The Deploy_Provider is total, and command construction never carries a credential**
    - **Validates: Requirements 14.2, 14.3, 14.8, 14.13**
    - karma + jasmine, no fast-check available: enumerate all three target ids and all sixteen
      malformed-field subsets rather than sampling, which is a stronger claim than 100 random draws

  - [x] 13.8 Write the Studio half of the capability gate spec by exhaustive enumeration
    - **Property 32: Capability findings gate a push identically on both sides (Studio half)**
    - **Validates: Requirements 16.3, 16.4, 16.5, 16.6, 16.8**
    - karma + jasmine, enumerating the finding-severity combinations, asserting the Studio's findings
      equal the validator's apart from `deployOnly` tagging and that a disagreement displays the
      Host_Adapter's findings. The validator half is task 1.9

  - [x] 13.9 Write the remaining frontend specs for the AWS deploy flow
    - Target persistence across a reload (14.1), plan-then-confirm-then-deploy ordering and the
      non-zero-plan branch (14.4-14.6), the authentication-failure message (14.9), the
      missing-directory and missing-entry-point branches (14.10), the browser-preview refusal (14.11),
      the gitignored generated file and its header (14.12), the concurrent-command guard and cancel
      affordance (14.14), and the Region_Pin display in both states (11.4)
    - _Requirements: 11.4, 14.1, 14.4, 14.5, 14.6, 14.9, 14.10, 14.11, 14.12, 14.14_

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd frontend; npm run build`, `cd engine; npm test`, `cd cloud; npm run check`,
    `cd cloud-aws; npm run check`, `cd cloud-aws; npm test`, `cd backend/src-tauri; cargo check`

- [x] 15. Deploy_Guide, steering file and the docs check
  - [x] 15.1 Write `docs/deploy-aws.md`
    - Sections in this order: what you are deploying, decide first, the Platform_Request_Template,
      bootstrap, configure, deploy, verify, operate, teardown, troubleshooting
    - List every resource the IaC_App creates, every Run_Table data category and every outbound call
      the Host_Adapter makes; state the Fargate-only, single-estate, DynamoDB single-table, WebSocket
      monitor and CDK decisions with their reasons; name the pinned CDK version wherever it names a
      bootstrap role or behaviour, and the `cloud-aws` check command as the pre-deploy step
    - Make the Platform_Request_Template copy-pasteable with each item separately labelled: the
      Deployment_Identity and its trust policy, the Permissions_Boundary, bootstrap approval with the
      qualifier, the VPC, subnets and endpoints, App_CMK and its key-policy grants, the
      Egress_Allow_List and the tag set
    - Document each private-source connectivity pattern as a separately titled option with the
      resources each side owns and the configuration inputs it requires
    - Label every IAM action list `verified against a deployed account` or `indicative, pending
      account validation` with the CDK version and region used, name IAM Access Analyzer policy
      generation from CloudTrail as the Runtime policy trimming method, and list each organisation
      guardrail with its consequence
    - Cover the five troubleshooting cases with the exact symptom string each produces and its
      corrective action, name each teardown-retained resource with the action that removes it, and
      name the five first-deploy verify checks with their observable results
    - _Requirements: 10.9, 13.11, 15.9, 15.10, 15.11, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.9, 17.10_

  - [x] 15.2 Write `.kiro/steering/aws-host.md`
    - A fileMatch area file covering `cloud-aws/`, giving the AWS host the always-on context the
      Cloudflare host has: the `core`/`aws`/`server`/`infra` boundary, the lease and fencing
      invariant, the no-Scan rule, the engine alias rule and the check pipeline
    - _Requirements: 17.8_

  - [x] 15.3 Write `check-docs.mjs`
    - Assert the guide's section order and content correspondences, deriving the resource list from the
      synthesized template and the troubleshooting symptom strings from the source rather than
      duplicating them, so drift fails the check
    - Add the step to the `cloud-aws` check pipeline that task 11.5 wired
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 10.9, 13.11, 15.9, 15.10, 15.11, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd frontend; npm run build`, `cd engine; npm test`, `cd cloud; npm run check`,
    `cd cloud-aws; npm run check`, `cd cloud-aws; npm test`, `cd backend/src-tauri; cargo check`

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Task 1.2 is deliberately
  not optional: criterion 16.7 makes the `capabilities.spec.ts` assertions a deliverable.
- All 34 correctness properties are covered. Property 32 is the one property split across two
  packages, as the design's placement rule requires: the validator half in `engine/` (task 1.9) and
  the Studio half in `frontend/` (task 13.8). Every other property is exactly one test.
- Property tests in `engine/` and `cloud-aws/` use vitest 4 plus fast-check 4 at a minimum of 100
  iterations. Frontend properties use karma and jasmine with exhaustive enumeration, because
  fast-check is not available there.
- `cd cloud; npm run check` appears in the verification for task 1.7 because `RunRecordStatus` gaining
  `skipped` is a structural twin change and the worker compiles against the same engine types.
- `engine/` has no local TypeScript install. A type-only check there is
  `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`, never `npx tsc`.
- No Rust change is in scope. `npx` is already allow-listed in `process.rs` and `stdin_data` already
  exists, so `cargo check` appears only as an unchanged-baseline confirmation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.5", "1.7", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "1.8", "1.9", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 2, "tasks": ["4.1", "4.2", "6.11", "6.12"] },
    { "id": 3, "tasks": ["4.3", "4.4", "6.1", "6.6", "6.8", "11.1"] },
    { "id": 4, "tasks": ["4.5", "4.6", "4.7", "4.8", "6.2", "6.3", "6.7", "6.9", "6.10", "11.2"] },
    { "id": 5, "tasks": ["6.4", "6.5", "7.1", "8.1", "8.3", "11.3"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4", "8.2", "8.6", "8.9", "11.4"] },
    { "id": 7, "tasks": ["7.5", "7.6", "7.7", "8.4", "8.5", "8.7", "8.8", "8.10", "11.5"] },
    { "id": 8, "tasks": ["4.9", "7.8", "8.11", "10.1", "11.6", "11.7"] },
    { "id": 9, "tasks": ["7.9", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "11.8"] },
    { "id": 10, "tasks": ["10.8", "10.9", "10.10", "10.11", "13.1", "13.2"] },
    { "id": 11, "tasks": ["10.12", "10.13", "13.3", "13.4", "13.6"] },
    { "id": 12, "tasks": ["13.5", "13.7", "13.8", "13.9"] },
    { "id": 13, "tasks": ["15.1", "15.2"] },
    { "id": 14, "tasks": ["15.3"] }
  ]
}
```
