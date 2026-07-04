// Uno — the classic shedding game. Engine-refereed. Seat 0 is the human;
// the rest are engine-driven AI opponents. Match the top card's color or
// type, or play a Wild and call a color. Action cards: Skip, Reverse,
// Draw Two, Wild, Wild Draw Four. First to empty their hand wins.
// Two-player Reverse acts as a Skip (standard Uno rule).

const { shuffle } = require('./deck');

const COLORS = ['R', 'Y', 'G', 'B'];
const COLOR_WORD = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };
const TYPE_WORD = {
  '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
  '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine',
  S: 'Skip', V: 'Reverse', D2: 'Draw Two',
};

const meta = {
  key: 'uno',
  name: 'Uno',
  blurb: 'The classic. Match color or type, drop a Wild and call a color, slam action cards to mess with opponents. Empty your hand first.',
  minPlayers: 2,
  maxPlayers: 4,
};

// Card encoding (compact strings for small persisted state):
// Colored: color + type, e.g. "R0", "R9", "RS" (skip), "RV" (reverse), "RD2" (draw two).
// Wilds: "W" (wild), "WD4" (wild draw four).

function colorOf(c) {
  if (c === 'W' || c === 'WD4') return null;
  return c[0];
}

function typeOf(c) {
  if (c === 'W') return 'W';
  if (c === 'WD4') return 'D4';
  return c.slice(1);
}

function cardName(c) {
  if (c === 'W') return 'Wild';
  if (c === 'WD4') return 'Wild Draw Four';
  return `${COLOR_WORD[colorOf(c)]} ${TYPE_WORD[typeOf(c)] || typeOf(c)}`;
}

function handWords(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function makeUnoDeck() {
  const deck = [];
  for (const col of COLORS) {
    deck.push(`${col}0`); // one zero per color
    for (let i = 1; i <= 9; i++) {
      deck.push(`${col}${i}`);
      deck.push(`${col}${i}`); // two of each 1-9
    }
    deck.push(`${col}S`, `${col}S`); // two skip
    deck.push(`${col}V`, `${col}V`); // two reverse
    deck.push(`${col}D2`, `${col}D2`); // two draw two
  }
  for (let i = 0; i < 4; i++) {
    deck.push('W'); // four wild
    deck.push('WD4'); // four wild draw four
  }
  return deck; // 108 cards
}

function top(state) {
  return state.discard[state.discard.length - 1];
}

function playable(c, state) {
  if (c === 'W' || c === 'WD4') return true;
  if (colorOf(c) === state.color) return true;
  const tc = top(state);
  if (colorOf(tc) !== null && typeOf(c) === typeOf(tc)) return true;
  return false;
}

function refill(state) {
  if (state.deck.length > 0) return;
  if (state.discard.length <= 1) return;
  const keep = state.discard.pop();
  state.deck = shuffle(state.discard);
  state.discard = [keep];
}

function drawCard(state, seat) {
  refill(state);
  if (state.deck.length === 0) return null;
  const c = state.deck.pop();
  state.hands[seat].push(c);
  return c;
}

function newGame(opts = {}) {
  const n = Math.max(2, Math.min(4, (parseInt(opts.opponents, 10) || 1) + 1));
  const deck = shuffle(makeUnoDeck());
  const hands = [];
  for (let i = 0; i < n; i++) hands.push([]);
  for (let k = 0; k < 7; k++) for (let i = 0; i < n; i++) hands[i].push(deck.pop());
  // Flip a starter that's a plain number card (no action, no wild).
  let starter = deck.pop();
  while (starter === 'W' || starter === 'WD4' || ['S', 'V', 'D2'].includes(typeOf(starter))) {
    deck.unshift(starter);
    starter = deck.pop();
  }
  const names = ['You', ...(opts.names || []).slice(0, n - 1)];
  while (names.length < n) names.push(`Player ${names.length}`);
  return {
    g: 'uno',
    deck,
    discard: [starter],
    color: colorOf(starter),
    hands,
    turn: 0,
    direction: 1,
    names,
    drew: false,
    status: 'active',
    winner: null,
  };
}

function nextSeat(state, from) {
  return (from + state.direction + state.hands.length) % state.hands.length;
}

function legalFor(state, seat) {
  const hand = state.hands[seat];
  const out = [];
  for (const c of hand) {
    if (!playable(c, state)) continue;
    if (c === 'W') {
      for (const s of COLORS)
        out.push({ token: `play_W_${s}`, label: `Play Wild, call ${COLOR_WORD[s]}` });
    } else if (c === 'WD4') {
      for (const s of COLORS)
        out.push({ token: `play_WD4_${s}`, label: `Play Wild Draw Four, call ${COLOR_WORD[s]}` });
    } else {
      out.push({ token: `play_${c}`, label: `Play the ${cardName(c)}` });
    }
  }
  return out;
}

function legal(state) {
  if (state.status !== 'active' || state.turn !== 0) return [];
  const plays = legalFor(state, 0);
  const moves = plays.map((p) => ({ token: p.token, label: p.label }));
  const canDraw = state.deck.length > 0 || state.discard.length > 1;
  if (!state.drew && canDraw) moves.push({ token: 'draw', label: 'Draw a card' });
  if (state.drew || (!canDraw && plays.length === 0))
    moves.push({ token: 'pass', label: 'Pass' });
  return moves;
}

function advance(state, skip = false) {
  state.drew = false;
  if (skip) {
    state.turn = nextSeat(state, nextSeat(state, state.turn));
  } else {
    state.turn = nextSeat(state, state.turn);
  }
}

function applyPlay(state, seat, cardCode, declaredColor, log) {
  const hand = state.hands[seat];
  const idx = hand.indexOf(cardCode);
  if (idx === -1) return { error: 'You are not holding that card.' };
  const c = hand[idx];
  if (!playable(c, state))
    return { error: `The ${cardName(c)} doesn't match. You need a ${COLOR_WORD[state.color] || state.color}, a ${typeOf(top(state))}, or a Wild.` };
  hand.splice(idx, 1);
  state.discard.push(c);

  let skipNext = false;
  let drawPenalty = 0;

  if (c === 'W') {
    state.color = declaredColor && COLORS.includes(declaredColor) ? declaredColor : COLORS[0];
    log.push(`${state.names[seat]} played Wild, calling ${COLOR_WORD[state.color]}.`);
  } else if (c === 'WD4') {
    state.color = declaredColor && COLORS.includes(declaredColor) ? declaredColor : COLORS[0];
    drawPenalty = 4;
    skipNext = true;
    log.push(`${state.names[seat]} played Wild Draw Four, calling ${COLOR_WORD[state.color]}.`);
  } else {
    state.color = colorOf(c);
    const t = typeOf(c);
    if (t === 'S') {
      skipNext = true;
      log.push(`${state.names[seat]} played the ${cardName(c)}. ${state.names[nextSeat(state, seat)]} is skipped!`);
    } else if (t === 'V') {
      state.direction *= -1;
      if (state.hands.length === 2) {
        skipNext = true;
        log.push(`${state.names[seat]} played the ${cardName(c)}. In a two-player game, that skips the opponent!`);
      } else {
        log.push(`${state.names[seat]} played the ${cardName(c)}. Direction reversed!`);
      }
    } else if (t === 'D2') {
      drawPenalty = 2;
      skipNext = true;
      log.push(`${state.names[seat]} played the ${cardName(c)}.`);
    } else {
      log.push(`${state.names[seat]} played the ${cardName(c)}.`);
    }
  }

  if (hand.length === 0) {
    state.status = 'over';
    state.winner = seat;
  } else if (hand.length === 1) {
    log.push(`${state.names[seat]} has one card left — Uno!`);
  }

  return { ok: true, skipNext, drawPenalty };
}

// AI brain: prefer colored action cards to disrupt, then high numbers.
// Save wilds for when nothing else works. Call the color you hold the most of.
function aiTurn(state, seat, log) {
  const sounds = [];
  const hand = state.hands[seat];
  let plays = hand.filter((c) => playable(c, state));

  if (plays.length === 0) {
    const d = drawCard(state, seat);
    if (d) {
      log.push(`${state.names[seat]} drew a card.`);
      sounds.push('card_draw');
    }
    plays = hand.filter((c) => playable(c, state));
  }

  if (plays.length === 0) {
    log.push(`${state.names[seat]} passed.`);
    advance(state);
    return sounds;
  }

  const colored = plays.filter((c) => c !== 'W' && c !== 'WD4');
  const wilds = plays.filter((c) => c === 'W' || c === 'WD4');

  let pick;
  if (colored.length > 0) {
    const actions = colored.filter((c) => ['S', 'V', 'D2'].includes(typeOf(c)));
    if (actions.length > 0) {
      pick = actions[0];
    } else {
      const numbers = colored
        .filter((c) => !isNaN(parseInt(typeOf(c), 10)))
        .sort((a, b) => parseInt(typeOf(b), 10) - parseInt(typeOf(a), 10));
      pick = numbers.length > 0 ? numbers[0] : colored[0];
    }
  } else {
    // Must play a wild. Prefer regular Wild over Wild Draw Four.
    pick = wilds.includes('W') ? 'W' : wilds[0];
  }

  let declared = null;
  if (pick === 'W' || pick === 'WD4') {
    const counts = {};
    for (const c of hand) {
      if (c === pick || c === 'W' || c === 'WD4') continue;
      const col = colorOf(c);
      if (col) counts[col] = (counts[col] || 0) + 1;
    }
    declared = COLORS.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
    sounds.push('uno_sting');
  }

  const res = applyPlay(state, seat, pick, declared, log);
  sounds.push('card_slap');

  if (res.drawPenalty > 0) {
    const target = nextSeat(state, seat);
    for (let i = 0; i < res.drawPenalty; i++) drawCard(state, target);
    log.push(`${state.names[target]} draws ${res.drawPenalty} cards.`);
    sounds.push('card_draw');
  }

  if (state.status === 'active') {
    advance(state, res.skipNext);
  }

  return sounds;
}

function runAI(state, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && state.turn !== 0 && guard < 60) {
    guard += 1;
    sounds.push(...aiTurn(state, state.turn, log));
  }
  return sounds;
}

function move(state, token) {
  if (state.status !== 'active')
    return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'It is not your turn yet.' };

  const log = [];
  let sounds = [];

  if (token === 'draw') {
    if (state.drew) return { error: 'You already drew this turn. Play a card or pass.' };
    const d = drawCard(state, 0);
    if (!d) return { error: 'The draw pile is empty. You have to pass.' };
    state.drew = true;
    return { sounds: ['card_draw'], log: [`You drew the ${cardName(d)}.`] };
  }

  if (token === 'pass') {
    advance(state);
    log.push('You passed.');
    sounds = ['card_slap', ...runAI(state, log)];
    return { sounds, log };
  }

  if (token.startsWith('play_')) {
    const rest = token.slice(5);
    let cardCode, declared;
    if (rest.startsWith('WD4_')) {
      cardCode = 'WD4';
      declared = rest.slice(4);
    } else if (rest.startsWith('W_')) {
      cardCode = 'W';
      declared = rest.slice(2);
    } else {
      cardCode = rest;
      declared = null;
    }

    const res = applyPlay(state, 0, cardCode, declared, log);
    if (res.error) return { error: res.error };

    sounds = ['card_slap'];

    if (res.drawPenalty > 0) {
      const target = nextSeat(state, 0);
      for (let i = 0; i < res.drawPenalty; i++) drawCard(state, target);
      log.push(`${state.names[target]} draws ${res.drawPenalty} cards and is skipped!`);
      sounds.push('card_draw');
    }

    if (state.status === 'active') {
      advance(state, res.skipNext);
      sounds.push(...runAI(state, log));
    } else {
      sounds.push('win_fanfare');
    }

    return { sounds, log };
  }

  return { error: `Not a legal move. Legal: ${legal(state).map((m) => m.token).join(', ')}.` };
}

function view(state) {
  const lines = [];
  const topCard = top(state);
  lines.push(`Top of the pile: ${cardName(topCard)}. Active color: ${COLOR_WORD[state.color] || state.color}.`);
  const counts = state.hands
    .map((h, i) => `${state.names[i]}: ${h.length}`)
    .slice(1)
    .join(', ');
  if (counts) lines.push(`Cards left — ${counts}.`);
  lines.push(`Your hand (${state.hands[0].length}): ${handWords(state.hands[0]) || 'empty'}.`);

  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    winner = state.winner === 0 ? 'player' : state.names[state.winner];
    lines.push(
      state.winner === 0
        ? 'You went out — you win!'
        : `${state.names[state.winner]} went out and wins this hand.`
    );
    sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone'];
  }

  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
