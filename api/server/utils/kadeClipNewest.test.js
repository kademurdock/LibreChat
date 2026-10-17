const test = require('node:test');
const assert = require('node:assert');
const { clipKeepNewest } = require('./kadeClipNewest.js');

const list = (n, prefix = 'card') =>
  Array.from({ length: n }, (_, i) => `${i + 1}. [2026-10-${String(i + 1).padStart(2, '0')}]. ${prefix} number ${i + 1} with some words`).join('\n\n');

test('short text is untouched', () => {
  const text = list(3);
  assert.strictEqual(clipKeepNewest(text, 10000), text);
});

test('keeps the newest entries and drops the oldest', () => {
  const text = list(40);
  const out = clipKeepNewest(text, 600);
  assert.ok(out.length <= 600, `length ${out.length}`);
  assert.match(out, /card number 40 /);
  assert.doesNotMatch(out, /card number 1 /);
  assert.match(out, /older entries left out to fit/);
});

test('keeps section headers and trims the longest section first', () => {
  const text = `# What you generally know about the user\n${list(3, 'shared')}\n\n# What you specifically remember on your own\n${list(30, 'private')}`;
  const out = clipKeepNewest(text, 900);
  assert.ok(out.length <= 900);
  assert.match(out, /# What you generally know about the user/);
  assert.match(out, /# What you specifically remember on your own/);
  assert.match(out, /shared number 1 /, 'the short section keeps its oldest card');
  assert.match(out, /private number 30 /);
  assert.doesNotMatch(out, /private number 1 /);
});

test('a card with a blank line inside stays whole', () => {
  const text = `1. [d]. first\n\nsecond paragraph of the first card\n\n2. [d]. ${'x'.repeat(50)}\n\n3. [d]. newest`;
  const out = clipKeepNewest(text, 90, '(cut)');
  assert.doesNotMatch(out, /second paragraph/);
  assert.match(out, /newest/);
});

test('one giant entry keeps its end', () => {
  const text = `1. [d]. ${'a'.repeat(500)}END`;
  const out = clipKeepNewest(text, 100, '(cut)');
  assert.ok(out.length <= 100);
  assert.match(out, /END$/);
});
