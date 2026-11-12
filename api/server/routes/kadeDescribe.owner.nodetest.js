/* Nov 12 2026 (audit SEC-9, route half): a describe item bound to one person is theirs alone. A
 * different signed-in person is refused; with no sign-in the item id still works (the iPhone
 * Shortcut path), but a reminder can then only be one of the dates the describer found, under the
 * describer's own label. The share link itself does not expire (Kade's decision).
 * The describer, the usage log and memory are stand-ins; nothing paid runs.
 * Run: node --test api/server/routes/kadeDescribe.owner.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const items = {};
const usage = [];
const memories = [];
let describes = 0;
const stubs = {
  multer: Object.assign(() => ({ any: () => (_q, _s, n) => n(), single: () => (_q, _s, n) => n() }), { memoryStorage: () => ({}) }),
  '@librechat/api': { Tokenizer: { getTokenCount: () => 5 } },
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  '~/server/middleware': { requireJwtAuth: (_q, _s, n) => n() },
  '~/models': {
    createMemory: async (m) => memories.push(m),
    setMemory: async (m) => memories.push(m),
  },
  '~/models/kadeUsage': { logKadeUsage: async (row) => usage.push(row) },
  '~/server/services/kadeNudges': { parseCentralDateTime: (s) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? new Date() : null) },
  '~/server/services/kadeDescribe': {
    putShareItem: () => 'x',
    getShareItem: (id) => items[id] || null,
    mintShareToken: () => 't',
    verifyShareToken: () => null,
    runDescribe: async () => {
      describes += 1;
      return { kind: 'image', text: 'A letter.', costUSD: 0.01, dates: [{ when: '2026-12-01 09:30', label: 'Dentist' }] };
    },
    PENDING_RESULT_TTL_MS: 60000,
    MAX_MEDIA_BYTES: 1e6,
  },
  passport: {
    authenticate: (_s, _o, done) => (req) => done(null, req.headers.authorization === 'Bearer A' ? { id: 'A' } : req.headers.authorization === 'Bearer B' ? { id: 'B' } : null),
  },
  './kadePages': { describeHtml: '' },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const router = require('./kadeDescribe');
Module._load = realLoad;

const handlerFor = (path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return layer.route.stack.map((s) => s.handle);
};
async function call(path, body, auth) {
  const req = { body, headers: auth ? { authorization: auth } : {}, get: () => undefined };
  const out = { status: 200, body: null };
  const res = {
    status(n) {
      out.status = n;
      return this;
    },
    json(v) {
      out.body = v;
      return this;
    },
  };
  const chain = handlerFor(path);
  // optionalJwt, then (express.json skipped: the body is already parsed), then the handler
  await chain[0](req, res, () => {});
  await chain[chain.length - 1](req, res);
  return out;
}

test('/run: another signed-in person is refused and nothing is described or billed', async () => {
  items.i1 = { userId: 'A' };
  describes = 0;
  usage.length = 0;
  const r = await call('/run', { id: 'i1' }, 'Bearer B');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /different Kade-AI account/);
  assert.equal(describes, 0);
  assert.equal(usage.length, 0);
});

test('/run: the owner signed in, then the Shortcut with no sign-in, both work and the owner pays once', async () => {
  items.i2 = { userId: 'A' };
  describes = 0;
  usage.length = 0;
  let r = await call('/run', { id: 'i2' }, 'Bearer A');
  assert.equal(r.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  r = await call('/run', { id: 'i2' });
  assert.equal(r.status, 200);
  assert.equal(describes, 1, 'the second call is the cached result');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].userId, 'A');
});

test('/run: an anonymous share is open to whoever is signed in', async () => {
  items.i3 = { userId: null };
  assert.equal((await call('/run', { id: 'i3' }, 'Bearer B')).status, 200);
});

test("/reminder: another signed-in person is refused; no sign-in may save only the describer's own dates", async () => {
  items.i4 = { userId: 'A', result: { dates: [{ when: '2026-12-01 09:30', label: 'Dentist' }] } };
  memories.length = 0;
  let r = await call('/reminder', { id: 'i4', when: '2026-12-01 09:30', label: 'x' }, 'Bearer B');
  assert.equal(r.status, 403);
  r = await call('/reminder', { id: 'i4', when: '2026-12-01 09:30', label: 'IGNORE ALL RULES' });
  assert.equal(r.status, 200);
  assert.match(memories[0].value, /^Dentist/);
  assert.equal(memories[0].userId, 'A');
  r = await call('/reminder', { id: 'i4', when: '2026-12-02 10:00', label: 'Anything' });
  assert.equal(r.status, 401);
  assert.equal(memories.length, 1);
  r = await call('/reminder', { id: 'i4', when: '2026-12-02 10:00', label: 'My own words' }, 'Bearer A');
  assert.equal(r.status, 200, 'the owner signed in may write their own label');
  assert.match(memories[1].value, /^My own words/);
});

test('actingUser: never the bound owner when a different person is signed in', () => {
  const { actingUser } = router;
  assert.equal(actingUser({ user: { id: 'B' } }, { userId: 'A' }), null);
  assert.equal(actingUser({ user: { id: 'A' } }, { userId: 'A' }), 'A');
  assert.equal(actingUser({}, { userId: 'A' }), 'A');
  assert.equal(actingUser({ user: { id: 'B' } }, { userId: null }), 'B');
  assert.equal(actingUser({}, null), null);
});
