/**
 * Minimal MCP server core — framework-free, mirroring the engine's
 * zero-dependency discipline. Speaks MCP JSON-RPC (protocol 2025-03-26):
 * initialize, tools/list, tools/call. Transports live in stdio.ts / http.ts.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolContext {
  /** Environment/secret lookup (process.env on stdio, worker env on HTTP). */
  env(name: string): string | undefined;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const SERVER_INFO = { name: 'phorma-practice-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-03-26';

export class McpServer {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly ctx: ToolContext) {}

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  /** Handles one JSON-RPC message. Returns null for notifications. */
  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    // Notifications (no id) get no response.
    const isNotification = request.id === undefined;

    try {
      switch (request.method) {
        case 'initialize':
          return this.respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        case 'notifications/initialized':
        case 'initialized':
          return null;
        case 'ping':
          return this.respond(id, {});
        case 'tools/list':
          return this.respond(id, {
            tools: [...this.tools.values()].map(tool => tool.definition),
          });
        case 'tools/call': {
          const params = request.params as { name?: string; arguments?: Record<string, unknown> };
          const tool = params?.name ? this.tools.get(params.name) : undefined;
          if (!tool) {
            return this.respond(id, {
              content: [{ type: 'text', text: `Unknown tool "${params?.name}".` }],
              isError: true,
            });
          }
          try {
            const text = await tool.handler(params.arguments ?? {}, this.ctx);
            return this.respond(id, { content: [{ type: 'text', text }], isError: false });
          } catch (error) {
            // Tool errors flow back as content so the model can react.
            const message = error instanceof Error ? error.message : String(error);
            return this.respond(id, {
              content: [{ type: 'text', text: `Error: ${message}` }],
              isError: true,
            });
          }
        }
        default:
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private respond(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }
}

// ── Shared helpers for tool modules ──────────────────────────────────────────

/** Requires a string argument, throwing a descriptive error when missing. */
export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required argument "${name}".`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Requires a string argument that is a safe resource identifier for URL-path
 * use (alphanumerics, dash, underscore, dot — no slashes, no query chars).
 * Model-supplied ids are interpolated into API paths; this blocks path
 * injection (`../other.api/…`) against the authenticated session.
 */
export function requireId(args: Record<string, unknown>, name: string): string {
  const value = requireString(args, name);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new Error(`Argument "${name}" must be a plain resource id (got "${value.slice(0, 40)}").`);
  }
  return value;
}

/** Requires a secret from the host environment. */
export function requireEnv(ctx: ToolContext, name: string, hint: string): string {
  const value = ctx.env(name);
  if (!value?.trim()) {
    throw new Error(`${name} is not configured. ${hint}`);
  }
  return value.trim();
}

/** JSON-ish fetch with descriptive errors and a body-size cap. */
export async function apiFetch(
  url: string,
  init: RequestInit & { expectBinary?: boolean } = {},
): Promise<{ status: number; json: unknown; text: string; bytes?: Uint8Array }> {
  const response = await fetch(url, init);
  if (init.expectBinary && response.ok) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, json: undefined, text: '', bytes };
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}: ${text.slice(0, 400)}`);
  }
  return { status: response.status, json, text };
}
