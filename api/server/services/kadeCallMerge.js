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
const { logger } = require('@librechat/data-schemas');
const { saveConvo, saveMessage } = require('~/models');
const { KadeCallTranscript } = require('~/models/kadeCallTranscript');

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

function fmtWhen(d) {
  try {
    return new Date(d).toLocaleString('en-US', {
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

    const conversationId = uuidv4();
    const agentName = doc.agentName || 'Kiana';
    const callerLabel = doc.callerName || 'You';
    const when = doc.startedAt || doc.createdAt || new Date();
    const surfaceWord = doc.surface === 'phone' ? 'Phone call' : 'Voice chat';

    let parent = NO_PARENT;
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
          sender: isUser ? callerLabel : agentName,
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

    const convoFields = {
      conversationId,
      title: `${surfaceWord} with ${agentName} — ${fmtWhen(when)}`,
      endpoint: 'agents',
      createdAt: new Date(when),
      updatedAt: new Date(doc.endedAt || when),
    };
    if (doc.agentId) {
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
      `[kadeCallMerge] minted convo ${conversationId} from transcript ${doc._id} (${turns.length} turns, ${doc.surface})`,
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
