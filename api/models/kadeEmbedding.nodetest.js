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
  const cards = model('kadeCardVector.js', { '~/models/kadeDiary': diary });
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
    await cards.KadeCardVector.updateOne({ userId: 'person', key: 'concert' }, { $set: { embedNextModel: 'other-model' } });
    assert.equal((await cards.searchCardVectors('person', 'a', vector, options)).length, 0);
  } finally { await mongoose.disconnect(); await server.stop(); }
});
