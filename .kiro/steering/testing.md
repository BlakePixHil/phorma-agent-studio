---
inclusion: auto
name: testing
description: How to test Phorma Agent Studio - the window.__phormaTest browser harness, Playwright and canvas pitfalls, engine vitest and fast-check property tests, tsx scenario scripts, and reproducing bugs end to end. Include when writing or running any test, debugging a reported bug, driving the app in a browser, or verifying a UI change.
---

# Testing

## Pick the cheapest level that proves the behaviour

| Behaviour | Where it belongs |
|---|---|
| Pure logic (expressions, retry, redaction, state, pricing, data nodes) | `engine/src/*.spec.ts` with vitest, plus a `fast-check` property test when a claim is universal |
| Engine orchestration (routing, retry/fallback, journal replay, for-each, approvals, waits) | `engine/test/*.e2e.mts` run with `npx -y tsx`, fake `ModelClient`, assertions on the `RunEvent` list |
| Cloud worker routes, projection, embed, deploy config | `cloud/` test scripts (`npm test`) and `wrangler dev` |
| Angular services and pure helpers | `frontend/**/*.spec.ts` (karma + jasmine) |
| Studio behaviour a user can see | browser E2E against `ng serve` on 7322, using `window.__phormaTest` |
| Manual drag, port wiring, node dragging UX | human verification, or a deliberate synthetic-mouse test with fresh screenshots |

A browser is the most expensive option. Reach for it only when the thing under test is the UI.

## Reproduce before you fix

For a bug fix, reproduce end to end as close to real user interaction as possible first. A fix
written against an assumed cause usually moves the symptom. Build the state with the harness, then
drive the actual surface the user touches.

## Stubbing AI features in the browser

- Get the component instance with `window.ng.getComponent(el)`, then replace the transport:
  `cmp.builder['transport'] = { create: () => ({ stream: async function* () { ... } }) }`.
  The builder is a singleton, so one stub covers the palette, chat, and analyzer paths.
  `FieldGenerationService` holds its own `transport` reference - stub `cmp.fieldGen['transport']`
  separately on the prompt panel.
- Force a subscription with `pc.profile.set({status:'active', tier:'pro', ...})`; `subscribed()`
  reads `profile()?.status`. Also stub `phormaCloud.refresh = async () => {}` or the post-run
  refresh wipes the fake profile.
- A profile alone does NOT render the billing surfaces - they sit behind Clerk. `phormaCloud.user`
  is `toSignal(clerk.user$)` and `signedIn` is computed off it, so neither takes a `.set()`: push a
  fake user into the subject (`pc.clerk.user$.next({id:'user_probe'})`), with `refresh` stubbed
  FIRST or the constructor effect fires a real `/api/me`. Then pin the gates themselves
  (`pc.signedIn = () => true`, plus `cmp.clerkUser = () => user` on the settings dialog): real Clerk
  finishes loading a second later, emits null, and tears the panel back down mid-probe.
- `palette.mode()` persists in localStorage. Set the mode explicitly, or a Plan-mode stub fed to an
  Agent-mode session yields text with no tool calls and zero nodes.
- Both sidebars render duplicate pane instances, so `document.querySelector('.phorma-...')` can hit
  the hidden one with a zero rect and stale computed styles. Filter by
  `getBoundingClientRect().width > 0`.
- Seed usage rows by writing fake `UsageLedgerEntry` records into the IndexedDB `usage` store and
  clicking the panel refresh - no model calls needed.

## Verifying UI without eyeballing

- A solid `pButton` whose label is buried under the PrimeNG `::before` overlay reports **zero**
  pixels with all channels > 200. Screenshot the element, draw it to a canvas, count bright pixels.
- Duplicate element ids: `document.querySelectorAll('[id]')` total must equal the unique count.
- Collapsed flex children: compare `getBoundingClientRect().height` against `scrollHeight`.
- Font floors: measure `getComputedStyle(el).fontSize`; never trust rem arithmetic (root is 14px).
- Downloads: stub `URL.createObjectURL` to capture the blob and `HTMLAnchorElement.prototype.click`
  to a no-op, then `await blob.text()`.

Related skills: `.github/skills/javascript-typescript-jest/SKILL.md`,
`.github/skills/harness-engineering/SKILL.md`, `.github/skills/angular-developer/references/`
(`testing-fundamentals.md`, `component-harnesses.md`, `e2e-testing.md`, `router-testing.md`).

---

`docs/e2e-testing.md` is referenced live below - the full harness API, recipes, and the
pixel-interaction survival guide. **If it appears as literal `#[[file:...]]` text rather than the
document itself, read `docs/e2e-testing.md` before driving the app in a browser.**

#[[file:docs/e2e-testing.md]]
