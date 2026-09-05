/**
 * KADE CARD RECALL — relevant recall for memory cards (Aug 15 2026, Part 69,
 * rung 1 of SESSION_PLAN_2026-08-15_PART69_MEMORY.md). Her number one: "I'm
 * most excited about the rag thing... I need a great memory system."
 *
 * BEFORE: every card in the shared bucket + the active character's bucket rode
 * the instructions HEAD every turn (her seat ~3.2K tokens; Amber's ~8K — at
 * the cap). Her complaint, measured: "she like the color blah, isn't
 * conversation relevant all the time."
 *
 * AFTER (when this lane is on for an agent): a small PINNED CORE stays in the
 * head — identity-critical cards that must never miss — and everything else
 * surfaces per-turn by meaning, a few hundred tokens max, in the volatile
 * TAIL beside the diary block. Quiet turns retrieve nothing and pay nothing.
 *
 * PINNED = (a) every SHARED-bucket card (the doctrine already keeps shared to
 * a tiny practical core: accessibility, name, tone); (b) every live REMINDER
 * card (scheduled alarms must never miss); (c) any card whose key matches
 * KADE_MEMORY_PIN_PATTERNS (default: family, accessib, blind, screen_reader,
 * pronounc, identity, call_me, name). (d) SMALL-SEAT BYPASS: if a seat's
 * whole corpus is at or under KADE_MEMORY_RAG_MIN_TOKENS (default 1200),
 * everything stays pinned — retrieval overhead buys nothing on two cards.
 *
 * CACHE RELIGION: the pinned block is byte-stable between turns (changes only
 * when a pinned card changes — same accepted cost as any memory edit today).
 * Retrieved cards change per turn, so they ride the TAIL, never the head.
 *
 * LATENCY, honest: on turns where the diary already searched (it embeds the
 * user's words every turn a user has diary entries), card recall reuses THAT
 * SAME query vector — cosine over a few hundred rows is sub-millisecond, so
 * the added per-turn cost is ~zero. On card-only users the one embed call
 * (~100-250ms, raced by the same timeout) is new spend: fractions of a tenth
 * of a cent. A `[kadeCardRecall]` log line reports ms + counts every turn it
 * runs — the receipts read straight from the deploy log.
 *
 * KILL SWITCH: unset KADE_MEMORY_RAG (or =0) and every seat rides the full
 * head exactly as before — this whole module becomes inert. Agent staging:
 * KADE_MEMORY_RAG_AGENTS (comma ids, default Kiana only; "all" = fleet).
 */
const { logger } = require('@librechat/data-schemas');
const { getAllUserMemories } = require('~/models');
const { embedText, searchDiary, countEntries } = require('~/models/kadeDiary');
const { syncBucketVectors, searchCardVectors } = require('~/models/kadeCardVector');
const { describeStale, isExpired, cardDate } = require('~/server/services/kadeOpenLoops');

const KIANA_ID = 'agent_6llV0eMu4fmIaj8f2x1Sb';
/* ⭐⭐⭐ THE RECALL FUNNEL (widened Aug 20 2026, with the memory-keeper's
 * fill-the-bank change in librechat.yaml — the two only work as a pair).
 *
 * THE TRAP THIS AVOIDS: telling the memory-keeper to save generously does
 * NOTHING on its own. However full the bank gets, only TOP_K cards and
 * CHAR_CAP characters ever reach the reply — a fuller bank behind a five-card
 * funnel just means more good memories losing to each other. Raise both or
 * neither.
 *
 * WHY IT IS SAFE TO WIDEN, measured on live seats before changing anything:
 * recall runs at a MEDIAN OF 318ms against this 2500ms timeout (p90 363, max
 * 390) — roughly 6x headroom. And 135 cards vs 113 cards differ by ~40ms, so
 * the cost is the single embed round trip, not the cosine scan. The bank can
 * grow several-fold before latency is even a question.
 *
 * ⚠️ THE ONE REAL COST: the recall block rides the VOLATILE TAIL, which is the
 * uncached part of the payload — so every character added here is paid at full
 * price on every turn that retrieves. 1400 -> 2200 is about +200 tokens, call
 * it a hundredth of a cent per turn. Cheap, but it is NOT free the way an
 * unpinned card is, so do not raise this one casually.
 *
 * ⚠️ THE SCALING LIMIT, for whoever grows this next: searchCardVectors does a
 * FULL SCAN — it loads every vector for the seat and scores cosine in JS.
 * Fine at hundreds. At several thousand cards per seat that becomes the
 * dominant cost and it will need a real vector index instead. `limit` is also
 * hard-capped at 12 inside searchCardVectors, so TOP_K above 12 silently does
 * nothing.
 *
 * All tunable without a deploy: KADE_RECALL_CARD_TOP_K, KADE_RECALL_CARD_CAP,
 * KADE_RECALL_DIARY_TOP_K, KADE_RECALL_DIARY_CAP, KADE_RECALL_TIMEOUT_MS. */
const intEnv = (name, def, lo, hi) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};
const CARD_TOP_K = intEnv('KADE_RECALL_CARD_TOP_K', 8, 1, 12);
const CARD_MIN_SCORE = 0.3;
const RECALL_TIMEOUT_MS = intEnv('KADE_RECALL_TIMEOUT_MS', 2500, 500, 10000);
const CARD_BLOCK_CHAR_CAP = intEnv('KADE_RECALL_CARD_CAP', 2200, 200, 8000);
const DIARY_TOP_K = intEnv('KADE_RECALL_DIARY_TOP_K', 4, 1, 12);
const DIARY_MIN_SCORE = 0.32;
const DIARY_BLOCK_CHAR_CAP = intEnv('KADE_RECALL_DIARY_CAP', 1600, 200, 8000);

function ragEnabled() {
  return process.env.KADE_MEMORY_RAG === '1';
}

/** Is card recall live for THIS character? (Kiana first, fleet later.) */
function cardRagActive(agentId) {
  if (!ragEnabled()) {
    return false;
  }
  const raw = (process.env.KADE_MEMORY_RAG_AGENTS || KIANA_ID).trim();
  if (raw.toLowerCase() === 'all') {
    return true;
  }
  if (!agentId) {
    return false;
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(agentId));
}

function pinPatterns() {
  const raw =
    process.env.KADE_MEMORY_PIN_PATTERNS ||
    /* Aug 20 2026: `access` added so the `access_*` cards the memory-keeper
     * now writes (see librechat.yaml's ACCESS NEEDS rule) ride the head every
     * turn. Verified before adding: the prefix matches nothing episodic in any
     * live bucket, so no head grew by a single token. `accessib` alone did NOT
     * match `access_blind_screen_reader`, which is exactly the trap this closes. */
    /* Aug 22 2026 (Part 85.5, the relationship ledger): `how_we_talk` pinned so
     * the standing contract of each relationship — their stated preferences AND
     * the character's own commitments — rides the head EVERY turn. A contract
     * that only sometimes surfaces is not a contract. */
    'family,accessib,access,blind,screen_reader,pronounc,identity,call_me,name,how_we_talk';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ⭐⭐⭐ THE SHARED-BUCKET CEILING (Aug 20 2026 — Kade: "we need the fix, and we
 * need to clean Amber A and everyone else to compliment that fix. Whoever they
 * choose as default agent is gonna retrieve most memories anyway.")
 *
 * THE BUG THIS CLOSES: shared-bucket cards pinned UNCONDITIONALLY — no size
 * cap, no relevance test, forever. That was safe while the shared bucket held
 * identity ("preferences", "personal_basics"), and it silently stopped being
 * safe as the memory writer filed episodic material there. Measured on one
 * real tester: 1,147 tokens of shared bucket riding EVERY turn of EVERY agent,
 * almost all of it medical-trauma narrative — a hospital betrayal, a stroke, a
 * heart attack — so even "hey what's up" was answered by a model primed on the
 * worst week of somebody's life. The token cost was trivial. The ATTENTION
 * cost was not, and it is a plausible driver of the dramatic register she has
 * been complaining about for weeks.
 *
 * THE RULE: the shared bucket may spend at most KADE_SHARED_PIN_MAX_TOKENS on
 * the head. Everything over the line becomes RETRIEVABLE — not deleted, not
 * moved, still shared, still visible to every agent, just surfaced when it is
 * relevant instead of always. Reminders survive first, then identity/safety
 * keys, then smallest-first.
 *
 * WHY THERE IS A SEPARATE, WIDER PATTERN LIST HERE: this ranking list is used
 * ONLY to decide what survives the ceiling. It is deliberately NOT added to
 * pinPatterns(), because measuring showed that widening the real pin list grew
 * agent-bucket heads by 83-176 tokens per user — words like "meds" and
 * "safety" match a lot of episodic cards. Widening it here costs nothing (it
 * only re-orders inside a fixed budget) and fixes a real ranking flaw: with
 * the narrow list, a 250-token budget dropped Kade's own "preferences" card
 * (125 tok) while keeping trivia, because the tiebreak was smallest-first.
 *
 * Kill switch: KADE_SHARED_PIN_MAX_TOKENS=0 restores the old
 * pin-everything-shared behaviour exactly. */
function sharedPinBudget() {
  const n = parseInt(process.env.KADE_SHARED_PIN_MAX_TOKENS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 250;
}
/* Part 99.4 — 'size' restores the pre-Aug-30 smallest-first tie-break.
 * A named helper rather than an inline process.env read for the same reason
 * sharedPinBudget is one: the ceiling test extracts applySharedCeiling into a
 * vm sandbox that has no `process`, and a direct read there is a crash the
 * suite reports as a broken function. */
function sharedPinOrder() {
  return String(process.env.KADE_SHARED_PIN_ORDER || '') === 'size' ? 'size' : 'recent';
}
const SHARED_RANK_EXTRA = [
  'preference', 'basics', 'safety', 'trigger', 'vision', 'allerg', 'pronoun', 'how_i', 'code_word',
];
function cardTokens(m) {
  if (Number.isFinite(m && m.tokenCount) && m.tokenCount > 0) {
    return m.tokenCount;
  }
  return Math.ceil((String((m && m.value) || '').length + String((m && m.key) || '').length) / 4);
}

function minRagTokens() {
  const n = parseInt(process.env.KADE_MEMORY_RAG_MIN_TOKENS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
}

/* Mirrors data-schemas formatDate closely enough for the pinned block — the
 * model reads these dates, nothing parses them. */
function fmtDate(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_e) {
    return '';
  }
}

function describeReminderCompact(m) {
  if (m.type !== 'reminder' || !m.dueAt) {
    return '';
  }
  try {
    const fires = new Date(m.dueAt).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const repeat = m.recurrence ? ', repeats ' + m.recurrence : '';
    const fired = m.completed ? ', already fired' : '';
    return ' (reminder fires ' + fires + ' CT' + repeat + fired + ')';
  } catch (_e) {
    return '';
  }
}

/* KADE Aug 26 2026 — SUBJECT GROUPING. Seven cards about one surgery arrived as
 * seven unrelated facts that happened to agree, and agreeing is exactly what made
 * them look healthy. Cards sharing a `subject` are now emitted together under one
 * heading with their dates, so the model meets ONE SITUATION WITH SEVEN NOTES,
 * newest four days old — which reads as a thing to ask about rather than announce.
 * Kill switch: KADE_CARD_SUBJECTS=0 restores the flat list byte-for-byte. */
function subjectsEnabled() {
  return process.env.KADE_CARD_SUBJECTS !== '0';
}

function renderCard(m, n) {
  return (
    n + '. [' + fmtDate(m.updated_at) + ']. ' + m.value + describeReminderCompact(m) + describeStale(m)
  );
}

function formatList(list) {
  const byDate = (a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0);
  const cards = list.slice().sort(byDate);
  if (!subjectsEnabled()) {
    return cards.map((m, i) => renderCard(m, i + 1)).join('\n\n');
  }

  /* A subject only earns a heading when it actually groups something — a lone
   * card with a subject is just a card, and a heading over it is noise. */
  const counts = new Map();
  for (const m of cards) {
    const sub = m.subject ? String(m.subject).trim() : '';
    if (sub) counts.set(sub, (counts.get(sub) || 0) + 1);
  }
  const grouped = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  if (!grouped.size) {
    return cards.map((m, i) => renderCard(m, i + 1)).join('\n\n');
  }

  const out = [];
  const emitted = new Set();
  let n = 0;
  for (const m of cards) {
    const sub = m.subject ? String(m.subject).trim() : '';
    if (sub && grouped.has(sub)) {
      if (emitted.has(sub)) continue;
      emitted.add(sub);
      const members = cards.filter((x) => String(x.subject || '').trim() === sub);
      const newest = members.reduce((a, b) => (byDate(a, b) > 0 ? a : b));
      const lines = members.map((x) => '   - [' + fmtDate(x.updated_at) + ']. ' + x.value + describeReminderCompact(x) + describeStale(x));
      n += 1;
      out.push(
        n + '. ABOUT "' + sub + '" — ' + members.length + ' notes, nothing newer than ' +
          fmtDate(newest.updated_at) + ':\n' + lines.join('\n'),
      );
      continue;
    }
    n += 1;
    out.push(renderCard(m, n));
  }
  return out.join('\n\n');
}

/* ⭐⭐⭐ THE SHARED CEILING, EXTRACTED (Aug 28 2026) — ONE HOME, TWO READERS.
 *
 * THE BUG THIS CLOSES, and it is a hole between two correct halves. The
 * Aug-20 ceiling trims the shared bucket to a token budget and moves the
 * losers to retrieval; its own log line says so out loud ("rest moved to
 * retrieval"). But `getRecallTailBlock` — the retrieval half — decided what
 * was already pinned with
 *
 *     const pinnedNow = m.agentId == null || ...
 *
 * i.e. "every shared card rides the head, don't spend tail on it." That was
 * exactly true BEFORE the ceiling existed and has been false for every
 * evicted card since. On one live seat that is 6 of 10 shared cards falling
 * between the two lanes every single turn: dropped from the head for being
 * over budget, then dropped from retrieval for supposedly being in the head.
 *
 * Two functions disagreeing about the same word is the shape that keeps
 * costing here — the Aug-26 announcement priority (two handlers eight lines
 * apart, opposite manners), the retry ladders in the TTS proxy. So the
 * decision now lives in ONE function that both halves call, and the tail
 * asks it by key instead of re-deriving it from a rule that drifted.
 *
 * Mutates `pinned` in place (removing evicted shared cards) and returns both
 * the surviving key set and the evicted cards. `log:false` lets the tail ask
 * the same question without doubling the log line every turn. */
function applySharedCeiling(pinned, pats, opts = {}) {
  const evicted = [];
  const budget = sharedPinBudget();
  const keySet = () =>
    new Set(pinned.filter((m) => m.agentId == null).map((m) => String(m.key)));
  if (budget <= 0) {
    return { evicted, pinnedSharedKeys: keySet() };
  }
  const sharedPinned = pinned.filter((m) => m.agentId == null);
  const sharedTotal = sharedPinned.reduce((sum, m) => sum + cardTokens(m), 0);
  if (sharedTotal <= budget) {
    return { evicted, pinnedSharedKeys: keySet() };
  }
  const rankPats = pats.concat(SHARED_RANK_EXTRA);
  const rankOf = (m) => {
    if (m.type === 'reminder') {
      return 0;
    }
    const k = String(m.key || '').toLowerCase();
    return rankPats.some((p) => k.includes(p)) ? 1 : 2;
  };
  /* ⭐⭐⭐ Aug 30 2026 (Part 99.4) — THE TIE-BREAK WAS SMALLEST-FIRST, AND THAT
   * IS A PACKING HEURISTIC WEARING AN IMPORTANCE HAT.
   *
   * Sorting the over-budget remainder by token count ascending maximises the
   * NUMBER of cards kept, which was never the objective. It systematically
   * evicts the LONGEST cards, and the longest card is the one about the
   * complicated thing — because complicated things take more words to write
   * down. Measured on the live corpus the day this was found:
   *
   *   Amber A, 720 tok of shared cards against a 250 ceiling. Kept on the
   *   head: that she likes two Sleep Token songs (25 tok). Evicted:
   *   `relationship_unconventional_breakup_arrangement` (70 tok) — the card
   *   saying she and her partner had broken up, written that same evening.
   *   The recall audit confirms it: across 30 audited turns that card reached
   *   the model ZERO times — not on the head (evicted), not through retrieval
   *   (never scored high enough). Forty minutes after the writer filed it,
   *   Kiana told her to her face that the breakup "hasn't happened yet",
   *   because the only relationship cards that could reach her were older
   *   ones describing a stalemate. THE FACT WAS IN THE DATABASE THE WHOLE
   *   TIME AND THE PLUMBING NEVER LET IT THROUGH.
   *
   * Newest-first is not a perfect importance signal, but it is a real one and
   * smallness is an anti-signal. Re-run against the live corpus: Amber A's
   * head gains the breakup card and the corrected relationship timeline;
   * Kade's seat keeps exactly the same cards (order only). Token count stays
   * as the FINAL tie-break so the ordering is deterministic.
   *
   * CACHE RELIGION IS UNHARMED (see the note at the top of this file): both
   * the set and the order still change only when a pinned card is written,
   * which is the same accepted cost as any memory edit today.
   *
   * KADE_SHARED_PIN_ORDER=size restores the old smallest-first behaviour. */
  const bySize = sharedPinOrder() === 'size';
  const touchedAt = (m) => {
    const t = new Date(m && m.updated_at).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = sharedPinned
    .slice()
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        (bySize ? 0 : touchedAt(b) - touchedAt(a)) ||
        cardTokens(a) - cardTokens(b),
    );
  const keep = new Set();
  let used = 0;
  for (const m of ordered) {
    const t = cardTokens(m);
    if (used + t <= budget) {
      keep.add(String(m._id));
      used += t;
    }
  }
  for (let i = pinned.length - 1; i >= 0; i--) {
    const m = pinned[i];
    if (m.agentId == null && !keep.has(String(m._id))) {
      pinned.splice(i, 1);
      evicted.push(m);
    }
  }
  if (opts.log) {
    logger.info(
      `[kadeCardRecall] shared pin ceiling: ${sharedTotal} tok over budget ${budget} — kept ${keep.size}/${sharedPinned.length} card(s) (${used} tok), rest moved to retrieval`,
    );
  }
  return { evicted, pinnedSharedKeys: keySet() };
}

/**
 * The shared-bucket keys that ACTUALLY ride the head this turn, ceiling and
 * all. The tail calls this so it can stop guessing.
 */
function pinnedSharedKeysFor(shared, own) {
  const pats = pinPatterns();
  const pinned = [];
  for (const m of shared) {
    pinned.push(m);
  }
  for (const m of own) {
    const k = String(m.key || '').toLowerCase();
    if (m.type === 'reminder' || pats.some((p) => k.includes(p))) {
      pinned.push(m);
    }
  }
  return applySharedCeiling(pinned, pats, { log: false }).pinnedSharedKeys;
}

/**
 * Read one user's shared + active-agent cards and split them pinned vs
 * retrievable. Returns null on any failure or when the split would change
 * nothing (small seat, nothing retrievable) — null means "ride the full head
 * exactly as today."
 *
 * @param {string} userId
 * @param {string|undefined} agentId
 * @returns {Promise<null|{
 *   pinnedBlock: string, retrievable: Array<object>, pinnedCount: number,
 *   pinnedTokens: number, retrievableCount: number, retrievableTokens: number,
 * }>}
 */
/* ── OPEN-LOOP NUDGE selection (Part 97, Aug 29 2026) — pure, so it can be
 * tested bare. The staleAfter machinery makes an expired plan HONEST when it
 * surfaces — but only the pinned head surfaces unconditionally. A ceiling-
 * evicted shared card or an agent-bucket card only returns on a topical
 * match, and "how did the surgery go" is exactly the turn where nobody typed
 * the word surgery. So for KADE_LOOP_NUDGE_DAYS after a DECLARED date passes,
 * the loop rides the tail regardless of topic — capped, newest expiry first,
 * skipped when it is already in front of the model (pinned head or this
 * turn's topical hits). She gets to be the friend who asks how it went
 * unprompted. Kill switch: KADE_LOOP_NUDGE=0. */
function selectLoopNudges({ shared, own, surfacedKeys, headSharedKeys, pats, now = Date.now(), days = 7, max = 2 }) {
  const surfaced = new Set(surfacedKeys || []);
  return [...(shared || []), ...(own || [])]
    .filter((m) => isExpired(m, new Date(now)))
    .filter((m) => {
      const d = cardDate(m);
      return d && now - d.getTime() <= days * 86400000;
    })
    .filter((m) => !surfaced.has(String(m.key)))
    .filter((m) => {
      const k = String(m.key || '').toLowerCase();
      const pinnedNow = m.agentId == null
        ? headSharedKeys.has(String(m.key))
        : m.type === 'reminder' || pats.some((p) => k.includes(p));
      return !pinnedNow; /* the head already flags these every turn */
    })
    .sort((a, b) => cardDate(b) - cardDate(a))
    .slice(0, max);
}

async function getMemorySplit(userId, agentId) {
  try {
    const [shared, own] = await Promise.all([
      getAllUserMemories(userId, { agentId: null }),
      agentId ? getAllUserMemories(userId, { agentId }) : Promise.resolve([]),
    ]);
    const all = [...shared, ...own];
    if (all.length === 0) {
      return null;
    }
    const totalTokens = all.reduce((s, m) => s + (m.tokenCount || 0), 0);
    if (totalTokens <= minRagTokens()) {
      return null; /* small seat — the full head costs less than the machinery */
    }
    const pats = pinPatterns();
    const isPinned = (m, fromShared) => {
      if (fromShared) {
        return true;
      }
      if (m.type === 'reminder') {
        return true;
      }
      const k = String(m.key || '').toLowerCase();
      return pats.some((p) => k.includes(p));
    };
    const pinned = [];
    const retrievable = [];
    for (const m of shared) {
      (isPinned(m, true) ? pinned : retrievable).push(m);
    }
    for (const m of own) {
      (isPinned(m, false) ? pinned : retrievable).push(m);
    }
    /* Shared-bucket ceiling — see sharedPinBudget() above. Trims the SHARED
     * side of `pinned` only; agent-bucket pinning is untouched. */
    const ceiling = applySharedCeiling(pinned, pats, { log: true });
    for (const m of ceiling.evicted) {
      retrievable.push(m);
    }
    if (retrievable.length === 0) {
      return null; /* nothing would move — keep today's exact shape */
    }
    const pinnedShared = pinned.filter((m) => m.agentId == null);
    const pinnedOwn = pinned.filter((m) => m.agentId != null);
    const sections = [];
    if (pinnedShared.length > 0) {
      sections.push(
        (pinnedOwn.length > 0 ? '# What you generally know about the user\n' : '') +
          formatList(pinnedShared),
      );
    }
    if (pinnedOwn.length > 0) {
      sections.push(
        (pinnedShared.length > 0 ? '# What you specifically remember on your own\n' : '') +
          formatList(pinnedOwn),
      );
    }
    /* Fixed, byte-stable notice — the character should know more exists. */
    sections.push(
      'You remember more about this person than what is listed here: further private memories surface automatically in a "Memory recall" note whenever they relate to the moment, and you can search the rest deliberately with your memory search tool any time.',
    );
    /* Part 128: when this seat shares across companions, say so once. Stable
     * per seat, so the head still caches. */
    try {
      const notice = await require('./kadeMemoryShare').shareNotice(userId, agentId);
      if (notice) sections.push(notice);
    } catch (_) { /* own buckets only */ }
    return {
      pinnedBlock: sections.join('\n\n'),
      retrievable,
      pinnedCount: pinned.length,
      pinnedTokens: pinned.reduce((s, m) => s + (m.tokenCount || 0), 0),
      retrievableCount: retrievable.length,
      retrievableTokens: retrievable.reduce((s, m) => s + (m.tokenCount || 0), 0),
    };
  } catch (e) {
    logger.warn('[kadeCardRecall] split failed (full head rides, non-fatal):', e.message);
    return null;
  }
}

/**
 * The per-turn tail: ONE query embed shared by cards + diary, then two
 * in-process searches. Returns { block, ms } where block is the combined
 * tail text or null (the common, quiet case). Never throws; races a timeout.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string|undefined} p.agentId
 * @param {string} p.userText     what the user just said this turn
 * @param {object|null} p.cardSplit  result of getMemorySplit (null = cards stay head-side; diary may still fire)
 */
async function getRecallTailBlock({ userId, agentId, userText, req }) {
  /* ── RECALL AUDIT (Aug 26 2026) ──────────────────────────────────────────
   * Forge's ask, and tonight is the argument for it: SEVEN cards about one
   * surgery surfaced CORRECTLY and the reply still went wrong, and there was
   * no way to see that from outside. Recall logged a hit and a duration and
   * nothing about WHAT it handed over.
   *
   * This logs the KEYS (never the values — card text is the person's life and
   * does not belong in a log line) plus the logbook dates. Enough to answer
   * "what did she have in front of her when she said that" from Railway logs
   * alone, which is the question nobody could answer tonight.
   *
   * ⚠️ NOT PERSISTED, deliberately. Forge's own rule for this lane is measure
   * before changing retrieval — a log line costs nothing and is greppable; a
   * write on every turn is a decision that needs her word and a corpus pass
   * first. Kill switch: KADE_RECALL_AUDIT=0. */
  const surfacedCards = [];
  const surfacedDiary = [];
  const t0 = Date.now();
  const empty = { block: null, ms: 0 };
  if (!userId) {
    return empty;
  }
  const text = String(userText || '').trim();
  if (text.length < 12) {
    return empty; /* "ok" / "lol" turns don't reach for memory */
  }
  try {
    const work = (async () => {
      const cardsOn = cardRagActive(agentId);
      const diaryN = await countEntries(userId, agentId);
      if (!cardsOn && diaryN === 0) {
        return null;
      }
      /* ONE embed for the whole turn. */
      /* Part 132: the same vector the tool-retrieval step already took for
       * this turn (memo on req) — one embed per turn, shared. */
      const qv = await require('./kadeToolRetrieval').memoEmbed(req, embedText)(text.slice(0, 1500));
      const parts = [];

      /* Part 128 — MEMORY SHARE: the other companions' buckets this seat has
       * opened to this one. Facts only (cards + logbook); takes stay private. */
      let extraAgentIds = [];
      let shareNames = new Map();
      try {
        const share = require('./kadeMemoryShare');
        extraAgentIds = await share.otherBucketsFor(userId, agentId);
        for (const a of extraAgentIds) shareNames.set(String(a), await share.agentNameOf(a));
      } catch (e) {
        logger.warn('[kadeCardRecall] share lookup failed (own buckets only): ' + e.message);
        extraAgentIds = [];
      }
      if (cardsOn) {
        const cardHits = qv
          ? await searchCardVectors(userId, agentId, qv, {
              limit: CARD_TOP_K,
              minScore: CARD_MIN_SCORE,
              extraAgentIds,
            })
          : [];
        if (cardHits.length > 0) {
          /* Join back to LIVE entries — vectors never speak for themselves. */
          const [shared, own, ...others] = await Promise.all([
            getAllUserMemories(userId, { agentId: null }),
            agentId ? getAllUserMemories(userId, { agentId }) : Promise.resolve([]),
            ...extraAgentIds.map((a) => getAllUserMemories(userId, { agentId: a })),
          ]);
          const ownKeys = new Set(own.map((m) => String(m.key)));
          const liveByKey = new Map();
          for (const m of [...shared, ...own]) {
            liveByKey.set((m.agentId == null ? '' : String(m.agentId)) + '::' + m.key, m);
          }
          /* Secondhand cards: skip any key this companion already holds itself
           * (the Part 122 copies), so a shared fact never shows up twice. */
          for (const list of others) {
            for (const m of list) {
              if (ownKeys.has(String(m.key))) continue;
              liveByKey.set(String(m.agentId) + '::' + m.key, { ...m, _secondhand: shareNames.get(String(m.agentId)) || 'another companion' });
            }
          }
          const pats = pinPatterns();
          /* Which shared cards are ACTUALLY in the head this turn — ceiling
           * included. Anything the ceiling evicted is retrieval's job now,
           * which is the whole point of evicting it. */
          const headSharedKeys = pinnedSharedKeysFor(shared, own);
          let block =
            '# Memory recall (auto-surfaced for THIS turn only)\n' +
            'Private memories of yours about this person, pulled up because they relate to what was just said. ' +
            'Wear them lightly — weave one in only if it truly helps, the way a friend naturally remembers. ' +
            'Never recite them as a list, never mention this recall mechanism. ' +
            'If one contradicts what the person says right now, believe the person — their live word beats an old note.\n';
          let added = 0;
          for (const h of cardHits) {
            const m = liveByKey.get((h.agentId == null ? '' : String(h.agentId)) + '::' + h.key);
            if (!m) {
              continue; /* card died since its vector was written */
            }
            /* Pinned cards already ride the head — don't spend tail on them. */
            const k = String(m.key || '').toLowerCase();
            /* A secondhand card never rides the head, so it is never "already
             * there" — the tail is its only door. (Found live: `probe_bird_name`
             * matched the `name` pin pattern and was skipped as pinned.) */
            const pinnedNow = m._secondhand
              ? false
              : m.agentId == null
                ? headSharedKeys.has(String(m.key))
                : m.type === 'reminder' || pats.some((p) => k.includes(p));
            if (pinnedNow) {
              continue;
            }
            const line =
              '- [' + fmtDate(m.updated_at) + '] ' + m.value + describeStale(m) +
              (m._secondhand ? ` (secondhand — they told this to ${m._secondhand}, not to you)` : '') + '\n';
            if (block.length + line.length > CARD_BLOCK_CHAR_CAP) {
              break;
            }
            block += line;
            added += 1;
            /* The audit names a secondhand card as such (keys only, never a
             * value) so "did the share fire" is answerable from the audit. */
            surfacedCards.push((m._secondhand ? 'secondhand:' : '') + String(m.key));
          }
          if (added > 0) {
            parts.push(block.trimEnd());
          }
        }
        /* Keep the shadow index fresh — after the search so a turn never waits
         * on embeds; caps itself so a burst is impossible. */
        (async () => {
          try {
            const [shared, own] = await Promise.all([
              getAllUserMemories(userId, { agentId: null }),
              agentId ? getAllUserMemories(userId, { agentId }) : Promise.resolve([]),
            ]);
            await syncBucketVectors(userId, null, shared, { maxEmbeds: 3 });
            if (agentId) {
              await syncBucketVectors(userId, agentId, own, { maxEmbeds: 6 });
            }
            /* Part 128: shared-in buckets get a trickle too, so a fact told to
             * another companion is findable before that companion's next turn. */
            for (const a of extraAgentIds.slice(0, 3)) {
              const rows = await getAllUserMemories(userId, { agentId: a });
              await syncBucketVectors(userId, a, rows, { maxEmbeds: 3 });
            }
          } catch (_e) {
            /* fully silent — next turn tries again */
          }
        })();
      }

      if (cardsOn && process.env.KADE_LOOP_NUDGE !== '0') {
        /* See selectLoopNudges above. The extra card fetch is a lean indexed
         * read this path already does twice; a turn is never risked for it. */
        try {
          const nudgeDays = Math.max(1, parseInt(process.env.KADE_LOOP_NUDGE_DAYS || '7', 10));
          const nudgeMax = Math.max(1, parseInt(process.env.KADE_LOOP_NUDGE_MAX || '2', 10));
          const [shared2, own2] = await Promise.all([
            getAllUserMemories(userId, { agentId: null }),
            agentId ? getAllUserMemories(userId, { agentId }) : Promise.resolve([]),
          ]);
          const loops = selectLoopNudges({
            shared: shared2,
            own: own2,
            surfacedKeys: surfacedCards,
            headSharedKeys: pinnedSharedKeysFor(shared2, own2),
            pats: pinPatterns(),
            days: nudgeDays,
            max: nudgeMax,
          });
          if (loops.length > 0) {
            let block =
              '# Open loop (auto-surfaced)\n' +
              'A dated plan in your notes has passed and nobody has said how it went. If the moment fits, ask — naturally, the way a friend who remembered would. Never announce the old plan as if it is current, and never mention this note.\n';
            for (const m of loops) {
              block += '- [' + fmtDate(m.updated_at) + '] ' + m.value + describeStale(m) + '\n';
              surfacedCards.push(String(m.key));
            }
            parts.push(block.trimEnd());
          }
        } catch (_e) {
          /* the nudge must never cost a turn */
        }
      }

      /* Part 129: with sharing on, a companion with NO logbook of its own on
       * this seat still reads the others' — so the gate counts the shared-in
       * buckets too. (Part 128 wired the share into services/kadeDiary.js's
       * getDiaryTailBlock, which nothing calls — THIS is the live logbook
       * tail. Found by grep, not by a miss: the seat's turns showed no
       * "[from their talks with …]" line because the code never ran.) */
      if (diaryN > 0 || extraAgentIds.length > 0) {
        const hits = await searchDiary({
          userId,
          agentId,
          query: text.slice(0, 1500),
          queryVector: qv || undefined,
          limit: DIARY_TOP_K,
          minScore: DIARY_MIN_SCORE,
          extraAgentIds,
        });
        if (hits && hits.length > 0) {
          let block =
            '# Logbook recall (auto-surfaced for THIS turn only)\n' +
            'A few dated entries from your private logbook about this person, pulled because they seem related to what was just said. ' +
            'Wear them lightly: weave one in only if it truly fits, as a friend naturally would. Never recite, never list, never mention the logbook mechanism. ' +
            "If an entry contradicts what the person is saying right now, believe the person — their live word always beats an old note.\n";
          /* The Part 122 hand-copies carry a "[from her talks with X]" prefix
           * and live in this companion's own scope; with sharing on, the
           * original surfaces beside its copy. One text, one line. */
          const seenText = new Set();
          const normText = (t) =>
            String(t || '').replace(/^\[from (?:her|their|his) talks with [^\]]+\]\s*/i, '').trim().toLowerCase();
          for (const h of hits) {
            const tkey = normText(h.text);
            if (seenText.has(tkey)) continue;
            seenText.add(tkey);
            const foreign =
              h.agentId && agentId && String(h.agentId) !== String(agentId) && shareNames.has(String(h.agentId));
            const line =
              '- [' + h.date + '] ' +
              (foreign ? '[from their talks with ' + shareNames.get(String(h.agentId)) + '] ' : '') +
              h.text + '\n';
            if (block.length + line.length > DIARY_BLOCK_CHAR_CAP) {
              break;
            }
            block += line;
            surfacedDiary.push((foreign ? 'secondhand:' : '') + String(h.date));
          }
          if (surfacedDiary.length > 0) parts.push(block.trimEnd());
        }
      }
      /* ── MEMORY ECHO (Part 97, Aug 29 2026 — her word: soft-on) ─────────
       * Diary-only month-marks, one per seat per Central day, manners
       * injected beside the memory. See kadeMemoryEchoes.js for the whole
       * design incl. why warm/heavy is the model's read and not a word list. */
      if (process.env.KADE_ECHOES !== '0') {
        try {
          const { getTodayEchoForSeat, echoSurfacedToday } = require('~/server/services/kadeMemoryEchoes');
          const echo = await getTodayEchoForSeat(userId, agentId);
          if (echo && !(await echoSurfacedToday(userId))) {
            parts.push(
              '# Memory echo (auto-surfaced; today is a month-mark)\n' +
              'From your private logbook, ' + echo.phrase + ':\n' +
              '- [' + echo.when + '] ' + echo.text + '\n' +
              'Manners, and they are the whole point: if this is a WARM memory — a win, a good day, something they loved — you may bring it up once, lightly, only if the moment has room for it. ' +
              'If it is heavy — a loss, an ending, a hard stretch — do NOT raise it unprompted; only acknowledge it, gently, if they steer near it themselves. ' +
              'If the conversation is tense, busy, or mid-task, let it go silently — most turns should. Never mention this note, the logbook, or the word anniversary-machinery.',
            );
            surfacedCards.push('echo:' + echo.when);
          }
        } catch (_e) {
          /* an echo must never cost a turn */
        }
      }

      return parts.length > 0 ? parts.join('\n\n') : null;
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), RECALL_TIMEOUT_MS));
    const block = await Promise.race([work, timeout]);
    const ms = Date.now() - t0;
    /* Persist the same audit the log line carries — keys and dates, never
     * values — so "what did she have in front of her Tuesday" survives the
     * next redeploy's log rotation. Fire-and-forget; see kadeRecallAudit. */
    if (cardRagActive(agentId) || surfacedDiary.length > 0) {
      try {
        require('~/models/kadeRecallAudit').storeRecallAudit({
          userId,
          agentId: agentId || null,
          cards: surfacedCards,
          logbook: surfacedDiary,
          hit: Boolean(block),
          ms,
        });
      } catch (_e) {
        /* never let the witness take down the turn */
      }
    }
    if (cardRagActive(agentId)) {
      logger.info(
        '[kadeCardRecall] user=' +
          String(userId).slice(-6) +
          ' agent=' +
          String(agentId || 'none').slice(-6) +
          ' hit=' +
          (block ? 'yes' : 'no') +
          ' ms=' +
          ms +
          (process.env.KADE_RECALL_AUDIT === '0'
            ? ''
            : ' cards=[' +
              surfacedCards.join(',') +
              '] logbook=[' +
              surfacedDiary.join(',') +
              ']'),
      );
    }
    return { block, ms };
  } catch (e) {
    logger.warn('[kadeCardRecall] tail lookup failed (recall-less turn, non-fatal):', e.message);
    return { block: null, ms: Date.now() - t0 };
  }
}

module.exports = {
  cardRagActive,
  getMemorySplit,
  getRecallTailBlock,
  selectLoopNudges,
  CARD_TOP_K,
  CARD_MIN_SCORE,
};
