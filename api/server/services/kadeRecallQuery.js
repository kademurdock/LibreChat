/**
 * KADE RECALL QUERY -- the words a turn searches with (Nov 10 2026).
 *
 * ONE HOME, TWO READERS. Tool retrieval (kadeToolRetrieval.js) and memory
 * recall (kadeCardRecall.js) both search with "what the person just said".
 * They used to work that string out separately, and whenever the two answers
 * differed the per-request embed memo missed: recall started a second embed
 * from nothing and waited for it. Every function here is pure (no logger, no
 * database, no network), so both readers get byte-identical text and the memo
 * always hits.
 *
 * WHAT IT DECIDES
 *   - turnWords: the person's own latest words. On a voice or phone turn the
 *     proxy folds up to 24 earlier turns in front of them inside an "earlier
 *     in this conversation" wrapper; searching the first 1,500 characters of
 *     that searched old words, not new ones. The wrapper is removed here, the
 *     same way client.js already removes it for the memory keeper.
 *   - memoryQuery: the exact string embedded for the memory search.
 *   - withPrevious: on a SHORT latest message ("what about her?") the memory
 *     query may carry the previous user message in front. Memory only: tool
 *     choice and the keyword aliases always read the latest message alone.
 *   - greetingShaped: "hey", "hello <the character's own name>".
 *
 * No function here makes a call or waits for anything.
 *
 * OFF SWITCHES (default on; "=0" turns each one off, read per call):
 *   KADE_RECALL_QUERY_CLEAN=0  keep the voice wrapper in the search text
 *   KADE_RECALL_PREV_TURN=0    never add the previous user message
 *   KADE_RECALL_GREETING=0     the old greeting test (one hardcoded name) and
 *                              no recall at all under 12 characters
 *   KADE_RECALL_DEADLINE=0     recall reads the last stored message first, as
 *                              before (see recallTurnText)
 * Knob: KADE_RECALL_SHORT_CHARS (default 40): a latest message shorter than
 *   this counts as short for withPrevious.
 */

/** The voice lane's replayed-transcript wrapper, as written by the voice
 * proxy's composeTextWithHistory. Twin of client.js CONTEXT_REPLAY_RE. */
const CONTEXT_REPLAY_RE =
  /\[EARLIER IN THIS CONVERSATION[\s\S]*?Reply ONLY to what follows\.\]\s*/gi;

/** Longest text ever embedded as a query (unchanged from before this file). */
const QUERY_CHARS = 1500;
/** Under this many characters a turn does not reach for memory by meaning. */
const GATE_CHARS = 12;
/** Longest slice of the previous user message that may ride a short query. */
const PREVIOUS_CHARS = 300;

const GREETING_WORDS = 'hi|hey|hello|good morning|good evening';
/** The greeting test as it stood before Nov 10 2026 (KADE_RECALL_GREETING=0). */
const LEGACY_GREETING_RE =
  /^(?:hi|hey|hello|good morning|good evening)(?:[.! ,]+(?:kiana))?[.! ]*$/i;

function envOf(env) {
  return env || (typeof process !== 'undefined' && process.env) || {};
}

function isOff(name, env) {
  return String(envOf(env)[name] || '') === '0';
}

/** The person's own latest words: wrapper removed, trimmed. */
function turnWords(text, env) {
  const raw = typeof text === 'string' ? text : String(text || '');
  if (isOff('KADE_RECALL_QUERY_CLEAN', env)) {
    return raw.trim();
  }
  return raw.replace(CONTEXT_REPLAY_RE, '').trim();
}

/** The exact string both readers embed for the memory search. Idempotent. */
function memoryQuery(text, env) {
  return turnWords(text, env).slice(0, QUERY_CHARS);
}

function shortChars(env) {
  const n = parseInt(envOf(env).KADE_RECALL_SHORT_CHARS, 10);
  return Number.isFinite(n) && n >= GATE_CHARS && n <= 400 ? n : 40;
}

/** Is this latest message short enough that the previous one may ride with it? */
function isShortTurn(text, env) {
  if (isOff('KADE_RECALL_PREV_TURN', env)) {
    return false;
  }
  const n = turnWords(text, env).length;
  return n >= GATE_CHARS && n < shortChars(env);
}

/**
 * The memory query for a short latest message: the previous user message (its
 * last PREVIOUS_CHARS characters, wrapper removed) on one line, then the latest
 * words. Returns the plain memoryQuery when the turn is not short or there is
 * no previous message.
 */
function withPrevious(latest, previous, env) {
  const plain = memoryQuery(latest, env);
  if (!isShortTurn(latest, env)) {
    return plain;
  }
  const prev = turnWords(previous, env);
  if (!prev || prev === turnWords(latest, env)) {
    return plain;
  }
  return (prev.slice(-PREVIOUS_CHARS).trim() + '\n' + plain).slice(0, QUERY_CHARS);
}

/**
 * The memory query tool retrieval starts early, beside its tools query. Tool
 * retrieval runs before the stored messages are read, so `previous` is the
 * last message it saw in this conversation (held in memory there), or ''.
 * Always a string to embed: a short turn with no known previous message gets
 * the plain words, so no turn waits for recall to start the embed itself.
 */
function earlyMemoryQuery(latest, previous, env) {
  return withPrevious(latest, previous || '', env);
}

/** Has this request already started a memory embed of exactly `query`? */
function memoHas(req, query) {
  const memo = req && req._kadeEmbedMemo;
  return Boolean(memo && typeof memo.has === 'function' && memo.has('query\0' + String(query || '')));
}

/**
 * The memory query this request has ALREADY started for these plain words, if
 * any: the plain words with a previous message in front (preferred), or the
 * plain words themselves. Recall searches with it instead of starting another
 * embed and waiting for that one from zero. null when nothing was started.
 */
function seededQuery(req, plain) {
  const memo = req && req._kadeEmbedMemo;
  const p = String(plain || '');
  if (!p || !memo || typeof memo.keys !== 'function') {
    return null;
  }
  const head = 'query\0';
  let exact = null;
  for (const key of memo.keys()) {
    if (typeof key !== 'string' || !key.startsWith(head)) {
      continue;
    }
    const value = key.slice(head.length);
    if (value === p) {
      exact = value;
    } else if (value.endsWith('\n' + p)) {
      return value;
    }
  }
  return exact;
}

/**
 * The caller's own earlier lines from a voice turn's folded history, newest
 * last, at most `n` of them. The character's own "YOU:" lines are left out.
 * [] when the text carries no wrapper. Pure.
 */
function earlierCallerLines(text, n = 3) {
  const raw = typeof text === 'string' ? text : '';
  const out = [];
  for (const block of raw.match(CONTEXT_REPLAY_RE) || []) {
    for (const line of block.split('\n')) {
      const m = /^THEM:\s*(.+)$/.exec(line.trim());
      if (m && m[1].trim()) {
        out.push(m[1].trim());
      }
    }
  }
  return n > 0 ? out.slice(-n) : [];
}

/**
 * Which stored text recall should read as "what was just said". Tool retrieval
 * reads the request's own text, so recall reads the same thing first and falls
 * back to the last stored message (a regenerate or an edit sends no text).
 * KADE_RECALL_DEADLINE=0 restores the old order (stored message first).
 */
function recallTurnText(bodyText, latestStoredText, env) {
  const body = typeof bodyText === 'string' ? bodyText : '';
  const stored = typeof latestStoredText === 'string' ? latestStoredText : '';
  if (isOff('KADE_RECALL_DEADLINE', env)) {
    return stored || body || '';
  }
  return body.trim() ? body : stored;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is this a bare greeting, with or without the character's own name?
 * "hey", "Hello!", "hi <name>", "good morning, <first name>". Never "ok",
 * "lol" or anything with more words in it.
 */
function greetingShaped(text, agentName, env) {
  const t = turnWords(text, env);
  if (!t) {
    return false;
  }
  if (isOff('KADE_RECALL_GREETING', env)) {
    return LEGACY_GREETING_RE.test(t);
  }
  const full = String(agentName || '').trim();
  const names = [];
  if (full.length >= 2 && full.length <= 60) {
    names.push(full);
    const first = full.split(/\s+/)[0];
    if (first.length >= 2 && first !== full) {
      names.push(first);
    }
  }
  const namePart = names.length > 0 ? '(?:[.! ,]+(?:' + names.map(escapeRe).join('|') + '))?' : '';
  return new RegExp('^(?:' + GREETING_WORDS + ')' + namePart + '[.! ]*$', 'i').test(t);
}

/**
 * May a turn UNDER the 12-character gate still reach the follow-up nudge and
 * the month echo (never an embed)? Only a greeting-shaped one.
 */
function shortGreeting(text, agentName, env) {
  if (isOff('KADE_RECALL_GREETING', env)) {
    return false;
  }
  return turnWords(text, env).length < GATE_CHARS && greetingShaped(text, agentName, env);
}

module.exports = {
  CONTEXT_REPLAY_RE,
  QUERY_CHARS,
  GATE_CHARS,
  PREVIOUS_CHARS,
  turnWords,
  memoryQuery,
  isShortTurn,
  earlyMemoryQuery,
  withPrevious,
  memoHas,
  seededQuery,
  earlierCallerLines,
  recallTurnText,
  greetingShaped,
  shortGreeting,
};
