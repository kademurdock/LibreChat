/* REVERIE LIFE — a place of your own (Sep 6 2026).
 *
 * Nine listings across the wards, from a room over Pat’s to a house behind
 * the Fairlawn gates. Rent is weekly and comes out on the world tick; being
 * behind is a nag and a rumor, never an eviction (comfort meters, not death
 * timers — the same law, applied to a roof). A home is a real room in the
 * same city: it has a door onto its street, other people can visit it, and
 * what you put in it changes what you can do there. Households share one
 * key ring: a partner who moves in, a kid who grows up here, a pet.
 *
 * Doors have a policy: open (anyone walks in), friends (people you like
 * can, when you are home), locked (keys only). Knocking always works. */
const registry = require('./registry');
const {
  MooRoom, MooChar, MooItem, emit, tell, setAttrs, setBusy, moveTo, coinOf, payCoin, matchName, itemsHeld, itemsIn, findHeld, makeItem, plural, joinAnd, cap, slug,
} = require('./ctx');

const LISTINGS = [
  { key: 'room_over_pats', name: 'the room over Pat’s', ward: 'hook', street: 'hook_front_street', rent: 18, deposit: 10, landlord: 'Pat Harris',
    desc: 'One room over the diner. The floor is warm from the grill below and the window looks at the harbor if you lean. It smells like coffee at five every morning whether you like it or not.',
    smell: 'Bacon and coffee coming up through the floorboards.' },
  { key: 'patch_rowhouse', name: 'a row house on Gully Road', ward: 'patch', street: 'patch_gully_road', rent: 25, deposit: 15, landlord: 'Ruth-Ann Purvis',
    desc: 'Two rooms and a stoop, in a row of the same. The walls are thin enough to know your neighbors’ business and thick enough to keep yours. The stoop is the best seat in the ward.',
    smell: 'Somebody’s greens through the wall, and old paint.' },
  { key: 'tanglefoot_loft', name: 'the loft over Hock’s Pawn', ward: 'tanglefoot', street: 'tanglefoot_line_street', rent: 30, deposit: 20, landlord: 'Aurelio Hock',
    desc: 'Brick, bare bulbs, and a window that buzzes pink from the sign across the street. Dez’s bass comes through the floor after ten. Nobody sleeps early here and nobody wants to.',
    smell: 'Dust, incense from somewhere, and last night.' },
  { key: 'millrace_workshop', name: 'a workshop bay in Millrace', ward: 'millrace', street: 'millrace_channel', rent: 28, deposit: 20, landlord: 'Royce Cutler',
    desc: 'A roll-up door, a concrete floor with a drain in it, and a mezzanine for sleeping. Room for a car, a bike, and every project you will never finish. The channel runs loud out back.',
    smell: 'Motor oil and wet concrete.' },
  { key: 'sweetwater_cottage', name: 'a cottage by the plots', ward: 'sweetwater', street: 'sweetwater_park', rent: 38, deposit: 25, landlord: 'the Parks Board',
    desc: 'Small and white with a porch that catches the afternoon. The garden plots are across the path and the creek talks all night. Ducks consider the yard theirs.',
    smell: 'Cut grass, creek water, and tomato leaves.' },
  { key: 'bell_flat', name: 'a flat above the bookshop', ward: 'bellward', street: 'bell_court_street', rent: 40, deposit: 30, landlord: 'Constance Ledger-Pryce',
    desc: 'High ceilings, a window seat, and the bell tower close enough to set your watch wrong by. The bookshop below closes at six and the quiet after is total.',
    smell: 'Paper and floor wax.' },
  { key: 'longacre_farmhouse', name: 'a farmhouse on the Ring Road', ward: 'longacre', street: 'ring_road', rent: 22, deposit: 15, landlord: 'Birdie Tandy',
    desc: 'A big old kitchen, a porch that faces the fields, and the freight going by at 11:40 close enough to rattle the glass. Miles of quiet in every direction.',
    smell: 'Woodsmoke, hay, and rain coming.' },
  { key: 'fairlawn_house', name: 'a house on Fairlawn Avenue', ward: 'fairlawn', street: 'fairlawn_ave', rent: 75, deposit: 60, purchase: 700, landlord: 'the Homeowners’ Association',
    desc: 'Lawn cut to the inch, a two-car drive, and a front room nobody sits in. The neighbors nod. The HOA has opinions about your mailbox. It is, undeniably, a nice house.',
    smell: 'Sprinklers, fresh paint, and nothing.' },
  { key: 'hook_houseboat', name: 'a houseboat at Pier Seven', ward: 'hook', street: 'pier_seven', rent: 20, deposit: 15, landlord: 'Marva Cutler',
    desc: 'She lists a little to port and the bilge pump has a personality. You fall asleep to water and wake to gulls. You can fish off your own back step.',
    smell: 'Diesel, salt, and coffee.', water: true },
];

function listingByKey(k) { return LISTINGS.find((l) => l.key === k); }
function homeIdFor(userId, key) { return `home_${slug(userId).slice(0, 12)}_${key}`; }

async function myHome(ch) {
  const hid = ch.attrs && ch.attrs.life && ch.attrs.life.home;
  if (!hid) return null;
  return MooRoom.findOne({ roomId: hid }).lean();
}
async function homesOf(userId) {
  return MooRoom.find({ $or: [{ 'props.home.owner': userId }, { 'props.home.tenants': userId }] }).lean();
}
function hasKey(room, userId) {
  const h = room && room.props && room.props.home;
  return !!h && (h.owner === userId || (h.tenants || []).includes(userId) || (h.keys || []).includes(userId));
}

/** May this character pass a locked exit? Homes decide by policy. */
async function mayPass(ctx, room, dirKey, destId) {
  const dest = await MooRoom.findOne({ roomId: destId }).lean();
  if (!dest || !(dest.props && dest.props.home)) return { ok: false, line: `The way ${dirKey} is locked. (unlock ${dirKey} — if you carry the right key.)` };
  return mayEnter(ctx, dest);
}
async function mayEnter(ctx, dest) {
  const h = dest.props.home;
  const me = ctx.userId;
  if (hasKey(dest, me)) return { ok: true };
  const ownerHome = await MooChar.findOne({ userId: h.owner, roomId: dest.roomId }).select('name').lean();
  if (h.door === 'open') return { ok: true };
  if (h.door === 'friends' || !h.door) {
    if (!ownerHome) return { ok: false, line: `${h.ownerName}’s door is shut and nobody is home. Knock anyway, or come back later.` };
    const rel = await require('./relationships').getRel(me, h.owner);
    if (rel.friendship >= 25) return { ok: true, line: `${h.ownerName} lets you in.` };
    return { ok: false, line: `${h.ownerName} is home, but you do not know each other that well yet. Knock.` };
  }
  return { ok: false, line: `${h.ownerName}’s door is locked. Knock, or ask for a key.` };
}

/* ── LISTINGS / RENT / BUY ───────────────────────────────────────────── */
registry.register({
  name: 'listings', aliases: ['for rent', 'housing', 'homes for rent', 'rentals'], free: true,
  help: { topic: 'home', usage: 'listings · listings hook', blurb: 'What is for rent in the city, and what it costs a week.' },
  async run(ctx, { arg }) {
    const mine = await homesOf(ctx.userId);
    const have = new Set(mine.map((m) => m.props.home.listing));
    let rows = LISTINGS.filter((l) => !have.has(l.key));
    if (arg) rows = rows.filter((l) => l.ward.includes(arg) || l.name.toLowerCase().includes(arg));
    if (!rows.length) return ctx.fail('Nothing listed matching that. "listings" alone shows everything.');
    ctx.say('For rent this week (rent per week, plus a deposit once):');
    for (const l of rows) ctx.say(`${cap(l.name)} — ${l.rent} a week, ${l.deposit} down${l.purchase ? `, or buy outright for ${l.purchase}` : ''}. ${l.desc.split('. ')[0]}. Say: rent ${l.name.replace(/^(the|a)\s+/, '').split(' ').slice(0, 2).join(' ')}`);
    ctx.say(`You carry $${coinOf(ctx.ch)}. Renting takes the deposit and the first week up front.`);
    return ctx.ok({ choices: rows.map((l) => ({ label: `Rent ${l.name} (${l.rent}/wk)`, cmd: `rent ${l.key}` })) });
  },
  buttons: async (ctx) => {
    const room = await ctx.room();
    const here = LISTINGS.some((l) => l.street === (room && room.roomId));
    return here && !ctx.life.home ? [{ label: 'See what’s for rent here', cmd: 'listings', group: 'here' }] : [];
  },
});

registry.register({
  name: 'rent', aliases: ['lease', 'sign lease'],
  help: { topic: 'home', usage: 'rent <listing>', blurb: 'Take a place. Deposit and first week up front; rent comes out weekly.' },
  async run(ctx, { arg }) {
    const { ch, life } = ctx;
    if (!arg) return ctx.fail('Rent which? "listings" shows what is open.');
    const homes = await homesOf(ch.userId);
    if (homes.filter((h) => h.props.home.owner === ch.userId).length >= 2) return ctx.fail('Two places to a name. Sell or move out of one first.');
    const l = LISTINGS.find((x) => x.key === arg.replace(/\s+/g, '_')) || matchName(LISTINGS, arg, (x) => x.name.replace(/^(the|a)\s+/, ''), (x) => x.ward) || LISTINGS.find((x) => x.desc.toLowerCase().includes(arg));
    if (!l) return ctx.fail(`No listing called "${arg}". Try "listings".`);
    const roomId = homeIdFor(ch.userId, l.key);
    if (await MooRoom.findOne({ roomId }).lean()) return ctx.fail(`You already hold ${l.name}.`);
    const cost = l.deposit + l.rent;
    if (coinOf(ch) < cost) return ctx.fail(`${cap(l.name)} wants $${cost} to move in (${l.deposit} deposit, ${l.rent} first week). You carry ${coinOf(ch)}. Work is where the verbs are.`, { kinds: [...ctx.kinds, 'err'] });
    await payCoin(ch, cost);
    const street = await MooRoom.findOne({ roomId: l.street }).select('name').lean();
    await MooRoom.create({
      roomId, name: `${ch.name}’s place — ${l.name}`, district: l.ward, desc: l.desc,
      exits: { out: l.street },
      props: { home: { owner: ch.userId, ownerName: ch.name, listing: l.key, tenants: [], keys: [], door: 'friends', rent: l.rent, rentDue: Date.now() + 7 * 86400000, owned: false, since: Date.now() }, smell: l.smell, sleepable: true, indoor: true, water: !!l.water, doings: 'Your place. Sleep, cook if you have a stove, shower if you have one, sit on the porch, have people over. "furnish" to see what you can add.' },
      createdBy: ch.userId,
    });
    life.home = roomId; life.homeName = l.name; life.homeStreet = l.street;
    await setAttrs(ch, { 'life.home': roomId, 'life.homeName': l.name, 'life.homeStreet': l.street, home: roomId });
    await emit(l.street, ch.userId, ch.name, 'emote', `${ch.name} signs for ${l.name}. ${l.landlord} hands over a key.`);
    await require('./drama').rumor(ctx, `${ch.name} took ${l.name}`, 'home', 2);
    ctx.say(`${l.landlord} counts the coin twice and hands you a key. ${cap(l.name)} is yours — ${l.rent} a week, out of your pocket every seven days. ${street ? `The door is off ${street.name}.` : ''} Say "home" to go there. It is empty; Hock’s Pawn and the Salvage Yard sell furniture.`);
    ctx.need({ fun: 10, company: 2 });
    return ctx.ok({ kinds: [...ctx.kinds, 'coin', 'door'] });
  },
});

registry.register({
  name: 'buy house', aliases: ['buy home', 'buy the house', 'purchase house'],
  help: { topic: 'home', usage: 'buy house', blurb: 'Own your place outright — no more rent. Only some listings sell.' },
  async run(ctx) {
    const { ch, life } = ctx;
    const room = await ctx.room();
    const h = room && room.props && room.props.home;
    if (!h || h.owner !== ch.userId) return ctx.fail('Stand inside your own place to buy it.');
    const l = listingByKey(h.listing);
    if (!l || !l.purchase) return ctx.fail(`${l ? l.landlord : 'The landlord'} is not selling this one. The Fairlawn house sells.`);
    if (h.owned) return ctx.fail('You already own it, deed and all.');
    if (coinOf(ch) < l.purchase) return ctx.fail(`The deed runs $${l.purchase}. You carry ${coinOf(ch)}.`);
    await payCoin(ch, l.purchase);
    await MooRoom.updateOne({ roomId: room.roomId }, { $set: { 'props.home.owned': true, 'props.home.rent': 0 } });
    await require('./drama').rumor(ctx, `${ch.name} bought ${l.name} outright`, 'money', 4);
    ctx.say(`Constance Ledger-Pryce at the bank slides the deed across. ${cap(l.name)} is yours, no rent, forever. The HOA sends a welcome letter with four pages of rules.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

registry.register({
  name: 'move out', aliases: ['give up lease', 'leave home'],
  help: { topic: 'home', usage: 'move out', blurb: 'Give a place back. Furniture comes with you.' },
  async run(ctx) {
    const { ch, life } = ctx;
    const room = await ctx.room();
    const h = room && room.props && room.props.home;
    if (!h || h.owner !== ch.userId) return ctx.fail('Stand inside your own place to move out of it.');
    const furniture = await MooItem.find({ 'location.type': 'room', 'location.id': room.roomId }).lean();
    for (const f of furniture) await MooItem.updateOne({ _id: f._id }, { $set: { location: { type: 'char', id: ch.userId }, portable: true } });
    const others = await MooChar.find({ roomId: room.roomId, userId: { $ne: ch.userId } }).lean();
    for (const o of others) await MooChar.updateOne({ _id: o._id }, { $set: { roomId: room.exits.out || 'city_gate' } });
    await moveTo(ch, room.exits.out || 'city_gate', null, `${ch.name} comes out carrying everything they own.`);
    await MooRoom.deleteOne({ roomId: room.roomId });
    const rest = await homesOf(ch.userId);
    const next = rest.find((r) => r.props.home.owner === ch.userId);
    life.home = next ? next.roomId : null; life.homeName = next ? listingByKey(next.props.home.listing).name : null;
    await setAttrs(ch, { 'life.home': life.home, 'life.homeName': life.homeName, home: life.home });
    for (const t of (h.tenants || [])) await MooChar.updateMany({ userId: t }, { $set: { 'attrs.life.home': null, 'attrs.life.homeName': null } });
    ctx.say(`You hand back the key. ${plural(furniture.length, 'thing')} come with you, and the deposit does not.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'door'] });
  },
});

/* ── HOME / VISIT / KNOCK / DOOR / INVITE ────────────────────────────── */
registry.register({
  name: 'home', aliases: ['go home', 'head home'],
  help: { topic: 'home', usage: 'home', blurb: 'Go to your place from anywhere in the city.' },
  async run(ctx) {
    const { ch, life } = ctx;
    if (!life.home) {
      if (ch.roomId === 'the_kettle') return ctx.fail('You are already at the Kettle — the closest thing to home you have. "listings" shows places for rent.');
      await moveTo(ch, 'the_kettle', `${ch.name} heads for the Kettle.`, `${ch.name} comes in like they live here.`);
      await setBusy(ch, 4, 'walking');
      ctx.say('No place of your own yet — the Kettle keeps a corner warm for anybody. "listings" shows what is for rent.');
      return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'move'] });
    }
    if (ch.roomId === life.home) return ctx.fail('You are already home.');
    const home = await MooRoom.findOne({ roomId: life.home }).lean();
    if (!home) { await setAttrs(ch, { 'life.home': null, 'life.homeName': null }); return ctx.fail('Your place is… gone. Odd. "listings" to find another.'); }
    const veh = await require('./vehicles').riding(ctx);
    await moveTo(ch, life.home, `${ch.name} heads home.`, `${ch.name} comes in and drops the keys in the dish.`);
    await setBusy(ch, veh ? 3 : 6, 'heading home');
    ctx.need({ rested: 2 });
    ctx.say(veh ? `You ${veh.verb} home.` : 'You make your way home.');
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'door'] });
  },
  buttons: (ctx) => ctx.life.home && ctx.ch.roomId !== ctx.life.home ? [{ label: 'Go home', cmd: 'home', group: 'move' }] : [],
});

registry.register({
  name: 'visit', aliases: ['go to house of', 'drop by'],
  help: { topic: 'home', usage: 'visit <person>', blurb: 'Go to somebody’s place. Their door decides if you get in.' },
  async run(ctx, { arg }) {
    const { ch } = ctx;
    if (!arg) return ctx.fail('Visit who?');
    const homes = await MooRoom.find({ 'props.home': { $exists: true } }).lean();
    const target = matchName(homes, arg, (h) => h.props.home.ownerName) || homes.find((h) => h.name.toLowerCase().includes(arg));
    if (!target) return ctx.fail(`Nobody called "${arg}" has a place in the city that you know of.`);
    if (target.roomId === ch.roomId) return ctx.fail('You are already here.');
    const may = await mayEnter(ctx, target);
    const street = target.exits.out;
    if (!may.ok) {
      if (ch.roomId !== street) { await moveTo(ch, street, `${ch.name} heads off to see somebody.`, `${ch.name} arrives, looking for a door.`); await setBusy(ch, 5, 'walking'); }
      await emit(target.roomId, ch.userId, ch.name, 'system', `Somebody knocks — it is ${ch.name}.`, 'knock');
      ctx.say(`${may.line} You knock. (If they say "let ${ch.name.split(' ')[0]} in", you are in.)`);
      return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'knock'] });
    }
    await moveTo(ch, target.roomId, `${ch.name} heads off to see somebody.`, `${ch.name} comes in.`);
    await setBusy(ch, 5, 'walking');
    ctx.need({ company: 4, fun: 3 });
    ctx.say(`${may.line ? may.line + ' ' : ''}You step into ${target.props.home.ownerName}’s place.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'door'] });
  },
});

registry.register({
  name: 'knock', help: { topic: 'home', usage: 'knock', blurb: 'Knock on the door you are standing at.' },
  async run(ctx) {
    const room = await ctx.room();
    const homes = await MooRoom.find({ 'exits.out': room.roomId, 'props.home': { $exists: true } }).lean();
    if (!homes.length) return ctx.fail('No doors here that knock back.');
    for (const h of homes) await emit(h.roomId, ctx.userId, ctx.ch.name, 'system', `Somebody knocks — it is ${ctx.ch.name}.`, 'knock');
    ctx.say(`You knock at ${joinAnd(homes.map((h) => h.props.home.ownerName + '’s'))}. If somebody is home they heard it.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'knock'] });
  },
});

registry.register({
  name: 'let in', aliases: ['let', 'answer door', 'open door for'],
  help: { topic: 'home', usage: 'let <person> in', blurb: 'Open your door to somebody knocking.' },
  async run(ctx, { arg }) {
    const { ch } = ctx;
    const room = await ctx.room();
    const h = room && room.props && room.props.home;
    if (!h || !hasKey(room, ch.userId)) return ctx.fail('You are not at your own door.');
    const who = arg.replace(/\s+in$/, '').trim();
    const outside = await MooChar.find({ roomId: room.exits.out, userId: { $not: /^(npc|stray):/ } }).lean();
    const t = matchName(outside, who);
    if (!t) return ctx.fail(`Nobody called "${who}" is outside your door right now.`);
    await MooChar.updateOne({ _id: t._id }, { $set: { roomId: room.roomId } });
    await emit(room.exits.out, t.userId, t.name, 'leave', `${t.name} is let in.`);
    await emit(room.roomId, t.userId, t.name, 'enter', `${ch.name} opens the door and ${t.name} comes in.`);
    await tell(t.userId, `${ch.name} opens the door. You are in — "look" to see the place.`, 'system', 'door');
    ctx.need({ company: 4 });
    ctx.say(`You open the door for ${t.name}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'door'] });
  },
  buttons: async (ctx) => {
    const room = await ctx.room();
    if (!room || !room.props || !room.props.home || !hasKey(room, ctx.userId)) return [];
    const outside = await MooChar.find({ roomId: room.exits.out, userId: { $not: /^(npc|stray|kid|pet):/ } }).select('name').lean();
    return outside.map((o) => ({ label: `Let ${o.name.split(' ')[0]} in`, cmd: `let ${o.name.split(' ')[0]} in`, group: 'here' }));
  },
});

registry.register({
  name: 'door', aliases: ['set door'],
  help: { topic: 'home', usage: 'door open · door friends · door locked', blurb: 'Who can walk into your place.' },
  async run(ctx, { arg }) {
    const room = await ctx.room();
    const h = room && room.props && room.props.home;
    if (!h || h.owner !== ctx.userId) return ctx.fail('Stand in your own place to set its door.');
    if (!arg) return ctx.fail(`Your door is set to "${h.door || 'friends'}". Options: open (anyone), friends (people you like, when you are home), locked (keys only).`);
    const v = ['open', 'friends', 'locked'].find((x) => arg.startsWith(x));
    if (!v) return ctx.fail('open, friends, or locked.');
    await MooRoom.updateOne({ roomId: room.roomId }, { $set: { 'props.home.door': v } });
    ctx.say(`Door: ${v}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'door'] });
  },
});

registry.register({
  name: 'give key', aliases: ['invite', 'key for'],
  help: { topic: 'home', usage: 'give key to <person>', blurb: 'Hand somebody a key to your place. They can come and go.' },
  async run(ctx, { arg }) {
    const { ch, life } = ctx;
    if (!life.home) return ctx.fail('You have no place to give a key to.');
    const who = arg.replace(/^to\s+/, '').trim();
    const here = await MooChar.find({ roomId: ch.roomId, userId: { $ne: ch.userId, $not: /^(npc|stray):/ } }).lean();
    const t = matchName(here, who);
    if (!t) return ctx.fail(`Nobody called "${who}" here to hand a key to. They have to be standing with you.`);
    await MooRoom.updateOne({ roomId: life.home }, { $addToSet: { 'props.home.keys': t.userId } });
    await tell(t.userId, `${ch.name} hands you a key to ${life.homeName}. "visit ${ch.name.split(' ')[0]}" gets you there any time.`, 'system', 'coin');
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} hands ${t.name} a key.`);
    await require('./relationships').adjust(ch.userId, t.userId, { friendship: 6 }, { names: { [ch.userId]: ch.name, [t.userId]: t.name } });
    ctx.say(`You hand ${t.name} a key to ${life.homeName}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

/* ── FURNITURE ───────────────────────────────────────────────────────── */
registry.register({
  name: 'place', aliases: ['put down', 'set up', 'install'],
  help: { topic: 'home', usage: 'place <furniture>', blurb: 'Set a piece of furniture up in your place.' },
  async run(ctx, { arg, argRaw }) {
    const { ch } = ctx;
    const room = await ctx.room();
    if (!room || !room.props || !room.props.home || !hasKey(room, ch.userId)) return ctx.fail('Furniture goes in a place you have a key to.');
    const item = await findHeld(ch.userId, arg, { 'props.furniture': { $exists: true } });
    if (!item) return ctx.fail(`You carry no furniture called "${argRaw}". Hock’s Pawn and the Salvage Yard sell it.`);
    const already = await MooItem.findOne({ 'location.type': 'room', 'location.id': room.roomId, 'props.furniture': item.props.furniture }).lean();
    if (already && !['plant', 'lamp', 'rug', 'chair'].includes(item.props.furniture)) return ctx.fail(`There is already ${already.name} here. Pack it up first (pack up ${already.name.replace(/^(a|an|the)\s+/, '')}).`);
    await MooItem.updateOne({ _id: item._id }, { $set: { location: { type: 'room', id: room.roomId }, portable: false } });
    await emit(room.roomId, ch.userId, ch.name, 'emote', `${ch.name} sets up ${item.name}.`);
    ctx.need({ fun: 4 });
    ctx.learn('handy', 2);
    ctx.say(`You set up ${item.name}. ${item.props.effect || ''}`.trim());
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'furniture'] });
  },
  buttons: async (ctx) => {
    const room = await ctx.room();
    if (!room || !room.props || !room.props.home || !hasKey(room, ctx.userId)) return [];
    const held = await MooItem.find({ 'location.type': 'char', 'location.id': ctx.userId, 'props.furniture': { $exists: true } }).select('name').lean();
    return held.slice(0, 4).map((h) => ({ label: `Place ${h.name}`, cmd: `place ${h.name.replace(/^(a|an|the)\s+/, '')}`, group: 'here' }));
  },
});
registry.register({
  name: 'pack up', aliases: ['unplace', 'take down'],
  help: { topic: 'home', usage: 'pack up <furniture>', blurb: 'Take a piece of furniture back into your hands.' },
  async run(ctx, { arg, argRaw }) {
    const room = await ctx.room();
    if (!room || !room.props || !room.props.home || !hasKey(room, ctx.userId)) return ctx.fail('Only in a place you have a key to.');
    const items = await MooItem.find({ 'location.type': 'room', 'location.id': room.roomId, 'props.furniture': { $exists: true } }).lean();
    const it = matchName(items, arg, (i) => i.name.replace(/^(a|an|the)\s+/, ''));
    if (!it) return ctx.fail(`No furniture called "${argRaw}" here.`);
    await MooItem.updateOne({ _id: it._id }, { $set: { location: { type: 'char', id: ctx.userId }, portable: true } });
    ctx.say(`You pack up ${it.name}.`);
    return ctx.ok({ wantRoom: true });
  },
});
registry.register({
  name: 'furnish', aliases: ['furniture', 'decorate'], free: true,
  help: { topic: 'home', usage: 'furnish', blurb: 'What your place has and what it could use.' },
  async run(ctx) {
    const { life } = ctx;
    if (!life.home) return ctx.fail('No place of your own yet. "listings" shows what is for rent.');
    const here = await MooItem.find({ 'location.type': 'room', 'location.id': life.home, 'props.furniture': { $exists: true } }).lean();
    const have = new Set(here.map((i) => i.props.furniture));
    const shops = require('./shops');
    const want = shops.FURNITURE.filter((f) => !have.has(f.type)).map((f) => `${f.name} (${f.effectShort})`);
    ctx.say(here.length ? `${cap(life.homeName)} has: ${here.map((i) => i.name).join(', ')}.` : `${cap(life.homeName)} is bare.`);
    if (want.length) ctx.say(`It could use: ${want.join('; ')}. Hock’s Pawn (Tanglefoot) sells the good stuff; the Salvage Yard (Millrace) sells it cheap and dented.`);
    return ctx.ok();
  },
});

/* ── HOME VERBS: shower, relax, porch ────────────────────────────────── */
async function furnitureHere(roomId, type) { return MooItem.findOne({ 'location.type': 'room', 'location.id': roomId, 'props.furniture': type }).lean(); }
registry.register({
  name: 'shower', aliases: ['bathe', 'wash up', 'bath'],
  help: { topic: 'needs', usage: 'shower', blurb: 'Get clean — at home with a shower, or wherever water is.' },
  async run(ctx) {
    const { ch } = ctx;
    const room = await ctx.room();
    const sh = room.props && room.props.home ? await furnitureHere(room.roomId, 'shower') : null;
    if (sh) { ctx.need({ clean: 60, rested: 5 }); await setBusy(ch, 4, 'showering'); await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} disappears into the shower. Singing, faintly.`); ctx.say('Hot water, your own soap, your own towel. You come out scrubbed.'); return ctx.ok({ kinds: [...ctx.kinds, 'water'] }); }
    if (room.props && room.props.home) return ctx.fail('No shower here yet. Hock’s and the Salvage Yard sell them — or swim off the Pier.');
    if (room.roomId === 'mercy_hospital' || room.roomId === 'the_clinic') { ctx.need({ clean: 35 }); ctx.say('A nurse points at a door without looking up. Institutional soap. You come out cleaner and smelling like a hallway.'); return ctx.ok({ kinds: [...ctx.kinds, 'water'] }); }
    if (room.props && (room.props.water || room.roomId === 'the_pier' || room.roomId === 'the_lake_dock' || room.roomId === 'the_breakwater')) return registry.get('swim').run(ctx, { arg: '' });
    return ctx.fail('Nowhere to wash here. Home with a shower, Mercy’s hallway bath, or a swim off the Pier, the Lake Dock, or the Breakwater.');
  },
  buttons: async (ctx) => {
    const room = await ctx.room();
    if (room && room.props && room.props.home && await furnitureHere(room.roomId, 'shower')) return [{ label: 'Shower', cmd: 'shower', group: 'here' }];
    return [];
  },
});
registry.register({
  name: 'swim', aliases: ['take a swim', 'dip'],
  help: { topic: 'fun', usage: 'swim', blurb: 'Off the Pier, the Lake Dock, or the Breakwater. Cold, clean, and good for you.' },
  when: async (ctx) => { const r = await ctx.room(); return !!(r && (r.props && r.props.water || ['the_pier', 'the_lake_dock', 'the_breakwater', 'pier_seven'].includes(r.roomId))); },
  whyNot: () => 'No water to swim in here. The Pier, the Lake Dock, Pier Seven, the Breakwater.',
  async run(ctx) {
    const { ch } = ctx;
    const room = await ctx.room();
    const cold = require('../reverie').weatherNow().kind;
    await setBusy(ch, 8, 'swimming');
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} jumps in. The splash reaches the boards.`);
    ctx.need({ clean: 40, fun: 15, rested: -6, fed: -4 });
    ctx.learn('fitness', 3);
    ctx.say(`You jump in. ${cold === 'snow' || cold === 'fog' ? 'It is cold enough to be a decision.' : 'Cold, then fine, then good.'} You haul out onto ${room.name} dripping and cleaner than you went in.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'splash'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return (r && (r.props && r.props.water || ['the_pier', 'the_lake_dock', 'the_breakwater', 'pier_seven'].includes(r.roomId))) ? [{ label: 'Swim', cmd: 'swim', group: 'here' }] : []; },
});
registry.register({
  name: 'relax', aliases: ['couch', 'kick back', 'lounge'],
  help: { topic: 'needs', usage: 'relax', blurb: 'Kick back on your couch. Fun and rest, a little of each.' },
  when: async (ctx) => { const r = await ctx.room(); return !!(r && r.props && r.props.home && hasKey(r, ctx.userId) && await furnitureHere(r.roomId, 'couch')); },
  whyNot: () => 'Nothing to kick back on here. A couch from Hock’s or the Salvage Yard, in your own place.',
  async run(ctx) {
    const { ch } = ctx;
    await setBusy(ch, 5, 'relaxing');
    ctx.need({ fun: 12, rested: 12 });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} flops onto the couch.`);
    ctx.say('You flop onto the couch and let the day drain out of your shoulders.');
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return r && r.props && r.props.home && hasKey(r, ctx.userId) && await furnitureHere(r.roomId, 'couch') ? [{ label: 'Relax on the couch', cmd: 'relax', group: 'here' }] : []; },
});
registry.register({
  name: 'porch', aliases: ['sit on the porch', 'stoop'],
  help: { topic: 'home', usage: 'porch', blurb: 'Sit out front and hear the street.' },
  when: async (ctx) => { const r = await ctx.room(); return !!(r && r.props && r.props.home); },
  async run(ctx) {
    const { ch } = ctx;
    const room = await ctx.room();
    const street = await MooRoom.findOne({ roomId: room.exits.out }).lean();
    const folks = await MooChar.find({ roomId: room.exits.out }).select('name').lean();
    await setAttrs(ch, { pose: 'sitting out front' });
    ctx.need({ fun: 5, rested: 4, company: folks.length ? 4 : 1 });
    ctx.say(`You sit out front. ${street ? street.props && street.props.listenLine ? street.props.listenLine : `${street.name} goes by.` : ''} ${folks.length ? 'Out on the street: ' + folks.map((f) => f.name).join(', ') + '.' : 'Nobody on the street just now.'}`);
    return ctx.ok();
  },
});

module.exports = { LISTINGS, listingByKey, myHome, homesOf, hasKey, mayPass, mayEnter, furnitureHere, homeIdFor };
