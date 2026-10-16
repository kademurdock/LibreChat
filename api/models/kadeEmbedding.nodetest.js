'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

function typescript(relative) {
  const filename = path.resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}
const helpers = typescript('../../packages/api/src/memory/embedding.ts');
const api = { ...helpers, diaryWriteOrigins: [], diaryWriteOrigin: () => 'test' };
function model(name, other = {}) {
  const filename = path.resolve(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.paths = module.paths;
  loaded.require = (id) => id === '@librechat/api' ? api : id === '@librechat/data-schemas'
    ? { logger: { warn() {}, error() {} }, excludedMemoryConversations: async () => ['excluded'],
      memorySourceStorage: { getStore: () => null }, memorySourceAllowed: async () => true }
    : other[id] || Module.prototype.require.call(loaded, id);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

test('a staged index keeps scope, exclusions, current content and the original vectors intact', async () => {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  process.env.KADE_EMBED_MODEL = 'qwen/qwen3-embedding-8b';
  process.env.KADE_EMBED_DIMENSIONS = '32';
  process.env.OPENROUTER_KEY = 'test-only';
  const diary = model('kadeDiary.js');
  let embedCalls = 0;
  const cards = model('kadeCardVector.js', { '~/models/kadeDiary': {
    ...diary, embedText: async () => { embedCalls++; throw new Error('An already-staged card must not be paid for again'); },
  } });
  const identity = helpers.memoryEmbeddingLane().identity;
  const vector = Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0);
  const add = async (userId, agentId, text, extra = {}) => diary.KadeDiaryEntry.create({
    userId, agentId, text, entryDate: '2026-10-13', embedding: vector, embedModel: 'gemini-embedding-001',
    embeddingNext: vector, embedNextModel: identity, embedNextHash: helpers.embeddingTextHash(text), ...extra,
  });
  try {
    const visible = await add('person', 'a', 'A concert memory.');
    await add('person', null, 'A shared memory.');
    await add('person', 'b', 'Another character memory.');
    await add('other-person', 'a', 'Another person memory.');
    await add('person', 'a', 'Excluded source.', { sourceConversationIds: ['excluded'] });
    await add('person', 'a', 'Changed words.', { embedNextHash: helpers.embeddingTextHash('Earlier words.') });
    await add('person', 'a', 'Wrong model.', { embedNextModel: 'other-model' });
    const found = await diary.searchDiary({ userId: 'person', agentId: 'a', query: 'concert', queryVector: vector, minScore: 0.5 });
    assert.deepEqual(new Set(found.map(x => x.text)), new Set(['A concert memory.', 'A shared memory.']));
    const kept = await diary.KadeDiaryEntry.findById(visible._id).lean();
    assert.equal(kept.embedModel, 'gemini-embedding-001');
    assert.deepEqual(kept.embedding, vector);
    const value = 'A rock concert.';
    await cards.KadeCardVector.create({ userId: 'person', agentId: 'a', key: 'concert',
      valueHash: cards.hashValue('Old value'), embedding: vector, embedModel: 'gemini-embedding-001',
      embeddingNext: vector, embedNextModel: identity, embedNextValueHash: cards.hashValue(value),
      embedNextHash: helpers.embeddingTextHash('concert: '+value) });
    const options = { values: new Map([['a::concert', value]]), minScore: 0.5 };
    assert.equal((await cards.searchCardVectors('person', 'a', vector, options)).length, 1);
    assert.equal((await cards.searchCardVectors('person', 'b', vector, options)).length, 0);
    assert.equal((await cards.searchCardVectors('other-person', 'a', vector, options)).length, 0);
    assert.equal((await cards.searchCardVectors('person', 'a', vector, { ...options, values: new Map([['a::concert', 'Changed value']]) })).length, 0);
    assert.equal((await cards.searchCardVectors('person', 'a', vector.slice(1), options)).length, 0);
    const synced = await cards.syncBucketVectors('person', 'a', [{ key: 'concert', value }]);
    assert.equal(synced.embedded, 0);
    assert.equal(embedCalls, 0);
    const stillOriginal = await cards.KadeCardVector.findOne({ userId: 'person', key: 'concert' }).lean();
    assert.equal(stillOriginal.valueHash, cards.hashValue('Old value'));
    assert.equal(stillOriginal.embedModel, 'gemini-embedding-001');
    await cards.KadeCardVector.updateOne({ userId: 'person', key: 'concert' }, { $set: { embedNextModel: 'other-model' } });
    assert.equal((await cards.searchCardVectors('person', 'a', vector, options)).length, 0);
  } finally { await mongoose.disconnect(); await server.stop(); }
});

/** kadeDiary with the provider call replaced; returns the module and the calls it made. */
function diaryWith(provider) {
  const calls = [];
  const original = api.requestMemoryEmbedding;
  api.requestMemoryEmbedding = async (lane, text, purpose) => { calls.push({ text, purpose }); return provider(calls.length, purpose); };
  try { return { diary: model('kadeDiary.js'), calls }; } finally { api.requestMemoryEmbedding = original; }
}
const timeoutError = () => Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' });

test('Oct 16: a memory query that times out is asked once more; documents fail soft at once', async () => {
  process.env.KADE_EMBED_MODEL = 'qwen/qwen3-embedding-8b';
  process.env.KADE_EMBED_DIMENSIONS = '32';
  process.env.OPENROUTER_KEY = 'test-only';
  const vector = Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0);
  const query = diaryWith((n) => { if (n === 1) throw timeoutError(); return vector; });
  assert.deepEqual(await query.diary.embedText('what concert did I see', { purpose: 'query' }), vector);
  assert.equal(query.calls.length, 2);
  const doc = diaryWith(() => { throw timeoutError(); });
  assert.equal(await doc.diary.embedText('A concert memory.'), null);
  assert.equal(doc.calls.length, 1, 'a document is not retried');
  const tools = diaryWith(() => { throw timeoutError(); });
  assert.equal(await tools.diary.embedText('what is the weather', { purpose: 'tools' }), null);
  assert.equal(tools.calls.length, 1, 'the tools query is raced on the turn path; no retry');
  const refused = diaryWith(() => { throw Object.assign(new Error('Request failed with status code 402'), { response: { status: 402 } }); });
  assert.equal(await refused.diary.embedText('what concert', { purpose: 'query' }), null);
  assert.equal(refused.calls.length, 1, 'only a timeout is retried');
  assert.equal(query.diary.embedPurpose('tools'), 'tools', 'Qwen3 reads the tools instruction');
  delete process.env.KADE_EMBED_MODEL;
  process.env.KADE_EMBED_GEMINI_KEY = 'test-only';
  assert.equal(query.diary.embedPurpose('tools'), 'query', 'a lane with no instruction shares the memory query');
  delete process.env.KADE_EMBED_GEMINI_KEY;
});

test('Oct 16: the diary backfill skips staged entries and never writes over the kept Google index', async () => {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  process.env.KADE_EMBED_MODEL = 'qwen/qwen3-embedding-8b';
  process.env.KADE_EMBED_DIMENSIONS = '32';
  process.env.OPENROUTER_KEY = 'test-only';
  const google = Array.from({ length: 32 }, (_, i) => i === 1 ? 1 : 0);
  const qwen = Array.from({ length: 32 }, (_, i) => i === 2 ? 1 : 0);
  const { diary, calls } = diaryWith(() => qwen);
  const identity = helpers.memoryEmbeddingLane().identity;
  try {
    await diary.KadeDiaryEntry.deleteMany({});
    const staged = await diary.KadeDiaryEntry.create({ userId: 'person', agentId: 'a', text: 'Staged memory.', entryDate: '2026-10-13',
      embedding: google, embedModel: 'gemini-embedding-001', embeddingNext: qwen, embedNextModel: identity, embedNextHash: helpers.embeddingTextHash('Staged memory.') });
    assert.deepEqual(await diary.backfillDiaryEmbeddings({ dry: true }), { dry: true, needing: 0, model: identity });
    let run = await diary.backfillDiaryEmbeddings({ pauseMs: 0 });
    assert.deepEqual({ ...run }, { scanned: 0, embedded: 0, failed: 0, remaining: 0, model: identity });
    assert.equal(calls.length, 0, 'a searchable staged entry is never paid for again');
    const googleOnly = await diary.KadeDiaryEntry.create({ userId: 'person', agentId: 'a', text: 'Google only.', entryDate: '2026-10-12',
      embedding: google, embedModel: 'gemini-embedding-001' });
    const changed = await diary.KadeDiaryEntry.create({ userId: 'person', agentId: 'a', text: 'Changed words.', entryDate: '2026-10-12',
      embedding: google, embedModel: 'gemini-embedding-001', embeddingNext: qwen, embedNextModel: identity, embedNextHash: helpers.embeddingTextHash('Earlier words.') });
    const blank = await diary.KadeDiaryEntry.create({ userId: 'person', agentId: 'a', text: 'No vector yet.', entryDate: '2026-10-12', embedding: null });
    assert.equal((await diary.backfillDiaryEmbeddings({ dry: true })).needing, 3);
    run = await diary.backfillDiaryEmbeddings({ pauseMs: 0 });
    assert.equal(run.embedded, 3);
    assert.equal(run.remaining, 0);
    assert.equal(calls.length, 3);
    for (const id of [googleOnly._id, changed._id]) {
      const row = await diary.KadeDiaryEntry.findById(id).lean();
      assert.equal(row.embedModel, 'gemini-embedding-001', 'the rollback index stays');
      assert.deepEqual(row.embedding, google);
      assert.deepEqual(row.embeddingNext, qwen);
      assert.equal(row.embedNextModel, identity);
      assert.equal(row.embedNextHash, helpers.embeddingTextHash(row.text));
    }
    const filled = await diary.KadeDiaryEntry.findById(blank._id).lean();
    assert.equal(filled.embedModel, identity);
    assert.deepEqual(filled.embedding, qwen);
    const untouched = await diary.KadeDiaryEntry.findById(staged._id).lean();
    assert.deepEqual(untouched.embedding, google);
    assert.equal(untouched.embedModel, 'gemini-embedding-001');
    assert.equal((await diary.backfillDiaryEmbeddings({ dry: true })).needing, 0, 'a second run finds nothing');
  } finally { await mongoose.disconnect(); await server.stop(); }
});
