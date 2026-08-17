/**
 * FakeSecretsManager - in-memory secrets backend for property testing.
 *
 * Mirrors the FakeRunTable pattern: a simple in-memory store with per-request
 * failure injection and an inspectable request log.
 *
 * Feature: aws-deployment-target
 * Requirements: 8.1, 8.14
 */

import type { SecretsBackend } from '../aws/secrets.js';

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

export interface SecretsRequestLogEntry {
  operation: 'get' | 'put';
  name: string;
}

// ---------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------

/**
 * A callback invoked before each operation. If it throws, the operation is
 * aborted and the error propagates to the caller.
 */
export type SecretsFailureInjector = (operation: 'get' | 'put', name: string) => void;

// ---------------------------------------------------------------------------
// FakeSecretsManager
// ---------------------------------------------------------------------------

export class FakeSecretsManager implements SecretsBackend {
  /** In-memory store: name -> value. */
  private readonly store = new Map<string, string>();

  /** Recorded request log for assertions. */
  readonly log: SecretsRequestLogEntry[] = [];

  /** Per-request failure injector. */
  private injector: SecretsFailureInjector | undefined;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Set the failure injector. Pass undefined to clear. */
  setFailureInjector(injector: SecretsFailureInjector | undefined): void {
    this.injector = injector;
  }

  /** Reset the store and logs. */
  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.injector = undefined;
  }

  /** Seed a secret value directly (bypasses logging and injection). */
  seed(name: string, value: string): void {
    this.store.set(name, value);
  }

  /** Check if a secret exists (for assertions). */
  has(name: string): boolean {
    return this.store.has(name);
  }

  /** Get a secret value directly (for assertions, bypasses logging). */
  peek(name: string): string | undefined {
    return this.store.get(name);
  }

  /** Number of entries in the store (for assertions). */
  get size(): number {
    return this.store.size;
  }

  // -------------------------------------------------------------------------
  // SecretsBackend implementation
  // -------------------------------------------------------------------------

  async get(name: string): Promise<string | undefined> {
    this.log.push({ operation: 'get', name });
    if (this.injector) this.injector('get', name);
    return this.store.get(name);
  }

  async put(name: string, value: string): Promise<void> {
    this.log.push({ operation: 'put', name });
    if (this.injector) this.injector('put', name);
    this.store.set(name, value);
  }
}
