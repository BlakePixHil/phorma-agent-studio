# Requirements Document

## Introduction

Phorma pivots from selling the studio to selling workflows to companies. The studio stays, both as
the internal build tool and as the top capability tier of the same product ladder, so selling the
studio later is the same code path rather than a second one. That requires organisations as
first-class tenants: a super admin creates an organisation, invites members, hands each member one
of four capability levels, and keeps super-admin reach across every organisation, while each
organisation's secrets, runs, usage and workflows stay isolated from every other organisation.

Today the system has exactly ONE identity, the Clerk user id, and that single value is
simultaneously the `tenants.id` primary key, the Durable Object instance-name prefix, the
`SecretVault` instance name, the deploy registry owner segment, the R2 backup path segment, the
Stripe customer reference and the quota bucket. The pivot therefore starts by separating the
question "who is asking" from the question "whose data is this", and answers the second with an
opaque Owner_Id.

Five principles constrain every requirement below.

- **Isolation is structural, not policy-checked.** An organisation that is not the caller's must be
  unaddressable, in the same way another user's data is unaddressable today. A boundary that is one
  inverted boolean away from open is not a boundary.
- **The wire contract only grows.** Capability tokens, refusal codes and proposal statuses are
  append-only. A studio three versions old must still read a refusal it has never seen.
- **An editor's change is a proposal.** A member below the builder level cannot reach a deployed
  instance by saving. Publishing is a builder action and runs the ordinary push path, so there is
  one way a spec becomes live.
- **A customer credential never reaches the build machine.** Operator and editor members work in
  the browser against deployed workflows only, with no local library and no OS keychain, so the
  desktop keychain and IndexedDB stay deliberately un-scoped.
- **Support reach is read-only and audited.** The super admin builds inside an organisation through
  real Clerk membership. Impersonation exists for support, refuses every write and every credit
  spend, and leaves one audit row per accepted use.

Per-workflow pricing is explicitly a later feature. This release buys only the cheap preparation
that avoids a signature change later: no catalogue, no meter, no entitlement table.

## Glossary

- **Studio**: the Angular frontend in `frontend/`, in desktop or browser shape.
- **Worker_Host**: the Cloudflare Worker in `cloud/`, in hosted or BYO shape.
- **Workflow_Agent**: the `WorkflowAgent` Durable Object holding one deployed workflow.
- **Portal_Index**: the `PortalIndex` Durable Object in `cloud/src/portal-registry.ts`.
- **Secret_Vault**: the `SecretVault` Durable Object, one instance per owner.
- **Auth_Resolver**: `verifyBearer` / `verifyRequest` in `cloud/src/auth.ts`, and the `AuthContext`
  returned by each.
- **User_Id**: the Clerk user id, the JWT `sub` claim.
- **Org_Id**: the Clerk organisation id, the JWT `org_id` claim, of the form `org_...`.
- **Owner_Id**: the opaque string identifying whose data a request addresses, resolved as
  `Org_Id ?? User_Id`. Owner_Id is the successor of every place a User_Id is used today as a data
  key.
- **Capability_Level**: one of the four named capability tokens `operator`, `editor`, `builder`,
  `admin`.
- **Capability_Contract**: the module declaring Capability_Level, the capability set of each level
  and the comparison between levels. Exists twice, as a structural twin: `cloud/src/capabilities.ts`
  and `frontend/src/app/core/capabilities.ts`.
- **Role_Gate**: the single server-side capability seam in the Worker_Host that every write route
  and every Workflow_Agent write path calls.
- **Capability_Service**: `frontend/src/app/core/capability.service.ts`, the Studio's dependency
  injection leaf holding the caller's resolved Capability_Level.
- **Capability_Guard**: the CI script `scripts/check-capability-isolation.mjs`.
- **Panel_Registry**: `frontend/src/app/core/panel-registry.service.ts` and its `DEFAULT_TABS`.
- **Action_Registry**: `frontend/src/app/core/studio-actions/`, the description of every studio
  capability the assistant can execute.
- **Deployment_Registry**: the `deploy:{Owner_Id}:{workflowId}` key space in Portal_Index.
- **Deployments_API**: `GET /api/deployments`.
- **Notifications_API**: `GET /api/notifications`, and the `WorkflowAgent.notificationsSince` RPC
  behind it.
- **Backup_Store**: the hosted-only `workflow_backups` D1 table and the `BACKUPS` R2 bucket behind
  it.
- **Entitlement_Gate**: `resolveHostedInference` in `cloud/src/tenants.ts`, the one hosted inference
  entitlement check, called from `/api/infer` and `WorkflowAgent.trigger`.
- **Cloud_Library**: the Studio surface listing an organisation's deployed workflows for a member
  with no local library.
- **Workflow_Spec**: a version-1 `WorkflowSpec` as produced by `WorkflowService.exportActiveSpec()`.
- **Canonical_Spec_Hash**: `fnv1a(canonicalJson(spec))` computed over a Workflow_Spec AFTER default
  materialization, so two hashes are only ever compared when both sides ran the same
  materialization.
- **Proposal**: a full Workflow_Spec submitted by an editor for publication, never applied to a
  deployed instance by its own creation.
- **Proposal_Store**: the hosted-only `workflow_proposals` D1 table.
- **Proposal_Body_Store**: the R2 prefix `proposal/{Owner_Id}/{workflowId}/{proposalId}`, distinct
  from the Backup_Store prefix.
- **Proposal_Status**: one of `pending`, `published`, `rejected`, `superseded`.
- **Operator_Gate**: `refuseNonOperator` in `cloud/src/admin-auth.ts`, the shared gate on every
  `/api/admin/*` surface.
- **Super_Admin**: a Clerk user id on the `TELEMETRY_ADMIN_USER_IDS` allowlist, reached through the
  Operator_Gate.
- **Impersonation_Resolver**: the separate server-side function that resolves an act-as request to a
  read-only Owner_Id for a Super_Admin.
- **Impersonation_Audit**: the append-only D1 record of accepted impersonated requests.
- **Admin_Console**: the `admin/` Angular dashboard.
- **Refusal_Code**: a machine-readable token in a refusal body that the Studio branches on, drawn
  from an append-only set.

---

## Requirements

Twenty requirements. Requirements 1 to 15, 19 and 20 are grouped under the phase that delivers them;
requirements 16 to 18 are non-functional and hold across every phase. Requirements 19 and 20 were
added after the first draft and keep their numbers, so document order and numeric order disagree in
two places rather than renumbering fifteen requirements and every cross-reference in `design.md` and
`tasks.md`. The phase heading above a requirement is where delivery order lives; the number is only
its identity.

## Phase 0 - Owner identity

### Requirement 1: Owner identity resolution

**User Story:** As a member of an organisation, I want every request I make to address my
organisation's data rather than my personal data, so that my colleagues and I see one shared
workspace.

#### Acceptance Criteria

1. THE Auth_Resolver SHALL return an `AuthContext` carrying `userId`, `orgId` and `ownerId`.
2. WHEN a verified Clerk session token carries an `org_id` claim, THE Auth_Resolver SHALL set
   `orgId` to that claim value and `ownerId` to the same value.
3. WHEN a verified credential carries no organisation claim, THE Auth_Resolver SHALL set `orgId` to
   null and `ownerId` to the credential's `userId`, so behaviour is identical to the behaviour
   before this feature existed.
4. WHERE the credential is a BYO shared token or an open unprotected instance, THE Auth_Resolver
   SHALL set `userId`, `orgId` and `ownerId` to null, and every consumer SHALL resolve the literal
   `default` owner exactly as before this feature existed.
5. THE Worker_Host SHALL treat Owner_Id as opaque, and no module SHALL parse, split or infer
   structure from an Owner_Id beyond equality comparison and the existing "contains no colon"
   check.
6. WHERE the credential is a Phorma desktop token, THE Auth_Resolver SHALL resolve `ownerId` to the
   token subject's User_Id unless the request names an organisation, and THE desktop token payload
   SHALL carry no organisation id, so no install holds a credential that names an owner for the
   whole of that token's lifetime.
7. WHEN a request names an organisation, THE Worker_Host SHALL resolve that organisation as the
   `ownerId` only after verifying the caller's membership of it server-side ON THAT REQUEST, and IF
   the membership cannot be verified, THEN THE Auth_Resolver SHALL resolve the caller's own User_Id
   as though the organisation had never been named.
8. IF a resolved Owner_Id contains a colon, THEN THE Worker_Host SHALL refuse the request with
   Refusal_Code `owner_invalid` and SHALL NOT truncate, escape or rewrite the value.
9. THE Worker_Host SHALL accept both the `user_...` and the `org_...` id shape on every write path
   that validates an incoming tenant id today, and SHALL refuse every other shape.
10. THE Worker_Host SHALL NOT re-validate an Owner_Id read out of an existing stored row, so rows
    written before this feature existed still resolve.
11. THE Refusal_Code set introduced by this requirement SHALL be append-only, comprising
    `owner_invalid`.
12. THE Worker_Host and THE Studio SHALL treat an account belonging to no organisation as a fully
    supported terminal state and not a state to be migrated, so a user who downloads the Studio,
    creates an account and never joins an organisation keeps every capability that account holds
    before this feature exists.
13. THE hosted Clerk instance SHALL keep personal accounts ENABLED, so authentication never requires
    choosing an organisation and a session token minted for an account with no organisation carries
    no organisation claim.
14. WHEN the Clerk organisation feature is enabled, THE verification step SHALL confirm BOTH the
    session-token claim layout AND that a NEWLY CREATED account authenticates with no organisation
    claim, because a forced organisation selection makes Requirement 1.3 unreachable for every new
    account and nothing logs an error when it does.
15. THE Studio SHALL NOT require an organisation to sign in, create a workflow, run a workflow or
    deploy, and no surface SHALL present organisation selection as a precondition for any of them.

### Requirement 2: Structural isolation of organisation-scoped addressing

**User Story:** As an organisation, I want another organisation's workflows to be unreachable rather
than merely refused, so that one inverted check cannot expose my data.

#### Acceptance Criteria

1. WHEN the Worker_Host routes a request to a Workflow_Agent, THE Worker_Host SHALL rewrite the
   agent instance name to `${ownerId}:${instance}`.
2. IF a request names an agent instance whose owner prefix differs from the caller's resolved
   Owner_Id, THEN THE Worker_Host SHALL answer 403 and SHALL NOT instantiate the Durable Object.
3. WHEN a Workflow_Agent accepts its first spec push, THE Workflow_Agent SHALL stamp the resolved
   Owner_Id onto its own state.
4. WHILE a Workflow_Agent holds a stamped owner, THE Workflow_Agent SHALL compare the caller's
   resolved Owner_Id against that stamped owner on every request and SHALL refuse a mismatch.
5. THE Worker_Host and THE Workflow_Agent SHALL each enforce isolation independently, and the test
   suite SHALL include a case that reaches a Workflow_Agent with a foreign Owner_Id and asserts the
   in-instance check alone refuses the request.
6. WHEN a Workflow_Agent purges itself, THE Workflow_Agent SHALL preserve the stamped owner, so a
   purged instance cannot be adopted by a different Owner_Id.
7. THE Portal_Index SHALL continue to refuse a registry segment containing a colon, for the
   Owner_Id segment and the workflow id segment alike.
8. WHERE a Workflow_Agent instance is a portal session instance, THE Workflow_Agent SHALL keep its
   existing behaviour and SHALL NOT participate in organisation ownership.
9. THE Workflow_Agent SHALL apply the same owner comparison to its WebSocket upgrade path as to its
   HTTP paths.

### Requirement 3: One-time ownership claim for pre-pivot deployments

**User Story:** As an organisation admin, I want a workflow that was deployed under a personal
account before the pivot to become owned by my organisation, so that my team can reach the
deployment that is already running.

#### Acceptance Criteria

1. THE Worker_Host SHALL expose an authenticated claim route that transfers one Workflow_Agent
   instance from its currently stamped Owner_Id to the caller's resolved Owner_Id.
2. WHEN a claim request arrives, THE Worker_Host SHALL accept the claim only if the caller's
   Capability_Level in the target organisation is `builder` or `admin` AND the caller's User_Id
   equals the instance's currently stamped Owner_Id.
3. IF the instance's stamped Owner_Id differs from the caller's own User_Id, THEN THE Worker_Host
   SHALL refuse the claim with Refusal_Code `claim_not_owner`.
4. IF the target instance holds no stamped owner, THEN THE Worker_Host SHALL refuse the claim with
   Refusal_Code `claim_unowned`, so a claim never adopts an instance the existing first-push stamp
   would have owned.
5. WHEN a claim is accepted, THE Workflow_Agent SHALL replace its stamped owner in one atomic
   write, so exactly one Owner_Id is stamped at every observable moment.
6. WHEN a claim is accepted, THE Workflow_Agent SHALL write a Deployment_Registry record under the
   new Owner_Id and SHALL remove the record under the previous Owner_Id.
7. WHEN a claim is accepted, THE Worker_Host SHALL transfer the instance's Backup_Store metadata
   rows and usage rows to the new Owner_Id.
8. WHEN the same claim request is repeated after acceptance, THE Worker_Host SHALL answer success
   without further state change.
9. WHEN a claim is accepted, THE Worker_Host SHALL record the previous Owner_Id, the new Owner_Id,
   the acting User_Id and the time of the claim.
10. THE claim route SHALL be reachable only in hosted mode, and THE Worker_Host SHALL answer 404 in
    BYO mode.
11. IF the caller's resolved Owner_Id already holds a Backup_Store metadata row for a workflow whose
    id equals the claimed workflow id, THEN THE Worker_Host SHALL refuse the claim with Refusal_Code
    `claim_conflict` before any ownership state changes, so a claim never half-applies.
12. THE Refusal_Code set introduced by this requirement SHALL be append-only, comprising
    `claim_not_owner`, `claim_unowned` and `claim_conflict`.

### Requirement 4: Organisation-scoping of every remaining owner consumer

**User Story:** As an organisation, I want my secrets, deployments, notifications, backups, usage,
quota and billing to all resolve to the same tenant, so that no surface silently addresses a
member's personal account.

#### Acceptance Criteria

1. THE Worker_Host SHALL address the Secret_Vault as `secrets:{Owner_Id}`, and
   `POST /api/connection-secrets` SHALL write into the vault of the caller's resolved Owner_Id.
2. WHEN a member with the `editor` Capability_Level or above submits a connection secret value from
   a browser, THE Worker_Host SHALL store that value in the organisation's Secret_Vault without any
   use of an operating system keychain.
3. THE Workflow_Agent SHALL write every Deployment_Registry record under the key
   `deploy:{Owner_Id}:{workflowId}` and SHALL remain the only writer of that key space.
4. THE Deployments_API SHALL list only the records of the caller's resolved Owner_Id.
5. THE Notifications_API SHALL fan out over the resolved Owner_Id's Deployment_Registry records
   only, and THE `notificationsSince` RPC SHALL re-check the passed Owner_Id against the instance's
   stamped owner and SHALL return an empty payload on a mismatch.
6. THE Backup_Store SHALL key metadata rows by Owner_Id and SHALL store bodies under
   `backup/{Owner_Id}/{workflowId}/{revision}`.
7. THE Backup_Store SHALL record each body's storage key on the metadata row, so an ownership
   transfer changes the owner column without rewriting or re-uploading an R2 object.
8. THE Worker_Host SHALL write every `usage` row and every usage ledger entry against the resolved
   Owner_Id.
9. THE Worker_Host SHALL treat one `tenants` row per Owner_Id as the single quota bucket, so tier
   allowance, run count and credit consumption are shared by every member of an organisation.
10. THE Worker_Host SHALL attach every credit grant to the Owner_Id tenant row, and a member's run
    SHALL draw from the organisation's grant pool.
11. THE provisioning route SHALL accept an organisation Owner_Id and SHALL provision the runtime key
    and tier against that row.
12. THE Worker_Host SHALL send the caller's User_Id as the Stripe client reference and SHALL NOT
    send an Org_Id, because self-serve subscription is a personal-account capability and an
    organisation is invoiced by Phorma Labs instead (Requirement 19).
13. WHERE the Worker_Host runs in BYO mode, every consumer named in this requirement SHALL behave
    exactly as before this feature existed.

### Requirement 19: Personal and organisation billing stay separate

**User Story:** As a solo user, I want my own subscription and credits to stay mine even when I also
work inside a managed organisation, so that an organisation never bills, absorbs or replaces my
personal account.

Delivered with Phase 0, alongside Requirement 4.

#### Acceptance Criteria

1. THE Worker_Host SHALL keep one `tenants` row per Owner_Id, and a personal Owner_Id row and an
   organisation Owner_Id row SHALL be fully independent: their own tier, status, quota rollup, credit
   grants and runtime key.
2. THE Worker_Host SHALL NOT transfer, merge or copy a subscription, a tier, a credit grant or a
   Stripe customer between a personal Owner_Id and an organisation Owner_Id in either direction, on
   any path, including the ownership claim of Requirement 3.
3. WHERE the resolved Owner_Id is a personal User_Id, THE Worker_Host SHALL keep every self-serve
   billing route behaving exactly as it does before this feature exists.
4. IF a self-serve billing request resolves an organisation Owner_Id, THEN THE Worker_Host SHALL
   refuse it with Refusal_Code `billing_managed` and SHALL NOT create a Stripe Checkout Session, a
   Stripe Customer or a Billing Portal session for that Owner_Id.
5. THE Worker_Host SHALL provision an organisation's tier and status through the Super_Admin route
   family only, and an organisation tenant SHALL reach an entitled state with no Stripe object in
   existence.
6. THE Entitlement_Gate SHALL read an organisation Owner_Id's own tier, status and quota, so a
   member's run is allowed or refused on the organisation's entitlement and never on that member's
   personal one.
7. THE Studio SHALL present every self-serve billing surface only while the active Owner_Id is the
   caller's personal User_Id, and SHALL present those surfaces as ABSENT rather than refused while an
   organisation Owner_Id is active - the same absence rule a BYO deployment already gets.
8. WHILE an organisation Owner_Id is active, THE Studio SHALL render that organisation's plan and
   remaining credits as read-only and SHALL name Phorma Labs as the party that manages the
   organisation's billing, so a member reads an absent Subscribe action as intended rather than
   broken.
9. THE Worker_Host SHALL accept both id shapes on the provisioning write path, and SHALL KEEP the
   narrower `user_...` validation on every Stripe-supplied id path, because an organisation Owner_Id
   can never legitimately arrive from Stripe.
10. WHERE an organisation needs a higher ceiling than its tier allowance, THE Super_Admin SHALL
    change that organisation's tier, and THE Worker_Host SHALL NOT introduce a credit grant that
    carries no Stripe payment id, so `credit_grants` keeps its payment-keyed uniqueness.
11. THE Worker_Host SHALL NOT issue, number or store an invoice: an organisation's invoicing happens
    in Stripe, operated by Phorma Labs, exactly as the sales-led enterprise tier does today.
12. THE Refusal_Code set introduced by this requirement SHALL be append-only, comprising
    `billing_managed`.

---

## Phase 1 - The capability contract and its enforcement

### Requirement 5: Named capability levels as an append-only contract

**User Story:** As a product owner, I want four named capability levels with an append-only wire
contract, so that a fifth level or a new capability never breaks an older studio.

#### Acceptance Criteria

1. THE Capability_Contract SHALL declare exactly four Capability_Level tokens in increasing order:
   `operator`, `editor`, `builder`, `admin`.
2. THE Capability_Contract SHALL grant the `operator` level the right to trigger a run, monitor a
   run, approve and answer gates, and read runs, traces, usage and notifications, and SHALL grant
   the `operator` level no write capability beyond answering a gate.
3. THE Capability_Contract SHALL grant the `editor` level every `operator` capability plus the
   right to change prompt text, schedule cron expressions, node configuration and connection secret
   values within an existing graph, and SHALL NOT grant the `editor` level the right to change graph
   structure or to create a workflow.
4. THE Capability_Contract SHALL grant the `builder` level every `editor` capability plus the right
   to create a workflow, change graph structure, deploy, manage connections, manage evals and manage
   the portal, scoped to the builder's own organisation.
5. THE Capability_Contract SHALL grant the `admin` level every `builder` capability plus member
   management and billing. Both are declared at the level regardless of whether a route exercises them
   in this release: `billing.manage` is reachable only over a personal Owner_Id (Requirement 19.4) and
   `member.manage` is reachable over no route at all (Requirement 13.7), and a released token is never
   renamed or repurposed to reflect that.
6. THE Capability_Contract SHALL define the level comparison such that a higher level holds every
   capability of every lower level.
7. THE Worker_Host and THE Studio SHALL each hold a copy of the Capability_Contract as a structural
   twin, and the twin pair SHALL be named in the `structure` steering file in the same change.
8. WHEN the Worker_Host resolves a Capability_Level, THE Worker_Host SHALL read the Clerk
   organisation role claim of the verified credential.
9. IF a credential carries an organisation claim and an absent or unrecognised role claim, THEN THE
   Worker_Host SHALL refuse the request with Refusal_Code `role_unknown`.
10. WHERE a credential carries no organisation claim, THE Worker_Host SHALL resolve the
    `admin` Capability_Level over the caller's personal Owner_Id, so a single-user install keeps
    every capability it had before this feature existed.
11. THE Capability_Level token set SHALL be append-only, and no released token SHALL be renamed or
    repurposed.

### Requirement 6: Server-side capability enforcement as one seam

**User Story:** As a security reviewer, I want every write to pass through one capability check, so
that a new route cannot ship without enforcement.

#### Acceptance Criteria

1. THE Worker_Host SHALL expose exactly one Role_Gate function that takes an `AuthContext` and a
   required Capability_Level and returns either an authorized identity or a refusal response.
2. THE Worker_Host SHALL call the Role_Gate from every API route that writes state and from every
   Workflow_Agent path that writes state.
3. THE Worker_Host SHALL allow every read route to every Capability_Level, including `operator`.
4. WHEN a spec push or a deployment delete arrives, THE Role_Gate SHALL require the `builder`
   Capability_Level.
5. WHEN a connection secret value write, a prompt text change, a cron change or a node configuration
   change arrives, THE Role_Gate SHALL require the `editor` Capability_Level.
6. WHEN a billing request arrives, THE Role_Gate SHALL require the `admin` Capability_Level AND the
   resolved Owner_Id SHALL be the caller's personal User_Id (Requirement 19.4), so the level check
   alone is never what protects a billing route.
7. WHEN a trigger, an approval or a correlated event arrives, THE Role_Gate SHALL require the
   `operator` Capability_Level.
8. IF the caller's Capability_Level is below the level the Role_Gate requires, THEN THE Worker_Host
   SHALL answer 403 with Refusal_Code `role_forbidden` and SHALL name the required level in the
   response body.
9. THE Worker_Host test suite SHALL enumerate every write route and SHALL assert that each one is
   covered by the Role_Gate, so a new unguarded write route fails the suite.
10. THE Refusal_Code set introduced by this requirement SHALL be append-only, comprising
    `role_forbidden` and `role_unknown`.
11. THE Worker_Host SHALL treat the Role_Gate as the security boundary, independent of any Studio
    side gating.

### Requirement 7: The Studio capability seam

**User Story:** As a maintainer, I want one frontend whose surfaces subtract by capability, so that
selling the studio tier later is the same code path rather than a second application.

#### Acceptance Criteria

1. THE Studio SHALL hold the caller's resolved Capability_Level in the Capability_Service.
2. THE Capability_Service SHALL inject no service on the run transport path and SHALL NOT inject
   `CloudService`, so the service stays a dependency injection leaf and cannot close a circular
   dependency.
3. THE Studio SHALL declare a minimum Capability_Level on each Panel_Registry tab entry, and THE
   Panel_Registry SHALL filter registered tabs by the resolved Capability_Level, so restriction is
   subtractive rather than conditional.
4. THE Studio SHALL read capability decisions only through the Capability_Service, and no component,
   template or service outside the capability module SHALL compare a Capability_Level token
   literal.
5. THE Capability_Guard SHALL fail when a Capability_Level token literal appears in a comparison, a
   conditional or a default value outside the capability module and its own tests, and SHALL permit a
   declared minimum level on a Panel_Registry tab entry or an Action_Registry action entry, because a
   declared minimum is data while a comparison is a decision.
6. THE Capability_Guard SHALL follow the structure of `scripts/check-telemetry-isolation.mjs` and
   SHALL be added to `.github/workflows/ci.yml` in the same change.
7. WHEN the resolved Capability_Level changes during a session, THE Studio SHALL recompute every
   capability-derived surface without a page reload.
8. THE Studio SHALL ship as ONE application for every Capability_Level, and no second Angular
   project SHALL be created for members.

### Requirement 8: Capability gating of the studio action registry

**User Story:** As a member, I want the assistant to offer only the capabilities I hold, so that the
assistant never proposes an action that will be refused.

#### Acceptance Criteria

1. THE Action_Registry SHALL declare a minimum Capability_Level on every action entry.
2. WHEN the Studio derives the Agent-mode tool list, THE Studio SHALL omit every action above the
   resolved Capability_Level, so a refused capability is absent rather than failing at execution.
3. WHEN the Studio derives a plan operation set or an assistant system prompt, THE Studio SHALL
   include only actions at or below the resolved Capability_Level.
4. WHILE the resolved Capability_Level is below `builder`, THE Studio SHALL NOT offer the plan apply
   path for an action above that level.
5. THE Worker_Host SHALL re-gate every action that reaches an API route through the Role_Gate, so an
   omission in the Action_Registry is not the security boundary.
6. THE Action_Registry SHALL keep its existing confirmation tiers unchanged, and capability gating
   SHALL compose with those tiers rather than replace them.

---

## Phase 2 - Member surfaces

### Requirement 9: Cloud library mode

**User Story:** As an operator or editor in a customer organisation, I want to open my
organisation's deployed workflows in a browser, so that I need no desktop install, no local library
and no keychain.

#### Acceptance Criteria

1. WHILE the resolved Capability_Level is `operator` or `editor`, THE Studio SHALL present the
   Cloud_Library, listing the organisation's deployed workflows from the Deployments_API.
2. WHEN a member opens a deployed workflow from the Cloud_Library, THE Studio SHALL read the
   deployed spec from the Workflow_Agent and SHALL open a read-only document tab.
3. WHEN the Studio opens a deployed spec, THE Studio SHALL preserve the deployed spec's own id
   rather than minting a new id, so the open document addresses the same workflow as the deployment.
4. WHILE the Studio runs in Cloud_Library mode, THE Studio SHALL NOT create or read a local
   workflow library, and SHALL NOT persist a workflow spec, a prompt body or a connection secret
   value to IndexedDB or to any local storage.
5. WHILE the Studio runs in Cloud_Library mode, THE Studio SHALL NOT call any operating system
   keychain path, and SHALL submit every connection secret value through the connection secrets
   route.
6. THE Cloud_Library SHALL work with no Tauri runtime present.
7. THE Studio SHALL load the Cloud_Library behind a lazy route or a deferred block, so the initial
   bundle does not grow by the size of the surface.
8. IF the Deployments_API request fails, THEN THE Studio SHALL report the failure and SHALL NOT
   present an empty list as an organisation with no deployments.

### Requirement 10: Member run, watch and approve

**User Story:** As an operator, I want to run a deployed workflow, watch the run and answer its
gates, so that I can do my job without a builder present.

#### Acceptance Criteria

1. WHEN a member triggers a deployed workflow, THE Workflow_Agent SHALL run the workflow through the
   existing trigger path and SHALL bill the organisation's quota bucket.
2. THE Studio SHALL render a member's run from RunEvents only, and no new visualisation contract
   SHALL be introduced for members.
3. WHEN a member watches a run, THE Studio SHALL use the existing WebSocket monitor of the
   Workflow_Agent.
4. WHEN a member answers an approval or supplies a correlated event, THE Workflow_Agent SHALL settle
   the pending gate through the existing suspension endpoints.
5. WHEN the Workflow_Agent settles a gate from a member action, THE Workflow_Agent SHALL record the
   acting User_Id alongside the outcome.
6. THE Studio SHALL show a member the organisation's runs, traces, usage and notifications through
   the existing owner-scoped routes.
7. WHERE the Phorma Cloud share of a run's cost is non-zero, THE Studio SHALL render that share as
   plan credits, and SHALL render only the BYO share in United States dollars.

---

## Phase 3 - Proposals

### Requirement 11: The proposal store

**User Story:** As an organisation admin, I want an editor's change held as a proposal, so that a
deployed workflow only changes when a builder publishes the change.

#### Acceptance Criteria

1. THE Worker_Host SHALL hold each Proposal as one Proposal_Store row carrying the Owner_Id, the
   workflow id, the author User_Id, the Proposal_Status, a revision integer, the Canonical_Spec_Hash
   of the proposed spec, the Canonical_Spec_Hash of the live spec at creation time, the body storage
   key and creation and update timestamps.
2. THE Proposal_Status field SHALL take exactly one of `pending`, `published`, `rejected` and
   `superseded`, and that set SHALL be append-only.
3. THE Worker_Host SHALL store every Proposal body under the Proposal_Body_Store prefix, and SHALL
   NOT write a Proposal body under the Backup_Store prefix.
4. THE Worker_Host SHALL serialize a Proposal body as JSON, then gzip, then AES-GCM, then R2, in
   that order.
5. IF the encryption key binding is absent, THEN THE Worker_Host SHALL refuse the Proposal with
   Refusal_Code `proposal_unencrypted` and SHALL NOT store an unencrypted body.
6. WHEN a Proposal is created or transitioned, THE Worker_Host SHALL apply the change with a
   conditional update guarded on the row's current revision, and SHALL treat the reported changed
   row count as the single-winner signal.
7. IF a conditional update reports no changed row, THEN THE Worker_Host SHALL answer 409 with
   Refusal_Code `proposal_conflict` and SHALL include the current revision in the response body, so
   the losing caller can retry against a truth.
8. THE Worker_Host SHALL validate that the workflow id in the request path equals the spec id in the
   submitted body, and SHALL refuse a mismatch.
9. THE Worker_Host SHALL rebuild a submitted Proposal body from validated fields rather than storing
   the received object as-is.
10. WHEN a Proposal is created, THE Worker_Host SHALL NOT call the Workflow_Agent, so creating a
    Proposal cannot mutate a deployed spec.
11. THE Worker_Host SHALL keep at most the ten most recent non-pending Proposals per workflow and
    SHALL destroy older Proposal bodies, and each path that destroys a Proposal body SHALL be named
    in the proposal route module.
12. WHERE the Worker_Host runs in BYO mode, the proposal surface SHALL be absent, answering 404
    rather than an error naming a missing binding.

### Requirement 12: Propose and publish

**User Story:** As an editor, I want to save a prompt or configuration change and hand the change to
a builder, so that my work reaches production through a review.

#### Acceptance Criteria

1. WHILE the resolved Capability_Level is `editor`, WHEN the member saves a change to prompt text, a
   cron expression, node configuration or a connection secret name within an existing graph, THE
   Studio SHALL submit the change as a Proposal and SHALL NOT push the spec.
2. IF an `editor` submission changes the graph structure or the set of workflows, THEN THE
   Worker_Host SHALL refuse the Proposal with Refusal_Code `proposal_scope` and SHALL name the
   disallowed change.
3. WHEN the Studio or the Worker_Host compares a proposed spec against the live spec, THE comparing
   side SHALL compute the Canonical_Spec_Hash of both specs after the same default materialization,
   so a proposal comparison compares like with like.
4. THE default materialization used for a Canonical_Spec_Hash SHALL be reachable as a pure function
   from a module with no dependency on `CloudService`, so no service on the transport path needs to
   inject `CloudService` to compare a spec.
5. WHEN a Proposal is accepted for a workflow that already holds a `pending` Proposal, THE
   Worker_Host SHALL set the existing Proposal to `superseded` in the same conditional update that
   accepts the new Proposal, so exactly one `pending` Proposal exists per workflow.
6. WHEN a builder or admin views a Proposal, THE Studio SHALL show the difference between the
   proposed spec and the live spec, grouped by the changed field.
7. WHEN a builder or admin publishes a Proposal, THE Worker_Host SHALL run the ordinary spec push
   path, including the existing validation, the existing default materialization and the existing
   Deployment_Registry write.
8. WHEN a push initiated by a publish is accepted, THE Worker_Host SHALL set the Proposal to
   `published`, and IF the push is refused, THEN THE Worker_Host SHALL leave the Proposal `pending`.
9. IF the live spec's Canonical_Spec_Hash differs from the hash recorded when the Proposal was
   created, THEN THE Worker_Host SHALL refuse the publish with Refusal_Code `proposal_stale` and
   SHALL include the current live hash.
10. WHEN a builder or admin rejects a Proposal, THE Worker_Host SHALL set the Proposal to `rejected`
    with an optional reason and SHALL retain the Proposal body until the retention limit prunes the
    body.
11. WHEN a Proposal is published or rejected, THE Worker_Host SHALL surface a notification to the
    author through the existing notification centre, using an appended notification kind.
12. THE proposal Refusal_Code set SHALL be append-only, comprising `proposal_scope`,
    `proposal_stale`, `proposal_conflict` and `proposal_unencrypted`.

---

## Phase 4 - Administration and support

### Requirement 13: Organisation and member management

**User Story:** As a super admin, I want to create organisations and hand members their capability
levels, so that I can onboard a customer without touching a database.

#### Acceptance Criteria

1. THE Worker_Host SHALL expose an organisation management route family behind the existing
   Operator_Gate, and SHALL NOT re-implement the 401 and 403 split that gate owns.
2. THE Operator_Gate SHALL keep its existing rules on the new route family: an absent bearer answers
   401, a non-Clerk credential kind answers 403, and a missing allowlist secret grants no access.
3. WHEN a Super_Admin creates an organisation, THE Worker_Host SHALL create the Clerk organisation
   and SHALL provision one `tenants` row keyed by the organisation Owner_Id.
4. WHEN the Worker_Host provisions a `tenants` row for a new organisation, THE Worker_Host SHALL NOT
   grant a paid tier implicitly.
5. WHEN a Super_Admin invites a member, THE Worker_Host SHALL record exactly one Capability_Level
   for that member in that organisation.
6. THE Worker_Host SHALL let a Super_Admin list organisations, list an organisation's members,
   change a member's Capability_Level and remove a member.
7. THE Worker_Host SHALL NOT expose an organisation-facing member management route in this release:
   organisation creation and every membership write SHALL be reachable through the Operator_Gate
   alone, so exactly one surface writes membership. THE `member.manage` capability SHALL stay
   declared in the Capability_Contract and exercised by no route, because a released token is never
   renamed or repurposed (Requirement 5.11) and an organisation-facing route is a later feature.
8. THE Admin_Console SHALL present organisation and member management using the existing shared view
   classes, and SHALL add no new stylesheet rules that breach the dashboard bundle budget.
9. IF a capability change request names a Capability_Level token the Worker_Host does not recognise,
   THEN THE Worker_Host SHALL refuse the request with Refusal_Code `role_unknown`.

### Requirement 20: Owner switching

**User Story:** As a user who has a personal account and also belongs to a managed organisation, I
want to choose which of the two I am working in, so that one account covers both without signing out
and without losing my own workflows.

Delivered in Phase 4, AFTER Requirement 13, because switching can only offer memberships that
something else created - and the only thing that creates one is the Super_Admin route family.

#### Acceptance Criteria

1. THE Studio SHALL present the caller's available owners - the personal account plus every
   organisation the caller is already a member of - and SHALL let the caller make one of them the
   ACTIVE Owner_Id.
2. THE Studio SHALL show the active Owner_Id wherever the account is identified, so the owner a
   workflow will deploy into is legible BEFORE the deploy rather than after it.
3. WHERE the caller belongs to no organisation, THE Studio SHALL present no switching surface at all,
   so a solo install gains no control it has no use for.
4. THE switching surface SHALL be available in both the browser and the desktop shape of the Studio,
   and SHALL require no Tauri runtime.
5. WHEN the active Owner_Id changes, THE Studio SHALL re-resolve the Capability_Level and the account
   profile from the Worker_Host and SHALL recompute every capability-derived surface without a page
   reload.
6. WHEN the active Owner_Id changes, THE Studio SHALL reset every owner-scoped session state it
   holds, including the notification read cursor, the accumulated notifications, the pending-action
   list and the deployment list, so no state belonging to the previous owner is presented as the new
   owner's.
7. WHEN the active Owner_Id changes, THE Studio SHALL close every document tab opened from the
   previous Owner_Id, because a document tab addresses a workflow id INSIDE one owner and the same id
   means a different workflow under another.
8. IF a document holds unsaved changes when a switch is requested, THEN THE Studio SHALL confirm
   through the existing confirm rail before switching and SHALL NOT discard the change silently.
9. WHEN the caller switches back to a previously active Owner_Id, THE Studio SHALL present that
   owner's surfaces as they were before the switch, and a switch SHALL NOT read, write or delete any
   local library entry, prompt, skill, credential or keychain item belonging to another owner.
10. THE Worker_Host SHALL NOT resolve an organisation Owner_Id named by a request unless the caller's
    membership of that organisation is verified server-side ON THAT REQUEST, so switching can never
    address an organisation the caller does not belong to.
11. IF the caller's membership of the active organisation is revoked, THEN the next request SHALL
    resolve as though the caller never named it, and THE Studio SHALL fall back to the personal
    Owner_Id - so a removed member loses reach without waiting for a credential to expire.
12. THE Super_Admin SHALL be the only party that creates an organisation and assigns a member to one,
    so the switching surface SHALL offer only memberships that already exist and SHALL NOT offer
    organisation creation, organisation naming or self-join.
13. THE Studio SHALL record the Owner_Id a locally stored workflow, run record and usage row belongs
    to, and SHALL present the local library, local run history and the usage panel for the ACTIVE
    Owner_Id only, because credits are the unit those surfaces render and a surface that mixes two
    payers is a billing surface reporting a number that belongs to nobody.
14. WHEN the Studio adds that Owner_Id to a local store, THE Studio SHALL bump the IndexedDB schema
    version and SHALL migrate every existing row to the Owner_Id in force before this feature existed,
    so no locally stored workflow, run or usage row becomes unreachable.
15. WHERE a local row carries no Owner_Id, THE Studio SHALL read it as belonging to the caller's
    personal Owner_Id, so a row written by an older build stays visible to the account that wrote it.

### Requirement 14: Read-only audited impersonation

**User Story:** As a super admin doing support, I want to see exactly what a customer sees without
being able to change or spend anything, so that support reach is never a write path.

#### Acceptance Criteria

1. THE Worker_Host SHALL resolve an impersonated Owner_Id through an Impersonation_Resolver that is
   separate from the Operator_Gate, because the Operator_Gate deliberately returns no identity.
2. THE Worker_Host SHALL read the impersonation target from a dedicated request header.
3. THE Worker_Host SHALL honour that header only when the caller is a Super_Admin AND the credential
   kind is `clerk`.
4. IF the header is present on a request from a caller who is not a Super_Admin, THEN THE
   Worker_Host SHALL ignore the header entirely and SHALL serve the request as the caller's own
   Owner_Id, so probing the header reveals nothing.
5. WHILE a request is impersonated, THE Worker_Host SHALL refuse every write path with Refusal_Code
   `impersonation_read_only`.
6. WHILE a request is impersonated, THE Entitlement_Gate SHALL refuse hosted inference with
   Refusal_Code `impersonation_read_only`, so an impersonated request spends no credits.
7. THE Worker_Host SHALL enforce the read-only rule at the gateway layer AND inside the
   Workflow_Agent, so neither layer alone is the boundary.
8. WHEN an impersonated request is accepted, THE Worker_Host SHALL write exactly one
   Impersonation_Audit row recording the acting User_Id, the impersonated Owner_Id, the request
   method, the request path and the time.
9. WHEN an impersonation header is ignored or refused, THE Worker_Host SHALL write no
   Impersonation_Audit row.
10. IF the Impersonation_Audit write fails, THEN THE Worker_Host SHALL refuse the request with
    Refusal_Code `impersonation_unaudited`, so an unaudited impersonated read never happens.
11. THE Impersonation_Audit SHALL be append-only, and THE Worker_Host SHALL expose the audit to a
    Super_Admin as a read-only list.
12. THE Studio SHALL offer no impersonation surface, and impersonation SHALL be reachable from the
    Admin_Console only.
13. THE Worker_Host SHALL hold no impersonation session state, so every impersonated request carries
    the header.
14. WHERE a Super_Admin needs to build inside a customer organisation, that Super_Admin SHALL hold a
    real Clerk organisation membership with a Capability_Level, and SHALL NOT reach a write path
    through impersonation.
15. THE Refusal_Code set introduced by this requirement SHALL be append-only, comprising
    `impersonation_read_only` and `impersonation_unaudited`.

---

## Phase 5 - Preparation for per-workflow pricing

### Requirement 15: Entitlement gate prepared for per-workflow pricing

**User Story:** As a product owner, I want the entitlement gate to already know which workflow is
running, so that per-workflow pricing later is a policy change rather than a signature change.

#### Acceptance Criteria

1. THE Entitlement_Gate SHALL accept an optional workflow id argument, so every existing call site
   keeps compiling.
2. WHEN `/api/infer` calls the Entitlement_Gate on behalf of a deployed or local run whose workflow
   id is known, THE Worker_Host SHALL pass that workflow id.
3. WHEN the Workflow_Agent calls the Entitlement_Gate, THE Workflow_Agent SHALL pass the deployed
   workflow's id.
4. THE Entitlement_Gate SHALL append exactly one Refusal_Code, `workflow_not_entitled`, to its
   existing append-only Refusal_Code set, SHALL NOT rename or repurpose any code already in that set,
   and SHALL NOT return the appended code in this release.
5. WHEN the Studio receives a Refusal_Code it does not recognise, THE Studio SHALL render the
   refusal's prose and SHALL NOT fail to render the surface.
6. THE Worker_Host SHALL NOT add a workflow catalogue, a per-workflow meter or an entitlement table
   in this release.
7. THE Entitlement_Gate SHALL remain the only hosted inference entitlement check, called from
   `/api/infer` and from the Workflow_Agent trigger path.

---

## Non-functional requirements

### Requirement 16: Wire contract and twin discipline

**User Story:** As a maintainer, I want every contract this feature adds to be append-only and
twinned explicitly, so that a worker change cannot silently break the studio.

#### Acceptance Criteria

1. THE repository SHALL contain no em dash in code, comment, document, commit message or user-facing
   string introduced by this feature, and SHALL use a plain hyphen instead.
2. Every Refusal_Code set this feature introduces SHALL be append-only, and no released code SHALL
   be renamed or repurposed.
3. THE `structure` steering file SHALL name the Capability_Contract twin pair and the proposal wire
   twin pair alongside the existing structural twins, in the same change that creates each pair.
4. WHEN a Capability_Level, a Proposal_Status or a proposal wire field changes in the Worker_Host
   copy, THE same change SHALL update the Studio copy.
5. THE Worker_Host SHALL keep the `AuthContext` `kind` field semantics unchanged, so a desktop token
   still cannot reach an operator surface.
6. THE Worker_Host SHALL keep every new route's behaviour in BYO mode either identical to today or
   absent, and SHALL NOT require a BYO worker to bind a new secret to keep working.

### Requirement 17: Product invariants preserved

**User Story:** As a user, I want the studio to keep the properties it has today, so that the pivot
costs me nothing I already rely on.

#### Acceptance Criteria

1. THE Studio SHALL run under a plain development server with no Tauri runtime present, and every
   native call SHALL stay behind the existing desktop guard.
2. THE Studio SHALL render every icon this feature adds from the Tabler icon font.
3. THE Studio SHALL render every dialog this feature adds as a bespoke overlay carrying
   `role="dialog"`, and SHALL NOT introduce a PrimeNG dialog component.
4. THE Studio SHALL render the Phorma Cloud share of any cost as plan credits, and SHALL render only
   the BYO share in United States dollars.
5. THE Studio SHALL keep raw secret values out of the webview on desktop, and SHALL continue to see
   only a boolean for a stored desktop key.
6. THE Studio SHALL consume RunEvents as the only run visualisation contract, for members and
   builders alike.
7. THE Studio SHALL render every prompt body as sanitized markdown.

### Requirement 18: Verification and budget

**User Story:** As a maintainer, I want the new surfaces covered in continuous integration and
inside the existing bundle budget, so that the pivot does not degrade the build.

#### Acceptance Criteria

1. WHEN this feature adds a test suite or a guard script, THE same change SHALL add that suite or
   script to `.github/workflows/ci.yml`.
2. THE Capability_Guard SHALL run in continuous integration alongside the existing guard scripts.
3. THE Studio production build SHALL keep the initial bundle below the 3 megabyte budget error
   threshold, against the 2.87 megabyte current figure.
4. WHEN this feature adds a Studio surface, THE Studio SHALL load that surface behind a lazy route
   or a deferred block, so the initial bundle does not grow by the size of the surface.
5. THE Worker_Host test suite SHALL cover organisation isolation at both layers, the ownership claim
   path, the Role_Gate coverage of every write route, the proposal single-winner concurrency and the
   impersonation read-only refusals.
6. THE Worker_Host test suite SHALL place every new D1-backed suite after the existing D1-backed
   suites and SHALL route each new worker handle and each new D1 handle through the existing
   loopback retry wrappers.
7. THE Studio test suite SHALL cover the Capability_Service resolution, the capability filtering of
   the Panel_Registry and the capability filtering of the Action_Registry derived tool list.
