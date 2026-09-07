# Phorma Agent Studio

A premium desktop canvas for **designing, debugging, and deploying multi-agent AI workflows — and watching them run live**. Agents are nodes; handoffs are edges that pulse during execution; runs can be paused, stepped, and inspected like an IDE debugger.

Built with **Tauri 2.0 (Rust)** + **Angular 20**, **PrimeNG**, **Tailwind CSS v4**, a custom **Canvas 2D** infinite-canvas renderer, and a framework-free **TypeScript run engine** that executes workflows both locally and in a **Cloudflare Durable Object** when deployed.

> Read [agent.md](agent.md) for the product vision and vocabulary. AI agents should also read
> [.kiro/steering/](.kiro/steering/) (conventions, structure, commands, testing, release) and
> [.github/agent-memory.md](.github/agent-memory.md) (accumulated gotchas).

```
phorma-agent-studio/
├─ frontend/          # Angular 20 studio (shell + canvas + panels)
│  └─ src/app/
│     ├─ core/        # workflow model/service, run controller, transports
│     ├─ layout/      # toolbar, sidebars, console dock, workflow tabs
│     └─ workspace/   # canvas engine, palette, prompt/properties/runs panels
├─ engine/            # @phorma/engine — the run engine (pure TS, no frameworks)
├─ backend/           # Tauri desktop shell
│  └─ src-tauri/src/  # llm.rs (streaming proxy + OS keychain), process.rs
└─ cloud/             # Cloudflare Worker (Agents SDK WorkflowAgent DO)
```

## Prerequisites

- Node.js 20+, npm 10+
- Rust 1.77+ (`rustup`) with the platform WebView deps for Tauri
  (https://v2.tauri.app/start/prerequisites/)
- Optional, recommended: [Ollama](https://ollama.com) for zero-key local models
  (`ollama pull llama3.2`)

## Install (both folders — easy to miss!)

```powershell
# 1. Frontend deps
cd frontend
npm install --legacy-peer-deps

# 2. Backend deps (installs the Tauri CLI — required for `npm run dev`)
cd ../backend
npm install
```

> If `npm run dev` prints "The system cannot find the path specified" or
> "Tauri CLI not found", you skipped step 2.

## Run (desktop, hot-reload)

From `backend/` — Tauri starts the Angular dev server (port **7322**) and the
native window together:

```powershell
cd backend
npm run dev
```

## Run in a browser (no desktop shell)

```powershell
cd frontend
npm start            # http://localhost:7322
```

The studio degrades gracefully: the status bar shows "Browser preview", API
keys fall back to localStorage, and Ollama is the recommended provider (no
CORS, no keys).

## Build a production desktop bundle

```powershell
cd backend
npm run build
```

## First workflow (60 seconds)

1. Click (or drag) **Manual** and **Researcher** from the Agents palette.
2. Drag from the trigger's **Start** port to the agent's **Task** port.
3. Select the agent — edit its markdown prompt in the **Prompt** panel.
4. Add provider keys via the toolbar **⚙ Settings** (or run Ollama locally).
5. Open the **Runs** panel, type a task, press **Run** (or **F5**).

Debugger controls: **F5** run · **F6** pause/resume · **F10** step ·
**Shift+F5** stop · right-click a node → **Toggle Breakpoint**.

## Publish a release (installers + auto-updater)

The entire release is driven by ONE version bump and ONE push. CI does the
building, signing, GitHub Release, and R2 sync.

```powershell
# 0. Start from a clean tree on main (commit or stash everything first)
git status

# 0.5. PRE-FLIGHT: run the PRODUCTION frontend build locally. Dev serve and
#      tsc do not check Angular budgets — CI has failed on a budget error
#      that `ng serve` never surfaced.
cd frontend; npm run build; cd ..

# 1. Bump the version everywhere (all package.json files, Cargo.toml,
#    tauri.conf.json), commit, and create the vX.Y.Z tag:
node scripts/release.mjs 0.2.0-beta.7
#    (add --dry-run to preview without committing)

# 2. Push the commit AND the tag — the tag is what triggers CI:
git push origin main v0.2.0-beta.7

# 3. Watch the "Release" workflow (takes ~15–20 min):
gh run watch
```

What CI does (`.github/workflows/release.yml`):

1. Builds signed installers for Windows, macOS (arm64 + x64), and Linux via
   `tauri-action`, using the `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` secrets.
2. Publishes a GitHub Release for the tag (marked prerelease if the version
   contains a `-`, e.g. `-beta.6`).
3. `publish-r2` job syncs installers, `.sig` files, and manifests into the
   `phorma-releases` R2 bucket (`stable/{version}/…`, `stable/latest.json`,
   `stable/releases.json`) — this is what the in-app updater and the download
   site consume.

Rules to avoid breaking it:

- **Never bump versions by hand** — `scripts/release.mjs` keeps all six
  manifests in sync; a mismatch breaks the updater.
- **Always push the tag** (`git push origin main vX.Y.Z`). Pushing only
  `main` does nothing — CI triggers on `v*` tags.
- **Never re-use or move a tag.** If a release fails, fix the issue and cut
  a new patch/beta version.
- If the R2 sync job fails, re-run just that job from the GitHub Actions UI —
  the GitHub Release assets are already there.
- If the build itself fails, clean up with
  `gh release delete vX.Y.Z --yes --cleanup-tag` (removes any partial GitHub
  Release AND the remote tag), then `git tag -d vX.Y.Z` locally, fix, and cut
  the next version.
- The workflow pins `projectPath: backend` for `tauri-action` — don't remove
  it. Without it, auto-detection has wandered into `mcp/` on Linux runners
  and resolved `beforeBuildCommand`'s `../frontend` to the nonexistent
  `mcp/frontend`.

## Deploy to the cloud (your Cloudflare account)

The worker source ships inside the installer, so a user needs no checkout of this
repository. One-time setup:

1. **Settings → Cloud → Your own Cloudflare → Deploy runtime → Set up runtime
   files.** The studio unpacks the worker this app version carries into its app
   data folder and runs `npm install` there, streaming to the console.
2. `npx wrangler login` once in any terminal. Wrangler stores the credentials for
   the whole machine, so the folder it runs in does not matter.
3. Set provider secrets from the same settings card (it streams
   `wrangler secret put`), plus `PHORMA_TOKEN` to protect your endpoints.

Then in the studio: toolbar **☁ Cloud** → **Deploy** (streams `wrangler deploy`
into the console) → paste the worker URL + token → **Push workflow** →
**Connect monitor**. While connected, **Run** triggers the deployed instance and
the canvas animates its RunEvents live — identical to a local run. Schedule
triggers arm real cron jobs in the worker; webhook triggers accept
`POST {worker}/agents/workflow-agent/{workflow-id}/trigger`.

Re-run **Set up runtime files** after the app updates: it refreshes the worker
source, so the next deploy carries the newer portal and runtime. The studio
compares your worker's build against the app's and warns you when it is behind.

Working from this repo instead? Point the runtime folder at `cloud/` after
`npm install` there. Local cloud testing without an account: `npx wrangler dev`
in `cloud/`.

## Run Phorma Cloud locally (contributors)

By default the studio talks to the **deployed** Phorma Cloud worker at
`https://cloud.phorma-labs.com`, which holds **production** Clerk credentials and
**live** Stripe keys. A local build ships the *development* Clerk key, so every
authenticated call against it answers `401 Unauthorized`. Running the app locally
does not change that on its own — the endpoint is a persisted setting.

To work on anything that touches accounts, billing or usage, run your own worker:

```powershell
cd cloud
npm run dev:setup
```

That one command writes `cloud/.dev.vars` (generating `KEY_ENC_SECRET` and
`PHORMA_ADMIN_TOKEN` for you), applies the migrations to the local D1, and
provisions your tenant row. It prompts for the three values it cannot generate:

| Value | Where from |
|---|---|
| `CLERK_SECRET_KEY` | Clerk Dashboard, the **development** instance, API keys. Must be `sk_test_` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard in **test** mode, Developers > API keys |
| `OPENROUTER_PROVISIONING_KEY` | Optional. Skip it and only hosted *inference* refuses |

It also wants your **development-instance** Clerk user id (`user_...`) for the
tenant row. The script refuses a live-mode key, refuses a placeholder that is too
short to be real, and is safe to re-run: existing values are never overwritten.

Then, in three terminals:

```powershell
cd cloud; npx wrangler dev --env hosted   # the worker, on http://localhost:8787
cd cloud; npm run dev:webhooks            # Stripe webhook forwarder
cd frontend; npm start                    # the studio, on http://localhost:7322
```

Finally point the studio at your worker: **Settings → Cloud → Phorma Cloud URL** →
`http://localhost:8787`. Without this step you are still talking to production and
will still see `401 Unauthorized`.

Three things that cost real debugging time here:

- **Use `npm run dev:webhooks`, never a bare `stripe listen`.** The Stripe CLI
  keeps its own credential from `stripe login`, which can point at a *different*
  sandbox than your `STRIPE_SECRET_KEY`. The mismatch is close to invisible: the
  listener starts fine and prints a valid `whsec_`, the worker verifies against it
  happily, and no event ever arrives. The wrapper pins the CLI to the same key the
  worker reads.
- Paste the `whsec_` the forwarder prints into `cloud/.dev.vars` and **restart the
  worker** — wrangler reads that file only at startup.
- `wrangler d1 migrations apply` records a migration by **filename**. If a
  migration file grew after you first applied it, the new statements never run and
  nothing complains. Check `sqlite_master` for the tables it should have created,
  not `d1_migrations`. On a local database the fix is free: stop the worker, delete
  `cloud/.wrangler/state/v3/d1`, and re-apply.

Pass flags to these scripts with `node`, not npm: `npm run dev:setup -- --dry-run`
does **not** work, because npm swallows unrecognised flags as its own config. Use
`node scripts/setup-local-dev.mjs --dry-run`.
