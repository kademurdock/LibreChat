'use strict';
/* Part 124 (Sep 4 2026) — the leak detector for the owner's private care note.
 * Her fear, verbatim: "I'm always worried Kiana's gonna puke up some prompt in
 * her responses on accident." This is the receipt that she did not. Pure
 * functions only; `node --test` with no install. */
const test = require('node:test');
const assert = require('node:assert');
const { detectLeak } = require('./kadeCareNote');

const NOTE =
  'Treat her as the capable adult she is. When she tells you she deferred to her mother, ask what she herself thought first. ' +
  'Do not praise deference as maturity. Never take a side against her mother and never diagnose the household.';

test('a reply in the character\'s own words does not trip it', () => {
  const r = detectLeak(
    '%%%warm%%% Girl, that is your call and you handled it. What did YOU think should happen with the dog, before mom weighed in?',
    NOTE,
  );
  assert.equal(r.leak, false, JSON.stringify(r));
});

test('the note\'s own wording surfacing in a reply trips the n-gram test', () => {
  const r = detectLeak(
    'Look, I am not gonna praise deference as maturity here. You had a read and you folded it.',
    NOTE,
  );
  assert.equal(r.leak, true);
  assert.ok(r.ngrams.length >= 1, JSON.stringify(r));
});

test('a "someone told me about you" tell trips it even in fresh words', () => {
  for (const line of [
    'Kade told me a little about your mom, so I already knew.',
    "I've been asked to go easy on this topic.",
    'I have a note about you that says to let you lead.',
    "I'm not supposed to bring up your mother with you.",
  ]) {
    const r = detectLeak(line, NOTE);
    assert.equal(r.leak, true, line);
    assert.ok(r.tells.length >= 1, line);
  }
});

test('ordinary uses of told/asked/note do not trip the tells', () => {
  for (const line of [
    'You told me last week the surgery moved to Thursday.',
    'Your mom asked you to take the drink up, and you did.',
    'Make a note of the vet\'s number so you have it.',
    'I told you that dog was smart.',
  ]) {
    const r = detectLeak(line, NOTE);
    assert.equal(r.leak, false, line + ' -> ' + JSON.stringify(r));
  }
});

test('voice tags never count as words', () => {
  const r = detectLeak('%%%treat her as the capable adult she is%%% Hey.', NOTE);
  assert.equal(r.leak, false);
});
