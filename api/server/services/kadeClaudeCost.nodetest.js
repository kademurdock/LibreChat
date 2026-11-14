/* Nov 14 2026: what a character's own message really cost when Claude wrote it
 * (services/kadeClaudeCost.js). The gateway bills a Claude turn at the MiMo price and puts the real
 * numbers in usage.kade_claude; these tests prove what is read from that note, what is added up, and
 * that a MiMo turn, a missing conversation or the off switch writes nothing. No database, no network.
 *
 * Run: node --test api/server/services/kadeClaudeCost.nodetest.js
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { FakeCollection } = require('../../test/kadeFakeMongo.cjs');
const cost = require('./kadeClaudeCost');

const approx = (got, want, msg) =>
  assert.ok(Math.abs(got - want) < 1e-9, `${msg || ''} got ${got}, want ${want}`);
/* The model message as the agents library hands it to the ModelEndHandler: the raw usage is kept in
 * response_metadata.usage (checked against @librechat/agents 3.2.46). */
const said = (realCost, billed, extra = {}) => ({
  usage_metadata: { input_tokens: 1000, output_tokens: 40, total_tokens: 1040 },
  response_metadata: {
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 40,
      cost: billed,
      kade_claude: { real_cost: realCost, is_byok: true, ...extra },
    },
  },
});

afterEach(() => {
  cost._seam.coll = null;
  cost._seam.logger = null;
  cost._seam.indexed = false;
});

test('costOf: only a call carrying the gateway note counts', () => {
  assert.deepEqual(cost.costOf(said(0.2134, 0.00047)), { real: 0.2134, billed: 0.00047 });
  assert.equal(
    cost.costOf({ response_metadata: { usage: { cost: 0.0011 } } }),
    null,
    'MiMo answered: no note',
  );
  assert.equal(cost.costOf({ usage_metadata: { input_tokens: 5 } }), null, 'no raw usage at all');
  assert.equal(cost.costOf(undefined), null);
  assert.equal(cost.costOf(null), null);
  assert.equal(cost.costOf({ response_metadata: { usage: { kade_claude: 'yes' } } }), null);
  assert.equal(cost.costOf(said(null, 0.001)), null, 'a note with no real cost');
  assert.equal(cost.costOf(said(-0.2, 0.001)), null);
  assert.equal(cost.costOf(said('0.2', 0.001)), null, 'a number only');
  assert.deepEqual(
    cost.costOf(said(0.1, undefined)),
    { real: 0.1, billed: 0 },
    'no billed cost: the whole real cost is extra',
  );
  assert.deepEqual(cost.costOf(said(0, 0)), { real: 0, billed: 0 });
  const broken = {
    get response_metadata() {
      throw new Error('a getter that throws');
    },
  };
  assert.equal(cost.costOf(broken), null, 'never breaks the handler');
});

test('extraUsd: what Claude cost above the billed rows, over every call of a turn, never below zero', () => {
  const usage = [
    { input_tokens: 1, kade_claude_cost: { real: 0.2, billed: 0.01 } },
    { input_tokens: 1 },
    { input_tokens: 1, kade_claude_cost: { real: 0.05, billed: 0.002 } },
    { input_tokens: 1, kade_claude_cost: { real: 0.001, billed: 0.01 } },
    null,
  ];
  approx(cost.extraUsd(usage), 0.19 + 0.048);
  assert.equal(cost.claudeCalls(usage), 3);
  assert.equal(cost.extraUsd([]), 0);
  assert.equal(cost.extraUsd(null), 0);
  assert.equal(cost.extraUsd([{ kade_claude_cost: { real: 'x', billed: 0 } }]), 0);
  assert.equal(cost.claudeCalls(undefined), 0);
});

test('record: one row per conversation, added up, kept 30 days, ids and dollars only', async () => {
  const c = new FakeCollection();
  cost._seam.coll = () => c;
  const now = new Date('2026-11-14T12:00:00Z');
  approx(
    await cost.record({
      conversationId: 'tmp-1',
      collectedUsage: [{ kade_claude_cost: { real: 0.21, billed: 0.005 } }],
      now,
      env: {},
    }),
    0.205,
  );
  await cost.record({
    conversationId: 'tmp-1',
    collectedUsage: [{ input_tokens: 3 }, { kade_claude_cost: { real: 0.05, billed: 0.001 } }],
    now,
    env: {},
  });
  assert.equal(c.rows.length, 1);
  const row = c.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['_id', 'at', 'calls', 'expireAt', 'usd']);
  assert.equal(row._id, 'tmp-1');
  approx(row.usd, 0.254);
  assert.equal(row.calls, 2);
  assert.equal(row.expireAt.getTime(), now.getTime() + 30 * 86400000);
  approx(await cost.extraUsdFor('tmp-1'), 0.254);
  assert.equal(await cost.extraUsdFor('nobody'), 0);
  assert.equal(await cost.extraUsdFor(''), 0);
});

test('record writes nothing for a MiMo turn, a missing conversation, or with the switch off', async () => {
  const c = new FakeCollection();
  cost._seam.coll = () => c;
  const claude = [{ kade_claude_cost: { real: 0.2, billed: 0 } }];
  assert.equal(
    await cost.record({ conversationId: 'tmp-2', collectedUsage: [{ input_tokens: 5 }], env: {} }),
    0,
  );
  assert.equal(
    await cost.record({
      conversationId: 'tmp-3',
      collectedUsage: [{ kade_claude_cost: { real: 0.001, billed: 0.002 } }],
      env: {},
    }),
    0,
  );
  assert.equal(await cost.record({ conversationId: '', collectedUsage: claude, env: {} }), 0);
  assert.equal(
    await cost.record({
      conversationId: 'tmp-4',
      collectedUsage: claude,
      env: { KADE_CLAUDE_COST_RECORD: '0' },
    }),
    0,
  );
  assert.equal(
    await cost.record({ conversationId: 'tmp-5', collectedUsage: undefined, env: {} }),
    0,
  );
  assert.equal(c.rows.length, 0);
  assert.equal(cost.recording({}), true, 'on unless switched off');
  assert.equal(cost.recording({ KADE_CLAUDE_COST_RECORD: ' 0 ' }), false);
});

test('record never throws: a database that is down loses the row, never the turn, and says so', async () => {
  const said = [];
  cost._seam.logger = { warn: (m) => said.push(m) };
  cost._seam.coll = () => {
    throw new Error('database down');
  };
  assert.equal(
    await cost.record({
      conversationId: 'tmp-6',
      collectedUsage: [{ kade_claude_cost: { real: 0.2, billed: 0 } }],
      env: {},
    }),
    0,
  );
  assert.equal(said.length, 1);
  assert.match(said[0], /^\[kadeClaudeCost\] Claude cost not recorded for tmp-6 \(\$0\.2000\): database down$/);
});

test('recordForTurn: only a hidden run\'s message turn records; a person\'s chat, a title and no request never do', async () => {
  const c = new FakeCollection();
  cost._seam.coll = () => c;
  const usage = [{ kade_claude_cost: { real: 0.2, billed: 0.01 } }];
  const go = (req, context) => cost.recordForTurn({ req, context, conversationId: 'tmp-g', collectedUsage: usage, env: {} });
  assert.equal(await go({ kadeHiddenRun: false }, 'message'), 0, 'a person\'s own chat');
  assert.equal(await go({}, 'message'), 0);
  assert.equal(await go({ kadeHiddenRun: true }, 'title'), 0);
  assert.equal(await go(undefined, 'message'), 0);
  assert.equal(c.rows.length, 0);
  approx(await go({ kadeHiddenRun: true }, 'message'), 0.19);
  assert.equal(c.rows.length, 1);
});

test('the 30-day clean-up index is made once, and tried again after a failure', async () => {
  const c = new FakeCollection();
  const made = [];
  let fail = true;
  c.createIndex = async (keys, opts) => {
    made.push([keys, opts]);
    if (fail) throw new Error('not yet');
  };
  cost._seam.coll = () => c;
  const usage = [{ kade_claude_cost: { real: 0.2, billed: 0 } }];
  await cost.record({ conversationId: 'i1', collectedUsage: usage, env: {} });
  fail = false;
  await cost.record({ conversationId: 'i2', collectedUsage: usage, env: {} });
  await cost.record({ conversationId: 'i3', collectedUsage: usage, env: {} });
  assert.equal(made.length, 2, 'failed once, made once, then left alone');
  assert.deepEqual(made[1], [{ expireAt: 1 }, { expireAfterSeconds: 0 }]);
  assert.equal(c.rows.length, 3, 'a failed index never stops a row');
});
