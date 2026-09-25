/* Part 291: real provider cost read back from the chat meter.
 * Run: node --test api/server/services/kadeRealCost.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./kadeRealCost');

/* Sticker rows in USD per million tokens, which is also credits per token. */
const ROWS = {
  'deepseek/deepseek-v4.1-flash': { prompt: 0.15, completion: 0.6 },
  'z-ai/glm-5.3-flash': { prompt: 0.15, completion: 0.5 },
  'anthropic/claude-sonnet-5': { prompt: 3, completion: 15 },
};
const CACHE = { 'anthropic/claude-sonnet-5': { write: 3.75, read: 0.3 } };
/** A db whose rates carry the platform factor x, exactly like data-schemas tx.ts. */
const fakeDb = (x) => ({
  getValueKey: (m) => (ROWS[m] ? m : undefined),
  getMultiplier: ({ model, tokenType }) => (ROWS[model] ? ROWS[model][tokenType] : 6) * x,
  getCacheMultiplier: ({ model, cacheType }) =>
    CACHE[model] && CACHE[model][cacheType] != null ? CACHE[model][cacheType] * x : null,
});
const bucket = (id, sums) => ({
  _id: { structured: false, afterSwitch: true, ...id },
  raw: 0,
  input: 0,
  write: 0,
  read: 0,
  charged: 0,
  rows: 1,
  ...sums,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('chat charged at the platform factor comes back at the real sticker', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const p = R.priceGroup(
    bucket({ model: 'deepseek/deepseek-v4.1-flash', tokenType: 'prompt' }, { raw: 1e6, charged: -0.3e6 }),
    price,
    2,
  );
  near(p.chargedUSD, 0.3);
  near(p.realUSD, 0.15);
  assert.equal(p.unpriced, null);
});

test('rows billed on the wrong price row before the switch are re-priced, not halved', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const p = R.priceGroup(
    bucket(
      { model: 'z-ai/glm-5.3-flash', tokenType: 'completion', afterSwitch: false },
      { raw: 1e6, charged: -9e6 },
    ),
    price,
    2,
  );
  near(p.chargedUSD, 9);
  near(p.realUSD, 0.5);
});

test('interrupted replies lose the upstream 1.15: tokens are priced, not the charge', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const p = R.priceGroup(
    bucket({ model: 'deepseek/deepseek-v4.1-flash', tokenType: 'completion' }, { raw: 1e6, charged: -1.38e6 }),
    price,
    2,
  );
  near(p.realUSD, 0.6);
});

test('cached prompt tokens are priced at the cache rows', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const p = R.priceGroup(
    bucket(
      { model: 'anthropic/claude-sonnet-5', tokenType: 'prompt', structured: true },
      { raw: 1.2e6, input: 1e5, write: 1e5, read: 1e6, charged: -3.15e6 },
    ),
    price,
    2,
  );
  // 0.1M x $3 + 0.1M x $3.75 + 1M x $0.30 = 0.975
  near(p.realUSD, 0.975);
});

test('a model with no price row falls back to charged / the factor of its date', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const after = R.priceGroup(bucket({ model: 'mystery/model-9', tokenType: 'completion' }, { raw: 1e6, charged: -12e6 }), price, 2);
  near(after.realUSD, 6);
  assert.equal(after.unpriced, 'mystery/model-9');
  const before = R.priceGroup(
    bucket({ model: 'mystery/model-9', tokenType: 'completion', afterSwitch: false }, { raw: 1e6, charged: -6e6 }),
    price,
    2,
  );
  near(before.realUSD, 6);
  const nameless = R.priceGroup(bucket({ model: null, tokenType: 'prompt' }, { raw: 10, charged: -60 }), price, 2);
  assert.equal(nameless.unpriced, '(no model)');
});

test('with no platform factor set, real equals the sticker and nothing is divided', () => {
  assert.equal(R.platformFactor({}), 1);
  assert.equal(R.platformFactor({ KADE_BILLING_MULTIPLIER: 'abc' }), 1);
  assert.equal(R.platformFactor({ KADE_BILLING_MULTIPLIER: '2' }), 2);
  const price = R.createPricer(fakeDb(1), 1);
  const p = R.priceGroup(bucket({ model: 'deepseek/deepseek-v4.1-flash', tokenType: 'prompt' }, { raw: 1e6, charged: -0.15e6 }), price, 1);
  near(p.realUSD, 0.15);
});

test('realChat asks only for spend rows and rolls buckets up under the caller keys', async () => {
  let pipeline;
  const Transaction = {
    aggregate: async (p) => {
      pipeline = p;
      return [
        bucket({ user: 'a', model: 'deepseek/deepseek-v4.1-flash', tokenType: 'prompt' }, { raw: 1e6, charged: -0.3e6, rows: 3 }),
        bucket({ user: 'a', model: 'deepseek/deepseek-v4.1-flash', tokenType: 'completion' }, { raw: 1e6, charged: -1.2e6, rows: 3 }),
        bucket({ user: 'b', model: 'mystery/model-9', tokenType: 'prompt' }, { raw: 1e6, charged: -4e6, rows: 1 }),
      ];
    },
  };
  const out = await R.realChat({
    Transaction,
    db: fakeDb(2),
    env: { KADE_BILLING_MULTIPLIER: '2' },
    match: { createdAt: { $gte: new Date('2026-09-01T05:00:00Z') } },
    keys: { user: '$user' },
  });
  assert.deepEqual(pipeline[0].$match.tokenType, { $in: ['prompt', 'completion'] });
  assert.ok(pipeline[0].$match.createdAt);
  assert.equal(pipeline[1].$group._id.user, '$user');
  assert.equal(pipeline[1].$group._id.model, '$model');
  const a = out.find((r) => r.key.user === 'a');
  const b = out.find((r) => r.key.user === 'b');
  near(a.realUSD, 0.75);
  near(a.chargedUSD, 1.5);
  assert.equal(a.rows, 6);
  assert.deepEqual(a.unpricedModels, []);
  near(b.realUSD, 2);
  assert.deepEqual(b.unpricedModels, ['mystery/model-9']);
});

test('the switch-over date splits old rows from new ones', () => {
  const stage = R.txGroupStage({ user: '$user' });
  assert.deepEqual(stage.$group._id.afterSwitch, { $gte: ['$createdAt', R.FACTOR_SINCE] });
  assert.equal(R.FACTOR_SINCE.toISOString(), '2026-09-05T05:01:00.000Z');
});

test('the gauge shows the administrator real cost and everyone else exactly what they are charged', () => {
  const env = { KADE_BILLING_MULTIPLIER: '2' };
  const db = fakeDb(2);
  const person = R.gaugePricing('USER', db, env);
  assert.equal(person.getMultiplier, db.getMultiplier);
  assert.equal(person.getCacheMultiplier, db.getCacheMultiplier);
  assert.equal(R.gaugePricing(undefined, db, env).getMultiplier, db.getMultiplier);
  const admin = R.gaugePricing('ADMIN', db, env);
  near(admin.getMultiplier({ model: 'anthropic/claude-sonnet-5', tokenType: 'completion' }), 15);
  near(admin.getCacheMultiplier({ model: 'anthropic/claude-sonnet-5', cacheType: 'read' }), 0.3);
  assert.equal(admin.getCacheMultiplier({ model: 'deepseek/deepseek-v4.1-flash', cacheType: 'read' }), null);
  near(R.gaugePricing('admin', db, env).getMultiplier({ model: 'z-ai/glm-5.3-flash', tokenType: 'prompt' }), 0.15);
});

test('admin role detection ignores case and missing roles', () => {
  assert.equal(R.isAdminRole('ADMIN'), true);
  assert.equal(R.isAdminRole('admin'), true);
  assert.equal(R.isAdminRole('USER'), false);
  assert.equal(R.isAdminRole(null), false);
});
