/**
 * Host_Adapter composition and the contract completeness assertion that gates
 * the listener (Req 1.9, 7.3, 8.1).
 *
 * Two halves, in the order the Server_Entry runs them:
 *
 * 1. `composeHostAdapter(env)` builds the production Host_Adapter from the six
 *    AWS clients under `src/aws/`, then asserts that every capability the frozen
 *    ten-key `RUNTIME_HOST_CAPABILITIES` array names has a live implementation.
 * 2. `startHost(env)` wraps that: an `IncompleteContractError` writes each
 *    missing capability name to stderr on its own line and exits non-zero.
 *
 * Both run BEFORE `http.createServer(...).listen(...)`, so a partial adapter
 * means the process is gone before a listener exists and the NLB target never
 * reports healthy. No run is started and no trigger request is ever accepted
 * against a partial adapter.
 *
 * The split is deliberate: composition is pure of process access and throws,
 * while the stderr write and the exit live in one small reporting layer that a
 * test can drive through injected sinks. `server/index.ts main()` calls
 * `startHost`; nothing else needs the exit behaviour.
 *
 * No client is constructed at module load. The Check_Pipeline imports this file
 * with no AWS credentials present, so every client is built inside
 * `composeHostAdapter`, which runs only after `readServerEnv` succeeds.
 *
 * Feature: aws-deployment-target, aws-byo-deploy
 * Requirements: 1.9, 7.3, 8.1
 */

import type { Connection, Redactor, WorkflowStateStore } from '@phorma/engine';
import { createRedactor } from '@phorma/engine';

import { RUNTIME_HOST_CAPABILITIES, type RuntimeHostCapability } from '../core/host-contract.js';
import type {
  JournalStore,
  LeaseStore,
  RunEventStore,
  RunHistoryStore,
  SpecStore,
  UsageLedgerStore,
} from '../core/host-contract.js';
import { isExpired } from '../core/retention.js';
import type { Item } from '../core/table-ops.js';

import { createDocumentTableClient } from '../aws/document-table-client.js';
import type { DocumentTableClientOptions } from '../aws/document-table-client.js';
import { createMetricPublisher } from '../aws/metric-publisher.js';
import type { MetricPublisherOptions } from '../aws/metric-publisher.js';
import { createMonitorBackend } from '../aws/monitor-backend.js';
import type { MonitorBackendOptions } from '../aws/monitor-backend.js';
import { createSchedulerBackend } from '../aws/scheduler-backend.js';
import type { SchedulerBackendOptions } from '../aws/scheduler-backend.js';
import { createSecretsBackend } from '../aws/secrets-backend.js';
import type { SecretsBackendOptions } from '../aws/secrets-backend.js';
import { createStdoutLogWriter } from '../aws/stdout-log-writer.js';
import type { StdoutLogWriterOptions } from '../aws/stdout-log-writer.js';
import { MonitorAdapter } from '../aws/monitor.js';
import { RunTableAdapter } from '../aws/run-table.js';
import { SchedulerAdapter } from '../aws/scheduler.js';
import { SecretsAdapter } from '../aws/secrets.js';
import { TelemetryAdapter } from '../aws/telemetry.js';
import type {
  DocumentTableClient,
  LogWriter,
  MetricPublisher,
  MonitorBackend,
  SchedulerBackend,
  SecretsBackend,
} from '../aws/ports.js';

import type { ServerEnv } from './env.js';

// ---------------------------------------------------------------------------
// Adapter shape expected at startup
// ---------------------------------------------------------------------------

/**
 * A record keyed by each RuntimeHostCapability with its live implementation
 * (or undefined/null if unimplemented).
 */
export type HostAdapter = Readonly<Record<RuntimeHostCapability, unknown>>;

// ---------------------------------------------------------------------------
// Startup assertion
// ---------------------------------------------------------------------------

/**
 * Error thrown when the composed adapter is missing one or more capability
 * implementations that AWS_CAPABILITIES declares present.
 */
export class IncompleteContractError extends Error {
  /** The capability keys that are declared present but have no live implementation. */
  readonly missing: readonly RuntimeHostCapability[];

  constructor(missing: readonly RuntimeHostCapability[]) {
    super(
      `AWS_Host startup failed: unimplemented capabilities: ${missing.join(', ')}`,
    );
    this.name = 'IncompleteContractError';
    this.missing = missing;
  }
}

/**
 * Assert that the composed adapter provides a live (non-nullish) implementation
 * for every capability in the frozen RUNTIME_HOST_CAPABILITIES array.
 *
 * This runs before the NLB target reports healthy, so no trigger request is
 * ever accepted with a partial adapter.
 *
 * @param adapter - The composed adapter to validate.
 * @throws IncompleteContractError naming each unimplemented capability.
 */
export function assertContractComplete(adapter: HostAdapter): void {
  const missing: RuntimeHostCapability[] = [];

  for (const capability of RUNTIME_HOST_CAPABILITIES) {
    if (adapter[capability] == null) {
      missing.push(capability);
    }
  }

  if (missing.length > 0) {
    throw new IncompleteContractError(missing);
  }
}
// ---------------------------------------------------------------------------
// Production composition
// ---------------------------------------------------------------------------

/**
 * The exit code used when the composed adapter is incomplete. Any non-zero code
 * satisfies Req 7.3; 1 is the conventional one, and ECS reports it verbatim as
 * the task stop code.
 */
export const EXIT_INCOMPLETE_CONTRACT = 1;

/**
 * The `workflowId` dimension on host-lifecycle telemetry.
 *
 * `TelemetryAdapter` is constructed per workflow, because a log entry and a
 * metric datum both carry the workflow id. Startup, shutdown, route errors and
 * the orphan-schedule metric happen outside any workflow, so they publish under
 * this scope rather than under a fabricated workflow id that a dashboard would
 * read as real. The Runner gets its own adapter from `createTelemetry`.
 */
export const HOST_TELEMETRY_SCOPE = 'host';

/**
 * The six client factories, injectable as a group.
 *
 * Production passes nothing and gets `PRODUCTION_HOST_FACTORIES`. The seam
 * exists so composition can be exercised without AWS credentials: every entry
 * has the same signature as the module-level factory it defaults to.
 */
export interface HostFactories {
  createDocumentTableClient(options: DocumentTableClientOptions): DocumentTableClient;
  createMonitorBackend(options: MonitorBackendOptions): MonitorBackend;
  createSecretsBackend(options: SecretsBackendOptions): SecretsBackend;
  createSchedulerBackend(options: SchedulerBackendOptions): SchedulerBackend;
  createMetricPublisher(options: MetricPublisherOptions): MetricPublisher;
  createStdoutLogWriter(options?: StdoutLogWriterOptions): LogWriter;
}

/** The real AWS clients, one per capability owner in `aws/capability-map.json`. */
export const PRODUCTION_HOST_FACTORIES: HostFactories = Object.freeze({
  createDocumentTableClient,
  createMonitorBackend,
  createSecretsBackend,
  createSchedulerBackend,
  createMetricPublisher,
  createStdoutLogWriter,
});

export interface ComposeHostOptions {
  /** Client factories to use instead of the production ones, entry by entry. */
  factories?: Partial<HostFactories>;
  /** Clock for TTL exclusion and state expiry. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The App_CMK key id applied to a Secret_Store entry this process has to
   * create. Absent leaves a created entry on the account default key.
   */
  appCmkKeyId?: string;
}

/**
 * The composed Host_Adapter and the pieces the Server_Entry wires around it.
 *
 * `capabilities` is what `assertContractComplete` validates. Everything else is
 * exposed because `server/index.ts` needs the concrete adapters for the route
 * handlers, the frame drain and the shutdown path, and building them twice would
 * mean two DynamoDB clients and two lease registries.
 */
export interface ComposedHost {
  /** The ten-key capability record, frozen. */
  readonly capabilities: HostAdapter;
  /** The resolved environment this host was composed from. */
  readonly env: ServerEnv;

  /** Run_Table access, shared by the run table adapter and the monitor backend. */
  readonly table: DocumentTableClient;
  readonly tableName: string;

  /** The Run_Table adapter: spec, journal, run history, lease and the purge path. */
  readonly runTable: RunTableAdapter;
  readonly specStore: SpecStore;
  readonly journalStore: JournalStore;
  readonly runHistory: RunHistoryStore;
  readonly runEvents: RunEventStore;
  readonly usageLedger: UsageLedgerStore;
  readonly leaseStore: LeaseStore;

  readonly monitor: MonitorAdapter;
  readonly secrets: SecretsAdapter;
  readonly scheduler: SchedulerAdapter;

  /** Host-lifecycle telemetry, scoped to `HOST_TELEMETRY_SCOPE`. */
  readonly telemetry: TelemetryAdapter;
  readonly logWriter: LogWriter;
  readonly metricPublisher: MetricPublisher;
  /** The one Redactor instance every secret value is seeded into. */
  readonly redactor: Redactor;

  /**
   * Connection metadata, keyed by connection id. Mutable and owned by the host:
   * the spec-push route replaces its contents, and `SecretsAdapter` reads it on
   * every resolve, so both sides see one inventory.
   */
  readonly connections: Map<string, Connection>;
  /** Provider key secret names, keyed by provider id. Mutable for the same reason. */
  readonly providerKeys: Map<string, string>;

  /** A `WorkflowStateStore` bound to one workflow id. */
  createStateStore(workflowId: string): WorkflowStateStore;
  /** A `TelemetryAdapter` bound to one workflow id, for the Runner. */
  createTelemetry(workflowId: string): TelemetryAdapter;
}

/**
 * Build the production Host_Adapter and assert it is complete.
 *
 * Every AWS client is constructed here, which is the first point at which
 * credentials are resolved. The last statement is `assertContractComplete`, so
 * an incomplete adapter never escapes this function.
 *
 * @param env - The resolved task-definition environment from `readServerEnv`.
 * @throws IncompleteContractError naming every unimplemented capability.
 */
export function composeHostAdapter(env: ServerEnv, options: ComposeHostOptions = {}): ComposedHost {
  const factories: HostFactories = { ...PRODUCTION_HOST_FACTORIES, ...options.factories };
  const now = options.now ?? Date.now;

  // --- Run_Table -----------------------------------------------------------
  const table = factories.createDocumentTableClient({
    region: env.region,
    tableName: env.runTableName,
  });

  // Read-time TTL exclusion: DynamoDB removal is best-effort and can lag, so an
  // expired item is filtered before it can be served (Req 4.8).
  const retentionExclude = (item: Item): boolean => isExpired(item as { ttl?: number }, now());
  const runTable = new RunTableAdapter(table, env.runTableName, retentionExclude);

  // --- Telemetry -----------------------------------------------------------
  // Built before the scheduler, which publishes the orphan-schedule metric.
  const logWriter = factories.createStdoutLogWriter();
  const metricPublisher = factories.createMetricPublisher({
    region: env.region,
    namespace: env.metricNamespace,
  });
  // One Redactor for the whole process: `SecretsAdapter` seeds it on every
  // resolve, and `TelemetryAdapter` scrubs every log field and metric dimension
  // through the same instance, so a value seeded by one run cannot leak from
  // another.
  const redactor = createRedactor();
  const redact = (value: string): string => redactor.scrub(value);

  const createTelemetry = (workflowId: string): TelemetryAdapter =>
    new TelemetryAdapter({ workflowId, logWriter, metricPublisher, redact });

  const telemetry = createTelemetry(HOST_TELEMETRY_SCOPE);

  // --- Monitor -------------------------------------------------------------
  const monitor = new MonitorAdapter(
    factories.createMonitorBackend({
      region: env.region,
      endpoint: env.monitorEndpoint,
      table,
      tableName: env.runTableName,
      now,
    }),
  );

  // --- Secret_Store --------------------------------------------------------
  const connections = new Map<string, Connection>();
  const providerKeys = new Map<string, string>();
  const secrets = new SecretsAdapter(
    factories.createSecretsBackend({
      region: env.region,
      ...(options.appCmkKeyId === undefined ? {} : { appCmkKeyId: options.appCmkKeyId }),
    }),
    { prefix: env.secretPrefix, connections, providerKeys },
    redactor,
  );

  // --- Schedules -----------------------------------------------------------
  // A schedule that fires for a purged workflow is deleted rather than run, so
  // the adapter needs to ask Run_Table whether the spec is still there.
  const specPresent = async (workflowId: string): Promise<boolean> =>
    (await runTable.read(workflowId)) !== undefined;

  const scheduler = new SchedulerAdapter(
    factories.createSchedulerBackend({ region: env.region }),
    {
      groupName: env.scheduleGroup,
      target: { arn: env.scheduleTargetArn, roleArn: env.scheduleRoleArn },
    },
    telemetry,
    specPresent,
  );

  const runEvents = runTable.eventStore;
  const usageLedger = runTable.usageStore;

  const capabilities: HostAdapter = Object.freeze({
    // Seven capabilities are Run_Table access, as `aws/capability-map.json`
    // declares, so they share one adapter over one document client.
    spec: runTable,
    journal: runTable,
    runHistory: runTable,
    runEvents,
    usageLedger,
    // `WorkflowStateStore` is the one workflow-scoped capability: the engine
    // hands it a store already bound to a workflow. The live implementation is
    // therefore the binder, which is what a run resolves it through.
    workflowState: (workflowId: string) => runTable.createStateStore(workflowId, now),
    connections: secrets,
    schedules: scheduler,
    monitor,
    lease: runTable,
  } satisfies Record<RuntimeHostCapability, unknown>);

  const host: ComposedHost = {
    capabilities,
    env,
    table,
    tableName: env.runTableName,
    runTable,
    specStore: runTable,
    journalStore: runTable,
    runHistory: runTable,
    runEvents,
    usageLedger,
    leaseStore: runTable,
    monitor,
    secrets,
    scheduler,
    telemetry,
    logWriter,
    metricPublisher,
    redactor,
    connections,
    providerKeys,
    createStateStore: (workflowId) => runTable.createStateStore(workflowId, now),
    createTelemetry,
  };

  // Last, and before any caller can reach a capability (Req 7.3).
  assertContractComplete(capabilities);

  return host;
}

// ---------------------------------------------------------------------------
// Reporting and exit
// ---------------------------------------------------------------------------

/**
 * The one stream operation the failure report needs, declared locally.
 *
 * `cloud-aws` installs no `@types/node`, so `process` carries no ambient type.
 * Declaring the single member that matters keeps this module type-checked
 * without pulling a whole platform typing surface into the package, and
 * `NodeJS.WriteStream` satisfies the shape, so injecting the real stream needs
 * no cast. Same pattern as `aws/stdout-log-writer.ts`.
 */
export interface StartupErrorSink {
  write(chunk: string): unknown;
}

export interface StartHostOptions extends ComposeHostOptions {
  /** Where the failure report goes. Defaults to `process.stderr`. */
  stderr?: StartupErrorSink;
  /** How the process ends. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

interface ProcessLike {
  stderr?: StartupErrorSink;
  exit?: (code: number) => void;
}

/** Read `process` through `globalThis`, so no ambient declaration is needed. */
function currentProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

function resolveStderr(): StartupErrorSink {
  const stderr = currentProcess()?.stderr;
  if (!stderr || typeof stderr.write !== 'function') {
    throw new Error(
      'startHost needs process.stderr to report a startup failure, and this ' +
        'runtime exposes none. Pass a stderr sink explicitly when running outside Node.',
    );
  }
  return stderr;
}

function resolveExit(): (code: number) => void {
  const exit = currentProcess()?.exit;
  if (typeof exit !== 'function') {
    throw new Error(
      'startHost needs process.exit to fail startup, and this runtime exposes ' +
        'none. Pass an exit function explicitly when running outside Node.',
    );
  }
  return exit;
}

/**
 * Write the failure report: the message, then each missing capability name on
 * its own line.
 *
 * One name per line is the contract Req 7.3 asks for, and it is what makes the
 * report usable from `aws logs tail`: the operator reads the whole set at once
 * instead of fixing one capability per redeploy.
 */
export function reportIncompleteContract(
  error: IncompleteContractError,
  stderr: StartupErrorSink = resolveStderr(),
): void {
  stderr.write(`${error.message}\n`);
  for (const capability of error.missing) {
    stderr.write(`${capability}\n`);
  }
}

/**
 * Compose the Host_Adapter, or report and exit.
 *
 * This is what `server/index.ts main()` calls between `readServerEnv` and
 * `http.createServer(...)`. On an incomplete contract the report goes to stderr,
 * one capability per line, and the process exits non-zero with no listener ever
 * created, so the NLB target never reports healthy (Req 7.3).
 *
 * Any other failure - a malformed monitor endpoint, a client that cannot be
 * constructed - propagates unchanged: it is not a contract gap, and turning it
 * into one would hide it behind a capability list that is actually complete.
 *
 * The rethrow after `exit` is unreachable in production, where `process.exit`
 * does not return. It exists so an injected `exit` that returns cannot yield a
 * partially composed host to the caller.
 */
export function startHost(env: ServerEnv, options: StartHostOptions = {}): ComposedHost {
  const { stderr, exit, ...composeOptions } = options;

  try {
    return composeHostAdapter(env, composeOptions);
  } catch (error) {
    if (!(error instanceof IncompleteContractError)) throw error;

    reportIncompleteContract(error, stderr ?? resolveStderr());
    (exit ?? resolveExit())(EXIT_INCOMPLETE_CONTRACT);
    throw error;
  }
}
