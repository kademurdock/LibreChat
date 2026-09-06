/* REVERIE LIFE — things to do (Sep 6 2026).
 *
 * The down-time layer: what you do when you are not doing anything. Cooking
 * with real ingredients on a real stove, ten frames at the Millrace Lanes,
 * darts at Dez’s, a hand of cards in the Parlor, a song, a set at the
 * bandshell for tips, a book at the Archive, a run up the Stairs, the Band on
 * the radio. Every one of them feeds a meter and a skill and makes a sound,
 * and the ones with scores keep a board the whole city can read. */
const registry = require('./registry');
const skills = require('./skills');
const { MooBoard, MooRumor } = require('~/models/kadeMooLife');
const {
  MooChar, MooItem, MooRoom, emit, setAttrs, setBusy, coinOf, payCoin, earnCoin, matchName, itemsHeld, findHeld, makeItem, worldClock, clockLine, cap, pick, chance, plural, joinAnd,
} = require('./ctx');

const lvl = (ctx, s) => skills.levelOf((ctx.life.skills || {})[s] || 0);
const act = (def) => registry.register({ ...def, help: { topic: 'fun', ...def.help } });
async function board(name, ctx, score, note) {
  await MooBoard.create({ board: name, userId: ctx.userId, name: ctx.ch.name, score, note: note || '' });
  const top = await MooBoard.find({ board: name }).sort({ score: -1 }).limit(1).lean();
  return top.length && top[0].userId === ctx.userId && top[0].score === score;
}

/* ── COOKING ─────────────────────────────────────────────────────────── */
const RECIPES = [
  { key: 'eggs', name: 'scrambled eggs', level: 0, needs: ['eggs'], feed: 30, fun: 4, line: 'Soft, a little pepper, gone in a minute.' },
  { key: 'pancakes', name: 'a stack of pancakes', level: 1, needs: ['flour', 'eggs', 'milk'], feed: 40, fun: 10, line: 'Uneven, golden, drowning in whatever you had.' },
  { key: 'grilled cheese', name: 'a grilled cheese', level: 0, needs: ['cheese', 'butter'], feed: 30, fun: 8, line: 'Crisp outside, molten inside, the sandwich that never let anybody down.' },
  { key: 'tacos', name: 'a plate of tacos', level: 2, needs: ['tortillas', 'meat', 'onion'], feed: 45, fun: 12, line: 'Three, dripping, better than the window’s and you will say so.' },
  { key: 'fish fry', name: 'a fish fry', level: 2, needs: ['fish', 'flour'], feed: 50, fun: 12, line: 'Crackling crust, lemon if you had it, the Hook on a plate.' },
  { key: 'stew', name: 'a pot of stew', level: 3, needs: ['meat', 'potatoes', 'onion'], feed: 55, fun: 10, line: 'It fed the block. It will feed the block again tomorrow.', portions: 3 },
  { key: 'apple pie', name: 'an apple pie', level: 4, needs: ['apples', 'flour', 'butter'], feed: 35, fun: 20, line: 'Pat would have notes. Pat would also have a second slice.', portions: 4, gift: true },
  { key: 'tomato sandwich', name: 'a tomato sandwich', level: 0, needs: ['tomato'], feed: 25, fun: 8, line: 'Ruth-Ann’s rule: salt, and eat it over the sink.' },
  { key: 'greens', name: 'a pot of greens', level: 1, needs: ['greens'], feed: 30, fun: 6, line: 'Slow, smoky, and the reason the Patch smells like it does.' },
  { key: 'cider donuts', name: 'cider donuts', level: 3, needs: ['flour', 'eggs', 'apples'], feed: 30, fun: 18, line: 'Warm, sugared, gone. Junie would trade a whole day of picking for these.', portions: 4, gift: true },
];
async function stoveHere(ctx) {
  const room = await ctx.room();
  if (!room) return null;
  if (room.props && room.props.home) return require('./housing').furnitureHere(room.roomId, 'stove') ? 'your stove' : null;
  if (room.roomId === 'pats_diner') return 'Pat’s back burner';
  if (room.roomId === 'the_cider_press' || room.roomId === 'tandy_stand') return 'the Tandys’ camp stove';
  return null;
}
async function ingredientsHeld(userId) {
  const items = await MooItem.find({ 'location.type': 'char', 'location.id': userId }).lean();
  const have = {};
  for (const i of items) {
    const key = (i.props && i.props.ingredient) || guessIngredient(i.name);
    if (key) (have[key] = have[key] || []).push(i);
  }
  return have;
}
function guessIngredient(name) {
  const n = name.toLowerCase();
  if (/tomato/.test(n)) return 'tomato';
  if (/greens|collard|kale/.test(n)) return 'greens';
  if (/apple/.test(n)) return 'apples';
  if (/(bass|perch|catfish|trout|crappie|carp|bluegill|fish|walleye|pike)\b/.test(n)) return 'fish';
  if (/potato/.test(n)) return 'potatoes';
  if (/onion/.test(n)) return 'onion';
  if (/egg/.test(n)) return 'eggs';
  if (/flour/.test(n)) return 'flour';
  if (/milk/.test(n)) return 'milk';
  if (/butter/.test(n)) return 'butter';
  if (/cheese/.test(n)) return 'cheese';
  if (/tortilla/.test(n)) return 'tortillas';
  if (/meat|beef|pork/.test(n)) return 'meat';
  return null;
}
act({
  name: 'recipes', aliases: ['cookbook', 'what can i cook'], free: true,
  help: { usage: 'recipes', blurb: 'What you know how to cook, and what each needs.' },
  async run(ctx) {
    const L = lvl(ctx, 'cooking');
    const have = await ingredientsHeld(ctx.userId);
    const rows = RECIPES.map((r) => { const can = r.level <= L; const missing = r.needs.filter((n) => !have[n]); return `${r.name}${can ? '' : ` (Cooking ${r.level})`}: ${r.needs.join(', ')}${can && !missing.length ? ' — you have it all' : missing.length && can ? ` — missing ${missing.join(', ')}` : ''}`; });
    ctx.say(`Cooking ${L}. ` + rows.join('; ') + '. Groceries: the Corner Store, the Fish Market, the Tandy stand, your own plot, the water.');
    return ctx.ok();
  },
});
act({
  name: 'cook', aliases: ['make', 'fry', 'bake'],
  help: { usage: 'cook <recipe>', blurb: 'Cook on a stove with what you carry. "recipes" first.' },
  async run(ctx, { arg }) {
    const stove = await stoveHere(ctx);
    if (!stove) return ctx.fail('No stove here. Your own place with a stove from Hock’s, or Pat lets regulars use the back burner.');
    if (!arg) return registry.get('recipes').run(ctx, { arg: '' });
    const r = RECIPES.find((x) => x.key === arg) || matchName(RECIPES, arg, (x) => x.name.replace(/^(a|an)\s+(plate|pot|stack)\s+of\s+|^(a|an)\s+/, ''), (x) => x.key);
    if (!r) return ctx.fail(`No recipe called "${arg}". "recipes" lists them.`);
    const L = lvl(ctx, 'cooking');
    if (r.level > L) return ctx.fail(`${cap(r.name)} wants Cooking ${r.level}; you are at ${L}. Eggs and grilled cheese teach.`);
    const have = await ingredientsHeld(ctx.userId);
    const missing = r.needs.filter((n) => !have[n]);
    if (missing.length) return ctx.fail(`You are short ${missing.join(' and ')}. The Corner Store on Gully Road, mostly.`);
    for (const n of r.needs) await MooItem.deleteOne({ _id: have[n][0]._id });
    const good = chance(0.7 + L * 0.03);
    const portions = r.portions || 1;
    for (let i = 0; i < portions; i++) await makeItem({ name: r.name + (portions > 1 ? ' (a portion)' : ''), desc: `${cap(r.name)}, made by ${ctx.ch.name} on ${stove}. ${good ? r.line : 'A little burnt. Still food.'}`, location: { type: 'char', id: ctx.userId }, props: { food: { feed: good ? r.feed : Math.round(r.feed * 0.6), fun: good ? r.fun : 1, line: good ? r.line : 'You eat around the black parts.' }, cooked: true, giftable: !!r.gift || good, value: 3 } });
    await setBusy(ctx.ch, 8, 'cooking');
    ctx.need({ fun: 8, clean: -4 }); ctx.learn('cooking', good ? 6 : 3);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} cooks. ${good ? 'The room starts smelling like a reason to stay.' : 'Something is a little burnt.'}`);
    ctx.say(`You cook ${r.name} on ${stove}. ${good ? r.line : 'You let it go a minute long. Edible, and honest about it.'} ${portions > 1 ? `${portions} portions, ` : ''}In your pockets — "eat ${r.key}", or "gift ${r.key} to <somebody>".`);
    return ctx.ok({ kinds: [...ctx.kinds, 'cook'] });
  },
  buttons: async (ctx) => (await stoveHere(ctx)) ? [{ label: 'Cook', cmd: 'recipes', group: 'here' }] : [],
});

/* ── BOWLING ─────────────────────────────────────────────────────────── */
function scoreRolls(frames) {
  /* frames: [[a,b?],...] up to 10, 10th may have 3 */
  let total = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const nextBalls = [...(frames[i + 1] || []), ...(frames[i + 2] || [])];
    if (i === 9) { total += f.reduce((s, x) => s + x, 0); continue; }
    if (f[0] === 10) total += 10 + (nextBalls[0] || 0) + (nextBalls[1] || 0);
    else if (f[0] + (f[1] || 0) === 10) total += 10 + (nextBalls[0] || 0);
    else total += f[0] + (f[1] || 0);
  }
  return total;
}
function bowlBall(ctx, pinsUp, aim) {
  const games = (ctx.life.games && ctx.life.games.bowling) || 0;
  const skill = Math.min(10, games / 3 + lvl(ctx, 'fitness') * 0.5 + (aim === 'hook' ? 1 : 0));
  const r = Math.random();
  const strikeP = 0.08 + skill * 0.025;
  if (pinsUp === 10 && r < strikeP) return 10;
  if (r > 0.93 - skill * 0.01) return 0; /* gutter */
  const mean = pinsUp * (0.45 + skill * 0.04);
  return Math.max(0, Math.min(pinsUp, Math.round(mean + (Math.random() - 0.5) * pinsUp * 0.6)));
}
act({
  name: 'bowl', aliases: ['bowling', 'start bowling', 'rent lane'],
  help: { usage: 'bowl · then roll (or roll hook), ten frames', blurb: 'Ten frames at the Millrace Lanes. Three dollars a game. The board remembers.' },
  when: async (ctx) => (await ctx.room()).roomId === 'bowling_lanes',
  whyNot: () => 'The lanes are in Millrace — the Millrace Lanes, league night Thursdays.',
  async run(ctx) {
    if (ctx.life.bowl) return ctx.fail(`You have a game going — frame ${ctx.life.bowl.frames.length + 1}. "roll".`);
    if (coinOf(ctx.ch) < 3) return ctx.fail('Three dollars a game, shoes included, shoes disgusting.');
    await payCoin(ctx.ch, 3);
    const own = await MooItem.findOne({ 'location.type': 'char', 'location.id': ctx.userId, 'props.bowling': true }).lean();
    ctx.life.bowl = { frames: [], own: !!own };
    await setAttrs(ctx.ch, { 'life.bowl': ctx.life.bowl });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} takes lane ${1 + Math.floor(Math.random() * 8)}.`);
    ctx.say(`Shoes on, lane lit, ${own ? 'your own ball' : 'a house ball that fits like a rumor'}. Ten frames. "roll" for straight, "roll hook" for a curve. The pins are up.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'bowl.pins.reset'] });
  },
  buttons: async (ctx) => (await ctx.room()).roomId === 'bowling_lanes' && !ctx.life.bowl ? [{ label: 'Bowl a game (3)', cmd: 'bowl', group: 'here' }] : [],
});
act({
  name: 'roll', aliases: ['bowl ball', 'roll hook', 'roll straight', 'throw ball'],
  help: { usage: 'roll · roll hook', blurb: 'Roll a frame.' },
  when: (ctx) => !!ctx.life.bowl,
  whyNot: () => 'No game going. "bowl" at the Millrace Lanes.',
  async run(ctx, { arg }) {
    const g = ctx.life.bowl;
    const aim = /hook/.test(ctx.lower) ? 'hook' : 'straight';
    const frameNo = g.frames.length + 1;
    const frame = [];
    let text;
    const a = bowlBall(ctx, 10, aim);
    frame.push(a);
    const sounds = ['bowl.roll'];
    if (a === 10) { text = `STRIKE. All ten go down like they were waiting for permission.`; sounds.push('bowl.strike'); }
    else {
      const b = bowlBall(ctx, 10 - a, aim);
      frame.push(b);
      if (a + b === 10) { text = `${a} on the first ball, then the rest — SPARE.`; sounds.push('bowl.spare'); }
      else if (a === 0 && b === 0) { text = 'Gutter. Gutter. The lane keeps a straight face.'; sounds.push('bowl.gutter'); }
      else { text = `${a} pins, then ${b}. ${a + b} for the frame${b === 0 ? ', the second ball finding the gutter' : ''}.`; sounds.push('bowl.pins'); }
    }
    if (frameNo === 10 && (frame[0] === 10 || frame[0] + (frame[1] || 0) === 10)) {
      const c = bowlBall(ctx, 10, aim); frame.push(c);
      text += ` Bonus ball: ${c === 10 ? 'another STRIKE' : c + ' pins'}.`;
    }
    g.frames.push(frame);
    const total = scoreRolls(g.frames);
    ctx.need({ fun: a === 10 ? 12 : 5, fed: -1 });
    ctx.learn('fitness', 1);
    if (g.frames.length >= 10) {
      const games = ((ctx.life.games && ctx.life.games.bowling) || 0) + 1;
      ctx.life.games = { ...(ctx.life.games || {}), bowling: games };
      ctx.life.bowl = null;
      await setAttrs(ctx.ch, { 'life.bowl': null, 'life.games': ctx.life.games });
      const top = await board('bowling', ctx, total, `${g.frames.filter((f) => f[0] === 10).length} strikes`);
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} finishes a game — ${total}.${top ? ' New house record.' : ''}`);
      if (top) await require('./drama').rumor(ctx, `${ctx.ch.name} put up ${total} at the Lanes — house record`, 'fun', 3);
      ctx.say(`Frame 10: ${text} FINAL: ${total}.${top ? ' That is the top of the board. Somebody is going to write it on the wall.' : total >= 150 ? ' League material.' : total >= 100 ? ' Respectable. Beer-league respectable.' : ' The pins won. They usually do.'} "scores bowling" for the board.`);
      return ctx.ok({ kinds: [...ctx.kinds, ...sounds, top ? 'levelup' : 'bowl.pins.reset'] });
    }
    await setAttrs(ctx.ch, { 'life.bowl': g });
    ctx.say(`Frame ${frameNo}: ${text} Running: ${total}.`);
    return ctx.ok({ kinds: [...ctx.kinds, ...sounds] });
  },
  buttons: (ctx) => ctx.life.bowl ? [{ label: `Roll (frame ${ctx.life.bowl.frames.length + 1})`, cmd: 'roll', group: 'here' }, { label: 'Roll a hook', cmd: 'roll hook', group: 'here' }] : [],
});

/* ── DARTS ───────────────────────────────────────────────────────────── */
act({
  name: 'darts', aliases: ['throw darts', 'play darts'],
  help: { usage: 'darts · then throw, five rounds', blurb: 'Darts at Dez’s. Three a round, five rounds, board keeps the best.' },
  when: async (ctx) => (await ctx.room()).roomId === 'dezs_bar',
  whyNot: () => 'The dartboard is at Dez’s, Line Street, behind the pool table nobody uses.',
  async run(ctx) {
    if (ctx.life.darts) return ctx.fail(`Round ${ctx.life.darts.rounds.length + 1}. "throw".`);
    ctx.life.darts = { rounds: [] };
    await setAttrs(ctx.ch, { 'life.darts': ctx.life.darts });
    ctx.say('Dez hands you three darts without looking. Five rounds. "throw".');
    return ctx.ok();
  },
  buttons: async (ctx) => (await ctx.room()).roomId === 'dezs_bar' && !ctx.life.darts ? [{ label: 'Play darts', cmd: 'darts', group: 'here' }] : [],
});
act({
  name: 'throw', aliases: ['throw dart', 'throw darts'],
  help: { usage: 'throw', blurb: 'Throw three darts.' },
  when: (ctx) => !!ctx.life.darts,
  whyNot: () => 'No darts in hand. "darts" at Dez’s.',
  async run(ctx) {
    const g = ctx.life.darts;
    const skill = ((ctx.life.games && ctx.life.games.darts) || 0) / 3 + lvl(ctx, 'hustle') * 0.4;
    const darts = [0, 1, 2].map(() => { const r = Math.random(); if (r < 0.03 + skill * 0.01) return 50; if (r < 0.08 + skill * 0.02) return 60; if (r < 0.2 + skill * 0.03) return 40 + Math.floor(Math.random() * 10); if (r > 0.9 - skill * 0.01) return 0; return 5 + Math.floor(Math.random() * 20); });
    const sum = darts.reduce((s, x) => s + x, 0);
    g.rounds.push(sum);
    const total = g.rounds.reduce((s, x) => s + x, 0);
    const words = darts.map((d) => d === 50 ? 'BULL' : d === 60 ? 'triple twenty' : d === 0 ? 'the wall' : String(d));
    ctx.need({ fun: 5 }); ctx.learn('hustle', 1);
    if (g.rounds.length >= 5) {
      ctx.life.games = { ...(ctx.life.games || {}), darts: ((ctx.life.games && ctx.life.games.darts) || 0) + 1 };
      ctx.life.darts = null;
      await setAttrs(ctx.ch, { 'life.darts': null, 'life.games': ctx.life.games });
      const top = await board('darts', ctx, total);
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} finishes at the board: ${total}.`);
      ctx.say(`Round 5: ${words.join(', ')} — ${sum}. FINAL: ${total}.${top ? ' Top of Dez’s board. Dez does not look up but he heard.' : ''}`);
      return ctx.ok({ kinds: [...ctx.kinds, 'dart.hit', top ? 'levelup' : 'emote'] });
    }
    await setAttrs(ctx.ch, { 'life.darts': g });
    ctx.say(`Round ${g.rounds.length}: ${words.join(', ')} — ${sum}. Running ${total}.`);
    return ctx.ok({ kinds: [...ctx.kinds, darts.includes(0) ? 'dart.miss' : 'dart.hit'] });
  },
  buttons: (ctx) => ctx.life.darts ? [{ label: `Throw (round ${ctx.life.darts.rounds.length + 1})`, cmd: 'throw', group: 'here' }] : [],
});

/* ── CARDS (a hand against the house) ────────────────────────────────── */
const CARD_FACES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function draw() { return CARD_FACES[Math.floor(Math.random() * 13)]; }
function handValue(cards) { let v = 0, aces = 0; for (const c of cards) { if (c === 'A') { aces++; v += 11; } else if (['J', 'Q', 'K'].includes(c)) v += 10; else v += parseInt(c, 10); } while (v > 21 && aces) { v -= 10; aces--; } return v; }
async function cardsAllowed(ctx) { const r = await ctx.room(); if (r.roomId === 'game_parlor' || r.roomId === 'dezs_bar') return true; return !!(await MooItem.findOne({ 'location.type': 'char', 'location.id': ctx.userId, 'props.cards': true }).lean()); }
act({
  name: 'play cards', aliases: ['cards', 'deal', 'blackjack', 'twenty-one'],
  help: { usage: 'play cards <bet> · hit · stand', blurb: 'Twenty-one against the house in the Game Parlor, or anywhere with a deck.' },
  when: cardsAllowed, whyNot: () => 'No cards here. The Game Parlor on Line Street deals, or carry a deck from the Corner Store.',
  async run(ctx, { arg }) {
    if (ctx.life.cards) return ctx.fail(`A hand is going: you hold ${ctx.life.cards.you.join(' ')} (${handValue(ctx.life.cards.you)}). hit or stand.`);
    const bet = Math.max(1, Math.min(50, parseInt(arg, 10) || 2));
    if (coinOf(ctx.ch) < bet) return ctx.fail(`You do not have ${bet} to put down.`);
    await payCoin(ctx.ch, bet);
    const you = [draw(), draw()], house = [draw(), draw()];
    ctx.life.cards = { bet, you, house };
    await setAttrs(ctx.ch, { 'life.cards': ctx.life.cards });
    const v = handValue(you);
    if (v === 21) return cardsSettle(ctx, 'blackjack');
    ctx.say(`${bet} down. You are dealt ${you.join(' and ')} — ${v}. The house shows ${house[0]}. hit or stand?`);
    return ctx.ok({ kinds: [...ctx.kinds, 'card_deal'], choices: [{ label: 'Hit', cmd: 'hit' }, { label: 'Stand', cmd: 'stand' }] });
  },
  buttons: async (ctx) => (await cardsAllowed(ctx)) && !ctx.life.cards ? [{ label: 'Play cards (2)', cmd: 'play cards 2', group: 'here' }] : [],
});
act({ name: 'hit', aliases: ['hit me', 'another card'], help: { usage: 'hit', blurb: 'Take a card.' }, when: (ctx) => !!ctx.life.cards, whyNot: () => 'No hand going. "play cards <bet>".',
  async run(ctx) { const g = ctx.life.cards; g.you.push(draw()); const v = handValue(g.you); if (v > 21) return cardsSettle(ctx, 'bust'); await setAttrs(ctx.ch, { 'life.cards': g }); ctx.say(`${g.you[g.you.length - 1]}. You hold ${g.you.join(' ')} — ${v}. hit or stand?`); return ctx.ok({ kinds: [...ctx.kinds, 'card_flip'], choices: [{ label: 'Hit', cmd: 'hit' }, { label: 'Stand', cmd: 'stand' }] }); },
  buttons: (ctx) => ctx.life.cards ? [{ label: 'Hit', cmd: 'hit', group: 'here' }, { label: 'Stand', cmd: 'stand', group: 'here' }] : [] });
act({ name: 'stand', aliases: ['hold cards', 'stand pat'], help: { usage: 'stand', blurb: 'Hold. The house plays out.' }, when: (ctx) => !!ctx.life.cards, fallthrough: true,
  async run(ctx) { return cardsSettle(ctx, 'stand'); } });
async function cardsSettle(ctx, how) {
  const g = ctx.life.cards;
  let houseV = handValue(g.house);
  if (how === 'stand') while (houseV < 17) { g.house.push(draw()); houseV = handValue(g.house); }
  const youV = handValue(g.you);
  let win = 0, text;
  if (how === 'blackjack') { win = Math.round(g.bet * 2.5); text = `Twenty-one off the deal. The house pays ${win}.`; }
  else if (how === 'bust') { text = `${g.you[g.you.length - 1]}. ${youV}. Bust. The house takes ${g.bet} without comment.`; }
  else if (houseV > 21) { win = g.bet * 2; text = `The house turns ${g.house.join(' ')} — ${houseV}. Bust. You take ${win}.`; }
  else if (youV > houseV) { win = g.bet * 2; text = `The house shows ${g.house.join(' ')} — ${houseV}. Your ${youV} holds. You take ${win}.`; }
  else if (youV === houseV) { win = g.bet; text = `${houseV} apiece. Push. Your ${g.bet} comes back.`; }
  else text = `The house shows ${g.house.join(' ')} — ${houseV}. Your ${youV} is short. The house takes ${g.bet}.`;
  ctx.life.cards = null;
  await setAttrs(ctx.ch, { 'life.cards': null });
  if (win) await earnCoin(ctx.ch, win);
  ctx.need({ fun: win > g.bet ? 10 : 3 }); ctx.learn('hustle', win > g.bet ? 3 : 1);
  await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', win > g.bet ? `${ctx.ch.name} takes a hand off the house.` : `${ctx.ch.name} loses a hand to the house, quietly.`);
  ctx.say(text + ` $${coinOf(ctx.ch)}.`);
  return ctx.ok({ kinds: [...ctx.kinds, win > g.bet ? 'chip_win' : 'card_flip'] });
}

/* ── MUSIC: sing, busk, dance ────────────────────────────────────────── */
const SONGS = ['a slow one about the ferry', 'the one everybody knows the chorus to', 'something Late Vance used to close the night with', 'a hymn, sideways', 'a love song with the names changed', 'the Band’s jingle, ironically, then not', 'a work song from the docks', 'the one about Gully Road in the rain'];
async function instrument(userId) { return MooItem.findOne({ 'location.type': 'char', 'location.id': userId, 'props.instrument': { $exists: true } }).lean(); }
act({
  name: 'sing', aliases: ['karaoke', 'sing a song', 'perform'],
  help: { usage: 'sing [song]', blurb: 'Sing — at Dez’s, the Bandshell, home, anywhere brave. The crowd decides.' },
  async run(ctx, { argRaw }) {
    const room = await ctx.room();
    const L = lvl(ctx, 'music');
    const song = argRaw || pick(SONGS);
    const crowd = await MooChar.countDocuments({ roomId: ctx.ch.roomId, userId: { $ne: ctx.userId } });
    const good = chance(0.35 + L * 0.06);
    const venue = room.roomId === 'dezs_bar' ? 'the little stage at Dez’s' : room.roomId === 'the_bandshell' ? 'the Bandshell' : room.roomId === 'the_kettle' ? 'the stage the size of a sigh' : room.name;
    await setBusy(ctx.ch, 8, 'singing');
    ctx.need({ fun: good ? 18 : 6, company: crowd ? 8 : 2, rested: -3 }); ctx.learn('music', good ? 6 : 3);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} sings ${song} at ${venue}. ${good ? (crowd ? 'The room actually goes quiet to listen.' : 'Nobody is here to hear how good that was.') : (crowd ? 'The room is kind about it.' : 'The room, empty, is kind about it.')}`, good ? 'social.clap' : null);
    ctx.say(`You sing ${song}. ${good ? (L >= 4 ? 'You hit the note you were scared of and hold it. Somebody whoops.' : 'It comes out better than you expected. Real applause, some of it.') : (L === 0 ? 'Brave. Loud. Mostly in the same key as the song.' : 'A rough night for the high notes. You finish anyway, which is the job.')}`);
    if (good && crowd >= 3 && chance(0.4)) await require('./drama').rumor(ctx, `${ctx.ch.name} sang at ${venue} and the room went quiet for it`, 'fun', 2);
    return ctx.ok({ kinds: [...ctx.kinds, good ? 'social.clap' : 'emote'] });
  },
  buttons: async (ctx) => ['dezs_bar', 'the_bandshell', 'the_kettle'].includes((await ctx.room()).roomId) ? [{ label: 'Sing', cmd: 'sing', group: 'here' }] : [],
});
act({
  name: 'busk', aliases: ['play for tips', 'play guitar', 'play music'],
  help: { usage: 'busk', blurb: 'Play for tips with an instrument from Hock’s — the Bandshell, Court Street, Front Street, the Pier.' },
  async run(ctx) {
    const inst = await instrument(ctx.userId);
    if (!inst) return ctx.fail('Nothing to play. Hock’s Pawn has a guitar and a harmonica.');
    const room = await ctx.room();
    const spots = { the_bandshell: 1.4, bell_court_street: 1.2, hook_front_street: 1.0, the_pier: 1.1, tanglefoot_line_street: 1.3, patch_gully_road: 0.8, sweetwater_park: 1.0, the_truck_stop: 0.7 };
    const mult = spots[room.roomId];
    if (!mult) return ctx.fail('Not a busking spot. The Bandshell, Court Street, Front Street, Line Street, the Pier, the park.');
    const L = lvl(ctx, 'music');
    const c = worldClock();
    const crowd = await MooChar.countDocuments({ roomId: ctx.ch.roomId, userId: { $ne: ctx.userId } });
    const hourMult = c.h >= 17 && c.h < 23 ? 1.4 : c.h >= 11 && c.h < 14 ? 1.2 : c.dark ? 0.5 : 1;
    const tips = Math.max(0, Math.round((1 + L * 1.2 + crowd * 0.8) * mult * hourMult * (0.6 + Math.random() * 0.8)));
    const bday = ctx.life.buskDay === c.dayKey ? (ctx.life.buskCount || 0) : 0;
    if (bday >= 5) return ctx.fail('Your fingers are done for the day. Five sets is a day. The hat says so too.');
    await setAttrs(ctx.ch, { 'life.buskDay': c.dayKey, 'life.buskCount': bday + 1 }); ctx.life.buskDay = c.dayKey; ctx.life.buskCount = bday + 1;
    if (tips) await earnCoin(ctx.ch, tips);
    await setBusy(ctx.ch, 12, 'playing a set');
    ctx.need({ fun: 12, company: 5, rested: -5, fed: -3 }); ctx.learn('music', 5);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} plays a set on ${inst.name.replace(/^(a|an)\s+/, 'the ')}. ${tips >= 8 ? 'Coins land in the case.' : 'A coin or two.'}`);
    ctx.say(`You open the case and play a set on ${inst.name.replace(/^(a|an)\s+/, 'the ')} — ${pick(SONGS)}, then two more. ${tips === 0 ? 'The hat stays empty. Wrong hour, wrong corner, right song.' : `$${tips} in the case${crowd ? ' — a little crowd stopped' : ''}. ${c.h >= 17 ? 'Evening is the money hour.' : ''}`}`);
    return ctx.ok({ kinds: [...ctx.kinds, tips ? 'coin' : 'emote'] });
  },
  buttons: async (ctx) => (await instrument(ctx.userId)) && ['the_bandshell', 'bell_court_street', 'hook_front_street', 'the_pier', 'tanglefoot_line_street', 'sweetwater_park'].includes((await ctx.room()).roomId) ? [{ label: 'Busk for tips', cmd: 'busk', group: 'here' }] : [],
});
act({
  name: 'dance', aliases: ['dance with', 'cut a rug'],
  help: { usage: 'dance [with <person>]', blurb: 'Dance — at Dez’s, the Bandshell, or anywhere with a radio going.' },
  async run(ctx, { arg }) {
    const room = await ctx.room();
    const ok = ['dezs_bar', 'the_bandshell', 'the_band_station'].includes(room.roomId) || (room.props && room.props.home && await require('./housing').furnitureHere(room.roomId, 'radio'));
    if (!ok) return ctx.fail('No music here. Dez’s, the Bandshell, or a radio at home.');
    const who = arg.replace(/^with\s+/, '');
    if (who) {
      const r = await require('./relationships').target(ctx, who); if (r.err) return ctx.fail(r.err);
      ctx.need({ fun: 15, company: 12 }); ctx.learn('charm', 3);
      await require('./relationships').land(ctx, r.t, 'dance', `You dance with ${r.t.name.split(' ')[0]}. ${r.kind === 'citizen' ? pick(['They know the steps. You do not. It works out.', 'They lead. You follow. Somebody hollers.', 'Two songs, and neither of you sits down.']) : 'Two songs, and neither of you sits down.'}`, `${ctx.ch.name} and ${r.t.name.split(' ')[0]} are dancing.`, { friendship: 5, romance: 4 }, { tellOther: `${ctx.ch.name} pulls you up to dance.` });
      return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
    }
    ctx.need({ fun: 12, company: 4, rested: -3 }); ctx.learn('fitness', 2);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} is dancing, and does not care who is watching.`);
    ctx.say(pick(['You dance like the bass is a personal instruction.', 'You dance. Badly, gloriously, alone, and then not alone.', 'You find the pocket of the beat and stay there.']));
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
  buttons: async (ctx) => ['dezs_bar', 'the_bandshell'].includes((await ctx.room()).roomId) ? [{ label: 'Dance', cmd: 'dance', group: 'here' }] : [],
});

/* ── READ / WORKOUT / RADIO / TV ─────────────────────────────────────── */
const BOOKS = ['a history of the Bell tower and why it is late', 'a field guide to the strays of Gully Road, annotated by hand', 'a Late Vance broadcast transcript, bound', 'the Founder’s first ledger, facsimile', 'a novel somebody left on the ferry, missing the last page', 'the harbor charts, older than the harbor', 'a cookbook with Pat’s handwriting in the margins', 'a children’s book about a cat who runs the city, which is not fiction'];
act({
  name: 'read', aliases: ['read a book', 'study'],
  help: { usage: 'read', blurb: 'Read — at the Archive, or a bookshelf at home. Learning, and a quiet kind of fun.' },
  async run(ctx) {
    const room = await ctx.room();
    const ok = room.roomId === 'the_archive' || (room.props && room.props.home && await require('./housing').furnitureHere(room.roomId, 'bookshelf'));
    if (!ok) return ctx.fail('Nothing to read here. The Archive on Court Street, or a bookshelf of your own.');
    await setBusy(ctx.ch, 8, 'reading');
    ctx.need({ fun: 8, rested: 3, company: -1 }); ctx.learn('learning', (ctx.life.traitKeys || []).includes('bookish') ? 6 : 4);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} settles in with a book.`);
    ctx.say(`You read ${pick(BOOKS)}. ${pick(['An hour goes by without asking.', 'You learn one thing you will repeat at Levi’s for a week.', 'Ines passes and does not shush you, which is approval.', 'The chair creaks. The page turns. That is the whole afternoon.'])}`);
    return ctx.ok({ kinds: [...ctx.kinds, 'page_turn'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return r.roomId === 'the_archive' || (r.props && r.props.home && await require('./housing').furnitureHere(r.roomId, 'bookshelf')) ? [{ label: 'Read', cmd: 'read', group: 'here' }] : []; },
});
act({
  name: 'workout', aliases: ['work out', 'exercise', 'run', 'climb', 'lift', 'jog'],
  help: { usage: 'workout', blurb: 'The Stairs, the Union Hall steps, the Ring Road, the park. Fitness, at a cost of clean.' },
  async run(ctx) {
    const room = await ctx.room();
    const spots = { the_stairs: 'You take the Stairs at a run, twice. Your legs file a complaint.', union_hall: 'Up and down the Union Hall steps until the dockhands stop laughing and start counting.', ring_road: 'You run the Ring Road until the fields blur. A truck honks. Encouragement, probably.', sweetwater_park: 'Laps around the park. The ducks pace you for a while, then lose interest.', the_docks: 'Merle hands you a crate. Then another. This is a workout with a paycheck’s worth of respect.', long_acre_fields: 'You run the field edge until the wind is the only sound.' };
    const line = spots[room.roomId];
    if (!line) return ctx.fail('Not a place to work out. The Stairs, the Union Hall steps, the Ring Road, Sweetwater Park, the docks.');
    await setBusy(ctx.ch, 10, 'working out');
    ctx.need({ fun: 6, clean: -12, rested: -8, fed: -5 }); ctx.learn('fitness', 6);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} is working out, and it shows.`);
    ctx.say(line + ' You feel it. Good.');
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
  buttons: async (ctx) => ['the_stairs', 'union_hall', 'ring_road', 'sweetwater_park'].includes((await ctx.room()).roomId) ? [{ label: 'Work out', cmd: 'workout', group: 'here' }] : [],
});
const DJ = {
  night: ['"This is the Band, and this is the hour nobody admits to. Here is something slow."', '"Somebody out on the Ring Road, this one is for your headlights."', '"The freight is due at 11:40. Set your watch by it. Do not set your watch by the bell."'],
  morning: ['"Good morning, Reverie. Pat’s coffee is bad and the harbor is loud. All is well."', '"Traffic: the tram is running. That is the traffic report."', '"The Salon opens at ten and so does everybody’s business."'],
  day: ['"Weather: the Founder’s sky is doing something again. Dress for two seasons."', '"Lost and Found says somebody left a whole ham. Opal would like it collected."', '"A reminder from the Bureau of Small Complaints: the third stool is still under review."'],
  evening: ['"Evening, Reverie. Dez’s is open, the Lanes have league night, and the Pier is free."', '"This next one goes out to the Patch, from somebody who did not leave a name."', '"The Band, coming to you from over the pawnshop, where the rent is paid in music."'],
};
act({
  name: 'radio', aliases: ['listen radio', 'listen to the radio', 'turn on radio', 'tune in', 'the band'],
  help: { usage: 'radio', blurb: 'Tune in the Band — at home with a radio, at the station, at Dez’s or Pat’s, or in a car.' },
  async run(ctx) {
    const room = await ctx.room();
    const car = (await require('./vehicles').owned(ctx.userId)).some((v) => v.props.vehicle.type === 'car');
    const ok = ['the_band_station', 'dezs_bar', 'pats_diner', 'the_truck_stop', 'the_garages'].includes(room.roomId) || car || (room.props && room.props.home && await require('./housing').furnitureHere(room.roomId, 'radio'));
    if (!ok) return ctx.fail('No radio here. Hock’s sells one for home; the Band comes through at Dez’s, Pat’s, the Truck Stop, and in any car.');
    const c = worldClock();
    const slot = c.h < 6 || c.h >= 23 ? 'night' : c.h < 11 ? 'morning' : c.h < 17 ? 'day' : 'evening';
    const rumor = await MooRumor.findOne({ heat: { $gte: 3 } }).sort({ at: -1 }).lean();
    ctx.need({ fun: 8, company: 3 });
    ctx.say(`The dial warms. The Band: ${pick(DJ[slot])}${rumor ? ` "And word around town: ${rumor.text}. You heard it here, or you heard it at Levi’s, same thing."` : ''} Then ${pick(SONGS)}, and the room feels less empty.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'radio'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return ['the_band_station', 'dezs_bar', 'pats_diner', 'the_truck_stop'].includes(r.roomId) || (r.props && r.props.home && await require('./housing').furnitureHere(r.roomId, 'radio')) ? [{ label: 'Turn on the radio', cmd: 'radio', group: 'here' }] : []; },
});
act({
  name: 'watch tv', aliases: ['tv', 'television', 'watch television'],
  help: { usage: 'watch tv', blurb: 'At home, with a set. Cheap fun.' },
  when: async (ctx) => { const r = await ctx.room(); return !!(r.props && r.props.home && await require('./housing').furnitureHere(r.roomId, 'tv')); },
  whyNot: () => 'No television here. Hock’s has one, heavy as a safe.',
  async run(ctx) {
    await setBusy(ctx.ch, 5, 'watching tv');
    ctx.need({ fun: 12, rested: 4, company: -1 });
    ctx.say(pick(['The only channel is a cooking show where Pat is the guest and refuses to give measurements.', 'A rerun of the Founder’s Day parade. The bell is late in this one too.', 'Static, then a game show where every prize is a flattened penny. You watch the whole thing.', 'The news: the third stool. Both sides. No resolution.']));
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
  buttons: async (ctx) => { const r = await ctx.room(); return r.props && r.props.home && await require('./housing').furnitureHere(r.roomId, 'tv') ? [{ label: 'Watch TV', cmd: 'watch tv', group: 'here' }] : []; },
});

/* ── SCORES ──────────────────────────────────────────────────────────── */
act({
  name: 'scores', aliases: ['leaderboard', 'high scores', 'board'], free: true,
  help: { usage: 'scores · scores bowling · scores darts', blurb: 'Who holds the boards.' },
  async run(ctx, { arg }) {
    const boards = arg ? [arg.split(' ')[0]] : ['bowling', 'darts'];
    for (const b of boards) {
      const top = await MooBoard.find({ board: b }).sort({ score: -1 }).limit(5).lean();
      ctx.say(top.length ? `${cap(b)}: ${top.map((t, i) => `${i + 1}. ${t.name} ${t.score}${t.note ? ` (${t.note})` : ''}`).join('; ')}.` : `${cap(b)}: nobody on the board yet.`);
    }
    return ctx.ok();
  },
});

/* fallback for "play" with no child present */
async function playGeneric(ctx, arg) { return ctx.fail(arg ? `Nobody called "${arg}" here to play with. "play cards" for a hand, "bowl" at the Lanes, "darts" at Dez’s.` : '"play with <kid>", "play cards <bet>", "bowl", "darts", "sing", "dance" — pick a thing.'); }

module.exports = { RECIPES, playGeneric, scoreRolls };
