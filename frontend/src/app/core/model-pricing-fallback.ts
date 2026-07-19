/**
 * Bundled pricing snapshot — fallback for {@link ModelPricingService} when
 * the OpenRouter models API is unreachable (offline desktop, firewalled).
 *
 * Keys are OpenRouter slugs; values are USD per TOKEN (OpenRouter's native
 * unit — e.g. $3/M input tokens = 0.000003).
 *
 * Snapshot date: 2026-07-19. Regenerated periodically — treat as
 * approximate; live-synced prices always win.
 */

import type { ModelPriceTable } from '@phorma/engine';

export const FALLBACK_PRICE_TABLE: ModelPriceTable = {
  // OpenAI
  'openai/gpt-5.5': { promptUsdPerToken: 0.00000175, completionUsdPerToken: 0.000014 },
  'openai/gpt-5.5-mini': { promptUsdPerToken: 0.00000035, completionUsdPerToken: 0.0000028 },
  'openai/gpt-5.1': { promptUsdPerToken: 0.00000125, completionUsdPerToken: 0.00001 },
  'openai/gpt-5.1-mini': { promptUsdPerToken: 0.00000025, completionUsdPerToken: 0.000002 },
  'openai/gpt-4.1': { promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000008 },
  'openai/gpt-4.1-mini': { promptUsdPerToken: 0.0000004, completionUsdPerToken: 0.0000016 },
  'openai/gpt-4o': { promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00001 },
  'openai/gpt-4o-mini': { promptUsdPerToken: 0.00000015, completionUsdPerToken: 0.0000006 },
  'openai/o3': { promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000008 },
  'openai/o4-mini': { promptUsdPerToken: 0.0000011, completionUsdPerToken: 0.0000044 },
  // Anthropic
  'anthropic/claude-sonnet-5': { promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
  'anthropic/claude-opus-4.8': { promptUsdPerToken: 0.000005, completionUsdPerToken: 0.000025 },
  'anthropic/claude-opus-4-7': { promptUsdPerToken: 0.000015, completionUsdPerToken: 0.000075 },
  'anthropic/claude-sonnet-4-5': { promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
  'anthropic/claude-haiku-4-5': { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000005 },
  'anthropic/claude-3-5-haiku': { promptUsdPerToken: 0.0000008, completionUsdPerToken: 0.000004 },
  // Google
  'google/gemini-3.5-flash': { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000025 },
  'google/gemini-3.5-pro': { promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00002 },
  'google/gemini-2.5-flash': { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000025 },
  'google/gemini-2.5-pro': { promptUsdPerToken: 0.00000125, completionUsdPerToken: 0.00001 },
  // Meta (Bedrock etc.)
  'meta-llama/llama-4-maverick': { promptUsdPerToken: 0.00000022, completionUsdPerToken: 0.00000088 },
  'meta-llama/llama-4-scout': { promptUsdPerToken: 0.00000017, completionUsdPerToken: 0.00000066 },
  // Amazon
  'amazon/nova-pro': { promptUsdPerToken: 0.0000008, completionUsdPerToken: 0.0000032 },
  'amazon/nova-lite': { promptUsdPerToken: 0.00000006, completionUsdPerToken: 0.00000024 },
};
