'use strict';
/* Nov 10 2026: what the booth SENDS to the YuE2 worker (packages/api/src/music/yue.ts: yueWorkerInput and its helpers).
 *
 * The fixes for garbled words with trained styles, covers that drift and a Creative variation dial that only slurred are
 * applied when a request is sent, never when it is saved: the job, the project and Open in the booth keep exactly what was
 * typed and chosen. Each fix has its own switch back, and with every switch set back the request is the one the previous
 * commit sent, key for key.
 *
 * Every line and lyric here is invented for the test. Nothing is sent anywhere.
 *
 * Run: node --test api/server/routes/yueWorkerInput.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const yue = require(path.resolve(__dirname, '../../../packages/api/src/music/yue.ts'));

const COVER = 'https://assets.test/cover.mp3';
const SHEET = '[Verse 1]\nPaper boats along the drain\n(along the drain)\n\n[Pre-Chorus]\nHold the line\n\n[Final Chorus: bigger]\nSing it clear\n[spoken]\nA made-up aside';
const ON = { YUE_COVERS_V2: '1' };
const BACK = { ...ON, YUE_PREFORMAT: '0', YUE_SAMPLING_V2: '0', YUE_STYLE_SOUND_STAGE: 'styled', YUE_COVER_TEMPO_ALWAYS: '0' };
const saved = (body, env = ON) => yue.yueInput({ script: 'Warm soul, female lead vocal', lyrics: SHEET, seed: 11, ...body }, env);
/** What the previous commit sent: the saved input without my_voice, nothing else. */
const before = (input) => { const { my_voice: _myVoice, ...rest } = input; return rest; };

const SHAPES = {
  'a plain new song': {},
  'a styled new song': { band: 'soul', style_strength: 0.7 },
  'a plain cover keeping its chords': { reference_voice_url: COVER },
  'a styled cover with a new accompaniment': { band: 'suno', reference_voice_url: COVER, keep_chords: 'No' },
  'a sung score': { abc: 'X:1\nK:C\nCDEF|', keep_chords: 'Yes' },
  'an instrumental': { singing: 'Instrumental, no singing', lyrics: '[Verse]\n[Chorus]' },
  'a song in her own voice': { my_voice: 'On' },
};

test.beforeEach(() => { process.env.YUE_STYLES_ENABLED = '1'; });
test.after(() => { delete process.env.YUE_STYLES_ENABLED; });

test('with every switch set back, each kind of request is sent exactly as the previous commit sent it', () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const input = saved(body);
    assert.deepEqual(yue.yueWorkerInput(input, BACK), before(input), name);
    assert.equal('my_voice' in yue.yueWorkerInput(input, BACK), false, 'my_voice never reaches the music worker');
  }
});

test('sending never changes what was saved: the job keeps her own tags, style and numbers', () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const input = saved(body);
    const copy = JSON.parse(JSON.stringify(input));
    yue.yueWorkerInput(input, ON);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), copy, name);
  }
  assert.equal(saved({}).lyrics, SHEET, 'yueInput itself still stores the sheet as typed');
});

test('a plain new song: the tags take YuE2\'s own spelling, the v2 sampling map is asked for, and nothing about styles is sent', () => {
  const sent = yue.yueWorkerInput(saved({}), ON);
  assert.equal(sent.lyrics, '[Verse]\nPaper boats along the drain\n(along the drain)\n\n[Pre-Chorus]\nHold the line\n\n[Chorus]\nSing it clear\n[spoken]\nA made-up aside');
  assert.equal(sent.sampling_map, 'v2');
  for (const key of ['lora_sound_stage', 'lora_modules', 'lora_layers', 'lora_key', 'match_score_tempo'])
    assert.equal(sent[key], undefined, key);
  assert.equal(sent.guidance, 1);
  assert.equal(sent.style, 'Warm soul, female lead vocal');
});

test('a styled song: the tags are the lower-case ones the styles were taught on, and the sound stage reads the plain model', () => {
  const sent = yue.yueWorkerInput(saved({ band: 'soul', style_strength: 0.7 }), ON);
  assert.equal(sent.lyrics, '[verse]\nPaper boats along the drain\n(along the drain)\n\n[prechorus]\nHold the line\n\n[chorus]\nSing it clear\n[spoken]\nA made-up aside');
  assert.equal(sent.lora_sound_stage, 'plain');
  assert.equal(sent.lora_key, yue.yueStyles.soul.key);
  assert.equal(sent.lora_scale, 0.7);
  assert.equal(sent.cot, 'off');
  assert.equal(sent.guidance, 1, 'guidance is not raised unless a number is set for it');
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_STYLE_SOUND_STAGE: 'both' }).lora_sound_stage, 'both');
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_STYLE_SOUND_STAGE: 'STYLED' }).lora_sound_stage, undefined);
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_STYLE_SOUND_STAGE: 'nonsense' }).lora_sound_stage, 'plain');
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul', style_strength: 0 }), ON).lora_sound_stage, undefined, 'strength 0 is plain YuE2');
});

test('section tags: every spelling her sheets use lands on one of YuE2\'s seven, and nothing else on the sheet moves', () => {
  const cases = {
    '[Chorus]': 'Chorus', '[Verse]': 'Verse', '[Bridge]': 'Bridge', '[Pre-Chorus]': 'Pre-Chorus', '[Outro]': 'Outro',
    '[Post-Chorus]': 'Chorus', '[Intro]': 'Intro', '[Verse 1]': 'Verse', '[Verse 3]': 'Verse', '[Final Chorus]': 'Chorus',
    '[Prechorus]': 'Pre-Chorus', '[bridge]': 'Bridge', '[postchorus]': 'Chorus', '[pre chorus]': 'Pre-Chorus',
    '[Verse 2: softer]': 'Verse', '[Chorus x2]': 'Chorus', '[Hook]': 'Chorus', '[Refrain]': 'Chorus', '[Interlude]': 'Interlude',
    '[Wah Guitar Solo]': 'Interlude', '[Instrumental Break]': 'Interlude', '[Verse 1 - quiet]': 'Verse', '[CHORUS]': 'Chorus',
    '[Middle 8]': 'Bridge', '[Ending]': 'Outro',
  };
  const lower = { 'Pre-Chorus': 'prechorus' };
  for (const [typed, title] of Object.entries(cases)) {
    assert.equal(yue.yueNativeLyrics(typed), `[${title}]`, typed);
    assert.equal(yue.yueNativeLyrics(typed, true), `[${lower[title] || title.toLowerCase()}]`, typed);
  }
  /* Directions and anything else in brackets are hers: never renamed, never dropped. */
  for (const kept of ['[spoken]', '[belting]', '[drums drop out, atmospheric pads]', '[Boom Bap Drums Enter]', '[Hard Stop]', '[End]',
    '[Half-Time Breakdown]', '[unclear]', '[Pause]', '[Band Drops Out]', '[Chorus] and then some', 'Verse 1', '(Chorus)', '[]',
    '[Verse one]', '[Rap]'])
    for (const trained of [false, true]) assert.equal(yue.yueNativeLyrics(kept, trained), kept, kept);
});

test('section tags: sung words, blank lines, spacing and Windows line ends come through untouched', () => {
  const sheet = '  [Verse 2]  \r\nLine one (echo)\r\n\r\n\r\n[Hook]\r\nLine two\n\n[Outro 1]';
  assert.equal(yue.yueNativeLyrics(sheet), '  [Verse]  \r\nLine one (echo)\r\n\r\n\r\n[Chorus]\r\nLine two\n\n[Outro]');
  const words = (text) => text.split(/\r?\n/).filter((line) => !/^\s*\[[^\]]*\]\s*$/.test(line));
  for (const trained of [false, true]) {
    assert.deepEqual(words(yue.yueNativeLyrics(SHEET, trained)), words(SHEET));
    assert.equal(yue.yueNativeLyrics(SHEET, trained).split('\n').length, SHEET.split('\n').length);
  }
  assert.equal(yue.yueNativeLyrics(''), '');
  assert.equal(yue.yueNativeLyrics(yue.yueNativeLyrics(SHEET, true), true), yue.yueNativeLyrics(SHEET, true), 'doing it twice changes nothing more');
});

test('a style whose lead ends "English," does not say the language twice', () => {
  const style = (script, band) => yue.yueWorkerInput(saved({ band, script }), ON).style;
  assert.equal(style('English slow jam R&B, dreamy', 'suno'), 'kdsuno, in the style of kdsuno. English, slow jam R&B, dreamy');
  assert.equal(style('American-English, contemporary R&B, slow tempo', 'sona'), 'kdsona, in the style of kdsona. English, contemporary R&B, slow tempo');
  assert.equal(style('Englishman in the rain, folk', 'suno'), 'kdsuno, in the style of kdsuno. English, Englishman in the rain, folk');
  assert.equal(style('Spanish bolero, slow', 'suno'), 'kdsuno, in the style of kdsuno. English, Spanish bolero, slow');
  /* Soul and Kids leads end with their genre, so the direction is a new sentence and stays whole. */
  assert.equal(style('English slow jam', 'soul'), `${yue.yueStyles.soul.lead} English slow jam`);
  assert.equal(yue.yueTidyStyle('English, English folk', undefined), 'English, English folk', 'no style, no change');
  assert.equal(yue.yueTidyStyle('English, English folk', 'constructor'), 'English, English folk');
  assert.equal(yue.yueWorkerInput(saved({ script: 'English slow jam' }), ON).style, 'English slow jam', 'plain YuE2 keeps the direction whole');
});

test('Creative variation: the v2 map is asked for unless it is switched back', () => {
  assert.equal(yue.yueWorkerInput(saved({ weirdness: 80 }), ON).sampling_map, 'v2');
  assert.equal(yue.yueWorkerInput(saved({ weirdness: 80 }), ON).weirdness, 80, 'the dial itself is sent as she set it');
  for (const off of ['0', 'false', 'off', 'No'])
    assert.equal(yue.yueWorkerInput(saved({}), { ...ON, YUE_SAMPLING_V2: off }).sampling_map, undefined, off);
  assert.equal(yue.yueSamplingMap({}), 'v2');
  assert.equal(yue.yueSamplingMap({ YUE_SAMPLING_V2: '0' }), 'v1');
});

test('guidance for a styled take: nothing unless a number is set, never over a number she chose, new songs and covers apart', () => {
  const set = { ...ON, YUE_STYLE_GUIDANCE: '1.3', YUE_STYLE_COVER_GUIDANCE: '1.2' };
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), set).guidance, 1.3);
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul', reference_voice_url: COVER }), set).guidance, 1.2);
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul', guidance: 1.6 }), set).guidance, 1.6, 'her own number wins');
  assert.equal(yue.yueWorkerInput(saved({}), set).guidance, 1, 'plain YuE2 is not touched');
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul', reference_voice_url: COVER }), { ...ON, YUE_STYLE_GUIDANCE: '1.3' }).guidance, 1);
  for (const bad of ['', 'high', '0.5', '1', '3.5', '1.234', '-2', '2e1'])
    assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_STYLE_GUIDANCE: bad }).guidance, 1, bad);
});

test('part of the composer for a style: nothing unless set; covers can have their own', () => {
  const scoped = { ...ON, YUE_STYLE_MODULES: 'mlp', YUE_STYLE_LAYERS: '8-27' };
  let sent = yue.yueWorkerInput(saved({ band: 'soul' }), scoped);
  assert.deepEqual([sent.lora_modules, sent.lora_layers], ['mlp', [8, 27]]);
  sent = yue.yueWorkerInput(saved({}), scoped);
  assert.deepEqual([sent.lora_modules, sent.lora_layers], [undefined, undefined], 'no style, no scope');
  const covers = { ...ON, YUE_STYLE_COVER_MODULES: 'ATTN', YUE_STYLE_COVER_LAYERS: ' 0 - 13 ' };
  sent = yue.yueWorkerInput(saved({ band: 'soul', reference_voice_url: COVER }), covers);
  assert.deepEqual([sent.lora_modules, sent.lora_layers], ['attn', [0, 13]]);
  sent = yue.yueWorkerInput(saved({ band: 'soul' }), covers);
  assert.deepEqual([sent.lora_modules, sent.lora_layers], [undefined, undefined], 'a new song does not take the covers\' scope');
  sent = yue.yueWorkerInput(saved({ band: 'soul', reference_voice_url: COVER }), { ...scoped, YUE_STYLE_COVER_MODULES: 'attn' });
  assert.deepEqual([sent.lora_modules, sent.lora_layers], ['attn', [8, 27]], 'the covers\' own value wins where it is set');
  for (const bad of [{ YUE_STYLE_MODULES: 'everything' }, { YUE_STYLE_LAYERS: '9-3' }, { YUE_STYLE_LAYERS: 'top' }, { YUE_STYLE_LAYERS: '0-999' }]) {
    sent = yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, ...bad });
    assert.deepEqual([sent.lora_modules, sent.lora_layers], [undefined, undefined], JSON.stringify(bad));
  }
});

test('a cover with a new accompaniment names its score\'s tempo too, unless she named a BPM', () => {
  const newBacking = { reference_voice_url: COVER, keep_chords: 'No' };
  assert.equal(saved(newBacking).match_score_tempo, undefined, 'the saved request is as before');
  assert.equal(yue.yueWorkerInput(saved(newBacking), ON).match_score_tempo, true);
  assert.equal(yue.yueWorkerInput(saved({ ...newBacking, band: 'soul' }), ON).match_score_tempo, true);
  assert.equal(yue.yueWorkerInput(saved({ ...newBacking, script: 'Warm soul at 92 BPM' }), ON).match_score_tempo, undefined);
  assert.equal(yue.yueWorkerInput(saved(newBacking), { ...ON, YUE_COVER_TEMPO_ALWAYS: '0' }).match_score_tempo, undefined);
  assert.equal(yue.yueWorkerInput(saved({ reference_voice_url: COVER }), ON).match_score_tempo, true, 'chords kept: as before');
  assert.equal(yue.yueWorkerInput(saved({}), ON).match_score_tempo, undefined, 'a new song has no score to match');
  assert.equal(yue.yueWorkerInput(saved({ ...newBacking, singing: 'Instrumental, no singing' }), ON).match_score_tempo, undefined);
  assert.equal(yue.yueWorkerInput(saved(newBacking, {}), {}).match_score_tempo, undefined, 'covers flag off: an old-shape cover is left alone');
});

test('the guide says what the dials do now, and goes back with the switch', () => {
  const settings = [
    { key: 'lyrics', hint: 'words' },
    { key: 'weirdness', hint: '50 is normal. Lower is more predictable; higher is more surprising and can lose its way.' },
    { key: 'guidance', hint: '1 is normal.' },
  ];
  const hint = (env, key) => yue.yueCoverSettings(settings, env).find((s) => s.key === key).hint;
  assert.equal(hint({ YUE_COVERS_V2: '1' }, 'weirdness'), yue.yueVariationHint);
  assert.equal(hint({ YUE_COVERS_V2: '1', YUE_SAMPLING_V2: '0' }, 'weirdness'), settings[1].hint);
  assert.equal(hint({ YUE_COVERS_V2: '1', YUE_STYLES_ENABLED: '1' }, 'guidance'), `1 is normal.${yue.yueGuidanceStyleSentence}`);
  assert.equal(hint({ YUE_COVERS_V2: '1' }, 'guidance'), '1 is normal.');
  assert.deepEqual(yue.yueCoverSettings(settings, {}), settings, 'covers flag off: the guide is untouched');
  for (const text of [yue.yueVariationHint, yue.yueGuidanceStyleSentence]) {
    assert.doesNotMatch(text, /temperature|token|sampling|LoRA|top_p/i, 'plain words only');
    assert.ok(text.length < 240);
  }
});

test('the route sends through yueWorkerInput and nothing else builds the worker request', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/api/src/music/yue.ts'), 'utf8');
  assert.match(source, /submit: \(input\) =>\s+provider\('run', \{ input: yueWorkerInput\(input\), policy:/);
  assert.equal(source.match(/provider\('run'/g).length, 1);
});
