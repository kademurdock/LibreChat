const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), express = require('express'), axios = require('axios'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
/* The transcriber's logger (Part 293) comes from @librechat/data-schemas, which is not built for
 * this script: a recording stand-in, so the fallback reasons can be checked. */
const logs = [];
const dataSchemas = { logger: { info: (line) => logs.push(['info', String(line)]), warn: (line) => logs.push(['warn', String(line)]), error: (line) => logs.push(['error', String(line)]) } };
function source(name) {
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/' + name + '.ts');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = (id) => (id === '@librechat/data-schemas' ? dataSchemas : Module.prototype.require.call(mod, id));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const { createYueRouter, yueInput } = source('yue');
const { createLyricsRouter, registerMusicReference, transcribeMusicLyrics, validateMusicReference, musicReferenceError } = source('lyrics');
const { notifyMusic } = source('notify');
(async () => {
  const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  Object.assign(process.env, { YUE_ENDPOINT_ID: 'fixture', RUNPOD_API_KEY: 'fixture', BRIDGE_SECRET: 'fixture', BRIDGE_URL: 'https://bridge.test', GEMINI_API_KEY: 'gemini-fixture', ELEVENLABS_API_KEY: 'scribe-fixture' });
  const providers = new Map(), submitted = [], saved = new Map(), notifications = [];
  let lostSubmission = 0, transcriptionCalls = 0, duration = 30;
  let geminiMode = 'ok', scribeFailure = false, geminiCalls = 0, scribeCalls = 0;
  let audioDownloads = 0, downloadFails = false, projectWrites = 0;
  axios.defaults.adapter = async config => {
    const url = config.url;
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    let data;
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      assert.equal(config.headers['x-goog-api-key'], 'gemini-fixture');
      assert.equal(config.maxRedirects, 0);
      assert.ok(config.timeout <= 60000);
      assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'audio/mpeg');
      assert.equal(Buffer.from(body.contents[0].parts[0].inlineData.data, 'base64').toString(), 'ID3fixture audio');
      assert.match(body.contents[0].parts[1].text, /audibly present/);
      // Part 293: section tags only where the music marks a section, from the allowed list; Flash on low thinking.
      assert.match(body.contents[0].parts[1].text, /only where the music audibly marks a new section: \[Verse\], \[Pre-Chorus\], \[Chorus\], \[Post-Chorus\], \[Bridge\], \[Intro\] or \[Outro\]\. A block whose words come back as a refrain is \[Chorus\]\. Do not number the labels\./);
      assert.doesNotMatch(body.contents[0].parts[1].text, /invented section labels/);
      assert.match(url, /\/models\/gemini-3\.8-flash:generateContent$/);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      assert.equal(body.contents[0].parts.length, 2, 'the model gets audio and instructions, never saved lyrics');
      if (geminiMode === 'error') throw new Error('Gemini unavailable');
      const finishReason = { truncated: 'MAX_TOKENS', recitation: 'RECITATION' }[geminiMode] || 'STOP';
      data = { candidates: [{ finishReason, content: { parts: [{ thought: true, text: 'Private reasoning must never be used as lyrics.' }, { text: '[Verse 1]\nHeard words\n\n[Interlude]\n\n[chorus]\nRepeated chorus\nRepeated chorus' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 3 } };
    } else if (url === 'https://api.elevenlabs.io/v1/speech-to-text') {
      scribeCalls++;
      assert.equal(config.headers['xi-api-key'], 'scribe-fixture');
      assert.equal(config.maxRedirects, 0); assert.ok(config.timeout <= 90000);
      const form = config.data.getBuffer().toString();
      assert.match(form, /scribe_v2/); assert.match(form, /ID3fixture audio/);
      assert.match(form, /name="tag_audio_events"\r\n\r\nfalse/);
      if (scribeFailure) throw new Error('Scribe unavailable');
      data = { text: 'Fallback lyrics. Same chorus. Same chorus.' };
    } else if (url.endsWith('/notify')) {
      assert.equal(config.headers['x-bridge-secret'], 'fixture'); assert.equal(body.requested, true);
      assert.equal(body.route, 'sound-booth'); assert.equal(body.broadcast, undefined);
      notifications.push(body); data = { ok: true, sent: 1 };
    } else if (url === 'https://assets.test/reference.wav') {
      audioDownloads++;
      if (downloadFails) throw new Error('Audio unavailable');
      assert.equal(config.maxRedirects, 0); data = Buffer.from('ID3fixture audio');
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
  const referenceHooks = { savedSources: async () => [], refresh: async url => url, duration: async () => duration };
  app.use(createYueRouter({ auth, user,
    validateReference: (seat, url) => validateMusicReference(seat, url, referenceHooks),
    project: async () => { projectWrites++; return new mongoose.Types.ObjectId().toString(); }, update: async () => {},
    complete: async job => saved.set(job.id, job),
    notify: async job => notifyMusic(job.user, job.input.title, job.takes.filter(t => t.state === 'done').length, job.takes.length, job.state !== 'done'),
  }));
  app.use(createLyricsRouter({ auth, user, savedSources: async () => [], refresh: async url => url,
    duration: async () => duration,
    transcribe: async (...args) => { transcriptionCalls++; return transcribeMusicLyrics(...args); },
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
    providers.get('provider2').error = 'Use a source recording up to six minutes long.';
    progress = await status(job.jobId); assert.equal(progress.state, 'failed'); assert.equal(progress.completed, 1); assert.equal(saved.size, 1);
    assert.match(progress.error, /Use a source recording up to six minutes long/);
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
    const References = mongoose.model('KadeMusicReference');
    await References.updateOne({ user: 'a' }, { $set: { transcript: { transcript: 'Old incomplete words', model: 'nova-3', seconds: 30 } } });
    const lyrics = await (await post('/reference/lyrics', { url: ref })).json(); assert.match(lyrics.transcript, /Heard words/); assert.match(lyrics.warning, /wrong or missing/);
    assert.equal(lyrics.model, 'gemini-3.8-flash'); assert.equal(lyrics.cached, false);
    assert.equal(lyrics.seconds, 30); assert.deepEqual(lyrics.usage, { inputTokens: 100, outputTokens: 23 });
    assert.doesNotMatch(lyrics.transcript, /reasoning|Old incomplete/);
    assert.equal((lyrics.transcript.match(/Repeated chorus/g) || []).length, 2);
    // Tags are kept to the allowed list: numbers go, unknown labels go, case is fixed.
    assert.equal(lyrics.transcript, '[Verse]\nHeard words\n\n[Chorus]\nRepeated chorus\nRepeated chorus');
    assert.match(lyrics.warning, /the section tags are guesses from the music/);
    const cached = await (await post('/reference/lyrics', { url: ref })).json(); assert.equal(cached.cached, true); assert.equal(transcriptionCalls, 1);
    assert.equal(cached.warning, lyrics.warning, 'a cached Gemini draft keeps the Gemini warning');
    assert.equal(geminiCalls, 1); assert.equal(scribeCalls, 0);
    geminiMode = 'truncated';
    const fallback = await transcribeMusicLyrics(Buffer.from('ID3fixture audio'), 'application/octet-stream', 45);
    assert.equal(fallback.model, 'scribe_v2'); assert.equal(fallback.transcript, 'Fallback lyrics.\nSame chorus.\nSame chorus.');
    assert.equal(fallback.seconds, 45); assert.equal(scribeCalls, 1);
    assert.ok(logs.some(([level, line]) => level === 'warn' && /\[music\/lyrics\] lyrics gemini fallback reason=finish:MAX_TOKENS model=gemini-3\.8-flash audio\/mpeg 16B 45s; using scribe_v2$/.test(line)), 'a truncated Gemini draft is logged before the fallback');
    const largeAudio = Buffer.alloc(14 * 1024 * 1024 + 1);
    largeAudio.write('ID3fixture audio');
    const beforeLarge = geminiCalls;
    assert.equal((await transcribeMusicLyrics(largeAudio, 'application/octet-stream', 360)).model, 'scribe_v2');
    assert.equal(geminiCalls, beforeLarge, 'oversized inline audio uses Scribe without uploading to Gemini');
    assert.ok(logs.some(([level, line]) => level === 'info' && /reason=skip:over-14MiB /.test(line)), 'a skipped Gemini call is logged as a skip, not a failure');
    geminiMode = 'error'; scribeFailure = true;
    await References.updateOne({ user: 'a' }, { $set: { transcriptVersion: 'older-version' } });
    assert.equal((await post('/reference/lyrics', { url: ref })).status, 502);
    const afterFailure = await References.findOne({ user: 'a' }).lean();
    assert.equal(afterFailure.transcript.transcript, lyrics.transcript, 'provider failures preserve existing draft');
    assert.equal(afterFailure.leaseUntil, undefined);
    assert.ok(logs.some(([level, line]) => level === 'warn' && /reason=error:Gemini unavailable /.test(line)), 'a Gemini error is logged before the fallback');
    geminiMode = 'ok'; scribeFailure = false;
    assert.equal((await post('/reference/lyrics', { url: ref })).status, 200);
    // A commercial song Gemini will not recite: the backup draft says plainly where it came from, cached or not.
    geminiMode = 'recitation';
    await References.updateOne({ user: 'a' }, { $set: { transcriptVersion: 'older-version' } });
    const backup = await (await post('/reference/lyrics', { url: ref })).json();
    assert.equal(backup.model, 'scribe_v2'); assert.equal(backup.cached, false);
    assert.equal(backup.warning, 'Draft lyrics from the backup transcriber, so they have no section tags. Add tags such as [Verse] and [Chorus] yourself. Singing, backing vocals and instruments can cause wrong or missing words. Listen and correct the Lyrics box before generating.');
    const backupCached = await (await post('/reference/lyrics', { url: ref })).json();
    assert.equal(backupCached.cached, true); assert.equal(backupCached.warning, backup.warning);
    assert.ok(logs.some(([level, line]) => level === 'warn' && /lyrics gemini fallback reason=finish:RECITATION model=gemini-3\.8-flash /.test(line)), 'RECITATION is countable in the log');
    assert.ok(logs.every(([, line]) => !line.includes('gemini-fixture') && !line.includes('scribe-fixture')), 'no key in any log line');
    geminiMode = 'ok';

    const cover = { ...input, reference_voice_url: ref };
    const beforeSubmissions = submitted.length, beforeProjects = projectWrites;
    assert.equal((await post('/render', cover, 'outsider')).status, 400);
    assert.equal(submitted.length, beforeSubmissions);
    await registerMusicReference('overlong', ref);
    duration = 433.1;
    const overlong = await post('/render', cover, 'overlong');
    assert.equal(overlong.status, 400); assert.match((await overlong.json()).error, /7 minutes 13 seconds.*6 minutes/);
    assert.equal(submitted.length, beforeSubmissions); assert.equal(projectWrites, beforeProjects);
    assert.equal(await Jobs.countDocuments({ user: 'overlong' }), 0);
    const beforeCached = audioDownloads;
    assert.equal((await post('/render', cover, 'overlong')).status, 400);
    assert.equal(audioDownloads, beforeCached, 'server-measured duration is cached for old imports');
    await registerMusicReference('unreadable', ref); duration = null;
    assert.equal((await post('/render', cover, 'unreadable')).status, 400);
    assert.equal(submitted.length, beforeSubmissions);
    await registerMusicReference('unavailable', ref); downloadFails = true;
    assert.equal((await post('/render', cover, 'unavailable')).status, 400);
    assert.equal(submitted.length, beforeSubmissions); downloadFails = false;
    await registerMusicReference('boundary', ref, 360);
    const downloadsBeforeValid = audioDownloads;
    const valid = await post('/render', cover, 'boundary'); assert.equal(valid.status, 200);
    assert.equal(audioDownloads, downloadsBeforeValid, 'new imports reuse trusted duration');
    assert.equal(submitted.length, beforeSubmissions + 2);
    const validJob = await valid.json(); await post('/cancel/' + validJob.jobId, {}, 'boundary');
    duration = 30;
    const savedSource = await validateMusicReference('old-project', ref, { ...referenceHooks, savedSources: async () => [ref], refresh: async () => ref });
    assert.equal(savedSource, ref, 'pre-registry owned projects remain usable');
    assert.equal(musicReferenceError(360), undefined);
    for (const seconds of [null, undefined, NaN, 0, -1]) assert.match(musicReferenceError(seconds), /could not be read/);
    console.log('Music controls integration passed: batches, distinct seeds, controls, concurrent-click guard, partial saves, single routed notification, uncertain submissions, cancellation, legacy jobs, private transcription, duration guard and cached drafts; tagged drafts, warnings by transcriber and logged fallback reasons.');
  } finally { server.closeAllConnections(); server.close(); await mongoose.disconnect(); await mongo.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
