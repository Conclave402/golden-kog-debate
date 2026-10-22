# golden-kog-debate

A two sided structure debate for a token risk analysis. Two advocates argue about
the measured facts, one for a sound structure and one for a fragile one, then a
reviewer weighs them. It is a risk tool only: no buy or sell view, no price, no
target, no entry or exit, no advice.

The pattern is adapted from the debate design of **TradingAgents** (TauricResearch,
Apache 2.0, https://github.com/TauricResearch/TradingAgents), without its trader and
without its portfolio manager. The module here is independent code under the same
Apache 2.0 licence.

## Call flow

```
debate(input, deps)
  |
  +-- mode "off"      -> return {status: "off"}, no route call
  |
  +-- sound   (exec, parallel)  \
  +-- fragile (exec, parallel)  /  one route call each, same facts
  |        |
  |        +-- each part is checked: numbers from the facts, refused words,
  |            dashes, Latin digits, word limit, deps.check
  |            a failing part becomes exactly:
  |            "No case could be written from the measured facts."
  |
  +-- reviewer (apex)  one route call with both advocate texts and the facts
           |
           +-- answers JSON {text, weight, unknown, tension?}
           +-- unparseable or failing reviewer -> status "rejected", empty texts
  |
  +-- mode "shadow": run everything, call deps.log(debate), return shown false
  +-- mode "on":     run everything, return shown true
```

Every model call goes through `deps.route`, so the module itself never opens a
network connection. That is what makes the tests offline and deterministic.

## Interface

```ts
debate(input, deps) -> Promise<Debate>

input: { facts_text, level, points, flag_ids, unknown }
deps:  { route, check?, mode?: "off" | "shadow" | "on", log?, timeoutMs? }
```

`route` is called with `{task_type: "risk_debate", tier_class: "text", complexity,
context_tokens, constitutional_flag: false, agent_id: "golden-kog", payload: {role,
system, prompt, max_tokens}}`, and must answer `{content, model?, cost_usd?}`.
The two advocates run in parallel, the reviewer runs after both.

## The rules every part must pass

1. Every number in a part appears in `facts_text`, written the same way.
2. No refused word: bull, bear, bullish, bearish, upside target, downside target,
   undervalued, overvalued, accumulate, moon, buy now, sell now, price target,
   entry, exit, take profit, not financial advice.
3. No dash characters of any kind, including the hyphen and the minus sign.
4. Latin digits only.
5. At most 180 words for an advocate and 150 for the reviewer.
6. `deps.check(text)` returns no problem.

An advocate that fails is replaced by the fixed sentence above and its reasons go
into `rejected`. A reviewer that fails, or whose answer is not the expected JSON,
gives `status: "rejected"` with empty texts. The debate never returns or changes a
level or a point total. `weight` keeps only ids that are present in `flag_ids`.
A call that runs longer than `timeoutMs` gives `status: "timeout"` and does not
throw. `usd` is the sum of the `cost_usd` of the calls that were made.

## Example Debate

From the tests, with three calls at 0.01 each:

```json
{
  "status": "ok",
  "shown": true,
  "sound": "The supply is 1000000 and the holder count is 333 positive. Authority is present while the freeze authority is absent, so the structure carries a single control point that is visible and can be watched. Concentration in the top holder at 250000 is a known quantity, not a hidden one.",
  "fragile": "The supply is 1000000 and the top holder owns 250000, so a large share sits with one owner. The mint authority is present, which means the supply can change, and only 333 positive holders exist. The freeze authority is absent, so the one control point left is the mint.",
  "reviewer": "Both sides rest on the same measured facts. The mint authority being present and the top holder owning 250000 are the two points that carry the risk. The open question is who controls the mint authority.",
  "weight": ["F7", "F1"],
  "unknown": ["who controls the mint authority"],
  "tension": "Concentration is measurable, control is not.",
  "models": { "sound": "model-sound", "fragile": "model-fragile", "reviewer": "model-reviewer" },
  "usd": 0.03,
  "rejected": []
}
```

## Build and test

```
npm install
npm run build
npm test
```

Node 22 or later, no runtime dependency. The tests are named after the acceptance
items A1 to A7, and each one fails if the change it proves is reverted.
