/* Nov 10 2026 (the money review): kade_task start needs a price from an EARLIER turn of the
 * same conversation, the person's own plain yes, one start per turn, and a quote that is
 * claimed in one step. The real services/kadeTasks.js runs here against an in-memory database
 * (api/test/kadeFakeMongo.cjs); the hidden turn is a stand-in, so no model is called.
 *
 * Run: node --test api/server/services/kadeTasks.spend.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { FakeCollection, stubModules } = require('../../test/kadeFakeMongo.cjs');

const AGENT = 'agent_test';
let colls = {};
const users = {
  adult: { _id: 'adult', role: 'USER' },
  other: { _id: 'other', role: 'USER' },
  kid: { _id: 'kid', role: 'USER', kadeAccountType: 'child' },
};
const runs = [];

stubModules({
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
  mongoose: {
    connection: { collection: (name) => (colls[name] = colls[name] || new FakeCollection()) },
    models: { Agent: { findOne: () => ({ select: () => ({ lean: async () => ({ model: 'test-model' }) }) }) } },
  },
  '~/models': { getUserById: async (id) => users[id] || null, getMultiplier: () => 1 },
  '~/server/services/kadeRealCost': { PAYER_FIELDS: 'role', platformFactor: () => 2, userPriceFactor: () => 2 },
  '~/server/services/kadeCharacterTurn': {
    /* The job itself: recorded, then left running (never resolves), like a long hidden turn. */
    speakFirst: (args) => {
      runs.push(args);
      return new Promise(() => {});
    },
  },
});

const tasks = require('./kadeTasks');

const turn = (id, text, extra = {}) => ({ user: { id, role: 'USER' }, body: { conversationId: 'c-1', text, ...extra } });
const GOAL = 'find the cheapest chest freezer near the test town';
const quoteIn = async (req) => {
  const q = await tasks.quote({ req, agentId: AGENT, goal: GOAL, steps: 8 });
  assert.equal(q.ok, true);
  return q;
};
const startIn = (req, quoteId) => tasks.start({ req, agentId: AGENT, agentName: 'Testa', quoteId, conversationId: req.body.conversationId });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const running = () => (colls.kadetasks ? colls.kadetasks.rows.filter((r) => r.status === 'running').length : 0);

beforeEach(() => {
  colls = {};
  runs.length = 0;
  delete process.env.KADE_TASK_YES_GATE;
  delete process.env.KADE_TASK_ATOMIC_START;
});

test('happy path: price in one turn, a plain yes in the next, the job starts once', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  assert.match(q.spoken, /at the very most/);
  assert.match(q.spoken, /later reply/);
  const s = await startIn(turn('adult', 'Yes, go ahead'), q.quoteId);
  assert.equal(s.ok, true);
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(running(), 1);
  assert.ok(colls.kadetaskquotes.rows[0].usedAt instanceof Date);
  assert.equal(colls.kadetaskstarts.rows.length, 0, 'the start lock is let go');
});

test('refused: start in the same turn that made the quote, even when the message says yes', async () => {
  const req = turn('adult', 'yes do it');
  const q = await quoteIn(req);
  const s = await startIn(req, q.quoteId);
  assert.equal(s.ok, false);
  assert.match(s.error, /same reply/);
  assert.equal(running(), 0);
  assert.equal(colls.kadetaskquotes.rows[0].usedAt, undefined, 'the price still stands for the next turn');
  /* and the next turn, with their yes, starts it */
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
});

test('refused: "ok, read this page for me" is not a yes to the price', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  for (const said of ['ok, read this page for me', 'sure, what else can you do', 'how much was it again?', 'no', 'wait', '']) {
    const s = await startIn(turn('adult', said), q.quoteId);
    assert.equal(s.ok, false, said);
    assert.match(s.error, /not a plain yes/, said);
  }
  assert.equal(running(), 0);
});

test('refused: a quote from another conversation', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const s = await startIn(turn('adult', 'yes', { conversationId: 'c-2' }), q.quoteId);
  assert.equal(s.ok, false);
  assert.match(s.error, /different conversation/);
  assert.equal(running(), 0);
});

test('refused: no quote, another person\'s quote, a quote over an hour old', async () => {
  assert.match((await startIn(turn('adult', 'yes'), 'qnope')).error, /quote first/);
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  assert.match((await startIn(turn('other', 'yes'), q.quoteId)).error, /quote first/);
  colls.kadetaskquotes.rows[0].createdAt = new Date(Date.now() - 61 * 60000);
  assert.match((await startIn(turn('adult', 'yes'), q.quoteId)).error, /over an hour old/);
  assert.equal(running(), 0);
});

test('single use: the same quote never starts a second job, and a retried yes turn starts nothing new', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
  /* the yes turn sent again (regenerate): a new request carrying the same yes */
  const again = await startIn(turn('adult', 'yes'), q.quoteId);
  assert.equal(again.ok, false);
  assert.match(again.error, /already started/);
  /* even once the first job is over */
  colls.kadetasks.rows[0].status = 'done';
  assert.match((await startIn(turn('adult', 'yes'), q.quoteId)).error, /already started/);
  /* and a fresh quote in the retried turn cannot be started in that turn */
  const retry = turn('adult', 'yes');
  const q2 = await quoteIn(retry);
  assert.match((await startIn(retry, q2.quoteId)).error, /same reply/);
  await settle();
  assert.equal(runs.length, 1);
});

test('two start calls in one turn: exactly one job', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const req = turn('adult', 'yes');
  const out = await Promise.all([startIn(req, q.quoteId), startIn(req, q.quoteId), startIn(req, q.quoteId)]);
  assert.equal(out.filter((o) => o.ok).length, 1);
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(running(), 1);
});

test('two start calls in one turn with two different quotes: still exactly one job', async () => {
  const q1 = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const q2 = await quoteIn(turn('adult', 'and a second job please'));
  const req = turn('adult', 'yes');
  const out = await Promise.all([startIn(req, q1.quoteId), startIn(req, q2.quoteId)]);
  assert.equal(out.filter((o) => o.ok).length, 1);
  assert.match(out.find((o) => !o.ok).error, /one job per reply/);
  await settle();
  assert.equal(runs.length, 1);
});

test('two requests at the same moment (two servers): one job, by the one-step claim and the start lock', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const same = await Promise.all([startIn(turn('adult', 'yes'), q.quoteId), startIn(turn('adult', 'yes'), q.quoteId)]);
  assert.equal(same.filter((o) => o.ok).length, 1);
  await settle();
  assert.equal(running(), 1);
  /* two different quotes, two requests, same instant: the lock lets one through */
  colls = {};
  runs.length = 0;
  const qa = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const qb = await quoteIn(turn('adult', 'and a second job please'));
  const two = await Promise.all([startIn(turn('adult', 'yes'), qa.quoteId), startIn(turn('adult', 'yes'), qb.quoteId)]);
  assert.equal(two.filter((o) => o.ok).length, 1);
  await settle();
  assert.equal(running(), 1);
  assert.equal(runs.length, 1);
});

test('one task at a time and the daily cap still hold, and leave the quote unused', async () => {
  const q1 = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const q2 = await quoteIn(turn('adult', 'and a second job please'));
  assert.equal((await startIn(turn('adult', 'yes'), q1.quoteId)).ok, true);
  const s2 = await startIn(turn('adult', 'yes'), q2.quoteId);
  assert.match(s2.error, /one task at a time/);
  assert.equal(colls.kadetaskquotes.rows.find((r) => r.quoteId === q2.quoteId).usedAt, undefined);
});

test('the phone lane and a call turn: refused, in words that can be spoken', async () => {
  /* somebody else on the line: refused before any price, as before */
  const onBehalf = { ...turn('adult', 'yes'), kadeOnBehalfOf: { id: 'other' } };
  assert.equal((await tasks.quote({ req: onBehalf, agentId: AGENT, goal: GOAL })).error, 'phone lane');
  assert.equal((await startIn(onBehalf, 'q1')).error, 'phone lane');
  const unresolved = { ...turn('adult', 'yes'), kadeOnBehalfOfUnresolved: true };
  assert.equal((await startIn(unresolved, 'q1')).error, 'phone lane');

  /* the seat owner's own call: every call turn is a new conversation carrying the folded
   * history, where the character's own "okay, yes" sits. It never approves. */
  const call = (text, conversationId) => ({ ...turn('adult', text, { conversationId, kadeOnBehalfOf: 'seat@example.com' }), kadeOnBehalfOf: { id: 'adult' } });
  const q = await quoteIn(call('look up a cheap chest freezer for me', 'call-turn-1'));
  const folded =
    '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
    'THEM: look up a cheap chest freezer for me\nYOU: okay, yes, that is about 5 cents. Shall I go ahead?\n' +
    '— end of earlier context. Reply ONLY to what follows.]\n\n';
  const s = await startIn(call(folded + 'yes', 'call-turn-2'), q.quoteId);
  assert.equal(s.ok, false);
  assert.match(s.error, /cannot be started from a call/);
  /* same conversation id, but the fold cannot be isolated: still refused */
  const broken = await startIn(call('[EARLIER IN THIS CONVERSATION — context only:\nYOU: okay yes', 'call-turn-1'), q.quoteId);
  assert.match(broken.error, /cannot be started from a call/);
  /* same conversation id and a whole fold: only the last caller words are read */
  const notYes = await startIn(call(folded + 'what was that again', 'call-turn-1'), q.quoteId);
  assert.match(notYes.error, /not a plain yes/);
  assert.equal(running(), 0);
  const yes = await startIn(call(folded + 'yes', 'call-turn-1'), q.quoteId);
  assert.equal(yes.ok, true);
});

test('children are still turned away softly, and a background run still cannot start another', async () => {
  const kidQuote = await tasks.quote({ req: turn('kid', 'find me a cool bike'), agentId: AGENT, goal: GOAL });
  assert.deepEqual({ ok: kidQuote.ok, soft: kidQuote.soft }, { ok: false, soft: true });
  const kidStart = await startIn(turn('kid', 'yes'), 'q1');
  assert.deepEqual({ ok: kidStart.ok, soft: kidStart.soft }, { ok: false, soft: true });
  const hidden = { ...turn('adult', 'yes'), kadeHiddenRun: true };
  assert.match((await startIn(hidden, 'q1')).error, /background task cannot start another/);
});

test('a quote row from before this change (no turn, no conversation) still needs the yes', async () => {
  colls.kadetaskquotes = new FakeCollection();
  colls.kadetaskquotes.rows.push({ _id: 'old', quoteId: 'qold', userId: 'adult', agentId: AGENT, goal: GOAL, steps: 8, typicalUSD: 0.01, mostUSD: 0.02, createdAt: new Date() });
  assert.match((await startIn(turn('adult', 'ok, read this page for me'), 'qold')).error, /not a plain yes/);
  assert.equal((await startIn(turn('adult', 'yes'), 'qold')).ok, true);
});

test('KADE_TASK_YES_GATE=0 puts the old rule back (a quote row is enough); the claim stays one step', async () => {
  process.env.KADE_TASK_YES_GATE = '0';
  const req = turn('adult', 'can you find me a cheap chest freezer');
  const q = await quoteIn(req);
  const out = await Promise.all([startIn(req, q.quoteId), startIn(req, q.quoteId)]);
  assert.equal(out.filter((o) => o.ok).length, 1);
});

test('KADE_TASK_ATOMIC_START=0 puts the old read-then-mark back; the yes rules stay', async () => {
  process.env.KADE_TASK_ATOMIC_START = '0';
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  assert.match((await startIn(turn('adult', 'ok, read this page for me'), q.quoteId)).error, /not a plain yes/);
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
  assert.equal(colls.kadetaskstarts, undefined, 'no lock row is written');
  assert.match((await startIn(turn('adult', 'yes'), q.quoteId)).error, /already started/);
});

test('the tool passes every refusal on plainly, and a start says started only when it did', async () => {
  const restore = stubModules({
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '~/server/services/kadeTasks': tasks,
  });
  try {
    const KadeTask = require('../../app/clients/tools/structured/KadeTask');
    const tool = (req) => new KadeTask({ req, agentId: AGENT, agentName: 'Testa' });
    const first = turn('adult', 'can you find me a cheap chest freezer');
    const quoted = JSON.parse(await tool(first)._call({ action: 'quote', goal: GOAL, steps: 8 }));
    assert.ok(quoted.quoteId);
    const sameTurn = await tool(first)._call({ action: 'start', quoteId: quoted.quoteId });
    assert.match(sameTurn, /^Not started: /);
    assert.match(sameTurn, /do not pretend it is running/);
    const noYes = await tool(turn('adult', 'ok, read this page for me'))._call({ action: 'start', quoteId: quoted.quoteId });
    assert.match(noYes, /^Not started: their last message is not a plain yes/);
    const started = JSON.parse(await tool(turn('adult', 'yes please'))._call({ action: 'start', quoteId: quoted.quoteId }));
    assert.equal(started.started, true);
    const kid = await tool(turn('kid', 'yes'))._call({ action: 'start', quoteId: 'q1' });
    assert.doesNotMatch(kid, /Not started|rule\b.*child/i);
    assert.match(kid, /work on it together/);
  } finally {
    restore();
  }
});
