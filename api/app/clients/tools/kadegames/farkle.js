/**
 * Farkle (July 4 2026 overnight build — from the GAMES_PLAN dice list).
 * Press-your-luck with real choices: roll six dice, set aside scoring dice,
 * roll the rest — but a roll with NOTHING scoring is a FARKLE and torches
 * the whole turn. House scoring (stated on /help/games): ones 100, fives 50,
 * three-of-a-kind = face x100 (three ones 1000), straight 1-6 = 1500, three
 * pairs = 1500. First to the target (default 4000) wins on the spot.
 * Kept simple on purpose — it plays fast by ear and the engine enforces it.
 */

const meta = {
  key: 'farkle',
  name: 'Farkle',
  blurb: 'Roll six dice, bank the ones that score, push your luck on the rest. Farkle and the turn burns. First to 4000.',
  minPlayers: 2,
  maxPlayers: 4,
  dealSounds: ['dice_shake'],
};

function d6() { return 1 + Math.floor(Math.random() * 6); }
function roll(n) { return Array.from({ length: n }, d6).sort(); }

function counts(dice) {
  const m = {};
  for (const d of dice) m[d] = (m[d] || 0) + 1;
  return m;
}

/* Every distinct take available on this roll, as {token,label,points,dice[]} */
function takesFor(dice) {
  const out = [];
  const m = counts(dice);
  const faces = Object.keys(m).map(Number);
  if (dice.length === 6 && faces.length === 6) {
    out.push({ token: 'keep_straight', label: 'Keep the straight 1-2-3-4-5-6 (+1500)', points: 1500, dice: dice.slice() });
  }
  if (dice.length === 6 && faces.length === 3 && faces.every((f) => m[f] === 2)) {
    out.push({ token: 'keep_threepairs', label: 'Keep three pairs (+1500)', points: 1500, dice: dice.slice() });
  }
  for (const f of faces) {
    if (m[f] >= 3) {
      const pts = f === 1 ? 1000 : f * 100;
      out.push({ token: `keep_${f}${f}${f}`, label: `Keep three ${f}s (+${pts})`, points: pts, dice: [f, f, f] });
    }
  }
  if (m[1] >= 1) out.push({ token: 'keep_1', label: 'Keep one 1 (+100)', points: 100, dice: [1] });
  if (m[5] >= 1) out.push({ token: 'keep_5', label: 'Keep one 5 (+50)', points: 50, dice: [5] });
  return out;
}

function newGame(opts = {}) {
  const rivals = Math.max(1, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 1));
  const target = Math.max(2, Math.min(10, parseInt(opts.rounds, 10) || 4)) * 1000;
  const names = ['You', ...(opts.names || []).slice(0, rivals)];
  const housePlayers = ['Sterling', 'Nana Pearl', 'Duke'];
  while (names.length < rivals + 1) names.push(housePlayers[(names.length - 1) % housePlayers.length]);
  const state = {
    g: 'farkle',
    target,
    names,
    scores: new Array(rivals + 1).fill(0),
    turn: 0,
    dice: [],       // current live roll
    kept: [],       // dice set aside this turn
    turnPoints: 0,
    tookThisRoll: false,
    status: 'active',
    winner: null,
  };
  startTurn(state, null);
  return state;
}

function startTurn(state, log) {
  state.dice = roll(6);
  state.kept = [];
  state.turnPoints = 0;
  state.tookThisRoll = false;
  if (checkFarkle(state, log)) return;
}

function checkFarkle(state, log) {
  if (takesFor(state.dice).length === 0) {
    if (log) log.push(`${state.names[state.turn]} roll${state.turn === 0 ? '' : 's'} ${state.dice.join(', ')} — FARKLE! ${state.turnPoints} turn points up in smoke.`);
    state.farkled = true;
    return true;
  }
  state.farkled = false;
  return false;
}

function applyTake(state, take) {
  // remove the take's dice from the live roll
  for (const d of take.dice) {
    const i = state.dice.indexOf(d);
    state.dice.splice(i, 1);
  }
  state.kept.push(...take.dice);
  state.turnPoints += take.points;
  state.tookThisRoll = true;
}

function endTurn(state, banked, log, sounds) {
  if (banked) {
    state.scores[state.turn] += state.turnPoints;
    log.push(`${state.names[state.turn]} bank${state.turn === 0 ? '' : 's'} ${state.turnPoints} — total ${state.scores[state.turn]}.`);
    sounds.push('chip_stack');
    if (state.scores[state.turn] >= state.target) {
      state.status = 'over';
      state.winner = state.turn;
      sounds.push(state.turn === 0 ? 'win_fanfare' : 'lose_trombone');
      return;
    }
  } else {
    sounds.push('dice_bad');
  }
  state.turn = (state.turn + 1) % state.scores.length;
  startTurn(state, log);
  if (state.farkled && state.turn !== 0) {
    // AI farkled on its opening roll — burn the turn immediately
    endTurn(state, false, log, sounds);
  }
}

function aiPlay(state, log, sounds) {
  let guard = 0;
  while (state.status === 'active' && state.turn !== 0 && guard < 80) {
    guard += 1;
    if (state.farkled) { endTurn(state, false, log, sounds); continue; }
    // greedy: take everything on the table
    let takes = takesFor(state.dice);
    while (takes.length) {
      applyTake(state, takes.sort((a, b) => b.points - a.points)[0]);
      takes = takesFor(state.dice);
    }
    log.push(`${state.names[state.turn]} sets aside ${state.kept.join(', ')} — ${state.turnPoints} riding.`);
    const behind = Math.max(...state.scores) - state.scores[state.turn];
    const pushHard = behind > state.target / 4 || Math.max(...state.scores) >= state.target - 500;
    const wantMore = state.turnPoints < (pushHard ? 600 : 350) && state.dice.length >= (pushHard ? 1 : 3);
    if (state.dice.length === 0) {
      // hot dice — always ride at least once more
      state.dice = roll(6);
      state.tookThisRoll = false;
      log.push(`${state.names[state.turn]} is HOT — all six back in hand and rolling: ${state.dice.join(', ')}.`);
      sounds.push('dice_roll');
      if (checkFarkle(state, log)) { endTurn(state, false, log, sounds); }
      continue;
    }
    if (wantMore) {
      state.dice = roll(state.dice.length);
      state.tookThisRoll = false;
      log.push(`${state.names[state.turn]} rolls ${state.dice.length}: ${state.dice.join(', ')}.`);
      sounds.push('dice_roll');
      if (checkFarkle(state, log)) { endTurn(state, false, log, sounds); }
      continue;
    }
    endTurn(state, true, log, sounds);
  }
}

function legal(state) {
  if (state.status !== 'active' || state.turn !== 0) return [];
  if (state.farkled) return [{ token: 'next', label: 'Hand the dice over (the farkle burned your turn)' }];
  const out = takesFor(state.dice).map((t) => ({ token: t.token, label: t.label }));
  if (state.tookThisRoll) {
    if (state.dice.length === 0) {
      out.push({ token: 'roll', label: 'HOT DICE — roll all six again' });
    } else {
      out.push({ token: 'roll', label: `Roll the ${state.dice.length} loose ${state.dice.length === 1 ? 'die' : 'dice'}` });
    }
    out.push({ token: 'bank', label: `Bank ${state.turnPoints} points and pass the dice` });
  }
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'Not your turn yet.' };
  const t = String(token || '').toLowerCase().trim();
  const log = [];
  const sounds = [];

  if (state.farkled) {
    if (t !== 'next') return { error: "You farkled — say 'next' to pass the dice." };
    endTurn(state, false, log, sounds);
    aiPlay(state, log, sounds);
    return { log, sounds };
  }

  if (t === 'roll') {
    if (!state.tookThisRoll) return { error: 'Set aside at least one scoring take before you roll again.' };
    if (state.dice.length === 0) state.dice = roll(6); // hot dice
    else state.dice = roll(state.dice.length);
    state.tookThisRoll = false;
    log.push(`You roll: ${state.dice.join(', ')}.`);
    sounds.push('dice_roll');
    if (checkFarkle(state, log)) sounds.push('dice_bad');
    return { log, sounds };
  }

  if (t === 'bank') {
    if (!state.tookThisRoll) return { error: 'Take a scoring set first, then you can bank.' };
    if (state.turnPoints <= 0) return { error: 'Nothing to bank yet.' };
    endTurn(state, true, log, sounds);
    if (state.status === 'active') aiPlay(state, log, sounds);
    return { log, sounds };
  }

  const take = takesFor(state.dice).find((x) => x.token === t);
  if (!take) return { error: `Not a take on this roll. Legal: ${legal(state).map((m) => m.token).join(', ')}.` };
  applyTake(state, take);
  log.push(`Set aside ${take.dice.join(', ')} for ${take.points} — ${state.turnPoints} riding, ${state.dice.length} dice loose.`);
  sounds.push('chip_bet');
  return { log, sounds };
}

function view(state) {
  const lines = [];
  lines.push(`Scores — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}. First to ${state.target}.`);
  const over = state.status === 'over';
  let winner = null;
  const sounds = [];
  if (over) {
    winner = state.winner === 0 ? 'player' : state.names[state.winner];
    lines.push(state.winner === 0 ? `You bank your way to ${state.scores[0]} — WINNER!` : `${state.names[state.winner]} gets there first.`);
  } else if (state.farkled) {
    lines.push(`Your roll came up ${state.dice.join(', ')} — FARKLE. Nothing scores; the turn is dead.`);
  } else {
    lines.push(`Your live roll: ${state.dice.join(', ')}.${state.kept.length ? ` Set aside: ${state.kept.join(', ')} (${state.turnPoints} riding).` : ''}`);
    lines.push('Read the dice, then the choices. Ones and fives always score; triples, a full straight, or three pairs score big.');
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
