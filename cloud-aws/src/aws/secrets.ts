/**
 * Secret_Store: ConnectionStore + provider key resolution + write path.
 *
 * Implements the engine's `ConnectionStore` interface against the
 * `SecretsBackend` port declared in `./ports.js`. The production implementation
 * is `./secrets-backend.js` over AWS Secrets Manager; the property tests supply
 * an in-memory implementation of the same port, so nothing in this module names
 * a test fixture (Req 8.2).
 *
 * Order of operations (Req 8.1, 8.10):
 * 1. assertConnectionId
 * 2. Resolve each secretKeys name in declaration order, stopping at first absent
 * 3. Seed the Redactor with every resolved value >= 8 characters
 * 4. Return ResolvedConnection
 *
 * The module also implements:
 * - Provider key resolution and {{API_KEY}} substitution (Req 8.12)
 * - Secret_Store write path for the Trigger_API route (Req 8.15)
 *
 * Feature: aws-deployment-target
 * Requirements: 8.1, 8.9, 8.10, 8.11, 8.12, 8.14, 8.15
 */

import type { ConnectionStore, Redactor } from '@phorma/engine';
import type { Connection, ResolvedConnection } from '@phorma/engine';
import { assertConnectionId, awsSecretName } from '@phorma/engine';

import { RETRY_BUDGETS, shouldRetry } from '../core/retry.js';
import { utf8ByteLength } from '../core/events.js';
import type { SecretsBackend } from './ports.js';

// ---------------------------------------------------------------------------
// Secrets backend port
// ---------------------------------------------------------------------------

/**
 * `SecretsBackend` is declared once, in `./ports.js`. It is re-exported here so
 * existing importers keep resolving, while the port has a single declaration
 * site (Req 8.2).
 */
export type { SecretsBackend };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SecretsConfig {
  /** The IaC-owned name prefix for Secrets Manager entries. */
  prefix: string;
  /** Connection metadata indexed by connectionId. */
  connections: ReadonlyMap<string, Connection>;
  /** Provider key secret names, keyed by provider id. */
  providerKeys?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time for a resolve call (Req 8.1: 10 seconds). */
const RESOLVE_TIMEOUT_MS = 10_000;

/** Minimum secret length to seed the Redactor (Req 8.11). */
const MIN_REDACT_LEN = 8;

/** Maximum secret value size for the write path (Req 8.15: 64 KB). */
const MAX_SECRET_VALUE_BYTES = 64 * 1024;

/** The placeholder the engine uses for provider keys. */
const API_KEY_PLACEHOLDER = '{{API_KEY}}';

// ---------------------------------------------------------------------------
// SecretsAdapter
// ---------------------------------------------------------------------------

/**
 * Implements the engine's `ConnectionStore` plus the provider key resolution
 * and the Secret_Store write path.
 */
export class SecretsAdapter implements ConnectionStore {
  private readonly backend: SecretsBackend;
  private readonly config: SecretsConfig;
  private readonly redactor: Redactor;

  /** Resolved provider keys cached for the lifetime of this adapter. */
  private readonly providerKeyCache = new Map<string, string | undefined>();

  constructor(backend: SecretsBackend, config: SecretsConfig, redactor: Redactor) {
    this.backend = backend;
    this.config = config;
    this.redactor = redactor;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ConnectionStore.resolve (Req 8.1, 8.10, 8.11)
  // ─────────────────────────────────────────────────────────────────────────

  async resolve(connectionId: string): Promise<ResolvedConnection> {
    // Step 1: validate connection id (Req 8.1)
    assertConnectionId(connectionId);

    // Look up connection metadata
    const connection = this.config.connections.get(connectionId);
    if (!connection) {
      throw new Error(
        `Connection "${connectionId}" not found in the deployed connection inventory.`,
      );
    }

    // Step 2: resolve each secretKeys name in declaration order (Req 8.1, 8.10)
    const secrets: Record<string, string> = {};
    const startMs = Date.now();

    for (const key of connection.secretKeys) {
      // Check timeout
      if (Date.now() - startMs > RESOLVE_TIMEOUT_MS) {
        throw new Error(
          `Connection "${connection.name}" (${connectionId}): resolution timed out after 10 seconds.`,
        );
      }

      const entryName = awsSecretName(this.config.prefix, connectionId, key);
      const value = await this.getSecretWithRetry(entryName, connectionId, connection.name, key);

      if (value === undefined) {
        // Stop at the first absent key (Req 8.10)
        throw new Error(
          `Connection "${connection.name}" (${connectionId}): secret key "${key}" is absent from Secret_Store.`,
        );
      }

      secrets[key] = value;
    }

    // Step 3: seed the Redactor BEFORE returning (Req 8.11)
    const redactableValues = Object.values(secrets).filter(v => v.length >= MIN_REDACT_LEN);
    if (redactableValues.length > 0) {
      this.redactor.addLiterals(redactableValues);
    }

    return {
      id: connectionId,
      type: connection.type,
      config: { ...connection.config },
      secrets,
      auth: connection.auth,
      allowWrites: connection.allowWrites ?? false,
      limits: connection.limits,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider key resolution (Req 8.12)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolves the provider key for a given provider id. Returns the key value
   * to substitute for {{API_KEY}}, or throws naming the provider when absent.
   */
  async resolveProviderKey(providerId: string): Promise<string> {
    // Check cache
    if (this.providerKeyCache.has(providerId)) {
      const cached = this.providerKeyCache.get(providerId);
      if (cached === undefined) {
        throw new Error(
          `Provider "${providerId}": API key is absent from Secret_Store. No request sent.`,
        );
      }
      return cached;
    }

    const secretName = this.config.providerKeys?.get(providerId);
    if (!secretName) {
      this.providerKeyCache.set(providerId, undefined);
      throw new Error(
        `Provider "${providerId}": API key is absent from Secret_Store. No request sent.`,
      );
    }

    const value = await this.getSecretWithRetry(secretName, undefined, undefined, providerId);
    if (value === undefined) {
      this.providerKeyCache.set(providerId, undefined);
      throw new Error(
        `Provider "${providerId}": API key is absent from Secret_Store. No request sent.`,
      );
    }

    // Seed redactor with the provider key too
    if (value.length >= MIN_REDACT_LEN) {
      this.redactor.addLiterals([value]);
    }

    this.providerKeyCache.set(providerId, value);
    return value;
  }

  /**
   * Substitutes `{{API_KEY}}` in the given string with the resolved provider
   * key. Throws naming the provider when the key is absent (Req 8.12).
   */
  async substituteApiKey(template: string, providerId: string): Promise<string> {
    if (!template.includes(API_KEY_PLACEHOLDER)) {
      return template;
    }
    const key = await this.resolveProviderKey(providerId);
    return template.replaceAll(API_KEY_PLACEHOLDER, key);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Secret_Store write path (Req 8.9, 8.15)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write a secret value through the Trigger_API route.
   *
   * - Rejects empty values (Req 8.15)
   * - Rejects values over 64 KB (Req 8.15)
   * - Leaves any existing entry unchanged on rejection
   */
  async writeSecret(
    connectionId: string,
    secretKey: string,
    value: string,
  ): Promise<{ name: string }> {
    // Validate connection id
    assertConnectionId(connectionId);

    // Reject empty value (Req 8.15)
    if (!value || value.length === 0) {
      throw new SecretWriteError(
        `Connection "${connectionId}": secret value for key "${secretKey}" must not be empty.`,
      );
    }

    // Reject value over 64 KB (Req 8.15)
    const byteLen = utf8ByteLength(value);
    if (byteLen > MAX_SECRET_VALUE_BYTES) {
      throw new SecretWriteError(
        `Connection "${connectionId}": secret value for key "${secretKey}" exceeds 64 KB (${byteLen} bytes).`,
      );
    }

    const entryName = awsSecretName(this.config.prefix, connectionId, secretKey);
    await this.backend.put(entryName, value);

    return { name: entryName };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: retried secret reads (Req 8.14)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reads a secret with the `secret` retry budget (3 attempts, 10s).
   * Returns undefined only when the entry is absent.
   * Throws on persistent unavailability after retries.
   */
  private async getSecretWithRetry(
    entryName: string,
    connectionId: string | undefined,
    connectionName: string | undefined,
    keyContext: string,
  ): Promise<string | undefined> {
    let attempt = 0;
    const startMs = Date.now();
    const budget = RETRY_BUDGETS['secret'];

    while (true) {
      attempt++;
      try {
        return await this.backend.get(entryName);
      } catch (err) {
        // Check timeout budget
        if (budget.timeoutMs && Date.now() - startMs >= budget.timeoutMs) {
          const ctx = connectionName
            ? `Connection "${connectionName}" (${connectionId})`
            : `Provider key "${keyContext}"`;
          throw new Error(
            `${ctx}: Secret_Store unavailable after ${attempt} attempts for entry "${entryName}".`,
          );
        }

        // Check retry eligibility
        if (!shouldRetry('secret', err, attempt)) {
          const ctx = connectionName
            ? `Connection "${connectionName}" (${connectionId})`
            : `Provider key "${keyContext}"`;
          throw new Error(
            `${ctx}: Secret_Store unavailable after ${attempt} attempts for entry "${entryName}".`,
          );
        }

        // Brief delay before retry (simple exponential backoff)
        await delay(Math.min(100 * Math.pow(2, attempt - 1), 2000));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error class for write path rejections
// ---------------------------------------------------------------------------

/**
 * Thrown when the Secret_Store write path rejects a value. The existing entry
 * is left unchanged (Req 8.15).
 */
export class SecretWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretWriteError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
