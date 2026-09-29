const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const supertest = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('../../dev/community-load.cjs');
const { createCommunityModels } = require('../../packages/data-schemas/src/models/community.ts');
const { createCommunityRouter } = require('../../packages/api/src/community/router.ts');
let mongo, db, app, books, playback, releases, ids;
const signed = [];
const people = {
  host: { id: new mongoose.Types.ObjectId().toString(), name: 'Kade', role: 'ADMIN' },
  guest: { id: new mongoose.Types.ObjectId().toString(), name: 'Friend', kadeLibraryAccess: 'family' },
  child: { id: new mongoose.Types.ObjectId().toString(), name: 'Child', kadeLibraryAccess: 'family', child: true },
  outsider: { id: new mongoose.Types.ObjectId().toString(), name: 'Outside', kadeLibraryAccess: 'none' },
};
const api = (user = 'host', room = 'room-a') => ({
  get: url => supertest(app).get(url).set('Authorization', user).set('X-Clubhouse-Token', room),
  post: (url, body) => supertest(app).post(url).set('Authorization', user).set('X-Clubhouse-Token', room).send(body),
  delete: url => supertest(app).delete(url).set('Authorization', user).set('X-Clubhouse-Token', room),
});
const endpoint = '/api/community/playback';
before(async () => {
  mongo = await MongoMemoryServer.create();
  db = new mongoose.Mongoose(); await db.connect(mongo.getUri());
  ({ playback, releases } = createCommunityModels(db));
  books = db.model('TestMediaBook', new mongoose.Schema({ title: String, owner: mongoose.Schema.Types.ObjectId, shared: Boolean, grownUpsOnly: Boolean, state: String, kind: String, tracks: [{ key: String, title: String, mime: String, seconds: Number, clipBegin: Number, clipEnd: Number }] }));
  ids = {};
  for (const [name, values] of Object.entries({ movie: { shared: true }, private: { shared: false }, adult: { shared: true, grownUpsOnly: true } })) {
    const book = await books.create({ title: name + ' <script>alert(1)</script>', owner: people.host.id, state: 'ready', kind: 'video', tracks: [{ key: name + '.mp4', title: 'Full movie', mime: 'video/mp4', seconds: 7200 }], ...values });
    ids[name] = String(book._id);
  }
  app = express(); app.use(createCommunityRouter({
    auth: (req, res, next) => { req.actor = people[req.get('Authorization')]; if (!req.actor) return res.sendStatus(401); next(); },
    actor: req => req.actor,
    child: async req => !!req.actor.child,
    room: req => ['room-a', 'room-b'].includes(req.get('X-Clubhouse-Token')) ? req.get('X-Clubhouse-Token') : null,
    openBook: async (req, id) => { const book = await books.findById(id).lean(); if (!book || (req.actor.role !== 'ADMIN' && (!book.shared || req.actor.kadeLibraryAccess !== 'family' || (req.actor.child && book.grownUpsOnly)))) return null; return book; },
    sign: async (key, mime, seconds, downloadName) => { signed.push({ key, mime, seconds, downloadName }); return 'https://media.example/' + key; },
    books, playback, releases, log: message => { throw new Error(message); },
  }));
});
after(async () => { if (db) await db.disconnect(); if (mongo) await mongo.stop(); });

test('public homepage is readable without login and publishes no family metadata', async () => {
  const response = await supertest(app).get('/');
  assert.equal(response.status, 200); assert.match(response.text, /Press play/);
  assert.doesNotMatch(response.text, /movie|adult|private|alert\(1\)/);
});
test('playback requires login and room authorization', async () => {
  assert.equal((await supertest(app).get(endpoint)).status, 401);
  assert.equal((await api('host', 'fake').get(endpoint)).status, 403);
});
test('outsiders cannot search the shared catalog; child filtering applies', async () => {
  assert.deepEqual((await api('outsider').get('/api/community/library')).body.items, []);
  const items = (await api('child').get('/api/community/library')).body.items;
  assert.equal(items.length, 1); assert.equal(items[0].id, ids.movie);
});
test('private media cannot be loaded into a room even by its owner', async () => {
  const response = await api().post(endpoint, { action: 'load', revision: 0, book: ids.private, track: 0 });
  assert.equal(response.status, 404); assert.equal(await playback.countDocuments(), 0);
});
test('load starts paused with no whole-file transfer; room state is isolated', async () => {
  assert.equal((await api().post(endpoint, { action: 'load', revision: 0, book: ids.movie, track: 0 })).status, 200);
  const state = (await api().get(endpoint + '?url=1')).body;
  assert.equal(state.active, true); assert.equal(state.playing, false); assert.equal(state.position, 0);
  assert.equal(state.url, 'https://media.example/movie.mp4'); assert.equal(state.controlling, true);
  assert.equal((await api('guest', 'room-b').get(endpoint)).body.active, false);
});
test('outsider does not learn current media title, book id, host or stream', async () => {
  const result = (await api('outsider').get(endpoint + '?url=1')).body;
  assert.equal(result.unavailable, true); assert.equal(result.title, undefined); assert.equal(result.book, undefined); assert.equal(result.url, undefined); assert.equal(result.hostName, undefined);
});
test('guest can listen but cannot seek, replace, stop or steal a live host', async () => {
  assert.equal((await api('guest').get(endpoint)).body.controlling, false);
  for (const action of ['seek', 'load', 'stop', 'take-control']) assert.equal((await api('guest').post(endpoint, { action, revision: 1, book: ids.movie, track: 0, position: 90 })).status, 403);
});
test('host controls shared time and late joiners catch up', async () => {
  assert.equal((await api().post(endpoint, { action: 'seek', revision: 1, position: 120 })).status, 200);
  assert.equal((await api().post(endpoint, { action: 'play', revision: 2 })).status, 200);
  await playback.updateOne({ _id: 'room-a' }, { $inc: { changedAt: -10000 } });
  const result = (await api('guest').get(endpoint)).body;
  assert.ok(result.position >= 130 && result.position < 132); assert.equal(result.playing, true);
  assert.equal((await api().post(endpoint, { action: 'pause', revision: 3 })).status, 200);
  const paused = (await api('guest').get(endpoint)).body;
  assert.equal(paused.playing, false); assert.ok(paused.position >= 130);
});
test('stale controls and simultaneous writers cannot overwrite the room', async () => {
  assert.equal((await api().post(endpoint, { action: 'play', revision: 1 })).status, 409);
  const responses = await Promise.all([50, 60].map(position => api().post(endpoint, { action: 'seek', position, revision: 4 })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
});
test('invalid track and seek positions are refused without changing state', async () => {
  for (const position of [-1, 7201, '20']) assert.equal((await api().post(endpoint, { action: 'seek', revision: 5, position })).status, 400);
  assert.equal((await api().post(endpoint, { action: 'load', revision: 5, book: ids.movie, track: 999 })).status, 404);
  assert.equal((await api().get(endpoint)).body.revision, 5);
});
test('a lost host can be replaced; taking control pauses instead of jumping', async () => {
  await playback.updateOne({ _id: 'room-a' }, { $set: { heartbeat: Date.now() - 30000 } });
  assert.equal((await api('guest').get(endpoint)).body.canTakeControl, true);
  assert.equal((await api('guest').post(endpoint, { action: 'take-control', revision: 5 })).status, 200);
  const result = (await api('guest').get(endpoint)).body;
  assert.equal(result.controlling, true); assert.equal(result.playing, false);
});
test('revoked access and changed files cannot keep issuing playback links', async () => {
  people.guest.kadeLibraryAccess = 'none';
  assert.equal((await api('guest').get(endpoint + '?url=1')).body.url, undefined);
  people.guest.kadeLibraryAccess = 'family';
  await books.updateOne({ _id: ids.movie }, { $set: { 'tracks.0.key': 'replacement.mp4' } });
  assert.equal((await api('guest').get(endpoint + '?url=1')).body.active, false);
  await books.updateOne({ _id: ids.movie }, { $set: { 'tracks.0.key': 'movie.mp4' } });
});
test('publishing requires owner and explicit confirmation', async () => {
  const body = { book: ids.movie, track: 0, title: 'My release', description: 'A described story.' };
  assert.equal((await api('guest').post('/api/community/releases', { ...body, confirmPublic: true })).status, 403);
  assert.equal((await api().post('/api/community/releases', body)).status, 400);
  assert.equal(await releases.countDocuments(), 0);
});
test('published release has its own public page, escapes text, and can be taken down', async () => {
  const response = await api().post('/api/community/releases', { book: ids.movie, track: 0, title: 'A <script>release</script>', description: '<img onerror=alert(1)>', confirmPublic: true });
  assert.equal(response.status, 201);
  const url = response.body.url;
  const page = await supertest(app).get(url);
  assert.equal(page.status, 200); assert.match(page.text, /&lt;script&gt;release/); assert.doesNotMatch(page.text, /<img onerror/);
  const slug = url.split('/').pop();
  assert.doesNotMatch(page.text, /<(video|audio)[^>]*\bsrc=/);
  assert.match(page.text, /Sign in to play or download/);
  assert.match(page.text, /href="\/request-access"/);
  for (const kind of ['stream', 'download']) {
    const endpoint = '/api/community/releases/' + slug + '/' + kind;
    assert.equal((await supertest(app).get(endpoint)).status, 401);
    const response = await api('outsider').get(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.body.url, 'https://media.example/movie.mp4');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(signed.at(-1).downloadName, slug + '.mp4');
  assert.equal(signed.at(-1).seconds, 3600);
  assert.deepEqual((await api('outsider').get('/api/community/library')).body.items, []);
  assert.equal((await api('outsider').get('/api/community/tracks/' + ids.movie)).status, 404);
  assert.equal((await api().delete('/api/community/releases/' + slug)).status, 200);
  assert.equal((await supertest(app).get(url)).status, 404);
  assert.equal((await api('outsider').get('/api/community/releases/' + slug + '/stream')).status, 404);
});

test('donations and the screened account request are visible without signing in', async () => {
  for (const path of ['/', '/support', '/watch']) {
    const response = await supertest(app).get(path);
    assert.equal(response.status, 200);
    assert.match(response.text, /href="\/support"/);
    assert.match(response.text, /href="\/request-access"/);
  }
  const response = await supertest(app).get('/support');
  assert.match(response.text, /https:\/\/cash.app\/\$kademurdock/);
  assert.match(response.text, /https:\/\/paypal.me\/kademurdock/);
  assert.match(response.text, /mailto:kademurdock@gmail.com/);
  assert.match(response.text, /Donations are optional/);
  assert.match(response.text, /I’m totally blind/);
});

test('only explicit releases bypass family membership and child restrictions still apply', async () => {
  assert.equal((await api('outsider').get('/api/community/releases/unpublished/stream')).status, 404);
  const response = await api().post('/api/community/releases', { book: ids.adult, track: 0, title: 'An adult release', confirmPublic: true });
  const slug = response.body.url.split('/').pop();
  assert.equal((await api('child').get('/api/community/releases/' + slug + '/stream')).status, 404);
  assert.equal((await api('child').get('/api/community/releases/' + slug + '/download')).status, 404);
  assert.equal((await api('outsider').get('/api/community/releases/' + slug + '/stream')).status, 200);
  await books.updateOne({ _id: ids.adult }, { $set: { 'tracks.0.key': 'changed.mp4' } });
  assert.equal((await api('outsider').get('/api/community/releases/' + slug + '/stream')).status, 404);
});
