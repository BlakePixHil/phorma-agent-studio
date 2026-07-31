---
inclusion: always
---

# Tech stack and commands

Versions are pinned in the four `package.json` files plus `backend/src-tauri/Cargo.toml`. All
four packages share ONE version number (currently `0.2.0-beta.8`) - see `release.md` steering.

## Stack

| Area | Stack |
|---|---|
| Frontend | Angular 20 (standalone, signals, OnPush), PrimeNG 20 + `@primeuix/themes` Aura preset, Tailwind CSS v4 (`@tailwindcss/postcss`), Tabler icons webfont, chart.js via PrimeNG `UIChart`, `marked` + `dompurify`, `ngx-clerk` |
| Canvas | Custom Canvas2D renderer in `frontend/src/app/workspace/canvas/` - no DOM/SVG nodes |
| Engine | `@phorma/engine` - pure TypeScript, no framework deps, consumed through a tsconfig path alias (no build step) |
| Desktop | Tauri v2, Rust 1.77+, plugins: dialog, opener, process, updater |
| Cloud | Cloudflare Worker + `agents` SDK (`WorkflowAgent` Durable Object, embedded SQLite), wrangler 4, `@clerk/backend` |
| Tests | engine: vitest 4 + fast-check 4 (`*.spec.ts`) and `tsx` scenario scripts (`test/*.e2e.mts`); frontend: karma + jasmine; cloud: `tsx`/`node` test scripts + miniflare |

Dev port is **7322**. Phorma Code owns 7321 - never collide.

## Install

```powershell
cd frontend; npm install --legacy-peer-deps   # ALWAYS --legacy-peer-deps here
cd ../backend; npm install                    # installs the Tauri CLI; skipping it breaks `npm run dev`
cd ../cloud;   npm install
```

`@angular/cdk` must stay on v20 to match Angular core.

## Run

```powershell
cd backend;  npm run dev     # desktop shell + Angular dev server together
cd frontend; npm start       # browser only, http://localhost:7322
cd cloud;    npx wrangler dev # local Durable Object, no Cloudflare account needed
```

Never start these from a tool call that blocks - they are long-running. Ask the user to run them,
or start them as a background process.

## Verify - run these before claiming a change is done

```powershell
cd frontend; npm run build                       # production build: the ONLY thing that checks Angular budgets
cd engine;   npm test                            # vitest --run (unit + fast-check property tests)
cd cloud;    npm run check                       # tsc --noEmit + wrangler deploy --dry-run
cd backend/src-tauri; cargo check                # or scripts/build-rust-debug.cmd
```

- `ng serve` and `tsc` do NOT check budgets. CI has failed on budget errors that dev serve never
  surfaced, so run the production frontend build before pushing.
- Budgets in `frontend/angular.json`: `initial` 2MB warning / 3MB error, `anyComponentStyle` 20kB
  warning / 24kB error. Consolidate duplicated SCSS rules before raising a budget. Keep heavy
  deps (chart.js) behind `@defer (on immediate)`.
- `engine/` has no local TypeScript install. For a type-only check there use
  `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`. Running `npx tsc` inside
  `engine/` tries to fetch the bogus `tsc` package and prompts interactively.
- Engine scenario scripts: `npx -y tsx engine/test/<name>.e2e.mts` from the repo root.
- After a `git pull`, missing deps in `frontend/node_modules` surface as build resolution errors
  (for example "Could not resolve chart.js/auto"). Reinstall before chasing it as a code bug.

## Model providers

Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama (local, zero key), LM Studio, and
`phorma-cloud` (billed to plan credits through the `/api/infer` proxy). Ollama and LM Studio
model lists are fetched live from the local server - do not rely on static suggestion lists, and
do not assume `llama3.2` is installed. Query `http://localhost:11434/api/tags` first.
