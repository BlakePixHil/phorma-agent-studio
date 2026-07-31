# Phorma Agent Studio - Copilot Instructions

## Before You Start

The canonical, tool-agnostic guidance lives in `.kiro/steering/`. Read these first, in order:

1. `agent.md` - product vision, target audience, core vocabulary.
2. `.kiro/steering/conventions.md` - coding rules (Angular, styling, PrimeNG, engine purity).
3. `.kiro/steering/structure.md` - repo map, structural twins, registry pattern, DI hazards.
4. `.kiro/steering/tech.md` - stack, install/run/verify commands, budgets.
5. `.kiro/steering/workflow.md` - how to work here: memory protocol, verification bar, bug-fix flow.
6. `.github/agent-memory.md` - accumulated gotchas and verified practices.

Area detail as needed: `.kiro/steering/frontend-ui.md`, `engine.md`, `desktop-rust.md`,
`cloud-worker.md`, `testing.md`, `release.md`, `skills.md`.

Do not duplicate those rules into this file. Add a rule to the matching steering file so every tool
sees it; keep this file for Copilot-specific behaviour only.

## The short version

- **Stack:** Angular 20 + Tailwind v4 + PrimeNG 20 + Tauri v2 + Cloudflare Workers (Agents SDK).
  Dev port 7322 (Phorma Code owns 7321).
- **Architecture:** agent workflows composed on a Canvas2D surface, executed by one shared
  TypeScript engine (`engine/`) that runs in-app for local debug and in a Cloudflare Durable Object
  when deployed. Rust proxies LLM calls and stores secrets.
- Standalone Angular components, OnPush, signals over RxJS.
- Tabler icons only (`ti ti-*`). PrimeIcons is uninstalled.
- Prompts are markdown, rendered sanitized (`marked` + DOMPurify), never raw `innerHTML`.
- `engine/` has zero Angular/Tauri/DOM dependencies. Model and network access go through injected
  transports.
- Never call Tauri APIs from domain code - go through `TauriService`, guarded by `isDesktop`. The app
  must work under plain `ng serve`.
- `engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts` are structural twins - change
  both or neither.
- `npm install --legacy-peer-deps` in `frontend/`.
- Never use the em dash. Use a plain hyphen.

## Copilot-specific rules

- Default to the Explore subagent for fast read-only codebase exploration before making changes.
- Prefer `replace_string_in_file` over `insert_edit_into_file` (it is faster). Include 3-5 lines of
  surrounding context so the match is unambiguous.
- After a `send_to_terminal` reply to a backgrounded command completes, the next `run_in_terminal`
  call resets cwd to the repo root - re-`cd` explicitly.
- Be concise and precise; skip generic advice. Use backticks for filenames and symbols. Break a
  request into smaller concepts before editing files.

## Non-negotiable working agreement

- After completing a feature, APPEND a terse dated bullet to `.github/agent-memory.md` under the
  right topic heading if you learned a gotcha, repeated task, verified practice, or dead end. Prune
  entries you find to be wrong. If the learning is a durable rule, put it in the matching
  `.kiro/steering/` file instead.
- Do not give much weight to development cost when making technical decisions.
- Bug fixes start with an end-to-end reproduction that matches real user interaction, so the fix
  addresses the real cause.
- Before browser E2E, read `docs/e2e-testing.md`. Build workflow state programmatically through
  `window.__phormaTest` (dev-only harness); never construct graphs by synthetic drag-and-drop.
  Reserve pixel interaction for the behaviour actually under test.
- Be picky about the UI: pixel imperfections are defects. Apply the same standard to engineering
  hygiene - a lint error, test failure, or flaky test you encounter gets fixed even if you did not
  cause it.
- Verify before claiming done: `frontend` production build (the only budget check), `engine` vitest,
  `cloud` `npm run check`, `cargo check`.
