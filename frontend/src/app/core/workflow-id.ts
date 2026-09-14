/**
 * Workflow id minting - the ONE place a new `WorkflowSpec.id` comes from.
 *
 * ## Why this is not just `Date.now()`
 *
 * Ids used to be `wf-${Date.now().toString(36)}`, which is unique on ONE machine
 * and only because two saves are rarely a millisecond apart. That stopped being
 * good enough the moment a workflow could travel: a workflow id is now the
 * Durable Object instance name, the deployment registry key, the backup key and
 * the restore identity, so two installs minting the same id would have one
 * silently address the other's deployment, run history and backups.
 *
 * A `crypto.randomUUID()`-derived suffix closes it (Requirement 14.1). The
 * timestamp prefix is KEPT deliberately: ids sort chronologically in a storage
 * dump, which is worth more than four extra characters, and every id already in
 * the wild starts that way (Requirement 14.2).
 *
 * ## The fallback ladder
 *
 * This function runs on the first save of every workflow, so it must not be able
 * to throw. `crypto.randomUUID()` is gated on a secure context, and the desktop
 * webview origin is platform dependent (`tauri://localhost`,
 * `http://tauri.localhost`), so its availability is not something to assume.
 * `crypto.getRandomValues` is NOT secure-context gated and is the first fallback;
 * `Math.random` is the last resort, which is weaker but still far better than the
 * bare millisecond it replaces.
 *
 * A leaf module: no Angular import, no `inject`, nothing to construct.
 */

/** Prefix every workflow id carries, including every legacy one. */
const WORKFLOW_ID_PREFIX = 'wf-';

/**
 * Hex characters of entropy in the suffix. 48 bits, so two ids minted in the
 * same millisecond collide with probability ~2^-48 - small enough that the
 * `saveNewSpecToLibrary` re-mint guard is unreachable in practice while staying
 * as the last-resort check it always was (Requirement 14.4).
 */
const SUFFIX_HEX_CHARS = 12;

/**
 * A fresh workflow id.
 *
 * Contains only `[a-z0-9-]`, which matters in three places that all treat an id
 * as an opaque key: the `deploy:{owner}:{workflowId}` registry key refuses a
 * colon, the Durable Object instance name is `{userId}:{workflowId}`, and the
 * backup object key is a path segment.
 */
export function mintWorkflowId(): string {
  return `${WORKFLOW_ID_PREFIX}${Date.now().toString(36)}-${randomSuffix()}`;
}

/** True for anything this product has ever minted, legacy ids included. */
export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(WORKFLOW_ID_PREFIX) && !value.includes(':');
}

/** 48 bits of hex, by the strongest source this runtime actually offers. */
function randomSuffix(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  try {
    if (typeof webCrypto?.randomUUID === 'function') {
      // The UUID's first 12 hex digits: `xxxxxxxx-xxxx-...`, so drop the dash.
      return webCrypto.randomUUID().replace(/-/g, '').slice(0, SUFFIX_HEX_CHARS);
    }
  } catch {
    // A non-secure context throws rather than returning undefined. Fall through.
  }
  try {
    if (typeof webCrypto?.getRandomValues === 'function') {
      const bytes = webCrypto.getRandomValues(new Uint8Array(SUFFIX_HEX_CHARS / 2));
      return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall through to the last resort.
  }
  let out = '';
  while (out.length < SUFFIX_HEX_CHARS) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}
