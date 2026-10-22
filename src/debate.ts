// golden-kog-debate: a two sided structure debate for a token risk analysis.
// Risk only. Never a trading view. Adapted from the debate pattern of
// TradingAgents (TauricResearch, Apache 2.0), without its trader or portfolio manager.
//
// The module is pure: every model call goes through the injected `route`, so the
// tests run offline. Node 22 or later, no runtime dependency.

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export type Role = "sound" | "fragile" | "reviewer";

export interface RouteArgs {
  task_type: "risk_debate";
  tier_class: "text";
  complexity: "exec" | "apex";
  context_tokens: number;
  constitutional_flag: false;
  agent_id: "golden-kog";
  payload: {
    role: Role;
    system: string;
    prompt: string;
    max_tokens: number;
  };
}

export interface DebateInput {
  facts_text: string;
  level: string;
  points: number;
  flag_ids: string[];
  unknown: string[];
}

export interface DebateDeps {
  route(args: RouteArgs): Promise<RouteResult>;
  check?(text: string): string[];
  mode?: "off" | "shadow" | "on";
  log?(row: Record<string, unknown>): void;
  timeoutMs?: number;
}

export interface Debate {
  status: "ok" | "rejected" | "timeout" | "off";
  shown: boolean;
  sound: string;
  fragile: string;
  reviewer: string;
  weight: string[];
  unknown: string[];
  tension?: string;
  models: { sound?: string; fragile?: string; reviewer?: string };
  usd: number;
  rejected: string[];
}

/** The one text a failed advocate part is replaced with. */
export const NO_CASE = "No case could be written from the measured facts.";

const MAX_ADVOCATE_WORDS = 180;
const MAX_REVIEWER_WORDS = 150;
const MAX_ADVOCATE_TOKENS = 400;
const MAX_REVIEWER_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 45000;

const REFUSED_WORDS = [
  "bull",
  "bear",
  "bullish",
  "bearish",
  "upside target",
  "downside target",
  "undervalued",
  "overvalued",
  "accumulate",
  "moon",
  "buy now",
  "sell now",
  "price target",
  "entry",
  "exit",
  "take profit",
  "not financial advice",
];

const DASHES = /[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/;

const SYSTEM_BASE = [
  "You are part of a token structure review for a risk tool.",
  "You argue about the measured facts only. You never give a trading view, a recommendation, a price, or advice.",
  "Every number you write must appear in the facts exactly as it was written there. Do not compute new numbers.",
  "Use Latin digits only. Do not use any dash character, hyphen or minus sign.",
  "Do not use the words bull, bear, bullish, bearish, upside target, downside target, undervalued, overvalued, accumulate, moon, buy now, sell now, price target, entry, exit, take profit, not financial advice.",
].join(" ");

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Number tokens written the way a reader sees them: digits with an optional decimal part. */
export function numbersIn(text: string): string[] {
  const found = text.match(/[0-9]+(?:\.[0-9]+)?/g);
  return found ? found : [];
}

function numberAppearsInFacts(token: string, facts: string): boolean {
  const pattern = new RegExp(`(^|[^0-9])${escapeRe(token)}([^0-9]|$)`);
  return pattern.test(facts);
}

function hasNonLatinDigit(text: string): boolean {
  for (const ch of text) {
    if (/\p{Nd}/u.test(ch) && !/[0-9]/.test(ch)) return true;
  }
  return false;
}

function hasRefusedWord(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const word of REFUSED_WORDS) {
    const pattern = new RegExp(`\\b${escapeRe(word).replace(/\\ /g, "\\s+")}\\b`);
    if (pattern.test(lower)) hits.push(word);
  }
  return hits;
}

/** Every rule a part must pass, in the order the spec lists them. */
export function problemsIn(text: string, factsText: string, role: Role, check?: (text: string) => string[]): string[] {
  const problems: string[] = [];
  for (const token of numbersIn(text)) {
    if (!numberAppearsInFacts(token, factsText)) {
      problems.push(`number ${token} is not in the measured facts`);
    }
  }
  for (const word of hasRefusedWord(text)) {
    problems.push(`refused word: ${word}`);
  }
  if (DASHES.test(text)) problems.push("a dash character is not allowed");
  if (hasNonLatinDigit(text)) problems.push("only Latin digits are allowed");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const limit = role === "reviewer" ? MAX_REVIEWER_WORDS : MAX_ADVOCATE_WORDS;
  if (words > limit) problems.push(`too many words: ${words} of ${limit}`);
  if (check) {
    for (const extra of check(text) || []) problems.push(String(extra));
  }
  return problems;
}

function estimateContextTokens(system: string, prompt: string): number {
  return Math.ceil((system.length + prompt.length) / 4);
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; result: T } | { timedOut: true }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    work.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, result });
      },
      () => {
        // A route that throws is treated like a call that ran out of time, so
        // the debate never throws at its caller.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: true });
      },
    );
  });
}

function parseReviewer(content: string): { text: string; weight: string[]; unknown: string[]; tension?: string } | null {
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      if (typeof parsed.text !== "string") continue;
      const weight = Array.isArray(parsed.weight) ? parsed.weight.map(String) : [];
      const unknown = Array.isArray(parsed.unknown) ? parsed.unknown.map(String) : [];
      const tension = typeof parsed.tension === "string" ? parsed.tension : undefined;
      return tension === undefined ? { text: parsed.text, weight, unknown } : { text: parsed.text, weight, unknown, tension };
    } catch {
      continue;
    }
  }
  return null;
}

function factsBlock(input: DebateInput): string {
  const lines = [
    `level: ${input.level}`,
    `points: ${input.points}`,
    `flags: ${input.flag_ids.join(", ") || "none"}`,
    "facts:",
    input.facts_text,
  ];
  return lines.join("\n");
}

function advocatePrompt(input: DebateInput, role: "sound" | "fragile"): string {
  const side =
    role === "sound"
      ? "Argue that the structure is sound, using only the measured facts."
      : "Argue that the structure is fragile, using only the measured facts.";
  return [
    side,
    "Write one short paragraph of at most 180 words.",
    "Do not add a trading view, a recommendation, a price, a target, or advice.",
    "",
    factsBlock(input),
  ].join("\n");
}

function reviewerPrompt(input: DebateInput, sound: string, fragile: string): string {
  return [
    "Two advocates argued about the same token structure from the measured facts.",
    "Weigh them and answer with one JSON object only, no prose around it:",
    '{"text": "<at most 150 words>", "weight": ["<flag id>"], "unknown": ["<open question>"], "tension": "<optional>"}',
    "weight may only contain ids from the flags list. Do not add a trading view, a recommendation, a price, or advice.",
    "",
    factsBlock(input),
    "",
    "advocate for a sound structure:",
    sound,
    "",
    "advocate for a fragile structure:",
    fragile,
  ].join("\n");
}

async function callRoute(
  deps: DebateDeps,
  input: DebateInput,
  role: Role,
  system: string,
  prompt: string,
  maxTokens: number,
): Promise<{ timedOut: false; result: RouteResult } | { timedOut: true }> {
  const args: RouteArgs = {
    task_type: "risk_debate",
    tier_class: "text",
    complexity: role === "reviewer" ? "apex" : "exec",
    context_tokens: estimateContextTokens(system, prompt),
    constitutional_flag: false,
    agent_id: "golden-kog",
    payload: { role, system, prompt, max_tokens: maxTokens },
  };
  return withTimeout(deps.route(args), deps.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : deps.timeoutMs);
}

/**
 * Run the debate: two advocates in parallel, then one reviewer.
 * Nothing here reaches the network; every model call goes through deps.route.
 */
export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode = deps.mode === undefined ? "shadow" : deps.mode;
  const base: Debate = {
    status: "off",
    shown: false,
    sound: "",
    fragile: "",
    reviewer: "",
    weight: [],
    unknown: Array.isArray(input && input.unknown) ? input.unknown.slice() : [],
    models: {},
    usd: 0,
    rejected: [],
  };

  if (mode === "off") return base;

  const rejected: string[] = [];
  const models: Debate["models"] = {};
  let usd = 0;

  const soundWork = callRoute(deps, input, "sound", SYSTEM_BASE, advocatePrompt(input, "sound"), MAX_ADVOCATE_TOKENS);
  const fragileWork = callRoute(deps, input, "fragile", SYSTEM_BASE, advocatePrompt(input, "fragile"), MAX_ADVOCATE_TOKENS);
  const [soundCall, fragileCall] = await Promise.all([soundWork, fragileWork]);

  for (const call of [soundCall, fragileCall]) {
    if (call.timedOut) {
      return { ...base, status: "timeout", rejected: ["a call exceeded the timeout"], usd };
    }
    if (call.result && typeof call.result.cost_usd === "number") usd += call.result.cost_usd;
  }

  const soundRaw = soundCall.timedOut ? "" : String(soundCall.result.content || "").trim();
  const fragileRaw = fragileCall.timedOut ? "" : String(fragileCall.result.content || "").trim();
  if (!soundCall.timedOut && soundCall.result.model) models.sound = soundCall.result.model;
  if (!fragileCall.timedOut && fragileCall.result.model) models.fragile = fragileCall.result.model;

  const soundProblems = problemsIn(soundRaw, input.facts_text, "sound", deps.check);
  const fragileProblems = problemsIn(fragileRaw, input.facts_text, "fragile", deps.check);
  const sound = soundProblems.length === 0 ? soundRaw : NO_CASE;
  const fragile = fragileProblems.length === 0 ? fragileRaw : NO_CASE;
  for (const problem of soundProblems) rejected.push(`sound: ${problem}`);
  for (const problem of fragileProblems) rejected.push(`fragile: ${problem}`);

  const reviewCall = await callRoute(
    deps,
    input,
    "reviewer",
    SYSTEM_BASE,
    reviewerPrompt(input, sound, fragile),
    MAX_REVIEWER_TOKENS,
  );
  if (reviewCall.timedOut) {
    return { ...base, status: "timeout", rejected: ["a call exceeded the timeout"], usd };
  }
  if (reviewCall.result && typeof reviewCall.result.cost_usd === "number") usd += reviewCall.result.cost_usd;
  if (reviewCall.result.model) models.reviewer = reviewCall.result.model;

  const reviewerRaw = String(reviewCall.result.content || "").trim();
  const parsed = parseReviewer(reviewerRaw);
  if (!parsed) {
    rejected.push("reviewer: the answer was not the expected JSON");
    return {
      ...base,
      status: "rejected",
      sound: "",
      fragile: "",
      reviewer: "",
      weight: [],
      unknown: Array.isArray(input && input.unknown) ? input.unknown.slice() : [],
      models,
      usd,
      rejected,
    };
  }

  const reviewerProblems = problemsIn(parsed.text, input.facts_text, "reviewer", deps.check);
  if (reviewerProblems.length > 0) {
    for (const problem of reviewerProblems) rejected.push(`reviewer: ${problem}`);
    return {
      ...base,
      status: "rejected",
      sound: "",
      fragile: "",
      reviewer: "",
      weight: [],
      unknown: Array.isArray(input && input.unknown) ? input.unknown.slice() : [],
      models,
      usd,
      rejected,
    };
  }

  const known = new Set(Array.isArray(input.flag_ids) ? input.flag_ids.map(String) : []);
  const weight: string[] = [];
  for (const id of parsed.weight) {
    if (known.has(id) && !weight.includes(id)) weight.push(id);
  }

  const result: Debate = {
    status: "ok",
    shown: mode === "on",
    sound,
    fragile,
    reviewer: parsed.text,
    weight,
    unknown: parsed.unknown.length > 0 ? parsed.unknown : Array.isArray(input.unknown) ? input.unknown.slice() : [],
    models,
    usd,
    rejected,
  };
  if (parsed.tension !== undefined) result.tension = parsed.tension;
  if (mode === "shadow" && deps.log) deps.log(result as unknown as Record<string, unknown>);
  return result;
}

export default debate;
