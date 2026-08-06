/**
 * Daily Word (Aug 6 2026 — idea 49 from PLATFORM_IMPROVEMENT_IDEAS, the last
 * unbuilt piece of the daily-games retention pair; Guess the Sound shipped
 * back on July 4). One secret five-letter word per CENTRAL-TIME day, the SAME
 * word for the whole family, six guesses, feedback spoken letter by letter —
 * the whole game is blind-native by construction. Streaks and a family board
 * ride the leaderboard route.
 *
 * Engine truths:
 *  - The word comes from a fixed, pre-shuffled bank indexed by the Central
 *    day number — deterministic forever, no state, same for every player,
 *    no repeat until the bank laps (400 words ≈ 13 months).
 *  - ONE puzzle per user per day is enforced at the DEAL layer (KadeGames
 *    tool + Parlor route) via dailyGate() below — the module itself stays a
 *    pure referee like every other game here.
 *  - The engine holds the answer like Trivia holds its key: view() NEVER
 *    prints it while the game is live, and the host persona never needs it —
 *    the move result carries the letter-by-letter read.
 *  - A guess must be 5 letters but is NOT dictionary-checked: by ear,
 *    "is that a real word" arguments are worse than letting Skylee try
 *    "zzzzz" and learn five cold letters. Guessing costs a row either way.
 */

const BANK = [
  // 368 family-clean, common, say-out-loud-friendly words, validated unique
  // and exactly five letters (build-time script). Order = deal order.
  'porch', 'grain', 'motel', 'shiny', 'crawl', 'bacon', 'fudge', 'swamp', 'tiger', 'plaid',
  'brick', 'onion', 'quilt', 'zesty', 'march', 'vivid', 'sneak', 'dough', 'lemon', 'crisp',
  'bloom', 'given', 'hatch', 'spare', 'toast', 'windy', 'crank', 'jolly', 'pearl', 'squad',
  'lucky', 'trace', 'moose', 'shrug', 'penny', 'blaze', 'growl', 'stump', 'cider', 'flock',
  'novel', 'perch', 'daisy', 'wagon', 'salsa', 'radio', 'chirp', 'bumpy', 'stove', 'creek',
  'amber', 'fetch', 'gumbo', 'ridge', 'plume', 'tulip', 'shore', 'knack', 'bison', 'muddy',
  'olive', 'prank', 'swing', 'vocal', 'dusty', 'eagle', 'frost', 'gravy', 'hinge', 'itchy',
  'jumbo', 'kayak', 'latch', 'mango', 'nurse', 'otter', 'patch', 'quart', 'roast', 'skunk',
  'thorn', 'udder', 'valve', 'whisk', 'yodel', 'zebra', 'apron', 'bluff', 'candy', 'diner',
  'elbow', 'flame', 'goose', 'honey', 'igloo', 'jelly', 'koala', 'lodge', 'maple', 'nacho',
  'ozone', 'piano', 'quick', 'raven', 'syrup', 'tempo', 'unity', 'vinyl', 'waltz', 'yeast',
  'acorn', 'badge', 'cabin', 'dandy', 'ember', 'ferry', 'giddy', 'hound', 'inlet', 'jewel',
  'kneel', 'llama', 'mirth', 'noble', 'oasis', 'plank', 'ranch', 'stool', 'trout', 'usher',
  'verse', 'wharf', 'yacht', 'anvil', 'burro', 'chess', 'derby', 'exact', 'fable', 'gecko',
  'hazel', 'ivory', 'karma', 'lasso', 'mocha', 'nifty', 'orbit', 'pesto', 'query', 'rodeo',
  'scout', 'tango', 'vapor', 'wedge', 'youth', 'attic', 'broom', 'cocoa', 'draft', 'evoke',
  'flint', 'grove', 'husky', 'irony', 'joint', 'kiosk', 'level', 'medal', 'nudge', 'opera',
  'plaza', 'quota', 'shawl', 'trunk', 'ultra', 'vault', 'wrist', 'yearn', 'aloof', 'bagel',
  'comet', 'dodge', 'essay', 'gourd', 'hippo', 'index', 'jazzy', 'knoll', 'lyric', 'mural',
  'ninth', 'ounce', 'polka', 'quill', 'rhyme', 'saucy', 'thump', 'unzip', 'viola', 'wafer',
  'yummy', 'zilch', 'agile', 'bench', 'chili', 'dwell', 'eight', 'first', 'glide', 'haste',
  'inbox', 'jumpy', 'knead', 'lunar', 'motto', 'nomad', 'oxbow', 'pivot', 'quest', 'rally',
  'strut', 'twirl', 'upper', 'woven', 'yield', 'abide', 'brave', 'clash', 'depot', 'flair',
  'gusto', 'humid', 'ideal', 'joker', 'kudos', 'ledge', 'mimic', 'nutty', 'peach', 'quack',
  'rivet', 'spool', 'tease', 'unite', 'vigor', 'whirl', 'award', 'blimp', 'churn', 'elude',
  'fjord', 'gnome', 'hoist', 'imply', 'jaunt', 'knelt', 'loyal', 'mount', 'never', 'onset',
  'pouch', 'quirk', 'roost', 'swoop', 'trend', 'utter', 'vouch', 'wring', 'antsy', 'boast',
  'cliff', 'ditch', 'entry', 'foamy', 'grasp', 'hunch', 'jiffy', 'kazoo', 'limbo', 'meaty',
  'north', 'oaken', 'prowl', 'quake', 'rumor', 'stray', 'tweak', 'unlit', 'vixen', 'wound',
  'ashen', 'blurt', 'crumb', 'dizzy', 'exile', 'fussy', 'gloss', 'hefty', 'inner', 'lofty',
  'mossy', 'niche', 'plush', 'quiet', 'rigid', 'scoot', 'tidal', 'undue', 'wacky', 'amble',
  'brisk', 'chore', 'dozen', 'elder', 'frank', 'grunt', 'hitch', 'icing', 'kudzu', 'leapt',
  'mulch', 'nippy', 'ochre', 'pique', 'slurp', 'verve', 'whoop', 'augur', 'briny', 'clomp',
  'drawl', 'expel', 'gaudy', 'adobe', 'beard', 'cameo', 'dwelt', 'eerie', 'fella', 'genre',
  'haiku', 'islet', 'ladle', 'melon', 'nasal', 'opine', 'lanky', 'quell', 'risen', 'sable',
  'tabby', 'umber', 'venom', 'waist', 'xenon', 'yolks', 'zonal', 'ample', 'banjo', 'civic',
  'diver', 'ethos', 'flute', 'grime', 'hobby', 'joust', 'gully', 'wiser',
];

const meta = {
  key: 'daily_word',
  name: 'Daily Word',
  blurb: 'One secret five-letter word a day for the whole family — six guesses, feedback letter by letter, streaks on the family board.',
  minPlayers: 1,
  maxPlayers: 1,
  dealSounds: ['page_turn'],
  daily: true, // the deal layers key off this: one table per user per Central day
};

// Central-time date key ("2026-08-06") — dependency-free, DST-safe via Intl.
function centralDateKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const EPOCH_KEY = '2026-08-07'; // puzzle #1 — the day this shipped for her
function puzzleNumber(dateKey) {
  const [y1, m1, d1] = EPOCH_KEY.split('-').map(Number);
  const [y2, m2, d2] = dateKey.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000) + 1;
}

function wordForDate(dateKey) {
  const n = puzzleNumber(dateKey) - 1;
  const idx = ((n % BANK.length) + BANK.length) % BANK.length;
  return BANK[idx];
}

function newGame() {
  const dateKey = centralDateKey();
  return {
    g: 'daily_word',
    dateKey,
    puzzle: puzzleNumber(dateKey),
    answer: wordForDate(dateKey),
    guesses: [], // [{ word, marks: ['placed'|'floating'|'cold'] x5 }]
    status: 'active',
    winner: null,
  };
}

// Classic two-pass scoring: exact positions first, then in-word-elsewhere
// with letter-count bookkeeping so a double letter never over-reports.
function scoreGuess(answer, guess) {
  const a = answer.split('');
  const g = guess.split('');
  const marks = Array(5).fill('cold');
  const remaining = {};
  for (let i = 0; i < 5; i++) {
    if (g[i] === a[i]) marks[i] = 'placed';
    else remaining[a[i]] = (remaining[a[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (marks[i] !== 'placed' && remaining[g[i]] > 0) {
      marks[i] = 'floating';
      remaining[g[i]] -= 1;
    }
  }
  return marks;
}

function speakMarks(word, marks) {
  const phrase = { placed: 'right letter, right spot', floating: 'in the word, different spot', cold: 'not in it' };
  return word
    .toUpperCase()
    .split('')
    .map((ch, i) => `${ch} — ${phrase[marks[i]]}`)
    .join('. ');
}

function knownShape(state) {
  const placed = Array(5).fill(null);
  const floating = new Set();
  const cold = new Set();
  for (const g of state.guesses) {
    g.word.split('').forEach((ch, i) => {
      if (g.marks[i] === 'placed') placed[i] = ch;
      else if (g.marks[i] === 'floating') floating.add(ch);
      else cold.add(ch);
    });
  }
  // a letter proven placed or floating is never "cold" even if a double
  // letter's second copy scored cold in some guess
  for (const ch of [...floating]) cold.delete(ch);
  for (const ch of placed) {
    if (!ch) continue;
    cold.delete(ch);
    floating.delete(ch); // placed wins the recap; doubles resolve by ear fine
  }
  return { placed, floating: [...floating].sort(), cold: [...cold].sort() };
}

function legal(state) {
  if (state.status !== 'active') return [];
  return []; // guesses ride the guess_<word> pattern; nothing enumerable
}

function move(state, token) {
  if (state.status !== 'active') {
    return { error: 'Today\'s puzzle is finished. A fresh word lands at midnight Central.' };
  }
  const t = String(token || '').toLowerCase().trim();
  const m = /^guess[_\s]+([a-z][a-z\s_]{0,30})$/.exec(t);
  if (!m) return { error: 'Submit the player\'s word as guess_<word>, like guess_porch.' };
  const guess = m[1].replace(/[\s_]+/g, '');
  if (guess.length !== 5) {
    return { error: `"${guess.toUpperCase()}" is ${guess.length} letters — the daily word is exactly five. This try didn't cost a guess.` };
  }
  const log = [];
  const sounds = ['card_flip'];
  const marks = scoreGuess(state.answer, guess);
  state.guesses.push({ word: guess, marks });
  const placedCount = marks.filter((x) => x === 'placed').length;
  const floatingCount = marks.filter((x) => x === 'floating').length;

  if (guess === state.answer) {
    state.status = 'over';
    state.winner = 'player';
    const n = state.guesses.length;
    log.push(`${guess.toUpperCase()} — that's the word! Solved in ${n} ${n === 1 ? 'guess' : 'guesses'}.`);
    sounds.push('correct_ding', 'win_fanfare');
  } else {
    log.push(`${speakMarks(guess, marks)}.`);
    log.push(`${placedCount} placed, ${floatingCount} floating, guess ${state.guesses.length} of 6.`);
    if (state.guesses.length >= 6) {
      state.status = 'over';
      state.winner = 'The house';
      log.push(`Out of guesses — the word was "${state.answer.toUpperCase()}". Tomorrow's a fresh one.`);
      sounds.push('lose_trombone');
    } else {
      sounds.push(placedCount + floatingCount > 0 ? 'correct_ding' : 'wrong_buzz');
    }
  }
  return { log, sounds };
}

function view(state) {
  const lines = [];
  const over = state.status !== 'active';
  lines.push(`Daily Word puzzle number ${state.puzzle} — ${state.dateKey}, same word for the whole family.`);
  if (!over) {
    lines.push(`Guesses used: ${state.guesses.length} of 6.`);
    const shape = knownShape(state);
    if (state.guesses.length) {
      const placedBits = shape.placed
        .map((ch, i) => (ch ? `letter ${i + 1} is ${ch.toUpperCase()}` : null))
        .filter(Boolean);
      if (placedBits.length) lines.push(`Locked in: ${placedBits.join(', ')}.`);
      if (shape.floating.length) lines.push(`In the word, spot unknown: ${shape.floating.join(', ').toUpperCase()}.`);
      if (shape.cold.length) lines.push(`Cold letters: ${shape.cold.join(', ').toUpperCase()}.`);
      const last = state.guesses[state.guesses.length - 1];
      lines.push(`Last guess ${last.word.toUpperCase()}: ${speakMarks(last.word, last.marks)}.`);
    } else {
      lines.push('No guesses yet — any five-letter word opens the board.');
    }
    lines.push('HOST NOTES: read feedback slowly, letter by letter, and keep the running recap handy. Submit the player\'s word as move guess_<word>. NEVER suggest words, never confirm or deny a letter yourself — the engine\'s feedback is the only truth. One puzzle per person per day; streaks are on the family board.');
  } else {
    const n = state.guesses.length;
    lines.push(
      state.winner === 'player'
        ? `Solved in ${n} ${n === 1 ? 'guess' : 'guesses'}. A fresh word lands at midnight Central.`
        : `Not solved today — the word was "${state.answer.toUpperCase()}". A fresh word lands at midnight Central.`,
    );
  }
  return {
    lines,
    legal: legal(state),
    legalHint: "guess_<word> — the player's five-letter word (e.g. guess_porch)",
    sounds: [],
    over,
    winner: over ? state.winner : null,
  };
}

/**
 * Deal-layer gate, shared by the KadeGames tool and the Parlor /new route:
 * one daily_word table per user per Central day. Also quietly closes stale
 * unfinished tables from prior days (they never count as losses — the
 * leaderboard skips quit-mid-game tables by design).
 * Returns { blocked: false } or { blocked: true, message, doc? }.
 */
async function dailyGate(userId, KadeGameState) {
  const today = centralDateKey();
  const docs = await KadeGameState.find({ user: userId, gameKey: 'daily_word' })
    .sort({ updatedAt: -1 })
    .limit(8);
  for (const d of docs) {
    const dk = d.state && d.state.dateKey;
    if (dk === today) {
      if (d.status === 'active') {
        return {
          blocked: true,
          doc: d,
          message: `Today's Daily Word is already on the table (table ${d.gameId}) — resume it with action='state' or a move. One puzzle a day keeps the streak honest.`,
        };
      }
      const won = d.state && d.state.winner === 'player';
      const n = (d.state && d.state.guesses && d.state.guesses.length) || 0;
      return {
        blocked: true,
        doc: d,
        message: won
          ? `Today's Daily Word is already solved — got it in ${n} ${n === 1 ? 'guess' : 'guesses'}. A fresh word lands at midnight Central; the family board has the streaks.`
          : `Today's Daily Word is already played (didn't fall this time). A fresh word lands at midnight Central.`,
      };
    }
    if (d.status === 'active' && dk && dk !== today) {
      d.status = 'over'; // stale day — close quietly, never a loss
      await d.save();
    }
  }
  return { blocked: false };
}

/**
 * Streak math, pure: dayResults = Map(dateKey -> won:boolean), todayKey =
 * centralDateKey(). Current streak counts consecutive WON days ending today
 * (or yesterday, if today is still unplayed — an unplayed today doesn't
 * break what you built). Best streak scans the whole map.
 */
function computeStreak(dayResults, todayKey) {
  const keyToUtc = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const prevKey = (k) => {
    const t = keyToUtc(k) - 86400000;
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  let current = 0;
  let cursor = dayResults.has(todayKey) ? todayKey : prevKey(todayKey);
  while (dayResults.get(cursor) === true) {
    current += 1;
    cursor = prevKey(cursor);
  }
  let best = 0;
  const wonDays = [...dayResults.entries()].filter(([, w]) => w).map(([k]) => keyToUtc(k)).sort((a, b) => a - b);
  let run = 0;
  for (let i = 0; i < wonDays.length; i++) {
    run = i > 0 && wonDays[i] - wonDays[i - 1] === 86400000 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return { current, best };
}

module.exports = { meta, newGame, view, move, legal, centralDateKey, puzzleNumber, wordForDate, dailyGate, computeStreak, scoreGuess, BANK };
