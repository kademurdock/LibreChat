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
const spend = require('./kadeSpendGate');
/* The end of a reply: the character's own words go by, and the prices of that turn are stamped. */
const replied = (req, replyText = 'That job usually costs about 12 cents, 40 cents at the very most. Want me to start it?') =>
  spend.afterReply({ req, replyText, agentName: 'Testa' });
/* A quote whose reply said the price, as the tool tells the character to. `say: false` leaves it unsaid. */
const quoteIn = async (req, { say = true } = {}) => {
  const q = await tasks.quote({ req, agentId: AGENT, goal: GOAL, steps: 8 });
  assert.equal(q.ok, true);
  if (say) await replied(req);
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
  delete process.env.KADE_SPEND_PRICE_HEARD;
  delete process.env.KADE_SPEND_NO_REPLAY;
  spend._resetForTests();
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
  /* two prices worked out, and said, in the one reply */
  const asked = turn('adult', 'can you find me a cheap chest freezer and a second job please');
  const q1 = await quoteIn(asked, { say: false });
  const q2 = await quoteIn(asked);
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
  const asked = turn('adult', 'can you find me a cheap chest freezer and a second job please');
  const qa = await quoteIn(asked, { say: false });
  const qb = await quoteIn(asked);
  const two = await Promise.all([startIn(turn('adult', 'yes'), qa.quoteId), startIn(turn('adult', 'yes'), qb.quoteId)]);
  assert.equal(two.filter((o) => o.ok).length, 1);
  await settle();
  assert.equal(running(), 1);
  assert.equal(runs.length, 1);
});

test('one task at a time and the daily cap still hold, and leave the quote unused', async () => {
  /* two prices worked out, and said, in the one reply */
  const asked = turn('adult', 'can you find me a cheap chest freezer and a second job please');
  const q1 = await quoteIn(asked, { say: false });
  const q2 = await quoteIn(asked);
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
    await replied(first);
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

/* ------------------------------------------------------------------------------------------
 * Review fixes, Nov 10 2026: the price must have been SAID, the yes must answer it, and a
 * retried reply is not a yes.
 * ---------------------------------------------------------------------------------------- */

test('review: a price worked out but never said cannot be started by a later yes', async () => {
  /* a page in the turn told the model to quote quietly; the reply was a summary with no price */
  const first = turn('adult', 'read this page for me');
  const q = await quoteIn(first, { say: false });
  await replied(first, 'Here is the summary of that page. Want me to keep going?');
  assert.equal(colls.kadetaskquotes.rows[0].heard, false);
  const s = await startIn(turn('adult', 'yes please'), q.quoteId);
  assert.equal(s.ok, false);
  assert.match(s.error, /never said to them/);
  assert.equal(running(), 0);
  /* and a reply that never ended at all (no stamp) is the same */
  colls = {};
  const q2 = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'), { say: false });
  assert.match((await startIn(turn('adult', 'yes'), q2.quoteId)).error, /never said to them/);
  assert.equal(running(), 0);
});

test('review: the price may be said in digits, in words or with a dollar sign; a tool result is never the reply', async () => {
  for (const words of ['That would be about 12 cents.', 'It runs twelve cents or so, okay?', 'Call it $0.12 at most.', 'Under a cent, honestly.', 'A couple of bucks at the very most.']) {
    colls = {};
    spend._resetForTests();
    const first = turn('adult', 'can you find me a cheap chest freezer');
    const q = await quoteIn(first, { say: false });
    await replied(first, words);
    assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true, words);
  }
});

test('review: a message that is not a yes closes the price, so a later "sure" to something else buys nothing', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  /* they said no thanks; the reply to that ends */
  const no = turn('adult', 'no thanks, maybe another day');
  await replied(no, 'No problem. Want to hear a joke instead?');
  assert.equal(colls.kadetaskquotes.rows[0].lapsed, true);
  const s = await startIn(turn('adult', 'sure'), q.quoteId);
  assert.equal(s.ok, false);
  assert.match(s.error, /has closed/);
  assert.equal(running(), 0);
});

test('review: a yes the server could not act on leaves the price open for the next yes', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const yes = turn('adult', 'yes');
  await replied(yes, 'The site is restarting, ask me again in a few minutes.');
  assert.equal(colls.kadetaskquotes.rows[0].usedAt, undefined);
  assert.equal((await startIn(turn('adult', 'Yes, go ahead'), q.quoteId)).ok, true);
});

test('review: another conversation saying something else does not close this one\'s price', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  await replied(turn('adult', 'what is the weather', { conversationId: 'c-2' }), 'Sunny.');
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
});

test('review: a regenerated, continued or edited reply cannot approve a price', async () => {
  for (const flag of [{ isRegenerate: true }, { isContinued: true }, { editedContent: { index: 0, text: 'x' } }]) {
    colls = {};
    spend._resetForTests();
    const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
    const s = await startIn(turn('adult', 'yes', flag), q.quoteId);
    assert.equal(s.ok, false, JSON.stringify(flag));
    assert.match(s.error, /retry of an earlier one/);
    /* the retried reply ending does not close the price; a fresh yes still starts it */
    await replied(turn('adult', 'yes', flag), 'That job is about 12 cents. Want it?');
    assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true, JSON.stringify(flag));
  }
});

test('review: the two new off switches put the first cut back', async () => {
  process.env.KADE_SPEND_PRICE_HEARD = '0';
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'), { say: false });
  await replied(turn('adult', 'no thanks'), 'Okay.');
  assert.equal(colls.kadetaskquotes.rows[0].usedAt, undefined, 'nothing is stamped or closed');
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
  delete process.env.KADE_SPEND_PRICE_HEARD;
  colls = {};
  process.env.KADE_SPEND_NO_REPLAY = '0';
  const q2 = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  assert.equal((await startIn(turn('adult', 'yes', { isRegenerate: true }), q2.quoteId)).ok, true);
});

test('review: a background run ending stamps and closes nothing', async () => {
  const q = await quoteIn(turn('adult', 'can you find me a cheap chest freezer'));
  const hidden = { ...turn('adult', 'do the job now'), kadeHiddenRun: true };
  assert.equal(await spend.afterReply({ req: hidden, replyText: 'Working.' }), null);
  assert.equal((await startIn(turn('adult', 'yes'), q.quoteId)).ok, true);
});
