/* Part 291, her words: "Yes, I do want double on voice." With KADE_VOICE_BILL_REAL=1 a voice or
 * phone chat turn is billed from its real transaction, to the real caller, at the platform factor:
 *   - kadeOnBehalfOf sets req.kadeBillTo for a non-admin caller (its own nodetest covers who);
 *   - client.js records the turn's usage to kadeBillTo, tags it context 'voice', keeps the balance on;
 *   - /usage-event writes the bridge's voice_chat estimate at $0 (nobody pays twice);
 *   - the funding page keeps voice on its own line.
 * No database and no '~' requires: client.js and kade.js are read as source and the pieces run in vm.
 *
 * Run: node --test api/server/services/kadeVoiceBill.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('./kadeRealCost');
const F = require('./kadeFunding');

const ON = { KADE_VOICE_BILL_REAL: '1' };
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

/* ---- /usage-event ------------------------------------------------------------------------ */

test('switch off: /usage-event writes every cost exactly as the bridge sent it', () => {
  for (const env of [{}, { KADE_VOICE_BILL_REAL: '0' }, { KADE_VOICE_BILL_REAL: 'yes' }]) {
    assert.deepEqual(R.voiceUsageEvent({ service: 'voice_chat', costUSD: 0.012, metadata: { tokens: 9 } }, env), {
      costUSD: 0.012,
      metadata: { tokens: 9 },
    });
  }
  assert.deepEqual(R.voiceUsageEvent({ service: 'voice_chat', costUSD: '0.5' }, {}), {
    costUSD: undefined,
    metadata: undefined,
  });
});

test('switch on: a call that went through the fork (viaFork) costs 0, keeps the row and the estimate for counts', () => {
  const meta = { tokens: 9, callSid: 'CA1', viaFork: true };
  const out = R.voiceUsageEvent({ service: 'voice_chat', costUSD: 0.012, metadata: meta }, ON);
  assert.equal(out.costUSD, 0);
  assert.deepEqual(out.metadata, { ...meta, billedBy: 'transactions', bridgeEstimateUSD: 0.012 });
  const bare = R.voiceUsageEvent({ service: 'voice_chat', metadata: { viaFork: true } }, ON);
  assert.equal(bare.costUSD, 0);
  assert.deepEqual(bare.metadata, { viaFork: true, billedBy: 'transactions' });
});

test('switch on: every other voice_chat estimate keeps its cost (F40: outbound calls, old bridges)', () => {
  for (const metadata of [
    undefined,
    { tokens: 9 },
    { tokens: 9, viaFork: false },
    { tokens: 9, viaFork: 'true' },
    { tokens: 9, viaFork: 1 },
    ['viaFork'],
  ]) {
    assert.deepEqual(
      R.voiceUsageEvent({ service: 'voice_chat', costUSD: 0.012, metadata }, ON),
      { costUSD: 0.012, metadata },
      JSON.stringify(metadata),
    );
  }
  // Switch off: even a viaFork estimate is charged as sent.
  assert.deepEqual(R.voiceUsageEvent({ service: 'voice_chat', costUSD: 0.012, metadata: { viaFork: true } }, {}), {
    costUSD: 0.012,
    metadata: { viaFork: true },
  });
});

test('switch on: phone minutes, pictures and everything else are still charged as sent', () => {
  for (const service of ['phone', 'fal_video', 'tts', 'web_voice', 'describe']) {
    assert.deepEqual(R.voiceUsageEvent({ service, costUSD: 0.14, metadata: { a: 1 } }, ON), {
      costUSD: 0.14,
      metadata: { a: 1 },
    });
  }
});

test('the /usage-event route really writes through voiceUsageEvent', () => {
  const kade = read('../routes/kade.js');
  const route = kade.slice(kade.indexOf("router.post('/usage-event'"), kade.indexOf("router.post('/asset-event'"));
  assert.match(route, /const priced = voiceUsageEvent\(\{ service, costUSD, metadata \}\);/);
  assert.match(route, /costUSD: priced\.costUSD,/);
  assert.match(route, /metadata: priced\.metadata,/);
  assert.doesNotMatch(route, /costUSD: typeof costUSD === 'number' \? costUSD : undefined/);
});

/* ---- client.js ----------------------------------------------------------------------------- */

/** AgentClient's kadeUsageUser + recordCollectedUsage, run against a stubbed recorder. */
function loadRecorder() {
  const src = read('../controllers/agents/client.js');
  const start = src.indexOf('  kadeUsageUser() {');
  const end = src.indexOf('  /**', src.indexOf('  async recordCollectedUsage({'));
  assert.ok(start > 0 && end > start, 'client.js still has kadeUsageUser and recordCollectedUsage');
  const calls = [];
  const deps = [];
  const wallets = [];
  const db = { updateBalance: async () => 'clamped', bulkInsertTransactions: async () => {} };
  const context = {
    recordCollectedUsage: async (d, args) => {
      calls.push(args);
      deps.push(d);
      return { input_tokens: 1, output_tokens: 1 };
    },
    db,
    require: (name) => {
      assert.equal(name, '~/server/services/kadeRealCost');
      return {
        voiceWalletUpdate: (opts) => {
          wallets.push(opts);
          return R.voiceWalletUpdate(opts);
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(`this.Recorder = class Recorder {\n${src.slice(start, end)}\n};`, context);
  const make = (req, user = req.user && req.user.id) => {
    const c = new context.Recorder();
    c.options = { req, agent: { model_parameters: { model: 'deepseek/deepseek-v4.1-flash' } } };
    c.user = user;
    c.conversationId = 'convo';
    c.collectedUsage = [{ input_tokens: 10, output_tokens: 2 }];
    c.responseMessageId = 'msg';
    return c;
  };
  return { make, calls, deps, wallets, db };
}

const KADE_SEAT = { id: 'kade', role: 'ADMIN' };

test("a billed voice turn records to the caller, tagged 'voice'", async () => {
  const { make, calls } = loadRecorder();
  const c = make({ user: KADE_SEAT, kadeBillTo: 'amber', kadeOnBehalfOf: { id: 'amber' } });
  assert.equal(c.kadeUsageUser(), 'amber');
  await c.recordCollectedUsage({ balance: { enabled: true }, context: 'message' });
  assert.equal(calls[0].user, 'amber');
  assert.equal(calls[0].context, 'voice');
  assert.deepEqual({ ...calls[0].balance }, { enabled: true });
});

test("Kade's own call, unknown emails and unlinked callers stay on her seat as 'message'", async () => {
  const { make, calls } = loadRecorder();
  // kadeOnBehalfOf without kadeBillTo: Kade herself, or the switch is off.
  await make({ user: KADE_SEAT, kadeOnBehalfOf: { id: 'kade' } }).recordCollectedUsage({ context: 'message' });
  await make({ user: KADE_SEAT, kadeOnBehalfOfUnresolved: true }).recordCollectedUsage({ context: 'message' });
  await make({ user: KADE_SEAT }).recordCollectedUsage({ context: 'message' });
  assert.deepEqual(
    calls.map((a) => [a.user, a.context]),
    [
      ['kade', 'message'],
      ['kade', 'message'],
      ['kade', 'message'],
    ],
  );
});

test('an ordinary chat turn is untouched, and only message rows become voice rows', async () => {
  const { make, calls } = loadRecorder();
  await make({ user: { id: 'holly', role: 'USER' } }).recordCollectedUsage({ context: 'message' });
  await make({ user: KADE_SEAT, kadeBillTo: 'amber' }).recordCollectedUsage({ context: 'title' });
  assert.deepEqual([calls[0].user, calls[0].context], ['holly', 'message']);
  assert.deepEqual([calls[1].user, calls[1].context], ['amber', 'title']);
});

/** chatCompletion's balance line, evaluated for a request. */
function balanceFor(req) {
  const src = read('../controllers/agents/client.js');
  const body = src.slice(src.indexOf('  async chatCompletion({'));
  const line = body
    .split('\n')
    .find((l) => l.includes("role === 'ADMIN'") && l.includes('balanceConfig = { ...balanceConfig, enabled: false }'));
  assert.ok(line, 'chatCompletion still decides the admin balance');
  const context = { balanceConfig: { enabled: true, startBalance: 0 }, self: { options: { req } } };
  vm.createContext(context);
  vm.runInContext(`(function () { ${line.trim().replace(/this\./g, 'self.')} }).call(null);`, context);
  return context.balanceConfig.enabled;
}

test("the caller's wallet is drawn on a billed voice turn; Kade's seat never is", () => {
  assert.equal(balanceFor({ user: KADE_SEAT, kadeBillTo: 'amber' }), true);
  assert.equal(balanceFor({ user: KADE_SEAT }), false);
  assert.equal(balanceFor({ user: KADE_SEAT, kadeOnBehalfOf: { id: 'kade' } }), false);
  assert.equal(balanceFor({ user: { id: 'holly', role: 'USER' } }), true);
});

test('a call is never cut mid-turn: the pre-turn balance check still skips the service seat', () => {
  const base = read('../../app/clients/BaseClient.js');
  assert.match(base, /const isKadeAdmin = this\.options\?\.req\?\.user\?\.role === 'ADMIN';/);
  assert.match(base, /!isKadeAdmin &&\s+balanceConfig\?\.enabled/);
});

/* ---- funding page ------------------------------------------------------------------------ */

const ROWS = { 'deepseek/deepseek-v4.1-flash': { prompt: 0.3, completion: 1.2 } };
const fakeDb = (x) => ({
  getValueKey: (m) => (ROWS[m] ? m : undefined),
  getMultiplier: ({ model, tokenType }) => (ROWS[model] ? ROWS[model][tokenType] : 6) * x,
  getCacheMultiplier: () => null,
});
const group = (tokens, perM, extra = {}) => ({
  _id: { model: 'deepseek/deepseek-v4.1-flash', tokenType: 'completion', structured: false, afterSwitch: true, ...extra },
  raw: tokens,
  input: 0,
  write: 0,
  read: 0,
  charged: -tokens * perM,
  rows: 1,
});
const AMBER = { _id: '6a0000000000000000000001', name: 'Amber A', role: 'USER' };

test("voice turns keep their own line, at real cost, and the label drops '(estimated)' when billed for real", () => {
  const s = F.compose({
    user: AMBER,
    txGroups: [group(1e6, 2.4), group(1e5, 2.4, { voice: true })],
    usageRows: [{ _id: 'voice_chat', costUSD: 0, quantity: 9000 }],
    price: R.createPricer(fakeDb(2), 2),
    factor: 2,
    voiceReal: true,
  });
  const voice = s.breakdown.find((f) => f.feature === 'voice');
  const chat = s.breakdown.find((f) => f.feature === 'chat');
  assert.equal(chat.realUSD, 1.2);
  assert.equal(chat.chargedUSD, 2.4);
  assert.equal(voice.realUSD, 0.12);
  assert.equal(voice.chargedUSD, 0.24, 'charged at 2x real');
  assert.equal(voice.label, 'Voice and phone conversations');
  assert.equal(voice.estimated, undefined, 'a $0 bridge row is a count, not an estimate');
  assert.equal(s.voiceBilledReal, true);
});

test("switch off: the voice line is the bridge estimate, still labelled '(estimated)'", () => {
  const s = F.compose({
    user: AMBER,
    usageRows: [{ _id: 'voice_chat', costUSD: 0.2, quantity: 9000 }],
    price: R.createPricer(fakeDb(2), 2),
    factor: 2,
  });
  const voice = s.breakdown.find((f) => f.feature === 'voice');
  assert.equal(voice.label, 'Voice and phone conversations (estimated)');
  assert.equal(voice.estimated, true);
  assert.equal(F.featureLabel('voice', false), 'Voice and phone conversations (estimated)');
  assert.equal(F.featureLabel('voice', true), 'Voice and phone conversations');
  assert.equal(F.featureLabel('chat', true), F.FEATURES.chat);
});

test("Kade's own note says whose voice turns are on her seat", () => {
  const kade = { _id: '6a0000000000000000000009', name: 'Kade', role: 'ADMIN' };
  const price = R.createPricer(fakeDb(2), 2);
  const off = F.compose({ user: kade, price, factor: 2 });
  const on = F.compose({ user: kade, price, factor: 2, voiceReal: true });
  assert.match(F.forModel(off).note, /includes voice and phone turns, which run on her seat/);
  assert.match(F.forModel(on).note, /her own voice calls, outbound calls and calls from people with no linked account/);
});

test('the funding queries group by the voice tag, and read the switch from the environment', async () => {
  const stages = [];
  const agg = (rows) => ({
    aggregate: async (pipeline) => {
      stages.push(pipeline);
      return rows;
    },
  });
  const lean = (v) => ({ lean: async () => v });
  const deps = {
    db: fakeDb(2),
    env: { KADE_BILLING_MULTIPLIER: '2', KADE_VOICE_BILL_REAL: '1' },
    Transaction: agg([group(1e5, 2.4, { voice: true })]),
    KadeUsage: agg([]),
    Ledger: agg([]),
    User: { findById: () => lean(AMBER), find: () => lean([AMBER]) },
    Balance: { findOne: () => lean(null), find: () => lean([]) },
  };
  const s = await F.fundingSummary(AMBER._id, {}, deps);
  assert.equal(s.breakdown[0].feature, 'voice');
  assert.equal(s.breakdown[0].label, 'Voice and phone conversations');
  const txGroup = stages[0].find((st) => st.$group).$group;
  assert.deepEqual(txGroup._id.voice, { $eq: ['$context', 'voice'] });
  stages.length = 0;
  deps.Transaction = agg([{ ...group(1e5, 2.4, { voice: true }), _id: { ...group(1e5, 2.4, { voice: true })._id, user: AMBER._id } }]);
  const people = await F.fundingPeople({}, deps);
  assert.equal(people[0].breakdown[0].feature, 'voice');
  assert.deepEqual(stages[0].find((st) => st.$group).$group._id.voice, { $eq: ['$context', 'voice'] });
});

/* ---- review fixes: the caller's wallet (F10, F13) ------------------------------------------ */

/** An in-memory Balance model with the three calls voiceWalletUpdate makes. */
function fakeBalance(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, { user: k, ...v }]));
  const copy = (d) => (d ? { ...d } : null);
  const calls = [];
  return {
    docs,
    calls,
    findOne: (q) => ({ lean: async () => copy(docs.get(String(q.user))) }),
    updateOne: async (q, update, opts = {}) => {
      calls.push(['updateOne', q, update, opts]);
      const k = String(q.user);
      const d = docs.get(k);
      if (update.$setOnInsert) {
        if (!d && opts.upsert) docs.set(k, { user: k, ...update.$setOnInsert });
        return;
      }
      if (update.$set && d && q.tokenCredits === null && d.tokenCredits == null) Object.assign(d, update.$set);
    },
    findOneAndUpdate: (q, update, opts = {}) => ({
      lean: async () => {
        calls.push(['findOneAndUpdate', q, update, opts]);
        const k = String(q.user);
        let d = docs.get(k);
        if (!d && opts.upsert) {
          d = { user: k, tokenCredits: 0 };
          docs.set(k, d);
        }
        if (d && update.$inc) d.tokenCredits = (d.tokenCredits || 0) + update.$inc.tokenCredits;
        return copy(d);
      },
    }),
  };
}
const START = { enabled: true, startBalance: 10e6 };

test('F10: a voice turn never forgives a negative wallet (starts at -400000, ends lower)', async () => {
  const Balance = fakeBalance({ amber: { tokenCredits: -400000 } });
  const write = R.voiceWalletUpdate({ balanceConfig: START, Balance });
  const out = await write({ user: 'amber', incrementValue: -20000 });
  assert.equal(out.tokenCredits, -420000);
  assert.ok(Balance.docs.get('amber').tokenCredits <= -400000);
  // The spend is an $inc (no read-modify-write clamp), and an existing record is never re-seeded.
  assert.deepEqual(
    Balance.calls.map((c) => [c[0], c[2]]),
    [['findOneAndUpdate', { $inc: { tokenCredits: -20000 } }]],
  );
  // A positive wallet goes down by exactly the spend, and may go below zero like deductKadeCredits.
  const pos = fakeBalance({ holly: { tokenCredits: 5000 } });
  const w2 = R.voiceWalletUpdate({ balanceConfig: START, Balance: pos });
  assert.equal((await w2({ user: 'holly', incrementValue: -8000 })).tokenCredits, -3000);
});

test('F13: a first voice call seeds the normal start balance before the spend, never a $0 record', async () => {
  const Balance = fakeBalance();
  const write = R.voiceWalletUpdate({ balanceConfig: START, Balance });
  const out = await write({ user: 'newbie', incrementValue: -20000 });
  assert.equal(out.tokenCredits, 10e6 - 20000);
  const seed = Balance.calls[0];
  assert.equal(seed[0], 'updateOne');
  assert.deepEqual(seed[2], { $setOnInsert: { tokenCredits: 10e6 } }, 'the seed only ever inserts');
  assert.equal(seed[3].upsert, true);
  // A record with no credits yet (null) is filled with the start balance, then charged.
  const nul = fakeBalance({ old: { tokenCredits: null } });
  const w2 = R.voiceWalletUpdate({ balanceConfig: START, Balance: nul });
  assert.equal((await w2({ user: 'old', incrementValue: -1 })).tokenCredits, 10e6 - 1);
  // With auto-refill configured, the seed carries the same refill fields the pre-turn check writes.
  const cfg = { ...START, autoRefillEnabled: true, refillIntervalValue: 30, refillIntervalUnit: 'days', refillAmount: 5e6 };
  const f = R.startBalanceFields(cfg);
  assert.deepEqual(
    { ...f, lastRefill: f.lastRefill instanceof Date },
    { tokenCredits: 10e6, autoRefillEnabled: true, refillIntervalValue: 30, refillIntervalUnit: 'days', refillAmount: 5e6, lastRefill: true },
  );
  // No start balance configured: nothing to seed; the debt is still recorded, not clamped.
  const none = fakeBalance();
  const w3 = R.voiceWalletUpdate({ balanceConfig: { enabled: true }, Balance: none });
  assert.equal((await w3({ user: 'x', incrementValue: -500 })).tokenCredits, -500);
  assert.equal(none.calls.filter((c) => c[0] === 'updateOne').length, 0);
});

test('client.js: a billed voice turn is written through the caller wallet writer; other turns keep updateBalance', async () => {
  const { make, deps, wallets, db } = loadRecorder();
  const balance = { enabled: true, startBalance: 10e6 };
  await make({ user: KADE_SEAT, kadeBillTo: 'amber' }).recordCollectedUsage({ balance, context: 'message' });
  assert.notEqual(deps[0].bulkWriteOps.updateBalance, db.updateBalance);
  assert.equal(deps[0].bulkWriteOps.insertMany, db.bulkInsertTransactions);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].balanceConfig, balance, 'seeds from the same balance config the turn uses');
  await make({ user: KADE_SEAT }).recordCollectedUsage({ balance, context: 'message' });
  await make({ user: { id: 'holly', role: 'USER' } }).recordCollectedUsage({ balance, context: 'message' });
  assert.equal(deps[1].bulkWriteOps.updateBalance, db.updateBalance);
  assert.equal(deps[2].bulkWriteOps.updateBalance, db.updateBalance);
  assert.equal(wallets.length, 1);
});

test('client.js: the estimated-usage fallback of a billed voice turn uses the same wallet writer', async () => {
  const src = read('../controllers/agents/client.js');
  const grab = (a, b) => {
    const i = src.indexOf(a);
    const j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, a);
    return src.slice(i, j);
  };
  const methods =
    grab('  kadeUsageUser() {', '  /**\r\n   * @param {Object} params') +
    grab('  async recordTokenUsage({', '  /** Anthropic Claude models');
  const writes = [];
  const spent = [];
  const db = {
    updateBalance: async () => 'clamped',
    bulkInsertTransactions: async () => {},
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
    spendTokens: async (tx, usage) => spent.push([tx, usage]),
  };
  const context = {
    db,
    logger: { error() {} },
    prepareTokenSpend: (tx, usage) => {
      const out = [];
      if (usage.promptTokens !== undefined) out.push({ tokenType: 'prompt', context: tx.context, user: tx.user });
      if (usage.completionTokens !== undefined) out.push({ tokenType: 'completion', context: tx.context, user: tx.user });
      return out;
    },
    bulkWriteTransactions: async (args, ops) => writes.push([args, ops]),
    require: () => ({ voiceWalletUpdate: () => 'caller-wallet' }),
  };
  vm.createContext(context);
  vm.runInContext(`this.C = class C {\n${methods}\n};`, context);
  const make = (req) => {
    const c = new context.C();
    c.options = { req };
    c.user = req.user.id;
    c.conversationId = 'convo';
    c.responseMessageId = 'msg';
    return c;
  };
  const balance = { enabled: true };
  await make({ user: KADE_SEAT, kadeBillTo: 'amber' }).recordTokenUsage({
    model: 'm',
    balance,
    promptTokens: 10,
    completionTokens: 2,
    usage: { reasoning_tokens: 5 },
  });
  assert.equal(spent.length, 0, 'spendTokens (and its clamp) is not used');
  const [args, ops] = writes[0];
  assert.equal(args.user, 'amber');
  assert.deepEqual(
    args.docs.map((d) => [d.tokenType, d.context, d.user]),
    [
      ['prompt', 'voice', 'amber'],
      ['completion', 'voice', 'amber'],
      ['completion', 'reasoning', 'amber'],
    ],
  );
  assert.equal(ops.updateBalance, 'caller-wallet');
  // Kade's own turn keeps spendTokens exactly as before.
  await make({ user: KADE_SEAT }).recordTokenUsage({ model: 'm', balance, promptTokens: 10, completionTokens: 2 });
  assert.equal(writes.length, 1);
  assert.equal(spent[0][0].user, 'kade');
  assert.equal(spent[0][0].context, 'message');
});

/* ---- review fixes: the funding figures (F14, F40) ------------------------------------------ */

test("F14: Kade's own figure leaves out her voice_chat estimates (her seat's chat rows already hold them)", () => {
  const kade = { _id: '6a0000000000000000000009', name: 'Kade', role: 'ADMIN' };
  const price = R.createPricer(fakeDb(2), 2);
  const s = F.compose({
    user: kade,
    txGroups: [group(1e6, 2.4)],
    usageRows: [
      { _id: 'voice_chat', costUSD: 0.5 },
      { _id: 'phone', costUSD: 0.1 },
    ],
    price,
    factor: 2,
  });
  assert.equal(s.realCostUSD, 1.3, 'chat 1.20 + phone 0.10, no voice estimate');
  assert.equal(s.breakdown.find((f) => f.feature === 'voice'), undefined);
  // Everyone else keeps their estimate: it is their only record of what their calls cost.
  const amber = F.compose({ user: AMBER, usageRows: [{ _id: 'voice_chat', costUSD: 0.5 }], price, factor: 2 });
  assert.equal(amber.realCostUSD, 0.5);
});

test('F40: with the switch on, a voice line that mixes real turns and an outbound estimate says so', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const mixed = F.compose({
    user: AMBER,
    txGroups: [group(1e5, 2.4, { voice: true })],
    usageRows: [{ _id: 'voice_chat', costUSD: 0.03 }],
    price,
    factor: 2,
    voiceReal: true,
  });
  const v = mixed.breakdown.find((f) => f.feature === 'voice');
  assert.equal(v.label, 'Voice and phone conversations (partly estimated)');
  assert.equal(v.realUSD, 0.15);
  assert.equal(F.forModel(mixed).breakdown.find((b) => b.what === v.label).estimated, true);
  const estOnly = F.compose({ user: AMBER, usageRows: [{ _id: 'voice_chat', costUSD: 0.03 }], price, factor: 2, voiceReal: true });
  assert.equal(estOnly.breakdown[0].label, 'Voice and phone conversations (estimated)');
});
