/* Sing it in my voice (Sep 27 2026), without a database: the voice registry and its owner rule, the choices as the screens say
 * them, what the voice worker is sent, the estimate and the finished-take note, the owner-only guide, the YuE2 choice, and the
 * page's generic "upload" engine. The job router, the YuE2 automation and the booth's wiring run against a real Mongo in
 * kadeSoundBoothMyVoice.mongo.nodetest.js.
 *
 * Run: node --test api/server/routes/kadeSoundBoothMyVoice.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tsx = require('tsx/cjs/api');

const voice = tsx.require('../../../packages/api/src/music/myVoice.ts', __filename);
const yue = tsx.require('../../../packages/api/src/music/yue.ts', __filename);

const OWNER = '6a0000000000000000000001';
const OTHER = '6a0000000000000000000002';
const SHA = 'a'.repeat(64);
const ENTRY = {
  model_key: `voice-models/${OWNER}/k3x9q/model.pth`,
  model_sha256: SHA,
  index_key: `voice-models/${OWNER}/k3x9q/model.index`,
  index_sha256: 'b'.repeat(64),
  range: { p05: 55.2, p50: 63.1, p95: 70.1 },
};
const ON = {
  MY_VOICE_ENABLED: '1',
  MY_VOICE_ENDPOINT_ID: 'ep',
  RUNPOD_API_KEY: 'k',
  MY_VOICE_MODELS: JSON.stringify({ [OWNER]: ENTRY }),
};

test('the registry takes only entries whose files sit in that account’s own folder', () => {
  const models = voice.parseMyVoiceModels(
    JSON.stringify({
      [OWNER]: ENTRY,
      [OTHER]: { model_key: `voice-models/${OWNER}/k3x9q/model.pth` }, // someone else's folder
      bad1: { model_key: 'voice-models/bad1/../x/model.pth' },
      bad2: { model_key: 'voice-models/bad2/m.pth', model_sha256: 'xyz' },
      bad3: { model_key: 'voice-models/bad3/m.pth', range: { p05: 70, p50: 60, p95: 80 } },
      bad4: { model_key: 'voice-models/bad4/m.pth', index_key: 'voice-models/other/m.index' },
      'bad user!': { model_key: 'voice-models/bad user!/m.pth' },
    }),
  );
  assert.deepEqual(Object.keys(models), [OWNER]);
  assert.equal(models[OWNER].label, 'My voice');
  assert.equal(models[OWNER].source, 'env');
  assert.deepEqual(models[OWNER].range, ENTRY.range);
  assert.deepEqual(voice.parseMyVoiceModels('not json'), {});
  assert.deepEqual(voice.parseMyVoiceModels('[1,2]'), {});
  assert.deepEqual(voice.parseMyVoiceModels(undefined), {});
});

test('only the owner, and only with the flag and the endpoint set', async () => {
  assert.equal((await voice.findMyVoiceModel(OWNER, ON)).model_key, ENTRY.model_key);
  assert.equal(
    await voice.findMyVoiceModel(OTHER, ON),
    null,
    'no table without a database: fails closed',
  );
  assert.equal(await voice.findMyVoiceModel(OWNER, { ...ON, MY_VOICE_ENABLED: '0' }), null);
  assert.equal(await voice.findMyVoiceModel(OWNER, { ...ON, MY_VOICE_ENDPOINT_ID: '' }), null);
  assert.equal(await voice.findMyVoiceModel(OWNER, { ...ON, RUNPOD_API_KEY: '' }), null);
  assert.equal(await voice.findMyVoiceModel('', ON), null);
  await assert.rejects(voice.registerMyVoiceModel(OTHER, ENTRY, 'said yes'), /does not belong/);
  await assert.rejects(voice.registerMyVoiceModel(OWNER, ENTRY, '  '), /said yes/);
});

test('a render body becomes a voice job; her choices are read in the words the screens show', () => {
  const url = 'https://assets.test/audios/u/song.mp3';
  const job = voice.myVoiceInput({ reference_voice_url: url }, ON);
  assert.deepEqual(job.voice, {
    source: 'song',
    pitch: 'auto',
    options: {
      extractor: 'hyperace',
      lead_split: true,
      lead_model: 'frazer',
      dereverb: false,
      soft_s: true,
      index_rate: 0.5,
      protect: 0.33,
      rms_mix_rate: 0.25,
    },
  });
  assert.equal(job.title, 'Sung in my voice');
  assert.equal(job.count, 1);
  const set = voice.myVoiceInput(
    {
      reference_voice_url: url,
      voice_source: 'Just a vocal',
      pitch: '-12',
      extractor: 'Mel-RoFormer Kim',
      lead_split: false,
      dereverb: 'on',
      soft_s: 'off',
      index_rate: 0.3,
      protect: 0.2,
      rms_mix_rate: 1,
      title: 'Take 2',
    },
    ON,
  );
  assert.deepEqual(set.voice, {
    source: 'vocal',
    pitch: -12,
    options: {
      extractor: 'melband_kim',
      lead_split: false,
      lead_model: 'frazer',
      dereverb: true,
      soft_s: false,
      index_rate: 0.3,
      protect: 0.2,
      rms_mix_rate: 1,
    },
  });
  assert.equal(
    voice.myVoiceInput({ reference_voice_url: url, extractor: 'demucs', pitch: '' }, ON).voice
      .options.extractor,
    'demucs',
  );
  /* Every extractor by its own label: two labels start "BS-RoFormer" and two "Mel-RoFormer", and a first-word match used to
   * send becruily to Kim. */
  for (const e of voice.myVoiceExtractors)
    assert.equal(
      voice.myVoiceInput({ reference_voice_url: url, extractor: e.label }, ON).voice.options
        .extractor,
      e.key,
      e.label,
    );
  assert.throws(
    () => voice.myVoiceInput({ reference_voice_url: url, extractor: 'BS-RoFormer' }, ON),
    /listed extractors/,
    'a first word two extractors share names neither',
  );
  for (const [body, words] of [
    [{}, /Recording to sing/],
    [{ reference_voice_url: 'http://assets.test/x.mp3' }, /Recording to sing/],
    [{ referenceExpected: true }, /finish importing/],
    [{ reference_voice_url: url, voice_source: 'karaoke' }, /Song with music or Just a vocal/],
    [{ reference_voice_url: url, pitch: 30 }, /-24 to 24/],
    [{ reference_voice_url: url, pitch: 1.5 }, /whole number/],
    [{ reference_voice_url: url, extractor: 'magic' }, /listed extractors/],
    [{ reference_voice_url: url, protect: 0.9 }, /from 0 to 0.5/],
    [{ reference_voice_url: url, lead_split: 'maybe' }, /on or off/],
    [{ reference_voice_url: url, soft_s: 'sometimes' }, /Softer S sounds, choose on or off/],
  ])
    assert.throws(() => voice.myVoiceInput(body, ON), words, JSON.stringify(body));
});

test('MY_VOICE_DEFAULTS moves the defaults after her listening; nonsense in it is ignored', () => {
  const env = {
    ...ON,
    MY_VOICE_DEFAULTS: JSON.stringify({
      extractor: 'melband_kim',
      protect: 0.2,
      lead_split: false,
      index_rate: 7,
      extractor2: 'x',
      lead_model: 'magic',
      soft_s: 'no',
    }),
  };
  assert.deepEqual(voice.myVoiceDefaults(env), {
    extractor: 'melband_kim',
    lead_split: false,
    lead_model: 'frazer',
    dereverb: false,
    soft_s: true,
    index_rate: 0.5,
    protect: 0.2,
    rms_mix_rate: 0.25,
  });
  /* Round 1's chain, if her listening prefers it: one setting on Railway. */
  const round1 = {
    ...ON,
    MY_VOICE_DEFAULTS: JSON.stringify({
      extractor: 'bs_roformer',
      lead_model: 'aufr33',
      dereverb: true,
      soft_s: false,
    }),
  };
  assert.deepEqual(
    (({ extractor, lead_model, dereverb, soft_s }) => ({
      extractor,
      lead_model,
      dereverb,
      soft_s,
    }))(voice.myVoiceDefaults(round1)),
    { extractor: 'bs_roformer', lead_model: 'aufr33', dereverb: true, soft_s: false },
  );
  assert.match(voice.myVoiceGuideEngine(round1).howToWrite.join(' '), /turn on Softer S sounds/);
  assert.match(voice.myVoiceGuideEngine(ON).howToWrite.join(' '), /Softer S sounds is on/);
  assert.equal(
    voice.myVoiceGuideEngine(env).settings.find((s) => s.key === 'extractor').default,
    'Mel-RoFormer Kim',
  );
  assert.deepEqual(
    voice.myVoiceDefaults({ MY_VOICE_DEFAULTS: '{broken' }),
    voice.myVoiceDefaults({}),
  );
});

test('the owner check adds her model and the recording length; the worker gets exactly its contract', async () => {
  const url = 'https://assets.test/audios/u/song.mp3';
  const prepare = voice.myVoicePrepare(
    async (user) => (user === OWNER ? voice.parseMyVoiceModels(ON.MY_VOICE_MODELS)[OWNER] : null),
    async () => 187.5,
  );
  await assert.rejects(
    prepare(OTHER, voice.myVoiceInput({ reference_voice_url: url }, ON)),
    /not available/,
  );
  const ready = await prepare(
    OWNER,
    voice.myVoiceInput({ reference_voice_url: url, pitch: 12 }, ON),
  );
  assert.equal(ready.voice.seconds, 187.5);
  assert.deepEqual(voice.myVoiceWorkerInput(ready), {
    mode: 'song',
    audio_url: url,
    pitch: 12,
    model_key: ENTRY.model_key,
    model_sha256: SHA,
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
  const round1 = await prepare(
    OWNER,
    voice.myVoiceInput({ reference_voice_url: url, extractor: 'bs_roformer' }, ON),
  );
  assert.equal(
    voice.myVoiceWorkerInput(round1).options.fallback,
    'demucs',
    'never its own fallback',
  );
  const opts = voice.myVoiceProjectOptions(ready);
  assert.deepEqual(opts, {
    voice_source: 'Song with music',
    extractor: 'BS-RoFormer HyperACE v2',
    lead_split: true,
    dereverb: false,
    soft_s: true,
    index_rate: 0.5,
    protect: 0.33,
    rms_mix_rate: 0.25,
    reference_voice_url: url,
    pitch: 12,
  });
  assert.ok(!JSON.stringify(opts).includes('voice-models/'), 'the project never carries the model');
  assert.equal(
    voice.myVoiceProjectWhy({ voice_source: 'Just a vocal' }),
    'Sung in my voice — a vocal on its own',
  );
});

test('money: said before, measured after, at the rate of the card that ran it', () => {
  const song = voice.myVoiceEstimate({ voice: { source: 'song', seconds: 180 } });
  assert.equal(song.costUSD, Math.round((45 + 0.45 * 180) * 0.000306 * 1000) / 1000);
  assert.match(song.spoken, /^About 4 cents of GPU time for a recording this long/);
  assert.match(
    voice.myVoiceEstimate({ voice: { source: 'vocal' } }).spoken,
    /song of about four minutes/,
  );
  assert.match(song.spoken, /does not use your credit balance/);
  assert.equal(voice.myVoiceTakeCost(90000, 'NVIDIA GeForce RTX 4090'), 90 * 0.000306);
  assert.equal(voice.myVoiceTakeCost(90000, 'Some New Card'), 90 * yue.yueFallbackUsdPerSecond);
  assert.equal(voice.myVoiceTakeCost(undefined, null), 0);
});

test('the finished-take note: the octave, what the worker worked around, and the cost', () => {
  const note = voice.myVoiceTakeNote({
    url: 'u',
    gpu: 'NVIDIA GeForce RTX 4090',
    execution_ms: 100000,
    pitch: { shift: -12 },
    worker_notes: [
      'The lead singer could not be told apart from the backing vocals, so every voice was re-sung together.',
    ],
  });
  assert.equal(
    note,
    'Sung in your voice. Moved down one octave to sit in your range. The lead singer could not be told apart from the backing vocals, so every voice was re-sung together. About 3 cents of GPU time on RTX 4090, execution only.',
  );
  assert.match(
    voice.myVoiceTakeNote({ pitch: { shift: 0, share_above_top: 0.18 } }),
    /high notes sit above your usual top/,
  );
  assert.equal(voice.myVoiceTakeNote(undefined), '');
});

test('the guide gains the engine and the YuE2 choice for an owner, and not a word for anyone else', () => {
  const guide = {
    engines: {
      yue2: { settings: [{ key: 'lyrics' }, { key: 'count' }, { key: 'seed' }] },
      lyria: { settings: [] },
    },
  };
  assert.equal(voice.withMyVoiceGuide(guide, null), guide, 'unchanged, the very same object');
  const model = voice.parseMyVoiceModels(ON.MY_VOICE_MODELS)[OWNER];
  const mine = voice.withMyVoiceGuide(guide, model, ON);
  assert.deepEqual(
    mine.engines.yue2.settings.map((s) => s.key),
    ['lyrics', 'my_voice', 'count', 'seed'],
  );
  assert.deepEqual(
    voice.withMyVoiceGuide(mine, model, ON).engines.yue2.settings.map((s) => s.key),
    ['lyrics', 'my_voice', 'count', 'seed'],
    'added once',
  );
  const engine = mine.engines.myvoice;
  assert.equal(engine.flow, 'upload');
  assert.deepEqual(
    engine.settings.map((s) => s.key),
    [
      'reference_voice_url',
      'voice_source',
      'pitch',
      'extractor',
      'lead_split',
      'soft_s',
      'dereverb',
      'index_rate',
      'protect',
      'rms_mix_rate',
    ],
  );
  assert.deepEqual(
    engine.settings.filter((s) => !s.advanced).map((s) => s.key),
    ['reference_voice_url', 'voice_source'],
    'the recording and what is in it stay in view; the rest waits in More settings',
  );
  assert.equal(engine.settings.find((s) => s.key === 'soft_s').default, true);
  assert.equal(engine.settings.find((s) => s.key === 'dereverb').default, false);
  assert.match(engine.ui.fromTake, /attached/);
  assert.deepEqual(engine.settings[1].options, ['Song with music', 'Just a vocal']);
  assert.deepEqual(voice.myVoiceYueSetting.options, ['Off', 'On']);
  assert.equal(guide.engines.yue2.settings.length, 3, 'the shared guide is never changed');
  const words = JSON.stringify(mine);
  for (const name of [/kade/i, /murdock/i, /holly/i, /singaling/i, /persona/i, /G3|A#4/])
    assert.doesNotMatch(words, name);
  assert.doesNotMatch(words, /voice-models\//, 'no storage key reaches a screen');
});

test('YuE2: "On" asks for a version in her voice and never reaches the music worker; nothing else changes', () => {
  const base = { script: 'Warm soul', lyrics: '[Verse]\nla la' };
  assert.equal(yue.yueInput({ ...base, my_voice: 'On' }).my_voice, true);
  assert.equal(yue.yueInput({ ...base, my_voice: true }).my_voice, true);
  for (const off of ['Off', undefined, 'nonsense', false])
    assert.equal('my_voice' in yue.yueInput({ ...base, my_voice: off }), false);
  const input = yue.yueInput({ ...base, my_voice: 'On' });
  assert.match(yue.yueTakeNote({ features: [] }, input), /A version in your voice follows/);
  assert.equal(yue.yueTakeNote({ features: [] }, yue.yueInput(base)), '');
});

/* ---------- the page: a generic "upload" engine, named by the guide, never by the page ---------- */
function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) =>
      name === './kadePages'
        ? { SHARED_HEAD: '<meta charset="utf-8">' }
        : require(path.join(__dirname, name)),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'),
    context,
  );
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('function confirmRender('));
function pageFunction(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('the shared page names no engine of hers: its words come from her guide', () => {
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /myvoice|Sing it in my voice|Song with music|Just a vocal/i);
  assert.match(
    code,
    /Object\.keys\(state\.guide\.engines\)\.forEach\(function\(k\)\{ if\(engineOrder\.indexOf\(k\)<0\) engineOrder\.push\(k\); \}\)/,
  );
});

test('an upload engine asks for its recording instead of a script, then renders with no script at all', async () => {
  const ui = voice.myVoiceGuideEngine(ON).ui;
  const run = async (clips) => {
    const focused = [];
    const ctx = {
      state: {
        writing: false,
        engine: 'myvoice',
        clips,
        guide: { engines: { myvoice: { flow: 'upload', ui } } },
      },
      said: [],
      rendered: 0,
      referenceReady: () => true,
      collect: () => ({ engine: 'myvoice' }),
      say: (words, err) => ctx.said.push([words, !!err]),
      document: {
        getElementById: () => ({ open: false, focus() {} }),
        querySelector: () => ({ focus: () => focused.push('file') }),
      },
    };
    ctx.doRender = () => {
      ctx.rendered++;
    };
    vm.runInNewContext(
      [pageFunction('isUpload'), pageFunction('uploadUi'), pageFunction('confirmRender')].join(
        '\n',
      ) + '\nthis.confirmRender = confirmRender;',
      ctx,
    );
    await ctx.confirmRender(false);
    return { ctx, focused };
  };
  const empty = await run([]);
  assert.equal(empty.ctx.rendered, 0);
  assert.deepEqual(empty.ctx.said, [[ui.needClip, true]]);
  assert.deepEqual(empty.focused, ['file'], 'focus goes to the file picker');
  assert.equal((await run([{ url: 'https://assets.test/a.mp3', name: 'a.mp3' }])).ctx.rendered, 1);
  const render = pageFunction('doRender');
  assert.match(
    render,
    /b\.script = isUpload\(\) \? undefined :/,
    'no voice placeholder is sent for an upload engine',
  );
  assert.match(render, /b\.auk_task!=='edit' && !isUpload\(\)/, 'and no script is required');
});

test('the library offers her the take sung again, and the voice-only file, from the guide’s words', () => {
  assert.match(script, /data-use="upload">'\+esc\(uploadUi\(ue\)\.useTake\|\|'Use this take'\)/);
  assert.match(script, /t\.vocalUrl \? ' · <a href="'\+esc\(t\.vocalUrl\)\+'" download/);
  assert.match(script, /t\.voiceNote \? '<p class="hint">' \+ esc\(t\.voiceNote\) \+ '<\/p>'/);
  assert.match(
    script,
    /state\.clips=\[\{url:take\.url, name:project\.title/,
    'the listening MP3, which fits the length check',
  );
});

test('the upload engine on the page: one sentence when a take is sent, focus that lands, no writing row, no second pass', () => {
  /* Focus goes to something that exists: the script box elsewhere, the recording picker (or the button) on an upload engine. */
  const focusIn = (engine, pickerDisabled) => {
    const got = [];
    const ctx = {
      state: { engine, guide: { engines: { myvoice: { flow: 'upload' }, yue2: {} } } },
      document: {
        getElementById: (id) => ({ focus: () => got.push(id) }),
        querySelector: () => ({ disabled: pickerDisabled, focus: () => got.push('picker') }),
      },
    };
    vm.runInNewContext(
      [pageFunction('isUpload'), pageFunction('focusWork'), 'focusWork();'].join('\n'),
      ctx,
    );
    return got;
  };
  assert.deepEqual(focusIn('yue2', false), ['script']);
  assert.deepEqual(focusIn('myvoice', false), ['picker']);
  assert.deepEqual(
    focusIn('myvoice', true),
    ['btnRender'],
    'a full picker is disabled: the button instead',
  );
  /* A library take sent to it: setEngine stays quiet and the handler says the one sentence, that the take is attached. */
  assert.match(script, /if\(!ue \|\| !setEngine\(ue, true\)\) return;/);
  assert.match(pageFunction('setEngine'), /if\(!quiet\) say\(uploadUi\(e\)\.select\|\|g\.name\)/);
  assert.match(
    script,
    /say\(uploadUi\(ue\)\.fromTake\|\|uploadUi\(ue\)\.select\|\|''\); document\.getElementById\('btnRender'\)\.focus\(\)/,
  );
  /* The quick-writing row was shown again two lines after being hidden. */
  assert.match(
    pageFunction('applyWorkflow'),
    /getElementById\('quickWriting'\)\.hidden=effects\|\|upload;/,
  );
  /* A version already in her voice is not offered to be sung in her voice again. */
  assert.match(script, /\(ue && !t\.voiceOf && \(state\.guide\.engines\[ue\]\.takesFrom/);
});
