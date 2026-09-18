const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const express = require('express'), axios = require('axios'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { createEffectsRouter, effectsInput, downloadEffects, effectsPrice } = require(path.resolve(__dirname, '../../../packages/api/src/audio/effects.ts'));
const { notifyMusic } = require(path.resolve(__dirname, '../../../packages/api/src/music/notify.ts'));
(async () => {
  const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  Object.assign(process.env, { FAL_KEY: 'fixture', BRIDGE_SECRET: 'fixture', BRIDGE_URL: 'https://bridge.test' });
  const submitted = [], rows = new Map(), saved = new Map(), notifications = [];
  let missingSubmission = false, savingFails = false;
  axios.defaults.adapter = async config => {
    const url = config.url, body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    let data, status = 200;
    if (url.endsWith('/notify')) { notifications.push(body); data = { ok: true, sent: 1 }; }
    else if (url.startsWith('https://v3.fal.media/')) { data = Buffer.from('RIFFxxxxWAVEfixture'); }
    else {
      assert.equal(config.headers.Authorization, 'Key fixture'); assert.equal(config.maxRedirects, 0);
      if (url.endsWith('/text-to-audio')) {
        submitted.push(body);
        if (missingSubmission) throw new Error('Connection lost after submission');
        const id = 'take-' + submitted.length, base = 'https://queue.fal.run/fal-ai/stable-audio-3/requests/' + id;
        rows.set(id, { status: 'IN_QUEUE' });
        data = { request_id: id, status_url: base + '/status', response_url: base, cancel_url: base + '/cancel' };
      } else {
        const id = url.match(/requests\/(take-\d+)/)[1], row = rows.get(id);
        if (url.endsWith('/cancel')) {
          assert.equal(config.method, 'put');
          if (row.status === 'COMPLETED') { status = 400; data = { status: 'ALREADY_COMPLETED' }; }
          else { row.status = 'CANCELLED'; data = { status: 'CANCELLATION_REQUESTED' }; }
        } else if (url.endsWith('/status')) data = row;
        else if (row.resultFails) { status = 422; data = { detail: [{ msg: 'Prompt could not be generated' }] }; }
        else data = { audio: { url: 'https://v3.fal.media/' + id + '.wav', file_size: 42 } };
      }
    }
    return { data, status, statusText: 'fixture', headers: {}, config };
  };
  const app = express();
  app.use(createEffectsRouter({ auth: (_req, _res, next) => next(), user: req => req.headers['x-user'] || 'a',
    project: async () => new mongoose.Types.ObjectId().toString(), update: async () => {},
    complete: async job => {
      if (savingFails) throw new Error('Storage briefly unavailable');
      await downloadEffects(job.output.url);
      saved.set(job.id, job); job.output.url = 'https://saved.test/' + job.id + '.wav'; job.output.duration_s = 12;
    },
    notify: job => notifyMusic(job.user, job.input.title, job.takes.filter(t => t.state === 'done').length, job.takes.length, job.state !== 'done', 'effects'),
  }));
  const Jobs = mongoose.model('KadeEffectsJob'); await Jobs.init();
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body, user = 'a') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  const progress = async id => (await fetch(base + '/status/' + id)).json();
  const input = { engine: 'stable', title: 'Harbor', script: 'Small waves, distant gulls, quiet rigging. No music.', duration: 12, count: 4, seed: 42 };
  try {
    for (const bad of [{ count: 5 }, { duration: 121 }, { duration: 1.5 }, { steps: 101 }, { seed: -1 }, { title: 'a'.repeat(81) }]) assert.throws(() => effectsInput({ ...input, ...bad }));
    assert.equal(effectsInput(input).steps, 8);
    await assert.rejects(() => downloadEffects('http://127.0.0.1/private'));
    const quote = await (await post('/render', { ...input, estimateOnly: true })).json();
    assert.equal(quote.estimate.costUSD, 0.0824); assert.equal(submitted.length, 0);
    const attempts = await Promise.all([post('/render', input), post('/render', input)]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const job = await attempts.find(r => r.status === 200).json();
    assert.deepEqual(submitted.map(x => x.seed), [42, 43, 44, 45]);
    assert.ok(submitted.every(x => x.output_format === 'wav' && x.num_inference_steps === 8 && x.duration === 12 && x.enable_safety_checker && !x.enable_prompt_expansion));
    assert.equal((await fetch(base + '/status/' + job.jobId, { headers: { 'x-user': 'stranger' } })).status, 404);
    rows.get('take-1').status = 'COMPLETED'; savingFails = true;
    assert.equal((await progress(job.jobId)).state, 'running'); assert.equal(saved.size, 0);
    savingFails = false;
    assert.equal((await progress(job.jobId)).completed, 1); assert.equal(notifications.length, 0);
    rows.get('take-2').status = 'COMPLETED'; rows.get('take-2').error = 'Safety checker rejected this take';
    rows.get('take-3').status = 'COMPLETED'; rows.get('take-3').resultFails = true;
    rows.get('take-4').status = 'COMPLETED';
    const done = await progress(job.jobId);
    assert.equal(done.state, 'failed'); assert.equal(done.completed, 2); assert.match(done.error, /Prompt could not be generated/);
    assert.equal(done.url.startsWith('https://saved.test/'), true); assert.equal(done.durationS, 12);
    await Promise.all([progress(job.jobId), progress(job.jobId)]);
    assert.equal(saved.size, 2); assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Your sound batch has stopped'); assert.equal(notifications[0].userId, 'a');
    assert.equal((await Jobs.findOne({ id: job.jobId })).costUSD, effectsPrice * 2);
    const next = await (await post('/render', { ...input, count: 2 })).json();
    rows.get('take-5').status = 'COMPLETED';
    assert.equal((await post('/cancel/' + next.jobId, {})).status, 200);
    assert.equal((await progress(next.jobId)).completed, 1, 'cancel race keeps a completed recording');
    missingSubmission = true;
    const uncertain = await post('/render', input); assert.equal(uncertain.status, 502);
    assert.equal(submitted.length, 7, 'a lost response does not trigger more paid submissions');
    assert.equal((await post('/render', input)).status, 409);
    console.log('Stable Audio integration passed: exact payload/price, four seeds, duplicate guard, account isolation, saving retry, partial failures, single notification, cancellation race, ambiguous submission protection.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
