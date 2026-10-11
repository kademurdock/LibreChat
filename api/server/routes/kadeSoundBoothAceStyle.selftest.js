'use strict';
/* ACE-Step XL, the Style choice (Oct 11 2026), through the booth route: the real kadeSoundBooth.js in a vm, the real jobs.ts,
 * ace.ts, pack.ts and carry module, an in-memory Mongo, RunPod stood in by an axios adapter. Nothing leaves this process.
 *
 * The Style choice is part of the Family feature pack and behind ACE_STYLES_ENABLED. Proven here, with the real
 * familyFeatures answering for each kind of account: with the flag unset the card, the worker job, the project, the asset and
 * the spoken answer are what they were; with it set, the card is live for the pack (an admin, a family member, an older
 * account, a child with the pack) and greyed out for everyone else, a direct request for a style from an account outside the
 * pack gets YuE2's refusal sentence and starts nothing (not even a quote), the App Review seat never gets ACE at all, a
 * styled request becomes exactly one Best RunPod job carrying the adapter, the project and the asset remember it, the take
 * note and the library line are honest about a style the worker did or did not confirm, and the carry between YuE2 and
 * ACE-Step XL leaves the style name behind and says so. The lyrics are invented placeholders. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const pack = require('../../../packages/api/src/family/pack.ts');
const yue = require('../../../packages/api/src/music/yue.ts');
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');

const ENDPOINT = 'https://api.runpod.ai/v2/acefixture/';
const FLAGS = ['ACE_ENABLED', 'ACE_ADMIN_ONLY', 'ACE_STYLES_ENABLED', 'ACE_DEFAULT_MODEL', 'ACE_MAX_SECONDS', 'ACE_ENDPOINT_ID', 'RUNPOD_API_KEY', 'YUE_ENDPOINT_ID', 'YUE_STYLES_ENABLED', 'FAL_KEY', 'BRIDGE_SECRET', 'KADE_LIBRARY_HIDDEN_FROM', 'KADE_APP_REVIEW_USER_IDS', 'NOTIFY_TEST_USER_IDS'];
const LYRICS = '[Verse]\nWalking home in the rain\n[Chorus]\nHold on, hold on\n(hold on)';
const DIRECTION = 'Slow soul, 88 BPM, Rhodes and brushed drums, a warm alto';
const CAPTION = 'Slow soul, Rhodes and brushed drums, a warm alto';
const CLOSED = 'ACE-Step XL is not open to your account yet.';
const REFUSED = { error: pack.FAMILY_PACK_STYLES_REFUSAL, pack: true };
/* sha-256 of JSON.stringify(aceGuide(env)) at the previous commit (before styles), from that commit's code. */
const GUIDE_BEFORE = '7199f29ab206a6964ee6db5b06407d526d9de552d2db92abff0486b407aae293';
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
/* An account made after the Family library's cutoff, by id: not a member of the pack unless it was granted. */
const LATER = (n) => `70000000000000000000${String(n).padStart(4, '0')}`;
const EARLY = '6a5fc5fa351af41332734161';
const REVIEW_SEAT = '6a6125d73939d20b95251078';

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/* The booth route in a vm with a hand-written @librechat/api: the real ace.ts exports and the real familyFeatures, so each
 * kind of account is judged by the pack's own rule. */
function loadBooth({ assetRows, logs }) {
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === '../services/kadeRealCost') return { userPriceFactor: (role) => (String(role).toUpperCase() === 'ADMIN' ? 1 : 3) };
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn: (line) => logs.push(String(line)), error: (...args) => logs.push(`ERROR ${args.map((a) => (a && a.stack) || String(a)).join(' ')}`) } };
    if (name === '@librechat/api') {
      const api = {
        needsRefresh: () => false,
        getNewS3URL: async (url) => url,
        saveBufferToS3: async () => 'https://storage.test/saved',
        createYueRouter: () => {
          const router = express.Router();
          router.post('/render', express.json(), (req, res, next) => (req.body && req.body.engine === 'yue2' ? res.json({ yueSaw: req.body }) : next()));
          return router;
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
        yueStyles: yue.yueStyles,
        yueStylesEnabled: yue.yueStylesEnabled,
        yueStyleHint: yue.yueStyleHint,
        yueStyleAccess: yue.yueStyleAccess,
        yueCost: 'test price',
        yueCoverSettings: (settings) => settings,
        yueCoverOptions: () => ({}),
        yueSavedOptions: (options) => options,
        yueProjectWhy: () => 'YuE2 — a song made on the sleeping music GPU',
        yueTakeFacts: () => ({}),
        yueMusicDirection: (style) => style,
        musicCoverLengthGuide: (guide) => guide,
        musicReferenceSpeedNote: () => '',
        effectsGuide: { name: 'Stable Audio', settings: [], howToWrite: [] },
        effectsConfigured: () => false,
        effectsVariant: () => ({ name: 'Stable Audio', model: 'stable', price: 0 }),
        notifyMusic: async () => ({ accepted: 0 }),
        familyFeatures: (user) => pack.familyFeatures(user),
        FAMILY_PACK_STYLES_REFUSAL: pack.FAMILY_PACK_STYLES_REFUSAL,
        audioAssetDescription: (asset) => asset.description || '',
        ...ace,
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
          req.user = { id: String(req.headers['x-test-user']), role: String(req.headers['x-test-role'] || 'USER'), ...JSON.parse(String(req.headers['x-test-extra'] || '{}')) };
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

/* Just enough of the KadeAsset model: an upsert keyed the way the complete hook keys it, and the reads GET /projects makes. */
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
  const runpod = { runs: [], jobs: new Map(), unexpected: [] };
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (!url.startsWith(ENDPOINT)) {
      runpod.unexpected.push(url);
      throw new Error(`unexpected call to ${url}`);
    }
    const rest = url.slice(ENDPOINT.length);
    if (rest === 'run') {
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
      const id = `prov${runpod.runs.length + 1}`;
      runpod.runs.push({ id, body, text: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) });
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

/* A worker answer shaped like the contract: take 0 at the top level, every take in `takes`, and for a styled take `style`. */
function workerAnswer(seed, extra = {}) {
  const folder = `ace/${String(seed).padStart(8, '0')}-aaaa-4bbb-8ccc-000000000000`;
  const take = { key: `${folder}/master.mp3`, wav_key: `${folder}/master.wav`, url: `https://assets.test/${folder}/master.mp3?X-Amz-Signature=a`, wav_url: `https://assets.test/${folder}/master.wav?X-Amz-Signature=a`, duration_s: 94.6, bytes: 3784000 };
  return {
    engine: 'ace', model: 'xl-sft', ...take, seed, processing_ms: 61000, truncated: false,
    takes: [{ index: 0, seed, ...take }],
    controls: { steps: 50, guidance_scale: 7, shift: 3 },
    timing: { model_load_s: 9, plan_s: 2.4, render_s: 41, encode_s: 1.6, upload_s: 1.2 }, memory: { render_peak_gib: 31.5 },
    gpu: 'NVIDIA RTX A6000', features: ['ace-xl-turbo', 'ace-xl-sft', 'batch', 'instrumental', 'probe', 'lora'],
    versions: { ace_step_commit: 'ca1e85f', torch: '2.8.0+cu128', worker: 'ace-2' }, worker_notes: ['Used 50 steps.'],
    plan: { bpm: 88, keyscale: 'A minor', duration: 95 }, ...extra,
  };
}
const STYLE_REPORT = { key: 'ace-loras/soul-real-v1', name: 'Soul', scale: 1, tag: 'x-tag', sha256: 'e'.repeat(64) };

test('ACE-Step XL Style choice through the booth route', async (t) => {
  const saved = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  setEnv(Object.fromEntries(FLAGS.map((key) => [key, undefined])));
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
  setEnv({ ACE_ENDPOINT_ID: 'acefixture', RUNPOD_API_KEY: 'fixture', ACE_ENABLED: '1' });
  const booth = loadBooth({ assetRows, logs });
  const internals = booth.exports._internals;
  assert.equal(internals.ACE_READY, true);
  assert.equal(internals.ACE_MOUNT, true);
  const app = express();
  app.use('/live', booth.exports);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const jobs = () => mongoose.connection.db.collection('kadeacejobs');

  /* The kinds of account. `member` is whether the Family feature pack's own rule says yes. */
  let later = 0;
  const kinds = {
    admin: () => ({ user: LATER(++later), role: 'ADMIN', member: true }),
    family: () => ({ user: LATER(++later), role: 'USER', extra: { kadeLibraryAccess: 'family' }, member: true }),
    early: () => ({ user: EARLY, role: 'USER', member: true }),
    child: () => ({ user: LATER(++later), role: 'USER', extra: { kadeAccountType: 'child', kadeLibraryAccess: 'family' }, member: true }),
    outsider: () => ({ user: LATER(++later), role: 'USER', member: false }),
    refused: () => ({ user: EARLY, role: 'USER', extra: { kadeLibraryAccess: 'none' }, member: false }),
    kid: () => ({ user: LATER(++later), role: 'USER', extra: { kadeAccountType: 'child' }, member: false }),
  };
  const reviewSeat = (role) => ({ user: REVIEW_SEAT, role, extra: { email: 'kadeai.vischeck722@gmail.com' }, member: false });
  const call = async (route, { body, who, method } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/live${route}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'x-test-user': who.user, 'x-test-role': who.role, 'x-test-extra': JSON.stringify(who.extra || {}) },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, data };
  };
  const song = { engine: 'ace', script: DIRECTION, lyrics: LYRICS, title: 'Rain song', seed: 5 };
  const started = async () => ({ runs: runpod.runs.length, projects: await Project.countDocuments({ engine: 'ace' }), jobs: await jobs().countDocuments() });
  const unchanged = async (before, why) => assert.deepEqual(await started(), before, why);
  /* Finishes whatever a request started: the job is cancelled at RunPod and the status read once, so the person is free again. */
  const settle = async (res, who) => {
    runpod.jobs.get(runpod.runs.at(-1).id).state = 'CANCELLED';
    await call(`/status/${res.data.jobId}`, { who });
  };
  const aceCard = async (who) => (await call('/health', { who })).data.guide.engines.ace;
  const setting = (card, key) => card.settings.find((s) => s.key === key);

  await t.test('ACE_STYLES_ENABLED unset: the card, the job, the project, the asset and the answer are what they were', async () => {
    setEnv({ ACE_ADMIN_ONLY: '0' });
    for (const kind of ['admin', 'family', 'outsider']) {
      const card = await aceCard(kinds[kind]());
      assert.equal(sha(card), GUIDE_BEFORE, `${kind}: the card is the previous commit's, byte for byte`);
      assert.deepEqual(card.settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'length', 'weirdness', 'guidance', 'seed']);
    }
    assert.equal(internals.asksForStyle({ engine: 'ace', band: 'soul' }), false, 'a Style on an ACE request is not a request for one');
    assert.equal(internals.aceStylesOn(), false);
    /* Even an outsider who sends a Style (an old client, or a hand-made request) gets a plain song, exactly as before. */
    const who = kinds.outsider();
    const res = await call('/render', { body: { ...song, band: 'soul', style_strength: 0.3, quality: 'Fast' }, who });
    assert.equal(res.status, 200, res.text);
    assert.equal(runpod.runs.at(-1).text, JSON.stringify({ input: JSON.parse(runpod.runs.at(-1).text).input, policy: { executionTimeout: 1200000, ttl: 7200000 } }));
    assert.equal(JSON.stringify(runpod.runs.at(-1).body.input), `{"model":"xl-turbo","caption":"${CAPTION}","lyrics":${JSON.stringify(LYRICS)},"duration":30,"seed":5,"batch_size":1,"bpm":88}`);
    const project = await Project.findById(res.data.projectId).lean();
    assert.deepEqual(project.options, { quality: 'Fast', length: 'Match my lyrics', singing: yue.yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 5 });
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(5, { model: 'xl-turbo' }), executionTime: 60000 });
    const status = await call(`/status/${res.data.jobId}`, { who });
    assert.equal(status.data.state, 'done');
    assert.equal(status.data.spoken, '1 of 1 takes ready. Open your library to compare them.', 'no style note on a plain take');
    assert.deepEqual(assetRows.at(-1).metadata, {
      title: 'Rain song', seed: 5, jobId: `${res.data.jobId}_1`, projectId: res.data.projectId, via: 'sound-booth',
      wavUrl: workerAnswer(5).wav_url, seconds: 95, lyrics: LYRICS, truncated: false,
      costScope: 'execution estimate; startup and idle are additional',
      gpu: 'NVIDIA RTX A6000', model: 'xl-turbo', bpm: 88, keyscale: 'A minor', weirdness: 50, guidance: 1,
    });
    setEnv({ ACE_ADMIN_ONLY: undefined });
  });

  setEnv({ ACE_STYLES_ENABLED: '1', ACE_ADMIN_ONLY: '0' });

  await t.test('styles on: the card is live for the pack and greyed out for everyone else, never hidden', async () => {
    const open = ace.aceGuide(process.env, true);
    const shut = ace.aceGuide(process.env, false);
    for (const [kind, make] of Object.entries(kinds)) {
      const who = make();
      const card = await aceCard(who);
      assert.deepEqual(card, who.member ? open : shut, kind);
      assert.deepEqual(card.settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'band', 'style_strength', 'length', 'weirdness', 'guidance', 'seed'], `${kind}: the choice is there either way`);
      assert.deepEqual(setting(card, 'band').options, ['none', 'soul']);
      assert.equal(setting(card, 'band').default, 'none');
      for (const key of ['band', 'style_strength']) assert.equal(setting(card, key).locked, who.member ? undefined : 'Part of the Family feature pack', `${kind} ${key}`);
      if (!who.member) assert.match(setting(card, 'band').hint, /Part of the Family feature pack, so songs on this account use None, plain ACE-Step XL\.$/);
      const features = (await call('/health', { who })).data.features;
      assert.equal(features.trainedStyles, who.member, `${kind}: the card agrees with the pack's own answer`);
    }
    /* The App Review seat never gets ACE at all, so no Style choice either, with the door open to everyone else. */
    for (const role of ['USER', 'ADMIN']) {
      const health = await call('/health', { who: reviewSeat(role) });
      assert.equal(health.data.guide.engines.ace, undefined, role);
      assert.equal(health.data.features.trainedStyles, false);
    }
    assert.equal(ace.aceGuide(process.env, true).settings.find((s) => s.key === 'band').locked, undefined, 'the shared card is never locked in place');
  });

  await t.test('styles on, a request for a style from every kind of account', async () => {
    for (const [kind, make] of Object.entries(kinds)) {
      const who = make();
      const before = await started();
      const quote = await call('/render', { body: { ...song, band: 'soul', estimateOnly: true }, who });
      if (!who.member) {
        assert.equal(quote.status, 403, `${kind}: not even a quote`);
        assert.deepEqual(quote.data, REFUSED, kind);
        const res = await call('/render', { body: { ...song, band: 'soul' }, who });
        assert.equal(res.status, 403, kind);
        assert.deepEqual(res.data, REFUSED, `${kind}: YuE2's sentence`);
        await unchanged(before, `${kind}: no RunPod call, no project row, no job`);
        const other = await call('/render', { body: { ...song, band: 'something-else' }, who });
        assert.equal(other.status, 403, `${kind}: the pack answer comes before the engine's`);
        assert.deepEqual(other.data, REFUSED);
        const plainQuote = await call('/render', { body: { ...song, band: 'none', estimateOnly: true }, who });
        assert.equal(plainQuote.status, 200, `${kind}: None is open to everyone`);
        assert.match(plainQuote.data.estimate.spoken, /^About 30 seconds of music, fast quality\./);
        const plain = await call('/render', { body: song, who });
        assert.equal(plain.status, 200, `${kind}: no Style at all is a plain song`);
        assert.equal(runpod.runs.at(-1).body.input.model, 'xl-turbo');
        assert.equal('lora_key' in runpod.runs.at(-1).body.input, false);
        await settle(plain, who);
        continue;
      }
      assert.equal(quote.status, 200, `${kind}: ${quote.text}`);
      assert.match(quote.data.estimate.spoken, /^About 30 seconds of music in the Soul style, which always uses best quality\. ACE-Step XL does not deduct/);
      await unchanged(before, `${kind}: a quote starts nothing`);
      const res = await call('/render', { body: { ...song, band: 'soul' }, who });
      assert.equal(res.status, 200, `${kind}: ${res.text}`);
      assert.equal(runpod.runs.length, before.runs + 1, `${kind}: exactly one RunPod job`);
      assert.deepEqual(runpod.runs.at(-1).body.input, {
        model: 'xl-sft', caption: CAPTION, lyrics: LYRICS, duration: 30, seed: 5, batch_size: 1, bpm: 88,
        lora_key: 'ace-loras/soul-real-v1', lora_scale: 1, vocal_language: 'en',
      }, kind);
      await settle(res, who);
      const refusedStyle = await call('/render', { body: { ...song, band: 'kids' }, who });
      assert.equal(refusedStyle.status, 400, kind);
      assert.deepEqual(refusedStyle.data, { error: 'That trained style is not available. Choose None or another style.' });
    }
    /* The App Review seat is refused at ACE's own door, before any Style is looked at, and nothing is started. */
    for (const role of ['USER', 'ADMIN']) for (const body of [{ ...song, band: 'soul' }, song, { ...song, band: 'soul', estimateOnly: true }]) {
      const before = await started();
      const res = await call('/render', { body, who: reviewSeat(role) });
      assert.equal(res.status, 403, role);
      assert.deepEqual(res.data, { error: CLOSED }, role);
      await unchanged(before, `review seat ${role}`);
    }
    assert.ok(logs.some((line) => /trained style REFUSED/.test(line)), 'the refusal is logged');
  });

  await t.test('the YuE2 Style gate is the same gate: a YuE2 request for a style from an outsider is still refused', async () => {
    assert.equal(internals.asksForStyle({ engine: 'yue2', band: 'soul' }), true);
    assert.equal(internals.asksForStyle({ engine: 'ace', band: 'soul' }), true, 'and now an ACE one');
    for (const body of [{ engine: 'ace', band: 'none' }, { engine: 'ace', band: '' }, { engine: 'ace' }, { engine: 'lyria', band: 'soul' }, { engine: 'seed', band: 'soul' }, null, undefined])
      assert.equal(internals.asksForStyle(body), false, JSON.stringify(body));
    const before = await started();
    const res = await call('/render', { body: { engine: 'yue2', script: 'Slow soul', lyrics: 'la la', band: 'soul' }, who: kinds.outsider() });
    assert.equal(res.status, 403);
    assert.deepEqual(res.data, REFUSED);
    const family = await call('/render', { body: { engine: 'yue2', script: 'Slow soul', lyrics: 'la la', band: 'soul' }, who: kinds.family() });
    assert.equal(family.status, 200);
    assert.equal(family.data.yueSaw.band, 'soul', 'the pack still passes on to YuE2');
    await unchanged(before, 'YuE2 stands in here, so ACE started nothing');
  });

  let styled;
  await t.test('a styled request is one Best RunPod job, in the order the worker reads, and the dials still work', async () => {
    const who = kinds.admin();
    const send = async (extra, expect) => {
      const res = await call('/render', { body: { ...song, ...extra }, who });
      assert.equal(res.status, 200, res.text);
      assert.equal(JSON.stringify(runpod.runs.at(-1).body.input), JSON.stringify(expect), JSON.stringify(extra));
      return res;
    };
    const head = { model: 'xl-sft', caption: CAPTION, lyrics: LYRICS, duration: 30, seed: 5, batch_size: 1, bpm: 88 };
    const tail = { lora_key: 'ace-loras/soul-real-v1', lora_scale: 1, vocal_language: 'en' };
    for (const extra of [{ band: 'soul' }, { band: 'soul', quality: 'Fast' }, { band: 'soul', quality: 'Best' }]) await settle(await send(extra, { ...head, ...tail }), who);
    await settle(await send({ band: 'soul', style_strength: 0.5 }, { ...head, lora_key: tail.lora_key, lora_scale: 0.5, vocal_language: 'en' }), who);
    await settle(await send({ band: 'soul', style_strength: 0 }, { ...head, model: 'xl-turbo' }), who);
    await settle(await send({ band: 'soul', style_strength: 0.00004 }, { ...head, model: 'xl-turbo' }), who);
    await settle(await send({ band: 'soul', style_strength: 0.00005 }, { ...head, lora_key: tail.lora_key, lora_scale: 0.0001, vocal_language: 'en' }), who);
    await settle(await send({ band: 'none', style_strength: 0.5 }, { ...head, model: 'xl-turbo' }), who);
    await settle(await send({ band: 'soul', length: '3:00', weirdness: 70, guidance: 2 }, { ...head, duration: 180, lm_temperature: 1.03, guidance_scale: 10, ...tail }), who);
    styled = await send({ band: 'soul', style_strength: 0.6, length: '3:00', seed: 9 }, { ...head, duration: 180, seed: 9, lora_key: tail.lora_key, lora_scale: 0.6, vocal_language: 'en' });
    /* An instrumental cannot take a style: a plain sentence, and nothing starts. */
    const other = kinds.admin();
    const before = await started();
    const instrumental = await call('/render', { body: { ...song, band: 'soul', singing: yue.yueSinging.instrumental }, who: other });
    assert.equal(instrumental.status, 400);
    assert.deepEqual(instrumental.data, { error: 'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.' });
    const strength = await call('/render', { body: { ...song, band: 'soul', style_strength: 1.5 }, who: other });
    assert.deepEqual(strength.data, { error: 'Style strength must be from 0 to 1.' });
    await unchanged(before, 'a refusal starts nothing');
    assert.equal((await call('/render', { body: { ...song, singing: yue.yueSinging.instrumental, band: 'none', estimateOnly: true }, who: other })).status, 200, 'an instrumental with None is as it always was');
  });

  await t.test('the project and the library row remember Style and strength, and Open in the booth sends the same job', async () => {
    const who = styled && kinds.admin;
    const owner = (await Project.findById(styled.data.projectId).lean()).user;
    const me = { user: String(owner), role: 'ADMIN' };
    const expected = { quality: 'Best', length: '3:00', singing: yue.yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 9, band: 'soul', style_strength: 0.6 };
    const project = await Project.findById(styled.data.projectId).lean();
    assert.equal(project.script, DIRECTION, 'Music direction is kept as she typed it: no trigger word');
    assert.deepEqual(project.options, expected);
    const list = await call('/projects', { who: me });
    const row = list.data.projects.find((p) => p.id === styled.data.projectId);
    assert.equal(row.why, 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
    assert.deepEqual(row.options, expected);
    assert.deepEqual((await call(`/projects/${row.id}`, { who: me })).data.project.options, expected);
    assert.ok(who, 'the account kinds are in scope');
    /* The page puts every option back in the card and sends the card; the job is the one that was sent. */
    const stored = await jobs().findOne({ id: styled.data.jobId });
    assert.equal(stored.input.band, 'soul');
    assert.equal(stored.input.lora_key, 'ace-loras/soul-real-v1');
    assert.equal(stored.input.model, 'xl-sft');
    assert.equal('vocal_language' in stored.input, false, 'the job keeps what she set; English is added when the request is built');
    await settle(styled, me);
    const reopened = await call('/render', { body: { engine: 'ace', title: 'Again', script: row.script, ...row.options }, who: me });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(JSON.stringify(runpod.runs.at(-1).body.input), JSON.stringify({ ...runpod.runs.find((r) => r.body.input.seed === 9).body.input }), 'the very same worker job');
    await settle(reopened, me);
  });

  await t.test('a finished styled take: the asset keeps the style, the answer and the library say it, and an unconfirmed style is said', async () => {
    const who = kinds.admin();
    const res = await call('/render', { body: { ...song, seed: 41, band: 'soul', style_strength: 0.7 }, who });
    assert.equal(res.status, 200, res.text);
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(41, { style: { ...STYLE_REPORT, scale: 0.7 } }), executionTime: 90000 });
    const status = await call(`/status/${res.data.jobId}`, { who });
    assert.equal(status.data.state, 'done');
    assert.equal(status.data.spoken, '1 of 1 takes ready. Open your library to compare them. Made in the Soul style at strength 0.7.');
    await call(`/status/${res.data.jobId}`, { who });
    const asset = assetRows.at(-1);
    assert.equal(asset.metadata.jobId, `${res.data.jobId}_1`);
    assert.deepEqual(asset.metadata, {
      title: 'Rain song', seed: 41, jobId: `${res.data.jobId}_1`, projectId: res.data.projectId, via: 'sound-booth',
      wavUrl: workerAnswer(41).wav_url, seconds: 95, lyrics: LYRICS, truncated: false,
      costScope: 'execution estimate; startup and idle are additional',
      gpu: 'NVIDIA RTX A6000', model: 'xl-sft', bpm: 88, keyscale: 'A minor', weirdness: 50, guidance: 1,
      band: 'soul', style_strength: 0.7, lora_key: 'ace-loras/soul-real-v1', lora_scale: 0.7,
      style: { ...STYLE_REPORT, scale: 0.7 }, takeNote: 'Made in the Soul style at strength 0.7.',
    });
    assert.equal(assetRows.filter((r) => r.metadata.jobId === `${res.data.jobId}_1`).length, 1, 'polled twice, saved once');
    const row = (await call('/projects', { who })).data.projects.find((p) => p.id === res.data.projectId);
    assert.equal(row.takes[0].note, 'Made in the Soul style at strength 0.7.', 'the library line');
    assert.equal(row.why, 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
    assert.equal(row.takes[0].url, asset.url);

    /* A worker that does not say which adapter it applied: the take is kept, and the note does not claim the style. */
    const quiet = await call('/render', { body: { ...song, seed: 42, band: 'soul' }, who });
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(42), executionTime: 60000 });
    const said = await call(`/status/${quiet.data.jobId}`, { who });
    const NOT = 'The Soul style was not confirmed for this take, so it may sound like plain ACE-Step XL.';
    assert.equal(said.data.state, 'done');
    assert.equal(said.data.spoken, `1 of 1 takes ready. Open your library to compare them. ${NOT}`);
    assert.equal(assetRows.at(-1).metadata.takeNote, NOT);
    assert.equal(assetRows.at(-1).metadata.style, undefined);
    assert.equal(assetRows.at(-1).metadata.lora_key, 'ace-loras/soul-real-v1', 'what was asked for is still recorded');

    /* A plain take beside them says nothing about styles, even from a worker that now sends the field. */
    const plain = await call('/render', { body: { ...song, seed: 43 }, who });
    Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(43, { style: STYLE_REPORT }), executionTime: 60000 });
    const plainStatus = await call(`/status/${plain.data.jobId}`, { who });
    assert.equal(plainStatus.data.spoken, '1 of 1 takes ready. Open your library to compare them.');
    assert.equal('takeNote' in assetRows.at(-1).metadata, false);
    assert.equal('style' in assetRows.at(-1).metadata, false);

    /* Style None with a strength she moved, a Style at strength 0, and one too small to count are plain takes: the asset names no
     * style (the project still remembers what she set), and the worker was sent no adapter. */
    for (const [seed, extra] of [[44, { band: 'none', style_strength: 0.4 }], [45, { style_strength: 0.4 }], [46, { band: 'soul', style_strength: 0 }], [47, { band: 'soul', style_strength: 0.00004 }]]) {
      const made = await call('/render', { body: { ...song, seed, ...extra }, who });
      assert.equal(made.status, 200, made.text);
      assert.equal(runpod.runs.at(-1).body.input.model, 'xl-turbo', JSON.stringify(extra));
      for (const key of ['lora_key', 'lora_scale', 'vocal_language']) assert.equal(key in runpod.runs.at(-1).body.input, false, `${JSON.stringify(extra)}: ${key} is not sent`);
      Object.assign(runpod.jobs.get(runpod.runs.at(-1).id), { state: 'COMPLETED', output: workerAnswer(seed, { model: 'xl-turbo' }), executionTime: 60000 });
      const done = await call(`/status/${made.data.jobId}`, { who });
      assert.equal(done.data.spoken, '1 of 1 takes ready. Open your library to compare them.', JSON.stringify(extra));
      for (const key of ['band', 'style_strength', 'lora_key', 'lora_scale', 'style', 'takeNote']) assert.equal(key in assetRows.at(-1).metadata, false, `${JSON.stringify(extra)}: ${key} is not in the asset`);
      assert.equal((await Project.findById(made.data.projectId).lean()).options.style_strength, extra.style_strength, `${JSON.stringify(extra)}: the project remembers what she set`);
    }
  });

  await t.test('switching styles off while a styled take is queued: it still finishes, and the next request is plain', async () => {
    const who = kinds.admin();
    const res = await call('/render', { body: { ...song, seed: 51, band: 'soul' }, who });
    assert.equal(res.status, 200);
    const prov = runpod.runs.at(-1).id;
    setEnv({ ACE_STYLES_ENABLED: undefined });
    try {
      assert.equal(sha(await aceCard(who)), GUIDE_BEFORE, 'the Style choice is gone from the card');
      Object.assign(runpod.jobs.get(prov), { state: 'COMPLETED', output: workerAnswer(51, { style: STYLE_REPORT }), executionTime: 60000 });
      const status = await call(`/status/${res.data.jobId}`, { who });
      assert.equal(status.data.state, 'done');
      assert.equal(status.data.spoken, '1 of 1 takes ready. Open your library to compare them. Made in the Soul style.');
      assert.equal(assetRows.at(-1).metadata.lora_key, 'ace-loras/soul-real-v1');
      const next = await call('/render', { body: { ...song, seed: 52, band: 'soul' }, who });
      assert.equal(next.status, 200);
      assert.equal('lora_key' in runpod.runs.at(-1).body.input, false, 'the next request is plain ACE-Step XL');
      assert.equal(runpod.runs.at(-1).body.input.model, 'xl-turbo');
      await settle(next, who);
    } finally {
      setEnv({ ACE_STYLES_ENABLED: '1' });
    }
  });

  await t.test('carry through the routes: a style name never crosses between YuE2 and ACE-Step XL, and the carry says so', async () => {
    const who = kinds.admin();
    const yueProject = await Project.create({ user: who.user, engine: 'yue2', title: 'Old soul', script: 'Slow soul, Rhodes, female lead vocal', options: { lyrics: LYRICS, band: 'soul', style_strength: 0.5, seed: 4, weirdness: 60, guidance: 2, count: 1 }, state: 'done' });
    const aceProject = await Project.create({ user: who.user, engine: 'ace', title: 'New soul', script: 'Slow soul, Rhodes', options: { quality: 'Best', length: 'Match my lyrics', singing: yue.yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 7, band: 'soul', style_strength: 0.6 }, state: 'done' });
    const toAce = await call(`/projects/${yueProject._id}/carry`, { body: { engine: 'ace' }, who });
    assert.equal(toAce.status, 200, toAce.text);
    for (const key of ['band', 'style_strength', 'lora_key', 'lora_scale']) assert.equal(key in toAce.data.project.options, false, `YuE2 to ACE: ${key}`);
    assert.equal(toAce.data.project.options.lyrics, LYRICS);
    assert.equal(toAce.data.project.options.seed, 4);
    assert.ok(toAce.data.notes.includes('ACE-Step XL has its own Style choice, taught separately from YuE2\'s, so the YuE2 style was left behind. Choose Style on the ACE-Step XL card to use one.'), toAce.data.notes.join(' | '));
    /* YuE2's own Style choice is behind YUE_STYLES_ENABLED. Without it there is no choice to "choose Style" on, and the carry says
     * only that the style was left behind. */
    const OWN = 'YuE2 has its own Style choice, taught separately from ACE-Step XL\'s, so the ACE-Step XL style was left behind. Choose Style on the YuE2 card to use one.';
    const NO_YUE_STYLE = 'YuE2 has no trained style, which only ACE-Step XL has, so that was left behind.';
    const toYue = await call(`/projects/${aceProject._id}/carry`, { body: { engine: 'yue2' }, who });
    assert.equal(toYue.status, 200, toYue.text);
    for (const key of ['band', 'style_strength', 'lora_key', 'lora_scale']) assert.equal(key in toYue.data.project.options, false, `ACE to YuE2: ${key}`);
    assert.ok(toYue.data.notes.includes(NO_YUE_STYLE), toYue.data.notes.join(' | '));
    assert.doesNotMatch(toYue.data.notes.join(' '), /Choose Style|quality choice/);
    const draftNoChoice = await call('/carry', { body: { engine: 'yue2', draft: { engine: 'ace', title: 'Draft', script: 'Slow soul', options: { quality: 'Best', lyrics: LYRICS, band: 'soul' } } }, who });
    assert.equal(draftNoChoice.status, 200, draftNoChoice.text);
    assert.ok(draftNoChoice.data.notes.includes(NO_YUE_STYLE), `the page's own draft carry says the same: ${draftNoChoice.data.notes.join(' | ')}`);
    assert.doesNotMatch(draftNoChoice.data.notes.join(' '), /Choose Style|quality choice/);
    setEnv({ YUE_STYLES_ENABLED: '1' });
    try {
      const withChoice = await call(`/projects/${aceProject._id}/carry`, { body: { engine: 'yue2' }, who });
      assert.equal(withChoice.status, 200, withChoice.text);
      assert.ok(withChoice.data.notes.includes(OWN), withChoice.data.notes.join(' | '));
      assert.doesNotMatch(withChoice.data.notes.join(' '), /quality choice/);
      for (const key of ['band', 'style_strength', 'lora_key', 'lora_scale']) assert.equal(key in withChoice.data.project.options, false, `ACE to YuE2: ${key}`);
      /* The page's own draft carry, from a Style at strength 0 (a plain take): nothing is left behind, so nothing is said. */
      const draftOf = (options) => ({ engine: 'ace', title: 'Draft', script: 'Slow soul', options: { quality: 'Fast', length: 'Match my lyrics', singing: yue.yueSinging.sung, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 7, ...options } });
      const zero = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ band: 'soul', style_strength: 0 }) }, who });
      assert.equal(zero.status, 200, zero.text);
      assert.doesNotMatch(zero.data.notes.join(' '), /[Ss]tyle/, zero.data.notes.join(' | '));
      const styledDraft = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ band: 'soul', quality: 'Best' }) }, who });
      assert.ok(styledDraft.data.notes.includes(OWN), styledDraft.data.notes.join(' | '));
      /* A person outside the pack has no Style choice on either card, so a hand-made draft that names one is carried as it always was. */
      const outsider = kinds.outsider();
      const handMade = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ band: 'soul', quality: 'Best' }) }, who: outsider });
      const bare = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ quality: 'Best' }) }, who: outsider });
      assert.equal(handMade.status, 200, handMade.text);
      assert.deepEqual(handMade.data.notes, bare.data.notes, 'no new sentence about a style');
      assert.doesNotMatch(handMade.data.notes.join(' '), /[Ss]tyle/);
      /* The same with ACE-Step XL styles switched off: the draft that names one gets what it always got. */
      setEnv({ ACE_STYLES_ENABLED: undefined });
      try {
        const off = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ band: 'soul', quality: 'Best' }) }, who });
        const offBare = await call('/carry', { body: { engine: 'yue2', draft: draftOf({ quality: 'Best' }) }, who });
        assert.deepEqual(off.data.notes, offBare.data.notes, 'no new sentence about a style');
        assert.doesNotMatch(off.data.notes.join(' '), /[Ss]tyle/);
        assert.match(off.data.notes.join(' '), /quality choice/);
      } finally {
        setEnv({ ACE_STYLES_ENABLED: '1' });
      }
    } finally {
      setEnv({ YUE_STYLES_ENABLED: undefined });
    }
    /* The original projects are untouched. */
    assert.equal((await Project.findById(yueProject._id).lean()).options.band, 'soul');
    assert.equal((await Project.findById(aceProject._id).lean()).options.band, 'soul');
    /* The page's own draft carry says the same. */
    const draft = await call('/carry', { body: { engine: 'ace', draft: { engine: 'yue2', title: 'Draft', script: 'Slow soul', options: { lyrics: LYRICS, band: 'soul', style_strength: 1 } } }, who });
    assert.equal(draft.status, 200);
    assert.equal('band' in draft.data.draft.options, false);
    assert.ok(draft.data.notes.some((n) => /YuE2 style was left behind/.test(n)));
    /* Someone outside the pack (a style draft from before the pack was taken away, say) has no Style choice on the ACE-Step XL card,
     * so the carry does not point at one: it says what it always said. */
    const outside = await call('/carry', { body: { engine: 'ace', draft: { engine: 'yue2', title: 'Draft', script: 'Slow soul', options: { lyrics: LYRICS, band: 'soul', style_strength: 1 } } }, who: kinds.outsider() });
    assert.equal(outside.status, 200, outside.text);
    assert.ok(outside.data.notes.includes('ACE-Step XL has no trained style, which only YuE2 has, so that was left behind.'), outside.data.notes.join(' | '));
    assert.doesNotMatch(outside.data.notes.join(' '), /Choose Style/);
    /* With styles off the sentence is the one it always was, and a person without ACE still cannot carry to or from it. */
    setEnv({ ACE_STYLES_ENABLED: undefined });
    try {
      const old = await call(`/projects/${yueProject._id}/carry`, { body: { engine: 'ace' }, who });
      assert.ok(old.data.notes.includes('ACE-Step XL has no trained style, which only YuE2 has, so that was left behind.'), old.data.notes.join(' | '));
    } finally {
      setEnv({ ACE_STYLES_ENABLED: '1' });
    }
    setEnv({ ACE_ADMIN_ONLY: undefined });
    const member = kinds.family();
    const closed = await call(`/projects/${yueProject._id}/carry`, { body: { engine: 'ace' }, who: member });
    assert.ok([403, 404].includes(closed.status), String(closed.status));
    const draftClosed = await call('/carry', { body: { engine: 'ace', draft: { engine: 'yue2', title: 'Draft', script: 'Slow soul', options: { lyrics: LYRICS } } }, who: member });
    assert.equal(draftClosed.status, 403);
    assert.deepEqual(draftClosed.data, { error: CLOSED });
    setEnv({ ACE_ADMIN_ONLY: '0' });
  });

  assert.deepEqual(runpod.unexpected, [], 'nothing but the ACE endpoint was called');
});
