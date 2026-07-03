/**
 * Tooling contract + shared tool utilities.
 *
 * The ENGINE decides which tools an agent may call (from its tool-link
 * edges), builds the provider-facing schemas, and runs the tool loop. The
 * HOST (studio or cloud worker) supplies a {@link ToolHost} that knows how to
 * actually list and execute them:
 *  - Studio desktop: HTTP via the Rust backend, MCP stdio via Rust sessions.
 *  - Studio browser / Cloudflare worker: HTTP via fetch, MCP over
 *    streamable HTTP via {@link HttpMcpClient}.
 */

import type { ToolDefinition } from './model.js';
import type { WorkflowNode } from './types.js';

/** A tool an agent may call, resolved to its owning tool node. */
export interface ResolvedTool {
  definition: ToolDefinition;
  /** The tool node this definition came from. */
  nodeId: string;
  /** The tool's native name on its server (MCP) — differs from wire name. */
  nativeName: string;
}

/** Host-provided tool discovery + execution. Must never throw on execute —
 * return an error string instead so the model can react. */
export interface ToolHost {
  /** Lists the tool definitions a tool node contributes (MCP → many). */
  listTools(node: WorkflowNode): Promise<Omit<ResolvedTool, 'nodeId'>[]>;
  /** Executes a call. Returns the result content (or an error description). */
  callTool(node: WorkflowNode, nativeName: string, argumentsJson: string): Promise<string>;
}

/** Providers accept tool names matching [a-zA-Z0-9_-]{1,64}. */
export function sanitizeToolName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 48);
  return cleaned.replace(/^_+|_+$/g, '') || 'tool';
}

/** Builds the wire-unique tool list for an agent's attached tool nodes. */
export async function resolveAgentTools(
  toolNodes: WorkflowNode[],
  host: ToolHost,
): Promise<ResolvedTool[]> {
  const resolved: ResolvedTool[] = [];
  const seen = new Set<string>();
  for (const node of toolNodes) {
    const tools = await host.listTools(node);
    for (const tool of tools) {
      let wireName = tool.definition.name;
      let attempt = 1;
      while (seen.has(wireName)) {
        attempt += 1;
        wireName = `${tool.definition.name}_${attempt}`.slice(0, 60);
      }
      seen.add(wireName);
      resolved.push({
        definition: { ...tool.definition, name: wireName },
        nativeName: tool.nativeName,
        nodeId: node.id,
      });
    }
  }
  return resolved;
}

// ── Built-in tool schemas (HTTP request, web search) ─────────────────────────

/** Default definition for an `http-tool` node. */
export function httpToolDefinition(node: WorkflowNode): ToolDefinition {
  const data = node.data as { method?: string; url?: string };
  return {
    name: sanitizeToolName(node.name),
    description:
      `${data.method ?? 'GET'} ${data.url ?? '(no URL configured)'}` +
      (node.description ? ` — ${node.description}` : ''),
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description:
            'Interpolated into the {{input}} placeholder of the URL and body template.',
        },
      },
      required: ['input'],
    },
  };
}

/** Default definition for a `web-search-tool` node. */
export function webSearchToolDefinition(node: WorkflowNode): ToolDefinition {
  return {
    name: sanitizeToolName(node.name),
    description: 'Search the web and return a short summary of top results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  };
}

/** Builds the concrete HTTP request an `http-tool` call should perform. */
export function buildHttpToolRequest(
  node: WorkflowNode,
  argumentsJson: string,
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const data = node.data as {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
  };
  const args = safeParse(argumentsJson) as { input?: unknown };
  const input = typeof args.input === 'string' ? args.input : JSON.stringify(args.input ?? '');
  const interpolate = (value: string): string =>
    value.split('{{input}}').join(input);

  const method = (data.method ?? 'GET').toUpperCase();
  return {
    url: interpolate(data.url ?? ''),
    method,
    headers: data.headers ?? {},
    body: method !== 'GET' && data.bodyTemplate ? interpolate(data.bodyTemplate) : undefined,
  };
}

/** Fetches raw text from a URL. Hosts supply this (Rust proxy, plain fetch). */
export type TextFetcher = (url: string, headers?: Record<string, string>) => Promise<string>;

const DUCKDUCKGO_ENDPOINT = 'https://api.duckduckgo.com/';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

/** User-Agent for outbound web-search requests. Wikipedia's API rejects
 * requests with no User-Agent (HTTP 403 "Please set a user-agent"), and
 * reqwest / Cloudflare Workers fetch send none by default. */
const WEB_SEARCH_USER_AGENT = 'PhormaAgentStudio/0.1 (https://phorma.dev)';
const WEB_SEARCH_HEADERS: Record<string, string> = { 'User-Agent': WEB_SEARCH_USER_AGENT };

/**
 * Web search for agents. Tries DuckDuckGo's free Instant Answer API first
 * (fast, precise for a single well-known entity), then falls back to
 * Wikipedia's full-text search + intro extract.
 *
 * This two-step fallback matters in practice: Instant Answer only resolves
 * bare entity names ("Roman Empire") and returns COMPLETELY EMPTY for
 * anything phrased as a question or command ("Research the roman empire",
 * "tell me about the roman empire") — exactly how LLMs write search queries.
 * Wikipedia's search API does real full-text matching, so it covers the
 * natural-language case Instant Answer misses.
 */
export async function performWebSearch(argumentsJson: string, fetchText: TextFetcher): Promise<string> {
  const args = safeParse(argumentsJson) as { query?: unknown };
  const query = typeof args.query === 'string' ? args.query : String(args.query ?? '');
  if (!query.trim()) return 'Error: no search query provided.';

  const instant = await tryInstantAnswer(query, fetchText);
  if (instant) return instant;

  const wiki = await tryWikipediaSearch(query, fetchText);
  return wiki ?? `No results found for "${query}".`;
}

async function tryInstantAnswer(query: string, fetchText: TextFetcher): Promise<string | null> {
  const url = `${DUCKDUCKGO_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const raw = await fetchText(url, WEB_SEARCH_HEADERS).catch(() => '');
  const parsed = safeParse(raw) as {
    AbstractText?: string;
    AbstractURL?: string;
    Answer?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };

  const lines: string[] = [];
  if (parsed.Answer) lines.push(`Answer: ${parsed.Answer}`);
  if (parsed.AbstractText) {
    lines.push(`${parsed.AbstractText}${parsed.AbstractURL ? ` (${parsed.AbstractURL})` : ''}`);
  }
  for (const topic of parsed.RelatedTopics ?? []) {
    if (lines.length >= 6) break;
    if (topic.Text) lines.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ''}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

async function tryWikipediaSearch(query: string, fetchText: TextFetcher): Promise<string | null> {
  // origin=* makes Wikipedia return CORS headers so browser fetch can read
  // the response; harmless for the Rust proxy and Cloudflare Workers.
  const searchUrl = `${WIKIPEDIA_API}?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}&origin=*`;
  const raw = await fetchText(searchUrl, WEB_SEARCH_HEADERS).catch(() => '');
  const parsed = safeParse(raw) as { query?: { search?: { title?: string; snippet?: string }[] } };
  const results = (parsed.query?.search ?? []).filter(result => result.title);
  if (results.length === 0) return null;

  const lines = results.map(result => `- ${result.title}: ${stripHtml(result.snippet ?? '')}`);

  // Ground the answer with the top match's intro paragraph when available.
  const topTitle = results[0]?.title;
  if (topTitle) {
    const extractUrl = `${WIKIPEDIA_API}?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles=${encodeURIComponent(topTitle)}&origin=*`;
    const extractRaw = await fetchText(extractUrl, WEB_SEARCH_HEADERS).catch(() => '');
    const extractParsed = safeParse(extractRaw) as {
      query?: { pages?: Record<string, { extract?: string }> };
    };
    const extract = Object.values(extractParsed.query?.pages ?? {})[0]?.extract;
    if (extract?.trim()) {
      lines.unshift(`${extract.trim()}\n(Wikipedia: ${topTitle})`);
    }
  }
  return lines.join('\n');
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

// ── Minimal MCP client over streamable HTTP ──────────────────────────────────

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/**
 * A minimal Model Context Protocol client for HTTP(S) servers (streamable
 * HTTP transport). Used for `mcp-tool` nodes with `transport: 'sse'` — in the
 * browser, in the cloud worker, and on desktop. Stdio servers are handled by
 * the desktop's Rust sessions instead.
 */
export class HttpMcpClient {
  private requestId = 0;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(private readonly endpoint: string) {}

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: object }[]> {
    await this.initialize();
    const result = (await this.rpc('tools/list', {})) as {
      tools?: { name: string; description?: string; inputSchema?: object }[];
    };
    return result.tools ?? [];
  }

  async callTool(name: string, argumentsJson: string): Promise<string> {
    await this.initialize();
    const result = (await this.rpc('tools/call', {
      name,
      arguments: safeParse(argumentsJson),
    })) as { content?: { type?: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .map(part => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
      .join('\n');
    return result.isError ? `Tool error: ${text}` : text || '(empty result)';
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'phorma-agent-studio', version: '0.1.0' },
    });
    // Per spec, notify after the initialize handshake completes.
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  private async rpc(method: string, params: object): Promise<unknown> {
    this.requestId += 1;
    const response = await this.post({
      jsonrpc: '2.0',
      id: this.requestId,
      method,
      params,
    });
    if (response?.error) {
      throw new Error(response.error.message ?? `MCP ${method} failed.`);
    }
    return response?.result;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method }, true).catch(() => undefined);
  }

  private async post(body: object, isNotification = false): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.sessionId = session;

    if (isNotification) return null;
    if (!response.ok) {
      throw new Error(`MCP server returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const raw = await response.text();
    if (contentType.includes('text/event-stream')) {
      // Streamable HTTP: the response arrives as SSE data lines.
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const parsed = safeParse(line.slice(5).trim()) as JsonRpcResponse;
        if (parsed && typeof parsed === 'object' && 'id' in parsed) return parsed;
      }
      throw new Error('MCP server sent no response frame.');
    }
    return safeParse(raw) as JsonRpcResponse;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
