---
inclusion: always
---

# In-repo skill packs

The repo carries vendored skill packs written for other agent tools. Kiro does not load them
automatically, so treat this as an index: when a task matches a row, read that `SKILL.md` (and its
`references/` folder) before working. They are deeper than general knowledge and current for the
versions this repo pins.

`.agents/skills/` is synced from upstream repos and tracked by `skills-lock.json` - do not hand-edit
those files. `.github/skills/` holds Copilot-oriented packs.

## Frontend and UI

| Pack | Use for |
|---|---|
| `.agents/skills/angular-best-practices-primeng/` | Angular + PrimeNG patterns as this repo applies them |
| `.agents/skills/tailwind-4-docs/` | Tailwind v4 utilities, config, v3-to-v4 migration, `references/gotchas.md` |
| `.agents/skills/scss-best-practices/` | SCSS structure and maintainability |
| `.github/skills/angular-developer/` | 37 reference docs: signals, `linkedSignal`, `resource`, effects, DI, routing, forms (reactive, template-driven, signal forms), ARIA, animations, styling, testing, CLI |
| `.github/skills/frontend-design/`, `premium-frontend-ui/`, `frosted-glass-modern-theme/` | Visual craft, motion, glassmorphism tokens |

## Backend, cloud, platform

| Pack | Use for |
|---|---|
| `.github/skills/cloudflare/agents-sdk/` | Agent class, state, callable RPC, WebSockets, scheduling |
| `.github/skills/cloudflare/durable-objects/` | DO patterns, SQLite storage, alarms, wrangler config |
| `.github/skills/cloudflare/workers-best-practices/` | Streaming, floating promises, global state, bindings, observability |
| `.github/skills/cloudflare/wrangler/` | Correct wrangler command syntax before running it |
| `.github/skills/cloudflare/platform/`, `email-service/`, `sandbox-sdk/`, `web-perf/` | Broader Cloudflare surface, transactional email, sandboxed execution, Core Web Vitals audits |
| `.github/skills/rust-best-practices/` | Rust in `backend/src-tauri/` |
| `.github/skills/clerk*/` (5 packs) | Clerk auth: setup, custom UI, backend API, CLI |

## Process and quality

| Pack | Use for |
|---|---|
| `.github/skills/security-review/` | Data-flow security review, secrets, injection, access control |
| `.github/skills/refactor/` | Surgical behaviour-preserving refactors |
| `.github/skills/javascript-typescript-jest/` | JS/TS test structure and mocking strategy |
| `.github/skills/harness-engineering/` | Turning repeated agent mistakes into durable repo instructions |
| `.github/skills/conventional-commit/` | Commit message format |
| `.github/skills/create-implementation-plan/` | Plan documents (prefer `.kiro/specs/` for spec-driven work) |
| `.github/skills/acquire-codebase-knowledge/`, `architecture-blueprint-generator/` | Repository-level discovery and architecture documentation, only when explicitly asked |
| `.github/skills/github-issues/` | Issue creation and field management via MCP |
