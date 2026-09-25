/* Part 292 (Sep 25 2026): the label sentences, the "Same X, different Y."
 * fragment and the "Here's the thing:" lead-in. Kade: "College essay crap."
 *
 * The rule for anything on the deletion list: the reply must still stand
 * after the cut. So every test asserts both halves: the empty label goes,
 * and ordinary speech that looks like it stays.
 *
 * Run: node --test api/server/utils/stripAiTells.labels.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { stripAiTells, createStreamScrubber } = require('./stripAiTells');

test('a label sentence standing on its own goes', () => {
  assert.strictEqual(
    stripAiTells('You buy the cheap printer and then pay for ink forever. That\'s the trap.'),
    'You buy the cheap printer and then pay for ink forever.',
  );
  assert.strictEqual(
    stripAiTells('The dedupe keeps one copy and points the rest at it. That\'s the whole design. Clever, too.'),
    'The dedupe keeps one copy and points the rest at it. Clever, too.',
  );
  assert.strictEqual(
    stripAiTells('Tabbies come in every color.\n\nThat’s the whole breed.'),
    'Tabbies come in every color.',
  );
  assert.strictEqual(
    stripAiTells('%%%dry%%% That\'s the loop. You wake up, check it, and start over.'),
    '%%%dry%%% You wake up, check it, and start over.',
  );
});

test('the "Same X, different Y." fragment goes', () => {
  assert.strictEqual(
    stripAiTells('One kid wanted it louder and one wanted it quieter. Same doll, opposite complaints.'),
    'One kid wanted it louder and one wanted it quieter.',
  );
});

test('the lead-in before a point goes and the point stands', () => {
  assert.strictEqual(stripAiTells("Here's the thing: it doesn't matter who paid."), "It doesn't matter who paid.");
  assert.strictEqual(stripAiTells('So here’s the thing — the kid at your school was right.'), 'So the kid at your school was right.');
  assert.strictEqual(stripAiTells("Here's my read: he was bluffing."), 'He was bluffing.');
  assert.strictEqual(
    stripAiTells("Okay, so the whole trick is this: a cassette stores the sound's shape as magnetism."),
    "Okay, a cassette stores the sound's shape as magnetism.",
  );
  assert.strictEqual(stripAiTells('The trick is this: salt the water first.'), 'Salt the water first.');
});

test('people talking are left alone', () => {
  for (const line of [
    "That's the one!",
    "That's the spirit!",
    'Is that the whole thing?',
    "That's the one with the red door.",
    "That's the trap they set for tourists, and we walked right into it.",
    "That's the whole reason I called you.",
    'Which one? That\'s the blue one.',
    'Same here, different day tomorrow though.',
    "Here's the thing I was telling you about, the lamp.",
    "Here's what I think we should do tonight.",
    "The kicker was the ending. I didn't see it coming.",
    'The trick is this one right here, the blue lever.',
    'The whole thing is this big, like a shoebox.',
  ]) {
    assert.strictEqual(stripAiTells(line), line, line);
  }
});

test('a reply that is only a label is kept (never scrub a message to nothing)', () => {
  assert.strictEqual(stripAiTells("That's the trap."), "That's the trap.");
});

test('the live stream never shows the label and never rewrites what it already sent', () => {
  const s = createStreamScrubber();
  const pieces = ['You buy the cheap printer', ' and pay for ink forever. ', "That's the ", 'trap. ', 'Just get a laser.'];
  let shown = '';
  for (const p of pieces) {
    for (const out of s.transform({ id: 'm1', delta: { content: p } })) {
      shown += out.delta.content;
    }
  }
  for (const out of s.flushId ? s.flushId('m1') : []) shown += out.delta.content;
  assert.ok(!/trap/.test(shown), 'label never streamed: ' + shown);
  assert.ok(shown.startsWith('You buy the cheap printer and pay for ink forever.'), shown);
});
