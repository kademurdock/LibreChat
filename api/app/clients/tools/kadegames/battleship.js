/**
 * Battleship by voice (July 4 2026 overnight build — the queued "quick win"
 * from GAMES_PLAN: spoken coordinates are blind-native, and the sound pack's
 * battleship_splash / battleship_boom were recorded for exactly this).
 *
 * One human vs the house. 10x10 grid, rows A–J, columns 1–10. Both fleets
 * are placed randomly by the engine (no board-fiddling by ear — you're
 * shooting within seconds). Call a square; the engine answers splash or BOOM,
 * then the house fires back — one move, one full exchange. The house AI
 * hunts honestly: it only knows the squares it has already shot (classic
 * hunt-and-target, no peeking — the engine keeps it that way).
 */

const ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const SIZE = 10;
const FLEET = [
  ['Carrier', 5],
  ['Battleship', 4],
  ['Cruiser', 3],
  ['Submarine', 3],
  ['Destroyer', 2],
];

const meta = {
  key: 'battleship',
  name: 'Battleship',
  blurb: 'Call your shots — "B 7!" — splash or BOOM. Sink the house\'s five ships before it sinks yours.',
  minPlayers: 2,
  maxPlayers: 2,
  dealSounds: ['drumroll_short'],
};

function cellId(r, c) { return `${ROWS[r]}${c + 1}`; }
function speakCell(id) {
  const m = /^([a-j])(10|[1-9])$/.exec(id);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : id;
}
function parseCell(id) {
  const m = /^([a-j])(10|[1-9])$/.exec(String(id || '').toLowerCase());
  if (!m) return null;
  return { r: ROWS.indexOf(m[1]), c: parseInt(m[2], 10) - 1 };
}

function placeFleet() {
  const taken = new Set();
  const ships = [];
  for (const [name, len] of FLEET) {
    for (;;) {
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * (horiz ? SIZE : SIZE - len + 1));
      const c = Math.floor(Math.random() * (horiz ? SIZE - len + 1 : SIZE));
      const cells = [];
      for (let i = 0; i < len; i++) cells.push(cellId(horiz ? r : r + i, horiz ? c + i : c));
      if (cells.some((x) => taken.has(x))) continue;
      cells.forEach((x) => taken.add(x));
      ships.push({ name, cells, hits: [] });
      break;
    }
  }
  return ships;
}

function newGame() {
  return {
    g: 'battleship',
    ships: { player: placeFleet(), ai: placeFleet() },
    shots: { player: {}, ai: {} }, // cell -> 'hit' | 'miss'
    ai: { wounded: [] }, // cells of enemy hits on not-yet-sunk player ships (the AI's honest memory)
    status: 'active',
    winner: null,
    lastExchange: [],
  };
}

function fleetOf(state, side) { return state.ships[side]; }
function shipAt(state, side, cell) {
  return fleetOf(state, side).find((s) => s.cells.includes(cell)) || null;
}
function sunk(ship) { return ship.hits.length >= ship.cells.length; }
function fleetSunk(state, side) { return fleetOf(state, side).every(sunk); }
function afloatCount(state, side) { return fleetOf(state, side).filter((s) => !sunk(s)).length; }

function resolveShot(state, shooter, cell, log, sounds) {
  const targetSide = shooter === 'player' ? 'ai' : 'player';
  const shots = state.shots[shooter];
  const ship = shipAt(state, targetSide, cell);
  const who = shooter === 'player' ? 'You' : 'The house';
  if (ship) {
    shots[cell] = 'hit';
    ship.hits.push(cell);
    const isSunk = sunk(ship);
    log.push(`${who} fire${shooter === 'player' ? '' : 's'} at ${speakCell(cell)} — BOOM! Direct hit${isSunk ? `, and the ${ship.name} goes DOWN` : ''}.`);
    sounds.push('battleship_boom');
    if (isSunk) sounds.push(shooter === 'player' ? 'chip_win' : 'wrong_buzz');
    return { hit: true, sunkShip: isSunk ? ship : null };
  }
  shots[cell] = 'miss';
  log.push(`${who} fire${shooter === 'player' ? '' : 's'} at ${speakCell(cell)} — splash. Miss.`);
  sounds.push('battleship_splash');
  return { hit: false, sunkShip: null };
}

/* The house's brain: parity hunt until a hit, then work the wounded cells'
 * neighbors; prefers continuing an established line. Knows ONLY its own
 * shot history — never reads the player's layout. */
function aiPickCell(state) {
  const shots = state.shots.ai;
  const unshot = (id) => id && !(id in shots);
  const neighbors = (id) => {
    const p = parseCell(id);
    const out = [];
    if (p.r > 0) out.push(cellId(p.r - 1, p.c));
    if (p.r < SIZE - 1) out.push(cellId(p.r + 1, p.c));
    if (p.c > 0) out.push(cellId(p.r, p.c - 1));
    if (p.c < SIZE - 1) out.push(cellId(p.r, p.c + 1));
    return out;
  };
  const wounded = state.ai.wounded;
  if (wounded.length >= 2) {
    // try to extend the line through the wounded cells
    const pts = wounded.map(parseCell);
    const sameRow = pts.every((p) => p.r === pts[0].r);
    const sameCol = pts.every((p) => p.c === pts[0].c);
    if (sameRow || sameCol) {
      const sorted = pts.slice().sort((a, b) => (sameRow ? a.c - b.c : a.r - b.r));
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const ends = sameRow
        ? [lo.c > 0 && cellId(lo.r, lo.c - 1), hi.c < SIZE - 1 && cellId(hi.r, hi.c + 1)]
        : [lo.r > 0 && cellId(lo.r - 1, lo.c), hi.r < SIZE - 1 && cellId(hi.r + 1, hi.c)];
      const open = ends.filter(unshot);
      if (open.length) return open[Math.floor(Math.random() * open.length)];
    }
  }
  if (wounded.length >= 1) {
    const cands = wounded.flatMap(neighbors).filter(unshot);
    if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
  }
  // parity hunt (checkerboard) — every ship spans at least one parity cell
  const pool = [];
  const pool2 = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const id = cellId(r, c);
      if (id in shots) continue;
      ((r + c) % 2 === 0 ? pool : pool2).push(id);
    }
  }
  const pick = pool.length ? pool : pool2;
  return pick[Math.floor(Math.random() * pick.length)];
}

function aiFire(state, log, sounds) {
  const cell = aiPickCell(state);
  if (!cell) return;
  const res = resolveShot(state, 'ai', cell, log, sounds);
  if (res.hit) {
    state.ai.wounded.push(cell);
    if (res.sunkShip) {
      // that ship's cells are no longer interesting
      state.ai.wounded = state.ai.wounded.filter((c) => !res.sunkShip.cells.includes(c));
    }
  }
}

function fleetLine(state, side, mine) {
  const parts = fleetOf(state, side).map((s) => {
    if (sunk(s)) return `${s.name} SUNK`;
    return mine && s.hits.length ? `${s.name} hit ${s.hits.length} of ${s.cells.length}` : null;
  }).filter(Boolean);
  const label = mine ? 'Your fleet' : "The house's fleet";
  const afloat = afloatCount(state, side);
  return `${label}: ${afloat} of ${FLEET.length} afloat${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}

function legal(state) {
  if (state.status !== 'active') return [];
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const id = cellId(r, c);
      if (!(id in state.shots.player)) out.push({ token: `fire_${id}`, label: `Fire at ${speakCell(id)}` });
    }
  }
  return out;
}

function view(state) {
  const lines = [];
  const over = state.status === 'over';
  if (state.lastExchange.length) {
    lines.push(...state.lastExchange);
  }
  lines.push(fleetLine(state, 'ai', false));
  lines.push(fleetLine(state, 'player', true));
  const fired = Object.keys(state.shots.player).length;
  const hits = Object.values(state.shots.player).filter((x) => x === 'hit').length;
  if (!over) {
    lines.push(`You've fired ${fired} shots, ${hits} hits. Rows run A to J, columns 1 to 10. Call the next square.`);
  }
  let winner = null;
  let sounds = [];
  if (over) {
    winner = state.winner === 'player' ? 'player' : 'The house';
    lines.push(state.winner === 'player'
      ? 'Every enemy ship is on the bottom — YOU WIN the battle!'
      : 'Your last ship is gone — the house takes the seas.');
    sounds = state.winner === 'player' ? ['win_fanfare'] : ['lose_trombone'];
  }
  return {
    lines,
    legal: legal(state),
    legalHint: 'any unfired square works: fire_<row letter><column>, like fire_b7 for B-7',
    sounds,
    over,
    winner,
  };
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This battle is over. Start a new one to play again.' };
  const m = /^fire_([a-j](?:10|[1-9]))$/.exec(String(token || '').toLowerCase().replace(/[\s-]+/g, ''));
  if (!m) return { error: 'Call a square like fire_b7 (rows A–J, columns 1–10).' };
  const cell = m[1];
  if (cell in state.shots.player) return { error: `You already fired at ${speakCell(cell)}. Pick a fresh square.` };
  const log = [];
  const sounds = [];
  resolveShot(state, 'player', cell, log, sounds);
  if (fleetSunk(state, 'ai')) {
    state.status = 'over';
    state.winner = 'player';
    state.lastExchange = [];
    return { log, sounds };
  }
  aiFire(state, log, sounds);
  if (fleetSunk(state, 'player')) {
    state.status = 'over';
    state.winner = 'ai';
    state.lastExchange = [];
    return { log, sounds };
  }
  state.lastExchange = [];
  return { log, sounds };
}

/* Visual grids for GameTable (aria-hidden, decorative only):
 * left = your waters (ships + the house's shots), right = your shots. */
function grids(state) {
  const yours = [];
  const shotsAt = [];
  for (let r = 0; r < SIZE; r++) {
    const rowA = [];
    const rowB = [];
    for (let c = 0; c < SIZE; c++) {
      const id = cellId(r, c);
      const myShip = shipAt(state, 'player', id);
      const theirShot = state.shots.ai[id];
      rowA.push(theirShot === 'hit' ? 'X' : theirShot === 'miss' ? 'M' : myShip ? 'S' : '');
      const myShot = state.shots.player[id];
      const enemyShip = myShot === 'hit' ? shipAt(state, 'ai', id) : null;
      rowB.push(myShot === 'hit' ? (enemyShip && sunk(enemyShip) ? 'K' : 'X') : myShot === 'miss' ? 'M' : '');
    }
    yours.push(rowA);
    shotsAt.push(rowB);
  }
  return [
    { name: 'Your waters', cells: yours },
    { name: 'Your shots', cells: shotsAt },
  ];
}

module.exports = { meta, newGame, view, move, legal, grids };
