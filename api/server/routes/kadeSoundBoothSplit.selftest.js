'use strict';
/* Part 122 (Sep 3 2026). Her ask: "If files are too long, we need a thing that
 * cuts them off or something auto." These are the ways an automatic cut can go
 * wrong quietly -- a part that changes voice halfway, half an <action> read
 * aloud, a sentence sheared in the middle -- each of which costs a render to
 * discover by ear. Run: node --test kadeSoundBoothSplit.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { splitSpeakScript } = require('./kadeSoundBoothSplit');

const OPEN = '<speak voice="Warm, clear adult woman with a natural American accent. Unhurried and kind." gender="female" scene="a quiet kitchen at night" shot="wide" pace="1.5">';
const wrap = (b) => `${OPEN}\n${b}\n</speak>`;
const sentences = (n, word = 'The fox crossed the yard without a sound.') =>
  Array.from({ length: n }, (_, i) => `${word} Number ${i}.`).join(' ');

test('a script inside the cap comes back untouched, as one part', () => {
  const s = wrap('Just a short line.');
  const parts = splitSpeakScript(s, 4000);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], s);
});

test('every part carries the SAME speak attributes — or part two is a different person', () => {
  const parts = splitSpeakScript(wrap(sentences(400)), 1000);
  assert.ok(parts.length > 3, `expected several parts, got ${parts.length}`);
  for (const p of parts) {
    assert.ok(p.startsWith(OPEN), 'a part lost the opening tag');
    assert.ok(p.trim().endsWith('</speak>'), 'a part lost the closing tag');
    assert.match(p, /voice="Warm, clear adult woman/);
    assert.match(p, /gender="female"/);
    assert.match(p, /scene="a quiet kitchen at night"/);
    assert.match(p, /pace="1.5"/);
  }
});

test('no part exceeds the cap', () => {
  for (const cap of [600, 1000, 2048, 4000]) {
    const parts = splitSpeakScript(wrap(sentences(500)), cap);
    for (const p of parts) assert.ok(p.length <= cap, `part of ${p.length} over cap ${cap}`);
  }
});

test('an action block is never cut in half', () => {
  const body = [
    sentences(20),
    '<action>she sets the mug down very carefully, listening for the stairs</action>',
    sentences(20),
    '<sound>a floorboard settles somewhere above them</sound>',
    sentences(20),
  ].join('\n\n');
  const parts = splitSpeakScript(wrap(body), 700);
  const all = parts.join('\n');
  assert.match(all, /<action>she sets the mug down very carefully, listening for the stairs<\/action>/);
  assert.match(all, /<sound>a floorboard settles somewhere above them<\/sound>/);
  for (const p of parts) {
    const opens = (p.match(/<action>/g) || []).length;
    const closes = (p.match(/<\/action>/g) || []).length;
    assert.equal(opens, closes, 'an action tag was split across parts');
    assert.equal((p.match(/<sound>/g) || []).length, (p.match(/<\/sound>/g) || []).length);
  }
});

test('nothing is lost and nothing is duplicated', () => {
  const body = sentences(300);
  const parts = splitSpeakScript(wrap(body), 900);
  const strip = (t) => t.replace(/<speak\b[^>]*>/gi, ' ').replace(/<\/speak>/gi, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(strip(parts.join(' ')), strip(body));
});

test('it breaks between sentences, not mid-sentence, when it can', () => {
  const parts = splitSpeakScript(wrap(sentences(200)), 900);
  for (const p of parts) {
    const inner = p.replace(/<speak\b[^>]*>/i, '').replace(/<\/speak>/i, '').trim();
    assert.match(inner, /[.!?]["')\]]?$/, `part ended mid-sentence: ...${inner.slice(-40)}`);
  }
});

test('one sentence longer than the whole cap still gets through, at a word boundary', () => {
  const monster = 'word '.repeat(900).trim() + '.';
  const parts = splitSpeakScript(wrap(monster), 800);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 800);
  const inner = parts.map((p) => p.replace(/<speak\b[^>]*>/i, '').replace(/<\/speak>/i, '').trim()).join(' ');
  assert.equal(inner.replace(/\s+/g, ' '), monster);
  for (const p of parts) assert.doesNotMatch(p, /wo\s*$|\sord/, 'a word was cut in half');
});

test('a script with no speak wrapper (Seed Audio prose) still splits', () => {
  const parts = splitSpeakScript(sentences(300), 800);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 800);
    assert.doesNotMatch(p, /<speak/);
  }
});

test('empty and whitespace input do not explode', () => {
  assert.deepEqual(splitSpeakScript('', 4000), ['']);
  assert.deepEqual(splitSpeakScript('   ', 4000), ['']);
});
