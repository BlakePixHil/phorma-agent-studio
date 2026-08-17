/**
 * Monitor: push RunEvents to authenticated WebSocket connections.
 *
 * PURE for testability - accepts an injected `MonitorBackend` port rather than
 * importing @aws-sdk/* directly. The runtime wires the real API Gateway
 * Management API transport; tests supply the in-memory fixture under
 * `src/test/`.
 *
 * Behaviour (Req 7.2, 7.12, 7.13, 7.14, 7.16):
 * - Push every RunEvent to every authenticated connection for the target
 *   workflow id, and to none of another workflow id.
 * - On a gone connection (`isGoneError`), discard that connection id and
 *   continue the run.
 * - Continue to a settled outcome even with zero connections open.
 * - Hold only `execute-api:ManageConnections` against the Monitor_API stage.
 *
 * Feature: aws-deployment-target
 * Requirements: 7.2, 7.12, 7.13, 7.14, 7.16
 */

import type { RunEvent } from '@phorma/engine';

import { isGoneError } from '../core/aws-errors.js';
import type { MonitorGateway } from '../core/host-contract.js';
import type { MonitorBackend } from './ports.js';

// ---------------------------------------------------------------------------
// MonitorAdapter - implements MonitorGateway (Req 7.2)
// ---------------------------------------------------------------------------

/**
 * Pushes RunEvents to every authenticated WebSocket connection for a
 * workflow id. Discards stale connections on a gone-connection error and continues
 * the run to its settled outcome regardless of how many connections are
 * open (Req 7.14, 7.16).
 */
export class MonitorAdapter implements MonitorGateway {
  private readonly backend: MonitorBackend;

  constructor(backend: MonitorBackend) {
    this.backend = backend;
  }

  /**
   * Push one RunEvent to every authenticated connection for this workflow.
   *
   * Fan out: every connection of the target workflow receives the event
   * exactly once; no connection of any other workflow receives it (Req 7.2).
   *
   * Gone-connection handling: discard the connection id, attempt no further
   * push to it, continue the run (Req 7.13).
   *
   * Zero connections: resolves successfully, the run continues (Req 7.14, 7.16).
   */
  async push(workflowId: string, event: RunEvent): Promise<void> {
    const connectionIds = await this.backend.listConnections(workflowId);

    // Zero connections is fine - continue the run (Req 7.14, 7.16)
    if (connectionIds.length === 0) {
      return;
    }

    const data = JSON.stringify(event);

    // Fan out to every connection (Req 7.2, 7.16)
    await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          await this.backend.postToConnection(connectionId, data);
        } catch (err: unknown) {
          if (isGoneError(err)) {
            // Discard stale connection, continue the run (Req 7.13, 8.7)
            await this.backend.removeConnection(workflowId, connectionId);
          }
          // Any other error is swallowed - the run must continue (Req 7.14)
        }
      }),
    );
  }
}
