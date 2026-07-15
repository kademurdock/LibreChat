/* KADE DREAMING — nightly sweep (Stage 2 of the episodic-memory build).
 *
 * The instant draft (Stage 1) refreshes a relationship's rolling summary right
 * after a CALL. This nightly pass covers the rest: every relationship that had
 * recent conversation activity (text OR calls) gets its "what's been going on
 * lately" summary refreshed, and summaries whose relationship has gone quiet
 * decay away. This is the "dreaming" cadence.
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
 *   KADE_SUMMARY_STALE_DAYS     decay a summary after N quiet days (default 45)
 *   KADE_SUMMARY_MAX_PER_RUN    relationships refreshed per run  (default 250)
 *   KADE_SUMMARY_MAX_MSGS       messages read per conversation   (default 80)
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { refreshSummaryFromText, turnsToText } = require('~/server/services/kadeMemorySummary');
const { deleteStaleMemorySummaries } = require('~/models/kadeMemorySummary');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
 * One pass: refresh recently-active relationships, then decay quiet ones.
 * Returns a small stats object. Never throws.
 */
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
  const staleDays = intEnv('KADE_SUMMARY_STALE_DAYS', 45);
  const since = new Date(Date.now() - lookbackHours * HOUR_MS);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  let decayed = 0;

  try {
    // Recently-active agent conversations, newest first.
    const convos = await Conversation.find(
      { updatedAt: { $gte: since }, agent_id: { $exists: true, $ne: null } },
      'conversationId user agent_id updatedAt',
    )
      .sort({ updatedAt: -1 })
      .limit(5000)
      .lean();

    // Collapse to the most-recent conversation per (user, agent) relationship.
    const perRelationship = new Map();
    for (const c of convos) {
      if (!c.user || !c.agent_id || !c.conversationId) {
        continue;
      }
      const key = `${String(c.user)}::${String(c.agent_id)}`;
      if (!perRelationship.has(key)) {
        perRelationship.set(key, c);
      }
    }
    const targets = Array.from(perRelationship.values()).slice(0, maxPerRun);
    const nameCache = new Map();

    for (const c of targets) {
      try {
        const userId = String(c.user);
        const agentId = String(c.agent_id);
        const msgs = await db.getMessages({ conversationId: c.conversationId, user: userId });
        const turns = (msgs || [])
          .filter((m) => m && typeof m.text === 'string' && m.text.trim())
          .slice(-maxMsgs)
          .map((m) => ({ role: m.isCreatedByUser ? 'user' : 'assistant', text: m.text }));
        if (turns.length < 2) {
          skipped += 1;
          continue;
        }
        const agentName = await agentNameLookup(nameCache, agentId);
        const res = await refreshSummaryFromText({
          userId,
          agentId,
          agentName,
          conversationText: turnsToText(turns),
          lastActivityAt: c.updatedAt,
          source: 'nightly',
        });
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

  // Decay: drop summaries whose relationship has been quiet past the threshold.
  try {
    decayed = await deleteStaleMemorySummaries(new Date(Date.now() - staleDays * DAY_MS));
  } catch (err) {
    logger.warn(`[kadeSummarySweep] decay failed: ${err && err.message}`);
  }

  logger.info(
    `[kadeSummarySweep] done: ${refreshed} refreshed, ${skipped} skipped, ${failed} failed, ${decayed} decayed`,
  );
  return { ran: true, refreshed, skipped, failed, decayed };
}

/** In-memory once-per-day guard (a restart during the target hour may re-run —
 *  harmless: refreshes are idempotent-ish and cheap, decay is idempotent). */
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
