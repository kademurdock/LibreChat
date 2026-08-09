const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeDiaryEntry } = require('~/models/kadeDiary');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);

/**
 * Aug 7 2026 — the DIARY housekeeping lane, third sibling beside
 * /api/admin/convos and /api/admin/memories, born the same evening as the
 * Living Diary itself. The first live test proved the need within the hour:
 * the keeper logged two "asked me to check the diary" meta-entries — junk by
 * the diary's own standards — and there was no way to delete them. A write
 * path without a delete path repeats the hallucinated-cards problem she just
 * lived through, so this lane ships WITH the diary, not someday after.
 *
 * Same guardrails as the memories lane: owner-gated (ACCESS_ADMIN +
 * READ_USERS), DELETE returns the removed entry so the caller can archive it
 * before it is gone, loud log lines, fail-soft audit.
 */
router.use(requireJwtAuth, requireAdminAccess, requireReadUsers);

function auditFailSoft(req, action, targetUserId, entryId, detail) {
  try {
    if (typeof db.recordAuditEntry === 'function') {
      void db
        .recordAuditEntry({
          category: 'admin',
          action,
          outcome: 'success',
          severity: 'info',
          actor: { id: String(req.user.id), type: 'user' },
          target: { id: String(entryId), type: 'diary', userId: String(targetUserId) },
          metadata: detail || {},
        })
        .catch((e) => logger.warn(`[admin-diary] audit entry failed (non-blocking): ${e.message}`));
    }
  } catch (e) {
    logger.warn(`[admin-diary] audit entry failed (non-blocking): ${e.message}`);
  }
}

/** GET /?userId=<id>[&agentId=<id>][&limit=200] — one user's diary, newest first.
 *  Embeddings never ride the response (bulk floats, nothing a human reads). */
router.get('/', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const filter = { userId };
    if (req.query.agentId !== undefined) {
      filter.agentId = String(req.query.agentId) || null;
    }
    const entries = await KadeDiaryEntry.find(filter)
      .sort({ entryDate: -1, createdAt: -1 })
      .limit(limit)
      .select('-embedding')
      .lean();
    res.json({
      entries: entries.map((e) => ({
        id: String(e._id),
        date: e.entryDate,
        text: e.text,
        agentId: e.agentId || null,
        source: e.source || null,
        salience: e.salience || 1,
        embedded: Boolean(e.embedModel),
        createdAt: e.createdAt,
      })),
      count: entries.length,
    });
  } catch (error) {
    logger.error('[admin-diary] list failed', error);
    res.status(500).json({ error: 'Failed to list diary entries' });
  }
});

/** POST / — BACKFILL lane (supervised card sort, history mining): body
 *  { userId, text, agentId?, scope?, entryDate? (YYYY-MM-DD), source? }.
 *  Embeds like any write; source defaults 'backfill'; keeper meta-guard does
 *  not apply to backfill (admin-driven, deliberate). */
router.post('/', async (req, res) => {
  try {
    const { userId, text, agentId = null, scope = 'agent', entryDate = null, source = 'backfill', salience = 1 } = req.body || {};
    if (!userId || !text) {
      return res.status(400).json({ error: 'userId and text are required' });
    }
    const { logDiaryEntry } = require('~/models/kadeDiary');
    const result = await logDiaryEntry({ userId, agentId, text, scope, source, entryDate, salience });
    if (!result.ok) {
      return res.status(500).json({ error: result.error || 'write failed' });
    }
    logger.info(`[admin-diary] backfill entry | admin: ${req.user.id} | user: ${userId} | date: ${result.date} | ${String(text).slice(0, 60)}`);
    auditFailSoft(req, 'admin_diary_backfill', userId, result.date, { source });
    res.json({ ok: true, date: result.date });
  } catch (error) {
    logger.error('[admin-diary] backfill failed', error);
    res.status(500).json({ error: 'Failed to write entry' });
  }
});

/** PATCH /:entryId?userId=<id> — rewrite one entry in place (MEMORY QUALITY
 *  PACK, Aug 9 2026, built FOR the supervised corpus sweep): body
 *  { text?, salience? }. The id, date, scope, and source survive — a rewrite
 *  is a better sentence, not a new memory. Text changes re-embed. */
router.patch('/:entryId', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    const { entryId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const text = req.body?.text !== undefined ? String(req.body.text) : null;
    const salience = req.body?.salience !== undefined ? req.body.salience : null;
    const { editDiaryEntry } = require('~/models/kadeDiary');
    const result = await editDiaryEntry({ _id: entryId, userId }, { text, salience });
    if (!result.ok) {
      return res
        .status(result.error === 'not found' ? 404 : result.error === 'nothing to change' || result.error === 'empty text' ? 400 : 500)
        .json({ error: result.error });
    }
    logger.info(
      `[admin-diary] entry edited | admin: ${req.user.id} | user: ${userId} | date: ${result.entry.entryDate} | ${String(result.entry.text).slice(0, 80)}`,
    );
    auditFailSoft(req, 'admin_diary_edit', userId, entryId, { date: result.entry.entryDate });
    res.json({
      ok: true,
      entry: {
        id: String(result.entry._id),
        date: result.entry.entryDate,
        text: result.entry.text,
        agentId: result.entry.agentId || null,
        source: result.entry.source || null,
        salience: result.entry.salience || 1,
      },
    });
  } catch (error) {
    logger.error('[admin-diary] edit failed', error);
    res.status(500).json({ error: 'Failed to edit diary entry' });
  }
});

/** DELETE /:entryId?userId=<id> — delete one entry; the removed entry rides the
 *  response so the caller can archive it first. */
router.delete('/:entryId', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    const { entryId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const entry = await KadeDiaryEntry.findOne({ _id: entryId, userId }).select('-embedding').lean();
    if (!entry) {
      return res.status(404).json({ error: 'Diary entry not found for that user' });
    }
    await KadeDiaryEntry.deleteOne({ _id: entryId, userId });
    logger.info(
      `[admin-diary] entry deleted | admin: ${req.user.id} | user: ${userId} | date: ${entry.entryDate} | text: ${String(entry.text).slice(0, 80)}`,
    );
    auditFailSoft(req, 'admin_diary_delete', userId, entryId, { date: entry.entryDate });
    res.json({
      ok: true,
      deleted: {
        id: String(entry._id),
        date: entry.entryDate,
        text: entry.text,
        agentId: entry.agentId || null,
        source: entry.source || null,
        createdAt: entry.createdAt,
      },
    });
  } catch (error) {
    logger.error('[admin-diary] delete failed', error);
    res.status(500).json({ error: 'Failed to delete diary entry' });
  }
});

module.exports = router;
