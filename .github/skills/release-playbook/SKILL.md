---
name: release-playbook
description: 'Full release procedure for Phorma Agent Studio - the ordered, gated playbook for cutting a version: pre-flight verification, scripts/release.mjs, pushing the tag, watching CI and the Release workflow, deploying the hosted Cloudflare Worker, and proving the release actually landed. Use whenever asked to cut, ship, publish or release a version, to bump versions, to deploy the worker, or to diagnose a release that failed, drifted or did not reach users.'
---

# Release playbook

**This document is a gate, not a reference.** Work top to bottom. Every phase ends in a check with a
literal expected value. Do not start a phase until the previous one passed, and do not report a
release as done until Phase 7 is signed off.

Releases here have failed in ways that stayed invisible for days: a worker deployed under the wrong
version stamp, an updater manifest poisoned with an old version, a production build shipping a
development auth key. Every step below exists because one of those happened. The steps that look
like paranoia are the ones that caught something.

## The shape of a release

```text
release.mjs bumps 11 files ─┬─▶ commit "release: X.Y.Z" ─▶ tag vX.Y.Z
                            │
git push origin main vX.Y.Z ─┼─▶ push to main ──▶ CI workflow      (tests, builds, guards)
                            └─▶ push of tag ──▶ Release workflow  (installers, GitHub Release, R2)

                              MANUAL, after the bump:
                              wrangler deploy --env hosted  ──▶ /status.json reports X.Y.Z
```

Two facts that drive the whole ordering:

- **CI does not run on the tag.** `ci.yml` triggers on `push: branches: ['**']`; a tag is not a
  branch. `release.yml` triggers on `push: tags: ['v*']`. Pushing both refs in one command starts
  both workflows; pushing only the tag builds installers from **untested** code.
- **CI does not deploy the worker.** That is a manual step and it belongs *after* `release.mjs`,
  because the script rewrites `cloud/src/build-info.ts` and that constant is the only thing
  `/status.json` reports as `build`.

## Copy-paste checklist

Paste this into your working notes and tick as you go. The phases below explain each line.

```text
[ ] 1  Clean tree, on main, synced with origin, no unreleased work left behind
[ ] 2  Full verification suite green (all 8 packages/guards)
[ ] 3  Version parity + auth-key swap proven in the built bundles
[ ] 4  release.mjs --dry-run reviewed, then run for real
[ ] 5  git push origin main vX.Y.Z   (BOTH refs, one command)
[ ] 6  CI green AND Release workflow green; GitHub Release has all 4 platforms
[ ] 7  Worker deployed if cloud/ changed; /status.json build == X.Y.Z
[ ] 8  R2 manifests serve X.Y.Z; updater answers 200 for an older version
[ ] 9  Post-release: memory + steering updated, operator steps recorded
```

---

## Phase 1 - Pre-flight state

```powershell
cd c:\Dev\phorma\phorma-agent-studio
git status --short                 # expect: EMPTY
git rev-parse --abbrev-ref HEAD    # expect: main
git fetch origin
git status -sb                     # expect: no "behind" / "ahead" surprises
git describe --tags                # tells you the last tag and commits since
git log --oneline <lastTag>..HEAD  # read this: it IS the release scope
```

**Gate.** A dirty tree is a stop, not a warning - `release.mjs` runs `git add` on 12 specific paths
and then `git commit`, so unrelated staged work is silently *excluded* while unrelated unstaged work
is silently *left behind*. Either way the tag does not describe the tree you think it does.

Decide the version now, from the log you just read. Never reuse or move an existing tag; if a tag
exists, the next release is a new number. Check with `git tag --list "v0.2.0-beta.1*"`.

## Phase 2 - Full verification suite

Run all of it. Not the parts you think you touched - the ordering guards, twin checks and bundle
scans catch cross-package breakage precisely because nobody expected them to fire.

```powershell
cd frontend;   npm run build                                          # ONLY thing checking Angular budgets
cd ../frontend; npx ng test --watch=false --browsers=ChromeHeadless
cd ../engine;  npm test
cd ../engine;  npm run test:e2e
cd ../cloud;   npm run test:unit
cd ../cloud;   npm run check
cd ../cloud-aws; npm run check
cd ../cloud-aws; npm test
cd ../cloud-aws; npm run test:e2e
cd ../backend/src-tauri; cargo check --locked
cd ../../backend/src-tauri; cargo test --locked
cd ../../admin; npm run build
cd ../admin;   npx ng test --watch=false --browsers=ChromeHeadless
cd ..
node scripts/check-deploy-bundle.mjs
node scripts/check-telemetry-catalog.mjs
node scripts/check-telemetry-isolation.mjs
node scripts/check-telemetry-secrets.mjs      # MUST run after the admin build
node scripts/check-admin-conventions.mjs
```

Traps in this phase, all previously shipped bugs:

- Use `npx ng test --watch=false`, never `npm test -- --watch=false`. npm 10 drops those flags
  silently and npm 11 warns `Unknown cli config` and drops them too, so `ng test` sits in watch mode
  and burns the timeout.
- `cargo check --locked`, matching CI. A bare `cargo check` happily rewrites `Cargo.lock` and hides
  the failure CI will hit.
- `--locked` also means `Cargo.lock` must already carry the *new* version - `release.mjs` handles
  that, which is why Phase 4 comes after this and you re-run `cargo check --locked` if it fails
  there.
- `check-telemetry-secrets.mjs` scans the emitted `admin/dist` bundle. Running it before the admin
  build makes it pass by scanning nothing (it hard-fails on a missing bundle only when `CI` is set).
- `engine/` has no local TypeScript. Type-check it with
  `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`; `npx tsc` there tries to fetch a
  bogus package and prompts interactively.
- Local Node may be too old for some `cloud` suites (`node:sqlite`, `registerHooks` need 22/24; CI
  pins 24). If a suite dies at *import* rather than at an assertion, that is the cause - verify the
  affected behaviour directly and say so explicitly rather than reporting the suite as green.

**Gate.** Everything green. A failure you did not cause still blocks the release and still gets
fixed - that is the repo's standing rule, not a judgement call.

## Phase 3 - Version parity and the auth-key swap

```powershell
node cloud-aws/scripts/check-versions.mjs    # all 6 packages share ONE version
```

Then prove the production Clerk key actually reached the bundle. **Grep the base64 key BODY, never
the `pk_live_` / `pk_test_` prefix** - both prefixes appear inside the Clerk SDK as prefix-check
literals, so a prefix grep passes on a bundle that was never replaced.

```powershell
# frontend: expect the pk_live_ body, and NO dev body
Select-String -Path frontend/dist/phorma/browser/*.js -Pattern 'Y2xlcmsucGhvcm1hLWxhYnMuY29tJA' | Select-Object -First 1
Select-String -Path frontend/dist/phorma/browser/*.js -Pattern 'Zmxvd2luZy1zZWFob3JzZS03Mi'     # expect: NOTHING

# admin: same two checks against its own bundle
Select-String -Path admin/dist/admin/browser/*.js -Pattern 'Y2xlcmsucGhvcm1hLWxhYnMuY29tJA' | Select-Object -First 1
Select-String -Path admin/dist/admin/browser/*.js -Pattern 'Zmxvd2luZy1zZWFob3JzZS03Mi'        # expect: NOTHING
```

**The dev-body pattern ends `...ZS03Mi`, not `...ZS03Mg`.** It was written as `Mg` until
`1.0.0-beta.3` and that made the whole negative check VACUOUS: `Zmxvd2luZy1zZWFob3JzZS03Mg` is
base64 for the bare string `flowing-seahorse-72`, but the real key encodes
`flowing-seahorse-72.clerk.accounts.dev$`, and base64 alignment makes the 25th character `i` rather
than `g`. The pattern therefore could not match even a bundle that really did ship the development
key - the one failure this step exists to catch. If you change a pattern here, verify it FAILS on a
development build before trusting it on a production one.

The swap is a `fileReplacements` entry on the `build` target's `production` config only
(`clerk.ts` -> `clerk.prod.ts` in `frontend`, `environment.ts` -> `environment.prod.ts` in `admin`).
`serve:development` and karma correctly keep the `pk_test_` key.

**Known cosmetic drift, do not "fix" mid-release:** `release.mjs` does *not* bump the six
`package-lock.json` files, so their top-level `version` fields trail the release (measured at
beta.18: frontend on beta.12, cloud beta.13, engine beta.8, admin beta.13, cloud-aws beta.9, backend
beta.5). This is currently harmless because every workflow uses `npm install`, not `npm ci`, and
`check-versions.mjs` reads `package.json` only. It becomes a real breakage the moment any workflow
switches to `npm ci`. Fix it as its own change, never inside a release.

## Phase 4 - Bump, commit, tag

```powershell
node scripts/release.mjs X.Y.Z --dry-run    # lists the 12 targets, writes NOTHING
node scripts/release.mjs X.Y.Z              # bumps, git add, commit "release: X.Y.Z", tag vX.Y.Z
git show --stat HEAD                        # expect exactly the 11 files
```

The 11 targets: `backend/src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}`, the six
`*/package.json`, `cloud/src/build-info.ts`, `frontend/src/app/core/app-version.ts`.

**Never bump a version by hand.** A manifest that disagrees with the others breaks the updater, and
the two source constants (`WORKER_BUILD`, the app version) are literals the script rewrites by regex
and *throws* if it cannot find - by design, because a missed stamp ships a worker that lies about
its version.

**Gate.** `git show --stat HEAD` lists 11 files and nothing else. If `Cargo.lock` moved, re-run
`cargo check --locked` before pushing.

**Commit unrelated fixes BEFORE this phase.** `release.mjs` `git add`s only its own 11 targets, so a
fix still sitting unstaged (a verification failure you just repaired, for instance) is silently left
out of the tag while every manifest claims the release contains it.

## Phase 5 - Push both refs

```powershell
git push origin main vX.Y.Z
```

One command, both refs. Pushing only `main` builds nothing. Pushing only the tag builds installers
from code CI never tested.

## Phase 6 - Watch both workflows

```powershell
gh run list --limit 5          # expect TWO new runs: CI (branch) and Release (tag)
gh run watch                   # ~15-20 min for Release
```

When the Release workflow finishes:

```powershell
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

**Gate.** Assets for all four targets: Windows NSIS `.exe`, macOS arm64 + x64, Linux AppImage/deb,
plus a `.sig` beside each updater artifact and `latest.json`. A partial matrix is a failed release
even though `fail-fast: false` let the other platforms succeed.

Recovery:

- **R2 sync failed only.** Re-run that job from the Actions UI; the GitHub Release assets already
  exist. Or republish from a dev machine:
  `gh release download vX.Y.Z --dir release-assets-fix` then
  `node scripts/publish-r2.mjs vX.Y.Z release-assets-fix` (needs `cloud/node_modules/.bin` on PATH).
- **A build failed.** `gh release delete vX.Y.Z --yes --cleanup-tag`, then `git tag -d vX.Y.Z`
  locally, fix, and cut the **next** version. Never re-point a tag.
- Do not remove `projectPath: backend` from the workflow. Without it `tauri-action` auto-detection
  has wandered into `mcp/` on Linux runners and resolved `beforeBuildCommand`'s `../frontend` to a
  nonexistent `mcp/frontend`.

## Phase 7 - Deploy the hosted worker

**Required whenever anything under `cloud/` changed, including a docs-only comment**, because
`WORKER_BUILD` moved and `/status.json` is the only cheap evidence of what is live.

Check for var drift *before* deploying - a deploy silently overwrites live vars with the file's:

```powershell
npx wrangler deployments list --env hosted          # which version is live, and why
npx wrangler versions view <version-id> --env hosted # secret NAMES, every var, bindings, DO migrations
cd cloud; npm run check
npx wrangler deploy --env hosted
```

Then the gate that catches the drift this repo has actually shipped twice:

```powershell
(Invoke-WebRequest https://cloud.phorma-labs.com/status.json).Content | ConvertFrom-Json | Select-Object build
# expect: X.Y.Z  — exactly the tag you just pushed
```

A `wrangler secret put` publishes **no** config change of its own; only `deploy` applies a `vars`
edit. And `/status.json` cannot confirm a Clerk key rotation - its probe returns 200 for any valid
key regardless of instance. `/api/me` with a real production session token returning 200 rather than
401 is the only end-to-end proof.

## Phase 8 - Prove it reached users

Three checks, all against the live worker. Substitute the version you just cut and the one before it.

```powershell
# 1. The manifest names the new version
(Invoke-WebRequest https://cloud.phorma-labs.com/releases.json).Content | ConvertFrom-Json |
  Select-Object -First 1

# 2. THE decisive one: an OLDER client is offered the update.
#    Expect 200 + JSON carrying the new version and a signature. 204 here is the
#    poisoned-manifest failure and it is silent on every client.
$r = Invoke-WebRequest "https://cloud.phorma-labs.com/update/stable/windows/x86_64/<PREVIOUS>" -SkipHttpErrorCheck
$r.StatusCode; ($r.Content | ConvertFrom-Json).version

# 3. And a CURRENT client is not. Expect 204.
(Invoke-WebRequest "https://cloud.phorma-labs.com/update/stable/windows/x86_64/<NEW>" -SkipHttpErrorCheck).StatusCode

# 4. The website's five download slugs redirect to the new version. Expect 302 each.
foreach ($p in @('windows-x64','macos-arm64','macos-intel','linux-appimage','linux-deb')) {
  $d = Invoke-WebRequest "https://cloud.phorma-labs.com/download/stable/latest/$p" `
        -Method Get -SkipHttpErrorCheck -MaximumRedirection 0
  "$p -> $($d.StatusCode) $($d.Headers.Location)"
}
```

**Windows PowerShell 5.1 cannot run the probes as written.** `-SkipHttpErrorCheck` is PowerShell 7+
only, and `Invoke-WebRequest` without `-UseBasicParsing` blocks on an interactive "Script Execution
Risk" prompt that silently consumes the whole command timeout. Either run these in `pwsh`, or use a
`[System.Net.HttpWebRequest]` helper with `AllowAutoRedirect = $false` and read the status code off
the `WebException`'s response when the answer is a 204 or a 302.

**Two traps in the probes themselves**, both hit while writing this:

- **Do not probe an asset with `-Method Head`.** `handleReleaseRequest` gates on
  `request.method !== 'GET'`, so HEAD falls through to the agent router and **404s** while the
  identical GET returns 200 and the real installer. The 404 reads as a missing artifact and sends
  you to debug R2 for nothing. Use `-Method Get ... -MaximumRedirection 0` and read
  `RawContentLength`.
- **The download slugs are not the updater's target strings.** The website route takes
  `windows-x64` / `macos-arm64` / `macos-intel` / `linux-appimage` / `linux-deb`
  (`DOWNLOAD_PLATFORM_MAP`); the updater path takes `windows/x86_64` style (`updaterPlatformKey`).
  Guessing `windows` or `linux` on the download route 404s and looks like a broken release.

GitHub marks the newest **non-prerelease** as "Latest", so on a beta chain GitHub's "Latest" lags far
behind - never rely on `gh`'s Latest fallback. A bare `gh release download` once poisoned
`stable/latest.json` with an old version and returned 204 to every updater client; `publish-r2.mjs`
now aborts on a version mismatch, and the workflow sets `VERSION` on the download step for exactly
this reason.

## Phase 9 - Post-release

- Append a dated bullet to `.github/agent-memory.md` for any gotcha learned. If it is a durable
  rule, put it in the matching `.kiro/steering/` file instead.
- If the release depended on operator work against a live third-party account (Clerk, Stripe,
  Cloudflare), record what was done and what remains in the go-live checklist in the `release`
  steering. **Verify a checklist in both directions** - a doc that understates what is done sends
  the next person to re-run a migration against live data.
- A blocked verification step is a release risk, not a formality. Say which check you could not run
  and why, explicitly, rather than letting it read as passed.

---

## Things that are NOT part of a release

- `cloud/npm run test:portal` - needs a manually started `wrangler dev` and a local model.
- Clerk instance settings (`after_sign_in_url`, the subdomain allowlist, `allowed_origins`) - all
  Dashboard or Backend-API work with no wrangler surface. Not blocked by a release, and not fixed by
  one either.
- Stripe catalogue mirroring into live mode. `tax_behavior` is permanent once set, so it is a
  create-once operation and belongs outside the release path.

## Reference

- `references/failure-modes.md` - every release failure this repo has had, with its signature.
- `.kiro/steering/release.md` - the short version, plus the Phorma Cloud go-live checklist.
- `.github/skills/conventional-commit/SKILL.md` - commit message format for the surrounding commits.
