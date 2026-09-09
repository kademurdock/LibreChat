/* REVERIE LIFE — the view: what a client is handed every turn (Sep 6 2026).
 *
 * `look` is the whole visual field for a blind player, and the button bar is
 * the whole visual field for a thumb on a phone. Both come from here. The
 * room view keeps the old string shape (native reads it) and adds structure
 * beside it. The actions list is built from the verb registry: every verb
 * that knows when it applies puts itself on the bar, so a new verb is a new
 * button with no client change. */
const registry = require('./registry');
const needs = require('./needs');
const skills = require('./skills');
const reverie = require('../reverie');
const strays = require('../strays');
require('../social');
const {
  MooRoom,
  MooItem,
  MooChar,
  MooDistrict,
  DIR_WORDS,
  clockLine,
  worldClock,
  kindOfSoul,
  coinOf,
} = require('./ctx');

async function describeRoom(ctx) {
  const { ch } = ctx;
  const room = await MooRoom.findOne({ roomId: ch.roomId }).lean();
  if (!room)
    return {
      roomId: null,
      name: 'Nowhere',
      desc: 'You are somewhere the world forgot to build. Say "home" or "go to gate" to be rescued.',
      exits: [],
      items: [],
      people: [],
      exitsDetail: [],
    };
  const [items, people, destRooms] = await Promise.all([
    MooItem.find({ 'location.type': 'room', 'location.id': room.roomId }).lean(),
    MooChar.find({ roomId: room.roomId, userId: { $ne: ch.userId } }).lean(),
    MooRoom.find({ roomId: { $in: Object.values(room.exits || {}) } })
      .select('roomId name district props.home')
      .lean(),
  ]);
  const destById = Object.fromEntries(destRooms.map((r) => [r.roomId, r]));
  const wx = reverie.weatherNow();
  const home = room.props && room.props.home;
  const exitsDetail = await Promise.all(Object.entries(room.exits || {}).map(async ([dir, to]) => {
    const d = destById[to];
    const locked = d?.props?.home
      ? !(await require('./housing').mayEnter(ctx, d)).ok
      : !!room.props?.locks?.[dir];
    return { dir, label: DIR_WORDS[dir] || dir, to: d ? d.name : 'an unavailable place', toId: to, locked,
      missing: !d, returning: !!d && to === ch.attrs?.prevRoom };
  }));
  const furniture = items.filter((i) => i.props && i.props.furniture);
  const loose = items.filter(
    (i) => !(i.props && i.props.furniture) && !(i.props && i.props.vehicle),
  );
  const vehicles = items.filter((i) => i.props && i.props.vehicle);

  let desc = room.desc;
  if (room.props && room.props.outdoor) desc += ' ' + wx.line;
  if (home) {
    const owner = home.ownerName || 'somebody';
    const mine = home.owner === ch.userId || (home.tenants || []).includes(ch.userId);
    desc += mine ? ' This is your place.' : ` This is ${owner}’s place.`;
    if (furniture.length)
      desc += ' Furnished with ' + furniture.map((f) => f.name).join(', ') + '.';
    else desc += ' Bare floors — nothing in it yet.';
  }
  if (vehicles.length)
    desc +=
      ' Parked here: ' +
      vehicles
        .map((v) => v.name + (v.props.ownerName ? ` (${v.props.ownerName}’s)` : ''))
        .join(', ') +
      '.';

  const bench = require('./places').benchView(room);
  if (bench) desc += ' ' + bench.line;

  const peopleObjs = people.map((p) => personTag(ctx, p, room.props));
  return {
    roomId: room.roomId,
    name: room.name,
    district: room.district,
    desc,
    exits: exitsDetail.map((e) => e.label),
    exitsDetail,
    items: loose.map((i) => i.name),
    furniture: furniture.map((f) => f.name),
    people: peopleObjs.map((p) => p.line),
    peopleDetail: peopleObjs,
    orientation: require('@librechat/api').reverieOrientation({ name: room.name, peopleDetail: peopleObjs, exitsDetail }),
    doings: room.props && room.props.doings,
    smell: room.props && room.props.smell,
    listen: room.props && room.props.listenLine,
    outdoor: !!(room.props && room.props.outdoor),
    sensory: require('@librechat/api').reverieSenses(room, wx.kind, worldClock().dark),
    washhouse: bench ? { benchStage: bench.stage } : null,
    hangout: require('./hangouts').view(room, ch.userId, ctx.isWizard),
    weather: wx.kind,
    home: home
      ? {
          owner: home.owner,
          ownerName: home.ownerName,
          mine: home.owner === ch.userId || (home.tenants || []).includes(ch.userId),
        }
      : null,
  };
}

/** One person, one line — pose beats schedule beats mood beats posture beats name. */
function personTag(ctx, p, roomProps = {}) {
  const kind = kindOfSoul(p);
  const a = p.attrs || {};
  let tag = '';
  if (a.pose) tag = a.pose;
  else if (kind === 'stray') tag = strays.roomTag((a.trust || {})[ctx.ch.userId] || 0);
  else if (kind === 'citizen') {
    const d = reverie.npcDoingNow(p.userId);
    tag =
      (!roomProps.hangout &&
        require('./planning').publicActivity(p, d?.doing, !!roomProps.outdoor)) ||
      (d && d.doing ? d.doing : '');
  } else if (kind === 'child') tag = a.child && a.child.doing ? a.child.doing : 'here';
  else if (kind === 'pet') tag = a.pet && a.pet.doing ? a.pet.doing : 'close by';
  else if (a.posture && a.posture !== 'standing') tag = a.posture;
  else if (kind === 'player') {
    const idleMin = (Date.now() - new Date(p.lastActiveAt || 0).getTime()) / 60000;
    if (idleMin > 30) tag = 'here, but their mind is elsewhere';
    else if (idleMin > 8) tag = 'quiet for a while';
  }
  let line = p.name;
  if (tag) line = kind === 'stray' || a.pose ? `${p.name}, ${tag}` : `${p.name} (${tag})`;
  return {
    id: p.userId,
    name: p.name,
    kind,
    tag,
    line,
    pronouns: a.pronouns || (kind === 'player' ? 'they' : null),
    appearance:
      require('@librechat/api').reverieAppearance(a) ||
      require('@librechat/api').residentAppearance(p.userId),
    cmds: personCmds(ctx, p, kind),
  };
}

/** What you can do to somebody — the menu a tap on a name opens. Server-side
 *  so the client never has to know who is a citizen and who is a cat. */
function personCmds(ctx, p, kind) {
  const first = (p.attrs && (p.attrs.aka || p.attrs.givenName)) || p.name.split(' ')[0];
  const f = (label, verb) => ({ label, cmd: `${verb} ${first}` });
  if (kind === 'stray')
    return [
      f('Approach', 'approach'),
      f('Pet', 'pet'),
      f('Coax', 'coax'),
      f('Look at', 'look'),
      f('Carry', 'carry'),
      f('Adopt', 'adopt'),
      ...(p.attrs && p.attrs.owner === ctx.ch.userId
        ? [f('Bring along', 'bring'), f('Stay', 'stay')]
        : []),
    ];
  if (kind === 'pet')
    return [f('Pet', 'pet'), f('Bring along', 'bring'), f('Stay', 'stay'), f('Look at', 'look')];
  if (kind === 'child')
    return [
      f('Talk to', 'talk to'),
      f('Play with', 'play with'),
      f('Feed', 'feed'),
      f('Read to', 'read to'),
      f('Teach', 'teach'),
      f('Tuck in', 'tuck in'),
      f('Bring along', 'bring'),
      f('Look at', 'look'),
    ];
  const base = [
    f('Look at', 'look'),
    f('Chat', 'chat'),
    f('Invite to hangout', 'hangout invite'),
    f('Joke', 'joke'),
    f('Compliment', 'compliment'),
    f('Hug', 'hug'),
    f('Comfort', 'comfort'),
  ];
  if (kind === 'citizen') {
    const id = String(p.userId).replace(/^npc:/, '');
    const out = [
      { label: 'Say hello', cmd: `converse ${p.name}: Hello! How is your day going?` },
      { label: 'Ask about here', cmd: `converse ${p.name}: What do you like doing around here?` },
      f('Talk to', 'talk to'),
      ...base,
    ];
    if (!require('./relationships').NO_ROMANCE.has(id))
      out.push(f('Flirt', 'flirt'), f('Date', 'date'));
    out.push(f('Argue', 'argue'), f('Shove', 'shove'));
    if (id === 'littleray') out.push({ label: 'See Ray', cmd: 'corner' });
    return out;
  }
  return [
    ...base,
    f('Flirt', 'flirt'),
    f('Kiss', 'kiss'),
    f('Date', 'date'),
    f('Dance with', 'dance with'),
    { label: 'Whisper to', cmd: `whisper ${JSON.stringify(p.name)}` },
    { label: 'Give $5', cmd: `give 5 dollars to ${p.name}` },
    f('Give key', 'give key to'),
    f('Argue', 'argue'),
    f('Fight', 'fight'),
  ];
}

/** HUD: everything the meters and the header show. */
async function hud(ctx) {
  const { ch, life } = ctx;
  const nd = needs.hud(life.needs || needs.fresh());
  const room = await ctx.room();
  const ward = room
    ? await MooDistrict.findOne({ districtId: room.district }).select('name').lean()
    : null;
  const wx = reverie.weatherNow();
  const c = worldClock();
  const top = skills
    .summary(life.skills || {})
    .filter((s) => s.level > 0)
    .sort((a, b) => b.level - a.level)
    .slice(0, 3);
  return {
    name: ch.name,
    characterId: ch.userId,
    appearance: require('@librechat/api').reverieAppearance(ch.attrs),
    pronouns: (ch.attrs && ch.attrs.pronouns) || 'they',
    coin: coinOf(ch),
    clock: clockLine(),
    bucket: c.bucket,
    dark: c.dark,
    weather: wx.kind,
    weatherLine: wx.line,
    ward: ward?.name || room?.district || '',
    wardId: room ? room.district : 'gate',
    roomName: room ? room.name : '',
    ...nd,
    skills: top.map((s) => `${s.name} ${s.level}`),
    home: life.homeName || null,
    partner: life.partnerName || null,
    busyUntil: (ch.attrs && ch.attrs.busyUntil) || 0,
    marks: (ch.attrs && ch.attrs.marks) || [],
  };
}

/** The button bar: every verb that says it applies, grouped. Exits and
 *  people are added by the client from their own lists. */
async function actions(ctx) {
  const out = [];
  for (const v of registry.all()) {
    if (v.hidden || typeof v.buttons !== 'function') continue;
    try {
      const bs = await v.buttons(ctx);
      for (const b of bs || [])
        out.push({ label: b.label, cmd: b.cmd, group: b.group || 'here', hint: b.hint || null });
    } catch (_) {
      /* a broken button never breaks a turn */
    }
  }
  /* de-dupe by cmd, keep first */
  const seen = new Set();
  return out.filter((a) => (seen.has(a.cmd) ? false : (seen.add(a.cmd), true)));
}

/** Attach hud/actions/people/exits to any result. If the verb moved us or
 *  asked for a room view, describe it. */
async function decorate(ctx, result) {
  result = result || { ok: false, lines: [] };
  result.lines = result.lines || [];
  result.kinds = result.kinds || [];
  result.sounds = result.sounds || [];
  result.mode = result.mode || (ctx.life && ctx.life.wiz ? 'create' : 'play');
  ctx._room = null; /* the verb may have moved us — re-read */
  if (result.ok && result.kinds.includes('move')) {
    const room = await ctx.room();
    if (room) {
      const footstep = require('@librechat/api').reverieSenses(
        room,
        reverie.weatherNow().kind,
      ).footstep;
      result.kinds = result.kinds.map((k) => (k === 'move' ? footstep : k));
    }
  }

  if (result.mode === 'play') {
    if (result.wantRoom || result.room) {
      const rv = await describeRoom(ctx);
      /* keep any fields the old engine put on room, but our richer view wins */
      result.room = { ...(result.room || {}), ...rv };
      result.district = rv.district;
      delete result.wantRoom;
    }
    const [h, acts] = await Promise.all([hud(ctx), actions(ctx)]);
    result.hud = h;
    result.actions = acts;
    if (!result.people || !result.exits) {
      const rv = result.room && result.room.peopleDetail ? result.room : await describeRoom(ctx);
      result.people = rv.peopleDetail || [];
      result.exits = rv.exitsDetail || [];
      if (!result.room)
        result.here = { roomId: rv.roomId, name: rv.name, district: rv.district, home: rv.home };
    }
  } else {
    result.hud = { name: ctx.ch.name, coin: coinOf(ctx.ch), clock: clockLine(), mode: result.mode };
  }
  /* native compat: sounds ride in kinds too */
  return result;
}

module.exports = { describeRoom, personTag, hud, actions, decorate };
