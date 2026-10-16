/* Oct 16 2026 — what the Library book sorter sends to OpenRouter. It reads its
 * own KADE_LIBRARY_SORT_MODEL (MiMo Pro by default) and never the live
 * librarian's KADE_LIBRARIAN_MODEL, keeps thinking off, and sends the
 * zero-retention provider block with DeepInfra first.
 * Run: node --test api/server/routes/kadeReadingRoomSort.nodetest.js (no network, no database). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const posts = [];
const usageRows = [];
let realCost = null;
const books = [
  { _id: 'b1', title: 'Laugh and Play', author: 'A. Writer', synopsis: 'Songs for little ones.', owner: 'u1' },
  { _id: 'b2', title: 'Night Shift', author: 'B. Writer', synopsis: 'A nurse solves a hospital mystery.', owner: 'u1' },
];
const stubs = {
  axios: {
    post: async (...args) => {
      posts.push(args);
      return {
        data: {
          choices: [{ message: { content: JSON.stringify({ books: [
            { id: 'b1', shelf: 'Fiction — Children', adult: false },
            { id: 'b2', shelf: 'Fiction — Mystery & thriller', adult: false },
          ] }) } }],
          usage: { prompt_tokens: 1e6, completion_tokens: 1e6 },
        },
      };
    },
  },
  '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
  '~/models/kadeBook': {
    KadeBook: {
      find: () => ({ sort: () => ({ limit: () => ({ lean: async () => books.map((b) => ({ ...b })) }) }) }),
      updateOne: async () => ({}),
      countDocuments: async () => 0,
    },
  },
  '@librechat/api': { correctedBookShelf: () => null },
  '~/models/kadeUsage': {
    logKadeUsage: async (row) => { usageRows.push(row); },
    logPlatformUsage: async (row) => { usageRows.push(row); },
    KadeUsage: { aggregate: async () => [] },
  },
  '~/server/services/kadeRealCost': { openRouterCost: () => realCost },
  /* Jev is switched off here, so every book goes to the model call under test. */
  '~/server/services/kadeJevJudges': { sortBooks: async (list) => ({ out: {}, leftovers: list, costUSD: 0 }) },
  './kadeReadingRoomTree': { forget() {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
/* sortOnce requires Jev and the tree lazily, so the stubs stay installed for the whole file. */
const sorter = require('./kadeReadingRoomSort');

const ENV = [
  'OPENROUTER_KEY', 'KADE_LIBRARY_SORT', 'KADE_LIBRARY_SORT_MODEL', 'KADE_LIBRARIAN_MODEL',
  'KADE_LIBRARY_SORT_IN_USD_PER_M', 'KADE_LIBRARY_SORT_OUT_USD_PER_M', 'KADE_LIBRARIAN_IN_USD_PER_M', 'KADE_LIBRARIAN_OUT_USD_PER_M',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OPENROUTER_KEY = 'test-only';
  posts.length = 0;
  usageRows.length = 0;
  realCost = null;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const ZERO_RETENTION_DEEPINFRA = { zdr: true, data_collection: 'deny', order: ['DeepInfra'], allow_fallbacks: true };

test('MiMo Pro sorts by default, thinking off, zero retention with DeepInfra first', async () => {
  assert.equal(await sorter.sortOnce({ force: true, userId: 'u1' }), 2);
  assert.equal(posts.length, 1);
  const [url, body] = posts[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  assert.deepEqual(body.provider, ZERO_RETENTION_DEEPINFRA);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(usageRows[0].metadata.model, 'xiaomi/mimo-v2.6-pro');
});

test('the live librarian setting never moves the sorter', async () => {
  process.env.KADE_LIBRARIAN_MODEL = 'xiaomi/mimo-v2.6-flash';
  process.env.KADE_LIBRARIAN_IN_USD_PER_M = '9';
  process.env.KADE_LIBRARIAN_OUT_USD_PER_M = '9';
  await sorter.sortOnce({ force: true, userId: 'u1' });
  assert.equal(posts[0][1].model, 'xiaomi/mimo-v2.6-pro');
  near(usageRows[0].costUSD, 0.435 + 0.87);
});

test('KADE_LIBRARY_SORT_MODEL picks the sorter model and keeps the provider block', async () => {
  process.env.KADE_LIBRARY_SORT_MODEL = 'xiaomi/mimo-v2.6-flash';
  await sorter.sortOnce({ force: true, userId: 'u1' });
  const body = posts[0][1];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  assert.deepEqual(body.provider, ZERO_RETENTION_DEEPINFRA);
  near(usageRows[0].costUSD, 0.14 + 0.28);
});

test('a reply naming no cost is priced at Pro rates; a reported cost wins; the sort rates can be tuned', async () => {
  /* 1M tokens in and 1M out, so the cost is the two per-million rates added. */
  await sorter.sortOnce({ force: true, userId: 'u1' });
  near(usageRows[0].costUSD, 0.435 + 0.87);
  process.env.KADE_LIBRARY_SORT_IN_USD_PER_M = '1';
  process.env.KADE_LIBRARY_SORT_OUT_USD_PER_M = '2';
  await sorter.sortOnce({ force: true, userId: 'u1' });
  near(usageRows[1].costUSD, 3);
  realCost = 0.004;
  await sorter.sortOnce({ force: true, userId: 'u1' });
  near(usageRows[2].costUSD, 0.004);
});
