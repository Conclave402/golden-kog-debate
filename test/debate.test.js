// A1 to A7, one test group per acceptance item of the Golden Kog risk debate job.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { debate, NO_CASE, problemsIn } = require("../dist/debate.js");

const FACTS = [
  "mint supply is 1000000",
  "top holder owns 250000",
  "holder count is 333 positive",
  "mint authority is present",
  "freeze authority is absent",
].join("\n");

const INPUT = {
  facts_text: FACTS,
  level: "high",
  points: 70,
  flag_ids: ["F1", "F7", "F9"],
  unknown: ["who controls the mint authority"],
};

const SOUND_OK =
  "The supply is 1000000 and the holder count is 333 positive. Authority is present while the freeze authority is absent, so the structure carries a single control point that is visible and can be watched. Concentration in the top holder at 250000 is a known quantity, not a hidden one.";
const FRAGILE_OK =
  "The supply is 1000000 and the top holder owns 250000, so a large share sits with one owner. The mint authority is present, which means the supply can change, and only 333 positive holders exist. The freeze authority is absent, so the one control point left is the mint.";
const REVIEWER_JSON = JSON.stringify({
  text: "Both sides rest on the same measured facts. The mint authority being present and the top holder owning 250000 are the two points that carry the risk. The open question is who controls the mint authority.",
  weight: ["F7", "F1", "F404"],
  unknown: ["who controls the mint authority"],
  tension: "Concentration is measurable, control is not.",
});

function makeRoute(overrides) {
  const calls = [];
  const route = async (args) => {
    calls.push(args);
    const role = args.payload.role;
    const custom = overrides && overrides[role];
    if (typeof custom === "function") return custom(args, calls);
    const content = role === "reviewer" ? REVIEWER_JSON : role === "sound" ? SOUND_OK : FRAGILE_OK;
    return { content, model: `model-${role}`, cost_usd: 0.01 };
  };
  return { route, calls };
}

test("A1 the two advocates are called in parallel with roles sound and fragile, then the reviewer with both texts", async () => {
  const started = [];
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  const { route } = makeRoute();
  const routed = async (args) => {
    const role = args.payload.role;
    started.push(role);
    if (role === "sound" || role === "fragile") {
      if (started.filter((r) => r === "sound" || r === "fragile").length === 2) releaseBarrier();
      await barrier;
    }
    return route(args);
  };
  const result = await debate(INPUT, { route: routed, mode: "on" });
  assert.equal(result.status, "ok");
  assert.deepEqual(started.slice(0, 2).sort(), ["fragile", "sound"]);
  assert.equal(started[2], "reviewer");
  assert.equal(result.sound, SOUND_OK);
  assert.equal(result.fragile, FRAGILE_OK);
  assert.equal(result.shown, true);
  const reviewerCall = started.length === 3;
  assert.ok(reviewerCall, "the reviewer runs after both advocates");
});

test("A1 the reviewer call carries both advocate texts and the facts", async () => {
  const { route, calls } = makeRoute();
  await debate(INPUT, { route, mode: "on" });
  const reviewer = calls.find((c) => c.payload.role === "reviewer");
  assert.ok(reviewer.payload.prompt.includes(SOUND_OK));
  assert.ok(reviewer.payload.prompt.includes(FRAGILE_OK));
  assert.ok(reviewer.payload.prompt.includes(FACTS));
  assert.equal(reviewer.complexity, "apex");
  assert.equal(reviewer.payload.max_tokens > 0, true);
  assert.equal(calls.filter((c) => c.complexity === "exec").length, 2);
});

test("A2 an advocate number that is not in the facts is replaced and the reason is kept", async () => {
  const { route } = makeRoute({ sound: () => ({ content: "The supply is 999999 and that is the whole story.", model: "m" }) });
  const result = await debate(INPUT, { route, mode: "on" });
  assert.equal(result.status, "ok");
  assert.equal(result.sound, NO_CASE);
  assert.ok(result.rejected.some((r) => r.startsWith("sound:") && r.includes("999999")));
  assert.equal(result.fragile, FRAGILE_OK);
});

test("A2 a reviewer number that is not in the facts drops the debate with empty texts", async () => {
  const bad = JSON.stringify({ text: "The supply is 42 and that settles it.", weight: ["F1"], unknown: [] });
  const { route } = makeRoute({ reviewer: () => ({ content: bad }) });
  const result = await debate(INPUT, { route, mode: "on" });
  assert.equal(result.status, "rejected");
  assert.equal(result.sound, "");
  assert.equal(result.fragile, "");
  assert.equal(result.reviewer, "");
  assert.ok(result.rejected.some((r) => r.startsWith("reviewer:") && r.includes("42")));
});

test("A3 refused words, a long dash, a non Latin digit, too many words and a guard problem are refused the same way", async () => {
  const cases = [
    { name: "refused word", text: "The top holder is bullish on the supply of 1000000." },
    { name: "long dash", text: "The supply is 1000000 \u2014 and the holder count is 333 positive." },
    { name: "non Latin digit", text: "The supply is 1000000 and the top holder owns ٢٥٠٠٠٠." },
    { name: "too many words", text: Array.from({ length: 200 }, () => "word").join(" ") },
  ];
  for (const one of cases) {
    const { route } = makeRoute({ fragile: () => ({ content: one.text }) });
    const result = await debate(INPUT, { route, mode: "on" });
    assert.equal(result.status, "ok", one.name);
    assert.equal(result.fragile, NO_CASE, one.name);
    assert.ok(result.rejected.some((r) => r.startsWith("fragile:")), one.name);
  }

  const guard = (text) => (text.includes("top holder owns 250000") ? ["the guard refused this text"] : []);
  const { route } = makeRoute();
  const result = await debate(INPUT, { route, mode: "on", check: guard });
  assert.equal(result.status, "ok");
  assert.equal(result.fragile, NO_CASE);
  assert.ok(result.rejected.some((r) => r.includes("the guard refused this text")));

  assert.deepEqual(problemsIn("The supply is 1000000.", FACTS, "sound"), []);
});

test("A4 the reviewer JSON is parsed, weight keeps only known flag ids, unparseable JSON gives rejected", async () => {
  const { route } = makeRoute();
  const result = await debate(INPUT, { route, mode: "on" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.weight, ["F7", "F1"]);
  assert.equal(result.tension, "Concentration is measurable, control is not.");
  assert.deepEqual(result.unknown, ["who controls the mint authority"]);
  assert.equal(result.models.reviewer, "model-reviewer");

  const broken = makeRoute({ reviewer: () => ({ content: "not json at all" }) });
  const rejected = await debate(INPUT, { route: broken.route, mode: "on" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewer, "");
  assert.ok(rejected.rejected.some((r) => r.includes("not the expected JSON")));
});

test("A5 a call over timeoutMs gives status timeout without throwing", async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ content: SOUND_OK }), 200));
  const { route } = makeRoute({ sound: slow });
  const result = await debate(INPUT, { route, mode: "on", timeoutMs: 20 });
  assert.equal(result.status, "timeout");
  assert.equal(result.shown, false);
});

test("A6 mode off makes no call, shadow logs and shows false, on shows true, usd sums the calls", async () => {
  const off = makeRoute();
  const offResult = await debate(INPUT, { route: off.route, mode: "off" });
  assert.equal(offResult.status, "off");
  assert.equal(off.calls.length, 0);
  assert.equal(offResult.usd, 0);

  const shadow = makeRoute();
  const logged = [];
  const shadowResult = await debate(INPUT, { route: shadow.route, mode: "shadow", log: (row) => logged.push(row) });
  assert.equal(shadowResult.status, "ok");
  assert.equal(shadowResult.shown, false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, "ok");

  const on = makeRoute();
  const onResult = await debate(INPUT, { route: on.route, mode: "on" });
  assert.equal(onResult.shown, true);
  assert.equal(onResult.usd, 0.03);
});

test("A6 the debate never returns or changes a level or points", async () => {
  const { route } = makeRoute();
  const result = await debate({ ...INPUT, level: "high", points: 70 }, { route, mode: "on" });
  assert.equal("level" in result, false);
  assert.equal("points" in result, false);
  assert.equal(INPUT.level, "high");
  assert.equal(INPUT.points, 70);
});

test("A7 the README shows the call flow, the rules, an example Debate and credits TradingAgents", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.ok(/call flow/i.test(readme), "call flow section");
  assert.ok(/rules/i.test(readme), "rules section");
  assert.ok(/example/i.test(readme), "example section");
  assert.ok(/TradingAgents/.test(readme), "TradingAgents credit");
  assert.ok(/Apache 2\.0/.test(readme), "license credit");
});
