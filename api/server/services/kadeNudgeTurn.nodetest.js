/* Run: node --test api/server/services/kadeNudgeTurn.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownsNudgePickup, waitingNotesBlock } = require('./kadeNudgeTurn');

test('waiting notes come after the answer and never ask for the start of the reply', () => {
  const block = waitingNotesBlock([
    { text: 'Waiting in the Library for your yes or no: Amber uploaded 12 books. They are on the Library page.' },
    { text: '  ' },
    { text: 'Reminder: call Holly' },
  ]);
  assert.match(block, /^# Waiting notes for this user\n/);
  assert.match(block, /Answer their latest message first/);
  assert.match(block, /calling any tools you normally would/);
  assert.match(block, /near the end of your reply/);
  assert.doesNotMatch(block, /START/i);
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 2);
  assert.equal(waitingNotesBlock([]), '');
  assert.equal(waitingNotesBlock(undefined), '');
});

test("only the person's own visible turn takes their notes", () => {
  const kade = '6a3cba4d0b0afa92194e42f7';
  assert.equal(ownsNudgePickup({ user: { id: kade } }), true);
  // Kade on the phone lane: acting for herself.
  assert.equal(ownsNudgePickup({ user: { id: kade }, kadeOnBehalfOf: { id: kade } }), true);
  // The voice lane signs in as Kade's service seat while a family member is on the line.
  assert.equal(ownsNudgePickup({ user: { id: kade }, kadeOnBehalfOf: { id: '6a5fc5fa351af41332734161' } }), false);
  // The bridge named someone on the line but the lookup failed.
  assert.equal(ownsNudgePickup({ user: { id: kade }, body: { kadeOnBehalfOf: 'x@example.com' }, kadeOnBehalfOfUnresolved: true }), false);
  // A consultation or other server-built run.
  assert.equal(ownsNudgePickup({ user: { id: kade }, kadeHiddenRun: true }), false);
  assert.equal(ownsNudgePickup({}), false);
  assert.equal(ownsNudgePickup(null), false);
});

test('a phone call leaves the Library digest for chat; chat takes everything', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('./kadeNudges'), 'utf8');
  const rows = [
    { _id: 1, userId: 'k', channel: 'chat', deliveredAt: null, type: 'reminder', text: 'Call Holly', createdAt: 1 },
    { _id: 2, userId: 'k', channel: 'chat', deliveredAt: null, type: 'library-digest', text: 'Amber uploaded 3 books', createdAt: 2 },
  ];
  const seen = [];
  const KadePendingNudge = {
    find(filter) {
      seen.push(filter);
      const nin = (filter.type && filter.type.$nin) || [];
      const hit = rows.filter((r) => r.userId === filter.userId && r.deliveredAt == null && !nin.includes(r.type));
      return { sort: () => ({ limit: () => ({ lean: async () => hit }) }) };
    },
    async updateMany(filter) {
      for (const r of rows) if (filter._id.$in.includes(r._id)) r.deliveredAt = new Date();
    },
  };
  const context = { KadePendingNudge, Array };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function takePendingChatNudges('), source.indexOf('/** ---- the sweep')), context);
  const phone = await context.takePendingChatNudges('k', 5, { exceptTypes: ['library-digest'] });
  assert.deepEqual(phone.map((n) => n.text), ['Call Holly']);
  assert.equal(rows[1].deliveredAt, null, 'the digest still waits for chat');
  const chat = await context.takePendingChatNudges('k');
  assert.deepEqual(chat.map((n) => n.text), ['Amber uploaded 3 books']);
  assert.equal(seen[1].type, undefined, 'chat pickup has no type filter');
  // The call-memories route really passes the filter.
  const kade = fs.readFileSync(require.resolve('../routes/kade.js'), 'utf8');
  assert.match(kade, /takePendingChatNudges\(uid, 5, \{ exceptTypes: \['library-digest'\] \}\)/);
});
