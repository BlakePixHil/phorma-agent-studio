/**
 * The production `MonitorBackend`: live monitor transport over the API Gateway
 * Management API, with the connection records in the Run_Table.
 *
 * This is the owning module for the `monitor` capability, as
 * `./capability-map.json` declares. It is the only module that imports
 * `@aws-sdk/client-apigatewaymanagementapi`.
 *
 * The three port operations split across two services:
 *
 * - `postToConnection` sends to one WebSocket connection through the management
 *   client built against `PHORMA_MONITOR_ENDPOINT`. A stale connection rejects
 *   with `GoneException`, which `core/aws-errors.ts isGoneError` classifies and
 *   `monitor.ts` acts on (Req 8.7).
 * - `listConnections` reads the `conn#` records of one workflow partition
 *   through `DocumentTableClient` - a `Query` on `pk = wf#{workflowId}` with
 *   `begins_with(sk, 'conn#')`, never a Scan (Req 8.3, 8.6).
 * - `removeConnection` deletes one `conn#{connectionId}` record from that same
 *   partition, which is why it takes both ids (Req 8.7).
 *
 * Connection records carry a TTL, and DynamoDB removal is best-effort, so the
 * listing applies the shared read-time exclusion from `core/retention.ts`
 * rather than pushing to a connection whose record has already expired.
 *
 * No client is constructed at module load: the Check_Pipeline runs with no AWS
 * credentials present, so the client is built inside `createMonitorBackend`,
 * which the Server_Entry calls after `readServerEnv` succeeds.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3, 8.7
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

import { connSk, pk } from '../core/keys.js';
import { isExpired } from '../core/retention.js';
import type { DocumentTableClient, MonitorBackend } from './ports.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MonitorBackendOptions {
  /** The region the Monitor_API lives in - `AWS_REGION` on the task definition. */
  region: string;
  /**
   * The Monitor_API stage endpoint - `PHORMA_MONITOR_ENDPOINT` on the task
   * definition. A `wss://` or `ws://` value is accepted and normalised: the
   * deploy output carries the WebSocket URL clients dial, while the management
   * API is the same host and stage over HTTPS.
   */
  endpoint: string;
  /** Run_Table access for the `conn#` records. */
  table: DocumentTableClient;
  /** The Run_Table name - `PHORMA_RUN_TABLE` on the task definition. */
  tableName: string;
  /** Clock for read-time TTL exclusion. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Sort-key prefix
// ---------------------------------------------------------------------------

/**
 * The sort-key prefix every connection record shares, derived from the one key
 * function rather than restated, so `keys.ts` stays the single derivation site.
 */
const CONNECTION_SK_PREFIX = connSk('');

// ---------------------------------------------------------------------------
// Endpoint normalisation
// ---------------------------------------------------------------------------

/**
 * Translate a Monitor_API endpoint into the management API endpoint.
 *
 * `wss://` becomes `https://` and `ws://` becomes `http://`; anything else is
 * returned unchanged. Pure, and exported so the mapping is covered by a test
 * that needs no client.
 */
export function managementEndpoint(endpoint: string): string {
  if (endpoint.startsWith('wss://')) return `https://${endpoint.slice('wss://'.length)}`;
  if (endpoint.startsWith('ws://')) return `http://${endpoint.slice('ws://'.length)}`;
  return endpoint;
}

// ---------------------------------------------------------------------------
// Connection id extraction
// ---------------------------------------------------------------------------

/**
 * Read the connection id off a stored connection record.
 *
 * The `$connect` integration writes the id as its own attribute; the sort key
 * carries it too, so a record written without the attribute still resolves.
 * A record that yields neither is skipped rather than pushed to.
 */
function connectionIdOf(item: Record<string, unknown>): string | undefined {
  const attribute = item['connectionId'];
  if (typeof attribute === 'string' && attribute.length > 0) return attribute;

  const sk = item['sk'];
  if (typeof sk !== 'string' || !sk.startsWith(CONNECTION_SK_PREFIX)) return undefined;

  const derived = sk.slice(CONNECTION_SK_PREFIX.length);
  return derived.length > 0 ? derived : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `MonitorBackend` for one Monitor_API stage and one
 * Run_Table.
 *
 * Credentials come from the default provider chain, which resolves the
 * Runtime_Identity task role on Fargate. The task role holds
 * `execute-api:ManageConnections` scoped to this stage and nothing else.
 */
export function createMonitorBackend(options: MonitorBackendOptions): MonitorBackend {
  const { region, endpoint, table, tableName } = options;
  const now = options.now ?? Date.now;

  const management = new ApiGatewayManagementApiClient({
    region,
    endpoint: managementEndpoint(endpoint),
  });

  const encoder = new TextEncoder();

  return {
    /**
     * Every connection id authenticated for this workflow, walking every page
     * of the one partition read and dropping records whose TTL has passed.
     */
    async listConnections(workflowId: string): Promise<string[]> {
      const partition = pk(workflowId);
      const nowMs = now();
      const connectionIds: string[] = [];
      let startKey: Record<string, unknown> | undefined;

      do {
        const page = await table.query({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: { ':pk': partition, ':prefix': CONNECTION_SK_PREFIX },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        });

        for (const item of page.Items ?? []) {
          const record = item as Record<string, unknown>;
          if (isExpired(record as { ttl?: number }, nowMs)) continue;
          const connectionId = connectionIdOf(record);
          if (connectionId !== undefined) connectionIds.push(connectionId);
        }

        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);

      return connectionIds;
    },

    /**
     * Send one already-serialised payload to one connection. Rejects with the
     * SDK's `GoneException` when the connection has gone away - the caller
     * classifies it, this module does not.
     */
    async postToConnection(connectionId: string, data: string): Promise<void> {
      await management.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: encoder.encode(data),
        }),
      );
    },

    /** Delete one connection record from its workflow partition (Req 8.7). */
    async removeConnection(workflowId: string, connectionId: string): Promise<void> {
      await table.delete({
        TableName: tableName,
        Key: { pk: pk(workflowId), sk: connSk(connectionId) },
      });
    },
  };
}
