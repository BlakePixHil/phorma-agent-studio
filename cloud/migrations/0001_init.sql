-- Phorma Cloud (hosted mode) - initial multi-tenant schema.
--
-- Applied with:  npx wrangler d1 migrations apply phorma-cloud --env hosted
-- BYO deployments never bind D1 and never run these.

-- One row per Phorma Cloud account (id = Clerk userId).
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  email TEXT,
  tier TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'active',      -- active | past_due | canceled
  openrouter_key_id TEXT,                     -- OpenRouter key hash/id (for disable/rotate)
  openrouter_key_enc TEXT,                    -- AES-GCM encrypted runtime key (base64)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-run usage ledger (authoritative billing/analytics record).
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  month TEXT NOT NULL,                        -- YYYY-MM
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_month ON usage(tenant_id, month);

-- Denormalized month-to-date rollup (hot path for quota checks).
CREATE TABLE IF NOT EXISTS quotas (
  tenant_id TEXT NOT NULL,
  month TEXT NOT NULL,
  runs_used INTEGER NOT NULL DEFAULT 0,
  cost_usd_used REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);
