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
const { mintConversationFromTranscript, backfillPhoneTranscripts } = require('~/server/services/kadeCallMerge');
const { extractMemoryFromCall } = require('~/server/services/kadeCallMemoryWrite');
const { refreshSummaryFromCall } = require('~/server/services/kadeMemorySummary');
const { runSummarySweep } = require('~/server/services/kadeMemorySummarySweep');

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
      /* KADE July 16 2026 (overnight audit): the bridge has sent the real
       * surface ('web' for browser streaming calls) all along — this route
       * hardcoded 'phone' and threw it away, so every web call was stored,
       * titled ("Phone call with…" instead of the intended "Voice chat
       * with…", see kadeCallMerge's surfaceWord), and logged as a phone
       * call. Allowlisted, not passed through blind. */
      surface: b.surface === 'web' ? 'web' : 'phone',
      agentId: b.agentId,
      agentName: b.agentName,
      callerName: b.callerName,
      from: b.from,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      turns: b.turns,
      metadata: b.metadata,
    });
    if (id) {
      // going-forward: mirror this phone call into the normal chat history (fail-soft)
      KadeCallTranscript.findById(id)
        .lean()
        .then(async (doc) => {
          if (!doc) {
            return;
          }
          await mintConversationFromTranscript(doc);
          // Calls TEACH memory now (parity with text): run the salience-fixed
          // memory-writer over the finished transcript. Re-read so it sees the
          // fresh mergedConversationId. Fully fail-soft — never breaks ingest.
          const fresh = await KadeCallTranscript.findById(id).lean();
          await extractMemoryFromCall(fresh || doc);
          // DREAMING: also refresh this relationship's rolling episodic
          // summary from the call (instant draft; nightly sweep tidies it).
          await refreshSummaryFromCall(fresh || doc);
        })
        .catch(() => {});
    }
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

/* ---- merge maintenance (secret-guarded): mint call transcripts into chats --- */
function mergeSecretOk(req) {
  const expected = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
  return !!expected && (req.body || {}).secret === expected;
}

// Mint ONE transcript (by id, or the most recent phone call) — the safe test path.
router.post('/merge-one', async (req, res) => {
  if (!mergeSecretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const b = req.body || {};
    const doc = b.id
      ? await KadeCallTranscript.findById(b.id).lean()
      : await KadeCallTranscript.findOne({ surface: { $in: ['phone', 'web'] } }).sort({ createdAt: -1 }).lean();
    if (!doc) {
      return res.json({ ok: true, found: false });
    }
    const conversationId = await mintConversationFromTranscript(doc, { force: !!b.force });
    res.json({
      ok: true,
      found: true,
      transcriptId: String(doc._id),
      surface: doc.surface,
      agentName: doc.agentName,
      turns: Array.isArray(doc.turns) ? doc.turns.length : 0,
      conversationId,
    });
  } catch (err) {
    logger.error('[/api/kade/calls/merge-one] error:', err);
    res.status(500).json({ error: 'merge failed' });
  }
});

// Backfill every not-yet-merged PHONE transcript (bounded).
router.post('/merge-backfill', async (req, res) => {
  if (!mergeSecretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const limit = Math.min(500, parseInt((req.body || {}).limit, 10) || 50);
    const result = await backfillPhoneTranscripts({ limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[/api/kade/calls/merge-backfill] error:', err);
    res.status(500).json({ error: 'backfill failed' });
  }
});

/* ---- OLD WEB CALLS STORED AS PHONE (July 17 2026, proposal D) -------------
 * Before fork 6cadd89, /ingest hardcoded surface:'phone', so WEB calls were
 * stored and titled as phone calls ("Phone call with…" instead of "Voice chat
 * with…"). The bridge has always sent from:"web:<email>" for web calls, so
 * the mislabeled docs are cleanly identifiable. Two secret-guarded routes:
 * a read-only LIST (show Kade first — house rule) and a bounded RETITLE that
 * fixes the transcript's surface AND the merged conversation's title. */
router.post('/web-mislabeled', async (req, res) => {
  if (!mergeSecretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const docs = await KadeCallTranscript.find(
      { surface: 'phone', from: { $regex: '^web:' } },
      '_id from agentName startedAt endedAt mergedConversationId user',
    )
      .sort({ startedAt: 1 })
      .limit(500)
      .lean();
    const mongoose = require('mongoose');
    const Conversation = mongoose.models.Conversation;
    const out = [];
    for (const d of docs) {
      let title = null;
      if (d.mergedConversationId && Conversation) {
        const c = await Conversation.findOne(
          { conversationId: String(d.mergedConversationId) },
          'title',
        ).lean();
        title = (c && c.title) || null;
      }
      out.push({
        id: String(d._id),
        from: d.from || null,
        agentName: d.agentName || null,
        startedAt: d.startedAt || null,
        mergedConversationId: d.mergedConversationId || null,
        currentTitle: title,
      });
    }
    res.json({ ok: true, count: out.length, calls: out });
  } catch (err) {
    logger.error('[/api/kade/calls/web-mislabeled] error:', err);
    res.status(500).json({ error: 'list failed' });
  }
});

router.post('/web-retitle', async (req, res) => {
  if (!mergeSecretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const dryRun = (req.body || {}).dryRun !== false; // DEFAULT DRY RUN — real writes need dryRun:false
    /* surface $in both: a partial earlier run may have fixed a transcript's
     * surface while its conversation title is still wrong — reselect those. */
    const docs = await KadeCallTranscript.find(
      { surface: { $in: ['phone', 'web'] }, from: { $regex: '^web:' } },
      '_id user surface mergedConversationId',
    )
      .limit(500)
      .lean();
    const { saveConvo } = require('~/models');
    const mongoose = require('mongoose');
    const Conversation = mongoose.models.Conversation;
    let surfaceFixed = 0;
    let retitled = 0;
    const changes = [];
    for (const d of docs) {
      logger.info(`[web-retitle] processing transcript ${d._id} (surface ${d.surface})`);
      if (d.surface === 'phone') {
        if (!dryRun) {
          await KadeCallTranscript.updateOne({ _id: d._id }, { $set: { surface: 'web' } });
        }
        surfaceFixed += 1;
      }
      if (d.mergedConversationId && Conversation) {
        const cid = String(d.mergedConversationId);
        const c = await Conversation.findOne({ conversationId: cid }, 'title').lean();
        if (c && typeof c.title === 'string' && c.title.startsWith('Phone call')) {
          const newTitle = c.title.replace(/^Phone call/, 'Voice chat');
          changes.push({ conversationId: cid, from: c.title, to: newTitle });
          if (!dryRun) {
            /* saveConvo, NOT a raw Conversation.updateOne — the raw query-level
             * update stalled in production (first attempt, July 17: response
             * never returned; suspicion is the meili sync hook path). saveConvo
             * is the exact call kadeCallMerge titles every minted call with. */
            await saveConvo(
              { userId: String(d.user) },
              { conversationId: cid, title: newTitle },
              { context: 'kadeWebRetitle' },
            );
          }
          retitled += 1;
          logger.info(`[web-retitle] retitled ${cid}: "${c.title}" -> "${newTitle}"`);
        }
      }
    }
    res.json({ ok: true, dryRun, surfaceFixed, retitled, changes });
  } catch (err) {
    logger.error('[/api/kade/calls/web-retitle] error:', err);
    res.status(500).json({ error: 'retitle failed' });
  }
});

// Manually fire the nightly DREAMING summary sweep (secret-guarded) — lets us
// smoke-test the episodic-summary path on demand instead of waiting for the
// scheduled UTC hour. Same secret as the merge routes.
router.post('/summary-sweep', async (req, res) => {
  if (!mergeSecretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const result = await runSummarySweep();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[/api/kade/calls/summary-sweep] error:', err);
    res.status(500).json({ error: 'summary sweep failed' });
  }
});

/* ---- friendly HTML page: GET /calls ------------------------------------- */
router.page = (req, res) => res.type('html').send(callsHtml);

module.exports = router;
