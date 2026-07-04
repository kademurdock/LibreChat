const { houseNames } = require('./deck');
/**
 * Liar's Dice (July 4 2026 overnight build — from the GAMES_PLAN wish list).
 * Perudo-style: everyone rolls five dice under their cup, then the table
 * trades escalating bids ("three fours") until somebody calls LIAR. Ones are
 * wild. The ENGINE rolls and counts everything — the rivals bluff with real
 * probability math on their own dice only (no peeking, enforced by code).
 *
 * Voice-native: your dice get read to you, everything else is talk.
 * Bids are on faces 2–6 (ones stay wild, always).
 */

const meta = {
  key: 'liars_dice',
  name: "Liar's Dice",
  blurb: 'Five dice under your cup, ones are wild. Raise the bid or call LIAR — lose the call, lose a die.',
  minPlayers: 2,
  maxPlayers: 4,
  dealSounds: ['dice_shake'],
};

function d6() { return 1 + Math.floor(Math.random() * 6); }
function rollFor(n) { return Array.from({ length: n }, d6).sort(); }

const FACE_WORD = { 2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes' };

function newGame(opts = {}) {
  const rivals = Math.max(1, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 2));
  const n = rivals + 1;
  const names = ['You', ...(opts.names || []).slice(0, rivals)];
  names.push(...houseNames(n - names.length, names));
  while (names.length < n) names.push(`Player ${names.length}`);
  const state = {
    g: 'liars_dice',
    names,
    diceCounts: new Array(n).fill(5),
    dice: [],
    bid: null, // {count, face, seat}
    turn: 0,
    round: 1,
    status: 'active',
    winner: null,
    lastCall: null,
  };
  newRound(state, null);
  return state;
}

function alive(state, seat) { return state.diceCounts[seat] > 0; }
function aliveSeats(state) { return state.diceCounts.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0); }
function totalDice(state) { return state.diceCounts.reduce((a, b) => a + b, 0); }

function newRound(state, log) {
  state.dice = state.diceCounts.map((c) => rollFor(c));
  state.bid = null;
  if (log) log.push(`Round ${state.round}: everyone shakes and rolls. ${totalDice(state)} dice on the table.`);
}

function nextAlive(state, from) {
  let s = from;
  do { s = (s + 1) % state.names.length; } while (!alive(state, s));
  return s;
}

function countFace(state, face) {
  let c = 0;
  for (const cup of state.dice) for (const d of cup) if (d === face || d === 1) c += 1;
  return c;
}

function validRaise(state, count, face) {
  if (!Number.isInteger(count) || !Number.isInteger(face)) return false;
  if (face < 2 || face > 6) return false;
  if (count < 1 || count > totalDice(state)) return false;
  if (!state.bid) return true;
  return count > state.bid.count || (count === state.bid.count && face > state.bid.face);
}

/* Rival brain: expected count of a face = what I hold (face + wild ones) plus
 * a third of everyone else's hidden dice (P(face or 1) = 1/3). Raise while
 * the current bid is comfortably below expectation, bluff a little past it
 * sometimes, and call LIAR when the bid outruns belief. */
function aiAct(state, seat, log, sounds) {
  const mine = state.dice[seat];
  const hidden = totalDice(state) - mine.length;
  const expFor = (face) => mine.filter((d) => d === face || d === 1).length + hidden / 3;
  if (state.bid) {
    const believable = expFor(state.bid.face) + 1.1 + (Math.random() < 0.25 ? 1 : 0);
    if (state.bid.count > believable) {
      resolveChallenge(state, seat, log, sounds);
      return true; // round resolved
    }
  }
  // choose my strongest face to steer toward
  let bestFace = 2;
  let bestExp = -1;
  for (let f = 2; f <= 6; f++) {
    const e = expFor(f);
    if (e > bestExp) { bestExp = e; bestFace = f; }
  }
  let count, face;
  if (!state.bid) {
    count = Math.max(1, Math.round(bestExp - 0.5));
    face = bestFace;
  } else if (bestFace > state.bid.face && validRaise(state, state.bid.count, bestFace)) {
    count = state.bid.count;
    face = bestFace;
  } else {
    count = state.bid.count + 1;
    face = bestFace;
    if (!validRaise(state, count, face)) face = state.bid.face;
  }
  if (!validRaise(state, count, face)) { // cornered — has to call
    resolveChallenge(state, seat, log, sounds);
    return true;
  }
  state.bid = { count, face, seat };
  log.push(`${state.names[seat]} bids ${count} ${FACE_WORD[face]}.`);
  sounds.push('chip_bet');
  state.turn = nextAlive(state, seat);
  return false;
}

function resolveChallenge(state, challenger, log, sounds) {
  const bid = state.bid;
  const bidder = bid.seat;
  const actual = countFace(state, bid.face);
  log.push(`${state.names[challenger]} calls LIAR on ${state.names[bidder]}'s ${bid.count} ${FACE_WORD[bid.face]}!`);
  // full reveal, spoken
  for (const s of aliveSeats(state)) {
    log.push(`  ${state.names[s]} shows: ${state.dice[s].join(', ')}.`);
  }
  log.push(`Count ${FACE_WORD[bid.face]} plus wild ones: ${actual}.`);
  sounds.push('drumroll_short');
  const bidderRight = actual >= bid.count;
  const loser = bidderRight ? challenger : bidder;
  state.diceCounts[loser] -= 1;
  log.push(`${bidderRight ? `The bid holds — ${state.names[challenger]} loses a die` : `It was a lie — ${state.names[bidder]} loses a die`} (${state.diceCounts[loser]} left).`);
  sounds.push(loser === 0 ? 'wrong_buzz' : 'correct_ding');
  state.lastCall = { challenger, bidder, actual, bid: { ...bid } };

  const living = aliveSeats(state);
  if (!alive(state, 0)) {
    // the human is out — game over, best-stocked rival takes it
    state.status = 'over';
    let best = living[0];
    for (const s of living) if (state.diceCounts[s] > state.diceCounts[best]) best = s;
    state.winner = best;
    sounds.push('lose_trombone');
    return;
  }
  if (living.length === 1) {
    state.status = 'over';
    state.winner = living[0];
    sounds.push(living[0] === 0 ? 'win_fanfare' : 'lose_trombone');
    return;
  }
  state.round += 1;
  state.turn = alive(state, loser) ? loser : nextAlive(state, loser);
  newRound(state, log);
  sounds.push('dice_shake');
}

function runAI(state, log, sounds) {
  let guard = 0;
  while (state.status === 'active' && state.turn !== 0 && guard < 60) {
    guard += 1;
    aiAct(state, state.turn, log, sounds);
  }
}

function suggestions(state) {
  const out = [];
  const total = totalDice(state);
  if (!state.bid) {
    for (let f = 6; f >= 2 && out.length < 4; f--) out.push([Math.max(1, Math.round(total / 4)), f]);
  } else {
    const { count, face } = state.bid;
    for (let f = face + 1; f <= 6 && out.length < 3; f++) out.push([count, f]);
    for (let f = 2; f <= 6 && out.length < 6; f++) out.push([count + 1, f]);
  }
  return out.filter(([c, f]) => validRaise(state, c, f)).slice(0, 6);
}

function legal(state) {
  if (state.status !== 'active' || state.turn !== 0) return [];
  const out = suggestions(state).map(([c, f]) => ({ token: `bid_${c}_${f}`, label: `Bid ${c} ${FACE_WORD[f]}` }));
  if (state.bid) out.push({ token: 'challenge', label: `Call LIAR on ${state.names[state.bid.seat]}` });
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'Not your turn yet.' };
  const log = [];
  const sounds = [];
  const t = String(token || '').toLowerCase().trim();
  if (t === 'challenge') {
    if (!state.bid) return { error: 'No bid on the table to challenge — open with a bid.' };
    resolveChallenge(state, 0, log, sounds);
    if (state.status === 'active' && state.turn !== 0) runAI(state, log, sounds);
    return { log, sounds };
  }
  const m = /^bid_(\d{1,2})_([2-6])$/.exec(t);
  if (!m) return { error: 'Bid like bid_3_4 (three fours), or challenge. Faces run 2 to 6 — ones are wild.' };
  const count = parseInt(m[1], 10);
  const face = parseInt(m[2], 10);
  if (!validRaise(state, count, face)) {
    return { error: state.bid
      ? `That doesn't raise ${state.bid.count} ${FACE_WORD[state.bid.face]} — raise the count, or the face at the same count.`
      : `An opening bid needs a count from 1 to ${totalDice(state)} on faces 2–6.` };
  }
  state.bid = { count, face, seat: 0 };
  log.push(`You bid ${count} ${FACE_WORD[face]}.`);
  sounds.push('chip_bet');
  state.turn = nextAlive(state, 0);
  runAI(state, log, sounds);
  return { log, sounds };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  let winner = null;
  const sounds = [];
  if (over) {
    winner = state.winner === 0 ? 'player' : state.names[state.winner];
    lines.push(state.winner === 0
      ? `Last cup standing — you win with ${state.diceCounts[0]} dice left!`
      : `${state.names[state.winner]} takes the table.`);
  } else {
    lines.push(`Your dice: ${state.dice[0].join(', ')}. (Ones are wild.)`);
    lines.push(`Dice left — ${aliveSeats(state).map((s) => `${state.names[s]}: ${state.diceCounts[s]}`).join(', ')}. ${totalDice(state)} total.`);
    lines.push(state.bid
      ? `Current bid: ${state.names[state.bid.seat]} says ${state.bid.count} ${FACE_WORD[state.bid.face]}. Raise it or call LIAR.`
      : 'No bid yet — open it up.');
  }
  return {
    lines,
    legal: legal(state),
    legalHint: 'any legal raise works: bid_<count>_<face> (faces 2–6)',
    sounds,
    over,
    winner,
  };
}

module.exports = { meta, newGame, view, move, legal };
