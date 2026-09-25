'use strict';
/* The three-box paste (Sep 25 2026): a ChatGPT answer shaped
 *   Lyrics Box / Tag Box / Negative Tag Box, each with a fenced block
 * must land as lyrics + music direction, with the negative tags sent nowhere,
 * and with no model call. Run: node --test kadeSoundBoothPaste.nodetest.js
 *
 * The song below is invented for this test. It follows the OUTPUT FORMAT of
 * the prompt, not anybody's real lyrics. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const paste = require('./kadeSoundBoothPaste');
const { splitLyricsBlock } = require('./kadeSoundBoothCarry');

const FENCE = '`'.repeat(3);
const LYRICS = [
  '[Verse 1]',
  'The vending machine ate my last two quarters',
  'So I kicked it once and it gave me soup',
  '',
  '[Chorus]',
  'Tomato soup at midnight (at midnight)',
  'Nobody asked for it, nobody paid',
  '',
  '[Bridge]',
  'I would write you a letter but the pen ran dry',
].join('\n');
const TAGS = 'Early-2000s pop-punk, 172 BPM, bratty tenor lead, palm-muted guitars, gang vocals on the chorus, bright snare, basement-show energy';
const NEGATIVE = 'no autotune, no ballad tempo, no generic inspirational lines';

function threeBox({ eol = '\n', lyricsHead = 'Lyrics Box', tagHead = 'Tag Box', negHead = 'Negative Tag Box', fence = FENCE } = {}) {
  return [
    lyricsHead, '', fence, LYRICS, fence, '',
    tagHead, '', fence, TAGS, fence, '',
    negHead, '', fence, NEGATIVE, fence, '',
  ].join('\n').replace(/\n/g, eol);
}

test('the exact OUTPUT FORMAT splits into lyrics, direction and a negative list', () => {
  const s = paste.splitSongPaste(threeBox());
  assert.ok(s, 'recognised');
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.tags, TAGS);
  assert.equal(s.negative, NEGATIVE);
  assert.deepEqual(s.boxes, ['lyrics', 'tags', 'negative']);
});

test('CRLF, bold headings with colons, extra blank lines and a language on the fence', () => {
  const messy = [
    '**Lyrics Box:**', '', '', FENCE + 'text', LYRICS, FENCE, '', '', '',
    '## Tag Box', FENCE, TAGS, FENCE,
    '**Negative Tag Box**:', '', FENCE, NEGATIVE, FENCE,
  ].join('\r\n');
  const s = paste.splitSongPaste(messy);
  assert.equal(s.lyrics, LYRICS, 'the lyric lines come through without a stray carriage return');
  assert.equal(s.tags, TAGS);
  assert.equal(s.negative, NEGATIVE);
  assert.doesNotMatch(s.lyrics + s.tags, /\r|```/);
});

test('no fences at all, and numbered headings', () => {
  const s = paste.splitSongPaste(['1. Lyrics Box', LYRICS, '', '2. Tag Box', TAGS, '', '3. Negative Tag Box', NEGATIVE].join('\n'));
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.tags, TAGS);
  assert.equal(s.negative, NEGATIVE);
});

test('a missing closing fence runs to the next heading; chatter after a closing fence is left out', () => {
  const s = paste.splitSongPaste([
    'Lyrics Box', FENCE, LYRICS, '',
    'Tag Box', FENCE, TAGS, FENCE, 'Hope you like it! Want a slower version?',
    'Negative Tag Box', FENCE, NEGATIVE,
  ].join('\n'));
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.tags, TAGS);
  assert.equal(s.negative, NEGATIVE);
});

test('boxes in another order still land in the right place', () => {
  const s = paste.splitSongPaste(['Tag Box', FENCE, TAGS, FENCE, 'Lyrics Box', FENCE, LYRICS, FENCE].join('\n'));
  assert.equal(s.tags, TAGS);
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.negative, '');
});

test('a single fenced box at the top is recognised; a brief that mentions a box is not', () => {
  const only = paste.splitSongPaste(['Tag Box', '', FENCE, TAGS, FENCE].join('\n'));
  assert.equal(only.tags, TAGS);
  assert.equal(only.lyrics, '');
  assert.equal(paste.splitSongPaste('A 1970s soul song. Rhodes, brushed drums.\n\nLyrics:\n[Verse 1]\nla la'), null,
    "the booth's own Lyrics: format is not a three-box paste");
  assert.equal(paste.splitSongPaste('A lo-fi beat.\nTag box\nwith a vinyl crackle'), null, 'one unfenced mention is not a paste');
  assert.equal(paste.splitSongPaste('Lyrics box'), null);
  assert.equal(paste.splitSongPaste(''), null);
  assert.equal(paste.splitSongPaste(undefined), null);
});

test('the draft comes back in the shape both clients already split on', () => {
  const s = paste.splitSongPaste(threeBox());
  const draft = paste.songPasteDraft(s);
  assert.equal(draft, TAGS + '\n\nLyrics:\n' + LYRICS);
  assert.doesNotMatch(draft, /no autotune/, 'the negative tags are not in it');
  /* the web page's split */
  const web = draft.split(/\nLyrics:\s*/i);
  assert.equal(web[0].trim(), TAGS);
  assert.equal(web.slice(1).join('\n'), LYRICS);
  /* the iPhone's split: first "\nLyrics:" */
  const at = draft.toLowerCase().indexOf('\nlyrics:');
  assert.equal(draft.slice(0, at).trim(), TAGS);
  assert.equal(draft.slice(at + '\nLyrics:'.length).trim(), LYRICS);
  /* and the server's */
  assert.deepEqual(splitLyricsBlock(draft), { prose: TAGS, lyrics: LYRICS });
  assert.equal(paste.songPasteDraft({ tags: TAGS, lyrics: '' }), TAGS, 'an instrumental has no Lyrics heading');
});

test('the note says where things went and why the negative tags were dropped', () => {
  const note = paste.songPasteNote(paste.splitSongPaste(threeBox()));
  assert.match(note, /Tag Box became the music direction/);
  assert.match(note, /Lyrics Box became the lyrics/);
  assert.match(note, /Negative Tag Box was left out/);
  assert.doesNotMatch(paste.songPasteNote({ tags: TAGS, lyrics: LYRICS, negative: '' }), /Negative/);
});

test('the render guard rewrites a music body in place and never sends the negative tags', () => {
  const lyria = { engine: 'lyria', script: threeBox({ eol: '\r\n' }), lyrics: '' };
  const r = paste.applySongPasteToBody(lyria);
  assert.ok(r);
  assert.equal(lyria.script, TAGS);
  assert.equal(lyria.lyrics, LYRICS);
  assert.doesNotMatch(JSON.stringify(lyria), /no autotune/);
  assert.match(r.note, /Negative Tag Box was left out/);

  const yue = { engine: 'yue2', script: threeBox(), lyrics: '[Verse]\nsomething older' };
  const y = paste.applySongPasteToBody(yue);
  assert.equal(yue.script, TAGS);
  assert.equal(yue.lyrics, LYRICS, 'a pasted song brings its own words');
  assert.match(y.note, /replaced what was in the lyrics box/);

  const speech = { engine: 'scenema', script: threeBox() };
  assert.equal(paste.applySongPasteToBody(speech), null, 'only the music engines are touched');
  assert.equal(speech.script, threeBox());
  const plain = { engine: 'lyria', script: 'A slow soul record.' };
  assert.equal(paste.applySongPasteToBody(plain), null);
  assert.equal(plain.script, 'A slow soul record.');
});

test("the page's copy is the same code and behaves the same", () => {
  assert.doesNotMatch(paste.PAGE_SOURCE, /<\/script/i);
  const ctx = {};
  vm.runInNewContext(paste.PAGE_SOURCE + '\nthis.out = splitSongPaste(input); this.draft = songPasteDraft(this.out); this.note = songPasteNote(this.out);', Object.assign(ctx, { input: threeBox({ eol: '\r\n' }) }));
  assert.equal(ctx.out.lyrics, LYRICS);
  assert.equal(ctx.out.tags, TAGS);
  assert.equal(ctx.draft, TAGS + '\n\nLyrics:\n' + LYRICS);
  assert.match(ctx.note, /Negative Tag Box was left out/);
});
