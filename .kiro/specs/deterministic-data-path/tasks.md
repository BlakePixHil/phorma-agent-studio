# Implementation Plan: Deterministic Data Path (Phase 1)

## Overview

Implementation proceeds outward from the pure engine core. The dependency-free primitives land first
(`engine/src/expr.ts`, `state.ts`, `retry.ts`, `redact.ts`, `connections.ts`, `data-host.ts`,
`capabilities.ts`, `data-nodes.ts`), then the executor cases in `engine/src/engine.ts`, then the three
host drivers (Tauri desktop, browser preview, Cloudflare Worker), then the Studio authoring surfaces
and push-time validation. Every module is TypeScript except the desktop drivers, which are Rust in
`backend/src-tauri`.

Out of scope, per the design: P1-14 connector packaging and all Phase 2 AWS host work.

## Tasks

- [x] 1. Type foundations and engine test harness
  - [x] 1.1 Add the eight data node kinds and their node data types to the engine spec contract
    - Extend `engine/src/types.ts` with `http-request`, `sql-query`, `transform`, `aggregate`, `assert`, `state-get`, `state-set` and `notify` on `WorkflowNodeKind`, plus `DATA_NODE_KINDS`, `DATA_IO_KINDS`, `isDataNode` and `rejectsToolLink`
    - Add `NodeRetryPolicy` (with `AgentRetryPolicy` as a deprecated alias), `HttpRequestNodeData`, `PaginationConfig`, `SqlQueryNodeData`, `TransformNodeData`, `TransformField`, `AggregateNodeData`, `GroupSpec`, `AggregateMetric`, `JoinSpec`, `PivotSpec`, `AssertNodeData`, `Assertion`, `StateGetNodeData`, `StateSetNodeData`, `NotifyNodeData`, `FixtureMode`, `RedactionRule` and `batchSize` on `ForEachNodeData`
    - _Requirements: 1.1, 2.1, 5.1, 6.1, 7.1, 8.1, 9.1, 9.8, 10.1, 12.1, 13.1, 15.1_

  - [x] 1.2 Mirror the new types in the Studio workflow model
    - Add the same kinds and node data interfaces to `frontend/src/app/core/workflow.model.ts`, extend the `WorkflowNodeData` union, and add `WorkflowSettings.notifications` and `WorkflowSettings.retention`
    - Keep every new kind `category: 'flow'` so `NODE_CATEGORY_COLORS` is untouched
    - _Requirements: 1.1, 1.7, 2.2, 13.6, 15.1, 15.12_

  - [x] 1.3 Set up the engine unit and property test harness
    - Add `vitest` and `fast-check` as dev dependencies plus a `test` script in `engine/package.json`, and create `engine/vitest.config.ts`
    - Create `engine/src/test/generators.ts` with shared arbitraries: arbitrary `Json`, arbitrary row array with a controllable key domain, arbitrary well-formed expression AST rendered to source, and arbitrary `RunEvent`
    - Add no runtime dependency to `engine/package.json`
    - _Requirements: 18.7_

- [x] 2. Engine-native expression evaluator (`engine/src/expr.ts`)
  - [x] 2.1 Implement the lexer, parser and `compileExpression`
    - Implement the §4.2 grammar, `ExpressionError` with a zero-based position, `CompiledExpression.source`, deduplicated `references` in first-occurrence order, and the 1-4096 character source bound
    - Enforce `MAX_EXPRESSION_DEPTH` (64) and `MAX_EXPRESSION_STEPS` (100000) as compile-time constants used by the evaluator
    - _Requirements: 4.1, 4.2, 4.3, 4.19_

  - [x] 2.2 Implement the evaluator core
    - Implement `evaluate` over the AST with `EvalContext`, absent-path-to-`null` resolution agreeing with `resolveJsonPath` in `engine/src/payload.ts`, arithmetic that yields `null` instead of `NaN`/`Infinity`, cross-type ordering comparisons yielding `false`, JSON structural equality for `==`/`!=`, `&&`/`||` short-circuit, the `in` operator, `now()` reading `EvalContext.nowMs`, and depth/step budget enforcement
    - Leave the supplied `EvalContext` structurally unchanged on both return and throw
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.18, 4.19, 4.21_

  - [x] 2.3 Implement the `EXPR_FUNCTIONS` table
    - Implement every listed function as total, returning `null` on a type it does not accept, with compile-time arity and unknown-name rejection
    - Implement sub-expression arguments for `map`, `filter`, `sort`, `sum`, `avg`, `distinct` and `countIf` with `item`/`index` bound and the enclosing bindings restored on return
    - _Requirements: 4.13, 4.14, 4.20_

  - [x] 2.4 Implement `validateExpression` and `printExpression`
    - `validateExpression` accepts exactly what `compileExpression` accepts, reports the same position, and throws for no string input
    - `printExpression` renders a compiled expression to source that recompiles, with character-identical output per invocation
    - _Requirements: 4.15, 4.16_

  - [x] 2.5 Write property test for expression totality, determinism and purity
    - **Property 1: Expression evaluation is total, pure and deterministic (claims 1, 2, 3)**
    - **Validates: Requirements 4.4, 4.11, 4.12, 4.19**

  - [x] 2.6 Write property test for no coercion and path safety
    - **Property 1: Expression evaluation is total, pure and deterministic (claims 4, 5)**
    - **Validates: Requirements 4.6, 4.7, 4.8, 4.18**

  - [x] 2.7 Write property test for parser termination and print/compile round trip
    - **Property 1: Expression evaluation is total, pure and deterministic (claim 6)**
    - **Validates: Requirements 4.3, 4.16, 4.17**

  - [x] 2.8 Write unit tests for the expression module
    - Table-driven cases per operator, per function, per error position; unknown identifier, unknown function and wrong-arity rejection
    - _Requirements: 4.2, 4.3, 4.13, 4.15_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Connection entity and host capability contracts
  - [x] 4.1 Create `engine/src/connections.ts`
    - Define `Connection`, `ConnectionType`, `SqlDriver`, `ConnectionAuth`, `SqlLimits`, `ResolvedConnection`, `ConnectionSummary`, the `^conn-[A-Za-z0-9_-]{1,64}$` id validator, `connectionSecretName` and `workerSecretName`
    - Export from `engine/src/index.ts`
    - _Requirements: 2.1, 2.6, 2.9, 2.11, 3.1, 3.5_

  - [x] 4.2 Create `engine/src/data-host.ts`
    - Define `ConnectionStore`, `DataRequest`, `DataResponse`, `DataFetcher`, `TransportFailureKind`, `DataTransportError`, `HttpStatusError`, `SqlRequest`, `SqlResult`, `SqlHost`, `StateEntry`, `WorkflowStateStore`, `FixtureStore` and `HostCapabilities`
    - Add the optional `connections`, `dataFetch`, `sql`, `state`, `fixtures`, `workflowId`, `redact` and `capabilities` members to `RunOptions` in `engine/src/engine.ts`
    - _Requirements: 8.16, 10.10, 12.1, 16.1, 17.1, 18.1_

  - [x] 4.3 Write unit tests for connection identity and secret naming
    - `connectionSecretName` prefixing, `workerSecretName` normalisation against `^[A-Z][A-Z0-9_]*$`, connection id rejection cases
    - _Requirements: 2.11, 3.1, 3.5_

- [x] 5. Retry classifier (`engine/src/retry.ts`)
  - [x] 5.1 Implement the pure retry decision module
    - Implement `RETRYABLE_STATUSES`, `parseRetryAfter` (delta-seconds and HTTP-date), `backoffFor` (full-jitter with an injected random source), `normalisePolicy` (clamping `maxAttempts` to 1-5 and resolving every default) and `decideRetry` with the `status`/`transport`/`retry-after`/`policy-all`/`not-retryable` reasons
    - Retry a non-idempotent step only for a `DataTransportError` whose `requestNeverSent` is true
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.14_

  - [x] 5.2 Write property test for retry bounds, safety and purity
    - **Property 5: Retry is bounded and never repeats an unsafe write (claims 21, 22, 23, 24, 26)**
    - **Validates: Requirements 11.2, 11.4, 11.5, 11.6, 11.7, 11.9**

  - [x] 5.3 Write unit tests for `parseRetryAfter` and the `decideRetry` matrix
    - Delta-seconds, HTTP-date, garbage and absent header values; the status/idempotency matrix; `disabled` and `retryOn: 'none'`
    - _Requirements: 11.3, 11.8, 11.14_

- [x] 6. Redaction pipeline (`engine/src/redact.ts`)
  - [x] 6.1 Implement `createRedactor`
    - Implement `RedactionConfig`, `addLiterals`, `scrub` (literals first on raw text with `MIN_SECRET_LEN` 8, then depth-32 structural `path`/`key` rules, then `pattern` rules on non-JSON text) and `event`
    - Compile `pattern` rules once with a 256-character source cap, a 100 ms per-input match budget, and `mask`/`hash`/`drop` replacements
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.14, 15.16, 15.17_

  - [x] 6.2 Write property test for redaction secret exclusion and idempotence
    - **Property 7: Redaction removes every secret and is idempotent (claims 34, 35, 36, 37, 38, 39)**
    - **Validates: Requirements 15.3, 15.5, 15.7, 15.8, 15.9, 15.17**

  - [x] 6.3 Write unit tests for rule kinds and budgets
    - Short-literal pass-through, oversized pattern rejection, exhausted match budget, deep-nesting cut-off
    - _Requirements: 15.4, 15.5, 15.15, 15.16_

- [x] 7. Durable state primitives (`engine/src/state.ts`)
  - [x] 7.1 Implement the state key scheme and sync primitives
    - Implement `scopedStateKey`, `STATE_NS`, `canonicalJson`, `fnv1a`, `compareWatermark`, `deltaFilter` and `claimIdempotent`
    - Add `engine/src/test/memory-state-store.ts`: an in-memory `WorkflowStateStore` honouring TTL expiry, the 1000-entry `list` clamp, the 32 KB value cap and atomic `compareAndSet`
    - _Requirements: 12.2, 12.3, 12.7, 12.10, 12.11, 12.12, 12.15, 12.18, 12.19_

  - [x] 7.2 Write property test for watermark total order
    - **Property 6: State primitives are idempotent, isolated and order-independent (claim 29)**
    - **Validates: Requirements 12.8, 12.15**

  - [x] 7.3 Write property test for canonical JSON key-order insensitivity and delta conservation
    - **Property 6: State primitives are idempotent, isolated and order-independent (claims 30, 31, 32)**
    - **Validates: Requirements 12.7, 12.10, 12.11**

  - [x] 7.4 Write property test for the state store contract
    - **Property 6: State primitives are idempotent, isolated and order-independent (claims 27, 28, 33)**
    - **Validates: Requirements 12.2, 12.13, 12.20**

  - [x] 7.5 Write unit tests for state bounds and expiry
    - Value size rejection, prune-oldest ordering excluding `wm:`/`oauth:`, namespace TTL defaults, `delete` semantics
    - _Requirements: 12.16, 12.17, 12.18, 12.21, 12.22_

- [x] 8. Capability matrix and validator (`engine/src/capabilities.ts`)
  - [x] 8.1 Declare the three host capability records
    - Implement `TAURI_DESKTOP_CAPABILITIES`, `BROWSER_CAPABILITIES` (no `sql-query`, no drivers, no connection types) and `CLOUDFLARE_CAPABILITIES` (`postgres` and `mysql` only), each with the five feature flags
    - _Requirements: 17.1, 17.2, 17.3_

  - [x] 8.2 Implement `validateAgainstCapabilities`
    - Walk the top-level graph then each embedded sub-workflow in ascending key order, applying node-kind, SQL driver, connection inventory, expression compilation and `tool-link` rules in a fixed per-node order
    - Return `CapabilityFinding[]` with `error`/`warning` severities, never throw on a malformed node, and collect the declared egress host list with a warning for non-static urls
    - _Requirements: 17.4, 17.5, 17.6, 17.7, 17.13, 17.14_

  - [x] 8.3 Write property test for capability validation soundness and determinism
    - **Property 11: Capability validation is sound across nested workflows (claims 51, 52, 53, 54)**
    - **Validates: Requirements 1.4, 17.4, 17.5, 17.6**

  - [x] 8.4 Write unit tests for finding messages and egress collection
    - Unsupported kind, unsupported driver, unknown connection, missing secrets, failing expression, non-static url warning
    - _Requirements: 17.13, 17.14, 17.15_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Pure data node executors (`engine/src/data-nodes.ts`)
  - [x] 10.1 Implement `runTransform` and `castValue`
    - Compile all field expressions before projecting, honour `itemsPath`/`mode`, the 200-field and 100000-element bounds, `default` then `cast` then `required` ordering, dotted `target` writes, `passthrough` merge order and `resultKey` wrapping
    - Expose the executor as `(node, payload, ctx) => Promise<string>` so it reads no graph topology, and never mutate the incoming payload; keep output byte-identical for identical inputs
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14_

  - [x] 10.2 Write property test for transform shape preservation and non-mutation
    - **Property 2: Transform preserves shape and never mutates its input (claims 7, 8, 9, 10)**
    - **Validates: Requirements 5.3, 5.8, 5.9, 5.13, 5.14**

  - [x] 10.3 Implement `runAggregate` for `group`, `join` and `pivot`
    - Insertion-ordered grouping by `by` tuple with the eight metric functions, non-numeric exclusion, `null` for empty `avg`/`min`/`max`, `countIf` predicate evaluation, inner and left joins with `collisionPrefix` merging, and pivot key construction with `fillValue` and duplicate-key rejection
    - Validate specs, uniqueness of metric names and array/size preconditions before accumulating any row
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.11, 6.12, 6.13_

  - [x] 10.4 Write property test for aggregate conservation and permutation invariance
    - **Property 3: Aggregation conserves counts and sums (claims 11, 12, 13, 17)**
    - **Validates: Requirements 6.1, 6.2, 6.10**

  - [x] 10.5 Write property test for join cardinality and pivot round trip
    - **Property 3: Aggregation conserves counts and sums (claims 14, 15, 16)**
    - **Validates: Requirements 6.6, 6.7, 6.8, 6.9**

  - [x] 10.6 Implement `batchItems`
    - Return the source list unchanged for an absent, non-integer or out-of-range `batchSize`, otherwise emit `ceil(n/batchSize)` batches whose concatenation equals the source list
    - _Requirements: 9.8, 9.9, 9.10_

  - [x] 10.7 Write property test for lossless batching
    - **Property 4: Batching is a lossless regrouping (claims 18, 19, 20)**
    - **Validates: Requirements 9.8, 9.9, 9.10**

- [x] 11. Run events and sync audit record
  - [x] 11.1 Add the eleven new run event types
    - Extend `RunEventPayload` in `engine/src/events.ts` with `http-request`, `http-response`, `page-fetched`, `sql-query`, `sql-result`, `state-read`, `state-written`, `assert-passed`, `assert-breached`, `notify-sent` and `sync-summary`, carrying metadata only and reusing `node-retrying` for data-node retries
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 11.2 Implement `SyncSummary` accumulation and the recorder branch
    - Add `SyncSummary` and `RunRecordSummary.sync` to `engine/src/run-record.ts`, implement `accumulateSync`, emit exactly one `sync-summary` immediately before the terminal event only when a data node executed, and attach it in `createRunRecorder`
    - _Requirements: 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11_

  - [x] 11.3 Write unit tests for sync summary invariants
    - `considered = changed + skipped` after the delta stage, `written + failed <= considered`, absent `sync` for agent-only runs, status counting
    - _Requirements: 14.6, 14.8, 14.10, 14.11_

- [x] 12. HTTP request node and shared retry wiring
  - [x] 12.1 Implement request construction in `engine/src/data-http.ts`
    - Implement `buildDataRequest` (template interpolation via `interpolatePayload`, single-slash base-url joining, exactly-once query encoding, JSON body validation before any I/O, `Idempotency-Key` trimming and the 255-character cap), `applyConnectionAuth` for every auth mode, and `selectResult` with `resultPath`/`resultKey` merge semantics
    - Apply connection auth after user headers so auth always wins, and register resolved secrets with the Redactor before constructing a request
    - _Requirements: 2.13, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.13, 8.14, 8.15, 8.22_

  - [x] 12.2 Write property test for host-applied auth precedence and request construction
    - **Property 8: Host-applied auth always wins and secrets never enter the spec (claims 40, 41, 42, 43, 44)**
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7**

  - [x] 12.3 Implement pagination advance and accumulation
    - Implement `nextCursorFrom` for `cursor`, `page`, `offset` and `link-header`, `initialCursor`, `maxPages` resolution (1-1000, default 100), item accumulation at `itemsPath`, non-advancing-cursor termination and the `page-fetched` payload shape
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.12, 9.13, 9.14_

  - [x] 12.4 Write property test for paginated fetch termination and item conservation
    - **Property 9: Paginated fetch terminates and conserves items (claims 45, 46, 47)**
    - **Validates: Requirements 9.2, 9.3, 9.5, 9.14**

  - [x] 12.5 Implement fixture identity and record/replay (`engine/src/fixtures.ts`)
    - Implement `fixtureKey` from workflow id, `fx:` namespace, node id, payload hash, occurrence index and request fingerprint, with HTTP and SQL fingerprints that exclude header values
    - Implement the four fixture modes, the `replayed` marker with `durationMs: 0`, the missing-fixture failure, the absent-store failure for `replay`, and the warning path for a failed or oversized write
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.11, 16.12_

  - [x] 12.6 Implement `withNodeRetry` in `engine/src/engine.ts`
    - Wrap `http-request`, `sql-query` and `notify` bodies with the normalised policy, `decideRetry`, exactly one `node-retrying` event per scheduled retry with a redacted error description, and `gate.sleep` for the delay so Stop and Pause still win
    - _Requirements: 11.1, 11.10, 11.11, 11.12, 11.13_

  - [x] 12.7 Write property test for stop-wins retry cancellation
    - **Property 5: Retry is bounded and never repeats an unsafe write (claim 25)**
    - **Validates: Requirements 11.12**

  - [x] 12.8 Implement `runHttpRequest` in `engine/src/engine.ts`
    - Add the `http-request` case: capability and connection guards, fixture short-circuit, the paginated fetch loop, success-code classification, `HttpStatusError` on failure, `responseMode` parsing, `timeoutSec` resolution, the `http-request`/`http-response` events with opt-in bodies, journal recording and `errorPortId` routing
    - _Requirements: 1.5, 1.6, 1.8, 8.1, 8.9, 8.10, 8.11, 8.12, 8.19, 8.20, 8.21, 18.2, 18.8_

  - [x] 12.9 Wire the idempotency claim into the http-request write path
    - Claim the rendered `idempotencyKey` through `claimIdempotent` under the `idem:` namespace before the outbound call when `RunOptions.state` is present, skip the call and increment `Sync_Summary.skipped` by exactly one on a lost claim, and write no delta hash for that record
    - Keep journal replay ahead of the claim so a resumed run never re-claims a completed write
    - _Requirements: 8.8, 12.3, 12.14_

  - [x] 12.10 Write unit tests for the http-request executor
    - Scripted `DataFetcher` covering 2xx, `successCodes`, 429 with `Retry-After`, transport failure kinds, truncation, all five pagination modes, each fixture mode and a lost idempotency claim
    - _Requirements: 8.11, 8.12, 8.18, 9.13, 12.14, 16.5, 16.7, 16.8_

- [x] 13. SQL query node
  - [x] 13.1 Implement statement analysis (`engine/src/sql-statement.ts`)
    - Implement `extractNamedParameters` ignoring `:name` inside string literals and comments, `{{`-token and empty-statement rejection, `isWriteStatement` classification after comment stripping, and the three-tier limit resolution for `maxRows`, `maxResultBytes` and `statementTimeoutMs`
    - _Requirements: 10.1, 10.2, 10.3, 10.7, 10.10_

  - [x] 13.2 Implement `runSqlQuery` in `engine/src/engine.ts`
    - Add the `sql-query` case: driver resolution and `SqlHost.supports` gate, `allowWrites` guard, parameter expression evaluation to scalars, the `sql-query` and `sql-result` events excluding parameter values, the `resultKey`/`rowCount`/`truncated` payload, timeout and rejection failures
    - _Requirements: 2.10, 10.4, 10.5, 10.6, 10.8, 10.9, 10.11, 10.12, 10.13, 10.14, 10.15, 18.9, 18.10_

  - [x] 13.3 Write unit tests for parameter binding and write classification
    - A payload containing `'; DROP TABLE` binds as a value and never as SQL; mismatched declared and extracted names; each read-only leading keyword; multi-statement input classified as a write
    - _Requirements: 10.1, 10.3, 10.4, 10.7, 10.13_

- [x] 14. Assert, state, notify and batched loop nodes
  - [x] 14.1 Implement `runAssert` in `engine/src/engine.ts`
    - Evaluate all 1-50 assertions in declaration order with no short-circuit, read the interpolated `baselineStateKey` once and expose `baseline`, emit `assert-passed`/`assert-breached`, append every assertion to `Sync_Summary.guards`, and route or fail per `onBreach` and `failedPortId` wiring
    - Reject an empty, duplicated, over-long or uncompilable assertion before evaluating any assertion; read no ambient clock and no random source; fail the node when a `baselineStateKey` is set and `RunOptions.state` is absent
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 18.8_

  - [x] 14.2 Write property test for guard pass-through and breach containment
    - **Property 10: A breached guard stops the write path (claims 48, 49, 50)**
    - **Validates: Requirements 7.1, 7.2, 7.4**

  - [x] 14.3 Implement `runStateGet` and `runStateSet` in `engine/src/engine.ts`
    - Scope keys with `scopedStateKey`, emit `state-read` and `state-written`, merge under `resultKey` with JSON-or-text parsing, and implement `value`, `delta` and `watermark` semantics with the `changed` flag and TTL handling
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 12.8, 12.9_

  - [x] 14.4 Implement `runNotify` in `engine/src/engine.ts`
    - Interpolate `to`/`subject`/`body` with `{{input}}` as the body default, deliver every channel through `DataFetcher` with a 30 second per-attempt timeout, raise `HttpStatusError` outside 2xx, emit `notify-sent` with a redacted target and no subject or body, and return the payload unchanged
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 13.9_

  - [x] 14.5 Wire batch mode into `runForEach`
    - Materialise iteration items through `batchItems`, report the batch count as `loop-started.total` and the batch array as `loop-iteration.item`
    - _Requirements: 9.8, 9.9, 9.11_

  - [x] 14.6 Write unit tests for the assert, state and notify executors
    - Warn-severity breaches, route-without-wiring fallback, absent-state failures, delta and watermark change decisions, notify channel validation
    - _Requirements: 7.6, 7.7, 12.4, 12.6, 12.8, 13.9_

- [x] 15. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Desktop (Tauri) host drivers
  - [x] 16.1 Add the `conn:` keychain namespace
    - Add `CONNECTION_SECRET_PREFIX` and extend `validate_secret_key` in `backend/src-tauri/src/llm.rs` so only `mcp:` and `conn:` keys are accepted, reusing the existing chunked `store_secret_value`/`clear_secret_value` path
    - _Requirements: 3.1, 3.2, 3.9_

  - [x] 16.2 Implement the Rust `data_request` command
    - Add `backend/src-tauri/src/data.rs` with a reqwest-backed command that resolves connection secrets in Rust, applies auth, enforces the response-byte cap and request timeout, returns lower-cased headers including `retry-after` and `link`, maps transport failures to the six failure kinds, and excludes secrets from every result and error crossing IPC; register it in `lib.rs`
    - _Requirements: 3.3, 8.16, 8.17, 8.18, 8.20_

  - [x] 16.3 Implement the Rust `sql_query` command per driver family
    - Add `backend/src-tauri/src/sql.rs` with parameter-bound execution for `postgres`, `mysql`, `mssql` and `sqlite`, applying the resolved row, byte and timeout limits with truncation reporting; add the driver crates to `backend/src-tauri/Cargo.toml` and register the command in `lib.rs`
    - _Requirements: 10.10, 10.11, 10.14, 18.3_

  - [x] 16.4 Write Rust unit tests for the desktop drivers
    - Keychain prefix rejection, chunked round trip of a long secret, per-driver binding of a payload containing `'; DROP TABLE` as a value, secret absence from command results and error strings
    - _Requirements: 3.2, 3.3, 3.9, 10.4_

  - [x] 16.5 Add the IndexedDB `connections` and `workflow-state` stores
    - Bump `DB_VERSION` 8 → 9 in `frontend/src/app/core/indexed-db-storage.service.ts`, add the `connections` store (keyPath `id`, no workflow index) and the `workflow-state` store (keyPath `key`, `by-workflow` index) with TTL expiry, the value and total-byte caps, prune-oldest eviction and transactional `compareAndSet`
    - _Requirements: 3.4, 12.1, 12.16, 12.17, 12.18, 12.19, 12.20, 12.21, 12.22_

  - [x] 16.6 Implement the desktop host adapters
    - Add `frontend/src/app/core/connection-store.service.ts` (keychain-backed `ConnectionStore` with single-flight OAuth refresh and complete-or-reject bundles), `data-fetch.service.ts`, `sql-host.service.ts`, `workflow-state.service.ts` and `fixture-store.service.ts`
    - Keep fixtures in the `fx:` namespace of the workflow-state store, out of the persisted spec and run history, and outside the run retention limits
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.12, 16.10, 18.3_

  - [x] 16.7 Wire the new capabilities into the local run path
    - Extend the `startRun` call in `frontend/src/app/core/run-controller.service.ts` with `workflowId`, `connections`, `dataFetch`, `sql`, `state`, `fixtures`, `redact` and `capabilities`, apply the Redactor in the persistence path only, honour `retention.noPersistNodeIds`/`keepRuns`/`maxAgeDays`, and deliver workflow-level notifications from the run event stream
    - _Requirements: 13.7, 13.10, 15.10, 15.11, 15.12, 15.13, 18.1, 18.2, 18.3_

  - [x] 16.8 Write unit tests for the desktop state store and connection store
    - TTL expiry, list clamping, workflow isolation, concurrent `compareAndSet`, missing-secret rejection with no partial bundle
    - _Requirements: 2.5, 12.13, 12.19, 12.20_

- [x] 17. Browser preview host
  - [x] 17.1 Implement the browser capability set
    - Supply `dataFetch` backed by browser `fetch` with the same caps and failure-kind mapping, a `SqlHost` whose `supports` returns false for every driver, a `ConnectionStore.resolve` that rejects with the desktop-or-worker message, the shared IndexedDB state and `fx:` fixtures, and `BROWSER_CAPABILITIES`
    - _Requirements: 3.8, 18.4_

  - [x] 17.2 Write unit tests for the browser host
    - Connection resolution rejection with no secret read and no outbound request, `supports` false for every driver
    - _Requirements: 3.8, 18.4_

- [x] 18. Cloudflare Worker host
  - [x] 18.1 Add the `workflow_state` table and worker stores
    - Create the table in `WorkflowAgent.ensureTables()` in `cloud/src/workflow-agent.ts` and implement `WorkflowStateStore` and `FixtureStore` over it, with `compareAndSet` as a single conditional SQL statement and no lease
    - Scope fixtures to the workflow identifier under the `fx:` namespace, keep them out of the persisted run history and exempt from the run retention limits
    - _Requirements: 12.1, 12.13, 12.16, 12.17, 12.18, 12.19, 12.20, 12.21, 12.22, 16.10, 18.6_

  - [x] 18.2 Implement `WorkerConnectionStore` (`cloud/src/connections.ts`)
    - Read secrets from `CONN_*` env names, take metadata only from the push route, cache OAuth tokens under `oauth:{connectionId}` with no expiry, serve cached tokens with at least 30 seconds of validity, and reject unknown or undelivered connections; declare the `CONN_*` index signature on `Env`
    - _Requirements: 2.7, 2.12, 3.5, 3.6, 3.7, 3.10, 3.11_

  - [x] 18.3 Implement the worker data and SQL drivers
    - Add `cloud/src/data-host.ts` wrapping `fetch` with `assertPublicHttpUrl`, the response-byte cap, the request timeout and failure-kind mapping; add a `SqlHost` supporting `postgres` and `mysql` only
    - _Requirements: 8.16, 8.17, 8.18, 8.20, 10.5, 18.5_

  - [x] 18.4 Wire the worker run path
    - Pass `connections`, `dataFetch`, `sql`, `state`, `fixtures`, `redact`, `workflowId` and `CLOUDFLARE_CAPABILITIES` into the worker's `startRun`, apply the Redactor before persistence and clipping, apply the retention overrides in place of `RUN_HISTORY_LIMIT`, and deliver workflow notifications from the DO's event stream
    - _Requirements: 13.7, 13.10, 15.10, 15.11, 15.12, 15.13, 18.1, 18.5_

  - [x] 18.5 Write worker tests for state and egress
    - Concurrent `compareAndSet` for the same key resolving exactly one caller true, TTL and pruning behaviour, `assertPublicHttpUrl` still applied on the data path
    - _Requirements: 12.13, 18.5, 18.6_

- [x] 19. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 20. Studio authoring surfaces
  - [x] 20.1 Add the node catalog entries and the Data palette section
    - Add one `NodeCatalogEntry` per data node kind in `frontend/src/app/core/node-catalog.ts` with label, description, icon, at least three keywords, default name, the declared port blueprint and complete `defaultData`; add the optional `section` field and render `Data` between `Flow` and `Tools` in `frontend/src/app/workspace/palette/agents-palette/agents-palette.*`
    - _Requirements: 1.3, 1.7, 19.1_

  - [x] 20.2 Reject `tool-link` edges on data nodes in the canvas validator
    - Reject before the edge is added, leave the graph unchanged and return the explanatory message
    - _Requirements: 1.4_

  - [x] 20.3 Add the data node property controls
    - Extend `frontend/src/app/workspace/properties/properties-form/properties-form.ts|html` with narrowed `computed()` accessors and controls for request configuration, pagination mode, transform fields, aggregate specs, assertions, state keys, notification channel, retry policy and fixture mode, rendering no control belonging only to another kind
    - _Requirements: 19.2_

  - [x] 20.4 Add debounced expression validation to expression fields
    - Call `validateExpression` 300 ms after the last keystroke, show the message and zero-based position while not ok, clear it while ok, and always retain the entered text
    - _Requirements: 19.3_

  - [x] 20.5 Add the connection picker
    - List `ConnectionSummary` values whose type is declared for the active host with name, type and present-secret count, show no secret value, and mark incomplete or unmatched selections unusable while leaving the stored `connectionId` and node editable
    - _Requirements: 2.9, 19.4_

  - [x] 20.6 Build the connection editor
    - Add `frontend/src/app/core/connections.service.ts` and a connection editor component supporting create, rename, delete with referencing-workflow confirmation, and direct secret writes to the host store with no value rendered or persisted in metadata or `WorkflowSpec`; disable secret entry when the host supplies no `ConnectionStore`
    - _Requirements: 2.2, 19.5, 19.6, 19.7, 19.8, 19.9_

  - [x] 20.7 Surface capability findings inline and gate local runs
    - Show findings on the node and in the properties panel within 500 ms of the change, keep editing available, and run the validator against the active host record before `startRun`, blocking the run and creating no run record on any error finding
    - _Requirements: 17.8, 17.9, 17.10, 17.15_

  - [x] 20.8 Write unit tests for the authoring surfaces
    - Catalog completeness per kind, tool-link rejection, expression error display, picker usability marking, connection deletion confirmation, finding rendering
    - _Requirements: 1.4, 19.1, 19.3, 19.4, 19.6, 17.8_

- [x] 21. Push-time and deploy-time validation
  - [x] 21.1 Validate and push connection metadata from `CloudService`
    - Run the validator against `CLOUDFLARE_CAPABILITIES` and the worker connection inventory in `pushWorkflow` after `materializeDefaults` and before the deployment request, abort with every finding on an error, and add the dedicated connection-metadata push route call carrying no secret value
    - _Requirements: 2.2, 3.6, 17.11_

  - [x] 21.2 Validate on the worker deployment route
    - Run the validator in the `POST /workflow` handler in `cloud/src/workflow-agent.ts`, respond 400 with every finding, store nothing and leave any deployed workflow unchanged; accept the deployment when only warnings are returned
    - _Requirements: 17.12, 17.15_

  - [x] 21.3 Write unit tests for push and deploy validation
    - Push aborted on an error finding, push proceeding with warnings only, worker 400 body containing the findings
    - _Requirements: 17.11, 17.12, 17.15_

- [x] 22. Integration and end-to-end determinism
  - [x] 22.1 Build the in-memory host fakes
    - Add `engine/src/test/fake-host.ts` with `FakeConnectionStore`, `FakeDataFetcher` (scripted status, header and body sequences including 429 with `Retry-After`), `FakeSqlHost`, `MemoryFixtureStore` and a throwing `ModelClient`
    - _Requirements: 18.1, 18.2_

  - [x] 22.2 Write property test for model-free execution and replay safety
    - **Property 12: No model in the data path, and replay repeats no side effects (claims 55, 56, 57, 58)**
    - **Validates: Requirements 1.2, 1.5, 1.6, 5.14, 8.19**

  - [x] 22.3 Write integration test for the reference sync graph
    - Drive `startRun` over the §14.1 graph and assert the sync summary counts, the delta-hash-after-write ordering, the guard entries and the batched upsert calls
    - _Requirements: 12.11, 12.12, 12.14, 14.4, 14.7, 14.8_

  - [x] 22.4 Write the fixture replay suite for CI
    - Run the data-node suites with `fixtures: 'replay'` against committed fixtures so no test reaches a real API or database
    - _Requirements: 16.5, 16.6, 16.9, 16.10_

- [x] 23. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- No sub-task is marked `*`: the property, unit and integration tests are treated as required here, because the correctness properties are the acceptance surface for the whole data path.
- Property test sub-tasks name the design property, the claim numbers they cover and the acceptance criteria they validate. Claims 1-58 of the design's twelve properties are each covered by exactly one test sub-task.
- Every acceptance criterion of Requirements 1-19 is referenced by at least one sub-task; no sub-task references a criterion that does not exist.
- Checkpoints sit after the pure primitives, after the engine executors, after the hosts, and at the end.
- P1-14 connector packaging and Phase 2 AWS host work are deliberately absent.
- `engine/` gains no runtime dependency; only `vitest` and `fast-check` as dev dependencies.
- The dependency graph below schedules the remaining incomplete sub-tasks only; already-completed sub-tasks are omitted. Sub-tasks that write the same file (`engine/src/engine.ts`, `cloud/src/workflow-agent.ts`, `properties-form.*`, `run-controller.service.ts`) are kept in separate waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["13.3", "14.1", "16.3", "18.1", "20.1"] },
    { "id": 1, "tasks": ["14.2", "14.3", "16.4", "18.2", "20.2"] },
    { "id": 2, "tasks": ["14.4", "16.5", "18.3", "20.3"] },
    { "id": 3, "tasks": ["14.5", "16.6", "18.4", "20.4"] },
    { "id": 4, "tasks": ["14.6", "16.7", "17.1", "18.5", "20.5"] },
    { "id": 5, "tasks": ["16.8", "17.2", "20.6", "21.1", "22.1"] },
    { "id": 6, "tasks": ["20.7", "21.2", "22.2"] },
    { "id": 7, "tasks": ["20.8", "21.3", "22.3", "22.4"] }
  ]
}
```
