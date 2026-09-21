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

test('the seventh leak: every citizen has pronouns, so no citizen is "they" by default', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'reverie.js'), 'utf8');
  const ids = [...src.matchAll(/\n    id: '([a-z0-9_]+)', name: /g)].map((m) => m[1]);
  assert.ok(ids.length >= 26, `only found ${ids.length} citizens`);
  for (const id of ids) {
    assert.ok(veil.pronounsOf(id), `${id} has no pronouns, so the city calls them they/them while every player picks`);
    assert.strictEqual(veil.pronounsOf('npc:' + id), veil.pronounsOf(id), 'the npc: prefix changed the answer');
  }
  /* Read off the prose, not guessed off names: the descriptions say these. */
  assert.strictEqual(veil.pronounsOf('doc'), 'she');
  assert.strictEqual(veil.pronounsOf('boone'), 'he');
  /* And where the city has never said, it stays unsaid. */
  assert.strictEqual(veil.pronounsOf('marsh'), 'they');
  assert.strictEqual(veil.pronounsOf('cass'), 'they');
});

test('the pronoun table holds nobody who is not in the census', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'reverie.js'), 'utf8');
  const ids = new Set([...src.matchAll(/\n    id: '([a-z0-9_]+)', name: /g)].map((m) => m[1]));
  for (const id of Object.keys(veil.CITIZEN_PRONOUNS)) {
    assert.ok(ids.has(id), `${id} is in the pronoun table but not in the census`);
  }
});

test('the eighth leak: a stranger sees a look, not a biography', () => {
  const bio =
    'Nell runs the Gully Washhouse in a soft cardigan with the sleeves pushed up. ' +
    'She lives in its rear room at 12 Gully Road. ' +
    'Her sister lives outside the city. ' +
    'Nell likes repairing things before replacing them. ' +
    'She worries the washhouse will close.';
  const stranger = veil.visibleDesc(bio, 'strangers');
  const friend = veil.visibleDesc(bio, 'friends');
  assert.ok(stranger.length < bio.length, 'a stranger read the whole row');
  assert.ok(/cardigan/.test(stranger), 'a stranger could not see what she is wearing');
  assert.ok(!/sister/.test(stranger), 'a stranger knew where her sister lives');
  assert.strictEqual(friend, bio, 'a friend was held back');
  assert.ok(veil.visibleDesc(bio, 'acquaintances').length > stranger.length, 'knowing somebody bought nothing');
});

test('a one-line look is returned whole to anybody, so souls are unaffected', () => {
  const soul = 'Average build, dark hair cropped short, dressed in whatever was clean.';
  for (const tier of ['strangers', 'acquaintances', 'friends', 'feuding']) {
    assert.strictEqual(veil.visibleDesc(soul, tier), soul, tier);
  }
  assert.strictEqual(veil.visibleDesc('', 'strangers'), '');
  assert.strictEqual(veil.visibleDesc(undefined, 'strangers'), '');
});
