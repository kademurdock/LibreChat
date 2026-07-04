// Shared card utilities for the Kade-AI Game Parlor.
// Voice-first: every card can be spoken aloud ("Ace of Spades").
// Pure functions + a plain RNG; deck lives inside the persisted game state.

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_WORD = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANK_WORD = {
  A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King',
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six',
  7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten',
};

// A card is the compact string "R:S", e.g. "A:S", "10:H". Compact so state stays small.
function card(r, s) {
  return `${r}:${s}`;
}
function rankOf(c) {
  return c.split(':')[0];
}
function suitOf(c) {
  return c.split(':')[1];
}

// Human/voice name: "Ace of Spades".
function cardName(c) {
  const [r, s] = c.split(':');
  return `${RANK_WORD[r] || r} of ${SUIT_WORD[s] || s}`;
}

// A short spoken list, e.g. "Ace of Spades, King of Hearts, and the Four of Clubs".
function handWords(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(card(r, s));
  return d;
}

// Fisher–Yates using Math.random (shuffle happens once at deal, then persisted).
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Blackjack-style value of a rank (Ace handled by caller for soft/hard).
function blackjackValue(r) {
  if (r === 'A') return 11;
  if (r === 'K' || r === 'Q' || r === 'J' || r === '10') return 10;
  return parseInt(r, 10);
}

// Total a blackjack hand, counting Aces as 1 when 11 would bust. Returns {total, soft}.
function scoreBlackjack(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = rankOf(c);
    if (r === 'A') aces += 1;
    total += blackjackValue(r);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  if (aces === 0) soft = false;
  return { total, soft };
}

// Rank ordering for rummy/gin/go-fish comparisons (A low here; games override as needed).
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i]));

// House players (July 4 2026 — Kade: "why is it always the same agents in
// the game?"): every unnamed seat used to fill from the same hardcoded trio
// (Sterling, Nana Pearl, Duke) or a robotic "Player 2". One shared pool of
// house characters — all real marketplace/companion personas — shuffled
// fresh per game, so tables feel different night to night. Agents can still
// seat specific characters via the tool's `names` option.
const HOUSE_PLAYERS = [
  'Sterling', 'Nana Pearl', 'Duke', 'Earl', 'Dottie', 'Big Tom', 'Wanda',
  'Denny', 'Ray', 'Josie', 'Miss Opal', 'Otis', 'Tammy Lynn', 'Grace',
];
function houseNames(count, taken = []) {
  const lower = taken.map((t) => String(t).toLowerCase());
  const pool = HOUSE_PLAYERS.filter((n) => !lower.includes(n.toLowerCase()));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, count));
}

module.exports = {
  RANKS,
  SUITS,
  SUIT_WORD,
  RANK_WORD,
  RANK_ORDER,
  card,
  rankOf,
  suitOf,
  cardName,
  handWords,


  makeDeck,
  shuffle,
  blackjackValue,
  scoreBlackjack,
  houseNames,
};
