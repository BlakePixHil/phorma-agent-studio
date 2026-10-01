# Implementation Plan: Document Delivery Primitives

## Tasks

- [x] 1. G1 Workflow variables
  - [x] 1.1 Twins: `WorkflowVariable`, `WorkflowSettings.variables` in `engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts`; `RunOptions.variables`
  - [x] 1.2 `engine/src/variables.ts`: resolve, validate (names, types, sizes, credentials), reference scanning
  - [x] 1.3 `interpolatePayload` scope argument and every engine call site; `buildDataRequest` options
  - [x] 1.4 `vars` reserved primary and `EvalContext.vars` in `expr.ts`; child frames resolve their own scope
  - [x] 1.5 Capability findings for variables and undefined references
  - [x] 1.6 Hosts pass `variables`: run controller, WorkflowAgent, AWS runner trigger
  - [x] 1.7 Workflow variables editor in the Properties no-selection state
  - [x] 1.8 Unit and property tests (precedence, totality, validation)
  - _Requirements: 1_

- [x] 2. Agent resultKey, Router expression mode, expression functions
  - [x] 2.1 `AgentNodeData.resultKey` twins, `parseReplyJson`, merge in the agent path, prompt panel field
  - [x] 2.2 `RouterNodeData.mode: 'expression'` twins, executor, validator, properties UI
  - [x] 2.3 `parseJson`, `containsAny`, `distinctBy`, `extractNumbers`, `htmlToText` plus generator lists
  - [x] 2.4 Unit and property tests
  - _Requirements: 8, 9, 10_

- [x] 3. G2 Run artifacts
  - [x] 3.1 `ArtifactRef`, `StoredArtifact`, `ArtifactStore` in `data-host.ts`; `features.artifacts` on all four literals and `FEATURE_FLAGS`
  - [x] 3.2 `engine/src/artifacts.ts`: ids, caps, ref guards, base64, `collectArtifactRefs`; engine writer with lazy run totals
  - [x] 3.3 `artifact-created` event, generators, `cloud.service.spec.ts` frames and counts, `describeRunEvent`
  - [x] 3.4 Studio IndexedDB store (v13), purge with `removeRun` and `pruneRuns`, run controller wiring
  - [x] 3.5 Cloudflare `run_artifacts` table, prune and purge, download route, `run-artifact` cloud operation
  - [x] 3.6 AWS run-table artifact store with chunking (no item TTL, see design), purge category, `DataHosts.artifacts`, `TriggerInput.variables`
  - [x] 3.7 Runs panel artifact list and download
  - [x] 3.8 Tests: caps, ids, store contract (memory store), host stores
  - _Requirements: 2_

- [x] 4. G3 render-document
  - [x] 4.1 `engine/src/markdown-blocks.ts` parser and `markdownToHtml`
  - [x] 4.2 `engine/src/pdf.ts` fonts, WinAnsi mapping, layout, links, writer
  - [x] 4.3 Node kind twins, executor, validator rules, catalog entry, properties UI
  - [x] 4.4 Unit and property tests (valid structure, xref offsets, determinism, wrap bound, encoding totality)
  - _Requirements: 3_

- [x] 5. G4 Email and idempotent sends
  - [x] 5.1 Notify field twins; `engine/src/email-providers.ts` with `generic-json` and `resend`
  - [x] 5.2 Notify executor: attachments, caps, adapters, claim, header, release
  - [x] 5.3 Claim release for `http-request` (`releaseIdempotent`)
  - [x] 5.4 Validator rules; properties UI for the new fields
  - [x] 5.5 Tests: byte-identical generic default, Resend shape, caps, claim lifecycle
  - _Requirements: 4, 5_

- [x] 6. G5 Multipart HTTP
  - [x] 6.1 `engine/src/multipart.ts`; `bodyMode: 'multipart'` twins; `DataRequest.bodyEncoding`
  - [x] 6.2 Fetchers: browser, Cloudflare Worker, Tauri `data_request` (Rust base64 decode)
  - [x] 6.3 Properties UI; validator rule
  - [x] 6.4 Tests: RFC 7578 shape, boundary property, host decode
  - _Requirements: 6_

- [x] 7. G6 state-list
  - [x] 7.1 Twins, executor, reserved filtering, output cap, validator, catalog, properties UI
  - [x] 7.2 Tests
  - _Requirements: 7_

- [x] 8. Template
  - [x] 8.1 `tpl-weekly-job-applications` in `workflow-templates.ts` with sample profile and template
  - [x] 8.2 Source fixtures under `engine/test/fixtures/`
  - [x] 8.3 `workflow-templates.spec.ts` assertions
  - [x] 8.4 `engine/test/job-applications-template.e2e.mts` (seven scenarios plus Melbourne targeting and optional Adzuna)
  - _Requirements: 11, 12_

- [x] 9. Verification and docs
  - [x] 9.1 All gates green; genericity grep on added lines clean (only the template id, in a spec that uses the template as its fixture)
  - [x] 9.2 Browser preview smoke: open, dry run against fixtures, download a PDF
  - [x] 9.3 Steering updates (engine, cloud-worker, frontend-ui, structure, tech) and agent-memory bullets
  - _Requirements: 12, 13_
