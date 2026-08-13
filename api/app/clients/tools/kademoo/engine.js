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
/* KADE 2026-08-13 (round 9): `logger` was used in this file and never
 * imported. The ledger caught it once already — a catch block whose logger
 * does not exist means the error HANDLING is the thing that throws, so a
 * non-fatal failure becomes a fatal one at exactly the moment you least want
 * it. It was reintroduced the first time this session too, by the overhearing
 * catch block, and caught by eslint no-undef rather than by anybody being
 * careful. Run the linter. */
const { logger } = require('@librechat/data-schemas');
/* REVERIE (Aug 10 2026): the carved city, the census, weather, and the tick —
 * all deterministic, all in reverie.js. The engine stays the referee. */
const reverie = require('./reverie');
const fishing = require('./fishing');
const social = require('./social');
const strays = require('./strays');
const overhear = require('./overhear');

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

async function emit(roomId, actorUserId, actorName, kind, text, sound) {
  const seq = await nextSeq();
  const doc = { seq, roomId, actorUserId, actorName, kind, text, at: new Date() };
  if (sound) doc.sound = sound;
  await MooEvent.create(doc);
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

/** World time rides Central so the city's clock matches the Founder's own.
 *  That is an IMPLEMENTATION fact and must never surface in-world: nothing
 *  a player reads may name a real place. Buckets for flavor + future
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
  /* KADE 2026-08-12: `sound` rides along beside `kind`. Additive, same shape
   * as the build-197 roomId addition -- a client that does not know the field
   * ignores it, and one that does plays the named file instead of the generic
   * earcon for the event's kind. */
  return events.map((e) => ({ kind: e.kind, text: e.text, sound: e.sound || null }));
}

async function describeRoom(ch) {
  const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
  if (!room) return { roomId: null, name: 'Nowhere', desc: 'You are somewhere the world forgot to build. Say "go gate" to be rescued.', exits: [], items: [], people: [] };
  const items = await MooItem.find({ 'location.type': 'room', 'location.id': room.roomId }).lean();
  const people = await MooChar.find({ roomId: room.roomId, userId: { $ne: ch.userId } })
    .select('name userId attrs.posture attrs.pose attrs.stray attrs.trust lastActiveAt')
    .lean();
  const exits = Object.keys(room.exits || {}).map((k) => DIR_WORDS[k] || k);
  return {
    /* KADE 2026-08-11 (build 197): roomId travels with the room. The sound
     * manifest has THREE scopes -- event, room, district -- and until now a
     * client was handed `district` but never the room's own id, so the whole
     * `room` scope was data nothing could ever reach. This one field completes
     * 16.1's three-layer sound design: ward bed (district) under room tone
     * (roomId) under the weather. Additive; every existing client ignores it. */
    roomId: room.roomId,
    name: room.name,
    district: room.district,
    desc: room.props?.outdoor ? `${room.desc} ${reverie.weatherNow().line}` : room.desc,
    exits,
    items: items.map((i) => i.name),
    /* WHO IS HERE, AND WHAT THEY ARE DOING (round 9). This list used to be
     * names, which is a chat window's user list. Order of precedence, most
     * specific first:
     *   1. a PLAYER'S OWN POSE — they said what they are doing, so say it
     *   2. an NPC's schedule — the census is always mid-something
     *   3. a stray's mood toward THIS reader — trust is per-person, so the
     *      same cat reads differently to two people standing side by side
     *   4. posture, then the bare name
     * This is the highest-leverage line in the file for a blind player:
     * `look` is the whole visual field, and this is the half of it that
     * moves. */
    people: people.map((p) => {
      if (p.attrs && p.attrs.pose) return `${p.name} ${p.attrs.pose}`;
      if (p.attrs && p.attrs.stray) {
        const t = (p.attrs.trust || {})[ch.userId] || 0;
        return `${p.name} (${strays.rungOf(t)})`;
      }
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
  /* KADE 2026-08-12: an event that NAMED a sound plays that file; everything
   * else falls back to its kind, exactly as before. The client already merges
   * every installed id into its sound map, so a wishlist id is simply a more
   * specific kind and no client change is needed for the meanwhile lane. */
  const kinds = meanwhile.map((m) => m.sound || m.kind);
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
  /* KADE 2026-08-12: `wait` and `listen` join the free list on purpose. The
   * Bite's reaction window starts the moment the bite reaches the player, and a
   * player holding the line and listening must never be told to hold on. */
  const FREE_VERBS = new Set(['look', 'l', 'recap', 'status', 'me', 'time', 'weather', 'exits', 'where', 'who', 'inventory', 'inv', 'i', 'coins', 'money', 'help', 'chars', 'map', 'dir', 'watch', 'wait', 'listen']);
  const busyUntil = ch.attrs?.busyUntil || 0;
  if (busyUntil > Date.now() && !FREE_VERBS.has(verb) && !verbRaw.startsWith('@')) {
    const secs = Math.ceil((busyUntil - Date.now()) / 1000);
    lines.push(`You are mid-${ch.attrs?.busyDoing || 'something'} — about ${secs} second${secs === 1 ? '' : 's'} left. (Senses are free: look, recap, status.)`);
    return { ok: false, lines };
  }
  /* How this character moves, read once per turn. null = the plain verbs. */
  const ws = social.walkStyleOf(ch);

  async function setBusy(seconds, doing) {
    const until = Date.now() + seconds * 1000;
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.busyUntil': until, 'attrs.busyDoing': doing } });
  }

  /* ── OVERHEARING (round 9) ───────────────────────────────────────────────
   * The room hears you. This is called by `say` and `speak`, and it is the
   * difference between a place and a chat window: before it, a citizen could
   * not hear an open remark AT ALL, and a room that does not answer you is
   * furniture — which is exactly how a player works out which chars are
   * synths. `talk to <citizen>` is a menu; this is a room.
   *
   * The four rules live in overhear.js. What lives HERE is rule 2 — one voice
   * at a time — because only the engine knows who is standing in the room.
   *
   * Returns the responder's line, or null for silence, which is a legitimate
   * answer and happens on purpose. Zero model calls. */
  async function roomAnswers(text) {
    try {
      const here = await MooChar.find({ roomId: ch.roomId, userId: /^npc:/ }).select('name userId').lean();
      if (!here.length) return null;
      const cands = here.map((n) => ({ id: n.userId.replace(/^npc:/, ''), name: n.name, userId: n.userId }));
      const who = overhear.chooseResponder(cands, text);
      if (!who) return null;
      const heardAll = (ch.attrs && ch.attrs.heard) || {};
      const heard = heardAll[who.userId] || [];
      const reply = overhear.overhearReply(who, text, { heard });
      if (!reply) return null;
      /* Rule 4 is per (player, npc) and it has to survive the turn, so it is
       * written before the line is spoken, not after. */
      const nextHeard = overhear.rememberLine(heard, reply.hash);
      await MooChar.updateOne({ _id: ch._id }, { $set: { [`attrs.heard.${who.userId}`]: nextHeard } });
      ch.attrs = { ...(ch.attrs || {}), heard: { ...heardAll, [who.userId]: nextHeard } };
      /* A line that already names the speaker (an action beat like "Pat lifts
       * the spatula") must not be prefixed again. */
      const spoken = reply.line.startsWith(who.name) ? reply.line : `${who.name}: ${reply.line}`;
      await emit(ch.roomId, who.userId, who.name, 'say', spoken);
      return spoken;
    } catch (err) {
      logger.error('[reverie] overhear failed (non-fatal):', err.message);
      return null;
    }
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
    await emit(origin, ch.userId, ch.name, 'leave', `${ch.name} ${ws ? ws.leave : 'sets'} off toward ${target.name}.`);
    ch.roomId = target.roomId;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: target.roomId, 'attrs.prevRoom': origin, 'attrs.pose': null } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: origin };
    await emit(target.roomId, ch.userId, ch.name, 'enter', ws ? `${ch.name} ${ws.enter} off the street.` : `${ch.name} arrives from the streets.`);
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
    await emit(ch.roomId, ch.userId, ch.name, 'leave', `${ch.name} ${ws ? ws.leave : 'heads'} ${DIR_WORDS[dirKey] || 'through ' + dirKey}.`);
    const originRoom = ch.roomId;
    ch.roomId = dest;
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest, 'attrs.prevRoom': originRoom, 'attrs.pose': null } });
    ch.attrs = { ...(ch.attrs || {}), prevRoom: originRoom };
    await emit(dest, ch.userId, ch.name, 'enter', ws ? `${ch.name} ${ws.enter}.` : `${ch.name} arrives.`);
    const roomView = await describeRoom(ch);
    lines.push(`You go ${DIR_WORDS[dirKey] || dirKey}.`);
    return { ok: true, lines, room: roomView, kinds: [...kinds, 'move'], district: roomView.district };
  }

  /* ORDERING NOTE (Aug 12 2026, found by losing a fish to it): this block sits
   * ABOVE the item verbs on purpose. `give` is how you ease line to a running
   * fish, and the generic `give <item> to <person>` handler was swallowing the
   * bare word before the fight ever saw it — the first live catch snapped off
   * mid-fight answering "Usage: give <item> to <person>." The guards below are
   * tight: every fishing verb except `cast` requires an active line, so nothing
   * here can shadow an ordinary command for a player who is not fishing. */
  /* ── THE BITE (Aug 12 2026) — fishing as a real-time listening test.
   * Her line: "a bite is a sound, not a text line." The nibble and the take are
   * two different files, built to be told apart in half a second, and every
   * verb below hands the client a sound id to play. No model in the loop and no
   * server timers: the state lives on the character, and the clock that matters
   * is the player's own. */
  const onTheLine = !!ch.attrs?.fishing;
  if (verb === 'cast'
      || (onTheLine && ['wait', 'listen', 'set', 'strike', 'hold', 'land', 'release'].includes(verb))
      || (onTheLine && verb === 'give' && !rest)
      || (onTheLine && verb === 'reel' && /^in\b/.test(rest))
      || (verb === 'sell' && !rest)) {
    const froom = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    let out = null;
    if (verb === 'cast') out = await fishing.cast(ch, froom);
    else if (verb === 'wait' || verb === 'listen') out = await fishing.waitOn(ch);
    else if (verb === 'set' || verb === 'strike') out = await fishing.setHook(ch);
    else if (verb === 'hold') out = await fishing.fight(ch, 'hold');
    else if (verb === 'give') out = await fishing.fight(ch, 'give');
    else if (verb === 'land') out = await fishing.land(ch);
    else if (verb === 'release') out = await fishing.release(ch);
    else if (verb === 'reel') out = await fishing.reelIn(ch);
    else if (verb === 'sell') out = await fishing.sellCatch(ch, froom);
    if (out) {
      for (const l of out.lines) lines.push(l);
      if (out.busy) await setBusy(out.busy, out.doing || 'fishing');
      return { ok: out.ok, lines, kinds: [...kinds], sounds: out.sounds || [] };
    }
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
    const attrInv = ch.attrs?.inventory || [];
    const all = [...items.map(i => i.name), ...attrInv.map(i => i.name)];
    lines.push(all.length ? `You carry: ${all.join(', ')}.` : 'You carry nothing.');
    return { ok: true, lines };
  }

  /* SELL <item> — sell a foraged or grown item at any merchant room */
  if (verb === 'sell' && rest) {
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    const hasMerchant = room?.props?.shop || room?.props?.job || ['the_salvage_yard', 'the_market', 'pats_diner', 'the_kettle', 'ruth_anns_stoop'].includes(ch.roomId);
    if (!hasMerchant) {
      lines.push('Nobody here to sell to. Try a shop, the market, the salvage yard, or anywhere food moves.');
      return { ok: false, lines };
    }
    const inv = ch.attrs?.inventory || [];
    const idx = inv.findIndex(i => i.name.toLowerCase() === rest.toLowerCase());
    if (idx === -1) {
      lines.push(`You don't have "${rest}" to sell. Check: inventory.`);
      return { ok: false, lines };
    }
    const item = inv[idx];
    const value = item.foraged ? 3 : item.grown ? 6 : 2;
    inv.splice(idx, 1);
    await MooChar.updateOne({ _id: ch._id }, {
      $set: { 'attrs.inventory': inv },
      $inc: { 'attrs.coin': value },
    });
    lines.push(`You sell ${item.name} for ${value} coin.`);
    return { ok: true, lines, sounds: ['obj.coins.drop'] };
  }

  /* GIVE <item> TO <name> — hand a foraged/grown item to another player.
   * Falls through to the MooItem give handler if item not in attrs.inventory. */
  if (verb === 'give' && rest && !/^\d+\s+coins?/i.test(rest)) {
    const gm = rest.match(/^(.+?)\s+to\s+(.+)$/i);
    if (gm) {
      const itemName = gm[1].trim();
      const recipName = gm[2].trim();
      const inv = ch.attrs?.inventory || [];
      const idx = inv.findIndex(i => i.name.toLowerCase() === itemName.toLowerCase());
      if (idx !== -1) {
        const recipient = await MooChar.findOne({
          roomId: ch.roomId,
          name: new RegExp('^' + escapeRe(recipName) + '$', 'i'),
          _id: { $ne: ch._id },
        }).lean();
        if (!recipient) {
          lines.push(`No "${recipName}" here.`);
          return { ok: false, lines };
        }
        const item = inv.splice(idx, 1)[0];
        const recipInv = recipient.attrs?.inventory || [];
        recipInv.push(item);
        await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.inventory': inv } });
        await MooChar.updateOne({ _id: recipient._id }, { $set: { 'attrs.inventory': recipInv } });
        await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} hands ${item.name} to ${recipient.name}.`);
        lines.push(`You give ${item.name} to ${recipient.name}.`);
        return { ok: true, lines, kinds: [...kinds, 'emote'] };
      }
      /* Not in attrs.inventory — fall through to MooItem give handler */
    }
  }

  if (verb === 'say') {
    const text = cmd.slice(cmd.toLowerCase().indexOf('say') + 4).trim();
    if (!text) {
      lines.push('Say what?');
      return { ok: false, lines };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'say', `${ch.name} says: "${text}"`);
    lines.push(`You say: "${text}"`);
    const answer = await roomAnswers(text);
    if (answer) lines.push(answer);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* ── EXTENDED EMOTES (round 9, Miriani's E2, the parts worth having) ──────
   * A plain `emote nods` behaves exactly as it always did. On top of that:
   *   *  your name (*1 first, *2 last)   -name  somebody or something here
   *   %he %him %his %himself             %{a,b,c}  pick one at random
   * Full grammar in social.js. What it unlocks is players writing scenes that
   * include other people correctly — the thing a soul table can never do,
   * because a soul table only knows the gestures somebody thought of first. */
  if (verb === 'emote' || (verb === 'me' && rest) || verbRaw === ':') {
    const text = cmd.slice(cmd.toLowerCase().indexOf(verbRaw) + verbRaw.length).trim();
    if (!text) {
      lines.push('Emote what? (`emote leans on the counter`, or point at somebody: `emote hands -merle the crate`.)');
      return { ok: false, lines };
    }
    const here = await MooChar.find({ roomId: ch.roomId, userId: { $ne: ch.userId } }).select('name attrs.pronouns').lean();
    const things = await MooItem.find({ 'location.type': 'room', 'location.id': ch.roomId }).select('name').lean();
    const pool = [
      ...here.map((c) => ({ name: c.name, kind: 'char', attrs: c.attrs || {} })),
      ...things.map((i) => ({ name: i.name, kind: 'item', attrs: {} })),
    ];
    const r = social.renderEmote(text, { name: ch.name, attrs: ch.attrs || {} }, pool);
    if (r.error) { lines.push(r.error); return { ok: false, lines }; }
    await emit(ch.roomId, ch.userId, ch.name, 'emote', r.text);
    lines.push(r.text);
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

  /* ══ THE STRAYS (round 9) ═══════════════════════════════════════════════
   *
   * VERB ORDERING — this block respects both bugs this project has already
   * paid for, and it is placed here on purpose:
   *   · BELOW the Bite, so bare `release` still eases line on a running fish
   *     (Aug 12: `give` was swallowed by `give <item> to <person>` and it cost
   *     a fish and an afternoon).
   *   · ABOVE the item verbs, so `carry` and `offer` reach an animal instead
   *     of being eaten by the container grammar.
   * Every verb below except `strays` is guarded on an animal actually being
   * matched, so nothing here shadows an ordinary command.
   *
   * Trust is per-person, lives on the ANIMAL as attrs.trust[userId], and is
   * never shown as a number to anybody, ever. */
  const STRAY_VERBS = new Set(['approach', 'pet', 'coax', 'offer', 'carry', 'adopt', 'surrender', 'call', 'strays']);
  if (STRAY_VERBS.has(verb) && !ch.attrs?.fishing) {
    /* `strays` — what you know about, and what it costs. Discoverability
     * again: a mechanic a blind player cannot find is a mechanic that does
     * not exist. */
    if (verb === 'strays') {
      const known = (ch.attrs && ch.attrs.strayLog) || {};
      const seen = Object.keys(known);
      lines.push(seen.length
        ? `You have met: ${seen.map((k) => (strays.STRAY_BY_ID['stray:' + k] || {}).short || k).join(', ')}.`
        : 'You have not gotten close to any of the city\'s animals yet. They are out there. approach one, slowly.');
      lines.push('approach / pet / coax to build trust · offer <food> to <animal> is faster · carry one when it lets you · adopt (15 coin) or surrender it at the Bureau of Small Complaints.');
      return { ok: true, lines };
    }

    /* Anything you are carrying comes first — `pet` with a cat in your arms
     * means the cat in your arms, not one across the room. */
    const carriedId = ch.attrs && ch.attrs.carrying;
    let animal = null;
    let wanted = rest;

    if (verb === 'offer') {
      const m = rest.match(/^(.+?)\s+to\s+(.+)$/i);
      if (!m) { lines.push('Offer what, to which animal? (offer bluegill to gray cat)'); return { ok: false, lines }; }
      wanted = m[2].trim();
    } else if (verb === 'call') {
      const m = rest.match(/^(.+?)\s+(.+)$/);
      if (!m) { lines.push('Usage: call <animal> <name> — and you only get to do it once.'); return { ok: false, lines }; }
      wanted = m[1].trim();
    }

    const inRoom = await MooChar.find({ roomId: ch.roomId, userId: /^stray:/ }).lean();
    const pool = carriedId ? [...inRoom, await MooChar.findOne({ userId: carriedId }).lean()].filter(Boolean) : inRoom;
    if (wanted) {
      const w = wanted.toLowerCase();
      animal = pool.find((a) => {
        const def = strays.STRAY_BY_ID[a.userId];
        return a.name.toLowerCase().includes(w)
          || (def && (def.short.includes(w) || w.includes(def.species)))
          || (a.attrs && a.attrs.givenName && a.attrs.givenName.toLowerCase().startsWith(w));
      });
    } else if (pool.length === 1) {
      animal = pool[0];
    }

    if (!animal) {
      /* `approach`, `pet`, `coax`, `carry`, `adopt`, `surrender` and `call` are
       * stray words and nothing else, so say what's actually wrong. Only
       * `offer` falls through, because it is the one word here that will
       * plausibly mean something else one day (offer a price, offer a hand).
       *
       * The first cut let approach/pet/coax fall through too, and the live
       * world answered `approach cat` in a room with no cat with "the world
       * does not know the command approach cat" — which is a lie about a verb
       * that exists, and the most discouraging thing a parser can say to
       * somebody still learning what the game accepts. */
      if (verb !== 'offer') {
        lines.push(pool.length
          ? `Which one? ${pool.map((a) => a.name).join(', ')}.`
          : 'No animal here. They keep to their own patches of the city — try the alleys off Front Street, Gully Road, Line Street, the Millrace, Sweetwater park, the Long Acre fields, or the Gravewalk lanterns.');
        return { ok: false, lines };
      }
      if (pool.length) {
        lines.push(`Which one? ${pool.map((a) => a.name).join(', ')}.`);
        return { ok: false, lines };
      }
    }

    if (animal) {
      const def = strays.STRAY_BY_ID[animal.userId] || { species: 'dog', temper: 'wary', short: 'animal' };
      const trustAll = animal.attrs?.trust || {};
      const before = trustAll[ch.userId] || 0;
      const lastAll = animal.attrs?.lastSeen || {};
      const sinceLastMs = Date.now() - (lastAll[ch.userId] || 0);
      const isMine = animal.attrs?.owner === ch.userId;

      /* Log that you have met it — this is what `strays` reads. */
      const shortId = animal.userId.replace(/^stray:/, '');
      if (!(ch.attrs?.strayLog || {})[shortId]) {
        await MooChar.updateOne({ _id: ch._id }, { $set: { [`attrs.strayLog.${shortId}`]: true } });
        ch.attrs = { ...(ch.attrs || {}), strayLog: { ...(ch.attrs?.strayLog || {}), [shortId]: true } };
      }

      /* ── CARRY ── */
      if (verb === 'carry') {
        if (carriedId === animal.userId) { lines.push(`You are already carrying ${animal.name}.`); return { ok: false, lines }; }
        if (carriedId) { lines.push('Your arms are full. release first.'); return { ok: false, lines }; }
        if (before < strays.CARRY_AT) {
          lines.push(strays.moodLine(def.species, before));
          lines.push('It is not going to let you pick it up. Not yet.');
          return { ok: false, lines, kinds: [...kinds, 'emote'], sounds: [strays.moodSound(def.species, before, false)].filter(Boolean) };
        }
        await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.carrying': animal.userId } });
        await MooChar.updateOne({ userId: animal.userId }, { $set: { roomId: ch.roomId, 'attrs.heldBy': ch.userId } });
        await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} picks up ${animal.name}, and it lets them.`, strays.moodSound(def.species, before, false));
        lines.push(`You pick ${animal.name} up. It weighs almost nothing and it does not struggle.`);
        lines.push(strays.SHELTER_ROOM === ch.roomId ? 'Opal looks up. She does not say anything yet.' : `You could carry it to the Bureau of Small Complaints, or you could keep it. Nobody is going to tell you which.`);
        return { ok: true, lines, kinds: [...kinds, 'emote'] };
      }

      /* ── SURRENDER ── the fork, and neither side of it is the answer. */
      if (verb === 'surrender') {
        if (carriedId !== animal.userId) { lines.push(`You would have to be carrying ${animal.name}.`); return { ok: false, lines }; }
        if (ch.roomId !== strays.SHELTER_ROOM) { lines.push('Not here. Opal\'s desk, at the Bureau of Small Complaints.'); return { ok: false, lines }; }
        await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.carrying': null }, $inc: { 'attrs.coin': strays.SURRENDER_PAYS, 'attrs.kindness': 1 } });
        await MooChar.updateOne({ userId: animal.userId }, { $set: { 'attrs.heldBy': null } });
        lines.push('Opal takes it without a speech. "Lost dog, found dog, same drawer."');
        lines.push(`She counts ${strays.SURRENDER_PAYS} coin into your hand and does not call it a reward, and you understand that it would be rude to argue.`);
        return { ok: true, lines, kinds: [...kinds, 'take'], sounds: ['obj.coins.drop'] };
      }

      /* ── ADOPT ── */
      if (verb === 'adopt') {
        if (isMine) { lines.push(`${animal.name} is already yours. call it something.`); return { ok: false, lines }; }
        if (before < strays.CARRY_AT) { lines.push('It has to trust you first. That is the whole cost, and it is not payable in coin.'); return { ok: false, lines }; }
        if ((ch.attrs?.coin || 0) < strays.ADOPT_COSTS) { lines.push(`Adoption is ${strays.ADOPT_COSTS} coin at Opal's desk. You have ${ch.attrs?.coin || 0}.`); return { ok: false, lines }; }
        await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': -strays.ADOPT_COSTS } });
        await MooChar.updateOne({ userId: animal.userId }, { $set: { 'attrs.owner': ch.userId } });
        lines.push(`Fifteen coin, and a line in a book, and that is the whole ceremony.`);
        lines.push(`${animal.name} is yours. It still has no name. That part costs one of yours — call ${def.short} <name>.`);
        return { ok: true, lines, kinds: [...kinds, 'take'] };
      }

      /* ── CALL (naming) ── the only thing in this game that spends a name. */
      if (verb === 'call') {
        if (!isMine) { lines.push('You do not name an animal you have not taken responsibility for.'); return { ok: false, lines }; }
        if (animal.attrs?.givenName) { lines.push(`It already has a name. It is ${animal.attrs.givenName}, and that was the point.`); return { ok: false, lines }; }
        const m = restRaw.match(/^\S+\s+(.+)$/);
        const given = (m ? m[1] : '').trim().slice(0, 40);
        if (!given) { lines.push('Call it what?'); return { ok: false, lines }; }
        await MooChar.updateOne({ userId: animal.userId }, { $set: { 'attrs.givenName': given, name: given } });
        await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} names ${animal.name} ${given}.`);
        lines.push(`${given}. It does not react, because it is an animal and it has no idea. You will both get used to it.`);
        return { ok: true, lines, kinds: [...kinds, 'emote'] };
      }

      /* ── APPROACH / PET / COAX / OFFER ── the actual relationship ── */
      let withFood = false;
      let foodName = null;
      if (verb === 'offer') {
        const m = rest.match(/^(.+?)\s+to\s+/i);
        foodName = m ? m[1].trim() : '';
        const inv = (ch.attrs && ch.attrs.inventory) || [];
        const held = await MooItem.find({ 'location.type': 'char', 'location.id': ch.userId }).select('name').lean();
        const names = [...inv.map((i) => (typeof i === 'string' ? i : i.name)), ...held.map((h) => h.name)].filter(Boolean);
        const match = names.find((n) => String(n).toLowerCase().includes(foodName.toLowerCase()));
        if (!match) { lines.push(`You are not carrying any "${foodName}".`); return { ok: false, lines }; }
        if (!strays.willEat(def.species, match)) {
          lines.push(`${animal.name} looks at the ${match}, then at you, and the look is not flattering.`);
          return { ok: false, lines, kinds: [...kinds, 'emote'] };
        }
        withFood = true;
        foodName = match;
      }

      const r = strays.trustGain(def.temper, { withFood, sinceLastMs });
      const after = Math.min(strays.CARRY_AT, before + r.gain);
      await MooChar.updateOne({ userId: animal.userId }, {
        $set: { [`attrs.trust.${ch.userId}`]: after, [`attrs.lastSeen.${ch.userId}`]: Date.now() },
      });

      if (r.bolted) {
        const away = strays.driftTo(def, ch.roomId, () => 0.01) || def.territory[0];
        await MooChar.updateOne({ userId: animal.userId }, { $set: { roomId: away } });
        await emit(ch.roomId, ch.userId, ch.name, 'emote', `${animal.name} bolts.`, 'life.stray.bolt');
        lines.push('You moved too fast and it was gone before you finished moving.');
        lines.push('It does not hold it against you. It will be somewhere else in its patch, and it will have forgotten by the time you find it. You have not lost anything but the walk.');
        return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: ['life.stray.bolt'] };
      }

      if (withFood) {
        const inv = ((ch.attrs && ch.attrs.inventory) || []).filter((i) => (typeof i === 'string' ? i : i.name) !== foodName);
        await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.inventory': inv } });
        await MooItem.deleteOne({ 'location.type': 'char', 'location.id': ch.userId, name: foodName });
        lines.push(`You put the ${foodName} down within reach and step back, which is the whole trick and nobody ever tells you.`);
      }

      const snd = strays.moodSound(def.species, after, false);
      lines.push(strays.moodLine(def.species, after));
      if (strays.rungOf(before) !== strays.rungOf(after) && strays.rungOf(after) === 'yours') {
        lines.push('You could pick this animal up.');
      }
      if (!r.patient && !withFood) {
        lines.push('You went at it quicker than it wanted. It cost you, and it cost you time, not affection.');
      }
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} ${verb === 'pet' ? 'reaches for' : verb === 'offer' ? 'offers something to' : 'moves slowly toward'} ${animal.name}.`, snd);
      return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: snd ? [snd] : [] };
    }
  }

  /* `release` with an animal in your arms. Guarded on actually carrying one,
   * and it sits BELOW the Bite block above, so a bare `release` mid-fight
   * still means the fish. Both meanings of the word survive because only one
   * of them can ever be true at a time. */
  if (verb === 'release' && ch.attrs?.carrying) {
    const held = await MooChar.findOne({ userId: ch.attrs.carrying }).lean();
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.carrying': null } });
    if (held) {
      await MooChar.updateOne({ userId: held.userId }, { $set: { roomId: ch.roomId, 'attrs.heldBy': null } });
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} sets ${held.name} down.`);
      lines.push(`You set ${held.name} down. It stays where you put it, which is its own kind of answer.`);
    } else {
      lines.push('You set it down.');
    }
    return { ok: true, lines, kinds: [...kinds, 'emote'] };
  }

  /* ── OBJECT DEPTH (KadeCore): containers, giving, keys ─────────────────── */
  if (verb === 'put' && !/penny.*rail/i.test(rest)) {
    // put <item> in <container> (penny-on-rail falls through to flatten handler)
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
  if (verb === 'give' && rest && !/^\d+\s+coins?\s+to\s+/i.test(rest)) {
    // give <item> to <player> — MooItem system
    const m = rest.match(/^(.+?)\s+to\s+(.+)$/i);
    if (!m) {
      lines.push('Usage: give <item> to <person>, or give <n> coin to <person>.');
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
  /* ── THE SOUL (round 9 — rebuilt on the MOO grammar) ─────────────────────
   * Round 7 shipped 20 gestures with a bare verb form and `<verb> at <name>`.
   * What every MOO soul has that we did not: an ADVERB SLOT. Tale runs 2200
   * adverbs against 250 emotes and prefix-matches them, and that one slot is
   * the difference between two people typing `nod` at each other and two
   * people having a conversation. It is also free — no content, no model call,
   * no new sound.
   *
   * Grammar, in any order that reads:  <verb> [adverb] [at|to|for <name>]
   *   nod                     smile warmly
   *   nod slowly              wave to Merle
   *   smile at Ruth-Ann       clap for Levi
   *   nod thou                -> nod thoughtfully   (prefix match)
   *
   * The preposition is chosen per gesture (you wave TO somebody, you clap FOR
   * them, you smirk AT them) because reading `waves at you` where `waves to
   * you` belongs is the kind of small wrongness that adds up to a world that
   * feels written by a machine. */
  if (social.SOCIALS[verb]) {
    let adverb = null;
    let targetName = null;
    let leftover = rest;

    const at = leftover.match(/\b(?:at|to|for|with|toward|towards)\s+(.+)$/i);
    if (at) {
      targetName = at[1].trim();
      leftover = leftover.slice(0, at.index).trim();
    }
    if (leftover) {
      const adv = social.matchAdverb(leftover.split(/\s+/)[0]);
      if (adv) adverb = adv;
      else if (!targetName) {
        /* Not an adverb and not a target — most likely somebody meant a
         * person and forgot the preposition. Try it as a name before giving
         * up, because `smile ruth` is what people actually type. */
        targetName = leftover;
      } else {
        lines.push(`"${leftover.split(/\s+/)[0]}" isn't an adverb I know. Try \`adverbs\` for the list.`);
        return { ok: false, lines };
      }
    }

    let target = null;
    if (targetName) {
      target = await MooChar.findOne({
        roomId: ch.roomId,
        userId: { $ne: ch.userId },
        name: new RegExp('^' + escapeRe(targetName), 'i'),
      }).lean();
      if (!target) {
        lines.push(`No "${targetName}" here.`);
        return { ok: false, lines };
      }
    }

    const r = social.renderSocial(verb, { adverb, targetName: target ? target.name : null, selfName: ch.name });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', r.third, r.sound);
    lines.push(r.first);
    return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: r.sound ? [r.sound] : [] };
  }

  /* `socials` and `adverbs` — DISCOVERABILITY, and it ships in the same block
   * as the feature on purpose. A sighted player finds a gesture list on a
   * wiki. A blind player finds it here or does not find it. */
  if (verb === 'socials' || verb === 'gestures' || verb === 'emotes' || verb === 'feelings') {
    social.listSocials(rest || null).forEach((l) => lines.push(l));
    return { ok: true, lines };
  }
  if (verb === 'adverbs') {
    lines.push(`${social.ADVERBS.length} adverbs, and any prefix that isn't ambiguous will do: ${social.ADVERBS.join(', ')}.`);
    return { ok: true, lines };
  }

  /* ── ROOM POSE (round 9) ─────────────────────────────────────────────────
   * Miriani's room poses, and the single biggest change to `look` this world
   * has had. A pose is a fragment that continues your name, so the room reads
   * "Ruby is leaning on the counter" instead of "Ruby".
   *
   * It clears when you leave the room — see the movement handlers. Miriani
   * keeps a pose until you clear it, which is fine there; here, "leaning
   * against the counter" following you onto the pier is a lie inside a room
   * description, and the room description IS the picture in this game. */
  if (verb === 'pose') {
    if (!restRaw || /^(clear|off|none|stop)$/i.test(rest)) {
      await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.pose': null } });
      lines.push('You go back to just standing there.');
      return { ok: true, lines };
    }
    const r = social.sanitizePose(restRaw);
    if (r.error) { lines.push(r.error); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.pose': r.pose } });
    lines.push(`The room now sees: ${ch.name} ${r.pose}.`);
    return { ok: true, lines };
  }

  /* ── PRONOUNS (round 9) ──────────────────────────────────────────────────
   * Extended emotes need them and the world had none. Sets, not genders — the
   * engine never asks what somebody is, only what words to use about them,
   * which is the only thing a sentence needs. Default they/them, which is
   * also the right default for a stranger, so the grammar and the manners
   * agree for once. */
  if (verb === 'pronouns' || verb === 'pronoun') {
    if (!rest) {
      const cur = (ch.attrs && ch.attrs.pronouns) || 'they';
      const set = social.PRONOUN_SETS[cur];
      lines.push(`The city speaks of you as ${set.sub}/${set.obj}/${set.pos}. Change it: pronouns she, pronouns he, pronouns they, pronouns it.`);
      return { ok: true, lines };
    }
    const key = social.PRONOUN_ALIASES[rest.trim().toLowerCase()];
    if (!key) {
      lines.push('Pick one: she/her, he/him, they/them, it/its.');
      return { ok: false, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.pronouns': key } });
    const set = social.PRONOUN_SETS[key];
    lines.push(`Noted. ${set.sub.charAt(0).toUpperCase() + set.sub.slice(1)}/${set.obj}/${set.pos}, from here on.`);
    return { ok: true, lines };
  }

  /* ── WALK STYLE (round 9) ────────────────────────────────────────────────
   * Miriani binds each style to its own movement verb. We keep `go` — our
   * movement grammar is already crowded and a blind player's muscle memory
   * should not have to fork — and make the style a setting. What it buys is
   * the ENTER and LEAVE lines other people read, which in a world where you
   * meet most people by hearing them arrive is characterisation for the price
   * of one attribute. */
  if (verb === 'walk-style' || verb === 'walkstyle' || (verb === 'walk' && rest)) {
    const key = rest.trim().toLowerCase();
    if (key === 'clear' || key === 'none' || key === 'normal') {
      await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.walkStyle': null } });
      lines.push('You go back to walking like everybody else.');
      return { ok: true, lines };
    }
    if (!social.WALK_STYLES[key]) {
      lines.push(`Styles: ${Object.keys(social.WALK_STYLES).join(', ')}. (walk-style clear to stop.)`);
      return { ok: !rest, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.walkStyle': key } });
    lines.push(`From here on you ${social.WALK_STYLES[key].you} out of rooms, and you ${social.WALK_STYLES[key].youIn}.`);
    return { ok: true, lines };
  }

  /* ── TOUCH-AS-OFFER (Round 7, Part 21) ──────────────────────────────────
   * Touch lands as an offer. The other person takes it or lets it pass,
   * and letting it pass produces no message and no refusal. Nobody gets
   * rejected out loud. The offer lives on the target character for 60s. */
  if (['handshake', 'hug', 'highfive', 'fistbump', 'pat'].includes(verb) || (verb === 'high' && rest.startsWith('five'))) {
    const gesture = verb === 'high' ? 'highfive' : verb;
    const targetName = (verb === 'high' ? rest.slice(4) : rest).trim();
    if (!targetName) {
      lines.push(`${gesture} whom?`);
      return { ok: false, lines };
    }
    const target = await MooChar.findOne({ roomId: ch.roomId, name: new RegExp('^' + escapeRe(targetName) + '$', 'i') }).lean();
    if (!target) {
      lines.push(`No "${targetName}" here.`);
      return { ok: false, lines };
    }
    const GESTURE_LINES = {
      handshake: ['extends a hand toward', 'You extend a hand toward'],
      hug:       ['opens their arms toward', 'You open your arms toward'],
      highfive:  ['raises a hand toward', 'You raise a hand toward'],
      fistbump:  ['holds out a fist toward', 'You hold out a fist toward'],
      pat:       ['reaches toward', 'You reach toward'],
    };
    const gl = GESTURE_LINES[gesture] || GESTURE_LINES.handshake;
    await MooChar.updateOne(
      { _id: target._id },
      { $set: { 'attrs.touchOffer': { from: ch.name, gesture, at: Date.now() } } },
    );
    lines.push(`${gl[1]} ${target.name}. If they take it, you will both know.`);
    return { ok: true, lines };
  }
  if (verb === 'accept') {
    const offer = ch.attrs?.touchOffer;
    if (!offer || (Date.now() - offer.at) > 60000) {
      if (offer) await MooChar.updateOne({ _id: ch._id }, { $unset: { 'attrs.touchOffer': '' } });
      lines.push('Nothing offered right now.');
      return { ok: false, lines };
    }
    const ACCEPT_LINES = {
      handshake: ['shake hands', 'social.handshake'],
      hug:       ['share a hug', 'social.hug'],
      highfive:  ['slap a clean high five', 'social.clap'],
      fistbump:  ['bump fists', 'social.fistbump'],
      pat:       ['a pat', null],
    };
    const al = ACCEPT_LINES[offer.gesture] || ACCEPT_LINES.handshake;
    const roomMsg = al[0] === 'a pat'
      ? `${offer.from} gives ${ch.name} ${al[0]}.`
      : `${ch.name} and ${offer.from} ${al[0]}.`;
    const selfMsg = al[0] === 'a pat'
      ? `${offer.from} gives you ${al[0]}.`
      : `You and ${offer.from} ${al[0]}.`;
    await emit(ch.roomId, ch.userId, ch.name, 'emote', roomMsg, al[1]);
    await MooChar.updateOne({ _id: ch._id }, { $unset: { 'attrs.touchOffer': '' } });
    lines.push(selfMsg);
    return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: al[1] ? [al[1]] : [] };
  }

  /* ── GIVE COIN ─────────────────────────────────────────────────────────
   * The economy flows between players. Coin changes hands in the same room. */
  if (verb === 'give' && /^\d+\s+coins?\s+to\s+/i.test(rest)) {
    const gm = rest.match(/^(\d+)\s+coins?\s+to\s+(.+)$/i);
    if (gm) {
      const amount = parseInt(gm[1], 10);
      const recipientName = gm[2].trim();
      if (amount <= 0) { lines.push('That is not an amount.'); return { ok: false, lines }; }
      if ((ch.attrs?.coin || 0) < amount) {
        lines.push(`You have ${ch.attrs?.coin || 0} coin. Not enough.`);
        return { ok: false, lines };
      }
      const recipient = await MooChar.findOne({
        roomId: ch.roomId,
        name: new RegExp('^' + escapeRe(recipientName) + '$', 'i'),
        _id: { $ne: ch._id },
      }).lean();
      if (!recipient) {
        lines.push(`No "${recipientName}" here to give coin to.`);
        return { ok: false, lines };
      }
      await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': -amount } });
      await MooChar.updateOne({ _id: recipient._id }, { $inc: { 'attrs.coin': amount } });
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} counts out ${amount} coin and hands it to ${recipient.name}.`, 'obj.coins.drop');
      lines.push(`You hand ${amount} coin to ${recipient.name}.`);
      return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: ['obj.coins.drop'] };
    }
  }

  /* ── ROOM CHORD (Round 7, Part 21) ─────────────────────────────────────
   * One tone per person present, bound to a musical key. A sonic census.
   * The chord tells a blind player who is nearby without the room having
   * to read a list. Sound IDs are chord.1 through chord.8 for up to 8
   * concurrent presences; more than that is rare. */
  if (verb === 'chord' || verb === 'listen') {
    /* Listen: room ear-signature first, then the chord (people count).
     * listenLine is pure data on the room — zero compute. */
    const listenRoom = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    if (listenRoom?.props?.listenLine) {
      lines.push(listenRoom.props.listenLine);
    }
    const present = await MooChar.find({ roomId: ch.roomId }).select('name').lean();
    const count = Math.min(present.length, 8);
    const names = present.map(p => p.name).join(', ');
    const chordSound = count > 0 ? `chord.${count}` : null;
    lines.push(count === 1
      ? 'Just you. One low tone, no harmony to build from yet.'
      : `${count} souls here: ${names}. The chord sounds ${count} notes.`);
    return { ok: true, lines, sounds: chordSound ? [chordSound] : [] };
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
    await MooChar.create({ userId: ch.userId, name, roomId: 'city_gate', active: true, attrs: { alive: true, coin: 20, lastMeal: Date.now(), lastSleep: Date.now() } });
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
    lines.push(w.line + ' (Reverie weather. The Founder folded hill country in against a sea that should not be there, and the sky has been dramatic for no reason ever since.)');
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
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: homeId, 'attrs.prevRoom': origin, 'attrs.pose': null } });
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
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: prevId, 'attrs.prevRoom': origin, 'attrs.pose': null } });
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
    /* Speaking aloud is a chosen act and it lands harder, so the room is more
     * likely to answer it. Two rolls, best of — never a guarantee, because a
     * room that always answers is as much a tell as one that never does. */
    const heardIt = (await roomAnswers(text)) || (await roomAnswers(text));
    if (heardIt) lines.push(heardIt);
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
    /* Pass game state so the NPC's response varies by time, weather,
     * crowd size — combinatorial, never the same canned rotation. */
    const heardAll = (ch.attrs && ch.attrs.heard) || {};
    const talkCtx = {
      hour: new Date().getHours(),
      weather: (reverie.weatherNow() || {}).kind || 'clear',
      playerName: ch.name,
      roomId: ch.roomId,
      peopleCount: (await MooChar.countDocuments({ roomId: ch.roomId })),
      outdoor: !!(await MooRoom.findOne({ roomId: ch.roomId }).lean())?.props?.outdoor,
      /* Rule 4 shares its memory with the overhearing lane on purpose: asking
       * Pat twice and overhearing Pat twice are the same social event to the
       * person on the receiving end, so they draw from one pool. */
      heard: heardAll[target.userId] || [],
    };
    const spoke = def ? reverie.npcTalkLine(def, talkCtx) : { line: `${target.name} nods at you, friendly enough.`, hash: null };
    if (spoke.hash) {
      const nextHeard = overhear.rememberLine(talkCtx.heard, spoke.hash);
      await MooChar.updateOne({ _id: ch._id }, { $set: { [`attrs.heard.${target.userId}`]: nextHeard } });
      ch.attrs = { ...(ch.attrs || {}), heard: { ...heardAll, [target.userId]: nextHeard } };
    }
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} stops to talk with ${target.name}.`);
    await emit(ch.roomId, target.userId, target.name, 'say', `${target.name}: ${spoke.line}`);
    lines.push(`${target.name}: ${spoke.line}`);
    return { ok: true, lines, kinds: [...kinds, 'say'] };
  }

  /* ════ FORAGE SYSTEM (Round 7, Part 20.2) ═══════════════════════════════
   * Wild food on the real calendar. A map of times, not places.
   * The almanac fills in as you find things — a veteran's filled
   * almanac is one of the best gifts in the game. */

  /* THE ALMANAC — what's in season RIGHT NOW, keyed to real month/day.
   * Each entry: { what, where (roomId array), monthStart, dayStart, monthEnd, dayEnd, desc, smell, catch } */
  const GARDEN_ROOMS = ['garden_plots']; /* expand later to the_patch */

  const FORAGE_CALENDAR = [
    { what: 'wild onion',   where: ['the_spring', 'sweetwater_park', 'the_ditches'], monthStart: 3, dayStart: 1, monthEnd: 5, dayEnd: 15,
      desc: 'A clump of wild onion, thin-stemmed and sharp.', smell: 'The air has that green-sharp bite — wild onion, close.', catch: null },
    { what: 'dandelion greens', where: ['sweetwater_park', 'the_ditches', 'long_acre_fields'], monthStart: 3, dayStart: 15, monthEnd: 5, dayEnd: 31,
      desc: 'Dandelion greens, young enough to eat without bitterness.', smell: 'Dandelions crowd the edges of everything here, this time of year.', catch: null },
    { what: 'watercress',   where: ['the_spring', 'sweetwater_creek'], monthStart: 3, dayStart: 1, monthEnd: 5, dayEnd: 31,
      desc: 'Watercress, peppery and dripping.', smell: 'The water smells green and peppery — watercress.', catch: null },
    { what: 'sassafras root', where: ['sweetwater_park', 'long_acre_fields'], monthStart: 3, dayStart: 1, monthEnd: 4, dayEnd: 30,
      desc: 'A sassafras root, thin as your finger, smelling like root beer.', smell: 'Something in the turned dirt smells like root beer. Sassafras.', catch: null },
    { what: 'poke',         where: ['the_patch', 'millrace_yard', 'long_acre_fields'], monthStart: 3, dayStart: 15, monthEnd: 4, dayEnd: 30,
      desc: 'Young poke shoots, barely a hand tall. Must be boiled three times.', smell: 'The fence line is thick with poke shoots, young and dangerous if you don\'t know the rule.', catch: 'Must be boiled three times. The world will tell you. Ruth-Ann will tell you. Do it.' },
    { what: 'morel',        where: ['long_acre_fields', 'the_timber'], monthStart: 4, dayStart: 5, monthEnd: 4, dayEnd: 25,
      desc: 'A morel mushroom, honeycombed and perfect.', smell: 'The loam smells like rain-on-warm-dirt, that particular morel weather.', catch: 'Cannot be farmed, cannot be predicted. The whole city loses its mind for about ten days.' },
    { what: 'mulberry',     where: ['the_stairs', 'fairlawn_walk'], monthStart: 6, dayStart: 10, monthEnd: 6, dayEnd: 28,
      desc: 'A handful of mulberries, fat and dark as bruises.', smell: 'The air is sweet and heavy — the mulberry tree is dropping.', catch: 'Stains everything you own. The Stairs get slick. Fairlawn files a complaint every year.' },
    { what: 'blackberry',   where: ['millrace_yard', 'long_acre_fields', 'the_rail_spur'], monthStart: 7, dayStart: 1, monthEnd: 7, dayEnd: 28,
      desc: 'Blackberries, warm from the sun and full of seeds.', smell: 'That particular July sweetness — blackberries ripening along the rail line.', catch: 'Thorns, chiggers, and Boone Tally knows where the good canes are if you ask him right.' },
    { what: 'pawpaw',       where: ['sweetwater_creek', 'the_bottoms'], monthStart: 9, dayStart: 5, monthEnd: 9, dayEnd: 20,
      desc: 'A pawpaw, custardy and tropical and completely wrong for this latitude.', smell: 'Something tropical and wrong for this latitude drifts up from the bottoms. Pawpaw.', catch: 'People who know the patch do not tell you where the patch is. This is the only secret in Reverie that people actually keep.' },
    { what: 'persimmon',    where: ['the_gravewalk', 'grave_hill'], monthStart: 11, dayStart: 1, monthEnd: 12, dayEnd: 15,
      desc: 'A persimmon, soft and yielding — it waited for the frost.', smell: 'Persimmon on the ground, split and sweet. The frost did its work.', catch: 'Eat one before frost and your whole face will regret it. You make that mistake once.' },
    { what: 'black walnut',  where: ['sweetwater_park', 'the_patch'], monthStart: 10, dayStart: 1, monthEnd: 10, dayEnd: 31,
      desc: 'Black walnuts in their husks, green-black and pungent.', smell: 'That sharp, almost chemical smell — black walnuts underfoot.', catch: 'Your hands are stained for a week. Millrace has a hulling machine and a man who charges to run it.' },
  ];

  function getForageInSeason(roomId) {
    const now = new Date();
    const m = now.getMonth() + 1; // 1-12
    const d = now.getDate();
    return FORAGE_CALENDAR.filter(f => {
      if (!f.where.includes(roomId)) return false;
      if (f.monthStart === f.monthEnd) return m === f.monthStart && d >= f.dayStart && d <= f.dayEnd;
      if (m === f.monthStart) return d >= f.dayStart;
      if (m === f.monthEnd) return d <= f.dayEnd;
      return m > f.monthStart && m < f.monthEnd;
    });
  }

  if (verb === 'forage' || verb === 'gather' || verb === 'harvest' || (verb === 'pick' && !GARDEN_ROOMS.includes(ch.roomId))) {
    const inSeason = getForageInSeason(ch.roomId);
    if (inSeason.length === 0) {
      const room = await MooRoom.findOne({ roomId: ch.roomId }).select('name').lean();
      lines.push(`Nothing wild to gather in ${room?.name || 'this place'} right now. The calendar and the land decide — not you. Walk the wards in their seasons and the air will tell you what's ready.`);
      return { ok: false, lines };
    }
    /* Pick a random item from what's available — foraging is discovery */
    const pick = inSeason[Math.floor(Math.random() * inSeason.length)];
    /* Cooldown: one forage per room per 30 minutes per character */
    const lastForage = ch.attrs?.lastForage || {};
    const lastHere = lastForage[ch.roomId] || 0;
    if (Date.now() - lastHere < 30 * 60 * 1000) {
      const mins = Math.ceil((30 * 60 * 1000 - (Date.now() - lastHere)) / 60000);
      lines.push(`You already picked through here recently. Give it ${mins} more minute${mins === 1 ? '' : 's'} — the land needs a rest, and so do your knees.`);
      return { ok: false, lines };
    }
    /* Update cooldown and inventory */
    const invKey = `inventory`;
    const inv = ch.attrs?.inventory || [];
    inv.push({ name: pick.what, foraged: true, at: Date.now() });
    const newLastForage = { ...lastForage, [ch.roomId]: Date.now() };
    await MooChar.updateOne({ _id: ch._id }, {
      $set: { 'attrs.lastForage': newLastForage, 'attrs.inventory': inv },
    });
    /* Update almanac — character's personal record of what they've found */
    const almanac = ch.attrs?.almanac || [];
    const alreadyKnown = almanac.some(a => a.what === pick.what);
    if (!alreadyKnown) {
      almanac.push({ what: pick.what, firstFound: Date.now(), where: ch.roomId });
      await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.almanac': almanac } });
    }
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} forages and comes up with something.`, 'forage.pick');
    let msg = pick.desc;
    if (pick.catch) msg += ` (${pick.catch})`;
    if (!alreadyKnown) msg += ' — New entry in your almanac.';
    lines.push(msg);
    return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: ['forage.pick'] };
  }

  /* ALMANAC — check what you've found so far */
  if (verb === 'almanac') {
    const almanac = ch.attrs?.almanac || [];
    if (almanac.length === 0) {
      lines.push('Your almanac is blank. Forage in the wild places — the spring, the park, the fields, the creek — and it fills in. A map of times, not places.');
      return { ok: true, lines };
    }
    const entries = almanac.map(a => {
      const cal = FORAGE_CALENDAR.find(f => f.what === a.what);
      const months = cal ? `(${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][cal.monthStart-1]}–${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][cal.monthEnd-1]})` : '';
      return `${a.what} ${months}`;
    });
    lines.push(`Your almanac, ${almanac.length} entries: ${entries.join(', ')}. The rest is still blank. Walk the wards in their seasons.`);
    return { ok: true, lines };
  }

  /* SNIFF / SMELL — nose-first design, the forage system's scout verb */
  if (verb === 'sniff' || verb === 'smell') {
    const inSeason = getForageInSeason(ch.roomId);
    if (inSeason.length > 0) {
      const smells = inSeason.map(f => f.smell);
      lines.push(smells[Math.floor(Math.random() * smells.length)]);
      return { ok: true, lines };
    }
    const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
    /* Fall back to room-level smell if defined */
    if (room?.props?.smell) {
      lines.push(room.props.smell);
    } else {
      lines.push('The air is what it is. Nothing particular on the wind right now.');
    }
    return { ok: true, lines };
  }


  /* ════ GARDEN PLOTS (Round 7, Part 20.3) ════════════════════════════════
   * Rented plots, real days, real seasons. Plant, water, wait, weed, pick.
   * Days, not minutes. Law 3 pace. Nothing dies while you're gone.
   * THE NOTE IS THE FEATURE — come back and find your plot was tended
   * and a note left on a stake. */

  const PLANTABLE = {
    tomato:    { grow: 5, desc: 'fat red tomatoes, warm from the vine', price: 0, sell: 8 },
    pepper:    { grow: 5, desc: 'peppers in a heap of color', price: 0, sell: 7 },
    greens:    { grow: 3, desc: 'a mess of greens, tender and dark', price: 0, sell: 5 },
    beans:     { grow: 4, desc: 'green beans, snapping crisp', price: 0, sell: 6 },
    corn:      { grow: 7, desc: 'ears of sweet corn, silk drying gold', price: 0, sell: 10 },
    herbs:     { grow: 2, desc: 'a bundle of herbs — basil, thyme, a sprig of something that smells like licorice', price: 0, sell: 4 },
    sunflower: { grow: 6, desc: 'sunflowers, tall and rattling, grown for nothing but the look of them', price: 0, sell: 3 },
  };



  if (verb === 'plant' && GARDEN_ROOMS.includes(ch.roomId)) {
    const what = rest.replace(/\s*(seeds?|seedling)\s*/i, '').trim().toLowerCase();
    if (!what) {
      lines.push(`Plant what? Options: ${Object.keys(PLANTABLE).join(', ')}. All free to start — seeds are in the shed.`);
      return { ok: false, lines };
    }
    if (!PLANTABLE[what]) {
      lines.push(`The shed doesn't have ${what} seeds. What's available: ${Object.keys(PLANTABLE).join(', ')}.`);
      return { ok: false, lines };
    }
    /* Check if character already has a plot going */
    if (ch.attrs?.gardenPlot) {
      const p = ch.attrs.gardenPlot;
      lines.push(`You already have ${p.crop} planted — ${p.stage === 'ready' ? 'ready to pick' : 'still growing'}. One plot at a time. Pick or pull it first.`);
      return { ok: false, lines };
    }
    /* Real-season check: planting season is April–August */
    const mo = new Date().getMonth() + 1;
    if (mo < 4 || mo > 8) {
      lines.push('Nothing goes in the ground this time of year. Planting runs April through August — the rest is frost, or too close to it.');
      return { ok: false, lines };
    }
    const plot = {
      crop: what,
      plantedAt: Date.now(),
      daysToGrow: PLANTABLE[what].grow,
      stage: 'growing', /* growing → ready */
      watered: Date.now(),
      weeded: Date.now(),
      notes: [],
    };
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.gardenPlot': plot } });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} kneels in the dirt and plants ${what} seeds.`, 'garden.plant');
    lines.push(`You plant ${what}. ${PLANTABLE[what].grow} real days to harvest — the calendar decides, not you. Water it. Weed it. Come back when it's ready.`);
    return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: ['garden.plant'] };
  }

  if (verb === 'water' && GARDEN_ROOMS.includes(ch.roomId)) {
    const plot = ch.attrs?.gardenPlot;
    if (!plot) {
      /* Can water someone else's plot — the NOTE feature */
      const targetName = rest.trim();
      if (targetName) {
        const target = await MooChar.findOne({
          'attrs.gardenPlot': { $exists: true },
          name: new RegExp('^' + escapeRe(targetName) + '$', 'i'),
        });
        if (target && target.attrs?.gardenPlot) {
          const note = `Yours were dry. Watered them. — ${ch.name}`;
          await MooChar.updateOne({ _id: target._id }, {
            $set: { 'attrs.gardenPlot.watered': Date.now() },
            $push: { 'attrs.gardenPlot.notes': { from: ch.name, text: note, at: Date.now() } },
          });
          await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} waters ${target.name}'s plot and leaves a note on the stake.`, 'garden.water');
          lines.push(`You water ${target.name}'s plot and leave a note: "${note}"`);
          return { ok: true, lines, sounds: ['garden.water'] };
        }
      }
      lines.push('You have no plot planted here. Try: plant <crop>. Or water <name> to tend someone else\'s.');
      return { ok: false, lines };
    }
    const hoursSince = (Date.now() - (plot.watered || 0)) / (1000 * 60 * 60);
    if (hoursSince < 12) {
      lines.push('Already watered recently. The soil is still dark. Come back tomorrow.');
      return { ok: false, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.gardenPlot.watered': Date.now() } });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} waters their plot. The spigot squeaks.`, 'garden.water');
    lines.push('You water your plot. The spigot squeaks in that way you know from two rows over.');
    return { ok: true, lines, sounds: ['garden.water'] };
  }

  if (verb === 'weed' && GARDEN_ROOMS.includes(ch.roomId)) {
    const plot = ch.attrs?.gardenPlot;
    if (!plot) { lines.push('No plot to weed. Plant something first.'); return { ok: false, lines }; }
    const hoursSince = (Date.now() - (plot.weeded || 0)) / (1000 * 60 * 60);
    if (hoursSince < 12) {
      lines.push('Already weeded recently. The rows are clean.');
      return { ok: false, lines };
    }
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.gardenPlot.weeded': Date.now() } });
    lines.push('You pull weeds until your knees ache and the rows look intentional again.');
    return { ok: true, lines };
  }

  if ((verb === 'check' || verb === 'tend' || verb === 'plot') && GARDEN_ROOMS.includes(ch.roomId)) {
    const plot = ch.attrs?.gardenPlot;
    if (!plot) { lines.push('No plot here. Try: plant <crop>. Options: ' + Object.keys(PLANTABLE).join(', ') + '.'); return { ok: false, lines }; }
    const daysPassed = (Date.now() - plot.plantedAt) / (1000 * 60 * 60 * 24);
    const daysLeft = Math.max(0, Math.ceil(plot.daysToGrow - daysPassed));
    /* Auto-advance stage */
    if (daysLeft === 0 && plot.stage === 'growing') {
      await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.gardenPlot.stage': 'ready' } });
      plot.stage = 'ready';
    }
    const wateredAgo = Math.round((Date.now() - (plot.watered || plot.plantedAt)) / (1000 * 60 * 60));
    const weededAgo = Math.round((Date.now() - (plot.weeded || plot.plantedAt)) / (1000 * 60 * 60));
    let status = `Your plot: ${plot.crop}. `;
    if (plot.stage === 'ready') {
      status += `Ready to pick — ${PLANTABLE[plot.crop]?.desc || plot.crop}. Use: pick.`;
    } else {
      status += `${daysLeft} day${daysLeft === 1 ? '' : 's'} to go. `;
      status += wateredAgo > 18 ? 'Needs water. ' : 'Watered. ';
      status += weededAgo > 18 ? 'Getting weedy.' : 'Rows are clean.';
    }
    /* Show notes left by others */
    if (plot.notes && plot.notes.length > 0) {
      const recent = plot.notes.slice(-3);
      status += ' Notes on the stake: ' + recent.map(n => `"${n.text}"`).join(' ');
      /* Clear notes after reading */
      await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.gardenPlot.notes': [] } });
    }
    lines.push(status);
    return { ok: true, lines };
  }

  if (verb === 'pick' && GARDEN_ROOMS.includes(ch.roomId) && !rest) {
    const plot = ch.attrs?.gardenPlot;
    if (!plot) { lines.push('No plot planted here.'); return { ok: false, lines }; }
    const daysPassed = (Date.now() - plot.plantedAt) / (1000 * 60 * 60 * 24);
    if (daysPassed < plot.daysToGrow) {
      const daysLeft = Math.ceil(plot.daysToGrow - daysPassed);
      lines.push(`Not ready yet. ${daysLeft} more day${daysLeft === 1 ? '' : 's'}. The calendar decides.`);
      return { ok: false, lines };
    }
    const crop = PLANTABLE[plot.crop];
    const inv = ch.attrs?.inventory || [];
    inv.push({ name: plot.crop, grown: true, at: Date.now() });
    const sellValue = crop?.sell || 5;
    await MooChar.updateOne({ _id: ch._id }, {
      $unset: { 'attrs.gardenPlot': '' },
      $set: { 'attrs.inventory': inv },
      $inc: { 'attrs.coin': sellValue },
    });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} picks ${crop?.desc || plot.crop} from their plot.`, 'garden.pick');
    lines.push(`You pick: ${crop?.desc || plot.crop}. The garden club nods. ${sellValue} coin for the harvest. Plot's clear — plant again whenever.`);
    return { ok: true, lines, kinds: [...kinds, 'emote'], sounds: ['garden.pick'] };
  }

  if (verb === 'pull' && GARDEN_ROOMS.includes(ch.roomId)) {
    const plot = ch.attrs?.gardenPlot;
    if (!plot) { lines.push('No plot to pull.'); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $unset: { 'attrs.gardenPlot': '' } });
    lines.push(`You pull up your ${plot.crop}. The plot's clear now.`);
    return { ok: true, lines };
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
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest.roomId, 'attrs.prevRoom': origin, 'attrs.pose': null }, $inc: { 'attrs.coin': -1 } });
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
    await MooChar.updateOne({ userId: ch.userId, active: true }, { $set: { roomId: dest.roomId, 'attrs.prevRoom': origin, 'attrs.pose': null }, $inc: { 'attrs.coin': -1 } });
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

  /* THE SHACK'S SHELVES — a rod and a tub of bait, which is the whole barrier
   * to entry for the one job in Reverie with no boss and no shift. Kept cheap
   * on purpose: a brand-new character with twenty credits can fish the river
   * her first hour and eat that night (round 7, Part 19.5). */
  if (verb === 'buy' && /\b(rod|pole|bait|worms?|liver)\b/i.test(rest)) {
    if (ch.roomId !== 'the_shack') {
      lines.push('That is Shack business. Marva keeps the rods and the bait cooler, east off the Docks.');
      return { ok: false, lines };
    }
    const coin = ch.attrs?.coin || 0;
    if (/\b(rod|pole)\b/i.test(rest)) {
      const owns = await MooItem.findOne({ 'location.type': 'char', 'location.id': ch.userId, 'props.rod': true }).lean();
      if (owns) { lines.push('You have a rod. Marva looks at it, then at you, and does not sell you a second one.'); return { ok: false, lines }; }
      if (coin < 6) { lines.push('A cane pole runs 6 coin. Marva waits. She is good at waiting.'); return { ok: false, lines }; }
      await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': -6 } });
      ch.attrs = { ...(ch.attrs || {}), coin: coin - 6 };
      await MooItem.create({
        itemId: 'rod_' + Date.now().toString(36),
        name: `${ch.name}'s cane pole`,
        desc: 'A cane pole, plain as a fence post, with line wrapped at the tip and a cork bobber gone soft with use. It will catch anything the river has and most of what the harbour does. Marva sold it to you without a word about which one you should want.',
        location: { type: 'char', id: ch.userId }, portable: true, props: { rod: true },
      });
      lines.push('Six coin. Marva hands you a cane pole off the wall rack — not the one you were looking at, the one you needed. She does not explain.');
      return { ok: true, lines, kinds: [...kinds, 'take'] };
    }
    const n = 5;
    if (coin < 2) { lines.push('Bait is 2 coin for a tub. That is about as cheap as this city gets.'); return { ok: false, lines }; }
    await MooChar.updateOne({ _id: ch._id }, { $inc: { 'attrs.coin': -2, 'attrs.bait': n } });
    ch.attrs = { ...(ch.attrs || {}), coin: coin - 2, bait: (ch.attrs?.bait || 0) + n };
    lines.push(`Two coin, and a paper tub of nightcrawlers in damp soil. Five casts' worth. You now carry ${(ch.attrs.bait)} bait.`);
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
      await MooChar.updateOne({ _id: ch._id }, { $set: { roomId: dest, 'attrs.pose': null } });
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
      /* Match structure from rest (lowercase), but pull VALUE from restRaw
       * so stored text keeps its original case. (The @set lowercase bug, Aug 13.) */
      const m = rest.match(/^"([^"]+)"\s+(\S+)\s+([\s\S]+)$/) || rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      /* Re-extract value from restRaw at the same offset to preserve case. */
      const mRaw = restRaw.match(/^"([^"]+)"\s+(\S+)\s+([\s\S]+)$/) || restRaw.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!m) {
        lines.push('Usage: @set me|here|"<player name>"|item:<name> <path> <value>. Value parses as JSON when it can, else string. Example: @set me standing 5');
        return { ok: false, lines };
      }
      const targetRaw = m[1].replace(/_/g, ' ');
      const path = m[2];
      const valueRaw = (mRaw || m)[3];
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

  if (verb === 'help') {
    lines.push('Moving: go <exit>, go to <place>, tram, ferry, home, back, map, dir. Senses: look, look <thing>, exits, where, time, weather, who, status, recap, chord, sniff. Hands: take, drop, put, get, give, inventory, coins, eat, sleep, work, flatten penny, buy brick. Fishing: cast, wait, set, hold, give, land, release, reel in, sell. Growing: forage, almanac, plant <crop>, water, weed, check, pick, pull. Social: 36 gestures (type socials) — each takes an adverb and a target: nod slowly, smile warmly at Ruth-Ann, wave to Merle. adverbs lists them. pose <what you are doing> shows in the room. emote with * for your name, -name to point at somebody, %he/%his for pronouns. pronouns <she|he|they|it>. walk-style <how you move>. Touch: handshake, hug, highfive, fistbump, pat <name> — they accept or let it pass. Animals: strays, approach, pet, coax, offer <food> to <animal>, carry, release, adopt, surrender, call <animal> <name>. give <n> coin to <name>. Voice: say (the Quiet), speak (aloud), emote, whisper <name> <words>, page <name> <words>, talk to <citizen>, petition <words>, wish <words>. Selves: describe me as <text>, chars, newchar <First Last>, switch <name>.');
    return { ok: true, lines };
  }

  return {
    ok: false,
    unknown: true,
    lines: [
      `The world does not know the command "${cmd}". Try: help`,
    ],
  };
}

module.exports = { runCommand };
