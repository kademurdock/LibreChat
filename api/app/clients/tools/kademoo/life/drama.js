/* REVERIE LIFE — the drama layer (Sep 6 2026).
 *
 * Her brief: not candy land, not dystopia. A soap opera if you live in the
 * slums, a garden show if you live behind the gates, and the same city
 * either way. So: the whisper network (what you do becomes what people say),
 * the ladder of violence with a hard ceiling (words → hands, never past
 * bruised, players only fight players who said yes), the corner where Little
 * Ray sells a little something and Doc has opinions about it, pickpocketing
 * in the wards whose law tables shrug — and Sgt. Odessa Vann, who does not
 * shrug, and Honorable Pham’s night court, which fines you and lets you go.
 *
 * Nobody dies. Nobody loses their character. Marks fade. The rumor does not,
 * for a while, and that is the actual punishment. */
const registry = require('./registry');
const skills = require('./skills');
const rel = require('./relationships');
const { MooRumor } = require('~/models/kadeMooLife');
const {
  MooChar, MooItem, MooRoom, MooDistrict, emit, tell, setAttrs, setBusy, moveTo, coinOf, payCoin, earnCoin, matchName, kindOfSoul, makeItem, worldClock, cap, pick, chance, plural, daysBetween,
} = require('./ctx');

const lvl = (ctx, s) => skills.levelOf((ctx.life.skills || {})[s] || 0);

/* ── THE WHISPER NETWORK ─────────────────────────────────────────────── */
async function rumor(ctx, text, kind = 'talk', heat = 2) {
  try {
    const room = await ctx.room();
    await MooRumor.create({ text, about: [ctx.userId], ward: room ? room.district : 'bellward', kind, heat });
  } catch (_) { /* gossip is never load-bearing */ }
}
async function freshRumors(limit = 5, excludeUser) {
  const q = { at: { $gte: new Date(Date.now() - 7 * 86400000) } };
  if (excludeUser) q.about = { $ne: excludeUser };
  return MooRumor.find(q).sort({ heat: -1, at: -1 }).limit(limit).lean();
}
const GOSSIP_SPOTS = { levis_chairs: 'Levi', the_salon: 'the stylist', pats_diner: 'Pat', ruth_anns_stoop: 'Ruth-Ann', dezs_bar: 'Dez', corner_store: 'the register', fish_market: 'the fishwives', the_band_station: 'the Band', union_hall: 'the steps', hoa_hall: 'the HOA ladies' };
registry.register({
  name: 'rumors', aliases: ['gossip', 'what have you heard', 'any news', 'word around town'], free: true,
  help: { topic: 'drama', usage: 'rumors', blurb: 'What the city is saying — at Levi’s, the Salon, Pat’s, Ruth-Ann’s stoop, Dez’s.' },
  async run(ctx) {
    const room = await ctx.room();
    const who = GOSSIP_SPOTS[room.roomId];
    if (!who) return ctx.fail('Gossip has addresses: Levi’s Chairs, the Salon, Pat’s counter, Ruth-Ann’s stoop, Dez’s, the Corner Store register. Or turn on the radio.');
    const rs = await freshRumors(5);
    const mine = await MooRumor.find({ about: ctx.userId, at: { $gte: new Date(Date.now() - 7 * 86400000) } }).sort({ at: -1 }).limit(2).lean();
    ctx.need({ company: 5, fun: 6 }); ctx.learn('charm', 1);
    if (!rs.length && !mine.length) { ctx.say(`${cap(who)} has nothing today. "Quiet week. Suspicious, honestly."`); return ctx.ok(); }
    ctx.say(`${cap(who)} leans in: ${rs.map((r) => r.text).join('. ')}${rs.length ? '.' : ''}`);
    if (mine.length) ctx.say(`And about you: "${mine.map((m) => m.text).join('. ')}." ${pick(['You could deny it. It would not help.', 'They say it kindly. Mostly.', 'The city keeps receipts.'])}`);
    return ctx.ok({ kinds: [...ctx.kinds, 'say'] });
  },
  buttons: async (ctx) => GOSSIP_SPOTS[(await ctx.room()).roomId] ? [{ label: 'Hear the gossip', cmd: 'rumors', group: 'here' }] : [],
});

/* ── MARKS ───────────────────────────────────────────────────────────── */
async function addMark(ch, mark, days) {
  const marks = Array.from(new Set([...((ch.attrs && ch.attrs.marks) || []), mark]));
  const meta = { ...((ch.attrs && ch.attrs.markMeta) || {}), [mark]: days ? Date.now() + days * 86400000 : null };
  await setAttrs(ch, { marks, markMeta: meta });
}
async function lawOf(ctx) {
  const room = await ctx.room();
  const d = await MooDistrict.findOne({ districtId: room.district }).lean();
  return { room, law: (d && d.props && d.props.law) || {}, kidSafe: !!(d && d.props && d.props.kid_safe), hoa: !!(d && d.props && d.props.hoa), ward: d ? d.name : room.district };
}

/* ── THE CORNER ──────────────────────────────────────────────────────── */
registry.register({
  name: 'corner', aliases: ['see ray', 'ask around', 'score', 'the corner'],
  help: { topic: 'drama', usage: 'corner', blurb: 'Little Ray, on Gully Road after dark. Polite, careful, and selling a little something.' },
  async run(ctx) {
    const { room, kidSafe } = await lawOf(ctx);
    const ray = await MooChar.findOne({ roomId: ctx.ch.roomId, userId: 'npc:littleray' }).lean();
    if (kidSafe) return ctx.fail('Not in this ward. Not anywhere near the kids.');
    if (!ray) return ctx.fail('Little Ray is not on this corner. Gully Road, evenings, and he sees you before you see him.');
    if (coinOf(ctx.ch) < 5) return ctx.fail('Ray looks at you with something like sympathy. "Come back when you got five. I don’t run tabs, cousin."');
    const c = worldClock();
    if (!c.dark && chance(0.5)) return ctx.fail('Ray shakes his head a quarter inch. "Broad daylight? Sgt. Vann eats at Pat’s till two. Come back after."');
    await payCoin(ctx.ch, 5);
    await makeItem({ name: 'a little something', desc: 'Folded paper, no label. Ray’s. You know what it is and so does anybody who sees it.', location: { type: 'char', id: ctx.userId }, props: { vice: true, value: 2 } });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} and Little Ray shake hands longer than a handshake takes.`);
    ctx.learn('hustle', 2);
    ctx.say('Ray does not look at you and does not look away. A handshake, and your pocket is heavier and lighter at the same time. "Be easy." ("use it" when you want to; Doc has opinions.)');
    if (chance(0.3)) await rumor(ctx, `${ctx.ch.name} was seen shaking hands with Little Ray`, 'vice', 2);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
  buttons: async (ctx) => (await MooChar.findOne({ roomId: ctx.ch.roomId, userId: 'npc:littleray' }).lean()) ? [{ label: 'See Ray', cmd: 'corner', group: 'people' }] : [],
});
registry.register({
  name: 'use', aliases: ['use it', 'smoke', 'take it', 'light up'],
  help: { topic: 'drama', usage: 'use', blurb: 'Use what you got off Ray. Fun goes up, everything else goes down, and habits are real.' },
  async run(ctx) {
    const it = await MooItem.findOne({ 'location.type': 'char', 'location.id': ctx.userId, 'props.vice': true }).lean();
    if (!it) return ctx.fail('Nothing on you. (Ray, Gully Road, after dark.)');
    const { kidSafe, room } = await lawOf(ctx);
    if (kidSafe || room.roomId === 'childrens_office' || room.roomId === 'treehouse_row') return ctx.fail('Not here. Not near kids. You know better.');
    await MooItem.deleteOne({ _id: it._id });
    const uses = (ctx.life.vice || 0) + 1;
    const habit = uses >= 3;
    await setAttrs(ctx.ch, { 'life.vice': uses, 'life.viceAt': Date.now() }); ctx.life.vice = uses;
    ctx.need({ fun: 30, clean: -20, rested: -12, fed: -8, company: -4 });
    await setBusy(ctx.ch, 8, 'somewhere else for a minute');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} steps to the side for a minute and comes back looser.`);
    ctx.say(pick(['The edges go soft. The bell is beautiful for once. Then it is over, and the bell is late again.', 'For a while the city is exactly the right size. Then it is not.', 'Everything is funny, then quiet, then you are hungry and it is later than you thought.']));
    if (habit && !(ctx.ch.attrs.marks || []).includes('a habit')) { await addMark(ctx.ch, 'a habit', 3); ctx.say('People are starting to notice. Ruth-Ann already has. Three days clean and it fades.'); await rumor(ctx, `${ctx.ch.name} has been out on Gully Road a lot lately`, 'vice', 3); }
    if (chance(0.25)) ctx.say('Doc, passing: "I am not going to say anything." Doc says several things.');
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});

/* ── PICKPOCKET ──────────────────────────────────────────────────────── */
registry.register({
  name: 'pickpocket', aliases: ['pick pocket', 'lift from', 'rob', 'steal from'],
  help: { topic: 'drama', usage: 'pickpocket <citizen>', blurb: 'In the Hook, the Patch, Tanglefoot. Hustle helps. Sgt. Vann does not.' },
  async run(ctx, { arg }) {
    const { law, kidSafe, room, ward, hoa } = await lawOf(ctx);
    if (!arg) return ctx.fail('Lift from who?');
    const here = await MooChar.find({ roomId: ctx.ch.roomId, userId: { $ne: ctx.userId } }).lean();
    const t = matchName(here, arg.replace(/^from\s+/, ''));
    if (!t) return ctx.fail(`Nobody called "${arg}" here.`);
    const k = kindOfSoul(t);
    if (k !== 'citizen') return ctx.fail(k === 'player' ? 'Not players. That is not the game. Hustle the house, not your friends.' : 'No.');
    if (kidSafe || law.ladderCap === 'words' || law.ladderCap === 'hands') return ctx.fail(`Not in ${ward}. ${hoa ? 'Private security is already smiling at you.' : 'Everybody here knows everybody.'}`);
    if (['npc:odessa', 'npc:pham', 'npc:reed', 'npc:junie', 'npc:ruthann'].includes(t.userId)) return ctx.fail(t.userId === 'npc:odessa' ? 'You consider it. Sgt. Vann considers you back. You reconsider.' : 'Not them. Even you have a line.');
    const L = lvl(ctx, 'hustle');
    const p = 0.35 + L * 0.05 + ((ctx.life.traitKeys || []).includes('hustler') ? 0.1 : 0) - (worldClock().dark ? 0 : 0.1);
    const vannHere = here.some((h) => h.userId === 'npc:odessa');
    if (vannHere || !chance(p)) {
      ctx.learn('hustle', 1);
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} gets a hand in ${t.name.split(' ')[0]}’s pocket and ${t.name.split(' ')[0]} gets a hand on ${ctx.ch.name}’s wrist.`);
      return nightCourt(ctx, `caught with a hand in ${t.name}’s pocket`, 10);
    }
    const take = 2 + Math.floor(Math.random() * (4 + L));
    await earnCoin(ctx.ch, take);
    ctx.learn('hustle', 4); ctx.need({ fun: 8 });
    await rel.adjust(ctx.userId, t.userId, { friendship: -2 }, { kind: 'lifted' });
    ctx.say(`Your hand is in and out. $${take}. ${t.name.split(' ')[0]} does not notice, yet. ${pick(['Your heart is going.', 'You hate how easy that was.', 'Ray would be proud, which is not a good sign.'])}`);
    if (chance(0.2)) await rumor(ctx, `somebody has been lifting wallets around ${room.name}`, 'crime', 2);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

/** Sgt. Vann → the Courthouse → Honorable Pham. A fine, or an hour of service, and a mark. */
async function nightCourt(ctx, charge, fine) {
  const { ch } = ctx;
  await emit(ch.roomId, null, 'the world', 'system', `Sgt. Odessa Vann appears the way she does, and walks ${ch.name} off toward Court Street.`, 'vio.siren.distant');
  await moveTo(ch, 'the_courthouse', null, `Sgt. Vann brings ${ch.name} in, ${charge}.`, { noFollow: true });
  const canPay = coinOf(ch) >= fine;
  if (canPay) await payCoin(ch, fine);
  await addMark(ch, 'on record', 14);
  await setBusy(ch, canPay ? 15 : 45, canPay ? 'in night court' : 'sweeping the courthouse steps');
  ctx.need({ fun: -15, company: -5, clean: -5 });
  await rumor(ctx, `${ch.name} got walked into night court by Sgt. Vann`, 'crime', 4);
  ctx.say(`Sgt. Vann does not say a word the whole way. Honorable Pham looks over the glasses: "${cap(charge)}." ${canPay ? `Fine, $${fine}. Paid. "Do not let me learn your name."` : `You cannot pay, so it is the steps and a broom, and the broom is heavy. "Do not let me learn your name."`} You are on record for two weeks. The city will hear.`);
  return ctx.ok({ wantRoom: true, kinds: [...ctx.kinds, 'vio.siren.distant', 'cer.bell.wronghour.single'] });
}

/* ── THE LADDER: shove, fight ────────────────────────────────────────── */
registry.register({
  name: 'shove', aliases: ['push', 'get in face of', 'square up'],
  help: { topic: 'drama', usage: 'shove <person>', blurb: 'The rung above words. Costs friendship. Where the law allows.' },
  async run(ctx, { arg }) {
    const { law, kidSafe, ward, hoa } = await lawOf(ctx);
    const r = await rel.target(ctx, arg, { noKids: true }); if (r.err) return ctx.fail(r.err);
    if (kidSafe || law.ladderCap === 'words') return ctx.fail(`Not in ${ward}. Words only here, and the ducks are watching.`);
    const { t, kind } = r;
    if (kind === 'citizen' && ['npc:odessa', 'npc:pham'].includes(t.userId)) return nightCourt(ctx, `laying hands on ${t.name}`, 15);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} shoves ${t.name.split(' ')[0]}. The room takes a step back.`);
    ctx.need({ fun: 2, company: -5 });
    const rr = await rel.land(ctx, t, 'shove', `You shove ${t.name.split(' ')[0]}. ${kind === 'citizen' ? pick([`${t.name.split(' ')[0]} does not shove back. Yet.`, `${t.name.split(' ')[0]} steps in close and says something only you hear.`]) : `${t.name.split(' ')[0]} is up in your face now.`}`, null, { friendship: -10 }, { tellOther: `${ctx.ch.name} shoves you. ("fight ${ctx.ch.name.split(' ')[0]}" if you want to make it one.)` });
    if (hoa) { await payCoin(ctx.ch, Math.min(coinOf(ctx.ch), 5)); ctx.say('The HOA fines you five dollars on the spot for "conduct." A form is involved.'); }
    if (rr.friendship <= -40) await rumor(ctx, `${ctx.ch.name} and ${t.name.split(' ')[0]} are about to come to blows`, 'feud', 3);
    return ctx.ok({ kinds: [...ctx.kinds, 'err'] });
  },
});
registry.register({
  name: 'fight', aliases: ['fight with', 'throw hands', 'square off'],
  help: { topic: 'drama', usage: 'fight <person>', blurb: 'Hands. Players must accept. Loser ends up bruised, maybe at Mercy. Never worse.' },
  async run(ctx, { arg }) {
    const { law, kidSafe, ward, hoa } = await lawOf(ctx);
    const r = await rel.target(ctx, arg.replace(/^with\s+/, ''), { noKids: true }); if (r.err) return ctx.fail(r.err);
    if (kidSafe || law.ladderCap === 'words') return ctx.fail(`Not in ${ward}. Not with kids around.`);
    const { t, kind } = r;
    if (kind === 'citizen') {
      if (['npc:odessa', 'npc:pham', 'npc:reed', 'npc:ruthann', 'npc:doc', 'npc:chike', 'npc:ines'].includes(t.userId)) return t.userId === 'npc:odessa' ? nightCourt(ctx, 'swinging on a sergeant', 20) : ctx.fail(`${t.name.split(' ')[0]}? No. The whole city would turn on you, and rightly.`);
      return brawl(ctx, t, 'citizen');
    }
    await rel.offer(ctx, t, 'fight', `${ctx.ch.name} wants to fight you, right here. (accept, or decline — declining costs nothing.)`);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} squares up on ${t.name}.`);
    ctx.say(`You square up on ${t.name.split(' ')[0]}. Their call. ${hoa ? 'Private security is already on the radio.' : ''}`);
    return ctx.ok();
  },
});
async function fightAccepted(ctx, from) { return brawl(ctx, from, 'player'); }
async function brawl(ctx, t, kind) {
  const { ch } = ctx;
  const { hoa } = await lawOf(ctx);
  const myF = lvl(ctx, 'fitness') + ((ch.attrs.marks || []).includes('bruised') ? -2 : 0);
  let theirF = 3;
  if (kind === 'player') { const other = await MooChar.findOne({ userId: t.userId, active: true }).lean(); theirF = skills.levelOf(((other.attrs.life || {}).skills || {}).fitness || 0); }
  else theirF = { merle: 8, boone: 7, dez: 5, royce: 6, emmett: 6, marsh: 7, hock: 3, levi: 4, littleray: 4, pat: 6 }[t.userId.replace(/^npc:/, '')] || 4;
  const win = chance(0.5 + (myF - theirF) * 0.06);
  const loser = win ? t : ch;
  const winner = win ? ch : t;
  await emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} and ${t.name} go at it. It is short and ugly and the room clears a circle. ${winner.name.split(' ')[0]} is standing when it is over.`);
  ctx.need({ fun: win ? 10 : -10, clean: -15, rested: -15, fed: -5 });
  ctx.learn('fitness', 5);
  await rel.adjust(ch.userId, t.userId, { friendship: -15, romance: -10 }, { kind: 'fight', names: { [ch.userId]: ch.name, [t.userId]: t.name } });
  if (loser === ch) await addMark(ch, 'bruised', 1);
  if (!win) {
    if (chance(0.5)) { await moveTo(ch, 'mercy_hospital', null, `${ch.name} comes in holding their ribs. Dr. Chike sighs and points at a bed.`); ctx.say(`You lose. You lose badly enough that somebody walks you to Mercy. Dr. Chike does not ask. You are bruised for a day. Nothing is broken that will not mend.`); }
    else ctx.say(`You lose. You are on the ground, then you are not, and ${t.name.split(' ')[0]} is walking away. Bruised for a day.`);
  } else {
    if (kind === 'player') { const o = await MooChar.findOne({ userId: t.userId, active: true }); if (o) { await MooChar.updateOne({ _id: o._id }, { $set: { 'attrs.markMeta.bruised': Date.now() + 86400000 }, $addToSet: { 'attrs.marks': 'bruised' } }); await tell(t.userId, `You lose the fight with ${ch.name}. Bruised for a day. Mercy has ice.`, 'system', 'err'); } }
    ctx.say(`You win. It does not feel like much. ${t.name.split(' ')[0]} is down and then up and then gone, and your hands hurt.`);
  }
  if (hoa) { await payCoin(ch, Math.min(coinOf(ch), 15)); ctx.say('The HOA fines you fifteen dollars. Private security takes a photo for the newsletter.'); }
  await rumor(ctx, `${ch.name} and ${t.name} fought at ${(await ctx.room()).name}${win ? ` and ${ch.name.split(' ')[0]} won` : ` and ${t.name.split(' ')[0]} won`}`, 'fight', 4);
  if (chance(0.3) && kind === 'citizen') return nightCourt(ctx, 'brawling in public', 8);
  await setBusy(ch, 12, 'catching your breath');
  return ctx.ok({ wantRoom: !win, kinds: [...ctx.kinds, 'fight'] });
}

/* ── RECORD ──────────────────────────────────────────────────────────── */
registry.register({
  name: 'record', aliases: ['my record', 'rap sheet'], free: true,
  help: { topic: 'drama', usage: 'record', blurb: 'Your marks and how long they last.' },
  async run(ctx) {
    const marks = ctx.ch.attrs.marks || [];
    const meta = ctx.ch.attrs.markMeta || {};
    if (!marks.length) return ctx.ok({ lines: [...ctx.lines, 'Clean. Sgt. Vann does not know your name, and that is the best way to be known by her.'] });
    ctx.say('Marks: ' + marks.map((m) => `${m}${meta[m] ? ` (${Math.max(0, Math.ceil((meta[m] - Date.now()) / 86400000))} days left)` : ''}`).join(', ') + '.');
    return ctx.ok();
  },
});

module.exports = { rumor, freshRumors, addMark, nightCourt, fightAccepted, lawOf, GOSSIP_SPOTS };
