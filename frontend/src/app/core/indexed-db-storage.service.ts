import { Injectable } from '@angular/core';

import type { WorkflowSpec } from './workflow.model';

const DB_NAME = 'phorma-agent-studio-db';
const DB_VERSION = 1;

/** Object store holding saved {@link WorkflowSpec} documents (keyPath `id`). */
const WORKFLOWS_STORE = 'workflows';

/**
 * IndexedDB-backed persistence for workflow documents.
 *
 * IndexedDB is used (rather than localStorage) because workflow graphs can
 * grow well past the ~5MB localStorage budget and IDB writes are async, so
 * saves never jank the canvas.
 */
@Injectable({ providedIn: 'root' })
export class IndexedDbStorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  async listWorkflows(): Promise<WorkflowSpec[]> {
    const db = await this.open();
    return this.request<WorkflowSpec[]>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).getAll(),
    );
  }

  async getWorkflow(id: string): Promise<WorkflowSpec | undefined> {
    const db = await this.open();
    return this.request<WorkflowSpec | undefined>(
      db.transaction(WORKFLOWS_STORE, 'readonly').objectStore(WORKFLOWS_STORE).get(id),
    );
  }

  async saveWorkflow(spec: WorkflowSpec): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(WORKFLOWS_STORE, 'readwrite').objectStore(WORKFLOWS_STORE).put(spec),
    );
  }

  async removeWorkflow(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(WORKFLOWS_STORE, 'readwrite').objectStore(WORKFLOWS_STORE).delete(id),
    );
  }

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WORKFLOWS_STORE)) {
          db.createObjectStore(WORKFLOWS_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
    });
    return this.dbPromise;
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
    });
  }
}
