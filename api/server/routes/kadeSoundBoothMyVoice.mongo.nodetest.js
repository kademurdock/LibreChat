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
  let clipSeconds = 181.2;
  const api = {
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
    validateMusicReference: async (_user, url) => url,
    musicReferenceSeconds: async () => 180,
    registerMusicReference: async () => {},
    musicReferenceError: (s) =>
      s > 360
        ? `This recording is 6 minutes ${Math.round(s) - 360} seconds long. Covers support up to 6 minutes. Import a shorter recording or an excerpt; your original will not be trimmed automatically.`
        : undefined,
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
          extractor: 'bs_roformer',
          lead_split: true,
          dereverb: true,
          index_rate: 0.5,
          protect: 0.33,
          rms_mix_rate: 0.25,
          fallback: 'demucs',
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
          extractor: 'bs_roformer',
          lead_split: true,
          dereverb: true,
          index_rate: 0.5,
          protect: 0.33,
          rms_mix_rate: 0.25,
          fallback: 'demucs',
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
