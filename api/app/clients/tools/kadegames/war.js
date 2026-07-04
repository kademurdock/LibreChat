// War — the classic card game, engine-refereed. Two players: seat 0 is the
// human, the house plays the other half of the deck. Flip cards, higher rank
// wins both; ties trigger WAR (three down, one up). Ace is HIGH here (14),
// unlike deck.js's RANK_ORDER. Zero decisions = pure sound-and-drama, great
// on the phone. Engine core written by Forge (devbox war.js, July 4 2026);
// reshaped to the kadegames module contract (state/view/move) this session.

const { makeDeck, shuffle, rankOf, cardName } = require('./deck');

const WAR_RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

// Games of War can theoretically run forever; past this many flips the bigger
// stack takes it so a phone game can't outlive the caller.
const MAX_ROUNDS = 500;

const meta = {
  key: 'war',
  name: 'War',
  blurb: 'Flip cards, higher rank wins both. Ties mean WAR — three down, one up, winner takes the pile.',
  minPlayers: 2,
  maxPlayers: 2,
  dealSounds: ['card_shuffle', 'card_deal'],
};

function newGame() {
  const deck = shuffle(makeDeck());
  return {
    g: 'war',
    playerDeck: deck.slice(0, 26),
    aiDeck: deck.slice(26),
    playerWon: [],
    aiWon: [],
    warPile: [],
    round: 0,
    phase: 'flip', // 'flip' | 'war'
    lastPlayerCard: null,
    lastAiCard: null,
    status: 'active',
    winner: null, // 'player' | 'ai'
  };
}

function totalOf(state, who) {
  return who === 'player'
    ? state.playerDeck.length + state.playerWon.length
    : state.aiDeck.length + state.aiWon.length;
}

// Draw from the face-down deck; when it empties, shuffle the won pile in.
function drawCard(state, who) {
  const deckKey = who === 'player' ? 'playerDeck' : 'aiDeck';
  const wonKey = who === 'player' ? 'playerWon' : 'aiWon';
  if (state[deckKey].length === 0 && state[wonKey].length === 0) return null;
  if (state[deckKey].length === 0) {
    state[deckKey] = shuffle(state[wonKey]);
    state[wonKey] = [];
  }
  return state[deckKey].shift();
}

function endGame(state, winner) {
  state.status = 'over';
  state.winner = winner;
  state.phase = 'flip';
}

function awardPile(state, winner, log, sounds) {
  const pileSize = state.warPile.length;
  if (winner === 'player') state.playerWon.push(...state.warPile);
  else state.aiWon.push(...state.warPile);
  state.warPile = [];
  log.push(`${winner === 'player' ? 'You take' : 'The house takes'} the pile — ${pileSize} cards.`);
  sounds.push(winner === 'player' ? 'chip_win' : 'card_slap');
  state.lastPlayerCard = null;
  state.lastAiCard = null;
  state.phase = 'flip';
  // A side with zero cards after the pile settles has lost.
  if (totalOf(state, 'player') === 0) endGame(state, 'ai');
  else if (totalOf(state, 'ai') === 0) endGame(state, 'player');
  else if (state.round >= MAX_ROUNDS) {
    endGame(state, totalOf(state, 'player') >= totalOf(state, 'ai') ? 'player' : 'ai');
    log.push(`That's ${MAX_ROUNDS} flips — calling it on cards held.`);
  }
}

function resolveFlip(state, pCard, aCard, log, sounds, isWar) {
  state.lastPlayerCard = pCard;
  state.lastAiCard = aCard;
  log.push(`You flip the ${cardName(pCard)}. The house flips the ${cardName(aCard)}.`);
  sounds.push('card_flip');
  const pVal = WAR_RANK_VALUE[rankOf(pCard)];
  const aVal = WAR_RANK_VALUE[rankOf(aCard)];
  if (pVal > aVal) awardPile(state, 'player', log, sounds);
  else if (aVal > pVal) awardPile(state, 'ai', log, sounds);
  else {
    state.phase = 'war';
    log.push(isWar ? 'ANOTHER tie — the war goes DEEPER!' : `Tied at ${rankOf(pCard)} — that means WAR!`);
    sounds.push('dice_shake');
  }
}

function view(state) {
  if (state.status === 'over') {
    const won = state.winner === 'player';
    return {
      lines: [
        `Game over after ${state.round} flips. ${won ? 'You win the whole deck!' : 'The house takes it.'}`,
      ],
      legal: [],
      over: true,
      sounds: won ? ['win_fanfare'] : [],
    };
  }
  const lines = [
    `Round ${state.round + 1}. You hold ${totalOf(state, 'player')} cards, the house holds ${totalOf(state, 'ai')}.`,
  ];
  let legal;
  if (state.phase === 'war') {
    lines.push(`WAR is on (tied at ${rankOf(state.lastPlayerCard)}) — each side lays three cards face down and flips a fourth. Winner takes the whole pile (${state.warPile.length} cards in it so far).`);
    legal = [{ token: 'war', label: 'Go to war — three down, flip the fourth' }];
  } else {
    legal = [{ token: 'flip', label: 'Flip your next card' }];
  }
  return { lines, legal, over: false, sounds: [] };
}

function move(state, token) {
  if (state.status !== 'active') return { log: [], sounds: [] };
  const log = [];
  const sounds = [];

  if (token === 'flip' && state.phase === 'flip') {
    const pCard = drawCard(state, 'player');
    if (pCard) state.warPile.push(pCard);
    else { endGame(state, 'ai'); return { log: ['You are out of cards.'], sounds }; }
    const aCard = drawCard(state, 'ai');
    if (aCard) state.warPile.push(aCard);
    else { state.playerWon.push(...state.warPile); state.warPile = []; endGame(state, 'player'); return { log: ['The house is out of cards.'], sounds: ['win_fanfare'] }; }
    state.round += 1;
    resolveFlip(state, pCard, aCard, log, sounds, false);
    return { log, sounds };
  }

  if (token === 'war' && state.phase === 'war') {
    for (let i = 0; i < 3; i++) {
      const p = drawCard(state, 'player');
      const a = drawCard(state, 'ai');
      if (p) state.warPile.push(p);
      if (a) state.warPile.push(a);
    }
    log.push('Three cards down from each side…');
    sounds.push('card_draw');
    const pCard = drawCard(state, 'player');
    if (pCard) state.warPile.push(pCard);
    else { state.aiWon.push(...state.warPile); state.warPile = []; endGame(state, 'ai'); return { log: [...log, 'You ran dry mid-war — the house takes it.'], sounds }; }
    const aCard = drawCard(state, 'ai');
    if (aCard) state.warPile.push(aCard);
    else { state.playerWon.push(...state.warPile); state.warPile = []; endGame(state, 'player'); return { log: [...log, 'The house ran dry mid-war — you take it all!'], sounds: ['win_fanfare'] }; }
    state.round += 1;
    resolveFlip(state, pCard, aCard, log, sounds, true);
    return { log, sounds };
  }

  return { error: `Not a legal move. Legal: ${view(state).legal.map((m) => m.token).join(', ')}.` };
}

module.exports = { meta, newGame, view, move };
