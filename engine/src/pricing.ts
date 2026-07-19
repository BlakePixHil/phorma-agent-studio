/**
 * Model pricing — pure cost-estimation helpers for providers that report
 * token counts but not USD cost (OpenAI, Anthropic, Bedrock, Gemini).
 *
 * The price table is keyed by OpenRouter model slugs (`vendor/model`), which
 * doubles as our canonical model-id namespace: the studio syncs the table
 * from OpenRouter's public /api/v1/models endpoint (no key required) and
 * ships a bundled snapshot as a fallback. This module never fetches — hosts
 * inject the table; the engine stays network-free beyond model transport.
 *
 * Estimated costs are always marked `costSource: 'estimated'` so UIs can
 * label them "(est.)" and billing code can ignore them. OpenRouter/Phorma
 * Cloud runs keep their provider-reported (`reported`) cost untouched.
 *
 * Pure TypeScript, zero framework dependencies — same rules as the rest of
 * the engine package.
 */

import type { ModelUsage } from './model.js';

/** USD per single token (OpenRouter's native pricing unit). */
export interface ModelPrice {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  /** Model context window in tokens, when the source reports it. */
  contextTokens?: number;
}

/** OpenRouter slug (`vendor/model`) → price. */
export type ModelPriceTable = Record<string, ModelPrice>;

/**
 * Normalizes a provider-native model id to an OpenRouter slug for price
 * lookup. Best-effort — returns null when no sensible mapping exists
 * (e.g. Ollama's local models, which cost nothing anyway).
 */
export function toPricingSlug(provider: string, model: string): string | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  switch (provider) {
    case 'openrouter':
    case 'phorma-cloud':
      // Already OpenRouter slugs; strip variant suffixes like `:free`.
      return id.split(':')[0] ?? id;
    case 'openai':
      return `openai/${id}`;
    case 'anthropic':
      return `anthropic/${stripAnthropicDate(id)}`;
    case 'gemini':
      return `google/${id}`;
    case 'bedrock': {
      // Bedrock ids: optional region/geo prefix (`us.` / `au.` / `apac.`),
      // vendor, dotted model id with a date + `-vN:0` suffix, e.g.
      // `au.anthropic.claude-opus-4-7-20250514-v1:0` → `anthropic/claude-opus-4-7`.
      const parts = id.split('.');
      if (parts.length < 2) return null;
      const vendorIndex = parts.length >= 3 && (parts[0]?.length ?? 0) <= 4 ? 1 : 0;
      const vendor = parts[vendorIndex];
      const rest = parts.slice(vendorIndex + 1).join('.');
      if (!vendor || !rest) return null;
      const cleaned = stripAnthropicDate(rest.replace(/-v\d+(:\d+)?$/, ''));
      return `${vendor === 'meta' ? 'meta-llama' : vendor}/${cleaned}`;
    }
    case 'ollama':
      return null; // Local inference — nothing to price.
    default:
      return null;
  }
}

/** Strips trailing `-YYYYMMDD` date stamps Anthropic appends to model ids. */
function stripAnthropicDate(id: string): string {
  return id.replace(/-20\d{6}$/, '');
}

/**
 * Estimates the USD cost of one usage sample. Returns null when the table
 * has no price for the model or the usage carries no token counts.
 * Ollama always estimates to 0 (local inference is free).
 */
export function estimateCostUsd(
  table: ModelPriceTable,
  provider: string,
  model: string,
  usage: ModelUsage,
): number | null {
  if (provider === 'ollama') return 0;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  const slug = toPricingSlug(provider, model);
  if (!slug) return null;
  const price = table[slug];
  if (!price) return null;
  return (
    (usage.inputTokens ?? 0) * price.promptUsdPerToken +
    (usage.outputTokens ?? 0) * price.completionUsdPerToken
  );
}

/** Host hook: estimates USD for a usage sample (null = no estimate). */
export type CostEstimator = (provider: string, model: string, usage: ModelUsage) => number | null;

/** Builds a {@link CostEstimator} bound to a price table. */
export function createCostEstimator(table: ModelPriceTable): CostEstimator {
  return (provider, model, usage) => estimateCostUsd(table, provider, model, usage);
}

/**
 * Fills in `costUsd` on a usage sample when the provider didn't report it.
 * Reported costs always win; estimates are marked `costSource: 'estimated'`.
 */
export function withEstimatedCost(
  usage: ModelUsage,
  provider: string,
  model: string,
  estimate: CostEstimator | null | undefined,
): ModelUsage {
  if (usage.costUsd !== undefined || !estimate) return usage;
  const costUsd = estimate(provider, model, usage);
  if (costUsd === null) return usage;
  return { ...usage, costUsd, costSource: 'estimated' };
}

/**
 * Parses OpenRouter's public `GET /api/v1/models` response into a price
 * table. Tolerant of shape drift — rows without parseable prices are skipped.
 */
export function priceTableFromOpenRouter(response: unknown): ModelPriceTable {
  const table: ModelPriceTable = {};
  const data = (response as { data?: unknown })?.data;
  if (!Array.isArray(data)) return table;
  for (const row of data) {
    const id = (row as { id?: unknown })?.id;
    const pricing = (row as { pricing?: { prompt?: unknown; completion?: unknown } })?.pricing;
    if (typeof id !== 'string' || !pricing) continue;
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    const slug = id.toLowerCase().split(':')[0] ?? id.toLowerCase();
    const contextLength = Number((row as { context_length?: unknown })?.context_length);
    table[slug] = {
      promptUsdPerToken: prompt,
      completionUsdPerToken: completion,
      contextTokens:
        Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
    };
  }
  return table;
}

/**
 * Looks up a model's context window (tokens) in a price table. Returns
 * undefined when the model is unknown or the source didn't report one —
 * callers apply a conservative default. Shaped for `RunOptions.contextWindow`.
 */
export function contextWindowOf(
  table: ModelPriceTable,
  provider: string,
  model: string,
): number | undefined {
  const slug = toPricingSlug(provider, model);
  if (!slug) return undefined;
  return table[slug]?.contextTokens;
}
