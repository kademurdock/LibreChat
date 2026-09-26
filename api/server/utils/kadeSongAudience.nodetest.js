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

test('the kill switch KADE_SONG_EXPLICIT=0 withdraws only the grown-up permission; clean stays clean', async () => {
  const off = { KADE_SONG_EXPLICIT: '0' };
  assert.equal(await A.songAudience({ id: 'a', kadeAccountType: 'adult' }, { env: off, loadUser: noRead }), null, 'a grown-up gets no note');
  assert.equal(await A.songAudience({ id: 'k', role: 'ADMIN' }, { env: off, loadUser: noRead }), null, 'the admin too');
  /* Part 293 review: pulling the switch must never leave the child or the reviewer less protected. */
  assert.equal(await A.songAudience({ id: 'a', kadeAccountType: 'adult' }, { env: off, loadUser: noRead, band: 'kids' }), 'clean', 'the Kids style');
  assert.equal(await A.songAudience({ id: 'c', kadeAccountType: 'child' }, { env: off, loadUser: noRead }), 'clean', 'the child');
  assert.equal(await A.songAudience({ id: VISCHECK, kadeAccountType: 'adult' }, { env: off, loadUser: noRead }), 'clean', 'the App Review seat');
  assert.equal(await A.songAudience({ id: 'u', role: 'USER' }, { env: off, loadUser: async () => ({}) }), 'clean', 'an untyped account');
  assert.equal(await A.songAudience({ id: 'x', role: 'USER' }, { env: off, loadUser: async () => { throw new Error('db down'); } }), 'clean', 'a failed read');
  assert.equal(await A.songAudience(null, { env: off }), 'clean', 'no user');
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

test('Part 293 review: compound and starred swearing is caught, and famous innocents are not hidden', () => {
  const flagged = [
    'what a clusterfuck', 'total mindfuck', 'you dipshit', 'batshit crazy', 'horseshit', 'sonofabitch', 'the whorehouse on Route 5',
    'some asshat', 'lazy fatass', 'a kickass guitar', 'dickwad', 'Dickwad', 'nice titty', 'lardass', 'hardass boss', 'dumbass', 'jackass', 'half-assed',
    'what a dick', 'DICK MOVE',
    'f***', 's**t', 'a**hole', 'b**ch', 'sh!t', 'F*** Mondays', 'f***ing hell', 's**t happens', 'b***h', 'motherf***er', 'fck this', 'F*** This Job',
    'kick a$$!', 'f*ck', 'f*king around', 'd*mn it', 'c*ck', '$hit', 'sh!tty day',
  ];
  for (const text of flagged) assert.ok(A.hasExplicitWords(text), text);
  const innocent = [
    'Moby Dick', 'the Dick Clark countdown', 'a horny toad by the creek', 'the Sex Pistols', 'shiitake', 'shitake mushrooms', 'cocktail', 'Scunthorpe United',
    'in F# minor', 'C# major, 90 BPM', 'Panic! at the Disco', 'Ke$ha', 'A$AP', '*NSYNC', 'Wow!!', 'P!nk', 'Yes!!!', 'Mamma Mia!', 'bass guitar and brass', 'the grass is greener',
    'embarrassed', 'pussy willows by the pond', 'Pussy cat, pussy cat, where have you been', 'Hitchcock', 'a peacock', 'Dickens', 'a rating of *****', 'kade@example',
  ];
  for (const text of innocent) assert.ok(!A.hasExplicitWords(text), text);
});

test('Part 293 review: a clean draft\'s sung lines are read for swearing; the music direction and READBACK are not', () => {
  const draft = 'Punk about a shitty landlord.\nLyrics:\n[Verse 1]\nThis rent is batshit\nThe sink is broken\n(oh, f***)\nThis rent is batshit\n[Chorus]\nPay up\nREADBACK: A punk song about a bad landlord and some shit.';
  assert.deepEqual(A.explicitSungLines(draft).map((t) => t.line), ['This rent is batshit', '(oh, f***)']);
  assert.match(A.explicitSungLines(draft)[0].tell, /has to be clean/);
  assert.deepEqual(A.explicitSungLines('No lyrics heading here, shit.'), []);
  assert.deepEqual(A.explicitSungLines('x\nLyrics:\n[Verse 1]\nPay the rent\n'), []);
});

test('the wall hides explicit assets from everyone who is not a grown-up (the child, the review seat, the untyped), and fails closed for them', async () => {
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
  /* Part 293 review: the wall asks the desk's question, so an account nobody typed (a child whose
   * type was never set, a new sign-up) gets the quieter wall, as it gets the clean note. */
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => ({}) }), true, 'an untyped account: never assumed adult');
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => null }), true, 'no such account');
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => ({ kadeAccountType: 'adult' }) }), false, 'typed adult in the database');
  assert.equal(await A.wallViewerRestricted({ id: 'g', role: 'USER' }, { env, loadUser: async () => ({ kadeAccountType: 'child' }) }), true);
  assert.equal(await A.wallViewerRestricted({ id: 'x', role: 'USER' }, { env, loadUser: async () => { throw new Error('db down'); } }), true, 'a failed read is the quieter wall');
  assert.equal(await A.wallViewerRestricted(null, { env }), true);
  assert.equal(await A.wallViewerRestricted({ id: 'a', kadeAccountType: 'adult' }, { env: { KADE_SONG_EXPLICIT: '0' }, loadUser: noRead }), false, 'the kill switch is the desk\'s, not the wall\'s');
  for (const user of [{ id: 'a', kadeAccountType: 'adult' }, { id: 'c', kadeAccountType: 'child' }, { id: VISCHECK, kadeAccountType: 'adult' }, { id: 'g', role: 'USER' }])
    assert.equal(await A.wallViewerRestricted(user, { env, loadUser: async () => ({}) }), (await A.songAudience(user, { env, loadUser: async () => ({}) })) !== 'explicit', 'the desk and the wall agree');
});

test('Part 293 review: the wall reads every text an asset keeps, including the Lyria wire prompt, and skips links and ids', () => {
  /* A Lyria take made from "Your own lyrics" with "Keep the words it wrote" off: the words live only
   * in metadata.wirePrompt (kadeSoundBooth.js withLyricsBlock and the Lyria asset log). */
  const ownLyrics = { _id: 'w', description: 'Lyria song', prompt: 'Punk.', metadata: { via: 'sound-booth', title: 'Cold', lyrics: undefined, lyricsClean: undefined, wirePrompt: 'Punk.\n\nLyrics:\nThis shit is cold, motherfucker' } };
  const later = { _id: 'n', description: 'Song', metadata: { someNewField: { words: ['la la', 'fuck it'] } } };
  const links = { _id: 'l', description: 'Grandma\'s pie', metadata: { wavUrl: 'https://f.example/abShitX.wav', scoreKey: 'yue/FUCKx1.abc', projectId: 'dick123', jobId: 'yue_bitch', lyrics: 'Pass the pie', note: 'https://x.example/sex' } };
  assert.match(A.wallAssetText(ownLyrics), /This shit is cold/);
  assert.deepEqual(A.filterWallAssets([ownLyrics, later, links], true).map((d) => d._id), ['l']);
  assert.deepEqual(A.filterWallAssets([ownLyrics, later, links], false).map((d) => d._id), ['w', 'n', 'l']);
  assert.equal(A.wallAssetText({ description: 'a', metadata: { buf: new Uint8Array(3), when: new Date(0) } }), 'a', 'only plain text is read');
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

test('Part 293 review: the real GET /asset-download/:id gives a restricted viewer only what the wall would show them', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/kade.js'), 'utf8');
  const start = src.indexOf("router.get('/asset-download/:id'");
  const stop = src.lastIndexOf('/* ---', src.indexOf('SAVE BY URL', start));
  assert.ok(start > 0 && stop > start, 'kade.js still has the download route');
  const OWNER = '6a00000000000000000000aa';
  const rows = {
    explicit: { _id: 'explicit', user: OWNER, shared: true, kind: 'audio', url: 'https://f.example/e.mp3', description: 'Cold', metadata: { wirePrompt: 'Lyrics:\nThis shit is cold' } },
    clean: { _id: 'clean', user: OWNER, shared: true, kind: 'audio', url: 'https://f.example/c.mp3', description: 'Pie', metadata: { lyrics: 'Pass the pie' } },
    private: { _id: 'private', user: OWNER, shared: false, kind: 'audio', url: 'https://f.example/p.mp3', description: 'Mine' },
  };
  const handlers = new Map();
  const fetched = [];
  const context = {
    router: { get: (p, _auth, fn) => handlers.set(p, fn) },
    requireJwtAuth: null,
    KadeAsset: { findById: (id) => ({ lean: async () => rows[id] || null }) },
    freshAssetUrl: async (u) => u,
    axios: { get: async (u) => { fetched.push(u); return { headers: { 'content-type': 'audio/mpeg' }, data: { pipe: (res) => res.json({ streamed: u }) } }; } },
    logger: { warn() {}, error() {} },
    process: { env: {} },
    require: (name) => (name === '~/server/utils/kadeSongAudience' ? A : require(name)),
    Date,
    Promise,
  };
  vm.runInNewContext(src.slice(start, stop), context);
  const download = async (user, id) => {
    let code = 200, body;
    const res = { status(c) { code = c; return this; }, json(v) { body = v; return this; }, setHeader() {} };
    await handlers.get('/asset-download/:id')({ user, params: { id }, query: {} }, res);
    return { code, body };
  };
  const child = { id: 'c', kadeAccountType: 'child', role: 'USER' };
  const reviewer = { id: VISCHECK, kadeAccountType: 'adult', role: 'USER' };
  const adult = { id: 'a', kadeAccountType: 'adult', role: 'USER' };
  assert.equal((await download(child, 'explicit')).code, 404, 'the child cannot fetch it by id');
  assert.equal((await download(reviewer, 'explicit')).code, 404, 'nor can the App Review seat');
  assert.equal((await download(child, 'clean')).code, 200, 'a clean shared song still downloads for them');
  assert.equal((await download(adult, 'explicit')).code, 200, 'a grown-up downloads it as before');
  assert.equal((await download({ id: OWNER, role: 'USER' }, 'explicit')).code, 200, 'the owner always gets their own, typed or not');
  assert.equal((await download(adult, 'private')).code, 404, 'unshared stays private');
  assert.deepEqual(fetched, ['https://f.example/c.mp3', 'https://f.example/e.mp3', 'https://f.example/e.mp3']);
});
