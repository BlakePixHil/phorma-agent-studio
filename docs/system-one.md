# System One (TypeSafe Jev)

System One is TypeSafe's typed decision model, Jev. It answers narrow questions about a piece of
text with calibrated probabilities instead of generated prose:

- **Yes/no (Noul)** returns P(yes), for example `0.93`.
- **Choice** returns one option out of up to 255, with a distribution and a confidence.
- **Score** returns a value on a 2-10 level scale, with a legend and a confidence.

It costs $0.042 per million input tokens. Output tokens are free. The same model version always
returns the same answer, which makes it cheap enough to put on every hop of a workflow and stable
enough to test against. Official docs: <https://docs.typesafe.ai/concepts/system-one>.

## Where the studio uses it

| Feature | Where | What it asks |
|---|---|---|
| Router "System One decides" | Router properties | One Choice over the route names. Probability pills appear on the canvas edges. Below the minimum confidence the ticket takes the "Not sure" route. |
| Approval auto-resolve | Approval Gate properties | One Noul, "safe to approve?". At or above *approve at* it approves, at or below *reject at* it rejects, and in between it waits for a person, who sees the estimate. |
| Decide node | Palette > Data > Decide | Up to 50 typed questions in one call, merged into the payload under `resultKey` (default `decisions`): `$.decisions.urgent > 0.7`, `$.decisions.topic.choice`. |
| Verify the output | Agent > Prompt > System One | Noul checks where yes means wrong: unsupported claims, off task, incomplete, wrong format, plus your own. One check at or above *flag at* fires. You then choose to rerun once on the fallback model, fail the step, or keep the output with a warning. |
| Preselect tools and skills | Agent > Prompt > System One | A Choice ranks every attached tool or skill, and then fit Nouls check the top few. The model is offered only what fits the turn. Tools never drop to zero; skills can. If System One fails, the full list is used. |
| System One judge | Evals, matcher `decision-judge` | Answers the input, matches the reference, contradicts it (inverted), and meets the criteria. The weighted score passes at 70% by default. It costs a fraction of a cent per case. |
| Portal guardrails | Portal trigger properties | Visitor messages and/or answers are screened for jailbreaks, harm or illegal activity, medical advice and self-harm, plus a severity score. Precedence is support > block > review > pass. |
| Palette assists | Agents palette | "Find by meaning" when a search finds nothing, and "Suggest what comes after" for the selected node. |
| Run triage | Runs > failed run | "Why did this fail?" returns one of seven categories with a remedy, and says whether a plain retry would help. |

Every decision emits a `decision` run event with the purpose (`route`, `gate`, `decide`, `verify`,
`tool-select`, `skill-select`, `judge`, `guard`), the versioned model and the raw answers. It
appears in the trace, and its cost lands in the run's usage as provider `typesafe`.

## Setting it up

System One needs one of the following.

- **Your own TypeSafe key.** Create one at <https://console.typesafe.ai/keys>, then open
  Settings > API keys > TypeSafe. The desktop app stores it in the OS keychain and proxies calls
  through Rust. The browser preview keeps it in local storage.
- **A Phorma Cloud sign-in.** Calls go through `POST /api/decide` on Phorma Labs' platform key and
  are billed to your plan credits.

Settings > API keys > System One source picks between them. **Automatic** prefers your key when you
have one.

### Deployed workflows

| Host | Key |
|---|---|
| Phorma Cloud (hosted) | Nothing to do. Runs use the platform key (`TYPESAFE_PLATFORM_KEY`) and bill your credits. |
| Your own Cloudflare worker | `TYPESAFE_API_KEY` worker secret. Use Settings > Cloud > worker secrets, or run `npx wrangler secret put TYPESAFE_API_KEY`. |
| AWS (ECS Fargate) | A `typesafe` provider key in Secrets Manager, alongside the model provider keys. |

The hostname `api.typesafe.ai` is added to a workflow's egress list automatically when any step
uses System One.

### Without a key

- A Router in System One mode falls back to keyword matching and logs a warning.
- Every other System One step fails and names the missing `decisions` capability.
- Portal guardrails fail closed: visitor turns are refused, never let through unscreened.
- Palette assists and triage are hidden.

## Writing good questions

- **Be narrow and literal.** Ask one thing per question, and use the words the content itself uses.
- **Frame the action case as yes.** "Does this reply make a promise about a refund?", not "Is this
  reply fine?".
- **Narrow the state.** Set *Evaluate only (state path)* to the field that matters, for example
  `ticket.message`. Jev gets less accurate as irrelevant context grows.
- **Combine in code, not in one question.** Several atomic Nouls in a Decide node, followed by an
  expression, beat one compound question.
- **Pin the model** for reproducible evals. `jev-latest` moves; `jev-1.13.0` does not.

## Limits

64k context, with 32k for the state plus the longest question. 1,200 requests a minute. Rate limits
(429) and overload (529) retry automatically, honouring `Retry-After`.
