# Deploying Phorma Agent Studio to AWS

> **Audience:** The operator or platform engineer who will deploy, operate and maintain the AWS
> deployment target in their own account.
>
> **Companion document:** `docs/aws-deployment-target-approval-request.md` contains the architecture
> rationale, network topology diagram, cost scenarios and the sign-off block.

---

## 1. What you are deploying

One CloudFormation stack, from a CDK application in `cloud-aws/`, created in a single `cdk deploy`,
in one configured region.

### Resources the IaC_App creates

| Resource | AWS service | Purpose |
|---|---|---|
| Workflow runtime | ECS Fargate service (one container, private subnets, no public IP) | Runs the workflow engine plus the Host_Adapter |
| Run_Table | DynamoDB single table, on-demand, 2 GSIs, TTL, PITR | All workflow state, journal, events, usage, leases |
| Trigger_API | API Gateway HTTP API, private integration via VPC Link and internal NLB | Webhook, manual and scheduled triggers, spec push, history reads |
| Monitor_API | API Gateway WebSocket API, direct DynamoDB service integration | Live run events outbound, control frames inbound |
| Schedule group | EventBridge Scheduler | The group individual schedules are created into, UTC, capped at 50 per workflow. One schedule per `schedule-trigger` node with a non-blank cron |
| Schedule shim | AWS Lambda (Node 22, ARM64, outside the VPC) | The one hop between a fired schedule and the trigger route. EventBridge Scheduler cannot target API Gateway, so the schedule invokes this function and it makes the signed call |
| Secret_Store | AWS Secrets Manager (one prefix) | Connection credentials and model provider keys |
| Log groups | CloudWatch Logs | Structured JSON run logs |
| Metrics and alarms | CloudWatch Metrics (6 metrics, 2 alarms) | Failed-scheduled-run and lease-takeover alarms |
| App_CMK | KMS customer-managed key (or your supplied key) | Encrypts the table, secrets and log groups |
| Five IAM roles | IAM | Deployment, Runtime, Task Execution, Scheduler Invoke, Schedule Shim |
| VPC endpoints | 2 gateway + 10 interface, private DNS | All AWS service access from private subnets |
| Internal NLB | Network Load Balancer | VPC Link target for Trigger_API |


The stack creates no container image store of its own, on either image path. Where the deploy builds
the image, it publishes into the CDK bootstrap container asset store your account already has from
`cdk bootstrap` (section 3.3). Where you supply `imageUri`, the image already lives in your own
registry and the deploy builds and pushes nothing (section 3.8).

### Run_Table data categories

| Sort key pattern | Data category | Retention |
|---|---|---|
| `spec` | Pushed workflow spec, connection metadata, settings | Until purge |
| `lease` | Execution_Lease (fence, expiry, runner) | Until purge |
| `run#{runId}` | Run record summary and graph snapshot | Configured retention days |
| `journal#{runId}#{journalKey}` | Journal entries (replay log) | Deleted on run settle |
| `event#{runId}#{seq:012d}` | Run log events | Configured retention days |
| `usage#{runId}#{nodeId}` | Usage ledger entries | Configured retention days |
| `state#{scopedKey}` | Workflow state entries | Per-entry TTL |
| `frame#{arrivedAtMs}#{connectionId}#{n}` | Inbound control frames | 1 hour |
| `conn#{connectionId}` | Monitor connection records | 2 hours |
| `skip#{atMs}#{runId}` | Skipped-run records (unfenced) | Configured retention days |

### Outbound calls the Host_Adapter makes

| Destination | Protocol | Purpose |
|---|---|---|
| DynamoDB (Run_Table) | HTTPS via gateway endpoint | All persistence: lease, journal, events, state, usage, spec, history |
| Secrets Manager | HTTPS via interface endpoint | Connection credential and provider key reads |
| CloudWatch Logs | HTTPS via interface endpoint | Structured JSON log writes |
| CloudWatch Metrics | HTTPS via interface endpoint | Six metric data points per run |
| EventBridge Scheduler | HTTPS via interface endpoint | Schedule create/delete on workflow push |
| API Gateway execute-api | HTTPS via interface endpoint | `PostToConnection` for live monitor push |
| ECR | HTTPS via interface endpoint | Container image pull from the bootstrap asset store or your own ECR (via Task Execution role) |
| S3 | HTTPS via gateway endpoint | ECR image layer storage |
| STS | HTTPS via interface endpoint | Role credential resolution |
| Bedrock Runtime | HTTPS via interface endpoint | Model inference (where Bedrock is configured) |
| Allow-listed hostnames | HTTPS via task security group egress | Third-party APIs and non-Bedrock model providers |
| Nominated data-source SG | TCP on configured port | Private SQL Server, Postgres, MySQL, on-prem |

The Schedule_Shim is the one component that is not the Host_Adapter and makes its own call. It runs
outside the VPC and reaches exactly one destination:

| Destination | Protocol | Purpose |
|---|---|---|
| Trigger_API `POST /workflows/{id}/trigger` | HTTPS, SigV4-signed `execute-api` | Start the run for a fired schedule |

---

## 2. Decide first

These architectural decisions are already closed. They exist here so a reviewer does not have to read
the spec to understand why.

| Decision | Resolution | Why |
|---|---|---|
| Infrastructure as code | AWS CDK in TypeScript (pinned at **2.265.0**) | Matches the codebase and the existing `npx`-through-Rust deploy rail. Terraform would mean a second IaC surface |
| Persistence | DynamoDB single table, on-demand | Access patterns are already key/value by `(workflowId, runId)`. RDS adds idle cost, a VPC dependency and a migration surface for reporting nobody has asked for |
| Compute for runs | Fargate only | A run is one long-lived in-process graph walk that can suspend indefinitely on an approval and may hold a connection pool. Lambda's 15 minute ceiling fights both |
| Monitor transport | API Gateway WebSocket API | Preserves the bidirectional control frame protocol with no client redesign. The canvas animates a deployed run identically to a local one |
| WebSocket route backing | Direct DynamoDB service integration | No Lambda on the hot path. A control frame arrives on every monitor interaction, so a function there would be a second compute surface carrying real traffic. Cost: about one second of control-frame latency |
| Schedule delivery | One Lambda, the Schedule_Shim | EventBridge Scheduler has no API Gateway target of either kind, so something has to bridge a fired schedule to the trigger route. Lambda `Invoke` is a supported target. The 15 minute ceiling is irrelevant: the shim signs one request and exits. Draining a queue in the task instead would have created a second run ingress, duplicating the lease and contention rules |
| Tenancy | Single estate, bring your own account | One Run_Table, one Trigger_API, one Monitor_API per deployment. Hosted multi-tenant AWS is out of scope |
| Orchestration | The engine remains the state machine | Step Functions would forfeit local-to-deployed parity, breaking the canvas debugger against a deployed run |

---

## 3. Platform Request Template

Copy this template into your organisation's request system. Each item is separately labelled so an
approver can answer individually.

---

### 3.1 Deployment_Identity

**What we need:** An IAM role ARN that the CDK application will assume to create the stack.

**Trust policy:** Must trust one or both of:

- An IAM Identity Center permission set (for human deploys)
- A GitHub OIDC provider with conditions on `repository`, `branch` and `environment` (for CI deploys)

An empty trust configuration fails synthesis. Both together allow human and CI deploys through one
role.

**Lambda permissions this role needs.** The stack creates one function, the Schedule_Shim, so the
deploy role carries a Lambda lifecycle grant scoped to `<PREFIX>-*` function names, plus `iam:PassRole`
for the shim's own role. If your boundary policy denies `lambda:*` outright, that denial has to be
relaxed for the prefixed name or cron schedules cannot be deployed. The named actions are
`CreateFunction`, `DeleteFunction`, `GetFunction`, `GetFunctionConfiguration`, `UpdateFunctionCode`,
`UpdateFunctionConfiguration`, `TagResource`, `UntagResource`, `ListTags`, `PutFunctionConcurrency`,
`DeleteFunctionConcurrency`, `AddPermission`, `RemovePermission` and `GetPolicy`. No wildcard action
and no account-wide resource.

```
Role ARN: arn:aws:iam::<ACCOUNT_ID>:role/<PREFIX>-deploy-role
Trust policy shape: [ ] Identity Center  [ ] GitHub OIDC  [ ] Both
Lambda lifecycle on arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:<PREFIX>-*: [ ] Approved
```

---

### 3.2 Permissions_Boundary

**What we need:** The ARN of the IAM managed policy your organisation requires on every role the
IaC_App creates.

Every role the application creates carries this boundary, including the Schedule_Shim's execution
role. Synthesis fails if no boundary is configured, or if any role is declared without it.

```
Permissions boundary ARN: arn:aws:iam::<ACCOUNT_ID>:policy/<BOUNDARY_POLICY_NAME>
```

---

### 3.3 CDK bootstrap approval and qualifier

**What we need:** Approval to run `cdk bootstrap` in the target account/region (if not already
bootstrapped), and the qualifier to use.

The CDK bootstrap (version for CDK **2.265.0**) creates a staging bucket, an ECR repository for
image assets, and a set of bootstrap roles. The qualifier isolates this application's bootstrap
resources from others in the same account.

```
Bootstrap qualifier: <your-qualifier>  (default: hnb659fds)
Bootstrap already present: [ ] Yes  [ ] No, approve bootstrap
```

---

### 3.4 VPC, subnets and endpoints

**What we need:** A VPC id and one or more private subnet ids (minimum 2 AZs recommended), or
approval for the IaC_App to create them.

Requirements:
- Subnets must have **no internet gateway route** in their route tables
- Public IP assignment must be disabled
- Subnets must be in the same VPC you supply

The IaC_App will create 12 VPC endpoints (2 gateway, 10 interface with private DNS) in those
subnets. If your organisation already shares VPC endpoints, supply the existing ones and we
configure against them.

```
VPC id:        vpc-<17 hex chars>
Subnet ids:    subnet-<17 hex chars>, subnet-<17 hex chars>
Create VPC:    [ ] Use existing  [ ] Approve creation
```

---

### 3.5 App_CMK and key-policy grants

**What we need:** A KMS customer-managed key ARN in the target region, or approval to create one.

The key encrypts: Run_Table, Secrets Manager entries and CloudWatch log groups. The container image
is not one of them - it lives in the bootstrap asset store or in your own registry (section 3.8),
each with its own encryption configuration.

Key-policy grants required:
- The **Deployment_Identity** needs `kms:CreateGrant` and `kms:DescribeKey`
- The **Runtime_Identity** needs `kms:Decrypt` (with `ViaService` condition for DynamoDB, Secrets Manager, CloudWatch Logs)
- The **Task_Execution_Identity** needs the App_CMK permissions the image pull path requires

The Deployment_Identity does NOT need `kms:Decrypt`, `kms:GenerateDataKey*` or `kms:ReEncrypt*`.

```
App_CMK ARN:   arn:aws:kms:<REGION>:<ACCOUNT_ID>:key/<KEY_ID>
Or:            [ ] Approve key creation
```

---

### 3.6 Egress_Allow_List

**What we need:** Approval for the set of outbound hostnames the workload will reach.

The allow-list is derived from the workflow definition before every deploy and printed to the
operator console for review. No all-destinations egress rule is created. Synthesis fails if one
appears in the template.

If Bedrock is the only model provider, no non-AWS egress is needed at all.

```
Approved egress hostnames: <derived per workflow, printed before deploy>
Data-source security group: sg-<17 hex chars>
Data-source port:           <port number>
```

---

### 3.7 Tag set

**What we need:** The cost-allocation tag keys and values to apply to every resource.

Every taggable resource carries this set. Synthesis fails if the set is absent or any value is empty.
Activate these keys as cost allocation tags in your payer account **before** the first deploy.

```
Tag set:
  <key1>: <value1>
  <key2>: <value2>
  ...
```

---

### 3.8 Container image source

**What we need:** Either approval for the deploy to build the container image locally, or the
reference of an image your platform team publishes.

One configuration field picks the path:

| `imageUri` | What happens | Docker daemon |
|---|---|---|
| Absent | The deploy builds `cloud-aws/Dockerfile` as a CDK Docker image asset and publishes it into the bootstrap container asset store from section 3.3 | Required on the machine running Plan or Deploy |
| Present | The stack references that image verbatim. Nothing is built and nothing is pushed | Not needed |

The reference path is the one to take where your supply chain requires that every image be built and
scanned by your own platform team. Your team publishes the image; the deploy only consumes it. If the
daemon is missing on the asset path, Preflight stops the run before any `cdk deploy` step starts with
`Docker daemon unreachable. The deploy builds the container image from cloud-aws/Dockerfile. Start
Docker, or set imageUri to a platform-published image (docs/deploy-aws.md section 3.8).`

**Shape of the value.** Either a tag reference or a digest reference:

```
{registry}/{repository}:{tag}
{registry}/{repository}@sha256:{digest}
```

Examples:

```
123456789012.dkr.ecr.us-east-1.amazonaws.com/platform/phorma-host:0.2.0
123456789012.dkr.ecr.eu-west-1.amazonaws.com/platform/phorma-host@sha256:<64 hex chars>
ghcr.io/<your-org>/phorma-agent-studio:0.2.0
```

Prefer the digest form where immutability matters: a tag can be moved under the running service, a
digest cannot.

**What the published image must satisfy** (same contract the built image meets):

- Its default command starts the Server_Entry
- Its runtime contains the `curl` binary, because the task health check invokes it

**What the value does to the pull grant.** The Task_Execution_Identity's image-pull permission is
derived from the reference, never guessed:

| Reference | Pull grant |
|---|---|
| Private ECR (`<account>.dkr.ecr.<region>.amazonaws.com/<repository>`) | The layer-read actions scoped to that one repository ARN, taken from the reference. A cross-account repository works, and a `@sha256:` digest is dropped when the ARN is derived |
| Any other registry: `ghcr.io`, `docker.io`, a self-hosted registry, and `public.ecr.aws` | No `ecr:*` repository statement at all. The Fargate agent pulls without calling ECR, so there is nothing to grant. Only `ecr:GetAuthorizationToken`, which takes no resource, remains |
| Absent (asset path) | The layer-read actions scoped to the bootstrap container asset store for your configured qualifier |

Neither path creates a container image store, so no such resource appears in the section 1 inventory.

```
Image source: [ ] Approve local build from cloud-aws/Dockerfile  [ ] Platform-published image
imageUri:     <registry>/<repository>:<tag>  or  <registry>/<repository>@sha256:<digest>
Publisher:    <team that builds and scans the image, if platform-published>
```

---

## 4. Bootstrap

Bootstrap creates the CDK staging resources in your account. Skip this section if your account is
already bootstrapped for CDK **2.265.0** with your chosen qualifier.

```bash
# From the cloud-aws/ directory
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION> \
  --qualifier <YOUR_QUALIFIER> \
  --cloudformation-execution-policies arn:aws:iam::<ACCOUNT_ID>:policy/<YOUR_EXECUTION_POLICY> \
  --trust <DEPLOY_ROLE_ARN>
```

The bootstrap qualifier must match the value you supply in configuration (section 5). CDK **2.265.0**
bootstrap roles govern which principals can trigger deployments and what the execution role can do.

---

## 5. Configure

### Where the CDK application comes from

The IaC_App ships **inside the Studio installer**. An operator has no checkout of the Phorma
repository and does not need one: **Settings > Cloud > Your own AWS > Deploy runtime > Set up runtime
files** unpacks the CDK application, the `Dockerfile` and the engine source into a workspace under
the app's data folder, runs `npm install` there, and stores that path as the runtime folder. Every
`cloud-aws/` path in this guide means that workspace. Re-run it after a Studio update so the deployed
runtime matches the app; the version it installed for is recorded in the workspace.

The container build context is the workspace's parent, which is what lets `Dockerfile` copy both
`cloud-aws/` and `engine/` exactly as it does in a checkout.

Contributors working from the repository can point the runtime folder at `cloud-aws/` instead, after
`npm install` there. Everything below then reads literally.

Create the deployment configuration. The Studio generates a gitignored
`cdk.context.phorma.json` beside `cdk.json` in the runtime folder.

### Required configuration values

| Field | Validation | Example |
|---|---|---|
| `accountId` | Exactly 12 digits | `123456789012` |
| `region` | Syntactically valid AWS region | `us-east-1` |
| `namePrefix` | 1-32 chars, `[a-z0-9-]` | `phorma-prod` |
| `permissionsBoundaryArn` | Well-formed IAM policy ARN | `arn:aws:iam::123456789012:policy/BoundaryPolicy` |
| `bootstrapQualifier` | CDK qualifier string | `hnb659fds` |
| `vpcId` | Well-formed VPC id in the target region | `vpc-0abc1234def567890` |
| `subnetIds` | One or more well-formed subnet ids, members of the VPC | `["subnet-0abc...", "subnet-0def..."]` |
| `notificationTargetArn` | Alarm notification target (SNS topic) | `arn:aws:sns:us-east-1:123456789012:ops` |
| `tags` | Non-empty key-value pairs | `{"team": "platform", "env": "prod"}` |
| `retentionDays` | 1-366 whole days (default: 30) | `30` |

### Optional configuration values

| Field | Notes |
|---|---|
| `appCmkArn` | KMS key ARN in the target region. If absent, a key is created |
| `dataSourceSecurityGroupId` | Security group of your private data source |
| `dataSourcePort` | Port to allow egress to the data-source security group |

Every check runs with no AWS credentials present. A malformed value fails synthesis before any
resource is created.

---

## 6. Deploy

### Pre-deploy: run the check command

```bash
cd cloud-aws
npm run check
```

This runs, in order, with no AWS credentials required:
1. TypeScript no-emit compile
2. CDK synthesis (no context lookups)
3. Template assertions (resource inventory, encryption, authorizers, alarms)
4. IAM deny-list assertions
5. No-scan check
6. Engine purity check
7. Engine alias check
8. Version check
9. Documentation correspondence check

A failure at any step exits non-zero. Fix before proceeding.

### Plan

The Studio runs the plan command automatically before deploy. From the CLI:

```bash
phorma-aws plan
```

This runs:
1. A `cdk diff` against the deployed stack
2. The existence preflight: `ec2:Describe*` calls verifying every configured VPC, subnet and
   security group exists and that every subnet is a member of the configured VPC
3. A `kms:DescribeKey` call verifying the App_CMK exists and is enabled (when an ARN is supplied)

A non-zero exit offers no confirmation. The Studio runs no deploy command when the plan fails.

### Deploy

After plan succeeds and the operator confirms:

```bash
phorma-aws deploy
```

The Studio streams output line by line, and at most one command per target runs at a time. There is
no cancel control: the desktop streamed-command rail exposes no cancellation, so the Studio offers a
link to the run console instead of a stop button. A command runs to completion or fails.

### CLI verbs

`phorma-aws` carries six verbs. The Studio drives all of them; the same commands work by hand from
the runtime folder (section 5).

| Verb | Arguments | What it does |
|---|---|---|
| `plan` | none | `cdk diff` against the deployed stack, then the existence preflight |
| `deploy` | none | `cdk deploy`, then reports the two discovered endpoints |
| `request` | `<url> <method>` | One SigV4-signed `execute-api` call. The body arrives on stdin, never in the argument list, so a payload cannot leak into a process listing |
| `monitor-url` | `<workflowId>` | A presigned Monitor_API `$connect` URL (section 8) |
| `doctor` | none | Config file, CDK entry point and session checks, reported by exit code |
| `outputs` | none | Re-reads the two endpoints from CloudFormation. Reads only, deploys nothing |

### Exit codes

Five codes, the same meaning whichever verb produced them. The Studio reads the code, not the wording.

| Code | Meaning | What to do |
|---|---|---|
| 0 | Pass | Nothing. `request` also exits 0 for an HTTP response of any status, including 4xx and 5xx: the status travels in the reported payload, so a 409 is a fact to read rather than a CLI failure |
| 1 | General failure | A preflight failure, a non-zero `cdk` step, a rejected configuration, an under-supplied verb or a transport error. The reason is on stderr |
| 2 | The configuration file is absent | Save the configuration from the Studio, or place `cdk.context.phorma.json` beside `cdk.json` |
| 3 | The CDK entry point is absent | The runtime folder is wrong or incomplete. Re-run Set up runtime files in Settings (section 5) |
| 4 | The session is invalid or expired | Run `aws sso login`, then retry. The Studio surfaces this automatically |

### Endpoint discovery

A successful deploy reports `TriggerApiUrl` and `MonitorApiUrl`, and the Studio stores both. Two
behaviours are worth knowing:

- If the deploy stream carried no readable endpoint report (a killed stream, a truncated final line,
  a deploy run from CI), the Studio runs `phorma-aws outputs` once to read the same values straight
  from CloudFormation. One recovery attempt, not a retry loop.
- If fewer than both values come back, the run still **exits 0**, names the missing output, and
  **leaves the stored endpoints unchanged**. The endpoints are stored as a pair, so writing half of
  them would leave the Studio claiming a pairing no single deploy produced. Fix the stack, then use
  the Refresh control (the `outputs` verb) rather than editing the stored values by hand.

---

## 7. Verify

### 7.1 End-to-end operator checklist

Work this list once, in order, against a real account. Nothing here can be checked without one: every
step needs the deployed stack, so this checklist is the acceptance test for the whole feature. Tick
each row only when you have seen the stated result with your own eyes.

| # | Step | Where | What you should see |
|---|---|---|---|
| 1 | Fill in the configuration | Studio Settings, Cloud section, or `cdk.context.phorma.json` by hand | Every field valid, no red field. The file lands beside `cdk.json` in your `cloud-aws` directory |
| 2 | Run `doctor` | Cloud dialog Doctor button, or `phorma-aws doctor` | Exit 0 and one line naming your account and identity. Exit 4 means run `aws sso login` first |
| 3 | Run Plan | Cloud dialog Deploy button (it plans first), or `phorma-aws plan` | The `cdk diff` output, then the preflight result. The egress allow-list is printed with a leading count for review |
| 4 | Confirm | The confirm dialog the Studio raises after a clean plan | A non-zero plan offers no confirm. The Studio runs no deploy command when the plan fails |
| 5 | Deploy | The same control, after confirming | Output streams line by line to the run console, ending with a `CREATE_COMPLETE` or `UPDATE_COMPLETE` stack status. Both endpoints are then stored (section 6, Endpoint discovery) |
| 6 | Check the service | ECS console, or `aws ecs describe-services` | Task status RUNNING, desired count met, health check passing |
| 7 | Push a spec | Open a workflow in the Studio and push it to the AWS target | Toast "Workflow pushed". The spec is now in Run_Table under sort key `spec`, and one schedule exists per `schedule-trigger` node with a non-blank cron |
| 8 | Trigger a run | Run the pushed workflow from the Studio, or `POST /workflows/{id}/trigger` with a `runId` in the body | 200, and the lease is taken. A second concurrent trigger answers 409 and records one `skipped` run |
| 9 | Read run history | The Studio runs panel for the deployed workflow, backed by `GET /workflows/{id}/runs` | Run records listed newest first, 100 per page |
| 10 | Watch live events | Keep the monitor attached while the run is in flight | Nodes animate on the canvas as the run walks the graph, within about two seconds of each event being pushed |
| 11 | Check telemetry | CloudWatch console, filtered by the workflow id dimension | Metric data points present, structured JSON entries in the app log group |
| 12 | Deploy a cron schedule | Push a workflow whose `schedule-trigger` node carries a cron a couple of minutes out, for example `*/2 * * * *` | The push succeeds. `aws scheduler list-schedules --group-name <prefix>-schedules` shows one schedule named `sched-...`, and its target is the `<prefix>-schedule-shim` function ARN |
| 13 | Watch the schedule fire | Wait for the cron instant, then check the shim log group `/phorma/<prefix>/schedule-shim` and the runs panel | One structured `Scheduled run started` line carrying a fresh `runId`, and a new run in history with source `schedule` |

Steps 7 to 10 are the ones that prove the host is really equivalent to the local engine, so do not
stop at a green stack. Steps 12 and 13 are the only way to confirm the schedule path: the
credential-free check pipeline proves synthesis and the fakes, never delivery.

### 7.2 Smoke checks

The condensed form of the same thing, for a re-deploy rather than a first deploy.

| # | Check | How | Observable result |
|---|---|---|---|
| 1 | Service health | ECS console or `aws ecs describe-services` | Task status RUNNING, desired count met, health check passing |
| 2 | API reachability | Push a workflow spec from the Studio | 200 response, spec visible in run history |
| 3 | Schedule firing | Push a workflow with a short cron and wait for the instant | A `Scheduled run started` line in the shim log group and a run with source `schedule` in history |
| 4 | Monitor connectivity | Attach the Studio monitor to the deployed workflow and trigger a run | Run events stream live to the canvas |
| 5 | Telemetry presence | CloudWatch console, filter by the workflow id dimension | Metrics data points present, log entries in the app log group |

---

## 8. Operate

### Pushing a workflow

A spec push runs the Capability_Validator against `AWS_CAPABILITIES`. If any finding is an error,
the push is refused and the previously deployed spec and schedule set remain unchanged.

### Cron schedule triggers

A `schedule-trigger` node with a non-blank `cron` becomes one EventBridge Scheduler schedule at
spec-push time. A blank `cron` is skipped rather than rejected, so a node you have not finished
configuring does not block a push.

**The path a fired schedule takes.** EventBridge Scheduler cannot invoke an API Gateway route. Its
templated targets are a closed list (CodeBuild, CodePipeline, ECS `RunTask`, EventBridge `PutEvents`,
Inspector, Kinesis, Firehose, Lambda `Invoke`, SageMaker, SNS, SQS, Step Functions) and its universal
target invokes AWS SDK API operations of the shape `arn:aws:scheduler:::aws-sdk:{service}:{operation}`.
Neither reaches `execute-api`. So the schedule targets the Schedule_Shim Lambda, and the shim makes
the signed call:

```
schedule fires
  -> Lambda Invoke (Scheduler_Invoke_Identity)
  -> Schedule_Shim mints a fresh runId
  -> POST /workflows/{id}/trigger, SigV4-signed (Schedule_Shim role)
  -> lease acquired, run starts on the Fargate task
```

The run id is minted per fire rather than stored on the schedule, because a schedule's stored input is
fixed when the spec is pushed and a baked-in id would be reused by every fire forever. The shim is the
only reason there is a hop at all; a scheduled run then follows exactly the same route as a manual
run from the Studio, so the lease, the 409 contention answer and the skip record all behave
identically.

**Cron dialect.** Type ordinary five-field Unix cron. The Studio and the host translate it to the
six-field form EventBridge requires, which differs in three ways worth knowing if you read a schedule
back in the AWS console:

| | Unix, what you type | AWS, what is stored |
|---|---|---|
| Fields | 5 | 6, with a trailing year |
| Day-of-week | 0-6 from Sunday, 7 also Sunday | 1-7 from Sunday |
| Day fields | `*` in both is normal | exactly one of day-of-month and day-of-week must be `?` |

So `0 12 * * *` is stored as `cron(0 12 * * ? *)`, and Unix Monday-to-Friday `1-5` is stored as `2-6`.
A six-field AWS expression is also accepted verbatim, so `15 10 ? * 6L 2022-2023` passes through
unchanged. A cron that cannot be expressed - both day fields constrained, for instance - is refused
on the push with a message naming the field, and no schedule is created or replaced.

**Timing.** Schedules run in UTC with a flexible time window of `OFF`, so a schedule fires at its
cron instant with 60 second precision. Schedules are capped at 50 per workflow.

**A schedule for a purged workflow.** When a schedule fires and the workflow's spec is gone, the
trigger route deletes the now-orphaned schedule, publishes the `SkippedScheduledRun` metric and
answers 404. The shim treats that as a terminal answer rather than a fault, so it neither retries nor
raises its error metric. The schedule stops firing after the first such tick.

**Reading a failure.** The shim throws, and so signals Scheduler to retry, only for a status a retry
could fix. A 409 (another Runner already holds the lease) and a 404 (no deployed spec) resolve
quietly; a 5xx or a transport error throws. That split matters because a 409 is normal on a workflow
that is already running, and treating it as an error would raise the Lambda error metric every time
the concurrency guard did its job. Structured lines land in `/phorma/<prefix>/schedule-shim`.

### Live run monitoring and the presigned URL

The webview holds no AWS credentials, and a browser `WebSocket` cannot carry a SigV4 `Authorization`
header, so the Studio opens the Monitor_API socket with a presigned `$connect` URL that it asks the
CLI for (`phorma-aws monitor-url <workflowId>`). The `workflowId` is part of the **signed** query
string, not appended afterwards, or API Gateway would reject the connect.

| Property | Value | Consequence |
|---|---|---|
| Presign validity | **300 seconds**, fixed in code and not configurable | A URL copied out of the console is useful for five minutes and then dead. Do not store one |
| When the presign happens | Inside every connect attempt, including every reconnect | An expired URL recovers on its own: the next reconnect presigns afresh rather than replaying the stale signature. There is nothing to refresh by hand |
| Session expiry during a run | The verb exits 4 | The Studio names `aws sso login`. Renew the session and the next reconnect attempt succeeds |
| `monitorApiUrl` not yet known | The verb refuses before signing anything | That means "not deployed yet", not "misconfigured". Deploy, or run `phorma-aws outputs` to discover it |

A dropped socket costs no run progress: the run continues to a settled outcome with zero connections
open, and every event it emitted is persisted in Run_Table either way, readable through
`GET /workflows/{id}/runs/{runId}`. Inbound control frames are retained for one hour and connection
records for two.

### Egress allow-list

Before every deploy, the Studio derives the egress allow-list from the workflow definition and
configured providers, prints it with a leading count, and lets the operator review it. A hostname
that cannot be statically derived is omitted and named on its own console line. No all-destinations
egress rule exists.

### Execution_Lease and single-flight

Only one Runner holds the lease for a given workflow id at any time. A second trigger (cron overlap,
manual while running, webhook) records a skip with status `skipped` and answers 409. A lease
takeover publishes a metric and raises the alarm.

### Retention

Run events, run records and usage entries are retained for the configured period (1-366 days,
default 30). DynamoDB TTL expires them. The read path excludes expired items before physical
deletion.

### Purge

Purging a workflow deletes: spec, journal entries, run records, run events, usage entries, state,
lease, skip records, and schedules. It answers with per-category counts. It deliberately preserves
Secret_Store entries (credentials are shared across workflows).

### Runtime policy trimming

Once the Host_Adapter is feature complete, use **IAM Access Analyzer policy generation from
CloudTrail** to reduce the Runtime_Identity policy to only the actions actually exercised. The
action lists in this guide are a starting position we expect to reduce.

### Organisation guardrails

| Guardrail | Consequence if not met |
|---|---|
| IAM permissions-boundary requirement | Synthesis fails: every role must carry the boundary |
| Region allow-list (SCP) | Deployment refused by AWS at the API level |
| Customer-managed-key requirement | Synthesis fails: the table, every secret and every log group must name App_CMK |
| Mandatory tagging (Tag Policy or SCP) | Synthesis fails if any tag is missing or empty |
| No public subnets | By design: tasks run in private subnets with no IGW route |
| Egress allow-list (firewall or SCP) | Only allow-listed hostnames leave the VPC; no all-destinations rule |
| Approved-policy requirement | All policies are managed, named with the prefix, reviewable by name |
| Change control on CloudFormation | Every change is a `cdk deploy` with a diff preview first |

---

## 9. Teardown

```bash
cdk destroy --qualifier <YOUR_QUALIFIER>
```

### Resources retained after teardown

These resources are deliberately NOT deleted by `cdk destroy`:

| Resource | Reason | Action to remove |
|---|---|---|
| KMS key (App_CMK) | Keys have a mandatory waiting period; may be shared | Schedule deletion: `aws kms schedule-key-deletion --key-id <KEY_ID> --pending-window-in-days 7` |
| VPC endpoints (if shared) | May serve other workloads in the same VPC | Remove manually if no longer needed: `aws ec2 delete-vpc-endpoints --vpc-endpoint-ids <IDS>` |
| CloudWatch log groups (with retention) | Retain logs for the configured retention period | Delete after retention expires: `aws logs delete-log-group --log-group-name <NAME>` |

---

## 10. Troubleshooting

### 10.1 Authentication failure

**Symptom string in the Studio console:**

```
Unable to locate credentials. You can configure credentials by running "aws configure sso".
```

or:

```
The SSO session associated with this profile has expired or is otherwise invalid.
```

**Corrective action:** Run `aws sso login --profile <YOUR_PROFILE>` to refresh your SSO session,
then retry the command. The Studio appends this as a next-step message automatically.

---

### 10.2 Preflight check failure

**Symptom string in the Studio console:**

```
Preflight failed: VPC vpc-0abc1234def567890 does not exist in us-east-1
```

or:

```
Preflight failed: subnet-0abc1234def567890 is not a member of vpc-0abc1234def567890
```

or:

```
Preflight failed: the supplied key ARN is unusable (key not found or not enabled in us-east-1)
```

**Corrective action:** Verify the configured VPC, subnet and key ids exist in the target region and
that every configured subnet belongs to the configured VPC. Correct the configuration and re-run
`phorma-aws plan`.

---

### 10.3 Synthesis failure

**Symptom string in the Studio console:**

```
Synthesis failed: Role <RoleName> does not have a permissions boundary attached
```

or:

```
Synthesis failed: <ResourceName> is not encrypted with the customer-managed key
```

or:

```
Synthesis failed: alarm <AlarmName> has no configured notification target
```

or:

```
Synthesis failed: cost-allocation tag set is missing or contains an empty value for key '<key>'
```

**Corrective action:** Check the configuration. Every synthesis failure names the offending element.
Common causes:
- `permissionsBoundaryArn` is not configured or is malformed
- `appCmkArn` names a key in a different region
- `notificationTargetArn` is missing
- `tags` set is absent or contains an empty value

Fix the configuration value and re-run `npm run check`.

---

### 10.4 Deployment failure

**Symptom string in the Studio console:**

```
❌  <StackName> failed: AccessDenied - User: arn:aws:sts::<ACCOUNT>:assumed-role/<ROLE>/... is not authorized to perform: <ACTION> on resource: <RESOURCE>
```

**Corrective action:** The Deployment_Identity is missing a permission for the resource type named
in the error. Common additions needed:

- `iam:CreateRole` with the path prefix and boundary condition
- `ecs:CreateCluster` or `ecs:CreateService`
- `dynamodb:CreateTable`
- `kms:CreateGrant`
- `ec2:CreateVpcEndpoint` (if the VPC endpoints are new)

Add the named action to the Deployment_Identity's permission set, scoped to the resource ARN or
name prefix shown in the error, then retry.

---

### 10.5 Runtime connection failure

**Symptom string in the Studio console (via run events):**

```
Connection failed: <hostname> - the hostname may not be in the Egress_Allow_List
```

or in CloudWatch Logs:

```
{"level":"error","workflowId":"...","runId":"...","message":"Node <nodeId> failed: connection to <hostname>:<port> timed out after 10000ms. The hostname may not be allow-listed for egress."}
```

**Corrective action:**
1. Verify the hostname appears in the egress allow-list printed before the last deploy
2. If missing: the hostname may be interpolated at run time and was omitted from the static
   derivation. Add it to the security group egress rules manually, or restructure the node to use
   a literal hostname
3. If present: check that the VPC endpoint or NAT path for the destination is functional, and that
   no network firewall or SCP is blocking the connection
4. For private data sources: verify the data-source security group allows inbound from the task
   security group on the configured port

---

### 10.6 A cron schedule never fires

Work these in order. The first two are the common causes and cost nothing to check.

**Was the schedule created at all?**

```bash
aws scheduler list-schedules --group-name <PREFIX>-schedules
```

An empty list means the push never created one. Either every `schedule-trigger` node has a blank
`cron`, which is skipped by design, or the push was refused. A refused push names the field: the
Studio raises a `Push failed` toast carrying the reason, for example both day fields being
constrained. Fix the expression and re-push.

**Is the target the shim?**

```bash
aws scheduler get-schedule --group-name <PREFIX>-schedules --name <SCHEDULE_NAME>
```

`Target.Arn` must be the `<PREFIX>-schedule-shim` function ARN. An `arn:aws:execute-api:...` target is
a stack from before the shim existed: EventBridge Scheduler has no API Gateway target, so such a
schedule could never fire. Re-deploy, then re-push the spec so the schedule is recreated against the
new target.

**Did the shim run?** Check `/phorma/<PREFIX>/schedule-shim`.

| What you see | Meaning |
|---|---|
| `Scheduled run started` | The shim did its job. Any missing run is downstream: check the runs panel and the app log group |
| `Scheduled run not started`, outcome `already-running` | The previous run was still going. Normal, and a skip record is in Run_Table |
| `Scheduled run not started`, outcome `not-deployed` | The spec was purged. The schedule has been deleted and will not fire again |
| `Trigger_API answered 403` | The shim's role lost `execute-api:Invoke` on the trigger route, or the permissions boundary now denies it |
| No log stream at all | Scheduler never invoked the function. Check that `<PREFIX>-scheduler-invoke` still grants `lambda:InvokeFunction` on it, and that its trust policy still names `scheduler.amazonaws.com` with the schedule group as `aws:SourceArn` |

**Is the clock what you expect?** Schedules evaluate in UTC and fire with 60 second precision. A cron
written against local time fires at the UTC instant, not the local one.

### 10.6b One workflow's schedules disappeared when another was pushed

**Symptom:** workflow A stops firing after an unrelated workflow B is pushed. `list-schedules` shows
B's schedules and not A's.

**Cause:** a stack from before schedule names were workflow-scoped. Schedule names were a single
opaque digest, and one schedule group holds every workflow, so "replace this workflow's schedules"
was implemented as "delete everything in the group".

**Corrective action:** update the app, re-deploy, and re-push every deployed workflow so each one
recreates its own schedules under its own `sched-<workflow>-<node>` prefix. Pushes are then scoped
per workflow, and a push for B lists and deletes only B's schedules.

---

### 10.7 The Studio accepts an alarm topic ARN that the CLI then rejects

**Symptom in the Studio console:**

```
alarmNotificationArn must be a valid SNS topic ARN (arn:aws:sns:<region>:<account>:<name>), got "..."
```

after a configuration form that showed no invalid field.

**Cause:** the Settings form validates the alarm notification target against a generic ARN shape,
while the configuration parser demands an **SNS topic** ARN. A well-formed ARN for another service,
for example `arn:aws:sqs:us-east-1:123456789012:q`, passes the form and is then refused when the
generated `cdk.context.phorma.json` is parsed.

**Corrective action:** supply an SNS topic ARN
(`arn:aws:sns:<region>:<account-id>:<topic-name>`). The alarms in this stack notify through SNS only,
so no other service ARN is usable here whatever the form accepted.

---

## Private-source connectivity patterns

Each pattern below describes how to connect the Fargate tasks to a private data source. Choose the
one that matches your network topology.

### Option A: Security group to security group (same VPC)

The simplest pattern when the data source is in the same VPC as the Fargate tasks.

**Resources the operator owns:**
- The data-source security group (e.g. on an RDS instance or EC2-hosted database)
- An inbound rule on that security group allowing the task security group on the database port

**Resources the IaC_App owns:**
- The task security group with an egress rule to the data-source security group on the configured port

**Configuration inputs required:**
- `dataSourceSecurityGroupId`: the security group id of the data source
- `dataSourcePort`: the TCP port the database listens on

---

### Option B: VPC peering

When the data source is in a different VPC in the same or different account, connected by a peering
connection.

**Resources the network owner owns:**
- The VPC peering connection between the two VPCs
- Route table entries in both VPCs pointing the peer CIDR to the peering connection
- An inbound rule on the data-source security group allowing the task subnet CIDR on the database port

**Resources the IaC_App owns:**
- The task security group with an egress rule to the peer CIDR on the configured port
- Route table entries on the task subnets (if not inherited from the VPC)

**Configuration inputs required:**
- `dataSourceSecurityGroupId`: the security group id in the peer VPC
- `dataSourcePort`: the TCP port
- The peer VPC CIDR (for egress rule scoping)

---

### Option C: Transit Gateway

When the data source is reachable through a Transit Gateway connecting multiple VPCs or on-premises
networks.

**Resources the network owner owns:**
- The Transit Gateway and its attachments to both VPCs
- Transit Gateway route tables routing the task VPC CIDR to the data-source attachment and vice versa
- An inbound rule on the data-source security group allowing the task subnet CIDR

**Resources the IaC_App owns:**
- The task security group with an egress rule to the data-source CIDR on the configured port
- Route table entries on the task subnets pointing the data-source CIDR to the Transit Gateway attachment

**Configuration inputs required:**
- `dataSourceSecurityGroupId`: the security group id behind the Transit Gateway
- `dataSourcePort`: the TCP port
- The data-source CIDR block

---

### Option D: PrivateLink (Interface VPC endpoint)

When the data source is exposed as a VPC endpoint service (e.g. a third-party SaaS database with
PrivateLink support).

**Resources the service provider owns:**
- The VPC endpoint service (Network Load Balancer target)
- Allowed principals for your account

**Resources the operator owns:**
- A VPC interface endpoint in the task subnets pointing to the endpoint service
- DNS resolution for the endpoint (private DNS or Route 53 private hosted zone)

**Resources the IaC_App owns:**
- The task security group with an egress rule to the endpoint ENIs on port 443 (or the service port)

**Configuration inputs required:**
- The VPC endpoint service name
- The service port
- Whether private DNS is handled by the endpoint or requires a Route 53 entry

---

### Option E: Direct Connect or site-to-site VPN

When the data source is on-premises, connected through Direct Connect or an IPsec VPN tunnel.

**Resources the network owner owns:**
- The Direct Connect connection or VPN tunnel to the VPC (via a Virtual Private Gateway or Transit Gateway)
- Route propagation or static routes for the on-premises CIDR into the task subnet route tables
- Firewall rules on the on-premises side allowing the task subnet CIDR on the database port

**Resources the IaC_App owns:**
- The task security group with an egress rule to the on-premises CIDR on the configured port

**Configuration inputs required:**
- `dataSourcePort`: the TCP port
- The on-premises CIDR block (for egress rule scoping)
- Confirmation that route propagation reaches the task subnets

---

## IAM action lists

> **Status:** `indicative, pending account validation` (CDK **2.265.0**, no deployed-account
> verification performed yet)
>
> **Runtime policy trimming method:** IAM Access Analyzer policy generation from CloudTrail, applied
> once the Host_Adapter is feature complete. The lists below are a starting position we expect to
> reduce, not a ceiling we intend to keep.

### Deployment_Identity

`indicative, pending account validation` - CDK 2.265.0

- `cloudformation:*` (scoped to the stack)
- `s3:*` on the CDK staging bucket
- `iam:CreateRole`, `iam:DeleteRole`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:GetRole`, `iam:TagRole` (under path prefix, with boundary condition)
- `iam:PassRole` (limited to Runtime_Identity and Task_Execution_Identity only)
- `iam:CreatePolicy`, `iam:DeletePolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`, `iam:CreatePolicyVersion`, `iam:DeletePolicyVersion`
- `ecs:CreateCluster`, `ecs:DeleteCluster`, `ecs:CreateService`, `ecs:DeleteService`, `ecs:UpdateService`, `ecs:RegisterTaskDefinition`, `ecs:DeregisterTaskDefinition`, `ecs:DescribeServices`, `ecs:DescribeClusters`
- `dynamodb:CreateTable`, `dynamodb:DeleteTable`, `dynamodb:DescribeTable`, `dynamodb:UpdateTable`, `dynamodb:TagResource`
- `secretsmanager:CreateSecret`, `secretsmanager:DeleteSecret`, `secretsmanager:TagResource`, `secretsmanager:DescribeSecret`
- `scheduler:CreateScheduleGroup`, `scheduler:DeleteScheduleGroup`, `scheduler:GetScheduleGroup`
- `apigateway:*` (scoped to the app APIs)
- `kms:CreateGrant`, `kms:DescribeKey`
- `ec2:Describe*`, `ec2:CreateVpcEndpoint`, `ec2:DeleteVpcEndpoints`, `ec2:CreateSecurityGroup`, `ec2:DeleteSecurityGroup`, `ec2:AuthorizeSecurityGroupEgress`, `ec2:RevokeSecurityGroupEgress`
- `ecr:*` on the bootstrap container asset repository only, and only on the asset path (the image push). The stack creates no repository of its own, so no `ecr:CreateRepository` is needed; on the `imageUri` path the statement is absent entirely (section 3.8)
- `logs:CreateLogGroup`, `logs:DeleteLogGroup`, `logs:PutRetentionPolicy`, `logs:TagLogGroup`
- `elasticloadbalancing:*` (scoped to the internal NLB)
- `cloudwatch:PutMetricAlarm`, `cloudwatch:DeleteAlarms`, `cloudwatch:DescribeAlarms`

**Does NOT hold:** `secretsmanager:GetSecretValue`, `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`, `kms:Decrypt`

### Runtime_Identity

`indicative, pending account validation` - CDK 2.265.0

- `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:Query`, `dynamodb:BatchWriteItem`, `dynamodb:ConditionCheckItem` (on the app table and its indexes)
- `secretsmanager:GetSecretValue` (on the app secret prefix)
- `kms:Decrypt` (on App_CMK, with `ViaService` condition naming DynamoDB, Secrets Manager and CloudWatch Logs in the Region_Pin)
- `execute-api:ManageConnections` (on the Monitor_API stage)
- `logs:CreateLogStream`, `logs:PutLogEvents` (on the app log group)
- `cloudwatch:PutMetricData` (in the app metric namespace)
- `scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule`, `scheduler:ListSchedules` (on the app schedule group)
- `iam:PassRole` - **exactly one statement**: resource is the Scheduler_Invoke_Identity role ARN, condition `iam:PassedToService = scheduler.amazonaws.com`
- `bedrock:InvokeModel` (on configured model ARNs, where Bedrock provider is configured)

**Does NOT hold:** any other `iam` action, any `ecs` action, any `ecr` action, any `s3` action, any `secretsmanager` action other than `GetSecretValue`, `dynamodb:Scan`

### Task_Execution_Identity

`indicative, pending account validation` - CDK 2.265.0

- `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:BatchCheckLayerAvailability` scoped to the one repository the image reference names: the bootstrap container asset repository on the asset path, the repository parsed out of `imageUri` on a private-ECR reference, and nothing at all on a non-ECR reference (section 3.8)
- `ecr:GetAuthorizationToken` on `*` (the API takes no resource)
- `logs:CreateLogStream`, `logs:PutLogEvents` (on the app log group)
- App_CMK permissions required by the image pull path

**Does NOT hold:** any Run_Table action, any `secretsmanager` action

### Scheduler_Invoke_Identity

`indicative, pending account validation` - CDK 2.265.0

- `execute-api:Invoke` (on the single Trigger_API scheduled-run route)

Trust policy: `scheduler.amazonaws.com` as the only principal, with `aws:SourceArn` condition scoped
to the IaC_App's schedule group.

**Does NOT hold:** any other action on any resource

---

## Notes

- The CDK version pinned in `cloud-aws/package.json` is **2.265.0**. This version governs
  bootstrap role behaviour, synthesis output shape and construct library compatibility. Name it when
  discussing bootstrap with your platform team.
- The `cloud-aws` check command (`npm run check`) is the pre-deploy step that validates everything
  without AWS credentials. Run it before every deploy.
- All IAM policies are managed policies with names derived from the configured name prefix. No role
  carries an inline policy.
- No IAM user or long-lived access key is created. Synthesis fails if the template declares either.
