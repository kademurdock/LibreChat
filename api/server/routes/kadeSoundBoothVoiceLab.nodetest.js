/* Nov 18 2026: the song swap's newer settings (presets, key fitting, backing singers, voice size, cleanup, stems, a chosen
 * voice) and the voice lab (packages/api music/voiceLab.ts) with its page. The settings run without a database; the lab's
 * routes run against a real Mongo (memory server) with the voice worker and the bucket answered by hooks in this file.
 * Nothing leaves the machine.
 *
 * Run: node --test api/server/routes/kadeSoundBoothVoiceLab.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const voice = require('../../../packages/api/src/music/myVoice.ts');
const lab = require('../../../packages/api/src/music/voiceLab.ts');

const OWNER = '6a0000000000000000000001';
const OTHER = '6a0000000000000000000002';
const ENTRY = {
  model_key: `voice-models/${OWNER}/k3x9q/model.pth`,
  model_sha256: 'a'.repeat(64),
  index_key: `voice-models/${OWNER}/k3x9q/model.index`,
  index_sha256: 'b'.repeat(64),
  range: { p05: 55.2, p50: 63.1, p95: 70.1 },
};
const ON = { MY_VOICE_ENABLED: '1', MY_VOICE_ENDPOINT_ID: 'ep', RUNPOD_API_KEY: 'k', MY_VOICE_MODELS: JSON.stringify({ [OWNER]: ENTRY }) };
const URL_ = 'https://assets.test/audios/u/song.mp3';
const withModel = (job) => ({ ...job, voice: { ...job.voice, model: ENTRY } });

test('a job at the defaults sends the worker exactly what it always sent', () => {
  const sent = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_ }, ON)));
  assert.deepEqual(Object.keys(sent.options).sort(), ['dereverb', 'extractor', 'f0_method', 'fallback', 'index_rate', 'lead_model', 'lead_split', 'protect', 'rms_mix_rate', 'room', 'soft_s']);
  assert.equal(sent.pitch, 'auto');
  assert.equal('transpose_song' in sent, false);
  assert.equal(sent.options.f0_method, 'rmvpe');
  /* an octave is never a key change, so the music is not asked to move */
  const octave = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_, pitch: -12 }, ON)));
  assert.equal('transpose_song' in octave, false);
});

test('the newer settings ride along only when they ask for something, in the words the screens show', () => {
  const job = voice.myVoiceInput({
    reference_voice_url: URL_, pitch: 3, formant: -2, denoise: 0.4, dereverb: true, dereverb_strength: 0.6,
    backing: 'Sing them in the voice too', f0_method: 'Simple', preset_filled: true,
  }, ON);
  const sent = voice.myVoiceWorkerInput(withModel(job));
  assert.equal(sent.pitch, 3);
  assert.equal(sent.transpose_song, true, 'three semitones is a key change: the music moves with the voice');
  assert.equal(sent.options.formant, -2);
  assert.equal(sent.options.denoise, 0.4);
  assert.equal(sent.options.dereverb_strength, 0.6);
  assert.equal(sent.options.backing, 'convert');
  assert.equal(sent.options.f0_method, 'pm');
  assert.equal('transpose_song' in sent.options, false, 'the switch is a top-level field, never an option');
  /* her own choice to leave the band where it is */
  const still = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_, pitch: 3, transpose_song: false }, ON)));
  assert.equal('transpose_song' in still, false);
  /* a dry vocal has no band to move, and no backing singers to choose about without the split */
  const dry = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_, voice_source: 'Just a vocal', pitch: 3 }, ON)));
  assert.equal('transpose_song' in dry, false);
  const unsplit = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_, lead_split: false, backing: 'remove' }, ON)));
  assert.equal('backing' in unsplit.options, false);
  /* the strength only matters with the room taken off */
  const noRoom = voice.myVoiceWorkerInput(withModel(voice.myVoiceInput({ reference_voice_url: URL_, dereverb_strength: 0.3 }, ON)));
  assert.equal('dereverb_strength' in noRoom.options, false);
});

test('fitting the key: asked for by the choice, overridden by typed semitones', () => {
  const fit = voice.myVoiceInput({ reference_voice_url: URL_, pitch_mode: 'Fit the voice: change the key' }, ON);
  assert.equal(fit.voice.pitch, 'fit');
  const sent = voice.myVoiceWorkerInput(withModel(fit));
  assert.equal(sent.pitch, 'fit');
  assert.equal(sent.transpose_song, true);
  assert.deepEqual(sent.voice_range, ENTRY.range);
  assert.equal(voice.myVoiceInput({ reference_voice_url: URL_, pitch_mode: 'Fit the voice: change the key', pitch: 2 }, ON).voice.pitch, 2);
  assert.equal(voice.myVoiceInput({ reference_voice_url: URL_, pitch_mode: 'Automatic: octaves only' }, ON).voice.pitch, 'auto');
  assert.equal(voice.myVoiceProjectOptions(fit).pitch_mode, 'Fit the voice: change the key');
});

test('refusals for the newer settings are sentences', () => {
  for (const body of [{ formant: 9 }, { denoise: 2 }, { dereverb_strength: -1 }, { backing: 'explode' }, { f0_method: 'magic' }])
    assert.throws(() => voice.myVoiceInput({ reference_voice_url: URL_, ...body }, ON), /must be from|choose one of the listed/);
});

test('a preset fills the settings: on the page by the guide, on the server for a client that sends only its name', () => {
  const engine = voice.myVoiceGuideEngine(ON);
  const preset = engine.settings.find((s) => s.key === 'preset');
  assert.equal(preset.kind, 'choice');
  assert.equal(preset.default, 'Natural');
  assert.deepEqual(preset.options, voice.myVoicePresets.map((p) => p.label));
  assert.ok(preset.options.includes('Clear diction') && preset.options.includes('Keep the original phrasing'));
  const keys = new Set(engine.settings.map((s) => s.key));
  for (const [name, fills] of Object.entries(preset.fills)) {
    assert.ok(preset.about[name], `${name} says what it does`);
    for (const [key, value] of Object.entries(fills)) {
      assert.ok(keys.has(key), `${name} fills ${key}, a setting the page shows`);
      const setting = engine.settings.find((s) => s.key === key);
      if (setting.kind === 'range') assert.ok(value >= setting.min && value <= setting.max, `${name}.${key} is inside its slider`);
      if (setting.kind === 'toggle') assert.equal(typeof value, 'boolean');
    }
  }
  /* Natural is the defaults, so choosing it changes nothing */
  const natural = voice.myVoiceInput({ reference_voice_url: URL_, preset: 'Natural' }, ON);
  const plain = voice.myVoiceInput({ reference_voice_url: URL_ }, ON);
  assert.deepEqual(natural.voice.options, plain.voice.options);
  assert.equal(natural.voice.preset, 'natural');
  /* a name alone (an app that draws no fills): the preset's values, around whatever she set herself */
  const named = voice.myVoiceInput({ reference_voice_url: URL_, preset: 'Clear diction', soft_s: false, protect: 0.33, index_rate: 0.9 }, ON);
  assert.equal(named.voice.options.soft_s, true, 'a setting still on its default takes the preset');
  assert.equal(named.voice.options.protect, 0.2);
  assert.equal(named.voice.options.index_rate, 0.9, 'a setting she moved stays hers');
  /* the web page fills the boxes itself and says so: every value is then taken as it stands */
  const filled = voice.myVoiceInput({ reference_voice_url: URL_, preset: 'Clear diction', preset_filled: true, soft_s: false, protect: 0.33 }, ON);
  assert.equal(filled.voice.options.soft_s, false);
  assert.equal(filled.voice.options.protect, 0.33);
  assert.equal(voice.myVoiceProjectOptions(filled).preset, 'Clear diction');
  /* an unknown preset is ignored, never a refusal */
  assert.equal(voice.myVoiceInput({ reference_voice_url: URL_, preset: 'Sparkle' }, ON).voice.preset, undefined);
});

test('every new setting on the page is a real control with a plain label and a hint', () => {
  const engine = voice.myVoiceGuideEngine(ON);
  for (const key of ['preset', 'pitch_mode', 'transpose_song', 'formant', 'backing', 'f0_method', 'dereverb_strength', 'denoise']) {
    const s = engine.settings.find((x) => x.key === key);
    assert.ok(s, key);
    assert.ok(['choice', 'toggle', 'range'].includes(s.kind), `${key} is a select, a checkbox or a slider`);
    assert.ok(s.label.length > 3 && s.hint.length > 20);
    assert.doesNotMatch(s.label, /f0|rms|index|formant|dereverb|denoise/i, `${key}'s label is in plain words`);
    if (s.kind === 'choice') assert.ok(s.options.includes(s.default));
    if (s.kind === 'range') assert.ok(s.default >= s.min && s.default <= s.max);
  }
  assert.equal(engine.settings.find((s) => s.key === 'formant').unit, 'semitones');
  assert.ok(engine.settings.filter((s) => !s.advanced).length <= 5, 'the main view stays short');
  assert.equal(engine.ui.rack, 'Open in the effects rack');
});

test('the voice choice: shown only with more than one voice; a name reaches only her own voices', async () => {
  assert.equal(voice.myVoiceGuideEngine(ON).settings.some((s) => s.key === 'voice'), false);
  const made = { id: 'v0123456789abcde', name: 'Low harmony', model: voice.parseMyVoiceModels(JSON.stringify({ [OWNER]: { model_key: `voice-models/${OWNER}/v0123456789abcde/model.pth`, range: { p05: 45, p50: 52, p95: 60 } } }))[OWNER] };
  const withVoices = voice.myVoiceGuideEngine(ON, [made]);
  const choice = withVoices.settings.find((s) => s.key === 'voice');
  assert.deepEqual(choice.options, ['My voice', 'Low harmony']);
  assert.equal(choice.default, 'My voice');
  const own = voice.parseMyVoiceModels(ON.MY_VOICE_MODELS)[OWNER];
  const prepare = voice.myVoicePrepare(async (u) => (u === OWNER ? own : null), undefined, async () => [made]);
  const mine = await prepare(OWNER, voice.myVoiceInput({ reference_voice_url: URL_ }, ON));
  assert.equal(mine.voice.model.model_key, ENTRY.model_key);
  assert.equal(mine.voice.voice_name, undefined);
  const asked = await prepare(OWNER, voice.myVoiceInput({ reference_voice_url: URL_, voice: 'low harmony' }, ON));
  assert.equal(asked.voice.model.model_key, made.model.model_key);
  assert.equal(asked.voice.voice_name, 'Low harmony');
  assert.deepEqual(voice.myVoiceWorkerInput(asked).voice_range, { p05: 45, p50: 52, p95: 60 });
  assert.equal(voice.myVoiceProjectOptions(asked).voice, 'Low harmony');
  assert.match(voice.myVoiceTakeNote({ url: 'https://x/y.mp3' }, asked), /^Sung in the voice Low harmony\./);
  await assert.rejects(prepare(OWNER, voice.myVoiceInput({ reference_voice_url: URL_, voice: 'Somebody' }, ON)), /not in your voice list/);
  await assert.rejects(prepare(OTHER, voice.myVoiceInput({ reference_voice_url: URL_, voice: 'Low harmony' }, ON)), /not available/);
  /* a voice whose model sits in another account's folder is never usable, whatever list hands it over */
  const stolen = { ...made, model: { ...made.model, user: OTHER } };
  const bad = voice.myVoicePrepare(async () => own, undefined, async () => [stolen]);
  await assert.rejects(bad(OWNER, voice.myVoiceInput({ reference_voice_url: URL_, voice: 'Low harmony' }, ON)), /not in your voice list/);
});

test('stems, the key change and an older worker, said back', () => {
  const out = {
    url: 'https://b/mix.mp3', instrumental_url: 'https://b/instrumental.mp3', instrumental_wav_url: 'https://b/instrumental.wav',
    backing_url: 'https://b/backing.mp3', lead_original_url: 'https://b/lead.mp3', features: ['stems', 'transpose', 'formant', 'denoise', 'backing-modes', 'pitch-fit'],
    pitch: { shift: 3, source: 'set', transposed_song: true },
  };
  assert.deepEqual(voice.myVoiceStemLinks(out), {
    instrumentalUrl: 'https://b/instrumental.mp3', instrumentalWavUrl: 'https://b/instrumental.wav',
    backingUrl: 'https://b/backing.mp3', leadOriginalUrl: 'https://b/lead.mp3',
  });
  assert.deepEqual(voice.myVoiceStemLinks({ url: 'https://b/mix.mp3', instrumental_url: 'javascript:alert(1)' }), {});
  assert.deepEqual(voice.myVoiceStemLinks(undefined), {});
  const job = voice.myVoiceInput({ reference_voice_url: URL_, pitch: 3, formant: 2 }, ON);
  assert.match(voice.myVoiceTakeNote(out, job), /Moved 3 semitones up, and the music moved with it\./);
  assert.doesNotMatch(voice.myVoiceTakeNote(out, job), /older than/);
  assert.match(voice.myVoiceTakeNote({ url: 'https://b/mix.mp3', features: ['song'] }, job), /The voice worker is older than some of these settings/);
  assert.doesNotMatch(voice.myVoiceTakeNote({ url: 'https://b/mix.mp3', features: ['song'] }, voice.myVoiceInput({ reference_voice_url: URL_ }, ON)), /older than/);
  /* singing the backing vocals too costs a second pass, and the estimate says so in money */
  const one = voice.myVoiceEstimate(voice.myVoiceInput({ reference_voice_url: URL_ }, ON)).costUSD;
  const two = voice.myVoiceEstimate(voice.myVoiceInput({ reference_voice_url: URL_, backing: 'convert' }, ON)).costUSD;
  assert.ok(two > one);
});

test('voice lab: names, the epochs table and the guide', () => {
  assert.equal(lab.checkVoiceName('  Dad   singing '), 'Dad singing');
  for (const bad of ['', 'x', 'y'.repeat(41), 'My Voice', 'a<b>c']) assert.throws(() => lab.checkVoiceName(bad), /name|My voice/);
  assert.deepEqual([2, 10, 20, 45].map(lab.voiceLabEpochs), [300, 200, 120, 80]);
  const guide = lab.voiceLabGuide();
  assert.match(guide.consent, /permission/);
  assert.ok(guide.tips.length >= 4);
  assert.equal(lab.voiceLabEnabled(ON), true);
  assert.equal(lab.voiceLabEnabled({ ...ON, VOICE_LAB_ENABLED: '0' }), false);
  assert.equal(lab.voiceLabEnabled({ ...ON, MY_VOICE_ENABLED: '0' }), false);
});

test('the voice lab page: labelled controls, one live region, a script that parses', () => {
  const stubs = { './kadePages': { SHARED_HEAD: '<meta charset="utf-8"><script>async function getToken(){return null;}</script>' } };
  const file = path.join(__dirname, 'kadeSoundBoothVoicesPage.js');
  const sandbox = { module: { exports: {} }, require: (id) => stubs[id] };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const html = sandbox.module.exports.voiceLabHtml;
  assert.equal((html.match(/aria-live=/g) || []).length, 1, 'one live region');
  assert.match(html, /<div id="status" class="status" role="status" aria-live="polite">/);
  assert.match(html, /<h1>Voice lab<\/h1>/);
  /* every static input is labelled: by a label for=, or by sitting inside its label */
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>', html.indexOf('<body>')));
  for (const m of body.matchAll(/<input[^>]*id="([^"]+)"[^>]*>/g)) {
    const labelled = body.includes(`for="${m[1]}"`) || new RegExp(`<label>\\s*<input[^>]*id="${m[1]}"`).test(body);
    assert.ok(labelled, `input ${m[1]} has a label`);
  }
  assert.match(body, /<fieldset>\s*<legend>Whose voice is it\?<\/legend>/);
  assert.doesNotMatch(html, /<canvas|draggable|ondrag/i);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const source of scripts) new vm.Script(source);
  const page = scripts[scripts.length - 1];
  /* the controls the script draws carry their own names, and the paid press is a two-step confirm */
  assert.match(page, /<label class="field" for="file_'\+id\+'">Add a recording to /);
  assert.match(page, /Remove '\+esc\(s\.name\)/);
  assert.match(page, /state\.confirm !== id/);
  assert.match(page, /Press the button again to start\./);
  assert.match(page, /echoCancellation: false, noiseSuppression: false/);
});

test('the booth page: a preset fills, a slider says its unit, a take leads to the rack and its stems', () => {
  const file = fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8');
  assert.match(file, /function applyPreset\(setting, name\)/);
  assert.match(file, /b\.preset_filled = true/);
  assert.match(file, /function unitText\(v,unit\)/);
  assert.match(file, /aria-valuetext=/);
  assert.match(file, /state\.rack = !!h\.data\.rack/);
  assert.match(file, /\/voice-changer\?'\+q\+'&title='/);
  assert.match(file, /t\.instrumentalUrl \?/);
  assert.match(file, /href="\/sound-booth\/voices"/);
  const sandbox = {};
  vm.runInNewContext(`${/function unitText\(v,unit\)\{[^\n]*\}/.exec(file)[0]}; out = [unitText(2,'semitones'), unitText(-1.5,'semitones'), unitText(1,'semitones'), unitText(0,'semitones')];`, sandbox);
  assert.deepEqual([...sandbox.out], ['2 semitones', 'minus 1.5 semitones', '1 semitone', '0 semitones']);
});

test('the voice lab through its routes', async (t) => {
  const express = require('express');
  const mongoose = require('mongoose');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  Object.assign(process.env, ON);
  delete process.env.VOICE_LAB_ENABLED;
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mongo-mem-')));
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const stored = new Map();
  const removed = [];
  const worker = { runs: [], status: 'IN_QUEUE', output: undefined, failRun: false, cancelled: [] };
  const said = [];
  const made = lab.createVoiceLab({
    auth: (req, res, next) => { req.user = { id: req.headers['x-user'] }; return req.user.id ? next() : res.status(401).json({ error: 'Sign in.' }); },
    user: (req) => String(req.user.id),
    allowed: async (user) => user === OWNER,
    upload: (req, res, next) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { req.file = { buffer: Buffer.concat(chunks), originalname: String(req.headers['x-name'] || ''), mimetype: String(req.headers['content-type'] || '') }; next(); });
    },
    put: async (key, body) => { stored.set(key, body.length); },
    remove: async (keys) => { for (const k of keys) { removed.push(k); stored.delete(k); } },
    seconds: async (body) => (body.length >= 10 ? body.length : undefined), // a test recording is as many seconds as it has bytes
    notify: async (user, v, ok) => { said.push([user, v.name, ok]); },
    provider: async (route, data) => {
      if (route === 'run') { if (worker.failRun) throw new Error('lost'); worker.runs.push(data); return { id: `job-${worker.runs.length}` }; }
      if (route.startsWith('cancel/')) { worker.cancelled.push(route); return {}; }
      return { status: worker.status, output: worker.output, executionTime: 1200000 };
    },
  }, { intervalMs: 3600000 });
  const app = express();
  app.use('/api/kade/sound-booth', made.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/kade/sound-booth`;
  t.after(async () => {
    made.stop();
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
    for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mongo-mem-') && !before.has(n)))
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  });
  const call = async (method, route, { user = OWNER, body, file, name } = {}) => {
    const headers = { 'x-user': user };
    if (file) { headers['content-type'] = 'audio/wav'; headers['x-name'] = name || 'take.wav'; } else if (body) headers['content-type'] = 'application/json';
    const r = await fetch(base + route, { method, headers, body: file || (body ? JSON.stringify(body) : undefined) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  await t.test('an account without Sing it in my voice reaches nothing', async () => {
    for (const [method, route] of [['GET', '/voices'], ['POST', '/voices'], ['GET', '/voices/v0123456789abcde'], ['DELETE', '/voices/v0123456789abcde']])
      assert.equal((await call(method, route, { user: OTHER, body: method === 'POST' ? { name: 'Sneaky', whose: 'mine' } : undefined })).status, 404);
    assert.equal((await call('GET', '/voices', { user: '' })).status, 401);
    process.env.VOICE_LAB_ENABLED = '0';
    assert.equal((await call('GET', '/voices')).status, 404, 'the switch turns the lab off for the owner too');
    delete process.env.VOICE_LAB_ENABLED;
  });

  let mine;
  await t.test('making a voice: a name, whose it is, and permission for anyone else’s', async () => {
    const empty = await call('GET', '/voices');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.voices, []);
    assert.match(empty.data.guide.consent, /permission/);
    assert.match((await call('POST', '/voices', { body: { name: 'x', whose: 'mine' } })).data.error, /2 to 40/);
    assert.match((await call('POST', '/voices', { body: { name: 'Uncle', whose: 'nobody' } })).data.error, /whose voice/);
    assert.match((await call('POST', '/voices', { body: { name: 'Uncle', whose: 'other', person: 'My uncle' } })).data.error, /permission box/);
    assert.match((await call('POST', '/voices', { body: { name: 'Uncle', whose: 'other', consent: 'yes', person: 'My uncle' } })).data.error, /permission box/, 'only a real tick counts');
    assert.match((await call('POST', '/voices', { body: { name: 'Uncle', whose: 'other', consent: true } })).data.error, /whose voice/);
    const uncle = await call('POST', '/voices', { body: { name: 'Uncle', whose: 'other', consent: true, person: 'My uncle' } });
    assert.equal(uncle.status, 201);
    assert.equal(uncle.data.voice.whose, 'other');
    assert.match(uncle.data.voice.id, /^v[0-9a-f]{15}$/);
    const row = await mongoose.models.KadeBoothVoice.findOne({ id: uncle.data.voice.id }).lean();
    assert.equal(row.consent.ticked, true);
    assert.match(row.consent.note, /Permission ticked for My uncle/);
    assert.ok(row.consent.at instanceof Date);
    assert.match((await call('POST', '/voices', { body: { name: 'uncle', whose: 'mine' } })).data.error, /already have a voice with that name/);
    mine = (await call('POST', '/voices', { body: { name: 'My low voice', whose: 'mine' } })).data.voice;
    assert.equal(mine.state, 'collecting');
    assert.equal(mine.canTrain, false);
    assert.ok(!JSON.stringify(uncle.data).includes('voice-samples/'), 'no storage key ever reaches a screen');
  });

  await t.test('recordings: checked, stored in this voice’s own folder, removable', async () => {
    assert.match((await call('POST', `/voices/${mine.id}/samples`, { file: Buffer.alloc(5), name: 'tiny.wav' })).data.error, /could not be read as audio/);
    assert.match((await call('POST', `/voices/${mine.id}/samples`, { file: Buffer.alloc(40), name: 'notes.txt' })).status === 201 ? 'stored by its audio type' : '', /stored/);
    const first = await call('POST', `/voices/${mine.id}/samples`, { file: Buffer.alloc(30), name: 'verse.wav' });
    assert.equal(first.status, 201);
    assert.match(first.data.added, /verse\.wav, 30 seconds/);
    assert.equal(first.data.voice.seconds, 70);
    assert.equal(first.data.voice.canTrain, true, 'seventy seconds is over the one-minute floor');
    for (const key of stored.keys()) assert.match(key, new RegExp(`^voice-samples/${OWNER}/${mine.id}/[a-z0-9]+\\.wav$`));
    assert.equal((await call('POST', `/voices/${mine.id}/samples`, { user: OTHER, file: Buffer.alloc(30) })).status, 404);
    const gone = await call('DELETE', `/voices/${mine.id}/samples/0`);
    assert.equal(gone.data.voice.seconds, 30);
    assert.equal(gone.data.voice.canTrain, false);
    assert.equal(stored.size, 1);
    assert.match((await call('POST', `/voices/${mine.id}/train`, { body: {} })).data.error, /at least one minute/);
    await call('POST', `/voices/${mine.id}/samples`, { file: Buffer.alloc(600), name: 'whole song.wav' });
    const now = (await call('GET', `/voices/${mine.id}`)).data.voice;
    assert.equal(now.seconds, 630);
    assert.match(now.estimate, /^About \d+ cents of GPU time for 10 minutes 30 seconds of recordings, usually \d+ to \d+ minutes\./);
    assert.equal(worker.runs.length, 0, 'nothing paid has happened yet');
  });

  await t.test('learning: one paid request, walked to a ready voice in this voice’s own folder', async () => {
    const started = await call('POST', `/voices/${mine.id}/train`, { body: { isolate: true, denoise: 0.4 } });
    assert.equal(started.status, 200);
    assert.match(started.data.started, /Learning My low voice has started/);
    assert.equal(worker.runs.length, 1);
    const sent = worker.runs[0];
    assert.equal(sent.input.mode, 'train');
    assert.equal(sent.input.owner, OWNER);
    assert.equal(sent.input.voice_id, mine.id);
    assert.equal(sent.input.sample_keys.length, 2);
    assert.ok(sent.input.sample_keys.every((k) => k.startsWith(`voice-samples/${OWNER}/${mine.id}/`)));
    assert.deepEqual(sent.input.options, { epochs: 'auto', isolate: true, denoise: 0.4, dereverb: false });
    assert.equal(sent.policy.executionTimeout, 7200000);
    assert.match((await call('POST', `/voices/${mine.id}/train`, { body: {} })).data.error, /already being learned/);
    assert.match((await call('POST', `/voices/${mine.id}/samples`, { file: Buffer.alloc(30) })).data.error, /being learned right now/);
    assert.match((await call('DELETE', `/voices/${mine.id}`)).data.error, /Stop it first/);
    const second = (await call('POST', '/voices', { body: { name: 'Second', whose: 'mine' } })).data.voice;
    await call('POST', `/voices/${second.id}/samples`, { file: Buffer.alloc(90) });
    assert.match((await call('POST', `/voices/${second.id}/train`, { body: {} })).data.error, /One voice at a time/);
    assert.equal(worker.runs.length, 1);
    worker.status = 'IN_PROGRESS';
    worker.output = 'Learning the voice, epoch 40 of 200';
    assert.match((await call('GET', `/voices/${mine.id}`)).data.voice.status, /epoch 40 of 200/);
    assert.deepEqual(await made.voices(OWNER), [], 'not usable until it is ready');
    /* a worker answer that points outside this voice's folder is refused */
    worker.status = 'COMPLETED';
    worker.output = { model_key: `voice-models/${OWNER}/k3x9q/model.pth` };
    const refused = (await call('GET', `/voices/${mine.id}`)).data.voice;
    assert.equal(refused.state, 'failed');
    assert.match(refused.status, /does not belong to this voice/);
    assert.deepEqual(said.pop(), [OWNER, 'My low voice', false]);
    /* she tries again, and this time it is right */
    worker.output = {
      model_key: `voice-models/${OWNER}/${mine.id}/model.pth`, model_sha256: 'c'.repeat(64),
      index_key: `voice-models/${OWNER}/${mine.id}/model.index`, index_sha256: 'd'.repeat(64),
      range: { p05: 45, p50: 52.5, p95: 61 }, minutes: 10.5, epochs: 200,
    };
    worker.status = 'IN_QUEUE';
    assert.equal((await call('POST', `/voices/${mine.id}/train`, { body: {} })).status, 200);
    assert.equal(worker.runs.length, 2);
    worker.status = 'COMPLETED';
    await made.advance();
    const ready = (await call('GET', `/voices/${mine.id}`)).data.voice;
    assert.equal(ready.state, 'ready');
    assert.match(ready.status, /^Ready\. Choose it under Voice in Sing it in my voice\. Learned from 10 minutes 30 seconds of recordings\./);
    assert.deepEqual(ready.samples, [], 'the recordings are not kept once the voice is learned');
    assert.equal([...stored.keys()].filter((k) => k.includes(mine.id)).length, 0);
    assert.deepEqual(said.pop(), [OWNER, 'My low voice', true]);
    const choices = await made.voices(OWNER);
    assert.equal(choices.length, 1);
    assert.equal(choices[0].name, 'My low voice');
    assert.equal(choices[0].model.model_key, `voice-models/${OWNER}/${mine.id}/model.pth`);
    assert.deepEqual(choices[0].model.range, { p05: 45, p50: 52.5, p95: 61 });
    assert.deepEqual(await made.voices(OTHER), []);
    assert.ok(!JSON.stringify(ready).includes('voice-models/'), 'the model never reaches a screen');
  });

  await t.test('a lost answer is never retried; stop, rename and delete', async () => {
    const list = (await call('GET', '/voices')).data.voices;
    const second = list.find((v) => v.name === 'Second');
    worker.failRun = true;
    const lost = await call('POST', `/voices/${second.id}/train`, { body: {} });
    assert.equal(lost.status, 502);
    assert.match(lost.data.error, /Nothing was retried/);
    assert.equal((await call('GET', `/voices/${second.id}`)).data.voice.state, 'uncertain');
    await made.advance();
    assert.equal(worker.runs.length, 2, 'the timer sends nothing by itself');
    worker.failRun = false;
    worker.status = 'IN_PROGRESS';
    worker.output = undefined;
    assert.equal((await call('POST', `/voices/${second.id}/train`, { body: {} })).status, 200, 'her own second press is her choice');
    const stopped = await call('POST', `/voices/${second.id}/cancel`);
    assert.match(stopped.data.stopped, /GPU time already used is still billed/);
    assert.equal(worker.cancelled.length, 1);
    assert.equal(stopped.data.voice.state, 'cancelled');
    assert.match((await call('PATCH', `/voices/${second.id}`, { body: { name: 'My low voice' } })).data.error, /already have a voice with that name/);
    assert.equal((await call('PATCH', `/voices/${second.id}`, { body: { name: 'Backup (old)' } })).data.voice.name, 'Backup (old)');
    const ready = list.find((v) => v.name === 'My low voice');
    const deleted = await call('DELETE', `/voices/${ready.id}`);
    assert.match(deleted.data.deleted, /My low voice was deleted/);
    assert.ok(removed.includes(`voice-models/${OWNER}/${ready.id}/model.pth`) && removed.includes(`voice-models/${OWNER}/${ready.id}/model.index`));
    assert.deepEqual(await made.voices(OWNER), []);
    assert.equal((await call('GET', `/voices/${ready.id}`)).status, 404);
    const kept = await mongoose.models.KadeBoothVoice.findOne({ id: ready.id }).lean();
    assert.equal(kept.state, 'deleted');
    assert.ok(kept.consent && kept.consent.at, 'the record of whose voice it was stays');
    assert.equal(kept.model_key, undefined);
  });
});
