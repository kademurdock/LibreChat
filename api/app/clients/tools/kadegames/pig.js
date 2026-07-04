const { houseNames } = require('./deck');
// Pig — press-your-luck dice, engine-refereed. Seat 0 is the human; the rest
// are AI. Roll to build turn points; roll a 1 ("pig!") and the turn's points
// vanish; hold to bank them. First to 100 wins. Perfect on the phone: two
// choices, all sound, zero board.

const meta = {
  key: 'pig',
  name: 'Pig',
  blurb: 'Press-your-luck dice. Roll to build points, hold to bank them — but a 1 wipes the turn. First to 100.',
  minPlayers: 2,
  maxPlayers: 4,
  dealSounds: ['dice_shake'],
};

const TARGET = 100;

function newGame(opts = {}) {
  const rivals = Math.max(1, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 1));
  const n = rivals + 1;
  const names = ['You', ...(opts.names || []).slice(0, rivals)];
  names.push(...houseNames(n - names.length, names));
  while (names.length < n) names.push(`Player ${names.length}`);
  return {
    g: 'pig',
    scores: new Array(n).fill(0),
    names,
    turn: 0,
    turnPoints: 0,
    status: 'active',
    winner: null,
  };
}

function d6() { return 1 + Math.floor(Math.random() * 6); }

function bank(state, seat, log) {
  state.scores[seat] += state.turnPoints;
  log.push(`${state.names[seat]} bank${seat === 0 ? '' : 's'} ${state.turnPoints} — total ${state.scores[seat]}.`);
  state.turnPoints = 0;
  if (state.scores[seat] >= TARGET) {
    state.status = 'over';
    state.winner = seat;
    return true;
  }
  return false;
}

function nextSeat(state) {
  state.turnPoints = 0;
  state.turn = (state.turn + 1) % state.scores.length;
}

// AI strategy: classic hold-at-21, but race for the win when it can end the
// game this turn, and push harder when far behind a leader near the target.
function aiHoldPoint(state, seat) {
  const me = state.scores[seat];
  const best = Math.max(...state.scores.filter((_, i) => i !== seat));
  if (me + state.turnPoints >= TARGET) return 0;             // can win by holding now
  if (best >= TARGET - 15) return Math.max(21, TARGET - me); // desperate: go for it
  return 21;
}

function aiTurn(state, seat, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && guard < 60) {
    guard += 1;
    const need = aiHoldPoint(state, seat);
    if (state.turnPoints > 0 && (state.turnPoints >= need || state.scores[seat] + state.turnPoints >= TARGET)) {
      if (bank(state, seat, log)) return sounds;
      nextSeat(state);
      return sounds;
    }
    const r = d6();
    sounds.push('dice_roll');
    if (r === 1) {
      sounds.push('dice_bad');
      log.push(`${state.names[seat]} rolls a one — pig! ${state.turnPoints} turn points gone.`);
      nextSeat(state);
      return sounds;
    }
    state.turnPoints += r;
    log.push(`${state.names[seat]} rolls a ${r} (${state.turnPoints} this turn).`);
  }
  nextSeat(state);
  return sounds;
}

// Run AI seats until control returns to the human or the game ends.
function drive(state, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && state.turn !== 0 && guard < 20) {
    guard += 1;
    sounds.push(...aiTurn(state, state.turn, log));
  }
  return sounds;
}

function legal(state) {
  if (state.status !== 'active' || state.turn !== 0) return [];
  const out = [{ token: 'roll', label: 'Roll the die' }];
  if (state.turnPoints > 0) {
    out.push({ token: 'hold', label: `Hold — bank your ${state.turnPoints} turn points` });
  }
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'It is not your turn yet.' };
  const log = [];
  let sounds = [];

  if (token === 'roll') {
    const r = d6();
    sounds.push('dice_roll');
    if (r === 1) {
      sounds.push('dice_bad');
      log.push(`You roll a one — pig! Your ${state.turnPoints} turn points are gone.`);
      nextSeat(state);
      sounds = sounds.concat(drive(state, log));
      return { sounds, log };
    }
    state.turnPoints += r;
    log.push(`You roll a ${r} — ${state.turnPoints} points on the table this turn.`);
    return { sounds, log };
  }

  if (token === 'hold') {
    if (state.turnPoints <= 0) return { error: 'Nothing to bank yet — roll first.' };
    sounds.push('chip_stack');
    if (bank(state, 0, log)) return { sounds, log };
    nextSeat(state);
    sounds = sounds.concat(drive(state, log));
    return { sounds, log };
  }

  return { error: `Legal moves: ${legal(state).map((m) => m.token).join(', ')}.` };
}

function view(state) {
  const lines = [];
  lines.push(`Scores — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}. First to ${TARGET} wins.`);
  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    winner = state.winner === 0 ? 'player' : state.names[state.winner];
    lines.push(state.winner === 0
      ? `You win with ${state.scores[0]} points!`
      : `${state.names[state.winner]} wins with ${state.scores[state.winner]} points.`);
    sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone'];
  } else if (state.turn === 0) {
    lines.push(state.turnPoints > 0
      ? `Your turn: ${state.turnPoints} unbanked points riding. Roll again or hold?`
      : 'Your turn: nothing on the table yet. Roll!');
  } else {
    lines.push(`${state.names[state.turn]} is up.`);
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
