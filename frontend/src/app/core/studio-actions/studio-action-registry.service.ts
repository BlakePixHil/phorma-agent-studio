import { Injectable, computed, inject } from '@angular/core';

import type { ToolDefinition } from '@phorma/engine';

import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { TauriService } from '../tauri.service';
import type { WorkflowGraph } from '../workflow.model';
import { ConnectionActionsService } from './connection-actions.service';
import { EvalActionsService } from './eval-actions.service';
import { GraphActionsService } from './graph-actions.service';
import { PortalActionsService } from './portal-actions.service';
import { PromptActionsService } from './prompt-actions.service';
import { RunActionsService } from './run-actions.service';
import { SettingsActionsService } from './settings-actions.service';
import { SkillActionsService } from './skill-actions.service';
import { UsageActionsService } from './usage-actions.service';
import { WorkflowActionsService } from './workflow-actions.service';
import {
  actionFail,
  describeAction,
  toolDefinitionOf,
  validateArgs,
  type ActionAccess,
  type ActionResult,
  type ActionSurface,
  type StudioAction,
} from './studio-action.model';

/** Panel tab that owns each surface, for the post-action reveal. */
const SURFACE_PANEL: Partial<Record<ActionSurface, string>> = {
  evals: 'evals',
  runs: 'runs',
  prompts: 'prompt',
  workflows: 'workflows',
  versions: 'workflows',
  skills: 'skills',
  connections: 'connections',
  portal: 'portal',
  usage: 'usage',
};

/** Options for one dispatch. */
export interface ExecuteOptions {
  /**
   * Set when the caller already obtained the user's consent - Plan playback
   * asks once for the whole plan rather than once per op (Requirement 4.7).
   */
  confirmed?: boolean;
  /** Suppresses the post-action panel reveal (used by silent internal calls). */
  quiet?: boolean;
  /**
   * Refuses Write_Actions. Ask mode only OFFERS reads, but a model can name any
   * id it likes, so the guarantee is enforced at dispatch too
   * (Requirement 5.5).
   */
  readOnly?: boolean;
}

/** One recorded execution within the current turn. */
export interface TurnEffect {
  actionId: string;
  label: string;
  surface: ActionSurface;
  revertable: boolean;
}

/**
 * The Action_Registry: one description of every executable studio capability,
 * and the single dispatch path all three assistant modes go through
 * (Requirement 1).
 *
 * Adding a capability is one entry in the owning surface's `actions()` plus its
 * executor. The Agent-mode tool list, the Plan-mode apply path and the system
 * prompts all derive from this registry, so none of them needs editing
 * (Requirement 1.6).
 */
@Injectable({ providedIn: 'root' })
export class StudioActionRegistryService {
  private readonly graphActions = inject(GraphActionsService);
  private readonly evalActions = inject(EvalActionsService);
  private readonly runActions = inject(RunActionsService);
  private readonly promptActions = inject(PromptActionsService);
  private readonly workflowActions = inject(WorkflowActionsService);
  private readonly skillActions = inject(SkillActionsService);
  private readonly connectionActions = inject(ConnectionActionsService);
  private readonly portalActions = inject(PortalActionsService);
  private readonly usageActions = inject(UsageActionsService);
  private readonly settingsActions = inject(SettingsActionsService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly tauri = inject(TauriService);

  /** Every registered Studio_Action, keyed by id. */
  private readonly index = computed(() => {
    const entries = new Map<string, StudioAction>();
    for (const action of [
      ...this.graphActions.actions(),
      ...this.promptActions.actions(),
      ...this.evalActions.actions(),
      ...this.runActions.actions(),
      ...this.workflowActions.actions(),
      ...this.skillActions.actions(),
      ...this.connectionActions.actions(),
      ...this.portalActions.actions(),
      ...this.usageActions.actions(),
      ...this.settingsActions.actions(),
    ]) {
      entries.set(action.id, action);
    }
    return entries;
  });

  /** Surfaces already revealed this turn, so reads do not thrash the sidebar. */
  private revealedSurfaces = new Set<ActionSurface>();
  private effects: TurnEffect[] = [];
  private failures: string[] = [];

  /** All actions in registration order. */
  all(): StudioAction[] {
    return [...this.index().values()];
  }

  /** One action by id, or undefined when the id is unknown. */
  byId(id: string): StudioAction | undefined {
    return this.index().get(id);
  }

  /**
   * The actions available to a mode. Ask mode gets the read-only subset
   * (Requirement 5.5); Plan and Agent get everything.
   */
  available(access: ActionAccess | 'all'): StudioAction[] {
    return access === 'all' ? this.all() : this.all().filter(action => action.access === access);
  }

  /** Tool definitions derived from the registry (Requirement 3.1). */
  toolDefinitions(access: ActionAccess | 'all'): ToolDefinition[] {
    return this.available(access).map(toolDefinitionOf);
  }

  /** Human-readable activity line for an about-to-run action. */
  describe(id: string, rawArgs: unknown): string {
    const action = this.byId(id);
    if (!action) return `Unknown action '${id}'`;
    const validated = validateArgs(action, rawArgs);
    return describeAction(action, validated.ok ? validated.args : {});
  }

  // ── Turn bookkeeping ─────────────────────────────────────────────────────

  /**
   * Resets per-turn state: new-node placement is seeded from the pre-turn
   * graph, the reveal tracker is cleared, and the effect log starts empty.
   */
  beginTurn(graphBefore: WorkflowGraph): void {
    this.graphActions.beginPlacement(graphBefore);
    this.revealedSurfaces = new Set();
    this.effects = [];
    this.failures = [];
  }

  /** Everything executed this turn, in order. */
  turnEffects(): readonly TurnEffect[] {
    return this.effects;
  }

  /**
   * Failure messages from this turn, so the chat can put them in the turn
   * record rather than leaving them only in the model's context
   * (Requirement 11.2).
   */
  turnFailures(): string[] {
    return [...this.failures];
  }

  /** True when the turn mutated the canvas graph (Edit_Session coverage). */
  get turnTouchedGraph(): boolean {
    return this.effects.some(effect => effect.revertable);
  }

  /**
   * Labels of this turn's effects that the Revert control cannot undo, so the
   * turn summary can separate them from graph edits (Requirement 7.5).
   */
  nonRevertableEffects(): string[] {
    const seen = new Set<string>();
    for (const effect of this.effects) {
      if (!effect.revertable) seen.add(effect.label);
    }
    return [...seen];
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  /**
   * Executes one Studio_Action. Always resolves with an Action_Result - a
   * missing id, invalid arguments, a declined confirmation and a throwing
   * owning service all become `ok: false` plus one sentence
   * (Requirements 3.3, 3.4, 6.4, 11.1).
   */
  async execute(
    id: string,
    rawArgs: unknown,
    options: ExecuteOptions = {},
  ): Promise<ActionResult> {
    const action = this.byId(id);
    if (!action) {
      return this.reject(`There is no studio action called '${id}'.`);
    }

    if (options.readOnly && action.access !== 'read') {
      return this.reject(
        `"${action.label}" changes the studio, which Ask mode cannot do. Switch to Plan or Agent mode.`,
      );
    }

    const validated = validateArgs(action, rawArgs);
    if (!validated.ok) return this.reject(validated.message);
    const args = validated.args;

    if (action.requiresDesktop && !this.tauri.isDesktop) {
      return this.reject(`"${action.label}" needs the Phorma desktop application.`);
    }

    if (action.risk === 'confirm' && !options.confirmed) {
      const approved = await this.confirmDialog.confirm({
        title: action.label,
        message: this.confirmMessage(action, args),
        confirmLabel: action.label,
        cancelLabel: 'Cancel',
        tone: isDestructive(action) ? 'danger' : 'default',
      });
      // Requirement 6.7: the outcome comes from the resolved value, never from
      // `activeState()` - the dialog clears that before resolving.
      if (!approved) {
        return this.reject(`The user declined "${action.label}", so nothing changed.`);
      }
    }

    let result: ActionResult;
    try {
      result = await action.run(args);
    } catch (error) {
      result = actionFail(oneSentence(error));
    }

    const revertable = result.revertable ?? (action.graphEdit === true && result.ok);
    result = { ...result, revertable };

    if (result.ok) {
      this.effects.push({
        actionId: action.id,
        label: describeAction(action, args),
        surface: action.surface,
        revertable,
      });
      if (!options.quiet) this.revealFor(action.surface);
    } else {
      this.failures.push(
        `${describeAction(action, args)}: ${result.message ?? 'it failed for an unknown reason.'}`,
      );
    }
    return result;
  }

  /**
   * Actions in a plan that need consent, so Plan mode can ask ONCE before
   * playback (Requirement 4.7).
   */
  pendingConfirmations(calls: readonly { id: string; args?: unknown }[]): StudioAction[] {
    const seen = new Set<string>();
    const actions: StudioAction[] = [];
    for (const call of calls) {
      const action = this.byId(call.id);
      if (!action || action.risk !== 'confirm' || seen.has(action.id)) continue;
      seen.add(action.id);
      actions.push(action);
    }
    return actions;
  }

  // ── Prompt assembly ──────────────────────────────────────────────────────

  /**
   * The action catalogue as prompt text (Requirement 5.1): one line per action
   * with its surface and description. This is what keeps the prompt flat as the
   * action surface grows - no panel state is embedded, only the way to read it.
   */
  summarizeActions(access: ActionAccess | 'all'): string {
    const bySurface = new Map<ActionSurface, StudioAction[]>();
    for (const action of this.available(access)) {
      const bucket = bySurface.get(action.surface);
      if (bucket) bucket.push(action);
      else bySurface.set(action.surface, [action]);
    }
    const blocks: string[] = [];
    for (const [surface, actions] of bySurface) {
      const lines = actions.map(
        action =>
          `- ${action.id}${action.risk === 'confirm' ? ' (asks the user to confirm)' : ''}: ${action.description}`,
      );
      blocks.push(`### ${surface}\n${lines.join('\n')}`);
    }
    return blocks.join('\n\n');
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Records a pre-execution refusal and returns it as an Action_Result. */
  private reject(message: string): ActionResult {
    this.failures.push(message);
    return actionFail(message);
  }

  private confirmMessage(action: StudioAction, args: Record<string, unknown>): string {
    if (action.confirmSummary) {
      try {
        return action.confirmSummary(args);
      } catch {
        // A broken summary formatter must never block the guardrail.
      }
    }
    return `The assistant wants to run "${action.label}". Continue?`;
  }

  /**
   * Reveals the panel that owns a surface (Requirement 8.6), once per surface
   * per turn so a multi-read turn does not flip the sidebar repeatedly.
   */
  private revealFor(surface: ActionSurface): void {
    if (surface === 'graph' || this.revealedSurfaces.has(surface)) return;
    const tabId = SURFACE_PANEL[surface];
    this.revealedSurfaces.add(surface);
    if (!tabId) return;
    this.settingsActions.reveal(tabId);
  }
}

/** Confirms that delete or overwrite state get the danger tone. */
function isDestructive(action: StudioAction): boolean {
  return /delete|remove|unpublish|restore/.test(action.id);
}

/** Collapses any thrown value into one sentence for an Action_Result. */
function oneSentence(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return 'The action failed for an unknown reason.';
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(trimmed);
  const sentence = firstSentence ? firstSentence[1] : trimmed;
  return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
}
