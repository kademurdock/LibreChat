/* Family library access, the trusted uploader and the librarian's digest in the
 * Library routes (Sep 24 2026). The rules themselves are tested in
 * packages/api/src/library/access.test.ts; this checks the route wiring.
 * Run: node --test api/server/routes/kadeReadingRoomAccess.selftest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `slice ${from}`);
  return source.slice(start, end);
};
const logger = { info() {}, warn() {}, error() {} };
/* Stand-in for familyLibraryMember: admins, and ids starting with "fam". */
const member = (user) => !!user && (user.role === 'ADMIN' || String(user.id).startsWith('fam'));

test('shared items open only for family members; everyone keeps their own', async () => {
  const books = {
    own: { _id: 'own', owner: 'new-person', state: 'ready', shared: false },
    family: { _id: 'family', owner: 'fam-amber', state: 'ready', shared: true },
    grown: { _id: 'grown', owner: 'fam-amber', state: 'ready', shared: true, grownUpsOnly: true },
    private: { _id: 'private', owner: 'fam-amber', state: 'ready', shared: false },
  };
  const c = {
    require: (name) => (name === '@librechat/api' ? { familyLibraryMember: member } : require(name)),
    isId: () => true,
    isAdmin: (req) => req.user.role === 'ADMIN',
    isChild: async (req) => req.user.kadeAccountType === 'child',
    KadeBook: { findById: (id) => ({ lean: async () => books[id] || null }) },
  };
  vm.runInNewContext(slice('function libraryHiddenFrom(req)', 'function listenClock') + slice('async function openBook(req, id)', 'function summary('), c);
  const open = async (user, id) => (await c.openBook({ user }, id))?._id || null;
  const stranger = { id: 'new-person' };
  assert.equal(c.libraryHiddenFrom({ user: stranger }), true);
  assert.equal(await open(stranger, 'own'), 'own');
  assert.equal(await open(stranger, 'family'), null);
  assert.equal(await open(stranger, 'private'), null);
  const family = { id: 'fam-holly' };
  assert.equal(c.libraryHiddenFrom({ user: family }), false);
  assert.equal(await open(family, 'family'), 'family');
  assert.equal(await open(family, 'private'), null);
  assert.equal(await open({ id: 'fam-kid', kadeAccountType: 'child' }, 'grown'), null);
  assert.equal(await open({ id: 'kade', role: 'ADMIN' }, 'private'), 'private');
});

test("a collection shows only items its reader could open on their own", async () => {
  let filter;
  const collection = { _id: 'c1', owner: 'fam-amber', shared: true, items: [{ book: 'a', track: 0 }], toObject() { return this; } };
  const c = {
    router: { get: (_path, ...handlers) => { c.handler = handlers.at(-1); } },
    requireJwtAuth() {},
    openCollection: async () => collection,
    isChild: async (req) => req.user.kadeAccountType === 'child',
    isAdmin: (req) => req.user.role === 'ADMIN',
    libraryHiddenFrom: (req) => !member(req.user),
    KadeBook: { find: (query) => { filter = query; return { lean: async () => [] }; } },
    summary: (b) => b,
    collOut: (x) => x,
    logger,
  };
  vm.runInNewContext(slice("router.get('/collections/:id'", "router.post('/collections/:id/items'"), c);
  const read = async (user) => {
    filter = null;
    await c.handler({ params: { id: 'c1' }, user }, { status() { return this; }, json() { return this; } });
    return JSON.parse(JSON.stringify(filter));
  };
  assert.deepEqual((await read({ id: 'new-person' })).$or, [{ owner: 'new-person' }]);
  assert.deepEqual((await read({ id: 'fam-holly' })).$or, [{ owner: 'fam-holly' }, { shared: true }]);
  const kid = await read({ id: 'fam-kid', kadeAccountType: 'child' });
  assert.deepEqual(kid.grownUpsOnly, { $ne: true });
  assert.equal((await read({ id: 'kade', role: 'ADMIN' })).$or, undefined);
});

function submissionsRoute({ trusted = false, item = null, pending = 0 } = {}) {
  const log = { created: [], shared: [], settled: [], digest: 0 };
  const c = {
    router: { post: (_path, ...handlers) => { c.handler = handlers.at(-1); } },
    requireJwtAuth() {},
    express: { json: () => () => {} },
    isId: () => true,
    isAdmin: (req) => req.user.role === 'ADMIN',
    canPublish: (req) => req.user.role === 'ADMIN' || trusted,
    settleTrustedSubmissions: async (_req, ids) => { log.settled.push(...ids.map(String)); },
    refreshLibrarianDigest: () => { log.digest++; },
    subOut: (s) => s,
    logger,
    require: (name) => (name === '@librechat/api' ? { trustedApprovalNote: 'Approved automatically.' } : require(name)),
    KadeBook: {
      findOne: () => ({ lean: async () => item }),
      updateOne: async (query, update) => { log.shared.push({ query, update }); },
    },
    KadeLibrarySubmission: {
      countDocuments: async () => pending,
      create: async (doc) => { log.created.push(doc); return { toObject: () => doc }; },
    },
  };
  vm.runInNewContext(slice("router.post('/submissions'", '/** Mine; for a librarian'), c);
  const send = async (body) => {
    let code = 200, result;
    await c.handler({ body, user: { id: 'amber', name: 'Amber A', role: 'USER' } }, { status(n) { code = n; return this; }, json(x) { result = x; return this; } });
    return { code, result };
  };
  return { send, log };
}

test("a trusted uploader's finished file goes straight in; her links and everyone else's items wait", async () => {
  const ready = { _id: 'b1', owner: 'amber', state: 'ready', shared: false };
  let s = submissionsRoute({ trusted: true, item: ready, pending: 73 });
  let r = await s.send({ book: 'b1', title: 'Making Out' });
  assert.equal(r.code, 200, 'the old pile does not block her');
  assert.equal(s.log.created[0].status, 'approved');
  assert.equal(s.log.created[0].decisionNote, 'Approved automatically.');
  assert.deepEqual(s.log.shared[0].update.$set.shared, true);
  assert.deepEqual(s.log.settled, ['b1']);
  assert.equal(s.log.digest, 0, 'no note for Kade');

  s = submissionsRoute({ trusted: true, item: null });
  r = await s.send({ url: 'https://example.com/tape' });
  assert.equal(s.log.created[0].status, undefined);
  assert.equal(s.log.shared.length, 0);
  assert.equal(s.log.digest, 1);

  s = submissionsRoute({ trusted: true, item: { ...ready, state: 'pending' } });
  await s.send({ book: 'b1' });
  assert.equal(s.log.created[0].status, undefined);
  assert.equal(s.log.digest, 1);

  // Her recording donation is shared from the start and goes in when its upload lands.
  s = submissionsRoute({ trusted: true, item: { ...ready, state: 'pending', shared: true } });
  await s.send({ book: 'b1' });
  assert.equal(s.log.created[0].status, 'approved');
  assert.equal(s.log.shared.length, 0);
  assert.equal(s.log.digest, 0);

  s = submissionsRoute({ trusted: false, item: ready });
  await s.send({ book: 'b1' });
  assert.equal(s.log.created[0].status, undefined);
  assert.equal(s.log.shared.length, 0);
  assert.equal(s.log.digest, 1);

  s = submissionsRoute({ trusted: false, item: ready, pending: 50 });
  assert.equal((await s.send({ book: 'b1' })).code, 400);
});

/* A tiny in-memory stand-in for KadePendingNudge. */
function nudgeStore(rows) {
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, want]) => {
      const have = row[key];
      if (want === null) return have == null;
      if (want instanceof RegExp || (want && want.constructor && want.constructor.name === 'RegExp')) return want.test(String(have || ''));
      if (want && typeof want === 'object' && '$gt' in want) return have > want.$gt;
      return String(have) === String(want);
    });
  let next = 1;
  return {
    rows,
    async updateMany(filter, update) { for (const row of rows.filter((r) => matches(r, filter))) Object.assign(row, update.$set); },
    async updateOne(filter, update) { const row = rows.find((r) => matches(r, filter)); if (row) Object.assign(row, update.$set); },
    async findOne(filter) { return rows.find((r) => matches(r, filter)) || null; },
    async deleteOne(filter) { const i = rows.findIndex((r) => matches(r, filter)); if (i >= 0) rows.splice(i, 1); },
    async exists(filter) { return rows.some((r) => matches(r, filter)); },
    async create(doc) { const row = { _id: 'n' + next++, deliveredAt: null, createdAt: new Date(), ...doc }; rows.push(row); return row; },
  };
}

test("Kade gets one waiting library note, rewritten in place, never one per item", async () => {
  let text = 'Waiting for your yes or no on the Library page: Amber uploaded 3 books.';
  const legacy = (t) => ({ _id: t, userId: 'kade', type: 'reminder', channel: 'chat', deliveredAt: null, createdAt: new Date(), text: t });
  const store = nudgeStore([
    legacy('Amber submitted something for the family library: "A" (a file). Open the Library page to approve or decline it.'),
    legacy('Amber asks for "B" to go in the family library. Open the Library page to approve or decline it.'),
    legacy('Karen says "C" is on the wrong shelf. Open the Library page to move it or leave it.'),
    legacy('Reminder: call Holly at five'),
  ]);
  const c = {
    process: { env: {} },
    logger,
    KadeBook: {},
    KadeLibrarySubmission: {},
    require: (name) => {
      if (name === '@librechat/api') return { pendingLibraryDigest: async () => text };
      if (name === '~/models/kadeNudge') return { KadePendingNudge: store };
      if (name === '~/db/models') return { User: { find: () => ({ lean: async () => [{ _id: 'kade' }] }) } };
      return require(name);
    },
  };
  vm.runInNewContext(slice('const LIBRARY_DIGEST = ', "router.post('/submissions'"), c);
  const waiting = () => store.rows.filter((r) => r.type === 'library-digest' && r.deliveredAt == null);

  await c.refreshLibrarianDigest();
  assert.equal(store.rows.filter((r) => r.type === 'reminder' && r.deliveredAt == null).length, 1, 'old per-item notes fold into the digest');
  assert.equal(store.rows.find((r) => r.text === 'Reminder: call Holly at five').deliveredAt, null);
  assert.equal(waiting().length, 1);
  assert.equal(waiting()[0].channel, 'chat');

  text = 'Waiting for your yes or no on the Library page: Amber uploaded 12 books.';
  await Promise.all([c.refreshLibrarianDigest(), c.refreshLibrarianDigest(), c.refreshLibrarianDigest()]);
  assert.equal(waiting().length, 1);
  assert.equal(waiting()[0].text, text);

  waiting()[0].deliveredAt = new Date(); // she chatted and heard it
  text = 'Waiting for your yes or no on the Library page: Amber uploaded 13 books.';
  await c.refreshLibrarianDigest();
  assert.equal(waiting().length, 0, 'no second note within six hours');

  store.rows.find((r) => r.type === 'library-digest').createdAt = new Date(Date.now() - 7 * 3600000);
  await c.refreshLibrarianDigest({ create: false });
  assert.equal(waiting().length, 0, 'a decision never starts a new note');
  await c.refreshLibrarianDigest();
  assert.equal(waiting().length, 1);

  text = '';
  await c.refreshLibrarianDigest({ create: false });
  assert.equal(waiting().length, 0, 'nothing waiting, so the note goes');
});
