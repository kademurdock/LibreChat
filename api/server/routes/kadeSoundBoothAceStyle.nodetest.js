'use strict';
/* ACE-Step XL, the Style choice (Oct 11 2026): the pure half. No server, no database. The trained styles (Soul, Suno) are
 * LoRAs taught to the Best (xl-sft) decoder; the Style choice is behind ACE_STYLES_ENABLED (off by default) and the Family
 * feature pack. Proven here: the registry, the flag, the hints, that with the flag unset nothing about the card, a request or
 * an answer changes (pinned against the base commit's own output), that Style None adds nothing to the worker request, the
 * styled request for each style (forced Best, lora_key, lora_scale, English), that Soul's request is what it was before Suno
 * was added, every refusal, the project round trip (and a project saved before Suno), the quote, the library line, the asset
 * facts and the take note, the card for a pack member and for everyone else, and the carry between YuE2 and ACE-Step XL,
 * which never moves a style either way (by key, never by name) and says only that one was left behind, never which. The routes and the router are in
 * kadeSoundBoothAceStyle.selftest.js. The lyrics are invented placeholders. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const ts = require('typescript');

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
const carry = require('./kadeSoundBoothCarry');

const SUNG = yue.yueSinging.sung;
const INSTRUMENTAL = yue.yueSinging.instrumental;
const ON = { ACE_STYLES_ENABLED: '1' };
const LYRICS = '[Verse]\nWalking home\n[Chorus]\nHold on';
const base = { script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 7 };
const PERSON_OR_FOLDER = /Kade|Holly|your own folders|sonauto|AudioCaptures|MUSIC GROUP|model training music|Desktop|iCloud|kdsoulr|kdsuno/i;
const STYLES = ['soul', 'suno'];
const LABEL = { soul: 'Soul', suno: 'Suno' };
const KEY = { soul: 'ace-loras/soul-real-v1', suno: 'ace-loras/suno-v1' };
const refusal = (body, message, env = ON) => assert.throws(() => ace.aceInput(body, env), { message }, JSON.stringify(body));
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = (body, env = ON) => ace.aceRequest(ace.aceInput(body, env));

/* YuE2's own sentences for the same three refusals, read from YuE2's code so the two cards can never drift apart. */
function yueSays(body, env = {}) {
  const saved = process.env.YUE_STYLES_ENABLED;
  process.env.YUE_STYLES_ENABLED = '1';
  try {
    yue.yueInput({ script: 'Slow soul, female lead vocal', lyrics: 'la la', ...body }, env);
  } catch (error) {
    return error.message;
  } finally {
    if (saved === undefined) delete process.env.YUE_STYLES_ENABLED;
    else process.env.YUE_STYLES_ENABLED = saved;
  }
  return 'accepted';
}

/* What the previous commit (969369b, before styles) built for these bodies, as the exact JSON it sent. */
const BEFORE_THE_STYLES = [
  [{ script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 7 },
    '{"model":"xl-turbo","caption":"Slow soul, Rhodes","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","duration":30,"seed":7,"batch_size":1,"bpm":88}'],
  [{ script: 'Bright synth pop', lyrics: '[Verse]\nla la\nla la', seed: 0, quality: 'Fast', length: '2:00' },
    '{"model":"xl-turbo","caption":"Bright synth pop","lyrics":"[Verse]\\nla la\\nla la","duration":120,"seed":0,"batch_size":1}'],
  [{ script: 'Warm folk song, fingerpicked guitar', lyrics: '[Verse]\nla la\nla la', seed: 12345, quality: 'Best', length: '3:00' },
    '{"model":"xl-sft","caption":"Warm folk song, fingerpicked guitar","lyrics":"[Verse]\\nla la\\nla la","duration":180,"seed":12345,"batch_size":1}'],
  [{ script: 'Funk, around 96 BPM, horns', lyrics: '[Chorus]\nla la', seed: 2147483647, quality: 'Best', length: '6:00' },
    '{"model":"xl-sft","caption":"Funk, horns","lyrics":"[Chorus]\\nla la","duration":360,"seed":2147483647,"batch_size":1,"bpm":96}'],
  [{ script: 'Banjo breakdown, 120 BPM', singing: INSTRUMENTAL, lyrics: 'ignored words', seed: 1 },
    '{"model":"xl-turbo","caption":"Banjo breakdown","lyrics":"[Instrumental]","duration":120,"seed":1,"batch_size":1,"bpm":120}'],
  [{ script: 'Slow jazz trio', singing: INSTRUMENTAL, seed: 99, quality: 'Best', length: '4:00' },
    '{"model":"xl-sft","caption":"Slow jazz trio","lyrics":"[Instrumental]","duration":240,"seed":99,"batch_size":1}'],
  [{ script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 5, quality: 'Best', length: '3:00', weirdness: 70, guidance: 2 },
    '{"model":"xl-sft","caption":"Slow soul, Rhodes","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","duration":180,"seed":5,"batch_size":1,"bpm":88,"lm_temperature":1.03,"guidance_scale":10}'],
  [{ script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 6, weirdness: 20, guidance: 3 },
    '{"model":"xl-turbo","caption":"Slow soul, Rhodes","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","duration":30,"seed":6,"batch_size":1,"bpm":88,"lm_temperature":0.58}'],
];
/* sha-256 of JSON.stringify(aceGuide(env)) at the previous commit, computed from that commit's code. */
const GUIDE_BEFORE = '7199f29ab206a6964ee6db5b06407d526d9de552d2db92abff0486b407aae293';
const GUIDE_BEFORE_SFT_240 = 'e9f65e35ef92b1601d39d5bae6d49989d3422b9e830551f181e042f9d36ca6cf';

/* ---------- the registry, the flag, the words ---------- */

test('the registry has two styles, Soul and Suno, with the key and scale the worker is told', () => {
  assert.deepEqual(ace.aceStyles, { soul: { key: 'ace-loras/soul-real-v1', scale: 1 }, suno: { key: 'ace-loras/suno-v1', scale: 1 } });
  for (const [name, row] of Object.entries(ace.aceStyles)) {
    assert.match(row.key, /^ace-loras\/[A-Za-z0-9._-]{1,60}$/, `${name}: the worker's strict key pattern`);
    assert.ok(!row.key.includes('..'), `${name}: no parent folder`);
    assert.ok(row.scale >= 0 && row.scale <= 1.5, `${name}: the worker takes 0.0 to 1.5`);
    assert.deepEqual(Object.keys(row).sort(), ['key', 'scale'], `${name}: a row is a key and a scale, nothing else the booth could trip on`);
  }
  assert.deepEqual(Object.keys(ace.aceStyles), STYLES, 'not YuE2\'s menu: no Kids');
  assert.equal(new Set(Object.values(ace.aceStyles).map((row) => row.key)).size, STYLES.length, 'two styles, two different adapters');
  const yueKeys = Object.values(yue.yueStyles).map((row) => row.key);
  for (const row of Object.values(ace.aceStyles)) assert.ok(!yueKeys.includes(row.key), 'a different adapter from every YuE2 style');
  /* YuE2 has a style named soul too. The name is the same and the adapter is not, which is why nothing in the booth may
   * treat a matching name as a matching style. */
  assert.ok(Object.keys(yue.yueStyles).includes('soul') && STYLES.includes('soul'));
  assert.notEqual(yue.yueStyles.soul.key, ace.aceStyles.soul.key);
  /* The worker's own limits on a styled request, for every row. */
  for (const name of STYLES) {
    const sent = request({ ...base, band: name });
    assert.equal(sent.lora_key, KEY[name], name);
    assert.equal(sent.lora_scale, ace.aceStyles[name].scale, name);
  }
});

test('ACE_STYLES_ENABLED is off unless it is exactly 1', () => {
  assert.equal(ace.aceStylesEnabled({}), false);
  assert.equal(ace.aceStylesEnabled(ON), true);
  for (const said of ['0', 'true', 'yes', 'on', '', ' 1', '1 ', 'ON', 'false']) assert.equal(ace.aceStylesEnabled({ ACE_STYLES_ENABLED: said }), false, JSON.stringify(said));
  assert.equal(ace.aceStylesEnabled({ ACE_ENABLED: '1' }), false, 'turning ACE on does not turn styles on');
});

test('the hints are short, plain, true, and name no person, folder or trigger word', () => {
  assert.equal(ace.aceStyleHint, 'A singing style taught to ACE-Step XL: Soul from soul and R&B records, Suno from songs made with Suno. Uses the Best quality. None is plain ACE-Step XL.');
  assert.ok(ace.aceStyleHint.split(/\s+/).length <= 30, 'about one sentence, as the booth asks');
  assert.ok(ace.aceStyleHint.length < 165, 'shorter than the first Suno wording (165 characters)');
  assert.ok(ace.aceStyleHint.endsWith(' Uses the Best quality. None is plain ACE-Step XL.'), 'the part that was always there is still there');
  /* The hint says every style the registry has, so a style added to the registry cannot be left out of what the card tells people. */
  for (const name of Object.keys(ace.aceStyles)) assert.match(ace.aceStyleHint, new RegExp(`\\b${LABEL[name] || name}\\b`), `${name} is in the hint`);
  assert.match(ace.aceStyleHint, /Suno from songs made with Suno/);
  assert.equal(ace.aceStyleLockedSentence, ' Part of the Family feature pack, so songs on this account use None, plain ACE-Step XL.');
  assert.ok(ace.aceStyleLockedSentence.includes(pack.FAMILY_PACK_NOTE), 'a client that does not read locked still sees why');
  /* The refusal is YuE2's, word for word: the same pack, the same feature. */
  assert.equal(pack.FAMILY_PACK_STYLES_REFUSAL, 'Trained styles are part of the Family feature pack, and this account does not have it. Set Style to None, then make the music again.');
  const everyHint = ace.aceGuide(ON, true).settings.map((s) => s.hint).concat(ace.aceGuide(ON, false).settings.map((s) => s.hint));
  for (const words of [ace.aceStyleHint, ace.aceStyleLockedSentence, pack.FAMILY_PACK_STYLES_REFUSAL, ...everyHint]) assert.doesNotMatch(words, PERSON_OR_FOLDER, words);
});

/* ---------- with the flag unset, nothing is different ---------- */

test('flag unset: the card is byte for byte the previous commit\'s, whoever asks', () => {
  assert.equal(sha(ace.aceGuide({})), GUIDE_BEFORE);
  assert.equal(sha(ace.aceGuide({ ACE_DEFAULT_MODEL: 'xl-sft', ACE_MAX_SECONDS: '240' })), GUIDE_BEFORE_SFT_240);
  for (const env of [{}, { ACE_STYLES_ENABLED: '0' }, { ACE_STYLES_ENABLED: 'true' }, { ACE_STYLES_ENABLED: '' }, { ACE_ENABLED: '1' }])
    for (const member of [true, false]) assert.equal(sha(ace.aceGuide(env, member)), GUIDE_BEFORE, `${JSON.stringify(env)} member=${member}`);
  assert.deepEqual(ace.aceGuide({}).settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'length', 'weirdness', 'guidance', 'seed']);
  const shell = { engines: { yue2: { name: 'YuE2' } } };
  assert.equal(ace.withAceGuide(shell, { role: 'ADMIN' }, {}), shell, 'ACE off: the very same object');
  assert.equal(ace.withAceGuide(shell, { role: 'USER' }, { ACE_ENABLED: '1' }), shell, 'admin-only: the very same object for everyone else');
  for (const member of [true, false]) assert.equal(sha(ace.withAceGuide(shell, { role: 'ADMIN' }, { ACE_ENABLED: '1' }, member).engines.ace), GUIDE_BEFORE);
});

test('flag unset: a Style on the request is ignored, as every field ACE does not have always was', () => {
  const plain = ace.aceInput(base, {});
  for (const extra of [{ band: 'soul' }, { band: 'suno' }, { band: 'kids' }, { band: 'soul', style_strength: 0.3 }, { band: 'suno', style_strength: 0.3 }, { band: 'nonsense' }, { band: ['soul'] }, { band: ['suno'] }, { style_strength: 5 }, { style_strength: 'x' }, { band: 'soul', quality: 'Fast', singing: false }, { band: 'suno', quality: 'Fast', singing: false }, { lora_key: 'ace-loras/suno-v1', lora_scale: 1, vocal_language: 'en' }]) {
    assert.deepEqual(ace.aceInput({ ...base, ...extra }, {}), plain, JSON.stringify(extra));
    assert.deepEqual(ace.aceInput({ ...base, ...extra }, { ACE_STYLES_ENABLED: '0' }), plain, JSON.stringify(extra));
  }
  const instrumental = ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 1 }, {});
  for (const name of STYLES)
    assert.deepEqual(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 1, band: name }, {}), instrumental, `${name}: an instrumental with a Style is not refused while styles are off`);
  for (const [body, before] of BEFORE_THE_STYLES) {
    for (const name of STYLES) assert.equal(JSON.stringify(request({ ...body, band: name, style_strength: 0.4 }, {})), before, `${name} ${JSON.stringify(body)}`);
    assert.equal(JSON.stringify(request(body, {})), before, JSON.stringify(body));
  }
  for (const name of STYLES) {
    assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: name }, {})), ace.aceEstimate(plain));
    assert.deepEqual(ace.aceProjectOptions(ace.aceInput({ ...base, band: name, style_strength: 0.3 }, {})), ace.aceProjectOptions(plain), `${name}: nothing about a Style is saved`);
  }
  /* The answer to a take is read as it always was, whatever style a worker names, because the job has no adapter. */
  for (const name of STYLES) {
    const input = ace.aceInput({ ...base, band: name }, {});
    const answer = { url: 'x', gpu: 'g', model: 'xl-turbo', style: { key: KEY[name], name: LABEL[name], scale: 1 } };
    assert.deepEqual(ace.aceTakeFacts(answer, input), ace.aceTakeFacts(answer, plain), name);
    assert.equal(ace.aceTakeNote(answer, input), '');
  }
});

test('flag on, Style None in any spelling: the worker request, the quote and the project are the previous commit\'s', () => {
  for (const [body, before] of BEFORE_THE_STYLES)
    for (const none of [{}, { band: 'none' }, { band: '' }, { band: null }, { band: undefined }]) {
      const input = ace.aceInput({ ...body, ...none }, ON);
      assert.equal(JSON.stringify(ace.aceRequest(input)), before, `${JSON.stringify(body)} ${JSON.stringify(none)}`);
      for (const key of ['band', 'style_strength', 'lora_key', 'lora_scale']) assert.equal(key in input, false, `${key} is not on the job`);
      assert.equal(ace.aceEstimate(input), ace.aceEstimate(ace.aceInput(body, {})));
      assert.deepEqual(ace.aceProjectOptions(input), ace.aceProjectOptions(ace.aceInput(body, {})));
      assert.equal(ace.aceProjectWhy(ace.aceProjectOptions(input)), ace.aceProjectWhy(ace.aceProjectOptions(ace.aceInput(body, {}))));
    }
  /* A strength she moved with no Style chosen is remembered (as at YuE2) and changes nothing that is sent. */
  const loose = ace.aceInput({ ...base, style_strength: 0.4 }, ON);
  assert.equal(loose.style_strength, 0.4);
  assert.equal(JSON.stringify(ace.aceRequest(loose)), BEFORE_THE_STYLES[0][1]);
  assert.deepEqual(ace.aceProjectOptions(loose), { ...ace.aceProjectOptions(ace.aceInput(base, {})), style_strength: 0.4 });
  const stored = JSON.parse(JSON.stringify(ace.aceInput(base, {})));
  assert.equal(JSON.stringify(ace.aceRequest(stored)), BEFORE_THE_STYLES[0][1], 'a job saved before styles existed is still that request');
  assert.equal(ace.aceTakeNote({ url: 'x', gpu: 'g' }, ace.aceInput(base, ON)), '', 'a plain take has no style note');
  assert.equal('takeNote' in ace.aceTakeFacts({ url: 'x' }, ace.aceInput(base, ON)), false);
});

/* ---------- the styled request ---------- */

test('a Soul song: forced Best, the adapter, its strength, English, and the caption exactly as typed', () => {
  const input = ace.aceInput({ ...base, band: 'soul' }, ON);
  assert.equal(input.model, 'xl-sft');
  assert.equal(input.band, 'soul');
  assert.equal(input.lora_key, 'ace-loras/soul-real-v1');
  assert.equal(input.lora_scale, 1);
  assert.equal('style_strength' in input, false, 'only what she sent is remembered');
  assert.equal(input.style, base.script, 'her words are not tagged or edited in the project');
  const asked = ace.aceRequest(input);
  assert.deepEqual(asked, {
    model: 'xl-sft', caption: 'Slow soul, Rhodes', lyrics: LYRICS, duration: 30, seed: 7, batch_size: 1, bpm: 88,
    lora_key: 'ace-loras/soul-real-v1', lora_scale: 1, vocal_language: 'en',
  });
  assert.deepEqual(Object.keys(asked), ['model', 'caption', 'lyrics', 'duration', 'seed', 'batch_size', 'bpm', 'lora_key', 'lora_scale', 'vocal_language']);
  assert.doesNotMatch(JSON.stringify(asked), /kdsoulr|kd[a-z0-9]+, /, 'the worker owns the trigger word: the booth never writes one');
  /* The caption is the plain one: the planner reads it as typed, and the worker tags it for the decoder. */
  assert.equal(asked.caption, ace.aceRequest(ace.aceInput({ ...base, band: 'none' }, ON)).caption);
  /* The worker's own rules for the three fields, as the booth meets them. */
  for (const strength of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1]) {
    const sent = request({ ...base, band: 'soul', style_strength: strength });
    assert.match(sent.lora_key, /^ace-loras\/[A-Za-z0-9._-]{1,60}$/);
    assert.equal(typeof sent.lora_scale, 'number');
    assert.ok(sent.lora_scale >= 0 && sent.lora_scale <= 1.5);
    assert.equal(sent.lora_scale, strength, `${strength}: no floating-point tail`);
    assert.equal(sent.model, 'xl-sft');
    assert.equal(sent.vocal_language, 'en');
  }
  assert.deepEqual(ace.aceRequest(JSON.parse(JSON.stringify(input))), asked, 'a request rebuilt from the stored job is the same');
});

/* What the base commit (a433eeb, Soul the only style) built for a Soul request, as the exact JSON, the quote, the saved options
 * and the library line, computed from that commit's code. Adding Suno must not move a word of any of it. */
const SOUL_BEFORE_SUNO = [
  [{ script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 7, band: 'soul' },
    '{"model":"xl-sft","caption":"Slow soul, Rhodes","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","duration":30,"seed":7,"batch_size":1,"bpm":88,"lora_key":"ace-loras/soul-real-v1","lora_scale":1,"vocal_language":"en"}',
    'About 30 seconds of music in the Soul style, which always uses best quality.',
    '{"quality":"Best","length":"Match my lyrics","singing":"Sung, with my lyrics","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","weirdness":50,"guidance":1,"seed":7,"band":"soul"}'],
  [{ script: 'Slow soul, 88 BPM, Rhodes', lyrics: LYRICS, seed: 7, band: 'soul', style_strength: 0.5 },
    '{"model":"xl-sft","caption":"Slow soul, Rhodes","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","duration":30,"seed":7,"batch_size":1,"bpm":88,"lora_key":"ace-loras/soul-real-v1","lora_scale":0.5,"vocal_language":"en"}',
    'About 30 seconds of music in the Soul style, which always uses best quality.',
    '{"quality":"Best","length":"Match my lyrics","singing":"Sung, with my lyrics","lyrics":"[Verse]\\nWalking home\\n[Chorus]\\nHold on","weirdness":50,"guidance":1,"seed":7,"band":"soul","style_strength":0.5}'],
  [{ script: 'Warm folk song, fingerpicked guitar', lyrics: '[Verse]\nla la\nla la', seed: 12345, band: 'soul', quality: 'Best', length: '3:00', weirdness: 70, guidance: 2 },
    '{"model":"xl-sft","caption":"Warm folk song, fingerpicked guitar","lyrics":"[Verse]\\nla la\\nla la","duration":180,"seed":12345,"batch_size":1,"lm_temperature":1.03,"guidance_scale":10,"lora_key":"ace-loras/soul-real-v1","lora_scale":1,"vocal_language":"en"}',
    'About 3 minutes of music in the Soul style, which always uses best quality.',
    '{"quality":"Best","length":"3:00","singing":"Sung, with my lyrics","lyrics":"[Verse]\\nla la\\nla la","weirdness":70,"guidance":2,"seed":12345,"band":"soul"}'],
  [{ script: 'Funk, around 96 BPM, horns', lyrics: '[Chorus]\nla la', seed: 2147483647, band: 'soul', quality: 'Fast', length: '6:00', style_strength: 0.3 },
    '{"model":"xl-sft","caption":"Funk, horns","lyrics":"[Chorus]\\nla la","duration":360,"seed":2147483647,"batch_size":1,"bpm":96,"lora_key":"ace-loras/soul-real-v1","lora_scale":0.3,"vocal_language":"en"}',
    'About 6 minutes of music in the Soul style, which always uses best quality.',
    '{"quality":"Best","length":"6:00","singing":"Sung, with my lyrics","lyrics":"[Chorus]\\nla la","weirdness":50,"guidance":1,"seed":2147483647,"band":"soul","style_strength":0.3}'],
];

test('Soul is the request, quote, project and library line it was before Suno was added', () => {
  for (const [body, sent, quote, options] of SOUL_BEFORE_SUNO) {
    const input = ace.aceInput(body, ON);
    assert.equal(JSON.stringify(ace.aceRequest(input)), sent, JSON.stringify(body));
    assert.equal(ace.aceEstimate(input), `${quote} ${ace.aceCost}`, JSON.stringify(body));
    assert.equal(JSON.stringify(ace.aceProjectOptions(input)), options, JSON.stringify(body));
    assert.equal(ace.aceProjectWhy(ace.aceProjectOptions(input)), 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
  }
});

test('a Suno song: forced Best, the adapter, its strength, English, and the caption exactly as typed', () => {
  const input = ace.aceInput({ ...base, band: 'suno' }, ON);
  assert.equal(input.model, 'xl-sft');
  assert.equal(input.band, 'suno');
  assert.equal(input.lora_key, 'ace-loras/suno-v1');
  assert.equal(input.lora_scale, 1);
  assert.equal('style_strength' in input, false, 'only what she sent is remembered');
  assert.equal(input.style, base.script, 'her words are not tagged or edited in the project');
  const asked = ace.aceRequest(input);
  assert.deepEqual(asked, {
    model: 'xl-sft', caption: 'Slow soul, Rhodes', lyrics: LYRICS, duration: 30, seed: 7, batch_size: 1, bpm: 88,
    lora_key: 'ace-loras/suno-v1', lora_scale: 1, vocal_language: 'en',
  });
  assert.deepEqual(Object.keys(asked), ['model', 'caption', 'lyrics', 'duration', 'seed', 'batch_size', 'bpm', 'lora_key', 'lora_scale', 'vocal_language']);
  assert.doesNotMatch(JSON.stringify(asked), /kdsuno|kdsoulr|kd[a-z0-9]+, /, 'the worker owns the trigger word: the booth never writes one');
  assert.equal(asked.caption, ace.aceRequest(ace.aceInput({ ...base, band: 'none' }, ON)).caption, 'the caption is the plain one');
  /* The scale is the strength times the registry's 1, with no floating-point tail, and every field is in the worker's range. */
  for (const strength of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1]) {
    const sent = request({ ...base, band: 'suno', style_strength: strength });
    assert.equal(sent.lora_key, 'ace-loras/suno-v1');
    assert.match(sent.lora_key, /^ace-loras\/[A-Za-z0-9._-]{1,60}$/);
    assert.equal(sent.lora_scale, strength * 1, `${strength}: strength x 1`);
    assert.equal(sent.lora_scale, strength, `${strength}: no floating-point tail`);
    assert.ok(sent.lora_scale >= 0 && sent.lora_scale <= 1.5);
    assert.equal(sent.model, 'xl-sft');
    assert.equal(sent.vocal_language, 'en');
  }
  assert.deepEqual(ace.aceRequest(JSON.parse(JSON.stringify(input))), asked, 'a request rebuilt from the stored job is the same');
  /* Quality said Fast, or nothing: a style is Best all the same. */
  for (const quality of [undefined, 'Fast', 'Best']) assert.equal(request({ ...base, band: 'suno', ...(quality ? { quality } : {}) }).model, 'xl-sft', String(quality));
});

test('Suno is Soul with a different adapter and a different name, and nothing else', () => {
  const swap = (text) => String(text).replace(/\bSoul\b/g, 'Suno').replace(/ace-loras\/soul-real-v1/g, 'ace-loras/suno-v1');
  const bodies = [
    ...SOUL_BEFORE_SUNO.map(([body]) => body),
    { ...base, band: 'soul', quality: 'Best', length: '3:00', weirdness: 20, guidance: 3, style_strength: 0.65 },
    { ...base, band: 'soul', style_strength: 0 },
    { ...base, band: 'soul', style_strength: 0.00004 },
    { ...base, band: 'soul', style_strength: 0.0001 },
    { ...base, band: 'soul', style_strength: 0.123456 },
    { script: 'Bright synth pop', lyrics: '[Verse]\nla la\nla la', seed: 0, band: 'soul', length: '2:00', title: 'A title' },
    { ...base, band: 'soul', script: `Soul ${'warm '.repeat(150)}` },
  ];
  const outcome = (body) => {
    try {
      const input = ace.aceInput(body, ON);
      return { input, request: ace.aceRequest(input), estimate: ace.aceEstimate(input), options: ace.aceProjectOptions(input) };
    } catch (error) {
      return { error: error.message };
    }
  };
  for (const body of bodies) {
    const soul = outcome(body);
    const suno = outcome({ ...body, band: 'suno' });
    assert.ok(!soul.error && !suno.error, JSON.stringify(body));
    const { band: soulBand, lora_key: soulKey, ...soulInput } = soul.input;
    const { band: sunoBand, lora_key: sunoKey, ...sunoInput } = suno.input;
    assert.deepEqual(sunoInput, soulInput, `${JSON.stringify(body)}: the same job but for the adapter`);
    assert.deepEqual([soulBand, sunoBand], ['soul', 'suno']);
    assert.deepEqual([soulKey, sunoKey], soulKey === undefined ? [undefined, undefined] : [KEY.soul, KEY.suno]);
    const { lora_key: a, ...soulRequest } = soul.request;
    const { lora_key: b, ...sunoRequest } = suno.request;
    assert.equal(JSON.stringify(sunoRequest), JSON.stringify(soulRequest), 'the same worker request but for the adapter, field for field and in order');
    assert.deepEqual([a, b], a === undefined ? [undefined, undefined] : [KEY.soul, KEY.suno]);
    assert.equal(suno.estimate, swap(soul.estimate), 'the quote names the style, and says nothing else different');
    assert.equal(JSON.stringify(suno.options).replace('"suno"', '"soul"'), JSON.stringify(soul.options));
    assert.equal(ace.aceProjectWhy(suno.options).replace('Suno', 'Soul'), ace.aceProjectWhy(soul.options));
  }
  /* A refusal is the same refusal for both. */
  for (const body of [{ ...base, band: 'soul', style_strength: 2 }, { script: 'Banjo', singing: INSTRUMENTAL, seed: 1, band: 'soul' }, { ...base, band: 'soul', quality: 'Great' }]) {
    assert.equal(outcome({ ...body, band: 'suno' }).error, outcome(body).error, JSON.stringify(body));
    assert.ok(outcome(body).error);
  }
});

test('the adapter is only ever the registry\'s: a request cannot name its own lora_key, scale, language or model', () => {
  const sneaky = { lora_key: 'ace-loras/someone-elses-v1', lora_scale: 1.5, vocal_language: 'fr', model: 'xl-turbo', lora: 'x' };
  const mine = { lora_key: KEY.suno, lora_scale: 0.2, vocal_language: 'en', model: 'xl-turbo' };
  for (const env of [{}, ON]) {
    const plain = request(base, env);
    for (const said of [sneaky, mine]) {
      assert.deepEqual(request({ ...base, ...said }, env), plain, `plain request, ${JSON.stringify(env)}`);
      assert.equal(JSON.stringify(request({ ...base, ...said, band: 'none' }, env)), JSON.stringify(plain));
    }
  }
  for (const name of STYLES) {
    const styled = request({ ...base, band: name });
    for (const said of [sneaky, mine]) assert.deepEqual(request({ ...base, ...said, band: name }), styled, `${name}: a styled request still takes the registry's key, scale and English`);
    assert.equal(styled.lora_key, KEY[name]);
    assert.equal(styled.lora_scale, 1);
    assert.equal(styled.vocal_language, 'en');
    assert.equal(styled.model, 'xl-sft');
  }
  /* Suno's adapter is reached by naming Suno, never by naming Soul's key or the other way round. */
  assert.notEqual(request({ ...base, band: 'soul', lora_key: KEY.suno }).lora_key, KEY.suno);
  assert.notEqual(request({ ...base, band: 'suno', lora_key: KEY.soul }).lora_key, KEY.soul);
});

test('a Style forces Best whatever Quality said, and the dials still work on it', () => {
  for (const name of STYLES) {
    for (const quality of [undefined, 'Fast', 'Best', 'fast']) {
      const sent = request({ ...base, band: name, ...(quality === undefined ? {} : { quality }) });
      assert.equal(sent.model, 'xl-sft', `${name} ${String(quality)}`);
    }
    for (const env of [{ ...ON, ACE_DEFAULT_MODEL: 'xl-turbo' }, { ...ON, ACE_DEFAULT_MODEL: 'xl-sft' }])
      assert.equal(request({ ...base, band: name }, env).model, 'xl-sft');
    assert.equal(ace.aceProjectOptions(ace.aceInput({ ...base, band: name, quality: 'Fast' }, ON)).quality, 'Best', 'the project says what was really made');
    /* Prompt guidance reaches a styled take even when Quality said Fast, since the take is Best. */
    const guided = request({ ...base, band: name, quality: 'Fast', guidance: 2, weirdness: 70 });
    assert.deepEqual(Object.keys(guided), ['model', 'caption', 'lyrics', 'duration', 'seed', 'batch_size', 'bpm', 'lm_temperature', 'guidance_scale', 'lora_key', 'lora_scale', 'vocal_language']);
    assert.equal(guided.guidance_scale, 10);
    assert.equal(guided.lm_temperature, 1.03);
    assert.doesNotMatch(ace.aceEstimate(ace.aceInput({ ...base, band: name, guidance: 2 }, ON)), /Prompt guidance only works/);
    /* A job that says it has an adapter is Best even if the job itself forgot to say so. */
    const odd = { ...ace.aceInput({ ...base, band: name }, ON), model: 'xl-turbo' };
    assert.equal(ace.aceRequest(odd).model, 'xl-sft');
    assert.equal(ace.aceProjectOptions(odd).quality, 'Best');
    assert.match(ace.aceEstimate(odd), /best quality/);
  }
});

test('Style strength: scaled by the registry, 0 is a plain take, and the registry\'s scale is respected', () => {
  for (const name of STYLES) {
    const full = request({ ...base, band: name, style_strength: 1 });
    assert.equal(full.lora_scale, 1);
    const half = request({ ...base, band: name, style_strength: 0.5 });
    assert.equal(half.lora_scale, 0.5);
    /* Strength 0 is the same request as Style None: no adapter, no Best, no English. */
    const zero = ace.aceInput({ ...base, band: name, style_strength: 0 }, ON);
    assert.equal(JSON.stringify(ace.aceRequest(zero)), BEFORE_THE_STYLES[0][1], name);
    assert.equal(zero.model, 'xl-turbo', 'Fast stays Fast');
    assert.equal(request({ ...base, band: name, style_strength: 0, quality: 'Best' }).model, 'xl-sft');
    assert.deepEqual([zero.band, zero.style_strength, 'lora_key' in zero], [name, 0, false], 'but it remembers what she set');
    assert.equal(ace.aceTakeNote({ url: 'x' }, zero), '', 'a plain take has no style note');
    /* A strength so small that the scale sent would round to 0 is the same plain take: the worker reads a scale of 0 as plain, so
     * sending it as Best with an adapter would charge Best for nothing and then report that the style was not confirmed. */
    for (const tiny of [0.00001, 0.00004, 0.000049, Number.MIN_VALUE]) {
      const input = ace.aceInput({ ...base, band: name, style_strength: tiny }, ON);
      assert.equal(JSON.stringify(ace.aceRequest(input)), BEFORE_THE_STYLES[0][1], `${name} ${tiny}`);
      assert.equal(input.model, 'xl-turbo', `${tiny}: Fast stays Fast`);
      for (const key of ['lora_key', 'lora_scale']) assert.equal(key in input, false, `${tiny}: ${key}`);
      assert.deepEqual([input.band, input.style_strength], [name, tiny], 'but it remembers what she set');
      assert.equal(ace.aceTakeNote({ url: 'x' }, input), '', 'a plain take has no style note');
      assert.equal(ace.aceEstimate(input), `About 30 seconds of music, fast quality. Style strength is too low, so the ${LABEL[name]} style is not used. ${ace.aceCost}`);
      assert.equal(request({ ...base, band: name, style_strength: tiny, quality: 'Best' }).model, 'xl-sft', 'Best only when she asked for it');
      assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, band: name, style_strength: tiny, seed: 1 }, ON).instrumental, true, 'no style, so an instrumental is not refused');
      assert.equal(ace.aceProjectWhy(ace.aceProjectOptions(input)), 'ACE-Step XL — a song made on the sleeping music GPU', 'the library line does not claim a style');
    }
    /* The smallest strength that still counts is sent, as the worker takes it. */
    for (const [strength, scale] of [[0.00005, 0.0001], [0.0001, 0.0001], [0.0004, 0.0004]]) {
      const sent = request({ ...base, band: name, style_strength: strength });
      assert.equal(sent.lora_scale, scale, String(strength));
      assert.equal(sent.model, 'xl-sft');
      assert.equal(sent.vocal_language, 'en');
    }
  }
  /* A registry row with another scale multiplies and rounds, for each row on its own. */
  for (const name of STYLES) {
    const row = ace.aceStyles[name];
    const saved = row.scale;
    try {
      row.scale = 0.7;
      assert.equal(request({ ...base, band: name, style_strength: 0.3 }).lora_scale, 0.21);
      for (const [strength, scale] of [[0.1, 0.07], [0.2, 0.14], [0.4, 0.28], [0.7, 0.49], [0.8, 0.56]])
        assert.equal(request({ ...base, band: name, style_strength: strength }).lora_scale, scale, `0.7 x ${strength} has no floating-point tail (0.7 x ${strength} is ${0.7 * strength} unrounded)`);
      assert.equal(request({ ...base, band: name }).lora_scale, 0.7);
      row.scale = 1.5;
      assert.equal(request({ ...base, band: name }).lora_scale, 1.5);
      /* Only the row that was changed: the other style's scale is its own. */
      const other = STYLES.find((candidate) => candidate !== name);
      assert.equal(request({ ...base, band: other }).lora_scale, 1, `${other} is untouched by ${name}'s row`);
    } finally {
      row.scale = saved;
    }
  }
});

test('every refusal is one plain sentence, in YuE2\'s words where YuE2 has the same one', () => {
  const UNAVAILABLE = 'That trained style is not available. Choose None or another style.';
  const STRENGTH = 'Style strength must be from 0 to 1.';
  const SINGING = 'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.';
  assert.equal(yueSays({ band: 'nonsense' }), UNAVAILABLE, 'YuE2 says the same');
  assert.equal(yueSays({ band: 'soul', style_strength: 2 }), STRENGTH, 'YuE2 says the same');
  assert.equal(yueSays({ band: 'soul', singing: INSTRUMENTAL, lyrics: '' }, { YUE_COVERS_V2: '1' }), SINGING, 'YuE2 says the same');
  /* YuE2's Kids is not an ACE-Step XL style, and a name that is nearly one is not one either: the registry is read by exact name. */
  for (const band of ['kids', 'Soul', 'SOUL', ' soul', 'soul ', 'Suno', 'SUNO', ' suno', 'suno ', 'soul,suno', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 5, true, ['soul'], ['suno'], {}, 'none ', 'None'])
    refusal({ ...base, band }, UNAVAILABLE);
  for (const name of STYLES) for (const style_strength of [-0.1, 1.1, 2, NaN, Infinity, -Infinity, '0.5', true, [], {}]) {
    refusal({ ...base, band: name, style_strength }, STRENGTH);
    refusal({ ...base, style_strength }, STRENGTH);
  }
  for (const name of STYLES) for (const style_strength of [0, 0.1, 0.5, 0.99, 1]) assert.equal(ace.aceInput({ ...base, band: name, style_strength }, ON).style_strength, style_strength);
  for (const name of STYLES) {
    refusal({ script: 'Banjo', singing: INSTRUMENTAL, band: name, seed: 1 }, SINGING);
    refusal({ script: 'Banjo', singing: true, band: name, seed: 1 }, SINGING);
    assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, band: name, style_strength: 0, seed: 1 }, ON).instrumental, true, `${name}: strength 0 is no style`);
    /* The order a person meets them in: the earlier refusals first, then the Style, then Quality. */
    refusal({ ...base, lyrics: '', band: name }, 'Add the words to sing in Lyrics, or choose Instrumental under Singing or instrumental.');
    refusal({ ...base, band: name, quality: 'Great' }, 'Under Quality, choose Fast or Best.');
    refusal({ ...base, band: name, length: '9:00' }, 'Choose a length up to 6:00.');
  }
  assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, band: 'none', seed: 1 }, ON).instrumental, true, 'None: an instrumental as ever');
  refusal({ ...base, band: 'nonsense', style_strength: 5 }, UNAVAILABLE);
  for (const sentence of [UNAVAILABLE, STRENGTH, SINGING]) assert.doesNotMatch(sentence, PERSON_OR_FOLDER);
});

/* ---------- the project, the quote, the library line ---------- */

test('Open in the booth: the project remembers Style and strength, and the card puts them back', () => {
  for (const name of STYLES) {
    const input = ace.aceInput({ ...base, band: name, style_strength: 0.6, quality: 'Fast', weirdness: 70, length: '3:00' }, ON);
    const options = ace.aceProjectOptions(input);
    assert.deepEqual(options, { quality: 'Best', length: '3:00', singing: SUNG, lyrics: LYRICS, weirdness: 70, guidance: 1, seed: 7, band: name, style_strength: 0.6 });
    const card = new Set(ace.aceGuide(ON, true).settings.map((s) => s.key));
    for (const key of Object.keys(options)) assert.ok(card.has(key), `${key} is a setting on the card, so the page puts it back`);
    const reopened = ace.aceInput({ script: input.style, ...JSON.parse(JSON.stringify(options)) }, ON);
    assert.deepEqual(ace.aceRequest(reopened), ace.aceRequest(input), `${name}: sent again from the reopened card, the very same request`);
    assert.equal(reopened.band, name, 'and it is the same style it was, not the other one');
    assert.equal(ace.aceProjectWhy(options), `ACE-Step XL — a song made on the sleeping music GPU, best quality, in the ${LABEL[name]} style`);
    /* A Style at the default strength is remembered without a strength; None remembers neither. */
    assert.deepEqual(ace.aceProjectOptions(ace.aceInput({ ...base, band: name }, ON)), { ...ace.aceProjectOptions(ace.aceInput(base, {})), quality: 'Best', band: name });
  }
  assert.equal('band' in ace.aceProjectOptions(ace.aceInput({ ...base, band: 'none' }, ON)), false);
  /* An older project, saved before styles, reads as it always did. */
  assert.equal(ace.aceProjectWhy({ quality: 'Best', singing: SUNG }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality');
  assert.equal(ace.aceProjectWhy(undefined), 'ACE-Step XL — a song made on the sleeping music GPU');
});

test('a project saved before Suno existed (band soul, as the base commit wrote it) still opens, reads and sends what it did', () => {
  /* The exact options the base commit's aceProjectOptions saved, written out as stored, and the exact job it sent from them. */
  for (const [body, sent, , options] of SOUL_BEFORE_SUNO) {
    const stored = JSON.parse(options);
    assert.equal(stored.band, 'soul');
    const reopened = ace.aceInput({ script: body.script, ...stored }, ON);
    assert.equal(JSON.stringify(ace.aceRequest(reopened)), sent, 'sent again from the reopened card, the very job it was');
    assert.deepEqual(ace.aceProjectOptions(reopened), stored, 'and saved again as it was');
    assert.equal(ace.aceProjectWhy(stored), 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
    const card = ace.aceGuide(ON, true).settings.find((setting) => setting.key === 'band');
    assert.ok(card.options.includes(stored.band), 'the card still offers the style the project was made in');
  }
  /* Saved before any style existed: no band at all. */
  const old = { quality: 'Fast', length: 'Match my lyrics', singing: SUNG, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 7 };
  assert.equal(JSON.stringify(ace.aceRequest(ace.aceInput({ script: base.script, ...old }, ON))), BEFORE_THE_STYLES[0][1]);
  /* A saved job (the stored input, as the router keeps it) rebuilds the same worker request. */
  for (const [body, sent] of SOUL_BEFORE_SUNO) assert.equal(JSON.stringify(ace.aceRequest(JSON.parse(JSON.stringify(ace.aceInput(body, ON))))), sent);
});

test('the library line says the style only when one was really used', () => {
  const why = (options) => ace.aceProjectWhy({ quality: 'Best', singing: SUNG, ...options });
  for (const name of STYLES) {
    const styled = `ACE-Step XL — a song made on the sleeping music GPU, best quality, in the ${LABEL[name]} style`;
    assert.equal(why({ band: name }), styled);
    assert.equal(why({ band: name, style_strength: 0.5 }), styled);
    assert.equal(why({ band: name, style_strength: 0 }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality', 'strength 0 is a plain take');
    assert.equal(why({ band: name, style_strength: 0.00004 }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality', 'so is one too small to count');
    assert.equal(why({ band: name, style_strength: 0.0001 }), styled, 'the smallest that counts');
    assert.equal(why({ band: name, style_strength: 'x' }), styled, 'defensive: a saved value that is not a number reads as the full style, as it did');
    assert.equal(ace.aceProjectWhy({ singing: INSTRUMENTAL, band: name }), `ACE-Step XL — an instrumental made on the sleeping music GPU, in the ${LABEL[name]} style`, 'defensive: the line follows the saved options');
  }
  for (const band of ['none', '', 'kids', 'Suno', 'SOUL', undefined, 5, 'constructor']) assert.equal(why({ band }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality', String(band));
});

test('the quote names the style, the quality it forces, and the cost, before anything is spent', () => {
  for (const name of STYLES) {
    const quote = ace.aceEstimate(ace.aceInput({ ...base, band: name }, ON));
    assert.equal(quote, `About 30 seconds of music in the ${LABEL[name]} style, which always uses best quality. ${ace.aceCost}`);
    assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: name, quality: 'Best', length: '3:00' }, ON)), `About 3 minutes of music in the ${LABEL[name]} style, which always uses best quality. ${ace.aceCost}`);
    assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: name, style_strength: 0 }, ON)), `About 30 seconds of music, fast quality. Style strength is 0, so the ${LABEL[name]} style is not used. ${ace.aceCost}`);
    const cut = ace.aceEstimate(ace.aceInput({ ...base, band: name, script: `Soul ${'warm '.repeat(150)}` }, ON));
    assert.match(cut, new RegExp(`in the ${LABEL[name]} style, which always uses best quality\\. Only the first part of Music direction fits; ACE-Step XL reads 512 characters\\.`));
    for (const said of [quote, cut]) assert.doesNotMatch(said, PERSON_OR_FOLDER, said);
    assert.ok(quote.endsWith(ace.aceCost), 'the cost line is still said, and still true: Best uses more');
  }
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: 'none' }, ON)), `About 30 seconds of music, fast quality. ${ace.aceCost}`);
});

/* ---------- the answer: the asset and the take note ---------- */

const STYLED_ANSWER = {
  engine: 'ace', model: 'xl-sft', key: 'ace/a/master.mp3', wav_key: 'ace/a/master.wav', url: 'https://assets.test/a.mp3', wav_url: 'https://assets.test/a.wav',
  duration_s: 94.6, bytes: 3784000, seed: 7, processing_ms: 61000, truncated: false,
  takes: [{ index: 0, seed: 7, key: 'ace/a/master.mp3', wav_key: 'ace/a/master.wav', url: 'https://assets.test/a.mp3', wav_url: 'https://assets.test/a.wav', duration_s: 94.6, bytes: 3784000 }],
  controls: { steps: 50, guidance_scale: 7, shift: 3, lm_temperature: 0.85 },
  timing: { model_load_s: 12, plan_s: 2.4, render_s: 41, encode_s: 1.6, upload_s: 1.2 }, memory: { render_peak_gib: 31.5 },
  gpu: 'NVIDIA RTX A6000', features: ['ace-xl-turbo', 'ace-xl-sft', 'batch', 'instrumental', 'probe', 'lora'],
  versions: { ace_step_commit: 'ca1e85f', torch: '2.8.0+cu128', worker: 'ace-2' },
  worker_notes: ['Used 50 steps.', 'Applied the Soul style at 1.'],
  style: { key: 'ace-loras/soul-real-v1', name: 'Soul', scale: 1, tag: 'x-tag', sha256: 'f'.repeat(64) },
  plan: { bpm: 88, keyscale: 'A minor', duration: 95 },
};

/** The same answer as the worker would give for a take made in this style. */
const answerFor = (name, extra = {}) => ({
  ...STYLED_ANSWER,
  worker_notes: ['Used 50 steps.', `Applied the ${LABEL[name]} style at 1.`],
  style: { key: KEY[name], name: LABEL[name], scale: 1, tag: 'x-tag', sha256: 'f'.repeat(64) },
  ...extra,
});

test('a styled worker answer parses: take 0, the style it applied, and one plain sentence for the library', () => {
  assert.deepEqual(answerFor('soul'), STYLED_ANSWER, 'the Soul fixture is the one this suite always used');
  for (const name of STYLES) {
    const answer = answerFor(name);
    const input = ace.aceInput({ ...base, band: name, style_strength: 0.7 }, ON);
    assert.equal(ace.aceOutput(answer), answer, 'take 0 is already at the top level');
    const { key: _k, wav_key: _w, url: _u, wav_url: _wu, duration_s: _d, bytes: _b, seed: _s, ...listed } = answer;
    const lifted = ace.aceOutput(listed);
    assert.equal(lifted.url, answer.url);
    assert.deepEqual(lifted.style, answer.style, 'lifting the first take keeps the style report');
    assert.deepEqual(ace.aceTakeFacts(answer, input), {
      gpu: 'NVIDIA RTX A6000', model: 'xl-sft', bpm: 88, keyscale: 'A minor', weirdness: 50, guidance: 1,
      band: name, style_strength: 0.7, lora_key: KEY[name], lora_scale: 0.7,
      style: { key: KEY[name], name: LABEL[name], scale: 1, tag: 'x-tag', sha256: 'f'.repeat(64) },
      takeNote: `Made in the ${LABEL[name]} style at strength 0.7.`,
    });
    assert.equal(ace.aceTakeNote(answer, ace.aceInput({ ...base, band: name }, ON)), `Made in the ${LABEL[name]} style.`, 'at the full strength nothing more is said');
    assert.equal(ace.aceTakeNote(answer, ace.aceInput({ ...base, band: name, style_strength: 1 }, ON)), `Made in the ${LABEL[name]} style.`);
    assert.doesNotMatch(ace.aceTakeNote(answer, input), PERSON_OR_FOLDER);
  }
});

test('a styled take the worker did not confirm says so, and nothing the worker says is trusted blindly', () => {
  for (const name of STYLES) {
    const other = STYLES.find((candidate) => candidate !== name);
    const input = ace.aceInput({ ...base, band: name }, ON);
    const answer = answerFor(name);
    const NOT = `The ${LABEL[name]} style was not confirmed for this take, so it may sound like plain ACE-Step XL.`;
    const { style: _style, ...plainAnswer } = answer;
    assert.equal(ace.aceTakeNote(plainAnswer, input), NOT, 'no style in the answer');
    assert.equal(ace.aceTakeNote({ ...answer, style: {} }, input), NOT, 'an empty report');
    assert.equal(ace.aceTakeNote({ ...answer, style: LABEL[name] }, input), NOT, 'a report that is not an object');
    assert.equal(ace.aceTakeNote({ ...answer, style: { scale: Infinity, name: 7, key: null } }, input), NOT, 'nothing usable in it');
    assert.equal(ace.aceTakeNote({ ...answer, style: { ...answer.style, key: 'ace-loras/another-v1' } }, input), NOT, 'another adapter than the one asked for');
    /* The other style's adapter is just as wrong an answer: a take asked for in one style and made in the other is not confirmed. */
    assert.equal(ace.aceTakeNote({ ...answer, style: { ...answer.style, key: KEY[other], name: LABEL[other] } }, input), NOT, `${LABEL[other]}'s adapter is not ${LABEL[name]}'s`);
    assert.equal(ace.aceTakeNote(undefined, input), '');
    const facts = ace.aceTakeFacts({ ...answer, style: { name: LABEL[name], scale: NaN, tag: 3, extra: 'ignored' } }, input);
    assert.deepEqual(facts.style, { name: LABEL[name] }, 'only fields of the right kind are kept');
    assert.equal(ace.aceTakeFacts(plainAnswer, input).style, undefined);
    assert.equal(ace.aceTakeFacts(plainAnswer, input).takeNote, NOT, 'the library line is the honest one');
    assert.equal(ace.aceTakeFacts(plainAnswer, input).lora_key, KEY[name], 'what was asked for is still recorded');
    /* The answer to a plain take is read exactly as it was, even from a worker that now sends a style field. */
    const plain = ace.aceInput(base, ON);
    assert.equal('style' in ace.aceTakeFacts(answer, plain), false);
    assert.equal(ace.aceTakeNote(answer, plain), '');
  }
});

test('a plain take\'s asset says nothing of a style, however the Style was left: None with a strength moved, strength 0, or one too small', () => {
  const answer = { url: 'x', gpu: 'NVIDIA RTX A6000', model: 'xl-turbo', plan: { bpm: 88, keyscale: 'A minor' } };
  const plainFacts = ace.aceTakeFacts(answer, ace.aceInput(base, {}));
  const STYLE_FIELDS = ['band', 'style_strength', 'lora_key', 'lora_scale', 'style', 'takeNote'];
  const plainSettings = [{ style_strength: 0.4 }, { style_strength: 0 }, { style_strength: 1 }, { band: 'none', style_strength: 0.4 }, { band: '', style_strength: 0.4 }];
  for (const name of STYLES) plainSettings.push({ band: name, style_strength: 0 }, { band: name, style_strength: 0.00004 }, { band: name, style_strength: 0, quality: 'Best' });
  for (const extra of plainSettings) {
    const input = ace.aceInput({ ...base, ...extra }, ON);
    const facts = ace.aceTakeFacts(answer, input);
    for (const key of STYLE_FIELDS) assert.equal(key in facts, false, `${JSON.stringify(extra)}: ${key}`);
    assert.deepEqual(facts, plainFacts, `${JSON.stringify(extra)}: the same facts as a take with no Style at all`);
    /* She set it, so the project still remembers it, and Open in the booth puts it back. */
    const options = ace.aceProjectOptions(input);
    assert.equal(options.style_strength, extra.style_strength, JSON.stringify(extra));
    assert.equal(options.band, STYLES.includes(extra.band) ? extra.band : undefined, JSON.stringify(extra));
  }
  /* A take that was sent an adapter still keeps all of them. */
  for (const name of STYLES) {
    const styled = ace.aceTakeFacts({ ...answer, model: 'xl-sft', style: answerFor(name).style }, ace.aceInput({ ...base, band: name, style_strength: 0.5 }, ON));
    for (const key of STYLE_FIELDS) assert.equal(key in styled, true, `${name} ${key}`);
    assert.equal(styled.band, name);
    assert.equal(styled.lora_key, KEY[name]);
  }
});

/* ---------- the card ---------- */

test('the card with styles on: Style after Quality, Style strength under More settings, the YuE2 card\'s keys and ranges', () => {
  const live = ace.aceGuide(ON, true);
  assert.deepEqual(live.settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'band', 'style_strength', 'length', 'weirdness', 'guidance', 'seed']);
  assert.deepEqual(live.settings.filter((s) => s.advanced).map((s) => s.key), ['style_strength', 'weirdness', 'guidance', 'seed']);
  const [band, strength] = [live.settings[3], live.settings[4]];
  assert.deepEqual(band, { key: 'band', label: 'Style', hint: ace.aceStyleHint, kind: 'choice', options: ['none', 'soul', 'suno'], default: 'none' });
  assert.deepEqual(strength, {
    key: 'style_strength', label: 'Style strength', kind: 'number', min: 0, max: 1, step: 0.1, default: 1, advanced: true,
    hint: 'Lower it to blend the style with plain ACE-Step XL. 0 is plain; 1 is the full style. Applies only when a Style is selected.',
  });
  /* The YuE2 card's own two rows, field for field (label, kind, ranges), so the web page and the iPhone draw them alike. */
  const yueBand = { key: 'band', label: 'Style', kind: 'choice', default: 'none' };
  const yueStrength = { key: 'style_strength', label: 'Style strength', kind: 'number', min: 0, max: 1, step: 0.1, default: 1, advanced: true };
  for (const [mine, theirs] of [[band, yueBand], [strength, yueStrength]]) for (const [field, value] of Object.entries(theirs)) assert.deepEqual(mine[field], value, `${mine.key}.${field}`);
  assert.equal(band.locked, undefined);
  assert.equal(strength.locked, undefined);
  const hint = (guide, key) => guide.settings.find((s) => s.key === key).hint;
  assert.equal(hint(live, 'singing'), 'Instrumental plays the tune on instruments and ignores any lyrics. Choose None under Style for an instrumental.');
  assert.equal(hint(live, 'quality'), 'Fast is quick. Best is slower and costs more. A Style always uses Best.');
  /* Prompt guidance is for Best only, and a Style is always Best: a Style hint that says Fast ignores it would contradict that. */
  assert.equal(hint(live, 'guidance'), 'Only for Quality Best; Fast ignores it. Higher follows your direction and lyrics more strictly but can sound less natural. A Style always uses Best, so this applies to it.');
  /* The rest of the card is the card it was. */
  const was = ace.aceGuide({}, true);
  const { settings: _a, ...liveRest } = live;
  const { settings: _b, ...wasRest } = was;
  assert.deepEqual(liveRest, wasRest, 'tagline, cost, how to write: untouched');
  for (const key of ['lyrics', 'length', 'weirdness', 'seed'])
    assert.deepEqual(live.settings.find((s) => s.key === key), was.settings.find((s) => s.key === key), key);
  assert.deepEqual({ ...live.settings.find((s) => s.key === 'guidance'), hint: '' }, { ...was.settings.find((s) => s.key === 'guidance'), hint: '' }, 'guidance: only its hint is longer');
  assert.ok(hint(live, 'guidance').startsWith(hint(was, 'guidance')), 'the plain hint is still the front of it');
  for (const setting of live.settings) assert.ok(setting.hint.length <= 240, `${setting.key}: a hint stays about a sentence or two`);
});

test('the card for an account outside the pack: the choice is there, every option kept, greyed out with the pack note', () => {
  const live = ace.aceGuide(ON, true);
  for (const outside of [ace.aceGuide(ON, false), ace.aceGuide(ON)]) {
    assert.deepEqual(outside.settings.map((s) => s.key), live.settings.map((s) => s.key), 'never hidden');
    for (const key of ['band', 'style_strength']) {
      const row = outside.settings.find((s) => s.key === key);
      const open = live.settings.find((s) => s.key === key);
      assert.equal(row.locked, 'Part of the Family feature pack');
      assert.equal(row.hint, `${open.hint} Part of the Family feature pack, so songs on this account use None, plain ACE-Step XL.`);
      assert.deepEqual({ ...row, hint: open.hint, locked: undefined }, { ...open, locked: undefined }, `${key}: options, ranges and default are the same`);
    }
    assert.deepEqual(outside.settings.find((s) => s.key === 'band').options, ['none', 'soul', 'suno']);
    /* Only the two Style rows change; the Singing and Quality hints do not speak of a Style they cannot use. */
    const plain = ace.aceGuide({}, true);
    for (const key of ['singing', 'lyrics', 'quality', 'length', 'weirdness', 'guidance', 'seed'])
      assert.deepEqual(outside.settings.find((s) => s.key === key), plain.settings.find((s) => s.key === key), key);
  }
  /* With the flag on, the shared card is never changed by a lock. */
  assert.equal(live.settings.find((s) => s.key === 'band').locked, undefined);
  assert.equal(ace.aceGuide(ON, true).settings.find((s) => s.key === 'band').locked, undefined);
});

test('withAceGuide carries the pack answer in; a caller that says nothing gets the choice greyed out', () => {
  const shell = { engines: { yue2: { name: 'YuE2' } }, other: 1 };
  const env = { ACE_ENABLED: '1', ACE_STYLES_ENABLED: '1' };
  const admin = { role: 'ADMIN' };
  const band = (guide) => guide.engines.ace.settings.find((s) => s.key === 'band');
  assert.equal(band(ace.withAceGuide(shell, admin, env, true)).locked, undefined);
  assert.equal(band(ace.withAceGuide(shell, admin, env, false)).locked, 'Part of the Family feature pack');
  assert.equal(band(ace.withAceGuide(shell, admin, env)).locked, 'Part of the Family feature pack', 'fail closed');
  assert.equal(band(ace.withAceGuide(shell, admin, env, 'yes')).locked, 'Part of the Family feature pack', 'only a true boolean opens it');
  assert.equal(band(ace.withAceGuide(shell, admin, env, undefined)).locked, 'Part of the Family feature pack');
  assert.deepEqual(Object.keys(ace.withAceGuide(shell, admin, env, true).engines), ['yue2', 'ace']);
  assert.equal(ace.withAceGuide(shell, { role: 'USER' }, env, true), shell, 'admin-only: no card, whatever the pack says');
  assert.equal(ace.withAceGuide(shell, { role: 'ADMIN' }, { ACE_STYLES_ENABLED: '1' }, true), shell, 'styles on without ACE on: no card');
  assert.equal(shell.engines.ace, undefined, 'the shared object is never changed');
});

test('aceStyleAccess is yueStyleAccess for the ACE card', () => {
  const settings = [
    { key: 'lyrics', label: 'Lyrics', hint: 'Words.', kind: 'text' },
    { key: 'band', label: 'Style', hint: ace.aceStyleHint, kind: 'choice', options: ['none', 'soul', 'suno'], default: 'none' },
    { key: 'style_strength', label: 'Style strength', hint: 'Strength.', kind: 'number' },
    { key: 'seed', label: 'Seed', hint: 'Seed.', kind: 'number' },
  ];
  assert.equal(ace.aceStyleAccess(settings, true, pack.FAMILY_PACK_NOTE), settings, 'unchanged with the pack');
  const locked = ace.aceStyleAccess(settings, false, pack.FAMILY_PACK_NOTE);
  assert.notEqual(locked, settings);
  assert.deepEqual(locked.map((s) => s.key), ['lyrics', 'band', 'style_strength', 'seed']);
  assert.equal(locked[1].locked, 'Part of the Family feature pack');
  assert.equal(locked[2].locked, 'Part of the Family feature pack');
  assert.equal(locked[1].hint, `${ace.aceStyleHint} Part of the Family feature pack, so songs on this account use None, plain ACE-Step XL.`);
  assert.equal(locked[0], settings[0]);
  assert.equal(locked[3], settings[3]);
  assert.equal(settings[1].locked, undefined, 'the shared settings are never changed');
  assert.equal(ace.aceStyleAccess(settings, false).at(1).locked, 'Part of the Family feature pack', 'the pack note is the default');
  const noStyle = settings.filter((s) => s.key !== 'band');
  assert.equal(ace.aceStyleAccess(noStyle, false, pack.FAMILY_PACK_NOTE), noStyle, 'styles switched off: nothing to lock');
  assert.equal(yue.yueStyleLockedSentence.replace('YuE2', 'ACE-Step XL'), ace.aceStyleLockedSentence, 'the same sentence as YuE2\'s, naming this engine');
});

/* ---------- the carry between the two engines ---------- */

const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
const yueSoul = () => deepFreeze({
  _id: 'p1', engine: 'yue2', title: 'Rain', sourceText: 'my notes',
  script: 'Slow soul, Rhodes, female lead vocal',
  options: { lyrics: LYRICS, band: 'soul', style_strength: 0.5, seed: 4, weirdness: 60, guidance: 2, count: 3, cot: 'off', steps: 40 },
});
const aceSoul = () => deepFreeze({
  _id: 'p2', engine: 'ace', title: 'Rain', sourceText: 'my notes', script: 'Slow soul, Rhodes',
  options: { quality: 'Best', length: 'Match my lyrics', singing: SUNG, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 7, band: 'soul', style_strength: 0.6 },
});
const STYLE_KEYS = ['band', 'style_strength', 'lora_key', 'lora_scale'];

test('carry, YuE2 to ACE-Step XL: the words and the seed come across, the style name does not, and it says so', () => {
  const out = carry.carryOver(yueSoul(), 'ace', { ace: true, aceStyles: true });
  assert.equal(out.ok, true);
  for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${key} stays behind`);
  assert.deepEqual(Object.keys(out.draft.options).sort(), ['carriedFrom', 'guidance', 'lyrics', 'seed', 'singing', 'weirdness']);
  assert.equal(out.draft.options.lyrics, LYRICS);
  assert.equal(out.draft.options.seed, 4);
  assert.equal(out.draft.options.weirdness, 60);
  assert.equal(out.draft.options.guidance, 2);
  assert.equal(out.draft.engine, 'ace');
  assert.ok(out.notes.includes('ACE-Step XL has its own Style choice, taught separately from YuE2\'s, so the YuE2 style was left behind. Choose Style on the ACE-Step XL card to use one.'), out.notes.join(' | '));
  assert.ok(out.notes.some((n) => /took 3|3 takes you asked for became one/.test(n)), 'the take count is still said');
  assert.doesNotMatch(out.notes.join(' '), /no trained style, which only YuE2 has/, 'ACE-Step XL has styles now: it does not claim otherwise');
});

test('carry, YuE2 to ACE-Step XL with styles off: the sentence it always was', () => {
  for (const helpers of [{ ace: true }, { ace: true, aceStyles: false }, { ace: true, aceStyles: 'yes' }]) {
    const out = carry.carryOver(yueSoul(), 'ace', helpers);
    assert.ok(out.notes.includes('ACE-Step XL has no trained style, which only YuE2 has, so that was left behind.'), JSON.stringify(helpers));
    for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false);
  }
});

test('carry, ACE-Step XL to YuE2: the style name does not come across, and it says so where YuE2 has a Style choice to point to', () => {
  const OWN = 'YuE2 has its own Style choice, taught separately from ACE-Step XL\'s, so the ACE-Step XL style was left behind. Choose Style on the YuE2 card to use one.';
  const out = carry.carryOver(aceSoul(), 'yue2', { ace: true, aceStyles: true, yueStyles: true });
  assert.equal(out.ok, true);
  for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${key} stays behind`);
  assert.equal(out.draft.options.lyrics, LYRICS);
  assert.equal(out.draft.options.seed, 7);
  assert.ok(out.notes.includes(OWN), out.notes.join(' | '));
  assert.doesNotMatch(out.notes.join(' '), /quality choice/, 'Best was the style\'s doing, and the style is already said');
  assert.equal(out.draft.script, 'Slow soul, Rhodes', 'no trigger word is written into her words');
  /* YuE2 has no Style choice for this person (its flag is off, or she is outside the pack): it is still said that the style was
   * left behind, but nothing points her at a choice that is not there. */
  for (const helpers of [{ ace: true, aceStyles: true }, { ace: true, aceStyles: true, yueStyles: false }, { ace: true, aceStyles: true, yueStyles: 'yes' }]) {
    const none = carry.carryOver(aceSoul(), 'yue2', helpers);
    assert.ok(none.notes.includes('YuE2 has no trained style, which only ACE-Step XL has, so that was left behind.'), `${JSON.stringify(helpers)}: ${none.notes.join(' | ')}`);
    assert.doesNotMatch(none.notes.join(' '), /Choose Style|own Style choice|quality choice/, JSON.stringify(helpers));
    for (const key of STYLE_KEYS) assert.equal(key in none.draft.options, false);
  }
});

test('carry, ACE-Step XL to YuE2 with ACE styles off for this person: the answer it always gave, whatever a hand-made draft names', () => {
  /* ACE-Step XL has no Style choice with the flag off or outside the pack; a draft that names one anyway (a hand-made body)
   * is carried exactly as before ACE-Step XL had styles: no sentence about a style, the quality choice said as it was. */
  const bare = { ...aceSoul(), options: { ...aceSoul().options } };
  delete bare.options.band;
  delete bare.options.style_strength;
  for (const helpers of [{ ace: true }, { ace: true, aceStyles: false }, { ace: true, aceStyles: 'yes' }, { ace: true, yueStyles: true }, { ace: true, aceStyles: false, yueStyles: true }]) {
    const toYue = carry.carryOver(aceSoul(), 'yue2', helpers);
    assert.deepEqual(toYue.notes, carry.carryOver(bare, 'yue2', helpers).notes, `${JSON.stringify(helpers)}: not one new sentence for YuE2`);
    assert.deepEqual(toYue.draft.options, carry.carryOver(bare, 'yue2', helpers).draft.options);
    assert.ok(toYue.notes.includes('YuE2 has no quality choice, so that was left behind.'), 'Best was her choice as far as this carry can tell');
    const toLyria = carry.carryOver(aceSoul(), 'lyria', helpers);
    assert.ok(toLyria.notes.includes('Lyria has no trained style, which only YuE2 has, no quality choice, so those were left behind.'), `${JSON.stringify(helpers)}: ${toLyria.notes.join(' | ')}`);
    assert.doesNotMatch(toLyria.notes.join(' '), /ACE-Step XL have/);
  }
});

test('carry: the style is said accurately for every other destination, and a plain take says nothing about styles', () => {
  const toLyria = carry.carryOver(aceSoul(), 'lyria', { ace: true, aceStyles: true });
  assert.ok(toLyria.notes.some((n) => n.startsWith('Lyria has no trained style, which only YuE2 and ACE-Step XL have')), toLyria.notes.join(' | '));
  for (const key of STYLE_KEYS) assert.equal(key in toLyria.draft.options, false);
  const yueToLyria = carry.carryOver(yueSoul(), 'lyria', { ace: true, aceStyles: true });
  assert.ok(yueToLyria.notes.some((n) => n.startsWith('Lyria has no trained style, which only YuE2 has, no ')), `a YuE2 project to Lyria: unchanged, and it does not speak of ACE-Step XL (${yueToLyria.notes.join(' | ')})`);
  assert.doesNotMatch(yueToLyria.notes.join(' '), /ACE-Step XL/);
  const plainAce = { ...aceSoul(), options: { quality: 'Fast', length: 'Match my lyrics', singing: SUNG, lyrics: LYRICS, weirdness: 50, guidance: 1, seed: 7 } };
  const noneAce = { ...aceSoul(), options: { ...plainAce.options, band: 'none' } };
  const zero = { ...aceSoul(), options: { ...plainAce.options, band: 'soul', style_strength: 0 } };
  for (const project of [plainAce, noneAce]) for (const to of ['yue2', 'lyria']) for (const yueStyles of [true, false]) {
    const out = carry.carryOver(project, to, { ace: true, aceStyles: true, yueStyles });
    assert.doesNotMatch(out.notes.join(' '), /[Ss]tyle/, `${to}: ${out.notes.join(' | ')}`);
  }
  /* A Style at strength 0 was a plain take: no adapter was used, so there is no style to say was left behind. */
  for (const to of ['yue2', 'lyria']) for (const yueStyles of [true, false]) {
    const out = carry.carryOver(zero, to, { ace: true, aceStyles: true, yueStyles });
    assert.doesNotMatch(out.notes.join(' '), /[Ss]tyle/, `${to}: strength 0 is a plain take (${out.notes.join(' | ')})`);
    for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false);
  }
  const zeroBest = { ...aceSoul(), options: { ...zero.options, quality: 'Best' } };
  assert.ok(carry.carryOver(zeroBest, 'yue2', { ace: true, aceStyles: true, yueStyles: true }).notes.includes('YuE2 has no quality choice, so that was left behind.'), 'Best was her own pick on a plain take, so it is said');
  /* While ACE-Step XL has no Style for this person, strength 0 is not looked at: the carry is the one it always was. */
  assert.ok(carry.carryOver(zero, 'lyria', { ace: true }).notes.some((n) => n.startsWith('Lyria has no trained style, which only YuE2 has')));
  const plainYue = { ...yueSoul(), options: { lyrics: LYRICS, seed: 4 } };
  assert.doesNotMatch(carry.carryOver(plainYue, 'ace', { ace: true, aceStyles: true }).notes.join(' '), /[Ss]tyle/);
  /* Strength never crosses by itself either, in either direction. */
  const strengthOnly = deepFreeze({ _id: 'p3', engine: 'yue2', title: 't', script: 'Soul', options: { lyrics: LYRICS, style_strength: 0.3 } });
  assert.equal('style_strength' in carry.carryOver(strengthOnly, 'ace', { ace: true, aceStyles: true }).draft.options, false);
});

test('carry: the original is never touched, and ACE-Step XL stays invisible to a person who may not use it', () => {
  const source = yueSoul();
  const before = JSON.stringify(source);
  carry.carryOver(source, 'ace', { ace: true, aceStyles: true });
  assert.equal(JSON.stringify(source), before, 'frozen, and the same');
  assert.deepEqual(carry.carryOver(source, 'ace', { aceStyles: true }), { ok: false, why: 'There is no engine by that name.' });
  assert.deepEqual(carry.carryOver(aceSoul(), 'yue2', { aceStyles: true }), { ok: false, why: 'That project was not made by an engine this can carry.' });
  assert.deepEqual(carry.destinationsFor('yue2', { ace: true }).map((d) => d.engine), ['lyria', 'ace']);
  assert.deepEqual(carry.destinationsFor('ace', { ace: true }).map((d) => d.engine), ['lyria', 'yue2']);
  assert.deepEqual(carry.ENGINES.ace.keeps, ['lyrics', 'seed', 'singing', 'weirdness', 'guidance'], 'no style key is carried');
  assert.deepEqual(carry.ENGINES.yue2.keeps.filter((key) => STYLE_KEYS.includes(key)), []);
  assert.deepEqual(carry.SHARED_KNOBS.filter((key) => STYLE_KEYS.includes(key)), []);
  for (const [engine, row] of Object.entries(carry.ENGINES)) assert.deepEqual(row.keeps.filter((key) => STYLE_KEYS.includes(key)), [], `${engine}: no engine keeps a style field`);
  assert.deepEqual(carry.STYLE_KEYS, STYLE_KEYS, 'the rule the carry enforces is the list this suite checks');
});

/* Both song engines have a style called soul, and they are different adapters. The carry must not tell them apart by name, because
 * a name proves nothing: it drops the Style fields by key, whatever the value, in both directions and for every style. */
test('carry: no style crosses between YuE2 and ACE-Step XL in either direction, whatever it is called', () => {
  const draftOf = (engine, options) => deepFreeze({ _id: 'p', engine, title: 'Rain', sourceText: 'notes', script: 'Slow soul, Rhodes', options: { lyrics: LYRICS, seed: 4, ...options } });
  const names = [...new Set([...Object.keys(yue.yueStyles), ...Object.keys(ace.aceStyles), 'none', '', 'Soul', 'SUNO', 'something else', 5, null, ['soul'], { soul: 1 }])];
  const live = [{ ace: true }, { ace: true, aceStyles: true }, { ace: true, aceStyles: true, yueStyles: true }, { ace: true, yueStyles: true }];
  assert.ok(names.includes('soul') && names.includes('suno') && names.includes('kids'), 'the names both menus share and the ones only one has');
  for (const helpers of live) for (const band of names) for (const strength of [undefined, 0, 0.5, 1]) {
    const options = { band, ...(strength === undefined ? {} : { style_strength: strength }), lora_key: 'ace-loras/suno-v1', lora_scale: 0.5 };
    for (const [from, to] of [['yue2', 'ace'], ['ace', 'yue2'], ['ace', 'lyria'], ['yue2', 'lyria']]) {
      const out = carry.carryOver(draftOf(from, options), to, helpers);
      assert.equal(out.ok, true, `${from} -> ${to}`);
      for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${from} -> ${to} ${JSON.stringify(helpers)}: ${key} (band ${JSON.stringify(band)}) does not cross`);
    }
  }
  /* Every style the two registries share by name, and the ones they do not. */
  for (const name of [...Object.keys(yue.yueStyles), ...Object.keys(ace.aceStyles)]) {
    const toAce = carry.carryOver(draftOf('yue2', { band: name }), 'ace', { ace: true, aceStyles: true });
    const toYue = carry.carryOver(draftOf('ace', { band: name }), 'yue2', { ace: true, aceStyles: true, yueStyles: true });
    assert.equal('band' in toAce.draft.options, false, `YuE2 ${name} does not become ACE-Step XL ${name}`);
    assert.equal('band' in toYue.draft.options, false, `ACE-Step XL ${name} does not become YuE2 ${name}`);
    assert.ok(toAce.notes.includes(`ACE-Step XL has its own Style choice, taught separately from YuE2's, so the YuE2 style was left behind. Choose Style on the ACE-Step XL card to use one.`), `${name}: ${toAce.notes.join(' | ')}`);
    assert.ok(toYue.notes.includes(`YuE2 has its own Style choice, taught separately from ACE-Step XL's, so the ACE-Step XL style was left behind. Choose Style on the YuE2 card to use one.`), `${name}: ${toYue.notes.join(' | ')}`);
  }
});

test('carry: the left-behind sentence says a style stayed behind and never which, so it is the same for every style', () => {
  /* The sentence is one fixed line, whatever style the draft named. A name in it would go stale the day a menu gains a style,
   * and would have to be kept in step with every other branch that adds one. The words are also what the YuE2 Style suite pins. */
  const sentenceFor = (from, band, helpers) => carry.carryOver(deepFreeze({ _id: 'p', engine: from, title: 't', script: 'Slow soul', options: { lyrics: LYRICS, band } }), from === 'ace' ? 'yue2' : 'ace', helpers).notes.find((n) => /left behind/.test(n));
  const both = { ace: true, aceStyles: true, yueStyles: true };
  const TO_YUE = 'YuE2 has its own Style choice, taught separately from ACE-Step XL\'s, so the ACE-Step XL style was left behind. Choose Style on the YuE2 card to use one.';
  const TO_ACE = 'ACE-Step XL has its own Style choice, taught separately from YuE2\'s, so the YuE2 style was left behind. Choose Style on the ACE-Step XL card to use one.';
  for (const name of [...new Set([...Object.keys(ace.aceStyles), ...Object.keys(yue.yueStyles), 'soul', 'suno', 'kids'])]) {
    assert.equal(sentenceFor('ace', name, both), TO_YUE, `ace ${name}`);
    assert.equal(sentenceFor('yue2', name, both), TO_ACE, `yue2 ${name}`);
  }
  /* Something that is not a plain name is not echoed into a sentence either. */
  for (const band of ['<b>x</b>', 'a b', 'x'.repeat(40), '1soul', 5, ['soul'], { soul: 1 }]) {
    assert.equal(sentenceFor('yue2', band, both), TO_ACE, JSON.stringify(band));
  }
  /* No note a carry makes between the two engines holds a style name, for any style on either menu. */
  for (const name of [...Object.keys(ace.aceStyles), ...Object.keys(yue.yueStyles)]) {
    for (const [from, to] of [['ace', 'yue2'], ['yue2', 'ace']]) for (const helpers of [both, { ace: true, aceStyles: true }, { ace: true }]) {
      const out = carry.carryOver(deepFreeze({ _id: 'p', engine: from, title: 't', script: 'Slow soul', options: { lyrics: LYRICS, band: name, style_strength: 0.5, seed: 4 } }), to, helpers);
      assert.doesNotMatch(out.notes.join(' '), /\b(soul|suno|kids)\b/i, `${from} -> ${to} ${name} ${JSON.stringify(helpers)}: ${out.notes.join(' | ')}`);
    }
  }
  assert.equal('styleName' in carry, false, 'the carry has no helper that puts a style name in a sentence');
  /* No style on the draft, no sentence; the sentence about a pointer to a card appears only where the card has a Style choice. */
  const none = carry.carryOver(deepFreeze({ _id: 'p', engine: 'yue2', title: 't', script: 's', options: { lyrics: LYRICS } }), 'ace', both);
  assert.doesNotMatch(none.notes.join(' '), /[Ss]tyle/);
  const noChoice = sentenceFor('ace', 'suno', { ace: true, aceStyles: true });
  assert.doesNotMatch(noChoice, /Choose Style/, 'YuE2 has no Style choice here, so none is pointed to');
  assert.equal(noChoice, 'YuE2 has no trained style, which only ACE-Step XL has, so that was left behind.', 'that case has its own, shorter sentence');
});

test('carry: the Style fields are dropped by a rule, not by what a table happens to list', () => {
  /* Were a later edit to add a Style field to a keeps list or to the shared knobs, the new draft still would not hold it. */
  const project = deepFreeze({ _id: 'p', engine: 'yue2', title: 't', script: 'Slow soul', options: { lyrics: LYRICS, band: 'soul', style_strength: 0.5, lora_key: 'ace-loras/soul-real-v1', lora_scale: 1, seed: 4 } });
  const aceProject = deepFreeze({ _id: 'p', engine: 'ace', title: 't', script: 'Slow soul', options: { lyrics: LYRICS, band: 'suno', style_strength: 0.5, lora_key: 'ace-loras/suno-v1', lora_scale: 1, seed: 4, singing: SUNG } });
  const tamper = [carry.ENGINES.ace.keeps, carry.ENGINES.yue2.keeps, carry.ENGINES.lyria.keeps, carry.SHARED_KNOBS];
  const sizes = tamper.map((list) => list.length);
  try {
    for (const list of tamper) list.push(...STYLE_KEYS);
    for (const [from, to] of [[project, 'ace'], [aceProject, 'yue2'], [project, 'lyria'], [aceProject, 'lyria']]) {
      const out = carry.carryOver(from, to, { ace: true, aceStyles: true, yueStyles: true });
      assert.equal(out.ok, true);
      for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${from.engine} -> ${to}: ${key}`);
      assert.equal(out.draft.options.lyrics !== undefined || to === 'lyria', true);
    }
  } finally {
    tamper.forEach((list, index) => list.splice(sizes[index]));
  }
  assert.deepEqual(tamper.map((list) => list.length), sizes, 'the tables are back as they were');
  assert.deepEqual(carry.SHARED_KNOBS.filter((key) => STYLE_KEYS.includes(key)), []);
  /* The carry route also builds its new project from out.draft alone, so nothing else is copied across. */
  assert.deepEqual(Object.keys(carry.carryOver(project, 'ace', { ace: true }).draft), ['engine', 'title', 'sourceText', 'script', 'options', 'mode', 'state']);
});

test('the booth never writes the trigger word: not in a request, a quote, a project, a card or a note', () => {
  for (const name of STYLES) {
    const input = ace.aceInput({ ...base, band: name, style_strength: 0.8 }, ON);
    const everything = [ace.aceRequest(input), ace.aceEstimate(input), ace.aceProjectOptions(input), ace.aceProjectWhy(ace.aceProjectOptions(input)), ace.aceGuide(ON, true), ace.aceGuide(ON, false), ace.aceTakeNote(answerFor(name), input), input];
    assert.doesNotMatch(JSON.stringify(everything), /kdsoulr|kdsona|kdkids|kdsuno/i);
    assert.doesNotMatch(JSON.stringify(everything), /Kade|Holly|AudioCaptures|Desktop|iCloud/);
  }
});
