/** KADE Aug 7 2026 — ANNIVERSARY SURFACING (idea 33, her pick).
 *
 * Memory cards carry created_at; when one turns exactly N months old today
 * (1, 3, 6, 12, 24... — Central time), the character who is ALLOWED to know
 * it gets one invisible head line inviting a warm passing mention. Scope is
 * sacred: an agent-scoped card only ever surfaces to ITS agent; shared cards
 * surface to everyone. Byte-stable per (user, agent, Central day) — same
 * cache discipline as the world block, one line, capped at ONE card a day
 * (the oldest milestone wins; a birthday party of five cards reads as spam).
 * Fail-soft everywhere: no Mongo, no cards, no milestone = ''.
 */
const MILESTONE_MONTHS = [1, 3, 6, 12, 24, 36, 48, 60];

function centralParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** true when `created` (a Date) falls exactly `months` calendar months before
 * today in Central time — day-of-month must match, so Jan 31 + 1mo simply
 * never fires in February instead of misfiring on the 28th. */
function isMonthsAgoToday(created, months, today) {
  const c = centralParts(created);
  let ty = today.y, tm = today.m - months;
  while (tm <= 0) { tm += 12; ty -= 1; }
  return c.y === ty && c.m === tm && c.d === today.d;
}

const memo = new Map(); // `${userId}:${agentId}` -> { dayKey, line }

async function getAnniversaryLine(userId, agentId) {
  if (process.env.KADE_ANNIVERSARIES === '0') return '';
  const today = centralParts();
  const dayKey = `${today.y}-${today.m}-${today.d}`;
  const memoKey = `${userId}:${agentId || 'shared'}`;
  const hit = memo.get(memoKey);
  if (hit && hit.dayKey === dayKey) return hit.line;
  let line = '';
  try {
    const mongoose = require('mongoose');
    const MemoryEntry = mongoose.models.MemoryEntry;
    if (MemoryEntry && userId) {
      const cards = await MemoryEntry.find({ userId }).select('key value agentId createdAt').limit(500).lean();
      let best = null; // highest months wins (the rarer milestone)
      for (const card of cards) {
        if (!card.createdAt) continue;
        if (card.agentId && String(card.agentId) !== String(agentId || '')) continue; // scope is sacred
        for (const months of MILESTONE_MONTHS) {
          if (isMonthsAgoToday(new Date(card.createdAt), months, today) && (!best || months > best.months)) {
            best = { months, card };
          }
        }
      }
      if (best) {
        const value = String(best.card.value || '').slice(0, 140);
        const span = best.months >= 12
          ? `${Math.floor(best.months / 12)} year${best.months >= 24 ? 's' : ''}`
          : `${best.months} month${best.months === 1 ? '' : 's'}`;
        line =
          'MEMORY ANNIVERSARY (invisible, same rules as the platform note): ' +
          `it has been exactly ${span} today since you first learned this about them: "${value}". ` +
          'A warm, natural passing mention is welcome ONLY if the moment genuinely fits — never open with it, never force it, never call it an anniversary.';
      }
    }
  } catch (_e) {
    line = '';
  }
  if (memo.size > 500) memo.clear();
  memo.set(memoKey, { dayKey, line });
  return line;
}

module.exports = { getAnniversaryLine, isMonthsAgoToday, centralParts };
