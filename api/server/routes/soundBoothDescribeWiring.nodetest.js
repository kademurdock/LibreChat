'use strict';
/* Oct 11 2026: Describe the sound of the recording, how kadeSoundBooth.js hands it to the router.
 *
 * The real kadeSoundBooth.js runs in a vm with a stand-in @librechat/api (the pattern of kadeSoundBoothAceGate.selftest.js), and
 * the lyrics router is replaced by a spy that keeps the hooks object it is given. What is proved:
 *   - with the feature on (KADE_DESCRIBE_SOUND unset or anything but 0) the hooks carry a `describe` that calls
 *     describeMusicSound with the recording and a key-alarm callback;
 *   - with KADE_DESCRIBE_SOUND=0, or a stand-in API that has no describer, the hooks are exactly what they were: no `describe`;
 *   - the Google key alarm hears a describe failure by its own lane name ("the sound describer"), with the name (never the value)
 *     of the key in use, and the lyric transcriber still reports under "the lyric transcriber";
 *   - end to end, with the real describer and a fake Gemini that refuses with a prepaid-balance error: the answer is no
 *     description, and the alarm fires once.
 *
 * Run: node --test api/server/routes/soundBoothDescribeWiring.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const express = require('express');
const axios = require('axios');

const logs = [];
const stubs = {
  'form-data': class {},
  '@librechat/data-schemas': { logger: { info: (l) => logs.push(['info', String(l)]), warn: (l) => logs.push(['warn', String(l)]), error: (l) => logs.push(['error', String(l)]) } },
};
function lyricsModule() {
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(mod, id));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const realLyrics = lyricsModule();

/** Loads the booth and returns the hooks it gave createLyricsRouter, and the alarms it raised. */
function loadBooth({ describerSpy, withDescriber = true, realDescriber = false, transcriberSpy }) {
  const alarms = [];
  let hooks;
  const module_ = { exports: {} };
  const localRequire = (name) => {
    if (name === '../services/kadeRealCost') return { userPriceFactor: () => 1 };
    if (name === '@librechat/data-schemas') return stubs['@librechat/data-schemas'];
    if (name === '~/server/services/kadeGoogleKeyAlarm') return { reportGoogleKeyTrouble: async (lane, error, meta) => { alarms.push({ lane, error, meta }); } };
    if (name === '@librechat/api') {
      const api = {
        needsRefresh: () => false, getNewS3URL: async (url) => url, saveBufferToS3: async () => 'https://storage.test/saved',
        createYueRouter: () => express.Router(), yueConfigured: () => false, writingCost: () => ({ costUSD: 0, measured: false }),
        splitLyricTitle: (text) => ({ script: text }), lyricTitleFromSong: () => undefined, musicWritingSettings: () => ({}),
        musicWritingBackground: () => false, labelReadback: (text) => text, lyricShapeIssue: () => null, fixStageDirections: (text) => text,
        formatGeneratedLyricsDraft: (text) => text, musicWritingPrompt: async (system) => system, yueStyles: {}, yueStylesEnabled: () => false,
        yueCost: 'test price', yueCoverSettings: (settings) => settings, yueCoverOptions: () => ({}), yueSavedOptions: (options) => options,
        yueProjectWhy: () => 'YuE2', yueTakeFacts: () => ({}), musicCoverLengthGuide: (yue) => yue, musicReferenceSpeedNote: () => '',
        effectsGuide: { name: 'Stable Audio', settings: [], howToWrite: [] }, effectsConfigured: () => false,
        effectsVariant: () => ({ name: 'Stable Audio', model: 'stable', price: 0 }), notifyMusic: async () => ({ accepted: 0 }),
        familyFeatures: () => ({ trainedStyles: false }), audioAssetDescription: (asset) => asset.description || '',
        createLyricsRouter: (given) => { hooks = given; return express.Router(); },
        transcribeMusicLyrics: transcriberSpy || (async () => ({ transcript: 'x', seconds: 1, model: 'm' })),
        ...(withDescriber
          ? { describeMusicSound: realDescriber ? realLyrics.describeMusicSound : describerSpy, describeSoundEnabled: realLyrics.describeSoundEnabled }
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
    if (name === '~/server/utils/kadeSongAudience') return { songAudience: async () => 'explicit', hasExplicitWords: () => false, explicitSungLines: () => [] };
    if (name === '~/models') return { getAgent: async () => null };
    if (name === '~/server/middleware') return { requireJwtAuth: (_req, _res, next) => next() };
    if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: {} };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async () => undefined, KadeUsage: {} };
    if (name === '~/models/kadeAsset') return { logKadeAsset: async () => ({}), KadeAsset: {} };
    return require(name.startsWith('.') ? path.join(__dirname, name) : name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8'), {
    require: localRequire, module: module_, exports: module_.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return { hooks, alarms };
}

const withEnv = (vars, run) => async () => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const MP3 = Buffer.from('ID3 fixture audio');
/* Objects made inside the vm have another Object.prototype; a JSON round trip makes them comparable. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('on: the router gets a describe hook that calls describeMusicSound with the recording and a key-alarm callback', withEnv({ KADE_DESCRIBE_SOUND: undefined, GEMINI_API_KEY: 'a-key', KADE_EMBED_GEMINI_KEY: undefined }, async () => {
  const seen = [];
  const { hooks, alarms } = loadBooth({ describerSpy: async (...args) => { seen.push(args); return { direction: 'x', seconds: 1, model: 'm' }; } });
  assert.equal(typeof hooks.describe, 'function');
  assert.equal(typeof hooks.transcribe, 'function', 'the transcribe hook is still there');
  const got = await hooks.describe(MP3, 'audio/mpeg', 30);
  assert.equal(got.direction, 'x');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], MP3);
  assert.deepEqual(seen[0].slice(1, 3), ['audio/mpeg', 30]);
  assert.equal(typeof seen[0][3], 'function', 'the key alarm callback');
  const error = new Error('Request failed with status code 429');
  seen[0][3](error);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].lane, 'the sound describer');
  assert.equal(alarms[0].error, error);
  assert.deepEqual(plain(alarms[0].meta), { keyName: 'GEMINI_API_KEY' }, 'the name of the key, never its value');
}));

test('on, with only the embed key set: the alarm names that key', withEnv({ KADE_DESCRIBE_SOUND: undefined, GEMINI_API_KEY: undefined, KADE_EMBED_GEMINI_KEY: 'embed-key' }, async () => {
  const seen = [];
  const { hooks, alarms } = loadBooth({ describerSpy: async (...args) => { seen.push(args); return null; } });
  await hooks.describe(MP3, 'audio/mpeg', 30);
  seen[0][3](new Error('boom'));
  assert.deepEqual(plain(alarms[0].meta), { keyName: 'KADE_EMBED_GEMINI_KEY' });
  assert.equal(JSON.stringify(alarms).includes('embed-key'), false);
}));

test('the lyric transcriber keeps its own lane name', withEnv({ KADE_DESCRIBE_SOUND: undefined, GEMINI_API_KEY: 'a-key' }, async () => {
  const seen = [];
  const { hooks, alarms } = loadBooth({ describerSpy: async () => null, transcriberSpy: async (...args) => { seen.push(args); return { transcript: 'x', seconds: 1, model: 'm' }; } });
  await hooks.transcribe(MP3, 'audio/mpeg', 30);
  seen[0][3](new Error('boom'));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].lane, 'the lyric transcriber');
}));

test('KADE_DESCRIBE_SOUND=0: no describe hook, so no extra call and no route; the other hooks are unchanged', withEnv({ KADE_DESCRIBE_SOUND: '0' }, async () => {
  const { hooks } = loadBooth({ describerSpy: async () => { throw new Error('must not be called'); } });
  assert.equal(hooks.describe, undefined);
  assert.deepEqual(Object.keys(hooks).sort(), ['auth', 'authorize', 'duration', 'refresh', 'savedSources', 'transcribe', 'user']);
}));

test('any other value than 0 leaves it on', withEnv({ KADE_DESCRIBE_SOUND: 'off' }, async () => {
  const { hooks } = loadBooth({ describerSpy: async () => null });
  assert.equal(typeof hooks.describe, 'function');
}));

test('a stand-in API with no describer (an older harness) has none, and loads fine', withEnv({ KADE_DESCRIBE_SOUND: undefined }, async () => {
  const { hooks } = loadBooth({ withDescriber: false });
  assert.equal(hooks.describe, undefined);
  assert.deepEqual(Object.keys(hooks).sort(), ['auth', 'authorize', 'duration', 'refresh', 'savedSources', 'transcribe', 'user']);
}));

test('end to end, with the real describer: Gemini refuses for an empty prepaid balance, the answer is no description, and the Google key alarm fires once', withEnv({ KADE_DESCRIBE_SOUND: undefined, GEMINI_API_KEY: 'gemini-key-for-tests', KADE_EMBED_GEMINI_KEY: undefined }, async () => {
  const calls = [];
  axios.defaults.adapter = async (config) => {
    calls.push(config.url);
    throw new axios.AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
      status: 429, statusText: 'Too Many Requests', headers: {}, config,
      data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } },
    });
  };
  logs.length = 0;
  const { hooks, alarms } = loadBooth({ realDescriber: true });
  assert.equal(await hooks.describe(MP3, 'audio/mpeg', 30), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].lane, 'the sound describer');
  assert.equal(alarms[0].error.response.status, 429);
  assert.deepEqual(plain(alarms[0].meta), { keyName: 'GEMINI_API_KEY' });
  assert.ok(logs.some(([level, line]) => level === 'warn' && /sound describe failed reason=http:429:RESOURCE_EXHAUSTED /.test(line)));
  assert.ok(logs.every(([, line]) => !line.includes('gemini-key-for-tests')));
}));
