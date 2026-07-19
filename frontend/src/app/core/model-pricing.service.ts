import { Injectable, signal } from '@angular/core';

import {
  createCostEstimator,
  priceTableFromOpenRouter,
  type CostEstimator,
  type ModelPriceTable,
  type ModelUsage,
} from '@phorma/engine';

import { FALLBACK_PRICE_TABLE } from './model-pricing-fallback';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_KEY = 'phorma.model-price-table.v1';
/** Refresh the synced table daily; prices move slowly. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedTable {
  fetchedAt: number;
  table: ModelPriceTable;
}

/**
 * Synced model pricing (EPIC 2) — gives BYO providers that report token
 * counts but not USD (OpenAI, Anthropic, Bedrock, Gemini) an ESTIMATED cost.
 *
 * Source of truth is OpenRouter's public `GET /api/v1/models` (no key
 * required) — its per-token USD prices cover every major vendor and its
 * slugs are already our canonical model namespace (`toPricingSlug` in
 * `engine/src/pricing.ts` normalizes provider-native ids). The synced table
 * is cached in localStorage for 24h; a bundled snapshot backstops offline
 * use. Estimates are always marked `costSource: 'estimated'` downstream so
 * the UI can label them "(est.)".
 *
 * Never used for Phorma Cloud billing — plan credits are metered
 * server-side from OpenRouter's reported cost, and cloud-billed usage is
 * displayed as credits, not dollars.
 */
@Injectable({ providedIn: 'root' })
export class ModelPricingService {
  /** Live price table: synced when fresh, cached or bundled otherwise. */
  readonly priceTable = signal<ModelPriceTable>(FALLBACK_PRICE_TABLE);

  private syncStarted = false;

  constructor() {
    const cached = this.readCache();
    if (cached) this.priceTable.set({ ...FALLBACK_PRICE_TABLE, ...cached.table });
    // Kick the sync lazily — never block startup on a network call.
    queueMicrotask(() => void this.sync());
  }

  /** Engine-shaped estimator bound to the current table. */
  estimator(): CostEstimator {
    // Rebind per call so long-lived recorders see table refreshes.
    return (provider, model, usage: ModelUsage) =>
      createCostEstimator(this.priceTable())(provider, model, usage);
  }

  /** Fetches the OpenRouter table if the cache is stale. Never throws. */
  async sync(force = false): Promise<void> {
    if (this.syncStarted && !force) return;
    this.syncStarted = true;
    const cached = this.readCache();
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
    try {
      const response = await fetch(MODELS_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const table = priceTableFromOpenRouter(await response.json());
      if (Object.keys(table).length === 0) return;
      this.priceTable.set({ ...FALLBACK_PRICE_TABLE, ...table });
      this.writeCache({ fetchedAt: Date.now(), table });
    } catch {
      // Offline / blocked — the bundled fallback stays in effect.
    }
  }

  private readCache(): CachedTable | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedTable;
      if (typeof parsed?.fetchedAt !== 'number' || typeof parsed?.table !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeCache(cache: CachedTable): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Quota/private-mode failures are fine — cache is an optimization.
    }
  }
}
