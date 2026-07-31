---
inclusion: fileMatch
fileMatchPattern: ["frontend/**/*.ts", "frontend/**/*.html", "frontend/**/*.scss", "frontend/angular.json"]
---

# Frontend and UI detail

Baseline rules are in the `conventions` steering. This file covers the surfaces that have already
produced regressions.

## Theme and shell

- Dark shell is obsidian/violet, not blue charcoal: `:root.app-dark` neutral surfaces use hue ~275
  at very low chroma (canvas `#0c0a10`, card `#130f18`, node `#17131d`, glass
  `rgba(19,15,25,0.88)`). Selection accents stay on `--phorma-accent-blue`.
- Palettes: Iris (purple, default, 500 = `#8578f6`), Azure, Emerald, Monochrome. Retired ids
  migrate in BOTH `app.config.ts` (`readInitialPaletteRamp`) and `theme.service.ts`
  (`readInitialPalette`) - keep the two migrations in sync.
- The saved palette must be seeded synchronously in `app.config.ts` via
  `definePreset(Aura, { semantic: { primary: ramp } })`. `updatePrimaryPalette()` in the
  `ThemeService` constructor does not affect first paint and causes a flash.
- All chrome panels (toolbar, both sidebars, terminal, status bar) are plain frosted glass. The
  specular shimmer `::after` gradients were deliberately removed. The single hairline divider is
  drawn by the resize handle, not by a panel border - do not add one.
- Sidebar widths: default 320 (`DEFAULT_PANEL_WIDTH`), min 220, max 640. Hydrate per-side width in
  `ngOnInit` (after the `side` input is bound, before `ngAfterContentInit` writes back), or startup
  clobbers the saved width.
- PrimeNG v20 button CSS variables are severity-prefixed (`--p-button-primary-background`). There
  is no generic `--p-button-background`. For an overlay that tracks the computed background use
  `background-color: inherit` plus a `linear-gradient` background image - `color-mix` cannot
  resolve `inherit`.

## Layout traps

- A direct child of a `display: flex; flex-direction: column` scroll container needs
  `flex-shrink: 0`, or it collapses to its header height while `overflow: auto` hides the rest.
  Symptom: `getBoundingClientRect().height` far below `scrollHeight` on a card that looks empty.
- Use `flex: 1 0 auto` (grow, never shrink) on a scrolling panel's grow section; plain `flex: 1`
  resolves to `1 1 0%` and lets trailing content overflow into the next heading.
- Do not use `float: right` for a trailing action in a section heading - make the label a flex row
  and give the button `margin-left: auto`.
- Sidebar list rows with hover-revealed actions: wrap the buttons in a `__row-actions` container
  that collapses to `width: 0; opacity: 0; overflow: hidden` and expands on row `:hover`.
  `opacity: 0` alone still occupies layout and truncates the row title early. The skills panel is
  the canonical implementation.
- Tab strips wrap (`flex-wrap`); do not reintroduce `overflow-x-auto` + `whitespace-nowrap`.

## Shared panel bodies

Panels shared between a sidebar and an expanded dialog must take a `scope` input and route every
`id` / `for` / `inputId` through an `id(suffix)` helper - both instances live in the DOM at once,
so static ids duplicate and break every label association. Verify with
`document.querySelectorAll('[id]')`: total must equal the unique count. `PropertiesForm` and
`AgentConfig` are the references; panel and dialog then differ only by a
`layout: 'stack' | 'grid'` input.

To add an expandable panel: add the id to `ExpandablePanelId`, add a `ti ti-arrows-maximize`
`.phorma-panel-icon-btn` calling `panelExpand.open(id)`, and host the dialog in `app.html` inside
`@defer (on immediate)`.

## Canvas overlays

Canvas-anchored overlays (thinking, ask-user, MCP warnings, AI review bar) reposition off a
`transformTick` bumped in `engine.onAfterDraw`, gated on overlays existing. A new overlay type must
add its presence check to that gate in `graph-canvas.ts` or it will not track pan and zoom.

Layout and fit: `layeredLayout` treats handoff edges as the only flow edges; tool nodes float below
the flow row. The fit rail is `CanvasStateService.zoomCommand` (the canvas effect consumes and
nulls it).

## Charts

- Chart options must be a `computed()` whenever an axis bound depends on loaded data. A static
  class field is evaluated at construction while the signals are still empty, so the bound stays
  wrong forever.
- Cap a secondary-axis bar series (for example `max: maxValue * 4`) or it fills the plot and buries
  the primary line.
- Never label a time series date-only when points can share a day. Add the clock time when
  `new Set(days).size < days.length`.
- chart.js is ~240KB: both the `<p-chart>` and its pane template stay inside
  `@defer (on immediate)`.

## Downloads and blobs

Defer `URL.revokeObjectURL(url)` with `setTimeout(..., 0)` after `link.click()`, or the blob can be
invalidated before the browser reads it.

## Historic data in the UI

Ledgers outlive the graph, so historic rows routinely reference deleted nodes. Resolve unknown ids
to an explicit "Deleted node - <short id>" label and make those rows non-clickable. A raw
`node-ms4b...` id in a table reads as a rendering bug.

## Rejected ideas - do not re-propose

Animated SVG rainbow glow borders on form inputs (tried on the prompt editor, rejected on sight and
reverted the same session). Keep focus indication to a border-color change. The rainbow ring
remains valid only where it already exists: the agents palette and the command palette input.

## Related skills

`.agents/skills/angular-best-practices-primeng/SKILL.md`,
`.agents/skills/scss-best-practices/SKILL.md`, `.agents/skills/tailwind-4-docs/SKILL.md`,
`.github/skills/angular-developer/` (37 reference docs on signals, forms, DI, routing, ARIA,
testing), `.github/skills/frosted-glass-modern-theme/`, `.github/skills/premium-frontend-ui/`.
