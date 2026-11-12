/* Nov 12 2026 (audit SEC-1): kade_approvals approve needs her own plain yes, in a message that
 * arrived AFTER the request was made, one approval per message, and (Kade's rule) no approval at
 * all on a plain yes while more than one earlier request is waiting. The real KadeApprovals.js,
 * services/kadeSpendGate.js and services/kadeApprovals.js word reading run here; the approvals
 * collection is a stand-in, so nothing ships.
 *
 * Run: node --test api/app/clients/tools/structured/KadeApprovals.gate.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { stubModules } = require('../../../../test/kadeFakeMongo.cjs');

const T = Date.parse('2026-11-12T18:00:00Z');
let rows = {};
let decided = [];
let gets = 0;
let listFails = false;

const approvals = {
  herWordsApprove: (text) => realApprovals.herWordsApprove(text),
  get: async (id) => {
    gets += 1;
    return rows[id] || null;
  },
  list: async ({ status } = {}) => {
    if (listFails) throw new Error('db down');
    return Object.values(rows)
      .map((r) => (r.status === 'pending' && new Date(r.expiresAt).getTime() < Date.now() ? { ...r, status: 'expired' } : r))
      .filter((r) => !status || r.status === status);
  },
  decide: async (args) => {
    decided.push(args);
    return { status: args.decision === 'approve' ? 'done' : 'denied', resultWords: 'ok', summary: 's' };
  },
};

stubModules({
  '@librechat/agents/langchain/tools': { Tool: class {} },
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
  '@librechat/api': { ownsPrivateMemory: (req) => Boolean(req && req.user && req.user.role === 'ADMIN') },
  '~/server/services/kadeApprovals': approvals,
  '~/server/services/kadeSpendGate': require(path.join(__dirname, '../../../../server/services/kadeSpendGate')),
});

const realApprovals = require(path.join(__dirname, '../../../../server/services/kadeApprovals'));
const KadeApprovals = require('./KadeApprovals');

const row = (id, createdAt, extra = {}) => {
  rows[id] = {
    approvalId: id,
    status: 'pending',
    createdAt: createdAt === undefined ? undefined : new Date(createdAt),
    expiresAt: new Date(Date.now() + 3600000),
    ...extra,
  };
};
const turn = (text, extra = {}) => ({ user: { id: 'kade', role: 'ADMIN' }, body: { text }, kadeMessageArrivedAt: T, ...extra });
const call = (req, data) => new KadeApprovals({ req })._call(data);
const approve = (req, approvalId = 'a1') => call(req, { action: 'approve', approvalId });

beforeEach(() => {
  rows = {};
  decided = [];
  gets = 0;
  listFails = false;
});

test('a plain yes approves a request made before her message, once, by words', async () => {
  row('a1', T - 60000);
  const out = await approve(turn('yes, ship it'));
  assert.match(out, /"status":"done"/);
  assert.deepEqual(decided, [{ approvalId: 'a1', decision: 'approve', by: 'words' }]);
});

test('a request made during this reply, or with no time on it, is refused', async () => {
  row('a1', T + 5);
  assert.match(await approve(turn('yes')), /made during this reply/);
  row('a1', undefined);
  assert.match(await approve(turn('yes')), /made during this reply/, 'the NaN case refuses');
  row('a1', T - 60000);
  assert.match(await approve(turn('yes', { kadeMessageArrivedAt: undefined })), /made during this reply/, 'no arrival stamp');
  assert.equal(decided.length, 0);
});

test('a message that is not a plain yes is refused before the request is even read', async () => {
  row('a1', T - 60000);
  for (const text of ['Ok, fix the login bug and open a PR.', 'Ok, make a PR', 'Yeah, send me the PR', 'okay tell me about the weather', 'ok can you commit and push that']) {
    assert.match(await approve(turn(text)), /not a plain yes/, text);
  }
  assert.equal(gets, 0);
  assert.equal(decided.length, 0);
});

test('a regenerated reply is never a new yes', async () => {
  row('a1', T - 60000);
  assert.match(await approve(turn('yes', { body: { text: 'yes', isRegenerate: true } })), /not a plain yes/);
  assert.equal(decided.length, 0);
});

test('a folded voice turn: only the tail after the fold counts', async () => {
  row('a1', T - 60000);
  const fold = '[earlier in this conversation, for context only; do not re-answer]\nYOU: okay, ship it\nTHEM: shall I?\n[reply only to what follows.]';
  assert.match(await approve(turn(`${fold}\nYOU: okay, ship it`)), /not a plain yes/);
  assert.match(await approve(turn(`${fold} yes`)), /"status":"done"/);
});

test('one approval per message; a refused first approve does not spend it', async () => {
  row('a1', T - 60000);
  row('a2', T - 50000, { status: 'done' });
  const req = turn('yes');
  assert.match(await approve(req, 'a2'), /not waiting any more \(done\)/);
  assert.match(await approve(req, 'a1'), /"status":"done"/);
  assert.match(await approve(req, 'a1'), /One approval per message/);
  assert.equal(decided.length, 1);
});

test("Kade's rule: two requests waiting from before her message, and a plain yes approves neither", async () => {
  row('a1', T - 60000);
  row('a2', T - 30000);
  const out = await approve(turn('yes, ship it'), 'a1');
  assert.match(out, /more than one request is waiting/);
  assert.equal(decided.length, 0);
  // One made during this reply does not count as waiting before her message.
  rows.a2.createdAt = new Date(T + 10);
  assert.match(await approve(turn('yes, ship it'), 'a1'), /"status":"done"/);
});

test('an expired or finished second request does not count as waiting', async () => {
  row('a1', T - 60000);
  row('a2', T - 30000, { expiresAt: new Date(Date.now() - 1000) });
  row('a3', T - 20000, { status: 'denied' });
  assert.match(await approve(turn('yes')), /"status":"done"/);
});

test('when the waiting list cannot be read, nothing is approved', async () => {
  row('a1', T - 60000);
  listFails = true;
  assert.match(await approve(turn('yes')), /could not check what else is waiting/);
  assert.equal(decided.length, 0);
});

test('deny still works on any words; list is untouched; a non-admin seat gets nothing', async () => {
  row('a1', T - 60000);
  await call(turn('no, drop it'), { action: 'deny', approvalId: 'a1' });
  assert.deepEqual(decided, [{ approvalId: 'a1', decision: 'deny', by: 'words' }]);
  assert.match(await call(turn('list'), { action: 'list' }), /"approvals"/);
  assert.match(await call({ user: { id: 'x', role: 'USER' }, body: { text: 'yes' } }, { action: 'approve', approvalId: 'a1' }), /Kade's alone/);
});

test('the chat route stamps the arrival before anything else runs', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../../../../server/routes/agents/chat.js'), 'utf8');
  const stamp = src.indexOf('req.kadeMessageArrivedAt = Date.now();');
  assert.ok(stamp > 0);
  assert.ok(stamp < src.indexOf('router.use(moderateText)') || src.indexOf('router.use(moderateText)') < 0);
  const defs = require('node:fs').readFileSync(path.join(__dirname, '../../../../../packages/api/src/tools/registry/definitions.ts'), 'utf8');
  assert.ok(defs.includes('the request was made in an EARLIER reply'), 'the schema text is mirrored');
});
