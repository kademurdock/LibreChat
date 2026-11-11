/* Nov 10 2026 (plan item S7): the claim counter in utils/kadePromiseGuard.js counts replies that
 * state a price, a start or a tool failure in a turn with no tool call. It only counts: one log
 * line, no change to the reply, no change to any tool result.
 *
 * Run: node --test api/server/utils/kadeClaimCounter.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { countClaims, countUnbackedClaims, applyReminderPromiseGuard } = require('./kadePromiseGuard');

const text = (t) => ({ type: 'text', text: t });
const call = (name, output = 'ok') => ({ type: 'tool_call', tool_call: { name, output } });
const lines = [];
const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };

beforeEach(() => {
  lines.length = 0;
  delete process.env.KADE_CLAIM_COUNTER;
});

test('a price, a start and a failure are each counted when no tool was called', () => {
  const parts = [text("That one costs about 12 cents. I've started it for you. Oh, and the search tool is down right now.")];
  assert.deepEqual(countClaims(parts), { tools: 0, price: 1, start: 1, failure: 1 });
  const n = countUnbackedClaims(parts, { agentId: 'agent_x', logger });
  assert.deepEqual(n, { tools: 0, price: 1, start: 1, failure: 1 });
  assert.deepEqual(lines, ['[kade/claim-counter] agent=agent_x tools=0 price=1 start=1 failure=1']);
});

test('claim shapes that count', () => {
  const price = ['It will cost $0.16 to make.', 'The price is 8 cents a song.', 'That would run you about a dollar.', 'It is 40 cents at the very most.'];
  const start = ["I've just kicked it off.", 'I started the job a second ago.', 'Your song is now rendering.', "It's running now.", 'I’ve queued that up.'];
  const failure = ['The tool failed on me.', 'It timed out.', 'I ran into an error.', "The search isn't cooperating, it didn't go through.", 'The booth keeps timing out.', 'Something went wrong on my end.'];
  for (const s of price) assert.equal(countClaims([text(s)]).price, 1, s);
  for (const s of start) assert.equal(countClaims([text(s)]).start, 1, s);
  for (const s of failure) assert.equal(countClaims([text(s)]).failure, 1, s);
});

test('ordinary speech is not counted', () => {
  for (const s of [
    "That's not working for me, can we try a different plan?",
    'I can start it whenever you like.',
    'Want me to start the job?',
    'I saved five dollars at the store yesterday.',
    'You gave me 20 cents back in change.',
    'She started school in the fall.',
    'How much does it cost? I do not know yet.',
    'My day was fine, it started slow.',
  ]) {
    assert.deepEqual(countClaims([text(s)]), { tools: 0, price: 0, start: 0, failure: 0 }, s);
  }
});

test('a turn that called any tool writes no line, whatever the reply says', () => {
  const parts = [call('kade_task', '{"started":true}'), text("I've started it. It costs about 12 cents.")];
  const n = countUnbackedClaims(parts, { agentId: 'agent_x', logger });
  assert.equal(n.tools, 1);
  assert.equal(lines.length, 0);
});

test('a reply with no claim writes no line', () => {
  countUnbackedClaims([text('Good morning. How did you sleep?')], { agentId: 'agent_x', logger });
  assert.equal(lines.length, 0);
});

test('the line carries counts and the agent id only, never the reply', () => {
  countUnbackedClaims([text('The private thing costs 12 cents and I started it.')], { agentId: 'agent_x', logger });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[kade\/claim-counter\] agent=agent_x tools=0 price=\d+ start=\d+ failure=\d+$/);
});

test('it blocks nothing and changes nothing: the parts are the same objects with the same text', () => {
  const parts = [text("I've started it and it costs 12 cents."), call('x', 'RESULT TEXT')];
  const frozen = JSON.stringify(parts);
  const lone = [text("I've started it and it costs 12 cents.")];
  const before = JSON.stringify(lone);
  countUnbackedClaims(parts, { logger });
  countUnbackedClaims(lone, { logger });
  assert.equal(JSON.stringify(parts), frozen);
  assert.equal(JSON.stringify(lone), before);
});

test('odd input never throws', () => {
  assert.deepEqual(countClaims(null), { tools: 0, price: 0, start: 0, failure: 0 });
  assert.deepEqual(countClaims([null, 5, { type: 'text' }, { type: 'text', text: { value: 'It costs 5 cents.' } }]), { tools: 0, price: 1, start: 0, failure: 0 });
  assert.doesNotThrow(() => countUnbackedClaims([text('It costs 5 cents.')]));
});

test('KADE_CLAIM_COUNTER=0 turns it off', () => {
  process.env.KADE_CLAIM_COUNTER = '0';
  assert.equal(countUnbackedClaims([text('It costs 5 cents.')], { logger }), null);
  assert.equal(lines.length, 0);
});

test('the reminder guard beside it is untouched', () => {
  const out = applyReminderPromiseGuard([text('Done, your reminder is set.')], { agentTools: ['kade_notify'], logger });
  assert.match(out[0].text, /did \*\*not\*\* actually get set/);
});
