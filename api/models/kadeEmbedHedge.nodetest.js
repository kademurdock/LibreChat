'use strict';
/* Nov 10 2026: the memory query's two embedding tries overlap (kadeDiary.requestQueryEmbedding).
 * Run: node --test api/models/kadeEmbedHedge.nodetest.js   (needs typescript and mongoose on the path;
 * no database is started and no network call is made: the provider is a stub with a clock). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

function typescript(relative) {
  const filename = path.resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename)).concat(module.paths);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}
const helpers = typescript('../../packages/api/src/memory/embedding.ts');

/** kadeDiary with the provider call replaced by `provider(n, timeoutMs)`; `calls` records each request. */
function diaryWith(provider) {
  const calls = [];
  const warnings = [];
  const api = { ...helpers, diaryWriteOrigins: [], diaryWriteOrigin: () => 'test',
    requestMemoryEmbedding: (lane, text, purpose, timeoutMs) => {
      const call = { n: calls.length + 1, purpose, timeoutMs, at: Date.now() };
      calls.push(call);
      return provider(call.n, timeoutMs);
    } };
  const filename = path.resolve(__dirname, 'kadeDiary.js');
  const loaded = new Module(filename, module);
  loaded.paths = module.paths;
  loaded.require = (id) => id === '@librechat/api' ? api : id === '@librechat/data-schemas'
    ? { logger: { warn: (m) => warnings.push(String(m)), error() {}, info() {} }, excludedMemoryConversations: async () => [],
      memorySourceStorage: { getStore: () => null }, memorySourceAllowed: async () => true }
    : Module.prototype.require.call(loaded, id);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { diary: loaded.exports, calls, warnings };
}
const VECTOR = Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));
const OTHER = Array.from({ length: 32 }, (_, i) => (i === 1 ? 1 : 0));
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
/** What axios does: rejects with a timeout error once `timeoutMs` has passed without an answer. */
const answersAt = (ms, value, timeoutMs) => ms <= timeoutMs
  ? after(ms, value)
  : new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`timeout of ${timeoutMs}ms exceeded`), { code: 'ECONNABORTED' })), timeoutMs));

function env(extra = {}) {
  for (const key of ['KADE_EMBED_GEMINI_KEY', 'KADE_EMBED_OPENAI_KEY', 'KADE_EMBED_HEDGE_MS', 'KADE_EMBED_TIMEOUT_MS']) delete process.env[key];
  Object.assign(process.env, { KADE_EMBED_MODEL: 'qwen/qwen3-embedding-8b', KADE_EMBED_DIMENSIONS: '32', OPENROUTER_KEY: 'test-only',
    KADE_EMBED_TIMEOUT_MS: '600', KADE_EMBED_HEDGE_MS: '150', ...extra });
}

test('a quick answer makes one request and no second try', async () => {
  env();
  const { diary, calls } = diaryWith((n, timeoutMs) => answersAt(20, VECTOR, timeoutMs));
  assert.deepEqual(await diary.embedText('what concert did I see', { purpose: 'query' }), VECTOR);
  await after(250);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs >= 1100 && calls[0].timeoutMs <= 1200, true, `the first request keeps the whole window (twice 600 ms), got ${calls[0].timeoutMs}`);
  const health = diary.readEmbedHealth();
  assert.deepEqual(health.byPurpose.query, { ok: 1, failed: 0 });
  assert.equal(health.secondTries, 0);
});

test('THE BUG: an answer at 800 ms (past the old 600 ms cut) is used; the old rule threw it away and failed both tries', async () => {
  env();
  // Every request answers 800 ms after it was sent: slower than one old try, well inside the window.
  const { diary, calls } = diaryWith((n, timeoutMs) => answersAt(800, n === 1 ? VECTOR : OTHER, timeoutMs));
  const t0 = Date.now();
  const got = await diary.embedText('what concert did I see', { purpose: 'query' });
  const took = Date.now() - t0;
  assert.deepEqual(got, VECTOR, 'the first request, given its whole window, answered');
  assert.equal(calls.length, 2, 'a second request started beside it at the hedge mark');
  assert.ok(calls[1].at - calls[0].at >= 140 && calls[1].at - calls[0].at < 400, `second started ${calls[1].at - calls[0].at} ms in`);
  assert.ok(took < 1100, `answered in ${took} ms, inside the 1,200 ms window`);
  assert.equal(diary.readEmbedHealth().failed, 0);

  // The same slow host under the old one-after-the-other rule (KADE_EMBED_HEDGE_MS=0): blind.
  env({ KADE_EMBED_HEDGE_MS: '0' });
  const old = diaryWith((n, timeoutMs) => answersAt(800, VECTOR, timeoutMs));
  assert.equal(await old.diary.embedText('what concert did I see', { purpose: 'query' }), null, 'two 600 ms tries, both cut');
  assert.equal(old.calls.length, 2);
  assert.deepEqual(old.calls.map((c) => c.timeoutMs), [undefined, undefined], 'the old path uses the purpose default');
  assert.deepEqual(old.diary.readEmbedHealth().byPurpose.query, { ok: 0, failed: 1 });
});

test('a first request that stalls is answered by the second, and the health counts say so', async () => {
  env();
  const { diary, calls } = diaryWith((n, timeoutMs) => answersAt(n === 1 ? 5000 : 30, n === 1 ? OTHER : VECTOR, timeoutMs));
  const t0 = Date.now();
  assert.deepEqual(await diary.embedText('what concert did I see', { purpose: 'query' }), VECTOR);
  assert.ok(Date.now() - t0 < 500, 'no waiting for the stalled first request');
  assert.equal(calls.length, 2);
  const health = diary.readEmbedHealth();
  assert.equal(health.secondTries, 1);
  assert.equal(health.secondTryWon, 1);
});

test('never more than two requests and never longer than the window; both timing out is one failed query', async () => {
  env();
  const { diary, calls, warnings } = diaryWith((n, timeoutMs) => answersAt(60000, VECTOR, timeoutMs));
  const t0 = Date.now();
  assert.equal(await diary.embedText('what concert did I see', { purpose: 'query' }), null);
  const took = Date.now() - t0;
  assert.equal(calls.length, 2);
  assert.ok(took >= 1100 && took < 1700, `gave up at the window (${took} ms), as the two old tries did together`);
  assert.ok(calls[1].timeoutMs <= 1200 - 140, `the second request only gets what is left of the window (${calls[1].timeoutMs})`);
  assert.deepEqual(diary.readEmbedHealth().byPurpose.query, { ok: 0, failed: 1 });
  assert.ok(warnings.some((w) => w.includes('semantic recall is blind for this turn')));
});

test('a refusal is not a timeout: one request, failed at once, no second try', async () => {
  env();
  const { diary, calls } = diaryWith(() => Promise.reject(Object.assign(new Error('Request failed with status code 402'), { response: { status: 402 } })));
  const t0 = Date.now();
  assert.equal(await diary.embedText('what concert', { purpose: 'query' }), null);
  assert.ok(Date.now() - t0 < 100);
  await after(250);
  assert.equal(calls.length, 1);
});

test('a first request that times out at once starts the second straight away (the Oct 16 rule)', async () => {
  env();
  const { diary, calls } = diaryWith((n) => n === 1
    ? Promise.reject(Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' }))
    : Promise.resolve(VECTOR));
  assert.deepEqual(await diary.embedText('what concert did I see', { purpose: 'query' }), VECTOR);
  assert.equal(calls.length, 2);
});

test('documents and tool queries are untouched: one request, the purpose default wait, counted apart', async () => {
  env();
  const { diary, calls } = diaryWith((n) => (n === 2 ? Promise.reject(Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' })) : Promise.resolve(VECTOR)));
  assert.deepEqual(await diary.embedText('A concert memory.'), VECTOR);
  assert.equal(await diary.embedText('what is the weather', { purpose: 'tools' }), null);
  assert.deepEqual(calls.map((c) => [c.purpose, c.timeoutMs]), [['document', undefined], ['tools', undefined]]);
  const health = diary.readEmbedHealth();
  assert.deepEqual(health.byPurpose, { query: { ok: 0, failed: 0 }, tools: { ok: 0, failed: 1 }, document: { ok: 1, failed: 0 } });
  assert.equal(health.ok, 1);
  assert.equal(health.failed, 1);
});

test('the request helper takes the caller\'s wait when given one and the purpose default otherwise', async () => {
  const axios = require('axios');
  const seen = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    seen.push(config.timeout);
    return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [{ index: 0, embedding: VECTOR }] } };
  };
  try {
    env();
    delete process.env.KADE_EMBED_TIMEOUT_MS;
    const lane = helpers.memoryEmbeddingLane(process.env);
    await helpers.requestMemoryEmbedding(lane, 'hello', 'query');
    await helpers.requestMemoryEmbedding(lane, 'hello', 'query', 4800);
    await helpers.requestMemoryEmbedding(lane, 'hello', 'query', 5);
    await helpers.requestMemoryEmbedding(lane, 'hello', 'document');
    assert.deepEqual(seen, [3000, 4800, 3000, 8000]);
  } finally { axios.defaults.adapter = original; }
});
