/* Oct 16 2026 — what the live Library librarian sends to OpenRouter: MiMo Flash
 * (it answers a person who is waiting), thinking off, and the zero-retention
 * provider block. Run: node --test api/server/routes/kadeReadingRoomLibrarian.nodetest.js
 * (no network: there is no Tavily key, so the web searches return nothing). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const posts = [];
const stubs = {
  axios: {
    post: async (...args) => {
      posts.push(args);
      return {
        data: {
          choices: [{ message: { content: '{"note":"A children\'s cassette.","confidence":"low","identified":""}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      };
    },
  },
  '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
  '~/models/kadeUsage': { logKadeUsage: async () => {} },
  '~/server/services/kadeRealCost': { openRouterCost: () => null },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const librarian = require('./kadeReadingRoomLibrarian');
Module._load = realLoad;

const ENV = ['OPENROUTER_KEY', 'KADE_LIBRARIAN', 'KADE_LIBRARIAN_MODEL', 'TAVILY_API_KEY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OPENROUTER_KEY = 'test-only';
  posts.length = 0;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const item = { title: 'Laugh and Play', kind: 'audio', category: 'cassette', author: 'Kid Songs' };

test('a question about what just happened goes to MiMo Flash with thinking off and zero retention', async () => {
  await librarian.ask({ item, track: null, question: 'Who is singing?', recap: { summary: 'Two kids sing.', scenes: [] }, fromSeconds: 0, toSeconds: 60 });
  assert.equal(posts.length, 1);
  const [url, body] = posts[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
  assert.equal(body.response_format, undefined);
});

test("the librarian's note asks for JSON under the same settings", async () => {
  const notes = await librarian.librarianNotes(item);
  assert.equal(notes.note, "A children's cassette.");
  const body = posts[0][1];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('KADE_LIBRARIAN_MODEL still picks the model, and the retention rule rides along', async () => {
  process.env.KADE_LIBRARIAN_MODEL = 'xiaomi/mimo-v2.6-pro';
  await librarian.ask({ item, track: null, question: 'What is it?', recap: { summary: 'A song.', scenes: [] } });
  const body = posts[0][1];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(body.reasoning, { enabled: false, effort: 'none' });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
});
