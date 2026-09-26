'use strict';
/* The Sound Booth page without a browser (Sep 25 2026). The page's script is
 * written inside a JS template literal, so a regex like /\nLyrics:/ must be
 * typed with doubled backslashes in the source. These build the page the way
 * the server does, compile every inline script, and read what a browser would
 * actually receive. Run: node --test kadeSoundBoothPage.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('every inline script compiles and no backspace character crept in', () => {
  assert.ok(scripts.length >= 1);
  for (const s of scripts) new Function(s);
  assert.equal(html.includes('\b'), false);
});

/* The page's own function, cut out by its braces and run as a browser would. */
function pageFunction(name) {
  const main = scripts.find((s) => s.includes('function ' + name + '('));
  assert.ok(main, name + ' is on the page');
  const start = main.indexOf('function ' + name + '(');
  let depth = 0;
  for (let i = main.indexOf('{', start); i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
function draftSorter(lyrics) {
  const ctx = { state: { values: { lyrics } }, renders: 0, writingLyrics: undefined };
  vm.runInNewContext(pageFunction('sortDraft') + '\nfunction renderSettings(){ renders++; }\nthis.sortDraft = sortDraft;', ctx);
  return ctx;
}
const DIRECTION = 'A 1970s soul song, Rhodes and brushed drums.';
const DRAFT = DIRECTION + '\n\nLyrics:\n[Verse 1]\nthe words';

test('a Lyria draft is split like a YuE2 draft, and an instrumental is left whole', () => {
  assert.match(pageFunction('sortDraft'), /result\.split\(\/\\nLyrics:\\s\*\/i\)/, 'the browser receives single backslashes');
  for (const engine of ['lyria', 'yue2']) {
    const ctx = draftSorter('');
    const out = ctx.sortDraft(engine, {}, DRAFT);
    assert.equal(out.result, DIRECTION);
    assert.equal(ctx.state.values.lyrics, '[Verse 1]\nthe words');
    assert.equal(ctx.writingLyrics, '', 'Undo knows the lyrics box was empty');
    assert.equal(out.lead, 'The words the desk wrote are now in ' + (engine === 'lyria' ? 'Your own lyrics' : 'Lyrics') + ', under Lyrics and song settings. ', 'she is told where the words went');
  }
  const inst = draftSorter('');
  assert.equal(inst.sortDraft('lyria', {}, 'A slow instrumental theme. Instrumental only, no vocals.').result, 'A slow instrumental theme. Instrumental only, no vocals.');
  assert.throws(() => draftSorter('').sortDraft('yue2', {}, 'A style with no words.'), /did not provide separate lyrics/, 'only YuE2 refuses a written draft without words');
});

test("Lyria: her own lyrics are kept over the desk's copy, and she is told when it differed", () => {
  const ctx = draftSorter('[Verse 1]\nher own words');
  const out = ctx.sortDraft('lyria', {}, DIRECTION + '\n\nLyrics:\n[Verse 1]\nher own words, tidied by the desk');
  assert.equal(out.result, DIRECTION);
  assert.equal(ctx.state.values.lyrics, '[Verse 1]\nher own words');
  assert.equal(ctx.renders, 0);
  assert.match(out.lead, /Your own lyrics were kept/);
  const same = draftSorter('[Verse 1]\nher own words');
  assert.equal(same.sortDraft('lyria', {}, DIRECTION + '\n\nLyrics:\n[Verse 1]\nher own words').lead, '', 'an exact echo needs no remark');
  const server = draftSorter('[Verse 1]\nher own words');
  assert.match(server.sortDraft('lyria', { note: 'Your own lyrics were kept as you wrote them.' }, DIRECTION).lead, /^Your own lyrics were kept as you wrote them\. $/, "the server's note is said");
  const yue = draftSorter('[Verse]\nolder words');
  const y = yue.sortDraft('yue2', {}, DRAFT);
  assert.equal(yue.state.values.lyrics, '[Verse 1]\nthe words', 'YuE2 is unchanged: its writer always returns the words');
  assert.equal(y.lead, 'Lyrics now holds the desk version of your words; Undo brings back yours. ', 'and a replaced lyrics box is said out loud');
  const echo = draftSorter('[Verse 1]\nthe words');
  assert.equal(echo.sortDraft('yue2', {}, DRAFT).lead, '', 'the same words back need no remark');
});

/* sortPastedSong run as the browser runs it, with the shared splitter and a
 * few stand-ins for the page around it. */
function pasteRig({ engine = 'lyria', direction = '', lyrics = '', instrumental = false } = {}) {
  const { PAGE_SOURCE } = require('./kadeSoundBoothPaste');
  const els = {
    script: { value: direction, focus() {} },
    readback: { textContent: 'an old readback' },
    btnRender: { textContent: '' },
    set_lyrics: { focus() { ctx.focused = 'set_lyrics'; } },
  };
  const ctx = {
    state: { engine, values: { lyrics, instrumental }, pendingRender: 'x' },
    said: [], focused: null, writingLyrics: undefined,
    document: { getElementById: (id) => els[id] },
    window: {},
  };
  vm.runInNewContext(PAGE_SOURCE + pageFunction('sortPastedSong') + `
    function busy(){ return false; }
    function renderSettings(){}
    function renderLabel(){ return 'Generate'; }
    function say(m){ said.push(m); }
    function changeWriting(v){ document.getElementById('script').value = v; }
    this.sortPastedSong = sortPastedSong;`, ctx);
  ctx.paste = (field, text) => {
    const e = { prevented: false, clipboardData: { getData: () => text }, preventDefault() { this.prevented = true; } };
    ctx.sortPastedSong(e, field);
    return e.prevented;
  };
  ctx.els = els;
  return ctx;
}
const F3 = '`'.repeat(3);
const P_LYRICS = '[Verse 1]\nsoup at midnight';
const P_TAGS = 'pop-punk, 172 BPM';
const THREE = ['Lyrics Box', F3, P_LYRICS, F3, 'Tag Box', F3, P_TAGS, F3, 'Negative Tag Box', F3, 'no autotune', F3].join('\n');

test('a whole song pasted into the lyrics box: her direction stays, the words land, she is told', () => {
  const rig = pasteRig({ direction: 'A 1970s soul song.', lyrics: '' });
  assert.equal(rig.paste('lyrics', THREE), true, 'the raw paste is not inserted');
  assert.equal(rig.els.script.value, 'A 1970s soul song.');
  assert.equal(rig.state.values.lyrics, P_LYRICS);
  assert.equal(rig.writingLyrics, '', 'Undo can put the empty box back');
  assert.equal(rig.focused, 'set_lyrics', 'focus stays where she pasted');
  assert.match(rig.said[0], /Your music direction was kept, so the Tag Box was left out/);
  assert.match(rig.said[0], /Negative Tag Box was left out/);
  assert.match(rig.said[0], /Undo restores what was there/);
  const empty = pasteRig({ direction: '' });
  empty.paste('lyrics', THREE);
  assert.equal(empty.els.script.value, P_TAGS, 'an empty direction takes the Tag Box');
});

test('a paste with no Tag Box never wipes the direction she typed', () => {
  const rig = pasteRig({ direction: 'A 1970s soul song.' });
  rig.paste('script', ['Lyrics Box', F3, P_LYRICS, F3, 'Negative Tag Box', F3, 'no autotune', F3].join('\n'));
  assert.equal(rig.els.script.value, 'A 1970s soul song.');
  assert.equal(rig.state.values.lyrics, P_LYRICS);
  assert.equal(rig.els.readback.textContent, 'an old readback', 'the readback of an unchanged direction stays');
  assert.match(rig.said[0], /no Tag Box, so your music direction was kept/);
  const plain = pasteRig({ direction: 'x' });
  assert.equal(plain.paste('script', 'just a sentence about a song'), false, 'ordinary text pastes normally');
  assert.equal(plain.said.length, 0);
  const seed = pasteRig({ engine: 'seed' });
  assert.equal(seed.paste('script', THREE), false, 'only the music engines sort a paste');
});

test('No singing on: a pasted Lyrics Box is held in the hidden lyrics box and she is told', () => {
  const rig = pasteRig({ direction: '', instrumental: true });
  rig.paste('script', THREE);
  assert.equal(rig.els.script.value, P_TAGS);
  assert.equal(rig.state.values.lyrics, P_LYRICS);
  assert.match(rig.said[0], /No singing is on, so those words will not be sung until you turn it off/);
});

test("a pasted song's answer is said as the paste's, not blamed on the writer", () => {
  const ctx = draftSorter('');
  const out = ctx.sortDraft('yue2', { pasted: true, note: 'Your pasted song was sorted into its boxes: the Tag Box became the music direction.', problem: 'YuE2 will not sing without words, and the paste had no Lyrics Box.' }, 'pop-punk, 172 BPM');
  assert.equal(out.result, 'pop-punk, 172 BPM', 'the Tag Box reaches Music direction');
  assert.match(out.lead, /^Your pasted song was sorted.*One thing to fix first: YuE2 will not sing without words/);
  const lyria = draftSorter('[Verse]\nolder words');
  const l = lyria.sortDraft('lyria', { pasted: true, note: 'sorted' }, 'pop-punk\n\nLyrics:\n[Verse 1]\npasted words');
  assert.equal(lyria.state.values.lyrics, '[Verse 1]\npasted words', "a paste's Lyrics Box wins over the lyrics box");
  assert.equal(l.result, 'pop-punk');
});

test('a whole song pasted into Music direction or the lyrics box is caught on the page', () => {
  const fn = pageFunction('sortPastedSong');
  assert.match(fn, /placeSongPaste\(pasted,\{field:field/);
  assert.match(html, /getElementById\('script'\)\.addEventListener\('paste', function\(e\)\{ sortPastedSong\(e,'script'\); \}\)/);
  assert.match(html, /getElementById\('settings'\)\.addEventListener\('paste', function\(e\)\{ if\(e\.target&&e\.target\.id==='set_lyrics'\)sortPastedSong\(e,'lyrics'\); \}\)/);
});

test('the library card shows the words it sang apart from the description', () => {
  assert.match(html, /<summary>Words it sang<\/summary>/);
  assert.match(html, /p\.sungLyrics \?/);
});

test('the paste splitter the server runs is spliced into the page, byte for byte', () => {
  const { PAGE_SOURCE } = require('./kadeSoundBoothPaste');
  assert.ok(html.includes(PAGE_SOURCE), 'the same source text, untouched by template escaping');
  assert.match(html, /addEventListener\('paste'/);
  /* The page's own copy, run as the browser would run it. */
  const main = scripts.find((s) => s.includes('function splitSongPaste('));
  const start = main.indexOf('function songPasteHeading(');
  const end = main.indexOf('var writingUndo=');
  const ctx = {};
  const F = '`'.repeat(3);
  vm.runInNewContext(main.slice(start, end) + '\nthis.out = splitSongPaste(input);', Object.assign(ctx, {
    input: ['Lyrics Box', F, '[Verse 1]\nsoup at midnight', F, 'Tag Box', F, 'pop-punk, 172 BPM', F, 'Negative Tag Box', F, 'no autotune', F].join('\r\n'),
  }));
  assert.equal(ctx.out.lyrics, '[Verse 1]\nsoup at midnight');
  assert.equal(ctx.out.tags, 'pop-punk, 172 BPM');
  assert.equal(ctx.out.negative, 'no autotune');
});
