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
 *   POST /events     — deliver an external event to a suspended Wait-for-Event
 *                      node: { correlationKey, payload? } → { ok, delivered }.
 *                      This is the webhook target for e-sign callbacks etc.
 *   POST /approvals  — resolve a pending approval: { nodeId, approved }
 *   GET  /status     — { name, hasWorkflow, running, savedAt, pendingWaits }
 *   GET  /runs       — run history: { runs: RunRecordSummary[], activeRunId }
 *   GET  /runs/{id}  — one full RunRecord (summary + graph + event log)
 *   WS   connect     — receive RunEvents; send control frames:
 *                      { type: 'approval', nodeId, approved }
 *                      { type: 'event', correlationKey, payload? }
 *                      { type: 'trigger', input }
 *                      { type: 'stop' }
 *
 * Auth: when a PHORMA_TOKEN secret is set, HTTP requests need
 * `Authorization: Bearer <token>` and WebSocket connects need `?token=`.
 */

import { Agent, type Connection, type ConnectionContext } from 'agents';

import { verifyBearer, verifyRequest, isHosted, type AuthContext } from './auth';
import {
  OPENROUTER_SLUG_PREFIX,
  TenantStore,
  tierLimits,
  type TenantEnv,
  type TenantRecord,
} from './tenants';

import {
  FetchModelClient,
  HttpMcpClient,
  buildHttpToolRequest,
  httpToolDefinition,
  performWebSearch,
  sanitizeToolName,
  startRun,
  webSearchToolDefinition,
  createRunRecorder,
  type JournalEntry,
  type ModelProviderId,
  type ResolvedTool,
  type RunEvent,
  type RunHandle,
  type RunJournal,
  type RunLogEvent,
  type RunRecord,
  type RunRecorder,
  type RunRecordSummary,
  type RunSource,
  type ToolHost,
  type WorkflowNode,
  type WorkflowSpec,
} from '@phorma/engine';

export interface Env extends TenantEnv {
  WorkflowAgent: DurableObjectNamespace;
  /** R2 bucket holding installer artifacts and update manifests. */
  RELEASES?: R2Bucket;
  /**
   * Runtime mode. 'hosted' = Phorma Labs multi-tenant deployment (fail-closed
   * Clerk auth, tenant ownership enforcement). Unset/anything else = BYO
   * single-tenant mode (today's behavior).
   */
  PHORMA_MODE?: string;
  /** Comma-separated origins allowed for CORS in hosted mode. */
  ALLOWED_ORIGINS?: string;
  /** Shared bearer token protecting triggers + monitoring (BYO mode only). */
  PHORMA_TOKEN?: string;
  /** Clerk secret key — when set, the studio authenticates with Clerk session JWTs. */
  CLERK_SECRET_KEY?: string;
  /**
   * Clerk instance public key (PEM) for offline JWT verification — avoids a
   * remote JWKS fetch on DO cold starts. Recommended in hosted mode.
   */
  CLERK_JWT_KEY?: string;
  /** Comma-separated origins allowed as JWT azp (token replay protection). */
  CLERK_AUTHORIZED_PARTIES?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Amazon Bedrock API key (bearer token) for BYO-key runs. */
  BEDROCK_API_KEY?: string;
  /** Default AWS region for Amazon Bedrock agents that don't set their own. */
  BEDROCK_REGION?: string;
  /** Remote Ollama/OpenAI-compatible server, if you host one. */
  OLLAMA_BASE_URL?: string;
}

/** Cumulative usage for one run (summed across node-usage events). */
interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface WorkflowAgentState {
  spec: WorkflowSpec | null;
  savedAt: string | null;
  /** Id of the most recent run (running or finished). */
  lastRunId: string | null;
  /** Clerk userId that owns this instance (stamped on first push, hosted mode). */
  ownerId?: string | null;
  /** Usage of the most recently completed run. */
  lastRunUsage?: RunUsage | null;
  /** Month key (YYYY-MM) the running totals below apply to. */
  usageMonth?: string | null;
  /** Month-to-date usage across runs (quota display; ledger comes later). */
  monthUsage?: RunUsage | null;
  /**
   * The in-flight run, persisted so a Durable Object eviction (hibernation,
   * deploy, crash) can resume it on the next wake. Cleared when the run
   * settles. Resume replays journaled node results (no repeated side
   * effects) until execution reaches the first unfinished node.
   */
  activeRun?: { runId: string; input: string; startedAt: number } | null;
}

/** The identity attached to an authorized request. */
// AuthContext now lives in ./auth (shared with the gateway + API routes).

/** Control frames the studio may send over the WebSocket. */
type ControlFrame =
  | { type: 'approval'; nodeId: string; approved: boolean }
  | { type: 'event'; correlationKey: string; payload?: string }
  | { type: 'trigger'; input?: string }
  | { type: 'stop' };

const PROVIDER_ENV_KEYS: Record<ModelProviderId, keyof Env | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  bedrock: 'BEDROCK_API_KEY',
  ollama: null,
  // Phorma Cloud never resolves a key from env — the tenant runtime key is
  // injected by the hosted inference path (DO trigger or /api/infer proxy).
  'phorma-cloud': null,
};

/**
 * Hosted inference is OpenRouter-only: whatever provider a node declares is
 * mapped to the equivalent OpenRouter model slug and billed against the
 * tenant's provisioned (credit-limited) runtime key. `OPENROUTER_SLUG_PREFIX`
 * is shared with the /api/infer proxy (see tenants.ts).
 */

export class WorkflowAgent extends Agent<Env, WorkflowAgentState> {
  override initialState: WorkflowAgentState = {
    spec: null,
    savedAt: null,
    lastRunId: null,
    ownerId: null,
    lastRunUsage: null,
    usageMonth: null,
    monthUsage: null,
  };

  /** Called on every DO wake (cold start). Resumes an interrupted run. */
  override async onStart(): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS run_journal (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (run_id, key)
      )
    `;
    // Run history (EPIC 1): a summary row per run plus its coalesced event
    // log, written when the run settles. Lives in the DO's embedded SQLite so
    // history works identically in hosted AND BYO deployments (no D1 needed).
    this.sql`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT,
        summary TEXT NOT NULL,
        graph TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `;
    const active = this.state.activeRun;
    if (active && !this.handle) {
      // The previous instance died mid-run (eviction). Restart the run with
      // its journal: completed nodes replay instantly, suspended waits and
      // approvals re-register, and execution continues from where it stopped.
      await this.trigger(active.input, active.runId);
    }
  }

  private handle: RunHandle | null = null;
  private runCounter = 0;
  /** Pending approval resolvers, keyed by node id. */
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  /**
   * Suspended Wait-for-Event resolvers, keyed by correlation key. The run
   * itself survives eviction via the journal + activeRun resume path; these
   * resolvers re-register when the resumed run reaches the wait again.
   * Events arriving with no waiter are buffered briefly so webhook races
   * don't drop deliveries.
   */
  private readonly waits = new Map<
    string,
    { resolve: (payload: string) => void; reject: (error: Error) => void }
  >();
  /** Events that arrived before their waiter registered (key → payload). */
  private readonly earlyEvents = new Map<string, string>();
  /** Ring buffer of this run's events, replayed to late-joining monitors. */
  private eventLog: RunEvent[] = [];
  /** Run-history recorder for the in-flight run (EPIC 1). */
  private recorder: RunRecorder | null = null;

  /** How many finished runs each workflow keeps; oldest are pruned. */
  private static readonly RUN_HISTORY_LIMIT = 50;

  // ── HTTP ───────────────────────────────────────────────────────────────────

  override async onRequest(request: Request): Promise<Response> {
    const auth = await this.authorized(request);
    if (!auth) {
      return json({ error: 'Unauthorized.' }, 401);
    }
    const denied = this.enforceOwnership(auth);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    if (request.method === 'POST' && path.endsWith('/workflow')) {
      const spec = (await request.json()) as WorkflowSpec;
      if (!spec || spec.version !== 1 || !Array.isArray(spec.graph?.nodes)) {
        return json({ error: 'Body must be a version-1 WorkflowSpec.' }, 400);
      }
      // Re-arm the schedule-trigger cron (if any) for the new spec.
      await this.rescheduleCron(spec);
      this.setState({
        ...this.state,
        spec,
        savedAt: new Date().toISOString(),
        // Hosted mode: first push stamps ownership; later pushes keep it.
        ownerId: this.state.ownerId ?? auth.userId,
      });
      return json({ ok: true, name: spec.name });
    }

    if (request.method === 'POST' && path.endsWith('/trigger')) {
      const body = (await request.json().catch(() => ({}))) as { input?: string };
      const result = await this.trigger(body.input ?? '');
      return json(result, result.ok ? 200 : (result.status ?? 409));
    }

    if (request.method === 'POST' && path.endsWith('/events')) {
      const body = (await request.json().catch(() => ({}))) as {
        correlationKey?: string;
        payload?: unknown;
      };
      const key = body.correlationKey?.trim();
      if (!key) return json({ error: 'correlationKey is required.' }, 400);
      const payload =
        typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload ?? '');
      const delivered = this.deliverEvent(key, payload);
      return json({ ok: true, delivered });
    }

    if (request.method === 'POST' && path.endsWith('/approvals')) {
      const body = (await request.json().catch(() => ({}))) as {
        nodeId?: string;
        approved?: boolean;
      };
      if (!body.nodeId) return json({ error: 'nodeId is required.' }, 400);
      const resolve = this.approvals.get(body.nodeId);
      if (!resolve) return json({ ok: true, delivered: false });
      this.approvals.delete(body.nodeId);
      resolve(body.approved === true);
      return json({ ok: true, delivered: true });
    }

    {
      // GET /runs/{runId} — one full RunRecord.
      const match = request.method === 'GET' ? /\/runs\/([^/]+)$/.exec(path) : null;
      if (match) {
        const record = this.loadRunRecord(decodeURIComponent(match[1]));
        if (!record) return json({ error: 'Run not found.' }, 404);
        return json(record);
      }
    }

    if (request.method === 'GET' && path.endsWith('/runs')) {
      return json({
        runs: this.listRunSummaries(),
        activeRunId: this.handle ? (this.state.activeRun?.runId ?? null) : null,
      });
    }

    if (request.method === 'GET' && path.endsWith('/status')) {
      return json({
        name: this.state.spec?.name ?? null,
        hasWorkflow: this.state.spec !== null,
        running: this.handle !== null,
        savedAt: this.state.savedAt,
        lastRunId: this.state.lastRunId,
        lastRunUsage: this.state.lastRunUsage ?? null,
        monthUsage: this.currentMonthUsage(),
        /** Correlation keys the current run is suspended on. */
        pendingWaits: [...this.waits.keys()],
      });
    }

    return json({ error: 'Not found.' }, 404);
  }

  // ── WebSocket monitor ──────────────────────────────────────────────────────

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get('token');
    const auth = await this.verifyToken(token);
    if (!auth || this.enforceOwnership(auth)) {
      connection.close(4001, 'Unauthorized.');
      return;
    }
    // Replay the current run's events so a late-joining monitor catches up.
    for (const event of this.eventLog) {
      connection.send(JSON.stringify(event));
    }
    // Sentinel so the studio can tell replayed history from live events.
    connection.send(
      JSON.stringify({
        type: 'monitor-synced',
        runId: this.state.activeRun?.runId ?? this.state.lastRunId ?? null,
        at: Date.now(),
      }),
    );
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
      case 'event':
        if (frame.correlationKey?.trim()) {
          this.deliverEvent(frame.correlationKey.trim(), frame.payload ?? '');
        }
        break;
      case 'trigger':
        void this.trigger(frame.input ?? '').then(result => {
          // Surface quota/config rejections to connected monitors — there is
          // no HTTP response channel for socket-initiated runs.
          if (!result.ok && result.error) {
            this.relay({
              type: 'run-failed',
              runId: 'pending',
              error: result.error,
              at: Date.now(),
            });
          }
        });
        break;
      case 'stop':
        this.handle?.stop();
        // A run suspended on an approval or external event is awaiting a
        // host promise, not the gate — unblock those so the run can unwind
        // (RunStoppedError is thrown at the next gate check).
        for (const resolve of this.approvals.values()) resolve(false);
        this.approvals.clear();
        for (const waiter of this.waits.values()) waiter.resolve('');
        this.waits.clear();
        break;
    }
  }

  // ── Scheduled (cron) runs ──────────────────────────────────────────────────

  /** Callback target for `this.schedule(cron, 'scheduledRun')`. */
  async scheduledRun(): Promise<void> {
    await this.trigger('', undefined, 'schedule');
  }

  /**
   * Callback target for wait-timeout alarms (`this.schedule(seconds,
   * 'waitTimedOut', correlationKey)`). Durable: fires even if the DO was
   * evicted and the run resumed in between. A stale alarm (event already
   * delivered, or run gone) is a no-op.
   */
  async waitTimedOut(correlationKey: string): Promise<void> {
    const waiter = this.waits.get(correlationKey);
    if (!waiter) return;
    this.waits.delete(correlationKey);
    waiter.reject(
      new Error(`Timed out waiting for external event "${correlationKey}".`),
    );
  }

  private async rescheduleCron(spec: WorkflowSpec): Promise<void> {
    // Drop existing cron schedules, then arm one per schedule-trigger node.
    for (const schedule of this.getSchedules()) {
      await this.cancelSchedule(schedule.id);
    }
    // Hosted mode: cap active schedules by tier so background cron runs
    // can't burn quota 24/7.
    let scheduleBudget = Number.POSITIVE_INFINITY;
    if (this.hosted && this.state.ownerId) {
      const tenant = await new TenantStore(this.env).getTenant(this.state.ownerId);
      scheduleBudget = tierLimits(tenant?.tier ?? 'starter').schedulesPerWorkflow;
    }
    for (const node of spec.graph.nodes) {
      if (node.kind !== 'schedule-trigger') continue;
      if (scheduleBudget <= 0) break;
      const cron = (node.data as { cron?: string }).cron;
      if (cron?.trim()) {
        await this.schedule(cron.trim(), 'scheduledRun', undefined);
        scheduleBudget -= 1;
      }
    }
  }

  // ── Run execution ────────────────────────────────────────────────────────────

  private async trigger(
    input: string,
    resumeRunId?: string,
    source: RunSource = 'manual',
  ): Promise<{ ok: boolean; runId?: string; error?: string; status?: number }> {
    const spec = this.state.spec;
    if (!spec) return { ok: false, error: 'No workflow uploaded yet.', status: 409 };
    if (this.handle) return { ok: false, error: 'A run is already in progress.', status: 409 };

    // Hosted mode: resolve the tenant, gate on subscription + quota, and
    // resolve the credit-limited OpenRouter runtime key.
    let tenant: TenantRecord | null = null;
    let tenantKey: string | null = null;
    const store = new TenantStore(this.env);
    if (this.hosted) {
      const ownerId = this.state.ownerId;
      if (!ownerId) return { ok: false, error: 'Workflow has no owner. Push it again.', status: 409 };
      tenant = await store.getTenant(ownerId);
      if (!tenant || tenant.status !== 'active') {
        return {
          ok: false,
          error: 'No active Phorma Cloud subscription. Visit Settings → Cloud to subscribe.',
          status: 402,
        };
      }
      const quota = await store.getQuota(tenant.id, tenant.tier);
      if (quota.runsUsed >= quota.limits.monthlyRuns) {
        return {
          ok: false,
          error: `Monthly run limit reached (${quota.limits.monthlyRuns}). Resets next month or upgrade your plan.`,
          status: 429,
        };
      }
      if (quota.costUsdUsed >= quota.limits.monthlyCostUsd) {
        return {
          ok: false,
          error: 'Monthly credits exhausted. Resets next month or upgrade your plan.',
          status: 402,
        };
      }
      tenantKey = await store.runtimeKey(tenant);
      if (!tenantKey) {
        return {
          ok: false,
          error: 'Your Phorma Cloud account has no runtime key yet. Contact support.',
          status: 402,
        };
      }
    }

    this.runCounter += 1;
    const resuming = !!resumeRunId;
    const runId = resumeRunId ?? `cloudrun-${Date.now().toString(36)}-${this.runCounter}`;
    this.eventLog = [];
    const startedAt = resuming ? (this.state.activeRun?.startedAt ?? Date.now()) : Date.now();

    // Run-history recorder (EPIC 1). A resumed run keeps its original source
    // (its summary row already exists); the journal replay re-emits earlier
    // events, rebuilding the recorder's log from scratch — so drop any rows
    // persisted for this run before the eviction.
    const recordedSource = resuming ? (this.recordedSource(runId) ?? 'resume') : source;
    const recorder = createRunRecorder({
      runId,
      workflowId: spec.id ?? null,
      workflowName: spec.name,
      source: recordedSource,
      environment: 'cloud',
      // Snapshot the spec graph as the user authored it (hosted provider
      // mapping is an execution detail, not what "Bring to Canvas" shows).
      graph: structuredClone(spec.graph),
    });
    const recordGraphJson = JSON.stringify(spec.graph);
    this.recorder = recorder;
    if (resuming) {
      this.sql`DELETE FROM run_events WHERE run_id = ${runId}`;
    }

    // Durable replay journal: completed node results live in the DO's
    // embedded SQLite. A resumed run replays them instantly (no model/tool
    // side effects); a fresh run starts with an empty journal.
    if (!resuming) {
      this.sql`DELETE FROM run_journal WHERE run_id != ${runId}`;
    }
    const journalCache = new Map<string, JournalEntry>();
    for (const row of this.sql<{ key: string; entry: string }>`
      SELECT key, entry FROM run_journal WHERE run_id = ${runId}
    `) {
      try {
        journalCache.set(row.key, JSON.parse(row.entry) as JournalEntry);
      } catch {
        // Corrupt row — ignore; the node simply re-executes.
      }
    }
    const journal: RunJournal = {
      lookup: key => journalCache.get(key),
      record: (key, entry) => {
        journalCache.set(key, entry);
        this.sql`
          INSERT OR REPLACE INTO run_journal (run_id, key, entry)
          VALUES (${runId}, ${key}, ${JSON.stringify(entry)})
        `;
      },
    };

    // Per-run usage accumulator — summed from node-usage events as they are
    // relayed, persisted ONCE when the run settles (never from event replay).
    const runUsage: RunUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    // Hosted: everything runs through OpenRouter on the tenant's key.
    // BYO: provider keys come from the worker's env secrets, as always.
    const graph = this.hosted ? this.mapGraphToOpenRouter(spec.graph) : spec.graph;
    if (typeof graph === 'string') return { ok: false, error: graph, status: 422 };

    const model = new FetchModelClient(async provider => {
      if (this.hosted) return tenantKey;
      const envKey = PROVIDER_ENV_KEYS[provider];
      return envKey ? ((this.env[envKey] as string | undefined) ?? null) : null;
    });

    const handle = startRun({
      runId,
      graph,
      input,
      source: recordedSource,
      // Batch workflows (ForEach) legitimately execute far more nodes than
      // the default anti-runaway budget allows.
      maxExecutions: graph.nodes.some(node => node.kind === 'for-each') ? 2000 : undefined,
      journal,
      model,
      tools: new CloudToolHost({
        restrictEgress: this.hosted,
        // Remote MCP bearer tokens come from worker secrets named
        // `MCP_<AUTHKEY>` (e.g. authKey `GITHUB_TOKEN` -> secret MCP_GITHUB_TOKEN).
        resolveBearer: authKey => {
          const value = this.env[`MCP_${authKey}` as keyof Env];
          return typeof value === 'string' && value.trim() ? value : null;
        },
      }),
      ollamaBaseUrl: this.env.OLLAMA_BASE_URL,
      bedrockRegion: this.env.BEDROCK_REGION,
      emit: event => {
        if (event.type === 'node-usage') {
          runUsage.inputTokens += event.usage.inputTokens ?? 0;
          runUsage.outputTokens += event.usage.outputTokens ?? 0;
          runUsage.costUsd += event.usage.costUsd ?? 0;
        }
        recorder.record(event);
        // Crash tolerance: refresh the summary row at node boundaries so an
        // evicted-and-never-resumed run still shows up (as 'running') in
        // history. Event rows are flushed once, when the run settles.
        if (
          event.type === 'run-started' ||
          event.type === 'node-completed' ||
          event.type === 'node-failed'
        ) {
          this.persistRunSummary(recorder.summary(), recordGraphJson);
        }
        this.relay(event);
      },
      requestApproval: (nodeId) =>
        new Promise<boolean>(resolve => {
          this.approvals.set(nodeId, resolve);
        }),
      waitForEvent: (_nodeId, correlationKey, _message, _payload, timeoutMs) =>
        new Promise<string>((resolve, reject) => {
          // An event may have raced ahead of the waiter (webhook fired while
          // the previous node was still streaming) — consume it immediately.
          const early = this.earlyEvents.get(correlationKey);
          if (early !== undefined) {
            this.earlyEvents.delete(correlationKey);
            resolve(early);
            return;
          }
          this.waits.set(correlationKey, { resolve, reject });
          // Durable timeout: an Agents-SDK alarm survives eviction, so a
          // multi-day expiry fires even across DO restarts. The clock
          // restarts when a resumed run re-registers this wait.
          if (timeoutMs && timeoutMs > 0) {
            void this.schedule(Math.ceil(timeoutMs / 1000), 'waitTimedOut', correlationKey);
          }
        }),
    });

    this.handle = handle;
    this.setState({
      ...this.state,
      lastRunId: runId,
      // Persisted so an eviction mid-run (e.g. suspended on a wait) resumes
      // on the next wake. Cleared when the run settles.
      activeRun: { runId, input, startedAt },
    });
    void handle.done.finally(() => {
      if (this.handle === handle) this.handle = null;
      // Reject anything still waiting so promises don't dangle.
      for (const resolve of this.approvals.values()) resolve(false);
      this.approvals.clear();
      for (const waiter of this.waits.values()) waiter.resolve('');
      this.waits.clear();
      this.earlyEvents.clear();
      // The run settled — drop the resume marker and its journal rows.
      this.setState({ ...this.state, activeRun: null });
      this.sql`DELETE FROM run_journal WHERE run_id = ${runId}`;
      this.recordRunUsage(runUsage);
      // Run history: finalize the summary, flush the coalesced event log,
      // and prune beyond the retention limit.
      const record = recorder.snapshot();
      this.persistRunSummary(record.summary, recordGraphJson);
      this.persistRunEvents(runId, record.events);
      this.pruneRunHistory();
      if (this.recorder === recorder) this.recorder = null;
      // Hosted: authoritative per-run ledger row + quota rollup in D1.
      // A RESUMED run only ledgers the incremental usage of the re-execution
      // (replayed nodes make no model calls) and must not bump the monthly
      // run count a second time.
      if (this.hosted && tenant) {
        void store
          .recordRun({
            tenantId: tenant.id,
            runId,
            workflowId: spec.id ?? 'default',
            costUsd: runUsage.costUsd,
            tokensIn: runUsage.inputTokens,
            tokensOut: runUsage.outputTokens,
            durationMs: Date.now() - startedAt,
            countsAsRun: !resuming,
          })
          .catch(() => undefined); // ledger failure must never break a run
      }
    });

    return { ok: true, runId };
  }

  /**
   * Rewrites every agent node's provider/model to the OpenRouter equivalent
   * (hosted inference is OpenRouter-only). Returns an error string when a
   * node cannot be mapped (Ollama).
   */
  private mapGraphToOpenRouter(graph: WorkflowSpec['graph']): WorkflowSpec['graph'] | string {
    const mapped = structuredClone(graph);
    for (const node of mapped.nodes) {
      const data = node.data as { provider?: ModelProviderId; model?: string };
      if (!data.provider || !data.model) continue;
      const prefix = OPENROUTER_SLUG_PREFIX[data.provider];
      if (prefix === null) {
        return `Agent "${node.name}" uses ${data.provider}, which is not available on Phorma Cloud. Pick a cloud model.`;
      }
      // openrouter + phorma-cloud already carry a full OpenRouter slug.
      if (data.provider !== 'openrouter' && data.provider !== 'phorma-cloud') {
        data.model = `${prefix}${data.model}`;
      }
      data.provider = 'openrouter';
    }
    return mapped;
  }

  // ── Run history (EPIC 1) ───────────────────────────────────────────────────

  /** Upserts a run's summary row (called at node boundaries + settle). */
  private persistRunSummary(summary: RunRecordSummary, graph: string): void {
    this.sql`
      INSERT OR REPLACE INTO runs (run_id, workflow_id, summary, graph, started_at, status)
      VALUES (
        ${summary.id},
        ${summary.workflowId},
        ${JSON.stringify(summary)},
        ${graph},
        ${summary.startedAt},
        ${summary.status}
      )
    `;
  }

  /** Replaces a run's stored event log with the recorder's coalesced log. */
  private persistRunEvents(runId: string, events: RunLogEvent[]): void {
    this.sql`DELETE FROM run_events WHERE run_id = ${runId}`;
    for (let seq = 0; seq < events.length; seq++) {
      this.sql`
        INSERT OR REPLACE INTO run_events (run_id, seq, event)
        VALUES (${runId}, ${seq}, ${JSON.stringify(events[seq])})
      `;
    }
  }

  /** Drops runs (and their events) beyond the retention limit, oldest first. */
  private pruneRunHistory(): void {
    const doomed = [
      ...this.sql<{ run_id: string }>`
        SELECT run_id FROM runs
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ${WorkflowAgent.RUN_HISTORY_LIMIT}
      `,
    ];
    for (const row of doomed) {
      this.sql`DELETE FROM run_events WHERE run_id = ${row.run_id}`;
      this.sql`DELETE FROM runs WHERE run_id = ${row.run_id}`;
    }
  }

  /** All stored run summaries, newest first. */
  private listRunSummaries(): RunRecordSummary[] {
    const summaries: RunRecordSummary[] = [];
    for (const row of this.sql<{ summary: string }>`
      SELECT summary FROM runs ORDER BY started_at DESC
    `) {
      try {
        summaries.push(JSON.parse(row.summary) as RunRecordSummary);
      } catch {
        // Corrupt row — skip.
      }
    }
    return summaries;
  }

  /** Loads one full RunRecord (summary + graph snapshot + event log). */
  private loadRunRecord(runId: string): RunRecord | null {
    const rows = [
      ...this.sql<{ summary: string; graph: string }>`
        SELECT summary, graph FROM runs WHERE run_id = ${runId}
      `,
    ];
    if (rows.length === 0) return null;
    try {
      const summary = JSON.parse(rows[0].summary) as RunRecordSummary;
      const graph = JSON.parse(rows[0].graph) as WorkflowSpec['graph'];
      const events: RunLogEvent[] = [];
      for (const row of this.sql<{ event: string }>`
        SELECT event FROM run_events WHERE run_id = ${runId} ORDER BY seq ASC
      `) {
        events.push(JSON.parse(row.event) as RunLogEvent);
      }
      return { summary, graph, events };
    } catch {
      return null;
    }
  }

  /** The source recorded for a run's existing summary row (resume path). */
  private recordedSource(runId: string): RunSource | null {
    for (const row of this.sql<{ summary: string }>`
      SELECT summary FROM runs WHERE run_id = ${runId}
    `) {
      try {
        return (JSON.parse(row.summary) as RunRecordSummary).source;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Persists a settled run's usage into the instance's monthly rollup. */
  private recordRunUsage(usage: RunUsage): void {
    const month = new Date().toISOString().slice(0, 7);
    const current = this.currentMonthUsage();
    this.setState({
      ...this.state,
      lastRunUsage: usage,
      usageMonth: month,
      monthUsage: {
        inputTokens: current.inputTokens + usage.inputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        costUsd: current.costUsd + usage.costUsd,
      },
    });
  }

  /**
   * Delivers an external event to a suspended Wait-for-Event node. Returns
   * true when a waiter consumed it; false buffers it for a short race window
   * (an event that beats its waiter is consumed on registration).
   */
  private deliverEvent(correlationKey: string, payload: string): boolean {
    const waiter = this.waits.get(correlationKey);
    if (waiter) {
      this.waits.delete(correlationKey);
      waiter.resolve(payload);
      return true;
    }
    // No waiter yet — keep it for a run that is about to reach the node.
    // Only while a run is active; otherwise the event is dropped.
    if (this.handle) this.earlyEvents.set(correlationKey, payload);
    return false;
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

  /** True when running as Phorma Labs' multi-tenant deployment. */
  private get hosted(): boolean {
    return isHosted(this.env);
  }

  /** Verifies an Authorization header (shared logic in ./auth). */
  private authorized(request: Request): Promise<AuthContext | null> {
    return verifyRequest(this.env, request);
  }

  /** Validates a bearer token (shared logic in ./auth). */
  private verifyToken(token: string | null): Promise<AuthContext | null> {
    return verifyBearer(this.env, token);
  }

  /**
   * Hosted-mode tenant isolation: once an instance is owned, only its owner
   * may touch it. Returns a 403 response when access must be denied, null
   * when allowed. BYO mode never denies (single-tenant).
   */
  private enforceOwnership(auth: AuthContext): Response | null {
    if (!this.hosted) return null;
    const owner = this.state.ownerId;
    if (owner && owner !== auth.userId) {
      return json({ error: 'Forbidden: this workflow belongs to another account.' }, 403);
    }
    return null;
  }

  /** Month-to-date usage, resetting when the calendar month rolls over. */
  private currentMonthUsage(): RunUsage {
    const month = new Date().toISOString().slice(0, 7);
    if (this.state.usageMonth === month && this.state.monthUsage) {
      return this.state.monthUsage;
    }
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
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

/** Hosted egress limits for user-defined tool calls. */
const TOOL_RESPONSE_MAX_BYTES = 256 * 1024;
const TOOL_TIMEOUT_MS = 30_000;

/**
 * SSRF guard for hosted mode: blocks URLs that resolve to private, loopback,
 * link-local, or metadata address space by hostname shape. (Workers cannot
 * resolve DNS ahead of fetch, so this is a best-effort literal check — the
 * platform additionally blocks direct RFC1918 access from Workers.)
 */
function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Blocked tool URL (unparseable): ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked tool URL (protocol ${url.protocol}) — only http/https allowed.`);
  }
  const host = url.hostname.toLowerCase();
  const blockedHosts = ['localhost', 'metadata.google.internal'];
  if (blockedHosts.includes(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`Blocked tool URL (internal host): ${host}`);
  }
  // Literal IPv4 checks: loopback, RFC1918, link-local/metadata, CGNAT.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const blocked =
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    if (blocked) throw new Error(`Blocked tool URL (private address): ${host}`);
  }
  // IPv6 loopback/link-local/unique-local literals.
  if (host.includes(':')) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '::1' || bare.startsWith('fe80') || bare.startsWith('fc') || bare.startsWith('fd')) {
      throw new Error(`Blocked tool URL (private IPv6): ${host}`);
    }
  }
}

/** fetch with a timeout + response size cap (hosted tool egress). */
async function guardedFetchText(
  url: string,
  init: RequestInit,
  restrict: boolean,
): Promise<{ ok: boolean; status: number; text: string }> {
  if (restrict) assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let text = await response.text();
    if (restrict && text.length > TOOL_RESPONSE_MAX_BYTES) {
      text = `${text.slice(0, TOOL_RESPONSE_MAX_BYTES)}\n[truncated: response exceeded 256KB]`;
    }
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tool execution in the worker: HTTP + web search via fetch (workers have no
 * CORS constraints), MCP over streamable HTTP. Stdio MCP servers are a
 * desktop capability — deployed workflows must use remote MCP URLs.
 *
 * With `restrictEgress` (hosted mode), user-controlled URLs are SSRF-guarded
 * and responses are size/time capped.
 */
class CloudToolHost implements ToolHost {
  private readonly mcpClients = new Map<string, HttpMcpClient>();
  private readonly restrictEgress: boolean;
  /** Resolves a remote MCP node's bearer token from worker secrets. */
  private readonly resolveBearer?: (authKey: string) => string | null;

  constructor(options?: {
    restrictEgress?: boolean;
    resolveBearer?: (authKey: string) => string | null;
  }) {
    this.restrictEgress = options?.restrictEgress ?? false;
    this.resolveBearer = options?.resolveBearer;
  }

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
        if (this.restrictEgress) assertPublicHttpUrl(data.url);
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
        try {
          const result = await guardedFetchText(
            request.url,
            { method: request.method, headers: request.headers, body: request.body },
            this.restrictEgress,
          );
          return result.ok ? result.text : `HTTP ${result.status}: ${result.text}`;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      case 'web-search-tool': {
        return performWebSearch(argumentsJson, async (url, headers) => {
          const result = await guardedFetchText(url, { headers: headers ?? {} }, this.restrictEgress);
          return result.text;
        });
      }
      case 'mcp-tool': {
        const data = node.data as { url?: string };
        if (!data.url) return `Error: MCP node "${node.name}" has no server URL.`;
        try {
          if (this.restrictEgress) assertPublicHttpUrl(data.url);
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return this.mcpFor(node, data.url).callTool(nativeName, argumentsJson);
      }
      default:
        return `Error: node kind "${node.kind}" is not a tool.`;
    }
  }

  private mcpFor(node: WorkflowNode, url: string): HttpMcpClient {
    let client = this.mcpClients.get(node.id);
    if (!client) {
      const data = node.data as { authKey?: string };
      const headers: Record<string, string> = {};
      if (data.authKey && this.resolveBearer) {
        const token = this.resolveBearer(data.authKey);
        if (token) headers['Authorization'] = `Bearer ${token}`;
      }
      client = new HttpMcpClient(url, headers);
      this.mcpClients.set(node.id, client);
    }
    return client;
  }
}
