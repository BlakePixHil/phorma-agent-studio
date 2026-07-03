# Phorma Agent Studio — Copilot Instructions

## Before You Start
Read `agent.md` in the project root for the full product vision, target audience, and core vocabulary before writing any code or making design decisions. Then read `.github/agent-memory.md` — the global agent memory — for accumulated gotchas and verified practices.

## Project Context
- **Stack:** Angular 20 + Tailwind CSS v4 + PrimeNG v20 + Tauri v2 + Cloudflare Workers (Agents SDK)
- **Architecture:** Agent orchestration platform — workflows of AI agents composed on an infinite Canvas2D surface, executed by a shared TypeScript run engine (`engine/`) that runs both in-app (local debug) and in a Cloudflare Durable Object (deployed). Rust backend proxies LLM calls and stores secrets.
- **Dev port:** 7322 (Phorma Code uses 7321)

## Coding Conventions
1. **Angular:** Use standalone components with OnPush change detection. Use signals over RxJS where possible.
2. **Styling:** Use Tailwind CSS v4 utility classes. CSS variables are defined in `src/styles.scss`.
3. **State:** Prefer signals (`signal()`, `computed()`, `effect()`) for local state. Use `PanelRegistryService` for shared sidebar/panel state.
4. **Sidebar/Panel System:** Collapse state lives in `PanelRegistryService` (`collapsedLeft`/`collapsedRight` signals). Both sidebars receive all pane templates in `app.html` — only those matching `sideTabs()` render.
5. **Icons:** Tabler icons ONLY (`ti ti-*` classes). Never use PrimeIcons (`pi pi-*`) — the package is removed. PrimeNG built-in icons must be overridden via icon templates/`pt`.
6. **Prompts:** All agent prompts are markdown. Render previews sanitized (marked + DOMPurify), never raw `innerHTML`.
7. **Engine purity:** Code in `engine/` must have zero Angular/Tauri/DOM dependencies — it runs in the browser AND in Cloudflare Workers. Model/network access goes through the injected transport.
8. **Web compatibility:** Never call Tauri APIs directly from domain code — go through `TauriService` and guard with `isDesktop`. The app must function under plain `ng serve`.

## Language & Tone
- Be concise and precise. Avoid generic advice.
- Use proper Markdown formatting with backticks for filenames and symbols.
- When implementing features, break down the request into smaller concepts before editing files.

## Agent Rules
- Always read `agent.md`, `copilot-instructions.md`, and `.github/agent-memory.md` at the start of a conversation.
- After completing a feature: if you learned a gotcha, repeated task, or verified practice a future agent should know, APPEND a terse dated bullet to `.github/agent-memory.md` under the right topic heading. Prune entries you discover to be wrong.
- Default to the Explore subagent for fast read-only codebase exploration before making changes.
- Prefer `replace_string_in_file` over `insert_edit_into_file` for edits (it's faster).
- When editing, include 3–5 lines of surrounding context to ensure unambiguous matches.
- Use `npm install --legacy-peer-deps` when installing Node packages.
- Never use the em dash "—". Use plain dash "-" instead.
- When making technical decisions, do not give much weight to development cost.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user will use it. This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
- Apply that same high standard to engineering excellence: lint, test faliure, and test flakiness. If you see one, even if it is not caused by what you are working on right now, still get it fixed.