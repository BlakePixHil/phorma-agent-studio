# Requirements Document

## Introduction

Phase 1 of the deterministic data path adds eight flow-node kinds (`http-request`, `sql-query`,
`transform`, `aggregate`, `assert`, `state-get`, `state-set`, `notify`), a first-class `Connection`
credential entity stored outside the workflow spec, an engine-native expression evaluator, durable
workflow state, fixture-based record/replay, payload redaction, and a per-host capability matrix with
push-time validation.

The goal is a scheduled workflow that reads from an HTTP or SQL source, reshapes and aggregates the
result, guards the result, and writes the result to a target system with no language model anywhere in
the data path. Every new capability is supplied to the engine as an optional interface on `RunOptions`,
so the engine stays dependency-free and each host (Tauri desktop, browser preview, Cloudflare Worker)
provides the drivers it can honestly support.

These requirements are derived from `design.md` in the same spec directory.

### Out of Scope

- **P1-14 connector packaging.** Deliberately deferred until the capabilities below exist.
- **Phase 2 AWS host.** No AWS host implementation, IaC tool, DynamoDB persistence, or multi-tenancy
  work is covered here. The only Phase 2 accommodation is the shape of
  `WorkflowStateStore.compareAndSet`.
- **Data nodes as agent tools.** Data nodes are flow steps in Phase 1; the port model keeps a later
  `tools`-role port possible without changing executor semantics.

## Glossary

- **Studio**: The Phorma Agent Studio frontend, including the canvas, node palette and properties panel.
- **Engine**: The host-independent workflow executor in `engine/`, entered through `startRun`.
- **Data_Node**: A node whose kind is one of the eight Phase 1 kinds listed in the Introduction.
- **Data_IO_Node**: A Data_Node that reaches outside the run: `http-request`, `sql-query`, `notify`.
- **Host**: A runtime that supplies capabilities to the Engine through `RunOptions`. The three hosts are
  Desktop_Host (Tauri), Browser_Host (browser preview) and Worker_Host (Cloudflare Worker).
- **Connection**: A named, typed credential bundle stored outside `WorkflowSpec`, referenced from node
  data by `connectionId` only.
- **ResolvedConnection**: A Connection with its secret values resolved by a Host at execution time.
- **ConnectionStore**: The Host capability that resolves a `connectionId` to a ResolvedConnection.
- **DataFetcher**: The Host capability that performs outbound HTTP for Data_Nodes.
- **SqlHost**: The Host capability that executes parameterised SQL statements per driver family.
- **WorkflowStateStore**: The Host capability providing a durable key/value store scoped by workflow.
- **FixtureStore**: The Host capability that reads and writes recorded Data_IO_Node responses.
- **Expression_Evaluator**: The engine-native expression module (`engine/src/expr.ts`) comprising
  `compileExpression`, `validateExpression` and `printExpression`.
- **Retry_Classifier**: The pure retry-decision module (`engine/src/retry.ts`), comprising
  `decideRetry`, `parseRetryAfter` and `backoffFor`.
- **Redactor**: The persistence-facing redaction pipeline (`engine/src/redact.ts`).
- **Capability_Validator**: The pure function `validateAgainstCapabilities` in `engine/src/capabilities.ts`.
- **HostCapabilities**: The declared capability record for one Host (node kinds, SQL drivers, connection
  types, feature flags).
- **Run_Recorder**: `createRunRecorder` in `engine/src/run-record.ts`, which accumulates a run summary.
- **Sync_Summary**: The per-run structured data-sync audit record attached to `RunRecordSummary.sync`.
- **Push_Service**: `CloudService.pushWorkflow` in the Studio, which deploys a workflow to Worker_Host.
- **Canvas_Validator**: The Studio connection validator that accepts or rejects a proposed edge.
- **Properties_Panel**: The Studio node configuration surface.
- **Transient_Failure**: An error the Retry_Classifier classifies as retryable: a retryable HTTP status
  (408, 425, 429, 500, 502, 503, 504) or a `DataTransportError`.

## Requirements

### Requirement 1: Deterministic node kinds and port model

**User Story:** As a workflow author, I want data steps that execute in the graph walk instead of being
chosen by an agent, so that a scheduled sync produces the same result on every run.

#### Acceptance Criteria

1. THE Studio SHALL define exactly the eight node kinds `http-request`, `sql-query`, `transform`,
   `aggregate`, `assert`, `state-get`, `state-set` and `notify`, each with `category` set to `flow` and
   each declaring ports of the roles `message-in` and `message-out` only.
2. WHEN a Data_Node executes, THE Engine SHALL make zero calls to `RunOptions.model` and SHALL produce
   the same node result whether `RunOptions.model` is supplied or absent.
3. THE Studio SHALL declare for every Data_Node kind exactly one `message-in` port named `In`, plus the
   following `message-out` ports: `http-request` with `Response` and `On error`; `sql-query` with `Rows`
   and `On error`; `transform`, `aggregate`, `state-get` and `state-set` with `Out`; `assert` with
   `Passed` and `Failed`; `notify` with `Sent` and `On error`.
4. WHEN a user proposes a `tool-link` edge whose source or target endpoint is a Data_Node, THE
   Canvas_Validator SHALL reject the edge before it is added to the graph, SHALL leave the graph
   unchanged, and SHALL return a validation message stating that data nodes cannot be attached to an
   agent as a tool.
5. THE Engine SHALL expose each Data_Node executor as a function of the node, the incoming payload and
   the run context only, and SHALL return the same result for identical node data, payload and run
   context regardless of which edges are connected to that node.
6. WHERE a Data_Node declares an `errorPortId` naming a `message-out` port of that node that is wired to
   at least one edge, WHEN that node fails, THE Engine SHALL route the failure through that port using
   the existing `errorRoutePortId` mechanism and SHALL continue the run.
7. THE Studio SHALL group all eight Data_Node palette entries under a single `Data` section rendered
   between the `Flow` and `Tools` sections, and SHALL render every Data_Node in the palette and on the
   canvas with the accent colour assigned to the `flow` category.
8. IF a Data_Node fails and the node declares no `errorPortId`, or the declared `errorPortId` names a
   port that is not `message-out` or is wired to no edge, THEN THE Engine SHALL fail the run with an
   error naming the failing node and SHALL execute no node reachable only through that node's outputs.

### Requirement 2: Connections as a credential entity

**User Story:** As an operator, I want credentials stored as named connections outside the workflow, so
that exporting, diffing, versioning and pushing a workflow never moves a secret.

#### Acceptance Criteria

1. THE Engine SHALL define a `Connection` record containing `id` matching
   `^conn-[A-Za-z0-9_-]{1,64}$`, a `name` of 1 to 100 characters, a `type` that is exactly one of
   `http`, `oauth2`, `sql`, `aws-sigv4` or `smtp`, non-secret `config`, 0 to 32 unique names in
   `secretKeys`, an `auth` descriptor, an `allowWrites` flag treated as false when absent, optional
   SQL `limits`, and `createdAt` and `updatedAt` as ISO-8601 UTC timestamps.
2. THE Studio SHALL store a Connection outside `WorkflowSpec`, SHALL persist `connectionId` as the
   only Connection reference in node data, and SHALL produce workflow exports, version snapshots and
   push payloads of `WorkflowSpec` that contain no `Connection` record and no secret value.
3. WHEN a Data_IO_Node executes with a `connectionId`, THE ConnectionStore SHALL resolve the
   Connection with every value named in `secretKeys` present in `secrets`, and SHALL either resolve a
   complete bundle or reject, never resolving a bundle holding a subset of the `secretKeys` names.
4. IF a `connectionId` is unknown to the ConnectionStore, THEN THE ConnectionStore SHALL reject the
   resolution with a message naming the requested `connectionId`, SHALL read no secret value, and THE
   Engine SHALL send no outbound request for that node.
5. IF a value named in `secretKeys` is absent from the Host secret store, THEN THE ConnectionStore
   SHALL reject the resolution with a message naming the Connection and the first missing secret key,
   SHALL discard every secret value already read, and THE Engine SHALL send no outbound request for
   that node.
6. THE ConnectionStore SHALL return a ResolvedConnection whose `secrets` and `config` maps are frozen,
   so that a caller's attempt to add, replace or delete an entry leaves both maps unchanged.
7. WHERE `auth.mode` is `oauth2-client-credentials` or `oauth2-refresh`, THE ConnectionStore SHALL
   supply in `secrets` an access token whose remaining validity is at least 30 seconds, and SHALL
   serve every resolution of the same Connection arriving while a refresh is in flight from that
   single refresh.
8. THE Engine SHALL exclude every ResolvedConnection secret value, in whole and as a substring, from
   run events, journal entries, run records, exports and version snapshots.
9. THE Engine SHALL expose a `ConnectionSummary` projection carrying the `secretKeys` names, the count
   of those names present in the Host secret store, and no secret value, for use by the
   Properties_Panel and the Capability_Validator.
10. WHERE a `sql-query` statement is classified as a write, THE Engine SHALL execute the statement only
    when the referenced Connection has `allowWrites` set to true, and SHALL treat an absent
    `allowWrites` as false.
11. IF a `connectionId` is empty or does not match `^conn-[A-Za-z0-9_-]{1,64}$`, THEN THE
    ConnectionStore SHALL reject the resolution with a message naming the rejected value and SHALL
    read no secret value.
12. IF acquiring or refreshing an OAuth access token fails, or yields a token whose remaining validity
    is under 30 seconds, THEN THE ConnectionStore SHALL reject the resolution with a message naming
    the Connection and the `auth.mode`, SHALL retain no partial bundle, and THE Engine SHALL send no
    outbound request for that node.
13. WHEN the ConnectionStore resolves a Connection, THE Engine SHALL register every value in `secrets`
    with the Redactor before the requesting node constructs any outbound request.

### Requirement 3: Per-host secret storage

**User Story:** As an operator, I want each host to hold connection secrets in the strongest store that
host offers, so that local runs and deployed runs are both safe without a second credential system.

#### Acceptance Criteria

1. THE Desktop_Host SHALL store each connection secret in the existing keychain service under an entry
   name of the form `conn:{connectionId}:{secretKey}`, alongside the existing `mcp:` prefixed entries,
   and SHALL store a value of up to 1000 characters as a single entry and a longer value as chunks of
   at most 1000 characters that a read reassembles into the identical value.
2. THE Desktop_Host SHALL accept a secret key for storage only when the key starts with `mcp:` or
   `conn:`.
3. THE Desktop_Host SHALL resolve connection secrets and apply them to the outbound request inside the
   Rust `data_request` and `sql_query` commands, and SHALL exclude every secret value, in whole and as
   a substring, from every value crossing the IPC boundary to the webview, including command results
   and error messages.
4. THE Desktop_Host SHALL store Connection metadata in a dedicated IndexedDB `connections` store keyed
   by the Connection `id`, holding the `secretKeys` names and no secret value, and SHALL scope no
   entry of that store to a workflow so that every stored Connection is readable from every workflow.
5. THE Worker_Host SHALL read each connection secret from the worker environment variable named by
   `workerSecretName(connectionId, secretKey)`, which prefixes the name with `CONN_`, replaces every
   character outside `A-Z`, `a-z` and `0-9` with `_`, and uppercases the result, so that every
   produced name matches `^[A-Z][A-Z0-9_]*$`.
6. THE Worker_Host SHALL obtain Connection metadata only from the payload of the dedicated push route,
   and SHALL read no Connection metadata and no secret value from Studio browser storage.
7. WHEN the Worker_Host refreshes an OAuth access token, THE Worker_Host SHALL write that token and
   its expiry timestamp to the WorkflowStateStore under the key `oauth:{connectionId}` with no expiry
   applied to the entry, and SHALL write no refreshed token to a deploy-time worker secret.
8. IF a workflow running on Browser_Host resolves a `connectionId`, THEN THE ConnectionStore SHALL
   reject the resolution with a message stating that connections require the desktop application or a
   deployed worker, SHALL read no secret value, and THE Engine SHALL send no outbound request for that
   node.
9. IF a secret key presented to the Desktop_Host keychain service starts with neither `mcp:` nor
   `conn:`, THEN THE Desktop_Host SHALL reject the operation with a message naming both accepted
   prefixes, and SHALL create, replace and delete no keychain entry.
10. WHILE a cached `oauth:{connectionId}` token holds at least 30 seconds of remaining validity, THE
    Worker_Host SHALL serve each resolution of that Connection from the cached token and SHALL request
    no new token.
11. IF the Connection metadata for a requested `connectionId` was not delivered by the push route,
    THEN THE Worker_Host SHALL reject the resolution with a message naming the requested
    `connectionId` and SHALL read no worker environment variable for that Connection.

### Requirement 4: Engine-native expression evaluation

**User Story:** As a workflow author, I want one expression language that behaves identically on every
host, so that a transform tested on the desktop produces the same value in the cloud.

#### Acceptance Criteria

1. THE Expression_Evaluator SHALL implement the grammar defined in the design with no runtime
   dependencies, SHALL be the only evaluation surface used by `transform`, `aggregate` metric
   predicates, `assert`, `state-set` value expressions and `sql-query` parameters, and SHALL read no
   value outside the supplied `EvalContext` and the fixed function table, so that the same source and
   the same `EvalContext` produce the same result on Desktop_Host, Browser_Host and Worker_Host.
2. WHEN `compileExpression` receives a source string of 1 to 4096 characters that conforms to the
   grammar, THE Expression_Evaluator SHALL return a `CompiledExpression` exposing `source` holding the
   unmodified input string, `references` listing every distinct path read from `$` in first-occurrence
   source order with duplicates removed, and `evaluate`.
3. IF a source string is empty, exceeds 4096 characters, contains a syntax error, names an unknown
   identifier or an unknown function, or supplies an argument count outside the arity declared for
   that function in `EXPR_FUNCTIONS`, THEN THE Expression_Evaluator SHALL throw an `ExpressionError`
   carrying the source and a zero-based character position, and SHALL return no `CompiledExpression`.
4. WHEN `evaluate` is called with any `EvalContext`, THE Expression_Evaluator SHALL return a value
   inside the JSON domain of null, boolean, number, string, array or object, and SHALL throw no error
   of any type other than `ExpressionError`.
5. WHEN an expression reads a path absent from the context, or reads `$` or any path below `$` while
   `EvalContext.$` is undefined, THE Expression_Evaluator SHALL return `null`.
6. WHEN an arithmetic operator receives an operand that is not a number, or `/` or `%` receives a
   divisor of zero, THE Expression_Evaluator SHALL return `null` and SHALL return no `NaN`,
   `Infinity` or `-Infinity` value.
7. WHEN an ordering comparison receives operands of different JSON types, THE Expression_Evaluator
   SHALL return `false` for both operand orders.
8. WHEN the `+` operator receives one string operand and one non-string operand, THE
   Expression_Evaluator SHALL return `null`.
9. WHEN `==` or `!=` compares two values, THE Expression_Evaluator SHALL compare the values by JSON
   structural equality, treating two objects as equal when they hold the same key set with equal
   values in any key order, and two arrays as equal only when they hold equal values in the same
   order.
10. WHEN the left operand of `&&` evaluates as falsy or the left operand of `||` evaluates as truthy,
    THE Expression_Evaluator SHALL return the short-circuit result without evaluating the right
    operand.
11. THE Expression_Evaluator SHALL return the `EvalContext.nowMs` value from every `now()` call within
    one `evaluate` invocation and SHALL read no ambient clock.
12. THE Expression_Evaluator SHALL leave the supplied `EvalContext` structurally unchanged after
    `evaluate` returns a value and after `evaluate` throws.
13. THE Expression_Evaluator SHALL expose exactly the functions listed in `EXPR_FUNCTIONS` and SHALL
    reject any other function name at compile time.
14. WHEN `map`, `filter`, `sort`, `sum`, `avg`, `distinct` or `countIf` evaluates its second argument,
    THE Expression_Evaluator SHALL evaluate that argument as a sub-expression string with `item` bound
    to the current element and `index` bound to the zero-based position of that element, and SHALL
    restore the enclosing `item` and `index` bindings when the call returns.
15. THE Expression_Evaluator SHALL provide `validateExpression`, which returns a success result for
    exactly those source strings `compileExpression` accepts, returns for every other source string a
    failure result carrying an error message and the same zero-based position `compileExpression`
    reports for that string, and throws no error for any string input.
16. THE Expression_Evaluator SHALL provide `printExpression`, which renders a compiled expression to a
    source string that `compileExpression` accepts and which produces character-identical output on
    every invocation for the same compiled expression.
17. FOR ALL expressions that compile, printing the compiled expression and compiling the printed source
    SHALL produce a structurally equivalent expression that evaluates to the same value for the same
    `EvalContext` (round-trip property).
18. THE Expression_Evaluator SHALL resolve a dotted path from `$` to the same value that
    `resolveJsonPath` in `engine/src/payload.ts` resolves, substituting `null` for an absent value.
19. IF evaluation reaches a recursion depth above 64 or an evaluated node count above 100000, THEN THE
    Expression_Evaluator SHALL stop evaluating, SHALL throw an `ExpressionError` indicating which of
    the two limits was reached, and SHALL return no partial value.
20. IF a function listed in `EXPR_FUNCTIONS` receives an argument of a JSON type it does not accept,
    including a non-array argument where an array is required and a sub-expression argument that is
    not a string or does not compile, THEN THE Expression_Evaluator SHALL return `null` for that call
    and SHALL throw no error.
21. WHEN the `in` operator is evaluated, THE Expression_Evaluator SHALL return `true` where the right
    operand is an array holding an element structurally equal to the left operand, where the right
    operand is an object holding a key equal to the left operand rendered as a string, or where both
    operands are strings and the left operand is a substring of the right operand, and SHALL return
    `false` in every other case.

### Requirement 5: Transform node

**User Story:** As a workflow author, I want to map source fields into target fields with casts and
defaults, so that I can reshape API or query results without writing code.

#### Acceptance Criteria

1. WHEN a `transform` node executes with a `fields` list holding 1 to 200 entries, THE Engine SHALL
   compile every field expression, in `fields` declaration order, before evaluating any expression and
   before projecting any record.
2. IF `fields` is empty, or `fields` holds more than 200 entries, or any field expression fails to
   compile, THEN THE Engine SHALL fail the node before projecting any record with a message naming the
   field `target` and the zero-based character position reported by the Expression_Evaluator, SHALL
   emit no output payload, and SHALL leave the incoming payload structurally unchanged.
3. WHERE `itemsPath` is set or `mode` is `array`, THE Engine SHALL emit one output record per source
   element in source order, SHALL emit an output element count equal to the source element count for
   source arrays of 0 to 100000 elements, and SHALL emit the output array under `resultKey` when
   `resultKey` is set or as a bare array otherwise.
4. IF `mode` is `array`, or `itemsPath` is set while `mode` is absent or `array`, and the resolved
   source value is not an array, THEN THE Engine SHALL fail the node with a message naming
   `itemsPath` and SHALL emit no output payload.
5. IF the resolved source array holds more than 100000 elements, THEN THE Engine SHALL fail the node
   before projecting any record with a message naming the element count and the 100000-element limit.
6. WHERE `mode` is `record` and the resolved source value is not an array, THE Engine SHALL emit
   exactly one output object projected from that source value with `index` bound to 0.
7. WHEN a field expression yields `null` or `undefined`, THE Engine SHALL use the declared `default`
   as the field value when the field declares a `default`, and SHALL use `null` as the field value
   when the field declares no `default`.
8. WHERE a field declares a `cast`, THE Engine SHALL apply the cast after the `default` is applied,
   SHALL apply exactly one of the casts `string`, `number`, `integer`, `boolean` or `date-iso`, SHALL
   truncate toward zero for `integer`, SHALL emit an ISO-8601 UTC timestamp with millisecond
   precision for `date-iso`, and SHALL produce `null` without raising an error when the value cannot
   be cast.
9. IF a field declares `required` as true and the field value is `null` or `undefined` after the
   declared `default` and `cast` are applied, THEN THE Engine SHALL fail the node with a message
   naming the field `target`, SHALL emit no output payload, and SHALL leave the incoming payload
   structurally unchanged.
10. THE Engine SHALL write each field value at the field `target` dotted path, creating one nested
    object per absent intermediate path segment, and SHALL omit the `target` from the output record
    when the field value is `null` and the field does not declare `required` as true.
11. WHERE `passthrough` is true, THE Engine SHALL copy the source element's own top-level fields into
    each output record before writing mapped field values, so that a mapped `target` matching a copied
    field name replaces the copied value.
12. WHERE `passthrough` is false or absent, THE Engine SHALL include only mapped field `target` paths
    in each output record.
13. THE Engine SHALL leave the incoming payload and every object and array reachable from it
    structurally unchanged after a `transform` node completes, including after a node failure.
14. WHEN a `transform` node executes twice with identical node data, identical payload and identical
    `nowMs`, THE Engine SHALL produce a byte-identical output payload string, or an identical failure
    naming the same field `target`, and SHALL read no ambient clock and no random source.

### Requirement 6: Aggregate node

**User Story:** As a workflow author, I want to group, join and pivot records, so that I can compute the
per-entity metrics a target system expects.

#### Acceptance Criteria

1. WHERE `op` is `group`, THE Engine SHALL emit one output row per distinct tuple of the 1 to 10 `by`
   paths, ordered by the first appearance of each tuple in the source rows, comparing tuples by JSON
   structural equality of the resolved values with an absent path resolving to `null`, and SHALL emit
   the row array under `resultKey` when `resultKey` is set or as a bare array otherwise.
2. THE Engine SHALL compute 0 to 50 uniquely named metrics per group, emitting for `count` the number
   of rows in the group, for `countIf` the number of rows in the group whose predicate is truthy, for
   `sum` the total of the numeric values at `path` and `0` when the group holds no numeric value at
   `path`, for `min` and `max` the smallest and the largest numeric value at `path`, for `avg` that
   total divided by the count of numeric values at `path`, for `first` the value at `path` taken from
   the earliest source row in the group, and for `distinct` the count of distinct values at `path`
   compared by JSON structural equality with `null` counted as one distinct value.
3. IF a metric of function `sum`, `avg`, `min` or `max` reads a value at `path` that is absent, `null`,
   a boolean, an object, an array, or a string that does not parse as a finite decimal number, THEN
   THE Engine SHALL exclude that row from that metric and SHALL emit no `NaN` value for that metric.
4. IF a group holds no numeric value at `path` for a metric of function `avg`, `min` or `max`, THEN THE
   Engine SHALL emit `null` for that metric.
5. WHERE a metric of function `countIf` declares `where`, THE Engine SHALL evaluate the predicate
   through the Expression_Evaluator exactly once per row in the group with `item` bound to the row and
   `index` bound to the zero-based source position of that row, and SHALL count the row only when the
   result is none of `false`, `null`, `0` and the empty string.
6. WHERE `op` is `join` and `type` is `inner`, THE Engine SHALL emit one output row per pair of left
   and right rows whose `leftKey` and `rightKey` values are equal by JSON structural equality, ordered
   by left-row source position and then by right-row source position, treating an absent key value as
   `null` so that it matches only another absent or `null` key value, and SHALL emit no output row for
   a left row with no matching right row.
7. WHERE `op` is `join` and `type` is `left`, THE Engine SHALL emit at least one output row for every
   left row, in left-row source order, and SHALL emit for a left row with no matching right row
   exactly one output row holding that left row's own top-level fields only, with no field contributed
   by any right row and no prefixed field name.
8. IF a right-hand row field name is also a field name of the left-hand row it is merged with, THEN THE
   Engine SHALL emit that right-hand value under the field name prefixed with `collisionPrefix`,
   defaulting to `right_`, SHALL leave the left-hand value under the unprefixed name unchanged, and
   SHALL emit every non-colliding right-hand field under its own name.
9. WHERE `op` is `pivot`, THE Engine SHALL emit one flat object whose keys are each grouped row's 1 to
   5 `keyFields` values joined by `separator`, defaulting to `_`, whose value for each such key is
   that grouped row's `valueField` value, whose value for each declared column absent from the grouped
   rows is `fillValue`, defaulting to `null`, and whose key count equals the number of grouped rows
   plus the number of declared columns absent from the grouped rows.
10. THE Engine SHALL produce identical `count`, `countIf`, `sum`, `min`, `max`, `avg` and `distinct`
    results for any permutation of the input rows, and SHALL derive the `first` metric value, the group
    order, the join output order and the pivot key order from source row order only, with no
    locale-dependent sorting.
11. WHEN an `aggregate` node executes twice with identical node data, identical incoming payload and
    identical `nowMs`, THE Engine SHALL emit a byte-identical output payload string or an identical
    failure message, SHALL read no ambient clock and no random source, and SHALL leave the incoming
    payload and every object and array reachable from it structurally unchanged, including after a
    node failure.
12. IF the spec named by `op` is absent, or a metric `name` is declared more than once, or a `countIf`
    metric declares no `where` or a `where` that fails to compile, or `itemsPath`, `join.leftPath`,
    `join.rightPath` or `pivot.rowsPath` resolves to a value that is not an array, or a resolved array
    holds more than 100000 elements, THEN THE Engine SHALL fail the node before accumulating any row
    with a message naming the rejected field and, for a size breach, the element count and the
    100000-element limit, and SHALL emit no output payload.
13. IF two grouped rows produce the same pivot key, THEN THE Engine SHALL fail the node with a message
    naming the duplicated key, SHALL emit no output payload, and SHALL overwrite no already-computed
    pivot value.

### Requirement 7: Assert node

**User Story:** As an operator, I want a guard before the write step, so that a bad source response
cannot overwrite good data in the target system.

#### Acceptance Criteria

1. WHEN an `assert` node executes, THE Engine SHALL evaluate each of the 1 to 50 declared assertions
   exactly once in declaration order with no short-circuit, SHALL treat an assertion as holding when
   its expression result is none of `false`, `null`, `0` and the empty string, and SHALL treat the
   assertion as breached otherwise.
2. WHEN every assertion of severity `error` holds, THE Engine SHALL emit an `assert-passed` event
   carrying the number of assertions evaluated, SHALL return the incoming payload as a byte-identical
   payload string, and SHALL route through the `Passed` port only.
3. WHEN an assertion is breached, THE Engine SHALL emit exactly one `assert-breached` event for that
   assertion, in declaration order, naming the assertion, carrying its declared message or its
   expression source when no message is declared, carrying its severity defaulted to `error` when
   absent, and carrying whether the breach is routed.
4. IF at least one assertion of severity `error` is breached and `onBreach` is `fail` or absent, THEN
   THE Engine SHALL evaluate every remaining assertion and then fail the node with a message naming
   the earliest-declared breached assertion of severity `error` together with that assertion's
   message, or its expression source when no message is declared, SHALL emit no output payload, and
   SHALL route through no `message-out` port.
5. IF at least one assertion of severity `error` is breached, `onBreach` is `route`, and
   `failedPortId` names a `message-out` port of that node wired to at least one edge, THEN THE Engine
   SHALL route exactly once through that port only a payload holding the names of the breached
   assertions of severity `error` in declaration order together with the unchanged incoming payload,
   and SHALL not fail the node.
6. IF at least one assertion of severity `error` is breached and `onBreach` is `route` while
   `failedPortId` is absent, names a port that is not `message-out`, or names a port wired to no edge,
   THEN THE Engine SHALL fail the node as specified in criterion 4 and SHALL route through no
   `message-out` port.
7. WHEN an assertion of severity `warn` is breached while every assertion of severity `error` holds,
   THE Engine SHALL neither fail the node nor route through the `Failed` port, and SHALL route through
   the `Passed` port only, returning the incoming payload as a byte-identical payload string.
8. WHERE `baselineStateKey` is set, THE Engine SHALL interpolate the key template against the incoming
   payload, SHALL read that workflow-scoped key from the WorkflowStateStore exactly once before
   evaluating any assertion, SHALL expose the JSON-parsed stored value to assertion expressions as
   `baseline`, and SHALL expose `null` as `baseline` when the key holds no value or the stored value
   does not parse as JSON.
9. THE Engine SHALL append to `Sync_Summary.guards` exactly one entry per evaluated assertion, in
   declaration order, carrying the assertion name, its pass state, and its declared message when one
   is declared, for both holding and breached assertions and for both the fail and route breach
   outcomes.
10. IF the `assertions` list is empty, or an assertion `name` is empty, longer than 100 characters or
    declared more than once, or an assertion `expression` fails to compile, THEN THE Engine SHALL fail
    the node before evaluating any assertion with a message naming the rejected assertion or field,
    SHALL emit no output payload, and SHALL append no entry to `Sync_Summary.guards`.
11. WHEN an `assert` node executes twice with identical node data, identical incoming payload and an
    identical baseline value, THE Engine SHALL reach the identical routing decision and SHALL emit a
    byte-identical output payload string or an identical failure message, SHALL read no ambient clock
    and no random source, and SHALL leave the incoming payload and every object and array reachable
    from it structurally unchanged, including after a node failure.

### Requirement 8: HTTP request node

**User Story:** As a workflow author, I want to call an HTTP API as a deterministic step, so that reads
and writes happen in the graph walk instead of at a model's discretion.

#### Acceptance Criteria

1. IF `RunOptions.dataFetch` is absent when an `http-request` node executes, THEN THE Engine SHALL fail
   the node before issuing any outbound request, with a message naming the Host and the missing
   capability, and SHALL leave the incoming payload unchanged.
2. WHEN an `http-request` node executes, THE Engine SHALL interpolate every `{{path}}` token in the
   url, query values, header values, body template and idempotency key using the existing
   `interpolatePayload` function, and SHALL leave a token whose path does not resolve verbatim in the
   rendered text.
3. WHEN `url` is relative and the ResolvedConnection supplies an absolute http or https
   `config.baseUrl`, THE Engine SHALL join the two values with exactly one `/` between them,
   collapsing a trailing `/` on the base and a leading `/` on the path into that single separator, and
   SHALL produce an absolute http or https URL.
4. THE Engine SHALL percent-encode each query key and each query value exactly once, SHALL leave an
   already-encoded percent sequence unchanged, and SHALL emit query entries in their configured order,
   so that identical node data and payload always produce a byte-identical query string.
5. THE Engine SHALL apply Connection authentication after user headers, so that when a user header and
   the Connection auth target the same header name the outbound request carries the Connection value
   and does not carry the user value.
6. THE Engine SHALL derive every authentication credential in an outbound request only from the
   ResolvedConnection, and SHALL construct no request whose authentication header or authentication
   query parameter value originates from node `headers`, `query`, `url` or `body` data.
7. IF `bodyMode` is `json` and the rendered body does not parse as JSON, THEN THE Engine SHALL fail the
   node before calling `DataFetcher`, with a message indicating that the body template did not render
   valid JSON, and SHALL make no attempt and no retry for that node.
8. WHERE `idempotencyKey` renders to a string that is non-empty after trimming surrounding whitespace
   and is at most 255 characters long, THE Engine SHALL set the `Idempotency-Key` request header to
   that trimmed value and SHALL send the identical value on every retry attempt of that node
   execution.
9. THE Engine SHALL emit exactly one `http-request` event per attempt and exactly one `http-response`
   event per received response, carrying method, url, attempt number counted from 1, status, duration
   in milliseconds measured from attempt dispatch to response completion, response byte count and
   truncation state.
10. THE Engine SHALL include a request or response body in an emitted event only when the node sets
    `persistRequestBody` or `persistResponseBody` respectively and the Redactor has processed that
    body, and SHALL otherwise omit the body from the event.
11. THE Engine SHALL treat a response status in 200-299 as successful, and SHALL additionally treat as
    successful any of the at most 20 statuses listed in `successCodes`, ignoring any listed value that
    is not an integer in the range 100 to 599.
12. IF the response status is outside the success set, THEN THE Engine SHALL raise an
    `HttpStatusError` carrying the status, the headers and a body preview capped at the first 512
    characters, and SHALL merge no part of that response into the payload, so that the retry policy of
    Requirement 11 and the `On error` port routing of Requirement 1 apply.
13. WHERE `resultPath` is set, THE Engine SHALL select the value at that path from the parsed response
    and SHALL treat a resolved value of `null` as a present value.
14. IF `resultPath` is set and the path resolves to no value in the parsed response, THEN THE Engine
    SHALL fail the node with a message naming the path, and SHALL emit no outgoing payload for that
    node.
15. WHERE `resultKey` is set and the incoming payload parses as a JSON object, THE Engine SHALL
    shallow-merge the selected result under that key, preserving every other top-level field and
    replacing only an existing field of that name; otherwise THE Engine SHALL replace the payload with
    the selected result.
16. THE DataFetcher SHALL reject with a `DataTransportError` carrying a failure kind of `connect`,
    `dns`, `tls`, `timeout`, `aborted` or `unknown` for a transport failure, SHALL use the kind
    `timeout` when the effective request timeout elapses before the response completes, and SHALL
    return a response for every HTTP status code including 3xx, 4xx and 5xx.
17. THE DataFetcher SHALL return every response header name lower-cased, and SHALL include
    `retry-after` and `link` whenever the response carries those headers.
18. WHERE the response exceeds the effective `maxResponseBytes` cap, resolved from node data when set
    and otherwise 4194304 bytes, THE DataFetcher SHALL truncate the body at that cap, SHALL set
    `truncated` to true and SHALL report `byteCount` as the number of bytes retained.
19. THE Engine SHALL record each `http-request` node execution through the existing `RunJournal`
    execution-key path before returning its output, so that a resumed run replays the recorded output
    and repeats no completed call.
20. THE Engine SHALL apply to every attempt an effective timeout of `timeoutSec` seconds when
    `timeoutSec` is an integer in the range 1 to 300 and of 30 seconds otherwise, and SHALL abort an
    attempt whose response has not completed within that timeout.
21. IF `responseMode` is `json` and the response body does not parse as JSON, including when the body
    was truncated, THEN THE Engine SHALL fail the node with a message indicating that the response
    body was not valid JSON and whether it was truncated, so that the `On error` port routing of
    Requirement 1 applies.
22. IF the interpolated url is empty, is relative while no `config.baseUrl` is available, or resolves
    to a scheme other than http or https, THEN THE Engine SHALL fail the node before calling
    `DataFetcher` with a message naming the rejected url.

### Requirement 9: Pagination and batching

**User Story:** As a workflow author, I want paginated reads and batched writes as configuration fields,
so that source and target API limits do not force me to build a subgraph.

#### Acceptance Criteria

1. THE Engine SHALL accept the pagination modes `none`, `cursor`, `page`, `offset` and `link-header` on
   an `http-request` node, and SHALL treat an absent pagination configuration as mode `none`.
2. WHILE a paginated fetch is running, THE Engine SHALL issue a request only while the completed page
   count is below the effective `maxPages`, resolved from node data when `maxPages` is an integer in
   the range 1 to 1000 and to 100 pages otherwise, and SHALL issue at most that many requests for the
   node.
3. WHEN a page response has been parsed, THE Engine SHALL append the elements resolved at `itemsPath`
   to the accumulated list in fetch order, SHALL count an absent or null value at `itemsPath` as zero
   items for that page, and SHALL fail the node with a message naming `itemsPath` when that path
   resolves to a value that is neither an array nor absent.
4. WHEN a page has been fetched and accumulated, THE Engine SHALL emit exactly one `page-fetched`
   event carrying the one-based page number, the item count of that page, and a more-pages flag that
   is true only when that response yielded a next pagination value.
5. IF a page response yields no next pagination value, or yields a next pagination value equal to the
   value used for the previous request, THEN THE Engine SHALL stop the pagination loop without issuing
   a further request, SHALL retain every item already accumulated and SHALL complete the node without
   failing it.
6. WHILE the pagination mode is `page` or `offset`, THE Engine SHALL treat a page as the final page
   when the mode is `page` and that page yielded zero items, and when the mode is `offset` and that
   page yielded fewer items than the configured `limit`, and SHALL issue no further request in that
   case.
7. WHEN the completed page count reaches the effective `maxPages`, THE Engine SHALL stop the
   pagination loop without issuing a further request, and SHALL set the more-pages flag on the final
   `page-fetched` event to true when that final response still yielded a next pagination value.
8. WHERE a `for-each` node sets `batchSize` to an integer in the range 2 to 10000, THE Engine SHALL
   run one iteration per batch, SHALL carry exactly `batchSize` items in every iteration except the
   last, and SHALL carry 1 to `batchSize` items in the last iteration.
9. WHERE a `for-each` node leaves `batchSize` absent or sets it to a value that is not an integer in
   the range 2 to 10000, including zero, one and negative values, THE Engine SHALL yield one item per
   iteration.
10. THE Engine SHALL produce batches whose concatenation in iteration order equals the source item
    list in the same order and multiplicity for source lists of 0 to 100000 items, and SHALL run zero
    iterations when the source item list is empty.
11. WHERE `batchSize` resolves to an integer in the range 2 to 10000, THE Engine SHALL report the
    number of batches as `loop-started.total` and the batch array as `loop-iteration.item`.
12. WHERE the pagination mode is `none`, THE Engine SHALL issue exactly one request for the node,
    SHALL accumulate no items, SHALL emit no `page-fetched` event, and SHALL apply the `resultPath`
    and `resultKey` selection of Requirement 8 to that single response.
13. WHEN issuing a request of a paginated fetch, THE Engine SHALL send no cursor parameter on the
    first page and the value resolved at `cursorPath` in `cursorParam` on every later page for mode
    `cursor`, SHALL send `startPage` when set and 1 otherwise in `pageParam` on the first page and
    increase that page by one per later page for mode `page`, SHALL send 0 in `offsetParam` on the
    first page and increase it by `limit` per later page while sending `limit` in `limitParam` for
    mode `offset`, and SHALL request the url of the response link whose relation matches the
    configured `rel`, defaulting to `next`, for mode `link-header`.
14. WHEN a paginated fetch has stopped, THE Engine SHALL emit one outgoing payload carrying the
    accumulated item list in fetch order and the completed page count, and SHALL apply the
    `resultPath` and `resultKey` selection of Requirement 8 to that payload.

### Requirement 10: SQL query node

**User Story:** As a workflow author, I want to read from a database with parameterised statements, so
that a sync can source data from a line-of-business system without exposing an injection surface.

#### Acceptance Criteria

1. THE Studio SHALL accept in a `sql-query` statement of 1 to 20000 characters only named parameters of
   the form `:name` where `name` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, SHALL accept 0 to 64 declared
   parameters with names unique within the node, and SHALL offer no control that concatenates payload
   text into a statement.
2. IF a `sql-query` statement contains a `{{` template token, including a statement that also contains
   valid `:name` parameters, or is empty once leading and trailing whitespace is removed, THEN THE
   Studio SHALL report the statement as invalid with a message naming the rejected statement and THE
   Engine SHALL fail the node before calling SqlHost.
3. THE Engine SHALL extract the named parameters of a statement excluding `:name` tokens appearing
   inside quoted string literals, line comments and block comments, SHALL require that the set of
   extracted names equals the set of declared parameter names compared case-sensitively, and SHALL
   otherwise fail the node before calling SqlHost with a message naming every extracted name that has
   no declaration and every declared name that does not appear in the statement.
4. WHEN a `sql-query` node executes, THE Engine SHALL evaluate each declared parameter expression
   against the incoming payload in declaration order and SHALL bind each resulting string, number,
   boolean or null value to its named parameter through the driver, passing no parameter value to the
   driver as statement text.
5. IF `RunOptions.sql` is absent, or the resolved driver — taken from the node data `driver` when
   present and from the ResolvedConnection `config` driver entry otherwise — is absent or is not one of
   `postgres`, `mysql`, `mssql` and `sqlite`, or `SqlHost.supports` returns false for the resolved
   driver, THEN THE Engine SHALL fail the node before calling `SqlHost.query` with a message naming the
   driver and the Host.
6. IF the statement is classified as a write and the ResolvedConnection has `allowWrites` other than
   true, THEN THE Engine SHALL fail the node before calling `SqlHost.query` with a message naming the
   Connection, and SHALL leave the target database unchanged.
7. THE Engine SHALL classify a statement as read-only when its first keyword, determined after removing
   leading whitespace, line comments and block comments and compared without regard to letter case, is
   `SELECT`, `WITH` followed by `SELECT`, `SHOW` or `DESCRIBE`, and SHALL classify every other
   statement, including one whose first keyword is unrecognised and one carrying more than a single
   non-empty `;`-separated statement, as a write.
8. WHEN the Engine submits a statement to SqlHost, THE Engine SHALL emit a `sql-query` event carrying
   the resolved driver, the statement text and the count of bound parameters, and SHALL exclude every
   parameter value and every ResolvedConnection secret value from that event.
9. WHEN `SqlHost.query` returns a result, THE Engine SHALL emit a `sql-result` event carrying the row
   count of that result, the elapsed duration in milliseconds and the truncation state as true or
   false.
10. THE SqlHost SHALL resolve each of `maxRows`, `maxResultBytes` and `statementTimeoutMs` from node
    data when that value is an integer within its accepted range, then from the Connection `limits`
    under the same condition, then from the defaults 10000 rows, 4194304 bytes and 30000 milliseconds,
    where the accepted ranges are 1 to 1000000 rows, 1024 to 33554432 bytes and 1000 to 300000
    milliseconds, and SHALL apply all three resolved limits to every statement it executes.
11. WHEN a result reaches the effective `maxRows` or the effective `maxResultBytes`, THE SqlHost SHALL
    stop reading further rows, SHALL return no more than the effective `maxRows` rows, SHALL set
    `truncated` to true, and THE Engine SHALL record the truncation for that node in `Sync_Summary`.
12. WHEN `SqlHost.query` returns a result, THE Engine SHALL return a payload carrying the returned rows
    under `resultKey`, defaulting to `rows`, a row count equal to the number of rows in that payload,
    and a truncation flag set to true only when the result was truncated, and SHALL return an empty row
    list with a row count of zero for a result carrying no rows.
13. IF a declared parameter expression fails to compile or evaluates to a value that is not a string,
    number, boolean or null, THEN THE Engine SHALL fail the node before calling `SqlHost.query` with a
    message naming the parameter and the rejected value kind, and SHALL bind no parameter.
14. IF the statement has not completed within the effective `statementTimeoutMs`, THEN THE SqlHost SHALL
    abort the statement and THE Engine SHALL fail the node with a message naming the node and the
    effective timeout in milliseconds, and SHALL pass no rows to any downstream node.
15. IF `SqlHost.query` rejects, THEN THE Engine SHALL fail the node with a message naming the node, the
    resolved driver and the Connection, SHALL emit no `sql-result` event for that attempt, and SHALL
    leave the incoming payload unchanged, so that the retry decision of Requirement 11 and the
    `On error` port routing of Requirement 1 apply.

### Requirement 11: Rate-limit-aware retry for non-model steps

**User Story:** As an operator, I want data steps to back off and respect rate limits, so that a busy
API does not fail an overnight sync and a retry never duplicates a write.

#### Acceptance Criteria

1. THE Engine SHALL apply a `NodeRetryPolicy` taken from node data to `http-request`, `sql-query` and
   `notify` nodes through one shared retry helper, and SHALL resolve each unset policy field to the
   defaults `maxAttempts` 3, `backoffMs` 1000 milliseconds, `maxBackoffMs` 30000 milliseconds,
   `maxRetryAfterMs` 120000 milliseconds, `retryOn` `transient`, `honorRetryAfter` true, `idempotent`
   false and `disabled` false.
2. THE Engine SHALL normalise `maxAttempts` to an integer in the range 1 to 5, treating an absent value
   as 3, a value below 1 or not an integer as 1 and a value above 5 as 5, and SHALL invoke the retried
   node body at most that many times, counting the first invocation as attempt 1.
3. IF the policy sets `disabled` to true or sets `retryOn` to `none`, THEN THE Retry_Classifier SHALL
   decide against retrying with the reason `not-retryable` and a delay of zero milliseconds, and THE
   Engine SHALL propagate the original error without emitting a `node-retrying` event.
4. IF the policy does not set `idempotent` to true, THEN THE Retry_Classifier SHALL decide to retry only
   for a `DataTransportError` whose kind is `connect`, `dns` or `tls`, and SHALL decide against
   retrying for every response status failure and every timeout or abort failure, whatever the value of
   `retryOn`.
5. WHERE the policy sets `idempotent` to true, THE Retry_Classifier SHALL decide to retry for a response
   status of 408, 425, 429, 500, 502, 503 or 504 and for any `DataTransportError`, subject to the
   attempt bound of criterion 2.
6. WHERE a response carries a `Retry-After` header that parses to a delay and the policy does not set
   `honorRetryAfter` to false, THE Retry_Classifier SHALL set the delay to the smaller of the parsed
   value and `maxRetryAfterMs`, SHALL clamp a parsed value below zero to zero milliseconds, SHALL
   ignore the exponential schedule for that attempt, and SHALL report the reason `retry-after`.
7. WHERE no parseable `Retry-After` applies, THE Retry_Classifier SHALL return a delay in the inclusive
   range zero to `min(backoffMs * 2^(attempt-1), maxBackoffMs)` milliseconds, drawn from the injected
   random source.
8. THE Retry_Classifier SHALL parse a `Retry-After` value expressed as non-negative delta-seconds as
   that count multiplied by 1000 milliseconds, SHALL parse an HTTP-date value as that date minus the
   supplied current time, and SHALL report an absent delay for an absent, empty or otherwise
   unparseable value so that criterion 7 applies.
9. THE Retry_Classifier SHALL return the same retry decision, delay and reason for an identical error,
   attempt number, policy, supplied current time and injected random source, and SHALL read no ambient
   clock and no ambient random source.
10. WHEN a retry is scheduled, THE Engine SHALL emit exactly one `node-retrying` event carrying the node
    identifier, the node name, the 1-based number of the attempt that failed, the normalised maximum
    attempts, the delay in milliseconds, the decision reason and an error description that the Redactor
    has processed.
11. WHEN a retry delay is pending, THE Engine SHALL sleep through the existing pause-aware and
    stop-aware gate helper and SHALL begin the next attempt only after the full delay has elapsed and
    the run is not paused.
12. IF a `RunStoppedError` is raised during an attempt or while a retry delay is pending, THEN THE
    Engine SHALL abandon the pending retry delay, propagate the error immediately, emit no further
    `node-retrying` event, and schedule no further attempt.
13. IF the normalised maximum attempts have been invoked and the last attempt failed, THEN THE Engine
    SHALL fail the node with the error of that last attempt, so that the `On error` port routing of
    Requirement 1 applies, and SHALL emit no `node-retrying` event for that final failure.
14. IF a failed attempt reports a response status that is not in the retryable set of criterion 5 and
    the error is not a `DataTransportError`, THEN THE Retry_Classifier SHALL decide against retrying
    with the reason `not-retryable`, unless the policy sets `retryOn` to `all`.

### Requirement 12: Durable workflow state and sync primitives

**User Story:** As an operator, I want durable per-workflow state, so that a sync can skip unchanged
records, claim a write once, and resume from a watermark.

#### Acceptance Criteria

1. THE WorkflowStateStore SHALL provide `get` returning the stored entry or an absent result, `set`
   accepting a key, a string value and an optional `ttlSec`, `delete`, a prefix-bounded `list`
   accepting a prefix and an optional limit, and `compareAndSet` accepting a key, an expected value or
   absent, a new value and an optional `ttlSec`, and SHALL represent every returned entry as the key,
   the stored string value, an `updatedAt` epoch-millisecond timestamp and, where a time-to-live
   applies, an `expiresAt` epoch-millisecond timestamp.
2. THE Engine SHALL scope every state key by the run's `workflowId` using `scopedStateKey` before
   calling `get`, `set`, `delete`, `list` or `compareAndSet`, so that a read, a prefix scan or a
   compare-and-set under one workflow observes no entry written under another workflow.
3. THE Engine SHALL reserve the key namespaces `delta:`, `idem:`, `wm:`, `oauth:` and `fx:` for state
   primitives, and SHALL construct primitive keys as `delta:` followed by the entity name and the
   external record identifier, `idem:` followed by the rendered idempotency key, `wm:` followed by the
   stream name, `oauth:` followed by the connection identifier, and `fx:` followed by the node
   identifier and the payload hash.
4. IF `RunOptions.state` is absent when a `state-get`, `state-set` or baseline read executes, THEN THE
   Engine SHALL fail the node with a message stating that the Host has no durable workflow state,
   SHALL attempt no state read and no state write, and SHALL emit neither a `state-read` nor a
   `state-written` event for that node.
5. WHEN a `state-get` node executes, THE Engine SHALL interpolate the `key` template against the
   incoming payload, SHALL emit exactly one `state-read` event carrying the scoped key and whether a
   value was found, and SHALL merge into the payload under `resultKey`, defaulting to `state`, the
   stored value, or `defaultValue` when the key is absent or expired, or `null` when the key is absent
   and no `defaultValue` is declared, merging that value parsed as JSON when it parses as JSON and as
   text otherwise.
6. WHERE `state-set` semantics are `value` or absent, THE Engine SHALL store the JSON serialisation of
   the evaluated `valueExpression` result, SHALL report `changed` as true for every such execution
   whether or not the stored value differs from the previous value, and SHALL return the incoming
   payload with the reported `changed` flag merged into it.
7. WHERE `state-set` semantics are `delta`, THE Engine SHALL compute an `fnv1a` hash of the canonical
   JSON form of the evaluated value, SHALL report `changed` as true only when the key is absent or that
   hash differs from the stored value, SHALL write the hash only when `changed` is true, and SHALL
   store that hash rather than the evaluated value.
8. WHERE `state-set` semantics are `watermark`, THE Engine SHALL report `changed` as true when the key
   is absent or `compareWatermark` orders the new value above the stored value and SHALL then store
   the new value, and SHALL otherwise report `changed` as false and leave the stored value unchanged.
9. THE Engine SHALL emit exactly one `state-written` event carrying the scoped key, the effective
   semantics and the `changed` flag for every `state-set` execution that reaches a write decision, and
   SHALL emit no `state-written` event for a `state-set` execution that fails before that decision.
10. THE Engine SHALL produce identical hashes for two records that differ only in object key ordering
    at any nesting depth, using a `canonicalJson` form that sorts object keys recursively and preserves
    array element order, and SHALL produce differing hashes for two structurally different records.
11. WHEN a delta filter runs over a record set, THE Engine SHALL classify each record as changed or
    skipped by comparing its computed hash with the value stored under that record's delta key, SHALL
    classify a record whose delta key is absent or expired as changed, and SHALL hold the relation that
    the changed count plus the skipped count equals the number of records processed after every record
    and at completion.
12. WHEN the write step for a changed record reports success, THE Engine SHALL then write that record's
    delta hash, and SHALL leave the delta key unchanged for every record whose write step reported
    failure or did not execute, so that a later run classifies that record as changed again.
13. WHEN two or more callers claim the same idempotency key through `compareAndSet` with an absent
    expected value, THE WorkflowStateStore SHALL resolve true for exactly one caller and false for
    every other caller, whatever the interleaving of those calls.
14. WHEN a caller receives false from an idempotency claim, THE Engine SHALL perform no write to the
    target system for that record, SHALL increment `Sync_Summary.skipped` by exactly one, and SHALL
    write no delta hash for that record.
15. THE `compareWatermark` function SHALL return -1, 0 or 1, comparing two values numerically when both
    parse as finite numbers, lexicographically when both are ISO 8601 timestamps and as plain strings
    otherwise, SHALL be antisymmetric and transitive so that the maximum over a set of values is
    independent of comparison order, and SHALL return a result without throwing for any two string
    inputs, including empty strings.
16. IF the value supplied to `set` or `compareAndSet` exceeds 32768 bytes when encoded as UTF-8, THEN
    THE Host SHALL reject that write with an error indicating that the per-value size limit was
    exceeded and SHALL leave any previously stored value for that key unchanged.
17. WHEN a write would take a workflow above the bounds of 50000 keys or 33554432 total UTF-8 value
    bytes, THE Host SHALL first delete entries in ascending `updatedAt` order, excluding the `wm:` and
    `oauth:` namespaces, until the write fits within both bounds, and SHALL reject the write with an
    error indicating the breached bound only when no further prunable entry remains.
18. THE Host SHALL apply the default time-to-live values of 400 days for `delta:`, 7 days for `idem:`
    and 30 days for `fx:` and no expiry for `wm:` and `oauth:`, SHALL let an explicit `ttlSec` in the
    integer range 1 to 34560000 seconds override the namespace default, and SHALL treat an entry whose
    `expiresAt` is at or before the current time as absent for `get`, for `list` and for the expected
    value of `compareAndSet`.
19. THE WorkflowStateStore SHALL return at most the supplied `list` limit of entries, SHALL treat an
    absent limit as 1000 entries, SHALL clamp a supplied limit above 1000 to 1000 and a supplied limit
    below 1 to 1, and SHALL return only entries whose key starts with the supplied prefix.
20. WHEN a value written through `set` is read through `get` under the same workflow-scoped key before
    that entry expires, THE WorkflowStateStore SHALL return that value byte-identical to the value
    written and an `updatedAt` equal to the time of that write.
21. IF the value stored under a key does not equal the `expected` value supplied to `compareAndSet`, or
    the key holds an unexpired value while `expected` is absent, THEN THE WorkflowStateStore SHALL
    resolve false and SHALL leave the stored value and its expiry unchanged.
22. WHEN `delete` is called for a key, THE WorkflowStateStore SHALL make a subsequent `get` for that key
    report absent, SHALL exclude that key from a subsequent `list`, and SHALL resolve without an error
    when the key holds no value.

### Requirement 13: Run-outcome notifications

**User Story:** As an operator, I want to be told when a scheduled sync fails or a guard breaches, so
that a silent overnight failure cannot go unnoticed.

#### Acceptance Criteria

1. THE Engine SHALL support a `notify` node whose `channel` is exactly one of `email`, `webhook` and
   `chat-webhook`, and SHALL treat every `notify` node as a pass-through step whose successful result
   is emitted on the `Sent` port.
2. WHEN a `notify` node executes, THE Engine SHALL interpolate every `{{path}}` token in `to`,
   `subject` and `body` using the existing `interpolatePayload` function, resolving an absent `body` to
   the template `{{input}}`, SHALL leave a token whose path does not resolve verbatim in the rendered
   text, and SHALL deliver the rendered message through `DataFetcher` with an effective per-attempt
   timeout of 30 seconds.
3. IF the delivery response status is outside 200-299, THEN THE Engine SHALL raise an `HttpStatusError`
   carrying that status and a body preview capped at the first 512 characters, SHALL emit no
   `notify-sent` event for that attempt, and SHALL leave the incoming payload unchanged, so that the
   retry policy of Requirement 11 and the `On error` port routing of Requirement 1 apply.
4. WHEN the delivery provider acknowledges the message with a response status in 200-299, THE Engine
   SHALL emit exactly one `notify-sent` event carrying the channel and the rendered target after the
   Redactor has processed it, SHALL exclude every ResolvedConnection secret value and the rendered
   `subject` and `body` from that event, and SHALL return the incoming payload unchanged, adding no
   field to it.
5. WHERE `channel` is `email`, THE Engine SHALL deliver the notification through the provider API of
   the resolved Connection reached by `DataFetcher`, and SHALL include no SMTP client in the engine.
6. THE Studio SHALL persist a workflow-level notification policy in `WorkflowSettings.notifications`
   holding `on` as 0 to 3 unique values drawn from `failure`, `guard-breach` and `completion`, an
   optional `connectionId` that references a Connection by identifier only, and an optional recipient
   of 1 to 320 characters, and SHALL persist no secret value in that policy.
7. WHEN a run emits `run-failed`, `run-completed` or `assert-breached` and the workflow notification
   policy names the trigger matching that event, being `failure` for `run-failed`, `completion` for
   `run-completed` and `guard-breach` for `assert-breached`, THE Host SHALL deliver exactly one
   notification for that event through `DataFetcher` using at most 3 delivery attempts, and SHALL
   report the same run outcome whether that delivery succeeds or fails.
8. IF `RunOptions.dataFetch` is absent when a `notify` node executes, THEN THE Engine SHALL fail the
   node before issuing any outbound request, with a message naming the Host and the missing capability,
   and SHALL leave the incoming payload unchanged.
9. IF a `notify` node's `channel` is absent or is not one of `email`, `webhook` or `chat-webhook`, or
   `channel` is `email` and either `connectionId` is absent or the rendered `to` value is empty after
   trimming surrounding whitespace, THEN THE Engine SHALL fail the node before issuing any outbound
   request, with a message naming the node and the rejected or missing value, SHALL emit no
   `notify-sent` event, and SHALL leave the incoming payload unchanged.
10. IF a run emits `run-failed`, `run-completed` or `assert-breached` while
    `WorkflowSettings.notifications` is absent or its `on` set does not name the trigger matching that
    event, THEN THE Host SHALL deliver no notification for that event and SHALL issue no outbound
    request.

### Requirement 14: Run events and sync audit record

**User Story:** As an operator, I want a structured record of what each sync read, changed and wrote, so
that I can answer questions about a run without re-reading the trace.

#### Acceptance Criteria

1. THE Engine SHALL define the run event types `http-request`, `http-response`, `page-fetched`,
   `sql-query`, `sql-result`, `state-read`, `state-written`, `assert-passed`, `assert-breached`,
   `notify-sent` and `sync-summary`, and SHALL emit each of them carrying the run identifier and the
   emission timestamp, plus the originating node identifier on every type except `sync-summary`.
2. THE Engine SHALL exclude request and response headers, SQL parameter values and every resolved
   secret value from every run event type listed in criterion 1, and SHALL include a request or
   response body only when the emitting node enabled body capture for that direction and the Redactor
   has processed that body.
3. THE Engine SHALL reuse the existing `node-retrying` event type for every Data_Node retry attempt and
   SHALL define no additional retry event type.
4. WHEN a run that executed at least one Data_Node reaches `run-completed` or `run-failed`, THE Engine
   SHALL emit exactly one `sync-summary` event carrying the accumulated Sync_Summary, with no other run
   event emitted between that `sync-summary` event and the terminal event.
5. WHEN the Run_Recorder receives a `sync-summary` event, THE Run_Recorder SHALL attach the event's
   Sync_Summary unchanged to `RunRecordSummary.sync` and SHALL retain the `sync-summary` event in the
   recorded event list.
6. WHEN a run that executed no Data_Node reaches `run-completed` or `run-failed`, THE Engine SHALL emit
   no `sync-summary` event and THE Run_Recorder SHALL omit `RunRecordSummary.sync`.
7. WHEN the Engine emits a `page-fetched`, `sql-result`, `http-response`, `state-written`,
   `assert-passed` or `assert-breached` event during a run, THE Engine SHALL accumulate that event's
   counts into the Sync_Summary before the `sync-summary` event is emitted, so that no emitted event of
   those types is absent from the accumulated totals.
8. THE Engine SHALL accumulate into `Sync_Summary.written` and `Sync_Summary.failed` the succeeded and
   failed record counts reported by each completed write loop, and SHALL keep every Sync_Summary count
   a non-negative integer such that the considered count equals the changed count plus the skipped
   count after the delta stage and the written count plus the failed count is at most the considered
   count.
9. WHEN the Engine emits a `page-fetched` event, THE Engine SHALL add the event's item count to the row
   count and one to the page count held under that node identifier in `Sync_Summary.sources`, and WHEN
   the Engine emits a `sql-result` event, THE Engine SHALL record that event's row count and its
   truncation state under that node identifier.
10. WHEN the Engine emits an `http-response` event, THE Engine SHALL increment by one the count held in
    `Sync_Summary.targetStatuses` for that response status, creating that entry with the value one when
    the status has not yet occurred in the run.
11. WHEN the Engine emits a `state-written` event, THE Engine SHALL increment `Sync_Summary.changed`
    where the semantics are `delta` and `changed` is true, SHALL increment `Sync_Summary.skipped` where
    the semantics are `delta` and `changed` is false, and SHALL record the event's key with its new
    value as the advanced watermark where the semantics are `watermark` and `changed` is true.

### Requirement 15: Payload redaction and run retention

**User Story:** As a compliance owner, I want persisted run history redacted and pruned, so that
customer data and credentials do not accumulate in a local database or a Durable Object.

#### Acceptance Criteria

1. THE Redactor SHALL accept 0 to 64 redaction rules per configuration, each of kind `path`, `key` or
   `pattern` with a replacement mode of `mask`, `hash` or `drop` defaulting to `mask`, and SHALL apply
   the first 64 rules in declaration order.
2. WHEN a Connection is resolved, THE Engine SHALL register every resolved secret value with the
   Redactor before emitting any event for that node.
3. THE Redactor SHALL replace every registered literal of 8 or more characters in the raw input text,
   including occurrences that span JSON string escapes, before attempting to parse the input as JSON.
4. IF a registered literal is shorter than 8 characters, THEN THE Redactor SHALL leave occurrences of
   that literal unchanged and SHALL continue applying the remaining literals and rules.
5. WHEN the input parses as JSON, THE Redactor SHALL apply `path` and `key` rules by walking the
   structure to a maximum depth of 32, SHALL leave values nested deeper than 32 levels structurally
   unchanged, and SHALL return text that parses as JSON.
6. WHEN the input does not parse as JSON, THE Redactor SHALL apply `pattern` rules to the raw text and
   SHALL return the resulting text.
7. THE Redactor SHALL return a string without throwing for every input from 0 to 1048576 bytes,
   including empty input and input that is not valid JSON, and SHALL complete each such call within
   1000 milliseconds.
8. THE Redactor SHALL produce byte-identical output when applied twice to the same input.
9. WHERE a rule sets `replace` to `hash`, THE Redactor SHALL store an `fnv1a` fingerprint of the
   canonical JSON form of the matched value, and SHALL produce the same fingerprint for two values that
   differ only in object key ordering.
10. THE Host SHALL apply the Redactor in the persistence path only, before any size clipping of the
    persisted event, and SHALL keep unredacted values in memory for the live run monitor.
11. WHERE `retention.noPersistNodeIds` names a node, THE Host SHALL replace the persisted node output
    and request and response bodies for that node with `[not persisted]` and SHALL retain that step's
    event type, node identifier and timing in the trace.
12. WHERE `retention.keepRuns` or `retention.maxAgeDays` is set on a workflow, WHEN a run record is
    persisted, THE Host SHALL retain at most `keepRuns` most recent runs within the supported range of
    1 to 1000 and SHALL delete persisted runs older than `maxAgeDays` within the supported range of 1
    to 3650 days, in place of the host default limit of 50 runs.
13. IF `retention.keepRuns` or `retention.maxAgeDays` is not a positive integer or falls outside its
    supported range, THEN THE Host SHALL ignore that value, SHALL apply the host default limit of 50
    runs and SHALL report an error indicating which retention setting is invalid.
14. THE Redactor SHALL compile each `pattern` rule once when the Redactor is created and SHALL evaluate
    each compiled pattern against a single input under a budget of 100 milliseconds.
15. IF a `pattern` rule exhausts its match budget for an input, THEN THE Redactor SHALL abandon that
    rule for that input, SHALL apply the remaining rules and SHALL return a string.
16. IF a `pattern` rule source exceeds 256 characters, THEN THE Redactor SHALL reject that rule with an
    error identifying the rejected rule and SHALL apply the remaining rules.
17. THE Redactor SHALL preserve the `type` and `nodeId` fields of every event passed through
    `redactor.event`.

### Requirement 16: Mock and replay fixtures

**User Story:** As a developer, I want to record and replay HTTP and SQL responses, so that I can iterate
on a sync and run it in continuous integration without touching a live system.

#### Acceptance Criteria

1. THE Engine SHALL resolve the fixture mode of every `http-request` and `sql-query` node from that
   node's `fixtures` value as exactly one of `off`, `record`, `replay` or `replay-or-record`, SHALL
   apply `off` when that value is absent or is not one of those four values, and SHALL perform the real
   call with no fixture read and no fixture write for a node whose resolved mode is `off`.
2. THE Engine SHALL derive each fixture key deterministically from the workflow identifier, the `fx:`
   namespace, the node identifier, an `fnv1a` hash of the node's input payload, the 0-based occurrence
   index of that node execution within the run and the request fingerprint, SHALL produce identical
   keys for two executions whose six components are equal, and SHALL produce different keys when any
   one of those components differs.
3. THE Engine SHALL compute the request fingerprint of an `http-request` node from the method, the url,
   the lower-cased request header names sorted in ascending order and the body treated as an empty
   string when absent, and SHALL compute the request fingerprint of a `sql-query` node from the
   statement and the canonical JSON form of the parameters, independent of parameter key ordering.
4. THE Engine SHALL exclude every request header value, including every value supplied by a
   ResolvedConnection, from the request fingerprint, so that rotating a credential yields the same
   fingerprint as before the rotation.
5. WHERE the fixture mode is `replay`, WHEN a fixture exists for the computed key, THE Engine SHALL
   make no DataFetcher call and no SqlHost call and SHALL produce as that node's output the status,
   headers and body recorded in that fixture for an `http-request` node, or the rows, row count and
   truncation state recorded in that fixture for a `sql-query` node.
6. WHERE the fixture mode is `replay`, IF no fixture exists for the computed key, THEN THE Engine SHALL
   fail that node with an error identifying the node and indicating that `record` mode is required,
   SHALL make no DataFetcher call and no SqlHost call, and SHALL leave every stored fixture unchanged.
7. WHERE the fixture mode is `record`, THE Engine SHALL read no fixture, SHALL perform the real call,
   SHALL emit the resulting `http-response` or `sql-result` event without the `replayed` marker set to
   true, and SHALL write a fixture at the computed key that reproduces that response on a later replay,
   overwriting any value already stored at that key.
8. WHERE the fixture mode is `replay-or-record`, THE Engine SHALL read the fixture at the computed key
   first, SHALL serve that node's output from the fixture with no real call when the read returns a
   value, and SHALL perform exactly one real call and write that call's response to the computed key
   when the read returns no value.
9. WHEN a node response is served from a fixture, THE Engine SHALL emit the same event types in the
   same order as a live call, SHALL report a duration of 0 milliseconds on those events, and SHALL set
   `replayed` to true on the `http-response` or `sql-result` event.
10. THE Host SHALL store every fixture through `FixtureStore` under the `fx:` namespace of the same
    durable store used for workflow state, scoped to the workflow identifier, SHALL exclude fixtures
    from the persisted workflow spec and from the persisted run history, and SHALL retain fixtures
    independent of the run retention limits.
11. WHERE the fixture mode is `replay`, IF the Host supplies no `FixtureStore`, THEN THE Engine SHALL
    fail that node with an error identifying the node and indicating that no fixture store is available
    on the Host, and SHALL make no DataFetcher call and no SqlHost call.
12. WHERE the fixture mode is `record` or `replay-or-record`, IF the Host supplies no `FixtureStore`,
    the fixture write fails, or the serialised fixture exceeds 4194304 bytes, THEN THE Engine SHALL
    return the live response as that node's output and SHALL report a warning identifying the node and
    indicating that the fixture was not stored.

### Requirement 17: Capability matrix and push-time validation

**User Story:** As an operator, I want each host's real capabilities declared and checked before a run or
a deploy, so that an unsupported node or a missing secret fails at design time rather than at 3am.

#### Acceptance Criteria

1. THE Engine SHALL declare exactly one `HostCapabilities` record for each of Desktop_Host,
   Browser_Host and Worker_Host, each record declaring a host identifier, a display label, the
   supported node kinds, the supported SQL drivers, the supported connection types, and a boolean value
   for each of the feature flags `cron`, `durableState`, `fixtures`, `privateNetworkEgress` and
   `stdioMcp`.
2. THE Engine SHALL exclude `sql-query` from the Browser_Host node kinds, SHALL include every other
   declared node kind, and SHALL declare zero SQL drivers and zero connection types for Browser_Host.
3. THE Engine SHALL declare exactly `postgres` and `mysql` as the Worker_Host SQL drivers, SHALL exclude
   `mssql`, and SHALL declare `mssql` for Desktop_Host only.
4. THE Capability_Validator SHALL return an empty finding list if and only if every node kind used in
   the validated spec is declared for the target Host, every `sql-query` driver used is declared for
   the target Host, every referenced `connectionId` exists in the supplied connection inventory with a
   connection type declared for the target Host and with the count of secrets present equal to the
   number of its declared `secretKeys`, every expression in the validated spec compiles under
   `validateExpression`, and no `tool-link` edge terminates on a Data_Node.
5. THE Capability_Validator SHALL apply every rule of criterion 4 to the nodes of every embedded
   sub-workflow of the validated spec in addition to the nodes of the top-level graph, and SHALL
   identify both the sub-workflow and the node in each finding raised for a sub-workflow node.
6. THE Capability_Validator SHALL emit findings ordered by the top-level graph nodes in graph node
   order, then each embedded sub-workflow in ascending sub-workflow key order, and within one node in a
   fixed rule order, and SHALL return the same findings in the same order for repeated calls over
   identical input.
7. IF a node has an absent or unrecognised kind, or node data that cannot be read for the rules of
   criterion 4, THEN THE Capability_Validator SHALL return an error finding identifying that node,
   SHALL continue validating the remaining nodes and SHALL raise no exception.
8. WHEN the Properties_Panel or the canvas displays a node that has an error finding, THE Studio SHALL
   show that finding inline on that node within 500 milliseconds of the change that produced it and
   SHALL leave every node editing action available.
9. WHEN a user starts a local run, THE Studio SHALL run the Capability_Validator against the
   Desktop_Host or Browser_Host capability record and that host's local connection inventory before
   calling `startRun`.
10. IF the Capability_Validator returns any error finding for a local run, THEN THE Studio SHALL not
    call `startRun`, SHALL create no run record and SHALL display every returned finding.
11. WHEN a user pushes a workflow to Worker_Host, THE Push_Service SHALL run the Capability_Validator
    against the Worker_Host capability record and the Worker_Host connection inventory after default
    materialisation and before sending the workflow deployment request, and IF any error finding is
    returned, THEN THE Push_Service SHALL send no deployment request and SHALL report every returned
    finding.
12. WHEN Worker_Host receives a workflow deployment request, THE Worker_Host SHALL run the
    Capability_Validator against its own capability record and connection inventory, and IF any error
    finding is returned, THEN THE Worker_Host SHALL respond with status 400 and every returned finding,
    SHALL not store the submitted workflow and SHALL leave any previously deployed workflow unchanged.
13. THE Capability_Validator SHALL collect into a declared egress list the distinct outbound host names,
    compared without regard to letter case, referenced by statically determinable `http-request` urls
    and by SQL connection configuration, and IF a referenced url is not statically determinable, THEN
    THE Capability_Validator SHALL omit it from that list and SHALL return a warning finding
    identifying the node.
14. THE Capability_Validator SHALL emit every finding with a severity of `error` or `warning`, with the
    identifier and the name of the node concerned when the finding concerns a node, and with a message
    naming the target Host label together with the unsupported node kind, SQL driver, connection type,
    absent secret keys or failing expression that caused the finding.
15. IF the Capability_Validator returns no finding of severity `error`, THEN THE Studio SHALL start the
    local run, THE Push_Service SHALL send the deployment request and THE Worker_Host SHALL accept the
    deployment, irrespective of any `warning` findings returned.

### Requirement 18: Host capability wiring

**User Story:** As a platform maintainer, I want every new capability injected through `RunOptions`, so
that the engine stays dependency-free and each host supplies only the drivers it can implement.

#### Acceptance Criteria

1. THE Engine SHALL accept the optional `RunOptions` members `connections`, `dataFetch`, `sql`, `state`,
   `fixtures`, `workflowId`, `redact` and `capabilities`, SHALL start and complete a run in which no
   executed node requires an absent member, SHALL treat an absent `workflowId` as the empty string, and
   SHALL apply no redaction transformation when `redact` is absent.
2. IF an executed Data_Node requires a `RunOptions` member that is absent, THEN THE Engine SHALL fail
   that node before making any outbound HTTP, SQL, state or fixture call for it, with a message naming
   the failing node, the missing member and the `capabilities` label of the Host when `capabilities` is
   supplied, SHALL leave every stored state entry and every stored fixture unchanged, and SHALL apply
   the `errorPortId` routing and fail-fast behaviour of Requirement 1 criteria 6 and 8.
3. THE Desktop_Host SHALL supply `connections` backed by the keychain, `dataFetch` backed by the Rust
   `data_request` command, `sql` backed by one Rust command per driver family declared in the desktop
   capability record, `state` backed by the IndexedDB `workflow-state` store, `fixtures` backed by the
   `fx:` namespace of that same store, `redact` backed by the Redactor created from the workflow
   retention settings, `workflowId` set to the identifier of the workflow being run, and `capabilities`
   set to the desktop capability record.
4. THE Browser_Host SHALL supply `dataFetch` backed by browser `fetch`, `state` and `fixtures` backed by
   the same IndexedDB store and `fx:` namespace as Desktop_Host, `redact` backed by the Redactor created
   from the workflow retention settings, a `SqlHost` whose `supports` returns false for every driver, a
   `connections` whose `resolve` rejects as Requirement 3 criterion 8 prescribes, and `capabilities` set
   to the browser capability record.
5. THE Worker_Host SHALL supply `connections` backed by worker environment secrets, `dataFetch` wrapped
   by the existing public-URL assertion and by the effective response-byte and request-timeout caps of
   Requirement 8, `sql` whose `supports` returns true for `postgres` and `mysql` only, `state` and
   `fixtures` backed by a `workflow_state` table in the Durable Object, `redact` backed by the Redactor
   created from the workflow retention settings, and `capabilities` set to the worker capability record.
6. WHEN 2 to 50 `compareAndSet` calls for the same workflow-scoped key and the same `expected` value
   reach the Worker_Host before any of them completes, THE Worker_Host SHALL resolve exactly one of
   those calls true and every other call false, SHALL perform each call as a single conditional SQL
   statement inside the Durable Object, and SHALL acquire no lease.
7. THE Engine SHALL implement the Expression_Evaluator, the Retry_Classifier, the Redactor and the
   capability matrix using only the runtime dependencies the engine package already declares, and SHALL
   add zero runtime dependency entries to that package.
8. THE Engine SHALL treat `dataFetch` as required by `http-request` and `notify`, `sql` as required by
   `sql-query`, `state` as required by `state-get`, `state-set` and an `assert` node that sets a
   baseline state key, `connections` as required by any Data_Node whose data sets a `connectionId`, and
   `fixtures` as required by an `http-request` or `sql-query` node whose fixture mode is other than
   `off`.
9. WHEN a `sql-query` node executes and `sql` is supplied, THE Engine SHALL call `SqlHost.supports` with
   that node's driver before calling `SqlHost.query`.
10. IF `SqlHost.supports` returns false for the driver of the executing `sql-query` node, THEN THE
    Engine SHALL fail that node with a message naming the driver and the Host, SHALL make no
    `SqlHost.query` call, and SHALL apply the `errorPortId` routing and fail-fast behaviour of
    Requirement 1 criteria 6 and 8.

### Requirement 19: Authoring surfaces for data nodes

**User Story:** As a workflow author, I want the palette and properties panel to configure data nodes
with validation as I type, so that I find a broken expression or a missing secret before I run anything.

#### Acceptance Criteria

1. THE Studio SHALL provide exactly one palette entry per Data_Node kind, each carrying a non-empty
   label, a non-empty description, an icon, at least three search keywords, a default node name, a port
   blueprint identical to the ports Requirement 1 declares for that kind, and default data in which
   every non-optional field of that kind's node data holds a value.
2. WHEN a user selects a Data_Node, THE Properties_Panel SHALL render one editable control for every
   field of that node kind's data — connection selection, request configuration, pagination mode,
   transform fields, aggregate specifications, assertions, state keys, notification channel, retry
   policy and fixture mode as applicable to that kind — SHALL render no control for a field that
   belongs only to another Data_Node kind, and SHALL write every committed edit into that node's data.
3. WHEN a user edits an expression field, THE Properties_Panel SHALL call `validateExpression` with the
   field's current text within 300 milliseconds of the last keystroke, SHALL display the returned error
   message together with the returned zero-based character position while the result is not ok, SHALL
   remove that indication while the result is ok, and SHALL retain the entered text in both cases.
4. THE Properties_Panel SHALL offer connection selection from the `ConnectionSummary` values whose
   `type` is declared for the active Host, SHALL show for each value its name, its type and the count of
   its declared `secretKeys` names present in the Host secret store, SHALL display no secret value, and
   SHALL mark as unusable both a value whose present count is lower than its declared `secretKeys` count
   and a stored `connectionId` that matches no listed value, while leaving the stored `connectionId`
   unchanged and the node editable.
5. WHEN a user opens the connection editor, THE Studio SHALL allow creating a Connection with an `id`
   matching `^conn-[A-Za-z0-9_-]{1,64}$`, renaming a Connection to a name of 1 to 100 characters and
   deleting a Connection, SHALL reject a submitted name outside 1 to 100 characters with an error
   indicating the allowed length while retaining the entered text and leaving the stored Connection
   unchanged, and SHALL render no stored secret value in any field.
6. WHERE a Connection is referenced by at least one workflow, WHEN a user requests its deletion, THE
   Studio SHALL list every referencing workflow identifier, SHALL leave the Connection metadata and its
   secret entries in place until the user confirms the deletion, and SHALL remove the metadata together
   with every secret entry named by its `secretKeys` once the user confirms.
7. WHERE the active Host supplies a ConnectionStore, WHEN a user enters or replaces a secret value in
   the connection editor, THE Studio SHALL write that value directly to the Host secret store, SHALL
   persist that value in neither the Connection metadata nor `WorkflowSpec`, and SHALL afterwards show
   the field as holding a stored secret without showing its value.
8. IF the active Host supplies no ConnectionStore, THEN THE Studio SHALL prevent secret entry in the
   connection editor and SHALL display an indication that secret storage requires Desktop_Host or
   Worker_Host.
9. IF a secret write or a secret removal requested by the connection editor fails, THEN THE Studio SHALL
   display an error naming the Connection and the affected secret key, SHALL leave every previously
   stored secret value unchanged, and SHALL leave the Connection metadata unchanged.
