import { Injectable, inject } from '@angular/core';

import {
  HttpMcpClient,
  applyConnectionAuth,
  buildHttpToolRequest,
  httpToolDefinition,
  performWebSearch,
  sanitizeToolName,
  webSearchToolDefinition,
  withConnectionBaseUrl,
  type ResolvedTool,
  type ToolHost,
  type WorkflowNode,
} from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { McpOAuthService } from './mcp-oauth.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';

/**
 * The studio's {@link ToolHost}: how local runs discover and execute tools.
 *
 * - HTTP + Web Search: desktop routes through the Rust `http_request`
 *   command (no webview CORS); browser preview uses plain fetch.
 * - MCP stdio: Rust-managed sessions (desktop only).
 * - MCP streamable HTTP: the engine's fetch-based client, everywhere.
 */
@Injectable({ providedIn: 'root' })
export class ToolHostService implements ToolHost {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);
  private readonly oauth = inject(McpOAuthService);
  private readonly connections = inject(ConnectionStoreService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge reaches nothing on the run path.
  private readonly telemetry = inject(TelemetryService);

  /** HTTP MCP clients, keyed by tool node id (reused across a run). */
  private readonly httpMcpClients = new Map<string, HttpMcpClient>();

  async listTools(node: WorkflowNode): Promise<Omit<ResolvedTool, 'nodeId'>[]> {
    switch (node.kind) {
      case 'http-tool': {
        const definition = httpToolDefinition(node);
        return [{ definition, nativeName: definition.name }];
      }
      case 'web-search-tool': {
        const definition = webSearchToolDefinition(node);
        return [{ definition, nativeName: definition.name }];
      }
      case 'mcp-tool':
        return this.listMcpTools(node);
      default:
        return [];
    }
  }

  /**
   * Executes one tool call. A throw is counted once here as `tool-call` and
   * rethrown untouched (Requirements 3.1, 3.2, 11.3) - the category is all that
   * is recorded, and `recordError` has no parameter the message or the stack
   * could travel in.
   *
   * A failure this method turns into an `Error: ...` RESULT is deliberately not
   * counted: the model receives it, can recover from it, and the run continues,
   * so it is a tool answer rather than a failed call. An MCP session that cannot
   * be reached from here counts as `tool-call` and not as `mcp`, because
   * `listMcpTools` already owns the connect seam and one failure gets one
   * counter.
   */
  async callTool(node: WorkflowNode, nativeName: string, argumentsJson: string): Promise<string> {
    try {
      return await this.dispatchTool(node, nativeName, argumentsJson);
    } catch (error) {
      this.telemetry.recordError('tool-call');
      throw error;
    }
  }

  private async dispatchTool(
    node: WorkflowNode,
    nativeName: string,
    argumentsJson: string,
  ): Promise<string> {
    switch (node.kind) {
      case 'http-tool': {
        const request = buildHttpToolRequest(node, argumentsJson);
        if (!request.url) return 'Error: the HTTP tool has no URL configured.';
        const connectionId = (node.data as { connectionId?: string }).connectionId;
        let authed = request;
        if (connectionId) {
          try {
            const conn = await this.connections.resolve(connectionId);
            authed = applyConnectionAuth({ ...request, url: withConnectionBaseUrl(request.url, conn) }, conn);
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const response = await this.fetchText(authed.url, authed.method, authed.headers, authed.body);
        return response;
      }
      case 'web-search-tool': {
        const raw = await performWebSearch(argumentsJson, (url, headers) =>
          this.fetchText(url, 'GET', headers ?? {}),
        );
        return raw;
      }
      case 'mcp-tool':
        return this.callMcpTool(node, nativeName, argumentsJson);
      default:
        return `Error: node kind "${node.kind}" is not a tool.`;
    }
  }

  /** Drops cached MCP connections (called when a run starts). */
  async reset(): Promise<void> {
    this.httpMcpClients.clear();
    // Stdio sessions are keyed per node and reconnected lazily; ask Rust to
    // drop them so config changes take effect on the next run.
    if (this.tauri.isDesktop) {
      // Best effort — ids are node-scoped; a stale session is re-created on
      // connect anyway, so there is nothing critical to clean here.
    }
  }

  // ── MCP ────────────────────────────────────────────────────────────────────

  /**
   * The MCP connect path: a stdio session spawned through Rust, or an HTTP
   * session opened by the engine's client, followed by the server's tool list.
   * Every way this can fail - no desktop shell, a missing URL, a missing token,
   * a spawn that dies, a server that refuses - is counted once as `mcp`
   * (Requirements 3.1, 3.2, 11.3). Category only: the error is rethrown
   * untouched and nothing about it is recorded.
   */
  private async listMcpTools(node: WorkflowNode): Promise<Omit<ResolvedTool, 'nodeId'>[]> {
    try {
      return await this.connectMcp(node);
    } catch (error) {
      this.telemetry.recordError('mcp');
      throw error;
    }
  }

  private async connectMcp(node: WorkflowNode): Promise<Omit<ResolvedTool, 'nodeId'>[]> {
    const data = node.data as {
      transport?: 'stdio' | 'sse';
      command?: string;
      args?: string[];
      url?: string;
      envKeys?: string[];
      presetId?: string;
    };

    let tools: { name: string; description?: string; inputSchema?: object }[];
    if (data.transport === 'stdio') {
      if (!this.tauri.isDesktop) {
        throw new Error('Local (stdio) MCP servers need the desktop app. Use a remote URL in browser mode.');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<string>('mcp_connect', {
        serverId: node.id,
        command: data.command ?? '',
        // Unfilled preset argFields leave empty-string positionals behind —
        // passing them verbatim confuses servers (e.g. filesystem treats ''
        // as an allowed directory). Drop them.
        args: (data.args ?? []).filter(arg => arg.trim() !== ''),
        envKeys: data.envKeys ?? [],
        // Rust falls back to preset-scoped app-default secrets when the
        // node-scoped ones are absent (Settings > Integrations).
        presetId: data.presetId ?? null,
      });
      tools = (JSON.parse(raw) as { tools?: typeof tools }).tools ?? [];
    } else {
      if (!data.url) throw new Error(`MCP node "${node.name}" has no server URL.`);
      tools = await (await this.httpMcpFor(node, data.url)).listTools();
    }

    const prefix = sanitizeToolName(node.name);
    return tools.map(tool => ({
      definition: {
        name: `${prefix}_${sanitizeToolName(tool.name)}`.slice(0, 60),
        description: tool.description ?? `${tool.name} (via ${node.name})`,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
      nativeName: tool.name,
    }));
  }

  private async callMcpTool(
    node: WorkflowNode,
    nativeName: string,
    argumentsJson: string,
  ): Promise<string> {
    const data = node.data as { transport?: 'stdio' | 'sse'; url?: string };
    if (data.transport === 'stdio') {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<string>('mcp_call', {
        serverId: node.id,
        name: nativeName,
        argumentsJson,
      });
      const parsed = JSON.parse(raw) as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      };
      const text = (parsed.content ?? [])
        .map(part => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
        .join('\n');
      return parsed.isError ? `Tool error: ${text}` : text || '(empty result)';
    }
    if (!data.url) return `Error: MCP node "${node.name}" has no server URL.`;
    return (await this.httpMcpFor(node, data.url)).callTool(nativeName, argumentsJson);
  }

  private async httpMcpFor(node: WorkflowNode, url: string): Promise<HttpMcpClient> {
    let client = this.httpMcpClients.get(node.id);
    if (!client) {
      const data = node.data as { authMode?: string; authKey?: string; presetId?: string };
      const headers: Record<string, string> = {};
      if (data.authMode === 'oauth') {
        // Interactive OAuth: use the stored (auto-refreshed) access token.
        const token = await this.oauth.validAccessToken(node.id);
        if (!token) {
          throw new Error(
            `"${node.name}" is not connected. Select the node and click Connect to sign in.`,
          );
        }
        headers['Authorization'] = `Bearer ${token}`;
      } else if (data.authKey) {
        // Static bearer / PAT.
        const token = await this.settings.resolveMcpBearer(node.id, data.authKey, data.presetId);
        if (!token) {
          throw new Error(
            `"${node.name}" has no token configured. Select the node and add its credentials, or set an application default in Settings > Integrations.`,
          );
        }
        headers['Authorization'] = `Bearer ${token}`;
      }
      client = new HttpMcpClient(url, headers);
      this.httpMcpClients.set(node.id, client);
    }
    return client;
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────────

  private async fetchText(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<string> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<{ status: number; body: string }>('http_request', {
        url,
        method,
        headers,
        body: body ?? null,
      });
      return response.status >= 400
        ? `HTTP ${response.status}: ${response.body}`
        : response.body;
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    return response.ok ? text : `HTTP ${response.status}: ${text}`;
  }
}
