const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReflectionBatch, parseReflection } = require('@librechat/api');

const window = { since: '2026-09-05T00:00:00.000Z', until: '2026-09-07T00:00:00.000Z' };
const turn = (messageId, conversationId, text, at = '2026-09-06T12:00:00.000Z') => ({
  messageId,
  conversationId,
  text,
  at,
  role: 'user',
});

test('a malformed reflection cannot publish private opinions as its summary', () => {
  assert.equal(
    parseReflection('MY TAKE:\nA private interpretation.\nCURIOUS ABOUT:\nA private question.'),
    null,
  );
  assert.equal(parseReflection('Preamble\nSUMMARY:\n\nMY TAKE:\nA private interpretation.'), null);
});

test('sections retain their scope; missing/empty fields preserve prior state and sentinels clear explicitly', () => {
  assert.deepEqual(
    parseReflection(
      'SUMMARY: Trip is planned.\nMY TAKE:\nI think it is worth it.\nCURIOUS ABOUT:\nNothing in particular.\nVERDICTS:\n',
    ),
    {
      summary: 'Trip is planned.',
      take: 'I think it is worth it.',
      curious: '',
    },
  );
  assert.equal(parseReflection('Unlabelled content of uncertain scope.'), null);
  assert.deepEqual(
    parseReflection('**SUMMARY:** A correction.\n**MY TAKE:** Changed on new evidence.'),
    {
      summary: 'A correction.',
      take: 'Changed on new evidence.',
    },
  );
});

test('reads both conversations in time order and carries source dates', () => {
  const batch = buildReflectionBatch({
    ...window,
    turns: [
      turn('b', 'evening', 'The trip was canceled.', '2026-09-06T20:00:00Z'),
      turn('a', 'morning', 'The trip is tomorrow.', '2026-09-06T08:00:00Z'),
    ],
  });
  assert.equal(batch.conversations, 2);
  assert.ok(batch.text.indexOf('morning') < batch.text.indexOf('evening'));
  assert.match(batch.text, /2026-09-06T08:00:00.000Z/);
  assert.equal(batch.cursor.pending, false);
});

test('bounded work resumes without dropping same-timestamp messages or paying twice', () => {
  const turns = ['c', 'a', 'b'].map((id) => turn(id, id, `Message ${id}`));
  const first = buildReflectionBatch({ ...window, turns, maxMessages: 2 });
  assert.equal(first.cursor.messageId, 'b');
  assert.equal(first.cursor.pending, true);
  const second = buildReflectionBatch({ ...window, turns, cursor: first.cursor });
  assert.equal(second.messages, 1);
  assert.match(second.text, /Message c/);
  assert.equal(buildReflectionBatch({ ...window, turns, cursor: second.cursor }), null);
});

test('invalid, duplicate and future turns do not poison the checkpoint', () => {
  const valid = turn('a', 'same', 'A real message.');
  const batch = buildReflectionBatch({
    ...window,
    turns: [
      valid,
      valid,
      turn('bad', 'same', 'Undated.', 'bad'),
      turn('future', 'same', 'Future.', '2099-01-01T00:00:00Z'),
    ],
  });
  assert.equal(batch.messages, 1);
  assert.equal(batch.cursor.messageId, 'a');
});

test('a large correction remains whole and later messages stay pending', () => {
  const text = 'Correction: ' + 'context '.repeat(300) + 'The appointment was canceled.';
  const batch = buildReflectionBatch({
    ...window,
    maxChars: 1000,
    turns: [turn('a', 'one', text), turn('b', 'two', 'A later message.')],
  });
  assert.ok(batch.text.endsWith('The appointment was canceled.'));
  assert.equal(batch.cursor.pending, true);
});
