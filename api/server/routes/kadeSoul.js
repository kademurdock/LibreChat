/**
 * KADE Oct 16 2026: /api/kade/soul — the person's own view of a character, and the
 * door other services use to have a character speak first.
 *
 *   GET    /:agentId                   how the character is coming in (in words), when you
 *                                       last talked, and your moments together. Your own only.
 *   DELETE /:agentId/moments/:id       forget one moment.
 *   POST   /speak                      (machine, x-kade-secret = BRIDGE_SECRET) a character writes
 *                                       a real message into a person's conversation and a push
 *                                       opens it. Body: { userId | email, agentId, note,
 *                                       conversationId?, title?, kind?, platformPaid?, requested?,
 *                                       steps?, push? }. See services/kadeCharacterTurn.js.
 *
 * The page never shows a character's private take on the person (Kade's decision,
 * Oct 16 2026); that stays with the character.
 */
const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const soul = require('~/server/services/kadeSoul');

const router = express.Router();

const AGENT_ID = /^agent_[A-Za-z0-9_-]{6,64}$/;

function machine(req) {
  const expected = String(process.env.BRIDGE_SECRET || '');
  const given = String(req.get('x-kade-secret') || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/* At most a few composed turns at once across the whole site. */
let running = 0;
const MAX_RUNNING = Number(process.env.KADE_SPEAK_MAX_RUNNING || 3);

router.post('/speak', express.json({ limit: '64kb' }), async (req, res) => {
  if (!machine(req)) return res.status(403).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const agentId = String(b.agentId || '');
  const note = String(b.note || '').trim();
  if (!AGENT_ID.test(agentId)) return res.status(400).json({ error: 'agentId required' });
  if (note.length < 10 || note.length > 6000) return res.status(400).json({ error: 'note must be 10 to 6000 characters' });
  let userId = String(b.userId || '');
  try {
    if (!userId && b.email) {
      const User = require('mongoose').models.User;
      const u = await User.findOne({ email: String(b.email).trim().toLowerCase() }).select('_id').lean();
      userId = u ? String(u._id) : '';
    }
  } catch (_) {
    userId = '';
  }
  if (!/^[a-f0-9]{24}$/.test(userId)) return res.status(400).json({ error: 'a known userId or email is required' });
  if (running >= MAX_RUNNING) return res.status(429).json({ error: 'busy, try again in a minute' });
  running += 1;
  try {
    const { speakFirst } = require('~/server/services/kadeCharacterTurn');
    const out = await speakFirst({
      userId,
      agentId,
      note,
      conversationId: b.conversationId ? String(b.conversationId) : undefined,
      title: b.title ? String(b.title) : undefined,
      kind: /^[a-z][a-z0-9-]{1,30}$/.test(String(b.kind || '')) ? String(b.kind) : 'post',
      platformPaid: b.platformPaid === true,
      requested: b.requested === true,
      steps: Number.isFinite(Number(b.steps)) ? Math.min(80, Math.max(0, Number(b.steps))) : undefined,
      push: b.push !== false,
    });
    return res.json({ ok: true, ...out });
  } catch (e) {
    logger.warn('[kadeSoul/speak] failed: ' + (e && e.message));
    return res.status(502).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  } finally {
    running -= 1;
  }
});

/* The person's own background tasks (services/kadeTasks.js), newest first. */
router.get('/tasks/list', requireJwtAuth, async (req, res) => {
  try {
    const { list } = require('~/server/services/kadeTasks');
    return res.json({ tasks: await list({ userId: String(req.user.id), limit: 20 }) });
  } catch (e) {
    return res.status(500).json({ error: 'could not read your tasks right now' });
  }
});

router.post('/tasks/:taskId/cancel', requireJwtAuth, async (req, res) => {
  try {
    const { cancel } = require('~/server/services/kadeTasks');
    const out = await cancel({ userId: String(req.user.id), taskId: String(req.params.taskId || '') });
    return res.status(out.ok ? 200 : 409).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'could not stop it right now' });
  }
});

router.get('/:agentId', requireJwtAuth, async (req, res) => {
  const agentId = String(req.params.agentId || '');
  if (!AGENT_ID.test(agentId)) return res.status(400).json({ error: 'not a character id' });
  try {
    const snap = await soul.soulSnapshot({ userId: String(req.user.id), agentId });
    /* The character's own days (the same for everyone it talks to). A private character's or a
     * Spotter's days show only to its owner (Oct 29 2026 privacy repair, services/kadeCharacterDays). */
    let days = [];
    try {
      const { daysVisibleTo } = require('~/server/services/kadeCharacterDays');
      if (!(await daysVisibleTo(agentId, req.user))) throw new Error('not yours to read');
      days = await require('mongoose')
        .connection.collection('kadecharacterdays')
        .find({ agentId, kind: 'day' })
        .sort({ day: -1 })
        .limit(3)
        .project({ _id: 0, day: 1, text: 1, following: 1, home: 1 })
        .toArray();
    } catch (_) {
      days = [];
    }
    return res.json({ ...snap, days });
  } catch (e) {
    logger.warn('[kadeSoul] snapshot failed: ' + e.message);
    return res.status(500).json({ error: 'could not read this right now' });
  }
});

router.delete('/:agentId/moments/:id', requireJwtAuth, async (req, res) => {
  const agentId = String(req.params.agentId || '');
  if (!AGENT_ID.test(agentId)) return res.status(400).json({ error: 'not a character id' });
  try {
    const out = await soul.forgetMoment({ userId: String(req.user.id), agentId, id: req.params.id });
    return res.status(out.ok ? 200 : 404).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'could not forget that right now' });
  }
});

module.exports = router;
