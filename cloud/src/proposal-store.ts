/**
 * Proposal bodies - the R2 half of the proposal queue
 * (multi-organisation-phorma, Requirement 11.3, 11.4, 11.5, design section 9.3).
 *
 * A near-copy of `BackupBodyStore`, and deliberately a COPY rather than a
 * generalisation. The two share a pipeline and nothing else: different keys,
 * different retention arithmetic, and - the decisive one - different destroy
 * paths. `backups.ts` documents exactly THREE paths that destroy backup data and
 * `backup-routes.ts` names each one at its call site "so a fourth cannot appear
 * by accident"; a shared store would put the proposal prune inside that audit as
 * a fourth. Two small stores whose duplication is visible beat one store whose
 * callers have to remember which rules apply to them.
 *
 * ## The pipeline, and why in this order
 *
 * `JSON -> gzip -> AES-GCM -> R2` (Requirement 11.4). Compression comes FIRST
 * because ciphertext does not compress: reversing the two would store every
 * proposal at full size forever, and a proposed spec is highly repetitive JSON.
 *
 * `encryptBytes` / `decryptBytes` and not the string pair: pushing gzip output
 * through base64 costs 1.78x in R2, on the one path whose whole job is storing
 * things cheaply.
 *
 * ## No key means no proposal
 *
 * With no `KEY_ENC_SECRET` bound, a creation is REFUSED with
 * `proposal_unencrypted` and NOTHING is stored (Requirement 11.5). The two
 * refusals mirror `BackupBodyStore.unavailable()`'s shape rather than collapsing
 * into one boolean, because the remedies differ and both are operator actions:
 * create the bucket, or set the secret.
 *
 * ## The bucket is the EXISTING one, and the prefix is the isolation
 *
 * `BACKUPS`, with no new bucket and no new binding, under
 * `proposal/{ownerId}/{workflowId}/{proposalId}` versus
 * `backup/{tenantId}/{workflowId}/{revision}`. That is not tidiness.
 * `BackupBodyStore.deleteTenant` is a prefix scan over `backup/{tenantId}/`, and
 * its `prune` and `deleteWorkflow` enumerate `bodyPrefix(tenant, workflow)`, so a
 * `proposal/` object is out of reach of every backup destroy path BY
 * CONSTRUCTION - and a proposal body can never be served by a backup read.
 *
 * ## Every method takes a FULL KEY
 *
 * Not `(ownerId, workflowId, proposalId)`. `workflow_proposals.body_key` is
 * `NOT NULL` and holds the whole key, so an ownership transfer moves `owner_id`
 * without rewriting one R2 object. A method that re-derived the key from the row
 * would answer "that body is gone" for an object sitting safely in the bucket,
 * with no type error anywhere - the same trap `bodyPrefixFor` exists to close on
 * the backup side.
 */

import { decryptBytes, encryptBytes } from './tenants';

/** Bindings the proposal body store needs. */
export interface ProposalBodyEnv {
  /**
   * R2 bucket holding proposal bodies. The SAME binding backups use; the key
   * prefix is what keeps the two apart.
   */
  BACKUPS?: R2Bucket;
  /** 32-byte base64 AES-GCM key, shared with the runtime-key vault. */
  KEY_ENC_SECRET?: string;
}

/** Why a body operation could not proceed. */
export type ProposalBodyRefusal = { reason: 'no-bucket' } | { reason: 'no-key' };

/** The store. Constructed per request, like every other store in here. */
export class ProposalBodyStore {
  constructor(private readonly env: ProposalBodyEnv) {}

  /**
   * Why this deployment cannot store a proposal body, or null when it can.
   *
   * Two distinct refusals rather than one boolean: an operator with no bucket and
   * an operator with no secret have to go to different places, and a route that
   * collapsed them would send one of them to the wrong one.
   */
  unavailable(): ProposalBodyRefusal | null {
    if (!this.env.BACKUPS) return { reason: 'no-bucket' };
    if (!this.env.KEY_ENC_SECRET) return { reason: 'no-key' };
    return null;
  }

  /** True when both the bucket and the encryption key are present. */
  get enabled(): boolean {
    return this.unavailable() === null;
  }

  private get bucket(): R2Bucket {
    if (!this.env.BACKUPS) throw new Error('Proposal bodies require the BACKUPS (R2) binding.');
    return this.env.BACKUPS;
  }

  private get secret(): string {
    if (!this.env.KEY_ENC_SECRET) throw new Error('Proposal bodies require KEY_ENC_SECRET.');
    return this.env.KEY_ENC_SECRET;
  }

  /**
   * Compresses, encrypts and stores one proposal body at `key`.
   *
   * `json` is the SERIALIZED body, so the caller owns exactly what is stored and
   * this owns only how it is stored.
   */
  async put(key: string, json: string): Promise<void> {
    const compressed = await gzip(new TextEncoder().encode(json));
    const sealed = await encryptBytes(compressed, this.secret);
    await this.bucket.put(key, sealed, {
      // Enough for an operator reading the bucket to tell what an opaque object
      // is without decrypting it, and deliberately NOTHING about the workflow or
      // its author: a name here would leak through a bucket listing that the body
      // itself encrypts.
      customMetadata: { kind: 'proposal', format: 'gzip+aes-gcm' },
    });
  }

  /**
   * Reads one body back as the JSON that was stored, or null when the object does
   * not exist.
   *
   * Null rather than a throw for a missing object, so a route can answer 404: a
   * body write that failed after its row landed leaves exactly this state, and
   * "the body is not here" is a 404 rather than a 500. A DECRYPTION failure does
   * throw - "not here" and "here and unreadable" need different answers, and the
   * second one is an incident.
   */
  async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const sealed = new Uint8Array(await object.arrayBuffer());
    const compressed = await decryptBytes(sealed, this.secret);
    return new TextDecoder().decode(await gunzip(compressed));
  }

  /**
   * Deletes the named bodies, and reports how many keys were asked for.
   *
   * R2 `delete` is idempotent, so a key whose object is already gone costs
   * nothing and is not an error - which is what lets a retried prune converge.
   */
  async delete(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    await Promise.all(keys.map(key => this.bucket.delete(key)));
    return keys.length;
  }

  /**
   * Every stored body key under one workflow's prefix.
   *
   * Read from R2 rather than from D1, because R2 is the authority on which bodies
   * actually exist - the same reason `BackupBodyStore.revisions` is. Used by the
   * tests and by any future operator read; the routes list from D1, which is
   * where the statuses are.
   */
  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix, limit: 1000, cursor });
      for (const object of listed.objects) out.push(object.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return out;
  }
}

// ── Compression ──────────────────────────────────────────────────────────────
//
// `CompressionStream` is part of the Workers runtime and needs no dependency. The
// stream dance exists because there is no one-shot API: a `Response` over the
// piped stream is the shortest correct way to collect the result, and it handles
// backpressure for free. Identical to `backup-store.ts` by intent - it is the
// runtime's shape, not a choice either file gets to make differently.

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
