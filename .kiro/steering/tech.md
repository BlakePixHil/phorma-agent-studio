---
inclusion: always
---

# Tech stack and commands

Versions are pinned in the `package.json` files of `frontend`, `backend`, `cloud`, `cloud-aws`,
`engine` and `admin`, plus `backend/src-tauri/Cargo.toml`. All six packages share ONE version number
(currently `1.0.0-beta.7`), which `cloud-aws/scripts/check-versions.mjs` enforces - see
`release.md` steering.

## Stack

| Area | Stack |
|---|---|
| Frontend | Angular 20 (standalone, signals, OnPush), PrimeNG 20 + `@primeuix/themes` Aura preset, Tailwind CSS v4 (`@tailwindcss/postcss`), Tabler icons webfont, chart.js via PrimeNG `UIChart`, `marked` + `dompurify`, `ngx-clerk` |
| Canvas | Custom Canvas2D renderer in `frontend/src/app/workspace/canvas/` - no DOM/SVG nodes |
| Engine | `@phorma/engine` - pure TypeScript, no framework deps, consumed through a tsconfig path alias (no build step) |
| Desktop | Tauri v2, Rust 1.77+, plugins: dialog, opener, process, updater |
| Cloud | Cloudflare Worker + `agents` SDK (`WorkflowAgent` Durable Object, embedded SQLite), wrangler 4, `@clerk/backend` |
| Admin | `admin/` - separate Angular 20 telemetry dashboard (PrimeNG 20 Aura, Tailwind v4, `ngx-clerk`, its own SVG chart kit - no chart.js), deployed as a Worker serving static assets, isolated from every other package |
| Tests | engine: vitest 4 + fast-check 4 (`*.spec.ts`) and `tsx` scenario scripts (`test/*.e2e.mts`); frontend and admin: karma + jasmine (+ fast-check 4); cloud: `tsx`/`node` test scripts + miniflare |

Dev port is **7322**, and `admin` serves on **7323**. Phorma Code owns 7321 - never collide.

## Install

```powershell
cd frontend; npm install --legacy-peer-deps   # ALWAYS --legacy-peer-deps here
cd ../backend; npm install                    # installs the Tauri CLI; skipping it breaks `npm run dev`
cd ../cloud;   npm install
cd ../admin;   npm install --legacy-peer-deps # telemetry dashboard, same PrimeNG/Clerk peer clash
```

`@angular/cdk` must stay on v20 to match Angular core.

## Run

```powershell
cd backend;  npm run dev     # desktop shell + Angular dev server together
cd frontend; npm start       # browser only, http://localhost:7322
cd admin;    npm start       # telemetry dashboard only, http://localhost:7323
cd admin;    npm run preview # same port, fixture data + fake session: no Clerk, no Worker (?preview=empty|fail|degraded)
cd cloud;    npx wrangler dev # local Durable Object, no Cloudflare account needed
```

Never start these from a tool call that blocks - they are long-running. Ask the user to run them,
or start them as a background process.

## Verify - run these before claiming a change is done

```powershell
cd frontend; npm run build                       # production build: the ONLY thing that checks Angular budgets
cd frontend; npx ng test --watch=false --browsers=ChromeHeadless   # karma + jasmine, 1631 specs, ~25s
cd engine;   npm test                            # vitest --run (unit + fast-check property tests)
cd engine;   npm run test:e2e                    # all 13 test/*.e2e.mts scenario scripts
cd cloud;    npm run test:unit                   # 39 worker suites (`test` is the same; the portal e2e is manual)
cd cloud;    npm run check                       # tsc --noEmit + wrangler deploy --dry-run
cd cloud-aws; npm run check                      # pre-deploy gate: 12 steps, no credentials, no Docker
cd cloud-aws; npm test                           # vitest --run (unit + property tests)
cd cloud-aws; npm run test:e2e                   # all 8 test/*.e2e.mts scenario scripts
cd backend/src-tauri; cargo check                # or scripts/build-rust-debug.cmd
cd backend/src-tauri; cargo test                 # 42 unit tests (sql, llm, data, deploy_assets)
cd admin; npm run build                          # dashboard production build: 875 kB initial, 1.5MB warning / 2MB error
cd admin; npx ng test --watch=false --browsers=ChromeHeadless       # karma + jasmine, 77 specs, ~26s
node scripts/check-deploy-bundle.mjs             # the installer still carries both BYO deploy runtimes
node scripts/check-telemetry-catalog.mjs         # the two Counter_Catalog twins and the D1 migration still agree
node scripts/check-telemetry-isolation.mjs       # TelemetryService import list is still a DI leaf
node scripts/check-capability-isolation.mjs      # CapabilityService is still a DI leaf, and no level token is compared outside it
node scripts/check-telemetry-secrets.mjs         # after the admin build: no admin secret, no sk_ key in the bundle
node scripts/check-admin-conventions.mjs         # dashboard templates: Tabler icons, no p-dialog, explicit sizes
```

`npm test -- --watch=false --browsers=ChromeHeadless` in `frontend/` and `admin/` does NOT forward
those flags through npm 10 or 11 (11 warns "Unknown cli config", 10 drops them silently) and
`ng test` then defaults to WATCH mode, which never exits. Always use the `npx ng test` form above,
in scripts and in CI.

`.github/workflows/ci.yml` runs every one of these on push and PR, plus
`engine`'s `tsc --noEmit`. Adding a suite means adding it to `ci.yml` in the same
change. `cloud`'s `npm run test:portal` stays out of CI on purpose: it needs a
manually started `wrangler dev` and a local model.

- `ng serve` and `tsc` do NOT check budgets. CI has failed on budget errors that dev serve never
  surfaced, so run the production frontend build before pushing.
- Budgets in `frontend/angular.json`: `initial` 2MB warning / 3MB error, `anyComponentStyle` 22kB
  warning / 26kB error. Budget units are DECIMAL (`3MB` = 3,000,000 bytes). `initial` currently sits
  at ~2,999,300 bytes, so the warning is expected, the 3MB error gates, and new initial-bundle code
  needs an offsetting `@defer` or dynamic `import()`. `admin/angular.json` runs tighter: `initial` 1.5MB warning / 2MB error, at
  875kB today. Consolidate duplicated SCSS rules before raising a budget. Keep heavy deps
  (chart.js in `frontend`) behind `@defer (on immediate)`.
- `cloud/test/*.test.mjs` suites that use `node:module` `registerHooks` need Node 22+. On a Node 20
  machine run one with `npx -y node@22 --import tsx test/<suite>.test.mjs`.
- `engine/` has no local TypeScript install. For a type-only check there use
  `../frontend/node_modules/.bin/tsc --noEmit -p tsconfig.json`. Running `npx tsc` inside
  `engine/` tries to fetch the bogus `tsc` package and prompts interactively.
- Engine scenario scripts: `npx -y tsx engine/test/<name>.e2e.mts` from the repo root.
- After a `git pull`, missing deps in `frontend/node_modules` surface as build resolution errors
  (for example "Could not resolve chart.js/auto"). Reinstall before chasing it as a code bug.

## Model providers

Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama (local, zero key), LM Studio, and
`phorma-cloud` (billed to plan credits through the `/api/infer` proxy).

System One (TypeSafe Jev, `docs/system-one.md`) is NOT a model provider: it is a separate
`RunOptions.decisions` transport (`DecisionClient`), keyed `typesafe` in the keychain,
`TYPESAFE_API_KEY` on a BYO worker, `TYPESAFE_PLATFORM_KEY` hosted (proxied by `POST /api/decide`),
and a `typesafe` provider key on AWS. Priced at $0.042/Mtok input, output free. Ollama and LM Studio
model lists are fetched live from the local server - do not rely on static suggestion lists, and
do not assume `llama3.2` is installed. Query `http://localhost:11434/api/tags` first.
