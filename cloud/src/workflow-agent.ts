/**
 * WorkflowAgent — one Durable Object per deployed workflow.
 *
 * Holds the workflow spec in agent state, executes runs with the EXACT same
 * `@phorma/engine` the studio uses locally, and broadcasts every RunEvent to
 * connected WebSocket clients. The studio's cloud monitor feeds those events
 * into the same visualization path as local runs — that is Phorma's
 * local-to-cloud parity.
 *
 * HTTP surface (all under /agents/workflow-agent/{instance}):
 *   POST /workflow   — upload/replace the workflow spec (studio "Push")
 *   POST /trigger    — start a run { input?: string } → { runId }
 *   GET  /status     — { name, hasWorkflow, running, savedAt }
 *   WS   connect     — receive RunEvents; send control frames:
 *                      { type: 'approval', nodeId, approved }
 *                      { type: 'trigger', input }
 *                      { type: 'stop' }
 *
 * Auth: when a PHORMA_TOKEN secret is set, HTTP requests need
 * `Authorization: Bearer <token>` and WebSocket connects need `?token=`.
 */

import { Agent, type Connection, type ConnectionContext } from 'agents';

import {
  FetchModelClient,
  HttpMcpClient,
  buildHttpToolRequest,
  httpToolDefinition,
  performWebSearch,
  sanitizeToolName,
  startRun,
  webSearchToolDefinition,
  type ModelProviderId,
  type ResolvedTool,
  type RunEvent,
  type RunHandle,
  type ToolHost,
  type WorkflowNode,
  type WorkflowSpec,
} from '@phorma/engine';

export interface Env {
  WorkflowAgent: DurableObjectNamespace;
  /** Shared bearer token protecting triggers + monitoring (recommended). */
  PHORMA_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Remote Ollama/OpenAI-compatible server, if you host one. */
  OLLAMA_BASE_URL?: string;
}

interface WorkflowAgentState {
  spec: WorkflowSpec | null;
  savedAt: string | null;
  /** Id of the most recent run (running or finished). */
  lastRunId: string | null;
}

/** Control frames the studio may send over the WebSocket. */
type ControlFrame =
  | { type: 'approval'; nodeId: string; approved: boolean }
  | { type: 'trigger'; input?: string }
  | { type: 'stop' };

const PROVIDER_ENV_KEYS: Record<ModelProviderId, keyof Env | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null,
};

export class WorkflowAgent extends Agent<Env, WorkflowAgentState> {
  override initialState: WorkflowAgentState = { spec: null, savedAt: null, lastRunId: null };

  private handle: RunHandle | null = null;
  private runCounter = 0;
  /** Pending approval resolvers, keyed by node id. */
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  /** Ring buffer of this run's events, replayed to late-joining monitors. */
  private eventLog: RunEvent[] = [];

  // ── HTTP ───────────────────────────────────────────────────────────────────

  override async onRequest(request: Request): Promise<Response> {
    if (!this.authorized(request)) {
      return json({ error: 'Unauthorized.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    if (request.method === 'POST' && path.endsWith('/workflow')) {
      const spec = (await request.json()) as WorkflowSpec;
      if (!spec || spec.version !== 1 || !Array.isArray(spec.graph?.nodes)) {
        return json({ error: 'Body must be a version-1 WorkflowSpec.' }, 400);
      }
      // Re-arm the schedule-trigger cron (if any) for the new spec.
      await this.rescheduleCron(spec);
      this.setState({ ...this.state, spec, savedAt: new Date().toISOString() });
      return json({ ok: true, name: spec.name });
    }

    if (request.method === 'POST' && path.endsWith('/trigger')) {
      const body = (await request.json().catch(() => ({}))) as { input?: string };
      const result = this.trigger(body.input ?? '');
      return json(result, result.ok ? 200 : 409);
    }

    if (request.method === 'GET' && path.endsWith('/status')) {
      return json({
        name: this.state.spec?.name ?? null,
        hasWorkflow: this.state.spec !== null,
        running: this.handle !== null,
        savedAt: this.state.savedAt,
        lastRunId: this.state.lastRunId,
      });
    }

    return json({ error: 'Not found.' }, 404);
  }

  // ── WebSocket monitor ──────────────────────────────────────────────────────

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const token = this.env.PHORMA_TOKEN;
    if (token && url.searchParams.get('token') !== token) {
      connection.close(4001, 'Unauthorized.');
      return;
    }
    // Replay the current run's events so a late-joining monitor catches up.
    for (const event of this.eventLog) {
      connection.send(JSON.stringify(event));
    }
  }

  override async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let frame: ControlFrame;
    try {
      frame = JSON.parse(message) as ControlFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'approval': {
        const resolve = this.approvals.get(frame.nodeId);
        if (resolve) {
          this.approvals.delete(frame.nodeId);
          resolve(frame.approved);
        }
        break;
      }
      case 'trigger':
        this.trigger(frame.input ?? '');
        break;
      case 'stop':
        this.handle?.stop();
        break;
    }
  }

  // ── Scheduled (cron) runs ──────────────────────────────────────────────────

  /** Callback target for `this.schedule(cron, 'scheduledRun')`. */
  async scheduledRun(): Promise<void> {
    this.trigger('');
  }

  private async rescheduleCron(spec: WorkflowSpec): Promise<void> {
    // Drop existing cron schedules, then arm one per schedule-trigger node.
    for (const schedule of this.getSchedules()) {
      await this.cancelSchedule(schedule.id);
    }
    for (const node of spec.graph.nodes) {
      if (node.kind !== 'schedule-trigger') continue;
      const cron = (node.data as { cron?: string }).cron;
      if (cron?.trim()) {
        await this.schedule(cron.trim(), 'scheduledRun', undefined);
      }
    }
  }

  // ── Run execution ──────────────────────────────────────────────────────────

  private trigger(input: string): { ok: boolean; runId?: string; error?: string } {
    const spec = this.state.spec;
    if (!spec) return { ok: false, error: 'No workflow uploaded yet.' };
    if (this.handle) return { ok: false, error: 'A run is already in progress.' };

    this.runCounter += 1;
    const runId = `cloudrun-${Date.now().toString(36)}-${this.runCounter}`;
    this.eventLog = [];

    const model = new FetchModelClient(async provider => {
      const envKey = PROVIDER_ENV_KEYS[provider];
      return envKey ? ((this.env[envKey] as string | undefined) ?? null) : null;
    });

    const handle = startRun({
      runId,
      graph: spec.graph,
      input,
      model,
      tools: new CloudToolHost(),
      ollamaBaseUrl: this.env.OLLAMA_BASE_URL,
      emit: event => this.relay(event),
      requestApproval: (nodeId) =>
        new Promise<boolean>(resolve => {
          this.approvals.set(nodeId, resolve);
        }),
    });

    this.handle = handle;
    this.setState({ ...this.state, lastRunId: runId });
    void handle.done.finally(() => {
      if (this.handle === handle) this.handle = null;
      // Reject anything still waiting so promises don't dangle.
      for (const resolve of this.approvals.values()) resolve(false);
      this.approvals.clear();
    });

    return { ok: true, runId };
  }

  /** Buffers + broadcasts a RunEvent to every connected monitor. */
  private relay(event: RunEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > 1000) this.eventLog = this.eventLog.slice(-1000);
    const payload = JSON.stringify(event);
    for (const connection of this.getConnections()) {
      try {
        connection.send(payload);
      } catch {
        // A dead monitor must never break a run.
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private authorized(request: Request): boolean {
    const token = this.env.PHORMA_TOKEN;
    if (!token) return true; // no token configured — open instance
    const header = request.headers.get('Authorization') ?? '';
    return header === `Bearer ${token}`;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // The studio calls from a Tauri webview / localhost dev server.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

/**
 * Tool execution in the worker: HTTP + web search via fetch (workers have no
 * CORS constraints), MCP over streamable HTTP. Stdio MCP servers are a
 * desktop capability — deployed workflows must use remote MCP URLs.
 */
class CloudToolHost implements ToolHost {
  private readonly mcpClients = new Map<string, HttpMcpClient>();

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
      case 'mcp-tool': {
        const data = node.data as { transport?: string; url?: string };
        if (data.transport === 'stdio') {
          throw new Error(
            `MCP node "${node.name}" uses a local (stdio) server — deployed workflows need a remote MCP URL.`,
          );
        }
        if (!data.url) throw new Error(`MCP node "${node.name}" has no server URL.`);
        const tools = await this.mcpFor(node, data.url).listTools();
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
      default:
        return [];
    }
  }

  async callTool(node: WorkflowNode, nativeName: string, argumentsJson: string): Promise<string> {
    switch (node.kind) {
      case 'http-tool': {
        const request = buildHttpToolRequest(node, argumentsJson);
        if (!request.url) return 'Error: the HTTP tool has no URL configured.';
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        const text = await response.text();
        return response.ok ? text : `HTTP ${response.status}: ${text}`;
      }
      case 'web-search-tool': {
        return performWebSearch(argumentsJson, async url => (await fetch(url)).text());
      }
      case 'mcp-tool': {
        const data = node.data as { url?: string };
        if (!data.url) return `Error: MCP node "${node.name}" has no server URL.`;
        return this.mcpFor(node, data.url).callTool(nativeName, argumentsJson);
      }
      default:
        return `Error: node kind "${node.kind}" is not a tool.`;
    }
  }

  private mcpFor(node: WorkflowNode, url: string): HttpMcpClient {
    let client = this.mcpClients.get(node.id);
    if (!client) {
      client = new HttpMcpClient(url);
      this.mcpClients.set(node.id, client);
    }
    return client;
  }
}
