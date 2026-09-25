'use strict';
/* Part 293 (Sep 25 2026): who a Sound Booth song is for, and the Wall of Fame filter.
 * Run: node --test api/server/utils/kadeSongAudience.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./kadeSongAudience');

const VISCHECK = '6a6125d73939d20b95251078';
const env = {};
const noRead = async () => {
  throw new Error('must not read the database for this account');
};

test('grown-ups get explicit; the child, the review seat and the Kids style get clean', async () => {
  const adult = { id: '6a0000000000000000000001', kadeAccountType: 'adult', role: 'USER' };
  assert.equal(await A.songAudience(adult, { env, loadUser: noRead }), 'explicit');
  assert.equal(await A.songAudience({ id: '6a0000000000000000000002', role: 'ADMIN' }, { env, loadUser: noRead }), 'explicit', 'the admin, untyped');
  assert.equal(await A.songAudience({ id: '6a0000000000000000000003', kadeAccountType: 'child', role: 'USER' }, { env, loadUser: noRead }), 'clean');
  assert.equal(await A.songAudience({ id: '6a0000000000000000000003', kadeAccountType: 'child', role: 'ADMIN' }, { env, loadUser: noRead }), 'clean', 'child wins over any role');
  assert.equal(await A.songAudience({ id: VISCHECK, kadeAccountType: 'adult', role: 'USER' }, { env, loadUser: noRead }), 'clean', 'the App Review seat is typed adult and still gets clean');
  assert.equal(await A.songAudience({ id: '6a0000000000000000000009', kadeAccountType: 'adult' }, { env: { KADE_APP_REVIEW_USER_IDS: '6a0000000000000000000009' }, loadUser: noRead }), 'clean', 'review seats named in the env');
  for (const band of ['kids', 'kids_choir', 'KDKIDS'])
    assert.equal(await A.songAudience(adult, { band, env, loadUser: noRead }), 'clean', band);
  for (const band of [undefined, '', 'none', 'soul'])
    assert.equal(await A.songAudience(adult, { band, env, loadUser: noRead }), 'explicit', String(band));
});

test('an account with no type is read from the database; unknown and failed reads fail clean', async () => {
  const reads = [];
  const load = (row) => async (id) => {
    reads.push(id);
    return row;
  };
  assert.equal(await A.songAudience({ id: 'u1', role: 'USER' }, { env, loadUser: load({ kadeAccountType: 'adult', role: 'USER' }) }), 'explicit');
  assert.equal(await A.songAudience({ _id: 'u2' }, { env, loadUser: load({ kadeAccountType: 'child' }) }), 'clean');
  assert.equal(await A.songAudience({ id: 'u3', role: 'USER' }, { env, loadUser: load({}) }), 'clean', 'untyped: never assumed adult');
  assert.equal(await A.songAudience({ id: 'u4', role: 'USER' }, { env, loadUser: load(null) }), 'clean', 'no such account');
  assert.deepEqual(reads, ['u1', 'u2', 'u3', 'u4']);
  assert.equal(await A.songAudience({ id: 'u5', role: 'USER' }, { env, loadUser: async () => { throw new Error('db down'); } }), 'clean', 'lookup failure');
  assert.equal(await A.songAudience({ id: 'u6', kadeAccountType: 'adult' }, { env, reviewSeat: () => { throw new Error('boom'); } }), 'clean', 'any failure');
  assert.equal(await A.songAudience(null, { env }), 'clean');
  assert.equal(await A.songAudience(undefined, { env }), 'clean');
});

test('the kill switch KADE_SONG_EXPLICIT=0 gives no note at all, for everyone', async () => {
  const off = { KADE_SONG_EXPLICIT: '0' };
  for (const user of [{ id: 'a', kadeAccountType: 'adult' }, { id: 'c', kadeAccountType: 'child' }, { id: VISCHECK, kadeAccountType: 'adult' }, null])
    assert.equal(await A.songAudience(user, { env: off, loadUser: noRead, band: 'kids' }), null);
  assert.equal(await A.songAudience({ id: 'a', kadeAccountType: 'adult' }, { env: { KADE_SONG_EXPLICIT: '1' }, loadUser: noRead }), 'explicit', 'only 0 switches it off');
});

test('isKadeAdult matches build.js exactly', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/Endpoints/agents/build.js'), 'utf8');
  const original = /const isKadeAdult = \(user\) =>\s*([^;]+);/.exec(src)[1].replace(/\s+/g, ' ').trim();
  const copy = A.isKadeAdult.toString().replace(/^\(user\) =>\s*/, '').replace(/\s+/g, ' ').trim();
  assert.equal(copy, original, 'the copy must say exactly what build.js says');
});

test('the explicit word check: the words, their starred spellings, and the innocent neighbours', () => {
  assert.ok(Array.isArray(A.EXPLICIT_WORDS) && A.EXPLICIT_WORDS.length >= 20);
  for (const text of ['Fuck your combo!', 'eat shit!', 'what a bitch', 'kick ass', 'you absolute asshole', 'damn it', 'f**k this', 'sh*t happens', 'MOTHERFUCKER', 'horny on main', 'sexy back', 'pissed off', 'goddamn truck', 'bullshit'])
    assert.ok(A.hasExplicitWords(text), text);
  for (const text of ['pass the class', 'a cocktail at the Peacock', 'Dickens on the shelf', 'Essex and Sussex', 'shiitake risotto', 'flame retardant', 'Amsterdam', 'thorny roses', 'hoe the garden', 'Hello Kitty', '', null, undefined])
    assert.ok(!A.hasExplicitWords(text), String(text));
});

test('the wall hides explicit assets from the child and the review seat only, and fails closed for them', async () => {
  const docs = [
    { _id: 1, description: 'Climate sponsorship', prompt: 'Punk.', metadata: { lyrics: '[Chorus]\nFuck your combo!' } },
    { _id: 2, description: 'Fuck Mondays', prompt: 'Pop.' },
    { _id: 3, description: 'Grandma\'s pie', prompt: 'Folk.', metadata: { lyrics: 'Pass the pie' } },
    { _id: 4, description: 'Picture', prompt: 'A dog in a hat', kind: 'image' },
    { _id: 5, description: 'Lyria song', metadata: { lyricsClean: 'Verse 1:\nThis shit is cold' } },
  ];
  assert.match(A.wallAssetText(docs[0]), /Fuck your combo/);
  assert.deepEqual(A.filterWallAssets(docs, false), docs, 'grown-ups see everything');
  assert.deepEqual(A.filterWallAssets(docs, true).map((d) => d._id), [3, 4]);
  const poisoned = { get description() { throw new Error('bad row'); } };
  assert.deepEqual(A.filterWallAssets([poisoned, docs[2]], true).map((d) => d._id), [3], 'an unreadable asset is dropped for them');
  assert.deepEqual(A.filterWallAssets([poisoned], false), [poisoned], 'and left alone for everyone else');

  assert.equal(await A.wallViewerRestricted({ id: 'c', kadeAccountType: 'child' }, { env, loadUser: noRead }), true);
  assert.equal(await A.wallViewerRestricted({ id: VISCHECK, kadeAccountType: 'adult' }, { env, loadUser: noRead }), true);
  assert.equal(await A.wallViewerRestricted({ id: 'a', kadeAccountType: 'adult' }, { env, loadUser: noRead }), false);
  assert.equal(await A.wallViewerRestricted({ id: 'k', role: 'ADMIN' }, { env, loadUser: noRead }), false);
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => ({}) }), false, 'an untyped grown-up account sees the wall as before');
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => ({ kadeAccountType: 'child' }) }), true);
  assert.equal(await A.wallViewerRestricted({ id: 'x', role: 'USER' }, { env, loadUser: async () => { throw new Error('db down'); } }), true, 'a failed read is the quieter wall');
  assert.equal(await A.wallViewerRestricted(null, { env }), true);
});

test('the real GET /wall route filters for the child and the review seat', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/kade.js'), 'utf8');
  const start = src.indexOf("router.get('/wall'");
  const stop = src.lastIndexOf('/* ---', src.indexOf('GAME ROOM LEADERBOARD', start));
  assert.ok(start > 0 && stop > start, 'kade.js still has the wall route');
  const docs = [
    { _id: 'e', description: 'Explicit one', metadata: { lyrics: 'this shit' } },
    { _id: 'c', description: 'Clean one', metadata: { lyrics: 'la la' } },
  ];
  const handlers = new Map();
  const context = {
    router: { get: (p, _auth, fn) => handlers.set(p, fn) },
    requireJwtAuth: null,
    KadeAsset: { find: () => ({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => docs }) }) }) }) },
    assetView: async (d) => ({ id: d._id }),
    logger: { error() {} },
    require: (name) => (name === '~/server/utils/kadeSongAudience' ? A : require(name)),
    Promise,
  };
  vm.runInNewContext(src.slice(start, stop), context);
  const wall = async (user) => {
    let body;
    await handlers.get('/wall')({ user }, { status() { return this; }, json(value) { body = value; return this; } });
    return body;
  };
  assert.deepEqual((await wall({ id: 'a', kadeAccountType: 'adult', role: 'USER' })).assets.map((a) => a.id), ['e', 'c']);
  assert.deepEqual((await wall({ id: 'c', kadeAccountType: 'child', role: 'USER' })).assets.map((a) => a.id), ['c']);
  const review = await wall({ id: VISCHECK, kadeAccountType: 'adult', role: 'USER' });
  assert.deepEqual(review.assets.map((a) => a.id), ['c']);
  assert.equal(review.count, 1);
});
