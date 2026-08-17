# Implementation Plan: AWS BYO Deploy

## Overview

The plan is ordered so a real end-to-end AWS deployment becomes reachable as early as possible. The
runtime lands first, because the Studio surface is only meaningful once something answers: dependency
pins and the `core`/`aws` port split, then the production SDK clients, then the Server_Entry and the
Dockerfile, then the infra image switch with the Monitor_API defect fixes, then the CLI layer and
endpoint discovery. Only after the check pipeline guards are green does the Studio work start:
transport seam and `AwsRequestService`, then the config store and Settings, then the Cloud dialog.

Everything is TypeScript. No Rust file changes: `backend/src-tauri/src/process.rs` already declares
`stdin_data` and already allow-lists `npx` and `npm`, so `cargo check` appears only as an
unchanged-baseline confirmation at the checkpoints.

Every stage ends at a checkpoint that runs the verification commands, so each stage is independently
verifiable.

## Tasks

- [x] 1. Dependencies and the core/aws port split
  - [x] 1.1 Pin every AWS SDK and Smithy dependency and promote `tsx` to a runtime dependency
    - Edit `cloud-aws/package.json`: add to `dependencies`, all exact pins with no `^` or `~`,
      `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`,
      `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-secrets-manager`,
      `@aws-sdk/client-scheduler`, `@aws-sdk/client-cloudwatch`,
      `@aws-sdk/client-cloudformation`, `@aws-sdk/client-ec2`, `@aws-sdk/client-kms`,
      `@aws-sdk/client-iam`, `@aws-sdk/client-sts`, `@aws-sdk/credential-providers` at `3.1110.0`
    - Add `@aws-sdk/util-format-url` at `3.972.44`, `@smithy/signature-v4` at `5.7.0`,
      `@smithy/protocol-http` at `5.6.0`, `@smithy/url-parser` at `4.5.0`,
      `@aws-crypto/sha256-js` at `5.2.0`
    - Move `tsx` from `devDependencies` to `dependencies` at the resolved exact `4.x` version, and
      change `constructs` from `^10.5.0` to an exact pin, because the CLI launcher now needs `tsx`
      at runtime and the declared-import guard will require exact pins
    - Extend `cloud-aws/scripts/check-versions.mjs` from "the CDK pin is exact" to "every entry in
      `cloud-aws/package.json` `dependencies` and `devDependencies` is an exact pin"
    - Run `npm install` in `cloud-aws` so `package-lock.json` records the new tree
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 6.1, 8.8_

  - [x] 1.2 Move the Run_Table write shapes out of the fake and into the pure layer
    - Create `cloud-aws/src/core/table-ops.ts` declaring `ItemKey`, `Item`, `ExprValue`,
      `ConditionNode`, `UpdateItemRequest`, `TransactWriteItem` and `TransactWriteRequest` as pure
      types, moved verbatim from `cloud-aws/src/test/fake-run-table.ts`
    - Change `cloud-aws/src/core/lease.ts` to import them from `./table-ops.js`, deleting its
      `../test/fake-run-table.js` import so `core/` no longer depends on a test fixture
    - Change `cloud-aws/src/test/fake-run-table.ts` to re-export or import the shapes from
      `../core/table-ops.js` rather than declaring them
    - Preserve `lease.fencedWrite`'s emitted shape verbatim: item 0 a `ConditionCheck` on
      `{ pk: 'wf#{workflowId}', sk: 'lease' }` with `ConditionExpression: '#fence = :mine'`, item 1
      the data write
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.4, 8.10_

  - [x] 1.3 Add the pure gone-connection classifier and stop exporting it from the fake
    - Create `cloud-aws/src/core/aws-errors.ts` with
      `isGoneError(error: unknown): boolean` matching `name === 'GoneException'` or an HTTP status of
      410, alongside a re-export path for the existing `classify` in `lease.ts`
    - Change `cloud-aws/src/test/fake-monitor.ts` to throw an error object carrying
      `name = 'GoneException'` instead of exporting a `GoneException` class
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.7, 8.10, 13.1_

  - [x] 1.4 Declare every backend port in one place
    - Create `cloud-aws/src/aws/ports.ts` declaring `DocumentTableClient` (get, put, update, delete,
      query, batchWrite, transactWrite, typed against `@aws-sdk/lib-dynamodb` command inputs and
      outputs, no `Scan`), `MonitorBackend`, `SecretsBackend`, `SchedulerBackend` (moved unchanged
      from `scheduler.ts`), `LogWriter` and `MetricPublisher`
    - Create `cloud-aws/src/aws/capability-map.json` mapping each of the ten
      `RUNTIME_HOST_CAPABILITIES` names from `src/core/host-contract.ts` to its owning module under
      `src/aws/`, so the later guard has a declared owner per capability
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 1.5 Add the single core-shape-to-SDK-command compiler
    - Create `cloud-aws/src/aws/table-ops-compile.ts` exporting `compileCondition`, `compileUpdate`
      and `compileTransact` over the `src/core/table-ops.ts` shapes
    - `compileTransact` must preserve the fenced-transact shape verbatim: item 0 the lease
      `ConditionCheck`, item 1 the data write
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.4_

  - [x] 1.6 Write property test for condition compilation soundness
    - **Property 10: Condition compilation is sound**
    - **Validates: Requirements 8.4**
    - Create `cloud-aws/src/aws/table-ops-compile.spec.ts` with vitest 4 and fast-check 4, minimum
      100 iterations, tagged `// Feature: aws-byo-deploy, Property 10: Condition compilation is sound`
    - Generate a core `ConditionNode` and a candidate `Item`, evaluate the node directly and evaluate
      the compiled expression with its name and value maps against the same item, assert the same
      verdict
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.4_

  - [x] 1.7 Implement the document-table port over the existing fake
    - Create `cloud-aws/src/test/fake-document-table-client.ts` implementing `DocumentTableClient`
      over `FakeRunTable`, preserving the recorded request log so the partition-scope and no-Scan
      assertions keep working
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.2_

- [x] 2. Production AWS SDK clients behind every capability
  - [x] 2.1 Implement the DynamoDB document client
    - Create `cloud-aws/src/aws/document-table-client.ts` with
      `createDocumentTableClient({ region, tableName })` wrapping
      `DynamoDBDocumentClient.from(new DynamoDBClient(...))` and forwarding each `DocumentTableClient`
      method to its command
    - Import no `ScanCommand`, in any form
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.3, 8.6_

  - [x] 2.2 Rewrite `RunTableAdapter` against the port
    - Change `cloud-aws/src/aws/run-table.ts` constructor to
      `(table: DocumentTableClient, tableName: string, retentionExclude?: (item: Item) => boolean)`,
      removing the `FakeRunTable` type
    - Route every run-scoped write through `lease.fencedWrite(...)` then `compileTransact(...)` then
      `table.transactWrite(...)`; route updates through `compileUpdate(...)`
    - Keep reads as `GetItem` by full key or `Query` on `pk` with an `sk` prefix, plus the GSI1 and
      GSI2 queries partitioned by workflow id
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.1, 8.2, 8.4, 8.6_

  - [x] 2.3 Write property test for fenced run-scoped writes
    - **Property 8: Every run-scoped write is fenced**
    - **Validates: Requirements 8.4**
    - Add to `cloud-aws/src/aws/run-table.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 8: Every run-scoped write is fenced`
    - Drive arbitrary Host_Adapter operation sequences while holding a lease through
      `FakeDocumentTableClient`, assert every recorded write other than the skip record is a
      `TransactWriteItems` carrying a `ConditionCheck` on `{ pk: 'wf#{workflowId}', sk: 'lease' }`
      asserting equality with the held fencing token
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.4_

  - [x] 2.4 Write property test for partition-scoped reads
    - **Property 11: Every read is partition-scoped**
    - **Validates: Requirements 8.6**
    - Add to `cloud-aws/src/aws/run-table.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 11: Every read is partition-scoped`
    - Assert every recorded read request is a `GetItem` or a `Query`, each carries a partition key
      value, and none is a `Scan`
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.6_

  - [x] 2.5 Write property test for descending run history
    - **Property 27: Run history is descending by start time**
    - **Validates: Requirements 15.4**
    - Add to `cloud-aws/src/aws/run-table.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 27: Run history is descending by start time`
    - Generate run records with arbitrary start times, page through the history read, assert the
      summaries are non-increasing by start time across page boundaries and no record repeats
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 15.4_

  - [x] 2.6 Implement the monitor backend and rewrite the monitor adapter
    - Create `cloud-aws/src/aws/monitor-backend.ts` using
      `@aws-sdk/client-apigatewaymanagementapi` for `postToConnection` against
      `PHORMA_MONITOR_ENDPOINT`, and `DocumentTableClient` (`Query` on `pk = wf#{id}` with
      `skPrefix = 'conn#'`) for `listConnections` and `removeConnection`
    - Change `cloud-aws/src/aws/monitor.ts` to import `MonitorBackend` from `./ports.js` and
      `isGoneError` from `../core/aws-errors.js`, deleting the `../test/fake-monitor.js` import
    - On a gone connection, delete that connection record and continue pushing to the remainder
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.1, 8.2, 8.3, 8.7_

  - [x] 2.7 Write property test for monitor fan-out and stale pruning
    - **Property 12: Monitor fan-out and stale pruning**
    - **Validates: Requirements 8.7**
    - Add to `cloud-aws/src/aws/monitor.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 12: Monitor fan-out and stale pruning`
    - Generate a connection set for a workflow plus a stale subset and a decoy workflow, assert one
      RunEvent is delivered exactly once per live connection, never to another workflow's
      connections, exactly the stale records are deleted, and the empty set resolves successfully
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.7_

  - [x] 2.8 Implement the secrets and scheduler backends
    - Create `cloud-aws/src/aws/secrets-backend.ts` with `@aws-sdk/client-secrets-manager`:
      `GetSecretValue` mapping `ResourceNotFoundException` to `undefined`, and `put` trying
      `PutSecretValue` then falling back to `CreateSecret` with the App_CMK key id
    - Create `cloud-aws/src/aws/scheduler-backend.ts` with `@aws-sdk/client-scheduler`:
      `CreateSchedule`, `DeleteSchedule` and paginated `ListSchedules` in the IaC-owned group
    - Retype `cloud-aws/src/aws/secrets.ts` and `cloud-aws/src/aws/scheduler.ts` against
      `SecretsBackend` and `SchedulerBackend` from `./ports.js`, removing every fake type reference
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 2.9 Implement the telemetry writers
    - Create `cloud-aws/src/aws/metric-publisher.ts` with `@aws-sdk/client-cloudwatch`
      `PutMetricData` into the configured namespace
    - Create `cloud-aws/src/aws/stdout-log-writer.ts` writing structured single-line JSON to
      `process.stdout`, with no CloudWatch Logs client (the task definition already uses the
      `awslogs` driver)
    - Retype `cloud-aws/src/aws/telemetry.ts` against `LogWriter` and `MetricPublisher`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 3. Checkpoint - ports and clients
  - Run `cd cloud-aws; npm run check`, then `cd cloud-aws; npm test`, then
    `npx -y tsx cloud-aws/test/lease-contention.e2e.mts` and
    `npx -y tsx cloud-aws/test/zombie-fencing.e2e.mts` to prove the fencing invariant survived the
    port split. Confirm the unchanged baseline with `cd backend/src-tauri; cargo check`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Server_Entry, route dispatch and the container image
  - [x] 4.1 Add the pure route table and matcher
    - Create `cloud-aws/src/core/route-table.ts` with `TriggerRouteId`, `HttpMethod`,
      `RouteDefinition`, the frozen `TRIGGER_ROUTES` list of the eight Trigger_Routes, `RouteMatch`,
      a total `matchRoute(method, pathname)` and `renderRoute(id, params)`
    - Decode each segment with `decodeURIComponent` inside a try block so a malformed escape yields
      `{ matched: false }` rather than a throw; compare segment counts, then literals, then bind
      parameters
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.4, 7.5_

  - [x] 4.2 Write property test for the route matcher
    - **Property 4: Route matcher is total, unique and inverts renderRoute**
    - **Validates: Requirements 7.4, 7.5**
    - Create `cloud-aws/src/core/route-table.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 4: Route matcher is total, unique and inverts renderRoute`
    - Assert `matchRoute` never throws and matches at most one definition for any method and path
      string, and that matching `renderRoute(id, params)` with that route's method yields that route
      id and exactly those parameter values for non-empty printable parameters
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.4, 7.5_

  - [x] 4.3 Read and validate the task-definition environment
    - Create `cloud-aws/src/server/env.ts` with `ServerEnv`, `DEFAULT_PORT = 8080`,
      `FRAME_DRAIN_INTERVAL_MS = 500`, `SHUTDOWN_BUDGET_MS = 25_000` and
      `readServerEnv(env: Record<string, string | undefined>): ServerEnv`
    - Throw `MissingEnvError` naming every absent variable, never just the first, over `AWS_REGION`,
      `PHORMA_RUN_TABLE`, `PHORMA_MONITOR_ENDPOINT`, `PHORMA_SECRET_PREFIX`,
      `PHORMA_SCHEDULE_GROUP`, `PHORMA_METRIC_NAMESPACE`, `PHORMA_SCHEDULE_TARGET_ARN` and
      `PHORMA_SCHEDULE_ROLE_ARN`, defaulting `PHORMA_RUNNER_ID` and `PORT`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.9_

  - [x] 4.4 Write property test for missing environment variable reporting
    - **Property 15: Startup names every missing environment variable**
    - **Validates: Requirements 7.9**
    - Create `cloud-aws/src/server/env.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 15: Startup names every missing environment variable`
    - For any subset of the required variables omitted, assert `readServerEnv` throws and the
      reported names equal that subset exactly
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.9_

  - [x] 4.5 Implement the HTTP listener, dispatch and shutdown
    - Create `cloud-aws/src/server/index.ts` with `createRequestListener(deps)`, `startServer(env)`,
      `shutdown(handle, signal)` and `main()`, using `node:http` and no framework
    - `GET /health` answers `200 {"status":"ok"}` from an in-memory flag set after the startup
      assertion; it is not a Trigger_Route
    - Everything else goes through `matchRoute`; `{ matched: false }` answers `404` with a JSON body
      naming the unmatched method and path
    - On a match, read the body with a 6 MB cap, parse JSON for body-carrying methods, invoke the
      `trigger-routes.ts` handler through a per-route adapter that maps `params` and query values,
      and write `RouteResult` as status plus `application/json` body; wrap `connections` responses as
      `{ connections: [...] }`
    - Wrap every handler call in try/catch: a throw answers `500 {"error":"Internal error"}`, logs one
      structured line carrying the route id and the error name and message through `LogWriter`, leaks
      no detail into the body, and leaves the listener serving
    - Start the frame drain on `FRAME_DRAIN_INTERVAL_MS`; register `SIGTERM` and `SIGINT` handlers that
      flip the health flag to draining, `server.close()`, wait for in-flight requests, clear the drain
      interval, release any held lease, then `process.exit(0)` with an unref'd `SHUTDOWN_BUDGET_MS`
      hard guard
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.8_

  - [x] 4.6 Write property test for handler throw containment
    - **Property 5: A handler throw is contained**
    - **Validates: Requirements 7.6**
    - Create `cloud-aws/src/server/index.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 5: A handler throw is contained`
    - For any of the eight routes and any thrown value, assert the status is 500, the body carries no
      detail from the thrown value, and a subsequent `GET /health` still answers 200
    - Add the 404 body-shape example and the `/health` 200 example alongside the property
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.2, 7.5, 7.6_

  - [x] 4.7 Compose the production Host_Adapter and assert completeness before listening
    - Extend `cloud-aws/src/server/startup.ts` with a composition function that builds the adapter
      from `document-table-client.ts`, `monitor-backend.ts`, `secrets-backend.ts`,
      `scheduler-backend.ts`, `metric-publisher.ts` and `stdout-log-writer.ts`, then runs
      `assertContractComplete(adapter)`
    - On `IncompleteContractError`, write each `missing` capability name to stderr on its own line and
      exit non-zero before the listener is created, so the NLB target never reports healthy
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.3, 8.1_

  - [x] 4.8 Write property test for unsatisfied capability reporting
    - **Property 14: Startup names every unsatisfied capability**
    - **Validates: Requirements 7.3**
    - Add to `cloud-aws/src/server/startup.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 14: Startup names every unsatisfied capability`
    - For any subset of the ten Runtime_Host_Contract capabilities left unimplemented, assert startup
      fails and the reported names equal that subset exactly
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.3_

  - [x] 4.9 Implement the Frame_Inbox drain
    - Create `cloud-aws/src/server/frame-drain.ts` with `DrainDeps` and
      `drainFrameInbox(deps): Promise<number>`
    - Do nothing while no lease is held; query `pk = wf#{workflowId}` with `skPrefix = 'frame#'`,
      parse with `core/frames.ts parseFrame`, route with `routeFrame`, deliver to the Runner, then
      delete each item through the fenced transact path
    - Delete and ignore an unparseable frame, matching `parseFrame`'s existing contract
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.7_

  - [x] 4.10 Write property test for frame drain ordering
    - **Property 13: Frame drain preserves arrival order**
    - **Validates: Requirements 7.7**
    - Create `cloud-aws/src/server/frame-drain.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 13: Frame drain preserves arrival order`
    - Generate Frame_Inbox items with arbitrary arrival timestamps, connection ids and counters,
      assert parseable frames reach the Runner in ascending arrival-key order and every drained item
      is deleted
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 7.7_

  - [x] 4.11 Wire the contention path through the trigger route
    - Change `cloud-aws/src/server/trigger-routes.ts` so a failed lease acquire writes exactly one
      unfenced `skip#{triggeredAtMs}#{runnerId}` record through `table.put(...)`, answers HTTP 409 and
      performs no further Run_Table write for that run
    - Keep the indeterminate-lease case answering 503 with a distinct message, never 409
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 8.5, 15.6_

  - [x] 4.12 Write property test for the losing Runner
    - **Property 9: The losing Runner writes exactly one unfenced record**
    - **Validates: Requirements 8.5, 15.6**
    - Add to `cloud-aws/src/server/trigger-contention.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 9: The losing Runner writes exactly one unfenced record`
    - For any interleaving of two Runners contending for one workflow, assert the loser writes exactly
      one item, that item is the unfenced skip record, its response status is 409, and it performs no
      further write for that run
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.5, 15.6_

  - [x] 4.13 Add the container image build
    - Create `cloud-aws/Dockerfile` as a two-stage build: `node:22-bookworm-slim` build stage running
      `npm ci` then `npx esbuild src/server/index.ts --bundle --platform=node --target=node22
      --format=esm --alias:@phorma/engine=../engine/src/index.ts --outfile=/build/dist/server.mjs`,
      and a runtime stage that installs `curl`, copies only `server.mjs`, sets `NODE_ENV=production`,
      `USER node`, `EXPOSE 8080` and `CMD ["node", "server.mjs"]`
    - Create a repository-root `.dockerignore` mirroring the CDK asset exclude list (`node_modules`,
      `frontend`, `backend`, `cloud`, `mcp`, `docs`, `.git`, `.kiro`, `cdk.out`, `**/*.spec.ts`)
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.3, 13.4_

  - [x] 4.14 Add the loopback server scenario script
    - Create `cloud-aws/test/server-e2e.e2e.mts` starting the real Server_Entry over loopback against
      `FakeDocumentTableClient` and the fake monitor, secrets and scheduler backends
    - Cover the health check, one call per Trigger_Route including path parameters, the 404 shape, the
      500 containment shape, a frame drain round trip and a SIGTERM shutdown that releases the lease
    - Avoid the `tsx` hazard: never await a run whose `waitForEvent` cannot resolve, synchronise on a
      side-channel promise instead
    - Verify: `npx -y tsx cloud-aws/test/server-e2e.e2e.mts`
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.7, 7.8, 13.8_

- [x] 5. Checkpoint - the container answers
  - Run `cd cloud-aws; npm run check`, `cd cloud-aws; npm test` and
    `npx -y tsx cloud-aws/test/server-e2e.e2e.mts`. The Server_Entry now serves the eight routes and
    the image that runs it exists, so the remaining runtime work is infra wiring.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Infra image switch, Monitor_API fixes and preflight
  - [x] 6.1 Add the pure container image decision
    - Create `cloud-aws/src/core/container-image.ts` with `ContainerImageChoice` (the `asset` variant
      naming `cloud-aws/Dockerfile`, the `reference` variant carrying `imageUri`) and
      `resolveContainerImage(config: AwsDeployConfig): ContainerImageChoice`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.1, 4.2_

  - [x] 6.2 Write property test for the image path switch
    - **Property 6: Container image path switch**
    - **Validates: Requirements 4.1, 4.2**
    - Create `cloud-aws/src/core/container-image.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 6: Container image path switch`
    - Assert the asset choice appears exactly when `imageUri` is absent, the reference choice carries
      that exact value exactly when present, and no third outcome is ever produced
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 4.1, 4.2_

  - [x] 6.3 Switch the stack and compute construct onto the image choice
    - In `cloud-aws/src/infra/stack.ts`, call `resolveContainerImage(config)` once and build either
      `ecs.ContainerImage.fromRegistry(choice.imageUri)` or
      `ecs.ContainerImage.fromDockerImageAsset(new ecrAssets.DockerImageAsset(this, 'HostImage', {
      directory: REPO_ROOT, file: choice.dockerfile, exclude: IMAGE_CONTEXT_EXCLUDES, platform:
      ecrAssets.Platform.LINUX_AMD64 }))`
    - Change `cloud-aws/src/infra/constructs/compute.ts` props to take `image: ecs.ContainerImage`
      instead of `ecrRepo: ecr.IRepository`, deleting the
      `ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest')` call
    - Declare `IMAGE_CONTEXT_EXCLUDES` alongside the stack so a frontend edit cannot change the asset
      fingerprint
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 6.4 Remove the dead ECR repository and derive the Task_Execution ECR resources
    - Delete the `${prefix}-host` repository from `cloud-aws/src/infra/constructs/secrets.ts`: a CDK
      Docker image asset publishes into the CDK bootstrap image repository, so nothing ever pushed to
      it (see the Requirement 4.6 correction note)
    - In `cloud-aws/src/infra/constructs/identity.ts`, derive the Task_Execution_Identity's
      `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` resource from the image choice: the
      bootstrap repository ARN on the asset path, the repository ARN parsed from `imageUri` on the
      reference path, with `ecr:GetAuthorizationToken` staying on `*`
    - Update `cloud-aws/src/infra/iam-assertions.spec.ts` and
      `cloud-aws/src/infra/role-disjointness.spec.ts` for both shapes
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.2, 5.8_

  - [x] 6.5 Assert the two image paths in the template
    - In `cloud-aws/src/infra/template.spec.ts`, assert on the asset path that the container `Image`
      resolves through the bootstrap image repository tokens, the asset manifest carries exactly one
      Docker image entry, and the template declares zero `AWS::ECR::Repository`
    - Assert on the `imageUri` path that the container `Image` equals the configured reference
      verbatim, the asset manifest carries zero Docker image entries, and the template declares zero
      `AWS::ECR::Repository`
    - Synthesize both paths through a context override in the spec, with no credentials and no Docker
      daemon
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.4, 4.6, 13.5_

  - [x] 6.6 Set the Server_Entry environment on the task definition
    - Add an `environment` block to the container definition in
      `cloud-aws/src/infra/constructs/compute.ts` setting `PHORMA_RUN_TABLE`,
      `PHORMA_MONITOR_ENDPOINT`, `PHORMA_SECRET_PREFIX`, `PHORMA_SCHEDULE_GROUP`,
      `PHORMA_METRIC_NAMESPACE`, `PHORMA_SCHEDULE_TARGET_ARN` and `PHORMA_SCHEDULE_ROLE_ARN`
      (`AWS_REGION` is set by the Fargate agent)
    - Keep the container health check as `curl -f http://localhost:8080/health || exit 1`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.9_

  - [x] 6.7 Assert the environment names cannot drift
    - Add a `cloud-aws/src/infra/template.spec.ts` assertion that every name `readServerEnv` requires
      is present on the synthesized container definition, importing the name list from
      `src/server/env.ts` so the server-side and infra-side checks read one source
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 7.9_

  - [x] 6.8 Fix the Monitor_API request templates
    - In `cloud-aws/src/infra/constructs/monitor-api.ts`, stop reading
      `$context.authorizer.workflowId` on every route: `AWS_IAM` authorization populates no authorizer,
      so every item would land under partition key `wf#` with an empty id
    - `$connect` reads the workflow id from the signed query string with `$input.params('workflowId')`
      and writes `{ pk: 'wf#<id>', sk: 'conn#<connectionId>' }`
    - `$default` reads it from the frame body with `$input.path('$.workflowId')` and writes
      `{ pk: 'wf#<id>', sk: 'frame#<paddedTime>#<connectionId>#0000' }`
    - Compute `ttl` in epoch seconds, `#set($ttl = $context.requestTimeEpoch / 1000 + 7200)` for
      connections and one hour for frames, replacing the epoch-millisecond value that made every item
      born expired
    - Convert `$disconnect` to a MOCK integration: the query string is unavailable outside `$connect`,
      so stale records are pruned by the TTL and by the `GoneException` path in `MonitorAdapter.push`;
      `pk` stays `wf#{workflowId}` on every write
    - Update the affected `cloud-aws/src/infra/template.spec.ts` assertions
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 11.7, 8.7_

  - [x] 6.9 Add the Docker probe to Preflight
    - In `cloud-aws/src/infra/preflight.ts`, add a `DockerProbe { available(): Promise<boolean> }` port
      and run it before any `cdk` step, on the asset path only
    - A failing probe adds the failure line `Docker daemon unreachable. The deploy builds the
      container image from cloud-aws/Dockerfile. Start Docker, or set imageUri to a platform-published
      image (docs/deploy-aws.md section 3.8).`
    - Keep the existing prerequisite checks reporting every failure in one run, each line naming the
      AWS_Config_Field, the supplied value, the target region and the matching `docs/deploy-aws.md`
      request-template item; import `@aws-sdk/client-ec2` dynamically so only `plan` and `doctor` pay
      for it
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.5, 5.2, 5.3, 5.4_

  - [x] 6.10 Write property test for preflight failure reporting
    - **Property 7: Preflight reports every failure, each naming its prerequisite**
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - Add to `cloud-aws/src/infra/preflight.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 7: Preflight reports every failure, each naming its prerequisite`
    - For any subset of prerequisites marked absent or disabled, assert the failure identifier set
      equals that subset exactly, `passed` is true only for the empty subset, and every failure line
      contains the field name, the supplied value, the region and the `docs/deploy-aws.md` item
    - Add the Docker-probe example beside the property
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 4.5, 5.2, 5.3, 5.4_

  - [x] 6.11 Follow the removed ECR resource through the docs guard
    - Update `docs/deploy-aws.md` so its resource inventory no longer lists the `${prefix}-host` ECR
      repository, and its section 3.8 describes the `imageUri` alternative the Docker failure line
      points at
    - Update `cloud-aws/scripts/check-docs.mjs` so the resource coverage it derives from the
      synthesized template still matches
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 4.2, 4.5_

- [x] 7. Checkpoint - the stack synthesizes both image paths
  - Run `cd cloud-aws; npm run check` and `cd cloud-aws; npm test`. Both synths must pass with no AWS
    credentials present and no Docker daemon running.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. CLI layer, sentinel envelope and endpoint discovery
  - [x] 8.1 Add the canonical envelope encoder
    - Create `cloud-aws/src/core/sentinel.ts` with `SENTINEL_PREFIX = '__phorma__:'`,
      `SENTINEL_CHUNK_BYTES = 48 * 1024`, `encodeSentinelEnvelope(payload): string[]`,
      `decodeSentinelEnvelope(lines): SentinelDecodeResult` and the `SentinelPayload` union
      (`http-response`, `monitor-url`, `deploy-outputs`)
    - Always emit at least one line, including for the empty payload; collect by sequence into a map,
      treat a duplicate sequence with differing content as an error, and report the lowest absent
      member of `0..max(seq)` as `missingSeq`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 8.2 Write property test for the envelope round trip and emit the cross-package fixture
    - **Property 1: Sentinel envelope round trip**
    - **Validates: Requirements 10.4, 10.5**
    - Create `cloud-aws/src/core/sentinel.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 1: Sentinel envelope round trip`
    - Assert decoding the lines `encodeSentinelEnvelope` produced yields exactly that payload, the
      sequence numbers are the contiguous range `0..n-1`, and at least one line is always emitted
    - Write the committed fixture `cloud-aws/test/fixtures/sentinel-corpus.json` carrying payload plus
      encoded lines for the empty, ASCII, astral-plane and multi-chunk cases
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 10.4, 10.5_

  - [x] 8.3 Emit the two endpoint outputs under stable logical ids
    - Create `cloud-aws/src/core/outputs.ts` with `TRIGGER_API_OUTPUT = 'TriggerApiUrl'`,
      `MONITOR_API_OUTPUT = 'MonitorApiUrl'` and `REQUIRED_OUTPUTS`
    - End `cloud-aws/src/infra/stack.ts` with the two `cdk.CfnOutput`s reading those constants, values
      `https://${triggerApi.api.ref}.execute-api.${this.region}.amazonaws.com` and
      `wss://${monitorApi.api.ref}.execute-api.${this.region}.amazonaws.com/live`, export names
      `${config.namePrefix}-trigger-api-url` and `${config.namePrefix}-monitor-api-url`
    - Add the output-presence assertions to `cloud-aws/src/infra/template.spec.ts`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 9.1_

  - [x] 8.4 Extend the config parser with the image and endpoint fields
    - Add optional `imageUri`, `triggerApiUrl` and `monitorApiUrl` to `AwsDeployConfig` in
      `cloud-aws/src/core/config.ts` and ignore the `$generatedBy` member
    - Validate `imageUri` against
      `^[a-z0-9.-]+(:\d+)?(/[a-z0-9._/-]+)+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$`,
      `triggerApiUrl` as a URL with scheme exactly `https:` and no query, fragment or trailing slash,
      and `monitorApiUrl` as a URL with scheme exactly `wss:` and no query or fragment
    - Raise `ConfigError` naming the field, the supplied value and the expected shape on a mismatch
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 2.8, 2.9_

  - [x] 8.5 Write property test for the accepted config shapes
    - **Property 16: Config parser accepts exactly the documented endpoint and image shapes**
    - **Validates: Requirements 2.6, 2.8, 2.9**
    - Add to `cloud-aws/src/core/config.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 16: Config parser accepts exactly the documented endpoint and image shapes`
    - For any candidate string, assert acceptance exactly when it matches that field's documented
      shape and scheme, and that every rejection raises a `ConfigError` whose message names the field
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 2.6, 2.8, 2.9_

  - [x] 8.6 Build the typed CLI layer
    - Create `cloud-aws/src/cli/main.ts` exporting `runVerb(argv: string[]): Promise<number>` and
      dispatching to `plan.ts`, `deploy.ts`, `request.ts`, `monitor-url.ts`, `doctor.ts` and
      `outputs.ts`, all importing `core/config.ts`, `core/sentinel.ts`, `core/outputs.ts` and
      `infra/preflight.ts` directly so there is no second config parser or envelope codec
    - `plan.ts` runs Preflight to completion before `cdk diff` and runs no `cdk` step when any check
      fails; `deploy.ts` runs `cdk deploy --require-approval never --outputs-file <tmpdir>/outputs.json`
      then emits a `deploy-outputs` envelope; `outputs.ts` produces the same payload from
      `CloudFormation:DescribeStacks` without deploying
    - `request.ts` signs with SigV4 for `execute-api` in the configured region using
      `fromNodeProviderChain()`, reads the body from stdin, takes the URL at argv index 3 and the
      method at argv index 4, and emits one `http-response` envelope carrying status, headers and body;
      it exits 0 whenever an HTTP response was received and non-zero only on transport or credential
      failure, with 4 reserved for credential resolution and `ExpiredToken`
    - `monitor-url.ts` presigns `$connect` for `execute-api` with `expiresIn: 300`, formats with
      `@aws-sdk/util-format-url`, includes `workflowId` in the signed query string and emits one
      envelope; `doctor.ts` keeps exit 0, 2, 3 and 4 for pass, missing config file, missing CDK entry
      point and invalid session
    - Every verb writes a usage line naming the verb and its arguments to stderr and exits non-zero
      when under-supplied, and reads credentials only from the Node provider chain
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 3.3, 3.4, 5.1, 5.5, 5.6, 6.2, 6.4, 6.5, 9.1, 10.1, 10.3, 10.4, 11.2_

  - [x] 8.7 Write property test for under-supplied verbs
    - **Property 24: Under-supplied verbs print usage and fail**
    - **Validates: Requirements 6.4**
    - Create `cloud-aws/src/cli/main.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 24: Under-supplied verbs print usage and fail`
    - For every verb and every argument count below its arity, assert a usage line naming the verb and
      its arguments goes to stderr, the exit code is non-zero, and no AWS call is made
    - Add the four `doctor` exit-code examples and the example asserting `plan` runs Preflight before
      `cdk diff`
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 5.1, 5.5, 5.6, 6.4_

  - [x] 8.8 Shrink the shim to a launcher
    - Replace the body of `cloud-aws/bin/phorma-aws.mjs` with the `tsx/esm/api` launcher that
      `tsImport`s `../src/cli/main.ts` and sets `process.exitCode = await runVerb(process.argv.slice(2))`
    - Delete the duplicated config parsing, envelope encoding and preflight logic the shim carried,
      including its `formatUrl` import from `@smithy/url-parser`, which that package does not export
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 3.3, 6.1, 6.2_

  - [x] 8.9 Record the fifth layer in the steering file
    - Update the four-layer boundary table in `.kiro/steering/aws-host.md` to five layers, adding
      `cli/` at `cloud-aws/src/cli/` with the rule "The five verbs. May import `core/`, `aws/` and
      `infra/`. Nothing imports `cli/`."
    - Update the same file's package-scripts and dependencies sections for the new guard chain, the
      exact-pin rule and `tsx` moving to `dependencies`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 6.1, 13.6_

- [x] 9. Check pipeline guards
  - [x] 9.1 Add the fake-backed-production-code guard
    - Create `cloud-aws/scripts/check-adapter-real.mjs` asserting: no non-spec file under `src/aws/`
      imports a specifier containing `/test/` or ending in `fake-run-table.js`, `fake-monitor.js`,
      `fake-secrets-manager.js` or `fake-scheduler.js`; no non-spec file under `src/aws/` contains an
      identifier matching `\bFake[A-Z]\w*`; each of the ten `RUNTIME_HOST_CAPABILITIES` has an owner
      in `src/aws/capability-map.json` that exists and carries at least one `@aws-sdk/` import;
      `src/server/index.ts` exists and contains both `createServer` from `node:http` and a `.listen(`
      call; `cloud-aws/Dockerfile` exists, installs `curl` and its `CMD` names the bundled entry; no
      file under `src/core/` imports `@aws-sdk/` or `node:fs`, `node:http`, `node:net` or
      `node:child_process`
    - Replace the filename-based bootstrap check with the Requirement 5.9 assertion that no module
      under `cloud-aws/` declares a CDK stack or exports a script whose effect is to CREATE a
      Platform_Prerequisite, meaning an IAM role or IAM managed policy that stands in for the
      Deployment_Identity or the Permissions_Boundary, a VPC, a subnet, an App_CMK or a CDK
      bootstrap stack. Assert it two ways: in source, that `PhormaAwsHostStack` is the only
      `cdk.Stack` subclass declared under `cloud-aws/` and that no file under `bin/` or `scripts/`
      invokes `cdk bootstrap` or declares a bootstrap stack; and against the template synthesized
      from a fully populated Deploy_Config_File, that it declares zero `AWS::EC2::VPC`, zero
      `AWS::EC2::Subnet`, zero `AWS::KMS::Key` and no `AWS::IAM::ManagedPolicy` or `AWS::IAM::Role`
      carrying a name or ARN that a configured Platform_Prerequisite field already supplies
    - The assertion is creation-only: referencing or reading a Platform_Prerequisite identifier is
      allowed and only bringing one into existence fails, so `bootstrapQualifier`, the CDK bootstrap
      image repository ARN derived in task 6.4, the `imageUri` repository ARN parse in task 6.5, the
      `iam.ManagedPolicy.fromManagedPolicyArn` boundary import, `ec2.Vpc.fromVpcAttributes`,
      `kms.Key.fromKeyArn` and the Preflight bootstrap stack lookup all pass unflagged, and so do
      the task and integration roles the host stack creates under the configured boundary
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 5.9, 13.1, 13.2, 13.3, 13.4_

  - [x] 9.2 Write property test for the layer boundaries
    - **Property 26: Layer boundaries hold across the file set**
    - **Validates: Requirements 8.1, 8.10, 13.1, 13.2**
    - Create `cloud-aws/scripts/check-adapter-real.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 26: Layer boundaries hold across the file set`
    - Run the guard against the real tree and against generated seeded violating fixtures in a temp
      directory: a `src/test/` import under `src/aws/`, a `Fake` identifier, a capability owner with no
      `@aws-sdk` import, an `@aws-sdk` import under `src/core/`
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 8.1, 8.10, 13.1, 13.2_

  - [x] 9.3 Add the declared-import guard
    - Create `cloud-aws/scripts/check-imports-declared.mjs` asserting every bare import specifier
      under `bin/`, `src/aws/` and `src/cli/`, static or dynamic, value or type-only, resolves to a
      package declared in `cloud-aws/package.json` at an exact version with no `^` or `~`
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 6.1, 6.3, 8.8_

  - [x] 9.4 Write property test for declared exact-version imports
    - **Property 25: Every import specifier is declared at an exact version**
    - **Validates: Requirements 6.1, 6.3, 8.8**
    - Create `cloud-aws/scripts/check-imports-declared.spec.ts`, minimum 100 iterations, tagged
      `// Feature: aws-byo-deploy, Property 25: Every import specifier is declared at an exact version`
    - Run the guard against the real tree and against seeded fixtures: an undeclared specifier, a
      declared specifier at a caret range, a dynamic import, a type-only import
    - Verify: `cd cloud-aws; npm test`
    - _Requirements: 6.1, 6.3, 8.8_

  - [x] 9.5 Wire the guards into the check pipeline and CI
    - Change the `check` script in `cloud-aws/package.json` to
      `tsc --noEmit && cdk synth --quiet && vitest --run src/infra && node scripts/check-no-scan.mjs &&
      node scripts/check-adapter-real.mjs && node scripts/check-imports-declared.mjs &&
      node scripts/check-engine-purity.mjs && node scripts/check-engine-alias.mjs &&
      node scripts/check-versions.mjs && node scripts/check-docs.mjs`, and add the second
      `cdk synth --quiet` run with the `imageUri` context override
    - Add `cloud-aws` to `.github/workflows/ci.yml`: an install step, `npm run check` and `npm test`
      in the `checks` job. CI does not run this package today, so the guard is only a gate once these
      steps exist
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 13.5, 13.6, 13.7, 13.8_

- [x] 10. Checkpoint - the runtime is complete and guarded
  - Run `cd cloud-aws; npm run check`, `cd cloud-aws; npm test`,
    `npx -y tsx cloud-aws/test/server-e2e.e2e.mts` and `cd engine; npm test` to prove no engine
    regression. Everything AWS-side is now deployable; the Studio work follows.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Studio transport seam and AwsRequestService
  - [x] 11.1 Add the Studio-side envelope decoder
    - Create `frontend/src/app/core/deploy/sentinel-envelope.ts` carrying the decoder half with the
      same exported shape as `cloud-aws/src/core/sentinel.ts`: `SENTINEL_PREFIX`,
      `decodeSentinelEnvelope(lines)` and `SentinelDecodeResult`
    - Collect by sequence, treat a duplicate sequence with differing content as an error, report the
      lowest absent member of `0..max(seq)` as `missingSeq`, and stay immune to arrival order and
      interleaved stderr
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 10.5, 10.6, 11.3_

  - [x] 11.2 Write property test for envelope gap detection
    - **Property 2: Sentinel gap detection names the first missing sequence**
    - **Validates: Requirements 10.6**
    - Create `frontend/src/app/core/deploy/sentinel-envelope.spec.ts` with karma and jasmine using
      exhaustive enumeration over the closed mutation set (fast-check is not available in this
      package), tagged
      `// Feature: aws-byo-deploy, Property 2: Sentinel gap detection names the first missing sequence`
    - For every complete line set in the enumeration and every single mutation of it (one line removed,
      one sequence duplicated with differing content, one sequence replaced by a value beyond the
      range), assert decoding fails and names the lowest missing sequence number
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 10.6_

  - [x] 11.3 Write property test for cross-package decoder agreement
    - **Property 3: Cross-package decoder agreement**
    - **Validates: Requirements 10.5, 11.3**
    - Add to `frontend/src/app/core/deploy/sentinel-envelope.spec.ts`, enumerating every entry in
      `cloud-aws/test/fixtures/sentinel-corpus.json`, tagged
      `// Feature: aws-byo-deploy, Property 3: Cross-package decoder agreement`
    - Assert the Studio decoder reproduces every payload the `cloud-aws` encoder produced, so the two
      implementations of the wire format cannot drift silently
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 10.5, 11.3_

  - [x] 11.4 Declare the transport seam and the per-target endpoint records
    - Create `frontend/src/app/core/deploy/cloud-transport.ts` with `HttpMethod`,
      `CloudTransportResponse` and `CloudTransport` (`id: 'fetch-bearer' | 'aws-cli'`, `send`,
      `monitorSocketUrl`), one implementation per credential model and never one per endpoint
    - Extend `frontend/src/app/core/deploy/deploy-targets.ts` with `CloudOperation`,
      `CloudEndpointContext`, `CloudEndpointSpec` (method, scope, path, optional body, optional
      unwrap) and `CloudEndpoints`, and add `endpoints` to `DeployTarget`
    - Declare the Cloudflare endpoints that exist today (`POST /workflow`, `POST /connections`,
      `GET /connections`, `POST /trigger`, `DELETE /workflow/purge`, `GET /status`, `GET /usage`, the
      root-scoped `/api/connection-secrets`) and the eight Trigger_Routes for `aws`
    - Fold `push-connections` into `push-spec` for `aws` with body `{ workflowId, spec, connections }`,
      exactly what `handleSpecPush` reads, and deliberately omit `status` and `list-secret-names`
      rather than inventing a ninth AWS route
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 12.4, 12.6_

  - [x] 11.5 Implement the SigV4 request service
    - Create `frontend/src/app/core/deploy/aws-request.service.ts` with `AwsHttpResponse`,
      `AwsRequestFailureKind`, `AwsRequestResult`, an `inFlight` signal, `send(url, init)` and
      `monitorUrl(workflowId)`
    - Invoke `run_streamed_command` with `program: 'npx'`,
      `args: ['phorma-aws', 'request', url, init.method]` and `stdinData: init.body ?? ''`, so the body
      never appears in `args` and never reaches a process listing
    - Filter sentinel lines out of the `process-output-event` stream by `requestId`, drop non-sentinel
      stdout, buffer stderr for the failure message, and decode with `decodeSentinelEnvelope`
    - Inject only `TauriService`, `AwsDeployConfigService` and `ToastService`; increment `inFlight` on
      entry and decrement in a `finally`; never read or write `AwsCliService.running`
    - Map exit code 4 to `{ ok: false, kind: 'auth' }` naming `aws sso login`, `!isDesktop` to
      `not-desktop` before any invoke, and an empty `cloudAwsDirectory` to `not-configured`
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 10.7, 10.9, 10.10, 10.11, 11.1_

  - [x] 11.6 Route every CloudService endpoint through one dispatcher
    - Add a `transport` computed and a private `call<T>(op, ctx, payload?)` to
      `frontend/src/app/core/cloud.service.ts` that resolves the endpoint spec from
      `DEPLOY_TARGETS[provider].endpoints`, returns `{ ok: 'unsupported' }` when absent, builds the URL
      from `instanceUrl` or the base according to `scope`, applies `body`, dispatches, then parses and
      applies `unwrap`
    - Convert `pushWorkflow`, `pushConnectionMetadata`, `fetchConnectionInventory`, `triggerHttp`,
      `removeWorkflow`, `fetchDeployedStatus`, `listRuns`, `runDetail`, `usage`, `putConnectionSecret`
      and `connectionSecretNames` to exactly one `call` each
    - Replace the hardcoded `${base}/agents/workflow-agent/${id}` with
      `DEPLOY_TARGETS[provider].instanceUrl(base, workflowId || 'default')`, add `effectiveWorkerUrl`
      returning `awsConfig.triggerApiUrl()` for `aws`, and extend `configured` so `aws` requires
      `awsConfig.valid()` and a populated `triggerApiUrl`
    - Leave `deployedStatus` at `null` and `connectionSecretNames()` at `[]` for an omitted operation;
      inject `AwsDeployConfigService` and `AwsRequestService`, neither of which injects `CloudService`
      or `RunControllerService`, so the known NG0200 cycle is untouched
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 10.8, 12.4, 12.5, 12.6_

  - [x] 11.7 Write property test for transport selection
    - **Property 21: Transport seam selects by target only**
    - **Validates: Requirements 1.6, 10.8, 10.10, 11.4**
    - Add to `frontend/src/app/core/cloud.service.spec.ts` with exhaustive enumeration over the three
      Deploy_Target values crossed with every supported operation, tagged
      `// Feature: aws-byo-deploy, Property 21: Transport seam selects by target only`
    - Assert dispatch goes through the AWS CLI transport exactly when the target is `aws` and through
      fetch with a bearer header otherwise, the monitor socket URL carries the token query parameter
      exactly for the two Cloudflare targets, and the AWS call completes regardless of the Plan and
      Deploy concurrency signal, which is never written
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 1.6, 10.8, 10.10, 11.4_

  - [x] 11.8 Write property test for registry-derived URLs
    - **Property 22: Deployed URLs come from the registry**
    - **Validates: Requirements 12.4, 12.6**
    - Add to `frontend/src/app/core/cloud.service.spec.ts`, enumerating every target, an enumerated
      workflow id set and every supported operation, tagged
      `// Feature: aws-byo-deploy, Property 22: Deployed URLs come from the registry`
    - Assert the requested URL equals `DEPLOY_TARGETS[target].instanceUrl(base, id)` joined with the
      path that target's endpoint spec yields, and that no URL is produced by a literal path in the
      service
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 12.4, 12.6_

  - [x] 11.9 Write property test for the configured() truth table
    - **Property 23: configured() truth table**
    - **Validates: Requirements 12.5**
    - Add to `frontend/src/app/core/cloud.service.spec.ts`, enumerating every target crossed with the
      aggregate-validity and endpoint-presence states, tagged
      `// Feature: aws-byo-deploy, Property 23: configured() truth table`
    - Assert `configured()` is true exactly under the conditions the requirements state per target,
      and that `aws` requires both aggregate validity and a populated `triggerApiUrl`
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 12.5_

  - [x] 11.10 Branch the monitor connection on the credential model
    - In `frontend/src/app/core/cloud.service.ts`, keep `connect()`'s single socket, `onmessage`
      handler and `RunControllerService.apply` call verbatim, and branch only the URL:
      `await this.transport().monitorSocketUrl(base, targetId)` for `aws`, the existing `?token=`
      shape otherwise
    - Implement `awsTransport.monitorSocketUrl` over `AwsRequestService.monitorUrl(workflowId)`; on
      failure show `toast.error('Monitor unavailable', message)` and return before `new WebSocket(...)`
    - Presign inside `connect()` so every reconnect attempt presigns afresh and an expired 300 second
      URL recovers on its own
    - Add a `workflowId` member to every ControlFrame the Studio sends over an AWS socket, which the
      fixed `$default` template reads; `parseFrame` inspects only `type` and the union's own fields, so
      the five frame kinds and the Cloudflare path are unchanged
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 11.1, 11.4, 11.5, 11.7, 11.8_

  - [x] 11.11 Write property test for untransformed RunEvents
    - **Property 28: RunEvents reach the run controller untransformed**
    - **Validates: Requirements 11.6**
    - Add to `frontend/src/app/core/cloud.service.spec.ts`, enumerating the RunEvent corpus, tagged
      `// Feature: aws-byo-deploy, Property 28: RunEvents reach the run controller untransformed`
    - Assert the object the monitor socket handler passes to `RunControllerService.apply` is deep-equal
      to the parsed frame and the `monitor-synced` sentinel is never passed
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 11.6_

  - [x] 11.12 Write property test for the capability push gate
    - **Property 29: Capability findings gate the push**
    - **Validates: Requirements 12.2, 12.3**
    - Add to `frontend/src/app/core/cloud.service.spec.ts`, enumerating finding sets over the severity
      lattice, tagged
      `// Feature: aws-byo-deploy, Property 29: Capability findings gate the push`
    - Assert the push proceeds exactly when the set contains no error-severity finding, and that every
      finding is written to the Problems console either way, with the inventory read coming from
      `GET /workflows/{id}/connections` through the AWS transport
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 12. Checkpoint - the Studio can reach a deployed host
  - Run `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`, then
    `cd frontend; npm run build` (the only thing that checks the Angular budgets), then
    `cd cloud; npm run check` to prove the Cloudflare path is untouched.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Studio config store, endpoint persistence and the Settings surface
  - [x] 13.1 Fix the config file and add the endpoint fields to the store
    - Change `buildConfigFile()` in `frontend/src/app/core/deploy/aws-deploy-config.service.ts` to
      carry the provenance notice as a `$generatedBy` string member inside the object, emitting no
      leading `//` comment lines, so a single `JSON.parse` accepts the output the CLI reads
    - Add `imageUri` as an optional field validated against the same OCI reference shapes the
      Config_Parser enforces, and `triggerApiUrl` and `monitorApiUrl` as discovery-written signals
    - Add `applyDiscoveredEndpoints({ triggerApiUrl, monitorApiUrl })` setting both signals inside
      `untracked()` and awaiting `writeConfigFile()`
    - Keep every field free of AWS credential material, and keep the aggregate validity signal computed
      from the per-field validity signals rather than a second source of truth
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 2.2, 2.4, 2.6, 2.7, 2.10, 3.1, 3.2, 9.2, 9.3_

  - [x] 13.2 Delete the spec case that encoded the config-file bug
    - Remove the case in `frontend/src/app/core/deploy/aws-deploy.spec.ts` that strips `//` comment
      lines before `JSON.parse`. Delete it rather than adapting it: it encoded the bug and is how the
      defect survived review
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 3.5_

  - [x] 13.3 Write property test for the config file round trip
    - **Property 17: Deploy_Config_File round trips through a bare JSON.parse**
    - **Validates: Requirements 3.1, 3.2, 3.5**
    - Add to `frontend/src/app/core/deploy/aws-deploy.spec.ts` with exhaustive enumeration over the
      populated/empty vector across the AWS_Config_Field set, tagged
      `// Feature: aws-byo-deploy, Property 17: Deploy_Config_File round trips through a bare JSON.parse`
    - Assert `JSON.parse(buildConfigFile())` succeeds with no preprocessing, the emitted text contains
      no line beginning with `//`, the parsed object carries the provenance notice as a string member,
      and every populated field appears with its trimmed value
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 3.1, 3.2, 3.5_

  - [x] 13.4 Write property test for the aggregate validity truth table
    - **Property 19: Aggregate validity truth table**
    - **Validates: Requirements 2.4, 2.5**
    - Add to `frontend/src/app/core/deploy/aws-deploy.spec.ts`, enumerating field states over
      {missing, invalid, valid} across the required and optional fields, tagged
      `// Feature: aws-byo-deploy, Property 19: Aggregate validity truth table`
    - Assert the aggregate value is true exactly when every required field is populated and every
      populated field passes its validator, and that the displayed count equals the number of missing
      or invalid fields
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 2.4, 2.5_

  - [x] 13.5 Collect deploy envelopes and persist the discovered endpoints
    - Add an optional envelope collector to `executeStreamedCommand` in
      `frontend/src/app/core/deploy/aws-cli.service.ts`, routing sentinel-prefixed lines to the
      collector and never to the terminal so operator output stays clean
    - Add `discoverEndpoints(cloudAwsDir, collected)`: decode the collected envelope, fall back to the
      `outputs` verb when the deploy stream carried none, then call
      `awsConfig.applyDiscoveredEndpoints(...)` after a deploy exits 0
    - On a missing output, show
      `toast.warning('Deploy output missing', 'The stack did not return MonitorApiUrl. The stored endpoint values are unchanged.')`
      and leave both signals untouched
    - Inject `AwsDeployConfigService` alongside the four existing dependencies; keep the derived egress
      allow-list written to the console before the deploy step starts
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 9.2, 9.3, 9.4, 12.7_

  - [x] 13.6 Write property test for endpoint discovery
    - **Property 20: Endpoint discovery persists or preserves**
    - **Validates: Requirements 9.2, 9.3, 9.4**
    - Add to `frontend/src/app/core/deploy/aws-deploy.spec.ts`, enumerating outputs documents over
      {both present, trigger missing, monitor missing, both missing, extra outputs}, tagged
      `// Feature: aws-byo-deploy, Property 20: Endpoint discovery persists or preserves`
    - Assert that with both output names present the two fields equal those values and the rewritten
      config file round trips through a bare `JSON.parse`, and that with either absent the message
      names each missing output and both previously stored values are unchanged
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 9.2, 9.3, 9.4_

  - [x] 13.7 Make AWS a selectable Deploy_Target in Settings
    - Change `pickCloudProvider(choice: 'phorma' | 'cloudflare')` to
      `pickCloudProvider(choice: DeployTargetId)` in
      `frontend/src/app/workspace/settings/settings-dialog/settings-dialog.ts`, so `aws` is accepted by
      type as well as at runtime, and persist it through `SettingsService.cloudProvider`
    - Add the third card and the third tab in
      `frontend/src/app/workspace/settings/settings-dialog/settings-dialog.html`, using the existing
      `phorma-settings__provider-card` and `__provider-tab` markup pattern: "Your own AWS", labelled
      `Bring your own`, icon `ti ti-brand-aws`, copy "Deploy the runtime to your own AWS account on ECS
      Fargate. You own the account, the keys and the bill. Your platform team issues the identifiers."
    - Label the `cloudflare` and `aws` cards bring-your-own and the `phorma` card managed, leaving the
      existing copy unchanged
    - Verify: `cd frontend; npm run build`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 13.8 Render the AWS body section
    - Add the section inside `@if (settings.cloudProvider() === 'aws')` in
      `frontend/src/app/workspace/settings/settings-dialog/settings-dialog.html`, reusing
      `phorma-settings__cloud-setup`, `__cloud-setup-intro`, `__input`, `__input--mono`,
      `__input--invalid`, `__hint` and `__note` with no new class and no new SCSS block, so the
      `anyComponentStyle` budget is not spent on per-field styling
    - Field groups in order: account and region; platform prerequisites with the intro "Your platform
      team issues these from the request template in `docs/deploy-aws.md`. The Studio creates none of
      them."; operations; container image; local paths with the existing folder picker; discovered
      endpoints rendered read-only on `__input--mono`
    - Render `subnetIds` as a comma-separated input split on write, the `imageUri` notice as "The
      deploy will reference this image and run no local image build." when populated and "The deploy
      builds the image from `cloud-aws/Dockerfile` and needs a running Docker daemon." when empty, and
      the endpoint notice "Push, runs and live monitoring stay unavailable until a deploy completes."
      while either endpoint is empty
    - Render the per-field `__hint` naming the field and expected shape on failure, the aggregate line
      "N fields need attention" as a `computed()`, and the Plan, Deploy and Doctor controls disabled
      while the aggregate validity is false
    - Under browser preview render the whole section with the three controls `[disabled]="true"` and a
      `__note` reading "Deploying to AWS runs the AWS CLI and CDK on your machine. Use the desktop app
      to plan, deploy or run doctor.", keeping the fields editable
    - Give every PrimeNG control an explicit `size="small"` (`pSize="small"` on `pInputText`) and use
      only Tabler `ti ti-*` icons
    - Verify: `cd frontend; npm run build`
    - _Requirements: 1.5, 1.7, 1.8, 1.9, 2.1, 2.3, 2.5, 2.7, 4.7, 9.5, 9.6_

  - [x] 13.9 Write property test for the AWS form coverage
    - **Property 18: The AWS form covers every field with the required chrome**
    - **Validates: Requirements 1.9, 2.1, 2.2, 2.3**
    - Create
      `frontend/src/app/workspace/settings/settings-dialog/settings-dialog.aws.spec.ts`, enumerating
      the AWS_Config_Field set exhaustively, tagged
      `// Feature: aws-byo-deploy, Property 18: The AWS form covers every field with the required chrome`
    - Assert exactly one control per field with an associated label, that editing stores the trimmed
      value, that an invalid value renders a message naming that field, that every PrimeNG control in
      the section carries an explicit small size, and that no element carries a non-Tabler icon class
    - Filter DOM queries to the visible panel instance (`getBoundingClientRect().width > 0`), since two
      instances of every panel body are in the DOM at once
    - Add the browser-parity and disabled-control examples beside the property
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 1.7, 1.8, 1.9, 2.1, 2.2, 2.3_

- [x] 14. Checkpoint - Settings can configure and deploy
  - Run `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless` and
    `cd frontend; npm run build`. The budget check matters here: the AWS body section is the largest
    template addition in this feature and `settings-dialog.scss` is already the largest sheet.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Cloud dialog AWS body section
  - [x] 15.1 Add the Plan, Deploy and Doctor controls
    - Add the body section inside the existing `@if (provider() === 'aws')` branch of
      `frontend/src/app/workspace/cloud/cloud-dialog/cloud-dialog.html`, below the header that already
      carries the AWS copy and the Region line
    - Add component methods in `frontend/src/app/workspace/cloud/cloud-dialog/cloud-dialog.ts`: one
      primary "Plan and deploy" button with `class="phorma-btn-content"` that writes the
      Deploy_Config_File first then calls `awsCli.planAndDeploy(dir, entryExists, egressAllowList)`,
      which already runs plan, refuses deploy on a non-zero plan and confirms through
      `ConfirmDialogService`, so the dialog adds no second ordering rule; and one `[text]` Doctor
      button calling `awsCli.runCommand(doctorCommand)`
    - Disable all controls with `awsCli.running() || !isDesktop || !awsConfig.valid()` and show
      `<i class="ti ti-loader-2 phorma-icon-spin">` on the active one
    - Offer no cancel affordance: `run_streamed_command` exposes no cancellation, so render the line
      "Running. Output is streaming to the console." with a button that opens the run console instead
    - Render the two discovered URLs read-only with the same unavailable notice Settings uses, and a
      `__note` reading "Deploying to AWS needs the desktop app." when `!isDesktop`
    - Verify: `cd frontend; npm run build`
    - _Requirements: 1.5, 1.8, 3.6, 5.7, 9.5, 9.6, 12.7_

  - [x] 15.2 Write examples for the Cloud dialog AWS controls
    - Create
      `frontend/src/app/workspace/cloud/cloud-dialog/cloud-dialog.aws.spec.ts` covering: the config
      file is written before `planAndDeploy` is called, the controls are disabled under browser preview
      and while `running()` is true, no cancel control is rendered, the console-link button is present
      while running, and a `doctor` exit code of 4 surfaces the `aws sso login` message
    - Verify: `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`
    - _Requirements: 1.8, 3.6, 5.7, 12.7_

- [x] 16. Docs and prior-spec housekeeping
  - [x] 16.1 Mark the prior spec superseded
    - Add one note at the top of `.kiro/specs/aws-deployment-target/tasks.md` stating that
      `aws-byo-deploy` supersedes it
    - Change no checkbox state and no other content in that file. Before the edit that file carries
      exactly 104 checked checkboxes (`[x]`) and zero unchecked ones; both counts must be identical
      after it
    - Verify: read the edited file and assert three things about it, since the `cloud-aws` check
      pipeline never opens it. In PowerShell from the repo root:
      `$p = '.kiro/specs/aws-deployment-target/tasks.md'; $c = Get-Content $p -Raw;`
      `if ($c -notmatch 'aws-byo-deploy') { throw 'superseded note missing' };`
      `if (([regex]::Matches($c, '- \[x\]')).Count -ne 104) { throw 'checked count changed' };`
      `if (([regex]::Matches($c, '- \[ \]')).Count -ne 0) { throw 'unchecked count changed' }`
      Also confirm the note sits above the `# Implementation Plan: AWS Deployment Target` heading or
      immediately below it, so a reader meets it before any task
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 16.2 Document the operator journey the plan cannot execute
    - Extend `docs/deploy-aws.md` with the end-to-end journey (configure, plan, confirm, deploy, push a
      spec, trigger a run, read run history, watch live events) as an operator checklist, because every
      step needs a real AWS account to observe and therefore belongs in the guide rather than in this
      plan
    - Document the presigned monitor URL's 300 second expiry and the reconnect behaviour, and keep
      `cloud-aws/scripts/check-docs.mjs` passing against the section order it enforces
    - Verify: `cd cloud-aws; npm run check`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 17. Final checkpoint
  - Run, in order: `cd cloud-aws; npm run check`; `cd cloud-aws; npm test`;
    `npx -y tsx cloud-aws/test/server-e2e.e2e.mts`; `npx -y tsx cloud-aws/test/lease-contention.e2e.mts`;
    `cd engine; npm test`; `cd cloud; npm run check`;
    `cd frontend; npm test -- --watch=false --browsers=ChromeHeadless`; `cd frontend; npm run build`;
    `cd backend/src-tauri; cargo check`.
  - `cargo check` is an unchanged-baseline confirmation only: no Rust file changes in this feature.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster path to a live
  deployment, but Properties 8, 9, 11 and 26 are the ones that keep the fencing and layer invariants
  from reopening, so skip those last.
- **Fifth layer in the steering table.** `bin/phorma-aws.mjs` shrinks to a `tsx/esm/api` launcher over
  a new `cloud-aws/src/cli/` layer, and `tsx` moves to `dependencies`. That adds a fifth layer to the
  four-layer table in `.kiro/steering/aws-host.md`, which task 8.9 updates in the same change.
- **Requirement 4.6 correction.** Criterion 4.6 was corrected during review to match the CDK asset
  publishing model. A CDK Docker image asset publishes into the CDK bootstrap image repository, so the
  criterion now asserts zero `AWS::ECR::Repository` on both paths, and per path: on the asset path the
  container image resolves through the CDK bootstrap image repository and the asset manifest carries
  exactly one Docker image entry, on the `imageUri` path the container image equals the configured
  reference verbatim and the asset manifest carries zero Docker image entries. `SecretsConstruct`'s
  `${prefix}-host` repository is removed as dead code because nothing ever pushed to it, and the
  Task_Execution ECR resources are derived from the image choice rather than from that repository.
  Tasks 6.4 and 6.5 already implement the corrected criterion and need no change.
- **Deleted spec case.** The `aws-deploy.spec.ts` case that strips `//` lines before `JSON.parse` is
  deleted, not adapted (task 13.2). It encoded the config-file bug; Property 17 replaces it with the
  assertion that the emitted text needs no preprocessing at all.
- **No cancel affordance.** `run_streamed_command` exposes no cancellation, and killing a `cdk deploy`
  mid-flight is worse than letting it settle, so the Cloud dialog offers a console link and a disabled
  state instead of a Cancel button (task 15.1).
- **Monitor_API defects.** Two independent defects are fixed in task 6.8: the request templates read
  `$context.authorizer.workflowId`, which `AWS_IAM` routes never populate, and `ttl` was set in epoch
  milliseconds so every item was born expired.
- **Exact version pins.** Every `@aws-sdk/client-*` and `lib-dynamodb` at `3.1110.0`,
  `@smithy/signature-v4` `5.7.0`, `@smithy/protocol-http` `5.6.0`, `@smithy/url-parser` `4.5.0`,
  `@aws-crypto/sha256-js` `5.2.0`, `@aws-sdk/util-format-url` `3.972.44`. `formatUrl` lives in
  `util-format-url`, not in `@smithy/url-parser`, which is why the current shim cannot resolve it.
- **Property test tooling.** `cloud-aws` properties run under vitest 4 with fast-check 4 at a minimum
  of 100 iterations against the fakes through the new ports. Frontend properties run under karma with
  jasmine using exhaustive enumeration over the closed input sets, because fast-check is not available
  in that package. Every property test carries a
  `// Feature: aws-byo-deploy, Property N: <name>` comment.
- **Engine type check.** `engine/` has no local TypeScript install. A type-only check there is
  `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`, never `npx tsc`, which tries to fetch
  the bogus `tsc` package and prompts interactively.
- **CI.** `.github/workflows/ci.yml` does not run `cloud-aws` today. Task 9.5 adds the install,
  `npm run check` and `npm test` steps, which is what makes the new guards an actual gate.

Which view governs. The numbered task order above, with its checkpoints, governs sequential
execution: work the tasks in number order and stop at each checkpoint until its verification commands
are green. The wave graph below is subordinate and narrower. It describes only which leaf sub-tasks a
team that has already reached a stage may run in parallel WITHIN that stage, so no wave crosses a
checkpoint and no wave mixes tasks from two stages. Where the two views appear to differ, the
numbered order and its checkpoints win.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.5"] },
    { "id": 2, "tasks": ["1.6", "1.7"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2", "2.6", "2.8", "2.9"] },
    { "id": 5, "tasks": ["2.3", "2.7"] },
    { "id": 6, "tasks": ["2.4"] },
    { "id": 7, "tasks": ["2.5"] },
    { "id": 8, "tasks": ["4.1", "4.3", "4.13"] },
    { "id": 9, "tasks": ["4.2", "4.4", "4.7", "4.9", "4.11"] },
    { "id": 10, "tasks": ["4.5", "4.8", "4.10", "4.12"] },
    { "id": 11, "tasks": ["4.6"] },
    { "id": 12, "tasks": ["4.14"] },
    { "id": 13, "tasks": ["6.1", "6.9"] },
    { "id": 14, "tasks": ["6.2", "6.3", "6.10"] },
    { "id": 15, "tasks": ["6.4", "6.6", "6.8"] },
    { "id": 16, "tasks": ["6.5", "6.11"] },
    { "id": 17, "tasks": ["6.7"] },
    { "id": 18, "tasks": ["8.1", "8.3", "8.4", "9.1", "9.3"] },
    { "id": 19, "tasks": ["8.2", "8.5", "9.2", "9.4"] },
    { "id": 20, "tasks": ["8.6"] },
    { "id": 21, "tasks": ["8.7", "8.8"] },
    { "id": 22, "tasks": ["9.5"] },
    { "id": 23, "tasks": ["8.9"] },
    { "id": 24, "tasks": ["11.1", "11.4"] },
    { "id": 25, "tasks": ["11.2", "11.5"] },
    { "id": 26, "tasks": ["11.3", "11.6"] },
    { "id": 27, "tasks": ["11.7", "11.10"] },
    { "id": 28, "tasks": ["11.8"] },
    { "id": 29, "tasks": ["11.9"] },
    { "id": 30, "tasks": ["11.11"] },
    { "id": 31, "tasks": ["11.12"] },
    { "id": 32, "tasks": ["13.1", "13.5", "13.7"] },
    { "id": 33, "tasks": ["13.2", "13.8"] },
    { "id": 34, "tasks": ["13.3", "13.9"] },
    { "id": 35, "tasks": ["13.4"] },
    { "id": 36, "tasks": ["13.6"] },
    { "id": 37, "tasks": ["15.1", "16.1", "16.2"] },
    { "id": 38, "tasks": ["15.2"] }
  ]
}
```
