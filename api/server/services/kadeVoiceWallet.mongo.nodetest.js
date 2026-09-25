'use strict';
/* node --test api/server/services/kadeVoiceWallet.mongo.nodetest.js
 * Part 291 review F10 + F13, against a real (in-memory) MongoDB: the wallet writer a voice turn
 * billed to its caller uses (kadeRealCost.voiceWalletUpdate) keeps a debt, seeds a first-time
 * caller's start balance, and never overwrites credits that are already there. The Balance schema
 * below mirrors packages/data-schemas/src/schema/balance.ts (defaults included), because mongoose
 * applies those defaults on an upsert. Nothing here touches the network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const R = require('./kadeRealCost');

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  tokenCredits: { type: Number, default: 0 },
  autoRefillEnabled: { type: Boolean, default: false },
  refillIntervalValue: { type: Number, default: 30 },
  refillIntervalUnit: { type: String, enum: ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months'], default: 'days' },
  lastRefill: { type: Date, default: Date.now },
  refillAmount: { type: Number, default: 0 },
  tenantId: { type: String, index: true },
});
const Balance = mongoose.models.TestVoiceWalletBalance || mongoose.model('TestVoiceWalletBalance', schema);

let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Balance.init();
});
test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
test.beforeEach(async () => {
  await Balance.deleteMany({});
});

const oid = () => new mongoose.Types.ObjectId();
const START = { enabled: true, startBalance: 10e6 };
const credits = async (user) => (await Balance.findOne({ user }).lean()).tokenCredits;

test('F10: a caller at -400000 who makes a voice turn ends at or below -400000', async () => {
  const user = oid();
  await Balance.create({ user, tokenCredits: -400000 });
  const write = R.voiceWalletUpdate({ balanceConfig: START, Balance });
  const out = await write({ user: String(user), incrementValue: -20000 });
  assert.equal(out.tokenCredits, -420000);
  assert.equal(await credits(user), -420000);
  assert.equal(await Balance.countDocuments({ user }), 1);
});

test('F13: a caller with no Balance record gets the start balance first, then the spend', async () => {
  const user = oid();
  const write = R.voiceWalletUpdate({ balanceConfig: START, Balance });
  await write({ user: String(user), incrementValue: -20000 });
  assert.equal(await credits(user), 10e6 - 20000);
  // A second turn charges the same record; it is never seeded again.
  await write({ user: String(user), incrementValue: -5000 });
  assert.equal(await credits(user), 10e6 - 25000);
  assert.equal(await Balance.countDocuments({ user }), 1);
});

test('F13: a record whose credits are null is filled with the start balance; real credits are never overwritten', async () => {
  const nul = oid();
  await Balance.collection.insertOne({ user: nul, tokenCredits: null });
  const write = R.voiceWalletUpdate({ balanceConfig: START, Balance });
  await write({ user: String(nul), incrementValue: -1000 });
  assert.equal(await credits(nul), 10e6 - 1000);
  const rich = oid();
  await Balance.create({ user: rich, tokenCredits: 250000 });
  await write({ user: String(rich), incrementValue: -1000 });
  assert.equal(await credits(rich), 249000);
  const zero = oid();
  await Balance.create({ user: zero, tokenCredits: 0 });
  await write({ user: String(zero), incrementValue: -1000 });
  assert.equal(await credits(zero), -1000, 'a real $0 wallet is not a missing one');
});

test('with no start balance configured, a first voice turn records the debt instead of a $0 row', async () => {
  const user = oid();
  const write = R.voiceWalletUpdate({ balanceConfig: { enabled: true }, Balance });
  await write({ user: String(user), incrementValue: -700 });
  assert.equal(await credits(user), -700);
});
