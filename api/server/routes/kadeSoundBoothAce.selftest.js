'use strict';
/* ACE-Step XL (Oct 10 2026) through the booth route: the real kadeSoundBooth.js in a vm, the real jobs.ts and
 * ace.ts router on an in-memory Mongo, RunPod stood in by an axios adapter. Nothing leaves this process.
 *
 * What it proves, in order: with ACE_ENABLED unset the guide, /health, the projects list and the handling of
 * every other engine are byte-identical to a booth that has no ACE at all; a request for engine ace is refused
 * in a plain sentence; with the flag on and admin-only on (the default) only an admin sees the card or queues
 * a take; one request becomes one RunPod job of exactly the worker contract; the answer, shaped like the
 * worker's (take 0 at the top level plus `takes`), is saved once as a library asset with service runpod_ace
 * and a YuE2-shaped metadata block; the cost comes from the card the worker names; a worker error, a
 * second request, a cancel and a flag turned off mid-flight all behave. The lyrics are invented placeholders. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

require.extensions['.ts'] = (mod, filename) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
const ace = require('../../../packages/api/src/music/ace.ts');
const { yueSinging } = require('../../../packages/api/src/music/yue.ts');
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');

const ENDPOINT = 'https://api.runpod.ai/v2/acefixture/';
const FLAGS = ['ACE_ENABLED', 'ACE_ADMIN_ONLY', 'ACE_DEFAULT_MODEL', 'ACE_MAX_SECONDS', 'ACE_ENDPOINT_ID', 'RUNPOD_API_KEY', 'YUE_ENDPOINT_ID', 'FAL_KEY', 'BRIDGE_SECRET'];
const LYRICS = '[Verse]\nWalking home in the rain\n[Chorus]\nHold on, hold on\n(hold on)';
const DIRECTION = 'Slow soul, 88 BPM, Rhodes and brushed drums, a warm alto';

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/* The booth route in a vm, with a hand-written @librechat/api. With `withAce` the real ace.ts exports are in it;
 * without, it is the booth as it was before ACE (every ACE check answers no, nothing is mounted). */
function loadBooth({ withAce, assetRows, logs, requires = {} }) {
  const module = { exports: {} };
  const localRequire = (name) => {
    if (Object.prototype.hasOwnProperty.call(requires, name)) return requires[name];
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn: (line) => logs.push(String(line)), error: (...args) => logs.push(`ERROR ${args.map((a) => (a && a.stack) || String(a)).join(' ')}`) } };
    if (name === '@librechat/api') {
      const api = {
        needsRefresh: () => false,
        getNewS3URL: async (url) => url,
        saveBufferToS3: async () => 'https://storage.test/saved',
        /* YuE2's router: its /render takes engine yue2 and hands back what it was given. */
        createYueRouter: () => {
          const yue = express.Router();
          yue.post('/render', express.json(), (req, res, next) => (req.body && req.body.engine === 'yue2' ? res.json({ yueSaw: req.body }) : next()));
          return yue;
        },
        yueConfigured: () => false,
        writingCost: () => ({ costUSD: 0, measured: false }),
        splitLyricTitle: (text) => ({ script: text }),
        lyricTitleFromSong: () => undefined,
        musicWritingSettings: () => ({}),
        musicWritingBackground: () => false,
        labelReadback: (text) => text,
        lyricShapeIssue: () => null,
        fixStageDirections: (text) => text,
        musicWritingPrompt: async (system) => system,
        yueStyles: {},
        yueStylesEnabled: () => false,
        yueCost: 'test price',
        yueCoverSettings: (settings) => settings,
        yueCoverOptions: () => ({}),
        yueSavedOptions: (options) => options,
        yueProjectWhy: () => 'YuE2 — a song made on the sleeping music GPU',
        yueTakeFacts: () => ({}),
        musicCoverLengthGuide: (yue) => yue,
        musicReferenceSpeedNote: () => '',
        effectsGuide: { name: 'Stable Audio', settings: [], howToWrite: [] },
        effectsConfigured: () => false,
        effectsVariant: () => ({ name: 'Stable Audio', model: 'stable', price: 0 }),
        notifyMusic: async () => ({ accepted: 0 }),
        familyFeatures: () => ({ trainedStyles: false }),
        audioAssetDescription: (asset) => asset.description || '',
        ...(withAce
          ? {
              createAceRouter: ace.createAceRouter, aceEnabled: ace.aceEnabled, aceConfigured: ace.aceConfigured, aceAllowed: ace.aceAllowed, aceAccess: ace.aceAccess,
              withAceGuide: ace.withAceGuide, aceProjectOptions: ace.aceProjectOptions, aceProjectWhy: ace.aceProjectWhy, aceTakeFacts: ace.aceTakeFacts,
            }
          : {}),
      };
      return new Proxy(api, {
        get(target, key) {
          if (key in target) return target[key];
          if (/^create\w*Router$/.test(String(key))) return () => express.Router();
          return undefined;
        },
      });
    }
    if (name === '~/server/services/kadeJevJudges') return {};
    if (name === '~/server/utils/kadeSongAudience') return { ...require(path.join(__dirname, '..', 'utils', 'kadeSongAudience.js')), songAudience: async () => 'explicit' };
    if (name === '~/models') return { getAgent: async () => null };
    if (name === '~/server/middleware') {
      return {
        requireJwtAuth: (req, _res, next) => {
          req.user = { id: String(req.headers['x-test-user']), role: String(req.headers['x-test-role'] || 'USER') };
          next();
        },
      };
    }
    if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: Project };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async () => undefined, KadeUsage: {} };
    if (name === '~/models/kadeAsset') return { logKadeAsset: async () => ({ _id: new mongoose.Types.ObjectId() }), KadeAsset: assetStore(assetRows) };
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(source, {
    require: localRequire, module, exports: module.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return module;
}

/* Just enough of the KadeAsset model: an upsert keyed the way the complete hook keys it, and the two reads GET /projects makes. */
function assetStore(rows) {
  const same = (a, b) => String(a) === String(b);
  return {
    async findOneAndUpdate(filter, update) {
      let row = rows.find((r) => same(r.user, filter.user) && r.service === filter.service && same(r.metadata && r.metadata.jobId, filter['metadata.jobId']));
      if (!row) {
        row = { _id: new mongoose.Types.ObjectId(), ...JSON.parse(JSON.stringify(update.$setOnInsert)), createdAt: new Date(0) };
        rows.push(row);
      }
      return row;
    },
    find(filter) {
      const ids = filter._id && filter._id.$in ? filter._id.$in.map(String) : null;
      const jobs = filter['metadata.jobId'] && filter['metadata.jobId'].$in ? filter['metadata.jobId'].$in.map(String) : null;
      const hit = rows.filter((r) => same(r.user, filter.user) && (!ids || ids.includes(String(r._id))) && (!jobs || jobs.includes(String(r.metadata && r.metadata.jobId))));
      const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => hit };
      return chain;
    },
  };
}

/* RunPod: every call is recorded; a job answers with whatever state and output the test has set for it. */
function fakeRunpod() {
  const runpod = { runs: [], jobs: new Map(), unexpected: [], failSubmit: false };
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (!url.startsWith(ENDPOINT)) {
      runpod.unexpected.push(url);
      throw new Error(`unexpected call to ${url}`);
    }
    const rest = url.slice(ENDPOINT.length);
    if (rest === 'run') {
      if (runpod.failSubmit) throw new Error('lost response');
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
      const id = `prov${runpod.runs.length + 1}`;
      runpod.runs.push({ id, body, headers: config.headers, method: config.method });
      runpod.jobs.set(id, { state: 'IN_QUEUE', executionTime: 60000, delayTime: 1500 });
      return reply({ id });
    }
    const [verb, id] = rest.split('/');
    const job = runpod.jobs.get(id);
    if (!job) throw Object.assign(new Error('no such job'), { response: { status: 404 } });
    if (verb === 'cancel') job.state = 'CANCELLED';
    return reply(verb === 'cancel' ? { id } : { id, status: job.state, executionTime: job.executionTime, delayTime: job.delayTime, output: job.state === 'COMPLETED' ? job.output : undefined });
  };
  return runpod;
}

/* A worker answer shaped like the contract: take 0 at the top level, every take in `takes`. */
function workerAnswer(seed, extra = {}) {
  const folder = `ace/${String(seed).padStart(8, '0')}-aaaa-4bbb-8ccc-000000000000`;
  const take = { key: `${folder}/master.mp3`, wav_key: `${folder}/master.wav`, url: `https://assets.test/${folder}/master.mp3?X-Amz-Signature=a`, wav_url: `https://assets.test/${folder}/master.wav?X-Amz-Signature=a`, duration_s: 94.6, bytes: 3784000 };
  return {
    engine: 'ace', model: 'xl-turbo', ...take, seed, processing_ms: 21000, truncated: false,
    takes: [{ index: 0, seed, ...take }],
    timing: { model_load_s: 0, plan_s: 2.4, render_s: 15.1, encode_s: 1.6, upload_s: 1.2 }, memory: { render_peak_gib: 22.5 },
    gpu: 'NVIDIA RTX A6000', features: ['ace-xl-turbo', 'ace-xl-sft', 'batch', 'instrumental', 'probe'],
    versions: { ace_step_commit: 'ca1e85f', torch: '2.8.0+cu128', worker: 'ace-1' }, worker_notes: ['Used 8 steps.'],
    plan: { bpm: 88, keyscale: 'A minor', duration: 95 }, ...extra,
  };
}

test('ACE-Step XL through the booth route', async (t) => {
  const saved = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  setEnv({ ACE_ENABLED: undefined, ACE_ADMIN_ONLY: undefined, ACE_DEFAULT_MODEL: undefined, ACE_MAX_SECONDS: undefined, YUE_ENDPOINT_ID: undefined, FAL_KEY: undefined, BRIDGE_SECRET: undefined, ACE_ENDPOINT_ID: undefined, RUNPOD_API_KEY: undefined });
  const mongo = await MongoMemoryServer.create();
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
    await mongo.stop();
    setEnv(saved);
  });
  await mongoose.connect(mongo.getUri());
  const runpod = fakeRunpod();
  const logs = [];
  const assetRows = [];
  const requires = { '../services/kadeRealCost': { userPriceFactor: (role) => (String(role).toUpperCase() === 'ADMIN' ? 1 : 3) } };
  /* Four boots of the same route: no ACE in the booth at all; ACE in it with nothing set (how it ships); an endpoint but
   * no flag (the flag switched off again); and the flag on. The router is only made for the last two. */
  const plainBooth = loadBooth({ withAce: false, assetRows: [], logs, requires });
  const idleBooth = loadBooth({ withAce: true, assetRows: [], logs, requires });
  assert.equal(plainBooth.exports._internals.ACE_READY, false);
  assert.equal(idleBooth.exports._internals.ACE_READY, true);
  assert.equal(idleBooth.exports._internals.ACE_MOUNT, false, 'nothing set: no ACE router');
  assert.equal('KadeAceJob' in mongoose.models, false, 'nothing set: no ACE job model, no collection, no index, no timer');
  setEnv({ ACE_ENDPOINT_ID: 'acefixture', RUNPOD_API_KEY: 'fixture' });
  const standbyBooth = loadBooth({ withAce: true, assetRows: [], logs, requires });
  assert.equal(standbyBooth.exports._internals.ACE_MOUNT, true, 'an endpoint alone keeps queued takes followed');
  setEnv({ ACE_ENABLED: '1' });
  const booth = loadBooth({ withAce: true, assetRows, logs, requires });
  setEnv({ ACE_ENABLED: undefined });
  assert.equal(booth.exports._internals.ACE_MOUNT, true);
  const app = express();
  for (const [prefix, mounted] of [['/plain', plainBooth], ['/idle', idleBooth], ['/standby', standbyBooth], ['/live', booth]]) app.use(prefix, mounted.exports);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const id = () => new mongoose.Types.ObjectId().toString();
  const ADMIN = id(), ADMIN_2 = id(), ADMIN_3 = id(), ADMIN_4 = id(), MEMBER = id(), MEMBER_2 = id();
  const call = async (route, { body, user, role = 'USER', prefix = '/live' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${prefix}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-test-user': user, 'x-test-role': role },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, data };
  };
  const asAdmin = (extra = {}) => ({ user: ADMIN, role: 'ADMIN', ...extra });
  const asMember = (extra = {}) => ({ user: MEMBER, role: 'USER', ...extra });
  const aceJobs = () => mongoose.connection.db.collection('kadeacejobs');
  const song = { engine: 'ace', script: DIRECTION, lyrics: LYRICS, title: 'Rain song', seed: 5 };
  const nothingStarted = async () => {
    assert.equal(runpod.runs.length, 0, 'no RunPod call');
    assert.equal(await Project.countDocuments({ engine: 'ace' }), 0, 'no project row');
    assert.equal(await aceJobs().countDocuments(), 0, 'no ACE job');
  };

  /* A few rows another engine made, so the projects list has something to compare. */
  await Project.create({ user: ADMIN, engine: 'yue2', title: 'Old YuE2 song', script: 'Soul', options: { lyrics: 'la', count: 1 }, state: 'done', costUSD: 0.03 });
  await Project.create({ user: ADMIN, engine: 'lyria', title: 'Old Lyria song', script: 'Folk brief', state: 'done', costUSD: 0.08 });
  await Project.create({ user: MEMBER, engine: 'stable', title: 'Rain', script: 'Rain on a roof', options: { duration: 10 }, state: 'done' });

  await t.test('ACE_ENABLED unset: the guide, /health and the projects list are byte-identical to a booth with no ACE', async () => {
    for (const prefix of ['/idle', '/standby', '/live']) {
      for (const who of [asAdmin(), asMember()]) {
        const before = await call('/health', { ...who, prefix: '/plain' });
        const after = await call('/health', { ...who, prefix });
        assert.equal(before.status, 200);
        assert.equal(after.text, before.text, `/health for ${who.role} on ${prefix}`);
        assert.deepEqual(Object.keys(after.data.guide.engines), ['scenema', 'stable', 'yue2', 'lyria', 'seed']);
        assert.deepEqual(Object.keys(after.data.engines), ['scenema', 'seed', 'stable', 'yue2', 'lyria']);
        assert.equal('ace' in after.data.guide.engines, false);
        const listed = await call('/projects', { ...who, prefix: '/plain' });
        const listedAfter = await call('/projects', { ...who, prefix });
        assert.equal(listed.status, 200, logs.filter((line) => line.startsWith('ERROR')).slice(-1).join());
        assert.equal(listedAfter.text, listed.text, `/projects for ${who.role} on ${prefix}`);
      }
    }
    await nothingStarted();
  });

  await t.test('ACE_ENABLED unset: every other engine is handled exactly as before', async () => {
    const yue = { engine: 'yue2', script: 'Soul', lyrics: 'la la' };
    for (const prefix of ['/idle', '/standby', '/live']) {
      const before = await call('/render', { body: yue, ...asAdmin({ prefix: '/plain' }) });
      const after = await call('/render', { body: yue, ...asAdmin({ prefix }) });
      assert.equal(after.status, 200);
      assert.equal(after.text, before.text, 'YuE2 reaches its own router unchanged');
      for (const body of [{ engine: 'seed', script: 'A short scene.' }, { engine: 'scenema', script: 'Hello there.' }, { engine: 'lyria', script: 'A slow soul record.' }, { engine: 'nonesuch', script: 'x' }, { script: 'No engine at all' }]) {
        const was = await call('/render', { body, ...asMember({ prefix: '/plain' }) });
        const now = await call('/render', { body, ...asMember({ prefix }) });
        assert.equal(now.status, was.status, `${prefix} ${JSON.stringify(body)}`);
        assert.equal(now.text, was.text, `${prefix} ${JSON.stringify(body)}`);
      }
    }
    await nothingStarted();
  });

  await t.test('ACE_ENABLED unset: a request for ace is refused in one plain sentence, even for an admin', async () => {
    for (const prefix of ['/idle', '/standby', '/live']) {
      for (const who of [asAdmin(), asMember(), { user: id(), role: 'ADMIN' }]) {
        const res = await call('/render', { body: song, ...who, prefix });
        assert.equal(res.status, 403, prefix);
        assert.deepEqual(res.data, { error: 'ACE-Step XL is not turned on yet.' });
      }
    }
    for (const value of ['0', 'true', '', 'on']) {
      setEnv({ ACE_ENABLED: value });
      assert.equal((await call('/render', { body: song, ...asAdmin() })).status, 403, `ACE_ENABLED=${JSON.stringify(value)}`);
    }
    setEnv({ ACE_ENABLED: undefined });
    assert.equal((await call('/render', { body: { ...song, estimateOnly: true }, ...asAdmin() })).status, 403, 'not even a price quote');
    assert.ok(logs.some((line) => /ace REFUSED/.test(line)), 'the refusal is logged');
    await nothingStarted();
  });

  await t.test('a booth that started with ACE off never lets an ace request fall through to another engine', async () => {
    setEnv({ ACE_ENABLED: '1' });
    try {
      const res = await call('/render', { body: song, ...asAdmin({ prefix: '/idle' }) });
      assert.equal(res.status, 503);
      assert.deepEqual(res.data, { error: 'ACE-Step XL is not configured yet.' });
      assert.equal((await call('/render', { body: song, ...asMember({ prefix: '/idle' }) })).status, 403);
    } finally {
      setEnv({ ACE_ENABLED: undefined });
    }
    await nothingStarted();
  });

  await t.test('ACE_ENABLED=1, admin-only by default: an admin sees the card, everyone else sees today\'s guide', async () => {
    setEnv({ ACE_ENABLED: '1' });
    const admin = await call('/health', asAdmin());
    assert.deepEqual(Object.keys(admin.data.guide.engines), ['scenema', 'stable', 'yue2', 'lyria', 'seed', 'ace'], 'the card is last');
    assert.deepEqual(admin.data.guide.engines.ace, ace.aceGuide(process.env));
    assert.equal(admin.data.guide.engines.ace.name, 'ACE-Step XL');
    assert.deepEqual(admin.data.engines.ace, { configured: true, queued: true, model: 'ACE-Step 1.5 XL' });
    const plain = await call('/health', { ...asAdmin(), prefix: '/plain' });
    const { ace: _card, ...restOfGuide } = admin.data.guide.engines;
    assert.deepEqual(restOfGuide, plain.data.guide.engines, 'every other card is untouched');
    const { ace: _engine, ...restOfEngines } = admin.data.engines;
    assert.deepEqual(restOfEngines, plain.data.engines);
    for (const who of [asMember(), { user: MEMBER_2, role: 'USER' }]) {
      const member = await call('/health', who);
      const memberPlain = await call('/health', { ...who, prefix: '/plain' });
      assert.equal(member.text, memberPlain.text, 'a member of the family sees exactly what they saw before');
    }
    setEnv({ ACE_ENDPOINT_ID: undefined });
    assert.equal((await call('/health', asAdmin())).data.engines.ace.configured, false, 'the card is there, and says it is not configured');
    assert.ok((await call('/health', asAdmin())).data.guide.engines.ace, 'the card does not depend on the endpoint');
    setEnv({ ACE_ENDPOINT_ID: 'acefixture' });
  });

  await t.test('ACE_ENABLED=1: a member of the family is refused, an admin is not, nothing is started by a refusal', async () => {
    const member = await call('/render', { body: song, ...asMember() });
    assert.equal(member.status, 403);
    assert.deepEqual(member.data, { error: 'ACE-Step XL is not open to your account yet.' });
    assert.equal((await call('/render', { body: { ...song, estimateOnly: true }, ...asMember() })).status, 403);
    await nothingStarted();
    const quote = await call('/render', { body: { ...song, estimateOnly: true }, ...asAdmin() });
    assert.equal(quote.status, 200);
    assert.equal(quote.data.ok, true);
    assert.equal(quote.data.estimate.spoken, ace.aceEstimate(ace.aceInput({ ...song }, process.env)));
    assert.match(quote.data.estimate.spoken, /^About 30 seconds of music, fast quality\. ACE-Step XL does not deduct from your credit balance/);
    assert.equal(quote.data.queued, undefined, 'a quote queues nothing');
    await nothingStarted();
  });

  await t.test('the plain refusals: a sheet over 4096 characters, a recording, a bad choice; no job, no row, no RunPod call', async () => {
    const refused = async (body, error) => {
      const res = await call('/render', { body: { ...song, ...body }, ...asAdmin() });
      assert.equal(res.status, 400, JSON.stringify(Object.keys(body)));
      assert.deepEqual(res.data, { error });
    };
    await refused({ lyrics: 'a'.repeat(4097) }, 'Those lyrics are 4097 characters; ACE-Step XL reads at most 4096. Cut a verse or a repeated chorus and try again.');
    await refused({ lyrics: '' }, 'Add the words to sing in Lyrics, or choose Instrumental under Singing or instrumental.');
    await refused({ reference_voice_url: 'https://assets.test/take.wav', referenceExpected: true }, 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.');
    await refused({ quality: 'Great' }, 'Under Quality, choose Fast or Best.');
    await refused({ length: '9:00' }, 'Choose a length up to 6:00.');
    await refused({ script: 'ab' }, 'Describe the music in 3 to 3000 characters.');
    await refused({ seed: -4 }, 'Seed must be a whole number from 0 to 2147483647.');
    await nothingStarted();
    const exact = await call('/render', { body: { ...song, lyrics: 'a'.repeat(4096), estimateOnly: true }, ...asAdmin() });
    assert.equal(exact.status, 200, '4096 characters are not refused');
  });

  let first;
  await t.test('one request becomes one RunPod job of exactly the worker contract, and a project row', async () => {
    const res = await call('/render', { body: { ...song, quality: 'Best', length: '3:00', sourceText: 'my notes', count: 4, abc: 'X:1', band: 'soul' }, ...asAdmin() });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.queued, true);
    assert.equal(res.data.engine, 'ace');
    assert.match(res.data.jobId, /^ace_[0-9a-f-]{36}$/);
    assert.equal(runpod.runs.length, 1, 'count 4 is still one take');
    const run = runpod.runs[0];
    assert.equal(run.method, 'post');
    assert.equal(run.headers.Authorization, 'Bearer fixture');
    assert.deepEqual(run.body.input, { model: 'xl-sft', caption: 'Slow soul, Rhodes and brushed drums, a warm alto', lyrics: LYRICS, duration: 180, seed: 5, batch_size: 1, bpm: 88 });
    assert.deepEqual(run.body.policy, { executionTimeout: 1200000, ttl: 7200000 });
    assert.deepEqual(Object.keys(run.body).sort(), ['input', 'policy']);
    const project = await Project.findById(res.data.projectId).lean();
    assert.equal(project.engine, 'ace', 'the project enum takes ace');
    assert.equal(String(project.user), ADMIN);
    assert.equal(project.title, 'Rain song');
    assert.equal(project.script, DIRECTION, 'Music direction is kept as typed, tempo and all');
    assert.equal(project.sourceText, 'my notes');
    assert.equal(project.state, 'queued');
    assert.deepEqual(project.options, { quality: 'Best', length: '3:00', singing: yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 5 });
    assert.deepEqual(project.jobs, [res.data.jobId]);
    const stored = await aceJobs().findOne({ id: res.data.jobId });
    assert.equal(stored.takes.length, 1);
    assert.equal(stored.takes[0].id, `${res.data.jobId}_1`);
    assert.equal(stored.takes[0].seed, 5);
    assert.equal(stored.takes[0].providerId, 'prov1');
    first = { ...res.data, take: stored.takes[0].id };
  });

  await t.test('a second request from the same person waits; another person is not held up', async () => {
    const again = await call('/render', { body: song, ...asAdmin() });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /^You already have an ACE-Step XL request in progress\. Wait for it before making another\.$/);
    assert.equal(runpod.runs.length, 1);
    const other = await call('/render', { body: { ...song, seed: 6 }, user: ADMIN_2, role: 'ADMIN' });
    assert.equal(other.status, 200, 'one active job per person, not per engine');
    assert.equal(runpod.runs.length, 2);
    assert.equal(runpod.runs[1].body.input.model, 'xl-turbo');
    assert.equal(runpod.runs[1].body.input.duration, 30, 'Match my lyrics: three sung lines make the 30 second floor');
    runpod.jobs.get('prov2').state = 'CANCELLED';
    await call(`/status/${other.data.jobId}`, { user: ADMIN_2, role: 'ADMIN' });
  });

  await t.test('status: queued, running, then done; the take is saved once as a library asset shaped like a YuE2 take', async () => {
    const mine = (route) => call(route, asAdmin());
    let status = await mine(`/status/${first.jobId}`);
    assert.equal(status.data.state, 'queued');
    assert.match(status.data.spoken, /^0 of 1 takes ready\. ACE-Step XL is composing\./);
    assert.equal((await call(`/status/${first.jobId}`, { user: MEMBER, role: 'USER' })).status, 404, 'another person cannot read it');
    runpod.jobs.get('prov1').state = 'IN_PROGRESS';
    status = await mine(`/status/${first.jobId}`);
    assert.equal(status.data.state, 'running');
    const answer = workerAnswer(5);
    Object.assign(runpod.jobs.get('prov1'), { state: 'COMPLETED', output: answer, executionTime: 60000 });
    status = await mine(`/status/${first.jobId}`);
    assert.equal(status.data.state, 'done');
    assert.equal(status.data.url, answer.url);
    assert.equal(status.data.durationS, 94.6);
    assert.equal(status.data.spoken, '1 of 1 takes ready. Open your library to compare them.');
    await mine(`/status/${first.jobId}`);
    assert.equal(assetRows.length, 1, 'polled again, still one asset');
    const [asset] = assetRows;
    assert.equal(asset.service, 'runpod_ace');
    assert.equal(asset.kind, 'audio');
    assert.equal(asset.url, answer.url, 'the MP3 is the take');
    assert.equal(asset.model, 'ACE-Step 1.5 XL');
    assert.equal(asset.prompt, DIRECTION);
    assert.equal(asset.description, 'Rain song');
    assert.equal(String(asset.user), ADMIN);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
    near(asset.costUSD, 60 * 0.000339);
    assert.deepEqual(asset.metadata, {
      title: 'Rain song', seed: 5, jobId: first.take, projectId: first.projectId, via: 'sound-booth',
      wavUrl: answer.wav_url, seconds: 95, lyrics: LYRICS, truncated: false,
      costScope: 'execution estimate; startup and idle are additional',
      gpu: 'NVIDIA RTX A6000', model: 'xl-turbo', bpm: 88, keyscale: 'A minor',
      weirdness: 50, guidance: 1,
    });
    const project = await Project.findById(first.projectId).lean();
    assert.equal(project.state, 'done');
    assert.deepEqual(project.assets, [String(asset._id)]);
    near(project.costUSD, 60 * 0.000339);
    const stored = await aceJobs().findOne({ id: first.jobId });
    assert.equal(stored.active, false);
    assert.equal(stored.takes[0].output.queue_ms, 1500, 'the wait for a GPU is kept beside the take');
    assert.equal(stored.takes[0].output.execution_ms, 60000);
    assert.deepEqual(stored.takes[0].output.takes[0].seed, 5);
    near(stored.takes[0].costUSD, 60 * 0.000339);
  });

  await t.test('the library: the row says what made it, costs are real for an ACE take, and nothing carries to a missing engine', async () => {
    const list = await call('/projects', asAdmin());
    assert.equal(list.status, 200);
    const row = list.data.projects.find((p) => p.engine === 'ace');
    assert.equal(row.why, 'ACE-Step XL — a song made on the sleeping music GPU, best quality');
    assert.deepEqual(row.options, { quality: 'Best', length: '3:00', singing: yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 5 });
    assert.equal(row.script, DIRECTION);
    assert.deepEqual(row.carryTo.map((d) => d.engine), ['lyria', 'yue2'], 'an admin can carry an ACE project to the other song engines');
    assert.equal(row.takes.length, 1);
    assert.equal(row.takes[0].url, assetRows[0].url);
    assert.equal(row.takes[0].masterUrl, assetRows[0].metadata.wavUrl);
    assert.equal(row.takes[0].seconds, 95);
    assert.equal(row.takes[0].note, '');
    assert.equal(row.takes[0].title, 'Rain song');
    assert.deepEqual(list.data.projects.find((p) => p.engine === 'yue2').carryTo.map((d) => d.engine), ['lyria', 'ace'], 'and a YuE2 project can be carried to ACE, for this admin only');
    assert.deepEqual(list.data.projects.find((p) => p.engine === 'lyria').carryTo.map((d) => d.engine), ['yue2', 'ace']);
    const one = await call(`/projects/${row.id}`, asAdmin());
    assert.equal(one.data.project.engine, 'ace');
    /* Her family are charged the platform factor; ACE is a trial Kade pays for, like YuE2, so it is quoted real. */
    const view = booth.exports._internals.projectView;
    const aceRow = { _id: row.id, engine: 'ace', title: 't', script: 's', options: {}, costUSD: 0.02, state: 'done' };
    assert.equal(view(aceRow, 3).costUSD, 0.02, 'ace: not multiplied');
    assert.equal(view({ ...aceRow, engine: 'yue2' }, 3).costUSD, 0.02);
    assert.equal(view({ ...aceRow, engine: 'lyria' }, 3).costUSD, 0.06, 'a Lyria row is multiplied');
    assert.equal(view(aceRow, 3, { ace: true }).engine, 'ace');
    assert.equal(view({ ...aceRow, engine: 'ace', options: undefined }, 1).why, 'ACE-Step XL — a song made on the sleeping music GPU');
  });

  await t.test('a worker that answers with an error becomes a failed take with its own sentence; nothing is saved', async () => {
    const res = await call('/render', { body: { ...song, seed: 11 }, user: ADMIN_3, role: 'ADMIN' });
    assert.equal(res.status, 200);
    const sentence = 'The music model ran out of memory. Try a shorter length.';
    Object.assign(runpod.jobs.get('prov3'), { state: 'COMPLETED', output: { error: sentence, gpu: 'NVIDIA RTX A6000' }, executionTime: 12000 });
    const rowsBefore = assetRows.length;
    const status = await call(`/status/${res.data.jobId}`, { user: ADMIN_3, role: 'ADMIN' });
    assert.equal(status.data.state, 'failed');
    assert.equal(status.data.error, `0 of 1 takes saved. ${sentence}`);
    assert.equal(status.data.spoken, `0 of 1 takes saved. ${sentence}`);
    assert.equal(assetRows.length, rowsBefore);
    const project = await Project.findById(res.data.projectId).lean();
    assert.equal(project.state, 'failed');
    assert.equal(project.lastError, `0 of 1 takes saved. ${sentence}`);
    assert.equal(project.assets.length, 0);
    /* Failed jobs free the person to try again at once. */
    assert.equal((await call('/render', { body: { ...song, seed: 12, estimateOnly: true }, user: ADMIN_3, role: 'ADMIN' })).status, 200);
    const again = await call('/render', { body: { ...song, seed: 12 }, user: ADMIN_3, role: 'ADMIN' });
    assert.equal(again.status, 200, 'a failed request does not block the next one');
    runpod.jobs.get('prov4').state = 'CANCELLED';
    await call(`/status/${again.data.jobId}`, { user: ADMIN_3, role: 'ADMIN' });
  });

  await t.test('a submission that cannot be confirmed is said, not retried, and an instrumental sends the tag the worker reads', async () => {
    runpod.failSubmit = true;
    const lost = await call('/render', { body: { ...song, seed: 21 }, user: ADMIN_4, role: 'ADMIN' });
    runpod.failSubmit = false;
    assert.equal(lost.status, 502);
    assert.match(lost.data.error, /Could not confirm whether one take started/);
    assert.equal(runpod.runs.length, 4, 'no automatic retry');
    assert.equal((await Project.findById(lost.data.projectId).lean()).state, 'failed', 'an unconfirmed take shows as failed on the project');
    /* ADMIN_4 is held (an unconfirmed take may be running); another admin sends an instrumental. */
    const played = await call('/render', { body: { engine: 'ace', script: 'Banjo breakdown, 140 bpm', singing: yueSinging.instrumental, lyrics: LYRICS, seed: 30 }, user: ADMIN_2, role: 'ADMIN' });
    assert.equal(played.status, 200, played.text);
    assert.deepEqual(runpod.runs.at(-1).body.input, { model: 'xl-turbo', caption: 'Banjo breakdown', lyrics: '[Instrumental]', duration: 120, seed: 30, batch_size: 1, bpm: 140 });
    const project = await Project.findById(played.data.projectId).lean();
    assert.equal(project.options.singing, yueSinging.instrumental);
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(30, { plan: undefined, model: 'xl-sft' }), executionTime: 30000 });
    const done = await call(`/status/${played.data.jobId}`, { user: ADMIN_2, role: 'ADMIN' });
    assert.equal(done.data.state, 'done');
    const asset = assetRows.at(-1);
    assert.equal(asset.metadata.lyrics, '', 'an instrumental keeps no lyrics on the asset: its sheet was not sung');
    assert.equal(asset.metadata.instrumental, true);
    assert.equal(asset.metadata.model, 'xl-sft');
    assert.equal('bpm' in asset.metadata, false, 'only what the worker reported');
    assert.equal(ace.aceProjectWhy(project.options), 'ACE-Step XL — an instrumental made on the sleeping music GPU');
  });

  await t.test('an answer that lists its takes without take 0 at the top level still finishes as a song', async () => {
    const res = await call('/render', { body: { ...song, seed: 61 }, user: id(), role: 'ADMIN' });
    assert.equal(res.status, 200);
    const { key: _key, wav_key: _wavKey, url: _url, wav_url: _wavUrl, duration_s: _seconds, bytes: _bytes, seed: _seed, ...listed } = workerAnswer(61);
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: listed, executionTime: 20000 });
    const rows = assetRows.length;
    const owner = (await Project.findById(res.data.projectId).lean()).user;
    const status = await call(`/status/${res.data.jobId}`, { user: String(owner), role: 'ADMIN' });
    assert.equal(status.data.state, 'done');
    assert.equal(assetRows.length, rows + 1);
    assert.equal(assetRows.at(-1).url, workerAnswer(61).takes[0].url, 'take 0 of the list is the song');
    assert.equal(assetRows.at(-1).metadata.wavUrl, workerAnswer(61).takes[0].wav_url);
    assert.equal(assetRows.at(-1).metadata.seconds, 95);
  });

  await t.test('Stop cancels the RunPod job and keeps what is finished', async () => {
    const res = await call('/render', { body: { ...song, seed: 40 }, user: MEMBER_2, role: 'USER' }).then(async (blocked) => {
      assert.equal(blocked.status, 403);
      setEnv({ ACE_ADMIN_ONLY: '0' });
      const allowed = await call('/render', { body: { ...song, seed: 40 }, user: MEMBER_2, role: 'USER' });
      setEnv({ ACE_ADMIN_ONLY: undefined });
      return allowed;
    });
    assert.equal(res.status, 200, 'ACE_ADMIN_ONLY=0 opens it to an ordinary account');
    const prov = runpod.runs.at(-1).id;
    const stop = await call(`/cancel/${res.data.jobId}`, { body: {}, user: MEMBER_2, role: 'USER' });
    assert.equal(stop.status, 200);
    assert.equal(stop.data.spoken, 'Stop requested for unfinished takes. Finished takes are kept. GPU time already used is still billed.');
    assert.equal(runpod.jobs.get(prov).state, 'CANCELLED');
    const status = await call(`/status/${res.data.jobId}`, { user: MEMBER_2, role: 'USER' });
    assert.equal(status.data.state, 'cancelled');
    /* Status and Stop need no gate: whoever started it may follow it, even after the door is shut again. */
    assert.equal((await call(`/status/${res.data.jobId}`, { user: MEMBER_2, role: 'USER' })).status, 200);
  });

  await t.test('ACE_ADMIN_ONLY=0 opens the card to everyone signed in; turning ACE_ENABLED off closes it but strands nothing', async () => {
    setEnv({ ACE_ADMIN_ONLY: '0' });
    const member = await call('/health', asMember());
    assert.deepEqual(member.data.guide.engines.ace, ace.aceGuide(process.env));
    setEnv({ ACE_ADMIN_ONLY: undefined });
    const queued = await call('/render', { body: { ...song, seed: 50 }, user: ADMIN_4, role: 'ADMIN' });
    /* ADMIN_4 still holds an unconfirmed take from the lost submission: it says so rather than starting a second paid one. */
    assert.equal(queued.status, 409);
    const fresh = id();
    const live = await call('/render', { body: { ...song, seed: 51 }, user: fresh, role: 'ADMIN' });
    assert.equal(live.status, 200);
    const prov = runpod.runs.at(-1).id;
    setEnv({ ACE_ENABLED: undefined });
    assert.equal((await call('/render', { body: song, user: fresh, role: 'ADMIN' })).status, 403, 'the flag is off: nothing new starts');
    assert.equal((await call('/health', { user: fresh, role: 'ADMIN' })).data.guide.engines.ace, undefined, 'and the card is gone');
    Object.assign(runpod.jobs.get(prov), { state: 'COMPLETED', output: workerAnswer(51), executionTime: 45000 });
    const rows = assetRows.length;
    const status = await call(`/status/${live.data.jobId}`, { user: fresh, role: 'ADMIN' });
    assert.equal(status.data.state, 'done', 'a take already queued still finishes');
    assert.equal(assetRows.length, rows + 1);
    setEnv({ ACE_ENABLED: '1' });
  });

  await t.test('without an endpoint or key the engine says so and starts nothing', async () => {
    const before = runpod.runs.length;
    setEnv({ ACE_ENDPOINT_ID: undefined });
    const res = await call('/render', { body: song, user: id(), role: 'ADMIN' });
    assert.equal(res.status, 503);
    assert.deepEqual(res.data, { error: 'ACE-Step XL is not configured yet.' });
    setEnv({ ACE_ENDPOINT_ID: 'acefixture', RUNPOD_API_KEY: undefined });
    assert.equal((await call('/render', { body: song, user: id(), role: 'ADMIN' })).status, 503);
    setEnv({ RUNPOD_API_KEY: 'fixture' });
    assert.equal(runpod.runs.length, before);
  });

  await t.test('Creative variation and Prompt guidance: the same two dials as the YuE2 card, sent only when moved, kept on the project and the asset', async () => {
    const health = await call('/health', asAdmin());
    const yueCard = health.data.guide.engines.yue2.settings;
    const aceCard = health.data.guide.engines.ace.settings;
    for (const key of ['weirdness', 'guidance']) {
      const mine = aceCard.find((setting) => setting.key === key);
      const theirs = yueCard.find((setting) => setting.key === key);
      for (const field of ['key', 'label', 'kind', 'min', 'max', 'step', 'default', 'advanced']) assert.deepEqual(mine[field], theirs[field], `${key}.${field} is the YuE2 card's`);
    }
    assert.equal(aceCard.find((setting) => setting.key === 'weirdness').hint, yueCard.find((setting) => setting.key === 'weirdness').hint);
    assert.match(aceCard.find((setting) => setting.key === 'guidance').hint, /^Only for Quality Best; Fast ignores it\. Higher follows your direction and lyrics more strictly but can sound less natural\.$/);
    assert.deepEqual(aceCard.filter((setting) => setting.advanced).map((setting) => setting.key), ['weirdness', 'guidance', 'seed'], 'all under More settings');
    assert.deepEqual(aceCard.map((setting) => setting.key), ['singing', 'lyrics', 'quality', 'length', 'weirdness', 'guidance', 'seed']);

    /* Out of range is refused in YuE2's sentences, before a job, a row or a RunPod call. */
    const owner = id();
    const as = { user: owner, role: 'ADMIN' };
    const runsBefore = runpod.runs.length, rowsBefore = await Project.countDocuments({ engine: 'ace' });
    for (const [extra, error] of [[{ weirdness: 101 }, 'Creative variation must be a whole number from 0 to 100.'], [{ weirdness: 12.5 }, 'Creative variation must be a whole number from 0 to 100.'], [{ guidance: 3.5 }, 'Prompt guidance must be from 1 to 3.'], [{ guidance: 0.5 }, 'Prompt guidance must be from 1 to 3.']]) {
      const res = await call('/render', { body: { ...song, ...extra }, ...as });
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.deepEqual(res.data, { error });
    }
    assert.equal(runpod.runs.length, runsBefore);
    assert.equal(await Project.countDocuments({ engine: 'ace' }), rowsBefore);

    /* The quote says so when the guidance is moved on Fast, and is silent on Best. */
    const fastQuote = await call('/render', { body: { ...song, guidance: 2, estimateOnly: true }, ...as });
    assert.match(fastQuote.data.estimate.spoken, /Prompt guidance only works with Quality Best, so Fast ignores it\./);
    const bestQuote = await call('/render', { body: { ...song, guidance: 2, quality: 'Best', estimateOnly: true }, ...as });
    assert.doesNotMatch(bestQuote.data.estimate.spoken, /Prompt guidance/);

    /* Best with both dials moved: the worker gets lm_temperature and guidance_scale, in that order, after bpm. */
    const best = await call('/render', { body: { ...song, seed: 70, quality: 'Best', length: '3:00', weirdness: 70, guidance: 2 }, ...as });
    assert.equal(best.status, 200, best.text);
    assert.deepEqual(runpod.runs.at(-1).body.input, { model: 'xl-sft', caption: 'Slow soul, Rhodes and brushed drums, a warm alto', lyrics: LYRICS, duration: 180, seed: 70, batch_size: 1, bpm: 88, lm_temperature: 1.03, guidance_scale: 10 });
    assert.deepEqual(Object.keys(runpod.runs.at(-1).body.input).slice(-2), ['lm_temperature', 'guidance_scale']);
    const bestProject = await Project.findById(best.data.projectId).lean();
    assert.deepEqual(bestProject.options, { quality: 'Best', length: '3:00', singing: yueSinging.sung, lyrics: LYRICS, weirdness: 70, guidance: 2, seed: 70 });
    const storedBest = await aceJobs().findOne({ id: best.data.jobId });
    assert.equal(storedBest.input.weirdness, 70, 'the job keeps the dials, not the worker numbers');
    assert.equal(storedBest.input.guidance, 2);
    assert.equal('lm_temperature' in storedBest.input, false);
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(70, { model: 'xl-sft' }), executionTime: 90000 });
    assert.equal((await call(`/status/${best.data.jobId}`, as)).data.state, 'done');
    assert.deepEqual(assetRows.at(-1).metadata, {
      title: 'Rain song', seed: 70, jobId: storedBest.takes[0].id, projectId: best.data.projectId, via: 'sound-booth',
      wavUrl: workerAnswer(70).wav_url, seconds: 95, lyrics: LYRICS, truncated: false,
      costScope: 'execution estimate; startup and idle are additional',
      gpu: 'NVIDIA RTX A6000', model: 'xl-sft', bpm: 88, keyscale: 'A minor',
      weirdness: 70, guidance: 2, lm_temperature: 1.03, guidance_scale: 10,
    });
    /* Open in the booth: the library row and the single project both carry the dials back to the page. */
    const list = await call('/projects', as);
    assert.deepEqual(list.data.projects.find((p) => p.id === best.data.projectId).options, { quality: 'Best', length: '3:00', singing: yueSinging.sung, lyrics: LYRICS, weirdness: 70, guidance: 2, seed: 70 });
    assert.deepEqual((await call(`/projects/${best.data.projectId}`, as)).data.project.options, { quality: 'Best', length: '3:00', singing: yueSinging.sung, lyrics: LYRICS, weirdness: 70, guidance: 2, seed: 70 });

    /* Fast with the guidance moved: the temperature goes, the guidance does not; the asset says what was sent. */
    const fast = await call('/render', { body: { ...song, seed: 71, weirdness: 20, guidance: 3 }, ...as });
    assert.equal(fast.status, 200, fast.text);
    assert.deepEqual(runpod.runs.at(-1).body.input, { model: 'xl-turbo', caption: 'Slow soul, Rhodes and brushed drums, a warm alto', lyrics: LYRICS, duration: 30, seed: 71, batch_size: 1, bpm: 88, lm_temperature: 0.58 });
    assert.equal((await Project.findById(fast.data.projectId).lean()).options.guidance, 3, 'the dial is kept even though Fast ignores it');
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(71), executionTime: 30000 });
    assert.equal((await call(`/status/${fast.data.jobId}`, as)).data.state, 'done');
    const fastMeta = assetRows.at(-1).metadata;
    assert.deepEqual([fastMeta.weirdness, fastMeta.guidance, fastMeta.lm_temperature], [20, 3, 0.58]);
    assert.equal('guidance_scale' in fastMeta, false, 'no guidance_scale was sent, so none is recorded');

    /* The dials at their defaults, said out loud: the job is exactly the one sent before the dials existed. */
    const plain = await call('/render', { body: { ...song, seed: 72, weirdness: 50, guidance: 1 }, ...as });
    assert.equal(plain.status, 200, plain.text);
    assert.equal(JSON.stringify(runpod.runs.at(-1).body.input), '{"model":"xl-turbo","caption":"Slow soul, Rhodes and brushed drums, a warm alto","lyrics":"[Verse]\\nWalking home in the rain\\n[Chorus]\\nHold on, hold on\\n(hold on)","duration":30,"seed":72,"batch_size":1,"bpm":88}');
    runpod.jobs.get(runpod.runs.at(-1).id).state = 'CANCELLED';
    await call(`/status/${plain.data.jobId}`, as);
  });

  await t.test('the ACE job ids are its own: a YuE2 status request never reaches the ACE router and the other way round', async () => {
    const yue = await call('/status/yue_0000', asAdmin());
    assert.notEqual(yue.status, 200);
    const mine = await call(`/status/${first.jobId}`, asAdmin());
    assert.equal(mine.status, 200);
    assert.match(first.jobId, /^ace_/);
  });

  assert.deepEqual(runpod.unexpected, [], 'nothing but the ACE endpoint was called');
});
