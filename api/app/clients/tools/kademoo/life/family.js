/* REVERIE LIFE — family (Sep 6 2026).
 *
 * Children come two ways: the Children’s Office in Bellward, where Miss
 * Ottoline Reed keeps a short list and a long memory, or a baby with your
 * partner once there is a crib to put it in. A child is a soul in the city —
 * a MooChar with `kid:` in front of its id — who lives at your place, goes to
 * school on Treehouse Row when old enough, and grows on the real calendar:
 * a baby for a day, a toddler for three, a kid for six, a teen for eight,
 * and then grown, at which point a parent can "claim" them and PLAY them —
 * a fourth character that does not count against the three, because you
 * raised it.
 *
 * Neglect is a nag from Miss Reed and a rumor on Gully Road, never a removal.
 * Pets are the strays, adopted the old way (trust first, then fifteen coin at
 * Opal’s desk) and then "bring"-able: they live at your place and follow you
 * when asked. */
const registry = require('./registry');
const rel = require('./relationships');
const housing = require('./housing');
const {
  MooChar, MooItem, MooRoom, emit, tell, setAttrs, setBusy, matchName, kindOfSoul, coinOf, payCoin, cap, pick, chance, hashStr, daysBetween, worldClock, plural,
} = require('./ctx');

const STAGES = [
  { key: 'baby', until: 1, label: 'a baby', doing: ['asleep in the crib', 'awake and considering yelling', 'chewing on something'] },
  { key: 'toddler', until: 4, label: 'a toddler', doing: ['pulling everything off the low shelf', 'asleep face-down', 'stacking cups', 'following the cat'] },
  { key: 'kid', until: 10, label: 'a kid', doing: ['doing homework badly', 'drawing on something', 'asking why', 'building a fort'] },
  { key: 'teen', until: 18, label: 'a teenager', doing: ['on the phone', 'pretending not to listen', 'eating everything', 'sulking with real skill'] },
  { key: 'grown', until: Infinity, label: 'grown', doing: ['packing a bag, slowly', 'looking at the door and then at you'] },
];
function stageOf(child) {
  const days = daysBetween(child.bornAt || Date.now()) + (child.startDays || 0);
  return STAGES.find((s) => days < s.until) || STAGES[STAGES.length - 1];
}

const FIRST_NAMES = ['June', 'Otis', 'Marisol', 'Theo', 'Nia', 'Calvin', 'Rosalind', 'Dashiell', 'Imani', 'Wendell', 'Pearl', 'Tobias', 'Zora', 'Amos', 'Lupe', 'Silas', 'Odette', 'Reuben', 'Yara', 'Booker', 'Hazel', 'Ezra', 'Delphine', 'Cyrus'];
const BLURBS = ['does not cry so much as announce', 'has already picked a favorite spoon', 'watches the door like somebody is coming', 'laughs at the ceiling fan', 'will not be put down', 'sleeps through anything, including the freight', 'hums to herself', 'has opinions about socks', 'wants to be read the same page eleven times', 'gives everybody a nickname'];

/** Miss Reed’s list for today — three children, deterministic by day so two
 *  players in the same week see the same kids and one of them can be first. */
function reedsList() {
  const c = worldClock();
  const seed = hashStr('reed:' + c.dayKey);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const s = (seed >>> (i * 5)) >>> 0;
    const name = FIRST_NAMES[(s + i * 7) % FIRST_NAMES.length];
    const stageKey = ['baby', 'toddler', 'kid'][(s >>> 3) % 3];
    const startDays = stageKey === 'baby' ? 0 : stageKey === 'toddler' ? 1 : 4;
    const pron = ['she', 'he', 'they'][(s >>> 6) % 3];
    out.push({ key: name.toLowerCase(), name, stageKey, startDays, pronouns: pron, blurb: BLURBS[(s >>> 8) % BLURBS.length] });
  }
  return out;
}

async function homeReady(ctx, stageKey) {
  if (!ctx.life.home) return { ok: false, why: 'You need a place of your own first — "listings".' };
  const need = stageKey === 'baby' || stageKey === 'toddler' ? 'crib' : 'bunk';
  const has = await housing.furnitureHere(ctx.life.home, need);
  if (!has) return { ok: false, why: `Your place needs ${need === 'crib' ? 'a crib' : 'a bunk bed'} first. Hock’s Pawn and the Salvage Yard sell them.` };
  return { ok: true };
}

async function myKids(userId) { return MooChar.find({ userId: /^kid:/, 'attrs.child.parents': userId }).lean(); }

async function makeChild(ctx, { name, stageKey, startDays, pronouns, blurb, parents }) {
  const last = ctx.ch.name.split(' ').slice(1).join(' ') || 'of the City';
  const id = 'kid:' + name.toLowerCase() + '_' + Date.now().toString(36);
  const st = STAGES.find((s) => s.key === stageKey) || STAGES[0];
  const kid = await MooChar.create({
    userId: id, name: `${name} ${last}`, roomId: ctx.life.home, active: true,
    attrs: { alive: true, pronouns, desc: `${name} ${last}, ${st.label}. ${cap(blurb)}.`, child: { parents, bornAt: Date.now() - startDays * 86400000, startDays: 0, fedAt: Date.now(), happy: 70, doing: pick(st.doing), school: false }, aka: name },
  });
  for (const p of parents) await rel.adjust(p, id, { friendship: 60 }, { names: { [p]: p === ctx.userId ? ctx.ch.name : (ctx.life.partnerName || ''), [id]: kid.name }, flags: { family: true } });
  return kid;
}

/* ── THE CHILDREN’S OFFICE ───────────────────────────────────────────── */
registry.register({
  name: 'adopt', aliases: ['adopt child', 'adopt a child', 'ask about adoption'],
  help: { topic: 'family', usage: 'adopt · adopt <name>', blurb: 'At the Children’s Office: see Miss Reed’s list, then take a child home. You need a home with a crib or bunk.' },
  async run(ctx, { arg }) {
    const room = await ctx.room();
    if (room.roomId !== 'childrens_office') {
      /* the strays' adopt lives in the old engine */
      const old = await require('../engine').runCommand({ userId: ctx.userId, displayName: ctx.ch.name, command: `adopt ${arg}`.trim(), isWizard: ctx.isWizard });
      if (old && !old.unknown && !/does not know/.test((old.lines || []).join(' '))) return { ...old, lines: [...ctx.lines, ...(old.lines || []).filter((l) => !/^MEANWHILE/.test(l))] };
      return ctx.fail('Children are adopted at the Children’s Office in the Archive, Bellward. Strays are adopted where they are — approach one first.');
    }
    const list = reedsList();
    const kids = await myKids(ctx.userId);
    if (!arg) {
      ctx.say(`Miss Ottoline Reed closes a folder. "Sit. You want to hear about them or you want to look at a list? Same thing, here." ${kids.length ? `She knows you have ${plural(kids.length, 'child', 'children')} already, and says so approvingly.` : ''}`);
      for (const k of list) ctx.say(`${k.name} — ${STAGES.find((s) => s.key === k.stageKey).label} (${k.pronouns === 'they' ? 'they/them' : k.pronouns === 'she' ? 'she/her' : 'he/him'}); ${k.blurb}.`);
      ctx.say(`"Thirty coin covers the paperwork. A crib for the little ones, a bunk for the bigger. And I will be checking." Say: adopt <name>.`);
      return ctx.ok({ choices: list.map((k) => ({ label: `Adopt ${k.name} (${k.stageKey})`, cmd: `adopt ${k.key}` })) });
    }
    const k = list.find((x) => x.key === arg || x.name.toLowerCase() === arg);
    if (!k) return ctx.fail(`Nobody called "${arg}" on today’s list. "adopt" alone reads it.`);
    if (kids.length >= 4) return ctx.fail('"Four is a house. Five is a program." Miss Reed does not budge.');
    const taken = await MooChar.findOne({ userId: new RegExp('^kid:' + k.key + '_'), 'attrs.child.listDay': worldClock().dayKey }).lean();
    if (taken) return ctx.fail(`${k.name} went home with somebody this morning. Miss Reed is glad and says so.`);
    const ready = await homeReady(ctx, k.stageKey);
    if (!ready.ok) return ctx.fail(`Miss Reed: "Not yet." ${ready.why}`);
    if (coinOf(ctx.ch) < 30) return ctx.fail(`Thirty coin for the paperwork. You carry ${coinOf(ctx.ch)}.`);
    const nd = ctx.life.needs || {};
    if (Object.values(nd).some((v) => v < 15)) return ctx.fail('Miss Reed looks you over. "Go eat something. Sleep. Come back when you are steady. I mean it kindly."');
    await payCoin(ctx.ch, 30);
    const parents = [ctx.userId]; if (ctx.life.partner) parents.push(ctx.life.partner);
    const kid = await makeChild(ctx, { ...k, parents });
    await MooChar.updateOne({ _id: kid._id }, { $set: { 'attrs.child.listDay': worldClock().dayKey } });
    await setBusy(ctx.ch, 8, 'signing papers');
    ctx.need({ fun: 20, company: 20 }); ctx.learn('care', 8);
    await emit(room.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} signs the last page and Miss Reed lets a breath out. ${kid.name} is going home.`);
    await require('./drama').rumor(ctx, `${ctx.ch.name} adopted ${kid.name.split(' ')[0]} from the Children’s Office`, 'family', 4);
    if (ctx.life.partner) await tell(ctx.life.partner, `${ctx.ch.name} just brought ${kid.name} home from the Children’s Office. You are a parent.`, 'system');
    ctx.say(`Miss Reed signs, stamps, and comes around the desk to shake your hand, which she does not do. "${kid.name.split(' ')[0]} ${kid.attrs.child.parents.length > 1 ? 'has two of you now' : 'has you now'}. Go home. Feed them. I will be by." ${kid.name} is at ${ctx.life.homeName}, waiting. "home" takes you there.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'cer.bell.distant.ward'] });
  },
  buttons: async (ctx) => (await ctx.room()).roomId === 'childrens_office' ? [{ label: 'Ask about adoption', cmd: 'adopt', group: 'here' }] : [],
});

registry.register({
  name: 'have baby', aliases: ['have a baby', 'try for a baby', 'start a family'],
  help: { topic: 'family', usage: 'have baby <first name>', blurb: 'With a partner, at home, with a crib. One every few days, which is plenty.' },
  async run(ctx, { argRaw }) {
    if (!ctx.life.partner) return ctx.fail('That takes two. A partner first — see "help family".');
    if (ctx.ch.roomId !== ctx.life.home) return ctx.fail('At home. This is a home thing.');
    const ready = await homeReady(ctx, 'baby');
    if (!ready.ok) return ctx.fail(ready.why);
    const last = ctx.life.lastBaby || 0;
    if (Date.now() - last < 3 * 86400000) return ctx.fail('One at a time. Give it a few days.');
    const partnerHere = await MooChar.findOne({ userId: ctx.life.partner, roomId: ctx.ch.roomId }).lean();
    if (!partnerHere) return ctx.fail(`${ctx.life.partnerName.split(' ')[0]} would want to be here for this.`);
    const name = (argRaw || '').trim().split(' ')[0] || pick(FIRST_NAMES);
    if (!/^[A-Za-z][A-Za-z'’-]{1,19}$/.test(name)) return ctx.fail('A first name, letters only.');
    const pron = pick(['she', 'he']);
    const kid = await makeChild(ctx, { name: cap(name), stageKey: 'baby', startDays: 0, pronouns: pron, blurb: pick(BLURBS), parents: [ctx.userId, ctx.life.partner] });
    await setAttrs(ctx.ch, { 'life.lastBaby': Date.now() }); ctx.life.lastBaby = Date.now();
    await MooChar.updateMany({ userId: ctx.life.partner }, { $set: { 'attrs.life.lastBaby': Date.now() } });
    ctx.need({ fun: 30, company: 30, rested: -20 }); ctx.learn('care', 10);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `There is a baby in the house. ${kid.name}. Everything is different now.`);
    await tell(ctx.life.partner, `${kid.name} is here. You are a parent. Go home.`, 'system', 'cer.bell.distant.ward');
    await require('./drama').rumor(ctx, `${ctx.ch.name} and ${ctx.life.partnerName} have a new baby, ${kid.name.split(' ')[0]}`, 'family', 5);
    ctx.say(`${kid.name} arrives — small, loud, and immediately in charge. ${cap(pron)} ${kid.attrs.child ? '' : ''}is in the crib. Feed, play with, read to, tuck in. Miss Reed will hear, and be pleased.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'cer.bell.distant.ward'] });
  },
});

/* ── LIVING WITH KIDS ────────────────────────────────────────────────── */
async function kidHere(ctx, arg, opts = {}) {
  const here = await MooChar.find({ roomId: ctx.ch.roomId, userId: /^kid:/ }).lean();
  const mine = here.filter((k) => (k.attrs.child.parents || []).includes(ctx.userId));
  const pool = opts.any ? here : mine;
  if (!pool.length) return { err: mine.length || !here.length ? 'No child of yours is here.' : `${here[0].name} is not yours to mind — though you can "play with" or "talk to" any kid.` };
  const k = arg ? matchName(pool, arg) : (pool.length === 1 ? pool[0] : null);
  if (!k) return { err: pool.length > 1 ? `Which one? ${pool.map((p) => p.name.split(' ')[0]).join(' or ')}.` : `No child called "${arg}" here.` };
  return { k, stage: stageOf(k.attrs.child) };
}
async function kidBump(k, delta) {
  const c = k.attrs.child;
  const happy = Math.max(0, Math.min(100, (c.happy || 50) + (delta.happy || 0)));
  const set = { 'attrs.child.happy': happy };
  if (delta.fed) set['attrs.child.fedAt'] = Date.now();
  await MooChar.updateOne({ _id: k._id }, { $set: set });
}

const kidVerb = (def) => registry.register({ ...def, help: { topic: 'family', ...def.help } });
kidVerb({
  name: 'feed', aliases: ['feed child', 'give bottle'],
  help: { usage: 'feed <child>', blurb: 'Feed a kid. Little ones need it most.' },
  async run(ctx, { arg }) {
    const r = await kidHere(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { k, stage } = r;
    await kidBump(k, { happy: 10, fed: true });
    ctx.need({ company: 5, fun: 3 }); ctx.learn('care', 3);
    const lines = { baby: `You feed ${k.name.split(' ')[0]} a bottle. Half of it ends up on you. ${cap(k.attrs.pronouns === 'they' ? 'they fall' : k.attrs.pronouns === 'she' ? 'she falls' : 'he falls')} asleep mid-swallow.`, toddler: `${k.name.split(' ')[0]} eats three bites, feeds two to the floor, and declares it the best meal ever.`, kid: `${k.name.split(' ')[0]} eats standing up, talking the whole time about a kid at school named Boots.`, teen: `${k.name.split(' ')[0]} eats everything in the kitchen and says "thanks" without looking up, which is a lot.`, grown: `${k.name.split(' ')[0]} cooks for YOU, which is when you know.` };
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} feeds ${k.name.split(' ')[0]}.`);
    ctx.say(lines[stage.key]);
    return ctx.ok({ kinds: [...ctx.kinds, 'eat'] });
  },
  buttons: async (ctx) => { const r = await kidHere(ctx, ''); return r.k ? [{ label: `Feed ${r.k.name.split(' ')[0]}`, cmd: `feed ${r.k.name.split(' ')[0]}`, group: 'people' }] : []; },
});
kidVerb({
  name: 'play with', aliases: ['play', 'play with child'],
  help: { usage: 'play with <child>', blurb: 'Play. It is most of the job.' },
  async run(ctx, { arg }) {
    const r = await kidHere(ctx, arg.replace(/^with\s+/, ''), { any: true }); if (r.err) return require('./activities').playGeneric ? require('./activities').playGeneric(ctx, arg) : ctx.fail(r.err);
    const { k, stage } = r;
    await kidBump(k, { happy: 15 });
    await setBusy(ctx.ch, 5, 'playing');
    ctx.need({ fun: 12, company: 8 }); ctx.learn('care', 3);
    const games = { baby: 'peekaboo, which is the funniest thing that has ever happened, eleven times', toddler: 'a game whose rules change every thirty seconds and which you lose', kid: 'a fort, then a war, then a truce with snacks', teen: 'a card game, which they win, and then they actually talk to you for a minute', grown: 'catch, out back, like nothing changed' };
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} and ${k.name.split(' ')[0]} are playing.`);
    ctx.say(`You and ${k.name.split(' ')[0]} play ${games[stage.key]}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'social.laugh'] });
  },
  buttons: async (ctx) => { const r = await kidHere(ctx, '', { any: true }); return r.k ? [{ label: `Play with ${r.k.name.split(' ')[0]}`, cmd: `play with ${r.k.name.split(' ')[0]}`, group: 'people' }] : []; },
});
kidVerb({
  name: 'read to', aliases: ['read to child', 'story'],
  help: { usage: 'read to <child>', blurb: 'A story. Learning for them, care for you.' },
  async run(ctx, { arg }) {
    const r = await kidHere(ctx, arg); if (r.err) return ctx.fail(r.err);
    const { k, stage } = r;
    await kidBump(k, { happy: 10 });
    await MooChar.updateOne({ _id: k._id }, { $inc: { 'attrs.child.books': 1 } });
    ctx.need({ fun: 6, company: 6, rested: 3 }); ctx.learn('care', 2);
    ctx.say(stage.key === 'baby' ? `You read to ${k.name.split(' ')[0]}, who chews the corner of the book with great attention.` : stage.key === 'teen' ? `${k.name.split(' ')[0]} says they are too old for this and then sits down anyway.` : `You read to ${k.name.split(' ')[0]}. The same page, again, please. Again.`);
    return ctx.ok();
  },
});
kidVerb({
  name: 'teach', aliases: ['teach child', 'help with homework'],
  help: { usage: 'teach <child> <thing>', blurb: 'Teach them something you know. Kids and teens only.' },
  async run(ctx, { arg }) {
    const [who, ...rest] = arg.split(' ');
    const r = await kidHere(ctx, who); if (r.err) return ctx.fail(r.err);
    const { k, stage } = r;
    if (stage.key === 'baby' || stage.key === 'toddler') return ctx.fail(`${k.name.split(' ')[0]} is a little young for lessons. Read to them.`);
    const thing = rest.join(' ') || 'something useful';
    await MooChar.updateOne({ _id: k._id }, { $inc: { 'attrs.child.lessons': 1 }, $set: { 'attrs.child.happy': Math.min(100, (k.attrs.child.happy || 50) + 5) } });
    ctx.need({ company: 6 }); ctx.learn('learning', 3);
    ctx.say(`You teach ${k.name.split(' ')[0]} ${thing}. ${stage.key === 'teen' ? 'They already knew, they say. They did not.' : 'They get it on the third try and act like it was the first.'}`);
    return ctx.ok();
  },
});
kidVerb({
  name: 'tuck in', aliases: ['tuck', 'put to bed', 'kiss goodnight', 'goodnight'],
  help: { usage: 'tuck in <child>', blurb: 'Bedtime. Works best with a crib or a bunk.' },
  async run(ctx, { arg }) {
    const r = await kidHere(ctx, arg.replace(/\s+in$/, '').replace(/^in\s+/, '')); if (r.err) return ctx.fail(r.err);
    const { k, stage } = r;
    await kidBump(k, { happy: 8 });
    await MooChar.updateOne({ _id: k._id }, { $set: { 'attrs.child.doing': stage.key === 'teen' ? 'pretending to be asleep' : 'asleep' } });
    ctx.need({ company: 5, fun: 3 }); ctx.learn('care', 2);
    ctx.say(stage.key === 'teen' ? `You say goodnight through the door. A grunt comes back. Love, in translation.` : `You tuck ${k.name.split(' ')[0]} in. One more story. No. One more. Fine. Lights out.`);
    return ctx.ok();
  },
});
kidVerb({
  name: 'bring', aliases: ['bring along', 'take along', 'come with me'],
  help: { usage: 'bring <child or pet>', blurb: 'They come with you when you move. "stay" leaves them.' },
  async run(ctx, { arg }) {
    const here = await MooChar.find({ roomId: ctx.ch.roomId, $or: [{ userId: /^kid:/, 'attrs.child.parents': ctx.userId }, { userId: /^stray:/, 'attrs.owner': ctx.userId }] }).lean();
    const t = arg ? matchName(here, arg, (x) => x.name, (x) => (x.attrs && (x.attrs.aka || x.attrs.givenName)) || '') : (here.length === 1 ? here[0] : null);
    if (!t) return ctx.fail(here.length ? `Bring who? ${here.map((h) => h.name.split(' ')[0]).join(', ')}.` : 'Nobody of yours here to bring.');
    if (t.userId.startsWith('kid:') && stageOf(t.attrs.child).key === 'teen') { if (chance(0.4)) return ctx.fail(`${t.name.split(' ')[0]} says "no" without looking up. Teenagers.`); }
    await MooChar.updateOne({ _id: t._id }, { $set: { 'attrs.followUser': ctx.userId } });
    ctx.say(`${t.name.split(' ')[0]} comes with you. ("stay ${t.name.split(' ')[0]}" to leave them somewhere.)`);
    return ctx.ok();
  },
  buttons: async (ctx) => { const here = await MooChar.find({ roomId: ctx.ch.roomId, 'attrs.followUser': { $ne: ctx.userId }, $or: [{ userId: /^kid:/, 'attrs.child.parents': ctx.userId }, { userId: /^stray:/, 'attrs.owner': ctx.userId }] }).select('name').lean(); return here.slice(0, 3).map((h) => ({ label: `Bring ${h.name.split(' ')[0]}`, cmd: `bring ${h.name.split(' ')[0]}`, group: 'people' })); },
});
kidVerb({
  name: 'stay', aliases: ['leave here', 'wait here'],
  help: { usage: 'stay <child or pet>', blurb: 'They stop following you.' },
  async run(ctx, { arg }) {
    const following = await MooChar.find({ 'attrs.followUser': ctx.userId }).lean();
    const t = arg ? matchName(following, arg) : (following.length === 1 ? following[0] : null);
    if (!t) return ctx.fail(following.length ? `Who stays? ${following.map((f) => f.name.split(' ')[0]).join(', ')}.` : 'Nobody is following you.');
    await MooChar.updateOne({ _id: t._id }, { $set: { 'attrs.followUser': null } });
    ctx.say(`${t.name.split(' ')[0]} stays here.`);
    return ctx.ok();
  },
});
kidVerb({
  name: 'family', aliases: ['my family', 'household', 'kids'], free: true,
  help: { usage: 'family', blurb: 'Your household: partner, children, pets, and how everybody is doing.' },
  async run(ctx) {
    const kids = await myKids(ctx.userId);
    const pets = await MooChar.find({ userId: /^stray:/, 'attrs.owner': ctx.userId }).lean();
    const bits = [];
    if (ctx.life.partnerName) bits.push(`${ctx.life.married ? 'Married to' : 'With'} ${ctx.life.partnerName}.`);
    for (const k of kids) { const st = stageOf(k.attrs.child); const hungryDays = daysBetween(k.attrs.child.fedAt || Date.now()); bits.push(`${k.name}, ${st.label}${st.key === 'grown' ? ' — "claim ' + k.name.split(' ')[0] + '" to play them' : ''}: ${k.attrs.child.happy >= 70 ? 'happy' : k.attrs.child.happy >= 40 ? 'alright' : 'needs you'}${hungryDays >= 1 ? ', hungry' : ''}, ${k.attrs.child.doing || 'about'}.`); }
    for (const p of pets) bits.push(`${p.name} (your ${(require('../strays').STRAY_BY_ID[p.userId.replace(/^stray:/, '')] || {}).species || 'animal'}).`);
    if (!bits.length) return ctx.ok({ lines: [...ctx.lines, 'Just you, so far. "help family" for how that changes.'] });
    ctx.say(bits.join(' '));
    return ctx.ok();
  },
  buttons: (ctx) => ctx.life.partnerName || ctx.life.hasKids ? [{ label: 'Family', cmd: 'family', group: 'self' }] : [],
});
kidVerb({
  name: 'claim', aliases: ['play as'],
  help: { usage: 'claim <grown child>', blurb: 'A child you raised, grown: play them as your own character. Does not count against three.' },
  async run(ctx, { arg }) {
    const kids = await myKids(ctx.userId);
    const k = matchName(kids, arg);
    if (!k) return ctx.fail('Which child? "family" lists them.');
    const st = stageOf(k.attrs.child);
    if (st.key !== 'grown') return ctx.fail(`${k.name.split(' ')[0]} is ${st.label}. Give it time. (The Founder can hurry it.)`);
    const life = { created: true, bornAt: Date.now(), pronouns: k.attrs.pronouns, age: 'young', look: { line: `${k.name}, grown, with your eyes and somebody’s chin.` }, origin: 'raised', originName: ctx.ch.name, traits: ['Raised right', 'Second generation'], traitKeys: ['kind', 'restless'], aspiration: 'a life of their own', aspirationKey: 'peace', needs: require('./needs').fresh(), needsAt: Date.now(), skills: { learning: Math.min(90, (k.attrs.child.books || 0) * 5 + (k.attrs.child.lessons || 0) * 8), care: 10 }, careers: {}, home: ctx.life.home, homeName: ctx.life.homeName, legacyOf: ctx.userId };
    await MooChar.updateMany({ userId: ctx.userId }, { $set: { active: false } });
    await MooChar.updateOne({ _id: k._id }, { $set: { userId: ctx.userId, active: true, 'attrs.life': life, 'attrs.coin': 20, 'attrs.desc': life.look.line, 'attrs.legacy': true }, $unset: { 'attrs.child': 1, 'attrs.followUser': 1 } });
    await rel.adjust(ctx.userId, k.userId, { friendship: 0 }, { flags: { family: true } });
    ctx.say(`You are ${k.name} now — grown, with twenty coin and a house key. Your ${ctx.ch.name.split(' ')[0]} self is still here: "switch ${ctx.ch.name.split(' ')[0]}" goes back.`);
    return { ok: true, lines: ctx.lines, wantRoom: true, kinds: ['enter'] };
  },
});

/* talk to <child> — citizens keep the old engine's talk; kids answer here, players get pointed at chat */
async function talkTarget(ctx) {
  const who = ctx.lower.replace(/^talk(\s+to|\s+with)?\s+/, '').trim();
  if (!who) return null;
  const here = await MooChar.find({ roomId: ctx.ch.roomId, userId: { $ne: ctx.userId } }).lean();
  const t = matchName(here, who);
  return t && (t.userId.startsWith('kid:') || kindOfSoul(t) === 'player') ? t : null;
}
kidVerb({
  name: 'talk', aliases: ['talk to', 'talk with'],
  help: { topic: 'people', usage: 'talk to <person>', blurb: 'Talk to a citizen (they answer in their own words), a kid, or a player.' },
  when: async (ctx) => !!(await talkTarget(ctx)), fallthrough: true,
  async run(ctx) {
    const t = await talkTarget(ctx);
    if (kindOfSoul(t) === 'player') return registry.get('chat').run(ctx, { arg: t.name.split(' ')[0], argRaw: t.name });
    const st = stageOf(t.attrs.child);
    const mine = (t.attrs.child.parents || []).includes(ctx.userId);
    const lines = {
      baby: [`${t.name.split(' ')[0]} grabs your finger and holds on. That is the conversation.`, `${t.name.split(' ')[0]} says "ba." You agree.`],
      toddler: [`${t.name.split(' ')[0]}: "Why?" You answer. "Why?" You answer. "Why?"`, `${t.name.split(' ')[0]} tells you a long story about a duck. There was, you gather, a duck.`],
      kid: [`${t.name.split(' ')[0]}: "Did you know a cat can jump five times its height? Boots said. Boots is wrong a lot but not about this."`, `${t.name.split(' ')[0]} shows you a drawing. It is you. You have four fingers and a huge smile. Fair.`, `${t.name.split(' ')[0]}: "When I grow up I’m going to drive the tram AND the ferry." A plan.`],
      teen: [`${t.name.split(' ')[0]}: "Fine." Then, a full minute later, an actual sentence about something that matters. You do not push.`, `${t.name.split(' ')[0]} asks for coin. Then asks how your day was, which is worth more than the coin.`, `${t.name.split(' ')[0]}: "Everybody at school knows about ${ctx.ch.name.split(' ')[0]}." You are not sure if that is good.`],
      grown: [`${t.name.split(' ')[0]} talks to you like an adult, which is the strangest and best thing that has ever happened.`, `${t.name.split(' ')[0]}: "I found a place. Over in ${pick(['the Hook', 'Millrace', 'Tanglefoot'])}. Don’t make that face."`],
    };
    ctx.need({ company: 8, fun: 4 }); if (mine) ctx.learn('care', 2);
    await kidBump(t, { happy: 6 });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} talks with ${t.name.split(' ')[0]}.`);
    ctx.say(pick(lines[st.key]));
    return ctx.ok({ kinds: [...ctx.kinds, 'say'] });
  },
});

/* ── PETS: adopted strays live at home ───────────────────────────────── */
kidVerb({
  name: 'pets', aliases: ['my pets'], free: true, hidden: true,
  help: { usage: 'pets', blurb: 'Your animals.' },
  async run(ctx) { const pets = await MooChar.find({ userId: /^stray:/, 'attrs.owner': ctx.userId }).lean(); ctx.say(pets.length ? `Yours: ${pets.map((p) => p.name).join(', ')}. "bring <name>" and they come along.` : 'No animals of your own. The strays are out there — approach one, earn its trust, then adopt.'); return ctx.ok(); },
});

/* @age <child> <days> — the Founder hurries time along, for demos and for mercy */
registry.register({
  name: '@age', hidden: true, free: true,
  help: { topic: 'builder', usage: '@age <child> <days>', blurb: 'Advance a child by N real days.' },
  async run(ctx, { arg }) {
    if (!ctx.isWizard) return ctx.fail('Only the Founder hurries time.');
    const m = /^(.+?)\s+(\d+)$/.exec(arg || '');
    if (!m) return ctx.fail('@age <child> <days>');
    const kids = await MooChar.find({ userId: /^kid:/ }).lean();
    const k = matchName(kids, m[1]);
    if (!k) return ctx.fail('No child by that name in the city.');
    await MooChar.updateOne({ _id: k._id }, { $inc: { 'attrs.child.bornAt': -parseInt(m[2], 10) * 86400000 } });
    const fresh = await MooChar.findOne({ _id: k._id }).lean();
    const st = stageOf(fresh.attrs.child);
    await MooChar.updateOne({ _id: k._id }, { $set: { 'attrs.child.stage': st.key, 'attrs.child.doing': pick(st.doing) } });
    ctx.say(`${k.name} is now ${stageOf(fresh.attrs.child).label}.`);
    return ctx.ok();
  },
});

module.exports = { STAGES, stageOf, reedsList, myKids, makeChild };
