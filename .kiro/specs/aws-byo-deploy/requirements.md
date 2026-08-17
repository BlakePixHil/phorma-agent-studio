# Requirements Document

## Introduction

Phorma Agent Studio offers two deploy shapes. Phorma Cloud is the managed offering and always runs
on Cloudflare. BYO lets the operator deploy into an account they own, and BYO must offer a choice of
either Cloudflare or AWS. Today the AWS choice does not exist: `cloud-aws/` carries pure logic, CDK
constructs and route handlers, but no Settings entry point, no production AWS SDK clients, no
container process, no endpoint discovery and no credential-safe HTTP transport from the webview.

This feature closes the whole path in one cut. An operator whose company forbids Phorma Cloud must
be able to open Settings then Cloud, pick AWS, supply the identifiers their platform team issued,
run a plan, deploy, push a workflow spec, trigger a run, read run history and watch live run events
stream onto the canvas, all inside their own AWS account.

Prerequisite AWS resources (the Deployment_Identity role, the Permissions_Boundary policy, the
VPC and subnets, the App_CMK and the CDK bootstrap stack) are fulfilled by the operator's platform
team from the request template in `docs/deploy-aws.md`. This feature creates none of them. It
invests instead in preflight messages precise enough that a failed check tells the operator exactly
which item to take back to their platform team.

## Glossary

- **Studio**: The Angular application in `frontend/`, running either in the Tauri desktop shell or
  in browser preview.
- **Cloud_Settings_Panel**: The Settings then Cloud surface (`workspace/settings/`) where the
  operator picks a Deploy_Target and configures it.
- **Deploy_Target**: One of the three selectable destinations: `phorma` (Phorma Cloud, managed
  Cloudflare), `cloudflare` (BYO Cloudflare) and `aws` (BYO AWS).
- **AWS_Config_Form**: The AWS body section of the Cloud_Settings_Panel that edits every
  AWS_Config_Field.
- **AWS_Config_Store**: `AwsDeployConfigService`, the signal-backed store that validates and
  persists AWS configuration and generates the Deploy_Config_File.
- **AWS_Config_Field**: One named AWS configuration input, for example `accountId`, `region`,
  `namePrefix`, `permissionsBoundaryArn`, `bootstrapQualifier`, `vpcId`, `subnetIds`, `appCmkArn`,
  `tagSet`, `retentionDays`, `notificationTargetArn`, `cloudAwsDirectory`, `imageUri`,
  `triggerApiUrl`, `monitorApiUrl`.
- **Deploy_Config_File**: `cdk.context.phorma.json`, written by the AWS_Config_Store beside
  `cdk.json` in the configured cloud-aws directory and read by the Phorma_AWS_CLI.
- **Config_Parser**: `cloud-aws/src/core/config.ts`, the pure parse and validate entry point for the
  Deploy_Config_File.
- **Phorma_AWS_CLI**: The `phorma-aws` shim at `cloud-aws/bin/phorma-aws.mjs`, with the verbs
  `plan`, `deploy`, `request`, `monitor-url` and `doctor`.
- **AWS_CLI_Service**: `AwsCliService`, the Studio service that runs Phorma_AWS_CLI commands through
  the Deploy_Runner.
- **AWS_Request_Service**: The Studio service that performs one AWS HTTP call by invoking the
  Phorma_AWS_CLI `request` verb and decoding the Sentinel_Envelope.
- **Cloud_Service**: `CloudService`, the Studio service that pushes specs, triggers runs, reads run
  history and opens the monitor socket.
- **Deploy_Runner**: The Rust `run_streamed_command` Tauri command that spawns an allow-listed
  program, streams its output and accepts `stdin_data`.
- **Sentinel_Envelope**: The Phorma_AWS_CLI stdout framing `__phorma__:{seq}:{base64}`, one line per
  chunk, used to carry an AWS HTTP response or a presigned URL back to the Studio.
- **Preflight**: The existence and reachability checks the `plan` and `doctor` verbs run against
  configured AWS prerequisites.
- **Platform_Prerequisite**: An AWS resource the operator's platform team creates and whose
  identifier the operator supplies: Deployment_Identity, Permissions_Boundary, VPC, subnets,
  App_CMK, notification topic, CDK bootstrap stack.
- **IaC_App**: The CDK application in `cloud-aws/src/infra/`, whose stack is `PhormaAwsHostStack`.
- **Container_Image**: The OCI image the Fargate task runs, sourced either from the
  cloud-aws Dockerfile or from a platform-published `imageUri`.
- **Server_Entry**: The `cloud-aws` process entry point that binds the HTTP port, serves
  `/health`, dispatches the Trigger_Routes, drains the Frame_Inbox and owns Runner lifecycle.
- **Trigger_API**: The AWS HTTP API fronting the eight Trigger_Routes, every route authorized with
  `AWS_IAM`.
- **Trigger_Routes**: `POST /workflows/{id}/spec`, `POST /workflows/{id}/trigger`,
  `DELETE /workflows/{id}`, `GET /workflows/{id}/runs`, `GET /workflows/{id}/runs/{runId}`,
  `GET /workflows/{id}/usage`, `GET /workflows/{id}/connections` and
  `PUT /connections/{connId}/secrets/{key}`.
- **Monitor_API**: The AWS WebSocket API whose `$connect` route is authorized with `AWS_IAM` and
  which pushes RunEvents to connected Studio clients.
- **Host_Adapter**: The `cloud-aws/src/aws/` layer that translates Runtime_Host_Contract capability
  calls into AWS SDK calls.
- **Runtime_Host_Contract**: The ten named capabilities in `cloud-aws/src/core/host-contract.ts`:
  spec, journal, runHistory, runEvents, usageLedger, workflowState, connections, schedules, monitor
  and lease.
- **Run_Table**: The single DynamoDB table holding every workflow-scoped item.
- **Execution_Lease**: The conditional-write lease item carrying the Fencing_Token that makes a run
  single-flight.
- **Fencing_Token**: The strictly increasing `fence` value issued by an Execution_Lease acquire.
- **Frame_Inbox**: The `frame#{arrivedAtMs}#{connectionId}#{n}` Run_Table items holding inbound
  ControlFrames from Monitor_API clients.
- **Check_Pipeline**: `cloud-aws` `npm run check`, which runs with no AWS credentials present and no
  Docker daemon required.
- **Fake_Backend**: Any module under `cloud-aws/src/test/`, for example `FakeRunTable`,
  `fake-secrets-manager`, `fake-scheduler` and `fake-monitor`.
- **Capability_Record**: `AWS_CAPABILITIES` in `engine/src/capabilities.ts`, the record push-time
  validation runs against for the `aws` Deploy_Target.
- **Prior_Spec**: `.kiro/specs/aws-deployment-target/`, the historical spec this feature supersedes.

## Requirements

### Requirement 1: BYO target model and Settings information architecture

**User Story:** As an operator whose company forbids Phorma Cloud, I want the Settings then Cloud
surface to offer AWS as a BYO destination, so that I can configure a deployment into an account my
company already monitors.

#### Acceptance Criteria

1. THE Cloud_Settings_Panel SHALL render one selectable card for each of the three Deploy_Target
   values `phorma`, `cloudflare` and `aws`.
2. THE Cloud_Settings_Panel SHALL label the `cloudflare` and `aws` cards as bring-your-own
   destinations and the `phorma` card as the managed destination.
3. WHEN the operator selects the `aws` card, THE Cloud_Settings_Panel SHALL persist the
   Deploy_Target value `aws` through `SettingsService.cloudProvider`.
4. THE Cloud_Settings_Panel SHALL accept `aws` as a valid argument to its Deploy_Target selection
   handler.
5. WHILE the persisted Deploy_Target is `aws`, THE Cloud_Settings_Panel SHALL render an AWS body
   section containing the AWS_Config_Form, a Plan control, a Deploy control and a Doctor control.
6. WHILE the persisted Deploy_Target is `phorma`, THE Studio SHALL use the Cloudflare Worker
   behaviour, endpoints and monitor authentication that shipped before this feature.
7. WHERE the Studio runs in browser preview, THE Cloud_Settings_Panel SHALL render the `aws` card
   and SHALL display a line stating that deploying to AWS requires the desktop app.
8. WHILE the Studio runs in browser preview, THE Cloud_Settings_Panel SHALL render the Plan, Deploy
   and Doctor controls in a disabled state.
9. THE Cloud_Settings_Panel SHALL render every AWS control with an explicit PrimeNG `small` size and
   SHALL use only Tabler icons.

### Requirement 2: AWS configuration inputs and validation

**User Story:** As an operator, I want every AWS identifier my platform team issued to be entered
and validated in the Studio, so that a malformed value is caught before any AWS call is made.

#### Acceptance Criteria

1. THE AWS_Config_Form SHALL provide one labelled input for each AWS_Config_Field.
2. WHEN the operator edits an AWS_Config_Field, THE AWS_Config_Store SHALL evaluate that field's
   validator and SHALL persist the trimmed value.
3. IF an AWS_Config_Field value fails its validator, THEN THE AWS_Config_Form SHALL display a
   message naming that field and the expected shape.
4. THE AWS_Config_Store SHALL expose a single aggregate validity value that is true only when every
   required AWS_Config_Field holds a value and every populated AWS_Config_Field passes its
   validator.
5. WHILE the aggregate validity value is false, THE Cloud_Settings_Panel SHALL render the Plan and
   Deploy controls in a disabled state and SHALL display the count of invalid or missing fields.
6. THE AWS_Config_Store SHALL treat `imageUri` as optional and SHALL accept a value matching an OCI
   image reference of the form `{registry}/{repository}:{tag}` or
   `{registry}/{repository}@sha256:{digest}`.
7. THE AWS_Config_Store SHALL treat `triggerApiUrl` and `monitorApiUrl` as values written by
   endpoint discovery and SHALL render them in the AWS_Config_Form as read-only text.
8. THE Config_Parser SHALL validate `imageUri`, `triggerApiUrl` and `monitorApiUrl` with the same
   accepted shapes the AWS_Config_Store enforces, and SHALL raise a `ConfigError` naming the field
   on a mismatch.
9. THE Config_Parser SHALL reject a `triggerApiUrl` whose scheme is other than `https` and a
   `monitorApiUrl` whose scheme is other than `wss`.
10. THE AWS_Config_Store SHALL keep every AWS_Config_Field free of AWS credential material.

### Requirement 3: Deploy configuration file round trip

**User Story:** As an operator, I want the generated deployment configuration file to be readable by
the CLI that consumes it, so that a deploy does not fail on the Studio's own output.

#### Acceptance Criteria

1. THE AWS_Config_Store SHALL emit Deploy_Config_File content that a single `JSON.parse` call
   accepts without preprocessing.
2. THE AWS_Config_Store SHALL carry the generated-file provenance notice inside a JSON string
   member of the emitted object rather than as leading comment lines.
3. WHEN the Phorma_AWS_CLI loads the Deploy_Config_File, THE Phorma_AWS_CLI SHALL parse content
   produced by the AWS_Config_Store and SHALL pass the parsed object to the Config_Parser.
4. IF the Config_Parser rejects the Deploy_Config_File, THEN THE Phorma_AWS_CLI SHALL write the
   `ConfigError` message to stderr and SHALL exit with a non-zero code.
5. THE AWS_Config_Store specification SHALL parse the emitted content with a bare `JSON.parse` call
   and SHALL contain no comment-stripping step.
6. WHEN the operator runs Plan or Deploy, THE Cloud_Settings_Panel SHALL rewrite the
   Deploy_Config_File before the Phorma_AWS_CLI is invoked.

### Requirement 4: Container image dual path

**User Story:** As a platform engineer, I want the stack to consume either an image the deploy
builds or an image my team already published, so that image provenance follows my company's supply
chain rules.

#### Acceptance Criteria

1. WHERE `imageUri` is absent from the Deploy_Config_File, THE IaC_App SHALL source the
   Container_Image from a CDK Docker image asset built from `cloud-aws/Dockerfile`.
2. WHERE `imageUri` is present in the Deploy_Config_File, THE IaC_App SHALL source the
   Container_Image from that reference and SHALL create no ECR repository.
3. THE `cloud-aws/Dockerfile` SHALL produce an image whose default command starts the Server_Entry
   and whose runtime contains the `curl` binary the task health check invokes.
4. THE IaC_App SHALL complete `cdk synth --quiet` with no AWS credentials present and no Docker
   daemon running, for both the asset path and the `imageUri` path.
5. WHERE `imageUri` is absent AND the Docker daemon is unreachable, WHEN the operator runs Plan or
   Deploy, THEN THE Preflight SHALL exit non-zero with a message naming Docker as the missing
   prerequisite before any `cdk deploy` step starts.
6. THE IaC_App template assertions SHALL assert that the template declares zero
   `AWS::ECR::Repository` on both paths, that on the asset path the container image resolves through
   the CDK bootstrap image repository and the asset manifest carries exactly one Docker image entry,
   and that on the `imageUri` path the container image equals the configured reference verbatim and
   the asset manifest carries zero Docker image entries.
7. WHEN the operator sets `imageUri`, THE AWS_Config_Form SHALL display that the deploy will
   reference the supplied image and will run no local image build.

### Requirement 5: Preflight and doctor prerequisite naming

**User Story:** As an operator, I want a failed preflight to name the exact prerequisite that is
missing, so that I return to my platform team with one specific request instead of a guess.

#### Acceptance Criteria

1. WHEN the operator runs the `plan` verb, THE Phorma_AWS_CLI SHALL run the Preflight to completion
   before it runs `cdk diff`.
2. IF a Platform_Prerequisite named in the Deploy_Config_File is absent, THEN THE Preflight SHALL
   write one failure line naming the AWS_Config_Field, the supplied value, the target region and the
   matching item in the `docs/deploy-aws.md` platform request template.
3. THE Preflight SHALL check the VPC, every listed subnet and its VPC membership, the data source
   security group, the App_CMK and its enabled state, the Permissions_Boundary policy, the CDK
   bootstrap stack for the configured qualifier, and the caller's ability to assume the
   Deployment_Identity.
4. THE Preflight SHALL report every failure it detects in one run rather than stopping at the first
   failure.
5. IF the Preflight detects at least one failure, THEN THE Phorma_AWS_CLI SHALL exit with a non-zero
   code and SHALL run no `cdk diff` or `cdk deploy` step.
6. WHEN the operator runs the `doctor` verb, THE Phorma_AWS_CLI SHALL exit 0 when every check
   passes, 2 when the Deploy_Config_File is absent, 3 when the CDK entry point is absent and 4 when
   the AWS session is invalid or expired.
7. IF the `doctor` verb exits 4, THEN THE AWS_CLI_Service SHALL display a message naming
   `aws sso login` as the next step.
8. THE Studio SHALL offer no control that creates a Platform_Prerequisite, and THE IaC_App SHALL add
   no IAM-creating action to the Deployment_Identity policy.
9. THE `cloud-aws` package SHALL contain no bootstrap stack and no bootstrap script that creates a
   Platform_Prerequisite.

### Requirement 6: CLI dependency completeness

**User Story:** As an operator, I want every `phorma-aws` verb to run in a fresh install, so that
plan, request, monitor-url and doctor are usable rather than failing on module resolution.

#### Acceptance Criteria

1. THE `cloud-aws` package SHALL declare every module specifier the Phorma_AWS_CLI imports as a
   dependency at an exact version.
2. WHEN any of the five Phorma_AWS_CLI verbs is invoked after a clean install, THE Phorma_AWS_CLI
   SHALL resolve every module it imports.
3. THE Check_Pipeline SHALL assert that every static and dynamic import specifier under
   `cloud-aws/bin/` and `cloud-aws/src/aws/` is declared in `cloud-aws/package.json`.
4. IF a Phorma_AWS_CLI verb receives fewer arguments than it requires, THEN THE Phorma_AWS_CLI SHALL
   write a usage line naming the verb and its arguments to stderr and SHALL exit with a non-zero
   code.
5. THE Phorma_AWS_CLI SHALL read AWS credentials only from the ambient profile or SSO session
   resolved by the Node provider chain.

### Requirement 7: Server entry point and health endpoint

**User Story:** As an operator, I want the deployed Fargate task to serve HTTP, so that the load
balancer health check passes and my triggers reach a running process.

#### Acceptance Criteria

1. THE Server_Entry SHALL bind TCP port 8080 on start.
2. WHEN an HTTP `GET /health` request arrives AND the startup completeness assertion has passed,
   THE Server_Entry SHALL respond with status 200 within 1000 ms.
3. IF the startup completeness assertion fails, THEN THE Server_Entry SHALL write the name of each
   unsatisfied Runtime_Host_Contract capability to stderr and SHALL terminate with a non-zero exit
   code.
4. THE Server_Entry SHALL dispatch each of the eight Trigger_Routes to its `trigger-routes` handler
   by matching both HTTP method and path template, including path parameters.
5. IF an incoming request matches no Trigger_Route, THEN THE Server_Entry SHALL respond with status
   404 and a JSON body naming the unmatched method and path.
6. IF a Trigger_Route handler throws, THEN THE Server_Entry SHALL respond with status 500, SHALL log
   the error and SHALL continue accepting requests.
7. THE Server_Entry SHALL drain the Frame_Inbox on an interval no longer than 1000 ms while a run
   holds an Execution_Lease, and SHALL deliver each drained ControlFrame to the Runner in arrival
   order.
8. WHEN the Server_Entry receives SIGTERM, THE Server_Entry SHALL stop accepting new requests,
   release any held Execution_Lease and exit 0 within 30 seconds.
9. THE Server_Entry SHALL read its Run_Table name, region and Monitor_API endpoint from environment
   variables the IaC_App sets on the task definition.

### Requirement 8: Production AWS SDK clients behind every capability

**User Story:** As an operator, I want the deployed host to talk to real AWS services, so that runs
actually persist, schedule and stream in my account.

#### Acceptance Criteria

1. THE Host_Adapter SHALL provide one production implementation for each of the ten
   Runtime_Host_Contract capabilities, and each implementation SHALL issue its calls through an
   `@aws-sdk` client.
2. THE Host_Adapter SHALL type every constructor parameter and exported signature against an
   interface that both the production AWS SDK client and a Fake_Backend satisfy, and SHALL reference
   no Fake_Backend type.
3. THE Host_Adapter SHALL back Run_Table access with a DynamoDB document client, monitor pushes with
   an API Gateway Management client, connection secrets with a Secrets Manager client, schedules
   with an EventBridge Scheduler client and telemetry with a CloudWatch client.
4. THE Host_Adapter SHALL perform every run-scoped Run_Table write as a `TransactWriteItems`
   carrying a `ConditionCheck` on the Execution_Lease item asserting `fence = :mine`.
5. THE Host_Adapter SHALL write the skipped-run record as the single unfenced Run_Table write.
6. THE Host_Adapter SHALL address every read by partition key using `Query` or `GetItem`, and SHALL
   issue no DynamoDB `Scan` operation.
7. WHEN a monitor push targets a connection that has gone away, THE Host_Adapter SHALL delete that
   connection record and SHALL continue pushing to the remaining connections.
8. THE `cloud-aws` package SHALL declare every `@aws-sdk` package it imports at an exact version.
9. THE `engine/src` directory SHALL contain no import of any `@aws-sdk` package, in value, type-only
   or dynamic form.
10. THE Host_Adapter SHALL keep AWS SDK usage inside `cloud-aws/src/aws/`, and THE `cloud-aws/src/core`
    directory SHALL remain free of AWS SDK imports and I/O.

### Requirement 9: Endpoint discovery from deploy outputs

**User Story:** As an operator, I want the deploy to tell the Studio where my endpoints are, so that
push, trigger, history and monitoring work without me copying URLs by hand.

#### Acceptance Criteria

1. THE IaC_App SHALL emit one CloudFormation output carrying the Trigger_API base URL and one
   carrying the Monitor_API WebSocket URL, each under a stable output name.
2. WHEN a Deploy command exits 0, THE AWS_CLI_Service SHALL read those two outputs and SHALL persist
   their values into the `triggerApiUrl` and `monitorApiUrl` AWS_Config_Fields.
3. WHEN the AWS_CLI_Service persists discovered endpoints, THE AWS_Config_Store SHALL rewrite the
   Deploy_Config_File so the Phorma_AWS_CLI reads the same values.
4. IF the AWS_CLI_Service cannot read an expected output after a successful deploy, THEN THE
   AWS_CLI_Service SHALL display a message naming the missing output and SHALL leave the previously
   stored endpoint values unchanged.
5. WHILE `triggerApiUrl` and `monitorApiUrl` hold values, THE Cloud_Settings_Panel SHALL display
   both URLs in the AWS body section.
6. WHILE either endpoint value is absent, THE Cloud_Settings_Panel SHALL display that the workflow
   surfaces stay unavailable until a deploy completes.

### Requirement 10: SigV4 HTTP transport through the CLI shim

**User Story:** As an operator, I want the Studio to reach my SigV4-protected Trigger_API, so that
pushing a spec and reading run history work from a webview that holds no AWS credentials.

#### Acceptance Criteria

1. THE AWS_Request_Service SHALL perform one AWS HTTP call by invoking the Phorma_AWS_CLI `request`
   verb through the Deploy_Runner, passing the full URL as the third argument, the HTTP method as
   the fourth argument and the request body on stdin.
2. THE AWS_Request_Service SHALL pass the request body to the Deploy_Runner through the
   `stdin_data` parameter.
3. THE Phorma_AWS_CLI `request` verb SHALL sign the call with SigV4 for the `execute-api` service in
   the configured region using ambient credentials.
4. THE Phorma_AWS_CLI `request` verb SHALL emit the HTTP status code, the response headers and the
   response body through the Sentinel_Envelope so the caller can distinguish an HTTP error status
   from a transport failure.
5. THE AWS_Request_Service SHALL reassemble Sentinel_Envelope lines in ascending sequence order,
   base64-decode each chunk and concatenate the chunks into the response payload.
6. IF a Sentinel_Envelope sequence number is missing or arrives out of order, THEN THE
   AWS_Request_Service SHALL fail the call with a message naming the missing sequence number.
7. IF the Phorma_AWS_CLI `request` verb exits with the authentication failure code, THEN THE
   AWS_Request_Service SHALL surface a message naming `aws sso login` as the next step.
8. WHILE the persisted Deploy_Target is `aws`, THE Cloud_Service SHALL route every Trigger_API call
   through the AWS_Request_Service instead of `fetch` with a bearer header.
9. THE AWS_Request_Service SHALL depend on the Deploy_Runner and SHALL inject neither Cloud_Service
   nor any service that injects Cloud_Service.
10. THE AWS_Request_Service SHALL execute a request without acquiring the AWS_CLI_Service Plan and
    Deploy concurrency guard, so a data read proceeds while a deploy runs.
11. WHERE the Studio runs in browser preview, WHEN a Trigger_API call is attempted, THEN THE
    AWS_Request_Service SHALL return a failure carrying a message stating that AWS calls require the
    desktop app.

### Requirement 11: Presigned live monitor connection

**User Story:** As an operator, I want live run events from my AWS deployment to animate the canvas,
so that a deployed run is as observable as a local one.

#### Acceptance Criteria

1. WHEN the operator requests a monitor connection AND the persisted Deploy_Target is `aws`, THE
   Cloud_Service SHALL obtain a presigned Monitor_API `$connect` URL through the Phorma_AWS_CLI
   `monitor-url` verb and SHALL open the WebSocket with that URL.
2. THE Phorma_AWS_CLI `monitor-url` verb SHALL presign the `$connect` request for the `execute-api`
   service with an expiry of 300 seconds and SHALL emit the resulting URL through the
   Sentinel_Envelope.
3. THE Cloud_Service SHALL decode the `monitor-url` Sentinel_Envelope through the same reassembly
   path the AWS_Request_Service uses.
4. WHILE the persisted Deploy_Target is `phorma` or `cloudflare`, THE Cloud_Service SHALL open the
   monitor WebSocket with the existing query-token URL shape.
5. IF the presign step fails, THEN THE Cloud_Service SHALL display a message naming the failure and
   SHALL open no WebSocket.
6. WHEN a RunEvent arrives over the AWS monitor WebSocket, THE Cloud_Service SHALL pass it to
   `RunControllerService.apply` without transformation.
7. WHEN the Studio sends a ControlFrame over the AWS monitor WebSocket, THE Monitor_API SHALL write
   it to the Frame_Inbox for the Server_Entry to drain.
8. IF the presigned URL expires while a monitor session is open, THEN THE Cloud_Service SHALL obtain
   a fresh presigned URL on the next reconnect attempt.

### Requirement 12: Push-time capability validation and target-aware URLs

**User Story:** As an operator, I want the Studio to validate my workflow against what the AWS host
supports before it pushes, so that I learn about an unsupported node in the editor rather than at
runtime.

#### Acceptance Criteria

1. WHEN the operator pushes a workflow spec AND the persisted Deploy_Target is `aws`, THE Studio
   SHALL validate the spec and connection inventory against the Capability_Record.
2. IF validation produces at least one error-severity finding, THEN THE Studio SHALL block the push
   and SHALL display each finding.
3. WHILE validation produces only warning-severity findings, THE Studio SHALL allow the push to
   proceed.
4. THE Cloud_Service SHALL derive every deployed-instance URL from the selected Deploy_Target's
   registry `instanceUrl` function rather than from a hardcoded path shape.
5. WHILE the persisted Deploy_Target is `aws` AND the aggregate configuration validity value is true
   AND `triggerApiUrl` holds a value, THE Cloud_Service SHALL report the target as configured.
6. WHILE the persisted Deploy_Target is `aws`, THE Cloud_Service SHALL address the eight
   Trigger_Routes at the paths the `aws` registry entry yields.
7. WHEN the operator runs a Deploy command, THE AWS_CLI_Service SHALL write the derived egress
   allow-list to the console before the deploy step starts.
8. WHERE the selected Deploy_Target declares no endpoint for an operation, THE Cloud_Service SHALL
   resolve that operation to the documented absent value instead of raising an error or addressing
   an undeclared route, resolving the deployed-status read to the unknown value `null` rather than
   to `not deployed` and resolving the connection-secret-name listing to an empty list.

### Requirement 13: Check pipeline guard against fake-backed production code

**User Story:** As a maintainer, I want the check pipeline to fail when production code is backed by
a test double, so that the class of gap this feature closes cannot silently reopen.

#### Acceptance Criteria

1. THE Check_Pipeline SHALL run a guard that fails when a module under `cloud-aws/src/aws/` imports
   from `cloud-aws/src/test/` or references a Fake_Backend type.
2. THE Check_Pipeline guard SHALL fail when a module under `cloud-aws/src/aws/` that implements a
   Runtime_Host_Contract capability contains no `@aws-sdk` import.
3. THE Check_Pipeline guard SHALL fail when the Server_Entry module is absent or binds no HTTP
   listener.
4. THE Check_Pipeline guard SHALL fail when `cloud-aws/Dockerfile` is absent.
5. THE Check_Pipeline SHALL complete with no AWS credentials present and with no Docker daemon
   running.
6. THE Check_Pipeline SHALL keep the existing `check-no-scan`, `check-engine-purity`,
   `check-engine-alias`, `check-versions` and `check-docs` guards passing.
7. THE repository CI workflow SHALL run the Check_Pipeline including the new guard.
8. THE `cloud-aws` test suite SHALL cover the Server_Entry route dispatch, the Sentinel_Envelope
   reassembly and the Container_Image path switch.

### Requirement 14: Superseded note on the prior spec

**User Story:** As a maintainer, I want the superseded spec to point at this one, so that a reader
of the old document is not misled about what shipped.

#### Acceptance Criteria

1. THE Prior_Spec `tasks.md` SHALL carry one note at the top of the document stating that
   `aws-byo-deploy` supersedes it.
2. THE Prior_Spec SHALL retain every task checkbox in the state it held before this feature.
3. THE Prior_Spec SHALL receive no other content change.

### Requirement 15: End-to-end operator journey

**User Story:** As an operator, I want the full path from configuration to live streaming to work
end to end in my own AWS account, so that my company can adopt the studio without Phorma Cloud.

#### Acceptance Criteria

1. WHEN the operator completes the AWS_Config_Form, runs Plan, confirms and runs Deploy, THE Studio
   SHALL report a successful deploy and SHALL hold discovered `triggerApiUrl` and `monitorApiUrl`
   values.
2. WHEN the operator pushes a workflow spec to the deployed Trigger_API, THE Server_Entry SHALL
   persist the spec to Run_Table and THE Studio SHALL report the push as successful.
3. WHEN the operator triggers a deployed run, THE Server_Entry SHALL acquire the Execution_Lease,
   execute the graph through `@phorma/engine` and record RunEvents to Run_Table.
4. WHEN the operator opens the runs surface for a deployed workflow, THE Studio SHALL list the run
   records returned by `GET /workflows/{id}/runs` in descending start-time order.
5. WHILE a deployed run is in flight AND a monitor WebSocket is open, THE Studio SHALL apply each
   pushed RunEvent to the canvas within 2 seconds of the Host_Adapter pushing it.
6. WHERE two Runners contend for one workflow, THE Server_Entry holding the lower Fencing_Token
   SHALL write one unfenced skipped-run record, SHALL respond with status 409 and SHALL make no
   further Run_Table write for that run.
