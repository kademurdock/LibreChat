/* REVERIE LIFE — the basic verbs (Sep 6 2026): look, go, who, status, eat,
 * sleep, work, inventory, time, what. These replace their old-engine twins
 * because they now read and write the meters. Everything not here still
 * falls through to the old engine untouched. */
const registry = require('./registry');
const needs = require('./needs');
const skills = require('./skills');
const view = require('./view');
const reverie = require('../reverie');
const social = require('../social');
const {
  MooRoom, MooChar, MooItem, DIR_ALIASES, DIR_WORDS, escapeRe, matchName, itemsHeld, itemsIn, findHeld,
  emit, setAttrs, setBusy, moveTo, coinOf, payCoin, earnCoin, clockLine, worldClock, todayKey, plural, joinAnd, cap, pick,
} = require('./ctx');

/* ── LOOK ─────────────────────────────────────────────────────────────── */
registry.register({
  name: 'look', aliases: ['l', 'examine', 'x'], free: true,
  help: { topic: 'senses', usage: 'look · look <thing or person> · look me', blurb: 'The room, or one thing in it, up close.' },
  async run(ctx, { arg, argRaw }) {
    arg = (arg || '').replace(/^at\s+/, '');
    if (!arg) return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'look'] });
    const { ch } = ctx;
    if (/^(me|myself|self)$/.test(arg)) return ctx.ok({ lines: [...ctx.lines, selfLook(ch)] });
    /* things here or held */
    const items = [...(await itemsIn(ch.roomId)), ...(await itemsHeld(ch.userId))];
    const item = matchName(items, arg, (i) => i.name.replace(/^(a|an|the|some)\s+/i, ''));
    if (item) {
      let line = `${cap(item.name)}: ${item.desc}`;
      if (item.props && item.props.food) line += ` (Eat it: eat ${item.name.replace(/^(a|an|the|some)\s+/i, '')}.)`;
      if (item.props && item.props.furniture && item.props.effect) line += ` ${item.props.effect}`;
      return ctx.ok({ lines: [...ctx.lines, line] });
    }
    /* people here */
    const here = await MooChar.find({ roomId: ch.roomId }).lean();
    const person = matchName(here, arg);
    if (person) {
      const a = person.attrs || {};
      const bits = [];
      bits.push(`${person.name}: ${a.desc || (person.userId.startsWith('npc:') ? (reverie.CENSUS_BY_ID[person.userId] || {}).desc : null) || `${person.name} keeps their look to themselves, so far.`}`);
      if (a.look && a.look.line) bits.push(a.look.line);
      if (a.pose) bits.push(`${person.name} is ${a.pose}.`);
      else if (a.posture && a.posture !== 'standing') bits.push(`They are ${a.posture}.`);
      if (Array.isArray(a.marks) && a.marks.length) bits.push(`Marks: ${a.marks.join(', ')}.`);
      const rel = await require('./relationships').describeRel(ch, person);
      if (rel) bits.push(rel);
      return ctx.ok({ lines: [...ctx.lines, bits.join(' ')] });
    }
    /* room features by word */
    const room = await ctx.room();
    if (room && room.props) {
      if (/^(exits?|ways?|doors?)$/.test(arg)) return ctx.ok({ lines: [...ctx.lines, exitsLine(room)] });
    }
    return ctx.fail(`Nothing called "${argRaw}" here to look at.`);
  },
});

function selfLook(ch) {
  const a = ch.attrs || {};
  const l = a.life || {};
  const bits = [`You are ${ch.name}`];
  if (l.age) bits.push(`, ${l.age}`);
  bits.push('.');
  if (a.desc) bits.push(' ' + a.desc);
  else if (l.look && l.look.line) bits.push(' ' + l.look.line);
  if (l.traits && l.traits.length) bits.push(` Traits: ${l.traits.join(', ')}.`);
  if (l.aspiration) bits.push(` You want, most of all: ${l.aspiration}.`);
  if (Array.isArray(a.marks) && a.marks.length) bits.push(` Marks: ${a.marks.join(', ')}.`);
  return bits.join('');
}

function exitsLine(room) {
  const ex = Object.entries(room.exits || {}).map(([k, v]) => (DIR_WORDS[k] || k) + ((room.props && room.props.locks && room.props.locks[k]) ? ' (locked)' : ''));
  return ex.length ? 'Ways out: ' + ex.join(', ') + '.' : 'No way out of here that you can see.';
}

registry.register({
  name: 'exits', aliases: ['ways'], free: true,
  help: { topic: 'moving', usage: 'exits', blurb: 'List the ways out, with where they lead.' },
  async run(ctx) {
    const rv = await view.describeRoom(ctx);
    if (!rv.exitsDetail.length) return ctx.ok({ lines: [...ctx.lines, 'No way out that you can see.'] });
    return ctx.ok({ lines: [...ctx.lines, 'Ways out: ' + rv.exitsDetail.map((e) => `${e.label} to ${e.to}${e.locked ? ' (locked)' : ''}`).join('; ') + '.'] });
  },
});

/* ── GO ───────────────────────────────────────────────────────────────── */
async function walk(ctx, dirKey) {
  const { ch } = ctx;
  const room = await ctx.room();
  const exits = (room && room.exits) || {};
  const dest = exits[dirKey];
  if (!dest) return ctx.fail(`No way ${DIR_WORDS[dirKey] || dirKey} from here. ${exitsLine(room || {})}`);
  const lock = room.props && room.props.locks && room.props.locks[dirKey];
  if (lock) {
    const housing = require('./housing');
    const may = await housing.mayPass(ctx, room, dirKey, dest);
    if (!may.ok) return ctx.fail(may.line, { kinds: [...ctx.kinds, 'locked'] });
  }
  const ws = social.walkStyleOf(ch);
  const word = DIR_WORDS[dirKey] || `through ${dirKey}`;
  await moveTo(ch, dest, `${ch.name} ${ws ? ws.leave : 'heads'} ${word}.`, ws ? `${ch.name} ${ws.enter}.` : `${ch.name} arrives.`);
  ctx.need({ fun: 0.3 });
  ctx.say(`You go ${word}.`);
  return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'move'] });
}

async function autowalk(ctx, wanted) {
  const { ch } = ctx;
  const allRooms = await MooRoom.find({}).select('roomId name exits props.locks props.home district').lean();
  const byId = Object.fromEntries(allRooms.map((r) => [r.roomId, r]));
  const wLower = wanted.toLowerCase().replace(/^(the\s+)/, '');
  const pub = allRooms.filter((r) => !(r.props && r.props.home) || (r.props.home.owner === ch.userId) || ((r.props.home.tenants || []).includes(ch.userId)));
  const target = pub.find((r) => r.name.toLowerCase().replace(/^the\s+/, '') === wLower || r.roomId === wLower.replace(/\s+/g, '_'))
    || pub.find((r) => r.name.toLowerCase().includes(wLower))
    || pub.find((r) => r.roomId.includes(wLower.replace(/\s+/g, '_')));
  if (!target) return ctx.fail(`Nowhere called "${wanted}" on the map. Try: map, or places.`);
  if (target.roomId === ch.roomId) return ctx.ok({ lines: [...ctx.lines, 'You are already there.'] });
  const prev = { [ch.roomId]: null };
  const queue = [ch.roomId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === target.roomId) break;
    const r = byId[cur]; if (!r) continue;
    for (const [dir, to] of Object.entries(r.exits || {})) {
      if ((r.props && r.props.locks && r.props.locks[dir]) && !(byId[to] && byId[to].props && byId[to].props.home && (byId[to].props.home.owner === ch.userId || (byId[to].props.home.tenants || []).includes(ch.userId)))) continue;
      if (to in prev || !byId[to]) continue;
      prev[to] = cur; queue.push(to);
    }
  }
  if (!(target.roomId in prev)) return ctx.fail(`No walking way to ${target.name} from here. Some places are reached by tram, ferry, or a car — or not by streets at all.`);
  let steps = 0; for (let cur = target.roomId; prev[cur]; cur = prev[cur]) steps++;
  const veh = await require('./vehicles').riding(ctx);
  const ws = social.walkStyleOf(ch);
  const how = veh ? veh.verbLine : (ws ? ws.leave : 'sets off');
  await moveTo(ch, target.roomId, `${ch.name} ${how} toward ${target.name}.`, veh ? `${ch.name} ${veh.arriveLine}.` : (ws ? `${ch.name} ${ws.enter} off the street.` : `${ch.name} arrives from the streets.`));
  const secs = veh ? Math.min(2 + Math.ceil(steps * veh.secPerStep), 12) : Math.min(3 + steps * 2, 18);
  await setBusy(ch, secs, veh ? veh.doing : 'walking');
  if (!veh && steps >= 4) ctx.learn('fitness', 1);
  ctx.need({ fun: 0.5, rested: veh ? 0 : -steps * 0.4 });
  ctx.say(veh ? `You ${veh.verb} to ${target.name} — ${plural(steps, 'street')} over, quick.` : `You walk to ${target.name} — ${plural(steps, 'street')} over.`);
  return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, veh ? veh.sound : 'move'] });
}

registry.register({
  name: 'go', aliases: ['walk', 'head', 'move'],
  help: { topic: 'moving', usage: 'go north · n · go to the pier · go to pats', blurb: 'Walk a direction, or name a place and your feet find it.' },
  async run(ctx, { arg }) {
    if (!arg) {
      if (ctx.lower === 'walk') return registry.get('walk mode').run(ctx, { arg: '', argRaw: '' });
      return ctx.fail('Go where? A direction, or "go to <place>".');
    }
    if (/^to\s+/.test(arg)) return autowalk(ctx, arg.replace(/^to\s+(the\s+)?/, '').trim());
    const key = DIR_ALIASES[arg] || arg.replace(/^the\s+/, '').replace(/\s+/g, '_');
    const room = await ctx.room();
    if (!(room && room.exits && room.exits[key]) && !DIR_ALIASES[arg]) return autowalk(ctx, arg);
    return walk(ctx, key);
  },
});
for (const [word, key] of Object.entries(DIR_ALIASES)) {
  if (word === key || ['in', 'out'].includes(word)) continue;
}
registry.register({
  name: 'n', aliases: ['north'], hidden: true, help: { topic: 'moving', usage: 'n', blurb: 'North.' }, run: (ctx) => walk(ctx, 'n'),
});
registry.register({ name: 's', aliases: ['south'], hidden: true, help: { topic: 'moving', usage: 's', blurb: 'South.' }, run: (ctx) => walk(ctx, 's') });
registry.register({ name: 'e', aliases: ['east'], hidden: true, help: { topic: 'moving', usage: 'e', blurb: 'East.' }, run: (ctx) => walk(ctx, 'e') });
registry.register({ name: 'w', aliases: ['west'], hidden: true, help: { topic: 'moving', usage: 'w', blurb: 'West.' }, run: (ctx) => walk(ctx, 'w') });
registry.register({ name: 'ne', aliases: ['northeast'], hidden: true, help: { topic: 'moving', usage: 'ne', blurb: 'Northeast.' }, run: (ctx) => walk(ctx, 'ne') });
registry.register({ name: 'nw', aliases: ['northwest'], hidden: true, help: { topic: 'moving', usage: 'nw', blurb: 'Northwest.' }, run: (ctx) => walk(ctx, 'nw') });
registry.register({ name: 'se', aliases: ['southeast'], hidden: true, help: { topic: 'moving', usage: 'se', blurb: 'Southeast.' }, run: (ctx) => walk(ctx, 'se') });
registry.register({ name: 'sw', aliases: ['southwest'], hidden: true, help: { topic: 'moving', usage: 'sw', blurb: 'Southwest.' }, run: (ctx) => walk(ctx, 'sw') });
registry.register({ name: 'u', aliases: ['up', 'upstairs'], hidden: true, help: { topic: 'moving', usage: 'up', blurb: 'Up.' }, run: (ctx) => walk(ctx, 'u') });
registry.register({ name: 'd', aliases: ['down', 'downstairs'], hidden: true, help: { topic: 'moving', usage: 'down', blurb: 'Down.' }, run: (ctx) => walk(ctx, 'd') });
registry.register({ name: 'in', aliases: ['enter', 'inside'], hidden: true, help: { topic: 'moving', usage: 'in', blurb: 'Go inside.' }, run: (ctx) => walk(ctx, 'in') });
registry.register({ name: 'out', aliases: ['outside', 'leave'], hidden: true, help: { topic: 'moving', usage: 'out', blurb: 'Step outside.' }, run: (ctx) => walk(ctx, 'out') });

registry.register({
  name: 'back', help: { topic: 'moving', usage: 'back', blurb: 'Retrace your last step.' },
  async run(ctx) {
    const prevId = ctx.ch.attrs && ctx.ch.attrs.prevRoom;
    if (!prevId) return ctx.fail('No steps to retrace yet.');
    const there = await MooRoom.findOne({ roomId: prevId }).select('roomId name').lean();
    if (!there) return ctx.fail('The way back is not there anymore.');
    await moveTo(ctx.ch, prevId, `${ctx.ch.name} doubles back.`, `${ctx.ch.name} comes back.`);
    ctx.say('You retrace your steps.');
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'move'] });
  },
});

registry.register({
  name: 'places', aliases: ['where can i go', 'destinations'], free: true,
  help: { topic: 'moving', usage: 'places · places hook', blurb: 'Every named place you can "go to", by ward.' },
  async run(ctx, { arg }) {
    const rooms = await MooRoom.find({ 'props.home': { $exists: false } }).select('name district').lean();
    const wards = {};
    for (const r of rooms) (wards[r.district] = wards[r.district] || []).push(r.name);
    const names = { gate: 'the Threshold', bellward: 'Bellward', hook: 'the Hook', tanglefoot: 'Tanglefoot', patch: 'the Patch', millrace: 'Millrace', sweetwater: 'Sweetwater', fairlawn: 'Fairlawn', longacre: 'Long Acre', gravewalk: 'the Gravewalk' };
    const want = arg ? Object.keys(names).find((k) => k.includes(arg) || names[k].toLowerCase().includes(arg)) : null;
    const keys = want ? [want] : Object.keys(names).filter((k) => wards[k] && k !== 'gravewalk');
    for (const k of keys) if (wards[k]) ctx.say(`${names[k]}: ${wards[k].sort().join(', ')}.`);
    ctx.say('Say "go to <place>" and your feet find it.');
    return ctx.ok();
  },
});

/* ── WHO / WHERE / TIME ───────────────────────────────────────────────── */
registry.register({
  name: 'who', aliases: ['online', 'players'], free: true,
  help: { topic: 'people', usage: 'who', blurb: 'Who is playing right now, and roughly where.' },
  async run(ctx) {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const players = await MooChar.find({ userId: { $not: /^(npc|stray|kid|pet):/ }, active: true, lastActiveAt: { $gte: since }, 'attrs.life.created': true }).select('name userId roomId lastActiveAt').lean();
    const rooms = await MooRoom.find({ roomId: { $in: players.map((p) => p.roomId) } }).select('roomId name district').lean();
    const byId = Object.fromEntries(rooms.map((r) => [r.roomId, r]));
    const others = players.filter((p) => p.userId !== ctx.userId);
    const cits = await MooChar.countDocuments({ userId: /^npc:/ });
    if (!others.length) ctx.say(`Nobody else is awake in the city right now — just you and ${cits} citizens going about their day. Say something anyway; the room hears you.`);
    else ctx.say(`Awake in the city: ${others.map((p) => { const r = byId[p.roomId]; return `${p.name} (${r ? r.name : 'somewhere'})`; }).join(', ')}. Plus you.`);
    return ctx.ok();
  },
});
registry.register({
  name: 'where', aliases: ['where am i'], free: true,
  help: { topic: 'senses', usage: 'where', blurb: 'Where you are, in one line.' },
  async run(ctx) {
    const room = await ctx.room();
    const d = room ? await require('./ctx').districtOf(room) : null;
    ctx.say(`You are at ${room ? room.name : 'nowhere'}, in ${d ? d.name : 'the city'}. ${room && room.props && room.props.doings ? room.props.doings : ''}`.trim());
    return ctx.ok();
  },
});
registry.register({
  name: 'time', aliases: ['clock', 'what time is it'], free: true,
  help: { topic: 'senses', usage: 'time', blurb: 'The city’s clock.' },
  async run(ctx) {
    const c = worldClock();
    ctx.say(`It is ${clockLine()} — ${c.bucket}, ${c.weekday === 'Sat' || c.weekday === 'Sun' ? 'the weekend' : 'a weekday'}. ${reverie.weatherNow().line}`);
    return ctx.ok();
  },
});

/* ── STATUS / NEEDS / SKILLS / INVENTORY ─────────────────────────────── */
registry.register({
  name: 'status', aliases: ['me', 'needs', 'mood', 'how am i'], free: true,
  help: { topic: 'you', usage: 'status', blurb: 'How you are doing: mood, meters, coin, marks.' },
  async run(ctx) {
    const { ch, life } = ctx;
    const nd = life.needs || needs.fresh();
    const room = await ctx.room();
    ctx.say(`You are ${ch.name}, at ${room ? room.name : 'nowhere'}. ${needs.statusLine(nd)}`);
    ctx.say(`Meters: ${needs.NEEDS.map((n) => `${n} ${Math.round(nd[n])} (${needs.word(n, nd[n])})`).join(', ')}.`);
    ctx.say(`${coinOf(ch)} coin in your pocket.${life.homeName ? ` Home: ${life.homeName}.` : ' No place of your own yet (listings shows what is for rent).'}${life.partnerName ? ` Partner: ${life.partnerName}.` : ''}`);
    if (Array.isArray(ch.attrs.marks) && ch.attrs.marks.length) ctx.say(`Marks: ${ch.attrs.marks.join(', ')}.`);
    const h = needs.hud(nd);
    if (h.hint) ctx.say(h.hint);
    return ctx.ok();
  },
  buttons: () => [{ label: 'How am I?', cmd: 'status', group: 'self' }],
});
registry.register({
  name: 'skills', aliases: ['skill'], free: true,
  help: { topic: 'you', usage: 'skills', blurb: 'Your ten skills and how far along each is.' },
  async run(ctx) {
    const rows = skills.summary(ctx.life.skills || {});
    ctx.say(skills.summaryLine(ctx.life.skills || {}));
    const learning = rows.filter((r) => r.level > 0 && r.next).map((r) => `${r.name}: ${r.xp}/${r.next} to level ${r.level + 1}`);
    if (learning.length) ctx.say(learning.join('; ') + '.');
    ctx.say('Skills: ' + Object.values(skills.SKILLS).map((s) => s.name).join(', ') + '. Do the thing and it grows. Good moods learn faster.');
    return ctx.ok();
  },
});
registry.register({
  name: 'inventory', aliases: ['inv', 'i', 'pockets', 'bag'], free: true,
  help: { topic: 'you', usage: 'inventory', blurb: 'What you carry, and your coin.' },
  async run(ctx) {
    const items = await itemsHeld(ctx.userId);
    const veh = items.filter((i) => i.props && i.props.vehicle);
    const rest = items.filter((i) => !(i.props && i.props.vehicle));
    ctx.say(rest.length ? `You carry: ${rest.map((i) => i.name).join(', ')}.` : 'Your pockets hold nothing but coin.');
    if (veh.length) ctx.say(`Yours to ride: ${veh.map((v) => v.name).join(', ')}.`);
    ctx.say(`${coinOf(ctx.ch)} coin.`);
    return ctx.ok();
  },
  buttons: () => [{ label: 'Pockets', cmd: 'inventory', group: 'self' }],
});
registry.register({
  name: 'coins', aliases: ['coin', 'money', 'wallet'], free: true,
  help: { topic: 'money', usage: 'coins', blurb: 'How much coin you have.' },
  async run(ctx) { ctx.say(`${coinOf(ctx.ch)} coin.`); return ctx.ok(); },
});

/* ── WHAT (can I do here) ────────────────────────────────────────────── */
registry.register({
  name: 'what', aliases: ['what can i do', 'what now', 'dir', 'directory', 'options'], free: true,
  help: { topic: 'help', usage: 'what', blurb: 'What there is to do right here, right now.' },
  async run(ctx) {
    const room = await ctx.room();
    if (room && room.props && room.props.doings) ctx.say(room.props.doings);
    const acts = await view.actions(ctx);
    const here = acts.filter((a) => a.group === 'here').map((a) => a.label);
    if (here.length) ctx.say('Right here you can: ' + here.join(', ') + '.');
    const rv = await view.describeRoom(ctx);
    if (rv.peopleDetail.length) ctx.say('Here with you: ' + rv.peopleDetail.map((p) => p.line).join('; ') + '. Tap a name, or: talk to <name>, chat <name>, hug <name>.');
    ctx.say(exitsLine(room || {}));
    return ctx.ok();
  },
  buttons: () => [{ label: 'What can I do?', cmd: 'what', group: 'self' }],
});

/* ── EAT ──────────────────────────────────────────────────────────────── */
registry.register({
  name: 'eat', aliases: ['order', 'dine', 'drink'],
  help: { topic: 'needs', usage: 'eat · eat <food you carry> · order', blurb: 'Eat where food is sold, or eat something from your pockets.' },
  async run(ctx, { arg, argRaw }) {
    const { ch } = ctx;
    if (arg) {
      const food = await findHeld(ch.userId, arg, { 'props.food': { $exists: true } });
      if (!food) return ctx.fail(`You carry nothing called "${argRaw}" you can eat.`);
      await MooItem.deleteOne({ _id: food._id });
      const f = food.props.food;
      ctx.need({ fed: f.feed || 25, fun: f.fun || 3 });
      await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} eats ${food.name}.`);
      ctx.say(`You eat ${food.name}. ${f.line || 'Good. Simple.'}`);
      return ctx.ok({ kinds: [...ctx.kinds, 'eat'] });
    }
    const room = await ctx.room();
    const food = room && room.props && room.props.food;
    if (!food) {
      const held = await MooItem.find({ 'location.type': 'char', 'location.id': ch.userId, 'props.food': { $exists: true } }).lean();
      if (held.length) return ctx.fail(`Nothing sold here, but you carry ${held.map((h) => h.name).join(', ')}. Eat one by name.`);
      return ctx.fail('Nothing to eat here. Pat’s, the Taco Window, Ruth-Ann’s stoop, the Truck Stop, the Tandy stand — food is where the people are. Or cook at home.');
    }
    const price = food.price || 0;
    if (price > coinOf(ch)) return ctx.fail(`That runs ${price} coin and you carry ${coinOf(ch)}. Ruth-Ann’s stoop feeds anybody, no questions — or work a shift first.`, { kinds: [...ctx.kinds, 'err'] });
    if (price) await payCoin(ch, price);
    await setAttrs(ch, { lastMeal: Date.now() });
    ctx.need({ fed: 45, fun: 4, company: 3 });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} settles in to eat.`);
    ctx.say(`You eat: ${food.menu}. ${price ? price + ' coin, well spent.' : 'No charge. Arguing about that has been tried.'}`);
    return ctx.ok({ kinds: [...ctx.kinds, 'eat'] });
  },
  async buttons(ctx) {
    const room = await ctx.room();
    const out = [];
    if (room && room.props && room.props.food) out.push({ label: `Eat (${room.props.food.price || 0} coin)`, cmd: 'eat', group: 'here' });
    return out;
  },
});

/* ── SLEEP ────────────────────────────────────────────────────────────── */
registry.register({
  name: 'sleep', aliases: ['rest', 'nap', 'lie down'],
  help: { topic: 'needs', usage: 'sleep', blurb: 'Sleep somewhere safe. Your own bed does it best.' },
  async run(ctx) {
    const { ch, life } = ctx;
    const room = await ctx.room();
    const isHome = life.home && life.home === ch.roomId;
    const bed = isHome ? await MooItem.findOne({ 'location.type': 'room', 'location.id': ch.roomId, 'props.furniture': 'bed' }).lean() : null;
    const safe = (room && room.props && room.props.sleepable) || isHome;
    if (!safe) return ctx.fail('Not a sleeping spot. Mercy never closes, the Kettle keeps its corner, the clinic has chairs, the truck stop booths have held worse — or rent a place of your own (listings).');
    const gain = bed ? 70 : isHome ? 45 : 35;
    await setAttrs(ch, { lastSleep: Date.now(), posture: 'standing' });
    ctx.need({ rested: gain, clean: bed ? 0 : -5 });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} sleeps a while, and the room keeps its voice down.`);
    await setBusy(ch, bed ? 4 : 6, 'sleeping');
    ctx.say(bed ? `You sleep in your own bed. The best kind. You wake fresh.` : isHome ? 'You sleep on the floor of your own place. A bed would be better — Hock’s and the junk market sell them.' : 'You sleep, upright and public. The world holds its noise down for you. You wake rested enough.');
    return ctx.ok({ kinds: [...ctx.kinds, 'sleep'] });
  },
  async buttons(ctx) {
    const room = await ctx.room();
    const isHome = ctx.life.home && ctx.life.home === ctx.ch.roomId;
    return (room && room.props && room.props.sleepable) || isHome ? [{ label: 'Sleep', cmd: 'sleep', group: 'here' }] : [];
  },
});

/* ── WORK + CAREERS ───────────────────────────────────────────────────── */
const CAREER_TITLES = ['new hand', 'regular', 'trusted', 'second', 'the boss’s right hand'];
const CAREER_STEPS = [0, 5, 14, 30, 55];
const CAREER_MULT = [1, 1.25, 1.5, 1.8, 2.2];
function careerLevel(shifts) { let lvl = 0; for (let i = 0; i < CAREER_STEPS.length; i++) if (shifts >= CAREER_STEPS[i]) lvl = i; return lvl; }
function careerSkill(jobName) {
  const j = jobName.toLowerCase();
  if (/archive|desk|record/.test(j)) return 'learning';
  if (/sink|grill|kitchen|diner|taco/.test(j)) return 'cooking';
  if (/bar|dez|parlor/.test(j)) return 'charm';
  if (/dock|crate|salvage|scale|field|orchard|press/.test(j)) return 'fitness';
  if (/garage|outboard|repair/.test(j)) return 'handy';
  if (/plot|garden|greenhouse/.test(j)) return 'garden';
  if (/clinic|mercy|children/.test(j)) return 'care';
  return 'hustle';
}

registry.register({
  name: 'work', aliases: ['shift', 'clock in'],
  help: { topic: 'money', usage: 'work', blurb: 'Work a shift where there is work. Shifts add up to promotions.' },
  async run(ctx) {
    const { ch, life } = ctx;
    const room = await ctx.room();
    const job = room && room.props && room.props.job;
    if (!job) return ctx.fail('No work here. The docks, the Archive desk, Pat’s sink, Dez’s bar, the salvage scale, the garden plots, the fields, the orchard — work is where the verbs are. "careers" shows your standing.');
    const t = todayKey();
    const workDay = (ch.attrs.workDay === t) ? (ch.attrs.workCount || 0) : 0;
    if (workDay >= 6) return ctx.fail(job.refusal || 'The work waves you off. Six shifts is a day. Tomorrow exists for a reason.');
    const careers = life.careers || {};
    const c = careers[job.name] || { shifts: 0 };
    const before = careerLevel(c.shifts);
    c.shifts += 1;
    const after = careerLevel(c.shifts);
    const wage = Math.round((job.wage || 5) * CAREER_MULT[after]);
    careers[job.name] = c;
    await setAttrs(ch, { workDay: t, workCount: workDay + 1, 'life.careers': careers }, { coin: wage });
    life.careers = careers;
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} works a shift at ${job.name}.`);
    await setBusy(ch, 10, 'working');
    ctx.need({ fed: -6, rested: -8, clean: -6, fun: -3, company: 4 });
    ctx.learn(careerSkill(job.name), 3);
    ctx.say(`${job.line} That is ${wage} coin — shift ${workDay + 1} of 6 today.`);
    if (after > before) {
      ctx.say(`Word comes down: you are ${CAREER_TITLES[after]} at ${job.name} now. Pay goes up.`);
      await require('./drama').rumor(ctx, `${ch.name} got moved up at ${job.name}`, 'work', 2);
      ctx.kind('levelup');
    }
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
  async buttons(ctx) {
    const room = await ctx.room();
    return room && room.props && room.props.job ? [{ label: `Work a shift (${room.props.job.name})`, cmd: 'work', group: 'here' }] : [];
  },
});
registry.register({
  name: 'careers', aliases: ['career', 'jobs'], free: true,
  help: { topic: 'money', usage: 'careers', blurb: 'Your standing at every job you have worked.' },
  async run(ctx) {
    const careers = ctx.life.careers || {};
    const rows = Object.entries(careers);
    if (!rows.length) ctx.say('You have not worked a shift anywhere yet. Work is where the verbs are: the docks, the Archive desk, Pat’s sink, Dez’s bar, the salvage scale, the plots, the fields, the orchard.');
    else ctx.say(rows.map(([name, c]) => { const lvl = careerLevel(c.shifts); const next = CAREER_STEPS[lvl + 1]; return `${name}: ${CAREER_TITLES[lvl]} (${c.shifts} shifts${next ? `, ${next - c.shifts} to the next step` : ', top of the ladder'})`; }).join('; ') + '.');
    return ctx.ok();
  },
});

/* ── WAIT / IDLE ──────────────────────────────────────────────────────── */
registry.register({
  name: 'wait', aliases: ['idle', 'hang out', 'chill'], free: true,
  /* a player with a line in the water is waiting on the Bite — that is the old engine's wait */
  when: (ctx) => !(ctx.ch.attrs && ctx.ch.attrs.fishing), fallthrough: true,
  help: { topic: 'senses', usage: 'wait', blurb: 'Let a moment pass and hear what the room does.' },
  async run(ctx) {
    const room = await ctx.room();
    const lines = ['You let a moment pass.', 'You wait, and the room goes on without you for a beat.', 'You stand still and listen.'];
    ctx.say(pick(lines) + (room && room.props && room.props.listenLine ? ' ' + room.props.listenLine : ''));
    ctx.need({ rested: 1 });
    return ctx.ok();
  },
});

module.exports = { walk, autowalk, exitsLine, careerLevel, CAREER_TITLES };
