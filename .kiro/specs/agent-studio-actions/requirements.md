# Requirements Document

## Introduction

The AI assistant can only edit the canvas graph. `WorkflowBuilderService.agentToolDefinitions()`
offers six tools (`get_workflow_state`, `add_node`, `update_node`, `remove_node`, `connect_nodes`,
`remove_connection`), `PlanOp` accepts only the five graph op forms
(`add | connect | update | remove | disconnect`), and every system prompt in
`workflow-builder-prompt.ts` casts the assistant as a graph architect. A request such as "create an
eval for me" therefore funnels into `add_node` and drops a node on the canvas, which is the reported
defect.

This feature introduces one Action_Registry that describes every executable Studio capability
(evals, run control, prompts, workflow library, versions, deploy, skills, connections, portal,
usage, settings, panel navigation, graph edits) as declarative Studio_Actions. All three assistant
modes consume that single registry: Agent_Mode calls Studio_Actions as live tools, Plan_Mode
proposes them as reviewable ops in the existing Apply card, and Ask_Mode receives the read-only
subset. Panel state is fetched on demand through Read_Actions rather than pushed into the system
prompt, so prompt size stays flat as the action surface grows. Each registry entry carries a
Risk_Tier so reads and cheap local writes execute silently while credit spend, deletions, deploys
and configuration writes route through Confirm_Service first.

Two related defects are in scope: the 120-character `prompt-gist` truncation in `summarizeGraph()`,
which makes "modify that specific prompt" unanswerable, and the `isAgentNode(node)` gate in
`update_node`, which silently discards prompt patches aimed at non-agent nodes.

### Out of Scope

- **New panels or new visual surfaces.** Studio_Actions drive the panels that already exist.
- **Engine changes.** `engine/` gains no registry import and the RunEvents visualization contract is
  unchanged.
- **Exposing the Action_Registry over MCP or to workflow agents at run time.** The registry serves
  the studio assistant only.
- **Autonomous scheduling.** No background or recurring assistant execution is introduced.
- **Feature-gating changes.** Agent_Mode and the Ctrl+P builder stay Phorma Cloud exclusive; Ask and
  Plan stay free.

## Glossary

- **Studio**: The Phorma Agent Studio frontend in `frontend/src/app/`.
- **Assistant**: The assistant chat surface (`AssistantChatService`, `WorkflowBuilderService`, the
  assistant panel and its expanded dialog) together with the Ctrl+P command-palette builder.
- **Ask_Mode**, **Plan_Mode**, **Agent_Mode**: The three `AssistantMode` values.
- **Action_Registry**: The new single registry of executable Studio capabilities, owned by the
  Studio frontend.
- **Studio_Action**: One Action_Registry entry: a stable id, a plain-language description, a JSON
  parameter schema, an Access_Class, a Surface, a Risk_Tier and an executor.
- **Access_Class**: `read` or `write`.
- **Read_Action**: A Studio_Action whose Access_Class is `read`.
- **Write_Action**: A Studio_Action whose Access_Class is `write`.
- **Graph_Action**: A Write_Action that mutates the canvas graph through
  `LocalAgentRouterService`.
- **Surface**: The Studio area a Studio_Action belongs to: `graph`, `evals`, `runs`, `prompts`,
  `workflows`, `versions`, `deploy`, `skills`, `connections`, `portal`, `usage`, `settings` or
  `navigation`.
- **Risk_Tier**: `silent` or `confirm`.
- **Action_Result**: The structured value every Studio_Action execution returns: `ok: true` plus a
  payload, or `ok: false` plus a single-sentence message.
- **Plan_Op**: One operation in a Plan_Mode edit plan (`PlanOp` in `assistant-chat.model.ts`).
- **Legacy_Plan_Op**: A Plan_Op persisted before this feature, whose `op` value is one of `add`,
  `connect`, `update`, `remove` or `disconnect`.
- **Action_Op**: The new Plan_Op form that carries a Studio_Action id and an arguments object.
- **Confirm_Service**: `ConfirmDialogService`, covering confirm and `prompt()` modes.
- **Edit_Session**: `AiEditSessionService`, which drives the Revert/Keep review bar.
- **Panel_Registry**: `PanelRegistryService`, which owns tab visibility and activation.
- **Owning_Service**: The existing Studio service that implements a capability, for example
  `EvalService`, `EvalRunnerService`, `RunControllerService`, `LocalAgentRouterService`,
  `WorkflowService`, `WorkflowVersionsService`, `CloudService`, `SkillsService`,
  `ConnectionsService`, `PortalService`, `UsageAnalyticsService`, `SettingsService`,
  `SettingsRegistryService` or `PromptLibraryService`.

## Requirements

### Requirement 1: One action registry as the single source of truth

**User Story:** As a studio operator, I want the assistant to work from one description of what the
studio can do, so that every assistant mode offers the same capabilities.

#### Acceptance Criteria

1. THE Action_Registry SHALL expose each Studio_Action with a unique stable id, a plain-language
   description, a JSON parameter schema, an Access_Class, a Surface, a Risk_Tier and an executor.
2. THE Action_Registry SHALL delegate every Studio_Action execution to the Owning_Service for that
   capability.
3. WHEN the Assistant executes a capability in Ask_Mode, Plan_Mode or Agent_Mode, THE Assistant
   SHALL dispatch the execution through the Action_Registry.
4. THE Action_Registry SHALL return an Action_Result for every execution attempt.
5. WHERE a Studio_Action requires a precondition that the current context lacks, THE
   Action_Registry SHALL return an Action_Result with `ok: false` and a message naming the missing
   precondition.
6. THE Action_Registry SHALL allow a new capability to be added as one registry entry plus its
   executor, with no edit to the Agent_Mode tool list, the Plan_Mode apply switch or the Ask_Mode
   prompt.
7. THE Action_Registry SHALL reside in `frontend/src/app/core/` and SHALL keep `engine/` free of
   Action_Registry imports.

### Requirement 2: Capability coverage across every studio surface

**User Story:** As a studio operator, I want to ask the assistant to do anything I can do by hand,
so that the chat is a real control surface and not a graph editor with a chat box.

#### Acceptance Criteria

1. THE Action_Registry SHALL provide Studio_Actions on Surface `evals` covering listing suites,
   reading one suite with its cases, creating a suite, adding a case, updating a case, removing a
   case, deleting a suite, starting a suite run through `EvalRunnerService.runSuite()`, cancelling a
   suite run and reading the latest suite results.
2. THE Action_Registry SHALL provide Studio_Actions on Surface `runs` covering starting a run,
   pausing or resuming a run, stepping a run, stopping a run, resetting a run, toggling a
   breakpoint, resolving an approval, resolving a question, listing recorded runs, reading one run
   record and loading a historical run, each through `RunControllerService`.
3. THE Action_Registry SHALL provide Studio_Actions on Surface `prompts` covering reading a node's
   complete prompt body, writing a node's prompt body, listing prompt-library entries, saving a
   prompt to the library and applying a library prompt to a node.
4. THE Action_Registry SHALL provide Studio_Actions on Surface `workflows`, `versions` and `deploy`
   covering listing library workflows, opening a workflow, creating a new workflow, saving the
   active workflow, deleting a workflow, listing versions of the active workflow, restoring a
   version, deploying the active workflow through `CloudService` and reading the deployment state.
5. THE Action_Registry SHALL provide Studio_Actions on Surface `skills` covering listing skills,
   reading one skill, creating a skill, updating a skill, deleting a skill, attaching a skill to an
   agent node and detaching a skill from an agent node.
6. THE Action_Registry SHALL provide Studio_Actions on Surface `connections` covering listing
   connections by id, display name and type, creating a connection, updating a connection's
   non-secret fields, deleting a connection and assigning a `connectionId` to a node.
7. THE Action_Registry SHALL provide Studio_Actions on Surface `portal` covering reading the portal
   configuration for the active workflow and updating the portal exposure of the active workflow.
8. THE Action_Registry SHALL provide Studio_Actions on Surface `usage` covering reading a usage
   summary for a requested period and reading the highest-cost nodes and workflows in that period.
9. THE Action_Registry SHALL provide Studio_Actions on Surface `settings` covering reading the
   non-secret values of settings declared in `SettingsRegistryService` and writing a declared
   setting value.
10. THE Action_Registry SHALL provide a Studio_Action on Surface `navigation` that reveals and
    activates a panel through `Panel_Registry` for any tab id in the set `agents`, `workflows`,
    `runs`, `skills`, `connections`, `prompt`, `properties`, `usage`, `evals`, `assistant`,
    `portal`.
11. THE Action_Registry SHALL provide Studio_Actions on Surface `graph` that preserve the behaviour
    of `get_workflow_state`, `add_node`, `update_node`, `remove_node`, `connect_nodes` and
    `remove_connection`.

### Requirement 3: Agent mode calls registry actions as live tools

**User Story:** As a subscriber using Agent mode, I want the assistant to act on any panel while I
watch, so that a multi-step request completes in one turn.

#### Acceptance Criteria

1. WHEN the Assistant starts an Agent_Mode turn, THE Assistant SHALL offer one tool definition per
   Studio_Action available in the current context, deriving the tool name, description and
   parameter schema from the Action_Registry entry.
2. WHEN the model emits a tool call, THE Assistant SHALL execute the matching Studio_Action through
   the Action_Registry and SHALL return the Action_Result to the model as JSON.
3. IF a tool call names an id absent from the Action_Registry, THEN THE Assistant SHALL return an
   Action_Result with `ok: false` naming the unknown id and SHALL continue the loop.
4. IF a tool call carries arguments that fail the Studio_Action parameter schema, THEN THE
   Action_Registry SHALL return an Action_Result with `ok: false` naming the invalid parameter and
   SHALL leave Studio state unchanged.
5. WHILE an Agent_Mode turn is running, THE Assistant SHALL emit one plain-language activity line
   per executed Studio_Action, naming the action and its outcome.
6. THE Assistant SHALL end an Agent_Mode turn after at most 12 model round trips.

### Requirement 4: Plan mode proposes registry actions for review

**User Story:** As a free-tier user, I want the assistant to propose panel changes I can review and
apply, so that I reach the same capabilities without a subscription.

#### Acceptance Criteria

1. THE Plan_Op type SHALL accept an Action_Op carrying a Studio_Action id and an arguments object,
   in addition to the five Legacy_Plan_Op forms.
2. WHEN the user applies a plan, THE Assistant SHALL dispatch every Plan_Op in the plan through the
   Action_Registry in plan order.
3. WHEN a persisted chat thread containing Legacy_Plan_Op values is loaded from the `chat-threads`
   store, THE Assistant SHALL deserialize each Legacy_Plan_Op and SHALL apply it with the behaviour
   it had before this feature.
4. THE Assistant SHALL render one plain-language line per Plan_Op in the proposal card, including
   lines for Action_Ops.
5. WHILE the Assistant runs in Plan_Mode inside the chat, THE Assistant SHALL hold the plan as a
   proposal until the user selects Apply.
6. WHILE the Assistant runs in Plan_Mode inside the Ctrl+P palette, THE Assistant SHALL apply the
   plan without a further user action.
7. WHERE a plan contains at least one Studio_Action with Risk_Tier `confirm`, THE Assistant SHALL
   request one grouped confirmation through Confirm_Service that lists those actions before
   playback begins.
8. IF a Plan_Op fails during playback, THEN THE Assistant SHALL stop playback, SHALL roll back the
   active Edit_Session and SHALL report the failing Plan_Op with the Action_Result message.

### Requirement 5: Panel detail is read on demand, not pushed into the prompt

**User Story:** As a studio operator, I want the assistant to look up the exact prompt, suite or run
it needs, so that answers are accurate and the request stays small.

#### Acceptance Criteria

1. THE Assistant system prompts SHALL list the available Studio_Action ids with their descriptions
   and Surfaces.
2. THE Assistant system prompts SHALL represent eval suites, run records, prompt bodies, usage rows,
   skills, connections, portal configuration and settings values by the matching Read_Action rather
   than by embedded state.
3. THE graph summary produced by `summarizeGraph()` SHALL identify each node by id, kind and display
   name and SHALL reference the prompt Read_Action for prompt bodies in place of a truncated
   `prompt-gist` fragment.
4. WHEN the prompt Read_Action executes for a node that carries a prompt, THE Action_Registry SHALL
   return the complete prompt body.
5. WHILE the Assistant runs in Ask_Mode, THE Assistant SHALL offer only Studio_Actions whose
   Access_Class is `read`.
6. WHEN a Read_Action executes, THE Action_Registry SHALL leave the workflow document, eval suites,
   run state, connections and settings unchanged.

### Requirement 6: Tiered guardrails before consequential actions

**User Story:** As a studio owner, I want a confirmation before the assistant spends credits,
deletes data or changes configuration, so that a misread request stays cheap and recoverable.

#### Acceptance Criteria

1. THE Action_Registry SHALL assign Risk_Tier `confirm` to every Studio_Action that starts a run,
   starts an eval suite run, deletes a suite, case, node, connection, skill, workflow or version,
   deploys to Cloudflare, or writes a setting or a connection.
2. THE Action_Registry SHALL assign Risk_Tier `silent` to every Read_Action and to each Write_Action
   whose effect is a local reversible change to the active document or to panel focus.
3. WHEN a Studio_Action with Risk_Tier `confirm` is invoked, THE Action_Registry SHALL obtain
   confirmation through Confirm_Service, using a summary that names the action and the affected
   objects by display name, before calling the Owning_Service.
4. IF the user declines a Risk_Tier `confirm` prompt, THEN THE Action_Registry SHALL return an
   Action_Result with `ok: false` and a message stating that the user declined, and SHALL leave
   Studio state unchanged.
5. THE Action_Registry SHALL exclude secret values from every Action_Result, reporting a
   keychain-backed or provider credential as a boolean presence flag.
6. WHERE an Action_Result reports cost, THE Studio SHALL render the Phorma Cloud share as plan
   credits and the bring-your-own share as USD.
7. THE Action_Registry SHALL read confirmation outcomes from the value Confirm_Service resolves
   with rather than from `activeState()`.

### Requirement 7: Reversibility is accurate

**User Story:** As a studio operator, I want to know exactly what I can undo after the assistant
acts, so that I trust the Revert control.

#### Acceptance Criteria

1. WHEN a turn executes at least one Graph_Action, THE Assistant SHALL run that turn inside an
   Edit_Session transaction so that the Revert and Keep controls appear after the turn.
2. WHEN a Graph_Action succeeds, THE Action_Registry SHALL record one Edit_Session entry naming the
   change.
3. IF a turn fails after a Graph_Action has mutated the graph, THEN THE Assistant SHALL roll back
   the active Edit_Session.
4. WHERE a Studio_Action is outside Edit_Session coverage, THE Action_Result SHALL carry a
   `revertable: false` marker.
5. WHEN a turn executes at least one Studio_Action marked `revertable: false`, THE Assistant SHALL
   describe those effects separately from the revertable graph edits in the turn summary.

### Requirement 8: Requests reach the capability they name

**User Story:** As a studio operator, I want "create an eval" to create an eval, so that the
assistant does what I asked instead of the nearest graph edit.

#### Acceptance Criteria

1. WHEN a user request names a capability covered by a Studio_Action, THE Assistant SHALL invoke
   that Studio_Action.
2. WHEN the user asks for an eval to be created for the active workflow, THE Assistant SHALL create
   an eval suite through `EvalService` and SHALL leave the canvas node count and connection count
   unchanged.
3. WHEN the user asks for the active workflow to be run, THE Assistant SHALL start the run through
   the Surface `runs` Studio_Action.
4. IF a request matches two or more Studio_Actions with no way to choose between them, THEN THE
   Assistant SHALL ask one clarifying question in the turn response and SHALL defer execution to a
   later turn.
5. WHERE no Studio_Action covers a request, THE Assistant SHALL state that the capability is
   unavailable and SHALL name the closest available Studio_Action.
6. WHEN a Studio_Action on a Surface other than `graph` completes, THE Assistant SHALL reveal and
   activate the panel that owns that Surface through `Panel_Registry`.

### Requirement 9: Prompt edits land on the identified prompt

**User Story:** As a studio operator, I want "change the researcher prompt" to change that prompt,
so that I stop editing prompts by hand to correct the assistant.

#### Acceptance Criteria

1. WHEN the user identifies a node by display name and asks for a prompt change, THE Assistant SHALL
   read that node's current prompt through the prompt Read_Action and SHALL write the revised body
   to that node id.
2. IF two or more nodes carry the display name given in the request, THEN THE Assistant SHALL ask
   which node to edit and SHALL defer the write.
3. WHEN the prompt Write_Action targets a node whose data declares a `prompt` field, THE
   Action_Registry SHALL apply the prompt patch regardless of whether the node is an agent node.
4. IF the prompt Write_Action targets a node whose data declares no `prompt` field, THEN THE
   Action_Registry SHALL return an Action_Result with `ok: false` naming the node kind.
5. THE prompt Write_Action SHALL accept a complete replacement prompt body as its argument.
6. THE Studio SHALL store every prompt body written by a Studio_Action as markdown.

### Requirement 10: Gating and platform boundaries hold

**User Story:** As a free-tier user on the web build, I want the widened action surface to respect
the plan and platform limits, so that the studio behaves consistently everywhere.

#### Acceptance Criteria

1. WHILE the account holds no Phorma Cloud subscription, THE Assistant SHALL keep Agent_Mode
   unavailable.
2. WHILE the account holds no Phorma Cloud subscription, THE Assistant SHALL offer the full
   Read_Action set in Ask_Mode and the full Action_Op vocabulary in Plan_Mode on the user's default
   model.
3. IF a model call fails with a credits or subscription error, THEN THE Assistant SHALL surface the
   existing credits-exhausted state for that turn.
4. WHERE a Studio_Action requires a native capability, THE Action_Registry SHALL call it through
   `TauriService` guarded by `isDesktop`.
5. IF a Studio_Action requiring a native capability is invoked in a browser session, THEN THE
   Action_Registry SHALL return an Action_Result with `ok: false` stating that the action needs the
   desktop application.

### Requirement 11: Failures are reported, not swallowed

**User Story:** As a studio operator, I want to see why an assistant action did not work, so that I
can fix the request or the state myself.

#### Acceptance Criteria

1. IF an Owning_Service throws while a Studio_Action executes, THEN THE Action_Registry SHALL return
   an Action_Result with `ok: false` carrying the error message in one sentence.
2. WHEN a Studio_Action returns an Action_Result with `ok: false`, THE Assistant SHALL include the
   message in the turn record so that the message appears in the chat transcript.
3. WHEN a Studio_Action starts a long-running operation such as a workflow run or an eval suite run,
   THE Action_Registry SHALL return an Action_Result once the operation has started, naming the
   panel where progress appears.
4. WHILE a long-running operation started by a Studio_Action is in progress, THE Studio SHALL report
   progress through the existing RunEvents path.
