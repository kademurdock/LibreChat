'use strict';
/* Part 179 (Sep 11 2026) — the Parlor lobby, the pure half.
 *
 * Read off the code, not a report: the phone put an empty code box and an
 * empty standings screen in front of the games, and nobody could see that
 * anybody else had a table open. /lobby lists the family's party tables with
 * a free seat; `private:true` on /new keeps one off it. These tests load the
 * route file with every dependency stubbed (no express, no Mongo, no game
 * engine) so the filter and the spoken line are proven anywhere `node` runs.
 *
 *   node --test api/server/routes/kadeParlor.lobby.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadParlor() {
  const module = { exports: {} };
  const routes = [];
  const fakeRouter = {
    get: (p, ...h) => routes.push(['get', p, h]),
    post: (p, ...h) => routes.push(['post', p, h]),
    use: () => {},
  };
  const localRequire = (name) => {
    if (name === 'express') return { Router: () => fakeRouter, json: () => (_r, _s, n) => n() };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '~/server/middleware') return { requireJwtAuth: (_r, _s, n) => n() };
    if (name === '~/models/kadeGameState') return { KadeGameState: {} };
    if (name === '~/app/clients/tools/kadegames') {
      const NAMES = { uno: 'Uno', hearts: 'Hearts', five_card_draw: 'Five-Card Draw' };
      return {
        getGame: (k) => (NAMES[k] ? { meta: { name: NAMES[k], seatAware: true } } : null),
        catalog: () => [],
      };
    }
    if (name === '~/server/utils/stripAiTells') return { stripAiTells: (t) => t, KADE_STYLE_NOTE: '' };
    if (name === './kadePages') return new Proxy({}, { get: () => '' });
    if (name === '~/app/clients/tools/kadegames/tableRunner') {
      return { resolveSeatAgents: async () => ({ seats: [], missing: [] }), playSeatTurns: async () => ({ log: [], sounds: [] }), maybeSettleChips: async () => [], pushHistory() {} };
    }
    throw new Error('unexpected require in test: ' + name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeParlor.js'), 'utf8');
  vm.runInNewContext(source, { require: localRequire, module, exports: module.exports, console, Date, Math, JSON, String, Number, Array, Object, Error });
  return { internals: module.exports._internals, routes };
}

const { internals, routes } = loadParlor();
const { lobbyRows, sayLobby, LOBBY_MAX } = internals;

const HOST = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ME = 'bbbbbbbbbbbbbbbbbbbbbbbb';
function table(over = {}) {
  return {
    user: over.user || HOST,
    gameId: over.gameId || 'ab12',
    gameKey: over.gameKey || 'uno',
    title: 'Uno',
    status: 'active',
    updatedAt: new Date('2026-09-11T12:00:00Z'),
    state: {
      party: {
        code: over.code || 'Q7PX',
        hostName: over.hostName || 'Amber',
        seats: over.seats || { 1: { kind: 'open' }, 2: { kind: 'open' }, 3: { kind: 'agent' } },
        memberIds: over.memberIds || [],
        private: over.private,
      },
    },
  };
}

test('the lobby route exists and party creation reads a private flag', () => {
  assert.ok(routes.some(([m, p]) => m === 'get' && p === '/lobby'), 'GET /lobby is wired');
  const src = fs.readFileSync(path.join(__dirname, 'kadeParlor.js'), 'utf8');
  assert.match(src, /private: req\.body\?\.private === true/);
});

test('a party table with a free seat is listed with the game name, host, seats and code', () => {
  const rows = lobbyRows([table()], ME);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { name: rows[0].name, host: rows[0].host, seatsOpen: rows[0].seatsOpen, code: rows[0].code, mine: rows[0].mine, seated: rows[0].seated, gameId: rows[0].gameId },
    { name: 'Uno', host: 'Amber', seatsOpen: 2, code: 'Q7PX', mine: false, seated: false, gameId: 'ab12' },
  );
});

test('full tables, private tables, solo tables and unknown games stay out or degrade kindly', () => {
  const full = table({ seats: { 1: { kind: 'guest', userId: 'x', name: 'Sky' }, 2: { kind: 'bot' } } });
  const priv = table({ private: true });
  const solo = { user: HOST, gameId: 's1', gameKey: 'blackjack', status: 'active', state: { names: [] } };
  const odd = table({ gameKey: 'not_a_game', gameId: 'zz' });
  const rows = lobbyRows([full, priv, solo, odd], ME);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gameId, 'zz');
  assert.equal(rows[0].name, 'Uno', 'falls back to the stored title when the engine does not know the key');
});

test("the host sees her own table marked as hers, a seated guest as seated", () => {
  assert.equal(lobbyRows([table()], HOST)[0].mine, true);
  assert.equal(lobbyRows([table()], HOST)[0].seated, true);
  const withMe = table({ memberIds: [ME], seats: { 1: { kind: 'guest', userId: ME, name: 'Me' }, 2: { kind: 'open' } } });
  const r = lobbyRows([withMe], ME)[0];
  assert.equal(r.mine, false);
  assert.equal(r.seated, true);
  assert.equal(r.seatsTaken, 1);
});

test('the list is capped', () => {
  const many = Array.from({ length: LOBBY_MAX + 7 }, (_, i) => table({ gameId: 't' + i, code: 'C' + i }));
  assert.equal(lobbyRows(many, ME).length, LOBBY_MAX);
});

test('the spoken line is one plain sentence a narrator can read', () => {
  assert.equal(sayLobby([]), 'Nobody has a table open right now.');
  const one = lobbyRows([table()], ME);
  assert.equal(sayLobby(one), "One table open: Amber's Uno table, 2 seats open.");
  const two = lobbyRows([table(), table({ user: 'cccccccccccccccccccccccc', gameId: 'h1', gameKey: 'hearts', hostName: 'Kade', seats: { 1: { kind: 'open' } } })], HOST);
  assert.equal(sayLobby(two), "2 tables open: your Uno table, 2 seats open; Kade's Hearts table, 1 seat open.");
  const seven = Array.from({ length: 7 }, (_, i) => table({ gameId: 't' + i }));
  assert.match(sayLobby(lobbyRows(seven, ME)), /, and 2 more\.$/);
});
