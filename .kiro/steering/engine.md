---
inclusion: fileMatch
fileMatchPattern: ["engine/**/*.ts", "engine/**/*.mts", "engine/*.json", "frontend/src/app/core/workflow.model.ts"]
---

# Run engine detail

`engine/` is the one implementation that executes workflows locally AND inside the Cloudflare
Durable Object. Behavioural drift between the two hosts is the failure mode this design exists to
prevent, so host-specific behaviour belongs in the injected transports, never in the engine.

## Hard constraints

- Zero Angular, Tauri, DOM, or Node-only APIs. Consumed via the `@phorma/engine` tsconfig path
  alias, so it is compiled as app source in the frontend and bundled by esbuild in cloud - there is
  no build step and no dist.
- `engine/src/types.ts` is a structural twin of `frontend/src/app/core/workflow.model.ts`. Node
  kinds, node data interfaces, `WorkflowSettings`, and `ModelProviderId` change in both or neither.
- Everything the host provides arrives through `RunOptions`: `ModelClient`, `ToolHost`,
  `connections`, `dataFetch`, `sql`, `state`, `fixtures`, `redact`, `capabilities`, `journal`,
  `requestApproval`, `waitForEvent`, `defaultModel`, `maxToolRounds`, `maxExecutions`,
  `decisions` (System One `DecisionClient`), `decisionModel`, `artifacts` (`ArtifactStore`, run
  files), `variables` (the top-level workflow's resolved `vars` scope).
- Workflow variables (`variables.ts`): `WorkflowSettings.variables` is resolved once per frame by
  `resolveWorkflowVariables`; a child frame resolves its own sub-workflow's settings. `vars.x` in an
  expression and `{{vars.x}}` in a template read the VARIABLES, never the payload, so no record can
  shadow a flag like `dryRun`. Variables are configuration, not credentials: a credential-shaped name
  or value is refused, and the author is pointed at Connections. The capability validator needs the
  spec's `settings` to see them - validating `{ graph }` alone reports every reference as undefined.
- Document delivery: a step writes a file through `RunOptions.artifacts` and the payload carries only
  an `ArtifactRef` (`{id, name, mimeType, sizeBytes}`); bytes never travel through a payload, prompt
  or trace event. Caps 1 MiB per artifact, 16 MiB and 200 per run; the id is derived from the run and
  the execution key, so a replayed producer overwrites rather than adds. `render-document` (PDF),
  notify email attachments, multipart `http-request` bodies and `state-list` consume it. A host
  stores artifacts with the run record and deletes them with it.
- Idempotent writes (`notify.idempotencyKey`, `http-request.idempotencyKey`) go through
  `claimWrite`; a claim is RELEASED (`releaseIdempotent`) only on provable non-delivery - a
  transport error with `requestNeverSent`, or a 4xx other than 408/409/425 - so a refused send can
  be retried next run while an ambiguous one is never sent twice.
- System One: every call goes through `Engine.evaluateDecision` (validation, purpose-scoped
  fixtures, the shared retry loop, one `node-usage` with provider `typesafe`). Emit exactly one
  `decision` event per logical decision via `emitDecision`. Question builders and answer readers
  are pure and live in `decisions.ts` (graph consumers) and `decision-batteries.ts` (verify,
  preselect, judge, guardrails). Only the Router degrades without a client (keyword fallback,
  `fallback: 'no-transport'`); every other consumer throws `missingCapability`. Preselection
  degrades to the full tool list on a System One error, never on a missing client.

## Execution contracts

- `RunEvent`s (`events.ts`) are the only output contract. Both hosts feed the same stream.
- Tool calling is native: schemas come from tool-link edges through `ToolHost`. Tool loop caps at 8
  rounds; results are capped at 8KB.
- Retry, fallback, timeout, and compression all happen INSIDE one `executeNode` call
  (`runAgent`'s `streamRoundRobustly`) so the journal key minted per `executeNode` stays stable and
  internal retries are replay-safe. Never lift retries above `executeNode`.
- Journal replay (`RunOptions.journal`): keys are `nodeId|fnv1a(payload)|occurrence`. A replayed
  node emits `node-completed` and follows handoffs but skips the body entirely - no model calls, no
  tool side effects, no duplicate approval or wait prompts. Recording happens BEFORE
  `followHandoffs` so a downstream crash never loses completed work.
- Sub-workflows use the FLAT, cycle-safe `WorkflowSpec.subWorkflows` registry, not recursive
  inlining. Nested execution is ONE run: child frames share gate, timeout, callbacks, journal, and
  the global execution budget. A child journal namespace MUST derive from the Execute Workflow
  wrapper's deterministic journal key - a separate child counter is bypassed on replay and can
  repeat side effects.
- Approval identity is `requestId` (frame/journal identity plus node occurrence). `nodeId` is
  display metadata only; maps keyed by `nodeId` collide across repeated or parallel child frames.
- `for-each` owns its iteration (sequential by default, opt-in concurrency 1-8). Port convention is
  positional: out[0] is the loop body, out[1] is Done. Do not fan out edges - aggregators key
  collected inputs by port id and would collide.
- Stop on a run suspended in `requestApproval` or `waitForEvent` does nothing by itself; the host
  must resolve the pending resolver so execution re-enters the gate and throws `RunStoppedError`.
- Execution budget `maxExecutions` defaults to 100; hosts pass 2000 when the graph contains a
  `for-each` node.
- Payload plumbing lives in `payload.ts`: `interpolatePayload` (`{{a.b.c}}` dotted paths,
  `{{input}}` for the whole payload, unknown tokens left verbatim), `extractItems`, `mergePayloads`.
  `renderPrompt` goes through it, so every agent prompt supports dotted paths.

## Deterministic data path modules

Pure, framework-free, individually unit and property tested. Reuse them rather than reimplementing:

| Module | Responsibility |
|---|---|
| `expr.ts` | Expression lexer, parser, `compileExpression`, `evaluate`, `EXPR_FUNCTIONS`, `validateExpression`, `printExpression`. Total and pure: unsupported types yield `null`, never `NaN`/`Infinity` or a throw at runtime. Bounds: 1-4096 source chars, depth 64, 100000 steps. |
| `retry.ts` | `RETRYABLE_STATUSES`, `parseRetryAfter`, `backoffFor` (full jitter, injected randomness), `normalisePolicy` (attempts clamped 1-5), `decideRetry`. A non-idempotent step retries only for a `DataTransportError` with `requestNeverSent`. |
| `redact.ts` | `createRedactor`: literals first (min secret length 8), then depth-32 structural path/key rules, then pattern rules on non-JSON text. Patterns capped at 256 chars with a 100ms match budget. |
| `state.ts` | `scopedStateKey`, `canonicalJson`, `fnv1a`, `compareWatermark`, `deltaFilter`, `claimIdempotent`. Store contract: TTL expiry, 1000-entry `list` clamp, 32KB value cap, atomic `compareAndSet`. |
| `pricing.ts` | `ModelPriceTable` keyed by OpenRouter slugs, `toPricingSlug` normalisation, `estimateCostUsd`, `withEstimatedCost` (reported cost always wins), `priceTableFromOpenRouter`. |
| `decisions.ts`, `decision-batteries.ts` | System One request validation and parsing, `FetchDecisionClient`, answer projection (`compactDecisionAnswers`), edge labels, `describeDecisionOutcome`, and the verify / preselect / judge / guardrail batteries with their verdict readers. |
| `data-http.ts`, `data-nodes.ts`, `sql-statement.ts`, `connections.ts`, `data-host.ts`, `fixtures.ts`, `capabilities.ts` | HTTP/pagination, transform/aggregate/batch, SQL statement safety, connection identity and secret naming, host capability contracts, fixture record/replay. |
| `variables.ts`, `artifacts.ts`, `delivery-limits.ts` | Workflow variable validation and resolution; artifact ids, name sanitising, caps and base64; delivery size limits. Static, in the barrel. |
| `markdown-blocks.ts`, `pdf.ts`, `email-providers.ts`, `multipart.ts`, `delivery-steps.ts` | Markdown to blocks, a dependency-free PDF writer (WinAnsi, Helvetica and Courier), provider-shaped email requests (`generic-json`, `resend`), RFC 7578 bodies, and the step builders. LAZY: loaded by dynamic `import()`, never re-exported from `index.ts`. |

Design intent and requirement numbering for all of the above live in
`.kiro/specs/deterministic-data-path/`.

## Testing

- `npm test` in `engine/` runs `vitest --run` over `src/**/*.spec.ts`. Property tests use
  `fast-check` with shared arbitraries in `src/test/generators.ts`; in-memory hosts such as
  `src/test/memory-state-store.ts` back the store contracts.
- A property test asserts a named claim from the spec. Keep the claim reference in the test name so
  the link back to `.kiro/specs/deterministic-data-path/` survives. A property that restates the
  implementation's own guard, or compares a function to itself, is not a test - shape-only claims
  (deduped, ordered, capped, lower-cased) all hold for an empty result, so pair every one with a
  case that pins CONTENTS.
- Never mirror a production constant table into a spec as an "oracle". A copy shares the bug you are
  hunting: an `egress.spec.ts` copy of `PROVIDER_HOSTS` passed with a hostile hostname in both.
- `npm run test:e2e` runs all 13 scenario scripts (`test/run-all.mjs`). Do not add a scenario script
  without it being picked up there - `vitest.config.ts` excludes `test/**`, so `npm test` will not
  run it and a crash before the first assertion looks like silence.
- Scenario tests are `test/*.e2e.mts`, run individually with `npx -y tsx engine/test/<name>.e2e.mts`
  (cross-package ones need `TSX_TSCONFIG_PATH=frontend/tsconfig.json`): build a
  graph with tiny node/edge helpers, drive `startRun` with a fake `ModelClient` and stub
  `waitForEvent` / `requestApproval`, assert on the collected `RunEvent` list. Orders of magnitude
  faster than a browser - prefer it for any engine-only behaviour.
- `tsx` hazard: awaiting a run whose `waitForEvent` never resolves hangs the process on an
  unsettled top-level await. To simulate DO eviction, abandon the run and synchronize on a
  side-channel promise instead.
- Never freeze `Date.now` in a scenario script: `RunGate.sleep` waits on a `Date.now()` deadline
  during retry backoff, so a frozen clock hangs the first retried request forever. Let the patched
  clock tick (`clock + (realNow() - wallStart)`) and jump it with `clock +=`.
- Type-check with `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`.
