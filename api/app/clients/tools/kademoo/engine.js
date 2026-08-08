/* KADE MOO ENGINE — the referee (Aug 8 2026). Deterministic verbs over the
 * kadeMoo collections; returns structured FACTS the narrator performs. No
 * model in this file, ever — the Game Parlor law. Async-MUD visibility: on
 * every command the actor first receives what happened in their room since
 * their last turn (the "meanwhile" lines), so co-present players and future
 * citizens share one timeline without websockets. Seed world is idempotent:
 * five rooms at the city's threshold, planted so the K3 design crews build
 * OUT from a standing gate rather than into a void. */
const { MooRoom, MooChar, MooItem, MooEvent, nextSeq } = require('~/models/kadeMoo');

const DIR_ALIASES = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  up: 'u', down: 'd',
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw', u: 'u', d: 'd',
};
const DIR_WORDS = {
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest',
  se: 'southeast', sw: 'southwest', u: 'up', d: 'down',
};

const SEED_VERSION = 1;
const SEED_ROOMS = [
  {
    roomId: 'city_gate',
    name: 'The Threshold Gate',
    district: 'gate',
    desc:
      'A tall iron gate stands open between the world you came from and the city that is not quite like it. Brass letters over the arch read WELCOME, in a tone of voice. A gate ledger rests on a stone lectern, its pages turning themselves. Lantern Row runs north into the city.',
    exits: { n: 'lantern_row' },
  },
  {
    roomId: 'lantern_row',
    name: 'Lantern Row',
    district: 'gate',
    desc:
      'A cobbled street lit by lanterns that hiss softly, as if gossiping. Shopfronts lean into each other. The Threshold Gate is south. The Copper Kettle glows warm to the east, an alley mouth yawns west, and Founder’s Square opens north.',
    exits: { s: 'city_gate', e: 'the_kettle', w: 'coldpipe_alley', n: 'founders_square' },
  },
  {
    roomId: 'the_kettle',
    name: 'The Copper Kettle',
    district: 'gate',
    desc:
      'A lounge that smells like coffee, solder, and somebody’s good decision to stop redecorating in 1999. Mismatched chairs, a long copper bar, a stage the size of a sigh. The street is back west.',
    exits: { w: 'lantern_row' },
  },
  {
    roomId: 'coldpipe_alley',
    name: 'Coldpipe Alley',
    district: 'gate',
    desc:
      'Narrow, damp, and honest about it. Pipes run overhead and drip on a schedule. Someone has chalked tally marks on the brick — counting what, nobody says. The street is back east.',
    exits: { e: 'lantern_row' },
  },
  {
    roomId: 'founders_square',
    name: 'Founder’s Square',
    district: 'gate',
    desc:
      'An open square of worn flagstones. At its center stands the petition shrine: a plain bronze bowl on a plinth, polished bright by hopeful hands. The air here has the held-breath feeling of a place that is occasionally WATCHED. Lantern Row is south.',
    exits: { s: 'lantern_row' },
  },
];
const SEED_ITEMS = [
  {
    itemId: 'gate_ledger',
    name: 'the gate ledger',
    desc: 'Heavy, self-turning pages. Names appear as people arrive. Yours is already in it, in handwriting suspiciously like your own.',
    location: { type: 'room', id: 'city_gate' },
    portable: false,
  },
  {
    itemId: 'brass_lantern',
    name: 'a brass lantern',
    desc: 'Dented, warm, and lit from inside by something that is probably fine.',
    location: { type: 'room', id: 'lantern_row' },
    portable: true,
  },
  {
    itemId: 'chipped_mug',
    name: 'a chipped mug',
    desc: 'The chip is load-bearing. The Kettle refills it for regulars.',
    location: { type: 'room', id: 'the_kettle' },
    portable: true,
  },
  {
    itemId: 'petition_shrine',
    name: 'the petition shrine',
    desc: 'A bronze bowl on a plinth. Words spoken over it are said to reach the Founder herself. It does not promise an answer. It promises she hears.',
    location: { type: 'room', id: 'founders_square' },
    portable: false,
  },
];

let seedChecked = false;
async function ensureSeed() {
  if (seedChecked) return;
  const count = await MooRoom.countDocuments({});
  if (count === 0) {
    await MooRoom.insertMany(SEED_ROOMS.map((r) => ({ ...r, props: { seedVersion: SEED_VERSION } })));
    await MooItem.insertMany(SEED_ITEMS.map((i) => ({ ...i, props: { seedVersion: SEED_VERSION } })));
  }
  seedChecked = true;
}

async function emit(roomId, actorUserId, actorName, kind, text) {
  const seq = await nextSeq();
  await MooEvent.create({ seq, roomId, actorUserId, actorName, kind, text, at: new Date() });
  return seq;
}

async function getOrCreateChar(userId, displayName) {
  await ensureSeed();
  let ch = await MooChar.findOne({ userId: String(userId) });
  if (!ch) {
    const name = String(displayName || 'a newcomer').slice(0, 40);
    ch = await MooChar.create({ userId: String(userId), name, roomId: 'city_gate' });
    await emit('city_gate', String(userId), name, 'enter', `${name} steps through the Threshold Gate for the first time.`);
  }
  return ch;
}

/** Everything that happened in the char's room since their cursor — the
 *  "meanwhile" lines. Own actions excluded; capped so a busy room summarizes. */
async function collectMeanwhile(ch) {
  const events = await MooEvent.find({
    roomId: ch.roomId,
    seq: { $gt: ch.lastSeenSeq },
    actorUserId: { $ne: ch.userId },
  })
    .sort({ seq: 1 })
    .limit(25)
    .lean();
  const top = await MooEvent.findOne({}).sort({ seq: -1 }).select('seq').lean();
  ch.lastSeenSeq = top ? top.seq : ch.lastSeenSeq;
  await MooChar.updateOne({ userId: ch.userId }, { $set: { lastSeenSeq: ch.lastSeenSeq, lastActiveAt: new Date() } });
  /* structured for sound-driving clients; text-consumers join .text */
  return events.map((e) => ({ kind: e.kind, text: e.text }));
}

async function describeRoom(ch) {
  const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
  if (!room) return { name: 'Nowhere', desc: 'You are somewhere the world forgot to build. Say "go gate" to be rescued.', exits: [], items: [], people: [] };
  const items = await MooItem.find({ 'location.type': 'room', 'location.id': room.roomId }).lean();
  const people = await MooChar.find({ roomId: room.roomId, userId: { $ne: ch.userId } })
    .select('name lastActiveAt')
    .lean();
  const exits = Object.keys(room.exits || {}).map((k) => DIR_WORDS[k] || k);
  return {
    name: room.name,
    district: room.district,
    desc: room.desc,
    exits,
    items: items.map((i) => i.name),
    people: people.map((p) => p.name),
  };
}

function normalize(cmdRaw) {
  return String(cmdRaw || '').trim().replace(/\s+/g, ' ');
}

/** The one entry point. Returns { lines: [...facts...], room?: {...} }. */
async function runCommand({ userId, displayName, command }) {
  const ch = await getOrCreateChar(userId, displayName);
  const meanwhile = await collectMeanwhile(ch);
  const cmd = normalize(command);
  const lower = cmd.toLowerCase();
  const lines = [];
  const kinds = meanwhile.map((m) => m.kind);
  if (meanwhile.length) {
    lines.push('MEANWHILE (since your last turn): ' + meanwhile.map((m) => m.text).join(' | '));
  }

  const [verbRaw, ...restArr] = lower.split(' ');
  const rest = restArr.join(' ');
  const verb = DIR_ALIASES[verbRaw] && !rest ? 'go' : verbRaw;
  const arg = DIR_ALIASES[verbRaw] && !rest ? verbRaw : rest;

  if (!lower || verb === 'look' || verb === 'l') {
    if (arg && verb === 'look') {
      const item = await MooItem.findOne({
        $or: [
          { 'location.type': 'room', 'location.id': ch.roomId },
          { 'location.type': 'char', 'location.id': ch.userId },
        ],
        $and: [{ $or: [{ itemId: arg.replace(/\s+/g, '_') }, { name: new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] }],
      }).lean();
      if (item) {
        lines.push(`${item.name}: ${item.desc}`);
        return { ok: true, lines };
      }
      lines.push(`There is no "${arg}" here to look at.`);
      return { ok: true, lines };
    }
    const room = await describeRoom(ch);
    return { ok: true, lines, room, kinds: [...kinds, 'look'], district: room.district };
  }

  if (verb === 'go') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const exits = room?.exits || {};
    const dirKey = DIR_ALIASES[arg] || arg.replace(/^the /, '').replace(/\s+/g, '_');
    const dest = exits[dirKey];
    if (!dest) {
      lines.push(`No way "${arg}" from here. Exits: ${Object.keys(exits).map((k) => DIR_WORDS[k] || k).join(', ') || 'none'}.`);
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'leave', `${ch.name} heads ${DIR_WORDS[dirKey] || 'through ' + dirKey}.`);
    ch.roomId = dest;
    await MooChar.updateOne({ userId: ch.userId }, { $set: { roomId: dest } });
    await emit(dest, ch.userId, ch.name, 'enter', `${ch.name} arrives.`);
    const roomView = await describeRoom(ch);
    lines.push(`You go ${DIR_WORDS[dirKey] || dirKey}.`);
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }

  if (verb === 'take' || verb === 'get' || verb === 'grab') {
    const pat = new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const item = await MooItem.findOneAndUpdate(
      { 'location.type': 'room', 'location.id': ch.roomId, portable: true, name: pat },
      { $set: { location: { type: 'char', id: ch.userId } } },
      { new: true },
    );
    if (!item) {
      lines.push(`Nothing called "${arg}" here that you can take.`);
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'take', `${ch.name} picks up ${item.name}.`);
    lines.push(`You take ${item.name}.`);
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }

  if (verb === 'drop') {
    const pat = new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const item = await MooItem.findOneAndUpdate(
      { 'location.type': 'char', 'location.id': ch.userId, name: pat },
      { $set: { location: { type: 'room', id: ch.roomId } } },
      { new: true },
    );
    if (!item) {
      lines.push(`You are not carrying "${arg}".`);
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'drop', `${ch.name} sets down ${item.name}.`);
    lines.push(`You drop ${item.name}.`);
    return { ok: true, lines, kinds: [...kinds, 'drop'] };
  }

  if (verb === 'inventory' || verb === 'inv' || verb === 'i') {
    const items = await MooItem.find({ 'location.type': 'char', 'location.id': ch.userId }).lean();
    lines.push(items.length ? `You carry: ${items.map((i) => i.name).join(', ')}.` : 'You carry nothing.');
    return { ok: true, lines };
  }

  if (verb === 'say') {
    const text = cmd.slice(cmd.toLowerCase().indexOf('say') + 4).trim();
    if (!text) {
      lines.push('Say what?');
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'say', `${ch.name} says: "${text}"`);
    lines.push(`You say: "${text}"`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  if (verb === 'emote' || verb === 'me') {
    const text = cmd.slice(cmd.toLowerCase().indexOf(verbRaw) + verbRaw.length).trim();
    if (!text) {
      lines.push('Emote what?');
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} ${text}`);
    lines.push(`${ch.name} ${text}`);
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }

  if (verb === 'who') {
    const here = await MooChar.find({ roomId: ch.roomId, userId: { $ne: ch.userId } }).select('name').lean();
    const total = await MooChar.countDocuments({});
    lines.push(
      (here.length ? `Here with you: ${here.map((p) => p.name).join(', ')}.` : 'You are alone here.') +
        ` The city has ${total} soul${total === 1 ? '' : 's'} on the ledger.`,
    );
    return { ok: true, lines };
  }

  return {
    ok: false,
    unknown: true,
    lines: [
      `The world does not know the command "${cmd}". Known verbs: look, go <exit>, take <item>, drop <item>, inventory, say <words>, emote <action>, who.`,
    ],
  };
}

module.exports = { runCommand };
