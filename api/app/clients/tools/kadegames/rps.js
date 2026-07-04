/**
 * Rock Paper Scissors (July 4 2026 overnight build) — the thirty-second
 * palate cleanser. Best-of series against the house; the engine throws for
 * the house at resolution time (independent random = provably fair, and the
 * agent can't peek because there's nothing to peek at until you've thrown).
 */

const THROWS = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const EMOJI = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };

const meta = {
  key: 'rps',
  name: 'Rock Paper Scissors',
  blurb: 'Best of five against the house. Quick draw — rock, paper, or scissors.',
  minPlayers: 2,
  maxPlayers: 2,
  dealSounds: ['drumroll_short'],
};

function newGame(opts = {}) {
  let bestOf = parseInt(opts.rounds, 10) || 5;
  bestOf = Math.max(3, Math.min(9, bestOf));
  if (bestOf % 2 === 0) bestOf += 1;
  return {
    g: 'rps',
    bestOf,
    need: Math.ceil(bestOf / 2),
    you: 0,
    house: 0,
    history: [], // {p, a, result}
    status: 'active',
    winner: null,
  };
}

function legal(state) {
  if (state.status !== 'active') return [];
  return THROWS.map((t) => ({ token: t, label: `Throw ${EMOJI[t]}` }));
}

const WIN_LINES = [
  'takes the round',
  'snags it',
  'wins that one going away',
  'takes it clean',
];

function move(state, token) {
  if (state.status !== 'active') return { error: 'This match is over. Start a new one to play again.' };
  const p = String(token || '').toLowerCase();
  if (!THROWS.includes(p)) return { error: 'Throw rock, paper, or scissors.' };
  const a = THROWS[Math.floor(Math.random() * 3)];
  const log = [];
  const sounds = ['drumroll_short'];
  let result;
  if (p === a) {
    result = 'tie';
    log.push(`Both threw ${EMOJI[p]} — tie round, throw again.`);
    sounds.push('draw_game');
  } else if (BEATS[p] === a) {
    result = 'you';
    state.you += 1;
    log.push(`${EMOJI[p]} beats ${EMOJI[a]} — you ${WIN_LINES[state.you % WIN_LINES.length]}. ${state.you}-${state.house}.`);
    sounds.push('correct_ding');
  } else {
    result = 'house';
    state.house += 1;
    log.push(`${EMOJI[a]} beats ${EMOJI[p]} — the house ${WIN_LINES[state.house % WIN_LINES.length]}. ${state.you}-${state.house}.`);
    sounds.push('wrong_buzz');
  }
  state.history.push({ p, a, result });
  if (state.you >= state.need || state.house >= state.need) {
    state.status = 'over';
    state.winner = state.you > state.house ? 'player' : 'The house';
    sounds.push(state.winner === 'player' ? 'win_fanfare' : 'lose_trombone');
  }
  return { log, sounds };
}

function view(state) {
  const lines = [`Best of ${state.bestOf} — first to ${state.need}. Score: you ${state.you}, the house ${state.house}.`];
  const over = state.status === 'over';
  let winner = null;
  if (over) {
    winner = state.winner;
    lines.push(state.winner === 'player' ? 'Match to YOU!' : 'The house takes the match.');
  } else {
    lines.push('Rock, paper, or scissors?');
  }
  return { lines, legal: legal(state), sounds: [], over, winner };
}

module.exports = { meta, newGame, view, move, legal };
