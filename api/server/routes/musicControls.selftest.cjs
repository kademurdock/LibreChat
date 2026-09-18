const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), express = require('express'), axios = require('axios'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
function source(name) {
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/' + name + '.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const { createYueRouter, yueInput } = source('yue');
const { createLyricsRouter, registerMusicReference } = source('lyrics');
const { notifyMusic } = source('notify');
(async () => {
  const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  Object.assign(process.env, { YUE_ENDPOINT_ID: 'fixture', RUNPOD_API_KEY: 'fixture', BRIDGE_SECRET: 'fixture', BRIDGE_URL: 'https://bridge.test' });
  const providers = new Map(), submitted = [], saved = new Map(), notifications = [];
  let lostSubmission = 0, transcriptionCalls = 0, duration = 30;
  axios.defaults.adapter = async config => {
    const url = config.url;
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    let data;
    if (url.endsWith('/notify')) {
      assert.equal(config.headers['x-bridge-secret'], 'fixture'); assert.equal(body.requested, true);
      assert.equal(body.route, 'sound-booth'); assert.equal(body.broadcast, undefined);
      notifications.push(body); data = { ok: true, sent: 1 };
    } else if (url === 'https://assets.test/reference.wav') {
      assert.equal(config.maxRedirects, 0); data = Buffer.from('fixture audio');
    } else if (url.endsWith('/run')) {
      submitted.push(body.input); const id = 'provider' + submitted.length;
      if (submitted.length === lostSubmission) throw new Error('Submission response lost');
      providers.set(id, { status: 'IN_QUEUE' }); data = { id };
    } else {
      const id = url.split('/').at(-1); const row = providers.get(id);
      assert.ok(row, 'unknown provider id');
      if (url.includes('/cancel/')) row.status = 'CANCELLED';
      data = { ...row, executionTime: 1000,
        output: row.status === 'COMPLETED' ? { url: 'https://assets.test/' + id + '.mp3', duration_s: 12 } : undefined };
    }
    return { data, status: 200, statusText: 'OK', headers: { 'content-type': 'audio/wav' }, config };
  };
  const auth = (_req, _res, next) => next(), user = req => String(req.headers['x-user'] || 'a');
  const app = express();
  app.use(createYueRouter({ auth, user,
    project: async () => new mongoose.Types.ObjectId().toString(), update: async () => {},
    complete: async job => saved.set(job.id, job),
    notify: async job => notifyMusic(job.user, job.input.title, job.takes.filter(t => t.state === 'done').length, job.takes.length, job.state !== 'done'),
  }));
  app.use(createLyricsRouter({ auth, user, savedSources: async () => [], refresh: async url => url,
    duration: async () => duration,
    transcribe: async () => { transcriptionCalls++; return { transcript: '[Verse]\nHeard words', seconds: 30, model: 'fixture' }; },
  }));
  await mongoose.model('KadeYueJob').init(); await mongoose.model('KadeMusicReference').init();
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body, seat = 'a') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': seat }, body: JSON.stringify(body) });
  const status = async (id, seat = 'a') => (await fetch(base + '/status/' + id, { headers: { 'x-user': seat } })).json();
  const input = { engine: 'yue2', script: 'Warm folk song', lyrics: '[Verse]\nOriginal words', title: 'Home Again', count: 2, seed: 42, weirdness: 70, steps: 48, guidance: 1.4 };
  try {
    for (const bad of [{ count: 0 }, { count: 5 }, { count: 1.5 }, { steps: 65 }, { weirdness: 101 }, { guidance: NaN }, { title: 'a'.repeat(81) }]) assert.throws(() => yueInput({ ...input, ...bad }));
    const defaults = yueInput({ script: input.script, lyrics: input.lyrics });
    assert.equal(defaults.weirdness, 50); assert.equal(defaults.steps, 32); assert.equal(defaults.guidance, 1); assert.equal(defaults.count, 1);
    const attempts = await Promise.all([post('/render', input), post('/render', input)]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const job = await attempts.find(r => r.status === 200).json();
    assert.equal(submitted.length, 2); assert.deepEqual(submitted.map(i => i.seed), [42, 43]);
    assert.ok(submitted.every(i => i.steps === 48 && i.weirdness === 70 && i.guidance === 1.4 && i.title === input.title));
    providers.get('provider1').status = 'COMPLETED';
    let progress = await status(job.jobId); assert.equal(progress.completed, 1); assert.equal(progress.total, 2); assert.equal(notifications.length, 0);
    providers.get('provider2').status = 'FAILED';
    progress = await status(job.jobId); assert.equal(progress.state, 'failed'); assert.equal(progress.completed, 1); assert.equal(saved.size, 1);
    await Promise.all([status(job.jobId), status(job.jobId)]); assert.equal(notifications.length, 1);
    assert.match(notifications[0].body, /1 of 2 takes saved/);
    assert.equal((await mongoose.model('KadeYueJob').findOne({ id: job.jobId }).lean()).notification.accepted, 1);
    assert.equal((await fetch(base + '/status/' + job.jobId, { headers: { 'x-user': 'b' } })).status, 404);

    lostSubmission = submitted.length + 2;
    const uncertain = await (await post('/render', input, 'b')).json();
    assert.equal(uncertain.queued, true); providers.get('provider3').status = 'COMPLETED';
    const stopped = await status(uncertain.jobId, 'b'); assert.equal(stopped.state, 'failed'); assert.equal(stopped.completed, 1);
    assert.match(stopped.error, /Contact Kade/); assert.equal((await post('/render', input, 'b')).status, 409);
    assert.equal(submitted.length, 4, 'uncertain paid submissions never retry');

    const cancel = await (await post('/render', { ...input, count: 4 }, 'c')).json();
    assert.equal((await post('/cancel/' + cancel.jobId, {}, 'c')).status, 200);
    assert.equal((await status(cancel.jobId, 'c')).state, 'cancelled');
    for (let i = 5; i <= 8; i++) assert.equal(providers.get('provider' + i).status, 'CANCELLED');

    const Jobs = mongoose.model('KadeYueJob');
    await Jobs.create({ id: 'yue_legacy', user: 'legacy', projectId: 'old', providerId: 'provider1', input: { style: input.script, lyrics: input.lyrics, seed: 7 }, state: 'running', active: true, createdAt: new Date() });
    assert.equal((await status('yue_legacy', 'legacy')).state, 'done');
    assert.ok(saved.has('yue_legacy'), 'in-flight jobs from the old deployment remain compatible');

    const ref = 'https://assets.test/reference.wav'; await registerMusicReference('a', ref);
    assert.equal((await post('/reference/lyrics', { url: ref }, 'b')).status, 404);
    assert.equal((await post('/reference/lyrics', { url: 'https://127.0.0.1/private' })).status, 404);
    assert.equal((await post('/reference/lyrics', { url: 'http://localhost' })).status, 400);
    duration = 361; assert.equal((await post('/reference/lyrics', { url: ref })).status, 400); assert.equal(transcriptionCalls, 0);
    duration = 30;
    const lyrics = await (await post('/reference/lyrics', { url: ref })).json(); assert.match(lyrics.transcript, /Heard words/); assert.match(lyrics.warning, /wrong or missing/);
    const cached = await (await post('/reference/lyrics', { url: ref })).json(); assert.equal(cached.cached, true); assert.equal(transcriptionCalls, 1);
    console.log('Music controls integration passed: batches, distinct seeds, controls, concurrent-click guard, partial saves, single routed notification, uncertain submissions, cancellation, legacy jobs, private transcription, duration guard and cached drafts.');
  } finally { server.closeAllConnections(); server.close(); await mongoose.disconnect(); await mongo.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
