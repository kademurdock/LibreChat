/**
 * KADE Sep 5 2026 (Part 132) — TOOLS AS RETRIEVAL ("deferred tools").
 *
 * Her question the night before: "I didn't know the tools thing was something
 * you could do. Is that what the big chat people do?" It is (Anthropic's Tool
 * Search / defer_loading, ChatGPT connectors on demand, Claude Code's deferred
 * toolkit, LibreChat's own discovered-tools lane for MCP). Her word: "do all
 * those things."
 *
 * THE PROBLEM, MEASURED (Part 131): Kiana carried 24 tool schemas = 39,393
 * chars ≈ 10K tokens on EVERY turn, plus web_search's 25K-char instruction
 * block at the head of the system message, whether the person wanted the
 * phone or was just saying good night. On xAI the 24-tool prefix is also where
 * the cache went flaky.
 *
 * THE SHAPE:
 *   - A CORE set rides every turn (KADE_TOOLS_CORE; default the six a friend
 *     reaches for without thinking: context, memory search, notify, weather,
 *     help, feedback). file_search joins core whenever the turn carries files.
 *   - Everything else is DEFERRED and retrieved per turn by (a) hand-written
 *     keyword aliases (the obvious asks: "tell me a joke", "call my mom",
 *     "play blackjack") and (b) embedding similarity between the person's
 *     words and each tool's description — the SAME Gemini embed the diary
 *     and card recall already take for this turn (memoised on the request, so
 *     the added per-turn cost is zero embed calls). Tool description vectors
 *     are computed once per process and cached.
 *   - STICKY PER CONVERSATION: once a tool is retrieved in a conversation it
 *     stays attached for the rest of it (in-process map, 48 h TTL). The tool
 *     list is part of the cached prefix; a set that only ever GROWS costs one
 *     re-read per new tool instead of a cache bust every time the topic
 *     moves. Same idea as the SDK's overrideDeferLoadingForDiscoveredTools.
 *   - AGENTS WITH ACTION TOOLS (Forge) ARE LEFT ALONE — his actions are the
 *     whole job, and a missed one is a broken ops run, not a cheaper turn.
 *
 * FAIL-SOFT, ALWAYS TOWARD THE OLD BEHAVIOUR: no user text (regenerate,
 * edit, empty), embed lane down with no keyword hit, anything thrown → the
 * full set rides, byte-identical to before this file existed. A cheaper turn
 * is never worth a tool the person asked for and did not get.
 *
 * Knobs (all env, read per call, no redeploy):
 *   KADE_TOOLS_RAG=0            kill switch (default on)
 *   KADE_TOOLS_CORE             comma list, replaces the default core
 *   KADE_TOOLS_CORE_EXTRA       comma list, adds to the core
 *   KADE_TOOLS_MIN_SCORE        cosine floor for an embed hit (default 0.60;
 *                               measured Sep 5: real asks 0.64–0.74, chit-chat
 *                               tops out ~0.55)
 *   KADE_TOOLS_MARGIN           also take tools within this of the top hit (0.06)
 *   KADE_TOOLS_MAX_EMBED        max tools taken by embedding per turn (4)
 *   KADE_TOOLS_RAG_SKIP_AGENTS  comma list of agent ids never filtered
 *   KADE_TOOLS_RAG_STRICT=1     trust keywords alone when the embed lane is down
 *
 * Proof lives outside the fork: the reframe's `tools-fingerprint` line
 * (count + bytes of the tools array on every upstream call).
 */
const { logger } = require('@librechat/data-schemas');

const DEFAULT_CORE = [
  'context',
  'kade_memory_search',
  'kade_notify',
  'kade_weather',
  'kade_help',
  'kade_feedback',
];

/** Hand-written aliases: the obvious asks, matched before any embedding. */
const ALIASES = {
  web_search: [
    /* Part 132.1 — her "Tell me about the Clancy trial. Apparently, it's all
     * over socials" turn attached NOTHING (no question mark, no alias, embed
     * under the floor) and Kiana spiralled through fifteen calls of the tools
     * she did have. The asks a person makes about the world without a "?": */
    /\b(tell me about|what'?s (?:the )?(?:deal|story|situation|update|news|latest|word) (?:with|on|about)|what happened (?:with|to|in)|what'?s (?:going on|up) with|fill me in|catch me up|heard (?:anything |something )?(?:about|of)|haven'?t heard|ever heard of|explain (?:the|this|that|what)|what (?:is|was|are|were) (?:the|this|that|a|an) )\b/i,
    /\b(socials?|social media|tiktok|twitter|instagram|facebook|reddit|threads|trending|viral|everybody'?s talking|all over (?:the )?(?:news|internet|feed|timeline))\b/i,
    /\b(trial|verdict|mistrial|jury|sentenc(?:e|ed|ing)|indicted|arrested|charged with|lawsuit|sued|acquitted|convicted|scandal|recall(?:ed)? (?:on|of)|outage|election|primary|hurricane|earthquake|shooting|crash|explosion)\b/i,
    /\b(search|google|bing|look (it |that |this |him |her |them )?up|find out|online|website|latest|newest|right now|today'?s|prices?|costs? of|how much (is|are|does|do|did|would)|what'?s the score|score of|who won|open (right )?now|in stock)\b/i,
  ],
  kade_research: [
    /\b(research|dig (into|in)|deep.?dive|investigate|thorough(ly)?|cross.?check|find everything|full report)\b/i,
  ],
  kade_news: [
    /\b(news|headlines?|current events|what'?s (going on|happening) (in the world|out there|today)|socials?|social media|trending|viral|all over (?:the )?(?:internet|feed|timeline)|everybody'?s talking)\b/i,
  ],
  kade_wikipedia: [
    /\b(wikipedia|encyclopedia|who (was|is|were|are) [A-Z]|history of|biography|when (was|did) .* (born|die|found|invent|discover))\b/i,
  ],
  kade_joke: [/\b(jokes?|make me laugh|puns?|something funny|dad joke|knock.?knock)\b/i],
  kade_games: [
    /\b(games?|play|blackjack|uno|trivia|farkle|battleship|go fish|hangman|yahtzee|poker|solitaire|checkers|tic.?tac.?toe|cards?|dice|parlor|quiz|deal me)\b/i,
  ],
  kade_adventure: [
    /\b(adventure|dungeon|quest|save (the )?(game|file|my progress)|load (my|the) (save|game)|continue (my|our|the) (story|game|campaign)|rpg|campaign)\b/i,
  ],
  kade_world: [
    /\b(the city|threshold( gate)?|reverie|the world|walk (in|to|around|down)|go (in|to|into) the city)\b/i,
  ],
  kade_phone_call: [
    /\b(call (my|the|him|her|them|a |an |up )|phone (call|them|him|her|my)|dial|ring (up|them|him|her)|make a call|place a call)\b/i,
  ],
  kade_call_me: [/\b(call me|ring me|wake me|give me a (call|ring)|phone me)\b/i],
  kade_message: [
    /\b(tell \w+ (i|that|to|he|she|they|hi|hey|happy|thanks)|message (for|to) \w+|let \w+ know|pass (it |this |that |the word )?(along|on)|leave (him|her|them|\w+) a message)\b/i,
  ],
  kade_lyrics: [/\b(lyrics?|words to (the |that )?song|what does (he|she|it) say in)\b/i],
  kade_read_page: [
    /(https?:\/\/|www\.|\.com\b|\.org\b|\.net\b|\b(read|open|summari[sz]e) (this|that|the|me the|me this) (page|article|link|site|story)\b)/i,
  ],
  kade_media: [
    /(youtube|youtu\.be|\b(this|that|the) (video|clip|song file|recording|track)\b|describe (this|that|the) (video|clip)|what'?s in (this|that) video|listen to this)/i,
  ],
  kade_transcribe: [/\b(transcri(be|pt|ption)|voice memo|the recording|audio (note|memo|file))\b/i],
  flux: [
    /\b(draw|paint|sketch|illustrat(e|ion)|picture of|image of|make (me )?(a|an) (picture|image|drawing|painting)|generate (a|an) (image|picture)|art of)\b/i,
  ],
  fal_studio: [
    /\b(video clip|make (me )?(a|an) (video|poster|logo|flyer|card|banner)|design (a|an|me)|short film|animate)\b/i,
  ],
  calculator: [
    /(\d+\s*[-+*/%x×÷]\s*\d+|\d+\s*%|\b(percent|percentage|calculate|calculation|how many \w+ (in|per|are in)|convert|divided by|square root|tip on)\b)/i,
  ],
  kade_code: [
    /\b(python|bash|javascript|node|script|run (some |the |this )?code|program|compute|algorithm)\b/i,
  ],
  kade_make_file: [
    /\b(spreadsheet|csv|excel|xlsx|docx|word doc(ument)?|make (me )?a (file|list i can keep|document)|save (it|this|that) as|export)\b/i,
  ],
  kade_location: [
    /\b(where am i|near me|around (here|me)|directions|how (do i|to|far to) get to|closest|nearest|my location|walk(ing)? (to|there)|which way)\b/i,
  ],
  kade_living_memory: [
    /\b(living memory|project memory|the (folder|repo|record)|help (doc|manual|page)|how does (the platform|the site|kade.?ai)|what did (forge|the last session)|project status)\b/i,
  ],
  kade_errand: [/\b(errand)\b/i],
  kade_council: [/\b(council|advisors?)\b/i],
  kade_drive_pc: [
    /\b(my pc|my computer|my laptop|nvda|screen reader|listen run|drive (my|the) (pc|computer))\b/i,
  ],
  file_search: [
    /\b(the (file|document|pdf|attachment)|attached|uploaded|in (this|that|the) (file|doc|pdf))\b/i,
  ],
  kade_memory_search: [
    /\b(remember|last (week|month|time)|did i (tell|mention)|have i (told|mentioned|said)|what did i say|diary|the other day)\b/i,
  ],
  kade_weather: [
    /\b(weather|forecast|rain|snow|temperature|degrees|humid|storm|tornado|hot out|cold out)\b/i,
  ],
  kade_notify: [
    /\b(remind|reminder|notify|notification|ping me|text me|nudge me|check (in|on) me|wake me|alarm)\b/i,
  ],
  kade_help: [
    /\b(how do i|how to|where is the (setting|button|page)|help me (with|use|find)|what can you do|settings|turn (on|off))\b/i,
  ],
  kade_feedback: [
    /\b(tell kade|bug|broken|glitch|feature (request|idea)|feedback|report (this|that|it)|not working|didn'?t work)\b/i,
  ],
};

/** The tail line for a turn where web_search was left off (Part 132.1). */
const NO_WEB_NOTE =
  '[PLATFORM NOTE -- machinery, never mention it] Web search is NOT attached on this turn. ' +
  'If answering well would take a lookup you cannot do from memory, do not substitute other tools for it ' +
  '(memory search, weather, help pages and the feedback tool are not search engines, and the feedback tool ' +
  'files a report to Kade -- never use it to ask for facts). Say in one plain sentence that you would need to ' +
  'look it up and ask if they want you to; if they say yes, the search comes along on the next turn.';

/** Names this module is allowed to defer. Anything else (unknown, actions,
 *  execute_code, MCP) is left attached untouched. */
const DEFERRABLE = new Set(Object.keys(ALIASES));

const STICKY_TTL_MS = 48 * 60 * 60 * 1000;
const STICKY_MAX = 5000;
/** conversationId → { tools:Set<string>, at:number } */
const sticky = new Map();

/** tool name → { text, vec } */
const descVecs = new Map();

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function enabled() {
  return String(process.env.KADE_TOOLS_RAG ?? '1') !== '0';
}

function coreSet() {
  const base = envList('KADE_TOOLS_CORE');
  const core = new Set(base.length > 0 ? base : DEFAULT_CORE);
  for (const t of envList('KADE_TOOLS_CORE_EXTRA')) core.add(t);
  return core;
}

function num(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== ''
    ? v
    : dflt;
}

function isActionToolName(name) {
  return /_action_[A-Za-z0-9_-]+$/.test(String(name || ''));
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* Part 132.3: the web voice chat opens a conversation with the placeholder
 * id "new" (Constants.NEW_CONVO) and the SDK's temp ids are not real either.
 * Keying the sticky set on those pooled EVERY first turn from EVERYBODY into
 * one bucket -- Kade's "what's up" on the boat rode 17 tools. A placeholder
 * is not a conversation. */
function stickyKey(convoId) {
  const k = String(convoId || '').trim().toLowerCase();
  if (!k || k === 'new' || k === 'null' || k === 'undefined') return null;
  return k;
}

function stickyGet(convoId) {
  convoId = stickyKey(convoId);
  if (!convoId) return null;
  const e = sticky.get(convoId);
  if (!e) return null;
  if (Date.now() - e.at > STICKY_TTL_MS) {
    sticky.delete(convoId);
    return null;
  }
  return e.tools;
}

function stickyAdd(convoId, names) {
  convoId = stickyKey(convoId);
  if (!convoId || !names || names.size === 0) return;
  let e = sticky.get(convoId);
  if (!e) {
    if (sticky.size >= STICKY_MAX) {
      /* drop the oldest fifth — a Map iterates in insertion order */
      let n = Math.floor(STICKY_MAX / 5);
      for (const k of sticky.keys()) {
        if (n-- <= 0) break;
        sticky.delete(k);
      }
    }
    e = { tools: new Set(), at: Date.now() };
    sticky.set(convoId, e);
  }
  e.at = Date.now();
  for (const n of names) e.tools.add(n);
}

/** Keyword pass. Returns Set of deferrable names whose alias matched. */
/** Part 132.1: a proper noun the person did not start a sentence with, inside
 *  an information-shaped message, is something in the world worth a search
 *  ("the Clancy trial", "is Walgreens open", "who is Bass Reeves"). Family
 *  chatter with names in it ("tell Skylee hi") lacks the info shape and stays
 *  off. Over-attaching costs one ~6K-char schema on that turn; under-attaching
 *  cost fifteen tool calls and a wrong trial. */
/* Part 132, her ask: a fact-shaped question about the world (not about the two
 * people talking) brings the search along. Kept OUT of the alias list so the
 * greeting check (132.3) can tell it apart from the other web_search cues. */
const FACT_Q = /(?:^|[.!?]\s+)(who|what|when|where|which|how (?:much|many|old|far|long|tall|big|fast|late|early)|is|are|was|were|did|does|do|has|have|can|will)\b(?![^?]*\b(?:you|your|yours|me|my|mine|i|i'm|we|us|our)\b)[^?]{2,120}\?/i;
const GREETING_ONLY = /\b(what'?s|what is|how'?s|how is|hows)\s+(up|good|new|going on|happening|it going|the word|crackin'?g?|poppin'?g?|shakin'?g?|everything|life|things|your day|it)\b[^?]{0,20}\?/i;
const INFO_SHAPE = /\b(what|who|when|where|why|how|which|tell me|about(?! to\b)|heard|explain|is|are|was|were|did|does|do|any (?:news|word|update)|update)\b/i;
const PROPER_NOUN = /(?<![.!?]\s|^)(?<!["'(])\b(?!I\b|I'm\b|I'll\b|I've\b|I'd\b)[A-Z][a-z]{2,}\b/;
function worldReferent(text) {
  /* a greeting question ("what's up?") is not an information shape */
  const t = String(text || '').replace(GREETING_ONLY, ' ');
  if (!INFO_SHAPE.test(t)) return false;
  const stripped = t.replace(/%%%[\s\S]*?%%%/g, '');
  return PROPER_NOUN.test(stripped);
}

function keywordHits(text, candidates) {
  const hits = new Set();
  const t = String(text || '');
  if (!t) return hits;
  for (const name of candidates) {
    const pats = ALIASES[name];
    if (!pats) continue;
    if (pats.some((re) => re.test(t))) hits.add(name);
  }
  if (candidates.includes('web_search') && !hits.has('web_search')) {
    /* Part 132.3: "what's up?", "how's it going?" are greetings, not questions
     * about the world -- the fact-question rule was reading them as one. */
    const q = FACT_Q.exec(t);
    if ((q && !GREETING_ONLY.test(q[0])) || worldReferent(t)) hits.add('web_search');
  }
  return hits;
}

/**
 * Embedding pass. `embed` is an async (text) => number[]|null. Description
 * vectors are cached per tool name for the life of the process.
 * Returns { hits:Set, scored:[[name,score]...], failed:boolean }.
 */
async function embedHits({ text, tools, embed, queryVec, minScore, margin, maxTake }) {
  const out = { hits: new Set(), scored: [], failed: false };
  if (!embed || !text || tools.length === 0) {
    out.failed = !embed;
    return out;
  }
  try {
    const qv = queryVec || (await embed(String(text).slice(0, 1500)));
    if (!qv) {
      out.failed = true;
      return out;
    }
    const need = tools.filter((t) => !descVecs.has(t.name));
    await Promise.all(
      need.map(async (t) => {
        const desc = `${String(t.name).replace(/^kade_/, '').replace(/_/g, ' ')}: ${String(t.description || '').slice(0, 1200)}`;
        const vec = await embed(desc);
        if (vec) descVecs.set(t.name, { text: desc, vec });
      }),
    );
    const scored = [];
    for (const t of tools) {
      const d = descVecs.get(t.name);
      if (!d) continue;
      scored.push([t.name, cosine(qv, d.vec)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    out.scored = scored;
    if (scored.length === 0) {
      out.failed = true;
      return out;
    }
    const top = scored[0][1];
    for (const [name, s] of scored) {
      if (out.hits.size >= maxTake) break;
      if (s >= minScore && s >= top - margin) out.hits.add(name);
    }
    return out;
  } catch (e) {
    out.failed = true;
    logger.warn('[kadeToolRag] embed pass failed (falling back): ' + (e && e.message));
    return out;
  }
}

/**
 * Decide which tools ride this turn.
 *
 * @param {object} p
 * @param {Array<{name:string, description?:string}>} p.tools  loaded tool instances
 * @param {string} p.text            the person's words this turn
 * @param {string|null} p.conversationId
 * @param {string} p.agentId
 * @param {boolean} p.hasFiles       turn carries file_search resources
 * @param {(t:string)=>Promise<number[]|null>} [p.embed]
 * @param {number[]|null} [p.queryVec]  an already-computed embed of `text`
 * @returns {Promise<{keep:Set<string>, dropped:string[], reason:string, scored?:Array}>}
 */
async function selectTools(p) {
  const all = new Set((p.tools || []).map((t) => t.name));
  const keepAll = (reason) => ({ keep: new Set(all), dropped: [], reason });
  if (!enabled()) return keepAll('off');
  if (envList('KADE_TOOLS_RAG_SKIP_AGENTS').includes(String(p.agentId || ''))) {
    return keepAll('skip-agent');
  }
  if ([...all].some(isActionToolName)) return keepAll('has-actions');
  const text = String(p.text || '').trim();
  if (!text) return keepAll('no-text');

  const core = coreSet();
  const keep = new Set();
  const deferrable = [];
  for (const t of p.tools || []) {
    const name = t.name;
    if (core.has(name) || !DEFERRABLE.has(name)) {
      keep.add(name);
    } else if (name === 'file_search' && p.hasFiles) {
      keep.add(name);
    } else {
      deferrable.push(t);
    }
  }
  if (deferrable.length === 0) return keepAll('nothing-deferrable');

  const stickyTools = stickyGet(p.conversationId);
  if (stickyTools) for (const n of stickyTools) if (all.has(n)) keep.add(n);

  const candidates = deferrable.filter((t) => !keep.has(t.name));
  const kw = keywordHits(
    text,
    candidates.map((t) => t.name),
  );
  const emb = await embedHits({
    text,
    tools: candidates,
    embed: p.embed,
    queryVec: p.queryVec,
    minScore: num('KADE_TOOLS_MIN_SCORE', 0.6),
    margin: num('KADE_TOOLS_MARGIN', 0.06),
    maxTake: Math.max(1, Math.floor(num('KADE_TOOLS_MAX_EMBED', 4))),
  });
  if (emb.failed && kw.size === 0 && String(process.env.KADE_TOOLS_RAG_STRICT || '') !== '1') {
    /* Embed lane down and no obvious ask: the old full set rides. A cheaper
       turn is never worth a missed tool. KADE_TOOLS_RAG_STRICT=1 trusts the
       keywords alone. */
    return keepAll('embed-down');
  }
  const retrieved = new Set([...kw, ...emb.hits]);
  for (const n of retrieved) keep.add(n);
  stickyAdd(p.conversationId, retrieved);
  const dropped = [...all].filter((n) => !keep.has(n));
  const reason = `kw=[${[...kw].join(',')}] emb=[${[...emb.hits].join(',')}]${
    stickyTools && stickyTools.size ? ` sticky=[${[...stickyTools].join(',')}]` : ''
  }`;
  return { keep, dropped, reason, scored: emb.scored.slice(0, 3) };
}

/**
 * Apply a selection to a loadAgentTools result IN PLACE: filters `tools`,
 * drops web_search's context blocks when web_search is dropped, and prunes
 * `toolDefinitions` if present. Returns the dropped names.
 */
function applySelection(result, keep) {
  if (!result || typeof result !== 'object') return [];
  const dropped = [];
  /* Instance mode (definitionsOnly=false): the model binds `tools`. */
  if (Array.isArray(result.tools) && result.tools.length > 0) {
    const before = result.tools.map((t) => t.name);
    result.tools = result.tools.filter((t) => keep.has(t.name));
    for (const n of before) if (!keep.has(n)) dropped.push(n);
  }
  /* Event-driven mode (the production path, definitionsOnly=true): the model
   * binds `toolDefinitions`; execution resolves by NAME through
   * `toolRegistry`, which is left whole on purpose so nothing the model
   * could still name is unexecutable. */
  if (Array.isArray(result.toolDefinitions) && result.toolDefinitions.length > 0) {
    const before = result.toolDefinitions.map((d) => d && d.name).filter(Boolean);
    result.toolDefinitions = result.toolDefinitions.filter(
      (d) => !d || !d.name || keep.has(d.name) || !DEFERRABLE.has(d.name),
    );
    for (const n of before) if (!keep.has(n) && DEFERRABLE.has(n) && !dropped.includes(n)) dropped.push(n);
  }
  if (dropped.includes('web_search')) {
    if (result.toolContextMap && typeof result.toolContextMap === 'object') {
      delete result.toolContextMap.web_search;
    }
    if (result.dynamicToolContextMap && typeof result.dynamicToolContextMap === 'object') {
      delete result.dynamicToolContextMap.web_search;
    }
  }
  return dropped;
}

/** Per-request memo so the diary/card recall reuses the same query vector. */
function memoEmbed(req, embed) {
  return async (text) => {
    const key = String(text || '');
    if (req) {
      if (!req._kadeEmbedMemo) req._kadeEmbedMemo = new Map();
      if (req._kadeEmbedMemo.has(key)) return req._kadeEmbedMemo.get(key);
      const pr = Promise.resolve()
        .then(() => embed(key))
        .catch(() => null);
      req._kadeEmbedMemo.set(key, pr);
      return pr;
    }
    return embed(key);
  };
}

function _resetForTests() {
  sticky.clear();
  descVecs.clear();
}

module.exports = {
  NO_WEB_NOTE,
  worldReferent,
  selectTools,
  applySelection,
  memoEmbed,
  keywordHits,
  cosine,
  ALIASES,
  DEFAULT_CORE,
  DEFERRABLE,
  _resetForTests,
};
