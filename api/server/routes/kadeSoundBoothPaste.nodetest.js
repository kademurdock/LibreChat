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
  vm.runInNewContext(paste.PAGE_SOURCE + '\nthis.placed = placeSongPaste(splitSongPaste(input), { field: "lyrics", direction: "Her own direction.", lyrics: "" });', ctx);
  assert.equal(ctx.placed.script, 'Her own direction.', 'the page decides with the same placement rules');
  assert.equal(ctx.placed.lyrics, LYRICS);
});

/* ---- review fixes, Sep 25 2026 ------------------------------------------- */

test('a label after the heading colon is not sung when a fenced box follows', () => {
  const s = paste.splitSongPaste([
    '**Lyrics Box:** (copy this into the lyrics field)', FENCE, LYRICS, FENCE,
    '**Tag Box:** (for the style field)', '', FENCE, TAGS, FENCE,
  ].join('\n'));
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.tags, TAGS);
  assert.doesNotMatch(s.lyrics + s.tags, /copy this|style field|```/);
  const single = paste.splitSongPaste(['Tag Box: (paste me)', FENCE, TAGS, FENCE].join('\n'));
  assert.equal(single.tags, TAGS, 'a single labelled, fenced box is still recognised');
  const unfenced = paste.splitSongPaste(['Lyrics Box', FENCE, LYRICS, FENCE, 'Tag Box: ' + TAGS, 'Negative Tag Box: ' + NEGATIVE].join('\n'));
  assert.equal(unfenced.tags, TAGS, 'inline text with no fence after it is the box itself');
  assert.equal(unfenced.negative, NEGATIVE);
});

test('fences of four or more backticks or tildes, with a three-backtick line kept inside', () => {
  const four = '`'.repeat(4);
  const s = paste.splitSongPaste(threeBox({ fence: four }));
  assert.equal(s.lyrics, LYRICS);
  assert.equal(s.tags, TAGS);
  assert.equal(s.negative, NEGATIVE);
  const inner = paste.splitSongPaste(['Lyrics Box', four + 'text', '[Verse 1]', FENCE, 'la la', four, 'Tag Box', '~~~~', TAGS, '~~~~'].join('\n'));
  assert.equal(inner.lyrics, '[Verse 1]\n' + FENCE + '\nla la', 'a shorter fence inside does not close the box');
  assert.equal(inner.tags, TAGS);
  assert.equal(paste.splitSongPaste(['Tag Box', four, TAGS, four].join('\n')).tags, TAGS, 'a single four-backtick box counts');
});

test('what came ahead of the first heading is kept as `before`', () => {
  assert.equal(paste.splitSongPaste(threeBox()).before, '');
  assert.equal(paste.splitSongPaste('A 1970s soul song, Rhodes.\n\n' + threeBox()).before, 'A 1970s soul song, Rhodes.');
});

function lyricsAndNegative() {
  return ['Lyrics Box', FENCE, LYRICS, FENCE, 'Negative Tag Box', FENCE, NEGATIVE, FENCE].join('\n');
}

test('a paste with no Tag Box keeps the direction she had', () => {
  const typed = { engine: 'lyria', script: 'A 1970s soul song, Rhodes and brushed drums.\n\n' + lyricsAndNegative(), lyrics: '' };
  const r = paste.applySongPasteToBody(typed);
  assert.equal(typed.script, 'A 1970s soul song, Rhodes and brushed drums.', 'what she typed above the paste stays the direction');
  assert.equal(typed.lyrics, LYRICS);
  assert.match(r.note, /no Tag Box, so your music direction was kept/);
  assert.doesNotMatch(JSON.stringify(typed), /no autotune|Lyrics Box/);

  const bare = { engine: 'yue2', script: lyricsAndNegative(), lyrics: '' };
  const b = paste.applySongPasteToBody(bare);
  assert.equal(bare.script, '');
  assert.match(b.note, /no Tag Box, so there is no music direction yet\. Describe the music/);

  /* the page's rule: the box's own text is the direction, and it stays */
  const placed = paste.placeSongPaste(paste.splitSongPaste(lyricsAndNegative()), { field: 'script', direction: 'Her typed direction.', lyrics: '' });
  assert.equal(placed.script, 'Her typed direction.');
  assert.equal(placed.lyrics, LYRICS);
});

test('a whole song pasted into the lyrics box is sorted too', () => {
  const empty = { engine: 'lyria', script: '', lyrics: threeBox() };
  const r = paste.applySongPasteToBody(empty);
  assert.ok(r);
  assert.equal(r.field, 'lyrics');
  assert.equal(empty.lyrics, LYRICS);
  assert.equal(empty.script, TAGS, 'an empty direction takes the Tag Box');
  assert.doesNotMatch(JSON.stringify(empty), /no autotune|Tag Box|```/);

  const mine = { engine: 'lyria', script: 'A 1970s soul song.', lyrics: threeBox({ eol: '\r\n' }) };
  const m = paste.applySongPasteToBody(mine);
  assert.equal(mine.script, 'A 1970s soul song.', 'a direction she wrote stays');
  assert.equal(mine.lyrics, LYRICS);
  assert.match(m.note, /Your music direction was kept, so the Tag Box was left out/);
  assert.doesNotMatch(m.note, /Tag Box became the music direction/);

  const both = { engine: 'lyria', script: threeBox(), lyrics: '[Verse]\nnot a paste' };
  assert.equal(paste.applySongPasteToBody(both).field, 'script', 'a paste in Music direction is read first');
});

test('with No singing on, the render body gets no words back', () => {
  const body = { engine: 'lyria', script: threeBox(), instrumental: true };
  const r = paste.applySongPasteToBody(body);
  assert.equal(body.script, TAGS);
  assert.equal('lyrics' in body, false, 'no lyrics are put back into an instrumental body');
  assert.match(r.note, /No singing is on, so the Lyrics Box was left out/);
  assert.doesNotMatch(r.note, /Lyrics Box became the lyrics/);
  /* the page holds the words in the hidden lyrics box and says so */
  const held = paste.placeSongPaste(paste.splitSongPaste(threeBox()), { field: 'script', direction: '', lyrics: '', instrumental: true, holdLyrics: true });
  assert.equal(held.lyrics, LYRICS);
  assert.match(held.note, /will not be sung until you turn it off/);
});
