import { Injectable, inject, signal } from '@angular/core';

import type { Connection, ConnectionAuth, ConnectionType, SqlLimits } from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { WorkflowService } from './workflow.service';
import type { EmbeddedWorkflow, WorkflowGraph, WorkflowSpec } from './workflow.model';

/**
 * `ConnectionsService` — CRUD over Connection METADATA (design §7.1;
 * Requirements 2.1, 2.2, 19.5, 19.6, 19.7, 19.8, 19.9).
 *
 * Deliberately separate from {@link ConnectionStoreService}: that service
 * RESOLVES a connection (metadata + secret values) for a running node. This
 * service is the authoring-time counterpart the connection editor talks to —
 * it owns the global IndexedDB `connections` store (Requirement 3.4) and
 * delegates every secret write/removal to `ConnectionStoreService`, which is
 * the only code in the app that knows the keychain entry naming scheme.
 *
 * A secret VALUE never passes through this service on its way to storage in
 * either direction: {@link writeSecret} hands the value straight to
 * `ConnectionStoreService.writeSecret` and only ever persists a metadata
 * patch recording that the key NAME now exists.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionsService {
  private readonly storage = inject(IndexedDbStorageService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly workflow = inject(WorkflowService);

  private readonly connectionsState = signal<Connection[]>([]);

  /** Every stored Connection, most recently updated first. Secret-free. */
  readonly connections = this.connectionsState.asReadonly();

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.connectionsState.set(await this.storage.listConnections());
    } catch {
      // The connection library must never break the studio - unreadable lists empty.
      this.connectionsState.set([]);
    }
  }

  /**
   * Requirement 19.8: whether the active host can hold a connection secret at
   * all. Mirrors `ConnectionStoreService.resolve`'s desktop-only gate, so the
   * editor disables secret entry rather than let a write silently go nowhere.
   */
  get secretsSupported(): boolean {
    return this.connectionStore.secretsSupported;
  }

  /**
   * Requirement 2.9 support: whether one declared secret is present in the
   * keychain, without ever reading its value.
   */
  async secretPresent(connectionId: string, secretKey: string): Promise<boolean> {
    return this.connectionStore.secretPresent(connectionId, secretKey);
  }

  /**
   * Requirement 19.5: creates a Connection with a fresh `conn-` id. Rejects a
   * name outside 1-100 characters before anything is written.
   */
  async create(seed: {
    name: string;
    type: ConnectionType;
    config?: Record<string, string>;
    secretKeys?: string[];
    auth?: ConnectionAuth;
    allowWrites?: boolean;
    limits?: SqlLimits;
  }): Promise<Connection> {
    assertConnectionName(seed.name);
    const now = new Date().toISOString();
    const connection: Connection = {
      id: newConnectionId(),
      name: seed.name.trim(),
      type: seed.type,
      config: seed.config ?? {},
      secretKeys: dedupe(seed.secretKeys ?? []),
      auth: seed.auth ?? { mode: 'none' },
      ...(seed.allowWrites ? { allowWrites: true } : {}),
      ...(seed.limits ? { limits: seed.limits } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.saveConnection(connection);
    await this.refresh();
    return connection;
  }

  /**
   * Requirement 19.5: renames a Connection to a name of 1-100 characters.
   * Throws (retaining the caller's entered text and leaving the stored
   * Connection unchanged) when the name is out of range.
   */
  async rename(id: string, name: string): Promise<Connection> {
    assertConnectionName(name);
    return this.update(id, { name: name.trim() });
  }

  /**
   * Upserts non-secret fields — name, type, config, auth, allowWrites, limits
   * and the `secretKeys` NAME list. Never accepts a secret value; there is no
   * parameter for one.
   */
  async update(
    id: string,
    patch: Partial<Omit<Connection, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Connection> {
    const current = await this.require(id);
    if (patch.name !== undefined) assertConnectionName(patch.name);
    const next: Connection = {
      ...current,
      ...patch,
      name: (patch.name ?? current.name).trim(),
      updatedAt: new Date().toISOString(),
    };
    await this.storage.saveConnection(next);
    await this.refresh();
    return next;
  }

  /**
   * Requirements 19.6, 2.2: every saved workflow whose graph — at the top
   * level or inside an embedded sub-workflow — or notification channel
   * references this connection id. The delete confirmation lists these
   * (id and name) before anything is removed.
   */
  referencingWorkflows(connectionId: string): { id: string; name: string }[] {
    return this.workflow
      .library()
      .filter(spec => specReferencesConnection(spec, connectionId))
      .map(spec => ({ id: spec.id, name: spec.name }));
  }

  /**
   * Requirement 19.7: writes a secret value directly to the host secret
   * store. Never persists the value in Connection metadata or `WorkflowSpec`
   * — only the key NAME is recorded, and only once the write itself has
   * succeeded, so a failed write (Requirement 19.9) leaves metadata
   * untouched.
   */
  async writeSecret(connectionId: string, secretKey: string, value: string): Promise<void> {
    const connection = await this.require(connectionId);
    await this.connectionStore.writeSecret(connectionId, secretKey, value);
    if (!connection.secretKeys.includes(secretKey)) {
      await this.update(connectionId, { secretKeys: [...connection.secretKeys, secretKey] });
    }
  }

  /**
   * Removes one secret entry from the host store. Leaves `secretKeys`
   * unchanged — dropping a name the connection still declares would make the
   * next resolution fail loudly instead of silently, which is the safer
   * failure mode (Requirement 2.3). Used internally by {@link remove} when
   * deleting the whole connection.
   */
  async clearSecret(connectionId: string, secretKey: string): Promise<void> {
    await this.connectionStore.clearSecret(connectionId, secretKey);
  }

  /**
   * Requirement 19.9: removes one secret entry the editor no longer wants
   * declared — clears the host value FIRST, and drops the name from
   * `secretKeys` only once that clear has succeeded. A failed clear leaves
   * both the stored value and the metadata untouched.
   */
  async removeSecretField(connectionId: string, secretKey: string): Promise<void> {
    const connection = await this.require(connectionId);
    await this.connectionStore.clearSecret(connectionId, secretKey);
    if (connection.secretKeys.includes(secretKey)) {
      await this.update(connectionId, {
        secretKeys: connection.secretKeys.filter(key => key !== secretKey),
      });
    }
  }

  /**
   * Requirement 19.6: removes the Connection metadata together with every
   * secret entry named by its `secretKeys`. Callers confirm with the caller
   * first (via {@link referencingWorkflowIds}); every declared secret is
   * cleared BEFORE metadata is removed, so a keychain failure partway through
   * leaves the Connection in place rather than deleting metadata a secret
   * removal never finished.
   */
  async remove(id: string): Promise<void> {
    const connection = this.connectionsState().find(item => item.id === id) ??
      (await this.storage.getConnection(id));
    if (!connection) return;

    if (this.secretsSupported) {
      for (const key of connection.secretKeys) {
        try {
          await this.connectionStore.clearSecret(id, key);
        } catch (error) {
          throw new Error(
            `Could not remove the secret "${key}" for connection "${connection.name}" (${id}): ` +
              `${error instanceof Error ? error.message : String(error)}. The connection was not deleted.`,
          );
        }
      }
    }
    await this.storage.removeConnection(id);
    await this.refresh();
  }

  private async require(id: string): Promise<Connection> {
    const cached = this.connectionsState().find(item => item.id === id);
    if (cached) return cached;
    const stored = await this.storage.getConnection(id);
    if (!stored) throw new Error(`Connection "${id}" was not found.`);
    return stored;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Mints a fresh connection id matching `^conn-[A-Za-z0-9_-]{1,64}$`. */
export function newConnectionId(): string {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Requirement 19.5: throws an error naming the allowed length when `name` is
 * outside 1 to 100 characters (after trimming).
 */
function assertConnectionName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new Error('Connection name must be between 1 and 100 characters.');
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** True when any node in `graph` carries the given `connectionId`. */
function graphReferencesConnection(graph: WorkflowGraph, connectionId: string): boolean {
  return graph.nodes.some(node => {
    const data = node.data as { connectionId?: string };
    return data.connectionId === connectionId;
  });
}

function embeddedReferencesConnection(
  subWorkflows: Record<string, EmbeddedWorkflow> | undefined,
  connectionId: string,
): boolean {
  if (!subWorkflows) return false;
  return Object.values(subWorkflows).some(
    embedded =>
      graphReferencesConnection(embedded.graph, connectionId) ||
      embedded.settings?.notifications?.connectionId === connectionId,
  );
}

/**
 * True when `spec` — its top-level graph, any embedded sub-workflow, or its
 * notification channel — references `connectionId`.
 */
function specReferencesConnection(spec: WorkflowSpec, connectionId: string): boolean {
  return (
    graphReferencesConnection(spec.graph, connectionId) ||
    spec.settings?.notifications?.connectionId === connectionId ||
    embeddedReferencesConnection(spec.subWorkflows, connectionId)
  );
}
