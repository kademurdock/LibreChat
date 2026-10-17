/**
 * Characters speaking first: where a post lands, and the task rules around it.
 * The hidden turn itself (compose) needs the whole site and is checked live.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

jest.mock('~/server/services/kadeRealCost', () => ({
  platformFactor: () => 2,
  userPriceFactor: (role) => (String(role).toUpperCase() === 'ADMIN' ? 1 : 2),
}));

let mongo;
let models;
let turn;
let tasks;
let userId;
let kidId;
const AGENT = 'agent_turn_test_00000000';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  models = require('~/models');
  turn = require('./kadeCharacterTurn');
  tasks = require('./kadeTasks');
  const User = mongoose.models.User;
  userId = String((await User.create({ name: 'Grown Up', email: 'adult@example.com', username: 'adult', provider: 'local', role: 'USER' }))._id);
  kidId = String((await User.create({ name: 'Kid', email: 'kid@example.com', username: 'kid', provider: 'local', role: 'USER', kadeAccountType: 'child' }))._id);
  await mongoose.connection.collection('agents').insertOne({
    id: AGENT,
    name: 'Testa',
    provider: 'openrouter',
    model: 'xiaomi/mimo-v2.6-pro',
    author: new mongoose.Types.ObjectId(),
    instructions: 'test',
    versions: [],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const req = (id, extra = {}) => ({ user: { id, role: 'USER' }, body: { conversationId: 'new', ...extra } });

test('a post with no recent conversation makes a new one titled for the character', async () => {
  const out = await turn.post({ userId, agentId: AGENT, text: '%%%warm%%% Hey, found it.', kind: 'post' });
  expect(out.created).toBe(true);
  const convo = await mongoose.models.Conversation.findOne({ conversationId: out.conversationId }).lean();
  expect(convo).toMatchObject({ agent_id: AGENT, endpoint: 'agents', user: userId, title: 'Testa' });
  const msg = await mongoose.models.Message.findOne({ messageId: out.messageId }).lean();
  expect(msg).toMatchObject({ isCreatedByUser: false, sender: 'Testa', text: '%%%warm%%% Hey, found it.' });
  expect(msg.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
  expect(msg.metadata.kadePost.kind).toBe('post');
});

test('a second post lands in the same recent conversation, after its newest message', async () => {
  const first = await turn.post({ userId, agentId: AGENT, text: 'one' });
  const second = await turn.post({ userId, agentId: AGENT, text: 'two' });
  expect(second.created).toBe(false);
  expect(second.conversationId).toBe(first.conversationId);
  const msg = await mongoose.models.Message.findOne({ messageId: second.messageId }).lean();
  expect(msg.parentMessageId).toBe(first.messageId);
});

test('a named conversation that belongs to someone else is never used', async () => {
  const theirs = await turn.post({ userId: kidId, agentId: AGENT, text: 'for the kid' });
  const mine = await turn.post({ userId, agentId: AGENT, text: 'for the adult', conversationId: theirs.conversationId });
  expect(mine.conversationId).not.toBe(theirs.conversationId);
});

test('the lock-screen preview drops voice directions and stops at a sentence', () => {
  const p = turn.pushPreview('%%%warm, bright%%% Found three freezers under four hundred dollars at stores in town. The best one is at Lowe\'s and it is on sale until Sunday, which matters because the price goes back up after that and I would not wait.');
  expect(p).not.toMatch(/%%%/);
  expect(p.length).toBeLessThanOrEqual(181);
  expect(p.startsWith('Found three freezers')).toBe(true);
});

describe('tasks', () => {
  test('a start without a quote is refused; a quote states the price and ceiling', async () => {
    const noQuote = await tasks.start({ req: req(userId), agentId: AGENT, quoteId: 'qnope' });
    expect(noQuote.ok).toBe(false);
    expect(noQuote.error).toMatch(/quote first/);
    const q = await tasks.quote({ req: req(userId), agentId: AGENT, goal: 'find the cheapest chest freezer in Springfield', steps: 10 });
    expect(q.ok).toBe(true);
    expect(q.spoken).toMatch(/at the very most/);
    expect(q.steps).toBe(10);
  });

  test('kids are turned away softly, before any price', async () => {
    const q = await tasks.quote({ req: req(kidId), agentId: AGENT, goal: 'find me a cool bike for my birthday' });
    expect(q.ok).toBe(false);
    expect(q.soft).toBe(true);
  });

  test('the phone lane on the service seat cannot start one for somebody else', async () => {
    const onBehalf = { user: { id: userId }, kadeOnBehalfOf: { id: kidId }, body: {} };
    const q = await tasks.quote({ req: onBehalf, agentId: AGENT, goal: 'look up something long for me' });
    expect(q.ok).toBe(false);
  });

  test('one task at a time, and a quote starts only once', async () => {
    const spy = jest.spyOn(turn, 'speakFirst').mockImplementation(() => new Promise(() => {}));
    const q1 = await tasks.quote({ req: req(userId), agentId: AGENT, goal: 'compare three phone plans for my mom' });
    const s1 = await tasks.start({ req: req(userId), agentId: AGENT, agentName: 'Testa', quoteId: q1.quoteId });
    expect(s1.ok).toBe(true);
    const again = await tasks.start({ req: req(userId), agentId: AGENT, quoteId: q1.quoteId });
    expect(again.ok).toBe(false);
    const q2 = await tasks.quote({ req: req(userId), agentId: AGENT, goal: 'and also find a good plumber nearby' });
    const s2 = await tasks.start({ req: req(userId), agentId: AGENT, quoteId: q2.quoteId });
    expect(s2.ok).toBe(false);
    expect(s2.error).toMatch(/one task at a time/);
    const listed = await tasks.list({ userId });
    expect(listed[0]).toMatchObject({ status: 'running', title: 'compare three phone plans for my mom' });
    const c = await tasks.cancel({ userId, taskId: s1.taskId });
    expect(c.ok).toBe(true);
    spy.mockRestore();
  });

  test('a finished task records where its answer went', async () => {
    await mongoose.connection.collection('kadetasks').deleteMany({});
    const spy = jest.spyOn(turn, 'speakFirst').mockResolvedValue({
      posted: true,
      conversationId: 'c-done',
      messageId: 'm-done',
      text: '%%%pleased%%% Done: the cheapest is forty dollars at the hardware store.',
      toolCalls: 3,
      composeConversationId: 'temp-1',
    });
    const q = await tasks.quote({ req: req(userId), agentId: AGENT, goal: 'find the cheapest box fan in town' });
    const s = await tasks.start({ req: req(userId), agentId: AGENT, agentName: 'Testa', quoteId: q.quoteId });
    expect(s.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await tasks.list({ userId });
    expect(row).toMatchObject({ status: 'done', conversationId: 'c-done' });
    expect(row.preview).toBe('Done: the cheapest is forty dollars at the hardware store.');
    spy.mockRestore();
  });
});
