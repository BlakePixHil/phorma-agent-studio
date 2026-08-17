# Requirements Document

## Introduction

Phase 2 of `docs/integrations-and-aws-deployment.md` adds AWS as a first-class deployment target
beside the Cloudflare Worker. It is two deliverables of roughly equal weight: an **AWS host** that runs
the existing `@phorma/engine` with the same run semantics as the Worker, and a **permission model plus
deployment guide** that a platform or security team can review and approve before anything is created.

The motivating constraint is concrete. Phase 1 shipped the deterministic data path, but
`CLOUDFLARE_CAPABILITIES` deliberately excludes the `mssql` driver and declares
`privateNetworkEgress: false`, so a workflow whose source is SQL Server, VPC-private or on-premises has
exactly two hosts today: a laptop, or nothing. Scheduled execution needs a real host. That is the AWS
host's reason to exist.

The engine is portable by construction: `engine/` has zero dependencies and every host capability
arrives through `RunOptions` (`journal`, `connections`, `dataFetch`, `sql`, `state`, `fixtures`,
`redact`, `capabilities`, `requestApproval`, `waitForEvent`). Phase 2 therefore adds no engine
subsystem. It adds a second host adapter, the infrastructure that runs it, and the identity and
network model around it.

One Cloudflare mechanism has no free equivalent on AWS and is the correctness core of this work: a
Durable Object *is* single-flight per workflow id, guaranteed by the platform. On AWS that guarantee
must be built, because a cron firing while a previous run is still walking the graph, or two tasks
starting during a rolling deploy, means duplicated writes into a customer's system of record.

### Decisions resolved in this document

The research document lists open decisions. This spec resolves the five that gate Phase 2. Each
resolution is a requirement below, not a preference.

| Decision | Resolution | Consequence |
| --- | --- | --- |
| IaC tool | **AWS CDK in TypeScript**, in a `cloud-aws/` sibling to `cloud/` | Matches the codebase and the existing `npx`-through-Rust deploy rail. Terraform is out of scope; retrofitting it later means a second IaC surface, so the decision is recorded rather than hedged. |
| Persistence shape | **DynamoDB single-table** | The Worker's access patterns are already key/value by `(workflowId, runId)`. RDS adds idle cost, a VPC dependency and a migration surface for reporting nobody has asked for yet. |
| Monitor transport | **API Gateway WebSocket API** | Preserves the existing bidirectional `ControlFrame` protocol (`approval`, `event`, `question`, `trigger`, `stop`) with no client redesign, so the canvas keeps animating a deployed run identically. |
| Multi-tenancy | **Single estate, single tenant (BYO only)** | The AWS host is the customer's own account. Hosted multi-tenant AWS is out of scope, but the table key design keeps a `dynamodb:LeadingKeys` condition possible without a data migration. |
| Compute mode | **Fargate only** | A run is one long-lived in-process graph walk that can suspend on an approval and may hold a database connection pool. Lambda's 15 minute ceiling fights both. A Lambda secondary mode is out of scope. |

### Out of Scope

- **Phase 1 node work.** Connections, `http-request`, `transform`, `aggregate`, `sql-query`, the
  workflow state store, fixtures, redaction and connector packaging are shipped. This spec consumes
  them and adds no node kind.
- **Terraform, RDS, SSE monitor transport, Lambda execution mode, hosted multi-tenant AWS.** Each is
  the rejected side of a decision above.
- **AWS Step Functions.** The engine is the state machine. Decomposing the graph walk into states
  would forfeit local-to-cloud parity, which is what makes the canvas debugger work against a
  deployed run.
- **App Runner.** A viable lighter alternative where an organisation already blesses it, at the cost
  of network control. Not built here.
- **Bedrock provider work.** `bedrock` already exists as a `ModelProviderId`; this spec grants the
  runtime identity Bedrock permissions only where an operator configures that provider.
- **Studio-held AWS credentials of any kind.** Not deferred: excluded by Requirement 14.

## Glossary

- **Studio**: The Phorma Agent Studio frontend, including the canvas, the Cloud dialog, the console and
  Settings.
- **Engine**: The host-independent workflow executor in `engine/`, entered through `startRun`.
- **Host**: A runtime that supplies capabilities to the Engine through `RunOptions`. The existing hosts
  are Desktop_Host (Tauri), Browser_Host (browser preview) and Worker_Host (Cloudflare Worker).
- **AWS_Host**: The Host added by this spec: one container image running the Engine plus the
  Host_Adapter on ECS Fargate.
- **Host_Adapter**: The AWS-specific code in `cloud-aws/` that implements every member of the
  Runtime_Host_Contract for AWS_Host.
- **Runtime_Host_Contract**: The named set of capabilities a Host must provide for a deployed run:
  spec storage, RunJournal, run history, run events, usage ledger, WorkflowStateStore, ConnectionStore,
  scheduled runs, live monitor and Execution_Lease.
- **Run_Table**: The single DynamoDB table AWS_Host owns, holding workflow specs, journal entries, run
  records, run events, usage ledger entries, workflow state and leases.
- **Execution_Lease**: The AWS_Host record in Run_Table that grants exactly one Runner the right to
  execute a given workflow id at a given time.
- **Fencing_Token**: A strictly increasing integer stamped on an Execution_Lease and carried by every
  Run_Table write a Runner makes.
- **Runner**: One AWS_Host process attempting or holding an Execution_Lease for one workflow id.
- **Zombie_Runner**: A Runner whose Execution_Lease has been taken over by another Runner, and whose
  Fencing_Token is therefore lower than the value stored on the Execution_Lease.
- **Scheduler**: The EventBridge Scheduler schedule group AWS_Host owns, holding one schedule per
  `schedule-trigger` node of every deployed workflow.
- **Monitor_API**: The API Gateway WebSocket API that carries RunEvents outbound and ControlFrames
  inbound for AWS_Host.
- **ControlFrame**: The existing inbound monitor protocol: `approval`, `event`, `question`, `trigger`
  and `stop` frames, defined once in `cloud/src/workflow-agent.ts` and reused unchanged.
- **Trigger_API**: The API Gateway HTTP API that carries webhook and manual trigger requests, spec
  push, run history reads and connection metadata for AWS_Host.
- **Secret_Store**: AWS Secrets Manager, holding provider keys and Connection secret values for
  AWS_Host.
- **IaC_App**: The AWS CDK application in `cloud-aws/` that creates every AWS_Host resource.
- **Deployment_Identity**: The IAM identity a person or CI pipeline assumes to run the IaC_App.
- **Runtime_Identity**: The ECS task role AWS_Host runs as.
- **Task_Execution_Identity**: The separate ECS task execution role that pulls the container image and
  creates log streams.
- **Scheduler_Invoke_Identity**: The role every Scheduler schedule assumes to invoke the Trigger_API
  scheduled-run route. It is the target role the Runtime_Identity passes when it creates a schedule.
- **Permissions_Boundary**: The IAM policy an organisation requires on every role the IaC_App creates.
- **Deploy_Provider**: The Studio abstraction that maps a chosen deploy target to its command line,
  its instance URL shape and its capability record.
- **Deploy_Runner**: The existing Rust `run_streamed_command` path that streams a child process line by
  line into the Studio console.
- **Plan_Command**: The `cloud-aws` plan verb the Studio runs before a deploy, being a CDK diff plus the
  deploy-time existence preflight of the configured VPC, subnet and App_CMK identifiers. It runs with the
  operator's ambient AWS session, unlike the credential-free check command of Requirement 13.8.
- **App_CMK**: The customer-managed KMS key AWS_Host uses for Run_Table, Secret_Store entries and log
  groups.
- **Egress_Allow_List**: The set of outbound hostnames a deployed workflow needs, derived from the
  workflow spec and the configured providers.
- **AWS_CAPABILITIES**: The `HostCapabilities` record declaring what AWS_Host can run, added to
  `engine/src/capabilities.ts` beside the three existing records.
- **Capability_Validator**: The existing pure function `validateAgainstCapabilities` in
  `engine/src/capabilities.ts`.
- **Deploy_Guide**: The document `docs/deploy-aws.md`.
- **Platform_Request_Template**: The copy-pasteable section of the Deploy_Guide an operator sends to a
  platform or security team.
- **Region_Pin**: The single AWS region an AWS_Host deployment is configured for.

## Requirements

### Requirement 1: Runtime host contract and local-to-cloud parity

**User Story:** As a maintainer, I want the AWS host to satisfy a named contract rather than a
Cloudflare-shaped assumption, so that adding a host never drags host detail into the engine and never
changes what the canvas sees.

#### Acceptance Criteria

1. THE Runtime_Host_Contract SHALL declare exactly 10 capabilities, being spec storage, RunJournal, run
   history, run events, usage ledger, WorkflowStateStore, ConnectionStore, scheduled runs, live monitor
   and Execution_Lease, with exactly one interface per capability and no eleventh member.
2. THE Engine SHALL contain zero imports of any AWS SDK package and zero imports from `cloud-aws/` in
   `engine/src`, counting value imports, type-only imports and dynamic import expressions alike, SHALL
   couple no `engine/src` module to an AWS service client, and SHALL carry no AWS-derived identifier in
   `engine/src` other than the 6 this spec declares, being the `aws-sigv4` Connection type, the
   `bedrock` provider id, the `aws-secrets-manager` `ConnectionSecretScheme` member of Requirement 8.3,
   the `aws-fargate` capability id of Requirement 16.1, the `awsSecretName` function of Requirement 8.2
   and the `AWS_CAPABILITIES` record of Requirement 16.1. This constraint holds independently of whether
   the Engine test suite would pass with such an import present.
3. WHEN AWS_Host executes a workflow, THE Host_Adapter SHALL forward every `RunEvent` the Engine emits
   exactly once, in the Engine's emission order, omitting no emitted event and adding no event kind that
   `RunControllerService.apply` does not already accept.
4. WHEN the Studio attaches a monitor to a run on AWS_Host, THE Studio SHALL render that run through
   `RunControllerService.apply` using the same code path a local run uses, with zero host-specific
   branch in that path.
5. THE Host_Adapter SHALL supply the Engine with `capabilities` set to the AWS_CAPABILITIES record
   declared in `engine/src/capabilities.ts` on every run it starts, and SHALL declare no capability
   value of its own.
6. WHERE a workflow node requires a capability AWS_CAPABILITIES declares as absent, THE Host_Adapter
   SHALL leave the corresponding `RunOptions` member absent, so that the Engine's existing
   missing-capability error names AWS_Host and the absent capability, and SHALL settle that run with a
   failed outcome having executed no node that requires that capability.
7. THE Host_Adapter SHALL execute the Engine version resolved through the `@phorma/engine` path alias,
   so that AWS_Host and Worker_Host run identical engine source, and SHALL fail its build if Engine
   source resolves from any path other than that alias.
8. WHEN the same workflow spec runs with the same trigger input on AWS_Host and on Worker_Host, THE
   Host_Adapter SHALL produce the same ordered sequence of `RunEvent` kinds and node ids as Worker_Host,
   differing only in run id, timestamps and host identity fields.
9. IF AWS_Host starts with any Runtime_Host_Contract capability that AWS_CAPABILITIES declares as
   present left unimplemented by the Host_Adapter, THEN THE Host_Adapter SHALL fail startup before
   accepting any trigger request, SHALL start no run, and SHALL report an error naming each
   unimplemented capability.

### Requirement 2: Single-flight execution lease

**User Story:** As an operator whose workflow writes into a system of record, I want exactly one run of
a workflow in flight at a time, so that a cron firing during a slow run or a rolling deploy cannot
double-apply a write.

#### Acceptance Criteria

1. WHEN a Runner attempts to start a run for a workflow id, THE Host_Adapter SHALL acquire the
   Execution_Lease for that workflow id with a single conditional write whose condition succeeds only
   when no Execution_Lease record exists for that workflow id, or the stored expiry timestamp is at or
   before the acquiring Runner's current time, where every expiry timestamp is stored and compared as an
   absolute UTC epoch millisecond integer.
2. WHEN the Host_Adapter acquires an Execution_Lease, THE Host_Adapter SHALL write, within that same
   conditional write, a Fencing_Token equal to 1 when no record existed and equal to the stored
   Fencing_Token plus 1 when a record existed, so that the written value is strictly greater than every
   Fencing_Token previously stored on that Execution_Lease and no second write is needed to establish it.
3. WHILE a Runner holds an Execution_Lease, THE Host_Adapter SHALL extend the stored expiry timestamp
   once per heartbeat interval, where the heartbeat interval is a fixed value between 5 and 20 seconds
   inclusive, using a single conditional write whose condition succeeds only when the stored
   Fencing_Token equals the Runner's Fencing_Token.
4. WHEN a run reaches a settled outcome of completed, failed or stopped, THE Host_Adapter SHALL release
   the Execution_Lease with a single conditional write that sets the stored expiry timestamp to the
   release time, retains the stored Fencing_Token rather than deleting the record, and succeeds only when
   the stored Fencing_Token equals the Runner's Fencing_Token, so that the next acquisition still
   observes the highest Fencing_Token ever issued for that workflow id.
5. THE Host_Adapter SHALL condition every Run_Table write a Runner makes for a run it is executing,
   covering journal entries, run records, run events, usage ledger entries, workflow state entries and
   Execution_Lease writes, on the stored Fencing_Token equalling that Runner's Fencing_Token, and SHALL
   exempt from that condition only the run-skipped record written by a Runner that acquired no
   Execution_Lease.
6. IF a Zombie_Runner attempts a Run_Table write, THEN THE Host_Adapter SHALL reject that write, SHALL
   leave the stored item unchanged, SHALL make no retry of that write, SHALL stop executing further node
   bodies for that run within one heartbeat interval, SHALL attempt no further Run_Table write for that
   run, and SHALL report termination through a `run-failed` RunEvent delivered over Monitor_API naming
   lease loss as the cause.
7. IF an Execution_Lease acquisition conditional write fails its condition because another Runner holds
   an Execution_Lease whose stored expiry timestamp is after the acquiring Runner's current time, THEN
   THE Host_Adapter SHALL start no run, SHALL write one `run-skipped` record naming the workflow id, the
   trigger source and the holding Fencing_Token read back from the failed condition, and SHALL return
   HTTP 409 to a Trigger_API caller within 5 seconds of receiving that caller's request.
8. WHEN a Runner acquires an Execution_Lease whose stored expiry timestamp had passed while a
   Fencing_Token was still recorded, THE Host_Adapter SHALL publish exactly one lease-takeover metric
   data point within 60 seconds of that acquisition, carrying the workflow id, the superseded
   Fencing_Token and the new Fencing_Token.
9. THE Host_Adapter SHALL set the Execution_Lease expiry timestamp, on acquisition and on every
   heartbeat, to a value at least 3 times the heartbeat interval and at most 300 seconds after the
   writing Runner's current time.
10. THE Host_Adapter SHALL hold at most one Execution_Lease per workflow id in one Runner process, and
    SHALL refuse a second concurrent start attempt for that workflow id through the same Execution_Lease
    conditional write rather than through an in-process check, leaving the stored Fencing_Token and the
    in-flight run unchanged.
11. WHERE a workflow suspends on an approval or an external event, THE Host_Adapter SHALL continue to
    extend the Execution_Lease expiry timestamp once per heartbeat interval for as long as the Runner
    process holds the suspended run, applying no upper bound on suspension duration and no
    suspension-specific timeout.
12. THE Host_Adapter SHALL derive the Execution_Lease partition key from the workflow id alone, using no
    run id, trigger source, task id or process id, so that two runs of the same workflow contend for one
    item and runs of different workflows contend for none.
13. WHEN any trigger source requests a run, THE Host_Adapter SHALL attempt the Execution_Lease
    conditional write as its first Run_Table operation, and SHALL decide whether that run starts from the
    outcome of that write alone, so that no read of lease or run state precedes the write.
14. WHEN two or more Runners attempt to acquire the Execution_Lease for the same workflow id
    concurrently while no unexpired Execution_Lease exists, THE Host_Adapter SHALL grant the
    Execution_Lease and a Fencing_Token to exactly one of those Runners, and SHALL fail the conditional
    write of every other Runner with a condition failure that reports the granted Fencing_Token.
15. IF a heartbeat conditional write fails its Fencing_Token condition, or no heartbeat conditional write
    succeeds before the stored expiry timestamp, THEN THE Host_Adapter SHALL treat that Runner as a
    Zombie_Runner from that moment and SHALL start no further node body for that run.
16. IF an Execution_Lease conditional write fails for a reason other than its condition, such as a
    throttled or transport-failed request, THEN THE Host_Adapter SHALL retry that write at most 3 times
    within 5 seconds in total, SHALL start no run when every attempt fails, and SHALL answer a
    Trigger_API caller with an error response indicating that the Execution_Lease state could not be
    determined, distinct from the response given when another Runner holds the Execution_Lease.

### Requirement 3: Durable journal and resume

**User Story:** As an operator, I want a run that dies mid-flight to resume without repeating work it
already completed, so that a restarted task does not send the same request twice.

#### Acceptance Criteria

1. THE Host_Adapter SHALL implement `RunJournal.lookup` and `RunJournal.record` against Run_Table,
   keyed by workflow id, run id and the Engine's journal key, and SHALL scope every journal read and
   write to a single workflow id and run id, so that no run can read or overwrite another run's entries.
2. WHEN the Host_Adapter records a journal entry, THE Host_Adapter SHALL resolve `RunJournal.record`
   only after Run_Table has acknowledged the write, SHALL hold no journal entry in process memory beyond
   that resolution, and SHALL retry a failed write at most 3 times within 10 seconds total, so that the
   Engine continues only after the entry is persisted.
3. WHEN a Runner starts a run whose run id already has journal entries in Run_Table, THE Host_Adapter
   SHALL read every entry for that run id, across as many paginated reads as the entry count requires
   and for at least 1000 entries, and SHALL supply those entries to the Engine as the run journal before
   the Engine executes its first node, so that the Engine replays completed nodes and performs no model
   call, tool call, HTTP request or SQL statement for them.
4. WHEN a run reaches a settled outcome of completed, failed or stopped, THE Host_Adapter SHALL delete
   every journal entry for that run id after the run record and the run events for that run are
   persisted in Run_Table.
5. WHEN a Runner starts a run that is not a resume, THE Host_Adapter SHALL delete every journal entry
   for the workflow id whose run id differs from the new run id, before the Engine executes the first
   node of the new run.
6. WHEN a Runner process is replaced while a run was in flight, THE Host_Adapter SHALL restart that run
   with the same run id and the same trigger input, so that journal replay applies, and SHALL apply this
   behaviour to every interrupted run regardless of how many nodes that run had completed or how long it
   had been running.
7. THE Host_Adapter SHALL store each journal entry as the `JournalEntry` shape the Engine defines,
   containing `output` and optional `viaPortIds` and no additional field the Engine does not read.
8. IF a journal entry read from Run_Table fails to parse as a `JournalEntry`, THEN THE Host_Adapter
   SHALL treat that key as absent, SHALL execute the corresponding node normally, SHALL leave the run
   running, and SHALL overwrite that key when it records the node's new entry.
9. IF the durable write of a journal entry does not succeed within 3 attempts and 10 seconds total, THEN
   THE Host_Adapter SHALL terminate the run with a `run-failed` RunEvent naming the node and journal
   write failure as the cause, and SHALL report that node as not completed.
10. IF a journal entry serializes to a payload larger than 300 kilobytes, THEN THE Host_Adapter SHALL
    record no entry for that key, SHALL truncate no part of that entry, and SHALL terminate the run with
    a `run-failed` RunEvent naming the node and the 300 kilobyte entry limit.
11. IF a run id has already been restarted 3 times by Runner replacement without reaching a settled
    outcome, THEN THE Host_Adapter SHALL start no further restart of that run id, SHALL record a failed
    outcome naming repeated Runner replacement as the cause, and SHALL delete every journal entry for
    that run id.

### Requirement 4: Run history, run events and usage ledger

**User Story:** As an operator, I want the runs panel, the trace and the usage panel to work against an
AWS deployment exactly as they do against a Worker, so that switching hosts does not cost me the audit
trail.

#### Acceptance Criteria

1. WHEN a run starts on AWS_Host, THE Host_Adapter SHALL persist one `RunRecord` for that run id in
   Run_Table within 5 seconds of the run's first `RunEvent`, carrying every field the existing
   `createRunRecorder` produces for an in-flight run, so that the Studio runs panel lists the run while
   it is still running.
2. THE Host_Adapter SHALL stamp every `RunEvent` of a run with a per-run sequence number starting at 1
   and increasing by exactly 1 per event in emission order, SHALL persist every `RunEvent` of that run in
   Run_Table, and SHALL serve them back ordered by ascending sequence number.
3. THE Trigger_API SHALL serve run history as the `RunRecordSummary` list shape the Studio runs panel
   already consumes, ordered by run start timestamp descending and capped at 100 summaries per response
   with a continuation token when more exist, and run detail as the `RunRecord` plus `RunEvent` list shape
   the trace already consumes, capped at 1000 run events per response with a continuation token when more
   exist.
4. THE Host_Adapter SHALL persist one usage ledger entry per `node-usage` RunEvent, carrying the same
   `UsageLedgerEntry` fields the Worker persists, keyed by workflow id, run id and node id, so that a
   resumed run re-emitting a `node-usage` RunEvent for an already-recorded node replaces that entry rather
   than adding a second one.
5. WHEN a caller requests usage ledger entries with a `since` value that parses as an ISO 8601 UTC
   timestamp, THE Trigger_API SHALL serve every usage ledger entry whose timestamp is at or after that
   value, ordered by ascending timestamp and capped at 1000 entries per response with a continuation token
   when more exist.
6. WHERE `RunOptions.redact` supplies a Redactor, THE Host_Adapter SHALL apply that Redactor to each run
   event and each run record before writing it to Run_Table, and SHALL write no unredacted copy of that
   run event or run record to Run_Table.
7. WHEN the Host_Adapter persists a run event whose payload exceeds 300 kilobytes, measured as UTF-8
   encoded bytes after the Redactor has been applied, THE Host_Adapter SHALL truncate that payload to at
   most 300 kilobytes, SHALL mark the event as truncated, SHALL leave every non-payload field of that
   event unchanged, and SHALL persist the event.
8. THE Host_Adapter SHALL retain run records, run events and usage ledger entries for the configured
   retention period of between 1 and 366 days defaulting to 30 days, SHALL delete each item at or after
   its retention expiry using a DynamoDB time-to-live attribute, and SHALL serve no item whose retention
   expiry has passed even before DynamoDB removes it.
9. WHEN an operator removes a deployed workflow through the Trigger_API purge route, THE Host_Adapter
   SHALL delete that workflow's spec, journal entries, run records, run events, usage ledger entries,
   workflow state and Execution_Lease from Run_Table, SHALL delete its Scheduler schedules, SHALL answer
   only after every one of those deletions has been confirmed or has failed, and SHALL answer with a
   per-category count of deleted items naming any category whose deletion failed, so that repeating the
   purge for the same workflow id deletes the remainder and answers with zero counts once nothing remains.
10. THE Host_Adapter SHALL preserve Secret_Store entries when a workflow is purged, because a Connection
    secret is shared across workflows.
11. WHEN a run settles with an outcome of completed, failed or stopped, THE Host_Adapter SHALL update that
    run's existing `RunRecord` in Run_Table in place with the settled outcome, the end timestamp and the
    optional `sync` Sync_Summary, so that Run_Table holds exactly one `RunRecord` per run id.
12. IF a Trigger_API run history, run detail or usage ledger request names a workflow id or run id absent
    from Run_Table, or carries a `since` value that is not a valid ISO 8601 UTC timestamp, THEN THE
    Trigger_API SHALL answer with a rejection response naming the invalid input, SHALL serve no run
    record, run event or usage ledger entry, and SHALL create no Run_Table item.
13. IF a Run_Table write of a run record, run event or usage ledger entry fails for a reason other than a
    Fencing_Token condition failure, THEN THE Host_Adapter SHALL retry that write at most 3 times, SHALL
    continue the run when those retries are exhausted, and SHALL publish a dropped-audit-write metric data
    point naming the workflow id, the run id and the item category.
14. THE `RunRecordStatus` union SHALL declare a `skipped` member in both structural twins, being the run
    record types in `engine/src` and `frontend/src/app/core/workflow.model.ts`, so that the skipped-run
    records of criteria 2.7 and 6.4 are served by the run history route of criterion 4.3 as an ordinary
    `RunRecordSummary`.
15. WHEN the Studio renders a run whose status is `skipped`, THE Studio SHALL render a status
    representation for that member at each status switch site, being `runs-panel.statusIcon`,
    `portal-panel.runStatusIcon` and the usage analytics status facet, and SHALL render that member
    through no fallback default branch at any of those 3 sites.
16. WHEN the Host_Adapter writes a skipped-run record, THE Host_Adapter SHALL write zero usage ledger
    entries for that run id, because a skipped run executes no node.

### Requirement 5: Workflow state store on AWS

**User Story:** As a workflow author, I want delta sync, watermarks and idempotency claims to behave on
AWS as they do locally, so that a re-run cannot double-apply a write.

#### Acceptance Criteria

1. THE Host_Adapter SHALL implement every member of the Engine's `WorkflowStateStore` interface against
   Run_Table: `get`, `set`, `delete`, `list` and `compareAndSet`, SHALL return the Engine's `StateEntry`
   shape carrying `key`, `value`, `updatedAt` and an `expiresAt` only where an expiry is stored, SHALL
   resolve `get` as absent for a key with no stored entry, and SHALL resolve `delete` without error for a
   key with no stored entry.
2. WHEN between 2 and 100 callers concurrently invoke `compareAndSet` for the same key with the same
   `expected` value, THE Host_Adapter SHALL resolve true for exactly one caller, SHALL resolve false for
   every other caller, and SHALL leave the stored value equal to the value supplied by the caller that
   resolved true.
3. THE Host_Adapter SHALL implement `compareAndSet` as a single DynamoDB conditional write, so that no
   read-then-write window exists between the comparison and the write, and SHALL leave the stored `value`
   and `updatedAt` unchanged for every `compareAndSet` call that resolves false.
4. THE Host_Adapter SHALL return at most 1000 entries from a `list` call, SHALL apply 1000 as the limit
   when the caller supplies none, SHALL clamp a caller-supplied limit to the range 1 to 1000, SHALL return
   only entries whose key begins with the caller-supplied prefix, and SHALL scope every key to the
   workflow id so that no `get`, `list` or `compareAndSet` under one workflow id observes an entry written
   under another.
5. IF a `set` or `compareAndSet` value exceeds 32,768 UTF-8 bytes, THEN THE Host_Adapter SHALL reject the
   call with an error naming the key and the 32,768 byte limit, SHALL write nothing to Run_Table, and SHALL
   leave any existing entry for that key and its `updatedAt` unchanged.
6. WHERE a state entry has a resolved expiry, THE Host_Adapter SHALL store that expiry as a DynamoDB
   time-to-live attribute in epoch seconds equal to the write time plus the resolved time-to-live, and
   SHALL treat an entry whose stored expiry is at or before the current time as absent on `get`, on `list`
   and on the `expected` comparison of `compareAndSet`, even before DynamoDB removes the item.
7. THE Host_Adapter SHALL resolve the time-to-live of every write through the single shared resolution
   function in `engine/src/state.ts`, so that an integer `ttlSec` of 1 to 34,560,000 seconds is applied as
   given, a non-integer or out-of-range `ttlSec` including 0 falls back to the namespace default for that
   key, and a key whose namespace has no default is stored with no time-to-live attribute, matching the
   behaviour of the other hosts.
8. IF a Run_Table request underlying a `get`, `set`, `delete`, `list` or `compareAndSet` call fails for a
   reason other than the conditional check the Host_Adapter placed on it, THEN THE Host_Adapter SHALL
   reject that call with an error naming the operation and the key, SHALL surface the failure as an error
   rather than as a false `compareAndSet` result, and SHALL leave the stored entry unchanged.
9. WHEN a `set` completes, or a `compareAndSet` resolves true, THE Host_Adapter SHALL store the supplied
   value byte-identical and SHALL set `updatedAt` to the time of that write, so that a subsequent `get`
   returns both.

### Requirement 6: Scheduled runs

**User Story:** As an operator, I want cron triggers to fire on AWS with the same semantics as on the
Worker, so that moving a scheduled sync to AWS is a deploy, not a redesign.

#### Acceptance Criteria

1. WHEN a workflow spec is pushed to AWS_Host, THE Host_Adapter SHALL create one Scheduler schedule per
   `schedule-trigger` node of that spec whose `cron` field contains at least one non-whitespace character,
   up to a maximum of 50 schedules for one workflow id, and SHALL set the time zone of every such schedule
   to UTC so that a cron field fires at the same instant it fires on Worker_Host.
2. WHEN a workflow spec is pushed to AWS_Host, THE Host_Adapter SHALL delete every Scheduler schedule it
   previously created for that workflow id, SHALL confirm every one of those deletions, and SHALL issue
   the first create for the new spec only after the last deletion is confirmed.
3. WHEN a Scheduler schedule fires, THE Host_Adapter SHALL attempt exactly one run of the target workflow
   within 60 seconds of the schedule's fire time, with an empty trigger input and a trigger source of
   `schedule`.
4. IF a Scheduler schedule fires while an unexpired Execution_Lease is held for that workflow id, THEN THE
   Host_Adapter SHALL start no run, SHALL persist a skipped-run record naming the workflow id, the schedule
   name and the holding Fencing_Token that the Trigger_API run history route serves, SHALL publish a
   skipped-scheduled-run metric data point, and SHALL leave that schedule enabled for its next fire.
5. THE Host_Adapter SHALL name each Scheduler schedule deterministically from the workflow id and the node
   id, at most 64 characters long and unique within the schedule group, so that pushing an unchanged spec a
   second time yields the same set of schedule names and leaves no schedule from the earlier push.
6. THE Host_Adapter SHALL create every Scheduler schedule in the schedule group the IaC_App owns, and
   SHALL set the Region_Pin as the schedule's region.
7. WHEN a scheduled run settles with a failed outcome, THE Host_Adapter SHALL publish a
   failed-scheduled-run metric data point carrying the workflow id and the run id within 60 seconds of that
   run settling.
8. THE AWS_CAPABILITIES record SHALL declare `features.cron` as true.
9. IF a pushed spec carries a `schedule-trigger` node whose `cron` field Scheduler rejects as an invalid
   schedule expression, or carries more than 50 `schedule-trigger` nodes with a non-empty `cron` field,
   THEN THE Host_Adapter SHALL create and delete no Scheduler schedule for that workflow id, SHALL leave
   the previously deployed spec and its schedules unchanged, and SHALL answer the spec push with an error
   naming the workflow id and the first rejected node id.
10. IF a Scheduler create or delete call for a spec push does not succeed within 3 attempts over at most
    30 seconds, THEN THE Host_Adapter SHALL delete every Scheduler schedule it created during that push,
    SHALL leave no schedule for that workflow id, and SHALL answer the spec push with an error naming the
    workflow id and the node id of the failing call.
11. IF a Scheduler schedule fires for a workflow id whose spec is absent from Run_Table, THEN THE
    Host_Adapter SHALL start no run, SHALL delete that schedule, and SHALL publish a
    skipped-scheduled-run metric data point naming the workflow id.

### Requirement 7: Live monitor and inbound control

**User Story:** As a workflow author, I want to watch a deployed AWS run animate on the canvas and
answer its approvals from there, so that debugging a deployed run feels like debugging a local one.

#### Acceptance Criteria

1. THE Monitor_API SHALL accept the existing ControlFrame union unchanged, being exactly the `approval`,
   `event`, `question`, `trigger` and `stop` frames, and SHALL add no frame kind and remove no field from
   any of them.
2. WHILE a monitor connection is open and authenticated for a workflow id, THE Host_Adapter SHALL forward
   every RunEvent of that workflow's active run to that connection exactly once, in the Engine's emission
   order, and SHALL forward no RunEvent of any other workflow id to that connection.
3. WHEN the Host_Adapter receives an `approval` frame, THE Host_Adapter SHALL resolve the pending approval
   whose `requestId` equals the frame's `requestId`, and SHALL leave every other pending approval, pending
   question and pending wait of that run unchanged.
4. WHEN the Host_Adapter receives a `question` frame, THE Host_Adapter SHALL resolve the pending question
   whose `requestId` equals the frame's `requestId` with the supplied response, and SHALL leave every other
   pending suspension of that run unchanged.
5. WHEN the Host_Adapter receives an `event` frame naming a `correlationKey` for which a waiter is
   registered, THE Host_Adapter SHALL resolve that waiter with the frame payload, and WHERE no waiter is
   registered for that `correlationKey`, THE Host_Adapter SHALL buffer the payload for the remainder of the
   active run and SHALL resolve the first waiter that later registers for that `correlationKey` with it,
   matching the Worker's early-event behaviour.
6. WHEN the Host_Adapter receives a `stop` frame for a run suspended in an approval or a wait, THE
   Host_Adapter SHALL resolve that pending suspension so that the Engine re-enters its gate and raises
   `RunStoppedError`, and SHALL settle that run with a stopped outcome.
7. WHEN the Host_Adapter receives a `trigger` frame, THE Host_Adapter SHALL attempt exactly one run with
   the supplied input through the Execution_Lease conditional write of Requirement 2.
8. IF a `trigger` frame cannot start a run because an unexpired Execution_Lease is held, THEN THE
   Host_Adapter SHALL send a synthetic `run-failed` RunEvent naming the holding Fencing_Token over that
   connection, SHALL start no run, and SHALL leave the in-flight run of that workflow id unaffected,
   because a monitor frame has no HTTP response channel.
9. WHEN a client requests a Monitor_API connection, THE Host_Adapter SHALL authenticate that request before
   the connection is established, and SHALL forward no RunEvent over a connection that has not
   authenticated.
10. IF Monitor_API connection authentication fails, THEN THE Monitor_API SHALL refuse the connection with a
    close code, SHALL forward no RunEvent, and SHALL record no connection id in Run_Table.
11. THE Monitor_API SHALL accept a SigV4 signature produced from the caller's AWS session as a valid
    connection credential, so that the Studio attaches a monitor using the same ambient session it signs
    Trigger_API requests with.
12. THE Host_Adapter SHALL push a RunEvent to Monitor_API using `execute-api:ManageConnections` against the
    Monitor_API stage the IaC_App created, and SHALL hold no other permission against Monitor_API.
13. IF a Monitor_API connection is stale when the Host_Adapter pushes a RunEvent, THEN THE Host_Adapter
    SHALL discard that connection id, SHALL attempt no further push to it, and SHALL continue the run to
    its settled outcome.
14. THE Host_Adapter SHALL continue a run to its settled outcome when zero monitor connections are open,
    and SHALL persist every RunEvent of that run to Run_Table regardless of how many connections are open.
15. IF a frame arriving on an authenticated Monitor_API connection does not parse as a member of the
    ControlFrame union, or names a `requestId` or `correlationKey` with no pending suspension and no
    buffering rule, THEN THE Host_Adapter SHALL ignore that frame, SHALL leave the run's pending
    suspensions unchanged, and SHALL leave the connection open.
16. WHILE more than one monitor connection is open for a workflow id, THE Host_Adapter SHALL forward every
    RunEvent of the active run to every one of those connections, and SHALL accept a ControlFrame from any
    one of them.

### Requirement 8: Secrets and connection resolution

**User Story:** As a security reviewer, I want the deployed runtime to read only the secrets it was
granted and the deployer to be unable to read any, so that a compromised deploy pipeline yields no
credentials.

#### Acceptance Criteria

1. THE Host_Adapter SHALL implement the Engine's ConnectionStore against Secret_Store, SHALL validate the
   connection id with the Engine's existing `assertConnectionId` before reading any Secret_Store entry,
   SHALL resolve each of the 0 to 32 names in `Connection.secretKeys` to exactly one Secret_Store entry, and
   SHALL resolve or reject within 10 seconds of the Engine's `resolve` call.
2. THE Host_Adapter SHALL derive each Secret_Store entry name from the connection id and the secret key
   through a single naming function exported from `engine/src/connections.ts` beside the existing
   `connectionSecretName` and `workerSecretName`, which SHALL return the same name for the same pair on
   every call, a distinct name for every distinct pair, a name at most 512 characters long, and a name
   beginning with the Secret_Store name prefix the IaC_App owns.
3. THE AWS_CAPABILITIES record SHALL declare `connectionSecretScheme` as `aws-secrets-manager`, and THE
   `ConnectionSecretScheme` union SHALL gain that member beside `os-keychain`, `cloudflare-worker-env` and
   `none`.
4. WHEN the Studio pushes a workflow to AWS_Host, THE Studio SHALL send Connection metadata containing
   exactly `id`, `name`, `type`, non-secret `config`, `auth`, the `secretKeys` names, `allowWrites` and
   `limits`, and SHALL send no secret value in any field.
5. THE Trigger_API SHALL serve a Connection inventory as the Engine's `ConnectionSummary` shape, carrying
   `secretsPresent` and `missingSecretKeys` and no secret value, so that the Capability_Validator checks the
   same inventory the Host_Adapter resolves against.
6. THE Runtime_Identity SHALL hold `secretsmanager:GetSecretValue` scoped to explicit secret ARNs or a
   single name prefix the IaC_App owns, and SHALL hold no `secretsmanager` action on any name outside that
   prefix.
7. THE Deployment_Identity SHALL hold `secretsmanager:CreateSecret`, `TagResource` and `PutResourcePolicy`
   scoped to that name prefix, and SHALL hold no `secretsmanager:GetSecretValue`,
   `secretsmanager:BatchGetSecretValue` or `secretsmanager:ListSecretVersionIds` action.
8. THE AWS_Host SHALL expose no Trigger_API route and no Monitor_API frame response that carries a
   Secret_Store value.
9. WHERE an operator supplies a Connection secret value for AWS_Host, THE Studio SHALL write that value
   through a Trigger_API route that stores it in Secret_Store, overwrites any existing entry of that name,
   and answers with only the entry name and the resulting `secretsPresent` count.
10. IF a name in `Connection.secretKeys` is absent from Secret_Store, THEN THE Host_Adapter SHALL reject the
    resolution with a message naming the Connection and the first absent key in `secretKeys` declaration
    order, SHALL attempt no further Secret_Store read for that resolution, and THE Engine SHALL send no
    outbound request for that node.
11. THE Host_Adapter SHALL seed the Phase 1 Redactor with every resolved secret value of 8 characters or
    more, so that no such value appears in whole or as a substring in run events, journal entries, run
    records, CloudWatch log entries, metric dimensions or Trigger_API responses.
12. THE Host_Adapter SHALL read each configured model provider key from Secret_Store and SHALL substitute it
    for the `{{API_KEY}}` placeholder at request time, matching the existing host behaviour, and IF the
    configured provider's key is absent from Secret_Store, THEN THE Host_Adapter SHALL fail that node with
    an error naming the provider and SHALL send no request to it.
13. IF a workflow push to AWS_Host carries a value in a position the Connection metadata shape reserves for
    a secret name, THEN THE Host_Adapter SHALL reject the push, SHALL store no spec, SHALL write no
    Secret_Store entry, and SHALL answer with an error naming the Connection and the offending field.
14. IF a Secret_Store read fails for a reason other than the entry being absent, THEN THE Host_Adapter SHALL
    retry that read at most 3 times within 10 seconds total, and SHALL fail the node with an error naming
    the Connection and Secret_Store unavailability when every attempt fails.
15. IF a Connection secret value supplied through the Trigger_API write route is empty or exceeds 64
    kilobytes, THEN THE Trigger_API SHALL reject the request, SHALL write no Secret_Store entry, and SHALL
    leave any existing entry of that name unchanged.

### Requirement 9: Endpoint authentication

**User Story:** As a security reviewer, I want every trigger route authenticated by default, so that no
configuration of this host can leave an open door into the customer's estate.

#### Acceptance Criteria

1. THE Trigger_API SHALL authenticate every route with exactly one configured mode, SHALL apply AWS SigV4
   as that mode for every route whose configuration names no mode, and SHALL treat a SigV4 signature as
   valid only when the signing identity is permitted to invoke that route and the request signing timestamp
   is within 300 seconds of the Trigger_API clock.
2. WHERE an operator configures OIDC authentication for a route, THE Trigger_API SHALL treat the presented
   token as valid only when its signature verifies against the configured issuer's published keys, its
   issuer claim equals the configured issuer, its audience claim contains the configured audience, and its
   expiry claim is later than the Trigger_API clock, and SHALL invoke the Host_Adapter only for a valid
   token.
3. IF a request to a Trigger_API route carries no valid SigV4 signature and no valid OIDC token, THEN THE
   Trigger_API SHALL answer HTTP 403, SHALL invoke no Host_Adapter route, SHALL create no Run_Table item,
   and SHALL disclose in that response neither the route's configured authentication mode nor the configured
   issuer or audience.
4. IF a Monitor_API connection request carries no valid credential, THEN THE Monitor_API SHALL refuse the
   connection at the connect request before establishing it, SHALL forward no RunEvent, and SHALL record no
   connection id in Run_Table.
5. THE IaC_App SHALL produce a deployment in which every Trigger_API route and every Monitor_API route
   carries an authorizer, except a route an operator has explicitly opted in as a portal route.
6. WHERE an operator opts a portal route in explicitly, THE Trigger_API SHALL serve that route without
   caller authentication, SHALL apply the configured request-rate limit of between 1 and 100 requests per
   second for that route defaulting to 10 requests per second, and SHALL apply the Redactor to every
   response body.
7. THE IaC_App SHALL default every portal route to disabled, so that a deployment with no portal
   configuration exposes no unauthenticated route, and SHALL treat a route that pushes a workflow spec,
   writes a Secret_Store value, purges a workflow or serves run history as ineligible for portal opt-in.
8. THE Studio SHALL sign every Trigger_API request with the operator's ambient AWS session using SigV4.
9. THE Host_Adapter SHALL reject a Trigger_API request addressing a workflow id absent from Run_Table with
   HTTP 404, SHALL create no Run_Table item for it, and SHALL perform that existence check only after the
   route's configured authentication has succeeded, so that an unauthenticated caller cannot learn which
   workflow ids exist.
10. IF a request presents a credential of a mode other than the one that route is configured for, THEN THE
    Trigger_API SHALL answer HTTP 403 and SHALL invoke no Host_Adapter route.
11. IF the IaC_App declares a Trigger_API route or a Monitor_API route that carries no authorizer and that
    no operator configuration has opted in as a portal route, THEN THE IaC_App SHALL fail synthesis with a
    message naming that route.
12. IF requests to a portal route exceed that route's configured request-rate limit, THEN THE Trigger_API
    SHALL refuse the excess requests with a rate-limit rejection response, SHALL invoke no Host_Adapter
    route for them, and SHALL continue serving requests within the limit.
13. IF the operator's ambient AWS session is absent or expired when the Studio is about to call the
    Trigger_API, THEN THE Studio SHALL send no Trigger_API request and SHALL report that the session must be
    renewed, naming `aws sso login` as the next step.

### Requirement 10: Networking and egress control

**User Story:** As a platform engineer, I want the runtime in private subnets with a declared outbound
allow-list, so that I can approve exactly what this workload reaches.

#### Acceptance Criteria

1. THE IaC_App SHALL place every Fargate task in subnets whose route tables carry no route to an internet
   gateway, and SHALL disable public IP address assignment on the Fargate service.
2. THE IaC_App SHALL create a gateway VPC endpoint for DynamoDB and interface VPC endpoints for Secrets
   Manager, ECR API, ECR DKR, CloudWatch Logs, STS and EventBridge Scheduler, SHALL create every interface
   endpoint in the same subnets the Fargate tasks run in, and SHALL enable private DNS on each.
3. THE IaC_App SHALL accept an existing VPC id together with a set of one or more subnet ids as
   configuration, and SHALL create a VPC and subnets only when the configuration supplies neither.
4. WHEN the Studio deploys to AWS_Host, THE Deploy_Provider SHALL derive an Egress_Allow_List from the
   outbound URLs of the workflow specs to be deployed, the `config` of every Connection those specs
   reference, and the configured model providers, containing one entry per distinct hostname compared
   case-insensitively, ordered alphabetically and capped at 200 entries.
5. THE Deploy_Provider SHALL write the Egress_Allow_List to the Studio console as one line per entry
   preceded by a line carrying the entry count, before the Deploy_Runner starts the deploy command, and
   SHALL write a line stating that no outbound hostname was derived when the list is empty.
6. IF a deployed run's outbound request neither connects nor receives a response within 10 seconds, or is
   rejected at connection setup, THEN THE Host_Adapter SHALL fail that node with an error naming the target
   hostname and stating that the hostname may not be in the Egress_Allow_List, and SHALL record no journal
   entry for that node.
7. THE AWS_CAPABILITIES record SHALL declare `features.privateNetworkEgress` as true.
8. THE AWS_CAPABILITIES record SHALL declare `sqlDrivers` as `postgres`, `mysql`, `mssql` and `sqlite`, and
   SHALL declare `features.stdioMcp` as false.
9. THE Deploy_Guide SHALL document each private-source connectivity pattern as a separately titled option,
   being security-group to security-group inside the VPC, VPC peering, Transit Gateway, PrivateLink, and
   Direct Connect or site-to-site VPN, and SHALL state for each the resources the operator owns, the
   resources the network owner owns, and the IaC_App configuration inputs it requires.
10. THE IaC_App SHALL accept the security group of a private data source as configuration, and SHALL create
    the task security group with egress rules only to the VPC endpoints it created, to that configured
    security group on its configured port, and to the ports the Egress_Allow_List entries require, and SHALL
    create no egress rule permitting every destination address.
11. IF the configuration supplies a VPC id, a subnet id or a security group id that is not well formed for
    its kind, supplies an identifier of one of those kinds carrying a region other than the Region_Pin, or
    supplies a subnet the configuration does not declare as a member of the supplied VPC, THEN THE IaC_App
    SHALL fail synthesis with a message naming the offending identifier, SHALL create no resource, and
    SHALL reach that outcome with no AWS credentials present in the environment.
12. IF an outbound hostname in a workflow spec is not a literal value because it is interpolated at run
    time, THEN THE Deploy_Provider SHALL omit it from the Egress_Allow_List, SHALL write a console line
    naming the node whose hostname could not be derived, and SHALL let the deploy proceed.
13. WHEN the Plan_Command runs, THE Plan_Command SHALL verify through `ec2:Describe*` calls in the
    Region_Pin that every configured VPC id, subnet id and security group id exists and that every
    configured subnet is a member of the configured VPC, and SHALL complete that verification before any
    `cdk deploy` invocation.
14. IF the Plan_Command finds a configured VPC id, subnet id or security group id absent from the
    Region_Pin, or finds a configured subnet that is not a member of the configured VPC, THEN THE
    Plan_Command SHALL exit non-zero reporting the same message naming the offending identifier that
    criterion 10.11 states for that identifier, and THE Studio SHALL run no deploy command.

### Requirement 11: Encryption, retention and residency

**User Story:** As a compliance owner, I want to state where this workload's data lives, how long it
lives, and which key protects it, so that I can answer a data-residency question with a fact.

#### Acceptance Criteria

1. THE IaC_App SHALL configure encryption at rest with App_CMK on Run_Table, every Secret_Store entry it
   creates, every CloudWatch log group it creates and the container image repository, and SHALL fail
   synthesis when any one of those resources synthesizes without App_CMK as its encryption key.
2. THE IaC_App SHALL accept an existing KMS key ARN as App_CMK, and SHALL create a customer-managed key in
   the Region_Pin as App_CMK only when an operator supplies no ARN.
3. THE IaC_App SHALL create every resource it declares in the Region_Pin, and SHALL fail synthesis before
   creating any resource when the configured region is absent or is not a syntactically valid AWS region
   identifier, reporting an error that identifies the region configuration value it read.
4. WHEN the operator opens the Cloud dialog, THE Studio SHALL display the Region_Pin of the configured AWS
   deploy target, or an indication that no region is configured when the target names none.
5. THE Host_Adapter SHALL accept a run-event retention period of a whole number of days between 1 and 366
   inclusive, and SHALL default it to 30 days when no period is configured.
6. WHEN the Host_Adapter persists a run event, THE Host_Adapter SHALL apply the workflow's existing per-node
   payload-persistence setting and field-level redaction rules to that event using the Phase 1 Redactor, and
   SHALL persist no payload for a node whose payload-persistence setting is off.
7. THE Runtime_Identity SHALL hold `kms:Decrypt` on App_CMK constrained by a `kms:ViaService` condition that
   names only DynamoDB, Secrets Manager and CloudWatch Logs in the Region_Pin.
8. THE Deployment_Identity SHALL hold `kms:CreateGrant` and `kms:DescribeKey` on App_CMK, and SHALL hold no
   `kms:Decrypt`, `kms:GenerateDataKey*` or `kms:ReEncrypt*` action on App_CMK.
9. IF an operator supplies an App_CMK ARN that is not a well-formed KMS key ARN or that names a region other
   than the Region_Pin, THEN THE IaC_App SHALL fail synthesis before creating any resource, SHALL create no
   key of its own, SHALL report an error indicating that the supplied key ARN is unusable, and SHALL reach
   that outcome with no AWS credentials present in the environment.
10. WHEN a persisted run event becomes older than the retention period in effect when it was persisted, THE
    Host_Adapter SHALL exclude that run event from every run-event read it serves.
11. IF the Phase 1 Redactor fails to process a run event, THEN THE Host_Adapter SHALL persist that run event
    without any payload and SHALL mark the event as carrying a withheld payload.
12. THE IaC_App SHALL set a log retention period on every CloudWatch log group it creates, matching the
    configured run-event retention period, and SHALL grant the Task_Execution_Identity the App_CMK
    permissions the container image pull path requires.
13. WHERE an operator supplies an App_CMK ARN, THE Plan_Command SHALL verify through a `kms:DescribeKey`
    call in the Region_Pin that the ARN names an existing enabled key, and SHALL complete that verification
    before any `cdk deploy` invocation.
14. IF the Plan_Command finds that a supplied App_CMK ARN names no existing enabled key in the Region_Pin,
    THEN THE Plan_Command SHALL exit non-zero reporting the same message indicating that the supplied key
    ARN is unusable that criterion 11.9 states, and THE Studio SHALL run no deploy command.

### Requirement 12: Observability and cost attribution

**User Story:** As an operator, I want to find out that last night's scheduled run failed without
opening the Studio, so that a 3am failure is not discovered a week later.

#### Acceptance Criteria

1. THE Host_Adapter SHALL write every log entry as a single-line JSON object carrying the workflow id, the
   log level and an ISO 8601 UTC timestamp, and SHALL carry the run id on every entry emitted while a run is
   in flight.
2. THE Host_Adapter SHALL publish a metric data point for each of run outcome, run duration, node retry
   count, Execution_Lease takeover, skipped scheduled run and dropped audit write, within 60 seconds of the
   event it measures, carrying the workflow id as a dimension.
3. THE IaC_App SHALL create an alarm that raises when the failed-scheduled-run metric records one or more
   data points within an evaluation period.
4. THE IaC_App SHALL create an alarm that raises when the lease-takeover metric records one or more data
   points within an evaluation period.
5. IF any alarm the IaC_App creates has no configured notification target, THEN THE IaC_App SHALL fail
   synthesis with a message naming that alarm, and SHALL create no resource.
6. THE IaC_App SHALL apply the operator-configured cost-allocation tags to every resource it creates that
   accepts tags.
7. IF the configuration supplies no cost-allocation tag set, or a tag in that set carries an empty value,
   THEN THE IaC_App SHALL fail synthesis with a message naming the missing or empty tag, and SHALL create no
   resource.
8. THE Host_Adapter SHALL exclude every Secret_Store value and every Connection secret from log entries and
   from metric dimensions, by routing every log entry and metric dimension through the same Phase 1 Redactor
   seeded in Requirement 8.
9. THE Host_Adapter SHALL write every log entry for one run to the log group the IaC_App created, so that
   filtering that group by run id yields every entry of that run and no entry of another.
10. IF publishing a metric data point fails, THEN THE Host_Adapter SHALL continue the run to its settled
    outcome, SHALL retry that publication at most 3 times, and SHALL write a log entry naming the metric when
    every attempt fails.

### Requirement 13: Infrastructure as code

**User Story:** As a platform engineer, I want the infrastructure expressed as reviewable code with a
plan preview, so that a deploy is a change record rather than a surprise.

#### Acceptance Criteria

1. THE IaC_App SHALL live in `cloud-aws/` as an AWS CDK application written in TypeScript, and SHALL declare
   no dependency on the `frontend`, `backend` or `cloud` packages.
2. THE IaC_App SHALL create the ECS cluster and Fargate service, the Run_Table, the Trigger_API, the
   Monitor_API, the Scheduler schedule group, the container image repository, the log groups, the
   Runtime_Identity, the Task_Execution_Identity, the alarms and the VPC endpoints, and SHALL create every
   one of them within a single `cdk deploy` invocation.
3. THE IaC_App SHALL accept a CDK bootstrap qualifier as configuration and SHALL apply it to every stack it
   declares, so that it can deploy into an account shared with other CDK applications.
4. THE IaC_App SHALL attach the configured Permissions_Boundary to every IAM role it creates, and SHALL fail
   synthesis when any role it declares synthesizes without that boundary.
5. IF the configuration names no Permissions_Boundary, THEN THE IaC_App SHALL fail synthesis with a message
   stating that a boundary is required, and SHALL create no resource.
6. THE IaC_App SHALL express its IAM policies as managed policies with names derived from a configured name
   prefix, and SHALL attach no inline policy to any role it creates, so that a platform team can review every
   policy by name.
7. THE IaC_App SHALL name every stack and every resource it creates with the configured name prefix, so that
   the resources of one deployment are distinguishable by name from those of another in the same account.
8. THE `cloud-aws` package SHALL provide a check command that runs a TypeScript no-emit compile and a CDK
   synthesis, SHALL pass that command with no AWS credentials present in the environment, and SHALL exit
   non-zero when either step fails.
9. THE IaC_App SHALL pin an exact CDK version in `cloud-aws/package.json`, and THE Deploy_Guide SHALL name
   that version wherever it names a bootstrap role or a bootstrap behaviour.
10. THE `cloud-aws` package SHALL share the repository version number with the four existing packages, and
    THE release script SHALL bump it together with them.
11. IF the IaC_App synthesis produces a template referencing a resource the Deployment_Identity permission
    set of Requirement 15 does not permit creating, THEN THE Deploy_Guide SHALL name that resource type in its
    troubleshooting section together with the permission the platform team must add.

### Requirement 14: Studio deploy provider

**User Story:** As an operator, I want to deploy to AWS from the Studio console with a diff first, and
without the Studio ever holding an AWS key, so that deploying is reviewable and my credentials stay in
my SSO session.

#### Acceptance Criteria

1. THE Studio SHALL offer `aws` as a deploy target beside `phorma` and `cloudflare`, and SHALL persist the
   selected target so that it survives an application restart.
2. THE Deploy_Provider SHALL supply per target the deploy command, the plan command, the working directory,
   the instance URL shape and the capability record, so that the Cloud dialog and `CloudService` read target
   behaviour from one place and carry no branch on the target id.
3. THE Studio SHALL derive every deployed-instance URL through the Deploy_Provider, so that the
   `/agents/workflow-agent/{id}` shape applies to Cloudflare targets only.
4. WHEN an operator deploys to AWS_Host, THE Studio SHALL run the plan command first, SHALL stream its output
   to the console through the Deploy_Runner line by line, and SHALL run no deploy command while the plan
   command is still running.
5. WHEN the plan command exits, THE Studio SHALL require an explicit operator confirmation before running the
   deploy command, and IF the plan command exited non-zero, THEN THE Studio SHALL offer no confirmation and
   SHALL run no deploy command.
6. WHEN an operator confirms, THE Studio SHALL run the deploy command through the Deploy_Runner, SHALL stream
   its output to the console line by line, and SHALL report the command's exit status when it exits.
7. THE Studio SHALL hold no AWS access key, no AWS secret access key and no AWS session token, in settings, in
   the OS keychain, in `localStorage`, in IndexedDB or in any request body.
8. THE Studio SHALL invoke every AWS command through the Deploy_Runner so that the command inherits the
   operator's ambient AWS profile or SSO session, and SHALL set no AWS credential environment variable on that
   command.
9. IF an AWS command exits with an authentication failure, THEN THE Studio SHALL write the command's own error
   output to the console and SHALL add a message naming `aws sso login` as the next step.
10. IF the operator has selected the `aws` target and the configured `cloud-aws` directory is absent or
    contains no CDK application entry point, THEN THE Studio SHALL report the missing directory or entry point
    and SHALL run no command.
11. THE Studio SHALL run AWS deploy commands on the desktop application only, and WHERE the Studio is running
    in the browser preview, THE Studio SHALL report that the browser preview cannot deploy and SHALL run no
    command.
12. THE Studio SHALL generate AWS deploy configuration into a gitignored file, so that an operator never
    hand-edits a version-controlled file that a `git pull` would conflict with.
13. THE Studio SHALL validate the configured account id as 12 digits, the region as a syntactically valid AWS
    region identifier, the name prefix as 1 to 32 characters of lower-case letters, digits and hyphens, and the
    Permissions_Boundary as a well-formed IAM policy ARN, before running any command, and SHALL run no command
    and SHALL name every invalid value while any configured value is malformed.
14. WHEN an AWS command is running, THE Studio SHALL start no second AWS command for the same target, and SHALL
    offer the operator a way to cancel the running command.

### Requirement 15: Permission model

**User Story:** As a security reviewer, I want the identity that builds the infrastructure separated
from the identity that runs the workflow, so that I can approve a small blast radius for the part that
runs continuously.

#### Acceptance Criteria

1. THE IaC_App SHALL create the Deployment_Identity, the Runtime_Identity, the Task_Execution_Identity and
   the Scheduler_Invoke_Identity as four distinct roles, and SHALL grant no permission of one to another.
2. THE Runtime_Identity SHALL hold only these permission groups: Run_Table item actions on the app table and
   its indexes, `secretsmanager:GetSecretValue` on the app secret prefix, `kms:Decrypt` on App_CMK,
   `execute-api:ManageConnections` on the Monitor_API stage, log stream and log event writes on the app log
   group, metric publication in the app metric namespace, `scheduler` create, delete and read actions on the
   app schedule group, exactly one `iam:PassRole` statement whose only resource is the Scheduler_Invoke_Identity
   role ARN and whose condition requires `iam:PassedToService` to equal `scheduler.amazonaws.com`, because
   `scheduler:CreateSchedule` of criterion 6.1 requires it, and WHERE an operator configures the `bedrock`
   provider, model invocation on the configured model ARNs in the Region_Pin.
3. THE Runtime_Identity SHALL hold no `iam` action other than the single conditioned `iam:PassRole` statement
   criterion 15.2 grants, no `ecs` action, no `ecr` action, no `secretsmanager` action other than
   `GetSecretValue`, no `s3` action, and no `dynamodb:Scan` on any resource.
4. THE Task_Execution_Identity SHALL hold only container image pull actions on the app image repository and
   log stream creation on the app log group, and SHALL hold no Run_Table action and no `secretsmanager` action.
5. THE Deployment_Identity SHALL hold CloudFormation, asset staging, IAM role creation under a path prefix
   with the Permissions_Boundary condition, ECS, DynamoDB table creation, Secrets Manager creation, Scheduler,
   API Gateway, KMS grant and EC2 describe actions, each scoped by resource ARN or name prefix, and SHALL hold
   no `dynamodb:GetItem`, `dynamodb:Query` or `dynamodb:Scan` action on Run_Table.
6. THE Deployment_Identity SHALL hold `iam:PassRole` restricted to the Runtime_Identity and the
   Task_Execution_Identity, and to no other role, so that the Scheduler_Invoke_Identity is passed by the
   Runtime_Identity alone under the condition criterion 15.2 states.
7. THE Deployment_Identity trust policy SHALL name an IAM Identity Center permission set, a GitHub OIDC
   provider with conditions on repository, branch and environment, or both together, so that one estate can
   allow human deploys and CI deploys through the same role.
8. THE IaC_App SHALL create no IAM user and no long-lived access key, and SHALL fail synthesis when its
   template declares either.
9. THE Deploy_Guide SHALL label each IAM action list it prints with either `verified against a deployed
   account` or `indicative, pending account validation`, and SHALL name the CDK version and the region any
   verification used.
10. THE Deploy_Guide SHALL name IAM Access Analyzer policy generation from CloudTrail as the method for
    reducing the Runtime_Identity policy once the Host_Adapter is feature complete.
11. THE Deploy_Guide SHALL list each organisation guardrail this design expects and the consequence of each:
    an IAM permissions-boundary requirement, a region allow-list, a customer-managed-key requirement, mandatory
    tagging, an absence of public subnets, an egress allow-list, an approved-policy requirement, and change
    control on CloudFormation.
12. THE `cloud-aws` check command SHALL assert against the synthesized template that the Runtime_Identity
    policy grants no action criterion 15.3 excludes, and SHALL assert that the same policy carries exactly
    one statement whose action set is exactly `iam:PassRole`, whose resource set is exactly the
    Scheduler_Invoke_Identity role ARN, and whose condition requires `iam:PassedToService` to equal
    `scheduler.amazonaws.com`, so that a policy widened by a later change to a second statement, a second
    resource or an absent condition fails the check rather than reaching a review.
13. THE Scheduler_Invoke_Identity SHALL hold exactly one action, being `execute-api:Invoke` on the single
    Trigger_API scheduled-run route, and SHALL hold no other action on any resource.
14. THE Scheduler_Invoke_Identity trust policy SHALL name `scheduler.amazonaws.com` as its only principal and
    SHALL carry an `aws:SourceArn` condition scoped to the Scheduler schedule group the IaC_App owns.
15. THE `cloud-aws` check command SHALL assert against the synthesized template that the
    Scheduler_Invoke_Identity policy grants exactly the one action criterion 15.13 states and that its trust
    policy carries the principal and the `aws:SourceArn` condition criterion 15.14 states.

### Requirement 16: AWS host capability record and push-time validation

**User Story:** As a workflow author, I want the Studio to tell me at design time that my workflow
cannot run on my deploy target, so that I find out on the canvas instead of at 3am.

#### Acceptance Criteria

1. THE `engine/src/capabilities.ts` module SHALL export AWS_CAPABILITIES as a `HostCapabilities` record with
   `id` set to `aws-fargate` and a `label` naming the AWS host, and SHALL include it in `HOST_CAPABILITIES`.
2. THE AWS_CAPABILITIES record SHALL declare `nodeKinds` as every member of `ALL_NODE_KINDS` except those
   AWS_Host cannot execute, SHALL declare `features.durableState` and `features.fixtures` as true, and SHALL
   declare `features.mcpOAuth` as false because an OAuth session never leaves the device that signed in.
3. WHERE the selected deploy target is `aws`, THE Studio SHALL produce design-time capability findings by
   running the Capability_Validator against AWS_CAPABILITIES, and SHALL surface them through the same Problems
   console surface the other targets use.
4. WHEN the Studio pushes a workflow to AWS_Host, THE Studio SHALL run the Capability_Validator against
   AWS_CAPABILITIES and the Trigger_API Connection inventory before sending the spec, and IF any finding has
   severity `error`, THEN THE Studio SHALL send no spec and SHALL write every finding to the Problems console.
5. WHEN the Host_Adapter receives a spec push, THE Host_Adapter SHALL run the Capability_Validator against
   AWS_CAPABILITIES, and IF any finding has severity `error`, THEN THE Host_Adapter SHALL answer with the
   findings, SHALL leave the previously deployed spec unchanged, and SHALL leave the Scheduler schedules
   unchanged.
6. THE Capability_Validator SHALL treat a finding of severity `warning` as non-blocking for both the Studio
   push and the Host_Adapter deployment, so that a spec whose only findings are warnings deploys.
7. THE `capabilities.spec.ts` suite SHALL assert that `HOST_CAPABILITIES` contains exactly four records with
   distinct ids, and that `mssql` is declared by the desktop host and AWS_Host only.
8. THE Studio SHALL treat the Host_Adapter's Capability_Validator result as authoritative when it differs
   from the Studio's own, and SHALL write the Host_Adapter's findings to the Problems console so that an
   operator sees the reason a push the Studio permitted was refused.

### Requirement 17: Deployment guide

**User Story:** As an operator facing a zero-trust AWS estate, I want a guide that tells me what to ask
my platform team for before I try to deploy, so that onboarding takes a day rather than three weeks.

#### Acceptance Criteria

1. THE Deploy_Guide SHALL exist at `docs/deploy-aws.md`.
2. THE Deploy_Guide SHALL contain sections in this order: what you are deploying, decide first, the
   Platform_Request_Template, bootstrap, configure, deploy, verify, operate, teardown, troubleshooting.
3. THE Deploy_Guide SHALL list every resource the IaC_App creates, every data category Run_Table stores, and
   every outbound call the Host_Adapter makes, in a form a security reviewer can read without opening this
   spec or the codebase.
4. THE Platform_Request_Template SHALL be copy-pasteable and SHALL request the Deployment_Identity and its
   trust policy, the Permissions_Boundary, CDK bootstrap approval with the qualifier, the VPC and subnets and
   endpoints, App_CMK and its key-policy grants, the Egress_Allow_List and the tag set, each as a separately
   labelled item an approver can answer individually.
5. THE Deploy_Guide SHALL describe the teardown command and SHALL name every resource teardown retains
   deliberately, together with the action that removes each retained resource.
6. THE Deploy_Guide troubleshooting section SHALL cover an expired SSO session, a boundary-denied role
   creation, a missing VPC endpoint, an egress refusal, and Execution_Lease contention, and SHALL state for
   each the text or symptom it produces in the Studio console and the corrective action.
7. THE Deploy_Guide SHALL state the Fargate-only, single-estate, DynamoDB single-table, WebSocket monitor and
   CDK decisions and the reason for each, so that a reviewer does not have to read this spec to learn them.
8. THE repository steering SHALL gain an `aws-host` area file covering `cloud-aws/`, so that the AWS host has
   the same always-on context the Cloudflare host has.
9. THE Deploy_Guide verify section SHALL name each check an operator performs after a first deploy, being a
   spec push, a manual trigger, a monitor attach, a run history read and a scheduled fire, and SHALL state the
   observable result of each.
10. THE Deploy_Guide SHALL name the `cloud-aws` check command as the step that runs before a deploy, so that a
    synthesis failure is found before a CloudFormation change set is created.

### Requirement 18: Tenancy and estate scope

**User Story:** As the maintainer, I want the AWS host to serve exactly one estate, so that its
isolation story is a simple fact rather than an enforcement claim I have to defend.

#### Acceptance Criteria

1. THE AWS_Host SHALL serve exactly one estate per deployment, with one Run_Table, one Trigger_API and one
   Monitor_API.
2. THE Host_Adapter SHALL derive every Run_Table partition key from the workflow id, so that prefixing those
   keys with a tenant identifier later changes no access pattern and requires no data migration.
3. WHEN the Host_Adapter addresses Run_Table, THE Host_Adapter SHALL scope every read and write to a single
   partition key, and SHALL issue no table scan on any code path.
4. THE Studio SHALL treat the `aws` deploy target as a bring-your-own target, and SHALL apply no Phorma Cloud
   tier limit, no monthly run count and no credit accounting to a run on AWS_Host.
5. THE Host_Adapter SHALL record model spend in the usage ledger with the real provider name and the
   bring-your-own cost field, leaving the Phorma Cloud cost field absent, matching bring-your-own behaviour on
   the other hosts.
6. THE `cloud-aws` check command SHALL assert that the Host_Adapter source contains no DynamoDB scan
   operation, so that criterion 3 cannot regress unnoticed.
