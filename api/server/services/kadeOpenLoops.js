/**
 * KADE OPEN LOOPS — a card that was true on a date, read back after it (Aug 26 2026).
 *
 * HER BUG, AND IT IS THE REASON THIS FILE EXISTS. A family member told Kiana on
 * the morning of Aug 26 that her mother's surgery had been cancelled. Later the
 * same day Kiana was still naming the surgery. Her seat held SEVEN cards saying
 * that surgery was happening — the date, the pre-op, the anaesthesia plan, the
 * recovery window, the surgical detail, the calendar, and an aside about her
 * aunt — and NOT ONE saying it was called off.
 *
 * ⚠️ NOTHING WAS RETRIEVED WRONG. Every card that came back was true when it was
 * written. The daily consolidation pass had run that morning and was RIGHT not to
 * touch them: they are not near-duplicates (they are seven different true facts)
 * and they do not contradict each other (all seven agree). The contradiction was
 * never between the cards. It was between the cards and the world, and nothing on
 * this platform has ever looked at a card and asked whether it is still true.
 *
 * WHAT AN OPEN LOOP IS: a card is not always a fact. "Her favourite Grey's
 * character is Bailey" is true forever. "Mom's foot surgery is Thursday August
 * 27, 2026" is a claim about the future that GOES FALSE ON A KNOWN DATE. The
 * store treats them identically.
 *
 * WHAT THIS DOES, AND ITS WHOLE AMBITION: it finds the date inside a card's text
 * and, once that date has passed, appends a short honest note at RECALL time.
 * It changes no card, deletes nothing, merges nothing, and writes nothing. It
 * puts doubt in front of the model at the exact moment it would otherwise
 * announce somebody's cancelled surgery back to them.
 *
 * ⚠️⚠️ AND THE FIRST DESIGN OF THIS FILE WAS WRONG. IT IS RECORDED HERE RATHER
 * THAN QUIETLY REPLACED, BECAUSE THE MISTAKE IS THE USEFUL PART.
 *
 * Version one inferred the loop from the card TEXT: find an explicit date, and
 * once it passes, flag the card. The parser worked perfectly — every pattern
 * below was exercised and correct. Then it was run in anger over 192 REAL cards
 * from two live seats, and the result was **15 flags, ONE of them right**:
 *
 *   ✓ "Mom has a pre-op appointment on Monday, August 24, 2026"   <- a real loop
 *   ✗ "Ziggy (African grey parrot, companion since 2017, died July 10 2026)"
 *   ✗ "Got CPR certified July 22, 2026 through LifePro Safety"
 *   ✗ "Saw Shinedown on July 28, 2026"
 *   ✗ "Daisy was an English bulldog they got in 2018..."   (a dog, dead since 2025)
 *   ✗ "Checked platform status on August 23, 2026"
 *   ...and eight more of the same shape.
 *
 * ⭐ THE LESSON, AND IT IS THE SAME ONE THIS RECORD KEEPS WRITING DOWN IN NEW
 * CLOTHES: **A DATE IS NOT A TENSE.** "Surgery is Thursday August 27" and "Got
 * CPR certified July 22" carry structurally identical dates and mean opposite
 * things — one is a PLAN, the other is a RECORD. No regex can see which, because
 * the difference is not in the digits. Shipping v1 would have stamped "⚠️ ASK,
 * don't assert" onto a dead parrot's memorial album and a dog that died in 2025,
 * on every turn, until the model learned to ignore the flag entirely.
 *
 * That is the fifth uncalibrated matcher to die on this platform, after the care
 * word list that caught a horror film, the direction law that banned gestures and
 * missed postures, the correction detector that found nineteen hits and zero real
 * corrections, and three detectors that died on a contraction.
 *
 * ⭐⭐ SO THE ORDER REVERSED. **THE WRITE SIDE MUST DECLARE THE LOOP; THE READ SIDE
 * CANNOT INFER IT.** The model filing the card knows perfectly well whether it is
 * writing a plan or a record. It says so with `staleAfter`. This file now flags
 * ONLY what was declared, and `extractDates` survives as a helper for the WRITER
 * to normalise a date it already decided is forward-looking — never as evidence
 * on its own.
 *
 * ⚠️ THE PARSER IS DELIBERATELY STRICT AND THAT IS A DESIGN DECISION, NOT A TODO.
 * This record is a graveyard of uncalibrated matchers — the care-detector word
 * list that caught a horror film, the direction law that banned gestures and
 * missed postures, three separate detectors that died on a contraction. A loose
 * date parser here would flag "the 90s", "August" with no year, "in three
 * weeks", and a phone number, and the flag would become noise the model learns
 * to ignore. Catching 70% of dated cards cleanly beats 95% with false flags.
 * Every pattern below requires an explicit YEAR.
 *
 * Kill switch: KADE_OPEN_LOOPS=0 — the flag disappears and recall reads exactly
 * as it did before this file existed.
 */

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};
const MONTH_RE = Object.keys(MONTHS).join('|');

/** Grace period before a passed date is called stale. A surgery "on the 27th"
 * read at 00:30 on the 27th is not stale yet, and a same-day flag would fire
 * while the thing is still happening. Default one day. */
function graceMs() {
  const raw = parseInt(process.env.KADE_OPEN_LOOP_GRACE_HOURS, 10);
  const hours = Number.isInteger(raw) && raw >= 0 && raw <= 720 ? raw : 24;
  return hours * 3600000;
}

function enabled() {
  return process.env.KADE_OPEN_LOOPS !== '0';
}

/**
 * Pull every explicit, year-bearing calendar date out of a string.
 * Accepts: "August 27, 2026" · "27 August 2026" · "2026-08-27" · "8/27/2026".
 * Rejects on purpose: bare months, bare weekdays, relative time, two-digit
 * years, and any date without a year.
 * @returns {Date[]} parsed dates, UTC-noon anchored so timezone can never
 *   shift one across a day boundary.
 */
function extractDates(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const push = (y, m, d) => {
    if (m < 0 || m > 11 || d < 1 || d > 31 || y < 2000 || y > 2100) return;
    const dt = new Date(Date.UTC(y, m, d, 12, 0, 0));
    /* Reject a rolled-over date: Feb 31 becomes Mar 3, which was never written. */
    if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return;
    out.push(dt);
  };

  /* "August 27, 2026" / "August 27 2026" */
  const a = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  /* "27 August 2026" */
  const b = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\s+(\\d{4})\\b`, 'gi');
  /* ISO "2026-08-27" */
  const c = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  /* US slash "8/27/2026" — four-digit year required, so 8/27/26 is skipped. */
  const d = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

  let m;
  while ((m = a.exec(s))) push(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  while ((m = b.exec(s))) push(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  while ((m = c.exec(s))) push(+m[1], +m[2] - 1, +m[3]);
  while ((m = d.exec(s))) push(+m[3], +m[1] - 1, +m[2]);
  return out;
}

/**
 * The date this card was DECLARED to go stale on — `staleAfter`, set by the
 * writer when it filed a forward-looking claim. Returns null for every card that
 * never declared one, which is almost all of them, which is correct.
 * @returns {Date|null}
 */
function cardDate(card) {
  if (!card || !card.staleAfter) return null;
  const d = new Date(card.staleAfter);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The WRITER's helper: given text the model has ALREADY decided describes a
 * forward-looking commitment, pull the date it turns on. Never call this to
 * decide WHETHER something is a loop — see the header. Latest date wins, because
 * "off Aug 27 through September 8" is not settled until the 8th.
 * @returns {Date|null}
 */
function dateFromText(text) {
  const dates = extractDates(text);
  if (!dates.length) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

/**
 * Is this card an open loop whose moment has passed?
 * ⚠️ Reminder cards are excluded — they have a real dueAt, the nudge sweep owns
 * them, and describeReminderCompact already speaks for them.
 */
function isExpired(card, now = new Date()) {
  if (!enabled()) return false;
  if (!card || card.type === 'reminder') return false;
  const d = cardDate(card);
  if (!d) return false;
  return now.getTime() - d.getTime() > graceMs();
}

/**
 * The line appended to an expired card at recall time. Short on purpose: it
 * rides every turn, and a paragraph of hedging would cost more than it buys.
 * @returns {string} '' when the card is fine
 */
function describeStale(card, now = new Date()) {
  if (!isExpired(card, now)) return '';
  const d = cardDate(card);
  const when = d.toISOString().slice(0, 10);
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const ago = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : 'already';
  return ` (⚠️ this said ${when} — that was ${ago} and nobody has confirmed what happened; ASK, don't assert)`;
}

module.exports = { extractDates, dateFromText, cardDate, isExpired, describeStale, enabled };
