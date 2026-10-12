'use strict';
/* Oct 11 2026: Describe the sound of the recording, on the Sound Booth page, without a browser.
 *
 * The page is built the way the server builds it (kadeSoundBoothPage.js in a vm), every inline script is compiled, and the
 * page's own functions are cut out and run against a small stand-in for the page around them, the way
 * kadeSoundBoothPage.nodetest.js does. soundBoothDescribePage.selftest.cjs drives the same page in a real browser.
 *
 * What is proved here:
 *   - KADE_DESCRIBE_SOUND=0: the page is the flag-on page with exactly the feature's four pieces taken out, and none of the
 *     feature's words are in it (soundBoothDescribePage.selftest.cjs and the release notes carry the comparison with the
 *     page before this change, byte for byte).
 *   - the Music direction box is filled when it is empty or still holds what this feature wrote, never when she typed;
 *   - the explicit button always replaces the box, announces it, and Undo writing change restores the box;
 *   - the buttons are real buttons with text labels, a hint that names them, and no id is used twice.
 *
 * Run: node --test api/server/routes/kadeSoundBoothDescribePage.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pageParts, describeSoundEnabled } = require('./kadeSoundBoothDescribe');

function buildPage(flag) {
  const saved = process.env.KADE_DESCRIBE_SOUND;
  if (flag === undefined) delete process.env.KADE_DESCRIBE_SOUND;
  else process.env.KADE_DESCRIBE_SOUND = flag;
  try {
    const context = {
      module: { exports: {} },
      require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
    return context.module.exports.soundBoothHtml;
  } finally {
    if (saved === undefined) delete process.env.KADE_DESCRIBE_SOUND;
    else process.env.KADE_DESCRIBE_SOUND = saved;
  }
}
const on = buildPage(undefined);
const off = buildPage('0');
const parts = pageParts({});
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* The page's own function, cut out by its braces and run as a browser would. */
function pageFunction(html, name) {
  const main = scriptsOf(html).find((s) => s.includes('function ' + name + '('));
  assert.ok(main, name + ' is on the page');
  const start = main.indexOf((main.indexOf('async function ' + name + '(') >= 0 ? 'async ' : '') + 'function ' + name + '(');
  let depth = 0;
  for (let i = main.indexOf('{', start); i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('every inline script compiles with the feature on and off, and no backspace character crept in', () => {
  for (const html of [on, off]) {
    assert.ok(scriptsOf(html).length >= 1);
    for (const s of scriptsOf(html)) new Function(s);
    assert.equal(html.includes('\b'), false);
  }
});

test('the four pieces of page source carry no backslash, no backtick and no template placeholder', () => {
  for (const [name, piece] of Object.entries(parts)) {
    assert.ok(piece.length > 0, name);
    assert.doesNotMatch(piece, /[\\`]|\$\{/, name + ' is spliced by interpolation and must not need escaping');
  }
});

test('KADE_DESCRIBE_SOUND=0: no piece of the feature is on the page, and the page is the flag-on page without exactly those four pieces', () => {
  assert.deepEqual(pageParts({ KADE_DESCRIBE_SOUND: '0' }), { button: '', heard: '', said: '', functions: '' });
  for (const piece of Object.values(parts)) assert.equal(off.includes(piece), false);
  assert.doesNotMatch(off, /btnDescribe|describeHint|heardSound|describeSound|data-auto-direction|Describe the sound of the recording|reference\/describe/);
  let rebuilt = on;
  for (const piece of [parts.functions, parts.button, parts.heard]) {
    assert.equal(rebuilt.split(piece).length, 2, 'each piece is on the page exactly once');
    rebuilt = rebuilt.replace(piece, '');
  }
  assert.equal(rebuilt.split('heard);').length > 0, true);
  rebuilt = rebuilt.replace('say(result.data.warning' + parts.said + ');', 'say(result.data.warning);');
  assert.equal(rebuilt, off, 'nothing else differs');
});

test('unset, 1, empty or any other value than 0 is on; only the string 0 is off', () => {
  assert.equal(describeSoundEnabled({}), true);
  assert.equal(describeSoundEnabled({ KADE_DESCRIBE_SOUND: '0' }), false);
  for (const value of ['1', '', 'false', 'off', ' 0', 'true']) assert.equal(describeSoundEnabled({ KADE_DESCRIBE_SOUND: value }), true, JSON.stringify(value));
  assert.equal(buildPage('1'), on);
  assert.equal(buildPage(''), on);
  assert.equal(buildPage('false'), on);
  assert.notEqual(buildPage('0'), on);
});

test('a harness that stubs every require with one fixed object still gets a working page, without the feature', () => {
  const context = { module: { exports: {} }, require: () => ({ SHARED_HEAD: '' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  const stubbed = context.module.exports.soundBoothHtml;
  for (const s of scriptsOf(stubbed)) new Function(s);
  assert.doesNotMatch(stubbed, /btnDescribe|heardSound/);
});

test('the guide is not touched: the page reads the Describe button from nowhere but its own source', () => {
  const route = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  const start = route.indexOf('const GUIDE = ');
  const guide = route.slice(start, route.indexOf('\n};', start));
  assert.ok(guide.length > 20000, 'the whole guide was read');
  assert.doesNotMatch(guide, /Describe the sound|describe the sound|btnDescribe|reference\/describe/, 'a client with no such button must not be told about one');
  assert.match(guide, /Transcribe reference lyrics drafts them for you to correct\./, 'the YuE2 how-to line is as it was');
});

/* ---------- the two buttons: real buttons, labelled, one id each ---------- */
test('Describe the sound of the recording: a real button with its text, a hint that names it, and the transcribe button as it was', () => {
  assert.match(parts.button, /<button type="button" class="act" id="btnDescribe" aria-describedby="describeHint">Describe the sound of the recording<\/button>/);
  assert.match(parts.button, /<p class="hint" id="describeHint">Fills Music direction with what the recording sounds like, for a cover in the same style\. Change or clear it to move the cover to another genre\.<\/p>/);
  const block = on.slice(on.indexOf("if(state.engine==='yue2' && state.clips.length){"));
  const lyricsAt = block.indexOf('id="btnLyrics">Transcribe reference lyrics</button>');
  const describeAt = block.indexOf('id="btnDescribe"');
  assert.ok(lyricsAt > 0 && describeAt > lyricsAt && describeAt < lyricsAt + 1500, 'it sits right after the transcribe button, in the same YuE2 cover block');
  assert.ok(block.slice(0, describeAt).indexOf("document.getElementById('btnLyrics').onclick=transcribeLyrics;") > 0);
  assert.match(parts.button, /document\.getElementById\('btnDescribe'\)\.disabled=busy\(\);/, 'disabled while anything else is working, like the transcribe button');
  assert.match(parts.button, /document\.getElementById\('btnDescribe'\)\.onclick=describeSound;/);
  assert.match(on, /<button type="button" class="act" id="btnLyrics">Transcribe reference lyrics<\/button><p class="hint">Free\. Drafts the sung words into Lyrics for you to check/, 'the transcribe button and its hint are untouched');
});

test('no id appears twice on the page, and the feature adds none that already exists', () => {
  const count = (html) => {
    const seen = new Map();
    for (const [, id] of html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) seen.set(id, (seen.get(id) || 0) + 1);
    return seen;
  };
  const withFeature = count(on);
  const without = count(off);
  for (const id of ['btnDescribe', 'describeHint']) assert.equal(withFeature.get(id), 1, id);
  const doubled = (map) => [...map].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(doubled(withFeature), doubled(without), 'the page has no id twice that it did not have before');
  for (const id of ['btnDescribe', 'describeHint']) assert.equal(without.get(id), undefined);
});

/* ---------- the page's functions, run against a stand-in page ---------- */
function stand({ engine = 'yue2', box = '', flag, lyrics = 'old lyrics', clips = [{ url: 'https://assets.test/a.mp3' }], busy = false, flags = {} } = {}) {
  const log = [];
  const element = (id, props = {}) => {
    const el = {
      id, value: '', textContent: '', hidden: false, attrs: {}, listeners: {},
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this)); },
      focus() { log.push('focus:' + id); },
      ...props,
    };
    return el;
  };
  const els = {};
  for (const id of ['script', 'readback', 'btnUndoWriting', 'set_lyrics', 'btnDescribe']) els[id] = element(id);
  els.script.value = box;
  els.script.attrs = flag === undefined ? {} : { 'data-auto-direction': flag };
  els.readback.textContent = 'an old readback';
  els.btnUndoWriting.hidden = true;
  const ctx = {
    state: { engine, values: { lyrics }, clips, writing: false, ...flags },
    document: { getElementById: (id) => els[id] },
    said: [], posts: [], renders: 0, quotes: 0, log, els, writingUndo: null,
    isBusy: busy, nextPost: null,
    record: (list, ...items) => list.push(items),
  };
  vm.runInNewContext(`
    function busy(){ return isBusy || !!state.writing; }
    function referenceReady(){ return true; }
    function say(message, isErr){ record(said, message, !!isErr); }
    function renderSettings(){ renders++; }
    function invalidateQuote(){ quotes++; }
    function focusById(id){ document.getElementById(id).focus(); }
    async function post(path, body){ record(posts, path, JSON.parse(JSON.stringify(body))); return nextPost(); }
    ${parts.functions}
    this.exposed = { directionIsFree, fillDirection, heardSound, describeSound };
  `, ctx);
  ctx.fn = ctx.exposed;
  return ctx;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const LINE = 'English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const FILLED = ' Music direction filled with what the recording sounds like. Change it or clear it if you want a different style.';
const READY = ' A description of the sound is ready, but your Music direction was kept. Choose Describe the sound of the recording to use it.';

test('after Transcribe reference lyrics: an empty Music direction is filled, flagged, and announced', () => {
  for (const empty of ['', '   ', '\n']) {
    const page = stand({ box: empty });
    assert.equal(page.fn.heardSound({ direction: LINE }), FILLED);
    assert.equal(page.els.script.value, LINE);
    assert.equal(page.els.script.attrs['data-auto-direction'], LINE, 'the flag holds the line this feature wrote');
    assert.equal(page.els.readback.textContent, '', 'a readback of the old direction is cleared');
  }
});

test('after Transcribe reference lyrics: text this feature wrote earlier is replaced, because nothing of hers is in it', () => {
  const earlier = 'English, rock, up-tempo, male lead vocal, loud guitars';
  const page = stand({ box: earlier, flag: earlier });
  assert.equal(page.fn.heardSound({ direction: LINE }), FILLED);
  assert.equal(page.els.script.value, LINE);
  assert.equal(page.els.script.attrs['data-auto-direction'], LINE);
});

test('after Transcribe reference lyrics: text she typed is never replaced; she is told a description is ready and which button uses it', () => {
  const mine = 'My own words for a slow blues cover';
  for (const flag of [undefined, '', 'something this feature wrote earlier']) {
    const page = stand({ box: mine, flag });
    assert.equal(page.fn.heardSound({ direction: LINE }), READY);
    assert.equal(page.els.script.value, mine);
    assert.equal(page.els.readback.textContent, 'an old readback', 'nothing about her box changed');
    assert.equal(page.els.script.attrs['data-auto-direction'], flag === undefined ? undefined : flag, 'the flag is not touched either');
  }
});

test('after Transcribe reference lyrics: typing clears the flag, so even a line she edited back to the same words is hers', () => {
  const page = stand({ box: '' });
  page.fn.heardSound({ direction: LINE });
  assert.equal(page.fn.directionIsFree(page.els.script), true);
  page.els.script.value = LINE + ' with more reverb';
  page.els.script.fire('input');
  assert.equal(page.els.script.getAttribute('data-auto-direction'), null, 'the flag is gone once she edits');
  page.els.script.value = LINE;
  assert.equal(page.fn.directionIsFree(page.els.script), false, 'the same words, typed by her, are still hers');
  assert.equal(page.fn.heardSound({ direction: 'English, soul, up-tempo, male lead vocal, horns' }), READY);
  assert.equal(page.els.script.value, LINE);
});

test('after Transcribe reference lyrics: a box changed in any other way no longer matches the flag, so it is hers too', () => {
  const page = stand({ box: '' });
  page.fn.heardSound({ direction: LINE });
  page.els.script.value = 'A starting point loaded from the list';
  assert.equal(page.fn.directionIsFree(page.els.script), false);
  assert.equal(page.fn.heardSound({ direction: LINE }), READY);
});

test('after Transcribe reference lyrics: no description, a plain note, or nonsense never touches the box', () => {
  const page = stand({ box: '' });
  assert.equal(page.fn.heardSound({}), '');
  assert.equal(page.fn.heardSound({ direction: '   ' }), '');
  assert.equal(page.fn.heardSound({ direction: 42 }), '');
  assert.equal(page.fn.heardSound({ direction_note: 'I could not describe the sound this time; type it yourself.' }), ' I could not describe the sound this time; type it yourself.');
  assert.equal(page.fn.heardSound({ direction_note: '  ' }), '');
  assert.equal(page.fn.heardSound({ direction: '', direction_note: 'The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.' }), ' The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.');
  assert.equal(page.els.script.value, '');
  assert.equal(page.els.script.getAttribute('data-auto-direction'), null);
  const typed = stand({ box: 'mine' });
  assert.equal(typed.fn.heardSound({ direction_note: 'a note' }), ' a note');
  assert.equal(typed.els.script.value, 'mine');
});

/* transcribeLyrics as the page runs it, with the pieces in place (and out of place with the flag off). */
async function transcribe(html, response, boxValue, flag) {
  const els = {};
  const ids = ['script', 'readback', 'btnUndoWriting', 'set_lyrics'];
  const log = [];
  for (const id of ids) els[id] = { id, value: '', textContent: '', hidden: true, attrs: {}, listeners: {}, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, setAttribute(n, v) { this.attrs[n] = String(v); }, removeAttribute(n) { delete this.attrs[n]; }, addEventListener() {}, focus() { log.push('focus:' + id); } };
  els.script.value = boxValue;
  if (flag !== undefined) els.script.attrs['data-auto-direction'] = flag;
  const ctx = {
    state: { engine: 'yue2', values: { lyrics: 'old lyrics' }, clips: [{ url: 'https://assets.test/a.mp3' }] },
    document: { getElementById: (id) => els[id] }, said: [], log, els, writingUndo: undefined, quotes: 0, renders: 0,
    response, record: (list, ...items) => list.push(items),
  };
  const source = [pageFunction(html, 'transcribeLyrics')];
  if (html === on) for (const name of ['directionBox', 'directionIsFree', 'fillDirection', 'heardSound']) source.push(pageFunction(html, name));
  vm.runInNewContext(`
    var writingUndo;
    function busy(){ return false; }
    function referenceReady(){ return true; }
    function say(message, isErr){ record(said, message, !!isErr); }
    function renderSettings(){ renders++; }
    function invalidateQuote(){ quotes++; }
    async function post(){ return response; }
    ${source.join('\n')}
    this.run = transcribeLyrics;
  `, ctx);
  await ctx.run();
  return ctx;
}
const WARNING = 'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words.';
const ANSWER = (extra = {}) => ({ ok: true, status: 200, data: { transcript: '[Verse]\nSome made-up words', warning: WARNING, cached: false, ...extra } });

test('Transcribe reference lyrics with the feature on: the lyrics, the filled direction, one announcement, and the old undo still holds both', async () => {
  const page = await transcribe(on, ANSWER({ direction: LINE }), '', undefined);
  assert.equal(page.state.values.lyrics, '[Verse]\nSome made-up words');
  assert.equal(page.els.script.value, LINE);
  assert.deepEqual(page.said.slice(1), [[WARNING + FILLED, false]], 'one sentence in the one status line: the warning first, then the fill');
  assert.equal(page.said[0][0], 'Listening for the sung words. Your current lyrics are kept until the draft is ready.');
  assert.equal(page.els.btnUndoWriting.hidden, false);
  assert.deepEqual(page.log, ['focus:set_lyrics'], 'focus lands on the lyrics, as before');
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: '', lyrics: 'old lyrics' }, 'Undo writing change brings back the direction she had and her lyrics');
  assert.ok(page.quotes >= 1 && page.renders >= 1);
});

test('Transcribe reference lyrics with the feature on: typed text is kept and the button is named', async () => {
  const page = await transcribe(on, ANSWER({ direction: LINE }), 'My slow blues idea', undefined);
  assert.equal(page.els.script.value, 'My slow blues idea');
  assert.deepEqual(page.said.slice(1), [[WARNING + READY, false]]);
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: 'My slow blues idea', lyrics: 'old lyrics' });
});

test('Transcribe reference lyrics with the feature on: a note when no description could be made; the lyrics still land', async () => {
  const note = 'I could not describe the sound this time; type it yourself.';
  const page = await transcribe(on, ANSWER({ direction_note: note }), '', undefined);
  assert.equal(page.state.values.lyrics, '[Verse]\nSome made-up words');
  assert.equal(page.els.script.value, '');
  assert.deepEqual(page.said.slice(1), [[WARNING + ' ' + note, false]]);
});

test('Transcribe reference lyrics from an older server (no direction at all): exactly the old sentence', async () => {
  const page = await transcribe(on, ANSWER(), '', undefined);
  assert.deepEqual(page.said.slice(1), [[WARNING, false]]);
  assert.equal(page.els.script.value, '');
});

test('Transcribe reference lyrics with the feature off: the page ignores a direction even if a server sent one, and says only the old sentence', async () => {
  const page = await transcribe(off, ANSWER({ direction: LINE }), '', undefined);
  assert.deepEqual(page.said.slice(1), [[WARNING, false]]);
  assert.equal(page.els.script.value, '');
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: '', lyrics: 'old lyrics' });
});

test('Transcribe reference lyrics when the lyrics fail: the old error, the box untouched', async () => {
  const page = await transcribe(on, { ok: false, status: 502, data: { error: 'Could not transcribe this recording.' } }, '', undefined);
  assert.deepEqual(page.said.slice(1), [['Could not transcribe this recording.', true]]);
  assert.equal(page.els.script.value, '');
});

/* ---------- the explicit button ---------- */
test('Describe the sound of the recording replaces what is in the box, even her own text, and announces it', async () => {
  for (const [box, flag] of [['', undefined], ['My own direction', undefined], ['an earlier auto line', 'an earlier auto line']]) {
    const page = stand({ box });
    page.els.script.attrs = flag === undefined ? {} : { 'data-auto-direction': flag };
    page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE, cached: false } });
    await page.fn.describeSound();
    assert.deepEqual(plain(page.posts), [['/api/kade/sound-booth/reference/describe', { url: 'https://assets.test/a.mp3' }]]);
    assert.equal(page.els.script.value, LINE, 'always replaced: this is an explicit request');
    assert.equal(page.els.script.attrs['data-auto-direction'], LINE);
    assert.equal(page.els.readback.textContent, '');
    assert.equal(page.said.at(-1)[1], false);
    assert.equal(page.said.at(-1)[0], 'Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre. Undo writing change brings back your previous direction.');
    assert.equal(page.said[0][0], 'Listening to how the recording sounds. Your Music direction is kept until the description is ready.', 'she hears that it is working');
    assert.equal(page.els.btnUndoWriting.hidden, false, 'the existing Undo writing change button is offered');
    assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: box }, 'Undo restores the direction and leaves the lyrics alone (no lyrics key)');
    assert.equal(page.state.writing, false, 'busy again only while it works');
    assert.equal(page.state.values.lyrics, 'old lyrics', 'the lyrics are never touched');
    assert.ok(page.log.includes('focus:script'), 'focus goes to the Music direction box she can now read and edit');
    assert.ok(page.quotes >= 1, 'the quote is invalidated, as for any change to the direction');
  }
});

test('Describe the sound of the recording: while it works the page is busy and the settings are redrawn; afterwards they are redrawn again', async () => {
  const page = stand({ box: '' });
  let seenBusy = null;
  page.nextPost = async () => { seenBusy = page.state.writing; return { ok: true, status: 200, data: { direction: LINE } }; };
  await page.fn.describeSound();
  assert.equal(seenBusy, true, 'busy while the request is out, so no render or second press can start');
  assert.ok(page.renders >= 2);
});

test('Describe the sound of the recording does nothing while anything else is working, or with no recording', async () => {
  const busyPage = stand({ box: 'mine', busy: true });
  busyPage.nextPost = async () => { throw new Error('must not be called'); };
  await busyPage.fn.describeSound();
  assert.deepEqual(busyPage.posts, []);
  assert.deepEqual(busyPage.said, []);
  const empty = stand({ box: 'mine', clips: [] });
  empty.nextPost = async () => { throw new Error('must not be called'); };
  await empty.fn.describeSound();
  assert.deepEqual(empty.posts, []);
  assert.equal(empty.els.script.value, 'mine');
});

test('Describe the sound of the recording that fails: her box is kept, nothing to undo, the error is said, and focus returns to the button', async () => {
  for (const response of [
    { ok: false, status: 502, data: { error: 'I could not describe the sound this time. Your Music direction is kept; type it yourself.' } },
    { ok: false, status: 0, data: { error: 'Connection lost. Check the library before retrying a render; it may still be working.' } },
    { ok: true, status: 200, data: {} },
    { ok: true, status: 200, data: { direction: '   ' } },
  ]) {
    const page = stand({ box: 'My own direction' });
    page.nextPost = async () => response;
    await page.fn.describeSound();
    assert.equal(page.els.script.value, 'My own direction');
    assert.equal(page.writingUndo, null, 'no Undo is armed for a change that did not happen');
    assert.equal(page.els.btnUndoWriting.hidden, true);
    assert.equal(page.state.writing, false);
    const [message, isErr] = page.said.at(-1);
    assert.equal(isErr, true);
    assert.equal(message, (response.data && response.data.error) || 'I could not describe the sound this time. Your Music direction is kept; type it yourself.');
    assert.equal(page.log.at(-1), 'focus:btnDescribe', 'focus is on the button again, not lost');
  }
});

test('Describe the sound of the recording: if the recording or the engine changed while it worked, nothing is written', async () => {
  const page = stand({ box: 'mine' });
  page.nextPost = async () => { page.state.clips = [{ url: 'https://assets.test/other.mp3' }]; return { ok: true, status: 200, data: { direction: LINE } }; };
  await page.fn.describeSound();
  assert.equal(page.els.script.value, 'mine');
  assert.equal(page.state.writing, false);
  const moved = stand({ box: 'mine' });
  moved.nextPost = async () => { moved.state.engine = 'lyria'; return { ok: true, status: 200, data: { direction: LINE } }; };
  await moved.fn.describeSound();
  assert.equal(moved.els.script.value, 'mine');
  assert.equal(moved.writingUndo, null);
});

test('the existing Undo writing change handler restores the direction a description replaced, and leaves lyrics undefined alone', () => {
  const handler = on.match(/document\.getElementById\('btnUndoWriting'\)\.onclick=function\(\)\{([\s\S]*?)\n    \};/)[1];
  assert.match(handler, /document\.getElementById\('script'\)\.value=writingUndo\.text;/);
  assert.match(handler, /if\(writingUndo\.lyrics!==undefined\)\{state\.values\.lyrics=writingUndo\.lyrics;renderSettings\(\);\}/, 'a describe-only undo has no lyrics key, so lyrics are not rewritten');
  assert.match(handler, /if\(busy\(\) \|\| !writingUndo \|\| writingUndo\.engine!==state\.engine\)return;/);
});
