const { makeDeck, shuffle, cardName, handWords, rankOf, suitOf, houseNames } = require('./deck');

/**
 * Five-Card Draw (July 23 2026 — GAMES_PLAN phase 4, the poker-night table).
 * Friendly-stakes fake chips only, 2-4 seats. One clean hand per game:
 * everyone antes, five cards down, ONE betting round (check / bet / call /
 * fold), draw up to three, showdown. Short and social on purpose — the
 * banter IS the game; rematches are one new_game away.
 *
 * PHASE-4 SHAPE: like hearts.js, this module never auto-plays seats 1+ —
 * personas (agentSeats.js) or the exported botMove() heuristic act through
 * the same move() referee the human uses. Nobody sees a hand that isn't
 * theirs; the engine only reveals cards at showdown.
 *
 * PHASE-5 HOOK: exports chipsDelta(state) — seat 0's net chips — so the
 * tool's persistent chip bank can settle the table when it ends.
 */

const meta = {
  key: 'five_card_draw',
  name: 'Five-Card Draw',
  blurb: "Poker night, friendly stakes: ante up, one round of betting, draw up to three, show 'em.",
  minPlayers: 2,
  maxPlayers: 4,
  dealSounds: ['card_shuffle', 'card_deal', 'chip_bet'],
  seatAware: true,
  usesChips: true,
};

const RANK_VAL = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
const ANTE = 10;
const BET = 20;

function newGame(opts = {}) {
  const rivals = Math.max(1, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 2));
  const n = rivals + 1;
  const names = ['You', ...(opts.names || []).slice(0, rivals)];
  names.push(...houseNames(n - names.length, names));
  while (names.length < n) names.push(`Player ${names.length}`);
  const deck = shuffle(makeDeck());
  const state = {
    g: 'five_card_draw',
    names,
    n,
    deck,
    hands: Array.from({ length: n }, () => deck.splice(0, 5)),
    chips: new Array(n).fill(200 - ANTE),
    pot: ANTE * n,
    committed: new Array(n).fill(0), // this betting round
    folded: new Array(n).fill(false),
    drawn: new Array(n).fill(false),
    phase: 'bet', // bet -> draw -> over
    betToMatch: 0,
    turn: 0,
    lastRaiser: null,
    actedCount: 0,
    status: 'active',
    winner: null,
    reveal: null,
  };
  return state;
}

/* ── Hand ranking ───────────────────────────────────────────────────────── */
function evalHand(cards) {
  const vals = cards.map((c) => RANK_VAL[rankOf(c)]).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ v: Number(v), c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);
  const flush = suits.every((s) => s === suits[0]);
  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals.join(',') === '14,5,4,3,2') straightHigh = 5; // wheel
  }
  const kick = groups.flatMap((g) => new Array(g.c).fill(g.v));
  if (straightHigh && flush) return { rank: 8, name: 'a straight flush', kick: [straightHigh] };
  if (groups[0].c === 4) return { rank: 7, name: `four ${plural(groups[0].v)}`, kick };
  if (groups[0].c === 3 && groups[1]?.c === 2) return { rank: 6, name: 'a full house', kick };
  if (flush) return { rank: 5, name: 'a flush', kick: vals };
  if (straightHigh) return { rank: 4, name: 'a straight', kick: [straightHigh] };
  if (groups[0].c === 3) return { rank: 3, name: `three ${plural(groups[0].v)}`, kick };
  if (groups[0].c === 2 && groups[1]?.c === 2) return { rank: 2, name: 'two pair', kick };
  if (groups[0].c === 2) return { rank: 1, name: `a pair of ${plural(groups[0].v)}`, kick };
  return { rank: 0, name: `${word(vals[0])} high`, kick: vals };
}
function word(v) {
  return { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' }[v] || String(v);
}
function plural(v) {
  const w = word(v);
  return w === 'Six' ? 'Sixes' : `${w}s`;
}
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.kick.length, b.kick.length); i++) {
    const d = (a.kick[i] || 0) - (b.kick[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* ── Turn helpers ───────────────────────────────────────────────────────── */
function liveSeats(state) {
  return state.names.map((_, i) => i).filter((i) => !state.folded[i]);
}
function nextLive(state, from) {
  for (let k = 1; k <= state.n; k++) {
    const i = (from + k) % state.n;
    if (!state.folded[i]) return i;
  }
  return from;
}

function maybeShowdown(state, log, sounds) {
  const live = liveSeats(state);
  if (live.length === 1) {
    endGame(state, live[0], log, sounds, true);
    return true;
  }
  if (state.phase === 'draw' && live.every((i) => state.drawn[i])) {
    const ranked = live
      .map((i) => ({ i, hand: evalHand(state.hands[i]) }))
      .sort((a, b) => compareHands(b.hand, a.hand));
    state.reveal = live.map((i) => `${state.names[i]}: ${handWords(state.hands[i])} — ${evalHand(state.hands[i]).name}`);
    endGame(state, ranked[0].i, log, sounds, false, ranked[0].hand.name);
    return true;
  }
  return false;
}

function endGame(state, winner, log, sounds, byFold, handName) {
  state.chips[winner] += state.pot;
  state.winner = winner;
  state.status = 'over';
  log.push(
    byFold
      ? `Everyone else folded — ${state.names[winner]} takes the pot of ${state.pot} chips without showing.`
      : `${state.names[winner]} wins the ${state.pot}-chip pot with ${handName}.`,
  );
  sounds.push('chip_win', winner === 0 ? 'win_fanfare' : 'lose_trombone');
}

function advanceBetting(state, log, sounds) {
  state.actedCount += 1;
  const live = liveSeats(state);
  const allMatched = live.every((i) => state.committed[i] === state.betToMatch);
  if (state.actedCount >= live.length && allMatched) {
    state.phase = 'draw';
    state.turn = live[0];
    log.push('Betting closed. Draw time — trade up to three cards.');
    return;
  }
  state.turn = nextLive(state, state.turn);
}

/* ── The referee ────────────────────────────────────────────────────────── */
function move(state, token) {
  if (state.status !== 'active') return { error: 'The hand is over.' };
  const seat = state.turn;
  const t = String(token).trim().toLowerCase();
  const log = [];
  const sounds = [];

  if (state.phase === 'bet') {
    const owe = state.betToMatch - state.committed[seat];
    if (t === 'check') {
      if (owe > 0) return { error: `There's a bet of ${owe} to you — call, or fold.` };
      log.push(`${state.names[seat]} checks.`);
    } else if (t === 'bet') {
      if (state.betToMatch > 0) return { error: 'A bet is already out — call or fold.' };
      state.betToMatch = BET;
      state.committed[seat] += BET;
      state.chips[seat] -= BET;
      state.pot += BET;
      state.actedCount = 0; // everyone must respond
      log.push(`${state.names[seat]} bets ${BET} chips.`);
      sounds.push('chip_bet');
    } else if (t === 'call') {
      if (owe <= 0) return { error: 'Nothing to call — check instead.' };
      state.committed[seat] += owe;
      state.chips[seat] -= owe;
      state.pot += owe;
      log.push(`${state.names[seat]} calls ${owe}.`);
      sounds.push('chip_bet');
    } else if (t === 'fold') {
      state.folded[seat] = true;
      log.push(`${state.names[seat]} folds.`);
      sounds.push('card_slap');
    } else {
      return { error: 'Betting moves: check, bet, call, or fold.' };
    }
    if (!maybeShowdown(state, log, sounds)) advanceBetting(state, log, sounds);
    return { log, sounds };
  }

  // Draw phase: draw_none or draw_<positions like "13"> (1-based card slots)
  if (state.phase === 'draw') {
    let m;
    if (t === 'draw_none' || t === 'stand_pat') {
      state.drawn[seat] = true;
      log.push(`${state.names[seat]} stands pat.`);
    } else if ((m = /^draw_([1-5]{1,3})$/.exec(t))) {
      const slots = [...new Set(m[1].split('').map(Number))].sort((a, b) => b - a);
      if (slots.length > 3) return { error: 'Draw at most three cards.' };
      for (const s of slots) {
        if (s > state.hands[seat].length) return { error: `You only have ${state.hands[seat].length} cards.` };
        state.hands[seat].splice(s - 1, 1);
      }
      while (state.hands[seat].length < 5) state.hands[seat].push(state.deck.shift());
      state.drawn[seat] = true;
      log.push(`${state.names[seat]} draws ${slots.length}.`);
      sounds.push('card_draw');
    } else {
      return { error: 'Draw moves: draw_none, or draw_ plus the card positions to replace (draw_13 swaps cards one and three).' };
    }
    if (!maybeShowdown(state, log, sounds)) {
      let nxt = nextLive(state, seat);
      let guard = 0;
      while (state.drawn[nxt] && guard++ < state.n) nxt = nextLive(state, nxt);
      state.turn = nxt;
    }
    return { log, sounds };
  }
  return { error: 'The hand is between phases — ask for the state.' };
}

/* ── Views ──────────────────────────────────────────────────────────────── */
function legalFor(state, seat) {
  if (state.status !== 'active' || state.turn !== seat || state.folded[seat]) return [];
  if (state.phase === 'bet') {
    const owe = state.betToMatch - state.committed[seat];
    return owe > 0
      ? [
          { token: 'call', label: `call the ${owe}-chip bet` },
          { token: 'fold', label: 'fold the hand' },
        ]
      : [
          { token: 'check', label: 'check (no bet)' },
          { token: 'bet', label: `bet ${BET} chips` },
          { token: 'fold', label: 'fold the hand' },
        ];
  }
  return [
    { token: 'draw_none', label: 'stand pat (keep all five)' },
    { token: 'draw_1', label: 'example: replace card one — draw_ plus positions, up to three (draw_245)' },
  ];
}

function seatView(state, seat) {
  return {
    seat,
    name: state.names[seat],
    lines: [
      `Five-Card Draw, ${state.phase === 'bet' ? 'betting round' : 'draw round'}. Pot: ${state.pot} chips.`,
      `Your chips: ${state.chips[seat]}. ${state.betToMatch ? `Bet to match: ${state.betToMatch}.` : 'No bet out yet.'}`,
      `Still in: ${liveSeats(state).map((i) => state.names[i]).join(', ')}.`,
      `Your hand: ${handWords(state.hands[seat])} — that's ${evalHand(state.hands[seat]).name}.`,
    ],
    legal: legalFor(state, seat),
  };
}

function botMove(state) {
  const seat = state.turn;
  const strength = evalHand(state.hands[seat]).rank;
  if (state.phase === 'bet') {
    const owe = state.betToMatch - state.committed[seat];
    if (owe > 0) return strength >= 1 || Math.random() < 0.3 ? 'call' : 'fold';
    return strength >= 2 || (strength >= 1 && Math.random() < 0.5) ? 'bet' : 'check';
  }
  // Draw: keep pairs+, toss the lowest of the rest.
  const hand = state.hands[seat];
  const counts = {};
  for (const c of hand) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
  const toss = hand
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => counts[rankOf(c)] === 1)
    .sort((a, b) => RANK_VAL[rankOf(a.c)] - RANK_VAL[rankOf(b.c)])
    .slice(0, 3)
    .map(({ i }) => i + 1);
  return toss.length ? `draw_${toss.join('')}` : 'draw_none';
}

function view(state) {
  const over = state.status !== 'active';
  const lines = [
    `Five-Card Draw — friendly stakes, ante ${ANTE}, pot ${state.pot} chips.`,
    `Seats: ${state.names.map((n, i) => `${n} (${state.chips[i]} chips${state.folded[i] ? ', folded' : ''})`).join('; ')}.`,
    `Your hand: ${handWords(state.hands[0])} — ${evalHand(state.hands[0]).name}.`,
  ];
  if (!over) lines.push(`${state.names[state.turn]}${state.turn === 0 ? ' — your' : "'s"} move (${state.phase === 'bet' ? 'betting' : 'drawing'}).`);
  if (over && state.reveal) lines.push(`Showdown: ${state.reveal.join('; ')}.`);
  if (over) lines.push(`${state.names[state.winner]} took the pot.`);
  return {
    over,
    // Leaderboard contract: 'player' when seat 0 wins, any other string = a loss.
    winner: over ? (state.winner === 0 ? 'player' : 'rival') : undefined,
    turnSeat: state.turn,
    lines,
    legal: over || state.turn !== 0 ? [] : legalFor(state, 0),
    legalHint: 'betting is check/bet/call/fold; drawing is draw_none or draw_ plus positions',
  };
}

/** Phase-5 chip-bank settle: seat 0's NET result for the hand. They sit down
 * "worth" 200 (ante immediately moves 10 of it into the pot, leaving a 190
 * stack); when the hand ends their worth is just their stack — the pot has
 * been paid out. Net = final stack minus the 200 they brought. */
function chipsDelta(state) {
  if (state.status !== 'over') return 0;
  return state.chips[0] - 200;
}

module.exports = { meta, newGame, view, move, seatView, botMove, chipsDelta };
