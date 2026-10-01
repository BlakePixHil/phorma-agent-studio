---
inclusion: fileMatch
fileMatchPattern: ["cloud/**/*.ts", "cloud/**/*.mjs", "cloud/wrangler.jsonc", "cloud/package.json", "frontend/src/app/core/cloud.service.ts", "frontend/src/app/core/phorma-cloud.service.ts"]
---

# Cloud runtime detail

`cloud/` is a Cloudflare Worker on the `agents` SDK. A `WorkflowAgent` Durable Object hosts the same
`@phorma/engine` as the studio and exposes WebSocket monitoring plus HTTP and cron triggers. Two
deployment shapes share the code: **hosted** (Phorma Cloud, billed to plan credits) and **BYO** (the
user's own Cloudflare account and keys).

## Rules

- System One (`docs/system-one.md`): the DO's `decisionClient()` uses `TYPESAFE_PLATFORM_KEY` hosted
  and `TYPESAFE_API_KEY` BYO; absent key = no client. `POST /api/decide` is the metered proxy for
  local runs (operator capability, 501 without the platform key, validated with the engine's own
  `validateDecisionRequest` before any upstream spend, status and `Retry-After` passed through,
  ledgered as `decide:<model>` with `countsAsRun: false`). Portal guardrails live in the DO
  (`startPortalTurn`, `answerPortalQuestion`, `fanOutToPortal`) and FAIL CLOSED: no key or any
  System One error refuses the turn. With output screening on, `node-token` is withheld and the
  `done` frame is delivered only after `screenPortalAnswer`; `portalScreening` keeps the turn busy
  and the SSE stream open until then.
- `cloud/` must depend on the `ai` package - the `agents` SDK imports it dynamically and wrangler
  bundling fails with "Could not resolve ai" otherwise.
- Verify with `npm run check` (`tsc --noEmit` plus `wrangler deploy --dry-run`) AND `npm test`.
  `check` runs no tests, so it alone is not verification. No Cloudflare account needed.
  `npm test` = `test:unit`, 41 suites: capabilities, projection, embed, deploy-config, connections, data-host,
  workflow-state, portal-cleanup, deployment-registry, notifications, run-wiring, status, releases, telemetry,
  tenant-billing, entitlement, stripe, auth-device, billing-routes, billing-admin, stripe-webhook, provisioning,
  workspace-migration, backup-store, backup-body, backup-routes, owner-identity, role-gate,
  organisation-isolation, ownership-claim, organisation-metering, organisation-billing, member-run,
  proposals, org-admin, impersonation, owner-switching, plus four
  Miniflare suites (deploy-validation, connection-secrets, telemetry-ingest, telemetry-admin).
  `backup-store`, `backup-body` and `backup-routes` are D1/R2-proxy-backed like the billing family
  and sit near the END of the chain behind a `node test/await-port-drain.mjs` barrier;
  `owner-identity`, `role-gate`, `organisation-isolation`, `ownership-claim`,
  `organisation-metering`, `organisation-billing`, `member-run`, `proposals`, `org-admin`,
  `impersonation` and `owner-switching` sit LAST, in that order, each behind a barrier of its own.
  `owner-switching` is the owner-switch half of `/api/me` plus `X-Phorma-Owner` end to end, and its
  two unrepeatable assertions are both about a SHAPE no function call can show: that `owners` is
  identical on BOTH `/api/me` branches - the `provisioned: false` one is the common case for a member
  who never subscribed personally, so a switcher fed only by the provisioned branch would be empty
  for exactly the people who need it - and that one desktop token answers about two different owners
  depending on the header, while a foreign organisation, an unparseable value and no header at all
  produce three BYTE-IDENTICAL bodies. It compares whole bodies rather than statuses for that reason.
  Its KV is an in-memory double so the absence of a cached membership LIST is observable: that list is
  deliberately uncached, because a grant taking 60 seconds to appear in a switcher gets blamed on the
  Super_Admin surface that just made it.
  `impersonation` is the act-as header end to end over the real deploy bundle, and it stands two
  harnesses in at once on purpose: the namespace WATCHER, because "the gateway refused before waking
  anything" has to be an observation rather than a source read, and a gateway-free HTTP probe that
  reaches an instance BY NAME, because the instance's own refusal is only visible with the gateway
  out of the path. Its three unrepeatable assertions are the ones the feature's silence makes
  invisible everywhere else: that an operator who ALSO holds a real `org:admin` membership writes
  through the membership and is refused through the header (one credential, one allowlist entry, two
  answers - without that pair every refusal is equally explained by "this operator is in nothing");
  that an ignored header produces a byte-identical response to the same request without it, for a
  non-operator, an unparseable value AND the same operator's `phd_` desktop token, with the audit
  count unchanged; and that DROPPING `impersonation_audit` refuses the read with
  `impersonation_unaudited` and serves no part of the resource. It also carries a narrow
  `uncaughtException` swallow for `ECONNRESET`: answering an `Upgrade: websocket` dispatchFetch with
  anything but a 101 - which the outright refusal does - leaves Miniflare's loopback socket reset and
  Node raises on the raw handle AFTER every check has passed. Reproduced against a five-line worker
  with no Phorma code in the path.
  `org-admin` is the operator organisation and member management family end to end over real D1,
  and its four unrepeatable assertions are all about a DIFFERENCE no single surface shows:
  that the three `refuseNonOperator` rules hold on the NEW prefix (an allowlisted DESKTOP token is
  403 there too); that creating an organisation makes NOT ONE OpenRouter call, which is the only
  proof that `provisionTenantTier`'s `active`-only key gate is structural rather than documentary;
  that a demotion and a REMOVAL each bite on the NEXT request, driven through a resolution BEFORE the
  write so the KV cache is warm and a module invalidating nothing would fail; and that a half-applied
  write is a reported 502 with its own code rather than a log line. Its KV is a recording DOUBLE
  rather than Miniflare's, because those two assertions are about what was DELETED and when, and its
  `fetch` stub records every Clerk and OpenRouter call WITH ITS BODY - `role` is the field that makes
  a demotion out of `admin` real, since a mapped `org:admin` claim short-circuits the authoritative
  table. Mutation-verified 2026-09-22: deleting either `invalidateMemberCache` call fails four
  assertions each.
  `proposals` is the proposal queue end to end over real D1 AND a real R2 bucket, and it stands two
  bindings in on purpose: `PortalIndex` answers `getDeployment` (so a registry read FAILURE is
  drivable, which must refuse rather than freeze a false live hash) and `WorkflowAgent` is a Proxy
  that RECORDS every property read and throws - that recorder IS the assertion that creating a
  proposal has no path to a deployment, which a source grep could not make. The PUBLISH sections swap
  that trap for a stub namespace whose `acceptSpecPush` records the call and writes the registry
  record a real accepted push would; emulating `syncDeployment` there is required rather than tidy,
  or every second publish of one workflow reads as stale. Its other unrepeatable
  assertion is that all four BACKUP destroy paths (revision prune, tombstone purge, retention sweep,
  delete-all) run over the same bucket and leave every `proposal/` object in place.
  `member-run` is the member half of the run path: a caller whose only level is `operator` (read from
  an `org_members` row, because its `org:member` claim is deliberately UNMAPPED and so cannot
  short-circuit) triggers the organisation's deployment, finds its suspended gate through
  `GET /api/notifications`, settles it through `POST /approvals`, and the persisted run record then
  names THAT member. It is the only suite that can see the WIRING of Requirement 10.5 - the pure
  decision is driven in `run-wiring`, and deleting one `rememberGateActor` call or the emit tee's
  `attributeGateActor` passes every pure check and fails exactly two assertions here. Its spec wires
  a manual trigger into an approval gate so nothing needs a model, but the tenant row still carries
  an encrypted runtime key: `resolveHostedInference` gates EVERY hosted trigger, and without one the
  run refuses `no_runtime_key` and nothing after it is reachable. A connector id is a port id plus
  the `-out` / `-in` suffix `portBaseId` strips, so a port whose own id ends in `-out` never resolves
  and the run ends after the trigger with no gate at all - which is a silent pass for anything that
  only asserts the run settled.
  `organisation-billing` is Property 39: it drives `/api/provision`, the signed Stripe webhook and
  `/api/checkout` over a personal owner and an organisation owner together and asserts that no
  billing fact of one is observable as the other's. Its four unrepeatable assertions are that a
  provisioned organisation reaches `active` with NOT ONE Stripe call, that a `credit_grants` row with
  no `stripe_payment_id` is refused by the schema, that a `billing_managed` refusal leaves both
  owners' rows byte-identical, and that `ownership-claim.ts`'s transfer statements name
  `workflow_backups` and `usage` and nothing else. A stub that silences `console.log` would swallow
  every PASS line, so it captures `warn`/`error` only, and its OpenRouter mint answers a DISTINCT
  hash per call - one canned hash makes "the two owners hold two runtime keys" vacuously true.
  `organisation-metering` drives `/api/infer` through the real router with member credentials, which
  is the only way to see whose meter a route moved - it started life as a section of `entitlement`
  and failed the CHAIN at iteration 20 on `connect EADDRINUSE` while passing in isolation, which is
  what a barrier and a suite of its own are for.
  `tenant-billing`, `entitlement`, `billing-routes`, `billing-admin`, `stripe-webhook`,
  `provisioning`, `owner-identity` and
  `workspace-migration` are also Miniflare-backed but take the D1
  binding straight out of the instance with `getD1Database` and never call `dispatchFetch`: a real
  local D1 with the real migrations applied,
  reached from Node, is the cheapest way to test SQL that ships - and `billing-routes` extends it to
  whole `/api/*` routes by importing `handleApiRequest` directly. Avoiding `dispatchFetch` does NOT
  exempt them from the loopback note below - see it for the measured socket cost of the proxy. `stripe-webhook` is the same shape
  and is by far the slowest suite in the chain (~60s), because its replay-convergence property
  delivers two full event scenarios per iteration over real D1. Do NOT buy that back by lowering
  `CONVERGENCE_RUNS` - the ordering defect that property exists to catch was missed at 60 runs.
  Two things that pattern needs: `cloudflare:workers`
  redirected to `test/stubs/cloudflare-workers.mjs` through `registerHooks` before the graph loads
  (so `api.ts` arrives via a dynamic `await import`), and, for an authenticated route, a locally
  minted RS256 JWT verified against a `CLERK_JWT_KEY` PEM - `@clerk/backend`'s offline path runs in
  Node with no JWKS fetch, so authorization never has to be stubbed.
  `npm run test:portal` is separate and MANUAL - it needs `npx wrangler dev` on 8799 plus a local
  Ollama model, which is also what gives you a full local Durable Object for E2E.
- A Miniflare `dispatchFetch` costs one loopback socket per request, and `getD1Database` costs one
  PER STATEMENT (measured: 300 proxied statements leave 306 sockets in TIME_WAIT; a keep-alive
  global undici dispatcher does not help, the proxy pools internally). Windows parks each closed
  socket in TIME_WAIT for two minutes against a 16,384-port range, and the chain now spends ~12,800
  of them in the billing suites alone, so a property fails mid-run on `connect EADDRINUSE` - usually
  in a LATER, innocent suite. Three rules, and none of them is "lower the iteration count": pass every
  new worker through `withLoopbackRetry` and every `getD1Database` handle through
  `withLoopbackRetryD1` (`cloud/test/miniflare-loopback.mjs`); keep the D1-proxy-heavy billing suites
  LAST in `test:unit` so the fetch property suites start against a clean port range; and put
  `node test/await-port-drain.mjs` in front of a suite that needs thousands of sockets to itself
  (there are now two such barriers, before `billing-admin` and before `stripe-webhook`). A fourth
  rule for any NEW D1-backed suite: batch per-iteration setup with `DB.batch([...])` rather than a
  loop of `run()` calls, since each statement is a socket - `withLoopbackRetryD1` wraps `batch` and
  unwraps each statement's `__inner`, so batching keeps the retry protection.
  Both wrappers retry connect-time port exhaustion only; every other error propagates on the first
  attempt. The wrappers survive a transient shortage, NOT an empty range - their ladder tops out at
  ~22s against a 120s TIME_WAIT - which is why the barrier exists: `stripe-webhook` spends ~7,050
  sockets, passes alone, and failed at iteration 60 of 120 when it inherited only ~2,500 free ports
  from `tenant-billing` + `entitlement` + `billing-routes`. The barrier waits for 10,000 free
  (capped at 180s, then proceeds) and is a NO-OP off Windows, so it costs CI nothing: `ubuntu-22.04`
  has 28,232 ports on a 60s recycle and has never exhausted them, which is also why this class of
  failure only ever reproduces locally.
- Wrangler/esbuild honours tsconfig `paths`, so `@phorma/engine` resolves exactly as in the frontend.
- Durable Object state uses the Agents SDK `this.sql` tagged template (embedded SQLite):
  `run_journal`, `usage_ledger`, workflow state, portal registry, and `run_artifacts`.
- Run artifacts (`cloud/src/run-artifacts.ts`, `DurableArtifactStore`) are files a run produced
  (PDFs from Render Document, for example), stored as base64 TEXT in `run_artifacts` beside `runs`.
  No R2: the engine caps an artifact at 1 MiB, inside the 2 MB row limit, so a BYO worker that binds
  nothing still runs every delivery step. `pruneRunHistory()` deletes a pruned run's artifacts and
  `purgeSelf()` clears the table. `GET /runs/{runId}/artifacts/{id}` answers `{artifact, base64}`
  as JSON, open to every level like the run record that references it.
- Durable Object SQLite refuses a string over 2 MB (`SQLITE_TOOBIG`; measured in workerd: 3.4 MB
  refused). The run journal goes through `persistableJournalRow` (`run-wiring.ts`,
  `JOURNAL_ROW_MAX_BYTES` 1,900,000): an entry over it stays in the in-memory journal only and any
  older row for the key is deleted, so one large API response does not fail a deployed run and, after
  an eviction, only that node re-executes. Any NEW table that stores a payload needs the same guard.
- `onStart()` fires on every DO wake and re-triggers an interrupted run via
  `trigger(input, resumeRunId)`. A resumed hosted run must pass `countsAsRun: false` to `recordRun`
  so it adds ledger cost without incrementing the monthly run count.
- Waits and approvals are IN-MEMORY. DO eviction kills a suspended run; the journal covers completed
  work only. The `earlyEvents` map buffers webhook races where an event arrives before the waiter
  registers.
- Suspension endpoints on the DO: `POST /events {correlationKey, payload}`,
  `POST /approvals {nodeId, approved}`, plus WS `event` and `stop` frames.
- Every suspended gate carries a `meta` (`PendingGateMeta`) alongside its resolver, filled from the
  arguments the engine passes `requestApproval` / `requestInput` / `waitForEvent`. Without it a
  pending gate is describable only to a live monitor, which is why `GET /status` could report
  correlation KEYS and nothing else. `drainPendingGates()` is the ONE place all three maps are
  settled and cleared - the `stop` frame and the settle `finally` both call it.
- `WorkflowAgent.notificationsSince(ownerId, cursor)` is the RPC behind
  `GET /api/notifications`: settled runs from the instance's own `runs` table filtered on `endedAt`
  (never `started_at`), its live pending gates, and `settingsIssues`. RPC and not an HTTP route,
  because a worker-to-DO `stub.fetch()` carries no bearer for `authorized()` to check - same reason
  `purgeSelf` and `startPortalTurn` are RPC. It re-checks `ownerId` against the stamp and THROWS on a
  mismatch (the aggregator records that workflow in `unreachable` and discloses nothing), and returns
  empty for a portal session instance. The throw is deliberate and is Property 4's positive control
  for "the instance refuses ALONE" - do not soften it into an empty payload, which would make a
  refusal indistinguishable from "nothing happened" and delete the only probe
  `organisation-isolation.test.mjs` and `ownership-claim.test.mjs` have for the stamp.
- `GET /usage?since=` serves the usage ledger in both hosted and BYO mode, written in the settle
  finally-block with 366 day / 5000 row retention.
- `GET /workflow` on the DO reads the deployed spec back, which is what makes a deployment itself a
  recoverable copy. It needs no redaction: a `WorkflowSpec` references credentials by NAME, and the
  values live in the `SecretVault` or worker env.
- `WorkflowAgent` is the ONLY writer of the `deploy:` registry in `PortalIndex` - on an accepted
  `POST /workflow`, on `DELETE /workflow`, in `purgeSelf(true)`, and backfilled from held state in
  `onStart()`. Every write is non-fatal (a failed one reports through `settingsIssues` and the
  deployment still succeeds), a rejected push writes nothing, and a portal SESSION instance
  (`state.portalSession != null`) is skipped. Resolve the workflow id BEFORE clearing `state.spec` -
  `workflowKey()` reads the spec id first, so afterwards there is nothing left to name.
- Hosted mode re-labels `node-usage` `provider` to `phorma-cloud` (hosted inference runs on
  OpenRouter but bills plan credits). BYO deployments keep real provider names.
- Historical run snapshots store a versioned envelope in the graph column and must still parse
  legacy raw graph JSON. Snapshots include optional `subWorkflows`.
- The studio bakes app-level defaults into the spec at PUSH time, so no cloud change is needed when a
  new app default appears - and the worker never materializes anything. The transform is
  `materializeSpecDefaults` in `frontend/src/app/core/spec-defaults.ts` (a pure leaf);
  `CloudService.materializeDefaults()` is a thin wrapper that adds the local skills refresh, which
  stays OUT of the hash. Consequence, stated: `DeploymentRecord.specHash` and
  `canonicalSpecHashOf(spec)` compare workflow CONFIGURATION, not attached skill CONTENT, and every
  hash any side compares is over an already-materialized spec.

## Tenancy and billing

- `TIERS` in `cloud/src/tenants.ts` is the authority: starter, pro, team. The `plus` tier was
  removed. `TIER_MONTHLY_CREDITS` in `phorma-cloud.service.ts` mirrors it, and `tierLabel()` renders
  ids (`team` displays as "Teams", unknown ids title-case through).
- `monthlyCredits` is the ONLY unit ever displayed. `monthlyCostUsd` is the real spend cap
  (OpenRouter key limit) and is analytics-only. Higher tiers bake a volume bonus into a larger USD
  budget so displayed credit numbers stay round.
- Sub-workflow depth limits: Free/BYO 2, Starter 5, Pro 8, Team 10, engine hard ceiling 25. Unknown
  hosted tiers fall back to Starter.
- Secrets: `npx wrangler secret put <PROVIDER>_API_KEY` per provider, plus `PHORMA_TOKEN` to protect
  BYO endpoints. Connection secrets follow `connectionSecretName` / `workerSecretName` from
  `engine/src/connections.ts` (worker names must match `^[A-Z][A-Z0-9_]*$`). Local `wrangler dev`
  vars are documented in `cloud/.dev.vars.example` (copy it to `.dev.vars`); deployed secret names
  live in the `wrangler.jsonc` header. Add a new secret to BOTH.
- Stripe billing reads `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, declared as `StripeEnv` in
  `cloud/src/stripe.ts` and folded into `ApiEnv`. Both are OPTIONAL and must stay that way: a BYO
  worker binds neither, so an unconfigured billing route answers 501 naming the missing secret
  (`requireStripeSecret`) rather than a 500. `STRIPE_WEBHOOK_SECRET` is per ENDPOINT, not per
  account - `stripe listen --forward-to` prints a different `whsec_` than a Dashboard endpoint, so a
  local run and the deployed worker never share it, and a stale one reads as `no_match` in the log.
- `BILLING_LOOKUP_KEYS` in `cloud/src/stripe.ts` is the security boundary for `/api/checkout`: a
  client sends a lookup KEY, never a price id, and anything off that six-entry Map is a 400 before
  any Stripe call happens. A key maps to a KIND (`subscription` | `topup`), never to a tier - tier
  comes from `metadata.tier` on the price via `tierForPrice`, so annual pricing is one more entry
  and no tier mapping to keep in sync. An unknown or missing `metadata.tier` is a REFUSAL, never a
  default to a paid tier. Lookup keys not ids because sandbox and live ids differ.
- Four billing routes, and WHERE each is matched is load-bearing.
  `POST /api/stripe/webhook` (`cloud/src/stripe-webhook.ts`) is matched at the TOP of
  `routeApiRequest`, above every branch that calls `request.json()` - the signature covers the RAW
  bytes and a consumed body cannot be re-read - and ABOVE the `store.enabled` gate, because an
  authentic event on a worker with no D1 must ask for a redelivery rather than be told "hosted
  bindings missing". It also sits outside `verifyRequest` and the `PHORMA_ADMIN_TOKEN` check entirely:
  Stripe authenticates by HMAC and has no bearer to present.
  `POST /api/checkout` and `POST /api/billing-portal` sit BELOW that gate and outside the `isAdmin`
  branch - billing is a hosted-only surface and a paying user is not an operator.
  `GET /billing/return` is NOT under `/api/`, so `index.ts` wires `handleBillingReturnRequest`
  (exported from `api.ts`) with the other public routes: it is a top-level navigation with no bearer,
  so it carries NO CORS headers, touches no bindings and renders static markup. `success_url` and
  `cancel_url` point at it because the studio is a desktop app with no addressable URL and a
  browser-parity user is on an arbitrary localhost port. The studio learns the outcome by polling
  `/api/me`, never from the redirect.
- The webhook's response policy is counter-intuitive and deliberate: a PERMANENT payload defect
  answers **2xx**. Stripe retries every non-2xx for days and eventually disables an endpoint that
  keeps failing, which breaks billing for EVERY tenant rather than the one event, and a retry can
  never fix a body we could not parse - so the evidence goes to the log and the delivery is accepted.
  Non-2xx is reserved for "send this again": 400 for an unreadable body or a bad signature, 413 over
  `STRIPE_WEBHOOK_MAX_BODY_BYTES` (1 MiB, checked from `Content-Length` BEFORE any HMAC so
  attacker-paid CPU on a public route is bounded), 501 for a missing `STRIPE_WEBHOOK_SECRET` or a
  missing D1 binding, 502 when Stripe is unreachable mid-apply. An `ignored_stale` or `unresolved`
  event is 2xx and still gets a `stripe_events` row - requirement 3 forbids discarding a payment that
  found no account, and "nothing happened" has to stay distinguishable from "never arrived".
  NEVER return a `retry` from the GRANT path specifically: `recordCreditGrant` is idempotent on
  `stripe_payment_id`, so a redelivery would grant nothing and fail again forever, over money that
  already landed, until Stripe disabled the endpoint for every tenant.
- Eight event types are dispatched, and DELAYED PAYMENT METHODS need two of them.
  `checkout.session.completed` fires with `payment_status` still unpaid for a bank debit or some
  wallets, and `applyTopUp` correctly refuses to grant on a promise - so
  `checkout.session.async_payment_succeeded` routes to the SAME `applyCheckoutSession`, which branches
  on `mode`, and the pack grants exactly once across the pair because the grant is keyed on the
  PAYMENT. Without it a customer paying that way was charged and received zero credits, permanently
  and silently. `checkout.session.async_payment_failed` is its own tiny handler
  (`applyFailedAsyncPayment`): nothing was ever granted, so it is a logged 2xx with a `stripe_events`
  row, NO state change, and no outbound call at all - it must NOT reach `applyCheckoutSession`, which
  in subscription mode would activate a plan for a payment that failed. Its `tenant_id` comes from
  `client_reference_id` only, because the fallback resolution paths can cost a Stripe read that can
  fail, and asking for a redelivery of an event we will never act on is a non-2xx over nothing.
- **Every `/api/admin/*` surface shares ONE gate**, `refuseNonOperator` in `cloud/src/admin-auth.ts`,
  which also owns `isOperator`, `noStoreResponder` and `readBearerToken`. There are THREE operator
  route families now - `/api/admin/telemetry/*` (`telemetry-admin.ts`), `/api/admin/billing/*`
  (`billing-admin.ts`) and `/api/admin/organisations/*` (`org-admin.ts`) - and all three are mounted
  beside each other in `routeApiRequest`, ABOVE the
  `store.enabled` gate, because each carries its own authorization and its own D1 handling. A new
  admin surface calls that gate; it never re-implements the 401/403 split. `telemetry-admin.ts` still
  exports `isTelemetryAdmin` as an alias of `isOperator` because `test/telemetry.test.mjs` and the
  requirement numbers are written against that name.
  The gate's rules, none of which are negotiable: an ABSENT bearer is 401 (checked before
  `verifyRequest`, which hands an anonymous context to an open BYO worker and would otherwise answer
  403 to a request carrying no credential); a non-`clerk` credential kind is 403, so a long-lived
  desktop `phd_` token sitting in a laptop keychain cannot carry operator access; and a missing
  allowlist secret means NO access rather than open access.
  **`TELEMETRY_ADMIN_USER_IDS` is a BARE comma-separated list, not JSON.** `["user_a","user_b"]`
  splits into `["user_a` and `"user_b"]`, neither of which equals a user id, so a JSON-shaped value
  fails closed and every operator reads 403 with nothing in the log to say why - indistinguishable
  from not being an operator. The name is historical (telemetry was the only admin surface when it was
  created) and is deliberately NOT renamed: one allowlist, one door, and renaming a secret costs a
  window where one of the two surfaces 403s for everyone.
- **`/api/admin/organisations/*` (`org-admin.ts`) is the ONLY surface in the worker that writes
  membership.** Requirement 13.7 of `multi-organisation-phorma`: there is no organisation-facing member
  management route in this release, so `member.manage` stays DECLARED in the capability contract and
  exercised by no route - a released token is never renamed or repurposed. `role-gate.test.mjs`
  asserts that ABSENCE as an inventory claim over its static scan, in both directions: no mutating
  route whose path reads like a membership write sits outside this prefix, and `WRITE_ROUTES` declares
  no such entry at any level.
  Four routes: `GET list`, `POST create`, `GET|POST|DELETE members`, `POST tier`.
  Three rules there are not negotiable. (1) **Clerk goes FIRST, then the `org_members` row.**
  `resolveRole` consults `CLERK_ROLE_LEVELS` BEFORE the table and `org:admin` maps to `admin`, so on a
  DEMOTION out of `admin` the Clerk role is what has to move first - write the row first and let the
  PATCH fail and the claim keeps short-circuiting to `admin` while the row says `builder`, a demotion
  in name only with a correct-looking row to prove it happened. The reverse partial fails CLOSED,
  because an `org:member` claim is deliberately unmapped. (2) **A partial failure is REPORTED, never
  logged**: 502 `org_clerk_failed` when nothing was written and 502 `org_partial_write` when one half
  landed, because one half existing without the other is the state an operator most needs to see and
  the one no later request can discover. Both codes are append-only. (3) **Every membership and level
  write invalidates `orgmember:{orgId}:{userId}` IMMEDIATELY**, on the failing paths too, because a
  demotion that takes 60 seconds to bite did not happen for 60 seconds and a REMOVAL that takes 60
  seconds leaves a removed member addressing the organisation through `X-Phorma-Owner` for a minute
  (Requirement 20.11). An unrecognised level token is 403 `role_unknown`, the Role_Gate's own token
  reused rather than copied.
  Creating an organisation provisions a `tenants` row at `UNPAID_ORG_TIER` (`none`, deliberately not
  in `TIERS`) with `UNPAID_ORG_STATUS` (`canceled`) and NO runtime key. An absent `DB` here is 501
  NAMING the binding, unlike the telemetry aggregates' empty answer: membership is the subject, and an
  empty list would read as "this account has no organisations".
- **Impersonation is read-only, audited, stateless, and lives in ONE module** (`impersonation.ts`,
  Requirement 14 of `multi-organisation-phorma`). `X-Phorma-Act-As` is read in one place and
  `impersonation_audit` is written and read in one place. `resolveOperator` (`admin-auth.ts`) is a
  SEPARATE function from `refuseNonOperator`, whose deliberate `null`-means-proceed contract is
  untouched: the gate hands back no identity, the resolver hands back the acting user id and refuses
  nothing. Five rules that are not negotiable.
  (1) **Null covers three cases that must be INDISTINGUISHABLE**: no header, a header from a
  non-operator, and a value `isOwnerId` rejects. All three serve the caller's own owner with NO
  refusal, so probing the header reveals nothing - the same discipline `X-Phorma-Owner` follows, and
  the reason the two headers stay separate.
  (2) **`applyImpersonation` moves EXACTLY ONE FIELD**, `ownerId`. `orgId`, `orgRole`, `userId` and
  `kind` keep their verified values, so `resolveRole` still answers about the credential and an
  impersonated READ is not refused `role_unknown` for the operator having no membership - substituting
  `orgId` too deletes the read half of the feature. Consequence: anything comparing the addressed
  owner reads `auth.ownerId`, never `resolveOwner(auth)`, which recomputes `orgId ?? userId` and
  answers the operator's own account. `WorkflowAgent.enforceOwnership` reads the field for exactly
  that reason.
  (3) **Three independent enforcement layers.** `guardImpersonation` at the gateway AND at the top of
  `routeApiRequest` refuses a WebSocket upgrade OUTRIGHT (a monitor socket accepts `approval`,
  `question`, `event`, `trigger` and `stop`, so it is a write channel wearing a read's clothes) and
  every non-GET with `impersonation_read_only`, before `routeAgentRequest` and before any route
  dispatch. `requireCapability` refuses an impersonated write FIRST, before the level comparison, so
  an operator who ALSO holds a real membership cannot write through the header - their membership is
  the write path. `resolveHostedInference(store, id, { impersonated })` refuses a SIXTH append-only
  token, `impersonation_read_only`, for any tenant state, so an impersonated request spends nothing
  even if both layers above were bypassed. That third layer is unreachable today by construction, and
  that is the point of it.
  (4) **`requireCapability`'s `options.method` makes the refusal write-scoped and OMITTING IT FAILS
  CLOSED.** Every control-plane call site is a write route and names nothing; `WorkflowAgent` serves
  both through one gate and passes its method; the socket path passes none on purpose.
  (5) **The audit write is AWAITED and a failure REFUSES the request** with `impersonation_unaudited`,
  never `ctx.waitUntil` - a `waitUntil` failure cannot refuse a request, and an unaudited impersonated
  read must never happen. One row per ACCEPTED request, none for one refused or ignored, and `path`
  carries NO query string. Do not "optimise" it into a background write: one D1 write on the request
  path is affordable precisely because impersonation is a support action measured in dozens per day.
  `GET /api/admin/impersonation` is the FOURTH operator prefix, read-only, `refuseNonOperator`-gated.
  Only three control-plane reads honour the substituted owner and the list is exported as
  `IMPERSONATED_READ_PATHS` (`api.ts`): `/api/me`, `/api/deployments`, `/api/notifications`.
  `/api/backups` and `GET /api/proposals` are deliberately NOT among them. `X-Phorma-Act-As` must stay
  in BOTH `Access-Control-Allow-Headers` lists (`corsHeaders` in `index.ts` and `json()` in
  `workflow-agent.ts`) - a header missing there is dropped by the BROWSER and the request arrives
  looking exactly like one that never carried it.
- **One provisioning path, two callers.** `provisionTenantTier` (`tenants.ts`) holds the three steps -
  `upsertTenant`, read the row BACK, reconcile the runtime key only for an `active` tenant - and both
  `POST /api/provision` and `POST /api/admin/organisations/tier` call it. Requirement 19.5 names
  provisioning as the only way an organisation becomes entitled, which is a claim about ONE path
  rather than about two that happen to agree, and the `active`-only gate `reconcileRuntimeKey`
  documents as the caller's is now structural. There is still NO credit-grant path and there must not
  be one: a higher ceiling is a TIER change (Requirement 19.10).
- `/api/admin/billing/*` is a SEPARATE prefix from the telemetry aggregates, not a sixth aggregate
  route, and the reason is a privacy contract rather than tidiness: telemetry bodies carry no
  `install_id` by construction and fold groups under five installs into `other`, while these bodies
  name identified paying tenants on purpose - "which account is cancelled but still holding a live
  key" is not actionable without the id. Two routes: `costs` (OpenRouter balance via
  `GET /api/v1/credits`, trailing-30-day burn from `usage`, runway, the committed ceiling summed over
  ACTIVE tenants, and the attention lists; `burn.daily` is the same window per UTC day, ascending and
  zero-filled, from ONE grouped query whose day sums ARE `meteredUsd`, and `[]` when the ledger is
  degraded or unbound) and `revenue` (Stripe `/v1/invoices` for gross/tax/net plus
  `/v1/balance_transactions` for the processing fee, KV-cached 300s). Split rather than merged so a
  Stripe outage degrades one card instead of blanking the balance and runway, which are what an
  operator opens the page for during exactly that outage.
  Three invariants there. **A NULL IS NOT A ZERO** in any response field: `balanceUsd: null` means the
  vendor read failed and `0` means the account is empty, and rendering them alike turns a blip into a
  false emergency. **Every USD figure is DOLLARS**, converted from Stripe's minor units once at the
  boundary. **`net = gross - tax` is the only margin basis** (requirement 49), and Stripe carries the
  tax in TWO shapes - the scalar `invoice.tax` and the `total_taxes[]` breakdown - so both are read;
  reading one silently reports zero tax and inflates the margin, which is worse than not measuring it.
- The OpenRouter BALANCE is deliberately absent from `/status.json`. `probeInference` there calls the
  credits endpoint but `drain()`s the body unread, so it measures reachability plus credential
  validity only and a dry account reads green. That is not a bug to fix in `status.ts`: the badge is
  rendered on phorma-labs.com's public footer, so anything that moved its colour would tell visitors
  about our funding rather than about their service. Balance, burn and runway belong behind the
  operator allowlist. Note also that nothing in this repo ever FUNDS the OpenRouter account - every
  vendor write is a spend limit on a key, and OpenRouter has no card-based credits-purchase API, so
  topping up is a manual dashboard action forever.
- `resolveHostedInference` (`cloud/src/tenants.ts`) is the ONE entitlement gate. `/api/infer` and
  `WorkflowAgent.trigger()` both call it - the DO used to carry a second copy of the checks, and two
  copies is how a top-up ends up raising the ceiling for a local run and not a deployed one. It
  returns `{ key, tenant }` or `{ status, error, code }`, so `'status' in result` still discriminates
  and the shape is still assignable where `StripeRefusal` is expected. The seven `code` tokens
  (`no_subscription`, `subscription_past_due`, `runs_exhausted`, `credits_exhausted`,
  `no_runtime_key`, `impersonation_read_only`, `workflow_not_entitled`) are an APPEND-ONLY wire
  contract the studio branches
  on: add one, never rename or repurpose one. The sixth is checked FIRST, before any read, and is a
  property of the CALLER rather than of the tenant - it is the third layer of the impersonation
  read-only rule, not a billing state. `past_due` must stay a distinct refusal from unsubscribed - the remedy is the billing
  portal, not a Subscribe CTA - and it deprovisions nothing, so a `past_due` tenant keeps tier, data
  and runtime key. The prose stays matchable too (`credits exhausted`, `subscription`), because an
  older studio falls back to a regex when the code is absent.
  The SEVENTH is RESERVED and is returned by nothing (Requirement 15.4 of
  `multi-organisation-phorma`): `entitlement.test.mjs` greps `cloud/src/` and fails if
  `workflow_not_entitled` appears anywhere but the union declaration and its doc comment, so wiring
  it up without also wiring up the policy fails a test. It exists because the gate now takes
  `options.workflowId` - `/api/infer` reads it off an ADDITIVE optional body field and
  `WorkflowAgent.trigger` passes `this.state.spec.id` - which nothing reads, deliberately: there is
  no workflow catalogue, no per-workflow meter and no entitlement table, and per-workflow pricing
  later is then a policy change inside this one function rather than a signature change across two
  call sites and a wire contract. A future workflow SKU arrives as price METADATA the way `tier`
  does, never as a client-supplied price id, so `BILLING_LOOKUP_KEYS` stays as it is.
- Grants RAISE the ceiling, they never reduce recorded usage: `effectiveCostUsdLimit` /
  `effectiveCreditsLimit` = tier allowance + `grantPool()`. The allowance is spent FIRST, so
  `recordRun` takes the tenant's `tier` (required, both callers already hold it) and draws
  `cost_usd_consumed` only for the part of a run that lands past `monthlyCostUsd` - `grantDrawUsd` is
  that split, pure and testable without D1. The draw hangs off the SAME `meta.changes` signal as the
  quota rollup, which is only a real signal because `0003_billing.sql` added `idx_usage_tenant_run`;
  a second gate computed any other way double-draws on a retried settle. Draw FIFO by `id`, never
  `created_at` (two grants from one webhook pass tie to the millisecond), and clamp both ends -
  `MIN(cost_usd, ...)` on write, `MAX(0, ...)` per grant on read - because the schema deliberately
  has no overdraw CHECK. `grantPool` is NOT KV-cached and must not become so: the gate reads it only
  once the allowance is gone, so it is off the hot path, and a stale pool would make a top-up look
  like it did nothing. `/api/me` exposes it as ADDITIVE quota fields (`grantCreditsRemaining`,
  `grantCostUsdRemaining`); `creditsLimit` stays the tier allowance alone, because only the allowance
  resets monthly.
- The OpenRouter runtime key is reconciled, never left behind: `reconcileRuntimeKey` (`tenants.ts`)
  PATCHES the existing key's `limit` to `runtimeKeyLimitUsd` and mints a replacement ONLY
  when there is no usable key (no ciphertext). It is called from `/api/provision`, from the
  webhook's subscription write and from the webhook's GRANT write, in every case with the row READ
  BACK AFTER the write - never with the
  tier off the event, because a stale event still performs its write and reconciling against it would
  cap a pro tenant at starter's $4. It never throws (a raise inside the webhook is a non-2xx and an
  endless Stripe redelivery), so every failure is a `RuntimeKeyOutcome` plus a `console.error`. When a
  replacement IS minted the superseded hash is disabled FIRST, so one tenant never holds two live
  keys, and `supersededKeyDisabled` is a THREE-state field: `null` nothing to retire, `false` we
  tried and a live key is still out there. Only `active` tenants are reconciled - re-limiting a
  cancelled or `past_due` key would undo the branch that took it out of service - and that gate is
  the CALL SITE's, not the function's, because the migration needs to classify a non-active tenant
  rather than have the call quietly no-op. The limit patch
  carries `disabled: false` with it, because a resubscriber's key was retired at cancellation and the
  cap alone would leave the row entitled while OpenRouter refused every run. Two columns, one
  write: `TenantStore.setRuntimeKey` exists because `upsertTenant` would force a rotation to restate
  `tier`/`status` and bypass the per-field clocks.
- The cap on the key is `runtimeKeyLimitUsd` = tier allowance + `grantPool()`, the SAME number
  `effectiveCostUsdLimit` gives the gate - NOT `monthlyCostUsd`. A purchased pack raised our ceiling
  while the key still carried the tier figure, and OpenRouter enforces its own `limit`, so the exact
  overage a pack was sold to cover was refused by the vendor. Two writes close it and BOTH are
  required: the grant-aware sum (one line, covering the PATCH, the mint and every call site) and the
  reconcile on the webhook's grant path. The sum alone never fires on a purchase; the grant-path call
  alone gets patched back out by the next tier change. Why the naive sum is safe: the cap is
  `allowance + poolAtPatch`, between patches the pool only SHRINKS (spending draws it down, a new
  grant IS a patch) and the allowance is constant (a tier change IS a patch), so
  `ourCeiling(t) = allowance + poolNow <= keyLimit` always and the key can never refuse a run the gate
  allows. The accepted residual: after a month boundary the key cap can sit ABOVE our ceiling by
  whatever pool was unspent at the last patch until the next patch tightens it - the gate is the
  primary control and reads the live pool, so do NOT add a cron sweep or a "last patched month"
  column. `runtimeKeyLimitUsd` never throws and degrades to the tier allowance alone: a store with no
  D1, or a database predating `0003_billing.sql` and therefore missing `credit_grants` (which is the
  hosted database the workspace migration runs against), reads an empty pool. ORDERING CAVEAT: a key
  minted before `limit_reset: 'monthly'` existed treats `limit` as a LIFETIME ceiling and nothing in
  the tenant row records which kind a tenant holds, so this is only fully sound once
  `scripts/migrate-openrouter-workspace.mjs` has re-minted the fleet. Do not try to detect it - there
  is no `GET /keys/{hash}` call in the worker and adding one is out of scope.
- `disableTenantRuntimeKey` is the ONLY way to retire a key, and it returns a boolean. Never
  `.catch(() => undefined)`: that reported a successful `/api/deactivate` while the key stayed live
  and spending, and a leaked key is invisible anywhere but OpenRouter. Deactivation and cancellation
  still proceed on a failure - the tenant status is what stops the spending - but the response
  carries `runtimeKeyDisabled: false`. An `RuntimeKeyOutcome.detail` reaching a response body is OUR
  sentence, never the vendor message: `provisionOpenRouterKey` carries 200 characters of OpenRouter's
  body in its error, and `/api/provision` puts `detail` in JSON, so the upstream text goes to the log
  only. OpenRouter's `limit` is CUMULATIVE unless a `limit_reset` is set, so a mint now sends
  `limit_reset: 'monthly'` - the same clock as the `monthlyCostUsd` allowance it mirrors. The tier
  PATCH deliberately does not send it (it would reinterpret an existing key's accrued usage on a path
  that runs on every tier change AND every top-up), so the fleet converges through mints: the
  workspace migration re-mints every key that predates the field. The grant term moves the limit
  VALUE, never the body shape - `provisioning.test.mjs` asserts "two fields and no more".
- Requirement 36's mechanism, settled by investigation: a runtime key's WORKSPACE is a mint-time body
  field, `workspace_id` on `POST /api/v1/keys`, defaulting to the account's default workspace when
  absent. `OPENROUTER_WORKSPACE_ID` (a hosted `var`, not a secret - a workspace UUID authorizes
  nothing, the management key does) is read in ONE place, `reconcileRuntimeKey`'s mint, so an unset id
  reproduces the old behaviour exactly. A management key is account-level and reaches every workspace,
  and no PATCH field moves an existing key, so migrating the fleet is `var` + deploy + re-mint:
  `cloud/scripts/migrate-openrouter-workspace.mjs` (dry run by default). Its re-runnability rests on
  the stored hash's own `workspace_id` plus the deterministic `runtimeKeyName(id)` orphan sweep -
  never a local ledger, because a key minted and not stored is unrecoverable and invisible except by
  its name. `cloud/scripts/` is excluded from the installer in `scripts/check-deploy-bundle.mjs`.
- **The owner seam.** `auth.ts` answers "who is asking" (`userId`, `kind`) AND "whose data is this"
  (`orgId`, `ownerId`, `orgRole`). Read `auth.ownerId`, or call `resolveOwner(auth)` for a context you
  synthesised; never re-derive `orgId ?? userId`. `ownerIdIsAddressable` is the colon guard and lives
  BESIDE the resolver, because a resolver that can return a refusal is one every caller must
  discriminate. `resolveRole(env, auth)` is the one level seam: no organisation claim resolves `admin`
  (which is what keeps a solo install byte-identical), a mapped `CLERK_ROLE_LEVELS` claim
  short-circuits, and `org_members` is the AUTHORITATIVE source behind the same 60s KV cache
  `getTenant` uses (`orgmember:{orgId}:{userId}`; a HIT is cached, a MISS never is). A `device`
  credential carries no organisation claim on purpose - `device-auth.ts`'s `phd_` payload gains
  nothing - so it names one per request with `X-Phorma-Owner`, confirmed against `org_members` by
  `resolveRequestedOwner`. That is a different header from `X-Phorma-Act-As`, which is an operator
  naming somebody else's owner. A `shared` credential ignores the header outright.
  `X-Phorma-Owner` is READ in one place and ADOPTED in one place: `adoptRequestedOwner` is called from
  `verifyRequest`, so every authenticated `/api/*` route and the HTTP gateway inherit it together.
  It moves TWO fields, `orgId` and `ownerId` - unlike `applyImpersonation`, which moves exactly one -
  because a confirmed membership is a fact about the CALLER, so `resolveRole` must answer about the
  organisation and `refuseManagedBilling` must refuse its checkout. It returns the context UNCHANGED
  for every other case, so an install that never sends the header is byte-identical. A WebSocket
  upgrade is NOT covered and cannot be: `WebSocket` carries no request header, so a monitor socket
  follows the verified claim alone.
  `GET /api/me` REPORTS all three answers as ADDITIVE fields - `ownerId`, `level` and `owners` - which
  is the studio's only source for any of them; `CapabilityService` and `ActiveOwnerService` are both DI
  leaves and are pushed whatever this route says. `owners` is resolved from `org_members` by `user_id`
  (what `idx_org_members_user` exists for) and is keyed on the VERIFIED caller, never the resolved
  owner: an organisation cannot switch, and an operator impersonating a customer therefore sees their
  OWN memberships there and learns nothing about the customer's. It is returned on BOTH branches, is
  NOT KV-cached, and an unrecognised level token is dropped rather than offered. `level` is OMITTED when `resolveRole` answers `{ unknown: true }`: a read never refuses
  over a membership question, an absent field is the same shape an older worker sends, and the
  studio's `isCapabilityLevel` guard rejects an absent and an unrecognised value identically. The
  refusal for an unresolvable role belongs on the WRITE path, in `requireCapability`.
- **Every owner consumer reads the RESOLVED owner, and there are exactly two exceptions.** The
  Secret_Vault instance name, the `deploy:` registry prefix on both the deployments list and the
  notification fan-out, `workflow_backups.tenant_id` plus the R2 backup prefix, and every `usage`
  row, `quotas` rollup and `credit_grants` draw all key on `auth.ownerId`, so one `tenants` row per
  owner is the single quota bucket and a member's run is entitled and metered against the
  ORGANISATION. Keying the entitlement gate and the ledger write differently is the defect to watch
  for: a run is then metered against a ceiling it was never checked against, and no single-surface
  test can see it (`organisation-metering.test.mjs` asserts both halves per call). The two
  exceptions are Stripe's: `/api/checkout` and `/api/billing-portal` pass `auth.userId` on every
  line, because an organisation is invoiced by Phorma Labs and an `org_` id must never reach Stripe.
- **Self-serve billing is a PERSONAL-account capability, and the refusal is not the Role_Gate's.**
  `refuseManagedBilling` (`api.ts`) answers 403 `billing_managed` at the TOP of `POST /api/checkout`
  and `POST /api/billing-portal`, above the level gate and above the catalogue lookup, so no Stripe
  object of any kind can exist for an organisation owner. It is NOT in `requireCapability` because an
  organisation admin resolves `admin` - a gate comparing levels alone admits them. `WRITE_ROUTES`
  therefore records both routes as `admin` PLUS a personal-owner condition. It reads `auth.orgId`
  rather than comparing `ownerId` with `userId`: the verified claim is the fact, and those two
  expressions differ for a `device` credential. An organisation reaches an entitled state through
  `/api/provision` alone, and a higher ceiling is a TIER change - there is no comp-credit path and
  there must not be one, because `credit_grants.stripe_payment_id` is `NOT NULL UNIQUE` and a grant
  without a payment would have to weaken the thing that makes a grant idempotent.
- **The Role_Gate is the third question, and it is the SECURITY BOUNDARY.** `requireCapability(env,
  auth, required, respond)` in `cloud/src/role-gate.ts` is the ONE capability check; discriminate with
  `'level' in result`, the same idiom as `'status' in gate`. Every write route calls it naming its level
  as a LITERAL, and `WRITE_ROUTES` + `requiredLevelFor(method, path)` are the DATA declaration of what
  each write requires - `cloud/test/role-gate.test.mjs` drives every entry against a real route and
  statically scans `api.ts` and `workflow-agent.ts` for a mutating literal the table does not answer, so
  a NEW WRITE ROUTE SHIPS WITH A TABLE ENTRY AND A PROBE or the suite fails. Reads are open to every
  level including `operator`; the boundary is between organisations, not within one. Three rules that
  are not negotiable. (1) Never derive a covered route's required level from the path inside a
  dispatch - two path matchers for one dispatch is how one starts admitting what the other refuses; the
  table's only runtime role is the FAIL-CLOSED backstop in `WorkflowAgent.onRequest`, which refuses a
  mutating method the table does not mention at `ROLE_GATE_FALLBACK_LEVEL` (`admin`). (2) An
  unresolvable role is `role_unknown`, never a substituted `operator` - `operator` can trigger a run,
  which spends the owner's credits, so there is no safe minimum. (3) A DO level refusal DRAINS the
  request body first (`refuseLevel`), or an unread request stream wedges the caller's next request on
  that socket.
- **Two independent isolation layers over the resolved owner.** The gateway in `index.ts` rewrites an
  instance name to `${resolveOwner(auth)}:${instance}` and 403s a foreign prefix BEFORE
  `routeAgentRequest`, so no Durable Object is woken - `organisation-isolation.test.mjs` proves that
  by watching `idFromName` rather than by reading the source. `WorkflowAgent.enforceOwnership`
  compares the stamp against `resolveOwner(auth)` and must be able to refuse ALONE, because the RPC
  entry points (`notificationsSince`, `purgeSelf`, `startPortalTurn`, `claimOwnership`) never pass
  through the gateway. `ownerIdIsAddressable` gates both, plus ONE gate above every authenticated
  `/api/*` route (`refuseUnaddressableOwner` in `api.ts`, below the Stripe webhook branch) answering
  `owner_invalid`.
- **A WorkflowAgent instance name is PERCENT-ENCODED in hosted mode.** `index.ts` writes
  `encodeURIComponent('{owner}:{workflowId}')` into the path and partyserver's `routePartykitRequest`
  hashes the path segment WITHOUT decoding it, so `org_a:wf` and `org_a%3Awf` are two different
  Durable Objects. Anything reaching an owner's instance by name goes through
  `workflowAgentInstance` (`portal-registry.ts`) or it silently addresses a blank instance - no error,
  no log line, an empty answer. Measured against the real deploy bundle, 2026-09-14.
  `askInstance` (`notifications.ts`) was one of those call sites and is FIXED - the notification
  fan-out addressed blank instances in hosted mode, so the feed read as "nothing has happened".
  KNOWN DEFECT, still open: `portalOwnerInstance` builds the RAW form, so in hosted mode a published
  portal reads a blank instance. Not fixed here because the fix moves which DO a live hosted portal
  reads and needs its own reproduction and migration thought. BYO is unaffected (no owner prefix,
  nothing to encode). The doc comment names it.
- **The ownership claim** is `POST /api/deployments/{workflowId}/claim` in `ownership-claim.ts`,
  mounted after `handleDeploymentsRequest` and ABOVE the `store.enabled` gate with its own two 404s,
  because that gate answers 501 naming a binding and BYO must see the route as ABSENT. Order is
  load-bearing: the `workflow_backups` collision pre-check, then the `claimOwnership` RPC (one
  `setState` replace, then a write-then-remove registry move), then ONE `DB.batch` moving
  `workflow_backups` and `usage`, then the `ownership_claims` row, which LOGS on failure rather than
  refusing. `quotas`, `tenants`, `credit_grants` and `stripe_customer_id` are deliberately NOT moved.
  The transfer is keyed on the ACTING USER as the source so a retry after a failed batch converges.
  Refusal codes `claim_not_owner` / `claim_unowned` / `claim_conflict` are append-only.
  OPEN GAP: a Durable Object name is fixed at creation, so a claimed deployment keeps living at
  `{actingUserId}:{workflowId}` while the organisation addresses `{orgId}:{workflowId}` - a different,
  blank instance. Ownership moves correctly; ADDRESSING what you now own needs a design decision.
- **`workflow_backups.body_key` is the stored R2 prefix, and NULL means derive it.** One fallback,
  `bodyPrefixFor` in `backup-store.ts`; every `BackupBodyStore` method takes that PREFIX rather than
  an owner and a workflow id, which is the enforcement - a method still taking `(tenantId,
  workflowId)` would derive the new owner's prefix for a claimed row and report a body that is sitting
  in the bucket as no longer retained. A claim freezes the prefix with
  `body_key = COALESCE(body_key, ?)`, so no R2 object is ever rewritten and every body stays readable
  at its original key. `deleteTenant` takes the stored prefixes alongside the owner scan for the same
  reason.
- **A `connection.close()` from `onConnect` is NOT delivered**, measured against the real deploy
  bundle: the client socket stays at `readyState === 1` and goes on being served. So the monitor
  socket's authorization is the PER-FRAME guard at the top of `WorkflowAgent.onMessage`, which reads the
  level `onConnect` recorded through `connection.setState` (partyserver's hibernation attachment, kept
  under `__user` beside its own `__pk`, so it survives an eviction for as long as the socket). An absent
  level refuses. Never store a token there - a credential in a socket attachment is a credential in
  Durable Object storage. Every `ControlFrame` (`approval`, `question`, `event`, `trigger`, `stop`)
  writes state, so this is a write path and Requirement 6.2 covers it.
- `tenants.id` IS the Clerk user id or an organisation id, and the classifier TRIO is deliberate:
  `isOwnerId` accepts `user_` and `org_`, `isClerkUserId` stays NARROWER and stays the predicate for
  anything that genuinely means a human - in particular the three Stripe-supplied id paths, because an
  organisation is invoiced by Phorma Labs and an `org_` id can never legitimately arrive from Stripe -
  and `isOrgId` is the narrowest, for the organisation management routes, which take an `orgId` and a
  `userId` as two SEPARATE parameters of one write. Validating both with `isOwnerId` would let a
  swapped pair through, and a membership row keyed `(user_x, org_y)` resolves for nobody, ever, with
  nothing logged about it. All three are WRITE-path only.
- `isClerkUserId` (`tenants.ts`) guards WRITE paths only:
  `/api/provision` and the two Stripe-supplied id paths. Never re-validate an id read out of
  `tenants` - rows hand-provisioned before that check can hold an id it rejects, and refusing to
  resolve one would strand a real payment. A bad id on a write creates an orphan row `/api/me` can
  never find, which is indistinguishable from a user who has not signed in yet.
- The billing schema is two migrations, both additive. `0003_billing.sql` carries the whole concern:
  `stripe_customer_id` / `stripe_subscription_id` on `tenants`, the PARTIAL unique index on the
  customer id (a plain UNIQUE enforces the same thing, the `WHERE` clause documents that an unmapped
  tenant is the steady state), the `idx_usage_tenant_run` repair that finally makes `recordRun`'s
  documented idempotency real, `stripe_events` and `credit_grants`. `0004_billing_ordering.sql` adds
  the per-field clocks. `0006_organisations.sql` is the organisation schema (`org_members`,
  `workflow_proposals` with its partial unique index, `ownership_claims`, `impersonation_audit`, and
  the nullable `workflow_backups.body_key`), written COMPLETE in one change on purpose: a migration is
  recorded as applied by FILENAME, so anything appended after a remote apply silently never runs, and
  only `org_members` is read by the code that shipped with it. It also carries the one ALTER in the
  set, so like 0003 it is NOT self-healing - never hand-run it through `d1 execute`, and a later schema
  change goes in 0007. Both billing ones ARE now applied remotely (verified 2026-09-09 -
  `npx wrangler d1 migrations list phorma-cloud --env hosted --remote` answers "No migrations to
  apply!"); that command is the only trustworthy answer to the question, so run it rather than
  believing a line of prose. One SQLite trap in there is worth carrying forward: `stripe_events.id` declares
  `PRIMARY KEY NOT NULL` because a bare `TEXT PRIMARY KEY` accepts NULL and NULLs compare distinct, so
  two `INSERT OR IGNORE` of a NULL id produced TWO rows and defeated the entire idempotency gate.
  `credit_grants.stripe_payment_id` is `NOT NULL UNIQUE` for the same reason, and it keys on the
  PAYMENT rather than the event because one payment can surface in more than one event type.
- Stripe delivery order is NOT guaranteed, and the ordering guard is ONE CLOCK PER FIELD on `tenants`
  (`billing_tier_at`, `billing_status_at`, `billing_dunning_at` + `billing_dunning_status`, added by
  `0004_billing_ordering.sql`). A handler passes a clock only with a field its event SUPPLIES: a
  subscription event carries a price so it supplies a tier, while `invoice.*` and
  `customer.subscription.deleted` carry none and merely restate the tier they read, so they must never
  touch `tierAt`. Reusing one clock for two fields, or reviving the old single `billing_event_at`
  gate, is the defect this replaced - a restating event that arrived first censored the older event
  that would have supplied the tier, and requirement 18 (a `past_due` tenant keeps its tier) broke on
  a pairing Stripe emits a second apart. `billing_event_at` is now AUDIT ONLY; nothing may gate on it.
  `status` is the FOLD of a lifecycle register and a dunning register, computed inside
  `upsertTenant`'s `ON CONFLICT` clause (so concurrent deliveries converge) - and a cancellation
  overrules an invoice at ANY timestamp while still losing to a later resubscription, which is why
  status needs two clocks and not one. Credit grants stay outside every clock. A stale event still
  PERFORMS its write; the clocks refuse the stale fields, which is what keeps the write-once buyer
  email from being lost when a checkout arrives late. Only
  `cloud/test/stripe-webhook.test.mjs`'s replay-convergence property catches a regression here -
  there is no type error and every example test still passes.
- The import edge is one way, `stripe.ts` -> `tenants.ts`. Anything derived from `TIERS` lives with
  `TIERS`: `isKnownTier` (hasOwnProperty, or `'toString'` reads as a tier), `usdPerCredit()` =
  `TIERS.starter.monthlyCostUsd / monthlyCredits` and `grantCostUsd(credits)` are all in
  `tenants.ts`. Never import `./stripe` from `tenants.ts` - that closes a module cycle around two
  load-time consts.
- One worker holds ONE `CLERK_SECRET_KEY`, and a token minted by one Clerk instance reads 401
  against another. So the key must match the publishable key the client build ships: a local
  `.dev.vars` takes the DEVELOPMENT `sk_test_` key pairing with
  `frontend/src/environments/clerk.ts` (and `admin/src/environments/environment.ts`), the deployed
  hosted worker takes PRODUCTION `sk_live_` pairing with the `.prod.ts` twins. `/status.json`
  CANNOT verify a rotation - its Clerk probe returns 200 for any valid key regardless of instance.
  `/api/me` with a production session token returning 200 is the only real check.
- **A production Clerk instance cannot sign anyone in on a CROSS-SITE origin.** The session cookie
  is first-party to the Frontend API's registrable domain, so any browser surface that needs a Clerk
  SESSION must be served from a `phorma-labs.com` subdomain. This is why `GET /auth/device` runs
  clerk-js on the worker's own origin rather than the studio's webview doing it, and why the telemetry
  dashboard is served from `telemetry-admin.phorma-labs.com` rather than its `workers.dev` origin -
  that origin loads clerk-js fine and then fails the sign-in attempt with `authorization_invalid`.
  Adding an origin to `ALLOWED_ORIGINS`, to `CLERK_AUTHORIZED_PARTIES` and to Clerk's allowlist is
  necessary but NOT sufficient; the domain has to be right first. Two probe traps: `GET /v1/environment`
  answers 200 for any origin at all, so "clerk-js loads" proves nothing, and a 422 from
  `POST /v1/client/sign_ins` only proves the origin is not allowlist-refused. `GET /v1/environment` is
  public and is the cheapest read of the instance's real config (Account Portal URLs,
  `after_sign_in_url`, `url_based_session_syncing`, `partitioned_cookies`).
- `CLERK_AUTHORIZED_PARTIES` is the JWT `azp` allowlist and is a hosted `var`, not a secret, so it
  must hold the SAME origin set as `ALLOWED_ORIGINS`: both dev servers (7322, 7323), the desktop
  build's webview origins (`tauri://localhost` on macOS and Linux, `http://tauri.localhost` on
  Windows and Android unless `app.windows.useHttpsScheme` is set, plus the `https://` form), and the
  deployed dashboard. `@clerk/backend` matches `azp` by exact string and skips the check entirely
  when the var is unset, so a missing origin is a hard 401 on every request from it rather than a
  degraded one. Changing a `var` takes effect only on the next `wrangler deploy --env hosted`.
- `cloud/.gitignore` globs `.dev.vars*` and `.env*`, with `!.dev.vars.example` as the single
  exception. Wrangler reads `.dev.vars.<env>` too, and with `--env hosted` it loads
  `.dev.vars.hosted` INSTEAD of `.dev.vars` (no merge), so a bare `.dev.vars` pattern would leave
  a real secret file committable.
- A deployed run resolves a connection secret from worker env FIRST, then from the `SecretVault`
  Durable Object (`POST /api/connection-secrets`, AES-GCM under `KEY_ENC_SECRET`, one instance per
  owner: `secrets:{ownerId}` hosted, `secrets:default` BYO - so an organisation's members share ONE
  vault and a credential stored by one colleague resolves on a run another one deployed). The vault is
  the only ingestion path a hosted tenant has, since `wrangler secret put` needs their own account.
  `MCP_*` bearers are still env-only. Spec: `.kiro/specs/deployed-credential-vault/`.
- Adding a Durable Object class means a binding + migration tag in `wrangler.jsonc` top level AND
  `env.hosted` AND `DeployConfigService`'s generated override, which REPLACES the committed config
  on every BYO deploy. `cloud/test/deploy-config.test.mjs` derives the expected class list from
  `src/index.ts`'s export statement and will catch a miss.

## Workflow backup (hosted only)

Spec: `.kiro/specs/cloud-workflow-backup/`. Metadata in D1 (`workflow_backups`, migration
`0005_workflow_backups.sql`), bodies in the `BACKUPS` R2 bucket (`phorma-backups`) under
`backup/{tenantId}/{workflowId}/{revision}`. `/api/backups/*` sits BELOW the `store.enabled` gate, so
the surface is ABSENT on a BYO worker rather than broken.

- Pipeline is `JSON -> gzip -> AES-GCM -> R2`, in that order: ciphertext does not compress, so
  reversing the two stores every workflow at full size forever. `encryptBytes`/`decryptBytes` in
  `tenants.ts` exist for this (bytes in, bytes out, same 12-byte-IV packing as `encryptString`) -
  pushing gzip through the string pair costs 1.78x in base64.
- No `KEY_ENC_SECRET` REFUSES the upload; a backup is never stored unencrypted. Phorma Labs holds
  the key, which is disclosed in-product beside the backup state with a one-click
  disable-and-delete-all. Passphrase E2E is rejected: a forgotten passphrase reproduces the loss.
- Concurrency is a conditional `UPDATE ... WHERE revision = ?` whose `meta.changes` is the
  single-winner signal - the same idiom `recordRun` uses, and for the same reason. `If-Match` absent
  is accepted ONLY for a workflow with no row; absent on an existing row is a 409, because nothing
  merges two specs. A 409 always carries the CURRENT revision so the loser retries against a truth.
- WRITES need `active` or `past_due`. READS survive a cancellation for 90 days
  (`lapseReadAccess`, clocked off `billing_status_at`; a clock of 0 means a hand-run
  `/api/deactivate` supplied none, and reads then stay allowed with no expiry rather than being
  destroyed on a value we never recorded). The tier cap (`TierLimits.backupWorkflows`, 25/100/250)
  bounds NEW workflows only - an existing backup must never go stale because of a limit.
- Four refusal codes, APPEND-ONLY like the entitlement ones: `no_subscription`, `backup_conflict`,
  `backup_cap`, `backup_too_large`.
- `runBackupRetention` rides the hosted `scheduled()` pass. Bodies go BEFORE the metadata row: the
  row is the only index of which R2 objects belong to a tenant, so the reverse order orphans them.
- Operator steps this code cannot do for itself: `npx wrangler r2 bucket create phorma-backups` and
  `npx wrangler d1 migrations apply phorma-cloud --env hosted --remote`.

## Workflow proposals (hosted only)

Spec: `.kiro/specs/multi-organisation-phorma/` Requirement 11. An editor's change is held as a
PROPOSAL and a builder's publish is what moves the deployed graph. Three modules:
`proposals.ts` (the wire contract, the pure decisions and the D1 `ProposalStore`),
`proposal-store.ts` (`ProposalBodyStore`, the R2 half) and `proposal-routes.ts` (`/api/proposals/*`).
Metadata is `workflow_proposals` from `0006_organisations.sql`; NO migration was added for it.

- `/api/proposals/*` sits ABOVE the `store.enabled` gate with its own TWO 404s, so BYO sees the
  surface as ABSENT rather than as a missing binding. That makes three placements in `api.ts` with
  three different answers: `/api/deployments` above and answering, `/api/backups` below and 501
  naming a binding, `/api/proposals` above and 404.
- **The single-pending invariant is a DATABASE constraint.** `idx_proposals_pending` is PARTIAL on
  `(owner_id, workflow_id) WHERE status = 'pending'`, so creation is ONE `DB.batch` that supersedes
  then inserts: a lost race violates the index and the whole batch rolls back. Every transition is a
  conditional `UPDATE ... WHERE status = ? AND revision = ?` whose `meta.changes` is the
  single-winner signal; zero changed rows is 409 `proposal_conflict` CARRYING THE CURRENT REVISION.
  A read-then-write here lets both reviewers through - mutation-verified, it answers "2 winners".
  The revision is therefore REQUIRED in the request body, never looked up server-side.
- Four refusal codes, APPEND-ONLY: `proposal_scope`, `proposal_stale`, `proposal_conflict`,
  `proposal_unencrypted`. The first two are declared with the set and answered by the publish work.
- Bodies are `JSON -> gzip -> AES-GCM -> R2` through `encryptBytes`/`decryptBytes`, in the EXISTING
  `BACKUPS` bucket under `proposal/{owner}/{workflow}/{proposalId}`. The PREFIX is the isolation:
  `BackupBodyStore.deleteTenant` scans `backup/{tenantId}/` and `prune`/`deleteWorkflow` enumerate
  `bodyPrefix`, so no backup destroy path can reach a proposal body and no backup read can serve one.
  No `KEY_ENC_SECRET` refuses `proposal_unencrypted` and stores NOTHING.
- **No code path from this surface to a `WorkflowAgent`**, and that absence is the whole of "an
  editor's change is a proposal": `ProposalRoutesEnv` does not even carry the binding. The one DO it
  reads is `PortalIndex.getDeployment`, for the live spec hash it FREEZES into the row - a registry
  read failure refuses 502 rather than freezing "nothing was deployed".
- Order: the row is claimed BEFORE the body is written, so a refused proposal stores nothing; a body
  write that fails after the row lands is 502 and a read of the missing body is 404, never 500.
- Retention keeps the ten most recent NON-PENDING rows per workflow and NEVER the pending one.
  `ORDER BY id` (the rowid), never `created_at` - two rows from one pass tie to the millisecond.
  `proposal_id` is what travels on the wire, so a rowid is never in a URL. ONE destroying path
  (`runProposalRetention`), named at each of its three call sites.
- Publishing is a SETTABLE SEAM (`ProposalPublisher`), not a call, and `api.ts` INSTALLS one built by
  `createProposalPublisher` (`proposal-publish.ts`). That is what lets both halves hold at once: the
  route still has no path to a `WorkflowAgent`, and a publish still runs the ordinary push path. With
  no performer installed the route answers 501 and leaves the row pending, because a `published`
  status recording a deploy that never happened is worse than a route saying it cannot yet - drive
  that case by calling `handleProposalRequest` with empty deps, not through the router.
- **ONE push path, two entrances.** `WorkflowAgent.applySpecPush(spec, fallbackOwnerId)` is private
  and holds the whole of it (validation against the same connection inventory, cron re-arm, owner
  stamp, `setState`, `syncDeployment`); `POST /workflow` calls it, and so does the public
  `acceptSpecPush(ownerId, spec)` RPC a publish uses. RPC and not `stub.fetch()` for the documented
  reason, and it re-checks the owner against the stamp and refuses a portal session instance exactly
  as `notificationsSince` does. It returns a `SpecPushOutcome` rather than throwing on a refused push,
  because "refused" is the case that leaves the proposal `pending`.
- Staleness is the publisher's, and its source is `PortalIndex.getDeployment().specHash` - written by
  `syncDeployment` on every accepted push, so it is the hash of what is really deployed and costs one
  storage read. A difference is 409 `proposal_stale` carrying the CURRENT hash; a registry read
  FAILURE is 502, never a staleness answer.
- **Scope is checked at CREATION, and the baseline is authenticated rather than trusted.**
  `scopeViolations(live, proposed)` (pure, in `proposals.ts`) treats the node id set, each node's
  `kind`, the edge set WITH its port wiring and the sub-workflow id set - plus the same three rules
  inside each sub-workflow graph - as STRUCTURE, and everything else as an editor's business. A
  caller below `builder` must send the deployed spec as `liveSpec`, and it is only used once
  `canonicalSpecHashOf(liveSpec)` equals the registry hash: that is how the check runs without waking
  a deployment (Requirement 11.10 stays intact). An absent baseline fails CLOSED with a 400 naming the
  field; a mismatched one is `proposal_stale`. A non-empty result is 403 `proposal_scope` NAMING each
  change, capped at `SCOPE_VIOLATIONS_REPORTED` with the true count beside it.
- The author's notification is an ADDITIVE `proposals` field on `NotificationsResponse`, filled by
  `ProposalStore.outcomesForAuthor(ownerId, authorUserId, since)` - a D1 read scoped by owner AND
  author, so a reviewer is never told about their own decision. It is a query rather than a fifth
  fan-out because the fact is in D1, and it degrades to absent on a BYO worker, an anonymous caller or
  a failed read rather than failing the deployment feed it rides along with.
- `WRITE_ROUTES` carries the three proposal writes FIRST, before the suffix-anchored Durable Object
  entries: `matchWriteRoute` returns the first match and `/\/publish$/` also matches
  `/api/proposals/{id}/{proposalId}/publish`. Both are `builder`, so nothing is mis-gated - the order
  is what keeps each entry answering the route it was written for.
- OPERATOR: `KEY_ENC_SECRET` must be set and `BACKUPS` must be bound, or proposals refuse and store
  nothing. No new secret, no new bucket, no new binding.

## Browser-facing pages (`cloud/src/brand-page.ts`)

Four pages land in an external browser during sign-in or checkout, and ALL of them render through
`brandPageDocument`: `GET /billing/return`, `GET /signed-in` (both `api.ts`), `GET /auth/device` and
its 503 `unavailablePage` variant (`device-auth-routes.ts`). Do not hand-write a fifth.

- The Phorma mark is an INLINE `<svg>`, never an `<img>` or a `<use href>`. Two pages answer
  `default-src 'none'` and the worker binds no `assets` directory, so an inline element is the only
  form that needs no CSP change and no binding - and these pages must render offline, in a webview,
  and on a BYO worker that binds nothing. `PHORMA_MARK_SVG` is a HAND COPY of
  `frontend/public/logo.svg` (`cloud/` cannot import from `frontend/`), so it is a structural twin:
  a brand change edits both. Its gradient ids are namespaced `phorma-mark-*` because an id in an
  inline SVG is document-global.
- `BRAND_PAGE_CSP` is the shared policy for the three pages that run no script. It adds exactly
  `img-src data:` over the old policy, for the favicon, which is a deliberately SIMPLIFIED flat mark -
  the real one's three gradients composite into a single smudge at 16px.
- The mark is the brand and the DOT is the state. Never tint the mark: a red logo reads as a broken
  logo, not an error. Every state also changes the heading TEXT, so the colour is a second signal.
- `state: 'none'` renders the mark with no dot, for a page reporting no request outcome (the 503).
- The `<h1>` holds TWO spans - the dot FIRST, then the text - so a script that rewrites the heading
  must target `BRAND_HEADING_TEXT_CLASS`. `#title span` matches the dot and writes the heading into an
  8px circle; it looks correct in the markup and is only visible in a screenshot.
- `cloud/test/billing-routes.test.mjs` asserts these pages reference NOTHING over the network -
  `data:` URIs only, every scheme and every path refused. Adding a remote reference is a deliberate
  decision that has to change that assertion.

## Public service status (`cloud/src/status.ts`)

`GET /status.json` and `GET /status.svg` are unauthenticated, edge-cached (30s) health routes that
phorma-labs.com renders as its footer indicator and `/status` page.

- Matched FIRST in `index.ts`, before the generic `OPTIONS` branch, because they answer with open
  CORS (`*`). Do not "fix" a cross-origin failure by adding the website to `ALLOWED_ORIGINS` - that
  widens the authenticated `/api/*` surface too.
- Ten components, each with a functional probe: WorkflowAgent DO, D1, KV, SecretVault DO,
  PortalIndex DO, R2, Clerk, OpenRouter, Stripe (`GET /v1/prices?limit=1`, catalogue objects only so
  no customer or balance data is ever in reach), telemetry store (D1 `telemetry_rollups`).
  `critical: true` on runtime, D1, KV, Clerk and OpenRouter. Billing is deliberately NOT critical: a
  Stripe outage stops new purchases, not tenants already running workflows, so it is amber. Its
  absent-key case is `unknown` in BOTH modes, unlike Clerk's - the billing routes already answer 501
  naming the secret, and a badge must not go amber for a catalogue that has not launched. It shares
  Clerk's blind spot: an `sk_test_` key against a sandbox is a healthy 200, so a test-vs-live mismatch
  is invisible here - the `sk_live_` prefix at go-live and a real session in the live Dashboard are
  the checks that prove it.
- Rollup: critical outage -> red, any degraded or non-critical outage -> amber, else green. An
  absent binding is `unknown` and is EXCLUDED, so a BYO worker never reads as broken.
- Always answers HTTP 200, even during an outage. A non-200 makes browsers and generic monitors
  report "unreachable" and throw away the detail we just gathered.
- Cloudflare's own status page is intentionally not consulted: its global indicator is almost never
  green, so it would pin the badge amber. Clerk's Statuspage (`/api/v2/status.json`) IS trusted for
  colour. OpenRouter has no public status JSON, so it gets a functional probe only.
- Probe `detail` strings are hand-written. Never forward a vendor body or an exception message -
  `status.test.mjs` asserts secrets and internal errors stay out of the payload.
- Operator banner without a deploy: put JSON at the `status:notice` KV key
  (`{status,message,until?}`). It can only make the rollup worse, never better.

## Release-adjacent code in cloud/

`cloud/src/releases.ts` serves the updater manifest. Prerelease comparison is SemVer dot-segment
numeric (`comparePrerelease`) - a plain string compare made `beta.10 < beta.9` and silently stopped
updates at the tenth beta. Changes here need a worker deploy, not just a release build.

Related skills: `.github/skills/cloudflare/agents-sdk/`, `durable-objects/`,
`workers-best-practices/`, `wrangler/`, `platform/`.
