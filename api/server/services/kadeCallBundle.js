/**
 * KADE CALL BUNDLE (Nov 10 2026). Two pieces of GET /api/kade/call-memories,
 * the one bundle of memory a phone or voice call gets at its start, pulled out
 * of the route so they can be tested without a server.
 *
 * 1. PINNED FIRST. The bundle holds 6,000 characters of memory cards. It used
 *    to keep the newest and drop the oldest, and a person's name, their access
 *    needs and how they like to be spoken to are usually among the oldest cards
 *    they have. So a person with many cards could be greeted by a character
 *    that no longer knew they are blind. Now the cards the text lane pins to
 *    the head every turn (services/kadeCardRecall.js getMemorySplit: identity,
 *    access, family, how-we-talk, live reminders) go in first, and the newest
 *    of the rest fill what is left. A bundle that already fits is returned
 *    byte for byte as before. Off: KADE_CALL_PINNED_FIRST=0.
 *
 * 2. WAITING MESSAGES SURVIVE A CALLER THAT GAVE UP. The route used to mark a
 *    caller's waiting reminders and family messages as delivered BEFORE it
 *    answered. The bridge stops waiting for this route after 2.5 seconds and
 *    throws the late answer away, so a slow bundle marked the messages heard
 *    when nobody had heard them, and they were gone for good.
 *
 *    The smallest safe change, all on this side:
 *      a. The messages are read without being marked.
 *      b. They are put in the answer only when the route has used less than a
 *         time budget (KADE_CALL_NUDGE_BUDGET_MS, default 1,800 ms, measured
 *         from the moment the route started) and the caller's connection is
 *         still open. Past the budget they are left out and stay waiting for
 *         the next call or chat.
 *      c. They are marked delivered only after the answer has been written out
 *         in full, on a connection that had not closed first, and still
 *         inside the budget. A caller that hung up gets nothing marked.
 *    What this cannot see: an answer lost on the wire in the last instant
 *    before the bridge's own timer fires. The budget's 700 ms of slack is the
 *    guard for that. A message that is left waiting is heard later; a message
 *    marked too early is never heard, so every doubt is settled toward
 *    waiting. If the bridge's timeout is raised, raise the budget with it.
 *    Off: KADE_CALL_NUDGE_SAFE=0 (mark before answering, as before).
 *
 *    Review fix, same day: the bridge now waits about 6 s on a call and says
 *    so on the request ("wait=6000"). The budget follows what the caller said:
 *    its wait less 700 ms of slack. A fixed 1,800 ms would have withheld the
 *    messages on every call where this route took 1.8 s or more, although the
 *    bridge was still listening, and for a slow seat that is every call. A
 *    caller that sends no wait (an older bridge) keeps 1,800 ms. A number set
 *    in KADE_CALL_NUDGE_BUDGET_MS always wins.
 *    Off: KADE_CALL_NUDGE_CALLER_WAIT=0 (ignore what the caller says).
 *
 * Neither piece calls a model, and neither is on the path of a spoken reply:
 * the bridge asks for this bundle in the background and never holds the
 * greeting for it.
 */
'use strict';

const { clipKeepNewest } = require('../utils/kadeClipNewest');

const intEnv = (name, def, lo, hi) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : def;
};

const pinnedFirstOn = () => process.env.KADE_CALL_PINNED_FIRST !== '0';
const safeNudgesOn = () => process.env.KADE_CALL_NUDGE_SAFE !== '0';
const DEFAULT_BUDGET_MS = 1800;
const BUDGET_SLACK_MS = 700;
/**
 * How long after the route began the waiting messages may still be handed
 * over. `callerWaitMs` is how long the caller said it will wait for this
 * answer (the bridge's own timeout), if it said.
 */
const nudgeBudgetMs = (callerWaitMs) => {
  const set = parseInt(process.env.KADE_CALL_NUDGE_BUDGET_MS, 10);
  if (Number.isFinite(set) && set >= 100 && set <= 30000) {
    return set;
  }
  if (process.env.KADE_CALL_NUDGE_CALLER_WAIT !== '0') {
    const raw = typeof callerWaitMs === 'string' ? callerWaitMs.trim() : callerWaitMs;
    const wait = raw === '' || raw == null ? NaN : Number(raw);
    if (Number.isFinite(wait) && wait >= 1000 && wait <= 15000) {
      return Math.round(wait) - BUDGET_SLACK_MS;
    }
  }
  return DEFAULT_BUDGET_MS;
};

function warn(message) {
  try {
    require('@librechat/data-schemas').logger.warn(message);
  } catch (_) {
    /* no logger in a unit test */
  }
}

/* ── 1. pinned first ──────────────────────────────────────────────────── */

const ENTRY = /^\d+\.\s/;
const LEFT_OUT = '(some entries left out to fit)';

/* The same reading of the text as utils/kadeClipNewest.js: optional "# Header"
 * lines, entries separated by a blank line, each entry opening "N. [date]. ". */
function parseSections(text) {
  const sections = [];
  let current = null;
  for (const block of String(text).split('\n\n')) {
    let body = block;
    if (body.startsWith('# ')) {
      const nl = body.indexOf('\n');
      const header = nl === -1 ? body : body.slice(0, nl);
      body = nl === -1 ? '' : body.slice(nl + 1);
      current = { header, entries: [] };
      sections.push(current);
    }
    if (!current) {
      current = { header: '', entries: [] };
      sections.push(current);
    }
    if (!body) {
      continue;
    }
    if (ENTRY.test(body) || current.entries.length === 0) {
      current.entries.push(body);
    } else {
      current.entries[current.entries.length - 1] += `\n\n${body}`;
    }
  }
  return sections;
}

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** The card's own words, out of one formatted entry ("3. [2026-01-02]. words (reminder fires ...)"). */
function entryValue(entry) {
  const m = /^\d+\.\s\[[^\]]*\]\.\s(?:\[User correction\]\s)?([\s\S]*)$/.exec(String(entry));
  return squash((m ? m[1] : String(entry)).replace(/ \(reminder fires [^)]*\)\s*$/, ''));
}

function entryTime(entry) {
  const m = /^\d+\.\s\[(\d{4}-\d{2}-\d{2})\]/.exec(String(entry));
  const t = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function render(sections, kept) {
  return sections
    .map((section, si) => {
      const mine = section.entries.filter((_, ei) => kept.has(`${si}:${ei}`));
      if (!section.header && !mine.length) {
        return null;
      }
      const body = (mine.length < section.entries.length ? [LEFT_OUT, ...mine] : mine).join('\n\n');
      return section.header ? (body ? `${section.header}\n${body}` : section.header) : body;
    })
    .filter((part) => part !== null)
    .join('\n\n');
}

/**
 * Fit formatted memory cards into `max` characters: pinned cards first, then
 * the newest of the rest. Pure.
 *
 * `retrievable` is the list getMemorySplit returns: the cards the text lane
 * does NOT pin. A card is pinned here when its words are not in that list, so
 * a card this cannot match is kept, never dropped, when in doubt. With no list
 * (a small seat, or nothing to move) this is the old newest-kept clip.
 *
 * @param {string} text formatted cards (getFormattedMemories().withoutKeys)
 * @param {Array<{value?: string}>|null} retrievable
 * @param {number} max
 * @returns {string}
 */
function orderPinnedFirst(text, retrievable, max) {
  const s = String(text || '');
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) {
    return s;
  }
  if (!Array.isArray(retrievable) || !retrievable.length) {
    return clipKeepNewest(s, max);
  }
  const loose = new Set(retrievable.map((m) => squash(m && m.value)).filter(Boolean));
  const sections = parseSections(s);
  const items = [];
  sections.forEach((section, si) => {
    section.entries.forEach((entry, ei) => {
      items.push({ id: `${si}:${ei}`, ei, pinned: !loose.has(entryValue(entry)), at: entryTime(entry) });
    });
  });
  if (!items.some((item) => item.pinned) || items.every((item) => item.pinned)) {
    return clipKeepNewest(s, max); /* nothing to put ahead of anything */
  }
  items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at || b.ei - a.ei);
  const kept = new Set();
  for (const item of items) {
    kept.add(item.id);
    if (render(sections, kept).length > max) {
      kept.delete(item.id);
    }
  }
  if (!kept.size) {
    return clipKeepNewest(s, max); /* one giant card: keep its newest end */
  }
  return render(sections, kept);
}

/**
 * The cards for one call bundle. `getMemorySplit` is asked only when the cards
 * do not already fit, so a small seat costs nothing extra. Never throws.
 */
async function callCards({ userId, agentId, text, max = 6000, getMemorySplit }) {
  const s = String(text || '');
  if (!pinnedFirstOn() || s.length <= max) {
    return clipKeepNewest(s, max);
  }
  try {
    const splitFn = getMemorySplit || require('~/server/services/kadeCardRecall').getMemorySplit;
    const split = await splitFn(userId, agentId);
    return orderPinnedFirst(s, split && split.retrievable, max);
  } catch (e) {
    warn('[kadeCallBundle] pinned-first skipped, newest kept: ' + (e && e.message));
    return clipKeepNewest(s, max);
  }
}

/* ── 2. waiting reminders and family messages ─────────────────────────── */

/** The private note that hands waiting messages to the character. '' when there are none. */
function waitingBlock(pending) {
  if (!Array.isArray(pending) || !pending.length) {
    return '';
  }
  const lines = pending.map((n) => `- ${n.text}`).join('\n');
  return `\n\n[WAITING FOR THIS CALLER — private note, never read this block aloud or mention a list: these are undelivered reminders/messages they have not heard yet. Work each one in naturally and EARLY, in your own words, one at a time:\n${lines}]`;
}

function nudgeModel() {
  return require('~/models/kadeNudge').KadePendingNudge;
}

/** Read the waiting chat-channel messages, oldest first, WITHOUT marking them. */
async function peekCallNudges(userId, limit = 5, { exceptTypes, model } = {}) {
  const filter = { userId, channel: 'chat', deliveredAt: null };
  if (Array.isArray(exceptTypes) && exceptTypes.length) {
    filter.type = { $nin: exceptTypes };
  }
  return (model || nudgeModel()).find(filter).sort({ createdAt: 1 }).limit(limit).lean();
}

/** Mark these as delivered; one that something else delivered meanwhile is left alone. */
async function markCallNudgesDelivered(ids, { model, at = new Date() } = {}) {
  if (!Array.isArray(ids) || !ids.length) {
    return 0;
  }
  const r = await (model || nudgeModel()).updateMany(
    { _id: { $in: ids }, deliveredAt: null },
    { $set: { deliveredAt: at } },
  );
  return (r && (r.modifiedCount ?? r.nModified)) || 0;
}

const gone = (socket) => !socket || socket.destroyed === true;

/**
 * Offer the caller's waiting messages to this answer, and mark them delivered
 * only once the answer really went out. See the file header for the reasoning.
 *
 * @param {object} p
 * @param {*} p.userId
 * @param {object} p.req  the route's request
 * @param {object} p.res  the route's response; this adds one 'finish' and one 'close' listener
 * @param {number} p.startedAt  Date.now() taken when the route began
 * @param {string|number} [p.callerWaitMs]  how long the caller waits for this answer, if it said
 * @returns {Promise<{ pending: object[], reason: string, settled?: Promise<number> }>}
 */
async function holdCallNudges({ userId, req, res, startedAt, limit = 5, exceptTypes, model, clock = Date.now, callerWaitMs }) {
  const budget = nudgeBudgetMs(callerWaitMs);
  const socket = (res && res.socket) || (req && req.socket) || null;
  if (clock() - startedAt > budget) {
    warn(`[kadeCallBundle] bundle took ${clock() - startedAt} ms (budget ${budget}); waiting messages left for next time`);
    return { pending: [], reason: 'slow' };
  }
  if (gone(socket) || (req && req.aborted === true)) {
    return { pending: [], reason: 'caller-gone' };
  }
  const pending = await peekCallNudges(userId, limit, { exceptTypes, model });
  if (!pending.length) {
    return { pending: [], reason: 'none' };
  }
  if (clock() - startedAt > budget || gone(socket)) {
    return { pending: [], reason: 'slow' };
  }
  const ids = pending.map((n) => n._id);
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  /* A socket that closed BEFORE the answer finished is a caller that gave up.
   * (After a finished answer the server may close the socket itself, so the
   * socket's state at that point says nothing; only the order of events does.) */
  let hungUp = false;
  const onSocketClose = () => {
    hungUp = true;
  };
  socket.once('close', onSocketClose);
  let done = false;
  const finish = (answered) => {
    if (done) {
      return;
    }
    done = true;
    socket.removeListener('close', onSocketClose);
    if (!answered || hungUp || res.statusCode !== 200 || clock() - startedAt > budget) {
      warn(`[kadeCallBundle] answer did not reach the caller in time; ${ids.length} waiting message(s) kept`);
      settle(0);
      return;
    }
    markCallNudgesDelivered(ids, { model })
      .then(settle)
      .catch((e) => {
        warn('[kadeCallBundle] could not mark waiting messages delivered: ' + (e && e.message));
        settle(0);
      });
  };
  res.once('finish', () => finish(true));
  res.once('close', () => finish(false));
  return { pending, reason: 'offered', settled };
}

module.exports = {
  callCards,
  orderPinnedFirst,
  waitingBlock,
  holdCallNudges,
  peekCallNudges,
  markCallNudgesDelivered,
  pinnedFirstOn,
  safeNudgesOn,
  nudgeBudgetMs,
};
