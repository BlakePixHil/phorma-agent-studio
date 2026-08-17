/**
 * Deploy target registry - a leaf module with pure data and functions.
 *
 * No `inject`, no service dependency, following `core/phorma-cloud-url.ts`.
 * This placement avoids the DI cycle hazard: `CloudService` legitimately
 * injects `RunControllerService`, so anything that CloudService reads must
 * not itself import CloudService.
 *
 * Each target carries its own route table (`endpoints`), so a request shape is
 * declared once here rather than spelled out at a call site. `CloudService`
 * resolves an operation to a spec, builds the URL from `instanceUrl` or the
 * base, and dispatches through the `CloudTransport` seam - which means adding a
 * host is a route table, not a second copy of every method.
 *
 * Feature: aws-byo-deploy
 * Requirements: 12.4, 12.6
 */

import {
  AWS_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  type HostCapabilities,
  type ConnectionSecretScheme,
} from '@phorma/engine';

import type { HttpMethod } from './cloud-transport';

// Re-export for consumers.
export type DeployTargetId = 'phorma' | 'cloudflare' | 'aws';

export interface DeployCommand {
  program: 'npx';
  args: string[];
  cwd: string;
}

export interface DeployContext {
  cloudFolder: string;
  workflowId: string;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// The endpoint registry
// ---------------------------------------------------------------------------

/**
 * Every logical operation the Studio performs against a deployed runtime.
 *
 * Logical, not per-host: `push-spec` names the intent, and each target decides
 * which route serves it. A target that has no route for an operation simply
 * declares none, and the dispatcher resolves it to that operation's documented
 * absent value (Requirement 12.6) rather than inventing a route.
 */
export type CloudOperation =
  | 'push-spec'
  | 'push-connections'
  | 'read-connections'
  | 'trigger'
  | 'purge'
  | 'status'
  | 'run-history'
  | 'run-detail'
  | 'usage'
  | 'put-secret'
  | 'list-secret-names';

/**
 * Everything an endpoint may need to build its path.
 *
 * Identity lives here and nowhere else, so a `body` reshaper never has to
 * re-derive an id the path already knows. The logical payload carries only the
 * data being written.
 */
export interface CloudEndpointContext {
  workflowId: string;
  runId?: string;
  connectionId?: string;
  secretKey?: string;
  since?: string;
  continuationToken?: string;
}

/** Logical payload for `push-spec`: the spec plus its connection metadata. */
export interface SpecPushPayload {
  spec: unknown;
  /** `ConnectionSummary` metadata, never a secret value. */
  connections?: readonly unknown[];
}

/** Logical payload for `push-connections`. */
export interface ConnectionsPushPayload {
  connections: readonly unknown[];
}

/** Logical payload for `trigger`. */
export interface TriggerPayload {
  input: string;
  source?: string;
}

/**
 * Logical payload for `put-secret`. The connection id and secret key travel in
 * the {@link CloudEndpointContext}, so the payload is the value alone.
 */
export interface SecretWritePayload {
  value: string;
}

export interface CloudEndpointSpec {
  method: HttpMethod;
  /** 'instance' resolves against instanceUrl(base, id); 'root' against the base. */
  scope: 'instance' | 'root';
  path(ctx: CloudEndpointContext): string;
  /** Reshapes the logical payload for this host. */
  body?(payload: unknown, ctx: CloudEndpointContext): unknown;
  /** Normalizes this host's response body into the shape the Studio consumes. */
  unwrap?(parsed: unknown): unknown;
}

/**
 * One target's route table. Partial by design: an absent operation is a
 * first-class state, not a gap (Requirement 12.6).
 */
export type CloudEndpoints = Readonly<Partial<Record<CloudOperation, CloudEndpointSpec>>>;

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  /** The record design-time and push-time validation runs against. */
  capabilities: HostCapabilities;
  connectionSecretScheme: ConnectionSecretScheme;
  desktopOnly: boolean;
  /** This target's route table - the only place a request shape is declared. */
  endpoints: CloudEndpoints;
  /** Absent for targets with no plan step; present for `aws`. */
  planCommand?(ctx: DeployContext): DeployCommand | null;
  deployCommand(ctx: DeployContext): DeployCommand | null;
  /** The ONLY place a deployed-instance URL is shaped. */
  instanceUrl(base: string, workflowId: string): string;
}

// ---------------------------------------------------------------------------
// Reading helpers for the endpoint records
// ---------------------------------------------------------------------------

/** A plain JSON object, or undefined for anything else (including an array). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** One field read as an array, or undefined. */
function arrayField(value: unknown, key: string): unknown[] | undefined {
  const field = asRecord(value)?.[key];
  return Array.isArray(field) ? field : undefined;
}

/** One field read as a string, or undefined when absent or another type. */
function stringField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === 'string' ? field : undefined;
}

/** The `items` page of a `PaginatedResult`, or an empty list. */
function pageItems(parsed: unknown): unknown[] {
  return arrayField(parsed, 'items') ?? [];
}

/** A query string from name/value pairs, skipping absent values. */
function query(pairs: readonly (readonly [string, string | undefined])[]): string {
  const parts = pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The oldest usage window the AWS host accepts - it requires ISO 8601. */
const EPOCH_ISO = new Date(0).toISOString();

// ---------------------------------------------------------------------------
// Cloudflare route table (Phorma Cloud and BYO Cloudflare)
// ---------------------------------------------------------------------------

/**
 * The Worker_Host routes exactly as they exist today.
 *
 * Instance-scoped paths hang off `{base}/agents/workflow-agent/{id}`; the
 * connection-secret vault is root-scoped because it belongs to the deployment
 * (or the tenant), not to one workflow instance.
 */
const CLOUDFLARE_ENDPOINTS: CloudEndpoints = {
  'push-spec': {
    method: 'POST',
    scope: 'instance',
    path: () => '/workflow',
    // The Worker_Host takes the spec as the entire body. Connection metadata
    // travels on its own route, so the rest of {@link SpecPushPayload} is
    // dropped here.
    body: (payload) => asRecord(payload)?.['spec'],
  },
  'push-connections': {
    method: 'POST',
    scope: 'instance',
    path: () => '/connections',
    // {@link ConnectionsPushPayload}, re-wrapped as the route expects it.
    body: (payload) => ({ connections: arrayField(payload, 'connections') ?? [] }),
  },
  'read-connections': {
    method: 'GET',
    scope: 'instance',
    path: () => '/connections',
    unwrap: (parsed) => arrayField(parsed, 'connections') ?? [],
  },
  trigger: {
    method: 'POST',
    scope: 'instance',
    path: () => '/trigger',
    // {@link TriggerPayload}. `source` is omitted rather than defaulted, which
    // is what the Worker_Host reads as a manual trigger.
    body: (payload) => {
      const source = stringField(payload, 'source');
      return { input: stringField(payload, 'input') ?? '', ...(source ? { source } : {}) };
    },
  },
  purge: {
    method: 'DELETE',
    scope: 'instance',
    path: () => '/workflow/purge',
  },
  status: {
    method: 'GET',
    scope: 'instance',
    path: () => '/status',
    // `hasWorkflow` is normalized to a strict boolean and `savedAt` to a
    // nullable string, so a partial body can never read as "deployed".
    unwrap: (parsed) => ({
      hasWorkflow: asRecord(parsed)?.['hasWorkflow'] === true,
      savedAt: stringField(parsed, 'savedAt') ?? null,
    }),
  },
  'run-history': {
    method: 'GET',
    scope: 'instance',
    path: () => '/runs',
  },
  'run-detail': {
    method: 'GET',
    scope: 'instance',
    path: (ctx) => `/runs/${encodeURIComponent(ctx.runId ?? '')}`,
  },
  usage: {
    method: 'GET',
    scope: 'instance',
    // The Worker_Host reads `since` as epoch milliseconds, defaulting to 0.
    path: (ctx) => `/usage${query([['since', ctx.since ?? '0']])}`,
    unwrap: (parsed) => arrayField(parsed, 'usage') ?? [],
  },
  'put-secret': {
    method: 'POST',
    scope: 'root',
    path: () => '/api/connection-secrets',
    // The vault route takes the identity in the body, so it is read back out of
    // the context and joined with the {@link SecretWritePayload} value.
    body: (payload, ctx) => ({
      connectionId: ctx.connectionId ?? '',
      secretKey: ctx.secretKey ?? '',
      value: stringField(payload, 'value') ?? '',
    }),
  },
  'list-secret-names': {
    method: 'GET',
    scope: 'root',
    path: () => '/api/connection-secrets',
    // Names only - there is no route that returns a value, by construction.
    unwrap: (parsed) =>
      (arrayField(parsed, 'secrets') ?? [])
        .map((entry) => stringField(entry, 'name'))
        .filter((name): name is string => name !== undefined),
  },
};

// ---------------------------------------------------------------------------
// AWS route table (the eight Trigger_Routes)
// ---------------------------------------------------------------------------

/**
 * The eight Trigger_Routes, and only those eight.
 *
 * They mirror `TRIGGER_ROUTES` in `cloud-aws/src/core/route-table.ts`, which is
 * the server's own router. Instance-scoped paths hang off
 * `{base}/workflows/{id}`, which is why `purge` declares an empty path: it
 * addresses the instance itself (`DELETE /workflows/{id}`).
 *
 * Two operations are deliberately ABSENT rather than mapped onto a ninth route
 * that does not exist:
 *
 * - `status` - the AWS host has no status route. `deployedStatus` stays `null`,
 *   which the existing contract already reads as "unknown", never as "not
 *   deployed".
 * - `list-secret-names` - Secrets Manager entries are written, never listed
 *   back. `connectionSecretNames()` answers `[]`.
 *
 * `push-connections` is absent too, but for a different reason: it is FOLDED
 * into `push-spec`, whose body carries `{ workflowId, spec, connections }` -
 * exactly the three fields `handleSpecPush` reads. One request, so a spec can
 * never be validated against a connection inventory it did not arrive with.
 */
const AWS_ENDPOINTS: CloudEndpoints = {
  // Trigger_Route `spec-push`: POST /workflows/{id}/spec
  'push-spec': {
    method: 'POST',
    scope: 'instance',
    path: () => '/spec',
    body: (payload, ctx) => ({
      // The server takes the path parameter as authoritative; sending the id
      // as well keeps the body self-describing in a log or a replay.
      workflowId: ctx.workflowId,
      spec: asRecord(payload)?.['spec'] ?? null,
      connections: arrayField(payload, 'connections') ?? [],
    }),
  },
  // Trigger_Route `connections`: GET /workflows/{id}/connections
  'read-connections': {
    method: 'GET',
    scope: 'instance',
    path: () => '/connections',
    unwrap: (parsed) => arrayField(parsed, 'connections') ?? [],
  },
  // Trigger_Route `trigger`: POST /workflows/{id}/trigger
  trigger: {
    method: 'POST',
    scope: 'instance',
    path: () => '/trigger',
    // The AWS host requires the caller to mint the run id, and defaults the
    // source to 'manual' when none is given.
    body: (payload, ctx) => ({
      runId: ctx.runId ?? '',
      input: stringField(payload, 'input') ?? '',
      source: stringField(payload, 'source') ?? 'manual',
    }),
    // A 202 carries `{ workflowId, runId, lease }`; the Studio consumes the
    // Worker_Host shape, so the lease is dropped here.
    unwrap: (parsed) => ({ ok: true, runId: stringField(parsed, 'runId') ?? '' }),
  },
  // Trigger_Route `purge`: DELETE /workflows/{id}
  purge: {
    method: 'DELETE',
    scope: 'instance',
    path: () => '',
  },
  // Trigger_Route `run-history`: GET /workflows/{id}/runs
  'run-history': {
    method: 'GET',
    scope: 'instance',
    path: (ctx) => `/runs${query([['continuationToken', ctx.continuationToken]])}`,
    // A paginated page of summaries. The AWS host tracks no "active run" on
    // this route, so the field the Studio reads is explicitly null (unknown).
    unwrap: (parsed) => ({ runs: pageItems(parsed), activeRunId: null }),
  },
  // Trigger_Route `run-detail`: GET /workflows/{id}/runs/{runId}
  'run-detail': {
    method: 'GET',
    scope: 'instance',
    path: (ctx) =>
      `/runs/${encodeURIComponent(ctx.runId ?? '')}` +
      query([['continuationToken', ctx.continuationToken]]),
    // `{ record, events }` collapses into the RunRecord the Studio consumes,
    // with the paginated event page winning when it carries anything.
    unwrap: (parsed) => {
      const record = asRecord(asRecord(parsed)?.['record']);
      if (!record) return null;
      const events = pageItems(asRecord(parsed)?.['events']);
      return events.length > 0 ? { ...record, events } : record;
    },
  },
  // Trigger_Route `usage`: GET /workflows/{id}/usage
  usage: {
    method: 'GET',
    scope: 'instance',
    // This host validates `since` as ISO 8601 and rejects anything else, so an
    // absent window becomes the epoch rather than the Worker_Host's `0`.
    path: (ctx) =>
      `/usage${query([
        ['since', ctx.since ?? EPOCH_ISO],
        ['continuationToken', ctx.continuationToken],
      ])}`,
    unwrap: (parsed) => pageItems(parsed),
  },
  // Trigger_Route `secret-write`: PUT /connections/{connId}/secrets/{key}
  'put-secret': {
    method: 'PUT',
    scope: 'root',
    path: (ctx) =>
      `/connections/${encodeURIComponent(ctx.connectionId ?? '')}` +
      `/secrets/${encodeURIComponent(ctx.secretKey ?? '')}`,
    // Identity is in the path, so the body is the value alone.
    body: (payload) => ({ value: stringField(payload, 'value') ?? '' }),
  },
};

/**
 * Authentication failure exit code from `phorma-aws doctor`.
 * Used by AwsCliService to map exit codes to actionable messages.
 */
export const AWS_AUTH_FAILURE_EXIT_CODE = 4;

/**
 * Every known deploy target. `phorma` and `cloudflare` both run on the
 * Cloudflare Worker host (Phorma Cloud IS a managed Worker). `aws` runs on
 * the ECS Fargate host with `AWS_CAPABILITIES`.
 */
export const DEPLOY_TARGETS: Readonly<Record<DeployTargetId, DeployTarget>> = {
  phorma: {
    id: 'phorma',
    label: 'Phorma Cloud',
    capabilities: CLOUDFLARE_CAPABILITIES,
    connectionSecretScheme: 'cloudflare-worker-env',
    desktopOnly: false,
    endpoints: CLOUDFLARE_ENDPOINTS,
    deployCommand: () => null,
    instanceUrl: (base, workflowId) => `${base}/agents/workflow-agent/${workflowId}`,
  },
  cloudflare: {
    id: 'cloudflare',
    label: 'Cloudflare (BYO)',
    capabilities: CLOUDFLARE_CAPABILITIES,
    connectionSecretScheme: 'cloudflare-worker-env',
    desktopOnly: true,
    endpoints: CLOUDFLARE_ENDPOINTS,
    deployCommand: (ctx) => ({
      program: 'npx',
      args: ['wrangler', 'deploy'],
      cwd: ctx.cloudFolder,
    }),
    instanceUrl: (base, workflowId) => `${base}/agents/workflow-agent/${workflowId}`,
  },
  aws: {
    id: 'aws',
    label: 'AWS (ECS Fargate)',
    capabilities: AWS_CAPABILITIES,
    connectionSecretScheme: 'aws-secrets-manager',
    desktopOnly: true,
    endpoints: AWS_ENDPOINTS,
    planCommand: (ctx) => ({
      program: 'npx',
      args: ['phorma-aws', 'plan'],
      cwd: ctx.cloudFolder,
    }),
    deployCommand: (ctx) => ({
      program: 'npx',
      args: ['phorma-aws', 'deploy'],
      cwd: ctx.cloudFolder,
    }),
    instanceUrl: (base, workflowId) => `${base}/workflows/${workflowId}`,
  },
};
