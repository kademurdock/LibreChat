import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const require = createRequire(import.meta.url);
const {
  createModels,
  tenantStorage,
  setConversationMemoryPolicy,
  setMemoryClearCutoff,
} = require('@librechat/data-schemas');
const {
  captureMemoryArtifactContext,
  persistMemoryArtifacts,
  scheduleMemoryArtifactPersistence,
  GenerationJobManager,
  createMemoryCallback,
} = require('@librechat/api');
const name = `memory_artifact_${randomUUID().replaceAll('-', '')}`;
const userId = '000000000000000000000001';
const conversationId = randomUUID();
const messageId = randomUUID();
let server, models;
const context = (extra = {}) =>
  captureMemoryArtifactContext({
    kind: 'conversation',
    userId,
    conversationId,
    messageId,
    sourceAt: new Date(),
    revision: 0,
    ...extra,
  });
const attachment = (extra = {}) => ({
  type: 'memory',
  toolCallId: 'call_fixture',
  messageId: 'wrong-late-metadata',
  conversationId: 'wrong-late-conversation',
  memory: {
    key: 'fixture_snack',
    value: 'Synthetic salted pretzels.',
    type: 'update',
    tokenCount: 7,
  },
  ...extra,
});
const reply = async (extra = {}) =>
  models.Message.create({
    user: userId,
    conversationId,
    messageId,
    text: 'The synthetic reply is complete.',
    isCreatedByUser: false,
    attachments: [],
    ...extra,
  });
const read = async () => models.Message.findOne({ user: userId, conversationId, messageId }).lean();

before(async () => {
  server = await MongoMemoryServer.create({
    binary: { version: '8.2.1' },
    instance: { dbName: name, ip: '127.0.0.1' },
  });
  await mongoose.connect(server.getUri(name), { serverSelectionTimeoutMS: 5000 });
  models = createModels(mongoose);
  await models.Message.init();
  await models.Conversation.init();
});
beforeEach(async () => {
  assert.equal(mongoose.connection.name, name);
  for (const collection of [
    'messages',
    'conversations',
    'users',
    'kadememorypolicies',
    'kadememoryepochs',
    'kadememoryclears',
  ]) {
    await mongoose.connection.collection(collection).deleteMany({});
  }
  await mongoose.connection
    .collection('users')
    .insertOne({ _id: new mongoose.Types.ObjectId(userId), personalization: { memories: true } });
  await models.Conversation.create({
    user: userId,
    conversationId,
    title: 'Synthetic fixture',
    endpoint: 'agents',
  });
});
after(async () => {
  try {
    assert.equal(mongoose.connection.name, name);
    assert.match(name, /^memory_artifact_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
    await server?.stop();
  }
});

test('late keeper after final/job deletion retains receipt on exact saved reply', async () => {
  const captured = context();
  const job = await GenerationJobManager.createJob(conversationId, userId, conversationId);
  await GenerationJobManager.updateMetadata(conversationId, { responseMessageId: messageId });
  await GenerationJobManager.completeJob(conversationId);
  assert.equal(await GenerationJobManager.hasJob(conversationId), false);
  let resolveMemory;
  const memoryResult = new Promise((resolve) => {
    resolveMemory = resolve;
  });
  const responseSaved = reply();
  const observed = scheduleMemoryArtifactPersistence({
    context: captured,
    memoryResult,
    responseSaved,
  });
  // Client disposal/new mutable IDs cannot redirect this captured work.
  resolveMemory([attachment()]);
  assert.equal(await observed, 1);
  const stored = await read();
  assert.equal(stored.attachments[0].messageId, messageId);
  assert.equal(stored.attachments[0].conversationId, conversationId);
  assert.equal(stored.text, 'The synthetic reply is complete.');
});

test('early keeper waits for actual saved reply without blocking caller', async () => {
  let saved;
  const responseSaved = new Promise((resolve) => {
    saved = resolve;
  });
  const observed = scheduleMemoryArtifactPersistence({
    context: context(),
    memoryResult: Promise.resolve([attachment()]),
    responseSaved,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await models.Message.countDocuments(), 0);
  await reply();
  saved(undefined);
  assert.equal(await observed, 1);
});

test('missing, deleted conversation/reply, wrong owner/conversation, or user message are never recreated', async () => {
  assert.equal(await persistMemoryArtifacts(context(), [attachment()]), 0);
  assert.equal(await models.Message.countDocuments(), 0);
  await reply({ isCreatedByUser: true });
  assert.equal(await persistMemoryArtifacts(context(), [attachment()]), 0);
  await models.Message.deleteMany({});
  await reply();
  assert.equal(
    await persistMemoryArtifacts(context({ userId: '000000000000000000000002' }), [attachment()]),
    0,
  );
  assert.equal(
    await persistMemoryArtifacts(context({ conversationId: randomUUID() }), [attachment()]),
    0,
  );
  await models.Conversation.deleteMany({});
  assert.equal(await persistMemoryArtifacts(context(), [attachment()]), 0);
  assert.deepEqual((await read()).attachments, []);
});

test('replayed/reordered metadata is idempotent and ordinary attachments survive concurrent appends', async () => {
  await reply({ attachments: [{ type: 'image', file_id: 'existing-photo' }] });
  await Promise.all([
    persistMemoryArtifacts(context(), [attachment()]),
    persistMemoryArtifacts(context(), [attachment({ messageId: 'another-late-id' })]),
    persistMemoryArtifacts(context(), [attachment({ toolCallId: 'call_fixture_second' })]),
  ]);
  const stored = await read();
  assert.equal(stored.attachments.length, 3);
  assert.equal(stored.attachments[0].file_id, 'existing-photo');
  assert.equal(stored.attachments.filter((a) => a.toolCallId === 'call_fixture').length, 1);
});

test('off record, exclusion, epoch advance/clear, or memory toggle prevent late artifacts', async () => {
  await reply();
  assert.equal(
    await persistMemoryArtifacts(context({ currentOffRecord: true }), [attachment()]),
    0,
  );
  const beforeExclusion = context();
  await setConversationMemoryPolicy(userId, conversationId, true);
  assert.equal(await persistMemoryArtifacts(beforeExclusion, [attachment()]), 0);
  await setConversationMemoryPolicy(userId, conversationId, false);
  const beforeClear = context({ revision: 2 });
  await setMemoryClearCutoff(userId);
  assert.equal(await persistMemoryArtifacts(beforeClear, [attachment()]), 0);
  await mongoose.connection.collection('kadememoryclears').deleteMany({});
  await mongoose.connection.collection('kadememoryepochs').deleteMany({});
  await mongoose.connection
    .collection('users')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { 'personalization.memories': false } },
    );
  assert.equal(await persistMemoryArtifacts(context(), [attachment()]), 0);
  assert.deepEqual((await read()).attachments, []);
});

test('captured tenant survives out-of-context completion and cannot target another tenant', async () => {
  await tenantStorage.run({ tenantId: 'fixture-a', userId }, async () => {
    await models.Conversation.create({
      user: userId,
      conversationId,
      title: 'Tenant fixture',
      endpoint: 'agents',
    });
    await reply();
  });
  await tenantStorage.run({ tenantId: 'fixture-b', userId }, async () => {
    await models.Conversation.create({
      user: userId,
      conversationId,
      title: 'Other tenant',
      endpoint: 'agents',
    });
    await reply();
  });
  const captured = tenantStorage.run({ tenantId: 'fixture-a', userId }, () => context());
  assert.equal(await persistMemoryArtifacts(captured, [attachment()]), 1);
  const tenantA = await tenantStorage.run({ tenantId: 'fixture-a', userId }, async () => read());
  const tenantB = await tenantStorage.run({ tenantId: 'fixture-b', userId }, async () => read());
  assert.equal(tenantA.attachments.length, 1);
  assert.equal(tenantB.attachments.length, 0);
});

test('epoch change inside the database update removes the in-flight receipt', async () => {
  await reply();
  const captured = context();
  const original = models.Message.updateOne;
  let raced = false;
  models.Message.updateOne = function (...args) {
    if (!raced && args[1].$push) {
      raced = true;
      return (async () => {
        await setConversationMemoryPolicy(userId, conversationId, true);
        return original.apply(this, args);
      })();
    }
    return original.apply(this, args);
  };
  try {
    assert.equal(await persistMemoryArtifacts(captured, [attachment()]), 0);
    assert.deepEqual((await read()).attachments, []);
  } finally {
    models.Message.updateOne = original;
  }
});

test('old response cannot emit an artifact to replacement generation on same conversation stream', async () => {
  const newer = randomUUID();
  await GenerationJobManager.createJob(conversationId, userId, conversationId);
  await GenerationJobManager.updateMetadata(conversationId, { responseMessageId: newer });
  GenerationJobManager.runtimeState.get(conversationId).hasSubscriber = true;
  let count = 0;
  const original = GenerationJobManager.eventTransport.emitChunk;
  GenerationJobManager.eventTransport.emitChunk = async () => {
    count++;
  };
  try {
    await GenerationJobManager.emitChunk(
      conversationId,
      { event: 'attachment', data: attachment() },
      messageId,
    );
    assert.equal(count, 0);
    await GenerationJobManager.emitChunk(
      conversationId,
      { event: 'attachment', data: attachment() },
      newer,
    );
    assert.equal(count, 1);
  } finally {
    GenerationJobManager.eventTransport.emitChunk = original;
    await GenerationJobManager.completeJob(conversationId);
  }
});

test('privacy change during a later append removes all receipts from this invocation only', async () => {
  await reply({ attachments: [{ type: 'image', file_id: 'keep-photo' }] });
  const captured = context();
  const original = models.Message.updateOne;
  let pushes = 0;
  models.Message.updateOne = function (...args) {
    if (args[1].$push && ++pushes === 2) {
      return (async () => {
        await setConversationMemoryPolicy(userId, conversationId, true);
        return original.apply(this, args);
      })();
    }
    return original.apply(this, args);
  };
  try {
    assert.equal(await persistMemoryArtifacts(captured, [attachment(), attachment({ toolCallId: 'second-call' })]), 0);
    const saved = await read();
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.attachments[0].file_id, 'keep-photo');
  } finally { models.Message.updateOne = original; }
});

test('ended legacy HTTP retains actual artifact for persistence without writing closed response', async () => {
  await reply();
  const artifacts = [];
  let writes = 0;
  const callback = createMemoryCallback({
    res: {
      headersSent: true,
      writableEnded: true,
      destroyed: false,
      write() {
        writes++;
        throw new Error('closed response');
      },
    },
    artifactPromises: artifacts,
    messageId,
    conversationId,
  });
  await callback(
    { output: { artifact: { memory: attachment().memory }, tool_call_id: 'legacy-fixture' } },
    { run_id: 'wrong-late-id', thread_id: 'wrong-late-chat' },
  );
  const actual = await Promise.all(artifacts);
  assert.equal(writes, 0);
  assert.equal(actual[0].messageId, messageId);
  assert.equal(await persistMemoryArtifacts(context(), actual), 1);
  assert.equal((await read()).attachments[0].toolCallId, 'legacy-fixture');
});
