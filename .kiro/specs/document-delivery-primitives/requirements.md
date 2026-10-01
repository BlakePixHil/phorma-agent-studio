# Requirements Document

## Introduction

A scheduled workflow that reads a person's own source documents, pulls records from public JSON
feeds, screens them, writes a tailored document per record, renders it to PDF, and delivers it by
email or HTTP upload with a durable 30-day ledger cannot be built in the studio today. Five things
are missing: named workflow-level values, binary content that is never pushed through a model or a
trace, a PDF renderer, email with attachments, and multipart upload. A sixth (listing a state
prefix) is needed to report on a ledger.

This feature adds those capabilities as GENERIC primitives and then ships one template that uses
them, `tpl-weekly-job-applications`. Only the template knows its domain. Every primitive names a
second, unrelated use case in the design, and Requirement 13 keeps the domain vocabulary out of
every non-template line this feature adds.

While designing the template, four smaller gaps surfaced that the original brief did not list.
They are generic and are specified here rather than worked around in the template:

- an agent cannot keep its incoming payload: its reply always REPLACES it (Requirement 8);
- the Router has no deterministic mode: keyword mode substring-matches the whole payload and decide
  mode needs System One (Requirement 9);
- the expression language cannot parse JSON text, test a string against a list, dedupe records by a
  derived key, extract figures from prose, or strip HTML (Requirement 10);
- the shared idempotency claim is never released, so a send that provably never reached the target
  stays blocked for the claim's whole TTL (Requirement 5.6).

G7 (readable page fetch) is NOT built: every default source returns the full description in its
JSON response, so the condition the brief set for it does not hold (design, "G7").

## Glossary

- **Engine**: `engine/`, the pure TypeScript run engine shared by every host.
- **Host**: Tauri desktop, browser preview, Cloudflare Worker (`cloud/`) or AWS (`cloud-aws/`).
- **Workflow_Variable**: a named, typed value in `WorkflowSettings.variables`.
- **Variable_Scope**: the resolved `name -> value` record a run frame reads as `vars`.
- **Artifact**: run-scoped binary content held by the host. Payloads carry only an Artifact_Ref.
- **Artifact_Ref**: `{ id, name, mimeType, sizeBytes }`.
- **Artifact_Store**: the host contract `RunOptions.artifacts`.
- **Email_Adapter**: one entry of `EMAIL_PROVIDERS`, selected by `Connection.config.emailProvider`.
- **Claim**: the `idem:` state entry written by `claimIdempotent`.
- **Provable_Non_Delivery**: a final failure that is a transport failure with `requestNeverSent`,
  or an HTTP status 400-499 other than 408, 409 and 425.

## Requirements

### Requirement 1: Workflow variables

**User Story:** As an operator, I want named values edited in one place, so that a prompt, a URL
and a guard read the same setting and I never edit a value in three nodes.

#### Acceptance Criteria

1. THE Studio and THE Engine SHALL declare `WorkflowSettings.variables?: WorkflowVariable[]` in both
   type twins, where `WorkflowVariable` is `{ name, type, value, description? }` and `type` is one
   of `text`, `markdown`, `number`, `boolean`, `list` (a list holds strings).
2. A variable name SHALL match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and be unique in its workflow.
3. WHEN a run starts, THE Host SHALL pass the top-level workflow's resolved Variable_Scope as
   `RunOptions.variables`; WHEN an `execute-workflow` node enters a child frame, THE Engine SHALL
   resolve that frame's scope from the child's own `EmbeddedWorkflow.settings.variables`.
4. `{{vars.<name>}}` in any payload template and agent prompt SHALL render the variable: a string
   raw, any other value as JSON. An unknown variable SHALL be left verbatim.
5. `vars.<name>` SHALL be readable in every expression, including inside `map`/`filter`
   sub-expressions.
6. PRECEDENCE: the `vars.` prefix SHALL ALWAYS resolve against the Variable_Scope and NEVER against
   the payload, so untrusted payload data cannot shadow a configured value. A payload field named
   `vars` stays reachable through `{{input}}` and `$.vars`.
7. THE Capability_Validator SHALL report an error for a variable with an invalid or duplicate name,
   a value that does not match its type, a value over 64 KiB, a scope over 256 KiB, a name or value
   that looks like a credential, and any `{{vars.x}}` or `vars.x` reference to an undefined name.
8. A credential-looking variable SHALL be refused with a message pointing to Connections.
9. THE Properties panel's no-selection state SHALL list, add, edit, retype and remove variables.

### Requirement 2: Run artifacts

**User Story:** As an automation author, I want a step to produce a file that later steps can
attach or upload, without the bytes ever entering a model prompt, a payload or the trace.

#### Acceptance Criteria

1. THE Engine SHALL declare `ArtifactStore { put, get, list }` keyed by `runId` and accept it as
   `RunOptions.artifacts`, and `HostCapabilities.features.artifacts` SHALL declare support.
2. A payload SHALL carry only `{ id, name, mimeType, sizeBytes }`; the bytes SHALL live in the store.
3. Artifact ids SHALL be derived from the run id and the producing node's execution key, so a
   re-executed node overwrites rather than duplicates.
4. THE Engine SHALL refuse an artifact over `ARTIFACT_MAX_BYTES` (1 MiB), and a write that would
   take the run over `RUN_ARTIFACTS_MAX_BYTES` (16 MiB) or `RUN_ARTIFACTS_MAX_COUNT` (200), with the
   run total read from the store so the cap survives a host restart.
5. Every write SHALL emit one `artifact-created` event carrying the Artifact_Ref only.
6. Artifacts SHALL survive the host's replay path: a journal-replayed producer is skipped and its
   recorded Artifact_Ref still resolves.
7. THE desktop and browser hosts SHALL persist artifacts in IndexedDB; THE Cloudflare host SHALL
   persist them in Durable Object SQLite; THE AWS host SHALL persist them in the run table.
8. Artifacts SHALL be purged with their run record: local delete and prune, Cloudflare history
   prune and `purgeSelf`, AWS workflow purge.
9. THE Runs panel trace SHALL list a run's artifacts with a download action, for local runs and for
   Cloudflare-deployed runs.
10. A node that needs artifacts on a host without `features.artifacts` SHALL be a validation error.

### Requirement 3: Render document

**User Story:** As an author, I want to turn markdown into a clean PDF, so that a report, invoice or
letter can be delivered as a file.

#### Acceptance Criteria

1. THE Engine SHALL add the `render-document` data node kind with ports In / Rendered / On error.
2. It SHALL render `markdown` (a payload template; `{{path}}` reads a payload path) to a PDF
   Artifact named from the rendered `fileName`, and merge the ref under `resultKey` (default
   `document`).
3. The PDF SHALL support headings 1-4, paragraphs, bullet and numbered lists, bold, italic, inline
   code, links (as URI annotations), horizontal rules, word wrap and multiple pages.
4. Text SHALL be real, selectable, single-column text in the standard Helvetica and Courier fonts
   with WinAnsi encoding; smart quotes, dashes, ellipsis and bullets SHALL map to their WinAnsi
   code points and an unmappable character SHALL render as `?`.
5. Page size (A4 / Letter), margins, base font size and accent colour SHALL be configurable and
   validated.
6. The writer SHALL be pure TypeScript with no dependency, and identical input SHALL produce
   byte-identical output on every host.
7. File names SHALL be sanitised (no path separators or control characters, `.pdf` enforced,
   at most 120 characters).

### Requirement 4: Email with attachments and provider adapters

**User Story:** As an author, I want the Notify step to send real email with a file attached through
my provider, so that I do not need a separate mail service.

#### Acceptance Criteria

1. `NotifyNodeData` SHALL gain `from`, `replyTo`, `cc`, `bodyFormat` (`markdown`, `html`, `text`),
   `attachments` (payload paths to Artifact_Refs or arrays of them), `attachmentLimit` (`fail`,
   `truncate`) and `idempotencyKey`, in both twins.
2. The Email_Adapter SHALL be chosen by `Connection.config.emailProvider`; absent means
   `generic-json`.
3. `generic-json` SHALL send exactly today's `{to, subject, body}` JSON when no new field is set,
   and add each new field only when it is set.
4. `resend` SHALL POST the Resend REST shape (`from`, `to[]`, `cc[]`, `reply_to`, `subject`, `html`,
   `text`, `attachments[{filename, content, content_type}]`) to `notifyUrl`, or `baseUrl` +
   `notifyPath` (default `https://api.resend.com` + `/emails`), and SHALL require a sender from
   the step or `Connection.config.defaultFrom`.
5. `markdown` bodies SHALL be converted to escaped HTML by the engine's own markdown renderer and
   also sent as text.
6. Attachments SHALL total at most `EMAIL_ATTACHMENTS_MAX_BYTES` (10 MiB raw); over the cap a
   `fail` step fails before sending and a `truncate` step drops trailing attachments and reports
   the count on `notify-sent`.
7. The adapter interface SHALL leave room for SendGrid, Postmark and Cloudflare Email Service, and
   `smtp` SHALL stay unimplemented.
8. An unknown `emailProvider`, or attachments on a non-email channel, SHALL be validation errors.

### Requirement 5: Idempotent sends

**User Story:** As an operator, I want retries, replays and re-runs never to deliver the same message
twice.

#### Acceptance Criteria

1. WHEN a notify step renders a non-empty `idempotencyKey`, THE Engine SHALL claim it with
   `claimIdempotent` before the first attempt and send it as the `Idempotency-Key` header.
2. A lost claim SHALL skip the send and follow no out-port, exactly like `http-request`.
3. Every retry attempt of one execution SHALL reuse the claim and the same header value.
4. A journal-replayed send SHALL not be re-sent.
5. Multipart `http-request` SHALL use the existing claim path unchanged.
6. WHEN a claimed `notify` or `http-request` execution finally fails with Provable_Non_Delivery,
   THE Engine SHALL release the claim so a later run can retry; any other final failure SHALL keep
   the claim for its TTL.

### Requirement 6: Multipart HTTP

**User Story:** As an author, I want to upload a generated file to an API that takes form uploads.

#### Acceptance Criteria

1. `HttpRequestNodeData.bodyMode` SHALL accept `multipart`, with `multipart.fields[]` (name, value
   template) and `multipart.files[]` (name, artifact payload path, optional file name template).
2. The body SHALL be RFC 7578 `multipart/form-data` with a boundary that is deterministic for the
   same parts and never occurs inside any part.
3. `DataRequest` SHALL gain `bodyEncoding?: 'utf8' | 'base64'`; every DataFetcher (browser, Tauri
   `data_request`, Cloudflare Worker) SHALL decode a `base64` body to bytes before sending.
4. Fixture fingerprints and the journal SHALL treat the base64 body as the body text.
5. `http-tool` multipart is NOT built: no agent in this feature needs it (design).

### Requirement 7: State list

**User Story:** As an author, I want to read every entry under a state prefix, so that a report can
show a ledger.

#### Acceptance Criteria

1. THE Engine SHALL add the `state-list` data node kind with ports In / Out.
2. It SHALL render `prefix`, call `WorkflowStateStore.list` with the workflow scope and `limit`
   (default 100, capped at `STATE_LIST_MAX_LIMIT`), and merge
   `[{key, value, updatedAt, expiresAt}]` under `resultKey` (default `entries`), with `key` unscoped,
   `value` parsed as JSON when it parses, and both dates ISO strings or `null`.
3. Entries in a reserved namespace (`idem:`, `delta:`, `wm:`, `oauth:`, `fx:`) SHALL never be
   returned, and a prefix that starts with one SHALL be a validation error.
4. The merged list SHALL be capped at 1 MiB of JSON, setting `<resultKey>Truncated: true` when cut.

### Requirement 8: Agent result merge

**User Story:** As an author, I want an agent's reply added to the payload rather than replacing it,
so that later steps still see the record the agent worked on.

#### Acceptance Criteria

1. `AgentNodeData.resultKey?: string` SHALL be declared in both twins.
2. WHEN set, THE Engine SHALL parse the reply as JSON (after stripping one surrounding code fence;
   falling back to the first balanced JSON object), merge it under `resultKey` into the payload
   with `mergePayloads`, and merge the raw text when it does not parse.
3. Absent, the reply SHALL replace the payload exactly as today.

### Requirement 9: Expression router

**User Story:** As an author, I want to branch on a computed value, deterministically.

#### Acceptance Criteria

1. `RouterNodeData.mode` SHALL accept `expression` with `RouterNodeData.expression`.
2. THE Engine SHALL evaluate the expression and follow the out-port whose name equals the result
   case-insensitively after trimming; with no match it SHALL follow `unsurePortId` when declared and
   otherwise fail the node naming the value.
3. The expression SHALL be compiled by the Capability_Validator, and expression mode SHALL never
   need System One.

### Requirement 10: Expression functions

#### Acceptance Criteria

1. `parseJson(text)` SHALL return the parsed value or `null` (input capped at 1 MiB).
2. `containsAny(text, list)` SHALL return true when `text` contains any non-empty string in `list`.
3. `distinctBy(list, 'keyExpr')` SHALL keep the first element per distinct evaluated key.
4. `extractNumbers(text)` SHALL return every digit run, with `.` or `,` separated groups, as
   strings, in order, at most 10000.
5. `htmlToText(text)` SHALL return readable text using `htmlToReadableText` from `web-fetch.ts`
   (input capped at 1 MiB).
6. All five SHALL be total: a wrong argument type yields `null`.

### Requirement 11: The template

#### Acceptance Criteria

1. THE Studio SHALL ship `tpl-weekly-job-applications` ("Weekly Job Applications (Melbourne and
   remote)", icon `ti ti-briefcase`) built only from the primitives above and existing ones.
2. It SHALL validate with zero findings against `CLOUDFLARE_CAPABILITIES` and contain no stdio or
   OAuth MCP node.
3. It SHALL have a Monday 08:00 Schedule trigger in `Australia/Melbourne` compiled to UTC and a
   Manual trigger.
4. It SHALL fetch Remotive, RemoteOK, every Greenhouse, Lever or Ashby board listed in
   `vars.companyBoards`, and Adzuna's Australian search only while `vars.adzunaAppId` is set, one
   `http-request` per provider. The default boards SHALL be companies with Melbourne or
   ANZ-remote roles, so a run with no configuration returns local postings.
5. It SHALL normalise, dedupe across sources, pre-filter deterministically and cap at
   `vars.maxApplicationsPerRun`. A posting is eligible when its location names one of
   `vars.homeLocations` (any work arrangement) or it is remote and names one of
   `vars.remoteRegions` or no region; local postings rank first.
6. Per posting it SHALL check the `applied:` and `screened:` ledgers, screen fit, tailor within the
   honesty rule, block any violation after one revision, render the PDF, route on the apply method
   (forced to a no-send branch when `vars.dryRun`), send idempotently, and record successes for 30
   days (`ttlSec: 2592000`).
7. It SHALL list the ledger and email a summary with this run's documents attached within the cap.
8. `vars.dryRun` SHALL default to `true`.
9. SEEK SHALL NOT be a source: it offers no public job-search API and its terms forbid scraping.

### Requirement 12: Verification

#### Acceptance Criteria

1. Every primitive SHALL have both type twins, capability-matrix entries, a `validateGraph` rule, an
   executor, a catalog entry or field UI, unit tests and property tests for universal claims.
2. `engine/test/job-applications-template.e2e.mts` SHALL prove the seven DoD scenarios, plus the
   Melbourne targeting and optional-Adzuna scenario, with mocks and fixtures only.

### Requirement 13: Genericity

#### Acceptance Criteria

1. The ADDED lines of every changed file other than the template entry, its tests and its fixtures
   SHALL contain none of the words job, resume, CV, cover letter, candidate, applicant, recruiter,
   ATS or hiring (case-insensitive, whole word, plural included). Whole files are not the measure:
   pre-existing engine code already uses "resume" for run resumption and "candidate" generically.
