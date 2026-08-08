/* KADE MOO ENGINE — the referee (Aug 8 2026). Deterministic verbs over the
 * kadeMoo collections; returns structured FACTS the narrator performs. No
 * model in this file, ever — the Game Parlor law. Async-MUD visibility: on
 * every command the actor first receives what happened in their room since
 * their last turn (the "meanwhile" lines), so co-present players and future
 * citizens share one timeline without websockets. Seed world is idempotent:
 * five rooms at the city's threshold, planted so the K3 design crews build
 * OUT from a standing gate rather than into a void. */
const { MooRoom, MooChar, MooItem, MooEvent, MooDistrict, MooSound, nextSeq } = require('~/models/kadeMoo');

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
  let ch = await MooChar.findOne({ userId: String(userId), active: true });
  if (!ch) {
    ch = await MooChar.findOne({ userId: String(userId) });
    if (ch) {
      await MooChar.updateOne({ _id: ch._id }, { $set: { active: true } });
    }
  }
  if (!ch) {
    const name = String(displayName || 'a newcomer').slice(0, 40);
    ch = await MooChar.create({ userId: String(userId), name, roomId: 'city_gate', active: true });
    await emit('city_gate', String(userId), name, 'enter', `${name} steps through the Threshold Gate for the first time.`);
  }
  return ch;
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** World time = Missouri time, honestly. Buckets for flavor + future
 *  room.props.nightDesc hooks. */
function worldTime() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
  const h = parseInt(fmt.format(new Date()), 10) % 24;
  const bucket =
    h < 5 ? 'the dead of night' :
    h < 8 ? 'early morning' :
    h < 12 ? 'morning' :
    h < 17 ? 'afternoon' :
    h < 21 ? 'evening' : 'night';
  return { hour: h, bucket };
}

/** Find one item by loose name among candidate locations. */
async function findItem(name, locations) {
  const pat = new RegExp(escapeRe(name), 'i');
  return MooItem.findOne({ $or: locations.map((l) => ({ 'location.type': l.type, 'location.id': l.id })), name: pat });
}

/** Everything that happened in the char's room since their cursor — the
 *  "meanwhile" lines. Own actions excluded; capped so a busy room summarizes. */
async function collectMeanwhile(ch) {
  const events = await MooEvent.find({
    roomId: { $in: [ch.roomId, `whisper:${ch.userId}`] },
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
async function runCommand({ userId, displayName, command, isWizard = false }) {
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
      if (arg.startsWith('in ')) {
        const boxName = arg.slice(3).trim();
        const box = await findItem(boxName, [
          { type: 'room', id: ch.roomId },
          { type: 'char', id: ch.userId },
        ]);
        if (!box) {
          lines.push(`No "${boxName}" here to look inside.`);
          return { ok: false, lines };
        }
        const contents = await MooItem.find({ 'location.type': 'item', 'location.id': box.itemId }).lean();
        lines.push(contents.length ? `Inside ${box.name}: ${contents.map((i) => i.name).join(', ')}.` : `${box.name} is empty.`);
        return { ok: true, lines };
      }
      const item = await MooItem.findOne({
        $or: [
          { 'location.type': 'room', 'location.id': ch.roomId },
          { 'location.type': 'char', 'location.id': ch.userId },
        ],
        $and: [{ $or: [{ itemId: arg.replace(/\s+/g, '_') }, { name: new RegExp(escapeRe(arg), 'i') }] }],
      }).lean();
      if (item) {
        lines.push(`${item.name}: ${item.desc}`);
        return { ok: true, lines };
      }
      const person = await MooChar.findOne({ roomId: ch.roomId, name: new RegExp('^' + escapeRe(arg) + '$', 'i') }).lean();
      if (person) {
        const pdesc = person.attrs?.desc || `${person.name} keeps their look to themselves, so far.`;
        const marks = Array.isArray(person.attrs?.marks) && person.attrs.marks.length ? ` Marks: ${person.attrs.marks.join(', ')}.` : '';
        lines.push(`${person.name}: ${pdesc}${marks}`);
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
    const lockKey = room?.props?.locks?.[dirKey];
    if (dest && lockKey) {
      lines.push(`The way ${DIR_WORDS[dirKey] || dirKey} is locked. (unlock ${DIR_WORDS[dirKey] || dirKey} — if you carry the right key.)`);
      return { ok: false, lines, kinds: [...kinds] };
    }
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

  if ((verb === 'take' || verb === 'get' || verb === 'grab') && !/ from /i.test(rest)) {
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

  /* ── OBJECT DEPTH (KadeCore): containers, giving, keys ─────────────────── */
  if (verb === 'put') {
    // put <item> in <container>
    const m = rest.match(/^(.+?)\s+in(?:to)?\s+(.+)$/i);
    if (!m) {
      lines.push('Usage: put <item> in <container>.');
      return { ok: false, lines };
    }
    const item = await findItem(m[1].trim(), [{ type: 'char', id: ch.userId }, { type: 'room', id: ch.roomId }]);
    if (!item || !item.portable) {
      lines.push(`You have no "${m[1].trim()}" to put anywhere.`);
      return { ok: false, lines };
    }
    const box = await findItem(m[2].trim(), [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
    if (!box || box.itemId === item.itemId) {
      lines.push(`No "${m[2].trim()}" here to put things in.`);
      return { ok: false, lines };
    }
    await MooItem.updateOne({ itemId: item.itemId }, { $set: { location: { type: 'item', id: box.itemId } } });
    await emit(ch.roomId, ch.userId, ch.name, 'drop', `${ch.name} puts ${item.name} in ${box.name}.`);
    lines.push(`You put ${item.name} in ${box.name}.`);
    return { ok: true, lines, kinds: [...kinds, 'drop'] };
  }
  if ((verb === 'get' || verb === 'take' || verb === 'grab') && / from /i.test(rest)) {
    const m = rest.match(/^(.+?)\s+from\s+(.+)$/i);
    const box = await findItem(m[2].trim(), [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
    if (!box) {
      lines.push(`No "${m[2].trim()}" here.`);
      return { ok: false, lines };
    }
    const pat = new RegExp(escapeRe(m[1].trim()), 'i');
    const item = await MooItem.findOneAndUpdate(
      { 'location.type': 'item', 'location.id': box.itemId, name: pat },
      { $set: { location: { type: 'char', id: ch.userId } } },
      { new: true },
    );
    if (!item) {
      lines.push(`Nothing like "${m[1].trim()}" inside ${box.name}.`);
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'take', `${ch.name} takes ${item.name} out of ${box.name}.`);
    lines.push(`You take ${item.name} from ${box.name}.`);
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }
  if (verb === 'give') {
    // give <item> to <player>
    const m = rest.match(/^(.+?)\s+to\s+(.+)$/i);
    if (!m) {
      lines.push('Usage: give <item> to <person>.');
      return { ok: false, lines };
    }
    const target = await MooChar.findOne({ roomId: ch.roomId, name: new RegExp('^' + escapeRe(m[2].trim()) + '$', 'i') });
    if (!target) {
      lines.push(`No one called "${m[2].trim()}" is here.`);
      return { ok: false, lines };
    }
    const pat = new RegExp(escapeRe(m[1].trim()), 'i');
    const item = await MooItem.findOneAndUpdate(
      { 'location.type': 'char', 'location.id': ch.userId, name: pat },
      { $set: { location: { type: 'char', id: target.userId } } },
      { new: true },
    );
    if (!item) {
      lines.push(`You are not carrying "${m[1].trim()}".`);
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'drop', `${ch.name} gives ${item.name} to ${target.name}.`);
    lines.push(`You give ${item.name} to ${target.name}.`);
    return { ok: true, lines, kinds: [...kinds, 'drop'] };
  }
  if (verb === 'unlock') {
    const dirKey = DIR_ALIASES[rest.trim().toLowerCase()] || rest.trim().toLowerCase();
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const lockItem = room?.props?.locks?.[dirKey];
    if (!lockItem) {
      lines.push('Nothing locked that way.');
      return { ok: false, lines };
    }
    const key = await MooItem.findOne({ itemId: lockItem, 'location.type': 'char', 'location.id': ch.userId }).lean();
    if (!key) {
      lines.push('You do not carry the key that fits.');
      return { ok: false, lines, kinds: [...kinds, 'err'] };
    }
    await MooRoom.updateOne({ roomId: ch.roomId }, { $unset: { [`props.locks.${dirKey}`]: '' } });
    await emit(ch.roomId, ch.userId, ch.name, 'system', `${ch.name} unlocks the way ${DIR_WORDS[dirKey] || dirKey}.`);
    lines.push(`Click. The way ${DIR_WORDS[dirKey] || dirKey} is open.`);
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }

  /* ── SOCIAL + IDENTITY (KadeCore) ──────────────────────────────────────── */
  if (verb === 'whisper') {
    // whisper <name> <text>
    const m = rest.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      lines.push('Usage: whisper <name> <words>.');
      return { ok: false, lines };
    }
    const target = await MooChar.findOne({ roomId: ch.roomId, name: new RegExp('^' + escapeRe(m[1]) + '$', 'i') }).lean();
    if (!target) {
      lines.push(`No "${m[1]}" here to whisper to.`);
      return { ok: false, lines };
    }
    const seq = await nextSeq();
    /* Private channel: whisper events live on roomId whisper:<userId>, which
     * only that user's collectMeanwhile reads. */
    await MooEvent.create({ seq, roomId: `whisper:${target.userId}`, actorUserId: ch.userId, actorName: ch.name, kind: 'whisper', text: `${ch.name} whispers to you: "${m[2]}"`, at: new Date() });
    lines.push(`You whisper to ${target.name}: "${m[2]}"`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }
  if (verb === 'page') {
    const m = rest.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      lines.push('Usage: page <name> <words> — reaches them anywhere in the city.');
      return { ok: false, lines };
    }
    const target = await MooChar.findOne({ name: new RegExp('^' + escapeRe(m[1]) + '$', 'i') }).lean();
    if (!target) {
      lines.push(`No character called "${m[1]}" on the ledger.`);
      return { ok: false, lines };
    }
    const seq = await nextSeq();
    await MooEvent.create({ seq, roomId: `whisper:${target.userId}`, actorUserId: ch.userId, actorName: ch.name, kind: 'page', text: `${ch.name} pages you from ${ch.roomId}: "${m[2]}"`, at: new Date() });
    lines.push(`You page ${target.name}: "${m[2]}"`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }
  if (lower.startsWith('describe me as ')) {
    const dtext = cmd.slice(15).trim().slice(0, 600);
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.desc': dtext } });
    lines.push('So you appear, from now on.');
    return { ok: true, lines };
  }
  if (verb === 'where') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    lines.push(`You are in ${room?.name || ch.roomId}, ${room?.district || 'somewhere'} district.`);
    return { ok: true, lines };
  }
  if (verb === 'time') {
    const t = worldTime();
    lines.push(`It is ${t.bucket} in the city.`);
    return { ok: true, lines };
  }
  if (verb === 'coins' || verb === 'money') {
    lines.push(`You carry ${ch.attrs?.coin || 0} coin.`);
    return { ok: true, lines };
  }
  if (verb === 'exits') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const ex = Object.keys(room?.exits || {}).map((k) => DIR_WORDS[k] || k);
    lines.push('Exits: ' + (ex.join(', ') || 'none') + '.');
    return { ok: true, lines };
  }

  /* ── CHARACTERS (her RS Games shape: several playable characters, one active) ── */
  if (verb === 'chars' || verb === 'characters') {
    const all = await MooChar.find({ userId: ch.userId }).select('name roomId active').lean();
    lines.push('Your characters: ' + all.map((c) => `${c.name}${c.active ? ' (active)' : ''}`).join(', ') + '.');
    return { ok: true, lines };
  }
  if (verb === 'newchar') {
    const name = cmd.slice(cmd.toLowerCase().indexOf('newchar') + 8).trim().slice(0, 40);
    if (!name) {
      lines.push('Name the character: newchar <name>.');
      return { ok: false, lines };
    }
    const exists = await MooChar.findOne({ userId: ch.userId, name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).lean();
    if (exists) {
      lines.push(`You already have a character named ${exists.name}.`);
      return { ok: false, lines };
    }
    await MooChar.updateMany({ userId: ch.userId }, { $set: { active: false } });
    await MooChar.create({ userId: ch.userId, name, roomId: 'city_gate', active: true });
    await emit('city_gate', ch.userId, name, 'enter', `${name} steps through the Threshold Gate for the first time.`);
    lines.push(`${name} is born at the Threshold Gate, and you are now playing them. (Switch back anytime: switch <name>.)`);
    return { ok: true, lines, kinds: [...kinds, 'enter'] };
  }
  if (verb === 'switch') {
    const name = rest.trim();
    if (!name) {
      lines.push('Switch to whom? Try: chars');
      return { ok: false, lines };
    }
    const target = await MooChar.findOne({ userId: ch.userId, name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
    if (!target) {
      lines.push(`No character of yours named "${name}". Try: chars`);
      return { ok: false, lines };
    }
    await MooChar.updateMany({ userId: ch.userId }, { $set: { active: false } });
    await MooChar.updateOne({ _id: target._id }, { $set: { active: true } });
    lines.push(`You are now ${target.name}.`);
    return { ok: true, lines };
  }

  /* ── WIZARDRY (owner/admin only — the #2 workflow: walk and build) ─────────
   * The LambdaMOO law wearing this house's clothes: wizards shape the world
   * through VERBS, never through the model's imagination. Every act of
   * creation is chronicled — the world FEELS the god working. */
  if (verbRaw.startsWith('@')) {
    if (!isWizard) {
      lines.push('The air ignores you. (Builder commands belong to the Founder and her deputies.)');
      return { ok: false, lines };
    }
    const wverb = verbRaw.slice(1);
    if (wverb === 'dig') {
      // @dig <dir> <Room Name...>
      const parts = rest.split(' ');
      const dirKey = DIR_ALIASES[(parts[0] || '').toLowerCase()];
      const roomName = parts.slice(1).join(' ').trim();
      if (!dirKey || !roomName) {
        lines.push('Usage: @dig <direction> <Room Name> — carves a new room that way, doors linked both ways.');
        return { ok: false, lines };
      }
      const newId = slugify(roomName) || 'room_' + Date.now();
      const clash = await MooRoom.findOne({ roomId: newId }).lean();
      if (clash) {
        lines.push(`A room with the id "${newId}" already exists (${clash.name}).`);
        return { ok: false, lines };
      }
      const here = await MooRoom.findOne({ roomId: ch.roomId }).lean();
      const OPP = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw', u: 'd', d: 'u' };
      const back = OPP[dirKey] || 'back';
      await MooRoom.create({
        roomId: newId,
        name: roomName,
        district: here?.district || 'gate',
        desc: 'Freshly carved from nothing, still smelling faintly of possibility. (@desc it when the words come.)',
        exits: { [back]: ch.roomId },
        props: {},
        createdBy: ch.userId,
      });
      await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { [`exits.${dirKey}`]: newId } });
      await emit(ch.roomId, ch.userId, ch.name, 'system', `Reality shivers: a way ${DIR_WORDS[dirKey]} opens where there was none.`);
      lines.push(`Dug: ${roomName} (${newId}) to the ${DIR_WORDS[dirKey]}, linked both ways.`);
      return { ok: true, lines, kinds: [...kinds, 'enter'] };
    }
    if (wverb === 'desc') {
      const text = rest.trim();
      if (!text) {
        lines.push('Usage: @desc <text> — rewrites this room\'s description.');
        return { ok: false, lines };
      }
      await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { desc: text.slice(0, 2000) } });
      await emit(ch.roomId, ch.userId, ch.name, 'system', 'The room seems to remember itself differently now.');
      lines.push('Description set.');
      return { ok: true, lines };
    }
    if (wverb === 'create') {
      // @create <name> ; <desc>
      const [namePart, ...descParts] = rest.split(';');
      const iname = (namePart || '').trim();
      const idesc = descParts.join(';').trim() || 'It resists description, for now.';
      if (!iname) {
        lines.push('Usage: @create <item name> ; <description> — conjures a portable item here.');
        return { ok: false, lines };
      }
      const itemId = slugify(iname) + '_' + Date.now().toString(36);
      await MooItem.create({ itemId, name: iname, desc: idesc.slice(0, 1000), location: { type: 'room', id: ch.roomId }, portable: true, props: {} });
      await emit(ch.roomId, ch.userId, ch.name, 'system', `${iname} simply exists now, as if it always had.`);
      lines.push(`Created: ${iname}.`);
      return { ok: true, lines, kinds: [...kinds, 'take'] };
    }
    if (wverb === 'tp' || wverb === 'teleport') {
      const dest = slugify(rest);
      const room = await MooRoom.findOne({ roomId: dest }).lean();
      if (!room) {
        lines.push(`No room with id "${dest}". Try @rooms.`);
        return { ok: false, lines };
      }
      await emit(ch.roomId, ch.userId, ch.name, 'leave', `${ch.name} vanishes.`);
      ch.roomId = dest;
      await MooChar.updateOne({ _id: ch._id }, { $set: { roomId: dest } });
      await emit(dest, ch.userId, ch.name, 'enter', `${ch.name} appears from nowhere.`);
      const roomView = await describeRoom(ch);
      lines.push(`You are elsewhere.`);
      return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
    }
    if (wverb === 'rooms') {
      const rooms = await MooRoom.find({}).select('roomId name district').sort({ roomId: 1 }).limit(100).lean();
      lines.push('Rooms: ' + rooms.map((r) => `${r.roomId} (${r.name})`).join(', ') + '.');
      return { ok: true, lines };
    }
    if (wverb === 'itemdesc') {
      const [namePart, ...descParts] = rest.split(';');
      const iname = (namePart || '').trim();
      const idesc = descParts.join(';').trim();
      if (!iname || !idesc) {
        lines.push('Usage: @itemdesc <item> ; <new description>');
        return { ok: false, lines };
      }
      const item = await findItem(iname, [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
      if (!item) {
        lines.push(`No "${iname}" here.`);
        return { ok: false, lines };
      }
      await MooItem.updateOne({ itemId: item.itemId }, { $set: { desc: idesc.slice(0, 1000) } });
      lines.push(`${item.name} re-described.`);
      return { ok: true, lines };
    }
    if (wverb === 'exit') {
      const parts = rest.split(' ');
      const dirKey = DIR_ALIASES[(parts[0] || '').toLowerCase()] || (parts[0] || '').toLowerCase();
      const destId = slugify(parts.slice(1).join(' '));
      const destRoom = await MooRoom.findOne({ roomId: destId }).lean();
      if (!dirKey || !destRoom) {
        lines.push('Usage: @exit <direction> <roomId> (see @rooms). Links one-way; @exit from the far side to make it mutual.');
        return { ok: false, lines };
      }
      await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { [`exits.${dirKey}`]: destId } });
      lines.push(`Linked: ${DIR_WORDS[dirKey] || dirKey} now leads to ${destRoom.name}.`);
      return { ok: true, lines };
    }
    if (wverb === 'unexit') {
      const dirKey = DIR_ALIASES[rest.trim().toLowerCase()] || rest.trim().toLowerCase();
      await MooRoom.updateOne({ roomId: ch.roomId }, { $unset: { [`exits.${dirKey}`]: '' } });
      lines.push(`The way ${DIR_WORDS[dirKey] || dirKey} is no more.`);
      return { ok: true, lines };
    }
    if (wverb === 'zap') {
      const item = await findItem(rest.trim(), [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
      if (!item) {
        lines.push(`No "${rest.trim()}" here to unmake.`);
        return { ok: false, lines };
      }
      await MooItem.deleteOne({ itemId: item.itemId });
      await MooItem.updateMany({ 'location.type': 'item', 'location.id': item.itemId }, { $set: { location: { type: 'room', id: ch.roomId } } });
      await emit(ch.roomId, ch.userId, ch.name, 'system', `${item.name} stops having ever been. Anything inside spills out.`);
      lines.push(`Unmade: ${item.name}.`);
      return { ok: true, lines };
    }
    if (wverb === 'set') {
      const m = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!m) {
        lines.push('Usage: @set me|here|<player>|item:<name> <path> <value>. Value parses as JSON when it can, else string. Example: @set me standing 5');
        return { ok: false, lines };
      }
      const targetRaw = m[1];
      const path = m[2];
      const valueRaw = m[3];
      let value;
      try { value = JSON.parse(valueRaw); } catch (e) { value = valueRaw.trim(); }
      const safePath = path.replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 80);
      if (!safePath || safePath.startsWith('_')) {
        lines.push('That path is not settable.');
        return { ok: false, lines };
      }
      const t = targetRaw.toLowerCase();
      if (t === 'here') {
        await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { [`props.${safePath}`]: value } });
        lines.push(`Room property ${safePath} set.`);
        return { ok: true, lines };
      }
      if (t.startsWith('item:')) {
        const item = await findItem(targetRaw.slice(5).replace(/_/g, ' '), [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
        if (!item) {
          lines.push('No such item here.');
          return { ok: false, lines };
        }
        await MooItem.updateOne({ itemId: item.itemId }, { $set: { [`props.${safePath}`]: value } });
        lines.push(`${item.name}: property ${safePath} set.`);
        return { ok: true, lines };
      }
      const target = t === 'me' ? ch : await MooChar.findOne({ name: new RegExp('^' + escapeRe(targetRaw) + '$', 'i') });
      if (!target) {
        lines.push(`No character "${targetRaw}".`);
        return { ok: false, lines };
      }
      await MooChar.updateOne({ _id: target._id }, { $set: { [`attrs.${safePath}`]: value } });
      lines.push(`${target.name}: attribute ${safePath} set.`);
      return { ok: true, lines };
    }
    if (wverb === 'get') {
      const targetRaw = rest.trim();
      const t = targetRaw.toLowerCase();
      if (t === 'here' || t === '') {
        const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
        lines.push(`Room ${room.roomId} props: ${JSON.stringify(room.props || {})} | exits: ${JSON.stringify(room.exits || {})}`);
        return { ok: true, lines };
      }
      if (t === 'me') {
        lines.push(`${ch.name} attrs: ${JSON.stringify(ch.attrs || {})}`);
        return { ok: true, lines };
      }
      if (t.startsWith('item:')) {
        const item = await findItem(targetRaw.slice(5).replace(/_/g, ' '), [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]);
        lines.push(item ? `${item.name}: ${JSON.stringify({ props: item.props, portable: item.portable, location: item.location })}` : 'No such item here.');
        return { ok: Boolean(item), lines };
      }
      const target = await MooChar.findOne({ name: new RegExp('^' + escapeRe(targetRaw) + '$', 'i') }).lean();
      lines.push(target ? `${target.name}: room ${target.roomId}, attrs ${JSON.stringify(target.attrs || {})}` : `No character "${targetRaw}".`);
      return { ok: Boolean(target), lines };
    }
    if (wverb === 'deputize' || wverb === 'undeputize') {
      const target = await MooChar.findOne({ name: new RegExp('^' + escapeRe(rest.trim()) + '$', 'i') });
      if (!target) {
        lines.push(`No character "${rest.trim()}".`);
        return { ok: false, lines };
      }
      const on = wverb === 'deputize';
      await MooChar.updateOne({ _id: target._id }, { $set: { 'attrs.builder': on } });
      await emit(ch.roomId, ch.userId, ch.name, 'system', on ? `${target.name} is raised to deputy — the world will answer their hands now.` : `${target.name}'s building hands are stilled.`);
      lines.push(`${target.name} ${on ? 'is now a deputy builder' : 'is no longer a deputy'}.`);
      return { ok: true, lines };
    }
    if (wverb === 'lockexit' || wverb === 'unlockexit') {
      const parts = rest.split(' ');
      const dirKey = DIR_ALIASES[(parts[0] || '').toLowerCase()] || (parts[0] || '').toLowerCase();
      if (wverb === 'unlockexit') {
        await MooRoom.updateOne({ roomId: ch.roomId }, { $unset: { [`props.locks.${dirKey}`]: '' } });
        lines.push(`The way ${DIR_WORDS[dirKey] || dirKey} forgets its lock.`);
        return { ok: true, lines };
      }
      const keyName = parts.slice(1).join(' ').trim();
      const key = keyName ? await findItem(keyName, [{ type: 'room', id: ch.roomId }, { type: 'char', id: ch.userId }]) : null;
      if (!dirKey || !key) {
        lines.push('Usage: @lockexit <direction> <key item here or carried> — that item becomes the key.');
        return { ok: false, lines };
      }
      await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { [`props.locks.${dirKey}`]: key.itemId } });
      lines.push(`The way ${DIR_WORDS[dirKey] || dirKey} is locked; ${key.name} is its key.`);
      return { ok: true, lines };
    }
    if (wverb === 'district') {
      const parts = rest.split(' ');
      const did = slugify(parts[0] || '');
      if (!did) {
        lines.push('Usage: @district <districtId> [<Display Name>] — tags this room into a district (created if new).');
        return { ok: false, lines };
      }
      const dname = parts.slice(1).join(' ').trim() || did.replace(/_/g, ' ');
      await MooDistrict.updateOne({ districtId: did }, { $setOnInsert: { name: dname, desc: '', props: {} } }, { upsert: true });
      await MooRoom.updateOne({ roomId: ch.roomId }, { $set: { district: did } });
      lines.push(`This room now belongs to the ${dname} district.`);
      return { ok: true, lines };
    }
    if (wverb === 'districts') {
      const ds = await MooDistrict.find({}).select('districtId name').lean();
      const counts = await MooRoom.aggregate([{ $group: { _id: '$district', n: { $sum: 1 } } }]);
      const byId = Object.fromEntries(counts.map((c) => [c._id, c.n]));
      lines.push(ds.length ? 'Districts: ' + ds.map((d) => `${d.districtId} (${d.name}, ${byId[d.districtId] || 0} rooms)`).join(', ') + '.' : 'No districts registered yet — raw room tags: ' + Object.keys(byId).join(', '));
      return { ok: true, lines };
    }
    if (wverb === 'coin') {
      const m = rest.match(/^(\S+)\s+(-?\d+)$/);
      const target = m ? await MooChar.findOne({ name: new RegExp('^' + escapeRe(m[1]) + '$', 'i') }) : null;
      if (!target) {
        lines.push('Usage: @coin <player> <amount> — grants (negative removes) coin.');
        return { ok: false, lines };
      }
      const amt = parseInt(m[2], 10);
      await MooChar.updateOne({ _id: target._id }, { $inc: { 'attrs.coin': amt } });
      lines.push(`${target.name} ${amt >= 0 ? 'gains' : 'loses'} ${Math.abs(amt)} coin.`);
      return { ok: true, lines };
    }
    if (wverb === 'sound') {
      const parts = rest.split(' ');
      const scopeType = (parts[0] || '').toLowerCase();
      if (scopeType === 'clear') {
        await MooSound.deleteOne({ scopeType: (parts[1] || '').toLowerCase(), scopeId: parts[2] === 'here' ? ch.roomId : (parts[2] || '') });
        lines.push('Sound cleared.');
        return { ok: true, lines };
      }
      const scopeId = parts[1] === 'here' ? ch.roomId : (parts[1] || '');
      const url = parts.slice(2).join(' ').trim();
      if (!['event', 'room', 'district'].includes(scopeType) || !scopeId || !/^https?:\/\//.test(url)) {
        lines.push('Usage: @sound event <kind> <url> · @sound room here <url> · @sound district <id> <url> · @sound clear <type> <id>. Kinds: move, look, take, drop, say, emote, enter, leave, err.');
        return { ok: false, lines };
      }
      await MooSound.updateOne({ scopeType, scopeId }, { $set: { url, addedBy: ch.userId } }, { upsert: true });
      lines.push(`Sound installed: ${scopeType} ${scopeId}. Clients pick it up on next load.`);
      return { ok: true, lines };
    }
    lines.push(`Unknown wizardry "@${wverb}". Builder: @dig, @desc, @create, @itemdesc, @exit, @unexit, @tp, @rooms. Wizard adds: @set, @get, @zap, @deputize, @lockexit, @unlockexit, @district, @districts, @coin, @sound.`);
    return { ok: false, lines };
  }

  return {
    ok: false,
    unknown: true,
    lines: [
      `The world does not know the command "${cmd}". Known verbs: look, look <thing>, look in <container>, go <exit>, take, drop, put <item> in <box>, get <item> from <box>, give <item> to <person>, inventory, say, emote, whisper <name> <words>, page <name> <words>, describe me as <text>, unlock <dir>, where, time, coins, exits, who, chars, newchar <name>, switch <name>.`,
    ],
  };
}

module.exports = { runCommand };
