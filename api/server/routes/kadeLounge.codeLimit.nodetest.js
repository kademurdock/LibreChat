/* Nov 12 2026 (audit SEC-10): Hotel passcodes are short, so wrong guesses are limited per person
 * (10 a minute, 30 an hour, shared by check-in and Hotel room keys). A right code never uses the
 * budget. Real express and express-rate-limit (memory store); the room list is a stand-in.
 * Run: node --test api/server/routes/kadeLounge.codeLimit.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');
const express = require('express');

const hash = (key, code) => crypto.createHash('sha256').update(`${key}:${code}`).digest('hex');
const rooms = [{ key: 'hotel-abc', name: 'Porch', codeHash: hash('hotel-abc', 'right1') }];
const stubs = {
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  '~/server/middleware': {
    requireJwtAuth: (req, _res, next) => {
      req.user = { id: req.get('x-test-user') || 'u1' };
      next();
    },
  },
  '~/models/kadeClubRoom': { KadeClubRoom: { find: () => ({ limit: () => ({ lean: async () => rooms }), sort: () => ({ limit: () => ({ lean: async () => rooms }) }) }) } },
  './Clubhouse/pages': { loungeHtml: '', engineHtml: '' },
  '~/server/utils/stripAiTells': { stripAiTells: (s) => s, KADE_STYLE_NOTE: '' },
  '@librechat/api': { familyFeatures: () => ({}), limiterCache: () => undefined },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  /* Any other '~/' module is the real one, from the api folder. */
  if (request.startsWith('~/')) return realLoad.call(this, require('node:path').join(__dirname, '../..', request.slice(2)), parent, isMain);
  return realLoad.call(this, request, parent, isMain);
};
const router = require('./kadeLounge');
Module._load = realLoad;

function post(port, path, body, user) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'x-test-user': user } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
test.after(() => server.close());

test('ten wrong codes a minute, then a spoken 429; another person is not slowed', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await post(port, '/hotel/checkin', { code: `wrong${i}` }, 'guesser')).status, 404);
  }
  const eleventh = await post(port, '/hotel/checkin', { code: 'right1' }, 'guesser');
  assert.equal(eleventh.status, 429);
  assert.match(eleventh.body.error, /a lot of passcodes at once/);
  const other = await post(port, '/hotel/checkin', { code: 'right1' }, 'friend');
  assert.equal(other.status, 200);
  assert.equal(other.body.key, 'hotel-abc');
});

test('a right code never uses the budget', async () => {
  for (let i = 0; i < 15; i++) {
    assert.equal((await post(port, '/hotel/checkin', { code: 'right1' }, 'regular')).status, 200);
  }
});

test('a public room key on /token never meets the limiter', async () => {
  for (let i = 0; i < 12; i++) {
    const r = await post(port, '/token', { room: 'porch' }, 'hopper');
    assert.notEqual(r.status, 429);
  }
});
