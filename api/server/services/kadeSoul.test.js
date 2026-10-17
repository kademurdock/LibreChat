const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const S = require('./kadeSoul.js');
const { cue } = require('./kadeSoulVocabulary.js');

const NOW = new Date('2026-10-16T23:42:00Z'); // Friday 6:42 p.m. Central

test('server vocabulary reads directions exactly like the face module', async () => {
  const file = path.join(__dirname, '../../../client/src/components/Chat/character/avatar-expression.mjs');
  const client = (await import(pathToFileURL(file).href)).default;
  const corpus = [
    'dry', 'warm', 'flat and hot like I am mad on her behalf', 'flat and clipped with no patience left',
    'dry a little raspy', 'laugh', 'soft laugh', 'sigh', 'warm but not letting it slide', 'not amused',
    'soft, worried', 'excited, tripping over yourself', 'teasing', 'gentle concern', 'tired and hoarse',
    'curious, leaning in', 'smug', 'whispering', 'reset', 'clears throat', 'stunned', 'deadpan', 'heavy-hearted',
  ];
  for (const tag of corpus) {
    assert.deepStrictEqual(cue(tag), client.cue(tag), tag);
  }
});

test('a reply with no directions has no feeling', () => {
  assert.strictEqual(S.replyFeeling('Just plain words.'), null);
});

test('a reply reads its directions, weighting the last one', () => {
  const f = S.replyFeeling('%%%soft, worried%%% That sounds hard. %%%sad%%% I am sorry.');
  assert.ok(f.v < -0.3, `valence ${f.v}`);
  assert.deepStrictEqual(f.top, ['sad', 'concerned']);
  const g = S.replyFeeling('%%%laughing%%% Oh no. %%%playful%%% You did not.');
  assert.ok(g.v > 0.5);
});

test('a heavy mood fades slower than a good one', () => {
  const base = { v: 0.2, a: 0.4 };
  const heavy = { v: -0.4, a: 0.3, at: new Date(NOW.getTime() - 24 * 3.6e6) };
  const good = { v: 0.8, a: 0.5, at: new Date(NOW.getTime() - 24 * 3.6e6) };
  const dh = S.deviationNow(heavy, base, NOW);
  const dg = S.deviationNow(good, base, NOW);
  assert.ok(Math.abs(dh.dv) / 0.6 > Math.abs(dg.dv) / 0.6, 'heavy keeps more of itself after a day');
  assert.ok(S.moodWords(dh.dv, dh.da).includes('heavy') || S.moodWords(dh.dv, dh.da).includes('tender'));
});

test('the character\'s own usual register is never a mood', () => {
  const base = { v: 0.05, a: 0.3 }; // a dry character
  const mood = { v: 0.05, a: 0.3, at: NOW };
  const d = S.deviationNow(mood, base, NOW);
  assert.strictEqual(S.moodWords(d.dv, d.da), '');
});

test('blending fades the old mood before adding the new reply', () => {
  const base = { v: 0.2, a: 0.4 };
  const m = S.blendMood({ v: -0.6, a: 0.3, at: new Date(NOW.getTime() - 200 * 3.6e6) }, base, { v: 0.6, a: 0.4, top: ['warm'] }, NOW);
  assert.ok(m.v > 0.3, 'an old heavy mood long faded does not drag a warm reply down');
  assert.deepStrictEqual(m.top, ['warm']);
});

test('the base leans on the default until a character has history', () => {
  assert.deepStrictEqual(S.baseOf(null), { v: 0.2, a: 0.4 });
  const b = S.baseOf({ v: 0.0, a: 0.3, n: 30 });
  assert.strictEqual(Math.round(b.v * 100), 0);
});

test('time of day where they are', () => {
  assert.strictEqual(S.nowLine(NOW, 'America/Chicago'), "It's Friday evening, 6:42 p.m., where they are.");
  assert.match(S.nowLine(new Date('2026-10-17T07:10:00Z'), 'America/Chicago'), /2:10 a\.m\..*middle of the night/);
  assert.match(S.nowLine(NOW, 'America/Los_Angeles'), /Friday afternoon, 4:42 p\.m\./);
});

test('how long since they last talked', () => {
  const tz = 'America/Chicago';
  assert.strictEqual(S.sinceWords(new Date(NOW.getTime() - 35 * 60000), NOW, tz), 'about 35 minutes ago');
  assert.strictEqual(S.sinceWords(new Date('2026-10-16T19:30:00Z'), NOW, tz), 'about 4 hours ago, this afternoon');
  assert.strictEqual(S.sinceWords(new Date('2026-10-15T23:00:00Z'), NOW, tz), 'yesterday evening');
  assert.strictEqual(S.sinceWords(new Date('2026-10-12T23:00:00Z'), NOW, tz), '4 days ago (Monday evening)');
  assert.strictEqual(S.sinceWords(new Date('2026-08-16T23:00:00Z'), NOW, tz), 'about 2 months ago');
});

test('a moment must really be in the conversation', () => {
  const ev = 'User: you are such a gremlin, honestly a little goblin of chaos\nAssistant: guilty';
  assert.ok(S.quoteInEvidence('a little goblin of chaos', ev));
  assert.ok(S.quoteInEvidence('“A little goblin of chaos!”', ev));
  assert.ok(!S.quoteInEvidence('you are my favorite person', ev));
  assert.ok(!S.quoteInEvidence('chaos', ev), 'one word is not a moment');
});

test('picking moments: standing bits first, nothing used lately, related ones by what they said', () => {
  const day = 86400000;
  const m = (id, quote, kind, ageDays, usedDaysAgo) => ({
    _id: id, quote, kind, why: '', createdAt: new Date(NOW - ageDays * day),
    lastUsedAt: usedDaysAgo == null ? null : new Date(NOW - usedDaysAgo * day),
  });
  const pile = [
    m('a', 'goblin of chaos', 'nickname', 10),
    m('b', 'the casserole incident', 'joke', 5, 1),
    m('c', 'I finally passed my driving test', 'milestone', 30),
    m('d', 'my tomatoes are taking over the porch', 'line', 3),
  ];
  const picked = S.pickMoments(pile, 'the tomatoes went wild again on the porch', NOW).map((x) => x._id);
  assert.deepStrictEqual(picked, ['a', 'd']);
  assert.ok(!picked.includes('b'), 'used yesterday, rests');
});
