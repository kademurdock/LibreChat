/* The Library's shelf tree (Part 296, Sep 27 2026): one call with every shelf and its honest count,
 * the display rules (nothing moved or renamed), and the /tree, /archive?deep=1 and /recent wiring.
 * Run: node --test api/server/routes/kadeReadingRoomTree.selftest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const T = require('./kadeReadingRoomTree');

const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `slice ${from}`);
  return source.slice(start, end);
};
const plain = (x) => JSON.parse(JSON.stringify(x));
const logger = { info() {}, warn() {}, error() {} };
const names = (node) => node.children.map((k) => k.name);
const byId = (tree, id) => {
  let hit = null;
  const walk = (n) => { if (n.id === id) hit = n; n.children.forEach(walk); };
  tree.roots.forEach(walk);
  if (tree.local) walk(tree.local);
  return hit;
};
/** n items straight on each path. */
const rows = (spec) => Object.entries(spec);

test('three fixed first-screen shelves, honest totals, empty shelves never listed', () => {
  const tree = T.buildTree(rows({ 'Videos/Commercials/Cars and Trucks/1990s': 30, 'Videos/Commercials/Cars and Trucks/1980s': 5, 'Audio/Radio/1990s': 2 }));
  assert.deepEqual(tree.roots.map((r) => r.name), ['Videos', 'Audio', 'Books']);
  assert.deepEqual(tree.roots.map((r) => r.count), [35, 2, 0]);
  assert.equal(tree.total, 37);
  assert.equal(tree.local, null, 'no Springfield screen unless asked for');
  const books = tree.roots[2];
  assert.equal(books.children.length, 0);
  const cars = byId(tree, 'Videos/Commercials/Cars and Trucks');
  assert.equal(cars.count, 35);
  assert.equal(cars.direct, 0);
  assert.deepEqual(names(cars), ['1980s', '1990s']);
  assert.equal(cars.shelves, 2);
});

test('a shelf of 20 items or fewer is flat: listed whole, its sub-shelves not walked', () => {
  const tree = T.buildTree(rows({ 'Videos/TV Shows/ALF/Bumpers/1980s': 4, 'Videos/TV Shows/ALF/Promos/1990s': 2, 'Videos/TV Shows/Big/1990s': 21, 'Videos/TV Shows/Big/2000s': 1 }));
  const alf = byId(tree, 'Videos/TV Shows/ALF');
  assert.equal(alf.flat, true);
  assert.equal(alf.count, 6);
  assert.deepEqual(alf.children, []);
  assert.equal(alf.shelves, 0);
  const big = byId(tree, 'Videos/TV Shows/Big');
  assert.equal(big.flat, false);
  assert.deepEqual(names(big), ['1990s', '2000s']);
  assert.equal(byId(tree, 'Videos/TV Shows/Big/2000s').flat, true);
  assert.equal(T.subShelf('Videos/TV Shows/ALF', 'Videos/TV Shows/ALF/Bumpers/1980s'), 'Bumpers, 1980s');
  assert.equal(T.subShelf('Videos/TV Shows/ALF', 'Videos/TV Shows/ALF'), '');
});

test('a shelf holding only one shelf is skipped; the row says both names and opens the deeper one', () => {
  const tree = T.buildTree(rows({
    'Audio/Ozarks (Springfield Area)/Radio Airchecks/1990s': 30,
    'Audio/Ozarks (Springfield Area)/Radio Airchecks/1980s': 30,
    'Audio/Described Movies & TV/TV/American dad/American Dad! - Season 02 (2006)/Season 2': 25,
    'Audio/Described Movies & TV/TV/American dad/American Dad! - Season 03 (2007)': 25,
    'Audio/Described Movies & TV/Movies/A': 30,
  }));
  const audio = tree.roots[1];
  const ozarks = audio.children.find((k) => k.name.startsWith('Ozarks'));
  assert.equal(ozarks.name, 'Ozarks (Springfield Area), Radio Airchecks');
  assert.equal(ozarks.path, 'Audio/Ozarks (Springfield Area)/Radio Airchecks');
  assert.equal(ozarks.id, ozarks.path);
  assert.equal(ozarks.count, 60);
  const dad = byId(tree, 'Audio/Described Movies & TV/TV/American dad');
  assert.equal(dad.children[0].name, 'American Dad! - Season 02 (2006)', 'a name that only repeats the one before it is dropped');
  assert.equal(dad.children[0].path, 'Audio/Described Movies & TV/TV/American dad/American Dad! - Season 02 (2006)/Season 2');
  // a chain stops at a shelf with items of its own, and never swallows the first-screen shelf
  const many = T.buildTree(rows({ 'Videos/Channels/Nickelodeon': 3, 'Videos/Channels/Nickelodeon/Nick Jr/1990s': 40 }));
  assert.equal(many.roots[0].name, 'Videos');
  const channels = many.roots[0].children[0];
  assert.equal(channels.name, 'Channels, Nickelodeon');
  assert.equal(channels.direct, 3);
  assert.deepEqual(names(channels), ['Nick Jr, 1990s']);
});

test('names sort like a person reads them: capitals ignored, decades oldest first, Undated and Other last', () => {
  const tree = T.buildTree(rows({
    'Videos/Toys & Dolls/x': 21, 'Videos/TV Shows/x': 21, 'Videos/arrested development/x': 21, 'Videos/Other Channels/x': 21,
    'Videos/Undated/x': 21, 'Videos/Multiple decades/x': 21, 'Videos/1990s/x': 21, 'Videos/1980s/x': 21, 'Videos/2000s/x': 21,
    'Videos/little-visits-on-the-go-the-sing-along-cassette/x': 21, 'Videos/9-1-1/x': 21, 'Videos/Otherworld/x': 21,
  }));
  assert.deepEqual(names(tree.roots[0]).map((n) => n.split(', ')[0]), [
    '9-1-1', '1980s', '1990s', '2000s', 'Arrested development', 'Little visits on the go the sing along cassette',
    'Otherworld', 'Toys & Dolls', 'TV Shows', 'Undated', 'Multiple decades', 'Other Channels',
  ]);
  const slug = tree.roots[0].children.find((k) => k.name.startsWith('Little visits'));
  assert.equal(slug.path, 'Videos/little-visits-on-the-go-the-sing-along-cassette/x', 'the real shelf keeps its real name');
  assert.equal(T.tidyName(''), 'Untitled shelf');
  assert.ok(T.compareNames('Season 2', 'Season 10') < 0);
});

test('holding shelves gather into one "Not filed yet" row, last, each opening its real shelf', () => {
  const tree = T.buildTree(rows({
    'Videos/Needs Filing/Archive Intake': 150,
    'Videos/Needs Filing/Interest Review': 2,
    'Videos/Advertising/Show Promos (Review)': 23,
    'Videos/Commercials/Toys/1990s': 40,
    'Videos/Channels/Disney/1990s': 5,
    'Videos/Channels/Disney/1980s': 2,
    'Videos/Channels/Disney/Show Promos (Review)': 3,
    'Audio/Needs Filing/Archive Intake': 68,
    'Audio/Needs Filing/TV/Empire': 2,
    'Audio/Radio/1990s': 30,
  }));
  const videos = tree.roots[0];
  assert.equal(videos.count, 150 + 2 + 23 + 40 + 5 + 2 + 3, 'every item is still counted under Videos');
  assert.deepEqual(names(videos), ['Channels, Disney', 'Commercials, Toys, 1990s', 'Not filed yet']);
  assert.equal(videos.children.some((k) => k.name.startsWith('Advertising')), false, 'a shelf emptied by the gathering is not listed');
  const disney = videos.children[0];
  assert.equal(disney.path, 'Videos/Channels/Disney');
  assert.equal(disney.count, 7, 'the (Review) shelf left Disney');
  assert.equal(disney.flat, false, 'never flat: /archive?deep=1 on it would list the holding shelf again');
  assert.deepEqual(names(disney), ['1980s', '1990s']);
  const waiting = videos.children.at(-1);
  assert.equal(waiting.virtual, true);
  assert.equal(waiting.path, '');
  assert.equal(waiting.id, '#not-filed/Videos');
  assert.equal(waiting.count, 178);
  assert.deepEqual(names(waiting), ['Advertising, Show Promos (Review)', 'Channels, Disney, Show Promos (Review)', 'Needs Filing']);
  assert.equal(waiting.children[0].path, 'Videos/Advertising/Show Promos (Review)');
  const needs = waiting.children[2];
  assert.deepEqual(names(needs), ['Archive Intake', 'Interest Review'], 'a holding shelf inside a holding shelf is left where it is');
  // one holding shelf: the row is that shelf, named plainly
  const audioWaiting = tree.roots[1].children.at(-1);
  assert.equal(audioWaiting.name, 'Not filed yet');
  assert.equal(audioWaiting.path, 'Audio/Needs Filing');
  assert.equal(audioWaiting.virtual, undefined);
  assert.equal(tree.roots[1].count, 100);
});

test('Springfield and the Ozarks: local video kinds, loose decades gathered, local audio, then Missouri', () => {
  const tree = T.buildTree(rows({
    'Videos/Ozarks (Springfield Area)/Local News/1990s': 415,
    'Videos/Ozarks (Springfield Area)/Local News/1980s': 82,
    'Videos/Ozarks (Springfield Area)/Around the Ozarks/Undated': 45,
    'Videos/Ozarks (Springfield Area)/1990s': 61,
    'Videos/Ozarks (Springfield Area)/1980s': 23,
    'Videos/Ozarks (Springfield Area)/Undated': 12,
    'Audio/Ozarks (Springfield Area)/Radio Airchecks/Undated': 12,
    'Videos/Missouri/Springfield & Ozarks/Classroom Recordings': 12,
    'Videos/Missouri/St. Louis (Local)/1990s': 600,
  }), { local: true });
  const local = tree.local;
  assert.equal(local.id, '#local');
  assert.equal(local.name, 'Springfield and the Ozarks');
  assert.equal(local.virtual, true);
  assert.equal(local.count, 415 + 82 + 45 + 61 + 23 + 12 + 12 + 12);
  assert.deepEqual(names(local), ['Around the Ozarks, Undated', 'Local News', 'Other local video', 'Radio Airchecks', 'Missouri, Springfield & Ozarks']);
  assert.deepEqual(local.children.map((k) => k.medium), ['video', 'video', 'video', 'audio', 'video']);
  const other = local.children[2];
  assert.equal(other.virtual, true);
  assert.deepEqual(names(other), ['1980s', '1990s', 'Undated']);
  assert.equal(other.count, 96);
  assert.equal(local.children[3].path, 'Audio/Ozarks (Springfield Area)/Radio Airchecks');
  assert.equal(local.children[4].path, 'Videos/Missouri/Springfield & Ozarks');
  // they also stay where they are
  assert.ok(byId(tree, 'Videos/Ozarks (Springfield Area)'));
  // nothing local: no Springfield screen
  assert.equal(T.buildTree(rows({ 'Videos/Commercials/x': 3 }), { local: true }).local, null);
  // items sitting on the local shelf itself are reached through the whole shelf
  const loose = T.buildTree(rows({ 'Videos/Ozarks (Springfield Area)': 30, 'Videos/Ozarks (Springfield Area)/Weather/1990s': 30 }), { local: true });
  assert.deepEqual(names(loose.local), ['Weather, 1990s', 'All local video']);
  assert.equal(loose.local.count, 60);
});

test('every row adds up: a shelf is its own items plus its rows, and ids are unique', () => {
  const spec = {};
  for (let i = 0; i < 400; i++) spec[`Videos/Commercials/Brand ${i % 37}/${1950 + (i % 6) * 10}s`] = (i % 9) + 1;
  spec['Videos/Commercials'] = 7;
  spec['Videos/Needs Filing/Archive Intake'] = 11;
  spec['Books'] = 4;
  spec['Books/Fiction — Romance'] = 9;
  const tree = T.buildTree(rows(spec), { local: true });
  const seen = new Set();
  const walk = (n) => {
    assert.ok(!seen.has(n.id), `unique ${n.id}`);
    seen.add(n.id);
    assert.equal(n.shelves, n.children.length);
    if (n.flat) assert.ok(n.count <= T.FLAT_MAX);
    else if (!n.virtual) assert.equal(n.direct + n.children.reduce((s, k) => s + k.count, 0), n.count, n.id);
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  assert.equal(tree.total, Object.values(spec).reduce((a, b) => a + b, 0));
  assert.equal(tree.roots[2].direct, 4, 'a book not yet shelved sits on Books itself');
});

test('the cache: kept five minutes, emptied by a library write, never by a reader moving through a book', () => {
  T.forget();
  T.remember('public:family:adult', { a: 1 }, 1000);
  assert.deepEqual(T.cached('public:family:adult', 2000), { a: 1 });
  assert.equal(T.cached('public:family:adult', 1000 + 5 * 60 * 1000 + 1), null);
  T.remember('k', { b: 1 });
  T.forget();
  assert.equal(T.cached('k'), null);
  assert.equal(T.writeClears('GET', '/tree'), false);
  assert.equal(T.writeClears('POST', '/book/abc/progress'), false);
  assert.equal(T.writeClears('POST', '/book/abc/bookmarks'), false);
  assert.equal(T.writeClears('DELETE', '/book/abc/bookmarks/b1'), false);
  assert.equal(T.writeClears('POST', '/collections/c1/items'), false);
  assert.equal(T.writeClears('POST', '/archive/done'), true);
  assert.equal(T.writeClears('POST', '/archive/move-folder'), true);
  assert.equal(T.writeClears('POST', '/librarian/organize'), true);
  assert.equal(T.writeClears('POST', '/book/abc/share'), true);
  assert.equal(T.writeClears('DELETE', '/book/abc'), true);
});

test('the router empties the tree when a write finishes', () => {
  let forgot = 0;
  const c = { router: { use: (fn) => { c.mw = fn; } }, shelfTree: { writeClears: T.writeClears, forget: () => { forgot++; } } };
  vm.runInNewContext(slice('router.use((req, res, next) => {\n  if (shelfTree.writeClears', "router.get('/guide'"), c);
  const run = (method, path) => {
    const res = new EventEmitter();
    let passed = false;
    c.mw({ method, path }, res, () => { passed = true; });
    assert.equal(passed, true);
    res.emit('finish');
    res.emit('close');
  };
  run('GET', '/archive');
  run('POST', '/book/x/progress');
  assert.equal(forgot, 0);
  run('POST', '/archive/done');
  assert.ok(forgot >= 1);
});

/* ── the routes, with a stand-in database ── */
class ObjectId { constructor(s) { this.s = s; } toJSON() { return `oid:${this.s}`; } }
function libraryRoutes({ member = true, treeRows = [], items = [], folders = [], total = 0, pending = [3, 2] } = {}) {
  const log = { aggregates: [], finds: [], counts: [] };
  const c = {
    router: { get: (path, ...handlers) => { c.routes[path] = handlers.at(-1); } },
    routes: {},
    requireJwtAuth() {},
    libraryHiddenFrom: (req) => !member || req.user.id === 'review-seat',
    isChild: async (req) => req.user.kadeAccountType === 'child',
    clampInt: (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; },
    mongoose: { Types: { ObjectId } },
    libraryPathExpression: () => ({ $display: 'path' }),
    summary: (b, p) => ({ id: String(b._id), title: b.title, path: b.path, progress: p || null }),
    shelfTree: T,
    logger,
    KadeReadingProgress: { find: () => ({ lean: async () => [] }) },
    KadeBook: {
      aggregate: (pipeline) => {
        log.aggregates.push(plain(pipeline));
        const has = (key) => pipeline.some((stage) => key in stage);
        if (has('$group') && pipeline.find((s) => s.$group).$group._id?.$display) return Promise.resolve(treeRows);
        if (has('$group')) return Promise.resolve(folders);
        if (has('$count')) return Promise.resolve(total ? [{ count: total }] : []);
        return Promise.resolve(items);
      },
      countDocuments: async (q) => { log.counts.push(plain(q)); return q.updatedAt.$gte ? pending[0] : pending[1]; },
      find: (q) => {
        const call = { q: plain(q) };
        log.finds.push(call);
        const chain = { select: (s) => { call.select = s; return chain; }, sort: (s) => { call.sort = plain(s); return chain; }, limit: (n) => { call.limit = n; return chain; }, lean: async () => items };
        return chain;
      },
    },
  };
  vm.runInNewContext(slice('const shelfPath = ', "router.get('/search'"), c);
  const get = async (path, query, user = { id: 'fam-holly' }) => {
    let code = 200, body;
    await c.routes[path]({ query, user }, { status(n) { code = n; return this; }, json(x) { body = x; return this; } });
    return { code, body: plain(body) };
  };
  return { get, log };
}

test('GET /tree: one aggregation, the family library for members, own uploads only for everyone else', async () => {
  T.forget();
  const treeRows = [{ _id: 'Videos/Ozarks (Springfield Area)/Local News/1990s', n: 30 }, { _id: 'Audio/Radio/1990s', n: 4 }];
  let r = libraryRoutes({ treeRows });
  let out = await r.get('/tree', {});
  assert.equal(out.code, 200);
  assert.equal(out.body.scope, 'public');
  assert.equal(out.body.total, 34);
  assert.equal(out.body.treeVersion, 1);
  assert.equal(out.body.flatMax, 20);
  assert.equal(out.body.local.name, 'Springfield and the Ozarks');
  assert.equal(out.body.pending, undefined);
  assert.equal(r.log.aggregates.length, 1);
  assert.deepEqual(r.log.aggregates[0][0], { $match: { state: 'ready', shared: true } });
  assert.deepEqual(r.log.aggregates[0][1], { $group: { _id: { $display: 'path' }, n: { $sum: 1 } } });
  await r.get('/tree', {});
  assert.equal(r.log.aggregates.length, 1, 'the second reader is answered from the cache');

  // a child never sees grown-ups-only items, and has a tree of its own
  await r.get('/tree', {}, { id: 'fam-kid', kadeAccountType: 'child' });
  assert.equal(r.log.aggregates.length, 2);
  assert.deepEqual(r.log.aggregates[1][0].$match.grownUpsOnly, { $ne: true });

  // the App Review seat and any account without the family library: own uploads, no Springfield screen, same words
  T.forget();
  r = libraryRoutes({ member: false, treeRows });
  out = await r.get('/tree', {}, { id: 'review-seat' });
  assert.equal(out.body.scope, 'public');
  assert.equal(out.body.local, null);
  assert.deepEqual(r.log.aggregates[0][0], { $match: { state: 'ready', owner: 'oid:review-seat' } });
  assert.equal(out.body.pending, undefined);
  await r.get('/tree', {}, { id: 'another-seat' });
  assert.equal(r.log.aggregates.length, 2, 'one person\'s own tree is never served to another');

  // scope=mine: the reader's own uploads, and what is still uploading or stuck
  T.forget();
  r = libraryRoutes({ treeRows, pending: [3, 2] });
  out = await r.get('/tree', { scope: 'mine' });
  assert.equal(out.body.scope, 'mine');
  assert.deepEqual(out.body.pending, { uploading: 3, stalled: 2 });
  assert.equal(out.body.local, null);
  assert.deepEqual(r.log.aggregates[0][0], { $match: { state: 'ready', owner: 'oid:fam-holly' } });
  assert.ok(r.log.counts.every((q) => q.owner === 'fam-holly' && q.state === 'pending'));
  T.forget();
});

test('GET /archive?deep=1 lists everything under a small shelf, with where each item sits', async () => {
  const at = 'Videos/TV Shows/Married... with Children';
  const items = [
    { _id: 'a', title: 'Bumper', path: `${at}/Bumpers/1990s` },
    { _id: 'b', title: 'Promo', path: `${at}/Promos & Previews/1980s` },
    { _id: 'c', title: 'Loose', path: at },
  ];
  const r = libraryRoutes({ items, total: 3 });
  const out = await r.get('/archive', { path: at, deep: '1' });
  assert.equal(out.body.path, at, 'dots in a shelf name are kept, so the right shelf opens');
  assert.equal(out.body.deep, true);
  assert.equal(out.body.total, 3);
  assert.deepEqual(out.body.folders, []);
  assert.deepEqual(out.body.items.map((i) => i.sub), ['Bumpers, 1990s', 'Promos & Previews, 1980s', '']);
  assert.equal(r.log.aggregates.length, 2, 'no folder listing for a whole-shelf list');
  const itemsPipeline = r.log.aggregates.find((p) => p.some((s) => s.$skip !== undefined));
  const match = itemsPipeline.find((s) => s.$match && s.$match.path);
  assert.deepEqual(match.$match.path, { $regex: '^Videos/TV Shows/Married\\.\\.\\. with Children(?:/|$)' });
  assert.ok(itemsPipeline.some((s) => s.$sort && s.$sort._titleKey === 1), 'titles sort ignoring capitals');
  assert.ok(itemsPipeline.some((s) => s.$project && s.$project['tracks.description.scenes'] === 0));
});

test('GET /archive without deep answers as before: items on the shelf, folders in reading order', async () => {
  const folders = [{ _id: 'TV Shows', count: 9 }, { _id: 'Toys & Dolls', count: 4 }, { _id: 'arrested development', count: 2 }, { _id: 'Undated', count: 1 }, { _id: '1990s', count: 3 }];
  const r = libraryRoutes({ items: [{ _id: 'x', title: 'Spot', path: 'Videos/Married... with Children' }], folders, total: 1 });
  const out = await r.get('/archive', { path: '/Videos/Married... with Children/' });
  assert.equal(out.body.path, 'Videos/Married... with Children');
  assert.equal(out.body.deep, undefined);
  assert.equal(out.body.items[0].sub, undefined);
  assert.deepEqual(out.body.folders.map((f) => f.name), ['1990s', 'arrested development', 'Toys & Dolls', 'TV Shows', 'Undated']);
  assert.equal(out.body.folders[1].path, 'Videos/Married... with Children/arrested development');
  const itemsPipeline = r.log.aggregates.find((p) => p.some((s) => s.$skip !== undefined));
  assert.deepEqual(itemsPipeline.find((s) => s.$match && 'path' in s.$match).$match, { path: 'Videos/Married... with Children' });
  const pager = itemsPipeline.slice(-3);
  assert.deepEqual(pager, [{ $skip: 0 }, { $limit: 60 }, { $project: { 'tracks.description.scenes': 0, 'tracks.recaps': 0 } }]);
});

test('GET /recent: the newest shared items; a seat without the family library gets its own uploads', async () => {
  let r = libraryRoutes({ items: [{ _id: 'n1', title: 'New tape', path: 'Videos/Commercials' }] });
  let out = await r.get('/recent', {});
  assert.equal(out.body.items[0].id, 'n1');
  assert.equal(out.body.limit, 60);
  assert.deepEqual(r.log.finds[0].q, { shared: true, state: 'ready' });
  assert.deepEqual(r.log.finds[0].sort, { sharedAt: -1 });
  assert.equal(r.log.finds[0].limit, 60);
  assert.match(r.log.finds[0].select, /-tracks\.description\.scenes/);
  await r.get('/recent', { limit: '500' }, { id: 'fam-kid', kadeAccountType: 'child' });
  assert.deepEqual(r.log.finds[1].q, { shared: true, state: 'ready', grownUpsOnly: { $ne: true } });
  assert.equal(r.log.finds[1].limit, 100);
  r = libraryRoutes({ member: false, items: [] });
  out = await r.get('/recent', {}, { id: 'review-seat' });
  assert.deepEqual(out.body.items, []);
  assert.deepEqual(r.log.finds[0].q, { owner: 'review-seat', state: 'ready' });
  assert.deepEqual(r.log.finds[0].sort, { createdAt: -1 });
});

test("an item says whether it is the library owner's, so a row need not end with her name", () => {
  const c = { libraryPath: (b) => b.path || '', libraryCategory: () => 'other', process: { env: {} } };
  vm.runInNewContext(slice('function summary(book, progress)', '/* ── the shelf ──'), c);
  const kade = c.summary({ _id: 'a', owner: '6a3cba4d0b0afa92194e42f7', ownerName: 'kademurdock', title: 'Meeks ad' }, null);
  const amber = c.summary({ _id: 'b', owner: '6a5fc5fa351af41332734161', ownerName: 'Amber', title: 'A book' }, null);
  assert.equal(kade.fromLibraryOwner, true);
  assert.equal(amber.fromLibraryOwner, false);
  assert.equal(kade.ownerName, 'kademurdock', 'the stored name is still sent, for older app builds');
  c.process.env.KADE_OWNER_USER_ID = '6a5fc5fa351af41332734161';
  assert.equal(c.summary({ _id: 'b', owner: '6a5fc5fa351af41332734161' }, null).fromLibraryOwner, true);
});
