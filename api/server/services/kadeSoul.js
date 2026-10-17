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
 */
'use strict';

const { cue } = require('./kadeSoulVocabulary');

const STATE = 'kadesoulstates';
const MOMENTS = 'kademoments';
const BASELINE_USER = '*';

const on = (name) => process.env.KADE_SOUL !== '0' && process.env[name] !== '0';

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

/** Pick the moments to offer this turn: standing bits first, then what they just said calls to mind. */
function pickMoments(moments, userText, now = new Date()) {
  const recentlyUsed = (m, days) => m.lastUsedAt && now.getTime() - new Date(m.lastUsedAt).getTime() < days * 86400000;
  const byNewest = [...moments].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const standing = byNewest.filter((m) => STANDING.has(m.kind) && !recentlyUsed(m, 2)).slice(0, 2);
  const taken = new Set(standing.map((m) => String(m._id)));
  const uw = new Set(words(userText));
  const related = byNewest
    .filter((m) => !taken.has(String(m._id)) && !recentlyUsed(m, 3))
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

/* ── storage ──────────────────────────────────────────────────────────── */

function coll(name) {
  return require('mongoose').connection.collection(name);
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

    if (on('KADE_SOUL_MOOD') && comingBack && row && row.mood && !(await clearedSince(userId, agentId, row.mood.at))) {
      const dev = deviationNow(row.mood, base, now);
      const feeling = dev ? moodWords(dev.dv, dev.da) : '';
      if (feeling) {
        const top = Array.isArray(row.mood.top) && row.mood.top.length ? ` (last time you were mostly ${row.mood.top.join(' and ')})` : '';
        sections.push(
          `# How you're coming in\nYou're ${feeling}${top}. Let it color how you sound if it fits, the way a person carries a mood into the next talk. You don't have to mention it.`,
        );
      }
    }

    let recalledIds = [];
    if (on('KADE_SOUL_MOMENTS')) {
      const moments = await visibleMoments(userId, agentId);
      const picked = pickMoments(moments, userText || '', now);
      if (picked.length) {
        recalledIds = picked.map((m) => String(m._id));
        sections.push(
          `# Our stuff\nReal moments with them, in the words that were said. Call one back only when it fits what's happening, like a friend would, and never the same one twice in a row.\n` +
            picked.map((m) => momentLine(m, tz)).join('\n'),
        );
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
    if (!(await soulAllowed({ userId, agentId, req, conversationId, offRecord, write: true }))) return { ok: false, skipped: true };
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
      const { ObjectId } = require('mongodb');
      const ids = recalledIds.map((id) => {
        try {
          return new ObjectId(id);
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
      const recalled = await coll(MOMENTS).find({ _id: { $in: ids }, userId: String(userId), agentId: String(agentId) }).toArray();
      const replyWords = new Set(words(text));
      const used = recalled.filter((m) => {
        const qw = [...new Set(words(m.quote))];
        return qw.length >= 2 && qw.filter((w) => replyWords.has(w)).length / qw.length >= 0.6;
      });
      if (used.length) {
        await coll(MOMENTS).updateMany({ _id: { $in: used.map((m) => m._id) } }, { $set: { lastUsedAt: now }, $inc: { uses: 1 } });
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
  await coll(STATE).updateMany(scope, { $unset: { mood: 1 } });
}

module.exports = {
  getSoulTailBlock,
  noteAfterReply,
  keepMoment,
  soulSnapshot,
  forgetMoment,
  clearSoul,
  /* pure pieces, exported for tests */
  replyFeeling,
  deviationNow,
  blendMood,
  moodWords,
  baseOf,
  nowLine,
  sinceWords,
  quoteInEvidence,
  pickMoments,
  words,
  FEEL,
};
