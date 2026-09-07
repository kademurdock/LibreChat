// Real MongoDB, request controller, task router and generation manager.
// Only authentication, model execution and unrelated application services are replaced.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('module-alias').addAlias('~', path.resolve(__dirname, '..'));
const api = require('@librechat/api');
const { createAgentTaskModel } = require('@librechat/data-schemas');
const manager = api.GenerationJobManager;
const receipts = api.getTaskReceipts();
let mongo;
let app;
let modelCalls = 0;
let pending = 0;
const gates = new Map();
const Conversation = mongoose.model(
  'TaskTestConversation',
  new mongoose.Schema({
    conversationId: String,
    user: String,
    title: String,
    createdAt: Date,
  }),
);
const Message = mongoose.model(
  'TaskTestMessage',
  new mongoose.Schema({
    messageId: String,
    conversationId: String,
    user: String,
    text: String,
    isCreatedByUser: Boolean,
    unfinished: { type: Boolean, default: false },
    error: Boolean,
  }),
);
const queries = {
  getConvo: (user, conversationId) => Conversation.findOne({ user, conversationId }).lean(),
  getMessages: (filter) => Message.find(filter).lean(),
  saveMessage: async (_context, message) =>
    Message.findOneAndUpdate({ user: message.user, messageId: message.messageId }, message, {
      upsert: true,
      new: true,
    }),
};
const logger = { debug() {}, warn() {}, error() {}, info() {} };
const originalLoad = Module._load;
Module._load = function (id, parent, _main) {
  if (id === '@librechat/api')
    return {
      ...api,
      checkAndIncrementPendingRequest: async () => {
        pending++;
        return { allowed: true };
      },
      decrementPendingRequest: async () => {
        pending--;
      },
    };
  if (id === '@librechat/data-schemas') return { ...originalLoad.apply(this, arguments), logger };
  if (id === '@librechat/api/telemetry') return { createSseStreamTelemetry: () => ({}) };
  if (id === '~/models') return queries;
  if (id === '~/server/cleanup')
    return { disposeClient() {}, clientRegistry: null, requestDataMap: new WeakMap() };
  if (id === '~/server/services/MCPRequestContext')
    return { getMCPRequestContext() {}, cleanupMCPRequestContextForReq: async () => {} };
  if (id === '~/server/services/kadeLongTaskPing') return { pingIfLongAndUnwatched() {} };
  if (id === '~/server/utils/stripAiTells') return { scrubMessageForTransmit: (value) => value };
  if (id === '~/cache') return { logViolation: async () => {} };
  if (id === '~/server/middleware')
    return {
      requireJwtAuth: (req, _res, next) => {
        req.user = { id: req.get('x-test-user') || 'alice' };
        next();
      },
      uaParser: (_req, _res, next) => next(),
      checkBan: (_req, _res, next) => next(),
      messageIpLimiter: (_req, _res, next) => next(),
      messageUserLimiter: (_req, _res, next) => next(),
      configMiddleware: (_req, _res, next) => next(),
    };
  if (parent?.filename.endsWith(path.join('agents', 'index.js'))) {
    if (['./chat', './openai', './responses'].includes(id)) return express.Router();
    if (id === './v1') return { v1: express.Router() };
  }
  return originalLoad.apply(this, arguments);
};
const controller = require('../server/controllers/agents/request');
const routes = require('../server/routes/agents');

async function initializeClient({ req }) {
  if (req.body.text === 'fail initialization') throw new Error('Invented initialization failure');
  const client = {
    sender: 'Test Agent',
    options: {},
    savedMessageIds: new Set(),
    skipSaveUserMessage: false,
    async sendMessage(text, options) {
      modelCalls++;
      const user = {
        user: req.user.id,
        text,
        messageId: randomUUID(),
        conversationId: options.conversationId,
        isCreatedByUser: true,
      };
      const responseId = randomUUID();
      options.onStart(user, responseId, true);
      if (text === 'wait here') {
        await new Promise((resolve) => gates.set(req.body.messageId, resolve));
      }
      if (options.abortController.signal.aborted) throw new Error('Request aborted');
      if (text === 'fail generation') throw new Error('Invented model failure');
      const conversation = await Conversation.findOneAndUpdate(
        { conversationId: options.conversationId, user: req.user.id },
        { title: 'Invented test conversation', createdAt: new Date() },
        { upsert: true, new: true },
      );
      return {
        messageId: responseId,
        conversationId: options.conversationId,
        user: req.user.id,
        isCreatedByUser: false,
        text: 'Invented reply',
        sender: client.sender,
        databasePromise: Promise.resolve({ conversation: conversation.toObject() }),
      };
    },
  };
  return { client };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { bufferCommands: false });
  await createAgentTaskModel(mongoose).init();
  await manager.initialize();
  app = express();
  app.use(express.json());
  app.post('/send', (req, res, next) => {
    req.user = { id: req.get('x-test-user') || 'alice' };
    req.config = {};
    req.body.endpointOption = { endpoint: 'agents' };
    return controller(req, res, next, initializeClient, null);
  });
  app.use('/api/agents', routes);
});
after(async () => {
  for (const release of gates.values()) release();
  await manager.destroy();
  await mongoose.disconnect();
  await mongo.stop();
  Module._load = originalLoad;
});

const owner = { userId: 'alice' };
const claim = (taskId, extra = {}) =>
  receipts.claim({ ...owner, taskId, fingerprint: 'invented', ...extra });
async function terminal(taskId) {
  for (let i = 0; i < 100; i++) {
    const task = await receipts.get(owner, taskId);
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Request did not finish');
}

test('simultaneous sends claim one durable request across database clients', async () => {
  const db = new mongoose.Mongoose();
  await db.connect(mongo.getUri());
  try {
    // Same production module, independent Mongoose connection.
    const file = path.resolve(__dirname, '../../packages/api/src/tasks/receipts.ts');
    const ts = require('typescript');
    const isolated = new Module(file, module);
    isolated.filename = file;
    isolated.paths = module.paths;
    isolated._compile(
      ts.transpileModule(require('node:fs').readFileSync(file, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      file,
    );
    const second = isolated.exports.createTaskReceipts(db);
    const tasks = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 ? receipts : second).claim({
          ...owner,
          taskId: 'parallel-request',
          fingerprint: 'invented',
        }),
      ),
    );
    assert.equal(tasks.filter((task) => task.created).length, 1);
    assert.equal(new Set(tasks.map((task) => task.task.conversationId)).size, 1);
  } finally {
    await db.disconnect();
  }
});

test('owner and tenant scope separate identical request identifiers', async () => {
  const a = await claim('scoped-request');
  const b = await claim('scoped-request', { userId: 'bob' });
  const c = await claim('scoped-request', { tenantId: 'other' });
  assert.equal(new Set([a.task._id, b.task._id, c.task._id]).size, 3);
  assert.equal(await receipts.get({ userId: 'stranger' }, 'scoped-request'), null);
});

test('changed payload conflicts and cannot launch another run', async () => {
  await claim('payload-request');
  await assert.rejects(claim('payload-request', { fingerprint: 'different' }), api.TaskConflict);
});

test('temporary receipts hold no conversation text and stay out of the inbox', async () => {
  const { task } = await claim('temporary-request', { temporary: true });
  assert.ok(task.expiresAt > new Date());
  assert.equal(task.text, undefined);
  assert.equal(task.title, undefined);
  assert.equal(
    (await receipts.list(owner)).some((row) => row.taskId === task.taskId),
    false,
  );
});

test('settled results survive rereads and cannot be overwritten by late stop or error', async () => {
  await claim('finished-request');
  await receipts.settle(owner, 'finished-request', 'completed', {
    responseMessageId: 'saved-reply',
  });
  await receipts.settle(owner, 'finished-request', 'failed');
  const task = await receipts.get(owner, 'finished-request');
  assert.equal(task.status, 'completed');
  assert.equal(task.responseMessageId, 'saved-reply');
});

test('deleted chat retains only a hidden duplicate guard and rejects late writes', async () => {
  const { task } = await claim('deleted-request');
  const file = path.resolve(__dirname, '../../packages/data-schemas/src/models/agentTask.ts');
  const ts = require('typescript');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = module.paths;
  const load = Module._load;
  Module._load = function (id) {
    if (id === '../config/tenantContext') return { getTenantId: () => undefined };
    return load.apply(this, arguments);
  };
  try {
    mod._compile(
      ts.transpileModule(require('node:fs').readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      file,
    );
    await mod.exports.removeConversationTaskLinks(mongoose, owner.userId, [task.conversationId]);
  } finally {
    Module._load = load;
  }
  await receipts.settle(owner, task.taskId, 'completed', { responseMessageId: 'late' });
  const removed = await receipts.get(owner, task.taskId);
  assert.equal(removed.status, 'removed');
  assert.equal(removed.conversationId, '');
  assert.equal(removed.responseMessageId, undefined);
  await assert.rejects(claim(task.taskId), /deleted chat/);
  assert.equal(
    (await receipts.list(owner)).some((row) => row.taskId === task.taskId),
    false,
  );
});

test('missing streams and partial replies never masquerade as finished work', async () => {
  const { task } = await claim('lost-request');
  task.jobCreatedAt = 12;
  task.responseMessageId = 'reply';
  assert.equal(api.taskStatus(task, null), 'interrupted');
  assert.equal(api.taskStatus(task, { createdAt: 13, status: 'running' }), 'interrupted');
  assert.equal(api.taskStatus(task, null, { messageId: 'reply', unfinished: true }), 'interrupted');
  assert.equal(api.taskStatus(task, null, { messageId: 'reply' }), 'interrupted');
  assert.equal(
    api.taskStatus(task, null, { messageId: 'unrelated', unfinished: false }),
    'interrupted',
  );
  assert.equal(api.taskStatus(task, null, { messageId: 'reply', unfinished: false }), 'completed');
});

test('real controller coalesces duplicate POSTs and saves a completed receipt', async () => {
  const count = modelCalls;
  const body = { text: 'wait here', messageId: 'controller-request' };
  const first = await request(app).post('/send').send(body).expect(200);
  const second = await request(app).post('/send').send(body).expect(200);
  assert.equal(second.body.status, 'existing');
  assert.equal(first.body.conversationId, second.body.conversationId);
  assert.equal(modelCalls, count + 1);
  gates.get(body.messageId)();
  const task = await terminal(body.messageId);
  assert.equal(task.status, 'completed');
  assert.ok(await Message.findOne({ messageId: task.responseMessageId, user: owner.userId }));
  const third = await request(app).post('/send').send(body).expect(200);
  assert.equal(third.body.taskStatus, 'completed');
  assert.equal(modelCalls, count + 1);
});

test('regenerate, continue and edit retries run once while a new request still creates a branch', async () => {
  for (const variant of [
    { isRegenerate: true },
    { isContinued: true },
    { editedContent: { type: 'text', text: 'edited', index: 0 } },
  ]) {
    const count = modelCalls;
    const body = {
      text: 'invented branch',
      messageId: randomUUID(),
      requestId: randomUUID(),
      ...variant,
    };
    await request(app).post('/send').send(body).expect(200);
    await terminal(body.requestId);
    const duplicate = await request(app).post('/send').send(body).expect(200);
    assert.equal(duplicate.body.status, 'existing');
    assert.equal(modelCalls, count + 1);
    const next = { ...body, requestId: randomUUID() };
    await request(app).post('/send').send(next).expect(200);
    await terminal(next.requestId);
    assert.equal(modelCalls, count + 2);
  }
});

test('receipt and stream checks reject a replacement request in the same conversation', async () => {
  const { task } = await claim('replaced-request');
  const original = await manager.createJob(task.conversationId, 'alice', task.conversationId);
  await manager.updateMetadata(task.conversationId, { taskId: task.taskId });
  await receipts.bind(owner, task.taskId, original.createdAt);
  const first = await request(app).get('/api/agents/chat/tasks/replaced-request').expect(200);
  assert.equal(first.body.streamAvailable, true);
  await manager.completeJob(task.conversationId);
  await manager.createJob(task.conversationId, 'alice', task.conversationId);
  await manager.updateMetadata(task.conversationId, { taskId: 'replacement-request' });
  await manager.emitChunk(task.conversationId, { message: 'replacement-buffer-marker' });
  const second = await request(app).get('/api/agents/chat/tasks/replaced-request').expect(200);
  assert.equal(second.body.streamAvailable, false);
  await request(app)
    .get(`/api/agents/chat/stream/${task.conversationId}?taskId=replaced-request`)
    .expect(409);
  const emitted = [];
  const result = await manager.subscribeWithResume(
    task.conversationId,
    (event) => emitted.push(event),
    undefined,
    undefined,
    { expectedTaskId: task.taskId },
  );
  assert.equal(result.subscription, null);
  assert.equal(result.resumeState, null);
  assert.deepEqual(emitted, []);
  const replacementEvents = [];
  const replacement = await manager.subscribe(
    task.conversationId,
    (event) => replacementEvents.push(event),
    undefined,
    undefined,
    { expectedTaskId: 'replacement-request' },
  );
  assert.ok(replacementEvents.some((event) => event.message === 'replacement-buffer-marker'));
  replacement.unsubscribe();
  await manager.completeJob(task.conversationId);
});

test('conflicting POST preserves the original live job', async () => {
  const body = { text: 'wait here', messageId: 'conflicting-request' };
  const first = await request(app).post('/send').send(body).expect(200);
  await request(app)
    .post('/send')
    .send({ ...body, text: 'changed' })
    .expect(409);
  assert.equal((await manager.getJob(first.body.streamId)).status, 'running');
  gates.get(body.messageId)();
  await terminal(body.messageId);
});

test('task API returns saved links only for the authenticated owner', async () => {
  const response = await request(app).get('/api/agents/chat/tasks/controller-request').expect(200);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.canOpenConversation, true);
  assert.equal(response.headers['cache-control'], 'no-store');
  await request(app)
    .get('/api/agents/chat/tasks/controller-request')
    .set('x-test-user', 'bob')
    .expect(404);
  const list = await request(app)
    .get('/api/agents/chat/tasks?userId=alice')
    .set('x-test-user', 'nobody')
    .expect(200);
  assert.deepEqual(list.body.tasks, []);
});

test('Stop with an expired explicit ID never falls back to a different chat', async () => {
  const job = await manager.createJob('another-chat', 'alice', 'another-chat');
  await request(app).post('/api/agents/chat/abort').send({ streamId: 'expired-chat' }).expect(404);
  assert.equal(job.abortController.signal.aborted, false);
  assert.ok(await manager.getJob('another-chat'));
  await manager.completeJob('another-chat');
});

test('Stop without an ID rejects ambiguity rather than selecting the first active chat', async () => {
  const one = await manager.createJob('first-chat', 'alice', 'first-chat');
  const two = await manager.createJob('second-chat', 'alice', 'second-chat');
  await request(app).post('/api/agents/chat/abort').send({ conversationId: 'new' }).expect(409);
  assert.equal(one.abortController.signal.aborted, false);
  assert.equal(two.abortController.signal.aborted, false);
  await manager.completeJob('first-chat');
  await manager.completeJob('second-chat');
});

test('Stop records its intended request and a late completion cannot change it', async () => {
  const body = { text: 'wait here', messageId: 'stopped-request' };
  const start = await request(app).post('/send').send(body).expect(200);
  await request(app)
    .post('/api/agents/chat/abort')
    .send({ streamId: start.body.streamId })
    .expect(200);
  gates.get(body.messageId)();
  const task = await terminal(body.messageId);
  assert.equal(task.status, 'stopped');
});

test('initialization and model errors produce failed receipts, not completed results', async () => {
  for (const [text, messageId] of [
    ['fail initialization', 'init-error-request'],
    ['fail generation', 'model-error-request'],
  ]) {
    await request(app).post('/send').send({ text, messageId }).expect(200);
    assert.equal((await terminal(messageId)).status, 'failed');
  }
});

test('cursor pages never repeat equal-time rows and exclude temporary entries', async () => {
  const pagingOwner = { userId: 'paging-user' };
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      receipts.claim({
        ...pagingOwner,
        taskId: `page-request-${i}`,
        fingerprint: 'invented',
      }),
    ),
  );
  await createAgentTaskModel(mongoose).updateMany(
    { userId: pagingOwner.userId },
    { $set: { createdAt: new Date('2026-09-06') } },
    { timestamps: false },
  );
  const first = (await receipts.list(pagingOwner)).slice(0, 20);
  const second = await receipts.list(pagingOwner, first[19].taskId);
  assert.equal(first.length, 20);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map((row) => row.taskId)).size, 25);
});

test('finished requests release the pending-request counter', async () => {
  for (let i = 0; i < 100 && pending; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pending, 0);
});
