'use strict';
/* node --test api/server/services/kadeLibraryFiles.mongo.nodetest.js
 * The one-file rule against a real (in-memory) MongoDB and a fake bucket (Sep 25 2026): the
 * librarian's merge moves every reference and undo puts every one back; held groups wait for Kade and
 * take her plan; the same-text book merge refuses anything that is not the same words; a withdrawn
 * file hands itself to its shortcut; only byte-identical unreferenced copies may go; the verifier
 * keeps a new copy once; the media sweep never picks a shortcut. Nothing here touches the network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const models = require('../../models/kadeBook');
const F = require('./kadeLibraryFiles');
const P = require('./kadeLibraryFilesPlan');

const { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, KadeLibrarySubmission, KadeLibraryFold } = models;
const Requests = mongoose.models.TestKadeMediaRequest || mongoose.model('TestKadeMediaRequest', new mongoose.Schema({ book: String, title: String }));
const DescriptionJobs = mongoose.models.TestKadeDescriptionJob || mongoose.model('TestKadeDescriptionJob', new mongoose.Schema({ library: { book: String, track: Number }, savedToLibrary: String, copies: [mongoose.Schema.Types.Mixed] }));

let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([KadeBook, KadeReadingProgress, KadeBookText].map((M) => M.init()));
});
test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
test.beforeEach(async () => {
  await Promise.all([KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, KadeLibrarySubmission, KadeLibraryFold, Requests, DescriptionJobs].map((M) => M.deleteMany({})));
  delete process.env.KADE_LIBRARY_FILES;
});

const oid = () => new mongoose.Types.ObjectId();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');
const KADE = oid();
const AMBER = oid();
const HOLLY = oid();

/** A fake bucket: objects by key, HEAD, GET (streamed), ListObjectsV2; deletes go through deleteKeys. */
function harness({ readers = {} } = {}) {
  const store = new Map();
  const deleted = [];
  const told = [];
  const s3 = {
    send: async (cmd) => {
      const name = cmd.constructor.name;
      const key = cmd.input.Key;
      if (name === 'HeadObjectCommand') {
        if (!store.has(key)) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: store.get(key).body.length, ETag: `"${md5(store.get(key).body)}"` };
      }
      if (name === 'GetObjectCommand') {
        if (!store.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        const o = store.get(key);
        return { Body: Readable.from([o.body]), ETag: `"${md5(o.body)}"` };
      }
      if (name === 'ListObjectsV2Command') {
        const Contents = [...store.entries()].filter(([k]) => k.startsWith(cmd.input.Prefix)).map(([k, o]) => ({ Key: k, Size: o.body.length, ETag: `"${o.etag || md5(o.body)}"`, LastModified: o.at }));
        return { Contents, IsTruncated: false };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const files = F.createLibraryFiles({
    models: { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, KadeLibrarySubmission, Receipts: KadeLibraryFold, Requests, DescriptionJobs },
    s3: () => s3,
    bucket: () => 'bucket',
    deleteKeys: async (keys) => { for (const k of keys) { deleted.push(k); store.delete(k); } },
    readerOf: async (id) => readers[String(id)] || { id: String(id), admin: false, child: false, hidden: false },
    notify: (owner, text) => told.push([String(owner), text]),
    keyFromFileUrl: (url) => { const i = String(url || '').indexOf('/books/'); return i === -1 ? '' : String(url).slice(i + 1); },
  });
  const put = (key, body, { at = new Date(Date.now() - 3 * 86400000), etag } = {}) => store.set(key, { body: Buffer.from(body), at, etag });
  return { files, store, deleted, told, put };
}

/** A media row whose one track is `body`, stored under its own media-library/<id>/ folder. */
async function mediaRow(h, body, fields = {}, { hashed = true, store = true } = {}) {
  const _id = fields._id || oid();
  const key = fields.key || `media-library/${_id}/${Math.random().toString(36).slice(2, 8)}.mp3`;
  if (store) h.put(key, body);
  const { key: _k, track = {}, ...rest } = fields;
  return (await KadeBook.create({
    _id, owner: KADE, kind: 'audio', category: 'tv', shared: true, state: 'ready', title: 'Untitled', path: 'Audio/Needs Filing',
    tracks: [{ key, bytes: Buffer.byteLength(body), sha256: hashed ? sha(body) : '', title: rest.title || 'Part 1', mime: 'audio/mpeg', ...track }],
    ...rest,
  })).toObject();
}

test('the librarian merge moves every reference to the keeper, and undo puts every one back', async () => {
  const h = harness();
  const body = 'Bel-Air S01E01 described';
  const keeper = await mediaRow(h, body, { title: '[S01.E01] Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022)' });
  const extra = await mediaRow(h, body, { title: '[S01.E01] Dreams and Nightmares', path: 'Audio/Needs Filing/TV/Bel-Air - Season 1 (2022)', track: { description: { state: 'done', summary: 'A paid description.' } } });
  const kKey = keeper.tracks[0].key;
  const eKey = extra.tracks[0].key;
  const E = extra._id;
  const K = keeper._id;
  const old = new Date(Date.now() - 3600000);
  await KadeReadingProgress.create({ user: AMBER, book: E, s: 0, pos: 12 });
  await KadeReadingProgress.collection.insertOne({ user: KADE, book: K, s: 0, c: 0, pos: 5, finished: false, createdAt: old, updatedAt: old });
  await KadeReadingProgress.create({ user: KADE, book: E, s: 0, pos: 99, finished: true });
  await KadeReadingBookmark.create({ user: AMBER, book: E, s: 0, pos: 30, note: 'the good part' });
  const list = await KadeCollection.create({ owner: AMBER, title: 'Sitcoms', items: [{ book: E }, { book: K }, { book: E }] });
  const sub = await KadeLibrarySubmission.create({ user: AMBER, book: E, title: 'Bel-Air' });
  const request = await Requests.create({ book: String(E), title: 'Bel-Air' });
  const job = await DescriptionJobs.create({ library: { book: String(E), track: 0 }, copies: [{ savedToLibrary: String(E) }, { savedToLibrary: 'other' }] });
  const shortcut = (await KadeBook.create({ owner: KADE, kind: 'audio', category: 'tv', shared: true, state: 'ready', title: 'Bel-Air pilot', path: 'Audio/Favourites', shortcutOf: E, tracks: [{ key: eKey, bytes: Buffer.byteLength(body), sha256: sha(body) }] })).toObject();
  // Both copies are read by a shortcut, so the filed one stays (a file others point at is kept first).
  await KadeBook.create({ owner: AMBER, kind: 'audio', category: 'tv', shared: false, state: 'ready', title: 'Bel-Air', path: 'Audio/Mine', shortcutOf: K, tracks: [{ key: kKey, bytes: Buffer.byteLength(body), sha256: sha(body) }] });

  const groups = await h.files.duplicateGroups();
  assert.strictEqual(groups.length, 1);
  const g = groups[0];
  assert.strictEqual(g.id, P.groupId(sha(body), Buffer.byteLength(body)));
  assert.strictEqual(g.keeper, String(K));
  assert.deepStrictEqual(g.rows.map((r) => [r.id, r.action]).sort(), [[String(E), 'merge'], [String(K), 'keep']].sort());
  assert.strictEqual(g.rows.find((r) => r.id === String(E)).usage.readers, 2, 'usage counts ride along');

  const preview = await h.files.mergeGroups({ groups: 'all' });
  assert.strictEqual(preview.preview.length, 1);
  assert.strictEqual((await KadeBook.findById(E).lean()).state, 'ready', 'a preview writes nothing');
  const changed = await h.files.mergeGroups({ groups: [g.id], keepers: { [g.id]: String(E) }, apply: true });
  assert.match(changed.refused[0].why, /keeper changed/);
  assert.strictEqual((await KadeBook.findById(E).lean()).state, 'ready');

  const done = await h.files.mergeGroups({ groups: [g.id], keepers: { [g.id]: String(K) }, apply: true, by: 'test' });
  assert.strictEqual(done.applied.length, 1);
  const folded = await KadeBook.findById(E).lean();
  assert.strictEqual(folded.state, 'merged');
  assert.strictEqual(String(folded.mergedInto), String(K));
  assert.strictEqual(folded.shared, false);
  assert.strictEqual(folded.tracks[0].key, kKey, 'the folded row forwards to the stored bytes');
  assert.strictEqual((await KadeBook.findById(K).lean()).tracks[0].description.state, 'done', 'the paid description moved to the keeper');
  assert.strictEqual(String((await KadeReadingProgress.findOne({ user: AMBER }).lean()).book), String(K));
  const kadePlace = await KadeReadingProgress.find({ user: KADE }).lean();
  assert.strictEqual(kadePlace.length, 1, 'one place per person per file');
  assert.strictEqual(kadePlace[0].pos, 99, 'the more recent place wins');
  assert.strictEqual(kadePlace[0].finished, true);
  assert.strictEqual(String((await KadeReadingBookmark.findOne({}).lean()).book), String(K));
  assert.deepStrictEqual((await KadeCollection.findById(list._id).lean()).items.map((i) => String(i.book)), [String(K), String(K), String(K)]);
  assert.strictEqual(String((await KadeLibrarySubmission.findById(sub._id).lean()).book), String(K));
  assert.strictEqual((await Requests.findById(request._id).lean()).book, String(K));
  const movedJob = await DescriptionJobs.findById(job._id).lean();
  assert.strictEqual(movedJob.library.book, String(K));
  assert.deepStrictEqual(movedJob.copies.map((c) => c.savedToLibrary), [String(K), 'other']);
  const sc = await KadeBook.findById(shortcut._id).lean();
  assert.strictEqual(String(sc.shortcutOf), String(K));
  assert.strictEqual(sc.tracks[0].key, kKey, "the shortcut's own track list follows the file");
  assert.deepStrictEqual(h.deleted, [eKey], 'only the extra copy goes, and only once nothing lists it');
  assert.deepStrictEqual(await h.files.duplicateGroups(), []);
  assert.strictEqual(await KadeLibraryFold.countDocuments({}), 1);

  const undone = await h.files.undoReceipts({ all: true });
  assert.strictEqual(undone.undone.length, 1);
  const back = await KadeBook.findById(E).lean();
  assert.strictEqual(back.state, 'ready');
  assert.strictEqual(back.shared, true);
  assert.strictEqual(back.mergedInto, undefined);
  assert.strictEqual(String((await KadeReadingProgress.findOne({ user: AMBER }).lean()).book), String(E));
  const kadeBack = await KadeReadingProgress.find({ user: KADE }).sort({ pos: 1 }).lean();
  assert.deepStrictEqual(kadeBack.map((p) => [String(p.book), p.pos, p.finished]), [[String(K), 5, false], [String(E), 99, true]]);
  assert.strictEqual(String((await KadeReadingBookmark.findOne({}).lean()).book), String(E));
  assert.deepStrictEqual((await KadeCollection.findById(list._id).lean()).items.map((i) => String(i.book)), [String(E), String(K), String(E)]);
  assert.strictEqual(String((await KadeLibrarySubmission.findById(sub._id).lean()).book), String(E));
  assert.strictEqual((await Requests.findById(request._id).lean()).book, String(E));
  const jobBack = await DescriptionJobs.findById(job._id).lean();
  assert.strictEqual(jobBack.library.book, String(E));
  assert.deepStrictEqual(jobBack.copies.map((c) => c.savedToLibrary), [String(E), 'other']);
  assert.strictEqual(String((await KadeBook.findById(shortcut._id).lean()).shortcutOf), String(E));
  assert.deepStrictEqual((await h.files.undoReceipts({ all: true })).undone, [], 'a receipt is undone once');
});

test('held groups wait for Kade: applied only when confirmed, with her own plan when she gives one', async () => {
  const h = harness();
  const cassette = 'Lion King read-along';
  const a = await mediaRow(h, cassette, { title: 'The Lion King - Book And CD', path: 'Audio/Cassettes/Movie read-along stories, mostly Disney' });
  const b = await mediaRow(h, cassette, { title: 'The Lion King', path: 'Audio/Cassettes/My cassette collection' });
  const episode = 'Black-ish 6.01';
  const e1 = await mediaRow(h, episode, { title: '6.01 Pops the Question', path: 'Audio/Described Movies & TV/TV/Black-ish/Black-ish Season 6' });
  const e2 = await mediaRow(h, episode, { title: "6.02 Every Day I'm Struggling", path: 'Audio/Needs Filing/TV/Black-ish/Black-ish Season 6 (2019)' });
  const groups = await h.files.duplicateGroups();
  assert.strictEqual(groups.length, 2);
  assert.ok(groups.every((g) => /mislabeled/.test(g.hold)));
  const lion = groups.find((g) => g.rows.some((r) => r.id === String(a._id)));
  const blackish = groups.find((g) => g !== lion);

  const refused = await h.files.mergeGroups({ groups: 'all', apply: true });
  assert.strictEqual(refused.applied.length, 0);
  assert.strictEqual(refused.refused.length, 2);
  assert.ok(refused.refused.every((r) => /confirmHeld/.test(r.why)));

  const applied = await h.files.mergeGroups({
    groups: 'all', apply: true, confirmHeld: [lion.id, blackish.id],
    plans: { [blackish.id]: { keeper: String(e1._id), action: 'merge' } },
  });
  assert.strictEqual(applied.applied.length, 2);
  const lionExtra = lion.rows.find((r) => r.action === 'shortcut');
  const kept = await KadeBook.findById(lionExtra.id).lean();
  assert.strictEqual(kept.state, 'ready', 'the second cassette collection keeps its entry');
  assert.strictEqual(String(kept.shortcutOf), lion.keeper);
  assert.strictEqual(kept.path, lionExtra.path, 'in its own folder');
  assert.strictEqual((await KadeBook.findById(e2._id).lean()).state, 'merged', 'Kade chose to keep one Black-ish copy');
  assert.strictEqual((await KadeBook.findById(e1._id).lean()).state, 'ready');
  const bad = await h.files.mergeGroups({ groups: 'all', apply: true, confirmHeld: ['x'], plans: {} });
  assert.strictEqual(bad.applied.length, 0, 'nothing left to merge');
  assert.ok(b);
});

test('the same-text book merge folds only identical words, carries readers over, and names what it refused', async () => {
  const h = harness();
  const sections = (jacket) => [{ title: 'About this book', kind: 'jacket', chunkCount: jacket.length }, { title: 'Chapter 1', kind: 'section', chunkCount: 3 }, { title: 'Chapter 2', kind: 'section', chunkCount: 2 }];
  const words = [['one', 'two', 'three'], ['four', 'five']];
  const book = async (owner, title, jacket, chapters = words, extra = {}) => {
    const row = await KadeBook.create({ owner, kind: 'text', category: 'book', shared: true, state: 'ready', title, path: 'Books/Fiction — Romance', sections: sections(jacket), fileUrl: `https://b2.invalid/file/bucket/books/${owner}/book-${oid()}.zip`, ...extra });
    await KadeBookText.create({ book: row._id, sections: [{ chunks: jacket }, ...chapters.map((chunks) => ({ chunks }))] });
    return row.toObject();
  };
  const keeper = await book(AMBER, 'Abundance', ['Abundance. By Ezra Klein.']);
  const extra = await book(AMBER, 'Abundance 6484147', ['Abundance 6484147.', 'A second jacket line.'], words, { grownUpsOnly: false });
  const edition = await book(AMBER, 'Scythe', ['Scythe.'], [['one', 'two', 'THREE'], ['four', 'five']]);
  const scythe = await book(AMBER, 'Scythe (2)', ['Scythe.']);
  const kade = await book(KADE, 'Abundance', ['Abundance.']);
  await KadeReadingProgress.create({ user: HOLLY, book: extra._id, s: 2, c: 1 });
  await KadeReadingBookmark.create({ user: HOLLY, book: extra._id, s: 1, c: 2 });
  await KadeReadingBookmark.create({ user: HOLLY, book: extra._id, s: 0, c: 1, note: 'jacket line that the keeper does not have' });

  const pairs = [{ extra: String(extra._id), keeper: String(keeper._id) }, { extra: String(scythe._id), keeper: String(edition._id) }, { extra: String(kade._id), keeper: String(keeper._id) }];
  const preview = await h.files.mergeBooks({ pairs });
  assert.deepStrictEqual(preview.ok.map((p) => p.extra), [String(extra._id)]);
  assert.deepStrictEqual(preview.refused.map((r) => r.why), ['the text differs', "different owners: another person's book is never folded away"]);
  assert.strictEqual((await KadeBook.findById(extra._id).lean()).state, 'ready');

  const applied = await h.files.mergeBooks({ pairs, apply: true, by: 'test' });
  assert.strictEqual(applied.applied.length, 1);
  assert.strictEqual(applied.applied[0].readers, 1);
  const folded = await KadeBook.findById(extra._id).lean();
  assert.strictEqual(folded.state, 'merged');
  assert.strictEqual(String(folded.mergedInto), String(keeper._id));
  const place = await KadeReadingProgress.findOne({ user: HOLLY }).lean();
  assert.deepStrictEqual([String(place.book), place.s, place.c], [String(keeper._id), 2, 1], 'the reader is on the same words');
  const marks = await KadeReadingBookmark.find({ user: HOLLY }).sort({ s: 1 }).lean();
  assert.deepStrictEqual(marks.map((m) => [String(m.book), m.s, m.c]), [[String(keeper._id), 0, 0], [String(keeper._id), 1, 2]]);
  assert.deepStrictEqual(h.deleted, [], "the extra's own original stays until its 30 days are up");
  const undo = await h.files.undoReceipts({ receiptIds: [applied.applied[0].receipt] });
  assert.strictEqual(undo.undone.length, 1);
  assert.strictEqual((await KadeBook.findById(extra._id).lean()).state, 'ready');
  assert.strictEqual(String((await KadeReadingProgress.findOne({ user: HOLLY }).lean()).book), String(extra._id));
});

test('a withdrawn file hands itself to its oldest shortcut, and its bytes stay while anything lists them', async () => {
  const h = harness();
  const body = 'The Little Mermaid read-along';
  const keeper = await mediaRow(h, body, { title: 'The Little Mermaid', path: 'Audio/Cassettes/Movie read-along stories, mostly Disney', track: { description: { state: 'done', summary: 'x' } } });
  const key = keeper.tracks[0].key;
  const s1 = (await KadeBook.create({ owner: KADE, kind: 'audio', category: 'cassette', state: 'ready', shared: true, title: 'Little Mermiad', path: 'Audio/Cassettes/My cassette collection', shortcutOf: keeper._id, tracks: [{ key, bytes: Buffer.byteLength(body), title: 'Side A' }] })).toObject();
  const s2 = (await KadeBook.create({ owner: KADE, kind: 'audio', category: 'cassette', state: 'ready', shared: true, title: 'Mermaid', path: 'Audio/Favourites', shortcutOf: keeper._id, tracks: [{ key, bytes: Buffer.byteLength(body) }] })).toObject();
  const merged = (await KadeBook.create({ owner: KADE, kind: 'audio', category: 'cassette', state: 'merged', mergedInto: keeper._id, mergedAt: new Date(), title: 'Mermaid copy', tracks: [{ key, bytes: 1 }] })).toObject();
  // What DELETE /book/:id does:
  const heir = await h.files.promoteShortcuts(keeper);
  await KadeBook.deleteOne({ _id: keeper._id });
  await h.files.releaseKeys([key], { except: [keeper._id] });
  assert.strictEqual(String(heir), String(s1._id), 'the oldest shortcut');
  const promoted = await KadeBook.findById(s1._id).lean();
  assert.strictEqual(promoted.shortcutOf, undefined);
  assert.strictEqual(promoted.title, 'Little Mermiad', 'it keeps its own name');
  assert.strictEqual(promoted.tracks[0].title, 'Side A', 'and its own track name');
  assert.strictEqual(promoted.tracks[0].description.state, 'done', 'with the description');
  assert.strictEqual(String((await KadeBook.findById(s2._id).lean()).shortcutOf), String(s1._id), 'the rest follow it');
  assert.strictEqual(String((await KadeBook.findById(merged._id).lean()).mergedInto), String(s1._id), 'old links keep forwarding');
  assert.deepStrictEqual(h.deleted, [], 'the bytes stay: the heir plays them');
  // A text book with no shortcut: its original goes with it now (the old leak).
  const text = (await KadeBook.create({ owner: KADE, kind: 'text', state: 'ready', title: 'A Chosen Faith', fileUrl: 'https://b2.invalid/file/bucket/books/u/book-1.zip' })).toObject();
  assert.strictEqual(await h.files.promoteShortcuts(text), null);
  await KadeBook.deleteOne({ _id: text._id });
  await h.files.releaseKeys(['books/u/book-1.zip'], { except: [text._id] });
  assert.deepStrictEqual(h.deleted, ['books/u/book-1.zip']);
});

test('objects nothing lists: only byte-identical copies of a file the same item plays, older than a day, may go', async () => {
  const h = harness();
  const body = 'Back to the Future Part 2';
  const row = await mediaRow(h, body, { title: 'Back to the Future Part II' });
  const id = String(row._id);
  h.put(`media-library/${id}/retry-1.mp4`, body); // the retried push: same bytes, three days old
  h.put(`media-library/${id}/retry-2.mp4`, body, { at: new Date() }); // same bytes but minutes old
  h.put(`media-library/${id}/other.mp4`, 'a different cut of the film');
  h.put(`media-library/${oid()}/orphan.mp4`, body); // no row at all
  const report = await h.files.unreferenced({ objects: await h.files.listObjects('media-library/') });
  assert.strictEqual(report.count, 4);
  assert.strictEqual(report.identical, 1);
  assert.strictEqual(report.deleted, 0, 'a report deletes nothing');
  const why = Object.fromEntries(report.entries.map((e) => [e.key.split('/').pop(), e.why]));
  assert.match(why['retry-2.mp4'], /less than a day/);
  assert.match(why['other.mp4'], /not byte-identical/);
  assert.match(why['orphan.mp4'], /lists no other file/);
  const applied = await h.files.unreferenced({ objects: await h.files.listObjects('media-library/'), apply: true });
  assert.strictEqual(applied.deleted, 1);
  assert.deepStrictEqual(h.deleted, [`media-library/${id}/retry-1.mp4`]);
  assert.ok(h.store.has(row.tracks[0].key), 'the file the item plays is never touched');
});

test('the verifier keeps a new copy once when the rule is on, and only flags it in report mode', async () => {
  const body = 'Family Guy S15E01';
  // report mode: flagged, nothing moves
  let h = harness();
  let twin = await mediaRow(h, body, { title: 'Family Guy 15.01', path: 'Audio/Described Movies & TV/TV/Family Guy' }, { hashed: false });
  let fresh = await mediaRow(h, body, { title: 'Family Guy 15.01', path: 'Audio/Needs Filing/TV/Family Guy', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  assert.deepStrictEqual(await h.files.verifyPass(), { duplicate: 1 });
  let row = await KadeBook.findById(fresh._id).lean();
  assert.strictEqual(row.fileCheck.state, 'duplicate');
  assert.strictEqual(String(row.fileCheck.of), String(twin._id));
  assert.strictEqual(row.state, 'ready');
  assert.deepStrictEqual(h.deleted, []);
  assert.strictEqual((await KadeBook.findById(twin._id).lean()).tracks[0].sha256, sha(body), 'hashed from the stored bytes');

  await KadeBook.deleteMany({});
  process.env.KADE_LIBRARY_FILES = 'on';
  h = harness();
  twin = await mediaRow(h, body, { title: 'Family Guy 15.01', path: 'Audio/Described Movies & TV/TV/Family Guy' }, { hashed: false });
  fresh = await mediaRow(h, body, { title: 'Family Guy 15.01', path: 'Audio/Needs Filing/TV/Family Guy', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  const unique = await mediaRow(h, 'a file of its own size, never read', { title: 'Unique', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  const tally = await h.files.verifyPass();
  assert.deepStrictEqual(tally, { folded: 1, unique: 1 });
  row = await KadeBook.findById(fresh._id).lean();
  assert.strictEqual(row.state, 'merged');
  assert.strictEqual(String(row.mergedInto), String(twin._id));
  assert.deepStrictEqual(h.deleted, [fresh.tracks[0].key], 'the new bytes go, after the stored copy answered');
  assert.strictEqual((await KadeBook.findById(unique._id).lean()).tracks[0].sha256, '', 'a unique size is settled without reading a byte');
  assert.strictEqual(h.told.length, 1);
  assert.match(h.told[0][1], /^Already in the library: "Family Guy 15\.01" .*exactly the same file, so it is kept once\.$/);
});

test('the backfill hashes only same-size files the ETags cannot tell apart; the ETag fill needs no reads', async () => {
  const h = harness();
  const a = await mediaRow(h, 'same size AAAA', {}, { hashed: false });
  const b = await mediaRow(h, 'same size AAAA', {}, { hashed: false });
  const c = await mediaRow(h, 'same size BBBB', {}, { hashed: false });
  await mediaRow(h, 'a size nobody else has', {}, { hashed: false });
  const filled = await h.files.fillEtags({ apply: true });
  assert.strictEqual(filled.written, 4);
  assert.strictEqual((await KadeBook.findById(c._id).lean()).tracks[0].etag, md5('same size BBBB'));
  const result = await h.files.hashCollisions();
  assert.strictEqual(result.hashed, 2, 'the two with one ETag');
  assert.strictEqual(result.settledByEtag, 1, 'the third is proven different by its ETag alone');
  assert.strictEqual((await KadeBook.findById(a._id).lean()).tracks[0].sha256, sha('same size AAAA'));
  assert.strictEqual((await KadeBook.findById(b._id).lean()).tracks[0].sha256, sha('same size AAAA'));
  assert.strictEqual((await KadeBook.findById(c._id).lean()).tracks[0].sha256, '');
  assert.strictEqual((await h.files.duplicateGroups()).length, 1, 'the pair now shows up for Kade');
});

function loadSweep() {
  const source = fs.readFileSync(path.join(__dirname, '../routes/kadeReadingRoomMediaSweep.js'), 'utf8');
  const sandbox = { module: { exports: {} }, process, Date, setInterval, setTimeout, console };
  sandbox.require = (name) => ({
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
    '~/models/kadeBook': { KadeBook },
    '~/models/kadeUsage': { logKadeUsage: async () => {} },
    '~/server/services/kadeJev': { enabled: () => true },
    '~/server/services/kadeMediaLibrarian': { zoneOf: () => 'intake', categoryOf: () => 'tv', VERSION: 1 },
  })[name];
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}

test('the media sweep never picks a shortcut, and waits for the verifier on a fresh upload', async () => {
  const sweep = loadSweep();
  const plain = await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'A tape', path: 'Audio/Needs Filing' });
  await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'A shortcut', path: 'Audio/Needs Filing', shortcutOf: plain._id });
  await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'Just uploaded', path: 'Audio/Needs Filing', fileCheck: { state: 'pending', at: new Date() } });
  const stale = await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'Verifier stuck', path: 'Audio/Needs Filing', fileCheck: { state: 'pending', at: new Date(Date.now() - 2 * 3600000) } });
  await KadeBook.create({ owner: KADE, kind: 'audio', state: 'merged', title: 'Folded', path: 'Audio/Needs Filing' });
  const picked = await sweep._pick(50);
  assert.deepStrictEqual(Array.from(picked, (i) => i.title).sort(), ['A tape', 'Verifier stuck']);
  assert.ok(stale);
  assert.strictEqual(sweep.identicalCopy({ title: 'Same title', tracks: [{ bytes: 5 }] }, new Set()), false, 'a title and a size are never a duplicate flag');
});

test('"another is kept" is written only while the other copy is kept: there, ready, the same owner\'s, and not itself marked', async () => {
  const sweep = loadSweep();
  const keeper = await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'The copy that stays', path: 'Audio/TV', fileCheck: { state: 'kept' } });
  const extra = (await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', title: 'The copy', path: 'Audio/Needs Filing', fileCheck: { state: 'duplicate', of: keeper._id } })).toObject();
  let kept = await sweep.keptCopies([extra]);
  assert.strictEqual(sweep.identicalCopy(extra, kept), true);
  assert.strictEqual(sweep.identicalCopy({ ...extra, fileCheck: { state: 'duplicate' } }, kept), false, 'a mark that names no copy');
  assert.strictEqual(sweep.identicalCopy({ ...extra, owner: AMBER }, kept), false, "never for another person's copy");
  await KadeBook.updateOne({ _id: keeper._id }, { $set: { 'fileCheck.state': 'duplicate', 'fileCheck.of': extra._id } });
  kept = await sweep.keptCopies([extra]);
  assert.strictEqual(sweep.identicalCopy(extra, kept), false, 'both marked: neither is "kept"');
  await KadeBook.updateOne({ _id: keeper._id }, { $set: { 'fileCheck.state': 'kept', state: 'pending' } });
  assert.strictEqual(sweep.identicalCopy(extra, await sweep.keptCopies([extra])), false, 'the other copy is not ready');
  await KadeBook.deleteOne({ _id: keeper._id });
  assert.strictEqual(sweep.identicalCopy(extra, await sweep.keptCopies([extra])), false, 'the other copy is gone');
});

test('report mode: two or three new copies of one file in one pass: only the extra ones are marked, never all of them', async () => {
  const body = "Schitt's Creek 1.01";
  const pending = () => ({ state: 'pending', at: new Date() });
  for (const filedFirst of [true, false]) {
    await KadeBook.deleteMany({});
    const h = harness();
    const filed = { title: 'Our Cup Runneth Over', path: "Video/TV/Schitt's Creek", fileCheck: pending() };
    const intake = { title: 'Our Cup Runneth Over', path: "Video/Needs Filing/Schitt's Creek - Copy", fileCheck: pending() };
    const first = await mediaRow(h, body, filedFirst ? filed : intake, { hashed: false });
    const second = await mediaRow(h, body, filedFirst ? intake : filed, { hashed: false });
    await h.files.verifyPass();
    const rows = new Map((await KadeBook.find({}).lean()).map((r) => [String(r._id), r]));
    const stays = filedFirst ? first : second;
    const extra = filedFirst ? second : first;
    assert.strictEqual(rows.get(String(extra._id)).fileCheck.state, 'duplicate', 'the Needs Filing copy is the extra one');
    assert.strictEqual(String(rows.get(String(extra._id)).fileCheck.of), String(stays._id));
    assert.strictEqual(rows.get(String(stays._id)).fileCheck.state, 'kept', `the filed copy stays (${filedFirst ? 'checked first' : 'checked second'})`);
  }
  await KadeBook.deleteMany({});
  const h = harness();
  const a = await mediaRow(h, body, { title: 'Our Cup Runneth Over', path: "Video/TV/Schitt's Creek", fileCheck: pending() }, { hashed: false });
  const b = await mediaRow(h, body, { title: 'Our Cup Runneth Over', path: 'Video/Needs Filing/One', fileCheck: pending() }, { hashed: false });
  const c = await mediaRow(h, body, { title: 'Our Cup Runneth Over', path: 'Video/Needs Filing/Two', fileCheck: pending() }, { hashed: false });
  await h.files.verifyPass();
  const states = Object.fromEntries((await KadeBook.find({}).lean()).map((r) => [String(r._id), [r.fileCheck.state, String(r.fileCheck.of || '')]]));
  assert.deepStrictEqual(states, { [String(a._id)]: ['kept', String(b._id)], [String(b._id)]: ['duplicate', String(a._id)], [String(c._id)]: ['duplicate', String(a._id)] });
  assert.deepStrictEqual(h.deleted, [], 'report mode changes nothing else');
});

test('report mode: an item that only shares one of its tracks is never an identical copy; a whole two-track copy is', async () => {
  const h = harness();
  const sideA = 'Tape 3 side A';
  const sideB = 'Tape 3 side B, only on this tape';
  await mediaRow(h, sideA, { title: 'Tape 3 side A', path: 'Audio/Cassettes/Mine' }, { hashed: false });
  const tape = async (title) => {
    const _id = oid();
    const [k1, k2] = [`media-library/${_id}/a.mp3`, `media-library/${_id}/b.mp3`];
    h.put(k1, sideA);
    h.put(k2, sideB);
    return (await KadeBook.create({ _id, owner: KADE, kind: 'audio', category: 'cassette', shared: true, state: 'ready', title, path: 'Audio/Needs Filing', fileCheck: { state: 'pending', at: new Date() },
      tracks: [{ key: k1, bytes: Buffer.byteLength(sideA), title: 'Side A' }, { key: k2, bytes: Buffer.byteLength(sideB), title: 'Side B' }] })).toObject();
  };
  const whole = await tape('Tape 3');
  assert.deepStrictEqual(await h.files.verifyPass(), { 'shares-tracks': 1 });
  assert.strictEqual((await KadeBook.findById(whole._id).lean()).fileCheck.state, 'shares-tracks');
  const sweep = loadSweep();
  const row = await KadeBook.findById(whole._id).lean();
  assert.strictEqual(sweep.identicalCopy(row, await sweep.keptCopies([row])), false, 'no space-review line for a shared side A');
  const again = await tape('Tape 3');
  assert.deepStrictEqual(await h.files.verifyPass(), { duplicate: 1 });
  const marked = await KadeBook.findById(again._id).lean();
  assert.strictEqual(String(marked.fileCheck.of), String(whole._id), 'every track the same file, in order');
});

test("report mode never marks a copy as the extra one because of someone else's copy, the admin's override included", async () => {
  const body = 'Christmas 1995 home video';
  const h = harness({ readers: { [String(KADE)]: { id: String(KADE), admin: true, child: false, hidden: false } } });
  await mediaRow(h, body, { owner: HOLLY, shared: false, title: "Holly's tape", path: 'Video/Home' }, { hashed: false });
  const kade = await mediaRow(h, body, { title: 'Christmas 1995', path: 'Video/Needs Filing', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  await mediaRow(h, 'Amber shares this one', { owner: AMBER, shared: true, title: 'Parade', path: 'Video/Local' });
  const holly = await mediaRow(h, 'Amber shares this one', { owner: HOLLY, shared: false, title: 'Parade', path: 'Video/Needs Filing', fileCheck: { state: 'pending', at: new Date() } });
  assert.deepStrictEqual(await h.files.verifyPass(), { kept: 2 });
  assert.strictEqual((await KadeBook.findById(kade._id).lean()).fileCheck.state, 'kept');
  assert.strictEqual((await KadeBook.findById(holly._id).lean()).fileCheck.state, 'kept', "Amber's copy is hers: both stay");
});

test("with the rule on, another person's copy is only linked: both rows stay, nothing is said, and one withdrawal never takes the other's item", async () => {
  process.env.KADE_LIBRARY_FILES = 'on';
  const body = 'Christmas 1995 home video';
  const h = harness({ readers: { [String(KADE)]: { id: String(KADE), admin: true, child: false, hidden: false } } });
  const hollys = await mediaRow(h, body, { owner: HOLLY, shared: false, title: "Holly's tape", path: 'Video/Home' }, { hashed: false });
  const kade = await mediaRow(h, body, { title: 'Christmas 1995', path: 'Video/Needs Filing', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  const ambers = await mediaRow(h, 'Amber shares this one', { owner: AMBER, shared: true, title: 'Parade', path: 'Video/Local' });
  const holly = await mediaRow(h, 'Amber shares this one', { owner: HOLLY, shared: false, title: 'Parade 1996', path: 'Video/Needs Filing', fileCheck: { state: 'pending', at: new Date() } });
  assert.deepStrictEqual(await h.files.verifyPass(), { linked: 2 });
  const k = await KadeBook.findById(kade._id).lean();
  assert.deepStrictEqual([k.state, k.shared, k.tracks[0].key], ['ready', true, hollys.tracks[0].key], "Kade's shared item stays, on Holly's stored bytes");
  const hl = await KadeBook.findById(holly._id).lean();
  assert.deepStrictEqual([hl.state, hl.title, hl.tracks[0].key], ['ready', 'Parade 1996', ambers.tracks[0].key]);
  assert.deepStrictEqual(h.told, [], 'nothing is said about a link');
  assert.strictEqual(await KadeLibraryFold.countDocuments({}), 0);
  // Amber withdraws hers: Holly's item keeps the bytes.
  await KadeBook.deleteOne({ _id: ambers._id });
  assert.deepStrictEqual(await h.files.releaseKeys([ambers.tracks[0].key], { except: [ambers._id] }), []);
});

test('with the rule on, a folded upload that had its own title is told so (never "nothing was lost"), and the fold can be put back', async () => {
  process.env.KADE_LIBRARY_FILES = 'on';
  const body = 'Family Guy S15E02';
  const h = harness();
  const twin = await mediaRow(h, body, { title: 'Family Guy 15.02', path: 'Audio/Described Movies & TV/TV/Family Guy' }, { hashed: false });
  const fresh = await mediaRow(h, body, { title: 'The one with the boat', description: 'Taped for Dad.', path: 'Audio/Needs Filing', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  assert.deepStrictEqual(await h.files.verifyPass(), { folded: 1 });
  assert.strictEqual(h.told.length, 1);
  assert.match(h.told[0][1], /^Your upload "The one with the boat" is exactly the same file as "Family Guy 15\.02"/);
  assert.ok(!/Nothing was lost/.test(h.told[0][1]));
  const [receipt] = await KadeLibraryFold.find({}).lean();
  assert.strictEqual(receipt.by, 'verifier');
  assert.strictEqual(String(receipt.keeper), String(twin._id));
  assert.deepStrictEqual([receipt.entries[0].before.title, receipt.entries[0].before.description], ['The one with the boat', 'Taped for Dad.']);
  await h.files.undoReceipts({ receiptIds: [String(receipt._id)] });
  const back = await KadeBook.findById(fresh._id).lean();
  assert.deepStrictEqual([back.state, back.title, back.tracks[0].key], ['ready', 'The one with the boat', twin.tracks[0].key], 'back, on the same stored bytes');
});

test('a check that keeps failing backs off and ends "unchecked"; it never blocks newer uploads', async () => {
  const h = harness();
  const body = 'a file whose stored object went missing';
  await mediaRow(h, body, { title: 'Stored twin' }, { hashed: false });
  const broken = await mediaRow(h, body, { title: 'Broken', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false, store: false });
  const fresh = await mediaRow(h, 'a size of its own', { title: 'Fresh', fileCheck: { state: 'pending', at: new Date() } }, { hashed: false });
  assert.deepStrictEqual(await h.files.verifyPass(), { failed: 1, unique: 1 });
  let row = await KadeBook.findById(broken._id).lean();
  assert.deepStrictEqual([row.fileCheck.state, row.fileCheck.tries], ['pending', 1]);
  assert.match(row.fileCheck.error, /NoSuchKey/);
  assert.ok(row.fileCheck.next > new Date(), 'it waits for its retry time');
  assert.strictEqual((await KadeBook.findById(fresh._id).lean()).fileCheck.state, 'unique');
  assert.deepStrictEqual(await h.files.verifyPass(), {}, 'not retried before its time');
  await KadeBook.updateOne({ _id: broken._id }, { $set: { 'fileCheck.next': new Date(Date.now() - 1000), 'fileCheck.tries': 4 } });
  assert.deepStrictEqual(await h.files.verifyPass(), { unchecked: 1 });
  row = await KadeBook.findById(broken._id).lean();
  assert.deepStrictEqual([row.fileCheck.state, row.fileCheck.tries], ['unchecked', 5]);
});

test("a book original an older row names only in fileUrl survives the withdrawal of a shortcut to it", async () => {
  const h = harness();
  const key = 'books/u1/book-abc.zip';
  const inserted = await KadeBook.collection.insertOne({ owner: KADE, kind: 'text', state: 'ready', title: 'A Chosen Faith', fileUrl: `https://b2.invalid/file/bucket/${key}`, tracks: [], createdAt: new Date(), updatedAt: new Date() });
  const shortcut = await KadeBook.create({ owner: AMBER, kind: 'text', state: 'ready', title: 'Faith', path: 'Books/Mine', shortcutOf: inserted.insertedId, fileKey: key });
  await KadeBook.deleteOne({ _id: shortcut._id });
  assert.deepStrictEqual(await h.files.releaseKeys([key], { except: [shortcut._id] }), []);
  assert.deepStrictEqual(h.deleted, []);
});

test('a merge-made shortcut carries the grown-ups flag of its file, undo lifts it, and a promoted shortcut keeps it', async () => {
  const h = harness();
  const body = 'A late-night special';
  const keeper = await mediaRow(h, body, { title: 'The Special', path: 'Video/Comedy/Specials', grownUpsOnly: true });
  const copy = await mediaRow(h, body, { title: 'The Special', path: 'Video/TV/HBO', grownUpsOnly: false });
  const [g] = await h.files.duplicateGroups();
  assert.strictEqual(g.keeper, String(keeper._id));
  const done = await h.files.mergeGroups({ groups: [g.id], apply: true });
  assert.deepStrictEqual(done.applied[0].entries.map((e) => e.action), ['shortcut']);
  let sc = await KadeBook.findById(copy._id).lean();
  assert.deepStrictEqual([String(sc.shortcutOf), sc.grownUpsOnly], [String(keeper._id), true], 'rule 8: a child never lists it');
  await h.files.undoReceipts({ all: true });
  sc = await KadeBook.findById(copy._id).lean();
  assert.deepStrictEqual([sc.shortcutOf, sc.grownUpsOnly], [undefined, false]);
  // A shortcut that missed the flag (the Jev sort flags a file without propagating) takes it on promotion.
  const pointer = await KadeBook.create({ owner: KADE, kind: 'audio', state: 'ready', shared: true, grownUpsOnly: false, title: 'Special', path: 'Video/Favourites', shortcutOf: keeper._id, tracks: [{ key: keeper.tracks[0].key, bytes: Buffer.byteLength(body), sha256: sha(body) }] });
  assert.strictEqual(String(await h.files.promoteShortcuts(keeper)), String(pointer._id));
  assert.strictEqual((await KadeBook.findById(pointer._id).lean()).grownUpsOnly, true);
});

test('withdrawing a text book whose copy became a shortcut through a merge hands over its text cleanly (no E11000)', async () => {
  const h = harness();
  const zip = 'the same Bookshare ZIP, byte for byte';
  const book = async (title, bookPath, parserVersion, chapters) => {
    const _id = oid();
    const key = `books/${KADE}/book-${_id}.zip`;
    h.put(key, zip);
    await KadeBookText.create({ book: _id, sections: chapters.map((chunks) => ({ chunks })) });
    return (await KadeBook.create({ _id, owner: KADE, kind: 'text', category: 'book', shared: true, state: 'ready', title, path: bookPath, fileKey: key, fileUrl: `https://b2.invalid/file/bucket/${key}`,
      fileBytes: Buffer.byteLength(zip), fileSha256: sha(zip), parserVersion, sections: chapters.map((c, i) => ({ title: `Chapter ${i + 1}`, kind: 'section', chunkCount: c.length })) })).toObject();
  };
  const keeper = await book('A Chosen Faith', 'Books/Faith', 2, [['one', 'two'], ['three']]);
  const copy = await book('A Chosen Faith', 'Books/Favourites', 1, [['one two three']]);
  const [g] = await h.files.duplicateGroups();
  assert.strictEqual(g.keeper, String(keeper._id));
  const done = await h.files.mergeGroups({ groups: [g.id], apply: true });
  assert.deepStrictEqual(done.applied[0].entries.map((e) => e.action), ['shortcut']);
  assert.strictEqual(await KadeBookText.countDocuments({}), 2, 'a merge leaves each row its own text');
  const heir = await h.files.promoteShortcuts(await KadeBook.findById(keeper._id).lean());
  assert.strictEqual(String(heir), String(copy._id));
  const texts = await KadeBookText.find({}).lean();
  assert.strictEqual(texts.length, 1, "the heir's old copy of the words went");
  assert.strictEqual(String(texts[0].book), String(copy._id));
  assert.deepStrictEqual(texts[0].sections.map((s) => s.chunks), [['one', 'two'], ['three']], "the heir reads the withdrawn file's text");
  const row = await KadeBook.findById(copy._id).lean();
  assert.deepStrictEqual([row.shortcutOf, row.parserVersion, row.sections.map((s) => s.chunkCount)], [undefined, 2, [2, 1]], 'and its section counts match that text');
});

test('a shared copy is never folded into a private one: books/merge and a held plan refuse it', async () => {
  const h = harness();
  const sections = [{ title: 'Chapter 1', kind: 'section', chunkCount: 2 }];
  const book = async (title, shared) => {
    const row = await KadeBook.create({ owner: KADE, kind: 'text', category: 'book', shared, state: 'ready', title, path: 'Books/Fiction', sections, fileUrl: `https://b2.invalid/file/bucket/books/${KADE}/book-${oid()}.zip` });
    await KadeBookText.create({ book: row._id, sections: [{ chunks: ['one', 'two'] }] });
    return row.toObject();
  };
  const shared = await book('Abundance', true);
  const priv = await book('Abundance (2)', false);
  const r = await h.files.mergeBooks({ pairs: [{ extra: String(shared._id), keeper: String(priv._id) }], apply: true });
  assert.strictEqual(r.applied.length, 0);
  assert.match(r.refused[0].why, /family library/);
  assert.strictEqual((await KadeBook.findById(shared._id).lean()).state, 'ready');
  const ok = await h.files.mergeBooks({ pairs: [{ extra: String(priv._id), keeper: String(shared._id) }] });
  assert.strictEqual(ok.ok.length, 1, 'the other way round is fine');

  const body = 'Held pair';
  const pub = await mediaRow(h, body, { title: '6.01 Pops the Question', path: 'Audio/Needs Filing/TV' });
  const mine = await mediaRow(h, body, { title: "6.02 Every Day I'm Struggling", shared: false, path: 'Audio/TV/Black-ish' });
  const [g] = await h.files.duplicateGroups();
  const refused = await h.files.mergeGroups({ groups: [g.id], apply: true, confirmHeld: [g.id], plans: { [g.id]: { keeper: String(mine._id), action: 'merge' } } });
  assert.strictEqual(refused.applied.length, 0);
  assert.match(refused.refused[0].why, /family library/);
  assert.strictEqual((await KadeBook.findById(pub._id).lean()).state, 'ready');
});

test("withdrawing a file: only its owner's shortcut inherits it; shortcuts other people made go with it", async () => {
  const h = harness();
  const body = 'Holly home video';
  const file = await mediaRow(h, body, { owner: HOLLY, title: 'Christmas', path: 'Video/Home' });
  const key = file.tracks[0].key;
  const t = { key, bytes: Buffer.byteLength(body), sha256: sha(body) };
  const ambers = await KadeBook.create({ owner: AMBER, kind: 'audio', state: 'ready', title: 'Holly tape', path: 'Video/Mine', shortcutOf: file._id, tracks: [t] });
  const hollys = await KadeBook.create({ owner: HOLLY, kind: 'audio', state: 'ready', title: 'Christmas again', path: 'Video/Favourites', shortcutOf: file._id, tracks: [t] });
  assert.strictEqual(String(await h.files.promoteShortcuts(file)), String(hollys._id), "her own shortcut, though Amber's is older");
  assert.strictEqual(String((await KadeBook.findById(ambers._id).lean()).shortcutOf), String(file._id), "Amber's is not handed to Holly's heir");
  assert.deepStrictEqual((await h.files.foreignShortcuts([file])).map(String), [String(ambers._id)]);

  await KadeBook.deleteMany({});
  const solo = await mediaRow(h, body, { owner: HOLLY, title: 'Christmas', path: 'Video/Home' });
  const other = await KadeBook.create({ owner: AMBER, kind: 'audio', state: 'ready', title: 'Holly tape', path: 'Video/Mine', shortcutOf: solo._id, tracks: [{ ...t, key: solo.tracks[0].key }] });
  assert.strictEqual(await h.files.promoteShortcuts(solo), null, "another person's shortcut never takes the file");
  const foreign = await h.files.foreignShortcuts([solo]);
  await KadeBook.deleteMany({ _id: { $in: [solo._id, ...foreign] } });
  assert.deepStrictEqual(await h.files.releaseKeys([solo.tracks[0].key], { except: [solo._id, ...foreign] }), [solo.tracks[0].key], 'so the withdrawal really removes it');
  assert.strictEqual(await KadeBook.findById(other._id).lean(), null);
});

test("a stricter grown-ups flag reaches the keeper and its shortcuts even when a link goes first, and undo lifts it", async () => {
  const h = harness();
  const body = 'A grown-ups cut of the same tape';
  const keeper = await mediaRow(h, body, { title: 'The Tape', path: 'Audio/Cassettes/My cassette collection' });
  const theirs = await mediaRow(h, body, { owner: AMBER, shared: false, title: 'The Tape', path: 'Audio/Mine' });
  const strict = await mediaRow(h, body, { title: 'The Tape', path: 'Audio/Needs Filing', grownUpsOnly: true });
  const pointer = (await KadeBook.create({ owner: KADE, kind: 'audio', category: 'tv', shared: true, state: 'ready', title: 'The Tape', path: 'Audio/Favourites', shortcutOf: keeper._id, tracks: [{ key: keeper.tracks[0].key, bytes: Buffer.byteLength(body), sha256: sha(body) }] })).toObject();
  const [g] = await h.files.duplicateGroups();
  assert.strictEqual(g.keeper, String(keeper._id));
  assert.deepStrictEqual(g.keeperSet, { grownUpsOnly: true });
  const done = await h.files.mergeGroups({ groups: [g.id], apply: true });
  assert.strictEqual(done.applied.length, 1);
  const actions = Object.fromEntries(done.applied[0].entries.map((e) => [e.id, e.action]));
  assert.deepStrictEqual(actions, { [String(theirs._id)]: 'link', [String(strict._id)]: 'merge' });
  assert.strictEqual((await KadeBook.findById(keeper._id).lean()).grownUpsOnly, true, 'the keeper took the stricter flag');
  assert.strictEqual((await KadeBook.findById(pointer._id).lean()).grownUpsOnly, true, 'and so did its shortcut (rule 8)');
  const linked = await KadeBook.findById(theirs._id).lean();
  assert.strictEqual(linked.state, 'ready', "another person's row stays theirs");
  assert.strictEqual(linked.grownUpsOnly, false, 'and keeps its own setting');
  assert.strictEqual(linked.tracks[0].key, keeper.tracks[0].key, 'sharing the stored bytes');
  await h.files.undoReceipts({ all: true });
  assert.strictEqual((await KadeBook.findById(keeper._id).lean()).grownUpsOnly, false);
  assert.strictEqual((await KadeBook.findById(pointer._id).lean()).grownUpsOnly, false);
  assert.strictEqual((await KadeBook.findById(strict._id).lean()).state, 'ready');
});

test("the storage keeper's daily report counts Library files no row lists, and removes nothing", async () => {
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '~/models/kadeBook') return models;
    if (request === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    return load.call(this, request, ...rest);
  };
  try {
    const keeperPath = require.resolve('./kadeStorageKeeper');
    delete require.cache[keeperPath];
    const { unreferencedSummary } = require('./kadeStorageKeeper');
    const h = harness();
    const body = 'Back to the Future Part 3';
    const row = await mediaRow(h, body, { title: 'Back to the Future Part III' });
    const id = String(row._id);
    await KadeBook.create({ owner: KADE, kind: 'text', state: 'ready', title: 'Kept book', fileKey: 'books/u/book-kept.zip' });
    const old = new Date(Date.now() - 3 * 86400000);
    const v = (key, size, etag, extra = {}) => ({ key, versionId: key + '-v', size, etag, lastModified: old, isLatest: true, deleteMarker: false, ...extra });
    const versions = [
      v(row.tracks[0].key, Buffer.byteLength(body), md5(body)),
      v(`media-library/${id}/retry.mp4`, Buffer.byteLength(body), md5(body)),
      v(`media-library/${id}/gone.mp4`, 10, md5('x'), { isLatest: false }),
      v(`media-library/${oid()}/orphan.mp4`, 7, md5('orphan')),
      v('books/u/book-kept.zip', 100, md5('kept')),
      v('books/u/book-loose.zip', 200, md5('loose')),
    ];
    const report = await unreferencedSummary(versions);
    assert.strictEqual(report.count, 2, 'the retried copy and the orphan (a hidden version is not counted)');
    assert.strictEqual(report.identical, 1);
    assert.strictEqual(report.books.count, 1, 'one book original no row lists');
    assert.ok(report.sample.some((e) => e.key.endsWith('/retry.mp4') && e.identical === true));
    assert.ok(report.sample.some((e) => e.key === 'books/u/book-loose.zip' && e.identical === false));
    assert.deepStrictEqual(h.deleted, [], 'report only');
  } finally {
    Module._load = load;
  }
});
