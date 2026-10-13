const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const api = require('@librechat/api');
const root = path.resolve(__dirname, '../../..');
const userId = 'synthetic-diary-user';
const agentId = 'agent_synthetic_diary';
const testVector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 0.2 : -0.1);

function diaryFixture(embedding) {
  const Module = require('node:module');
  const ts = require('typescript');
  const helperFile = path.join(root, 'packages/api/src/memory/embedding.ts');
  const helper = new Module(helperFile);
  helper.paths = Module._nodeModulePaths(path.dirname(helperFile));
  helper.require = (name) => name === 'axios' ? { post: embedding } : require(name);
  helper._compile(ts.transpileModule(fs.readFileSync(helperFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, helperFile);
  const env = { KADE_DIARY: '1', KADE_EMBED_GEMINI_KEY: 'synthetic-no-network-key' };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'api/models/kadeDiary.js'), 'utf8');
  vm.runInNewContext(source, {
    module,
    process: { env },
    require: (name) => {
      if (name === 'axios') return { post: embedding };
      if (name === '@librechat/api') return { ...api, ...helper.exports, memoryEmbeddingLane: () => helper.exports.memoryEmbeddingLane(env) };
      return require(name);
    },
  });
  return module.exports;
}

function delayedEmbedding() {
  let start;
  let release;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    post: async () => {
      start();
      await blocked;
      return { data: { embedding: { values: testVector } } };
    },
  };
}

test('real diary creation respects policy changes during embedding and insertion', async (t) => {
  const name = `diary_privacy_${randomUUID().replaceAll('-', '')}`;
  const mongo = await MongoMemoryServer.create({ instance: { dbName: name, ip: '127.0.0.1' } });
  await mongoose.connect(mongo.getUri(name));
  const User = mongoose.model(
    'User',
    new mongoose.Schema({ _id: String, personalization: Object }),
  );
  await User.create({ _id: userId, personalization: { memories: true } });
  t.after(async () => {
    assert.equal(mongoose.connection.name, name);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo.stop();
  });
  const write = async (diary, conversationId) => {
    const source = {
      userId,
      agentId,
      conversationId,
      kind: 'conversation',
      sourceAt: new Date(),
      revision: await schemas.memoryPolicyRevision(userId),
    };
    return schemas.memorySourceStorage.run(source, () =>
      diary.logDiaryEntry({
        userId,
        agentId,
        conversationId,
        text: `Finished folding a tiny paper crane for ${conversationId} and felt proud of its sturdy wings.`,
        origin: 'live_chat',
      }),
    );
  };

  await t.test(
    'allowed creation still saves a real dated entry and successful-write stamp',
    async () => {
      const diary = diaryFixture(async () => ({ data: { embedding: { values: testVector } } }));
      assert.equal((await write(diary, 'allowed-chat')).ok, true);
      const row = await diary.KadeDiaryEntry.findOne({ conversationId: 'allowed-chat' }).lean();
      assert.ok(row.writeActivity.live_chat.createdAt instanceof Date);
      assert.equal(row.embedding.length, 1536);
    },
  );

  for (const control of ['exclude', 'clear']) {
    await t.test(
      `${control} during the actual awaited embedding prevents a new diary row`,
      async () => {
        const delayed = delayedEmbedding();
        const diary = diaryFixture(delayed.post);
        const conversationId = `${control}-chat`;
        const pending = write(diary, conversationId);
        await delayed.started;
        if (control === 'exclude')
          await schemas.setConversationMemoryPolicy(userId, conversationId, true);
        else await schemas.setMemoryClearCutoff(userId, agentId);
        delayed.release();
        try {
          assert.equal((await pending).ok, false);
          assert.equal(await diary.KadeDiaryEntry.countDocuments({ conversationId }), 0);
        } finally {
          await diary.KadeDiaryEntry.deleteMany({ conversationId });
        }
      },
    );
  }

  await t.test('a policy change inside the actual insert removes only its new entry', async () => {
    const diary = diaryFixture(async () => ({ data: { embedding: { values: testVector } } }));
    const conversationId = 'insert-race-chat';
    const original = diary.KadeDiaryEntry.create;
    diary.KadeDiaryEntry.create = async function (...args) {
      const created = await original.apply(this, args);
      await schemas.setConversationMemoryPolicy(userId, conversationId, true);
      return created;
    };
    try {
      assert.equal((await write(diary, conversationId)).ok, false);
    } finally {
      diary.KadeDiaryEntry.create = original;
    }
    assert.equal(await diary.KadeDiaryEntry.countDocuments({ conversationId }), 0);
    assert.equal(await diary.KadeDiaryEntry.countDocuments({ conversationId: 'allowed-chat' }), 1);
  });
});
