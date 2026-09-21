/* The Sep 21 2026 additions to the scrubber, and the lines they must not touch.
 *
 * A deletion rule runs on every assistant message on the platform, so the only
 * safe kind is one where the sentence still stands after the cut. Each test
 * below asserts both halves: the tell goes, and ordinary speech that looks a
 * little like it stays.
 *
 * Run: node --test api/server/utils/stripAiTells.additions.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { stripAiTells } = require('./stripAiTells');

test('Certainly! goes, and the sentence after it stands', () => {
  assert.strictEqual(stripAiTells('Certainly! The bus leaves at six.'), 'The bus leaves at six.');
  assert.strictEqual(stripAiTells("I'd be happy to help with that: it opens at nine."), 'It opens at nine.');
});

test('the words people actually say are left alone', () => {
  for (const line of [
    'Of course she did. That is exactly her.',
    'Sure, go ahead.',
    'Certainly not, and you know it.',
    'I would be happy to see her again one of these days.',
  ]) {
    assert.strictEqual(stripAiTells(line), line, line);
  }
});

test('the essay connectives go', () => {
  assert.strictEqual(stripAiTells('In conclusion, it was the cat.'), 'It was the cat.');
  assert.strictEqual(stripAiTells("In today's world, everything is a subscription."), 'Everything is a subscription.');
  assert.strictEqual(stripAiTells('To sum up, she is fine.'), 'She is fine.');
});

test('the widened hope-this-helps closer goes, wherever it ends', () => {
  assert.strictEqual(stripAiTells('Two eggs and a pinch of salt. Hope this helps!'), 'Two eggs and a pinch of salt.');
  assert.strictEqual(stripAiTells('Two eggs. I hope that is helpful.'), 'Two eggs.');
  assert.strictEqual(stripAiTells('Two eggs. Hope this gives you a place to start.'), 'Two eggs.');
  /* Mid-message, it is a person talking and it stays. */
  const mid = 'Hope this helps, and tell me how the cake turns out.';
  assert.strictEqual(stripAiTells(mid), mid);
});

test('a scrub never empties a message and never touches code', () => {
  assert.strictEqual(stripAiTells('Certainly!'), 'Certainly!');
  const code = 'Try:\n```\nIn conclusion, print("hi")\n```';
  assert.ok(stripAiTells(code).includes('In conclusion, print("hi")'));
});
