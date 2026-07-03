// Go Fish — engine-refereed. Seat 0 is the human; the rest are AI. Ask an
// opponent for a rank you already hold; if they have it you get all of them
// and go again, otherwise you "go fish" from the pond. Four of a kind = a book.
// Most books when the cards run out wins. Kid-friendly, great by voice.

const { makeDeck, shuffle, cardName, handWords, rankOf, RANK_WORD, RANKS } = require('./deck');

const meta = {
  key: 'go_fish',
  name: 'Go Fish',
  blurb: 'Ask for ranks, collect four-of-a-kind books. Easy, friendly, perfect by ear.',
  minPlayers: 2,
  maxPlayers: 4,
};

function pluralRank(r) {
  const w = RANK_WORD[r] || r;
  return w === 'Six' ? 'Sixes' : `${w}s`;
}

function newGame(opts = {}) {
  const n = Math.max(2, Math.min(4, (parseInt(opts.opponents, 10) || 1) + 1));
  const deck = shuffle(makeDeck());
  const hands = [];
  const books = [];
  const bookRanks = [];
  for (let i = 0; i < n; i++) { hands.push([]); books.push(0); bookRanks.push([]); }
  const per = n === 2 ? 7 : 5;
  for (let k = 0; k < per; k++) for (let i = 0; i < n; i++) hands[i].push(deck.pop());
  const names = ['You', ...(opts.names || []).slice(0, n - 1)];
  while (names.length < n) names.push(`Player ${names.length}`);
  const state = { g: 'go_fish', deck, hands, books, bookRanks, names, turn: 0, status: 'active', winner: null };
  for (let i = 0; i < n; i++) bookCheck(state, i, null);
  return state;
}

function counts(hand) {
  const m = {};
  for (const c of hand) { const r = rankOf(c); m[r] = (m[r] || 0) + 1; }
  return m;
}

function bookCheck(state, seat, log) {
  const m = counts(state.hands[seat]);
  for (const r of Object.keys(m)) {
    if (m[r] === 4) {
      state.hands[seat] = state.hands[seat].filter((c) => rankOf(c) !== r);
      state.books[seat] += 1;
      state.bookRanks[seat].push(r);
      if (log) log.push(`${state.names[seat]} completed a book of ${pluralRank(r)}!`);
    }
  }
}

function totalBooks(state) { return state.books.reduce((a, b) => a + b, 0); }

// Can any seat still make a legal ask? (needs a seat with cards AND another
// seat with cards). If not, and the deck is empty, the game can't progress.
function canAsk(state) {
  const withCards = state.hands.filter((h) => h.length > 0).length;
  return withCards >= 2;
}

function checkEnd(state, log) {
  if (totalBooks(state) >= 13 || (state.deck.length === 0 && !canAsk(state))) {
    state.status = 'over';
    const max = Math.max(...state.books);
    const leaders = state.books.map((b, i) => (b === max ? i : -1)).filter((i) => i >= 0);
    state.winner = leaders.length === 1 ? leaders[0] : 'tie';
    if (log) log.push('The cards are gone. Books tallied.');
    return true;
  }
  return false;
}

// Top up an empty hand at the start of a seat's turn (standard rule).
function startTurn(state, seat, log) {
  if (state.hands[seat].length === 0 && state.deck.length > 0) {
    const c = state.deck.pop();
    state.hands[seat].push(c);
    if (log && seat === 0) log.push(`You were out of cards, so you drew the ${cardName(c)}.`);
    bookCheck(state, seat, log);
  }
}

function draw(state) { return state.deck.length ? state.deck.pop() : null; }

// One ask by `seat` to `target` for rank `r`. Returns { again, sounds }.
function doAsk(state, seat, target, r, log) {
  const give = state.hands[target].filter((c) => rankOf(c) === r);
  const asker = state.names[seat];
  const askee = state.names[target];
  if (give.length > 0) {
    state.hands[target] = state.hands[target].filter((c) => rankOf(c) !== r);
    state.hands[seat].push(...give);
    log.push(`${asker} asked ${askee} for ${pluralRank(r)} — got ${give.length}.`);
    bookCheck(state, seat, log);
    return { again: true, sounds: ['correct_ding'] };
  }
  log.push(`${asker} asked ${askee} for ${pluralRank(r)} — Go Fish!`);
  const c = draw(state);
  if (!c) { log.push(`${asker} couldn't draw; the pond is empty.`); return { again: false, sounds: ['wrong_buzz'] }; }
  state.hands[seat].push(c);
  const drewAsked = rankOf(c) === r;
  if (seat === 0) log.push(`You drew the ${cardName(c)}.`);
  bookCheck(state, seat, log);
  if (drewAsked) { log.push(`${asker} fished the very ${RANK_WORD[r] || r} they asked for — go again!`); return { again: true, sounds: ['correct_ding'] }; }
  return { again: false, sounds: ['card_draw'] };
}

// A seat with cards but no valid target just draws (rare: everyone else is out
// but the pond still has cards). Keeps the game moving instead of deadlocking.
function fish(state, seat, log) {
  const c = draw(state);
  if (!c) return { sounds: [] };
  state.hands[seat].push(c);
  if (seat === 0) log.push(`No one to ask, so you fished the ${cardName(c)}.`);
  else log.push(`${state.names[seat]} fished a card.`);
  bookCheck(state, seat, log);
  return { sounds: ['card_draw'] };
}

function hasTarget(state, seat) {
  return state.hands.some((h, i) => i !== seat && h.length > 0);
}

function advance(state) {
  let guard = 0;
  do { state.turn = (state.turn + 1) % state.hands.length; guard++; }
  while (guard < state.hands.length && state.hands[state.turn].length === 0 && state.deck.length === 0);
}

function aiTurn(state, seat, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && state.turn === seat && guard < 30) {
    guard += 1;
    startTurn(state, seat, log);
    if (checkEnd(state, log)) break;
    const myCounts = counts(state.hands[seat]);
    const ranks = Object.keys(myCounts);
    if (ranks.length === 0) { advance(state); break; }
    if (!hasTarget(state, seat)) {
      sounds.push(...fish(state, seat, log).sounds);
      if (checkEnd(state, log)) break;
      advance(state);
      break;
    }
    const r = ranks[Math.floor(Math.random() * ranks.length)];
    const targets = state.hands.map((h, i) => i).filter((i) => i !== seat && state.hands[i].length > 0);
    const target = targets[Math.floor(Math.random() * targets.length)];
    const res = doAsk(state, seat, target, r, log);
    sounds.push(...res.sounds);
    if (checkEnd(state, log)) break;
    if (!res.again) { advance(state); break; }
  }
  return sounds;
}

function drive(state, log) {
  const sounds = [];
  let guard = 0;
  while (state.status === 'active' && guard < 300) {
    guard += 1;
    if (checkEnd(state, log)) break;
    if (state.turn === 0) {
      if (legal(state).length > 0) break;   // hand control back to the human
      advance(state);                        // human genuinely can't act; skip
      continue;
    }
    const before = state.turn;
    sounds.push(...aiTurn(state, state.turn, log)); // aiTurn advances internally
    if (state.turn === before && state.status === 'active') advance(state);
  }
  return sounds;
}

function legalAsks(state) {
  const ranks = [...new Set(state.hands[0].map(rankOf))].sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b));
  const targets = state.hands.map((h, i) => i).filter((i) => i !== 0 && state.hands[i].length > 0);
  const out = [];
  for (const t of targets) for (const r of ranks) out.push({ token: `ask_${t}_${r}`, label: `Ask ${state.names[t]} for ${pluralRank(r)}` });
  return out;
}

function legal(state) {
  if (state.status !== 'active' || state.turn !== 0) return [];
  const asks = legalAsks(state);
  if (asks.length) return asks;
  if (state.deck.length > 0) return [{ token: 'fish', label: state.hands[0].length ? 'Go fishing (draw a card)' : "You're out of cards — draw one" }];
  return [];
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
  if (state.turn !== 0) return { error: 'It is not your turn yet.' };
  const log = [];
  if (token === 'fish') {
    if (legalAsks(state).length > 0) return { error: 'You can ask an opponent — pick a rank and a player.' };
    if (state.deck.length === 0) return { error: 'The pond is empty; you cannot fish.' };
    const f = fish(state, 0, log);
    let sounds = f.sounds.slice();
    if (checkEnd(state, log)) return { sounds, log };
    if (legalAsks(state).length > 0) return { sounds, log }; // drew a usable card — go again
    advance(state);
    sounds = sounds.concat(drive(state, log));
    return { sounds, log };
  }
  if (!token || !token.startsWith('ask_')) return { error: `Ask an opponent for a rank you hold. Legal: ${legal(state).map((m) => m.token).join(', ')}.` };
  const parts = token.split('_');
  const target = parseInt(parts[1], 10);
  const r = parts.slice(2).join('_');
  if (!state.hands[target] || target === 0) return { error: 'No such opponent at the table.' };
  if (state.hands[target].length === 0) return { error: `${state.names[target]} is out of cards — ask someone else.` };
  if (!state.hands[0].some((c) => rankOf(c) === r)) return { error: `You can only ask for a rank you're holding. You don't have any ${pluralRank(r)}.` };
  const res = doAsk(state, 0, target, r, log);
  let sounds = res.sounds.slice();
  if (checkEnd(state, log)) return { sounds, log };
  // "Go again" only if the human genuinely has a move left; completing a book
  // can empty the hand, in which case the turn passes.
  if (res.again && legal(state).length > 0) return { sounds, log };
  advance(state);
  sounds = sounds.concat(drive(state, log));
  return { sounds, log };
}

function view(state) {
  const lines = [];
  const m = counts(state.hands[0]);
  const held = [...new Set(state.hands[0].map(rankOf))].sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b))
    .map((r) => `${m[r]}×${RANK_WORD[r] || r}`).join(', ');
  lines.push(`Your hand: ${held || 'empty'}.`);
  lines.push(`Books — ${state.names.map((nm, i) => `${nm}: ${state.books[i]}`).join(', ')}. Pond: ${state.deck.length} cards left.`);
  const over = state.status === 'over';
  let winner = null;
  let sounds = [];
  if (over) {
    if (state.winner === 'tie') { winner = 'tie'; lines.push("It's a tie on books!"); sounds = ['draw_game']; }
    else { winner = state.winner === 0 ? 'player' : state.names[state.winner]; lines.push(state.winner === 0 ? `You win with ${state.books[0]} books!` : `${state.names[state.winner]} wins with ${state.books[state.winner]} books.`); sounds = state.winner === 0 ? ['win_fanfare'] : ['lose_trombone']; }
  }
  return { lines, legal: legal(state), sounds, over, winner };
}

module.exports = { meta, newGame, view, move, legal };
