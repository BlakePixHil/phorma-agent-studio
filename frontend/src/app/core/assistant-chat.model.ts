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

/** Derives a thread title from the first user message. */
export function titleFromRequest(request: string): string {
  const line = request.trim().split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}
