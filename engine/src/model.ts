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

import type { ModelProviderId } from './types.js';

export const API_KEY_PLACEHOLDER = '{{API_KEY}}';

/** A tool call requested by the model (arguments = raw JSON string). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Provider-agnostic conversation message. Adapters map to wire formats. */
export type ChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant-tool-calls'; text?: string; calls: ToolCall[] }
  | { role: 'tool-results'; results: { id: string; name: string; content: string }[] };

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
  maxTokens?: number;
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
  /** USD actually charged — present only when the provider reports it (OpenRouter). */
  costUsd?: number;
}

/** One parsed frame of a model stream. */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; call: ToolCall }
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
  if (request.temperature !== undefined) inferenceConfig['temperature'] = request.temperature;

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
  // Usage reporting: OpenAI + OpenRouter support stream_options.include_usage
  // (final chunk carries token counts). OpenRouter additionally returns the
  // actual USD cost when usage accounting is requested. Gemini's and Ollama's
  // OpenAI-compat shims are not guaranteed to accept these fields, so they
  // are only sent to providers known to support them. Phorma Cloud reuses the
  // OpenRouter wire format (the proxy forwards to OpenRouter), so it gets the
  // same usage accounting.
  const wantsUsage =
    request.provider === 'openai' ||
    request.provider === 'openrouter' ||
    request.provider === 'phorma-cloud';
  const wantsCost = request.provider === 'openrouter' || request.provider === 'phorma-cloud';
  return JSON.stringify({
    model: request.model,
    stream: true,
    temperature: request.temperature,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: openAiMessages(request),
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

/** Assembles OpenAI streaming deltas (text + fragmented tool calls). */
class OpenAiStreamParser implements StreamParser {
  private readonly pending = new Map<number, { id: string; name: string; args: string }>();
  private toolCounter = 0;

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
    return [...this.flushCalls(), { type: 'done' }];
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
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;

  push(line: string): ModelChunk[] {
    if (!line.startsWith('data:')) return [];
    let parsed: {
      type?: string;
      index?: number;
      message?: { usage?: { input_tokens?: number } };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
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
        }
        return [];
      case 'content_block_delta':
        if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
          return [{ type: 'text', text: parsed.delta.text }];
        }
        if (parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
          return [{ type: 'thinking', text: parsed.delta.thinking }];
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
  return JSON.stringify({
    model: request.model,
    stream: true,
    temperature: request.temperature,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
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
      throw new Error(
        `${request.provider} request failed (${response.status}): ${truncate(detail, 300)}`,
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
