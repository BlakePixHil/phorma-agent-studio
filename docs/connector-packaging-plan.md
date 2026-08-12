# Plan: P1-14 Connector packaging

Source item: `docs/integrations-and-aws-deployment.md` §P1-14, deferred out of the
`deterministic-data-path` spec until the Phase 1 primitives were real. They now are, so the thing
this was waiting on is done.

This is a plan, not a spec. It fixes the decisions and the order of work; requirement numbering and
acceptance criteria are deliberately absent.

**Status: implemented 2026-08-12.** All six phases landed, with one item dropped on purpose (the
properties-panel provenance display - see Phase 3). Durable rules from this work now live in the
`structure` steering; the war stories are in `.github/agent-memory.md`.

## What a connector is

A **connector** is one shareable JSON file that turns "here is how you talk to system X" into
something a user installs in seconds instead of rebuilding. It declares, in one bundle:

| Part | Materializes as |
|---|---|
| Connection template | a `Connection` (type, non-secret `config` fields, secret key NAMES, `auth` mode) |
| Steps | pre-configured `http-request` / `sql-query` / `transform` / `aggregate` nodes |
| Mapping tables | `TransformNodeData.lookups` content, shared by every step in the bundle |
| Starter workflows | full `WorkflowSpec`s wired from the steps above |

Nothing in a bundle is new capability. Every part materializes into an entity that already exists,
already deploys, already runs on all three hosts. That is the whole point: packaging is a
distribution feature, not a runtime feature, so the engine, the cloud worker and the Rust shell need
**zero changes**.

### The decision test

- **Faster**: an API-fronted sync goes from "author eight nodes and read the vendor docs" to "install,
  paste one key, run". This is the single biggest idea-to-running-agent win left in the data path.
- **Simpler**: the canvas still shows plain data nodes. A connector leaves no special node kind, no
  opaque box, nothing an ops owner cannot read. Uninstalling a connector does not break a workflow
  built from it, because the nodes were never owned by it.
- **Powerful**: the mapping table and pagination config that took an afternoon to get right become
  shareable, and the studio gains an ecosystem surface with the skills library as precedent.

## Decisions

These are the calls worth disagreeing with before code exists.

**1. One file, `*.connector.json`, format version 1.**
Matches both precedents: a skill is one `.md`, a workflow is one `.phorma.json`. A multi-file bundle
buys nothing and costs a container format. `format: 1` plus an optional `minAppVersion` so an old
build refuses a newer bundle with a sentence instead of a stack trace.

**2. Steps are their own palette sub-section, not `NODE_CATALOG` entries.**
`MCP_PRESETS` already proves the palette can render a second registry with its own drag payload
prefix (`mcp-preset:`). Connector steps copy that exactly with `connector-step:`, resolved at drop
time. `NODE_CATALOG` stays a compile-time array and no existing consumer of it changes. The rejected
alternative was a `NodeCatalogService.entries()` seam merging runtime entries in, which touches the
palette, the drag service, instantiation, the prompt-library built-ins and the assistant for the same
user-visible result.

**3. The bundle format lives in `engine/src/connectors.ts`.**
Pure declaration plus parse, validate and serialize, sitting beside `connections.ts` which it depends
on. The engine does not consume it and esbuild drops it from the worker bundle. It goes there anyway
because that is where vitest and fast-check live, and the load-bearing invariant of this feature -
*a bundle can never carry a secret* - deserves a property test rather than a code review.

**4. Connectors are a section of the Connections panel, not a new panel tab.**
A connector is how a connection gets set up, so it belongs where connections are. Follows the
Workflows panel's collapsible Templates section. No `DEFAULT_TABS` change, no `ActionSurface` change.

**5. Install never installs trust.**
- A bundle carries secret key NAMES only. `Connection.secretKeys` is already name-only, so this falls
  out of the existing type rather than needing a new rule.
- `allowWrites` is never set by an install. Writes stay opt-in on the connection, chosen by the person
  whose credential it is. A bundle whose steps need writes says so at install time and still leaves
  the flag off.
- The install preview shows the declared egress hosts (`collectEgressHosts`) and runs
  `validateAgainstCapabilities` for the current host, so a bundle cannot silently install steps this
  host cannot execute.
- A bundle that carries a value in a secret position is rejected outright, not sanitized. Silent
  sanitization teaches authors to keep shipping secrets.

## Out of scope for this pass

No remote registry, marketplace, or HTTP fetch of bundles. No signing or checksums. No auto-update of
installed connectors. No new node kinds. No cloud or Rust changes. Install is local and manual, the
same way a skill import is today. A registry is the obvious follow-up and the format should not
prevent it, but shipping distribution before the format has survived real use is how you get stuck
with a bad format.

## Phases

Each phase ends green on the checks in the `tech` steering that its files touch.

### Phase 1 - the format (engine, pure)

`engine/src/connectors.ts` and `engine/src/connectors.spec.ts`.

- `CONNECTOR_FORMAT_VERSION`, `CONNECTOR_ID_PATTERN` (`cx-` prefixed, mirroring `conn-`).
- `ConnectorBundle`: `{ format, id, name, description?, version, author?, icon?, minAppVersion?,
  connection: ConnectorConnectionTemplate, steps: ConnectorStep[], tables?, workflows? }`.
- `ConnectorConnectionTemplate`: `type`, `configFields: ConnectorConfigField[]` (name, label,
  description?, placeholder?, required?, default?), `secretFields: ConnectorSecretField[]` (name,
  label, description?, docsUrl?), `auth: ConnectionAuth`, `needsWrites?: boolean`, `limits?`.
  `ConnectorSecretField` is shaped after `McpEnvField`, the one existing declared-credential schema.
- `ConnectorStep`: `{ id, label, description?, icon?, keywords?, kind, data }` where `kind` is
  restricted to the four packageable data kinds and `data` is the matching node data with
  `connectionId` absent.
- `parseConnectorBundle(text)`, `validateConnectorBundle(bundle)` returning positioned findings,
  `serializeConnectorBundle`, `connectorFileName`.
- `secretPositionsOf(bundle)` and the rejection rule behind decision 5.
- Property tests: round-trip stability; validation totality (never throws on arbitrary JSON); and the
  named claim **a valid bundle contains no secret value in any position**, generated against
  arbitrary bundles with secret-shaped strings injected.

Verify: `cd engine; npm test` plus the type-only check with the frontend's tsc.

### Phase 2 - storage and install (frontend core, no UI)

- IndexedDB v9 to v10 with a `connectors` store (keyPath `id`, no index, cross-workflow, same shape as
  `skills`). One migration in `indexed-db-storage.service.ts`.
- `core/connectors.service.ts`: `installed` signal, `refresh`, `install(bundle)`, `remove(id)`,
  `byId`, `steps` computed. Built-in bundles derive read-only from a compile-time array at read time
  and are never persisted, with a `builtin:` id prefix, copying `prompt-library.model.ts`.
- `install` materialization: create the `Connection` through `ConnectionsService.create` with
  `allowWrites` off, register steps and tables, report which secret fields are still missing.
  Reuse an existing connection of the same type when the user picks one instead of minting a second.
- No palette or panel wiring yet, so this phase is verifiable by build plus a `window.__phormaTest`
  install-and-list round trip.

Verify: `cd frontend; npm run build`.

### Phase 3 - authoring surfaces

- Connections panel: **Connectors** as a bottom-pinned collapsible expander, the same shape as the
  runs panel's History and the workflows panel's Templates, with install and package actions in its
  header and per-row status meta (bound connection, "Needs apiToken"). The connection list above
  grows, so the expander stays reachable with no connections and with many. Hover-revealed row
  actions use the collapsing `__row-actions` container, per the skills panel pattern.
- Install preview dialog: bespoke overlay with `role="dialog"`, showing what installs, which secrets
  are needed, declared egress hosts, capability findings, and a warning when `needsWrites` is set.
- Palette: **Connector Steps** sub-section under Data, drag payload `connector-step:<connectorId>:<stepId>`,
  click-to-add supported (Playwright cannot reach hover submenus, and the palette keeps that path
  working deliberately).
- Properties panel: **dropped deliberately.** The plan originally called for showing a step-derived
  node's originating connector as read-only provenance. That cannot be done honestly: decision 2
  leaves no back-reference on the node, so provenance could only be *inferred* by matching node data
  against installed steps - and that inference starts lying the moment the user edits the node, which
  is immediately, because editing it is the point. The properties panel already shows what matters
  (the bound connection, and capability findings for it), so it needs no change.

Verify: `cd frontend; npm run build`, plus a browser pass through `window.__phormaTest` per the
`testing` steering. Duplicate-id check on any shared panel body (`document.querySelectorAll('[id]')`
total equals unique count).

### Phase 4 - packaging out

The half that makes the ecosystem real: **Package as connector** from the active workflow or a node
selection. Pick the connection, pick the steps, name and version the bundle, emit the file with
secrets and `connectionId` references stripped. `subworkflow-extract.ts` is the graph-slice precedent
for the selection mechanics. Blob download in browser (defer `revokeObjectURL` with `setTimeout`),
Tauri file write on desktop.

Round-trip test: package a workflow, install the result into a clean state, confirm the steps
reproduce the same node data.

### Phase 5 - built-in connectors

One or two real ones, chosen to exercise the format rather than to look impressive: something with
cursor pagination, an idempotency key and a mapping table, and one SQL connector. Real bundles are the
only way to find out whether the format is right, which is exactly why the source doc refused to
design this before the primitives existed.

### Phase 6 - assistant actions and docs

- `connection-actions.service.ts`: `connector_list` (read, silent), `connector_install` (write,
  confirm), `connector_remove` (write, confirm). Step insertion goes in `graph-actions.service.ts` as
  `graphEdit: true`, since it edits the canvas and should reveal it.
- Update `structure` steering (registry list, IDB version), `docs/integrations-and-aws-deployment.md`
  (P1-14 no longer deferred), and append the paid-for gotchas to `.github/agent-memory.md`.

## Risks

- **Format churn.** Mitigated by shipping built-ins in the same pass and by refusing unknown
  `format` values loudly. Accepted: version 1 will probably need a version 2.
- **Untrusted bundle content.** A bundle is a URL and SQL declaration, which becomes egress at run
  time. Mitigated by the install preview, capability validation, writes staying opt-in, and the
  expression language already being total, pure and I/O-free.
- **Palette crowding.** The Data section grows with every installed connector. Watch it at three or
  more connectors; the fix is grouping steps under their connector, not truncating the section.
