'use strict';
/* Sep 24 2026. The Library's reading view: its settings, colors and paging
 * (client/public/assets/library/reader.js), the page route that feeds it, and
 * who may open an accessible edition's notice (kadeReadingRoom.js).
 * Run: node --test kadeReadingRoomReader.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readerSource = fs.readFileSync(path.join(__dirname, '../../../client/public/assets/library/reader.js'), 'utf8');
const routeSource = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
/** The reader's pure parts; objects are copied out of the script's own realm
 * so deepEqual compares values, not prototypes. */
function core() {
  const window = {};
  vm.runInNewContext(readerSource, { window });
  const c = window.libraryReaderCore;
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return { ...c, SETTINGS: plain(c.SETTINGS), DEFAULTS: plain(c.DEFAULTS), THEMES: plain(c.THEMES),
    normalize: (...a) => plain(c.normalize(...a)), seed: (...a) => plain(c.seed(...a)) };
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

test('every color choice keeps text at 7:1 or better, highlighted or not, and the marker visible', () => {
  const { THEMES } = core();
  for (const [name, [bg, fg, mark, hl]] of Object.entries(THEMES)) {
    assert.ok(contrast(fg, bg) >= 7, `${name} text ${contrast(fg, bg).toFixed(1)}`);
    assert.ok(contrast(fg, hl) >= 7, `${name} highlighted text ${contrast(fg, hl).toFixed(1)}`);
    assert.ok(contrast(mark, bg) >= 3, `${name} marker ${contrast(mark, bg).toFixed(1)}`);
  }
});

test('saved choices are checked; the first visit starts from the chat settings and the device', () => {
  const { normalize, seed, DEFAULTS } = core();
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize({ size: '9', colors: 'yellow', follow: false, extra: 'x' }), { ...DEFAULTS, colors: 'yellow', follow: false });
  assert.deepEqual(seed({}), DEFAULTS);
  assert.equal(seed({ highContrast: true, dark: true }).colors, 'dark');
  assert.equal(seed({ moreContrast: true, dark: false }).colors, 'light');
  assert.equal(seed({ font: 'opendyslexic' }).font, 'opendyslexic');
  assert.equal(seed({ font: 'comic' }).font, 'page');
  assert.equal(seed({ spacing: 'loose' }).lines, '2.6');
  // a saved choice wins over the seed; a missing one falls back to it
  assert.equal(normalize({ colors: 'cream' }, seed({ highContrast: true })).colors, 'cream');
  assert.equal(normalize({ size: '2' }, seed({ font: 'lexend' })).font, 'lexend');
});

test('pages, headings, and the chapter title spoken as the first passage', () => {
  const { PAGE, pageStart, pageHeading, isTitlePassage } = core();
  assert.equal(pageStart(0), 0);
  assert.equal(pageStart(PAGE - 1), 0);
  assert.equal(pageStart(PAGE + 3), PAGE);
  assert.equal(pageHeading('Chapter One: The Wrong Door', 0, 12), 'Chapter One: The Wrong Door');
  assert.equal(pageHeading('Part 1', PAGE, PAGE * 2 + 5), 'Part 1, page 2 of 3');
  assert.equal(pageHeading('', 0, 1), 'Untitled section');
  assert.ok(isTitlePassage('Chapter One: The Wrong Door.', 'Chapter One: The Wrong Door'));
  assert.ok(!isTitlePassage('Chapter One began with rain.', 'Chapter One'));
});

test('the settings a reader can change are labelled, plain words', () => {
  const { SETTINGS } = core();
  assert.deepEqual(SETTINGS.map((s) => s.label), ['Text size', 'Colors', 'Line spacing', 'Letter and word spacing', 'Line width', 'Typeface']);
  for (const s of SETTINGS) for (const [, label] of s.options) assert.match(label, /^[A-Z][A-Za-z ,]+$/);
});

function passagesHandler(book, stored) {
  const start = routeSource.indexOf("router.get('/book/:id/passages/:s'");
  const end = routeSource.indexOf('/* ── the voice', start);
  let handler;
  const context = {
    router: { get: (_p, _auth, fn) => { handler = fn; } }, requireJwtAuth: () => {},
    openBook: async () => book, isMedia: (b) => b && b.kind !== 'text',
    clampInt: (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; },
    KadeBookText: { findOne: (_q, projection) => ({ lean: async () => ({ sections: stored.slice(projection.sections.$slice[0], projection.sections.$slice[0] + 1) }) }) },
    require: () => ({ readingPassages: (chunks, kind, from, count) => chunks.slice(from, from + count).map((c) => (kind === 'jacket' ? 'jacket:' : '') + c) }),
    logger: { error: (m, e) => { throw e || new Error(m); } },
  };
  vm.runInNewContext(routeSource.slice(start, end), context);
  return async (s, query) => {
    let status = 200, body;
    await handler({ params: { id: 'b', s }, query, user: { id: 'u' } }, { status(n) { status = n; return this; }, json(j) { body = j; } });
    return { status, body };
  };
}

test('the reading view gets a page of a chapter in one request, capped, in narration positions', async () => {
  const book = { _id: 'b', kind: 'text', sections: [{ title: 'About this book', kind: 'jacket' }, { title: 'Chapter 1', kind: 'section' }] };
  const stored = [{ chunks: ['A book.'] }, { chunks: Array.from({ length: 100 }, (_, i) => `passage ${i}`) }];
  const get = passagesHandler(book, stored);
  let r = await get(1, { from: '40', count: '40' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.s, r.body.title, r.body.from, r.body.total, r.body.passages.length], [1, 'Chapter 1', 40, 100, 40]);
  assert.equal(r.body.passages[0], 'passage 40');
  r = await get(1, { from: '0', count: '5000' });
  assert.equal(r.body.passages.length, 60, 'never more than sixty passages at once');
  r = await get(0, {});
  assert.deepEqual(r.body.passages, ['jacket:A book.'], 'the jacket goes through the jacket cleaner');
  assert.equal((await get(1, { from: '100' })).status, 404);
  assert.equal((await get(7, {})).status, 404);
  assert.equal((await passagesHandler({ ...book, kind: 'audio' }, stored)(0, {})).status, 404);
  assert.equal((await passagesHandler(null, stored)(0, {})).status, 404);
});

test('an accessible edition notice is for the uploader and the librarian only', () => {
  const start = routeSource.indexOf('function noticeHidden(');
  const end = routeSource.indexOf('\n}\n', start) + 3;
  const context = { isAdmin: (req) => req.user.role === 'ADMIN', NOTICE_REASONS: new Set(['bookshare-notice', 'accessibility-notice']) };
  vm.runInNewContext(routeSource.slice(start, end), context);
  const book = { owner: 'amber', skipped: [{ reason: 'bookshare-notice' }, { reason: 'copyright' }, { reason: 'accessibility-notice' }] };
  const hidden = (user, k) => context.noticeHidden({ user }, book, k);
  assert.equal(hidden({ id: 'cousin' }, 0), true);
  assert.equal(hidden({ id: 'cousin' }, 2), true);
  assert.equal(hidden({ id: 'cousin' }, 1), false, 'a copyright page stays playable for everyone');
  assert.equal(hidden({ id: 'amber' }, 0), false);
  assert.equal(hidden({ id: 'kade', role: 'ADMIN' }, 2), false);
  assert.equal(hidden({ id: 'cousin' }, 9), false);
  assert.match(routeSource, /skipped: \(book\.skipped \|\| \[\]\)\.map\([^\n]*\.filter\(\(s\) => !noticeHidden\(req, book, s\.k\)\)/);
});

test('the player offers one reading-view button and loads the reader script', () => {
  const context = { require: () => ({ SHARED_HEAD: '', librarianGuide: { chatUrl: '/c/new' } }), module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8'), context);
  const html = context.module.exports.readingRoomHtml;
  assert.equal((html.match(/id="readingViewBtn"/g) || []).length, 1);
  assert.match(html, /<button class="act" id="readingViewBtn" type="button"[^>]*hidden>Open reading view<\/button>/);
  assert.match(html, /<script src="\/assets\/library\/reader\.js\?v=\d+"><\/script>/);
  // the skipped-parts list names no source
  assert.ok(/Front matter the library skips on its own: the copyright page/.test(html), 'skipped-parts hint');
  assert.ok(/'bookshare-notice': 'accessibility notice', 'accessibility-notice': 'accessibility notice'/.test(html), 'neutral reason labels');
});
