'use strict';
/* Part 295 (Sep 27 2026): the Sound Booth's Style choice (trained YuE2 styles).
 *
 * Soul is now the composer LoRA taught from real soul and R&B records (trigger kdsoulr, step
 * 1000), chosen by ear in a blind test over the AI-trained sonauto style, whose file stays in the
 * bucket for rollback. It was taught from commercial records, so the whole Style choice is part
 * of the Family feature pack: greyed out, never hidden, for everyone outside the pack (the App
 * Review seats included), and refused by the server with plain words when an older client still
 * sends one. Her rule holds too: booth words name no person and no private folder.
 *
 * Oct 11 2026: Sona is back on the menu as the fourth style, on a retrained file (yue2-loras/sona-step800.pt, taught from
 * female-lead pop songs made with Sonauto). The September file (soul-sona1800.pt) is never used again; its lead is only
 * recognised so an older saved song still opens. It sits behind the same Family feature pack gate as every row.
 *
 * Proven here: the style rows and their lead sentences (the training captions' shape), the hint,
 * yueStyleAccess, the pack's new map entry and refusal, the real booth route (kadeSoundBooth.js
 * loaded with stand-ins for the database, the upload parser and the YuE2 router) greying the
 * guide per person and refusing or passing /render, and the web page's locked choice.
 *
 * Run from the repo root: node api/server/routes/soundBoothStyle.selftest.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
const compile = (mod, filename) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
require.extensions['.ts'] = compile;
function loadTs(relative) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  compile(mod, filename);
  return mod.exports;
}
const yue = loadTs('packages/api/src/music/yue.ts');
const pack = loadTs('packages/api/src/family/pack.ts');
const link = require('./kadeSoundBoothLink');

/* "Sonauto" is not here any more: like Suno it is a public product's name, and the Sona clause of the Style hint says what that style was
 * taught from. It is allowed in that one clause and nowhere else (the hint test below counts it). Everything that names a person or a
 * private folder is still refused. */
const PERSON_OR_FOLDER = /Kade|Holly|your own folders|AudioCaptures|MUSIC GROUP|KIDS CHOIR|model training music|Desktop|iCloud/i;

function withEnv(values, run) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const out = run();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

/* ---------------- the style rows ------------------------------------------ */
test('Soul is the real-music composer LoRA; its lead has the training captions\' shape and leaves the singer to Music direction', () => {
  const soul = yue.yueStyles.soul;
  assert.equal(soul.key, 'yue2-loras/soul-real-step1000.pt');
  assert.equal(soul.scale, 1);
  // Training captions: "kdsoulr, in the style of kdsoulr. English, <era> <sub-genre>, <pace>, <female|male> lead vocal, ..."
  assert.match(soul.lead, /^kdsoulr, in the style of kdsoulr\. English, /);
  assert.equal(soul.lead, 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul.');
  assert.doesNotMatch(soul.lead, /\b(fe)?male\b|\bwoman\b|\bman\b|kdsona/i, 'captions named the singer per song, so the lead forces no voice');
  // The worker only folds keys under yue2-loras/ ending .pt, 1-80 safe characters (yue_handler.py STYLE_KEY).
  for (const row of Object.values(yue.yueStyles)) assert.match(row.key, /^yue2-loras\/[A-Za-z0-9._-]{1,80}\.pt$/);
  assert.doesNotMatch(soul.key, /decoder|soundstage/i, 'never a decoder file under yue2-loras/');
});

test('Kids and Soul are unchanged, and the menu is exactly Kids, Soul, Suno and Sona', () => {
  assert.deepEqual(Object.keys(yue.yueStyles), ['kids', 'soul', 'suno', 'sona']);
  assert.deepEqual(yue.yueStyles.kids, {
    key: 'yue2-loras/kids-step1200.pt',
    scale: 1,
    lead: "kdkids, in the style of kdkids. English, children's choir, a group of young voices singing together, bright and clear.",
  });
  assert.deepEqual(yue.yueStyles.soul, {
    key: 'yue2-loras/soul-real-step1000.pt',
    scale: 1,
    lead: 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul.',
  });
});

/* Oct 11 2026: the third style, taught from songs made with Suno (trigger kdsuno). Its checkpoint is the one heard after 600
 * steps; the file (279,028,157 bytes) is in the bucket as yue2-loras/suno-step600.pt. The worker needed no change: a style is
 * one row, and the Family feature pack gates every row at once (the tests below). */
test('Suno is the composer LoRA taught from songs made with Suno; its lead stops at the language and forces no singer', () => {
  const suno = yue.yueStyles.suno;
  assert.deepEqual(suno, {
    key: 'yue2-loras/suno-step600.pt',
    scale: 1,
    lead: 'kdsuno, in the style of kdsuno. English,',
  });
  /* Training captions: "kdsuno, in the style of kdsuno. English, <genre>, <pace>, <female|male|both> lead vocal, ... <N> BPM."
   * (every one of the 370, and the samples that were heard). The lead ends with the comma the captions had after the language, so
   * Music direction carries the caption on; "English." followed by free text is a shape no caption and no sample ever had. */
  assert.match(suno.lead, /^kdsuno, in the style of kdsuno\. English,$/);
  assert.doesNotMatch(suno.lead, /\b(fe)?male\b|\bwoman\b|\bman\b|\bboth\b/i, 'the captions named the singer per song, so the lead forces no voice');
  assert.doesNotMatch(suno.key, /decoder|soundstage/i, 'never a decoder file under yue2-loras/');
  assert.match(suno.key, /^yue2-loras\/[A-Za-z0-9._-]{1,80}\.pt$/, 'the worker folds only keys of this shape');
});

/* Oct 11 2026: the fourth style, Sona, retrained from female-lead pop songs made with Sonauto (trigger kdsona). The checkpoint is the one
 * after 800 steps (279,028,157 bytes, sha256 3004de4b268eeeda...), uploaded as yue2-loras/sona-step800.pt. The worker needed no change: its
 * key pattern is ^yue2-loras/[A-Za-z0-9._-]{1,80}\.pt$. The September file (soul-sona1800.pt) is never used again. */
test('Sona is the retrained composer LoRA; its lead stops at the language and forces no singer, and its key is the new file', () => {
  assert.deepEqual(yue.yueStyles.sona, {
    key: 'yue2-loras/sona-step800.pt',
    scale: 1,
    lead: 'kdsona, in the style of kdsona. English,',
  });
  /* Training captions: "kdsona, in the style of kdsona. English, female lead vocal, <N> BPM." The booth puts the lead first and Music
   * direction carries the caption on, the way it does for Suno. */
  assert.match(yue.yueStyles.sona.lead, /^kdsona, in the style of kdsona\. English,$/);
  assert.doesNotMatch(yue.yueStyles.sona.lead, /\b(fe)?male\b|\bwoman\b|\bman\b|\bboth\b/i, 'the lead forces no voice');
  assert.match(yue.yueStyles.sona.key, /^yue2-loras\/[A-Za-z0-9._-]{1,80}\.pt$/, 'the worker folds only keys of this shape');
  assert.doesNotMatch(yue.yueStyles.sona.key, /decoder|soundstage/i, 'never a decoder file under yue2-loras/');
  /* The September checkpoint stays in storage and must never be sent: no row, and no request, carries its key. */
  for (const row of Object.values(yue.yueStyles)) assert.doesNotMatch(row.key, /sona1800|soul-sona/i, row.key);
  assert.equal(Object.values(yue.yueStyles).filter((row) => /sona/i.test(row.key)).length, 1, 'one Sona file in the registry');
});

test('every style row is one adapter of its own: a safe key, its own trigger twice in its lead, English, no singer, scale in range', () => {
  const rows = Object.entries(yue.yueStyles);
  assert.ok(rows.length >= 4);
  assert.ok(rows.some(([name]) => name === 'sona'), 'Sona is one of the rows checked here');
  const keys = new Set();
  const triggers = new Set();
  for (const [name, row] of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['key', 'lead', 'scale'], name);
    assert.match(row.key, /^yue2-loras\/[A-Za-z0-9._-]{1,80}\.pt$/, name);
    assert.ok(row.key.includes(name), `${name}: the key says whose adapter it is`);
    assert.ok(typeof row.scale === 'number' && row.scale > 0 && row.scale <= 1.5, name);
    const trigger = /^(kd[a-z]+), in the style of \1\. English/.exec(row.lead);
    assert.ok(trigger, `${name}: the lead opens with its own trigger twice, then English`);
    assert.doesNotMatch(row.lead, /\b(fe)?male\b|\bwoman\b|\bman\b/i, name);
    assert.doesNotMatch(row.lead, PERSON_OR_FOLDER, name);
    assert.ok(!keys.has(row.key), `${name}: no two styles share a file`);
    assert.ok(!triggers.has(trigger[1]), `${name}: no two styles share a trigger word`);
    keys.add(row.key);
    triggers.add(trigger[1]);
    for (const [other, otherRow] of rows) {
      if (other !== name) assert.ok(!otherRow.lead.startsWith(row.lead), `${other}'s lead must not start with ${name}'s, or the older-song cleanup would eat it`);
    }
  }
});

test('a Soul song opens with the lead, runs score-free, and asks the worker for the new file', () => {
  withEnv({ YUE_STYLES_ENABLED: '1' }, () => {
    const input = yue.yueInput({ script: 'Slow tempo, female lead vocal, warm electric piano, 72 BPM.', lyrics: '[Verse]\nWords' }, {});
    assert.equal(input.lora_key, undefined, 'no Style, no LoRA');
    const soul = yue.yueInput({ script: 'Slow tempo, female lead vocal, warm electric piano, 72 BPM.', lyrics: '[Verse]\nWords', band: 'soul' }, {});
    assert.equal(soul.style, 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul. Slow tempo, female lead vocal, warm electric piano, 72 BPM.');
    assert.equal(soul.lora_key, 'yue2-loras/soul-real-step1000.pt');
    assert.equal(soul.lora_scale, 1);
    assert.equal(soul.cot, 'off');
    assert.equal(soul.band, 'soul');
  });
});

/* The request each style makes, written out once, in the key order yueInput has always produced. Kids, Soul and None are what the
 * previous commit sent (the same strings were compared byte for byte against that commit); Suno is built on the same pattern. */
const DIRECTION = 'Slow tempo, female lead vocal, warm electric piano, 72 BPM.';
const RECORDING = 'https://assets.test/source.wav';
const COVER_ENV = { YUE_COVERS_V2: '1', YUE_FIT_TEMPO: '1', YUE_FIT_LYRICS: '1', YUE_MEASURE_FIT: '1' };
function expectedRequest(band, { recording = false, covers = false } = {}) {
  const row = band ? yue.yueStyles[band] : undefined;
  return {
    style: `${row ? `${row.lead} ` : ''}${DIRECTION}`,
    title: 'Slow tempo, female lead vocal, warm electric',
    count: 1,
    weirdness: 50,
    steps: 32,
    guidance: 1,
    lyrics: '[Verse]\nWords',
    ...(recording ? { reference_voice_url: RECORDING } : {}),
    cot: row ? (recording ? (covers ? 'full' : 'melody') : 'off') : recording && !covers ? 'melody' : 'full',
    ...(row ? { band, lora_key: row.key, lora_scale: row.scale } : {}),
    seed: 7,
    ...(covers && recording ? { keep_harmony: true, length_guard: true, fit_lyrics: 'timing', measure_fit: true, fit_tempo: true } : {}),
  };
}
const request = (body, env = {}) => withEnv({ YUE_STYLES_ENABLED: '1', ...env }, () => yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7, ...body }, process.env));

test('a Suno song opens with the lead, runs score-free, and asks the worker for its own file', () => {
  const suno = request({ band: 'suno' });
  assert.equal(suno.style, `kdsuno, in the style of kdsuno. English, ${DIRECTION}`);
  assert.equal(suno.lora_key, 'yue2-loras/suno-step600.pt');
  assert.equal(suno.lora_scale, 1);
  assert.equal(suno.cot, 'off');
  assert.equal(suno.band, 'suno');
  assert.equal(JSON.stringify(suno), JSON.stringify(expectedRequest('suno')));
  const half = request({ band: 'suno', style_strength: 0.5 });
  assert.equal(half.lora_scale, 0.5);
  assert.equal(half.style_strength, 0.5);
  assert.match(half.style, /^kdsuno, in the style of kdsuno\. English, Slow tempo/);
  // Her singer choice rides in Music direction, after the lead: nothing in the lead picks a voice.
  const male = request({ band: 'suno', script: 'Mid-tempo, male lead vocal, acoustic guitar, 96 BPM.' });
  assert.equal(male.style, 'kdsuno, in the style of kdsuno. English, Mid-tempo, male lead vocal, acoustic guitar, 96 BPM.');
});

/* The Sona request written out as literals (not read back from the registry), so a wrong key, scale or lead in the registry fails here. */
const SONA_LEAD = 'kdsona, in the style of kdsona. English,';
const occurrences = (text, part) => text.split(part).length - 1;
test('a Sona song carries the new file, a scale of strength x 1, and the lead exactly once', () => {
  const sona = request({ band: 'sona' });
  assert.deepEqual(JSON.parse(JSON.stringify(sona)), {
    style: `${SONA_LEAD} ${DIRECTION}`,
    title: 'Slow tempo, female lead vocal, warm electric',
    count: 1,
    weirdness: 50,
    steps: 32,
    guidance: 1,
    lyrics: '[Verse]\nWords',
    cot: 'off',
    band: 'sona',
    lora_key: 'yue2-loras/sona-step800.pt',
    lora_scale: 1,
    seed: 7,
  });
  assert.equal(JSON.stringify(sona), JSON.stringify(expectedRequest('sona')), 'the same key order as every other style');
  assert.equal(occurrences(sona.style, SONA_LEAD), 1, 'the lead is there once');
  assert.equal(occurrences(sona.style, 'kdsona'), 2, 'its trigger word is in the lead twice and nowhere else');
  assert.ok(sona.style.startsWith(`${SONA_LEAD} `), 'the lead opens the caption, the way the training captions did');
  assert.equal(JSON.stringify(sona).includes('sona1800'), false, 'the September file is never sent');
  // Strength scales the adapter: scale = strength x the row's 1.
  for (const style_strength of [1, 0.9, 0.5, 0.25, 0.1]) {
    const styled = request({ band: 'sona', style_strength });
    assert.equal(styled.lora_scale, style_strength * 1, `strength ${style_strength}`);
    assert.equal(styled.style_strength, style_strength);
    assert.equal(styled.lora_key, 'yue2-loras/sona-step800.pt');
    assert.equal(occurrences(styled.style, SONA_LEAD), 1, `strength ${style_strength}: one lead`);
  }
  // Strength 0 is plain YuE2: no lead, no file, and the request equals the plain one apart from the Style fields that were named.
  const zero = request({ band: 'sona', style_strength: 0 });
  const plain = request({});
  assert.equal(zero.lora_key, undefined);
  assert.equal(zero.lora_scale, undefined);
  assert.equal(zero.style, plain.style);
  assert.equal(zero.cot, plain.cot);
  // Her own words ride after the lead, whichever voice she names: nothing in the lead picks one.
  for (const script of ['Upbeat pop, 120 BPM, bright synths.', 'Mid-tempo, male lead vocal, acoustic guitar, 96 BPM.', 'female lead vocal, 90 BPM, warm piano']) {
    const own = request({ band: 'sona', script });
    assert.equal(own.style, `${SONA_LEAD} ${script}`);
    assert.equal(occurrences(own.style, SONA_LEAD), 1);
  }
  // A Sona cover keeps the official recipe like every style: chords kept, the file in the request, the lead once.
  const cover = request({ band: 'sona', reference_voice_url: RECORDING }, COVER_ENV);
  assert.equal(cover.lora_key, 'yue2-loras/sona-step800.pt');
  assert.equal(cover.lora_scale, 1);
  assert.equal(cover.cot, 'full');
  assert.equal(cover.keep_harmony, true);
  assert.equal(occurrences(cover.style, SONA_LEAD), 1);
});

test('None makes the request the previous commit made, and so do Kids and Soul; each style differs from plain only in its own fields', () => {
  for (const shape of [{}, { recording: true }, { recording: true, covers: true }]) {
    const env = shape.covers ? COVER_ENV : {};
    const body = shape.recording ? { reference_voice_url: RECORDING } : {};
    // Style None, in every spelling the page and the phone send it.
    for (const none of [{}, { band: 'none' }, { band: '' }, { band: 'none', style_strength: undefined }]) {
      assert.equal(JSON.stringify(request({ ...body, ...none }, env)), JSON.stringify(expectedRequest(undefined, shape)), JSON.stringify([shape, none]));
    }
    const plain = request(body, env);
    for (const band of Object.keys(yue.yueStyles)) {
      const styled = request({ ...body, band }, env);
      assert.equal(JSON.stringify(styled), JSON.stringify(expectedRequest(band, shape)), `${band} ${JSON.stringify(shape)}`);
      // Everything but the lead on the style, cot (off for a new song), band, lora_key and lora_scale is exactly the plain request.
      const strip = ({ style, cot, band: _b, lora_key, lora_scale, ...rest }) => rest;
      assert.deepEqual(strip(styled), strip(plain), `${band} changes nothing else`);
      assert.equal(styled.style, `${yue.yueStyles[band].lead} ${plain.style}`);
      assert.equal(styled.lora_key, yue.yueStyles[band].key);
      assert.equal(styled.lora_scale, yue.yueStyles[band].scale);
    }
  }
});

/* Oct 11 2026, adding Sona: what the commit before it (the merge of both Suno branches, 2c9dd68) sent for None, Kids, Soul and Suno,
 * as sha256 of the JSON of five requests each: a new song, the same at strength 0.5, a cover with the covers flag off, a cover with
 * every cover flag on, and a score. They were computed on that commit's yue.ts with the same inputs as below, so these strings only
 * change if one of those four requests does. Adding a row to the registry must not move any of them. */
const SENT_BEFORE_SONA = {
  noBand: '15acfffe54729003f25f251baf4acefb13620d56c18467ea9a94380f6ff00d42',
  none: 'b5f2c1aab94bfe202af8e727098aed7e179da858d9d438ed255872e052370f1b',
  kids: '07b9877ee7b2bdd6788930424ca3b2e408ea48130640f377927a6b741c8d855d',
  soul: 'fec6ba1a3bd9aeaca9ac036cb99e34df73103a5761c4064d920c220f511fb15a',
  suno: 'ba865315b7225c992396b5a56c236f96d9b8a53ea94f604ebf69cd43386223f3',
};
const shaOf = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
test('with Sona added, the requests for no Style, None, Kids, Soul and Suno are byte for byte what they were before', () => {
  const ask = (env, body) => JSON.stringify(request(body, env));
  const shapesFor = (band) => [
    ask({}, { band }),
    ask({}, { band, style_strength: 0.5 }),
    ask({}, { band, reference_voice_url: RECORDING }),
    ask(COVER_ENV, { band, reference_voice_url: RECORDING }),
    ask({ YUE_COVERS_V2: '1' }, { band, abc: 'X:1', lyrics: 'la' }),
  ];
  for (const band of ['none', 'kids', 'soul', 'suno']) assert.equal(shaOf(JSON.stringify(shapesFor(band))), SENT_BEFORE_SONA[band], `${band}: the requests are the base's`);
  assert.equal(shaOf(JSON.stringify([ask({}, {}), ask({}, { reference_voice_url: RECORDING }), ask(COVER_ENV, { reference_voice_url: RECORDING })])), SENT_BEFORE_SONA.noBand, 'no Style at all: the base\'s requests');
  // The check can fail: a Sona request is not any of them, and a changed Kids row would move its hash.
  assert.notEqual(shaOf(JSON.stringify(shapesFor('sona'))), SENT_BEFORE_SONA.suno);
});

test('covers and instrumentals treat Suno exactly as they treat Kids and Soul', () => {
  const COVER = { reference_voice_url: RECORDING };
  const SINGING = 'Instrumental, no singing';
  const REFUSAL = 'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.';
  for (const band of Object.keys(yue.yueStyles)) {
    // The official cover recipe and fit-by-tempo come through untouched: chords kept, the length guard, the tempo fit, the lyric sync.
    const cover = request({ band, ...COVER }, COVER_ENV);
    assert.equal(cover.cot, 'full', band);
    assert.equal(cover.keep_harmony, true, band);
    assert.equal(cover.fit_tempo, true, `${band}: YUE_FIT_TEMPO still asks the worker to fit a long cover`);
    assert.equal(cover.length_guard, true, band);
    assert.equal(cover.fit_lyrics, 'timing', band);
    assert.equal(cover.lora_key, yue.yueStyles[band].key, band);
    const cut = request({ band, ...COVER, keep_chords: 'No: a new accompaniment that fits my style' }, COVER_ENV);
    assert.equal(cut.cot, 'melody', band);
    assert.equal(cut.keep_harmony, false, band);
    // With the cover flags off a cover is melody only, as for every style.
    assert.equal(request({ band, ...COVER }).cot, 'melody', band);
    assert.equal('fit_tempo' in request({ band, ...COVER }), false, `${band}: no tempo field with YUE_FIT_TEMPO off`);
    // A score keeps the chords answer it was given.
    assert.equal(request({ band, abc: 'X:1', lyrics: 'la' }, { YUE_COVERS_V2: '1' }).cot, 'full', band);
    // An instrumental with a style is refused with one sentence, for every style, in both flag states.
    for (const env of [COVER_ENV, { YUE_COVERS_V2: '1' }]) {
      assert.throws(() => request({ band, lyrics: '', singing: SINGING }, env), { message: REFUSAL }, band);
      assert.throws(() => request({ band, lyrics: '[Verse]\nla', singing: true }, env), { message: REFUSAL }, band);
    }
    // A style at strength 0 is plain YuE2, so an instrumental is not refused then.
    assert.equal(request({ band, style_strength: 0, lyrics: '', singing: SINGING }, { YUE_COVERS_V2: '1' }).instrumental, true, band);
    // Without the covers flag the instrumental choice is not read at all, as before.
    assert.throws(() => request({ band, lyrics: '', singing: SINGING }), { message: 'Add the words to sing in Lyrics, up to 8000 characters.' }, band);
    // The rest of the styled-song rules are the same.
    assert.throws(() => request({ band, style_strength: 1.5 }), { message: 'Style strength must be from 0 to 1.' }, band);
    assert.equal(request({ band, my_voice: true }).my_voice, true, `${band}: Sing it in my voice rides along as before`);
  }
  // Plain YuE2 instrumentals are still allowed.
  assert.equal(request({ lyrics: '', singing: SINGING }, { YUE_COVERS_V2: '1' }).instrumental, true);
});

test('with the Style choice switched off, every style, Suno included, gets the one plain refusal and nothing else changes', () => {
  for (const band of [...Object.keys(yue.yueStyles), 'something-else']) {
    assert.throws(
      () => withEnv({ YUE_STYLES_ENABLED: undefined }, () => yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7, band }, {})),
      { message: 'That trained style is not available. Choose None or another style.' },
      band,
    );
  }
  for (const flag of [undefined, '0', 'true', '']) {
    assert.throws(
      () => withEnv({ YUE_STYLES_ENABLED: flag }, () => yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', band: 'suno' }, {})),
      /That trained style is not available/,
      `YUE_STYLES_ENABLED=${flag} only '1' turns styles on`,
    );
  }
  const off = withEnv({ YUE_STYLES_ENABLED: undefined }, () => yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7, band: 'none' }, {}));
  assert.equal(JSON.stringify(off), JSON.stringify(expectedRequest(undefined)), 'with styles off a plain song is the previous commit\'s request');
});

test('a band that is only a name every object has (constructor, toString, __proto__ ...) is not a style, and is refused like any unknown one', () => {
  withEnv({ YUE_STYLES_ENABLED: '1' }, () => {
    const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__', '__defineGetter__', '__lookupGetter__', 'a-style-that-was-removed'];
    for (const band of names) {
      assert.throws(
        () => yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7, band }, {}),
        { message: 'That trained style is not available. Choose None or another style.' },
        band,
      );
    }
    // The lookup refuses the inherited names only: every real style on the menu still goes through.
    for (const band of Object.keys(yue.yueStyles)) {
      assert.equal(yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7, band }, {}).band, band);
    }
  });
});

test('style strength reaches the worker and zero makes the same request as plain YuE2', () => {
  withEnv({ YUE_STYLES_ENABLED: '1' }, () => {
    const song = { script: 'Warm soul, female lead, 80 BPM.', lyrics: '[verse]\nCarry these words home', band: 'soul', seed: 123 };
    const softer = yue.yueInput({ ...song, style_strength: .5 }, {});
    assert.equal(softer.lora_scale, .5);
    assert.equal(softer.style_strength, .5);
    assert.equal(softer.cot, 'off');
    assert.match(softer.style, /^kdsoulr/);
    const off = yue.yueInput({ ...song, style_strength: 0 }, {});
    const plain = yue.yueInput({ ...song, band: 'none' }, {});
    assert.equal(off.style_strength, 0);
    for (const key of ['style', 'lyrics', 'cot', 'lora_key', 'lora_scale', 'seed']) {
      assert.equal(off[key], plain[key], key);
    }
    for (const style_strength of [-.1, 1.1, NaN, Infinity, '0.5', true]) {
      assert.throws(() => yue.yueInput({ ...song, style_strength }, {}), /Style strength/);
    }
    const cover = yue.yueInput({ ...song, style_strength: .5, reference_voice_url: 'https://audio.test/song.wav' }, {});
    assert.equal(cover.lora_scale, .5);
    assert.equal(cover.cot, 'melody');
  });
});

test('style strength shares the trained-style access lock', () => {
  const settings = [{ key: 'band', hint: yue.yueStyleHint }, { key: 'style_strength', hint: 'Strength' }];
  const locked = yue.yueStyleAccess(settings, false, pack.FAMILY_PACK_NOTE);
  assert.equal(locked[0].locked, pack.FAMILY_PACK_NOTE);
  assert.equal(locked[1].locked, pack.FAMILY_PACK_NOTE);
});

test('reopening a styled song never accumulates training triggers or keeps one when style is off', () => {
  withEnv({ YUE_STYLES_ENABLED: '1' }, () => {
    const song = { script: 'Female lead, warm piano, 80 BPM.', lyrics: '[verse]\nCarry these words home', band: 'soul' };
    const first = yue.yueInput(song, {});
    const reopened = yue.yueInput({ ...song, script: first.style }, {});
    assert.equal(reopened.style, first.style);
    assert.equal(reopened.title, first.title);
    const repeated = `${yue.yueStyles.soul.lead} ${yue.yueStyles.kids.lead} ${first.style}`;
    assert.equal(yue.yueInput({ ...song, script: repeated }, {}).style, first.style);
    assert.equal(yue.yueInput({ ...song, script: repeated, style_strength: 0 }, {}).style, song.script);
    assert.equal(yue.yueInput({ ...song, script: repeated, band: 'none' }, {}).style, song.script);
    assert.equal(yue.yueMusicDirection(first.style), song.script);
    assert.equal(yue.yueMusicDirection('A singer describes kdsoulr in the middle.'), 'A singer describes kdsoulr in the middle.');
  });
});

test('reopening a styled song never accumulates triggers for any style, Suno included, and older songs lose every lead', () => {
  withEnv({ YUE_STYLES_ENABLED: '1' }, () => {
    const direction = 'Mid-tempo, male lead vocal, acoustic guitar, 96 BPM.';
    const everyLead = Object.values(yue.yueStyles).map((row) => row.lead);
    for (const band of Object.keys(yue.yueStyles)) {
      const lead = yue.yueStyles[band].lead;
      const song = { script: direction, lyrics: '[verse]\nCarry these words home', band };
      const first = yue.yueInput(song, {});
      assert.equal(first.style, `${lead} ${direction}`, band);
      // Opening the saved song and rendering again puts the trigger in front once, not twice.
      assert.equal(yue.yueInput({ ...song, script: first.style }, {}).style, first.style, band);
      assert.equal(yue.yueInput({ ...song, script: `${lead} ${lead} ${first.style}` }, {}).style, first.style, band);
      // Every lead at once, in any order, is taken off an older saved song.
      assert.equal(yue.yueMusicDirection(`${everyLead.join(' ')} ${direction}`), direction, band);
      assert.equal(yue.yueMusicDirection([...everyLead].reverse().join(' ') + ` ${direction}`), direction, band);
      assert.equal(yue.yueMusicDirection(lead), '', `${band}: the lead alone`);
      assert.equal(yue.yueMusicDirection(`${lead} ${direction}`), direction, band);
      // With Style off or at strength 0 the saved lead is still removed, so the song renders plain.
      assert.equal(yue.yueInput({ ...song, script: first.style, band: 'none' }, {}).style, direction, band);
      assert.equal(yue.yueInput({ ...song, script: first.style, style_strength: 0 }, {}).style, direction, band);
      // The trigger word in the middle of her own words is her words.
      const trigger = /^(kd[a-z]+),/.exec(lead)[1];
      assert.equal(yue.yueMusicDirection(`A singer describes ${trigger} in the middle.`), `A singer describes ${trigger} in the middle.`, band);
      assert.equal(yue.yueMusicDirection(`Warm piano. ${lead} Slow.`), `Warm piano. ${lead} Slow.`, `${band}: a lead that is not at the front is not removed`);
    }
    // A song saved in the Sonauto-era style (the September Sona, retired) still loses its trigger.
    assert.equal(yue.yueMusicDirection('kdsona, in the style of kdsona. English, female lead vocal. Warm piano.'), 'Warm piano.');
  });
});

/* Sona is back, and its lead is the FRONT of the September Sona's lead ("... English," then " female lead vocal."). Both are leads the
 * cleanup must take off whole, in any mix, once each time and never half: tried shortest first, the retired lead would leave
 * "female lead vocal." in front of an older song's words. */
test('the current Sona lead and the retired September Sona lead both come off whole, singly, doubled and mixed, and no word is lost', () => {
  const retired = 'kdsona, in the style of kdsona. English, female lead vocal.';
  const sona = yue.yueStyles.sona.lead;
  assert.ok(retired.startsWith(`${sona} `), 'the trap this test guards: one lead is the front of the other');
  const direction = 'Warm piano, soft drums, 80 BPM.';
  const others = Object.entries(yue.yueStyles).filter(([name]) => name !== 'sona').map(([, row]) => row.lead);
  const all = [retired, sona, ...others];
  for (const [label, front] of [
    ['the current lead', sona],
    ['the retired lead', retired],
    ['the current lead twice', `${sona} ${sona}`],
    ['the retired lead twice', `${retired} ${retired}`],
    ['current then retired', `${sona} ${retired}`],
    ['retired then current', `${retired} ${sona}`],
    ['every lead in a row', all.join(' ')],
    ['every lead, reversed', [...all].reverse().join(' ')],
    ['retired between two others', `${others[0]} ${retired} ${others[1]}`],
  ]) {
    assert.equal(yue.yueMusicDirection(`${front} ${direction}`), direction, label);
    assert.equal(yue.yueMusicDirection(front), '', `${label}: the leads alone leave nothing`);
    assert.equal(yue.yueMusicDirection(`  ${front}   ${direction}  `), direction, `${label}: stray spaces`);
  }
  // Whatever follows the current lead is her caption and stays: the words the training captions continue with are hers to type.
  for (const words of ['female lead vocal, 90 BPM, warm piano', 'female lead vocal and bright synths', 'Female lead vocal. Warm piano.', 'male lead vocal. Warm piano.', 'pop, female lead vocal']) {
    assert.equal(yue.yueMusicDirection(`${sona} ${words}`), words, words);
    assert.equal(yue.yueMusicDirection(`${sona} ${sona} ${words}`), words, `twice: ${words}`);
  }
  // A lead that is only the start of a longer word is not a lead (the current lead is still the front of the second text, and comes off).
  assert.equal(yue.yueMusicDirection(`${sona}x Warm piano.`), `${sona}x Warm piano.`);
  assert.equal(yue.yueMusicDirection(`${retired}x Warm piano.`), 'female lead vocal.x Warm piano.');
  // The words the retired lead ended with are only part of it when the whole lead is there.
  assert.equal(yue.yueMusicDirection('kdsona, in the style of kdsona. English, female lead vocal Warm piano.'), 'female lead vocal Warm piano.');
  // The one text both readings share: the current lead, then her words beginning "female lead vocal." That is exactly what the
  // retired lead looked like, so this search reads it as that lead. The save path does not search (savedDirection in
  // kadeSoundBooth.js; the round trip test below), so the words she typed are kept in what is saved.
  assert.equal(yue.yueMusicDirection(`${sona} female lead vocal. Warm piano.`), 'Warm piano.');
});

/* ---------------- the hint and the lock ----------------------------------- */
test('the Style hint is true now and names no person or folder', () => {
  const hint = yue.yueStyleHint;
  assert.match(hint, /^A singing style taught to YuE2 from recordings: /, 'Suno was taught from songs made with Suno, so not "real recordings"');
  assert.doesNotMatch(hint, /real recordings/);
  assert.match(hint, /Soul from soul and R&B records[,.]/);
  assert.match(hint, /Suno from songs made with Suno[,.]/);
  assert.match(hint, /Sona from female-led pop songs made with Sonauto[,.]/, 'one plain clause: what Sona was taught from, and that its lead singer is a woman');
  assert.match(hint, /Kids from a children’s choir\./);
  assert.match(hint, /For Soul or Suno, write female lead vocal or male lead vocal in Music direction\./);
  assert.doesNotMatch(hint, /clean/i, 'Sep 27 2026: no clean-lyrics rule for the Kids style');
  assert.match(hint, /None is plain YuE2\./);
  /* Four styles in one sentence of clauses: 58 words, under the ceiling the booth keeps ("super wordy and cluttered"). Sona added 8 words
   * (50 before); the ceiling did not need to move. */
  assert.ok(hint.split(/\s+/).length <= 60, `the hint stays short (${hint.split(/\s+/).length} words)`);
  assert.doesNotMatch(hint, /one expressive female lead/, 'the old sonauto description is gone');
  const everyStyleWord = [hint, yue.yueStyleLockedSentence, pack.FAMILY_PACK_STYLES_REFUSAL, ...Object.values(yue.yueStyles).flatMap((row) => [row.lead, row.key])];
  for (const words of everyStyleWord) assert.doesNotMatch(words, PERSON_OR_FOLDER, words);
  /* "Sonauto" is a product's name and the hint may say it, once, in Sona's clause; nothing else the booth shows or sends names it. */
  assert.equal((hint.match(/Sonauto/g) || []).length, 1);
  for (const words of everyStyleWord.filter((w) => w !== hint)) assert.doesNotMatch(words, /sonauto/i, words);
  assert.doesNotMatch(hint, /sona1800|kdsona|\.pt\b/i, 'no trigger word and no file name in what people read');
});

test('the Style hint says what every style on the menu was taught from, once each, and the voice sentence names only styles whose captions named a singer', () => {
  const sentences = yue.yueStyleHint.split(/(?<=\.)\s+/);
  /* The first sentence gives each style one clause, "Soul from soul and R&B records", in registry order. */
  for (const name of Object.keys(yue.yueStyles)) {
    const word = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const own = sentences[0].match(new RegExp(`\\b${word} from [^,.]+`, 'g')) || [];
    assert.equal(own.length, 1, `${name} has exactly one clause of its own in the hint`);
    assert.equal(sentences.slice(1).filter((sentence) => new RegExp(`^${word}\\b`).test(sentence)).length, 0, `${name} is not described a second time`);
  }
  const voice = sentences.filter((sentence) => /lead vocal/.test(sentence));
  assert.equal(voice.length, 1);
  assert.match(voice[0], /\bSoul\b/);
  assert.match(voice[0], /\bSuno\b/);
  assert.doesNotMatch(voice[0], /\bKids\b/, 'the choir style has no single singer to choose');
  assert.doesNotMatch(voice[0], /\bSona\b/, 'every song Sona was taught from has a female lead, so there is no singer to choose; its own clause says so');
  /* The training captions of the Suno style, counted when the set was built: 220 named a female lead, 89 a male lead, 25 both,
   * 36 no singer. The first two are what the sentence promises. */
  assert.match(yue.yueStyles.suno.lead, /^kdsuno, in the style of kdsuno\. English,$/);
});

test('yueStyleAccess: the pack keeps the choice; everyone else sees it greyed out with every option', () => {
  const settings = [
    { key: 'lyrics', label: 'Lyrics', hint: 'Words.', kind: 'text' },
    { key: 'band', label: 'Style', hint: yue.yueStyleHint, kind: 'choice', options: ['none', 'kids', 'soul', 'suno', 'sona'], default: 'none' },
    { key: 'count', label: 'Number of takes', hint: 'One to four.', kind: 'number' },
  ];
  assert.equal(yue.yueStyleAccess(settings, true, pack.FAMILY_PACK_NOTE), settings, 'unchanged with the pack');
  const locked = yue.yueStyleAccess(settings, false, pack.FAMILY_PACK_NOTE);
  assert.notEqual(locked, settings);
  assert.deepEqual(locked.map((s) => s.key), ['lyrics', 'band', 'count'], 'never hidden');
  const band = locked[1];
  assert.equal(band.locked, 'Part of the Family feature pack');
  assert.deepEqual(band.options, ['none', 'kids', 'soul', 'suno', 'sona']);
  assert.equal(band.default, 'none');
  assert.equal(band.hint, yue.yueStyleHint + ' Part of the Family feature pack, so songs on this account use None, plain YuE2.');
  assert.ok(yue.yueStyleLockedSentence.includes(pack.FAMILY_PACK_NOTE), 'the hint carries the pack note for clients that do not read locked');
  assert.equal(locked[0], settings[0]);
  assert.equal(settings[1].locked, undefined, 'the shared settings are never changed');
  const noStyle = settings.filter((s) => s.key !== 'band');
  assert.equal(yue.yueStyleAccess(noStyle, false, pack.FAMILY_PACK_NOTE), noStyle, 'styles switched off: nothing to lock');
});

test('the pack map has trainedStyles, exactly the pack, and the pack note equals the link lane\'s', () => {
  const env = {};
  const admin = { id: '6a3cba4d0b0afa92194e42f7', role: 'ADMIN' };
  const review = { id: '6a6125d73939d20b95251078' }; // the App Review seat
  const early = { id: '6a5fc5fa351af41332734161' }; // an account from before the cutoff
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined, KADE_APP_REVIEW_USER_IDS: undefined }, () => {
    for (const user of [admin, review, early, { id: early.id, kadeLibraryAccess: 'none' }, null]) {
      assert.equal(pack.familyFeatures(user, env).trainedStyles, pack.familyPack(user), JSON.stringify(user));
    }
    assert.equal(pack.familyFeatures(review, env).trainedStyles, false, 'App Review never');
    assert.equal(pack.familyFeatures(admin, env).trainedStyles, true);
  });
  assert.equal(link.PACK_NOTE, pack.FAMILY_PACK_NOTE);
  assert.equal(
    pack.FAMILY_PACK_STYLES_REFUSAL,
    'Trained styles are part of the Family feature pack, and this account does not have it. Set Style to None, then make the music again.',
  );
});

/* ---------------- the real booth route ------------------------------------ */
function stub() {
  return new Proxy(function () {}, {
    get: (_target, key) => (key === '__esModule' ? false : /Router$/.test(String(key)) ? () => express.Router() : stub()),
    apply: () => stub(),
  });
}
function loadBooth(state) {
  const mod = { exports: {} };
  const api = {
    ...yue,
    FAMILY_PACK_STYLES_REFUSAL: pack.FAMILY_PACK_STYLES_REFUSAL,
    familyFeatures: (user) => state.features(user),
    createLyricsRouter: () => express.Router(),
    createEffectsRouter: () => express.Router(),
    /* Stands in for the YuE2 router: it shows what reached it. */
    createYueRouter: (hooks) => {
      state.yueHooks = hooks; // the booth's own project hook, for the round-trip test
      const r = express.Router();
      r.post('/render', express.json(), (req, res, next) => (req.body && req.body.engine === 'yue2' ? res.json({ yueSaw: req.body }) : next()));
      return r;
    },
  };
  const localRequire = (name) => {
    if (name === '@librechat/api') return new Proxy(api, { get: (t, k) => (k in t ? t[k] : undefined) });
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn: (line) => state.warnings.push(line), error() {}, debug() {} } };
    if (name === '~/server/middleware') {
      return { requireJwtAuth: (req, _res, next) => { state.auths += 1; req.user = state.user; next(); } };
    }
    if (name === '~/server/utils/kadeSongAudience') {
      return { ...require(path.join(__dirname, '..', 'utils', 'kadeSongAudience.js')), songAudience: async () => 'explicit' };
    }
    if (['express', 'axios', 'crypto', 'mongoose'].includes(name)) return require(name);
    if (['./kadeSoundBoothLink', './kadeSoundBoothPaste', './kadeSoundBoothScreenplay', './kadeSoundBoothSplit', './kadeSoundBoothCarry', './kadeSoundBoothStitch'].includes(name)) {
      return require(path.join(__dirname, name));
    }
    if (name === '~/models/kadeSoundBoothProject' && state.projects) {
      /* Just a create() that keeps the row, for the round-trip test; everything else on the model is the usual stand-in. */
      const fake = { create: async (doc) => { const row = { _id: `proj${state.projects.length + 1}`, ...doc }; state.projects.push(row); return row; } };
      return { KadeSoundBoothProject: new Proxy(fake, { get: (t, k) => (k in t ? t[k] : stub()) }) };
    }
    return stub(); // multer, the models, the chain, Jev, the key alarm: not what this file tests
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8'), {
    require: localRequire, module: mod, exports: mod.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return mod.exports;
}

/* The YuE2 card of the guide with the Style choice off, as sha256 of its JSON, computed on the commit before Sona was added (2c9dd68)
 * with the same stand-ins as below. With YUE_STYLES_ENABLED unset, '0', 'true' or empty the card is that one, byte for byte. */
const YUE2_CARD_STYLES_OFF_BEFORE_SONA = '3062ce1ba575a5f54d1e8ce4f1d47b98c30647aed92d157b8d4f830d1cdc154a';
test('the booth route with the Style choice switched off: the YuE2 card has neither Style setting for anyone, and nothing else in the guide differs', () => {
  const internals = (flag, trainedStyles) => withEnv({ YUE_STYLES_ENABLED: flag, KADE_SOUNDBOOTH_YT_LINKS: undefined }, () => {
    const state = { user: { id: 'u1' }, features: () => ({ trainedStyles }), warnings: [], auths: 0 };
    return loadBooth(state)._internals;
  });
  const STYLE_SETTINGS = ['band', 'style_strength'];
  const keysOf = (guide) => [...guide.engines.yue2.settings.map((setting) => setting.key)];
  const withoutStyle = (guide) => JSON.stringify({ ...guide, engines: { ...guide.engines, yue2: { ...guide.engines.yue2, settings: guide.engines.yue2.settings.filter((setting) => !STYLE_SETTINGS.includes(setting.key)) } } });
  const on = internals('1', true);
  for (const key of STYLE_SETTINGS) assert.ok(keysOf(on.GUIDE).includes(key), `${key} is on the card with the flag on`);
  // Only '1' turns the choice on: unset, '0', 'true' and an empty value are all off.
  for (const flag of [undefined, '0', 'true', '']) {
    for (const trainedStyles of [true, false]) {
      const off = internals(flag, trainedStyles);
      for (const key of STYLE_SETTINGS) assert.equal(keysOf(off.GUIDE).includes(key), false, `YUE_STYLES_ENABLED=${flag}: no ${key} on the card`);
      assert.equal(JSON.stringify(off.GUIDE), withoutStyle(on.GUIDE), `YUE_STYLES_ENABLED=${flag}: the guide is the flag-on guide minus exactly the two Style settings`);
      assert.equal(shaOf(JSON.stringify(off.GUIDE.engines.yue2)), YUE2_CARD_STYLES_OFF_BEFORE_SONA, `YUE_STYLES_ENABLED=${flag}: the YuE2 card is byte for byte the one from before Sona was added`);
      // Nothing to grey out, so the guide goes out as it is, for a member and a stranger alike.
      for (const user of [{ id: 'family' }, { id: 'bob' }, null]) assert.equal(off.withStyleAccess(off.GUIDE, user), off.GUIDE, `YUE_STYLES_ENABLED=${flag}`);
    }
  }
});

test('the booth route: the guide greys Style out per person, and /render refuses a style outside the pack', async () => {
  await withEnv({ YUE_STYLES_ENABLED: '1', KADE_SOUNDBOOTH_YT_LINKS: undefined }, async () => {
    const state = { user: { id: 'u1' }, features: () => ({ trainedStyles: false }), warnings: [], auths: 0 };
    const booth = loadBooth(state);
    const { GUIDE, withStyleAccess, styleAllowed, asksForStyle } = booth._internals;
    const band = GUIDE.engines.yue2.settings.find((s) => s.key === 'band');
    assert.equal(band.hint, yue.yueStyleHint, 'the guide reads the hint from yue.ts');
    assert.deepEqual([...band.options], ['none', 'kids', 'soul', 'suno', 'sona'], 'the options (a vm array, so spread into this realm)');
    assert.equal(band.locked, undefined, 'the shared GUIDE carries no lock');

    // Per person.
    state.features = () => ({ trainedStyles: true });
    assert.equal(withStyleAccess(GUIDE, { id: 'family' }), GUIDE, 'a family account sees the guide as it is');
    state.features = () => ({ trainedStyles: false });
    const stranger = withStyleAccess(GUIDE, { id: 'bob' });
    const greyed = stranger.engines.yue2.settings.find((s) => s.key === 'band');
    assert.equal(greyed.locked, 'Part of the Family feature pack');
    assert.deepEqual([...greyed.options], ['none', 'kids', 'soul', 'suno', 'sona'], 'every option is still there');
    assert.match(greyed.hint, /Part of the Family feature pack, so songs on this account use None, plain YuE2\.$/);
    assert.equal(stranger.engines.lyria, GUIDE.engines.lyria, 'other engines untouched');
    assert.equal(GUIDE.engines.yue2.settings.find((s) => s.key === 'band').locked, undefined, 'GUIDE itself is never changed');
    state.features = () => { throw new Error('lookup failed'); };
    assert.equal(styleAllowed({ id: 'x' }), false, 'an unreadable pack answer is outside the pack');
    assert.equal(withStyleAccess(GUIDE, { id: 'x' }).engines.yue2.settings.find((s) => s.key === 'band').locked, 'Part of the Family feature pack');
    state.features = () => ({ mediaLinks: true });
    assert.equal(styleAllowed({ id: 'x' }), false, 'only trainedStyles opens it');

    assert.equal(asksForStyle({ engine: 'yue2', band: 'soul' }), true);
    assert.equal(asksForStyle({ engine: 'yue2', band: 'kids' }), true);
    assert.equal(asksForStyle({ engine: 'yue2', band: 'suno' }), true);
    assert.equal(asksForStyle({ engine: 'yue2', band: 'sona' }), true);
    assert.equal(asksForStyle({ engine: 'yue2', band: 'none' }), false);
    assert.equal(asksForStyle({ engine: 'yue2', band: '' }), false);
    assert.equal(asksForStyle({ engine: 'yue2' }), false);
    assert.equal(asksForStyle({ engine: 'lyria', band: 'soul' }), false);
    assert.equal(asksForStyle(null), false);

    // Through HTTP.
    const app = express();
    app.use(booth);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(base + '/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const song = { engine: 'yue2', script: 'Slow tempo, female lead vocal, 72 BPM.', lyrics: '[Verse]\nWords' };
    try {
      state.features = () => ({ trainedStyles: false, mediaLinks: false });
      for (const style of ['soul', 'kids', 'suno', 'sona', 'something-else']) {
        const refused = await post({ ...song, band: style });
        assert.equal(refused.status, 403, style);
        assert.deepEqual(refused.body, { error: pack.FAMILY_PACK_STYLES_REFUSAL, pack: true });
        assert.equal(refused.body.yueSaw, undefined, 'nothing reached YuE2');
      }
      assert.match(state.warnings.join('\n'), /trained style REFUSED user=u1: not in the Family feature pack/);
      const plain = await post({ ...song, band: 'none' });
      assert.equal(plain.status, 200);
      assert.equal(plain.body.yueSaw.band, 'none', 'None is plain YuE2, open to everyone');
      assert.equal((await post(song)).body.yueSaw.engine, 'yue2', 'no Style at all is plain YuE2');

      state.features = () => ({ trainedStyles: true });
      for (const style of ['soul', 'kids', 'suno', 'sona']) {
        const family = await post({ ...song, band: style });
        assert.equal(family.status, 200, style);
        assert.equal(family.body.yueSaw.band, style, `the pack passes ${style} on to YuE2`);
      }

      // Sep 27 2026, her word: no clean-words rule for the Kids style; explicit lyrics pass through.
      const swearing = await post({ ...song, band: 'kids', lyrics: '[Verse]\nWhat the fuck' });
      assert.equal(swearing.status, 200);
      assert.equal(swearing.body.yueSaw.band, 'kids', 'the Kids style renders explicit lyrics like any style');
    } finally {
      server.close();
    }
  });
});

/* Every kind of account, judged by the pack's own rule (the real familyFeatures), through the real booth route: the guide, the
 * direct request, and the sentence. The ids are the ones the library tests use: the App Review seat, an account from before the
 * Family library's cutoff, and a newer account that waits for a yes. */
const EARLY = '6a5fc5fa351af41332734161';
const LATER = '700000000000000000000001';
const REVIEW_SEAT = '6a6125d73939d20b95251078';
const TEST_SEAT = '6a572e3be680dcdaadca0f04';
const ACCOUNTS = {
  admin: { user: { id: LATER, role: 'ADMIN' }, member: true },
  'admin on the review seat': { user: { id: REVIEW_SEAT, role: 'ADMIN', email: 'kadeai.vischeck722@gmail.com' }, member: false },
  'family member': { user: { id: LATER, role: 'USER', kadeLibraryAccess: 'family' }, member: true },
  'older account': { user: { id: EARLY, role: 'USER' }, member: true },
  'child with the pack': { user: { id: LATER, role: 'USER', kadeAccountType: 'child', kadeLibraryAccess: 'family' }, member: true },
  'newer account': { user: { id: LATER, role: 'USER' }, member: false },
  'pack turned off': { user: { id: EARLY, role: 'USER', kadeLibraryAccess: 'none' }, member: false },
  'child without the pack': { user: { id: LATER, role: 'USER', kadeAccountType: 'child' }, member: false },
  'App Review seat': { user: { id: REVIEW_SEAT, role: 'USER', email: 'kadeai.vischeck722@gmail.com' }, member: false },
  'App Review seat, pack granted': { user: { id: REVIEW_SEAT, role: 'USER', kadeLibraryAccess: 'family' }, member: false },
  'test seat': { user: { id: TEST_SEAT, role: 'USER' }, member: false },
  'test seat granted the pack': { user: { id: TEST_SEAT, role: 'USER', kadeLibraryAccess: 'family' }, member: true },
  'nobody signed in': { user: null, member: false },
};

test('every kind of account: every style, Suno and Sona included, is live for exactly the Family feature pack and greyed out for everyone else, the review seat included', async () => {
  await withEnv({ YUE_STYLES_ENABLED: '1', KADE_SOUNDBOOTH_YT_LINKS: undefined, KADE_LIBRARY_HIDDEN_FROM: undefined, KADE_APP_REVIEW_USER_IDS: undefined, NOTIFY_TEST_USER_IDS: undefined }, async () => {
    const state = { user: null, features: (user) => pack.familyFeatures(user, {}), warnings: [], auths: 0 };
    const booth = loadBooth(state);
    const { GUIDE, withStyleAccess, styleAllowed } = booth._internals;
    const app = express();
    app.use(booth);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(base + '/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const song = { engine: 'yue2', script: DIRECTION, lyrics: '[Verse]\nWords' };
    try {
      for (const [kind, { user, member }] of Object.entries(ACCOUNTS)) {
        state.user = user;
        assert.equal(styleAllowed(user), member, kind);
        // The guide: the choice and its strength stay for everyone, with every option, greyed out outside the pack.
        const card = withStyleAccess(GUIDE, user).engines.yue2;
        const band = card.settings.find((s) => s.key === 'band');
        const strength = card.settings.find((s) => s.key === 'style_strength');
        assert.deepEqual([...band.options], ['none', 'kids', 'soul', 'suno', 'sona'], `${kind}: nothing is hidden`);
        assert.equal(band.default, 'none', kind);
        assert.equal(band.locked, member ? undefined : 'Part of the Family feature pack', kind);
        assert.equal(strength.locked, member ? undefined : 'Part of the Family feature pack', kind);
        assert.equal(band.hint.endsWith('so songs on this account use None, plain YuE2.'), !member, `${kind}: the hint says why for a client that ignores locked`);
        // The direct request for each style (an older client, or a hand-made body), Sona's the same as Kids, Soul and Suno.
        for (const style of Object.keys(yue.yueStyles)) {
          state.warnings.length = 0;
          const asked = await post({ ...song, band: style });
          if (member) {
            assert.equal(asked.status, 200, `${kind} ${style}`);
            assert.equal(asked.body.yueSaw.band, style, `${kind}: ${style} passed on to YuE2`);
            assert.equal(state.warnings.length, 0, `${kind} ${style}`);
          } else {
            assert.equal(asked.status, 403, `${kind} ${style}`);
            assert.deepEqual(asked.body, { error: pack.FAMILY_PACK_STYLES_REFUSAL, pack: true }, `${kind} ${style}: the same sentence for every style`);
            assert.equal(asked.body.yueSaw, undefined, `${kind} ${style}: nothing reached YuE2`);
            assert.match(state.warnings.join('\n'), /trained style REFUSED/, `${kind} ${style}`);
          }
        }
        assert.ok(Object.keys(yue.yueStyles).includes('sona'), 'Sona is one of the styles asked for above');
        // Plain YuE2 stays open to everyone who is signed in.
        assert.equal((await post({ ...song, band: 'none' })).status, 200, `${kind}: Style None is open`);
        assert.equal((await post(song)).status, 200, `${kind}: no Style is open`);
      }
    } finally {
      server.close();
    }
  });
});

test('options round trip: a styled song is saved with its Style, opens with it, and renders again as the same request; older projects open as they were', async () => {
  await withEnv({ YUE_STYLES_ENABLED: '1', YUE_COVERS_V2: '1', KADE_SOUNDBOOTH_YT_LINKS: undefined }, async () => {
    const state = { user: { id: 'u1' }, features: () => ({ trainedStyles: true }), warnings: [], auths: 0, projects: [] };
    const booth = loadBooth(state);
    const { projectView } = booth._internals;
    assert.equal(typeof state.yueHooks.project, 'function', 'the booth hands the YuE2 router its project hook');
    // What the page does on Open in the booth: the saved settings come back as values, the saved direction as the script.
    const reopen = (view) => ({ ...view.options, script: view.script, title: view.title, lyrics: view.options.lyrics });
    for (const band of Object.keys(yue.yueStyles)) {
      for (const style_strength of [undefined, 0.5, 1, 0]) {
        const input = yue.yueInput({ script: DIRECTION, lyrics: '[Verse]\nWords', band, style_strength, seed: 5, title: 'Rain song' }, process.env);
        const id = await state.yueHooks.project('u1', input, 'my notes');
        const saved = JSON.parse(JSON.stringify(state.projects.find((row) => String(row._id) === id)));
        const view = projectView(saved, 1, {});
        const why = `${band} ${style_strength}`;
        assert.equal(view.options.band, band, why);
        assert.equal(view.options.style_strength, style_strength, why);
        assert.equal(view.script, DIRECTION, `${why}: the lead is not saved into her words`);
        assert.equal(view.engine, 'yue2');
        assert.match(view.why, /^YuE2 /, why);
        // Rendering the opened project asks the worker for exactly what the first render did.
        const again = yue.yueInput(reopen(view), process.env);
        assert.equal(JSON.stringify(again), JSON.stringify(input), why);
        assert.equal(again.lora_key, style_strength === 0 ? undefined : yue.yueStyles[band].key, why);
      }
    }
    // Older projects: a plain one, one saved with the lead still in front of her words (before the lead was kept out of the
    // saved direction), and one with a Style the booth no longer has.
    const legacy = (script, options) => projectView({ _id: 'old', user: 'u1', engine: 'yue2', title: 'Old', script, sourceText: '', options, state: 'done' }, 1, {});
    const plain = legacy('Slow soul, female lead vocal', { lyrics: '[Verse]\nWords', cot: 'full', seed: 3, count: 1, weirdness: 50, steps: 32, guidance: 1 });
    assert.equal('band' in plain.options, false, 'a project from before Styles opens with none');
    assert.equal(yue.yueInput(reopen(plain), process.env).lora_key, undefined);
    for (const band of ['kids', 'soul']) {
      const old = legacy(`${yue.yueStyles[band].lead} Slow soul`, { lyrics: '[Verse]\nWords', band, seed: 3, style_strength: 0.7 });
      assert.equal(old.options.band, band);
      const render = yue.yueInput(reopen(old), process.env);
      assert.equal(render.style, `${yue.yueStyles[band].lead} Slow soul`, `${band}: the lead is put in front once`);
      assert.equal(render.lora_scale, 0.7);
    }
    /* Sona: a project saved in September (the first, Sonauto-era Sona) stored band 'sona' and, in front of her words, the long retired
     * lead; one saved after the lead was kept out has only her words. Both open, and both render as a Sona song on the NEW file with
     * the lead once. No saved project carries an adapter file, so the old file cannot ride along. */
    const retiredLead = 'kdsona, in the style of kdsona. English, female lead vocal.';
    const sonaLead = yue.yueStyles.sona.lead;
    for (const [what, script] of [
      ['the retired lead', `${retiredLead} Slow soul`],
      ['the retired lead twice', `${retiredLead} ${retiredLead} Slow soul`],
      ['the current lead', `${sonaLead} Slow soul`],
      ['her words only', 'Slow soul'],
    ]) {
      for (const options of [
        { lyrics: '[Verse]\nWords', band: 'sona', seed: 3, style_strength: 0.7 },
        { lyrics: '[Verse]\nWords', band: 'sona', seed: 3 },
        { lyrics: '[Verse]\nWords', cot: 'off', band: 'sona', seed: 3, count: 1, weirdness: 50, steps: 32, guidance: 1, style_strength: 1 },
      ]) {
        const old = legacy(script, options);
        const why = `${what} ${JSON.stringify(options.style_strength)}`;
        assert.equal(old.options.band, 'sona', why);
        const render = yue.yueInput(reopen(old), process.env);
        assert.equal(render.band, 'sona', why);
        assert.equal(render.style, `${sonaLead} Slow soul`, `${why}: the current lead, once, then her words`);
        assert.equal(render.style.split('kdsona').length - 1, 2, `${why}: one lead, its trigger word twice`);
        assert.equal(render.lora_key, 'yue2-loras/sona-step800.pt', `${why}: the new file`);
        assert.equal(render.lora_scale, options.style_strength === undefined ? 1 : options.style_strength, why);
        assert.doesNotMatch(JSON.stringify(render), /sona1800/, why);
      }
    }
    // With the Style choice switched off, the same old project is refused with the one plain sentence, as an old Kids one is.
    withEnv({ YUE_STYLES_ENABLED: undefined }, () => {
      const old = legacy(`${retiredLead} Slow soul`, { lyrics: '[Verse]\nWords', band: 'sona', seed: 3 });
      assert.throws(() => yue.yueInput(reopen(old), process.env), { message: 'That trained style is not available. Choose None or another style.' });
    });
    /* Her own words can begin with "female lead vocal." after a lead. That is also how the retired Sona lead ended, but here they are
     * hers: what is saved keeps them (the booth cuts the lead it put in front exactly, savedDirection), and the song reopens as the
     * same request. */
    for (const band of Object.keys(yue.yueStyles)) {
      for (const script of ['female lead vocal. Warm piano.', 'female lead vocal. kdsona is a made-up word.']) {
        for (const style_strength of [undefined, 0.4, 0]) {
          const input = yue.yueInput({ script, lyrics: '[Verse]\nWords', band, style_strength, seed: 5, title: 'Rain song' }, process.env);
          const id = await state.yueHooks.project('u1', input, 'my notes');
          const view = projectView(JSON.parse(JSON.stringify(state.projects.find((row) => String(row._id) === id))), 1, {});
          const why = `${band} ${style_strength} ${script}`;
          assert.equal(view.script, script, `${why}: nothing she wrote is lost from what is saved`);
          assert.equal(JSON.stringify(yue.yueInput(reopen(view), process.env)), JSON.stringify(input), `${why}: it reopens as the same request`);
          if (style_strength !== 0) assert.equal(input.style, `${yue.yueStyles[band].lead} ${script}`, why);
        }
      }
    }
    const gone = legacy('Slow soul', { lyrics: '[Verse]\nWords', band: 'a-style-that-was-removed', seed: 3 });
    assert.equal(gone.options.band, 'a-style-that-was-removed', 'it still opens');
    assert.throws(() => yue.yueInput(reopen(gone), process.env), { message: 'That trained style is not available. Choose None or another style.' });
  });
});

/* ---------------- the carry between YuE2 and ACE-Step XL --------------------- */
const carry = require('./kadeSoundBoothCarry');
const ace = loadTs('packages/api/src/music/ace.ts');
const STYLE_KEYS = ['band', 'style_strength', 'lora_key', 'lora_scale'];
const CARRY_LYRICS = '[Verse]\nWords one\n[Chorus]\nWords two';

test('the carry never moves a style name between YuE2 and ACE-Step XL, for any name on either menu', () => {
  /* Both engines have a Soul and a Suno now, and they are different adapters taught to different models, so a name must not
   * cross: the carry copies only the keys in an engine's `keeps` list and none of those is a style key. */
  const names = [...new Set([...Object.keys(yue.yueStyles), ...Object.keys(ace.aceStyles), 'soul', 'suno', 'kids'])];
  const triggers = /kd(kids|soulr|sona|suno)/i;
  for (const name of names) {
    for (const style_strength of [undefined, 0, 0.5, 1]) {
      const lead = yue.yueStyles[name] ? `${yue.yueStyles[name].lead} ` : '';
      const yueProject = { _id: 'y1', engine: 'yue2', title: 'Rain', sourceText: 'notes', script: `${lead}Slow soul, Rhodes`, options: { lyrics: CARRY_LYRICS, band: name, style_strength, lora_key: 'yue2-loras/x.pt', lora_scale: 1, seed: 4, count: 1 } };
      const aceProject = { _id: 'a1', engine: 'ace', title: 'Rain', sourceText: 'notes', script: 'Slow soul, Rhodes', options: { quality: 'Best', length: 'Match my lyrics', singing: 'Sung, with my lyrics', lyrics: CARRY_LYRICS, weirdness: 50, guidance: 1, seed: 7, band: name, style_strength, lora_key: 'ace-loras/x', lora_scale: 1 } };
      for (const helpers of [{ ace: true }, { ace: true, aceStyles: true }, { ace: true, yueStyles: true }, { ace: true, aceStyles: true, yueStyles: true }]) {
        const why = `${name} ${style_strength} ${JSON.stringify(helpers)}`;
        const toAce = carry.carryOver(yueProject, 'ace', helpers);
        const toYue = carry.carryOver(aceProject, 'yue2', helpers);
        for (const [out, expectedSeed] of [[toAce, 4], [toYue, 7]]) {
          assert.equal(out.ok, true, why);
          for (const key of STYLE_KEYS) assert.equal(key in out.draft.options, false, `${why}: ${key} stays behind`);
          assert.equal(out.draft.options.lyrics, CARRY_LYRICS, `${why}: her words and tags come across whole`);
          assert.equal(out.draft.options.seed, expectedSeed, why);
          assert.doesNotMatch(JSON.stringify(out.draft), triggers, `${why}: no trigger word is written into her draft`);
          /* A note may say which style stayed behind ("the YuE2 style was left behind", or "the YuE2 Kids style ..." when it names
           * the one she had), because that is the person's own choice and it is the SOURCE engine's. Take that one phrase out and no
           * style name is left: no note tells her to pick a named style on the other card, whose menu is a different one. */
          const said = out.notes.join(' ').replace(/\bthe (?:YuE2|ACE-Step XL)(?: [A-Za-z0-9_-]+)? style was left behind\b/g, '');
          assert.doesNotMatch(said, /\b(soul|suno|kids)\b/i, `${why}: the notes never name a style on the other engine's menu`);
          assert.doesNotMatch(out.notes.join(' '), /\bkd[a-z0-9]+\b|\b(?:yue2|ace)-loras\b|\.pt\b|\blora_(?:key|scale)\b/i, `${why}: the notes name no trigger word, adapter file or lora field`);
          /* A saved YuE2 direction can still carry its lead; the carry takes the trigger sentence off and keeps her words. */
          assert.ok(out.draft.script.endsWith('Slow soul, Rhodes'), `${why}: ${out.draft.script}`);
        }
      }
    }
  }
  // The leads of every YuE2 style come off an older draft, in front of or repeated, on the way to ACE-Step XL and to Lyria.
  for (const [name, row] of Object.entries(yue.yueStyles)) {
    for (const to of ['ace', 'lyria']) {
      const out = carry.carryOver({ _id: 'y2', engine: 'yue2', title: 'T', script: `${row.lead} ${row.lead} Warm piano`, options: { lyrics: CARRY_LYRICS, band: name } }, to, { ace: true });
      assert.ok(!/kd[a-z]+, in the style of/i.test(out.draft.script), `${name} -> ${to}: ${out.draft.script}`);
      assert.match(out.draft.script, /Warm piano$/, `${name} -> ${to}`);
    }
  }
});

test('the two engines keep separate adapters: a name only one of them has is refused by the other, and a shared name is two different files', () => {
  const UNAVAILABLE = 'That trained style is not available. Choose None or another style.';
  const ACE_ON = { ACE_STYLES_ENABLED: '1' };
  const aceBody = { script: 'Slow soul, 88 BPM, Rhodes', lyrics: CARRY_LYRICS, seed: 7 };
  const yueBody = { script: DIRECTION, lyrics: '[Verse]\nWords', seed: 7 };
  for (const row of Object.values(yue.yueStyles)) assert.match(row.key, /^yue2-loras\//, "YuE2's files live under yue2-loras/");
  for (const row of Object.values(ace.aceStyles)) assert.match(row.key, /^ace-loras\//, "ACE-Step XL's adapters live under ace-loras/");
  for (const name of Object.keys(yue.yueStyles)) {
    if (!(name in ace.aceStyles)) {
      assert.throws(() => ace.aceInput({ ...aceBody, band: name }, ACE_ON), { message: UNAVAILABLE }, `${name} is YuE2's alone`);
      continue;
    }
    const mine = request({ ...yueBody, band: name });
    const theirs = ace.aceRequest(ace.aceInput({ ...aceBody, band: name }, ACE_ON));
    assert.notEqual(mine.lora_key, theirs.lora_key, `${name} is a different file on each engine`);
    assert.match(mine.lora_key, /^yue2-loras\//, name);
    assert.match(theirs.lora_key, /^ace-loras\//, name);
    assert.doesNotMatch(JSON.stringify(mine), /ace-loras/, `${name}: nothing of ACE-Step XL in a YuE2 request`);
    assert.doesNotMatch(JSON.stringify(theirs), /yue2-loras|kd[a-z]+, in the style of/, `${name}: nothing of YuE2 in an ACE-Step XL request`);
  }
  for (const name of Object.keys(ace.aceStyles)) {
    if (!(name in yue.yueStyles)) assert.throws(() => request({ ...yueBody, band: name }), { message: UNAVAILABLE }, `${name} is ACE-Step XL's alone`);
  }
});

test('the carry says a style was left behind, for any style, and only points at a Style choice that exists for her', () => {
  for (const band of Object.keys(yue.yueStyles)) {
    const project = { _id: 'y3', engine: 'yue2', title: 'T', script: 'Slow soul', options: { lyrics: CARRY_LYRICS, band, seed: 1 } };
    const toLyria = carry.carryOver(project, 'lyria', { ace: true, aceStyles: true });
    assert.ok(toLyria.notes.some((note) => /^Lyria has no trained style, which only YuE2 has/.test(note)), `${band}: ${toLyria.notes.join(' | ')}`);
    const toAce = carry.carryOver(project, 'ace', { ace: true, aceStyles: true });
    /* "... so the YuE2 style was left behind." or, when the carry names the style she had, "... so the YuE2 Kids style was left
     * behind." Either is the same sentence; a name, when it is there, must be the style she had. */
    const LEFT_BEHIND = /^ACE-Step XL has its own Style choice, taught separately from YuE2's, so the YuE2( [A-Za-z0-9_-]+)? style was left behind\. Choose Style on the ACE-Step XL card to use one\.$/;
    const said = toAce.notes.map((note) => LEFT_BEHIND.exec(note)).find(Boolean);
    assert.ok(said, `${band}: ${toAce.notes.join(' | ')}`);
    if (said[1]) assert.equal(said[1].trim().toLowerCase(), band, `${band}: a name in the sentence is the style she had`);
    const withoutChoice = carry.carryOver(project, 'ace', { ace: true });
    assert.ok(withoutChoice.notes.includes('ACE-Step XL has no trained style, which only YuE2 has, so that was left behind.'), `${band}: ${withoutChoice.notes.join(' | ')}`);
    // A plain project (no Style, or None) says nothing about styles.
    for (const plainBand of [undefined, 'none', '']) {
      const plain = carry.carryOver({ ...project, options: { ...project.options, band: plainBand } }, 'ace', { ace: true, aceStyles: true });
      assert.doesNotMatch(plain.notes.join(' '), /[Ss]tyle/, JSON.stringify(plainBand));
    }
  }
});

/* ---------------- the web page -------------------------------------------- */
test('the web page: a locked choice is shown disabled on its default, says why, and is never sent', () => {
  const pageSource = fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8');
  const context = { module: { exports: {} }, require: () => ({ SHARED_HEAD: '' }) };
  vm.runInNewContext(pageSource, context);
  const html = context.module.exports.soundBoothHtml;
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.doesNotThrow(() => new vm.Script(script), 'the page script parses');
  const renderer = script.slice(script.indexOf("if(s.kind==='choice'){"), script.indexOf("if(s.kind==='clip'){"));
  assert.match(renderer, /var locked=!!s\.locked, chosen=locked\?s\.default:/, 'a locked choice sits on its default');
  assert.match(renderer, /class="hint locked" id="'\+id\+'_h">'\+esc\(s\.hint\)/, 'its hint, with the pack sentence, is visible');
  assert.match(renderer, /aria-describedby="'\+id\+'_h"'\+\(locked\?' disabled':''\)/, 'disabled, and described by that hint');
  assert.match(renderer, /s\.options\.map/, 'every option is listed');
  assert.match(script, /if\(s\.kind==='clip' \|\| s\.locked\) return;/, 'collect() never sends a locked choice');
  // Review: Surprise me never sends a locked Style either (an opened project can still hold one).
  assert.match(script, /var styleOpen=engine==='yue2'&&!state\.guide\.engines\.yue2\.settings\.some\(function\(s\)\{return s\.key==='band'&&s\.locked;\}\);/);
  assert.match(script, /post\('\/api\/kade\/sound-booth\/idea',\{band:styleOpen\?state\.values\.band:undefined,thinkMode:writingThink\}\)/);
  assert.match(html, /select\[disabled\] \{ opacity:\.55; cursor:default; \}/, 'greyed out');
});
