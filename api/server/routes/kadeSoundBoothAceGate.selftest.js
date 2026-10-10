'use strict';
/* ACE-Step XL (Oct 10 2026): every way in. The real kadeSoundBooth.js in a vm, the real ace.ts router and carry module, an
 * in-memory Mongo, RunPod and the writing model stood in by an axios adapter. Nothing leaves this process.
 *
 * Until Kade opens ACE-Step XL (ACE_ENABLED, and ACE_ADMIN_ONLY on by default) only an admin account may use it, and "use"
 * is wider than Make music: the render, a pasted three-box song rendered straight away, the writing desk (/script, shallow
 * and deep), the two carry routes (a draft in the page and a saved project, to ACE and from it), the library's carry lists
 * and the media link. Each is tried as an admin, as a family member, with ACE_ADMIN_ONLY=0, and with the flag unset, and a
 * refusal must leave nothing behind: no RunPod call, no model call, no job, no project row, no notice.
 * With the flag unset the writing desk and the carry answer exactly as they did before ACE existed. The words are invented. */
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
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');
const link = require('./kadeSoundBoothLink');

const ENDPOINT = 'https://api.runpod.ai/v2/acefixture/';
const GATEWAY = 'https://reframe-proxy-production.up.railway.app/chat/completions';
const FLAGS = ['ACE_ENABLED', 'ACE_ADMIN_ONLY', 'ACE_ENDPOINT_ID', 'RUNPOD_API_KEY', 'YUE_ENDPOINT_ID', 'REFRAME_PROXY_SECRET', 'OPENROUTER_KEY', 'KADE_LLM_GATEWAY_URL', 'BRIDGE_SECRET'];
const LYRICS = '[Verse 1]\nWalking home in the rain\n\n[Chorus]\nHold on, hold on\n(hold on)';
const DIRECTION = 'Slow soul, 88 BPM, Rhodes and brushed drums, a warm alto';
const OFF = 'ACE-Step XL is not turned on yet.';
const CLOSED = 'ACE-Step XL is not open to your account yet.';
const F3 = '`'.repeat(3);
const PASTE_LYRICS = '[Verse 1]\nThe vending machine ate my last two quarters\n\n[Chorus]\nTomato soup at midnight (at midnight)';
const PASTE_TAGS = 'Early-2000s pop-punk, 172 BPM, bratty tenor lead, palm-muted guitars';
const PASTE = ['**Lyrics Box**', '', F3, PASTE_LYRICS, F3, '', 'Tag Box:', '', F3, PASTE_TAGS, F3, '', 'Negative Tag Box', '', F3, 'no autotune, no ballad tempo', F3].join('\r\n');

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadBooth({ withAce = true, assetRows, logs }) {
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
          const yue = express.Router();
          yue.post('/render', express.json(), (req, res, next) => (req.body && req.body.engine === 'yue2' ? res.json({ yueSaw: req.body }) : next()));
          return yue;
        },
        yueConfigured: () => false,
        writingCost: () => ({ costUSD: 0, measured: false }),
        splitLyricTitle: (text) => ({ script: text }),
        lyricTitleFromSong: () => undefined,
        musicWritingSettings: () => ({}),
        musicWritingBackground: (request) => ['lyria', 'yue2', 'ace'].includes(request.engine) && request.mode === 'write' && !!(request.deep || request.deepWrite || request.background || request.thinkMode),
        labelReadback: (text) => text,
        lyricShapeIssue: () => null,
        fixStageDirections: (text) => text,
        formatGeneratedLyricsDraft: (text) => text,
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
    if (name === '~/models/kadeAsset') {
      const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => assetRows };
      return { logKadeAsset: async () => ({ _id: new mongoose.Types.ObjectId() }), KadeAsset: { find: () => chain, findOneAndUpdate: async () => ({ _id: new mongoose.Types.ObjectId() }) } };
    }
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(source, {
    require: localRequire, module, exports: module.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return module;
}

/* RunPod and the writing model. Every call is recorded; a model call answers with whatever text the test has set. */
function fakeNetwork() {
  const net = { runs: [], modelCalls: [], unexpected: [], modelText: '' };
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    if (url === GATEWAY) {
      net.modelCalls.push(body);
      return reply({ choices: [{ message: { content: net.modelText }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }
    if (url.startsWith(ENDPOINT)) {
      const rest = url.slice(ENDPOINT.length);
      if (rest === 'run') {
        const id = `prov${net.runs.length + 1}`;
        net.runs.push({ id, body });
        return reply({ id });
      }
      return reply({ id: rest.split('/')[1], status: 'IN_QUEUE' });
    }
    net.unexpected.push(url);
    throw new Error(`unexpected call to ${url}`);
  };
  return net;
}

test('ACE-Step XL: every way in is behind the same gate', async (t) => {
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
  const net = fakeNetwork();
  const logs = [];
  /* The booth is loaded the way a server with an endpoint set loads it (the ACE router exists). What the flags say is read
   * again on every request, so each test turns them on and off. */
  setEnv({ ACE_ENDPOINT_ID: 'acefixture', RUNPOD_API_KEY: 'fixture', REFRAME_PROXY_SECRET: 'fixture-key' });
  const booth = loadBooth({ assetRows: [], logs });
  assert.equal(booth.exports._internals.ACE_MOUNT, true);
  const app = express();
  app.use('/live', booth.exports);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const id = () => new mongoose.Types.ObjectId().toString();
  const ADMIN = id(), MEMBER = id();
  const call = async (route, { body, user, role = 'USER', method } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/live${route}`, {
      method: method || (body ? 'POST' : 'GET'),
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
  const flags = (vars) => setEnv({ ACE_ENABLED: undefined, ACE_ADMIN_ONLY: undefined, ...vars });
  const mark = async () => ({ runs: net.runs.length, models: net.modelCalls.length, projects: await Project.countDocuments(), jobs: await aceJobs().countDocuments() });
  const nothingMoved = async (before, what) => assert.deepEqual(await mark(), before, `${what} left something behind`);
  const refusedAs = (res, error, what) => {
    assert.equal(res.status, 403, `${what}: ${res.text}`);
    assert.deepEqual(res.data, { error }, `${what}: nothing but the sentence`);
  };

  const yueProject = await Project.create({ user: MEMBER, engine: 'yue2', title: 'Porch song', script: 'English, folk, warm alto', sourceText: 'a porch song', options: { lyrics: LYRICS, seed: 42, count: 2 }, state: 'done' });
  const aceProject = await Project.create({ user: MEMBER, engine: 'ace', title: 'Rain song', script: DIRECTION, options: { quality: 'Best', length: '3:00', singing: 'Sung, with my lyrics', lyrics: LYRICS, seed: 5 }, state: 'done' });
  const adminYue = await Project.create({ user: ADMIN, engine: 'yue2', title: 'Admin porch song', script: 'English, folk, warm alto', sourceText: 'a porch song', options: { lyrics: LYRICS, seed: 42, count: 2, band: 'soul' }, state: 'done' });

  await t.test('the flag unset: nobody is let in by any route, and the desk and the carry answer as they did before ACE', async () => {
    flags({});
    const before = await mark();
    for (const who of [asMember(), asAdmin()]) {
      refusedAs(await call('/render', { ...who, body: { engine: 'ace', script: DIRECTION, lyrics: LYRICS } }), OFF, 'render');
      refusedAs(await call('/render', { ...who, body: { engine: 'ace', script: PASTE } }), OFF, 'a pasted song');
      refusedAs(await call('/script', { ...who, body: { engine: 'ace', mode: 'write', text: 'A slow soul song' } }), OFF, 'the writing desk');
      refusedAs(await call('/script', { ...who, body: { engine: 'ace', mode: 'write', background: true, text: 'A slow soul song' } }), OFF, 'the deep writing lane');
      refusedAs(await call('/carry', { ...who, body: { engine: 'ace', draft: { engine: 'yue2', script: 'x', options: { lyrics: LYRICS } } } }), OFF, 'a draft carried to ACE');
      refusedAs(await call('/carry', { ...who, body: { engine: 'yue2', draft: { engine: 'ace', script: 'x', options: { lyrics: LYRICS } } } }), OFF, 'a draft carried from ACE');
    }
    refusedAs(await call(`/projects/${yueProject.id}/carry`, { ...asMember(), body: { engine: 'ace' } }), OFF, 'a project carried to ACE');
    refusedAs(await call(`/projects/${aceProject.id}/carry`, { ...asMember(), body: { engine: 'yue2' } }), OFF, 'a project carried from ACE');
    await nothingMoved(before, 'a refusal');
    assert.equal(net.unexpected.length, 0);
    /* The library lists no ACE destination for anyone, and carries as before. */
    const list = await call('/projects', asMember());
    for (const row of list.data.projects) assert.ok(!row.carryTo.some((d) => d.engine === 'ace'), `${row.engine} offered ACE with the flag unset`);
    assert.deepEqual(list.data.projects.find((p) => p.engine === 'yue2').carryTo.map((d) => d.engine), ['lyria']);
    /* The desk treats an unknown engine as it always did (an AuK script), so a request that does not name ace is untouched. */
    net.modelText = 'Slow soul, 88 BPM, Rhodes\n\nLyrics:\n[Verse]\nthe invented words\n\nREADBACK: A slow soul song.';
    const yue = await call('/script', { ...asAdmin(), body: { engine: 'yue2', mode: 'write', text: 'A slow soul song', lyrics: '[Verse]\nher words' } });
    assert.equal(yue.status, 200, yue.text);
    assert.equal(yue.data.engine, 'yue2');
    assert.match(net.modelCalls.at(-1).messages[0].content, /^You are the script desk[\s\S]*YUE2 MUSIC FORMAT \(the only format you may output\)/);
    assert.doesNotMatch(net.modelCalls.at(-1).messages[0].content, /ACE-STEP/);
    const viaCarry = await call('/carry', { ...asAdmin(), body: { engine: 'lyria', draft: { engine: 'yue2', script: 'English, folk', options: { lyrics: LYRICS } } } });
    assert.equal(viaCarry.status, 200);
    assert.equal(viaCarry.data.draft.engine, 'lyria');
  });

  await t.test('ACE_ENABLED=1 and admin-only: a member of the family is turned away from every way in, and nothing is started', async () => {
    flags({ ACE_ENABLED: '1' });
    const before = await mark();
    refusedAs(await call('/render', { ...asMember(), body: { engine: 'ace', script: DIRECTION, lyrics: LYRICS } }), CLOSED, 'render');
    /* A pasted three-box song is refused before it is sorted: no note, no sorted boxes, only the sentence. */
    refusedAs(await call('/render', { ...asMember(), body: { engine: 'ace', script: PASTE } }), CLOSED, 'a pasted song');
    refusedAs(await call('/render', { ...asMember(), body: { engine: 'ace', script: DIRECTION, lyrics: PASTE } }), CLOSED, 'a song pasted into the lyrics box');
    refusedAs(await call('/render', { ...asMember(), body: { engine: 'ace', script: PASTE, estimateOnly: true } }), CLOSED, 'a price quote');
    refusedAs(await call('/script', { ...asMember(), body: { engine: 'ace', mode: 'write', text: 'A slow soul song', lyrics: LYRICS } }), CLOSED, 'the writing desk');
    refusedAs(await call('/script', { ...asMember(), body: { engine: 'ace', mode: 'format', text: PASTE } }), CLOSED, 'a pasted song at the desk');
    refusedAs(await call('/script', { ...asMember(), body: { engine: 'ace', mode: 'write', background: true, text: 'A slow soul song' } }), CLOSED, 'the deep writing lane (no job, no "draft did not finish" notice)');
    refusedAs(await call('/carry', { ...asMember(), body: { engine: 'ace', draft: { engine: 'yue2', script: 'x', options: { lyrics: LYRICS } } } }), CLOSED, 'a draft carried to ACE');
    refusedAs(await call('/carry', { ...asMember(), body: { engine: 'yue2', draft: { engine: 'ace', script: 'x', options: { lyrics: LYRICS } } } }), CLOSED, 'a draft carried from ACE');
    refusedAs(await call(`/projects/${yueProject.id}/carry`, { ...asMember(), body: { engine: 'ace', rewrite: true } }), CLOSED, 'a project carried to ACE, with the rewrite');
    refusedAs(await call(`/projects/${aceProject.id}/carry`, { ...asMember(), body: { engine: 'lyria' } }), CLOSED, 'a saved ACE project carried out');
    await nothingMoved(before, 'a refusal');
    assert.equal(net.unexpected.length, 0);
    /* Her library and /health never mention it. */
    const list = await call('/projects', asMember());
    for (const row of list.data.projects) assert.ok(!row.carryTo.some((d) => d.engine === 'ace'), `${row.engine} offered ACE to a member`);
    const health = await call('/health', asMember());
    assert.equal('ace' in health.data.guide.engines, false);
    assert.equal('ace' in health.data.engines, false);
    /* An ordinary request from the same member is untouched. */
    net.modelText = 'Slow soul\n\nLyrics:\n[Verse]\nthe invented words\n\nREADBACK: ok.';
    assert.equal((await call('/script', { ...asMember(), body: { engine: 'lyria', mode: 'write', text: 'A slow soul song', lyrics: '[Verse]\nmine' } })).status, 200);
    assert.equal((await call('/carry', { ...asMember(), body: { engine: 'lyria', draft: { engine: 'yue2', script: 'English, folk', options: { lyrics: LYRICS } } } })).status, 200);
  });

  await t.test('ACE_ENABLED=1: an admin is let in everywhere, and a pasted song is sorted before ACE reads it', async () => {
    flags({ ACE_ENABLED: '1' });
    const render = await call('/render', { ...asAdmin(), body: { engine: 'ace', script: PASTE, title: 'Pasted song' } });
    assert.equal(render.status, 200, render.text);
    assert.equal(render.data.queued, true);
    assert.equal(net.runs.length, 1);
    const sent = net.runs[0].body.input;
    assert.equal(sent.lyrics, PASTE_LYRICS, 'the Lyrics Box became the lyrics');
    assert.equal(sent.caption, 'Early-2000s pop-punk, bratty tenor lead, palm-muted guitars', 'the Tag Box became the direction, its tempo moved to the bpm field');
    assert.equal(sent.bpm, 172);
    assert.doesNotMatch(JSON.stringify(sent), /autotune|Tag Box|```/, 'the negative tags went nowhere');
    assert.match(render.data.note, /Negative Tag Box was left out/);
    assert.deepEqual(render.data.pasteSorted, { script: PASTE_TAGS, lyrics: PASTE_LYRICS });
    const row = await Project.findById(render.data.projectId);
    assert.equal(row.engine, 'ace');
    assert.equal(row.script, PASTE_TAGS, 'the project keeps the direction, not the whole paste');
    assert.equal(row.options.lyrics, PASTE_LYRICS);
    /* The writing desk: the song desk's prompt with ACE-Step XL's name in its heading. */
    net.modelText = 'Slow soul, 88 BPM, Rhodes\n\nLyrics:\n[Verse]\nthe invented words\n\nREADBACK: A slow soul song.';
    const calls = net.modelCalls.length;
    const desk = await call('/script', { ...asAdmin(), body: { engine: 'ace', mode: 'write', text: 'A slow soul song', lyrics: '[Verse]\nher own words' } });
    assert.equal(desk.status, 200, desk.text);
    assert.equal(net.modelCalls.length, calls + 1, 'one writing call, no new ones');
    const system = net.modelCalls.at(-1).messages[0].content;
    assert.match(system, /ACE-STEP XL MUSIC FORMAT \(the only format you may output\):\nWrite a concise style direction in 25 to 45 words/);
    assert.doesNotMatch(system, /YUE2/);
    assert.match(net.modelCalls.at(-1).messages[1].content, /THEIR EXISTING LYRICS: Keep these words exactly/, 'her own words are kept, as on the YuE2 card');
    assert.equal(desk.data.engine, 'ace');
    assert.match(desk.data.script, /^Slow soul, 88 BPM, Rhodes\n\nLyrics:\n\[Verse\]/);
    assert.equal(desk.data.readback, 'A slow soul song.');
    assert.equal(desk.data.problem, null);
    assert.deepEqual(desk.data.estimate, { spoken: 'The draft is ready. Generating the song is a separate paid action.' });
    /* An instrumental is asked for without words, the YuE2 way. */
    const quiet = await call('/script', { ...asAdmin(), body: { engine: 'ace', mode: 'write', text: 'A slow theme', singing: 'Instrumental, no singing' } });
    assert.equal(quiet.status, 200, quiet.text);
    assert.match(net.modelCalls.at(-1).messages[1].content, /INSTRUMENTAL MODE IS SELECTED/);
    /* A pasted song at the desk is sorted with no model call. */
    const callsBefore = net.modelCalls.length;
    const pasted = await call('/script', { ...asAdmin(), body: { engine: 'ace', mode: 'write', text: PASTE } });
    assert.equal(pasted.status, 200, pasted.text);
    assert.equal(net.modelCalls.length, callsBefore, 'no writer was asked');
    assert.equal(pasted.data.pasted, true);
    assert.equal(pasted.data.script, PASTE_TAGS + '\n\nLyrics:\n' + PASTE_LYRICS);
    assert.deepEqual(pasted.data.estimate, { spoken: 'The draft is ready. Generating the song is a separate paid action.' });
    const noWords = await call('/script', { ...asAdmin(), body: { engine: 'ace', mode: 'write', text: ['**Tag Box**', F3, PASTE_TAGS, F3].join('\n') } });
    assert.match(noWords.data.problem, /^ACE-Step XL will not sing without words, and the paste had no Lyrics Box/);
    const yueNoWords = await call('/script', { ...asAdmin(), body: { engine: 'yue2', mode: 'write', text: ['**Tag Box**', F3, PASTE_TAGS, F3].join('\n') } });
    assert.match(yueNoWords.data.problem, /^YuE2 will not sing without words, and the paste had no Lyrics Box/);
    /* The deep lane is a job for ACE as for YuE2: accepted at once, and the draft is there when asked for. */
    const deep = await call('/script', { ...asAdmin(), body: { engine: 'ace', mode: 'write', background: true, text: 'A slow soul song', lyrics: '[Verse]\nher words' } });
    assert.equal(deep.status, 202, deep.text);
    let job;
    for (let i = 0; i < 50 && !(job && job.data.state === 'done'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await call(`/script/job/${deep.data.job}`, asAdmin());
    }
    assert.equal(job.data.state, 'done', job.text);
    assert.equal(job.data.result.engine, 'ace');
    /* The library offers an admin ACE as a destination, between the song engines only. */
    const list = await call('/projects', asAdmin());
    assert.deepEqual(list.data.projects.find((p) => p.engine === 'yue2').carryTo.map((d) => d.engine), ['lyria', 'ace']);
    const health = await call('/health', asAdmin());
    assert.equal(health.data.guide.engines.ace.name, 'ACE-Step XL');
  });

  await t.test('carrying to and from ACE: a draft in the page, and a saved project; the original is never touched', async () => {
    flags({ ACE_ENABLED: '1' });
    const draft = await call('/carry', { ...asAdmin(), body: { engine: 'ace', draft: { engine: 'yue2', title: 'Porch song', sourceText: 'a porch song', script: 'English, folk, warm alto', options: { lyrics: LYRICS, seed: 42, count: 2, band: 'soul', singing: 'Sung, with my lyrics' } } } });
    assert.equal(draft.status, 200, draft.text);
    assert.equal(draft.data.draft.engine, 'ace');
    assert.equal(draft.data.draft.options.lyrics, LYRICS);
    assert.equal(draft.data.draft.options.seed, 42);
    assert.equal(draft.data.draft.options.singing, 'Sung, with my lyrics');
    assert.equal(draft.data.draft.title, 'Porch song (on ACE-Step XL)');
    assert.match(draft.data.notes.join(' '), /ACE-Step XL has no trained style, which only YuE2 has/);
    assert.match(draft.data.notes.join(' '), /ACE-Step XL makes one take at a time, so the 2 takes you asked for became one/);
    const back = await call('/carry', { ...asAdmin(), body: { engine: 'yue2', draft: { engine: 'ace', title: 'Rain song', script: DIRECTION, options: { lyrics: LYRICS, quality: 'Best', length: '3:00', seed: 5 } } } });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.data.draft.options.lyrics, LYRICS);
    assert.match(back.data.notes.join(' '), /YuE2 has no quality choice, no length choice/);
    assert.equal((await call('/carry', { ...asAdmin(), body: { engine: 'seed', draft: { engine: 'ace', script: 'x', options: {} } } })).status, 400, 'ACE does not carry to a sound engine');
    assert.equal((await call('/carry', { ...asAdmin(), body: { engine: 'ace', draft: { engine: 'ace', script: 'x', options: {} } } })).status, 400);
    /* A saved project: a new row, the original exactly as it was. */
    const original = JSON.stringify((await Project.findById(adminYue.id).lean()));
    const rows = await Project.countDocuments({ user: ADMIN });
    const saved = await call(`/projects/${adminYue.id}/carry`, { ...asAdmin(), body: { engine: 'ace' } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.project.engine, 'ace');
    assert.equal(saved.data.from.engine, 'yue2');
    assert.equal(await Project.countDocuments({ user: ADMIN }), rows + 1);
    const made = await Project.findById(saved.data.project.id).lean();
    assert.equal(made.engine, 'ace');
    assert.equal(made.state, 'draft');
    assert.equal(String(made.user), ADMIN);
    assert.equal(made.options.lyrics, LYRICS);
    assert.equal(made.options.seed, 42);
    assert.equal(made.options.singing, 'Sung, with my lyrics');
    assert.deepEqual({ ...made.options.carriedFrom }, { project: adminYue.id, engine: 'yue2' });
    assert.equal(JSON.stringify(await Project.findById(adminYue.id).lean()), original, 'the original project was touched');
    assert.deepEqual(saved.data.project.carryTo.map((d) => d.engine), ['lyria', 'yue2'], 'and the new draft can go on to the other song engines');
    /* ACE to YuE2 as a saved project. */
    await Project.updateOne({ _id: aceProject._id }, { $set: { user: ADMIN } });
    const out = await call(`/projects/${aceProject.id}/carry`, { ...asAdmin(), body: { engine: 'yue2' } });
    assert.equal(out.status, 200, out.text);
    const outRow = await Project.findById(out.data.project.id).lean();
    assert.equal(outRow.engine, 'yue2');
    assert.equal(outRow.options.lyrics, LYRICS);
    assert.equal(outRow.options.quality, undefined);
    /* The optional rewrite goes to the writer with ACE-Step XL's format, and words she did not write are left out. */
    net.modelText = 'Slow soul, warm alto, Rhodes.\n\nLyrics:\nmade-up words\n\nREADBACK: ok.';
    const lyriaRow = await Project.create({ user: ADMIN, engine: 'lyria', title: 'Brief song', script: 'A long pop brief with no lyrics heading.', sourceText: 'a pop song', options: {}, state: 'done' });
    const calls = net.modelCalls.length;
    const rewritten = await call(`/projects/${lyriaRow.id}/carry`, { ...asAdmin(), body: { engine: 'ace', rewrite: true } });
    assert.equal(rewritten.status, 200, rewritten.text);
    assert.equal(net.modelCalls.length, calls + 1);
    assert.match(net.modelCalls.at(-1).messages[0].content, /ACE-STEP XL MUSIC FORMAT/);
    assert.match(net.modelCalls.at(-1).messages[1].content, /moving to ACE-Step XL/);
    assert.equal(rewritten.data.notes.some((n) => /made up words/.test(n)), true, 'made-up words are said, and kept out of Lyrics');
    const rewrittenRow = await Project.findById(rewritten.data.project.id).lean();
    assert.equal(rewrittenRow.script, 'Slow soul, warm alto, Rhodes.');
    assert.equal(rewrittenRow.options.lyrics, undefined);
    await Project.updateOne({ _id: aceProject._id }, { $set: { user: MEMBER } });
  });

  await t.test('ACE_ADMIN_ONLY=0 opens the same doors to a member; ACE_ENABLED off closes them again for everyone', async () => {
    flags({ ACE_ENABLED: '1', ACE_ADMIN_ONLY: '0' });
    net.modelText = 'Slow soul\n\nLyrics:\n[Verse]\nthe invented words\n\nREADBACK: ok.';
    const calls = net.modelCalls.length;
    const desk = await call('/script', { ...asMember(), body: { engine: 'ace', mode: 'write', text: 'A slow soul song', lyrics: '[Verse]\nher words' } });
    assert.equal(desk.status, 200, desk.text);
    assert.equal(desk.data.engine, 'ace');
    assert.equal(net.modelCalls.length, calls + 1);
    const carried = await call('/carry', { ...asMember(), body: { engine: 'ace', draft: { engine: 'yue2', script: 'x', options: { lyrics: LYRICS } } } });
    assert.equal(carried.status, 200, carried.text);
    const project = await call(`/projects/${yueProject.id}/carry`, { ...asMember(), body: { engine: 'ace' } });
    assert.equal(project.status, 200, project.text);
    const list = await call('/projects', asMember());
    assert.deepEqual(list.data.projects.find((p) => p.id === String(yueProject._id)).carryTo.map((d) => d.engine), ['lyria', 'ace']);
    const render = await call('/render', { ...asMember(), body: { engine: 'ace', script: DIRECTION, lyrics: LYRICS, seed: 3 } });
    assert.equal(render.status, 200, render.text);
    flags({});
    const before = await mark();
    refusedAs(await call('/script', { ...asMember(), body: { engine: 'ace', mode: 'write', text: 'A slow soul song' } }), OFF, 'the desk, switched off again');
    refusedAs(await call(`/projects/${yueProject.id}/carry`, { ...asMember(), body: { engine: 'ace' } }), OFF, 'a carry, switched off again');
    await nothingMoved(before, 'a refusal');
    const list2 = await call('/projects', asMember());
    assert.ok(!list2.data.projects.some((p) => p.carryTo.some((d) => d.engine === 'ace')));
  });

  await t.test('the media link and the reference lane: ACE-Step XL has no recording to cover, so the link answers its usual sentence', async () => {
    const app2 = express();
    app2.use(link.createReferenceLinkRouter({
      auth: (req, _res, next) => { req.user = { id: 'u1', role: String(req.headers['x-test-role'] || 'USER') }; next(); },
      features: () => ({ mediaLinks: true }),
      logger: { info() {}, warn() {}, error() {} },
      store: async () => { throw new Error('nothing is stored for ACE'); },
      media: () => { throw new Error('nothing is downloaded for ACE'); },
      env: {},
    }));
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise((resolve) => server2.on('listening', resolve));
    try {
      for (const role of ['USER', 'ADMIN']) {
        const res = await fetch(`http://127.0.0.1:${server2.address().port}/reference/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ engine: 'ace', url: 'https://example.test/watch' }) });
        assert.equal(res.status, 400, role);
        assert.deepEqual(await res.json(), { error: 'Media links are for YuE2 covers. For this engine, import an audio file.' });
      }
    } finally {
      server2.closeAllConnections();
      await new Promise((resolve) => server2.close(resolve));
    }
    /* The guide the link helper rewrites keeps whatever else it was given, ACE's card included, by reference. */
    const card = ace.aceGuide({});
    const guide = { engines: { yue2: { settings: [{ key: 'reference_voice_url', hint: 'x' }] }, ace: card } };
    const out = link.guideFor(guide, { id: 'u1' }, () => ({ mediaLinks: true }), {});
    assert.equal(out.engines.ace, card);
    assert.equal(link.guideFor({ engines: { ace: card } }, { id: 'u1' }, () => ({ mediaLinks: true }), {}).engines.ace, card);
    /* A recording sent for ACE-Step XL is refused by the engine itself, in a sentence that names the right one. */
    flags({ ACE_ENABLED: '1' });
    const before = await mark();
    const cover = await call('/render', { ...asAdmin(), body: { engine: 'ace', script: DIRECTION, lyrics: LYRICS, reference_voice_url: 'https://assets.test/a.wav', referenceExpected: true } });
    assert.equal(cover.status, 400, cover.text);
    assert.equal(cover.data.error, 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.');
    await nothingMoved(before, 'a recording sent to ACE');
    flags({});
  });
});
