---
inclusion: fileMatch
fileMatchPattern: ["cloud/**/*.ts", "cloud/**/*.mjs", "cloud/wrangler.jsonc", "cloud/package.json", "frontend/src/app/core/cloud.service.ts", "frontend/src/app/core/phorma-cloud.service.ts"]
---

# Cloud runtime detail

`cloud/` is a Cloudflare Worker on the `agents` SDK. A `WorkflowAgent` Durable Object hosts the same
`@phorma/engine` as the studio and exposes WebSocket monitoring plus HTTP and cron triggers. Two
deployment shapes share the code: **hosted** (Phorma Cloud, billed to plan credits) and **BYO** (the
user's own Cloudflare account and keys).

## Rules

- `cloud/` must depend on the `ai` package - the `agents` SDK imports it dynamically and wrangler
  bundling fails with "Could not resolve ai" otherwise.
- Verify with `npm run check` (`tsc --noEmit` plus `wrangler deploy --dry-run`). No Cloudflare
  account needed. `npx wrangler dev` gives a full local Durable Object for E2E, and
  `npm test` runs the portal, projection, embed, deploy-config, connections, data-host,
  workflow-state, and run-wiring suites.
- Wrangler/esbuild honours tsconfig `paths`, so `@phorma/engine` resolves exactly as in the frontend.
- Durable Object state uses the Agents SDK `this.sql` tagged template (embedded SQLite):
  `run_journal`, `usage_ledger`, workflow state, portal registry.
- `onStart()` fires on every DO wake and re-triggers an interrupted run via
  `trigger(input, resumeRunId)`. A resumed hosted run must pass `countsAsRun: false` to `recordRun`
  so it adds ledger cost without incrementing the monthly run count.
- Waits and approvals are IN-MEMORY. DO eviction kills a suspended run; the journal covers completed
  work only. The `earlyEvents` map buffers webhook races where an event arrives before the waiter
  registers.
- Suspension endpoints on the DO: `POST /events {correlationKey, payload}`,
  `POST /approvals {nodeId, approved}`, plus WS `event` and `stop` frames.
- `GET /usage?since=` serves the usage ledger in both hosted and BYO mode, written in the settle
  finally-block with 366 day / 5000 row retention.
- Hosted mode re-labels `node-usage` `provider` to `phorma-cloud` (hosted inference runs on
  OpenRouter but bills plan credits). BYO deployments keep real provider names.
- Historical run snapshots store a versioned envelope in the graph column and must still parse
  legacy raw graph JSON. Snapshots include optional `subWorkflows`.
- `CloudService.materializeDefaults()` bakes app-level defaults (default model, tool rounds) into the
  spec at push time, so no cloud change is needed when a new app default appears.

## Tenancy and billing

- `TIERS` in `cloud/src/tenants.ts` is the authority: starter, pro, team. The `plus` tier was
  removed. `TIER_MONTHLY_CREDITS` in `phorma-cloud.service.ts` mirrors it, and `tierLabel()` renders
  ids (`team` displays as "Teams", unknown ids title-case through).
- `monthlyCredits` is the ONLY unit ever displayed. `monthlyCostUsd` is the real spend cap
  (OpenRouter key limit) and is analytics-only. Higher tiers bake a volume bonus into a larger USD
  budget so displayed credit numbers stay round.
- Sub-workflow depth limits: Free/BYO 2, Starter 5, Pro 8, Team 10, engine hard ceiling 25. Unknown
  hosted tiers fall back to Starter.
- Secrets: `npx wrangler secret put <PROVIDER>_API_KEY` per provider, plus `PHORMA_TOKEN` to protect
  BYO endpoints. Connection secrets follow `connectionSecretName` / `workerSecretName` from
  `engine/src/connections.ts` (worker names must match `^[A-Z][A-Z0-9_]*$`).
- A deployed run resolves a connection secret from worker env FIRST, then from the `SecretVault`
  Durable Object (`POST /api/connection-secrets`, AES-GCM under `KEY_ENC_SECRET`, one instance per
  owner: `secrets:{userId}` hosted, `secrets:default` BYO). The vault is the only ingestion path a
  hosted tenant has, since `wrangler secret put` needs their own account. `MCP_*` bearers are still
  env-only. Spec: `.kiro/specs/deployed-credential-vault/`.
- Adding a Durable Object class means a binding + migration tag in `wrangler.jsonc` top level AND
  `env.hosted` AND `DeployConfigService`'s generated override, which REPLACES the committed config
  on every BYO deploy. `cloud/test/deploy-config.test.mjs` derives the expected class list from
  `src/index.ts`'s export statement and will catch a miss.

## Release-adjacent code in cloud/

`cloud/src/releases.ts` serves the updater manifest. Prerelease comparison is SemVer dot-segment
numeric (`comparePrerelease`) - a plain string compare made `beta.10 < beta.9` and silently stopped
updates at the tenth beta. Changes here need a worker deploy, not just a release build.

Related skills: `.github/skills/cloudflare/agents-sdk/`, `durable-objects/`,
`workers-best-practices/`, `wrangler/`, `platform/`.
