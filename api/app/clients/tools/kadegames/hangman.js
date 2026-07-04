/**
 * Hangman by voice (July 4 2026 overnight build). The engine holds the word
 * (the host genuinely can't spoil it), you call letters. Six misses and the
 * house wins. Categories keep it guessable by ear; every state read spells
 * the word out phonetically-friendly ("B, blank, blank, E").
 */

const WORDS = {
  animals: ['raccoon', 'catfish', 'possum', 'armadillo', 'bullfrog', 'firefly', 'coyote', 'whitetail deer', 'snapping turtle', 'barn owl', 'crawdad', 'copperhead', 'mockingbird', 'largemouth bass', 'wild turkey', 'box turtle', 'red fox', 'tree frog', 'june bug', 'mule'],
  food: ['biscuits and gravy', 'fried okra', 'peach cobbler', 'sweet tea', 'corn dog', 'funnel cake', 'hush puppies', 'apple butter', 'pot roast', 'banana pudding', 'cornbread', 'blackberry jam', 'deviled eggs', 'fried catfish', 'sweet corn', 'chicken and dumplings', 'pecan pie', 'grits', 'coleslaw', 'barbecue ribs'],
  around_the_house: ['screen door', 'porch swing', 'window fan', 'junk drawer', 'clothesline', 'flyswatter', 'rocking chair', 'quilt', 'mason jar', 'wheelbarrow', 'garden hose', 'toolbox', 'lawnmower', 'bird feeder', 'welcome mat', 'storm cellar', 'wind chimes', 'coffee pot', 'recliner', 'flashlight'],
  places: ['gravel road', 'swimming hole', 'county fair', 'bait shop', 'water tower', 'town square', 'feed store', 'campground', 'drive in theater', 'church basement', 'gas station', 'courthouse', 'corn maze', 'state park', 'boat ramp', 'flea market', 'fairgrounds', 'hay field', 'creek bed', 'trailer park'],
  music: ['banjo', 'fiddle', 'harmonica', 'jukebox', 'gospel choir', 'square dance', 'honky tonk', 'washboard', 'steel guitar', 'front porch picking', 'karaoke night', 'marching band', 'church hymn', 'drum solo', 'mixtape', 'boom box', 'record player', 'line dance', 'talent show', 'garage band'],
  games_and_fun: ['horseshoes', 'cornhole', 'checkers', 'dominoes', 'hopscotch', 'hide and seek', 'water balloon', 'trampoline', 'tire swing', 'sparklers', 'scavenger hunt', 'sack race', 'bingo night', 'card table', 'puzzle', 'yo yo', 'jump rope', 'kite', 'skipping stones', 'campfire stories'],
};

const CATEGORY_WORD = {
  animals: 'Critters', food: 'Good Eatin\'', around_the_house: 'Around the House',
  places: 'Places Around Here', music: 'Music & Noise', games_and_fun: 'Games & Fun',
};

const MAX_MISSES = 6;

const meta = {
  key: 'hangman',
  name: 'Hangman',
  blurb: 'The engine picks a secret word, you call letters. Six misses and it wins. Categories keep it fair.',
  minPlayers: 1,
  maxPlayers: 1,
  dealSounds: ['page_turn'],
};

function newGame(opts = {}) {
  const catKey = String(opts.category || '').toLowerCase().trim().replace(/\s+/g, '_');
  const cats = Object.keys(WORDS);
  const cat = WORDS[catKey] ? catKey : cats[Math.floor(Math.random() * cats.length)];
  const list = WORDS[cat];
  const word = list[Math.floor(Math.random() * list.length)];
  return {
    g: 'hangman',
    cat,
    word,
    guessed: [],
    misses: 0,
    status: 'active',
    winner: null,
  };
}

function maskWords(state) {
  // "B, blank, blank, E" per word — reads clean over TTS/phone
  return state.word.split(' ').map((w) =>
    w.split('').map((ch) => (state.guessed.includes(ch) ? ch.toUpperCase() : 'blank')).join(', ')
  ).join('  —  next word —  ');
}

function solved(state) {
  return state.word.replace(/[^a-z]/g, '').split('').every((ch) => state.guessed.includes(ch));
}

function legal(state) {
  if (state.status !== 'active') return [];
  const out = [];
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    if (!state.guessed.includes(ch)) out.push({ token: `guess_${ch}`, label: `Guess the letter ${ch.toUpperCase()}` });
  }
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This word is finished. Start a new game for a fresh one.' };
  const m = /^guess_([a-z])$/.exec(String(token || '').toLowerCase());
  if (!m) return { error: 'Guess one letter at a time, like guess_e.' };
  const ch = m[1];
  if (state.guessed.includes(ch)) return { error: `${ch.toUpperCase()} was already called. Tried so far: ${state.guessed.map((c) => c.toUpperCase()).join(', ')}.` };
  state.guessed.push(ch);
  const log = [];
  const sounds = [];
  const count = state.word.split('').filter((c) => c === ch).length;
  if (count > 0) {
    sounds.push('correct_ding');
    log.push(`${ch.toUpperCase()} is in there${count > 1 ? ` ${count} times` : ''}!`);
    if (solved(state)) {
      state.status = 'over';
      state.winner = 'player';
      log.push(`That's the whole thing — "${state.word.toUpperCase()}"! You beat the gallows.`);
      sounds.push('win_fanfare');
    }
  } else {
    state.misses += 1;
    sounds.push('wrong_buzz');
    const left = MAX_MISSES - state.misses;
    log.push(`No ${ch.toUpperCase()}. ${left === 0 ? 'That was the last miss.' : `${left} ${left === 1 ? 'miss' : 'misses'} left.`}`);
    if (state.misses >= MAX_MISSES) {
      state.status = 'over';
      state.winner = 'The house';
      log.push(`The word was "${state.word.toUpperCase()}". Gallows takes it.`);
      sounds.push('lose_trombone');
    }
  }
  return { log, sounds };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  lines.push(`Category: ${CATEGORY_WORD[state.cat] || state.cat}.`);
  if (!over) {
    const wordCount = state.word.split(' ').length;
    lines.push(`The word${wordCount > 1 ? `s (${wordCount} words)` : ''}: ${maskWords(state)}.`);
    const missed = state.guessed.filter((c) => !state.word.includes(c));
    if (missed.length) lines.push(`Missed letters: ${missed.map((c) => c.toUpperCase()).join(', ')}. ${MAX_MISSES - state.misses} of ${MAX_MISSES} misses left.`);
    lines.push('Call a letter.');
  } else {
    lines.push(state.winner === 'player' ? `Solved: "${state.word.toUpperCase()}".` : `It got away — the word was "${state.word.toUpperCase()}".`);
  }
  return {
    lines,
    legal: legal(state),
    legalHint: 'any letter they call works: guess_<letter>, like guess_e',
    sounds: [],
    over,
    winner: over ? state.winner : null,
  };
}

module.exports = { meta, newGame, view, move, legal };
