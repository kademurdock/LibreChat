const axios = require('axios');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { Conversation, Message } = require('~/db/models');

/**
 * Retroactive title repair (July 27 2026, Kade: "fix the names of the current
 * conversations... that don't look like a tornado").
 *
 * WHY THIS EXISTS: from the v0.8.7 rebase (~July 22) until yaml `295fbbe`,
 * the custom titlePrompt had no {convo} placeholder, so EVERY generated title
 * came from a model that never saw the conversation — users' lists filled
 * with invented titles ("AI for Business Applications" over pickle snacks).
 * This route re-derives titles from the REAL stored messages using the same
 * model + the same fixed prompt shape the live titler now uses.
 *
 * Shape: POST /api/kade/titles/backfill
 *   body { secret, limit?=20, afterId?, since?='2026-07-22', dryRun?=false }
 * Cursor-driven (afterId) so the caller sweeps in bounded chunks with no
 * server-side state and no double-processing; deterministic titles ("Voice
 * chat with…", "Phone call with…", "New Chat", "First chat") are never
 * touched, and a convo whose messages can't support a title is skipped.
 * Same secret pair as the call-merge admin routes.
 */

const DETERMINISTIC_TITLE =
  /^(voice chat with |phone call with |new chat$|first chat$|untitled)/i;

/* Mirrors the FIXED yaml titlePrompt (295fbbe) — if that prompt materially
 * changes, keep this copy in spirit (it only runs for the broken window). */
const PROMPT_HEAD =
  'Write a concise, specific title for the conversation below: 3 to 7 words naming the actual topic or what ' +
  'the user wanted. Use ONLY words, names, and topics that literally appear in the conversation — NEVER invent ' +
  'people, events, or subjects that are not in it. If the topic is unclear, use the most specific words the user ' +
  'actually said. Output ONLY the title itself: plain text, no preamble or explanation, no surrounding quotes, ' +
  'no trailing punctuation, no emoji. Avoid vague titles like Conversation, User question, or Chat.';

function secretOk(req) {
  const expected = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
  return !!expected && (req.body || {}).secret === expected;
}

function textOf(msg) {
  if (Array.isArray(msg.content) && msg.content.length) {
    const joined = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (joined) return joined;
  }
  return typeof msg.text === 'string' ? msg.text.trim() : '';
}

function cleanTitle(raw) {
  let t = String(raw || '').split('\n')[0].trim();
  t = t.replace(/^["'“”‘’\s]+|["'“”‘’\s.!?,;:]+$/g, '').replace(/\s{2,}/g, ' ');
  if (!t || t.length < 3 || t.length > 90) return null;
  // A blind/chatty model output is exactly what we're repairing — refuse it.
  if (/^(sure|okay|of course|here is|here's|the title)/i.test(t)) return null;
  return t;
}

async function generateTitle(convoText) {
  const gatewayUrl =
    process.env.KADE_LLM_GATEWAY_URL || 'https://reframe-proxy-production.up.railway.app/chat/completions';
  const key = process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY;
  if (!key) return null;
  const r = await axios.post(
    gatewayUrl,
    {
      model: 'google/gemini-2.5-flash-lite',
      max_tokens: 40,
      messages: [{ role: 'user', content: `${PROMPT_HEAD}\n\nConversation:\n${convoText}` }],
    },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  return cleanTitle(r.data?.choices?.[0]?.message?.content);
}

const router = express.Router();

router.post('/backfill', async (req, res) => {
  if (!secretOk(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const b = req.body || {};
    const limit = Math.min(40, parseInt(b.limit, 10) || 20);
    const since = new Date(b.since || '2026-07-22T00:00:00Z');
    const dryRun = b.dryRun === true;
    /* createdAt, NOT updatedAt: a conversation is titled ONCE at birth, so
     * only convos BORN in the broken window carry poisoned titles. An old
     * convo with a good title that merely got new messages after July 22
     * must never be re-titled out from under its owner (first dry run
     * caught exactly two of those — that's why this line exists). */
    const filter = { createdAt: { $gte: since } };
    if (b.afterId) {
      filter._id = { $gt: b.afterId };
    }
    const convos = await Conversation.find(filter).sort({ _id: 1 }).limit(limit).lean();
    const items = [];
    let retitled = 0;
    let lastId = null;
    for (const c of convos) {
      lastId = String(c._id);
      const title = String(c.title || '');
      if (DETERMINISTIC_TITLE.test(title.trim())) {
        continue;
      }
      const msgs = await Message.find({ conversationId: c.conversationId })
        .sort({ createdAt: 1 })
        .limit(10)
        .lean();
      const lines = [];
      for (const m of msgs) {
        const t = textOf(m);
        if (!t) continue;
        lines.push(`${m.isCreatedByUser ? 'User' : 'AI'}: ${t.slice(0, 900)}`);
        if (lines.join('\n').length > 5000) break;
      }
      const hasUserLine = lines.some((l) => l.startsWith('User: ') && l.length > 10);
      if (!hasUserLine) {
        continue;
      }
      /* GROUNDING CHECK (second dry run's lesson): a hand-renamed or lucky
       * title shares words with its own conversation; the bug's signature is
       * a title sharing NOTHING (the model never saw the convo). Only
       * regenerate ungrounded titles — plus outright chatty ones ("Sure, I
       * can do that...") which are broken regardless of overlap. */
      const convoLower = lines.join('\n').toLowerCase();
      const STOP = new Set(['with', 'about', 'your', 'that', 'this', 'from', 'what', 'have', 'chat', 'conversation', 'question', 'asking', 'first', 'help', 'talk']);
      const titleWords = (title.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w));
      const grounded = titleWords.some((w) => convoLower.includes(w));
      const chatty = /^(sure|okay|of course|here is|here's|the title)/i.test(title.trim());
      if (grounded && !chatty) {
        continue;
      }
      let fresh = null;
      try {
        fresh = await generateTitle(lines.join('\n'));
      } catch (e) {
        logger.warn(`[kade/titles backfill] title call failed for ${c.conversationId}: ${e.message}`);
      }
      if (!fresh || fresh === title) {
        continue;
      }
      items.push({ conversationId: c.conversationId, old: title, new: fresh });
      if (!dryRun) {
        await Conversation.updateOne({ _id: c._id }, { $set: { title: fresh } });
        retitled += 1;
      }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    res.json({
      ok: true,
      dryRun,
      scanned: convos.length,
      retitled,
      nextAfterId: convos.length === limit ? lastId : null,
      items,
    });
  } catch (err) {
    logger.error('[/api/kade/titles/backfill] error:', err);
    res.status(500).json({ error: 'backfill failed' });
  }
});

module.exports = router;
