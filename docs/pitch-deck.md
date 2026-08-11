# Phorma Labs - Pitch Materials

Blake Linnell &middot; blakelinnell96@gmail.com &middot; Melbourne, Australia
Prepared for pre-seed conversations (Blackbird, AirTree, Startmate, angels).

**The presentable deck is `docs/pitch-deck.html`.** Single file, no dependencies, works offline.
Arrow keys or click to navigate, `G` for the slide grid, `F` for fullscreen. 11 slides. Export to PDF
with Ctrl+P (landscape, background graphics on, margins none) or headless:

```powershell
chrome.exe --headless=new --no-pdf-header-footer --print-to-pdf="c:\path\phorma-deck.pdf" `
  "file:///c:/Dev/phorma/phorma-agent-studio/docs/pitch-deck.html"
```

**One asset to drop in:** save the canvas screenshot as `docs/assets/canvas-run.png` and slide 4
picks it up. Until then that slide shows a labelled placeholder rather than a broken image. See
`docs/assets/README.md` for framing notes - the frame crops with `object-fit: cover` anchored to the
top, so keep the important nodes in the upper two thirds.

---

## Company Description

### Short (about 50 words - application form field)

Phorma Labs builds Phorma Agent Studio, a desktop studio where teams design multi-agent AI
workflows on a canvas, debug them live with breakpoints and full run traces, and deploy the
identical engine to their own Cloudflare account. Visual like n8n, debuggable like an IDE,
agent-native by design.

### Medium (about 120 words - deck appendix, data room, investor update header)

Phorma Labs is an Australian software company building Phorma Agent Studio: the studio and runtime
for multi-agent AI systems. Agents are nodes on an infinite canvas, handoffs are edges that light up
as work flows through, and every run can be paused, stepped and replayed with a full trace, the way
an IDE debugs code. One TypeScript engine executes a workflow locally on the desktop and inside a
Cloudflare Durable Object in production, so what a team tests is byte-identical to what ships.
Model access is bring-your-own-key across Anthropic, OpenAI, Gemini, OpenRouter and local Ollama,
and any Model Context Protocol server becomes a draggable tool node. The studio is free; Phorma
Cloud sells the managed control plane on a credit-based subscription.

### One-line descriptor (directory listings, intro emails)

Phorma Agent Studio - the visual studio and debugger for multi-agent AI workflows.

---

## Elevator Pitch

### 30 seconds (spoken)

Every company is trying to put AI agents into their operations, and nobody can see what those
agents are actually doing. Engineers build them in code and debug with print statements. Ops teams
get handed a black box. Phorma Agent Studio puts agents on a canvas where you watch them think in
real time, pause and step through a run like a debugger, replay any run from its full trace, then
deploy the exact same engine to your own cloud with one click. n8n can replay what already happened.
LangGraph gives you a debugger, in code, for engineers. We give the whole team a live agent run they
can drive.

### 15 seconds (cold open, hallway)

Phorma is the visual studio and debugger for AI agents. You build agents on a canvas, watch every
run happen live, step through it like code, then ship the identical engine to your own cloud.

### Written intro email version

Hi [NAME] - I am Blake Linnell, founder of Phorma Labs in Melbourne.

Teams are shipping AI agents into real operations and have almost no way to see what those agents
did. Engineers debug with log greps; ops teams get a black box.

Phorma Agent Studio is a desktop studio where agents are nodes on a canvas. You watch runs happen
live, pause and step through them with breakpoints, replay any past run from its full trace, and
deploy the identical engine into your own Cloudflare account. Same engine local and in production,
bring your own model keys, any MCP server becomes a tool node.

I built the studio and the cloud runtime, four packages and about 100k lines, in six weeks, and it
ships as signed installers on macOS, Windows and Linux today. Two teams have already committed to
pay before a payment page exists, including an accounting firm running it against day-to-day
operations.

Worth 30 minutes? Happy to run a live multi-agent workflow for you on the call.

---

## The 11 slides

| # | Slide | The one thing it has to land |
|---|---|---|
| 1 | Title | Open with the demo, not this slide |
| 2 | Problem | Agents are in production and invisible, with a named customer saying so |
| 3 | Why now | The category is proven and the labs handed the visual layer back |
| 4 | Canvas | Show it running. Do not describe it |
| 5 | Debugger | The wedge: live run control plus evals on the same graph |
| 6 | Local to cloud parity | What you test is byte-identical to what ships |
| 7 | Competition | Honest about n8n, then sharp about the gap |
| 8 | Who buys | Engineers land, ops expand, two teams already committed |
| 9 | Business model | Free studio, paid control plane, the journal is the moat |
| 10 | Why me | Velocity plus an existing line to the operations buyer |
| 11 | The ask | $1.2M, 18 months, three milestones |

---

## How the $1.2M was sized

Not a round number picked for comfort. The bottom-up plan for 18 months in Melbourne:

| Line | 18-month cost |
|---|---|
| Founder salary, below market | ~$195k |
| Product sales hire from month 2, package plus commission | ~$215k |
| Senior engineer from month 6 | ~$210k |
| Cloud, inference subsidy for the zero-key first run, code signing, tooling | ~$110k |
| Go-to-market programs, content, one US conference trip | ~$150k |
| Legal, accounting, insurance, IP | ~$55k |
| Contingency, roughly 10% | ~$95k |
| **Total** | **~$1.03M** |

$1.2M gives 18 months with genuine buffer rather than 18 months of hoping nothing slips.

**Market context that makes the number defensible.** The median Australian angel and pre-seed round
in 2026 is $1.3 million ([Cut Through Ventures, via Capital Brief](https://www.capitalbrief.com/newsletter/outlier-status-8cc343bf-0999-412d-a404-2660b83c8921/)),
so $1.2M sits just under the median rather than reaching above it. Early-stage deal flow is also
tight: Q2 2026 saw the lowest sub-$5M deal count since Cut Through began collecting data in 2020, a
44% drop on the 2025 quarterly average ([Forbes Australia](https://www.forbes.com.au/news/entrepreneurs/vc-funding-dries-up-for-australian-startups-even-as-ai-hype-grows/)).
A lean, tightly-justified ask is the right posture in that market. Content was rephrased for
compliance with licensing restrictions.

**Milestones the round buys.** Month 6: billing and analytics live, 25 paying teams, $2.5k MRR.
Month 12: 120 paying teams, $12k MRR, 800 weekly active. Month 18: 250+ paying teams, $25k MRR
($300k ARR run-rate), 40% week-4 retention - a credible seed-stage position.

---

## Slide 3 credibility check

Two of the four cards are externally verifiable and two are arguments. Know which is which.

**Verifiable.** n8n's $180M Series C led by Accel
([PitchBook](https://pitchbook.com/news/articles/openai-agentkit-vc-not-worried)) proves the category
is venture-scale. OpenAI's own AgentKit page carries the wind-down notice for Agent Builder, off the
platform 30 November 2026 ([openai.com](https://openai.com/blog/introducing-agentkit)). That is a
dated, stranded cohort, and it is the single best "why now" you have.

**The counter-argument you must pre-empt.** A sharp partner will say the labs killed Agent Builder
because nobody wanted a visual agent builder. Answer with the pairing: n8n's $180M says the demand
exists outside the labs, and the wind-down pushes those users toward a code SDK they cannot use. The
demand did not evaporate; it got orphaned.

**Arguments, not facts.** "MCP dissolved the connector moat" cuts both ways, since n8n gets MCP too.
The honest form, which is the version on the slide, is that integration breadth is now table stakes
for everyone, so the contest moves to the run experience. Card 4 leans on Optimised Accounting as
evidence that the production buyer is already non-technical. That card is only as strong as your
design-partner list, so keep growing it.

---

## Slide 7 credibility check - you were right about n8n

n8n does have debugging, and claiming otherwise would have cost you the room. Per
[n8n's own docs](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions),
their *Debug in editor* feature loads a previous execution's data into the current workflow and pins
it into the first node so you can fix and re-run. They also ship execution history, data pinning, and
AI evaluations. It is real tooling, and it is a paid feature on Cloud and registered Community plans.
Content was rephrased for compliance with licensing restrictions.

So the slide no longer claims a binary "n8n cannot debug." It splits the column in two:

- **Inspect a past run** - n8n yes, vendor builders yes, code SDKs via external tooling. Not a
  differentiator, so do not pretend it is one.
- **Pause, step, breakpoint a live run** - this is ours. You cannot hold an n8n execution at node
  three, read what the agent decided, and step it forward.

Frame the gap as architectural rather than as a missing feature: their unit of work is an execution
log, ours is a run you can drive. That is why retrofitting it is expensive for them, and it is the
answer to "what stops n8n from shipping this next quarter."

Expect follow-ups on Langflow, Flowise, Dify, Sim and Gumloop. Know each one's specific gap and
answer in a sentence. Never claim a column you cannot demo on the call.

---

## Questions to have answers ready for

1. **"Where does value accrue if everything is bring-your-own?"** The run journal and cross-model
   eval history, shared across a team. Not the token markup. Say it before they ask.
2. **"You are reselling inference at margin."** Partly, today. Cloudflare unit cost is negligible per
   run, so margin is not infra-constrained, and the subscription is the control plane, not the tokens.
3. **"Ops teams do not install desktop apps."** Correct, which is why engineers land and ops expand.
   The canvas is the expansion mechanism, not the acquisition one.
4. **"Why hire sales before engineering?"** The product is further ahead than the pipeline. That is an
   unusual position for a pre-seed company and it dictates the hire order.
5. **"What is the focus story?"** Have one sentence covering Phorma Labs, Phorma Code and the other
   Phorma products.
6. **"Why you?"** Six weeks to a shipped four-package stack, seven years shipping under deadline
   pressure, and an existing line into the operations buyer.

---

## Before you send it

1. Save the canvas screenshot to `docs/assets/canvas-run.png`.
2. Instrument the app. Installs, first-run-completed, week-1 and week-4 return, workflows deployed.
   Every day without this destroys evidence you cannot recover later.
3. Wire Stripe, then convert the two committed teams. Two paying customers beats two interested ones
   by a wide margin, and it makes the month-6 milestone believable.
4. Get written permission from David Markovski to use the quote and the Optimised Accounting name.
5. Rehearse the demo on a plane-mode laptop against local Ollama. A demo that needs wifi and an API
   key will fail in the room.
