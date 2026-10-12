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

test('the pieces of page source carry no backslash, no backtick and no template placeholder', () => {
  assert.deepEqual(Object.keys(parts), ['ask', 'hint', 'button', 'top', 'rearm', 'hold', 'settle', 'heard', 'ahead', 'functions']);
  for (const [name, piece] of Object.entries(parts)) {
    assert.ok(piece.length > 0, name);
    assert.doesNotMatch(piece, /[\\`]|\$\{/, name + ' is spliced by interpolation and must not need escaping');
  }
});

test('KADE_DESCRIBE_SOUND=0: no piece of the feature is on the page, and the page is the flag-on page without exactly those pieces', () => {
  const none = Object.fromEntries(Object.keys(parts).map((name) => [name, '']));
  assert.deepEqual(pageParts({ KADE_DESCRIBE_SOUND: '0' }), none);
  for (const piece of Object.values(parts)) assert.equal(off.includes(piece), false);
  assert.doesNotMatch(off, /btnDescribe|describeHint|heardSound|describeSound|data-auto-direction|Describe the sound of the recording|reference\/describe|describe:true|holdWith|releaseHold|settleFocus|earlierUndo|keepEarlier|nameCover|focusedId|Also fills an empty Music direction/);
  /* the settle piece is on the page twice (a stale answer and a failed one); every other piece once */
  const times = { settle: 2 };
  let rebuilt = on;
  for (const [name, piece] of Object.entries(parts).sort((x, y) => y[1].length - x[1].length)) {
    assert.equal(rebuilt.split(piece).length - 1, times[name] || 1, name + ' is on the page the expected number of times');
    rebuilt = rebuilt.split(piece).join('');
  }
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
  assert.match(parts.button, /<p class="hint" id="describeHint">Free. Fills Music direction with what the recording sounds like, for a cover in the same style\. Change or clear it to move the cover to another genre\.<\/p>/);
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
const IDS = ['script', 'readback', 'btnUndoWriting', 'set_lyrics', 'btnDescribe', 'btnLyrics', 'btnDraft', 'btnInspire', 'trackTitle'];
const COVER = { url: 'https://assets.test/a.mp3', name: 'cover.mp3' };
/** A tiny page: elements by id, an activeElement that a rebuild (renderSettings) drops to the body, and a log of focus calls. */
function makePage({ box = '', flag, title = '', focus = '', clips = [COVER], lyrics = 'old lyrics', engine = 'yue2' } = {}) {
  const log = [];
  const body = { id: '' };
  const document = { activeElement: body, body, getElementById: (id) => els[id] };
  const els = {};
  for (const id of IDS) {
    els[id] = {
      id, value: '', textContent: '', hidden: false, disabled: false, readOnly: false, attrs: {}, listeners: {},
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this)); },
      focus() { log.push('focus:' + id); document.activeElement = this; },
    };
  }
  els.script.value = box;
  if (flag !== undefined) els.script.attrs['data-auto-direction'] = flag;
  els.readback.textContent = 'an old readback';
  els.btnUndoWriting.hidden = true;
  els.trackTitle.value = title;
  if (focus) document.activeElement = els[focus];
  return { log, els, body, document, state: { engine, values: { lyrics }, clips, writing: false } };
}

function stand(options = {}) {
  const { busy = false } = options;
  const page = makePage(options);
  const ctx = {
    state: page.state, document: page.document,
    said: [], posts: [], renders: 0, quotes: 0, controls: 0, log: page.log, els: page.els, writingUndo: options.undo === undefined ? null : options.undo,
    isBusy: busy, nextPost: null, snapshots: [],
    record: (list, ...items) => list.push(items),
  };
  vm.runInNewContext(`
    function busy(){ return isBusy || !!state.writing; }
    function referenceReady(){ return true; }
    function say(message, isErr){ record(said, message, !!isErr); }
    function renderSettings(){ renders++; if (['btnLyrics', 'btnDescribe', 'set_lyrics'].indexOf(document.activeElement.id) >= 0) document.activeElement = document.body; }
    function invalidateQuote(){ quotes++; }
    function updateRenderControls(){ controls++; }
    function focusById(id){ var el=document.getElementById(id); if(el) el.focus(); }
    async function post(path, body){ record(posts, path, JSON.parse(JSON.stringify(body))); snapshots.push({ activeElement: document.activeElement.id, writing: state.writing, readOnly: els.script.readOnly, renders: renders, lyricsDisabled: els.btnLyrics.disabled, describeAria: els.btnDescribe.attrs['aria-disabled'] || null, draftDisabled: els.btnDraft.disabled, inspireDisabled: els.btnInspire.disabled }); return nextPost(); }
    ${parts.functions}
    this.exposed = { directionIsFree, fillDirection, heardSound, describeSound, nameCover, earlierUndo, keepEarlier, holdWith, releaseHold, settleFocus, focusedId };
  `, ctx);
  ctx.fn = ctx.exposed;
  ctx.page = page;
  return ctx;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const LINE = 'English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const FILLED = 'Music direction filled with what the recording sounds like. Change it or clear it if you want a different style.';
const NAMED = ' Track title: cover (cover).';
const READY = 'A description of the sound is ready, but your Music direction was kept. Choose Describe the sound of the recording to use it.';

test('after Transcribe reference lyrics: an empty Music direction is filled, flagged, and announced', () => {
  for (const empty of ['', '   ', '\n']) {
    const page = stand({ box: empty });
    assert.equal(page.fn.heardSound({ direction: LINE }), FILLED + NAMED);
    assert.equal(page.els.script.value, LINE);
    assert.equal(page.els.script.attrs['data-auto-direction'], LINE, 'the flag holds the line this feature wrote');
    assert.equal(page.els.readback.textContent, '', 'a readback of the old direction is cleared');
  }
});

test('after Transcribe reference lyrics: text this feature wrote earlier is replaced, because nothing of hers is in it', () => {
  const earlier = 'English, rock, up-tempo, male lead vocal, loud guitars';
  const page = stand({ box: earlier, flag: earlier });
  assert.equal(page.fn.heardSound({ direction: LINE }), FILLED + NAMED);
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
    assert.equal(page.els.trackTitle.value, '', 'and the title is not named after a fill that did not happen');
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
  assert.equal(page.fn.heardSound({ direction_note: 'I could not describe the sound this time; type it yourself.' }), 'I could not describe the sound this time; type it yourself.');
  assert.equal(page.fn.heardSound({ direction_note: '  ' }), '');
  assert.equal(page.fn.heardSound({ direction: '', direction_note: 'The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.' }), 'The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.');
  assert.equal(page.els.script.value, '');
  assert.equal(page.els.script.getAttribute('data-auto-direction'), null);
  assert.equal(page.els.trackTitle.value, '', 'no fill, no title');
  const typed = stand({ box: 'mine' });
  assert.equal(typed.fn.heardSound({ direction_note: 'a note' }), 'a note');
  assert.equal(typed.els.script.value, 'mine');
});

/* ---------- an untitled cover is named after its recording ---------- */
test('an untitled cover is named after its recording when the box is filled, the sentence says so, and Undo can give the empty title back', () => {
  const page = stand({ box: '', undo: { engine: 'yue2', text: '', lyrics: 'old lyrics' } });
  assert.equal(page.fn.heardSound({ direction: LINE }), FILLED + NAMED);
  assert.equal(page.els.trackTitle.value, 'cover (cover)', 'the extension is gone; "(cover)" is what Cover this take adds');
  assert.equal(page.state.coverTitle, 'cover (cover)');
  assert.equal(page.writingUndo.title, '', 'Undo brings back the empty title');
  assert.equal(page.writingUndo.generatedTitle, 'cover (cover)', 'and only if it is still the one this feature wrote');
});

test('a title she wrote is never replaced, and one she changed after the fill is hers', () => {
  const mine = stand({ box: '', title: 'My porch song' });
  assert.equal(mine.fn.heardSound({ direction: LINE }), FILLED);
  assert.equal(mine.els.trackTitle.value, 'My porch song');
  const edited = stand({ box: '', title: 'cover (cover) take two' });
  edited.state.coverTitle = 'cover (cover)';
  assert.equal(edited.fn.heardSound({ direction: LINE }), FILLED);
  assert.equal(edited.els.trackTitle.value, 'cover (cover) take two');
});

test('a title this feature wrote is replaced when the recording changes, so a new cover is not named after the old one', () => {
  const page = stand({ box: '', title: 'cover (cover)', clips: [{ url: 'https://assets.test/b.mp3', name: 'second song.wav' }] });
  page.state.coverTitle = 'cover (cover)';
  assert.equal(page.fn.heardSound({ direction: LINE }), FILLED + ' Track title: second song (cover).');
  assert.equal(page.els.trackTitle.value, 'second song (cover)');
});

test('the cover title is at most 80 characters, keeps a name that has a dot but no extension, and is not made from nothing', () => {
  const long = stand({ box: '', clips: [{ url: 'https://assets.test/c.mp3', name: 'x'.repeat(200) + '.mp3' }] });
  long.fn.heardSound({ direction: LINE });
  assert.equal(long.els.trackTitle.value.length, 79);
  assert.ok(long.els.trackTitle.value.endsWith(' (cover)'));
  const dotted = stand({ box: '', clips: [{ url: 'https://assets.test/d.mp3', name: 'Mr. Blue Sky' }] });
  dotted.fn.heardSound({ direction: LINE });
  assert.equal(dotted.els.trackTitle.value, 'Mr. Blue Sky (cover)');
  const linked = stand({ box: '', clips: [{ url: 'https://assets.test/e.mp3', name: 'Linked song' }] });
  linked.fn.heardSound({ direction: LINE });
  assert.equal(linked.els.trackTitle.value, 'Linked song (cover)');
  const nameless = stand({ box: '', clips: [{ url: 'https://assets.test/f.mp3', name: '' }] });
  assert.equal(nameless.fn.heardSound({ direction: LINE }), FILLED);
  assert.equal(nameless.els.trackTitle.value, '');
});

/* transcribeLyrics as the page runs it, with the pieces in place (and out of place with the flag off). `options.during(state)` runs while the request is out. */
async function transcribeRun(html, response, options = {}) {
  const page = makePage(options);
  const sandbox = {
    state: page.state, document: page.document, said: [], log: page.log, els: page.els,
    quotes: 0, renders: 0, controls: 0, posts: [], snapshots: [], response, record: (list, ...items) => list.push(items), isBusy: false, options,
  };
  if (options.coverTitle) page.state.coverTitle = options.coverTitle;
  const source = [pageFunction(html, 'transcribeLyrics')];
  if (html === on) for (const name of ['directionBox', 'directionIsFree', 'fillDirection', 'heardSound', 'focusedId', 'earlierUndo', 'keepEarlier', 'holdWith', 'releaseHold', 'settleFocus', 'nameCover']) source.push(pageFunction(html, name));
  vm.runInNewContext(`
    var writingUndo = options.undo === undefined ? undefined : options.undo;
    function busy(){ return isBusy || !!state.writing; }
    function referenceReady(){ return true; }
    function say(message, isErr){ record(said, message, !!isErr); }
    function renderSettings(){ renders++; if (['btnLyrics', 'btnDescribe', 'set_lyrics'].indexOf(document.activeElement.id) >= 0) document.activeElement = document.body; }
    function invalidateQuote(){ quotes++; }
    function updateRenderControls(){ controls++; }
    function focusById(id){ var el=document.getElementById(id); if(el) el.focus(); }
    async function post(path, body){ record(posts, path, JSON.parse(JSON.stringify(body))); snapshots.push({ activeElement: document.activeElement.id, lyricsDisabled: els.btnLyrics.disabled, lyricsAria: els.btnLyrics.attrs['aria-disabled'] || null, describeDisabled: els.btnDescribe.disabled, draftDisabled: els.btnDraft.disabled, inspireDisabled: els.btnInspire.disabled }); if (options.during) options.during(state); return typeof response === 'function' ? response() : response; }
    ${source.join('\n')}
    this.run = transcribeLyrics;
    this.undo = function(){ return writingUndo; };
  `, sandbox);
  await sandbox.run();
  sandbox.writingUndo = sandbox.undo();
  sandbox.page = page;
  return sandbox;
}
const WARNING = 'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words.';
const ANSWER = (extra = {}) => ({ ok: true, status: 200, data: { transcript: '[Verse]\nSome made-up words', warning: WARNING, cached: false, ...extra } });

test('Transcribe reference lyrics with the feature on: asks for the description, fills the direction, and says the fill FIRST in the one status sentence', async () => {
  const page = await transcribeRun(on, ANSWER({ direction: LINE }));
  assert.deepEqual(plain(page.posts), [['/api/kade/sound-booth/reference/lyrics', { url: 'https://assets.test/a.mp3', describe: true }]], 'the page opts in');
  assert.equal(page.state.values.lyrics, '[Verse]\nSome made-up words');
  assert.equal(page.els.script.value, LINE);
  assert.deepEqual(page.said.slice(1), [[FILLED + NAMED + ' ' + WARNING, false]], 'the part about Music direction comes first, so it is not cut off behind the long warning');
  assert.equal(page.said[0][0], 'Listening for the sung words. Your current lyrics are kept until the draft is ready.');
  assert.equal(page.els.btnUndoWriting.hidden, false);
  assert.equal(page.log.at(-1), 'focus:set_lyrics', 'focus lands on the lyrics, as before');
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: '', lyrics: 'old lyrics', title: '', generatedTitle: 'cover (cover)' }, 'Undo writing change brings back the direction and the title she had, and her lyrics');
  assert.ok(page.quotes >= 1 && page.renders >= 1);
});

test('Transcribe reference lyrics with the feature on: typed text is kept and the button is named', async () => {
  const page = await transcribeRun(on, ANSWER({ direction: LINE }), { box: 'My slow blues idea' });
  assert.equal(page.els.script.value, 'My slow blues idea');
  assert.deepEqual(page.said.slice(1), [[READY + ' ' + WARNING, false]]);
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: 'My slow blues idea', lyrics: 'old lyrics' });
});

test('Transcribe reference lyrics with the feature on: a note when no description could be made; the lyrics still land', async () => {
  const note = 'I could not describe the sound this time; type it yourself.';
  const page = await transcribeRun(on, ANSWER({ direction_note: note }));
  assert.equal(page.state.values.lyrics, '[Verse]\nSome made-up words');
  assert.equal(page.els.script.value, '');
  assert.deepEqual(page.said.slice(1), [[note + ' ' + WARNING, false]]);
});

test('Transcribe reference lyrics from an older server (no direction at all): exactly the old sentence', async () => {
  const page = await transcribeRun(on, ANSWER());
  assert.deepEqual(page.said.slice(1), [[WARNING, false]]);
  assert.equal(page.els.script.value, '');
});

test('Transcribe reference lyrics with the feature off: it does not ask, ignores a direction even if a server sent one, and says only the old sentence', async () => {
  const page = await transcribeRun(off, ANSWER({ direction: LINE }));
  assert.deepEqual(plain(page.posts), [['/api/kade/sound-booth/reference/lyrics', { url: 'https://assets.test/a.mp3' }]], 'no opt-in on the switched-off page');
  assert.deepEqual(page.said.slice(1), [[WARNING, false]]);
  assert.equal(page.els.script.value, '');
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: '', lyrics: 'old lyrics' });
});

test('Transcribe reference lyrics when the lyrics fail: the old error, the box untouched', async () => {
  const page = await transcribeRun(on, { ok: false, status: 502, data: { error: 'Could not transcribe this recording.' } });
  assert.deepEqual(page.said.slice(1), [['Could not transcribe this recording.', true]]);
  assert.equal(page.els.script.value, '');
});

/* ---------- Undo: her text survives a second press ---------- */
test('Undo after Describe twice brings back what she typed, not the first description', async () => {
  const page = stand({ box: 'MY OWN TYPED DIRECTION' });
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE } });
  await page.fn.describeSound();
  assert.equal(page.els.script.value, LINE);
  assert.equal(page.writingUndo.text, 'MY OWN TYPED DIRECTION');
  const second = 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ';
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: second } });
  await page.fn.describeSound();
  assert.equal(page.els.script.value, second);
  assert.equal(page.writingUndo.text, 'MY OWN TYPED DIRECTION', 'the slot is not re-armed with the feature\'s own earlier line');
  await page.fn.describeSound();
  assert.equal(page.writingUndo.text, 'MY OWN TYPED DIRECTION', 'nor on a third press');
});

test('Undo after Describe, then Transcribe, brings back what she typed (and her lyrics from before the transcript)', async () => {
  const stood = stand({ box: 'MY OWN TYPED DIRECTION', lyrics: 'my lyrics' });
  stood.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE } });
  await stood.fn.describeSound();
  assert.equal(stood.els.script.value, LINE);
  const page = await transcribeRun(on, ANSWER({ direction: 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ' }), {
    box: stood.els.script.value, flag: stood.els.script.attrs['data-auto-direction'], lyrics: 'my lyrics', undo: stood.writingUndo, title: stood.els.trackTitle.value, coverTitle: stood.state.coverTitle,
  });
  assert.equal(page.els.script.value, 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ');
  assert.equal(page.writingUndo.text, 'MY OWN TYPED DIRECTION', 'the text is the one before the feature first wrote the box');
  assert.equal(page.writingUndo.lyrics, 'my lyrics');
  assert.equal(page.writingUndo.title, '', 'and the title the feature named is still undone');
  assert.equal(page.writingUndo.generatedTitle, 'cover (cover)');
});

test('Undo after Transcribe, then Transcribe again: the direction she typed first, the lyrics as they were at the second press', async () => {
  const first = await transcribeRun(on, ANSWER({ direction: LINE }), { box: 'MY OWN TYPED DIRECTION', lyrics: 'my lyrics' });
  assert.equal(first.els.script.value, 'MY OWN TYPED DIRECTION', 'typed text is kept; nothing was filled');
  const empty = await transcribeRun(on, ANSWER({ direction: LINE }), { box: '', lyrics: 'my lyrics' });
  assert.equal(empty.els.script.value, LINE);
  const again = await transcribeRun(on, ANSWER({ transcript: '[Verse]\nSecond words', direction: 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ' }), {
    box: empty.els.script.value, flag: empty.els.script.attrs['data-auto-direction'], lyrics: '[Verse]\nSome made-up words', undo: empty.writingUndo, title: empty.els.trackTitle.value, coverTitle: empty.state.coverTitle,
  });
  assert.equal(again.writingUndo.text, '', 'the empty box she started with, not the first fill');
  assert.equal(again.writingUndo.lyrics, '[Verse]\nSome made-up words', 'the lyrics are re-taken at each press, as they always were');
});

test('Undo after Describe on text she typed over a fill is that text, not the older one', async () => {
  const page = stand({ box: 'MY OWN TYPED DIRECTION' });
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE } });
  await page.fn.describeSound();
  page.els.script.value = LINE + ' with more reverb';
  page.els.script.fire('input');
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: 'English, soul, slow tempo, male lead vocal, gritty vocals, warm organ' } });
  await page.fn.describeSound();
  assert.equal(page.writingUndo.text, LINE + ' with more reverb', 'she edited the fill, so the edit is hers and is what Undo brings back');
});

test('earlierUndo: nothing to keep unless the box holds the feature\'s own line and the Undo is for this engine', () => {
  const mine = stand({ box: 'typed', undo: { engine: 'yue2', text: 'older' } });
  assert.equal(mine.fn.earlierUndo(), null, 'typed text: no earlier undo to build on');
  const filled = stand({ box: LINE, flag: LINE, undo: { engine: 'yue2', text: 'older' } });
  assert.equal(filled.fn.earlierUndo().text, 'older');
  const otherEngine = stand({ box: LINE, flag: LINE, undo: { engine: 'lyria', text: 'older' } });
  assert.equal(otherEngine.fn.earlierUndo(), null);
  const none = stand({ box: LINE, flag: LINE });
  assert.equal(none.fn.earlierUndo(), null);
  const empty = stand({ box: '', flag: '', undo: { engine: 'yue2', text: 'older' } });
  assert.equal(empty.fn.earlierUndo(), null, 'an empty box is nothing to keep');
});

/* ---------- focus and the other buttons while a call is out ---------- */
test('Transcribe reference lyrics keeps focus on its button while the call is out, and puts the other buttons that start work out of use', async () => {
  const page = await transcribeRun(on, ANSWER({ direction: LINE }), { focus: 'btnLyrics' });
  const during = page.snapshots[0];
  assert.equal(during.activeElement, 'btnLyrics', 'focus is on the button, not on the page body, while it works');
  assert.equal(during.lyricsDisabled, false, 'a focusable button...');
  assert.equal(during.lyricsAria, 'true', '...marked unavailable for a screen reader');
  assert.equal(during.describeDisabled, true);
  assert.equal(during.draftDisabled, true, 'Help write this does nothing while this works, and says so');
  assert.equal(during.inspireDisabled, true, 'so does Surprise me');
  assert.equal(page.els.btnDraft.disabled, false, 'and they are back on afterwards');
  assert.equal(page.els.btnInspire.disabled, false);
  assert.equal(page.log.at(-1), 'focus:set_lyrics');
});

test('Transcribe reference lyrics: focus is not taken when it was not on the button, and is put back on every way out that is not a fill', async () => {
  const elsewhere = await transcribeRun(on, ANSWER(), { focus: 'script' });
  assert.equal(elsewhere.snapshots[0].activeElement, 'script', 'focus stays where she put it');
  assert.equal(elsewhere.log.filter((entry) => entry === 'focus:btnLyrics').length, 0);
  const failed = await transcribeRun(on, { ok: false, status: 502, data: { error: 'Could not transcribe this recording.' } }, { focus: 'btnLyrics' });
  assert.equal(failed.log.at(-1), 'focus:btnLyrics', 'a failure puts focus back on the button');
  assert.equal(failed.els.btnDraft.disabled, false);
  assert.equal(failed.els.btnInspire.disabled, false);
  const stale = await transcribeRun(on, { ok: true, status: 200, data: { transcript: 'x', direction: LINE } }, { focus: 'btnLyrics', during(state) { state.clips = [{ url: 'https://assets.test/other.mp3', name: 'o.mp3' }]; } });
  assert.equal(stale.log.at(-1), 'focus:btnLyrics', 'a stale answer writes nothing and gives focus back too');
  assert.equal(stale.els.script.value, '');
  assert.equal(stale.els.btnDraft.disabled, false);
  const away = await transcribeRun(on, { ok: true, status: 200, data: { transcript: 'x', direction: LINE } }, { focus: 'script', during(state) { state.clips = []; } });
  assert.equal(away.log.filter((entry) => entry === 'focus:btnLyrics').length, 0, 'and focus she moved is left alone');
});

test('Transcribe reference lyrics with the feature off: the rebuild is the old one, with no hold and no focus work', async () => {
  const page = await transcribeRun(off, ANSWER(), { focus: 'btnLyrics' });
  assert.equal(page.snapshots[0].activeElement, '', 'the old page lets a rebuild drop focus to the body, as it always did');
  assert.equal(page.snapshots[0].lyricsAria, null);
});

/* ---------- the explicit button ---------- */
test('Describe the sound of the recording replaces what is in the box, even her own text, and announces it', async () => {
  for (const [box, flag] of [['', undefined], ['My own direction', undefined], ['an earlier auto line', 'an earlier auto line']]) {
    const page = stand({ box, flag });
    page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE, cached: false } });
    await page.fn.describeSound();
    assert.deepEqual(plain(page.posts), [['/api/kade/sound-booth/reference/describe', { url: 'https://assets.test/a.mp3' }]]);
    assert.equal(page.els.script.value, LINE, 'always replaced: this is an explicit request');
    assert.equal(page.els.script.attrs['data-auto-direction'], LINE);
    assert.equal(page.els.readback.textContent, '');
    assert.equal(page.said.at(-1)[1], false);
    assert.equal(page.said.at(-1)[0], 'Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre. Track title: cover (cover). Undo writing change brings back your previous direction.');
    assert.equal(page.said[0][0], 'Listening to how the recording sounds. Your Music direction is kept until the description is ready.', 'she hears that it is working');
    assert.equal(page.els.btnUndoWriting.hidden, false, 'the existing Undo writing change button is offered');
    assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: box, title: '', generatedTitle: 'cover (cover)' }, 'Undo restores the direction and the title, and leaves the lyrics alone (no lyrics key)');
    assert.equal(page.state.writing, false, 'busy again only while it works');
    assert.equal(page.state.values.lyrics, 'old lyrics', 'the lyrics are never touched');
    assert.ok(page.log.includes('focus:script'), 'focus goes to the Music direction box she can now read and edit');
    assert.ok(page.quotes >= 1, 'the quote is invalidated, as for any change to the direction');
    assert.equal(page.els.trackTitle.value, 'cover (cover)');
  }
});

test('Describe the sound of the recording: with a title of her own the sentence does not mention a title', async () => {
  const page = stand({ box: '', title: 'My porch song' });
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE } });
  await page.fn.describeSound();
  assert.equal(page.said.at(-1)[0], 'Music direction replaced with what the recording sounds like. Change it or clear it to move the cover to another genre. Undo writing change brings back your previous direction.');
  assert.deepEqual(plain(page.writingUndo), { engine: 'yue2', text: '' });
  assert.equal(page.els.trackTitle.value, 'My porch song');
});

test('Describe the sound of the recording: while it works the pressed button keeps focus and is marked unavailable, the others are out of use, Music direction is read-only, and nothing is rebuilt; afterwards all is back', async () => {
  const page = stand({ box: 'Typed while nothing is running', focus: 'btnDescribe' });
  page.nextPost = async () => ({ ok: true, status: 200, data: { direction: LINE } });
  await page.fn.describeSound();
  const during = page.snapshots[0];
  assert.equal(during.writing, true, 'busy while the request is out, so no render or second press can start');
  assert.equal(during.activeElement, 'btnDescribe', 'focus is on the pressed button, not the body');
  assert.equal(during.describeAria, 'true');
  assert.equal(during.lyricsDisabled, true);
  assert.equal(during.draftDisabled, true);
  assert.equal(during.inspireDisabled, true);
  assert.equal(during.readOnly, true, 'she cannot type into the box the description is about to replace');
  assert.equal(during.renders, 0, 'the panel is not rebuilt around her during the wait');
  assert.equal(page.els.script.readOnly, false);
  assert.equal(page.els.btnDraft.disabled, false);
  assert.equal(page.els.btnInspire.disabled, false);
  assert.ok(page.renders >= 1, 'and rebuilt once, afterwards');
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
    { ok: false, status: 429, data: { error: 'The sound of this recording could not be described a moment ago. Try again in half a minute, or type the direction yourself.' } },
    { ok: false, status: 0, data: { error: 'Connection lost. Check the library before retrying a render; it may still be working.' } },
    { ok: true, status: 200, data: {} },
    { ok: true, status: 200, data: { direction: '   ' } },
  ]) {
    const page = stand({ box: 'My own direction', focus: 'btnDescribe' });
    page.nextPost = async () => response;
    await page.fn.describeSound();
    assert.equal(page.els.script.value, 'My own direction');
    assert.equal(page.writingUndo, null, 'no Undo is armed for a change that did not happen');
    assert.equal(page.els.btnUndoWriting.hidden, true);
    assert.equal(page.state.writing, false);
    assert.equal(page.els.script.readOnly, false);
    const [message, isErr] = page.said.at(-1);
    assert.equal(isErr, true);
    assert.equal(message, (response.data && response.data.error) || 'I could not describe the sound this time. Your Music direction is kept; type it yourself.');
    assert.equal(page.log.at(-1), 'focus:btnDescribe', 'focus is on the button again, not lost');
    assert.equal(page.els.trackTitle.value, '', 'no fill, no title');
  }
});

test('Describe the sound of the recording: focus she moved elsewhere is not taken back', async () => {
  const page = stand({ box: 'mine', focus: 'set_lyrics' });
  page.nextPost = async () => ({ ok: false, status: 502, data: { error: 'I could not describe the sound this time. Your Music direction is kept; type it yourself.' } });
  await page.fn.describeSound();
  assert.equal(page.log.filter((entry) => entry === 'focus:btnDescribe').length, 0);
});

test('Describe the sound of the recording: if the recording or the engine changed while it worked, nothing is written, and the controls are put back', async () => {
  const page = stand({ box: 'mine', focus: 'btnDescribe' });
  page.nextPost = async () => { page.state.clips = [{ url: 'https://assets.test/other.mp3', name: 'other.mp3' }]; return { ok: true, status: 200, data: { direction: LINE } }; };
  await page.fn.describeSound();
  assert.equal(page.els.script.value, 'mine');
  assert.equal(page.state.writing, false);
  assert.equal(page.els.script.readOnly, false);
  assert.equal(page.els.btnDraft.disabled, false);
  assert.equal(page.log.at(-1), 'focus:btnDescribe', 'focus was on the button, so it goes back there');
  const moved = stand({ box: 'mine' });
  moved.nextPost = async () => { moved.state.engine = 'lyria'; return { ok: true, status: 200, data: { direction: LINE } }; };
  await moved.fn.describeSound();
  assert.equal(moved.els.script.value, 'mine');
  assert.equal(moved.writingUndo, null);
  assert.equal(moved.log.filter((entry) => entry === 'focus:btnDescribe').length, 0, 'no focus is taken when it was not on the button');
});

test('the existing Undo writing change handler restores the direction a description replaced, and leaves lyrics undefined alone', () => {
  const handler = on.match(/document\.getElementById\('btnUndoWriting'\)\.onclick=function\(\)\{([\s\S]*?)\n    \};/)[1];
  assert.match(handler, /document\.getElementById\('script'\)\.value=writingUndo\.text;/);
  assert.match(handler, /if\(writingUndo\.lyrics!==undefined\)\{state\.values\.lyrics=writingUndo\.lyrics;renderSettings\(\);\}/, 'a describe-only undo has no lyrics key, so lyrics are not rewritten');
  assert.match(handler, /if\(busy\(\) \|\| !writingUndo \|\| writingUndo\.engine!==state\.engine\)return;/);
  assert.match(handler, /if\(writingUndo\.title!==undefined&&document\.getElementById\('trackTitle'\)\.value===writingUndo\.generatedTitle\)document\.getElementById\('trackTitle'\)\.value=writingUndo\.title;/, 'a title the feature wrote goes back, but only while it is still that title');
});

test('the Transcribe reference lyrics hint says it also fills Music direction, only while the feature is on', () => {
  assert.match(on, /Undo writing change brings back your lyrics\. Also fills an empty Music direction with what the recording sounds like\.<\/p>/);
  assert.match(off, /Undo writing change brings back your lyrics\.<\/p>/);
  assert.doesNotMatch(off, /Also fills an empty Music direction/);
});
