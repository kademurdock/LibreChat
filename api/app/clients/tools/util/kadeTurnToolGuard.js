'use strict';
/**
 * KADE Oct 20 2026: the search loop guard (web_search and kade_wikipedia).
 *
 * What happened: Tavily ran past its plan ('Researcher', 1,008 of 1,000 credits) and has answered
 * every web_search with status 432 since 2026-10-20 19:38Z. Kiana read each failure as "try
 * again" and called web_search round after round, thousands of times in one reply (3,835 calls in
 * Amber's 19:49 turn), until the 14-step recursion limit cut the turn off. On Oct 19-20 Wikipedia
 * also answered her parallel lookups with 429 (58 times). The loop is what used up the plan.
 *
 * The rule, per TURN (one request; the agents runtime builds the tools again for every round of
 * tool calls, so the state is keyed on the request object, not the tool instance):
 *   - a provider quota answer (HTTP 402, 429, 432, 433, or words like "rate limit", "quota",
 *     "plan limit") is final for the rest of the turn: that call and every later one answer
 *     UNAVAILABLE and nothing more is sent to the provider;
 *   - at most KADE_WEB_SEARCH_TURN_CAP web searches (default 6) and KADE_WIKIPEDIA_TURN_CAP
 *     Wikipedia lookups (default 8) per turn; past the cap the tool answers CAP_REACHED.
 *     A run given more rounds (a background task's x-kade-steps, req.kadeStepBudget) gets caps
 *     scaled to its budget: cap x budget / 7, 7 being about the rounds in the default 14 steps.
 *   - KADE_TURN_TOOL_GUARD=0 turns the whole guard off (no caps, no quota stop): the rollback.
 * Counting happens before the provider is called, so a round of parallel calls is capped too.
 * No '~' requires, so node --test loads it.
 */

const WEB_SEARCH = 'web_search';
const WIKIPEDIA = 'kade_wikipedia';

const UNAVAILABLE = {
  [WEB_SEARCH]: 'Web search is unavailable right now; answer from what you already know.',
  [WIKIPEDIA]: 'Wikipedia is unavailable right now; answer from what you already know.',
};

const DEFAULT_CAPS = { [WEB_SEARCH]: 6, [WIKIPEDIA]: 8 };
const CAP_ENV = { [WEB_SEARCH]: 'KADE_WEB_SEARCH_TURN_CAP', [WIKIPEDIA]: 'KADE_WIKIPEDIA_TURN_CAP' };

/** What a tool answers once its per-turn cap is used up. */
function capReachedText(name, cap) {
  const what = name === WIKIPEDIA ? 'Wikipedia' : 'web search';
  return `You have already used ${what} ${cap} times for this reply, which is the limit. Do not call it again in this reply; answer from what you already found.`;
}

/** About how many tool rounds the platform's default 14-step limit allows. */
const DEFAULT_ROUNDS = 7;

/** False when KADE_TURN_TOOL_GUARD=0: every call goes through and no tool is wrapped. */
function guardOn(env = process.env) {
  return String((env && env.KADE_TURN_TOOL_GUARD) ?? '') !== '0';
}

/**
 * The per-turn cap for a tool (env override when it is a positive whole number). A run with a
 * larger step budget (turnKey.kadeStepBudget, set for background tasks that are promised up to N
 * rounds) gets the cap scaled to that budget, never below the base cap.
 */
function capFor(name, env = process.env, turnKey) {
  const raw = Number(env && env[CAP_ENV[name]]);
  let cap = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CAPS[name] || 6;
  const budget = Number(turnKey && typeof turnKey === 'object' ? turnKey.kadeStepBudget : NaN);
  if (Number.isFinite(budget) && budget > 0) {
    cap = Math.max(cap, Math.ceil((cap * budget) / DEFAULT_ROUNDS));
  }
  return cap;
}

const QUOTA_STATUS = /\b(?:status(?: code)?|HTTP)\s*:?\s*(?:402|429|432|433)\b/i;
const QUOTA_WORDS = /rate[ -]?limit|too many requests|quota|usage limit|plan limit|exceeded your|credits? (?:exhausted|exceeded)|limit exceeded/i;

/**
 * True when an error (or the text/status a tool got back) says the provider stopped serving us
 * for quota or rate reasons, so trying again this turn is pointless.
 * @param {unknown} err an Error, an axios error, a status number or a message string
 */
function isProviderQuotaError(err) {
  if (err == null) return false;
  if (typeof err === 'number') return [402, 429, 432, 433].includes(err);
  const status = typeof err === 'object' ? err.response?.status ?? err.status ?? err.statusCode : undefined;
  if (typeof status === 'number' && [402, 429, 432, 433].includes(status)) return true;
  const text = typeof err === 'string' ? err : String((err && err.message) || '');
  return QUOTA_STATUS.test(text) || QUOTA_WORDS.test(text);
}

/** turn key (the request object) -> Map(tool name -> { calls, unavailable }) */
const turns = new WeakMap();

function stateFor(turnKey, name) {
  const key = turnKey && (typeof turnKey === 'object' || typeof turnKey === 'function') ? turnKey : null;
  if (!key) return { calls: 0, unavailable: false };
  let byTool = turns.get(key);
  if (!byTool) {
    byTool = new Map();
    turns.set(key, byTool);
  }
  let s = byTool.get(name);
  if (!s) {
    s = { calls: 0, unavailable: false };
    byTool.set(name, s);
  }
  return s;
}

/**
 * Ask to make one call. { ok: true } counts it; otherwise { ok: false, text } is what the tool
 * answers instead of calling the provider.
 */
function beginCall(turnKey, name, env = process.env) {
  if (!guardOn(env)) return { ok: true };
  const s = stateFor(turnKey, name);
  if (s.unavailable) return { ok: false, text: UNAVAILABLE[name], why: 'unavailable' };
  const cap = capFor(name, env, turnKey);
  if (s.calls >= cap) return { ok: false, text: capReachedText(name, cap), why: 'cap' };
  s.calls += 1;
  return { ok: true };
}

/** A quota answer came back: refuse every later call this turn. */
function markUnavailable(turnKey, name) {
  stateFor(turnKey, name).unavailable = true;
}

/** How many calls this turn has made and whether the provider is off (tests and logs). */
function peek(turnKey, name) {
  const s = stateFor(turnKey, name);
  return { calls: s.calls, unavailable: s.unavailable };
}

/**
 * Wrap the agents library's web_search tool (createSearchTool) for one request. The library
 * catches provider failures itself and hands the model an empty result whose artifact carries
 * `web_search.error` ("Tavily API request failed: Request failed with status code 432"), which
 * the model reads as "search again". The wrapper checks that error and the caps.
 * The tool's responseFormat is content_and_artifact, so every answer is a [content, artifact] pair.
 * @param {object} tool a LangChain StructuredTool (its _call is replaced on this instance only)
 * @param {{ req?: object, env?: object, logger?: { warn: Function } }} [opts]
 */
function guardWebSearchTool(tool, { req, env = process.env, logger } = {}) {
  if (!guardOn(env)) return tool;
  if (!tool || typeof tool._call !== 'function' || tool.__kadeTurnGuard) return tool;
  const original = tool._call.bind(tool);
  const turnKey = req || tool;
  tool._call = async (...args) => {
    const gate = beginCall(turnKey, WEB_SEARCH, env);
    if (!gate.ok) return [gate.text, undefined];
    const out = await original(...args);
    const artifact = Array.isArray(out) ? out[1] : undefined;
    const error = artifact && artifact[WEB_SEARCH] && artifact[WEB_SEARCH].error;
    if (error && isProviderQuotaError(String(error))) {
      markUnavailable(turnKey, WEB_SEARCH);
      try {
        logger?.warn?.(`[kadeTurnToolGuard] web_search off for the rest of this turn: ${String(error).slice(0, 160)}`);
      } catch (_) {
        /* noop */
      }
      return [UNAVAILABLE[WEB_SEARCH], undefined];
    }
    return out;
  };
  tool.__kadeTurnGuard = true;
  return tool;
}

module.exports = {
  WEB_SEARCH,
  WIKIPEDIA,
  UNAVAILABLE,
  DEFAULT_CAPS,
  DEFAULT_ROUNDS,
  guardOn,
  capFor,
  capReachedText,
  isProviderQuotaError,
  beginCall,
  markUnavailable,
  peek,
  guardWebSearchTool,
};
