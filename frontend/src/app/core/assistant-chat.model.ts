/**
 * Data model for the AI Assistant chat (EPIC 5).
 *
 * A {@link ChatThread} is a persisted conversation scoped to one workflow
 * document. Threads hold {@link ChatTurn}s; assistant turns may carry a
 * structured attachment (a Plan-mode proposal, an analyzer report, or a
 * migration-converter result) rendered as a rich card in the chat UI.
 *
 * Keep this file free of Angular imports — it is shared by services,
 * components, and (potentially) tests.
 */

import type { ModelProviderId } from './workflow.model';

/** How the AI responds to a turn. */
export type AssistantMode = 'ask' | 'plan' | 'agent';

/**
 * One operation in a Plan-mode edit plan (the model's JSON output).
 *
 * `action` is the general form: any Studio_Action id plus its arguments, which
 * is how Plan mode reaches the eval, run, workflow, skill, connection, portal,
 * usage, settings and navigation surfaces. The five graph forms
 * (`add | connect | update | remove | disconnect`) are kept verbatim because
 * chat threads persisted before the Action_Registry existed still contain them
 * and must replay with their original behaviour (Requirement 4.3).
 */
export interface PlanOp {
  op: 'add' | 'connect' | 'update' | 'remove' | 'disconnect' | 'action';
  // add
  ref?: string;
  type?: string;
  name?: string;
  prompt?: string;
  // connect
  from?: string;
  to?: string;
  fromPort?: string;
  toPort?: string;
  // update / remove
  node?: string;
  // disconnect
  connection?: string;
  // action - a Studio_Action id and its arguments
  action?: string;
  args?: Record<string, unknown>;
  /**
   * How to carry this step out BY HAND in the studio, as markdown. Plan mode is
   * a proposal the user can either have applied for them (Phorma Cloud) or work
   * through themselves, so every op has to stand on its own as an instruction -
   * which panel, which control, what value. Also read by subscribers who expand
   * a step to see what an op will actually do before applying it.
   *
   * Optional because threads persisted before this existed replay without it.
   */
  detail?: string;
}

/** A complete Plan-mode edit plan (summary + ordered ops). */
export interface EditPlan {
  summary?: string;
  ops: PlanOp[];
}

/**
 * A Plan proposal attached to an assistant turn. Chat renders it as a card
 * with an op list and an Apply button; `applied` flips once played back.
 */
export interface PlanProposalAttachment {
  kind: 'plan-proposal';
  plan: EditPlan;
  /** Set when the user applied the plan (epoch ms). */
  appliedAt?: number;
  /** Human-readable origin, e.g. 'chat', 'analyzer', 'converter'. */
  origin?: 'chat' | 'analyzer' | 'converter';
}

/** Attachments an assistant turn may carry. */
export type ChatAttachment = PlanProposalAttachment;

/** The model that produced (or will produce) a turn. */
export interface ChatModelRef {
  provider: ModelProviderId;
  model: string;
}

/**
 * Cost of one assistant turn. Phorma Cloud-billed turns render as plan
 * CREDITS (never dollars); BYO turns render USD, "(est.)" when estimated —
 * the same display rule as runs (EPIC 2).
 */
export interface ChatTurnUsage {
  /** Real USD cost of the turn's model calls (reported or estimated). */
  costUsd: number;
  /** True when billed to Phorma Cloud plan credits. */
  phormaCloud: boolean;
  /** True when any portion of costUsd is a pricing-table estimate. */
  estimated: boolean;
}

/** Lifecycle of one step the assistant took. */
export type ChatStepStatus = 'running' | 'done' | 'failed';

/**
 * One studio action or tool call the assistant made during a turn.
 *
 * Replaced the plain `activity: string[]`, which encoded status in the TEXT
 * ("X - done", "X - failed: ...") and appended a second row when a call ended,
 * so every call showed twice and a failure still wore a green check. One step
 * is now one row whose status changes in place.
 */
export interface ChatStep {
  /** The tool-call id, stable across the running -> done/failed transition. */
  id: string;
  /** Studio_Action id (`web_fetch`, `graph_add_node`, ...). */
  action: string;
  /** Human-readable activity line. */
  label: string;
  status: ChatStepStatus;
  /** Arguments as the model sent them, pretty-printed and capped. */
  args?: string;
  /** Result payload excerpt (successful steps), pretty-printed and capped. */
  result?: string;
  /** One-sentence failure reason (failed steps). */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** The model's visible reasoning for one turn. */
export interface ChatThinking {
  /** Readable reasoning text (a provider summary for Claude models). */
  text: string;
  /** Wall time spent thinking, for the "Thought for Ns" header. */
  durationMs: number;
}

/** A web page the user attached to a message as a reference. */
export interface ChatReference {
  url: string;
  /** Page title once read; the host until then. */
  title?: string;
  /** `failed` keeps the chip visible with its reason instead of dropping it silently. */
  status: 'ready' | 'failed';
  /** Characters of page text handed to the model. */
  chars?: number;
  truncated?: boolean;
  error?: string;
}

/** One message in a thread. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  /** Markdown body (user request or assistant answer/summary). */
  text: string;
  /** Mode the turn ran in (assistant turns; user turns record the ask). */
  mode: AssistantMode;
  /** Model used for assistant turns (absent on user turns). */
  modelRef?: ChatModelRef;
  /** Structured payload rendered as a card (assistant turns only). */
  attachment?: ChatAttachment;
  /**
   * What the assistant DID this turn, one entry per studio action or tool call,
   * in order. Captured from the live step feed when the turn completes so the
   * rows survive in the transcript instead of vanishing with the spinner -
   * scrolling back through a conversation is how a user audits what an
   * Agent-mode turn changed. Absent on turns that took no actions.
   */
  steps?: ChatStep[];
  /**
   * LEGACY: the pre-{@link ChatStep} activity lines. Read only by
   * {@link normalizeChatTurn}, which converts them to `steps` on load; never
   * written any more.
   */
  activity?: string[];
  /** The model's visible reasoning this turn (assistant turns, when streamed). */
  thinking?: ChatThinking;
  /** Web pages the user attached to this message (user turns). */
  references?: ChatReference[];
  /** Cost of this turn's model calls (assistant turns, when known). */
  usage?: ChatTurnUsage;
  /** Terminal state for assistant turns. */
  status?: 'ok' | 'error' | 'cancelled';
  /** Error message when status = 'error'. */
  error?: string;
  at: number;
}

/** A persisted conversation, scoped to one workflow. */
export interface ChatThread {
  id: string;
  /** Library workflow id, or null for unsaved drafts. */
  workflowId: string | null;
  /** Auto-generated from the first user message (editable later). */
  title: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

let chatCounter = 0;

/** Mints a unique chat-scoped id. */
export function chatId(prefix: string): string {
  chatCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${chatCounter}`;
}

/**
 * Upgrades a turn persisted before {@link ChatStep} existed: each legacy
 * activity pair ("X" then "X - done" / "X - failed: why") collapses to ONE
 * step carrying its status. Idempotent, and a no-op for current turns, so it
 * is safe on every read path - no IndexedDB version bump is needed because
 * the store holds whole objects without a schema.
 */
export function normalizeChatTurn(turn: ChatTurn): ChatTurn {
  if (!turn.activity || turn.steps) {
    if (!turn.activity) return turn;
    const { activity: _legacy, ...rest } = turn;
    return rest;
  }
  const steps: ChatStep[] = [];
  for (const [index, line] of turn.activity.entries()) {
    const done = /^(.*) - done$/.exec(line);
    const failed = /^(.*) - failed: (.*)$/.exec(line);
    const label = done?.[1] ?? failed?.[1];
    const previous = steps[steps.length - 1];
    if (label !== undefined && previous && previous.label === label && previous.status === 'running') {
      previous.status = failed ? 'failed' : 'done';
      if (failed) previous.error = failed[2];
      continue;
    }
    steps.push({
      id: `${turn.id}-legacy-${index}`,
      action: '',
      label: label ?? line,
      status: failed ? 'failed' : done ? 'done' : 'running',
      ...(failed ? { error: failed[2] } : {}),
      startedAt: turn.at,
    });
  }
  // A legacy row left "running" is a completed turn's step whose end line was
  // never written (older builds wrote one line per call); it did finish.
  for (const step of steps) if (step.status === 'running') step.status = 'done';
  const { activity: _legacy, ...rest } = turn;
  return { ...rest, steps };
}

/** {@link normalizeChatTurn} over a whole thread. */
export function normalizeChatThread(thread: ChatThread): ChatThread {
  return { ...thread, turns: thread.turns.map(normalizeChatTurn) };
}

/** Derives a thread title from the first user message. */
export function titleFromRequest(request: string): string {
  const line = request.trim().split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}
