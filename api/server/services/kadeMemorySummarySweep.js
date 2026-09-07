/* KADE DREAMING — nightly sweep (Stage 2 of the episodic-memory build).
 *
 * The instant draft (Stage 1) refreshes a relationship's rolling summary right
 * after a CALL. This nightly pass covers the rest: every relationship that had
 * recent conversation activity gets its unseen turns reflected in chronological
 * batches across all of that relationship's chats. A saved cursor prevents
 * repeat work and preserves unfinished batches. Quiet relationships keep their
 * learned history; their context is dated when read.
 *
 * Self-contained + server-side (no Cowork/Claude session, no external cron):
 * an hourly setInterval that fires once per day at a target UTC hour, mirroring
 * the spirit of the weekly consolidation sweep. Fail-soft throughout; a bad run
 * never touches chats, calls, cards, or the merge. Disabled instantly by
 * KADE_MEMORY_SUMMARY=0 (same hatch as the rest of the dreaming layer).
 *
 * Tunable via env (all optional):
 *   KADE_SUMMARY_UTC_HOUR       target hour, 0-23 UTC        (default 8 = ~3am Central)
 *   KADE_SUMMARY_LOOKBACK_HOURS how far back "recent" is     (default 30)
 *   KADE_SUMMARY_MAX_PER_RUN    relationships refreshed per run  (default 250)
 *   KADE_SUMMARY_MAX_MSGS       messages per relationship batch  (default 80)
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { refreshSummaryFromText } = require('~/server/services/kadeMemorySummary');
const { buildReflectionBatch } = require('@librechat/api');
const { KadeMemorySummary, getMemorySummary } = require('~/models/kadeMemorySummary');

const HOUR_MS = 60 * 60 * 1000;

function enabled() {
  return String(process.env.KADE_MEMORY_SUMMARY || '') !== '0';
}
function intEnv(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : def;
}

/** Resolve an agent's display name (cached per sweep run); falls back to id. */
async function agentNameLookup(cache, agentId) {
  if (cache.has(agentId)) {
    return cache.get(agentId);
  }
  let name = null;
  try {
    const a = await db.getAgent({ id: agentId });
    name = (a && a.name) || null;
  } catch (_) {
    /* fall back to id */
  }
  cache.set(agentId, name);
  return name;
}

/**
 * One pass: reflect unseen activity and resume unfinished batches.
 * Returns a small stats object. Never throws.
 */
/* ⭐⭐⭐ READ THE REPLY WHEREVER IT ACTUALLY LIVES (Aug 19 2026).
 *
 * THE BUG: this sweep filtered turns with `typeof m.text === 'string' &&
 * m.text.trim()`. Modern LibreChat assistant replies do NOT populate `text` --
 * the reply lives in `content[]` blocks. Measured on Kade's live database:
 * across EVERY recently-active agent conversation, assistant messages with a
 * non-empty `.text` numbered ZERO. Not few. Zero.
 *
 * So the nightly "KADE DREAMING" relationship summary -- the thing that gives
 * a fresh conversation continuity, the running story of what has been going on
 * between a person and a character -- was being written from ONLY THE USER'S
 * HALF of the transcript. Nothing the character ever said reached it. And any
 * conversation short enough that the user's messages alone fell under the
 * two-turn floor was skipped outright, which is why the Aug 19 08:00 run
 * reported `refreshed: 0, skipped: 2` while several relationship summaries sat
 * frozen since Aug 16 and the diary and memory cards updated by the minute.
 *
 * The correct extractor already existed one file over, in kadeHistoryMiner's
 * `textOf()` -- which is exactly why the DIARY stayed healthy while the
 * summaries quietly starved. This is that same helper, applied here. Keep the
 * two in step. */
function summaryTextOf(m) {
  if (!m) {
    return '';
  }
  if (typeof m.text === 'string' && m.text.trim()) {
    return m.text.trim();
  }
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p && p.type === 'text')
      .map((p) => (typeof p.text === 'string' ? p.text : p.text && p.text.value) || '')
      .join('\n')
      .trim();
  }
  return '';
}

async function runSummarySweep() {
  if (!enabled()) {
    return { ran: false, reason: 'disabled' };
  }
  const Conversation = mongoose.models.Conversation;
  if (!Conversation) {
    return { ran: false, reason: 'no-conversation-model' };
  }

  const lookbackHours = intEnv('KADE_SUMMARY_LOOKBACK_HOURS', 30);
  const maxPerRun = intEnv('KADE_SUMMARY_MAX_PER_RUN', 250);
  const maxMsgs = intEnv('KADE_SUMMARY_MAX_MSGS', 80);
  const since = new Date(Date.now() - lookbackHours * HOUR_MS);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  const decayed = 0;
  let pending = 0;

  try {
    // Recently-active agent conversations, newest first.
    const convos = await Conversation.find(
      { updatedAt: { $gte: since }, agent_id: { $exists: true, $ne: null } },
      'conversationId user agent_id updatedAt',
    )
      .sort({ updatedAt: -1 })
      .limit(5000)
      .lean();

    const perRelationship = new Map();
    for (const c of convos) {
      if (!c.user || !c.agent_id || !c.conversationId) continue;
      const key = `${String(c.user)}::${String(c.agent_id)}`;
      if (!perRelationship.has(key)) perRelationship.set(key, c);
    }
    // A bounded batch left unfinished yesterday must stay eligible after the lookback window.
    const backlogs = await KadeMemorySummary.find({ 'nightlyCursor.pending': true }, 'userId agentId').lean();
    for (const row of backlogs) {
      const key = `${row.userId}::${row.agentId}`;
      if (!perRelationship.has(key)) perRelationship.set(key, { user: row.userId, agent_id: row.agentId });
    }
    const targets = Array.from(perRelationship.values()).slice(0, maxPerRun);
    const nameCache = new Map();

    for (const c of targets) {
      try {
        const userId = String(c.user);
        const agentId = String(c.agent_id);
        const user = await db.getUserById(userId, 'personalization');
        if (!user || user.personalization?.memories === false) {
          skipped++;
          continue;
        }
        const prior = await getMemorySummary(userId, agentId);
        const cursor = prior?.nightlyCursor?.at && prior?.nightlyCursor?.messageId ? prior.nightlyCursor : null;
        const from = cursor ? new Date(cursor.at) : since;
        const until = new Date();
        const sources = await Conversation.find({
          user: userId, agent_id: agentId, updatedAt: { $gte: from },
        }, 'conversationId').lean();
        const turns = [];
        for (const source of sources) {
          if (await require('@librechat/data-schemas').getConversationMemoryPolicy(userId, source.conversationId)) continue;
          const msgs = await db.getMessages({ conversationId: source.conversationId, user: userId });
          for (const m of msgs || []) {
            if (m.error || m.unfinished || !m.createdAt) continue;
            turns.push({
              messageId: m.messageId, conversationId: source.conversationId,
              role: m.isCreatedByUser ? 'user' : 'assistant',
              text: summaryTextOf(m).replace(/\[EARLIER IN THIS CONVERSATION[\s\S]*?Reply ONLY to what follows\.\]\s*/gi, ''),
              at: m.updatedAt || m.createdAt,
            });
          }
        }
        const batch = buildReflectionBatch({
          turns, cursor, since: since.toISOString(), until: until.toISOString(), maxMessages: maxMsgs,
        });
        if (!batch) { skipped += 1; continue; }
        const agentName = await agentNameLookup(nameCache, agentId);
        const res = await refreshSummaryFromText({
          userId, agentId, agentName,
          conversationText: batch.text,
          lastActivityAt: new Date(Math.max(new Date(batch.cursor.at).getTime(), new Date(prior?.lastActivityAt || 0).getTime())),
          asOf: batch.cursor.at,
          nightlyCursor: batch.cursor,
          source: 'nightly',
          sourceConversationIds: [...new Set(turns.map((turn) => turn.conversationId))],
        });
        if (batch.cursor.pending) pending += 1;
        if (res) {
          refreshed += 1;
        } else {
          skipped += 1;
        }
      } catch (inner) {
        failed += 1;
        logger.warn(`[kadeSummarySweep] relationship refresh failed: ${inner && inner.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[kadeSummarySweep] sweep query failed: ${err && err.message}`);
  }

  // Quiet relationships retain their learned history and opinions. Injection already dates them.
  // Forgetting is an explicit user action, not a side effect of being away for 45 days.
  logger.info(
    `[kadeSummarySweep] done: ${refreshed} refreshed, ${skipped} skipped, ${failed} failed, ${decayed} decayed, ${pending} pending`,
  );
  return { ran: true, refreshed, skipped, failed, decayed, pending };
}

/** The in-memory scheduler limits runs; stored cursors prevent replay after restarts. */
let _lastRunDay = null;

function startMemorySummarySweep() {
  if (!enabled()) {
    logger.info('[kadeSummarySweep] disabled via KADE_MEMORY_SUMMARY=0 — not scheduling.');
    return;
  }
  const targetHour = intEnv('KADE_SUMMARY_UTC_HOUR', 8);
  const tick = async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() !== targetHour) {
        return;
      }
      const dayKey = now.toISOString().slice(0, 10);
      if (_lastRunDay === dayKey) {
        return;
      }
      _lastRunDay = dayKey;
      logger.info('[kadeSummarySweep] nightly dreaming run starting…');
      await runSummarySweep();
    } catch (err) {
      logger.warn(`[kadeSummarySweep] tick failed: ${err && err.message}`);
    }
  };
  setInterval(tick, HOUR_MS);
  // Catch the case where we boot during the target hour.
  setTimeout(tick, 60 * 1000);
  logger.info(
    `[kadeSummarySweep] scheduler started — hourly check, fires once/day at ${targetHour}:00 UTC.`,
  );
}

module.exports = { runSummarySweep, startMemorySummarySweep };
