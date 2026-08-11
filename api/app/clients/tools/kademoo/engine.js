/* KADE MOO ENGINE — the referee (Aug 8 2026). Deterministic verbs over the
 * kadeMoo collections; returns structured FACTS the narrator performs. No
 * model in this file, ever — the Game Parlor law. Async-MUD visibility: on
 * every command the actor first receives what happened in their room since
 * their last turn (the "meanwhile" lines), so co-present players and future
 * citizens share one timeline without websockets. Seed world is idempotent:
 * five rooms at the city's threshold, planted so the K3 design crews build
 * OUT from a standing gate rather than into a void. */
const { MooRoom, MooChar, MooItem, MooEvent, MooDistrict, MooSound, nextSeq } = require('~/models/kadeMoo');
const axios = require('axios');
/* REVERIE (Aug 10 2026): the carved city, the census, weather, and the tick —
 * all deterministic, all in reverie.js. The engine stays the referee. */
const reverie = require('./reverie');

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
  /* Reverie rides the same boot check: idempotent, insert-if-absent,
   * never overwrites a room her hands or the Angel's have touched. */
  try { await reverie.carveReverie(); } catch (e) { /* fail-soft: the gate still stands */ }
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
    ch = await MooChar.create({ userId: String(userId), name, roomId: 'city_gate', active: true, attrs: { alive: true, coin: 20, lastMeal: Date.now(), lastSleep: Date.now() } });
    await emit('city_gate', String(userId), name, 'enter', `${name} steps through the Threshold Gate for the first time.`);
  }
  /* LAW 3 (the Meanwhile): the world never punishes leaving. Away a day or
   * more? Somebody fed you before you came back. Hollow/Frayed only accrue
   * during play, never during absence. */
  const awayMs = Date.now() - new Date(ch.lastActiveAt || Date.now()).getTime();
  if (awayMs > 20 * 60 * 60 * 1000) {
    const nowMs = Date.now();
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.lastMeal': nowMs, 'attrs.lastSleep': nowMs } });
    ch.attrs = { ...(ch.attrs || {}), lastMeal: nowMs, lastSleep: nowMs };
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
    .select('name userId attrs.posture lastActiveAt')
    .lean();
  const exits = Object.keys(room.exits || {}).map((k) => DIR_WORDS[k] || k);
  return {
    name: room.name,
    district: room.district,
    desc: room.props?.outdoor ? `${room.desc} ${reverie.weatherNow().line}` : room.desc,
    exits,
    items: items.map((i) => i.name),
    people: people.map((p) => {
      const doing = p.userId && p.userId.startsWith('npc:') ? reverie.npcDoingNow(p.userId) : null;
      if (doing && doing.doing) return `${p.name} (${doing.doing})`;
      if (p.attrs?.posture && p.attrs.posture !== 'standing') return `${p.name} (${p.attrs.posture})`;
      return p.name;
    }),
  };
}

function normalize(cmdRaw) {
  return String(cmdRaw || '').trim().replace(/\s+/g, ' ');
}

/** The one entry point. Returns { lines: [...facts...], room?: {...} }. */
async function runCommand({ userId, displayName, command, isWizard = false }) {
  const ch = await getOrCreateChar(userId, displayName);
  await reverie.tickWorld();
  const meanwhile = await collectMeanwhile(ch);
  const cmd = normalize(command);
  const lower = cmd.toLowerCase();
  const lines = [];
  const kinds = meanwhile.map((m) => m.kind);
  if (meanwhile.length) {
    const recapText = meanwhile.map((m) => m.text).join(' | ').slice(0, 1500);
    lines.push('MEANWHILE (since your last turn): ' + recapText);
    MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.lastMeanwhile': recapText } }).catch(() => {});
    ch.attrs = { ...(ch.attrs || {}), lastMeanwhile: recapText };
  }

  const [verbRaw, ...restArr] = lower.split(' ');
  const rest = restArr.join(' ');
  /* KADE 2026-08-11: `rest` comes off the LOWERCASED command, which is right
   * for syntax (directions, verbs, ids) and wrong for CONTENT. Every builder
   * verb was writing lowercase into the world: room descriptions, item names,
   * item prose, attribute values -- and, the bug that surfaced it, @sound URLs
   * (an S3 presigned signature is case-sensitive, so a lowercased URL 401s on
   * her phone). `restRaw` is the same text with its case intact. Rule: parse
   * with `rest`, STORE from `restRaw`. The say/emote/speak/newchar verbs
   * already did this by hand via cmd.slice(); this generalises it. */
  const restRaw = cmd.slice(verbRaw.length).trim();
  const verb = DIR_ALIASES[verbRaw] && !rest ? 'go' : verbRaw;
  const arg = DIR_ALIASES[verbRaw] && !rest ? verbRaw : rest;

  /* ROUNDTIME (Part 4): doing a thing takes seconds, and the world says so.
   * Senses stay free — only hands and feet wait. */
  const FREE_VERBS = new Set(['look', 'l', 'recap', 'status', 'me', 'time', 'weather', 'exits', 'where', 'who', 'inventory', 'inv', 'i', 'coins', 'money', 'help', 'chars', 'map', 'dir', 'watch']);
  const busyUntil = ch.attrs?.busyUntil || 0;
  if (busyUntil > Date.now() && !FREE_VERBS.has(verb) && !verbRaw.startsWith('@')) {
    const secs = Math.ceil((busyUntil - Date.now()) / 1000);
    lines.push(`You are mid-${ch.attrs?.busyDoing || 'something'} — about ${secs} second${secs === 1 ? '' : 's'} left. (Senses are free: look, recap, status.)`);
    return { ok: false, lines };
  }
  async function setBusy(seconds, doing) {
    const until = Date.now() + seconds * 1000;
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.busyUntil': until, 'attrs.busyDoing': doing } });
  }

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
        const posture = person.attrs?.posture && person.attrs.posture !== 'standing' ? ` They are ${person.attrs.posture}.` : '';
        lines.push(`${person.name}: ${pdesc}${marks}${posture}`);
        return { ok: true, lines };
      }
      lines.push(`There is no "${arg}" here to look at.`);
      return { ok: true, lines };
    }
    const room = await describeRoom(ch);
    return { ok: true, lines, room, kinds: [...kinds, 'look'], district: room.district };
  }

  if (verb === 'go' && /^to\s+/i.test(arg)) {
    /* AUTOWALK (v2 plan: the single biggest QoL feature): "go to the pier"
     * walks you there. BFS over the street map; locked ways refuse. */
    const wanted = arg.replace(/^to\s+(the\s+)?/i, '').trim();
    if (!wanted) { lines.push('Go to where?'); return { ok: false, lines }; }
    const allRooms = await MooRoom.find({}).select('roomId name exits props.locks district').lean();
    const byId = Object.fromEntries(allRooms.map((r) => [r.roomId, r]));
    const wLower = wanted.toLowerCase();
    let target = allRooms.find((r) => r.name.toLowerCase() === wLower || r.roomId === wLower.replace(/\s+/g, '_'))
      || allRooms.find((r) => r.name.toLowerCase().includes(wLower))
      || allRooms.find((r) => r.roomId.includes(wLower.replace(/\s+/g, '_')));
    if (!target) { lines.push(`Nowhere called "${wanted}" on the map. Try: map`); return { ok: false, lines }; }
    if (target.roomId === ch.roomId) { lines.push('You are already there.'); return { ok: true, lines }; }
    const prev = { [ch.roomId]: null };
    const queue = [ch.roomId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === target.roomId) break;
      const r = byId[cur];
      if (!r) continue;
      for (const [dir, dest] of Object.entries(r.exits || {})) {
        if ((r.props?.locks || {})[dir]) continue;
        if (dest in prev || !byId[dest]) continue;
        prev[dest] = cur;
        queue.push(dest);
      }
    }
    if (!(target.roomId in prev)) { lines.push(`No walking way to ${target.name} from here. Some places are not reached by streets.`); return { ok: false, lines }; }
    let steps = 0;
    for (let cur = target.roomId; prev[cur]; cur = prev[cur]) steps++;
    const origin = ch.roomId;
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} sets off toward ${target.name}.`);
    ch.roomId = target.roomId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: target.roomId, 'attrs.prevRoom': origin } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin };
    await emit(target.roomId, ch.userId, ch.name, 'enter', `${ch.name} arrives from the streets.`);
    await setBusy(Math.min(3 + steps * 2, 18), 'walking');
    const roomView = await describeRoom(ch);
    lines.push(`You walk to ${target.name} — ${steps} street${steps === 1 ? '' : 's'} over.`);
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
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
    const originRoom = ch.roomId;
    ch.roomId = dest;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest, 'attrs.prevRoom': originRoom } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: originRoom };
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
    const here = await MooChar.find({ roomId: ch.roomId, userId: { $ne: ch.userId } }).select('name attrs.posture').lean();
    const total = await MooChar.countDocuments({});
    lines.push(
      (here.length ? `Here with you: ${here.map((p) => p.name + (p.attrs?.posture && p.attrs.posture !== 'standing' ? ' (' + p.attrs.posture + ')' : '')).join(', ')}.` : 'You are alone here.') +
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

  /* ── SOCIALS (her ask: sitting, standing, laughing — presence with a body) ── */
  if (verb === 'sit' || verb === 'stand' || verb === 'lie') {
    const posture = verb === 'lie' ? 'lying down' : verb === 'sit' ? 'sitting' : 'standing';
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.posture': posture } });
    if (verb !== 'stand') {
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} ${verb === 'sit' ? 'sits down' : 'lies down'}.`);
    } else {
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} stands up.`);
    }
    lines.push(verb === 'sit' ? 'You sit down.' : verb === 'lie' ? 'You lie down.' : 'You stand up.');
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }
  const SOCIALS = {
    laugh: ['You laugh.', 'laughs.'],
    giggle: ['You giggle.', 'giggles.'],
    smile: ['You smile.', 'smiles.'],
    grin: ['You grin.', 'grins.'],
    nod: ['You nod.', 'nods.'],
    wave: ['You wave.', 'waves.'],
    sigh: ['You sigh.', 'sighs.'],
    shrug: ['You shrug.', 'shrugs.'],
    clap: ['You clap.', 'claps.'],
    dance: ['You bust a little move.', 'busts a little move.'],
    yawn: ['You yawn.', 'yawns.'],
    hum: ['You hum a few bars of something.', 'hums a few bars of something.'],
  };
  if (SOCIALS[verb] && !rest) {
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} ${SOCIALS[verb][1]}`);
    lines.push(SOCIALS[verb][0]);
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }
  if (SOCIALS[verb] && rest.startsWith('at ')) {
    const targetName = rest.slice(3).trim();
    const target = await MooChar.findOne({ roomId: ch.roomId, name: new RegExp('^' + escapeRe(targetName) + '$', 'i') }).lean();
    if (target) {
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} ${SOCIALS[verb][1].replace('.', '')} at ${target.name}.`);
      lines.push(`${SOCIALS[verb][0].replace('.', '')} at ${target.name}.`);
      return { ok: true, lines, kinds: [...kinds, 'emote'] };
    }
    lines.push(`No \"${targetName}\" here.`);
    return { ok: false, lines };
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
    /* PART 3 — names come in parts. First and last, minimum; the full name is
     * unique like life; a hundred Rubies, one Ruby Boggs. */
    if (name.split(/\s+/).length < 2) {
      lines.push('The records office wants a family name too — first and last, like everyone on the ledger. There can be a hundred Rubies in Reverie but only one Ruby Boggs. Try: newchar <First Last>.');
      return { ok: false, lines };
    }
    const taken = await MooChar.findOne({ name: new RegExp('^' + escapeRe(name) + '$', 'i') }).lean();
    if (taken) {
      lines.push(`The records office checks the ledger and shakes its head — a ${name} already walks this city. Full names are one to a soul. Pick another last name, or another first.`);
      return { ok: false, lines };
    }
    const mooCount = await MooChar.countDocuments({ userId: ch.userId });
    if (mooCount >= 3) {
      lines.push('Three characters to an account — identities stay heavy here. A fourth slot is earned, not typed. (The Founder can grant one.)');
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


  /* ════ REVERIE SYSTEMS (Aug 10 2026 — from the v2 Founder's Plan) ════ */

  /* STATUS — the body as comfort, never a death timer (Part 6). */
  if (verb === 'status' || verb === 'me') {
    const nowMs = Date.now();
    const fed = (nowMs - (ch.attrs?.lastMeal || 0)) < 18 * 60 * 60 * 1000;
    const rested = (nowMs - (ch.attrs?.lastSleep || 0)) < 20 * 60 * 60 * 1000;
    const room = await MooRoom.findOne({ roomId: ch.roomId }).select('name district').lean();
    const bits = [];
    bits.push(`You are ${ch.name}, in ${room?.name || ch.roomId}.`);
    bits.push(fed ? 'Fed — the day sits easy on you.' : 'Hollow — you have not eaten in a while. Nothing is wrong. Food is where the people are.');
    bits.push(rested ? 'Rested.' : 'Frayed — the world reads a little blurry. Sleep anywhere safe to reset.');
    bits.push(`${ch.attrs?.coin || 0} coin in your pocket.`);
    if (Array.isArray(ch.attrs?.marks) && ch.attrs.marks.length) bits.push(`Marks: ${ch.attrs.marks.join(', ')}.`);
    if (ch.attrs?.openPetition?.text) bits.push(`One petition open: "${ch.attrs.openPetition.text}"`);
    if (ch.attrs?.openWish?.text) bits.push(`One wish in the drum: "${ch.attrs.openWish.text}"`);
    lines.push(bits.join(' '));
    return { ok: true, lines };
  }

  /* WEATHER — one sky, eight wards' worth of sound. */
  if (verb === 'weather' || verb === 'sky') {
    const w = reverie.weatherNow();
    lines.push(w.line + ' (Missouri weather. It is occasionally dramatic for no reason.)');
    return { ok: true, lines };
  }

  /* MAP — relationships, never grids (v1 law, kept). */
  if (verb === 'map') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).select('district').lean();
    const d = await MooDistrict.findOne({ districtId: room?.district || 'gate' }).lean();
    lines.push(d?.props?.mapLine || 'This part of the city keeps its shape to itself, so far.');
    if (d?.props?.soundLine) lines.push(`You know ${d.name || 'this ward'} by ear: ${d.props.soundLine}.`);
    return { ok: true, lines };
  }

  /* DIR — "what is there to do here?", answerable anywhere (v1 law, kept). */
  if (verb === 'dir' || verb === 'directory') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    lines.push(room?.props?.doings || 'Nothing formal here. Which in this city usually means: talk to somebody.');
    const ex = Object.keys(room?.exits || {}).map((k) => DIR_WORDS[k] || k);
    if (ex.length) lines.push('Ways out: ' + ex.join(', ') + '.');
    return { ok: true, lines };
  }

  /* RECAP — replay the last meanwhile for a reader that fell behind. */
  if (verb === 'recap') {
    lines.push(ch.attrs?.lastMeanwhile ? 'Last meanwhile, again: ' + ch.attrs.lastMeanwhile : 'Nothing to replay — your meanwhile is caught up.');
    return { ok: true, lines };
  }

  /* HOME and BACK — un-lose yourself (v1 law, kept). */
  if (verb === 'home') {
    const homeId = ch.attrs?.home || 'the_kettle';
    if (ch.roomId === homeId) { lines.push('You are already home.'); return { ok: true, lines }; }
    const origin = ch.roomId;
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} heads home.`);
    ch.roomId = homeId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: homeId, 'attrs.prevRoom': origin } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin };
    await emit(homeId, ch.userId, ch.name, 'enter', `${ch.name} comes in like they live here.`);
    await setBusy(4, 'walking home');
    const roomView = await describeRoom(ch);
    lines.push(ch.attrs?.home ? 'You make your way home.' : 'No place of your own yet — the Kettle keeps a corner warm for anyone. (A wizard can set your home with @set.)');
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }
  if (verb === 'back') {
    const prevId = ch.attrs?.prevRoom;
    if (!prevId) { lines.push('No steps to retrace yet.'); return { ok: false, lines }; }
    const there = await MooRoom.findOne({ roomId: prevId }).select('roomId').lean();
    if (!there) { lines.push('The way back is not there anymore.'); return { ok: false, lines }; }
    const origin = ch.roomId;
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} doubles back.`);
    ch.roomId = prevId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: prevId, 'attrs.prevRoom': origin } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin };
    await emit(prevId, ch.userId, ch.name, 'enter', `${ch.name} comes back.`);
    const roomView = await describeRoom(ch);
    lines.push('You retrace your steps.');
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }

  /* EAT — food is society, not fuel (Part 6, the Veil's answer). */
  if (verb === 'eat' || verb === 'order') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const food = room?.props?.food;
    if (!food) { lines.push('Nothing to eat here. Pat\'s, the taco window, Ruth-Ann\'s stoop, the truck stop — food is where the people are. (dir tells you what a place does.)'); return { ok: false, lines }; }
    const price = food.price || 0;
    const coin = ch.attrs?.coin || 0;
    if (price > coin) { lines.push(`That runs ${price} coin and you carry ${coin}. Ruth-Ann's stoop feeds anybody, no questions — or work a shift first (work, where there's work).`); return { ok: false, lines, kinds: [...kinds, 'err'] }; }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.lastMeal': Date.now() }, $inc: { 'attrs.coin': -price } });
    ch.attrs = { ...(ch.attrs || {}), lastMeal: Date.now(), coin: coin - price };
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} settles in to eat.`);
    lines.push(`You eat: ${food.menu}. ${price ? price + ' coin, well spent.' : 'No charge. Arguing about that has been tried.'} Warmth moves in. You are Fed.`);
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }

  /* SLEEP — anywhere safe resets Frayed. The world holds its noise down. */
  if (verb === 'sleep' || verb === 'rest' || verb === 'nap') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const safe = room?.props?.sleepable || (ch.attrs?.home && ch.attrs.home === ch.roomId);
    if (!safe) { lines.push('Not a sleeping spot. Mercy never closes, the Kettle keeps its corner, the clinic has chairs, the truck stop booths have held worse.'); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.lastSleep': Date.now(), 'attrs.posture': 'standing' } });
    ch.attrs = { ...(ch.attrs || {}), lastSleep: Date.now() };
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} sleeps a while, and the room keeps its voice down.`);
    await setBusy(6, 'sleeping');
    lines.push('You sleep. The world holds its noise down for you, and whatever happens lands in your meanwhile. You wake Rested.');
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }

  /* SPEAK — the Quiet (ratified law): say is mind-speech; speaking aloud is a
   * chosen act in your fitted voice. */
  if (verb === 'speak') {
    const text = cmd.slice(cmd.toLowerCase().indexOf('speak') + 6).trim();
    if (!text) { lines.push('Speak what, aloud? (Ordinary say is the Quiet — mind-speech. Speaking aloud carries weight: songs, toasts, testimony, proposals.)'); return { ok: false, lines }; }
    await emit(ch.roomId, ch.userId, ch.name, 'say', `${ch.name} speaks ALOUD, fitted voice carrying: "${text}"`);
    lines.push(`You speak aloud, and the room feels the difference: "${text}"`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* TALK TO — the census answers ($0: rotating lines; the narrator lane
   * inhabits them fully later). */
  if (verb === 'talk' && /^to\s+/i.test(rest)) {
    const who = rest.replace(/^to\s+/i, '').trim();
    const folks = await MooChar.find({ roomId: ch.roomId, userId: /^npc:/ }).lean();
    const target = folks.find((f) => f.name.toLowerCase().includes(who.toLowerCase()) || (f.attrs?.aka || '').toLowerCase() === who.toLowerCase());
    if (!target) { lines.push(`Nobody called "${who}" here to talk to.`); return { ok: false, lines }; }
    const def = reverie.CENSUS_BY_ID[target.userId];
    const line = def ? reverie.npcTalkLine(def) : `${target.name} nods at you, friendly enough.`;
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} stops to talk with ${target.name}.`);
    await emit(ch.roomId, target.userId, target.name, 'say', `${target.name}: ${line}`);
    lines.push(`${target.name}: ${line}`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* WORK — six shifts a day, then the world is sick of you (Part 7). */
  if (verb === 'work') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const job = room?.props?.job;
    if (!job) { lines.push('No work here. The docks, the Archive desk, Pat\'s sink, Dez\'s bar, the salvage scale, the garden plots, the fields — work is where the verbs are.'); return { ok: false, lines }; }
    const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const workDay = ch.attrs?.workDay === t ? (ch.attrs?.workCount || 0) : 0;
    if (workDay >= 6) { lines.push(job.refusal || 'The work waves you off. Six shifts is a day. Tomorrow exists for a reason.'); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.workDay': t, 'attrs.workCount': workDay + 1 }, $inc: { 'attrs.coin': job.wage } });
    ch.attrs = { ...(ch.attrs || {}), coin: (ch.attrs?.coin || 0) + job.wage };
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} works a shift at ${job.name}.`);
    await setBusy(12, 'working');
    lines.push(`${job.line} That is ${job.wage} coin — ${workDay + 1} of 6 shifts today.`);
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }

  /* TRAM and FERRY — the loops that stitch the wards (Part 2). */
  if (verb === 'tram') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    if (!room?.props?.tram) { lines.push('No tram stop here. The tram calls at Court Street, Front Street, Line Street, Gully Road, the Millrace, Sweetwater Park, and Fairlawn Avenue.'); return { ok: false, lines }; }
    const stops = await MooRoom.find({ 'props.tram': true }).select('roomId name district').lean();
    if (!rest) { lines.push('The tram calls at: ' + stops.map((s) => s.name).join(', ') + '. Ride one: tram <stop>.'); return { ok: true, lines }; }
    const wLower = rest.toLowerCase();
    const dest = stops.find((s) => s.roomId !== ch.roomId && (s.name.toLowerCase().includes(wLower) || s.district.includes(wLower.replace(/\s+/g, ''))));
    if (!dest) { lines.push(`The tram does not call anywhere called "${rest}". Stops: ` + stops.map((s) => s.name).join(', ') + '.'); return { ok: false, lines }; }
    const coin = ch.attrs?.coin || 0;
    if (coin < 1) { lines.push('Fare is 1 coin and your pocket disagrees. The Stairs are free and character-building.'); return { ok: false, lines, kinds: [...kinds, 'err'] }; }
    const origin = ch.roomId;
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} boards the tram.`);
    ch.roomId = dest.roomId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest.roomId, 'attrs.prevRoom': origin }, $inc: { 'attrs.coin': -1 } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin, coin: coin - 1 };
    await emit(dest.roomId, ch.userId, ch.name, 'enter', `${ch.name} steps off the tram.`);
    await setBusy(8, 'riding the tram');
    const roomView = await describeRoom(ch);
    lines.push(`The tram hums you across the city and lets you off at ${dest.name}. 1 coin.`);
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }
  if (verb === 'ferry') {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    if (!room?.props?.ferry) { lines.push('No ferry here. She ties up at the Hook dock and the Sweetwater pier.'); return { ok: false, lines }; }
    const destId = room.props.ferryTo;
    const dest = await MooRoom.findOne({ roomId: destId }).select('roomId name').lean();
    if (!dest) { lines.push('The far dock is not answering. Odd.'); return { ok: false, lines }; }
    const coin = ch.attrs?.coin || 0;
    if (coin < 1) { lines.push('Crossing is 1 coin. Captain Marsh takes IOUs from exactly nobody.'); return { ok: false, lines, kinds: [...kinds, 'err'] }; }
    const origin = ch.roomId;
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} steps aboard the ferry.`);
    ch.roomId = dest.roomId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest.roomId, 'attrs.prevRoom': origin }, $inc: { 'attrs.coin': -1 } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin, coin: coin - 1 };
    await emit(dest.roomId, ch.userId, ch.name, 'enter', `${ch.name} comes off the ferry.`);
    await setBusy(10, 'crossing the river');
    const roomView = await describeRoom(ch);
    lines.push(`The ferry takes it slow — conversational, the Captain calls it — and ties up at ${dest.name}. 1 coin.`);
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }

  /* FLATTEN PENNY — the rails, built with love (Part 17.4). */
  if (verb === 'flatten' || (verb === 'put' && /penny.*rail/i.test(rest))) {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    if (!room?.props?.rails) { lines.push('No rails here to flatten anything on. The grade crossing is out past the ring road.'); return { ok: false, lines }; }
    await setBusy(12, 'waiting on the freight');
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
    const itemId = 'flat_penny_' + Date.now().toString(36);
    await MooItem.create({ itemId, name: 'a flattened penny (' + t + ')', desc: `Warm, thin as a leaf, stamped by the freight and the date: ${t}. Worthless. Priceless. Some folks leave one on a grave, a custom nobody remembers starting.`, location: { type: 'char', id: ch.userId }, portable: true, props: { keepsake: true } });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} sets a penny on the rail and stands well back. The rumble builds from far off, arrives like weather, and is gone.`);
    lines.push('You set the penny on the rail and stand WELL back, like you were raised to. The rumble builds from far off — you hear it before you feel it, feel it before you see it. Then the freight is past, and the penny is thin as a leaf and warm as a pocket. You take your flattened penny.');
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }

  /* BUY BRICK — everyone's pocket phone (Part 5), corner store issue. */
  if (verb === 'buy' && /brick/i.test(rest)) {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    if (ch.roomId !== 'corner_store') { lines.push('Bricks are corner-store business — the Patch corner store sells them over the counter.'); return { ok: false, lines }; }
    const coin = ch.attrs?.coin || 0;
    if (coin < 5) { lines.push('A brick runs 5 coin. The counter waits without judgment. Mostly.'); return { ok: false, lines }; }
    const has = await MooItem.findOne({ 'location.type': 'char', 'location.id': ch.userId, 'props.brick': true }).lean();
    if (has) { lines.push('You already carry a brick. Losing it is a whole bad day — which is to say, a story. Not today.'); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': -5 } });
    ch.attrs = { ...(ch.attrs || {}), coin: coin - 5 };
    const itemId = 'brick_' + Date.now().toString(36);
    await MooItem.create({ itemId, name: `${ch.name}'s brick`, desc: 'A pocket phone — folks call any phone a brick, even the thin ones. Old joke, stuck. Calls, texts, the Feed, the map. Yours now.', location: { type: 'char', id: ch.userId }, portable: true, props: { brick: true } });
    await emit(ch.roomId, ch.userId, ch.name, 'take', `${ch.name} buys a brick over the counter. The bell over the door approves.`);
    lines.push('Five coin across the counter and the brick is yours. Calls, texts, the Feed, the map — the city in your pocket.');
    return { ok: true, lines, kinds: [...kinds, 'take'] };
  }

  /* PETITION / PRAY — the god with a pager (Part 10). One open per soul;
   * rides the platform's real notify lane to the Founder's actual phone. */
  if (verb === 'petition' || verb === 'pray') {
    const text = cmd.slice(cmd.toLowerCase().indexOf(verbRaw) + verbRaw.length).trim().slice(0, 280);
    if (!text) {
      lines.push(ch.attrs?.openPetition?.text
        ? `One petition per soul, and yours is still on her desk: "${ch.attrs.openPetition.text}"`
        : 'Petition what? Speak it plain: petition <your words>. It reaches her. It does not promise an answer. It promises she hears.');
      return { ok: false, lines };
    }
    if (ch.attrs?.openPetition?.text) {
      lines.push(`One petition per soul — each one costs something to spend. Yours is still open: "${ch.attrs.openPetition.text}"`);
      return { ok: false, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.openPetition': { text, at: new Date().toISOString() } } });
    ch.attrs = { ...(ch.attrs || {}), openPetition: { text } };
    await emit(ch.roomId, ch.userId, ch.name, 'system', `A petition leaves ${ch.name}'s hands and the air takes it. Somewhere, a slot clears its throat politely.`);
    /* The real pager: bridge /notify → her actual phone. Fail-soft — the
     * petition stands in the chronicle either way. */
    try {
      const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
      const secret = process.env.NOTIFY_AGENT_SECRET || '';
      if (secret) {
        let adminId;
        try {
          const { findUser } = require('~/models');
          const admin = await findUser({ email: process.env.KADE_ADMIN_EMAIL || 'kademurdock@gmail.com' }, '_id');
          adminId = admin && admin._id ? String(admin._id) : undefined;
        } catch (_e) { /* fall through */ }
        await axios.post(`${bridgeUrl}/notify`, {
          secret, agentId: 'reverie_petition', agentName: 'Reverie',
          title: 'A petition from the city',
          body: `${ch.name}: "${text}"`,
          urgent: false, userId: adminId,
        }, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
      }
    } catch (e) {
      // The slot never explains itself.
    }
    lines.push('Your words go where words like these go. The world does not promise an answer. It promises she hears.');
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* WISH — the Drawing (Part 8). One open wish, asked for in your own words,
   * at the Mark Exchange where the drum turns weekly. */
  if (verb === 'wish') {
    const text = cmd.slice(cmd.toLowerCase().indexOf('wish') + 5).trim().slice(0, 280);
    if (ch.roomId !== 'mark_exchange' && ch.roomId !== 'wishing_fountain') {
      lines.push('Wishes go in at the Mark Exchange, where the drum turns once a week — or quieter, at the Sweetwater fountain.');
      return { ok: false, lines };
    }
    if (!text) {
      lines.push(ch.attrs?.openWish?.text ? `Your wish is in the drum: "${ch.attrs.openWish.text}" One at a time — that is what makes it cost something.` : 'Wish for what? Your own words: wish <the thing you cannot afford>.');
      return { ok: false, lines };
    }
    if (ch.attrs?.openWish?.text) {
      lines.push(`One open wish at a time — yours is still tumbling: "${ch.attrs.openWish.text}"`);
      return { ok: false, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.openWish': { text, at: new Date().toISOString(), where: ch.roomId } } });
    ch.attrs = { ...(ch.attrs || {}), openWish: { text } };
    if (ch.roomId === 'mark_exchange') {
      await emit(ch.roomId, ch.userId, ch.name, 'system', `${ch.name} writes a wish small and feeds it to the drum. The drum squeaks its blessing.`);
      lines.push('You write it small and feed it to the drum. Once a week the drum turns, a few wishes come out true, and the crier lane says whose. Luck draws — with a thumb on the scale for folks who give back.');
    } else {
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} throws a coin to the fountain and says something too quiet to carry.`);
      lines.push('A coin to the water, a wish to the world, logged where only the world can read it. Every so often one comes true with no announcement at all.');
    }
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* THE WINDOW — founder-only spectating (Part 18.2): present but not there.
   * The Peephole rule: nothing disturbed, nothing announced, no trace. */
  if (verb === 'watch' && isWizard) {
    const wanted = rest.trim().toLowerCase();
    if (!wanted) { lines.push('Watch what? A room id, a citizen, or a ward: watch pats_diner · watch pat · watch hook'); return { ok: false, lines }; }
    let roomIds = [];
    let label = wanted;
    const room = await MooRoom.findOne({ roomId: wanted.replace(/\s+/g, '_') }).lean();
    if (room) { roomIds = [room.roomId]; label = room.name; }
    if (!roomIds.length) {
      const citizen = await MooChar.findOne({ userId: /^npc:/, name: new RegExp(escapeRe(wanted), 'i') }).lean();
      if (citizen) { roomIds = [citizen.roomId]; label = `${citizen.name} (${(await MooRoom.findOne({ roomId: citizen.roomId }).select('name').lean())?.name || citizen.roomId})`; }
    }
    if (!roomIds.length) {
      const ward = await MooDistrict.findOne({ districtId: wanted.replace(/\s+/g, '') }).lean() || await MooDistrict.findOne({ name: new RegExp(escapeRe(wanted), 'i') }).lean();
      if (ward) {
        const wardRooms = await MooRoom.find({ district: ward.districtId }).select('roomId').lean();
        roomIds = wardRooms.map((r) => r.roomId);
        label = ward.name;
      }
    }
    if (!roomIds.length) { lines.push(`Nothing called "${wanted}" to watch.`); return { ok: false, lines }; }
    const events = await MooEvent.find({ roomId: { $in: roomIds } }).sort({ seq: -1 }).limit(10).lean();
    events.reverse();
    lines.push(`Behind the glass: ${label}. Citizens never know. The world never performs.`);
    if (roomIds.length === 1) {
      const r = await MooRoom.findOne({ roomId: roomIds[0] }).lean();
      const folks = await MooChar.find({ roomId: roomIds[0] }).select('name userId').lean();
      if (r) lines.push(`${r.name}: ${r.desc}`);
      if (folks.length) lines.push('Present: ' + folks.map((f) => f.userId.startsWith('npc:') ? `${f.name} (${(reverie.npcDoingNow(f.userId) || {}).doing || 'about'})` : f.name).join(', ') + '.');
    }
    lines.push(events.length ? 'Lately: ' + events.map((e) => e.text).join(' | ') : 'Lately: quiet.');
    return { ok: true, lines };
  }

  /* Founder's ledgers: open petitions and the drum's contents. */
  if ((verbRaw === '@petitions' || verbRaw === '@wishes') && isWizard) {
    const key = verbRaw === '@petitions' ? 'attrs.openPetition.text' : 'attrs.openWish.text';
    const holders = await MooChar.find({ [key]: { $exists: true, $ne: null } }).select('name attrs userId').lean();
    if (!holders.length) { lines.push(verbRaw === '@petitions' ? 'No petitions open. The slot sits quiet.' : 'The drum is empty. For now.'); return { ok: true, lines }; }
    for (const h of holders) {
      const o = verbRaw === '@petitions' ? h.attrs.openPetition : h.attrs.openWish;
      lines.push(`${h.name}: "${o.text}" (${(o.at || '').slice(0, 10)})`);
    }
    lines.push(verbRaw === '@petitions' ? 'Answer one with: @answered <name> — their petition clears and they are told it was heard.' : 'Grant one by hand and clear it with: @granted <name>.');
    return { ok: true, lines };
  }
  if ((verbRaw === '@answered' || verbRaw === '@granted') && isWizard) {
    const target = await MooChar.findOne({ name: new RegExp('^' + escapeRe(rest.trim().replace(/_/g, ' ')) + '$', 'i') });
    if (!target) { lines.push(`No character "${rest.trim()}".`); return { ok: false, lines }; }
    const field = verbRaw === '@answered' ? 'attrs.openPetition' : 'attrs.openWish';
    await MooChar.updateOne({ _id: target._id }, { $unset: { [field]: '' } });
    const seq = await nextSeq();
    const note = verbRaw === '@answered'
      ? 'Your petition has been heard. Not at the Office — the Office never answers. But heard.'
      : 'The drum turned, and your wish came out true. The crier lane will say so by morning.';
    await MooEvent.create({ seq, roomId: `whisper:${target.userId}`, actorUserId: null, actorName: 'the world', kind: 'whisper', text: note, at: new Date() });
    lines.push(`${target.name}'s ${verbRaw === '@answered' ? 'petition' : 'wish'} is cleared, and they will find out in the way the world does these things.`);
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
      const roomName = restRaw.split(' ').slice(1).join(' ').trim();
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
      const text = restRaw.trim();
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
      const [namePart, ...descParts] = restRaw.split(';');
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
      const [namePart, ...descParts] = restRaw.split(';');
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
      /* Names come in parts (Aug 10 2026): quote a spaced name — @set "Ruby
       * Boggs" standing 5 — or use underscores: @set Ruby_Boggs standing 5. */
      const m = rest.match(/^"([^"]+)"\s+(\S+)\s+([\s\S]+)$/) || rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!m) {
        lines.push('Usage: @set me|here|"<player name>"|item:<name> <path> <value>. Value parses as JSON when it can, else string. Example: @set me standing 5');
        return { ok: false, lines };
      }
      const targetRaw = m[1].replace(/_/g, ' ');
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
      const target = await MooChar.findOne({ name: new RegExp('^' + escapeRe(rest.trim().replace(/_/g, ' ')) + '$', 'i') });
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
      const m = rest.match(/^(.+?)\s+(-?\d+)$/);
      const target = m ? await MooChar.findOne({ name: new RegExp('^' + escapeRe(m[1].replace(/_/g, ' ')) + '$', 'i') }) : null;
      if (!target) {
        lines.push('Usage: @coin <player> <amount> — grants (negative removes) coin. Spaced names work plain: @coin Ruby Boggs 10.');
        return { ok: false, lines };
      }
      const amt = parseInt(m[2], 10);
      await MooChar.updateOne({ _id: target._id }, { $inc: { 'attrs.coin': amt } });
      lines.push(`${target.name} ${amt >= 0 ? 'gains' : 'loses'} ${Math.abs(amt)} coin.`);
      return { ok: true, lines };
    }
    if (wverb === 'sound') {
      const parts = rest.split(' ');
      const rawParts = restRaw.split(' ');
      const scopeType = (parts[0] || '').toLowerCase();
      if (scopeType === 'clear') {
        await MooSound.deleteOne({ scopeType: (parts[1] || '').toLowerCase(), scopeId: parts[2] === 'here' ? ch.roomId : (parts[2] || '') });
        lines.push('Sound cleared.');
        return { ok: true, lines };
      }
      const scopeId = parts[1] === 'here' ? ch.roomId : (parts[1] || '');
      const url = rawParts.slice(2).join(' ').trim(); // case-sensitive: signed URLs
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
      `The world does not know the command "${cmd}". Moving: go <exit>, go to <place>, tram, ferry, home, back, map, dir. Senses: look, look <thing>, exits, where, time, weather, who, status, recap. Hands: take, drop, put, get, give, inventory, coins, eat, sleep, work, flatten penny, buy brick. Voice: say (the Quiet), speak (aloud), emote, whisper <name> <words>, page <name> <words>, talk to <citizen>, petition <words>, wish <words>. Selves: describe me as <text>, chars, newchar <First Last>, switch <name>.`,
    ],
  };
}

module.exports = { runCommand };
