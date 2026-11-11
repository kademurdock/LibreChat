/**
 * The words a turn searches with (kadeRecallQuery.js, Nov 10 2026). Pure
 * functions, no network, no database, no model, invented text only:
 *   node --test api/server/services/kadeRecallQuery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('./kadeRecallQuery.js');

const ON = {};
/** The voice proxy's wrapper, built the way composeTextWithHistory builds it. */
const wrap = (earlier, latest) =>
  '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
  earlier.join('\n') +
  '\n— end of earlier context. Reply ONLY to what follows.]\n\n' +
  latest;

test('the voice wrapper is removed and the latest words are kept exactly', () => {
  const text = wrap(['THEM: tell me a joke about telescopes', 'YOU: Why did the lens blush?'], 'How is the weather looking today?');
  assert.equal(Q.turnWords(text, ON), 'How is the weather looking today?');
  assert.equal(Q.memoryQuery(text, ON), 'How is the weather looking today?');
});

test('ordinary prose that mentions the phrase is left alone', () => {
  const text = 'Earlier in this conversation you said the kiln was fixed.';
  assert.equal(Q.turnWords(text, ON), text);
});

test('a wrapper with no words after it leaves nothing to search with', () => {
  assert.equal(Q.turnWords(wrap(['THEM: old words'], ''), ON), '');
});

test('cleaning is idempotent, so two readers always get the same string', () => {
  const text = '  ' + wrap(['THEM: ' + 'x'.repeat(600)], 'What about the pottery class? ' + 'y'.repeat(2000)) + '  ';
  const once = Q.memoryQuery(text, ON);
  assert.equal(Q.memoryQuery(once, ON), once);
  assert.equal(once.length, Q.QUERY_CHARS);
  assert.ok(once.startsWith('What about the pottery class?'));
});

test('KADE_RECALL_QUERY_CLEAN=0 keeps the old text (wrapper and all)', () => {
  const text = wrap(['THEM: old words'], 'new words here');
  const off = { KADE_RECALL_QUERY_CLEAN: '0' };
  assert.equal(Q.turnWords(text, off), text.trim());
  assert.equal(Q.memoryQuery(text, off), text.trim().slice(0, 1500));
});

test('the previous user message rides only a short latest message', () => {
  const prev = 'My sister starts her pottery class on Thursday.';
  assert.equal(Q.withPrevious('what about her?', prev, ON), prev + '\nwhat about her?');
  const long = 'Can you remind me what we decided about the telescope mount last week?';
  assert.equal(Q.withPrevious(long, prev, ON), long, 'a full message searches alone');
  assert.equal(Q.withPrevious('ok', prev, ON), 'ok', 'under the 12 character gate nothing is added');
  assert.equal(Q.withPrevious('what about her?', '', ON), 'what about her?');
  assert.equal(Q.withPrevious('what about her?', 'what about her?', ON), 'what about her?', 'a repeat adds nothing');
});

test('the previous message is clipped to its last 300 characters and loses its wrapper', () => {
  const prev = wrap(['THEM: never searched'], 'a'.repeat(500) + ' the kiln');
  const q = Q.withPrevious('and then what?', prev, ON);
  assert.ok(!q.includes('never searched'));
  assert.ok(q.endsWith('the kiln\nand then what?'));
  assert.equal(q.length, Q.PREVIOUS_CHARS + 1 + 'and then what?'.length);
});

test('KADE_RECALL_PREV_TURN=0 never adds the previous message', () => {
  const off = { KADE_RECALL_PREV_TURN: '0' };
  assert.equal(Q.isShortTurn('what about her?', off), false);
  assert.equal(Q.withPrevious('what about her?', 'My sister starts Thursday.', off), 'what about her?');
  assert.equal(Q.earlyMemoryQuery('what about her?', 'My sister starts Thursday.', off), 'what about her?');
});

test('tool retrieval always has a memory query to start early, short turn or not', () => {
  assert.equal(Q.earlyMemoryQuery('what about her?', '', ON), 'what about her?');
  assert.equal(Q.earlyMemoryQuery('what about her?', undefined, ON), 'what about her?');
  assert.equal(Q.earlyMemoryQuery('what about her?', 'My sister starts Thursday.', ON), 'My sister starts Thursday.\nwhat about her?');
  const long = 'Tell me about the telescope project we planned.';
  assert.equal(Q.earlyMemoryQuery(long, 'My sister starts Thursday.', ON), long);
  assert.equal(Q.earlyMemoryQuery('ok', 'My sister starts Thursday.', ON), 'ok');
  assert.equal(Q.isShortTurn('x'.repeat(45), { KADE_RECALL_SHORT_CHARS: '60' }), true);
  assert.equal(Q.isShortTurn('x'.repeat(45), ON), false);
});

test('seededQuery finds the memory query a turn already started, the one with a previous message first', () => {
  const memo = (...keys) => ({ _kadeEmbedMemo: new Map(keys.map((k) => [k, Promise.resolve([1])])) });
  assert.equal(Q.seededQuery(memo('query\0what about her?'), 'what about her?'), 'what about her?');
  assert.equal(
    Q.seededQuery(memo('query\0what about her?', 'query\0My sister starts Thursday.\nwhat about her?'), 'what about her?'),
    'My sister starts Thursday.\nwhat about her?',
  );
  assert.equal(Q.seededQuery(memo('tools\0what about her?'), 'what about her?'), null, 'a tools query is not a memory query');
  assert.equal(Q.seededQuery(memo('query\0what about him?'), 'what about her?'), null);
  assert.equal(Q.seededQuery({}, 'what about her?'), null);
  assert.equal(Q.seededQuery(null, 'what about her?'), null);
  assert.equal(Q.seededQuery(memo('query\0'), ''), null);
});

test('earlierCallerLines reads the caller\'s own lines out of the voice wrapper, newest last', () => {
  const text = wrap(['THEM: one', 'YOU: a reply', 'THEM: two', 'THEM: three', 'YOU: THEM: not a caller line', 'THEM: four'], 'latest words');
  assert.deepEqual(Q.earlierCallerLines(text, 3), ['two', 'three', 'four']);
  assert.deepEqual(Q.earlierCallerLines(text, 10), ['one', 'two', 'three', 'four']);
  assert.deepEqual(Q.earlierCallerLines('latest words alone', 3), []);
  assert.deepEqual(Q.earlierCallerLines('THEM: typed by hand, no wrapper', 3), []);
  assert.deepEqual(Q.earlierCallerLines(undefined, 3), []);
});

test('memoHas reads the per-request memo by the exact memory query', () => {
  const req = { _kadeEmbedMemo: new Map([['query\0what about her?', Promise.resolve([1])]]) };
  assert.equal(Q.memoHas(req, 'what about her?'), true);
  assert.equal(Q.memoHas(req, 'what about him?'), false);
  assert.equal(Q.memoHas({}, 'what about her?'), false);
  assert.equal(Q.memoHas(null, 'what about her?'), false);
});

test('recall reads the request text first, the stored message as the fallback', () => {
  assert.equal(Q.recallTurnText('typed words', 'stored words', ON), 'typed words');
  assert.equal(Q.recallTurnText('', 'stored words', ON), 'stored words');
  assert.equal(Q.recallTurnText('   ', 'stored words', ON), 'stored words');
  assert.equal(Q.recallTurnText(undefined, 'stored words', ON), 'stored words');
  assert.equal(Q.recallTurnText(undefined, undefined, ON), '');
  const off = { KADE_RECALL_DEADLINE: '0' };
  assert.equal(Q.recallTurnText('typed words', 'stored words', off), 'stored words', 'the old order');
  assert.equal(Q.recallTurnText('typed words', '', off), 'typed words');
});

test("a greeting is recognised with the character's own name, whoever that is", () => {
  for (const [text, name] of [
    ['hey', 'Juniper'],
    ['Hello!', 'Juniper'],
    ['hi Juniper', 'Juniper'],
    ['hey, juniper!', 'Juniper'],
    ['good morning Juniper', 'Juniper Vale'],
    ['hello Juniper Vale', 'Juniper Vale'],
    ['hi', ''],
  ]) {
    assert.equal(Q.greetingShaped(text, name, ON), true, text);
  }
});

test('"ok", "lol", another name and longer sentences are not greetings', () => {
  for (const text of ['ok', 'lol', 'k', 'yes', 'thanks', 'hey Marlowe', 'hey can you help', 'hi there how are you', '']) {
    assert.equal(Q.greetingShaped(text, 'Juniper', ON), false, text);
    assert.equal(Q.shortGreeting(text, 'Juniper', ON), false, text);
  }
});

test('a name with regex characters in it cannot break or widen the test', () => {
  assert.equal(Q.greetingShaped('hey D.J. (the cat)', 'D.J. (the cat)', ON), true);
  assert.equal(Q.greetingShaped('hey DxJx', 'D.J.', ON), false);
  assert.equal(Q.greetingShaped('hey anything at all', '.*', ON), false);
});

test('only a greeting UNDER 12 characters takes the no-embed path', () => {
  assert.equal(Q.shortGreeting('hey', 'Juniper', ON), true);
  assert.equal(Q.shortGreeting('hi Juniper', 'Juniper', ON), true);
  assert.equal(Q.shortGreeting('good morning Juniper', 'Juniper', ON), false, '12 or more embeds as always');
});

test('KADE_RECALL_GREETING=0 puts the old test back and closes the short path', () => {
  const off = { KADE_RECALL_GREETING: '0' };
  assert.equal(Q.shortGreeting('hey', 'Juniper', off), false);
  assert.equal(Q.greetingShaped('hey Juniper', 'Juniper', off), false, 'the old test knew one name only');
  assert.equal(Q.greetingShaped('good morning', 'Juniper', off), true);
});
