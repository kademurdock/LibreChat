/* Oct 16 2026 — what the Library frame labeler sends to OpenRouter: MiMo Pro by
 * default, thinking off, a 40-token cap, and the zero-retention provider block.
 * Run: node --test api/server/routes/kadeReadingRoomFrameFile.nodetest.js (no network). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const posts = [];
let realCost = null;
const stubs = {
  axios: {
    post: async (...args) => {
      posts.push(args);
      return {
        data: {
          choices: [{ message: { content: '"Tegrin shampoo."' } }],
          usage: { prompt_tokens: 1e6, completion_tokens: 1e6 },
        },
      };
    },
  },
  '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
  '~/server/services/kadeJev': { enabled: () => true },
  '~/server/services/kadeJevJudges': { decideAdFromFrame: async () => ({ category: null, costUSD: 0 }) },
  '~/server/services/kadeRealCost': { openRouterCost: () => realCost },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const framer = require('./kadeReadingRoomFrameFile');
Module._load = realLoad;

const ENV = ['OPENROUTER_KEY', 'KADE_FRAME_MODEL', 'KADE_FRAME_IN_USD_PER_M', 'KADE_FRAME_OUT_USD_PER_M'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OPENROUTER_KEY = 'test-only';
  posts.length = 0;
  realCost = null;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const look = () => framer._internals.labelFrame(Buffer.from('jpeg bytes'), 'Tegrin ad, 1969');

test('MiMo Pro is the default eye, with thinking off, a small cap and zero retention', async () => {
  const { label } = await look();
  assert.equal(label, 'Tegrin shampoo');
  assert.equal(posts.length, 1);
  const [url, body] = posts[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(framer.MODEL(), 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.max_tokens, 40);
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
  const [text, picture] = body.messages[0].content;
  assert.match(text.text, /Tegrin ad, 1969/);
  assert.equal(picture.type, 'image_url');
  assert.equal(picture.image_url.url, `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`);
});

test('KADE_FRAME_MODEL still picks the model, and the retention rule rides along', async () => {
  process.env.KADE_FRAME_MODEL = 'xiaomi/mimo-v2.6-flash';
  await look();
  const body = posts[0][1];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
});

test('a reply naming no cost is priced at Pro rates by default, Flash rates on Flash', async () => {
  /* 1M tokens in and 1M out, so the cost is the two per-million rates added. */
  near((await look()).costUSD, 0.435 + 0.87);
  process.env.KADE_FRAME_MODEL = 'xiaomi/mimo-v2.6-flash';
  near((await look()).costUSD, 0.14 + 0.28);
  process.env.KADE_FRAME_IN_USD_PER_M = '1';
  process.env.KADE_FRAME_OUT_USD_PER_M = '2';
  near((await look()).costUSD, 3);
  realCost = 0.0002;
  near((await look()).costUSD, 0.0002);
});
