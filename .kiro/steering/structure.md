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

## Structural twins - keep in sync

The engine and the studio each declare the workflow contract independently. They are structural
twins, not shared imports:

- `engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts`

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

## Persistence

- Local: IndexedDB, currently at v7. Stores include runs, `usage`, `chat-threads`,
  `workflow-versions`. Every store keys workflows by `workflowKey: workflowId ?? 'draft'`.
  Bumping the schema means bumping the version and adding a migration.
- Layout and small settings: `localStorage` via `core/layout-storage.ts`
  (`phorma.layout.*` keys, `loadLayout`/`saveLayout`).
- Cloud: Durable Object embedded SQLite (`run_journal`, `usage_ledger`, workflow state) via the
  Agents SDK `this.sql` tagged template.
- Secrets: OS keychain through `llm.rs`. Keychain scopes for MCP are
  `mcp:{nodeId}:{envKey}` (node override) and `mcp:preset:{presetId}:{envKey}` (app default).

## Known dependency-injection hazard

Circular DI (NG0200) exists around the run path:
`RunControllerService -> ModelTransportService -> PhormaCloudService -> CloudService -> RunControllerService`.
`CloudService` legitimately injects `RunControllerService`, so **services on the transport path
must not inject `CloudService`**. Read the Phorma Cloud base URL with
`loadLayout('phormaCloudUrl', PHORMA_CLOUD_DEFAULT_URL)` instead.
`WorkflowVersionsService` deliberately injects only storage for the same reason.
