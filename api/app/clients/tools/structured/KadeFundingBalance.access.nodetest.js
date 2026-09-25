/* kade_funding_balance: who may ask about whom (Part 291, Sep 25 2026).
 * Run: node --test api/app/clients/tools/structured/KadeFundingBalance.access.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const REVIEW = '6a6125d73939d20b95251078';
const ORIGINAL_KADE_FUNDING = process.env.KADE_FUNDING;
const PEOPLE = {
  kade: { id: 'kade', name: 'Kade', admin: true, child: false, reviewSeat: false },
  amber: { id: 'amber', name: 'Amber A', admin: false, child: false, reviewSeat: false },
  holly: { id: 'holly', name: 'Holly', admin: false, child: false, reviewSeat: false },
  skylee: { id: 'skylee', name: 'Skylee', admin: false, child: true, reviewSeat: false },
  hiddenreview: { id: 'hiddenreview', name: 'Hidden', admin: false, child: false, reviewSeat: true },
  /* A seat whose request claims ADMIN but whose account is not. */
  pretender: { id: 'pretender', name: 'Pat', admin: false, child: false, reviewSeat: false },
};

/* The tool reads KADE_FUNDING from a process object of its own (Part 291 review F26), so no test
 * ever writes the real process.env, and a KADE_FUNDING=0 set outside cannot fail these tests. */
function load({ failWith, env = {} } = {}) {
  const seen = { summaries: [], people: 0, accounts: [] };
  const funding = {
    reviewSeatIds: () => [REVIEW],
    isReviewSeat: (u) => String(u.id || u._id || '') === REVIEW || String(u.email || '') === 'vischeck@example.test',
    account: async (id) => {
      seen.accounts.push(id);
      if (failWith) throw failWith;
      return PEOPLE[id] || null;
    },
    windowFor: (period) => (period === 'this_month' ? { from: 'month' } : {}),
    findPerson: async (t) =>
      /^amber a$/i.test(t) ? { one: { id: 'amber', name: 'Amber A' } } : /^a$/i.test(t) ? { many: ['Amber A', 'Amber Lacey'] } : {},
    fundingSummary: async (id, window) => {
      seen.summaries.push(id);
      seen.window = window;
      return { id, child: PEOPLE[id] && PEOPLE[id].child };
    },
    fundingPeople: async () => {
      seen.people++;
      return [{ name: 'Kade', admin: true }, { name: 'Amber A', admin: false, realCostUSD: 12.4, paidBackUSD: 30, differenceUSD: -17.6, status: 'ahead' }];
    },
    spokenLine: (p) => `line for ${p.name}`,
    forModel: (s, { self }) => ({ id: s.id, self, child: !!s.child }),
  };
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
    '@librechat/api': { fundingToolDescription: 'd', fundingToolSchema: {} },
    '~/server/services/kadeFunding': funding,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeFundingBalance'), 'utf8'), {
    module,
    require: (name) => {
      if (!(name in stubs)) throw new Error(`unexpected require ${name}`);
      return stubs[name];
    },
    JSON,
    String,
    process: { env },
  });
  const Tool = module.exports;
  return { make: (req, extra = {}) => new Tool({ req, userId: 'kade', ...extra }), seen, Tool };
}
const call = async (tool, input = {}) => JSON.parse(await tool._call(input));

test('a member gets their own figures and cannot ask about anyone else', async () => {
  const { make, seen } = load();
  const h = { user: { id: 'holly', role: 'USER' }, body: {} };
  assert.deepEqual(await call(make(h)), { id: 'holly', self: true, child: false });
  assert.deepEqual(await call(make(h), { person: 'me' }), { id: 'holly', self: true, child: false });
  assert.deepEqual(await call(make(h), { person: 'Holly' }), { id: 'holly', self: true, child: false });
  const refused = await call(make(h), { person: 'Amber A' });
  assert.equal(refused.refused, true);
  assert.match(refused.spoken, /your own/);
  assert.equal((await call(make(h), { person: 'everyone' })).refused, true);
  assert.deepEqual(seen.summaries, ['holly', 'holly', 'holly']);
  assert.equal(seen.people, 0);
});

test('the asker never comes from the userId option (that is the signed-in seat)', async () => {
  const { make, seen } = load();
  await call(make({ user: { id: 'amber', role: 'USER' }, body: {} }, { userId: 'kade' }));
  assert.deepEqual(seen.summaries, ['amber']);
});

test('a request claiming ADMIN is checked against the database', async () => {
  const { make, seen } = load();
  const out = await call(make({ user: { id: 'pretender', role: 'ADMIN' }, body: {} }), { person: 'Amber A' });
  assert.equal(out.refused, true);
  assert.deepEqual(seen.summaries, []);
});

test('a voice caller acts as themselves even though the seat is Kade', async () => {
  const { make, seen } = load();
  const req = { user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'holly' }, body: { isTemporary: true } };
  assert.deepEqual(await call(make(req)), { id: 'holly', self: true, child: false });
  assert.equal((await call(make(req), { person: 'Amber A' })).refused, true);
  assert.equal((await call(make(req), { person: 'everyone' })).refused, true);
  assert.deepEqual(seen.summaries, ['holly']);
  assert.equal(seen.people, 0);
});

test('an unidentified voice caller is told politely that nothing was looked up', async () => {
  const { make, seen } = load();
  const a = await call(make({ user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true, body: { isTemporary: true } }), { person: 'Amber A' });
  const b = await call(make({ user: { id: 'kade', role: 'ADMIN' }, body: { isTemporary: true } }));
  assert.match(a.error, /couldn't tell whose account/);
  assert.match(b.error, /couldn't tell whose account/);
  assert.match(a.error, /Do not guess/);
  assert.deepEqual(seen.summaries, []);
  assert.deepEqual(seen.accounts, []);
});

test('Kade on her own seat may ask about anyone by name, or everyone', async () => {
  const { make, seen } = load();
  const k = { user: { id: 'kade', role: 'ADMIN' }, body: {} };
  assert.deepEqual(await call(make(k)), { id: 'kade', self: true, child: false });
  assert.deepEqual(await call(make(k), { person: 'Amber A' }), { id: 'amber', self: false, child: false });
  assert.match((await call(make(k), { person: 'A' })).ask, /Amber A, Amber Lacey/);
  assert.match((await call(make(k), { person: 'Zed' })).error, /Nobody named "Zed"/);
  const all = await call(make(k), { person: 'everyone' });
  assert.equal(seen.people, 1);
  assert.deepEqual(all.people.map((p) => p.name), ['Amber A'], 'Kade herself is left out of the list');
  assert.equal(all.people[0].spoken, 'line for Amber A');
});

test('Kade calling in by voice as herself keeps her powers', async () => {
  const { make } = load();
  const req = { user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'kade' }, body: { isTemporary: true } };
  assert.deepEqual(await call(make(req), { person: 'Amber A' }), { id: 'amber', self: false, child: false });
});

test('the App Review seat hears only that it is not available', async () => {
  const { make, seen } = load();
  for (const id of [REVIEW, 'hiddenreview']) {
    const out = await call(make({ user: { id, role: 'USER' }, body: {} }));
    assert.equal(out.available, false);
    assert.doesNotMatch(JSON.stringify(out), /Kade|paid|owe|cost|money/i);
  }
  assert.deepEqual(seen.summaries, []);
  assert.deepEqual(seen.accounts, ['hiddenreview'], 'the known review id is refused before any lookup');
});

test("a child's own lookup is marked for the gentle wording", async () => {
  const { make } = load();
  assert.deepEqual(await call(make({ user: { id: 'skylee', role: 'USER' }, body: {} })), { id: 'skylee', self: true, child: true });
});

test('period passes through; failures and the kill switch never guess', async () => {
  const { make, seen } = load();
  await call(make({ user: { id: 'holly', role: 'USER' }, body: {} }), { period: 'this_month' });
  assert.deepEqual(seen.window, { from: 'month' });
  const broken = load({ failWith: new Error('db down') });
  const out = await call(broken.make({ user: { id: 'holly', role: 'USER' }, body: {} }));
  assert.match(out.error, /Do not guess/);
  const switchedOff = load({ env: { KADE_FUNDING: '0' } });
  const off = await call(switchedOff.make({ user: { id: 'holly', role: 'USER' }, body: {} }));
  assert.match(off.error, /switched off/);
  assert.deepEqual(switchedOff.seen.accounts, [], 'nothing is looked up while it is off');
  assert.equal(process.env.KADE_FUNDING, ORIGINAL_KADE_FUNDING, 'the real environment is never touched');
  assert.match((await call(make({ body: {} }))).error, /Sign in/);
});

test('the App Review seat never gets the tool: signed in, or a voice caller acting as it (F22)', () => {
  const { Tool } = load();
  assert.equal(Tool.hiddenFor({ user: { id: REVIEW, role: 'USER' } }), true);
  assert.equal(Tool.hiddenFor({ user: { id: 'other', email: 'vischeck@example.test', role: 'USER' } }), true, 'caught by email too');
  assert.equal(Tool.hiddenFor({ user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: REVIEW, email: 'x@example.test' } }), true);
  assert.equal(Tool.hiddenFor({ user: { id: 'kade', role: 'ADMIN' } }), false);
  assert.equal(Tool.hiddenFor({ user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'holly' } }), false);
  assert.equal(Tool.hiddenFor({ user: { id: 'holly', role: 'USER' }, body: {} }), false);
  assert.equal(Tool.hiddenFor(undefined), false);
});

test('initialize.js leaves the tool out for the review seat, even when an agent lists it', () => {
  const src = fs.readFileSync(require.resolve('../../../../server/services/Endpoints/agents/initialize.js'), 'utf8');
  assert.match(src, /fundingHidden = require\('~\/app\/clients\/tools\/structured\/KadeFundingBalance'\)\.hiddenFor\(req\)/);
  assert.match(src, /let fundingHidden = true;/, 'a failed check leaves it out');
  assert.match(src, /const withFeedback = fundingHidden\s*\?\s*offered\.filter\(\(t\) => t !== 'kade_funding_balance'\)\s*:\s*offered;/);
});
