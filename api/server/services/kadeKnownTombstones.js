/**
 * "DO NOT RELEARN" MARKERS FOR FORGOTTEN FACTS (Nov 11 2026, card 8).
 *
 * When a person says "forget that", kadeKnownCard.js deletes the card and writes a tombstone
 * here: the forgotten words, each hashed with the person's id. The words themselves are not
 * kept, so the tombstone does not keep the fact it guards.
 *
 * Every writer that could bring the fact back respects it:
 *   - the keeper's card writes (packages/data-schemas methods/memory.ts, through
 *     memoryTombstoned in memory/policy.ts, the same match in TypeScript),
 *   - the relationship summary (models/kadeMemorySummary.js setMemorySummary: the nightly pass,
 *     same-day memory and call summaries all save through it; a sentence carrying the fact is
 *     dropped from every field),
 *   - same-day memory (kadeSameDayMemory.js drops the sentence before it saves),
 *   - the nightly card check (kadeCardCheck.js never writes a fix that carries it),
 *   - the logbook (models/kadeDiary.js logDiaryEntry refuses the entry),
 *   - moments (kadeSoul.js keepMoment refuses the quote).
 *
 * The match: a text carries a forgotten fact when it holds at least 80 percent of the fact's
 * content words (both, when the fact has only two). It must stay identical to
 * packages/data-schemas/src/memory/tombstoneMatch.ts; kadeKnownTombstones.test.js checks both.
 *
 * Tombstones last KADE_KNOWN_TOMBSTONE_DAYS (default 365). The person's own correction or a fresh
 * "remember this" through kade_known lifts a matching one. An account delete removes them all.
 * Off: KADE_KNOWN_TOMBSTONE=0 (nothing is checked or dropped; tombstones are still written).
 * Every function here fails open: a database hiccup never blocks an ordinary write.
 */
'use strict';

const crypto = require('crypto');

const COLL = 'kadeknowntombstones';

const STOP = new Set(
  (
    'the and for are but not you your yours was were with that this they them their there then than ' +
    'have has had having she her hers him his its our ours who whom what when where why how which ' +
    'will would shall should can could may might must about into onto from over under again also just ' +
    'very too some any all each every both few more most other such only own same off out up down ' +
    'being been does did doing done get got gets user person said says told tell tells like really'
  ).split(' '),
);

function on(env = process.env) {
  return String((env && env.KADE_KNOWN_TOMBSTONE) ?? '') !== '0';
}
function days(env = process.env) {
  const v = parseInt(env && env.KADE_KNOWN_TOMBSTONE_DAYS, 10);
  return Number.isFinite(v) && v >= 1 && v <= 3650 ? v : 365;
}

/* ── the match (pure; mirror of tombstoneMatch.ts) ─────────────────────── */

function words(text) {
  const seen = new Set();
  const out = [];
  const raw = String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/);
  for (const w of raw) {
    if (!w) continue;
    const digits = /^[0-9]+$/.test(w);
    if (!digits && (w.length < 3 || STOP.has(w))) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function hashOf(userId, word) {
  return crypto.createHash('sha256').update(`${String(userId)}|${word}`).digest('hex').slice(0, 16);
}

function hashes(userId, text) {
  return words(text).map((w) => hashOf(userId, w));
}

/* Review fix (Nov 11 2026): 60 percent of the forgotten fact's words, and at least two, so a
 * reworded fact ("Has a sister nearby in Branson, Missouri" after "sister lives in Branson") is
 * still caught. It leans toward keeping a fact forgotten over learning a near one. */
function covers(tomb, candidate) {
  const t = Array.isArray(tomb) ? tomb : [];
  if (t.length < 2) return false;
  const have = new Set(candidate || []);
  let hit = 0;
  for (const h of t) if (have.has(h)) hit += 1;
  return hit >= Math.max(2, Math.ceil(t.length * 0.6));
}

/** Split into sentences, keeping each sentence's own trailing space or line break. */
function sentences(text) {
  const s = String(text || '');
  const out = [];
  const re = /[^.!?\n]*(?:[.!?]+|\n|$)\s*/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) break;
    out.push(m[0]);
  }
  return out;
}

/**
 * Drop every sentence that carries a forgotten fact. Pure.
 * @returns {{ text: string, removed: number }}
 */
function scrubWith(userId, text, tombs) {
  const src = typeof text === 'string' ? text : '';
  if (!src || !Array.isArray(tombs) || !tombs.length) return { text: src, removed: 0 };
  let removed = 0;
  const kept = sentences(src).filter((sentence) => {
    const cand = hashes(userId, sentence);
    if (tombs.some((t) => covers(t.hashes, cand))) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (!removed) return { text: src, removed: 0 };
  return { text: kept.join('').replace(/[ \t]+\n/g, '\n').trim(), removed };
}

/**
 * For removing what a forgotten fact left behind (a moment is a short quote): true when the text
 * carries the fact, or when it is mostly made of the fact's words (two or more, 60 percent of its
 * own). Never used to refuse a new write: a short new fact may share a word or two.
 */
function carriesPart(userId, text, tombs) {
  if (blockedWith(userId, text, tombs)) return true;
  const own = hashes(userId, text);
  if (own.length < 2) return false;
  return (tombs || []).some((t) => {
    const set = new Set(t.hashes || []);
    const hit = own.filter((h) => set.has(h)).length;
    return hit >= 2 && hit / own.length >= 0.6;
  });
}

function blockedWith(userId, text, tombs) {
  if (!Array.isArray(tombs) || !tombs.length) return false;
  const whole = hashes(userId, text);
  if (tombs.some((t) => covers(t.hashes, whole))) return true;
  return sentences(text).some((s) => {
    const cand = hashes(userId, s);
    return tombs.some((t) => covers(t.hashes, cand));
  });
}

/* ── storage ──────────────────────────────────────────────────────────── */

/* For unit tests only: an in-memory stand-in for the collection. Never set in the running server. */
const seam = { coll: null };
let indexed = false;
function coll() {
  if (seam.coll) return seam.coll;
  const c = require('mongoose').connection.collection(COLL);
  if (!indexed) {
    indexed = true;
    Promise.resolve()
      .then(() => c.createIndex({ userId: 1, createdAt: -1 }))
      .then(() => c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }))
      .catch(() => {
        indexed = false;
      });
  }
  return c;
}

async function list(userId, now = new Date()) {
  if (!userId) return [];
  const rows = await coll()
    .find({ userId: String(userId), $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] })
    .limit(2000)
    .toArray();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Write the tombstone for one forgotten fact. The fact's text is NOT stored, only its hashed words.
 * @returns {Promise<boolean>} whether a tombstone was written (a fact of one word gets none)
 */
async function add({ userId, agentId = null, text, origin = 'forget', now = new Date(), env = process.env }) {
  const h = hashes(userId, text);
  if (!userId || h.length < 2) return false;
  await coll().insertOne({
    userId: String(userId),
    agentId: agentId == null ? null : String(agentId),
    hashes: h,
    origin: String(origin).slice(0, 24),
    createdAt: now,
    expiresAt: new Date(now.getTime() + days(env) * 86400000),
  });
  return true;
}

/** The person told it again on purpose ("remember that", or a correction): lift matching tombstones. */
async function lift({ userId, text }) {
  if (!userId) return 0;
  const cand = hashes(userId, text);
  const rows = await list(userId);
  const ids = rows.filter((t) => covers(t.hashes, cand)).map((t) => t._id);
  if (!ids.length) return 0;
  const r = await coll().deleteMany({ _id: { $in: ids }, userId: String(userId) });
  return (r && r.deletedCount) || ids.length;
}

/**
 * True when the text carries a fact this person asked to forget. Review fix: fails CLOSED when the
 * tombstones cannot be read (the write is skipped this time; a forgotten fact never comes back
 * because of a database hiccup).
 */
async function blocks(userId, text, env = process.env) {
  try {
    if (!on(env) || !userId || !String(text || '').trim()) return false;
    return blockedWith(userId, text, await list(userId));
  } catch (_) {
    return true;
  }
}

/** The text with every sentence carrying a forgotten fact dropped. Fails open (text unchanged). */
async function scrub(userId, text, env = process.env) {
  try {
    if (!on(env) || !userId || typeof text !== 'string' || !text.trim()) return { text, removed: 0 };
    return scrubWith(userId, text, await list(userId));
  } catch (_) {
    return { text, removed: 0 };
  }
}

/** Scrub several string fields at once (one read). Non-string fields pass through untouched. */
async function scrubFields(userId, fields, env = process.env) {
  const out = { ...(fields || {}) };
  let removed = 0;
  try {
    if (!on(env) || !userId) return { fields: out, removed };
    const tombs = await list(userId);
    if (!tombs.length) return { fields: out, removed };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const r = scrubWith(userId, v, tombs);
      out[k] = r.text;
      removed += r.removed;
    }
  } catch (_) {
    return { fields: { ...(fields || {}) }, removed: 0 };
  }
  return { fields: out, removed };
}

/** Account delete. */
async function clearFor(userId) {
  if (!userId) return 0;
  const r = await coll().deleteMany({ userId: String(userId) });
  return (r && r.deletedCount) || 0;
}

module.exports = {
  COLL,
  on,
  words,
  hashOf,
  hashes,
  covers,
  sentences,
  scrubWith,
  blockedWith,
  carriesPart,
  list,
  add,
  lift,
  blocks,
  scrub,
  scrubFields,
  clearFor,
  __seam: seam,
};
