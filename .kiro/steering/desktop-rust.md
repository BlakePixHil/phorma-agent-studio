---
inclusion: fileMatch
fileMatchPattern: ["backend/**/*.rs", "backend/src-tauri/**/*.json", "backend/src-tauri/Cargo.toml", "frontend/src/app/core/tauri.service.ts"]
---

# Desktop shell (Tauri + Rust) detail

`backend/src-tauri/src/` is the native surface: `llm.rs` (streaming LLM proxy + OS keychain),
`process.rs` (spawning), `mcp.rs` (stdio MCP sessions), `oauth.rs`, `sql.rs`, `data.rs`,
`ollama.rs`, `commands.rs`, `lib.rs`.

## Rules

- `Cargo.toml` sets `unsafe_code = "forbid"`. No `unsafe` blocks - use a safe crate (for example
  `sysinfo` for disk space) instead of FFI.
- `process.rs` runs ONLY allow-listed programs (npx, npm, uvx). Extend the allow-list deliberately;
  never accept an arbitrary program name from the webview.
- API keys never enter the webview. The webview sees booleans; `llm.rs` substitutes the
  `{{API_KEY}}` placeholder. MCP keychain scopes are `mcp:{nodeId}:{envKey}` and
  `mcp:preset:{presetId}:{envKey}`, both passing the `mcp:` prefix validation in `llm.rs`.
- Strip ANSI escape codes in BOTH the Rust output reader threads and the frontend console service,
  or artifacts like `[33m` leak into the console.
- Spawn long-running dev processes with `CI=true` so CLIs fail fast instead of prompting - the
  console is output-only.
- Killing a spawned process on Windows: `child.kill()` only kills the `npm.cmd` wrapper and orphans
  the node child, which keeps the port. Use `taskkill /PID <pid> /T /F` and kill any prior run
  before starting a new one.

## Streaming command pattern

Copy `llm.rs`: a `tauri::Emitter` global event with a `{requestId, kind, data?}` payload, and
cancellation through a `tokio::sync::watch` channel held in a `Mutex<Option<HashMap>>`. Iterate
`bytes_stream()` with flat `match` arms (`Some(Ok(bytes))` / `Some(Err(e))` / `None`) - nested
`if let` plus `while let` trips type inference on `Bytes`.

Cargo features that are easy to miss: `reqwest` needs `json` (without it, `.json()` is missing and
the compiler reports misleading `[u8]: Sized` errors on stream iteration), and `tokio::select!`
needs the `macros` feature.

## MCP transport

stdio MCP is NEWLINE-DELIMITED JSON-RPC, not LSP `Content-Length` framing. Sessions live in
`mcp.rs`, keyed by tool node id; `mcp_connect` resolves node-scoped secrets first, then preset
scope. Remote MCP goes through the engine's `HttpMcpClient` (streamable HTTP - responses may be SSE
or plain JSON, parse both).

## tauri.conf.json

- `"dragDropEnabled": false` on the window is REQUIRED for HTML5 drag and drop (palette to canvas).
  Tauri defaults it to `true`, which routes drops to the OS file-drop handler so `dragover` and
  `drop` never reach the DOM. It works in the browser and is silently broken in the desktop app.
  Changing it needs an app restart.
- `beforeDevCommand` / `devUrl` pin port 7322.
- Updater: `bundle.createUpdaterArtifacts: true` plus a `plugins.updater` block with `pubkey` and
  endpoints, and `windows.installMode: "quiet"` so the NSIS updater runs silently instead of showing
  a progress installer. The signing private key at `backend/src-tauri/.tauri/updater.key` is
  gitignored and must never be committed.

## Updater JS API

`check()` returns an update object or null. Both `update.download(onEvent)` and
`downloadAndInstall(onEvent)` take an optional progress callback with `Started`
(`data.contentLength`), `Progress` (`data.chunkLength`, accumulate yourself) and `Finished` events.
`UpdateService` deliberately uses `download()` only, then prompts, then `install()` plus `relaunch()`
- `downloadAndInstall()` runs the installer immediately on Windows. On Windows `install()` exits the
app itself; `relaunch()` covers macOS and Linux.

## Verification

`cd backend/src-tauri; cargo check` (or `scripts/build-rust-debug.cmd`). Keep it green alongside the
frontend build after every phase of work.

Related skill: `.github/skills/rust-best-practices/SKILL.md`.
