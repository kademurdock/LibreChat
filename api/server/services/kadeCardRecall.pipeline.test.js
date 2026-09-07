const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real recall service AND vector ranking. Only storage, embedding,
// and ancillary services are replaced; no model calls or family data are used.
function fixture({ shared = [], own = [], others = {}, vectors, failReads = false } = {}) {
  const reads = [];
  const audits = [];
  const logger = { info() {}, warn() {} };
  const cards = { '': shared, companion: own, ...others };
  const vectorRows = vectors || Object.entries(cards).flatMap(([agentId, rows]) =>
    rows.map((m) => ({ key: m.key, agentId: agentId || null, embedding: m.vector || [1, 0] })));
  const vectorModel = {
    find(filter) {
      assert.equal(filter.userId, 'seat');
      const scopes = new Set(filter.$or.map((x) => x.agentId));
      return { select: () => ({ lean: async () => vectorRows.filter((x) => scopes.has(x.agentId)) }) };
    },
  };
  class Schema { index() {} }
  const diary = {
    embedText: async () => [1, 0], currentEmbedModel: () => 'fixture-model',
    countEntries: async () => 0, searchDiary: async () => [],
  };
  const load = (file, deps, env = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, exports: module.exports, process: { env }, console,
      setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; },
      clearTimeout,
      require(id) {
        if (Object.hasOwn(deps, id)) return deps[id];
        if (id === 'crypto') return require('node:crypto');
        throw new Error('Unexpected dependency: ' + id);
      },
    }, { filename: file });
    return module.exports;
  };
  const ranking = load(path.join(__dirname, '../../models/kadeCardVector.js'), {
    mongoose: { Schema, models: { KadeCardVector: vectorModel } },
    '@librechat/data-schemas': { logger }, '~/models/kadeDiary': diary,
  });
  const service = load(path.join(__dirname, 'kadeCardRecall.js'), {
    '@librechat/data-schemas': { logger },
    '~/models': { getAllUserMemories: async (userId, { agentId }) => {
      assert.equal(userId, 'seat'); reads.push(agentId || '');
      if (failReads) throw new Error('storage unavailable');
      return cards[agentId || ''] || [];
    } },
    '~/models/kadeDiary': diary,
    '~/models/kadeCardVector': { ...ranking, syncBucketVectors: async () => {} },
    '~/server/services/kadeOpenLoops': { describeStale: () => '', isExpired: () => false, cardDate: () => 0 },
    './kadeToolRetrieval': { memoEmbed: (_req, embed) => embed },
    './kadeMemoryShare': {
      otherBucketsFor: async () => Object.keys(others),
      agentNameOf: async () => 'Other companion', shareNotice: async () => '',
    },
    '~/models/kadeRecallAudit': { storeRecallAudit: (row) => audits.push(row) },
  }, { KADE_MEMORY_RAG: '1', KADE_MEMORY_RAG_AGENTS: 'all', KADE_ECHOES: '0' });
  const run = () => service.getRecallTailBlock({ userId: 'seat', agentId: 'companion', userText: 'Tell me about the telescope project.', req: {} });
  return { run, reads, audits };
}

const card = (key, value, agentId = 'companion', vector = [1, 0]) =>
  ({ key, value, agentId, tokenCount: 200, updated_at: '2026-09-06', vector });

test('pinned facts cannot crowd a useful memory out of the top eight', async () => {
  const own = Array.from({ length: 8 }, (_, i) => card('identity_' + i, 'Pinned fact ' + i));
  own.push(card('telescope_project', 'Building a telescope with a friend.', 'companion', [0.8, 0.6]));
  const f = fixture({ own });
  const { block } = await f.run();
  assert.match(block || '', /Building a telescope/);
  assert.doesNotMatch(block, /Pinned fact/);
  assert.deepEqual(Array.from(f.audits[0].cards), ['telescope_project']);
});

test('deleted vectors and secondhand duplicate keys do not spend recall slots', async () => {
  const own = [card('current_project', 'The current project is a telescope.', 'companion', [0.8, 0.6])];
  const others = { friend: [card('current_project', 'Old secondhand project.', 'friend'), card('unique_hobby', 'Enjoys pottery.', 'friend', [0.7, 0.7])] };
  const vectors = Array.from({ length: 8 }, (_, i) => ({ key: 'deleted_' + i, agentId: null, embedding: [1, 0] }));
  vectors.push(...[...own, ...others.friend].map((m) => ({ key: m.key, agentId: m.agentId, embedding: m.vector })));
  const f = fixture({ own, others, vectors });
  const { block } = await f.run();
  assert.match(block || '', /current project is a telescope/);
  assert.match(block, /Enjoys pottery/);
  assert.match(block, /secondhand/);
  assert.doesNotMatch(block, /Old secondhand/);
});

test('one live read per bucket serves recall, open loops, and vector refresh', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.reads.sort(), ['', 'companion']);
  await f.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reads.length, 4, 'a later turn must read fresh cards');
});

test('an unavailable card store returns a safe empty recall', async () => {
  const f = fixture({ failReads: true, own: [card('hobby', 'Enjoys pottery.')] });
  const result = await f.run();
  assert.equal(result.block, null);
});
