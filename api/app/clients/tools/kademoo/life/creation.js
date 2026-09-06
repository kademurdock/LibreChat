/* REVERIE LIFE — being born (Sep 6 2026).
 *
 * The character creation wizard. Nine short questions, every one answerable
 * by a button or a typed word, and none of them a form. It runs INSIDE the
 * command lane — the client sends whatever was tapped or said as a command,
 * and while a soul is unfinished this file gets every command first. The
 * result carries `choices` so a phone shows buttons and a screen reader
 * hears a numbered list; typing the number, the word, or the whole label all
 * work. `back` steps back, `cancel` walks away, `help` explains the step.
 *
 * Origins are the Sims' "household" idea folded into a MUD's "where do I
 * wake up": each one sets your first street, your pockets, and one citizen
 * who already knows your name. */
const registry = require('./registry');
const needs = require('./needs');
const social = require('../social');
const {
  MooChar, MooItem, escapeRe, emit, setAttrs, makeItem, moveTo, cap, joinAnd,
} = require('./ctx');

const PRONOUNS = [
  { key: 'she', label: 'she / her' },
  { key: 'he', label: 'he / him' },
  { key: 'they', label: 'they / them' },
];
const AGES = [
  { key: 'young', label: 'Young — early twenties, everything ahead of you' },
  { key: 'grown', label: 'Grown — thirties or forties, some miles on you' },
  { key: 'seasoned', label: 'Seasoned — fifties or sixties, seen the city change' },
  { key: 'elder', label: 'Elder — seventy and up, and nobody argues with you' },
];
const BUILDS = ['slight', 'average', 'solid', 'big', 'tall and lean', 'short and sturdy'];
const HAIR = ['close-cropped', 'locs', 'braids', 'a fade', 'long and loose', 'a bun', 'curls', 'gray and proud', 'a shaved head', 'under a hat, always'];
const STYLES = ['work boots and denim', 'thrifted and sharp', 'church clothes on a weekday', 'hoodie and headphones', 'a good coat, always', 'sundresses and sneakers', 'coveralls with your name stitched on', 'suit, no tie', 'track jacket and gold chain', 'whatever was clean'];

const ORIGINS = [
  {
    key: 'boat', label: 'Off the boat — you came in on the ferry with one bag',
    room: 'hook_front_street', coin: 15, contact: 'npc:merle', contactName: 'Merle Boggs',
    kit: [{ name: 'a canvas duffel', desc: 'Everything you own, and it is not heavy.' }],
    line: 'The ferry horn is still in your ears when you step onto Front Street. Merle Boggs, a dockhand built like cargo, looks you over and decides you are all right.',
  },
  {
    key: 'agedout', label: 'Aged out — the Children’s Office just handed you your file',
    room: 'bell_court_street', coin: 25, contact: 'npc:reed', contactName: 'Miss Ottoline Reed',
    kit: [{ name: 'a manila file with your name on it', desc: 'Everything the city wrote down about you. Thinner than it should be.' }],
    line: 'Miss Ottoline Reed walks you to the Archive steps herself, hands you your file, and says the thing she says to all of you: "Come back and tell me how it goes. I mean that."',
  },
  {
    key: 'forever', label: 'Been here forever — the Patch raised you and everybody knows it',
    room: 'patch_gully_road', coin: 20, contact: 'npc:ruthann', contactName: 'Ruth-Ann Purvis',
    kit: [{ name: 'a house key on a shoelace', desc: 'It does not open anything anymore. You keep it anyway.' }],
    line: 'Gully Road smells like somebody’s greens and Ruth-Ann Purvis is already waving you over to the stoop. You have never once been a stranger here.',
  },
  {
    key: 'cameback', label: 'Came back — you left for the big city and it did not work out',
    room: 'fairlawn_ave', coin: 40, contact: 'npc:ines', contactName: 'Ines Beaumont',
    kit: [{ name: 'a phone with a cracked screen', desc: 'Nobody from before is going to call. You check anyway.' }],
    line: 'Fairlawn Avenue looks exactly the same, which is the insult. Your folks’ old place has new people in it. Ines Beaumont at the Archive is the only one who ever wrote back.',
  },
  {
    key: 'highway', label: 'Drifted in off the highway — a trucker dropped you at the Truck Stop',
    room: 'the_truck_stop', coin: 12, contact: 'npc:cass', contactName: 'Cass Delaney',
    kit: [{ name: 'a road atlas with a page torn out', desc: 'The torn page was this city. Somebody wanted you to find it.' }],
    line: 'The rig pulls away and leaves you in the Truck Stop lot with the smell of diesel and pancakes. A retired pilot named Cass Delaney buys you a coffee without asking why.',
  },
];

const TRAITS = [
  { key: 'funny', label: 'Funny', blurb: 'jokes land better, and you need more fun to stay level' },
  { key: 'kind', label: 'Kind', blurb: 'care comes easy; strays and kids trust you sooner' },
  { key: 'stubborn', label: 'Stubborn', blurb: 'arguments go your way more; apologies cost you more' },
  { key: 'bookish', label: 'Bookish', blurb: 'the Archive is your second home; learning comes fast' },
  { key: 'handy', label: 'Handy', blurb: 'things you fix stay fixed; the Garages notice' },
  { key: 'restless', label: 'Restless', blurb: 'you walk faster and get bored quicker' },
  { key: 'romantic', label: 'Romantic', blurb: 'flirting works; heartbreak hits harder' },
  { key: 'hustler', label: 'Hustler', blurb: 'deals, dice, and the corner all lean your way' },
  { key: 'homebody', label: 'Homebody', blurb: 'home does more for you; crowds wear you down' },
  { key: 'loud', label: 'Loud', blurb: 'the room hears you; so does Sgt. Vann' },
  { key: 'quiet', label: 'Quiet', blurb: 'people tell you things; company fills slower' },
  { key: 'green', label: 'Green thumb', blurb: 'the plots and the orchard take to you' },
];
const ASPIRATIONS = [
  { key: 'family', label: 'Family — a full house, people who are yours' },
  { key: 'fortune', label: 'Fortune — a house on Fairlawn and a car that starts' },
  { key: 'knowledge', label: 'Knowledge — know this city better than the Archive does' },
  { key: 'popularity', label: 'Popularity — walk into Dez’s and hear your name' },
  { key: 'craft', label: 'Craft — cook, build, or play something people talk about' },
  { key: 'nature', label: 'Nature — the water, the plots, the orchard, the strays' },
  { key: 'hustle', label: 'Hustle — come up from nothing and make them respect it' },
  { key: 'peace', label: 'Peace — a quiet porch, a fed cat, and nobody’s drama' },
];

const STEPS = ['first', 'last', 'pronouns', 'age', 'build', 'hair', 'style', 'origin', 'trait1', 'trait2', 'aspiration', 'confirm'];

function choicesFor(step, data) {
  const num = (arr, f) => arr.map((x, i) => ({ label: `${i + 1}. ${f(x)}`, cmd: String(i + 1) }));
  switch (step) {
    case 'first': return { prompt: 'Welcome to Reverie. Before the city can know you, it needs a name. What is your FIRST name? (Type it, or say it.)', free: true, choices: [] };
    case 'last': return { prompt: `${data.first}. Good. And your FAMILY name? Full names are one to a soul here — a hundred Rubies, one Ruby Boggs.`, free: true, choices: [] };
    case 'pronouns': return { prompt: `${data.first} ${data.last}. How should the city refer to you?`, choices: num(PRONOUNS, (p) => p.label) };
    case 'age': return { prompt: 'How many years have you got on you?', choices: num(AGES, (a) => a.label) };
    case 'build': return { prompt: 'Your build — how you take up a doorway.', choices: num(BUILDS, (b) => b) };
    case 'hair': return { prompt: 'Your hair.', choices: num(HAIR, (h) => h) };
    case 'style': return { prompt: 'What you wear, most days.', choices: [...num(STYLES, (s) => s), { label: `${STYLES.length + 1}. Say it in your own words`, cmd: 'own words' }], free: true };
    case 'origin': return { prompt: 'Now the real question. How did you come to be standing in this city?', choices: num(ORIGINS, (o) => o.label) };
    case 'trait1': return { prompt: 'Two traits make a person. Pick the first.', choices: num(TRAITS, (t) => `${t.label} — ${t.blurb}`) };
    case 'trait2': return { prompt: `${TRAITS.find((t) => t.key === data.trait1).label}. And the second?`, choices: num(TRAITS.filter((t) => t.key !== data.trait1), (t) => `${t.label} — ${t.blurb}`) };
    case 'aspiration': return { prompt: 'Last one. What do you want out of this life, more than anything?', choices: num(ASPIRATIONS, (a) => a.label) };
    case 'confirm': {
      const o = ORIGINS.find((x) => x.key === data.origin);
      const summary = `${data.first} ${data.last} (${PRONOUNS.find((p) => p.key === data.pronouns).label}), ${AGES.find((a) => a.key === data.age).label.split(' — ')[0].toLowerCase()}. ${lookLine(data)} ${TRAITS.find((t) => t.key === data.trait1).label} and ${TRAITS.find((t) => t.key === data.trait2).label.toLowerCase()}. Wants ${ASPIRATIONS.find((a) => a.key === data.aspiration).label.split(' — ')[0].toLowerCase()}. ${o.label.split(' — ')[0]}.`;
      return { prompt: `Here is who you are: ${summary} Ready?`, choices: [{ label: '1. Yes — step into the city', cmd: 'yes' }, { label: '2. Start over', cmd: 'start over' }] };
    }
    default: return { prompt: '', choices: [] };
  }
}

function lookLine(d) {
  const build = d.build || 'average';
  const hair = d.hair || 'hair under a hat';
  const style = d.styleFree || d.style || 'whatever was clean';
  return `${cap(build)} build, ${hair}, dressed in ${style}.`;
}

/** Match a typed/tapped answer against a choice list: number, key, or a label prefix. */
function pickChoice(list, answer, keyOf, labelOf) {
  const a = String(answer || '').trim().toLowerCase().replace(/\.$/, '');
  if (!a) return null;
  const n = parseInt(a, 10);
  if (String(n) === a && n >= 1 && n <= list.length) return list[n - 1];
  return list.find((x) => keyOf(x).toLowerCase() === a)
    || list.find((x) => labelOf(x).toLowerCase() === a)
    || list.find((x) => labelOf(x).toLowerCase().split(' — ')[0].toLowerCase() === a)
    || list.find((x) => labelOf(x).toLowerCase().startsWith(a))
    || list.find((x) => labelOf(x).toLowerCase().includes(a) && a.length >= 4)
    || null;
}

function validName(s) {
  const n = String(s || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 20) return null;
  if (!/^[A-Za-z][A-Za-z'’\-]*$/.test(n)) return null;
  return n.split(/[-'’]/).map((p) => p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p).join(n.includes('-') ? '-' : n.includes('’') ? '’' : "'");
}

/** A character that existed before the Life layer (Kade's own, the family's)
 *  is not a newcomer. Adopt them in place: meters fresh, nothing renamed,
 *  nothing moved, and one line telling them what grew while they were away.
 *  "remake me" re-asks the new questions without touching what they own. */
function isReturning(ch) {
  const a = ch.attrs || {};
  if (a.life && a.life.newcomer) return false;
  const named = /^\S+\s+\S+/.test(ch.name || '') && !/^newcomer /.test(ch.name || '');
  return named && (a.lastMeal || a.desc || a.pose || (a.coin || 0) > 0 || a.pronouns || a.walkStyle || a.home);
}
async function adoptReturning(ctx) {
  const { ch } = ctx;
  const life = { created: true, wiz: null, bornAt: Date.now(), returning: true, pronouns: (ch.attrs && ch.attrs.pronouns) || 'they', age: null, look: { line: (ch.attrs && ch.attrs.desc) || '' }, origin: 'before', traits: [], traitKeys: [], aspiration: null, needs: needs.fresh(), needsAt: Date.now(), skills: {}, careers: {}, home: (ch.attrs && ch.attrs.home) || null };
  await setAttrs(ch, { life });
  ctx.life = life;
  return { ok: true, mode: 'play', lines: [...ctx.lines, `Welcome back, ${ch.name}. The city grew while you were away: you have needs now (status), places for rent (listings), skills, family, the Lanes, the whisper network. Nothing of yours changed. Say "remake me" to answer the new questions — pronouns, age, traits, what you want — and keep everything you own. "help start" for the rest.`], wantRoom: true, kinds: ['enter'] };
}

async function handle(ctx) {
  const { ch, life, cmd, lower } = ctx;
  if (!life.wiz && !life.created && isReturning(ch)) return adoptReturning(ctx);
  if (!life.wiz) {
    life.wiz = { step: 'first', data: {} };
    await setAttrs(ch, { 'life.wiz': life.wiz });
    const c = choicesFor('first', {});
    return { ok: true, mode: 'create', lines: [...ctx.lines, 'A city is being built, and you are about to be somebody in it.', c.prompt], choices: c.choices, freeText: !!c.free, step: 'first' };
  }
  const wiz = life.wiz;
  const data = wiz.data || {};
  const step = wiz.step;
  const respond = (msgLines, nextStep) => {
    const c = choicesFor(nextStep, data);
    return { ok: true, mode: 'create', lines: [...ctx.lines, ...msgLines, c.prompt].filter(Boolean), choices: c.choices, freeText: !!c.free, step: nextStep };
  };
  const save = async (nextStep) => { wiz.step = nextStep; wiz.data = data; await setAttrs(ch, { 'life.wiz': wiz }); };
  const steps = data.remake ? STEPS.filter((s) => !['first', 'last', 'origin'].includes(s)) : STEPS;
  const restart = async () => {
    const kept = data.remake ? { remake: true, first: data.first, last: data.last, origin: data.origin } : {};
    Object.keys(data).forEach((k) => delete data[k]);
    Object.assign(data, kept);
    await save(steps[0]);
    return respond(['Questions started again.'], steps[0]);
  };

  /* a client re-opening the page sends "look" first; a newcomer may type
   * "what" or "status" — none of those is anybody's name. Re-ask instead. */
  if (/^(look|l|what|status|where|who|exits|inventory|inv|i|time|map|hint|menu)$/.test(lower)) return respond([], step);
  /* control words */
  if (lower === 'help' || lower === '?') return respond([HELP[step] || 'Answer with the number, the word, or say the whole thing. "back" goes a step back, "cancel" walks away.'], step);
  if (lower === 'back') {
    const i = steps.indexOf(step);
    if (i <= 0) return respond(['This is the first question.'], step);
    await save(steps[i - 1]);
    return respond(['Back one.'], steps[i - 1]);
  }
  if (lower === 'start over') return restart();
  if (lower === 'cancel' || lower === 'quit') {
    if (data.remake) {
      await setAttrs(ch, { 'life.wiz': null });
      ctx.life.wiz = null;
      return { ok: true, mode: 'play', lines: [...ctx.lines, `You are still ${ch.name}. Your character and everything you own are unchanged.`], wantRoom: true };
    }
    const others = await MooChar.countDocuments({ _id: { $ne: ch._id }, userId: ch.userId, 'attrs.life.created': true });
    if (others > 0) {
      await MooChar.deleteOne({ _id: ch._id });
      const back = await MooChar.findOne({ userId: ch.userId, 'attrs.life.created': true }).sort({ lastActiveAt: -1 });
      if (back) await MooChar.updateOne({ _id: back._id }, { $set: { active: true } });
      return { ok: true, mode: 'play', lines: [...ctx.lines, `Never mind. You are ${back ? back.name : 'yourself'} again.`], wantRoom: true };
    }
    return respond(['You can’t cancel your first self — the city needs somebody to talk to. Answer the question, or "start over".'], step);
  }

  switch (step) {
    case 'first': {
      const n = validName(cmd);
      if (!n) return respond(['A first name is letters only, two to twenty of them. Try again.'], 'first');
      data.first = n; await save('last'); return respond([], 'last');
    }
    case 'last': {
      const n = validName(cmd);
      if (!n) return respond(['A family name is letters only (hyphens and apostrophes are fine). Try again.'], 'last');
      const full = `${data.first} ${n}`;
      const taken = await MooChar.findOne({ _id: { $ne: ch._id }, name: new RegExp('^' + escapeRe(full) + '$', 'i') }).lean();
      if (taken) return respond([`The records office checks the ledger and shakes its head — a ${full} already walks this city. Another family name, or "back" for another first.`], 'last');
      data.last = n; await save('pronouns'); return respond([], 'pronouns');
    }
    case 'pronouns': {
      const p = pickChoice(PRONOUNS, lower, (x) => x.key, (x) => x.label) || (/^her|^she/.test(lower) ? PRONOUNS[0] : /^him|^he/.test(lower) ? PRONOUNS[1] : /^them|^they/.test(lower) ? PRONOUNS[2] : null);
      if (!p) return respond(['Pick one: 1, 2, or 3 — or say she, he, or they.'], 'pronouns');
      data.pronouns = p.key; await save('age'); return respond([], 'age');
    }
    case 'age': {
      const a = pickChoice(AGES, lower, (x) => x.key, (x) => x.label);
      if (!a) return respond(['Pick a number from 1 to 4, or say young, grown, seasoned, or elder.'], 'age');
      data.age = a.key; await save('build'); return respond([], 'build');
    }
    case 'build': {
      const b = pickChoice(BUILDS, lower, (x) => x, (x) => x);
      if (!b) return respond(['Pick a number, or say the words.'], 'build');
      data.build = b; await save('hair'); return respond([], 'hair');
    }
    case 'hair': {
      const h = pickChoice(HAIR, lower, (x) => x, (x) => x);
      if (!h) return respond(['Pick a number, or say the words.'], 'hair');
      data.hair = h; await save('style'); return respond([], 'style');
    }
    case 'style': {
      if (lower === 'own words' || lower === String(STYLES.length + 1)) { data.awaitStyle = true; await save('style'); return { ok: true, mode: 'create', lines: [...ctx.lines, 'Say what you wear, in a sentence.'], choices: [], freeText: true, step: 'style' }; }
      if (data.awaitStyle) { data.styleFree = cmd.slice(0, 120); delete data.awaitStyle; const nxt = data.remake ? 'trait1' : 'origin'; await save(nxt); return respond([], nxt); }
      const s = pickChoice(STYLES, lower, (x) => x, (x) => x);
      const after = data.remake ? 'trait1' : 'origin';
      if (!s) { data.styleFree = cmd.slice(0, 120); await save(after); return respond([], after); }
      data.style = s; await save(after); return respond([], after);
    }
    case 'origin': {
      const o = pickChoice(ORIGINS, lower, (x) => x.key, (x) => x.label);
      if (!o) return respond(['Pick a number from 1 to 5.'], 'origin');
      data.origin = o.key; await save('trait1'); return respond([], 'trait1');
    }
    case 'trait1': {
      const t = pickChoice(TRAITS, lower, (x) => x.key, (x) => x.label);
      if (!t) return respond(['Pick a number from 1 to 12, or say the trait.'], 'trait1');
      data.trait1 = t.key; await save('trait2'); return respond([], 'trait2');
    }
    case 'trait2': {
      const rest = TRAITS.filter((t) => t.key !== data.trait1);
      const t = pickChoice(rest, lower, (x) => x.key, (x) => x.label);
      if (!t) return respond(['Pick a number, or say the trait.'], 'trait2');
      data.trait2 = t.key; await save('aspiration'); return respond([], 'aspiration');
    }
    case 'aspiration': {
      const a = pickChoice(ASPIRATIONS, lower, (x) => x.key, (x) => x.label);
      if (!a) return respond(['Pick a number from 1 to 8.'], 'aspiration');
      data.aspiration = a.key; await save('confirm'); return respond([], 'confirm');
    }
    case 'confirm': {
      if (/^(1|yes|y|ready|go|yeah|yep)\b/.test(lower)) return born(ctx, data);
      if (/^(2|no|start over)/.test(lower)) return restart();
      return respond(['Say yes to step into the city, or "start over".'], 'confirm');
    }
    default:
      await save('first'); return respond([], 'first');
  }
}

const HELP = {
  first: 'Your first name — the one people call across a room. Letters only.',
  last: 'Your family name. Families are real here: two Boggses are kin whether they like it or not.',
  origin: 'Where you start, what is in your pockets, and who already knows you. Nothing is locked by this — you can walk anywhere from anywhere.',
  trait1: 'Traits color how the city treats you and how fast some things come. Two of them.',
  aspiration: 'What the game nudges you toward and cheers when you get there. You can change it later at the Founder’s Office.',
};

/** The soul is finished. Rename, dress, place, and hand over the starter kit. */
async function born(ctx, d) {
  const { ch } = ctx;
  const o = ORIGINS.find((x) => x.key === d.origin);
  const name = `${d.first} ${d.last}`;
  const taken = await MooChar.findOne({ _id: { $ne: ch._id }, name: new RegExp('^' + escapeRe(name) + '$', 'i') }).lean();
  if (taken) { ctx.life.wiz.step = 'last'; await setAttrs(ch, { 'life.wiz': ctx.life.wiz }); return { ok: false, mode: 'create', lines: [...ctx.lines, `Somebody took ${name} while you were deciding. Another family name?`], choices: [], freeText: true, step: 'last' }; }
  const traitKeys = [d.trait1, d.trait2];
  const traits = traitKeys.map((k) => TRAITS.find((t) => t.key === k).label);
  const life = {
    created: true, wiz: null, bornAt: Date.now(),
    pronouns: d.pronouns, age: AGES.find((a) => a.key === d.age).label.split(' — ')[0].toLowerCase(),
    look: { build: d.build, hair: d.hair, style: d.styleFree || d.style, line: lookLine(d) },
    origin: d.origin, originName: o.contactName, traits, traitKeys,
    aspiration: ASPIRATIONS.find((a) => a.key === d.aspiration).label.split(' — ')[0].toLowerCase(), aspirationKey: d.aspiration,
    needs: needs.fresh(), needsAt: Date.now(), skills: {}, careers: {},
  };
  /* trait starts */
  if (traitKeys.includes('bookish')) life.skills.learning = 12;
  if (traitKeys.includes('handy')) life.skills.handy = 12;
  if (traitKeys.includes('green')) life.skills.garden = 12;
  if (traitKeys.includes('hustler')) life.skills.hustle = 12;
  if (traitKeys.includes('funny')) life.skills.charm = 8;
  if (traitKeys.includes('kind')) life.skills.care = 12;

  if (d.remake) {
    /* keep the soul: name, coin, room, pockets, friends. Refresh who they are. */
    const old = ctx.life || {};
    const keptSkills = { ...(old.skills || {}) };
    for (const [key, xp] of Object.entries(life.skills)) keptSkills[key] = Math.max(keptSkills[key] || 0, xp);
    const kept = { needs: old.needs || needs.fresh(), needsAt: old.needsAt || Date.now(), skills: keptSkills, careers: old.careers || {}, home: old.home || null, homeName: old.homeName || null, homeStreet: old.homeStreet || null, partner: old.partner || null, partnerName: old.partnerName || null, married: old.married || false, games: old.games || {}, bornAt: old.bornAt || Date.now() };
    const merged = { ...old, ...life, ...kept, wiz: null, created: true, returning: false };
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.life': merged, 'attrs.pronouns': d.pronouns, 'attrs.desc': life.look.line } });
    ch.attrs = { ...(ch.attrs || {}), life: merged, pronouns: d.pronouns, desc: life.look.line };
    ctx.life = merged;
    return { ok: true, mode: 'play', lines: [...ctx.lines, `That is you, then: ${traits.join(' and ')}, wanting ${life.aspiration}. Everything you owned is still yours.`], wantRoom: true, kinds: ['levelup'] };
  }
  await MooChar.updateOne({ _id: ch._id }, {
    $set: {
      name, active: true,
      'attrs.life': life, 'attrs.pronouns': d.pronouns, 'attrs.coin': o.coin,
      'attrs.desc': life.look.line, 'attrs.lastMeal': Date.now(), 'attrs.lastSleep': Date.now(), 'attrs.alive': true,
    },
  });
  ch.name = name; ch.attrs = { ...(ch.attrs || {}), life, pronouns: d.pronouns, coin: o.coin, desc: life.look.line };
  ctx.life = life;
  for (const k of o.kit) await makeItem({ name: k.name, desc: k.desc, location: { type: 'char', id: ch.userId }, props: { keepsake: true } });
  /* the one who knows your name */
  await require('./relationships').adjust(ch.userId, o.contact, { friendship: 25 }, { names: { [ch.userId]: name, [o.contact]: o.contactName } });
  await moveTo(ch, o.room, null, `${name} arrives in the city for the first time.`, { noFollow: true });
  const lines = [...ctx.lines, `${o.line}`, `You are ${name}. ${traits.join(' and ')}, wanting ${life.aspiration}. ${o.coin} coin in your pocket. The city is yours to walk — tap a direction, or say "what" to hear what you can do right here. "help" any time.`];
  return { ok: true, mode: 'play', lines, wantRoom: true, kinds: ['enter'], born: true };
}

/* remake me — the new questions, for a soul that predates them */
registry.register({
  name: 'remake me', aliases: ['remake', 'redo me', 'answer the questions'],
  help: { topic: 'you', usage: 'remake me', blurb: 'Answer pronouns, age, look, traits and aspiration again. Keeps everything you own.' },
  async run(ctx) {
    const parts = ctx.ch.name.split(' ');
    const wiz = { step: 'pronouns', data: { first: parts[0], last: parts.slice(1).join(' ') || 'of the City', remake: true, origin: ctx.life.origin && ORIGINS.some((o) => o.key === ctx.life.origin) ? ctx.life.origin : 'forever' } };
    ctx.life.wiz = wiz;
    await setAttrs(ctx.ch, { 'life.wiz': wiz });
    const c = choicesFor('pronouns', wiz.data);
    return { ok: true, mode: 'create', lines: [...ctx.lines, 'Same name, new questions. Nothing you own changes.', c.prompt], choices: c.choices, freeText: false, step: 'pronouns' };
  },
});

/* newchar — a second (or third) self, born through the same door. */
registry.register({
  name: 'newchar', aliases: ['new character', 'create character'],
  help: { topic: 'you', usage: 'newchar', blurb: 'Start a new character (three to an account). Switch between them with "switch <name>".' },
  async run(ctx) {
    const count = await MooChar.countDocuments({ userId: ctx.userId });
    if (count >= 3) return ctx.fail('Three characters to an account — identities stay heavy here. A fourth slot is earned, not typed. (The Founder can grant one.)');
    await MooChar.updateMany({ userId: ctx.userId }, { $set: { active: false } });
    const top = await require('./ctx').MooEvent.findOne({}).sort({ seq: -1 }).select('seq').lean();
    await MooChar.create({ userId: ctx.userId, name: `newcomer ${Date.now().toString(36)}`, roomId: 'city_gate', active: true, lastSeenSeq: top ? top.seq : 0, attrs: { alive: true, coin: 0, life: { created: false, wiz: { step: 'first', data: {} } } } });
    const c = choicesFor('first', {});
    return { ok: true, mode: 'create', lines: [...ctx.lines, 'A new self. Same door.', c.prompt], choices: c.choices, freeText: true, step: 'first' };
  },
});

module.exports = { handle, ORIGINS, TRAITS, ASPIRATIONS, PRONOUNS, AGES, STEPS };
