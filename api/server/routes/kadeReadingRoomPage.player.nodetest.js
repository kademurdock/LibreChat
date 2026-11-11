'use strict';
/* Nov 10 2026 (redesign): the media player, by ear and by eye.
 * What these hold: plainly named skip buttons; one labelled position slider for recordings that
 * speaks time in words and does not chatter while playing; a state line in words that is never a
 * second live region; resume said with its place; captions and spoken-description choices right
 * under the controls; a recording with no picture that is not an invisible Tab stop; and keyboard
 * shortcuts that leave Ctrl, Alt, text boxes, the slider and the rest of the page alone.
 * Run: node --test api/server/routes/kadeReadingRoomPage.player.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { source, html, answers, open, settle, shown, tabStops } = require('./kadeReadingRoomPage.rig');

const AT = 'https://example.invalid/library';
const tape = (extra) => ({
  id: 'id8',
  title: 'KTTS aircheck',
  kind: 'audio',
  category: 'radio',
  tracks: [
    { title: 'Side A', seconds: 125, mime: 'audio/mpeg', url: '/a.mp3' },
    { title: 'Side B', seconds: 3725, mime: 'audio/mpeg', url: '/b.mp3' },
  ],
  bookmarks: [],
  skipped: [],
  mine: false,
  progress: null,
  defaultVoice: 'V',
  ...extra,
});
async function withBook(book, run, address) {
  const kept = answers.book;
  answers.book = () => book;
  try {
    const page = open(AT + (address || '?book=' + book.id));
    await settle();
    /* jsdom has no media engine: the tests move the clock by hand */
    let now = 0;
    Object.defineProperty(page.$('fileMedia'), 'currentTime', { get: () => now, set: (v) => { now = v; }, configurable: true });
    page.at = (seconds, type) => {
      now = seconds;
      page.$('fileMedia').dispatchEvent(new page.window.Event(type || 'timeupdate'));
    };
    await run(page);
    page.dom.window.close();
  } finally {
    answers.book = kept;
  }
}
const key = (page, target, init) => {
  const event = new page.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

test('the skip buttons say how far they go, and a book says passages', async () => {
  await withBook(tape(), async (page) => {
    assert.equal(page.$('backBtn').textContent, 'Back 15 seconds');
    assert.equal(page.$('fwdBtn').textContent, 'Forward 15 seconds');
    assert.equal(page.$('prevSecBtn').textContent, 'Previous part');
    assert.equal(page.document.querySelector('#player .controls').getAttribute('role'), 'group');
    assert.equal(page.document.querySelector('#player .controls').getAttribute('aria-label'), 'Playback');
  });
  const book = open(AT + '?book=id4');
  await settle();
  assert.equal(book.$('backBtn').textContent, 'Previous passage');
  assert.equal(book.$('fwdBtn').textContent, 'Next passage');
  assert.equal(book.$('seekWrap').hidden, true, 'a book read aloud has chapters and passages, not a clock');
  book.dom.window.close();
  assert.match(source, /#player \.controls button\.act \{ min-height:56px; font-size:1\.05rem; \}/, 'large controls');
});

test('the position slider: labelled, in words, and it moves the recording', async () => {
  await withBook(tape(), async (page) => {
    const bar = page.$('seekBar');
    assert.equal(page.$('seekWrap').hidden, false);
    assert.equal(bar.type, 'range');
    assert.equal(page.document.querySelector('label[for="seekBar"]').textContent, 'Position');
    assert.equal(bar.max, '125');
    assert.equal(bar.step, '5', 'arrow keys move five seconds in a longer recording');
    assert.equal(bar.getAttribute('aria-valuetext'), '0 seconds of 2 minutes 5 seconds');
    page.at(40, 'seeked');
    assert.equal(bar.value, '40');
    assert.equal(bar.getAttribute('aria-valuetext'), '40 seconds of 2 minutes 5 seconds');
    assert.equal(page.$('timeLine').textContent, '0:40 of 2:05');
    bar.value = '90';
    bar.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    assert.equal(bar.getAttribute('aria-valuetext'), '1 minute 30 seconds of 2 minutes 5 seconds');
    assert.equal(page.$('timeLine').textContent, '1:30 of 2:05', 'the clock shows where the slider is before it lets go');
    bar.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    assert.equal(page.$('fileMedia').currentTime, 90);
    assert.ok(!bar.hasAttribute('aria-live') && !page.$('seekWrap').hasAttribute('aria-live'));
  });
  await withBook(tape({ tracks: [{ title: 'Spot', seconds: 30, mime: 'video/mp4', url: '/v.mp4' }] }), async (page) => {
    assert.equal(page.$('seekBar').max, '30', 'video has the same slider');
    assert.equal(page.$('seekBar').step, '1', 'a short clip moves by the second');
  });
  await withBook(tape({ tracks: [{ title: 'Unknown length', mime: 'audio/mpeg', url: '/u.mp3' }] }), async (page) => {
    assert.equal(page.$('seekWrap').hidden, true, 'no slider until the length is known');
  });
});

test('while playing, the slider moves in five-second hops and holds still under keyboard focus', async () => {
  await withBook(tape(), async (page) => {
    const bar = page.$('seekBar');
    page.$('playBtn').click();
    await settle(20);
    assert.equal(page.$('playBtn').textContent, 'Pause');
    const told = [];
    new page.window.MutationObserver((list) => list.forEach((m) => told.push(m.oldValue))).observe(bar, { attributes: true, attributeFilter: ['aria-valuetext'], attributeOldValue: true });
    for (let second = 1; second <= 12; second++) page.at(second);
    await settle(10);
    assert.deepEqual(told, ['0 seconds of 2 minutes 5 seconds', '5 seconds of 2 minutes 5 seconds'], 'twelve seconds of playing changed the slider twice (at 5 and at 10)');
    assert.equal(bar.getAttribute('aria-valuetext'), '10 seconds of 2 minutes 5 seconds');
    assert.equal(page.$('timeLine').textContent, '0:12 of 2:05', 'the clock beside it runs every second');
    told.length = 0;
    bar.matches = (selector) => selector === ':focus-visible';
    bar.focus();
    for (let second = 13; second <= 40; second++) page.at(second);
    await settle(10);
    assert.deepEqual(told, ['10 seconds of 2 minutes 5 seconds'], 'brought up to date once as focus lands (so what is read on arrival is true), then a screen reader resting on it is told nothing while it plays');
    assert.equal(bar.getAttribute('aria-valuetext'), '12 seconds of 2 minutes 5 seconds');
    page.$('playBtn').click();
    page.$('fileMedia').dispatchEvent(new page.window.Event('pause'));
    assert.equal(bar.getAttribute('aria-valuetext'), '40 seconds of 2 minutes 5 seconds', 'pausing brings it up to date');
    await settle(10);
    assert.deepEqual(told, ['10 seconds of 2 minutes 5 seconds', '12 seconds of 2 minutes 5 seconds']);
  });
});

test('the state line says in words what the player is doing, and is never a second live region', async () => {
  await withBook(tape(), async (page) => {
    const state = page.$('playState');
    assert.equal(state.textContent, 'Paused · Part 1 of 2: Side A');
    assert.ok(!state.hasAttribute('aria-live') && !state.hasAttribute('role'));
    assert.equal(page.document.querySelectorAll('[aria-live]').length, 1);
    page.$('playBtn').click();
    await settle(20);
    assert.equal(state.textContent, 'Playing · Part 1 of 2: Side A');
    page.$('speedSel').value = '1.5';
    page.$('speedSel').dispatchEvent(new page.window.Event('change'));
    assert.equal(state.textContent, 'Playing · Part 1 of 2: Side A · 1.5 times speed');
    page.$('nextSecBtn').click();
    await settle(20);
    assert.match(state.textContent, /Part 2 of 2: Side B/);
    assert.equal(page.$('seekBar').getAttribute('aria-valuetext'), '0 seconds of 1 hour 2 minutes 5 seconds');
  });
  const clip = open(AT + '?book=id1');
  await settle();
  assert.equal(clip.$('playState').textContent, 'Paused', 'a one-part clip does not repeat its own title');
  clip.dom.window.close();
});

test('resume: the place is said in words and shown on the clock', async () => {
  await withBook(tape({ progress: { s: 0, c: 0, pos: 95 } }), async (page) => {
    assert.equal(page.$('live').textContent, 'Resuming KTTS aircheck at 1 minute 35 seconds. Part 1 of 2: Side A. Press Play.');
    assert.equal(page.document.activeElement.id, 'playBtn');
  });
  await withBook(tape(), async (page) => {
    assert.equal(page.$('live').textContent, 'Opened KTTS aircheck. Part 1 of 2: Side A. Press Play.');
  });
});

test('a recording with no picture is not an invisible Tab stop; a video keeps its own controls', async () => {
  assert.ok(!/<video id="fileMedia"[^>]*\scontrols/.test(html), 'no controls until a video asks for them');
  await withBook(tape(), async (page) => {
    const media = page.$('fileMedia');
    assert.equal(media.controls, false);
    assert.equal(media.getAttribute('tabindex'), '-1');
    assert.equal(media.getAttribute('aria-hidden'), 'true');
    assert.ok(!tabStops(page.document).includes(media));
  });
  await withBook(tape({ tracks: [{ title: 'Spot', seconds: 30, mime: 'video/mp4', url: '/v.mp4' }] }), async (page) => {
    const media = page.$('fileMedia');
    assert.equal(media.controls, true);
    assert.equal(media.hasAttribute('aria-hidden'), false);
    assert.equal(media.hasAttribute('tabindex'), false);
    assert.equal(media.getAttribute('aria-label'), 'The recording');
  });
});

test('captions and spoken description are one row right under the controls', async () => {
  const video = (description) => tape({ tracks: [{ title: 'Spot', seconds: 300, mime: 'video/mp4', url: '/v.mp4', description }] });
  await withBook(video({ state: 'done', summary: 'A lumber yard.', scenes: [{ t: 3, text: 'A truck.' }] }), async (page) => {
    const row = page.$('accessRow');
    assert.equal(row.hidden, false);
    assert.equal(row.getAttribute('role'), 'group');
    assert.equal(row.getAttribute('aria-label'), 'Captions and description');
    const order = (a, b) => !!(a.compareDocumentPosition(b) & 4);
    assert.ok(order(page.document.querySelector('#player .controls'), row) && order(row, page.$('descWrap')), 'under the controls, above the long boxes');
    const toggle = page.$('descToggleBtn');
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.textContent, 'Spoken description: off');
    toggle.click();
    await settle(50);
    assert.equal(toggle.textContent, 'Spoken description: on', 'the state is in the words, not in a colour');
    assert.equal(page.$('descMode').checked, true, 'the same switch as the box further down');
    assert.equal(page.$('live').textContent, 'Descriptions on: the video pauses to describe each scene.');
    page.$('descMode').checked = false;
    page.$('descMode').dispatchEvent(new page.window.Event('change'));
    assert.equal(toggle.textContent, 'Spoken description: off');
    assert.equal(page.$('descFindBtn').hidden, true);
    assert.equal(page.$('captionsBtn').hidden, true, 'no captions button for a file without a caption track');
  });
  await withBook(video(undefined), async (page) => {
    assert.equal(page.$('descToggleBtn').hidden, true);
    const find = page.$('descFindBtn');
    assert.equal(find.hidden, false);
    find.click();
    assert.equal(page.$('descWrap').open, true);
    assert.equal(page.document.activeElement.id, 'descBtn');
  });
  await withBook(tape(), async (page) => {
    assert.equal(page.$('accessRow').hidden, true, 'an audio tape has neither, so the row is not there');
  });
  await withBook(video(undefined), async (page) => {
    const tracks = [{ kind: 'captions', mode: 'disabled' }, { kind: 'metadata', mode: 'hidden' }];
    Object.defineProperty(page.$('fileMedia'), 'textTracks', { value: tracks, configurable: true });
    page.$('fileMedia').dispatchEvent(new page.window.Event('loadedmetadata'));
    const captions = page.$('captionsBtn');
    assert.equal(captions.hidden, false);
    assert.equal(captions.textContent, 'Captions: off');
    captions.click();
    await settle(50);
    assert.equal(captions.textContent, 'Captions: on');
    assert.equal(tracks[0].mode, 'showing');
    assert.equal(tracks[1].mode, 'hidden', 'only caption tracks are touched');
    assert.equal(page.$('live').textContent, 'Captions on.');
    assert.equal(page.window.localStorage.getItem('kade.library.captions'), '1', 'remembered for the next video');
  });
});

test('keyboard shortcuts stay out of the way of screen readers, the browser and typing', async () => {
  await withBook(tape(), async (page) => {
    const { document } = page;
    const play = page.$('playBtn');
    const playing = () => play.textContent === 'Pause';
    page.$('bookTitle').focus();
    assert.equal(key(page, page.$('bookTitle'), { code: 'KeyK', key: 'k' }), true);
    await settle(20);
    assert.equal(playing(), true, 'K plays');
    assert.equal(key(page, page.$('bookTitle'), { code: 'Space', key: ' ' }), true);
    assert.equal(playing(), false, 'Space pauses');
    for (const held of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      assert.equal(key(page, document.body, { key: 'ArrowLeft', code: 'ArrowLeft', ...held }), false, 'Alt+Left is the browser Back; Ctrl and the Windows key belong to others');
      assert.equal(key(page, document.body, { key: 'k', code: 'KeyK', ...held }), false);
    }
    assert.equal(playing(), false);
    for (const id of ['seekBar', 'chapterSel', 'askBox', 'edTitle']) {
      assert.equal(key(page, page.$(id), { key: 'ArrowRight', code: 'ArrowRight' }), false, id + ' keeps its own arrow keys');
      assert.equal(key(page, page.$(id), { key: 'b', code: 'KeyB' }), false, 'typing a b in ' + id + ' is typing');
    }
    assert.equal(page.$('live').textContent.includes('Bookmark'), false);
    assert.equal(key(page, play, { code: 'Space', key: ' ' }), false, 'Space on a button presses the button');
    const outside = document.querySelector('a.back');
    assert.equal(key(page, outside, { key: 'k', code: 'KeyK' }), false, 'a key typed outside the player is not the player\'s');
    assert.equal(playing(), false);
    assert.equal(key(page, document.body, { key: 'ArrowRight', code: 'ArrowRight' }), true);
    assert.equal(page.$('live').textContent, '');
    await settle(50);
    assert.equal(page.$('live').textContent, 'Forward 15 seconds.');
    const off = page.$('keysOn');
    assert.equal(off.checked, true);
    assert.equal(off.closest('label').textContent.trim(), 'Keyboard shortcuts for this player');
    off.checked = false;
    off.dispatchEvent(new page.window.Event('change'));
    assert.equal(key(page, document.body, { code: 'Space', key: ' ' }), false, 'one switch turns every shortcut off');
    assert.equal(playing(), false);
    assert.equal(page.window.localStorage.getItem('kade.library.keys'), '0');
    assert.match(page.$('keysHint').textContent, /None of them uses Ctrl or Alt, and every one is also a button/);
    assert.ok(shown(page.$('keysHint')));
  });
});

test('short rows: one checkbox under the results leaves the folder line off, and remembers', async () => {
  const page = open(AT + '/search');
  await settle();
  const box = page.$('shortRows');
  assert.equal(page.$('browseList').querySelectorAll('.meta.place').length, 3);
  assert.ok(page.$('browsePager').compareDocumentPosition(box) & 4, 'under the list and its pager, so it is never between you and the first result');
  box.checked = true;
  box.dispatchEvent(new page.window.Event('change'));
  assert.equal(page.$('browseList').querySelectorAll('.meta.place').length, 0);
  assert.equal(page.$('browseList').querySelectorAll('li').length, 3);
  assert.equal(page.window.localStorage.getItem('kade.library.shortRows'), '1');
  page.$('searchBox').value = 'ky3';
  page.$('browseForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(page.$('browseList').querySelectorAll('.meta.place').length, 0, 'the next list is short too');
  box.checked = false;
  box.dispatchEvent(new page.window.Event('change'));
  await settle();
  assert.equal(page.$('browseList').querySelectorAll('.meta.place').length, 3);
  page.dom.window.close();
});
