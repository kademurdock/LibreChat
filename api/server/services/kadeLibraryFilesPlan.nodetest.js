'use strict';
/* node --test api/server/services/kadeLibraryFilesPlan.nodetest.js
 * The one-file rule, held still (Sep 25 2026). Shapes follow the Sep 25 bucket listing: 1,410
 * same-size same-ETag groups, 1,232 of them a Described Movies & TV copy plus a Needs Filing copy. */
const test = require('node:test');
const assert = require('node:assert');
const P = require('./kadeLibraryFilesPlan');

const KADE = '6a3cba4d0b0afa92194e42f7';
const AMBER = '6a5fc5fa351af41332734161';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
let n = 0;
const id = () => '6ab16a5c' + String(++n).padStart(16, '0');
const row = (extra = {}) => ({ _id: id(), owner: KADE, kind: 'audio', shared: true, title: 'Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022)', tracks: [{ key: 'k' + n, bytes: 85600000, sha256: H1 }], ...extra });

test('same file needs the same byte count and the same SHA-256; nothing else counts', () => {
  assert.ok(P.sameFile({ sha256: H1, bytes: 10 }, { sha256: H1, bytes: 10 }));
  assert.ok(!P.sameFile({ sha256: H1, bytes: 10 }, { sha256: H1, bytes: 11 }), 'different size');
  assert.ok(!P.sameFile({ sha256: H1, bytes: 10 }, { sha256: H2, bytes: 10 }), 'different hash');
  assert.ok(!P.sameFile({ sha256: '', bytes: 10 }, { sha256: '', bytes: 10 }), 'unhashed is never the same');
  assert.ok(!P.sameFile({ sha256: 'x', bytes: 10 }, { sha256: 'x', bytes: 10 }), 'not a SHA-256');
  assert.ok(!P.sameFile({ sha256: H1, bytes: 0 }, { sha256: H1, bytes: 0 }), 'empty files are not a match');
});

test('two different single-part ETags prove two files; everything else goes to the hash', () => {
  assert.strictEqual(P.etagVerdict({ etag: '6551ddbec3f47ba7abd2d3ae99966fd4' }, { etag: '"0551ddbec3f47ba7abd2d3ae99966fd4"' }), 'different');
  assert.strictEqual(P.etagVerdict({ etag: '6551ddbec3f47ba7abd2d3ae99966fd4' }, { etag: '"6551ddbec3f47ba7abd2d3ae99966fd4"' }), 'hash');
  assert.strictEqual(P.etagVerdict({ etag: '63ee21a99e1431a969e49dfe8068a89d-4' }, { etag: '73ee21a99e1431a969e49dfe8068a89d-4' }), 'hash', 'multipart ETags depend on part sizes');
  assert.strictEqual(P.etagVerdict({ etag: '' }, { etag: 'abc' }), 'hash');
});

test('the filed copy stays and the Needs Filing copy merges (the Sep 24 Bel-Air pair)', () => {
  const filed = row();
  const intake = row({ path: 'Audio/Needs Filing/TV/Bel-Air - Season 1 (2022)' });
  for (const order of [[filed, intake], [intake, filed]]) {
    const g = P.planGroup(order);
    assert.strictEqual(g.keeper, filed._id);
    assert.deepStrictEqual(g.extras.map((e) => [e.id, e.action]), [[intake._id, 'merge']]);
    assert.strictEqual(g.hold, '');
  }
});

test('keeper order: shared, then filed, then described, then a clean title, then the older row', () => {
  const priv = row({ shared: false });
  const pub = row();
  assert.strictEqual(P.chooseKeeper([priv, pub])._id, pub._id);
  const plain = row();
  const describedRow = row({ tracks: [{ key: 'd', bytes: 85600000, sha256: H1, description: { state: 'done' } }] });
  assert.strictEqual(P.chooseKeeper([plain, describedRow])._id, describedRow._id);
  const copy = row({ title: 'One World- Together at Home (2020) - Copy' });
  const clean = row({ title: 'One World- Together at Home (2020)' });
  assert.strictEqual(P.chooseKeeper([copy, clean])._id, clean._id);
  const older = row();
  const newer = row();
  assert.strictEqual(P.chooseKeeper([newer, older])._id, older._id);
  const pointedAt = row({ path: 'Audio/Needs Filing/TV' });
  assert.strictEqual(P.chooseKeeper([older, pointedAt], { [pointedAt._id]: { shortcuts: 2 } })._id, pointedAt._id, 'a file others point at stays');
});

test('two real folders of one owner keep a shortcut (The Lion King cassette in two collections)', () => {
  const a = row({ title: 'The Lion King - Book And CD', path: 'Audio/Cassettes/Movie read-along stories, mostly Disney' });
  const b = row({ title: 'The Lion King', path: 'Audio/Cassettes/My cassette collection' });
  const g = P.planGroup([a, b]);
  assert.deepStrictEqual(g.extras.map((e) => e.action), ['shortcut']);
  assert.match(g.hold, /mislabeled/, 'different titles wait for Kade');
});

test('the same bytes under two episode titles are held for Kade, never merged on their own', () => {
  const e1 = row({ title: '6.01 Pops the Question', path: 'Audio/Described Movies & TV/TV/Black-ish/Black-ish Season 6' });
  const e2 = row({ title: "6.02 Every Day I'm Struggling", path: 'Audio/Needs Filing/TV/Black-ish/Black-ish Season 6 (2019)' });
  assert.match(P.planGroup([e1, e2]).hold, /mislabeled/);
});

test("another person's copy is linked, never merged or turned into Kade's shortcut", () => {
  const kade = row();
  const amber = row({ owner: AMBER, shared: false, path: '' });
  const g = P.planGroup([kade, amber]);
  assert.strictEqual(g.keeper, kade._id);
  assert.deepStrictEqual(g.extras.map((e) => e.action), ['link']);
});

test('the keeper takes the stricter grown-ups flag of its own copies', () => {
  const open = row();
  const adult = row({ path: 'Audio/Needs Filing/TV', grownUpsOnly: true });
  assert.deepStrictEqual(P.planGroup([open, adult]).keeperSet, { grownUpsOnly: true });
});

test('a new upload of a stored file the uploader can open: kept once, and they are told', () => {
  const twin = row();
  const fresh = row({ path: 'Audio/Needs Filing/TV/Bel-Air - Season 1 (2022)' });
  assert.deepStrictEqual(P.uploadDecision({ item: fresh, twin, canOpen: true }), { action: 'merge', tell: 'already' });
  const line = P.alreadyLine(twin, 'Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022)');
  assert.match(line, /^Already in the library: "Dreams and Nightmares" \(Audio\/Described Movies/);
});

test("another person's copy is never folded: both rows stay and only the bytes are shared, like planGroup", () => {
  const twin = row(); // Kade's shared copy
  const amberCopy = row({ owner: AMBER, path: '' });
  assert.deepStrictEqual(P.uploadDecision({ item: amberCopy, twin, canOpen: true }), { action: 'link', tell: null });
  const kadeUpload = row({ path: 'Audio/Needs Filing' });
  const hollyPrivate = row({ owner: AMBER, shared: false });
  assert.deepStrictEqual(P.uploadDecision({ item: kadeUpload, twin: hollyPrivate, canOpen: false }), { action: 'link', tell: null });
});

test('a shared new copy never folds into a private stored one', () => {
  const privateTwin = row({ shared: false });
  const fresh = row({ path: 'Audio/Needs Filing' });
  const d = P.uploadDecision({ item: fresh, twin: privateTwin, canOpen: true });
  assert.strictEqual(d.action, 'link');
  assert.match(d.hold, /shared/);
  assert.strictEqual(P.uploadDecision({ item: row({ shared: false, path: 'Audio/Needs Filing' }), twin: privateTwin, canOpen: true }).action, 'merge', 'private into private still folds');
});

test('report mode: "duplicate" only for a whole copy the owner keeps elsewhere; anything else is kept or shares tracks', () => {
  const twin = row({ state: 'ready' });
  const fresh = row({ path: 'Audio/Needs Filing' });
  assert.strictEqual(P.reportState({ item: fresh, twin, canOpen: true, whole: true }), 'duplicate');
  assert.strictEqual(P.reportState({ item: fresh, twin, canOpen: true, whole: false }), 'shares-tracks', 'a shared side A is never a duplicate');
  assert.strictEqual(P.reportState({ item: fresh, twin: { ...twin, owner: AMBER }, canOpen: true, whole: true }), 'kept', "another person's copy: both stay");
  assert.strictEqual(P.reportState({ item: fresh, twin: { ...twin, owner: AMBER, shared: false }, canOpen: false, whole: true }), 'kept', 'a copy she cannot open');
  assert.strictEqual(P.reportState({ item: fresh, twin: { ...twin, shared: false }, canOpen: true, whole: true }), 'kept', 'a less open copy is not the one kept');
  assert.strictEqual(P.reportState({ item: fresh, twin: { ...twin, fileCheck: { state: 'duplicate' } }, canOpen: true, whole: true }), 'kept', 'the marked copy never counts as kept');
  assert.strictEqual(P.reportState({ item: fresh, twin: { ...twin, state: 'pending' }, canOpen: true, whole: true }), 'kept');
});

test('a folded upload with its own title or notes is never told "nothing was lost"', () => {
  const twin = row({ title: 'Family Guy 15.01', description: '' });
  const same = { title: 'Family Guy 15.01 - Copy', description: '' };
  assert.strictEqual(P.ownWords(same, twin), false, 'a copy suffix is not a title of its own');
  assert.strictEqual(P.foldedLine(twin, 'Video/TV', { mine: same }), P.alreadyLine(twin, 'Video/TV'));
  const titled = { title: 'Our first Christmas', description: '' };
  const line = P.foldedLine(twin, 'Video/TV', { mine: titled });
  assert.match(line, /^Your upload "Our first Christmas" is exactly the same file as "Family Guy 15\.01", already in the library \(Video\/TV\)/);
  assert.match(line, /saved for 30 days, so your copy can be put back\.$/);
  assert.ok(!/Nothing was lost/.test(line));
  assert.strictEqual(P.ownWords({ title: 'Family Guy 15.01', description: 'Taped off FOX in 2016.' }, twin), true, 'notes of its own');
  assert.match(P.foldedSummary(3, false), /Nothing was lost\.$/);
  assert.ok(!/Nothing was lost/.test(P.foldedSummary(3, true)));
});

test('a skipped empty donation says plainly that nothing was sent, the item went, and where the copy is', () => {
  const twin = row({ title: 'Side A' });
  assert.strictEqual(P.nothingUploadedLine(twin, 'Audio/Cassettes', { started: 'My tape' }), 'Nothing was uploaded: this exact file is already in the library as "Side A", in Audio/Cassettes. The new item "My tape" you started was removed.');
  assert.strictEqual(P.nothingUploadedLine(twin, '', { own: true }), 'Nothing was uploaded: this exact file is already on your shelf as "Side A". The new item you started was removed.');
});

test("a new upload of someone else's private file: a silent link, with nothing to say", () => {
  const privateTwin = row({ owner: AMBER, shared: false, title: "Grandma's Christmas 1994" });
  const fresh = row({ path: 'Audio/Needs Filing' });
  const d = P.uploadDecision({ item: fresh, twin: privateTwin, canOpen: false });
  assert.deepStrictEqual(d, { action: 'link', tell: null });
  assert.ok(!JSON.stringify(d).includes('Grandma'));
});

test('a new upload filed into a second real folder by the same owner becomes a shortcut', () => {
  const twin = row({ path: 'Audio/Cassettes/My cassette collection' });
  const fresh = row({ path: 'Audio/Cassettes/Movie read-along stories, mostly Disney' });
  assert.strictEqual(P.uploadDecision({ item: fresh, twin, canOpen: true }).action, 'shortcut');
});

test('a bookmark in one cut of a text lands on the same words in another cut', () => {
  assert.deepStrictEqual(P.remapPosition([3, 7, 5], [10, 5], 1, 2), { s: 0, c: 5 });
  assert.deepStrictEqual(P.remapPosition([10, 5], [3, 7, 5], 1, 4), { s: 2, c: 4 });
  assert.deepStrictEqual(P.remapPosition([3], [2], 0, 2), { s: 0, c: 1 }, 'past the end clamps to the last chunk');
});

test('the one promise: the keeper is never an extra, and a row of another owner is never merged away', () => {
  for (let i = 0; i < 50; i++) {
    const items = [row(), row({ owner: i % 2 ? AMBER : KADE, path: i % 3 ? 'Audio/Needs Filing' : 'Audio/Cassettes/X' }), row({ shared: i % 4 === 0 })];
    const g = P.planGroup(items);
    assert.ok(!g.extras.some((e) => e.id === g.keeper));
    const byId = Object.fromEntries(items.map((it) => [it._id, it]));
    const keeper = byId[g.keeper];
    for (const e of g.extras) if (String(byId[e.id].owner) !== String(keeper.owner)) assert.strictEqual(e.action, 'link');
  }
});

test('who can open a copy: owner and librarian always; the family only shared, never a child a grown-ups copy', () => {
  const shared = row({ owner: AMBER, state: 'ready' });
  const adult = { id: KADE, admin: false, child: false, hidden: false };
  assert.ok(P.canOpen(adult, shared));
  assert.ok(!P.canOpen({ ...adult, hidden: true }, shared), 'no family access (review seat, test seats)');
  assert.ok(!P.canOpen({ ...adult, child: true }, { ...shared, grownUpsOnly: true }), 'rule 8: absent for a child');
  assert.ok(!P.canOpen(adult, { ...shared, shared: false }), "someone else's private copy");
  assert.ok(P.canOpen({ ...adult, id: AMBER }, { ...shared, shared: false }), 'her own');
  assert.ok(!P.canOpen(adult, { ...shared, state: 'merged' }), 'a folded copy is never a twin');
});

test('a row is a whole copy only when every track is the same file, in order; a shared side A is not', () => {
  const t = (sha256, bytes = 5) => ({ key: sha256.slice(0, 3), sha256, bytes });
  assert.ok(P.wholeCopy({ tracks: [t(H1), t(H2)] }, { tracks: [t(H1), t(H2)] }));
  assert.ok(!P.wholeCopy({ tracks: [t(H1)] }, { tracks: [t(H1), t(H2)] }), 'side A only');
  assert.ok(!P.wholeCopy({ tracks: [t(H2), t(H1)] }, { tracks: [t(H1), t(H2)] }), 'another order is another item');
  assert.ok(P.wholeCopy({ tracks: [], fileSha256: H1, fileBytes: 9 }, { tracks: [], fileSha256: H1, fileBytes: 9 }), 'a text book by its original');
});

test('a new copy marked grown-ups only is never folded into a copy children can open', () => {
  const twin = row({ grownUpsOnly: false });
  const fresh = row({ path: 'Audio/Needs Filing', grownUpsOnly: true });
  const d = P.uploadDecision({ item: fresh, twin, canOpen: true });
  assert.strictEqual(d.action, 'link');
  assert.match(d.hold, /grown-ups/);
});

test("Kade's own plan for a held group: her keeper, merge or shortcut; another person's row stays a link", () => {
  const a = row({ title: '6.01 Pops the Question', path: 'Audio/Described Movies & TV/TV/Black-ish/Black-ish Season 6' });
  const b = row({ title: "6.02 Every Day I'm Struggling", path: 'Audio/Needs Filing/TV/Black-ish/Black-ish Season 6 (2019)' });
  const other = row({ owner: AMBER, shared: false, path: '' });
  const g = P.planGroup([a, b, other], { keeperId: b._id, actions: { [a._id]: 'shortcut', [other._id]: 'merge' } });
  assert.strictEqual(g.keeper, b._id);
  assert.deepStrictEqual(g.extras.map((e) => [e.id, e.action]), [[a._id, 'shortcut'], [other._id, 'link']]);
  assert.strictEqual(P.planGroup([a, b], { keeperId: 'not-in-the-group' }), null);
  assert.strictEqual(P.planGroup([a, b], { keeperId: a._id, actions: { [b._id]: 'merge' } }).extras[0].action, 'merge');
});

test('a shared copy never merges into a private keeper: the plan is marked unsafe and held', () => {
  const shared = row({ path: 'Audio/Needs Filing' });
  const priv = row({ shared: false });
  const bad = P.planGroup([shared, priv], { keeperId: priv._id, actions: { [shared._id]: 'merge' } });
  assert.match(bad.unsafe, /family library/);
  assert.match(bad.hold, /family library/);
  const asShortcut = P.planGroup([shared, priv], { keeperId: priv._id, actions: { [shared._id]: 'shortcut' } });
  assert.strictEqual(asShortcut.unsafe, '', 'a shortcut keeps its own sharing');
  const auto = P.planGroup([shared, priv]);
  assert.strictEqual(auto.keeper, shared._id, 'on its own the shared copy is kept');
  assert.strictEqual(auto.unsafe, '');
  const pointed = P.planGroup([shared, priv], { usage: { [priv._id]: { shortcuts: 1 } } });
  assert.strictEqual(pointed.keeper, priv._id, 'a private file others point at would be kept...');
  assert.match(pointed.hold, /family library/, '...so the group waits for Kade');
});

test('a group is named by its file, and only a real name parses', () => {
  const id = P.groupId(H1, 85600000);
  assert.strictEqual(id, `${H1}:85600000`);
  assert.deepStrictEqual(P.parseGroupId(id), { sha256: H1, bytes: 85600000 });
  assert.strictEqual(P.parseGroupId('x:1'), null);
  assert.strictEqual(P.itemOfKey('media-library/6ab16a5c1a1739268f933bd0/mfa1-abc123.mp4'), '6ab16a5c1a1739268f933bd0');
  assert.strictEqual(P.itemOfKey('books/u/book-1.zip'), '');
});

test('the same words with a different jacket read as the same book; one changed word does not', () => {
  const kinds = ['jacket', 'section', 'section'];
  const one = [{ chunks: ['Abundance. By Ezra Klein.'] }, { chunks: ['one', 'two'] }, { chunks: ['three'] }];
  const two = [{ chunks: ['Abundance 6484147.', 'Second line.'] }, { chunks: ['one', 'two'] }, { chunks: ['three'] }];
  const three = [{ chunks: ['Abundance.'] }, { chunks: ['one', 'TWO'] }, { chunks: ['three'] }];
  assert.strictEqual(P.bookTextDigest(one, kinds), P.bookTextDigest(two, kinds));
  assert.notStrictEqual(P.bookTextDigest(one, kinds), P.bookTextDigest(three, kinds));
});

test('an unreferenced object may go only as a byte-identical copy of its own item file, older than a day', () => {
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const item = '6ab16a5c1a1739268f933bd0';
  const k = (name) => `media-library/${item}/${name}`;
  const itemKeys = new Map([[item, [{ key: k('played.mp4'), size: 100, etag: 'a'.repeat(32), sha256: H1 }]]]);
  const old = new Date(NOW - 2 * 86400000);
  const out = P.classifyUnreferenced([
    { key: k('played.mp4'), size: 100, etag: 'a'.repeat(32), lastModified: old },
    { key: k('retry.mp4'), size: 100, etag: '"' + 'a'.repeat(32) + '"', lastModified: old },
    { key: k('fresh.mp4'), size: 100, etag: 'a'.repeat(32), lastModified: new Date(NOW - 3600000) },
    { key: k('multipart.mp4'), size: 100, etag: 'a'.repeat(32) + '-2', lastModified: old },
    { key: k('hashed.mp4'), size: 100, etag: 'b'.repeat(32) + '-3', sha256: H1, lastModified: old },
    { key: k('bigger.mp4'), size: 101, etag: 'a'.repeat(32), lastModified: old },
  ], { referenced: new Set([k('played.mp4')]), itemKeys, now: NOW });
  const by = Object.fromEntries(out.map((e) => [e.key.split('/').pop(), e.deletable]));
  assert.deepStrictEqual(by, { 'retry.mp4': true, 'fresh.mp4': false, 'multipart.mp4': false, 'hashed.mp4': true, 'bigger.mp4': false });
});
