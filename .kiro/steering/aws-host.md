---
inclusion: fileMatch
fileMatchPattern: ["cloud-aws/**/*.ts", "cloud-aws/**/*.mjs", "cloud-aws/**/*.mts", "cloud-aws/package.json", "cloud-aws/tsconfig.json", "cloud-aws/cdk.json", "cloud-aws/vitest.config.ts"]
---

# AWS host detail

`cloud-aws/` is the AWS deployment target for Phorma Agent Studio. It runs the same `@phorma/engine`
as the desktop and Cloudflare hosts on ECS Fargate, backed by a DynamoDB single table and API Gateway
WebSocket/HTTP APIs. It is BYO only - single estate, single tenant, the operator's own AWS account.

## Five-layer boundary

| Layer | Path | Rule |
|---|---|---|
| `core/` | `src/core/` | Pure logic. Zero AWS SDK imports, zero I/O. Property-tested against `FakeRunTable`. |
| `aws/` | `src/aws/` | SDK clients. One file per service, thin translation of `core/` decisions into SDK calls. |
| `server/` | `src/server/` | Runner lifecycle, Trigger_API route handlers, startup contract assertion. |
| `infra/` | `src/infra/` | CDK constructs, synth-time Aspects. Template assertions and IAM deny-lists verify it. |
| `cli/` | `src/cli/` | The six verbs. May import `core/`, `aws/` and `infra/`. Nothing imports `cli/`. |
| `shim/` | `src/shim/` | The Schedule_Shim Lambda handler plus its esbuild builder. The handler imports NOTHING from this package. `cli/` and `infra/` import the builder for the asset path. |

Do not move logic across these boundaries. If a rule must hold for all inputs, it belongs in `core/`.
If it translates a decision into an SDK call, it belongs in `aws/`. Constructs and Aspects live in
`infra/` and are exercised through template assertions, not property tests (except Property 29 which
exercises the Aspects as pure functions over generated construct trees).

`VERB_SPECS` in `src/cli/main.ts` is the one verb table: `plan`, `deploy`, `request`, `monitor-url`,
`doctor`, `outputs`. `runVerb` returns an exit code and never calls `process.exit` - exiting mid-write
truncates the final Sentinel_Envelope line the Studio is waiting for.

`bin/phorma-aws.mjs` is a launcher and nothing else: it `tsImport`s `../src/cli/main.ts` and sets
`process.exitCode = await runVerb(process.argv.slice(2))`. It must never regain config parsing,
Sentinel_Envelope encoding or Preflight logic - the shim once carried untyped copies of all of it, and
that second implementation is what Requirement 3.3 forbids.

## Aspects must be registered, not just defined

`PhormaAwsHostStack` ends with six `cdk.Aspects.of(this).add(...)` calls. An Aspect that is exported
from `aspects.ts` but never registered is dead code: synthesis passes on a violating tree and every
guardrail it was meant to enforce is silently off. Register in the stack constructor, after every
construct (so the Aspect visits the complete tree) and after `Tags.of` (so `TagAspect` reads a
populated `TagManager`). `template.spec.ts` asserts all six are registered and that the real stack
synthesizes with no error annotation - keep those assertions passing rather than deleting them.

Every role in the estate carries the permissions boundary, including roles created outside
`IdentityConstruct` (for example `MonitorApi`'s integration role). `PermissionsBoundaryAspect` is
the backstop that catches an omission at synth time instead of at deploy time.

## Cron schedules go through the Schedule_Shim, never straight at a route

**EventBridge Scheduler has no API Gateway target.** Its templated targets are a closed list
(CodeBuild, CodePipeline, ECS `RunTask`, EventBridge `PutEvents`, Inspector, Kinesis, Firehose,
Lambda `Invoke`, SageMaker, SNS, SQS, Step Functions) and its universal target invokes AWS SDK
operations of the shape `arn:aws:scheduler:::aws-sdk:{service}:{operation}`. An `execute-api` ARN is a
valid target for an EventBridge **rule**, which is a different service. Pointing a schedule at the
Trigger_Route makes `CreateSchedule` fail, which fails the spec push, which is how cron was
undeployable for a whole release.

So the chain is: schedule fires, Scheduler invokes the `{prefix}-schedule-shim` Lambda, the shim mints
a fresh `runId` and SigV4-signs `POST /workflows/{id}/trigger`. Consequences to preserve:

- `PHORMA_SCHEDULE_TARGET_ARN` is the SHIM FUNCTION ARN. A template assertion fails if it ever names
  `execute-api` again.
- Scheduler_Invoke_Identity holds exactly `lambda:InvokeFunction` on that function. The
  `execute-api:Invoke` grant lives on the shim's own role, which is the identity that signs. Both
  single-action assertions still apply, to their own role.
- The `runId` is minted per fire, never stored on the schedule: a schedule's input is fixed at push
  time, so a baked-in id would repeat forever.
- The shim throws ONLY for a status a retry could fix. 409 (lease held) and 404 (no spec) resolve
  quietly. Throwing on 409 would raise the Lambda error metric every time the concurrency guard
  worked correctly.
- The shim reuses the existing trigger route rather than a second ingress. Do not add a queue drain
  that starts runs directly - that duplicates the lease acquire, the 409 answer and the skip record
  in `server/`.
- The orphan path (`ScheduleStore.handleScheduleFire`) is called by the trigger route AFTER the lease
  acquire, never before: Property 6 requires the lease write to be the first Run_Table operation with
  no preceding read, and the spec-presence check is a read.

## Cron dialect translation lives in `core/cron.ts`

`translateCron` is the single owner of the Unix-to-AWS conversion, and validation is the same pass as
translation. Three rules, each of which was previously broken in the direction that mattered:

- AWS cron is SIX fields with a trailing year. A five-field Unix expression gains `*`.
- AWS day-of-week is `1-7` from Sunday. Unix is `0-6` with `7` also Sunday, so AWS is `(unix % 7) + 1`.
- `*` may not appear in BOTH day fields. Exactly one of day-of-month and day-of-week carries `?`.

So `0 12 * * *` becomes `0 12 * * ? *`. Never "append a year wildcard" - that produces
`0 12 * * * *`, which AWS rejects. Never validate against Unix ranges - that accepts Sunday `0` and
rejects `?`, so the local check and AWS disagree in both directions.

`aws/scheduler-backend.ts scheduleExpression` adds the `cron(...)` wrapper and nothing else.

## Schedule names are workflow-scoped

`scheduleName(workflowId, nodeId)` is `sched-{16 hex of workflow}-{40 hex of node}`, and
`schedulePrefix(workflowId)` reproduces everything up to the separator. One schedule group holds
EVERY workflow, so `SchedulerBackend.listSchedules` takes a REQUIRED `namePrefix` and
`deleteAllForWorkflow` scopes to it.

This is not cosmetic. With a single opaque digest there was no way to ask which schedules belonged to
a workflow, and "replace this workflow's schedules" was implemented as "delete everything in the
group" - so pushing workflow B deleted workflow A's schedules, unrecoverably, since rollback only
undoes creates from the failing push. `FakeSchedulerBackend` honours the prefix deliberately: a fake
that ignored it would accept the bug again.

## Lease and fencing invariant

The correctness core of the package. A Durable Object is single-flight by platform guarantee;
on AWS that guarantee is built with a conditional-write Execution_Lease.

- Every run's first Run_Table operation is the lease acquire - a single conditional write that grants
  a strictly increasing Fencing_Token (`attribute_not_exists(pk) OR expiresAtMs <= :now`, with
  `fence = if_not_exists(fence, :zero) + 1`).
- Heartbeat at **10 seconds** (`HEARTBEAT_MS`), expiry at **60 seconds** (`LEASE_TTL_MS`).
- Every run-scoped Run_Table write is a `TransactWriteItems` with a `ConditionCheck` on the lease
  item asserting `fence = :mine`.
- The **only exception** is the unfenced skip record written when the lease acquire fails because
  another Runner holds it (HTTP 409, one `run-skipped` record).
- A Zombie Runner (whose fencing token is lower than the stored one) changes nothing: its writes are
  rejected, it stops node bodies within one heartbeat, and it reports `run-failed` naming lease loss.
- Release retains the fencing token and sets `expiresAtMs = now`, so the next acquire always sees the
  highest token ever issued.

When modifying any Run_Table write path, verify the write is fenced. If it is not fenced and it is
not the skip record, it is a bug.

## No-Scan rule

**No DynamoDB Scan operation anywhere in the package.** Every read addresses a single partition key.
This is enforced by `scripts/check-no-scan.mjs` (exits non-zero on violation) and by Property 26
against the `FakeRunTable` recorded request log.

When adding a new read path, use `Query` with the partition key, never `Scan`.

## Engine alias rule

`@phorma/engine` is the **only** route to engine source. No relative import crossing into
`../engine` is allowed. This ensures AWS_Host and Worker_Host run identical engine source resolved
through the tsconfig path alias.

Enforced by `scripts/check-engine-alias.mjs`.

## Engine purity rule

`engine/src/` has zero imports of any `@aws-sdk/*` package - value imports, type-only imports and
dynamic import expressions alike. The only AWS-derived identifiers allowed in `engine/src` are:
`aws-sigv4`, `bedrock`, `aws-secrets-manager`, `aws-fargate`, `awsSecretName`, `AWS_CAPABILITIES`.

Enforced by `scripts/check-engine-purity.mjs`.

## Check pipeline - `npm run check`

The whole chain runs with **no AWS credentials and no Docker daemon**, and exits non-zero on any
failure. This is the pre-deploy gate. In order:

1. `tsc --noEmit`
2. `npm run bundle:shim` (`tsx src/shim/build.ts`) - esbuild bundles
   `src/shim/schedule-shim.ts` into `dist/schedule-shim/`. This runs BEFORE both synths and the
   ordering is load bearing: `lambda.Code.fromAsset` on a missing directory fails synthesis with
   `CannotFindAsset`. Pre-bundling is also why the no-Docker guarantee holds - `NodejsFunction` would
   bundle at synth time and fall back to Docker when local esbuild resolution fails, making the
   guarantee depend on the machine.

   The builder lives in `src/shim/build.ts` and NOT under `scripts/` because
   `cloud-aws/scripts/` is not shipped in the installer while `src/` is, and a real operator deploy
   runs from an unpacked workspace with no checkout. `cli/plan.ts` and `cli/deploy.ts` call
   `bundleShimForCdk` before any `cdk` step for the same reason, so the bundle is rebuilt from the
   shipped source on every plan and deploy and can never be a stale artefact. `esbuild` is therefore a
   runtime `dependency`, not a devDependency.
3. `cdk synth --quiet` - the Container_Image ASSET path (`infra/app.ts` falls back to the
   placeholder config when no context is supplied). No context lookups, `fromVpcAttributes` never
   `fromLookup`.
4. `scripts/synth-image-reference.mjs` - the second synthesis, the Container_Image REFERENCE path.
   The two paths build different templates (asset fingerprints the `Dockerfile` and derives the
   Task_Execution ECR grant from the bootstrap repository; reference carries `imageUri` verbatim and
   parses the grant out of it), so one synth covers only half the switch. It spawns `cdk` with an
   argument array because the config travels as `--context phorma:config=<json>` and a JSON literal
   in an npm script is not portable across `cmd.exe` and `sh`. It fails if no
   `phorma-check-image-host` template appears, since a context that never arrives would make the
   step vacuous.
5. `vitest --run src/infra`, which covers:
   - Template assertions (`aws-cdk-lib/assertions`): resource inventory, table/API counts, VPC
     endpoints, `AssignPublicIp: DISABLED`, App_CMK encryption, route authorizers, portal throttle,
     `execute-api:ManageConnections` scope, alarms, bootstrap qualifier, the Schedule_Shim function
     (one, outside the VPC, App_CMK log group) and that `PHORMA_SCHEDULE_TARGET_ARN` names it rather
     than an `execute-api` route
   - Aspect wiring: all six guardrails registered on the stack, real stack synthesizes with no
     error annotation
   - IAM deny-list assertions: Runtime policy stays within Req 15.3, single `iam:PassRole` shape,
     Scheduler_Invoke_Identity single action, Task_Execution and Deployment policies
   - Property 29 (both halves): Aspects over generated construct trees, Plan_Command preflight
6. `check-no-scan.mjs` - no DynamoDB Scan anywhere
7. `check-adapter-real.mjs` - no fake-backed production code under `src/aws/`, every
   Runtime_Host_Contract capability has an owning adapter that really calls AWS, `src/core/` stays
   pure (no `node:fs`/`http`/`net`/`child_process`), and no module creates a Platform_Prerequisite:
   `PhormaAwsHostStack` is the only stack, nothing bootstraps, and the synthesized template declares
   no VPC, subnet, KMS key or boundary policy the operator already supplies. Creation-only -
   `fromVpcAttributes`, `fromKeyArn`, `fromManagedPolicyArn` and the bootstrap lookup all pass.
8. `check-imports-declared.mjs` - every bare specifier under `bin/`, `src/aws/`, `src/cli/` and
   `src/shim/` resolves to a package `package.json` declares at an exact pin. Catches static,
   type-only, dynamic and re-export forms. The reverse direction of `check-versions.mjs`: the CLI shim
   once imported eight undeclared packages, so four verbs died on module resolution in a fresh
   install.
9. `check-engine-purity.mjs` - no AWS SDK in `engine/`
10. `check-engine-alias.mjs` - engine resolves only through `@phorma/engine`
11. `check-versions.mjs` - five packages one version, every pin exact, `aws-cdk-lib` and `tsx` both
    in `dependencies`
12. `check-docs.mjs` - `docs/deploy-aws.md` section order, resource coverage derived from the
    synthesized template, troubleshooting strings derived from source

Step 5 is the reason `tsc --noEmit` alone is not enough: vitest does not type-check, so a spec file
can compile-fail while its tests pass. Both run.

`.github/workflows/ci.yml` runs `npm run check`, `npm test` and `npm run test:e2e` for this package
in the `checks` job,
after an install step of its own. Guards are only a gate once CI runs them - adding a guard means
keeping that job current.

Two synthesis traps:

- A CDK `--context key=value` argument arrives at the app as a **JSON string**, not an object.
  `infra/context-config.ts` accepts both and throws on a malformed string rather than falling back to
  the placeholder. A reader that accepts only an object silently synthesizes `phorma-check` into
  account `000000000000`.
- The second synth's `--output` must live **under** `cdk.out` (`cdk.out/image-path`). A sibling
  directory lands inside the repository-root image build context, so asset staging copies its own
  output forever and presents as `cdk synth` hanging.

Verification commands:

```powershell
cd cloud-aws; npm run check    # the full pipeline above
cd cloud-aws; npm test         # vitest --run (property + unit tests)
cd cloud-aws; npm run test:e2e # all 8 test/*.e2e.mts scenario scripts
```

## Testing

vitest 4 + fast-check 4, matching the versions `engine/` already pins.

- **Minimum 100 iterations** per property test.
- Property tests live beside their subject under `src/**/*.spec.ts` (`core/`, `aws/`, `server/`,
  `cli/`, `infra/`, plus three in `engine/src/`), and one beside each Check_Pipeline guard in
  `scripts/**/*.spec.ts`. `vitest.config.ts` `include` lists both roots -
  widen it when adding a spec outside `src/`, or it runs nowhere and `npm test` still reports
  success. `scripts/*.spec.ts` stays out of `tsconfig.json` `include`: it imports a `.mjs` guard and
  uses `node:` builtins the package has no `@types/node` for.
- Tag format: `// Feature: <spec>, Property N: <name>`. **Two specs own files in this tree**, so use
  the one that owns the file: `aws-deployment-target` built the host (lease, runner, `aws/` adapters,
  `infra/` constructs and roles, the `src/test/` fakes, most `test/*.e2e.mts`); `aws-byo-deploy`
  added the CLI, the `server/` HTTP entry, config parsing, the Sentinel_Envelope, the route table,
  frame drain and the Check_Pipeline guards. Property numbers are per-spec, so a bare `Property 9`
  is ambiguous without the feature tag. A file both specs touched carries both
  (`// Feature: aws-deployment-target, aws-byo-deploy`).
- Shared fixtures in `src/test/`:
  - `FakeRunTable` (`fake-run-table.ts`): reproduces DynamoDB conditional-write semantics,
    `TransactWriteItems` all-or-nothing, `Query` with page size, failure injection, recorded request
    log for partition/scan assertions. `FakeDocumentTableClient` is the same idea one level lower -
    it stands in for the `lib-dynamodb` client so the real `run-table.ts` is the code under test.
    `fake-monitor.ts`, `fake-secrets-manager.ts` and `fake-scheduler.ts` cover the other services.
    Production code under `src/aws/` may never import any of them (`check-adapter-real.mjs`).
  - Shared generators (`generators.ts`): edge cases for payload sizes (300 KB, 64 KB),
    state values (32,768 bytes, astral-plane), `ttlSec` (zero, negative, fractional, out of range),
    retention days (0, 367, 30.5), cron (blank, invalid), 51 schedule nodes, 0 and 32 secret keys.
- Scenario scripts: `test/*.e2e.mts`, run individually with
  `npx -y tsx cloud-aws/test/<name>.e2e.mts` from the repo root, or all eight with
  `npm run test:e2e`. They drive the real `runner.ts` and the real Server_Entry against
  `FakeRunTable` and fake AWS adapters. `vitest.config.ts` excludes `test/**`, so adding a script
  without it being picked up by `test/run-all.mjs` means it runs nowhere and `npm test` still
  reports success.
- The `tsx` hazard: awaiting a run whose `waitForEvent` never resolves hangs on an unsettled
  top-level await. Abandon the run and synchronise on a side-channel promise.

## Key design decisions

| Decision | Rationale |
|---|---|
| Single DynamoDB table | Access patterns are all `(workflowId, sortKey)`. No Scan needed. |
| 2 GSIs | GSI1: run history descending (100/page). GSI2: usage ledger ascending (1000/page). Both partitioned by workflow id. |
| On-demand capacity | No capacity planning; cost scales with usage. |
| TTL attribute (`ttl`, epoch seconds) | Retention enforcement. Items excluded at read time before DynamoDB removes them. |
| Point-in-time recovery (PITR) | Operational safety net for the single table. |
| Four IAM roles | Runtime, Task_Execution, Deployment, Scheduler_Invoke. Each disjoint - no action-and-resource pair granted to more than one (except the documented Scheduler `PassRole`). |
| Fargate only | A run is a long-lived in-process graph walk that can suspend indefinitely. Lambda's 15 min ceiling fights that. |
| WebSocket monitor | Preserves the `ControlFrame` protocol byte-for-byte - no client change needed. |
| BYO single estate | One Run_Table, one Trigger_API, one Monitor_API per deployment. No multi-tenant complexity. |

## Run_Table key scheme

All keys derive from the workflow id. `pk` is always `wf#{workflowId}`.

| Sort key pattern | Content |
|---|---|
| `spec` | Workflow spec |
| `lease` | Execution_Lease: fence, expiresAtMs, runId, runnerId |
| `run#{runId}` | RunRecord |
| `journal#{runId}#{journalKey}` | JournalEntry |
| `event#{runId}#{seq:012d}` | RunEvent (zero-padded 12-digit sequence) |
| `usage#{runId}#{nodeId}` | UsageLedgerEntry |
| `state#{scopedKey}` | StateEntry (per-entry TTL) |
| `frame#{arrivedAtMs}#{connectionId}#{n}` | Inbound ControlFrame (1 hour TTL) |
| `conn#{connectionId}` | Monitor connection record (2 hour TTL) |
| `skip#{triggeredAtMs}#{runnerId}` | Skipped-run record (unfenced) |

## Package scripts

```json
{
  "check": "tsc --noEmit && npm run bundle:shim && cdk synth --quiet && node scripts/synth-image-reference.mjs && vitest --run src/infra && node scripts/check-no-scan.mjs && node scripts/check-adapter-real.mjs && node scripts/check-imports-declared.mjs && node scripts/check-engine-purity.mjs && node scripts/check-engine-alias.mjs && node scripts/check-versions.mjs && node scripts/check-docs.mjs",
  "bundle:shim": "tsx src/shim/build.ts",
  "test": "vitest --run",
  "test:e2e": "node test/run-all.mjs"
}
```

## Dependencies

- Every entry in `dependencies` and `devDependencies` is an **exact** pin - no `^`, no `~`, no range,
  no dist-tag. Enforced by `check-versions.mjs` (widened from the original CDK-only rule). Local
  links (`file:`) are exempt: they carry no registry version.
- `tsx` is a **runtime** `dependency`, not a devDependency, because `bin/phorma-aws.mjs` is a
  `tsx/esm/api` launcher and `cdk.json` runs the CDK app through `tsx`. `check-versions.mjs` asserts
  it stays there.
- `aws-cdk-lib`, `constructs` and `esbuild` in `dependencies`; `aws-cdk` (the CLI) in
  `devDependencies`. `esbuild` is a runtime dependency because `plan` and `deploy` build the
  Schedule_Shim bundle in the operator's workspace, where devDependencies cannot be assumed.
- The pinned AWS SDK set: `client-apigatewaymanagementapi`, `client-cloudformation`,
  `client-cloudwatch`, `client-dynamodb`, `client-ec2`, `client-iam`, `client-kms`,
  `client-scheduler`, `client-secrets-manager`, `client-sts`, `credential-providers`,
  `lib-dynamodb`, `util-format-url`, plus `@aws-crypto/sha256-js` and the Smithy trio
  (`@smithy/protocol-http`, `@smithy/signature-v4`, `@smithy/url-parser`) that sign the
  Monitor_API WebSocket URL.
- `@phorma/engine` is `file:../engine` and resolves through the tsconfig path alias.
- `vitest` 4, `fast-check` 4, `typescript` and `esbuild` as dev dependencies.
- Zero dependency on `frontend`, `backend` or `cloud` packages.

## Common mistakes

- Adding a `Scan` import or operation - `check-no-scan.mjs` will catch it.
- Importing from `../engine` with a relative path instead of `@phorma/engine`.
- Writing to Run_Table without fencing (missing `ConditionCheck` on the lease item).
- Adding an `@aws-sdk/*` import to `engine/src/`.
- Using `fromLookup` in CDK (requires credentials at synth time, breaks the check pipeline).
- Importing a package under `bin/`, `src/aws/`, `src/cli/` or `src/shim/` without declaring it at an
  exact pin.
- Putting logic back into `bin/phorma-aws.mjs` instead of `src/cli/`.
- Pointing an EventBridge Scheduler target at an `execute-api` ARN. There is no API Gateway target.
- Translating cron by appending a year wildcard, or validating it against Unix field ranges. Use
  `core/cron.ts translateCron`.
- Calling `listSchedules` without a workflow name prefix, which deletes other workflows' schedules.
- Switching the Lambda to `NodejsFunction`, which reintroduces a Docker dependency into a pipeline
  that guarantees none.
- Creating a Platform_Prerequisite (VPC, subnet, App_CMK, boundary policy, notification topic,
  bootstrap stack) instead of referencing the identifier the operator supplied.
- Omitting the `ttl` attribute on items that need retention enforcement.
- Comparing lease timestamps as strings or relative durations instead of absolute epoch milliseconds.
