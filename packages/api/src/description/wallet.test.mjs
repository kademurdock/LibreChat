import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDescriptionWallet } from './wallet.ts';
import Module, { createRequire } from 'node:module';

let mongo;
const wallet = createDescriptionWallet();
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
async function account(dollars, role = 'USER') {
  const user = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('users').insertOne({ _id: user, role });
  if (dollars !== undefined) await mongoose.connection.collection('balances').insertOne({ user, tokenCredits: dollars * 1e6 });
  return String(user);
}
test('parallel jobs cannot reserve the same wallet money; reservations and refunds are idempotent', async () => {
  const owner = await account(10);
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) => wallet.reserve(owner, `run-${n}`, 6)));
  assert.equal(results.filter(Boolean).length, 1);
  const run = `run-${results.indexOf(true)}`;
  assert.equal(await wallet.available(owner), 4);
  assert.equal(await wallet.reserve(owner, run, 6), true);
  await Promise.all(Array.from({ length: 10 }, () => wallet.settle(owner, run, 1.25)));
  assert.equal(await wallet.available(owner), 8.75);
  assert.equal(await wallet.reserve(owner, run, 6), false);
});
test('provider overrun never charges more than the accepted price or overdraws a balance', async () => {
  const owner = await account(1);
  assert.equal(await wallet.reserve(owner, 'overrun', 0.25), true);
  await wallet.settle(owner, 'overrun', 30);
  assert.equal(await wallet.available(owner), 0.75);
  await wallet.settle(owner, 'overrun', 30);
  assert.equal(await wallet.available(owner), 0.75);
});
test('cancelled unstarted work returns its entire reservation, even after another chat spends money', async () => {
  const owner = await account(10);
  await wallet.reserve(owner, 'cancel', 7);
  await mongoose.connection.collection('balances').updateOne({ user: new mongoose.Types.ObjectId(owner) }, { $inc: { tokenCredits: -2e6 } });
  await wallet.settle(owner, 'cancel', 0);
  assert.equal(await wallet.available(owner), 8);
});

test('recovery fences a reservation that arrives late, and racing reserve/refund never strands money', async () => {
  const owner = await account(10);
  await wallet.settle(owner, 'late-reservation', 0);
  assert.equal(await wallet.reserve(owner, 'late-reservation', 4), false);
  for (let i = 0; i < 20; i++) {
    await Promise.all([wallet.reserve(owner, `race-${i}`, 4), wallet.settle(owner, `race-${i}`, 0)]);
    assert.equal(await wallet.available(owner), 10);
  }
});
test('administrators are paid by the platform; missing or empty member balances cannot start paid work', async () => {
  const owner = await account(undefined, 'ADMIN');
  assert.equal(await wallet.available(owner), null);
  assert.equal(await wallet.reserve(owner, 'admin-film', 500), true);
  await wallet.settle(owner, 'admin-film', 300);
  assert.equal(await wallet.available(owner), null);
  for (const value of [undefined, 0]) {
    const member = await account(value);
    assert.equal(await wallet.available(member), 0);
    assert.equal(await wallet.reserve(member, 'paid-film', 0.01), false);
    assert.equal(await wallet.reserve(member, 'included-narration', 0), true);
  }
});

test('recording provider usage does not debit a reserved description twice, while ordinary metered usage still debits', async () => {
  mongoose.model('User', new mongoose.Schema({ role: String }), 'users');
  mongoose.model('Balance', new mongoose.Schema({ user: mongoose.Schema.Types.ObjectId, tokenCredits: Number }), 'balances');
  const original = Module._load;
  let logKadeUsage;
  try {
    Module._load = function (name, parent, isMain) {
      if (name === '@librechat/data-schemas') return { logger: { warn() {} } };
      return original.call(this, name, parent, isMain);
    };
    ({ logKadeUsage } = createRequire(import.meta.url)('../../../../api/models/kadeUsage.js'));
  } finally { Module._load = original; }
  const userId = await account(10);
  await wallet.reserve(userId, 'logged-run', 2);
  await logKadeUsage({ userId, service: 'describe', quantity: 1, costUSD: 0.5,
    metadata: { source: 'described-video', job: 'test', walletHandled: true } });
  assert.equal(await wallet.available(userId), 8);
  await wallet.settle(userId, 'logged-run', 0.5);
  assert.equal(await wallet.available(userId), 9.5);
  await logKadeUsage({ userId, service: 'describe', quantity: 1, costUSD: 0.25,
    metadata: { source: 'library' } });
  assert.equal(await wallet.available(userId), 9.25);
  assert.equal(await mongoose.connection.collection('kadeusage').countDocuments({ user: new mongoose.Types.ObjectId(userId) }), 2);
});
