const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeDiaryEntry, logDiaryEntry, diaryEnabled } = require('~/models/kadeDiary');
const db = require('~/models');

const router = express.Router();

/**
 * Aug 7 2026 — the USER-facing diary lane (Phase 4 of the Living Diary, her
 * "build that screen" word). Own entries only, always scoped to the JWT user —
 * this is the API the /diary web page runs on and the native app can reuse
 * verbatim for a Diary screen later.
 *
 * Semantics:
 *  - GET / lists the caller's entries newest-first (embeddings never ride the
 *    wire), each with the character's display name resolved so the page can
 *    say "with Kiana" instead of an agent id.
 *  - POST / adds a MANUAL entry (source 'manual'). Manual entries are SHARED
 *    scope on purpose: written in her own diary rather than told to one
 *    character, so any of her companions may recall it. The page says this
 *    in plain words.
 *  - DELETE /:id forgets one entry, own entries only, and answers with the
 *    removed entry (same delete-with-receipt manner as the admin lanes).
 *
 * The KADE_DIARY=0 kill switch closes writes here too; reading stays open so
 * the page can still show what exists even while the diary is paused.
 */
router.use(requireJwtAuth);

/** Resolve agent ids -> display names, fail-soft, tiny in-request cache. */
async function resolveAgentNames(agentIds) {
  const names = {};
  for (const id of agentIds) {
    if (!id) {
      continue;
    }
    try {
      const agent = await db.getAgent({ id });
      if (agent?.name) {
        names[id] = agent.name;
      }
    } catch (_e) {
      /* a nameless row beats a broken page */
    }
  }
  return names;
}

/** GET / — the caller's diary, newest first. Optional ?limit= (default 400, max 1000). */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 400, 1), 1000);
    const entries = await KadeDiaryEntry.find({ userId: String(req.user.id) })
      .sort({ entryDate: -1, createdAt: -1 })
      .limit(limit)
      .select('-embedding')
      .lean();
    const distinctAgents = [...new Set(entries.map((e) => e.agentId).filter(Boolean))];
    const agentNames = await resolveAgentNames(distinctAgents);
    res.json({
      enabled: diaryEnabled(),
      count: entries.length,
      entries: entries.map((e) => ({
        id: String(e._id),
        date: e.entryDate,
        text: e.text,
        agentId: e.agentId || null,
        agentName: e.agentId ? agentNames[e.agentId] || null : null,
        source: e.source || 'keeper',
        createdAt: e.createdAt,
      })),
    });
  } catch (error) {
    logger.error('[diary] list failed', error);
    res.status(500).json({ error: 'Failed to load your diary' });
  }
});

/** POST / — add a manual entry to the caller's own diary (shared scope, see header). */
router.post('/', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'The entry text is empty' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Keep an entry under 2,000 characters' });
    }
    const result = await logDiaryEntry({
      userId: req.user.id,
      agentId: null,
      text,
      scope: 'shared',
      source: 'manual',
    });
    if (!result.ok) {
      return res.status(result.error === 'diary disabled' ? 503 : 500).json({
        error: result.error === 'diary disabled' ? 'The diary is currently paused' : 'Failed to save the entry',
      });
    }
    res.json({ ok: true, date: result.date });
  } catch (error) {
    logger.error('[diary] manual add failed', error);
    res.status(500).json({ error: 'Failed to save the entry' });
  }
});

/** DELETE /:entryId — forget one of the caller's own entries. */
router.delete('/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const entry = await KadeDiaryEntry.findOne({ _id: entryId, userId: String(req.user.id) })
      .select('-embedding')
      .lean();
    if (!entry) {
      return res.status(404).json({ error: 'That entry was not found in your diary' });
    }
    await KadeDiaryEntry.deleteOne({ _id: entryId, userId: String(req.user.id) });
    logger.info(
      `[diary] user forgot an entry | user: ${req.user.id} | date: ${entry.entryDate} | text: ${String(entry.text).slice(0, 60)}`,
    );
    res.json({
      ok: true,
      deleted: { id: String(entry._id), date: entry.entryDate, text: entry.text },
    });
  } catch (error) {
    logger.error('[diary] delete failed', error);
    res.status(500).json({ error: 'Failed to forget the entry' });
  }
});

module.exports = router;
