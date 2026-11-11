/**
 * SEARCH YOUR OWN PAST CHATS (Nov 11 2026, card 9 of the home agent plan).
 *
 * "What was that pharmacy number from last week?" gets a real answer from the person's own chats.
 *
 * HOW IT SEARCHES: through the MeiliSearch index LibreChat already keeps for its own search box.
 * Checked live on 11 Nov 2026, read-only, counts only: the Chat project has a Meilisearch service,
 * the LibreChat service has SEARCH=true with MEILI_HOST and MEILI_MASTER_KEY set, and 11,537 of
 * 11,824 messages carry the synced flag. The messages collection has no text index, and none is
 * built: no new index on the live database. Meili's message index makes `user` filterable, so the
 * search asks Meili for this person's messages only.
 *
 * THE RAILS, all in code:
 *   - Only the asker's own messages. Meili is asked with `user = "<their id>"`; every hit is then
 *     read again from the database with the same user id, and a row that does not match is
 *     dropped. A broken or stale index can never hand over someone else's words.
 *   - Signed-in only. Refused on a phone call (paired or not), in a hidden background run and for
 *     an unknown caller, before anything is searched (kadeLaneTrustAdapter.js).
 *   - This character's conversations by default; every conversation of theirs only when they ask
 *     ("in any chat"). The conversation they are in now is left out; it is already in view.
 *   - Tainted turns are left out: a reply that called a tool carrying outside text (a web page, a
 *     file, a recording; kadeUntrustedTools.js) is not returned, so page text never comes back as
 *     if they had said it.
 *   - Numbers that look like codes, cards, bank or social security numbers are masked in every
 *     snippet. Phone numbers, prices, years and times are kept.
 *   - Snippets only, about 240 characters each, at most 8.
 *
 * No model, no new collection, no wait before a reply: it runs only when the character calls it.
 * Off: KADE_RECALL_SEARCH=0 (the tool is not offered and refuses). Default on, because Meili serves it.
 * No '~' requires at load time, so node --test loads it.
 */
'use strict';

const lanes = require('./kadeLaneTrustAdapter');
const { isUntrustedToolName } = require('./kadeUntrustedTools');

const SNIPPET = 240;
const MAX_RESULTS = 8;
const MEILI_FETCH = 40;

function on(env = process.env) {
  return String((env && env.KADE_RECALL_SEARCH) ?? '') !== '0';
}

/* ── masking ──────────────────────────────────────────────────────────── */

const CODE_WORDS = /\b(?:code|pin|passcode|password|otp|verification|verify|security|one[- ]time|login|account|acct|routing|card|cvv|cvc|ssn|social)\b/i;

/**
 * Mask number runs that look like codes, cards, bank or social security numbers. Pure.
 *  - 13 to 19 digits (cards), grouped or not: all but the last four hidden.
 *  - 3-2-4 (social security shape): hidden.
 *  - 9 to 12 digits with no phone shape (bank and account numbers): hidden.
 *  - 4 to 8 digits right after a code word ("code 482913", "PIN is 1234"): hidden.
 *  - 6 to 8 digits standing alone (one-time codes): hidden.
 * Kept: phone numbers written as phone numbers, money ($12.50), years, times, dates, short numbers.
 */
function maskNumbers(text) {
  let s = String(text || '');
  /* social security shape first, before the general runs swallow it */
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[number hidden]');
  /* runs of digits joined by single spaces or dashes */
  s = s.replace(/(^|[^\w$.:/])((?:\d[ -]?){8,22}\d)(?![\w])/g, (m, pre, run) => {
    const digits = run.replace(/\D/g, '');
    const phoneShape =
      /^(?:\+?1[ -.]?)?\(?\d{3}\)?[ -.]\d{3}[ -.]\d{4}$/.test(run.trim()) && (digits.length === 10 || digits.length === 11);
    if (phoneShape) return m;
    if (digits.length >= 13 && digits.length <= 19) return `${pre}[card number hidden, ends ${digits.slice(-4)}]`;
    if (digits.length >= 9) return `${pre}[number hidden]`;
    return m;
  });
  /* a code word, then a short run */
  s = s.replace(/(\b(?:code|pin|passcode|password|otp|verification|security)\b[^\d\n]{0,20})(\d{4,8})\b/gi, (m, lead) => `${lead}[code hidden]`);
  /* a 6 to 8 digit run standing alone, not money, not a decimal, not part of a phone or date */
  s = s.replace(/(^|[\s(])(\d{6,8})(?=$|[\s).,!?;])/g, (m, pre, run, offset, all) => {
    const before = all.slice(Math.max(0, offset - 1), offset + pre.length);
    if (/\$/.test(before)) return m;
    return `${pre}[code hidden]`;
  });
  return s;
}

/* ── snippets ─────────────────────────────────────────────────────────── */

function textOf(m) {
  if (!m) return '';
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p && p.type === 'text')
      .map((p) => (typeof p.text === 'string' ? p.text : (p.text && p.text.value) || ''))
      .join('\n');
  }
  return '';
}

function clean(text) {
  return String(text || '')
    .replace(/\[EARLIER IN THIS CONVERSATION[\s\S]*?Reply ONLY to what follows\.\]\s*/gi, '')
    .replace(/%%%[\s\S]*?%%%/g, ' ')
    .replace(/%{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function terms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** About SNIPPET characters around the first query word found, masked. Pure. */
function snippetOf(text, query) {
  const t = clean(text);
  if (!t) return '';
  const low = t.toLowerCase();
  let at = -1;
  for (const w of terms(query)) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(SNIPPET / 3));
  if (start > 0) {
    const sp = t.indexOf(' ', start);
    start = sp > 0 && sp - start < 20 ? sp + 1 : start;
  }
  let out = t.slice(start, start + SNIPPET);
  if (start + SNIPPET < t.length) {
    const sp = out.lastIndexOf(' ');
    if (sp > SNIPPET * 0.6) out = out.slice(0, sp);
    out += '...';
  }
  if (start > 0) out = '...' + out;
  return maskNumbers(out);
}

/** A reply that took in outside text through a tool. */
function tainted(m) {
  if (!m || !Array.isArray(m.content)) return false;
  return m.content.some((p) => p && p.type === 'tool_call' && p.tool_call && isUntrustedToolName(p.tool_call.name));
}

function dayOf(at) {
  const d = at ? new Date(at) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
}

/* ── storage, the real ones ───────────────────────────────────────────── */

/* For unit tests only: stand-ins. Never set in the running server. */
const seam = { deps: null };

function realDeps() {
  return {
    meili: (q, opts) => require('~/models').searchMessages(q, opts, false),
    messages: (userId, messageIds) =>
      require('~/models').getMessages(
        { user: String(userId), messageId: { $in: messageIds } },
        'messageId conversationId user isCreatedByUser createdAt text content sender expiredAt',
      ),
    conversations: async (userId, conversationIds) => {
      const Conversation = require('mongoose').models.Conversation;
      if (!Conversation) return [];
      return Conversation.find({ user: String(userId), conversationId: { $in: conversationIds } }, 'conversationId agent_id title isTemporary expiredAt').lean();
    },
  };
}

/* ── the search ───────────────────────────────────────────────────────── */

const REFUSED = {
  off: 'Searching past chats is switched off right now.',
  unavailable: 'This is not available here.',
  hidden: 'A background job cannot search their chats.',
  'unknown-caller': 'The person on the line could not be matched to an account, so their chats cannot be searched here.',
  phone: 'Past chats can only be searched in the signed-in app or website, never on a phone call. Say that kindly in one sentence.',
};

/**
 * @returns {Promise<{ ok: boolean, why?: string, results?: Array<object>, tellThem: string }>}
 */
async function search({ req, agentId, query, everywhere = false, limit = 5, env = process.env }) {
  if (!on(env)) return { ok: false, why: 'off', tellThem: REFUSED.off };
  const who = lanes.actorOf(req, env);
  if (!who.ok) return { ok: false, why: who.why, tellThem: REFUSED[who.why] };
  if (who.lane !== 'signed-in') return { ok: false, why: 'phone', tellThem: REFUSED.phone };
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 2) return { ok: false, why: 'empty', tellThem: 'Say what to look for in "query", in a few words.' };
  const userId = who.userId;
  /* The id goes inside a Meili filter string: only a plain id is ever placed there. */
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(userId)) return { ok: false, why: 'unavailable', tellThem: REFUSED.unavailable };
  const d = seam.deps || realDeps();
  const n = Math.min(MAX_RESULTS, Math.max(1, Number(limit) || 5));
  const here = req && req.body && typeof req.body.conversationId === 'string' ? req.body.conversationId : null;

  let hits;
  try {
    const res = await d.meili(q, { filter: `user = "${userId}"`, limit: MEILI_FETCH });
    hits = (res && Array.isArray(res.hits) ? res.hits : []).filter((h) => h && h.messageId && String(h.user || userId) === userId);
  } catch (_) {
    return { ok: false, why: 'search-down', tellThem: 'The chat search is not answering right now. Say so plainly; do not guess what they said.' };
  }
  const ids = [...new Set(hits.map((h) => String(h.messageId)))];
  if (!ids.length) return { ok: true, results: [], tellThem: 'Nothing in their past chats matched. Say so plainly; do not guess.' };

  /* Read every hit again from the database, as this person. */
  const rows = ((await d.messages(userId, ids)) || []).filter((m) => m && String(m.user) === userId);
  const byId = new Map(rows.map((m) => [String(m.messageId), m]));
  const convoIds = [...new Set(rows.map((m) => String(m.conversationId)).filter(Boolean))];
  const convos = new Map(
    ((await d.conversations(userId, convoIds)) || []).filter((c) => c && c.conversationId).map((c) => [String(c.conversationId), c]),
  );

  const results = [];
  for (const id of ids) {
    if (results.length >= n) break;
    const m = byId.get(id);
    if (!m) continue;
    const convo = convos.get(String(m.conversationId));
    if (!convo || convo.isTemporary === true) continue;
    if (here && String(m.conversationId) === here) continue;
    if (!everywhere && agentId && String(convo.agent_id || '') !== String(agentId)) continue;
    if (tainted(m)) continue;
    const snippet = snippetOf(textOf(m), q);
    if (!snippet) continue;
    results.push({ when: dayOf(m.createdAt), who: m.isCreatedByUser ? 'they said' : 'you said', snippet });
  }
  return {
    ok: true,
    results,
    tellThem: results.length
      ? 'These are bits of their own past chats. Answer from them in plain words; say the day if it helps. Numbers shown as hidden stay hidden.'
      : everywhere || !agentId
        ? 'Nothing in their past chats matched. Say so plainly; do not guess.'
        : 'Nothing in your chats with them matched. They can ask you to look in all their chats.',
  };
}

module.exports = { on, search, maskNumbers, snippetOf, tainted, textOf, REFUSED, __seam: seam };
