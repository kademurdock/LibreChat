'use strict';
/* KADE Nov 12 2026 (platform audit, phase 3 A2): saved messages as every app shows and speaks them.
 * GET /api/kade/messages/:conversationId answers { messages: [...] }: the same rows as LibreChat's
 * GET /api/messages/:conversationId (a bare array, left untouched for the website), plus
 * kade.readableText on each row that has text. ?after=<ISO time> returns only rows created after it,
 * so a phone that already holds the transcript reads the new tail, not the whole chat (AND-6, IOS-20).
 *
 * Nov 13 2026 (sweep 4.5): `after` now also matches rows CHANGED after it (updatedAt), not only rows
 * created after it. A reply saved partial on a disconnect and finished later, or one that gains a
 * memory receipt, comes back in the next tail read; apps upsert by messageId. No app sends `after`
 * yet. KADE_MESSAGES_AFTER=created goes back to createdAt only. Only the caller's own rows are read. Branches are not resolved (version 1 shows
 * the flat history, as both apps do today). */
const { withReadableText } = require('../utils/kadeReadableText');

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function createKadeMessagesHandler({ getMessages, logger = console }) {
  return async function kadeMessages(req, res) {
    try {
      const conversationId = String(req.params.conversationId || '');
      if (!CONVERSATION_ID.test(conversationId)) {
        return res.status(400).json({ error: 'Bad conversation id' });
      }
      const filter = { conversationId, user: req.user.id };
      const after = req.query && req.query.after ? new Date(String(req.query.after)) : null;
      if (after && !Number.isNaN(after.getTime())) {
        const createdOnly =
          String(process.env.KADE_MESSAGES_AFTER ?? '')
            .trim()
            .toLowerCase() === 'created';
        if (createdOnly) {
          filter.createdAt = { $gt: after };
        } else {
          // createdAt stays in the match for any old row that has no updatedAt.
          filter.$or = [{ updatedAt: { $gt: after } }, { createdAt: { $gt: after } }];
        }
      }
      const rows = await getMessages(filter, '-_id -__v -user');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ messages: (rows || []).map(withReadableText) });
    } catch (e) {
      logger.error('[kade/messages] failed:', e);
      return res.status(500).json({ error: 'Could not load messages' });
    }
  };
}

module.exports = { createKadeMessagesHandler };
