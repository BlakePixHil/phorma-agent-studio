/**
 * Portal access keys (EPIC 9) — the first SCOPED credential in the runtime.
 *
 * Every other token here is all-or-nothing: `PHORMA_TOKEN` and Clerk session
 * JWTs both grant full control of an instance (push a spec, read all history,
 * read usage, trigger, stop). A published endpoint must be reachable by
 * strangers, so it needs a credential that can do exactly one thing: send a
 * message to ONE workflow.
 *
 * Design:
 *  - A key looks like `pk_{slug}_{40 base32 chars}`. The slug rides in the
 *    key so a leaked key can't be replayed against a different portal, and so
 *    the worker can reject mismatches before touching storage.
 *  - Only SHA-256 hashes are stored. A key is shown to the owner exactly once
 *    at mint time; thereafter it is unrecoverable (same contract as a GitHub
 *    PAT). Revocation deletes the hash.
 *  - Comparison is constant-time over the digest, so a timing oracle can't
 *    walk the secret out of us.
 *
 * Pure Web Crypto — no Node built-ins, no `agents` SDK.
 */

/** Prefix that makes a leaked key greppable in logs and secret scanners. */
const KEY_PREFIX = 'pk';

/** Bytes of entropy per key. 32 bytes = 256 bits. */
const KEY_ENTROPY_BYTES = 32;

/** Crockford-style base32 without look-alike characters (no I, L, O, U). */
const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Metadata the owner sees for a minted key. The secret is NOT stored. */
export interface PortalTokenRecord {
  /** Short public identifier used to revoke this key. */
  id: string;
  /** SHA-256 of the full key string, hex-encoded. */
  hash: string;
  /** Owner-supplied note ("Zapier", "partner API"). */
  label: string;
  createdAt: number;
  /** Epoch ms of the most recent successful use, when known. */
  lastUsedAt?: number;
}

/** A freshly minted key: the plaintext is returned ONCE, then discarded. */
export interface MintedPortalToken {
  record: PortalTokenRecord;
  /** Show this to the owner immediately. It cannot be recovered later. */
  secret: string;
}

function randomBase32(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let text = '';
  for (const byte of buffer) text += BASE32[byte % BASE32.length];
  return text;
}

/** Hex-encodes a digest. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a string, hex-encoded. */
export async function hashPortalToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(digest);
}

/**
 * Mints a scoped key for one portal. The caller stores `record` and shows
 * `secret` to the owner once.
 */
export async function mintPortalToken(slug: string, label: string): Promise<MintedPortalToken> {
  const secret = `${KEY_PREFIX}_${slug}_${randomBase32(KEY_ENTROPY_BYTES)}`;
  return {
    secret,
    record: {
      id: randomBase32(6),
      hash: await hashPortalToken(secret),
      label: label.trim() || 'Access key',
      createdAt: Date.now(),
    },
  };
}

/** Timing-safe string comparison (equal-length hex digests). */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

/** True when the key's embedded slug matches, cheaply and without hashing. */
function claimsSlug(token: string, slug: string): boolean {
  return token.startsWith(`${KEY_PREFIX}_${slug}_`);
}

/**
 * Verifies a presented key against a portal's stored hashes. Returns the
 * matching record (so the caller can stamp `lastUsedAt`) or null.
 */
export async function verifyPortalToken(
  slug: string,
  tokens: readonly PortalTokenRecord[],
  presented: string | null | undefined,
): Promise<PortalTokenRecord | null> {
  const token = presented?.trim();
  if (!token || !claimsSlug(token, slug)) return null;
  const hash = await hashPortalToken(token);
  for (const record of tokens) {
    if (timingSafeEqual(record.hash, hash)) return record;
  }
  return null;
}

/**
 * Extracts a portal key from a request. Accepted, in order:
 *  - `Authorization: Bearer pk_…`   (server-to-server callers)
 *  - `X-Portal-Key: pk_…`           (browser fetch, avoids CORS preflight
 *                                    ambiguity with the studio's own auth)
 *  - `?key=pk_…`                    (shareable link: `/p/slug?key=…`)
 */
export function readPortalToken(request: Request, url: URL): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value.startsWith(`${KEY_PREFIX}_`)) return value;
  }
  const custom = request.headers.get('X-Portal-Key')?.trim();
  if (custom) return custom;
  const query = url.searchParams.get('key')?.trim();
  return query || null;
}
