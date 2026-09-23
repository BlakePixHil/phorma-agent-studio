/**
 * System One decisions - typed, calibrated judgments from TypeSafe's Jev model.
 *
 * A decision model is NOT a chat model. It never generates text: it evaluates a
 * `state` against named questions and returns typed answers with calibrated
 * probabilities, typically in ~100 ms. That makes it the natural primitive for
 * the places a workflow needs a fast judgment between deterministic steps:
 * routing, auto-resolving approvals, verifying agent output, screening portal
 * traffic, picking tools, grading evals.
 *
 * Three question types (https://docs.typesafe.ai/primitives):
 * - `noul`   - is this true? Returns P(yes) in [0, 1].
 * - `choice` - which of these options? Returns the winner, the distribution and
 *   a confidence derived from how peaked the distribution is.
 * - `score`  - where on these ordered levels? Returns a probability-weighted
 *   position (it can land between levels), the distribution and a confidence.
 *
 * The engine reaches the model through an injected {@link DecisionClient}
 * (`RunOptions.decisions`), exactly like `ModelClient`: the desktop proxies
 * through Rust so the key stays in the OS keychain, the worker calls with a
 * worker secret, Phorma Cloud tenants call a metered proxy. This module owns
 * the shared wire contract and one fetch-based client; it performs no I/O at
 * import time and depends on nothing outside the engine.
 */

import { DataTransportError, HTTP_BODY_PREVIEW_MAX_CHARS, HttpStatusError } from './data-host.js';
import { resolveJsonPath } from './payload.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The one TypeSafe evaluation endpoint. Fixed in code, never user-supplied. */
export const DECISION_API_URL = 'https://api.typesafe.ai/v1/systemone';

/** Egress host every decision-using workflow reaches. */
export const DECISION_API_HOST = 'api.typesafe.ai';

/** Model alias used when a node pins none. Resolves to the latest stable Jev. */
export const DEFAULT_DECISION_MODEL = 'jev-latest';

/** `provider` label stamped on decision `node-usage` events. */
export const DECISION_PROVIDER = 'typesafe';

/** Jev bills input tokens only: $0.042 per million (output tokens are free). */
export const DECISION_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** API limit: a Choice question offers at most this many options. */
export const MAX_CHOICE_OPTIONS = 255;
/** API limits on Score levels. */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/**
 * Conservative character ceiling for a serialised `state`. Jev budgets 32k
 * tokens for the state plus the longest question; ~4 chars per token leaves
 * headroom for the questions. Accuracy also degrades well before the limit on
 * large irrelevant state, so the error points at `statePath`.
 */
export const MAX_DECISION_STATE_CHARS = 100_000;

/** Default per-request timeout for {@link FetchDecisionClient}. */
export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

/** Question and answer ids: short identifiers safe as JSON keys and in paths. */
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/;

const USER_AGENT = 'PhormaAgentStudio/1.0 (https://phorma.dev)';

// ─────────────────────────────────────────────────────────────────────────────
// Wire types (https://docs.typesafe.ai/api)
// ─────────────────────────────────────────────────────────────────────────────

/** `instructions` and `criteria` descriptions accept strings or JSON structure. */
export type DecisionText = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionText;
  /** Optional clarification of what a yes (`true`) and a no (`false`) mean. */
  criteria?: { true?: DecisionText; false?: DecisionText };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: DecisionText;
  /** Option label -> description (`null` when the label says it all). */
  criteria: Record<string, DecisionText | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionText;
  /** Ordered level descriptions, lowest first. */
  criteria: DecisionText[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** P(yes), 0..1. Noul carries no separate confidence. */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionRequest {
  /** Model id or alias (`jev-latest`, `jev-1.13.0`). */
  model: string;
  /** The content under evaluation. Text only. */
  state: string | Record<string, unknown> | unknown[];
  /** Question id -> question. Ids are for code; they are never sent to inference. */
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult {
  /** The VERSIONED model that answered (aliases resolve server-side). */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
}

/**
 * Evaluates a decision request. Implementations MUST reject with
 * {@link HttpStatusError} for a non-2xx answer (so 429/5xx honour the shared
 * retry classifier and `Retry-After`) and with {@link DataTransportError} when
 * no response arrived.
 */
export interface DecisionClient {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}

/** The tuning fields any decision-backed node config carries. */
export interface DecisionTuningLike {
  statePath?: string;
  decisionModel?: string;
}

/** Why a workflow step asked System One. Stamped on the `decision` event. */
export type DecisionPurpose =
  | 'route'
  | 'gate'
  | 'decide'
  | 'verify'
  | 'guard'
  | 'tool-select'
  | 'skill-select'
  | 'judge';

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function isDecisionText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && typeof value === 'object';
}

/**
 * Checks a request against the documented API limits before it is sent, so an
 * authoring mistake fails with a readable message instead of a bare 422.
 * Returns `null` when valid, else a sentence describing the first problem.
 */
export function validateDecisionRequest(request: DecisionRequest): string | null {
  if (typeof request.model !== 'string' || request.model.trim().length === 0) {
    return 'No decision model is set.';
  }
  const stateText = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
  if (typeof stateText !== 'string' || stateText.trim().length === 0) {
    return 'The input to evaluate is empty.';
  }
  if (stateText.length > MAX_DECISION_STATE_CHARS) {
    return (
      `The input to evaluate is ${stateText.length} characters, over the ${MAX_DECISION_STATE_CHARS} ` +
      'character limit. Point the step at the relevant field with a state path.'
    );
  }

  const entries = Object.entries(request.questions ?? {});
  if (entries.length === 0) return 'No questions are defined.';

  for (const [id, question] of entries) {
    if (!QUESTION_ID.test(id)) {
      return `Question id "${id}" must start with a letter and use only letters, digits, "_", ":", "." or "-".`;
    }
    if (!question || !isDecisionText(question.instructions)) {
      return `Question "${id}" has no instructions.`;
    }
    switch (question.type) {
      case 'noul':
        break;
      case 'choice': {
        const options = Object.keys(question.criteria ?? {});
        if (options.length < 2) return `Question "${id}" needs at least two options.`;
        if (options.length > MAX_CHOICE_OPTIONS) {
          return `Question "${id}" has ${options.length} options; the limit is ${MAX_CHOICE_OPTIONS}.`;
        }
        if (options.some(option => option.trim().length === 0)) {
          return `Question "${id}" has an option with an empty label.`;
        }
        break;
      }
      case 'score': {
        const levels = Array.isArray(question.criteria) ? question.criteria : [];
        if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
          return `Question "${id}" needs between ${MIN_SCORE_LEVELS} and ${MAX_SCORE_LEVELS} levels.`;
        }
        if (!levels.every(isDecisionText)) return `Question "${id}" has an empty level.`;
        break;
      }
      default:
        return `Question "${id}" has an unknown type.`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing
// ─────────────────────────────────────────────────────────────────────────────

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!finite(entry)) return undefined;
    out[key] = entry;
  }
  return out;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof entry === 'string' ? entry : JSON.stringify(entry);
  }
  return out;
}

function parseAnswer(raw: unknown): DecisionAnswer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  switch (record['type']) {
    case 'noul':
      return finite(record['noul']) ? { type: 'noul', noul: record['noul'] } : undefined;
    case 'choice': {
      const probabilities = numberRecord(record['probabilities']);
      if (typeof record['choice'] !== 'string' || !probabilities || !finite(record['confidence'])) {
        return undefined;
      }
      return {
        type: 'choice',
        choice: record['choice'],
        probabilities,
        confidence: record['confidence'],
      };
    }
    case 'score': {
      const probabilities = numberRecord(record['probabilities']);
      if (!finite(record['score']) || !probabilities || !finite(record['confidence'])) return undefined;
      return {
        type: 'score',
        score: record['score'],
        legend: stringRecord(record['legend']),
        probabilities,
        confidence: record['confidence'],
      };
    }
    default:
      return undefined;
  }
}

/**
 * Narrows a decoded response body. Throws a descriptive error for a shape the
 * engine cannot trust (never silently routes on a malformed answer).
 */
export function parseDecisionResponse(raw: unknown, expectedIds?: readonly string[]): DecisionResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('System One returned a response that is not a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  const answersRaw = record['answers'];
  if (answersRaw === null || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) {
    throw new Error('System One returned a response without answers.');
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, value] of Object.entries(answersRaw as Record<string, unknown>)) {
    const answer = parseAnswer(value);
    if (!answer) throw new Error(`System One returned an unreadable answer for "${id}".`);
    answers[id] = answer;
  }
  for (const id of expectedIds ?? []) {
    if (!(id in answers)) throw new Error(`System One returned no answer for "${id}".`);
  }
  const usage = (record['usage'] ?? {}) as Record<string, unknown>;
  return {
    model: typeof record['model'] === 'string' ? record['model'] : '',
    answers,
    usage: {
      inputTokens: finite(usage['input_tokens']) ? usage['input_tokens'] : 0,
      outputTokens: finite(usage['output_tokens']) ? usage['output_tokens'] : 0,
    },
  };
}

/**
 * An HTTP failure from the decision API. Keeps `name === 'HttpStatusError'`
 * (set by the base class) so the shared retry classifier recognises it, but
 * carries a message an operator can act on.
 */
export class DecisionHttpError extends HttpStatusError {
  constructor(status: number, headers: Record<string, string>, bodyPreview: string) {
    super(status, headers, bodyPreview);
    this.message = describeDecisionStatus(status, bodyPreview);
  }
}

function describeDecisionStatus(status: number, bodyPreview: string): string {
  const detail = extractErrorDetail(bodyPreview);
  switch (status) {
    case 401:
      return 'System One rejected the TypeSafe API key (HTTP 401). Check the key in Settings → API keys.';
    case 402:
      return `System One refused the request (HTTP 402)${detail ? `: ${detail}` : ''}.`;
    case 422:
      return `System One rejected the questions (HTTP 422)${detail ? `: ${detail}` : ''}.`;
    case 429:
      return 'System One rate limit reached (HTTP 429).';
    case 529:
      return 'System One is temporarily overloaded (HTTP 529).';
    default:
      return `System One request failed (HTTP ${status})${detail ? `: ${detail}` : ''}.`;
  }
}

function extractErrorDetail(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const candidate = parsed['error'] ?? parsed['detail'] ?? parsed['message'];
    if (typeof candidate === 'string') return clip(candidate, 240);
    if (candidate !== undefined) return clip(JSON.stringify(candidate), 240);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return clip(text, 240);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Turns a host's raw HTTP answer into a result or a classified error. Shared by
 * every transport that proxies the call (Rust, hosted proxy, worker), so the
 * error semantics are identical everywhere.
 */
export function decisionResultFromHttp(
  status: number,
  headers: Record<string, string>,
  body: string,
  expectedIds?: readonly string[],
): DecisionResult {
  if (status < 200 || status > 299) {
    const lower: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) lower[name.toLowerCase()] = value;
    throw new DecisionHttpError(status, lower, clip(body ?? '', HTTP_BODY_PREVIEW_MAX_CHARS));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('System One returned a response that is not valid JSON.');
  }
  return parseDecisionResponse(parsed, expectedIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch client (browser, worker, AWS)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the TypeSafe API key, or null when none is configured. */
export type DecisionKeyResolver = () => Promise<string | null>;

export interface FetchDecisionClientOptions {
  /** Endpoint override - tests and the hosted proxy only. */
  url?: string;
  timeoutMs?: number;
  /** Injected fetch (tests, egress-guarded host fetch). */
  fetch?: typeof fetch;
  /** Extra headers (e.g. a Phorma Cloud bearer for the hosted proxy). */
  headers?: Record<string, string>;
}

/**
 * fetch-based client for hosts that may hold the key (worker secret, AWS
 * Secrets Manager, browser preview localStorage). The desktop app uses a Rust
 * proxy instead so the key never enters the webview.
 */
export class FetchDecisionClient implements DecisionClient {
  constructor(
    private readonly resolveKey: DecisionKeyResolver,
    private readonly options: FetchDecisionClientOptions = {},
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const key = await this.resolveKey();
    if (!key) {
      throw new Error('No TypeSafe API key is configured for System One. Add one in Settings → API keys.');
    }
    const fetchImpl = this.options.fetch ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    let response: Response;
    try {
      response = await fetchImpl(this.options.url ?? DECISION_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${key}`,
          'user-agent': USER_AGENT,
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(request),
        signal: controller?.signal,
      });
    } catch (error) {
      const aborted = controller?.signal.aborted === true;
      throw new DataTransportError(
        aborted ? 'timeout' : 'unknown',
        aborted
          ? `System One did not answer within ${Math.round(timeoutMs / 1000)}s.`
          : `System One could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const body = await response.text().catch(() => '');
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return decisionResultFromHttp(response.status, headers, body, Object.keys(request.questions));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers shared by the node executors
// ─────────────────────────────────────────────────────────────────────────────

/** USD for one decision call (input tokens only). */
export function decisionCostUsd(usage: DecisionUsage): number {
  return Math.max(0, usage.inputTokens) * DECISION_USD_PER_INPUT_TOKEN;
}

/**
 * Builds the `state` for a payload: the parsed JSON document when the payload
 * is JSON, the raw text otherwise. An optional dotted `statePath` narrows it to
 * the field the questions are about - Jev's accuracy drops as irrelevant state
 * grows, so narrowing is the single most effective tuning knob.
 */
export function payloadToState(
  payload: string,
  statePath?: string,
): string | Record<string, unknown> | unknown[] {
  const text = payload ?? '';
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    parsed = undefined;
  }

  const path = (statePath ?? '').trim().replace(/^\$\.?/, '');
  if (path && isJson) {
    const narrowed = resolveJsonPath(parsed, path);
    if (narrowed !== undefined) return asState(narrowed);
  }
  if (isJson) return asState(parsed);
  return text.trim().length > 0 ? text : '(no input provided)';
}

function asState(value: unknown): string | Record<string, unknown> | unknown[] {
  if (typeof value === 'string') return value.trim().length > 0 ? value : '(no input provided)';
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  // Numbers, booleans and null are text as far as the model is concerned.
  return JSON.stringify(value);
}

/**
 * Compact, expression-friendly projection of answers for merging into a JSON
 * payload: a Noul becomes its probability (`$.decisions.refund > 0.7`), a Choice
 * or Score keeps its value, confidence and distribution
 * (`$.decisions.topic.choice == 'billing'`).
 */
export function compactDecisionAnswers(
  answers: Readonly<Record<string, DecisionAnswer>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    switch (answer.type) {
      case 'noul':
        out[id] = answer.noul;
        break;
      case 'choice':
        out[id] = {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
        };
        break;
      case 'score':
        out[id] = {
          score: answer.score,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
        };
        break;
    }
  }
  return out;
}

/**
 * Reads a numeric threshold from node data, clamped to [0, 1], falling back to
 * `fallback` for an absent or unreadable value.
 */
export function readThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** The pinned model on a node, or the run default, or {@link DEFAULT_DECISION_MODEL}. */
export function resolveDecisionModel(nodeModel: unknown, runDefault?: string): string {
  if (typeof nodeModel === 'string' && nodeModel.trim()) return nodeModel.trim();
  if (typeof runDefault === 'string' && runDefault.trim()) return runDefault.trim();
  return DEFAULT_DECISION_MODEL;
}

/** Formats a probability as a whole percentage (`0.934` -> `93%`). */
export function formatProbability(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/**
 * One line per answer, human-readable, for traces and tooltips:
 * `refund: yes 93%`, `topic: billing (confidence 81%)`, `mood: 1.4 of 0-2`.
 */
export function describeDecisionAnswers(answers: Readonly<Record<string, DecisionAnswer>>): string[] {
  return Object.entries(answers).map(([id, answer]) => {
    switch (answer.type) {
      case 'noul':
        return `${id}: ${answer.noul >= 0.5 ? 'yes' : 'no'} ${formatProbability(answer.noul >= 0.5 ? answer.noul : 1 - answer.noul)}`;
      case 'choice': {
        const ranked = Object.entries(answer.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([option, p]) => `${option} ${formatProbability(p)}`)
          .join(', ');
        return `${id}: ${answer.choice} (confidence ${formatProbability(answer.confidence)}) - ${ranked}`;
      }
      case 'score': {
        const top = Math.max(0, Object.keys(answer.probabilities).length - 1);
        return `${id}: ${answer.score.toFixed(2)} of 0-${top} (confidence ${formatProbability(answer.confidence)})`;
      }
    }
  });
}

/** A probability pill drawn on one outgoing edge of a routing decision. */
export interface DecisionEdgeLabel {
  /** e.g. `92%`, or `unsure` on the low-confidence path. */
  text: string;
  /** True on the edge the run actually took. */
  selected: boolean;
}

/**
 * Per-connection probability labels for a routing `decision` event: the
 * Choice probability of each route on its outgoing handoff(s), the taken edge
 * marked. Pure so the live canvas, the cloud monitor and run history share it.
 *
 * Routes are matched by port NAME, exactly as the engine labels options.
 */
export function decisionEdgeLabels(
  graph: Pick<WorkflowGraph, 'nodes' | 'connections'>,
  event: {
    nodeId: string;
    purpose: string;
    answers: Readonly<Record<string, DecisionAnswer>>;
    selectedPortId?: string;
    fallback?: string;
  },
): Map<string, DecisionEdgeLabel> {
  const labels = new Map<string, DecisionEdgeLabel>();
  if (event.purpose !== 'route') return labels;
  const node = graph.nodes.find(candidate => candidate.id === event.nodeId);
  if (!node) return labels;
  const route = event.answers['route'];
  const outs = node.ports.filter(port => port.role === 'message-out');
  const names = uniqueOptionLabels(
    outs.map(port => port.name),
    index => `Route ${index + 1}`,
  );
  const probabilityByPort = new Map<string, number>();
  if (route?.type === 'choice') {
    outs.forEach((port, index) => {
      const p = route.probabilities[names[index] ?? ''];
      if (typeof p === 'number') probabilityByPort.set(port.id, p);
    });
  }

  for (const connection of graph.connections) {
    if (connection.kind !== 'handoff') continue;
    const portId = connection.outputId.replace(/-(in|out)$/, '');
    const port = outs.find(candidate => candidate.id === portId);
    if (!port) continue;
    const selected = port.id === event.selectedPortId;
    const p = probabilityByPort.get(port.id);
    let text: string;
    if (p !== undefined) text = formatProbability(p);
    else if (selected && event.fallback === 'low-confidence') text = 'unsure';
    else if (selected && event.fallback === 'no-transport') text = 'keyword';
    else continue;
    labels.set(connection.id, { text, selected });
  }
  return labels;
}

/** Actor stamped on an approval a System One verdict settled without a human. */
export const DECISION_ACTOR = 'system-one';

/**
 * Stable, unique option labels for a Choice built from user-authored names.
 * Blank names fall back to `fallback(index)`; duplicates get ` (2)`, ` (3)`.
 * The model sees the label, so it stays human-readable.
 */
export function uniqueOptionLabels(names: readonly string[], fallback: (index: number) => string): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, index) => {
    const base = (raw ?? '').trim() || fallback(index);
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/** Authored question spec, structurally identical to `DecisionQuestionSpec` in types.ts. */
interface QuestionSpecLike {
  id?: unknown;
  type?: unknown;
  instructions?: unknown;
  options?: unknown;
  levels?: unknown;
  yes?: unknown;
  no?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Converts the questions authored on a Decide node into wire questions.
 * Returns the questions, or a sentence naming the first authoring problem.
 * Duplicate ids are rejected: an answer id must address exactly one question.
 */
export function buildDecisionQuestions(
  specs: unknown,
): { questions: Record<string, DecisionQuestion> } | { error: string } {
  const list = Array.isArray(specs) ? (specs as QuestionSpecLike[]) : [];
  if (list.length === 0) return { error: 'Add at least one question.' };
  const questions: Record<string, DecisionQuestion> = {};

  for (const [index, spec] of list.entries()) {
    const id = text(spec?.id);
    const where = id ? `Question "${id}"` : `Question ${index + 1}`;
    if (!QUESTION_ID.test(id)) {
      return { error: `${where} needs an id that starts with a letter and uses letters, digits or "_".` };
    }
    if (id in questions) return { error: `Question id "${id}" is used twice.` };
    const instructions = text(spec.instructions);
    if (!instructions) return { error: `${where} has no question text.` };

    switch (spec.type) {
      case 'noul': {
        const yes = text(spec.yes);
        const no = text(spec.no);
        questions[id] = {
          type: 'noul',
          instructions,
          ...(yes || no ? { criteria: { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) } } : {}),
        };
        break;
      }
      case 'choice': {
        const options = Array.isArray(spec.options) ? (spec.options as { label?: unknown; description?: unknown }[]) : [];
        const labels = uniqueOptionLabels(
          options.map(option => text(option?.label)),
          i => `Option ${i + 1}`,
        );
        const criteria: Record<string, DecisionText | null> = {};
        labels.forEach((label, i) => {
          const description = text(options[i]?.description);
          criteria[label] = description || null;
        });
        questions[id] = { type: 'choice', instructions, criteria };
        break;
      }
      case 'score': {
        const levels = (Array.isArray(spec.levels) ? spec.levels : []).map(text).filter(Boolean);
        questions[id] = { type: 'score', instructions, criteria: levels };
        break;
      }
      default:
        return { error: `${where} has no type (yes/no, choice or score).` };
    }
  }
  return { questions };
}

/**
 * Merges decision answers into a payload under `resultKey`: a JSON object
 * payload keeps its fields; anything else is preserved under `input`.
 */
export function mergeDecisionAnswers(
  payload: string,
  resultKey: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
): string {
  const compact = compactDecisionAnswers(answers);
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(payload);
    isJson = true;
  } catch {
    parsed = undefined;
  }
  if (isJson && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [resultKey]: compact });
  }
  return JSON.stringify({ input: isJson ? parsed : payload, [resultKey]: compact });
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph inspection
// ─────────────────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * True when this node asks System One at run time. The single source of truth
 * for egress declaration, capability validation and the studio's "needs a
 * TypeSafe key" hint.
 */
export function nodeUsesDecisions(node: Pick<WorkflowNode, 'kind' | 'data'>): boolean {
  const data = record(node.data);
  switch (node.kind) {
    case 'decide':
      return true;
    case 'router':
      return data?.['mode'] === 'decide';
    case 'approval-gate':
      return record(data?.['autoResolve'])?.['enabled'] === true;
    case 'agent':
      return (
        record(data?.['verify'])?.['enabled'] === true ||
        record(data?.['preselect'])?.['enabled'] === true
      );
    case 'portal-trigger': {
      const guardrails = record(data?.['guardrails']);
      return (
        record(guardrails?.['input'])?.['enabled'] === true ||
        record(guardrails?.['output'])?.['enabled'] === true
      );
    }
    default:
      return false;
  }
}

/** True when any node of the graph asks System One. */
export function usesDecisions(graph: Pick<WorkflowGraph, 'nodes'>): boolean {
  return (graph?.nodes ?? []).some(node => nodeUsesDecisions(node));
}
