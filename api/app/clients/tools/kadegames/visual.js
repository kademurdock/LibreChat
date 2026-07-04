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
const battleshipMod = require('./battleship');

function card(c) {
  // 'K:H' -> { r: 'K', s: 'H' } (deck.js compact strings, rank:suit)
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
    case 'war': {
      const done = state.status === 'over';
      const flip = (c) => (c ? card(c) : { back: true });
      return {
        kind: 'cards',
        seats: [
          { name: 'The house', cards: [flip(state.lastAiCard)], total: state.aiDeck.length + state.aiWon.length },
          { name: 'You', cards: [flip(state.lastPlayerCard)], total: state.playerDeck.length + state.playerWon.length, you: true },
        ],
        pool: state.warPile.length,
        over: done,
        winner: state.winner,
      };
    }
    /* ---------- July 4 2026 overnight additions ---------- */
    case 'cards_against_reality':
    case 'crab_apples': {
      const done = state.status === 'over';
      const judging = state.phase === 'judge';
      return {
        kind: 'quiz',
        seats: state.names.map((name, i) => ({ name, you: i === 0, score: state.scores[i] })),
        round: state.round,
        rounds: state.target,
        // your own hand while playing, anonymized submissions while judging —
        // nothing here the player can't legally see
        question: done ? null : {
          q: state.prompt,
          options: judging ? state.subs.map((sub) => sub.card) : state.hands[0],
          cat: gameKey === 'cards_against_reality' ? 'Cards Against Reality' : 'Crab Apples',
          diff: judging ? 'you judge' : `${state.names[state.judge]} judges`,
        },
        over: done,
        winner: state.winner,
      };
    }
    case 'sound_guess': {
      const done = state.status === 'over';
      const cur = !done && state.qs[state.idx] ? state.qs[state.idx] : null;
      return {
        kind: 'quiz',
        seats: state.names.map((name, i) => ({ name, you: i === 0, score: state.scores[i] })),
        round: Math.min(state.idx + 1, state.qs.length),
        rounds: state.qs.length,
        // options only — the cue name and answer index NEVER leave the server
        question: cur ? { q: 'What was that sound?', options: cur.options, cat: 'Guess the Sound', diff: '' } : null,
        over: done,
        winner: state.winner,
      };
    }
    case 'battleship': {
      return {
        kind: 'grid',
        grids: battleshipMod.grids(state),
        seats: [],
        over: state.status === 'over',
        winner: state.winner === 'player' ? 'player' : state.winner ? 'The house' : null,
      };
    }
    case 'tictactoe': {
      const cells = [[], [], []];
      state.board.forEach((v, i) => {
        cells[Math.floor(i / 3)].push(v === 'X' ? 'x' : v === 'O' ? 'o' : '');
      });
      return {
        kind: 'grid',
        grids: [{ name: 'You are X', cells }],
        seats: [],
        over: state.status === 'over',
        winner: state.winner,
      };
    }
    case 'liars_dice': {
      const over = state.status === 'over';
      const rows = [
        { label: 'Your dice', value: state.dice[0] ? state.dice[0].join('  ') : '', strong: true },
        {
          label: 'Bid',
          value: state.bid ? `${state.bid.count} × ${state.bid.face}s (${state.names[state.bid.seat]})` : '—',
        },
        ...state.names.map((n, i) => ({ label: n, value: `${state.diceCounts[i]} dice` })),
      ];
      return { kind: 'board', rows, seats: [], over, winner: over ? (state.winner === 0 ? 'player' : state.names[state.winner]) : null };
    }
    case 'farkle': {
      const over = state.status === 'over';
      const rows = [
        { label: 'Live roll', value: state.dice.join('  ') || '—', strong: true },
        { label: 'Set aside', value: state.kept.join('  ') || '—' },
        { label: 'Riding', value: String(state.turnPoints) },
        ...state.names.map((n, i) => ({ label: n, value: `${state.scores[i]} / ${state.target}` })),
      ];
      return { kind: 'board', rows, seats: [], over, winner: over ? (state.winner === 0 ? 'player' : state.names[state.winner]) : null };
    }
    case 'hangman': {
      const over = state.status === 'over';
      const masked = state.word
        .split('')
        .map((ch) => (ch === ' ' ? ' / ' : state.guessed.includes(ch) || over ? ch.toUpperCase() : '_'))
        .join(' ');
      const missed = state.guessed.filter((c) => !state.word.includes(c));
      const rows = [
        { label: '', value: masked, strong: true },
        { label: 'Missed', value: missed.map((c) => c.toUpperCase()).join(' ') || '—' },
        { label: 'Lives', value: String(6 - state.misses) },
      ];
      return { kind: 'board', rows, seats: [], over, winner: over ? state.winner : null };
    }
    case 'scramble': {
      const over = state.status === 'over';
      const rows = over
        ? [{ label: 'Final score', value: `${state.score} (par ${state.words.length})`, strong: true }]
        : [
            { label: `Word ${state.idx + 1} of ${state.words.length}`, value: state.scrambles[state.idx].toUpperCase().split('').join(' '), strong: true },
            { label: 'Score', value: `${state.score} (par ${state.words.length})` },
          ];
      return { kind: 'board', rows, seats: [], over, winner: over ? state.winner : null };
    }
    case 'in_between': {
      const over = state.status === 'over';
      return {
        kind: 'cards',
        seats: [
          { name: 'The posts', cards: state.posts ? state.posts.map(card) : [] },
          { name: 'Your draw', cards: state.drawn ? [card(state.drawn)] : [{ back: true }], you: true },
        ],
        chips: state.bank,
        over,
        winner: over ? state.winner : null,
      };
    }
    case 'rps': {
      const over = state.status === 'over';
      const last = state.history.slice(-3).map((h) => `${h.p[0].toUpperCase()}${h.p.slice(1)} vs ${h.a}`).join(' · ');
      const rows = [
        { label: 'Score', value: `You ${state.you} — House ${state.house} (first to ${state.need})`, strong: true },
        { label: 'Recent', value: last || '—' },
      ];
      return { kind: 'board', rows, seats: [], over, winner: over ? state.winner : null };
    }
    case 'madlibs': {
      const over = state.status === 'over';
      const rows = over
        ? [{ label: 'The story is told', value: '— scroll the chat for the reveal —', strong: true }]
        : [
            { label: 'Words collected', value: `${state.words.length}`, strong: true },
            { label: 'Last word', value: state.words.length ? `"${state.words[state.words.length - 1]}"` : '—' },
          ];
      return { kind: 'board', rows, seats: [], over, winner: null };
    }
    default:
      return null;
  }
}

module.exports = { visualView };
