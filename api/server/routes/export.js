const express = require('express');
const JSZip = require('jszip');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getAllUserMemories } = require('~/models');
const { KadeDiaryEntry } = require('~/models/kadeDiary');

const router = express.Router();
router.use(requireJwtAuth);

/**
 * Aug 9 2026 — OWN YOUR DATA (her spec, verbatim spirit: "so people can take
 * ownership of their own data… a compressed zip folder"). GET /api/export/mine
 * hands the signed-in user EVERYTHING that is theirs: memory cards, logbook
 * entries, and full conversation history — as machine JSON *and* as plain
 * readable text, zipped. Own account only, by construction (JWT id is the
 * only key used anywhere). Family-scale sizes, so it streams in one breath.
 */
router.get('/mine', async (req, res) => {
  const userId = String(req.user.id);
  try {
    const zip = new JSZip();
    const stamp = new Date().toISOString().slice(0, 10);
    const meta = { exportedAt: new Date().toISOString(), account: req.user.email || userId, format: 'Kade-AI export v1' };

    /* Memory cards */
    let cards = [];
    try {
      cards = (await getAllUserMemories(userId)) || [];
    } catch (e) { logger.warn('[export] memories fetch failed:', e.message); }
    zip.file('data/memories.json', JSON.stringify(cards, null, 1));
    zip.file(
      'readable/memories.txt',
      cards.length
        ? cards.map((c) => `[${c.key}]${c.agentId ? ` (with one companion)` : ' (shared)'}\n${c.value}\n`).join('\n')
        : 'No memory cards yet.\n',
    );

    /* Logbook */
    let entries = [];
    try {
      entries = await KadeDiaryEntry.find({ userId }).sort({ entryDate: 1, createdAt: 1 }).select('-embedding').lean();
    } catch (e) { logger.warn('[export] diary fetch failed:', e.message); }
    zip.file('data/logbook.json', JSON.stringify(entries.map((e) => ({
      date: e.entryDate, text: e.text, salience: e.salience || 1, source: e.source, agentId: e.agentId || null,
    })), null, 1));
    zip.file(
      'readable/logbook.txt',
      entries.length
        ? entries.map((e) => `${e.entryDate}${(e.salience || 1) > 1 ? ' (a bigger day)' : ''}\n${e.text}\n`).join('\n')
        : 'No logbook entries yet.\n',
    );

    /* Conversations + messages (mongoose models registered by the app) */
    let convos = [];
    let msgCount = 0;
    try {
      const Conversation = mongoose.models.Conversation;
      const Message = mongoose.models.Message;
      convos = await Conversation.find({ user: userId }).sort({ updatedAt: 1 }).select('conversationId title createdAt updatedAt').lean();
      const convosOut = [];
      for (const c of convos) {
        const msgs = await Message.find({ conversationId: c.conversationId, user: userId })
          .sort({ createdAt: 1 })
          .select('sender isCreatedByUser text createdAt')
          .lean();
        msgCount += msgs.length;
        convosOut.push({
          title: c.title || 'Untitled',
          startedAt: c.createdAt,
          messages: msgs.map((m) => ({ from: m.isCreatedByUser ? 'you' : (m.sender || 'companion'), at: m.createdAt, text: m.text || '' })),
        });
        const safe = String(c.title || 'untitled').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'untitled';
        const day = c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : 'undated';
        zip.file(
          `readable/conversations/${day} ${safe}.txt`,
          msgs.map((m) => `${m.isCreatedByUser ? 'You' : (m.sender || 'Companion')}: ${m.text || ''}\n`).join('\n') || '(empty)\n',
        );
      }
      zip.file('data/conversations.json', JSON.stringify(convosOut, null, 1));
    } catch (e) {
      logger.warn('[export] conversations fetch failed:', e.message);
      zip.file('data/conversations.json', JSON.stringify({ error: 'conversations unavailable in this export' }));
    }

    meta.counts = { memoryCards: cards.length, logbookEntries: entries.length, conversations: convos.length, messages: msgCount };
    zip.file('README.txt',
      `Your Kade-AI export — ${stamp}\n\nThis folder is yours to keep: every memory card, logbook entry, and conversation on your account, in two forms.\n\n- readable/ — plain text, open anywhere, screen-reader friendly.\n- data/ — the same things as JSON, for taking to any other tool.\n\nCounts: ${meta.counts.memoryCards} memory cards, ${meta.counts.logbookEntries} logbook entries, ${meta.counts.conversations} conversations (${meta.counts.messages} messages).\n\nYour words belong to you. — Kade-AI\n`);
    zip.file('data/manifest.json', JSON.stringify(meta, null, 1));

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    logger.info(`[export] ${userId} exported ${meta.counts.conversations} convos / ${msgCount} msgs / ${cards.length} cards / ${entries.length} logbook (${buf.length} bytes)`);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="kade-ai-export-${stamp}.zip"`,
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (error) {
    logger.error('[export] failed', error);
    res.status(500).json({ error: 'The export hit a snag — try again in a minute.' });
  }
});

module.exports = router;
