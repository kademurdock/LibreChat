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
  // A consultation or other server-built run.
  assert.equal(ownsNudgePickup({ user: { id: kade }, kadeHiddenRun: true }), false);
  assert.equal(ownsNudgePickup({}), false);
  assert.equal(ownsNudgePickup(null), false);
});
