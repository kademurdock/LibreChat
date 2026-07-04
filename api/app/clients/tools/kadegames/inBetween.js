/**
 * In-Between / Acey-Deucey (July 4 2026 overnight build). Two posts go up,
 * you bet fake chips on whether the next card lands strictly between them.
 * Smack a post and it costs DOUBLE — the classic sting. Start with 100
 * chips; double your stack to win, go broke and the house grins. Twelve
 * rounds max so a phone game has a natural end. Aces are high.
 */

const { makeDeck, shuffle, cardName, rankOf } = require('./deck');

const VAL = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
const START = 100;
const GOAL = 200;
const MAX_ROUNDS = 12;

const meta = {
  key: 'in_between',
  name: 'In-Between',
  blurb: 'Two posts up, you bet the next card lands between them. Hit a post, pay double. Double your chips to win.',
  minPlayers: 1,
  maxPlayers: 1,
  dealSounds: ['card_shuffle', 'chip_stack'],
};

function freshDeckIfLow(state) {
  if (state.deck.length < 8) state.deck = shuffle(makeDeck());
}

function dealPosts(state, log) {
  freshDeckIfLow(state);
  for (;;) {
    const a = state.deck.pop();
    const b = state.deck.pop();
    if (VAL[rankOf(a)] === VAL[rankOf(b)]) {
      if (log) log.push(`Posts came up paired — ${cardName(a)} and ${cardName(b)}. Redealt, no charge.`);
      freshDeckIfLow(state);
      continue;
    }
    state.posts = VAL[rankOf(a)] < VAL[rankOf(b)] ? [a, b] : [b, a];
    state.drawn = null;
    return;
  }
}

function gap(state) {
  return VAL[rankOf(state.posts[1])] - VAL[rankOf(state.posts[0])] - 1;
}

function newGame() {
  const state = {
    g: 'in_between',
    deck: shuffle(makeDeck()),
    bank: START,
    round: 1,
    posts: null,
    drawn: null,
    status: 'active',
    winner: null,
    payout: 0,
  };
  dealPosts(state, null);
  return state;
}

function finish(state, log, sounds) {
  state.status = 'over';
  state.payout = state.bank - START;
  if (state.bank <= 0) {
    state.winner = 'The house';
    log.push('Busted flat. The house sweeps the felt.');
    sounds.push('lose_trombone');
  } else if (state.bank >= GOAL) {
    state.winner = 'player';
    log.push(`You doubled the stake — ${state.bank} chips! Cashier's window is that way.`);
    sounds.push('jackpot_win', 'coin_shower');
  } else if (state.bank > START) {
    state.winner = 'player';
    log.push(`Twelve rounds done — you walk with ${state.bank} chips, up ${state.bank - START}.`);
    sounds.push('win_fanfare');
  } else if (state.bank === START) {
    state.winner = 'push';
    log.push('Twelve rounds and dead even. A push — nobody bleeds.');
    sounds.push('draw_game');
  } else {
    state.winner = 'The house';
    log.push(`Twelve rounds done — down to ${state.bank} chips. House edge, baby.`);
    sounds.push('lose_trombone');
  }
}

function nextRound(state, log, sounds) {
  if (state.bank <= 0 || state.bank >= GOAL || state.round >= MAX_ROUNDS) {
    finish(state, log, sounds);
    return;
  }
  state.round += 1;
  dealPosts(state, log);
  sounds.push('card_flip');
}

function legal(state) {
  if (state.status !== 'active') return [];
  const out = [];
  for (const b of [5, 10, 25, 50]) {
    if (b <= state.bank) out.push({ token: `bet_${b}`, label: `Bet ${b} chips the next card lands between` });
  }
  out.push({ token: 'skip', label: 'Skip these posts (fresh deal, no bet)' });
  return out;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This session is over. Start a new game for a fresh 100 chips.' };
  const t = String(token || '').toLowerCase().trim();
  const log = [];
  const sounds = [];

  if (t === 'skip') {
    log.push('Passed on those posts.');
    nextRound(state, log, sounds);
    return { log, sounds };
  }

  const m = /^bet_(\d{1,3})$/.exec(t);
  if (!m) return { error: 'Bet with bet_5, bet_10, bet_25, or bet_50 — or skip.' };
  const bet = parseInt(m[1], 10);
  if (![5, 10, 25, 50].includes(bet)) return { error: 'House takes bets of 5, 10, 25, or 50.' };
  if (bet > state.bank) return { error: `You've only got ${state.bank} chips.` };

  freshDeckIfLow(state);
  const card = state.deck.pop();
  state.drawn = card;
  const v = VAL[rankOf(card)];
  const [lo, hi] = state.posts.map((p) => VAL[rankOf(p)]);
  sounds.push('chip_bet', 'card_flip');
  log.push(`Posts: ${cardName(state.posts[0])} and ${cardName(state.posts[1])}. You bet ${bet}. The draw… ${cardName(card)}!`);
  if (v === lo || v === hi) {
    const loss = Math.min(state.bank, bet * 2);
    state.bank -= loss;
    log.push(`POST! Smacked the ${cardName(card)} dead on — that's double: ${loss} chips gone. Bank: ${state.bank}.`);
    sounds.push('wrong_buzz');
  } else if (v > lo && v < hi) {
    state.bank += bet;
    log.push(`Right between the posts — you win ${bet}! Bank: ${state.bank}.`);
    sounds.push('chip_win');
  } else {
    state.bank -= bet;
    log.push(`Outside the posts. ${bet} chips to the house. Bank: ${state.bank}.`);
    sounds.push('card_slap');
  }
  nextRound(state, log, sounds);
  return { log, sounds };
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  let winner = null;
  if (over) {
    winner = state.winner;
    lines.push(`Final bank: ${state.bank} chips (started with ${START}).`);
    lines.push(state.winner === 'player' ? 'You beat the felt!' : state.winner === 'push' ? 'Dead even — a push.' : 'The house takes it.');
  } else {
    const g = gap(state);
    lines.push(`Round ${state.round} of ${MAX_ROUNDS}. Bank: ${state.bank} chips.`);
    lines.push(`The posts: ${cardName(state.posts[0])} low, ${cardName(state.posts[1])} high — ${g === 0 ? 'NOTHING fits between those. Skip is free…' : `${g} rank${g === 1 ? '' : 's'} fit between`}. Aces are high.`);
    lines.push('Place a bet or skip.');
  }
  return { lines, legal: legal(state), sounds: [], over, winner };
}

module.exports = { meta, newGame, view, move, legal };
