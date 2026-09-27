/* REVERIE LIFE — wants, life goals and the reward shelf (Part 296, Sep 26 2026).
 *
 * The creation wizard has always asked "What do you want out of this life,
 * more than anything?" and promised, in its own help line, that the game
 * "nudges you toward and cheers when you get there". Nothing ever did. The
 * answer was stored and never read again.
 *
 * This is the Sims backbone the city was missing: something to do next.
 *
 *   WANTS    Three small wishes a day, drawn from what you said you want out
 *            of life, your two traits, your meters and your circumstances (no
 *            place yet, a kid at home, a stove, a pet). Doing one plays a
 *            chime, pays satisfaction, and a fresh one takes its place, up to
 *            six a day. Every want can say where it happens, so a tap on it
 *            walks you there — that matters most to somebody who cannot see
 *            a map.
 *   GOALS    Five steps up the life you chose, checked against the real
 *            state of your character (money, skills, people, home, family).
 *            A step lands in the room: "looks like somebody who got what they
 *            wanted." `aspiration` changes the goal and keeps what you did.
 *   REWARDS  Satisfaction buys things that exist nowhere else in the city:
 *            a telescope, an easel, a jukebox, a fish tank, a hammock, a lava
 *            lamp; or a good night's sleep and a lifted mood on the spot.
 *
 * Laws kept: code is the referee (no model decides anything here), nothing
 * is taken away for failing a want (they simply turn over at midnight), a
 * child seat never draws a romance, card or scratch-ticket want, and the
 * draw is deterministic per person per day so it cannot be rerolled by
 * reloading the page. */
const registry = require('./registry');
const needsLib = require('./needs');
const skills = require('./skills');
const {
  MooChar, MooItem, MooRoom, emit, setAttrs, worldClock, hashStr, cap, joinAnd, coinOf, makeItem, logger,
} = require('./ctx');

const PER_DAY = 6;
const OPEN = 3;

/* ── THE WANTS ────────────────────────────────────────────────────────────
 * match(ev) sees one finished, successful command:
 *   ev.verb    the registry verb, or the first word the old engine took
 *   ev.lower   the whole command, lower case
 *   ev.roomId  where you are now; ev.fromRoom where you started
 *   ev.district, ev.kinds, ev.life, ev.state
 * `when(s)` decides whether the want can be drawn at all. `asp` and `trait`
 * make it three and two times likelier for the people it suits. */
const W = (id, text, pts, match, extra = {}) => ({ id, text, pts, match, count: 1, ...extra });
const verbIs = (...names) => (ev) => names.includes(ev.verb);
const inRoom = (roomId, ...names) => (ev) => ev.roomId === roomId && (!names.length || names.includes(ev.verb));
const WANTS = [
  /* meters first — the Sims rule that a want can be as small as dinner */
  W('need_fed', 'Get something good to eat', 15, verbIs('eat', 'cook'), { when: (s) => s.needs.fed < 45, weight: 6, hint: 'Pat’s, the Taco Window, the bakery, or your own stove.', go: 'pats_diner' }),
  W('need_rest', 'Get some real rest', 15, verbIs('sleep', 'relax', 'sauna', 'soak'), { when: (s) => s.needs.rested < 40, weight: 6, hint: 'Your own bed is best. Mercy and the Kettle keep a corner for anybody.' }),
  W('need_company', 'Spend some time with somebody', 15, verbIs('chat', 'hug', 'talk', 'converse', 'joke', 'compliment', 'dance', 'hangout'), { when: (s) => s.needs.company < 45, weight: 6, hint: 'Anybody counts. Pat’s is never empty.', go: 'pats_diner' }),
  W('need_fun', 'Do something just for fun', 15, verbIs('bowl', 'darts', 'sing', 'dance', 'watch tv', 'watch a movie', 'play pinball', 'claw machine', 'skee ball', 'swim', 'cannonball', 'play cards', 'radio', 'paint', 'sketch'), { when: (s) => s.needs.fun < 45, weight: 6, hint: 'The Starlite Arcade, the Bijou, the Lanes, or a swim.' }),
  W('need_clean', 'Get cleaned up', 15, verbIs('shower', 'swim', 'swim laps', 'sauna', 'soak', 'cannonball'), { when: (s) => s.needs.clean < 45, weight: 5, hint: 'A shower at home, the Sweetwater Bathhouse, or a swim off the Pier.', go: 'sweetwater_bathhouse' }),

  /* food and home */
  W('eat_pats', 'Eat at Pat’s', 20, inRoom('pats_diner', 'eat'), { go: 'pats_diner', hint: 'Front Street, the water end. "eat" at the counter.' }),
  W('eat_tacos', 'Get tacos at the Taco Window', 20, inRoom('taco_window', 'eat'), { go: 'taco_window', asp: ['hustle', 'popularity'], when: (s) => s.hour >= 16 || s.hour < 3 }),
  W('eat_bakery', 'Have something warm from the Early Bird Bakery', 20, inRoom('early_bird_bakery', 'eat', 'buy'), { go: 'early_bird_bakery', when: (s) => s.hour >= 5 && s.hour < 15, asp: ['peace', 'craft'] }),
  W('cook', 'Cook something', 30, (ev) => ev.verb === 'cook' && /^cook \S/.test(ev.lower), { asp: ['craft', 'family'], hint: 'A stove at home, or Pat’s back burner. "recipes" lists what you can make.' }),
  W('rent', 'Find a place of your own', 50, verbIs('rent'), { when: (s) => !s.hasHome, weight: 4, asp: ['fortune', 'peace', 'family'], hint: '"listings" shows what is for rent. A room over Pat’s is eighteen a week.' }),
  W('furnish', 'Put something new in your place', 30, verbIs('place'), { when: (s) => s.hasHome, weight: 2, asp: ['peace', 'craft', 'fortune'], hint: 'Hock’s Pawn sells furniture; the Salvage Yard sells it dented and cheap.' }),
  W('sleep_home', 'Sleep at home tonight', 20, (ev) => ev.verb === 'sleep' && !!ev.life.home && String(ev.roomId).startsWith(ev.life.home), { when: (s) => s.hasHome && (s.hour >= 20 || s.hour < 6), asp: ['peace', 'family'] }),
  W('paint_walls', 'Give a room at home a new color', 30, (ev) => ev.kinds.includes('obj.paint.roller') || (ev.verb === 'floor' && ev.kinds.some((k) => /^move\.step\./.test(k))), { when: (s) => s.hasHome, asp: ['craft', 'peace'], trait: ['handy'], hint: 'At home: "paint walls <a color>" or "floor <a kind of floor>".' }),
  W('build_room', 'Add a room to your home', 60, (ev) => ev.verb === 'build room' && ev.kinds.includes('work.hammer.build'), { when: (s) => s.hasHome && s.coin >= 60, asp: ['family', 'fortune', 'craft'], trait: ['handy', 'homebody'], hint: 'At home: "build room" shows what you can add.' }),

  /* people */
  W('chat3', 'Chat with people three times', 25, verbIs('chat'), { count: 3, asp: ['popularity', 'family'], trait: ['loud', 'funny'], go: 'pats_diner' }),
  W('joke', 'Tell somebody a joke', 20, verbIs('joke'), { asp: ['popularity'], trait: ['funny'] }),
  W('compliment', 'Pay somebody a compliment', 20, verbIs('compliment'), { asp: ['popularity', 'family'], trait: ['kind'] }),
  W('hug', 'Hug somebody', 20, verbIs('hug'), { asp: ['family'], trait: ['kind'] }),
  W('comfort', 'Comfort somebody', 25, verbIs('comfort'), { asp: ['family', 'peace'], trait: ['kind', 'quiet'] }),
  W('gift', 'Give somebody a gift', 30, verbIs('gift', 'give'), { asp: ['family', 'popularity'], trait: ['kind', 'romantic'], hint: 'Flowers from the Corner Store, apples from the Tandy stand. "gift <thing> to <name>".' }),
  W('converse', 'Have a real conversation with somebody', 25, verbIs('converse', 'reply'), { asp: ['popularity', 'knowledge'], trait: ['quiet'], hint: 'Tap a name and choose Say hello.' }),
  W('say_room', 'Say something to a whole room', 15, (ev) => ['say', 'speak'].includes(ev.verb), { trait: ['loud'], hint: '"say <anything>" and see who answers.' }),
  W('dance', 'Dance with somebody', 25, (ev) => ev.verb === 'dance' && / with /.test(ev.lower), { asp: ['popularity', 'family'], trait: ['romantic', 'restless'], go: 'dezs_bar' }),
  W('hangout', 'Start or join a hangout', 30, (ev) => ev.verb === 'hangout' && /^hangout \S/.test(ev.lower) && !/^hangout (memories|memory|leave|invite)\b/.test(ev.lower), { asp: ['popularity', 'family', 'peace'], hint: '"hangout" offers a cookout, a record night or a story circle.' }),
  W('date', 'Go on a date', 40, verbIs('date'), { when: (s) => !s.isChild && s.romance(15) >= 1, asp: ['family'], trait: ['romantic'], hint: 'Flirt first. "date <name>" picks a spot.' }),
  W('flirt', 'Flirt a little', 20, verbIs('flirt'), { when: (s) => !s.isChild, trait: ['romantic'] }),

  /* fun */
  W('bowl', 'Bowl a game at the Millrace Lanes', 30, verbIs('bowl'), { go: 'bowling_lanes', asp: ['popularity', 'hustle'] }),
  W('darts', 'Throw darts at Dez’s', 25, verbIs('darts'), { go: 'dezs_bar', when: (s) => !s.isChild, asp: ['hustle', 'popularity'] }),
  W('cards', 'Play a hand of cards in the Game Parlor', 25, (ev) => ev.verb === 'play cards' && /\d/.test(ev.lower), { go: 'game_parlor', when: (s) => !s.isChild, asp: ['hustle'], trait: ['hustler'] }),
  W('sing', 'Sing where people can hear you', 30, verbIs('sing'), { go: 'dezs_bar', asp: ['popularity', 'craft'], trait: ['loud'] }),
  W('movie', 'Catch a picture at the Bijou', 30, (ev) => ev.kinds.includes('cer.bijou.projector'), { go: 'the_bijou', asp: ['peace', 'popularity', 'family'] }),
  W('pinball', 'Play pinball at the Starlite Arcade', 25, verbIs('play pinball'), { go: 'starlite_arcade', asp: ['hustle', 'popularity'], trait: ['restless'] }),
  W('claw', 'Win something from the claw machine', 35, (ev) => ev.verb === 'claw machine' && ev.kinds.includes('game.claw.win'), { go: 'starlite_arcade', trait: ['hustler', 'restless'] }),
  W('skee', 'Roll a game of skee-ball', 20, verbIs('skee ball'), { go: 'starlite_arcade' }),
  W('swim_laps', 'Swim laps at the Sweetwater Bathhouse', 25, verbIs('swim laps'), { go: 'sweetwater_bathhouse', asp: ['peace', 'nature'] }),
  W('sauna', 'Sweat it out in the bathhouse sauna', 20, verbIs('sauna'), { go: 'sweetwater_bathhouse', asp: ['peace'] }),
  W('paint', 'Paint a picture', 35, (ev) => ev.verb === 'paint' && ev.kinds.includes('obj.brush.stroke'), { go: 'the_easel', asp: ['craft', 'knowledge'], hint: 'At the Easel on Fairlawn Avenue: "paint <anything you like>".' }),
  W('radio', 'Listen to the Band for a while', 15, verbIs('radio'), { asp: ['peace'], go: 'dezs_bar' }),
  W('read', 'Read something', 20, verbIs('read'), { go: 'the_archive', asp: ['knowledge', 'peace'], trait: ['bookish'] }),
  W('scratch', 'Buy a scratch ticket', 15, verbIs('scratch ticket'), { when: (s) => !s.isChild, go: 'corner_store', asp: ['hustle', 'fortune'], trait: ['hustler'] }),
  W('wish', 'Make a wish at the fountain', 20, verbIs('wish'), { go: 'wishing_fountain', asp: ['peace', 'family'], hint: '"wish <what you want, in your own words>".' }),
  W('penny', 'Flatten a penny at the Grade Crossing', 25, verbIs('flatten'), { go: 'the_rails', trait: ['restless'], hint: 'Put one on the rail and wait for the freight.' }),

  /* outdoors and animals */
  W('fish', 'Catch a fish', 30, (ev) => (ev.verb === 'easy fish' && /keep|release/.test(ev.lower)) || ev.verb === 'land', { go: 'pier_seven', asp: ['nature', 'peace'], trait: ['quiet'], hint: '"easy fish" at any water, no timing needed.' }),
  W('explore', 'Walk the Alder Trail', 25, (ev) => ev.roomId === 'alder_trail' && ev.fromRoom !== 'alder_trail', { go: 'alder_trail', asp: ['nature', 'knowledge'], trait: ['restless'] }),
  W('photo', 'Photograph wildlife', 30, verbIs('photograph wildlife', 'track wildlife'), { go: 'alder_trail', asp: ['nature', 'knowledge'] }),
  W('stray', 'Win a stray over a little', 25, verbIs('pet', 'approach', 'coax', 'offer'), { asp: ['nature', 'peace'], trait: ['kind'], hint: 'The gray cat on Gully Road likes patience.', go: 'patch_gully_road' }),
  W('forage', 'Forage something in season', 20, verbIs('forage'), { asp: ['nature'], trait: ['green'], hint: '"almanac" says what is in season; "forage" in the wild places.' }),
  W('garden', 'Tend the garden plots', 25, verbIs('plant', 'water', 'weed', 'pick'), { go: 'garden_plots', asp: ['nature', 'craft'], trait: ['green'] }),
  W('ferry', 'Ride the ferry across', 20, verbIs('ferry'), { go: 'ferry_dock_hook', asp: ['nature', 'peace'] }),
  W('tram', 'Ride the tram', 15, verbIs('tram'), { go: 'bell_court_street' }),
  W('sweetwater', 'Spend some time in Sweetwater', 15, (ev) => ev.district === 'sweetwater' && ev.fromDistrict !== 'sweetwater', { go: 'sweetwater_park', asp: ['peace', 'nature', 'family'] }),
  W('longacre', 'Go out past the Ring Road to Long Acre', 20, (ev) => ev.district === 'longacre' && ev.fromDistrict !== 'longacre', { go: 'long_acre_fields', asp: ['nature', 'peace'] }),
  W('tanglefoot', 'See Tanglefoot after dark', 20, (ev) => ev.district === 'tanglefoot' && ev.fromDistrict !== 'tanglefoot', { go: 'tanglefoot_line_street', when: (s) => !s.isChild && (s.hour >= 19 || s.hour < 3), asp: ['popularity', 'hustle'] }),

  /* work and growth */
  W('work', 'Work a shift', 25, verbIs('work'), { asp: ['fortune', 'hustle'], hint: 'The docks, Pat’s sink, the Archive desk, the bakery, the Bijou — "work" where there is work.' }),
  W('work2', 'Work two shifts', 40, verbIs('work'), { count: 2, when: (s) => s.coin < 150, asp: ['fortune', 'hustle'] }),
  W('levelup', 'Get better at something', 40, (ev) => ev.kinds.includes('levelup'), { asp: ['knowledge', 'craft'], hint: 'Any skill that levels up counts. "skills" shows where you stand.' }),
  W('workout', 'Work out', 20, verbIs('workout', 'swim laps'), { asp: ['popularity'], trait: ['restless'], hint: 'The Stairs, the Union Hall steps, or laps at the bathhouse.', go: 'the_stairs' }),

  /* family */
  W('kid_play', 'Play with your kid', 30, verbIs('play with'), { when: (s) => s.kids > 0, weight: 3, asp: ['family'] }),
  W('kid_read', 'Read to your kid', 30, verbIs('read to'), { when: (s) => s.kids > 0, weight: 2, asp: ['family', 'knowledge'] }),
  W('pet_walk', 'Take your pet along somewhere', 20, verbIs('bring'), { when: (s) => s.pets > 0, asp: ['nature', 'peace'] }),
];
const WANT_BY_ID = Object.fromEntries(WANTS.map((w) => [w.id, w]));

/* ── LIFE GOALS: five steps up the life you chose ─────────────────────── */
const G = (title, pts, check) => ({ title, pts, check });
const craftLevels = (s) => ['cooking', 'handy', 'music', 'painting'].map((k) => s.level(k));
const GOALS = {
  family: [
    G('A real friend', 100, (s) => s.friends(30) >= 1),
    G('Somebody you have gone on a date with', 150, (s) => s.romance(30) >= 1),
    G('Somebody who is yours', 200, (s) => !!s.life.partner),
    G('A child in the house', 300, (s) => s.kids >= 1),
    G('A full house: two children or more', 500, (s) => s.kids >= 2),
  ],
  fortune: [
    G('A hundred dollars in your pocket', 100, (s) => s.coin >= 100),
    G('A place of your own', 150, (s) => s.hasHome),
    G('Wheels of your own', 200, (s) => s.vehicles >= 1),
    G('Trusted at a job', 300, (s) => s.careerTop >= 2),
    G('A house on Fairlawn Avenue, bought outright', 500, (s) => s.ownsFairlawn),
  ],
  knowledge: [
    G('Learning at level 2', 100, (s) => s.level('learning') >= 2),
    G('Three skills at level 2', 150, (s) => s.skillsAt(2) >= 3),
    G('Learning at level 5', 200, (s) => s.level('learning') >= 5),
    G('Five skills at level 3', 300, (s) => s.skillsAt(3) >= 5),
    G('Learning at level 8', 500, (s) => s.level('learning') >= 8),
  ],
  popularity: [
    G('Three people who know you', 100, (s) => s.friends(10) >= 3),
    G('Two friends', 150, (s) => s.friends(30) >= 2),
    G('Charm at level 4', 200, (s) => s.level('charm') >= 4),
    G('Five friends', 300, (s) => s.friends(30) >= 5),
    G('A close friend and eight friends', 500, (s) => s.friends(60) >= 1 && s.friends(30) >= 8),
  ],
  craft: [
    G('Any craft at level 2', 100, (s) => Math.max(...craftLevels(s)) >= 2),
    G('Any craft at level 4', 150, (s) => Math.max(...craftLevels(s)) >= 4),
    G('Two crafts at level 4', 200, (s) => craftLevels(s).filter((l) => l >= 4).length >= 2),
    G('Any craft at level 7', 300, (s) => Math.max(...craftLevels(s)) >= 7),
    G('A master: any craft at level 10', 500, (s) => Math.max(...craftLevels(s)) >= 10),
  ],
  nature: [
    G('Your first catch', 100, (s) => s.level('fishing') >= 1),
    G('An animal of your own', 150, (s) => s.pets >= 1),
    G('Garden at level 3', 200, (s) => s.level('garden') >= 3),
    G('Fishing at level 5', 300, (s) => s.level('fishing') >= 5),
    G('Garden and Fishing both at level 6', 500, (s) => s.level('garden') >= 6 && s.level('fishing') >= 6),
  ],
  hustle: [
    G('Fifty dollars in your pocket', 100, (s) => s.coin >= 50),
    G('Hustle at level 3', 150, (s) => s.level('hustle') >= 3),
    G('Two hundred fifty dollars in your pocket', 200, (s) => s.coin >= 250),
    G('Second in command at a job', 300, (s) => s.careerTop >= 3),
    G('Hustle at level 8 and five hundred dollars', 500, (s) => s.level('hustle') >= 8 && s.coin >= 500),
  ],
  peace: [
    G('A place of your own', 100, (s) => s.hasHome),
    G('A bed of your own at home', 150, (s) => s.homeHas('bed')),
    G('An animal of your own', 200, (s) => s.pets >= 1),
    G('A home with six things in it', 300, (s) => s.furniture >= 6),
    G('A glowing mood, at home', 500, (s) => s.atHome && needsLib.moodOf(s.needs).label === 'glowing'),
  ],
};
const ASPIRATION_NAMES = {
  family: 'Family', fortune: 'Fortune', knowledge: 'Knowledge', popularity: 'Popularity',
  craft: 'Craft', nature: 'Nature', hustle: 'Hustle', peace: 'Peace',
};

/* ── REWARDS ──────────────────────────────────────────────────────────── */
const REWARDS = [
  { key: 'fresh', name: 'Fresh wants', cost: 25, blurb: 'Swap today’s open wants for new ones.' },
  { key: 'rest', name: 'A good night’s sleep, right now', cost: 60, blurb: 'Rested all the way up.' },
  { key: 'lift', name: 'A lifted mood', cost: 60, blurb: 'Fun and company, a big boost of each.' },
  { key: 'lavalamp', name: 'a lava lamp', cost: 120, furniture: 'lavalamp', blurb: 'Slow red wax, rising and falling. Sighted visitors stare at it. Everybody else hears it hum.', effect: 'The room glows and hums a little. Relaxing near it does more.' },
  { key: 'hammock', name: 'a hammock', cost: 160, furniture: 'hammock', blurb: 'Rope, two hooks, and an afternoon. Rest in it at home.', effect: '"swing in the hammock" at home: rest and fun both.' },
  { key: 'fishtank', name: 'a fish tank', cost: 180, furniture: 'fishtank', blurb: 'A bubbling tank with six small fish who all have opinions.', effect: '"watch the fish" at home: a calm that sticks.' },
  { key: 'jukebox', name: 'a jukebox', cost: 220, furniture: 'jukebox', blurb: 'Chrome, colored light and forty records. Plays at home.', effect: '"play the jukebox" at home: fun, and Music practice.' },
  { key: 'easel', name: 'an easel', cost: 220, furniture: 'easel', blurb: 'Paint at home instead of walking to the Easel.', effect: '"paint <anything>" at home.' },
  { key: 'telescope', name: 'a telescope', cost: 260, furniture: 'telescope', blurb: 'Brass, on a tripod. On a clear night the sky gets closer.', effect: '"stargaze" at home after dark: fun, rest and Learning.' },
];

/* ── STATE ─────────────────────────────────────────────────────────────── */
function wantsOf(life) {
  const w = life.wants && typeof life.wants === 'object' ? life.wants : {};
  return { day: w.day || null, list: Array.isArray(w.list) ? w.list : [], drawn: w.drawn || 0, doneToday: w.doneToday || 0 };
}

/** Everything a want or a goal may ask about, fetched lazily and once per turn. */
function stateOf(ctx) {
  const { ch, life } = ctx;
  const c = worldClock();
  const s = {
    life,
    hour: c.h,
    isChild: !!ctx.isChild,
    coin: coinOf(ch),
    needs: { ...needsLib.fresh(), ...(life.needs || {}) },
    hasHome: !!life.home,
    atHome: !!life.home && String(ch.roomId || '').startsWith(life.home),
    level: (k) => skills.levelOf((life.skills || {})[k] || 0),
    skillsAt: (n) => Object.keys(skills.SKILLS).filter((k) => skills.levelOf((life.skills || {})[k] || 0) >= n).length,
    careerTop: Math.max(0, ...Object.values(life.careers || {}).map((c2) => careerLevel(c2.shifts || 0))),
    kids: 0, pets: 0, vehicles: 0, furniture: 0, ownsFairlawn: false, homeTypes: new Set(), rels: [],
    friends: (n) => s.rels.filter((r) => (r.friendship || 0) >= n).length,
    romance: (n) => s.rels.filter((r) => (r.romance || 0) >= n).length,
    homeHas: (type) => s.homeTypes.has(type),
  };
  return s;
}
function careerLevel(shifts) { const steps = [0, 5, 14, 30, 55]; let lvl = 0; for (let i = 0; i < steps.length; i++) if (shifts >= steps[i]) lvl = i; return lvl; }

/** The slower facts (people, family, things), read only when something needs them. */
async function hydrate(ctx, s) {
  const uid = ctx.userId;
  const [rels, kids, pets, vehicles, furniture, homes] = await Promise.all([
    require('./relationships').relsOf(uid),
    MooChar.countDocuments({ userId: /^kid:/, 'attrs.child.parents': uid }),
    MooChar.countDocuments({ $or: [{ userId: /^pet:/, 'attrs.owner': uid }, { userId: /^stray:/, 'attrs.owner': uid }] }),
    MooItem.countDocuments({ 'location.type': 'char', 'location.id': uid, 'props.vehicle': { $exists: true } }),
    s.life.home ? MooItem.find({ 'location.type': 'room', 'location.id': { $in: await homeRoomIds(s.life.home) }, 'props.furniture': { $exists: true } }).select('props.furniture').lean() : [],
    MooRoom.find({ 'props.home.owner': uid, 'props.home.listing': 'fairlawn_house', 'props.home.owned': true }).select('roomId').lean(),
  ]);
  s.rels = rels;
  s.kids = kids;
  s.pets = pets;
  s.vehicles = vehicles;
  s.furniture = furniture.length;
  s.homeTypes = new Set(furniture.map((f) => f.props.furniture));
  s.ownsFairlawn = homes.length > 0;
  s.hydrated = true;
  return s;
}
async function homeRoomIds(homeId) {
  const extra = await MooRoom.find({ 'props.home.parent': homeId }).select('roomId').lean();
  return [homeId, ...extra.map((r) => r.roomId)];
}

/* ── THE DRAW ──────────────────────────────────────────────────────────── */
function eligible(s, used) {
  return WANTS.filter((w) => !used.includes(w.id) && (!w.when || w.when(s)));
}
function weightOf(w, s) {
  let n = w.weight || 1;
  const asp = s.life.aspirationKey;
  if (asp && (w.asp || []).includes(asp)) n *= 3;
  if ((w.trait || []).some((t) => (s.life.traitKeys || []).includes(t))) n *= 2;
  return n;
}
function drawOne(userId, day, index, s, used) {
  const pool = eligible(s, used);
  if (!pool.length) return null;
  const weights = pool.map((w) => weightOf(w, s));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = hashStr(`${userId}|${day}|${index}`) % Math.max(1, Math.round(total * 100));
  for (let i = 0; i < pool.length; i++) {
    roll -= Math.round(weights[i] * 100);
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}
function fresh(w) { return { id: w.id, n: 0, need: w.count || 1, done: false }; }

/** Today's wants, drawn if the day has turned. Writes only when it draws. */
async function ensureToday(ctx, s) {
  const day = worldClock().dayKey;
  const cur = wantsOf(ctx.life);
  if (cur.day === day && cur.list.length) return cur;
  s = s || stateOf(ctx);
  if (!s.hydrated) await hydrate(ctx, s);
  const next = { day, list: [], drawn: 0, doneToday: 0 };
  const used = [];
  while (next.list.length < OPEN) {
    const w = drawOne(ctx.userId, day, next.drawn++, s, used);
    if (!w) break;
    used.push(w.id);
    next.list.push(fresh(w));
  }
  ctx.life.wants = next;
  await setAttrs(ctx.ch, { 'life.wants': next });
  return next;
}

function describe(entry) {
  const w = WANT_BY_ID[entry.id];
  if (!w) return null;
  const progress = w.count > 1 ? ` (${Math.min(entry.n, w.count)} of ${w.count})` : '';
  return { id: w.id, text: w.text + progress, done: !!entry.done, pts: w.pts, hint: w.hint || null, go: w.go || null };
}

/* ── OBSERVE: called once after every turn (life/index.js) ─────────────── */
const lastGoalCheck = new Map();
const GOAL_VERBS = new Set(['rent', 'buy house', 'adopt', 'marry', 'move in', 'have baby', 'place', 'buy', 'date', 'propose', 'claim', 'chat', 'hug', 'compliment', 'gift', 'build room']);
function verbOf(ctx) {
  if (ctx.verbName) return ctx.verbName;
  const words = String(ctx.lower || '').split(' ');
  return words[0] || '';
}

async function observe(ctx, result, start = {}) {
  if (!result || !result.ok || !ctx.life || !ctx.life.created || ctx.life.wiz) return;
  const verb = verbOf(ctx);
  if (!verb || ['look', 'l', 'wants', 'goals', 'rewards', 'aspiration', 'status', 'help', 'hint', 'what', 'who', 'where', 'time'].includes(verb)) return;
  const room = await ctx.room();
  const s = stateOf(ctx);
  const state = await ensureToday(ctx, s);
  const ev = {
    verb, lower: ctx.lower, roomId: ctx.ch.roomId, fromRoom: start.roomId || null,
    district: room ? room.district : null, fromDistrict: start.district || null,
    kinds: [...(result.kinds || []), ...(result.sounds || [])], life: ctx.life, state: s,
  };
  const lines = [];
  const sounds = [];
  let gained = 0;
  let changed = false;
  for (const entry of state.list) {
    if (entry.done) continue;
    const w = WANT_BY_ID[entry.id];
    if (!w) continue;
    let hit = false;
    try { hit = !!w.match(ev); } catch (_) { hit = false; }
    if (!hit) continue;
    changed = true;
    entry.n = (entry.n || 0) + 1;
    if (entry.n < (w.count || 1)) {
      lines.push(`Want: ${w.text}, ${entry.n} of ${w.count}.`);
      continue;
    }
    entry.done = true;
    state.doneToday += 1;
    gained += w.pts;
    lines.push(`Want fulfilled: ${w.text}. +${w.pts} satisfaction.`);
    sounds.push('ui.want.done');
  }
  if (changed) {
    /* the done ones make room for fresh ones, up to six finished a day */
    const used = state.list.map((e) => e.id);
    const open = state.list.filter((e) => !e.done);
    const kept = state.list.filter((e) => e.done).slice(-PER_DAY);
    const before = open.length;
    if (!s.hydrated) await hydrate(ctx, s);
    while (open.length < OPEN && state.doneToday + open.length < PER_DAY) {
      const w = drawOne(ctx.userId, state.day, state.drawn++, s, used);
      if (!w) break;
      used.push(w.id);
      open.push(fresh(w));
    }
    state.list = [...kept, ...open];
    const added = open.slice(before);
    if (added.length) lines.push(`A new want: ${added.map((e) => WANT_BY_ID[e.id].text).join('; ')}.`);
    else if (!open.length) lines.push('That is every want for today. Tomorrow brings new ones.');
  }

  /* the next step up the life goal: at most once a minute, or at once when
   * something that goals care about just happened */
  const due = Date.now() - (lastGoalCheck.get(ctx.userId) || 0) > 60000 || GOAL_VERBS.has(verb) || ev.kinds.includes('levelup') || ev.kinds.includes('coin');
  if (due) lastGoalCheck.set(ctx.userId, Date.now());
  const goal = due ? await checkGoal(ctx, s) : null;
  if (goal) {
    gained += goal.pts;
    lines.push(`Life goal reached: ${goal.title}. +${goal.pts} satisfaction.${goal.last ? ` That is everything ${ASPIRATION_NAMES[goal.key]} asked of you. "aspiration" to choose what comes next.` : ` Next: ${goal.next}.`}`);
    sounds.push('ui.goal.done');
    const pr = require('../social').pronounsOf(ctx.ch);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} looks like somebody who just got something ${pr.sub} ${pr.plural ? 'were' : 'was'} after.`, 'ui.goal.done');
  }

  if (!changed && !goal) return;
  const total = Math.max(0, (ctx.life.satisfaction || 0) + gained);
  ctx.life.satisfaction = total;
  ctx.life.wants = state;
  const patch = { 'life.wants': state, 'life.satisfaction': total };
  if (goal) patch['life.goals'] = ctx.life.goals;
  await setAttrs(ctx.ch, patch);
  result.lines = [...(result.lines || []), ...lines];
  result.kinds = [...(result.kinds || []), ...sounds];
  if (gained) result.satisfactionGained = gained;
}

function goalState(life) {
  const g = life.goals && typeof life.goals === 'object' ? life.goals : {};
  return { done: g.done && typeof g.done === 'object' ? g.done : {} };
}
async function checkGoal(ctx, s) {
  const key = ctx.life.aspirationKey;
  const ladder = GOALS[key];
  if (!ladder) return null;
  const gs = goalState(ctx.life);
  const doneN = (gs.done[key] || []).length;
  if (doneN >= ladder.length) return null;
  const step = ladder[doneN];
  await hydrate(ctx, s);
  let ok = false;
  try { ok = !!step.check(s); } catch (e) { logger.warn('[life] goal check failed:', e && e.message); }
  if (!ok) return null;
  gs.done[key] = [...(gs.done[key] || []), doneN];
  ctx.life.goals = gs;
  const next = ladder[doneN + 1];
  return { key, title: step.title, pts: step.pts, last: !next, next: next ? next.title : null };
}

/* ── THE HUD LINE (view.hud) ───────────────────────────────────────────── */
async function hudOf(ctx) {
  if (!ctx.life || !ctx.life.created || ctx.life.wiz) return null;
  const state = await ensureToday(ctx);
  const key = ctx.life.aspirationKey;
  const ladder = GOALS[key] || [];
  const doneN = (goalState(ctx.life).done[key] || []).length;
  return {
    wants: [...state.list.filter((e) => !e.done), ...state.list.filter((e) => e.done)].map(describe).filter(Boolean),
    satisfaction: Math.floor(ctx.life.satisfaction || 0),
    goal: ladder.length ? { aspiration: ASPIRATION_NAMES[key], step: Math.min(doneN + 1, ladder.length), of: ladder.length, next: ladder[doneN] ? ladder[doneN].title : null, done: doneN >= ladder.length } : null,
  };
}

/* ── VERBS ─────────────────────────────────────────────────────────────── */
registry.register({
  name: 'wants', aliases: ['my wants', 'today', 'wishes today', 'what do i want'], free: true,
  help: { topic: 'you', usage: 'wants', blurb: 'Today’s wants, your life goal, and your satisfaction.' },
  async run(ctx) {
    const h = await hudOf(ctx);
    if (!h) return ctx.fail('Wants start once you are somebody in the city.');
    const open = h.wants.filter((w) => !w.done);
    const done = h.wants.filter((w) => w.done);
    ctx.say(open.length ? `Today you want: ${open.map((w, i) => `${i + 1}. ${w.text} (${w.pts})`).join('; ')}.` : 'You have done everything you wanted today. New wants come with the morning.');
    if (done.length) ctx.say(`Done today: ${joinAnd(done.map((w) => w.text))}.`);
    if (h.goal) ctx.say(h.goal.done ? `Life goal, ${h.goal.aspiration}: all ${h.goal.of} steps done. "aspiration" picks a new one.` : `Life goal, ${h.goal.aspiration}: step ${h.goal.step} of ${h.goal.of}, ${h.goal.next}.`);
    else ctx.say('No life goal chosen. "aspiration" picks one.');
    ctx.say(`Satisfaction: ${h.satisfaction}. "rewards" shows what it buys.`);
    return ctx.ok({
      choices: [
        ...open.map((w) => (w.go ? { label: `${w.text}: take me there`, cmd: `go to ${w.go}` } : { label: `${w.text}: how?`, cmd: `want ${w.id}` })),
        { label: 'Rewards', cmd: 'rewards' },
      ],
    });
  },
  buttons: async (ctx) => {
    if (!ctx.life || !ctx.life.created) return [];
    const st = wantsOf(ctx.life);
    const open = st.day === worldClock().dayKey ? st.list.filter((e) => !e.done).length : OPEN;
    return [{ label: open ? `My wants (${open})` : 'My wants', cmd: 'wants', group: 'self' }];
  },
});

registry.register({
  name: 'want', hidden: true, free: true,
  help: { topic: 'you', usage: 'want <which>', blurb: 'How to do one of today’s wants.' },
  async run(ctx, { arg }) {
    const st = await ensureToday(ctx);
    const pick = st.list.find((e) => e.id === arg) || st.list.filter((e) => !e.done)[Number(arg) - 1];
    const w = pick && WANT_BY_ID[pick.id];
    if (!w) return ctx.fail('That is not one of today’s wants. "wants" lists them.');
    ctx.say(`${w.text}. ${w.hint || 'Anywhere it makes sense. The city will notice.'}`);
    return ctx.ok(w.go ? { choices: [{ label: 'Take me there', cmd: `go to ${w.go}` }] } : {});
  },
});

registry.register({
  name: 'aspiration', aliases: ['life goal', 'goals', 'goal', 'change aspiration'], free: true,
  help: { topic: 'you', usage: 'aspiration · aspiration <family|fortune|knowledge|popularity|craft|nature|hustle|peace>', blurb: 'Your life goal and its five steps. Change it any time; finished steps stay finished.' },
  async run(ctx, { arg }) {
    const want = String(arg || '').trim().toLowerCase();
    const gs = goalState(ctx.life);
    if (want) {
      const key = Object.keys(GOALS).find((k) => k === want || ASPIRATION_NAMES[k].toLowerCase() === want || k.startsWith(want));
      if (!key) return ctx.fail(`No life goal called "${arg}". Choose: ${Object.values(ASPIRATION_NAMES).join(', ')}.`);
      ctx.life.aspirationKey = key;
      ctx.life.aspiration = ASPIRATION_NAMES[key].toLowerCase();
      await setAttrs(ctx.ch, { 'life.aspirationKey': key, 'life.aspiration': ctx.life.aspiration });
      ctx.say(`Your life goal is now ${ASPIRATION_NAMES[key]}. Tomorrow’s wants will lean that way.`);
    }
    const key = ctx.life.aspirationKey;
    const ladder = GOALS[key];
    if (!ladder) {
      ctx.say(`Choose a life goal: ${Object.values(ASPIRATION_NAMES).join(', ')}.`);
    } else {
      const doneN = (gs.done[key] || []).length;
      ctx.say(`${ASPIRATION_NAMES[key]}: ${ladder.map((st, i) => `${i + 1}. ${st.title}${i < doneN ? ' (done)' : i === doneN ? ' (next)' : ''}`).join('; ')}.`);
    }
    return ctx.ok({ choices: Object.keys(GOALS).filter((k) => k !== ctx.life.aspirationKey).map((k) => ({ label: `Switch to ${ASPIRATION_NAMES[k]}`, cmd: `aspiration ${k}` })) });
  },
});

registry.register({
  name: 'rewards', aliases: ['reward', 'satisfaction', 'spend satisfaction', 'redeem'], free: true,
  help: { topic: 'you', usage: 'rewards · rewards <name>', blurb: 'Spend satisfaction on things found nowhere else in the city.' },
  async run(ctx, { arg }) {
    const pts = Math.floor(ctx.life.satisfaction || 0);
    const want = String(arg || '').trim().toLowerCase().replace(/^(a|an|the)\s+/, '');
    if (!want) {
      ctx.say(`You have ${pts} satisfaction. ${REWARDS.map((r) => `${cap(r.name)}, ${r.cost}: ${r.blurb}`).join(' ')}`);
      return ctx.ok({ choices: REWARDS.map((r) => ({ label: `${cap(r.name)} (${r.cost})${pts < r.cost ? ', not yet' : ''}`, cmd: `rewards ${r.key}` })) });
    }
    const r = REWARDS.find((x) => x.key === want || x.name.toLowerCase().replace(/^(a|an)\s+/, '') === want || x.name.toLowerCase().includes(want));
    if (!r) return ctx.fail(`No reward called "${arg}". "rewards" lists them.`);
    if (pts < r.cost) return ctx.fail(`${cap(r.name)} takes ${r.cost} satisfaction. You have ${pts}. Wants and life goals earn it.`);
    const claimed = await MooChar.updateOne({ _id: ctx.ch._id, 'attrs.life.satisfaction': { $gte: r.cost } }, { $inc: { 'attrs.life.satisfaction': -r.cost } });
    if (!claimed.modifiedCount) return ctx.fail('Your satisfaction changed before that went through. Check "rewards" again.');
    ctx.life.satisfaction = pts - r.cost;
    if (r.key === 'fresh') {
      const st = await ensureToday(ctx);
      const s = await hydrate(ctx, stateOf(ctx));
      const used = st.list.map((e) => e.id);
      st.list = st.list.map((e) => {
        if (e.done) return e;
        const w = drawOne(ctx.userId, st.day, st.drawn++, s, used);
        if (!w) return e;
        used.push(w.id);
        return fresh(w);
      });
      ctx.life.wants = st;
      await setAttrs(ctx.ch, { 'life.wants': st });
      ctx.say(`Fresh wants: ${st.list.filter((e) => !e.done).map((e) => WANT_BY_ID[e.id].text).join('; ')}.`);
    } else if (r.key === 'rest') {
      ctx.need({ rested: 100 });
      ctx.say('You feel like you slept ten hours in a good bed with the window open. Rested, all the way.');
    } else if (r.key === 'lift') {
      ctx.need({ fun: 45, company: 35 });
      ctx.say('Something lifts. The day looks friendlier than it did a minute ago.');
    } else {
      await makeItem({ name: r.name, desc: r.blurb, location: { type: 'char', id: ctx.userId }, props: { furniture: r.furniture, effect: r.effect, value: 0, reward: true } });
      ctx.say(`${cap(r.name)} is yours. ${r.effect} Take it home and "place ${r.name.replace(/^(a|an)\s+/, '')}".`);
    }
    return ctx.ok({ kinds: [...ctx.kinds, 'ui.reward'] });
  },
});

module.exports = { WANTS, WANT_BY_ID, GOALS, REWARDS, ASPIRATION_NAMES, observe, hudOf, ensureToday, drawOne, stateOf, eligible, wantsOf };
