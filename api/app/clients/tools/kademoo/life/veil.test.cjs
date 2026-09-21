const assert = require('node:assert/strict');
const { test } = require('node:test');
const veil = require('./veil');

/* THE VEIL. Kade's requirement is a negative one -- "nobody should ever be able
 * to tell whether the person behind the player is a synth or a soul" -- and a
 * negative is exactly the kind of thing that rots quietly. Each of these tests
 * guards one channel that WAS leaking before Sep 21 2026, so a later edit that
 * reopens it has to walk past a red test to do it. */

test('the wire cannot say which kind of person somebody is', () => {
  assert.equal(veil.publicKind('citizen'), 'person');
  assert.equal(veil.publicKind('player'), 'person');
  assert.equal(veil.publicKind('citizen'), veil.publicKind('player'));
  /* An animal is an animal and a child is a child. The client draws those
   * differently and nobody is pretending a cat is a soul. */
  for (const k of ['stray', 'pet', 'child']) assert.equal(veil.publicKind(k), k);
});

test('one grammar: the parenthesis cannot mean synth any more', () => {
  /* The old rule was `Name (doing)` for a citizen and a bare `Name` for an
   * active human, which made the most-read line in the game a perfect oracle. */
  assert.equal(veil.sameGrammar('Pat Harris', 'wiping the counter'), 'Pat Harris (wiping the counter)');
  assert.equal(veil.sameGrammar('Kade', 'wiping the counter'), 'Kade (wiping the counter)');
  assert.equal(veil.sameGrammar('Pat Harris', ''), 'Pat Harris');
  assert.equal(veil.sameGrammar('Kade', ''), 'Kade');
  /* A pose reads as an aside for anybody, same as it always did for a stray. */
  assert.equal(veil.sameGrammar('Merle', 'sitting on a crate', { pose: true }), 'Merle, sitting on a crate');
});

test('a soul gets a manner of their own, not everybody-is-warm', () => {
  const a = veil.temperOf('68ab12ff9c0011');
  assert.ok(veil.TEMPERS.includes(a), 'must be one of the four REACT banks');
  assert.equal(veil.temperOf('68ab12ff9c0011'), a, 'stable for the life of the character');
  /* An authored temperament always wins: the census is still the census. */
  assert.equal(veil.temperOf('npc:pat', 'gruff'), 'gruff');
  /* Spread: if humans clustered into one voice that would be its own tell. */
  const seen = {};
  for (let i = 0; i < 400; i++) {
    const t = veil.temperOf('player-' + i);
    seen[t] = (seen[t] || 0) + 1;
  }
  assert.equal(Object.keys(seen).length, 4, 'all four voices in use');
  for (const n of Object.values(seen)) assert.ok(n > 40, `lopsided spread: ${JSON.stringify(seen)}`);
});

test('the speaking verbs look for every person, and only skip animals', () => {
  const q = veil.speakableIn('pats_diner');
  assert.equal(q.roomId, 'pats_diner');
  const re = q.userId.$not;
  /* Before this, both verbs filtered `userId: /^npc:/`, so trying to talk to
   * somebody was a one-command synth test: a citizen answered and a human got
   * "choose somebody who is here" about a person standing in the room. */
  assert.ok(!re.test('npc:pat'), 'a citizen is speakable');
  assert.ok(!re.test('68ab12ff9c0011'), 'a human is speakable');
  for (const id of ['stray:gray', 'pet:rufus', 'kid:junie']) assert.ok(re.test(id), `${id} is not`);
});

test('speakableIn can leave the speaker out without narrowing who counts as a person', () => {
  const q = veil.speakableIn('pats_diner', 'me-123');
  assert.equal(q.userId.$ne, 'me-123');
  assert.ok(!q.userId.$not.test('npc:pat'));
  assert.ok(q.userId.$not.test('stray:gray'));
});

test('isPerson accepts the wire value too, or the reaction banks close again', () => {
  /* relationships.js asks this about `kind` from target(), which is the
   * internal value -- but view.js hands out the public one, and a later edit
   * that passes the public value through must not silently stop matching. */
  for (const k of ['citizen', 'player', 'person']) assert.equal(veil.isPerson(k), true, k);
  for (const k of ['stray', 'pet', 'child', undefined]) assert.equal(veil.isPerson(k), false, String(k));
});
