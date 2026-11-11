/**
 * ONE FACT, ONCE PER TURN (Nov 10 2026, plan item N5).
 *
 * A turn can carry the same fact in the pinned cards (the cached head), in the
 * relationship summary (the head too), in a recalled card and in a logbook line
 * (both in the tail). The model then meets it up to four times, and it reads as
 * the thing to bring up. This drops a recalled card or a logbook line when what
 * it says is already in front of the model this turn.
 *
 * What was already there before this file: a pinned card is never recalled as
 * itself (same key), and logbook lines are de-duplicated against each other by
 * exact text. What this adds is DIFFERENT records saying the same thing.
 *
 * The rule is deliberately tight, because the summary has no vector and word
 * overlap can throw away a true, separate fact:
 *   - the line needs at least MIN_WORDS distinct content words;
 *   - ALL of them (KADE_RECALL_ONE_FACT_OVERLAP, default 1; build two review: at 0.8
 *     one word could differ, and that word was often the news, "Friday" against
 *     the summary's "Thursday") must be in ONE pinned card, or in one sentence of
 *     the summary or two that touch;
 *   - "not", "no", "never" and the like are content words, so "decided not to
 *     take the job" is never the same as "decided to take the job";
 *   - every number in the line (a date, an age, a price, a time) must be in
 *     that same place. A line with a number the head does not carry is kept:
 *     the number is the news.
 * Nothing is deleted from memory. A dropped line is only left out of this
 * turn's tail.
 *
 * No model, no network, no database: plain string work on text this turn has
 * already loaded. Off: KADE_RECALL_ONE_FACT=0.
 */
'use strict';

const STOP = new Set(
  ('the a an and or but so to of in on at for with is it its i you me my your we our us that this was were be been are am do did does ' +
    'yes just like really oh ok okay well he she they them his her their what when where who how why there here ' +
    'then than too very can could would should will im youre thats got get one all some any ' +
    'about from out up down off over into have has had also still now says said told tells').split(' '),
);

/* A negation changes the fact. Each counts as the one content word "not" (short ones included). */
const NEGATION = new Set(
  'not no never none cant cannot wont dont didnt doesnt isnt wasnt arent werent havent hasnt hadnt wouldnt couldnt shouldnt nobody nothing neither nor'.split(' '),
);

const MIN_WORDS = 4;

function enabled(env = process.env) {
  return env.KADE_RECALL_ONE_FACT !== '0';
}

function overlapNeeded(env = process.env) {
  const v = parseFloat(env.KADE_RECALL_ONE_FACT_OVERLAP);
  return Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : 1;
}

/** Light stemming, so "walks" meets "walk" and "moved" meets "move". Never used for display. */
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Distinct content words of a text, lower-cased and lightly stemmed. */
function contentWords(text) {
  const found = String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .match(/[a-z][a-z']*/g);
  const out = new Set();
  for (const raw of found || []) {
    const w = raw.replace(/'s$/, '').replace(/'/g, '');
    if (NEGATION.has(w)) out.add('not');
    else if (w.length > 2 && !STOP.has(w)) out.add(stem(w));
  }
  return out;
}

/** Every number in a text, as written ("27", "3:30", "2026"). */
function numbers(text) {
  return new Set(String(text || '').match(/\d+(?:[:.]\d+)*/g) || []);
}

/** The line as the model sees it, without the "- [2026-11-03] " lead or a secondhand note. */
function bare(line) {
  return String(line || '')
    .replace(/^\s*-\s*/, '')
    .replace(/^\[[^\]]{0,40}\]\s*/, '')
    .replace(/^\[from (?:her|their|his) talks with [^\]]+\]\s*/i, '')
    .replace(/\s*\((?:secondhand|reminder fires|this plan's date)[^)]*\)\s*$/i, '')
    .trim();
}

/**
 * Break the head text into the places a fact can already be: each pinned card
 * whole, and each summary sentence alone and joined to the next one.
 * @param {{ pinned?: string[], summary?: string }} head
 * @returns {{ words: Set<string>, nums: Set<string> }[]}
 */
function headPlaces({ pinned = [], summary = '' } = {}) {
  const places = [];
  const add = (text) => {
    const words = contentWords(text);
    if (words.size) places.push({ words, nums: numbers(text) });
  };
  for (const card of pinned || []) add(card);
  const sentences = String(summary || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  sentences.forEach((s, i) => {
    add(s);
    if (i + 1 < sentences.length) add(`${s} ${sentences[i + 1]}`);
  });
  return places;
}

/**
 * Does one of these places already say what this line says? Pure.
 * @param {string} line a recalled card or logbook line
 * @param {{ words: Set<string>, nums: Set<string> }[]} places from headPlaces()
 * @param {number} [need] share of the line's content words that must be found
 */
function alreadySaid(line, places, need = overlapNeeded()) {
  const text = bare(line);
  const words = contentWords(text);
  if (words.size < MIN_WORDS || !places || !places.length) return false;
  const nums = numbers(text);
  for (const place of places) {
    let hit = 0;
    for (const w of words) if (place.words.has(w)) hit += 1;
    if (hit / words.size < need) continue;
    let numbersHeld = true;
    for (const n of nums) {
      if (!place.nums.has(n)) {
        numbersHeld = false;
        break;
      }
    }
    if (numbersHeld) return true;
  }
  return false;
}

/**
 * Keep the lines that add something. Order is kept. Pure.
 * @param {string[]} lines
 * @param {{ pinned?: string[], summary?: string }} head
 * @returns {{ kept: string[], dropped: number, keptIndex: number[] }}
 */
function dropRepeats(lines, head, env = process.env) {
  const list = Array.isArray(lines) ? lines : [];
  const all = { kept: list.slice(), dropped: 0, keptIndex: list.map((_, i) => i) };
  if (!enabled(env) || !list.length) return all;
  const places = headPlaces(head);
  if (!places.length) return all;
  const need = overlapNeeded(env);
  const kept = [];
  const keptIndex = [];
  list.forEach((line, i) => {
    if (alreadySaid(line, places, need)) return;
    kept.push(line);
    keptIndex.push(i);
  });
  return { kept, dropped: list.length - kept.length, keptIndex };
}

/**
 * Hold a promise and say, without waiting, whether it has an answer yet. Recall
 * starts the summary read before its embed wait and looks at it afterwards: a
 * read that is not back by then is simply not used, so this can never add a
 * wait before a reply.
 * @template T
 * @param {Promise<T>} promise
 * @returns {{ peek: () => T | undefined }}
 */
function peekable(promise) {
  let value;
  let settled = false;
  Promise.resolve(promise).then(
    (v) => {
      value = v;
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { peek: () => (settled ? value : undefined) };
}

module.exports = { enabled, overlapNeeded, contentWords, numbers, bare, headPlaces, alreadySaid, dropRepeats, peekable, MIN_WORDS };
