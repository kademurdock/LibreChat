/**
 * Tic-Tac-Toe by voice (July 4 2026 overnight build). Squares are phone-pad
 * numbers — 1 top-left, 9 bottom-right — which reads perfectly by ear.
 * The house plays solid-but-beatable (win, block, center, corner): a perfect
 * bot never loses and that's no fun for the kids.
 */

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const SPOT = [
  'top left', 'top middle', 'top right',
  'middle left', 'dead center', 'middle right',
  'bottom left', 'bottom middle', 'bottom right',
];

const meta = {
  key: 'tictactoe',
  name: 'Tic-Tac-Toe',
  blurb: 'Squares 1 to 9 like a phone pad — 1 is top left, 9 is bottom right. Beat the house to three in a row.',
  minPlayers: 2,
  maxPlayers: 2,
  dealSounds: ['page_turn'],
};

function winnerOf(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

function newGame() {
  const state = {
    g: 'tictactoe',
    board: new Array(9).fill(null), // 'X' human, 'O' house
    houseStarts: Math.random() < 0.5,
    status: 'active',
    winner: null,
  };
  if (state.houseStarts) aiMove(state, []);
  return state;
}

function open(board) {
  return board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
}

function findLineMove(board, mark) {
  for (const [a, b, c] of LINES) {
    const vals = [board[a], board[b], board[c]];
    if (vals.filter((v) => v === mark).length === 2 && vals.includes(null)) {
      return [a, b, c][vals.indexOf(null)];
    }
  }
  return -1;
}

function aiMove(state, log) {
  const b = state.board;
  let pick = findLineMove(b, 'O'); // win
  if (pick < 0) pick = findLineMove(b, 'X'); // block
  if (pick < 0 && b[4] === null) pick = 4; // center
  if (pick < 0) {
    const corners = [0, 2, 6, 8].filter((i) => b[i] === null);
    if (corners.length) pick = corners[Math.floor(Math.random() * corners.length)];
  }
  if (pick < 0) {
    const o = open(b);
    pick = o[Math.floor(Math.random() * o.length)];
  }
  b[pick] = 'O';
  log.push(`The house takes square ${pick + 1} — ${SPOT[pick]}.`);
  const w = winnerOf(b);
  if (w) {
    state.status = 'over';
    state.winner = w === 'draw' ? 'tie' : w === 'X' ? 'player' : 'The house';
  }
}

function legal(state) {
  if (state.status !== 'active') return [];
  return open(state.board).map((i) => ({ token: `place_${i + 1}`, label: `Take square ${i + 1} (${SPOT[i]})` }));
}

function boardLines(state) {
  const say = (v, i) => (v === 'X' ? 'you' : v === 'O' ? 'house' : `${i + 1}`);
  const rows = [];
  for (let r = 0; r < 3; r++) {
    rows.push(state.board.slice(r * 3, r * 3 + 3).map((v, i) => say(v, r * 3 + i)).join(' | '));
  }
  return [`Board (rows top to bottom): ${rows.join('  //  ')}.`];
}

function move(state, token) {
  if (state.status !== 'active') return { error: 'This board is done. Start a new game to play again.' };
  const m = /^place_([1-9])$/.exec(String(token || '').toLowerCase());
  if (!m) return { error: `Pick an open square: ${legal(state).map((x) => x.token).join(', ')}.` };
  const i = parseInt(m[1], 10) - 1;
  if (state.board[i]) return { error: `Square ${i + 1} is taken. Open: ${open(state.board).map((x) => x + 1).join(', ')}.` };
  const log = [];
  const sounds = ['bingo_pop'];
  state.board[i] = 'X';
  log.push(`You take square ${i + 1} — ${SPOT[i]}.`);
  let w = winnerOf(state.board);
  if (w) {
    state.status = 'over';
    state.winner = w === 'draw' ? 'tie' : w === 'X' ? 'player' : 'The house';
  } else {
    aiMove(state, log);
  }
  if (state.status === 'over') {
    sounds.push(state.winner === 'player' ? 'win_fanfare' : state.winner === 'tie' ? 'draw_game' : 'lose_trombone');
  }
  return { log, sounds };
}

function view(state) {
  const lines = boardLines(state);
  const over = state.status === 'over';
  let winner = null;
  if (over) {
    winner = state.winner;
    lines.push(state.winner === 'tie' ? "Cat's game — a draw." : state.winner === 'player' ? 'Three in a row — you win!' : 'The house lines up three. Rematch?');
  } else {
    lines.push('Your move — say a square number.');
  }
  return { lines, legal: legal(state), sounds: [], over, winner };
}

module.exports = { meta, newGame, view, move, legal };
