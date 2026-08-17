/**
 * The production `SecretsBackend`: Secret_Store access over Secrets Manager.
 *
 * This is the owning module for the `connections` capability, as
 * `./capability-map.json` declares, so every connection credential the engine
 * resolves reaches AWS through the client built here.
 *
 * Thin translation only. Two operations, no retry policy and no shape
 * rewriting: `SecretsAdapter` in `./secrets.ts` owns the retry budget, the
 * ordering rules and the Redactor seeding, and calls this port with a full
 * entry name.
 *
 * Two behaviours are worth naming:
 *
 * - `get` maps an absent entry to `undefined` rather than throwing, because
 *   `SecretsAdapter` distinguishes "absent" (a refusal naming the key) from
 *   "unavailable" (retried against the `secret` budget). Every other failure
 *   propagates unchanged so the retry path can see it.
 * - `put` writes a new version of an existing entry through `PutSecretValue`
 *   and only falls back to `CreateSecret` when the entry does not exist yet.
 *   The created entry carries the App_CMK key id, which is what
 *   `CustomerKeyAspect` requires of every IaC-declared secret - an entry
 *   created at runtime must match.
 *
 * No client is constructed at module load: the Check_Pipeline runs with no AWS
 * credentials, so credential resolution happens inside
 * `createSecretsBackend`, which the Server_Entry calls after `readServerEnv`
 * succeeds.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type { SecretsBackend } from './ports.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SecretsBackendOptions {
  /** The region the Secret_Store lives in - `AWS_REGION` on the task definition. */
  region: string;
  /**
   * The App_CMK key id or ARN, applied when `put` has to create the entry.
   * It comes from deployment configuration, never from a literal in this
   * module. When absent, a created entry falls back to the Secrets Manager
   * account default key.
   */
  appCmkKeyId?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `SecretsBackend`.
 *
 * Credentials come from the default provider chain, which resolves the
 * Runtime_Identity task role on Fargate. Calling this function is the first
 * point at which a client exists.
 */
export function createSecretsBackend(options: SecretsBackendOptions): SecretsBackend {
  const { region, appCmkKeyId } = options;
  const client = new SecretsManagerClient({ region });

  return {
    async get(name: string): Promise<string | undefined> {
      try {
        const output = await client.send(new GetSecretValueCommand({ SecretId: name }));
        // A binary-only entry carries no `SecretString`. Phorma only ever
        // writes strings, so treat that as absent rather than guessing an
        // encoding.
        return output.SecretString;
      } catch (error) {
        if (isAbsentEntry(error)) return undefined;
        throw error;
      }
    },

    async put(name: string, value: string): Promise<void> {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
        return;
      } catch (error) {
        // Anything other than "the entry does not exist" is a real failure.
        if (!isAbsentEntry(error)) throw error;
      }

      await client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
          ...(appCmkKeyId === undefined ? {} : { KmsKeyId: appCmkKeyId }),
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when Secrets Manager reported that the named entry does not exist.
 *
 * The `instanceof` check covers the modelled exception; the name check covers
 * the same error arriving through a bundle boundary that broke the prototype
 * chain, which is the exact shape `core/aws-errors.ts` matches for gone
 * connections.
 */
function isAbsentEntry(error: unknown): boolean {
  if (error instanceof ResourceNotFoundException) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ResourceNotFoundException'
  );
}
