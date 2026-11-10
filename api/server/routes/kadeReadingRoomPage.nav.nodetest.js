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
    const body = answers[name] ? answers[name](text) : {};
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
  assert.equal(page.$('skipLink').getAttribute('href'), '#main');
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
