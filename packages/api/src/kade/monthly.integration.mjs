import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';

// Run with installed monorepo dependencies, or point MONTHLY_TEST_DEPENDENCIES at
// an isolated tools directory. MONTHLY_COMPILED_MODULE selects the real TS build.
const require = process.env.MONTHLY_TEST_DEPENDENCIES
  ? createRequire(resolve(process.env.MONTHLY_TEST_DEPENDENCIES, 'package.json'))
  : createRequire(import.meta.url);
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const { Decimal128, MongoClient, ObjectId } = require('mongodb');
const monthly = process.env.MONTHLY_COMPILED_MODULE
  ? require(resolve(process.env.MONTHLY_COMPILED_MODULE))
  : await import(
      `data:text/javascript;base64,${Buffer.from(
        stripTypeScriptTypes(readFileSync(new URL('./monthly.ts', import.meta.url), 'utf8'), {
          mode: 'strip',
        }),
      ).toString('base64')}`
    );
const { monthlyBooks, monthlyWindow } = monthly;
const window = monthlyWindow('2026-09-01T00:00:00-05:00', '2026-10-01T00:00:00-05:00');
const inside = new Date('2026-09-15T12:00:00.000Z');
const beforeMonth = new Date(window.from.getTime() - 1);
const lastMillisecond = new Date(window.to.getTime() - 1);
let server;
let client;
let databaseCounter = 0;

before(async () => {
  server = await MongoMemoryServer.create({
    binary: {
      version: process.env.MONTHLY_TEST_MONGO_VERSION || '7.0.16',
      downloadDir:
        process.env.MONGOMS_DOWNLOAD_DIR || resolve(tmpdir(), 'monthly-accounting-mongo'),
    },
    instance: { ip: '127.0.0.1', dbName: 'monthly_synthetic' },
  });
  client = new MongoClient(server.getUri());
  await client.connect();
});

after(async () => {
  await client?.close();
  await server?.stop();
});

async function fixture({ users = [], transactions = [], extras = [], funding = [] }) {
  const db = client.db(`monthly_synthetic_${++databaseCounter}`);
  const collections = {
    users: db.collection('synthetic_accounts'),
    transactions: db.collection('synthetic_transactions'),
    extras: db.collection('synthetic_extras'),
    funding: db.collection('synthetic_funding'),
  };
  await Promise.all([
    users.length && collections.users.insertMany(users),
    transactions.length && collections.transactions.insertMany(transactions),
    extras.length && collections.extras.insertMany(extras),
    funding.length && collections.funding.insertMany(funding),
  ]);
  const aggregates = new Map();
  const reader = (collection) => ({
    aggregate: async (pipeline) => {
      const rows = await collection.aggregate(pipeline).toArray();
      aggregates.set(collection.collectionName, rows);
      return rows;
    },
  });
  return {
    collections,
    aggregates,
    books: (testWindow = window) =>
      monthlyBooks(testWindow, {
        Transaction: reader(collections.transactions),
        KadeUsage: reader(collections.extras),
        KadeFundingEntry: reader(collections.funding),
        userCollection: 'synthetic_accounts',
      }),
  };
}

const debit = (user, tokenValue, fields = {}) => ({
  user,
  tokenType: 'prompt',
  tokenValue,
  createdAt: inside,
  ...fields,
});
const usage = (user, costUSD, fields = {}) => ({
  user,
  costUSD,
  service: 'synthetic_extra',
  createdAt: inside,
  ...fields,
});
const entry = (kind, usd, fields = {}) => ({ kind, usd, at: inside, ...fields });

test('real Mongo uses Chicago half-open bounds and excludes credit/refill rows', async () => {
  const user = new ObjectId();
  const data = await fixture({
    users: [{ _id: user, role: 'USER' }],
    transactions: [
      debit(user, -4_000, { createdAt: window.from }),
      debit(user, -4_000, { createdAt: lastMillisecond, tokenType: 'completion' }),
      debit(user, -100_000_000, { createdAt: beforeMonth }),
      debit(user, -100_000_000, { createdAt: window.to }),
      debit(user, 10_000_000),
      debit(user, 0),
      debit(user, -10_000_000, { tokenType: 'credits' }),
      debit(user, 10_000_000, { tokenType: 'autoRefill' }),
      debit(user, -10_000_000, { tokenType: 'other' }),
    ],
    extras: [
      usage(user, 1, { chargedUSD: 2, createdAt: window.from }),
      usage(user, 1, { chargedUSD: 2, createdAt: lastMillisecond }),
      usage(user, 100, { chargedUSD: 100, createdAt: beforeMonth }),
      usage(user, 100, { chargedUSD: 100, createdAt: window.to }),
    ],
  });
  const result = await data.books();
  const grouped = data.aggregates.get('synthetic_transactions');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].rows, 2);
  assert.ok(Math.abs(grouped[0].nominalUSD - 0.008) < 1e-12);
  assert.equal(result.nonAdmin.chatChargedUSD, 0.01);
  assert.equal(result.nonAdmin.extrasChargedUSD, 4);
  assert.equal(result.coverage.chatRows, 2);
  assert.equal(result.coverage.extraRows, 2);
  assert.deepEqual(result.window, {
    from: '2026-09-01T05:00:00.000Z',
    to: '2026-10-01T05:00:00.000Z',
    timeZone: 'America/Chicago',
    endExclusive: true,
  });
});

test('real joins classify owner and USER while retaining missing and unknown roles', async () => {
  const [owner, user, custom, noRole, deleted] = Array.from({ length: 5 }, () => new ObjectId());
  const accounts = [owner, user, custom, noRole, deleted, null];
  const data = await fixture({
    users: [
      { _id: owner, role: ' admin ' },
      { _id: user, role: 'USER' },
      { _id: custom, role: 'RESEARCHER' },
      { _id: noRole },
    ],
    transactions: accounts.map((account, index) => debit(account, -(index + 2) * 1_000_000)),
    extras: accounts.map((account, index) =>
      usage(account, index === 0 ? 10 : index + 1, {
        chargedUSD: index === 0 ? 999 : (index + 1) * 2,
      }),
    ),
  });
  const result = await data.books();
  assert.deepEqual(result.ownerExempt, { chatNominalUSD: 2, extrasNominalUSD: 10 });
  assert.equal(result.nonAdmin.chatChargedUSD, 3);
  assert.equal(result.nonAdmin.extrasChargedUSD, 4);
  assert.equal(result.nonAdmin.walletChargedUSD, 7);
  assert.deepEqual(result.unclassified, { chatNominalUSD: 22, extrasNominalUSD: 18 });
  assert.equal(result.coverage.chatRows, 6);
  assert.equal(result.coverage.extraRows, 6);
  assert.equal(result.coverage.unknownRoleRows, 8);
  assert.equal(result.coverage.unknownRoleAccounts, 3);
  assert.equal(result.coverage.missingAccountRows, 4);
  assert.equal(result.coverage.missingAccounts, 1);
  for (const account of accounts.filter(Boolean)) {
    assert.equal(JSON.stringify(result).includes(account.toHexString()), false);
  }
});

test('real month bounds include the extra hour when Chicago leaves daylight saving time', async () => {
  const november = monthlyWindow('2026-11-01T00:00:00-05:00', '2026-12-01T00:00:00-06:00');
  const user = new ObjectId();
  const data = await fixture({
    users: [{ _id: user, role: 'USER' }],
    transactions: [
      debit(user, -1_000_000, { createdAt: november.from }),
      debit(user, -2_000_000, { createdAt: new Date('2026-11-01T06:30:00Z') }),
      debit(user, -3_000_000, { createdAt: new Date('2026-11-01T07:30:00Z') }),
      debit(user, -4_000_000, { createdAt: new Date('2026-12-01T05:30:00Z') }),
      debit(user, -100_000_000, { createdAt: new Date(november.from.getTime() - 1) }),
      debit(user, -100_000_000, { createdAt: november.to }),
    ],
  });
  const result = await data.books(november);
  assert.equal(result.nonAdmin.chatChargedUSD, 10);
  assert.equal(result.coverage.chatRows, 4);
  assert.equal(result.window.from, '2026-11-01T05:00:00.000Z');
  assert.equal(result.window.to, '2026-12-01T06:00:00.000Z');
});

test('real numeric extras preserve zero and refunds and label legacy inference', async () => {
  const user = new ObjectId();
  const data = await fixture({
    users: [{ _id: user, role: 'USER' }],
    extras: [
      usage(user, 4, { chargedUSD: 8 }),
      usage(user, -1, { chargedUSD: -2 }),
      usage(user, 2, { chargedUSD: 0 }),
      usage(user, 0.15, { chargedUSD: 0, service: 'voice_chat' }),
      usage(user, 0.75),
      usage(user, 0.5, { chargedUSD: '99' }),
      usage(user, Decimal128.fromString('0.125'), { chargedUSD: Decimal128.fromString('0.375') }),
      usage(user, '9', { chargedUSD: 0.25 }),
      usage(user, null),
    ],
  });
  const result = await data.books();
  assert.equal(result.nonAdmin.extrasChargedUSD, 7.88);
  assert.equal(result.nonAdmin.extrasRecordedChargedUSD, 6.63);
  assert.equal(result.nonAdmin.extrasInferredChargedUSD, 1.25);
  assert.equal(result.nonAdmin.walletRecordedChargedUSD, 6.63);
  assert.deepEqual(result.extraRecords, {
    costUSD: 6.53,
    voiceEstimateUSD: 0.15,
    voiceEstimateRows: 1,
  });
  assert.equal(result.coverage.extraRows, 9);
  assert.equal(result.coverage.legacyExtraRows, 3);
  assert.equal(result.coverage.nonAdminLegacyExtraRows, 3);
  assert.equal(result.coverage.ownerLegacyExtraRows, 0);
});

test('refund-only real aggregates remain signed instead of becoming charges', async () => {
  const user = new ObjectId();
  const data = await fixture({
    users: [{ _id: user, role: 'USER' }],
    extras: [usage(user, -2, { chargedUSD: -4 }), usage(user, -0.25)],
  });
  const result = await data.books();
  assert.equal(result.nonAdmin.walletChargedUSD, -4.25);
  assert.equal(result.nonAdmin.extrasRecordedChargedUSD, -4);
  assert.equal(result.nonAdmin.extrasInferredChargedUSD, -0.25);
  assert.equal(result.extraRecords.costUSD, -2.25);
});

test('real ledger excludes voided/outside rows and keeps repayments apart from net grants', async () => {
  const data = await fixture({
    funding: [
      entry('repayment', 20, { at: window.from }),
      entry('repayment', 15, { at: lastMillisecond, voidedAt: null }),
      entry('grant', 10),
      entry('grant', -2),
      entry('repayment', 100, { voidedAt: inside }),
      entry('grant', 100, { voidedAt: inside }),
      entry('repayment', 100, { at: beforeMonth }),
      entry('repayment', 100, { at: window.to }),
      entry('grant', 100, { at: beforeMonth }),
      entry('grant', 100, { at: window.to }),
      entry('other', 100),
    ],
  });
  const result = await data.books();
  assert.deepEqual(result.repayments, { recordedUSD: 35, count: 2 });
  assert.deepEqual(result.grants, { netUSD: 8, count: 2 });
  assert.equal(result.nonAdmin.walletChargedUSD, 0);
});

test('real aggregation sums before rounding across accounts and charge categories', async () => {
  const one = new ObjectId();
  const two = new ObjectId();
  const data = await fixture({
    users: [
      { _id: one, role: 'USER' },
      { _id: two, role: 'USER' },
    ],
    transactions: [debit(one, -4_000), debit(two, -4_000)],
    extras: [usage(one, 0.004, { chargedUSD: 0.004 })],
    funding: [entry('grant', -0.004), entry('grant', -0.004)],
  });
  const result = await data.books();
  assert.equal(result.nonAdmin.chatChargedUSD, 0.01);
  assert.equal(result.nonAdmin.extrasChargedUSD, 0);
  assert.equal(result.nonAdmin.walletChargedUSD, 0.01);
  assert.equal(result.grants.netUSD, -0.01);
  const combined = await fixture({
    users: [{ _id: one, role: 'USER' }],
    transactions: [debit(one, -4_000)],
    extras: [usage(one, 0.004, { chargedUSD: 0.004 })],
  });
  const combinedResult = await combined.books();
  assert.equal(combinedResult.nonAdmin.chatChargedUSD, 0);
  assert.equal(combinedResult.nonAdmin.extrasChargedUSD, 0);
  assert.equal(combinedResult.nonAdmin.walletChargedUSD, 0.01);
  const halves = await fixture({
    users: [{ _id: one, role: 'USER' }],
    transactions: [debit(one, -1_005_000)],
    extras: [usage(one, -0.005, { chargedUSD: -0.005 })],
  });
  const halfResult = await halves.books();
  assert.equal(halfResult.nonAdmin.chatChargedUSD, 1.01);
  assert.equal(halfResult.nonAdmin.extrasChargedUSD, -0.01);
  assert.equal(halfResult.nonAdmin.walletChargedUSD, 1);
});

test('empty real collections return explicit zero totals without account records', async () => {
  const data = await fixture({});
  const result = await data.books();
  assert.equal(result.nonAdmin.walletChargedUSD, 0);
  assert.equal(result.ownerExempt.chatNominalUSD, 0);
  assert.equal(result.coverage.chatRows, 0);
  assert.equal(result.coverage.extraRows, 0);
  assert.deepEqual(result.repayments, { recordedUSD: 0, count: 0 });
  assert.deepEqual(result.grants, { netUSD: 0, count: 0 });
});
