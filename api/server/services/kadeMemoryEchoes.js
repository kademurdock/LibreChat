'use strict';
/**
 * kadeMemoryEchoes.js — Part 97 (Aug 29 2026): ECHOES GO SOFT-ON, her word.
 *
 * memory-health has computed anniversaries since Aug 26 — detection only,
 * injection parked "for her word." The word came Aug 29: on, but SOFT. The
 * shape of soft, exactly:
 *
 *  - DIARY ONLY. A diary entry marks a day somebody lived; a card's
 *    updated_at marks the day a fact got edited. "A month since this fact
 *    was edited" is machinery noise, not a memory — card echoes stay out.
 *  - MID-CONVERSATION ONLY. This rides the recall tail of a turn that is
 *    already happening. Nothing here ever texts anybody first.
 *  - ONE per turn, at most one surfaced per seat per Central day — enforced
 *    through the recall audit, which already persists surfaced keys: an
 *    injected echo lands there as `echo:<date>`, and the next turn checks.
 *  - WARM/HEAVY IS READ FROM THE CONTENT, IN CONTEXT, BY THE MODEL — with
 *    the manners injected right beside the memory (see the block text in
 *    kadeCardRecall). Not a word-list classifier: this record is a graveyard
 *    of those, and a happy/sad list would be the sixth headstone. The
 *    failure mode of a judgment miss is one gentle mention of a heavy
 *    month-mark — which the record shows can even be wanted (the Sunday
 *    check-in Amber asked for on a hard anniversary).
 *
 * Kill switch: KADE_ECHOES=0 (default ON).
 */
const { logger } = require('@librechat/data-schemas');

function enabled() {
  return process.env.KADE_ECHOES !== '0';
}

/** Minimum age before a date is a "month-mark" — mirrors memory-health. */
const MIN_AGE_DAYS = 28;
const DAY = 86400000;

function centralParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { key: `${get('year')}-${get('month')}-${get('day')}`, day: get('day') };
}

function monthsBetween(thenMs, now = Date.now()) {
  return Math.max(1, Math.round((now - thenMs) / (30.44 * DAY)));
}

/** "3 months ago today" / "a year ago today" — years come free with age. */
function phraseAgo(months) {
  if (months % 12 === 0) {
    const y = months / 12;
    return y === 1 ? 'a year ago today' : `${y} years ago today`;
  }
  return months === 1 ? 'a month ago today' : `${months} months ago today`;
}

/* One computation per (seat, Central day) — the answer cannot change within a
 * day, so a turn never pays the query twice. In-memory on purpose: a redeploy
 * recomputes a few tiny indexed reads, nothing more. */
const seatDayCache = new Map();

/**
 * Today's echo for one seat, or null — the oldest qualifying diary entry
 * whose entryDate shares today's day-of-month, at least MIN_AGE_DAYS back.
 * @returns {Promise<{when:string, monthsAgo:number, phrase:string, text:string}|null>}
 */
async function getTodayEchoForSeat(userId, agentId) {
  if (!enabled() || !userId) return null;
  const { key: todayKey, day } = centralParts();
  const cacheKey = `${userId}::${agentId || ''}::${todayKey}`;
  if (seatDayCache.has(cacheKey)) return seatDayCache.get(cacheKey);
  let out = null;
  try {
    const mongoose = require('mongoose');
    const diary = mongoose.connection.db.collection('kadediaryentries');
    const cutoffKey = new Date(Date.now() - MIN_AGE_DAYS * DAY).toISOString().slice(0, 10);
    const scope = agentId
      ? { $or: [{ agentId: null }, { agentId: { $exists: false } }, { agentId: String(agentId) }] }
      : {};
    const rows = await diary.find(
      { userId: String(userId), entryDate: { $regex: `-${day}$`, $lte: cutoffKey, $ne: todayKey }, ...scope },
      { projection: { entryDate: 1, text: 1, salience: 1 } },
    ).sort({ entryDate: 1 }).limit(3).toArray();
    if (rows.length) {
      /* Oldest first, salience breaking ties upward — the deepest echo wins. */
      rows.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : (b.salience || 1) - (a.salience || 1)));
      const r = rows[0];
      const months = monthsBetween(Date.parse(`${r.entryDate}T12:00:00Z`));
      out = { when: r.entryDate, monthsAgo: months, phrase: phraseAgo(months), text: String(r.text || '').slice(0, 400) };
    }
  } catch (e) {
    logger.warn('[kadeMemoryEchoes] echo lookup failed (echo-less turn, non-fatal):', e.message);
    out = null;
  }
  seatDayCache.set(cacheKey, out);
  if (seatDayCache.size > 500) seatDayCache.clear(); /* day rollover hygiene */
  return out;
}

/** Has an echo already surfaced for this seat today? Read from the recall
 *  audit — the injected marker `echo:<date>` lands there like any key. */
async function echoSurfacedToday(userId) {
  try {
    const { readRecallAudits } = require('~/models/kadeRecallAudit');
    const rows = await readRecallAudits({ userId, limit: 60 });
    const { key: todayKey } = centralParts();
    for (const r of rows) {
      const rowDay = centralParts(new Date(r.createdAt)).key;
      if (rowDay !== todayKey) break; /* newest-first — past today, stop */
      if ((r.cards || []).some((k) => String(k).startsWith('echo:'))) return true;
    }
  } catch (_e) {
    return true; /* cannot verify the cap — stay quiet rather than repeat */
  }
  return false;
}

module.exports = { getTodayEchoForSeat, echoSurfacedToday, phraseAgo, monthsBetween, enabled, MIN_AGE_DAYS };
