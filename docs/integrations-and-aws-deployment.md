# External Data Integration & AWS Deployment: Findings and Scope

> Research date: 2026-07-29. Investigation of `engine/`, `cloud/`, `frontend/src/app/core/`,
> `backend/src-tauri/`, `mcp/`.
>
> Two phases, deliberately independent:
> - **Phase 1 — Deterministic data path.** Generic nodes and primitives that let a workflow read from
>   an HTTP API or a database, shape and aggregate the result, and write it to another system, with no
>   language model anywhere in the data path.
> - **Phase 2 — AWS deployment target.** A first-class AWS host alongside the Cloudflare Worker,
>   designed for a medium-sized org running zero-trust IAM, where "click Deploy" is not the starting
>   point — an agreed permission model is.
>
> Everything here is scoped as a **product capability**, not as one customer's integration. A concrete
> customer requirement drove the investigation; it is recorded in Appendix B as a validation case only.

---

## 1. Why this exists

The studio today is excellent at orchestrating *language models*. It is not yet able to move *data*.
A workflow can ask an agent to call an HTTP endpoint, but it cannot deterministically:

- fetch from several endpoints or tables and join the results,
- aggregate rows into a record shape,
- write that record to a third-party API on a schedule,
- and prove afterwards exactly what it sent.

That class of workflow — **scheduled, deterministic, system-to-system sync** — is the single most
requested thing that our node catalog cannot express. It is also the class where an LLM in the data
path is unacceptable: the outputs feed billing, forecasting, and reporting, so a hallucinated number
is a business incident, not a bad answer.

Phase 1 closes that gap generically. Phase 2 makes it deployable inside a regulated AWS estate.

---

## 2. What already exists (verified)

Worth being precise, because most of the orchestration half is already built and should not be rebuilt.

| Capability | Where | Notes |
| --- | --- | --- |
| Cron trigger | `schedule-trigger` node; `rescheduleCron` in `cloud/src/workflow-agent.ts` | Real DO alarms, re-armed on every spec push. Cloud only — there is no local scheduler. |
| Webhook trigger | `POST /agents/workflow-agent/{id}/trigger` | The node's `path` field is currently unused; one endpoint per workflow. |
| Loop | `for-each` node (`ForEachNodeData`: `itemsPath`, `concurrency`, `continueOnError`) | Auto-detects the array in the incoming payload. |
| Durable resume | `RunJournal` in `engine/src/engine.ts`; `run_journal` table in the DO | Keyed `nodeId\|payloadHash\|occurrence`. Replays completed nodes without repeating side effects. |
| Retry / fallback / timeouts / error branch | EPIC 3 primitives, `AgentRetryPolicy`, `error-handler` node | **Retry wraps model calls only.** Tool and HTTP failures return a string, not a retryable error. |
| Run history, trace, usage ledger | `engine/src/run-record.ts`; `runs`, `run_events`, `usage_ledger` tables | Works in BYO and hosted; no D1 required. |
| Live monitor | WebSocket `onConnect` + `ControlFrame` in the DO | Canvas animates a deployed run identically to a local one. |
| Portable engine | `engine/` — **zero dependencies**, no DOM beyond fetch/streams | This is why a second host is feasible at all. |
| Tool host abstraction | `ToolHost` in `engine/src/tools.ts` | Three implementations: Rust desktop, browser fetch, `CloudToolHost`. |
| OAuth patterns | `engine/src/mcp-oauth.ts` (OAuth 2.1 + PKCE), `mcp/phorma-practice-mcp/src/xero-auth.ts` (refresh-token broker, single-flight, rotation callback) | The Xero broker is the template for any token-based connector. |
| Secret storage | OS keychain via `keyring` in `backend/src-tauri/src/llm.rs`; `wrangler secret` in cloud | Desktop and cloud only, provider-scoped. No general-purpose credential entity. |
| Egress hardening | `assertPublicHttpUrl` + `guardedFetchText` in the worker | SSRF guard, timeout, 256 KB cap — hosted mode only. |

### The three structural gaps

1. **No deterministic data path.** `http-tool` is a *tool an agent calls*, and its parameter schema is
   a single `input` string interpolated into one `{{input}}` placeholder (`buildHttpToolRequest`,
   `engine/src/tools.ts`). Any multi-field request body must therefore be authored by a model.
2. **No database access from a deployed workflow.** The only DB path in the repo is an MCP preset for
   Postgres over **stdio**, and `CloudToolHost.listTools` explicitly rejects stdio servers for deployed
   workflows. There is no SQL client in `backend/src-tauri/Cargo.toml` and none in `cloud/`.
3. **No credential entity.** Tool credentials live in `node.data.headers`, i.e. inside the spec JSON
   that gets pushed to the worker and written to exports and version snapshots. Acceptable for a demo
   key; not acceptable for a database password or a long-lived refresh token.

---

## 3. Design principles for Phase 1

These are the constraints every work item below is written against.

1. **Deterministic by default.** Data-path nodes never call a model. Agents remain available for the
   things they are good at — summarising an exception, drafting a notification, classifying an
   anomaly — but they sit *beside* the pipeline, not inside it.
2. **Specs stay portable, secrets never travel.** A node holds a *reference* (`connectionId`), never a
   credential. The spec remains safe to export, diff, version, and push.
3. **Local-to-cloud parity, honestly declared.** Where a node cannot run on a given host (a TCP
   database driver in a Worker, for example), the studio says so at design time rather than failing at
   3am. A per-host capability matrix is part of the deliverable, not an afterthought.
4. **Everything a sync does is auditable.** Request, response status, row counts, and what changed —
   recorded as first-class run events, with payload redaction available for sensitive fields.
5. **Idempotent writes.** A re-run must not double-apply. Delta state and idempotency keys are
   primitives, not per-workflow inventions.

---

## Phase 1 — Deterministic data path

Effort is a t-shirt size: **XS** trivial, **S** contained change, **M** new node plus host wiring,
**L** new subsystem touching engine + all three hosts + UI, **XL** multi-subsystem.

### P1-1 · Connections: a first-class credential entity — **L**

The keystone. Everything else depends on it, so it goes first.

A `Connection` is a named, typed, stored-outside-the-spec credential bundle:

```ts
interface Connection {
  id: string;                   // referenced from node.data.connectionId
  name: string;
  type: 'http' | 'oauth2' | 'sql' | 'aws-sigv4';
  /** Non-secret config: base URL, host/port/database, token endpoint, region. */
  config: Record<string, string>;
  /** Secret field NAMES only. Values live in the host's secret store. */
  secretKeys: string[];
}
```

- **Storage per host:** desktop → OS keychain (extend `backend/src-tauri/src/llm.rs`, which already
  chunks long values and scopes by service name); Cloudflare → `wrangler secret` with a naming
  convention (`CONN_{id}_{key}`), set through the existing secrets wizard in `cloud.service.ts`;
  AWS → Secrets Manager or SSM Parameter Store (Phase 2).
- **Resolution:** hosts implement `resolveConnection(connectionId)` and inject values at execution
  time, exactly as model API keys are substituted today via the `{{API_KEY}}` placeholder.
- **Guardrails:** connection IDs are validated against the deployed host's inventory at push time, so
  a missing secret is a *deploy-time* error. Secret values never appear in run events, exports,
  version snapshots, or the trace panel.
- **UI:** a Connections page in Settings (list, create, test, rotate, "used by N workflows"), plus a
  connection picker on every data node.

### P1-2 · `http-request` flow node — **M**

A real request *step*, not a tool an agent decides to call.

- Method, URL, query params, headers, body — each with `{{path.to.field}}` interpolation against the
  incoming payload (not a single `{{input}}`).
- `connectionId` supplies base URL and auth; auth is applied by the host, never templated by the user.
- Response handling: parse JSON or text, choose what lands in the payload (whole body, or a JSON
  pointer), configurable success codes, and an error out-port for everything else.
- Emits `http-request` / `http-response` run events (method, URL, status, duration, byte count —
  **never** headers or bodies unless the node opts in, and never secrets).
- Reuses the existing SSRF guard and size caps in hosted mode.

### P1-3 · Rate-limit-aware retry for non-model steps — **S**

`AgentRetryPolicy` today only wraps model calls. Generalise the retry wrapper so any node can declare
one, and teach it HTTP semantics: retry on 408/429/5xx and network errors, honour `Retry-After`,
exponential backoff with jitter, and never retry a non-idempotent step unless the node says it is safe.
Reuses the existing `node-retrying` run event.

### P1-4 · `transform` node — **M**

Deterministic reshaping between a source response and a target payload: rename, cast, default,
concatenate, lookup-table mapping (the "source vocabulary → target vocabulary" problem appears in
every integration), conditional expressions, and array projection.

Recommendation: an **expression language** (JSONata-style or a small safe subset) rather than arbitrary
JavaScript. Rationale — it is portable across all three hosts with no sandbox, it is diffable in
version history, and it cannot reach the network or the filesystem. A scripting node is a separate,
later decision with real sandboxing implications, and should not be smuggled in here.

Pairs naturally with AI assistance: the Assistant (EPIC 5) can *draft* a mapping expression, which the
user then reviews. Generated once at design time, executed deterministically forever after.

### P1-5 · `aggregate` node (group / join / rollup) — **M**

The case that motivated this work needs several source calls combined into one record. Generically:

- **Group by** one or more keys, with `count`, `countIf`, `sum`, `min`, `max`, `avg`, `first`, `distinct`.
- **Join** two arrays on a key (inner / left), so "one call per table, then combine" works.
- **Pivot** a grouped result into a flat record — `{group: 'A', bucket: 'x', n: 3}` → `{A_x: 3}` —
  which is exactly the shape most target APIs want.

Doing this in a node rather than in SQL matters when the source is an HTTP API you do not control, or
when the aggregation spans two systems.

### P1-6 · `sql-query` node — **M** per driver family

Scoped now, built when needed. Not on the critical path if the source system is fronted by an HTTP API,
but the node is the difference between "we can integrate with your API" and "we can integrate with your
data".

- One node kind, a `driver` discriminator, one `connectionId`.
- **Parameterised statements only.** Named parameters bound from the payload; string concatenation into
  SQL is not offered by the UI at all. This is the single most important design decision in the node.
- Read-oriented by default: `SELECT` and stored-procedure reads; writes behind an explicit
  "allow writes" toggle on the *connection*, so a read-only credential cannot be misused by a workflow.
- Guardrails: statement timeout, max rows, max result bytes, and a required `LIMIT` prompt when the
  planner cannot see one.
- Returns `{rows: [...], rowCount: n}`; a "Test query" button in the properties panel returns the first
  few rows and the inferred column types (**S** on top, high value for the person building the workflow).

Driver families and honest host constraints:

| Driver | Desktop (Rust/Node) | Cloudflare Worker | AWS (Node runtime) |
| --- | --- | --- | --- |
| PostgreSQL | Yes | Possible over Hyperdrive / TCP sockets | Yes |
| MySQL / MariaDB | Yes | Possible over Hyperdrive / TCP sockets | Yes |
| **SQL Server (MSSQL, TDS)** | Yes | **Assume no** | Yes |
| SQLite / DuckDB (local file) | Yes | No | Only with mounted storage |

On MSSQL in Workers: Cloudflare's managed database connectivity covers Postgres and MySQL, and I found
no TDS-capable driver in this repo to test against, so treat Worker support as unavailable until
someone proves otherwise. **Practical consequence: MSSQL-sourced workflows need the AWS host (Phase 2)
or desktop execution.** That dependency is the strongest single argument for doing Phase 2.

Also note: private/on-prem databases usually cannot be reached from any public serverless runtime
without network plumbing. That is a Phase 2 networking concern (§P2-6), not a driver concern.

### P1-7 · Pagination and batching — **S–M**

Two small primitives that remove a lot of hand-rolled workflow logic:

- **Paginated fetch**: a mode on `http-request` — cursor, page/offset, or `Link` header — that loops
  until exhausted, with a hard page cap, and concatenates results.
- **Batch/chunk**: a mode on `for-each` that yields groups of N items rather than single items, so a
  target API's "max 100 records per call" limit is one config field instead of a subgraph.

### P1-8 · Workflow state store (delta sync + idempotency) — **M**

A small durable key-value API scoped to a workflow, exposed to the engine as a host capability
(alongside `RunJournal`) and surfaced as `state-get` / `state-set` nodes:

- **Delta sync:** store a hash of what was last sent per entity, so a run pushes only what changed.
  This is usually about auditability and blast radius rather than cost, but it also directly answers
  "can we avoid burning the target system's API quota" — yes.
- **Idempotency keys:** so a resumed or retried run cannot double-apply a write.
- **Watermarks:** "last successfully processed timestamp/ID" for incremental extracts.

Host mappings: desktop → IndexedDB (a new store, consistent with EPICs 1/6/7); Cloudflare → the DO's
embedded SQLite; AWS → DynamoDB. Needs a retention/size policy so it cannot grow unbounded.

### P1-9 · `assert` / sanity-guard node — **S**

An expression that must hold or the run fails (or routes to an error branch) *before* the write step.
Prevents the classic silent integration failure: a source query breaks, returns zero rows, and the sync
faithfully writes zeroes over good data. Typical guards are row-count floors, non-null checks, and
period-over-period variance limits ("refuse if the total moved more than X%"). Cheap to build, and the
thing that makes a scheduled sync trustworthy.

### P1-10 · Run-outcome notifications — **S–M**

A scheduled workflow that fails at 3am with nobody watching is worse than no workflow. Needs a
delivery step (email via provider connection, generic webhook, chat webhook) plus a workflow setting
for "notify on failure / on guard breach / on completion", driven off the existing `run-failed` and
`run-completed` events. Should work from any host.

### P1-11 · Sync audit record — **S**

Extend the persisted `RunRecord` with an optional structured summary for data workflows: source row
counts, records considered / changed / written / skipped / failed, and target response codes. This is
what turns "the run succeeded" into "here is what we sent on the 3rd, and why". Reuses the run-record
persistence from EPIC 1 rather than inventing a second store.

### P1-12 · Payload redaction and retention controls — **S–M**

Run events currently store node outputs verbatim, which for data workflows means business records land
in run history. Needed: per-node "do not persist payload" and field-level redaction patterns, plus a
retention setting per workflow. Also a hard requirement for Phase 2 in any regulated estate.

### P1-13 · Mock / replay mode for data nodes — **M**

Building a sync against a production API is unpleasant. Let `http-request` and `sql-query` record
responses on a run and replay them on later runs (a "fixtures" toggle), so a workflow can be iterated
and evaluated (EPIC 4) without touching the source system. Also makes the data nodes testable in CI.

### P1-14 · Reusable connector definitions — **L** — SHIPPED

Once the primitives exist, an integration is a JSON bundle: a connection type, some pre-configured
`http-request` steps, and a mapping table. Packaging that as a shareable "connector" (with the existing
skills library as the distribution precedent) is where the ecosystem value is — but it was premature
until P1-1 through P1-8 were real, so it was deliberately deferred so as not to distort the primitives.

Those primitives now exist, and this shipped: one `*.connector.json` carrying a connection template,
pre-configured steps, mapping tables and starter workflows, installed through a preview that shows
the declared egress and credentials before anything is written. Plan and decisions:
`docs/connector-packaging-plan.md`. Format and packaging: `engine/src/connectors.ts`. A remote
registry, signing and connector auto-update are the follow-ups and are deliberately still absent.

### Phase 1 dependency order

| # | Item | Size | Depends on |
| --- | --- | --- | --- |
| P1-1 | Connections + secret references | L | — |
| P1-2 | `http-request` flow node | M | P1-1 |
| P1-3 | Rate-limit-aware retry for non-model steps | S | P1-2 |
| P1-4 | `transform` node | M | — |
| P1-5 | `aggregate` node | M | P1-4 |
| P1-6 | `sql-query` node (per driver family, incl. MSSQL) | M each | P1-1 |
| P1-7 | Pagination + batching | S–M | P1-2 |
| P1-8 | Workflow state store | M | — |
| P1-9 | `assert` / sanity guard | S | P1-4 |
| P1-10 | Run-outcome notifications | S–M | P1-1 |
| P1-11 | Sync audit record | S | P1-2, P1-6 |
| P1-12 | Redaction + retention | S–M | — |
| P1-13 | Mock / replay | M | P1-2, P1-6 |
| P1-14 | Connector packaging | L | all of the above (shipped) |

**Minimum viable slice for an API-fronted source:** P1-1, P1-2, P1-4, P1-5, P1-8, P1-9 — one **L**,
four **M**, one **S**. `schedule-trigger`, `for-each`, retries, journalling, run history and live
monitoring are already done and need no work.

### Cross-cutting engineering notes

- **New node kinds are cheap by construction.** A kind needs an executor branch in
  `engine/src/engine.ts`, an entry in `NODE_CATALOG` (`frontend/src/app/core/node-catalog.ts`), the
  `WorkflowNodeKind` union in `frontend/src/app/core/workflow.model.ts`, a properties-panel editor, and
  a host implementation per runtime. The registry-driven design is already set up for this.
- **Data nodes are not tools.** They execute in the graph walk, on `message-out` ports, and must not be
  attachable via `tool-link`. Keeping the two concepts separate is what preserves determinism. Exposing
  a *configured* data node to an agent as a tool is a possible later feature, not a Phase 1 goal.
- **The engine must stay dependency-free.** Drivers and fetch implementations belong to hosts, behind
  narrow interfaces in `RunOptions` (the pattern `ToolHost` and `RunJournal` already establish).
- **Capability declaration.** Add a per-host capability set so the studio can warn "this workflow uses
  a node your deploy target cannot run" at push time. Without this, Phase 1 plus multiple hosts becomes
  a support problem.

---

## Phase 2 — AWS deployment target

Today "deploy" means one thing: `npx wrangler deploy` from `cloud/`, streamed through the Rust
`run_streamed_command` and into the studio console (`CloudService.deploy`,
`frontend/src/app/core/cloud.service.ts`). That works because Cloudflare's model is "log in, push code".

An AWS estate in a medium-sized org does not work that way. Deployment is a *negotiated capability*:
an identity that can assume a role, inside an account someone owns, under service control policies,
with a permissions boundary, into a VPC that was designed for you, with encryption keys you were
granted. So Phase 2 is two deliverables of roughly equal weight: **an AWS host** and **a permission
model plus guide that a platform/security team can approve.**

### P2-1 · Runtime host contract — **M** (design), gates everything else

The engine is portable by construction: `engine/` has zero dependencies and no Cloudflare or Tauri
coupling. Everything Cloudflare-specific lives in `cloud/`. Four capabilities must be reimplemented,
and one is genuinely subtle.

| Cloudflare mechanism | What it provides | AWS replacement |
| --- | --- | --- |
| One Durable Object per workflow id | **Single-flight execution** — the platform guarantees one instance | DynamoDB conditional-write lease with TTL + heartbeat. *The subtle one.* |
| DO embedded SQLite (`run_journal`, `runs`, `run_events`, `usage_ledger`) | Durable journal + history co-located with the run | DynamoDB (single-table, `pk = workflow#id`, `sk = run#…`), or RDS if SQL reporting is wanted |
| DO alarms via `this.schedule(cron, 'scheduledRun')` | Cron per workflow, re-armed on each spec push | EventBridge Scheduler — one schedule per `schedule-trigger` node, created/removed on push |
| Hibernating WebSockets (`onConnect`, `ControlFrame`) | Live monitor + inbound control (approve, answer, trigger, stop) | API Gateway WebSocket API, or SSE over an ALB. WebSocket preserves the inbound control path with least redesign. |
| `wrangler secret` | Provider keys and connection secrets | Secrets Manager (rotatable, IAM-scoped) or SSM Parameter Store (cheaper) |

**Design the lease before writing anything else.** The DO gives single-flight for free; without an
equivalent, a cron firing while a previous run is still going, or two tasks starting during a deploy,
produces duplicate writes to a customer's system. Shape: conditional `PutItem` on
`lease#{workflowId}` with a fencing token and TTL, heartbeat while running, release on settle,
takeover permitted only after TTL expiry. Every write the runtime makes carries the fencing token so a
zombie task's writes are rejected. This is the correctness core of the AWS host.

### P2-2 · Recommended architecture — **L**

```
EventBridge Scheduler ─┐
API Gateway (HTTP)  ───┼──► ECS Fargate service (private subnets)
API Gateway (WS)    ───┘         │  container = engine + AWS host adapter
                                 ├──► DynamoDB   (spec, journal, runs, events, usage, leases, state)
                                 ├──► Secrets Manager (provider keys, connections)
                                 ├──► CloudWatch Logs / Metrics
                                 └──► outbound HTTPS (LLM providers, target APIs) via NAT or egress proxy
ECR ◄── image build                   optional: RDS / on-prem DB over VPC routing
```

**Why Fargate over Lambda:** a run is one long-lived in-process graph walk that can suspend on an
approval or an external event, and (with Phase 1) may hold a database connection pool. Lambda's
15-minute ceiling and per-invoke lifecycle fight both. Lambda is a reasonable *secondary* mode for
short deterministic syncs, sharing the same adapter.

**Why not Step Functions:** the engine *is* the state machine. Decomposing the graph walk into SFN
states would mean rewriting the engine, forfeiting local-to-cloud parity — the thing that makes the
canvas debugger work against a deployed run. Not recommended.

**App Runner** is a lighter alternative to Fargate if the org already blesses it, at the cost of less
control over networking.

### P2-3 · Infrastructure as code + studio deploy provider — **M**

- A `cloud-aws/` sibling to `cloud/`: the host adapter plus **CDK** (TypeScript, consistent with the
  codebase; Terraform as an alternative if that is the org standard — worth asking before building).
- The studio's deploy path generalises rather than forks: `CloudService.deploy()` already shells out
  through `run_streamed_command` and streams to the console, and the cloud dialog already branches on
  `provider() === 'cloudflare'`. An AWS branch runs `npx cdk deploy` (or `terraform apply`) through the
  same plumbing. What needs generalising is `deploy-config.service.ts`, which hardcodes Cloudflare
  bindings and DO migrations, and the `/agents/workflow-agent/{id}/…` URL shape the frontend assumes.
- **Never handle raw AWS credentials.** The studio invokes the CLI and inherits the user's ambient
  profile / SSO session. No access keys in settings, no keys in the keychain, no keys on the wire.
  If the session has expired, the studio surfaces the CLI's own error and a "run `aws sso login`" hint.
- A **`cdk diff` / plan preview** before apply, shown in the console, is close to mandatory in a
  change-controlled environment.

### P2-4 · Permission model (the zero-trust core) — **L**

Two identities, never conflated:

**A. Deployment identity** — used by a person or CI to create infrastructure. Broad but temporary and
bounded.
**B. Runtime identity** — the ECS task role the workflow actually runs as. Narrow, permanent, and the
one that matters for blast radius.

#### Deployment identity

- Humans authenticate through **IAM Identity Center** (SSO) and assume a deployment role. CI
  authenticates through **GitHub OIDC** (or the org's equivalent) with a trust policy scoped to
  repo, branch, and environment. **No long-lived access keys in either case.**
- CDK requires a one-time **bootstrap** per account/region, which creates its own roles (deploy,
  file-publishing, image-publishing, lookup, and an execution role CloudFormation assumes). In a
  restricted org this is the step that needs platform-team involvement, because:
  - bootstrap creates IAM roles and an S3 bucket + ECR repo for assets;
  - it accepts a **permissions boundary** (`--custom-permissions-boundary`) — expect this to be
    mandatory, and expect an SCP that denies `iam:CreateRole` / `iam:PutRolePolicy` without it;
  - it accepts a **custom qualifier**, which matters if the account is shared with other CDK apps;
  - the CloudFormation execution role is what actually creates resources, so the deployer's own
    permissions can stay comparatively small.
  Role names and bootstrap behaviour vary by CDK version — confirm against the version we pin rather
  than copying names from documentation.
- Terraform equivalent: a deployment role plus a locked-down state backend (versioned, encrypted S3 +
  DynamoDB lock table), with state treated as sensitive because it can contain secret ARNs.

Deployment-identity permissions, by resource group (least privilege, scoped by tag and name prefix):

| Group | Actions (indicative) | Scoping |
| --- | --- | --- |
| CloudFormation | `cloudformation:CreateStack`, `UpdateStack`, `DescribeStack*`, `CreateChangeSet`, `ExecuteChangeSet`, `GetTemplate` | stack name prefix |
| Asset staging | `s3:PutObject`/`GetObject` on the CDK assets bucket; `ecr:*` limited to the app repo (`PutImage`, `BatchCheckLayerAvailability`, upload actions) | bucket + repo ARN |
| IAM | `iam:CreateRole`, `AttachRolePolicy`, `PutRolePolicy`, `PassRole`, `TagRole` | **path prefix + `PermissionsBoundary` condition**; `PassRole` limited to the task and execution roles |
| Compute | `ecs:*` on the cluster/service, `logs:CreateLogGroup`, `PutRetentionPolicy` | cluster ARN, log-group prefix |
| Data | `dynamodb:CreateTable`, `UpdateTable`, `TagResource` | table name prefix |
| Secrets | `secretsmanager:CreateSecret`, `TagResource`, `PutResourcePolicy` — **not** `GetSecretValue` | name prefix |
| Scheduling | `scheduler:CreateSchedule`, `UpdateSchedule`, `DeleteSchedule`, `GetSchedule` | schedule-group ARN |
| API | `apigateway:*` scoped to the created APIs | resource ARNs |
| KMS | `kms:CreateGrant`, `DescribeKey` on the app CMK | key ARN |
| Networking | `ec2:Describe*` (lookups), security-group create/authorise if we own the SG | VPC-scoped conditions |

Note the deliberate omission: a deployer that can *create* secrets but cannot *read* them. Same for the
data plane — deployment can create the table, not scan it.

#### Runtime identity (ECS task role) — the one to argue for narrowly

| Purpose | Actions | Resource scope |
| --- | --- | --- |
| Journal, history, leases, state | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`, `DeleteItem`, `BatchWriteItem` | the app table (+ its indexes) only; consider `dynamodb:LeadingKeys` conditions for multi-tenant |
| Provider keys + connections | `secretsmanager:GetSecretValue` | **explicit secret ARNs or a strict name prefix**, never `*` |
| Envelope decryption | `kms:Decrypt` (+ `GenerateDataKey` if we encrypt payloads) | the app CMK, with `kms:ViaService` conditions |
| Live monitor push | `execute-api:ManageConnections` | the WebSocket API stage ARN |
| Logs | `logs:CreateLogStream`, `PutLogEvents` | the app log group |
| Bedrock (only if used) | `bedrock:InvokeModel`, `InvokeModelWithResponseStream` | specific model ARNs and region |

Explicitly **not** in the runtime role: any `iam:*`, any `ecs:*` or `ecr:*` (that is the separate task
*execution* role — ECR pull + log creation only), any `secretsmanager:CreateSecret` or `Put*`, and no
`s3:*` unless a feature actually needs it. The runtime writes to exactly one table, reads exactly the
secrets it was granted, and talks to allow-listed endpoints.

Sketch of the shape we would submit for review:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "RunState", "Effect": "Allow",
      "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:Query","dynamodb:DeleteItem","dynamodb:BatchWriteItem"],
      "Resource": ["arn:aws:dynamodb:REGION:ACCT:table/phorma-runtime","arn:aws:dynamodb:REGION:ACCT:table/phorma-runtime/index/*"] },
    { "Sid": "ReadOwnSecrets", "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": ["arn:aws:secretsmanager:REGION:ACCT:secret:phorma/*"] },
    { "Sid": "DecryptViaSecrets", "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": ["arn:aws:kms:REGION:ACCT:key/KEY-ID"],
      "Condition": { "StringEquals": { "kms:ViaService": "secretsmanager.REGION.amazonaws.com" } } },
    { "Sid": "MonitorPush", "Effect": "Allow",
      "Action": ["execute-api:ManageConnections"],
      "Resource": ["arn:aws:execute-api:REGION:ACCT:API-ID/STAGE/POST/@connections/*"] }
  ]
}
```

Treat the action lists as a starting point for review, not as verified-minimal — they must be trimmed
against the adapter once it exists, ideally by running with CloudTrail and IAM Access Analyzer and
generating a policy from observed calls.

#### Org guardrails to expect, and what each costs us

| Guardrail | Consequence for this design |
| --- | --- |
| SCP: deny `iam:*` without a permissions boundary | CDK must be bootstrapped with `--custom-permissions-boundary`; every role we create inherits it |
| SCP: region allow-list | Pin the stack region; Bedrock region must be in the allow-list or that provider is unavailable |
| SCP: deny unencrypted resources / require CMK | DynamoDB, Secrets Manager, CloudWatch Logs and the ECR repo all get the app CMK; adds a key-policy dependency |
| Mandatory tagging (owner, cost centre, data class) | Tags become CDK inputs and part of the deploy config UI |
| No public subnets / no IGW | Egress via NAT or a proxy; ALB/API Gateway is the only ingress |
| Egress allow-list (proxy or firewall) | **Every outbound host must be declared**: LLM provider APIs, target SaaS APIs, package registries at build time. A workflow calling an undeclared host will fail — the studio should surface that error clearly rather than as a generic timeout |
| No inline IAM policies / approved policies only | Our policies ship as managed policies with names the platform team can review |
| Change control on CloudFormation | `cdk diff` output becomes the change record; deploys may need to run from CI rather than a laptop |

### P2-5 · Endpoint authentication — **M**

The Cloudflare host authenticates with `PHORMA_TOKEN` (BYO) or Clerk JWTs (hosted). On AWS the options
are better and should be used: **IAM SigV4** on the HTTP API (the studio signs with the user's SSO
session — no shared secret exists to leak), **Cognito / OIDC via the org IdP**, or a Lambda authorizer
for a shared bearer token. Recommendation: SigV4 as the default, OIDC where non-AWS callers (a webhook
from a SaaS product) need in — those get a separate, narrowly scoped route with request signing or an
HMAC shared secret.

Stated plainly because it is easy to get wrong under time pressure: **no configuration of this host
should be able to expose an unauthenticated trigger endpoint by default.** Public portal routes
(EPIC 9) are the deliberate exception and must remain opt-in, rate-limited, and redacted.

### P2-6 · Networking, including private data sources — **M–L**

- Tasks in **private subnets**, no public IPs. Ingress only via API Gateway (or an internal ALB).
- **VPC endpoints** for DynamoDB (gateway), plus interface endpoints for Secrets Manager, ECR API + DKR,
  CloudWatch Logs, STS and Scheduler — cheaper and tighter than routing that traffic through NAT, and
  often required where NAT is disallowed.
- Reaching a **private or on-prem database** (the main reason a customer needs AWS at all) is one of:
  security-group-to-security-group within the VPC; VPC peering or Transit Gateway to another VPC;
  PrivateLink to a service the data owner publishes; or Direct Connect / site-to-site VPN to on-prem.
  Each is a conversation with the network owner, not a config field — the guide should say so and give
  the diagram for each.
- Outbound: a documented allow-list of hostnames the runtime needs, per configured provider and
  connection. Generating that list from the workflow spec at deploy time is a genuinely nice feature
  and cheap to add (**S**).

### P2-7 · Encryption, retention, residency — **S–M**

Customer-managed KMS key for DynamoDB, Secrets Manager, and log groups. TLS everywhere (already true).
Region pinned and documented for data-residency questions. Run-event retention configurable, with the
Phase 1 redaction controls (P1-12) available — necessary because run history persists node outputs,
which for data workflows means business records.

### P2-8 · Observability and cost — **S–M**

Structured logs to CloudWatch with the run id as a correlation key; metrics for run outcomes, duration,
lease contention, and retry counts; alarms on failed scheduled runs and on lease-takeover events (which
usually mean a task died mid-run). Cost-allocation tags so the estate owner can see the spend. The
existing usage ledger already covers model spend; this is infrastructure spend.

### P2-9 · The deployment guide — **M**

A real deliverable, not a README paragraph. Proposed shape, as `docs/deploy-aws.md`:

1. **What you are deploying** — architecture diagram, the resource list, the data it stores, the
   outbound calls it makes. One page a security reviewer can read.
2. **Decide first** — account and region; who owns the account; CI or laptop deploys; VPC (existing or
   new); how the data source is reached; which LLM providers, and therefore which egress hosts.
3. **Request template for the platform/security team** — copy-pasteable: the deployment role and its
   trust policy, the permissions boundary, CDK bootstrap approval and qualifier, the VPC/subnets and
   endpoints, the KMS key and key-policy grants, the egress allow-list, and the tags. Getting this
   right up front is the difference between a one-day and a three-week onboarding.
4. **Bootstrap** — SSO login, `cdk bootstrap` with the boundary and qualifier, verification.
5. **Configure** — connections and provider keys into Secrets Manager (never into the spec), deploy
   config in the studio.
6. **Deploy** — `cdk diff` → review → `cdk deploy`, streamed in the studio console; what a successful
   run looks like.
7. **Verify** — push a workflow, trigger it, attach the monitor, confirm run history and a scheduled
   fire.
8. **Operate** — rotate secrets, update the image, roll back, read the alarms, prune run history.
9. **Teardown** — `cdk destroy`, plus what is intentionally retained (secrets, logs, table) and how to
   remove it deliberately.
10. **Troubleshooting** — expired SSO session, boundary-denied `CreateRole`, missing VPC endpoint,
    egress-proxy denial, lease contention, and how each presents in the console output.

### Phase 2 effort summary

| # | Item | Size |
| --- | --- | --- |
| P2-1 | Host contract + single-flight lease design | M (design) |
| P2-2 | AWS host adapter: journal, history, events, cron, monitor, secrets | L |
| P2-3 | CDK app + studio deploy provider abstraction + `cdk diff` preview | M |
| P2-4 | Permission model: deploy role, task role, boundary-compatible policies | L |
| P2-5 | Endpoint auth (SigV4 / OIDC) | M |
| P2-6 | Networking: private subnets, VPC endpoints, private-source patterns | M–L |
| P2-7 | KMS, retention, residency | S–M |
| P2-8 | Observability, alarms, cost tags | S–M |
| P2-9 | `docs/deploy-aws.md` guide + platform-team request template | M |
| P2-10 | Per-host capability matrix + push-time validation (shared with Phase 1) | S |

Phase 2 is not a prerequisite for Phase 1 *if* the data source is reachable over the public internet.
It becomes the critical path the moment a source is MSSQL, VPC-private, or on-prem — see P1-6.

---

## Decisions needed before building

1. **Expression language for `transform` / `assert` / `aggregate`** — JSONata, a JMESPath variant, or a
   bespoke minimal grammar. Affects the Assistant's generation prompt and version-history diffs. A
   scripting node is explicitly a separate decision.
2. **IaC tool** — CDK (TypeScript, matches the codebase) or Terraform (often the org standard). Ask
   before building; retrofitting is painful.
3. **Persistence shape on AWS** — DynamoDB single-table (cheap, serverless, fits the DO's key/value
   access patterns) vs RDS (SQL reporting over run history, but a VPC dependency and idle cost).
4. **Monitor transport** — API Gateway WebSocket (keeps the existing bidirectional `ControlFrame`
   protocol) vs SSE + a separate control endpoint (simpler infra, more client work).
5. **Where connection secrets live for local runs** — extend the existing keychain service, or a
   separate encrypted store. Affects P1-1's storage interface.
6. **Multi-tenancy on AWS** — is the AWS host BYO-only (one estate, one tenant), or does hosted mode
   need it too? The Cloudflare host's tenant isolation is structural (instance-name prefixing); on AWS
   it would have to be enforced by DynamoDB key conditions and IAM.
7. **Whether data nodes can ever be exposed to agents as tools.** Not in Phase 1, but the answer shapes
   the node/port model now.

---

## Appendix A — Reference validation case

The requirement that prompted this investigation, generalised (details withheld; it is a validation
case, not the spec):

> A customer wants a nightly, one-way sync of ~20 aggregate counts per client record, from a
> line-of-business platform's database into a SaaS CRM's deal records. The counts are derived with
> filters over status, category, size band and a date predicate, keyed by an external client identifier
> already present in both systems. The numbers drive revenue forecasting and billing. Their engineering
> team will expose the source data as an HTTP API, likely several endpoints across different tables,
> with aggregation required on our side. A later phase adds two-way sync of contact permissions and
> monthly billed-usage figures.

Mapping onto Phase 1: `schedule-trigger` (exists) → `http-request` × N (P1-2) → `aggregate` (P1-5) →
`transform` for the source→target vocabulary mapping (P1-4) → `assert` guard (P1-9) → delta check
against stored state (P1-8) → batched `for-each` (P1-7) → `http-request` upsert (P1-2) → audit record
(P1-11) → notify on failure (P1-10). Not one node of that is customer-specific, which is the point:
this shape recurs in essentially every scheduled integration.

The two questions the customer asked are also generic, and both have generic answers worth building in:

- **"How do we identify the target fields?"** Field labels in a spreadsheet are not identifiers. Every
  mature SaaS API exposes field metadata (for Zoho CRM, `GET /crm/v8/settings/fields?module=…` returns
  per-field API names). A **schema-discovery affordance** on `http-request`/connections — fetch
  the target's field list once, then pick from it — removes an entire class of integration bug.
- **"Can we sync only what changed, to save API quota?"** Yes, and that is exactly P1-8. Worth noting
  the economics are usually not the binding constraint: Zoho's record APIs accept 100 records per call
  at roughly 1 credit per 10 records, against a daily allowance in the tens of thousands, so a few
  hundred records a night is negligible; their Bulk Write path costs a flat 500 credits per job and only
  pays off in the thousands of records
  ([Zoho API limits](https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html),
  [Bulk Write vs Records API](https://help.zoho.com/portal/es/community/topic/kaizen-103-bulk-write-api-using-php-sdk-v5-part-i)).
  Delta sync earns its place through auditability and blast radius, not cost. *Third-party API details
  above were rephrased from vendor documentation for licensing compliance and should be re-checked
  before relying on them.*

---

## Appendix B — Verification status of the claims in this document

- **Verified by reading the code** (paths cited in §2): node-kind catalog, `http-tool`'s single
  `{{input}}` parameter schema, retry applying to model calls only, absence of any SQL driver, cron
  implemented as DO alarms and re-armed on push, `CloudToolHost` rejecting stdio MCP servers, credentials
  living in `node.data.headers`, and the `wrangler deploy` path through `run_streamed_command`.
- **Verified against vendor documentation**: Zoho CRM record-API batch sizes, credit costs, and Bulk
  Write pricing (links above).
- **Assumed, not verified**: that no TDS/SQL Server driver works in a Cloudflare Worker (inferred from
  Cloudflare's managed database connectivity covering Postgres and MySQL, and from nothing in this repo
  to test against). Confirm before promising MSSQL on the Cloudflare host.
- **Indicative only**: all IAM action lists, CDK bootstrap role names, and SCP behaviours. These vary by
  CDK version and by org policy and must be validated against the real account and the real adapter.
- **Not attempted**: no build, test, or deploy was run as part of this investigation, and nothing in the
  repository was modified.
