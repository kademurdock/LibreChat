/* REVERIE LIFE — the shops (Sep 6 2026).
 *
 * Every counter in the city, as data: what it sells, for how much, and what
 * the thing does once it is yours. `shop` reads the shelf, `buy` takes it.
 * Anything not on these shelves falls through to the old engine, which still
 * sells rods, bait, and one commemorative brick. */
const registry = require('./registry');
const oldEngine = require('../engine');
const {
  MooItem, emit, setAttrs, coinOf, payCoin, earnCoin, matchName, itemsHeld, findHeld, makeItem, cap, plural,
} = require('./ctx');

/* furniture: type is the slot; effect is what it unlocks */
const FURNITURE = [
  { type: 'bed', name: 'a bed', price: 45, effectShort: 'sleep properly', effect: 'Sleep here and wake truly rested.', desc: 'A real bed with a real mattress. The single biggest upgrade a person can make.' },
  { type: 'couch', name: 'a couch', price: 35, effectShort: 'relax', effect: '"relax" on it for fun and rest both.', desc: 'Deep enough to lose an afternoon in. One cushion is better than the others and everybody knows which.' },
  { type: 'stove', name: 'a stove', price: 50, effectShort: 'cook', effect: '"cook <recipe>" here with what you carry.', desc: 'Four burners, three of which work, which is one more than most. It clicks four times before it lights.' },
  { type: 'shower', name: 'a shower', price: 40, effectShort: 'get clean', effect: '"shower" here — hot water on demand.', desc: 'Pressure like a fire hose and hot water in under a minute. A miracle of plumbing.' },
  { type: 'table', name: 'a kitchen table', price: 25, effectShort: 'eat together', effect: 'Meals eaten here count for more, and for everybody at it.', desc: 'Scarred, solid, and seats four with elbows. Every real conversation in the city has happened at one of these.' },
  { type: 'radio', name: 'a radio', price: 20, effectShort: 'hear the Band', effect: '"radio" tunes in the Band any hour.', desc: 'Wood case, warm dial light, one station that comes in clear and one that mostly does not.' },
  { type: 'bookshelf', name: 'a bookshelf', price: 30, effectShort: 'read at home', effect: '"read" here without walking to the Archive.', desc: 'Sags in the middle from books somebody actually read.' },
  { type: 'plant', name: 'a houseplant', price: 8, effectShort: 'a little life', effect: 'The room feels lived in. Water it now and then.', desc: 'Green, forgiving, and slightly too big for its pot.' },
  { type: 'lamp', name: 'a good lamp', price: 12, effectShort: 'cozy', effect: 'Warm light. Sighted visitors will notice.', desc: 'Brass base, cloth shade, the kind of light that makes a room a room.' },
  { type: 'rug', name: 'a rug', price: 15, effectShort: 'warm floors', effect: 'Bare floors stop being bare.', desc: 'Faded red, soft underfoot, hides exactly one stain.' },
  { type: 'chair', name: 'a porch chair', price: 10, effectShort: 'sit out front', effect: '"porch" is more comfortable.', desc: 'Metal, springy, painted a green that used to be a different green.' },
  { type: 'crib', name: 'a crib', price: 30, effectShort: 'a baby sleeps', effect: 'A little one can sleep here. Needed before the Children’s Office will talk to you.', desc: 'Slats, a mobile with three ducks and a mystery fourth thing, one wobbly leg.' },
  { type: 'bunk', name: 'a bunk bed', price: 40, effectShort: 'kids sleep', effect: 'Room for kids to sleep — two of them, arguing about the top.', desc: 'The ladder is missing one rung. It has always been missing one rung.' },
  { type: 'tv', name: 'a television', price: 38, effectShort: 'fun on tap', effect: '"watch tv" — fun, cheap and fast.', desc: 'Heavy as a safe, screen slightly green, remote held together with tape.' },
  { type: 'pettree', name: 'a scratching post', price: 12, effectShort: 'cats stay', effect: 'A cat that lives here is happier and says so less.', desc: 'Carpet on a post. The cat will ignore it in favor of the couch.' },
];

const GROCERIES = [
  { key: 'eggs', name: 'a carton of eggs', price: 3, desc: 'A dozen, one cracked. Always one cracked.', props: { ingredient: 'eggs', food: { feed: 8, line: 'Raw. You regret it immediately.' } } },
  { key: 'flour', name: 'a bag of flour', price: 2, desc: 'Five pounds. Gets on everything.', props: { ingredient: 'flour' } },
  { key: 'milk', name: 'a jug of milk', price: 2, desc: 'Cold, for now.', props: { ingredient: 'milk', food: { feed: 6, line: 'Cold milk from the jug. Nobody saw.' } } },
  { key: 'butter', name: 'a stick of butter', price: 2, desc: 'Real butter. Ruth-Ann would approve.', props: { ingredient: 'butter' } },
  { key: 'tortillas', name: 'a stack of tortillas', price: 2, desc: 'Still warm if you hurry.', props: { ingredient: 'tortillas', food: { feed: 8, line: 'Plain tortilla, standing up. A classic.' } } },
  { key: 'meat', name: 'a pound of ground meat', price: 5, desc: 'Wrapped in white paper, weighed generously.', props: { ingredient: 'meat' } },
  { key: 'potatoes', name: 'a sack of potatoes', price: 3, desc: 'Dirt still on them, which is how you know.', props: { ingredient: 'potatoes' } },
  { key: 'onion', name: 'an onion', price: 1, desc: 'Big, papery, and honest about what it is.', props: { ingredient: 'onion' } },
  { key: 'cheese', name: 'a wedge of cheese', price: 3, desc: 'Sharp. Sweats a little in the bag.', props: { ingredient: 'cheese', food: { feed: 8, line: 'Cheese, straight from the wedge.' } } },
  { key: 'coffee', name: 'a can of coffee', price: 4, desc: 'Not Pat’s. Nothing is Pat’s.', props: { ingredient: 'coffee' } },
  { key: 'candy', name: 'a bag of penny candy', price: 1, desc: 'Mixed. The good ones are on the bottom.', props: { food: { feed: 3, fun: 6, line: 'Sugar and nostalgia.' }, giftable: true } },
  { key: 'lotto', name: 'a scratch ticket', price: 2, desc: 'Somebody has to win. Statistically it is not you.', props: { lotto: true } },
  { key: 'flowers', name: 'a bunch of flowers', price: 4, desc: 'Grocery-store flowers, which still count.', props: { gift: 'romance', giftable: true } },
];
const PAWN_GOODS = [
  { key: 'guitar', name: 'a secondhand guitar', price: 45, desc: 'Somebody’s initials scratched inside. Stays in tune for about a song.', props: { instrument: 'guitar', value: 20 } },
  { key: 'harmonica', name: 'a harmonica', price: 12, desc: 'Key of C. Pocket-sized and impossible to play quietly.', props: { instrument: 'harmonica', value: 5 } },
  { key: 'watch', name: 'a gold watch', price: 60, desc: 'Runs a little fast, like the bell tower runs slow.', props: { value: 35, gift: 'friend', giftable: true } },
  { key: 'ring', name: 'a ring', price: 80, desc: 'Plain gold band. Hock does not ask, and neither should you.', props: { ring: true, value: 40, giftable: true } },
  { key: 'camera', name: 'an old camera', price: 30, desc: 'Film, not that you can get film. It still clicks like it means it.', props: { value: 12, giftable: true } },
  { key: 'bowling ball', name: 'your own bowling ball', price: 35, desc: 'Drilled for a stranger’s hand, close enough. Marbled blue.', props: { bowling: true, value: 15 } },
  { key: 'dart set', name: 'a set of darts', price: 15, desc: 'Three, matching, flights a little bent.', props: { darts: true, value: 6 } },
  { key: 'deck', name: 'a deck of cards', price: 3, desc: 'Fifty-one cards and a joker standing in for the six of clubs.', props: { cards: true, value: 1 } },
];
const SALON = [
  { key: 'haircut', name: 'a haircut', price: 12, service: 'hair' },
  { key: 'makeover', name: 'the full makeover', price: 30, service: 'makeover' },
  { key: 'nails', name: 'nails done', price: 10, service: 'nails' },
];

const SHOPS = {
  corner_store: { keeper: 'the corner store', goods: GROCERIES, line: 'The Corner Store sells groceries by the nickel and gossip for free.' },
  pawn_hocks: { keeper: 'Hock', goods: [...PAWN_GOODS, ...FURNITURE.map((f) => ({ key: f.type, name: f.name, price: f.price, desc: f.desc, props: { furniture: f.type, effect: f.effect, value: Math.round(f.price / 2) } }))], line: 'Hock’s Pawn takes anything with a story and sells it back with a better one.' },
  salvage_yard: { keeper: 'the yard', goods: FURNITURE.map((f) => ({ key: f.type, name: `${f.name} (dented)`, price: Math.max(3, Math.round(f.price * 0.55)), desc: f.desc + ' It has been rained on at least once.', props: { furniture: f.type, effect: f.effect, value: Math.round(f.price / 4), dented: true } })), line: 'The Salvage Yard sells furniture by the pound. Everything works. Nothing matches.' },
  the_salon: { keeper: 'the Salon', goods: SALON.map((s) => ({ ...s, desc: '' })), line: 'The Salon fixes hair, nails, and reputations, in that order of reliability.' },
  fish_market: { keeper: 'the fish market', goods: [{ key: 'fish', name: 'a whole fish, wrapped', price: 6, desc: 'Fresh off somebody’s boat this morning.', props: { ingredient: 'fish', food: { feed: 10, line: 'Raw fish, standing in the market. Bold.' } } }], line: 'The Fish Market wakes before anyone and sells what the boats brought.' },
  tandy_stand: { keeper: 'the Tandy stand', goods: [{ key: 'apples', name: 'a bag of apples', price: 3, desc: 'Orchard apples, a little lopsided, perfect.', props: { ingredient: 'apples', food: { feed: 8, fun: 3, line: 'Crisp. Junie picked these.' }, giftable: true } }, { key: 'cider', name: 'a jug of cider', price: 5, desc: 'Cold and cloudy. Emmett’s press.', props: { food: { feed: 6, fun: 8, line: 'Sweet, cold, a little sharp at the end.' }, giftable: true } }], line: 'The Tandy stand sells what the orchard grew this week.' },
  the_garages: { keeper: 'Royce', goods: [], line: 'The Garages sell bikes and cars that mostly start. "vehicles" for the lot.' },
  the_shack: { keeper: 'Marva', goods: [], line: 'Marva keeps rods and bait: buy rod, buy bait. Ask about the charter.' },
};

async function shopHere(ctx) { const r = await ctx.room(); return r ? SHOPS[r.roomId] || null : null; }

registry.register({
  name: 'shop', aliases: ['browse', 'shelf', 'catalog', 'menu', 'prices', 'what do you sell'], free: true,
  help: { topic: 'money', usage: 'shop', blurb: 'See what a counter sells.' },
  async run(ctx) {
    const s = await shopHere(ctx);
    const room = await ctx.room();
    if (!s) {
      if (room && room.props && room.props.food) return ctx.fail(`This is a food counter: ${room.props.food.menu} for ${room.props.food.price || 0} coin. Say "eat".`);
      return ctx.fail('No counter here. Shops: the Corner Store (Patch), Hock’s Pawn (Tanglefoot), the Salvage Yard (Millrace), the Salon (Fairlawn), the Fish Market (Hook), the Tandy stand (Long Acre), the Garages (Millrace), the Shack (Hook).');
    }
    ctx.say(s.line);
    if (room.roomId === 'the_garages') return require('./vehicles').lot(ctx);
    if (room.roomId === 'the_shack') return ctx.ok();
    ctx.say(s.goods.map((g) => `${g.name} — ${g.price}`).join('; ') + `. You carry ${coinOf(ctx.ch)}. Say "buy <thing>".`);
    return ctx.ok({ choices: s.goods.slice(0, 24).map((g) => ({ label: `Buy ${g.name} (${g.price})`, cmd: `buy ${g.key}` })) });
  },
  buttons: async (ctx) => (await shopHere(ctx)) ? [{ label: 'Browse the shelf', cmd: 'shop', group: 'here' }] : [],
});

registry.register({
  name: 'buy', aliases: ['purchase'],
  help: { topic: 'money', usage: 'buy <thing>', blurb: 'Buy something off the shelf you are standing at.' },
  async run(ctx, { arg, argRaw }) {
    const { ch } = ctx;
    if (!arg) return registry.get('shop').run(ctx, { arg: '' });
    const s = await shopHere(ctx);
    const room = await ctx.room();
    if (room && room.roomId === 'the_garages') return require('./vehicles').buy(ctx, arg);
    const g = s ? (s.goods.find((x) => x.key === arg) || matchName(s.goods, arg, (x) => x.name.replace(/^(a|an|the|your own)\s+/, ''), (x) => x.key)) : null;
    if (!g) {
      /* rods, bait, bricks — the old engine's counters */
      const old = await oldEngine.runCommand({ userId: ch.userId, displayName: ch.name, command: `buy ${argRaw}`, isWizard: ctx.isWizard });
      if (old && !old.unknown && !/Nothing called|does not know/.test((old.lines || []).join(' '))) return { ...old, lines: [...ctx.lines, ...(old.lines || []).filter((l) => !/^MEANWHILE/.test(l))] };
      return ctx.fail(s ? `${cap(s.keeper)} does not sell "${argRaw}". "shop" shows the shelf.` : 'No counter here to buy from. "shop" anywhere with one.');
    }
    if (coinOf(ch) < g.price) return ctx.fail(`${cap(g.name)} is ${g.price} coin and you carry ${coinOf(ch)}.`, { kinds: [...ctx.kinds, 'err'] });
    await payCoin(ch, g.price);
    if (g.service) return salon(ctx, g);
    await makeItem({ name: g.name, desc: g.desc, location: { type: 'char', id: ch.userId }, props: { ...(g.props || {}), boughtAt: room.roomId, price: g.price } });
    await emit(ch.roomId, ch.userId, ch.name, 'take', `${ch.name} buys ${g.name}.`);
    if (g.props && g.props.furniture) ctx.say(`You buy ${g.name} for ${g.price}. It is yours to carry home and "place". ${g.props.effect}`);
    else ctx.say(`You buy ${g.name} for ${g.price} coin.`);
    if (g.props && g.props.lotto) ctx.say('Scratch it: "scratch ticket".');
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

async function salon(ctx, g) {
  const { ch, life } = ctx;
  await require('./ctx').setBusy(ch, 8, 'in the chair');
  ctx.need({ clean: 40, fun: 12, company: 6 });
  ctx.learn('charm', 2);
  if (g.service === 'hair') { await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} gets a haircut and comes out a half-inch taller.`); ctx.say('Scissors, hot towel, and a stylist who tells you exactly whose marriage is in trouble. You come out sharp.'); }
  else if (g.service === 'makeover') {
    await setAttrs(ch, { 'life.look.polished': Date.now() });
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} comes out of the back looking like a different tax bracket.`);
    ctx.say('An hour in the chair and a running commentary on your life choices. You come out polished — the Salon’s word — and people will say so for a day.');
    await require('./drama').rumor(ctx, `${ch.name} came out of the Salon looking brand new`, 'talk', 1);
  } else { ctx.say('Nails done. You keep looking at your hands.'); }
  return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
}

/* ── PAWN ─────────────────────────────────────────────────────────────── */
registry.register({
  name: 'pawn', aliases: ['hock', 'sell to hock'],
  help: { topic: 'money', usage: 'pawn <thing>', blurb: 'Hock buys anything with a value. Half what it is worth, no questions.' },
  when: async (ctx) => (await ctx.room()).roomId === 'pawn_hocks',
  whyNot: () => 'Hock’s Pawn is on Line Street in Tanglefoot. He buys; nobody else does.',
  async run(ctx, { arg, argRaw }) {
    const { ch } = ctx;
    if (!arg) { const held = await itemsHeld(ch.userId); const v = held.filter((i) => i.props && (i.props.value || i.props.price)); return ctx.fail(v.length ? `Hock would take: ${v.map((i) => `${i.name} (${Math.max(1, Math.round((i.props.value || i.props.price / 2) || 1))})`).join(', ')}.` : 'Hock looks at your pockets and shakes his head. Nothing there he wants.'); }
    const it = await findHeld(ch.userId, arg);
    if (!it) return ctx.fail(`You carry nothing called "${argRaw}".`);
    if (it.props && it.props.keepsake) return ctx.fail(`Hock turns ${it.name} over once and hands it back. "Not this one. You’d hate me by Friday."`);
    const val = Math.max(1, Math.round((it.props && (it.props.value || (it.props.price ? it.props.price / 2 : 0))) || 1));
    await MooItem.deleteOne({ _id: it._id });
    await earnCoin(ch, val);
    ctx.learn('hustle', 2);
    await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} pawns ${it.name}.`);
    if (it.props && it.props.ring) await require('./drama').rumor(ctx, `${ch.name} pawned a ring at Hock’s`, 'love', 3);
    ctx.say(`Hock gives ${it.name} the eyebrow and counts out ${val} coin. "Story’s worth more than the thing. Always is."`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
  buttons: async (ctx) => (await ctx.room()).roomId === 'pawn_hocks' ? [{ label: 'Pawn something', cmd: 'pawn', group: 'here' }] : [],
});

registry.register({
  name: 'scratch ticket', aliases: ['scratch', 'scratch off'],
  help: { topic: 'fun', usage: 'scratch ticket', blurb: 'Scratch a lottery ticket from the Corner Store.' },
  async run(ctx) {
    const { ch } = ctx;
    const t = await MooItem.findOne({ 'location.type': 'char', 'location.id': ch.userId, 'props.lotto': true }).lean();
    if (!t) return ctx.fail('No ticket to scratch. The Corner Store sells them, two coin.');
    await MooItem.deleteOne({ _id: t._id });
    const r = Math.random();
    const win = r < 0.02 ? 100 : r < 0.08 ? 20 : r < 0.25 ? 5 : r < 0.4 ? 2 : 0;
    if (win) { await earnCoin(ch, win); ctx.need({ fun: win >= 20 ? 25 : 8 }); ctx.say(win >= 100 ? `THREE BELLS. ${win} coin. The Corner Store will be talking about this for a month.` : `A winner — ${win} coin.`); if (win >= 100) await require('./drama').rumor(ctx, `${ch.name} hit a hundred on a scratch ticket`, 'money', 4); }
    else { ctx.need({ fun: -2 }); ctx.say('Two bells and a boot. Nothing. The odds were printed right there on the back.'); }
    return ctx.ok({ kinds: [...ctx.kinds, win ? 'coin' : 'err'] });
  },
});

module.exports = { FURNITURE, GROCERIES, PAWN_GOODS, SHOPS, shopHere };
