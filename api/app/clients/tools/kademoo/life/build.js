/* REVERIE LIFE — build mode (Part 296, Sep 26 2026).
 *
 * A home was one room. The Sims is, for a great many of the people who love
 * it, a game about the house: adding the bedroom, painting the kitchen, the
 * checkered floor you always wanted. So a place can grow now.
 *
 *   build room <kind>    bedroom, kitchen, bathroom, nursery, den, studio,
 *                        sunroom or yard, joined to your place through a
 *                        free direction (a bedroom goes upstairs when it can)
 *   paint walls <color>  any color you can name; the picture uses it
 *   floor <kind>         wood, checkered tile, carpet, stone, linoleum...
 *                        and your footsteps change to match
 *   rooms                what your home has, room by room
 *
 * The rooms are real rooms: furniture goes in them, a bed in the bedroom
 * sleeps you properly, a shower in the bathroom washes you, and visitors walk
 * through them. Everything is described in words first, because that is the
 * whole picture for a person listening; the 3D miniature reads the same
 * colors and floors for the people looking.
 *
 * Plus the keepsakes from the reward shelf (wants.js), which only do their
 * thing at home: stargaze, watch the fish, play the jukebox, swing in the
 * hammock, watch the lava lamp. */
const registry = require('./registry');
const {
  MooRoom, MooItem, emit, setBusy, payCoin, coinOf, worldClock, hashStr, pick, cap, joinAnd, plural, DIR_WORDS,
} = require('./ctx');

const KINDS = {
  bedroom: { name: 'bedroom', price: 80, prefer: ['u', 'n', 'e', 'w', 'ne', 'nw'], sleepable: true, desc: 'A quiet room with a window over the street and space for a bed. The door closes all the way, which is its whole point.', smell: 'Clean sheets and the faint cedar of a closet.' },
  kitchen: { name: 'kitchen', price: 90, prefer: ['w', 'e', 'n', 'nw', 'ne'], desc: 'A kitchen with a deep sink, a window over it, and room for a stove and a table. Every good conversation in this house will happen in here, eventually.', smell: 'Dish soap, and whatever gets cooked in here next.' },
  bathroom: { name: 'bathroom', price: 70, prefer: ['e', 'w', 'n', 'ne', 'nw', 'u'], desc: 'A small bathroom with white tile and a window that fogs. There is room for a shower and a shelf of things you mean to use.', smell: 'Soap and steam.', floor: 'white tile' },
  nursery: { name: 'nursery', price: 70, prefer: ['n', 'u', 'e', 'w', 'ne', 'nw'], sleepable: true, desc: 'A small bright room with a low window, soft corners, and space for a crib or a bunk bed. It is waiting for somebody small.', smell: 'Baby powder and new paint.' },
  den: { name: 'den', price: 60, prefer: ['w', 'e', 'n', 'nw', 'ne', 'd'], desc: 'A low, comfortable room for doing nothing on purpose: a couch goes here, and a television, and a radio for the Band.', smell: 'Old books and a warm lamp.' },
  studio: { name: 'studio', price: 60, prefer: ['u', 'n', 'e', 'w', 'ne', 'nw'], desc: 'A room with the best light in the house and a floor you do not mind getting paint on. An easel or a jukebox would be at home here.', smell: 'Sawdust and window light.' },
  sunroom: { name: 'sunroom', price: 90, prefer: ['s', 'e', 'w', 'se', 'sw', 'ne'], desc: 'Glass on three sides. In the morning the whole room fills with light, and in the rain it sounds like being inside a drum.', smell: 'Warm glass and houseplants.' },
  yard: { name: 'yard', price: 50, prefer: ['s', 'd', 'sw', 'se', 'e', 'w'], outdoor: true, desc: 'A patch of grass behind the house with a fence around it and a clothesline. It is small, and it is yours, and the sky over it counts.', smell: 'Cut grass and the neighbor’s cooking.', floor: 'grass' },
};
const MAX_ROOMS = 4;
const REVERSE = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw', u: 'd', d: 'u' };

/* colors a person might say, mapped for the picture; anything else still works in words */
const COLORS = {
  white: '#eeeae0', cream: '#efe1c1', ivory: '#f0e9d4', beige: '#d9c7a4', tan: '#c8a97c', brown: '#8a6446', chocolate: '#5e4130',
  gray: '#9ea3a4', grey: '#9ea3a4', charcoal: '#4a4f52', black: '#2e3033', silver: '#c4c8c8',
  red: '#b8574c', brick: '#a4553f', rust: '#a5603b', maroon: '#743a3a', burgundy: '#6e2f3c', coral: '#e08870', salmon: '#e39b86', pink: '#e7a0b8', rose: '#d78f9d', blush: '#ecc0c0',
  orange: '#dd8e4f', peach: '#f0bd97', apricot: '#efb58a', gold: '#d6ae54', mustard: '#caa240', yellow: '#e8cf6b', lemon: '#ecdc7e', butter: '#f0dd9a',
  green: '#7fa47a', sage: '#9cb59a', olive: '#8c8d53', mint: '#a9d6bd', forest: '#4f7053', emerald: '#3f8a66', lime: '#a9c95c', seafoam: '#93cbb5', avocado: '#8e9a4f',
  teal: '#3f8a88', turquoise: '#52b3b0', aqua: '#78c9c6', blue: '#5f8fc4', navy: '#35486f', sky: '#9cc4e4', cobalt: '#3f63a8', denim: '#56739b', periwinkle: '#9aa7dd', robin: '#8fc7cf',
  purple: '#8a6fb0', lavender: '#b4a3d6', lilac: '#c3a7cf', plum: '#6e4a6e', violet: '#7e62b8', mauve: '#b28b9e',
};
function colorHex(words) {
  const w = String(words || '').toLowerCase();
  const found = Object.keys(COLORS).filter((k) => new RegExp(`\\b${k}\\b`).test(w));
  if (found.length) return COLORS[found[found.length - 1]];
  const h = hashStr(w);
  return `hsl(${h % 360}, 32%, 70%)`;
}
const FLOORS = [
  { re: /check|checker/, kind: 'checker', surface: 'linoleum', name: 'checkered tile' },
  { re: /carpet|shag|rug/, kind: 'carpet', surface: 'carpet', name: 'carpet' },
  { re: /stone|slate|brick|flagstone|concrete|cement/, kind: 'stone', surface: 'cobble', name: 'stone' },
  { re: /marble/, kind: 'tile', surface: 'linoleum', name: 'marble' },
  { re: /tile|terrazzo|ceramic/, kind: 'tile', surface: 'linoleum', name: 'tile' },
  { re: /linoleum|vinyl|lino/, kind: 'tile', surface: 'linoleum', name: 'linoleum' },
  { re: /grass|lawn|turf/, kind: 'grass', surface: 'grass.dry', name: 'grass' },
  { re: /cork/, kind: 'carpet', surface: 'carpet', name: 'cork' },
  { re: /wood|oak|pine|maple|walnut|cherry|plank|board|hardwood|parquet/, kind: 'planks', surface: 'wood.interior', name: 'wood' },
];
function floorOf(words) {
  const w = String(words || '').toLowerCase();
  const f = FLOORS.find((x) => x.re.test(w));
  return f ? { ...f } : null;
}
function clean(words, max) {
  // eslint-disable-next-line no-control-regex
  return String(words || '').replace(/[\u0000-\u001f\u007f"“”<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A room of your home, and whether you run it. */
async function homeHere(ctx) {
  const room = await ctx.room();
  const h = room && room.props && room.props.home;
  if (!h) return null;
  const mainId = h.parent || room.roomId;
  const main = h.parent ? await MooRoom.findOne({ roomId: mainId }).lean() : room;
  if (!main || !main.props || !main.props.home) return null;
  const mh = main.props.home;
  const mine = mh.owner === ctx.userId || (mh.tenants || []).includes(ctx.userId);
  return { room, main, mainId, mine, owner: mh.owner === ctx.userId };
}
async function extraRooms(mainId) { return MooRoom.find({ 'props.home.parent': mainId }).lean(); }

function styleLine(style) {
  if (!style) return '';
  const bits = [];
  if (style.walls) bits.push(`the walls are ${style.walls}`);
  if (style.floor) bits.push(`the floor is ${style.floor}`);
  return bits.length ? cap(joinAnd(bits)) + '.' : '';
}
function feelLine(count) {
  if (count >= 8) return 'It feels full of somebody’s life.';
  if (count >= 5) return 'It feels lived in and cozy.';
  if (count >= 2) return 'It is starting to feel like somebody lives here.';
  return '';
}

registry.register({
  name: 'build room', aliases: ['add room', 'add a room', 'build a room', 'build', 'expand', 'add on'],
  help: { topic: 'home', usage: 'build room · build room <bedroom|kitchen|bathroom|nursery|den|studio|sunroom|yard>', blurb: 'Add a room to your place. It joins through a free direction and holds its own furniture.' },
  async run(ctx, { arg }) {
    const h = await homeHere(ctx);
    if (!h || !h.mine) return ctx.fail('Stand inside your own place to build onto it. "home" takes you there.');
    const extras = await extraRooms(h.mainId);
    const want = String(arg || '').trim().toLowerCase().replace(/^(a|an|the)\s+/, '').replace(/\s+room$/, '');
    const kindKey = Object.keys(KINDS).find((k) => k === want || (want && k.startsWith(want)) || (want === 'bath' && k === 'bathroom') || (want === 'garden' && k === 'yard') || (want === 'backyard' && k === 'yard'));
    if (!kindKey) {
      if (extras.length >= MAX_ROOMS) return ctx.fail(`Your place already has ${extras.length} added rooms, which is as many as the lot allows.`);
      ctx.say(`You can add ${MAX_ROOMS - extras.length} more ${MAX_ROOMS - extras.length === 1 ? 'room' : 'rooms'}. ${Object.values(KINDS).map((k) => `A ${k.name}, $${k.price}`).join('; ')}. You carry $${coinOf(ctx.ch)}.`);
      return ctx.ok({ choices: Object.entries(KINDS).map(([k, v]) => ({ label: `Build a ${v.name} ($${v.price})`, cmd: `build room ${k}` })) });
    }
    const kind = KINDS[kindKey];
    if (extras.length >= MAX_ROOMS) return ctx.fail(`Your place already has ${extras.length} added rooms. That is as big as the lot allows.`);
    const main = h.main;
    const dir = kind.prefer.find((d) => !(main.exits || {})[d]) || ['n', 'e', 'w', 's', 'ne', 'nw', 'se', 'sw', 'u', 'd'].find((d) => !(main.exits || {})[d]);
    if (!dir) return ctx.fail('Every wall of your place already has a door in it. There is nowhere left to build.');
    if (!(await payCoin(ctx.ch, kind.price))) return ctx.fail(`A ${kind.name} costs $${kind.price} in lumber and a week of hammering. You carry $${coinOf(ctx.ch)}.`, { kinds: [...ctx.kinds, 'err'] });
    const count = extras.filter((r) => r.props.home.roomType === kindKey).length;
    const roomId = `${h.mainId}_${kindKey}${count ? count + 1 : ''}`;
    const mh = main.props.home;
    const floor = kind.floor ? floorOf(kind.floor) : null;
    await MooRoom.create({
      roomId,
      name: `${mh.ownerName}’s ${kind.name}${count ? ` ${count + 1}` : ''}`,
      district: main.district,
      desc: kind.desc,
      exits: { [REVERSE[dir]]: h.mainId },
      props: {
        home: { owner: mh.owner, ownerName: mh.ownerName, listing: mh.listing, tenants: mh.tenants || [], keys: mh.keys || [], door: mh.door || 'friends', parent: h.mainId, roomType: kindKey },
        smell: kind.smell, sleepable: !!kind.sleepable, indoor: !kind.outdoor, outdoor: !!kind.outdoor,
        doings: kind.outdoor ? 'Your yard. Lie in the grass, look at the sky, have people over for a cookout.' : `Your ${kind.name}. Furnish it: "place <furniture>". Paint it: "paint walls <color>". Change the floor: "floor <kind>".`,
        ...(floor ? { surface: floor.surface, style: { floor: floor.name, floorKind: floor.kind } } : {}),
      },
      createdBy: ctx.userId,
    });
    await MooRoom.updateOne({ roomId: h.mainId, [`exits.${dir}`]: { $exists: false } }, { $set: { [`exits.${dir}`]: roomId } });
    await setBusy(ctx.ch, 10, 'building');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} spends a long afternoon with a hammer and a stack of lumber. There is a new ${kind.name} ${DIR_WORDS[dir] === 'up' ? 'upstairs' : DIR_WORDS[dir] === 'down' ? 'downstairs' : `through a new door to the ${DIR_WORDS[dir]}`}.`, 'work.hammer.build');
    await require('./drama').rumor(ctx, `${ctx.ch.name} built a ${kind.name} onto their place`, 'home', 1);
    ctx.need({ fun: 12, rested: -8, clean: -8 });
    ctx.learn('handy', 6);
    ctx.say(`Lumber, nails, one smashed thumb, and it is done: a ${kind.name}, ${DIR_WORDS[dir] === 'up' ? 'up a new flight of stairs' : DIR_WORDS[dir] === 'down' ? 'down a new flight of stairs' : `through a new door to the ${DIR_WORDS[dir]}`}. ${kind.desc} Go ${DIR_WORDS[dir]} to see it.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'work.hammer.build'] });
  },
  buttons: async (ctx) => {
    const h = await homeHere(ctx);
    return h && h.mine ? [{ label: 'Build a room', cmd: 'build room', group: 'here' }, { label: 'Paint the walls', cmd: 'paint walls', group: 'here' }, { label: 'Change the floor', cmd: 'floor', group: 'here' }] : [];
  },
});

const PAINT_IDEAS = ['sage green', 'buttercream yellow', 'robin’s egg blue', 'warm white', 'terracotta', 'lavender', 'navy blue', 'peach'];
registry.register({
  name: 'paint walls', aliases: ['paint the walls', 'paint room', 'paint the room', 'wall color', 'walls'],
  help: { topic: 'home', usage: 'paint walls <any color>', blurb: 'Paint the room of your home you are standing in. Ten dollars a room.' },
  async run(ctx, { argRaw }) {
    const h = await homeHere(ctx);
    if (!h || !h.mine) return ctx.fail('You can only paint the walls of your own place.');
    if (h.room.props.outdoor) return ctx.fail('A yard has no walls to paint. The fence would like a word, though.');
    const color = clean(argRaw, 40).replace(/^(them|it)\s+/i, '');
    if (!color) {
      ctx.say(`What color? Say it after "paint walls". Anything you can name works: ${joinAnd(PAINT_IDEAS.slice(0, 5))}.`);
      return ctx.ok({ choices: PAINT_IDEAS.map((c) => ({ label: cap(c), cmd: `paint walls ${c}` })) });
    }
    if (!(await payCoin(ctx.ch, 10))) return ctx.fail('A gallon of paint and a roller run ten dollars.');
    const style = { ...((h.room.props && h.room.props.style) || {}), walls: color.toLowerCase(), wallHex: colorHex(color) };
    await MooRoom.updateOne({ roomId: h.room.roomId }, { $set: { 'props.style': style } });
    await setBusy(ctx.ch, 8, 'painting the walls');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} rolls ${color} paint over the walls, humming.`, 'obj.paint.roller');
    ctx.need({ fun: 8, clean: -6 });
    ctx.learn('handy', 2);
    ctx.say(`Two coats, a drop cloth, and a little on your elbow: the walls are ${color} now. The room feels different already.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'obj.paint.roller'] });
  },
});

registry.register({
  name: 'floor', aliases: ['change the floor', 'new floor', 'flooring', 'lay a floor'],
  help: { topic: 'home', usage: 'floor <wood|checkered tile|carpet|stone|tile|linoleum|marble>', blurb: 'Put down a new floor in the room of your home you are standing in. Fifteen dollars.' },
  async run(ctx, { argRaw }) {
    const h = await homeHere(ctx);
    if (!h || !h.mine) return ctx.fail('You can only change the floor in your own place.');
    const words = clean(argRaw, 40);
    const f = floorOf(words);
    if (!f) {
      ctx.say('What kind of floor? Wood, checkered tile, carpet, stone, tile, linoleum, marble or cork. Say it after "floor".');
      return ctx.ok({ choices: ['warm oak boards', 'black and white checkered tile', 'thick carpet', 'gray stone', 'white tile', 'marble'].map((x) => ({ label: cap(x), cmd: `floor ${x}` })) });
    }
    if (h.room.props.outdoor && f.kind !== 'grass' && f.kind !== 'stone') return ctx.fail('Outside, it is grass or stone. "floor stone" makes a patio.');
    if (!(await payCoin(ctx.ch, 15))) return ctx.fail('A new floor runs fifteen dollars in materials.');
    const style = { ...((h.room.props && h.room.props.style) || {}), floor: words.toLowerCase(), floorKind: f.kind };
    await MooRoom.updateOne({ roomId: h.room.roomId }, { $set: { 'props.style': style, 'props.surface': f.surface } });
    await setBusy(ctx.ch, 8, 'laying a floor');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} spends a while on hands and knees laying a new floor.`, 'work.hammer.build');
    ctx.need({ fun: 6, rested: -5 });
    ctx.learn('handy', 3);
    ctx.say(`You lay ${words.toLowerCase()}, edge to edge. Your footsteps sound different in here now.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, `move.step.${f.surface}`] });
  },
});

registry.register({
  name: 'rooms', aliases: ['my rooms', 'house tour', 'tour', 'floor plan'], free: true,
  help: { topic: 'home', usage: 'rooms', blurb: 'Every room of your home, what is in it, and which way it is.' },
  async run(ctx) {
    const homeId = ctx.life.home;
    if (!homeId) return ctx.fail('No place of your own yet. "listings" shows what is for rent.');
    const main = await MooRoom.findOne({ roomId: homeId }).lean();
    if (!main) return ctx.fail('Your place is not there any more. "listings" to find another.');
    const extras = await extraRooms(homeId);
    const all = [main, ...extras];
    const stuff = await MooItem.find({ 'location.type': 'room', 'location.id': { $in: all.map((r) => r.roomId) }, 'props.furniture': { $exists: true } }).select('name location').lean();
    const lines = all.map((r) => {
      const dir = Object.entries(main.exits || {}).find(([, to]) => to === r.roomId);
      const things = stuff.filter((s) => s.location.id === r.roomId).map((s) => s.name);
      const where = r.roomId === homeId ? 'the front room' : `the ${r.props.home.roomType}${dir ? `, ${DIR_WORDS[dir[0]]} from the front room` : ''}`;
      return `${cap(where)}: ${things.length ? things.join(', ') : 'empty'}${r.props.style && r.props.style.walls ? `; ${r.props.style.walls} walls` : ''}${r.props.style && r.props.style.floor ? `; ${r.props.style.floor} floor` : ''}.`;
    });
    ctx.say(`${cap(ctx.life.homeName || 'Your place')}, ${plural(all.length, 'room')}. ${lines.join(' ')}`);
    return ctx.ok({ choices: all.filter((r) => r.roomId !== ctx.ch.roomId).map((r) => ({ label: `Go to ${r.roomId === homeId ? 'the front room' : `the ${r.props.home.roomType}`}`, cmd: `go to ${r.roomId}` })) });
  },
});

/* ── KEEPSAKES AT HOME ─────────────────────────────────────────────────── */
async function hasHere(ctx, type) {
  const room = await ctx.room();
  if (!room || !room.props || !room.props.home) return false;
  return !!(await MooItem.exists({ 'location.type': 'room', 'location.id': room.roomId, 'props.furniture': type }));
}
function keepsake(def) {
  registry.register({
    name: def.name, aliases: def.aliases || [],
    help: { topic: 'home', usage: def.name, blurb: def.blurb },
    when: (ctx) => hasHere(ctx, def.type),
    whyNot: () => def.whyNot,
    async run(ctx) {
      if (def.check) { const why = def.check(ctx); if (why) return ctx.fail(why); }
      await setBusy(ctx.ch, def.secs || 6, def.doing);
      ctx.need(def.needs);
      if (def.skill) ctx.learn(def.skill, def.xp || 2);
      const line = typeof def.line === 'function' ? def.line(ctx) : pick(def.line);
      if (def.emote) await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} ${def.emote}`, def.sound);
      ctx.say(line);
      return ctx.ok({ kinds: [...ctx.kinds, ...(def.sound ? [def.sound] : [])] });
    },
    buttons: async (ctx) => ((await hasHere(ctx, def.type)) ? [{ label: def.label, cmd: def.name, group: 'here' }] : []),
  });
}
const SKY = [
  'You find the Dipper, then follow its edge to the star that does not move. The city is loud below you and none of it reaches up here.',
  'Saturn is up tonight. Through the eyepiece it is small and sharp and ringed, like somebody drew it on purpose.',
  'The moon fills the whole lens. You can see the shadows of mountains along its edge.',
  'A meteor cuts across the corner of the sky and is gone before you can say anything. You say something anyway.',
  'You find the three stars of the belt, then the fuzzy smudge below them where new stars are being made.',
  'A satellite crawls across the dark, steady as a bus on its route.',
];
keepsake({ name: 'stargaze', aliases: ['use the telescope', 'look through the telescope', 'look at the stars'], type: 'telescope', label: 'Stargaze', doing: 'stargazing', blurb: 'At home with a telescope, after dark.', whyNot: 'You need a telescope at home for that. It is on the reward shelf ("rewards").', needs: { fun: 15, rested: 6 }, skill: 'learning', xp: 4, secs: 10, sound: 'obj.telescope.turn',
  check: () => (worldClock().dark ? (['rain', 'storm', 'fog', 'overcast'].includes(require('../reverie').weatherNow().kind) ? 'Clouds tonight. The telescope shows you the underside of the weather.' : null) : 'It is still light out. The stars will wait for you.'),
  line: SKY, emote: 'bends to the telescope and goes quiet for a long while.' });
const FISH = ['The orange one chases the striped one around the castle, again, for reasons of its own.', 'The little gray fish hangs in the bubbles, perfectly still, like it is thinking.', 'All six fish come to the glass at once when you lean close, hoping you are food.', 'The bubbler hums. The plants sway. Your shoulders come down an inch.'];
keepsake({ name: 'watch the fish', aliases: ['watch fish', 'feed the fish', 'look at the fish tank'], type: 'fishtank', label: 'Watch the fish', doing: 'watching the fish', blurb: 'At home with a fish tank.', whyNot: 'No fish tank here. One is on the reward shelf ("rewards").', needs: { rested: 10, fun: 8 }, sound: 'obj.water.bubbles', line: FISH });
const RECORDS = ['"Ferry Boat Blues", scratchy and slow.', '"Dance Me Down to Line Street", the one with the trumpet.', '"Wrong Bell Waltz", which somebody wrote about this city and never admitted it.', '"Tomato Stake Stomp", played too fast on purpose.', '"Pier Seven at Midnight", mostly bass and rain.', '"Sweetwater Sunday", which makes everybody sway a little.'];
keepsake({ name: 'play the jukebox', aliases: ['jukebox', 'pick a record', 'play a record'], type: 'jukebox', label: 'Play the jukebox', doing: 'dancing to the jukebox', blurb: 'At home with a jukebox. Fun, and Music practice.', whyNot: 'No jukebox here. One is on the reward shelf ("rewards").', needs: { fun: 14, company: 2 }, skill: 'music', xp: 2, sound: 'obj.jukebox.play',
  line: () => `You drop a coin you did not need to drop and pick ${pick(RECORDS)} The arm swings over, the needle lands, and the room fills up.`, emote: 'feeds the jukebox and the room fills with music.' });
keepsake({ name: 'swing in the hammock', aliases: ['hammock', 'lie in the hammock', 'nap in the hammock'], type: 'hammock', label: 'Swing in the hammock', doing: 'swinging in the hammock', blurb: 'At home with a hammock. Rest and fun, both.', whyNot: 'No hammock here. One is on the reward shelf ("rewards").', needs: { rested: 16, fun: 6 }, secs: 8, sound: 'obj.hammock.creak',
  line: ['The ropes creak and the hammock rocks you slow. You do not fall asleep. You are just resting your eyes.', 'You swing with one foot on the floor, pushing off now and then, going nowhere, happily.'] });
keepsake({ name: 'watch the lava lamp', aliases: ['lava lamp', 'stare at the lava lamp'], type: 'lavalamp', label: 'Watch the lava lamp', doing: 'watching the lava lamp', blurb: 'At home with a lava lamp.', whyNot: 'No lava lamp here. One is on the reward shelf ("rewards").', needs: { fun: 6, rested: 6 }, sound: 'obj.lamp.hum',
  line: ['A red blob rises, splits in two, and one half sinks back. The lamp hums. You watch the whole thing and feel better for it.', 'The wax takes its time. So do you.'] });
registry.register({
  name: 'lie in the grass', aliases: ['lie on the grass', 'look at the sky', 'sunbathe', 'cloud watch'],
  help: { topic: 'home', usage: 'lie in the grass', blurb: 'In your own yard. Rest, and the sky.' },
  when: async (ctx) => { const r = await ctx.room(); return !!(r && r.props && r.props.home && r.props.home.roomType === 'yard'); },
  whyNot: () => 'That is for your own yard. "build room yard" at home adds one.',
  async run(ctx) {
    const c = worldClock();
    const wx = require('../reverie').weatherNow().kind;
    await setBusy(ctx.ch, 8, 'lying in the grass');
    ctx.need({ rested: 12, fun: 8 });
    ctx.say(['rain', 'storm'].includes(wx) ? 'You lie in the wet grass and let it rain on you. It is a choice. It is a good one.' : c.dark ? 'You lie on your back in the grass. The stars are out over the fence, and the city hums past them.' : 'You lie on your back in the grass. A cloud goes by shaped like a ferry, then like nothing at all.');
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return r && r.props && r.props.home && r.props.home.roomType === 'yard' ? [{ label: 'Lie in the grass', cmd: 'lie in the grass', group: 'here' }] : []; },
});

module.exports = { KINDS, COLORS, colorHex, floorOf, styleLine, feelLine, homeHere, extraRooms, MAX_ROOMS };
