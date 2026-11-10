'use strict';
/* Nov 10 2026: finding your way around the Library page, by ear and by eye.
 * What these hold: one main landmark and a skip link; every section heading reachable while its
 * box is closed; the local "start here" buttons above the results, not under them; focus that
 * never falls off the page when a list is redrawn; focus back on the item you came back from;
 * a one-part clip without chapter controls; and the "pick up where you left off" list.
 * Run: node --test api/server/routes/kadeReadingRoomPage.nav.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'kadeReadingRoomPage.js'), 'utf8');
const assets = path.join(__dirname, '../../../client/public/assets/library');
const context = {
  require: () => ({ SHARED_HEAD: '', librarianGuide: { chatUrl: '/c/new' } }),
  module: { exports: {} },
};
vm.runInNewContext(source, context);
const html = context.module.exports.readingRoomHtml;

const row = (n, extra) => ({
  id: 'id' + n,
  title: 'Clip ' + n,
  kind: 'video',
  category: 'commercials',
  typeLabel: 'Commercial',
  path: 'Video/Missouri',
  owner: 'someone',
  shared: true,
  progress: null,
  ...extra,
});
const place = (when, extra) => ({ s: 0, c: 0, pos: 30, finished: false, updatedAt: when, ...extra });
const answers = {
  shelf: () => ({
    me: 'me1',
    librarian: false,
    familyLibrary: true,
    mine: [row(90, { owner: 'me1', path: '', progress: place('2026-11-01T00:00:00Z') })],
    borrowed: [
      row(91, { progress: place('2026-11-09T00:00:00Z') }),
      row(92, { progress: place('2026-11-05T00:00:00Z') }),
      row(93, { progress: place('2026-11-08T00:00:00Z') }),
      row(94, { progress: place('2026-11-10T00:00:00Z', { finished: true }) }),
      row(95, { progress: { s: 0, c: 0, pos: 0, finished: false, updatedAt: '2026-11-10T00:00:00Z' } }),
    ],
  }),
  browse: () => ({ total: 3, items: [row(1), row(2), row(3)], types: [], decades: [], next: null }),
  archive: (url) => {
    const at = new URL(url, 'https://x.invalid').searchParams.get('path') || '';
    return at
      ? { crumbs: at.split('/').map((name) => ({ name })), folders: [], items: [row(1), row(2)], total: 2, limit: 60, page: 0 }
      : { crumbs: [], folders: [{ name: 'Video', path: 'Video', count: 2 }], items: [], total: 0, limit: 60, page: 0 };
  },
  collections: () => ({ mine: [], shared: [] }),
  submissions: () => ({ submissions: [], librarian: false }),
  requests: () => ({ admin: false, canRequest: true, requests: [], next: null }),
  book: (url) =>
    /id4/.test(url)
      ? { id: 'id4', title: 'A Book', kind: 'text', chapters: [{ title: 'One', chunks: 2 }, { title: 'Two', chunks: 2 }], bookmarks: [{ id: 'b1', s: 0, c: 0, sectionTitle: 'One' }], skipped: [], mine: true, progress: null, defaultVoice: 'V' }
      : { id: 'id1', title: 'Clip 1', kind: 'video', category: 'commercials', tracks: [{ title: 'Clip 1', seconds: 30, mime: 'video/mp4', url: '/x.mp4' }], bookmarks: [], skipped: [], mine: false, progress: null, defaultVoice: 'V' },
};

function open(url, session) {
  const quiet = new VirtualConsole(); // jsdom has no media playback; its "not implemented" notes are noise here
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: quiet });
  const { window } = dom;
  Object.entries(session || {}).forEach(([key, value]) => window.sessionStorage.setItem(key, value));
  const calls = [];
  window.getToken = async () => 'token';
  window.fetch = async (address, options) => {
    const text = String(address);
    calls.push((options && options.method ? options.method : 'GET') + ' ' + text);
    const name = (text.replace('/api/kade/reading-room/', '').match(/^[a-z]+/) || [''])[0];
    const body = answers[name] ? await answers[name](text) : {};
    if (body && body.failWith) return { ok: false, status: 500, json: async () => ({ error: body.failWith }) };
    return { ok: true, status: 200, json: async () => body };
  };
  window.HTMLMediaElement.prototype.load = function () {};
  window.HTMLMediaElement.prototype.play = async function () {};
  window.HTMLMediaElement.prototype.pause = function () {};
  window.Element.prototype.scrollIntoView = function () {};
  ['browse.js', 'requests.js', 'reader.js', 'access.js'].forEach((file) =>
    window.eval(fs.readFileSync(path.join(assets, file), 'utf8')),
  );
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  window.eval(inline[inline.length - 1]);
  return { dom, window, document: window.document, calls, $: (id) => window.document.getElementById(id) };
}
const settle = async (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const visibleHeadings = (document) =>
  [...document.querySelectorAll('h1,h2,h3')]
    .filter((heading) => {
      for (let node = heading; node; node = node.parentElement) {
        if (node.hidden || (node.classList && node.classList.contains('hidden'))) return false;
        if (node.tagName === 'DETAILS' && !node.open) return false;
      }
      return true;
    })
    .map((heading) => heading.tagName + ' ' + heading.textContent.trim());

test('the page has one main landmark, a skip link to search, and a named search form', () => {
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelectorAll('main').length, 1);
  assert.ok(document.querySelector('main').contains(document.getElementById('pageTitle')));
  const skip = document.querySelector('a.skip');
  assert.equal(skip.getAttribute('href'), '#searchBox');
  assert.equal(document.body.firstElementChild, skip, 'the skip link is the first thing on the page');
  assert.equal(document.getElementById('browseForm').getAttribute('role'), 'search');
  assert.ok(document.getElementById('browseForm').getAttribute('aria-label'));
  assert.equal(document.querySelectorAll('[aria-live]').length, 1, 'still exactly one live region');
});

test('no section heading hides inside a closed box, and each box is named for its heading', () => {
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelectorAll('#shelf details h2').length, 0);
  for (const id of ['h-archive', 'h-collections', 'h-mine']) {
    const heading = document.getElementById(id);
    assert.equal(heading.tagName, 'H2');
    assert.equal(heading.nextElementSibling.tagName, 'DETAILS', id + ' sits right above its box');
  }
  assert.equal(document.getElementById('h-collections').textContent, 'Your playlists');
  assert.match(document.querySelector('#h-collections + details summary').textContent, /playlists/);
  assert.match(document.querySelector('#h-mine + details summary').textContent, /shelf/);
});

test('the local start-here buttons come after search and before the results', () => {
  const { document } = new JSDOM(html).window;
  const order = (a, b) => !!(a.compareDocumentPosition(b) & 4); // b follows a
  const local = document.getElementById('discoveryLinks');
  assert.ok(order(document.getElementById('searchBox'), local));
  assert.ok(order(local, document.getElementById('h-results')));
  assert.ok(order(document.getElementById('h-results'), document.getElementById('browseList')));
  assert.equal(document.getElementById('browseList').getAttribute('aria-labelledby'), 'h-results');
  assert.ok(!html.includes('var(--border)'), 'no colour variable that is never defined');
});

test('a start-here button puts focus on the Results heading; a filter leaves focus alone', async () => {
  const page = open('https://example.invalid/library');
  await settle();
  page.document.querySelector('#discoveryLinks button').click();
  await settle();
  assert.equal(page.document.activeElement.id, 'h-results');
  assert.equal(page.$('h-results').textContent, 'Results: Videos · Missouri');
  const kind = page.$('browseKind');
  kind.focus();
  kind.value = 'video';
  kind.dispatchEvent(new page.window.Event('change'));
  await settle();
  assert.equal(page.document.activeElement.id, 'browseKind');
  page.dom.window.close();
});

test('pick up where you left off: three newest unfinished items, and none when nothing is unfinished', async () => {
  const page = open('https://example.invalid/library');
  await settle();
  assert.equal(page.$('continueBox').hidden, false);
  const names = [...page.$('continueList').querySelectorAll('button')]
    .map((button) => button.getAttribute('aria-label'))
    .filter((name) => /^Continue /.test(name));
  assert.deepEqual(names, ['Continue Clip 91', 'Continue Clip 93', 'Continue Clip 92']);
  assert.equal(visibleHeadings(page.document)[1], 'H2 Pick up where you left off');
  page.dom.window.close();
});

test('opening a folder moves focus to the crumb for where you now are', async () => {
  const page = open('https://example.invalid/library');
  await settle();
  page.$('folderBrowse').open = true;
  page.$('folderBrowse').dispatchEvent(new page.window.Event('toggle'));
  await settle();
  const first = page.$('archiveList').querySelector('button');
  first.focus();
  first.click();
  await settle();
  assert.equal(page.document.activeElement.textContent, 'Video');
  assert.equal(page.document.activeElement.getAttribute('aria-current'), 'location');
  assert.ok(page.$('crumbs').contains(page.document.activeElement));
  assert.equal(JSON.parse(page.window.sessionStorage.getItem('library-folders')).path, 'Video');
  page.dom.window.close();
});

test('coming back from an item puts focus on the row it was opened from, once', async () => {
  const note = JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() });
  const page = open('https://example.invalid/library', { 'library-return': note });
  await settle();
  assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  assert.equal(page.window.sessionStorage.getItem('library-return'), null);
  page.dom.window.close();
  const old = JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() - 3 * 3600 * 1000 });
  const stale = open('https://example.invalid/library', { 'library-return': old });
  await settle();
  assert.equal(stale.document.activeElement, stale.document.body, 'an old note never moves focus');
  stale.dom.window.close();
});

test('a remembered folder reopens quietly on the way back', async () => {
  const page = open('https://example.invalid/library', {
    'library-folders': JSON.stringify({ open: true, path: 'Video/Missouri', page: 0 }),
    'library-return': JSON.stringify({ id: 'id2', host: 'archiveList', at: Date.now() }),
  });
  await settle(120); // the page opens the box itself, and the box's own toggle event loads the folder
  assert.equal(page.$('folderBrowse').open, true);
  assert.ok(page.calls.some((call) => call.includes('/archive?path=Video%2FMissouri')));
  assert.ok(page.$('archiveList').contains(page.document.activeElement));
  assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  page.dom.window.close();
});

test('a one-part clip: its own title, no shelf behind it, no chapter controls', async () => {
  const page = open('https://example.invalid/library?book=id1');
  assert.ok(page.$('shelf').classList.contains('hidden'), 'the shelf steps aside before anything loads');
  assert.equal(page.$('librarianCard').hidden, true);
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
  page.$('skipLink').click();
  assert.equal(page.document.activeElement.id, 'bookTitle');
  assert.equal(page.window.location.hash, '');
  page.dom.window.close();
});

test('a book keeps its chapter controls, and removing a bookmark keeps focus on the page', async () => {
  const page = open('https://example.invalid/library?book=id4');
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

test('form field edges and the quiet button edge are dark enough to see (3 to 1)', () => {
  const luminance = (hex) => {
    const part = (i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * part(0) + 0.7152 * part(1) + 0.0722 * part(2);
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
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
});

/* ── Independent review, Nov 10 2026 ─────────────────────────────────────── */

test('a return note whose row is not on the page is used up, and never steals focus later', async () => {
  const note = JSON.stringify({ id: 'id77', host: 'browseList', at: Date.now() - 20 * 60 * 1000 });
  const kept = answers.browse;
  try {
    const page = open('https://example.invalid/library', { 'library-return': note });
    await settle();
    assert.equal(page.document.activeElement, page.document.body, 'the row is not there, so focus is left alone');
    assert.equal(page.window.sessionStorage.getItem('library-return'), null, 'and the note is gone after its one try');
    answers.browse = () => ({ total: 2, items: [row(77), row(78)], types: [], decades: [], next: null });
    page.document.querySelector('#discoveryLinks button').click();
    await settle();
    assert.equal(page.document.activeElement.id, 'h-results', 'a later list that holds the item does not pull focus off the heading');
    page.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

test('a note waits for its own list: the shelf loading first does not use up a note for the results', async () => {
  const kept = answers.browse;
  try {
    answers.browse = async () => {
      await settle(80);
      return kept();
    };
    const page = open('https://example.invalid/library', {
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
});

test('a note for the folders is dropped when no folder is going to reopen; so is a note for an unknown list', async () => {
  const page = open('https://example.invalid/library', {
    'library-return': JSON.stringify({ id: 'id2', host: 'archiveList', at: Date.now() }),
  });
  await settle();
  assert.equal(page.window.sessionStorage.getItem('library-return'), null);
  page.dom.window.close();
  const odd = open('https://example.invalid/library', {
    'library-return': JSON.stringify({ id: 'id2', host: 'somethingElse', at: Date.now() }),
  });
  await settle();
  assert.equal(odd.window.sessionStorage.getItem('library-return'), null);
  odd.dom.window.close();
});

test('the skip link moves focus without writing a fragment, and a stray fragment does not kill the return', async () => {
  const page = open('https://example.invalid/library');
  await settle();
  page.$('skipLink').click();
  assert.equal(page.document.activeElement.id, 'searchBox');
  assert.equal(page.window.location.hash, '', 'no #searchBox left in the address');
  page.dom.window.close();
  const note = () => JSON.stringify({ id: 'id2', host: 'browseList', at: Date.now() });
  const old = open('https://example.invalid/library#searchBox', { 'library-return': note() });
  await settle();
  assert.equal(old.document.activeElement.getAttribute('aria-label'), 'Open Clip 2', 'only a request link stands the note down');
  old.dom.window.close();
  const deep = open('https://example.invalid/library#libraryRequests', { 'library-return': note() });
  await settle();
  assert.notEqual(deep.document.activeElement.getAttribute('aria-label'), 'Open Clip 2');
  assert.equal(deep.window.sessionStorage.getItem('library-return'), null);
  deep.dom.window.close();
  assert.ok(!/location\.search\s*=[^=]/.test(source), 'every move goes through visit(), which leaves the fragment behind');
  assert.ok(source.includes("function visit(query){ location.href = location.pathname + (query || ''); }"));
  assert.ok(!/<main[^>]*tabindex/.test(html), 'main is not a focus target, so a click on plain text does not ring the whole page');
});

test('leaving an item by a link drops the return note; the playlist skip link is named for a playlist', async () => {
  const page = open('https://example.invalid/library?book=id1', {
    'library-return': JSON.stringify({ id: 'id1', host: 'browseList', at: Date.now() }),
  });
  await settle();
  assert.ok(page.window.sessionStorage.getItem('library-return'), 'kept while the item is open, for Back to the shelf');
  page.document.querySelector('a.back').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(page.window.sessionStorage.getItem('library-return'), null);
  page.dom.window.close();
  const list = open('https://example.invalid/library?collection=c1');
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
    const page = open('https://example.invalid/library', {
      'library-folders': JSON.stringify({ open: true, path: 'Video', page: 0 }),
    });
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

test('a folder that cannot be loaded says why and puts focus on the Folders heading', async () => {
  const kept = answers.archive;
  try {
    const page = open('https://example.invalid/library');
    await settle();
    page.$('folderBrowse').open = true;
    page.$('folderBrowse').dispatchEvent(new page.window.Event('toggle'));
    await settle();
    answers.archive = () => ({ failWith: 'The folder is not available.' });
    const first = page.$('archiveList').querySelector('button');
    first.focus();
    first.click();
    await settle();
    assert.equal(page.document.activeElement.id, 'h-archive');
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
    const page = open('https://example.invalid/library');
    await settle();
    const buttons = [...page.$('continueList').querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    assert.deepEqual(buttons, ['Continue Clip 90']);
    assert.ok([...page.$('mineList').querySelectorAll('button')].some((button) => button.textContent === 'Add parts'), 'Add parts stays on Your shelf');
    assert.equal(page.$('continueBox').hasAttribute('aria-labelledby'), false);
    assert.equal(page.$('continueList').getAttribute('aria-labelledby'), 'h-continue');
    page.dom.window.close();
  } finally {
    answers.shelf = kept;
  }
});

test('a search or a filter brings results that are below the screen into view; opening the page does not', async () => {
  const page = open('https://example.invalid/library');
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
  page.$('browseForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(scrolled.length, 2);
  page.dom.window.close();
});

test('the status line: held to two lines only while it is stuck over a scrolled page, and taps pass through', async () => {
  const page = open('https://example.invalid/library');
  await settle();
  const live = page.$('live');
  live.classList.remove('fresh');
  page.document.querySelector('#discoveryLinks button').click();
  await settle();
  assert.ok(live.classList.contains('fresh'));
  assert.ok(!live.classList.contains('held'), 'in its own place at the top it shows every line');
  live.classList.remove('fresh');
  live.getBoundingClientRect = () => ({ top: -900, bottom: -850 });
  page.document.querySelector('#discoveryLinks button').click();
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
  const luminance = (hex) => {
    const part = (i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * part(0) + 0.7152 * part(1) + 0.0722 * part(2);
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const list = 'summary:focus-visible, nav\\.crumbs button:focus-visible, a\\.skip:focus, \\[tabindex="-1"\\]:focus-visible';
  const light = source.match(new RegExp(list + ' \\{ outline:3px solid (#[0-9a-f]{6})'))[1];
  const dark = source.match(new RegExp(list + ' \\{ outline-color:(#[0-9a-f]{6})'))[1];
  for (const ground of ['#f6f7f9', '#fff6da', '#ffffff']) assert.ok(ratio(light, ground) >= 3, 'light ring on ' + ground);
  assert.ok(ratio(dark, '#14161a') >= 3, 'dark ring on the dark page');
});
