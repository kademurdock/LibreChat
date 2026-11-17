'use strict';
/* Character caps on the Sound Booth's text boxes (Nov 17 2026, her ask: "if someone is going to write 5000 chars and
 * it only accepts 2000 on a model, the textbox needs to reflect that"). Without a browser: the booth page's applyCaps
 * and the Open voices panel run in jsdom, with the limits the server sends.
 * Run: NODE_PATH=<a node_modules with express and jsdom> node --test api/server/routes/kadeSoundBoothCaps.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { CAPS_SOURCE } = require('./kadeSoundBoothCaps');
const { LIMITS, SCRIPT_MAX, SETTING_MAX, withTextLimits } = require('./kadeSoundBoothLimits');
const ov = require('./kadeSoundBoothOpenVoices');
const writer = require('./kadeSoundBoothOpenVoicesWriter');
const { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT } = require('./kadeSoundBoothOpenVoicesPage');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

/* ---------- the numbers are the server's own ---------- */

test('the limits are the numbers the routes refuse at', () => {
  const yue = read('../../../packages/api/src/music/yue.ts');
  const ace = read('../../../packages/api/src/music/ace.ts');
  const effects = read('../../../packages/api/src/audio/effects.ts');
  for (const src of [yue, ace, effects]) assert.ok(src.includes(`body.script.length > ${LIMITS.musicDirection})`), 'direction cap');
  assert.ok(yue.includes(`body.lyrics.length > ${LIMITS.yueLyrics}`));
  assert.ok(yue.includes(`body.abc.length > ${LIMITS.yueAbc}`));
  assert.ok(ace.includes(`const LYRICS_LIMIT = ${LIMITS.aceLyrics};`));
  assert.equal(LIMITS.wordsText, 200, 'the bridge (auk-words.js MAX_TEXT) refuses past 200 too');
  assert.equal(LIMITS.fixDescription, 300, 'the bridge (auk-tasks.js) refuses past 300 too');
  assert.equal(LIMITS.scenemaPart, 4000, 'the bridge (scenema.js MAX_PROMPT) refuses past 4000');
  /* The booth route reads the very same constants, and refuses an over-long edit instruction itself. */
  const booth = read('kadeSoundBooth.js');
  assert.match(booth, /const MAX_SCENEMA_CHARS = LIMITS\.scenemaPart;/);
  assert.match(booth, /const MAX_SEED_CHARS = LIMITS\.seed;/);
  assert.match(booth, /const MAX_LYRIA_CHARS = LIMITS\.lyriaBrief;/);
  assert.match(booth, /const MAX_LYRIA_LYRICS_CHARS = LIMITS\.lyriaLyrics;/);
  assert.match(booth, /String\(b\.text \|\| ''\)\.trim\(\)\.slice\(0, LIMITS\.desk\)/);
  assert.match(booth, /editing && !wording && !fixing && script\.length > LIMITS\.scenemaPart/);
  assert.match(booth, /guide: withTextLimits\(/, '/health sends the limits inside the guide');
  /* Every capped setting is a real typed setting of that engine's card. */
  const aceGuide = ace.slice(ace.indexOf('key: \'lyrics\'') - 200);
  assert.ok(aceGuide.length > 200, 'ACE has a lyrics box');
  for (const [engine, keys] of Object.entries(SETTING_MAX)) {
    for (const key of Object.keys(keys)) if (engine !== 'ace') assert.match(booth, new RegExp(`key: '${key}'[^\\n]*kind: 'text'`), `${engine} ${key}`);
  }
});

test('the guide carries each engine\'s limits, without changing the guide it was given', () => {
  const guide = { engines: {
    scenema: { name: 'AuK HQ', settings: [{ key: 'instruction', kind: 'text' }, { key: 'voice_description', kind: 'text' }, { key: 'old_text', kind: 'text' }, { key: 'pace', kind: 'choice' }] },
    seed: { name: 'Seed Audio', settings: [] }, lyria: { name: 'Lyria', settings: [{ key: 'lyrics', kind: 'text' }] },
    yue2: { name: 'YuE2', settings: [{ key: 'lyrics', kind: 'text' }, { key: 'abc', kind: 'text' }] }, ace: { name: 'ACE-Step XL', settings: [{ key: 'lyrics', kind: 'text' }] },
    stable: { name: 'Stable Audio', settings: [] }, myvoice: { name: 'My voice', settings: [] },
  } };
  const before = JSON.stringify(guide);
  const g = withTextLimits(guide);
  assert.equal(JSON.stringify(guide), before);
  assert.equal(g.deskMax, 6000);
  assert.equal(g.engines.scenema.scriptMax, undefined, 'AuK speech is made in parts: a count, no one limit');
  assert.deepEqual([g.engines.seed.scriptMax, g.engines.seed.scriptCut], [2048, true]);
  for (const e of ['lyria', 'yue2', 'ace', 'stable']) assert.equal(g.engines[e].scriptMax, 3000, e);
  assert.equal(g.engines.myvoice.scriptMax, undefined);
  const by = (e, k) => g.engines[e].settings.find((s) => s.key === k);
  assert.equal(by('scenema', 'instruction').maxChars, 4000);
  assert.deepEqual([by('scenema', 'voice_description').maxChars, by('scenema', 'voice_description').maxCut], [600, true]);
  assert.equal(by('scenema', 'old_text').maxChars, 200);
  assert.equal(by('scenema', 'pace').maxChars, undefined);
  assert.equal(by('lyria', 'lyrics').maxChars, 8000);
  assert.equal(by('yue2', 'lyrics').maxChars, 8000);
  assert.equal(by('yue2', 'abc').maxChars, 40000);
  assert.equal(by('ace', 'lyrics').maxChars, 4096);
  assert.equal(SCRIPT_MAX.scenema, undefined);
});

/* ---------- the booth page ---------- */

function buildPage() {
  const context = { module: { exports: {} }, require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))) };
  vm.runInNewContext(read('kadeSoundBoothPage.js'), context);
  return context.module.exports.soundBoothHtml;
}
const main = [...buildPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function confirmRender('));
function pageFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' is on the page');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

const BOOTH_GUIDE = withTextLimits({ engines: {
  scenema: { name: 'AuK HQ', settings: [{ key: 'instruction', label: 'Edit instructions', kind: 'text' }, { key: 'old_text', label: 'Words it says now', kind: 'text' }, { key: 'new_text', label: 'New words', kind: 'text' }, { key: 'fix_description', label: 'New voice', kind: 'text' }, { key: 'voice_description', label: 'Describe a new voice (without a reference)', kind: 'text' }] },
  seed: { name: 'Seed Audio', settings: [] },
  lyria: { name: 'Lyria', settings: [{ key: 'lyrics', label: 'Your own lyrics', kind: 'text' }] },
  yue2: { name: 'YuE2', settings: [{ key: 'lyrics', label: 'Lyrics', kind: 'text' }, { key: 'abc', label: 'Optional composition (ABC)', kind: 'text' }] },
  ace: { name: 'ACE-Step XL', settings: [{ key: 'lyrics', label: 'Lyrics', kind: 'text' }] },
  stable: { name: 'Stable Audio', settings: [] },
} });

function booth() {
  const dom = new JSDOM(`<!doctype html><body><p id="status" role="status"></p>
    <label id="editorLabel" for="script">Music direction</label><textarea id="script" aria-describedby="scriptHint"></textarea><p id="scriptHint"></p>
    <label id="textLabel" for="text">The words to perform</label><textarea id="text" aria-describedby="textHint"></textarea><p id="textHint"></p>
    <div id="settings"></div></body>`, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`${CAPS_SOURCE}
    var status=document.getElementById('status'), caps=null, lastSaid=0;
    ${pageFunction(main, 'say')}
    caps=boothCaps({say:say,status:status,saidAt:function(){ return lastSaid; }});
    var state={guide:${JSON.stringify(BOOTH_GUIDE)}, engine:'yue2'};
    ${pageFunction(main, 'briefLength')}
    ${pageFunction(main, 'applyCaps')}
    window.say=say; window.state=state; window.applyCaps=applyCaps;`);
  const $ = (id) => w.document.getElementById(id);
  /* What renderSettings draws for the engine: a textarea for lyrics and instructions, an input for other text. */
  const draw = (engine, values = {}) => {
    $('settings').innerHTML = BOOTH_GUIDE.engines[engine].settings.map((s) => (s.key === 'lyrics' || s.key === 'instruction'
      ? `<textarea id="set_${s.key}" aria-describedby="set_${s.key}_h"></textarea><p id="set_${s.key}_h"></p>`
      : `<input type="text" id="set_${s.key}" aria-describedby="set_${s.key}_h"><p id="set_${s.key}_h"></p>`)).join('');
    for (const [k, v] of Object.entries(values)) $('set_' + k).value = v;
  };
  const pick = (engine, noScript, values) => { w.state.engine = engine; draw(engine, values); w.applyCaps(!!noScript); };
  return { w, $, pick };
}

test('the page wires applyCaps into every redraw, and splices the caps helper into its script', () => {
  assert.ok(main.includes('function boothCaps('));
  new Function(main);
  assert.match(pageFunction(main, 'applyWorkflow'), /applyCaps\(upload\|\|editing\);\s*}$/);
  assert.match(pageFunction(main, 'renderSettings'), /applyWorkflow\(\);\s*}$/, 'every settings redraw recounts');
  assert.match(pageFunction(main, 'say'), /caps\.notes\(\)/);
});

test('booth page: maxlength is the server limit for each engine, and follows the engine', () => {
  const { $, pick } = booth();
  const cases = { seed: 2048, yue2: 3000, ace: 3000, stable: 3000 };
  for (const [engine, max] of Object.entries(cases)) {
    pick(engine);
    assert.equal($('script').maxLength, max, engine);
    assert.equal($('script_count').textContent, `0 of ${max.toLocaleString('en-US')} characters.`);
  }
  pick('lyria'); assert.equal($('set_lyrics').maxLength, 8000);
  pick('yue2'); assert.equal($('set_lyrics').maxLength, 8000); assert.equal($('set_abc').maxLength, 40000);
  pick('ace'); assert.equal($('set_lyrics').maxLength, 4096);
  pick('scenema');
  assert.equal($('script').hasAttribute('maxlength'), false, 'AuK speech is made in parts: no single limit');
  assert.equal($('script_count').textContent, '0 characters.');
  assert.equal($('set_instruction').maxLength, 4000);
  assert.equal($('set_old_text').maxLength, 200);
  assert.equal($('set_new_text').maxLength, 200);
  assert.equal($('set_fix_description').maxLength, 300);
  assert.equal($('set_voice_description').maxLength, 600);
  assert.equal($('text').maxLength, 6000, 'the writing desk reads 6,000');
  pick('yue2'); assert.equal($('text').hasAttribute('maxlength'), false, 'a song engine sorts a pasted song whole: count only');
  pick('lyria'); assert.equal($('script').hasAttribute('maxlength'), false, 'Lyria counts the brief, not a Lyrics part');
  assert.equal($('script_count').textContent, '0 of 3,000 characters.');
  pick('scenema');
  /* An upload engine or an AuK edit task hides the script box: its limit and count go. */
  pick('scenema', true);
  assert.equal($('script').hasAttribute('maxlength'), false);
  assert.equal($('script_count'), null);
  assert.equal($('script').getAttribute('aria-describedby'), 'scriptHint');
});

test('booth page: the limit is read with the box, the count sits after it, and typing makes nothing read', () => {
  const { $, pick, w } = booth();
  pick('ace');
  $('set_lyrics').value = 'x'.repeat(120);
  $('set_lyrics').dispatchEvent(new w.Event('input'));
  assert.equal($('set_lyrics_count').textContent, '120 of 4,096 characters.');
  assert.equal($('set_lyrics').getAttribute('aria-describedby'), 'set_lyrics_h set_lyrics_limit');
  assert.equal($('set_lyrics').nextElementSibling.id, 'set_lyrics_limit');
  assert.equal($('set_lyrics_limit').nextElementSibling.id, 'set_lyrics_count');
  assert.equal($('set_lyrics_limit').textContent, 'Up to 4,096 characters for ACE-Step XL.');
  /* Her report: typing re-read the box's description. Only the fixed limit line is tied to the box, and typing never changes it. */
  const before = $('set_lyrics_limit').textContent;
  $('set_lyrics').value = 'x'.repeat(121); $('set_lyrics').dispatchEvent(new w.Event('input'));
  assert.equal($('set_lyrics_limit').textContent, before);
  assert.equal($('set_lyrics_count').textContent, '121 of 4,096 characters.');
  assert.ok(!$('set_lyrics').getAttribute('aria-describedby').includes('_count'));
  assert.equal($('set_lyrics_count').getAttribute('aria-live'), null);
  assert.equal($('set_lyrics_count').getAttribute('role'), null);
  assert.equal($('script').getAttribute('aria-describedby'), 'scriptHint script_limit');
  /* Typing says nothing until the limit. */
  w.say('Ready.');
  $('script').value = 'abc'; $('script').dispatchEvent(new w.Event('input'));
  assert.equal($('status').textContent, 'Ready.');
  $('script').value = 'y'.repeat(3000); $('script').dispatchEvent(new w.Event('input'));
  assert.equal($('status').textContent, 'That is the limit: 3,000 characters for ACE-Step XL. ACE-Step XL reads only about the first 512 characters of this. The rest is left out.');
});

test('booth page: a lower limit keeps her words and says how many are over', async () => {
  const { $, pick, w } = booth();
  pick('yue2', false, { lyrics: 'la '.repeat(2000) });
  $('script').value = 'z'.repeat(2500);
  w.applyCaps(false);
  await tick();
  /* ACE takes 4,096 of lyrics: 6,000 typed stays, and she is told. */
  pick('ace', false, { lyrics: 'la '.repeat(2000) });
  w.say('ACE-Step XL. Describe the style, add lyrics, then choose Make music.');
  await tick();
  assert.equal($('set_lyrics').value.length, 6000, 'nothing is cut');
  assert.equal($('set_lyrics').maxLength, 4096);
  assert.equal($('set_lyrics_count').textContent, '6,000 of 4,096 characters, 1,904 over.');
  assert.match($('status').textContent, /^ACE-Step XL\. Describe the style, add lyrics, then choose Make music\. Lyrics: 1,904 characters over the limit of 4,096 for ACE-Step XL\. Your words are kept\. It will be refused until it is shorter\.$/);
  /* Seed cuts a long script itself: the note says so. */
  pick('seed');
  await tick();
  assert.equal($('script').value.length, 2500);
  assert.match($('status').textContent, /^Music direction: 452 characters over the limit of 2,048 for Seed Audio\. Your words are kept\. Anything past 2,048 will be cut off\./);
  /* Said once: a redraw at the same limit says nothing new. */
  w.say('Quiet.');
  pick('seed'); await tick();
  assert.equal($('status').textContent, 'Quiet.');
});

/* ---------- review fixes, Nov 17 ---------- */

const input = (w, box, value) => { box.value = value; box.dispatchEvent(new w.Event('input')); };
const pasteInto = (w, box, text) => {
  const e = new w.Event('paste', { cancelable: true });
  e.clipboardData = { getData: () => text };
  box.dispatchEvent(e);
  return e;
};

test('booth page: a song engine leaves the writing desk box uncut, so a pasted song reaches the server whole', () => {
  const { $, pick, w } = booth();
  for (const engine of ['lyria', 'yue2', 'ace']) {
    pick(engine);
    assert.equal($('text').hasAttribute('maxlength'), false, engine);
  }
  input(w, $('text'), 'x'.repeat(6500));
  assert.equal($('text_count').textContent, '6,500 characters.');
  pick('seed');
  assert.equal($('text').maxLength, 6000, 'other engines keep the desk\'s 6,000');
  /* The server sorts a song paste before its 6,000 cut: that is why the song engines take the whole paste. */
  const booth_ = read('kadeSoundBooth.js');
  assert.ok(booth_.indexOf('songPaste.splitSongPaste(b.text)', 2200) < booth_.indexOf('.slice(0, LIMITS.desk)'));
});

test('booth page: Lyria counts only the brief, as checkMusic does, and a Lyrics part is not cut', async () => {
  const { $, pick, w } = booth();
  pick('lyria');
  w.say('Ready.');
  const brief = 'b'.repeat(1200) + '\nLyrics:\n' + 'la la\n'.repeat(500);
  input(w, $('script'), brief);
  await tick();
  assert.equal($('script').hasAttribute('maxlength'), false);
  assert.equal($('script_count').textContent, '1,200 of 3,000 characters. The Lyrics part is counted with the lyrics.');
  assert.equal($('status').textContent, 'Ready.', 'nothing is over, so nothing is said');
  /* The same split the server uses. */
  const carry = require('./kadeSoundBoothCarry');
  assert.equal(carry.splitLyricsBlock(brief).prose.length, 1200);
  /* A brief that really is too long is said once, with the server's refusal. */
  input(w, $('script'), 'p'.repeat(3100) + '\nLyrics:\nla');
  await tick();
  assert.equal($('status').textContent, 'Music direction: 100 characters over the limit of 3,000 for Lyria. Your words are kept. It will be refused until it is shorter.');
  w.say('Quiet.');
  input(w, $('script'), 'p'.repeat(3101) + '\nLyrics:\nla');
  await tick();
  assert.equal($('status').textContent, 'Quiet.');
});

test('booth page: the same sentence twice is heard twice', () => {
  const { $, w } = booth();
  w.say('Saved.');
  w.say('Saved.');
  assert.equal($('status').textContent, 'Saved. ');
  w.say('Saved.');
  assert.equal($('status').textContent, 'Saved.');
});

test('booth page: ACE says it reads about the first 512 characters of the direction', async () => {
  const { $, pick, w } = booth();
  pick('ace');
  w.say('Ready.');
  input(w, $('script'), 'd'.repeat(500));
  assert.equal($('status').textContent, 'Ready.');
  input(w, $('script'), 'd'.repeat(2000));
  assert.equal($('script_count').textContent, '2,000 of 3,000 characters. ACE-Step XL reads about the first 512.');
  assert.equal($('status').textContent, 'ACE-Step XL reads only about the first 512 characters of this. The rest is left out.');
  w.say('Quiet.');
  input(w, $('script'), 'd'.repeat(2001));
  assert.equal($('status').textContent, 'Quiet.', 'said once while it stays past 512');
  input(w, $('script'), 'd'.repeat(100));
  input(w, $('script'), 'd'.repeat(600));
  assert.match($('status').textContent, /^ACE-Step XL reads only about the first 512/);
  /* The number is ace.ts's own. */
  assert.ok(read('../../../packages/api/src/music/ace.ts').includes(`const CAPTION_LIMIT = ${LIMITS.aceCaption};`));
});

test('booth page: a paste with no room is said, and a paste the page sorted itself is not', async () => {
  const { $, pick, w } = booth();
  pick('yue2');
  input(w, $('script'), 'f'.repeat(3000));
  w.say('Ready.');
  pasteInto(w, $('script'), 'another paragraph');
  await tick();
  assert.equal($('status').textContent, 'Nothing was pasted. The box is at the limit: 3,000 characters for YuE2.');
  w.say('Ready.');
  const sorted = pasteInto(w, $('script'), 'a song');
  sorted.preventDefault();
  await tick();
  assert.equal($('status').textContent, 'Ready.');
  /* A paste that went in, cut, is said by the input that follows it, once. */
  input(w, $('script'), 'f'.repeat(2990));
  pasteInto(w, $('script'), 'g'.repeat(50));
  input(w, $('script'), 'f'.repeat(3000));
  await tick();
  assert.equal($('status').textContent, 'Cut to fit the limit: 3,000 characters for YuE2.');
});

test('booth page: the sentences read well whatever the box is called', async () => {
  const { $, pick, w } = booth();
  pick('scenema', false, { voice_description: 'v'.repeat(620) });
  w.applyCaps(false);
  w.say('AuK HQ.');
  await tick();
  assert.equal($('status').textContent, 'AuK HQ. Describe a new voice: 20 characters over the limit of 600 for AuK HQ. Your words are kept. Anything past 600 will be cut off.');
});

test('booth page: a note found while the page speaks goes out in that one sentence', async () => {
  const { $, pick, w } = booth();
  pick('yue2', false, { lyrics: 'la '.repeat(2000) });
  await tick();
  let writes = 0;
  new w.MutationObserver((m) => { writes += m.length; }).observe($('status'), { childList: true, characterData: true, subtree: true });
  pick('ace', false, { lyrics: 'la '.repeat(2000) });
  w.say('ACE-Step XL picked.');
  await tick();
  assert.equal(writes, 1, 'the live region changed once');
  assert.match($('status').textContent, /^ACE-Step XL picked\. Lyrics: 1,904 characters over/);
});

test('booth page: at the limit is said once, not after every typo fixed in a full box', () => {
  const { $, pick, w } = booth();
  pick('yue2');
  input(w, $('script'), 'a'.repeat(3000));
  assert.match($('status').textContent, /^That is the limit/);
  w.say('Quiet.');
  input(w, $('script'), 'a'.repeat(2999));
  input(w, $('script'), 'a'.repeat(3000));
  input(w, $('script'), 'a'.repeat(2998));
  input(w, $('script'), 'a'.repeat(3000));
  assert.equal($('status').textContent, 'Quiet.');
  /* Well under the limit, or leaving the box, and it is said again. */
  input(w, $('script'), 'a'.repeat(2900));
  input(w, $('script'), 'a'.repeat(3000));
  assert.match($('status').textContent, /^That is the limit/);
  w.say('Quiet.');
  input(w, $('script'), 'a'.repeat(2999));
  $('script').dispatchEvent(new w.Event('blur'));
  input(w, $('script'), 'a'.repeat(3000));
  assert.match($('status').textContent, /^That is the limit/);
});

/* ---------- the Open voices panel ---------- */

const ALL = { voxcpm: true, ming: true, mingControls: true, chatterbox: true, dramabox: true };
const OV_LIMITS = { text: ov.MAX_TEXT, style: ov.MAX_STYLE, name: ov.MAX_NAME, idea: writer.MAX_IDEA, clipWords: ov.MAX_CLIP_WORDS };

function panel() {
  const dom = new JSDOM(`<!doctype html><body><p id="status" role="status"></p>${OPEN_VOICES_HTML}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.getToken = async () => 'tok';
  w.AbortSignal.timeout = () => undefined;
  w.fetch = async (url) => (url.endsWith('/open-voices')
    ? { ok: true, status: 200, json: async () => ({ engines: ov.engineList(ALL), voices: [], coldNote: 'cold', limits: OV_LIMITS }) }
    : { ok: false, status: 400, json: async () => ({ error: 'no' }) });
  w.eval(OPEN_VOICES_SCRIPT.replace(/^\s*<script>|<\/script>\s*$/g, ''));
  const $ = (id) => w.document.getElementById(id);
  const pick = (id) => { $('ovEngine').value = id; $('ovEngine').onchange(); };
  return { w, $, pick, ready: async () => { for (let i = 0; i < 40 && $('openVoicesDrawer').hidden; i++) await tick(); } };
}

test('the route sends the panel its limits from the constants it checks', () => {
  assert.match(read('kadeSoundBoothOpenVoices.js'), /limits: \{ text: MAX_TEXT, style: MAX_STYLE, name: MAX_NAME, idea: writer\.MAX_IDEA, clipWords: MAX_CLIP_WORDS \}/);
  assert.equal(ov.MAX_CLIP_WORDS, 1000);
  /* The writer's own idea of each engine's length is the engine list's. */
  for (const e of ov.engineList(ALL)) assert.equal(writer.engineShape({ engine: e.id, mode: 'design' }).maxText, e.maxText, e.id);
  /* Hints that name a number name the real one. */
  for (const e of ov.engineList(ALL)) assert.ok(e.textHint.includes(`Up to ${e.maxText.toLocaleString('en-US')} characters.`), e.id);
});

test('Open voices: Words to say and Describe the voice take each engine\'s limit, with a count', async () => {
  const p = panel(); const { $, pick } = p;
  await p.ready();
  const by = Object.fromEntries(ov.engineList(ALL).map((e) => [e.id, e]));
  for (const id of ['voxcpm', 'ming', 'chatterbox', 'dramabox']) {
    pick(id);
    assert.equal($('ovText').maxLength, by[id].maxText, id);
    assert.equal($('ovText_count').textContent, `0 of ${by[id].maxText.toLocaleString('en-US')} characters.`);
  }
  assert.deepEqual([by.voxcpm.maxText, by.ming.maxText, by.dramabox.maxText], [5000, 2500, 4000]);
  pick('voxcpm'); assert.equal($('ovDescription').maxLength, 400);
  pick('ming'); assert.equal($('ovDescription').maxLength, 600);
  assert.equal($('ovDescription').getAttribute('aria-describedby'), 'ovDescriptionHint ovDescription_limit');
  /* Its hint already says "Up to N characters", so the limit line is not read a second time. */
  assert.equal($('ovText').getAttribute('aria-describedby'), 'ovTextHint');
  assert.equal($('ovStyle').maxLength, 400);
  assert.equal($('ovIdea').maxLength, 3000);
  assert.equal($('ovClipWords').maxLength, 1000);
  assert.equal($('ovIdea_count').textContent, '0 of 3,000 characters.');
  /* Chatterbox takes no description: the hidden box has no count to read. */
  pick('chatterbox');
  assert.equal($('ovDescription_count'), null);
  p.w.close();
});

test('Open voices: switching to Ming keeps words over its 2,500 and says so; a paste cut to fit is said', async () => {
  const p = panel(); const { $, pick, w } = p;
  await p.ready();
  pick('voxcpm');
  $('ovText').value = 'w'.repeat(3000);
  $('ovText').dispatchEvent(new w.Event('input'));
  pick('ming');
  await tick();
  assert.equal($('ovText').value.length, 3000, 'her words are kept');
  assert.equal($('ovText').maxLength, 2500);
  assert.equal($('ovText_count').textContent, '3,000 of 2,500 characters, 500 over.');
  assert.match($('status').textContent, /Words to say: 500 characters over the limit of 2,500 for Ming\. Your words are kept\. It will be refused until it is shorter\.$/);
  assert.match($('status').textContent, /^Ming/, 'the engine\'s own sentence is kept first');
  /* A paste the box cut to fit. The browser's maxlength does the cutting; the page says it. */
  $('ovText').value = '';
  $('ovText').dispatchEvent(new w.Event('input'));
  const paste = new w.Event('paste');
  paste.clipboardData = { getData: () => 'v'.repeat(2600) };
  $('ovText').dispatchEvent(paste);
  $('ovText').value = 'v'.repeat(2500);
  $('ovText').dispatchEvent(new w.Event('input'));
  assert.equal($('status').textContent, 'Cut to fit the limit: 2,500 characters for Ming.');
  p.w.close();
});

test('the writer says when its words were cut to the engine\'s limit', () => {
  const req = { engine: 'ming', how: 'write', shape: writer.engineShape({ engine: 'ming', mode: 'design' }) };
  const long = writer.parseWriterReply('WORDS: ' + 'word '.repeat(700), req);
  assert.equal(long.cutTo, 2500);
  assert.ok(long.text.length <= 2500);
  assert.equal(writer.parseWriterReply('WORDS: A short line.', req).cutTo, undefined);
  assert.match(read('kadeSoundBoothOpenVoices.js'), /Cut to the \$\{got\.cutTo\.toLocaleString\('en-US'\)\} characters \$\{ask\.shape\.name\} takes\./);
});

test('Open voices: the panel-wide limits name no engine, and an engine switch changes the live region once', async () => {
  const p = panel(); const { $, pick, w } = p;
  await p.ready();
  pick('voxcpm');
  $('ovStyle').value = 's'.repeat(405);
  $('ovIdea').value = 'i'.repeat(3010);
  $('ovText').value = 'w'.repeat(3000);
  pick('voxcpm');
  await tick();
  assert.equal($('ovStyle_count').textContent, '405 of 400 characters, 5 over.', 'Style sits in the speak section, hidden here: counted, said when shown');
  assert.match($('status').textContent, /The idea box: 10 characters over the limit of 3,000\. Your words are kept\. Anything past 3,000 will be cut off\./);
  assert.doesNotMatch($('status').textContent, /Open voices takes|the writer takes/);
  let writes = 0;
  new w.MutationObserver((m) => { writes += m.length; }).observe($('status'), { childList: true, characterData: true, subtree: true });
  pick('ming');
  await tick();
  assert.equal(writes, 1, 'the engine sentence and the note are one change');
  assert.match($('status').textContent, /^Ming.*Words to say: 500 characters over the limit of 2,500 for Ming\./);
  /* A paste into a full box: nothing goes in, no input event comes, and it is said. */
  $('ovText').value = 'w'.repeat(2500);
  $('ovText').dispatchEvent(new w.Event('input'));
  const e = new w.Event('paste', { cancelable: true });
  e.clipboardData = { getData: () => 'one more paragraph' };
  $('ovText').dispatchEvent(e);
  await tick();
  assert.equal($('status').textContent, 'Nothing was pasted. The box is at the limit: 2,500 characters for Ming.');
  p.w.close();
});
