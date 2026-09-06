/* REVERIE LIFE — needs and mood (Sep 6 2026).
 *
 * Five comfort meters, 0 to 100, the Sims shape with the Reverie law on top:
 * they only move while you are actually playing. Law 3 is kept in the math —
 * the decay clock advances by at most twenty minutes per command, so a night
 * away costs you twenty minutes of hunger, not a night of it. Nothing here
 * kills anybody. A meter at zero is uncomfortable and says so, and that is
 * all it ever is.
 *
 *   fed      — food is society, not fuel. Eat where the people are.
 *   rested   — sleep anywhere safe. Home beds do it better.
 *   clean    — showers, the salon, a swim. Low clean and people notice.
 *   fun      — games, music, fishing, fooling around.
 *   company  — talk to somebody. Anybody. The strays count a little.
 *
 * Mood is the average, and mood is the multiplier on everything you learn
 * and the color on everything a citizen says back to you. */
const { clamp } = require('./ctx');

const NEEDS = ['fed', 'rested', 'clean', 'fun', 'company'];
/* points lost per hour of PLAY */
const DECAY = { fed: 9, rested: 6, clean: 5, fun: 11, company: 8 };
const MAX_STEP_MS = 20 * 60 * 1000;

const WORDS = {
  fed: [[85, 'full'], [60, 'fed'], [35, 'peckish'], [15, 'hungry'], [0, 'hollow']],
  rested: [[85, 'fresh'], [60, 'rested'], [35, 'tired'], [15, 'worn'], [0, 'frayed']],
  clean: [[85, 'scrubbed'], [60, 'clean'], [35, 'rumpled'], [15, 'grubby'], [0, 'ripe']],
  fun: [[85, 'delighted'], [60, 'content'], [35, 'restless'], [15, 'bored'], [0, 'flat']],
  company: [[85, 'surrounded'], [60, 'connected'], [35, 'quiet'], [15, 'lonesome'], [0, 'alone']],
};
const HINTS = {
  fed: 'Food is where the people are: Pat’s, the Taco Window, Ruth-Ann’s stoop, the Truck Stop — or cook at home.',
  rested: 'Sleep somewhere safe — your own bed is best, Mercy and the Kettle keep a corner for anybody.',
  clean: 'A shower at home, a swim off the Pier, or the Salon on Fairlawn Avenue.',
  fun: 'Bowl at the Lanes, fish off Pier Seven, sing at Dez’s, play cards in the Parlor, read at the Archive.',
  company: 'Talk to somebody. Chat, joke, hug. Even the strays count a little.',
};

function fresh() { return { fed: 80, rested: 85, clean: 80, fun: 70, company: 65 }; }

function word(need, v) {
  for (const [floor, w] of WORDS[need]) if (v >= floor) return w;
  return WORDS[need][WORDS[need].length - 1][1];
}

/** Advance decay. Mutates nothing; returns the new needs object and whether anything changed. */
function decayed(life, nowMs = Date.now()) {
  const needs = { ...fresh(), ...(life.needs || {}) };
  const last = life.needsAt || nowMs;
  const dt = clamp(nowMs - last, 0, MAX_STEP_MS);
  if (dt <= 0) return { needs, changed: !life.needs };
  const hours = dt / 3600000;
  for (const n of NEEDS) needs[n] = clamp(Math.round((needs[n] - DECAY[n] * hours) * 10) / 10, 0, 100);
  return { needs, changed: true };
}

function apply(needs, delta) {
  const out = { ...needs };
  for (const [k, v] of Object.entries(delta || {})) if (k in out) out[k] = clamp(Math.round((out[k] + v) * 10) / 10, 0, 100);
  return out;
}

function moodOf(needs) {
  const avg = NEEDS.reduce((s, n) => s + (needs[n] || 0), 0) / NEEDS.length;
  const low = Math.min(...NEEDS.map((n) => needs[n] || 0));
  const score = avg * 0.7 + low * 0.3;
  const label = score >= 80 ? 'glowing' : score >= 60 ? 'good' : score >= 40 ? 'okay' : score >= 22 ? 'low' : 'rough';
  const mult = { glowing: 1.5, good: 1.2, okay: 1, low: 0.75, rough: 0.5 }[label];
  return { score: Math.round(score), label, mult };
}

/** One spoken line for status: only what is worth saying. */
function statusLine(needs) {
  const bits = [];
  for (const n of NEEDS) {
    const v = needs[n];
    if (v < 35) bits.push(`${word(n, v)} (${n} ${Math.round(v)})`);
  }
  const mood = moodOf(needs);
  if (!bits.length) return `You feel ${mood.label}. Nothing is asking for attention.`;
  return `You feel ${mood.label}: ${bits.join(', ')}.`;
}

/** The loudest complaint, for the hint line. */
function worst(needs) {
  let w = null;
  for (const n of NEEDS) if (!w || needs[n] < needs[w]) w = n;
  return w;
}

/** HUD-shaped: every meter as number + word, mood, and the one hint. */
function hud(needs) {
  const m = moodOf(needs);
  const w = worst(needs);
  return {
    meters: NEEDS.map((n) => ({ key: n, value: Math.round(needs[n]), word: word(n, needs[n]) })),
    mood: m.label,
    moodScore: m.score,
    hint: needs[w] < 35 ? HINTS[w] : null,
  };
}

module.exports = { NEEDS, DECAY, fresh, word, decayed, apply, moodOf, statusLine, worst, hud, HINTS };
