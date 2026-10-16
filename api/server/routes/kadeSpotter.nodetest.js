/* Oct 16 2026 — the Spotter persona drafter (POST /api/kade/spotter/generate).
 * It goes through the reframe gateway, which holds every MiMo body to zero
 * retention, so the body here carries the model, thinking off and a longer wait.
 * Run: node --test api/server/routes/kadeSpotter.nodetest.js (no network, no database). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const posts = [];
let reply = { data: { choices: [{ message: { content: '  You are calm and unhurried.  ' } }] } };
const stubs = {
  axios: { post: async (...args) => { posts.push(args); return reply; } },
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  '~/server/middleware': { requireJwtAuth: (_req, _res, next) => next() },
  '~/models/kadeSpotter': { getSpotter: async () => null, setSpotter: async () => null, deleteSpotter: async () => null },
  '~/models/kadeSpotterAgent': { ensureSpotterAgent: async () => null },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
/* The generate handler requires axios when it runs, so the stubs stay installed for the whole file. */
const router = require('./kadeSpotter');

const ENV = ['REFRAME_PROXY_SECRET', 'REFRAME_PROXY_URL'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.REFRAME_PROXY_SECRET = 'test-only';
  posts.length = 0;
  reply = { data: { choices: [{ message: { content: '  You are calm and unhurried.  ' } }] } };
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function generate(body) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/generate' && l.route.methods.post);
  assert.ok(layer, 'POST /generate is mounted');
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handlers[handlers.length - 1]({ body, user: { id: 'u1' } }, res);
  return res;
}

test('the drafter asks MiMo Pro through the gateway with thinking off and a 45-second wait', async () => {
  const res = await generate({ seed: 'a cowboy who says "howdy"' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { persona: 'You are calm and unhurried.' });
  assert.equal(posts.length, 1);
  const [url, body, options] = posts[0];
  assert.equal(url, 'https://reframe-proxy-production.up.railway.app/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 400);
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  /* Zero retention is the gateway's job (reframe mimo.js); this body names no provider of its own. */
  assert.equal(body.provider, undefined);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /a cowboy who says 'howdy'/);
  assert.equal(options.timeout, 45000);
  assert.equal(options.headers.Authorization, 'Bearer test-only');
});

test('REFRAME_PROXY_URL still points the drafter at the gateway', async () => {
  process.env.REFRAME_PROXY_URL = 'https://gateway.example.invalid';
  await generate({});
  assert.equal(posts[0][0], 'https://gateway.example.invalid/chat/completions');
  assert.equal(posts[0][1].model, 'xiaomi/mimo-v2.6-pro');
});

test('no gateway secret means no call, and an empty answer is a 502', async () => {
  delete process.env.REFRAME_PROXY_SECRET;
  assert.equal((await generate({})).statusCode, 503);
  assert.equal(posts.length, 0);
  process.env.REFRAME_PROXY_SECRET = 'test-only';
  reply = { data: { choices: [] } };
  assert.equal((await generate({})).statusCode, 502);
});
