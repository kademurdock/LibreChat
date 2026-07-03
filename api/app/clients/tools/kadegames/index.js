// Game Parlor engine registry. Each module is a server-side referee: it holds
// the deck/hands/turn and only ever exposes a player's own view + the LEGAL
// moves. The AInever referees — it plays a legal move and brings the banter.
// Add a new game = drop a module here with { meta, newGame, view, move }.

const blackjack = require('./blackjack');
const wildEights = require('./wildEights');
const goFish = require('./goFish');

const GAMES = {
  blackjack,
  wild_eights: wildEights,
  go_fish: goFish,
};

function getGame(key) {
  return GAMES[key] || null;
}

function catalog() {
  return Object.values(GAMES).map((g) => ({
    key: g.meta.key,
    name: g.meta.name,
    blurb: g.meta.blurb,
    players: g.meta.minPlayers === g.meta.maxPlayers ? `${g.meta.minPlayers}` : `${g.meta.minPlayers}-${g.meta.maxPlayers}`,
  }));
}

module.exports = { GAMES, getGame, catalog };
