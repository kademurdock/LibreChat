const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), express = require('express'), axios = require('axios'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
function source(relative) {
  const filename = path.resolve(__dirname, '../../../packages/api/src/' + relative + '.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => id === '@librechat/data-schemas'
    ? { logger: { info() {}, warn() {}, error() {} } } : Module.prototype.require.call(mod, id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return mod.exports;
}
const { createLyricsRouter, registerMusicReference, validateMusicReference } = source('music/lyrics');
const { isAukOwnedReference } = source('speech/edit');
const env = { AWS_BUCKET_NAME: 'fixture-bucket', AWS_ENDPOINT_URL: 'https://objects.test' };
const own = 'https://objects.test/fixture-bucket/audios/alice/import.wav';
const foreign = 'https://objects.test/fixture-bucket/audios/bob/private.wav';
const generated = 'https://objects.test/fixture-bucket/yue2/generated/master.mp3';
const generatedAlias = 'https://fixture-bucket.objects.test/yue2/generated/master.mp3?X-Amz-Signature=fixture';
const provider = 'https://provider.test/audio?object=owned';
const forgedProvider = 'https://provider.test/audio?object=foreign';

(async () => {
  const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  const References = mongoose.model('KadeMusicReference'); await References.init();
  let downloads = 0, transcriptions = 0, refreshes = 0, refreshTarget;
  const authorized = [];
  axios.defaults.adapter = async config => {
    downloads++;
    assert.notEqual(config.url, foreign, 'foreign storage must never be downloaded');
    assert.notEqual(config.url, forgedProvider, 'foreign provider query must never be downloaded');
    assert.equal(config.maxRedirects, 0);
    return { data: Buffer.from('synthetic audio'), status: 200, statusText: 'OK', headers: { 'content-type': 'audio/wav' }, config };
  };
  const hooks = {
    auth: (_req, _res, next) => next(), user: () => 'alice',
    savedSources: async () => [generated, provider],
    authorize: async (user, url) => {
      authorized.push(url);
      if (user !== 'alice' || (!isAukOwnedReference(user, url, [generated], env) && url !== provider)) {
        throw new Error('Reference is not owned.');
      }
    },
    refresh: async (url, user) => { assert.equal(user, 'alice'); refreshes++; return refreshTarget || url; },
    duration: async () => 30,
    transcribe: async () => { transcriptions++; return { transcript: 'Synthetic owned words', seconds: 30, model: 'fixture' }; },
  };
  const app = express(); app.use(createLyricsRouter(hooks));
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const post = url => fetch('http://127.0.0.1:' + server.address().port + '/reference/lyrics', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const activity = () => [downloads, transcriptions, refreshes];
  try {
    // A genuine old import can have no registry or asset row; namespace ownership suffices.
    assert.equal(await References.countDocuments({ user: 'alice' }), 0);
    const first = await post(own); assert.equal(first.status, 200); assert.equal((await first.json()).cached, false);
    assert.equal(await References.countDocuments({ user: 'alice' }), 1);
    const good = await References.findOne({ user: 'alice' }).lean();
    const beforeCache = activity();
    const cached = await post(own); assert.equal(cached.status, 200); assert.equal((await cached.json()).cached, true);
    assert.deepEqual(activity(), beforeCache, 'owned cached words need no provider calls');

    // A legacy poisoned registry/cache entry must not turn caller input into proof of ownership.
    await registerMusicReference('alice', foreign, 30);
    await References.updateOne({ user: 'alice', url: foreign }, { $set: { transcript: good.transcript, transcriptVersion: good.transcriptVersion } });
    let before = activity();
    const poisoned = await post(foreign); assert.equal(poisoned.status, 400);
    assert.equal((await poisoned.json()).transcript, undefined);
    await assert.rejects(validateMusicReference('alice', foreign, hooks), /not saved on your account/);
    assert.deepEqual(activity(), before, 'denial happens before signing, downloading, or transcribing');

    // An owned lookup key must not authorize a different stored URL, even with cached words.
    const poisonedKey = own.replace('import', 'poisoned-key');
    await registerMusicReference('alice', poisonedKey, 30);
    await References.updateOne({ user: 'alice', url: poisonedKey }, { $set: { url: foreign, transcript: good.transcript, transcriptVersion: good.transcriptVersion } });
    before = activity();
    assert.equal((await post(poisonedKey)).status, 400);
    await assert.rejects(validateMusicReference('alice', poisonedKey, hooks), /not saved on your account/);
    assert.deepEqual(activity(), before);

    // Refresh results are independently checked before downloads and before a render can use them.
    const fresh = own.replace('import', 'refresh'); await registerMusicReference('alice', fresh, 30);
    refreshTarget = foreign; before = activity();
    assert.equal((await post(fresh)).status, 400);
    await assert.rejects(validateMusicReference('alice', fresh, hooks), /not saved on your account/);
    assert.deepEqual(activity(), [before[0], before[1], before[2] + 2]);
    assert.equal((await References.findOne({ user: 'alice', url: fresh }).lean()).leaseUntil, undefined);
    refreshTarget = undefined;

    // A row changed at the lease boundary cannot bypass checks through the second cache return.
    const raced = own.replace('import', 'raced'); await registerMusicReference('alice', raced, 30);
    const originalClaim = References.findOneAndUpdate;
    References.findOneAndUpdate = function (...args) {
      const query = originalClaim.apply(this, args), lean = query.lean.bind(query);
      query.lean = async () => ({ ...await lean(), url: foreign, transcript: good.transcript, transcriptVersion: good.transcriptVersion });
      return query;
    };
    before = activity();
    try { assert.equal((await post(raced)).status, 400); }
    finally { References.findOneAndUpdate = originalClaim; }
    assert.deepEqual(activity(), before);

    // Storage aliases match the same owned object; provider query strings remain part of ownership.
    assert.equal(await validateMusicReference('alice', generatedAlias, hooks), generatedAlias);
    await registerMusicReference('alice', provider, 30);
    assert.equal(await validateMusicReference('alice', provider, hooks), provider);
    before = activity();
    await assert.rejects(validateMusicReference('alice', forgedProvider, hooks), /not saved on your account/);
    assert.equal((await post(forgedProvider)).status, 400);
    assert.deepEqual(activity(), before);
    assert.ok(authorized.includes(forgedProvider), 'authorization receives the full query-bearing URL');
    console.log('Music reference ownership passed: imports without registry, safe cache reuse, poisoned registry and stored URL denial, claimed-cache race, pre/post refresh checks, storage aliases, and provider query isolation.');
  } finally {
    server.closeAllConnections(); server.close(); await mongoose.disconnect(); await mongo.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
