/* Part 291: what each person's use really cost Kade, and what they paid her back.
 * Run: node --test api/server/services/kadeFunding.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./kadeFunding');
const { createPricer } = require('./kadeRealCost');

const ROWS = {
  'deepseek/deepseek-v4.1-flash': { prompt: 0.15, completion: 0.6 },
  'z-ai/glm-5.3-flash': { prompt: 0.15, completion: 0.5 },
};
const fakeDb = (x) => ({
  getValueKey: (m) => (ROWS[m] ? m : undefined),
  getMultiplier: ({ model, tokenType }) => (ROWS[model] ? ROWS[model][tokenType] : 6) * x,
  getCacheMultiplier: () => null,
});
const group = (model, tokenType, tokens, perM, extra = {}) => ({
  _id: { model, tokenType, structured: false, afterSwitch: true, ...extra },
  raw: tokens,
  input: 0,
  write: 0,
  read: 0,
  charged: -tokens * perM,
  rows: 1,
});
const AMBER = { _id: '6a0000000000000000000001', name: 'Amber A', role: 'USER' };
const run = (extra) => F.compose({ user: AMBER, price: createPricer(fakeDb(2), 2), factor: 2, ...extra });

test('chat charged at 2x comes back at the real sticker', () => {
  const s = run({ txGroups: [group('deepseek/deepseek-v4.1-flash', 'prompt', 1e6, 0.3)] });
  assert.equal(s.chargedUSD, 0.3);
  assert.equal(s.realCostUSD, 0.15);
  assert.equal(s.breakdown[0].feature, 'chat');
});

test('rows billed on the wrong price row before Sep 5 are re-priced, not halved', () => {
  const s = run({ txGroups: [group('z-ai/glm-5.3-flash', 'prompt', 1e6, 1.4, { afterSwitch: false })] });
  assert.equal(s.chargedUSD, 1.4);
  assert.equal(s.realCostUSD, 0.15);
});

test('extras are real already: never divided, speech costs nothing', () => {
  const s = run({
    usageRows: [
      { _id: 'fal_video', costUSD: 0.63, quantity: 1 },
      { _id: 'tts', costUSD: 0, quantity: 50000 },
      { _id: 'phone', costUSD: 0.14, quantity: 10 },
      { _id: 'voice_chat', costUSD: 0.2, quantity: 9000 },
    ],
  });
  assert.equal(s.realCostUSD, 0.97);
  assert.equal(s.breakdown.find((f) => f.feature === 'video').realUSD, 0.63);
  assert.equal(s.breakdown.find((f) => f.feature === 'voice').estimated, true);
  assert.equal(s.breakdown.find((f) => f.feature === 'speech').realUSD, 0);
});

test('an unpriced model falls back to charged / factor and is named', () => {
  const s = run({ txGroups: [group('mystery/model-9', 'completion', 1e6, 12)] });
  assert.equal(s.realCostUSD, 6);
  assert.deepEqual(s.unpricedModels, ['mystery/model-9']);
  assert.match(F.forModel(s).note, /estimate/);
});

test('difference and plain words to the cent, both ways', () => {
  const ahead = run({ usageRows: [{ _id: 'fal_video', costUSD: 12.4 }], repaid: { usd: 30, entries: 1 } });
  assert.equal(ahead.differenceUSD, -17.6);
  assert.equal(ahead.status, 'ahead');
  assert.equal(
    F.spokenLine(ahead),
    "Your use has really cost Kade $12.40 so far. You've paid her back $30.00, so you're $17.60 ahead.",
  );
  const short = run({ usageRows: [{ _id: 'fal_video', costUSD: 42.4 }], repaid: { usd: 30, entries: 1 } });
  assert.equal(short.status, 'short');
  assert.equal(
    F.spokenLine(short),
    "Your use has really cost Kade $42.40 so far. You've paid her back $30.00, so the difference is $12.40.",
  );
  const none = run({ usageRows: [{ _id: 'fal_video', costUSD: 12.4 }] });
  assert.match(F.spokenLine(none), /You haven't paid her back anything yet, so the difference is \$12\.40\./);
  const even = run({ usageRows: [{ _id: 'fal_video', costUSD: 30 }], repaid: { usd: 30 } });
  assert.match(F.spokenLine(even), /all square/);
  assert.equal(F.spokenLine(run({})), "Your use hasn't cost Kade anything yet, so nothing is owed.");
});

test('Kade hears other people by name, and her own figures without anything owed', () => {
  const ahead = run({ usageRows: [{ _id: 'fal_video', costUSD: 12.4 }], repaid: { usd: 30 } });
  assert.equal(
    F.spokenLine(ahead, { self: false }),
    "Amber A's use has really cost you $12.40 so far. Amber A has paid you back $30.00, so Amber A is $17.60 ahead.",
  );
  const kade = F.compose({
    user: { _id: '6a0000000000000000000009', name: 'Kade', role: 'ADMIN' },
    txGroups: [group('deepseek/deepseek-v4.1-flash', 'completion', 1e6, 1.2)],
    price: createPricer(fakeDb(2), 2),
    factor: 2,
  });
  assert.equal(kade.admin, true);
  assert.equal(kade.chargedUSD, 0);
  assert.equal(F.spokenLine(kade), 'You pay the bills, so nothing is owed. Your own use has really cost $0.60 so far.');
  assert.match(F.forModel(kade).note, /voice and phone turns/);
});

test("a child's account hears its figures gently, with nothing about owing", () => {
  const child = F.compose({
    user: { _id: '6a0000000000000000000002', name: 'Skylee', role: 'USER', kadeAccountType: 'child' },
    usageRows: [{ _id: 'flux', costUSD: 2.5 }],
    price: createPricer(fakeDb(2), 2),
    factor: 2,
  });
  assert.equal(child.child, true);
  const line = F.spokenLine(child);
  assert.match(line, /\$2\.50/);
  assert.match(line, /nothing for you to worry about/);
  assert.doesNotMatch(line, /owe|difference|paid her back|short/i);
  assert.match(F.forModel(child).note, /never suggest they owe/);
  const gave = F.compose({
    user: { _id: '6a0000000000000000000002', name: 'Skylee', role: 'USER', kadeAccountType: 'child' },
    usageRows: [{ _id: 'flux', costUSD: 2.5 }],
    repaid: { usd: 5 },
    price: createPricer(fakeDb(2), 2),
    factor: 2,
  });
  assert.match(F.spokenLine(gave), /given her \$5\.00 toward it/);
});

test('this month is said as a date, and the model sees the period', () => {
  const s = run({ usageRows: [{ _id: 'phone', costUSD: 1 }], window: { from: new Date('2026-09-01T05:00:00Z') } });
  assert.match(F.spokenLine(s), /since September 1\./);
  assert.equal(F.forModel(s).period, 'this month');
  assert.equal(F.windowFor('this_month', {}, new Date('2026-09-25T12:00:00Z')).from.toISOString(), '2026-09-01T05:00:00.000Z');
  assert.deepEqual(F.windowFor('all_time'), { from: undefined, to: undefined });
});

test('only non-voided repayments count; chat asks for spend rows only', async () => {
  const seen = {};
  const agg = (n, rows) => ({ aggregate: async (p) => { seen[n] = p; return rows; } });
  const deps = {
    env: { KADE_BILLING_MULTIPLIER: '2' },
    db: fakeDb(2),
    User: { findById: () => ({ lean: async () => ({ ...AMBER }) }) },
    Transaction: agg('tx', [group('deepseek/deepseek-v4.1-flash', 'prompt', 1e6, 0.3)]),
    KadeUsage: agg('ku', [{ _id: 'fal_video', costUSD: 12.25 }]),
    Ledger: agg('ledger', [{ _id: null, usd: 30, entries: 1, last: new Date('2026-09-20T17:00:00Z') }]),
    Balance: { findOne: () => ({ lean: async () => ({ tokenCredits: 4.2e6 }) }) },
  };
  const window = { from: new Date('2026-09-01T05:00:00Z') };
  const s = await F.fundingSummary(AMBER._id, window, deps);
  assert.equal(seen.ledger[0].$match.kind, 'repayment');
  assert.equal(seen.ledger[0].$match.voidedAt, null);
  assert.deepEqual(seen.ledger[0].$match.at, { $gte: window.from });
  assert.deepEqual(seen.tx[0].$match.tokenType, { $in: ['prompt', 'completion'] });
  assert.deepEqual(seen.tx[0].$match.createdAt, { $gte: window.from });
  assert.deepEqual(seen.ku[0].$match.createdAt, { $gte: window.from });
  assert.equal(s.realCostUSD, 12.4);
  assert.equal(s.paidBackUSD, 30);
  assert.equal(s.differenceUSD, -17.6);
  assert.equal(s.walletBalanceUSD, 4.2);
  assert.equal(await F.fundingSummary('nope', {}, deps), null);
});

test('everyone: per-person figures, nobody with nothing, most covered first', async () => {
  const U = (id, name, role = 'USER') => ({ _id: `6a000000000000000000000${id}`, name, role });
  const users = [U(1, 'Amber A'), U(2, 'Holly'), U(3, 'Quiet'), U(9, 'Kade', 'ADMIN')];
  const deps = {
    env: { KADE_BILLING_MULTIPLIER: '2' },
    db: fakeDb(2),
    User: { find: () => ({ lean: async () => users }) },
    Transaction: {
      aggregate: async () => [
        { ...group('deepseek/deepseek-v4.1-flash', 'completion', 1e6, 1.2), _id: { user: users[1]._id, model: 'deepseek/deepseek-v4.1-flash', tokenType: 'completion', structured: false, afterSwitch: true } },
        { ...group('deepseek/deepseek-v4.1-flash', 'completion', 2e6, 1.2), _id: { user: users[3]._id, model: 'deepseek/deepseek-v4.1-flash', tokenType: 'completion', structured: false, afterSwitch: true } },
      ],
    },
    KadeUsage: { aggregate: async () => [{ _id: { user: users[0]._id, service: 'fal_video' }, costUSD: 12.4 }] },
    Ledger: { aggregate: async () => [{ _id: users[0]._id, usd: 30, entries: 1 }] },
    Balance: { find: () => ({ lean: async () => [{ user: users[1]._id, tokenCredits: 1e6 }] }) },
  };
  const people = await F.fundingPeople({}, deps);
  assert.deepEqual(people.map((p) => p.name), ['Kade', 'Holly', 'Amber A']);
  const holly = people.find((p) => p.name === 'Holly');
  assert.equal(holly.realCostUSD, 0.6);
  assert.equal(holly.walletBalanceUSD, 1);
  assert.equal(people.find((p) => p.name === 'Amber A').differenceUSD, -17.6);
  assert.equal(people.find((p) => p.name === 'Kade').admin, true);
});

test('the acting person comes from the database: role, child, review seat', async () => {
  const docs = {
    '6a0000000000000000000001': { _id: '6a0000000000000000000001', name: 'Amber A', role: 'USER', kadeAccountType: 'adult' },
    '6a0000000000000000000002': { _id: '6a0000000000000000000002', name: 'Skylee', role: 'USER', kadeAccountType: 'child' },
    '6a0000000000000000000009': { _id: '6a0000000000000000000009', name: 'Kade', role: 'ADMIN' },
    '6a6125d73939d20b95251078': { _id: '6a6125d73939d20b95251078', name: 'Visibility Test', role: 'USER' },
  };
  const deps = { env: {}, User: { findById: (id) => ({ lean: async () => docs[String(id)] || null }) } };
  assert.deepEqual(await F.account('6a0000000000000000000009', deps), { id: '6a0000000000000000000009', name: 'Kade', admin: true, child: false, reviewSeat: false });
  assert.equal((await F.account('6a0000000000000000000002', deps)).child, true);
  assert.equal((await F.account('6a0000000000000000000001', deps)).admin, false);
  assert.equal((await F.account('6a6125d73939d20b95251078', deps)).reviewSeat, true);
  assert.equal(await F.account('not-an-id', deps), null);
  assert.equal(F.isReviewSeat({ id: '6a0000000000000000000001' }, { KADE_APP_REVIEW_USER_IDS: '6a0000000000000000000001' }), true);
});

test('finding a person: email, exact name, first-name prefix, or ask which', async () => {
  const people = [{ _id: 'a1', name: 'Amber A' }, { _id: 'a2', name: 'Amber Lacey' }, { _id: 'h1', name: 'Holly' }];
  const deps = {
    User: {
      findOne: (q) => ({ lean: async () => (q.email === 'holly@example.com' ? people[2] : null) }),
      find: (q) => ({ limit: () => ({ lean: async () => people.filter((p) => q.name.test(p.name)) }) }),
    },
  };
  assert.deepEqual(await F.findPerson('Holly@Example.com', deps), { one: { id: 'h1', name: 'Holly' } });
  assert.deepEqual(await F.findPerson('amber a', deps), { one: { id: 'a1', name: 'Amber A' } });
  assert.deepEqual(await F.findPerson('Amber', deps), { many: ['Amber A', 'Amber Lacey'] });
  assert.deepEqual(await F.findPerson('Zed', deps), {});
  assert.deepEqual(await F.findPerson('a.*', deps), {});
});

test('repayment validation', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const id = '6a0000000000000000000001';
  assert.equal(F.validateRepayment({ userId: id, usd: '$30' }, now).value.usd, 30);
  assert.equal(F.validateRepayment({ userId: id, usd: '12.345' }, now).value.usd, 12.35);
  assert.match(F.validateRepayment({ userId: id, usd: '3000' }, now).error, /over \$1,000/);
  assert.match(F.validateRepayment({ userId: id, usd: '0' }, now).error, /one cent/);
  assert.match(F.validateRepayment({ userId: id, usd: 'ten' }, now).error, /one cent/);
  assert.match(F.validateRepayment({ userId: id, usd: 5, at: '2026-12-01' }, now).error, /future/);
  assert.match(F.validateRepayment({ userId: id, usd: 5, at: '2025-06-01' }, now).error, /before the platform/);
  assert.equal(F.validateRepayment({ userId: id, usd: 5, at: '2026-09-20' }, now).value.at.toISOString(), '2026-09-20T17:00:00.000Z');
  assert.match(F.validateRepayment({ userId: 'nope', usd: 5 }, now).error, /who paid/);
  assert.equal(F.validateRepayment({ userId: id, usd: 5, clientKey: 'abc' }, now).value.clientKey, undefined);
  assert.equal(F.validateRepayment({ userId: id, usd: 5, clientKey: 'a1b2c3d4-e5f6' }, now).value.clientKey, 'a1b2c3d4-e5f6');
});

test('services land on the right feature', () => {
  const cases = {
    voice_chat: 'voice', phone: 'phone', tts: 'speech', inworld_tts: 'speech', flux: 'pictures', fal_image: 'pictures',
    fal_video: 'video', fal_audio: 'audio', google_lyria: 'audio', soundbooth_script: 'audio', runpod_yue2: 'audio',
    describe: 'describe', 'describe-uncertain': 'describe', tavily: 'search', game_table: 'rooms', clubhouse_bot: 'rooms',
    kade_make_file: 'other',
  };
  for (const [service, feature] of Object.entries(cases)) assert.equal(F.featureOf(service), feature, service);
  assert.equal(F.dollars(-17.6), '$17.60');
  assert.equal(F.dollars(1234.5), '$1,234.50');
  assert.equal(F.cents(-0.001), 0);
});
