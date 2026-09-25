'use strict';
/* The one-file rule's route wiring (Sep 25 2026): old links to a folded copy forward to its keeper
 * (at most 3 hops, and the keeper is judged on its own); a shortcut opens with its keeper's file and
 * never more openly than that file; a client-sent hash is answered only for a copy the uploader can
 * open and otherwise changes nothing; a withdrawn file hands itself to its shortcut and its stored
 * bytes go only through reference counting. The rules themselves are tested in
 * services/kadeLibraryFilesPlan.nodetest.js and services/kadeLibraryFiles*.nodetest.js.
 * Run: node --test api/server/routes/kadeReadingRoomFiles.selftest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../services/kadeLibraryFiles');
const filesPlan = require('../services/kadeLibraryFilesPlan');

const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `slice ${from}`);
  return source.slice(start, end);
};
const logger = { info() {}, warn() {}, error() {} };
const member = (user) => !!user && (user.role === 'ADMIN' || String(user.id).startsWith('fam'));
const plainJSON = (x) => JSON.parse(JSON.stringify(x));
const SHA = 'c'.repeat(64);

function fakeBooks(rows) {
  const byId = (id) => rows[String(id)] || null;
  return { rows, findById: (id) => ({ lean: async () => (byId(id) ? structuredClone(byId(id)) : null) }) };
}

function opener(rows) {
  const KadeBook = fakeBooks(rows);
  const libraryFiles = F.createLibraryFiles({ models: { KadeBook }, s3: () => null, bucket: () => '', deleteKeys: async () => {}, readerOf: async () => null });
  const c = {
    require: (name) => (name === '@librechat/api' ? { familyLibraryMember: member } : require(name)),
    isId: (id) => /^[a-z0-9-]+$/i.test(String(id || '')),
    isAdmin: (req) => req.user.role === 'ADMIN',
    isChild: async (req) => req.user.kadeAccountType === 'child',
    readerFor: async (req) => ({ id: String(req.user.id), admin: req.user.role === 'ADMIN', child: req.user.kadeAccountType === 'child', hidden: !member(req.user) }),
    KadeBook,
    libraryFiles,
  };
  vm.runInNewContext(slice('function libraryHiddenFrom(req)', 'function listenClock') + slice('async function openBook(req, id)', 'function summary('), c);
  return async (user, id) => plainJSON(await c.openBook({ user }, id));
}

test('an old link to a folded copy forwards to its keeper, at most three hops, and the keeper decides who may open it', async () => {
  const keeper = { _id: 'k', owner: 'fam-amber', state: 'ready', shared: true, kind: 'audio', title: 'Dreams and Nightmares', tracks: [{ key: 'media-library/k/a.mp3', title: 'Dreams' }] };
  const rows = {
    k: keeper,
    e1: { _id: 'e1', owner: 'fam-amber', state: 'merged', mergedInto: 'k' },
    e2: { _id: 'e2', owner: 'fam-amber', state: 'merged', mergedInto: 'e1' },
    e3: { _id: 'e3', owner: 'fam-amber', state: 'merged', mergedInto: 'e2' },
    e4: { _id: 'e4', owner: 'fam-amber', state: 'merged', mergedInto: 'e3' },
    p: { _id: 'p', owner: 'fam-amber', state: 'ready', shared: false, kind: 'audio', title: "Grandma's Christmas 1994", tracks: [] },
    ep: { _id: 'ep', owner: 'fam-amber', state: 'merged', mergedInto: 'p' },
    lost: { _id: 'lost', owner: 'fam-amber', state: 'merged' },
  };
  const open = opener(rows);
  const holly = { id: 'fam-holly' };
  assert.equal((await open(holly, 'e1'))._id, 'k');
  assert.equal((await open(holly, 'e3'))._id, 'k', 'three hops still forward');
  assert.equal(await open(holly, 'e4'), null, 'a fourth hop does not');
  assert.equal(await open(holly, 'ep'), null, "a copy folded into someone's private item stays closed to others");
  assert.equal((await open({ id: 'fam-amber' }, 'ep'))._id, 'p', 'the owner still gets her own keeper');
  assert.equal(await open(holly, 'lost'), null);
  assert.equal(await open({ id: 'stranger' }, 'e1'), null, 'no family access, no forward');
});

test('a shortcut opens under its own name with its keeper file, never more openly than that file', async () => {
  const rows = {
    k: { _id: 'k', owner: 'fam-kade', state: 'ready', shared: true, grownUpsOnly: false, kind: 'audio', tracks: [{ key: 'media-library/k/side-a.mp3', title: 'Side A', description: { state: 'done', summary: 'A read-along.' } }] },
    s: { _id: 's', owner: 'fam-kade', state: 'ready', shared: true, kind: 'audio', title: 'The Lion King', path: 'Audio/Cassettes/My cassette collection', shortcutOf: 'k', tracks: [{ key: 'media-library/k/side-a.mp3', title: 'The Lion King' }] },
    adult: { _id: 'adult', owner: 'fam-kade', state: 'ready', shared: true, grownUpsOnly: true, kind: 'audio', tracks: [{ key: 'x' }] },
    s2: { _id: 's2', owner: 'fam-kade', state: 'ready', shared: true, grownUpsOnly: false, kind: 'audio', title: 'Late show', shortcutOf: 'adult', tracks: [{ key: 'x' }] },
    closed: { _id: 'closed', owner: 'fam-kade', state: 'ready', shared: false, kind: 'audio', tracks: [{ key: 'y' }] },
    s3: { _id: 's3', owner: 'fam-amber', state: 'ready', shared: true, kind: 'audio', title: 'My copy', shortcutOf: 'closed', tracks: [{ key: 'y' }] },
  };
  const open = opener(rows);
  const seen = await open({ id: 'fam-holly' }, 's');
  assert.equal(seen._id, 's');
  assert.equal(seen.title, 'The Lion King');
  assert.equal(seen.path, 'Audio/Cassettes/My cassette collection');
  assert.equal(seen.tracks[0].title, 'The Lion King', 'its own track name');
  assert.equal(seen.tracks[0].description.state, 'done', "the keeper's description serves it");
  assert.equal(seen.fileId, 'k', 'text and descriptions are read from, and written to, the keeper');
  assert.equal(await open({ id: 'fam-kid', kadeAccountType: 'child' }, 's2'), null, 'rule 8: a grown-ups file is absent through a shortcut too');
  assert.equal(await open({ id: 'fam-holly' }, 's3'), null, "another person's shortcut closes when the file goes private");
  assert.equal((await open({ id: 'fam-kade' }, 's3')).fileId, 'closed', 'the file owner still opens it');
});

function presign({ mode = 'on', found = null, item = {} } = {}) {
  const handlers = {};
  const calls = { twin: [], signed: 0, deleted: [] };
  const it = { _id: 'item', owner: 'fam-kade', state: 'pending', title: 'My tape', tracks: [], save: async () => {}, toObject() { return this; }, ...item };
  const c = {
    router: { post: (path, ...a) => { handlers[path] = a.at(-1); } }, express: { json: () => () => {} }, requireJwtAuth: () => {},
    ownAudio: async () => it, mimeFor: () => ({ mime: 'video/mp4', ext: 'mp4' }), MAX_TRACK_BYTES: 20 * 1024 ** 3, MULTIPART_ABOVE: 150 * 1024 ** 2, MULTIPART_PART_BYTES: 50 * 1024 ** 2,
    trackKey: () => 'media/item/file.mp4', createMultipart: async () => 'upload', signPart: async () => 'https://storage/part', signPut: async () => { calls.signed++; return 'https://storage/whole'; },
    MEDIA_PREFIX: () => 'media', summary: (x) => ({ id: x._id, title: x.title }), headObject: async () => ({ ContentLength: 1 }), completeMultipart: async () => {}, MEDIA_EXT: { mp4: 'video/mp4' }, VIDEO_EXT: { mp4: true },
    refreshListen: () => {}, pendingCheck: () => ({}), logger,
    filesMode: () => mode, filesPlan, libraryPath: (row) => row.path || '',
    readerFor: async (req) => ({ id: req.user.id, admin: false, child: false, hidden: false }),
    libraryFiles: { storedTwin: async (...args) => { calls.twin.push(args); return found; } },
    KadeBook: { deleteOne: async (q) => { calls.deleted.push(q); return { deletedCount: 1 }; } },
  };
  vm.runInNewContext(slice('const alreadyAnswer = ', 'const MAX_UPLOAD_BYTES') + slice('async function claimedTwin(', "router.post('/media/:id/track/upload'"), c);
  const call = async (body) => {
    let code = 200, result;
    await handlers['/media/:id/track/presign']({ params: { id: 'item' }, user: { id: 'fam-kade' }, body }, { status(n) { code = n; return this; }, json(x) { result = x; return this; } });
    return { code, ...plainJSON(result) };
  };
  return { call, calls };
}

test('a hash the uploader sends skips the upload only for a brand-new empty item that would be a whole copy they can open, and names nothing else', async () => {
  const visible = { _id: 'k', owner: 'fam-amber', shared: true, kind: 'video', title: 'Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022)', tracks: [{ key: 'media-library/k/a.mp4' }] };
  let s = presign({ found: { twin: visible, canOpen: true } });
  let r = await s.call({ fileName: 'ep.mp4', bytes: 100, sha256: SHA });
  assert.equal(r.duplicate, true);
  assert.equal(r.same, 'file');
  assert.equal(r.existing.id, 'k');
  assert.equal(r.removed, 'item');
  assert.equal(r.message, 'Nothing was uploaded: this exact file is already in the library as "Dreams and Nightmares", in Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022). The new item "My tape" you started was removed.');
  assert.equal(s.calls.signed, 0, 'no bytes move');
  assert.deepEqual(plainJSON(s.calls.deleted), [{ _id: 'item', state: 'pending', tracks: { $size: 0 } }], 'the empty item goes, and only while it is still empty');

  // A part of a longer item is always accepted: the verifier links it to the stored bytes after.
  s = presign({ found: { twin: visible, canOpen: true }, item: { state: 'ready', tracks: [{ key: 'media/item/side-a.mp4' }] } });
  r = await s.call({ fileName: 'side-b.mp4', bytes: 100, sha256: SHA });
  assert.equal(r.url, 'https://storage/whole', 'side B of a tape is never refused');
  assert.equal(r.duplicate, undefined);
  assert.equal(s.calls.twin.length, 0);
  assert.deepEqual(s.calls.deleted, []);
  // A stored copy with several parts is not what this one file would be.
  s = presign({ found: { twin: { ...visible, tracks: [{ key: 'a' }, { key: 'b' }] }, canOpen: true } });
  assert.equal((await s.call({ fileName: 'ep.mp4', bytes: 100, sha256: SHA })).url, 'https://storage/whole');
  // The admin adding a part to someone else's empty item never removes it.
  s = presign({ found: { twin: visible, canOpen: true }, item: { owner: 'fam-holly' } });
  assert.equal((await s.call({ fileName: 'ep.mp4', bytes: 100, sha256: SHA })).url, 'https://storage/whole');

  const hidden = { _id: 'p', owner: 'fam-amber', shared: false, title: "Grandma's Christmas 1994" };
  s = presign({ found: null });
  r = await s.call({ fileName: 'tape.mp4', bytes: 100, sha256: SHA });
  assert.equal(r.url, 'https://storage/whole', 'it presigns as before');
  assert.equal(r.duplicate, undefined);
  s = presign({ found: { twin: hidden, canOpen: false } });
  r = await s.call({ fileName: 'tape.mp4', bytes: 100, sha256: SHA });
  assert.equal(r.url, 'https://storage/whole');
  assert.ok(!JSON.stringify(r).includes('Grandma'), "someone else's private copy is never named");

  s = presign({ mode: 'report', found: { twin: visible, canOpen: true } });
  r = await s.call({ fileName: 'ep.mp4', bytes: 100, sha256: SHA });
  assert.equal(r.url, 'https://storage/whole', 'report mode never skips an upload');
  assert.equal(s.calls.twin.length, 0);
  s = presign({ found: { twin: visible, canOpen: true } });
  r = await s.call({ fileName: 'ep.mp4', bytes: 100, sha256: 'not-a-hash' });
  assert.equal(r.url, 'https://storage/whole');
  assert.equal(s.calls.twin.length, 0, 'a malformed hash is never looked up');
  s = presign({ item: { shortcutOf: 'k' } });
  assert.equal((await s.call({ fileName: 'ep.mp4', bytes: 100 })).code, 400, 'a shortcut takes no parts of its own');
});

test('the push lane skips exactly-the-same files the pusher can open, and clears the empty pending row', async () => {
  const deleted = [];
  const saved = [];
  class KadeBook {
    constructor(doc) { Object.assign(this, doc, { _id: 'new-' + saved.length }); }
    async save() { saved.push(this); }
    static async findOne(q) { return q.originalPath === 'Audio/TV/ep1.mp3' ? { _id: 'pending-1', state: 'pending', tracks: [] } : null; }
    static async deleteOne(q) { deleted.push(q); }
  }
  let handler;
  const visible = { _id: 'k', title: 'Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV' };
  const c = {
    router: { post: (_p, ...a) => { handler = a.at(-1); } }, express: { json: () => () => {} }, requireJwtAuth: () => {},
    canPublish: () => true, cleanPath: (p) => String(p || ''), mimeFor: () => ({ kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' }), MAX_TRACK_BYTES: 20 * 1024 ** 3,
    KadeBook, bareTitle: (t) => t, CATEGORIES: ['tv'], ARCHIVE_CATEGORY: () => 'tv', refineMediaFiling: () => ({}), trackKey: () => 'media-library/new/a.mp3',
    MULTIPART_ABOVE: 150 * 1024 ** 2, signPut: async () => 'https://storage/put', libraryPath: (row) => row.path, logger,
    claimedTwin: async (_req, sha256) => (sha256 === SHA ? visible : null),
  };
  vm.runInNewContext(slice("router.post('/archive/presign'", "router.post('/archive/done'"), c);
  let result;
  await handler({ body: { files: [{ originalPath: 'Audio/TV/ep1.mp3', name: 'ep1.mp3', path: 'Audio/TV', bytes: 100, sha256: SHA }, { originalPath: 'Audio/TV/ep2.mp3', name: 'ep2.mp3', path: 'Audio/TV', bytes: 100 }] }, user: { id: 'fam-kade', name: 'Kade' } }, { status() { return this; }, json(x) { result = plainJSON(x); return this; } });
  assert.deepEqual(result.files[0], { originalPath: 'Audio/TV/ep1.mp3', id: 'k', skipped: 'already in the library', same: 'file', title: 'Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV' });
  assert.deepEqual(plainJSON(deleted), [{ _id: 'pending-1', state: 'pending' }], 'the empty pending row from an earlier try goes');
  assert.equal(result.files[1].url, 'https://storage/put', 'a file without a hash goes up as before');
});

function deps(found, mode = 'on') {
  const c = {
    filesMode: () => mode, filesPlan, libraryPath: (row) => row.path || '', summary: (x) => ({ id: String(x._id), title: x.title }), logger,
    requestReader: async (id) => ({ id, admin: false, child: false, hidden: false }),
    libraryFiles: { storedTwin: async () => found },
    KadeBook: { findOne: (q) => ({ lean: async () => ({ m: { _id: 'm', owner: 'o', state: 'merged', mergedInto: 'k' }, k: { _id: 'k', owner: 'o', state: 'ready', title: 'The keeper' } })[String(q._id)] || null }) },
  };
  vm.runInNewContext(slice('const alreadyAnswer = ', 'const MAX_UPLOAD_BYTES'), c);
  return vm.runInNewContext('({' + slice('  existing: async (id, owner) => {', '  importFile: async (job, path, directory) => {') + '})', c);
}

test('the import lane: a precheck answers only for a copy the uploader can open; an old import id forwards', async () => {
  const visible = { _id: 'k', owner: 'reader', shared: false, title: 'A Chosen Faith', skipped: [], jacket: '' };
  let r = plainJSON(await deps({ twin: visible, canOpen: true }).precheck({ id: 'reader' }, SHA, 186573));
  assert.equal(r.duplicate, true);
  assert.equal(r.same, 'file');
  assert.equal(r.book.id, 'k');
  assert.equal(r.message, 'Already on your shelf: "A Chosen Faith". It is exactly the same file, so it is kept once.');
  assert.equal(await deps({ twin: visible, canOpen: false }).precheck({ id: 'reader' }, SHA, 1), null);
  assert.equal(await deps({ twin: visible, canOpen: true }, 'report').precheck({ id: 'reader' }, SHA, 1), null);
  r = plainJSON(await deps(null).existing('m', 'o'));
  assert.deepEqual([r.book.id, r.duplicate, r.same], ['k', true, 'file'], 'a folded import answers with its keeper');
  assert.equal(plainJSON(await deps(null).existing('k', 'o')).duplicate, undefined);
});

function remover(book, promoted = null, foreign = []) {
  let handler;
  const log = { texts: [], released: null, promotedFrom: null, rowsDeleted: [], placesDeleted: [] };
  const doc = { ...book, toObject() { const { toObject, ...rest } = this; return rest; } };
  const c = {
    router: { delete: (_p, ...a) => { handler = a.at(-1); } }, requireJwtAuth: () => {}, isId: () => true, isAdmin: () => false, logger,
    KadeBook: { findById: async () => doc, deleteOne: async (q) => { log.rowsDeleted.push(q); }, deleteMany: async (q) => { log.rowsDeleted.push(q); } },
    KadeBookText: { deleteOne: async (q) => { log.texts.push(q); }, deleteMany: async (q) => { log.texts.push(q); } },
    KadeReadingProgress: { deleteMany: async (q) => { log.placesDeleted.push(q); } }, KadeReadingBookmark: { deleteMany: async () => {} },
    libraryFiles: {
      promoteShortcuts: async (row) => { log.promotedFrom = row._id; return promoted; },
      foreignShortcuts: async () => foreign,
      releaseKeys: async (keys, opts) => { log.released = { keys, except: opts.except }; return []; },
    },
    URL,
  };
  vm.runInNewContext(slice('function keyFromFileUrl(fileUrl)', '/* ── re-read a book') + slice("router.delete('/book/:id'", 'const { readingRoomHtml }'), c);
  return async () => {
    let code = 200;
    await handler({ params: { id: book._id }, user: { id: book.owner } }, { status(n) { code = n; return this; }, json() { return this; } });
    return { code, log };
  };
}

test("withdrawing an item: its shortcut inherits the file, and stored bytes (a book's original too) go only by reference count", async () => {
  let r = await remover({ _id: 'b1', owner: 'u', kind: 'text', fileUrl: 'https://b2.invalid/file/bucket/books/u/book-1.zip' })();
  assert.equal(r.code, 200);
  assert.deepEqual(plainJSON(r.log.released), { keys: ['books/u/book-1.zip'], except: ['b1'] }, "the original no longer stays on B2 for good");
  assert.equal(r.log.texts.length, 1);
  r = await remover({ _id: 'k', owner: 'u', kind: 'audio', tracks: [{ key: 'media-library/k/a.mp3' }] }, 's1')();
  assert.equal(r.log.promotedFrom, 'k');
  assert.deepEqual(plainJSON(r.log.released.keys), ['media-library/k/a.mp3'], 'released through reference counting: the heir still lists it');
  assert.equal(r.log.texts.length, 0, 'the text moved to the heir, so it is not deleted');
  // Shortcuts other people made to it go with it, and do not keep its bytes.
  r = await remover({ _id: 'h', owner: 'holly', kind: 'video', tracks: [{ key: 'media-library/h/a.mp4' }] }, null, ['amber-shortcut'])();
  assert.equal(r.code, 200);
  assert.deepEqual(plainJSON(r.log.rowsDeleted), [{ _id: 'h' }, { _id: { $in: ['amber-shortcut'] } }]);
  assert.deepEqual(plainJSON(r.log.placesDeleted), [{ book: 'h' }, { book: { $in: ['amber-shortcut'] } }], 'their owners simply lose the pointer');
  assert.deepEqual(plainJSON(r.log.released), { keys: ['media-library/h/a.mp4'], except: ['h', 'amber-shortcut'] });
});

test('a shortcut is an ordinary row of its own that reads the file; grown-ups carries over; one per folder', async () => {
  let handler;
  const created = [];
  const file = { _id: 'k', owner: 'fam-kade', state: 'ready', shared: true, grownUpsOnly: true, kind: 'audio', category: 'cassette', title: 'The Lion King - Book And CD', path: 'Audio/Cassettes/Movie read-along stories, mostly Disney', tracks: [{ _id: 't1', key: 'media-library/k/a.mp3', bytes: 9, sha256: SHA, title: 'Side A' }] };
  let exists = false;
  const c = {
    router: { post: (_p, ...a) => { handler = a.at(-1); } }, express: { json: () => () => {} }, requireJwtAuth: () => {}, logger,
    openBook: async () => file, canPublish: (req) => req.user.role === 'ADMIN', cleanPath: (p) => String(p || '').trim(), libraryPath: (row) => row.path,
    keyFromFileUrl: () => '', summary: (x) => x,
    KadeBook: { findById: () => ({ lean: async () => file }), exists: async () => exists, create: async (doc) => { created.push(doc); return { toObject: () => doc }; }, updateOne: async () => ({}) },
  };
  vm.runInNewContext(slice('async function ensureFileKey(', 'const MAX_UPLOAD_BYTES') + slice("router.post('/book/:id/shortcut'", "router.post('/book/:id/return'"), c);
  const call = async (user, body) => {
    let code = 200, result;
    await handler({ params: { id: 'k' }, user, body }, { status(n) { code = n; return this; }, json(x) { result = x; return this; } });
    return { code, result };
  };
  const kade = { id: 'fam-kade', role: 'ADMIN', name: 'Kade' };
  assert.equal((await call(kade, {})).code, 400);
  assert.equal((await call(kade, { path: file.path })).code, 409, 'the file itself is already in that folder');
  let r = await call(kade, { path: 'Audio/Cassettes/My cassette collection', title: 'The Lion King' });
  assert.equal(r.code, 200);
  const row = plainJSON(created[0]);
  assert.equal(row.shortcutOf, 'k');
  assert.equal(row.title, 'The Lion King');
  assert.equal(row.path, 'Audio/Cassettes/My cassette collection');
  assert.equal(row.grownUpsOnly, true, 'never more open than its file');
  assert.equal(row.shared, true);
  assert.equal(row.source, 'shortcut');
  assert.deepEqual(row.tracks, [{ key: 'media-library/k/a.mp3', bytes: 9, sha256: SHA, title: 'Side A' }], 'the same stored bytes, no second copy');
  r = await call({ id: 'fam-holly' }, { path: 'Audio/My favourites', shared: true });
  assert.equal(plainJSON(created[1]).shared, false, 'shared only by someone who may publish');
  exists = true;
  assert.equal((await call(kade, { path: 'Audio/Cassettes/My cassette collection' })).code, 409);
});

test("a shortcut to an older book first writes the book's own fileKey, so withdrawing the shortcut never counts the original out", async () => {
  let handler;
  const created = [];
  const written = [];
  const book = { _id: 'b', owner: 'fam-kade', state: 'ready', shared: true, kind: 'text', title: 'A Chosen Faith', path: '', fileUrl: 'https://b2.invalid/file/bucket/books/u1/book-abc.zip', tracks: [] };
  const c = {
    router: { post: (_p, ...a) => { handler = a.at(-1); } }, express: { json: () => () => {} }, requireJwtAuth: () => {}, logger, URL,
    openBook: async () => book, canPublish: () => false, cleanPath: (p) => String(p || '').trim(), libraryPath: (row) => row.path, summary: (x) => x,
    KadeBook: { findById: () => ({ lean: async () => book }), exists: async () => false, create: async (doc) => { created.push(doc); return { toObject: () => doc }; }, updateOne: async (q, u) => { written.push([q, u]); return {}; } },
  };
  vm.runInNewContext(slice('function keyFromFileUrl(fileUrl)', '/* ── re-read a book') + slice('async function ensureFileKey(', 'const MAX_UPLOAD_BYTES') + slice("router.post('/book/:id/shortcut'", "router.post('/book/:id/return'"), c);
  await handler({ params: { id: 'b' }, user: { id: 'fam-holly' }, body: { path: 'Books/Mine' } }, { status() { return this; }, json() { return this; } });
  assert.deepEqual(plainJSON(written), [[{ _id: 'b', $or: [{ fileKey: '' }, { fileKey: { $exists: false } }] }, { $set: { fileKey: 'books/u1/book-abc.zip' } }]]);
  assert.equal(created[0].fileKey, 'books/u1/book-abc.zip');
});
