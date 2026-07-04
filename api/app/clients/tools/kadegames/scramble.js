/**
 * Word Scramble (July 4 2026 overnight build). The engine scrambles a word;
 * you unscramble it out loud. Free-text answers ride a guess_<word> token
 * (the legal list can't enumerate the answer — that would print it), so the
 * host is told the exact submit pattern instead. Par is one point a word;
 * hints cost half the point.
 */

const BANK = [
  'possum', 'banjo', 'catfish', 'gravel', 'sunset', 'tornado', 'pumpkin', 'biscuit',
  'lantern', 'thunder', 'fiddle', 'meadow', 'sawmill', 'harvest', 'firefly', 'compass',
  'whistle', 'dumpling', 'porch', 'orchard', 'creek', 'skillet', 'mustang', 'prairie',
  'cricket', 'bonfire', 'holler', 'quilt', 'walnut', 'cider', 'sheriff', 'wagon',
  'sparrow', 'maple', 'canyon', 'roost', 'grits', 'turnip', 'catnip', 'burrow',
];

const meta = {
  key: 'scramble',
  name: 'Word Scramble',
  blurb: 'Unscramble the word by ear — "SPOMUS" ... possum! Beat par across five words.',
  minPlayers: 1,
  maxPlayers: 1,
  dealSounds: ['page_turn'],
};

function shuffleStr(w) {
  for (let tries = 0; tries < 20; tries++) {
    const a = w.split('');
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    const s = a.join('');
    if (s !== w) return s;
  }
  return w.split('').reverse().join('');
}

function pickWords(n) {
  const pool = BANK.slice();
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function newGame(opts = {}) {
  const rounds = Math.max(3, Math.min(10, parseInt(opts.rounds, 10) || 5));
  const words = pickWords(rounds);
  return {
    g: 'scramble',
    words,
    scrambles: words.map(shuffleStr),
    idx: 0,
    score: 0, // 2 per clean solve, 1 after a hint
    hintUsed: false,
    wrongs: 0,
    status: 'active',
    winner: null,
  };
}

function spellOut(s) {
  return s.toUpperCase().split('').join(', ');
}

function advanceWord(state) {
  state.idx += 1;
  state.hintUsed = false;
  state.wrongs = 0;
  if (state.idx >= state.words.length) {
    state.status = 'over';
    // par = one clean point a word ( = rounds); beat par to take the win
    state.winner = state.score >= state.words.length ? 'player' : 'The house';
  }
}

function legal(state) {
  if (state.status !== 'active') return [];
  const out = [];
  if (!state.hintUsed) out.push({ token: 'hint', label: 'Take a hint (first letter — the word then pays 1 instead of 2)' });
  out.push({ token: 'skip', label: 'Skip this word (no points)' });
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This scramble is done. Start a new game for fresh words.' };
  const t = String(token || '').toLowerCase().trim();
  const word = state.words[state.idx];
  const log = [];
  const sounds = [];

  if (t === 'hint') {
    if (state.hintUsed) return { error: 'Hint is already spent on this word.' };
    state.hintUsed = true;
    log.push(`Hint: it starts with ${word[0].toUpperCase()}.`);
    sounds.push('page_turn');
    return { log, sounds };
  }
  if (t === 'skip') {
    log.push(`Skipped — it was "${word.toUpperCase()}".`);
    sounds.push('card_slap');
    advanceWord(state);
    return { log, sounds };
  }
  const m = /^guess_([a-z_ ]{2,24})$/.exec(t);
  if (!m) return { error: 'Submit their word as guess_<word> (like guess_possum), or use hint / skip.' };
  const guess = m[1].replace(/[_\s]+/g, '');
  if (guess === word.replace(/\s+/g, '')) {
    const pts = state.hintUsed ? 1 : 2;
    state.score += pts;
    log.push(`"${word.toUpperCase()}" is RIGHT — ${pts} point${pts > 1 ? 's' : ''}! Score: ${state.score}.`);
    sounds.push('correct_ding');
    advanceWord(state);
    if (state.status === 'over') sounds.push(state.winner === 'player' ? 'win_fanfare' : 'lose_trombone');
  } else {
    state.wrongs += 1;
    sounds.push('wrong_buzz');
    if (state.wrongs >= 3) {
      log.push(`Third strike — it was "${word.toUpperCase()}". Next word.`);
      advanceWord(state);
      if (state.status === 'over') sounds.push(state.winner === 'player' ? 'win_fanfare' : 'lose_trombone');
    } else {
      log.push(`Not "${guess}". ${3 - state.wrongs} tries left on this one.`);
    }
  }
  return { log, sounds };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  if (!over) {
    const scr = state.scrambles[state.idx];
    lines.push(`Word ${state.idx + 1} of ${state.words.length}. The letters: ${spellOut(scr)}.`);
    lines.push(`Read the letters out slowly. Score so far: ${state.score} (par is ${state.words.length}).`);
    lines.push("When the player says their word, submit it as move guess_<their word>. 'hint' buys the first letter, 'skip' moves on.");
  } else {
    lines.push(`Done! Final score ${state.score}, par ${state.words.length}.`);
    lines.push(state.winner === 'player' ? 'Over par — you win!' : 'Under par this time — the house takes it.');
  }
  return {
    lines,
    legal: legal(state),
    legalHint: 'plus guess_<word> for whatever word the player says',
    sounds: [],
    over,
    winner: over ? state.winner : null,
  };
}

module.exports = { meta, newGame, view, move, legal };
