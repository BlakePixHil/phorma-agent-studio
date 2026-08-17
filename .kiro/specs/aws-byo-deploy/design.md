# Design Document

## Overview

This feature turns `cloud-aws/` from a well-tested skeleton into a deployable host, and gives the
Studio a credential-safe path to talk to it. The work splits into six seams:

1. `cloud-aws/src/aws/` gains one production client per capability behind port interfaces that both
   the AWS SDK and the existing fakes satisfy.
2. `cloud-aws/src/server/index.ts` becomes a real process: an HTTP listener on 8080, a total route
   matcher over the eight Trigger_Routes, the Frame_Inbox drain and SIGTERM lease release.
3. `cloud-aws/Dockerfile` plus an image switch in `compute.ts` gives the two image provenance paths.
4. The CDK stack emits two endpoint outputs; the `deploy` and `outputs` verbs surface them; the
   Studio persists them.
5. `AwsRequestService` carries one SigV4 HTTP call per invocation through the CLI shim, and
   `CloudService` grows a transport seam so the eight endpoints keep one call site each.
6. Settings grows a third Deploy_Target card with the AWS body section, and the Cloud dialog grows
   Plan, Deploy and Doctor controls.

Everything is TypeScript. No Rust change is required, which the next section establishes by
reading rather than assuming.

## Verified state of the code this design builds on

Read before designing, and load-bearing for the decisions below.

**The desktop shell needs no change.** `backend/src-tauri/src/process.rs` declares
`run_streamed_command(app, request_id, cwd, program, args, stdin_data: Option<String>)`. When
`stdin_data` is `Some`, it sets `Stdio::piped()`, writes the bytes and drops the handle so the child
sees EOF. `ALLOWED_PROGRAMS` is `["npx", "npm"]`, and the Windows branch resolves `npx.cmd`. Both
requirements of the transport (an allow-listed `npx` and a body on stdin) are already satisfied, so
`AwsRequestService` needs no new Tauri command and no allow-list change. The only Rust-adjacent
obligation is that nothing in this feature may pass a secret through `args`.

**CDK image assets do not need Docker at synth.** `aws-cdk-lib@2.265.0`'s `DockerImageAsset`
constructor validates that the directory and the Dockerfile exist, runs `AssetStaging` to fingerprint
the build context, and calls `stack.synthesizer.addDockerImageAsset(...)` which writes an entry into
the asset manifest. There is no `docker` invocation and no credential use in that path;
`docker build` happens later, in the asset publishing step of `cdk deploy`. This is why Requirement
4.4 holds by construction on both image paths, and why Requirement 4.5 needs an explicit Docker
probe in Preflight: synthesis will pass happily on a machine with no Docker daemon.

**`src/aws/` is not production code today.** `run-table.ts` declares
`constructor(private readonly table: FakeRunTable, ...)`. `monitor.ts` imports `MonitorBackend` and
`GoneException` from `../test/fake-monitor.js`. `secrets.ts`, `scheduler.ts` and `telemetry.ts` take
injected backends whose only implementations are fakes. `cloud-aws/package.json` declares
`@phorma/engine`, `aws-cdk-lib` and `constructs`, and no `@aws-sdk` package at all.

**`src/core/lease.ts` imports its write shapes from `../test/fake-run-table.js`.** The pure decision
layer currently depends on a test fixture for `ConditionNode`, `ExprValue`, `Item`, `ItemKey`,
`TransactWriteItem`, `TransactWriteRequest` and `UpdateItemRequest`. That inversion has to be undone
before production code can compile those shapes into SDK command inputs.

**Trigger_API and Monitor_API are IAM-authorized.** Every route in `trigger-api.ts` carries
`authorizationType: 'AWS_IAM'`, and `monitor-api.ts` sets it on `$connect`. The webview holds no AWS
credentials, so the CLI transport is not a convenience, it is the only option.

**Two Monitor_API defects block the live path.** The `$connect`, `$disconnect` and `$default`
request templates read `$context.authorizer.workflowId`, which `AWS_IAM` authorization never
populates (there is no authorizer), so every connection and frame item would land under partition
key `wf#` with an empty id. Separately, all three templates set `ttl` to
`$context.requestTimeEpoch`, which is epoch milliseconds, while DynamoDB TTL is epoch seconds, so
every item is created already expired. Both are fixed here.

**Studio side.** `AwsCliService` has the plan-then-confirm-then-deploy ordering, a `running` signal,
the exit-code-4 to `aws sso login` mapping and the egress allow-list console block, and injects only
`TauriService`, `TerminalOutputService`, `ToastService` and `ConfirmDialogService`.
`AwsDeployConfigService` has validated signals for twelve fields plus `buildConfigFile()` and
`writeConfigFile()`. Neither service has a UI call site. `settings-dialog.ts` types
`pickCloudProvider(choice: 'phorma' | 'cloudflare')` and the template renders two cards and two
tabs. `cloud-dialog` has the AWS header copy and the Region line but no body section.
`CloudService.instanceUrl()` hardcodes `${base}/agents/workflow-agent/${id}`, `configured()` returns
`false` for `aws`, every call is `fetch` plus a bearer header, and `connect()` appends `?token=`.
`AwsDeployConfigService.buildConfigFile()` prepends `//` comment lines that the shim's
`JSON.parse(readFileSync(...))` cannot read, and `aws-deploy.spec.ts` strips those lines before
parsing, which is how the bug survived review.

## Architecture

### Layer map

`aws-host.md` defines four layers. This feature adds a fifth, `cli/`, and the steering table must be
updated in the same change.

| Layer | Path | Rule |
|---|---|---|
| `core/` | `cloud-aws/src/core/` | Pure. No AWS SDK, no I/O, no `node:` import. Property-tested. |
| `aws/` | `cloud-aws/src/aws/` | One module per service. Ports plus one production implementation each. May import `@aws-sdk/*`. Must not import from `src/test/`. |
| `server/` | `cloud-aws/src/server/` | Process entry, HTTP listener, route dispatch, Runner lifecycle, frame drain, shutdown. |
| `infra/` | `cloud-aws/src/infra/` | CDK constructs, Aspects, preflight decision layer. |
| `cli/` | `cloud-aws/src/cli/` | The five verbs. May import `core/`, `aws/` and `infra/`. Nothing imports `cli/`. |

`bin/phorma-aws.mjs` shrinks to a launcher. It registers `tsx`'s ESM API and imports
`src/cli/main.ts` in-process:

```js
#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';
const { runVerb } = await tsImport('../src/cli/main.ts', import.meta.url);
process.exitCode = await runVerb(process.argv.slice(2));
```

This is the decision that makes Requirement 3.3 unconditional and Requirement 6 tractable: every
verb runs type-checked TypeScript that imports `core/config.ts` directly, so there is no second
config parser, no second envelope codec and no untyped duplicate of the preflight decision layer.
`tsx` moves from `devDependencies` to `dependencies` at an exact version, because it is now a runtime
requirement of the CLI. `cdk.json` already runs the CDK app through `npx -y tsx`, so this adds no new
tool to the operator's machine.

### Data flow, Studio to AWS

```
Settings/Cloud dialog
  -> AwsDeployConfigService            (validate, persist, write cdk.context.phorma.json)
  -> AwsCliService                     (plan, confirm, deploy, doctor, outputs)  [Deploy_Runner]
  -> AwsRequestService                 (one SigV4 HTTP call)                     [Deploy_Runner]
CloudService
  -> CloudTransport seam               (fetch+bearer | AwsRequestService)
  -> DEPLOY_TARGETS[target].endpoints  (per-target method, path, body, unwrap)
  -> Trigger_API (AWS_IAM)  -> VPC Link -> NLB:80 -> task:8080 -> Server_Entry
  -> Monitor_API ($connect AWS_IAM, presigned) -> RunEvent -> RunControllerService.apply
Server_Entry
  -> matchRoute (core)  -> trigger-routes handler  -> Host_Adapter port  -> @aws-sdk client
  -> frame drain (500 ms)  -> Runner
```

## Components and Interfaces

Ten numbered sections follow, one per component this feature adds or rewrites: the Host_Adapter, the
Server_Entry, the Container_Image path switch, endpoint discovery, the AWS_Request_Service, the
Cloud_Service transport seam, the monitor connection, the Settings surface, the Cloud dialog body
section and the Check_Pipeline guards. Each names its module paths and the signatures it introduces.

## 1. Host_Adapter rewrite

### One port declaration site

`cloud-aws/src/aws/ports.ts` becomes the single declaration site for every backend interface. The
port types are expressed against `@aws-sdk` input and output types where the shape matters, and
against plain values where it does not. Production implementations and fakes both satisfy them, and
no module under `src/aws/` names a fake type.

```ts
// cloud-aws/src/aws/ports.ts
import type {
  BatchWriteCommandInput, BatchWriteCommandOutput,
  DeleteCommandInput, DeleteCommandOutput,
  GetCommandInput, GetCommandOutput,
  PutCommandInput, PutCommandOutput,
  QueryCommandInput, QueryCommandOutput,
  TransactWriteCommandInput, TransactWriteCommandOutput,
  UpdateCommandInput, UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/** Run_Table access. Seven operations, no Scan, ever. */
export interface DocumentTableClient {
  get(input: GetCommandInput): Promise<GetCommandOutput>;
  put(input: PutCommandInput): Promise<PutCommandOutput>;
  update(input: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(input: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(input: QueryCommandInput): Promise<QueryCommandOutput>;
  batchWrite(input: BatchWriteCommandInput): Promise<BatchWriteCommandOutput>;
  transactWrite(input: TransactWriteCommandInput): Promise<TransactWriteCommandOutput>;
}

export interface MonitorBackend {
  listConnections(workflowId: string): Promise<string[]>;
  postToConnection(connectionId: string, data: string): Promise<void>;
  removeConnection(workflowId: string, connectionId: string): Promise<void>;
}

export interface SecretsBackend {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
}

export interface SchedulerBackend { /* moved unchanged from scheduler.ts */ }

export interface LogWriter { write(line: string): Promise<void>; }
export interface MetricPublisher { publish(metric: MetricDataPoint): Promise<void>; }
```

Production implementations, one file each, each importing exactly one `@aws-sdk` client:

| Module | Client | Notes |
|---|---|---|
| `src/aws/document-table-client.ts` | `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` | `createDocumentTableClient({ region, tableName })` wraps `DynamoDBDocumentClient.from(new DynamoDBClient(...))` and forwards each port method to its command. Imports no `ScanCommand`. |
| `src/aws/monitor-backend.ts` | `@aws-sdk/client-apigatewaymanagementapi` | `listConnections` and `removeConnection` go through `DocumentTableClient` (`Query` on `pk = wf#{id}`, `skPrefix = 'conn#'`); `postToConnection` goes through the management client against the `PHORMA_MONITOR_ENDPOINT`. |
| `src/aws/secrets-backend.ts` | `@aws-sdk/client-secrets-manager` | `GetSecretValue` mapping `ResourceNotFoundException` to `undefined`; `put` tries `PutSecretValue` and falls back to `CreateSecret` with the App_CMK key id. |
| `src/aws/scheduler-backend.ts` | `@aws-sdk/client-scheduler` | `CreateSchedule`, `DeleteSchedule`, paginated `ListSchedules` in the IaC-owned group. |
| `src/aws/metric-publisher.ts` | `@aws-sdk/client-cloudwatch` | `PutMetricData` into the configured namespace. |
| `src/aws/stdout-log-writer.ts` | none | Structured single-line JSON to `process.stdout`. The task definition already uses the `awslogs` driver, so a CloudWatch Logs client would be a second path to the same log group. |

`RunTableAdapter`'s constructor becomes
`constructor(private readonly table: DocumentTableClient, private readonly tableName: string, private readonly retentionExclude?: (item: Item) => boolean)`.
Every `this.table.putItem(...)` style call becomes an awaited port call with a real command input.
`src/test/fake-document-table-client.ts` implements `DocumentTableClient` over the existing
`FakeRunTable`, so every property test that exists today keeps running against the fake, unchanged in
intent, while production code names only the port.

`GoneException` moves out of the fake. `cloud-aws/src/core/aws-errors.ts` gains a pure
`isGoneError(error: unknown): boolean` matching `name === 'GoneException'` or an HTTP status of 410,
alongside the existing `classify` in `lease.ts`. `monitor.ts` imports it from `core/`, and the fake
throws an error object carrying that name.

### Exact dependency versions

Added to `cloud-aws/package.json` `dependencies`, all exact pins with no range prefix:

| Package | Version | Used by |
|---|---|---|
| `@aws-sdk/client-dynamodb` | `3.1110.0` | `document-table-client.ts` |
| `@aws-sdk/lib-dynamodb` | `3.1110.0` | `document-table-client.ts`, `ports.ts` |
| `@aws-sdk/client-apigatewaymanagementapi` | `3.1110.0` | `monitor-backend.ts` |
| `@aws-sdk/client-secrets-manager` | `3.1110.0` | `secrets-backend.ts` |
| `@aws-sdk/client-scheduler` | `3.1110.0` | `scheduler-backend.ts` |
| `@aws-sdk/client-cloudwatch` | `3.1110.0` | `metric-publisher.ts` |
| `@aws-sdk/client-cloudformation` | `3.1110.0` | `cli/outputs.ts`, bootstrap-stack preflight |
| `@aws-sdk/client-ec2` | `3.1110.0` | preflight VPC, subnet, security group |
| `@aws-sdk/client-kms` | `3.1110.0` | preflight App_CMK |
| `@aws-sdk/client-iam` | `3.1110.0` | preflight Permissions_Boundary |
| `@aws-sdk/client-sts` | `3.1110.0` | `doctor`, Deployment_Identity assume check |
| `@aws-sdk/credential-providers` | `3.1110.0` | `fromNodeProviderChain` in every verb |
| `@aws-sdk/util-format-url` | `3.972.44` | `monitor-url` presign formatting |
| `@smithy/signature-v4` | `5.7.0` | `request`, `monitor-url` |
| `@smithy/protocol-http` | `5.6.0` | `request`, `monitor-url` |
| `@smithy/url-parser` | `4.5.0` | `request` |
| `@aws-crypto/sha256-js` | `5.2.0` | SigV4 hash |
| `tsx` | pin the resolved `4.x` version | `bin/phorma-aws.mjs` launcher, `cdk.json` |

Two notes. The current shim imports `formatUrl` from `@smithy/url-parser`, which does not export it;
the function lives in `@aws-sdk/util-format-url`, hence its presence above. `@aws-sdk/client-ec2` is
large; it is imported dynamically inside the preflight backend so only `plan` and `doctor` pay for
it. `check-versions.mjs` extends from "the CDK pin is exact" to "every dependency in
`cloud-aws/package.json` is an exact pin".

### The fencing invariant survives the rewrite

The write shapes move from the fake into the pure layer. `cloud-aws/src/core/table-ops.ts` takes over
`ItemKey`, `Item`, `ExprValue`, `ConditionNode`, `UpdateItemRequest`, `TransactWriteItem` and
`TransactWriteRequest` as pure declarations. `FakeRunTable` imports them from `core/`, `lease.ts`
imports them from `core/`, and the `../test/` import in `core/` disappears.

`cloud-aws/src/aws/table-ops-compile.ts` is the only place a core write shape becomes an SDK command
input:

```ts
export function compileCondition(node: ConditionNode, names: NameMap, values: ValueMap): string;
export function compileUpdate(tableName: string, req: UpdateItemRequest): UpdateCommandInput;
export function compileTransact(tableName: string, req: TransactWriteRequest): TransactWriteCommandInput;
```

`compileTransact` preserves the shape `lease.fencedWrite` produces: item 0 is a `ConditionCheck` on
`{ pk: wf#{workflowId}, sk: 'lease' }` with `ConditionExpression: '#fence = :mine'`, item 1 is the
data write. Nothing in `src/aws/` may build a `TransactWriteCommandInput` by hand; every run-scoped
write goes `lease.fencedWrite(...) -> compileTransact(...) -> table.transactWrite(...)`. The single
exception stays the unfenced skip record, which `trigger-routes.ts` writes through
`table.put(...)` directly, and which the property in section "Correctness Properties" pins as the
only unfenced write.

Reads keep the existing rule: `GetItem` by full key or `Query` on `pk` with an `sk` prefix, plus
GSI1 and GSI2 queries partitioned by workflow id. `check-no-scan.mjs` keeps guarding the import
surface, and a property asserts the recorded request log carries no `Scan` and no keyless read.

## 2. Server_Entry

### HTTP mechanism

`node:http` with a hand-rolled matcher, not a framework. Three reasons. The package has three
runtime dependencies today and an exact-pin discipline; adding Express or Fastify adds a dependency
tree that the new declared-import guard then has to reason about. The routing surface is eight
routes with at most two path parameters, so a framework's router earns nothing. And the matcher
belongs in `core/` where it can be property-tested as a pure function, which a framework router
cannot be.

### Route table in `core/`

```ts
// cloud-aws/src/core/route-table.ts  (pure)
export type TriggerRouteId =
  | 'spec-push' | 'trigger' | 'purge' | 'run-history'
  | 'run-detail' | 'usage' | 'connections' | 'secret-write';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteDefinition {
  readonly id: TriggerRouteId;
  readonly method: HttpMethod;
  /** Segments; a leading ':' marks a parameter. */
  readonly segments: readonly string[];
  readonly params: readonly string[];
}

export const TRIGGER_ROUTES: readonly RouteDefinition[] = Object.freeze([
  { id: 'spec-push',    method: 'POST',   segments: ['workflows', ':id', 'spec'] },
  { id: 'trigger',      method: 'POST',   segments: ['workflows', ':id', 'trigger'] },
  { id: 'purge',        method: 'DELETE', segments: ['workflows', ':id'] },
  { id: 'run-history',  method: 'GET',    segments: ['workflows', ':id', 'runs'] },
  { id: 'run-detail',   method: 'GET',    segments: ['workflows', ':id', 'runs', ':runId'] },
  { id: 'usage',        method: 'GET',    segments: ['workflows', ':id', 'usage'] },
  { id: 'connections',  method: 'GET',    segments: ['workflows', ':id', 'connections'] },
  { id: 'secret-write', method: 'PUT',    segments: ['connections', ':connId', 'secrets', ':key'] },
] as const);

export type RouteMatch =
  | { matched: true; route: RouteDefinition; params: Readonly<Record<string, string>> }
  | { matched: false };

/** Total: never throws, matches at most one route, for any method and any path. */
export function matchRoute(method: string, pathname: string): RouteMatch;

/** Inverse of matchRoute for the Studio-side path builders and the tests. */
export function renderRoute(id: TriggerRouteId, params: Record<string, string>): string;
```

Matching decodes each path segment with `decodeURIComponent` inside a try block (a malformed escape
yields `{ matched: false }` rather than a throw), compares segment counts first, then literals, then
binds parameters. No two routes share a method and a segment count with overlapping literals, so the
match is unique by construction, and a property asserts it.

### Entry point

```ts
// cloud-aws/src/server/index.ts
export const DEFAULT_PORT = 8080;
export const FRAME_DRAIN_INTERVAL_MS = 500;
export const SHUTDOWN_BUDGET_MS = 25_000;

export interface ServerEnv {
  region: string;            // AWS_REGION
  runTableName: string;      // PHORMA_RUN_TABLE
  monitorEndpoint: string;   // PHORMA_MONITOR_ENDPOINT
  secretPrefix: string;      // PHORMA_SECRET_PREFIX
  scheduleGroup: string;     // PHORMA_SCHEDULE_GROUP
  metricNamespace: string;   // PHORMA_METRIC_NAMESPACE
  scheduleTargetArn: string; // PHORMA_SCHEDULE_TARGET_ARN
  scheduleRoleArn: string;   // PHORMA_SCHEDULE_ROLE_ARN
  runnerId: string;          // PHORMA_RUNNER_ID, defaults to a generated id
  port: number;              // PORT, defaults to DEFAULT_PORT
}

/** Throws MissingEnvError naming every absent variable, never just the first. */
export function readServerEnv(env: Record<string, string | undefined>): ServerEnv;

export function createRequestListener(deps: ServerDeps): http.RequestListener;
export async function startServer(env: ServerEnv): Promise<ServerHandle>;
export async function shutdown(handle: ServerHandle, signal: string): Promise<void>;
export async function main(): Promise<void>;
```

Start sequence:

1. `readServerEnv(process.env)`. A missing variable writes every missing name to stderr and exits 1.
2. Compose the Host_Adapter from the production clients, then `assertContractComplete(adapter)`.
   `IncompleteContractError.missing` is written to stderr, one capability per line, and the process
   exits 1. The listener has not been created yet, so the NLB target never reports healthy.
3. `http.createServer(createRequestListener(deps)).listen(env.port)`.
4. Start the frame drain interval.
5. Register `SIGTERM` and `SIGINT` handlers.

The request listener:

- `GET /health` answers `200 {"status":"ok"}` from an in-memory flag set after step 2. It is not a
  Trigger_Route and is not exposed through the API, only to the NLB health check and the container
  health check.
- Everything else goes through `matchRoute(req.method, new URL(req.url, 'http://local').pathname)`.
  On `{ matched: false }` the response is
  `404 {"error":"No route for METHOD /path","method":"...","path":"..."}`.
- On a match, the body is read with a 6 MB cap, parsed as JSON when the method carries one, and the
  handler is invoked from a per-route adapter that maps `params` and query values onto the existing
  `trigger-routes.ts` signature. The handler's `RouteResult` is written as
  `res.writeHead(status, {'content-type':'application/json'})` plus `JSON.stringify(body)`.
- Every handler call is wrapped in try/catch. A throw becomes
  `500 {"error":"Internal error"}`, logs one structured line carrying the route id and the error
  name and message through the `LogWriter`, and leaves the listener running. No error detail reaches
  the response body.
- `connections` responses are wrapped as `{ connections: [...] }` so the Studio has one parse shape
  across targets.

The frame drain:

```ts
// cloud-aws/src/server/frame-drain.ts
export interface DrainDeps {
  table: DocumentTableClient;
  tableName: string;
  lease: () => HeldLease | undefined;
  deliver(frame: ControlFrame): void;
}
/** Queries conn# then frame# items, delivers in arrival order, deletes each fenced. */
export async function drainFrameInbox(deps: DrainDeps): Promise<number>;
```

The drain runs on a 500 ms interval and does nothing while no lease is held. It queries
`pk = wf#{workflowId}` with `skPrefix = 'frame#'`, which is already arrival-ordered because
`frameSk` zero-pads `arrivedAtMs` to 13 digits ahead of the connection id and the counter, so
lexicographic order equals arrival order. Each frame is parsed with `core/frames.ts parseFrame`,
routed with `routeFrame`, delivered to the Runner, then deleted through the fenced transact path
(the delete is a run-scoped write, so it carries the `ConditionCheck`). An unparseable frame is
deleted and ignored, matching `parseFrame`'s existing contract.

Shutdown on SIGTERM:

1. Flip the health flag to draining so the health check fails and the target is deregistered.
2. `server.close()` to stop accepting connections, then wait for in-flight requests.
3. Clear the drain interval.
4. `leaseStore.release(heldLease, now)` when a lease is held.
5. `process.exit(0)`, with a hard `setTimeout(() => process.exit(0), SHUTDOWN_BUDGET_MS)` unref'd
   guard so the 30 second requirement holds even if a request hangs.

The task definition environment variables come from the IaC_App. `compute.ts` gains an
`environment` block setting `PHORMA_RUN_TABLE`, `PHORMA_MONITOR_ENDPOINT`, `PHORMA_SECRET_PREFIX`,
`PHORMA_SCHEDULE_GROUP`, `PHORMA_METRIC_NAMESPACE`, `PHORMA_SCHEDULE_TARGET_ARN` and
`PHORMA_SCHEDULE_ROLE_ARN`; `AWS_REGION` is set by the Fargate agent. A template assertion asserts
each name is present on the container definition, so the server-side check and the infra-side check
cannot drift.

## 3. Container image dual path

### The switch is a pure decision

```ts
// cloud-aws/src/core/container-image.ts  (pure)
export type ContainerImageChoice =
  | { kind: 'asset'; dockerfile: 'cloud-aws/Dockerfile' }
  | { kind: 'reference'; imageUri: string };

export function resolveContainerImage(config: AwsDeployConfig): ContainerImageChoice;
```

`stack.ts` calls it once and passes an `ecs.ContainerImage` into `ComputeConstruct`:

```ts
const choice = resolveContainerImage(config);
const image = choice.kind === 'reference'
  ? ecs.ContainerImage.fromRegistry(choice.imageUri)
  : ecs.ContainerImage.fromDockerImageAsset(new ecrAssets.DockerImageAsset(this, 'HostImage', {
      directory: REPO_ROOT,
      file: choice.dockerfile,
      exclude: IMAGE_CONTEXT_EXCLUDES,
      platform: ecrAssets.Platform.LINUX_AMD64,
    }));
```

`ComputeConstruct`'s props lose `ecrRepo: ecr.IRepository` and gain `image: ecs.ContainerImage`, so
`ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest')` disappears.

The build context is the repository root with an explicit exclude list (`node_modules`, `frontend`,
`backend`, `cloud`, `mcp`, `docs`, `.git`, `.kiro`, `cdk.out`, `**/*.spec.ts`), because the image
needs both `cloud-aws/` and `engine/` and the engine is consumed as source through the tsconfig path
alias. Excluding the rest keeps the asset fingerprint stable: a frontend edit must not trigger an
image rebuild. A repository-root `.dockerignore` mirrors the exclude list for a hand-run
`docker build`.

### Requirement 4.6 correction

Requirement 4.6 asks the template assertions to assert an ECR repository present on the asset path
and absent on the `imageUri` path. That is not achievable as written, and the design does not pretend
otherwise. A CDK Docker image asset publishes into the **CDK bootstrap** image repository, which is
already a Platform_Prerequisite (section 3.3 of `docs/deploy-aws.md` names it). The stack therefore
declares no `AWS::ECR::Repository` on either path, and `SecretsConstruct`'s `${prefix}-host`
repository is removed as dead: nothing ever pushed to it.

The assertion that preserves the intent, and that the tasks will implement instead:

- Asset path: the synthesized task definition's container `Image` resolves through the bootstrap
  image repository tokens, the asset manifest carries exactly one Docker image entry, and the
  template declares zero `AWS::ECR::Repository`.
- `imageUri` path: the container `Image` equals the configured reference verbatim, the asset manifest
  carries zero Docker image entries, and the template declares zero `AWS::ECR::Repository`.

`IdentityConstruct` follows: the Task_Execution_Identity's `ecr:BatchGetImage` and
`ecr:GetDownloadUrlForLayer` resource is derived from the image choice (the bootstrap repository ARN
on the asset path, the repository ARN parsed from `imageUri` on the reference path), with
`ecr:GetAuthorizationToken` staying on `*` as the API requires. `iam-assertions.spec.ts` and
`role-disjointness.spec.ts` are updated for both shapes, and `docs/deploy-aws.md` plus
`check-docs.mjs` follow the removed resource.

### Dockerfile

`cloud-aws/Dockerfile`, two stages, bundled with esbuild so the runtime image runs plain `node` with
no transpiler and no `node_modules`:

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY cloud-aws/package.json cloud-aws/package-lock.json cloud-aws/tsconfig.json ./cloud-aws/
COPY engine ./engine
RUN cd cloud-aws && npm ci
COPY cloud-aws/src ./cloud-aws/src
RUN cd cloud-aws && npx esbuild src/server/index.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --alias:@phorma/engine=../engine/src/index.ts \
      --outfile=/build/dist/server.mjs

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/dist/server.mjs ./server.mjs
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
```

`curl` is installed because `compute.ts`'s container health check is
`curl -f http://localhost:8080/health || exit 1`. `esbuild` stays a `devDependency`: `npm ci` in the
build stage installs it, and the runtime stage carries neither it nor `node_modules`.

### Why synth stays Docker-free and credential-free

On the `imageUri` path there is no asset at all, so the question does not arise. On the asset path
`DockerImageAsset` only fingerprints the build context and writes an asset manifest entry, as
established in the verified-state section, so `cdk synth --quiet` needs no daemon and no
credentials. It does need the directory and the Dockerfile to exist, which is exactly why the new
guard asserts `cloud-aws/Dockerfile` is present: without it, synthesis fails with
`CannotFindFile` and the whole check pipeline goes red.

Because synthesis cannot detect a missing daemon, `plan` and `deploy` run a Docker probe in
Preflight before any `cdk` step, on the asset path only:

```ts
// cloud-aws/src/infra/preflight.ts
export interface DockerProbe { available(): Promise<boolean>; }
```

A failing probe yields the failure line
`Docker daemon unreachable. The deploy builds the container image from cloud-aws/Dockerfile. Start Docker, or set imageUri to a platform-published image (docs/deploy-aws.md section 3.8).`

## 4. Endpoint discovery

### Outputs

`stack.ts` ends with two outputs under stable logical ids:

```ts
new cdk.CfnOutput(this, 'TriggerApiUrl', {
  value: `https://${triggerApi.api.ref}.execute-api.${this.region}.amazonaws.com`,
  exportName: `${config.namePrefix}-trigger-api-url`,
});
new cdk.CfnOutput(this, 'MonitorApiUrl', {
  value: `wss://${monitorApi.api.ref}.execute-api.${this.region}.amazonaws.com/live`,
  exportName: `${config.namePrefix}-monitor-api-url`,
});
```

The logical ids `TriggerApiUrl` and `MonitorApiUrl` are the contract. `cloud-aws/src/core/outputs.ts`
declares them once as `TRIGGER_API_OUTPUT` and `MONITOR_API_OUTPUT`, and both the CDK construct and
the CLI parser read those constants, so a rename cannot desynchronize the two ends.

### Surfacing them

`cli/deploy.ts` runs
`cdk deploy --require-approval never --outputs-file <tmpdir>/outputs.json --context phorma:config=...`,
then reads the file, extracts the stack's two outputs and emits one Sentinel_Envelope carrying
`{ kind: 'deploy-outputs', triggerApiUrl, monitorApiUrl }`. A sixth verb, `outputs`, does the same
thing from `CloudFormation:DescribeStacks` without deploying, for the recovery path in Requirement
9.4 and for operators who deploy from CI. Both are envelope-framed, so the Studio has one decoder.

### Persisting them

`AwsCliService.executeStreamedCommand` gains an optional envelope collector. Lines beginning with the
sentinel prefix are routed to the collector and never written to the terminal, so operator output
stays clean. After a deploy exits 0:

```ts
// AwsCliService
private async discoverEndpoints(cloudAwsDir: string, collected: string[]): Promise<void>;
```

It decodes the collected envelope, or falls back to running the `outputs` verb when the deploy stream
carried none, then calls
`this.awsConfig.applyDiscoveredEndpoints({ triggerApiUrl, monitorApiUrl })`. That method sets both
signals inside `untracked()` and awaits `writeConfigFile()` so the CLI reads the same values on the
next invocation. A missing output produces
`this.toast.warning('Deploy output missing', 'The stack did not return MonitorApiUrl. The stored endpoint values are unchanged.')`
and leaves both signals untouched.

`AwsCliService` now injects `AwsDeployConfigService` in addition to its four existing dependencies.
`AwsDeployConfigService` injects only `TauriService`, so no cycle appears.

## 5. AwsRequestService and the Sentinel_Envelope

### Envelope format, one implementation per direction

`cloud-aws/src/core/sentinel.ts` is the canonical encoder, imported by `cli/request.ts`,
`cli/monitor-url.ts`, `cli/deploy.ts` and `cli/outputs.ts`:

```ts
export const SENTINEL_PREFIX = '__phorma__:';
export const SENTINEL_CHUNK_BYTES = 48 * 1024;

/** Base64 chunks of the UTF-8 payload, sequence 0..n-1, always at least one line. */
export function encodeSentinelEnvelope(payload: string): string[];

/** For the property tests and the cross-package fixture. */
export function decodeSentinelEnvelope(lines: readonly string[]): SentinelDecodeResult;

export type SentinelDecodeResult =
  | { ok: true; payload: string }
  | { ok: false; error: string; missingSeq?: number };
```

The webview cannot import from `cloud-aws/`, so the Studio carries the decoder half in
`frontend/src/app/core/deploy/sentinel-envelope.ts` with the same exported shape. Drift is caught two
ways: the cloud-aws spec writes a committed fixture
`cloud-aws/test/fixtures/sentinel-corpus.json` (payload plus encoded lines, covering empty, ASCII,
astral-plane and multi-chunk cases), and the frontend spec asserts its decoder reproduces every
payload in that fixture.

Reassembly rules, identical on both sides. Lines are collected into a `Map<number, string>` keyed by
sequence. A duplicate sequence with differing content is an error. The expected set is
`0..max(seq)`; the first absent member yields
`{ ok: false, error: 'Sentinel envelope incomplete: sequence 3 is missing', missingSeq: 3 }`.
Concatenation follows ascending sequence, then a single base64 decode per chunk. Order of arrival is
irrelevant, only completeness and sequence numbering, which keeps the decoder immune to interleaved
stderr.

### The request verb carries status and headers

`cli/request.ts` signs with SigV4 for `execute-api` in the configured region using
`fromNodeProviderChain()`, performs the call, and emits one envelope whose payload is:

```json
{ "kind": "http-response", "status": 200, "headers": { "content-type": "application/json" }, "body": "..." }
```

This is the change that lets the caller tell a 409 from a broken pipe. The verb exits 0 whenever it
received an HTTP response, whatever the status, and non-zero only on a transport or credential
failure, with exit code 4 reserved for a credential resolution or `ExpiredToken` failure so the
`aws sso login` mapping works uniformly with `doctor`.

### The service

```ts
// frontend/src/app/core/deploy/aws-request.service.ts
export interface AwsHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}
export type AwsRequestFailureKind =
  | 'not-desktop' | 'not-configured' | 'transport' | 'envelope' | 'auth';
export type AwsRequestResult =
  | { ok: true; response: AwsHttpResponse }
  | { ok: false; kind: AwsRequestFailureKind; message: string };

@Injectable({ providedIn: 'root' })
export class AwsRequestService {
  /** Own accounting, deliberately not AwsCliService.running. */
  readonly inFlight = signal(0);

  async send(url: string, init: { method: HttpMethod; body?: string }): Promise<AwsRequestResult>;
  async monitorUrl(workflowId: string): Promise<{ ok: true; url: string } | { ok: false; message: string }>;
}
```

Injects `TauriService`, `AwsDeployConfigService` and `ToastService`. It does not inject
`CloudService`, `AwsCliService` or `RunControllerService`, so the DI edge is one-way:
`CloudService -> AwsRequestService`. A test that instantiates it in a TestBed providing no
`CloudService` proves the absence of the reverse edge.

Invocation, exactly:

```ts
await invoke<{ success: boolean; exitCode: number | null }>('run_streamed_command', {
  requestId: `aws-req-${++this.counter}`,
  cwd: this.config.cloudAwsDirectory(),
  program: 'npx',
  args: ['phorma-aws', 'request', url, init.method],
  stdinData: init.body ?? '',
});
```

The URL is argv index 3 and the method is argv index 4 as the shim expects. The body never appears in
`args`, so it never reaches a process listing. Sentinel lines arrive through the
`process-output-event` listener filtered by `requestId`; non-sentinel `stdout` lines are dropped and
`stderr` lines are buffered for the failure message rather than written to the run console, because a
data read is not operator output.

`inFlight` increments on entry and decrements in a `finally`. There is no mutual exclusion: several
reads may run concurrently, and none of them consult or write `AwsCliService.running`, so a run
history read proceeds while a deploy streams. Exit code 4 yields
`{ ok: false, kind: 'auth', message: 'AWS session expired. Run `aws sso login`, then try again.' }`.
`!this.tauri.isDesktop` yields
`{ ok: false, kind: 'not-desktop', message: 'AWS calls require the desktop app. The browser preview cannot reach your Trigger API.' }`
before any invoke, and an empty `cloudAwsDirectory` yields `not-configured`.

## 6. CloudService transport seam

### The seam type

Two collaborating types, both in leaf modules with no `inject`.

```ts
// frontend/src/app/core/deploy/cloud-transport.ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface CloudTransportResponse { status: number; ok: boolean; body: string; }

/** The seam. One implementation per credential model, never per endpoint. */
export interface CloudTransport {
  readonly id: 'fetch-bearer' | 'aws-cli';
  send(url: string, init: { method: HttpMethod; body?: string }): Promise<CloudTransportResponse>;
  monitorSocketUrl(instanceBase: string, workflowId: string): Promise<string>;
}
```

```ts
// frontend/src/app/core/deploy/deploy-targets.ts  (extended)
export type CloudOperation =
  | 'push-spec' | 'push-connections' | 'read-connections' | 'trigger' | 'purge'
  | 'status' | 'run-history' | 'run-detail' | 'usage' | 'put-secret' | 'list-secret-names';

export interface CloudEndpointContext {
  workflowId: string;
  runId?: string;
  connectionId?: string;
  secretKey?: string;
  since?: string;
  continuationToken?: string;
}

export interface CloudEndpointSpec {
  method: HttpMethod;
  /** 'instance' resolves against instanceUrl(base, id); 'root' against the base. */
  scope: 'instance' | 'root';
  path(ctx: CloudEndpointContext): string;
  /** Reshapes the logical payload for this host. */
  body?(payload: unknown, ctx: CloudEndpointContext): unknown;
  /** Normalizes this host's response body into the shape the Studio consumes. */
  unwrap?(parsed: unknown): unknown;
}

export type CloudEndpoints = Readonly<Partial<Record<CloudOperation, CloudEndpointSpec>>>;
```

`DeployTarget` gains `endpoints: CloudEndpoints`. The Cloudflare targets declare the routes that
exist today (`POST /workflow`, `POST /connections`, `GET /connections`, `POST /trigger`,
`DELETE /workflow/purge`, `GET /status`, `GET /usage`, and the root-scoped
`/api/connection-secrets`). The `aws` target declares the eight Trigger_Routes, folds
`push-connections` into `push-spec` (whose body is
`{ workflowId, spec, connections }`, exactly what `handleSpecPush` reads), and **omits** `status`
and `list-secret-names`, because AWS has no such route and the design will not invent a ninth one to
paper over that. An omitted operation is a first-class state: `refreshStatus` leaves
`deployedStatus` at `null`, which the existing contract already defines as "unknown, never read as
not deployed", and `connectionSecretNames()` returns `[]`.

### One call site per endpoint

`CloudService` gains one dispatcher and every endpoint call goes through it:

```ts
private readonly transport = computed<CloudTransport>(() =>
  this.provider() === 'aws' ? this.awsTransport : this.fetchTransport);

private async call<T>(
  op: CloudOperation,
  ctx: CloudEndpointContext,
  payload?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string } | { ok: 'unsupported' }>;
```

`call` resolves the endpoint spec from `DEPLOY_TARGETS[provider].endpoints`, returns
`{ ok: 'unsupported' }` when absent, builds the URL from `instanceUrl` or the base according to
`scope`, applies `body`, dispatches through `this.transport()`, then parses and applies `unwrap`.
`fetchTransport` is a thin object closing over `fetch` and the existing `headers()`; `awsTransport`
closes over `AwsRequestService`. Neither branch is visible at the call sites: `pushWorkflow`,
`pushConnectionMetadata`, `fetchConnectionInventory`, `triggerHttp`, `removeWorkflow`,
`fetchDeployedStatus`, `listRuns`, `runDetail`, `usage`, `putConnectionSecret` and
`connectionSecretNames` each keep exactly one.

Two defect fixes travel with the seam:

```ts
private instanceUrl(workflowId: string): string | null {
  const target = DEPLOY_TARGETS[this.provider() ?? 'cloudflare'];
  const base = this.effectiveWorkerUrl();
  if (!base) return null;
  return target.instanceUrl(base, workflowId || 'default');
}

readonly effectiveWorkerUrl = computed(() => {
  const provider = this.provider();
  if (provider === 'phorma') return this.phormaCloudUrl();
  if (provider === 'aws') return this.awsConfig.triggerApiUrl();
  return this.workerUrl();
});

readonly configured = computed(() => {
  const provider = this.provider();
  if (provider === 'phorma') return this.phormaCloudUrl().length > 0;
  if (provider === 'cloudflare') return this.workerUrl().length > 0;
  if (provider === 'aws') {
    return this.awsConfig.valid() && this.awsConfig.triggerApiUrl().length > 0;
  }
  return false;
});
```

The hardcoded `${base}/agents/workflow-agent/${id}` is gone; the registry's `instanceUrl` is the only
place a deployed-instance URL is shaped, which is what it was written for. `CloudService` now injects
`AwsDeployConfigService` and `AwsRequestService`, both of which sit below it and inject neither it nor
`RunControllerService`, so the known NG0200 cycle is untouched.

Push-time capability validation needs no change beyond the seam: `pushWorkflow` already reads
`DEPLOY_TARGETS[provider].capabilities`, which for `aws` is `AWS_CAPABILITIES`, and already blocks on
error-severity findings while letting warnings through. What changes is that the inventory it
validates against now comes from `GET /workflows/{id}/connections` through the AWS transport.

`engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts` are untouched by this feature, so
the structural twins stay in sync by not moving.

## 7. Monitor connection

`connect()` keeps its single socket, its `onmessage` handler and its `RunControllerService.apply`
call verbatim. Only the URL derivation branches:

```ts
const socketUrl = this.provider() === 'aws'
  ? await this.transport().monitorSocketUrl(base, targetId)   // presigned wss, no token param
  : this.tokenSocketUrl(base, await this.resolveAuthToken()); // existing ?token= shape
```

`awsTransport.monitorSocketUrl` calls `AwsRequestService.monitorUrl(workflowId)`, which runs
`npx phorma-aws monitor-url <workflowId>` through the Deploy_Runner and decodes the result with the
same `decodeSentinelEnvelope` the request path uses. A failed presign shows
`this.toast.error('Monitor unavailable', message)` and returns before `new WebSocket(...)`, so no
socket is opened. Because the presign happens inside `connect()`, every reconnect attempt presigns
afresh, which is what makes an expired 300 second URL recover on its own.

`cli/monitor-url.ts` presigns the `$connect` request for `execute-api` with `expiresIn: 300`, formats
it with `@aws-sdk/util-format-url`, and emits one envelope line. The `workflowId` query parameter is
part of the signed URL.

### Monitor_API construct fixes

The three request templates stop referencing the non-existent authorizer context and start using
values that IAM-authorized routes actually carry.

- `$connect` reads the workflow id from the signed query string with `$input.params('workflowId')`
  and writes `{ pk: 'wf#<id>', sk: 'conn#<connectionId>' }`, plus a `ttl` computed as
  `#set($ttl = $context.requestTimeEpoch / 1000 + 7200)` so it is epoch seconds two hours out.
- `$default` reads the workflow id from the frame body with `$input.path('$.workflowId')` and writes
  `{ pk: 'wf#<id>', sk: 'frame#<paddedTime>#<connectionId>#0000' }` with a one hour `ttl` in
  seconds. The Studio's frame sender therefore adds a `workflowId` member to every ControlFrame it
  sends over an AWS socket. `parseFrame` only inspects `type` and the union's own fields, so the
  five frame kinds are unchanged and the Cloudflare path is unaffected.
- `$disconnect` becomes a MOCK integration. The query string is not available outside `$connect`, so
  the integration cannot address the workflow partition, and inventing a reverse-index partition
  would break the invariant that `pk` is always `wf#{workflowId}`. Stale connection records are
  pruned by the two hour TTL and, sooner, by the `GoneException` path in `MonitorAdapter.push`,
  which Requirement 8.7 already mandates.

This keeps every write inside the `wf#{workflowId}` partition and keeps the Frame_Inbox drain a
single prefix query.

## 8. Settings information architecture

### Three cards, three tabs

`pickCloudProvider(choice: DeployTargetId)` replaces the `'phorma' | 'cloudflare'` literal union, so
the handler accepts `'aws'` by type as well as at runtime. The unselected state renders three
`phorma-settings__provider-card` buttons and the selected state renders three
`phorma-settings__provider-tab` buttons, both driven by the same markup pattern already in place.
Copy:

- Phorma Cloud, labelled `Managed`. Existing copy unchanged.
- Your own Cloudflare, labelled `Bring your own`. Existing copy unchanged.
- Your own AWS, labelled `Bring your own`, icon `ti ti-brand-aws`, copy: "Deploy the runtime to your
  own AWS account on ECS Fargate. You own the account, the keys and the bill. Your platform team
  issues the identifiers."

### AWS body section

Rendered inside `@if (settings.cloudProvider() === 'aws')`, reusing the classes the Cloudflare body
already uses (`phorma-settings__cloud-setup`, `__cloud-setup-intro`, `__input`, `__input--mono`,
`__input--invalid`, `__hint`, `__note`). No new class and no new SCSS block: the
`anyComponentStyle` budget is 20kB warning and 24kB error, and `settings-dialog.scss` is the largest
sheet in the app, so a per-field style block is the wrong place to spend it. Field groups, in order:

1. **Account and region.** `accountId`, `region`, `namePrefix`.
2. **Platform prerequisites.** `permissionsBoundaryArn`, `bootstrapQualifier`, `vpcId`, `subnetIds`
   (comma-separated input, split on write), `appCmkArn`, `notificationTargetArn`. Group intro line:
   "Your platform team issues these from the request template in `docs/deploy-aws.md`. The Studio
   creates none of them."
3. **Operations.** `tagSet` (key and value rows), `retentionDays`.
4. **Container image.** `imageUri`, optional. When populated, a `__note` reads "The deploy will
   reference this image and run no local image build." When empty, "The deploy builds the image from
   `cloud-aws/Dockerfile` and needs a running Docker daemon."
5. **Local paths.** `cloudAwsDirectory` with the existing folder-picker button.
6. **Discovered endpoints.** `triggerApiUrl` and `monitorApiUrl` rendered `readonly` on
   `__input--mono`. While either is empty: "Push, runs and live monitoring stay unavailable until a
   deploy completes."

Validation display: each field renders its own `__hint` message naming the field and the expected
shape when its validator fails, and the control carries `__input--invalid`. Above the actions, an
aggregate line reads "3 fields need attention" whenever `awsConfig.valid()` is false, computed from
the same per-field validity signals rather than a second source of truth.

Every PrimeNG control carries an explicit `size="small"` (`pSize="small"` on `pInputText`), and every
icon is a Tabler `ti ti-*`. The invalid count and the image notice are `computed()`, so no effect
reads and writes the same signal. The one effect in this area, the discovered-endpoint persistence,
wraps its writes in `untracked()`.

### Browser parity

The AWS card, the tab and the whole body section render under plain `ng serve`. `isDesktop` is false
there, so the section renders a `__note` reading "Deploying to AWS runs the AWS CLI and CDK on your
machine. Use the desktop app to plan, deploy or run doctor." and the Plan, Deploy and Doctor controls
render `[disabled]="true"`. Fields stay editable so an operator can prepare a configuration in the
browser and deploy later from the desktop app.

## 9. Cloud dialog AWS body section

Rendered inside the existing `@if (provider() === 'aws')` branch, below the header that already
carries the AWS copy and the Region line.

- **Plan and deploy.** One primary button, `phorma-btn-content`, labelled "Plan and deploy", calling
  a component method that writes the Deploy_Config_File first, then
  `awsCli.planAndDeploy(dir, entryExists, egressAllowList)`. That entry point already runs plan,
  refuses to offer deploy on a non-zero plan, and asks `ConfirmDialogService` before deploying, so
  the dialog adds no second ordering rule.
- **Doctor.** A `[text]` button calling `awsCli.runCommand(doctorCommand)`.
- **Loading.** All three controls are `[disabled]="awsCli.running() || !isDesktop || !awsConfig.valid()"`,
  and the active one shows `<i class="ti ti-loader-2 phorma-icon-spin">`.
- **Cancel.** None is offered, and the design says so rather than implying one exists: the
  Deploy_Runner exposes no cancellation for `run_streamed_command`, and killing a `cdk deploy`
  mid-flight is worse than letting it settle. The affordance instead is a line reading "Running.
  Output is streaming to the console." with a button that opens the run console.
- **Endpoints.** The two discovered URLs render read-only, with the same unavailable notice as
  Settings when either is absent.
- **Desktop-only hint.** When `!isDesktop`, a `__note` reading "Deploying to AWS needs the desktop
  app." above the disabled controls.

## 10. Check pipeline guard

Two new guard scripts, both plain Node, both credential-free and Docker-free.

`cloud-aws/scripts/check-adapter-real.mjs` asserts:

1. No file under `src/aws/` (excluding `*.spec.ts`) has an import specifier containing `/test/` or
   ending in `fake-run-table.js`, `fake-monitor.js`, `fake-secrets-manager.js` or
   `fake-scheduler.js`.
2. No file under `src/aws/` (excluding `*.spec.ts`) contains an identifier matching `\bFake[A-Z]\w*`.
3. For each of the ten `RUNTIME_HOST_CAPABILITIES` names, the module declared as its owner in
   `src/aws/capability-map.json` exists and contains at least one `@aws-sdk/` import specifier.
4. `src/server/index.ts` exists and contains both `createServer` imported from `node:http` and a
   `.listen(` call.
5. `cloud-aws/Dockerfile` exists, installs `curl`, and its `CMD` names the bundled server entry.
6. No file under `src/core/` contains an `@aws-sdk/` specifier or an import of `node:fs`,
   `node:http`, `node:net` or `node:child_process`, which pins the purity of the pure layer.
7. No file matching `bootstrap` exists under `cloud-aws/`, so the package cannot grow a script that
   creates a Platform_Prerequisite.

`cloud-aws/scripts/check-imports-declared.mjs` asserts that every bare import specifier under
`bin/`, `src/aws/` and `src/cli/` (static or dynamic, value or type) resolves to a package declared
in `cloud-aws/package.json` at an exact version with no `^` or `~`. This is the guard that would have
caught today's state, where `plan`, `request`, `monitor-url` and `doctor` import eight packages the
manifest never declared.

The chain becomes:

```json
"check": "tsc --noEmit && cdk synth --quiet && vitest --run src/infra && node scripts/check-no-scan.mjs && node scripts/check-adapter-real.mjs && node scripts/check-imports-declared.mjs && node scripts/check-engine-purity.mjs && node scripts/check-engine-alias.mjs && node scripts/check-versions.mjs && node scripts/check-docs.mjs"
```

The two new guards sit immediately after `check-no-scan.mjs`, so the cheap static guards cluster and
a violation is reported before the slower engine and docs guards run. `cdk synth --quiet` runs twice
in the tasks that cover Requirement 4.4, once per image path, driven by a context override.
`.github/workflows/ci.yml` already runs `cloud-aws`'s `check`; the tasks add the second synth and
`npm test` for the package.

## Data models

### Deploy_Config_File (`cdk.context.phorma.json`)

Pure JSON, no leading comment lines, parseable by a single `JSON.parse`. The provenance notice moves
inside the object as a string member, which is the whole fix for Requirement 3:

```json
{
  "$generatedBy": "Phorma Agent Studio Settings > Cloud. Generated file, gitignored, rewritten on every Plan and Deploy. Delete it to reset.",
  "accountId": "123456789012",
  "region": "eu-west-1",
  "namePrefix": "acme-agents",
  "permissionsBoundaryArn": "arn:aws:iam::123456789012:policy/PlatformBoundary",
  "bootstrapQualifier": "phorma",
  "appCmkArn": "arn:aws:kms:eu-west-1:123456789012:key/2f9a...",
  "vpc": { "id": "vpc-0a1b2c3d4e5f60718", "subnetIds": ["subnet-0a1b...", "subnet-0c2d..."] },
  "egressAllowList": ["api.anthropic.com"],
  "costAllocationTags": { "app": "phorma", "owner": "ops" },
  "retentionDays": 30,
  "alarmNotificationArn": "arn:aws:sns:eu-west-1:123456789012:platform-alarms",
  "imageUri": "123456789012.dkr.ecr.eu-west-1.amazonaws.com/platform/phorma-host:1.4.2",
  "triggerApiUrl": "https://abc123.execute-api.eu-west-1.amazonaws.com",
  "monitorApiUrl": "wss://def456.execute-api.eu-west-1.amazonaws.com/live"
}
```

`parseAwsDeployConfig` ignores `$generatedBy` and gains three optional fields:

```ts
export interface AwsDeployConfig {
  // ... existing fields unchanged
  /** OCI reference: {registry}/{repository}:{tag} or {registry}/{repository}@sha256:{digest}. */
  imageUri?: string;
  /** Discovered Trigger_API base. https only. */
  triggerApiUrl?: string;
  /** Discovered Monitor_API socket URL. wss only. */
  monitorApiUrl?: string;
}
```

Accepted shapes, enforced identically by `AwsDeployConfigService` and `Config_Parser`:

| Field | Rule |
|---|---|
| `imageUri` | `^[a-z0-9.-]+(:\d+)?(/[a-z0-9._/-]+)+(:[A-Za-z0-9._-]{1,128}\|@sha256:[a-f0-9]{64})$` |
| `triggerApiUrl` | Parses as a URL, scheme exactly `https:`, no query, no fragment, no trailing slash |
| `monitorApiUrl` | Parses as a URL, scheme exactly `wss:`, no query, no fragment |

A mismatch raises `ConfigError` naming the field, the supplied value and the expected shape.

### Sentinel_Envelope payloads

Three payload kinds, each a JSON object with a `kind` discriminator so one decoder serves all of
them:

```ts
type SentinelPayload =
  | { kind: 'http-response'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'monitor-url'; url: string; expiresInSec: 300 }
  | { kind: 'deploy-outputs'; triggerApiUrl?: string; monitorApiUrl?: string; missing: string[] };
```

### CloudFormation outputs

```ts
// cloud-aws/src/core/outputs.ts
export const TRIGGER_API_OUTPUT = 'TriggerApiUrl';
export const MONITOR_API_OUTPUT = 'MonitorApiUrl';
export const REQUIRED_OUTPUTS = [TRIGGER_API_OUTPUT, MONITOR_API_OUTPUT] as const;
```

## Error handling

| Failure | Surface | Behaviour |
|---|---|---|
| Field validator fails | AWS_Config_Form | Per-field message naming the field and shape; aggregate count; Plan and Deploy disabled. |
| `ConfigError` from Config_Parser | CLI stderr | Message written verbatim, exit 1, no `cdk` step. |
| Docker daemon unreachable, asset path | Preflight | One failure line naming Docker and the `imageUri` alternative, exit 1, no `cdk` step. |
| Platform_Prerequisite absent | Preflight | One line per absent item naming the field, the value, the region and the `docs/deploy-aws.md` item, all failures reported in one run, exit 1. |
| AWS session expired | `doctor`, `request` | Exit 4, mapped by the Studio to a message naming `aws sso login`. |
| Deploy output missing | AwsCliService | Warning naming the missing output; stored endpoints unchanged. |
| Sentinel gap | AwsRequestService | `{ ok: false, kind: 'envelope' }` naming the missing sequence number; caller treats it as a transport failure, never as an HTTP status. |
| HTTP error status from Trigger_API | AwsRequestService | `{ ok: true }` carrying the status; `CloudService.call` maps it to `{ ok: false, status, error }` so a 409 stays distinguishable from a broken pipe. |
| Browser preview | AwsRequestService, AwsCliService | Refusal naming the desktop app before any invoke. |
| Startup capability missing | Server_Entry | Every missing capability name to stderr, exit 1, listener never created, target never healthy. |
| Missing environment variable | Server_Entry | Every missing name to stderr, exit 1. |
| Unmatched route | Server_Entry | 404 with the method and path in the body. |
| Handler throw | Server_Entry | 500 with a generic body, one structured log line, listener keeps serving. |
| Lease held by another Runner | `trigger` route | One unfenced skip record, HTTP 409, no further Run_Table write for that run. |
| Lease state indeterminate | `trigger` route | HTTP 503 with a distinct message, never 409. |
| Monitor connection gone | MonitorAdapter | Connection record deleted, remaining pushes continue, run unaffected. |
| Presign failure | CloudService | Toast naming the failure, no WebSocket opened. |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system, essentially a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Reflection applied before writing this list: the route-matcher totality and the render-then-match
inversion were merged into one property because the inversion is the natural witness for uniqueness;
the "explicit small size and Tabler icons" claim was merged into the AWS form field totality property
because both quantify over the same rendered control set; and the endpoint-persistence and
config-rewrite claims were merged because the rewrite is only observable as a round trip through the
persisted file. Properties covering the ten capability implementations, the version pins and the
layer boundaries are expressed as static-scan properties over the file set rather than as runtime
properties, because that is where their universal quantification actually lives.

Packages and tools: `cloud-aws` properties run under vitest 4 with fast-check 4 at a minimum of 100
iterations, against the fakes through the new port implementations. Frontend properties run under
karma with jasmine using exhaustive enumeration over the closed input sets, because fast-check is not
available in that package.

### Property 1: Sentinel envelope round trip

For any payload string, decoding the lines produced by `encodeSentinelEnvelope` yields exactly that
payload, the emitted sequence numbers are the contiguous range `0..n-1`, and at least one line is
always emitted including for the empty payload.

Package: `cloud-aws/src/core/sentinel.spec.ts`

**Validates: Requirements 10.4, 10.5**

### Property 2: Sentinel gap detection names the first missing sequence

For any complete line set and any single mutation of it (one line removed, one sequence number
duplicated with different content, or one sequence number replaced by a value beyond the range),
decoding fails and the failure names the lowest missing sequence number.

Package: `frontend/src/app/core/deploy/sentinel-envelope.spec.ts`

**Validates: Requirements 10.6**

### Property 3: Cross-package decoder agreement

For every entry in the committed corpus fixture, the Studio decoder reproduces the payload the
`cloud-aws` encoder produced, so the two implementations of the wire format cannot drift apart
silently.

Package: `frontend/src/app/core/deploy/sentinel-envelope.spec.ts` over
`cloud-aws/test/fixtures/sentinel-corpus.json`

**Validates: Requirements 10.5, 11.3**

### Property 4: Route matcher is total, unique and inverts renderRoute

For any method string and any path string, `matchRoute` returns without throwing and matches at most
one route definition. For any route id and any parameter values drawn from non-empty printable
strings, matching `renderRoute(id, params)` with that route's method yields that route id and exactly
those parameter values.

Package: `cloud-aws/src/core/route-table.spec.ts`

**Validates: Requirements 7.4, 7.5**

### Property 5: A handler throw is contained

For any of the eight routes and any thrown value, the response status is 500, the response body
carries no detail from the thrown value, and a subsequent `GET /health` request still answers 200.

Package: `cloud-aws/src/server/index.spec.ts`

**Validates: Requirements 7.6**

### Property 6: Container image path switch

For any deployment configuration, `resolveContainerImage` yields the asset choice exactly when
`imageUri` is absent and the reference choice carrying that exact value exactly when it is present,
and never a third outcome.

Package: `cloud-aws/src/core/container-image.spec.ts`

**Validates: Requirements 4.1, 4.2**

### Property 7: Preflight reports every failure, each naming its prerequisite

For any subset of the checked prerequisites marked absent or disabled, the preflight result's failure
identifier set equals that subset exactly, `passed` is true only for the empty subset, and every
failure line contains the AWS_Config_Field name, the supplied value, the target region and the
matching `docs/deploy-aws.md` request-template item.

Package: `cloud-aws/src/infra/preflight.spec.ts`

**Validates: Requirements 5.2, 5.3, 5.4**

### Property 8: Every run-scoped write is fenced

For any sequence of Host_Adapter operations performed while holding a lease, every recorded
Run_Table write other than the skip record is a `TransactWriteItems` whose items include a
`ConditionCheck` on `{ pk: wf#{workflowId}, sk: 'lease' }` asserting equality with the held fencing
token.

Package: `cloud-aws/src/aws/run-table.spec.ts`

**Validates: Requirements 8.4**

### Property 9: The losing Runner writes exactly one unfenced record

For any interleaving of two Runners contending for one workflow, the Runner whose acquire fails
writes exactly one Run_Table item, that item is the unfenced skip record, its response status is 409,
and it performs no further write for that run.

Package: `cloud-aws/src/server/trigger-contention.spec.ts`

**Validates: Requirements 8.5, 15.6**

### Property 10: Condition compilation is sound

For any core `ConditionNode` and any candidate item, evaluating the node directly and evaluating the
compiled DynamoDB condition expression with its name and value maps against the same item produce the
same verdict.

Package: `cloud-aws/src/aws/table-ops-compile.spec.ts`

**Validates: Requirements 8.4**

### Property 11: Every read is partition-scoped

For any sequence of Host_Adapter read operations, every recorded request is a `GetItem` or a `Query`,
each carries a partition key value, and none is a `Scan`.

Package: `cloud-aws/src/aws/run-table.spec.ts`

**Validates: Requirements 8.6**

### Property 12: Monitor fan-out and stale pruning

For any set of connections for a workflow and any subset of them stale, pushing one RunEvent delivers
it exactly once to each live connection, delivers it to no connection of any other workflow, deletes
exactly the stale connection records, and resolves successfully including when the set is empty.

Package: `cloud-aws/src/aws/monitor.spec.ts`

**Validates: Requirements 8.7**

### Property 13: Frame drain preserves arrival order

For any set of Frame_Inbox items with arbitrary arrival timestamps, connection ids and counters, the
drain delivers the parseable frames to the Runner in ascending arrival-key order and deletes every
drained item.

Package: `cloud-aws/src/server/frame-drain.spec.ts`

**Validates: Requirements 7.7**

### Property 14: Startup names every unsatisfied capability

For any subset of the ten Runtime_Host_Contract capabilities left unimplemented, startup fails and
the reported capability names equal that subset exactly.

Package: `cloud-aws/src/server/startup.spec.ts`

**Validates: Requirements 7.3**

### Property 15: Startup names every missing environment variable

For any subset of the required task-definition environment variables omitted, `readServerEnv` throws
and the reported names equal that subset exactly.

Package: `cloud-aws/src/server/env.spec.ts`

**Validates: Requirements 7.9**

### Property 16: Config parser accepts exactly the documented endpoint and image shapes

For any candidate string, `parseAwsDeployConfig` accepts `imageUri`, `triggerApiUrl` and
`monitorApiUrl` exactly when the string matches that field's documented shape and scheme, and every
rejection raises a `ConfigError` whose message names the field.

Package: `cloud-aws/src/core/config.spec.ts`

**Validates: Requirements 2.6, 2.8, 2.9**

### Property 17: Deploy_Config_File round trips through a bare JSON.parse

For any combination of populated and empty AWS_Config_Fields, `JSON.parse(buildConfigFile())`
succeeds with no preprocessing, the emitted text contains no line beginning with `//`, the parsed
object carries the provenance notice as a string member, and every populated field appears with its
trimmed value.

Package: `frontend/src/app/core/deploy/aws-deploy.spec.ts`

**Validates: Requirements 3.1, 3.2, 3.5**

### Property 18: The AWS form covers every field with the required chrome

For every member of the AWS_Config_Field set, the rendered AWS body section contains exactly one
control whose label is associated with it, editing it stores the trimmed value, an invalid value
renders a message naming that field, every PrimeNG control in the section carries an explicit small
size, and no element in the section carries a non-Tabler icon class.

Package: `frontend/src/app/workspace/settings/settings-dialog/settings-dialog.aws.spec.ts`

**Validates: Requirements 1.9, 2.1, 2.2, 2.3**

### Property 19: Aggregate validity truth table

For every vector of field states drawn from missing, invalid and valid across the required and
optional fields, the aggregate validity value is true exactly when every required field is populated
and every populated field passes its validator, and the displayed count equals the number of missing
or invalid fields.

Package: `frontend/src/app/core/deploy/aws-deploy.spec.ts`

**Validates: Requirements 2.4, 2.5**

### Property 20: Endpoint discovery persists or preserves

For any deploy outputs document, when both required output names are present the two config fields
equal those values and the rewritten Deploy_Config_File round trips them through a bare `JSON.parse`;
when either is absent the message names each missing output and both previously stored values are
unchanged.

Package: `frontend/src/app/core/deploy/aws-deploy.spec.ts`

**Validates: Requirements 9.2, 9.3, 9.4**

### Property 21: Transport seam selects by target only

For every Deploy_Target value and every supported cloud operation, the seam dispatches through the
AWS CLI transport exactly when the target is `aws` and through fetch with a bearer header otherwise,
the monitor socket URL carries the token query parameter exactly for the two Cloudflare targets, and
in the AWS case the call proceeds and completes regardless of the value of the Plan and Deploy
concurrency signal, which is never written.

Package: `frontend/src/app/core/cloud.service.spec.ts`

**Validates: Requirements 1.6, 10.8, 10.10, 11.4**

### Property 22: Deployed URLs come from the registry

For every Deploy_Target value, every workflow id and every supported operation, the URL the service
requests equals `DEPLOY_TARGETS[target].instanceUrl(base, id)` joined with the path that target's
endpoint spec yields, and no URL is produced by a literal path in the service.

Package: `frontend/src/app/core/cloud.service.spec.ts`

**Validates: Requirements 12.4, 12.6**

### Property 23: configured() truth table

For every Deploy_Target value crossed with the aggregate-validity and endpoint-presence states,
`configured()` is true exactly under the conditions the requirements state for that target, and for
`aws` requires both aggregate validity and a populated `triggerApiUrl`.

Package: `frontend/src/app/core/cloud.service.spec.ts`

**Validates: Requirements 12.5**

### Property 24: Under-supplied verbs print usage and fail

For every CLI verb and every argument count below that verb's arity, the verb writes a usage line
naming the verb and its arguments to stderr, exits non-zero, and performs no AWS call.

Package: `cloud-aws/src/cli/main.spec.ts`

**Validates: Requirements 6.4**

### Property 25: Every import specifier is declared at an exact version

For every bare import specifier appearing under `bin/`, `src/aws/` and `src/cli/`, whether static or
dynamic, value or type-only, `cloud-aws/package.json` declares that package with a version carrying
no range prefix.

Package: `cloud-aws/scripts/check-imports-declared.spec.ts` (the guard applied to the real tree and
to seeded violating fixtures)

**Validates: Requirements 6.1, 6.3, 8.8**

### Property 26: Layer boundaries hold across the file set

For every file under `src/core/` there is no `@aws-sdk` specifier and no I/O module import; for every
non-spec file under `src/aws/` there is no import from `src/test/` and no identifier matching
`Fake[A-Z]`; and for each of the ten capability names its owning module under `src/aws/` exists and
carries at least one `@aws-sdk` import.

Package: `cloud-aws/scripts/check-adapter-real.spec.ts`

**Validates: Requirements 8.1, 8.10, 13.1, 13.2**

### Property 27: Run history is descending by start time

For any set of run records with arbitrary start times, the summaries returned by the history read are
non-increasing by start time across page boundaries, and no record appears twice.

Package: `cloud-aws/src/aws/run-table.spec.ts`

**Validates: Requirements 15.4**

### Property 28: RunEvents reach the run controller untransformed

For every RunEvent shape in the enumerated corpus, the object the monitor socket handler passes to
`RunControllerService.apply` is deep-equal to the parsed frame, and the `monitor-synced` sentinel is
never passed.

Package: `frontend/src/app/core/cloud.service.spec.ts`

**Validates: Requirements 11.6**

### Property 29: Capability findings gate the push

For any set of capability findings, the push proceeds exactly when the set contains no
error-severity finding, and every finding in the set is written to the Problems console either way.

Package: `frontend/src/app/core/cloud.service.spec.ts`

**Validates: Requirements 12.2, 12.3**

## Testing Strategy

### Verification commands

```powershell
cd cloud-aws; npm run check     # tsc, two synths, infra suite, six static guards
cd cloud-aws; npm test          # vitest --run: core, aws, server, infra suites
cd frontend;  npm run build     # the only thing that checks the anyComponentStyle budget
cd frontend;  npm test -- --watch=false --browsers=ChromeHeadless
cd engine;    npm test          # unchanged, run to prove no engine regression
npx -y tsx cloud-aws/test/server-e2e.e2e.mts        # loopback HTTP against fake clients
npx -y tsx cloud-aws/test/lease-contention.e2e.mts  # existing, must stay green
```

`cargo check` is not required: no Rust file changes. Run it only if the `ALLOWED_PROGRAMS`
allow-list is ever touched, which this feature does not need.

### Which suite covers what

| Area | Suite | Kind |
|---|---|---|
| Envelope format | `src/core/sentinel.spec.ts`, frontend `sentinel-envelope.spec.ts` | Properties 1, 2, 3 |
| Route dispatch | `src/core/route-table.spec.ts`, `src/server/index.spec.ts` | Properties 4, 5, plus 404 and health examples |
| Image switch | `src/core/container-image.spec.ts`, `src/infra/template.spec.ts` | Property 6, plus the two template assertions and the asset-manifest assertions |
| Preflight | `src/infra/preflight.spec.ts` | Property 7, plus the Docker-probe example |
| Fencing and reads | `src/aws/run-table.spec.ts`, `src/aws/table-ops-compile.spec.ts`, `src/server/trigger-contention.spec.ts` | Properties 8, 9, 10, 11, 27 |
| Monitor push | `src/aws/monitor.spec.ts` | Property 12 |
| Frame drain | `src/server/frame-drain.spec.ts` | Property 13 |
| Startup and env | `src/server/startup.spec.ts`, `src/server/env.spec.ts` | Properties 14, 15 |
| Config parsing | `src/core/config.spec.ts` | Property 16 |
| CLI verbs | `src/cli/main.spec.ts` | Property 24, plus the four `doctor` exit-code examples and the ordering example for plan before diff |
| Static guards | `scripts/check-adapter-real.spec.ts`, `scripts/check-imports-declared.spec.ts` | Properties 25, 26, each run against the real tree and against seeded violating fixtures |
| Studio config and discovery | `core/deploy/aws-deploy.spec.ts` | Properties 17, 19, 20, plus the existing exit-code-4 and browser-refusal examples |
| Studio transport | `core/cloud.service.spec.ts` | Properties 21, 22, 23, 28, 29 |
| Settings surface | `settings-dialog.aws.spec.ts` | Property 18, plus the browser-parity and disabled-control examples |
| End to end | `test/server-e2e.e2e.mts` plus the manual journey in `docs/deploy-aws.md` | Integration: real Server_Entry over loopback against fake clients; live account for the deploy, push, trigger, history and streaming journey |

The existing `aws-deploy.spec.ts` case that strips `//` lines before parsing is deleted, not adapted.
It encoded the bug, and Property 17 replaces it with the assertion that the emitted text needs no
preprocessing at all.

### Integration and smoke coverage the properties deliberately do not carry

SigV4 signature validity, CloudWatch log content, API Gateway service integrations, the 2 second
streaming latency and the credential-free plus Docker-free execution of the check pipeline are
verified by one or two observations each, not by a hundred iterations. They exercise AWS behaviour
rather than this repository's logic, and repeating them adds cost without adding information.
