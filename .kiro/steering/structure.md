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
  properties, runs, evals, usage, portal, skills, workflows, assistant, command-palette, cloud,
  connections, onboarding, settings.
- `frontend/src/styles.scss` - CSS variables, theme surfaces, and the shared utility classes
  (`.phorma-panel-icon-btn`, `.phorma-input-icon-btn`, `.phorma-btn-content`, `.phorma-icon-spin`).

Panels register themselves as tabs in `DEFAULT_TABS` (`core/panel-registry.service.ts`) with
`{id, side, order}`. Both sidebars receive every pane template in `app.html`; only tabs matching
`sideTabs()` render - which means **two instances of every panel body are in the DOM at once**.
Consequences: element ids must be scoped, and DOM queries in tests must filter for the visible
one (`getBoundingClientRect().width > 0`).

## Admin dashboard layout (`admin/`)

Two concerns behind one shell: five telemetry aggregate views, and a Spend view over the billing
route family.

- `admin/src/app/core/admin-api.ts` - the ONE transport. Owns the session-token funnel (the branded
  `SessionToken`, `SESSION_TOKEN_RESOLVER`, `clerkSessionTokenResolver`), the `AdminResult` union, and
  the two auth signals (`forbidden`, `sessionRejected`). Both feature services go through it, because
  one operator allowlist gates both prefixes on the Worker.
- `telemetry-api.service.ts` and `billing-api.service.ts` - a prefix plus typed methods each, nothing
  more. The telemetry one RE-EXPORTS everything from `admin-api.ts` so the views and specs that
  already imported those names from it keep working.
- `core/models.ts` and `core/billing-models.ts` - response shapes, each a structural twin of its
  Worker module. `models.ts` bodies carry no identity by construction; `billing-models.ts` bodies name
  tenants on purpose. Do not merge them.
- `views/` - one folder per view. The nav (`app.ts` `VIEW_NAV`) and the router (`app.routes.ts`) DERIVE
  the five telemetry entries from `TELEMETRY_ROUTES`, so a sixth aggregate route cannot compile without
  a nav entry and a loader. The Spend view is appended EXPLICITLY, because it reads two API routes and
  so has no single route to derive a path from. Its view id is `spend`, deliberately not `costs`, so one
  word does not mean both a URL segment and one of the two routes behind it.
- Auth surfaces in `auth/`: `signed-out` (no Clerk session), `session-rejected` (a token we sent was
  refused - 401), `not-authorized` (403). Three screens because the remedies differ, and the shell
  orders them in that sequence.
- Every shared class already exists in `admin/src/styles.scss` (`.admin-view`, `.admin-grid`,
  `.admin-card`, `.admin-stat`, `.admin-table`, `.admin-footnote`, `.admin-columns`). A new view should
  add no SCSS; the budget is 1.5MB warning against ~791kB.

## Structural twins - keep in sync

The engine and the studio each declare the workflow contract independently. They are structural
twins, not shared imports:

- `engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts`
- `cloud/src/telemetry-admin.ts` and `admin/src/app/core/models.ts`
- `cloud/src/billing-admin.ts` and `admin/src/app/core/billing-models.ts`
- `cloud/src/deployments.ts` and `frontend/src/app/core/deployments.model.ts`
- `cloud/src/backup-routes.ts` and `frontend/src/app/core/backup.model.ts`
- `cloud/src/notifications.ts` and `frontend/src/app/core/notifications.model.ts` - the WIRE half
  only. Everything below `NotificationsResponse` in the studio file (`StudioNotification`,
  `NotificationKind`, `PendingActionRow`) is studio-only and has no worker counterpart by design.
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
   `usage-actions.service.ts`, `settings-actions.service.ts`, `graph-actions.service.ts`).
2. Delegate the executor to the Owning_Service. The registry never reimplements a capability.
3. Pick the tier: `confirm` for credit spend, deletion, deploy, and settings or connection writes;
   `silent` for reads and local reversible document edits.

Nothing else changes. The Agent-mode tool list, the Plan apply path and the system prompts are all
derived (`toolDefinitions`, `plan-op.ts`, `summarizeActions`). An action service must not inject
`WorkflowBuilderService` or `AssistantChatService` - the registry sits downstream of them.

Panel state is READ ON DEMAND. Do not embed eval suites, run records, prompt bodies, usage rows,
skills, connections, portal configuration or settings values into a system prompt; expose a
Read_Action instead so prompt size stays flat as the surface grows.

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
