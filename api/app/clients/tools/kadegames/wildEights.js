// Wild Eights — our crazy-eights. Engine-refereed. Seat 0 is the human; the
// rest are engine-driven AI opponents so one person can play right away.
// Match the top card's rank or suit, or drop an Eight (wild) and call a suit.
// First to empty their hand wins. Eights are wild; there are no reverses.

const { makeDeck, shuffle, cardName, handWords, rankOf, suitOf, SUIT_WORD, SUITS } = require('./deck');

const meta = {
  key: 'wild_eights',
  name: 'Wild Eights',
  blurb: 'Our crazy-eights. Match rank or suit, dump an Eight to change the suit, empty your hand first.',
  minPlayers: 2,
  maxPlayers: 4,
};

function code(c) { return rankOf(c) + suitOf(c); }
function parseCode(x) { return { r: x.slice(0, -1), s: x.slice(-1) }; }

function top(state) { return state.discard[state.discard.length - 1]; }

function playable(c, state) {
  const r = rankOf(c);
  if (r === '8') return true;
  return r === rankOf(top(state)) || suitOf(c) === state.suit;
}

function refill(state) {
  if (state.deck.length > 0) return;
  if (state.discard.length <= 1) return;
  const keep = state.discard.pop();
  state.deck = shuffle(state.discard);
  state.discard = [keep];
}

function draw(state, seat) {
  refill(state);
  if (state.deck.length === 0) return null;
  const c = state.deck.pop();
  state.hands[seat].push(c);
  return c;
}

function newGame(opts = {}) {
  const n = Math.max(2, Math.min(4, (parseInt(opts.opponents, 10) || 1) + 1));
  const deck = shuffle(makeDeck());
  const hands = [];
  for (let i = 0; i < n; i++) hands.push([]);
  const per = n === 2 ? 7 : 5;
  for (let k = 0; k < per; k++) for (let i = 0; i < n; i++) hands[i].push(deck.pop());
  // Flip a starter that isn't an 8.
  let starter = deck.pop();
  while (rankOf(starter) === '8') { deck.unshift(starter); starter = deck.pop(); }
  const names = ['You', ...(opts.names || []).slice(0, n - 1)];
  while (names.length < n) names.push(`Player ${names.length}`);
  return {
    g: 'wild_eights',
    deck,
    discard: [starter],
    suit: suitOf(starter),
    hands,
    turn: 0,
    names,
    drew: false,
    status: 'active',
    winner: null,
  };
}

function legalFor(state, seat) {
  const hand = state.hands[seat];
  const out = [];
  for (const c of hand) {
    if (!playable(c, state)) continue;
    if (rankOf(c) === '8') {
      for (const s of SUITS) out.push({ token: `play_${code(c)}_${s}`, label: `Play the ${cardName(c)}, call ${SUIT_WORD[s]}`, card: c, suit: s });
    } else {
      out.push({ token: `play_${code(c)}`, label: `Play the ${cardName(c)}`, card: c });
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
  if (state.drew || (!canDraw && plays.length === 0)) moves.push({ token: 'pass', label: 'Pass' });
  return moves;
}

// Frozen-table check (bug fix July 4 2026): pile dead (no deck, nothing to
// reshuffle) AND no seat holds a playable card = the game can never move
// again. Classic table rule: fewest cards takes it; even counts tie.
// Without this, the table pass-looped forever (same family as the old
// Go Fish deadlock).
function deadCheck(state) {
  if (state.status !== 'active') return false;
  if (state.deck.length > 0 || state.discard.length > 1) return false;
  for (const hand of state.hands) {
    if (hand.some((c) => playable(c, state))) return false;
  }
  const min = Math.min(...state.hands.map((h) => h.length));
  const leaders = state.hands.map((h, i) => (h.length === min ? i : -1)).filter((i) => i >= 0);
  state.status = 'over';
  state.winner = leaders.length === 1 ? leaders[0] : 'tie';
  state.endedBy = 'deadpile';
  return true;
}

function advance(state) {
  state.drew = false;
  state.turn = (state.turn + 1) % state.hands.length;
  deadCheck(state);
}

function applyPlay(state, seat, cardCode, declaredSuit, log) {
  const hand = state.hands[seat];
  const idx = hand.findIndex((c) => code(c) === cardCode);
  if (idx === -1) return { error: 'You are not holding that card.' };
  const c = hand[idx];
  if (!playable(c, state)) return { error: `The ${cardName(c)} doesn't match. You need a ${rankOf(top(state))} or a ${SUIT_WORD[state.suit]}, or an Eight.` };
  hand.splice(idx, 1);
  state.discard.push(c);
  if (rankOf(c) === '8') state.suit = declaredSuit && SUITS.includes(declaredSuit) ? declaredSuit : suitOf(c);
  else state.suit = suitOf(c);
  const who = state.names[seat];
  log.push(`${who} played the ${cardName(c)}${rankOf(c) === '8' ? `, calling ${SUIT_WORD[state.suit]}` : ''}.`);
  if (hand.length === 0) { state.status = 'over'; state.winner = seat; }
  else if (hand.length === 1) log.push(`${who} is down to one card!`);
  return { ok: true, eight: rankOf(c) === '8' };
}

// Simple opponent brain: play a legal non-8 dumping the highest card; save 8s
// unless nothing else works; when playing an 8, call this seat's most-common suit.
function aiTurn(state, seat, log) {
  const sounds = [];
  const hand = state.hands[seat];
  let plays = hand.filter((c) => playable(c, state));
  if (plays.length === 0) {
    const d = draw(state, seat);
    if (d) { log.push(`${state.names[seat]} drew a card.`); sounds.push('card_draw'); }
    plays = hand.filter((c) => playable(c, state));
  }
  if (plays.length === 0) { log.push(`${state.names[seat]} passed.`); advance(state); return sounds; }
  const nonEights = plays.filter((c) => rankOf(c) !== '8');
  const pick = (nonEights.length ? nonEights : plays)[0];
  let declared = null;
  if (rankOf(pick) === '8') {
    const counts = {};
    for (const c of hand) if (code(c) !== code(pick)) counts[suitOf(c)] = (counts[suitOf(c)] || 0) + 1;
    declared = SUITS.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
    sounds.push('uno_sting');
  }
  applyPlay(state, seat, code(pick), declared, log);
  sounds.push('card_slap');
  if (state.status === 'active') advance(state);
  return sounds;
}

function runAI(state, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && state.turn !== 0 && guard < 40) {
    guard += 1;
    sounds.push(...aiTurn(state, state.turn, log));
  }
  return sounds;
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'It is not your turn yet.' };
  const log = [];
  let sounds = [];
  if (token === 'draw') {
    if (state.drew) return { error: 'You already drew this turn. Play a card or pass.' };
    const d = draw(state, 0);
    if (!d) return { error: 'The draw pile is empty. You have to pass.' };
    state.drew = true;
    return { sounds: ['card_draw'], log: [`You drew the ${cardName(d)}.`] };
  }
  if (token === 'pass') {
    // move() must enforce what legal() offers (bug fix July 4 2026: a bare
    // 'pass' used to sail through even with plays + draws available).
    const plays = legalFor(state, 0);
    const canDraw = state.deck.length > 0 || state.discard.length > 1;
    if (!state.drew && canDraw) {
      return { error: plays.length ? 'No free passes — play a card, or draw first.' : 'Nothing playable? Draw a card first; then you can pass.' };
    }
    if (!state.drew && !canDraw && plays.length > 0) {
      return { error: 'You have a playable card, so you have to play it.' };
    }
    advance(state);
    log.push('You passed.');
    sounds = ['card_slap', ...runAI(state, log)];
    return { sounds, log };
  }
  if (token.startsWith('play_')) {
    const parts = token.slice(5).split('_');
    const cardCode = parts[0];
    const declared = parts[1] || null;
    const res = applyPlay(state, 0, cardCode, declared, log);
    if (res.error) return { error: res.error };
    sounds = ['card_slap'];
    if (state.status === 'active') { advance(state); sounds.push(...runAI(state, log)); }
    else sounds.push('win_fanfare');
    return { sounds, log };
  }
  return { error: `Not a legal move. Legal: ${legal(state).map((m) => m.token).join(', ')}.` };
}

function view(state) {
  const lines = [];
  lines.push(`Top of the pile: ${cardName(top(state))}. Active suit: ${SUIT_WORD[state.suit]}.`);
  const counts = state.hands.map((h, i) => `${state.names[i]}: ${h.length}`).slice(1).join(', ');
  if (counts) lines.push(`Cards left — ${counts}.`);
  lines.push(`Your hand (${state.hands[0].length}): ${handWords(state.hands[0]) || 'empty'}.`);
  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    if (state.winner === 'tie') {
      winner = 'tie';
      lines.push("The pile went dead and nobody could move — even cards, so it's a tie!");
      sounds = ['draw_game'];
    } else {
      winner = state.winner === 0 ? 'player' : state.names[state.winner];
      const how = state.endedBy === 'deadpile' ? 'had the fewest cards when the pile went dead' : 'went out';
      lines.push(state.winner === 0 ? `You ${how} — you win!` : `${state.names[state.winner]} ${how} and wins this hand.`);
      sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone'];
    }
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
