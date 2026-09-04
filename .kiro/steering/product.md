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

- Ask and Plan assistant modes work without a subscription, on the default model. Composing and
  refining a plan is free; having the studio BUILD it for you is the paid capability.
- Agent mode and the Ctrl+P AI builder are Phorma Cloud exclusive, gated in the UI by
  `phormaCloud.subscribed()` and re-gated server-side by `/api/infer`.
- Applying a chat plan is gated the same way, through `WorkflowBuilderService.canAutoApply`
  (proxied as `AssistantChatService.canAutoApply`). Without a subscription the Apply button is
  absent and the plan is the deliverable: every `PlanOp` carries a `detail` with manual
  instructions, rendered as a per-step expander. Subscribers get both - the button, and the same
  expanders to check a step before applying it.
- Plan in chat is proposal-only (Apply button). Plan in the Ctrl+P palette auto-applies. That
  asymmetry is deliberate - speed is the palette's whole point.

## Purchasing (live, no longer a placeholder)

Subscribing and buying credits are real flows in the app. The "Coming soon" credit packs and the
Subscribe CTAs that only deep-linked to a settings page are gone, and the admin-token-gated
`POST /api/provision` is no longer the only way a tenant becomes `active`. Spec:
`.kiro/specs/stripe-billing/`.

- All five Subscribe CTAs start a real Stripe Checkout Session for `ENTRY_PLAN_TIER`
  (`core/plan-catalog.ts`), each paired with a secondary "See all plans" link. A context-free CTA in a
  narrow panel cannot ask which of three plans somebody wants.
- The plan cards on Settings > Cloud are the considered path. Enterprise carries no Stripe price and
  is a Contact sales link. A tenant who already HAS a subscription is routed to the Stripe Billing
  Portal and never to a second checkout, because a second Checkout Session buys a SECOND subscription
  instead of moving them between plans - and `past_due` counts as having one.
- Credit packs in the credits dialog are live and subscriber-only.
- Cancel, change plan, update card and invoice history are all the Billing Portal. We do not build
  those surfaces.
- Checkout opens through the existing `openExternal` helper and completes in an external browser, so
  the studio refreshes `/api/me` on a bounded poll (24 attempts, 5s apart, behind
  `BILLING_POLL_CONFIG`) plus a focus-triggered refresh. Nothing is inferred from the redirect: the
  worker's webhook is the only writer of subscription state.
- A `past_due` tenant keeps their plan, workflows and credits, and is offered Update card - never the
  Subscribe CTA. Refusal copy lives in one place (`core/billing-refusal.ts`) so the toast, the Ctrl+P
  palette and the chat cannot drift into three answers for one refusal.
- Credits-not-dollars still holds: a purchased pack contributes CREDITS, and the USD budget behind it
  is worker-side only.
- Every billing surface is ABSENT, not broken, on a BYO deployment, which binds no D1 and must never
  need Stripe configuration.

---

#[[file:agent.md]]
