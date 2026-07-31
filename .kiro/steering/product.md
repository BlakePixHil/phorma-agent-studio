---
inclusion: always
---

# Product context

`agent.md` is the single source of truth for what this product is. It is referenced live at the
bottom of this file, so edit `agent.md` - never restate it here. **If the reference below appears as
literal `#[[file:agent.md]]` text rather than the document itself, read `agent.md` before doing
product or design work.**

## The decision test

Every feature, refactor, or UI change must make the studio **faster**, **simpler**, or more
**powerful** without weakening the other two. If it does none of those, it does not belong.

- Faster: idea to running agent in under a minute. Defaults must be runnable. A new modal,
  wizard step, or required config before a user can run something is suspect.
- Simpler: a non-technical ops owner must understand it from looking at the canvas. Prefer
  visible state over hidden config.
- Powerful: every power feature needs a legible visual representation. Capability reachable
  only through raw JSON fails the simplicity pillar.

## Non-negotiable product rules

These are enforced across the codebase - breaking one is a regression, not a style choice.

- **Markdown prompts everywhere.** Agent prompts are markdown, rendered sanitized (`marked` +
  `DOMPurify` + `bypassSecurityTrustHtml`). Never raw `innerHTML`.
- **Tabler icons only** (`ti ti-*`). `primeicons` is uninstalled; PrimeNG components that render
  built-in icons need icon templates or `pt` overrides.
- **No Monaco, no code editors.** This is not a coding tool.
- **Browser parity.** The app must run under plain `ng serve` with no Tauri present. Native calls
  go through `TauriService` and are guarded by `isDesktop`.
- **RunEvents are the only visualization contract.** Local engine and cloud WebSocket both feed
  `RunControllerService.apply()`. New run UI consumes RunEvents, never bespoke state.
- **Credits, not dollars.** The Phorma Cloud-billed share of any cost renders as plan credits;
  only the BYO share renders USD, suffixed "(est.)" when estimated. Split on
  `phormaCloudCostUsd` everywhere (runs panel, trace, usage panel, settings).
- **Secrets stay out of the webview.** Desktop keys live in the OS keychain via `llm.rs`; the
  webview only sees a boolean. Engine requests carry the `{{API_KEY}}` placeholder that Rust
  (desktop) or `FetchModelClient` (web) substitutes. Never log or persist raw keys.
- **Bring your own everything.** Any provider, the user's own Cloudflare account, the user's own
  keys. No lock-in ceiling.

## Feature gating (current)

- Ask and Plan assistant modes work without a subscription, on the default model.
- Agent mode and the Ctrl+P AI builder are Phorma Cloud exclusive, gated in the UI by
  `phormaCloud.subscribed()` and re-gated server-side by `/api/infer`.
- Plan in chat is proposal-only (Apply button). Plan in the Ctrl+P palette auto-applies. That
  asymmetry is deliberate - speed is the palette's whole point.

---

#[[file:agent.md]]
