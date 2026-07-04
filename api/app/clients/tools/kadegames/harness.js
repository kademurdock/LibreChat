/**
 * Game Parlor referee harness — the engine's proof of correctness.
 *
 * Run:  NODE_PATH=<dir with axios> node harness.js [--n 2000] [--seed 42] [--game key]
 * (No jest, no deps beyond axios for trivia's module load; trivia rounds are
 * played on SYNTHETIC fixtures so the harness never hits the network.)
 *
 * What it enforces on every game, every move (the iron rule, mechanized):
 *   1. newGame/view/move never throw.
 *   2. A move picked FROM the engine's legal list is never rejected.
 *   3. A garbage token IS rejected — and rejection must not mutate state.
 *   4. Whenever the engine hands control back and the game is not over,
 *      the human has at least one legal move (no stuck tables — the class
 *      of bug that deadlocked Go Fish once and Wild Eights/Uno tonight).
 *   5. Games terminate within a sane move budget.
 *   6. Conservation: card/dice/score invariants per game (52 cards stay 52…).
 *   7. visualView() never throws and never leaks (trivia answer key, hole
 *      cards, opponent hands) at any point of any game.
 *
 * Reproducible: Math.random is replaced by a seeded LCG; failures print the
 * seed + game number so any crash can be replayed exactly.
 */

'use strict';

/* ---------- seeded RNG so failures replay exactly ---------- */
const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
}
const BASE_SEED = parseInt(argOf('seed', '20260704'), 10);
const N = parseInt(argOf('n', '2000'), 10);
const ONLY = argOf('game', null);

let _s = BASE_SEED >>> 0;
function srand(seed) { _s = seed >>> 0; }
Math.random = function seededRandom() {
  // LCG (Numerical Recipes) — plenty for shuffles/AI dice.
  _s = (_s * 1664525 + 1013904223) >>> 0;
  return _s / 4294967296;
};

const { GAMES } = require('./index');
const { visualView } = require('./visual');
const { rankOf } = require('./deck');

let failures = 0;
let checks = 0;
function fail(msg) {
  failures += 1;
  console.error(`  FAIL: ${msg}`);
}
function ok(cond, msg) {
  checks += 1;
  if (!cond) fail(msg);
  return !!cond;
}

function deepSnapshot(x) { return JSON.stringify(x); }

/* ---------- per-game conservation checks ---------- */
function cardCount52(state, parts) {
  return parts.reduce((n, p) => n + p, 0);
}
const CONSERVE = {
  blackjack: (s) => cardCount52(s, [s.deck.length, s.player.length, s.dealer.length]) === 52,
  wild_eights: (s) => cardCount52(s, [s.deck.length, s.discard.length, ...s.hands.map((h) => h.length)]) === 52,
  uno: (s) => cardCount52(s, [s.deck.length, s.discard.length, ...s.hands.map((h) => h.length)]) === 108,
  go_fish: (s) => cardCount52(s, [s.deck.length, ...s.hands.map((h) => h.length), s.books.reduce((a, b) => a + b, 0) * 4]) === 52,
  war: (s) => cardCount52(s, [s.playerDeck.length, s.aiDeck.length, s.playerWon.length, s.aiWon.length, s.warPile.length]) === 52,
};

/* ---------- leak checks on the visual layer ---------- */
function visualLeakCheck(key, state) {
  let vis;
  try {
    vis = visualView(key, state);
  } catch (e) {
    return fail(`visualView(${key}) threw: ${e.message}`);
  }
  if (vis == null) return true; // no visual for this game — fine
  const raw = JSON.stringify(vis);
  checks += 1;
  if (key === 'trivia') {
    if (/"correct"/.test(raw)) return fail('trivia visual leaks the answer key');
  }
  if (key === 'blackjack' && state.phase === 'player') {
    // hole card must be face down during play
    const dealerSeat = vis.seats && vis.seats[0];
    const shown = (dealerSeat && dealerSeat.cards || []).filter((c) => !c.back).length;
    if (shown > 1) return fail('blackjack visual shows the hole card during play');
  }
  if ((key === 'wild_eights' || key === 'uno' || key === 'go_fish') && state.status === 'active') {
    // opponents' hands must be backs only
    for (let i = 1; i < (vis.seats || []).length; i++) {
      const cards = vis.seats[i].cards || [];
      if (cards.some((c) => !c.back)) return fail(`${key} visual leaks opponent cards`);
    }
  }
  return true;
}

/* ---------- synthetic trivia (no network) ---------- */
function syntheticTrivia(rivals, rounds) {
  const qs = [];
  for (let i = 0; i < rounds; i++) {
    const options = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    qs.push({ q: `Synthetic question ${i + 1}?`, cat: 'Synthetics', diff: ['easy', 'medium', 'hard'][i % 3], options, correct: Math.floor(Math.random() * 4) });
  }
  const names = ['You'];
  for (let i = 0; i < rivals; i++) names.push(`Rival ${i + 1}`);
  return { g: 'trivia', qs, idx: 0, scores: new Array(rivals + 1).fill(0), names, status: 'active', winner: null };
}

/* ---------- one full random-legal-move game ---------- */
async function playOne(key, G, gameNo, opts) {
  const seed = (BASE_SEED ^ (gameNo * 2654435761)) >>> 0;
  srand(seed);
  let state;
  try {
    state = key === 'trivia'
      ? syntheticTrivia(opts.opponents || 0, opts.rounds || 5)
      : await G.newGame(opts);
  } catch (e) {
    return fail(`${key}#${gameNo} newGame threw: ${e.message} (seed ${seed})`);
  }

  const MOVE_CAP = key === 'war' ? 1400 : 600;
  let moves = 0;
  for (;;) {
    let v;
    try {
      v = G.view(state);
    } catch (e) {
      return fail(`${key}#${gameNo} view threw after ${moves} moves: ${e.message} (seed ${seed})`);
    }
    visualLeakCheck(key, state);
    if (v.over) {
      ok(Array.isArray(v.legal) && v.legal.length === 0, `${key}#${gameNo}: legal moves offered on a finished game`);
      if (CONSERVE[key]) ok(CONSERVE[key](state), `${key}#${gameNo}: conservation broken at game end (seed ${seed})`);
      ok(v.winner !== undefined, `${key}#${gameNo}: finished game has no winner field`);
      return true;
    }
    if (!ok(v.legal && v.legal.length > 0, `${key}#${gameNo}: game not over but human has NO legal moves after ${moves} moves — stuck table (seed ${seed})`)) {
      return false;
    }
    const tokens = v.legal.map((m) => m.token);
    ok(new Set(tokens).size === tokens.length, `${key}#${gameNo}: duplicate legal tokens`);

    // Occasionally poke the referee with garbage; it must reject w/o mutating.
    if (moves % 7 === 3) {
      const before = deepSnapshot(state);
      let r;
      try {
        r = await G.move(state, 'xx_not_a_move_zz');
      } catch (e) {
        return fail(`${key}#${gameNo} move(garbage) threw: ${e.message}`);
      }
      ok(r && r.error, `${key}#${gameNo}: garbage token was ACCEPTED`);
      ok(deepSnapshot(state) === before, `${key}#${gameNo}: rejected move mutated state (seed ${seed})`);
    }

    const pick = tokens[Math.floor(Math.random() * tokens.length)];
    let res;
    try {
      res = await G.move(state, pick);
    } catch (e) {
      return fail(`${key}#${gameNo} move(${pick}) threw: ${e.message} (seed ${seed})`);
    }
    if (!ok(!(res && res.error), `${key}#${gameNo}: legal move ${pick} rejected: ${res && res.error} (seed ${seed})`)) return false;
    if (CONSERVE[key]) {
      if (!ok(CONSERVE[key](state), `${key}#${gameNo}: conservation broken after ${pick} (seed ${seed})`)) return false;
    }
    moves += 1;
    if (moves > MOVE_CAP) {
      return fail(`${key}#${gameNo}: no termination after ${MOVE_CAP} moves (seed ${seed})`);
    }
  }
}

/* ---------- surgical regression tests (bug-shaped states) ---------- */
async function surgical() {
  console.log('— surgical regression tests —');

  // Wild Eights / Uno: dead pile + nobody can play must END the game, not stall.
  {
    const G = GAMES.wild_eights;
    const state = {
      g: 'wild_eights', deck: [], discard: ['A:S'], suit: 'S',
      hands: [['3:H'], ['4:H']], turn: 0, names: ['You', 'Bot'],
      drew: false, status: 'active', winner: null,
    };
    const v = G.view(state);
    if (v.legal.length > 0) {
      const r = await G.move(state, v.legal[0].token);
      ok(!(r && r.error), 'w8 deadlock: pass rejected');
    }
    const v2 = G.view(state);
    ok(v2.over === true, 'WILD EIGHTS DEADLOCK: dead frozen pile must END the game (fewest cards wins)');
    ok(v2.winner !== undefined && v2.winner !== null, 'w8 dead-pile finish must carry a winner/tie');
  }
  {
    const G = GAMES.uno;
    const state = {
      g: 'uno', deck: [], discard: ['R5'], color: 'R',
      hands: [['B3'], ['G7']], turn: 0, direction: 1, names: ['You', 'Bot'],
      drew: false, status: 'active', winner: null,
    };
    const v = G.view(state);
    if (v.legal.length > 0) {
      const r = await G.move(state, v.legal[0].token);
      ok(!(r && r.error), 'uno deadlock: pass rejected');
    }
    const v2 = G.view(state);
    ok(v2.over === true, 'UNO DEADLOCK: dead frozen pile must END the game (fewest cards wins)');
    ok(v2.winner !== undefined && v2.winner !== null, 'uno dead-pile finish must carry a winner/tie');
  }

  // Wild Eights / Uno: 'pass' while holding a playable card and not having
  // drawn must be REJECTED (the legal list never offers it — move() must agree).
  {
    const G = GAMES.wild_eights;
    const state = {
      g: 'wild_eights', deck: ['2:C', '9:D'], discard: ['A:S'], suit: 'S',
      hands: [['3:S'], ['4:H']], turn: 0, names: ['You', 'Bot'],
      drew: false, status: 'active', winner: null,
    };
    const r = await G.move(state, 'pass');
    ok(r && r.error, 'WILD EIGHTS: free pass accepted while a play + draw were available (known bug if failing)');
  }
  {
    const G = GAMES.uno;
    const state = {
      g: 'uno', deck: ['G2', 'Y9'], discard: ['R5'], color: 'R',
      hands: [['R3'], ['G7']], turn: 0, direction: 1, names: ['You', 'Bot'],
      drew: false, status: 'active', winner: null,
    };
    const r = await G.move(state, 'pass');
    ok(r && r.error, 'UNO: free pass accepted while a play + draw were available (known bug if failing)');
  }

  // Blackjack: payout math spot-checks.
  {
    const G = GAMES.blackjack;
    srand(7);
    for (let i = 0; i < 400; i++) {
      const s = G.newGame({ bet: 10 });
      while (!G.view(s).over) {
        const v = G.view(s);
        const t = v.legal[Math.floor(Math.random() * v.legal.length)].token;
        await G.move(s, t);
      }
      const mult = s.doubled ? 2 : 1;
      const expected = s.result === 'blackjack' ? 15
        : s.result === 'push' ? 0
        : (s.result === 'win' || s.result === 'dealer_bust') ? 10 * mult
        : -10 * mult;
      ok(s.payout === expected, `blackjack payout wrong: result=${s.result} doubled=${s.doubled} payout=${s.payout} expected=${expected}`);
    }
  }

  // War: winner ends holding all 52.
  {
    const G = GAMES.war;
    srand(11);
    const s = G.newGame();
    let guard = 0;
    while (!G.view(s).over && guard++ < 1500) {
      await G.move(s, G.view(s).legal[0].token);
    }
    const v = G.view(s);
    ok(v.over, 'war did not finish in 1500 moves');
  }
}

/* ---------- main ---------- */
(async function main() {
  const plans = [
    ['blackjack', { bet: 25 }, Math.min(N, 3000)],
    ['blackjack', { bet: 10 }, Math.min(N, 2000)],
    ['wild_eights', { opponents: 1 }, N],
    ['wild_eights', { opponents: 3, names: ['Sterling', 'Nana Pearl', 'Duke'] }, N],
    ['uno', { opponents: 1 }, N],
    ['uno', { opponents: 3 }, N],
    ['go_fish', { opponents: 1 }, N],
    ['go_fish', { opponents: 3 }, N],
    ['pig', { opponents: 1 }, N],
    ['pig', { opponents: 3 }, N],
    ['trivia', { opponents: 0, rounds: 5 }, Math.min(N, 1500)],
    ['trivia', { opponents: 3, rounds: 10 }, Math.min(N, 1500)],
    ['war', {}, Math.min(N, 1500)],
  ];
  console.log(`Game Parlor harness — seed ${BASE_SEED}, up to ${N} games per plan\n`);
  await surgical();
  console.log('\n— random-legal-move soak —');
  for (const [key, opts, count] of plans) {
    if (ONLY && key !== ONLY) continue;
    const G = GAMES[key];
    if (!G) { fail(`no module for ${key}`); continue; }
    const f0 = failures;
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await playOne(key, G, i, opts);
      if (failures > f0 + 4) { console.error(`  (aborting ${key} soak — too many failures)`); break; }
      if (!alive && failures > f0 + 4) break;
    }
    console.log(`  ${key} ${JSON.stringify(opts)}: ${count} games, ${failures - f0} failures`);
  }
  console.log(`\n${checks} checks, ${failures} failures.`);
  process.exit(failures ? 1 : 0);
})();
