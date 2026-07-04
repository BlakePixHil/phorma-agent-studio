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
}

/** One parsed frame of a model stream. */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; call: ToolCall }
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

interface ProviderAdapter {
  buildRequest(request: ModelRequest): ProviderWireRequest;
  createParser(): StreamParser;
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
  return JSON.stringify({
    model: request.model,
    stream: true,
    temperature: request.temperature,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: openAiMessages(request),
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
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }

    const chunks: ModelChunk[] = [];
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

  push(line: string): ModelChunk[] {
    if (!line.startsWith('data:')) return [];
    let parsed: {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    };
    try {
      parsed = JSON.parse(line.slice(5).trim());
    } catch {
      return [];
    }

    switch (parsed.type) {
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
    return [{ type: 'done' }];
  }
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
      body: JSON.stringify({
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
      }),
    };
  },
  createParser: () => new AnthropicStreamParser(),
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

/** Creates a stateful stream parser for a provider's response lines. */
export function createStreamParser(provider: ModelProviderId): StreamParser {
  return ADAPTERS[provider].createParser();
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

    const parser = adapter.createParser();
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
