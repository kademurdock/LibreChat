'use strict';
/* Nov 10 2026: what the independent review of the Library redesign found, held as tests.
 *  1. The Position slider holds still while it plays under keyboard focus. Stepping it afterwards
 *     must move from where playback IS, not from where focus first landed.
 *  2. The folders page asks who is signed in every time. A note left in the tab by the last
 *     person must never draw their Move and Delete for the next one.
 *  3. Without the Family feature pack, the search and folders pages still say why the family
 *     collection is not there. The App Review seat is told nothing.
 *  4. Arrowing through one filter menu is one Back step at any pace, by ear included.
 * Run: node --test api/server/routes/kadeReadingRoomPage.review.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { answers, open, settle, row, shown } = require('./kadeReadingRoomPage.rig');

const AT = 'https://example.invalid';
const tape = {
  id: 'id8',
  title: 'Long tape',
  kind: 'audio',
  category: 'radio',
  tracks: [{ title: 'Side A', seconds: 3600, mime: 'audio/mpeg', url: '/a.mp3' }],
  bookmarks: [],
  skipped: [],
  mine: false,
  progress: null,
  defaultVoice: 'V',
};
/* Plays the tape to 40 seconds, rests keyboard focus on the slider, plays on to 400 seconds. */
async function resting(run) {
  const kept = answers.book;
  answers.book = () => tape;
  try {
    const page = open(AT + '/library?book=id8');
    await settle();
    let now = 0;
    const media = page.$('fileMedia');
    Object.defineProperty(media, 'currentTime', { get: () => now, set: (v) => { now = v; }, configurable: true });
    const tick = (s) => {
      now = s;
      media.dispatchEvent(new page.window.Event('timeupdate'));
    };
    page.$('playBtn').click();
    await settle(20);
    const bar = page.$('seekBar');
    for (let s = 1; s <= 40; s++) tick(s);
    bar.matches = (selector) => selector === ':focus-visible';
    bar.focus();
    for (let s = 41; s <= 400; s++) tick(s);
    assert.equal(bar.getAttribute('aria-valuetext'), '40 seconds of 1 hour', 'the hold: nothing is said while focus rests on it');
    const move = (value) => {
      bar.value = String(value);
      bar.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      bar.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    };
    const press = (name) => bar.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    await run({ page, bar, move, press, tick, at: () => now });
    page.dom.window.close();
  } finally {
    answers.book = kept;
  }
}

test('slider: Right arrow after resting on it goes forward from where playback is', async () => {
  await resting(async ({ bar, move, press, at }) => {
    press('ArrowRight');
    assert.equal(bar.value, '400', 'the key press brings the slider up to date before the browser steps it');
    assert.equal(bar.getAttribute('aria-valuetext'), '6 minutes 40 seconds of 1 hour');
    move(Number(bar.value) + Number(bar.step)); // what the browser then does for ArrowRight
    assert.equal(at(), 405);
    assert.equal(bar.getAttribute('aria-valuetext'), '6 minutes 45 seconds of 1 hour');
  });
});

test('slider: Left arrow, Home and End after resting on it', async () => {
  await resting(async ({ bar, move, press, tick, at }) => {
    press('ArrowLeft');
    move(Number(bar.value) - Number(bar.step));
    assert.equal(at(), 395);
    for (let s = 396; s <= 500; s++) tick(s);
    press('Home');
    move(0);
    assert.equal(at(), 0, 'Home is the very start');
    for (let s = 1; s <= 90; s++) tick(s);
    press('End');
    move(3600);
    assert.equal(at(), 3600, 'End is the very end');
  });
});

test('slider: a step that arrives with no key press (a screen reader gesture) is taken from where playback is', async () => {
  await resting(async ({ bar, move, at }) => {
    move(Number(bar.value) + Number(bar.step));
    assert.equal(at(), 405, 'playback was at 400 seconds');
    assert.equal(bar.getAttribute('aria-valuetext'), '6 minutes 45 seconds of 1 hour');
  });
  await resting(async ({ bar, move, at }) => {
    move(Number(bar.value) - Number(bar.step));
    assert.equal(at(), 395);
  });
  await resting(async ({ move, at }) => {
    move(0);
    assert.equal(at(), 0, 'the very start is always meant as written');
  });
});

test('slider: a pointer goes exactly where it is put, and a drag is not bent', async () => {
  await resting(async ({ page, bar, tick, at }) => {
    bar.dispatchEvent(new page.window.Event('pointerdown', { bubbles: true }));
    assert.equal(bar.value, '400');
    bar.value = '1200';
    bar.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    for (let s = 401; s <= 420; s++) tick(s); // it keeps playing during a slow drag
    bar.value = '1800';
    bar.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    bar.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    assert.equal(at(), 1800);
  });
});

test('slider: with focus elsewhere nothing is corrected (it is never more than five seconds behind)', async () => {
  const kept = answers.book;
  answers.book = () => tape;
  try {
    const page = open(AT + '/library?book=id8');
    await settle();
    let now = 0;
    const media = page.$('fileMedia');
    Object.defineProperty(media, 'currentTime', { get: () => now, set: (v) => { now = v; }, configurable: true });
    page.$('playBtn').click();
    await settle(20);
    for (let s = 1; s <= 43; s++) {
      now = s;
      media.dispatchEvent(new page.window.Event('timeupdate'));
    }
    const bar = page.$('seekBar');
    assert.equal(bar.value, '40');
    bar.value = '900';
    bar.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    bar.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    assert.equal(now, 900);
    page.dom.window.close();
  } finally {
    answers.book = kept;
  }
});

test('folders: who is signed in is asked, not taken from what the last person in this tab left behind', async () => {
  const keptA = answers.archive;
  answers.archive = () => ({ crumbs: [{ name: 'Video' }], folders: [], items: [row(1, { owner: 'someoneElse' })], total: 1, limit: 60, page: 0 });
  try {
    const page = open(AT + '/library/folders?folder=Video', { 'library-who': JSON.stringify({ me: 'previousPerson', librarian: true }) });
    await settle(150);
    assert.ok(page.calls.some((call) => call.includes('/shelf')), 'the shelf answer says who this is');
    const buttons = [...page.$('archiveList').querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['Open'], 'not a librarian and not the owner; drawn: ' + buttons.join(', '));
    assert.equal(page.window.sessionStorage.getItem('library-who'), null, 'the old note is thrown away and no new one is written');
    page.dom.window.close();
  } finally {
    answers.archive = keptA;
  }
});

test('without the Family feature pack, search and folders say why the family collection is not there', async () => {
  const keptS = answers.shelf,
    keptB = answers.browse;
  try {
    answers.shelf = () => ({ ...keptS(), familyLibrary: false });
    answers.browse = () => ({ total: 0, items: [], types: [], decades: [], next: null, familyLibrary: false });
    const search = open(AT + '/library/search');
    await settle(150);
    assert.equal(search.$('browseCount').textContent, '0 items');
    assert.ok(shown(search.$('familyLibraryNotice')), 'on the search page');
    assert.match(search.$('familyLibraryNotice').textContent, /Family feature pack/);
    search.dom.window.close();
    const folders = open(AT + '/library/folders');
    await settle(150);
    assert.ok(shown(folders.$('familyLibraryNotice')), 'on the folders page');
    folders.dom.window.close();

    /* the App Review seat: the server answers null, and nothing is said */
    answers.shelf = () => ({ ...keptS(), familyLibrary: null });
    answers.browse = () => ({ total: 0, items: [], types: [], decades: [], next: null, familyLibrary: null });
    for (const where of ['/library/search', '/library/folders']) {
      const review = open(AT + where);
      await settle(150);
      assert.ok(!shown(review.$('familyLibraryNotice')), 'the review seat hears nothing about a family collection on ' + where);
      review.dom.window.close();
    }

    /* a member with the pack */
    answers.shelf = keptS;
    answers.browse = () => ({ total: 0, items: [], types: [], decades: [], next: null, familyLibrary: true });
    const member = open(AT + '/library/search');
    await settle(150);
    assert.ok(!shown(member.$('familyLibraryNotice')));
    member.dom.window.close();
  } finally {
    answers.shelf = keptS;
    answers.browse = keptB;
  }
});

test('the browse answer gives the App Review seat null, the same as the shelf answer', () => {
  const router = fs.readFileSync(path.join(__dirname, 'kadeReadingRoom.js'), 'utf8');
  const browse = router.slice(router.indexOf("router.get('/browse'"));
  assert.match(browse.slice(0, 3000), /familyLibrary: reader\.hidden && require\('@librechat\/api'\)\.libraryReviewSeat\(req\.user\) \? null : !reader\.hidden,/);
});

test('arrowing through one filter menu at listening pace is one Back step; another menu, or coming back to it, is a new one', async () => {
  const page = open(AT + '/library/search');
  await settle(100);
  const before = page.window.history.length,
    kind = page.$('browseKind'),
    sort = page.$('browseSort');
  const choose = async (menu, value, wait) => {
    menu.value = value;
    menu.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    await settle(wait);
  };
  for (const value of ['text', 'audio', 'video']) await choose(kind, value, 1700);
  assert.equal(page.window.history.length - before, 1, 'three slow arrow presses in one menu');
  assert.equal(page.window.location.search, '?kind=video');
  kind.dispatchEvent(new page.window.Event('blur'));
  await choose(sort, 'title', 20);
  assert.equal(page.window.history.length - before, 2, 'a second menu is its own step');
  sort.dispatchEvent(new page.window.Event('blur'));
  await choose(kind, 'audio', 20);
  assert.equal(page.window.history.length - before, 3, 'back in the first menu after leaving it: a new step');
  await choose(kind, 'text', 20);
  assert.equal(page.window.history.length - before, 3);
  /* a page turn in between ends the run, even with no blur */
  page.window.history.pushState(null, '', page.window.location.pathname + '?kind=text&page=2');
  page.window.dispatchEvent(new page.window.PopStateEvent('popstate'));
  await settle(50);
  const mid = page.window.history.length;
  await choose(kind, 'video', 20);
  assert.equal(page.window.history.length - mid, 1, 'after Back, Forward or a page turn the next filter change is a new step');
  page.dom.window.close();
});
