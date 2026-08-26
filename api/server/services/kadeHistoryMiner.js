/* KADE HISTORY MINER (Aug 8 2026, her ask: "proactively scan every user's
 * chats and create memories and log entries for things in their past chats
 * that would have fallen into this system now, but then it wasn't developed
 * enough to know better").
 *
 * What it does: walks conversations OLDEST-FIRST, per user, and runs the same
 * keeper brain (mistral-small, processMemory) over each finished conversation
 * with history-specific instructions. Output: dated LOGBOOK entries stamped
 * with the conversation's real Central date (source 'mined'), plus — rarely —
 * a durable card when history holds a still-true fact the live keeper never
 * met. The whole summer, remembered the way it would have been.
 *
 * Trust envelope: identical to the live memory system — the same machine
 * writer already reads every live turn; no human eyes, results scoped to the
 * character who was in the room (forceAgentScope), shared bucket untouched.
 *
 * Safety rails, in order of importance:
 *  - HISTORY CAN NEVER ERASE THE PRESENT: deleteMemory is a refusing stub.
 *  - Cards from history never overwrite live cards: existing cards ride the
 *    context and the instructions forbid touching them; writes are pinned to
 *    the convo's agent bucket.
 *  - Run-once per conversation: atomic claim in kademiningstates.
 *  - Paced (KADE_MINER_DELAY_MS, default 1500) + per-kick cap
 *    (maxPerRun, default 150) + stop flag checked every iteration.
 *  - Fail-soft per convo: one bad conversation logs and moves on.
 *  - Kill switch: KADE_MINER=0 refuses to start.
 *
 * Cost: one mistral-small pass per conversation (~$0.001 typical) + Gemini
 * embeddings per written entry (~hundredth of a cent). A 500-conversation
 * account ≈ fifty cents. Numbers reported by /status.
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { processMemory, resolveMemoryAgentLLMConfig } = require('@librechat/api');
const { HumanMessage, AIMessage, getBufferString } = require('@librechat/agents/langchain/messages');
const { getFormattedMemories, setMemory, getUserKey, getUserKeyValues } = require('~/models');
const { logDiaryEntry, centralDateString } = require('~/models/kadeDiary');
const { KadeMiningState } = require('~/models/kadeMiningState');
const { getAppConfig } = require('~/server/services/Config');

const MAX_BUFFER_CHARS = 60000;
const DELAY_MS = Math.max(500, parseInt(process.env.KADE_MINER_DELAY_MS, 10) || 1500);

/* In-process control. A deploy mid-run simply stops the run; state in Mongo
 * means the next kick resumes exactly where it left off. */
const control = {
  running: false,
  stopRequested: false,
  startedAt: null,
  scope: null,
  processed: 0,
  entriesLogged: 0,
  errors: 0,
  lastConvoId: null,
};

function minerEnabled() {
  return process.env.KADE_MINER !== '0';
}

function miningInstructions(convoDate, agentName) {
  return `You are reading ONE OLD conversation from ${convoDate}, between the user and the character "${agentName}". The platform's logbook did not exist back then — your job is to write, today, what the logbook WOULD have recorded that day. This is archaeology, not live listening.

WHAT TO WRITE — logbook entries via log_diary (they are dated to that old day automatically):
- Real life-moments the user shared: things that happened, how something went, plans made, moods that defined the day.
- Rabbit holes: if the user genuinely dug into a topic with curiosity (asked, followed up, reacted), ONE light line naming what caught them and the gem that landed. A single passing question is not a rabbit hole.
- Story beats of ongoing sagas or projects as they stood THAT day.
Write each entry as one or two plain past-tense sentences with the gist, like a friend's journal. Most conversations deserve 0 to 2 entries; many deserve NONE (task chatter, quick lookups, small talk with nothing in it). Zero entries is a correct and common answer.

CARDS (set_memory) — RARE from history: only a durable, clearly STILL-TRUE fact about the user that is NOT already in the existing memory shown to you, and could not have changed since. When unsure whether it is still true, do NOT file a card — write a dated logbook entry instead, since the entry carries its own timeframe. Never rewrite, tighten, or touch any existing card: live memory outranks history, always.

NEVER: never call delete_memory (it will refuse); never log the mechanics of the conversation itself (asking to check memory, tool usage, assistant work); never file the character's own statements as facts about the user; never invent anything not present in the text.`;
}

async function mineOneConversation({ convo, memoryConfig, appConfig }) {
  const userId = String(convo.user);
  const agentId = convo.agent_id ? String(convo.agent_id).slice(0, 64) : undefined;
  const convoDate = centralDateString(new Date(convo.createdAt));

  const msgs = await mongoose.models.Message.find({ conversationId: convo.conversationId })
    .sort({ createdAt: 1 })
    .select('text isCreatedByUser sender content')
    .lean();
  const textOf = (m) => {
    if (m.text && m.text.trim()) return m.text;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p) => p && p.type === 'text')
        .map((p) => (typeof p.text === 'string' ? p.text : p.text && p.text.value) || '')
        .join('\n');
    }
    return '';
  };
  const turns = msgs.map((m) => ({ user: Boolean(m.isCreatedByUser), text: textOf(m).trim() })).filter((t) => t.text);
  if (turns.length < 2) {
    return { skipped: 'too-short' };
  }
  const lc = turns.map((t) => (t.user ? new HumanMessage(t.text) : new AIMessage(t.text)));
  let buffer = getBufferString(lc);
  if (buffer.length > MAX_BUFFER_CHARS) {
    buffer =
      buffer.slice(0, 20000) +
      '\n\n[Middle of a long conversation omitted]\n\n' +
      buffer.slice(-30000);
  }

  const llmConfig = await resolveMemoryAgentLLMConfig({
    appConfig,
    memoryConfig,
    userId,
    db: { getUserKey, getUserKeyValues },
  });
  const { withKeys, totalTokens } = await getFormattedMemories({ userId, agentId });

  let logged = 0;
  const stubRes = { headersSent: false };
  await processMemory({
    res: stubRes,
    userId,
    agentId,
    messages: [new HumanMessage(`# The old conversation (from ${convoDate}):\n\n${buffer}`)],
    validKeys: undefined,
    llmConfig,
    messageId: `mine-${convo.conversationId}`,
    tokenLimit: memoryConfig.tokenLimit,
    conversationId: String(convo.conversationId),
    memory: withKeys || '',
    totalTokens: totalTokens || 0,
    instructions: miningInstructions(convoDate, convo.title || 'the character'),
    forceAgentScope: Boolean(agentId),
    setMemory,
    /* HISTORY CAN NEVER ERASE THE PRESENT. */
    deleteMemory: async () => ({ ok: false, message: 'History mining never deletes memory.' }),
    logDiary: async ({ text, scope }) => {
      const result = await logDiaryEntry({
        userId,
        agentId,
        text,
        scope,
        source: 'mined',
        entryDate: convoDate,
      });
      if (result.ok) {
        logged += 1;
      }
      return result;
    },
    user: { id: userId },
  });
  return { logged };
}

/** Kick a mining run. scope: a userId string, or 'all'. Returns immediately;
 *  work continues in the background. */
async function startMining({ scope = 'all', maxPerRun = 150 } = {}) {
  if (!minerEnabled()) {
    return { ok: false, error: 'KADE_MINER=0' };
  }
  if (control.running) {
    return { ok: false, error: 'already running', status: minerStatus() };
  }
  const appConfig = await getAppConfig();
  const memoryConfig = appConfig && appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true || !memoryConfig.agent?.model) {
    return { ok: false, error: 'memory writer not configured' };
  }
  control.running = true;
  control.stopRequested = false;
  control.startedAt = new Date();
  control.scope = scope;
  control.processed = 0;
  control.entriesLogged = 0;
  control.errors = 0;

  (async () => {
    try {
      const filter = {
        agent_id: { $exists: true, $ne: null },
        $or: [{ expiredAt: null }, { expiredAt: { $exists: false } }],
      };
      if (scope !== 'all') {
        filter.user = scope;
      }
      const cap = Math.min(Math.max(parseInt(maxPerRun, 10) || 150, 1), 2000);
      /* Oldest first — the logbook fills in chronological order. */
      const cursor = mongoose.models.Conversation.find(filter)
        .sort({ createdAt: 1 })
        .select('conversationId user agent_id createdAt title')
        .lean()
        .cursor();
      for await (const convo of cursor) {
        if (control.stopRequested || control.processed >= cap) {
          break;
        }
        /* Atomic run-once claim. */
        try {
          await KadeMiningState.create({
            conversationId: String(convo.conversationId),
            userId: String(convo.user),
            agentId: convo.agent_id ? String(convo.agent_id) : null,
            status: 'claimed',
          });
        } catch (dupe) {
          continue; /* already mined or claimed */
        }
        control.lastConvoId = String(convo.conversationId);
        try {
          const result = await mineOneConversation({ convo, memoryConfig, appConfig });
          control.processed += 1;
          control.entriesLogged += result.logged || 0;
          await KadeMiningState.updateOne(
            { conversationId: String(convo.conversationId) },
            { $set: { status: result.skipped ? `skipped:${result.skipped}` : 'done', entries: result.logged || 0, minedAt: new Date() } },
          );
        } catch (e) {
          control.errors += 1;
          control.processed += 1;
          logger.warn(`[historyMiner] convo ${convo.conversationId} failed (moving on): ${e.message}`);
          await KadeMiningState.updateOne(
            { conversationId: String(convo.conversationId) },
            { $set: { status: 'error', note: String(e.message).slice(0, 200), minedAt: new Date() } },
          ).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
      logger.info(
        `[historyMiner] run finished: scope=${scope} processed=${control.processed} entries=${control.entriesLogged} errors=${control.errors}`,
      );
    } catch (e) {
      logger.error('[historyMiner] run crashed (state preserved, re-kick resumes):', e.message);
    } finally {
      control.running = false;
    }
  })();

  return { ok: true, started: true, scope, maxPerRun };
}

/**
 * RE-MINE A WINDOW (Aug 26 2026, her ask: "even if you need to rerun every
 * conversation from every user through these systems again… I don't want anyone
 * to have anything missing from the logs and memories just because of our screw
 * up").
 *
 * WHY IT EXISTS. The logbook went silent: ~45 entries a day on Aug 17-19, then
 * 17, 7, 3, 2, and ZERO from Aug 24 on. The cause was salience, not capability —
 * the same keeper model that logged a rabbit hole 1 time in 3 under the live
 * instructions logged it 3 times in 3 under the miner's. So those days ARE
 * recoverable, but only if the miner is allowed to walk them again, and its
 * run-once claim is what stops it.
 *
 * ⚠️ THIS DELETES CLAIM ROWS AND NOTHING ELSE. It never touches a diary entry, a
 * card, or a message. The worst case is that a conversation gets read a second
 * time — which is now safe, because logDiaryEntry dedups within a day. Ship
 * order matters and it was: dedup FIRST, then this.
 *
 * ⚠️ A WINDOW IS REQUIRED. There is no "reset everything" — an unbounded reset
 * would re-walk 522 conversations and cost real money for no reason. Both dates
 * are YYYY-MM-DD and match the conversation's CREATION day, because that is the
 * day the miner stamps its entries with (`convoDate` above).
 *
 * @param {object} p
 * @param {string} p.from  YYYY-MM-DD, inclusive
 * @param {string} p.to    YYYY-MM-DD, inclusive
 * @param {string} [p.scope]  a userId, or 'all'
 * @param {boolean} [p.dry]   count only, delete nothing
 */
async function resetMining({ from, to, scope = 'all', dry = false } = {}) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(String(from || '')) || !DATE.test(String(to || ''))) {
    return { ok: false, error: 'from and to are required, formatted YYYY-MM-DD' };
  }
  if (String(from) > String(to)) {
    return { ok: false, error: 'from is after to' };
  }
  if (control.running) {
    return { ok: false, error: 'a mining run is in progress — stop it first' };
  }
  try {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    const convoFilter = {
      agent_id: { $exists: true, $ne: null },
      createdAt: { $gte: start, $lte: end },
    };
    if (scope !== 'all') {
      convoFilter.user = scope;
    }
    const convos = await mongoose.models.Conversation.find(convoFilter)
      .select('conversationId')
      .lean();
    const ids = convos.map((c) => String(c.conversationId));
    if (!ids.length) {
      return { ok: true, window: { from, to }, scope, conversations: 0, cleared: 0, dry: Boolean(dry) };
    }
    const claimed = await KadeMiningState.countDocuments({ conversationId: { $in: ids } });
    if (dry) {
      return { ok: true, window: { from, to }, scope, conversations: ids.length, wouldClear: claimed, dry: true };
    }
    const r = await KadeMiningState.deleteMany({ conversationId: { $in: ids } });
    logger.info(
      `[historyMiner] RESET window ${from}..${to} scope=${scope}: cleared ${r.deletedCount} claim(s) over ${ids.length} conversation(s) — the next kick will re-walk them.`,
    );
    return {
      ok: true,
      window: { from, to },
      scope,
      conversations: ids.length,
      cleared: r.deletedCount,
      next: 'POST /api/admin/mining/start to re-walk them',
    };
  } catch (e) {
    logger.error('[historyMiner] reset failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function stopMining() {
  control.stopRequested = true;
  return { ok: true, stopping: control.running };
}

async function minerStatus() {
  const [done, errors, claimed] = await Promise.all([
    KadeMiningState.countDocuments({ status: { $in: ['done'] } }),
    KadeMiningState.countDocuments({ status: 'error' }),
    KadeMiningState.countDocuments({ status: 'claimed' }),
  ]);
  const skipped = await KadeMiningState.countDocuments({ status: { $regex: '^skipped' } });
  const liveFilter = {
    agent_id: { $exists: true, $ne: null },
    $or: [{ expiredAt: null }, { expiredAt: { $exists: false } }],
  };
  const totalConvos = await mongoose.models.Conversation.countDocuments(liveFilter);

  /* ⚠️ AUG 26 2026 — `remaining` USED TO BE A FALSE ALL-CLEAR, and it is the
   * same disease as everything else found this week: a number that looks
   * healthy and is not.
   *
   * It was `totalConvos - done - skipped - errors`, which subtracts STATE ROWS
   * from LIVE CONVERSATIONS — two different populations. A state row survives
   * its conversation, so after 229 conversations were deleted on Aug 26 the
   * sum read 413 - 522 - 14 = negative, clamped to 0, and the endpoint
   * cheerfully reported "remaining: 0, nothing left to mine" while 150 real
   * conversations had never been walked at all.
   *
   * Now it asks the only question that matters — HOW MANY LIVE CONVERSATIONS
   * HAVE NO CLAIM ROW — by intersecting the two id sets. At this scale (low
   * hundreds) that is one cheap projection each; the cap keeps it honest if
   * the platform ever grows, and says so rather than guessing. */
  let remaining = null;
  let remainingExact = true;
  try {
    const CAP = Math.max(1000, parseInt(process.env.KADE_MINER_STATUS_CAP, 10) || 5000);
    const liveIds = await mongoose.models.Conversation.find(liveFilter)
      .select('conversationId')
      .limit(CAP + 1)
      .lean();
    remainingExact = liveIds.length <= CAP;
    const ids = liveIds.slice(0, CAP).map((c) => String(c.conversationId));
    const claimedRows = await KadeMiningState.find({ conversationId: { $in: ids } })
      .select('conversationId')
      .lean();
    const claimedSet = new Set(claimedRows.map((r) => String(r.conversationId)));
    remaining = ids.reduce((n, id) => n + (claimedSet.has(id) ? 0 : 1), 0);
  } catch (e) {
    logger.warn('[historyMiner] exact remaining failed, falling back to the old estimate:', e.message);
    remaining = Math.max(0, totalConvos - done - skipped - errors);
    remainingExact = false;
  }
  /* Claim rows whose conversation is gone — deleted chats, mostly. Harmless,
   * but they are why the old arithmetic went negative, so they are named. */
  const orphanClaims = Math.max(0, done + skipped + errors - (totalConvos - remaining));
  return {
    running: control.running,
    scope: control.scope,
    startedAt: control.startedAt,
    thisRun: {
      processed: control.processed,
      entriesLogged: control.entriesLogged,
      errors: control.errors,
      lastConvoId: control.lastConvoId,
    },
    allTime: { done, skipped, errors, stuckClaims: claimed - (control.running ? 1 : 0), orphanClaims },
    remaining,
    remainingExact,
    totalConvos,
  };
}

module.exports = { startMining, stopMining, minerStatus, resetMining };
