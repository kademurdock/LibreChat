/**
 * Guess the Sound (July 4 2026 overnight build — the queued quick win that's
 * literally built FROM Kade's own sound pack: the engine plays one of her
 * recorded clips, you guess what it was. Kids will run this into the ground.)
 *
 * The engine holds the answer key like Trivia does. The mystery clip rides
 * the normal [sound:x] pipeline (web chat, conversation mode, AND the phone
 * line all already play those), so the game works on every surface with zero
 * new plumbing. The host is ORDERED never to name the token it carries.
 */

const POOL = [
  ['card_shuffle', 'A deck of cards being shuffled'],
  ['card_deal', 'Cards being dealt around a table'],
  ['card_flip', 'One card flipping over'],
  ['card_draw', 'A card sliding off the deck'],
  ['card_slap', 'A card slapped down on the pile'],
  ['dice_shake', 'Dice rattling in a cup'],
  ['dice_roll', 'Dice tumbling across the table'],
  ['dice_bad', 'A single die wobbling to a stop'],
  ['chip_bet', 'A few poker chips clacking down'],
  ['chip_stack', 'A tall stack of chips being built'],
  ['chip_win', 'A big pile of chips raked in'],
  ['coin_flip', 'A coin flipped and caught'],
  ['bingo_tumble', 'A bingo ball cage spinning'],
  ['bingo_pop', 'A bingo ball popping out'],
  ['battleship_splash', 'A shot splashing into the sea'],
  ['battleship_boom', 'A direct hit — explosion'],
  ['page_turn', 'A page turning'],
  ['drumroll_short', 'A drumroll'],
  ['timer_tick', 'A timer ticking down'],
  ['timer_up', 'A big gong'],
  ['uno_sting', 'A dramatic "one card left!" sting'],
  ['jackpot_win', 'A slot-machine jackpot'],
  ['coin_shower', 'Coins showering down'],
  ['win_fanfare', 'A triumphant victory fanfare'],
  ['lose_trombone', 'A sad trombone'],
  ['draw_game', 'A confused little trumpet'],
];

const meta = {
  key: 'sound_guess',
  name: 'Guess the Sound',
  blurb: 'The table plays one of its own real sound effects — you name it. Three choices, ears only.',
  minPlayers: 1,
  maxPlayers: 4,
  dealSounds: [], // round 1's mystery clip is the only thing that should play
};

const LETTERS = ['a', 'b', 'c'];
const RIVAL_SKILL = 0.6;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newGame(opts = {}) {
  const rivals = Math.max(0, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 0));
  const rounds = Math.max(3, Math.min(10, parseInt(opts.rounds, 10) || 5));
  const deck = shuffle(POOL.slice());
  const qs = [];
  for (let i = 0; i < rounds; i++) {
    const answer = deck[i % deck.length];
    const others = shuffle(POOL.filter((p) => p[0] !== answer[0])).slice(0, 2);
    const options = shuffle([answer, ...others]);
    qs.push({ cue: answer[0], options: options.map((o) => o[1]), correct: options.indexOf(answer) });
  }
  const names = ['You'];
  for (let i = 0; i < rivals; i++) names.push((opts.names || [])[i] || `Rival ${i + 1}`);
  return { g: 'sound_guess', qs, idx: 0, scores: new Array(rivals + 1).fill(0), names, status: 'active', winner: null };
}

function legal(state) {
  if (state.status !== 'active') return [];
  const cur = state.qs[state.idx];
  return cur.options.map((opt, i) => ({ token: `answer_${LETTERS[i]}`, label: `${LETTERS[i].toUpperCase()}: ${opt}` }));
}

function questionLines(state) {
  const cur = state.qs[state.idx];
  const lines = [
    `Round ${state.idx + 1} of ${state.qs.length}: the mystery sound just played. NEVER name or describe the sound token you carried — it IS the answer. If they want it again, use action='state' (it replays).`,
    'The choices:',
  ];
  cur.options.forEach((opt, i) => lines.push(`  ${LETTERS[i].toUpperCase()}: ${opt}`));
  return lines;
}

function finish(state, log) {
  state.status = 'over';
  const max = Math.max(...state.scores);
  const leaders = state.scores.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
  state.winner = leaders.length === 1 ? leaders[0] : 'tie';
  log.push(`Final score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}.`);
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This round of Guess the Sound is over. Start a new one to play again.' };
  const m = /^answer_([a-c])$/.exec(String(token || '').toLowerCase());
  if (!m) return { error: `Answer with one of: ${legal(state).map((x) => x.token).join(', ')}.` };
  const pick = LETTERS.indexOf(m[1]);
  const cur = state.qs[state.idx];
  const log = [];
  const sounds = [];
  if (pick === cur.correct) {
    state.scores[0] += 1;
    sounds.push('correct_ding');
    log.push(`Dead on! It was "${cur.options[cur.correct]}". You're at ${state.scores[0]}.`);
  } else {
    sounds.push('wrong_buzz');
    log.push(`Not this time — it was ${LETTERS[cur.correct].toUpperCase()}: "${cur.options[cur.correct]}".`);
  }
  for (let i = 1; i < state.scores.length; i++) {
    if (Math.random() < RIVAL_SKILL) {
      state.scores[i] += 1;
      log.push(`${state.names[i]} nailed it too (${state.scores[i]}).`);
    } else {
      log.push(`${state.names[i]} guessed wrong (${state.scores[i]}).`);
    }
  }
  state.idx += 1;
  if (state.idx >= state.qs.length) finish(state, log);
  return { sounds, log };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    lines.push(`Game over. Score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')} of ${state.qs.length}.`);
    if (state.winner === 'tie') { winner = 'tie'; lines.push("It's a tie!"); sounds = ['draw_game']; }
    else {
      winner = state.winner === 0 ? 'player' : state.names[state.winner];
      lines.push(state.winner === 0 ? 'Golden ears — you win!' : `${state.names[state.winner]} takes it.`);
      sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone'];
    }
  } else {
    if (state.idx > 0 || state.scores.length > 1) {
      lines.push(`Score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}.`);
    }
    lines.push(...questionLines(state));
    sounds = [state.qs[state.idx].cue]; // the mystery clip itself
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
