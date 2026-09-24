/**
 * Model transport — provider adapters + the ModelClient contract.
 *
 * Providers are described as pure request-builders and STATEFUL stream
 * parsers so the SAME logic drives every runtime:
 *  - `FetchModelClient` (this file) streams via fetch — used in the browser
 *    and in the Cloudflare worker.
 *  - The desktop app's TauriModelClient (frontend) sends the built request to
 *    the Rust proxy (CORS-free, keys injected from the OS keychain) and
 *    parses the raw lines with the same parsers.
 *
 * Streams yield {@link ModelChunk}s: text tokens AND fully-assembled tool
 * calls (providers stream tool-call JSON in fragments; the parsers stitch
 * them back together).
 *
 * API keys never appear in built requests: header/url values carry the
 * `{{API_KEY}}` placeholder, substituted at the last moment by whichever
 * layer actually holds the secret.
 */

import type { RunFailureCode } from './events.js';
import type { ModelProviderId } from './types.js';

export const API_KEY_PLACEHOLDER = '{{API_KEY}}';

/**
 * A failed model HTTP request. Carries the status code so retry logic can
 * classify transient (429/5xx) vs permanent (auth, bad request) failures
 * without parsing message strings.
 */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the failure was an HTTP response (absent = network). */
    readonly status?: number,
    /**
     * Stable machine token from the responder, when it issued one - see
     * {@link RunFailureCode}. Same motivation as `status` one line up: a
     * consumer classifies the failure without parsing the message. This is what
     * carries a hosted entitlement refusal (`credits_exhausted` and friends)
     * from the `/api/infer` body out to the terminal `run-failed` event.
     */
    readonly code?: RunFailureCode,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

/**
 * Pulls the {@link RunFailureCode} off a thrown error, when it carries one, so
 * the engine's failure events can forward it (`node-failed`, `run-failed`).
 *
 * Total: anything else - including a non-Error throw - yields `undefined`, never
 * an empty string, so the field is absent once the event is serialized and
 * `event.code ?? fallback` is enough for a consumer to reach its prose fallback
 * (requirement 20). A present-but-empty token would read as "coded" and skip it.
 *
 * Narrowed to {@link ModelRequestError} ON PURPOSE, rather than duck-typing any
 * error with a string `code`. Node system errors and undici's `fetch` failures
 * already populate `code` (`ECONNRESET`, `ENOTFOUND`, `UND_ERR_*`), and a
 * `DataFetcher` running under Node can throw one straight through, so a
 * duck-typed reader would stamp a socket error into a field documented as a
 * stable entitlement token. Consumers would still behave (an unrecognised token
 * falls through to the fallback), but the run record and trace would then carry
 * a token that means nothing, and the field would stop being trustworthy for the
 * next thing that reads it. `DataTransportError` deliberately spells its own
 * discriminant `kind` for the same reason.
 */
export function failureCodeOf(error: unknown): RunFailureCode | undefined {
  if (!(error instanceof ModelRequestError)) return undefined;
  return error.code !== undefined && error.code.length > 0 ? error.code : undefined;
}

/**
 * Classifies an error thrown by a model stream as transient (worth retrying:
 * rate limits, server errors, network drops, timeouts) or permanent (auth
 * failures, malformed requests — retrying cannot help).
 */
export function isTransientModelError(error: unknown): boolean {
  if (error instanceof ModelRequestError) {
    if (error.status === undefined) return true; // network-level failure
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === 'NodeTimeoutError') return true;
  // Clients that don't throw ModelRequestError (e.g. the desktop Rust proxy)
  // embed the status in the message: "openai request failed (503): …".
  const status = /\((\d{3})\)/.exec(error.message);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 429 || code >= 500;
  }
  // fetch network failures surface as TypeError('fetch failed') & friends.
  if (error.name === 'TypeError') return true;
  return /network|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket|connection|timed? ?out/i.test(
    error.message,
  );
}

/** A tool call requested by the model (arguments = raw JSON string). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Opaque reasoning state a provider requires back, unmodified, when the
 * conversation continues after a tool call.
 *
 * - `anthropic`: the Messages API `thinking` / `redacted_thinking` content
 *   blocks with their `signature` (Claude rejects or silently disables
 *   thinking on a tool-use turn whose earlier thinking blocks are missing).
 * - `openrouter`: OpenRouter's `reasoning_details` array, which it maps back to
 *   the upstream provider's native form (signatures, encrypted reasoning).
 *
 * Never shown to the user and never interpreted - it is echoed verbatim on the
 * matching `assistant-tool-calls` message and ignored by every other adapter.
 */
export interface ReasoningReplay {
  format: 'anthropic' | 'openrouter';
  blocks: unknown[];
}

/** Provider-agnostic conversation message. Adapters map to wire formats. */
export type ChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | {
      role: 'assistant-tool-calls';
      text?: string;
      calls: ToolCall[];
      /** Reasoning state from the round that produced these calls. */
      reasoning?: ReasoningReplay;
    }
  | { role: 'tool-results'; results: { id: string; name: string; content: string }[] };

/** How hard a reasoning-capable model should think. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Asks the model to reason visibly before answering. Adapters that cannot
 * request reasoning (or whose models never stream it) ignore the field; a
 * model that reasons by default still streams `thinking` chunks without it.
 */
export interface ReasoningRequest {
  effort: ReasoningEffort;
}

/** JSON-Schema-ish parameters object accepted by all providers. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
}

export interface ModelRequest {
  provider: ModelProviderId;
  model: string;
  /** System prompt (markdown). */
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  /** Visible-output budget. Reasoning, when requested, is budgeted on top. */
  maxTokens?: number;
  /** Request visible reasoning (see {@link supportsReasoningRequest}). */
  reasoning?: ReasoningRequest;
  /** Ollama server override; defaults to http://localhost:11434. */
  ollamaBaseUrl?: string;
  /** LM Studio server override; defaults to http://localhost:1234. */
  lmstudioBaseUrl?: string;
  /**
   * AWS region for Amazon Bedrock, used to build the regional endpoint URL
   * (e.g. `ap-southeast-2`). Defaults to us-east-1.
   */
  bedrockRegion?: string;
}

/** Normalized token/cost usage for one model stream. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** USD actually charged - present only when the provider reports it (OpenRouter). */
  costUsd?: number;
  /**
   * How `costUsd` was obtained: `reported` = the provider returned the exact
   * charge (OpenRouter usage accounting); `estimated` = computed from token
   * counts and a pricing table (see pricing.ts). Absent when costUsd is absent.
   */
  costSource?: 'reported' | 'estimated';
}

/** One parsed frame of a model stream. */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  /**
   * Emitted once at end-of-stream when the response carried reasoning state
   * that must be echoed back on the next tool round (see ReasoningReplay).
   */
  | { type: 'reasoning-replay'; replay: ReasoningReplay }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done' };

/** A fully-built HTTP request, still carrying the API-key placeholder. */
export interface ProviderWireRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Streams completion chunks for a request. */
export interface ModelClient {
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

/** Stateful line parser for one streaming response. */
export interface StreamParser {
  push(line: string): ModelChunk[];
  /** Flushes anything buffered at end-of-stream. */
  end(): ModelChunk[];
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234';
/** Default AWS region for the Amazon Bedrock endpoint. */
const DEFAULT_BEDROCK_REGION = 'us-east-1';

/** Resolves the effective AWS region for a Bedrock request. */
function bedrockRegionOf(request: ModelRequest): string {
  return (request.bedrockRegion ?? DEFAULT_BEDROCK_REGION).trim() || DEFAULT_BEDROCK_REGION;
}

/**
 * Model families that REJECT non-default sampling parameters outright: sending
 * `temperature` (or `top_p` / `top_k`) is a hard 400, not a warning. Anthropic
 * retired the knobs from Claude Opus 4.7 onward, so Sonnet 5, Opus 4.7, Opus
 * 4.8, Opus 5 and Fable 5 all fail with "`temperature` is deprecated for this
 * model" - and it fails identically on the direct Anthropic API, on Bedrock
 * Converse, and on any OpenAI-compatible endpoint that forwards the field.
 *
 * The match is on the model id rather than the provider because the SAME model
 * arrives under four spellings: `claude-sonnet-5` (Anthropic),
 * `anthropic/claude-sonnet-5` (OpenRouter, Phorma Cloud),
 * `au.anthropic.claude-sonnet-5` (a Bedrock geographic inference profile) and
 * `anthropic.claude-sonnet-5-20260115-v1:0` (a versioned Bedrock model id).
 *
 * A version-number pattern beats an exhaustive id list here: every id for a
 * retired-knob model carries its family and version, so new point releases and
 * new regional profiles are covered without an edit. Deliberately does NOT
 * match `claude-sonnet-4-5` and friends, which still accept a temperature (they
 * only reject `temperature` and `top_p` TOGETHER, and the engine never sends
 * `top_p`).
 */
const NO_SAMPLING_PARAMS = /claude-(?:sonnet|opus|fable|haiku)-(?:5|4[-.]7|4[-.]8)\b/i;

/**
 * Whether a model accepts `temperature`. When false the field must be OMITTED
 * from the wire body - sending the provider's own default value is still a 400,
 * so there is no safe value to fall back to.
 */
export function acceptsSamplingParams(model: string): boolean {
  return !NO_SAMPLING_PARAMS.test(model);
}

/**
 * The temperature to put on the wire, or `undefined` to omit the field.
 * `JSON.stringify` drops an `undefined` property, which is exactly what these
 * models require.
 */
function wireTemperature(request: ModelRequest): number | undefined {
  return acceptsSamplingParams(request.model) ? request.temperature : undefined;
}

// ── Reasoning (thinking) requests ────────────────────────────────────────────────────────

/**
 * Claude models that take ADAPTIVE thinking (`thinking: {type: 'adaptive'}`):
 * the 4.6 generation onward. From 4.7 the manual `type: 'enabled'` form is a
 * hard 400, and from 4.7 `display` defaults to `omitted`, so the request must
 * opt into `display: 'summarized'` or the stream carries no thinking text.
 */
const ADAPTIVE_THINKING = /claude-(?:sonnet|opus|fable|mythos)-(?:5|4[-.][6-9])\b/i;

/**
 * Claude models that only take MANUAL extended thinking (`budget_tokens`):
 * Claude 3.7 Sonnet and the Claude 4 models up to 4.5. Checked after
 * {@link ADAPTIVE_THINKING}, which claims the newer ids first.
 */
const MANUAL_THINKING = /claude-(?:3-7-sonnet|(?:sonnet|opus)-4|haiku-4[-.]5)/i;

/** Thinking-token budget per effort level (manual budget / visible-output headroom). */
const REASONING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
};

/**
 * OpenRouter's `reasoning.effort` share of `max_tokens` (its documented
 * ratios). The request's `max_tokens` is inflated by this share so the
 * caller's `maxTokens` stays the budget for the VISIBLE answer.
 */
const OPENROUTER_EFFORT_SHARE: Record<ReasoningEffort, number> = {
  low: 0.2,
  medium: 0.5,
  high: 0.8,
};

/** Hard ceiling for an inflated `max_tokens` (well under every model's limit). */
const MAX_REASONING_MAX_TOKENS = 32_000;

/**
 * Whether the engine can ASK this provider/model for visible reasoning. False
 * does not mean the model never reasons - DeepSeek-R1 on Ollama streams
 * `reasoning_content` unasked - only that a {@link ReasoningRequest} is a
 * no-op, so a UI toggle for it should read as disabled.
 */
export function supportsReasoningRequest(provider: ModelProviderId, model: string): boolean {
  if (provider === 'openrouter' || provider === 'phorma-cloud') return true;
  if (provider === 'anthropic') return ADAPTIVE_THINKING.test(model) || MANUAL_THINKING.test(model);
  return false;
}

/** The Anthropic `thinking` config (and adjusted limits) for a request, or null. */
function anthropicThinking(
  request: ModelRequest,
): { thinking: object; maxTokens: number; omitTemperature: boolean } | null {
  if (!request.reasoning) return null;
  const base = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget = REASONING_BUDGET[request.reasoning.effort];
  // Thinking tokens count toward max_tokens in both modes, so the budget is
  // added on top rather than carved out of the visible answer.
  const maxTokens = Math.min(base + budget, MAX_REASONING_MAX_TOKENS);
  if (ADAPTIVE_THINKING.test(request.model)) {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      maxTokens,
      omitTemperature: true,
    };
  }
  if (MANUAL_THINKING.test(request.model)) {
    return {
      // budget_tokens must be >= 1024 and strictly below max_tokens.
      thinking: { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1024) },
      maxTokens,
      // `temperature` is incompatible with thinking on these models.
      omitTemperature: true,
    };
  }
  return null;
}

// ── Amazon Bedrock (Converse API) ────────────────────────────────────────────
//
// Bedrock is invoked through the unified `Converse` API on the bedrock-runtime
// endpoint, authenticated with a Bedrock API key. Converse works for every
// model family (Claude, Nova, Llama, gpt-oss, …) AND accepts cross-region /
// geographic inference profile ids (e.g. `au.anthropic.claude-opus-4-7`) —
// unlike the OpenAI Chat Completions endpoint (open-weight only) or the mantle
// Messages API (doesn't serve geo inference profiles). This is non-streaming:
// Converse returns a single JSON body. `ConverseStream` returns AWS's binary
// event-stream, which the line-based proxy can't parse yet — a later addition.

/** Maps engine messages to the Converse `messages` array. */
function converseMessages(request: ModelRequest): object[] {
  const wire: object[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant-tool-calls') {
      const content: object[] = [];
      if (message.text?.trim()) content.push({ text: message.text });
      for (const call of message.calls) {
        content.push({
          toolUse: { toolUseId: call.id, name: call.name, input: safeParseJson(call.arguments) },
        });
      }
      wire.push({ role: 'assistant', content });
    } else if (message.role === 'tool-results') {
      wire.push({
        role: 'user',
        content: message.results.map(result => ({
          toolResult: { toolUseId: result.id, content: [{ text: result.content }] },
        })),
      });
    } else {
      wire.push({ role: message.role, content: [{ text: message.content }] });
    }
  }
  return wire;
}

/** Builds the Bedrock Converse request body. */
function converseBody(request: ModelRequest): string {
  const inferenceConfig: Record<string, unknown> = {
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  const temperature = wireTemperature(request);
  if (temperature !== undefined) inferenceConfig['temperature'] = temperature;

  const body: Record<string, unknown> = {
    messages: converseMessages(request),
    inferenceConfig,
  };
  if (request.system?.trim()) body['system'] = [{ text: request.system }];
  if (request.tools?.length) {
    body['toolConfig'] = {
      tools: request.tools.map(tool => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.parameters },
        },
      })),
    };
  }
  return JSON.stringify(body);
}

/**
 * Parses a non-streaming Converse response. Accumulates the JSON body across
 * pushes (the body has no line framing) and decodes it on `end()` into text,
 * tool-call, and usage chunks.
 */
class ConverseResponseParser implements StreamParser {
  private buffer = '';

  push(line: string): ModelChunk[] {
    this.buffer += line;
    return [];
  }

  end(): ModelChunk[] {
    const raw = this.buffer;
    this.buffer = '';
    if (!raw.trim()) return [{ type: 'done' }];

    let parsed: {
      output?: {
        message?: {
          content?: {
            text?: string;
            toolUse?: { toolUseId?: string; name?: string; input?: unknown };
          }[];
        };
      };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [{ type: 'done' }];
    }

    const chunks: ModelChunk[] = [];
    let toolCounter = 0;
    for (const block of parsed.output?.message?.content ?? []) {
      if (block.text) chunks.push({ type: 'text', text: block.text });
      if (block.toolUse) {
        toolCounter += 1;
        chunks.push({
          type: 'tool-call',
          call: {
            id: block.toolUse.toolUseId ?? `call_${toolCounter}`,
            name: block.toolUse.name ?? '',
            arguments: JSON.stringify(block.toolUse.input ?? {}),
          },
        });
      }
    }
    if (parsed.usage) {
      chunks.push({
        type: 'usage',
        usage: { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens },
      });
    }
    chunks.push({ type: 'done' });
    return chunks;
  }
}

interface ProviderAdapter {
  buildRequest(request: ModelRequest): ProviderWireRequest;
  /**
   * Creates the stream parser for a response. Receives the request because
   * some providers (Bedrock) speak different wire formats per model family.
   */
  createParser(request: ModelRequest): StreamParser;
  /** Whether this provider requires an API key. */
  requiresKey: boolean;
}

// ── OpenAI-compatible family (OpenAI, OpenRouter, Gemini-compat, Ollama) ─────

function openAiMessages(request: ModelRequest): object[] {
  const wire: object[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'assistant-tool-calls') {
      wire.push({
        role: 'assistant',
        content: message.text ?? null,
        tool_calls: message.calls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
        // OpenRouter maps these back to the upstream's native reasoning
        // blocks (Claude signatures, encrypted OpenAI reasoning). Only ever
        // present when the previous round came from OpenRouter's wire.
        reasoning_details:
          message.reasoning?.format === 'openrouter' ? message.reasoning.blocks : undefined,
      });
    } else if (message.role === 'tool-results') {
      for (const result of message.results) {
        wire.push({ role: 'tool', tool_call_id: result.id, content: result.content });
      }
    } else {
      wire.push({ role: message.role, content: message.content });
    }
  }
  return wire;
}

function openAiBody(request: ModelRequest): string {
  // Usage reporting: OpenAI, OpenRouter, Gemini's OpenAI-compat shim, and
  // Ollama all support stream_options.include_usage (final chunk carries
  // token counts). OpenRouter additionally returns the actual USD cost when
  // usage accounting is requested. Phorma Cloud reuses the OpenRouter wire
  // format (the proxy forwards to OpenRouter), so it gets the same usage
  // accounting.
  const wantsUsage =
    request.provider === 'openai' ||
    request.provider === 'openrouter' ||
    request.provider === 'phorma-cloud' ||
    request.provider === 'gemini' ||
    request.provider === 'ollama';
  const wantsCost = request.provider === 'openrouter' || request.provider === 'phorma-cloud';
  // OpenRouter's unified `reasoning` parameter (Phorma Cloud forwards to
  // OpenRouter). Effort is a SHARE of max_tokens there, so max_tokens is
  // inflated to keep the caller's budget for the visible answer.
  const reasoning = wantsCost && request.reasoning ? request.reasoning : undefined;
  const baseMaxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTokens = reasoning
    ? Math.min(
        Math.round(baseMaxTokens / (1 - OPENROUTER_EFFORT_SHARE[reasoning.effort])),
        MAX_REASONING_MAX_TOKENS,
      )
    : baseMaxTokens;
  return JSON.stringify({
    model: request.model,
    stream: true,
    temperature: wireTemperature(request),
    max_tokens: maxTokens,
    messages: openAiMessages(request),
    reasoning: reasoning ? { effort: reasoning.effort } : undefined,
    stream_options: wantsUsage ? { include_usage: true } : undefined,
    usage: wantsCost ? { include: true } : undefined,
    tools: request.tools?.length
      ? request.tools.map(tool => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }))
      : undefined,
  });
}

/**
 * Rebuilds OpenRouter's `reasoning_details` from streamed fragments. Each
 * fragment carries an `index`; fragments sharing one are pieces of the same
 * detail, so their text-like fields concatenate and scalar fields (signature,
 * id, format, type) take the latest non-empty value. The result is echoed back
 * verbatim, so nothing here interprets the content.
 */
class ReasoningDetailsAccumulator {
  private readonly byIndex = new Map<number, Record<string, unknown>>();
  private nextIndex = 0;

  push(fragments: readonly unknown[]): void {
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== 'object') continue;
      const record = fragment as Record<string, unknown>;
      const index = typeof record['index'] === 'number' ? record['index'] : this.nextIndex++;
      const existing = this.byIndex.get(index);
      if (!existing) {
        this.byIndex.set(index, { ...record });
        continue;
      }
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '') continue;
        if ((key === 'text' || key === 'summary' || key === 'data') && typeof value === 'string') {
          const prior = existing[key];
          existing[key] = typeof prior === 'string' ? prior + value : value;
        } else {
          existing[key] = value;
        }
      }
    }
  }

  drain(): unknown[] {
    const blocks = [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
    this.byIndex.clear();
    this.nextIndex = 0;
    return blocks;
  }
}

/** Assembles OpenAI streaming deltas (text + fragmented tool calls). */
class OpenAiStreamParser implements StreamParser {
  private readonly pending = new Map<number, { id: string; name: string; args: string }>();
  private toolCounter = 0;
  /** OpenRouter `reasoning_details`, merged across stream fragments. */
  private readonly details = new ReasoningDetailsAccumulator();

  push(line: string): ModelChunk[] {
    if (!line.startsWith('data:')) return [];
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return this.end();

    let parsed: {
      choices?: {
        delta?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
          reasoning_details?: unknown[] | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        /** OpenRouter usage accounting: USD actually charged. */
        cost?: number;
      } | null;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }

    const chunks: ModelChunk[] = [];

    // Usage arrives on a final chunk (typically with an empty choices array)
    // when stream_options.include_usage / OpenRouter usage accounting is on.
    if (parsed.usage) {
      chunks.push({
        type: 'usage',
        usage: {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          costUsd: parsed.usage.cost,
          costSource: parsed.usage.cost !== undefined ? 'reported' : undefined,
        },
      });
    }

    const choice = parsed.choices?.[0];
    if (!choice) return chunks;

    if (choice.delta?.content) {
      chunks.push({ type: 'text', text: choice.delta.content });
    }
    // Reasoning/thinking tokens (OpenRouter, DeepSeek, o1-style models).
    // Carried separately so the engine can route them to a thinking channel
    // without polluting the answer text or handoff payload.
    if (choice.delta?.reasoning) {
      chunks.push({ type: 'thinking', text: choice.delta.reasoning });
    }
    if (choice.delta?.reasoning_content) {
      chunks.push({ type: 'thinking', text: choice.delta.reasoning_content });
    }
    // Structured reasoning state for replay. Not re-emitted as `thinking`:
    // OpenRouter mirrors the readable text into `delta.reasoning` above.
    if (Array.isArray(choice.delta?.reasoning_details)) {
      this.details.push(choice.delta.reasoning_details);
    }
    for (const fragment of choice.delta?.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      let call = this.pending.get(index);
      if (!call) {
        this.toolCounter += 1;
        call = { id: fragment.id ?? `call_${this.toolCounter}`, name: '', args: '' };
        this.pending.set(index, call);
      }
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.args += fragment.function.arguments;
    }
    // Some servers (e.g. Ollama) send finish_reason without a [DONE] line.
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
      chunks.push(...this.flushCalls());
    }
    return chunks;
  }

  end(): ModelChunk[] {
    const chunks: ModelChunk[] = this.flushCalls();
    const blocks = this.details.drain();
    if (blocks.length > 0) {
      chunks.push({ type: 'reasoning-replay', replay: { format: 'openrouter', blocks } });
    }
    chunks.push({ type: 'done' });
    return chunks;
  }

  private flushCalls(): ModelChunk[] {
    const chunks: ModelChunk[] = [];
    for (const [, call] of [...this.pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.name) {
        chunks.push({
          type: 'tool-call',
          call: { id: call.id, name: call.name, arguments: call.args || '{}' },
        });
      }
    }
    this.pending.clear();
    return chunks;
  }
}

function openAiCompatible(
  url: string | ((req: ModelRequest) => string),
  requiresKey: boolean,
): ProviderAdapter {
  return {
    requiresKey,
    buildRequest(request) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (requiresKey) headers['Authorization'] = `Bearer ${API_KEY_PLACEHOLDER}`;
      return {
        url: typeof url === 'function' ? url(request) : url,
        method: 'POST',
        headers,
        body: openAiBody(request),
      };
    },
    createParser: () => new OpenAiStreamParser(),
  };
}

// ── Anthropic (Messages API) ─────────────────────────────────────────────────

function anthropicMessages(request: ModelRequest): object[] {
  const wire: object[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant-tool-calls') {
      const content: object[] = [];
      // Thinking blocks go back first and verbatim - Claude rejects a tool-use
      // continuation whose thinking was edited, reordered or dropped.
      if (message.reasoning?.format === 'anthropic') {
        content.push(...(message.reasoning.blocks as object[]));
      }
      if (message.text?.trim()) content.push({ type: 'text', text: message.text });
      for (const call of message.calls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeParseJson(call.arguments),
        });
      }
      wire.push({ role: 'assistant', content });
    } else if (message.role === 'tool-results') {
      wire.push({
        role: 'user',
        content: message.results.map(result => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
        })),
      });
    } else {
      wire.push({ role: message.role, content: message.content });
    }
  }
  return wire;
}

/** Assembles Anthropic streaming events (text deltas + tool_use blocks). */
class AnthropicStreamParser implements StreamParser {
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
  /** Thinking / redacted_thinking blocks by content index, for replay. */
  private readonly thinkingBlocks = new Map<
    number,
    { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }
  >();
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;

  push(line: string): ModelChunk[] {
    if (!line.startsWith('data:')) return [];
    let parsed: {
      type?: string;
      index?: number;
      message?: { usage?: { input_tokens?: number } };
      content_block?: { type?: string; id?: string; name?: string; data?: string };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
      };
      usage?: { output_tokens?: number };
    };
    try {
      parsed = JSON.parse(line.slice(5).trim());
    } catch {
      return [];
    }

    switch (parsed.type) {
      case 'message_start':
        this.inputTokens = parsed.message?.usage?.input_tokens;
        return [];
      case 'message_delta':
        // Anthropic reports CUMULATIVE output tokens on each message_delta —
        // keep the latest value rather than summing.
        if (parsed.usage?.output_tokens !== undefined) {
          this.outputTokens = parsed.usage.output_tokens;
        }
        return [];
      case 'content_block_start':
        if (parsed.content_block?.type === 'tool_use') {
          this.blocks.set(parsed.index ?? 0, {
            id: parsed.content_block.id ?? `toolu_${parsed.index ?? 0}`,
            name: parsed.content_block.name ?? '',
            json: '',
          });
        } else if (parsed.content_block?.type === 'thinking') {
          this.thinkingBlocks.set(parsed.index ?? 0, { type: 'thinking', thinking: '', signature: '' });
        } else if (parsed.content_block?.type === 'redacted_thinking') {
          this.thinkingBlocks.set(parsed.index ?? 0, {
            type: 'redacted_thinking',
            data: parsed.content_block.data ?? '',
          });
        }
        return [];
      case 'content_block_delta':
        if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
          return [{ type: 'text', text: parsed.delta.text }];
        }
        if (parsed.delta?.type === 'thinking_delta') {
          const block = this.thinkingBlocks.get(parsed.index ?? 0);
          if (block?.type === 'thinking') block.thinking += parsed.delta.thinking ?? '';
          return parsed.delta.thinking ? [{ type: 'thinking', text: parsed.delta.thinking }] : [];
        }
        if (parsed.delta?.type === 'signature_delta') {
          const block = this.thinkingBlocks.get(parsed.index ?? 0);
          if (block?.type === 'thinking') block.signature += parsed.delta.signature ?? '';
          return [];
        }
        if (parsed.delta?.type === 'input_json_delta') {
          const block = this.blocks.get(parsed.index ?? 0);
          if (block) block.json += parsed.delta.partial_json ?? '';
        }
        return [];
      case 'content_block_stop': {
        const block = this.blocks.get(parsed.index ?? 0);
        if (block) {
          this.blocks.delete(parsed.index ?? 0);
          return [
            {
              type: 'tool-call',
              call: { id: block.id, name: block.name, arguments: block.json || '{}' },
            },
          ];
        }
        return [];
      }
      case 'message_stop':
        return this.end();
      default:
        return [];
    }
  }

  end(): ModelChunk[] {
    this.blocks.clear();
    const chunks: ModelChunk[] = [];
    if (this.thinkingBlocks.size > 0) {
      const blocks = [...this.thinkingBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, block]) => block);
      this.thinkingBlocks.clear();
      chunks.push({ type: 'reasoning-replay', replay: { format: 'anthropic', blocks } });
    }
    if (this.inputTokens !== undefined || this.outputTokens !== undefined) {
      chunks.push({
        type: 'usage',
        usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      });
      this.inputTokens = undefined;
      this.outputTokens = undefined;
    }
    chunks.push({ type: 'done' });
    return chunks;
  }
}

/** Builds the Anthropic Messages API request body (shared by Anthropic + Bedrock). */
function anthropicBody(request: ModelRequest): string {
  const thinking = anthropicThinking(request);
  return JSON.stringify({
    model: request.model,
    stream: true,
    temperature: thinking?.omitTemperature ? undefined : wireTemperature(request),
    max_tokens: thinking?.maxTokens ?? request.maxTokens ?? DEFAULT_MAX_TOKENS,
    thinking: thinking?.thinking,
    system: request.system,
    messages: anthropicMessages(request),
    tools: request.tools?.length
      ? request.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }))
      : undefined,
  });
}

const anthropicAdapter: ProviderAdapter = {
  requiresKey: true,
  buildRequest(request) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY_PLACEHOLDER,
        'anthropic-version': '2023-06-01',
        // Required when calling straight from a browser context (web mode).
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: anthropicBody(request),
    };
  },
  createParser: () => new AnthropicStreamParser(),
};

/**
 * Amazon Bedrock adapter — the unified Converse API on bedrock-runtime,
 * authenticated with a Bedrock API key. The model id (or inference profile id)
 * goes in the URL path; it's URL-encoded so versioned ids containing `:` work.
 */
const bedrockAdapter: ProviderAdapter = {
  requiresKey: true,
  buildRequest(request): ProviderWireRequest {
    const region = bedrockRegionOf(request);
    return {
      url: `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
        request.model,
      )}/converse`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY_PLACEHOLDER}`,
      },
      body: converseBody(request),
    };
  },
  createParser: () => new ConverseResponseParser(),
};

const ADAPTERS: Record<ModelProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openAiCompatible('https://api.openai.com/v1/chat/completions', true),
  openrouter: openAiCompatible('https://openrouter.ai/api/v1/chat/completions', true),
  // Google exposes an OpenAI-compatible endpoint for Gemini.
  gemini: openAiCompatible(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    true,
  ),
  ollama: openAiCompatible(
    request =>
      `${(request.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '')}/v1/chat/completions`,
    false,
  ),
  lmstudio: openAiCompatible(
    request =>
      `${(request.lmstudioBaseUrl ?? DEFAULT_LMSTUDIO_BASE_URL).replace(/\/$/, '')}/v1/chat/completions`,
    false,
  ),
  bedrock: bedrockAdapter,
  // Phorma Cloud: the studio's composite ModelClient intercepts this provider
  // and POSTs the built (OpenRouter-shaped) request to the Phorma Cloud
  // /api/infer proxy, which injects the tenant's runtime key. The adapter
  // itself is never called locally for a real run — it exists so the engine
  // type contract stays exhaustive and so deployed workflows can map
  // phorma-cloud nodes to OpenRouter. requiresKey is false because the local
  // client never holds a key (the proxy does).
  'phorma-cloud': openAiCompatible('https://openrouter.ai/api/v1/chat/completions', false),
};

export function providerAdapter(provider: ModelProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}

export function buildWireRequest(request: ModelRequest): ProviderWireRequest {
  return providerAdapter(request.provider).buildRequest(request);
}

export function providerRequiresKey(provider: ModelProviderId): boolean {
  return ADAPTERS[provider].requiresKey;
}

/**
 * Creates a stateful stream parser for a request's response lines. Takes the
 * full request because some providers (Bedrock) pick the wire format per model.
 */
export function createStreamParser(request: ModelRequest): StreamParser {
  return ADAPTERS[request.provider].createParser(request);
}

/** Substitutes the API-key placeholder into a built request. */
export function substituteApiKey(
  request: ProviderWireRequest,
  apiKey: string,
): ProviderWireRequest {
  const replace = (value: string): string => value.split(API_KEY_PLACEHOLDER).join(apiKey);
  return {
    ...request,
    url: replace(request.url),
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, replace(value)]),
    ),
  };
}

/** Resolves an API key for a provider (null when none stored). */
export type ApiKeyResolver = (provider: ModelProviderId) => Promise<string | null>;

/**
 * fetch-based streaming client. Works anywhere `fetch` + ReadableStream exist
 * (browsers, Cloudflare workers). The desktop app uses the Rust proxy client
 * instead so keys stay in the OS keychain.
 */
export class FetchModelClient implements ModelClient {
  constructor(private readonly resolveKey: ApiKeyResolver) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const adapter = providerAdapter(request.provider);
    let wire = adapter.buildRequest(request);

    if (adapter.requiresKey) {
      const key = await this.resolveKey(request.provider);
      if (!key) {
        throw new Error(
          `No API key configured for ${request.provider}. Add one in Settings.`,
        );
      }
      wire = substituteApiKey(wire, key);
    }

    const response = await fetch(wire.url, {
      method: wire.method,
      headers: wire.headers,
      body: wire.body,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new ModelRequestError(
        `${request.provider} request failed (${response.status}): ${truncate(detail, 300)}`,
        response.status,
      );
    }

    const parser = adapter.createParser(request);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex).trimEnd();
          buffered = buffered.slice(newlineIndex + 1);
          for (const chunk of parser.push(line)) {
            if (chunk.type === 'done') return;
            yield chunk;
          }
          newlineIndex = buffered.indexOf('\n');
        }
      }
      // Flush any trailing content with no closing newline (e.g. a
      // non-streaming JSON body like Bedrock Converse) before finalizing.
      if (buffered.trim().length > 0) {
        for (const chunk of parser.push(buffered)) {
          if (chunk.type === 'done') return;
          yield chunk;
        }
      }
      for (const chunk of parser.end()) {
        if (chunk.type === 'done') return;
        yield chunk;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
