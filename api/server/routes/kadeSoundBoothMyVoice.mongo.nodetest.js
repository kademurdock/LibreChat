/* Sing it in my voice (Sep 27 2026) through the real booth: kadeSoundBooth.js itself, loaded with the real YuE2 and voice job
 * routers (packages/api music/yue.ts, music/myVoice.ts, audio/jobs.ts), the real project model, a real Mongo (memory server)
 * and RunPod answered by a fake axios adapter. Nothing leaves the machine.
 *
 * What it holds the booth to: an account with no voice model sees and reaches nothing (guide, /health, the engine, the YuE2
 * choice, the upload lane); the owner's voice job carries her model to the worker and never to a screen; a YuE2 song with
 * "Sing it in my voice: On" keeps its take and gains a version in her voice beside it, paid apart and said once.
 *
 * Run: node --test api/server/routes/kadeSoundBoothMyVoice.mongo.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ts = require('typescript');

const OWNER = '6a0000000000000000000001';
const OTHER = '6a0000000000000000000002';
const ENTRY = {
  model_key: `voice-models/${OWNER}/k3x9q/model.pth`,
  model_sha256: 'a'.repeat(64),
  index_key: `voice-models/${OWNER}/k3x9q/model.index`,
  index_sha256: 'b'.repeat(64),
  range: { p05: 55.2, p50: 63.1, p95: 70.1 },
};
Object.assign(process.env, {
  MY_VOICE_ENABLED: '1',
  MY_VOICE_ENDPOINT_ID: 'voiceep',
  RUNPOD_API_KEY: 'test-only',
  YUE_ENDPOINT_ID: 'yueep',
  MY_VOICE_MODELS: JSON.stringify({ [OWNER]: ENTRY }),
});
delete process.env.YUE_COVERS_V2;
delete process.env.MY_VOICE_DEFAULTS;

/* The TypeScript sources through one plain require hook (as yue.selftest.cjs does), so they share this file's axios and
 * mongoose. (tsx.require gives each call its own module namespace, and a second axios there would miss the fake RunPod.) */
require.extensions['.ts'] = (m, filename) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
const voice = require('../../../packages/api/src/music/myVoice.ts');
const yue = require('../../../packages/api/src/music/yue.ts');
/* The real recording limits, import words and guide lengths from music/lyrics.ts, with its transcriber's form-data and
 * logger stubbed (as kadeSoundBoothLink.nodetest.js does), so Sing it in my voice is held to the real six minutes while a
 * YuE2 cover may be sped up to fit (YUE_FIT_TEMPO=1). */
function musicLyrics() {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  const stubs = {
    'form-data': function FormData() {},
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
  return compiled.exports;
}
const lyrics = musicLyrics();

/* Nothing may reach the network: any real HTTP(S) request fails the test at once. */
for (const lib of [require('node:http'), require('node:https')]) {
  lib.request = () => {
    throw new Error('a real network request was attempted');
  };
  lib.get = lib.request;
}

/* RunPod, answered here. Each endpoint keeps what it was sent and answers with the status and output a test sets. */
const rp = {};
for (const ep of ['yueep', 'voiceep'])
  rp[ep] = {
    runs: [],
    status: 'IN_QUEUE',
    output: undefined,
    executionTime: 60000,
    failRun: false,
  };
axios.defaults.adapter = async (config) => {
  const url = config.url || '';
  const m = url.match(/^https:\/\/api\.runpod\.ai\/v2\/(yueep|voiceep)\/(run|status|cancel)/);
  assert.ok(m, 'only RunPod is called: ' + url);
  const ep = rp[m[1]];
  let data;
  if (m[2] === 'run') {
    if (ep.failRun) throw new Error('the answer was lost');
    ep.runs.push((typeof config.data === 'string' ? JSON.parse(config.data) : config.data).input);
    data = { id: `${m[1]}-${ep.runs.length}` };
  } else {
    data = {
      status: ep.status,
      executionTime: ep.executionTime,
      delayTime: 1500,
      output: ep.status === 'COMPLETED' ? ep.output : undefined,
    };
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

test('Sing it in my voice through the real booth', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const Asset =
    mongoose.models.KadeAsset ||
    mongoose.model(
      'KadeAsset',
      new mongoose.Schema(
        {
          user: String,
          service: String,
          kind: String,
          url: String,
          backupUrl: String,
          model: String,
          prompt: String,
          description: String,
          costUSD: Number,
          chargedUSD: Number,
          metadata: mongoose.Schema.Types.Mixed,
        },
        { timestamps: true },
      ),
    );
  const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');
  const notified = [];
  const referenceChecks = []; // what each render's recording was checked for (validateMusicReference's `use`)
  let clipSeconds = 181.2;
  const api = {
    ...yue, // every YuE2 export the booth reads (yueSavedOptions, yueStyleAccess, ...), so kade's own additions keep working
    ...voice,
    createYueRouter: yue.createYueRouter,
    yueConfigured: yue.yueConfigured,
    yueCost: yue.yueCost,
    yueStyles: yue.yueStyles,
    yueStylesEnabled: yue.yueStylesEnabled,
    yueCoverSettings: yue.yueCoverSettings,
    yueCoverOptions: yue.yueCoverOptions,
    yueProjectWhy: yue.yueProjectWhy,
    yueTakeFacts: yue.yueTakeFacts,
    createLyricsRouter: () => express.Router(),
    createEffectsRouter: () => express.Router(),
    effectsGuide: {
      name: 'Stable Audio',
      tagline: 'Sounds.',
      where: '',
      cost: '',
      bestFor: [],
      notFor: [],
      howToWrite: [],
      settings: [],
    },
    effectsConfigured: () => false,
    effectsVariant: () => ({ name: 'Stable Audio', model: 'x', price: 0 }),
    notifyMusic: async (...args) => {
      notified.push(args);
      return { at: new Date(), accepted: 1 };
    },
    validateMusicReference: async (_user, url, _hooks, use) => {
      referenceChecks.push(use);
      return url;
    },
    musicReferenceSeconds: async () => 180,
    registerMusicReference: async () => {},
    musicReferenceError: lyrics.musicReferenceError,
    musicReferenceSpeedNote: lyrics.musicReferenceSpeedNote,
    musicCoverLengthGuide: lyrics.musicCoverLengthGuide,
    saveBufferToS3: async ({ fileName }) => `https://assets.test/audios/u/${fileName}`,
    needsRefresh: () => false,
    getNewS3URL: async (u) => u,
    familyFeatures: () => ({
      mediaLinks: false,
      describerLinks: true,
      jukeboxLinks: true,
      familyLibrary: false,
    }),
  };
  const multer = Object.assign(
    () => ({
      single: () => (req, _res, next) => {
        const name = req.headers['x-file-name'];
        if (name)
          req.file = {
            buffer: Buffer.alloc(4096, 1),
            originalname: name,
            mimetype: req.headers['x-file-type'] || '',
          };
        req.body = { engine: req.headers['x-engine'] };
        next();
      },
    }),
    { memoryStorage: () => ({}) },
  );
  const localRequire = (name) => {
    const fakes = {
      multer,
      '@librechat/api': api,
      '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
      '~/server/services/kadeJevJudges': {},
      '~/server/middleware': {
        requireJwtAuth: (req, _res, next) => {
          req.user = {
            id: String(req.headers['x-user'] || OTHER),
            role: req.headers['x-role'] || 'USER',
          };
          next();
        },
      },
      '~/models/kadeUsage': { logKadeUsage: async () => {}, KadeUsage: {} },
      '~/models': { getAgent: async () => null },
      '~/server/utils/kadeSongAudience': {
        songAudience: async () => 'adult',
        hasExplicitWords: () => false,
        explicitSungLines: () => [],
        isKidsBand: () => false,
      },
      '~/models/kadeAsset': { logKadeAsset: async () => {}, KadeAsset: Asset },
      '~/models/kadeSoundBoothProject': { KadeSoundBoothProject: Project },
      './kadeSoundBoothChain': {},
      './kadeSoundBoothStitch': {
        durationOf: async () => clipSeconds,
        normalizeReferenceClip: async () => null,
      },
      '../services/kadeRealCost': {
        userPriceFactor: (role) => (String(role).toUpperCase() === 'ADMIN' ? 1 : 2),
      },
    };
    return name in fakes ? fakes[name] : require(name);
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8'), {
    require: localRequire,
    module: mod,
    exports: mod.exports,
    process,
    console,
    Buffer,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const followUps = mod.exports._internals.myVoiceFollowUps;
  followUps.stop(); // the test walks them itself
  const app = express();
  app.use('/booth', mod.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/booth`;
  const call = async (route, { user = OTHER, body, headers = {}, role = 'USER' } = {}) => {
    const res = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-user': user, 'x-role': role, ...headers },
      body: body && JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  });
  const SAYS_IT = /myvoice|my_voice|Sing it in my voice|in your voice/i;

  await t.test('anyone else: /health says nothing about it', async () => {
    const h = await call('/health');
    assert.equal(h.status, 200);
    assert.ok(h.data.guide.engines.yue2 && h.data.guide.engines.lyria, 'the booth is all there');
    assert.doesNotMatch(JSON.stringify(h.data), SAYS_IT);
  });

  await t.test('the owner: the engine, the YuE2 choice and a configured lane', async () => {
    const h = await call('/health', { user: OWNER });
    assert.equal(h.data.guide.engines.myvoice.flow, 'upload');
    assert.equal(h.data.guide.engines.myvoice.name, 'Sing it in my voice');
    const keys = h.data.guide.engines.yue2.settings.map((s) => s.key);
    assert.equal(keys[keys.indexOf('count') - 1], 'my_voice');
    assert.deepEqual(h.data.engines.myvoice, { configured: true, queued: true, model: 'RVC v2' });
    assert.doesNotMatch(
      JSON.stringify(h.data),
      /voice-models\/|p05|63\.1/,
      'no storage key or range reaches a screen',
    );
  });

  await t.test(
    'the upload lane: FLAC and the length check for the owner; anyone else is AuK, as before',
    async () => {
      const mine = await call('/reference', {
        user: OWNER,
        body: {},
        headers: { 'x-engine': 'myvoice', 'x-file-name': 'take.flac', 'x-file-type': 'audio/flac' },
      });
      assert.equal(mine.status, 200, JSON.stringify(mine.data));
      assert.match(
        mine.data.spoken,
        /Clip imported, 181.2 seconds\. The original is kept as it is\./,
      );
      const theirs = await call('/reference', {
        body: {},
        headers: { 'x-engine': 'myvoice', 'x-file-name': 'take.flac', 'x-file-type': 'audio/flac' },
      });
      assert.equal(theirs.status, 400);
      assert.match(theirs.data.error, /^AuK can't read that kind of file/);
      assert.doesNotMatch(
        theirs.data.error,
        /other engine/,
        'no hint that some other engine takes it',
      );
      const speech = await call('/reference', {
        body: {},
        headers: { 'x-engine': 'myvoice', 'x-file-name': 'take.mp3', 'x-file-type': 'audio/mpeg' },
      });
      assert.equal(speech.status, 200);
      assert.match(speech.data.spoken, /Speech uses a voice sample/);
    },
  );

  const url = 'https://assets.test/audios/u/take.flac';
  await t.test(
    'anyone else naming the engine falls through like any unknown engine, and nothing is sent',
    async () => {
      for (const body of [
        { engine: 'myvoice', reference_voice_url: url },
        { engine: 'myvoice', reference_voice_url: url, estimateOnly: true },
      ]) {
        const r = await call('/render', { body });
        assert.equal(r.status, 400);
        assert.deepEqual(r.data, { error: 'There is nothing to render yet.' });
      }
      assert.equal(rp.voiceep.runs.length, 0);
    },
  );

  let jobId;
  await t.test(
    'the owner: the price first, then her model goes to the worker and nowhere else',
    async () => {
      const body = {
        engine: 'myvoice',
        reference_voice_url: url,
        voice_source: 'Just a vocal',
        pitch: -12,
        title: 'Porch song',
      };
      const quote = await call('/render', { user: OWNER, body: { ...body, estimateOnly: true } });
      assert.equal(quote.status, 200);
      assert.match(
        quote.data.estimate.spoken,
        /^About 2 cents of GPU time for a recording this long/,
      );
      assert.equal(rp.voiceep.runs.length, 0);
      const r = await call('/render', { user: OWNER, role: 'ADMIN', body });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.queued, true);
      assert.match(r.data.jobId, /^voice_/);
      jobId = r.data.jobId;
      assert.deepEqual(rp.voiceep.runs[0], {
        mode: 'vocal',
        audio_url: url,
        pitch: -12,
        model_key: ENTRY.model_key,
        model_sha256: ENTRY.model_sha256,
        index_key: ENTRY.index_key,
        index_sha256: ENTRY.index_sha256,
        voice_range: ENTRY.range,
        options: {
          extractor: 'hyperace',
          lead_split: true,
          lead_model: 'frazer',
          dereverb: false,
          soft_s: true,
          index_rate: 0.5,
          protect: 0.33,
          rms_mix_rate: 0.25,
          fallback: 'bs_roformer',
          room: true,
          f0_method: 'rmvpe',
        },
      });
      const project = await Project.findById(r.data.projectId).lean();
      assert.equal(project.engine, 'myvoice');
      assert.equal(project.title, 'Porch song');
      assert.doesNotMatch(JSON.stringify(project), /voice-models\//);
      assert.equal((await call('/status/' + jobId)).status, 404, 'anyone else cannot read her job');
    },
  );

  await t.test(
    'finished: a take with her voice alone beside it, the real price and a note that says what happened',
    async () => {
      Object.assign(rp.voiceep, {
        status: 'COMPLETED',
        executionTime: 95000,
        output: {
          url: 'https://assets.test/voice/j1/vocal.mp3',
          wav_url: 'https://assets.test/voice/j1/vocal.wav',
          vocal_url: 'https://assets.test/voice/j1/vocal.mp3',
          vocal_wav_url: 'https://assets.test/voice/j1/vocal.wav',
          duration_s: 181.2,
          gpu: 'NVIDIA GeForce RTX 4090',
          pitch: { shift: -12, source: 'set' },
          worker_notes: [],
          features: ['vocal'],
        },
      });
      const s = await call('/status/' + jobId, { user: OWNER, role: 'ADMIN' });
      assert.equal(s.data.state, 'done', JSON.stringify(s.data));
      assert.match(
        s.data.spoken,
        /Sung in your voice\. Moved down one octave to sit in your range\. About 3 cents of GPU time on RTX 4090, execution only\./,
      );
      const list = await call('/projects', { user: OWNER, role: 'ADMIN' });
      const p = list.data.projects.find((x) => x.engine === 'myvoice');
      assert.equal(p.why, 'Sung in my voice — a vocal on its own');
      assert.equal(p.costUSD, Math.round(95 * 0.000306 * 1000) / 1000);
      assert.equal(p.takes.length, 1);
      assert.equal(p.takes[0].vocalUrl, 'https://assets.test/voice/j1/vocal.mp3');
      assert.match(p.takes[0].note, /^Sung in your voice/);
      assert.equal(p.options.voice_source, 'Just a vocal');
      assert.equal(p.options.pitch, -12);
      assert.deepEqual(p.carryTo, [], 'nothing to carry a voice version to');
      assert.equal(
        (await call('/projects')).data.projects.length,
        0,
        'anyone else sees none of it',
      );
      clipSeconds = 400;
      const long = await call('/reference', {
        user: OWNER,
        body: {},
        headers: { 'x-engine': 'myvoice', 'x-file-name': 'long.mp3', 'x-file-type': 'audio/mpeg' },
      });
      clipSeconds = 181.2;
      assert.equal(long.status, 400);
      assert.equal(
        long.data.error,
        'This recording is 6 minutes 40 seconds long. Sing it in my voice takes recordings up to 6 minutes. Import a shorter recording or an excerpt; your original will not be trimmed automatically.',
      );
    },
  );

  await t.test(
    'a vocal effect: the worker gets vocal_fx, the take keeps her dry voice and adds the effected one, and the note says it',
    async () => {
      Object.assign(rp.voiceep, { status: 'IN_QUEUE', output: undefined });
      const r = await call('/render', {
        user: OWNER,
        role: 'ADMIN',
        body: { engine: 'myvoice', reference_voice_url: url, vocal_fx: 'Echo', title: 'Echo song' },
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const sent = rp.voiceep.runs.at(-1);
      assert.equal(sent.vocal_fx, 'echo');
      assert.equal('vocal_fx' in sent.options, false);
      Object.assign(rp.voiceep, {
        status: 'COMPLETED',
        executionTime: 100000,
        output: {
          url: 'https://assets.test/voice/e1/mix.mp3',
          key: 'voice/e1/mix.mp3',
          wav_url: 'https://assets.test/voice/e1/mix.wav',
          vocal_url: 'https://assets.test/voice/e1/vocal.mp3',
          vocal_wav_url: 'https://assets.test/voice/e1/vocal.wav',
          vocal_fx_url: 'https://assets.test/voice/e1/vocal_fx.mp3',
          vocal_fx_key: 'voice/e1/vocal_fx.mp3',
          vocal_fx_wav_url: 'https://assets.test/voice/e1/vocal_fx.wav',
          vocal_fx: { preset: 'echo', label: 'Echo', tempo_bpm: 84.9, tempo_source: 'detected', delay_ms: 530 },
          duration_s: 181.2,
          gpu: 'NVIDIA GeForce RTX 4090',
          pitch: { shift: 0, source: 'auto' },
          worker_notes: [],
          features: ['song', 'vocal-fx'],
        },
      });
      const s = await call('/status/' + r.data.jobId, { user: OWNER, role: 'ADMIN' });
      assert.equal(s.data.state, 'done', JSON.stringify(s.data));
      assert.match(s.data.spoken, /Vocal effect: Echo, its repeats in time with the song at about 85 beats a minute\./);
      const p = (await call('/projects', { user: OWNER, role: 'ADMIN' })).data.projects.find(
        (x) => x.id === r.data.projectId,
      );
      assert.equal(p.options.vocal_fx, 'Echo', 'Open in the booth restores it');
      assert.equal(p.takes[0].vocalUrl, 'https://assets.test/voice/e1/vocal.mp3', 'the dry voice, always kept');
      assert.equal(p.takes[0].vocalFxUrl, 'https://assets.test/voice/e1/vocal_fx.mp3');
      assert.match(p.takes[0].note, /Vocal effect: Echo/);

      /* Just a vocal with an effect: the take itself is the voice with the effect (the worker's key is vocal_fx.mp3), so the
       * take offers no second link to that same file; the dry voice is still beside it. */
      Object.assign(rp.voiceep, { status: 'IN_QUEUE', output: undefined });
      const v = await call('/render', {
        user: OWNER,
        role: 'ADMIN',
        body: {
          engine: 'myvoice',
          reference_voice_url: url,
          voice_source: 'Just a vocal',
          vocal_fx: 'Plate reverb',
          title: 'Plate vocal',
        },
      });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      assert.equal(rp.voiceep.runs.at(-1).mode, 'vocal');
      assert.equal(rp.voiceep.runs.at(-1).vocal_fx, 'plate');
      Object.assign(rp.voiceep, {
        status: 'COMPLETED',
        executionTime: 60000,
        output: {
          url: 'https://assets.test/voice/e2/vocal_fx.mp3',
          key: 'voice/e2/vocal_fx.mp3',
          wav_url: 'https://assets.test/voice/e2/vocal_fx.wav',
          vocal_url: 'https://assets.test/voice/e2/vocal.mp3',
          vocal_wav_url: 'https://assets.test/voice/e2/vocal.wav',
          vocal_fx_url: 'https://assets.test/voice/e2/vocal_fx.mp3',
          vocal_fx_key: 'voice/e2/vocal_fx.mp3',
          vocal_fx_wav_url: 'https://assets.test/voice/e2/vocal_fx.wav',
          vocal_fx: { preset: 'plate', label: 'Plate reverb', reverb_s: 2 },
          duration_s: 95,
          gpu: 'NVIDIA GeForce RTX 4090',
          pitch: { shift: 0, source: 'auto' },
          worker_notes: [],
          features: ['vocal', 'vocal-fx'],
        },
      });
      const vs = await call('/status/' + v.data.jobId, { user: OWNER, role: 'ADMIN' });
      assert.equal(vs.data.state, 'done', JSON.stringify(vs.data));
      const vp = (await call('/projects', { user: OWNER, role: 'ADMIN' })).data.projects.find(
        (x) => x.id === v.data.projectId,
      );
      assert.equal(vp.takes[0].vocalUrl, 'https://assets.test/voice/e2/vocal.mp3', 'the dry voice, always kept');
      assert.equal(vp.takes[0].vocalFxUrl, undefined, 'the take is already the voice with the effect');
      assert.match(vp.takes[0].note, /Vocal effect: Plate reverb\./);
    },
  );

  let yueTheirs, yueMine;
  await t.test(
    'YuE2 with the choice on: dropped for anyone else, kept for her, never sent to the music worker',
    async () => {
      const song = {
        engine: 'yue2',
        script: 'Warm soul with a Rhodes',
        lyrics: '[Verse]\nla la la',
        my_voice: 'On',
      };
      const theirs = await call('/render', { body: song });
      assert.equal(theirs.status, 200, JSON.stringify(theirs.data));
      const mine = await call('/render', { user: OWNER, role: 'ADMIN', body: song });
      assert.equal(mine.status, 200, JSON.stringify(mine.data));
      yueTheirs = theirs.data;
      yueMine = mine.data;
      assert.equal(rp.yueep.runs.length, 2);
      for (const sent of rp.yueep.runs)
        assert.equal('my_voice' in sent, false, "the music worker gets today's request");
      const jobs = mongoose.connection.db.collection('kadeyuejobs');
      assert.equal((await jobs.findOne({ id: theirs.data.jobId })).input.my_voice, undefined);
      assert.equal((await jobs.findOne({ id: mine.data.jobId })).input.my_voice, true);
      assert.equal(
        (await Project.findById(theirs.data.projectId).lean()).options.my_voice,
        undefined,
      );
      assert.equal((await Project.findById(mine.data.projectId).lean()).options.my_voice, 'On');
    },
  );

  await t.test(
    'each finished take of hers gets a version in her voice; theirs does not',
    async () => {
      const before = rp.voiceep.runs.length;
      Object.assign(rp.yueep, {
        status: 'COMPLETED',
        executionTime: 60000,
        output: {
          url: 'https://assets.test/yue2/abc/master.mp3',
          wav_url: 'https://assets.test/yue2/abc/master.wav',
          wav_key: 'yue2/abc/master.wav',
          duration_s: 150,
          truncated: false,
          gpu: 'NVIDIA A40',
          features: [],
        },
      });
      const theirs = await call('/status/' + yueTheirs.jobId);
      assert.equal(theirs.data.state, 'done');
      assert.doesNotMatch(theirs.data.spoken, SAYS_IT);
      assert.equal(rp.voiceep.runs.length, before, 'no voice version for anyone else');
      const mine = await call('/status/' + yueMine.jobId, { user: OWNER, role: 'ADMIN' });
      assert.equal(mine.data.state, 'done');
      assert.match(
        mine.data.spoken,
        /A version in your voice follows a few minutes after each take/,
      );
      assert.equal(rp.voiceep.runs.length, before + 1);
      assert.deepEqual(rp.voiceep.runs.at(-1), {
        mode: 'song',
        audio_key: 'yue2/abc/master.wav',
        pitch: 'auto',
        model_key: ENTRY.model_key,
        model_sha256: ENTRY.model_sha256,
        index_key: ENTRY.index_key,
        index_sha256: ENTRY.index_sha256,
        voice_range: ENTRY.range,
        options: {
          extractor: 'hyperace',
          lead_split: true,
          lead_model: 'frazer',
          dereverb: false,
          soft_s: true,
          index_rate: 0.5,
          protect: 0.33,
          rms_mix_rate: 0.25,
          fallback: 'bs_roformer',
          room: true,
          f0_method: 'rmvpe',
        },
      });
      const source = await Asset.findOne({ user: OWNER, service: 'runpod_yue2' }).lean();
      assert.deepEqual(source.metadata.myVoice, { state: 'queued' });
      const theirTakes = (await call('/projects')).data.projects.flatMap((x) => x.takes);
      assert.equal(theirTakes.length, 1);
      for (const key of ['vocalUrl', 'voiceOf', 'voiceNote'])
        assert.equal(key in theirTakes[0], false, `no ${key} on anyone else's take`);
      const list = await call('/projects', { user: OWNER, role: 'ADMIN' });
      const p = list.data.projects.find((x) => x.id === yueMine.projectId);
      assert.equal(p.takes[0].voiceNote, 'A version in your voice is being made.');
    },
  );

  await t.test(
    'the version lands beside the take, is paid apart, and she is told once',
    async () => {
      Object.assign(rp.voiceep, { status: 'IN_PROGRESS' });
      await followUps.advance();
      assert.equal(
        await Asset.countDocuments({
          service: 'runpod_myvoice',
          'metadata.voiceOf': { $exists: true },
        }),
        0,
      );
      Object.assign(rp.voiceep, {
        status: 'COMPLETED',
        executionTime: 120000,
        output: {
          url: 'https://assets.test/voice/f1/mix.mp3',
          wav_url: 'https://assets.test/voice/f1/mix.wav',
          vocal_url: 'https://assets.test/voice/f1/vocal.mp3',
          vocal_wav_url: 'https://assets.test/voice/f1/vocal.wav',
          duration_s: 150,
          gpu: 'NVIDIA GeForce RTX 4090',
          pitch: { shift: 0, source: 'auto' },
          worker_notes: [],
          features: ['song'],
        },
      });
      await followUps.advance();
      await followUps.advance(); // a second pass changes nothing
      const source = await Asset.findOne({ user: OWNER, service: 'runpod_yue2' }).lean();
      const made = await Asset.find({ user: OWNER, 'metadata.voiceOf': String(source._id) }).lean();
      assert.equal(made.length, 1);
      assert.equal(made[0].metadata.vocalUrl, 'https://assets.test/voice/f1/vocal.mp3');
      assert.match(made[0].description, /\(in my voice\)$/);
      assert.equal(source.metadata.myVoice.state, 'done');
      const project = await Project.findById(yueMine.projectId).lean();
      assert.equal(project.assets.length, 2);
      assert.equal(project.voiceCostUSD, 120 * 0.000306);
      const p = (await call('/projects', { user: OWNER, role: 'ADMIN' })).data.projects.find(
        (x) => x.id === yueMine.projectId,
      );
      assert.equal(
        p.costUSD,
        Math.round((60 * 0.000339 + 120 * 0.000306) * 1000) / 1000,
        'the take and its voice version, together',
      );
      assert.equal(p.takes.length, 2);
      assert.equal(p.takes[0].voiceOf, String(source._id));
      assert.equal(p.takes[0].vocalUrl, 'https://assets.test/voice/f1/vocal.mp3');
      assert.equal(
        'voiceNote' in p.takes[1],
        false,
        'done: nothing more to say on the source take',
      );
      const told = notified.filter((n) => /in your voice/.test(n[1]));
      assert.equal(told.length, 1);
      assert.deepEqual(told[0].slice(0, 5), [
        OWNER,
        'Warm soul with a Rhodes, in your voice',
        1,
        1,
        false,
      ]);
    },
  );

  await t.test(
    'a take is queued once, and a lost submission is marked, said on its take, and never resent',
    async () => {
      const source = await Asset.findOne({ user: OWNER, service: 'runpod_yue2' }).lean();
      const again = await followUps.queue({
        user: OWNER,
        projectId: yueMine.projectId,
        sourceAssetId: String(source._id),
        sourceJobId: 'yue_x_1',
        audioKey: 'yue2/abc/master.wav',
        title: 'x',
      });
      assert.deepEqual(again, { queued: false, reason: 'already queued' });
      const other = await Asset.create({
        user: OWNER,
        service: 'runpod_yue2',
        kind: 'audio',
        url: 'https://assets.test/yue2/def/master.mp3',
        metadata: {},
      });
      const runs = rp.voiceep.runs.length;
      rp.voiceep.failRun = true;
      const lost = await followUps.queue({
        user: OWNER,
        projectId: yueMine.projectId,
        sourceAssetId: String(other._id),
        sourceJobId: 'yue_y_1',
        audioKey: 'yue2/def/master.wav',
        title: 'y',
      });
      rp.voiceep.failRun = false;
      assert.deepEqual(lost, { queued: false, reason: 'submission unconfirmed' });
      const marked = await Asset.findById(other._id).lean();
      assert.equal(marked.metadata.myVoice.state, 'failed');
      assert.match(marked.metadata.myVoice.error, /No automatic paid retry/);
      await followUps.advance();
      assert.equal(rp.voiceep.runs.length, runs, 'never resent');
      const none = await followUps.queue({
        user: OTHER,
        projectId: yueTheirs.projectId,
        sourceAssetId: 'z',
        sourceJobId: 'yue_z_1',
        audioKey: 'yue2/z/master.wav',
        title: 'z',
      });
      assert.deepEqual(none, { queued: false, reason: 'no voice model' });
    },
  );

  await t.test(
    'takes that finish minutes apart: one notification, after the last version, counting them all',
    async () => {
      /* The first take's version used to finish while the second take was still rendering, and was announced as the whole
       * batch ("1 of 1"); the second was never announced. The notification now waits for the YuE2 request itself. */
      const YueJobs = mongoose.models.KadeYueJob;
      await YueJobs.create({
        id: 'yue_b2',
        user: OWNER,
        state: 'running',
        active: true,
        input: {},
        createdAt: new Date(),
      });
      const title = 'Two takes, minutes apart';
      const take = async (n) => {
        const asset = await Asset.create({
          user: OWNER,
          service: 'runpod_yue2',
          kind: 'audio',
          url: `https://assets.test/yue2/b2${n}/master.mp3`,
          metadata: {},
        });
        return followUps.queue({
          user: OWNER,
          projectId: yueMine.projectId,
          sourceAssetId: String(asset._id),
          sourceJobId: `yue_b2_${n}`,
          audioKey: `yue2/b2${n}/master.wav`,
          title,
        });
      };
      const toldAbout = () => notified.filter((n) => n[1] === `${title}, in your voice`);
      Object.assign(rp.voiceep, {
        status: 'COMPLETED',
        executionTime: 90000,
        output: {
          url: 'https://assets.test/voice/b2/mix.mp3',
          duration_s: 150,
          gpu: 'NVIDIA GeForce RTX 4090',
          features: ['song'],
        },
      });
      assert.equal((await take(1)).queued, true);
      await followUps.advance();
      assert.equal(toldAbout().length, 0, 'the request is still rendering its second take');
      assert.equal((await take(2)).queued, true);
      await followUps.advance();
      assert.equal(toldAbout().length, 0, 'both versions done, but the request has not ended yet');
      await YueJobs.updateOne({ id: 'yue_b2' }, { $set: { state: 'done', active: false } });
      await followUps.advance();
      await followUps.advance();
      assert.equal(toldAbout().length, 1, 'said once');
      assert.deepEqual(toldAbout()[0].slice(2, 5), [2, 2, false], 'counting both versions');
    },
  );

  await t.test(
    'fit by tempo (YUE_FIT_TEMPO=1): a YuE2 cover may run to 6:40 and says it will be sped up; Sing it in my voice keeps six minutes',
    async () => {
      const saved = { flag: process.env.YUE_FIT_TEMPO, seconds: clipSeconds };
      process.env.YUE_FIT_TEMPO = '1';
      try {
        const h = await call('/health', { user: OWNER });
        const yueCover = h.data.guide.engines.yue2.settings.find((s) => s.key === 'reference_voice_url');
        assert.match(
          yueCover.hint,
          /^Import one song, up to 6 minutes 40 seconds\. A song over six minutes is sped up a little to fit, in the same key\./,
        );
        assert.ok(
          h.data.guide.engines.yue2.howToWrite.includes(
            'A cover takes one recording up to 6 minutes 40 seconds. A song over six minutes is sped up a little to fit, in the same key. YuE2 hears its melody and makes a new arrangement, so listen for wrong notes.',
          ),
        );
        const sing = JSON.stringify(h.data.guide.engines.myvoice);
        assert.match(sing, /up to twenty megabytes and six minutes/);
        assert.doesNotMatch(sing, /6 minutes 40|sped up/, 'Sing it in my voice keeps its six minutes');

        clipSeconds = 380;
        const song = await call('/reference', {
          user: OWNER,
          body: {},
          headers: { 'x-engine': 'yue2', 'x-file-name': 'long.mp3', 'x-file-type': 'audio/mpeg' },
        });
        assert.equal(song.status, 200, JSON.stringify(song.data));
        assert.match(
          song.data.spoken,
          /^Clip imported, 380 seconds\. YuE2 sings up to six minutes, so this cover will be sped up about 8%, in the same key\./,
        );
        const mine = await call('/reference', {
          user: OWNER,
          body: {},
          headers: { 'x-engine': 'myvoice', 'x-file-name': 'long.mp3', 'x-file-type': 'audio/mpeg' },
        });
        assert.equal(mine.status, 400);
        assert.equal(
          mine.data.error,
          'This recording is 6 minutes 20 seconds long. Sing it in my voice takes recordings up to 6 minutes. Import a shorter recording or an excerpt; your original will not be trimmed automatically.',
        );
        clipSeconds = 355;
        const short = await call('/reference', {
          user: OWNER,
          body: {},
          headers: { 'x-engine': 'myvoice', 'x-file-name': 'short.mp3', 'x-file-type': 'audio/mpeg' },
        });
        assert.equal(short.status, 200);
        assert.doesNotMatch(short.data.spoken, /sped up/);

        // Before a render: a YuE2 cover is checked against a cover's limit; Sing it in my voice against six minutes.
        referenceChecks.length = 0;
        const cover = await call('/render', {
          user: OWNER,
          body: { engine: 'yue2', script: 'Warm soul', lyrics: '[Verse]\nla la', reference_voice_url: url, estimateOnly: true },
        });
        assert.equal(cover.status, 200, JSON.stringify(cover.data));
        const voiceQuote = await call('/render', {
          user: OWNER,
          body: { engine: 'myvoice', reference_voice_url: url, voice_source: 'Just a vocal', estimateOnly: true },
        });
        assert.equal(voiceQuote.status, 200, JSON.stringify(voiceQuote.data));
        // (made inside the booth's vm, so compared through JSON: undefined in an array reads as null)
        assert.equal(JSON.stringify(referenceChecks), '[{"yueCover":true},null]');
        assert.equal(referenceChecks[1], undefined, 'Sing it in my voice passes nothing: six minutes');
      } finally {
        if (saved.flag === undefined) delete process.env.YUE_FIT_TEMPO;
        else process.env.YUE_FIT_TEMPO = saved.flag;
        clipSeconds = saved.seconds;
      }
    },
  );

  await t.test(
    'a YuE2 take cut at its length limit says so on the take and in the library, not "may end early"',
    async () => {
      const SOMEONE = '6a0000000000000000000003';
      Object.assign(rp.yueep, { status: 'IN_QUEUE' });
      const r = await call('/render', {
        user: SOMEONE,
        body: { engine: 'yue2', script: 'Slow country waltz', lyrics: '[Verse]\nla la la' },
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      Object.assign(rp.yueep, {
        status: 'COMPLETED',
        executionTime: 60000,
        output: {
          url: 'https://assets.test/yue2/cut/master.mp3',
          wav_url: 'https://assets.test/yue2/cut/master.wav',
          duration_s: 360,
          truncated: true,
          gpu: 'NVIDIA A40',
          features: ['keep-harmony'],
        },
      });
      const cut =
        'YuE2 had not finished when it reached its length limit, so this take stops abruptly at six minutes. Try another take.';
      const s = await call('/status/' + r.data.jobId, { user: SOMEONE });
      assert.equal(s.data.state, 'done');
      assert.equal(s.data.spoken, `1 of 1 takes ready. Open your library to compare them. ${cut}`);
      const asset = await Asset.findOne({ user: SOMEONE, service: 'runpod_yue2' }).lean();
      assert.equal(asset.metadata.truncated, true);
      assert.equal(asset.metadata.takeNote, cut);
      const listed = (await call('/projects', { user: SOMEONE })).data.projects.find((x) => x.id === r.data.projectId);
      assert.equal(listed.takes[0].note, cut);
      assert.doesNotMatch(JSON.stringify(listed), /Kade/);
    },
  );

  await t.test('with the flag off, even the owner sees and reaches nothing', async () => {
    process.env.MY_VOICE_ENABLED = '0';
    try {
      assert.doesNotMatch(JSON.stringify((await call('/health', { user: OWNER })).data), SAYS_IT);
      const r = await call('/render', {
        user: OWNER,
        body: { engine: 'myvoice', reference_voice_url: url },
      });
      assert.deepEqual(r.data, { error: 'There is nothing to render yet.' });
    } finally {
      process.env.MY_VOICE_ENABLED = '1';
    }
  });
});
