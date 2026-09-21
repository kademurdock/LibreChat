/* THE ERRANDS — why anybody is ever in the same room as anybody else.
 *
 * KADE, Sep 21 2026: "these are regular sitezens going about the day on the
 * platform, but it's alike a tree falling and nobody being around to hear it
 * [...] when people do connect, I want there to be other players too."
 *
 * THE MEASUREMENT THAT ORDERED THIS FILE. The city has 61 rooms and 26
 * citizens, and their authored schedules are not schedules — they are POSTS.
 * Thirteen of the twenty-six never leave one room in their lives. Pat Harris
 * and Doc have a single slot each, `from: 0, to: 24`, so they have stood at
 * the same counter every hour of every day since the carve. Nobody eats out.
 * Nobody goes home. Nobody visits anybody.
 *
 * Walked across an hour, that gives:
 *
 *     rooms with anybody in them at all ....... 23 of 61
 *     of those, rooms holding exactly ONE ..... 20
 *     the busiest room in the city, ever ...... 4 (Pat's, seven in the evening)
 *
 * So the city is 62% empty, and seven-eighths of what is left is one person
 * standing on their own. You cannot walk in on a conversation, because there
 * is almost nowhere in Reverie where two people are. That is the tree falling
 * with nobody around, and no amount of better dialogue fixes it: a room with
 * one person in it has no social life to overhear.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO. It does not rewrite one line of
 * her schedules. The authored day is the backbone and stays exactly as
 * written; this adds two hours to it, the two hours everybody in a real town
 * has — you eat somewhere in the middle of the day, and you are somewhere
 * with people in the evening.
 *
 * Deterministic, pure, and free. Same citizen, same day, same errand, in every
 * process and on every reload, hashed from the id and the date. No model, no
 * dice, no database: the referee is still code, which is the law of this world
 * and the reason `npcDoingNow` can keep being a pure function that anything is
 * allowed to call in a loop.
 *
 * Destinations lean hard on the few rooms a town actually gathers in, and lean
 * harder still toward wherever somebody they already know is posted, because
 * the point is not to scatter people evenly — it is to put them together.
 */

/* The rooms this city gathers in, with the hours they are worth being in and
 * the weight of how likely somebody is to pick one. Every roomId here was
 * checked against CITY_ROOMS. `open` wraps midnight when from > to. */
const HANGOUTS = [
  { room: 'pats_diner', from: 5, to: 24, weight: 5, doing: 'holding a stool with a coffee', meal: true },
  { room: 'ruth_anns_stoop', from: 9, to: 22, weight: 4, doing: 'up on the stoop, talking' },
  { room: 'dezs_bar', from: 17, to: 3, weight: 4, doing: 'nursing one and listening' },
  { room: 'the_kettle', from: 8, to: 21, weight: 3, doing: 'over a cup of tea', meal: true },
  { room: 'levis_chairs', from: 9, to: 19, weight: 3, doing: 'waiting a turn in the chair' },
  { room: 'corner_store', from: 7, to: 23, weight: 2, doing: 'picking up a few things', meal: true },
  { room: 'game_parlor', from: 12, to: 4, weight: 2, doing: 'watching a game go badly' },
  { room: 'union_hall', from: 7, to: 19, weight: 2, doing: 'on the steps, in no hurry' },
  { room: 'fish_market', from: 5, to: 13, weight: 2, doing: 'arguing about the price of fish', meal: true },
  { room: 'taco_window', from: 21, to: 4, weight: 2, doing: 'in the line at the window', meal: true },
];
const HANGOUT_ROOMS = new Set(HANGOUTS.map((h) => h.room));

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function isOpen(h, hour) {
  return h.from <= h.to ? hour >= h.from && hour < h.to : hour >= h.from || hour < h.to;
}

/** The three hours a day this person is not at their post: a morning one, a
 *  middle-of-the-day one and an evening one, each an hour long and each the
 *  same for the whole of that day.
 *
 *  Three was arrived at by measuring, not by taste. Two left nine o'clock in
 *  the morning as the emptiest hour in the city -- 15% of citizens with
 *  anybody, worse than three in the morning -- because both windows sat after
 *  eleven. Three hours out of twenty-four is still less time away from your
 *  post than any real person spends. */
function windowsFor(npcId, dayKey) {
  return {
    morning: 7 + (hash(`${npcId}|${dayKey}|morning`) % 4),   /* 7 through 10 */
    meal: 11 + (hash(`${npcId}|${dayKey}|meal`) % 6),        /* 11 through 16 */
    evening: 17 + (hash(`${npcId}|${dayKey}|evening`) % 6),  /* 17 through 22 */
  };
}

/** Where the authored schedule has somebody at this hour. Given rather than
 *  looked up so this file never reaches back into reverie.js. */
function postedAt(def, hour) {
  for (const s of def.schedule || []) {
    const inSlot = s.from <= s.to ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to;
    if (inSlot) return s.room;
  }
  return def.home;
}

/**
 * Where this citizen is spending their errand hour, or null for "at their post
 * like always".
 *
 * @param {string} npcId    'npc:pat'
 * @param {object} def      their census row
 * @param {object} t        { h, dayKey }
 * @param {object} census   CENSUS_BY_ID, for finding where a friend is posted
 */
function errandFor(npcId, def, t, census = {}) {
  if (!def || !def.schedule) return null;
  const w = windowsFor(npcId, t.dayKey);
  const which = t.h === w.morning ? 'morning' : t.h === w.meal ? 'meal' : t.h === w.evening ? 'evening' : null;
  if (!which) return null;

  const post = postedAt(def, t.h);
  /* Somebody whose own day already has them somewhere sociable is not sent
   * anywhere. Dez is at Dez's; that IS the evening. */
  if (HANGOUT_ROOMS.has(post)) return null;

  /* Morning and midday are for somewhere that feeds you; the evening is for
   * anywhere people are. */
  const eating = which === 'morning' || which === 'meal';
  const open = HANGOUTS.filter((h) => isOpen(h, t.h) && h.room !== post && (!eating || h.meal || h.weight >= 4));
  if (!open.length) return null;

  /* Their own people first. If anybody they know or are related to is posted
   * at one of these rooms this hour, that is where they go, because the whole
   * purpose of the errand is to put two people in one room. */
  const theirs = [];
  for (const other of [...(def.family || []), ...(def.knows || [])]) {
    const od = census['npc:' + other] || census[other];
    if (!od) continue;
    const there = postedAt(od, t.h);
    const spot = open.find((h) => h.room === there);
    if (spot) theirs.push({ spot, name: (od.aka || od.name || '').split(' ')[0] });
  }
  const seed = hash(`${npcId}|${t.dayKey}|${which}|where`);
  if (theirs.length) {
    const pick = theirs[seed % theirs.length];
    return { room: pick.spot.room, doing: `${pick.spot.doing}, catching up with ${pick.name}` };
  }

  /* Otherwise a weighted pick, so the town gathers where a town gathers
   * instead of spreading one person evenly over ten rooms. */
  const total = open.reduce((a, h) => a + h.weight, 0);
  let n = seed % total;
  for (const h of open) {
    n -= h.weight;
    if (n < 0) return { room: h.room, doing: h.doing };
  }
  return { room: open[0].room, doing: open[0].doing };
}

module.exports = { errandFor, windowsFor, postedAt, isOpen, HANGOUTS, HANGOUT_ROOMS, hash };
