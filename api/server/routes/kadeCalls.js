/* Calls & Conversations history (July 5 2026).
 *
 * Phone calls were fully ephemeral and conversation-mode calls were buried in
 * the normal chat list. This router is the single backend for the /calls page:
 *   GET    /api/kade/calls          list the signed-in user's calls (newest first)
 *   GET    /api/kade/calls/:id      one call's full transcript (owner only)
 *   DELETE /api/kade/calls/:id      remove a call from history (owner only)
 *   POST   /api/kade/calls/ingest   secret-guarded machine ingest (phone bridge)
 *   POST   /api/kade/calls/mine     signed-in ingest (conversation mode client)
 * Transcript text only; no audio is stored.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeCallTranscript, logKadeCall } = require('~/models/kadeCallTranscript');
const { callsHtml } = require('./kadeCallsPage');

const router = express.Router();

const uidOf = (req) => String((req.user && (req.user.id || req.user._id)) || '');

function preview(turns) {
  if (!Array.isArray(turns) || !turns.length) {
    return '';
  }
  const first = turns.find((t) => t && t.role === 'user' && t.text) || turns.find((t) => t && t.text);
  const text = first && first.text ? String(first.text) : '';
  return text.length > 140 ? text.slice(0, 139).trimEnd() + '…' : text;
}

/* ---- list ---------------------------------------------------------------- */
router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const userId = uidOf(req);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 60));
    const docs = await KadeCallTranscript.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const calls = docs.map((d) => ({
      id: String(d._id),
      surface: d.surface || 'conversation',
      agentName: d.agentName || 'Kiana',
      callerName: d.callerName || null,
      startedAt: d.startedAt || d.createdAt,
      durationSec: d.durationSec || 0,
      turnCount: d.turnCount || (Array.isArray(d.turns) ? d.turns.length : 0),
      preview: preview(d.turns),
    }));
    res.json({ calls });
  } catch (err) {
    logger.error('[/api/kade/calls] list error:', err);
    res.status(500).json({ error: 'Could not load your calls right now.' });
  }
});

/* ---- one transcript (owner only) ---------------------------------------- */
router.get('/:id', requireJwtAuth, async (req, res) => {
  try {
    const userId = uidOf(req);
    const doc = await KadeCallTranscript.findOne({ _id: req.params.id, user: userId }).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Call not found.' });
    }
    res.json({
      id: String(doc._id),
      surface: doc.surface || 'conversation',
      agentName: doc.agentName || 'Kiana',
      callerName: doc.callerName || null,
      from: doc.from || null,
      startedAt: doc.startedAt || doc.createdAt,
      endedAt: doc.endedAt || null,
      durationSec: doc.durationSec || 0,
      turnCount: doc.turnCount || (Array.isArray(doc.turns) ? doc.turns.length : 0),
      turns: (doc.turns || []).map((t) => ({ role: t.role, text: t.text, at: t.at })),
    });
  } catch (err) {
    logger.error('[/api/kade/calls/:id] get error:', err);
    res.status(500).json({ error: 'Could not load that transcript.' });
  }
});

/* ---- delete from history (owner only) ----------------------------------- */
router.delete('/:id', requireJwtAuth, async (req, res) => {
  try {
    const userId = uidOf(req);
    const r = await KadeCallTranscript.deleteOne({ _id: req.params.id, user: userId });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (err) {
    logger.error('[/api/kade/calls/:id] delete error:', err);
    res.status(500).json({ error: 'Could not delete that call.' });
  }
});

/* ---- machine ingest (phone bridge) — secret guarded ---------------------- */
router.post('/ingest', async (req, res) => {
  try {
    const expected = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.body || {}).secret !== expected) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const b = req.body || {};
    const id = await logKadeCall({
      userId: b.userId,
      userEmail: b.userEmail,
      surface: 'phone',
      agentId: b.agentId,
      agentName: b.agentName,
      callerName: b.callerName,
      from: b.from,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      turns: b.turns,
      metadata: b.metadata,
    });
    res.json({ ok: true, saved: !!id, id: id ? String(id) : null });
  } catch (err) {
    logger.error('[/api/kade/calls/ingest] error:', err);
    res.status(500).json({ error: 'ingest failed' });
  }
});

/* ---- signed-in ingest (conversation mode client) ------------------------ */
router.post('/mine', requireJwtAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const id = await logKadeCall({
      userId: uidOf(req),
      surface: 'conversation',
      agentId: b.agentId,
      agentName: b.agentName,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      turns: b.turns,
      conversationId: b.conversationId,
      metadata: b.metadata,
    });
    res.json({ ok: true, saved: !!id, id: id ? String(id) : null });
  } catch (err) {
    logger.error('[/api/kade/calls/mine] error:', err);
    res.status(500).json({ error: 'save failed' });
  }
});

/* ---- friendly HTML page: GET /calls ------------------------------------- */
router.page = (req, res) => res.type('html').send(callsHtml);

module.exports = router;
