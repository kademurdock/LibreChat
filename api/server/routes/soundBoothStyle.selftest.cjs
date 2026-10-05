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

const PERSON_OR_FOLDER = /Kade|Holly|your own folders|sonauto|AudioCaptures|MUSIC GROUP|KIDS CHOIR|model training music|Desktop/i;

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

test('Kids is unchanged, and the menu is still exactly Kids and Soul', () => {
  assert.deepEqual(Object.keys(yue.yueStyles), ['kids', 'soul']);
  assert.deepEqual(yue.yueStyles.kids, {
    key: 'yue2-loras/kids-step1200.pt',
    scale: 1,
    lead: "kdkids, in the style of kdkids. English, children's choir, a group of young voices singing together, bright and clear.",
  });
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

/* ---------------- the hint and the lock ----------------------------------- */
test('the Style hint is true now and names no person or folder', () => {
  const hint = yue.yueStyleHint;
  assert.match(hint, /^A singing style taught to YuE2 from real recordings\./);
  assert.match(hint, /Soul learned from soul and R&B records/);
  assert.match(hint, /female lead vocal or male lead vocal in Music direction/);
  assert.match(hint, /Kids sings with a children’s choir\./, 'Part 296: shorter');
  assert.doesNotMatch(hint, /clean/i, 'Sep 27 2026: no clean-lyrics rule for the Kids style');
  assert.match(hint, /None is plain YuE2\./);
  assert.ok(hint.split(/\s+/).length <= 60, 'the hint stays short');
  assert.doesNotMatch(hint, /one expressive female lead/, 'the old sonauto description is gone');
  for (const words of [hint, yue.yueStyleLockedSentence, pack.FAMILY_PACK_STYLES_REFUSAL, yue.yueStyles.soul.lead, yue.yueStyles.kids.lead]) {
    assert.doesNotMatch(words, PERSON_OR_FOLDER, words);
  }
});

test('yueStyleAccess: the pack keeps the choice; everyone else sees it greyed out with every option', () => {
  const settings = [
    { key: 'lyrics', label: 'Lyrics', hint: 'Words.', kind: 'text' },
    { key: 'band', label: 'Style', hint: yue.yueStyleHint, kind: 'choice', options: ['none', 'kids', 'soul'], default: 'none' },
    { key: 'count', label: 'Number of takes', hint: 'One to four.', kind: 'number' },
  ];
  assert.equal(yue.yueStyleAccess(settings, true, pack.FAMILY_PACK_NOTE), settings, 'unchanged with the pack');
  const locked = yue.yueStyleAccess(settings, false, pack.FAMILY_PACK_NOTE);
  assert.notEqual(locked, settings);
  assert.deepEqual(locked.map((s) => s.key), ['lyrics', 'band', 'count'], 'never hidden');
  const band = locked[1];
  assert.equal(band.locked, 'Part of the Family feature pack');
  assert.deepEqual(band.options, ['none', 'kids', 'soul']);
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
    createYueRouter: () => {
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
    return stub(); // multer, the models, the chain, Jev, the key alarm: not what this file tests
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8'), {
    require: localRequire, module: mod, exports: mod.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return mod.exports;
}

test('the booth route: the guide greys Style out per person, and /render refuses a style outside the pack', async () => {
  await withEnv({ YUE_STYLES_ENABLED: '1', KADE_SOUNDBOOTH_YT_LINKS: undefined }, async () => {
    const state = { user: { id: 'u1' }, features: () => ({ trainedStyles: false }), warnings: [], auths: 0 };
    const booth = loadBooth(state);
    const { GUIDE, withStyleAccess, styleAllowed, asksForStyle } = booth._internals;
    const band = GUIDE.engines.yue2.settings.find((s) => s.key === 'band');
    assert.equal(band.hint, yue.yueStyleHint, 'the guide reads the hint from yue.ts');
    assert.deepEqual([...band.options], ['none', 'kids', 'soul'], 'the options (a vm array, so spread into this realm)');
    assert.equal(band.locked, undefined, 'the shared GUIDE carries no lock');

    // Per person.
    state.features = () => ({ trainedStyles: true });
    assert.equal(withStyleAccess(GUIDE, { id: 'family' }), GUIDE, 'a family account sees the guide as it is');
    state.features = () => ({ trainedStyles: false });
    const stranger = withStyleAccess(GUIDE, { id: 'bob' });
    const greyed = stranger.engines.yue2.settings.find((s) => s.key === 'band');
    assert.equal(greyed.locked, 'Part of the Family feature pack');
    assert.deepEqual([...greyed.options], ['none', 'kids', 'soul'], 'every option is still there');
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
      for (const style of ['soul', 'kids', 'something-else']) {
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
      const family = await post({ ...song, band: 'soul' });
      assert.equal(family.status, 200);
      assert.equal(family.body.yueSaw.band, 'soul', 'the pack passes on to YuE2');

      // Sep 27 2026, her word: no clean-words rule for the Kids style; explicit lyrics pass through.
      const swearing = await post({ ...song, band: 'kids', lyrics: '[Verse]\nWhat the fuck' });
      assert.equal(swearing.status, 200);
      assert.equal(swearing.body.yueSaw.band, 'kids', 'the Kids style renders explicit lyrics like any style');
    } finally {
      server.close();
    }
  });
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
  assert.match(script, /post\('\/api\/kade\/sound-booth\/idea',\{band:styleOpen\?state\.values\.band:undefined\}\)/);
  assert.match(html, /select\[disabled\] \{ opacity:\.55; cursor:default; \}/, 'greyed out');
});
