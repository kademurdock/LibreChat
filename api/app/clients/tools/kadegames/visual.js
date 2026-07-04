// Game Parlor VISUAL views (July 3 2026, Kade's ask: "add a visual element").
// Builds a render-ready JSON picture of a table for the chat client's
// GameTable widget. STRICT RULE: this must never leak anything the player
// couldn't legally see — the dealer's hole card stays hidden during play,
// other players' hands are counts only, and trivia answers NEVER leave the
// server. The widget is purely decorative for sighted folks: every fact it
// shows is already spoken/written by the agent, and the whole thing is
// aria-hidden so screen-reader flow is completely unchanged (Kade's rule:
// visuals must not step on access).

const { scoreBlackjack, rankOf } = require('./deck');

function card(c) {
  // 'KH' -> { r: 'K', s: 'H' } (10 is two chars of rank)
  return { r: rankOf(c), s: c.slice(-1) };
}

function visualView(gameKey, state) {
  switch (gameKey) {
    case 'blackjack': {
      const done = state.phase !== 'player';
      return {
        kind: 'cards',
        seats: [
          {
            name: 'Dealer',
            cards: state.dealer.map((c, i) => (done || i === 0 ? card(c) : { back: true })),
            total: done ? scoreBlackjack(state.dealer).total : null,
          },
          { name: 'You', cards: state.player.map(card), total: scoreBlackjack(state.player).total, you: true },
        ],
        chips: state.bet * (state.doubled ? 2 : 1),
        result: state.result,
        over: done,
      };
    }
    case 'wild_eights': {
      const top = state.discard[state.discard.length - 1];
      return {
        kind: 'cards',
        seats: state.names.map((name, i) => ({
          name,
          you: i === 0,
          cards: i === 0 ? state.hands[0].map(card) : state.hands[i].map(() => ({ back: true })),
          turn: state.turn === i && state.status === 'active',
        })),
        pile: top ? card(top) : null,
        suit: state.suit || null,
        over: state.status === 'over',
        winner: state.winner,
      };
    }
    case 'uno': {
      const unoCard = (c) => {
        if (c === 'W') return { r: 'W', s: null };
        if (c === 'WD4') return { r: 'D4', s: null };
        return { r: c.slice(1), s: c[0] };
      };
      const top = state.discard[state.discard.length - 1];
      return {
        kind: 'cards',
        seats: state.names.map((name, i) => ({
          name,
          you: i === 0,
          cards: i === 0 ? state.hands[0].map(unoCard) : state.hands[i].map(() => ({ back: true })),
          turn: state.turn === i && state.status === 'active',
        })),
        pile: top ? unoCard(top) : null,
        suit: state.color || null,
        over: state.status === 'over',
        winner: state.winner,
      };
    }
    case 'go_fish': {
      return {
        kind: 'cards',
        seats: state.names.map((name, i) => ({
          name,
          you: i === 0,
          cards: i === 0 ? state.hands[0].map(card) : state.hands[i].map(() => ({ back: true })),
          books: (state.bookRanks && state.bookRanks[i]) || [],
          score: state.books[i],
          turn: state.turn === i && state.status === 'active',
        })),
        pool: state.deck.length,
        over: state.status === 'over',
        winner: state.winner,
      };
    }
    case 'pig': {
      return {
        kind: 'dice',
        seats: state.names.map((name, i) => ({
          name,
          you: i === 0,
          score: state.scores[i],
          turn: state.turn === i && state.status !== 'over',
        })),
        riding: state.turnPoints,
        target: 100,
        over: state.status === 'over',
        winner: state.winner,
      };
    }
    case 'trivia': {
      const done = state.status === 'over';
      const cur = !done && state.qs[state.idx] ? state.qs[state.idx] : null;
      return {
        kind: 'quiz',
        seats: state.names.map((name, i) => ({ name, you: i === 0, score: state.scores[i] })),
        round: Math.min(state.idx + 1, state.qs.length),
        rounds: state.qs.length,
        // question + options only — the answer key NEVER leaves the server
        question: cur ? { q: cur.q, options: cur.options, cat: cur.cat, diff: cur.diff } : null,
        over: done,
        winner: state.winner,
      };
    }
    default:
      return null;
  }
}

module.exports = { visualView };
