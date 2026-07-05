// Trivia Night — engine-refereed quiz. Real questions from the Open Trivia
// Database (free, no key). The ENGINE holds the answer key; the host never
// sees which option is correct until the player commits, so it can't leak or
// fudge. Solo quiz or race AI rivals. On the phone, barge-in IS the buzzer.

const axios = require('axios');

const meta = {
  key: 'trivia',
  name: 'Trivia Night',
  blurb: 'Real quiz questions, A through D. Play solo or race AI rivals — first ear to the buzzer wins.',
  minPlayers: 1,
  maxPlayers: 4,
  dealSounds: ['drumroll_short'],
};

// Friendly topic → Open Trivia DB category id.
const CATEGORIES = {
  general: 9, books: 10, film: 11, movies: 11, music: 12, tv: 14, television: 14,
  video_games: 15, games: 15, science: 17, nature: 17, computers: 18, math: 19,
  sports: 21, geography: 22, history: 23, politics: 24, art: 25, celebrities: 26,
  animals: 27, vehicles: 28, comics: 29, anime: 31, cartoons: 32,
};

// How often an AI rival gets a question right, by difficulty.
const RIVAL_SKILL = { easy: 0.75, medium: 0.55, hard: 0.4 };

const LETTERS = ['a', 'b', 'c', 'd'];

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function newGame(opts = {}) {
  const rivals = Math.max(0, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 0));
  const rounds = Math.max(3, Math.min(15, parseInt(opts.rounds, 10) || 5));
  const difficulty = ['easy', 'medium', 'hard'].includes(String(opts.difficulty || '').toLowerCase())
    ? String(opts.difficulty).toLowerCase()
    : null;
  const catKey = String(opts.category || '').toLowerCase().trim().replace(/\s+/g, '_');
  const category = CATEGORIES[catKey] || null;

  const params = { amount: rounds, type: 'multiple', encode: 'url3986' };
  if (difficulty) params.difficulty = difficulty;
  if (category) params.category = category;

  let data;
  try {
    const r = await axios.get('https://opentdb.com/api.php', { params, timeout: 8000 });
    data = r.data;
  } catch (e) {
    throw new Error('The trivia question service is not answering right now — try again in a few seconds.');
  }
  if (!data || data.response_code !== 0 || !Array.isArray(data.results) || !data.results.length) {
    throw new Error(
      category || difficulty
        ? 'The question bank came up short for that topic/difficulty combo — try a different topic, an easier difficulty, or plain new_game.'
        : 'The trivia question service came up empty — try again in a few seconds.',
    );
  }

  const qs = data.results.map((it) => {
    const options = shuffle([dec(it.correct_answer), ...it.incorrect_answers.map(dec)]);
    return {
      q: dec(it.question),
      cat: dec(it.category),
      diff: it.difficulty,
      options,
      correct: options.indexOf(dec(it.correct_answer)),
    };
  });

  const names = ['You', ...(opts.names || []).slice(0, rivals)];
  while (names.length < rivals + 1) names.push(`Rival ${names.length}`);

  return {
    g: 'trivia',
    qs,
    idx: 0,
    scores: new Array(rivals + 1).fill(0),
    names,
    status: 'active',
    winner: null,
  };
}

function questionLines(state) {
  const cur = state.qs[state.idx];
  const lines = [
    `Question ${state.idx + 1} of ${state.qs.length} (${cur.cat}, ${cur.diff}): ${cur.q}`,
  ];
  cur.options.forEach((opt, i) => lines.push(`${LETTERS[i].toUpperCase()}: ${opt}`));
  return lines;
}

function legal(state) {
  if (state.status !== 'active') return [];
  const cur = state.qs[state.idx];
  return cur.options.map((opt, i) => ({
    token: `answer_${LETTERS[i]}`,
    label: `Answer ${LETTERS[i].toUpperCase()}: ${opt}`,
  }));
}

function finish(state, log) {
  state.status = 'over';
  const max = Math.max(...state.scores);
  const leaders = state.scores.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
  state.winner = leaders.length === 1 ? leaders[0] : 'tie';
  log.push(`Final score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}.`);
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This quiz is over. Start a new one to play again.' };
  const m = /^answer_([a-d])$/.exec(String(token || '').toLowerCase());
  if (!m) return { error: `Answer with one of: ${legal(state).map((x) => x.token).join(', ')}.` };
  const pick = LETTERS.indexOf(m[1]);
  const cur = state.qs[state.idx];
  if (pick >= cur.options.length) return { error: 'That option does not exist on this question.' };

  const log = [];
  const sounds = [];
  const right = pick === cur.correct;
  if (right) {
    state.scores[0] += 1;
    sounds.push('correct_ding');
    log.push(`Correct! ${cur.options[cur.correct]} it is. You're at ${state.scores[0]}.`);
  } else {
    sounds.push('wrong_buzz');
    log.push(`Not quite — the answer was ${LETTERS[cur.correct].toUpperCase()}: ${cur.options[cur.correct]}.`);
  }

  // AI rivals take their swing at the same question (engine decides, by skill).
  const skill = RIVAL_SKILL[cur.diff] ?? 0.55;
  for (let i = 1; i < state.scores.length; i++) {
    if (Math.random() < skill) {
      state.scores[i] += 1;
      log.push(`${state.names[i]} got it right too (${state.scores[i]}).`);
    } else {
      log.push(`${state.names[i]} missed it (${state.scores[i]}).`);
    }
  }

  state.idx += 1;
  if (state.idx >= state.qs.length) {
    finish(state, log);
  }
  return { sounds, log };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    lines.push(`Quiz over. Score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')} out of ${state.qs.length}.`);
    if (state.winner === 'tie') { winner = 'tie'; lines.push("It's a tie!"); sounds = ['draw_game']; }
    else {
      winner = state.winner === 0 ? 'player' : state.names[state.winner];
      lines.push(state.winner === 0 ? 'You take the crown!' : `${state.names[state.winner]} takes it.`);
      sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone'];
    }
  } else {
    if (state.scores.length > 1 || state.idx > 0) {
      lines.push(`Score so far — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}.`);
    }
    lines.push(...questionLines(state));
    lines.push('HOST RULE: You may personally know the correct answer -- do NOT say it, spell it, hint at it, emphasize the right option, or think out loud about it. Read the question and all four options (A through D) in a neutral, even voice, then wait for the player to lock in their letter.');
    lines.push('The engine reveals the correct answer to you only AFTER the player commits (it comes back in the result log) -- that is the ONLY moment you confirm right or wrong. Telegraphing it early ruins the game.');
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
