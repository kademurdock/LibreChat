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

const KIANA_ID = 'agent_6llV0eMu4fmIaj8f2x1Sb';
const CARD_TOP_K = 5;
const CARD_MIN_SCORE = 0.3;
const RECALL_TIMEOUT_MS = 2500;
const CARD_BLOCK_CHAR_CAP = 1400;
const DIARY_TOP_K = 3;
const DIARY_MIN_SCORE = 0.32;
const DIARY_BLOCK_CHAR_CAP = 1200;

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
    'family,accessib,blind,screen_reader,pronounc,identity,call_me,name';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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

function formatList(list) {
  return list
    .slice()
    .sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0))
    .map(
      (m, i) => i + 1 + '. [' + fmtDate(m.updated_at) + ']. ' + m.value + describeReminderCompact(m),
    )
    .join('\n\n');
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
