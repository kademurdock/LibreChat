/* /api/kade/funding (Part 291): admin or ops secret only, repayments idempotent, void and restore.
 * Run: node --test api/server/routes/kadeFunding.routes.nodetest.js
 * Offline: the ledger and accounts are in-memory fakes, the sign-in is a stub. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const API = path.resolve(__dirname, '../..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/* The sign-in stub: a JSON x-test-user header is the signed-in person; none means not signed in. */
const fakeJwt = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ message: 'Unauthorized' });
  req.user = JSON.parse(raw);
  return next();
};
const originalLoad = Module._load;
before(() => {
  Module._load = function (id, parent, isMain) {
    if (id === '@librechat/data-schemas') return { logger: quiet };
    if (id === '@librechat/api') return { libraryReviewSeat: () => false };
    if (id === './requireJwtAuth' && parent && /kadeOpsSecret/.test(parent.filename)) return fakeJwt;
    if (typeof id === 'string' && id.startsWith('~/')) return originalLoad.call(this, path.join(API, id.slice(2)), parent, isMain);
    return originalLoad.apply(this, arguments);
  };
});
after(() => {
  Module._load = originalLoad;
});

const KADE = '6a0000000000000000000009';
const AMBER = '6a0000000000000000000001';
const HOLLY = '6a0000000000000000000002';
const USERS = { [KADE]: { _id: KADE, name: 'Kade', role: 'ADMIN' }, [AMBER]: { _id: AMBER, name: 'Amber A', role: 'USER' }, [HOLLY]: { _id: HOLLY, name: 'Holly', role: 'USER' } };
const as = (id) => JSON.stringify({ id, role: USERS[id].role });
const lean = (v) => ({ lean: async () => v });

function fakeLedger() {
  const rows = [];
  let n = 0;
  const matches = (doc, q) =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne && doc[k] !== undefined;
      return String(doc[k]) === String(v) || (v === null && doc[k] == null);
    });
  return {
    rows,
    exists: async (q) => rows.some((r) => matches(r, q)),
    findOne: (q) => lean(rows.find((r) => matches(r, q)) || null),
    create: async (doc) => {
      if (doc.clientKey && rows.some((r) => r.clientKey === doc.clientKey)) {
        throw Object.assign(new Error('dup'), { code: 11000 });
      }
      const row = { _id: `6b00000000000000000000${String(++n).padStart(2, '0')}`, voidedAt: null, voidReason: '', ...doc };
      rows.push(row);
      return { toObject: () => ({ ...row }) };
    },
    find: (q) => ({ sort: () => ({ limit: () => lean(rows.filter((r) => matches(r, q)).slice().reverse()) }) }),
    findOneAndUpdate: (q, u) => {
      const row = rows.find((r) => matches(r, q));
      if (row) Object.assign(row, u.$set);
      return lean(row ? { ...row } : null);
    },
  };
}
const fakeUser = {
  findById: (id) => lean(USERS[String(id)] || null),
  find: (q) => lean(q._id.$in.map((id) => USERS[id]).filter(Boolean)),
};

function app({ ledger = fakeLedger(), summaries = [] } = {}) {
  const express = require('express');
  const realFunding = require('../services/kadeFunding');
  const funding = {
    ...realFunding,
    fundingSummary: async (userId, window) => {
      summaries.push({ userId, window });
      const paid = ledger.rows.filter((r) => String(r.user) === userId && r.kind === 'repayment' && !r.voidedAt).reduce((s, r) => s + r.usd, 0);
      return realFunding.compose({
        user: USERS[userId],
        usageRows: [{ _id: 'fal_video', costUSD: 12.4 }],
        repaid: { usd: paid },
        price: () => ({ priced: false, rate: null }),
        factor: 2,
        window,
      });
    },
    fundingPeople: async () => [
      { name: 'Kade', admin: true, realCostUSD: 50, paidBackUSD: 0 },
      { name: 'Amber A', admin: false, realCostUSD: 12.4, paidBackUSD: 30 },
      { name: 'Holly', admin: false, realCostUSD: 20, paidBackUSD: 0 },
    ],
  };
  const { createFundingRouter } = require('./kadeFunding');
  const a = express();
  a.use(express.json());
  a.use('/api/kade/funding', createFundingRouter({ funding, Ledger: ledger, User: fakeUser }));
  return { a, ledger, summaries };
}

test('nobody signed in, and signed-in people who are not Kade, are turned away', async () => {
  const request = require('supertest');
  const { a, ledger } = app();
  await request(a).get('/api/kade/funding/people').expect(401);
  await request(a).get('/api/kade/funding/people').set('x-test-user', as(AMBER)).expect(403);
  await request(a).get(`/api/kade/funding/summary?userId=${AMBER}`).set('x-test-user', as(AMBER)).expect(403);
  await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(AMBER)).send({ userId: AMBER, usd: 30 }).expect(403);
  assert.equal(ledger.rows.length, 0);
});

test('the ops secret works only when set and exactly right, and acts as nobody', async () => {
  const request = require('supertest');
  const { a, ledger } = app();
  delete process.env.KADE_OPS_SECRET;
  await request(a).get('/api/kade/funding/people').set('x-kade-ops-secret', '').expect(401);
  process.env.KADE_OPS_SECRET = 'test-ops-secret-value';
  try {
    await request(a).get('/api/kade/funding/people').set('x-kade-ops-secret', 'test-ops-secret-valuX').expect(401);
    await request(a).get('/api/kade/funding/people').set('x-kade-ops-secret', 'short').expect(401);
    const ok = await request(a).post('/api/kade/funding/repayments').set('x-kade-ops-secret', 'test-ops-secret-value').send({ userId: AMBER, usd: '30', at: '2026-09-20', note: 'PayPal' }).expect(200);
    assert.equal(ok.body.ok, true);
    assert.equal(ledger.rows[0].via, 'ops');
    assert.equal(ledger.rows[0].addedBy, null);
    assert.doesNotMatch(JSON.stringify(ok.body), /test-ops-secret/);
    await request(a).get('/api/kade/funding/summary').set('x-kade-ops-secret', 'test-ops-secret-value').expect(400);
  } finally {
    delete process.env.KADE_OPS_SECRET;
  }
});

test('Kade records a repayment once per submit and hears the new difference', async () => {
  const request = require('supertest');
  const { a, ledger } = app();
  const body = { userId: AMBER, usd: '$30.00', at: '2026-09-20', note: 'PayPal, thank you', clientKey: 'a1b2c3d4-0001' };
  const first = await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send(body).expect(200);
  assert.equal(first.body.entry.usd, 30);
  assert.equal(first.body.entry.name, 'Amber A');
  assert.equal(first.body.entry.at, '2026-09-20T17:00:00.000Z');
  assert.equal(first.body.summary.paidBackUSD, 30);
  assert.equal(
    first.body.spoken,
    "Recorded $30.00 from Amber A. Amber A's use has really cost you $12.40 so far. Amber A has paid you back $30.00, so Amber A is $17.60 ahead.",
  );
  const again = await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send(body).expect(200);
  assert.equal(again.body.duplicate, true);
  assert.equal(ledger.rows.length, 1);
  assert.equal(String(ledger.rows[0].addedBy), KADE);
  assert.equal(ledger.rows[0].kind, 'repayment');
  const bad = await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send({ userId: AMBER, usd: '0' }).expect(400);
  assert.match(bad.body.error, /one cent/);
  await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send({ userId: '6a00000000000000000000ff', usd: 5 }).expect(404);
});

test('removing a repayment is a void that can be put back; grants cannot be voided here', async () => {
  const request = require('supertest');
  const { a, ledger } = app();
  const made = await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send({ userId: HOLLY, usd: 10 }).expect(200);
  const id = made.body.entry.id;
  const gone = await request(a).post(`/api/kade/funding/repayments/${id}/void`).set('x-test-user', as(KADE)).send({ reason: 'typo' }).expect(200);
  assert.ok(gone.body.entry.voidedAt);
  assert.equal(gone.body.entry.voidReason, 'typo');
  assert.equal(gone.body.summary.paidBackUSD, 0);
  await request(a).post(`/api/kade/funding/repayments/${id}/void`).set('x-test-user', as(KADE)).expect(404);
  const back = await request(a).post(`/api/kade/funding/repayments/${id}/restore`).set('x-test-user', as(KADE)).expect(200);
  assert.equal(back.body.entry.voidedAt, null);
  assert.equal(back.body.summary.paidBackUSD, 10);
  await request(a).post(`/api/kade/funding/repayments/${id}/restore`).set('x-test-user', as(KADE)).expect(404);
  await request(a).post('/api/kade/funding/repayments/not-an-id/void').set('x-test-user', as(KADE)).expect(400);
  ledger.rows.push({ _id: '6b0000000000000000000099', user: HOLLY, kind: 'grant', usd: 5, voidedAt: null });
  await request(a).post('/api/kade/funding/repayments/6b0000000000000000000099/void').set('x-test-user', as(KADE)).expect(404);
});

test('the ledger lists repayments by default, grants on request, with names', async () => {
  const request = require('supertest');
  const { a, ledger } = app();
  await request(a).post('/api/kade/funding/repayments').set('x-test-user', as(KADE)).send({ userId: AMBER, usd: 30 }).expect(200);
  ledger.rows.push({ _id: '6b0000000000000000000088', user: HOLLY, kind: 'grant', usd: 5, note: '', at: new Date(), voidedAt: null });
  const rep = await request(a).get('/api/kade/funding/ledger').set('x-test-user', as(KADE)).expect(200);
  assert.deepEqual(rep.body.entries.map((e) => [e.kind, e.name, e.usd]), [['repayment', 'Amber A', 30]]);
  const grants = await request(a).get('/api/kade/funding/ledger?kind=grant').set('x-test-user', as(KADE)).expect(200);
  assert.deepEqual(grants.body.entries.map((e) => [e.kind, e.name, e.usd]), [['grant', 'Holly', 5]]);
  const all = await request(a).get('/api/kade/funding/ledger?kind=all').set('x-test-user', as(KADE)).expect(200);
  assert.equal(all.body.entries.length, 2);
});

test('people: totals leave Kade out; summary defaults to her own and passes the period', async () => {
  const request = require('supertest');
  const { a, summaries } = app();
  const people = await request(a).get('/api/kade/funding/people?period=this_month').set('x-test-user', as(KADE)).expect(200);
  assert.deepEqual(people.body.totals, { othersRealUSD: 32.4, paidBackUSD: 30, differenceUSD: 2.4 });
  assert.equal(people.body.spoken, "Other people's use has really cost you $32.40. They have paid you back $30.00, so you have covered $2.40 more than they paid back.");
  assert.ok(people.body.window.from);
  assert.equal(people.headers['cache-control'], 'no-store');
  const own = await request(a).get('/api/kade/funding/summary').set('x-test-user', as(KADE)).expect(200);
  assert.equal(own.body.userId, KADE);
  assert.match(own.body.spoken, /^You pay the bills/);
  const amber = await request(a).get(`/api/kade/funding/summary?userId=${AMBER}&period=this_month`).set('x-test-user', as(KADE)).expect(200);
  assert.equal(amber.body.name, 'Amber A');
  assert.ok(summaries[summaries.length - 1].window.from, 'this_month reaches the service as a window');
});
