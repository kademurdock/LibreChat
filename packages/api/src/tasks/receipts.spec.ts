import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTaskReceipts, taskFingerprint } from './receipts';

let mongoServer: MongoMemoryServer;
const owner = { userId: 'user-test-1', tenantId: 'default' };
const fingerprint = taskFingerprint(['hi there', 'chat-1', 'parent-1', 'agent_x', 'agents']);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.collection('agenttasks').deleteMany({});
});

describe('task receipts: second send of the same message (Oct 29 2026)', () => {
  it('answers a second request id with the first request inside the window', async () => {
    const receipts = createTaskReceipts(mongoose);
    const first = await receipts.claim({
      ...owner,
      taskId: 'first-request-1',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(first.created).toBe(true);
    const second = await receipts.claim({
      ...owner,
      taskId: 'second-request-1',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(second.created).toBe(false);
    expect(second.task.taskId).toBe('first-request-1');
  });

  it('starts a new request when the window is off, the first failed, or the message differs', async () => {
    const receipts = createTaskReceipts(mongoose);
    await receipts.claim({ ...owner, taskId: 'first-request-2', fingerprint, conversationId: 'chat-1' });
    const off = await receipts.claim({
      ...owner,
      taskId: 'second-request-2',
      fingerprint,
      conversationId: 'chat-1',
    });
    expect(off.created).toBe(true);

    await receipts.settle(owner, 'first-request-2', 'failed');
    await receipts.settle(owner, 'second-request-2', 'stopped');
    const afterFailure = await receipts.claim({
      ...owner,
      taskId: 'third-request-2',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(afterFailure.created).toBe(true);

    const different = await receipts.claim({
      ...owner,
      taskId: 'fourth-request-2',
      fingerprint: taskFingerprint(['something else', 'chat-1', 'parent-1', 'agent_x', 'agents']),
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(different.created).toBe(true);
  });

  it('never reuses another person request', async () => {
    const receipts = createTaskReceipts(mongoose);
    await receipts.claim({ ...owner, taskId: 'first-request-3', fingerprint, conversationId: 'chat-1' });
    const other = await receipts.claim({
      userId: 'user-test-2',
      tenantId: 'default',
      taskId: 'other-request-3',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(other.created).toBe(true);
  });

  it('lets the same request id retry as before', async () => {
    const receipts = createTaskReceipts(mongoose);
    await receipts.claim({ ...owner, taskId: 'same-request-4', fingerprint, conversationId: 'chat-1' });
    const retry = await receipts.claim({
      ...owner,
      taskId: 'same-request-4',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(retry.created).toBe(false);
    expect(retry.task.taskId).toBe('same-request-4');
  });

  it('lets an old identical message through once the window has passed', async () => {
    const receipts = createTaskReceipts(mongoose);
    await receipts.claim({ ...owner, taskId: 'old-request-5', fingerprint, conversationId: 'chat-1' });
    await mongoose.connection
      .db!.collection('agenttasks')
      .updateOne({ taskId: 'old-request-5' }, { $set: { createdAt: new Date(Date.now() - 60000) } });
    const later = await receipts.claim({
      ...owner,
      taskId: 'new-request-5',
      fingerprint,
      conversationId: 'chat-1',
      dedupeWindowMs: 20000,
    });
    expect(later.created).toBe(true);
  });
});
