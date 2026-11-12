'use strict';
/* KADE Nov 12 2026 (platform audit, phase 3 A2): saved messages as every app shows and speaks them.
 * GET /api/kade/messages/:conversationId answers { messages: [...] }: the same rows as LibreChat's
 * GET /api/messages/:conversationId (a bare array, left untouched for the website), plus
 * kade.readableText on each row that has text. ?after=<ISO time> returns only rows created after it,
 * so a phone that already holds the transcript reads the new tail, not the whole chat (AND-6, IOS-20).
 *
 * Limits: `after` filters on createdAt, so a row that changes later (a reply that gains a memory receipt)
 * is not returned again. Only the caller's own rows are read. Branches are not resolved (version 1 shows
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
        filter.createdAt = { $gt: after };
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
