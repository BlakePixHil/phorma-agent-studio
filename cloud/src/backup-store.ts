/**
 * Workflow backup bodies - the R2 half of hosted backup.
 *
 * ## The pipeline, and why in this order
 *
 * `JSON -> gzip -> AES-GCM -> R2`. Compression comes FIRST because ciphertext
 * does not compress: reversing the two would store a workflow graph at full size
 * forever. A spec is highly repetitive JSON, so gzip typically takes 2MB to
 * something in the low hundreds of kB.
 *
 * ## Encryption at rest, and who can read it
 *
 * The existing `KEY_ENC_SECRET` rail, which means Phorma Labs CAN technically
 * decrypt a backup. That is a deliberate decision, not an oversight: it is what
 * makes support-assisted recovery possible at all, and it is disclosed in the
 * product beside the backup state with a one-click disable-and-delete-all
 * (Requirement 11). End-to-end encryption under a user passphrase was considered
 * and REJECTED - a forgotten passphrase would reproduce the exact loss this
 * feature exists to prevent.
 *
 * With no `KEY_ENC_SECRET` bound, an upload is REFUSED rather than stored in the
 * clear (Requirement 11.2).
 *
 * ## Key shape
 *
 * `backup/{tenantId}/{workflowId}/{revision}`. Revision-suffixed, so an accepted
 * upload always writes a key that does not exist yet (Requirement 10.3) and two
 * concurrent uploads can never overwrite each other's body - the D1 revision
 * claim has already picked a winner before either gets here.
 *
 * The tenant id is the FIRST segment so a prefix list is naturally scoped to one
 * account, which is what makes the retention prune and delete-all possible
 * without a second index.
 *
 * ## Why every method takes a PREFIX rather than an owner and a workflow id
 *
 * Because the owner in the key and the owner in the metadata row are allowed to
 * differ. An ownership claim moves `workflow_backups.tenant_id` into an
 * organisation and rewrites NO R2 object (Requirement 4.7), recording the prefix
 * that was in force on the row's `body_key` column. So the caller resolves the
 * prefix once, through {@link bodyPrefixFor}, and hands it down.
 *
 * The signature is the enforcement. A method that still took `(tenantId,
 * workflowId)` would silently derive the NEW owner's prefix for a transferred row
 * and answer "that revision is no longer retained" for a body that is sitting
 * safely in the bucket, with no type error anywhere.
 */

import { decryptBytes, encryptBytes } from './tenants';

/** Bindings the body store needs. */
export interface BackupBodyEnv {
  /** R2 bucket holding backup bodies. Hosted only. */
  BACKUPS?: R2Bucket;
  /** 32-byte base64 AES-GCM key, shared with the runtime-key vault. */
  KEY_ENC_SECRET?: string;
}

/** Why a body operation could not proceed. */
export type BackupBodyRefusal =
  | { reason: 'no-bucket' }
  | { reason: 'no-key' };

/** The store. Constructed per request, like every other store in here. */
export class BackupBodyStore {
  constructor(private readonly env: BackupBodyEnv) {}

  /**
   * Why this deployment cannot store a body, or null when it can.
   *
   * Two distinct refusals rather than one boolean, because the remedies differ and
   * both are operator actions: create the bucket, or set the secret. A route that
   * collapsed them would send an operator looking in the wrong place.
   */
  unavailable(): BackupBodyRefusal | null {
    if (!this.env.BACKUPS) return { reason: 'no-bucket' };
    if (!this.env.KEY_ENC_SECRET) return { reason: 'no-key' };
    return null;
  }

  /** True when both the bucket and the encryption key are present. */
  get enabled(): boolean {
    return this.unavailable() === null;
  }

  private get bucket(): R2Bucket {
    if (!this.env.BACKUPS) throw new Error('Backup bodies require the BACKUPS (R2) binding.');
    return this.env.BACKUPS;
  }

  private get secret(): string {
    if (!this.env.KEY_ENC_SECRET) {
      throw new Error('Backup bodies require KEY_ENC_SECRET.');
    }
    return this.env.KEY_ENC_SECRET;
  }

  /**
   * Compresses, encrypts and stores one revision's body.
   *
   * `json` is the SERIALIZED spec, so the caller owns what exactly gets backed up
   * and this owns only how it is stored.
   */
  async put(prefix: string, revision: number, json: string): Promise<void> {
    const compressed = await gzip(new TextEncoder().encode(json));
    const sealed = await encryptBytes(compressed, this.secret);
    await this.bucket.put(`${prefix}${revision}`, sealed, {
      // Recorded so an operator reading the bucket can tell what an opaque object
      // is without decrypting it. Deliberately NOTHING about the workflow itself:
      // a name here would leak through a bucket listing that the body encrypts.
      customMetadata: { revision: String(revision), format: 'gzip+aes-gcm' },
    });
  }

  /**
   * Reads one revision back as the JSON that was stored, or null when the object
   * does not exist.
   *
   * A DECRYPTION failure throws rather than answering null: "this revision is not
   * here" and "this revision is here and we cannot read it" need different
   * answers, and the second one is an incident.
   */
  async get(prefix: string, revision: number): Promise<string | null> {
    const object = await this.bucket.get(`${prefix}${revision}`);
    if (!object) return null;
    const sealed = new Uint8Array(await object.arrayBuffer());
    const compressed = await decryptBytes(sealed, this.secret);
    return new TextDecoder().decode(await gunzip(compressed));
  }

  /**
   * Every stored revision for one workflow, newest first.
   *
   * Read from R2 rather than from D1, because R2 is the authority on which bodies
   * actually exist: a prune that half-completed leaves D1's `revision` counter
   * ahead of the bodies, and a restore list that promised a body it cannot serve
   * is worse than a shorter honest one.
   */
  async revisions(prefix: string): Promise<number[]> {
    const listed = await this.bucket.list({ prefix, limit: 1000 });
    return listed.objects
      .map(object => Number(object.key.slice(prefix.length)))
      .filter(value => Number.isInteger(value) && value > 0)
      .sort((a, b) => b - a);
  }

  /**
   * Deletes every revision older than the newest `keep`, and reports what went
   * (Requirement 10.7).
   *
   * The newest revision is ALWAYS retained regardless of `keep`, so a
   * misconfigured cap can never leave a workflow with a metadata row and no body.
   */
  async prune(prefix: string, keep: number): Promise<number[]> {
    const all = await this.revisions(prefix);
    const doomed = all.slice(Math.max(1, keep));
    if (doomed.length === 0) return [];
    await Promise.all(doomed.map(revision => this.bucket.delete(`${prefix}${revision}`)));
    return doomed;
  }

  /** Deletes every revision of one workflow. Returns how many went. */
  async deleteWorkflow(prefix: string): Promise<number> {
    const all = await this.revisions(prefix);
    if (all.length === 0) return 0;
    await Promise.all(all.map(revision => this.bucket.delete(`${prefix}${revision}`)));
    return all.length;
  }

  /**
   * Deletes every body belonging to one tenant (Requirement 11.6).
   *
   * A prefix scan rather than a loop over ids, so an object whose metadata row was
   * already gone still goes. That matters: this is the "delete everything" control
   * a user reaches for on privacy grounds, and leaving an orphaned object behind
   * would make the promise false.
   */
  async deleteTenant(tenantId: string, extraPrefixes: readonly string[] = []): Promise<number> {
    // `extraPrefixes` carries the stored `body_key` of every row this tenant held,
    // because an ownership claim leaves an object under the PREVIOUS owner's prefix
    // (Requirement 4.7) and a scan of `backup/{tenantId}/` would walk straight past
    // it. Deduplicated by KEY rather than by prefix, since a tenant's own prefix and
    // a stored one routinely overlap.
    const prefixes = [...new Set([`backup/${tenantId}/`, ...extraPrefixes])];
    const doomed = new Set<string>();
    for (const prefix of prefixes) {
      let cursor: string | undefined;
      do {
        const listed = await this.bucket.list({ prefix, limit: 1000, cursor });
        for (const object of listed.objects) doomed.add(object.key);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    if (doomed.size === 0) return 0;
    await Promise.all([...doomed].map(key => this.bucket.delete(key)));
    return doomed.size;
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** `backup/{tenantId}/{workflowId}/` - the prefix one workflow's bodies share. */
export function bodyPrefix(tenantId: string, workflowId: string): string {
  return `backup/${tenantId}/${workflowId}/`;
}

/** The one place a body key is shaped. */
export function bodyKey(tenantId: string, workflowId: string, revision: number): string {
  return `${bodyPrefix(tenantId, workflowId)}${revision}`;
}

/**
 * Where one metadata row's bodies actually live: the STORED prefix, or the derived
 * one when there is none (Requirement 4.7).
 *
 * The single fallback in the codebase, so "a NULL `body_key` means derive it" is
 * one expression rather than a rule every call site has to remember. A row written
 * before the column existed, and every row an ordinary upload writes, both land on
 * the derived value - which is what makes the column backfill-free.
 */
export function bodyPrefixFor(record: {
  tenantId: string;
  workflowId: string;
  bodyKey: string | null;
}): string {
  return record.bodyKey ?? bodyPrefix(record.tenantId, record.workflowId);
}

// ── Compression ──────────────────────────────────────────────────────────────
//
// `CompressionStream` is part of the Workers runtime and needs no dependency. The
// stream dance below exists because there is no one-shot API: a `Response` over
// the piped stream is the shortest correct way to collect the result, and it
// handles backpressure for free.

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
