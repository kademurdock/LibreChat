/* ── THE STRAYS (2026-08-13, round 9 — rebuilt) ────────────────────────────
 *
 * REBUILD NOTE. A previous session wrote this system, wrote a ledger entry
 * claiming commit e52c25b, and never pushed. The commit does not exist on the
 * kade branch and never did. What follows is rebuilt from that entry's spec,
 * which was detailed enough to rebuild faithfully — including its tuned
 * numbers, which are honoured here and re-verified by simulation rather than
 * taken on trust. That is the whole lesson of the entry sitting directly
 * above it in the ledger.
 *
 * HER RULING, and the reason none of this lives in MooItem:
 *   "a player char is a player char whether you're controlling it or I am."
 * The strays are MooChars. Same table as Pat. Same table as you. A char is a
 * char. This costs nothing and it means every system that already understands
 * a person in a room — look, who, the room chord, overhearing — understands an
 * animal for free, and none of them had to be told about animals.
 *
 * WHAT A STRAY IS, mechanically: a char that DRIFTS inside a territory instead
 * of running a schedule. The census has schedules because people have jobs. A
 * stray has a patch of the city it is usually in and no reason to be anywhere
 * at any particular hour, and modelling that as a schedule would have made it
 * a very small employee.
 *
 * TRUST IS PER-PERSON AND IT NEVER SHOWS A NUMBER. The cat that trusts you
 * does not trust your friend, and neither of you is ever told 62. You are told
 * what the animal does when you move, and you learn to read it. The rungs
 * below are graded so the step between two of them is audible in the sentence.
 */

/* ── THE SEVEN ─────────────────────────────────────────────────────────────
 * No stray has a name. A name costs one of yours to spend, and spending it is
 * the adoption. Until then the world calls it what you would call it: the
 * gray one, the dog with the bad ear. */
const STRAYS = [
  {
    id: 'gray_cat', species: 'cat', temper: 'skittish',
    name: 'a gray cat, thin through the ribs',
    short: 'gray cat',
    desc: 'Thin through the ribs in a way that is not starvation and not health either. Gray the color of a sidewalk after rain. It has worked out which doorways are warm and it does not intend to explain the list to you.',
    territory: ['hook_front_street', 'the_docks', 'coldpipe_alley', 'fish_market', 'the_stairs'],
  },
  {
    id: 'brown_dog', species: 'dog', temper: 'friendly',
    name: 'a brown dog with a bad ear',
    short: 'brown dog',
    desc: 'Brown all over, with one ear that folds wrong and has folded wrong long enough that it is simply the shape of the ear now. Carries itself like somebody who has never once been hit, which in this ward is either luck or Ruth-Ann.',
    territory: ['patch_gully_road', 'ruth_anns_stoop', 'the_stairs', 'patch_payphone'],
  },
  {
    id: 'orange_tom', species: 'cat', temper: 'bold',
    name: 'a large orange tomcat',
    short: 'orange tomcat',
    desc: 'Large in the way of an animal nobody has ever successfully told no. Orange, notched about the face, and entirely convinced that Line Street is a thing that happens on his floor.',
    territory: ['tanglefoot_line_street', 'pawn_hocks', 'taco_window', 'game_parlor'],
  },
  {
    id: 'black_dog', species: 'dog', temper: 'wary',
    name: 'a small black dog favoring one leg',
    short: 'black dog',
    desc: 'Small and black and putting less weight on the back left than on the other three. The limp is old and settled. It watches hands, not faces, which tells you something you would rather not know.',
    territory: ['millrace_channel', 'the_garages', 'salvage_yard', 'ring_road'],
  },
  {
    id: 'calico', species: 'cat', temper: 'wary',
    name: 'a calico cat with a torn ear',
    short: 'calico',
    desc: 'Three colors and a left ear that ends early. Sits where it can see two exits. Has opinions about the garden plots that the garden plots are unaware of.',
    territory: ['sweetwater_park', 'garden_plots', 'fairlawn_ave', 'wishing_fountain'],
  },
  {
    id: 'yellow_dog', species: 'dog', temper: 'skittish',
    name: 'a yellow dog that keeps its distance',
    short: 'yellow dog',
    desc: 'Yellow, rangy, and always about forty feet away. Follows the trucks out and follows them back. Has never let a person finish walking toward it and does not plan to start today.',
    territory: ['long_acre_fields', 'the_truck_stop', 'the_airfield', 'ring_road'],
  },
  {
    id: 'smoke_cat', species: 'cat', temper: 'bold',
    name: 'a cat the color of old smoke',
    short: 'smoke cat',
    desc: 'The exact gray of a lantern chimney nobody has cleaned. Walks the Gravewalk like staff. The teahouse feeds it and pretends not to, and it accepts the pretense as its due.',
    territory: ['gravewalk_lanterns', 'gravewalk_teahouse', 'gravewalk_switchboard'],
  },
];
const STRAY_BY_ID = Object.fromEntries(STRAYS.map((s) => ['stray:' + s.id, s]));

/* ── THE SHELTER ───────────────────────────────────────────────────────────
 * No new room was carved, because Opal's Lost & Found already WAS this. The
 * line was written for her months before the system existed:
 *   "lost dog, found dog, same drawer."
 * When the fiction already says it, building a second place to say it again is
 * how a world gets bloated instead of deep. */
const SHELTER_ROOM = 'bureau_small_complaints';
const SURRENDER_PAYS = 3;
const ADOPT_COSTS = 15;

/* ── TRUST ─────────────────────────────────────────────────────────────────
 *
 * THE NUMBERS ARE MEASURED, NOT GUESSED — and this is the second time, because
 * the first set was invented and was bad. From the spec: a skittish cat took
 * ~115 patient approaches and could NEVER be rushed into it at all. That is a
 * wall, not a patience mechanic. Re-tuned against 800-run sims per temper.
 *
 * Targets, approaches-to-carry, patient / with-food / rushed:
 *     bold      4  /  2  /  4
 *     friendly  8  /  3  /  9
 *     wary     16  /  4  / 26
 *     skittish 24  /  6  / 48
 *
 * The three properties those numbers exist to guarantee:
 *   · PATIENCE ALWAYS WORKS. Every temper is reachable by simply coming back.
 *   · FOOD IS ROUGHLY FOUR TIMES FASTER, and it is the thing a person works
 *     out on their own, which is the best kind of mechanic there is.
 *   · RUSHING COSTS, BUT NEVER FORBIDS. Doubling the work is a lesson. A wall
 *     is a bug wearing a lesson's clothes.
 *
 * Gains are derived from the targets rather than typed in, so the targets stay
 * the thing anybody edits and the arithmetic can't drift away from them.
 * `verifyTuning()` at the bottom re-derives them by simulation. */
const CARRY_AT = 100;
const TARGETS = {
  bold: { patient: 4, food: 2, rushed: 4 },
  friendly: { patient: 8, food: 3, rushed: 9 },
  wary: { patient: 16, food: 4, rushed: 26 },
  skittish: { patient: 24, food: 6, rushed: 48 },
};
/* The half-step. Trust has to EXCEED the threshold, not reach it, so a naive
 * CARRY_AT/target lands the measured mean half an approach above the target
 * every time — the last approach always overshoots, by half a step on average.
 * First pass shipped that: every temper measured target+0.5, and 4.5 is not
 * what the ledger promises when it says 4. Deriving against (target - 0.5)
 * makes the printed number the number a player actually experiences. */
const GAIN = Object.fromEntries(Object.entries(TARGETS).map(([t, v]) => [t, {
  patient: CARRY_AT / (v.patient - 0.5),
  food: CARRY_AT / (v.food - 0.5),
  rushed: CARRY_AT / (v.rushed - 0.5),
}]));

/** An approach is PATIENT if you gave the animal room since the last one.
 *  Ninety seconds is long enough that repeat-mashing is a choice and short
 *  enough that it is not homework. */
const PATIENCE_MS = 90 * 1000;

/** Bolt chance when you rush it. A bolt costs you the animal's company, not
 *  its trust — you have to go find it again. Time is the punishment; the
 *  relationship is not damaged, because a real animal that gets startled does
 *  not conclude you are a bad person, it concludes you are fast. */
const BOLT_CHANCE = { bold: 0.05, friendly: 0.15, wary: 0.35, skittish: 0.5 };

/** ±18% jitter. The mean is what the targets promise; the spread is what
 *  keeps two players from comparing notes and finding an integer. */
function jitter(rng) {
  return 0.82 + (rng ? rng() : Math.random()) * 0.36;
}

/**
 * One interaction's trust gain.
 * @returns {{ gain:number, patient:boolean, bolted:boolean }}
 */
function trustGain(temper, { withFood = false, sinceLastMs = Infinity, rng = Math.random } = {}) {
  const g = GAIN[temper] || GAIN.wary;
  const patient = sinceLastMs >= PATIENCE_MS;
  if (withFood) {
    /* Food short-circuits patience. Holding out something it wants is its own
     * argument and the animal does not care how long you waited to make it. */
    return { gain: g.food * jitter(rng), patient: true, bolted: false };
  }
  if (patient) return { gain: g.patient * jitter(rng), patient: true, bolted: false };
  const bolted = rng() < (BOLT_CHANCE[temper] || 0.3);
  return { gain: g.rushed * jitter(rng), patient: false, bolted };
}

/* ── THE MOOD LADDER ───────────────────────────────────────────────────────
 * Six rungs. The step between any two is meant to be audible in the sentence
 * — you should be able to tell you moved without being told a number, and a
 * player who has never seen the source should be able to describe the ladder
 * back to you after an afternoon. */
const RUNGS = [
  { at: 0, key: 'gone' },
  { at: 15, key: 'watching' },
  { at: 35, key: 'tolerating' },
  { at: 55, key: 'curious' },
  { at: 75, key: 'close' },
  { at: 95, key: 'yours' },
];
function rungOf(trust) {
  let r = RUNGS[0];
  for (const rung of RUNGS) if (trust >= rung.at) r = rung;
  return r.key;
}

const MOOD_LINES = {
  cat: {
    gone: 'It is up and gone before your weight finishes shifting. You get the tail and the sound of it landing somewhere else.',
    watching: 'It holds where it is and watches your hands. Not your face. Your hands.',
    tolerating: 'It stays put, which is new. The tail moves once, slow, and stops.',
    curious: 'It comes a step and a half toward you and stops there, on its own terms, and waits to see what you do with that.',
    close: 'It leans its whole head into your hand and shuts its eyes like the decision cost it nothing.',
    yours: 'It walks up and stands against your shin and stays there. You could pick this animal up and it knows it and it stayed anyway.',
  },
  dog: {
    gone: 'It is forty feet away before you finish the step, then turns and looks back to see whether that was the right call.',
    watching: 'It holds its distance and keeps you in front of it, weight on the back legs.',
    tolerating: 'It lets you stand there. The tail is low and moving, which is not the same as happy, but it is not nothing.',
    curious: 'It closes half the distance and stops, ears forward, deciding.',
    close: 'It pushes its head under your hand and lets its weight rest against your leg.',
    yours: 'It sits on your foot. Not near your foot. On it.',
  },
};
function moodLine(species, trust) {
  return (MOOD_LINES[species] || MOOD_LINES.dog)[rungOf(trust)];
}

/* ── SOUND ─────────────────────────────────────────────────────────────────
 * Which sound an interaction makes, by species and rung. `life.*` was already
 * a reserved family; these are the first ids in it that anything emits. */
function moodSound(species, trust, bolted) {
  if (bolted) return 'life.stray.bolt';
  const rung = rungOf(trust);
  if (species === 'cat') {
    if (rung === 'gone') return 'life.cat.hiss';
    if (rung === 'watching') return null;
    if (rung === 'tolerating') return 'life.cat.meow';
    return 'life.cat.purr';
  }
  if (rung === 'gone') return 'life.stray.bolt';
  if (rung === 'watching') return 'life.dog.growl';
  if (rung === 'tolerating') return 'life.dog.whine';
  return 'life.dog.pant';
}

/* ── FOOD ──────────────────────────────────────────────────────────────────
 * What each species will take. Deliberately drawn from what the forage
 * almanac, the garden plots and the Bite already put in your hands — the point
 * of the tie-in is that the fastest way to a stray's trust is something you
 * grew, found, or caught, and none of it is buyable. */
const CAT_FOOD = ['fish', 'perch', 'bluegill', 'catfish', 'crappie', 'bass', 'drum', 'sunfish', 'shad', 'herring', 'sardine', 'minnow'];
const DOG_FOOD = ['fish', 'perch', 'bluegill', 'catfish', 'crappie', 'bass', 'drum', 'sunfish', 'shad',
  'egg', 'eggs', 'bacon', 'sausage', 'biscuit', 'jerky', 'pawpaw', 'persimmon', 'hickory nut', 'walnut'];
const ALSO_FINE = ['greens', 'beans', 'corn', 'tomato', 'pepper', 'herbs', 'mulberries', 'blackberries', 'morels', 'poke', 'watercress', 'dandelion greens', 'wild onion'];

/** Will this animal take it? Cats are narrow and honest about it. */
function willEat(species, foodName) {
  const f = String(foodName || '').toLowerCase();
  const list = species === 'cat' ? CAT_FOOD : DOG_FOOD;
  if (list.some((k) => f.includes(k))) return true;
  if (species === 'dog' && ALSO_FINE.some((k) => f.includes(k))) return true;
  return false;
}

/* ── DRIFT ─────────────────────────────────────────────────────────────────
 * Called by the world tick. An animal moves inside its territory on its own
 * clock, and the clock is deliberately slow: a stray you saw on Front Street
 * ten minutes ago should usually still be findable, or "go find the gray one"
 * stops being a thing a person can decide to do. */
const DRIFT_CHANCE = 0.22;

function driftTo(def, currentRoom, rng = Math.random) {
  if (rng() > DRIFT_CHANCE) return null;
  const options = def.territory.filter((r) => r !== currentRoom);
  if (!options.length) return null;
  return options[Math.floor(rng() * options.length)];
}

/* ── TUNING VERIFICATION ───────────────────────────────────────────────────
 * Runs the real trustGain in a loop and reports mean approaches-to-carry per
 * temper per style. Not a test framework, on purpose: it is callable from a
 * node one-liner in any future session, so the numbers in the ledger can be
 * re-checked in ten seconds by somebody who does not trust this comment. */
function verifyTuning(runs = 800) {
  const out = {};
  for (const temper of Object.keys(TARGETS)) {
    out[temper] = {};
    for (const style of ['patient', 'food', 'rushed']) {
      let total = 0;
      for (let i = 0; i < runs; i++) {
        let trust = 0, n = 0;
        while (trust < CARRY_AT && n < 5000) {
          const r = trustGain(temper, {
            withFood: style === 'food',
            sinceLastMs: style === 'rushed' ? 0 : Infinity,
          });
          trust += r.gain; n++;
        }
        total += n;
      }
      out[temper][style] = +(total / runs).toFixed(2);
    }
  }
  return out;
}

module.exports = {
  STRAYS, STRAY_BY_ID, SHELTER_ROOM, SURRENDER_PAYS, ADOPT_COSTS,
  CARRY_AT, TARGETS, GAIN, PATIENCE_MS, BOLT_CHANCE,
  trustGain, rungOf, moodLine, moodSound, willEat, driftTo, verifyTuning,
};
