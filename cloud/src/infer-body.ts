/**
 * Body helpers for `POST /api/infer`, kept in a leaf module (no bindings, no
 * `cloudflare:` imports) so a plain Node test can drive them.
 */

/** `/api/infer` output ceiling: the studio's largest request plus reasoning headroom. */
export const INFER_MAX_TOKENS_CEILING = 32_000;

/** Default when the caller names no budget. */
export const INFER_DEFAULT_MAX_TOKENS = 4096;

/** A caller-supplied `max_tokens`, defaulted and bounded. */
export function clampMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return INFER_DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.floor(value), INFER_MAX_TOKENS_CEILING);
}

/**
 * Rebuilds OpenRouter's `reasoning` request from caller input, keeping only
 * the one field the studio sends. Rebuilt rather than forwarded so a client
 * cannot smuggle other variants (`max_tokens`, `exclude`, `mode: 'pro'`) past
 * the ceiling above - reasoning tokens are billed as output either way.
 */
export function sanitizeReasoning(
  value: unknown,
): { effort: 'low' | 'medium' | 'high' } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const effort = (value as { effort?: unknown }).effort;
  return effort === 'low' || effort === 'medium' || effort === 'high' ? { effort } : undefined;
}
