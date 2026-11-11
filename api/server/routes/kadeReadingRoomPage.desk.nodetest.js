'use strict';
/* Nov 10 2026 (redesign): the web Library takes the phone's map.
 * /library is a short front desk; each row opens its own small page with its own address, title
 * and first-level heading. What these hold: the rows and their order; that each page shows only
 * its own blocks and asks the server only for what it shows; that old links and bookmarks still
 * land in the right place; and the Family feature pack rule (marked, never hidden; the App Review
 * seat is told nothing).
 * Run: node --test api/server/routes/kadeReadingRoomPage.desk.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { source, html, row, place, answers, open, settle, shown, visibleHeadings, tabStops } = require('./kadeReadingRoomPage.rig');

const AT = 'https://example.invalid/library';
const apiCalls = (page) => page.calls.map((call) => call.replace(/^GET \/api\/kade\/reading-room/, '').replace(/\?.*/, ''));
const views = () => {
  const context = { require: () => ({ SHARED_HEAD: '', librarianGuide: { chatUrl: '/c/new' } }), module: { exports: {} } };
  vm.runInNewContext(source, context);
  return Array.from(context.module.exports.LIBRARY_VIEWS);
};

test('the front desk: the rows, in the phone order, each a link to its own page', async () => {
  const page = open(AT);
  await settle();
  const rows = [...page.$('deskNav').querySelectorAll('a')].filter(shown);
  assert.deepEqual(
    rows.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')]),
    [
      ['Continue and your shelf', '/library/continue'],
      ['Springfield and the Ozarks', '/library/local'],
      ['Browse and search', '/library/search'],
      ['Folders', '/library/folders'],
      ['Playlists', '/library/playlists'],
      ['Family shelves', '/library/family'],
      ['Requests', '/library/requests'],
      ['Add to the Library', '/library/add'],
      ['Talk to the Librarian', '/c/new'],
    ],
  );
  for (const a of rows) {
    const hint = page.$(a.getAttribute('aria-describedby'));
    assert.ok(hint && hint.textContent.length > 20, 'each row says what is behind it');
    assert.ok(a.querySelector('strong').textContent === a.getAttribute('aria-label'), 'the name a screen reader says is the name on screen');
    assert.equal(a.querySelector('.hicon').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(page.$('deskNav').tagName, 'NAV');
  assert.equal(page.$('deskNav').getAttribute('aria-labelledby'), 'h-desk');
  assert.deepEqual(visibleHeadings(page.document), ['H1 The Library', 'H2 Pick up where you left off', 'H2 Around the Library']);
  assert.equal(page.document.title, 'The Library — Kade-AI');
  assert.equal(page.$('backLink').getAttribute('href'), '/home');
  assert.equal(page.$('backLink').getAttribute('aria-label'), 'Back to Home');
  page.dom.window.close();
});

test('the front desk is short and makes one small call', async () => {
  const page = open(AT);
  await settle();
  assert.deepEqual(apiCalls(page), ['/shelf'], 'no catalogue, folders, playlists or requests until they are asked for');
  const stops = tabStops(page.document);
  assert.ok(stops.length <= 13, 'Home, up to three Continue rows and nine rows: ' + stops.length + ' Tab stops');
  assert.equal(page.$('mineList').querySelectorAll('li').length, 0, 'the whole shelf is not drawn here');
  assert.equal(page.$('browseList').children.length, 0);
  assert.equal(page.document.activeElement, page.document.body, 'opening the Library never moves focus');
  page.dom.window.close();
});

test('each small page: its own heading, title and way back, and only its own blocks', async () => {
  const pages = {
    continue: ['Continue and your shelf', ['/shelf']],
    local: ['Springfield and the Ozarks', []],
    search: ['Browse and search', ['/browse']],
    folders: ['Folders', ['/shelf', '/archive']],
    playlists: ['Playlists', ['/collections']],
    family: ['Family shelves', ['/shelf', '/archive']],
    requests: ['Requests', ['/submissions', '/requests']],
    add: ['Add to the Library', []],
    librarian: ["The librarian's desk", ['/shelf', '/submissions']],
  };
  assert.deepEqual(Object.keys(pages), views(), 'every page the server knows is covered here');
  for (const [name, [title, calls]] of Object.entries(pages)) {
    const page = open(AT + '/' + name);
    await settle(100);
    assert.equal(page.$('pageTitle').textContent, title);
    assert.equal(page.document.title, title + ' — The Library — Kade-AI');
    assert.equal(visibleHeadings(page.document)[0], 'H1 ' + title);
    assert.equal(page.document.querySelectorAll('h1').length, 1);
    assert.equal(page.$('backLink').getAttribute('href'), '/library');
    assert.equal(page.$('backLink').getAttribute('aria-label'), 'Back to the Library');
    assert.equal(page.document.documentElement.getAttribute('data-view'), name);
    for (const block of page.document.querySelectorAll('[data-views]'))
      assert.equal(block.hidden, !block.getAttribute('data-views').split(' ').includes(name), name + ': ' + block.getAttribute('data-views'));
    assert.deepEqual(apiCalls(page).sort(), calls.slice().sort(), name + ' asks only for what it shows');
    const levels = visibleHeadings(page.document).map((heading) => Number(heading[1]));
    levels.forEach((level, i) => assert.ok(i === 0 || level - levels[i - 1] <= 1, name + ': no heading level is skipped'));
    assert.equal(page.document.activeElement, page.document.body, name + ': opening a page never moves focus');
    page.dom.window.close();
  }
});

test('nothing flashes: the head names the page before the body is drawn, and the CSS hides the other blocks', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const script = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('kadeLibraryView'));
  assert.ok(script, 'the which-page check runs in the head');
  const pick = (address) => {
    const at = new URL(address, 'https://example.invalid');
    const element = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    vm.runInNewContext(script, { document: { documentElement: element }, location: at, URLSearchParams });
    return element.attrs['data-view'];
  };
  assert.equal(pick('/library'), 'desk');
  assert.equal(pick('/library/'), 'desk');
  assert.equal(pick('/reading-room'), 'desk');
  for (const name of views()) {
    assert.equal(pick('/library/' + name), name);
    assert.ok(head.includes(`html[data-view="${name}"] [data-views]:not([data-views~="${name}"])`), 'a rule for ' + name);
  }
  assert.ok(head.includes('html[data-view="desk"] [data-views]:not([data-views~="desk"])'));
  assert.ok(head.includes('html[data-view="item"] [data-views], html[data-view="playlist"] [data-views] { display:none !important; }'));
  // old links and bookmarks
  assert.equal(pick('/library?book=abc'), 'item');
  assert.equal(pick('/library/search?book=abc&q=1,2'), 'item');
  assert.equal(pick('/library?collection=c1'), 'playlist');
  assert.equal(pick('/library?request=r1#libraryRequests'), 'requests');
  assert.equal(pick('/library#libraryRequests'), 'requests');
  assert.equal(pick('/library?q=meeks'), 'search');
  assert.equal(pick('/library?under=Videos%2FMissouri&page=2'), 'search');
  assert.equal(pick('/library?folder=Video'), 'folders');
  assert.equal(pick('/library/nonsense'), 'desk');
  assert.equal(pick('/library#searchBox'), 'desk');
});

test('old links land in the right place: an item, a playlist, a request alert', async () => {
  const item = open(AT + '?book=id1');
  await settle();
  assert.equal(item.$('player').classList.contains('hidden'), false);
  assert.equal(item.$('bookTitle').textContent, 'Clip 1');
  item.dom.window.close();
  const kept = answers.requests;
  try {
    const asked = [];
    answers.requests = (url) => {
      asked.push(url);
      return kept();
    };
    const alert = open(AT + '?request=abc123#libraryRequests');
    await settle(100);
    assert.equal(alert.$('pageTitle').textContent, 'Requests');
    assert.ok(asked.length > 0, 'the requests are loaded');
    assert.equal(alert.document.querySelector('[data-views="requests"]').hidden, false);
    alert.dom.window.close();
  } finally {
    answers.requests = kept;
  }
});

test('the server serves every page of the Library and sends anything else to the front desk', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.ok(index.includes("app.get('/library', routes.kadeReadingRoom.page);"));
  assert.ok(index.includes("app.get('/library/:view', routes.kadeReadingRoom.page);"));
  assert.ok(index.includes("app.get('/reading-room', routes.kadeReadingRoom.page);"), "the room's first name still works");
  const router = fs.readFileSync(path.join(__dirname, 'kadeReadingRoom.js'), 'utf8');
  const body = router.match(/router\.page = \(req, res\) => \{([\s\S]*?)\n\};/)[1];
  const sent = [];
  const page = new Function('LIBRARY_VIEWS', 'readingRoomHtml', 'return (req, res) => {' + body + '};')(views(), 'PAGE');
  const res = { redirect: (code, to) => sent.push([code, to]), type: () => ({ send: (text) => sent.push(text) }) };
  page({ params: {} }, res);
  page({ params: { view: 'search' } }, res);
  page({ params: { view: 'constructor' } }, res);
  page({ params: { view: 'Search' } }, res);
  assert.deepEqual(sent, ['PAGE', 'PAGE', [302, '/library'], [302, '/library']]);
  /* the service worker must never treat a Library page as a chat page (it would reload it) */
  const heal = fs.readFileSync(path.join(__dirname, '../../../client/sw/heal.js'), 'utf8');
  const list = heal.match(/return \/\^\(\?:([^)]*)\)/)[1].split('|');
  assert.ok(!list.includes('library') && !list.includes('reading-room'));
});

test('the Family feature pack: the row is always there, marked in words; the review seat is told nothing', async () => {
  const kept = answers.shelf;
  try {
    const shelf = (familyLibrary, librarian) => () => ({ me: 'me1', librarian: !!librarian, familyLibrary, mine: [], borrowed: [] });
    answers.shelf = shelf(false);
    const stranger = open(AT);
    await settle();
    const locked = stranger.$('row-family');
    assert.ok(shown(locked), 'never hidden');
    assert.ok(locked.classList.contains('locked'));
    assert.match(stranger.$('rowhint-family').textContent, /Family feature pack$/, 'said with the row, not by colour');
    assert.equal(locked.getAttribute('href'), '/library/family', 'and it still opens the page that explains');
    assert.equal(stranger.$('familyLibraryNotice').hidden, false);
    assert.equal(stranger.$('row-desk').hidden, true);
    stranger.dom.window.close();
    const page = open(AT + '/family');
    await settle(100);
    assert.equal(page.$('familyLibraryNotice').hidden, false);
    assert.match(page.$('familyLibraryNotice').textContent, /Ask Kade/);
    assert.equal(page.$('familyList').children.length, 0);
    assert.equal(page.$('familyHistoryLink').hidden, true);
    assert.ok(!page.calls.some((call) => call.includes('/archive')));
    page.dom.window.close();

    answers.shelf = shelf(null);
    const review = open(AT);
    await settle();
    assert.ok(!review.$('row-family').classList.contains('locked'));
    assert.equal(review.$('familyLibraryNotice').hidden, true, 'the review seat hears nothing about a family collection');
    review.dom.window.close();
    const reviewPage = open(AT + '/family');
    await settle(100);
    assert.equal(reviewPage.$('familyLibraryNotice').hidden, true);
    assert.equal(reviewPage.$('familyBlurb').hidden, true);
    reviewPage.dom.window.close();

    answers.shelf = shelf(true, true);
    const family = open(AT);
    await settle();
    assert.ok(!family.$('row-family').classList.contains('locked'));
    assert.equal(family.$('row-desk').hidden, false, "the librarian sees the librarian's desk row");
    assert.equal(family.$('row-desk').getAttribute('href'), '/library/librarian');
    family.dom.window.close();
    const shelves = open(AT + '/family');
    await settle(100);
    const links = [...shelves.$('familyList').querySelectorAll('a')];
    assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href')]), [['Video (2 items)', '/library/folders?folder=Video']]);
    assert.equal(shelves.$('familyHistoryLink').hidden, false);
    assert.equal(shelves.$('familyBlurb').hidden, false);
    shelves.dom.window.close();
  } finally {
    answers.shelf = kept;
  }
});

test('the local page: home first, every row a plain link into the real shelves', async () => {
  const page = open(AT + '/local');
  await settle();
  const links = [...page.$('localNav').querySelectorAll('a')].map((a) => [a.querySelector('strong').textContent, decodeURIComponent(a.getAttribute('href'))]);
  assert.deepEqual(links, [
    ['Local television', '/library/folders?folder=Videos/Ozarks (Springfield Area)'],
    ['Local radio and audio', '/library/folders?folder=Audio/Ozarks (Springfield Area)'],
    ['Missouri', '/library/folders?folder=Videos/Missouri'],
    ['Everything that mentions Springfield', '/library/search?q=Springfield'],
  ]);
  /* the shelf names are the ones the phone's Springfield screen opens (kadeReadingRoomTree.js) */
  const tree = fs.readFileSync(path.join(__dirname, 'kadeReadingRoomTree.js'), 'utf8');
  assert.ok(tree.includes("const LOCAL_VIDEO = 'Videos/Ozarks (Springfield Area)';"));
  assert.ok(tree.includes("const LOCAL_AUDIO = 'Audio/Ozarks (Springfield Area)';"));
  assert.deepEqual(visibleHeadings(page.document), ['H1 Springfield and the Ozarks', 'H2 From everywhere']);
  assert.deepEqual(apiCalls(page), [], 'a page of links needs no call at all');
  page.dom.window.close();
});

test('Add parts on a shelf row opens the Add page at that item', async () => {
  const kept = answers.shelf;
  const keptBook = answers.book;
  try {
    answers.shelf = () => ({ me: 'me1', librarian: false, familyLibrary: true, mine: [row(90, { owner: 'me1', path: '', progress: place('2026-11-09T00:00:00Z') })], borrowed: [] });
    const shelf = open(AT + '/continue');
    await settle();
    const add = [...shelf.$('mineList').querySelectorAll('button')].find((button) => button.textContent === 'Add parts');
    assert.equal(add.getAttribute('aria-label'), 'Add parts to Clip 90');
    assert.ok(source.includes("add.onclick = function(){ location.href = BASE + '/add?parts=' + encodeURIComponent(b.id); };"));
    shelf.dom.window.close();
    answers.book = () => ({ id: 'id90', title: 'Clip 90', kind: 'audio', tracks: [{ title: 'Side A' }] });
    const page = open(AT + '/add?parts=id90');
    await settle(100);
    assert.equal(page.$('auTracks').classList.contains('hidden'), false);
    assert.match(page.$('auTracksHint').textContent, /Clip 90.*1 part so far/);
    assert.equal(page.document.activeElement.id, 'auFile');
    assert.equal(page.$('live').textContent, 'Add a part to Clip 90.');
    page.dom.window.close();
  } finally {
    answers.shelf = kept;
    answers.book = keptBook;
  }
});

test("the librarian's desk: only for the librarian, and deciding keeps focus on the page", async () => {
  const stranger = open(AT + '/librarian');
  await settle(100);
  assert.equal(stranger.$('reviewNo').hidden, false);
  assert.equal(stranger.$('reviewWrap').hidden, true);
  stranger.dom.window.close();
  const kept = answers.submissions;
  const keptShelf = answers.shelf;
  try {
    const waiting = [{ id: 's1', type: 'submission', userName: 'Amber', url: 'https://example.invalid/v', title: 'KY3 1994', status: 'pending' }];
    answers.submissions = (url) => (/decide/.test(url) ? {} : { submissions: /status=pending/.test(url) ? waiting : [], librarian: true });
    answers.shelf = () => ({ me: 'me1', librarian: true, familyLibrary: true, mine: [], borrowed: [] });
    const page = open(AT + '/librarian');
    page.window.prompt = () => '';
    await settle(120);
    assert.equal(page.$('reviewNo').hidden, true);
    assert.equal(page.$('reviewWrap').hidden, false);
    assert.deepEqual(visibleHeadings(page.document).slice(0, 3), ["H1 The librarian's desk", "H2 The librarian's sorting", 'H2 Waiting for the librarian']);
    const approve = page.$('reviewList').querySelector('button.primary');
    approve.focus();
    approve.click();
    await settle(120);
    assert.equal(page.document.activeElement.id, 'h-review', 'the pressed button is gone with the old list; focus is on the list heading');
    assert.equal(page.$('live').textContent, 'Approved.');
    page.dom.window.close();
  } finally {
    answers.submissions = kept;
    answers.shelf = keptShelf;
  }
});

test('a playlist goes back to the playlists page, and an item played from it comes back to the playlist', async () => {
  const kept = answers.collections;
  try {
    answers.collections = (url) =>
      /collections\/c1/.test(url)
        ? { id: 'c1', title: 'Saturday', mine: true, shared: false, items: [{ n: 0, title: 'Clip 1', track: 0, book: { id: 'id1', kind: 'video', category: 'commercials' } }] }
        : { mine: [{ id: 'c1', title: 'Saturday', count: 1, shared: false }], shared: [] };
    const list = open(AT + '/playlists');
    await settle();
    assert.equal(list.$('collectionList').getAttribute('aria-labelledby'), 'pageTitle');
    assert.equal(list.$('collectionList').querySelector('button').getAttribute('aria-label'), 'Open collection Saturday');
    list.dom.window.close();
    const page = open(AT + '?collection=c1');
    await settle();
    assert.equal(page.$('collBack').textContent.replace(/^\W+/, ''), 'Back to playlists');
    assert.ok(source.includes("$('collBack').onclick = function(){ visit('/playlists'); };"));
    page.$('collItems').querySelector('button').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    const note = JSON.parse(page.window.sessionStorage.getItem('library-return'));
    assert.equal(note.from, '/library?collection=c1');
    page.dom.window.close();
  } finally {
    answers.collections = kept;
  }
});
