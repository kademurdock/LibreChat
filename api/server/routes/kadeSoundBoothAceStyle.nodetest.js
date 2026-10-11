'use strict';
/* ACE-Step XL, the Style choice (Oct 11 2026): the pure half. No server, no database. The trained style (Soul) is a LoRA
 * taught to the Best (xl-sft) decoder; the Style choice is behind ACE_STYLES_ENABLED (off by default) and the Family feature
 * pack. Proven here: the registry, the flag, the hints, that with the flag unset nothing about the card, a request or an
 * answer changes (pinned against the previous commit's own output), that Style None adds nothing to the worker request, the
 * styled request (forced Best, lora_key, lora_scale, English), every refusal, the project round trip, the quote, the library
 * line, the asset facts and the take note, the card for a pack member and for everyone else, and the carry between YuE2 and
 * ACE-Step XL, which never moves a style name either way. The routes and the router are in kadeSoundBoothAceStyle.selftest.js.
 * The lyrics are invented placeholders. */
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
const PERSON_OR_FOLDER = /Kade|Holly|your own folders|sonauto|AudioCaptures|MUSIC GROUP|model training music|Desktop|kdsoulr/i;
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

test('the registry has one style, Soul, with the key and scale the worker is told', () => {
  assert.deepEqual(ace.aceStyles, { soul: { key: 'ace-loras/soul-real-v1', scale: 1 } });
  for (const [name, row] of Object.entries(ace.aceStyles)) {
    assert.match(row.key, /^ace-loras\/[A-Za-z0-9._-]{1,60}$/, `${name}: the worker's strict key pattern`);
    assert.ok(!row.key.includes('..'), `${name}: no parent folder`);
    assert.ok(row.scale >= 0 && row.scale <= 1.5, `${name}: the worker takes 0.0 to 1.5`);
  }
  assert.deepEqual(Object.keys(ace.aceStyles), ['soul'], 'not YuE2\'s menu: no Kids');
  const yueKeys = Object.values(yue.yueStyles).map((row) => row.key);
  for (const row of Object.values(ace.aceStyles)) assert.ok(!yueKeys.includes(row.key), 'a different adapter from every YuE2 style');
});

test('ACE_STYLES_ENABLED is off unless it is exactly 1', () => {
  assert.equal(ace.aceStylesEnabled({}), false);
  assert.equal(ace.aceStylesEnabled(ON), true);
  for (const said of ['0', 'true', 'yes', 'on', '', ' 1', '1 ', 'ON', 'false']) assert.equal(ace.aceStylesEnabled({ ACE_STYLES_ENABLED: said }), false, JSON.stringify(said));
  assert.equal(ace.aceStylesEnabled({ ACE_ENABLED: '1' }), false, 'turning ACE on does not turn styles on');
});

test('the hints are short, plain, true, and name no person, folder or trigger word', () => {
  assert.equal(ace.aceStyleHint, 'A singing style taught to ACE-Step XL from real soul and R&B records. Uses the Best quality. None is plain ACE-Step XL.');
  assert.ok(ace.aceStyleHint.split(/\s+/).length <= 30, 'about one sentence, as the booth asks');
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
  for (const extra of [{ band: 'soul' }, { band: 'kids' }, { band: 'soul', style_strength: 0.3 }, { band: 'nonsense' }, { band: ['soul'] }, { style_strength: 5 }, { style_strength: 'x' }, { band: 'soul', quality: 'Fast', singing: false }]) {
    assert.deepEqual(ace.aceInput({ ...base, ...extra }, {}), plain, JSON.stringify(extra));
    assert.deepEqual(ace.aceInput({ ...base, ...extra }, { ACE_STYLES_ENABLED: '0' }), plain, JSON.stringify(extra));
  }
  const instrumental = ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 1 }, {});
  assert.deepEqual(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 1, band: 'soul' }, {}), instrumental, 'an instrumental with a Style is not refused while styles are off');
  for (const [body, before] of BEFORE_THE_STYLES) {
    assert.equal(JSON.stringify(request({ ...body, band: 'soul', style_strength: 0.4 }, {})), before, JSON.stringify(body));
    assert.equal(JSON.stringify(request(body, {})), before, JSON.stringify(body));
  }
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: 'soul' }, {})), ace.aceEstimate(plain));
  assert.deepEqual(ace.aceProjectOptions(ace.aceInput({ ...base, band: 'soul', style_strength: 0.3 }, {})), ace.aceProjectOptions(plain), 'nothing about a Style is saved');
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

test('the adapter is only ever the registry\'s: a request cannot name its own lora_key, scale, language or model', () => {
  const sneaky = { lora_key: 'ace-loras/someone-elses-v1', lora_scale: 1.5, vocal_language: 'fr', model: 'xl-turbo', lora: 'x' };
  for (const env of [{}, ON]) {
    const plain = request(base, env);
    assert.deepEqual(request({ ...base, ...sneaky }, env), plain, `plain request, ${JSON.stringify(env)}`);
    assert.equal(JSON.stringify(request({ ...base, ...sneaky, band: 'none' }, env)), JSON.stringify(plain));
  }
  const styled = request({ ...base, band: 'soul' });
  assert.deepEqual(request({ ...base, ...sneaky, band: 'soul' }), styled, 'a styled request still takes the registry\'s key, scale and English');
  assert.equal(styled.lora_key, 'ace-loras/soul-real-v1');
  assert.equal(styled.lora_scale, 1);
  assert.equal(styled.vocal_language, 'en');
  assert.equal(styled.model, 'xl-sft');
});

test('a Style forces Best whatever Quality said, and the dials still work on it', () => {
  for (const quality of [undefined, 'Fast', 'Best', 'fast']) {
    const sent = request({ ...base, band: 'soul', ...(quality === undefined ? {} : { quality }) });
    assert.equal(sent.model, 'xl-sft', String(quality));
  }
  for (const env of [{ ...ON, ACE_DEFAULT_MODEL: 'xl-turbo' }, { ...ON, ACE_DEFAULT_MODEL: 'xl-sft' }])
    assert.equal(request({ ...base, band: 'soul' }, env).model, 'xl-sft');
  assert.equal(ace.aceProjectOptions(ace.aceInput({ ...base, band: 'soul', quality: 'Fast' }, ON)).quality, 'Best', 'the project says what was really made');
  /* Prompt guidance reaches a styled take even when Quality said Fast, since the take is Best. */
  const guided = request({ ...base, band: 'soul', quality: 'Fast', guidance: 2, weirdness: 70 });
  assert.deepEqual(Object.keys(guided), ['model', 'caption', 'lyrics', 'duration', 'seed', 'batch_size', 'bpm', 'lm_temperature', 'guidance_scale', 'lora_key', 'lora_scale', 'vocal_language']);
  assert.equal(guided.guidance_scale, 10);
  assert.equal(guided.lm_temperature, 1.03);
  assert.doesNotMatch(ace.aceEstimate(ace.aceInput({ ...base, band: 'soul', guidance: 2 }, ON)), /Prompt guidance only works/);
  /* A job that says it has an adapter is Best even if the job itself forgot to say so. */
  const odd = { ...ace.aceInput({ ...base, band: 'soul' }, ON), model: 'xl-turbo' };
  assert.equal(ace.aceRequest(odd).model, 'xl-sft');
  assert.equal(ace.aceProjectOptions(odd).quality, 'Best');
  assert.match(ace.aceEstimate(odd), /best quality/);
});

test('Style strength: scaled by the registry, 0 is a plain take, and the registry\'s scale is respected', () => {
  const full = request({ ...base, band: 'soul', style_strength: 1 });
  assert.equal(full.lora_scale, 1);
  const half = request({ ...base, band: 'soul', style_strength: 0.5 });
  assert.equal(half.lora_scale, 0.5);
  /* Strength 0 is the same request as Style None: no adapter, no Best, no English. */
  const zero = ace.aceInput({ ...base, band: 'soul', style_strength: 0 }, ON);
  assert.equal(JSON.stringify(ace.aceRequest(zero)), BEFORE_THE_STYLES[0][1]);
  assert.equal(zero.model, 'xl-turbo', 'Fast stays Fast');
  assert.equal(request({ ...base, band: 'soul', style_strength: 0, quality: 'Best' }).model, 'xl-sft');
  assert.deepEqual([zero.band, zero.style_strength, 'lora_key' in zero], ['soul', 0, false], 'but it remembers what she set');
  assert.equal(ace.aceTakeNote({ url: 'x' }, zero), '', 'a plain take has no style note');
  /* A registry row with another scale multiplies and rounds. */
  const row = ace.aceStyles.soul;
  const saved = row.scale;
  try {
    row.scale = 0.7;
    assert.equal(request({ ...base, band: 'soul', style_strength: 0.3 }).lora_scale, 0.21);
    for (const [strength, scale] of [[0.1, 0.07], [0.2, 0.14], [0.4, 0.28], [0.7, 0.49], [0.8, 0.56]])
      assert.equal(request({ ...base, band: 'soul', style_strength: strength }).lora_scale, scale, `0.7 x ${strength} has no floating-point tail (0.7 x ${strength} is ${0.7 * strength} unrounded)`);
    assert.equal(request({ ...base, band: 'soul' }).lora_scale, 0.7);
    row.scale = 1.5;
    assert.equal(request({ ...base, band: 'soul' }).lora_scale, 1.5);
  } finally {
    row.scale = saved;
  }
});

test('every refusal is one plain sentence, in YuE2\'s words where YuE2 has the same one', () => {
  const UNAVAILABLE = 'That trained style is not available. Choose None or another style.';
  const STRENGTH = 'Style strength must be from 0 to 1.';
  const SINGING = 'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.';
  assert.equal(yueSays({ band: 'nonsense' }), UNAVAILABLE, 'YuE2 says the same');
  assert.equal(yueSays({ band: 'soul', style_strength: 2 }), STRENGTH, 'YuE2 says the same');
  assert.equal(yueSays({ band: 'soul', singing: INSTRUMENTAL, lyrics: '' }, { YUE_COVERS_V2: '1' }), SINGING, 'YuE2 says the same');
  for (const band of ['kids', 'Soul', 'SOUL', ' soul', 'soul ', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 5, true, ['soul'], {}, 'none ', 'None'])
    refusal({ ...base, band }, UNAVAILABLE);
  for (const style_strength of [-0.1, 1.1, 2, NaN, Infinity, -Infinity, '0.5', true, [], {}]) {
    refusal({ ...base, band: 'soul', style_strength }, STRENGTH);
    refusal({ ...base, style_strength }, STRENGTH);
  }
  for (const style_strength of [0, 0.1, 0.5, 0.99, 1]) assert.equal(ace.aceInput({ ...base, band: 'soul', style_strength }, ON).style_strength, style_strength);
  refusal({ script: 'Banjo', singing: INSTRUMENTAL, band: 'soul', seed: 1 }, SINGING);
  refusal({ script: 'Banjo', singing: true, band: 'soul', seed: 1 }, SINGING);
  assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, band: 'none', seed: 1 }, ON).instrumental, true, 'None: an instrumental as ever');
  assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, band: 'soul', style_strength: 0, seed: 1 }, ON).instrumental, true, 'strength 0 is no style');
  /* The order a person meets them in: the earlier refusals first, then the Style, then Quality. */
  refusal({ ...base, lyrics: '', band: 'soul' }, 'Add the words to sing in Lyrics, or choose Instrumental under Singing or instrumental.');
  refusal({ ...base, band: 'nonsense', style_strength: 5 }, UNAVAILABLE);
  refusal({ ...base, band: 'soul', quality: 'Great' }, 'Under Quality, choose Fast or Best.');
  refusal({ ...base, band: 'soul', length: '9:00' }, 'Choose a length up to 6:00.');
  for (const sentence of [UNAVAILABLE, STRENGTH, SINGING]) assert.doesNotMatch(sentence, PERSON_OR_FOLDER);
});

/* ---------- the project, the quote, the library line ---------- */

test('Open in the booth: the project remembers Style and strength, and the card puts them back', () => {
  const input = ace.aceInput({ ...base, band: 'soul', style_strength: 0.6, quality: 'Fast', weirdness: 70, length: '3:00' }, ON);
  const options = ace.aceProjectOptions(input);
  assert.deepEqual(options, { quality: 'Best', length: '3:00', singing: SUNG, lyrics: LYRICS, weirdness: 70, guidance: 1, seed: 7, band: 'soul', style_strength: 0.6 });
  const card = new Set(ace.aceGuide(ON, true).settings.map((s) => s.key));
  for (const key of Object.keys(options)) assert.ok(card.has(key), `${key} is a setting on the card, so the page puts it back`);
  const reopened = ace.aceInput({ script: input.style, ...JSON.parse(JSON.stringify(options)) }, ON);
  assert.deepEqual(ace.aceRequest(reopened), ace.aceRequest(input), 'sent again from the reopened card, the very same request');
  assert.equal(ace.aceProjectWhy(options), 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
  /* A Style at the default strength is remembered without a strength; None remembers neither. */
  assert.deepEqual(ace.aceProjectOptions(ace.aceInput({ ...base, band: 'soul' }, ON)), { ...ace.aceProjectOptions(ace.aceInput(base, {})), quality: 'Best', band: 'soul' });
  assert.equal('band' in ace.aceProjectOptions(ace.aceInput({ ...base, band: 'none' }, ON)), false);
  /* An older project, saved before styles, reads as it always did. */
  assert.equal(ace.aceProjectWhy({ quality: 'Best', singing: SUNG }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality');
  assert.equal(ace.aceProjectWhy(undefined), 'ACE-Step XL — a song made on the sleeping music GPU');
});

test('the library line says the style only when one was really used', () => {
  const why = (options) => ace.aceProjectWhy({ quality: 'Best', singing: SUNG, ...options });
  assert.equal(why({ band: 'soul' }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
  assert.equal(why({ band: 'soul', style_strength: 0.5 }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality, in the Soul style');
  assert.equal(why({ band: 'soul', style_strength: 0 }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality', 'strength 0 is a plain take');
  for (const band of ['none', '', 'kids', undefined, 5, 'constructor']) assert.equal(why({ band }), 'ACE-Step XL — a song made on the sleeping music GPU, best quality', String(band));
  assert.equal(ace.aceProjectWhy({ singing: INSTRUMENTAL, band: 'soul' }), 'ACE-Step XL — an instrumental made on the sleeping music GPU, in the Soul style', 'defensive: the line follows the saved options');
});

test('the quote names the style, the quality it forces, and the cost, before anything is spent', () => {
  const quote = ace.aceEstimate(ace.aceInput({ ...base, band: 'soul' }, ON));
  assert.equal(quote, `About 30 seconds of music in the Soul style, which always uses best quality. ${ace.aceCost}`);
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: 'soul', quality: 'Best', length: '3:00' }, ON)), `About 3 minutes of music in the Soul style, which always uses best quality. ${ace.aceCost}`);
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: 'soul', style_strength: 0 }, ON)), `About 30 seconds of music, fast quality. Style strength is 0, so the Soul style is not used. ${ace.aceCost}`);
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, band: 'none' }, ON)), `About 30 seconds of music, fast quality. ${ace.aceCost}`);
  const cut = ace.aceEstimate(ace.aceInput({ ...base, band: 'soul', script: `Soul ${'warm '.repeat(150)}` }, ON));
  assert.match(cut, /in the Soul style, which always uses best quality\. Only the first part of Music direction fits; ACE-Step XL reads 512 characters\./);
  for (const said of [quote, cut]) assert.doesNotMatch(said, PERSON_OR_FOLDER, said);
  assert.ok(quote.endsWith(ace.aceCost), 'the cost line is still said, and still true: Best uses more');
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

test('a styled worker answer parses: take 0, the style it applied, and one plain sentence for the library', () => {
  const input = ace.aceInput({ ...base, band: 'soul', style_strength: 0.7 }, ON);
  assert.equal(ace.aceOutput(STYLED_ANSWER), STYLED_ANSWER, 'take 0 is already at the top level');
  const { key: _k, wav_key: _w, url: _u, wav_url: _wu, duration_s: _d, bytes: _b, seed: _s, ...listed } = STYLED_ANSWER;
  const lifted = ace.aceOutput(listed);
  assert.equal(lifted.url, STYLED_ANSWER.url);
  assert.deepEqual(lifted.style, STYLED_ANSWER.style, 'lifting the first take keeps the style report');
  assert.deepEqual(ace.aceTakeFacts(STYLED_ANSWER, input), {
    gpu: 'NVIDIA RTX A6000', model: 'xl-sft', bpm: 88, keyscale: 'A minor', weirdness: 50, guidance: 1,
    band: 'soul', style_strength: 0.7, lora_key: 'ace-loras/soul-real-v1', lora_scale: 0.7,
    style: { key: 'ace-loras/soul-real-v1', name: 'Soul', scale: 1, tag: 'x-tag', sha256: 'f'.repeat(64) },
    takeNote: 'Made in the Soul style at strength 0.7.',
  });
  assert.equal(ace.aceTakeNote(STYLED_ANSWER, ace.aceInput({ ...base, band: 'soul' }, ON)), 'Made in the Soul style.', 'at the full strength nothing more is said');
  assert.equal(ace.aceTakeNote(STYLED_ANSWER, ace.aceInput({ ...base, band: 'soul', style_strength: 1 }, ON)), 'Made in the Soul style.');
  const worded = ace.aceTakeNote(STYLED_ANSWER, input);
  assert.doesNotMatch(worded, PERSON_OR_FOLDER);
});

test('a styled take the worker did not confirm says so, and nothing the worker says is trusted blindly', () => {
  const input = ace.aceInput({ ...base, band: 'soul' }, ON);
  const NOT = 'The Soul style was not confirmed for this take, so it may sound like plain ACE-Step XL.';
  const { style: _style, ...plainAnswer } = STYLED_ANSWER;
  assert.equal(ace.aceTakeNote(plainAnswer, input), NOT, 'no style in the answer');
  assert.equal(ace.aceTakeNote({ ...STYLED_ANSWER, style: {} }, input), NOT, 'an empty report');
  assert.equal(ace.aceTakeNote({ ...STYLED_ANSWER, style: 'Soul' }, input), NOT, 'a report that is not an object');
  assert.equal(ace.aceTakeNote({ ...STYLED_ANSWER, style: { scale: Infinity, name: 7, key: null } }, input), NOT, 'nothing usable in it');
  assert.equal(ace.aceTakeNote({ ...STYLED_ANSWER, style: { ...STYLED_ANSWER.style, key: 'ace-loras/another-v1' } }, input), NOT, 'another adapter than the one asked for');
  assert.equal(ace.aceTakeNote(undefined, input), '');
  const facts = ace.aceTakeFacts({ ...STYLED_ANSWER, style: { name: 'Soul', scale: NaN, tag: 3, extra: 'ignored' } }, input);
  assert.deepEqual(facts.style, { name: 'Soul' }, 'only fields of the right kind are kept');
  assert.equal(ace.aceTakeFacts(plainAnswer, input).style, undefined);
  assert.equal(ace.aceTakeFacts(plainAnswer, input).takeNote, NOT, 'the library line is the honest one');
  assert.equal(ace.aceTakeFacts(plainAnswer, input).lora_key, 'ace-loras/soul-real-v1', 'what was asked for is still recorded');
  /* The answer to a plain take is read exactly as it was, even from a worker that now sends a style field. */
  const plain = ace.aceInput(base, ON);
  assert.equal('style' in ace.aceTakeFacts(STYLED_ANSWER, plain), false);
  assert.equal(ace.aceTakeNote(STYLED_ANSWER, plain), '');
});

/* ---------- the card ---------- */

test('the card with styles on: Style after Quality, Style strength under More settings, the YuE2 card\'s keys and ranges', () => {
  const live = ace.aceGuide(ON, true);
  assert.deepEqual(live.settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'band', 'style_strength', 'length', 'weirdness', 'guidance', 'seed']);
  assert.deepEqual(live.settings.filter((s) => s.advanced).map((s) => s.key), ['style_strength', 'weirdness', 'guidance', 'seed']);
  const [band, strength] = [live.settings[3], live.settings[4]];
  assert.deepEqual(band, { key: 'band', label: 'Style', hint: ace.aceStyleHint, kind: 'choice', options: ['none', 'soul'], default: 'none' });
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
  /* The rest of the card is the card it was. */
  const was = ace.aceGuide({}, true);
  const { settings: _a, ...liveRest } = live;
  const { settings: _b, ...wasRest } = was;
  assert.deepEqual(liveRest, wasRest, 'tagline, cost, how to write: untouched');
  for (const key of ['lyrics', 'length', 'weirdness', 'guidance', 'seed'])
    assert.deepEqual(live.settings.find((s) => s.key === key), was.settings.find((s) => s.key === key), key);
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
    assert.deepEqual(outside.settings.find((s) => s.key === 'band').options, ['none', 'soul']);
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
    { key: 'band', label: 'Style', hint: ace.aceStyleHint, kind: 'choice', options: ['none', 'soul'], default: 'none' },
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

test('carry, ACE-Step XL to YuE2: the style name does not come across, and it says so', () => {
  for (const helpers of [{ ace: true, aceStyles: true }, { ace: true }]) {
    const out = carry.carryOver(aceSoul(), 'yue2', helpers);
    assert.equal(out.ok, true);
    for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${key} stays behind`);
    assert.equal(out.draft.options.lyrics, LYRICS);
    assert.equal(out.draft.options.seed, 7);
    assert.ok(out.notes.includes('YuE2 has its own Style choice, taught separately from ACE-Step XL\'s, so the ACE-Step XL style was left behind. Choose Style on the YuE2 card to use one.'), out.notes.join(' | '));
    assert.doesNotMatch(out.notes.join(' '), /quality choice/, 'Best was the style\'s doing, and the style is already said');
    assert.equal(out.draft.script, 'Slow soul, Rhodes', 'no trigger word is written into her words');
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
  for (const project of [plainAce, noneAce]) for (const to of ['yue2', 'lyria']) {
    const out = carry.carryOver(project, to, { ace: true, aceStyles: true });
    assert.doesNotMatch(out.notes.join(' '), /[Ss]tyle/, `${to}: ${out.notes.join(' | ')}`);
  }
  assert.ok(carry.carryOver(zero, 'yue2', { ace: true, aceStyles: true }).notes.some((n) => /ACE-Step XL style was left behind/.test(n)), 'what was set is said, even at strength 0');
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
});

test('the booth never writes the trigger word: not in a request, a quote, a project, a card or a note', () => {
  const input = ace.aceInput({ ...base, band: 'soul', style_strength: 0.8 }, ON);
  const everything = [ace.aceRequest(input), ace.aceEstimate(input), ace.aceProjectOptions(input), ace.aceProjectWhy(ace.aceProjectOptions(input)), ace.aceGuide(ON, true), ace.aceGuide(ON, false), ace.aceTakeNote(STYLED_ANSWER, input), input];
  assert.doesNotMatch(JSON.stringify(everything), /kdsoulr|kdsona|kdkids/i);
  assert.doesNotMatch(JSON.stringify(everything), /Kade|Holly|AudioCaptures|Desktop/);
});
