---
inclusion: always
---

# Coding conventions

Canonical for every tool and contributor. `.github/copilot-instructions.md` points here.

## Angular

- Standalone components, `changeDetection: ChangeDetectionStrategy.OnPush`.
- Signals over RxJS: `signal()`, `computed()`, `effect()`, `linkedSignal`, `resource`. Inputs and
  outputs use `input()` / `output()`.
- Shared sidebar and panel state lives in `PanelRegistryService` (`collapsedLeft` /
  `collapsedRight` / widths). Expanded-panel state lives in `PanelExpandService`.
- Templates cannot contain arrow functions in event bindings - add a component method.
- A literal `{` or `}` inside a template attribute value breaks Angular @-block parsing. Avoid
  braces in placeholders or use HTML entities.
- Signals exposed to a template must be CALLED: `providers()` not `providers`. `ng build` catches
  it; `tsc` alone may not.
- `effect()` hazard: if the callback invokes a method that reads and writes the same signal, the
  effect loops forever and can OOM the renderer. Wrap such calls in `untracked(() => ...)`. This
  has bitten the settings dialog, the properties panel, and the command palette.
- Class field initializers cannot reference constructor parameter properties
  (`private readonly x = this.options.y`) - the field runs before the parameter is assigned.
  Assign in the constructor body.

## Styling

- Tailwind v4 utilities first; CSS variables live in `frontend/src/styles.scss`. Root font size is
  **14px**, so rem maths must be against 14 (`0.857rem` is 12px). Verify with
  `getComputedStyle(el).fontSize`, never by rem arithmetic against 16.
- Reuse the shared utility classes in `styles.scss` instead of per-panel sizing:
  `.phorma-panel-icon-btn` for panel header actions, `.phorma-input-icon-btn` for buttons flush
  beside a small input, `.phorma-btn-content` for solid `pButton`s, `.phorma-icon-spin` for
  spinners.
- SCSS overrides on PrimeNG must be scoped (`.phorma-x__foo.p-button`) and must delete the
  superseded border/background/cursor rules, or chrome doubles up.
- Do not override `font-size` on PrimeNG controls in panel SCSS - the size token drives height, so
  a hard-coded font size desynchronizes neighbouring controls.
- Never hardcode input chrome (background, border, radius, placeholder colour). Field colours come
  from `--phorma-field-*` through `core/theme-preset.ts`; hand-rolled inputs use the
  `shared/_field.scss` `chrome()` mixin. See the `frontend-ui` steering for the full recipe.

## PrimeNG

- Every control in a panel needs an explicit size: `size="small"` on `pButton`, `p-select`,
  `p-inputnumber`, `p-checkbox`, `p-selectbutton`; `pSize="small"` on `pInputText` and `pTextarea`.
  Omitting it silently renders the larger default and rows misalign by a few px.
- Never use the `icon` / `iconPos` props (they render removed PrimeIcons). Put the Tabler icon in
  the button content.
- Solid `pButton` renders an opaque `::before` overlay, so bare text nodes and static `<i>`
  children paint underneath and become invisible. Add `class="phorma-btn-content"` and wrap bare
  label text in a `<span>`. `severity="secondary"` is still solid and still affected;
  `[text]` and `[outlined]` are not.
- `[link]` is not a `pButton` input - use `[text]="true"`.
- Destructive icon buttons: `severity="secondary"` with `[outlined]` or `[text]` plus a `--danger`
  modifier that goes red only on `:hover:not(:disabled)`. A panel full of `severity="danger"`
  reads as a wall of warnings.
- Never nest a `<button>` inside a `<button>`. Put the row button and its action button as
  siblings in a flex wrapper and reveal the action on wrapper `:hover`.
- The app has zero `p-dialog` usage - dialogs are bespoke overlays following the confirm-dialog
  pattern. Every dialog carries `role="dialog"` (global key handlers depend on that probe).
- Overlay layering: expanded panels sit at `z-index: 75`, real dialogs at `80`, the confirm/prompt
  dialog at `85`, the command palette at `90`. A confirm is routinely summoned from inside another
  dialog (e.g. a delete action), so it must always outrank every real dialog, not just tie with it.

## State, storage, services

- `ToastService` has `success` / `warning` / `error` / `show`. There is no `.info()`.
- Console entry `timestamp` is an ISO string; formatting happens at render time. Never store a
  pre-formatted locale string.
- `ConfirmDialogService` covers confirm and `prompt()` (single text input) - reuse it for any
  rename or naming flow. Do not read `activeState()` in the `.then()` callback; it is already
  cleared. Use the resolved value.
- `HistoryService.boundaryOnce()` forces the next graph mutation into a fresh undo step - use it
  for atomic multi-step replacements.
- Workflow-scoped config belongs in `WorkflowSpec.settings` (both type twins) and is edited in the
  Properties panel's no-selection state.

## Engine purity and platform boundaries

- `engine/` has zero Angular, Tauri, DOM, or Node dependencies. Model and network access go
  through injected transports (`ModelClient`, `ToolHost`, `DataFetcher`, `SqlHost`,
  `WorkflowStateStore`, `FixtureStore`).
- Domain code never calls Tauri directly - go through `TauriService` and guard with `isDesktop`.
- Any outbound HTTP from the engine must set a `User-Agent`. Several public APIs reject UA-less
  requests and the failure is silent because JSON parsing masks the error body.
- Interfaces without an index signature are not assignable to `Record<string, unknown>`.
  Cross-package boundary types use `object` plus per-kind casts.

## Language and formatting

- **Never use the em dash.** Use a plain hyphen. Applies to code, comments, docs, and commits.
- Prettier config lives in `frontend/package.json`: `printWidth: 100`, `singleQuote: true`.
- Backticks around filenames and symbols in prose. Be concise and specific; skip generic advice.
