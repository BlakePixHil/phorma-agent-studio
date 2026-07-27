# E2E Testing Guide for AI Agents

How to end-to-end test Phorma Agent Studio effectively — especially the canvas,
which is pure Canvas2D and therefore invisible to DOM-based tooling.

## The Golden Rule

> **Build state through code. Verify behavior through the UI.**

The canvas renders nodes and edges onto a single `<canvas>` element. There are
no DOM nodes to query, so Playwright cannot find, drag, or wire nodes reliably.
Synthetic pixel-coordinate drags are slow and brittle: drag thresholds swallow
small movements, click-to-add stacks nodes on the canvas centre, and port dots
are ~10px hit-targets that move whenever the layout changes.

Do NOT waste turns dragging nodes around. Use the programmatic test harness to
construct the exact workflow you need in one call, then spend your pixel
interactions on the thing actually under test (a button, a panel, a dialog, a
run's visual behavior).

Manual drag-and-drop, port wiring, and node dragging are still covered — by
**human verification**. Only test them via synthetic mouse events when the
drag/wiring interaction itself is what you are testing.

## The Test Harness: `window.__phormaTest`

Dev builds (`ng serve`, port 7322) install a programmatic API at
`window.__phormaTest`. It is absent in production builds. Every method routes
through the same `WorkflowService` mutations the real UI uses — state built
this way is indistinguishable from state built by hand, including undo
history, dirty tracking, and canvas rendering.

Call it from Playwright via `page.evaluate(...)`:

```js
const ids = await page.evaluate(() =>
  window.__phormaTest.buildWorkflow({
    nodes: [
      { key: 'trigger', catalogId: 'trigger-manual' },
      { key: 'writer', catalogId: 'agent-writer', data: { provider: 'ollama', model: 'llama3.2' } },
    ],
    edges: [{ from: 'trigger', to: 'writer' }],
  }),
);
// ids -> { trigger: 'node-...', writer: 'node-...' }
```

### Building state

| Method | Purpose |
|---|---|
| `catalogIds()` | List every palette entry id (`trigger-manual`, `agent-blank`, `flow-router`, `tool-http`, `mcp-preset:github`, …). |
| `buildWorkflow(spec)` | **Preferred.** Whole workflow in one call: nodes (by catalog id + optional `name`/`data`), edges (by node key + optional port NAMES), workflow `settings`. Replaces the current graph and auto-layouts. Returns `key → nodeId`. |
| `addNode(catalogId, {name?, data?, position?})` | Add one node. Positions auto-stagger so nothing overlaps. |
| `connect(fromId, toId, {fromPort?, toPort?})` | Wire two nodes. Ports resolve automatically (first `message-out` → first `message-in`; tool nodes wire via `tools` ports). Pass port NAMES (e.g. `"Approved"`, `"On error"`) to pick a specific branch. Throws with the available port list on mismatch. |
| `enableErrorBranch(nodeId)` | Adds the "On error" out-port to an agent and sets `errorPortId` (same as the Prompt panel toggle). Returns the port id — use its NAME `"On error"` in `connect`. |
| `updateNodeData(nodeId, patch)` | Patch kind-specific data (`prompt`, `provider`, `model`, `retry`, `fallback`, `timeoutSec`, `cron`, …). |
| `updateSettings(patch)` | Patch workflow settings (`{ timeoutMinutes: 5 }`). |
| `autoLayout()` / `clearGraph()` / `getGraph()` | Housekeeping + assertions on graph shape. |
| `fitView()` | Frame the whole graph in the viewport. `buildWorkflow` does this automatically; call it before screenshots after manual `addNode`/`connect` sequences. |
| `select(nodeId)` / `clearSelection()` | Drive the Prompt/Properties panels without clicking canvas pixels. |

### Running & observing

| Method | Purpose |
|---|---|
| `run(input?)` | Set the task input and press Run. |
| `waitForRunEnd(timeoutMs?)` | Promise resolving `'completed' \| 'failed' \| 'stopped'`. **Await this instead of `waitForTimeout` polling.** |
| `phase()` | Current run phase at any moment. |
| `trace()` | The Runs-panel trace entries (`{icon, label, detail, tone}`), e.g. assert a `node-retrying` entry appeared. |
| `nodeStates()` | Canvas ring states per node (`thinking`/`done`/`error`/…). |
| `approvals()` / `approve(nodeId, approved)` | Inspect and resolve human-approval gates. |
| `waits()` / `sendEvent(nodeId, payload)` | Inspect and resolve Wait-for-Event suspensions. |
| `questions()` / `answerQuestion(requestId, response)` | Inspect and answer Ask-User suspensions. |
| `stop()` | Stop the in-flight run. |

### Opening dialogs

| Method | Purpose |
|---|---|
| `openSettings(pageId?, anchorId?)` | Open the Settings dialog, optionally on a page (`'cloud'`, `'models'`, …) and scrolled to an anchor. |
| `closeSettings()` | Close it. |

Use these instead of clicking the menubar. Settings lives under **File →
Preferences → Settings**, a PrimeNG nested submenu that needs a real hover chain;
synthetic clicks resolve the `<li>` but never open the popup, and the `Ctrl+,`
accelerator is registered by the menubar rather than a global key handler, so it
does nothing when the canvas has focus. `openSettings('cloud')` is one call:

```js
await page.evaluate(() => window.__phormaTest.openSettings('cloud'));
await page.locator('button:has-text("Your own Cloudflare")').first().click();
```

### Recipes

**Agent with a wired error branch (EPIC 3):**

```js
await page.evaluate(() => {
  const t = window.__phormaTest;
  const ids = t.buildWorkflow({
    nodes: [
      { key: 'trig', catalogId: 'trigger-manual' },
      { key: 'main', catalogId: 'agent-blank', data: { provider: 'openai', model: 'gpt-bogus' } },
      { key: 'rescue', catalogId: 'agent-blank', data: { provider: 'ollama', model: 'llama3.2' } },
    ],
    edges: [{ from: 'trig', to: 'main' }],
  });
  t.enableErrorBranch(ids.main);
  t.connect(ids.main, ids.rescue, { fromPort: 'On error' });
  return ids;
});
```

**Run and assert on the trace:**

```js
await page.evaluate(() => window.__phormaTest.run('Say hello in five words.'));
const phase = await page.evaluate(() => window.__phormaTest.waitForRunEnd(60_000));
const trace = await page.evaluate(() => window.__phormaTest.trace());
// assert phase === 'completed', trace contains 'X retrying (attempt 2/2)…' etc.
```

**Approval gate flow:**

```js
await page.evaluate(() => window.__phormaTest.run('Draft it.'));
// wait until phase() === 'waiting-approval', then:
const [gate] = await page.evaluate(() => window.__phormaTest.approvals());
await page.evaluate(id => window.__phormaTest.approve(id, true), gate.nodeId);
```

**Ask User flow:**

```js
await page.evaluate(() => window.__phormaTest.run('Book me a table.'));
// wait until phase() === 'waiting-input', then:
const [q] = await page.evaluate(() => window.__phormaTest.questions());
await page.evaluate(id => window.__phormaTest.answerQuestion(id, 'Friday, 7pm'), q.requestId);
```

`answerQuestion` is the programmatic path. To test the UI itself, the answer
box is rendered TWICE for the same question - inline on the canvas beneath the
node (`app-ask-user-overlay`, real DOM, autofocused) and in the Runs panel card
(`textarea[data-request-id]`). Both edit one shared draft in
`RunControllerService`, so typing in one and submitting from the other is
valid. A suspended question also reveals the Runs pane and raises a persistent
"needs an answer" toast.

## Environment Notes

- Dev server: `cd frontend && npx ng serve --port 7322` (7321 belongs to Phorma Code).
- Local model: Ollama at `localhost:11434`. **Do not assume `llama3.2` is
  installed** — query `http://localhost:11434/api/tags` and use an installed
  model name, or use a stub-level engine test instead (below).
- The harness throws descriptive errors (unknown catalog id, missing port,
  incompatible roles). Read the message — it lists valid options.
- `page.evaluate` runs outside Angular; the harness re-enters the zone for
  you, so signals/CD update without extra ticks.

## When NOT to use the harness

- **Engine-only behavior** (retry logic, routing, timeouts): write a stub-model
  test in `engine/test/*.e2e.mts` instead — `npx -y tsx <file>` with a fake
  `ModelClient` is orders of magnitude faster than a browser. See
  `robustness.e2e.mts` for the pattern.
- **The drag/wiring UX itself**: that is human-verification territory, or a
  deliberate synthetic-mouse test with fresh screenshots before every
  coordinate interaction.
- **Production builds**: the harness does not exist there by design.

## Pixel-Interaction Survival Guide (when you must)

- Take a fresh screenshot before EVERY coordinate-based click — layouts move.
- Node drags need a threshold: move a few px first, then the real drag, then up.
- Port wiring: `mouse.down` exactly on the port dot, move in ≥6 steps, brief
  pause on the target dot, `mouse.up`.
- Click-to-add palette buttons drop nodes at the canvas centre — they stack.
  Prefer `addNode` with an explicit position.
- The left palette overlay intercepts clicks near the left edge; interact with
  the canvas centre-right.
- Inside the Settings dialog, Playwright's actionability checks often report the
  search box or header paragraph "intercepts pointer events" on a control that
  is plainly visible. Scroll and click in one `page.evaluate` instead:
  ```js
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.phorma-settings__provider-tab')]
      .find(b => b.textContent.includes('Phorma Cloud'));
    t.scrollIntoView({ block: 'center' });
    t.click();
  });
  ```
- Set an explicit viewport (`page.setViewportSize({ width: 1440, height: 900 })`)
  before screenshotting the studio. A shared page can carry a tiny viewport from
  earlier work, which renders as a mostly-empty dark canvas and looks like a
  rendering bug.
