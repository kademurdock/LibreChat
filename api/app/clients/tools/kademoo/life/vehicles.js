/* REVERIE LIFE — getting around (Sep 6 2026).
 *
 * The tram and the ferry were already here. This adds what a person owns:
 * a bike from the Garages, a scooter, a sedan that starts on the third try,
 * a pickup. A vehicle is an item that rides with you; "go to" uses it
 * automatically, "walk" puts you back on your feet, "park" leaves it where
 * it sits. Cars drink gas. Medallion 88 — the autocab everybody asks for by
 * name — comes when called and costs by the block. */
const registry = require('./registry');
const {
  MooRoom, MooItem, emit, setAttrs, setBusy, moveTo, coinOf, payCoin, matchName, itemsHeld, findHeld, makeItem, cap, plural,
} = require('./ctx');

const LOT = [
  { key: 'bike', name: 'a bicycle', price: 35, type: 'bike', secPerStep: 0.9, verb: 'ride', verbLine: 'pedals off', arriveLine: 'rolls up on a bicycle and hops off', doing: 'riding', sound: 'transit.bike', desc: 'Three speeds, two of which work. A bell that startles pigeons. Faster than feet, free to run, and you arrive awake.' },
  { key: 'scooter', name: 'a scooter', price: 80, type: 'scooter', secPerStep: 0.6, verb: 'scoot', verbLine: 'buzzes off on a scooter', arriveLine: 'buzzes up on a scooter', doing: 'scooting', sound: 'transit.scooter', fuel: 12, desc: 'Fifty cc of pure optimism. Sounds like an angry bee, turns like a thought.' },
  { key: 'sedan', name: 'a rusted sedan', price: 260, type: 'car', secPerStep: 0.4, verb: 'drive', verbLine: 'drives off', arriveLine: 'pulls up in a sedan that coughs once and dies', doing: 'driving', sound: 'transit.car', fuel: 20, desc: 'Starts on the third try, every time. The radio only gets the Band. The back seat has held a lot of groceries and at least one nap.' },
  { key: 'pickup', name: 'a pickup truck', price: 400, type: 'car', secPerStep: 0.4, verb: 'drive', verbLine: 'drives off in the pickup', arriveLine: 'pulls up in the pickup', doing: 'driving', sound: 'transit.car', fuel: 24, desc: 'Bench seat, a bed full of somebody else’s gravel, and the kind of engine that sounds like it means it. Royce says it will outlive you.' },
];
const FUEL_PRICE = 4;

async function owned(userId) { return MooItem.find({ 'location.type': 'char', 'location.id': userId, 'props.vehicle': { $exists: true } }).lean(); }

/** What you are riding right now, if anything — the fastest thing you carry, unless you chose to walk. */
async function riding(ctx) {
  if (ctx.life.transport === 'walk') return null;
  const vs = await owned(ctx.userId);
  if (!vs.length) return null;
  let best = null;
  for (const v of vs) {
    const def = LOT.find((l) => l.type === v.props.vehicle.type && l.key === v.props.vehicle.key) || LOT.find((l) => l.type === v.props.vehicle.type);
    if (!def) continue;
    if (def.fuel && (v.props.fuel || 0) <= 0) continue;
    if (!best || def.secPerStep < best.def.secPerStep) best = { def, item: v };
  }
  if (!best) return null;
  if (best.def.fuel) MooItem.updateOne({ _id: best.item._id }, { $inc: { 'props.fuel': -1 } }).catch(() => {});
  return { ...best.def, item: best.item, sound: best.def.sound };
}

async function lot(ctx) {
  ctx.say('Royce wipes his hands and points down the row: ' + LOT.map((l) => `${l.name} — ${l.price}`).join('; ') + `. You carry ${coinOf(ctx.ch)}. "buy <bike|scooter|sedan|pickup>". Gas is ${FUEL_PRICE} a fill, here or at the Truck Stop.`);
  return ctx.ok({ choices: LOT.map((l) => ({ label: `Buy ${l.name} (${l.price})`, cmd: `buy ${l.key}` })) });
}
async function buy(ctx, arg) {
  const l = LOT.find((x) => x.key === arg) || matchName(LOT, arg, (x) => x.name.replace(/^(a|an)\s+/, ''), (x) => x.type);
  if (!l) return ctx.fail(`Royce does not have "${arg}". "shop" for the lot.`);
  if (coinOf(ctx.ch) < l.price) return ctx.fail(`${cap(l.name)} is ${l.price}. You carry ${coinOf(ctx.ch)}. Royce does not do payments. Boone might have rail work.`);
  const have = await owned(ctx.userId);
  if (have.some((v) => v.props.vehicle.key === l.key)) return ctx.fail(`You already own ${l.name}.`);
  await payCoin(ctx.ch, l.price);
  await makeItem({ name: l.name, desc: l.desc, location: { type: 'char', id: ctx.userId }, props: { vehicle: { type: l.type, key: l.key }, fuel: l.fuel || null, ownerName: ctx.ch.name, value: Math.round(l.price / 2), price: l.price } });
  await setAttrs(ctx.ch, { 'life.transport': 'ride' }); ctx.life.transport = 'ride';
  await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} buys ${l.name} off Royce’s lot.`);
  ctx.need({ fun: 15 });
  await require('./drama').rumor(ctx, `${ctx.ch.name} bought ${l.name} off Royce`, 'money', l.price >= 200 ? 3 : 1);
  ctx.say(`Royce takes the cash, hands you ${l.type === 'bike' ? 'the bike' : 'the keys'}, and says "${l.type === 'bike' ? 'Oil the chain.' : 'Third try. Every time. Don’t fight it.'}" ${cap(l.name)} is yours. "go to <place>" uses it now; "walk" if you would rather. ${l.fuel ? `Tank: ${l.fuel} trips. Gas is ${FUEL_PRICE} here or at the Truck Stop.` : ''}`);
  return ctx.ok({ kinds: [...ctx.kinds, 'coin', l.sound] });
}

registry.register({
  name: 'vehicles', aliases: ['my rides', 'garage', 'lot'], free: true,
  help: { topic: 'moving', usage: 'vehicles', blurb: 'What you own to ride, and what is on Royce’s lot.' },
  async run(ctx) {
    const vs = await owned(ctx.userId);
    if (vs.length) ctx.say(`Yours: ${vs.map((v) => `${v.name}${v.props.fuel != null ? ` (gas for ${v.props.fuel} trips)` : ''}`).join(', ')}. You are ${ctx.life.transport === 'walk' ? 'walking' : 'riding'} by default — "walk" or "ride" flips it.`);
    else ctx.say('You own nothing with wheels. Royce’s lot is at the Garages in Millrace.');
    if ((await ctx.room()).roomId === 'the_garages') return lot(ctx);
    return ctx.ok();
  },
});
registry.register({
  name: 'walk mode', aliases: ['on foot', 'walk instead'], hidden: true,
  help: { topic: 'moving', usage: 'walk', blurb: 'Leave the ride; go on foot.' },
  async run(ctx) { await setAttrs(ctx.ch, { 'life.transport': 'walk' }); ctx.life.transport = 'walk'; ctx.say('On foot from here. "ride" to get back on.'); return ctx.ok(); },
});
registry.register({
  name: 'ride', aliases: ['drive', 'bike', 'scoot', 'take the car', 'ride to', 'drive to', 'bike to'],
  help: { topic: 'moving', usage: 'drive to <place> · ride · walk', blurb: 'Use what you own. "drive to pats", or just "ride" to make it the default.' },
  async run(ctx, { arg }) {
    const vs = await owned(ctx.userId);
    if (!vs.length) return ctx.fail('Nothing to ride. Royce’s lot at the Garages sells bikes and cars; the tram and the ferry take cash.');
    if (ctx.life.transport === 'walk') { await setAttrs(ctx.ch, { 'life.transport': 'ride' }); ctx.life.transport = 'ride'; }
    const dest = arg.replace(/^to\s+(the\s+)?/, '').trim();
    if (!dest) { ctx.say(`Riding by default now. "go to <place>" and you are off. ${vs.map((v) => v.name).join(', ')}.`); return ctx.ok(); }
    const r = await riding(ctx);
    if (!r) return ctx.fail('Everything you own is out of gas. "gas up" at the Garages or the Truck Stop.');
    return require('./verbs_basics').autowalk(ctx, dest);
  },
  buttons: async (ctx) => { const vs = await owned(ctx.userId); return vs.length && ctx.life.transport === 'walk' ? [{ label: 'Ride instead of walk', cmd: 'ride', group: 'move' }] : vs.length ? [{ label: 'Walk instead', cmd: 'on foot', group: 'move' }] : []; },
});
registry.register({
  name: 'park', help: { topic: 'moving', usage: 'park <vehicle>', blurb: 'Leave a vehicle here. "unpark" takes it back.' },
  async run(ctx, { arg }) {
    const vs = await owned(ctx.userId);
    const v = arg ? matchName(vs, arg, (x) => x.name.replace(/^(a|an)\s+/, ''), (x) => x.props.vehicle.key) : vs[0];
    if (!v) return ctx.fail('Park what? You have nothing with you.');
    await MooItem.updateOne({ _id: v._id }, { $set: { location: { type: 'room', id: ctx.ch.roomId } } });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} parks ${v.name}.`);
    ctx.say(`You park ${v.name} here. "unpark" when you are back for it.`);
    return ctx.ok();
  },
});
registry.register({
  name: 'unpark', aliases: ['get in', 'take back vehicle'],
  help: { topic: 'moving', usage: 'unpark', blurb: 'Take your parked vehicle back.' },
  async run(ctx, { arg }) {
    const here = await MooItem.find({ 'location.type': 'room', 'location.id': ctx.ch.roomId, 'props.vehicle': { $exists: true }, 'props.ownerName': ctx.ch.name }).lean();
    const v = arg ? matchName(here, arg, (x) => x.name.replace(/^(a|an)\s+/, '')) : here[0];
    if (!v) return ctx.fail('Nothing of yours is parked here.');
    await MooItem.updateOne({ _id: v._id }, { $set: { location: { type: 'char', id: ctx.userId } } });
    ctx.say(`You take ${v.name} back.`);
    return ctx.ok();
  },
  buttons: async (ctx) => { const here = await MooItem.find({ 'location.type': 'room', 'location.id': ctx.ch.roomId, 'props.vehicle': { $exists: true }, 'props.ownerName': ctx.ch.name }).select('name').lean(); return here.map((h) => ({ label: `Take ${h.name}`, cmd: `unpark ${h.name.replace(/^(a|an)\s+/, '')}`, group: 'here' })); },
});
registry.register({
  name: 'gas up', aliases: ['fill up', 'gas', 'refuel', 'fuel'],
  help: { topic: 'moving', usage: 'gas up', blurb: 'Fill the tank — at the Garages or the Truck Stop, four dollars.' },
  when: async (ctx) => ['the_garages', 'the_truck_stop'].includes((await ctx.room()).roomId),
  whyNot: () => 'Gas is at the Garages in Millrace or the Truck Stop out on Long Acre.',
  async run(ctx) {
    const vs = (await owned(ctx.userId)).filter((v) => v.props.fuel != null);
    if (!vs.length) return ctx.fail('Nothing you own takes gas.');
    if (coinOf(ctx.ch) < FUEL_PRICE) return ctx.fail(`Gas is $${FUEL_PRICE}.`);
    await payCoin(ctx.ch, FUEL_PRICE);
    for (const v of vs) { const def = LOT.find((l) => l.key === v.props.vehicle.key); await MooItem.updateOne({ _id: v._id }, { $set: { 'props.fuel': def ? def.fuel : 20 } }); }
    ctx.say(`You fill up. $${FUEL_PRICE}. The pump clicks off like it is proud of itself.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
  buttons: async (ctx) => (['the_garages', 'the_truck_stop'].includes((await ctx.room()).roomId) && (await owned(ctx.userId)).some((v) => v.props.fuel != null)) ? [{ label: 'Gas up (4)', cmd: 'gas up', group: 'here' }] : [],
});

/* ── MEDALLION 88 ─────────────────────────────────────────────────────── */
registry.register({
  name: 'cab', aliases: ['call cab', 'call a cab', 'taxi', 'call 88', 'medallion 88', 'hail cab'],
  help: { topic: 'moving', usage: 'cab <place>', blurb: 'Medallion 88 comes when called. Three dollars plus one a street. Knows every road, including the ones that are not.' },
  async run(ctx, { arg }) {
    const dest = arg.replace(/^to\s+(the\s+)?/, '').trim();
    if (!dest) return ctx.fail('Cab to where? Medallion 88 knows every place on the map — "places" lists them.');
    const allRooms = await MooRoom.find({ 'props.home': { $exists: false } }).select('roomId name district').lean();
    const wLower = dest.toLowerCase().replace(/^the\s+/, '');
    const target = allRooms.find((r) => r.name.toLowerCase().replace(/^the\s+/, '') === wLower) || allRooms.find((r) => r.name.toLowerCase().includes(wLower)) || allRooms.find((r) => r.roomId.includes(wLower.replace(/\s+/g, '_')));
    if (!target) return ctx.fail(`88 has never heard of "${dest}", and 88 has heard of everything.`);
    if (target.district === 'gravewalk') return ctx.fail('88 goes quiet on the radio. "Not there. Not for anybody. Sorry, hon."');
    if (target.roomId === ctx.ch.roomId) return ctx.fail('You are already here. 88 would charge you anyway.');
    const room = await ctx.room();
    const fare = 3 + (room.district === target.district ? 1 : 3);
    if (coinOf(ctx.ch) < fare) return ctx.fail(`The fare is ${fare} and you carry ${coinOf(ctx.ch)}. 88 does not run tabs. Feet are free.`);
    await payCoin(ctx.ch, fare);
    await moveTo(ctx.ch, target.roomId, `Medallion 88 pulls up out of nowhere and ${ctx.ch.name} gets in.`, `Medallion 88 pulls up and ${ctx.ch.name} climbs out. The cab is gone before the door shuts.`);
    await setBusy(ctx.ch, 5, 'in the cab');
    ctx.need({ fun: 2, rested: 2 });
    ctx.say(`Medallion 88 is there before you finish saying it. The driver does not talk and the radio plays the Band. ${target.name}, $${fare}, and the cab is gone like it was never there.`);
    return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'transit.cab'] });
  },
  buttons: (ctx) => coinOf(ctx.ch) >= 4 ? [{ label: 'Call a cab', cmd: 'cab', group: 'move', hint: 'cab <place>' }] : [],
});

module.exports = { LOT, owned, riding, lot, buy };
