# Implementation Plan: multi-organisation-phorma

## Overview

Sixteen demoable increments across the six phases the requirements declare, using the same phase
numbers and the same phase names so one label never means two things. Every task lands a change that
can be shown working, carries its own tests, and names the verification commands that cover what it
touched.

Tasks 15 and 16 were added after the first draft, for Requirements 19 and 20, and keep their numbers
rather than renumbering eleven tasks and the dependency graph. Each one sits physically in the phase
that delivers it, exactly as Requirements 19 and 20 do in `requirements.md`, so document order and
numeric order disagree in two places and the phase heading is what carries delivery order.

Four ordering facts shape the plan and are not negotiable:

- **Phases 0 and 1 are inert.** With no organisation configured, every credential carries no org
  claim, so `resolveOwner` returns today's owner and `resolveRole` returns `admin` (Requirements 1.3,
  5.10), and the studio's `CapabilityService` starts at `admin`. That is what lets the owner seam, the
  capability contract, the Role_Gate and the studio seam all ship before any organisation exists, with
  byte-identical behaviour.
- **The migration is written once, in task 1, complete.** Wrangler records a migration as applied by
  FILENAME, so anything appended to `0006_organisations.sql` after it has been applied remotely
  silently never runs. Tasks 2, 10, 12, 13 and 15 consume tables that already exist and add NO
  migration; any schema change discovered later goes in `0007`.
- **A desktop install names its owner PER REQUEST, never in its token.** The `phd_` payload gains
  nothing, and an organisation named by the `X-Phorma-Owner` header is resolved only after the caller's
  membership is confirmed against `org_members` behind the cache `resolveRole` already uses
  (design section 2.5). That is what makes switching work on desktop without a re-sign-in and makes a
  revoked membership bite on the next request rather than after the token's 30-day TTL. It also makes
  `org_members` the AUTHORITATIVE membership and level source, with the Clerk role claim an
  optimisation for a browser credential - so "are custom Clerk organisation roles on our plan" is no
  longer on the critical path.
- **Task 16 carries the only irreversible step in the feature.** The IndexedDB v12 upgrade runs on the
  user's machine on first launch. Everything else rolls back with a worker deploy; this does not. Verify
  it against a store populated by the PREVIOUS build, never against an empty one.

Tasks marked **OPERATOR** contain a step this code cannot perform. Those steps are called out inside
the task rather than deferred to a release checklist.

---

## Tasks

### PHASE 0 - Owner identity

- [x] 1. The owner seam in the worker, with no behaviour change
  - **Objective:** separate "who is asking" from "whose data is this" in `cloud/src/auth.ts` and
    `cloud/src/tenants.ts`, and land the whole `0006` migration, with every observable behaviour
    unchanged because no organisation exists yet.
  - **OPERATOR, FIRST, before `readOrgClaim` is written:** verify the live Clerk claim layout with TWO
    tokens, not one. Read `GET /v1/environment` on the Clerk Frontend API for the instance's real
    configuration, then send a REAL production session token at `/api/me` and require 200 with the
    expected owner - once from an account IN an organisation, and once from a BRAND NEW account, which
    must carry no organisation claim and resolve its own owner (Requirement 1.14). An unread `org_id`
    claim is a silent failure: every member of every organisation resolves their PERSONAL owner, sees an
    empty workspace, and nothing logs an error. `/status.json` cannot verify any of this - its Clerk
    probe answers 200 for any valid key regardless of instance and reads no claims.
  - **OPERATOR:** enable Organizations in Clerk, and in the SAME sitting confirm that **personal
    accounts stay ENABLED** (Requirement 1.13). Per
    [Clerk's session tasks documentation](https://clerk.com/docs/authentication/configuration/session-tasks),
    an instance created after 22 August 2025 leaves the personal-account option DISABLED by default when
    Organizations is enabled, and a user is then required to choose an organisation after
    authenticating. In that configuration there is no such thing as a token with no organisation claim,
    so `resolveOwner`'s `?? auth.userId` branch, `resolveRole`'s `admin` default and this whole task's
    "no behaviour change" claim become unreachable - and a solo user who just downloaded the Studio
    cannot get past sign-in without being put in an organisation. Nothing logs an error when it happens;
    the second token in the check above is the only thing that catches it. Then establish whether custom
    organisation roles are available on our plan: if they are not, nothing degrades, because
    `org_members` is the authoritative source either way and `CLERK_ROLE_LEVELS` simply maps `org:admin`
    alone. If the session token template is customised, add the organisation claims to it.
  - **OPERATOR:** apply the migration with
    `npx wrangler d1 migrations apply phorma-cloud --env hosted --remote`, then verify with
    `npx wrangler d1 migrations list phorma-cloud --env hosted --remote` answering "No migrations to
    apply!". That command is the only trustworthy answer to "is it applied". The migration is additive,
    so it is safe to apply BEFORE the worker deploy.
  - Implementation:
    - `AuthContext` gains `orgId`, `ownerId` and `orgRole`, all additive. `kind` keeps its exact
      present meaning so `refuseNonOperator`'s `auth.kind !== 'clerk'` rule is untouched
      (Requirement 16.5).
    - `resolveOwner(auth)` returns `auth.orgId ?? auth.userId`. It is a function AND a cached field:
      `verifyBearer` fills the field by calling the function, so the expression is written once.
    - `readOrgClaim(payload)` reads the organisation id and the RAW role claim from whichever layout
      the verified instance emits, tolerates the other, and returns nulls rather than throwing for a
      token with neither. An org id with no role claim is NOT an error here; it becomes `role_unknown`
      at `resolveRole`, which is where fail-closed belongs.
    - `ownerIdIsAddressable(ownerId)` beside `resolveOwner`, not inside it, because a resolver that can
      return a refusal is a resolver every caller has to discriminate. Nothing truncates, escapes or
      rewrites the value.
    - `isOwnerId` beside `isClerkUserId` in `cloud/src/tenants.ts`, accepting `user_` and `org_`
      shapes. It inherits `isClerkUserId`'s documented asymmetry verbatim: WRITE paths only, never an
      id read back out of a row. `isClerkUserId` stays exported and stays narrower.
    - `resolveRole(env, auth)` returns `{ level }` or `{ unknown: true }`. `org_members` is the
      AUTHORITATIVE source, read behind the SAME KV cache shape `getTenant` uses
      (`orgmember:{orgId}:{userId}`, `expirationTtl: TENANT_CACHE_TTL_S` of 60, which is also KV's
      floor); the `CLERK_ROLE_LEVELS` claim mapping is consulted FIRST as an optimisation for a `clerk`
      credential and is not load-bearing. Neither source answering is `{ unknown: true }`. No new
      binding: the claim reader uses the Clerk secret already bound and the table read takes the
      existing `DB` and `TENANTS`. A `device` credential carries no role claim at all, which is why the
      table cannot be a fallback.
    - `cloud/src/device-auth.ts` is UNCHANGED. The `phd_` payload gains nothing, deliberately: a signed
      organisation id would leave a desktop install unable to switch without re-running the whole
      browser handoff, and would honour a revoked membership for up to the token's 30-day TTL, because
      lean v1 keeps no server-side record of a minted token to revoke.
    - Instead, `readRequestedOrg(request)` reads `X-Phorma-Owner` in ONE place and
      `resolveRequestedOwner(env, auth)` resolves it, returning the caller's own `userId` whenever the
      named organisation cannot be confirmed against `org_members` - which covers an absent header, an
      unparseable value and a real organisation the caller is not a member of, all three
      INDISTINGUISHABLE from outside, the same discipline the act-as header's three null cases follow
      (Requirements 1.6, 1.7, 20.10, 20.11).
    - Header naming is load-bearing: `X-Phorma-Owner` is a member naming their OWN organisation and is
      checked against membership; `X-Phorma-Act-As` (task 13) is an operator naming somebody else's and
      is checked against the allowlist. One header for both would make the difference between "my
      organisation" and "a customer's organisation" a property of who is asking rather than of what was
      asked.
    - `resolveOwner` stays SYNCHRONOUS and keeps reading `auth.orgId`. For a `clerk` credential
      `verifyBearer` fills that field from the verified claim; for a `device` credential it fills it with
      the subject's `userId` and the organisation is resolved one layer up, where a `TenantEnv` is
      available. Both paths write the same field, so no consumer below them branches on credential kind.
      Document the asymmetry ON `resolveOwner` rather than leaving the first caller to find it.
    - A `shared` credential IGNORES the header outright: BYO binds no `DB`, so there is nothing to check
      a membership against and nothing an organisation could mean.
    - `cloud/migrations/0006_organisations.sql` in full: `org_members`, `workflow_proposals` with its
      partial unique index, `ownership_claims`, `impersonation_audit`, and the nullable
      `workflow_backups.body_key` column. Carry `0003_billing.sql`'s END-OF-SCHEMA warning. Only
      `org_members` is read by this task; the rest exist so no later task has to append to an applied
      file.
  - Tests (`cloud/test/owner-identity.test.mjs`, new):
    - A token with NO org claim resolves exactly today's owner, and every observable outcome equals the
      pre-feature outcome (Property 2).
    - A token WITH an org claim resolves the org as `ownerId` and leaves `userId` as the subject
      (Property 1).
    - `ownerIdIsAddressable` refuses a colon-bearing owner and the request answers `owner_invalid`
      with nothing written under it (Property 1).
    - `isOwnerId` accepts both id shapes, refuses every other shape, and a stored row whose id it
      would reject still resolves on every read path (Property 3).
    - `readOrgClaim` tolerates both layouts and returns nulls for a token carrying neither.
    - `resolveRole` resolves from `org_members`, short-circuits on a mapped claim, and answers
      `{ unknown: true }` when neither source has an answer.
    - A `device` token naming an organisation it IS a member of resolves that organisation; naming one it
      is NOT a member of resolves its own `userId` with NO refusal and a response identical to the same
      request without the header; and a membership deleted between two requests changes the second
      request's resolved owner (Property 40's server half, Requirements 20.10, 20.11).
    - A `shared` credential with the header set resolves the `default` owner exactly as without it.
    - A `device` credential keeps its `kind` and is still refused at every operator surface regardless
      of owner (Property 35).
    - The suite is D1-backed (the `org_members` fallback), so it goes LAST in `test:unit` behind
      `node test/await-port-drain.mjs`, through `withLoopbackRetry` and `withLoopbackRetryD1`, with
      per-iteration setup batched via `DB.batch([...])`. The JWT is locally minted RS256 verified
      against `CLERK_JWT_KEY`, and `registerHooks` redirects `cloudflare:workers`, so authorization is
      never stubbed.
    - `.github/workflows/ci.yml` and `cloud/package.json`'s `test:unit` chain are updated in the SAME
      change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `node scripts/check-deploy-bundle.mjs`
  - **Demo:** the full cloud suite green and unchanged, plus a new unit test showing an org-claim token
    resolving an org owner.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14, 5.8,
    16.1, 16.2, 16.5, 16.6, 18.1, 18.6, 20.10, 20.11_

- [x] 2. Org-scoped addressing and the ownership claim path
  - **Objective:** two independent isolation layers over the resolved owner, and a one-time claim that
    moves a pre-pivot personal deployment into an organisation.
  - Implementation:
    - `cloud/src/index.ts`: the 401 becomes `if (!auth || !resolveOwner(auth))`, `prefix` becomes
      `${resolveOwner(auth)}:`, and `ownerIdIsAddressable` gates both. The 403 branch keeps its exact
      shape, including the property that matters most: it returns BEFORE `routeAgentRequest`, so a
      foreign organisation's instance is never woken.
    - `WorkflowAgent.enforceOwnership` compares `resolveOwner(auth)` instead of `auth.userId`, and the
      first-push stamp becomes `this.state.ownerId ?? resolveOwner(auth)`. The WebSocket upgrade path
      inherits both with no new code, and the 101 response is never re-wrapped.
    - `purgeSelf` already preserves the stamp. No code change, and a test pins it because the line
      reads like housekeeping.
    - New `cloud/src/ownership-claim.ts` mounted immediately after `handleDeploymentsRequest` and ABOVE
      the `store.enabled` gate, with its own two refusals as its first two lines: `!isHosted(env)` is
      404 and `!new TenantStore(env).enabled` is 404. It cannot sit below the gate, which answers 501
      naming a missing binding. `deployments.ts` stays a read.
    - `POST /api/deployments/{workflowId}/claim`: `verifyRequest`, then Role_Gate at `builder` for the
      NEW owner, then the `claimOwnership(actingUserId, newOwnerId)` RPC. The Role_Gate is task 5's
      `requireCapability`, so task 5 lands FIRST (see the dependency graph) and this task never
      hand-rolls a second capability check - Requirement 6.2 wants one seam, and a route with its own
      check is how two gates start disagreeing.
    - Add the claim route's `WRITE_ROUTES` entry at `builder` in THIS task, beside the route itself, and
      extend `cloud/test/role-gate.test.mjs`'s runtime drive to cover it. A table entry for a route that
      does not exist yet would 404 under that drive, which is why the entry travels with the route
      rather than with the table. The instance decides: no
      stamp is `claim_unowned`, a stamp that is not the acting USER id is `claim_not_owner` (the
      comparison is against the acting user, not the resolved owner, because moving a personally-owned
      deployment is the whole point), a stamp equal to the new owner is the idempotent success.
    - Before the DO write, pre-check the one collision that can half-apply a claim:
      `workflow_backups` has PK `(tenant_id, workflow_id)`, so
      `SELECT 1 FROM workflow_backups WHERE tenant_id = ? AND workflow_id = ?` and refuse
      `claim_conflict` rather than discover it mid-transfer.
    - The replace is one `setState({ ...this.state, ownerId: newOwnerId })`, so there is no observable
      moment with two stamped owners or none. The registry move runs AFTER it and reads
      `this.state.ownerId` fresh.
    - Registry move is write-then-remove: `registerDeployment` under the new owner first, then
      `deregisterDeployment` of the old. A failure between the two leaves a visible DUPLICATE that a
      later backfill or push corrects; the reverse order leaves NO record, which is invisible and is
      the exact defect the registry exists to close. Both calls are already idempotent, so a retry
      converges.
    - The `body_key` column (already in `0006`) is now read: `BackupBodyStore` uses
      `record.bodyKey ?? bodyPrefix(record.tenantId, record.workflowId)`, so a NULL reads as the derived
      legacy value and no backfill is needed. A claim changes `tenant_id` and leaves `body_key` alone,
      so no R2 object is ever rewritten.
    - The two row transfers run as ONE `DB.batch([...])` over `workflow_backups` and `usage`. `quotas`
      rows are deliberately NOT moved: they are a `(tenant_id, month)` rollup and moving history would
      rewrite a billing period that has already been charged.
    - One `ownership_claims` row per accepted claim. Unlike the impersonation audit, a failed write
      here logs and does NOT refuse: the move has already happened, and the row is reconstructible
      from the registry.
    - Portal session instances stay out of organisation ownership. The four existing early returns in
      `syncDeployment`, `removeDeployment`, `backfillDeployment` and `notificationsSince` already do
      it; a test pins them.
    - No migration. `0006` already carries `ownership_claims` and `body_key`.
  - Tests (`cloud/test/organisation-isolation.test.mjs` and `cloud/test/ownership-claim.test.mjs`, new):
    - A foreign org is 403 at the gateway and NO Durable Object is instantiated (Property 4).
    - A case that reaches the instance WITHOUT the gateway in the path, by a foreign-prefixed name
      under the wrangler `--dry-run` bundle plus the Miniflare harness-module pattern
      (`modulesRoot` plus an ESModule harness re-exporting `WorkflowAgent`, `PortalIndex` and
      `SecretVault`), asserting `enforceOwnership` refuses ALONE. If the assertion can only be made
      with the gateway present, it is asserting the gateway.
    - The WebSocket upgrade path refuses a foreign owner and closes `4001` (Property 4).
    - `purgeSelf` preserves the stamp, so a purged instance cannot be adopted (Property 5).
    - An accepted claim moves the stamp, the registry record, the backup metadata rows and the usage
      rows, leaves the row count unchanged, and leaves the R2 key set byte-identical with every body
      still readable at its original key (Properties 8, 9).
    - `claim_unowned`, `claim_not_owner` and `claim_conflict` each refuse and leave the stamp, the
      registry and every D1 row unchanged (Property 7).
    - A repeat claim is a no-op success with no second audit row (Property 8).
    - Concurrent claims against one instance: exactly one succeeds and every observed read of the stamp
      returns exactly one owner (Property 8).
    - A portal session instance gets no registry record and an empty `notificationsSince` payload
      (Property 6).
    - Both suites are D1-backed and join the tail behind `node test/await-port-drain.mjs`, through
      `withLoopbackRetry` / `withLoopbackRetryD1`, with `DB.batch([...])` setup.
    - `.github/workflows/ci.yml` and `test:unit` updated in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `node scripts/check-deploy-bundle.mjs`
  - **Demo:** push a workflow as yourself, claim it into an organisation, address it org-scoped, and a
    second organisation gets 403 at both layers.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7,
    3.8, 3.9, 3.10, 3.11, 3.12, 4.7, 16.2, 18.1, 18.5, 18.6_

- [x] 3. Org-scope the remaining owner consumers
  - **Objective:** every surface that answers "whose data" resolves the same owner, so no route
    silently addresses a member's personal account.
  - Implementation:
    - `secretVaultName` becomes `secrets:{ownerId}`, and `POST /api/connection-secrets` writes into the
      resolved owner's vault. A browser editor submits a value with no operating system keychain in the
      path.
    - `deploymentOwner(resolveOwner(auth))` for the deploy registry, so `GET /api/deployments` lists
      only the caller's owner's records. `WorkflowAgent` stays the only writer of the `deploy:` key
      space.
    - `GET /api/notifications` fans out over the resolved owner's registry records only, and
      `notificationsSince` re-checks the passed owner against the stamp and returns an empty payload on
      a mismatch.
    - `/api/backups` and `bodyKey` resolve the owner; `usage` rows, the usage ledger, `quotas` and
      `credit_grants` all key on the owner, so one `tenants` row per owner is the single quota bucket
      and a member's run draws from the organisation's grant pool.
    - `/api/provision` accepts an organisation owner. The Stripe `client_reference_id` keeps carrying
      `auth.userId` and NOT the resolved owner, because self-serve checkout is refused for an
      organisation owner entirely (task 15, Requirement 19.4) - an organisation is invoiced by Phorma
      Labs, so an `org_` id can never legitimately reach Stripe.
    - Move exactly ONE `isClerkUserId` write-path call site to `isOwnerId`: `/api/provision` in
      `cloud/src/api.ts`. The three call sites in `cloud/src/stripe-webhook.ts` - the session
      `client_reference_id` and the customer `metadata.clerk_user_id` inside `resolveTenant`, plus the
      delayed-payment branch that reads `client_reference_id` alone - deliberately STAY narrow. An
      earlier draft of this plan moved all four, which was right only while an organisation could buy a
      subscription; it cannot, so widening a classifier on a third-party-supplied input buys nothing and
      broadens what an inbound value may claim.
    - BYO mode behaves exactly as before throughout: a `shared` credential resolves the `default` owner
      through the paths that already fold to it.
  - Tests:
    - Extend the existing D1-backed suites (`provisioning`, `stripe-webhook`, `tenant-billing`,
      `backup-routes`, `notifications`, `connection-secrets`, `deployment-registry`) so each surface
      returns one organisation's rows and never another's: `GET /api/deployments`,
      `GET /api/notifications`, `GET /api/backups` and the vault entry list each equal exactly the
      caller's owner's subset, no extra entry and no omitted entry (Property 10).
    - An interleaving of runs by several members of one organisation produces a usage rollup and a grant
      draw that both resolve to the organisation, and the rollup equals the sum over the runs
      independently of which member acted (Property 11).
    - An explicit assertion that `/api/provision` accepts an `org_` id, that all THREE
      `stripe-webhook.ts` paths still REFUSE one, and that `isClerkUserId` is still exported and still
      narrower. The refusal assertions are the load-bearing half: they are what would fail if somebody
      later "finished" the widening.
    - A BYO-shaped case per surface asserting pre-feature behaviour (Property 37).
    - Any NEW D1-backed suite goes LAST in `test:unit` behind `node test/await-port-drain.mjs`, through
      `withLoopbackRetryD1`, with per-iteration setup batched via `DB.batch([...])`, and is added to
      `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
  - **Demo:** provision an organisation, deploy into it, and see deployments, notifications, usage and
    backups all org-scoped with the user's own personal data untouched.
  - _Requirements: 1.9, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 10.6, 18.6_

- [x] 15. Personal and organisation billing stay separate
  - **Objective:** a personal account keeps the self-serve billing it has today, an organisation is
    invoiced by Phorma Labs and never reaches Stripe, and neither can absorb the other. Requirement 19,
    delivered in Phase 0 because it is the billing half of "whose data is this".
  - Implementation:
    - One refusal at the TOP of `POST /api/checkout` and `POST /api/billing-portal`, before the
      catalogue lookup and before any Stripe call: `if (auth.orgId) return respond({ error, code:
      'billing_managed' }, 403)`. Placed there rather than in the Role_Gate for a reason worth stating
      in the code: an organisation admin resolves `admin`, so a gate that only compared LEVELS would
      admit them. The refusal is about which owner is paying, not about what the caller may do.
    - `billing_managed` joins the append-only Refusal_Code set, and `WRITE_ROUTES` records the two
      billing routes as `admin` PLUS the personal-owner condition, so the table does not read as though
      the level were the whole gate.
    - An organisation reaches an entitled state through the Super_Admin path alone: `/api/provision`
      (already `isOwnerId` from task 3) writes the tier verbatim and forces `status: 'active'`, with no
      Stripe object anywhere. That is exactly what it does for the sales-led enterprise tier today, and
      its header comment already calls itself manual billing - so this task adds no mechanism, it names
      the one that exists as the intended path for an organisation.
    - NO credit grant without a Stripe payment. `credit_grants.stripe_payment_id` is `NOT NULL UNIQUE`,
      which is what makes a grant idempotent on the payment rather than the event, and a comp-credit path
      would have to weaken that. An organisation that needs a higher ceiling gets a TIER change, which
      `reconcileRuntimeKey` already turns into a limit patch on the existing OpenRouter key rather than a
      second key (Requirement 19.10).
    - Nothing transfers, in either direction, on any path. The claim route (task 2) already moves
      `workflow_backups` and `usage` rows only; extend the comment there to name `tenants`,
      `credit_grants` and `stripe_customer_id` alongside `quotas` as deliberately NOT moved, for the same
      reason: they record a billing period already charged to somebody.
    - Studio: one computed on `PhormaCloudService`, `selfServeBilling`, true only when the active owner
      is the personal account. It has to reach ALL FIVE Subscribe CTAs (Settings > Models, agent config,
      the Ctrl+P palette, and the two in assistant chat), the plan cards, and the credit packs - today
      only the Settings > Cloud panel gates on the deploy target, and the other four gate on the chosen
      model provider or on `subscribed()` alone, so four of the five are currently reachable on a BYO
      deploy target too. ABSENT, never refused: a disabled Subscribe button reads as broken.
    - While an organisation owner is active, Settings > Cloud renders the plan and remaining credits
      READ-ONLY and names Phorma Labs as the party that manages billing, so the missing action is legible
      (Requirement 19.8). Tabler icons only, no new SCSS, and no `p-dialog`.
    - `frontend/src/app/core/billing-refusal.ts` maps `billing_managed` to the `contact-support` remedy,
      so the one place refusal copy lives keeps answering for every code.
  - Tests:
    - `POST /api/checkout` and `POST /api/billing-portal` with an organisation-resolved caller answer 403
      `billing_managed`, and NO Stripe request is made - assert on the absence of the outbound call, not
      only on the status, because a refusal that still created a Customer is the failure that matters.
    - The same two routes with a personal owner behave byte-identically to today, including the
      `past_due` routing and the 404 for a tenant with no Stripe customer.
    - Property: no sequence of provisioning writes, Stripe events, grants, runs or claims makes a tier,
      status, grant, quota rollup, runtime key or Stripe customer of one owner observable as the other's,
      and a member's entitlement decision is a function of the ORGANISATION's row alone (Property 39).
    - An organisation tenant provisioned with a tier runs a workflow and is metered against the
      organisation, with no Stripe object in the database.
    - `settings-dialog.billing.spec.ts` gains a second parameterisation over the SAME five surfaces and
      five actions it already enumerates for BYO, this time for an active organisation owner, requiring
      zero of them.
    - Any new cloud suite goes LAST in `test:unit` behind `node test/await-port-drain.mjs`, through
      `withLoopbackRetry` / `withLoopbackRetryD1`, with `DB.batch([...])` setup, and into
      `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `cd frontend; npm run build`
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
  - **Demo:** a personal account subscribes through Stripe exactly as today; the same build, switched to
    an organisation, shows the organisation's plan and credits with every purchase action absent, and the
    worker refuses a hand-rolled checkout call with `billing_managed`.
  - _Requirements: 4.12, 6.6, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.11, 19.12,
    16.2, 17.4, 18.1_

---

### PHASE 1 - The capability contract and its enforcement

- [x] 4. The capability contract as a twinned pair
  - **Objective:** four named capability levels whose ordering is derived from their capability sets,
    declared independently in the worker and the studio.
  - Implementation:
    - `cloud/src/capabilities.ts` and `frontend/src/app/core/capabilities.ts`: `CapabilityLevel`
      (`operator`, `editor`, `builder`, `admin`), `CAPABILITY_LEVELS` for display order only, the
      `Capability` token union, and `CAPABILITIES_BY_LEVEL`.
    - The level sets are CUMULATIVE BY CONSTRUCTION: `editor` spreads `operator`'s array, `builder`
      spreads `editor`'s, `admin` spreads `builder`'s. Requirement 5.6 is then a property of the table
      rather than a claim about it.
    - `capabilitiesOf`, `holds`, and `atLeast` by SET INCLUSION rather than an index lookup, so a level
      added later is automatically correct and a missing capability in a higher level becomes a FAILING
      comparison rather than a silently wrong one.
    - Named tokens, never a numeric ladder: an ordinal persisted in an `org_members` row, cached in KV
      or held in an older studio means something different the day a level is inserted, silently, with
      no type error. A number in a refusal body or an audit row is also unreadable.
    - `CLERK_ROLE_LEVELS` maps a raw claim value to a level, in the worker copy.
    - Add both files to the structural twins list in `.kiro/steering/structure.md` in the SAME change.
  - Tests:
    - `cloud/test/capabilities.test.mjs` under `tsx` with `fast-check` 4.9.0, and the karma equivalent
      for the studio twin.
    - Property: `atLeast(a, b)` holds exactly when every capability of `b` is a capability of `a`; the
      display order agrees with the inclusion order; and for every adjacent pair the higher set is a
      STRICT superset (Property 12).
    - Each property is PAIRED with cases pinning actual CONTENTS, because a shape-only claim holds for
      an empty set: assert `graph.structure` present in `builder` and absent from `editor`,
      `member.manage` present in `admin` only, and `run.trigger` present at every level.
    - Never mirror `CAPABILITIES_BY_LEVEL` into a spec as an oracle; that is a shared-bug tautology.
      Where a count is needed, derive it by calling the function under test with a narrowed input.
    - Assert the twins declare identical token sets, so a one-sided change fails (Property 36).
    - Mutation-check the suite: a property that survives deleting one capability from a higher level's
      array is not testing Requirement 5.6. Read the file with `[IO.File]::ReadAllText($absolutePath)`,
      `.Replace()` one realistic bug, run the targeted suite, restore the exact original text.
    - New suites go into `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `cd frontend; npm run build`
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
  - **Demo:** unit tests over the full permission matrix, both copies.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.11, 16.3, 16.4, 18.1_

- [x] 5. Server-side role enforcement
  - **Objective:** one seam every write passes through, and a suite that fails when a new write route
    is not covered.
  - Implementation:
    - `cloud/src/role-gate.ts` exporting `AuthorizedCaller` and
      `requireCapability(env, auth, required, respond)`, discriminated with `'level' in result` - the
      same idiom `resolveHostedInference` established with `'status' in gate`, so no cast is needed.
    - Three refusals, in this order: impersonation-write first (the field exists now and is wired in
      task 13), then `role_unknown`, then `role_forbidden` naming the required level in the body. The
      impersonation refusal is FIRST on purpose, so an operator who also holds a real membership cannot
      write through the header.
    - `WRITE_ROUTES` and `requiredLevelFor(method, path)` as DATA, in exactly one place.
      `requiredLevelFor` answering `undefined` for a MUTATING method is itself a failure and the gate
      refuses rather than passing, so an unguarded new write route is broken-closed at runtime.
    - The table covers every write route that EXISTS when this task lands. A route this feature adds
      later brings its own entry with it (the ownership claim in task 2, proposal publish and reject in
      task 10), because the runtime half of the suite drives each entry against a real route and an
      entry with no route behind it would 404.
    - The two billing routes are recorded as `admin` PLUS a personal-owner condition, because an
      organisation admin resolves `admin` and the level is therefore not what refuses them - task 15
      owns the `billing_managed` refusal, and the table must not read as though the level covered it.
    - The `/api/admin/*` families are NOT Role_Gate routes and must be EXEMPT from the static scan by
      name, not by accident. They are gated by `refuseNonOperator`, which answers a different
      401-versus-403 split and hands back no identity, so `requiredLevelFor` answering `undefined` for
      `POST /api/admin/organisations` is correct rather than a miss. Write the exemption as an explicit
      allowlist with a reason per entry, the way `check-telemetry-isolation.mjs` does, so a new
      non-admin write route cannot slip through by resembling one.
    - `resolveCaller` as the THIRD step in `WorkflowAgent.onRequest`, after `authorized` and
      `enforceOwnership`, resolving the level ONCE per request so a route with two checks costs one KV
      read. Each write branch then opens with one line:
      `if (!atLeast(caller.level, 'builder')) return roleForbidden('builder');`
    - Do NOT derive the required level from the path inside the DO. Two route tables for one dispatch
      is how one of them starts admitting what the other refuses.
    - Reads stay open to every level, `operator` included. The boundary this feature defends is BETWEEN
      organisations, not within one.
    - An unresolvable role fails CLOSED with `role_unknown`, never a substituted `operator`: `operator`
      can trigger a run, which spends the organisation's credits, so there is no safe minimum.
    - A credential with no organisation claim resolves `admin`, which is what lets the gate go on every
      write route in one change without gating anything that works today.
  - Tests (`cloud/test/role-gate.test.mjs`, new, both halves required):
    - Runtime: drive every `WRITE_ROUTES` entry with an operator-level token and assert 403
      `role_forbidden` with the required level named, then with the declared level and assert it is NOT
      403. Cover `POST /workflow`, `DELETE /workflow` and `POST /api/connection-secrets` explicitly, and
      assert 200 on the reads and on the monitor (Property 14).
    - Static: scan `cloud/src/api.ts` and `cloud/src/workflow-agent.ts` for mutating method and path
      literals and fail on any that `requiredLevelFor` does not answer. Copy the comment and
      template-literal stripping and the "no matches found means the parser broke" vacuous-pass guard
      from `scripts/check-telemetry-isolation.mjs`. This is what makes a new unguarded write route fail
      the suite.
    - A builder-level token passes the builder routes; an `operator` is accepted on trigger, events,
      approvals and questions (Property 14).
    - An organisation claim with an absent or unrecognised role and no `org_members` row is
      `role_unknown` with nothing written (Property 13).
    - Locally minted RS256 JWT verified against `CLERK_JWT_KEY`, so authorization is never stubbed,
      with `registerHooks` redirecting `cloudflare:workers` before the module graph loads. D1-backed,
      so the suite joins the tail behind `node test/await-port-drain.mjs`, through the loopback retry
      wrappers, with `DB.batch([...])` setup.
    - `.github/workflows/ci.yml` and `test:unit` updated in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `node scripts/check-deploy-bundle.mjs` (this task adds a file under `cloud/src/`)
  - **Demo:** two tokens differing only in role get different answers from the same routes, with no
    studio involved.
  - _Requirements: 5.9, 5.10, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 6.10, 6.11, 8.5, 13.1, 13.2,
    16.2, 18.1, 18.5, 18.6_ (Requirement 6.6's personal-owner half and Requirement 13.7's
    no-organisation-facing-route assertion land in tasks 15 and 12 respectively.)

- [x] 6. The studio capability seam and its guard
  - **Objective:** one dependency-injection leaf holding the resolved level, subtractive panel
    registration, and a CI guard that fails on a capability read outside the module.
  - Implementation:
    - `frontend/src/app/core/capability.service.ts` injecting `ClerkService` and NOTHING else. It is
      read by `PanelRegistryService` at startup, so it must not reach the known NG0200 cycle
      (`RunControllerService -> ModelTransportService -> PhormaCloudService -> CloudService ->
      RunControllerService`): no `CloudService`, no `PhormaCloudService`, no `WorkflowService`.
    - The level arrives through a settable `resolveFrom(level)` seam, PUSHED by whoever already holds
      the verified `/api/me` answer, because `ClerkService` never loads a user on desktop and desktop is
      where builders work. Same idiom as `RunControllerService.remoteApprovalSender` and
      `NotificationCenterService.deepLinkHandler`, and it makes "recompute without a page reload" a
      single signal write.
    - The initial value is `admin`, so an install with no organisation has every capability it had
      before and no surface flickers into a restricted shape on startup.
    - `/api/me` gains two ADDITIVE fields, `ownerId` and `level`, so an older studio ignores them and an
      older worker omitting them leaves the studio on its `admin` default.
    - One filter seam on the service, `allows(minLevel?: CapabilityLevel)`, which applies the
      absent-means-`operator` default INSIDE the capability module. Never `?? 'operator'` at a call
      site: that is a level literal outside the module, which Requirement 7.4 forbids and the guard
      below fails on. Both the panel filter and the action filter (task 7) go through it.
    - `PanelTab` gains `minLevel?: CapabilityLevel`; `DEFAULT_TABS` declares it on `evals`,
      `connections`, `portal` and `skills` at `builder`. The filter is
      `this.capability.allows(t.minLevel)` and goes in the `leftTabs` / `rightTabs` COMPUTED, never in
      `_tabs`: `loadTabs()` merges saved side, order and visibility onto
      `DEFAULT_TABS` and persists `_tabs` through an effect, so removing an entry from `_tabs` would
      drop it from the saved layout and a member promoted to builder would lose their arrangement.
    - `scripts/check-capability-isolation.mjs` modelled on `scripts/check-telemetry-isolation.mjs`: the
      import allowlist for `capability.service.ts` (`@angular/core`, `ngx-clerk`, `./capabilities`) with
      a reason per entry and the pruning rule that an unused allowlist entry also fails, plus the token
      scan for a `CapabilityLevel` literal in a COMPARISON POSITION (an `if`, a ternary, a `case` label,
      a `??` or `||` default, or an argument to `atLeastLevel` / `allows`) anywhere under
      `frontend/src/app/` outside `core/capabilities.ts`, `core/capability.service.ts` and their specs.
      A `minLevel:` DECLARATION is PERMITTED and must be: `DEFAULT_TABS` and every action entry declare
      one, and a declaration is data while a comparison is a decision. Keep the comment and
      template-literal stripping and the vacuous-pass guard: zero specifiers found means the parser
      broke, not that the file is clean.
    - Add the guard to `.github/workflows/ci.yml` in the SAME change.
  - Tests:
    - `capability.service.spec.ts`: the `admin` default, resolution through `resolveFrom`, and
      `cloudLibraryOnly` below `builder`.
    - `panel-registry.service.spec.ts`: tab registration changes with the level, a filtered tab is
      STILL in `_tabs` and still persisted, and a promotion restores the user's arrangement
      (Property 15).
    - A level change recomputes every derived surface with no reload, and applying the same level twice
      changes nothing (Property 16).
    - A deliberately planted violation (a `'builder'` comparison in a component) proves the guard fails,
      then is removed.
    - New specs and the new guard go into `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd frontend; npm run build` and read the reported `initial` figure against the 3MB error
      threshold; the current figure is 2.87MB, so there is about 130kB of headroom. `ng serve` and
      `tsc` do NOT evaluate budgets.
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-capability-isolation.mjs`
    - `node scripts/check-telemetry-isolation.mjs`
    - `cd cloud; npm run check` and `cd cloud; npm test` for the `/api/me` fields.
  - **Demo:** switching the resolved level changes sidebar composition with no component-level
    conditionals, and the guard catches a planted role read.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 18.1, 18.2, 18.3, 18.7_

- [x] 7. Capability-gate the studio action registry
  - **Objective:** one field per action entry, and the Agent-mode tool list, the plan operation set and
    the system prompts all narrow by derivation.
  - Implementation:
    - `StudioAction` gains `minLevel?: CapabilityLevel` (absent reads as `operator`), declared on every
      entry across `eval-actions`, `run-actions`, `prompt-actions`, `workflow-actions`, `skill-actions`,
      `connection-actions`, `portal-actions`, `usage-actions`, `settings-actions` and `graph-actions`.
    - `StudioActionRegistryService.available(access)` adds one clause on
      `this.capability.allows(action.minLevel)` - the same seam the panel filter uses, so the
      absent-means-`operator` default stays inside the capability module and no level literal appears
      here. Nothing downstream changes:
      `toolDefinitions`, `summarizeActions` and `plan-op.ts`'s apply path all read `available()`.
    - `execute()` re-checks the level and returns `actionFail` with one sentence, so a model naming an
      id it was not offered is refused at dispatch as well as omitted from the list. Same
      defence-in-depth shape as the existing `options.readOnly` check for Ask mode.
    - `risk` and `minLevel` are ORTHOGONAL. Confirmation tiers are unchanged: a builder still confirms a
      deploy, and a capability refusal is not a confirmation.
    - Plan apply composes with the existing subscription gate through
      `WorkflowBuilderService.canAutoApply` rather than replacing it.
    - An action service still injects neither `WorkflowBuilderService` nor `AssistantChatService`; the
      registry sits downstream of both.
    - The worker re-gates every action that reaches a route, so an omitted `minLevel` is a UI defect and
      never a security one.
  - Tests:
    - The derived tool list at `operator` excludes every write action and includes the reads, and at
      `builder` includes everything at or below it: the visible set equals EXACTLY the allowed subset,
      no extra entry and no omitted entry, while the registry index still contains every entry
      (Property 15).
    - The plan apply path is absent below `builder` (Property 15).
    - `execute()` refuses an action above the level even when the id is supplied directly.
    - The confirm dialog is presented exactly when `risk` is `confirm` and the capability refusal occurs
      exactly when the level is below the minimum; neither field changes the other's behaviour
      (Property 17).
    - New specs are added to `.github/workflows/ci.yml` in the SAME change if they land in a new file.
  - Verification:
    - `cd frontend; npm run build`
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-capability-isolation.mjs`
  - **Demo:** the assistant offers an operator only read actions while the same build offers a builder
    everything.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 18.7_

---

### PHASE 2 - Member surfaces

- [x] 8. Cloud library mode
  - **Objective:** a member with no local data opens their organisation's deployed workflow on the
    canvas, read-only, in a browser.
  - Implementation:
    - List from `GET /api/deployments` through the EXISTING `DeploymentsService`, which already pins
      `DEPLOY_TARGETS.phorma` and goes through `dispatchCloudOperation`. No second transport, no second
      model, and `DeploymentSummary` stays the twin of `cloud/src/deployments.ts` it already is.
    - Open by reading `GET /workflow` off the instance. It needs no redaction: a `WorkflowSpec`
      references credentials by NAME and the values live in the `SecretVault` or worker env, and
      authentication and ownership are enforced two seams above the branch.
    - `WorkflowService.openDeployedSpec(spec)` shaped like `openVersionSnapshot`, with
      `workflowId: spec.id` PRESERVED and `readOnly: true`. This is RESTORE-shaped in identity, not
      import-shaped: `importSpec` mints a fresh id because a file import is a copy, while an editor's
      proposal is keyed on the deployed workflow id and a builder's publish pushes back to that
      instance. An import-shaped open would produce a proposal against a workflow id that does not exist
      in the cloud.
    - It is snapshot-shaped in PERSISTENCE: never calls `storage.saveWorkflow`, never touches
      `libraryState`, and writes no spec, prompt body or connection secret value to IndexedDB or
      `localStorage`. The stores are workflow-keyed by `workflowKey`, so "do not write" is the whole
      mechanism and there is no scoping to get wrong.
    - `readOnly: true` is the existing immutability rail and needs no new enforcement: `mutateGraph`,
      `renameActive`, `describeActive`, `updateSettings` and `saveActive` already return early on it,
      and `CloudService.pushWorkflow` already refuses a read-only active document.
    - No keychain path. Connection secret values go to `POST /api/connection-secrets`. The gate is
      explicit even though the keychain is already behind `TauriService.isDesktop`, so a builder on
      desktop who is an editor elsewhere cannot write that organisation's credential into their own
      machine's keychain. The desktop keychain contract is UNCHANGED by this task: the webview still
      sees only a boolean for a stored key, and no raw value is added to a response or a signal
      (Requirement 17.5).
    - Behind a lazy route or `@defer (on immediate)`, the same treatment chart.js gets, so the initial
      bundle does not grow by the size of the surface. No new runtime dependency.
    - A failed list renders the FAILURE, never the empty state. The module's existing discipline already
      says `creditsSpent: null` means "cannot tell" and `0` means "spent nothing"; the same rule extends
      to the list itself.
  - Tests:
    - A member with an empty IndexedDB library sees the organisation's deployments.
    - Opening one produces a read-only tab carrying the deployed spec's OWN id, including when the local
      library already holds that id, and no write reaches IndexedDB, `localStorage` or any keychain path
      for any interaction at `operator` or `editor` level (Property 18).
    - A failed deployments read reports the failure and never renders the empty state, for a refusal, a
      server error and a network loss alike (Property 19).
    - A browser test through `window.__phormaTest`: stub `phormaCloud.refresh` FIRST, push a fake user,
      pin the gates, then drive the level through `capability.resolveFrom('operator')` rather than
      through Clerk, which is exactly why that seam exists. Filter every DOM query by
      `getBoundingClientRect().width > 0` because both sidebars render duplicate pane instances, and
      assert `document.querySelectorAll('[id]')` total equals the unique count.
    - New specs are added to `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd frontend; npm run build` and read the reported `initial` figure; the surface must be deferred,
      so the figure should not move materially from 2.87MB.
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-capability-isolation.mjs`
  - **Demo:** sign in as an operator in a browser with no local data and open the organisation's live
    workflow on the canvas, read-only.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 17.1, 17.5, 18.3, 18.4_

- [x] 9. Run, watch and approve as a member
  - **Objective:** an operator runs a deployed workflow end to end with no new visualisation contract.
  - Implementation:
    - Trigger through `POST /trigger`, which bills the organisation's quota bucket because `trigger`
      resolves `this.state.ownerId` and passes it to `resolveHostedInference`.
    - Consume the EXISTING WebSocket monitor into `RunControllerService.apply()`. RunEvents stay the
      only visualisation contract.
    - Answer approvals and correlated events through the existing suspension endpoints
      (`POST /approvals`, `POST /events`, `POST /questions`, and the WS `approval`, `event` and `stop`
      frames).
    - Record the acting user id on a settled gate from `caller.userId`. `drainPendingGates()` is the ONE
      place all three maps are settled, and `PendingGateMeta` already rides alongside each resolver, so
      the acting id reaches run history through the recorder rather than through a new table.
    - Render the Phorma Cloud share of cost as CREDITS and only the BYO share in USD, splitting on
      `phormaCloudCostUsd` exactly as the runs panel, trace, usage panel and settings already do.
  - Tests:
    - An engine scenario script for the gate round trip, dropped into `engine/test/` as a `*.e2e.mts`
      file. `engine/test/run-all.mjs` DISCOVERS `*.e2e.mts` by directory scan and treats a non-zero exit
      as a failure, so no runner edit is needed and CI picks it up.
    - A browser test through `window.__phormaTest` driving the approval overlay, with the pixel
      interactions spent only on the overlay itself and the rest of the state built programmatically.
    - A settled gate records the acting member's `userId` alongside the outcome and the run's history
      carries it (Property 20).
    - The credits split holds for a member exactly as for a builder (Property 38).
    - If a new suite file lands, `.github/workflows/ci.yml` is updated in the SAME change.
  - Verification:
    - `cd engine; npm test`
    - `cd engine; npm run test:e2e`
    - `cd frontend; npm run build`
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `cd cloud; npm run check` and `cd cloud; npm test`
    - Engine type-only check, if engine files changed:
      `cd engine; ../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`. Never `npx tsc` inside
      `engine/`, which tries to fetch a bogus package and prompts interactively.
  - **Demo:** an operator triggers a deployed workflow, watches nodes glow and edges pulse, answers an
    approval gate and reads the trace.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 17.4, 17.6_

---

### PHASE 3 - Proposals

- [x] 10. The proposal store
  - **Objective:** a hosted-only proposal queue whose single-pending invariant is a database
    constraint, with bodies that no backup destroy path can reach.
  - Implementation:
    - No migration. `0006_organisations.sql` (task 1) already carries `workflow_proposals` with
      `id INTEGER PRIMARY KEY AUTOINCREMENT` plus `proposal_id TEXT UNIQUE`, the partial unique index
      `idx_proposals_pending` on `(owner_id, workflow_id) WHERE status = 'pending'`, and
      `idx_proposals_workflow`. If a schema change is discovered here it goes in `0007`, never appended
      to an applied file.
    - The prune orders by `id` and NEVER by `created_at`: `id` is the rowid, monotonic per insert and
      never reused, while `created_at` is a TEXT ISO string and two rows written by one pass tie to the
      millisecond. `proposal_id` is what travels on the wire, so a rowid is never in a URL.
    - `cloud/src/proposals.ts` for the pure half and `cloud/src/proposal-routes.ts` for the routes,
      mounted ABOVE the `store.enabled` gate with the same two explicit refusals the claim route uses,
      because Requirement 11.12 wants a flat 404 rather than an error naming a missing binding.
    - `cloud/src/proposal-store.ts`, a near-copy of `BackupBodyStore` and deliberately a copy rather
      than a generalisation. `JSON -> gzip -> AES-GCM -> R2`, in that order: ciphertext does not
      compress, so reversing the two stores every proposal at full size forever. Use
      `encryptBytes` / `decryptBytes`, not the string pair, which costs 1.78x in base64.
    - No `KEY_ENC_SECRET` refuses `proposal_unencrypted` and stores NOTHING, mirroring
      `BackupBodyStore.unavailable()`'s two-refusal shape.
    - The existing `BACKUPS` bucket, under the `proposal/{owner}/{workflow}/{proposalId}` prefix. No new
      bucket and no new binding. The prefix is what keeps the two apart BY CONSTRUCTION:
      `BackupBodyStore.deleteTenant` scans `backup/{tenantId}/` and `prune` / `deleteWorkflow` enumerate
      `bodyPrefix(tenant, workflow)`, so a `proposal/` object is out of reach of every backup destroy
      path and a proposal body can never be served by a backup read.
    - Creation is a `DB.batch([...])` whose first statement supersedes any pending row and whose second
      inserts the new one, so the supersede happens in the SAME update pass as the accept. If two
      creations race, one batch's supersede finds nothing, its insert violates `idx_proposals_pending`,
      and the whole batch rolls back.
    - Every transition is a conditional `UPDATE ... WHERE status = '<expected>' AND revision = ?` whose
      `meta.changes` is the single-winner signal. Zero changed rows is 409 with
      `code: 'proposal_conflict'` carrying the CURRENT revision, so the losing caller retries against a
      truth. The four proposal codes (`proposal_scope`, `proposal_stale`, `proposal_conflict`,
      `proposal_unencrypted`) are one append-only set; never rename one.
    - Path id must equal the spec id in the body. `parseProposalBody` mirrors `parseBody` in
      `backup-routes.ts`: the spec is shape-checked and `connections` is REBUILT to `{id, name}` only,
      so the one field a secret could ride in is narrowed rather than trusted.
    - Creation NEVER calls the `WorkflowAgent`. That missing edge is the "an editor's change is a
      proposal" principle expressed structurally: there is no code path from the proposal route to a
      deployed instance.
    - Body order: the row is claimed BEFORE the body is written, so a refused proposal stores nothing. A
      body write that fails after the row lands is a 502 and leaves a pending row whose body is missing;
      a read of a missing body answers 404 rather than 500.
    - Retention keeps the ten most recent NON-PENDING rows per workflow and never prunes a pending one.
      ONE destroy path, named at its call site in `proposal-routes.ts` the way `backup-routes.ts` names
      each of its three, so a second cannot appear by accident.
  - Tests (`cloud/test/proposals.test.mjs`, new):
    - Concurrency properties over the claim: for any interleaving of creations against one workflow, at
      most one row is pending at every observable read, every displaced row is `superseded`, exactly one
      creation wins each contended round, and the loser answers 409 `proposal_conflict` carrying the
      true current revision (Property 21).
    - A proposal creation leaves the deployed spec and its registry `specHash` byte-identical, and no
      request reaches the `WorkflowAgent` (Property 22).
    - Round trip: the stored object decrypts and decompresses to the body that was stored, is smaller
      than the plaintext for a repetitive spec, and a connection entry carrying extra keys is stored as
      `{id, name}` alone. With no key bound the request is refused `proposal_unencrypted` and no object
      exists (Property 23).
    - Every backup destroy path (revision prune, tombstone purge, delete-all, retention sweep) destroys
      no proposal object, and no proposal key begins with the backup prefix (Property 24).
    - Retention: the retained non-pending count is `min(n, 10)`, the pending row is never pruned, and
      every surviving row has a readable body while every pruned row has none (Property 26).
    - Shape refusals: a path id that differs from the spec id, and a body that fails the shape check.
    - BYO answers 404 with no binding named (Property 37).
    - D1-backed and R2-backed, so the suite goes LAST in `test:unit` behind
      `node test/await-port-drain.mjs`, through `withLoopbackRetry` / `withLoopbackRetryD1`, with
      per-iteration setup batched via `DB.batch([...])`.
    - Mutation-check the concurrency property: replacing the conditional update with a read-then-write
      must fail it.
    - `.github/workflows/ci.yml` and `test:unit` updated in the SAME change.
  - **OPERATOR:** `KEY_ENC_SECRET` must already be set on the hosted worker, or proposals refuse with
    `proposal_unencrypted` and store nothing. No new secret and no new bucket are required; confirm
    `BACKUPS` is bound before deploying (`/status.json` probes R2).
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `node scripts/check-deploy-bundle.mjs`
  - **Demo:** two concurrent proposal writes, exactly one winner, the loser told the current revision.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 16.2,
    18.1, 18.5, 18.6_

- [x] 11. Propose and publish, including the Canonical_Spec_Hash soundness fix
  - **Objective:** an editor's save becomes a proposal, a builder reviews a diff and publishes through
    the ordinary push path, and both sides of every hash comparison ran the same transform.
  - Implementation:
    - Extract the default materialization into `frontend/src/app/core/spec-defaults.ts`, a leaf module
      with no Angular dependency beyond types and no service import:
      `materializeSpecDefaults(spec, defaults)` and `canonicalSpecHash(spec, defaults)`. This is the
      fix for the defect `notifications.model.ts` already documents: `materializeDefaults` is private to
      `CloudService`, which every service on the transport path must not inject, so a comparison against
      the un-materialized spec reports drift on every deployment that is perfectly current.
    - `CloudService.materializeDefaults` BECOMES a thin wrapper: it keeps its name, its visibility and
      its single call site in `pushWorkflow`, reads the three settings values, calls
      `materializeSpecDefaults`, and then runs `skillsLibrary.syncAttachedSkills(graph)` over the
      resolved graphs. The push path is byte-identical in behaviour.
    - The skills refresh stays OUTSIDE the hash transform. It is a LIBRARY READ, not a default, and a
      member has no local skills library, so including it would make the hash depend on machine state.
      Stated consequence: the hash compares workflow CONFIGURATION, not attached skill CONTENT.
    - Update the comment in `frontend/src/app/core/notifications.model.ts` in the SAME change so it stops
      naming a blocker that no longer exists. Adding the `spec-drift` notification kind is a separate
      feature and is deliberately not shipped here.
    - An editor's save submits a proposal instead of pushing. `scopeViolations(live, proposed)` in
      `cloud/src/proposals.ts` is pure and property-tested: structure is the node id set, the node
      kinds, the edge set with its port wiring, and the sub-workflow id set. A non-empty result is
      `proposal_scope` NAMING the disallowed change. The worker is the boundary; the studio's own refusal
      is a usability feature.
    - A builder or admin reviews a field-grouped diff through the existing `workflow-diff` surface and
      the existing `marked` plus `DOMPurify` markdown component. No new runtime dependency.
    - Publish runs the ORDINARY push path. Extract the `POST /workflow` branch body into
      `private async acceptSpecPush(spec, ownerId)` and call it from BOTH the HTTP branch and a new
      `acceptSpecPush` RPC, so there is one push path with two entrances. RPC and not `stub.fetch()`,
      because a worker-to-DO fetch carries no bearer for `authorized()` to check, and the RPC re-checks
      the owner against the stamp exactly as `notificationsSince` does.
    - Staleness compares `live_spec_hash` against the current `DeploymentRecord.specHash` read from
      `PortalIndex.getDeployment`, which is written by `syncDeployment` on every accepted push, so it is
      the hash of what is actually deployed and it costs one storage read rather than a spec download.
      A difference is `proposal_stale` with the current live hash in the body.
    - A second pending proposal supersedes the first in the SAME conditional update. Reject carries an
      optional reason and retains the body until retention prunes it. The author is notified through the
      existing notification rail with an APPENDED notification kind.
    - Reuse `ConfirmDialogService` for the publish confirmation, and `HistoryService.boundaryOnce()` if
      a publish replaces local graph state. Any dialog this task adds is a bespoke overlay carrying
      `role="dialog"`, with a non-scrolling card, no header icon, and Tabler icons only.
    - Add the proposal wire twin pair (`cloud/src/proposals.ts` and
      `frontend/src/app/core/proposals.model.ts`) to `.kiro/steering/structure.md` in the SAME change.
  - Tests:
    - An editor save creates a proposal, never calls the push transport, and leaves the deployed spec
      byte-identical; a structural mutation is refused `proposal_scope` with a body naming that change
      (Property 27).
    - A builder publish moves the deployed spec and marks the proposal `published`; a refused push
      leaves it `pending`; a rejection stores the reason and retains the body; no terminal row ever
      transitions again (Property 25).
    - A second pending proposal is SUPERSEDED rather than dropped (Property 21).
    - The hash comparison is sound across the materialization: `canonicalSpecHash` computed in the
      studio equals the hash the push path stored for the same spec, and is INVARIANT to the defaults
      passed whenever every agent already carries an explicit provider and model. A publish is refused
      `proposal_stale` exactly when the live hash differs, with the current live hash in the body
      (Property 28).
    - Publishing a spec produces the same validation findings, the same deployed state and the same
      registry record as pushing it directly (Property 29).
    - `spec-defaults.spec.ts` in `frontend/` for the pure transform, with the invariance property above.
    - New suites and specs are added to `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `cd frontend; npm run build` and read the reported `initial` figure; the review surface is
      deferred, so it must not move the figure materially.
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-capability-isolation.mjs`
  - **Demo:** an editor changes a prompt, a builder reviews the diff and publishes, and the deployed
    instance answers with the new prompt on the next run.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 16.2,
    16.3, 16.4, 17.2, 17.3, 17.7, 18.4_

---

### PHASE 4 - Administration and support

- [x] 12. Org and member management in the admin console
  - **Objective:** create an organisation, invite a member, and hand them a capability level, from the
    dashboard.
  - Implementation:
    - Worker: an organisation management route family behind the EXISTING `refuseNonOperator` gate,
      never a re-implementation of the 401 and 403 split that gate owns. Its rules stay: an absent
      bearer is 401, a non-`clerk` credential kind is 403, and a missing `TELEMETRY_ADMIN_USER_IDS`
      grants no access. Create the Clerk organisation and provision one `tenants` row keyed by the
      organisation owner, with NO paid tier implicitly.
    - NO organisation-facing member management route in this release (Requirement 13.7). Membership is
      written through the Operator_Gate alone, so exactly one surface writes it. The `member.manage`
      capability stays declared in the Capability_Contract and exercised by no route, because a released
      token is never renamed or repurposed - and an organisation-facing route is a later feature, not a
      gap. Assert the absence: the route enumeration's static half must find no `admin`-level member
      write outside the operator prefix.
    - Every membership write lands an `org_members` row. That table is the AUTHORITATIVE membership and
      level source rather than a fallback (task 1), because a `device` credential carries no Clerk role
      claim and the header-named owner in `resolveRequestedOwner` is confirmed against it - so a write
      that only touched Clerk would leave a desktop install unable to switch into the organisation it
      was just added to. Write the Clerk membership AND the row, in that order, and report a partial
      failure rather than logging it: one of the two existing without the other is the state an operator
      most needs to see.
    - Membership and level writes INVALIDATE the `orgmember:{orgId}:{userId}` KV key immediately. A
      demotion that takes 60 seconds to bite is a demotion that did not happen for 60 seconds, and a
      REMOVAL that takes 60 seconds to bite leaves a removed member addressing the organisation for a
      minute (Requirement 20.11). An unrecognised level token is `role_unknown`.
    - An organisation's TIER is assigned here too, through the provisioning path task 15 names as the
      only way an organisation becomes entitled. Creating an organisation grants no paid tier implicitly
      (Requirement 13.4); raising a ceiling later is a tier change, never a credit grant
      (Requirement 19.10).
    - No migration. `org_members` already exists from task 1.
    - Admin console: follow the conventions already enforced in `admin/`. One transport in
      `admin-api.ts` owning the session-token funnel and the `AdminResult` union, a prefixed typed
      service with nothing more than a prefix and typed methods, a wire twin under `core/`, and one
      folder under `views/`. The nav and router DERIVE the five telemetry entries from
      `TELEMETRY_ROUTES`, so this view is appended EXPLICITLY the way Spend is.
    - No new SCSS. Every shared class already exists in `admin/src/styles.scss` (`.admin-view`,
      `.admin-grid`, `.admin-card`, `.admin-stat`, `.admin-table`, `.admin-footnote`, `.admin-columns`),
      and the budget is 1.5MB warning against about 791kB today. Tabler icons, no `p-dialog`, explicit
      sizes on every control.
  - Tests:
    - The admin karma suite extended for the new view.
    - A worker suite for the routes: the operator gate's three rules, organisation creation provisioning
      a tenant row with no paid tier, and exactly one `org_members` row per `(organisation, user)` whose
      level equals the last accepted write (Property 30).
    - A demotion is effective on the NEXT request, and so is a REMOVAL: after removal the same request
      that resolved the organisation a moment ago resolves the caller's own owner instead, with no
      refusal (Requirement 20.11). Both are the KV invalidation assertion.
    - An organisation created here has no paid tier and no `active` subscription status, and exactly one
      `org_members` row exists per `(organisation, user)` whose level equals the last accepted write
      (Property 30).
    - No `admin`-level member-management write route exists outside the operator prefix.
    - `.github/workflows/ci.yml` updated in the SAME change for any new suite.
  - Verification:
    - `cd admin; npm run build`
    - `cd admin; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-admin-conventions.mjs`
    - `node scripts/check-telemetry-secrets.mjs` after the admin build
    - `node scripts/check-telemetry-catalog.mjs`
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
  - **OPERATOR:** `TELEMETRY_ADMIN_USER_IDS` stays a BARE comma-separated list, never JSON. A
    JSON-shaped value splits into entries that match no user id, fails closed, and every operator reads
    403 with nothing in the log to say why. `CLERK_AUTHORIZED_PARTIES` and `ALLOWED_ORIGINS` must hold
    the SAME origin set: both dev servers (7322 and 7323), the desktop webview origins
    (`tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows and Android plus the
    `https://` form), and the deployed dashboard. `@clerk/backend` matches `azp` by exact string and
    skips the check entirely when the var is unset, so a missing origin is a hard 401 on every request
    from it. A `var` change takes effect ONLY on the next `wrangler deploy --env hosted`.
  - **Demo:** create an organisation in the dashboard, invite a member, and watch them sign in and see
    that organisation's workflows and nothing else.
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 18.1_

- [x] 13. Read-only audited impersonation
  - **Objective:** an operator reads any organisation exactly as its members see it, cannot write, and
    leaves one audit row per accepted request.
  - Implementation:
    - `resolveOperator(request, env)` in `cloud/src/admin-auth.ts`, a SEPARATE function that returns the
      operator's identity. `refuseNonOperator` keeps its deliberate `null` contract untouched, because
      handing back an identity nobody uses would invite a route to start scoping by it.
      `resolveOperator` reuses `readBearerToken`, `verifyRequest` and `isOperator` and keeps the gate's
      non-negotiable rules, so a long-lived `phd_` desktop token can never impersonate.
    - `cloud/src/impersonation.ts` reads `X-Phorma-Act-As` in ONE place. Null covers three cases that
      must be INDISTINGUISHABLE from outside: no header, a header from a non-operator, and a header
      carrying a value `isOwnerId` rejects. In all three the request is served as the caller's own owner
      with no refusal and no distinguishing response, so probing the header reveals nothing.
    - No session state. Every impersonated request carries the header, so there is nothing to expire,
      revoke or leak.
    - Gateway enforcement in `cloud/src/index.ts`: when impersonation resolves, the prefix becomes the
      impersonated owner AND the method must be GET. Anything else is 403 `impersonation_read_only`
      before `routeAgentRequest` runs. The WebSocket upgrade path is refused OUTRIGHT rather than
      treated as a read: a monitor socket accepts `approval`, `event` and `stop` control frames, so it
      is a write channel wearing a read's clothes.
    - Instance enforcement: `AuthorizedCaller.impersonated` is checked FIRST in `requireCapability`,
      before the level comparison, so an operator who also holds a real membership still cannot write
      through the header. Their membership is the write path.
    - Entitlement gate: `resolveHostedInference` refuses with `impersonation_read_only`, a SIXTH token
      APPENDED to the five existing `HostedInferenceRefusalCode` values, never a rename.
    - The audit write is AWAITED and a failure REFUSES the request with `impersonation_unaudited`. Not
      `ctx.waitUntil`: a `waitUntil` failure cannot refuse the request. The cost is one D1 write on the
      request path, which is acceptable precisely because impersonation is a support action measured in
      dozens per day. `path` is stored WITHOUT the query string.
    - `GET /api/admin/impersonation` exposes the append-only audit to an operator, behind
      `refuseNonOperator` beside the existing telemetry and billing families. A third operator prefix
      rather than a sixth telemetry aggregate, because this body names identified people on purpose.
    - No migration. `impersonation_audit` already exists from task 1.
    - Admin console only. `AdminRequestService` gains a sibling `sendActingAs` going through the same
      branded `SessionToken` funnel and the same `AdminResult` union, so the no-session guarantee and
      the 401-versus-403 split are inherited rather than reimplemented. The studio offers nothing.
  - Tests (`cloud/test/impersonation.test.mjs`, new):
    - An operator reads another organisation's deployments through the header.
    - The same operator's `POST /trigger` and `POST /workflow` are refused
      `impersonation_read_only`, at the gateway and inside the instance, and the WebSocket upgrade is
      refused outright (Property 31).
    - The entitlement gate refuses hosted inference for a tenant state that would otherwise be
      entitled, and no usage row, ledger entry or grant draw is produced (Property 31).
    - A non-operator's act-as header is IGNORED entirely: the response equals the response to the
      identical request without the header, and no audit row is written. A header-free request
      immediately after an impersonated one resolves the caller's own owner (Property 32).
    - Every accepted use writes EXACTLY one audit row whose acting user, owner, method, path and time
      equal the request's own values, with no query string in `path` (Property 33).
    - An injected audit-write failure refuses the request and serves no response body (Property 33).
    - D1-backed, so the suite joins the tail behind `node test/await-port-drain.mjs`, through the
      loopback retry wrappers, with `DB.batch([...])` setup.
    - `.github/workflows/ci.yml` and `test:unit` updated in the SAME change.
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `node scripts/check-deploy-bundle.mjs` (this task adds a file under `cloud/src/`)
    - `cd admin; npm run build`
    - `cd admin; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-admin-conventions.mjs`
    - `node scripts/check-telemetry-secrets.mjs` after the admin build
  - **Demo:** read any organisation's deployments without membership, and watch a write attempt refused
    and recorded.
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13,
    14.14, 14.15, 16.2, 18.1, 18.5_

- [x] 16. Owner switching
  - **Objective:** a user with a personal account and one or more memberships chooses which they are
    working in, without signing out and without their own workflows going anywhere. Requirement 20,
    delivered in Phase 4 because you cannot switch into an organisation nothing has created.
  - Implementation:
    - `frontend/src/app/core/active-owner.service.ts`, a DI LEAF for the same reason `CapabilityService`
      is one: the value is read on the transport path and `PhormaCloudService` sits on the known NG0200
      cycle. It holds `activeOrgId` (null IS the personal account, and the startup value), `owners`
      pushed by whoever holds the verified `/api/me` answer, and `requestedOrg()` for the transports. It
      injects no `CloudService`, no `PhormaCloudService` and no `WorkflowService`. Extend
      `scripts/check-capability-isolation.mjs`'s import allowlist to cover this file too, rather than
      writing a second guard.
    - `canSwitch = owners().length > 1`, so a solo account renders NOTHING (Requirement 20.3). This is
      the criterion a demo must show: an account with no memberships must look exactly as it does today.
    - `X-Phorma-Owner` goes on beside the `Authorization` header at the seams that already exist:
      `PhormaCloudService.sessionToken()`'s callers (`/api/me`, `/api/infer`), `dispatchCloudOperation`,
      and `BillingService`'s own equivalent. A browser build does not strictly need it - Clerk's
      `setActive` puts the organisation in the session claim, which `verifyBearer` reads - but sending it
      in both shapes keeps ONE code path, and the worker prefers the verified claim when both are present.
    - Browser switching calls Clerk's `setActive` on the raw instance behind `ClerkService.clerk$`.
      `ClerkService` does not expose `setActive`; the raw `Clerk` does, and `PhormaCloudService.signOut()`
      already awaits `firstValueFrom(this.clerk.clerk$)`, so the idiom exists. Desktop switching sets the
      signal alone, because the header is the whole mechanism there. Do NOT import `ngx-clerk`'s
      `ClerkOrganizationSwitcherComponent`: it offers organisation creation and self-join, which
      Requirement 20.12 forbids, and it carries Clerk's own chrome.
    - `/api/me` gains one more ADDITIVE field beyond task 6's `ownerId` and `level`: `owners`, resolved
      from `org_members` by `user_id` - which is exactly what `idx_org_members_user` exists for. One
      source answers both shapes, so a desktop install with no Clerk session gets the same list a browser
      gets from `user.organizationMemberships`.
    - `owners`, `ownerId` and `level` must be returned on BOTH `/api/me` branches, including the
      `provisioned: false` early return. That branch is the COMMON case for an organisation member: a
      member who never subscribed personally has no `tenants` row of their own, so a switcher fed only by
      the provisioned branch would be empty for exactly the people who need it. `PhormaCloudProfile` is
      the studio twin of that body and gains the three fields with it.
    - UI placement is not free. The toolbar account control has THREE branches, and the browser one is
      `<clerk-user-button>` whose popover is Clerk's, not ours - `Toolbar.accountMenu` only exists on the
      device-token branch. So the switcher is its own control beside the account button rather than an
      item inside that menu, or both branches get a Phorma-owned menu. Either way the ACTIVE owner is
      visible without opening anything (Requirement 20.2), because the whole point is knowing which owner
      a deploy will reach before pressing Deploy.
    - The switch resets owner-scoped session state: `DeployedNotificationsService`'s poll cursor and
      accumulated list, `NotificationsService`'s store, `NotificationCenterService`'s merge, and
      `DeploymentsService`'s list. The notification cursor is the sharp one - the read marker IS the poll
      cursor, so carrying it across a switch silently suppresses the new owner's settled runs up to the
      previous owner's last-read time.
    - Every document tab opened from the previous owner CLOSES, because a document tab addresses a
      workflow id inside one owner and the same id means a different workflow under another. A dirty
      document routes through `ConfirmDialogService` first (Requirement 20.8) - use the resolved value,
      never `activeState()` in the `.then()`, which is already cleared. `AssistantContextService` is keyed
      by open-tab `docId` and is session state, so it drops itself with the tabs and needs no change.
    - IndexedDB **v12**: add `ownerId` to the workflow-scoped stores (`runs`, `usage`,
      `workflow-versions`, `workflow-state`, `workflow-backup-state`, and the library). The migration
      stamps every existing row with the personal Owner_Id in force before the upgrade, and a row with no
      owner READS as personal (Requirements 20.14, 20.15) - the same absent-is-ordinary discipline
      `workflow_backups.body_key` follows. Filter at the READ, never delete on switch: a switch is a
      change of view, and pruning would make "switching back presents that owner's surfaces as they were"
      impossible.
    - The KEYCHAIN stays un-scoped and that is deliberate, not an omission - see the rejected
      alternatives in the design. A browser member has no keychain path at all, and scoping would create
      the artefact the "no customer credential on a build machine" principle forbids.
    - Behind a lazy route or `@defer (on immediate)` if the switcher grows past a menu, so the initial
      bundle does not move against the 3MB error threshold.
  - Tests:
    - Property: across any sequence of switches, every capability-derived surface, the profile, the
      deployment list, the notification cursor and the accumulated notifications equal those of a session
      that started at the final owner; no tab from a previous owner survives; switching back reproduces
      that owner's surfaces; and an account with no membership is offered no switching surface
      (Property 40).
    - Property: each local surface presents exactly the active owner's subset, the total row count is
      invariant under any number of switches, a row with no owner reads as personal, and a store populated
      by the PREVIOUS schema version upgrades with every row still readable (Property 41).
    - The v12 upgrade is tested against a store SEEDED at v11 and then opened, not against an empty one.
      This is the only irreversible step in the feature: it runs on the user's machine on first launch and
      no worker deploy rolls it back.
    - A dirty document prompts through the confirm rail and a cancel leaves the active owner unchanged.
    - Worker: the `owners` field lists exactly the caller's memberships, and a membership removed between
      two calls disappears from the second.
    - A browser test through `window.__phormaTest`: stub `phormaCloud.refresh` FIRST, push a fake user,
      pin the gates, drive the level through `capability.resolveFrom(...)` and the owner through the new
      service rather than through Clerk. Filter every DOM query by `getBoundingClientRect().width > 0`
      because both sidebars render duplicate pane instances, and assert
      `document.querySelectorAll('[id]')` total equals the unique count.
    - New specs and any new worker suite go into `.github/workflows/ci.yml` in the SAME change.
  - Verification:
    - `cd frontend; npm run build` and read the reported `initial` figure against the 3MB error threshold
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
    - `node scripts/check-capability-isolation.mjs`
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
  - **Demo:** one signed-in account switches from its personal library to a managed organisation and back:
    the sidebar composition, the deployment list, the notification bell and the billing surfaces all
    change, the personal library is exactly as it was on return, and a second account with no membership
    sees no switcher at all.
  - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.12, 20.13, 20.14, 20.15,
    17.1, 17.3, 18.1, 18.3, 18.4, 18.7_

---

### PHASE 5 - Preparation for per-workflow pricing

- [x] 14. Per-workflow pricing preparation
  - **Objective:** the entitlement gate already knows which workflow is running, so per-workflow pricing
    later is a policy change inside one function rather than a signature change across two call sites
    and a wire contract.
  - Implementation:
    - `resolveHostedInference(store, tenantId, options?)` with an optional bag carrying `workflowId`
      (and the `impersonated` flag from task 13), so every existing call site keeps compiling.
    - `/api/infer` passes the workflow id when the request carries one, which means an ADDITIVE optional
      `workflowId` on the `POST /api/infer` body: ignored by an older worker, omitted by an older studio.
    - `WorkflowAgent.trigger` passes `this.state.spec.id`, which it already holds.
    - Append `workflow_not_entitled` to `HostedInferenceRefusalCode` and NEVER return it in this
      release.
    - The gate stays the ONLY hosted inference entitlement check, called from exactly `/api/infer` and
      the trigger path. Build no catalogue, no meter and no entitlement table.
    - Leave `BILLING_LOOKUP_KEYS` intact, so a future workflow SKU arrives as price METADATA the way
      tier does, never as a client-supplied price id.
    - The studio already tolerates an unknown code: `frontend/src/app/core/billing-refusal.ts` holds the
      copy in one place and falls back to the served PROSE. Keep the five existing codes' load-bearing
      prose (`credits exhausted`, `subscription`), because an older studio falls back to a regex when
      the code is absent.
  - Tests:
    - The existing `cloud/test/entitlement.test.mjs` green with the new signature, plus a case per
      existing call site passing the workflow id and asserting identical behaviour.
    - A case asserting the reserved code is unreachable: `workflow_not_entitled` appears in the type
      declaration and its doc comment and NOWHERE else under `cloud/src/`. That is a grep, and it is
      enough - it fails the moment somebody wires it up without also wiring up the policy.
    - The studio renders the served prose for an unrecognised refusal code and reports no error
      (Property 34).
  - Verification:
    - `cd cloud; npm run check`
    - `cd cloud; npm test`
    - `cd frontend; npm run build`
    - `cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`
  - **Demo:** the entitlement gate carries the workflow id end to end with identical behaviour.
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 16.2_

---

## Notes

- **Phases 0 and 1 ship inert.** Tasks 1 to 7 and 15 change no observable behaviour for an install with
  no organisation, because every credential resolves its personal owner and the `admin` level, and a
  personal owner is exactly who self-serve billing already serves. That is what makes the enforcement
  layer deployable before any organisation exists.
- **A solo account is a supported end state, not a waypoint.** A user who downloads the Studio, creates
  an account and never joins an organisation must reach every capability they have today
  (Requirement 1.12). Two things protect that and both are easy to lose: the Clerk personal-account
  setting (task 1's second OPERATOR step) and `canSwitch` rendering nothing for an account with no
  memberships (task 16). Every demo in this plan should be run twice, once as a solo account.
- **Operator steps this code cannot perform**, all called out in the task that needs them: the
  two-token Clerk claim-layout verification and the Clerk Organizations configuration INCLUDING the
  personal-account confirmation (task 1), the migration apply with
  `npx wrangler d1 migrations apply phorma-cloud --env hosted --remote` plus the
  `d1 migrations list` confirmation (task 1), `KEY_ENC_SECRET` already set and `BACKUPS` bound
  (task 10), and the `TELEMETRY_ADMIN_USER_IDS` bare-list rule plus keeping `CLERK_AUTHORIZED_PARTIES`
  and `ALLOWED_ORIGINS` on the same origin set (task 12). A `var` change takes effect only on the next
  `wrangler deploy --env hosted`.
- **One D1 migration, written once.** `0006_organisations.sql` lands complete in task 1. Tasks 2, 10,
  12, 13 and 15 add no migration, because wrangler records a migration as applied by filename and
  anything appended after a remote apply silently never runs. A later schema change goes in `0007`.
  Task 16's IndexedDB v12 is a SEPARATE store on the user's machine, with the opposite risk profile:
  no filename bookkeeping, and no rollback either.
- **Every new suite and guard is added to `.github/workflows/ci.yml` in the same change**, and every new
  cloud suite is also added to `cloud/package.json`'s `test:unit` chain in the D1-backed tail behind
  `node test/await-port-drain.mjs`.
- **Refusal codes are one append-only set, across every task** (Requirement 16.2). The full set this
  feature introduces: `owner_invalid` (task 1), `claim_not_owner`, `claim_unowned`, `claim_conflict`
  (task 2), `billing_managed` (task 15), `role_unknown`, `role_forbidden` (task 5),
  `proposal_unencrypted`, `proposal_conflict` (task 10), `proposal_scope`, `proposal_stale` (task 11),
  `impersonation_read_only`, `impersonation_unaudited` (task 13), and the reserved
  `workflow_not_entitled` (task 14). A released token is never renamed or repurposed, and a studio three
  versions old must render an unknown code's prose rather than break.
- **Two owner-naming headers, and they are not interchangeable.** `X-Phorma-Owner` (task 1) is a member
  naming their OWN organisation and is checked against `org_members`; `X-Phorma-Act-As` (task 13) is an
  operator naming somebody ELSE'S and is checked against the allowlist, is read-only, and is audited.
  Folding them into one header would make the difference between the two a property of who is asking
  rather than of what was asked.
- **No em dash anywhere** (Requirement 16.1): not in code, a comment, a SQL migration, a document, a
  commit message or a user-facing string. Plain hyphen. This applies to every task, and the migration
  and guard-script comments this feature adds are where it has slipped before.
- **Never use the `npm test -- --watch=false` form for Angular.** npm 11 warns "Unknown cli config" and
  npm 10 drops the flags silently, and the karma builder then defaults to watch mode and never exits.
  Always `npx ng test --watch=false --browsers=ChromeHeadless`.
- **Only `npm run build` checks Angular budgets.** `ng serve` and `tsc` do not, and CI has failed on a
  budget error dev serve never surfaced. Read the reported `initial` figure against the 3MB error
  threshold in `frontend/` (2.87MB today) and the 2MB threshold in `admin/` (about 791kB today).
- **Property discipline.** Every property test runs at least 100 iterations and carries the tag
  `Feature: multi-organisation-phorma, Property {number}: {property text}`. Pin CONTENTS, not only
  shape. Never mirror a production constant table into a spec as an oracle. Mutation-check each new
  property suite by planting one realistic bug and restoring the exact original text afterwards, never
  by `git checkout` while in-flight work is uncommitted.
- **Release.** All six packages share one version number and `cloud-aws/scripts/check-versions.mjs`
  enforces it, so any bump goes through `scripts/release.mjs`. Read the `release-playbook` skill before
  bumping; it is a gate, not a reference.
- Pre-pivot deployments are claimed once each by an organisation admin through
  `POST /api/deployments/{workflowId}/claim` after task 2 ships. It is idempotent, so a repeat is safe.

## Task Dependency Graph

Reading order follows the phases; EXECUTION order is the graph below, and the two deliberately differ.
Three edges are worth stating because they are not obvious from the phase numbers:

- Task 4 (the capability contract) and task 5 (the Role_Gate) both land before task 2, because task 2's
  claim route is a write that goes through the Role_Gate rather than carrying a check of its own.
- Task 15 (billing separation) needs task 3's owner-scoped consumers and task 5's `WRITE_ROUTES`, so it
  runs with task 3's wave at the earliest and is grouped just after it.
- Task 16 (owner switching) runs AFTER task 12, not with the other Phase 2 studio work. Switching can
  only offer memberships something else created, and task 12 is the only thing that creates one - it is
  also what makes `org_members` populated enough for the header check and the `owners` list to mean
  anything.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "4"] },
    { "id": 1, "tasks": ["5", "6"] },
    { "id": 2, "tasks": ["2", "7"] },
    { "id": 3, "tasks": ["3"] },
    { "id": 4, "tasks": ["15"] },
    { "id": 5, "tasks": ["8"] },
    { "id": 6, "tasks": ["9", "10"] },
    { "id": 7, "tasks": ["11"] },
    { "id": 8, "tasks": ["12"] },
    { "id": 9, "tasks": ["13", "16"] },
    { "id": 10, "tasks": ["14"] }
  ]
}
```
