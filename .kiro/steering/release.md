---
inclusion: auto
name: release
description: Release and distribution procedure for Phorma Agent Studio - version bumping with scripts/release.mjs, tagging, the GitHub Actions Release workflow, signed Tauri installers, R2 publishing, and the in-app auto-updater. Include when cutting a release, bumping versions, fixing a failed release build, publishing installers, or debugging why the app does not see a new version.
---

# Release and auto-update

One version bump, one push. CI builds, signs, publishes the GitHub Release, and syncs R2.

## Procedure

```powershell
git status                                  # start clean, on main
cd frontend; npm run build; cd ..           # PRE-FLIGHT: only the production build checks budgets
node scripts/release.mjs 0.2.0-beta.9       # bumps every manifest, commits, tags (--dry-run to preview)
git push origin main v0.2.0-beta.9          # the TAG is what triggers CI
gh run watch                                # ~15-20 min
```

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

## Updater behaviour

`UpdateService`: `check()` then a background `download()` (never `downloadAndInstall()`, which runs
the installer immediately on Windows), then a confirm dialog offering "Restart now" or "On next
launch". Deferral persists `phorma.layout.updateOnNextLaunch=<version>` and the next startup check
installs silently. Silent install depends on `plugins.updater.windows.installMode: "quiet"` in
`tauri.conf.json`.

Version comparison for the manifest lives in `cloud/src/releases.ts` and needs a worker deploy when
changed.

Related skill: `.github/skills/conventional-commit/SKILL.md` for commit message format.
