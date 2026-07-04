/**
 * Fill-In Stories — our Mad-Libs-style game (July 4 2026 overnight build,
 * original templates). The host collects words by ear one at a time, the
 * engine holds the story so nothing spoils, and the reveal lands with a
 * drumroll and a page turn. Pure silly, zero reading required.
 */

const TEMPLATES = [
  {
    title: 'The County Fair Incident',
    slots: ['a name', 'an animal', 'an adjective', 'a food', 'a verb ending in -ing', 'a number', 'a body part', 'an exclamation'],
    text: 'Nobody talks about the year {0} entered a {1} in the county fair. The judges called it "{2}," which everyone knows is fair-speak for trouble. Things were fine until it smelled the deep-fried {3} and started {4} through the midway. It cleared {5} funnel cake stands and stepped on the mayor\'s {6}. All {0} could say was "{7}!" — and that\'s why the fair has a rule with their name on it now.',
  },
  {
    title: 'Grandma’s Secret Recipe',
    slots: ['a name', 'a food', 'a liquid', 'an adjective', 'a kitchen tool', 'a number', 'an animal', 'a place'],
    text: 'Grandma {0} guards her famous {1} recipe with her life. The secret, she finally admitted, is a splash of {2} and stirring it with a {4} until it looks "{3}." She lets it sit for {5} hours, and if the {6} starts sniffing around the kitchen, it\'s ready. Folks drive here all the way from {7} for a plate, and she still won\'t write it down.',
  },
  {
    title: 'The Fishing Trip',
    slots: ['a name', 'an adjective', 'a thing you\'d find in a garage', 'an animal', 'a verb ending in -ing', 'a number', 'a song title or made-up song', 'a body of water'],
    text: '{0} swore this was the year they\'d catch Old Whiskers, the most {1} catfish in {7}. Armed with nothing but a {2} and pure stubbornness, they rowed out at dawn. By noon, a {3} had stolen the bait and the boat was slowly {4}. {0} waited {5} more hours, singing "{6}" to pass the time. Old Whiskers is still out there — and honestly, he\'s earned it.',
  },
  {
    title: 'The Church Potluck',
    slots: ['a name', 'a food', 'an adjective', 'a number', 'another name', 'a verb ending in -ed', 'a household object', 'an exclamation'],
    text: 'The flyer said "bring a dish to share," so {0} brought {1} — the {2} kind. It sat next to {4}\'s casserole for {3} minutes before somebody finally tried it, {5} loudly, and had to be fanned with a {6}. The pastor just said "{7}" and blessed the whole table twice. There\'s a sign-up sheet now.',
  },
  {
    title: 'Tornado Weather',
    slots: ['a name', 'a piece of furniture', 'an adjective', 'an animal', 'a food', 'a number', 'a verb ending in -ing', 'a made-up town name'],
    text: 'When the sirens went off, {0} grabbed the {1} and headed for the cellar — priorities being what they are. The radio said the storm was "{2}" and headed straight for {7}. Down in the dark, the {3} kept trying to eat the emergency {4}. They stayed put {5} minutes past the all-clear, {6} the whole time, just to be sure. The {1} made it through fine.',
  },
  {
    title: 'The Yard Sale',
    slots: ['a name', 'an adjective', 'a thing in an attic', 'an amount of money', 'another name', 'an animal', 'a verb ending in -ing', 'a place'],
    text: 'Every spring, {0} drags out the card tables for the world\'s most {1} yard sale. This year\'s crown jewel: a {2}, priced firmly at {3}. {4} haggled for an hour while a {5} sat in the free box, {6} at customers. By sundown nothing had sold, so it all went back to {7} — same as last year, same as next year.',
  },
  {
    title: 'First Day at the New Job',
    slots: ['a name', 'a job', 'an adjective', 'an office object', 'a number', 'a verb ending in -ing', 'a food', 'an exclamation'],
    text: 'On day one as the new {1}, {0} was told the rules were simple: look {2}, never touch the {3}, and lunch is exactly {4} minutes. By ten o\'clock they were {5} in the supply closet with a {6}. The boss opened the door, paused, and said "{7}." {0} got promoted by Friday — that\'s just how this town works.',
  },
  {
    title: 'The Haunted Gas Station',
    slots: ['a name', 'an adjective', 'a snack', 'a number', 'a sound', 'a piece of clothing', 'a verb ending in -ing', 'a made-up name for a ghost'],
    text: 'Everybody knows pump 3 at the old gas station is {1}. {0} stopped there at midnight anyway, craving a {2}. The lights flickered {3} times, something went "{4}" behind the ice machine, and a {5} floated past the beef jerky. {0} just kept {6} and paid cash. The clerk nodded: "That\'s just {7}. He\'s harmless. Mostly."',
  },
];

const SURPRISE = {
  default: ['a rubber chicken', 'the mayor', 'forty-two', 'a kazoo', 'pickled eggs', 'wiggling', 'sparkly', 'the courthouse', 'yeehaw'],
};

const meta = {
  key: 'madlibs',
  name: 'Fill-In Stories',
  blurb: 'Give the host a noun here, a verb there — then hear the whole ridiculous story read back. Original stories, endless replays.',
  minPlayers: 1,
  maxPlayers: 1,
  dealSounds: ['page_turn'],
};

function newGame() {
  const tpl = Math.floor(Math.random() * TEMPLATES.length);
  return {
    g: 'madlibs',
    tpl,
    words: [],
    status: 'active',
    winner: null,
    story: null,
  };
}

function template(state) { return TEMPLATES[state.tpl]; }

function assemble(state) {
  const t = template(state);
  return t.text.replace(/\{(\d+)\}/g, (_, i) => String(state.words[Number(i)] || '...').toUpperCase());
}

function legal(state) {
  if (state.status !== 'active') return [];
  return [{ token: 'surprise_me', label: 'Let the house pick this word (chaos mode)' }];
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This story is told. Start a new game for a different one.' };
  const t = template(state);
  const idx = state.words.length;
  const raw = String(token || '').toLowerCase().trim();
  let word = null;
  if (raw === 'surprise_me') {
    const pool = SURPRISE.default;
    word = pool[Math.floor(Math.random() * pool.length)];
  } else {
    const m = /^word_([a-z0-9][a-z0-9_ '-]{0,28})$/.exec(raw);
    if (!m) return { error: `I need ${t.slots[idx]} — submit it as word_<their word> (spaces as underscores), or surprise_me.` };
    word = m[1].replace(/_+/g, ' ').trim();
    if (!word) return { error: 'That word came through empty — try again.' };
  }
  state.words.push(word);
  const log = [`Got it: "${word}" for ${t.slots[idx]}.`];
  const sounds = ['page_turn'];
  if (state.words.length >= t.slots.length) {
    state.status = 'over';
    state.story = assemble(state);
    log.push('That was the last word — time for the reveal. Read the story below with FULL drama; the filled-in words are in capitals.');
    sounds.push('drumroll_short', 'page_turn');
  }
  return { log, sounds };
}

function view(state) {
  const t = template(state);
  const lines = [];
  const over = state.status === 'over';
  if (over) {
    lines.push(`"${t.title}" — the finished story. Read it aloud with feeling:`);
    lines.push(state.story || assemble(state));
    lines.push('Offer another round — a different story comes up each time.');
  } else {
    const idx = state.words.length;
    lines.push(`Story: "${t.title}" (don't reveal anything else about it). Word ${idx + 1} of ${t.slots.length}.`);
    if (state.words.length) lines.push(`Collected so far: ${state.words.map((w) => `"${w}"`).join(', ')}.`);
    lines.push(`Ask the player for: ${t.slots[idx].toUpperCase()}. Submit their answer as move word_<their word> — or surprise_me lets the house pick.`);
  }
  return {
    lines,
    legal: legal(state),
    legalHint: 'plus word_<the player\'s word> for whatever they give you',
    sounds: [],
    over,
    winner: null,
  };
}

module.exports = { meta, newGame, view, move, legal };
