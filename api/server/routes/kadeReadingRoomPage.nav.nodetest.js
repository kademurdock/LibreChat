'use strict';
/* Nov 10 2026: finding your way around the Library, by ear and by eye.
 * What these hold: one main landmark and a skip link where one is worth having; headings in
 * order; the first result within 11 Tab stops; focus that never falls off the page when a list
 * is redrawn; focus back on the item you came back from; a one-part clip without chapter
 * controls; and the "pick up where you left off" list.
 * The Library's pages (the front desk and its small pages) have their own file,
 * kadeReadingRoomPage.desk.nodetest.js, and the address its own, ...address.nodetest.js.
 * Run: node --test api/server/routes/kadeReadingRoomPage.nav.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source, html, row, place, answers, open, settle, visibleHeadings, tabStops, JSDOM } = require('./kadeReadingRoomPage.rig');

const AT = 'https://example.invalid/library';
const submit = (page) => page.$('browseForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));

test('the page has one main landmark, a skip link to the results, and a named search form', async () => {
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelectorAll('main').length, 1);
  assert.ok(document.querySelector('main').contains(document.getElementById('pageTitle')));
  const skip = document.querySelector('a.skip');
  assert.equal(skip.getAttribute('href'), '#h-results');
  assert.equal(skip.textContent, 'Skip to results');
  assert.equal(document.body.firstElementChild, skip, 'the skip link is the first thing on the page');
  assert.equal(document.getElementById('browseForm').getAttribute('role'), 'search');
  assert.ok(document.getElementById('browseForm').getAttribute('aria-label'));
  assert.equal(document.querySelectorAll('[aria-live]').length, 1, 'still exactly one live region');
  const search = open(AT + '/search');
  assert.equal(search.$('skipLink').hidden, false);
  await settle();
  search.dom.window.close();
  const desk = open(AT);
  assert.equal(desk.$('skipLink').hidden, true, 'a short page of rows has nothing worth skipping');
  await settle();
  desk.dom.window.close();
});

test('no heading hides inside a closed box, and no list is named for a heading on another page', () => {
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelectorAll('#shelf details h2').length, 0);
  for (const list of document.querySelectorAll('#shelf [aria-labelledby]:not([hidden])')) {
    const name = document.getElementById(list.getAttribute('aria-labelledby'));
    assert.ok(name, list.id + ' is named by something that exists');
    const block = list.closest('[data-views]');
    assert.ok(name.id === 'pageTitle' || block.contains(name), list.id + ' is named by the page title or a heading on its own page');
  }
});

test('search comes first, then the results; headings go in order on the search page', async () => {
  const { document } = new JSDOM(html).window;
  const order = (a, b) => !!(a.compareDocumentPosition(b) & 4); // b follows a
  assert.ok(order(document.getElementById('searchBox'), document.getElementById('h-results')));
  assert.ok(order(document.getElementById('h-results'), document.getElementById('browseList')));
  assert.ok(order(document.getElementById('browseList'), document.getElementById('browsePager')));
  assert.equal(document.getElementById('browseList').getAttribute('aria-labelledby'), 'h-results');
  assert.ok(!html.includes('var(--border)'), 'no colour variable that is never defined');
  const page = open(AT + '/search');
  await settle();
  assert.deepEqual(visibleHeadings(page.document), ['H1 Browse and search', 'H2 Results']);
  page.dom.window.close();
});

test('the first result is at most the 11th Tab stop, and three presses away with the skip link', async () => {
  const page = open(AT + '/search');
  await settle();
  const stops = tabStops(page.document);
  const first = page.$('browseList').querySelector('button');
  assert.equal(first.getAttribute('aria-label'), 'Open Clip 1');
  assert.ok(stops.indexOf(first) + 1 <= 11, 'the first result is Tab stop ' + (stops.indexOf(first) + 1));
  assert.equal(stops[0].id, 'skipLink');
  page.$('skipLink').click(); // Tab, Enter
  assert.equal(page.document.activeElement.id, 'h-results');
  const after = stops.filter((node) => page.$('h-results').compareDocumentPosition(node) & 4);
  assert.equal(after[0], first, 'the next Tab from the Results heading is the first result');
  page.dom.window.close();
});

test('a filter leaves focus on its menu', async () => {
  const page = open(AT + '/search');
  await settle();
  const kind = page.$('browseKind');
  kind.focus();
  kind.value = 'video';
  kind.dispatchEvent(new page.window.Event('change'));
  await settle();
  assert.equal(page.document.activeElement.id, 'browseKind');
  page.dom.window.close();
});

test('pick up where you left off: three newest unfinished on the front desk, all of them on the Continue page', async () => {
  const names = (page) =>
    [...page.$('continueList').querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
  const desk = open(AT);
  await settle();
  assert.equal(desk.$('continueBox').hidden, false);
  assert.deepEqual(names(desk), ['Continue Clip 91', 'Continue Clip 93', 'Continue Clip 92']);
  assert.deepEqual(visibleHeadings(desk.document).slice(0, 2), ['H1 The Library', 'H2 Pick up where you left off']);
  desk.dom.window.close();
  const all = open(AT + '/continue');
  await settle();
  assert.deepEqual(names(all), ['Continue Clip 91', 'Continue Clip 93', 'Continue Clip 92', 'Continue Clip 90']);
  all.dom.window.close();
  const kept = answers.shelf;
  try {
    answers.shelf = () => ({ me: 'me1', librarian: false, familyLibrary: true, mine: [], borrowed: [row(94, { progress: place('2026-11-10T00:00:00Z', { finished: true }) })] });
    const none = open(AT);
    await settle();
    assert.equal(none.$('continueBox').hidden, true, 'absent when nothing is unfinished');
    none.dom.window.close();
  } finally {
    answers.shelf = kept;
  }
});

test('opening a folder moves focus to the crumb for where you now are', async () => {
  const page = open(AT + '/folders');
  await settle();
  assert.equal(page.$('crumbs').querySelector('button').textContent, 'All folders');
  assert.equal(page.$('crumbs').querySelector('button').getAttribute('aria-current'), 'location', 'at the top, the top crumb is where you are');
  const first = page.$('archiveList').querySelector('button');
  first.focus();
  first.click();
  await settle();
  assert.equal(page.document.activeElement.textContent, 'Video');
  assert.equal(page.document.activeElement.getAttribute('aria-current'), 'location');
  assert.equal(page.$('crumbs').querySelectorAll('[aria-current]').length, 1);
  assert.ok(page.$('crumbs').contains(page.document.activeElement));
  assert.equal(page.window.location.search, '?folder=Video', 'the folder is in the address');
  page.dom.window.close();
});

test('coming back from an item puts focus on the row it was opened from, once', async () => {
  const note = JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() });
  const page = open(AT + '/search', { 'library-return': note });
  await settle();
  assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  assert.equal(page.window.sessionStorage.getItem('library-return'), null);
  page.dom.window.close();
  const old = JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() - 3 * 3600 * 1000 });
  const stale = open(AT + '/search', { 'library-return': old });
  await settle();
  assert.equal(stale.document.activeElement, stale.document.body, 'an old note never moves focus');
  stale.dom.window.close();
});

test('a folder in the address reopens quietly on the way back, with focus on the row', async () => {
  const page = open(AT + '/folders?folder=Video%2FMissouri', {
    'library-return': JSON.stringify({ id: 'id2', host: 'archiveList', at: Date.now() }),
    'library-who': JSON.stringify({ me: 'me1', librarian: false }),
  });
  await settle(120);
  assert.ok(page.calls.some((call) => call.includes('/archive?path=Video%2FMissouri')));
  assert.ok(!page.calls.some((call) => call.includes('/shelf')), 'who you are is remembered from the front desk; the whole shelf is not fetched again');
  assert.ok(page.$('archiveList').contains(page.document.activeElement));
  assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  assert.equal(page.$('live').textContent, '', 'nothing is spoken when the page itself reopens a folder');
  page.dom.window.close();
});

test('a one-part clip: its own title, no shelf behind it, no chapter controls', async () => {
  const page = open(AT + '?book=id1');
  assert.ok(page.$('shelf').classList.contains('hidden'), 'the shelf steps aside before anything loads');
  await settle();
  assert.equal(page.document.title, 'Clip 1 — The Library — Kade-AI');
  assert.deepEqual(visibleHeadings(page.document), ['H1 The Library', 'H2 Clip 1']);
  assert.equal(page.$('prevSecBtn').hidden, true);
  assert.equal(page.$('nextSecBtn').hidden, true);
  assert.equal(page.$('chapterWrap').hidden, true);
  assert.equal(page.$('timeLine').hidden, false);
  assert.ok(!page.$('timeLine').hasAttribute('aria-live'), 'the clock is never spoken by itself');
  assert.ok(!/chapter/i.test(page.$('keysHint').textContent));
  assert.equal(page.document.activeElement.id, 'playBtn');
  assert.equal(page.$('skipLink').getAttribute('href'), '#bookTitle', 'the skip link goes to the item, not the whole page');
  assert.equal(page.$('skipLink').textContent, 'Skip to the item');
  assert.equal(page.$('skipLink').hidden, false);
  page.$('skipLink').click();
  assert.equal(page.document.activeElement.id, 'bookTitle');
  assert.equal(page.window.location.hash, '');
  page.dom.window.close();
});

test('a book keeps its chapter controls, and removing a bookmark keeps focus on the page', async () => {
  const page = open(AT + '?book=id4');
  await settle();
  assert.equal(page.$('prevSecBtn').hidden, false);
  assert.equal(page.$('prevSecBtn').textContent, 'Previous chapter');
  assert.equal(page.$('chapterWrap').hidden, false);
  assert.equal(page.$('timeLine').hidden, true);
  const remove = page.$('bookmarkList').querySelector('button.quiet');
  remove.focus();
  remove.click();
  await settle();
  assert.equal(page.document.activeElement.id, 'bookmarkSummary');
  page.dom.window.close();
});

const luminance = (hex) => {
  const part = (i) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * part(0) + 0.7152 * part(1) + 0.0722 * part(2);
};
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test('form field edges and the quiet button edge are dark enough to see (3 to 1)', () => {
  const field = source.match(/select, input\[type=text\], input\[type=file\], textarea \{[^}]*border:1px solid (#[0-9a-f]{6})/)[1];
  const fieldDark = source.match(/select, input\[type=text\], input\[type=file\], textarea \{ border-color:(#[0-9a-f]{6})/)[1];
  const quiet = source.match(/button\.act\.quiet, a\.act\.quiet \{ border-color:(#[0-9a-f]{6})/)[1];
  assert.ok(ratio(field, '#f6f7f9') >= 3, 'field edge on the light page');
  assert.ok(ratio(fieldDark, '#14161a') >= 3, 'field edge on the dark page');
  assert.ok(ratio(quiet, '#f6f7f9') >= 3, 'quiet button edge on the light page');
  assert.ok(ratio(quiet, '#14161a') >= 3, 'quiet button edge on the dark page');
});

test('a signed-out Library link comes back to the same place after sign-in', () => {
  assert.ok(source.includes("'/login?redirect_to=' + encodeURIComponent(location.pathname + location.search + location.hash)"));
  assert.ok(!source.includes("'/login?redirect='"), 'the sign-in page reads redirect_to, never redirect');
  const auth = fs.readFileSync(path.join(__dirname, '../../../client/src/hooks/AuthContext.tsx'), 'utf8');
  const hard = auth.match(/\[([^\]]*'\/request-access'[^\]]*)\]\.includes\(destinationPath\)/)[1];
  for (const page of ['/library', '/reading-room', '/family-history', '/agent-work'])
    assert.ok(hard.includes(`'${page}'`), page + ' is loaded as a server page after sign-in');
  assert.ok(auth.includes("destinationPath.startsWith('/library/')"), 'and so is every small page of the Library');
});

/* ── Independent review, Nov 10 2026 ─────────────────────────────────────── */

test('a return note whose row is not on the page is used up, and never steals focus later', async () => {
  const note = JSON.stringify({ id: 'id77', host: 'browseList', at: Date.now() - 20 * 60 * 1000 });
  const kept = answers.browse;
  try {
    const page = open(AT + '/search', { 'library-return': note });
    await settle();
    assert.equal(page.document.activeElement, page.document.body, 'the row is not there, so focus is left alone');
    assert.equal(page.window.sessionStorage.getItem('library-return'), null, 'and the note is gone after its one try');
    answers.browse = () => ({ total: 2, items: [row(77), row(78)], types: [], decades: [], next: null });
    page.$('searchBtn').focus();
    submit(page);
    await settle();
    assert.equal(page.document.activeElement.id, 'searchBtn', 'a later list that holds the item does not pull focus');
    page.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

test('a note waits for its own list, and a note for a list on another page is dropped', async () => {
  const kept = answers.browse;
  try {
    answers.browse = async () => {
      await settle(80);
      return kept();
    };
    const page = open(AT + '/search', {
      'library-return': JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() }),
    });
    await settle(40);
    assert.ok(page.window.sessionStorage.getItem('library-return'), 'still waiting for the results');
    await settle(140);
    assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
    page.dom.window.close();
  } finally {
    answers.browse = kept;
  }
  for (const [where, host] of [['', 'archiveList'], ['/search', 'archiveList'], ['/folders', 'browseList'], ['/playlists', 'browseList'], ['', 'somethingElse']]) {
    const other = open(AT + where, { 'library-return': JSON.stringify({ id: 'id2', host, at: Date.now() }) });
    await settle();
    assert.equal(other.window.sessionStorage.getItem('library-return'), null, host + ' note on ' + (where || 'the front desk'));
    other.dom.window.close();
  }
});

test('the skip link moves focus without writing a fragment, and a stray fragment does not kill the return', async () => {
  const page = open(AT + '/search');
  await settle();
  page.$('skipLink').click();
  assert.equal(page.document.activeElement.id, 'h-results');
  assert.equal(page.window.location.hash, '', 'no fragment left in the address');
  page.dom.window.close();
  const note = () => JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() });
  const old = open(AT + '/search#searchBox', { 'library-return': note() });
  await settle();
  assert.equal(old.document.activeElement.getAttribute('aria-label'), 'Open Clip 2', 'only a request link stands the note down');
  old.dom.window.close();
  const deep = open(AT + '#libraryRequests', { 'library-return': note() });
  await settle();
  assert.notEqual(deep.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  assert.equal(deep.window.sessionStorage.getItem('library-return'), null);
  deep.dom.window.close();
  assert.ok(!/location\.search\s*=[^=]/.test(source), 'every move goes through visit(), which leaves the fragment behind');
  assert.ok(source.includes("function visit(query){ location.href = BASE + (query || ''); }"));
  assert.ok(!/<main[^>]*tabindex/.test(html), 'main is not a focus target, so a click on plain text does not ring the whole page');
});

test('leaving an item by a link drops the return note; the playlist skip link is named for a playlist', async () => {
  const page = open(AT + '?book=id1', {
    'library-return': JSON.stringify({ id: 'id1', host: 'browseList', at: Date.now() }),
  });
  await settle();
  assert.ok(page.window.sessionStorage.getItem('library-return'), 'kept while the item is open, for Back to the shelf');
  page.document.querySelector('a.back').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(page.window.sessionStorage.getItem('library-return'), null);
  page.dom.window.close();
  const list = open(AT + '?collection=c1');
  assert.equal(list.$('skipLink').getAttribute('href'), '#collTitle');
  assert.equal(list.$('skipLink').textContent, 'Skip to the playlist');
  await settle();
  list.dom.window.close();
});

test('turning a folder page keeps focus on the pager and says the page; a dead button hands focus on', async () => {
  const kept = answers.archive;
  try {
    answers.archive = (url) => {
      const at = new URL(url, 'https://x.invalid').searchParams;
      return { crumbs: [{ name: 'Video' }], folders: [], items: [row(1), row(2)], total: 150, limit: 60, page: Number(at.get('page')) || 0 };
    };
    const page = open(AT + '/folders?folder=Video');
    await settle(120);
    const next = page.$('pageNext');
    next.focus();
    next.click();
    await settle();
    assert.equal(page.document.activeElement.id, 'pageNext', 'still on Next page, so it can be pressed again');
    assert.equal(page.$('live').textContent, 'Page 2 of 3 (150 items here).');
    next.click();
    await settle();
    assert.equal(next.disabled, true);
    assert.equal(page.document.activeElement.id, 'pagePrev', 'the last page: focus moves to the button that still works');
    page.dom.window.close();
  } finally {
    answers.archive = kept;
  }
});

test('a folder that cannot be loaded says why and puts focus on the page heading', async () => {
  const kept = answers.archive;
  try {
    const page = open(AT + '/folders');
    await settle();
    answers.archive = () => ({ failWith: 'The folder is not available.' });
    const first = page.$('archiveList').querySelector('button');
    first.focus();
    first.click();
    await settle();
    assert.equal(page.document.activeElement.id, 'pageTitle');
    assert.equal(page.$('pageTitle').textContent, 'Folders');
    assert.equal(page.$('live').textContent, 'The folder is not available.');
    assert.match(page.$('archiveList').textContent, /not available/);
    page.dom.window.close();
  } finally {
    answers.archive = kept;
  }
});

test('pick up where you left off: one stop a row, even for your own upload, and the name is said once', async () => {
  const kept = answers.shelf;
  try {
    answers.shelf = () => ({
      me: 'me1',
      librarian: false,
      familyLibrary: true,
      mine: [row(90, { owner: 'me1', path: '', progress: place('2026-11-09T00:00:00Z') })],
      borrowed: [],
    });
    const page = open(AT + '/continue');
    await settle();
    const buttons = [...page.$('continueList').querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    assert.deepEqual(buttons, ['Continue Clip 90']);
    assert.ok([...page.$('mineList').querySelectorAll('button')].some((button) => button.textContent === 'Add parts'), 'Add parts stays on Your shelf');
    assert.equal(page.$('continueBox').hasAttribute('aria-labelledby'), false);
    assert.equal(page.$('continueList').getAttribute('aria-labelledby'), 'h-continue');
    assert.deepEqual(visibleHeadings(page.document), ['H1 Continue and your shelf', 'H2 Pick up where you left off', 'H2 Your shelf']);
    page.dom.window.close();
  } finally {
    answers.shelf = kept;
  }
});

test('a search or a filter brings results that are below the screen into view; opening the page does not', async () => {
  const page = open(AT + '/search');
  const scrolled = [];
  page.window.Element.prototype.scrollIntoView = function () {
    scrolled.push(this.id || this.tagName);
  };
  page.window.Element.prototype.getBoundingClientRect = function () {
    return { top: 2000, bottom: 2040, left: 0, right: 0, width: 0, height: 40 };
  };
  await settle();
  assert.deepEqual(scrolled, [], 'the first load never moves the page');
  const kind = page.$('browseKind');
  kind.focus();
  kind.value = 'video';
  kind.dispatchEvent(new page.window.Event('change'));
  await settle();
  assert.deepEqual(scrolled, ['LI']);
  assert.equal(page.document.activeElement.id, 'browseKind', 'focus stays on the menu');
  page.$('searchBox').value = 'ky3';
  submit(page);
  await settle();
  assert.equal(scrolled.length, 2);
  page.dom.window.close();
});

test('the status line: held to two lines only while it is stuck over a scrolled page, and taps pass through', async () => {
  const page = open(AT + '/search');
  await settle();
  const live = page.$('live');
  live.classList.remove('fresh');
  page.$('searchBox').value = 'one';
  submit(page);
  await settle();
  assert.ok(live.classList.contains('fresh'));
  assert.ok(!live.classList.contains('held'), 'in its own place at the top it shows every line');
  live.classList.remove('fresh');
  live.getBoundingClientRect = () => ({ top: -900, bottom: -850 });
  page.$('searchBox').value = 'two';
  submit(page);
  await settle();
  assert.ok(live.classList.contains('held'));
  assert.match(source, /#live\.fresh \{[^}]*pointer-events:none/);
  assert.match(source, /#live\.fresh\.held \{ max-height:4\.5rem; overflow:hidden; \}/);
  assert.match(source, /html\.kade-art-off #live\.fresh \{ position:static/);
  assert.match(source, /html \{ scroll-padding-top:5rem; \}/);
  assert.equal(page.document.querySelectorAll('[aria-live]').length, 1);
  page.dom.window.close();
});

test('the focus ring on box rows, crumbs and focused headings shows on the light page and the dark one (3 to 1)', () => {
  const list = 'summary:focus-visible, nav\\.crumbs button:focus-visible, a\\.skip:focus, \\[tabindex="-1"\\]:focus-visible';
  const light = source.match(new RegExp(list + ' \\{ outline:3px solid (#[0-9a-f]{6})'))[1];
  const dark = source.match(new RegExp(list + ' \\{ outline-color:(#[0-9a-f]{6})'))[1];
  for (const ground of ['#f6f7f9', '#fff6da', '#ffffff']) assert.ok(ratio(light, ground) >= 3, 'light ring on ' + ground);
  assert.ok(ratio(dark, '#14161a') >= 3, 'dark ring on the dark page');
});
