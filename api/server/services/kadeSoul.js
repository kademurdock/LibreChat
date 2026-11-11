/**
 * KADE SOUL STATE (Oct 16 2026). Kade, the same day: "I want agentic friend
 * characters, synthetic souls, to be the objective ... memory, opinions,
 * things that make the person. No matter what llm we use."
 *
 * Three things a friend carries between conversations that the platform did
 * not, each stored per (person, character) and read into the per-turn tail:
 *
 *   TIME SENSE  the time of day where the person is, and how long since the two
 *               of them last talked, to the minute. Before this a character knew
 *               the date only, and "days since" appeared at two days or more,
 *               computed by the nightly sweep.
 *   MOOD        how the character felt the last time, carried forward and fading.
 *               Read from the character's OWN voice directions (%%%warm%%%,
 *               %%%flat and hot%%%), through the same vocabulary that moves its
 *               face, so it costs no model call. Measured against the
 *               character's own usual register, so Kiana's everyday "dry" is
 *               her baseline, never a mood. Heavy feelings fade slower than
 *               good ones (40 h half-life against 16 h).
 *   OUR STUFF   short real quotes: a joke that landed, a nickname, a first, a
 *               milestone. The keeper saves them (keep_moment) only when the
 *               words are really in the conversation, and the tail offers a few
 *               back, never one the character used in the last few days.
 *
 * Privacy follows the memory rules already in force: nothing is read or
 * written on a turn run for someone else (voice lane on the service seat), in a
 * temporary chat, in an excluded conversation, off the record, or for a person
 * whose memory is switched off. A full memory clear cuts moments off at the
 * clear's time; moments from excluded conversations are never offered.
 *
 * Kill switches: KADE_SOUL=0 (all), KADE_SOUL_TIME=0, KADE_SOUL_MOOD=0,
 * KADE_SOUL_MOMENTS=0. Fail-soft everywhere: a turn without its soul block
 * beats a broken turn.
 *
 * Nov 10 2026, two additions, neither of which adds a model call or a wait
 * before a reply:
 *   A CALL COUNTS AS TALKING  a finished call stamps "last talked" from the
 *               call's own last turn time (noteCallTalked). Off: KADE_SOUL_CALL_TALKED=0.
 *               Mood is NOT written from calls: the bridge strips the voice
 *               directions out of a transcript before it stores it, so there is
 *               nothing to read a feeling from.
 *   OUR STUFF RESTS  every offer of a moment is counted after the reply; a joke
 *               or line offered KADE_SOUL_MOMENT_OFFERS times (default 5) rests
 *               for KADE_SOUL_MOMENT_REST_DAYS days (default 14). A nickname
 *               never rests: it is how the character says the person's name.
 *               A one-word quote now counts as used when the word is in the
 *               reply, and the block names the moment called back last.
 *               Off: KADE_SOUL_MOMENT_REST=0 (the Oct 16 behaviour, exactly).
 */
'use strict';

const { cue } = require('./kadeSoulVocabulary');

const STATE = 'kadesoulstates';
const MOMENTS = 'kademoments';
const BASELINE_USER = '*';

const on = (name) => process.env.KADE_SOUL !== '0' && process.env[name] !== '0';

const intEnv = (name, def, lo, hi) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : def;
};
/* Read at call time, so a switch flipped in Railway needs no code change. */
const restOn = () => on('KADE_SOUL_MOMENTS') && process.env.KADE_SOUL_MOMENT_REST !== '0';
const offerLimit = () => intEnv('KADE_SOUL_MOMENT_OFFERS', 5, 1, 1000);
const restDays = () => intEnv('KADE_SOUL_MOMENT_REST_DAYS', 14, 1, 365);
const LAST_USED_WINDOW_DAYS = 30;

/* For unit tests only: stand-in collections, memory gate and id maker, so the
 * storage paths run with no database. Never set in the running server. */
const seam = { coll: null, allowed: null, objectId: null, reasonGate: null };

/* How each face expression feels: [valence -1..1, arousal 0..1]. */
const FEEL = Object.freeze({
  neutral: [0, 0.3],
  warm: [0.6, 0.4],
  tender: [0.5, 0.2],
  calm: [0.3, 0.15],
  confident: [0.4, 0.5],
  amused: [0.7, 0.6],
  playful: [0.65, 0.7],
  excited: [0.8, 0.9],
  smug: [0.35, 0.5],
  curious: [0.35, 0.55],
  thoughtful: [0.1, 0.3],
  skeptical: [-0.1, 0.45],
  dry: [0.05, 0.3],
  serious: [-0.05, 0.45],
  frustrated: [-0.5, 0.7],
  angry: [-0.7, 0.9],
  disgusted: [-0.6, 0.6],
  surprised: [0.1, 0.85],
  afraid: [-0.6, 0.8],
  concerned: [-0.35, 0.5],
  sad: [-0.65, 0.2],
  tired: [-0.25, 0.1],
});
const DEFAULT_BASE = Object.freeze({ v: 0.2, a: 0.4 });
const HALF_LIFE_H = Object.freeze({ good: 16, heavy: 40 });
const CONTINUING_MS = 20 * 60 * 1000;

/** The feeling of one reply, from its voice directions; null when it has none. */
function replyFeeling(text) {
  const tags = [...String(text || '').matchAll(/%%%([^%\n]{1,160})%%%/g)].map((m) => m[1]);
  let sv = 0;
  let sa = 0;
  let w = 0;
  const weightByName = {};
  tags.forEach((tag, i) => {
    let c;
    try {
      c = cue(tag);
    } catch (_) {
      return;
    }
    const name = c && c.expression;
    if (!name || name === 'neutral' || !FEEL[name]) {
      return;
    }
    const weight = (i === tags.length - 1 ? 1.5 : 1) * (c.kind === 'moment' ? 0.6 : 1);
    sv += FEEL[name][0] * weight;
    sa += FEEL[name][1] * weight;
    w += weight;
    weightByName[name] = (weightByName[name] || 0) + weight;
  });
  if (!w) {
    return null;
  }
  const top = Object.entries(weightByName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  return { v: sv / w, a: sa / w, top };
}

function baseOf(row) {
  if (!row || !Number.isFinite(row.v) || !Number.isFinite(row.a)) {
    return DEFAULT_BASE;
  }
  /* Until a character has a few dozen replies behind it, lean on the default. */
  const n = Math.min(Number(row.n) || 0, 30);
  const t = n / 30;
  return { v: DEFAULT_BASE.v * (1 - t) + row.v * t, a: DEFAULT_BASE.a * (1 - t) + row.a * t };
}

/** Where the remembered mood stands now, relative to the character's own usual. */
function deviationNow(mood, base, now = new Date()) {
  if (!mood || !mood.at || !Number.isFinite(mood.v) || !Number.isFinite(mood.a)) {
    return null;
  }
  const b = base || DEFAULT_BASE;
  const hours = Math.max(0, (now.getTime() - new Date(mood.at).getTime()) / 3.6e6);
  const dv0 = mood.v - b.v;
  const da0 = mood.a - b.a;
  const k = Math.pow(0.5, hours / (dv0 < 0 ? HALF_LIFE_H.heavy : HALF_LIFE_H.good));
  return { dv: dv0 * k, da: da0 * k, hours };
}

/** Blend a reply into the remembered mood (the old mood fades first). */
function blendMood(mood, base, feeling, now = new Date()) {
  const b = base || DEFAULT_BASE;
  const dev = deviationNow(mood, b, now);
  const cur = dev ? { v: b.v + dev.dv, a: b.a + dev.da } : { v: b.v, a: b.a };
  return {
    v: cur.v * 0.6 + feeling.v * 0.4,
    a: cur.a * 0.6 + feeling.a * 0.4,
    top: feeling.top,
    at: now,
  };
}

/* ── a reason for the mood (Nov 10 2026, plan item N2) ────────────────── */

/* The mood line used to be one of seven canned phrases with nothing behind it:
 * "still a bit stirred up", about what? When the keeper writes a logbook line
 * on a turn, a short piece of that line is now stored beside the mood, and the
 * next time the character comes back with a mood it is told what it was about.
 *
 * Where it lives: in the ONE row for this person and this character
 * (kadesoulstates, userId + agentId). Never in the character's shared baseline
 * row (userId '*'), which every person's turns feed and which holds numbers
 * only. It is the keeper's own line, so it costs no model call, and it is
 * written after the reply.
 *
 * Who may hear it: only a turn on the person's own signed-in seat. A phone
 * call's memory bundle (caller ID only) gets the mood without the reason. It
 * obeys the memory switch, off the record, a conversation kept out of memory
 * and a memory clear, the same as the rest of this file. A full or
 * per-character clear removes it.
 *
 * Off: KADE_SOUL_MOOD_REASON=0 (nothing stored, nothing shown), and every
 * switch that turns the mood off. */
const REASON_MAX = 160;
const REASON_MIN = 12;
const REASON_BEFORE_MS = 90 * 60 * 1000;
const REASON_AFTER_MS = 30 * 60 * 1000;
const reasonOn = () => on('KADE_SOUL_MOOD') && process.env.KADE_SOUL_MOOD_REASON !== '0';

/** One short plain line from the keeper's logbook text, or '' when there is nothing usable. Pure. */
function tidyReason(text) {
  const flat = String(text || '')
    .replace(/%%%[\s\S]*?%%%/g, ' ')
    .replace(/%{2,}/g, ' ')
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length < REASON_MIN) return '';
  /* The first sentence when it is long enough to mean something, else as much as fits. */
  const first = (flat.match(/^.{12,}?[.!?](?=\s|$)/) || [''])[0];
  let out = first && first.length <= REASON_MAX ? first : flat;
  if (out.length > REASON_MAX) {
    out = out.slice(0, REASON_MAX);
    const cut = out.lastIndexOf(' ');
    out = (cut > REASON_MAX * 0.6 ? out.slice(0, cut) : out).replace(/[,;:\s]+$/, '') + '...';
  }
  return out;
}

/**
 * The stored reason, when it belongs to the mood this row carries: written no
 * more than 90 minutes before that mood was last set and no more than 30
 * minutes after (the keeper finishes a little after the reply). Pure.
 */
function moodReasonText(row) {
  const why = row && row.moodWhy;
  const mood = row && row.mood;
  if (!why || !mood || !mood.at || !why.at || typeof why.text !== 'string') return '';
  const text = why.text.trim();
  if (text.length < REASON_MIN) return '';
  const whyAt = new Date(why.at).getTime();
  const moodAt = new Date(mood.at).getTime();
  if (!Number.isFinite(whyAt) || !Number.isFinite(moodAt)) return '';
  if (whyAt < moodAt - REASON_BEFORE_MS || whyAt > moodAt + REASON_AFTER_MS) return '';
  return text.slice(0, REASON_MAX + 3);
}

/** The "# How you're coming in" section, or '' when there is no mood to speak of. Pure. */
function moodSection(row, base, now = new Date(), why = '') {
  if (!row || !row.mood) return '';
  const dev = deviationNow(row.mood, base, now);
  const feeling = dev ? moodWords(dev.dv, dev.da) : '';
  if (!feeling) return '';
  const top = Array.isArray(row.mood.top) && row.mood.top.length ? ` (last time you were mostly ${row.mood.top.join(' and ')})` : '';
  const because = why
    ? ` What it was about, from your own note that day: "${why}" That is why you feel it, not a line to read out; bring the subject up only if it fits.`
    : '';
  return `# How you're coming in\nYou're ${feeling}${top}.${because} Let it color how you sound if it fits, the way a person carries a mood into the next talk. You don't have to mention it.`;
}

function moodWords(dv, da) {
  if (dv >= 0.3) return da > 0.15 ? 'still lit up from last time with them' : 'still warm and glad from last time with them';
  if (dv >= 0.15) return 'in an easy, good place with them';
  if (dv <= -0.3) return da > 0.15 ? 'still a bit stirred up from last time with them' : 'still a little heavy from last time with them';
  if (dv <= -0.15) return da > 0.15 ? 'a little unsettled from last time with them' : 'a little tender from last time with them';
  if (da >= 0.25) return 'still buzzing a bit from last time with them';
  if (da <= -0.25) return 'quieter than usual coming in';
  return '';
}

/* ── time ─────────────────────────────────────────────────────────────── */

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function zoneFor(req) {
  const supplied = req && req.body && typeof req.body.timezone === 'string' ? req.body.timezone.trim() : '';
  if (supplied && validZone(supplied)) return supplied;
  const fallback = (process.env.LC_DEFAULT_TIMEZONE || '').trim();
  return fallback && validZone(fallback) ? fallback : 'America/Chicago';
}

function partsIn(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = parseInt(get('hour'), 10) % 24;
  return {
    weekday: get('weekday'),
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: parseInt(get('minute'), 10),
  };
}

function partOfDay(hour) {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function clock(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a.m.' : 'p.m.'}`;
}

function nowLine(now, tz) {
  const p = partsIn(now, tz);
  const time = clock(p.hour, p.minute);
  if (p.hour < 5) {
    return `It's ${time} where they are, the middle of the night (${p.weekday} night).`;
  }
  return `It's ${p.weekday} ${partOfDay(p.hour)}, ${time}, where they are.`;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** "about 3 hours ago, this afternoon" / "yesterday evening" / "4 days ago (Monday evening)". */
function sinceWords(last, now, tz) {
  const ms = now.getTime() - last.getTime();
  const minutes = ms / 60000;
  const lp = partsIn(last, tz);
  const np = partsIn(now, tz);
  const days = dayDiff(lp.day, np.day);
  const part = partOfDay(lp.hour);
  if (minutes < 90) {
    return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes ago`;
  }
  if (days === 0) {
    const hours = Math.round(minutes / 60);
    const when = part === 'night' && lp.hour < 5 ? 'in the middle of the night' : `this ${part}`;
    return `about ${hours} hour${hours === 1 ? '' : 's'} ago, ${when}`;
  }
  if (days === 1) {
    return part === 'night' ? 'last night' : `yesterday ${part}`;
  }
  if (days < 7) {
    return `${days} days ago (${lp.weekday} ${part})`;
  }
  if (days < 21) {
    return `${days} days ago`;
  }
  if (days < 45) {
    return `about ${Math.round(days / 7)} weeks ago`;
  }
  return `about ${Math.round(days / 30)} months ago`;
}

/* ── moments ──────────────────────────────────────────────────────────── */

const STOP = new Set(
  ('the a an and or but so to of in on at for with is it its i you me my your we our us that this was were be been are am do did does ' +
    'not no yes just like really oh ok okay well um uh lol haha he she they them his her their what when where who how why there here ' +
    'then than too very can could would should will its im youre dont didnt thats got get gonna wanna yeah yep nah one all some any ' +
    'about from out up down off over into have has had').split(' '),
);

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [])
    .map((w) => w.replace(/'s$/, '').replace(/'/g, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function loose(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this quote really in what was said? Exact (loosely) or nearly every word. */
function quoteInEvidence(quote, evidence) {
  const q = loose(quote);
  const e = loose(evidence);
  if (!q || !e) return false;
  if (q.length >= 8 && e.includes(q)) return true;
  const qw = words(quote);
  if (qw.length < 2) return false;
  const ew = new Set(words(evidence));
  const hit = qw.filter((w) => ew.has(w)).length;
  return hit / qw.length >= 0.8;
}

const KINDS = Object.freeze(['nickname', 'joke', 'first', 'milestone', 'line']);
const STANDING = new Set(['nickname', 'joke']);
const MOMENT_CAP = 300;

function relatedness(moment, userWords) {
  const mw = [...new Set(words(`${moment.quote} ${moment.why || ''}`))];
  if (!mw.length || !userWords.size) return 0;
  const hits = mw.filter((w) => userWords.has(w));
  const strong = hits.filter((w) => w.length >= 6).length;
  if (hits.length < 2 && strong < 1) return 0;
  return (hits.length + strong) / Math.sqrt(mw.length);
}

/**
 * Pick the moments to offer this turn: standing bits first, then what they just said calls to mind.
 *
 * With the rest rule on (default): a nickname is always on offer, used or not,
 * because hiding it would make the character stop saying it; it takes one of
 * the two standing places and a joke takes the other. Anything else that is
 * resting (restUntil in the future, set after enough offers) is left out.
 * Still at most four lines, the same as before.
 */
function pickMoments(moments, userText, now = new Date()) {
  const rest = restOn();
  const recentlyUsed = (m, days) => m.lastUsedAt && now.getTime() - new Date(m.lastUsedAt).getTime() < days * 86400000;
  const resting = (m) => Boolean(m.restUntil) && new Date(m.restUntil).getTime() > now.getTime();
  const out = (m, days) => (rest ? m.kind !== 'nickname' && (recentlyUsed(m, days) || resting(m)) : recentlyUsed(m, days));
  const byNewest = [...moments].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  let standing;
  if (rest) {
    const names = byNewest.filter((m) => m.kind === 'nickname');
    const jokes = byNewest.filter((m) => m.kind === 'joke' && !out(m, 2));
    standing = [...names.slice(0, 1), ...jokes.slice(0, names.length ? 1 : 2)];
    if (standing.length < 2) standing.push(...names.slice(1, 3 - standing.length));
  } else {
    standing = byNewest.filter((m) => STANDING.has(m.kind) && !recentlyUsed(m, 2)).slice(0, 2);
  }
  const taken = new Set(standing.map((m) => String(m._id)));
  const uw = new Set(words(userText));
  const related = byNewest
    .filter((m) => !taken.has(String(m._id)) && !out(m, 3))
    .map((m) => ({ m, s: relatedness(m, uw) }))
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .map((x) => x.m);
  return [...standing, ...related];
}

function shortDate(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(d));
  } catch (_) {
    return '';
  }
}

function momentLine(m, tz) {
  const who = m.speaker === 'me' ? 'you said it' : 'they said it';
  const kind = m.kind === 'nickname' ? 'a nickname' : m.kind === 'joke' ? 'a running joke' : m.kind === 'first' ? 'a first' : m.kind === 'milestone' ? 'a milestone' : 'a line that stuck';
  const why = m.why ? `: ${String(m.why).trim()}` : '';
  return `- "${String(m.quote).trim()}" (${who}, ${shortDate(m.createdAt, tz)}; ${kind}${why})`;
}

/* Words only, possessives folded, padded with spaces so a whole-word test is one includes(). */
function phrase(text) {
  const p = loose(String(text || '').replace(/%%%[^%\n]{1,160}%%%/g, ' '))
    .replace(/'s(?= |$)/g, '')
    .replace(/'/g, '')
    .replace(/ +/g, ' ')
    .trim();
  return ` ${p} `;
}

/**
 * Did the reply call this moment back? Two or more real words: most of them are
 * in the reply (the Oct 16 rule). Fewer (a one-word nickname, or a quote made of
 * small words): the quote itself is in the reply as whole words. Before Nov 10
 * the second case could never be true, so a one-word nickname was never marked
 * used.
 */
function momentUsed(quote, replyText) {
  const qw = [...new Set(words(quote))];
  if (qw.length >= 2) {
    const replyWords = new Set(words(replyText));
    return qw.filter((w) => replyWords.has(w)).length / qw.length >= 0.6;
  }
  if (!restOn()) return false;
  const q = phrase(quote);
  return q.trim().length >= 2 && phrase(replyText).includes(q);
}

/**
 * What to write after a reply, for the moments that were offered this turn.
 * Pure. Every offer is counted. A moment that is not a nickname rests once its
 * offers since the last rest reach the limit, and the count starts over.
 * @returns {{ usedIds: any[], restIds: any[], countIds: any[], restUntil: Date }}
 */
function offerPlan(recalled, replyText, now = new Date()) {
  const rest = restOn();
  const limit = offerLimit();
  const usedIds = [];
  const restIds = [];
  const countIds = [];
  for (const m of recalled || []) {
    if (momentUsed(m.quote, replyText)) usedIds.push(m._id);
    if (!rest) continue;
    if (m.kind !== 'nickname' && (Number(m.offers) || 0) + 1 >= limit) restIds.push(m._id);
    else countIds.push(m._id);
  }
  return { usedIds, restIds, countIds, restUntil: new Date(now.getTime() + restDays() * 86400000) };
}

/** The moment the character called back most recently (never a nickname), or null. */
function lastUsedMoment(moments, now = new Date()) {
  let best = null;
  for (const m of moments || []) {
    if (!m || m.kind === 'nickname' || !m.lastUsedAt) continue;
    const at = new Date(m.lastUsedAt).getTime();
    if (!Number.isFinite(at) || at > now.getTime() || now.getTime() - at > LAST_USED_WINDOW_DAYS * 86400000) continue;
    if (!best || at > new Date(best.lastUsedAt).getTime()) best = m;
  }
  return best;
}

/** The "# Our stuff" section for this turn. Pure. `text` is '' when there is nothing to offer. */
function ourStuffSection(moments, userText, now = new Date(), tz = 'America/Chicago') {
  const picked = pickMoments(moments, userText || '', now);
  if (!picked.length) return { text: '', recalledIds: [] };
  let text =
    `# Our stuff\nReal moments with them, in the words that were said. Call one back only when it fits what's happening, like a friend would, and never the same one twice in a row.\n` +
    picked.map((m) => momentLine(m, tz)).join('\n');
  if (restOn()) {
    const pickedIds = new Set(picked.map((m) => String(m._id)));
    const last = lastUsedMoment(moments, now);
    if (last && !pickedIds.has(String(last._id))) {
      text += `\nThe one you called back most recently was "${String(last.quote).trim()}", ${sinceWords(new Date(last.lastUsedAt), now, tz)}. Let that one rest for now.`;
    }
  }
  return { text, recalledIds: picked.map((m) => String(m._id)) };
}

/* ── storage ──────────────────────────────────────────────────────────── */

function coll(name) {
  return seam.coll ? seam.coll(name) : require('mongoose').connection.collection(name);
}

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await coll(STATE).createIndex({ userId: 1, agentId: 1 }, { unique: true });
    await coll(MOMENTS).createIndex({ userId: 1, agentId: 1, createdAt: -1 });
  } catch (_) {
    indexed = false;
  }
}

/**
 * May this turn read or write soul state for this person? A hidden run (the
 * character speaking first, services/kadeHiddenRun.js) runs in a throwaway
 * temporary chat on the person's own seat: it may READ, so the message carries
 * the mood and the time, and never WRITES.
 */
async function soulAllowed({ userId, agentId, req, conversationId, offRecord, write = false }) {
  if (process.env.KADE_SOUL === '0' || !userId || !agentId || String(agentId).startsWith('ephemeral')) return false;
  if (offRecord) return false;
  if (req) {
    const { ownsPrivateMemory } = require('@librechat/api');
    if (!ownsPrivateMemory(req)) return false;
    const hidden = req.kadeHiddenRun === true;
    if (hidden && write) return false;
    if (!hidden && req.body && req.body.isTemporary) return false;
  }
  const ds = require('@librechat/data-schemas');
  if (conversationId && typeof ds.getConversationMemoryPolicy === 'function') {
    if (await ds.getConversationMemoryPolicy(String(userId), String(conversationId))) return false;
  }
  const User = require('mongoose').models.User;
  if (User) {
    const u = await User.findById(String(userId)).select('personalization').lean();
    if (u && u.personalization && u.personalization.memories === false) return false;
  }
  return true;
}

async function readState(userId, agentId) {
  await ensureIndexes();
  const [row, base] = await Promise.all([
    coll(STATE).findOne({ userId: String(userId), agentId: String(agentId) }),
    coll(STATE).findOne({ userId: BASELINE_USER, agentId: String(agentId) }),
  ]);
  return { row, base: baseOf(base) };
}

async function lastTalkedAt(userId, agentId, conversationId, row) {
  if (row && row.lastTurnAt) return new Date(row.lastTurnAt);
  /* First turn since this shipped: fall back to the newest other conversation. */
  try {
    const Conversation = require('mongoose').models.Conversation;
    if (!Conversation) return null;
    const prior = await Conversation.findOne({
      user: String(userId),
      agent_id: String(agentId),
      ...(conversationId ? { conversationId: { $ne: String(conversationId) } } : {}),
    })
      .sort({ updatedAt: -1 })
      .select('updatedAt')
      .lean();
    return prior && prior.updatedAt ? new Date(prior.updatedAt) : null;
  } catch (_) {
    return null;
  }
}

/** Was this person's memory cleared after `at`? A cleared mood is not carried. */
async function clearedSince(userId, agentId, at) {
  const ds = require('@librechat/data-schemas');
  if (typeof ds.memoryClearCutoff !== 'function' || !at) return false;
  const cutoff = await ds.memoryClearCutoff(String(userId), String(agentId));
  return Boolean(cutoff && new Date(at).getTime() <= cutoff.getTime());
}

async function visibleMoments(userId, agentId) {
  const ds = require('@librechat/data-schemas');
  const [excluded, cutoff] = await Promise.all([
    typeof ds.excludedMemoryConversations === 'function' ? ds.excludedMemoryConversations(String(userId)) : [],
    typeof ds.memoryClearCutoff === 'function' ? ds.memoryClearCutoff(String(userId), String(agentId)) : null,
  ]);
  const filter = { userId: String(userId), agentId: String(agentId) };
  if (excluded && excluded.length) filter.conversationId = { $nin: excluded };
  if (cutoff) filter.createdAt = { $gt: cutoff };
  return coll(MOMENTS).find(filter).sort({ createdAt: -1 }).limit(MOMENT_CAP).toArray();
}

/* ── the per-turn tail ────────────────────────────────────────────────── */

/**
 * @returns {Promise<{ block: string, recalledIds: string[] }>}
 */
async function getSoulTailBlock({ userId, agentId, req, conversationId, userText, offRecord, now = new Date() }) {
  const empty = { block: '', recalledIds: [] };
  try {
    if (!(await soulAllowed({ userId, agentId, req, conversationId, offRecord }))) return empty;
    const tz = zoneFor(req);
    const { row, base } = await readState(userId, agentId);
    const last = await lastTalkedAt(userId, agentId, conversationId, row);
    const gapMs = last ? now.getTime() - last.getTime() : null;
    const comingBack = gapMs === null || gapMs >= CONTINUING_MS;
    const sections = [];

    if (on('KADE_SOUL_TIME')) {
      const lines = [nowLine(now, tz)];
      if (last && comingBack) lines.push(`You two last talked ${sinceWords(last, now, tz)}.`);
      sections.push(`# Right now\n${lines.join(' ')}`);
    }

    if (on('KADE_SOUL_MOOD') && comingBack && row && row.mood) {
      /* Nov 10 2026: the reason's own checks run beside the clear check that was
       * already waited on here, not after it, so this adds no wait. A turn with
       * no request (a phone call's memory bundle) never gets the reason. */
      const [cleared, why] = await Promise.all([
        clearedSince(userId, agentId, row.mood.at),
        req ? moodReasonAllowed(row, userId, agentId).catch(() => '') : '',
      ]);
      if (!cleared) {
        const section = moodSection(row, base, now, why);
        if (section) sections.push(section);
      }
    }

    let recalledIds = [];
    if (on('KADE_SOUL_MOMENTS')) {
      const moments = await visibleMoments(userId, agentId);
      const ours = ourStuffSection(moments, userText || '', now, tz);
      if (ours.text) {
        recalledIds = ours.recalledIds;
        sections.push(ours.text);
      }
    }
    return { block: sections.join('\n\n'), recalledIds };
  } catch (e) {
    try {
      require('@librechat/data-schemas').logger.warn('[kadeSoul] tail skipped: ' + (e && e.message));
    } catch (_) {}
    return empty;
  }
}

/* ── after the reply ──────────────────────────────────────────────────── */

async function noteAfterReply({ userId, agentId, req, conversationId, text, recalledIds = [], offRecord, now = new Date() }) {
  try {
    if (!(await (seam.allowed || soulAllowed)({ userId, agentId, req, conversationId, offRecord, write: true }))) return { ok: false, skipped: true };
    await ensureIndexes();
    const feeling = on('KADE_SOUL_MOOD') ? replyFeeling(text) : null;
    const { row, base } = await readState(userId, agentId);
    const set = { lastTurnAt: now, lastConversationId: conversationId ? String(conversationId) : null, updatedAt: now };
    if (feeling) {
      set.mood = blendMood(row && row.mood, base, feeling, now);
      /* The character's own usual register, across everyone: numbers only. */
      const b = await coll(STATE).findOne({ userId: BASELINE_USER, agentId: String(agentId) });
      const n = (b && Number(b.n)) || 0;
      const alpha = Math.max(0.02, 1 / (n + 1));
      const bv = b && Number.isFinite(b.v) ? b.v : feeling.v;
      const ba = b && Number.isFinite(b.a) ? b.a : feeling.a;
      await coll(STATE).updateOne(
        { userId: BASELINE_USER, agentId: String(agentId) },
        { $set: { v: bv * (1 - alpha) + feeling.v * alpha, a: ba * (1 - alpha) + feeling.a * alpha, updatedAt: now }, $inc: { n: 1 } },
        { upsert: true },
      );
    }
    await coll(STATE).updateOne(
      { userId: String(userId), agentId: String(agentId) },
      { $set: set, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    if (recalledIds.length && text) {
      const ObjectId = seam.objectId || require('mongodb').ObjectId;
      const ids = recalledIds.map((id) => {
        try {
          return new ObjectId(id);
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
      const recalled = await coll(MOMENTS).find({ _id: { $in: ids }, userId: String(userId), agentId: String(agentId) }).toArray();
      const plan = offerPlan(recalled, text, now);
      if (plan.usedIds.length) {
        await coll(MOMENTS).updateMany({ _id: { $in: plan.usedIds } }, { $set: { lastUsedAt: now }, $inc: { uses: 1 } });
      }
      /* Nov 10 2026: count the offer. After the reply, never waited on. */
      if (plan.countIds.length) {
        await coll(MOMENTS).updateMany({ _id: { $in: plan.countIds } }, { $set: { lastOfferedAt: now }, $inc: { offers: 1, offersTotal: 1 } });
      }
      if (plan.restIds.length) {
        await coll(MOMENTS).updateMany(
          { _id: { $in: plan.restIds } },
          { $set: { lastOfferedAt: now, offers: 0, restUntil: plan.restUntil }, $inc: { offersTotal: 1, rests: 1 } },
        );
      }
    }
    return { ok: true, mood: Boolean(feeling) };
  } catch (e) {
    try {
      require('@librechat/data-schemas').logger.warn('[kadeSoul] after-reply skipped: ' + (e && e.message));
    } catch (_) {}
    return { ok: false, error: e && e.message };
  }
}

/* ── the reason, stored and read ──────────────────────────────────────── */

/**
 * Store why the character feels the way it does, from the logbook line the
 * keeper just wrote for this turn. Called after the reply, never waited on.
 * Writes only the row for this person and this character. Never throws.
 */
async function noteMoodReason({ userId, agentId, req, conversationId, text, offRecord, now = new Date() }) {
  try {
    if (!reasonOn()) return { ok: false, skipped: 'off' };
    /* The shared per-character baseline row is keyed by this user id. It holds numbers only, for everyone. */
    if (!userId || String(userId) === BASELINE_USER) return { ok: false, skipped: 'no-person' };
    const reason = tidyReason(text);
    if (!reason) return { ok: false, skipped: 'empty' };
    if (!(await (seam.allowed || soulAllowed)({ userId, agentId, req, conversationId, offRecord, write: true }))) {
      return { ok: false, skipped: 'memory-off' };
    }
    await ensureIndexes();
    await coll(STATE).updateOne(
      { userId: String(userId), agentId: String(agentId) },
      {
        $set: { moodWhy: { text: reason, at: now, conversationId: conversationId ? String(conversationId) : null }, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    return { ok: true };
  } catch (e) {
    try {
      require('@librechat/data-schemas').logger.warn('[kadeSoul] mood reason skipped: ' + (e && e.message));
    } catch (_) {}
    return { ok: false, error: e && e.message };
  }
}

/**
 * The reason to show this turn, or ''. On top of moodReasonText: nothing after
 * a memory clear, and nothing from a conversation now kept out of memory.
 */
async function moodReasonAllowed(row, userId, agentId) {
  if (!reasonOn()) return '';
  const text = moodReasonText(row);
  if (!text) return '';
  if (seam.reasonGate) return (await seam.reasonGate(row, userId, agentId)) ? text : '';
  const ds = require('@librechat/data-schemas');
  const from = row.moodWhy.conversationId;
  const [cleared, excluded] = await Promise.all([
    clearedSince(userId, agentId, row.moodWhy.at),
    typeof ds.excludedMemoryConversations === 'function' ? ds.excludedMemoryConversations(String(userId)) : [],
  ]);
  if (cleared) return '';
  if (from && Array.isArray(excluded) && excluded.includes(String(from))) return '';
  return text;
}

/* ── a finished call counts as talking (Nov 10 2026) ──────────────────── */

const VOICEMAIL_TURN = /^\s*\[VOICEMAIL LEFT\]/i;
const CLOCK_SLACK_MS = 10 * 60 * 1000;

/**
 * When did this call last have a turn, and may it count as the two of them
 * talking? Pure. Never answers "now": the time comes from the call's own last
 * turn, or from the time the call ended when its turns carry no times (the
 * phone bridge sends none). A time slightly ahead of this server's clock is
 * pulled back to the clock; one far ahead is a broken clock and is refused.
 *
 * Refused: no resolved caller, no real character, a voicemail (the bridge
 * marks the message it left with "[VOICEMAIL LEFT]"), a call where the person
 * never spoke, and an outbound call with fewer than two things said by the
 * other end (an answering machine's greeting is usually heard as one).
 *
 * @param {object} doc lean call transcript ({ user, agentId, turns, endedAt, metadata })
 * @returns {{ at: Date } | { skip: string }}
 */
function callTalkStamp(doc, now = new Date()) {
  if (!doc || !doc.user) return { skip: 'no-caller' };
  if (!doc.agentId || String(doc.agentId).startsWith('ephemeral')) return { skip: 'no-character' };
  const turns = (Array.isArray(doc.turns) ? doc.turns : []).filter((t) => t && String(t.text || '').trim());
  if (turns.some((t) => VOICEMAIL_TURN.test(String(t.text)))) return { skip: 'voicemail' };
  const said = turns.filter((t) => t.role === 'user').length;
  if (!said) return { skip: 'nobody-spoke' };
  const outbound = Boolean(doc.metadata && doc.metadata.outbound);
  if (outbound && said < 2) return { skip: 'outbound-unanswered' };
  const times = turns.map((t) => (t.at ? new Date(t.at).getTime() : NaN)).filter(Number.isFinite);
  let at = times.length ? Math.max(...times) : doc.endedAt ? new Date(doc.endedAt).getTime() : NaN;
  if (!Number.isFinite(at)) return { skip: 'no-time' };
  if (at > now.getTime() + CLOCK_SLACK_MS) return { skip: 'time-ahead' };
  at = Math.min(at, now.getTime());
  return { at: new Date(at) };
}

/**
 * Stamp "last talked" for this person and character from a finished call.
 * Only ever moves the time forward ($max), so a second ingest of the same call,
 * or a call filed after a later text turn, changes nothing. Writes a time and
 * nothing else: a phone caller is known by caller ID only. Obeys the person's
 * memory switch and a conversation set to stay out of memory. Never throws.
 */
async function noteCallTalked(doc, { now = new Date() } = {}) {
  try {
    if (process.env.KADE_SOUL === '0' || process.env.KADE_SOUL_CALL_TALKED === '0') return { ok: false, skipped: 'off' };
    const stamp = callTalkStamp(doc, now);
    if (stamp.skip) return { ok: false, skipped: stamp.skip };
    const userId = String(doc.user);
    const agentId = String(doc.agentId).slice(0, 64);
    const conversationId = doc.mergedConversationId || doc.conversationId || null;
    if (!(await (seam.allowed || soulAllowed)({ userId, agentId, req: null, conversationId, write: true }))) {
      return { ok: false, skipped: 'memory-off' };
    }
    await ensureIndexes();
    await coll(STATE).updateOne(
      { userId, agentId },
      { $max: { lastTurnAt: stamp.at }, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return { ok: true, at: stamp.at };
  } catch (e) {
    try {
      require('@librechat/data-schemas').logger.warn('[kadeSoul] call stamp skipped: ' + (e && e.message));
    } catch (_) {}
    return { ok: false, error: e && e.message };
  }
}

/* ── the keeper's keep_moment ─────────────────────────────────────────── */

/**
 * Save one moment. `evidence` is the recent conversation text the keeper saw;
 * the quote must really be in it. Runs inside the keeper's memory source scope.
 */
async function keepMoment({ userId, agentId, quote, speaker, kind, why, conversationId, evidence }) {
  if (!on('KADE_SOUL_MOMENTS')) return { ok: false, error: 'moments are switched off' };
  const q = String(quote || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (q.length < 3 || q.length > 200) return { ok: false, error: 'a moment is a short quote, 3 to 200 characters' };
  if (!userId || !agentId) return { ok: false, error: 'missing person or character' };
  if (!quoteInEvidence(q, evidence)) return { ok: false, error: 'those words are not in the conversation; keep only what was really said' };
  /* Card 8 (Nov 11 2026): never keep a moment that carries a fact the person asked to forget. */
  try {
    if (await require('./kadeKnownTombstones').blocks(userId, `${q}\n${String(why || '')}`)) {
      return { ok: false, error: 'they asked for that to be forgotten' };
    }
  } catch (_) {
    /* kept as before */
  }
  const ds = require('@librechat/data-schemas');
  const source =
    (ds.memorySourceStorage && ds.memorySourceStorage.getStore && ds.memorySourceStorage.getStore()) ||
    (conversationId ? { userId: String(userId), conversationId: String(conversationId), kind: 'conversation' } : undefined);
  if (typeof ds.memorySourceAllowed === 'function' && !(await ds.memorySourceAllowed(source))) {
    return { ok: false, error: 'Conversation memory is excluded' };
  }
  await ensureIndexes();
  const existing = await coll(MOMENTS).find({ userId: String(userId), agentId: String(agentId) }).project({ quote: 1 }).toArray();
  if (existing.some((m) => loose(m.quote) === loose(q))) return { ok: true, duplicate: true };
  const now = new Date();
  const doc = {
    userId: String(userId),
    agentId: String(agentId),
    quote: q,
    speaker: speaker === 'me' ? 'me' : 'them',
    kind: KINDS.includes(kind) ? kind : 'line',
    why: String(why || '').trim().slice(0, 160),
    conversationId: conversationId ? String(conversationId) : (source && source.conversationId) || null,
    createdAt: now,
    lastUsedAt: null,
    uses: 0,
  };
  const { insertedId } = await coll(MOMENTS).insertOne(doc);
  if (typeof ds.memorySourceAllowed === 'function' && !(await ds.memorySourceAllowed(source))) {
    await coll(MOMENTS).deleteOne({ _id: insertedId });
    return { ok: false, error: 'Memory policy changed during this write' };
  }
  /* Keep the pile bounded: the oldest plain lines go first, standing bits stay. */
  const count = existing.length + 1;
  if (count > MOMENT_CAP) {
    const extra = await coll(MOMENTS)
      .find({ userId: String(userId), agentId: String(agentId), kind: { $nin: ['nickname', 'joke'] } })
      .sort({ createdAt: 1 })
      .limit(count - MOMENT_CAP)
      .project({ _id: 1 })
      .toArray();
    if (extra.length) await coll(MOMENTS).deleteMany({ _id: { $in: extra.map((m) => m._id) } });
  }
  return { ok: true };
}

/* ── for the person's own view (About this character) ─────────────────── */

async function soulSnapshot({ userId, agentId, now = new Date() }) {
  const { row, base } = await readState(userId, agentId);
  const moodCleared = row && row.mood ? await clearedSince(userId, agentId, row.mood.at) : true;
  const dev = row && row.mood && !moodCleared ? deviationNow(row.mood, base, now) : null;
  const feeling = dev ? moodWords(dev.dv, dev.da) : '';
  const moments = await visibleMoments(userId, agentId);
  return {
    mood: feeling ? { words: feeling, lastMostly: (row.mood.top || []).slice(0, 2) } : null,
    lastTalkedAt: row && row.lastTurnAt ? new Date(row.lastTurnAt).toISOString() : null,
    moments: moments.map((m) => ({
      id: String(m._id),
      quote: m.quote,
      speaker: m.speaker,
      kind: m.kind,
      why: m.why || '',
      createdAt: m.createdAt,
    })),
  };
}

async function forgetMoment({ userId, agentId, id }) {
  const { ObjectId } = require('mongodb');
  let _id;
  try {
    _id = new ObjectId(String(id));
  } catch (_) {
    return { ok: false, error: 'not a moment id' };
  }
  const r = await coll(MOMENTS).deleteOne({ _id, userId: String(userId), ...(agentId ? { agentId: String(agentId) } : {}) });
  return { ok: r.deletedCount === 1 };
}

/** A full or per-character memory clear also clears moments and mood (called by the clear paths). */
async function clearSoul(userId, agentId) {
  const scope = { userId: String(userId), ...(agentId ? { agentId: String(agentId) } : {}) };
  await coll(MOMENTS).deleteMany(scope);
  await coll(STATE).updateMany(scope, { $unset: { mood: 1, moodWhy: 1 } });
}

module.exports = {
  getSoulTailBlock,
  noteAfterReply,
  noteCallTalked,
  noteMoodReason,
  keepMoment,
  soulSnapshot,
  forgetMoment,
  clearSoul,
  /* pure pieces, exported for tests */
  replyFeeling,
  deviationNow,
  blendMood,
  moodWords,
  tidyReason,
  moodReasonText,
  moodReasonAllowed,
  moodSection,
  baseOf,
  nowLine,
  sinceWords,
  quoteInEvidence,
  pickMoments,
  momentUsed,
  offerPlan,
  lastUsedMoment,
  ourStuffSection,
  callTalkStamp,
  words,
  FEEL,
  __seam: seam,
};
