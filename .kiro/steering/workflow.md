---
inclusion: always
---

# How to work in this repo

## Where knowledge lives

| Need | Source |
|---|---|
| What the product is, vocabulary, non-goals | `agent.md` (inlined by the `product` steering) |
| Stack, commands, verify loop | `tech` steering |
| Repo map, twins, registry pattern | `structure` steering |
| Coding rules | `conventions` steering |
| Accumulated gotchas and verified practices | `.github/agent-memory.md` (`agent-memory` steering) |
| Area detail (frontend, engine, desktop, cloud) | fileMatch steering files, loaded with those files |
| Browser and engine E2E technique | `docs/e2e-testing.md` (`testing` steering) |
| Release, versioning, updater | `release` steering |
| Skill packs available in-repo | `skills` steering |
| In-flight and shipped feature specs | `.kiro/specs/<feature>/{requirements,design,tasks}.md` |

Deeper long-form docs: `docs/portal.md`, `docs/integrations-and-aws-deployment.md`,
`docs/heym-research.md`, `mcp/phorma-practice-mcp/README.md`.

## Before implementing

1. Check `.github/agent-memory.md` for the topic heading covering your area. It records verified
   fixes, dead ends, and rejected approaches - it will save you a re-litigated mistake.
2. Read the code you are about to change. This codebase has non-obvious invariants (structural
   twins, journal replay safety, DI cycles, duplicate panel instances in the DOM).
3. For anything multi-file or architectural, check `.kiro/specs/` for an existing spec, or propose
   one rather than improvising a design.

## While implementing

- Break the request into concepts before editing files.
- Follow existing patterns over introducing new ones. If a shared rail exists
  (`ConfirmDialogService`, `AssistantChatService.sendTask`, `PanelExpandService`,
  `LocalAgentRouterService.connectNodes`), use it instead of new plumbing.
- Do not weigh development cost heavily in technical decisions. Correct beats cheap.

## Bug fixes start with a reproduction

Reproduce the bug end to end, as close to real user interaction as possible, before fixing it.
This is how you find the actual cause instead of patching a symptom. Read the `testing` steering
or `docs/e2e-testing.md` before any browser work: build workflow state programmatically through
`window.__phormaTest`, and spend pixel interactions only on the behaviour under test.

## Verification is not optional

Run the checks in the `tech` steering that cover what you touched: frontend production build,
`engine` vitest suite, `cloud` check, `cargo check`. A change is not done until they are green.

Hold the same bar for quality signals you did not cause: a lint error, a failing test, or a flaky
test you happen to see gets fixed, not stepped around. When verifying UI, be picky - pixel
imperfections are defects.

## Update the memory when you learn something

After completing work, append a terse dated bullet to `.github/agent-memory.md` under the right
topic heading if you learned a gotcha, a repeated task, a verified practice, or a dead end. Prune
entries you discover to be wrong. Format:

```
- 2026-07-31 - <what to do or avoid, and why it bit us>
```

If a learning is a durable rule rather than a war story, put it in the matching steering file
instead so it is always loaded.

## Keeping the steering docs honest

The steering files are the always-on context, so stale content here is worse than none. When a
convention, command, budget, or architectural boundary changes, update the steering file in the
same change. `product` inlines `agent.md` and `agent-memory` inlines `.github/agent-memory.md`
through `#[[file:...]]` references, so those two stay in sync automatically - edit the source
files, not the wrappers.
