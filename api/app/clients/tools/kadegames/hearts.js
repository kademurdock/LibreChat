const { makeDeck, shuffle, cardName, handWords, rankOf, suitOf, houseNames } = require('./deck');

/**
 * Hearts (July 23 2026 — GAMES_PLAN phase 4, "the perfect multi-agent table").
 * Four seats, classic no-pass variant, first to 50 ends the game, lowest
 * score wins. Hearts are a point each, the Queen of Spades is thirteen,
 * shooting the moon hands everyone else twenty-six.
 *
 * PHASE-4 SHAPE: this module NEVER auto-plays the other seats. view() (and
 * seatView()) always describe whoever's turn it is; the TOOL layer decides
 * how seats 1-3 move — a real marketplace agent's persona picks from the
 * legal list (agentSeats.js), or the exported botMove() heuristic fills in
 * when no persona is seated (or a persona answers nonsense). The engine
 * stays the only referee either way.
 */

const meta = {
  key: 'hearts',
  name: 'Hearts',
  blurb: 'Four seats, tricks, and one mean Queen of Spades. Lowest score wins — first to 50 ends it.',
  minPlayers: 4,
  maxPlayers: 4,
  dealSounds: ['card_shuffle', 'card_deal'],
  seatAware: true, // tool layer: seats 1-3 are external (personas or botMove)
};

const RANK_ORDER = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
const QS = 'Q:S';
const TWO_CLUBS = '2:C';
const GAME_TO = 50;

function sortHand(h) {
  const suitRank = { C: 0, D: 1, S: 2, H: 3 };
  return h.slice().sort((a, b) =>
    suitRank[suitOf(a)] - suitRank[suitOf(b)] || RANK_ORDER[rankOf(a)] - RANK_ORDER[rankOf(b)],
  );
}

function dealRound(state) {
  const deck = shuffle(makeDeck());
  state.hands = [[], [], [], []];
  for (let i = 0; i < 52; i++) state.hands[i % 4].push(deck[i]);
  state.hands = state.hands.map(sortHand);
  state.trick = []; // [{seat, card}]
  state.taken = [[], [], [], []]; // point cards taken this round
  state.heartsBroken = false;
  state.trickNo = 1;
  state.turn = state.hands.findIndex((h) => h.includes(TWO_CLUBS));
  state.leader = state.turn;
}

function newGame(opts = {}) {
  const names = ['You', ...(opts.names || []).slice(0, 3)];
  names.push(...houseNames(4 - names.length, names));
  while (names.length < 4) names.push(`Player ${names.length}`);
  const state = {
    g: 'hearts',
    names,
    scores: [0, 0, 0, 0],
    round: 1,
    status: 'active',
    winner: null,
  };
  dealRound(state);
  return state;
}

function pointsIn(cards) {
  return cards.reduce((n, c) => n + (suitOf(c) === 'H' ? 1 : 0) + (c === QS ? 13 : 0), 0);
}

function legalCards(state, seat) {
  const hand = state.hands[seat];
  const isFirstTrick = state.trickNo === 1;
  if (state.trick.length === 0) {
    // Leading.
    if (isFirstTrick) return [TWO_CLUBS].filter((c) => hand.includes(c));
    const nonHearts = hand.filter((c) => suitOf(c) !== 'H');
    if (!state.heartsBroken && nonHearts.length) return nonHearts;
    return hand.slice();
  }
  const led = suitOf(state.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  if (follow.length) return follow;
  if (isFirstTrick) {
    // No points on the first trick unless there's no choice.
    const clean = hand.filter((c) => suitOf(c) !== 'H' && c !== QS);
    if (clean.length) return clean;
  }
  return hand.slice();
}

function finishTrick(state, log, sounds) {
  const led = suitOf(state.trick[0].card);
  let best = 0;
  for (let i = 1; i < 4; i++) {
    const c = state.trick[i].card;
    if (suitOf(c) === led && RANK_ORDER[rankOf(c)] > RANK_ORDER[rankOf(state.trick[best].card)]) best = i;
  }
  const winner = state.trick[best].seat;
  const pts = pointsIn(state.trick.map((t) => t.card));
  state.taken[winner].push(...state.trick.map((t) => t.card).filter((c) => suitOf(c) === 'H' || c === QS));
  log.push(`${state.names[winner]} takes the trick${pts ? ` — ${pts} point${pts === 1 ? '' : 's'} in it` : ''}.`);
  if (pts) sounds.push('card_slap');
  state.trick = [];
  state.leader = winner;
  state.turn = winner;
  state.trickNo += 1;

  if (state.hands.every((h) => h.length === 0)) {
    // Round over — score it (with the moon check).
    const roundPts = state.taken.map(pointsIn);
    const shooter = roundPts.findIndex((p) => p === 26);
    if (shooter >= 0) {
      for (let i = 0; i < 4; i++) if (i !== shooter) state.scores[i] += 26;
      log.push(`${state.names[shooter]} SHOT THE MOON — everyone else takes 26!`);
      sounds.push('win_fanfare');
    } else {
      for (let i = 0; i < 4; i++) state.scores[i] += roundPts[i];
      log.push(`Round ${state.round} scored: ${state.names.map((n, i) => `${n} +${roundPts[i]}`).join(', ')}.`);
    }
    if (Math.max(...state.scores) >= GAME_TO) {
      const low = Math.min(...state.scores);
      state.winner = state.scores.indexOf(low);
      state.status = 'over';
      log.push(`Game over — ${state.names[state.winner]} wins with ${low} point${low === 1 ? '' : 's'}!`);
      sounds.push(state.winner === 0 ? 'win_fanfare' : 'lose_trombone');
    } else {
      state.round += 1;
      dealRound(state);
      log.push(`Fresh deal — round ${state.round}. Scores: ${state.names.map((n, i) => `${n} ${state.scores[i]}`).join(', ')}.`);
      sounds.push('card_shuffle');
    }
  }
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'The game is over.' };
  const m = /^play_(.+)$/.exec(String(token).trim());
  if (!m) return { error: 'Moves look like play_QS or play_10H.' };
  const compact = m[1].length >= 2 ? `${m[1].slice(0, -1)}:${m[1].slice(-1)}` : null;
  const seat = state.turn;
  const legal = legalCards(state, seat);
  if (!compact || !legal.includes(compact)) {
    return { error: `That's not a legal play right now for ${state.names[seat]}.` };
  }
  const log = [];
  const sounds = ['card_flip'];
  state.hands[seat] = state.hands[seat].filter((c) => c !== compact);
  state.trick.push({ seat, card: compact });
  if (suitOf(compact) === 'H' && !state.heartsBroken) {
    state.heartsBroken = true;
    log.push('Hearts are broken!');
  }
  log.push(`${state.names[seat]} plays the ${cardName(compact)}.`);
  if (state.trick.length === 4) {
    finishTrick(state, log, sounds);
  } else {
    state.turn = (seat + 1) % 4;
  }
  return { log, sounds };
}

function tokenFor(c) {
  return `play_${c.replace(':', '')}`;
}

/** The CURRENT seat's private view + legal tokens — what a persona (or the
 * human, when seat 0) is allowed to know. */
function seatView(state, seat) {
  const trickSoFar = state.trick.length
    ? state.trick.map((t) => `${state.names[t.seat]}: ${cardName(t.card)}`).join('; ')
    : '(you lead)';
  return {
    seat,
    name: state.names[seat],
    lines: [
      `Round ${state.round}, trick ${state.trickNo}. Scores: ${state.names.map((n, i) => `${n} ${state.scores[i]}`).join(', ')}.`,
      `On the table: ${trickSoFar}.`,
      `Your hand: ${handWords(state.hands[seat])}.`,
      `Hearts ${state.heartsBroken ? 'are broken' : 'not broken yet'}.`,
    ],
    legal: legalCards(state, seat).map((c) => ({ token: tokenFor(c), label: cardName(c) })),
  };
}

/** Heuristic fallback so a table never stalls: follow low; when void, dump
 * the Queen, then high hearts, then the biggest card; lead low. */
function botMove(state) {
  const seat = state.turn;
  const legal = legalCards(state, seat);
  const by = (c) => RANK_ORDER[rankOf(c)];
  if (state.trick.length === 0) {
    return tokenFor(legal.slice().sort((a, b) => by(a) - by(b))[0]);
  }
  const led = suitOf(state.trick[0].card);
  const following = legal.filter((c) => suitOf(c) === led);
  if (following.length) {
    const ceiling = Math.max(
      ...state.trick.filter((t) => suitOf(t.card) === led).map((t) => by(t.card)),
    );
    const under = following.filter((c) => by(c) < ceiling);
    const pick = under.length
      ? under.sort((a, b) => by(b) - by(a))[0] // duck as high as safely possible
      : following.sort((a, b) => by(a) - by(b))[0]; // must win? win cheap
    return tokenFor(pick);
  }
  if (legal.includes(QS)) return tokenFor(QS);
  const hearts = legal.filter((c) => suitOf(c) === 'H').sort((a, b) => by(b) - by(a));
  if (hearts.length) return tokenFor(hearts[0]);
  return tokenFor(legal.slice().sort((a, b) => by(b) - by(a))[0]);
}

/** Human-facing table view (seat 0's perspective). */
function view(state) {
  const over = state.status !== 'active';
  const mine = seatView(state, 0);
  const lines = [
    `Hearts — round ${state.round}, trick ${state.trickNo}. Lowest score wins; ${GAME_TO} ends it.`,
    `Scores: ${state.names.map((n, i) => `${n} ${state.scores[i]}`).join(', ')}.`,
    state.trick.length
      ? `On the table: ${state.trick.map((t) => `${state.names[t.seat]} played the ${cardName(t.card)}`).join('; ')}.`
      : `${state.names[state.turn]} lead${state.turn === 0 ? '' : 's'} this trick.`,
    `Your hand: ${handWords(state.hands[0])}.`,
  ];
  if (over) lines.push(`Winner: ${state.names[state.winner]}.`);
  return {
    over,
    // Leaderboard contract: 'player' when seat 0 wins, any other string = a loss.
    winner: over ? (state.winner === 0 ? 'player' : 'rival') : undefined,
    turnSeat: state.turn,
    lines,
    legal: over || state.turn !== 0 ? [] : mine.legal,
    legalHint: 'say the card you want to play',
    sounds: over ? [] : undefined,
  };
}

module.exports = { meta, newGame, view, move, seatView, botMove };
