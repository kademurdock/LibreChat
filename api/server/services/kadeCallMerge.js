/* Merge phone-call transcripts into the normal conversation history (July 13 2026).
 *
 * ADDITIVE + IDEMPOTENT: KadeCallTranscript stays the source of truth; each phone
 * transcript is MIRRORED into a native LibreChat conversation + messages so it
 * shows up in the regular chat list (read by the battle-tested, screen-reader-
 * friendly chat screen instead of the custom /calls page). We stamp
 * `mergedConversationId` on the transcript and skip anything already minted, so
 * re-runs never duplicate. Fail-soft: a mint error never breaks call logging.
 * Conversation-mode calls already have their own real conversation, so only
 * PHONE transcripts are minted.
 */
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { saveConvo, saveMessage } = require('~/models');
const { KadeCallTranscript } = require('~/models/kadeCallTranscript');

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

function fmtWhen(d) {
  // KADE July 16 2026: this runs SERVER-side (Railway = UTC), so without an
  // explicit zone every merged call was titled 5-6 hours off ("4:55 AM" for a
  // late-evening call). The user base is Kade's Central-time family; override
  // with KADE_DISPLAY_TZ if that ever changes.
  try {
    return new Date(d).toLocaleString('en-US', {
      timeZone: process.env.KADE_DISPLAY_TZ || 'America/Chicago',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

/**
 * Mint one native conversation + messages from a call transcript doc (lean).
 * Returns the conversationId, or null (already-merged / empty / error).
 */
async function mintConversationFromTranscript(doc, opts = {}) {
  try {
    if (!doc || !doc.user) {
      return null;
    }
    const userId = String(doc.user);
    if (doc.mergedConversationId && !opts.force) {
      return String(doc.mergedConversationId);
    }
    const turns = Array.isArray(doc.turns) ? doc.turns.filter((t) => t && t.text) : [];
    if (!turns.length) {
      return null;
    }

    /* KADE July 22 2026 (call continuity, her spec: "if it's still open
     * when they hit call again, it needs to continue that open conversation
     * instead of making multiple conversations for what could be the same
     * session"): a bridge ingest can now carry the app's OPEN conversation
     * on doc.conversationId (the schema's existing link-back field). When
     * it names a real conversation OWNED BY THIS USER, the call's turns are
     * APPENDED there -- chained off its real last message, title left
     * alone -- and mergedConversationId is stamped with the SAME id, so the
     * app's post-call handoff resolves to the conversation the caller was
     * already inside. Any mismatch (wrong owner, deleted, malformed) falls
     * back to the fresh mint, exactly as before. */
    let conversationId = uuidv4();
    let appendTarget = null;
    let parent = NO_PARENT;
    if (doc.conversationId) {
      try {
        const Conversation = mongoose.models.Conversation || mongoose.model('Conversation');
        const existing = await Conversation.findOne(
          { conversationId: String(doc.conversationId), user: userId },
          { conversationId: 1 },
        ).lean();
        if (existing) {
          appendTarget = String(doc.conversationId);
          conversationId = appendTarget;
          const Message = mongoose.models.Message || mongoose.model('Message');
          const lastMsg = await Message.find(
            { conversationId: appendTarget, user: userId },
            { messageId: 1 },
          )
            .sort({ createdAt: -1 })
            .limit(1)
            .lean();
          if (lastMsg && lastMsg[0] && lastMsg[0].messageId) {
            parent = String(lastMsg[0].messageId);
          }
        }
      } catch (e) {
        logger.warn(`[kadeCallMerge] append-target lookup failed, minting fresh: ${e.message}`);
        appendTarget = null;
        conversationId = uuidv4();
        parent = NO_PARENT;
      }
    }
    const agentName = doc.agentName || 'Kiana';
    const callerLabel = doc.callerName || 'You';
    const when = doc.startedAt || doc.createdAt || new Date();
    const surfaceWord = doc.surface === 'phone' ? 'Phone call' : 'Voice chat';

    for (const t of turns) {
      const messageId = uuidv4();
      const isUser = t.role === 'user';
      const at = t.at || when;
      await saveMessage(
        { userId },
        {
          messageId,
          conversationId,
          parentMessageId: parent,
          // Per-turn attribution (July 2026): a Spotter turn carries its own
          // agentName so it's credited to the Spotter (e.g. Whitney) rather
          // than the base agent the call started on (e.g. Kiana). Ordinary
          // turns have no per-turn agentName and fall back to the call's.
          sender: isUser ? callerLabel : (t.agentName || agentName),
          text: String(t.text || ''),
          isCreatedByUser: isUser,
          user: userId,
          unfinished: false,
          error: false,
          createdAt: at,
          updatedAt: at,
        },
        { context: 'kadeCallMerge' },
      );
      parent = messageId;
    }

    const convoFields = appendTarget
      ? {
          // Appending: the conversation already has its name and birthday --
          // only its freshness moves.
          conversationId,
          updatedAt: new Date(doc.endedAt || when),
        }
      : {
          conversationId,
          title: `${surfaceWord} with ${agentName} — ${fmtWhen(when)}`,
          endpoint: 'agents',
          createdAt: new Date(when),
          updatedAt: new Date(doc.endedAt || when),
        };
    if (!appendTarget && doc.agentId) {
      convoFields.agent_id = doc.agentId;
    }
    await saveConvo({ userId }, convoFields, {
      context: 'kadeCallMerge',
      createdAtOnInsert: new Date(when),
    });

    await KadeCallTranscript.updateOne(
      { _id: doc._id },
      { $set: { mergedConversationId: conversationId } },
    );
    logger.info(
      `[kadeCallMerge] ${appendTarget ? 'appended into' : 'minted'} convo ${conversationId} from transcript ${doc._id} (${turns.length} turns, ${doc.surface})`,
    );
    return conversationId;
  } catch (err) {
    logger.warn(
      `[kadeCallMerge] mint failed for transcript ${doc && doc._id}: ${err && err.message}`,
    );
    return null;
  }
}

/** Backfill: mint every not-yet-merged PHONE transcript (bounded per call). */
async function backfillPhoneTranscripts({ limit = 50 } = {}) {
  const docs = await KadeCallTranscript.find({
    surface: { $in: ['phone', 'web'] },
    $or: [{ mergedConversationId: { $exists: false } }, { mergedConversationId: null }],
  })
    .sort({ createdAt: 1 })
    .limit(Math.min(500, Math.max(1, limit)))
    .lean();
  let minted = 0;
  for (const d of docs) {
    const cid = await mintConversationFromTranscript(d);
    if (cid) {
      minted += 1;
    }
  }
  return { scanned: docs.length, minted };
}

module.exports = { mintConversationFromTranscript, backfillPhoneTranscripts };
