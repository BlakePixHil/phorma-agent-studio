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

- `cloud/` must depend on the `ai` package - the `agents` SDK imports it dynamically and wrangler
  bundling fails with "Could not resolve ai" otherwise.
- Verify with `npm run check` (`tsc --noEmit` plus `wrangler deploy --dry-run`) AND `npm test`.
  `check` runs no tests, so it alone is not verification. No Cloudflare account needed.
  `npm test` = `test:unit`, 29 suites: projection, embed, deploy-config, connections, data-host,
  workflow-state, portal-cleanup, deployment-registry, notifications, run-wiring, status, releases, telemetry,
  tenant-billing, entitlement, stripe, billing-routes, billing-admin, stripe-webhook, provisioning,
  workspace-migration, backup-store, backup-body, backup-routes, plus four
  Miniflare suites (deploy-validation, connection-secrets, telemetry-ingest, telemetry-admin).
  `backup-store`, `backup-body` and `backup-routes` are D1/R2-proxy-backed like the billing family
  and sit at the END of the chain behind a `node test/await-port-drain.mjs` barrier.
  `tenant-billing`, `entitlement`, `billing-routes`, `billing-admin`, `stripe-webhook`,
  `provisioning` and
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
  `run_journal`, `usage_ledger`, workflow state, portal registry.
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
  `purgeSelf` and `startPortalTurn` are RPC. It re-checks `ownerId` and returns empty for a portal
  session instance.
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
- `CloudService.materializeDefaults()` bakes app-level defaults (default model, tool rounds) into the
  spec at push time, so no cloud change is needed when a new app default appears.

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
  which also owns `isOperator`, `noStoreResponder` and `readBearerToken`. There are two operator
  route families now - `/api/admin/telemetry/*` (`telemetry-admin.ts`) and `/api/admin/billing/*`
  (`billing-admin.ts`) - and both are mounted beside each other in `routeApiRequest`, ABOVE the
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
- `/api/admin/billing/*` is a SEPARATE prefix from the telemetry aggregates, not a sixth aggregate
  route, and the reason is a privacy contract rather than tidiness: telemetry bodies carry no
  `install_id` by construction and fold groups under five installs into `other`, while these bodies
  name identified paying tenants on purpose - "which account is cancelled but still holding a live
  key" is not actionable without the id. Two routes: `costs` (OpenRouter balance via
  `GET /api/v1/credits`, trailing-30-day burn from `usage`, runway, the committed ceiling summed over
  ACTIVE tenants, and the attention lists) and `revenue` (Stripe `/v1/invoices` for gross/tax/net plus
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
  and the shape is still assignable where `StripeRefusal` is expected. The five `code` tokens
  (`no_subscription`, `subscription_past_due`, `runs_exhausted`, `credits_exhausted`,
  `no_runtime_key`) are an APPEND-ONLY wire contract the studio branches on: add one, never rename or
  repurpose one. `past_due` must stay a distinct refusal from unsubscribed - the remedy is the billing
  portal, not a Subscribe CTA - and it deprovisions nothing, so a `past_due` tenant keeps tier, data
  and runtime key. The prose stays matchable too (`credits exhausted`, `subscription`), because an
  older studio falls back to a regex when the code is absent.
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
- `tenants.id` IS the Clerk user id, and `isClerkUserId` (`tenants.ts`) guards WRITE paths only:
  `/api/provision` and the two Stripe-supplied id paths. Never re-validate an id read out of
  `tenants` - rows hand-provisioned before that check can hold an id it rejects, and refusing to
  resolve one would strand a real payment. A bad id on a write creates an orphan row `/api/me` can
  never find, which is indistinguishable from a user who has not signed in yet.
- The billing schema is two migrations, both additive. `0003_billing.sql` carries the whole concern:
  `stripe_customer_id` / `stripe_subscription_id` on `tenants`, the PARTIAL unique index on the
  customer id (a plain UNIQUE enforces the same thing, the `WHERE` clause documents that an unmapped
  tenant is the steady state), the `idx_usage_tenant_run` repair that finally makes `recordRun`'s
  documented idempotency real, `stripe_events` and `credit_grants`. `0004_billing_ordering.sql` adds
  the per-field clocks. Both ARE now applied remotely (verified 2026-09-09 -
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
  owner: `secrets:{userId}` hosted, `secrets:default` BYO). The vault is the only ingestion path a
  hosted tenant has, since `wrangler secret put` needs their own account. `MCP_*` bearers are still
  env-only. Spec: `.kiro/specs/deployed-credential-vault/`.
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
