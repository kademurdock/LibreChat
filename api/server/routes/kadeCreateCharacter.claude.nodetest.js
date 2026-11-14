'use strict';
/* Nov 14 2026 — the character builder's persona writer names its writing lane for the gateway
 * (utils/kadeClaudeLane.js). Her words: "Change the lyric desk etc to it too, whatever benefits from better writing
 * than Mimo". A verified adult's round carries the adult mark, so the gateway may write it with Claude on her credit,
 * MiMo underneath; a child's, a teen's or an untyped account's never does. The body is the MiMo body either way, and
 * a builder that cannot load the helper sends exactly what it sent before.
 * Run: node --test api/server/routes/kadeCreateCharacter.claude.nodetest.js (no network, no database). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realCost = require('../services/kadeRealCost');
const claudeLane = require('../utils/kadeClaudeLane');

const SOURCE = fs.readFileSync(path.join(__dirname, 'kadeCreateCharacter.js'), 'utf8');

function loadBuilder({ withHelper = true } = {}) {
  const handlers = {};
  const posts = [];
  const router = { use() {}, get: (p, ...h) => (handlers[`GET ${p}`] = h.at(-1)), post: (p, ...h) => (handlers[`POST ${p}`] = h.at(-1)) };
  const stubs = {
    express: Object.assign(() => ({}), { Router: () => router, json: () => (_q, _s, next) => next && next() }),
    https: {},
    axios: { post: async (...args) => { posts.push(args); return { data: { choices: [{ message: { content: 'draft' } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 } } }; } },
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
    '@librechat/api': { generateConversationStarters: async () => [], parseConversationStarters: () => [], conversationStartersHandler: () => () => {} },
    '~/server/middleware': { requireJwtAuth() {} },
    '~/models/kadeUsage': { logKadeUsage: async () => {}, fluxCost: () => 0.03 },
    '~/server/services/kadeRealCost': { ...realCost, userPriceFactor: () => 1 },
    './kadePages': { SHARED_HEAD: '' },
    '~/server/services/kadePersonaWriter': {
      PERSONA_CRAFT: 'You write system prompts for characters on a chat platform.',
      personaUserContent: () => "CHARACTER BRIEF (from the person building them):\nA ferry captain.\n\nWrite the character's system prompt now.",
      parsePersonaOutput: () => ({ instructions: 'x'.repeat(300), questions: [], notes: '' }),
    },
    ...(withHelper ? { '../utils/kadeClaudeLane': claudeLane } : {}),
  };
  const module = { exports: {} };
  vm.runInNewContext(SOURCE, {
    module, exports: module.exports,
    require: (name) => {
      if (!(name in stubs)) throw new Error('unexpected require ' + name);
      return stubs[name];
    },
    process: { env: { REFRAME_PROXY_SECRET: 'test-only' } },
    Buffer, setTimeout, console,
  });
  const write = async (user) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handlers['POST /write-persona']({ user, body: { description: 'A ferry captain who tells long stories.' } }, res);
    return res;
  };
  return { posts, write };
}

test('an adult\'s persona round carries the lane and the adult mark; the body is the MiMo body', async () => {
  const b = loadBuilder();
  assert.equal((await b.write({ id: 'a1', role: 'USER', kadeAccountType: 'adult' })).statusCode, 200);
  const [, body, options] = b.posts[0];
  assert.equal(options.headers['x-kade-claude-lane'], 'persona-writer');
  assert.equal(options.headers['x-kade-adult'], '1');
  assert.equal(options.headers.Authorization, 'Bearer test-only');
  assert.equal(options.timeout, 300000);
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(JSON.parse(JSON.stringify(body.reasoning)), { enabled: true, effort: 'low', exclude: true });
  for (const user of [{ id: 'c1', role: 'USER', kadeAccountType: 'child' }, { id: 't1', role: 'USER', kadeAccountType: 'teen' }, { id: 'u1', role: 'USER' }]) {
    await b.write(user);
    const [, other, opts] = b.posts.at(-1);
    assert.equal(JSON.stringify(other), JSON.stringify(body), 'the same body for everyone');
    assert.equal(opts.headers['x-kade-claude-lane'], 'persona-writer');
    assert.equal(opts.headers['x-kade-adult'], undefined, JSON.stringify(user));
  }
  await b.write({ id: 'k', role: 'ADMIN' });
  assert.equal(b.posts.at(-1)[2].headers['x-kade-adult'], '1', 'Kade herself');
});

test('a builder that cannot load the helper sends exactly what it sent before', async () => {
  const b = loadBuilder({ withHelper: false });
  assert.equal((await b.write({ id: 'a1', role: 'USER', kadeAccountType: 'adult' })).statusCode, 200);
  const headers = b.posts[0][2].headers;
  assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type']);
});
