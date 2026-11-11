'use strict';
/* The Library page, loaded for real in jsdom with made-up answers, for the page's own tests
 * (kadeReadingRoomPage.*.nodetest.js). Nothing here talks to a server. Needs jsdom. */
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
/* Tests swap one of these for a moment and put it back. */
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
const shown = (node) => {
  for (; node; node = node.parentElement) {
    if (node.hidden || (node.classList && node.classList.contains('hidden'))) return false;
    if (node.tagName === 'DETAILS' && !node.open) return false;
  }
  return true;
};
const visibleHeadings = (document) =>
  [...document.querySelectorAll('h1,h2,h3')].filter(shown).map((heading) => heading.tagName + ' ' + heading.textContent.trim());
/* Every place the Tab key stops, in order, among what is shown. */
const tabStops = (document) =>
  [...document.querySelectorAll('a[href], button, input, select, textarea, summary, video[controls], [tabindex]')].filter(
    (node) =>
      shown(node.tagName === 'SUMMARY' ? node.parentElement.parentElement : node) &&
      !node.disabled &&
      node.type !== 'hidden' &&
      node.getAttribute('tabindex') !== '-1',
  );

module.exports = { source, html, row, place, answers, open, settle, shown, visibleHeadings, tabStops, JSDOM };
