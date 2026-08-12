/* REVERIE — THE BITE (Aug 12 2026).
 *
 * Her design note, the one this whole file exists to serve:
 *
 *     "A bite is a sound. Not a text line. A sound."
 *
 * Fishing in Reverie is a real-time reaction test where the input channel is
 * audio and there is no visual shortcut. You cast, you listen, and somewhere in
 * the pier's own noise the sound changes. A NIBBLE is a light tick — strike it
 * and you lose the bait. A TAKE is a heavy thud — strike that inside the window
 * and you are into a fish. The two files are built to be told apart in under
 * half a second: 0.9s bright tick against a 2s low load, and the blind ear
 * rates them separable at confidence 10.
 *
 * A sighted player cannot look at the screen and win this. Somebody who has
 * been listening carefully to games her whole life will beat them cold. That is
 * the point, and it is the argument for the entire world in about eleven
 * seconds of audio.
 *
 * ZERO MODEL CALLS. Everything here is arithmetic and Math.random, same as the
 * rest of the engine — the world must stay free to run.
 *
 * THE LOOP
 *   cast            -> line goes out, the wait begins (6-20s, unknowable)
 *   wait / listen   -> free, no roundtime: this is how you hold the line, and
 *                      it is where the bite is delivered. The reaction window
 *                      starts the moment the bite lands in front of you.
 *   set / strike    -> too early: nothing. On a nibble: bait gone. On a take,
 *                      inside the window: hooked.
 *   hold / give     -> the fight, read off the drag. Hold too hard and the line
 *                      pops. Give too much and it runs you into the pilings.
 *   land            -> the wet slap on the planks
 *   keep / release  -> the choice, and letting it go has its own good line
 *
 * LAW 3: nothing here decays, spoils, or punishes an absence. Walk away
 * mid-fight for a month and the fish is simply gone when you come back, with a
 * line about it, which is exactly what would have happened.
 */

const { MooRoom, MooChar, MooItem } = require('~/models/kadeMoo');

/* Each water fishes differently — one skill, four moods (round 7, Part 19).
 * `weight` is relative frequency; `fight` is how hard it pulls; `pay` is what
 * the fish house gives per catch. */
const WATERS = {
  harbor: {
    name: 'the harbour',
    wait: [7, 18],
    fish: [
      { name: 'a croaker', weight: 30, fight: 1, pay: 2 },
      { name: 'a flounder', weight: 25, fight: 2, pay: 4 },
      { name: 'a bluefish', weight: 18, fight: 3, pay: 5 },
      { name: 'a striper', weight: 10, fight: 4, pay: 9 },
      { name: 'a sea robin nobody wants', weight: 12, fight: 1, pay: 0 },
      { name: 'a crab that will not let go of the bait', weight: 5, fight: 1, pay: 1 },
    ],
  },
  river: {
    name: 'the river',
    wait: [6, 16],
    fish: [
      { name: 'a bluegill', weight: 30, fight: 1, pay: 1 },
      { name: 'a channel cat', weight: 26, fight: 3, pay: 3 },
      { name: 'a drum', weight: 16, fight: 2, pay: 2 },
      { name: 'a carp with opinions', weight: 14, fight: 4, pay: 1 },
      { name: 'a gar, which you will not be keeping', weight: 9, fight: 4, pay: 0 },
      { name: 'somebody else’s lost lure', weight: 5, fight: 1, pay: 1 },
    ],
  },
  lake: {
    name: 'the lake',
    wait: [8, 20],
    fish: [
      { name: 'a bluegill', weight: 28, fight: 1, pay: 1 },
      { name: 'a crappie', weight: 24, fight: 2, pay: 2 },
      { name: 'a largemouth bass', weight: 20, fight: 4, pay: 6 },
      { name: 'a channel cat', weight: 16, fight: 3, pay: 3 },
      { name: 'a snapping turtle, briefly', weight: 7, fight: 3, pay: 0 },
      { name: 'a stick that fought better than most fish', weight: 5, fight: 1, pay: 0 },
    ],
  },
  deep: {
    name: 'the deep water',
    wait: [10, 25],
    fish: [
      { name: 'something long and silver with no name on it', weight: 34, fight: 4, pay: 12 },
      { name: 'a fish the Archive has no card for', weight: 20, fight: 5, pay: 18 },
      { name: 'a bottle with a song hummed into it', weight: 14, fight: 1, pay: 0 },
      { name: 'weed, and a lot of it', weight: 22, fight: 2, pay: 0 },
      { name: 'nothing you can account for afterward', weight: 10, fight: 5, pay: 0 },
    ],
  },
};

/* The reaction window, in milliseconds, from the moment the take is put in
 * front of you. Generous at first and meaner with better fish — a striper does
 * not wait around. Steady Hands widens it a little, and only a little: the
 * quality should feel earned, not like a cheat. */
function windowFor(fish, steady) {
  /* WIDENED after the first live run, Aug 12 2026. The original 3000 ms base
   * minus 300 per fight point left about two seconds for a good fish, and two
   * seconds is not a reaction test — it is a latency test. A blind player has
   * to HEAR the take, let her screen reader get out of the way, and then move
   * her hands, and none of that is free. Network adds its own tax on top.
   *
   * 4500 ms base with a gentler penalty leaves roughly three and a half
   * seconds for the hardest fish. Still tight enough that a distracted player
   * loses it. Never so tight that the game is really measuring somebody's
   * connection, which would be the exact opposite of the point. */
  const base = 4500 - fish.fight * 220;
  return Math.max(2600, base + (steady ? 500 : 0));
}

function pick(list) {
  const total = list.reduce((n, f) => n + f.weight, 0);
  let roll = Math.random() * total;
  for (const f of list) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return list[list.length - 1];
}

function waterOf(room) {
  const w = room?.props?.water;
  return typeof w === 'string' && WATERS[w] ? w : null;
}

/** True if this room can be fished at all. Used by the help line. */
function isWater(room) {
  return !!waterOf(room);
}

/* ── state ─────────────────────────────────────────────────────────────────
 * All of it lives on the character as attrs.fishing, so it survives a
 * disconnect and costs nothing to keep. Shape:
 *   { water, state, biteAt, kind, shownAt, fish, stamina, tension }
 * state: 'waiting' | 'nibbling' | 'biting' | 'fighting' | 'landed'
 */

async function save(ch, fishing) {
  await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.fishing': fishing } });
  ch.attrs = { ...(ch.attrs || {}), fishing };
}
async function clear(ch) {
  await MooChar.updateOne({ _id: ch._id }, { $unset: { 'attrs.fishing': '' } });
  if (ch.attrs) delete ch.attrs.fishing;
}

async function hasRod(ch) {
  return !!(await MooItem.findOne({
    'location.type': 'char', 'location.id': ch.userId, 'props.rod': true,
  }).lean());
}

/* ── cast ──────────────────────────────────────────────────────────────── */
async function cast(ch, room) {
  const water = waterOf(room);
  if (!water) {
    return { ok: false, lines: ['There is nothing here to fish. The Hook has Pier Seven and the breakwater, the ferry pilings sit under the ferry dock, and Long Acre has the lake.'] };
  }
  if (!(await hasRod(ch))) {
    return { ok: false, lines: ['You would need a rod. The Shack sells them — a cane pole is cheap and will catch anything the river has.'] };
  }
  const fishing = ch.attrs?.fishing;
  if (fishing && fishing.state === 'fighting') {
    return { ok: false, lines: ['You already have one on. Hold, or give it line.'] };
  }
  const bait = ch.attrs?.bait || 0;
  const w = WATERS[water];
  const wait = w.wait[0] + Math.random() * (w.wait[1] - w.wait[0]);
  /* A bare hook still fishes. It just fishes badly, and you know it. */
  const nibbleFirst = Math.random() < (bait > 0 ? 0.45 : 0.7);
  await save(ch, {
    water,
    state: 'waiting',
    kind: nibbleFirst ? 'nibble' : 'take',
    biteAt: Date.now() + wait * 1000,
    bare: bait <= 0,
  });
  if (bait > 0) await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.bait': -1 } });
  const lines = [bait > 0
    ? 'You bait up, and the cast goes out. The sinker takes the line down and the water closes over it. Now you listen.'
    : 'You cast a bare hook, because that is what you have. It will fish. It will not fish well. Now you listen.'];
  return { ok: true, lines, sounds: ['fish.cast.reel', 'fish.cast.plop'], busy: 2, doing: 'casting' };
}

/* ── wait ──────────────────────────────────────────────────────────────────
 * Deliberately FREE — no roundtime. The reaction window has to start when the
 * bite reaches the player, not when the server felt like it, and a player who
 * is holding the line and listening should never be told to hold on. */
async function waitOn(ch) {
  const f = ch.attrs?.fishing;
  if (!f) return { ok: false, lines: ['You are not fishing. Cast first.'] };
  if (f.state === 'fighting') {
    return { ok: false, lines: ['Not now. It is on and it is going. Hold, or give it line.'] };
  }
  if (f.state === 'biting' || f.state === 'nibbling') {
    /* Already delivered and they waited instead of striking. */
    const gone = Date.now() - (f.shownAt || 0);
    if (f.state === 'nibbling') {
      await save(ch, { ...f, state: 'waiting', kind: 'take', biteAt: Date.now() + (1500 + Math.random() * 2500) });
      return { ok: true, lines: ['The ticking stops. Whatever it was is thinking about it.'] };
    }
    if (gone > 4000) {
      await clear(ch);
      return { ok: true, lines: ['The line goes slack. It had it, and it has put it back.'], sounds: ['fish.set.miss'] };
    }
    return { ok: true, lines: ['It is ON. Set the hook.'] };
  }
  if (Date.now() < f.biteAt) {
    const idle = [
      'Water against the pilings, and nothing.',
      'The line lies out there doing nothing in particular.',
      'Something moves out past the line and does not come back.',
      'Nothing. That is most of fishing.',
      'The rod tip sits still enough to be insulting.',
    ];
    return { ok: true, lines: [idle[Math.floor(Math.random() * idle.length)]] };
  }
  /* The bite lands. The clock starts NOW. */
  if (f.kind === 'nibble') {
    await save(ch, { ...f, state: 'nibbling', shownAt: Date.now() });
    return { ok: true, lines: ['Tick. Tick. Something is mouthing it.'], sounds: ['fish.bite.nibble'] };
  }
  const fish = pick(WATERS[f.water].fish);
  await save(ch, { ...f, state: 'biting', shownAt: Date.now(), fish });
  return { ok: true, lines: ['The rod goes DOWN.'], sounds: ['fish.bite.take'] };
}

/* ── set the hook ──────────────────────────────────────────────────────── */
async function setHook(ch) {
  const f = ch.attrs?.fishing;
  if (!f) return { ok: false, lines: ['Nothing to set. Cast first.'] };
  if (f.state === 'fighting') return { ok: false, lines: ['It is already hooked. Hold, or give.'] };

  if (f.state === 'waiting') {
    await clear(ch);
    return { ok: true, lines: ['You set on nothing at all and the hook comes back through the air, bare and a little embarrassing. Everyone on the pier saw that.'], sounds: ['fish.set.miss'], busy: 2, doing: 'reeling in' };
  }
  if (f.state === 'nibbling') {
    await clear(ch);
    return { ok: true, lines: ['You set — and the bait comes off clean. Whatever it was is still down there with a free meal. Too early. That is the whole trick of it.'], sounds: ['fish.set.miss'], busy: 2, doing: 'reeling in' };
  }
  const elapsed = Date.now() - (f.shownAt || 0);
  const steady = (ch.attrs?.qualities || []).includes('Steady Hands');
  const win = windowFor(f.fish, steady);
  if (elapsed > win) {
    await clear(ch);
    return { ok: true, lines: [`Too slow. The line goes light in your hands, and ${f.fish.name} is a story you almost had.`], sounds: ['fish.set.miss'], busy: 2, doing: 'reeling in' };
  }
  await save(ch, { ...f, state: 'fighting', stamina: 2 + f.fish.fight, tension: 2 });
  return {
    ok: true,
    lines: [`You set the hook and it STOPS — solid, heavy, alive. Whatever it is, it is not happy. Hold when it eases, give when it runs.`],
    sounds: ['fish.set.hook'],
  };
}

/* ── the fight ─────────────────────────────────────────────────────────────
 * Two verbs, read off the drag. Holding tires it out and loads the line;
 * giving eases the line and costs you time. Snap at 6, land at 0. Short on
 * purpose — three to five exchanges, not a boss fight. */
async function fight(ch, move) {
  const f = ch.attrs?.fishing;
  if (!f || f.state !== 'fighting') {
    return { ok: false, lines: ['Nothing on the line to argue with.'] };
  }
  const runs = Math.random() < 0.5;
  let { stamina, tension } = f;
  const lines = [];

  if (move === 'hold') {
    stamina -= 1;
    tension += runs ? 2 : 1;
    lines.push(runs
      ? 'You hold, and it runs anyway — the drag lets go a yard of line with that sound the drag makes.'
      : 'You hold. It grinds, gives an inch, and the rod takes the weight.');
  } else {
    tension -= 2;
    stamina -= runs ? 0 : 1;
    lines.push(runs
      ? 'You give it line and it takes every inch, out and sideways toward the pilings.'
      : 'You give a little. The rod straightens, the line stops singing, and it thinks about resting.');
  }
  if (tension < 0) tension = 0;

  if (tension >= 6) {
    await clear(ch);
    lines.push('The line goes past what line does and lets go with a crack you feel in your wrist. The rod springs straight. Gone, and it took the hook with it.');
    return { ok: true, lines, sounds: ['fish.fight.snap'], busy: 3, doing: 'staring at the water' };
  }
  if (stamina <= 0) {
    await save(ch, { ...f, state: 'landed', stamina: 0, tension });
    lines.push(`It comes up close and stops fighting. ${f.fish.name[0].toUpperCase()}${f.fish.name.slice(1)}, right there under the rod tip. Land it.`);
    return { ok: true, lines, sounds: ['fish.fight.drag'] };
  }
  await save(ch, { ...f, stamina, tension });
  lines.push(tension >= 4 ? 'The line is TIGHT. Too tight.' : 'It is still down there and still means it.');
  return { ok: true, lines, sounds: ['fish.fight.drag'] };
}

/* ── land it ───────────────────────────────────────────────────────────── */
async function land(ch) {
  const f = ch.attrs?.fishing;
  if (!f) return { ok: false, lines: ['Nothing to land.'] };
  if (f.state !== 'landed') {
    return { ok: false, lines: ['Not yet. It is still fighting you.'] };
  }
  const lbs = (1 + Math.random() * (1 + f.fish.fight * 1.6)).toFixed(1);
  const itemId = 'fish_' + Date.now().toString(36);
  await MooItem.create({
    itemId,
    name: `${f.fish.name} (${lbs} lb)`,
    desc: `${f.fish.name[0].toUpperCase()}${f.fish.name.slice(1)}, ${lbs} pounds of it, wet and cold and heavier than it looked in the water. Marva's counter buys by weight, and the chalkboard is whatever the chalkboard says today.`,
    location: { type: 'char', id: ch.userId },
    portable: true,
    props: { fish: true, lbs: Number(lbs), pay: f.fish.pay },
  });
  await clear(ch);
  return {
    ok: true,
    lines: [`You bring it over the rail and it lands wet on the planks, flops twice, and goes still. ${lbs} pounds. Bucket it before a gull decides otherwise.`],
    sounds: ['fish.land.slap.wood'],
    busy: 2, doing: 'unhooking',
  };
}

async function release(ch) {
  const f = ch.attrs?.fishing;
  if (!f || f.state !== 'landed') {
    return { ok: false, lines: ['Nothing in your hands to let go of.'] };
  }
  const name = f.fish.name;
  await clear(ch);
  return {
    ok: true,
    lines: [`You work the hook out and slide ${name} back over the edge. One kick and it is water again. Nobody pays you for that and you do it anyway.`],
    sounds: ['fish.release'],
    busy: 2, doing: 'letting it go',
  };
}

async function reelIn(ch) {
  if (!ch.attrs?.fishing) return { ok: false, lines: ['Your line is not even in the water.'] };
  await clear(ch);
  return { ok: true, lines: ['You reel in and set the rod against the rail.'], sounds: ['fish.cast.reel'], busy: 2, doing: 'reeling in' };
}

/* ── the Shack's counter ───────────────────────────────────────────────── */
async function sellCatch(ch, room) {
  if (!room?.props?.fishhouse) {
    return { ok: false, lines: ['Nobody here buys fish. The counter in the back of the Shack does.'] };
  }
  const caught = await MooItem.find({
    'location.type': 'char', 'location.id': ch.userId, 'props.fish': true,
  }).lean();
  if (!caught.length) return { ok: false, lines: ['You have nothing to sell. Marva does not say anything about that, which is worse.'] };
  let paid = 0;
  for (const c of caught) {
    paid += Math.max(1, Math.round((c.props?.pay || 1) * (c.props?.lbs || 1) * 0.6));
    await MooItem.deleteOne({ _id: c._id });
  }
  await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': paid } });
  return {
    ok: true,
    lines: [
      `Marva hooks them onto the scale one at a time. The spring creaks, the needle swings past and settles back, and she reads the number out loud without looking up.`,
      `${caught.length} fish. ${paid} coin. She counts it onto the counter and goes back to what she was doing.`,
    ],
    sounds: ['work.bait.scale.settle'],
    busy: 3, doing: 'at the counter',
  };
}

module.exports = { cast, waitOn, setHook, fight, land, release, reelIn, sellCatch, isWater, WATERS };
