/**
 * Backend ports - the single declaration site for every interface the
 * Host_Adapter talks to.
 *
 * Each port is expressed against `@aws-sdk` input and output types where the
 * shape matters, and against plain values where it does not. Both the
 * production implementation and the test fake satisfy the same interface, so no
 * module under `src/aws/` ever names a fake type (Req 8.2).
 *
 * The imports here are type-only: this module compiles to nothing and performs
 * no I/O.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import type {
  BatchWriteCommandInput,
  BatchWriteCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type { ScheduleEntry, ScheduleTarget } from './scheduler.js';
import type { MetricDataPoint } from './telemetry.js';

// ---------------------------------------------------------------------------
// 1. Run_Table access
// ---------------------------------------------------------------------------

/**
 * Run_Table access as a document client: seven operations, and deliberately
 * no whole-table read (Req 8.6). Every read addresses a single partition key
 * through `get` or `query`.
 *
 * The production implementation is `document-table-client.ts` over
 * `DynamoDBDocumentClient`; the test fixture under `src/test/` implements the same port.
 */
export interface DocumentTableClient {
  get(input: GetCommandInput): Promise<GetCommandOutput>;
  put(input: PutCommandInput): Promise<PutCommandOutput>;
  update(input: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(input: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(input: QueryCommandInput): Promise<QueryCommandOutput>;
  batchWrite(input: BatchWriteCommandInput): Promise<BatchWriteCommandOutput>;
  transactWrite(input: TransactWriteCommandInput): Promise<TransactWriteCommandOutput>;
}

// ---------------------------------------------------------------------------
// 2. Live monitor transport
// ---------------------------------------------------------------------------

/**
 * The backend that pushes data to WebSocket connections and owns the
 * connection records.
 *
 * The production implementation is `monitor-backend.ts`: `postToConnection`
 * goes through the API Gateway Management API against
 * `PHORMA_MONITOR_ENDPOINT`, while `listConnections` and `removeConnection`
 * address the `conn#` records in one workflow partition through
 * `DocumentTableClient` (Req 8.3, 8.7).
 */
export interface MonitorBackend {
  /** Return every connection id currently authenticated for a workflow id. */
  listConnections(workflowId: string): Promise<string[]>;
  /** Send data to a single connection. Rejects with a gone error when stale. */
  postToConnection(connectionId: string, data: string): Promise<void>;
  /** Delete the connection record for a stale connection id (Req 8.7). */
  removeConnection(workflowId: string, connectionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 3. Secret_Store access
// ---------------------------------------------------------------------------

/**
 * The backend that reads and writes secret values by full entry name.
 *
 * The production implementation is `secrets-backend.ts` over Secrets Manager;
 * the test fixture under `src/test/` implements the same port.
 */
export interface SecretsBackend {
  /** Read a secret value by its full entry name. Undefined when absent. */
  get(name: string): Promise<string | undefined>;
  /** Write a secret value. Creates or overwrites. */
  put(name: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 4. Schedule management
// ---------------------------------------------------------------------------

/**
 * The backend that creates, deletes and lists schedules in the IaC-owned
 * schedule group.
 *
 * The production implementation is `scheduler-backend.ts` over EventBridge
 * Scheduler; the test fixture under `src/test/` implements the same port. Moved unchanged from
 * `scheduler.ts`, which re-exports it.
 */
export interface SchedulerBackend {
  /** Create a schedule in the given group. */
  createSchedule(
    groupName: string,
    name: string,
    cron: string,
    timezone: string,
    target: ScheduleTarget,
  ): Promise<void>;
  /** Delete a schedule from the given group. */
  deleteSchedule(groupName: string, name: string): Promise<void>;
  /**
   * List schedules in the given group whose name starts with `namePrefix`.
   *
   * The prefix is REQUIRED rather than optional. One schedule group holds every
   * workflow's schedules, so an unscoped list is only ever the first half of
   * "delete everything in this group" - which is exactly the bug this parameter
   * exists to make unrepresentable. Callers pass
   * `schedulePrefix(workflowId)` from `core/schedule-name.ts`.
   */
  listSchedules(groupName: string, namePrefix: string): Promise<ScheduleEntry[]>;
}

// ---------------------------------------------------------------------------
// 5. Telemetry writers
// ---------------------------------------------------------------------------

/**
 * The backend that writes one structured single-line log entry.
 *
 * The production implementation is `stdout-log-writer.ts`: the task definition
 * already uses the `awslogs` driver, so stdout is the log path.
 */
export interface LogWriter {
  write(line: string): Promise<void>;
}

/**
 * The backend that publishes one metric data point.
 *
 * The production implementation is `metric-publisher.ts` over CloudWatch
 * `PutMetricData` in the configured namespace (Req 8.3).
 */
export interface MetricPublisher {
  publish(metric: MetricDataPoint): Promise<void>;
}

// ---------------------------------------------------------------------------
// Capability ownership
// ---------------------------------------------------------------------------

/**
 * `./capability-map.json` names the module under `src/aws/` that owns each of
 * the ten `RUNTIME_HOST_CAPABILITIES` from `src/core/host-contract.ts`. It is a
 * flat object with exactly those ten keys and no others, so the Check_Pipeline
 * guard can assert every capability has a declared owner that reaches AWS
 * through an `@aws-sdk` client (Req 8.1).
 *
 * Six of the ten capabilities (spec, journal, runHistory, runEvents,
 * usageLedger, workflowState) plus the lease are Run_Table access, so they
 * share `document-table-client.ts`. Connections resolve through Secrets
 * Manager, schedules through EventBridge Scheduler, and the monitor through the
 * API Gateway Management API.
 */
