# Phorma Agent Studio

A premium desktop canvas for **designing, debugging, and deploying multi-agent AI workflows — and watching them run live**. Agents are nodes; handoffs are edges that pulse during execution; runs can be paused, stepped, and inspected like an IDE debugger.

Built with **Tauri 2.0 (Rust)** + **Angular 20**, **PrimeNG**, **Tailwind CSS v4**, a custom **Canvas 2D** infinite-canvas renderer, and a framework-free **TypeScript run engine** that executes workflows both locally and in a **Cloudflare Durable Object** when deployed.

> Read [agent.md](agent.md) for the product vision and vocabulary. AI agents should also read [.github/agent-memory.md](.github/agent-memory.md).

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
node scripts/release.mjs 0.2.0-beta.6
#    (add --dry-run to preview without committing)

# 2. Push the commit AND the tag — the tag is what triggers CI:
git push origin main v0.2.0-beta.6

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
- If the build itself fails, delete the dead tag
  (`git push origin :refs/tags/vX.Y.Z; git tag -d vX.Y.Z`), fix, and cut the
  next version. Also delete any draft/partial GitHub Release for that tag.

## Deploy to the cloud (your Cloudflare account)

One-time setup in `cloud/`:

```powershell
cd cloud
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # repeat per provider you use
npx wrangler secret put PHORMA_TOKEN        # protects your endpoints (recommended)
```

Then in the studio: toolbar **☁ Cloud** → pick the `cloud/` folder → **Deploy**
(streams `wrangler deploy` into the console) → paste the worker URL + token →
**Push workflow** → **Connect monitor**. While connected, **Run** triggers the
deployed instance and the canvas animates its RunEvents live — identical to a
local run. Schedule triggers arm real cron jobs in the worker; webhook
triggers accept `POST {worker}/agents/workflow-agent/{workflow-id}/trigger`.

Local cloud testing without an account: `npx wrangler dev` in `cloud/`.
