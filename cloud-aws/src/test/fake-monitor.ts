/**
 * FakeMonitorBackend: an in-memory WebSocket push backend for property testing
 * the MonitorGateway implementation.
 *
 * Tracks connections by workflow id, records all posted messages, and supports
 * GoneException injection for stale connection simulation.
 *
 * Feature: aws-deployment-target
 */

import type { RunEvent } from '@phorma/engine';

import type { MonitorBackend } from '../aws/ports.js';

// ---------------------------------------------------------------------------
// Gone connection error - thrown when a connection id is stale
// ---------------------------------------------------------------------------

/**
 * Build the error a stale connection push rejects with.
 *
 * Carries `name = 'GoneException'` so `core/aws-errors.ts isGoneError` matches
 * it exactly as it matches the real API Gateway Management API error. The fake
 * exports no exception class: production code must not be able to import one
 * from a test fixture (Req 8.10, 13.1).
 */
function goneError(connectionId: string): Error {
  const error = new Error(`Connection ${connectionId} is gone`);
  error.name = 'GoneException';
  return error;
}

// ---------------------------------------------------------------------------
// MonitorBackend interface - declared once, in src/aws/ports.ts
// ---------------------------------------------------------------------------

/**
 * Re-exported for convenience. The single declaration site is
 * `src/aws/ports.ts`, so production code never imports a port type from a test
 * fixture (Req 8.2, 8.10).
 */
export type { MonitorBackend };

// ---------------------------------------------------------------------------
// FakeMonitorBackend implementation
// ---------------------------------------------------------------------------

export class FakeMonitorBackend implements MonitorBackend {
  /** Map of workflowId -> set of connection ids. */
  private readonly connections = new Map<string, Set<string>>();

  /** Set of connection ids that will throw GoneException on push. */
  private readonly goneConnections = new Set<string>();

  /** All successfully posted messages: { connectionId, data }. */
  readonly posted: Array<{ connectionId: string; data: string }> = [];

  /** All connection ids that were removed due to GoneException. */
  readonly removed: string[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Setup helpers (not part of the interface)
  // ─────────────────────────────────────────────────────────────────────────

  /** Register a connection for a workflow. */
  addConnection(workflowId: string, connectionId: string): void {
    let set = this.connections.get(workflowId);
    if (!set) {
      set = new Set();
      this.connections.set(workflowId, set);
    }
    set.add(connectionId);
  }

  /** Mark a connection as gone - it will throw GoneException on the next push. */
  markGone(connectionId: string): void {
    this.goneConnections.add(connectionId);
  }

  /** Get all workflow ids that have connections. */
  getWorkflowIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Get the current connection set for a workflow (after removals). */
  getConnections(workflowId: string): string[] {
    const set = this.connections.get(workflowId);
    return set ? [...set] : [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MonitorBackend interface
  // ─────────────────────────────────────────────────────────────────────────

  async postToConnection(connectionId: string, data: string): Promise<void> {
    if (this.goneConnections.has(connectionId)) {
      throw goneError(connectionId);
    }
    this.posted.push({ connectionId, data });
  }

  async listConnections(workflowId: string): Promise<string[]> {
    const set = this.connections.get(workflowId);
    return set ? [...set] : [];
  }

  async removeConnection(workflowId: string, connectionId: string): Promise<void> {
    this.removed.push(connectionId);
    // The real backend deletes the `conn#{connectionId}` record in the
    // `wf#{workflowId}` partition, so scope the removal the same way.
    this.connections.get(workflowId)?.delete(connectionId);
    this.goneConnections.delete(connectionId);
  }
}
