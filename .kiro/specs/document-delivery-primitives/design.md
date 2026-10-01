# Design Document: Document Delivery Primitives

## Overview

Six brief items (G1-G6) and four discovered gaps become generic engine primitives. Each enters the
engine as data on a node, a field on `WorkflowSettings`, or a member of `RunOptions`; nothing host
specific lives in `engine/`. The template `tpl-weekly-job-applications` is the first consumer.

| Primitive | Where | Second use case |
|---|---|---|
| G1 Workflow variables | `WorkflowSettings.variables`, `engine/src/variables.ts`, `payload.ts`, `expr.ts` | A support-triage workflow whose escalation address and SLA hours are set once and read by a prompt, a guard and a Notify step |
| G2 Run artifacts | `RunOptions.artifacts`, `engine/src/artifacts.ts`, one store per host | A month-end report whose CSV export is uploaded to a file API and attached to an email |
| G3 `render-document` | `engine/src/markdown-blocks.ts`, `engine/src/pdf.ts` | Rendering an invoice or a monthly KPI report from an agent's markdown |
| G4 Email adapters + attachments | `engine/src/email-providers.ts`, `NotifyNodeData` | Emailing a weekly report PDF to a distribution list through Resend |
| G5 Multipart HTTP | `engine/src/multipart.ts`, `bodyMode: 'multipart'`, `DataRequest.bodyEncoding` | Uploading a generated PDF to a document store or e-signature API |
| G6 `state-list` | `engine.ts` executor over `WorkflowStateStore.list` | A daily digest listing every open ticket the workflow is tracking under `open:` |
| Agent `resultKey` | `AgentNodeData.resultKey` | A classification agent that adds `{category}` to a ticket record instead of replacing it |
| Router `expression` mode | `RouterNodeData.expression` | Routing an order to "refund", "replace" or "review" from a computed field |
| Expression functions | `expr.ts` | `parseJson` reads a webhook's stringified body; `containsAny` flags banned words; `distinctBy` dedupes CRM contacts by e-mail; `extractNumbers` checks a summary invents no figures; `htmlToText` cleans CMS content |
| Claim release | `state.ts` `releaseIdempotent`, `engine.ts` | A webhook post that got a 422 can be fixed and retried the same day |

### Existing equivalents checked

- Variables: none. `WorkflowSettings` holds only `timeoutMinutes`, notifications and retention.
- Artifacts: none. `DataRequest.body` and `DataResponse.body` are strings; the only binary paths are
  the hosted R2 backup and proposal stores, which are tenant-scoped, encrypted and not run-scoped.
- PDF: `buildSimplePdf` in `mcp/phorma-practice-mcp/src/ias-tools.ts` is one page and wraps nothing.
  Not imported (separate package), used as a reference only.
- Email: `notify` already posts `{to, subject, body}` JSON to a connection endpoint. Extended, not
  replaced (G4 is NOT a new node kind: the channel, connection, retry, error port and masking are
  all reused).
- Multipart: none. `bodyMode: 'form'` sends rendered text as-is.
- State list: `WorkflowStateStore.list` exists on all three stores with the 1000 clamp; there is no
  node over it.
- Readable text: `htmlToReadableText` in `web-fetch.ts` is reused by the `htmlToText` function.
- Idempotency: `claimIdempotent` and `claimHttpWrite` exist; reused for notify.

## G1 Workflow variables

```ts
type WorkflowVariableType = 'text' | 'markdown' | 'number' | 'boolean' | 'list';
interface WorkflowVariable { name: string; type: WorkflowVariableType; value: string | number | boolean | string[]; description?: string }
interface WorkflowSettings { ...; variables?: WorkflowVariable[] }
interface RunOptions { ...; variables?: Readonly<Record<string, Json>> }
```

`variables.ts` exports `resolveWorkflowVariables(settings)` (hosts call it), and
`validateWorkflowVariables(list)` plus `variableReferences(text)` (the validator calls them).

Interpolation: `interpolatePayload(template, payload, scope?)` gains an optional third argument.
A token whose path starts with `vars.` resolves against `scope.vars` only. Every engine call site
passes the frame's scope; `buildDataRequest` receives it through an options argument.

Expressions: `vars` becomes a reserved primary (like `$`) that evaluates to `EvalContext.vars`
(`{}` when absent). Sub-expressions inherit it because `callIterating` spreads the context.
Previously a bare `vars.x` meant `$.vars.x`; that shorthand is retired for this one word, for the
same precedence reason as templates.

Precedence rationale: the template's `dryRun` is the one switch between "draft only" and "send to
third parties". If a payload field could shadow it, any fetched record carrying `{"vars":
{"dryRun": false}}` could flip it. `vars.` therefore never reads the payload.

Credential refusal: a name matching `secret|password|passwd|token|api[_-]?key|private[_-]?key|
credential|bearer` or a value matching a known key shape (`sk-`, `re_`, `ghp_`, `xox[abp]-`,
`AKIA[0-9A-Z]{16}`, a PEM private key, a JWT) is an error naming Connections.

Validation findings come from `validateAgainstCapabilities`, whose target now optionally includes
`settings`; each sub-workflow scope is checked against its own variables.

## G2 Run artifacts

```ts
interface ArtifactRef { id: string; name: string; mimeType: string; sizeBytes: number }
interface StoredArtifact { ref: ArtifactRef; nodeId: string; createdAt: number; bytes: Uint8Array }
interface ArtifactStore {
  put(runId: string, artifact: StoredArtifact): Promise<void>;
  get(runId: string, id: string): Promise<StoredArtifact | undefined>;
  list(runId: string): Promise<ArtifactRef[]>;
}
```

- Id: `art-${fnv1a(runId|executionKey)}-${fnv1a(name)}`, so a re-executed producer overwrites.
- Caps: 1 MiB per artifact (fits one Durable Object SQLite row without R2), 16 MiB and 200
  artifacts per run. The engine lazily reads `list(runId)` once per run to seed its totals, so the
  cap holds after a Durable Object eviction.
- Event: `artifact-created { runId, nodeId, nodeName, artifact: ArtifactRef, at }`.
- Replay: the producer's journal entry holds the payload with the ref; the store row outlives the
  journal (the journal is deleted on settle, artifacts are deleted with run history).
- Hosts:
  - desktop and browser: IndexedDB store `run-artifacts` (DB v13), key `[runId, id]`, index
    `by-run`. `removeRun` and `pruneRuns` delete the run's artifacts in the same pass.
  - Cloudflare: table `run_artifacts(run_id, id, name, mime_type, size_bytes, node_id, created_at,
    bytes TEXT)`, the bytes base64-encoded. Deleted by `pruneRunHistory` for pruned runs and by `purgeSelf`. Download route
    `GET /runs/:runId/artifacts/:id` behind `authorized()`, returning JSON `{artifact, base64}` so
    the studio's existing JSON transport carries it.
  - AWS: a header item `artifact#{runId}#{id}` (reference, provenance, part count) plus part items
    `artifact#{runId}#{id}#part#{nnnn}` holding the bytes base64-encoded, 300,000 characters per
    part (DynamoDB items cap at 400 KB). Parts are written before the header, so an interrupted
    write reads as absent, and a shorter replacement deletes the stale tail. No item TTL: AWS run
    records carry none either, and an artifact must not expire before the record that references
    it. `artifact#` joins `PURGE_CATEGORIES`. Wired through `DataHosts.artifacts`, and
    `TriggerInput.variables` carries the resolved `vars` scope. AWS has no production run path yet
    (no `executeRun` caller), so AWS is covered by unit tests only, and that is stated.
- Studio: `RunArtifactsService` reads the local store or calls the `run-artifact` cloud operation
  (Cloudflare targets only; AWS has no artifact route and the download is hidden for it), and
  saves through a Blob anchor.

## G3 render-document

```ts
interface RenderDocumentNodeData {
  markdown: PayloadTemplate; fileName: PayloadTemplate; title?: PayloadTemplate;
  format?: 'pdf'; resultKey?: string;
  layout?: { pageSize?: 'a4' | 'letter'; marginMm?: number; fontSize?: number; accentColor?: string };
  errorPortId?: string;
}
```

`markdown-blocks.ts` parses a bounded markdown subset into blocks (heading 1-4, paragraph, bullet
and ordered list items with nesting depth, rule, code block) of inline runs (text, bold, italic,
code, link). The same AST renders escaped HTML for email (`markdownToHtml`).

`pdf.ts` lays the blocks out:

- Fonts: Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique, Courier, all
  `/Encoding /WinAnsiEncoding`. Width tables are the AFM widths for codes 32-255.
- Unicode to WinAnsi: Latin-1 maps directly; the 0x80-0x9F block maps the 27 typographic code
  points (smart quotes, en and em dash, ellipsis, bullet, euro, trademark, ...); NBSP becomes a
  space, U+2010-U+2012 and U+2212 a hyphen, anything else `?`.
- Layout: greedy word wrap on measured widths, a word longer than a line breaks by character,
  page break when the next line does not fit, headings never orphaned at a page bottom, list
  hanging indent with the bullet in the gutter. H1 large, H2 accent-coloured with a rule below,
  H3 bold, H4 small and muted (contact lines).
- Links: blue (accent) text plus a `/Link` annotation with a `/URI` action, only for http, https
  and mailto.
- Output: uncompressed content streams; every byte is ASCII because non-ASCII string bytes are
  written as octal escapes, so `string.length` equals the byte offset in the xref table. No
  timestamps: `/CreationDate` is omitted so output is deterministic.
- DOCX: deferred (stretch goal, not built).

## G4 Email adapters

```ts
interface OutboundEmail { to: string[]; cc: string[]; from?: string; replyTo?: string; subject?: string;
  body: string; bodyFormat?: 'markdown' | 'html' | 'text'; attachments: EmailAttachment[]; idempotencyKey?: string }
interface EmailProviderAdapter { id; label; requiresSender; supportsAttachments;
  endpoint(conn): string; build(email, conn): { headers; body: string } }
const EMAIL_PROVIDERS: Record<'generic-json' | 'resend', EmailProviderAdapter>
```

Adding SendGrid or Postmark is one entry; Cloudflare Email Service would be an adapter that
returns a `send_email` binding call instead of an HTTP request, which is why the interface returns
a request description rather than performing I/O. `smtp` stays unimplemented (the `smtp`
connection type remains declared but no adapter exists).

`generic-json` default body is byte-identical to today when no new field is set. Attachments in
`generic-json` are `[{fileName, mimeType, content}]` (base64).

## Idempotency and claim release

Notify: the key renders once per execution, is claimed before attempt 1, and rides as the
`Idempotency-Key` header on every attempt (Resend dedupes for 24 h on that header). On final
failure the engine releases the claim only for Provable_Non_Delivery. A 5xx or timeout may have
been delivered, so the claim is kept: the next run skips rather than risk a duplicate. The same
release applies to `http-request` claims.

## G5 Multipart

`multipart.ts` builds the body bytes; `DataRequest.body` carries base64 with
`bodyEncoding: 'base64'` and the `Content-Type` carries the boundary. The boundary is
`----phorma-` plus `fnv1a` of the part names and sizes, salted until it does not occur in any
part. Browser and Worker fetchers decode to `Uint8Array`; the Tauri `data_request` command decodes
with a local base64 decoder (the crate has none) and sends bytes with reqwest.

`http-tool` multipart is not built: the template uploads from a deterministic step, never from an
agent tool call, and an agent cannot address an artifact without new tool-argument plumbing.

## G6 state-list

```ts
interface StateListNodeData { prefix: PayloadTemplate; limit?: number; resultKey?: string }
```

Reserved namespaces are filtered after the store call, so a prefix of `''` still never leaks a
claim or a watermark.

## G7 readable page fetch: not built

Remotive (`description`), RemoteOK (`description`), Greenhouse (`content` with `?content=true`),
Lever (`descriptionPlain`, `lists`) and Ashby (`descriptionPlain`) all return the full text in the
list response, verified against the live endpoints on 2026-10-01. `htmlToText` cleans the HTML.
Adzuna is the exception: it returns a description SNIPPET only, so its postings are screened on
less text. That is accepted rather than fixed with G7, because Adzuna is optional and its
`redirect_url` lands on Adzuna's own page rather than the employer's.

## Agent resultKey, Router expression, expression functions

Straightforward; see Requirements 8-10. `parseReplyJson` strips one code fence and falls back to
the first balanced `{...}` so a model that adds a sentence still yields its JSON.

## Capability matrix

`features.artifacts`: true on all four hosts. New kinds `render-document` and `state-list` join
`ALL_NODE_KINDS`, every literal's `nodeKinds` and `DATA_NODE_KINDS` (neither is in
`DATA_IO_KINDS`: neither reaches the network). New `validateGraph` rules:

1. `render-document`, notify with attachments, and multipart http-request need
   `features.artifacts`.
2. `render-document` layout validation (page size, margin 5-50 mm, font size 7-16, `#rrggbb`).
3. Notify: unknown `emailProvider` on the connection, attachments on a non-email channel.
4. `state-list`: empty prefix or a reserved-namespace prefix; limit outside 1-1000.
5. Router expression mode: the expression compiles (via `expressionsOf`).
6. Variables: Requirement 1.7.

## Sources (template)

| Source | Endpoint | Terms | Apply API |
|---|---|---|---|
| Remotive | `GET https://remotive.com/api/remote-jobs?category=software-dev` | Public API; link back and name Remotive; at most 4 calls a day | none |
| RemoteOK | `GET https://remoteok.com/api` (element 0 is the legal notice) | Link back and name Remote OK | none |
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Public job board API | `POST .../jobs/{id}` needs the employer's Job Board API key |
| Lever | `GET https://api.lever.co/v0/postings/{slug}?mode=json` | Public postings API | apply POST needs the employer's API key |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{slug}` | Public posting API | `applicationForm.submit` needs the employer's API key |
| Adzuna (optional) | `GET https://api.adzuna.com/v1/api/jobs/au/search/1?app_id=&where=&what_or=&max_days_old=` | Free app id and key; personal use permitted; 250 calls a day; credit "Jobs by Adzuna" | none |

No default source has a candidate-usable apply API. The api branch is wired and runs only for a
`companyBoards` entry marked `|api` (`provider:slug|api`) while `vars.applyApiUrl` is set, which is
what the e2e exercises. LinkedIn, Indeed and anything behind a login are not used. SEEK is not
used: its developer platform serves hirers and ATS partners only, and its terms forbid scraping.

### Audience: Melbourne

The template targets someone living in Melbourne. The schedule is pinned to `Australia/Melbourne`
rather than the machine's zone. `vars.homeLocations` (`['melbourne']`) makes a role there eligible
whatever its work arrangement; `vars.remoteRegions` (Australian cities, `australia`, `au:`, `anz`,
`apac`, `asia pacific`, `oceania`, `worldwide`, `anywhere`, `global`) is what a REMOTE role must
name, so a remote role restricted to another country is dropped. Ranking is local first, then
remote roles naming an allowed region, then remote roles naming none, newest first within each.

Default boards were chosen from a live check on 2026-10-01 for Melbourne or ANZ-remote openings:
`ashby:xero`, `greenhouse:easygo`, `greenhouse:block`, `greenhouse:cultureamp`,
`lever:mable`, `ashby:sitemate`, `lever:deputy`, `greenhouse:buildkite`,
`greenhouse:octopusdeploy`, `ashby:dovetail`. Board openings change; an empty or 404 board is
reported in the summary's source section and the rest continue. `ashby:airwallex` was dropped
after a real run: its board is about 8.5 MB (549 roles with full descriptions), over the 4 MiB
response cap, and neither Ashby nor Greenhouse offers server-side filtering. Block's board is
about 3.4 MB, under the cap but over a Durable Object SQLite value, which is why the Worker's
journal skips persisting oversized entries (see the cloud-worker steering).

Each normaliser emits `{postings}` and all of them feed ONE `Keep eligible postings` transform,
so a source's loop result is its eligible postings only (about 90 KB on a live run, against the
several MB of fetched descriptions). The merge only dedupes, ranks and caps.

Source quirks the normalisers handle: Ashby sets `isRemote` on HYBRID roles too, so its
`workplaceType` decides when present; Lever's `categories.allLocations` and Ashby's
`secondaryLocations` carry every office a role is open in, so a Melbourne second office matches;
Adzuna's location gets `, Australia` appended because the endpoint is Australia-only. Title
keywords are substring-matched, so very short ones (`ai` matches `maintenance`) were dropped from
the defaults, and `vars.excludeTitleKeywords` skips manager and director titles by title only.

## Template graph

```
Schedule (Mon 08:00 Australia/Melbourne) --+
Manual -------------------------------------+--> Sources (transform) --> Each source (for-each, c=2)
   body: By provider (router expr) --> Remotive | RemoteOK | Greenhouse | Lever | Ashby | Adzuna (http-request)
                                   --> one normalise transform per provider --> Keep eligible postings (terminal)
   done: Merge, dedupe and rank (transform) --> Each posting (for-each, c=1)
   body: Applied? (state-get) --> Screened? (state-get) --> Ledger check (router)
           seen  --> Skipped (transform)
           new   --> Fit (agent, resultKey fit) --> Fit facts (transform) --> Fit gate (router)
                       screened --> Record screened (state-set screened:, 30 d) --> Screened (transform)
                       fit      --> Tailor (agent, resultKey tailored) --> Fidelity facts --> Fidelity check (assert, route)
                                     breach --> Revision brief --> Revise (agent) --> Fidelity facts 2 --> Fidelity re-check
                                                   breach --> Blocked (transform)
                                     pass   --> Render PDF (render-document) --> Send route (router expr)
                                                   dry run --> Dry-run outcome
                                                   api     --> Upload (multipart http-request, idem apply:key) --> Record application
                                                   email   --> Send email (notify, idem apply:key)            --> Record application
                                                   manual  --> Record manual (state-set, manual-pending)  --> Manual outcome
                                     Record application (state-set applied:, 30 d) --> Applied outcome
   done: Ledger (state-list applied:) --> Summary facts (transform) --> Summary (agent, resultKey summary)
         --> Email summary (notify, attachments documents, truncate)
```

Honesty rule (rule 4), all deterministic, in `Fidelity facts` plus `Fidelity check`:

- Every profile line starting with `#` (name, `####` contact line, `###` role, education and
  certification lines) appears verbatim in the tailored document, and no heading line appears that
  is not in the profile: employers, titles, dates, education, certifications and contact details are
  locked.
- Every number in the tailored document is a number in the profile; every number in the letter is
  in the profile or the posting.
- `addedSkills.length <= vars.maxAddedSkills`; each added skill appears in the Skills section and
  nowhere else; each names a `relatedTo` that is in the profile; every Skills entry not in the
  profile is declared in `addedSkills`.

Agents have no tools, so `toolResultCapChars` and `maxToolRounds` (which the Jira template raises)
do not apply; `maxTokens` is raised on the tailor and revise agents instead.

Ledger key: `posting.key` = `source:id` as specified, deduped within a run on that key and on
company plus title (the company with `.`, `,` and a trailing Pty Ltd / Ltd / Inc / LLC removed).
Known gap: the same role re-listed on a different source in a later week has a different key.
