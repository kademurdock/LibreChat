/* REVERIE LIFE — how people feel about each other (Sep 6 2026).
 *
 * One number for friendship (-100 feud … 100 family) and one for romance
 * (0 … 100), per pair, player or citizen, either side. Every social verb here
 * moves them and says how it went; every citizen answers in a voice set by
 * temperament and by where you two already stand. Consent is built in for
 * players: a kiss, a proposal, a move-in are OFFERS the other person accepts
 * or lets pass. Citizens decide for themselves, with dice weighted by your
 * charm, your traits, and the history.
 *
 * Zero model calls. The city's warmth is a lookup table and a coin flip, and
 * it has to be, because it has to answer in fifty milliseconds forever. */
const registry = require('./registry');
const skills = require('./skills');
const reverie = require('../reverie');
const { MooRel } = require('~/models/kadeMooLife');
const {
  MooChar, MooItem, emit, tell, setAttrs, setBusy, matchName, findHeld, kindOfSoul, coinOf, cap, pick, chance, hashStr,
} = require('./ctx');

function pairKey(a, b) { return [String(a), String(b)].sort().join('|'); }

async function getRel(a, b) {
  const doc = await MooRel.findOne({ pair: pairKey(a, b) }).lean();
  return doc || { pair: pairKey(a, b), a: String(a), b: String(b), friendship: 0, romance: 0, flags: {}, recent: [] };
}
async function adjust(a, b, delta, opts = {}) {
  const pair = pairKey(a, b);
  const cur = await getRel(a, b);
  const f = Math.max(-100, Math.min(100, (cur.friendship || 0) + (delta.friendship || 0)));
  const r = Math.max(0, Math.min(100, (cur.romance || 0) + (delta.romance || 0)));
  const set = { a: String(a), b: String(b), friendship: f, romance: r, lastAt: new Date() };
  if (opts.names) set.names = { ...(cur.names || {}), ...opts.names };
  if (opts.flags) set.flags = { ...(cur.flags || {}), ...opts.flags };
  const upd = { $set: set };
  if (opts.kind) upd.$push = { recent: { $each: [opts.kind], $slice: -6 } };
  await MooRel.updateOne({ pair }, upd, { upsert: true });
  return { ...cur, ...set, flags: set.flags || cur.flags || {} };
}
async function relsOf(userId) { return MooRel.find({ $or: [{ a: userId }, { b: userId }] }).sort({ lastAt: -1 }).lean(); }

function tierOf(rel) {
  const f = rel.flags || {};
  if (f.married) return 'married';
  if (f.partner) return 'partners';
  if (f.family) return 'family';
  if (f.exes) return 'exes';
  const fr = rel.friendship || 0;
  if (fr <= -40) return 'feuding';
  if (fr <= -10) return 'on bad terms';
  if (fr < 10) return 'strangers';
  if (fr < 30) return 'acquaintances';
  if (fr < 60) return 'friends';
  if (fr < 85) return 'close friends';
  return 'like family';
}
function romanceWord(rel) {
  const r = rel.romance || 0;
  if ((rel.flags || {}).married || (rel.flags || {}).partner) return null;
  if (r >= 70) return 'more than a spark';
  if (r >= 45) return 'something there';
  if (r >= 20) return 'a spark';
  return null;
}
async function describeRel(ch, other) {
  if (!other || other.userId === ch.userId) return null;
  const k = kindOfSoul(other);
  if (k === 'stray') return null;
  const rel = await getRel(ch.userId, other.userId);
  const tier = tierOf(rel);
  const rw = romanceWord(rel);
  if (tier === 'strangers' && !rw) return k === 'citizen' ? `You and ${other.name.split(' ')[0]} have not really talked.` : null;
  return `You and ${other.name.split(' ')[0]} are ${tier}${rw ? `, and there is ${rw}` : ''}.`;
}

/* ── CITIZEN TEMPERAMENTS ────────────────────────────────────────────── */
const TEMPER = {
  pat: 'gruff', merle: 'warm', dez: 'cool', ines: 'formal', ruthann: 'warm', littleray: 'cool', levi: 'warm', doc: 'gruff', hock: 'cool',
  boone: 'gruff', marsh: 'gruff', reed: 'formal', odessa: 'formal', wendell: 'formal', opal: 'warm', constance: 'formal', oleander: 'cool', pham: 'formal',
  cass: 'warm', chike: 'formal', marva: 'gruff', royce: 'cool', birdie: 'warm', emmett: 'gruff', junie: 'warm',
};
const NO_ROMANCE = new Set(['junie', 'reed', 'pham', 'odessa', 'chike']); /* a kid, and the people whose job it is not */
function temperOf(npcId) { return TEMPER[String(npcId).replace(/^npc:/, '')] || 'warm'; }

const REACT = {
  chat: {
    warm: ['{N} lights up and talks with their hands.', '{N} pulls you into the conversation like there was a seat saved.', '{N} asks about you first and means it.'],
    gruff: ['{N} grunts, then says more than you expected.', '{N} talks while working. It counts.', '{N} gives you two sentences and a nod. From {n}, that is a speech.'],
    cool: ['{N} leans back and lets you do the talking, then says one true thing.', '{N} talks like the conversation is a card game and you are both bluffing.', '{N} half-smiles and keeps it short.'],
    formal: ['{N} listens with their whole attention and answers in complete sentences.', '{N} is polite, precise, and warmer than the words.', '{N} asks a good question and waits for the real answer.'],
  },
  joke_hit: {
    warm: ['{N} laughs so hard they have to put something down.', '{N} howls and repeats the punchline to nobody.'],
    gruff: ['{N} does not laugh, but the corner of the mouth goes. That is a standing ovation.', '{N} snorts. "Alright. That one was alright."'],
    cool: ['{N} shakes their head, grinning despite themselves.', '{N}: "Okay. Okay, that was good."'],
    formal: ['{N} laughs once, surprised, then covers it with a cough.', '{N} allows a smile. "That was very nearly funny."'],
  },
  joke_miss: ['{N} waits for the rest of it. There is no rest of it.', '{N} looks at you like you sneezed.', 'Silence. {N} changes the subject kindly.'],
  compliment_hit: {
    warm: ['{N} waves it off and glows for a minute anyway.', '{N}: "Stop it. Keep going."'],
    gruff: ['{N} says "hm" and stands a little straighter.', '{N} pretends not to hear it and does not stop smiling for a while.'],
    cool: ['{N} tilts their head. "Yeah? Noted."', '{N} lets it land. "I know. But thank you."'],
    formal: ['{N} thanks you properly and remembers it.', '{N} inclines their head. "That is kind. Sincerely."'],
  },
  compliment_miss: ['{N} hears the angle in it and lets it pass.', '{N}: "Mm-hm." Not buying it today.'],
  flirt_hit: ['{N} holds your eye a beat longer than the joke needed.', '{N} laughs low and does not step back.', '{N} bumps your shoulder on the way past, on purpose.', '{N}: "You keep saying things like that."'],
  flirt_miss: ['{N} smiles the way you smile at a nephew. Not today.', '{N} does not notice, or does a good job of it.', '{N}: "That’s sweet." Which is the polite door closing.'],
  flirt_no: ['{N} is kind about it and clear about it: no.', 'That is not a door {N} has for anybody. They are gracious about it.'],
  hug: {
    warm: ['{N} hugs you back hard enough to move your spine.', '{N} folds you in like it was their idea.'],
    gruff: ['{N} gives you two pats on the back, which is a lot.', '{N} allows the hug. Endures it, even. Then squeezes once.'],
    cool: ['{N} hugs you back, brief and real.', '{N}: "Alright, alright." Hugs you anyway.'],
    formal: ['{N} is surprised, then returns it with care.', '{N} hugs you back with one arm and pats twice.'],
  },
  argue_win: ['{N} throws up their hands. You win this one and both of you know it.', '{N} goes quiet, which from {n} means you were right.'],
  argue_lose: ['{N} takes you apart one point at a time. Politely.', '{N} says one sentence and there is nothing left to say.'],
  insult: ['{N} goes very still. That will cost you.', '{N} laughs, not nicely. The room heard it.', '{N} looks at you like a door they are closing.'],
  apologize_yes: ['{N} lets a long breath out. "Okay. Okay."', '{N} nods. "Don’t make me hear it twice."'],
  apologize_no: ['{N} is not there yet. They say so.', '{N}: "Not today." But not never.'],
  comfort: ['{N} lets you sit with them a while. That was the whole thing.', '{N} does not say much. Leans a little. Enough.'],
  gift_yes: ['{N} turns {g} over twice and cannot quite hide the smile.', '{N}: "You didn’t have to." Keeps it anyway.'],
  gift_flowers: ['{N} takes the flowers and looks at you a long second.', '{N} puts the flowers in water immediately, which tells you something.'],
};

function fill(line, other, extra = {}) {
  const first = other.name.split(' ')[0];
  return line.replace(/\{N\}/g, other.name.split(' ')[0]).replace(/\{n\}/g, first).replace(/\{g\}/g, extra.gift || 'it');
}
function react(key, other, extra) {
  const bank = REACT[key];
  const arr = Array.isArray(bank) ? bank : (bank[temperOf(other.userId)] || bank.warm);
  return fill(pick(arr), other, extra);
}

/** charm-weighted roll. base 0..1; charm adds up to +.3; mood via ctx */
function roll(ctx, base, bonus = 0) {
  const charm = skills.levelOf((ctx.life.skills || {}).charm || 0);
  const mood = require('./needs').moodOf(ctx.life.needs || {});
  const traits = ctx.life.traitKeys || [];
  let p = base + charm * 0.03 + (mood.label === 'glowing' ? 0.08 : mood.label === 'rough' ? -0.12 : 0) + bonus;
  if (traits.includes('funny')) p += 0.05;
  return chance(Math.max(0.05, Math.min(0.95, p)));
}

async function target(ctx, arg, opts = {}) {
  const here = await MooChar.find({ roomId: ctx.ch.roomId, userId: { $ne: ctx.ch.userId } }).lean();
  const t = matchName(here, arg.replace(/^(with|to|at|about)\s+/, ''));
  if (!t) return { err: `Nobody called "${arg}" is here with you.` };
  const k = kindOfSoul(t);
  if (k === 'stray') return { err: `${t.name} is an animal. Try: pet, approach, offer.` };
  if (opts.noKids && k === 'child') return { err: `${t.name} is a child.` };
  if (opts.noNpcRomance && k === 'citizen' && NO_ROMANCE.has(t.userId.replace(/^npc:/, ''))) return { err: react('flirt_no', t) };
  if (opts.romance && k === 'child') return { err: 'No.' };
  return { t, kind: k };
}

/** Say the outcome to the room and to the other player (if any). */
async function land(ctx, t, kind, selfLine, roomLine, delta, opts = {}) {
  const { ch } = ctx;
  const names = { [ch.userId]: ch.name, [t.userId]: t.name };
  const rel = await adjust(ch.userId, t.userId, delta, { names, kind, flags: opts.flags });
  if (roomLine) await emit(ch.roomId, ch.userId, ch.name, 'emote', roomLine);
  if (opts.tellOther && kindOfSoul(t) === 'player') await tell(t.userId, opts.tellOther, 'system', opts.sound);
  ctx.say(selfLine);
  if (opts.tierNote !== false) {
    const tier = tierOf(rel);
    if (rel.friendship >= 30 && (rel.friendship - (delta.friendship || 0)) < 30) ctx.say(`You and ${t.name.split(' ')[0]} are friends now.`);
    else if (rel.friendship >= 60 && (rel.friendship - (delta.friendship || 0)) < 60) ctx.say(`You and ${t.name.split(' ')[0]} are close friends now.`);
    else if (rel.friendship <= -40 && (rel.friendship - (delta.friendship || 0)) > -40) ctx.say(`That did it. You and ${t.name.split(' ')[0]} are feuding.`);
    if (rel.romance >= 45 && (rel.romance - (delta.romance || 0)) < 45) ctx.say(`There is something between you and ${t.name.split(' ')[0]} now, and you both know it.`);
  }
  return rel;
}

/* ── TALK VERBS ──────────────────────────────────────────────────────── */
const socialVerb = (def) => registry.register({ ...def, help: { topic: 'people', ...def.help } });

socialVerb({
  name: 'chat', aliases: ['chat with', 'talk with', 'catch up with', 'small talk'],
  help: { usage: 'chat <person>', blurb: 'Pass the time with somebody. Friendship, slowly and surely.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Chat with who?');
    const r = await target(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    await setBusy(ctx.ch, 3, 'talking');
    ctx.need({ company: 8, fun: 2 }); ctx.learn('charm', 2);
    const line = kind === 'citizen' ? react('chat', t) : `You and ${t.name.split(' ')[0]} talk a while about nothing in particular, which is the good kind.`;
    const topic = pick(['the weather', 'the bell being wrong again', 'what Pat put in the pie', 'the ferry schedule', 'who moved into the Patch', 'the freight last night', 'Dez’s new speakers', 'the Salon’s latest victim', 'the price of eggs', 'the strays on Gully Road']);
    await land(ctx, t, 'chat', `You chat with ${t.name.split(' ')[0]} about ${topic}. ${line}`, `${ctx.ch.name} and ${t.name.split(' ')[0]} fall into talking about ${topic}.`, { friendship: kind === 'citizen' ? 4 : 5 });
    return ctx.ok({ kinds: [...ctx.kinds, 'say'] });
  },
});
socialVerb({
  name: 'joke', aliases: ['tell joke', 'tell a joke', 'joke with', 'crack a joke'],
  help: { usage: 'joke <person>', blurb: 'Try a joke on somebody. Funny people land more.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Joke with who?');
    const r = await target(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    const hit = roll(ctx, 0.55, (ctx.life.traitKeys || []).includes('funny') ? 0.15 : 0);
    ctx.need({ fun: hit ? 8 : 2, company: 4 }); ctx.learn('charm', hit ? 3 : 1);
    const line = kind === 'citizen' ? react(hit ? 'joke_hit' : 'joke_miss', t) : (hit ? `${t.name.split(' ')[0]} laughs — a real one.` : `${t.name.split(' ')[0]} gives you a courtesy laugh. You both hear it.`);
    await land(ctx, t, 'joke', `You tell ${t.name.split(' ')[0]} a joke. ${line}`, hit ? `${ctx.ch.name} tells a joke and ${t.name.split(' ')[0]} actually laughs.` : `${ctx.ch.name} tells a joke. It goes by.`, { friendship: hit ? 5 : -1 });
    return ctx.ok({ kinds: [...ctx.kinds, hit ? 'social.laugh' : 'emote'] });
  },
});
socialVerb({
  name: 'compliment', aliases: ['praise', 'flatter'],
  help: { usage: 'compliment <person>', blurb: 'Say something nice. Sincere lands; oily does not.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Compliment who?');
    const r = await target(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    const rel = await getRel(ctx.userId, t.userId);
    const recentSame = (rel.recent || []).slice(-2).filter((k) => k === 'compliment').length;
    const hit = recentSame < 2 && roll(ctx, 0.65);
    ctx.need({ company: 4 }); ctx.learn('charm', hit ? 2 : 1);
    const line = kind === 'citizen' ? react(hit ? 'compliment_hit' : 'compliment_miss', t) : (hit ? `${t.name.split(' ')[0]} takes it well.` : `${t.name.split(' ')[0]} has heard enough of those for one day.`);
    await land(ctx, t, 'compliment', `You pay ${t.name.split(' ')[0]} a compliment. ${line}`, `${ctx.ch.name} says something nice to ${t.name.split(' ')[0]}.`, { friendship: hit ? 4 : 0, romance: hit && rel.romance > 0 ? 3 : 0 });
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'flirt', aliases: ['flirt with', 'make eyes at'],
  help: { usage: 'flirt <person>', blurb: 'Test the waters. Romantic souls do it better; nobody is owed a yes.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Flirt with who?');
    const r = await target(ctx, arg, { romance: true, noNpcRomance: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind === 'child') return ctx.fail('No.');
    const rel = await getRel(ctx.userId, t.userId);
    if (rel.flags && rel.flags.family) return ctx.fail(`${t.name.split(' ')[0]} is family. No.`);
    const other = kind === 'player' ? await MooChar.findOne({ userId: t.userId, active: true }).lean() : null;
    if (other && other.attrs && other.attrs.life && other.attrs.life.noFlirt) return ctx.fail(`${t.name.split(' ')[0]} has made it known they are not here for that. Respect it.`);
    /* citizens who are spoken for */
    const taken = await MooRel.findOne({ $or: [{ a: t.userId }, { b: t.userId }], 'flags.partner': true }).lean();
    if (taken && !(taken.a === ctx.userId || taken.b === ctx.userId)) { await land(ctx, t, 'flirt', `${t.name.split(' ')[0]} is spoken for, and says so, kindly.`, null, { friendship: -1 }, { tierNote: false }); return ctx.ok(); }
    const hit = roll(ctx, 0.45, ((ctx.life.traitKeys || []).includes('romantic') ? 0.15 : 0) + (rel.friendship >= 30 ? 0.1 : 0) + (rel.romance >= 20 ? 0.1 : 0));
    ctx.need({ fun: hit ? 10 : 0, company: 4 }); ctx.learn('charm', hit ? 3 : 1);
    const line = kind === 'citizen' ? react(hit ? 'flirt_hit' : 'flirt_miss', t) : (hit ? `${t.name.split(' ')[0]} does not step back.` : `${t.name.split(' ')[0]} lets it go by, gently.`);
    const firstTime = !(rel.recent || []).includes('flirt');
    await land(ctx, t, 'flirt', `You flirt with ${t.name.split(' ')[0]}. ${line}`, `${ctx.ch.name} is flirting with ${t.name.split(' ')[0]}. The room notices.`, { romance: hit ? 8 : 1, friendship: hit ? 2 : -1 }, { tellOther: firstTime ? `${ctx.ch.name} is flirting with you. Flirt back if you like — or "no flirting" tells the whole city you are not here for that.` : null });
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'no flirting', aliases: ['not here for that', 'flirting off', 'flirting on'],
  help: { usage: 'no flirting · flirting on', blurb: 'Make it known you are not here for romance. Nobody can flirt with you.' },
  async run(ctx, { arg }, hit) {
    const on = /flirting on/.test(ctx.lower);
    await setAttrs(ctx.ch, { 'life.noFlirt': !on });
    ctx.life.noFlirt = !on;
    ctx.say(on ? 'Alright — flirting is back on the table.' : 'Understood. The city knows you are not here for that; flirting bounces off you.');
    return ctx.ok();
  },
});
socialVerb({
  name: 'kiss', aliases: ['kiss on the cheek'],
  help: { usage: 'kiss <person>', blurb: 'For people there is something with. Players get to say yes first.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Kiss who?');
    const r = await target(ctx, arg, { romance: true, noNpcRomance: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind === 'child') return ctx.fail('A kiss on the forehead: "kiss <child> goodnight" is the verb you want.');
    const rel = await getRel(ctx.userId, t.userId);
    if (rel.flags && rel.flags.family) return ctx.fail('No.');
    if (kind === 'player') {
      if (rel.romance < 20 && !(rel.flags && (rel.flags.partner || rel.flags.married))) return ctx.fail(`Too soon with ${t.name.split(' ')[0]}. Flirt first; see if it is mutual.`);
      await offer(ctx, t, 'kiss', `${ctx.ch.name} leans in for a kiss. (accept, or decline)`);
      ctx.say(`You lean in toward ${t.name.split(' ')[0]}… and wait to see.`);
      return ctx.ok();
    }
    if (rel.romance < 35) { await land(ctx, t, 'kiss', `${t.name.split(' ')[0]} turns so it lands on the cheek. Not yet.`, `${ctx.ch.name} goes in for a kiss and ${t.name.split(' ')[0]} offers a cheek.`, { romance: -3 }); return ctx.ok(); }
    await land(ctx, t, 'kiss', `You kiss ${t.name.split(' ')[0]}. They kiss you back. The room pretends not to look.`, `${ctx.ch.name} and ${t.name.split(' ')[0]} kiss. The room pretends not to look.`, { romance: 10, friendship: 3 });
    ctx.need({ fun: 15, company: 10 });
    await require('./drama').rumor(ctx, `${ctx.ch.name} and ${t.name.split(' ')[0]} were kissing at ${(await ctx.room()).name.split(' — ')[0]}`, 'love', 3);
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'hug', aliases: ['embrace'],
  help: { usage: 'hug <person>', blurb: 'A hug. Citizens hug back in their own way; players choose.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Hug who?');
    const r = await target(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind === 'player') {
      /* the old engine's touch-as-offer handles players — same 60-second window */
      const old = await require('../engine').runCommand({ userId: ctx.userId, displayName: ctx.ch.name, command: `hug ${t.name}`, isWizard: ctx.isWizard });
      ctx.need({ company: 3 });
      return { ...old, lines: [...ctx.lines, ...(old.lines || []).filter((l) => !/^MEANWHILE/.test(l))] };
    }
    ctx.need({ company: 10, fun: 3 }); ctx.learn('care', 1);
    await land(ctx, t, 'hug', `You hug ${t.name.split(' ')[0]}. ${react('hug', t)}`, `${ctx.ch.name} hugs ${t.name.split(' ')[0]}.`, { friendship: 4 });
    return ctx.ok({ kinds: [...ctx.kinds, 'social.hug'] });
  },
});
socialVerb({
  name: 'comfort', aliases: ['console', 'sit with', 'check on'],
  help: { usage: 'comfort <person>', blurb: 'Be there for somebody having a day.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Comfort who?');
    const r = await target(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    ctx.need({ company: 8 }); ctx.learn('care', 3);
    await setBusy(ctx.ch, 3, 'sitting with somebody');
    await land(ctx, t, 'comfort', `You sit with ${t.name.split(' ')[0]} a while. ${kind === 'citizen' ? react('comfort', t) : 'Whatever it is, it is a little lighter for two.'}`, `${ctx.ch.name} sits with ${t.name.split(' ')[0]} a while.`, { friendship: 6 });
    if (kind === 'player') { const o = await MooChar.findOne({ userId: t.userId, active: true }); if (o && o.attrs && o.attrs.life) { const n = require('./needs'); const nn = n.apply(o.attrs.life.needs || n.fresh(), { company: 10, fun: 3 }); await MooChar.updateOne({ _id: o._id }, { $set: { 'attrs.life.needs': nn } }); } }
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'argue', aliases: ['argue with', 'bicker with', 'fight about'],
  help: { usage: 'argue <person> [about <thing>]', blurb: 'Have it out. Stubborn wins more. Costs friendship either way, a little.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Argue with who?');
    const [who, about] = arg.split(/\s+about\s+/);
    const r = await target(ctx, who, { noKids: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    const win = roll(ctx, 0.5, (ctx.life.traitKeys || []).includes('stubborn') ? 0.2 : 0);
    ctx.need({ fun: win ? 6 : -4, company: 2 }); ctx.learn('charm', 2);
    const topic = about || pick(['the third stool', 'whose turn it was', 'the ferry schedule', 'what the bell means', 'money', 'the right way to do it']);
    await land(ctx, t, 'argue', `You argue with ${t.name.split(' ')[0]} about ${topic}. ${kind === 'citizen' ? react(win ? 'argue_win' : 'argue_lose', t) : (win ? 'You get the last word.' : `${t.name.split(' ')[0]} gets the last word.`)}`, `${ctx.ch.name} and ${t.name.split(' ')[0]} are arguing about ${topic}. Voices up.`, { friendship: -3 });
    return ctx.ok({ kinds: [...ctx.kinds, 'say'] });
  },
});
socialVerb({
  name: 'insult', aliases: ['diss', 'mock'],
  help: { usage: 'insult <person>', blurb: 'Say the mean thing. It costs, and the room remembers.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Insult who?');
    const r = await target(ctx, arg, { noKids: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    ctx.need({ fun: 3, company: -4 });
    const rel = await land(ctx, t, 'insult', `You say the mean thing to ${t.name.split(' ')[0]}. ${kind === 'citizen' ? react('insult', t) : `${t.name.split(' ')[0]} heard every word.`}`, `${ctx.ch.name} says something ugly to ${t.name.split(' ')[0]}. The room goes quiet.`, { friendship: -12, romance: -10 }, { tellOther: `${ctx.ch.name} insults you, out loud, in front of people.` });
    if (rel.friendship <= -40) await require('./drama').rumor(ctx, `${ctx.ch.name} and ${t.name.split(' ')[0]} are feuding`, 'feud', 3);
    return ctx.ok({ kinds: [...ctx.kinds, 'err'] });
  },
});
socialVerb({
  name: 'apologize', aliases: ['apologise', 'say sorry', 'sorry'],
  help: { usage: 'apologize <person>', blurb: 'Mend it. Stubborn souls find this harder.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Apologize to who?');
    const r = await target(ctx, arg.replace(/^to\s+/, '')); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    const rel = await getRel(ctx.userId, t.userId);
    const ok = roll(ctx, rel.friendship < -30 ? 0.35 : 0.7, (ctx.life.traitKeys || []).includes('stubborn') ? -0.15 : 0.05);
    ctx.need({ company: 3 }); ctx.learn('care', 2);
    await land(ctx, t, 'apologize', `You apologize to ${t.name.split(' ')[0]}. ${kind === 'citizen' ? react(ok ? 'apologize_yes' : 'apologize_no', t) : (ok ? `${t.name.split(' ')[0]} hears you.` : `${t.name.split(' ')[0]} is not there yet.`)}`, `${ctx.ch.name} apologizes to ${t.name.split(' ')[0]}.`, { friendship: ok ? 10 : 2 });
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'gift', aliases: ['give gift'],
  help: { usage: 'gift <thing> to <person>', blurb: 'Hand somebody something you bought or made. Flowers say one thing, a watch another.' },
  async run(ctx, { arg }) {
    const m = /^(.+?)\s+to\s+(.+)$/.exec(arg || '');
    if (!m) return ctx.fail('gift <thing> to <person>');
    const it = await findHeld(ctx.userId, m[1]);
    if (!it) return ctx.fail(`You carry nothing called "${m[1]}".`);
    const r = await target(ctx, m[2]); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    const p = it.props || {};
    const romance = p.gift === 'romance' ? 10 : p.ring ? 0 : 0;
    const friendship = p.giftable || p.food ? 8 : p.gift === 'friend' ? 12 : 4;
    if (kind === 'player') await MooItem.updateOne({ _id: it._id }, { $set: { location: { type: 'char', id: t.userId } } });
    else await MooItem.deleteOne({ _id: it._id });
    ctx.need({ company: 6, fun: 4 }); ctx.learn('charm', 2);
    const line = kind === 'citizen' ? react(p.gift === 'romance' ? 'gift_flowers' : 'gift_yes', t, { gift: it.name }) : `${t.name.split(' ')[0]} has it now.`;
    await land(ctx, t, 'gift', `You give ${t.name.split(' ')[0]} ${it.name}. ${line}`, `${ctx.ch.name} gives ${t.name.split(' ')[0]} ${it.name}.`, { friendship, romance }, { tellOther: `${ctx.ch.name} gives you ${it.name}. It is in your pockets.`, sound: 'coin' });
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

/* ── OFFERS (consent) ────────────────────────────────────────────────── */
async function offer(ctx, t, kind, promptLine, extra = {}) {
  await MooChar.updateOne({ userId: t.userId, active: true }, { $set: { 'attrs.life.offer': { from: ctx.userId, fromName: ctx.ch.name, kind, until: Date.now() + 120000, ...extra } } });
  await tell(t.userId, promptLine, 'system', 'knock');
}
socialVerb({
  name: 'accept', aliases: ['yes', 'say yes', 'accept offer'],
  help: { usage: 'accept', blurb: 'Say yes to whatever was just offered: a kiss, a proposal, a fight, a hand.' },
  async run(ctx) {
    const o = ctx.life.offer;
    if (!o || o.until < Date.now()) {
      const old = await require('../engine').runCommand({ userId: ctx.userId, displayName: ctx.ch.name, command: 'accept', isWizard: ctx.isWizard });
      return { ...old, lines: [...ctx.lines, ...(old.lines || []).filter((l) => !/^MEANWHILE/.test(l))] };
    }
    await setAttrs(ctx.ch, { 'life.offer': null }); ctx.life.offer = null;
    const from = await MooChar.findOne({ userId: o.from, active: true }).lean();
    if (!from || from.roomId !== ctx.ch.roomId) return ctx.fail(`${o.fromName} is not here anymore.`);
    const names = { [ctx.userId]: ctx.ch.name, [from.userId]: from.name };
    const me = ctx.ch.name.split(' ')[0], them = from.name.split(' ')[0];
    if (o.kind === 'kiss') {
      await adjust(ctx.userId, from.userId, { romance: 10, friendship: 3 }, { names, kind: 'kiss' });
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} and ${from.name} kiss. The room pretends not to look.`);
      ctx.need({ fun: 15, company: 10 });
      await require('./drama').rumor(ctx, `${from.name} and ${ctx.ch.name} were kissing at ${(await ctx.room()).name.split(' — ')[0]}`, 'love', 3);
      ctx.say(`You kiss ${them} back.`);
      return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
    }
    if (o.kind === 'propose') {
      await adjust(ctx.userId, from.userId, { romance: 15, friendship: 10 }, { names, kind: 'engaged', flags: { partner: true, engaged: true } });
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} says YES. ${from.name} is engaged to ${ctx.ch.name}. Somebody whoops.`, 'cer.fireworks.own');
      await setAttrs(ctx.ch, { 'life.partnerName': from.name, 'life.partner': from.userId });
      await MooChar.updateOne({ _id: from._id }, { $set: { 'attrs.life.partnerName': ctx.ch.name, 'attrs.life.partner': ctx.userId } });
      await require('./drama').rumor(ctx, `${from.name} and ${ctx.ch.name} are engaged`, 'love', 5);
      ctx.need({ fun: 30, company: 20 });
      ctx.say(`You say yes. You and ${them} are engaged. The Courthouse in Bellward marries people any day — "marry ${them}" there when you are both ready.`);
      return ctx.ok({ kinds: [...ctx.kinds, 'cer.fireworks.own'] });
    }
    if (o.kind === 'movein') {
      const housing = require('./housing');
      const home = await housing.myHome(from) || (from.attrs.life && from.attrs.life.home ? await require('./ctx').MooRoom.findOne({ roomId: from.attrs.life.home }).lean() : null);
      if (!home) return ctx.fail(`${them} does not have a place anymore.`);
      await require('./ctx').MooRoom.updateOne({ roomId: home.roomId }, { $addToSet: { 'props.home.tenants': ctx.userId } });
      const listing = housing.listingByKey(home.props.home.listing);
      await setAttrs(ctx.ch, { 'life.home': home.roomId, 'life.homeName': listing ? listing.name : 'home', home: home.roomId });
      ctx.life.home = home.roomId; ctx.life.homeName = listing ? listing.name : 'home';
      await adjust(ctx.userId, from.userId, { friendship: 10 }, { names, kind: 'movein' });
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} is moving in with ${from.name}.`);
      await require('./drama').rumor(ctx, `${ctx.ch.name} moved in with ${from.name}`, 'home', 3);
      ctx.say(`You move in with ${them}. ${listing ? cap(listing.name) : 'Their place'} is home now; "home" takes you there.`);
      return ctx.ok({ kinds: [...ctx.kinds, 'door'] });
    }
    if (o.kind === 'fight') return require('./drama').fightAccepted(ctx, from);
    if (o.kind === 'adopt_pet') return require('./family').adoptPetAccepted(ctx, from, o);
    return ctx.fail('That offer does not make sense anymore.');
  },
});
socialVerb({
  name: 'decline', aliases: ['no thanks', 'refuse', 'step back', 'turn down'],
  help: { usage: 'decline', blurb: 'Let an offer pass. Kindly.' },
  async run(ctx) {
    const o = ctx.life.offer;
    if (!o) return ctx.fail('Nothing is being offered to you right now.');
    await setAttrs(ctx.ch, { 'life.offer': null }); ctx.life.offer = null;
    await tell(o.from, `${ctx.ch.name} lets it pass. ${o.kind === 'propose' ? 'Not a no forever. A not-now.' : ''}`.trim(), 'system');
    if (o.kind === 'propose') await adjust(ctx.userId, o.from, { romance: -5 }, { kind: 'declined' });
    ctx.say(`You let it pass. ${o.fromName} will understand, or won’t.`);
    return ctx.ok();
  },
});

/* ── PROPOSE / MARRY / BREAK UP / MOVE IN ─────────────────────────────── */
socialVerb({
  name: 'propose', aliases: ['propose to', 'ask to marry'],
  help: { usage: 'propose <person>', blurb: 'Ask. You need a ring (Hock’s) and more than a spark.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Propose to who?');
    const r = await target(ctx, arg.replace(/^to\s+/, ''), { romance: true, noNpcRomance: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind === 'child') return ctx.fail('No.');
    const ring = await MooItem.findOne({ 'location.type': 'char', 'location.id': ctx.userId, 'props.ring': true }).lean();
    if (!ring) return ctx.fail('No ring. Hock’s Pawn on Line Street has one, and Hock will not ask.');
    const rel = await getRel(ctx.userId, t.userId);
    if (rel.flags && rel.flags.married) return ctx.fail('You two are already married.');
    if (ctx.life.partner && ctx.life.partner !== t.userId) return ctx.fail(`You are with ${ctx.life.partnerName}. Break up first, if that is where this is going.`);
    if (rel.romance < 60) return ctx.fail(`Not yet. You and ${t.name.split(' ')[0]} are not there — go on some dates (date ${t.name.split(' ')[0]}).`);
    await MooItem.deleteOne({ _id: ring._id });
    if (kind === 'player') {
      await offer(ctx, t, 'propose', `${ctx.ch.name} goes down on one knee, ring out. (accept, or decline)`);
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} goes down on one knee in front of ${t.name}. The room stops.`);
      ctx.say(`You go down on one knee. The ring is out. Now it is ${t.name.split(' ')[0]}’s turn.`);
      return ctx.ok();
    }
    const yes = roll(ctx, 0.6, (rel.romance - 60) / 100);
    if (!yes) { await land(ctx, t, 'propose', `${t.name.split(' ')[0]} takes your hands and says not yet. Not no. Not yet.`, `${ctx.ch.name} proposes to ${t.name} and gets a "not yet."`, { romance: -4 }); await require('./drama').rumor(ctx, `${ctx.ch.name} proposed to ${t.name} and got a not-yet`, 'love', 4); return ctx.ok(); }
    await land(ctx, t, 'propose', `${t.name.split(' ')[0]} says yes. Somebody whoops. You are engaged.`, `${ctx.ch.name} proposes to ${t.name} and ${t.name.split(' ')[0]} says YES.`, { romance: 15, friendship: 10 }, { flags: { partner: true, engaged: true } });
    await setAttrs(ctx.ch, { 'life.partnerName': t.name, 'life.partner': t.userId });
    ctx.life.partnerName = t.name; ctx.life.partner = t.userId;
    await require('./drama').rumor(ctx, `${ctx.ch.name} and ${t.name} are engaged`, 'love', 5);
    ctx.need({ fun: 30, company: 20 });
    ctx.say('The Courthouse in Bellward marries people any day: "marry" there together.');
    return ctx.ok({ kinds: [...ctx.kinds, 'cer.fireworks.own'] });
  },
});
socialVerb({
  name: 'marry', aliases: ['get married', 'wed'],
  help: { usage: 'marry <person>', blurb: 'At the Courthouse, engaged, both present. Honorable Pham does the honors.' },
  async run(ctx, { arg }) {
    const room = await ctx.room();
    if (room.roomId !== 'the_courthouse') return ctx.fail('Weddings happen at the Courthouse on Court Street. Honorable Pham does not travel.');
    const who = arg || ctx.life.partnerName;
    if (!who) return ctx.fail('Marry who?');
    const r = await target(ctx, who); if (r.err) return ctx.fail(r.err);
    const { t } = r;
    const rel = await getRel(ctx.userId, t.userId);
    if (!(rel.flags && rel.flags.engaged)) return ctx.fail(`You and ${t.name.split(' ')[0]} are not engaged. Propose first, with a ring.`);
    if (rel.flags.married) return ctx.fail('Already married. Twice would be showing off.');
    const names = { [ctx.userId]: ctx.ch.name, [t.userId]: t.name };
    await adjust(ctx.userId, t.userId, { romance: 20, friendship: 15 }, { names, kind: 'married', flags: { married: true, engaged: false, partner: true, marriedAt: Date.now() } });
    await MooChar.updateOne({ _id: ctx.ch._id }, { $set: { 'attrs.life.married': true, 'attrs.life.partnerName': t.name, 'attrs.life.partner': t.userId } });
    await MooChar.updateOne({ userId: t.userId, active: true }, { $set: { 'attrs.life.married': true, 'attrs.life.partnerName': ctx.ch.name, 'attrs.life.partner': ctx.userId } });
    await emit(room.roomId, ctx.userId, ctx.ch.name, 'emote', `Honorable Pham looks up from the docket. "Well. Alright then." ${ctx.ch.name} and ${t.name} are married. Pham signs, stamps, and for once smiles.`, 'cer.bell.distant.ward');
    for (const rid of ['bell_court_street', 'pats_diner', 'dezs_bar', 'ruth_anns_stoop']) await emit(rid, null, 'the world', 'system', `Word goes around: ${ctx.ch.name} and ${t.name} just got married at the Courthouse.`, 'cer.bell.distant.ward');
    await require('./drama').rumor(ctx, `${ctx.ch.name} and ${t.name} got married at the Courthouse`, 'love', 6);
    ctx.need({ fun: 40, company: 30 });
    ctx.say(`Honorable Pham signs, stamps, and smiles, which nobody has seen. You and ${t.name.split(' ')[0]} are married. Half the city will know by dinner.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'cer.bell.distant.ward'] });
  },
  buttons: async (ctx) => (await ctx.room()).roomId === 'the_courthouse' && ctx.life.partnerName && !ctx.life.married ? [{ label: `Marry ${ctx.life.partnerName.split(' ')[0]}`, cmd: `marry ${ctx.life.partnerName.split(' ')[0]}`, group: 'here' }] : [],
});
socialVerb({
  name: 'break up', aliases: ['breakup', 'break up with', 'divorce', 'leave partner'],
  help: { usage: 'break up with <person>', blurb: 'End it. It hurts, and the city will talk.' },
  async run(ctx, { arg }) {
    const who = arg.replace(/^with\s+/, '') || ctx.life.partnerName;
    if (!who) return ctx.fail('You are not with anybody.');
    const rels = await relsOf(ctx.userId);
    const rel = rels.find((x) => (x.flags && (x.flags.partner || x.flags.married)) && ((x.names || {})[x.a === ctx.userId ? x.b : x.a] || '').toLowerCase().includes(who.toLowerCase()));
    if (!rel) return ctx.fail(`You are not with anybody called "${who}".`);
    const otherId = rel.a === ctx.userId ? rel.b : rel.a;
    const otherName = (rel.names || {})[otherId] || 'them';
    const wasMarried = rel.flags.married;
    await adjust(ctx.userId, otherId, { romance: -60, friendship: -25 }, { kind: 'breakup', flags: { partner: false, married: false, engaged: false, exes: true } });
    await setAttrs(ctx.ch, { 'life.partnerName': null, 'life.partner': null, 'life.married': false });
    ctx.life.partnerName = null; ctx.life.partner = null;
    await MooChar.updateMany({ userId: otherId }, { $set: { 'attrs.life.partnerName': null, 'attrs.life.partner': null, 'attrs.life.married': false } });
    await tell(otherId, `${ctx.ch.name} ends it with you. ${wasMarried ? 'The papers will come from the Courthouse.' : ''}`.trim(), 'system', 'err');
    /* move out of a shared home if it is theirs */
    if (ctx.life.home) { const home = await require('./ctx').MooRoom.findOne({ roomId: ctx.life.home }).lean(); if (home && home.props.home.owner === otherId) { await require('./ctx').MooRoom.updateOne({ roomId: home.roomId }, { $pull: { 'props.home.tenants': ctx.userId } }); await setAttrs(ctx.ch, { 'life.home': null, 'life.homeName': null, home: null }); ctx.life.home = null; ctx.life.homeName = null; ctx.say('You pack a bag. Their place is not yours anymore; the Kettle keeps a corner.'); } }
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} looks like somebody who just ended something.`);
    await require('./drama').rumor(ctx, `${ctx.ch.name} and ${otherName} ${wasMarried ? 'split up' : 'broke up'}`, 'love', 5);
    ctx.need({ fun: -20, company: -15 });
    ctx.say(`It is over with ${otherName.split(' ')[0]}. You feel it in your chest. The city will have it by morning.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'err'] });
  },
});
socialVerb({
  name: 'move in', aliases: ['move in with', 'ask to move in'],
  help: { usage: 'move in with <person> · move in <person> (invite them)', blurb: 'Share a roof. Invite a partner or close friend into your place, or ask into theirs.' },
  async run(ctx, { arg }) {
    const who = arg.replace(/^with\s+/, '');
    if (!who) return ctx.fail('Move in with who?');
    const r = await target(ctx, who); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind !== 'player') return ctx.fail(`${t.name.split(' ')[0]} has a home and a life already. Citizens do not move in. (Yet.)`);
    const rel = await getRel(ctx.userId, t.userId);
    if (rel.friendship < 50 && !(rel.flags && rel.flags.partner)) return ctx.fail(`You and ${t.name.split(' ')[0]} are not close enough for keys yet.`);
    if (!ctx.life.home) return ctx.fail(`You have no place to offer. Ask ${t.name.split(' ')[0]} to invite you instead — they say "move in ${ctx.ch.name.split(' ')[0]}".`);
    await offer(ctx, t, 'movein', `${ctx.ch.name} asks you to move in with them at ${ctx.life.homeName}. (accept, or decline)`);
    ctx.say(`You ask ${t.name.split(' ')[0]} to move in. Their call.`);
    return ctx.ok();
  },
});
socialVerb({
  name: 'date', aliases: ['ask out', 'take out', 'go on a date with'],
  help: { usage: 'date <person>', blurb: 'A proper date, at a proper spot: Dez’s, the Pier, the Bandshell, Pat’s after dark, the Tea House.' },
  async run(ctx, { arg }) {
    if (!arg) return ctx.fail('Date who?');
    const r = await target(ctx, arg, { romance: true, noNpcRomance: true }); if (r.err) return ctx.fail(r.err);
    const { t, kind } = r;
    if (kind === 'child') return ctx.fail('No.');
    const room = await ctx.room();
    const spots = { dezs_bar: 'a booth at Dez’s with the bass in your ribs', the_pier: 'the end of the Pier with your feet over the water', the_bandshell: 'the Bandshell steps while somebody rehearses', pats_diner: 'the corner booth at Pat’s over pie', gravewalk_teahouse: 'the Tea House, which is a strange choice and a memorable one', the_lake_dock: 'the Lake Dock at dusk', treehouse_row: 'the swings on Treehouse Row, like kids', sweetwater_park: 'a walk through Sweetwater Park' };
    const spot = spots[room.roomId];
    if (!spot) return ctx.fail('Not a date spot. Try Dez’s, the Pier, the Bandshell, Pat’s, the Lake Dock, Sweetwater Park.');
    const rel = await getRel(ctx.userId, t.userId);
    if (rel.romance < 15 && kind === 'citizen') return ctx.fail(`${t.name.split(' ')[0]} likes you fine, but a date? Flirt first; see if it is mutual.`);
    if (coinOf(ctx.ch) < 4) return ctx.fail('A date costs four coin, minimum. Even the Pier. Especially the Pier.');
    await require('./ctx').payCoin(ctx.ch, 4);
    await setBusy(ctx.ch, 10, 'on a date');
    const good = roll(ctx, 0.7, (ctx.life.traitKeys || []).includes('romantic') ? 0.1 : 0);
    ctx.need({ fun: good ? 25 : 8, company: 20, fed: 5 }); ctx.learn('charm', 4);
    await land(ctx, t, 'date', `You and ${t.name.split(' ')[0]} spend the evening at ${spot}. ${good ? 'It goes well. It goes very well.' : 'It is nice. A little quiet. Nice.'}`, `${ctx.ch.name} and ${t.name.split(' ')[0]} are clearly on a date.`, { romance: good ? 14 : 6, friendship: 6 });
    if (good && chance(0.5)) await require('./drama').rumor(ctx, `${ctx.ch.name} and ${t.name.split(' ')[0]} were out together at ${room.name}`, 'love', 2);
    return ctx.ok({ kinds: [...ctx.kinds, 'emote'] });
  },
});
socialVerb({
  name: 'relationships', aliases: ['friends', 'who do i know', 'people i know'], free: true,
  help: { usage: 'relationships', blurb: 'Everybody you have history with, and where you stand.' },
  async run(ctx) {
    const rels = (await relsOf(ctx.userId)).filter((r) => Math.abs(r.friendship) >= 5 || r.romance >= 10 || Object.values(r.flags || {}).some(Boolean));
    if (!rels.length) return ctx.ok({ lines: [...ctx.lines, 'Nobody yet, really. Chat with somebody. Joke. Show up twice.'] });
    const rows = rels.slice(0, 20).map((r) => { const other = r.a === ctx.userId ? r.b : r.a; const nm = (r.names || {})[other] || other.replace(/^npc:/, ''); const rw = romanceWord(r); return `${nm}: ${tierOf(r)}${rw ? ` (${rw})` : ''}`; });
    ctx.say(rows.join('; ') + '.');
    return ctx.ok();
  },
  buttons: () => [{ label: 'My people', cmd: 'relationships', group: 'self' }],
});

module.exports = { getRel, adjust, relsOf, tierOf, describeRel, offer, target, land, react, roll, pairKey, NO_ROMANCE };
