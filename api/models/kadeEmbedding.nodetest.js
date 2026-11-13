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

test('TURN-14: recall reads only the active vector and still finds staged, live and rollback rows', async () => {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  process.env.KADE_EMBED_MODEL = 'qwen/qwen3-embedding-8b';
  process.env.KADE_EMBED_DIMENSIONS = '32';
  process.env.OPENROUTER_KEY = 'test-only';
  const diary = model('kadeDiary.js');
  const cards = model('kadeCardVector.js', { '~/models/kadeDiary': diary });
  const identity = helpers.memoryEmbeddingLane().identity;
  const vector = Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));
  const other = Array.from({ length: 32 }, (_, i) => (i === 5 ? 1 : 0));
  try {
    await diary.KadeDiaryEntry.deleteMany({});
    /* (a) rollback vector from another model + the active model's staged vector, right hash */
    await diary.KadeDiaryEntry.create({ userId: 'p14', agentId: 'a', text: 'Staged row.', entryDate: '2026-10-13',
      embedding: other, embedModel: 'gemini-embedding-001', embeddingNext: vector, embedNextModel: identity,
      embedNextHash: helpers.embeddingTextHash('Staged row.') });
    /* (b) the active model's vector only */
    await diary.KadeDiaryEntry.create({ userId: 'p14', agentId: 'a', text: 'Live row.', entryDate: '2026-10-13',
      embedding: vector, embedModel: identity });
    /* (c) the active model's staged vector with a WRONG hash: never returned */
    await diary.KadeDiaryEntry.create({ userId: 'p14', agentId: 'a', text: 'Stale row.', entryDate: '2026-10-13',
      embedding: other, embedModel: 'gemini-embedding-001', embeddingNext: vector, embedNextModel: identity,
      embedNextHash: helpers.embeddingTextHash('Other words.') });
    const found = await diary.searchDiary({ userId: 'p14', agentId: 'a', query: 'row', queryVector: vector, minScore: 0.5 });
    assert.deepEqual(new Set(found.map((x) => x.text)), new Set(['Staged row.', 'Live row.']));
    assert.equal(found[0].score, found[1].score, 'the same vector scores the same either way');

    const value = 'Front row seats.';
    await cards.KadeCardVector.create({ userId: 'p14', agentId: 'a', key: 'seats',
      valueHash: cards.hashValue('Old value'), embedding: other, embedModel: 'gemini-embedding-001',
      embeddingNext: vector, embedNextModel: identity, embedNextValueHash: cards.hashValue(value),
      embedNextHash: helpers.embeddingTextHash('seats: ' + value) });
    await cards.KadeCardVector.create({ userId: 'p14', agentId: 'a', key: 'band',
      valueHash: cards.hashValue('The band.'), embedding: vector, embedModel: identity });
    const options = { values: new Map([['a::seats', value], ['a::band', 'The band.']]), minScore: 0.5 };
    const hits = await cards.searchCardVectors('p14', 'a', vector, options);
    assert.deepEqual(new Set(hits.map((h) => h.key)), new Set(['seats', 'band']));
    const wrong = { ...options, values: new Map([['a::seats', 'Changed value'], ['a::band', 'The band.']]) };
    assert.deepEqual((await cards.searchCardVectors('p14', 'a', vector, wrong)).map((h) => h.key), ['band']);

    /* switching the lane switches which vector is read: on another model only that model's row
     * is found, served from its own `embedding` */
    process.env.KADE_EMBED_MODEL = 'other/rollback-model';
    const otherIdentity = helpers.memoryEmbeddingLane().identity;
    await diary.KadeDiaryEntry.create({ userId: 'p14', agentId: 'a', text: 'Other lane row.', entryDate: '2026-10-13',
      embedding: other, embedModel: otherIdentity, embeddingNext: vector, embedNextModel: identity,
      embedNextHash: helpers.embeddingTextHash('Other lane row.') });
    const back = await diary.searchDiary({ userId: 'p14', agentId: 'a', query: 'row', queryVector: other, minScore: 0.5 });
    assert.deepEqual(back.map((x) => x.text), ['Other lane row.']);
    process.env.KADE_EMBED_MODEL = 'qwen/qwen3-embedding-8b';
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }
});

/** kadeDiary with the provider call replaced; returns the module and the calls it made. */
function diaryWith(provider) {
  const calls = [];
  const original = api.requestMemoryEmbedding;
  api.requestMemoryEmbedding = async (lane, text, purpose, timeoutMs) => { calls.push({ text, purpose, timeoutMs }); return provider(calls.length, purpose); };
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
  /* Nov 13 2026 (sweep 8.2): a document that times out is asked once more; KADE_EMBED_DOC_RETRY=0 undoes it. */
  const doc = diaryWith(() => { throw timeoutError(); });
  assert.equal(await doc.diary.embedText('A concert memory.'), null);
  assert.equal(doc.calls.length, 2, 'a document is asked once more, and only once');
  assert.equal(doc.diary.readEmbedHealth().failed, 1, 'two failed requests are one failed embed');
  assert.equal(doc.diary.readEmbedHealth().docRetries, 1);
  assert.equal(doc.diary.readEmbedHealth().docRetryWon, 0);
  const docSecond = diaryWith((n) => { if (n === 1) throw timeoutError(); return vector; });
  assert.deepEqual(await docSecond.diary.embedText('A concert memory.'), vector);
  assert.equal(docSecond.calls.length, 2);
  assert.deepEqual(docSecond.calls.map((c) => c.timeoutMs), [undefined, 12000], 'the second request waits longer than the 8 s first one');
  assert.deepEqual(docSecond.diary.readEmbedHealth().byPurpose.document, { ok: 1, failed: 0 });
  assert.equal(docSecond.diary.readEmbedHealth().docRetryWon, 1);
  process.env.KADE_EMBED_DOC_TIMEOUT_MS = '20000';
  const docLong = diaryWith((n) => { if (n === 1) throw timeoutError(); return vector; });
  await docLong.diary.embedText('A concert memory.');
  assert.equal(docLong.calls[1].timeoutMs, 20000, 'the second wait is never shorter than the first');
  delete process.env.KADE_EMBED_DOC_TIMEOUT_MS;
  const docRefused = diaryWith(() => { throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }); });
  assert.equal(await docRefused.diary.embedText('A concert memory.'), null);
  assert.equal(docRefused.calls.length, 1, 'a refused document is not asked again');
  process.env.KADE_EMBED_DOC_RETRY = '0';
  const docOff = diaryWith(() => { throw timeoutError(); });
  assert.equal(await docOff.diary.embedText('A concert memory.'), null);
  assert.equal(docOff.calls.length, 1, 'switch off: a document fails soft at once, as before');
  delete process.env.KADE_EMBED_DOC_RETRY;

  /* Sweep 8.2: memory-health turns amber above 10% failures since boot (three failures at least). */
  const amber = doc.diary.embedHealthAmber;
  const eh = (ok, failed, byPurpose) => ({ ok, failed, byPurpose, provider: 'compatible', model: 'qwen', lastError: 'timeout of 3000ms exceeded' });
  assert.equal(amber(eh(34, 8, { document: { ok: 29, failed: 7 }, tools: { ok: 2, failed: 1 }, query: { ok: 3, failed: 0 } }), {}).severity, 'amber', 'the Nov 13 live reading (19%) now warns');
  assert.match(amber(eh(34, 8, { document: { ok: 29, failed: 7 }, tools: { ok: 2, failed: 1 }, query: { ok: 3, failed: 0 } }), {}).detail, /8 of 42 .*19%.*tool queries 1 of 3, writes 7 of 36.*timeout of 3000ms/);
  assert.equal(amber(eh(95, 5), {}), null, '5% is quiet');
  assert.equal(amber(eh(90, 10), {}), null, 'exactly 10% is quiet');
  assert.equal(amber(eh(89, 11), {}).lane, 'embedding');
  assert.equal(amber(eh(8, 2), {}), null, 'two failures on a young process is not a warning yet');
  assert.equal(amber(eh(2, 1), {}).severity, 'amber', 'over 25% still speaks at any count, as before');
  assert.equal(amber(eh(0, 5), {}), null, 'all failed is the red rule in the route, not this one');
  assert.equal(amber(eh(50, 0), {}), null);
  assert.equal(amber(eh(34, 8), { KADE_EMBED_WARN_RATIO: '0.25' }), null, 'the old threshold by switch');
  assert.equal(amber(eh(34, 8), { KADE_EMBED_WARN_RATIO: 'junk' }).severity, 'amber');
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
