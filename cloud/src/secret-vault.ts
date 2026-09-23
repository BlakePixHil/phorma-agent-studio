/**
 * `SecretVault` - deployment-scoped store for credentials a DEPLOYED run needs.
 *
 * Why this exists: until now the only credential a deployed run could resolve
 * was a worker environment secret (`CONN_*`, `MCP_*`), and the only way to set
 * one is `wrangler secret put` - a deploy-time command run against the
 * operator's own Cloudflare account. That makes connection secrets impossible
 * for a Phorma-hosted tenant (they do not own the account) and a terminal trip
 * for a BYO operator, so a workflow with an authenticated `http-request` node
 * could be built, validated and then never deployed. This is the ingestion
 * path that closes that gap.
 *
 * Shape and guarantees:
 *
 * - One instance per OWNER (hosted) or per deployment (BYO), addressed through
 *   {@link secretVaultName}. Deliberately NOT per workflow: a credential is a
 *   property of the account, and re-entering the same API key once per workflow
 *   would be its own dead end. "Owner" and not "user": an organisation's members
 *   share one vault, which is the whole point of a shared workspace
 *   (multi-organisation-phorma, Requirement 4.1).
 * - Values are AES-GCM encrypted by the CALLER with `KEY_ENC_SECRET` before
 *   they arrive (`encryptString` in `tenants.ts`). The vault stores opaque
 *   ciphertext and has no way to read it, so a bug here cannot leak a
 *   plaintext credential.
 * - Entries are keyed by the engine's `workerSecretName(connectionId, key)` /
 *   `MCP_<AUTHKEY>` name, so the vault is a drop-in fallback for the env lookup
 *   it supplements - and env keeps priority, so an operator who already set a
 *   real worker secret is never silently overridden.
 * - Plain `DurableObject`, never the `agents` SDK `Agent`: an `Agent`
 *   broadcasts its state to every connected socket, which for this table would
 *   be a credential disclosure.
 */

import { DurableObject } from 'cloudflare:workers';

/** Storage-key prefix for one vault entry. */
const ENTRY_PREFIX = 'secret:';

/**
 * Ceiling on entries per vault. Generous for real use (a tenant with 200
 * distinct credentials is doing something unusual) and bounded so a compromised
 * client cannot grow DO storage without limit.
 */
export const SECRET_VAULT_MAX_ENTRIES = 200;

/** Ceiling on one stored ciphertext, which bounds the plaintext too. */
export const SECRET_VAULT_MAX_VALUE_CHARS = 8192;

/** The shape a worker secret name must have, matching `workerSecretName`. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** One stored entry. Never holds plaintext. */
interface VaultEntry {
  /** AES-GCM ciphertext, base64, produced by `encryptString`. */
  enc: string;
  updatedAt: number;
}

/** What a caller learns about an entry without being able to read it. */
export interface SecretVaultEntryInfo {
  name: string;
  updatedAt: number;
}

export class SecretVault extends DurableObject {
  /** Stores (or replaces) one entry. Rejects a bad name or an over-full vault. */
  async put(name: string, enc: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!SECRET_NAME_PATTERN.test(name)) {
      return { ok: false, error: `Invalid secret name "${name}".` };
    }
    if (enc.length === 0 || enc.length > SECRET_VAULT_MAX_VALUE_CHARS) {
      return { ok: false, error: 'Secret value is empty or too large.' };
    }
    const key = `${ENTRY_PREFIX}${name}`;
    const existing = await this.ctx.storage.get<VaultEntry>(key);
    if (!existing) {
      const count = (await this.ctx.storage.list({ prefix: ENTRY_PREFIX, limit: SECRET_VAULT_MAX_ENTRIES + 1 })).size;
      if (count >= SECRET_VAULT_MAX_ENTRIES) {
        return { ok: false, error: `This account already stores ${SECRET_VAULT_MAX_ENTRIES} secrets.` };
      }
    }
    await this.ctx.storage.put<VaultEntry>(key, { enc, updatedAt: Date.now() });
    return { ok: true };
  }

  /** The stored ciphertext for `name`, or null. Decryption is the caller's job. */
  async read(name: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<VaultEntry>(`${ENTRY_PREFIX}${name}`);
    return entry?.enc ?? null;
  }

  /** Drops one entry. Idempotent. */
  async remove(name: string): Promise<{ removed: boolean }> {
    return { removed: await this.ctx.storage.delete(`${ENTRY_PREFIX}${name}`) };
  }

  /**
   * Every stored entry's NAME and mtime, sorted by name. This is what lets the
   * studio show "stored in the cloud" beside a secret field without any path
   * that could read the value back.
   */
  async entries(): Promise<SecretVaultEntryInfo[]> {
    const map = await this.ctx.storage.list<VaultEntry>({ prefix: ENTRY_PREFIX });
    const list: SecretVaultEntryInfo[] = [];
    for (const [key, entry] of map) {
      list.push({ name: key.slice(ENTRY_PREFIX.length), updatedAt: entry.updatedAt });
    }
    return list.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
}

// ── Addressing ───────────────────────────────────────────────────────────────

/** Env slice needed to reach a vault. */
export interface SecretVaultEnv {
  /**
   * Optional on purpose: a worker deployed before this binding existed still
   * serves every other route, and the credential paths report the absence
   * instead of throwing on an undefined namespace.
   */
  SecretVault?: DurableObjectNamespace<SecretVault>;
  /** base64 32-byte AES-GCM key. Without it there is no vault at all. */
  KEY_ENC_SECRET?: string;
}

/**
 * The vault instance name for one owner: `secrets:{ownerId}`
 * (multi-organisation-phorma, Requirement 4.1).
 *
 * Hosted mode passes the RESOLVED owner - `auth.ownerId`, which is the
 * organisation when the credential names one and the account otherwise - because
 * that is exactly the prefix the gateway uses to scope workflow instances
 * (`{ownerId}:{workflowId}`), so isolation here is the same structural boundary
 * rather than a second scheme to keep in step. Passing `auth.userId` instead
 * would give every member of an organisation a private vault and report every
 * shared credential as missing on a deployed run. BYO mode has one owner and
 * passes null.
 *
 * Nothing here parses the value: an owner id is opaque, and the colon guard lives
 * beside `resolveOwner` in `auth.ts` (Requirement 1.5).
 */
export function secretVaultName(ownerId: string | null | undefined): string {
  return ownerId ? `secrets:${ownerId}` : 'secrets:default';
}

/**
 * The vault stub for one owner. Every caller goes through this, so the naming
 * scheme lives in exactly one place. Callers must have checked the binding.
 */
export function secretVault(
  env: SecretVaultEnv,
  ownerId: string | null | undefined,
): DurableObjectStub<SecretVault> {
  const namespace = env.SecretVault;
  if (!namespace) throw new Error('This deployment has no SecretVault binding.');
  return namespace.get(namespace.idFromName(secretVaultName(ownerId)));
}
