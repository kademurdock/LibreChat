const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);

/**
 * Aug 7 2026 — the owner's conversation-housekeeping lane (her go: "you can
 * build that admin thing"). Design honors her own house rule ("I have promised
 * not to look at people's chats intentionally... that doesn't mean I shouldn't
 * have the ability considering it's my dwelling"):
 *
 *   - The LIST endpoint returns METADATA ONLY (title, dates, message count) —
 *     the cleanup workflow judges by title and shape, never by content.
 *   - DELETE returns the full conversation + messages in its response so the
 *     calling tool can archive straight to disk before the data is gone. The
 *     content rides through the wire once, into a backup file, unread.
 *   - Every mutation logs a loud [admin-convos] line, and an audit entry is
 *     attempted fail-soft (a broken audit shape must never block housekeeping,
 *     but the log line always lands).
 *
 * Gated ACCESS_ADMIN + READ_USERS, the same pair as the users router.
 */
router.use(requireJwtAuth, requireAdminAccess, requireReadUsers);

function auditFailSoft(req, action, targetUserId, conversationId, detail) {
  try {
    if (typeof db.recordAuditEntry === 'function') {
      void db
        .recordAuditEntry({
          category: 'admin',
          action,
          outcome: 'success',
          severity: 'info',
          actor: { id: String(req.user.id), type: 'user' },
          target: { id: String(conversationId), type: 'conversation', userId: String(targetUserId) },
          metadata: detail || {},
        })
        .catch((e) => logger.warn(`[admin-convos] audit entry failed (non-blocking): ${e.message}`));
    }
  } catch (e) {
    logger.warn(`[admin-convos] audit entry failed (non-blocking): ${e.message}`);
  }
}

/** GET /?userId=<id>&cursor=<cursor> — metadata-only page of a user's conversations. */
router.get('/', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const result = await db.getConvosByCursor(userId, { cursor, limit: 25 });
    const convos = result?.conversations || [];
    const ids = convos.map((c) => c.conversationId).filter(Boolean);
    const counts = {};
    if (ids.length) {
      const rows = await mongoose.models.Message.aggregate([
        { $match: { conversationId: { $in: ids } } },
        { $group: { _id: '$conversationId', n: { $sum: 1 } } },
      ]);
      rows.forEach((r) => {
        counts[r._id] = r.n;
      });
    }
    res.json({
      conversations: convos.map((c) => ({
        conversationId: c.conversationId,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        endpoint: c.endpoint,
        messageCount: counts[c.conversationId] || 0,
      })),
      nextCursor: result?.nextCursor || null,
    });
  } catch (error) {
    logger.error('[admin-convos] list failed', error);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

/** PATCH /:conversationId  body { userId, title } — retitle another user's conversation. */
router.patch('/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = String(req.body?.userId || '').trim();
    const title = String(req.body?.title || '').trim().slice(0, 200);
    if (!userId || !title) {
      return res.status(400).json({ error: 'userId and title are required' });
    }
    const updated = await mongoose.models.Conversation.findOneAndUpdate(
      { conversationId, user: userId },
      { title },
      { new: true },
    ).lean();
    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found for that user' });
    }
    logger.info(`[admin-convos] RETITLE by ${req.user.id}: user=${userId} convo=${conversationId} -> "${title}"`);
    auditFailSoft(req, 'conversation.retitle', userId, conversationId, { title });
    res.json({ ok: true, conversationId, title: updated.title });
  } catch (error) {
    logger.error('[admin-convos] retitle failed', error);
    res.status(500).json({ error: 'Failed to retitle conversation' });
  }
});

/** DELETE /:conversationId?userId=<id> — delete-with-export: the response carries the
 * full conversation + messages for the caller to archive; then it is gone. */
router.delete('/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const conversation = await db.getConvo(userId, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found for that user' });
    }
    const messages = await mongoose.models.Message.find({ conversationId }).lean();
    const dbResponse = await db.deleteConvos(userId, { conversationId });
    logger.info(
      `[admin-convos] DELETE by ${req.user.id}: user=${userId} convo=${conversationId} title="${conversation.title}" msgs=${messages.length}`,
    );
    auditFailSoft(req, 'conversation.delete', userId, conversationId, {
      title: conversation.title,
      messageCount: messages.length,
    });
    res.json({ ok: true, deleted: dbResponse, archived: { conversation, messages } });
  } catch (error) {
    logger.error('[admin-convos] delete failed', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

module.exports = router;
