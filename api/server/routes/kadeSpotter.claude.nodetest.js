/* Nov 14 2026 — the Spotter persona drafter names its writing lane for the gateway (utils/kadeClaudeLane.js).
 * Her words: "Change the lyric desk etc to it too, whatever benefits from better writing than Mimo". A verified
 * adult's draft carries the adult mark, so the gateway may write it with Claude on her credit, MiMo underneath;
 * a child's, a teen's or an untyped account's never does. The body is exactly the MiMo body either way.
 * Run: node --test api/server/routes/kadeSpotter.claude.nodetest.js (no network, no database). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const posts = [];
const stored = new Map(); // what the stored-account read answers, by user id
const stubs = {
  axios: { post: async (...args) => { posts.push(args); return { data: { choices: [{ message: { content: 'You are calm.' } }] } }; } },
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  '~/server/middleware': { requireJwtAuth: (_req, _res, next) => next() },
  '~/models/kadeSpotter': { getSpotter: async () => null, setSpotter: async () => null, deleteSpotter: async () => null },
  '~/models/kadeSpotterAgent': { ensureSpotterAgent: async () => null },
  '~/models': { getUserById: async (id) => stored.get(id) || null },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const router = require('./kadeSpotter');

let saved;
beforeEach(() => {
  saved = { secret: process.env.REFRAME_PROXY_SECRET, send: process.env.KADE_SEND_CLAUDE_LANE };
  process.env.REFRAME_PROXY_SECRET = 'test-only';
  delete process.env.KADE_SEND_CLAUDE_LANE;
  posts.length = 0;
  stored.clear();
});
afterEach(() => {
  for (const [k, v] of [['REFRAME_PROXY_SECRET', saved.secret], ['KADE_SEND_CLAUDE_LANE', saved.send]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function generate(user, body = { seed: 'calm and funny' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/generate' && l.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handlers[handlers.length - 1]({ body, user }, res);
  return res;
}

test('an adult\'s draft carries the lane and the adult mark; the body is the MiMo body', async () => {
  const res = await generate({ id: 'a1', kadeAccountType: 'adult' });
  assert.equal(res.statusCode, 200);
  const [, body, options] = posts[0];
  assert.equal(options.headers['x-kade-claude-lane'], 'spotter-draft');
  assert.equal(options.headers['x-kade-adult'], '1');
  assert.equal(options.headers.Authorization, 'Bearer test-only');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro', 'MiMo stays the call the gateway falls back to');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  await generate({ id: 'c1', kadeAccountType: 'child' });
  assert.deepEqual(posts[1][1], body, 'the same body for everyone');
});

test('a child, a teen, an untyped account and a failed account read carry no adult mark', async () => {
  stored.set('typed', { kadeAccountType: 'adult' });
  for (const [user, adult] of [[{ id: 'c1', kadeAccountType: 'child' }, false], [{ id: 't1', kadeAccountType: 'teen' }, false],
    [{ id: 'u1', role: 'USER' }, false], [{ id: 'typed', role: 'USER' }, true], [{ id: 'k', role: 'ADMIN' }, true]]) {
    posts.length = 0;
    await generate(user);
    const headers = posts[0][2].headers;
    assert.equal(headers['x-kade-claude-lane'], 'spotter-draft', JSON.stringify(user));
    assert.equal(headers['x-kade-adult'], adult ? '1' : undefined, JSON.stringify(user));
  }
  stubs['~/models'].getUserById = async () => { throw new Error('db down'); };
  posts.length = 0;
  await generate({ id: 'u2', role: 'USER' });
  assert.equal(posts[0][2].headers['x-kade-adult'], undefined, 'fails closed');
  stubs['~/models'].getUserById = async (id) => stored.get(id) || null;
});

test('KADE_SEND_CLAUDE_LANE=0 sends no mark', async () => {
  process.env.KADE_SEND_CLAUDE_LANE = '0';
  await generate({ id: 'a1', kadeAccountType: 'adult' });
  const headers = posts[0][2].headers;
  assert.equal('x-kade-claude-lane' in headers, false);
  assert.equal('x-kade-adult' in headers, false);
});
