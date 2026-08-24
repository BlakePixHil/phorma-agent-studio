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
 *   DELETE /workflow - remove the deployed spec (studio "Remove from cloud");
 *                      refused while a run is in progress; run history,
 *                      the usage ledger and connection metadata are kept
 *   DELETE /workflow/purge - full teardown: cancel cron, unpublish the portal,
 *                      delete tracked portal session DOs (via RPC) and empty
 *                      every SQLite table. Studio "Remove from cloud" and the
 *                      library-delete path hit this.
 *   POST /connections — replace the connection metadata inventory (names,
 *                      types, auth modes — never a secret value)
 *   GET  /connections — this worker's connection inventory as
 *                      `ConnectionSummary[]` (name, type, secretsPresent)
 *   POST /trigger    — start a run { input?: string, source?: 'eval' } → { runId }
 *   POST /events     — deliver an external event to a suspended Wait-for-Event
 *                      node: { correlationKey, payload? } → { ok, delivered }.
 *                      This is the webhook target for e-sign callbacks etc.
 *   POST /approvals  — resolve a pending approval: { requestId, approved }
 *   POST /questions  — answer a pending Ask-User node: { requestId, response }
 *   GET  /status     — { name, hasWorkflow, running, savedAt, pendingWaits }
 *   GET  /runs       — run history: { runs: RunRecordSummary[], activeRunId }
 *   GET  /runs/{id}  — one full RunRecord (summary + graph + event log)
 *   GET  /usage      — usage ledger: { usage: UsageLedgerEntry[] } (?since=ms)
 *   WS   connect     — receive RunEvents; send control frames:
 *                      { type: 'approval', requestId, approved }
 *                      { type: 'event', correlationKey, payload? }
 *                      { type: 'question', requestId, response }
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
  decryptString,
  tierLimits,
  type TenantEnv,
  type TenantRecord,
} from './tenants';
import {
  isTerminalPortalEvent,
  toPortalEvent,
  toSseFrame,
  type PortalEvent,
} from './portal-events';
import {
  portalIndex,
  type PortalRegistryEnv,
  type PublishRecord,
} from './portal-registry';
import { mintPortalToken, type PortalTokenRecord } from './portal-auth';
import { WORKER_BUILD } from './build-info';
// The SSRF guard is shared with the data path (`createWorkerDataFetcher`), so
// hosted tool egress and hosted data egress can never drift apart.
import {
  WORKER_HOST_LABEL,
  WorkerSqlHost,
  assertPublicHttpUrl,
  createWorkerDataFetcher,
} from './data-host';
import {
  WorkerConnectionStore,
  connectionMetadataFromPush,
  type WorkerConnectionSecretSource,
} from './connections';
import { secretVault, type SecretVaultEnv } from './secret-vault';
// Decisions about a pushed spec (retention bounds, notification targeting) live
// in one dependency-free module; this file owns the effects they describe.
import {
  NOTIFY_DETAIL_CHARS,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_TIMEOUT_MS,
  dataPathSettings,
  notificationDetail,
  notificationEndpoint,
  notificationTriggerFor,
  notificationWanted,
  resolveRunRetention,
  type NotifyTrigger,
  type RunRetention,
  type WorkflowNotificationPolicy,
} from './run-wiring';
import {
  DurableFixtureStore,
  DurableWorkflowStateStore,
  ensureWorkflowStateTable,
  type DurableSqlExecutor,
} from './workflow-state';

import {
  CLOUDFLARE_CAPABILITIES,
  DEFAULT_MAX_RESPONSE_BYTES,
  FetchModelClient,
  HttpMcpClient,
  applyConnectionAuth,
  buildHttpToolRequest,
  createRedactor,
  httpToolDefinition,
  performWebSearch,
  sanitizeToolName,
  startRun,
  webSearchToolDefinition,
  withConnectionBaseUrl,
  createRunRecorder,
  decodeRunSnapshot,
  encodeRunSnapshot,
  buildPortalInput,
  findPortalTrigger,
  portalPublicConfig,
  resolveResponderNodeId,
  suggestPortalSlug,
  trimPortalHistory,
  validateAgainstCapabilities,
  validatePortal,
  PORTAL_DEFAULT_RATE_LIMIT_PER_MIN,
  type PortalTriggerData,
  type PortalTurn,
  type PortalValidation,
  // Aliased: `Connection` is already the partyserver WebSocket type in here.
  type Connection as DataConnection,
  type DataFetcher,
  type DataRequest,
  type JournalEntry,
  type ModelProviderId,
  type Redactor,
  type ResolvedConnection,
  type ResolvedTool,
  type RunEvent,
  type RunHandle,
  type RunJournal,
  type RunLogEvent,
  type RunRecord,
  type RunRecorder,
  type RunRecordSummary,
  type RunRecordUsage,
  type RunSource,
  type UsageLedgerEntry,
  type ToolHost,
  type WorkflowNode,
  type WorkflowSpec,
} from '@phorma/engine';

export interface Env extends TenantEnv, PortalRegistryEnv, SecretVaultEnv {
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
  /**
   * Comma-separated Clerk user ids allowed to read `/api/admin/telemetry/*`
   * (the Owner_Allowlist). Absent or empty means NO access, never open access —
   * the allowlist is the only key to that surface. Hosted only:
   * `npx wrangler secret put TELEMETRY_ADMIN_USER_IDS --env hosted`.
   */
  TELEMETRY_ADMIN_USER_IDS?: string;
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
  /**
   * Connection secrets (Requirement 3.5). One variable per
   * `Connection.secretKeys` entry, named by the engine's
   * `workerSecretName(connectionId, secretKey)` — always `CONN_` prefixed,
   * always `^[A-Z][A-Z0-9_]*$` — and set through `CloudService.putWorkerSecret`
   * (`wrangler secret put`, value on stdin). `WorkerConnectionStore` is the only
   * reader; nothing else in the worker may touch these.
   */
  [connectionSecret: `CONN_${string}`]: string | undefined;
  /**
   * Bearer tokens for REMOTE (`sse`) MCP nodes: one per `authKey`, named
   * `MCP_<AUTHKEY>` (authKey `RESEND_API_KEY` -> `MCP_RESEND_API_KEY`). Read
   * only by the `resolveBearer` hook handed to `CloudToolHost`.
   *
   * Declared so the lookup is a typed contract rather than a cast. Note these
   * are the ONLY MCP credential a deployed run can resolve: a local (stdio)
   * server cannot be spawned here at all, and an interactive OAuth session is
   * held in the studio's keychain with no path to a worker. That is why the
   * capability record sets `stdioMcp: false` and remote presets meant for
   * deployment authenticate with a static token.
   */
  [mcpBearer: `MCP_${string}`]: string | undefined;
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
  /**
   * Connection METADATA delivered by the dedicated push route (Requirement 3.6):
   * names, types and auth modes, never a secret value. `WorkerConnectionStore`
   * pairs each entry with the `CONN_*` worker secrets at resolve time; a
   * connection that was never pushed simply does not exist on this worker
   * (Requirement 3.11).
   */
  connections?: DataConnection[] | null;
  /**
   * Set ONLY on session instances (`{workflowId}#s{sessionId}`), which serve
   * one visitor conversation on a published portal. Its presence is what makes
   * an instance a portal session: cron is never armed, and the redacted SSE
   * projection reads `responderNodeId` from here.
   */
  portalSession?: PortalSessionState | null;
}

/** Per-visitor conversation state held by a session instance. */
interface PortalSessionState {
  slug: string;
  sessionId: string;
  /** Library workflow id this session serves. */
  workflowId: string;
  /**
   * DO instance name of the owner's workflow, so settled runs can be mirrored
   * back for the Runs/Usage panels. Carried explicitly because `this.name`
   * THROWS on an instance reached by RPC (partyserver only sets it when the
   * request came through `routePartykitRequest`).
   */
  ownerInstance: string;
  /** Node whose tokens the visitor may see; null = final output only. */
  responderNodeId: string | null;
  /** Rolling transcript, capped by the engine's retention helpers. */
  transcript: PortalTurn[];
  createdAt: number;
}

/** The identity attached to an authorized request. */
// AuthContext now lives in ./auth (shared with the gateway + API routes).

/** Control frames the studio may send over the WebSocket. */
type ControlFrame =
  | { type: 'approval'; requestId: string; approved: boolean }
  | { type: 'event'; correlationKey: string; payload?: string }
  | { type: 'question'; requestId: string; response: string }
  | { type: 'trigger'; input?: string }
  | { type: 'stop' };

const PROVIDER_ENV_KEYS: Record<ModelProviderId, keyof Env | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  bedrock: 'BEDROCK_API_KEY',
  ollama: null,
  lmstudio: null,
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
    this.ensureTables();
    const active = this.state.activeRun;
    if (active && !this.handle) {
      // The previous instance died mid-run (eviction). Restart the run with
      // its journal: completed nodes replay instantly, suspended waits and
      // approvals re-register, and execution continues from where it stopped.
      await this.trigger(active.input, active.runId);
    }
  }

  /**
   * Creates this instance's tables. Idempotent and cheap, and deliberately
   * callable from anywhere: an RPC entry point (a portal visitor's turn) can
   * reach `trigger()` before `onStart()` has finished, which previously failed
   * with "no such table: run_journal".
   */
  private ensureTables(): void {
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
    // Usage ledger (EPIC 2): one compact row per settled run, deliberately
    // SEPARATE from the runs table so cost analytics survive run-history
    // pruning. `usage` is the RunRecordSummary.usage JSON (totals + per-node
    // and per-model rollups). Works hosted AND BYO (no D1 needed).
    // Durable workflow state + fixtures (P1-8 / P1-13): one table serving
    // `RunOptions.state` and, under the `fx:` namespace, `RunOptions.fixtures`.
    // Deliberately separate from `runs`/`run_events`, so run-history pruning
    // and the run-retention limits never touch a workflow's state or fixtures.
    ensureWorkflowStateTable(this.stateSql);
    this.sql`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT,
        workflow_name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        usage TEXT NOT NULL
      )
    `;
  }

  /**
   * `this.sql` as a plain value. The state store holds the tagged executor
   * rather than the Agent, which keeps it testable against any SQLite handle.
   */
  private readonly stateSql: DurableSqlExecutor = <T>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] => this.sql<T>(strings, ...values);

  private stateStore: DurableWorkflowStateStore | null = null;
  /** Shared outbound HTTP for data nodes and workflow notifications (18.5). */
  private dataFetcher: DataFetcher | null = null;
  /** Shared SQL host: `postgres` and `mysql` only (18.5). */
  private sqlHost: WorkerSqlHost | null = null;
  /**
   * Invalid retention settings and rejected redaction rules seen on this
   * instance, surfaced on `GET /status` (Requirements 15.13, 15.16).
   */
  private readonly settingsIssues: string[] = [];

  /**
   * `RunOptions.state` for runs in this instance: durable per-workflow state in
   * the DO's `workflow_state` table (Requirements 12.1, 18.5).
   */
  private workflowStateHost(): DurableWorkflowStateStore {
    this.ensureTables();
    this.stateStore ??= new DurableWorkflowStateStore({ sql: this.stateSql });
    return this.stateStore;
  }

  /**
   * `RunOptions.fixtures`: the `fx:` namespace of the same table, scoped to the
   * workflow being run (Requirement 16.10). Not cached, because the instance's
   * spec — and therefore its workflow id — can be replaced by a push.
   */
  private fixtureHost(workflowId: string): DurableFixtureStore {
    return new DurableFixtureStore(this.workflowStateHost(), workflowId);
  }

  /**
   * `RunOptions.dataFetch` for data nodes and for workflow-level notifications
   * (Requirement 18.5). Egress always goes through `assertPublicHttpUrl`, and
   * the response-byte and request-timeout caps live in the fetcher, so no caller
   * can opt out of either.
   */
  private dataFetchHost(): DataFetcher {
    this.dataFetcher ??= createWorkerDataFetcher();
    return this.dataFetcher;
  }

  /**
   * `RunOptions.sql`: `supports` answers true for `postgres` and `mysql` only,
   * so a `mssql`/`sqlite` node fails with a clear message before a statement is
   * submitted (Requirements 18.5, 18.9, 18.10). Driver wire implementations are
   * injected, and none is bound on this worker yet.
   */
  private sqlQueryHost(): WorkerSqlHost {
    this.sqlHost ??= new WorkerSqlHost();
    return this.sqlHost;
  }

  /** Pushed connection metadata as `WorkerConnectionStore` wants it. */
  private connectionMetadata(): Map<string, DataConnection> {
    return connectionMetadataFromPush(this.state.connections ?? []);
  }

  /**
   * `RunOptions.connections`: metadata from the push route paired with the
   * `CONN_*` worker secrets, with OAuth tokens cached in the same
   * `workflow_state` table under `oauth:{connectionId}` (Requirements 3.5-3.7,
   * 3.10, 3.11). Built per run, because a push can replace both the metadata and
   * the workflow id that scopes the token cache.
   *
   * `secretSource` is the second ingestion path (`secret-vault.ts`): env wins,
   * the vault fills the gap for a credential the operator could not set with
   * `wrangler secret put`. `ownerFallback` matters on the FIRST push of a
   * workflow, where the inventory is read before `POST /workflow` has stamped
   * `ownerId` - without it, a hosted tenant's very first deploy would look at
   * the wrong vault and report every secret missing.
   */
  private connectionHost(workflowId: string, ownerFallback?: string | null): WorkerConnectionStore {
    return new WorkerConnectionStore(
      this.env as unknown as Readonly<Record<string, unknown>>,
      this.connectionMetadata(),
      this.workflowStateHost(),
      { workflowId, secretSource: this.vaultSecretSource(ownerFallback) },
    );
  }

  /**
   * Vault-backed fallback for a `CONN_*` name, or undefined when this
   * deployment has no vault (no binding, or no encryption key - both mean
   * there is nothing to read). A decryption failure reads as absent: the
   * caller already turns absence into a named, actionable error, and a
   * half-decrypted credential must never reach an outbound request.
   */
  private vaultSecretSource(ownerFallback?: string | null): WorkerConnectionSecretSource | undefined {
    const encryptionKey = this.env.KEY_ENC_SECRET;
    if (!this.env.SecretVault || !encryptionKey) return undefined;
    const ownerId = this.hosted ? (this.state.ownerId ?? ownerFallback ?? null) : null;
    const vault = secretVault(this.env, ownerId);
    return {
      read: async (name: string) => {
        const enc = await vault.read(name);
        if (!enc) return undefined;
        try {
          return await decryptString(enc, encryptionKey);
        } catch {
          console.error(`[phorma] Could not decrypt the stored secret ${name}.`);
          return undefined;
        }
      },
    };
  }

  /**
   * Records an invalid retention setting or a rejected redaction rule
   * (Requirements 15.13, 15.16). Reported rather than fatal: the run proceeds
   * under the host defaults, and the operator sees the reason in `wrangler tail`
   * and on `GET /status`.
   */
  private reportSettingsIssue(message: string): void {
    if (this.settingsIssues.includes(message)) return;
    this.settingsIssues.push(message);
    if (this.settingsIssues.length > 20) this.settingsIssues.shift();
    console.error(`[phorma] ${message}`);
  }

  /**
   * Effective run-history retention (Requirements 15.12, 15.13).
   *
   * `keepRuns` and `maxAgeDays` override the host default of
   * {@link WorkflowAgent.RUN_HISTORY_LIMIT} only while they are positive
   * integers inside their supported ranges; anything else is ignored, reported,
   * and replaced by the default.
   */
  private runRetention(): RunRetention {
    return resolveRunRetention(
      dataPathSettings(this.state.spec).retention,
      WorkflowAgent.RUN_HISTORY_LIMIT,
      message => this.reportSettingsIssue(`${WORKER_HOST_LABEL}: ${message}`),
    );
  }

  private handle: RunHandle | null = null;
  private runCounter = 0;
  /** Pending approval resolvers, keyed by exact engine request id. */
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  /** Pending Ask-User resolvers, keyed by exact engine request id. */
  private readonly questions = new Map<string, (response: string) => void>();
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
  /**
   * Open portal SSE writers (EPIC 9). Separate from `getConnections()` because
   * these carry the REDACTED projection, never raw RunEvents.
   */
  private readonly portalStreams = new Set<PortalStreamWriter>();
  /** Public events of the current portal run, replayed to a late subscriber. */
  private portalReplay: PortalEvent[] = [];

  /**
   * Host default for how many finished runs each workflow keeps; oldest are
   * pruned. `WorkflowSettings.retention.keepRuns` overrides it while it is a
   * valid setting (Requirements 15.12, 15.13).
   */
  private static readonly RUN_HISTORY_LIMIT = 50;
  /** Usage-ledger retention: rows older than this are pruned at settle. */
  private static readonly USAGE_LEDGER_MAX_AGE_MS = 366 * 24 * 60 * 60 * 1000;
  /** Usage-ledger retention: hard row cap (newest kept). */
  private static readonly USAGE_LEDGER_MAX_ROWS = 5000;

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
      // Deploy-time capability gate (Requirements 17.12, 17.15): the SAME
      // validator and the SAME connection inventory the studio checks at push
      // time (Requirement 17.11, `CloudService.pushWorkflow`), run again here so
      // a direct/older/misbehaving client can never deploy a spec this worker
      // cannot run. An error finding aborts before `setState`/`rescheduleCron`
      // run, so a previously deployed workflow is left completely unchanged.
      // Warning-only findings never block the deployment.
      const connections = await this.connectionHost(spec.id, auth.userId).list();
      const findings = validateAgainstCapabilities(spec, CLOUDFLARE_CAPABILITIES, connections);
      if (findings.some(finding => finding.severity === 'error')) {
        return json({ error: 'Workflow is not deployable to this worker.', findings }, 400);
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

    // Removes the deployed spec (studio "Remove from cloud"). The instance
    // itself, its run history, usage ledger and connection metadata are
    // untouched, so pushing again needs no other setup.
    if (request.method === 'DELETE' && path.endsWith('/workflow')) {
      if (this.handle) {
        return json({ error: 'Stop the running run before removing this workflow.' }, 409);
      }
      await this.cancelScheduledRuns();
      this.setState({ ...this.state, spec: null, savedAt: null });
      return json({ ok: true });
    }

    // Full teardown (studio "Remove from cloud" with `?purge=1`, and the
    // library-delete path). Wipes EVERYTHING this DO owns for the workflow:
    // the spec, cron schedules, portal slug + access keys, tracked portal
    // session DOs, and every SQLite table (run_journal, runs, run_events,
    // usage_ledger, workflow_state incl. fixtures and cached OAuth tokens).
    // Connection secrets in the per-tenant SecretVault are NOT touched (they
    // may be shared across workflows) and D1 usage rows are retained for
    // billing. This is the OWNER instance, so it cascades: `cascade=true` also
    // cancels cron, unpublishes the portal and purges every tracked portal
    // session DO via {@link WorkflowAgent.purgeSelf} (RPC).
    if (request.method === 'DELETE' && path.endsWith('/workflow/purge')) {
      if (this.handle) {
        return json({ error: 'Stop the running run before removing this workflow.' }, 409);
      }
      const { orphanedSessions } = await this.purgeSelf(true);
      return json({ ok: true, purged: true, orphanedSessions });
    }

    // The dedicated connection-metadata push route (Requirement 3.6). Carries
    // NAMES only: `connectionMetadataFromPush` drops anything value-shaped, and
    // the secrets themselves arrive separately as `CONN_*` worker secrets.
    if (request.method === 'POST' && path.endsWith('/connections')) {
      const body = (await request.json().catch(() => ({}))) as unknown;
      const connections = [...connectionMetadataFromPush(body).values()];
      this.setState({ ...this.state, connections });
      return json({ ok: true, connections: connections.map(connection => connection.id) });
    }

    // Read-back of this worker's connection inventory: names, types and how
    // many of each connection's declared secrets are actually set as `CONN_*`
    // worker secrets — never a value. Consulted by `CloudService.pushWorkflow`
    // (Requirement 17.11) to run the Capability_Validator against the SAME
    // inventory `WorkerConnectionStore` will resolve against at run time.
    if (request.method === 'GET' && path.endsWith('/connections')) {
      const workflowId = this.state.spec?.id ?? '';
      const connections = await this.connectionHost(workflowId, auth.userId).list();
      return json({ connections });
    }

    if (request.method === 'POST' && path.endsWith('/trigger')) {
      const body = (await request.json().catch(() => ({}))) as {
        input?: string;
        source?: string;
      };
      // Callers may tag eval-suite case runs and machine webhook calls;
      // everything else stays manual. `portal` is NOT accepted here — portal
      // runs are minted by the public router in a session instance, so
      // honouring it would let a caller forge portal attribution.
      const source: RunSource =
        body.source === 'eval' ? 'eval' : body.source === 'webhook' ? 'webhook' : 'manual';
      const result = await this.trigger(body.input ?? '', undefined, source);
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
        requestId?: string;
        approved?: boolean;
      };
      if (!body.requestId) return json({ error: 'requestId is required.' }, 400);
      const resolve = this.approvals.get(body.requestId);
      if (!resolve) return json({ ok: true, delivered: false });
      this.approvals.delete(body.requestId);
      resolve(body.approved === true);
      return json({ ok: true, delivered: true });
    }

    if (request.method === 'POST' && path.endsWith('/questions')) {
      const body = (await request.json().catch(() => ({}))) as {
        requestId?: string;
        response?: string;
      };
      if (!body.requestId) return json({ error: 'requestId is required.' }, 400);
      const resolve = this.questions.get(body.requestId);
      if (!resolve) return json({ ok: true, delivered: false });
      this.questions.delete(body.requestId);
      resolve(typeof body.response === 'string' ? body.response : '');
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

    // GET /usage?since={epochMs} — per-run usage ledger rows (newest first).
    // Survives run-history pruning; the studio's analytics merge these with
    // its local IndexedDB ledger.
    if (request.method === 'GET' && path.endsWith('/usage')) {
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      return json({ usage: this.listUsageLedger(since) });
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
        /** Connection ids this worker holds metadata for (never a secret). */
        connections: (this.state.connections ?? []).map(connection => connection.id),
        /**
         * Invalid retention settings, rejected redaction rules and undelivered
         * workflow notifications (Requirements 13.7, 15.13, 15.16).
         */
        settingsIssues: [...this.settingsIssues],
      });
    }

    // ── Portal owner routes (EPIC 9) ─────────────────────────────────────────
    // Authenticated (they sit below `authorized` + `enforceOwnership`). The
    // PUBLIC surface lives in portal.ts and never reaches this method.

    if (request.method === 'POST' && path.endsWith('/publish')) {
      // Drain the body even though it is unused: leaving a request stream
      // unread inside a Durable Object throws "Can't read from request stream
      // after response has been sent" and wedges the connection for the
      // caller's NEXT request on the same socket.
      await request.text().catch(() => '');
      return this.publishPortal();
    }

    if (request.method === 'POST' && path.endsWith('/unpublish')) {
      await request.text().catch(() => '');
      const result = await portalIndex(this.env).unpublish(this.workflowKey());
      return json({ ok: true, removed: result.removed });
    }

    if (request.method === 'GET' && path.endsWith('/portal')) {
      const [status, taken] = await Promise.all([
        portalIndex(this.env).statusFor(this.workflowKey()),
        portalIndex(this.env).takenSlugs(this.workflowKey()),
      ]);
      return json({
        record: status.record ? redactPublishRecord(status.record) : null,
        validation: this.validateForPublish(taken),
        // Lets the studio warn a BYO owner that their deployed worker predates
        // the app, i.e. it is missing portal fixes until they pull + deploy.
        workerBuild: WORKER_BUILD,
      });
    }

    if (request.method === 'POST' && path.endsWith('/portal-tokens')) {
      const body = (await request.json().catch(() => ({}))) as { label?: string };
      return this.mintPortalKey(body.label ?? '');
    }

    {
      const match =
        request.method === 'DELETE' ? /\/portal-tokens\/([^/]+)$/.exec(path) : null;
      if (match) {
        await request.text().catch(() => '');
        return this.revokePortalKey(decodeURIComponent(match[1]));
      }
    }

    // Portal runs execute in per-visitor session instances, so their history
    // would be scattered across instances. Sessions mirror a compact summary
    // back here at settle; this is where the studio reads them.
    if (request.method === 'GET' && path.endsWith('/portal-runs')) {
      return json({ runs: this.listPortalRunSummaries() });
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
        const resolve = this.approvals.get(frame.requestId);
        if (resolve) {
          this.approvals.delete(frame.requestId);
          resolve(frame.approved);
        }
        break;
      }
      case 'question': {
        const resolve = this.questions.get(frame.requestId);
        if (resolve) {
          this.questions.delete(frame.requestId);
          resolve(frame.response ?? '');
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
        // A run suspended on an approval, question, or external event is
        // awaiting a host promise, not the gate — unblock those so the run
        // can unwind (RunStoppedError is thrown at the next gate check).
        for (const resolve of this.approvals.values()) resolve(false);
        this.approvals.clear();
        for (const resolve of this.questions.values()) resolve('');
        this.questions.clear();
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

  /**
   * Callback target for workflow-timeout alarms (`this.schedule(seconds,
   * 'workflowTimedOut', runId)`). The engine enforces the deadline itself
   * while the DO is awake; this durable alarm exists to WAKE an evicted DO
   * (e.g. suspended on an approval) — `onStart` resumes the run, and the
   * engine's re-armed deadline (remaining budget ≤ 0) fails it immediately.
   * Stale alarms (run settled or superseded) are no-ops.
   */
  async workflowTimedOut(_runId: string): Promise<void> {
    // Intentionally empty — waking the DO is the entire job.
  }

  /**
   * Cancels every armed CRON schedule without touching in-flight
   * `waitTimedOut` / `workflowTimedOut` alarms - shared by `rescheduleCron`
   * (re-arming for a freshly pushed spec) and DELETE /workflow (removing the
   * deployed spec outright).
   */
  private async cancelScheduledRuns(): Promise<void> {
    for (const schedule of this.getSchedules()) {
      if (schedule.callback === 'scheduledRun') {
        await this.cancelSchedule(schedule.id);
      }
    }
  }

  /**
   * Fully tears down THIS Durable Object instance. Called with `cascade=true`
   * from the `DELETE /workflow/purge` HTTP handler (which always lands on the
   * OWNER instance), and with `cascade=false` via RPC from that owner for each
   * tracked portal session instance - a session owns no portal slug and no
   * cron of its own to cancel.
   *
   * Wipes every SQLite table this DO owns (`run_journal`, `runs`,
   * `run_events`, `usage_ledger`, `workflow_state` incl. fixtures and cached
   * OAuth tokens) plus the agents-SDK housekeeping tables, clears the alarm so
   * nothing is left to wake the instance, and resets state to blank. When
   * `cascade` is true it also cancels cron, unpublishes the portal slug +
   * access keys, and purges every tracked portal session DO via RPC.
   *
   * Connection secrets in the per-tenant SecretVault are NOT touched (they
   * may be shared across workflows) and D1 usage rows are retained for
   * billing. Session purges are best-effort: an evicted or mid-run session
   * logs a warning and does not abort the overall purge. Its registry entry is
   * KEPT so a later purge can retry it, and the count comes back as
   * `orphanedSessions` for the caller to surface.
   */
  async purgeSelf(cascade: boolean): Promise<{ ok: true; orphanedSessions: number }> {
    let orphanedSessions = 0;
    if (cascade) {
      // Owner instance only: cancel cron, drop the portal slug + access
      // keys, then purge every tracked portal session DO via RPC.
      await this.cancelScheduledRuns();
      const index = portalIndex(this.env);
      const workflowId = this.workflowKey();
      await index.unpublish(workflowId);
      // Forget a session only AFTER its DO is actually purged. The registry is
      // the only reference to a session instance that exists anywhere, so
      // dropping the key on a failed purge would orphan that DO permanently -
      // the exact leak this registry was added to prevent.
      const sessions = await index.listSessions(workflowId);
      const purged = await Promise.all(
        sessions.map(async session => ({
          session,
          ok: await this.purgeSessionInstance(session.instanceName),
        })),
      );
      const done = purged.filter(entry => entry.ok).map(entry => entry.session.sessionId);
      orphanedSessions = purged.length - done.length;
      await index.forgetSessions(workflowId, done);
    }
    // Empty every SQLite table this DO owns, its own and the agents-SDK
    // housekeeping ones (whose rows would otherwise outlive the workflow).
    // `workflow_state` keys are workflow-scoped, but this instance IS the
    // workflow (or the session), so a blanket DELETE is correct and cheaper
    // than a scoped one.
    //
    // DELETE, not DROP: this instance stays alive and serving until it is
    // evicted, and both the SDK and this class keep using those tables -
    // `setState` writes `cf_agents_state` right below, and a second purge reads
    // `cf_agents_schedules` through `getSchedules()`. Dropping them made both
    // throw "no such table", so the purge 500'd after doing most of the work and
    // a retry 500'd immediately. Only the rows are the payload; empty tables
    // cost nothing and disappear with the instance.
    //
    // Filtered through `sqlite_master` because these tables are created lazily:
    // `cf_agents_queues` and `cf_agents_mcp_servers` may never have existed, and
    // `DELETE FROM` a missing table throws (the old `DROP TABLE IF EXISTS` was
    // tolerant of that; a bare DELETE is not). A tagged-template value cannot
    // be a table identifier, so the names stay literal.
    const present = new Set(
      this.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.map(
        row => row.name,
      ),
    );
    const clear = (table: string, run: () => void): void => {
      if (present.has(table)) run();
    };
    clear('run_journal', () => this.sql`DELETE FROM run_journal`);
    clear('runs', () => this.sql`DELETE FROM runs`);
    clear('run_events', () => this.sql`DELETE FROM run_events`);
    clear('usage_ledger', () => this.sql`DELETE FROM usage_ledger`);
    clear('workflow_state', () => this.sql`DELETE FROM workflow_state`);
    clear('cf_agents_schedules', () => this.sql`DELETE FROM cf_agents_schedules`);
    clear('cf_agents_queues', () => this.sql`DELETE FROM cf_agents_queues`);
    clear('cf_agents_mcp_servers', () => this.sql`DELETE FROM cf_agents_mcp_servers`);
    // Drop the alarm: the SDK arms one for the next schedule, and an alarm that
    // fires after the schedules are gone would wake a purged instance for
    // nothing.
    //
    // Deliberately NOT `ctx.storage.deleteAll()`. On a SQLite-backed Durable
    // Object that deletes the TABLES, not just key-value pairs, and this
    // instance keeps serving until it is evicted - so `setState` below and the
    // SDK's `getSchedules()` on any later request both threw "no such table",
    // which made the purge report failure after succeeding and made a retry
    // fail outright. This class stores nothing outside SQLite, so emptying the
    // tables above already removes every byte of workflow data; a Durable Object
    // is not deleted by `deleteAll()` either way.
    await this.ctx.storage.deleteAlarm();
    // Reset state. This rewrites the single `cf_agents_state` row, so the
    // instance is left holding the same blank state a brand-new one would have
    // and a re-push needs no other setup. Preserve `ownerId` so a stray
    // post-purge request can still be attributed for abuse analysis.
    this.setState({
      ...this.initialState,
      ownerId: this.state.ownerId,
    });
    return { ok: true, orphanedSessions };
  }

  /**
   * Best-effort RPC call to purge a portal session DO instance by name.
   * Called from {@link purgeSelf} for every session the `PortalIndex`
   * registry tracked for this workflow. Returns false when the session could
   * not be purged (already evicted, mid-run, transient RPC failure) so the
   * caller keeps its registry entry for a later retry instead of orphaning the
   * instance. Never throws: the owner is torn down regardless.
   */
  private async purgeSessionInstance(sessionName: string): Promise<boolean> {
    try {
      const id = this.env.WorkflowAgent.idFromName(sessionName);
      const stub = this.env.WorkflowAgent.get(id) as unknown as {
        purgeSelf(cascade: boolean): Promise<{ ok: true; orphanedSessions: number }>;
      };
      await stub.purgeSelf(false);
      return true;
    } catch (error) {
      console.warn(`purgeSessionInstance: failed to purge session ${sessionName}`, error);
      return false;
    }
  }

  private async rescheduleCron(spec: WorkflowSpec): Promise<void> {
    // Portal session instances serve ONE visitor conversation. Arming cron
    // there would give every visitor their own recurring job.
    if (this.state.portalSession) return;

    // Drop existing CRON schedules only. Cancelling everything (the previous
    // behaviour) also killed in-flight `waitTimedOut` / `workflowTimedOut`
    // alarms, so a spec push during a suspended run silently dropped its
    // timeouts and the run could hang forever.
    await this.cancelScheduledRuns();
    // Hosted mode: cap active schedules by tier so background cron runs
    // can't burn quota 24/7.
    let scheduleBudget = Number.POSITIVE_INFINITY;
    let tierSchedulesLimit = Number.POSITIVE_INFINITY;
    if (this.hosted && this.state.ownerId) {
      const tenant = await new TenantStore(this.env).getTenant(this.state.ownerId);
      tierSchedulesLimit = tierLimits(tenant?.tier ?? 'starter').schedulesPerWorkflow;
      scheduleBudget = tierSchedulesLimit;
    }
    for (const node of spec.graph.nodes) {
      if (node.kind !== 'schedule-trigger') continue;
      if (scheduleBudget <= 0) {
        // Plain-English: this surfaces in the cloud monitor's status panel
        // (GET /status) and wrangler tail. The node name is user-authored
        // (non-secret) and helps the operator identify which schedule was
        // skipped without exposing cloudflare internals to the end user.
        this.reportSettingsIssue(
          `Schedule "${node.name}" was not armed because this plan allows ` +
            `${tierSchedulesLimit} ${tierSchedulesLimit === 1 ? 'schedule' : 'schedules'} ` +
            `per workflow. The cloud runs the first ${tierSchedulesLimit} ` +
            `in order and skips the rest. Upgrade the plan to arm all schedules.`,
        );
        break;
      }
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
    // An RPC-initiated run (portal turn) can arrive before onStart completes.
    this.ensureTables();

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
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
    });
    // Redaction (P1-12). Built per run from the workflow's retention settings and
    // seeded further at run time with every resolved connection secret. It sits
    // in FRONT of the recorder — which is what clips a payload at 64 KB — so a
    // secret can never be persisted, not even inside a clipped fragment
    // (Requirement 15.10). Rejected rules are reported, never fatal (15.16).
    const retention = dataPathSettings(spec).retention;
    const redactor = createRedactor({
      rules: Array.isArray(retention?.redact) ? retention.redact : [],
      noPersistNodeIds: Array.isArray(retention?.noPersistNodeIds) ? retention.noPersistNodeIds : [],
    });
    for (const ruleError of redactor.ruleErrors) this.reportSettingsIssue(ruleError);

    // Keep the existing graph column, but store a versioned portable envelope.
    // Old rows containing a raw graph remain readable through decodeRunSnapshot.
    const recordGraphJson = encodeRunSnapshot(spec.graph, spec.subWorkflows);
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

    // Hosted: everything runs through OpenRouter on the tenant's key,
    // including every embedded sub-workflow. Mapping clones each authored
    // graph so provider rewrites never change the uploaded spec or history.
    // BYO: provider keys come from the worker's env secrets, as always.
    let graph = spec.graph;
    let subWorkflows = spec.subWorkflows;
    if (this.hosted) {
      const mapped = this.mapSpecToOpenRouter(spec);
      if (typeof mapped === 'string') return { ok: false, error: mapped, status: 422 };
      graph = mapped.graph;
      subWorkflows = mapped.subWorkflows;
    }
    const maxSubWorkflowDepth = tenant
      ? tierLimits(tenant.tier).subWorkflowDepth
      : 2;

    // Workflow-level timeout: the engine enforces the deadline in-process; a
    // durable alarm additionally wakes an evicted DO so a suspended run still
    // times out on schedule. A RESUMED run keeps its original deadline — the
    // remaining budget shrinks by the time already elapsed since startedAt.
    const timeoutMinutes = spec.settings?.timeoutMinutes;
    let runTimeoutMs: number | undefined;
    if (typeof timeoutMinutes === 'number' && timeoutMinutes > 0) {
      const limitMs = timeoutMinutes * 60_000;
      const elapsedMs = resuming ? Date.now() - startedAt : 0;
      runTimeoutMs = Math.max(1, limitMs - elapsedMs);
      void this.schedule(Math.ceil(runTimeoutMs / 1000) + 5, 'workflowTimedOut', runId);
    }

    const model = new FetchModelClient(async provider => {
      if (this.hosted) return tenantKey;
      const envKey = PROVIDER_ENV_KEYS[provider];
      return envKey ? ((this.env[envKey] as string | undefined) ?? null) : null;
    });

    // Deterministic data path (P1). Every capability the data nodes need is
    // injected here and nowhere else, so the engine stays dependency-free and a
    // node that needs something this host cannot supply fails with a message
    // naming the host (Requirements 18.1, 18.5).
    const workflowId = spec.id ?? '';
    const connections = this.connectionHost(workflowId);
    const dataFetch = this.dataFetchHost();

    const handle = startRun({
      runId,
      graph,
      input,
      source: recordedSource,
      workflowId,
      connections,
      dataFetch,
      sql: this.sqlQueryHost(),
      state: this.workflowStateHost(),
      fixtures: this.fixtureHost(workflowId),
      redact: value => redactor.scrub(value),
      capabilities: CLOUDFLARE_CAPABILITIES,
      // Batch workflows (ForEach) legitimately execute far more nodes than
      // the default anti-runaway budget allows. Embedded graphs share the
      // parent run's execution counter, so they must participate in the scan.
      maxExecutions: this.hasForEach(graph, subWorkflows) ? 2000 : undefined,
      subWorkflows,
      resolveWorkflow: workflowId => subWorkflows?.[workflowId],
      maxSubWorkflowDepth,
      runTimeoutMs,
      journal,
      model,
      tools: new CloudToolHost({
        restrictEgress: this.hosted,
        // Remote MCP bearer tokens come from worker secrets named
        // `MCP_<AUTHKEY>` (e.g. authKey `GITHUB_TOKEN` -> secret MCP_GITHUB_TOKEN).
        resolveBearer: authKey => {
          const value = this.env[`MCP_${authKey}`];
          return typeof value === 'string' && value.trim() ? value : null;
        },
        // http-tool nodes reuse the SAME connection store as the deterministic
        // data path, so an agent-callable HTTP tool can carry real auth
        // (Basic/Bearer/etc.) without a secret ever living in node.data.
        resolveConnection: connectionId => connections.resolve(connectionId),
      }),
      ollamaBaseUrl: this.env.OLLAMA_BASE_URL,
      bedrockRegion: this.env.BEDROCK_REGION,
      emit: rawEvent => {
        // Hosted inference is billed to the tenant's Phorma Cloud plan
        // credits, so usage events are re-labeled `phorma-cloud` regardless
        // of the OpenRouter mapping — the recorder's rollups and the studio
        // UI use that provider to render credits instead of dollars (plan
        // subscribers must never see raw USD). BYO deployments keep their
        // real provider names (their cost IS dollars).
        const event =
          this.hosted && rawEvent.type === 'node-usage'
            ? { ...rawEvent, provider: 'phorma-cloud' }
            : rawEvent;
        if (event.type === 'node-usage') {
          runUsage.inputTokens += event.usage.inputTokens ?? 0;
          runUsage.outputTokens += event.usage.outputTokens ?? 0;
          runUsage.costUsd += event.usage.costUsd ?? 0;
        }
        // Requirement 15.10: the persistence path — and only the persistence
        // path — is redacted, ahead of the recorder's own 64 KB clipping.
        recorder.record(redactor.event(event));
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
        // Monitors (and the portal projection) keep full in-memory fidelity for
        // the operator watching the run live.
        this.relay(event);
        // Workflow-level notifications are HOST behaviour: the DO watches its
        // own event stream (Requirements 13.7, 13.10).
        this.notifyOnRunEvent(event, spec, { connections, dataFetch, redactor });
      },
      requestApproval: (_nodeId, _message, _payload, requestId) =>
        new Promise<boolean>(resolve => {
          this.approvals.set(requestId, resolve);
        }),
      requestInput: (_nodeId, _question, _payload, requestId) =>
        new Promise<string>(resolve => {
          this.questions.set(requestId, resolve);
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
      for (const resolve of this.questions.values()) resolve('');
      this.questions.clear();
      for (const waiter of this.waits.values()) waiter.resolve('');
      this.waits.clear();
      this.earlyEvents.clear();
      // The run settled — drop the resume marker, its journal rows, and any
      // pending workflow-timeout wake alarm.
      this.setState({ ...this.state, activeRun: null });
      this.sql`DELETE FROM run_journal WHERE run_id = ${runId}`;
      void (async () => {
        for (const schedule of this.getSchedules()) {
          if (schedule.callback === 'workflowTimedOut') {
            await this.cancelSchedule(schedule.id);
          }
        }
      })().catch(() => undefined);
      this.recordRunUsage(runUsage);
      // Run history: finalize the summary, flush the coalesced event log,
      // and prune beyond the retention limit.
      const record = recorder.snapshot();
      this.persistRunSummary(record.summary, recordGraphJson);
      this.persistRunEvents(runId, record.events);
      this.pruneRunHistory();
      this.writeUsageLedger(record.summary);
      // Portal runs execute in per-visitor session instances, so without this
      // the owner's Runs and Usage panels would never see them.
      this.mirrorPortalRun(record.summary, recordGraphJson);
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
    const map = (
      nodeName: string,
      target: { provider?: ModelProviderId; model?: string },
    ): string | null => {
      if (!target.provider || !target.model) return null;
      const prefix = OPENROUTER_SLUG_PREFIX[target.provider];
      if (prefix === null) {
        return `Agent "${nodeName}" uses ${target.provider}, which is not available on Phorma Cloud. Pick a cloud model.`;
      }
      // openrouter + phorma-cloud already carry a full OpenRouter slug.
      if (target.provider !== 'openrouter' && target.provider !== 'phorma-cloud') {
        target.model = `${prefix}${target.model}`;
      }
      target.provider = 'openrouter';
      return null;
    };
    for (const node of mapped.nodes) {
      const data = node.data as {
        provider?: ModelProviderId;
        model?: string;
        fallback?: { provider: ModelProviderId; model: string };
      };
      const primaryError = map(node.name, data);
      if (primaryError) return primaryError;
      // The LLM-fallback model must be mapped too — it is executed by the
      // same hosted OpenRouter path when the primary fails.
      if (data.fallback) {
        const fallbackError = map(node.name, data.fallback);
        if (fallbackError) return fallbackError;
      }
    }
    return mapped;
  }

  /** Maps the parent and every embedded graph without mutating the spec. */
  private mapSpecToOpenRouter(
    spec: WorkflowSpec,
  ):
    | {
        graph: WorkflowSpec['graph'];
        subWorkflows: WorkflowSpec['subWorkflows'];
      }
    | string {
    const graph = this.mapGraphToOpenRouter(spec.graph);
    if (typeof graph === 'string') return graph;

    if (!spec.subWorkflows) return { graph, subWorkflows: undefined };
    const subWorkflows: NonNullable<WorkflowSpec['subWorkflows']> = {};
    for (const [workflowId, workflow] of Object.entries(spec.subWorkflows)) {
      const mappedGraph = this.mapGraphToOpenRouter(workflow.graph);
      if (typeof mappedGraph === 'string') {
        return `Sub-workflow "${workflow.name}" (${workflowId}): ${mappedGraph}`;
      }
      subWorkflows[workflowId] = { ...workflow, graph: mappedGraph };
    }
    return { graph, subWorkflows };
  }

  // ── Workflow-level notifications (P1-10) ───────────────────────────────────

  /**
   * Watches the run's own event stream and delivers the workflow notification
   * policy (Requirements 13.7, 13.10).
   *
   * This is deliberately HOST behaviour, not engine behaviour: the DO already
   * sees every event, so a policy needs no node on the canvas. A policy that
   * does not name the trigger for this event issues no outbound request at all.
   *
   * Fire-and-forget: the run's outcome is reported whether or not the delivery
   * lands (Requirement 13.7).
   */
  private notifyOnRunEvent(
    event: RunEvent,
    spec: WorkflowSpec,
    host: { connections: WorkerConnectionStore; dataFetch: DataFetcher; redactor: Redactor },
  ): void {
    const trigger = notificationTriggerFor(event);
    if (trigger === undefined) return;
    const policy = dataPathSettings(spec).notifications;
    // Requirement 13.10: no policy, or a policy that does not subscribe to this
    // trigger, means no notification and no request.
    if (!notificationWanted(policy, trigger)) return;

    // `waitUntil` keeps the invocation alive until the delivery settles: a
    // terminal event fires as the run unwinds, and without it the isolate can be
    // torn down mid-POST — the notification would silently vanish.
    this.ctx.waitUntil(
      this.deliverWorkflowNotification(trigger, event, policy, spec, host).catch(() => undefined),
    );
  }

  /**
   * One notification, at most {@link NOTIFY_MAX_ATTEMPTS} attempts, through the
   * same `DataFetcher` the data nodes use — so the egress guard, the response cap
   * and the per-attempt timeout are identical (Requirements 13.7, 18.5).
   *
   * The body carries run metadata and a redacted reason only: never a node
   * output, never a resolved secret.
   */
  private async deliverWorkflowNotification(
    trigger: NotifyTrigger,
    event: RunEvent,
    policy: WorkflowNotificationPolicy,
    spec: WorkflowSpec,
    host: { connections: WorkerConnectionStore; dataFetch: DataFetcher; redactor: Redactor },
  ): Promise<void> {
    const connectionId = policy.connectionId?.trim();
    let conn: ResolvedConnection | undefined;
    if (connectionId) {
      try {
        conn = await host.connections.resolve(connectionId);
      } catch (error) {
        // An unresolvable connection means no delivery, never a partial one.
        this.reportSettingsIssue(
          `Workflow notification for "${trigger}" was not delivered: ` +
            `${host.redactor.scrub(messageOf(error))}`,
        );
        return;
      }
      // Requirement 15.2: registered before anything is emitted or persisted
      // about this delivery.
      host.redactor.addLiterals(Object.values(conn.secrets));
    }

    const to = (policy.to ?? '').trim();
    const endpoint = notificationEndpoint(to, conn);
    if (!endpoint) {
      this.reportSettingsIssue(
        `Workflow notification for "${trigger}" has no delivery target: set settings.notifications.to ` +
          `to an https URL, or give the connection a notifyUrl or baseUrl.`,
      );
      return;
    }

    const body = JSON.stringify({
      trigger,
      runId: 'runId' in event ? event.runId : null,
      workflowId: spec.id ?? null,
      workflowName: spec.name,
      environment: 'cloud',
      // Recipient only when the endpoint is the provider, not the recipient.
      to: to === endpoint ? undefined : to || undefined,
      detail: host.redactor.scrub(notificationDetail(event)).slice(0, NOTIFY_DETAIL_CHARS),
      at: Date.now(),
    });

    // Auth last, exactly as the engine's request builder orders it, so the
    // connection always wins over the message's own headers.
    const request: DataRequest = applyConnectionAuth(
      {
        url: endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      },
      conn,
    );

    let detail = 'no attempt was made';
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await host.dataFetch(request);
        if (response.status >= 200 && response.status <= 299) return;
        detail = `HTTP ${response.status}`;
      } catch (error) {
        // A transport message can echo the target's own text, so it is scrubbed
        // before it can reach `GET /status` or a log line.
        detail = host.redactor.scrub(messageOf(error));
      }
      if (attempt < NOTIFY_MAX_ATTEMPTS) {
        await new Promise<void>(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    this.reportSettingsIssue(
      `Workflow notification for "${trigger}" failed after ${NOTIFY_MAX_ATTEMPTS} attempts (${detail}).`,
    );
  }

  /** True when any graph sharing this run's execution budget contains ForEach. */
  private hasForEach(
    graph: WorkflowSpec['graph'],
    subWorkflows: WorkflowSpec['subWorkflows'],
  ): boolean {
    if (graph.nodes.some(node => node.kind === 'for-each')) return true;
    return Object.values(subWorkflows ?? {}).some(workflow =>
      workflow.graph.nodes.some(node => node.kind === 'for-each'),
    );
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

  /**
   * Drops runs (and their events) beyond the workflow's retention bounds:
   * everything past the `keepRuns` most recent, then everything older than
   * `maxAgeDays` (Requirement 15.12). Both come from
   * `WorkflowSettings.retention` when they are valid and from the host default
   * of {@link WorkflowAgent.RUN_HISTORY_LIMIT} otherwise (Requirement 15.13).
   *
   * `workflow_state` — and with it the `fx:` fixtures — is a different table on
   * purpose, so pruning history never touches a workflow's state or fixtures
   * (Requirement 16.10).
   */
  private pruneRunHistory(): void {
    const { keepRuns, maxAgeMs } = this.runRetention();
    const doomed = [
      ...this.sql<{ run_id: string }>`
        SELECT run_id FROM runs
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ${keepRuns}
      `,
    ];
    if (maxAgeMs !== null) {
      doomed.push(
        ...this.sql<{ run_id: string }>`
          SELECT run_id FROM runs WHERE started_at < ${Date.now() - maxAgeMs}
        `,
      );
    }
    for (const runId of new Set(doomed.map(row => row.run_id))) {
      this.sql`DELETE FROM run_events WHERE run_id = ${runId}`;
      this.sql`DELETE FROM runs WHERE run_id = ${runId}`;
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
      const snapshot = decodeRunSnapshot(rows[0].graph);
      const events: RunLogEvent[] = [];
      for (const row of this.sql<{ event: string }>`
        SELECT event FROM run_events WHERE run_id = ${runId} ORDER BY seq ASC
      `) {
        events.push(JSON.parse(row.event) as RunLogEvent);
      }
      return {
        summary,
        graph: snapshot.graph,
        subWorkflows: snapshot.subWorkflows,
        events,
      };
    } catch {
      return null;
    }
  }

  // ── Usage ledger (EPIC 2) ───────────────────────────────────────────────────────────

  /** Writes (or replaces, for resumed runs) a settled run's ledger row. */
  private writeUsageLedger(summary: RunRecordSummary): void {
    this.sql`
      INSERT OR REPLACE INTO usage_ledger
        (run_id, workflow_id, workflow_name, source, status, started_at, ended_at, usage)
      VALUES (
        ${summary.id},
        ${summary.workflowId},
        ${summary.workflowName},
        ${summary.source},
        ${summary.status},
        ${summary.startedAt},
        ${summary.endedAt ?? null},
        ${JSON.stringify(summary.usage)}
      )
    `;
    // Retention: age-based first, then a hard row cap (newest kept).
    this.sql`
      DELETE FROM usage_ledger
      WHERE started_at < ${Date.now() - WorkflowAgent.USAGE_LEDGER_MAX_AGE_MS}
    `;
    this.sql`
      DELETE FROM usage_ledger WHERE run_id IN (
        SELECT run_id FROM usage_ledger
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ${WorkflowAgent.USAGE_LEDGER_MAX_ROWS}
      )
    `;
  }

  /** Ledger rows started at/after `since`, newest first. */
  private listUsageLedger(since: number): UsageLedgerEntry[] {
    const rows: UsageLedgerEntry[] = [];
    for (const row of this.sql<{
      run_id: string;
      workflow_id: string | null;
      workflow_name: string;
      source: string;
      status: string;
      started_at: number;
      ended_at: number | null;
      usage: string;
    }>`
      SELECT run_id, workflow_id, workflow_name, source, status, started_at, ended_at, usage
      FROM usage_ledger
      WHERE started_at >= ${since}
      ORDER BY started_at DESC
    `) {
      try {
        rows.push({
          runId: row.run_id,
          workflowId: row.workflow_id,
          workflowName: row.workflow_name,
          source: row.source as RunSource,
          status: row.status as RunRecordSummary['status'],
          environment: 'cloud',
          startedAt: row.started_at,
          endedAt: row.ended_at ?? undefined,
          usage: JSON.parse(row.usage) as RunRecordUsage,
        });
      } catch {
        // Corrupt row — skip.
      }
    }
    return rows;
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
    this.fanOutToPortal(event);
  }

  // ── Portal: owner operations (EPIC 9) ──────────────────────────────────────

  /**
   * This instance's library workflow id.
   *
   * `this.name` is only available when the request arrived through
   * `routePartykitRequest` — reading it on an RPC-reached instance throws — so
   * the spec id and the session record are consulted first.
   */
  private workflowKey(): string {
    const fromSpec = this.state.spec?.id;
    if (fromSpec) return fromSpec;
    const fromSession = this.state.portalSession?.workflowId;
    if (fromSession) return fromSession;
    try {
      return this.name.split(':').pop() ?? this.name;
    } catch {
      return 'default';
    }
  }

  /** Runs the shared publish validator against the current spec. */
  private validateForPublish(takenSlugs: string[]): PortalValidation {
    const graph = this.state.spec?.graph;
    if (!graph) {
      return {
        errors: [{ code: 'no-workflow', message: 'Push this workflow before publishing it.' }],
        warnings: [],
        responderNodeId: null,
      };
    }
    return validatePortal(graph, { takenSlugs });
  }

  /**
   * Publishes the pushed spec's portal trigger. The spec is the source of
   * truth: the studio edits the `portal-trigger` node on the canvas, pushes,
   * then calls this. Re-validating here means a hand-rolled POST cannot
   * bypass the UI's checks.
   */
  private async publishPortal(): Promise<Response> {
    const spec = this.state.spec;
    if (!spec) return json({ ok: false, error: 'Push this workflow before publishing it.' }, 409);

    const trigger = findPortalTrigger(spec.graph);
    if (!trigger) {
      return json({ ok: false, error: 'This workflow has no Portal trigger node.' }, 422);
    }

    const index = portalIndex(this.env);
    const workflowId = this.workflowKey();
    const taken = await index.takenSlugs(workflowId);
    const validation = validatePortal(spec.graph, { takenSlugs: taken });
    if (validation.errors.length) {
      return json({ ok: false, error: validation.errors[0].message, validation }, 422);
    }

    // Hosted mode: a published portal is reachable by strangers and spends the
    // tenant's credits, so the count is capped per tier.
    if (this.hosted && this.state.ownerId) {
      const tenant = await new TenantStore(this.env).getTenant(this.state.ownerId);
      const cap = tierLimits(tenant?.tier ?? 'starter').publishedPortals;
      const already = await index.countForOwner(this.state.ownerId, workflowId);
      if (already >= cap) {
        return json(
          {
            ok: false,
            error: `Your plan allows ${cap} published ${cap === 1 ? 'portal' : 'portals'}. Take one offline or upgrade your plan.`,
          },
          402,
        );
      }
    }

    const data = trigger.data as PortalTriggerData;
    // An empty slug is normal — publishing must not stall on naming.
    const slug = data.slug?.trim() || suggestPortalSlug(spec.name, () => Math.random());
    const config = portalPublicConfig({ ...data, slug }, spec.name);
    const existing = (await index.statusFor(workflowId)).record;

    const record: PublishRecord = {
      slug,
      workflowId,
      ownerId: this.state.ownerId ?? null,
      workflowName: spec.name,
      mode: config.mode,
      access: config.access,
      title: config.title,
      greeting: config.greeting,
      fields: config.fields,
      responderNodeId: resolveResponderNodeId(spec.graph, data.responderNodeId),
      rateLimitPerMin:
        data.rateLimitPerMin && data.rateLimitPerMin > 0
          ? Math.min(data.rateLimitPerMin, 120)
          : PORTAL_DEFAULT_RATE_LIMIT_PER_MIN,
      theme: config.theme,
      showBranding: config.showBranding,
      embedEnabled: config.embedEnabled,
      embedOrigins: config.embedOrigins,
      embedLabel: config.embedLabel,
      // Keys survive re-publishing: an owner who tweaks a greeting must not
      // silently break every integration holding a key.
      tokens: existing?.tokens ?? [],
      publishedAt: existing?.publishedAt ?? Date.now(),
      updatedAt: Date.now(),
      hits: existing?.hits ?? 0,
      lastHitAt: existing?.lastHitAt,
    };

    const result = await index.publish(record);
    if (!result.ok) return json({ ok: false, error: result.error }, 409);
    return json({ ok: true, record: redactPublishRecord(record), validation });
  }

  /** Mints a scoped access key. The plaintext is returned exactly once. */
  private async mintPortalKey(label: string): Promise<Response> {
    const index = portalIndex(this.env);
    const workflowId = this.workflowKey();
    const { record } = await index.statusFor(workflowId);
    if (!record) return json({ ok: false, error: 'Publish this workflow first.' }, 409);
    if (record.tokens.length >= PORTAL_MAX_TOKENS) {
      return json(
        { ok: false, error: `A portal may hold at most ${PORTAL_MAX_TOKENS} access keys.` },
        409,
      );
    }
    const minted = await mintPortalToken(record.slug, label);
    await index.setTokens(workflowId, [...record.tokens, minted.record]);
    return json({
      ok: true,
      // The ONLY time the plaintext exists outside the caller's clipboard.
      secret: minted.secret,
      token: publicTokenView(minted.record),
    });
  }

  /** Revokes one access key by id. */
  private async revokePortalKey(tokenId: string): Promise<Response> {
    const index = portalIndex(this.env);
    const workflowId = this.workflowKey();
    const { record } = await index.statusFor(workflowId);
    if (!record) return json({ ok: false, error: 'This workflow is not published.' }, 409);
    const remaining = record.tokens.filter(token => token.id !== tokenId);
    if (remaining.length === record.tokens.length) {
      return json({ ok: false, error: 'No such access key.' }, 404);
    }
    await index.setTokens(workflowId, remaining);
    return json({ ok: true });
  }

  /** Portal-sourced run summaries mirrored here by session instances. */
  private listPortalRunSummaries(): RunRecordSummary[] {
    return this.listRunSummaries().filter(summary => summary.source === 'portal');
  }

  // ── Portal: session instances (EPIC 9) ─────────────────────────────────────

  /**
   * The spec a portal session should execute. Internal RPC from the public
   * router: it deliberately returns the spec ONLY (no owner, usage, history or
   * run state), and it is never reachable over HTTP.
   */
  async publishedSpec(): Promise<WorkflowSpec | null> {
    return this.state.spec ?? null;
  }

  /**
   * Prepares this instance to serve ONE visitor conversation.
   *
   * Called by the public router (worker-side, already rate-limited and
   * access-checked) with the published spec. Session instances deliberately
   * never arm cron: a hundred visitors must not create a hundred cron jobs.
   */
  async initPortalSession(input: {
    spec: WorkflowSpec;
    slug: string;
    sessionId: string;
    workflowId: string;
    ownerInstance: string;
    ownerId: string | null;
    responderNodeId: string | null;
  }): Promise<{ ok: true }> {
    const existing = this.state.portalSession;
    this.setState({
      ...this.state,
      spec: input.spec,
      savedAt: new Date().toISOString(),
      ownerId: input.ownerId,
      portalSession: {
        slug: input.slug,
        sessionId: input.sessionId,
        workflowId: input.workflowId,
        ownerInstance: input.ownerInstance,
        responderNodeId: input.responderNodeId,
        // Re-initialising an existing session (a later turn, or a wake after
        // eviction) must keep the transcript or `{{history}}` resets to empty.
        transcript: existing?.transcript ?? [],
        createdAt: existing?.createdAt ?? Date.now(),
      },
    });
    return { ok: true };
  }

  /**
   * Starts a visitor turn. Returns the runId the visitor's SSE stream should
   * attach to, or a public-safe error.
   *
   * The transcript lives here, so multi-turn chat needs no engine change: the
   * envelope carries `{{message}}` and `{{history}}` as JSON, which
   * `interpolatePayload` already resolves.
   */
  async startPortalTurn(input: {
    message?: string;
    fields?: Record<string, string | number | boolean>;
  }): Promise<{ ok: boolean; runId?: string; error?: string; status?: number }> {
    const session = this.state.portalSession;
    if (!session) return { ok: false, error: 'This conversation has expired.', status: 409 };
    if (this.handle) {
      return { ok: false, error: 'Still working on your last message.', status: 409 };
    }

    const message = input.message?.trim() ?? '';
    const turnNumber = session.transcript.filter(turn => turn.role === 'user').length + 1;
    const envelope = buildPortalInput({
      message,
      fields: input.fields,
      history: session.transcript,
      sessionId: session.sessionId,
      turn: turnNumber,
    });

    // Record the visitor's turn BEFORE running so a failed run still leaves a
    // coherent transcript for the retry.
    this.appendPortalTurn({
      role: 'user',
      text: message || renderFieldSummary(input.fields),
      at: Date.now(),
    });

    this.portalReplay = [];
    const result = await this.trigger(envelope, undefined, 'portal');
    if (!result.ok) {
      // `trigger` rejections are written for the OPERATOR ("Visit Settings →
      // Cloud to subscribe", "Monthly credits exhausted") and must never be
      // shown to a stranger.
      return { ok: false, error: publicTriggerError(result.status), status: result.status ?? 409 };
    }
    return result;
  }

  /** Answers a pending Ask User node from the portal page. */
  async answerPortalQuestion(requestId: string, response: string): Promise<{ delivered: boolean }> {
    const resolve = this.questions.get(requestId);
    if (!resolve) return { delivered: false };
    this.questions.delete(requestId);
    resolve(response);
    return { delivered: true };
  }

  /**
   * Opens a redacted SSE stream for the current turn. Replays whatever the run
   * has already produced (the page POSTs then subscribes, so tokens can arrive
   * before the listener does).
   */
  async openPortalStream(): Promise<Response> {
    if (!this.state.portalSession) {
      return new Response('event: error\ndata: {"type":"error","message":"Expired."}\n\n', {
        status: 200,
        headers: SSE_HEADERS,
      });
    }

    const encoder = new TextEncoder();
    let writer: PortalStreamWriter | null = null;
    const streams = this.portalStreams;
    const replay = [...this.portalReplay];
    const running = this.handle !== null;

    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        writer = {
          write: text => controller.enqueue(encoder.encode(text)),
          close: () => {
            try {
              controller.close();
            } catch {
              // Already closed by a racing terminal event.
            }
            if (writer) streams.delete(writer);
          },
        };

        let sawTerminal = false;
        for (const event of replay) {
          writer.write(toSseFrame(event));
          if (isTerminalPortalEvent(event)) sawTerminal = true;
        }
        // A finished turn needs no live subscription.
        if (sawTerminal || !running) {
          writer.close();
          return;
        }
        streams.add(writer);
      },
      cancel: () => {
        if (writer) streams.delete(writer);
      },
    });

    return new Response(body, { status: 200, headers: SSE_HEADERS });
  }

  /** The visitor-facing config for this session's portal. */
  async portalSessionInfo(): Promise<{ active: boolean; turns: number }> {
    const session = this.state.portalSession;
    return {
      active: !!session,
      turns: session?.transcript.filter(turn => turn.role === 'user').length ?? 0,
    };
  }

  /**
   * Accepts a settled portal run from a session instance so the owner's Runs
   * and Usage panels stay whole. Internal: reached only via RPC from a sibling
   * DO inside the same worker, never over HTTP.
   */
  async acceptPortalRun(summary: RunRecordSummary, graph: string): Promise<{ ok: true }> {
    // Reached by RPC, so onStart may not have run yet.
    this.ensureTables();
    this.persistRunSummary(summary, graph);
    this.pruneRunHistory();
    this.writeUsageLedger(summary);
    return { ok: true };
  }

  /**
   * Copies a settled session run up to the owner instance. Best-effort: a
   * mirroring failure must never affect the visitor's answer.
   */
  private mirrorPortalRun(summary: RunRecordSummary, graph: string): void {
    const session = this.state.portalSession;
    if (!session || summary.source !== 'portal') return;
    // A session instance name always carries the `#s` suffix, so it can never
    // equal the owner instance — but assert it anyway: a self-call would
    // recurse through acceptPortalRun.
    const ownerInstance = session.ownerInstance;
    if (!ownerInstance || ownerInstance.includes('#s')) return;
    void (async () => {
      const stub = this.env.WorkflowAgent.get(
        this.env.WorkflowAgent.idFromName(ownerInstance),
      ) as unknown as { acceptPortalRun(s: RunRecordSummary, g: string): Promise<unknown> };
      await stub.acceptPortalRun(summary, graph);
    })().catch(() => undefined);
  }

  // ── Portal streaming (EPIC 9) ──────────────────────────────────────────────

  /**
   * Pushes the REDACTED projection of an event to portal SSE subscribers.
   *
   * Public visitors never get a WebSocket: the `agents` SDK sends the whole
   * agent state (spec + ownerId) on connect and lets any client overwrite it,
   * so a socket here would publish the owner's prompts. SSE is one-way and
   * carries only what `toPortalEvent` explicitly allows.
   */
  private fanOutToPortal(event: RunEvent): void {
    const session = this.state.portalSession;
    if (!session) return;
    const projected = toPortalEvent(event, { responderNodeId: session.responderNodeId });
    if (!projected) return;

    // Buffer for a visitor whose EventSource has not attached yet: the page
    // POSTs the message and opens the stream as two round trips, so the first
    // tokens can legitimately land before anyone is listening.
    this.portalReplay.push(projected);
    if (this.portalReplay.length > PORTAL_REPLAY_LIMIT) {
      this.portalReplay = this.portalReplay.slice(-PORTAL_REPLAY_LIMIT);
    }
    // Remember the answer so the next turn's `{{history}}` includes it.
    if (projected.type === 'done') {
      this.appendPortalTurn({ role: 'assistant', text: projected.output, at: Date.now() });
    }

    const frame = toSseFrame(projected);
    const terminal = isTerminalPortalEvent(projected);
    for (const stream of [...this.portalStreams]) {
      try {
        stream.write(frame);
        if (terminal) stream.close();
      } catch {
        // A disconnected visitor must never break a run.
        this.portalStreams.delete(stream);
      }
    }
    if (terminal) this.portalStreams.clear();
  }

  /** Records the assistant's answer in the session transcript. */
  private appendPortalTurn(turn: PortalTurn): void {
    const session = this.state.portalSession;
    if (!session) return;
    this.setState({
      ...this.state,
      portalSession: {
        ...session,
        transcript: trimPortalHistory([...session.transcript, turn]),
      },
    });
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

/** An error's message, without leaking a non-Error's internals. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // The studio calls from a Tauri webview / localhost dev server.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

// ── Portal helpers (EPIC 9) ─────────────────────────────────────────────────

/** How many public events a portal turn buffers for a late SSE subscriber. */
const PORTAL_REPLAY_LIMIT = 2000;

/** Access keys per portal. Enough for real integrations, bounded for storage. */
const PORTAL_MAX_TOKENS = 20;

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Nginx-style proxies buffer by default and would defeat streaming.
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
};

/** One open portal SSE stream. */
interface PortalStreamWriter {
  write(text: string): void;
  close(): void;
}

/** Owner-facing key metadata. The hash never leaves the worker. */
function publicTokenView(token: PortalTokenRecord): Omit<PortalTokenRecord, 'hash'> {
  const { hash: _hash, ...rest } = token;
  return rest;
}

/**
 * The owner's view of a publish record: everything except the key hashes,
 * which are useless to a client and are credential material.
 */
function redactPublishRecord(record: PublishRecord): Omit<PublishRecord, 'tokens'> & {
  tokens: Omit<PortalTokenRecord, 'hash'>[];
} {
  return { ...record, tokens: record.tokens.map(publicTokenView) };
}

/**
 * Maps a `trigger()` rejection to copy a stranger may read.
 *
 * The originals are addressed to the operator ("Visit Settings → Cloud to
 * subscribe", "Monthly credits exhausted. Resets next month or upgrade your
 * plan.") and would leak the owner's billing state to the public.
 */
function publicTriggerError(status?: number): string {
  switch (status) {
    case 429:
      return 'This assistant is busy right now. Please try again shortly.';
    case 402:
      return 'This assistant is temporarily unavailable.';
    default:
      return 'This assistant is temporarily unavailable.';
  }
}

/** Human-readable one-line summary of submitted form values. */
function renderFieldSummary(fields?: Record<string, string | number | boolean>): string {
  if (!fields) return '';
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
}

/** Hosted egress limits for user-defined tool calls. */
const TOOL_RESPONSE_MAX_BYTES = 256 * 1024;
const TOOL_TIMEOUT_MS = 30_000;

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
  /** Resolves an `http-tool` node's stored connection (base url + auth). */
  private readonly resolveConnection?: (connectionId: string) => Promise<ResolvedConnection>;

  constructor(options?: {
    restrictEgress?: boolean;
    resolveBearer?: (authKey: string) => string | null;
    resolveConnection?: (connectionId: string) => Promise<ResolvedConnection>;
  }) {
    this.restrictEgress = options?.restrictEgress ?? false;
    this.resolveBearer = options?.resolveBearer;
    this.resolveConnection = options?.resolveConnection;
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
        const data = node.data as { transport?: string; url?: string; authMode?: string };
        if (data.transport === 'stdio') {
          throw new Error(
            `MCP node "${node.name}" uses a local (stdio) server — deployed workflows need a remote MCP URL.`,
          );
        }
        if (data.authMode === 'oauth') {
          throw new Error(
            `MCP node "${node.name}" uses interactive OAuth sign-in - a deployed workflow can't reuse that ` +
              `signed-in session. Use an MCP server authenticated with a static API token/bearer credential instead.`,
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
        const connectionId = (node.data as { connectionId?: string }).connectionId;
        let authedRequest = request;
        try {
          if (connectionId) {
            if (!this.resolveConnection) return 'Error: connections are not available on this host.';
            const conn = await this.resolveConnection(connectionId);
            authedRequest = applyConnectionAuth({ ...request, url: withConnectionBaseUrl(request.url, conn) }, conn);
          }
          const result = await guardedFetchText(
            authedRequest.url,
            { method: authedRequest.method, headers: authedRequest.headers, body: authedRequest.body },
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
