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
const { describeStale } = require('~/server/services/kadeOpenLoops');

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
    const budget = sharedPinBudget();
    if (budget > 0) {
      const sharedPinned = pinned.filter((m) => m.agentId == null);
      const sharedTotal = sharedPinned.reduce((sum, m) => sum + cardTokens(m), 0);
      if (sharedTotal > budget) {
        const rankPats = pats.concat(SHARED_RANK_EXTRA);
        const rankOf = (m) => {
          if (m.type === 'reminder') {
            return 0;
          }
          const k = String(m.key || '').toLowerCase();
          return rankPats.some((p) => k.includes(p)) ? 1 : 2;
        };
        const ordered = sharedPinned
          .slice()
          .sort((a, b) => rankOf(a) - rankOf(b) || cardTokens(a) - cardTokens(b));
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
            retrievable.push(m);
          }
        }
        logger.info(
          `[kadeCardRecall] shared pin ceiling: ${sharedTotal} tok over budget ${budget} — kept ${keep.size}/${sharedPinned.length} card(s) (${used} tok), rest moved to retrieval`,
        );
      }
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
async function getRecallTailBlock({ userId, agentId, userText }) {
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
      const qv = await embedText(text.slice(0, 1500));
      const parts = [];

      if (cardsOn) {
        const cardHits = qv
          ? await searchCardVectors(userId, agentId, qv, {
              limit: CARD_TOP_K,
              minScore: CARD_MIN_SCORE,
            })
          : [];
        if (cardHits.length > 0) {
          /* Join back to LIVE entries — vectors never speak for themselves. */
          const [shared, own] = await Promise.all([
            getAllUserMemories(userId, { agentId: null }),
            agentId ? getAllUserMemories(userId, { agentId }) : Promise.resolve([]),
          ]);
          const liveByKey = new Map();
          for (const m of [...shared, ...own]) {
            liveByKey.set((m.agentId == null ? '' : String(m.agentId)) + '::' + m.key, m);
          }
          const pats = pinPatterns();
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
            const pinnedNow =
              m.agentId == null || m.type === 'reminder' || pats.some((p) => k.includes(p));
            if (pinnedNow) {
              continue;
            }
            const line = '- [' + fmtDate(m.updated_at) + '] ' + m.value + '\n';
            if (block.length + line.length > CARD_BLOCK_CHAR_CAP) {
              break;
            }
            block += line;
            added += 1;
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
          } catch (_e) {
            /* fully silent — next turn tries again */
          }
        })();
      }

      if (diaryN > 0) {
        const hits = await searchDiary({
          userId,
          agentId,
          query: text.slice(0, 1500),
          queryVector: qv || undefined,
          limit: DIARY_TOP_K,
          minScore: DIARY_MIN_SCORE,
        });
        if (hits && hits.length > 0) {
          let block =
            '# Logbook recall (auto-surfaced for THIS turn only)\n' +
            'A few dated entries from your private logbook about this person, pulled because they seem related to what was just said. ' +
            'Wear them lightly: weave one in only if it truly fits, as a friend naturally would. Never recite, never list, never mention the logbook mechanism. ' +
            "If an entry contradicts what the person is saying right now, believe the person — their live word always beats an old note.\n";
          for (const h of hits) {
            const line = '- [' + h.date + '] ' + h.text + '\n';
            if (block.length + line.length > DIARY_BLOCK_CHAR_CAP) {
              break;
            }
            block += line;
          }
          parts.push(block.trimEnd());
        }
      }
      return parts.length > 0 ? parts.join('\n\n') : null;
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), RECALL_TIMEOUT_MS));
    const block = await Promise.race([work, timeout]);
    const ms = Date.now() - t0;
    if (cardRagActive(agentId)) {
      logger.info(
        '[kadeCardRecall] user=' +
          String(userId).slice(-6) +
          ' agent=' +
          String(agentId || 'none').slice(-6) +
          ' hit=' +
          (block ? 'yes' : 'no') +
          ' ms=' +
          ms,
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
  CARD_TOP_K,
  CARD_MIN_SCORE,
};
