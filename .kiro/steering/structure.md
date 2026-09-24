---
inclusion: always
---

# Project structure

```
phorma-agent-studio/
├─ agent.md                  # product source of truth
├─ .github/
│  ├─ agent-memory.md        # accumulated repo memory (read + append, see workflow.md)
│  ├─ copilot-instructions.md
│  └─ skills/                # skill packs for GitHub Copilot (see skills.md steering)
├─ .agents/skills/           # skill packs synced by skills-lock.json
├─ .kiro/
│  ├─ steering/              # THIS directory - Kiro's persistent context
│  └─ specs/                 # spec-driven features (requirements -> design -> tasks)
├─ docs/                     # long-form guides (e2e-testing, portal, integrations, research)
├─ engine/                   # @phorma/engine - pure TS run engine + its tests
├─ frontend/                 # Angular 20 studio
├─ backend/src-tauri/src/    # Rust desktop shell
├─ cloud/src/                # Cloudflare Worker + WorkflowAgent Durable Object
├─ mcp/phorma-practice-mcp/  # framework-free MCP server (accounting-firm tools)
└─ scripts/                  # release.mjs, publish-r2.mjs, rust build helpers
```

## Frontend layout

- `frontend/src/app/core/` - all services and models. Workflow model and service, run controller,
  transports, storage, settings, cloud, assistant, evals, portal, usage, skills, history.
- `frontend/src/app/layout/` - toolbar, sidebars, document tabs, bottom terminal.
- `frontend/src/app/shared/` - confirm dialog, expanded panel dialog, markdown, toast, icons,
  info popover, directives.
- `frontend/src/app/workspace/` - canvas plus one folder per feature surface: palette, prompt,
  properties, runs, evals, usage, portal, skills, workflows, cloud-library, assistant,
  command-palette, cloud, connections, onboarding, settings.
- `frontend/src/styles.scss` - CSS variables, theme surfaces, and the shared utility classes
  (`.phorma-panel-icon-btn`, `.phorma-input-icon-btn`, `.phorma-btn-content`, `.phorma-icon-spin`).

Panels register themselves as tabs in `DEFAULT_TABS` (`core/panel-registry.service.ts`) with
`{id, side, order, visible}` plus an optional `minLevel`. Both sidebars receive every pane template
in `app.html`; only tabs matching `sideTabs()` render - which means **two instances of every panel
body are in the DOM at once**. Consequences: element ids must be scoped, and DOM queries in tests
must filter for the visible one (`getBoundingClientRect().width > 0`).

`minLevel` is a declared minimum `CapabilityLevel` and is DATA: the only comparison happens in the
`leftTabs` / `rightTabs` computeds, through `CapabilityService.allows(tab.minLevel)`, so restriction
is subtractive rather than conditional. Filter in the COMPUTED, never in `_tabs` - `loadTabs()`
merges the saved side, order and visibility onto `DEFAULT_TABS` and an effect persists `_tabs`, so
dropping an entry there would delete it from the user's saved layout and a member later promoted
would lose their arrangement. A surface that OFFERS tabs to the user (the Window menu) reads
`allowedTabs()`, which keeps hidden-but-allowed tabs; `tabs()` stays the unfiltered record.
`scripts/check-capability-isolation.mjs` fails on a level token compared anywhere outside
`core/capabilities.ts` and `core/capability.service.ts`, and permits a `minLevel:` declaration.

## Admin dashboard layout (`admin/`)

Four concerns behind one shell: five telemetry aggregate views, a Spend view over the billing route
family, an Organisations view over the organisation management family, and an Impersonation view that
is BOTH the only way to read a customer's account as that customer and the record of every time
anybody did.

- `admin/src/app/core/admin-api.ts` - the ONE transport. Owns the session-token funnel (the branded
  `SessionToken`, `SESSION_TOKEN_RESOLVER`, `clerkSessionTokenResolver`), the `AdminResult` union, the
  two auth signals (`forbidden`, `sessionRejected`) and `ACT_AS_HEADER`. All four feature services go
  through it, because one operator allowlist gates all four prefixes on the Worker. Four entry points -
  `get(url, range)` for a ranged aggregate, `read(url, params)` for a read that is not about a window,
  `mutate(method, url, {body, params})` for a write, `sendActingAs(url, ownerId, params)` for a read
  served as ANOTHER owner - and ONE private `send`, so the bearer header is still built in exactly one
  place. That matters most on the write half, where a blank bearer would be a membership change rather
  than a blank card, and on the act-as half, where a stray header is honoured SILENTLY.
  `sendActingAs` is GET-only and has no `mutate` twin: the Worker refuses every other method, so a
  write control would exist only to be refused.
- `telemetry-api.service.ts`, `billing-api.service.ts`, `org-api.service.ts` and
  `impersonation-api.service.ts` - a prefix plus typed methods each, nothing more. None of them
  validates or maps anything: the Worker owns every refusal. The telemetry one RE-EXPORTS everything
  from `admin-api.ts` so the views and specs that already imported those names from it keep working.
  The impersonation one is the only service that calls `sendActingAs`, and it is the only one whose two
  methods read two DIFFERENT route families - the `/api/admin/*` audit, and `/api/deployments` as the
  customer.
- `core/models.ts`, `core/billing-models.ts`, `core/org-models.ts` and `core/impersonation-models.ts` -
  response shapes, each a structural twin of its Worker module, and each with a DIFFERENT disclosure
  contract: `models.ts` bodies carry no identity by construction, `billing-models.ts` bodies name
  paying tenants on purpose, `org-models.ts` bodies name individual PEOPLE by Clerk user id because
  "who is in this organisation and at what level" is not answerable without them, and
  `impersonation-models.ts` bodies name a person AND WHAT THEY READ, which is the strongest of the
  four. Do not merge them.
- `views/` - one folder per view. The nav (`app.ts` `VIEW_NAV`) and the router (`app.routes.ts`) DERIVE
  the five telemetry entries from `TELEMETRY_ROUTES`, so a sixth aggregate route cannot compile without
  a nav entry and a loader. Spend, Organisations and Impersonation are appended EXPLICITLY, because
  each reads several API routes and so has no single route to derive a path from. Their view ids are
  `spend`, `organisations` and `impersonation`, deliberately not `costs`, `members` or `audit`, so one
  word does not mean both a URL segment and one of the things behind it. Impersonation is LAST in the
  nav because it is the surface an operator should reach for least often: every use of it names a
  person in a permanent record.
- Organisations is the dashboard's only WRITE surface, and the only surface in the whole product that
  writes membership (Requirement 13.7 of `multi-organisation-phorma`). Two conventions it establishes:
  a destructive action is a TWO-STEP inline arm-then-confirm, because this package has no
  `ConfirmDialogService` and the repo has zero `p-dialog`; and a write reports the WORKER's own
  sentence, never a local one, because the two answers an operator must act on - `role_unknown` and
  `org_partial_write` - are only distinguishable from the Worker's body.
- Auth surfaces in `auth/`: `signed-out` (no Clerk session), `session-rejected` (a token we sent was
  refused - 401), `not-authorized` (403). Three screens because the remedies differ, and the shell
  orders them in that sequence.
- The "Obsidian glow" visual language lives entirely in `admin/src/styles.scss`: glass `.admin-card`,
  `.admin-kpis`, `.admin-split`/`.admin-pair`, `.admin-chip`, `.admin-figure`, the shared form classes
  (`.admin-form`, `.admin-field`, `.admin-label`, `.admin-id`, `.admin-sr`), tables, and every chart
  class. Component `styles:` blocks carry page LAYOUT only. Budget: 1.5MB warning against ~875kB.
- Views are built from `views/kit/` (`AdminKpi` - keeps the `.admin-stat*` classes specs read,
  `AdminDelta`, `AdminHint`, `AdminData`) and `views/charts/` (SVG, no chart.js). Rules they encode:
  - NO explainer text on the page. Standing copy goes in an `AdminHint` tooltip, which also renders it
    `.admin-sr` so assistive tech and `textContent` specs still read it. Only FUNCTIONAL status (a
    degraded read, a caveat, the impersonation "nothing deployed" warning) stays visible, as a chip.
  - Raw tables live behind `AdminData` ("View data", a native `<details>`) as `GroupTable
    [framed]="false"`, so the "every label reaches the DOM" property still holds.
  - A request that only ENRICHES a view (previous-period deltas via `DateRangeService.previousRange`,
    a sparkline series) goes through `enrichment()` in `views/secondary.ts`: it never throws, so it
    cannot move the view out of `loaded`. Specs match requests by route AND range (`pending(m, route,
    range)`), and `finish` fails leftover enrichments.
  - Per-day charts are laid onto every calendar day (`alignDays` in `views/series.ts`), so a folded
    day is a gap, never a zero and never silently bridged.
- `npm run preview` swaps `app/preview/preview.ts` for `preview.fixtures.ts` (fixture HttpBackend,
  fake Clerk session). The prod bundle carries none of it - check with a grep for `FixtureBackend`.
  Watch out for one trap in an inline `styles:` or `template:` block: a BACKTICK inside a comment
  terminates the template literal, and Angular reports it as
  `Failed to resolve @Component.styles to a string` with no line number.

## Structural twins - keep in sync

The engine and the studio each declare the workflow contract independently. They are structural
twins, not shared imports:

- `engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts`
- `cloud/src/telemetry-admin.ts` and `admin/src/app/core/models.ts`
- `cloud/src/billing-admin.ts` and `admin/src/app/core/billing-models.ts`
- `cloud/src/impersonation.ts` and `admin/src/app/core/impersonation-models.ts` - the audit READ half
  only. `ACT_AS_HEADER` is also twinned, but into `admin/src/app/core/admin-api.ts` rather than the
  model file, because it is a property of the transport and one place builds a request. Everything
  else in the worker module is worker-only by design: the two refusal codes, the guard, the
  substitution and the audit write. `SupportDeploymentRow` there is a THIRD independent declaration of
  a shape `cloud/src/deployments.ts` and `frontend/src/app/core/deployments.model.ts` already twin -
  accepted, because impersonation lives in `admin/` and nowhere else, so that package has to name the
  shape it reads.
- `cloud/src/org-admin.ts` and `admin/src/app/core/org-models.ts` - the WIRE half only.
  `OrgAdminRefusalCode`, `UNPAID_ORG_STATUS`, the Clerk role mapping and every handler are
  worker-only. Deliberately NOT twinned: the Capability_Level VOCABULARY. The worker reports
  `levels` and `tiers` on every read and the dashboard renders what it is told, because a third
  independent copy of the level tokens would have no test comparing all three -
  `cloud/test/capabilities.test.mjs` compares exactly two. A `level` is a plain `string` in the
  dashboard on purpose.
- `cloud/src/capabilities.ts` and `frontend/src/app/core/capabilities.ts` - the `CapabilityLevel`
  tokens, the `Capability` tokens, `CAPABILITIES_BY_LEVEL` and `atLeast`. `CLERK_ROLE_LEVELS` is
  WORKER-ONLY and deliberately not twinned: a role claim exists only on a verified credential, and
  the studio is TOLD its level by `/api/me`. `cloud/test/capabilities.test.mjs` loads both modules
  and compares behaviour, not text, so a one-sided edit fails there rather than drifting.
- `cloud/src/deployments.ts` and `frontend/src/app/core/deployments.model.ts`
- `cloud/src/backup-routes.ts` and `frontend/src/app/core/backup.model.ts`
- `cloud/src/notifications.ts` and `frontend/src/app/core/notifications.model.ts` - the WIRE half
  only. Everything below `NotificationsResponse` in the studio file (`StudioNotification`,
  `NotificationKind`, `PendingActionRow`) is studio-only and has no worker counterpart by design.
  `NotificationsResponse.proposals` is part of the wire half and its element type lives in the
  PROPOSAL twin below, not restated here.
- `cloud/src/proposals.ts` and `frontend/src/app/core/proposals.model.ts` - `ProposalStatus`,
  `ProposalSummary`, `ProposalConnectionRef`, `ProposalNotice` and the four append-only refusal
  codes (`proposal_scope`, `proposal_stale`, `proposal_conflict`, `proposal_unencrypted`). The WIRE
  half only: `ProposalSubmitOutcome` and the label/icon helpers below it in the studio file are
  studio-only, and `ProposalStore`, `scopeViolations`, `doomedProposals` and `canonicalSpecHashOf`
  are worker-only. A status or a code is persisted in D1 and rendered by a studio that may be three
  versions old, so both sets are append-only: never rename or repurpose one.
- `frontend/public/logo.svg` and `PHORMA_MARK_SVG` in `cloud/src/brand-page.ts` - `cloud/` cannot
  import from `frontend/`, so the brand mark is hand-copied. A brand change edits both.

Node kinds, node data interfaces, `WorkflowSettings`, and `ModelProviderId` exist in BOTH. Adding
or changing one without the other compiles in one package and breaks the other.

## Adding a node kind (registry pattern)

Node kinds are data plus strategy - the canvas is registry-driven and normally needs zero changes.

1. Kind union and data interface in `engine/src/types.ts` AND `core/workflow.model.ts`.
2. Catalog entry in `core/node-catalog.ts` (palette, drag, instantiation all read from it).
3. Executor branch in the `runNodeBody` switch in `engine/src/engine.ts`.
4. Editor in the properties panel.
5. Canvas changes ONLY for a genuinely new visual state (for example mapping a new waiting state
   to the amber breathing ring in `canvas-graph-renderer.ts`).

Adding an MCP preset is a single entry in `MCP_PRESETS` (`core/node-catalog.ts`); palette,
properties panel, settings Integrations, and the Rust stdio spawn path all pick it up.

System One UI is deferred so it stays out of the initial bundle (the budget is tight): node
config in `workspace/properties/decision-config/` (router, approval gate, decide, portal
guardrails), agent config in `workspace/prompt/agent-decisions/`, palette assists in
`workspace/palette/palette-assist/`, run triage in `workspace/runs/run-triage/`. Each is mounted
with `@defer` and gated on `DecisionTransportService.available()`. Studio-side question builders
live in `core/studio-assist.ts` and are loaded with a dynamic `import()`. A new System One node
setting goes in `decision-config`, not in the properties form.

## Connector packaging (P1-14)

A connector is one `*.connector.json` declaring a connection template, pre-configured data steps,
mapping tables and optional starter workflows. Format, validation, packaging and every derivation
live in `engine/src/connectors.ts` (pure, property-tested); the studio adds storage and install in
`core/connectors.service.ts` over the IndexedDB `connectors` store.

- Installed steps are NOT in `NODE_CATALOG`. They resolve through a one-function seam:
  `registerConnectorStepResolver` in `core/node-catalog.ts`, installed by `ConnectorsService`, and
  consulted by `findCatalogEntry` for `connector-step:` ids exactly like the `mcp-preset:` branch.
  That seam exists to avoid a DI edge from `WorkflowService` into `ConnectorsService`, which would
  close a cycle through `ConnectionsService`.
- Instantiating a step yields an ORDINARY data node with no back-reference, so removing a connector
  cannot break a workflow built from it. Do not add provenance fields to node data to "fix" this.
- A bundle never carries a secret value, and installing never sets `Connection.allowWrites`.
  `validateConnectorBundle` rejects a credential in any position rather than sanitizing it.
- Adding a built-in connector is one entry in `BUILTIN_CONNECTOR_BUNDLES`
  (`core/connectors-builtin.ts`); built-ins are derived at read time and never persisted. Validate
  them with `npx -y tsx engine/test/connectors-builtin.e2e.mts`.

## Adding an assistant capability (action registry pattern)

`core/studio-actions/` is the single description of every studio capability the AI assistant can
execute. All three assistant modes dispatch through it: Agent mode as live tools, Plan mode as
`{op:'action'}` Plan_Ops, Ask mode as the read-only subset.

1. Add one entry to the owning surface's `actions()` (`eval-actions.service.ts`,
   `run-actions.service.ts`, `prompt-actions.service.ts`, `workflow-actions.service.ts`,
   `skill-actions.service.ts`, `connection-actions.service.ts`, `portal-actions.service.ts`,
   `usage-actions.service.ts`, `settings-actions.service.ts`, `graph-actions.service.ts`,
   `web-actions.service.ts`).
2. Delegate the executor to the Owning_Service. The registry never reimplements a capability.
3. Pick the tier: `confirm` for credit spend, deletion, deploy, and settings or connection writes;
   `silent` for reads and local reversible document edits.
4. Declare `minLevel`, the minimum `CapabilityLevel`. It is ORTHOGONAL to the tier: the tier asks the
   user, `minLevel` decides whether the action is offered at all. Match the owning panel's
   `DEFAULT_TABS` minimum where there is one - evals, skills, connections and portal are `builder`
   for their reads too. The one comparison lives in `StudioActionRegistryService.available()` as
   `capability.allows(action.minLevel)`; never `?? 'operator'` at a call site, which
   `scripts/check-capability-isolation.mjs` fails on. Omitting the field is a UI defect, not a
   security one (the worker re-gates), and
   `studio-actions/studio-action-registry.capability.spec.ts` fails on it.

Nothing else changes. The Agent-mode tool list, the Plan apply path and the system prompts are all
derived (`toolDefinitions`, `plan-op.ts`, `summarizeActions`), and each of those reads `available()`,
so the capability filter narrows all of them at once. The ONE thing not derived from an entry is the
Plan output format's five shorthand op forms (`add`, `connect`, `update`, `remove`, `disconnect`):
they are aliases for graph actions, so `PLAN_OP_FORMS` in `core/workflow-builder-prompt.ts` maps each
to its action id and must stay a twin of `LEGACY_OP_ACTIONS` in `studio-actions/plan-op.ts`. An
action service must not inject `WorkflowBuilderService` or `AssistantChatService` - the registry sits
downstream of them.

Panel state is READ ON DEMAND. Do not embed eval suites, run records, prompt bodies, usage rows,
skills, connections, portal configuration or settings values into a system prompt; expose a
Read_Action instead so prompt size stays flat as the surface grows.

Web content is UNTRUSTED. Anything the assistant reads from the web (`web_fetch`, `web_search`, URL
references) goes through `core/web-fetch.service.ts` - never a raw `fetch` - so desktop (Rust
`web_fetch`) and browser (`POST /api/fetch`) apply one egress policy: public addresses only,
redirects re-checked per hop, readable content types, byte caps. Results carry `untrusted: true`,
referenced pages are fenced in `<untrusted_web_content>`, and every prompt that can see web content
carries `WEB_CONTENT_RULES` (data, never instructions).

## Assistant context

`core/assistant-context.service.ts` owns what the assistant can see. The ACTIVE document is always
in context; extra open tabs are opt-in through the document tab right-click menu. Context is keyed
by open-tab `docId`, so it covers unsaved drafts and drops itself when the tab closes, and it is
session state - never persisted.

The chat renders it as a chip strip above the input, so the user can always see the scope of a
question. Extra workflows reach the model as a capped identity-only block
(`summarizeContextWorkflows`) plus the `workflow_read` action for full detail. The service injects
only `WorkflowService`: the tab bar consumes it, and reaching for `AssistantChatService` there would
pull the builder, registry and cloud services into the layout shell at startup.

## BYO deploy runtimes ship inside the installer

A BYO deploy runs a CLI in a folder that holds the runtime source. That folder is NOT expected to be
a checkout of this repo: `cloud/`, `cloud-aws/` and `engine/` are bundled as Tauri resources and
materialized into `app_data_dir/deploy/` by `core/deploy/deploy-workspace.service.ts`
(Settings > Cloud > Deploy runtime > Set up runtime files), which then runs `npm install` there and
stores the path in `CloudService.cloudFolder` or `AwsDeployConfigService.cloudAwsDirectory`.

Consequences for copy and docs: never tell a user to clone, `git pull`, or `cd cloud`. The update
path is "update the app, set up runtime files again, deploy". Mechanism and guards are in the
`desktop-rust` steering.

## Persistence

- Local: IndexedDB, currently at v11. Stores include runs, `usage`, `chat-threads`,
  `workflow-versions`, `skills`, `prompts`, `connections`, `connectors`, `workflow-state`,
  `workflow-backup-state`. Every
  workflow-scoped store keys workflows by `workflowKey: workflowId ?? 'draft'`.
  Bumping the schema means bumping the version and adding a migration.
- Layout and small settings: `localStorage` via `core/layout-storage.ts`
  (`phorma.layout.*` keys, `loadLayout`/`saveLayout`).
- Cloud: Durable Object embedded SQLite (`run_journal`, `usage_ledger`, workflow state) via the
  Agents SDK `this.sql` tagged template.
- Secrets: OS keychain through `llm.rs`. Keychain scopes for MCP are
  `mcp:{nodeId}:{envKey}` (node override) and `mcp:preset:{presetId}:{envKey}` (app default).

## Recovery: deployments and cloud backup

Two independent surfaces, both about a workflow surviving the machine it was built
on. Spec: `.kiro/specs/cloud-workflow-backup/`.

- **A Durable Object namespace cannot be enumerated.** That is why `PortalIndex` carries a third key
  space, `deploy:{ownerId}:{workflowId}` (`DEFAULT_DEPLOYMENT_OWNER` is the literal `default` in
  BYO). It is written by `WorkflowAgent` ALONE - on an accepted `POST /workflow`, on
  `DELETE /workflow`, in `purgeSelf(true)`, and backfilled from held state on any wake - so the list
  stays correct for a studio that crashed, was uninstalled or is three versions old. The studio never
  writes it.
- **A backup is not a mirror.** A local library delete sends NOTHING to the cloud; it only drops the
  local `workflow-backup-state` row. An explicit delete sets `deleted_at` (a tombstone whose bodies
  stay restorable for 30 days). Exactly three paths destroy backup data - the 10-revision prune, an
  explicit purge of a tombstone, and disable-and-delete-all - and each is named in `backup-routes.ts`
  so a fourth cannot appear by accident.
- **Restore preserves identity.** `WorkflowService.restoreSpec` keeps the spec's `id`;
  `importSpec` still mints a fresh one. An import is a copy, a restore is the same workflow arriving
  from elsewhere, and restoring under a new id leaves the original deployment as orphaned as before.
- **Two dispatchers, one route table.** `DeploymentsService` and `WorkflowBackupService` PIN
  `DEPLOY_TARGETS.phorma`, because a subscriber deploying to AWS still has a hosted account.
  `CloudService` resolves the chosen target. Both go through `dispatchCloudOperation`
  (`core/deploy/cloud-dispatch.ts`) so the plumbing exists once. `cloud.service.spec.ts` names the
  Phorma-pinned operations explicitly and drives every other one, so a new `CloudService` operation
  cannot compile without coverage.
- Backup is hosted-only and sits BELOW the `store.enabled` gate; `/api/deployments` sits ABOVE it,
  because the registry lives in a DO that BYO binds too. A BYO install gets the file-based
  `LibraryExportService` instead, and that is deliberate: "bring your own everything" means
  durability without a subscription.

## The notification centre

The toolbar bell, left of the account control. Present for every SIGNED-IN account;
only the deployed feed is subscription-gated.

- **Poll, not push.** `GET /api/notifications?since=` (`cloud/src/notifications.ts`) reads the
  `deploy:` registry then fans out over each deployment by **RPC** (`WorkflowAgent.notificationsSince`),
  capped at `NOTIFY_FANOUT_MAX`. RPC and not `stub.fetch()`, because a worker-to-DO fetch carries no
  `Authorization` header and would trip `authorized()`. D1 cannot serve this at all: `usage` has no
  run-outcome column.
- **Four services, and the split is a DI constraint.** `NotificationsService` is a bare signal store
  because `RunControllerService` injects it, so it must reach nothing on the transport path.
  `DeployedNotificationsService` owns the poll and copies `DeploymentsService`'s shape exactly (pins
  `DEPLOY_TARGETS.phorma`, `loadPhormaCloudUrl()`, `dispatchCloudOperation`, no `CloudService`).
  `NotificationCenterService` merges them and is injected only by components and the action registry.
  `notification-projection.ts` holds every pure decision.
- **Notifications ACCUMULATE, pending actions are REPLACED.** A settled run is history: merged
  idempotently on `{workflowId}:{runId}:{kind}`, which is what lets the deployed feed be re-derived
  instead of persisted. A pending gate is live Durable Object memory: replaced wholesale per poll,
  because a merged list leaves a phantom "needs your approval" row that resolves to nothing.
- **The read marker IS the poll cursor.** `markAllRead()` is the only thing that advances it, and it
  is the `?since=` value - so an unread notification survives a restart with nothing persisted but a
  number, and no IndexedDB store. `add()` PINS `at` on a re-merge, or a timestamp-less kind
  (a deployment's `settingsIssues`) goes unread again on every tick.
- **A failed poll replaces nothing.** Going offline must not read as "everything got resolved".
- Deep-linking is a settable seam (`deepLinkHandler`, installed by `App`), because it needs
  `CloudService` and the centre must not inject it. Same idiom as
  `RunControllerService.remoteApprovalSender`.

## Known dependency-injection hazard

Circular DI (NG0200) exists around the run path:
`RunControllerService -> ModelTransportService -> PhormaCloudService -> CloudService -> RunControllerService`.
`CloudService` legitimately injects `RunControllerService`, so **services on the transport path
must not inject `CloudService`**. Read the Phorma Cloud base URL with `loadPhormaCloudUrl()` from
`core/phorma-cloud-url.ts` - a leaf module that also owns `PHORMA_CLOUD_DEFAULT_URL` and migrates
installs off retired hosts. `WorkflowVersionsService` deliberately injects only storage for the
same reason.

`CapabilityService` (`core/capability.service.ts`) is the strictest case: it injects **nothing at
all**, and `scripts/check-capability-isolation.mjs` keeps it that way. `PanelRegistryService`
injects it and the layout shell reads that registry at startup, so anything it reached would be
constructed during the first frame. The resolved level is PUSHED in through `resolveFrom(level)` by
whoever already holds the verified `/api/me` answer - the same settable-seam idiom as
`RunControllerService.remoteApprovalSender` and `NotificationCenterService.deepLinkHandler` - which
is also what makes a mid-session level change one signal write with no reload. Do not add
`ClerkService` here: `user$` emits `null` for a signed-in desktop install, and `ClerkService` itself
injects `Router`.
