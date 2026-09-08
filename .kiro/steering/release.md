---
inclusion: auto
name: release
description: Release and distribution procedure for Phorma Agent Studio - version bumping with scripts/release.mjs, tagging, the GitHub Actions Release workflow, signed Tauri installers, R2 publishing, and the in-app auto-updater. Include when cutting a release, bumping versions, fixing a failed release build, publishing installers, or debugging why the app does not see a new version.
---

# Release and auto-update

One version bump, one push. CI builds, signs, publishes the GitHub Release, and syncs R2.

> **Cutting an actual release? Read `.github/skills/release-playbook/SKILL.md` first and work it
> top to bottom.** This file is the summary and the operator checklists; the playbook is the ordered,
> gated procedure with an expected value at every step, and `references/failure-modes.md` beside it
> catalogues every release failure this repo has had. Agents have repeatedly missed steps by working
> from this summary alone.

## Procedure

```powershell
git status                                  # start clean, on main
cd frontend; npm run build; cd ..           # PRE-FLIGHT: only the production build checks budgets
node scripts/release.mjs 0.2.0-beta.9       # bumps every manifest, commits, tags (--dry-run to preview)
git push origin main v0.2.0-beta.9          # the TAG is what triggers CI
gh run watch                                # ~15-20 min
cd cloud; npm run check                     # then, if cloud/ changed at all:
npx wrangler deploy --env hosted            # AFTER the bump, never before - see below
```

CI does NOT deploy the worker; it builds installers and syncs R2. The worker is a separate manual
step, and it belongs **after** `release.mjs` runs, because the script bumps `cloud/src/build-info.ts`
and that constant is what `/status.json` reports as `build`. Deploying the worker before the bump, or
from a mid-development tree, is how the live worker came to report `0.2.0-beta.12` while serving
beta.14's billing routes - drift that stays invisible until someone probes a route and reads 401
instead of 404. `/status.json`'s `build` matching the tag is the only cheap evidence that the deployed
worker is the one you think it is, so check it after every release.

`.github/workflows/release.yml` then builds signed installers for Windows, macOS (arm64 + x64), and
Linux via `tauri-action` using the `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` secrets, publishes a
GitHub Release (prerelease when the version contains `-`), and runs `publish-r2` to sync installers,
`.sig` files, and manifests into the `phorma-releases` R2 bucket (`stable/{version}/...`,
`stable/latest.json`, `stable/releases.json`). The in-app updater and the download site read those.

## Rules

- Never bump versions by hand. `scripts/release.mjs` keeps all manifests in sync; a mismatch breaks
  the updater. The script lives in `scripts/`, so run `node scripts/release.mjs X.Y.Z` from the repo
  root.
- Always push the tag. Pushing only `main` does nothing.
- Never reuse or move a tag. If a release fails, cut a new patch or beta version.
- If only the R2 sync failed, re-run that job from the Actions UI - the GitHub Release assets already
  exist. If the build failed, clean up with `gh release delete vX.Y.Z --yes --cleanup-tag`, then
  `git tag -d vX.Y.Z` locally, fix, and cut the next version.
- Do not remove `projectPath: backend` from the workflow. Without it, `tauri-action` auto-detection
  has wandered into `mcp/` on Linux runners and resolved `beforeBuildCommand`'s `../frontend` to a
  nonexistent `mcp/frontend`.
- GitHub marks the newest NON-prerelease as "Latest", so with a beta chain "Latest" lags far behind.
  Never rely on `gh`'s Latest fallback in CI - a bare `gh release download` once poisoned
  `stable/latest.json` with an old version and returned 204 to every updater client. `publish-r2.mjs`
  now aborts on a version mismatch.

## Manual republish from a dev machine

```powershell
gh release download vX.Y.Z --dir release-assets-fix
node scripts/publish-r2.mjs vX.Y.Z release-assets-fix   # needs cloud/node_modules/.bin on PATH
```

Verify with the worker updater endpoint for an older version (expect 200 plus JSON) and
`/releases.json`.

## Clerk keys: a development build and a production build ship different keys

Clerk rejects a production publishable key on localhost, so one file cannot serve both targets.

| Package | Development file (`pk_test_`) | Production file (`pk_live_`) |
|---|---|---|
| `frontend` | `src/environments/clerk.ts` | `src/environments/clerk.prod.ts` |
| `admin` | `src/environments/environment.ts` | `src/environments/environment.prod.ts` |

Each `angular.json` swaps them with a `fileReplacements` entry under the `build` target's
`production` configuration ONLY, and that is enough: `serve:production` and the Tauri installer both
route through `build:production`, while `serve:development` and the karma `test` target have no
replacement and correctly keep the `pk_test_` key. Keep every environment file's doc comment matching
the key it actually holds - a comment asserting the opposite is what let an inverted `admin` pair
survive review.

To PROVE a swap took effect, grep the emitted bundle for the base64 key BODY, never the `pk_live_` /
`pk_test_` prefix: both prefixes already appear inside the Clerk SDK as prefix-check literals, so a
prefix grep passes happily on a bundle that was never replaced.

The worker side pairs with it. One worker holds ONE `CLERK_SECRET_KEY`, so a local `wrangler dev`
takes the DEVELOPMENT key from `cloud/.dev.vars` (names documented in the tracked
`cloud/.dev.vars.example`; `cloud/.gitignore` globs `.dev.vars*` and `.env*` with `!.dev.vars.example`
as the single exception) while the deployed hosted worker holds the production one. `/status.json`
cannot confirm that rotation - its Clerk probe returns 200 for any valid key regardless of instance.
`/api/me` with a production session token returning 200 rather than 401 is the only real check.

## Phorma Cloud go-live checklist (billing)

The billing code shipped (`.kiro/specs/stripe-billing/`). Everything below is operator work against
live accounts, so treat it as a checklist and VERIFY each step against the live account rather than
assuming a previous release covered it - or that this list is current. Steps 1-5 were verified done on
2026-09-07; steps 6 and 7 are still unverified.

Verify, do not assume, in both directions. Every check below is read-only and needs no Dashboard:

```powershell
npx wrangler versions view <version-id> --env hosted   # secret NAMES, vars, bindings, DO migrations
npx wrangler deployments list --env hosted             # which version is live, and what caused it
npx wrangler d1 execute phorma-cloud --env hosted --remote --json --command `
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

1. `npx wrangler secret put CLERK_SECRET_KEY --env hosted` with the `sk_live_` key.
2. `npx wrangler secret put CLERK_JWT_KEY --env hosted` with the production PEM. Rotate both in one
   step: with a PEM set, `@clerk/backend` never uses the secret key to verify, so a stale
   `CLERK_JWT_KEY` 401s every production token with a failure that reads exactly like a wrong secret
   key.
3. `npx wrangler secret put STRIPE_SECRET_KEY --env hosted` and
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET --env hosted`, both live-mode values. The webhook
   secret is per ENDPOINT, so take it from the live Dashboard endpoint and never from
   `stripe listen`.
4. `npx wrangler d1 migrations apply phorma-cloud --env hosted --remote`. **DONE** - verified
   2026-09-07: `d1_migrations` lists all four, `credit_grants` and `stripe_events` exist, `tenants`
   carries both `stripe_*` columns and all four `billing_*` clocks, and `idx_usage_tenant_run` is
   present. Check the COLUMNS and not just `d1_migrations`: a migration edited after a partial apply
   stays stamped while its later statements never run, which is a failure this repo has already had
   locally.
5. `npx wrangler deploy --env hosted`. A `var` edit (`CLERK_AUTHORIZED_PARTIES`,
   `OPENROUTER_WORKSPACE_ID`) takes effect ONLY here; a `wrangler secret put` publishes no config
   change of its own.
6. Mirror the Stripe catalogue into LIVE mode BY LOOKUP KEY, with `tax_behavior: 'inclusive'` on every
   price, and enable Stripe Tax plus the AU GST obligation in the Dashboard for both sandbox and live.
   **PARTIALLY DONE** - verified and corrected 2026-09-08 on `acct_1UB18DFzmpLXhRYz`: all six
   `phorma_*` live prices now carry their `metadata` AND `tax_behavior: inclusive`.

   Two traps this step hid for weeks, both worth reading before touching another catalogue:

   - **Metadata belongs on the PRICE, not the product.** All six prices shipped with
     `metadata: {}` while `tier` and `credits` sat on the parent products, so `tierForPrice`
     (which reads `price.metadata.tier` by requirement 7) refused every plan with "a plan price
     carries no metadata.tier". Verify with `GET /v1/prices` and read `data[].metadata` - the
     product's metadata is not what the worker sees.
   - **`tax_behavior` is only correctable while it is `unspecified`.** Stripe: "Once specified as
     either inclusive or exclusive, it cannot be changed." It shipped as `unspecified`, which the
     worker LOGS rather than refuses (deliberately - refusing would strand a deployment), so it was
     invisible. Fixed in place because nothing had sold yet; after a sale the only remedy is a
     replacement price plus a subscriber migration. Check this BEFORE the first payment, always.

   Still outstanding: `GET /v1/tax/registrations` is EMPTY, so the AU GST registration was never
   added, and the account default is `inferred_by_currency`. That is Dashboard work.
7. Re-provision the owner tenant under the PRODUCTION Clerk user id and rotate
   `TELEMETRY_ADMIN_USER_IDS`. Clerk cannot migrate users from a development instance to a production
   one, so a dev-keyed `tenants` row is unrecoverable rather than portable.

Before step 5, check for var drift with `npx wrangler versions view <id> --env hosted`, which lists every var by
name without needing the Dashboard.

## Updater behaviour

`UpdateService`: `check()` then a background `download()` (never `downloadAndInstall()`, which runs
the installer immediately on Windows), then a confirm dialog offering "Restart now" or "On next
launch". Deferral persists `phorma.layout.updateOnNextLaunch=<version>` and the next startup check
installs silently. Silent install depends on `plugins.updater.windows.installMode: "quiet"` in
`tauri.conf.json`.

Version comparison for the manifest lives in `cloud/src/releases.ts` and needs a worker deploy when
changed.

Related skill: `.github/skills/conventional-commit/SKILL.md` for commit message format.
