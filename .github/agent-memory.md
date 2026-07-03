# Agent Memory — Phorma Agent Studio

Global repo memory for AI agents working on this codebase. **Read this at the start of every session** (after [agent.md](../agent.md)). **Append to it after completing a feature** if you learned something a future agent should know: gotchas, repeated tasks, verified practices, dead ends. Keep entries terse — dated bullets under a topic heading. Prune entries that become wrong or obsolete.

---

## Tauri / Desktop Shell

- 2026-07-03 — `"dragDropEnabled": false` on the window in `backend/src-tauri/tauri.conf.json` is REQUIRED for HTML5 drag-and-drop (palette → canvas) to work in the desktop app. Tauri defaults it to `true`, which hands drops to the OS file-drop handler; `dragover`/`drop` never reach the DOM. Works in browser, silently broken in Tauri. Needs app restart to take effect.
- 2026-07-03 — Killing a spawned process on Windows: `child.kill()` only kills the `npm.cmd` wrapper, not the node child → orphan keeps the port. Use `taskkill /PID <pid> /T /F` (kill whole tree). Also kill any prior run before starting a new one.
- 2026-07-03 — Spawn long-running dev processes with env `CI=true` so CLIs fail fast instead of prompting interactively (the console is output-only).
- 2026-07-03 — Strip ANSI escape codes BOTH in Rust (output reader threads) and in the frontend console service, or artifacts like `[33m❯[39m` leak into the console.
- 2026-07-03 — AS's own dev server runs on port **7322** (`tauri.conf.json` beforeDevCommand/devUrl). Phorma Code uses 7321; don't collide.

## Build / Dependencies

- 2026-07-03 — All npm installs in `frontend/` must use `--legacy-peer-deps`.
- 2026-07-03 — Build verify loop: `cd frontend && npx ng build` and `cd backend/src-tauri && cargo check`. Keep both green after every phase.
- 2026-07-03 — `@angular/cdk` must stay at v20 to match Angular core.
- 2026-07-03 — `engine/` is consumed via the `@phorma/engine` tsconfig path alias (frontend/tsconfig.json → ../engine/src/index.ts). Angular compiles it as app source; no build step. Keep engine code framework-free.
- 2026-07-03 — `backend/` needs its OWN `npm install` (installs `@tauri-apps/cli` into backend/node_modules/.bin). Without it `npm run dev` fails with "The system cannot find the path specified".
- 2026-07-03 — `cloud/` must depend on the `ai` package: the `agents` SDK dynamically imports it, and wrangler bundling fails with "Could not resolve ai" otherwise. Verify cloud changes with `npm run check` (tsc + `wrangler deploy --dry-run`) — no Cloudflare account needed; `wrangler dev` gives a full local DO for E2E.
- 2026-07-03 — Wrangler/esbuild honors tsconfig `paths`, so `@phorma/engine` resolves in cloud/ the same way as in the frontend.
- 2026-07-03 — Rust `process.rs` runs ONLY allow-listed programs (npx/npm). Extend the allow-list deliberately; never accept arbitrary program names from the webview.
- 2026-07-03 — TS structural typing: interfaces WITHOUT index signatures are not assignable to `Record<string, unknown>`. Cross-package boundary types should use `object` + per-kind casts instead.
- 2026-07-03 — `tokio::select!` requires the tokio `macros` feature in Cargo.toml.

## UI / Styling

- 2026-07-03 — Icons are **Tabler-only** (`ti ti-*`). `primeicons` is removed; PrimeNG components that render built-in icons (select chevrons, toast close, submenu arrows, checkboxes) need icon templates/`pt` overrides — audit when adding a new PrimeNG component.
- 2026-07-03 — Specular shimmer (`::after` gradient) belongs to the LEFT panel only. Right panel, terminal, status bar are plain glass. The single hairline divider is drawn by the resize handle, not a panel border (avoid double lines).
- 2026-07-03 — Angular templates do not support arrow functions in event bindings — use a component method.
- 2026-07-03 — Literal `{` / `}` inside template attribute values (e.g. JSON placeholders) break Angular @-block parsing. Avoid braces in placeholders or use HTML entities.
- 2026-07-03 — `ToastService` has `success/warning/error/show` — there is NO `.info()`.
- 2026-07-03 — Console entry `timestamp` is an ISO string; `bottom-terminal.formatTime()` re-parses it with `new Date()`. Never store pre-formatted locale strings there.
- 2026-07-03 — PrimeNG context-menu submenus open on HOVER; Playwright synthetic clicks can't reach nested items. The palette supports click-to-add (`NodeDragService.requestAdd`) partly for this reason — keep it working.
- 2026-07-03 — Tried an SVG rainbow chasing-glow border on the prompt editor's focus state (dashed rect + hue-rotate). User rejected it on sight ("looks like shit") and it was reverted same-session. Lesson: flashy animated borders on a plain multi-line text input read as gimmicky, not premium — keep focus indication to a simple border-color change (see `.phorma-prompt__editor:focus`). Don't re-propose SVG glow effects for form inputs without being asked.

## Product Rules

- 2026-07-03 — Prompts are **markdown**. Render previews sanitized (`marked` + DOMPurify) — never raw `innerHTML`.
- 2026-07-03 — No Monaco, no code editors. This is not a coding tool.
- 2026-07-03 — Domain/engine code must not hard-depend on Tauri — the app must work in a plain browser (`TauriService.isDesktop` guards).
- 2026-07-03 — API keys: desktop keys live in the OS keychain via `llm.rs` (webview only sees a boolean); engine requests carry the `{{API_KEY}}` placeholder that Rust (desktop) or FetchModelClient (web) substitutes. Never log or persist raw keys elsewhere.
- 2026-07-03 — RunEvents are the single visualization contract: local engine AND (later) cloud WebSocket both feed `RunControllerService.apply()`. New run UI must consume RunEvents, not bespoke state.
- 2026-07-03 — Tool calling is native: agents get tool schemas from their tool-link edges via the engine's `ToolHost` (studio: `ToolHostService`; cloud: `CloudToolHost`). Tool loop max 8 rounds, results capped at 8KB.
- 2026-07-03 — MCP stdio transport is NEWLINE-DELIMITED JSON-RPC (not LSP Content-Length framing). Sessions live in Rust (`mcp.rs`), keyed by tool node id. Remote MCP uses the engine's `HttpMcpClient` (streamable HTTP; responses may be SSE or JSON — parse both).
- 2026-07-03 — Ollama's OpenAI-compat endpoint sends `finish_reason` without a `[DONE]` line — stream parsers must flush tool calls on BOTH signals.
- 2026-07-03 — Engine E2E testing: a throwaway `npx -y tsx script.mts` importing `./engine/src/index.js` against local Ollama is the fastest full-loop verification (no UI needed).
- 2026-07-03 — Web Search tool uses DuckDuckGo's free instant-answer API — topical coverage only. Swap in a keyed provider (Brave/Tavily) for production-grade search without touching the engine.

## Learnings

<!-- Append new dated learnings below, grouped under the topic headings above (create a new heading if none fits). -->
