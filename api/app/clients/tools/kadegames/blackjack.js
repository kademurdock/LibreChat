// Blackjack — engine-refereed. The dealer plays by fixed house rules (hit
// until 17, stand on soft 17). The AI at the table only banters; the engine
// deals, scores, and settles. Single deck, reshuffled each new game.

const { makeDeck, shuffle, cardName, handWords, rankOf, scoreBlackjack } = require('./deck');

const meta = {
  key: 'blackjack',
  name: 'Blackjack',
  blurb: 'Beat the dealer to 21 without busting. A dealer character is a must.',
  minPlayers: 1,
  maxPlayers: 1,
};

function newGame(opts = {}) {
  const bet = Math.max(1, Math.min(500, parseInt(opts.bet, 10) || 10));
  const deck = shuffle(makeDeck());
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  const state = { g: 'blackjack', deck, player, dealer, phase: 'player', result: null, bet, doubled: false };
  const p = scoreBlackjack(player).total;
  const d = scoreBlackjack(dealer).total;
  if (p === 21 || d === 21) {
    state.phase = 'done';
    if (p === 21 && d === 21) state.result = 'push';
    else if (p === 21) state.result = 'blackjack';
    else state.result = 'lose';
  }
  return state;
}

function dealerPlay(state) {
  // Stand on soft 17 (common house rule).
  let s = scoreBlackjack(state.dealer);
  while (s.total < 17) {
    state.dealer.push(state.deck.pop());
    s = scoreBlackjack(state.dealer);
  }
  const p = scoreBlackjack(state.player).total;
  const d = s.total;
  if (d > 21) state.result = 'dealer_bust';
  else if (p > d) state.result = 'win';
  else if (p < d) state.result = 'lose';
  else state.result = 'push';
  state.phase = 'done';
}

function legal(state) {
  if (state.phase !== 'player') return [];
  const moves = [
    { token: 'hit', label: 'Hit (take another card)' },
    { token: 'stand', label: 'Stand (keep your hand)' },
  ];
  if (state.player.length === 2) moves.push({ token: 'double', label: 'Double down (one card, double bet)' });
  return moves;
}

function view(state) {
  const p = scoreBlackjack(state.player);
  const lines = [];
  lines.push(`Your hand: ${handWords(state.player)} — ${p.total}${p.soft ? ' (soft)' : ''}.`);
  if (state.phase === 'player') {
    lines.push(`Dealer shows the ${cardName(state.dealer[0])}, plus a face-down card.`);
  } else {
    const d = scoreBlackjack(state.dealer);
    lines.push(`Dealer had ${handWords(state.dealer)} — ${d.total}.`);
  }
  const over = state.phase === 'done';
  let winner = null;
  let sounds = [];
  if (over) {
    const wins = state.result === 'win' || state.result === 'blackjack' || state.result === 'dealer_bust';
    const push = state.result === 'push';
    winner = push ? 'push' : wins ? 'player' : 'dealer';
    const payout = state.result === 'blackjack' ? Math.round(state.bet * 1.5)
      : wins ? state.bet * (state.doubled ? 2 : 1)
      : push ? 0
      : -state.bet * (state.doubled ? 2 : 1);
    state.payout = payout;
    const resultText = {
      blackjack: `BLACKJACK! You win ${payout} chips.`,
      win: `You win — ${payout} chips.`,
      dealer_bust: `Dealer busts! You win ${payout} chips.`,
      lose: `Dealer takes it. You lose ${Math.abs(payout)} chips.`,
      bust: `You busted. You lose ${Math.abs(payout)} chips.`,
      push: `Push — it's a tie. Your bet comes back.`,
    }[state.result];
    lines.push(resultText);
    sounds = wins ? ['chip_win', 'win_fanfare'] : push ? ['draw_game'] : ['lose_trombone'];
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

function move(state, token) {
  if (state.phase !== 'player') return { error: 'This hand is already over. Start a new game to play again.' };
  if (token === 'hit') {
    state.player.push(state.deck.pop());
    if (scoreBlackjack(state.player).total > 21) {
      state.result = 'bust';
      state.phase = 'done';
      return { sounds: ['card_flip'], log: ['You hit and busted.'] };
    }
    return { sounds: ['card_flip'], log: ['You hit.'] };
  }
  if (token === 'stand') {
    dealerPlay(state);
    return { sounds: ['card_flip'], log: ['You stand; the dealer plays.'] };
  }
  if (token === 'double') {
    if (state.player.length !== 2) return { error: 'You can only double on your first two cards.' };
    state.doubled = true;
    state.player.push(state.deck.pop());
    if (scoreBlackjack(state.player).total > 21) {
      state.result = 'bust';
      state.phase = 'done';
      return { sounds: ['card_flip'], log: ['You doubled and busted.'] };
    }
    dealerPlay(state);
    return { sounds: ['card_flip'], log: ['You double down.'] };
  }
  return { error: `Not a legal move here. Legal moves: ${legal(state).map((m) => m.token).join(', ')}.` };
}

module.exports = { meta, newGame, view, move, legal };
