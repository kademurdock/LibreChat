/**
 * Characters speaking first: where a post lands, and the task rules around it.
 * The hidden turn itself (compose) needs the whole site and is checked live.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

/* A Stop landing on another server is looked for every 15 s live; here, quickly. */
process.env.KADE_TASK_CANCEL_LOOK_MS = '60';

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
    let release;
    const spy = jest.spyOn(turn, 'speakFirst').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
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
    /* The stopped turn ends; nothing is posted and this server's job is over. */
    release({ posted: false, composeConversationId: null });
    await new Promise((r) => setTimeout(r, 100));
    expect((await tasks.list({ userId }))[0].status).toBe('cancelled');
    expect(tasks.runningHere()).toBe(0);
    spy.mockRestore();
  });

  test('only a task older than the work limit is called lost; a fresh one keeps running', async () => {
    await mongoose.connection.collection('kadetasks').deleteMany({});
    const postSpy = jest.spyOn(turn, 'post').mockResolvedValue({ conversationId: 'c-x', messageId: 'm-x', created: false });
    const pushSpy = jest.spyOn(turn, 'notifyPost').mockResolvedValue({ ok: true });
    await mongoose.connection.collection('kadetasks').insertMany([
      { taskId: 'told', userId, agentId: AGENT, title: 'old job', status: 'running', createdAt: new Date(Date.now() - 30 * 60000), bootId: 'other' },
      { taskId: 'tfresh', userId, agentId: AGENT, title: 'fresh job', status: 'running', createdAt: new Date(Date.now() - 60000), bootId: 'other' },
    ]);
    await tasks.sweepInterrupted();
    const rows = await tasks.list({ userId });
    expect(rows.find((r) => r.taskId === 'told').status).toBe('interrupted');
    expect(rows.find((r) => r.taskId === 'tfresh').status).toBe('running');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0].text).toMatch(/restarted while I was working/);
    postSpy.mockRestore();
    pushSpy.mockRestore();
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

describe('deploys and restarts (Oct 17 2026)', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const answer = {
    posted: true,
    conversationId: 'c-1',
    messageId: 'm-1',
    text: 'Found it.',
    toolCalls: 1,
    composeConversationId: null,
  };
  let otherAdult;

  beforeAll(async () => {
    otherAdult = String(
      (
        await mongoose.models.User.create({
          name: 'Other Grown Up',
          email: 'adult2@example.com',
          username: 'adult2',
          provider: 'local',
          role: 'USER',
        })
      )._id,
    );
  });

  beforeEach(async () => {
    await mongoose.connection.collection('kadetasks').deleteMany({});
    tasks.holdStarts(false);
  });

  afterEach(() => {
    tasks.holdStarts(false);
    jest.restoreAllMocks();
  });

  test('a shutdown waits for the running job and refuses new starts; the refused price still stands', async () => {
    let finish;
    const speak = jest.spyOn(turn, 'speakFirst').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(answer);
        }),
    );
    const q1 = await tasks.quote({
      req: req(userId),
      agentId: AGENT,
      goal: 'find a dentist open on Saturdays',
    });
    expect(
      (
        await tasks.start({
          req: req(userId),
          agentId: AGENT,
          agentName: 'Testa',
          quoteId: q1.quoteId,
        })
      ).ok,
    ).toBe(true);
    await sleep(50);
    let drained = null;
    const draining = tasks.drain({ budgetMs: 10000 }).then((out) => {
      drained = out;
    });
    await sleep(50);
    expect(drained).toBeNull();
    const q2 = await tasks.quote({
      req: req(otherAdult),
      agentId: AGENT,
      goal: 'compare two library card renewals',
    });
    const refused = await tasks.start({
      req: req(otherAdult),
      agentId: AGENT,
      quoteId: q2.quoteId,
    });
    expect(refused).toMatchObject({ ok: false, draining: true });
    expect(refused.error).toMatch(/restarting/);
    expect(await tasks.busy()).toMatchObject({ here: 1, running: 1, draining: true });
    finish();
    await draining;
    expect(drained).toMatchObject({ cutOff: 0 });
    expect((await tasks.list({ userId }))[0].status).toBe('done');
    /* The new server takes the same price. */
    tasks.holdStarts(false);
    speak.mockResolvedValue(answer);
    expect(
      (await tasks.start({ req: req(otherAdult), agentId: AGENT, quoteId: q2.quoteId })).ok,
    ).toBe(true);
    await sleep(100);
  });

  test('a job the shutdown cannot wait for is marked interrupted at once, told, and never posts late', async () => {
    let finish;
    jest.spyOn(turn, 'speakFirst').mockImplementation(async (opts) => {
      await new Promise((r) => {
        finish = r;
      });
      return (await opts.beforePost({})) ? answer : { posted: false, composeConversationId: null };
    });
    const postSpy = jest
      .spyOn(turn, 'post')
      .mockResolvedValue({ conversationId: 'c-x', messageId: 'm-x', created: false });
    jest.spyOn(turn, 'notifyPost').mockResolvedValue({ ok: true });
    const q = await tasks.quote({
      req: req(userId),
      agentId: AGENT,
      goal: 'read every review of three freezers',
    });
    await tasks.start({ req: req(userId), agentId: AGENT, agentName: 'Testa', quoteId: q.quoteId });
    await sleep(50);
    const out = await tasks.drain({ budgetMs: 100 });
    expect(out.cutOff).toBe(1);
    expect((await tasks.list({ userId }))[0].status).toBe('interrupted');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0].text).toMatch(/restarted while I was working/);
    finish();
    await sleep(150);
    expect((await tasks.list({ userId }))[0].status).toBe('interrupted');
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test('busy counts fresh running jobs anywhere, never stale rows the sweep has yet to close', async () => {
    await mongoose.connection.collection('kadetasks').insertMany([
      {
        taskId: 'tf',
        userId,
        agentId: AGENT,
        title: 'fresh',
        status: 'running',
        createdAt: new Date(Date.now() - 2 * 60000),
        bootId: 'other',
      },
      {
        taskId: 'ts',
        userId,
        agentId: AGENT,
        title: 'stale',
        status: 'running',
        createdAt: new Date(Date.now() - 30 * 60000),
        bootId: 'other',
      },
      {
        taskId: 'td',
        userId,
        agentId: AGENT,
        title: 'done',
        status: 'done',
        createdAt: new Date(),
      },
    ]);
    expect(await tasks.busy()).toMatchObject({
      here: 0,
      running: 1,
      draining: false,
      dbCounted: true,
    });
  });

  test("the drain budget leaves room inside Railway's window", () => {
    const keep = { ...process.env };
    delete process.env.KADE_TASK_DRAIN_MS;
    process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS = '1200';
    expect(tasks.drainBudgetMs()).toBe(1155000);
    delete process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
    expect(tasks.drainBudgetMs()).toBe(17.5 * 60000);
    process.env.KADE_TASK_DRAIN_MS = '0';
    expect(tasks.drainBudgetMs()).toBe(0);
    process.env = keep;
  });

  test('a Stop that lands on another server is noticed by the server running the job', async () => {
    let finish;
    jest.spyOn(turn, 'speakFirst').mockImplementation(async (opts) => {
      await opts.onStart({ streamId: 'stream-elsewhere' });
      await new Promise((r) => {
        finish = r;
      });
      return (await opts.beforePost({})) ? answer : { posted: false, composeConversationId: null };
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    const q = await tasks.quote({
      req: req(userId),
      agentId: AGENT,
      goal: 'find a plumber who works weekends',
    });
    const s = await tasks.start({
      req: req(userId),
      agentId: AGENT,
      agentName: 'Testa',
      quoteId: q.quoteId,
    });
    await sleep(50);
    /* What cancel() on the other server writes. */
    await mongoose.connection
      .collection('kadetasks')
      .updateOne({ taskId: s.taskId }, { $set: { status: 'cancel-requested' } });
    await sleep(250);
    const aborts = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/agents/chat/abort'),
    );
    expect(aborts).toHaveLength(1);
    expect(JSON.parse(aborts[0][1].body)).toEqual({ streamId: 'stream-elsewhere' });
    finish();
    await sleep(150);
    expect((await tasks.list({ userId }))[0].status).toBe('cancelled');
  });
});
