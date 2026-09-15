const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { KadeAsset } = require('../../models/kadeAsset');

test('archive is reversible, owner-scoped, and preserves files and sharing; WAV download is authorized', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  let user = owner;
  const app = express(); app.use(express.json());
  app.get('/fixture.wav', (_req, res) => res.type('audio/wav').send('WAV fixture'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
  const source = fs.readFileSync(__dirname + '/kade.js', 'utf8');
  const context = { router: app, mongoose, KadeAsset, axios, process, logger: console,
    freshAssetUrl: async (url) => url,
    requireJwtAuth: (req, _res, next) => { req.user = { id: String(user) }; next(); } };
  for (const name of ["router.post('/my-assets/:id/archive'", "router.get('/asset-download/:id'"]) {
    const start = source.indexOf(name); const end = source.indexOf('\n});', start) + 4;
    vm.runInNewContext(source.slice(start, end), context);
  }
  const row = await KadeAsset.create({ user: owner, kind: 'audio', shared: false,
    url: base + '/original.mp3', metadata: { wavUrl: base + '/fixture.wav' } });
  const archive = (value) => fetch(base + '/my-assets/' + row.id + '/archive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: value }) });
  assert.equal((await archive(true)).status, 200);
  let stored = await KadeAsset.findById(row.id).lean();
  assert.equal(stored.archived, true); assert.equal(stored.url, row.url); assert.equal(stored.shared, false);
  assert.equal((await archive(false)).status, 200);
  assert.equal((await KadeAsset.findById(row.id)).archived, false);
  assert.equal((await archive('true')).status, 400);
  user = other;
  assert.equal((await archive(true)).status, 404);
  assert.equal((await fetch(base + '/asset-download/' + row.id + '?master=1')).status, 404);
  user = owner;
  const wav = await fetch(base + '/asset-download/' + row.id + '?master=1');
  assert.equal(wav.status, 200); assert.match(wav.headers.get('content-disposition'), /\.wav/);
  assert.equal(await wav.text(), 'WAV fixture');
  await KadeAsset.updateOne({ _id: row.id }, { $unset: { 'metadata.wavUrl': '' } });
  assert.equal((await fetch(base + '/asset-download/' + row.id + '?master=1')).status, 404);
});
